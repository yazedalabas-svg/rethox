import type { User } from "./types";

let accessToken: string | null = null;
export const setToken = (value: string | null) => { accessToken = value; };

export type AuthSession = { accessToken: string; user: User };
type AuthSessionListener = (session: AuthSession | null) => void;
let sessionListener: AuthSessionListener | null = null;
let refreshPromise: Promise<AuthSession> | null = null;

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

const request = async <T>(path: string, options: RequestInit = {}): Promise<T> => {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  const response = await fetch(apiUrl(path), { ...options, headers, credentials: "include" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    throw new ApiError(response.status, data);
  }
  return response.status === 204 ? undefined as T : response.json();
};

export const refreshSession = (): Promise<AuthSession> => {
  if (!refreshPromise) {
    refreshPromise = request<AuthSession>("/auth/refresh", { method: "POST" })
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
