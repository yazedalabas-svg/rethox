import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accessTokenExpiresAt,
  api,
  refreshSession,
  setAuthSessionListener,
  setToken,
} from "./api";

const jwt = (expiresAtSeconds: number) => {
  const encode = (value: object) => btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode({ exp: expiresAtSeconds })}.signature`;
};

afterEach(() => {
  vi.unstubAllGlobals();
  setAuthSessionListener(null);
  setToken(null);
});

describe("auth session transport", () => {
  it("reads the JWT expiry used by proactive session renewal", () => {
    expect(accessTokenExpiresAt(jwt(1_800_000_000))).toBe(1_800_000_000_000);
    expect(accessTokenExpiresAt("broken-token")).toBe(0);
  });

  it("coalesces simultaneous refreshes into one server request", async () => {
    const session = {
      accessToken: jwt(1_800_000_000),
      user: { id: "u1", name: "قارئ", email: "reader@example.com", role: "CUSTOMER" as const, theme: "light" },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(session), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("document", { cookie: "rethox_csrf=csrf-token" });
    vi.stubGlobal("fetch", fetchMock);

    const first = refreshSession();
    const second = refreshSession();
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/refresh", expect.objectContaining({ credentials: "include" }));
  });

  it("sends the double-submit CSRF token with mutating requests", async () => {
    vi.stubGlobal("document", { cookie: "rethox_csrf=csrf-token" });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await api("/auth/logout", { method: "POST" });

    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get("x-rethox-csrf")).toBe("csrf-token");
  });

  it("bootstraps a missing CSRF cookie once before a protected request", async () => {
    const session = {
      accessToken: jwt(1_800_000_000),
      user: { id: "u1", name: "قارئ", email: "reader@example.com", role: "CUSTOMER" as const, theme: "light" },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(session), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("document", { cookie: "" });
    vi.stubGlobal("fetch", fetchMock);

    await refreshSession();

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/auth/csrf", {
      credentials: "include",
      cache: "no-store",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/auth/refresh", expect.objectContaining({ credentials: "include" }));
  });
});
