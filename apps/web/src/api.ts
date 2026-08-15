import type { User } from "./types";

let accessToken: string | null = null;
export const setToken = (value: string | null) => { accessToken = value; };

export type AuthSession = { accessToken: string; user: User };
type AuthSessionListener = (session: AuthSession | null) => void;
let sessionListener: AuthSessionListener | null = null;
let refreshPromise: Promise<AuthSession> | null = null;
let csrfBootstrapPromise: Promise<void> | null = null;

const csrfToken = () => {
  if (typeof document === "undefined") return "";
  const prefix = "rethox_csrf=";
  const value = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix));
  if (!value) return "";
  try { return decodeURIComponent(value.slice(prefix.length)); }
  catch { return ""; }
};

export const setAuthSessionListener = (listener: AuthSessionListener | null) => {
  sessionListener = listener;
  return () => {
    if (sessionListener === listener) sessionListener = null;
  };
};

export const accessTokenExpiresAt = (token: string) => {
  try {
    const payload = token.split(".")[1];
    if (!payload) return 0;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))) as { exp?: number };
    return typeof decoded.exp === "number" ? decoded.exp * 1000 : 0;
  } catch {
    return 0;
  }
};

// Empty in local development: Vite proxies the API on the same origin.
// In production the static Cloudflare site can point at the Express API
// without ever exposing server-side Supabase credentials.
const productionApiOrigin = "";
const configuredApiOrigin = (import.meta.env.VITE_API_BASE_URL || productionApiOrigin).trim().replace(/\/$/, "");
export const apiUrl = (path: string) => `${configuredApiOrigin}/api${path.startsWith("/") ? path : `/${path}`}`;

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(status: number, data: Record<string, unknown>) {
    super(String(data.message || "حدث خطأ غير متوقع"));
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

const mutatingMethod = (method?: string) =>
  ["POST", "PUT", "PATCH", "DELETE"].includes((method || "GET").toUpperCase());

// The refresh cookie is HttpOnly, so an old browser session cannot repair its
// CSRF state from JavaScript.  Prime the cookie through a same-origin GET once
// before any mutating request.  Concurrent requests share one bootstrap call.
const ensureCsrfToken = async () => {
  if (csrfToken()) return;
  if (!csrfBootstrapPromise) {
    csrfBootstrapPromise = fetch(apiUrl("/auth/csrf"), {
      credentials: "include",
      cache: "no-store",
    }).then((response) => {
      if (!response.ok) throw new ApiError(response.status, {});
    }).finally(() => { csrfBootstrapPromise = null; });
  }
  await csrfBootstrapPromise;
};

const request = async <T>(path: string, options: RequestInit = {}): Promise<T> => {
  if (mutatingMethod(options.method)) await ensureCsrfToken();
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  const csrf = csrfToken();
  if (csrf) headers.set("x-rethox-csrf", csrf);
  const response = await fetch(apiUrl(path), { ...options, headers, credentials: "include" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    throw new ApiError(response.status, data);
  }
  return response.status === 204 ? undefined as T : response.json();
};

const downloadRequest = async (path: string) => {
  // A stalled PDF response used to leave the export button disabled forever.
  // Give large books ample time while still returning control to the reader if
  // the connection has genuinely stopped.
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 8 * 60_000);
  const headers = new Headers();
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  try {
    const response = await fetch(apiUrl(path), {
      headers,
      credentials: "include",
      signal: controller.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      throw new ApiError(response.status, data);
    }
    return await response.blob();
  } finally {
    globalThis.clearTimeout(timeout);
  }
};

export const refreshSession = (): Promise<AuthSession> => {
  if (!refreshPromise) {
    const refreshRequest = () => request<AuthSession>("/auth/refresh", { method: "POST" });
    refreshPromise = refreshRequest()
      .catch(async (error) => {
        // A refresh token is rotated after every renewal. Two open tabs can
        // legitimately renew at the same moment: the first response updates
        // the shared cookie, while the second request still carries the old
        // value. Retry once after that cookie update instead of logging the
        // reader out for a harmless cross-tab race.
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
        await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
        return refreshRequest();
      })
      .then((session) => {
        setToken(session.accessToken);
        sessionListener?.(session);
        return session;
      })
      .catch((error) => {
        // A temporary network/server error must not eject a signed-in reader.
        // Only the auth server's explicit rejection ends the local session.
        if (error instanceof ApiError && error.status === 401) {
          setToken(null);
          sessionListener?.(null);
        }
        throw error;
      })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
};

const authPathsThatMustNotRefresh = new Set([
  "/auth/login",
  "/auth/register",
  "/auth/google/id-token",
  "/auth/phone/start",
  "/auth/phone/verify",
  "/auth/refresh",
  "/auth/logout",
]);

export const api = async <T>(path: string, options: RequestInit = {}, retry = true): Promise<T> => {
  try {
    return await request<T>(path, options);
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 401 &&
      retry &&
      !authPathsThatMustNotRefresh.has(path)
    ) {
      await refreshSession();
      return request<T>(path, options);
    }
    throw error;
  }
};

export const downloadFile = async (path: string, filename: string) => {
  let blob: Blob;
  try {
    blob = await downloadRequest(path);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    await refreshSession();
    blob = await downloadRequest(path);
  }
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // The browser consumes a blob URL asynchronously after click(). Revoking it
  // in the same turn intermittently aborts large exports, particularly on
  // Chromium. Keep it alive long enough for the download manager to own it.
  globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
};
