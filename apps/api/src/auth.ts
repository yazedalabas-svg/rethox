import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { db } from "./store.js";
import type { Role } from "./types.js";

const configuredSecret = process.env.JWT_SECRET?.trim();
// Never use a public/default signing key in production. An ephemeral key keeps
// the service secure if hosting was configured manually instead of render.yaml;
// refresh cookies still restore sessions after a restart.
const secret = configuredSecret || (
  process.env.NODE_ENV === "production"
    ? randomBytes(48).toString("base64url")
    : "rethox-local-development-only-secret"
);

export const hasPersistentSessionSecret = Boolean(configuredSecret && configuredSecret.length >= 32);
export type AuthRequest = Request & { user?: { id: string; role: Role } };
export const accessToken = (id: string, _role: Role) =>
  jwt.sign({ sub: id }, secret, { expiresIn: "10m", issuer: "rethox-api", audience: "rethox-web" });
export const refreshValue = () => `${randomUUID()}.${randomUUID()}`;
export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");

const authenticatedUser = (value?: string) => {
  if (!value) return undefined;
  const payload = jwt.verify(value, secret, {
    issuer: "rethox-api",
    audience: "rethox-web",
  }) as jwt.JwtPayload;
  const user = db().users.find((item) => item.id === String(payload.sub));
  return user ? { id: user.id, role: user.role } : undefined;
};

export const auth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const value = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!value) return res.status(401).json({ message: "يلزم تسجيل الدخول" });
  try {
    req.user = authenticatedUser(value);
    if (!req.user) return res.status(401).json({ message: "الحساب غير موجود" });
    next();
  } catch {
    res.status(401).json({ message: "انتهت الجلسة" });
  }
};

export const optionalAuth = (req: AuthRequest, _res: Response, next: NextFunction) => {
  const value = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (value) {
    try { req.user = authenticatedUser(value); } catch { /* guest request */ }
  }
  next();
};

export const requireRole = (role: Role) => (req: AuthRequest, res: Response, next: NextFunction) => {
  const user = req.user && db().users.find((item) => item.id === req.user!.id);
  if (!user || user.role !== role)
    return res.status(403).json({ message: "لا تملك الصلاحية" });
  req.user = { id: user.id, role: user.role };
  next();
};

export const publicUser = (id: string) => {
  const user = db().users.find((item) => item.id === id);
  return user && {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    theme: user.theme,
    oauthProvider: user.oauthProvider,
  };
};

export const publicAuthor = (id: string) => {
  const user = db().users.find((item) => item.id === id);
  return user && { id: user.id, name: user.name };
};
