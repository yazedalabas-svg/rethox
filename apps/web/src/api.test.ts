import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accessTokenExpiresAt,
  api,
  downloadFile,
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
  vi.useRealTimers();
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

  it("keeps the session when another tab has just rotated the refresh cookie", async () => {
    vi.useFakeTimers();
    const session = {
      accessToken: jwt(1_800_000_000),
      user: { id: "u1", name: "قارئ", email: "reader@example.com", role: "CUSTOMER" as const, theme: "light" },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "انتهت الجلسة" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(session), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("document", { cookie: "rethox_csrf=csrf-token" });
    vi.stubGlobal("fetch", fetchMock);

    const refreshed = refreshSession();
    await vi.advanceTimersByTimeAsync(300);
    await expect(refreshed).resolves.toEqual(session);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("does not revoke a PDF blob URL before the browser can start the download", async () => {
    vi.useFakeTimers();
    const click = vi.fn();
    const append = vi.fn();
    const remove = vi.fn();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("document", {
      cookie: "",
      body: { append },
      createElement: vi.fn(() => ({ click, remove, href: "", download: "" })),
    });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:book"),
      revokeObjectURL,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Blob(["pdf"]), { status: 200 })));

    await downloadFile("/books/book-1/pdf", "book.pdf");

    expect(append).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:book");
  });
});
