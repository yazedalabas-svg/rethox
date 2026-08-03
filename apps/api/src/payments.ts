import { Router } from "express";
import { z } from "zod";
import { moyasar } from "./integrations.js";
import type { AuthRequest } from "./auth.js";
import { auth } from "./auth.js";

const router = Router();

const CreatePaymentInput = z.object({
  amount: z.number().int().positive(),
  description: z.string().min(3).max(100),
});

router.post("/create", auth, async (req: AuthRequest, res) => {
  if (!moyasar) {
    return res.status(503).json({ message: "Moyasar integration is not configured." });
  }

  const parsed = CreatePaymentInput.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payment details.", issues: parsed.error.issues });
  }

  try {
    const response = await fetch(`${moyasar.baseURL}/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${Buffer.from(`${moyasar.secretKey}:`).toString("base64")}`,
      },
      body: JSON.stringify({
        amount: parsed.data.amount,
        currency: "SAR",
        description: parsed.data.description,
        callback_url: "https://rethox.online/payment-callback", // Replace with your actual callback URL
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      return res.status(response.status).json({ message: "Failed to create payment.", error: errorData });
    }

    const payment = await response.json();
    res.status(201).json({ paymentUrl: payment.source.transaction_url });

  } catch (error) {
    console.error("Moyasar payment creation failed:", error);
    res.status(500).json({ message: "An unexpected error occurred while creating the payment." });
  }
});

export const paymentsRouter = router;
