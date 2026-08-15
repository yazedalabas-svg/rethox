import { describe, expect, it } from "vitest";
import { rotateRefreshSession, type RefreshSession } from "./refresh-sessions.js";

describe("rotateRefreshSession", () => {
  it("invalidates the old token and preserves the user", () => {
    const now = Date.now();
    const sessions: RefreshSession[] = [{
      userId: "reader-1",
      hash: "old",
      expiresAt: new Date(now + 10_000).toISOString(),
    }];
    const result = rotateRefreshSession(sessions, "old", "new", now, 20_000);
    expect(result?.previous.hash).toBe("old");
    expect(sessions).toEqual([{
      userId: "reader-1",
      hash: "new",
      expiresAt: new Date(now + 20_000).toISOString(),
    }]);
  });

  it("does not revive an expired token", () => {
    const now = Date.now();
    const sessions: RefreshSession[] = [{
      userId: "reader-1",
      hash: "old",
      expiresAt: new Date(now - 1).toISOString(),
    }];
    expect(rotateRefreshSession(sessions, "old", "new", now, 20_000)).toBeNull();
    expect(sessions[0].hash).toBe("old");
  });
});
