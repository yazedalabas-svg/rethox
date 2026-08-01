import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accessTokenExpiresAt,
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
    vi.stubGlobal("fetch", fetchMock);

    const first = refreshSession();
    const second = refreshSession();
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/refresh", expect.objectContaining({ credentials: "include" }));
  });
});
