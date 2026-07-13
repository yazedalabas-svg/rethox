import type { User } from "./types";

let accessToken: string | null = null;
export const setToken = (value: string | null) => { accessToken = value; };

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
  const response = await fetch(`/api${path}`, { ...options, headers, credentials: "include" });
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
