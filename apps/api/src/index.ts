import "./env.js";
import argon2 from "argon2";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type ErrorRequestHandler, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import getMp3Duration from "get-mp3-duration";
import pino from "pino";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import {
  accessToken,
  auth,
  hasPersistentSessionSecret,
  optionalAuth,
  publicAuthor,
  publicUser,
  refreshValue,
  requireRole,
  tokenHash,
  type AuthRequest,
} from "./auth.js";
import {
  connectRemoteStore,
  db,
  persistenceStatus,
  save,
  saveProgressCheckpoint,
  saveSessionChange,
} from "./store.js";
import type { Book, Chapter, ChapterIllustration, Role, Sentence, User } from "./types.js";
import { integrationStatus, supabase, supabaseAdmin } from "./integrations.js";
import { createRelationalBackup, startBackupScheduler } from "./backup-service.js";
import { summaryProvider } from "./summary-provider.js";
import { safeClientTimestamp, weightedBookProgress } from "./progress.js";
import { TtsGenerationQueue } from "./tts-queue.js";
import { runProcess } from "./process-runner.js";
import { clientHttpError } from "./http-errors.js";
import { rotateRefreshSession } from "./refresh-sessions.js";
import { trimPairedCache } from "./cache-budget.js";
import {
  createInvoice,
  demoCheckout,
  paymentsConfigured,
  paymentsRouter,
} from "./payments.js";

const app = express();
const port = Number(process.env.PORT || 4181);
const phoneAuthEnabled = process.env.PHONE_AUTH_ENABLED === "true";
const webOrigin = process.env.WEB_ORIGIN || "http://127.0.0.1:5173";
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  contentSecurityPolicy: {
    directives: {
      scriptSrc: ["'self'", "https://accounts.google.com"],
      frameSrc: ["'self'", "https://accounts.google.com"],
      connectSrc: ["'self'", "https://accounts.google.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://*.supabase.co", "https://lh3.googleusercontent.com"],
      workerSrc: ["'self'", "blob:"],
    },
  },
}));
const allowedOrigins = new Set([
  webOrigin,
  process.env.PUBLIC_SITE_URL?.replace(/\/$/, ""),
  "https://rethox.online",
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
].filter(Boolean));
app.use(cors({
  origin(origin, done) {
    if (!origin || allowedOrigins.has(origin)) return done(null, true);
    // A rejected CORS origin should not crash delivery of public static files.
    done(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use("/api/auth", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
const logger = pino({ level: process.env.LOG_LEVEL || "info" });
app.use((req, res, next) => {
  const requestId = randomUUID();
  const startedAt = performance.now();
  res.setHeader("X-Request-Id", requestId);
  res.once("finish", () => logger.info({
    requestId,
    method: req.method,
    path: req.path,
    status: res.statusCode,
    durationMs: Math.round(performance.now() - startedAt),
  }, "request completed"));
  next();
});
const authLimit = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
const summaryLimit = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
});
const ttsLimit = rateLimit({
  windowMs: 60_000,
  limit: 80,
  standardHeaders: true,
  legacyHeaders: false,
});
const orderLimit = rateLimit({
  windowMs: 10 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});
const communityWriteLimit = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
const progressWriteLimit = rateLimit({
  windowMs: 60_000,
  limit: 180,
  standardHeaders: true,
  legacyHeaders: false,
});
const avatarUploadLimit = rateLimit({
  windowMs: 10 * 60_000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
});
const chapterImageUploadLimit = rateLimit({
  windowMs: 10 * 60_000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
});
const writeLimit = rateLimit({
  windowMs: 60_000,
  limit: 240,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api", (req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method))
    return writeLimit(req, res, next);
  next();
});
// Narration is deliberately pinned to Hamed. A failed generation must surface
// as an error instead of silently replacing the narrator with another voice.
const hamedVoice = "ar-SA-HamedNeural";
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ttsScript = resolve(rootDir, "tools/tts_edge.py");
const pythonCommand = process.platform === "win32" ? "python" : "python3";
if (spawnSync(pythonCommand, ["-c", "import edge_tts"], { stdio: "ignore" }).status !== 0) {
  spawnSync(
    pythonCommand,
    ["-m", "pip", "install", "--user", "--break-system-packages", "--disable-pip-version-check", "--no-cache-dir", "edge-tts==7.2.7"],
    { stdio: "inherit" },
  );
}
const ttsCache = process.env.TTS_CACHE_DIR
  ? resolve(process.env.TTS_CACHE_DIR)
  : resolve(process.cwd(), "data/tts-cache");
// Imported source files stay outside the web root; reading data and cover metadata live in the store.
mkdirSync(ttsCache, { recursive: true });
const ttsGenerationQueue = new TtsGenerationQueue(450);
const ttsCacheMaxBytes = Number(process.env.TTS_CACHE_MAX_BYTES || 600 * 1024 * 1024);
let lastTtsCacheMaintenanceAt = 0;
let ttsCacheMaintenance = Promise.resolve();
const scheduleTtsCacheMaintenance = (keepKey: string) => {
  if (Date.now() - lastTtsCacheMaintenanceAt < 60_000) return;
  lastTtsCacheMaintenanceAt = Date.now();
  ttsCacheMaintenance = ttsCacheMaintenance
    .then(async () => {
      const removedBytes = await trimPairedCache(ttsCache, ttsCacheMaxBytes, keepKey);
      if (removedBytes) logger.info({ removedBytes }, "trimmed narration cache");
    })
    .catch((error) => logger.warn({ error: String(error) }, "narration cache maintenance failed"));
};
app.use(
  "/api/tts/audio",
  express.static(ttsCache, {
    immutable: true,
    maxAge: "30d",
    setHeaders: (res) => res.setHeader("Accept-Ranges", "bytes"),
  }),
);

const normalizeArabic = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[إأآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .trim();
const externalChapterCache = new Map<string, Map<string, Chapter>>();
const loadChapterContent = (chapter: Chapter): Chapter => {
  if (chapter.sentences.length || !chapter.contentFile) return chapter;
  const dataRoot = resolve(process.cwd(), "data");
  const filePath = resolve(dataRoot, chapter.contentFile);
  if (!filePath.startsWith(dataRoot + sep) || !existsSync(filePath))
    throw new Error("external chapter content is missing");
  let volume = externalChapterCache.get(filePath);
  if (!volume) {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { chapters?: Chapter[] };
    volume = new Map((parsed.chapters || []).map((item) => [item.id, item]));
    externalChapterCache.set(filePath, volume);
  }
  const loaded = volume.get(chapter.id);
  if (!loaded) throw new Error("chapter is missing from external volume");
  return {
    ...loaded,
    isSample: chapter.isSample,
    illustrations: chapter.illustrations ?? loaded.illustrations,
  };
};
const findSentenceContext = (sentenceId: string): { book: Book; chapter: Chapter; sentence: Sentence } | null => {
  for (const book of db().books) {
    for (const chapterMeta of book.chapters) {
      const chapter = chapterMeta.sentences.some((item) => item.id === sentenceId)
        ? chapterMeta
        : chapterMeta.contentFile
          ? loadChapterContent(chapterMeta)
          : chapterMeta;
      const sentence = chapter.sentences.find((item) => item.id === sentenceId);
      if (sentence) return { book, chapter: chapterMeta, sentence };
    }
  }
  return null;
};
const latinDigits = (value: string) => value
  .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
  .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
const normalizePhone = (value: string) => {
  const compact = latinDigits(value).trim().replace(/[^\d+]/g, "").replace(/^00/, "+");
  const parsed = parsePhoneNumberFromString(compact);
  return parsed?.isValid() ? parsed.number : "";
};
const weightedAverage = (ratings: number[]) => {
  if (!ratings.length) return 0;
  const prior = 3.8;
  const weight = 5;
  const total = ratings.reduce((sum, rating) => sum + rating, 0);
  return Math.round(((total + prior * weight) / (ratings.length + weight)) * 10) / 10;
};
const bookRating = (bookId: string) =>
  weightedAverage(db().reviews.filter((review) => review.bookId === bookId).map((review) => review.rating));
const chapterRating = (chapterId: string) =>
  weightedAverage(
    db().chapterComments
      .filter((comment) => comment.chapterId === chapterId && !comment.parentId && comment.rating > 0)
      .map((comment) => comment.rating),
  );
const UserInput = z.object({
  name: z.string().min(2).max(60),
  email: z.string().email().max(180),
  password: z.string().min(8).max(100),
});
const LoginInput = z.object({
  email: z.string().min(3).max(180),
  password: z.string().min(1),
});
const ProfileInput = z.object({
  name: z.string().trim().min(2).max(60),
  avatarUrl: z.union([z.string().url().max(1000), z.literal("")]).optional(),
});
const avatarTypes = {
  "image/jpeg": { extension: "jpg", matches: (body: Buffer) => body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff },
  "image/png": { extension: "png", matches: (body: Buffer) => body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/webp": { extension: "webp", matches: (body: Buffer) => body.length >= 12 && body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP" },
} as const;
const BookInput = z.object({
  title: z.string().min(2),
  author: z.string().min(2),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  synopsis: z.string().min(20),
  priceMinor: z.number().int().nonnegative(),
  genre: z.string().min(2),
  tags: z.array(z.string()).default([]),
  coverTheme: z.string().default("indigo"),
});
const BookPatch = BookInput.partial().extend({
  status: z.enum(["PUBLISHED", "DRAFT"]).optional(),
  coverUrl: z.string().url().max(1000).optional(),
  pageCount: z.number().int().positive().optional(),
});

const SESSION_LIFETIME_MS = 365 * 864e5;
const setRefreshCookie = (res: Response, value: string) => res.cookie("rethox_refresh", value, {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: SESSION_LIFETIME_MS,
  path: "/api/auth",
});
const csrfCookie = (res: Response, value: string) => res.cookie("rethox_csrf", value, {
  httpOnly: false,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: SESSION_LIFETIME_MS,
  path: "/api",
});
const csrfOriginIsAllowed = (req: express.Request) => {
  const origin = req.get("origin");
  return Boolean(origin && allowedOrigins.has(origin));
};
const requireCsrf = (req: express.Request, res: Response, next: express.NextFunction) => {
  const csrfCookieValue = typeof req.cookies.rethox_csrf === "string"
    ? req.cookies.rethox_csrf
    : "";
  const csrfHeader = req.get("x-rethox-csrf") || "";
  if (csrfCookieValue && csrfHeader === csrfCookieValue) return next();
  // Existing readers may still have a refresh cookie from before CSRF was
  // introduced. Accept exactly one same-origin renewal and issue their token.
  if (!csrfCookieValue && csrfOriginIsAllowed(req)) {
    csrfCookie(res, randomUUID());
    return next();
  }
  res.status(403).json({ message: "تعذر التحقق من حماية الطلب" });
};
const issueSession = async (
  res: Response,
  user: { id: string; role: Role },
  options: { persistState?: boolean } = {},
) => {
  const refresh = refreshValue();
  const session = {
    userId: user.id,
    hash: tokenHash(refresh),
    expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS).toISOString(),
  };
  db().refreshTokens.push(session);
  setRefreshCookie(res, refresh);
  csrfCookie(res, randomUUID());
  if (options.persistState) await save();
  else await saveSessionChange({ issued: session });
  return accessToken(user.id, user.role);
};

app.get("/api/health", (_req, res) => {
  const persistence = persistenceStatus();
  res.json({
    ok: true,
    mode: "demo-persistent",
    // "persistent-disk" means DATA_DIR points at the mounted disk and user
    // data (accounts, comments) survives deploys; "container-local" means it
    // is wiped on every deploy/restart.
    storage: process.env.DATA_DIR ? "persistent-disk" : "container-local",
    durableStorage: persistence.relationalEnabled
      ? "supabase-relational"
      : persistence.remoteConnected
        ? "supabase-legacy"
      : process.env.DATA_DIR
        ? "persistent-disk"
        : "not-configured",
    persistenceHealthy: !persistence.lastRemoteErrorAt,
    googleAuth: googleClientId && googleClientSecret
      ? "oauth-code-and-gsi"
      : "google-identity-services",
    sessionSecret: hasPersistentSessionSecret ? "configured" : "ephemeral-secure",
    catalogContent: db().books.every((book) => book.chapters.every((chapter) =>
      !chapter.contentFile || existsSync(resolve(process.cwd(), "data", chapter.contentFile)),
    )) ? "ready" : "missing",
    time: new Date().toISOString(),
  });
});
app.get("/api/integrations/status", async (_req, res) => {
  try {
    res.json(await integrationStatus());
  } catch (error) {
    logger.warn({ error: String(error) }, "integration status failed");
    res.status(503).json({ message: "تعذر فحص خدمات التخزين الآن" });
  }
});
app.post("/api/tts", ttsLimit, async (req, res) => {
  const parsed = z
    .object({
      text: z.string().min(1).max(3000),
    })
    .safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ message: "النص أو إعدادات الصوت غير صحيحة" });
  const narrationText = parsed.data.text
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim();
  if (!narrationText || narrationText.includes("\uFFFD"))
    return res.status(400).json({ message: "ترميز النص غير صالح" });
  const voice = hamedVoice;
  const rate = "+0%";
  const pitch = "+0Hz";
  const key = createHash("sha256")
    .update(`utf8-v9-hamed-only-word-boundary|${voice}|${rate}|${pitch}|${narrationText}`)
    .digest("hex")
    .slice(0, 32);
  const audioPath = resolve(ttsCache, `${key}.mp3`);
  const metaPath = resolve(ttsCache, `${key}.json`);
  try {
    if (!existsSync(audioPath) || !existsSync(metaPath)) {
      await ttsGenerationQueue.run(key, async () => {
        // A queued duplicate may have finished while this caller was waiting.
        if (existsSync(audioPath) && existsSync(metaPath)) return;
        let lastError: unknown;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            await runProcess(
              pythonCommand,
              [
                ttsScript,
                "--out",
                audioPath,
                "--voice",
                voice,
                "--rate",
                rate,
                "--pitch",
                pitch,
              ],
              { input: narrationText, timeoutMs: 90_000 },
            );
            return;
          } catch (error) {
            lastError = error;
            const retryDelay = Math.min(12_000, 1_000 * 2 ** attempt);
            await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelay));
          }
        }
        throw lastError || new Error("TTS generation failed");
      });
    }
    const metadata = JSON.parse(readFileSync(metaPath, "utf8"));
    if (!Array.isArray(metadata.boundaries) || metadata.boundaries.length === 0) {
      const durationMs = Math.max(1, getMp3Duration(readFileSync(audioPath)));
      const words = narrationText.split(/\s+/).filter(Boolean);
      const totalWeight = words.reduce((sum, word) => sum + Math.max(2, word.length), 0) || 1;
      let cursorMs = 0;
      metadata.boundaries = words.map((word, index) => {
        const endMs = index === words.length - 1
          ? durationMs
          : cursorMs + Math.max(1, Math.round(durationMs * Math.max(2, word.length) / totalWeight));
        const boundary = { text: word, startMs: cursorMs, endMs };
        cursorMs = endMs;
        return boundary;
      });
      metadata.durationMs = durationMs;
      writeFileSync(metaPath, JSON.stringify(metadata), "utf8");
    }
    scheduleTtsCacheMaintenance(key);
    res.json({
      ...metadata,
      audioUrl: `/api/tts/audio/${key}.mp3`,
      cached: existsSync(audioPath),
    });
  } catch (error) {
    logger.error({ error: String(error) }, "edge tts failed");
    return res.status(502).json({
      message: "تعذر تجهيز صوت حامد الآن",
      ...(process.env.NODE_ENV === "production"
        ? {}
        : { detail: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) }),
    });
  }
});
app.post("/api/auth/register", authLimit, async (req, res) => {
  const parsed = UserInput.safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({ message: "تحقق من البيانات", issues: parsed.error.issues });
  const email = parsed.data.email.toLowerCase();
  const existing = db().users.find((u) => u.email === email);
  if (existing)
    return res.status(409).json({ message: "تعذر إنشاء الحساب بهذه البيانات" });
  const user: User = {
    id: randomUUID(),
    name: parsed.data.name,
    email,
    passwordHash: await argon2.hash(parsed.data.password, {
      type: argon2.argon2id,
    }),
    role: "CUSTOMER" as const,
    theme: "light" as const,
    createdAt: new Date().toISOString(),
  };
  db().users.push(user);
  const token = await issueSession(res, user, { persistState: true });
  res.status(201).json({ accessToken: token, user: publicUser(user.id) });
});
app.post("/api/auth/login", authLimit, async (req, res) => {
  const parsed = LoginInput.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ message: "بيانات الدخول غير مكتملة" });
  const loginEmail = parsed.data.email.trim().toLowerCase();
  const user = db().users.find((u) => u.email === loginEmail);
  if (!user)
    return res.status(401).json({ message: "البريد أو كلمة المرور غير صحيحة" });
  if (!(await argon2.verify(user.passwordHash, parsed.data.password)))
    return res.status(401).json({
      message:
        user.oauthProvider === "google"
          ? "استخدم زر «المتابعة باستخدام Google» لهذا الحساب"
          : "البريد أو كلمة المرور غير صحيحة",
    });
  const token = await issueSession(res, user);
  res.json({ accessToken: token, user: publicUser(user.id) });
});
const phoneStartLimit = rateLimit({
  windowMs: 10 * 60_000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "انتظر قليلًا قبل طلب رمز جديد" },
});
const phoneVerifyLimit = rateLimit({
  windowMs: 10 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة" },
});
app.post("/api/auth/phone/start", phoneStartLimit, async (req, res) => {
  if (!phoneAuthEnabled)
    return res.status(503).json({ message: "تسجيل الجوال متوقف مؤقتًا" });
  if (!supabase)
    return res.status(503).json({ message: "تسجيل الجوال غير مضبوط على الخادم" });
  const parsed = z.object({ phone: z.string().min(8).max(20) }).safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ message: "اكتب رقم الجوال بصيغة دولية صحيحة" });
  const phone = normalizePhone(parsed.data.phone);
  if (!phone)
    return res.status(400).json({ message: "استخدم الصيغة الدولية، مثال: +9665xxxxxxxx" });
  const { error } = await supabase.auth.signInWithOtp({
    phone,
    options: { shouldCreateUser: true },
  });
  if (error) {
    logger.warn({ code: error.code, status: error.status, providerMessage: error.message }, "phone OTP send failed");
    if (error.status === 429)
      return res.status(429).json({ message: "طُلبت رموز كثيرة. انتظر قليلًا ثم حاول مجددًا" });
    if (error.status === 400)
      return res.status(400).json({ message: "هذا الرقم غير صالح لاستقبال رمز التحقق" });
    return res.status(502).json({ message: "تعذر إرسال الرمز الآن. تحقق من خدمة الرسائل وحاول مجددًا" });
  }
  res.json({ sent: true, phone });
});
app.post("/api/auth/phone/verify", phoneVerifyLimit, async (req, res) => {
  if (!phoneAuthEnabled)
    return res.status(503).json({ message: "تسجيل الجوال متوقف مؤقتًا" });
  if (!supabase)
    return res.status(503).json({ message: "تسجيل الجوال غير مضبوط على الخادم" });
  const parsed = z.object({
    phone: z.string().min(8).max(20),
    token: z.string().regex(/^\d{6}$/),
  }).safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ message: "رقم الجوال أو رمز التحقق غير صحيح" });
  const phone = normalizePhone(parsed.data.phone);
  if (!phone)
    return res.status(400).json({ message: "رقم الجوال غير صحيح" });
  const { data, error } = await supabase.auth.verifyOtp({
    phone,
    token: parsed.data.token,
    type: "sms",
  });
  if (error || !data.user?.phone)
    return res.status(401).json({ message: "الرمز غير صحيح أو انتهت صلاحيته" });
  // A phone stored by the legacy email flow was never verified. Never link an
  // OTP identity to it: that would allow pre-claiming somebody else's number.
  db().users.forEach((item) => {
    if (item.phone === phone && item.oauthSubject !== data.user!.id) item.phone = undefined;
  });
  let user = db().users.find((item) => item.oauthSubject === data.user!.id);
  if (!user) {
    user = {
      id: data.user.id,
      name: `قارئ ${phone.slice(-4)}`,
      email: "",
      phone,
      passwordHash: await argon2.hash(randomUUID(), { type: argon2.argon2id }),
      role: "CUSTOMER",
      theme: "light",
      oauthProvider: "supabase",
      oauthSubject: data.user.id,
      createdAt: new Date().toISOString(),
    };
    db().users.push(user);
  } else {
    user.phone = phone;
    user.oauthProvider = "supabase";
    user.oauthSubject = data.user.id;
  }
  const access = await issueSession(res, user, { persistState: true });
  res.json({ accessToken: access, user: publicUser(user.id) });
});
const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
const googleAudience = googleClientId || "";
// Behind Render's proxy the real host/protocol arrive in forwarded headers.
app.set("trust proxy", 1);
const googleRedirectUri = (req: AuthRequest) => {
  const forwardedPublicOrigin = req.get("x-rethox-public-origin") === "https://rethox.online"
    ? "https://rethox.online"
    : "";
  const requestHost = req.get("host") || "";
  const requestBase = `${req.protocol}://${requestHost}`.replace(/\/$/, "");
  const configuredBase = process.env.NODE_ENV === "production"
    ? forwardedPublicOrigin || process.env.API_PUBLIC_URL || requestBase
    : process.env.GOOGLE_LOCAL_SITE_URL || (requestHost.startsWith("localhost") || requestHost.startsWith("127.0.0.1")
      ? requestBase
      : `http://127.0.0.1:${port}`);
  const base = (configuredBase || requestBase).replace(/\/$/, "");
  return `${base}/api/auth/google/callback`;
};
const publicWebUrl = () => (process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
const redirectToWeb = (res: Response, path: string) => {
  const target = safeReturnPath(path);
  const web = publicWebUrl();
  res.redirect(web ? new URL(target, `${web}/`).toString() : target);
};
const safeReturnPath = (value: unknown) => {
  const path = String(value || "/");
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
};
type GoogleClaims = {
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: string;
  name?: string;
  exp?: string;
  iss?: string;
};
type VerifiedGoogleClaims = Required<Pick<GoogleClaims, "sub" | "email">> & GoogleClaims;
const verifyGoogleIdToken = async (idToken: string): Promise<VerifiedGoogleClaims> => {
  if (!googleAudience) throw new Error("Google client is not configured");
  const response = await fetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken),
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) throw new Error("token verification failed: " + response.status);
  const claims = await response.json() as GoogleClaims;
  if (
    claims.aud !== googleAudience || !claims.sub || !claims.email ||
    claims.email_verified !== "true" || Number(claims.exp || 0) * 1000 <= Date.now() ||
    !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss || "")
  ) throw new Error("invalid Google identity claims");
  return claims as VerifiedGoogleClaims;
};
const resolveGoogleUser = async (claims: VerifiedGoogleClaims) => {
  const email = claims.email.toLowerCase();
  let user = db().users.find(
    (item) => item.oauthSubject === claims.sub || item.email === email,
  );
  if (!user) {
    user = {
      id: randomUUID(),
      name: String(claims.name || "قارئ rethox").slice(0, 60),
      email,
      passwordHash: await argon2.hash(randomUUID(), { type: argon2.argon2id }),
      role: "CUSTOMER",
      theme: "light",
      oauthProvider: "google",
      oauthSubject: claims.sub,
      createdAt: new Date().toISOString(),
    };
    db().users.push(user);
  } else {
    if (user.oauthSubject && user.oauthSubject !== claims.sub)
      throw new Error("email already linked to another Google identity");
    if (user.oauthSubject !== claims.sub) {
      user.passwordHash = await argon2.hash(randomUUID(), { type: argon2.argon2id });
      db().refreshTokens = db().refreshTokens.filter((token) => token.userId !== user!.id);
    }
    user.oauthProvider = "google";
    user.oauthSubject = claims.sub;
  }
  return user;
};
app.get("/api/auth/google/config", (_req, res) =>
  res.json({ clientId: googleAudience }),
);
app.post("/api/auth/google/id-token", authLimit, async (req, res) => {
  const parsed = z.object({
    credential: z.string().min(100).max(6000),
    consent: z.literal(true),
  }).safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ message: "يجب تأكيد الموافقة قبل استخدام Google" });
  try {
    const verifiedClaims = await verifyGoogleIdToken(parsed.data.credential);
    const verifiedUser = await resolveGoogleUser(verifiedClaims);
    /* Legacy inline verifier retained only as unreachable reference.
    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(parsed.data.credential)}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) throw new Error(`token verification failed: ${response.status}`);
    const claims = await response.json() as {
      aud?: string; sub?: string; email?: string; email_verified?: string;
      name?: string; exp?: string; iss?: string;
    };
    if (
      claims.aud !== googleAudience || !claims.sub || !claims.email ||
      claims.email_verified !== "true" || Number(claims.exp || 0) * 1000 <= Date.now() ||
      !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss || "")
    ) throw new Error("invalid Google identity claims");
    const email = claims.email.toLowerCase();
    let user = db().users.find(
      (item) => item.oauthSubject === claims.sub || item.email === email,
    );
    if (!user) {
      user = {
        id: randomUUID(),
        name: String(claims.name || "قارئ rethox").slice(0, 60),
        email,
        passwordHash: await argon2.hash(randomUUID(), { type: argon2.argon2id }),
        role: "CUSTOMER",
        theme: "light",
        oauthProvider: "google",
        oauthSubject: claims.sub,
        createdAt: new Date().toISOString(),
      };
      db().users.push(user);
    } else {
      user.oauthProvider = "google";
      user.oauthSubject = claims.sub;
    }
    */
    const token = await issueSession(res, verifiedUser, { persistState: true });
    res.json({ accessToken: token, user: publicUser(verifiedUser.id) });
  } catch (error) {
    logger.warn({ error: String(error) }, "Google ID token login failed");
    res.status(401).json({ message: "تعذر التحقق من حساب Google" });
  }
});
const googleOauthCookie = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  maxAge: 600_000,
  path: "/api/auth",
};
const googleAuthorizationUrl = (req: AuthRequest, state: string) => {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", googleClientId || "");
  url.searchParams.set("redirect_uri", googleRedirectUri(req));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  // Google may otherwise skip its consent screen for a previously approved account.
  url.searchParams.set("prompt", "consent select_account");
  return url.toString();
};
app.get("/api/auth/google", (_req, res) =>
  redirectToWeb(res, "/login?error=google-consent"),
);
app.post("/api/auth/google/consent", authLimit, (req: AuthRequest, res) => {
  if (!googleClientId || !googleClientSecret)
    return res.status(503).json({ message: "تسجيل Google غير مضبوط على الخادم" });
  const parsed = z.object({
    accepted: z.literal(true),
    returnTo: z.string().max(500).optional(),
  }).safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ message: "يجب الموافقة بوضوح قبل المتابعة" });
  const state = randomUUID();
  res.cookie("rethox_oauth_state", state, googleOauthCookie);
  res.cookie("rethox_oauth_consent", state, googleOauthCookie);
  res.cookie("rethox_oauth_return", safeReturnPath(parsed.data.returnTo), googleOauthCookie);
  res.json({ authorizationUrl: googleAuthorizationUrl(req, state) });
});
app.get("/api/auth/google/callback", async (req, res) => {
  const fail = (reason: string) =>
    redirectToWeb(res, `/login?error=${reason}`);
  if (!googleClientId || !googleClientSecret) return fail("google-config");
  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  if (
    !code || !state ||
    state !== req.cookies.rethox_oauth_state ||
    state !== req.cookies.rethox_oauth_consent
  )
    return fail("google-state");
  res.clearCookie("rethox_oauth_state", { path: "/api/auth" });
  res.clearCookie("rethox_oauth_consent", { path: "/api/auth" });
  const returnTo = safeReturnPath(req.cookies.rethox_oauth_return);
  res.clearCookie("rethox_oauth_return", { path: "/api/auth" });
  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        redirect_uri: googleRedirectUri(req),
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenResponse.ok)
      throw new Error(`token exchange failed: ${tokenResponse.status}`);
    const tokens = (await tokenResponse.json()) as { id_token?: string };
    if (!tokens.id_token) throw new Error("missing id_token");
    const verifiedClaims = await verifyGoogleIdToken(tokens.id_token);
    const verifiedUser = await resolveGoogleUser(verifiedClaims);
    /* Legacy payload-only handling removed from execution.
    // The id_token arrives directly from Google's token endpoint over TLS,
    // so its payload can be trusted without local signature verification.
    const claims = JSON.parse(
      Buffer.from(tokens.id_token.split(".")[1], "base64url").toString("utf8"),
    ) as { sub?: string; email?: string; name?: string };
    if (!claims.sub || !claims.email) throw new Error("missing claims");
    const email = claims.email.toLowerCase();
    let user = db().users.find(
      (item) => item.oauthSubject === claims.sub || item.email === email,
    );
    if (!user) {
      user = {
        id: randomUUID(),
        name: String(claims.name || "قارئ rethox").slice(0, 60),
        email,
        passwordHash: await argon2.hash(randomUUID(), { type: argon2.argon2id }),
        role: "CUSTOMER",
        theme: "light",
        oauthProvider: "google",
        oauthSubject: claims.sub,
        createdAt: new Date().toISOString(),
      };
      db().users.push(user);
    } else {
      // Same email already registered with a password: link the Google identity.
      user.oauthProvider = "google";
      user.oauthSubject = claims.sub;
    }
    */
    await issueSession(res, verifiedUser, { persistState: true });
    redirectToWeb(res, returnTo);
  } catch (error) {
    logger.warn({ error: String(error) }, "google oauth failed");
    fail("google");
  }
});
app.post("/api/auth/refresh", authLimit, requireCsrf, async (req, res) => {
  const value = req.cookies.rethox_refresh;
  if (!value) return res.status(401).json({ message: "لا توجد جلسة" });
  const hash = tokenHash(value);
  const nextValue = refreshValue();
  const rotation = rotateRefreshSession(
    db().refreshTokens,
    hash,
    tokenHash(nextValue),
    Date.now(),
    SESSION_LIFETIME_MS,
  );
  if (!rotation) return res.status(401).json({ message: "انتهت الجلسة" });
  const user = db().users.find((u) => u.id === rotation.next.userId);
  if (!user) return res.status(401).json({ message: "المستخدم غير موجود" });
  setRefreshCookie(res, nextValue);
  await saveSessionChange({
    issued: rotation.next,
    revokedHashes: [rotation.previous.hash],
  });
  res.json({
    accessToken: accessToken(user.id, user.role),
    user: publicUser(user.id),
  });
});
app.post("/api/auth/logout", requireCsrf, async (req, res) => {
  const value = req.cookies.rethox_refresh;
  if (value)
    db().refreshTokens = db().refreshTokens.filter(
      (t) => t.hash !== tokenHash(value),
    );
  res.clearCookie("rethox_refresh", {
    path: "/api/auth",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  res.clearCookie("rethox_csrf", {
    path: "/api",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  if (value) await saveSessionChange({ revokedHashes: [tokenHash(value)] });
  res.status(204).end();
});
app.get("/api/auth/me", auth, (req: AuthRequest, res) =>
  res.json({ user: publicUser(req.user!.id) }),
);
app.post(
  "/api/auth/avatar",
  avatarUploadLimit,
  auth,
  express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "5mb" }),
  async (req: AuthRequest, res) => {
    if (!supabaseAdmin)
      return res.status(503).json({ message: "رفع الصور غير متاح الآن" });
    const storageAdmin = supabaseAdmin;

    const contentType = (req.get("content-type") || "").split(";", 1)[0] as keyof typeof avatarTypes;
    const descriptor = avatarTypes[contentType];
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!descriptor || body.length < 128 || body.length > 5 * 1024 * 1024 || !descriptor.matches(body))
      return res.status(400).json({ message: "اختر صورة JPG أو PNG أو WEBP بحجم لا يتجاوز 5MB" });

    const objectPath = `${req.user!.id}/${randomUUID()}.${descriptor.extension}`;
    const upload = () => storageAdmin.storage.from("avatars").upload(objectPath, body, {
      contentType,
      cacheControl: "31536000",
      upsert: false,
    });
    let result = await upload();
    if (result.error && /bucket.*not found/i.test(result.error.message)) {
      const { error: bucketError } = await storageAdmin.storage.createBucket("avatars", {
        public: true,
        fileSizeLimit: 5 * 1024 * 1024,
        allowedMimeTypes: Object.keys(avatarTypes),
      });
      if (!bucketError || /already exists/i.test(bucketError.message)) result = await upload();
    }
    if (result.error) {
      logger.error({ error: result.error.message }, "avatar upload failed");
      return res.status(503).json({ message: "تعذر رفع الصورة الآن، حاول مجددًا" });
    }
    const { data } = storageAdmin.storage.from("avatars").getPublicUrl(objectPath);
    res.status(201).json({ avatarUrl: data.publicUrl });
  },
);
app.patch("/api/auth/profile", auth, async (req: AuthRequest, res) => {
  const parsed = ProfileInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "بيانات الملف الشخصي غير صالحة" });
  const user = db().users.find((item) => item.id === req.user!.id);
  if (!user) return res.status(404).json({ message: "الحساب غير موجود" });
  const avatarUrl = parsed.data.avatarUrl?.trim() || undefined;
  if (supabaseAdmin) {
    const { error } = await supabaseAdmin
      .from("profiles")
      .upsert({ user_id: user.id, display_name: parsed.data.name, avatar_url: avatarUrl || null }, { onConflict: "user_id" });
    if (error) {
      logger.error({ error: error.message }, "profile update persistence failed");
      return res.status(503).json({ message: "تعذر حفظ الملف الشخصي الآن، حاول مجددًا" });
    }
  }
  user.name = parsed.data.name;
  user.avatarUrl = avatarUrl;
  await save({ skipRelational: Boolean(supabaseAdmin) });
  res.json({ user: publicUser(user.id) });
});

app.get("/api/books", (req, res) => {
  let books = db().books.filter((b) => b.status === "PUBLISHED");
  const q = normalizeArabic(String(req.query.q || ""));
  const tag = String(req.query.tag || "");
  const genre = String(req.query.genre || "");
  const max = Number(req.query.maxPrice || Infinity);
  if (q)
    books = books.filter((b) =>
      normalizeArabic(
        `${b.title} ${b.author} ${b.synopsis} ${b.tags.join(" ")}`,
      ).includes(q),
    );
  if (tag) books = books.filter((b) => b.tags.includes(tag));
  if (genre) books = books.filter((b) => b.genre === genre);
  books = books.filter((b) => b.priceMinor <= max);
  res.json({
    books: books.map(({ chapters, documentFile, ...book }) => ({
      ...book,
      rating: bookRating(book.id),
      chapterCount: chapters.length,
      sampleChapterId: chapters.find((c) => c.isSample)?.id,
    })),
  });
});
app.get("/api/books/:id/pdf", auth, (req: AuthRequest, res) => {
  const book = db().books.find(
    (item) => item.id === req.params.id && item.status === "PUBLISHED",
  );
  if (!book?.documentFile)
    return res.status(404).json({ message: "ملف الكتاب غير موجود" });
  const owns = db().entitlements.some(
    (item) => item.userId === req.user!.id && item.bookId === book.id,
  );
  if (!owns) return res.status(403).json({ message: "اشترِ الكتاب لفتح النسخة الكاملة" });
  const booksDir = resolve(process.cwd(), "data/books");
  const filePath = resolve(booksDir, book.documentFile);
  if (!filePath.startsWith(booksDir + sep) || !existsSync(filePath))
    return res.status(404).json({ message: "ملف الكتاب غير موجود" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${book.slug}.pdf"`);
  res.sendFile(filePath);
});
app.get("/api/books/:slug", optionalAuth, (req: AuthRequest, res) => {
  const book = db().books.find(
    (b) => b.slug === req.params.slug && b.status === "PUBLISHED",
  );
  if (!book) return res.status(404).json({ message: "الكتاب غير موجود" });
  const owns = !!req.user && db().entitlements.some(
    (item) => item.userId === req.user!.id && item.bookId === book.id,
  );
  const { chapters, documentFile, ...meta } = book;
  res.json({
    book: {
      ...meta,
      rating: bookRating(book.id),
      hasPdf: owns && Boolean(documentFile),
      chapters: chapters.map(({ sentences, contentFile, ...chapter }) => ({
        ...chapter,
        locked: !chapter.isSample && !owns,
        rating: chapterRating(chapter.id),
        sentenceCount: chapter.sentenceCount ?? sentences.length,
        // A chapter can bundle many real chapters as "sections" (e.g. a whole
        // novel volume). Flag which of those are locked individually so a
        // sample volume can still hold paid chapters past the free preview.
        sections: chapter.sections?.map((section) => ({
          ...section,
          locked: section.isSample === false && !owns,
        })),
      })),
    },
  });
});
app.get("/api/books/:id/chapters", optionalAuth, (req: AuthRequest, res) => {
  const book = db().books.find((b) => b.id === req.params.id);
  if (!book) return res.status(404).json({ message: "الكتاب غير موجود" });
  const owns =
    !!req.user &&
    db().entitlements.some(
      (e) => e.userId === req.user!.id && e.bookId === book.id,
    );
  res.json({
    chapters: book.chapters.map(({ sentences, contentFile, ...c }) => ({
      ...c,
      locked: !c.isSample && !owns,
      sentenceCount: c.sentenceCount ?? sentences.length,
    })),
  });
});
app.get("/api/chapters/:id/content", optionalAuth, (req: AuthRequest, res) => {
  const book = db().books.find((b) =>
    b.chapters.some((c) => c.id === req.params.id),
  );
  const chapterMeta = book?.chapters.find((c) => c.id === req.params.id);
  if (!book || !chapterMeta)
    return res.status(404).json({ message: "الفصل غير موجود" });
  const owns =
    !!req.user &&
    db().entitlements.some(
      (e) => e.userId === req.user!.id && e.bookId === book.id,
    );
  if (!chapterMeta.isSample && !owns)
    return res.status(403).json({
      message: "اشترِ الكتاب لفتح هذا الفصل",
      book: { id: book.id, slug: book.slug, title: book.title, priceMinor: book.priceMinor },
      chapter: { id: chapterMeta.id, title: chapterMeta.title },
    });
  let chapter: Chapter;
  try { chapter = loadChapterContent(chapterMeta); }
  catch (error) {
    logger.error({ chapterId: chapterMeta.id, error: String(error) }, "chapter content unavailable");
    return res.status(503).json({ message: "تعذر تجهيز الفصل الآن" });
  }
  const sections = chapter.sections || [];
  const requestedSectionId = String(req.query.section || "");
  const requestedSectionIndex = requestedSectionId
    ? sections.findIndex(
        (section) => section.id === requestedSectionId || section.sentenceId === requestedSectionId,
      )
    : -1;
  // A chapter can bundle many real chapters as "sections" (e.g. a whole novel
  // volume) — gate reading at the section boundary when some of those are
  // locked behind purchase, even though the parent chapter itself is a
  // sample. Falling back to index 0 handles both an explicit request past
  // the free portion and the implicit "no section" full-chapter view.
  const firstLockedSectionIndex = owns
    ? -1
    : sections.findIndex((section) => section.isSample === false);
  const effectiveSectionIndex = requestedSectionIndex >= 0 ? requestedSectionIndex : 0;
  if (firstLockedSectionIndex >= 0 && effectiveSectionIndex >= firstLockedSectionIndex)
    return res.status(403).json({
      message: "اشترِ الكتاب لفتح هذا الفصل",
      book: { id: book.id, slug: book.slug, title: book.title, priceMinor: book.priceMinor },
      chapter: { id: chapterMeta.id, title: chapterMeta.title },
    });
  const activeSection = requestedSectionIndex >= 0 ? sections[requestedSectionIndex] : undefined;
  const nextSection = activeSection
    ? sections[requestedSectionIndex + 1]
    : firstLockedSectionIndex >= 0
      ? sections[firstLockedSectionIndex]
      : undefined;
  const visibleChapter = activeSection || nextSection
    ? (() => {
        const startIndex = activeSection
          ? chapter.sentences.findIndex((sentence) => sentence.id === activeSection.sentenceId)
          : 0;
        const endIndex = nextSection
          ? chapter.sentences.findIndex((sentence) => sentence.id === nextSection.sentenceId)
          : chapter.sentences.length;
        const sentences = chapter.sentences.slice(Math.max(0, startIndex), Math.max(0, endIndex));
        const sentenceIds = new Set(sentences.map((sentence) => sentence.id));
        return {
          ...chapter,
          sentences,
          illustrations: chapter.illustrations?.filter(
            (illustration) => illustration.afterSentenceId
              ? sentenceIds.has(illustration.afterSentenceId)
              : effectiveSectionIndex === 0,
          ),
        };
      })()
    : chapter;
  const chapterIndex = book.chapters.findIndex((item) => item.id === chapterMeta.id);
  const chapterLink = (item: (typeof book.chapters)[number] | undefined) =>
    item
      ? {
          id: item.id,
          title: item.title,
          position: item.position,
          sentenceCount: item.sentenceCount ?? item.sentences.length,
          locked: !item.isSample && !owns,
        }
      : null;
  res.json({
    book: {
      id: book.id,
      slug: book.slug,
      title: book.title,
      author: book.author,
      contentUnitLabel: book.contentUnitLabel,
      contentUnitLabelPlural: book.contentUnitLabelPlural,
      priceMinor: book.priceMinor,
    },
    chapter: {
      ...withAutomaticIllustrationAlt(visibleChapter),
      contentFile: undefined,
      sections: visibleChapter.sections?.map((section) => ({
        ...section,
        locked: section.isSample === false && !owns,
      })),
    },
    chapterList: book.chapters.map((item) => ({
      id: item.id,
      title: item.title,
      position: item.position,
      locked: !item.isSample && !owns,
    })),
    navigation: {
      previous: chapterLink(book.chapters[chapterIndex - 1]),
      next: chapterLink(book.chapters[chapterIndex + 1]),
    },
    activeSection,
    sectionNavigation: activeSection
      ? {
          previous: requestedSectionIndex > 0 ? chapter.sections?.[requestedSectionIndex - 1] : null,
          next: nextSection || null,
        }
      : null,
    audio: { type: "tts-demo", url: null },
  });
});
app.get("/api/search", (req, res) => {
  const q = normalizeArabic(String(req.query.q || ""));
  const books = db().books.filter((b) =>
    normalizeArabic(`${b.title} ${b.author} ${b.tags.join(" ")}`).includes(q),
  );
  res.json({ books: books.map(({ chapters, documentFile, ...b }) => ({ ...b, rating: bookRating(b.id) })) });
});
app.get("/api/recommendations", (_req, res) =>
  res.json({
    books: [...db().books]
      .sort((a, b) => bookRating(b.id) - bookRating(a.id))
      .slice(0, 3)
      .map(({ chapters, documentFile, ...b }) => ({ ...b, rating: bookRating(b.id) })),
  }),
);

app.use("/api/payments", paymentsRouter);

app.post("/api/orders", orderLimit, auth, async (req: AuthRequest, res) => {
  const ids = z.array(z.string()).min(1).safeParse(req.body.bookIds);
  if (!ids.success)
    return res.status(400).json({ message: "اختر كتابًا واحدًا على الأقل" });
  const buyer = db().users.find((u) => u.id === req.user!.id);
  if (!buyer)
    return res.status(401).json({ message: "يلزم تسجيل الدخول بحساب مسجل" });
  const books = db().books.filter((b) => ids.data.includes(b.id) && b.status === "PUBLISHED");
  if (books.length !== new Set(ids.data).size)
    return res.status(400).json({ message: "أحد المنتجات غير متاح للشراء" });
  let ownedBookIds = db().entitlements
    .filter((item) => item.userId === req.user!.id && ids.data.includes(item.bookId))
    .map((item) => item.bookId);
  if (supabaseAdmin) {
    const { data: ownedRows, error: ownershipError } = await supabaseAdmin
      .from("entitlements")
      .select("book_id")
      .eq("user_id", req.user!.id)
      .is("revoked_at", null)
      .in("book_id", books.map((book) => book.id));
    if (ownershipError) {
      logger.error({ error: ownershipError.message }, "ownership check failed");
      return res.status(503).json({ message: "تعذر التحقق من مشترياتك الآن، حاول مجددًا" });
    }
    ownedBookIds = (ownedRows || []).map((item) => item.book_id);
  }
  if (ownedBookIds.length) {
    return res.status(409).json({
      code: "BOOK_ALREADY_OWNED",
      bookIds: ownedBookIds,
      message: ownedBookIds.length === 1
        ? "تم شراء هذا المنتج مسبقًا"
        : "بعض المنتجات في طلبك تم شراؤها مسبقًا",
    });
  }
  const requestedOrderId = randomUUID();
  const publicNumber = `RX-${requestedOrderId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const bookIds = books.map((book) => book.id);
  const cartKey = `${req.user!.id}:${[...bookIds].sort().join(",")}`;
  const totalMinor = books.reduce((sum, book) => sum + book.priceMinor, 0);
  const alreadyOwned = () =>
    res.status(409).json({
      code: "BOOK_ALREADY_OWNED",
      bookIds,
      message: "تم شراء هذا المنتج مسبقًا",
    });

  if (demoCheckout) {
    let persistedOrder: any = null;
    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin.rpc("complete_demo_order", {
        p_order_id: requestedOrderId,
        p_public_number: publicNumber,
        p_user_id: req.user!.id,
        p_book_ids: bookIds,
        p_idempotency_key: `demo:${cartKey}`,
      });
      if (error) {
        if (error.message.includes("book_already_owned")) return alreadyOwned();
        logger.error({ error: error.message }, "atomic checkout failed");
        return res.status(503).json({ message: "تعذر إكمال الطلب بأمان الآن، حاول مجددًا" });
      }
      persistedOrder = data;
    }
    const order = {
      id: persistedOrder?.id || requestedOrderId,
      userId: req.user!.id,
      bookIds,
      totalMinor: persistedOrder?.total_minor ?? totalMinor,
      currency: persistedOrder?.currency || "SAR",
      status: "COMPLETED" as const,
      createdAt: persistedOrder?.created_at || new Date().toISOString(),
    };
    if (!db().orders.some((item) => item.id === order.id)) db().orders.push(order);
    books.forEach((b) => {
      if (
        !db().entitlements.some(
          (e) => e.userId === req.user!.id && e.bookId === b.id,
        )
      )
        db().entitlements.push({ userId: req.user!.id, bookId: b.id });
    });
    await save({ skipRelational: Boolean(supabaseAdmin) });
    return res
      .status(201)
      .json({ order, message: "تم الشراء التجريبي، لم يُخصم أي مبلغ" });
  }

  if (!paymentsConfigured)
    return res.status(503).json({ message: "الدفع غير متاح حاليًا، حاول لاحقًا" });

  // Real checkout reserves the order first and hands the buyer to Moyasar.
  // Entitlements stay unissued until a verified payment settles the order.
  let pendingOrder: any = null;
  if (supabaseAdmin) {
    const { data, error } = await supabaseAdmin.rpc("create_pending_order", {
      p_order_id: requestedOrderId,
      p_public_number: publicNumber,
      p_user_id: req.user!.id,
      p_book_ids: bookIds,
      p_idempotency_key: `pay:${cartKey}`,
    });
    if (error) {
      if (error.message.includes("book_already_owned")) return alreadyOwned();
      if (error.message.includes("amount_below_minimum"))
        return res.status(400).json({ message: "أقل مبلغ للدفع هو ريال واحد" });
      logger.error({ error: error.message }, "pending order creation failed");
      return res.status(503).json({ message: "تعذر بدء الطلب الآن، حاول مجددًا" });
    }
    pendingOrder = data;
  }
  const order = {
    id: pendingOrder?.id || requestedOrderId,
    userId: req.user!.id,
    bookIds,
    totalMinor: pendingOrder?.total_minor ?? totalMinor,
    currency: pendingOrder?.currency || books[0]?.currency || "SAR",
    status: "PENDING" as const,
    createdAt: pendingOrder?.created_at || new Date().toISOString(),
  };
  if (order.totalMinor < 100)
    return res.status(400).json({ message: "أقل مبلغ للدفع هو ريال واحد" });
  if (!db().orders.some((item) => item.id === order.id)) db().orders.push(order);
  await save({ skipRelational: Boolean(supabaseAdmin) });

  try {
    const invoice = await createInvoice({
      orderId: order.id,
      amountMinor: order.totalMinor,
      currency: order.currency,
      description: books.map((book) => book.title).join(" + ").slice(0, 100),
      publicOrigin: publicWebUrl() || webOrigin,
    });
    if (supabaseAdmin) {
      const { error } = await supabaseAdmin.rpc("attach_order_payment", {
        p_order_id: order.id,
        p_external_id: invoice.invoiceId,
      });
      if (error)
        logger.error({ error: error.message }, "could not record the payment attempt");
    }
    // Remember which invoice the buyer was sent to so the return page can
    // confirm the payment without waiting for the webhook.
    const stored = db().orders.find((item) => item.id === order.id);
    if (stored) stored.externalId = invoice.invoiceId;
    await save({ skipRelational: Boolean(supabaseAdmin) });
    res.status(201).json({ order, paymentUrl: invoice.url });
  } catch (error) {
    logger.error(
      { orderId: order.id, error: (error as Error).message },
      "invoice creation failed",
    );
    res.status(502).json({ message: "تعذر فتح صفحة الدفع الآن، حاول مجددًا" });
  }
});
app.get("/api/orders", auth, (req: AuthRequest, res) =>
  res.json({ orders: db().orders.filter((o) => o.userId === req.user!.id) }),
);
app.get("/api/orders/:id", auth, (req: AuthRequest, res) => {
  const order = db().orders.find(
    (o) => o.id === req.params.id && o.userId === req.user!.id,
  );
  order
    ? res.json({ order })
    : res.status(404).json({ message: "الطلب غير موجود" });
});
app.get("/api/entitlements", auth, (req: AuthRequest, res) =>
  res.json({
    bookIds: db()
      .entitlements.filter((e) => e.userId === req.user!.id)
      .map((e) => e.bookId),
  }),
);

app.get("/api/reading-list", auth, (req: AuthRequest, res) =>
  res.json({
    bookIds: db().readingList
      .filter((item) => item.userId === req.user!.id)
      .map((item) => item.bookId),
  }),
);
app.post("/api/reading-list/:bookId", auth, async (req: AuthRequest, res) => {
  const book = db().books.find((item) => item.id === req.params.bookId && item.status === "PUBLISHED");
  if (!book) return res.status(404).json({ message: "الكتاب غير موجود" });
  const existing = db().readingList.find(
    (item) => item.userId === req.user!.id && item.bookId === book.id,
  );
  if (!existing) {
    db().readingList.push({ userId: req.user!.id, bookId: book.id, createdAt: new Date().toISOString() });
    await save();
  }
  res.status(existing ? 200 : 201).json({ saved: true, bookId: book.id });
});
app.delete("/api/reading-list/:bookId", auth, async (req: AuthRequest, res) => {
  db().readingList = db().readingList.filter(
    (item) => !(item.userId === req.user!.id && item.bookId === req.params.bookId),
  );
  await save();
  res.status(204).end();
});

app.put("/api/progress/:bookId", progressWriteLimit, auth, async (req: AuthRequest, res) => {
  const body = z
    .object({
      chapterId: z.string().min(1).max(200),
      sentenceId: z.string().min(1).max(200).optional(),
      wordId: z.string().min(1).max(200).optional(),
      positionMs: z.number().nonnegative().max(7 * 24 * 60 * 60 * 1000),
      percentage: z.number().min(0).max(100),
      clientUpdatedAt: z.string().datetime().optional(),
    })
    .safeParse(req.body);
  if (!body.success)
    return res.status(400).json({ message: "بيانات التقدم غير صحيحة" });
  const bookId = String(req.params.bookId);
  const book = db().books.find((item) => item.id === bookId);
  const chapter = book?.chapters.find((item) => item.id === body.data.chapterId);
  if (!book || !chapter)
    return res.status(404).json({ message: "الكتاب أو الفصل غير موجود" });
  const ownsBook = db().entitlements.some(
    (item) => item.userId === req.user!.id && item.bookId === bookId,
  );
  if (!chapter.isSample && !ownsBook)
    return res.status(403).json({ message: "اشترِ الكتاب لحفظ التقدم في هذا الفصل" });
  const overallPercentage = weightedBookProgress(
    book.chapters,
    chapter.id,
    body.data.percentage,
  );
  const index = db().progress.findIndex(
    (p) => p.userId === req.user!.id && p.bookId === bookId,
  );
  const updatedAt = safeClientTimestamp(body.data.clientUpdatedAt);
  const { clientUpdatedAt: _clientUpdatedAt, ...progressInput } = body.data;
  const value = {
    userId: req.user!.id,
    bookId,
    ...progressInput,
    percentage: overallPercentage,
    updatedAt,
  };
  if (supabaseAdmin) {
    const { data, error } = await supabaseAdmin.rpc("save_reading_progress", {
      p_user_id: req.user!.id,
      p_book_id: bookId,
      p_chapter_id: body.data.chapterId,
      p_sentence_id: body.data.sentenceId || null,
      p_word_id: body.data.wordId || null,
      p_position_ms: Math.max(0, Math.round(body.data.positionMs)),
      p_book_percentage: overallPercentage,
      p_chapter_percentage: body.data.percentage,
      p_client_updated_at: updatedAt,
    });
    if (error) {
      logger.error({ error: error.message }, "progress persistence failed");
      return res.status(503).json({ message: "تعذر حفظ موضع القراءة الآن، حاول مجددًا" });
    }
    if (data?.accepted === false) {
      return res.json({
        progress: index >= 0 ? db().progress[index] : null,
        ignoredAsStale: true,
      });
    }
    const storedProgress = data?.progress;
    if (storedProgress) {
      value.percentage = Number(storedProgress.percentage);
      value.updatedAt = storedProgress.updated_at || value.updatedAt;
    }
  }
  index >= 0 ? (db().progress[index] = value) : db().progress.push(value);
  if (supabaseAdmin) await saveProgressCheckpoint();
  else await save({ skipRelational: true });
  res.json({ progress: value });
});
app.get("/api/progress/:bookId", auth, (req: AuthRequest, res) =>
  res.json({
    progress:
      db().progress.find(
        (p) => p.userId === req.user!.id && p.bookId === req.params.bookId,
      ) || null,
  }),
);
app.post("/api/bookmarks", auth, async (req: AuthRequest, res) => {
  const parsed = z
    .object({
      bookId: z.string(),
      chapterId: z.string(),
      sentenceId: z.string(),
    })
    .safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ message: "العلامة غير مكتملة" });
  const existing = db().bookmarks.find(
    (b) => b.userId === req.user!.id && b.sentenceId === parsed.data.sentenceId,
  );
  if (existing) return res.json({ bookmark: existing });
  const bookmark = {
    id: randomUUID(),
    userId: req.user!.id,
    ...parsed.data,
    createdAt: new Date().toISOString(),
  };
  db().bookmarks.push(bookmark);
  await save();
  res.status(201).json({ bookmark });
});
app.delete("/api/bookmarks/:id", auth, async (req: AuthRequest, res) => {
  db().bookmarks = db().bookmarks.filter(
    (b) => !(
      (b.id === req.params.id || b.sentenceId === req.params.id) &&
      b.userId === req.user!.id
    ),
  );
  await save();
  res.status(204).end();
});
app.post("/api/reports", communityWriteLimit, auth, async (req: AuthRequest, res) => {
  const parsed = z.object({
    bookId: z.string().min(1),
    chapterId: z.string().min(1),
    sentenceId: z.string().min(1).optional(),
    message: z.string().trim().min(3).max(500),
  }).safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ message: "اكتب وصفًا واضحًا للمشكلة" });
  const book = db().books.find((item) => item.id === parsed.data.bookId);
  const chapter = book?.chapters.find((item) => item.id === parsed.data.chapterId);
  if (!book || !chapter)
    return res.status(404).json({ message: "الفصل غير موجود" });
  const now = new Date().toISOString();
  const report = {
    id: randomUUID(),
    userId: req.user!.id,
    ...parsed.data,
    status: "OPEN" as const,
    createdAt: now,
    updatedAt: now,
  };
  db().reports.push(report);
  await save();
  res.status(201).json({ report });
});
app.post(
  "/api/sentences/:id/summary",
  summaryLimit,
  optionalAuth,
  async (req: AuthRequest, res) => {
    let context: ReturnType<typeof findSentenceContext>;
    try { context = findSentenceContext(String(req.params.id)); }
    catch (error) {
      logger.error({ sentenceId: req.params.id, error: String(error) }, "sentence lookup failed");
      return res.status(503).json({ message: "تعذر تجهيز الجملة الآن" });
    }
    if (!context)
      return res.status(404).json({ message: "الجملة غير موجودة" });
    const owns = !!req.user && db().entitlements.some(
      (item) => item.userId === req.user!.id && item.bookId === context!.book.id,
    );
    if (!context.chapter.isSample && !owns)
      return res.status(403).json({ message: "اشترِ الكتاب لاستخدام الخلاصة في هذا الفصل" });
    const sentence = context.sentence;
    if (sentence.summary)
      return res.json({ summary: sentence.summary, cached: true });
    let summary = `الخلاصة: ${sentence.text.split(/\s+/).slice(0, 8).join(" ")}…`;
    if (summaryProvider) {
      try {
        summary = await summaryProvider.summarize(sentence.text);
      } catch (error) {
        logger.warn({ error: String(error) }, "OpenRouter summary failed");
      }
    }
    sentence.summary = summary;
    if (!context.chapter.contentFile) await save();
    res.json({ summary, cached: false });
  },
);

// Old records can reference an author that no longer exists in the store;
// the list must still render instead of breaking the whole section.
const fallbackAuthor = (userId: string) => ({
  id: userId,
  name: "قارئ rethox",
});
app.get("/api/reviews/:bookId", (req, res) => {
  const reviews = db().reviews
    .filter((review) => review.bookId === req.params.bookId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ provider, ...review }) => ({
      ...review,
      user: publicAuthor(review.userId) ?? fallbackAuthor(review.userId),
    }));
  const average = weightedAverage(reviews.map((review) => review.rating));
  res.json({ reviews, average, count: reviews.length });
});
app.post("/api/reviews", communityWriteLimit, auth, async (req: AuthRequest, res) => {
  const parsed = z
    .object({
      bookId: z.string().min(1),
      rating: z.number().int().min(1).max(5),
      body: z.string().trim().max(1200).default(""),
      spoiler: z.boolean().default(false),
    })
    .safeParse(req.body);
  if (!parsed.success || !db().books.some((book) => book.id === parsed.data?.bookId))
    return res.status(400).json({ message: "بيانات التقييم غير صحيحة" });
  const now = new Date().toISOString();
  const author = db().users.find((u) => u.id === req.user!.id);
  const provider = author?.oauthProvider === "google" ? ("google" as const) : ("email" as const);
  let review = db().reviews.find(
    (item) => item.userId === req.user!.id && item.bookId === parsed.data.bookId,
  );
  const previousReview = review ? { ...review } : null;
  if (review) Object.assign(review, parsed.data, { provider, updatedAt: now });
  else {
    review = {
      id: randomUUID(),
      userId: req.user!.id,
      ...parsed.data,
      provider,
      createdAt: now,
      updatedAt: now,
    };
    db().reviews.push(review);
  }
  if (supabaseAdmin) {
    const { error } = await supabaseAdmin.from("book_reviews").upsert({
      id: review.id,
      user_id: review.userId,
      book_id: review.bookId,
      rating: review.rating,
      body: review.body,
      spoiler: review.spoiler,
      moderation_status: "VISIBLE",
      created_at: review.createdAt,
      updated_at: review.updatedAt,
      deleted_at: null,
    }, { onConflict: "user_id,book_id" });
    if (error) {
      if (previousReview) Object.assign(review, previousReview);
      else db().reviews = db().reviews.filter((item) => item.id !== review!.id);
      logger.error({ error: error.message }, "review persistence failed");
      return res.status(503).json({ message: "تعذر حفظ التقييم الآن، حاول مجددًا" });
    }
  } else {
    await save();
  }
  const { provider: _provider, ...publicReview } = review;
  res.status(201).json({ review: { ...publicReview, user: publicAuthor(review.userId) } });
});
app.delete("/api/reviews/:bookId", communityWriteLimit, auth, async (req: AuthRequest, res) => {
  const bookId = String(req.params.bookId);
  const initiallyMatchedIds = new Set(
    db().reviews
      .filter((review) => review.userId === req.user!.id && review.bookId === bookId)
      .map((review) => review.id),
  );
  if (supabaseAdmin) {
    const { data, error } = await supabaseAdmin
      .from("book_reviews")
      .update({ deleted_at: new Date().toISOString() })
      .eq("user_id", req.user!.id)
      .eq("book_id", bookId)
      .is("deleted_at", null)
      .select("id");
    if (error) {
      logger.error({ error: error.message }, "review deletion persistence failed");
      return res.status(503).json({ message: "تعذر حذف التقييم الآن، حاول مجددًا" });
    }
    for (const item of data || []) initiallyMatchedIds.add(item.id);
  }
  db().reviews = db().reviews.filter((review) => !initiallyMatchedIds.has(review.id));
  await save({ skipRelational: Boolean(supabaseAdmin) });
  res.status(204).end();
});
app.get("/api/chapters/:id/comments", (req, res) => {
  const chapterId = String(req.params.id);
  const comments = db().chapterComments
    .filter((comment) => comment.chapterId === chapterId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ provider, ...comment }) => ({
      ...comment,
      user: publicAuthor(comment.userId) ?? fallbackAuthor(comment.userId),
    }));
  const ratings = comments.filter((comment) => !comment.parentId && comment.rating > 0);
  const average = weightedAverage(ratings.map((comment) => comment.rating));
  res.json({ comments, average, count: comments.length, ratingCount: ratings.length });
});
app.post("/api/chapters/:id/comments", communityWriteLimit, auth, async (req: AuthRequest, res) => {
  const chapterId = String(req.params.id);
  const chapterExists = db().books.some((book) =>
    book.chapters.some((chapter) => chapter.id === chapterId),
  );
  const parsed = z
    .object({
      rating: z.number().int().min(1).max(5).optional(),
      body: z.string().trim().max(1200).default(""),
      spoiler: z.boolean().default(false),
      parentId: z.string().optional(),
    })
    .safeParse(req.body);
  if (!chapterExists || !parsed.success)
    return res.status(400).json({ message: "بيانات التعليق غير صحيحة" });
  const isReply = !!parsed.data.parentId;
  if (isReply) {
    const parent = db().chapterComments.find(
      (item) => item.id === parsed.data.parentId && item.chapterId === chapterId && !item.parentId,
    );
    if (!parent || parsed.data.body.length < 1)
      return res.status(400).json({ message: "الرد غير صحيح" });
  } else if (!parsed.data.rating) {
    return res.status(400).json({ message: "اختر تقييمًا للفصل" });
  }
  const now = new Date().toISOString();
  const author = db().users.find((u) => u.id === req.user!.id);
  const provider = author?.oauthProvider === "google" ? ("google" as const) : ("email" as const);
  const data = {
    rating: isReply ? 0 : parsed.data.rating!,
    body: parsed.data.body,
    spoiler: parsed.data.spoiler,
    parentId: parsed.data.parentId,
  };
  let comment = isReply
    ? undefined
    : db().chapterComments.find(
        (item) => item.userId === req.user!.id && item.chapterId === chapterId && !item.parentId,
      );
  if (comment) Object.assign(comment, data, { provider, updatedAt: now });
  else {
    const newComment = {
      id: randomUUID(),
      userId: req.user!.id,
      chapterId,
      ...data,
      provider,
      createdAt: now,
      updatedAt: now,
    };
    db().chapterComments.push(newComment);
    comment = newComment;
  }
  await save();
  const { provider: _provider, ...publicComment } = comment;
  res.status(201).json({ comment: { ...publicComment, user: publicAuthor(comment.userId) } });
});
app.delete("/api/chapters/:id/comments/:commentId", communityWriteLimit, auth, async (req: AuthRequest, res) => {
  const chapterId = String(req.params.id);
  const commentId = z.string().uuid().safeParse(req.params.commentId);
  if (!commentId.success) return res.status(400).json({ message: "معرّف التعليق غير صالح" });
  const ownedComment = db().chapterComments.find(
    (comment) => comment.id === commentId.data && comment.userId === req.user!.id && comment.chapterId === chapterId,
  );
  if (!ownedComment) return res.status(404).json({ message: "التعليق غير موجود أو لا تملك حذفه" });
  if (supabaseAdmin) {
    const { data, error } = await supabaseAdmin
      .from("chapter_comments")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", commentId.data)
      .eq("user_id", req.user!.id)
      .eq("chapter_id", chapterId)
      .is("deleted_at", null)
      .select("id");
    if (error) {
      logger.error({ error: error.message }, "comment deletion persistence failed");
      return res.status(503).json({ message: "تعذر حذف التعليق الآن، حاول مجددًا" });
    }
    if (!data?.length) return res.status(404).json({ message: "التعليق غير موجود أو حُذف مسبقًا" });
  }
  db().chapterComments = db().chapterComments.filter(
    (comment) => comment.id !== commentId.data,
  );
  await save({ skipRelational: Boolean(supabaseAdmin) });
  res.status(204).end();
});

const chapterImageBody = express.raw({
  type: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  // High-resolution PNG artwork is often much larger than compressed web
  // formats. Keep one generous ceiling for covers and chapter art, while
  // still protecting the API process from an unbounded request body.
  // Supabase's current project plan permits Storage files up to 50MB.
  limit: process.env.ADMIN_IMAGE_UPLOAD_LIMIT || "50mb",
});
const imageExtension: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
const detectedImageMime = (body: unknown) => {
  if (!Buffer.isBuffer(body)) return "";
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff)
    return "image/jpeg";
  if (body.length >= 12 && body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp";
  const gifHeader = body.subarray(0, 6).toString("ascii");
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return "image/gif";
  return "";
};
const adminChapter = (chapterId: string) => {
  const book = db().books.find((item) => item.chapters.some((chapter) => chapter.id === chapterId));
  const chapterMeta = book?.chapters.find((chapter) => chapter.id === chapterId);
  if (!book || !chapterMeta) return null;
  return { book, chapterMeta, chapter: loadChapterContent(chapterMeta) };
};
const validImagePlacement = (chapter: Chapter, afterSentenceId?: string) =>
  !afterSentenceId || chapter.sentences.some((sentence) => sentence.id === afterSentenceId);
const automaticIllustrationAlt = (chapter: Chapter, afterSentenceId?: string) => {
  const sentencePosition = afterSentenceId
    ? chapter.sentences.find((sentence) => sentence.id === afterSentenceId)?.position
    : undefined;
  return sentencePosition
    ? `صورة بعد الفقرة ${sentencePosition} من الفصل`
    : "صورة في بداية الفصل";
};
const withAutomaticIllustrationAlt = (chapter: Chapter): Chapter => ({
  ...chapter,
  illustrations: chapter.illustrations?.map((illustration) => ({
    ...illustration,
    alt: automaticIllustrationAlt(chapter, illustration.afterSentenceId),
  })),
});
const publicChapterAssetUrl = (bucket: string, objectPath: string) =>
  bucket === "site-public"
    ? objectPath
    : supabaseAdmin!.storage.from(bucket).getPublicUrl(objectPath).data.publicUrl;
const recordAdminAudit = async (
  userId: string,
  action: string,
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown> = {},
) => {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  if (supabaseAdmin) {
    const { error } = await supabaseAdmin.from("admin_audit_logs").insert({
      id,
      user_id: userId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      metadata,
      created_at: createdAt,
    });
    if (error) throw new Error(`audit log failed: ${error.message}`);
  }
  db().auditLogs.push({ id, userId, action, createdAt });
  await save({ skipRelational: Boolean(supabaseAdmin) });
};
const updateMemoryIllustration = (
  chapter: Chapter,
  illustration: ChapterIllustration,
) => {
  const items = chapter.illustrations || [];
  const index = items.findIndex((item) => item.id === illustration.id);
  chapter.illustrations = index < 0
    ? [...items, illustration]
    : items.map((item, itemIndex) => itemIndex === index ? illustration : item);
};

app.get("/api/admin/catalog", auth, requireRole("ADMIN"), (_req, res) => {
  res.json({
    books: db().books.map((book) => ({
      id: book.id,
      title: book.title,
      author: book.author,
      synopsis: book.synopsis,
      slug: book.slug,
      priceMinor: book.priceMinor,
      status: book.status,
      coverUrl: book.coverUrl,
      contentUnitLabel: book.contentUnitLabel,
      contentUnitLabelPlural: book.contentUnitLabelPlural,
      chapters: book.chapters.map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        position: chapter.position,
        illustrationCount: chapter.illustrations?.length || 0,
      })),
    })),
  });
});
app.get("/api/admin/chapters/:id", auth, requireRole("ADMIN"), (req, res) => {
  try {
    const context = adminChapter(String(req.params.id));
    if (!context) return res.status(404).json({ message: "الفصل غير موجود" });
    res.json({
      book: { id: context.book.id, title: context.book.title },
      chapter: {
        id: context.chapter.id,
        title: context.chapter.title,
        position: context.chapter.position,
        illustrations: (context.chapterMeta.illustrations || []).map((illustration) => ({
          ...illustration,
          alt: automaticIllustrationAlt(context.chapter, illustration.afterSentenceId),
        })),
        sentences: context.chapter.sentences.map((sentence) => ({
          id: sentence.id,
          position: sentence.position,
          text: sentence.text,
        })),
      },
    });
  } catch (error) {
    logger.warn({ error: String(error), chapterId: req.params.id }, "admin chapter load failed");
    res.status(503).json({ message: "تعذر تحميل محتوى الفصل" });
  }
});
app.post(
  "/api/admin/chapters/:id/illustrations",
  chapterImageUploadLimit,
  auth,
  requireRole("ADMIN"),
  chapterImageBody,
  async (req: AuthRequest, res) => {
    if (!supabaseAdmin)
      return res.status(503).json({ message: "قاعدة البيانات أو التخزين غير متصل" });
    const context = adminChapter(String(req.params.id));
    if (!context) return res.status(404).json({ message: "الفصل غير موجود" });
    const metadata = z.object({
      afterSentenceId: z.string().max(200).optional(),
    }).safeParse({
      afterSentenceId: String(req.query.afterSentenceId || "") || undefined,
    });
    if (!metadata.success || !validImagePlacement(context.chapter, metadata.data.afterSentenceId))
      return res.status(400).json({ message: "موضع الصورة غير صحيح" });
    const alt = automaticIllustrationAlt(context.chapter, metadata.data.afterSentenceId);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const declaredMime = String(req.get("content-type") || "").split(";")[0].toLowerCase();
    const actualMime = detectedImageMime(body);
    if (!body.length || !imageExtension[declaredMime] || actualMime !== declaredMime)
      return res.status(400).json({ message: "الملف ليس صورة صالحة أو نوعه غير مطابق" });

    const { data: versions, error: versionError } = await supabaseAdmin
      .from("chapter_assets")
      .select("version,position")
      .eq("chapter_id", context.chapter.id)
      .eq("kind", "IMAGE");
    if (versionError) return res.status(503).json({ message: "تعذر قراءة صور الفصل" });
    const version = Math.max(0, ...(versions || []).map((item) => item.version || 0)) + 1;
    const position = Math.max(0, ...(versions || []).map((item) => item.position || 0)) + 1;
    const objectPath = `${context.chapter.id}/${randomUUID()}.${imageExtension[declaredMime]}`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from("chapter-images")
      .upload(objectPath, body, { contentType: declaredMime, cacheControl: "31536000", upsert: false });
    if (uploadError) {
      logger.error({ error: uploadError.message }, "chapter image upload failed");
      return res.status(503).json({ message: "تعذر رفع الصورة إلى التخزين" });
    }
    const { data: asset, error: assetError } = await supabaseAdmin
      .from("chapter_assets")
      .insert({
        chapter_id: context.chapter.id,
        kind: "IMAGE",
        bucket: "chapter-images",
        object_path: objectPath,
        content_type: declaredMime,
        byte_size: Buffer.byteLength(body),
        checksum_sha256: createHash("sha256").update(body).digest("hex"),
        version,
        alt_text: alt,
        after_sentence_id: metadata.data.afterSentenceId || null,
        position,
        created_by: req.user!.id,
        updated_at: new Date().toISOString(),
      })
      .select("id,bucket,object_path,alt_text,after_sentence_id,position")
      .single();
    if (assetError || !asset) {
      await supabaseAdmin.storage.from("chapter-images").remove([objectPath]);
      logger.error({ error: assetError?.message }, "chapter image metadata failed");
      return res.status(503).json({ message: "تعذر حفظ بيانات الصورة" });
    }
    const { error: chapterError } = await supabaseAdmin
      .from("chapters")
      .update({ illustrations_managed: true })
      .eq("id", context.chapter.id);
    if (chapterError) {
      await supabaseAdmin.from("chapter_assets").delete().eq("id", asset.id);
      await supabaseAdmin.storage.from("chapter-images").remove([objectPath]);
      return res.status(503).json({ message: "تعذر تفعيل إدارة صور الفصل" });
    }
    const illustration: ChapterIllustration = {
      id: asset.id,
      src: publicChapterAssetUrl(asset.bucket, asset.object_path),
      alt,
      afterSentenceId: asset.after_sentence_id || undefined,
      position: asset.position,
      storagePath: asset.object_path,
    };
    updateMemoryIllustration(context.chapterMeta, illustration);
    await recordAdminAudit(req.user!.id, "CHAPTER_IMAGE_ADDED", "chapter", context.chapter.id, {
      illustrationId: asset.id,
      afterSentenceId: illustration.afterSentenceId || null,
      objectPath,
    });
    res.status(201).json({ illustration });
  },
);
app.patch(
  "/api/admin/chapters/:id/illustrations/:illustrationId",
  auth,
  requireRole("ADMIN"),
  async (req: AuthRequest, res) => {
    if (!supabaseAdmin) return res.status(503).json({ message: "قاعدة البيانات غير متصلة" });
    const context = adminChapter(String(req.params.id));
    if (!context) return res.status(404).json({ message: "الفصل غير موجود" });
    const parsed = z.object({
      afterSentenceId: z.string().max(200).nullable(),
    }).safeParse(req.body);
    if (!parsed.success || !validImagePlacement(context.chapter, parsed.data.afterSentenceId || undefined))
      return res.status(400).json({ message: "موضع الصورة غير صحيح" });
    const alt = automaticIllustrationAlt(context.chapter, parsed.data.afterSentenceId || undefined);
    const updates: Record<string, unknown> = {
      alt_text: alt,
      after_sentence_id: parsed.data.afterSentenceId || null,
      updated_at: new Date().toISOString(),
    };
    const { data: asset, error } = await supabaseAdmin
      .from("chapter_assets")
      .update(updates)
      .eq("id", req.params.illustrationId)
      .eq("chapter_id", context.chapter.id)
      .eq("kind", "IMAGE")
      .select("id,bucket,object_path,alt_text,after_sentence_id,position")
      .maybeSingle();
    if (error) return res.status(503).json({ message: "تعذر حفظ تعديل الصورة" });
    if (!asset) return res.status(404).json({ message: "الصورة غير موجودة" });
    const illustration: ChapterIllustration = {
      id: asset.id,
      src: publicChapterAssetUrl(asset.bucket, asset.object_path),
      alt,
      afterSentenceId: asset.after_sentence_id || undefined,
      position: asset.position,
      storagePath: asset.bucket === "chapter-images" ? asset.object_path : undefined,
    };
    updateMemoryIllustration(context.chapterMeta, illustration);
    await recordAdminAudit(req.user!.id, "CHAPTER_IMAGE_UPDATED", "chapter", context.chapter.id, {
      illustrationId: asset.id,
      afterSentenceId: illustration.afterSentenceId || null,
    });
    res.json({ illustration });
  },
);
app.put(
  "/api/admin/chapters/:id/illustrations/:illustrationId/file",
  chapterImageUploadLimit,
  auth,
  requireRole("ADMIN"),
  chapterImageBody,
  async (req: AuthRequest, res) => {
    if (!supabaseAdmin) return res.status(503).json({ message: "التخزين غير متصل" });
    const context = adminChapter(String(req.params.id));
    if (!context) return res.status(404).json({ message: "الفصل غير موجود" });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const declaredMime = String(req.get("content-type") || "").split(";")[0].toLowerCase();
    if (!body.length || !imageExtension[declaredMime] || detectedImageMime(body) !== declaredMime)
      return res.status(400).json({ message: "الملف ليس صورة صالحة أو نوعه غير مطابق" });
    const { data: current, error: currentError } = await supabaseAdmin
      .from("chapter_assets")
      .select("id,bucket,object_path,alt_text,after_sentence_id,position")
      .eq("id", req.params.illustrationId)
      .eq("chapter_id", context.chapter.id)
      .eq("kind", "IMAGE")
      .maybeSingle();
    if (currentError) return res.status(503).json({ message: "تعذر قراءة بيانات الصورة" });
    if (!current) return res.status(404).json({ message: "الصورة غير موجودة" });
    const objectPath = `${context.chapter.id}/${randomUUID()}.${imageExtension[declaredMime]}`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from("chapter-images")
      .upload(objectPath, body, { contentType: declaredMime, cacheControl: "31536000", upsert: false });
    if (uploadError) return res.status(503).json({ message: "تعذر رفع الصورة البديلة" });
    const { data: asset, error: updateError } = await supabaseAdmin
      .from("chapter_assets")
      .update({
        bucket: "chapter-images",
        object_path: objectPath,
        content_type: declaredMime,
        byte_size: Buffer.byteLength(body),
        checksum_sha256: createHash("sha256").update(body).digest("hex"),
        alt_text: automaticIllustrationAlt(context.chapter, current.after_sentence_id || undefined),
        updated_at: new Date().toISOString(),
      })
      .eq("id", current.id)
      .select("id,bucket,object_path,alt_text,after_sentence_id,position")
      .single();
    if (updateError || !asset) {
      await supabaseAdmin.storage.from("chapter-images").remove([objectPath]);
      return res.status(503).json({ message: "تعذر ربط الصورة البديلة بالفصل" });
    }
    if (current.bucket === "chapter-images")
      await supabaseAdmin.storage.from("chapter-images").remove([current.object_path]);
    const illustration: ChapterIllustration = {
      id: asset.id,
      src: publicChapterAssetUrl(asset.bucket, asset.object_path),
      alt: automaticIllustrationAlt(context.chapter, asset.after_sentence_id || undefined),
      afterSentenceId: asset.after_sentence_id || undefined,
      position: asset.position,
      storagePath: asset.object_path,
    };
    updateMemoryIllustration(context.chapterMeta, illustration);
    await recordAdminAudit(req.user!.id, "CHAPTER_IMAGE_REPLACED", "chapter", context.chapter.id, {
      illustrationId: asset.id,
      objectPath,
    });
    res.json({ illustration });
  },
);
app.delete(
  "/api/admin/chapters/:id/illustrations/:illustrationId",
  auth,
  requireRole("ADMIN"),
  async (req: AuthRequest, res) => {
    if (!supabaseAdmin) return res.status(503).json({ message: "قاعدة البيانات غير متصلة" });
    const context = adminChapter(String(req.params.id));
    if (!context) return res.status(404).json({ message: "الفصل غير موجود" });
    const { data: asset, error: findError } = await supabaseAdmin
      .from("chapter_assets")
      .select("id,bucket,object_path")
      .eq("id", req.params.illustrationId)
      .eq("chapter_id", context.chapter.id)
      .eq("kind", "IMAGE")
      .maybeSingle();
    if (findError) return res.status(503).json({ message: "تعذر قراءة بيانات الصورة" });
    if (!asset) return res.status(404).json({ message: "الصورة غير موجودة" });
    const { error: deleteError } = await supabaseAdmin.from("chapter_assets").delete().eq("id", asset.id);
    if (deleteError) return res.status(503).json({ message: "تعذر حذف الصورة من قاعدة البيانات" });
    if (asset.bucket === "chapter-images") {
      const { error: storageError } = await supabaseAdmin.storage.from("chapter-images").remove([asset.object_path]);
      if (storageError) logger.warn({ error: storageError.message, path: asset.object_path }, "orphan chapter image cleanup failed");
    }
    context.chapterMeta.illustrations = (context.chapterMeta.illustrations || [])
      .filter((item) => item.id !== asset.id);
    await recordAdminAudit(req.user!.id, "CHAPTER_IMAGE_DELETED", "chapter", context.chapter.id, {
      illustrationId: asset.id,
      objectPath: asset.object_path,
    });
    res.status(204).end();
  },
);

app.get("/api/admin/audit-logs", auth, requireRole("ADMIN"), async (_req, res) => {
  if (supabaseAdmin) {
    const { data, error } = await supabaseAdmin
      .from("admin_audit_logs")
      .select("id,user_id,action,entity_type,entity_id,metadata,created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) return res.status(503).json({ message: "تعذر تحميل سجل التغييرات" });
    return res.json({ logs: data || [] });
  }
  res.json({ logs: db().auditLogs.slice().reverse().slice(0, 100) });
});

app.post(
  "/api/admin/books",
  auth,
  requireRole("ADMIN"),
  async (req: AuthRequest, res) => {
    const parsed = BookInput.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({
          message: "بيانات الكتاب غير صحيحة",
          issues: parsed.error.issues,
        });
    if (db().books.some((b) => b.slug === parsed.data.slug))
      return res.status(409).json({ message: "الرابط مستخدم" });
    const book: Book = {
      id: randomUUID(),
      currency: "SAR",
      status: "DRAFT",
      rating: 0,
      chapters: [],
      ...parsed.data,
    };
    db().books.push(book);
    await save();
    await recordAdminAudit(req.user!.id, "BOOK_CREATED", "book", book.id, {
      title: book.title,
      status: book.status,
    });
    res.status(201).json({ book });
  },
);
app.patch(
  "/api/admin/books/:id",
  auth,
  requireRole("ADMIN"),
  async (req: AuthRequest, res) => {
    const book = db().books.find((b) => b.id === req.params.id);
    if (!book) return res.status(404).json({ message: "الكتاب غير موجود" });
    const parsed = BookPatch.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "بيانات التعديل غير صحيحة" });
    Object.assign(book, parsed.data);
    await save();
    await recordAdminAudit(req.user!.id, "BOOK_UPDATED", "book", book.id, {
      fields: Object.keys(parsed.data),
    });
    res.json({ book });
  },
);
app.put(
  "/api/admin/books/:id/cover",
  chapterImageUploadLimit,
  auth,
  requireRole("ADMIN"),
  chapterImageBody,
  async (req: AuthRequest, res) => {
    if (!supabaseAdmin) return res.status(503).json({ message: "التخزين غير متصل" });
    const book = db().books.find((item) => item.id === req.params.id);
    if (!book) return res.status(404).json({ message: "الكتاب غير موجود" });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const declaredMime = String(req.get("content-type") || "").split(";")[0].toLowerCase();
    if (!body.length || !imageExtension[declaredMime] || detectedImageMime(body) !== declaredMime)
      return res.status(400).json({ message: "الملف ليس صورة صالحة أو نوعه غير مطابق" });

    const objectPath = `covers/${book.id}/${randomUUID()}.${imageExtension[declaredMime]}`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from("chapter-images")
      .upload(objectPath, body, { contentType: declaredMime, cacheControl: "31536000", upsert: false });
    if (uploadError) {
      logger.error({ error: uploadError.message, bookId: book.id }, "book cover upload failed");
      return res.status(503).json({ message: "تعذر رفع غلاف الرواية" });
    }

    const previousCoverUrl = book.coverUrl;
    book.coverUrl = publicChapterAssetUrl("chapter-images", objectPath);
    try {
      await save();
    } catch (error) {
      book.coverUrl = previousCoverUrl;
      await save().catch(() => undefined);
      await supabaseAdmin.storage.from("chapter-images").remove([objectPath]);
      logger.error({ error: String(error), bookId: book.id }, "book cover persistence failed");
      return res.status(503).json({ message: "تعذر حفظ غلاف الرواية" });
    }
    await recordAdminAudit(req.user!.id, "BOOK_COVER_UPDATED", "book", book.id, { objectPath })
      .catch((error) => logger.warn({ error: String(error), bookId: book.id }, "book cover audit failed"));
    res.json({ book });
  },
);
app.delete("/api/admin/books/:id", auth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const book = db().books.find((b) => b.id === req.params.id);
  if (!book) return res.status(404).json({ message: "الكتاب غير موجود" });
  book.status = "DRAFT";
  await save();
  await recordAdminAudit(req.user!.id, "BOOK_UNPUBLISHED", "book", book.id);
  res.status(204).end();
});
const persistentProfiles = async () => {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin
    .from("app_users")
    .select("id,email,phone,role,status,created_at,profiles(display_name,avatar_url),user_settings(theme),user_identities(provider)")
    .neq("status", "DELETED")
    .order("created_at", { ascending: false });
  if (error) {
    logger.warn({ error: error.message }, "persistent profiles unavailable");
    return [];
  }
  const normalized = (data || []).map((user: any) => ({
    id: user.id,
    display_name: user.profiles?.display_name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    theme: user.user_settings?.theme,
    avatar_url: user.profiles?.avatar_url,
    provider: user.user_identities?.[0]?.provider,
    created_at: user.created_at,
  }));
  return normalized.map((profile) => ({
    id: profile.id,
    name: profile.display_name || "قارئ rethox",
    email: profile.email || "",
    phone: profile.phone || undefined,
    role: profile.role === "ADMIN" ? "ADMIN" : "CUSTOMER",
    theme: profile.theme === "dark" ? "dark" : "light",
    createdAt: profile.created_at,
    avatarUrl: profile.avatar_url || undefined,
    oauthProvider: profile.provider || "supabase",
  }));
};
app.get("/api/admin/users", auth, requireRole("ADMIN"), async (_req, res) => {
  const remoteUsers = await persistentProfiles();
  const users = [...db().users.map((u) => publicUser(u.id)), ...remoteUsers]
    .filter((user, index, all) => all.findIndex((item) => item?.id === user?.id) === index);
  res.json({ users });
});
app.patch(
  "/api/admin/users/:id/role",
  auth,
  requireRole("ADMIN"),
  async (req: AuthRequest, res) => {
    const role = z.enum(["CUSTOMER", "ADMIN"]).safeParse(req.body.role);
    const user = db().users.find((u) => u.id === req.params.id);
    if (!role.success || !user)
      return res.status(400).json({ message: "الطلب غير صحيح" });
    user.role = role.data;
    await save();
    await recordAdminAudit(req.user!.id, "USER_ROLE_CHANGED", "user", user.id, {
      role: role.data,
    });
    res.json({ user: publicUser(user.id) });
  },
);
app.get("/api/admin/reports", auth, requireRole("ADMIN"), (_req, res) => {
  res.json({
    reports: db().reports
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((report) => ({
        ...report,
        user: publicUser(report.userId),
        bookTitle: db().books.find((book) => book.id === report.bookId)?.title || "كتاب محذوف",
        chapterTitle: db().books.flatMap((book) => book.chapters).find((chapter) => chapter.id === report.chapterId)?.title || "فصل محذوف",
      })),
  });
});
app.patch("/api/admin/reports/:id", auth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const status = z.enum(["OPEN", "RESOLVED"]).safeParse(req.body.status);
  const report = db().reports.find((item) => item.id === req.params.id);
  if (!status.success || !report)
    return res.status(400).json({ message: "البلاغ غير موجود" });
  report.status = status.data;
  report.updatedAt = new Date().toISOString();
  await save();
  await recordAdminAudit(req.user!.id, "REPORT_STATUS_CHANGED", "report", report.id, {
    status: report.status,
  });
  res.json({ report });
});
app.get("/api/admin/overview", auth, requireRole("ADMIN"), async (_req, res) => {
  const remoteUsers = await persistentProfiles();
  const userIds = new Set([...db().users.map((user) => user.id), ...remoteUsers.map((user) => user.id)]);
  res.json({
    counts: {
      books: db().books.length,
      users: userIds.size,
      orders: db().orders.length,
      openReports: db().reports.filter((report) => report.status === "OPEN").length,
      reviews: db().reviews.length + db().chapterComments.length,
    },
    orders: db().orders.slice(-10).reverse(),
  });
});
app.get("/api/admin/backups", auth, requireRole("ADMIN"), async (_req, res) => {
  if (!supabaseAdmin)
    return res.status(503).json({ message: "قاعدة البيانات غير متصلة" });
  const { data, error } = await supabaseAdmin
    .from("backup_runs")
    .select("id,kind,period_key,status,object_path,byte_size,row_counts,created_at,completed_at,error_message")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return res.status(503).json({ message: "تعذر تحميل النسخ الاحتياطية" });
  res.json({ backups: data || [] });
});
app.post("/api/admin/backups", auth, requireRole("ADMIN"), async (_req, res) => {
  if (!supabaseAdmin)
    return res.status(503).json({ message: "قاعدة البيانات غير متصلة" });
  try {
    const backup = await createRelationalBackup(supabaseAdmin, "MANUAL");
    res.status(201).json({ backup });
  } catch (error) {
    logger.error({ error: String(error) }, "manual backup failed");
    res.status(503).json({ message: "تعذر إنشاء النسخة الاحتياطية" });
  }
});

const webDist = resolve(rootDir, "apps/web/dist");
if (existsSync(webDist))
  app.use(
    express.static(webDist, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-store");
          return;
        }
        if (/\.(js|css)$/i.test(filePath))
          res.setHeader("Cache-Control", "no-cache, max-age=0, must-revalidate");
      },
    }),
  );

const staticSpaPaths = new Set([
  "/",
  "/login",
  "/register",
  "/cart",
  "/settings",
  "/account",
  "/admin",
]);

const decodePathSegment = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

const isKnownSpaPath = (requestPath: string) => {
  const normalizedPath =
    requestPath.length > 1 ? requestPath.replace(/\/+$/, "") : requestPath;
  if (staticSpaPaths.has(normalizedPath)) return true;

  const bookMatch = normalizedPath.match(/^\/book\/([^/]+)$/);
  if (bookMatch) {
    const slug = decodePathSegment(bookMatch[1]);
    return !!slug && db().books.some(
      (book) => book.slug === slug && book.status === "PUBLISHED",
    );
  }

  const volumeContentsMatch = normalizedPath.match(/^\/book\/([^/]+)\/volume\/([^/]+)$/);
  if (volumeContentsMatch) {
    const slug = decodePathSegment(volumeContentsMatch[1]);
    const chapterId = decodePathSegment(volumeContentsMatch[2]);
    return !!slug && !!chapterId && db().books.some(
      (book) =>
        book.slug === slug &&
        book.status === "PUBLISHED" &&
        book.chapters.some((chapter) => chapter.id === chapterId),
    );
  }

  const readerMatch = normalizedPath.match(/^\/reader\/([^/]+)$/);
  if (readerMatch) {
    const chapterId = decodePathSegment(readerMatch[1]);
    return !!chapterId && db().books.some(
      (book) =>
        book.status === "PUBLISHED" &&
        book.chapters.some((chapter) => chapter.id === chapterId),
    );
  }

  return false;
};

app.use((req, res) => {
  const servesSpa = req.method === "GET" || req.method === "HEAD";
  if (
    servesSpa &&
    !req.path.startsWith("/api/") &&
    isKnownSpaPath(req.path) &&
    existsSync(webDist)
  ) {
    res.setHeader("Cache-Control", "no-store");
    return res.sendFile(resolve(webDist, "index.html"));
  }
  if (servesSpa && !req.path.startsWith("/api/")) {
    res.setHeader("X-Robots-Tag", "noindex");
    return res.status(404).type("text/plain").send("Not Found");
  }
  res.status(404).json({ message: "المسار غير موجود" });
});
const apiErrorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (res.headersSent) return;
  const clientError = clientHttpError(error);
  if (clientError) {
    logger.warn(
      { method: req.method, path: req.path, status: clientError.status },
      "invalid request",
    );
    return res.status(clientError.status).json({ message: clientError.message });
  }
  logger.error({ method: req.method, path: req.path, error: String(error) }, "request failed");
  res.status(500).json({ message: "تعذر حفظ العملية بأمان، حاول مجددًا" });
};
app.use(apiErrorHandler);

const bootstrap = async () => {
  try {
    await connectRemoteStore(supabaseAdmin);
    if (supabaseAdmin) startBackupScheduler(supabaseAdmin);
  } catch (error) {
    logger.error({ error: String(error) }, "persistent Supabase store unavailable");
  }
  const adminEmail =
    process.env.ADMIN_EMAIL ||
    (process.env.NODE_ENV === "production" ? "" : "admin@rethox.local");
  const adminPassword =
    process.env.ADMIN_PASSWORD ||
    (process.env.NODE_ENV === "production" ? "" : "Rethox2026!");
  if (adminEmail && adminPassword && !db().users.some((u) => u.email === adminEmail)) {
    db().users.push({
      id: "admin-demo",
      name: "مدير rethox",
      email: adminEmail,
      passwordHash: await argon2.hash(adminPassword, { type: argon2.argon2id }),
      role: "ADMIN",
      theme: "dark",
      createdAt: new Date().toISOString(),
    });
    await save();
  }
  app.listen(port, "0.0.0.0", () =>
    console.log(`rethox API http://0.0.0.0:${port}`),
  );
};
bootstrap();
