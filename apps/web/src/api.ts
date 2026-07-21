import type { User } from "./types";

let accessToken: string | null = null;
export const setToken = (value: string | null) => { accessToken = value; };

// Empty in local development: Vite proxies the API on the same origin.
// In production the static Cloudflare site can point at the Express API
// without ever exposing server-side Supabase credentials.
const productionApiOrigin = typeof window !== "undefined" && window.location.hostname === "rethox.online"
  ? "https://api.rethox.online"
  : "";
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

export const api = async <T>(path: string, options: RequestInit = {}, retry = true): Promise<T> => {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  const response = await fetch(apiUrl(path), { ...options, headers, credentials: "include" });
  if (response.status === 401 && retry && path !== "/auth/refresh") {
    try {
      const session = await api<{ accessToken: string; user: User }>("/auth/refresh", { method: "POST" }, false);
      setToken(session.accessToken);
      return api<T>(path, options, false);
    } catch { setToken(null); }
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    throw new ApiError(response.status, data);
  }
  return response.status === 204 ? undefined as T : response.json();
};
