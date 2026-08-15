import { Router } from "express";
import rateLimit from "express-rate-limit";
import { timingSafeEqual } from "node:crypto";
import pino from "pino";
import { z } from "zod";
import { auth, type AuthRequest } from "./auth.js";
import { moyasar, supabaseAdmin } from "./integrations.js";
import { db, save } from "./store.js";
import type { Store } from "./types.js";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const router = Router();

// Real charges are the default. Free checkout has to be asked for explicitly so
// that a missing key in production breaks checkout instead of giving books away.
export const demoCheckout = process.env.PAYMENTS_MODE === "demo";
export const paymentsConfigured = Boolean(moyasar);
export const liveKey = Boolean(moyasar?.secretKey.startsWith("sk_live_"));

const webhookSecret = process.env.MOYASR_WEBHOOK_SECRET?.trim();

const authHeader = () =>
  `Basic ${Buffer.from(`${moyasar!.secretKey}:`).toString("base64")}`;

const moyasarFetch = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${moyasar!.baseURL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(),
      ...init?.headers,
    },
    signal: init?.signal || AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      `Moyasar ${init?.method || "GET"} ${path} failed with ${response.status}`,
    ) as Error & { status?: number; body?: unknown };
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body as Record<string, any>;
};

/**
 * Creates the hosted Moyasar checkout page for an order that already exists in
 * PENDING state. The amount comes from the caller, which reads it back from the
 * database — it is never taken from the browser.
 */
export const createInvoice = async (input: {
  orderId: string;
  amountMinor: number;
  currency: string;
  description: string;
  publicOrigin: string;
}) => {
  const invoice = await moyasarFetch("/invoices", {
    method: "POST",
    body: JSON.stringify({
      amount: input.amountMinor,
      currency: input.currency,
      description: input.description,
      success_url: `${input.publicOrigin}/payment-callback?order=${encodeURIComponent(input.orderId)}`,
      back_url: `${input.publicOrigin}/cart`,
      metadata: { order_id: input.orderId },
    }),
  });
  if (!invoice?.id || !invoice?.url) {
    throw new Error("Moyasar returned an invoice without an id or url");
  }
  return { invoiceId: String(invoice.id), url: String(invoice.url) };
};

export const fetchInvoice = (invoiceId: string) =>
  moyasarFetch(`/invoices/${encodeURIComponent(invoiceId)}`);

/**
 * Applies a settled payment to the JSON store used when Supabase is absent.
 * Returns whether anything changed. Exported so the rules below stay tested:
 * a paid order is final, and repeating a settlement is a no-op.
 */
export const applySettlement = (
  store: Pick<Store, "orders" | "entitlements">,
  orderId: string,
  paid: boolean,
) => {
  const order = store.orders.find((item) => item.id === orderId);
  if (!order) return false;
  // A paid order never reverts — a late failure event must not strip a buyer
  // of books they were charged for.
  if (order.status === "COMPLETED") return false;
  order.status = paid ? "COMPLETED" : "CANCELLED";
  if (!paid) return true;
  order.bookIds.forEach((bookId) => {
    if (
      !store.entitlements.some(
        (item) => item.userId === order.userId && item.bookId === bookId,
      )
    )
      store.entitlements.push({ userId: order.userId, bookId });
  });
  return true;
};

/**
 * Settles an order from an invoice that Moyasar confirmed as paid. Safe to run
 * repeatedly: the database function is idempotent and re-checks the amount.
 */
export const settleOrderFromInvoice = async (invoice: Record<string, any>) => {
  const orderId = String(invoice?.metadata?.order_id || "");
  if (!orderId) throw new Error("Moyasar invoice is missing metadata.order_id");
  const invoiceId = String(invoice.id);
  const paid = invoice.status === "paid";

  if (supabaseAdmin) {
    const { error } = paid
      ? await supabaseAdmin.rpc("complete_paid_order", {
          p_order_id: orderId,
          p_external_id: invoiceId,
          p_amount_minor: Number(invoice.amount),
          p_currency: String(invoice.currency || "SAR"),
        })
      : await supabaseAdmin.rpc("fail_order", {
          p_order_id: orderId,
          p_external_id: invoiceId,
        });
    if (error) {
      logger.error({ orderId, invoiceId, error: error.message }, "order settlement failed");
      throw new Error(error.message);
    }
  }

  const changed = applySettlement(db(), orderId, paid);
  if (changed) await save({ skipRelational: Boolean(supabaseAdmin) });
  logger.info({ orderId, invoiceId, paid }, "order settled");
  return { orderId, paid };
};

/**
 * Confirms an order against Moyasar directly. Used by the return page so a
 * buyer is not left waiting on a webhook that may not be configured yet.
 */
export const verifyOrderPayment = async (invoiceId: string) => {
  const invoice = await fetchInvoice(invoiceId);
  return settleOrderFromInvoice(invoice);
};

const matchesWebhookSecret = (candidate: unknown) => {
  if (!webhookSecret) return false;
  if (typeof candidate !== "string" || !candidate) return false;
  const expected = Buffer.from(webhookSecret);
  const received = Buffer.from(candidate);
  return expected.length === received.length && timingSafeEqual(expected, received);
};

const WebhookInput = z.object({
  type: z.string(),
  secret_token: z.string().optional(),
  live: z.boolean().optional(),
  data: z.object({
    id: z.string(),
    invoice_id: z.string().nullish(),
    metadata: z.record(z.string(), z.any()).nullish(),
  }),
});

router.post("/webhook", async (req, res) => {
  if (!moyasar) return res.status(503).json({ message: "Payments are not configured." });
  if (!webhookSecret) {
    logger.error("MOYASR_WEBHOOK_SECRET is not set; rejecting webhook");
    return res.status(503).json({ message: "Webhook secret is not configured." });
  }

  const parsed = WebhookInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid webhook payload." });
  if (!matchesWebhookSecret(parsed.data.secret_token)) {
    logger.warn({ type: parsed.data.type }, "rejected webhook with a bad secret token");
    return res.status(401).json({ message: "Invalid secret token." });
  }
  // A test-mode event must never settle an order on a live account.
  if (typeof parsed.data.live === "boolean" && parsed.data.live !== liveKey) {
    logger.warn({ live: parsed.data.live, liveKey }, "rejected webhook from the wrong mode");
    return res.status(401).json({ message: "Payment mode mismatch." });
  }
  if (!parsed.data.type.startsWith("payment_")) return res.json({ ok: true, ignored: true });

  const invoiceId =
    parsed.data.data.invoice_id ||
    (parsed.data.data.metadata?.invoice_id as string | undefined);
  if (!invoiceId) return res.json({ ok: true, ignored: true });

  try {
    // The webhook body only tells us which invoice to look at. The amount and
    // status that decide the outcome are read back from Moyasar directly.
    await verifyOrderPayment(invoiceId);
    res.json({ ok: true });
  } catch (error) {
    logger.error({ invoiceId, error: (error as Error).message }, "webhook settlement failed");
    res.status(500).json({ message: "Could not settle the order." });
  }
});

const verifyLimit = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

/** Looks up the invoice a buyer was sent to, without trusting the request for it. */
const invoiceIdForOrder = async (orderId: string) => {
  const local = db().orders.find((item) => item.id === orderId)?.externalId;
  if (local) return local;
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from("payments")
    .select("external_id")
    .eq("order_id", orderId)
    .not("external_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0]?.external_id ? String(data[0].external_id) : null;
};

router.post("/verify", verifyLimit, auth, async (req: AuthRequest, res) => {
  if (!moyasar) return res.status(503).json({ message: "الدفع غير متاح حاليًا" });
  const parsed = z.string().min(1).max(120).safeParse(req.body?.orderId);
  if (!parsed.success) return res.status(400).json({ message: "رقم الطلب غير صالح" });

  const order = db().orders.find(
    (item) => item.id === parsed.data && item.userId === req.user!.id,
  );
  if (!order) return res.status(404).json({ message: "الطلب غير موجود" });
  if (order.status === "COMPLETED") return res.json({ status: "COMPLETED" });

  const invoiceId = await invoiceIdForOrder(order.id);
  if (!invoiceId)
    return res.status(409).json({ message: "لا توجد عملية دفع مرتبطة بهذا الطلب" });

  try {
    const result = await verifyOrderPayment(invoiceId);
    res.json({ status: result.paid ? "COMPLETED" : "CANCELLED" });
  } catch (error) {
    logger.error(
      { orderId: order.id, error: (error as Error).message },
      "manual verification failed",
    );
    res.status(502).json({ message: "تعذر التحقق من الدفع الآن، حاول مجددًا" });
  }
});

export const paymentsRouter = router;
