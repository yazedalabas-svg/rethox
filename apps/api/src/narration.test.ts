import { describe, expect, it } from "vitest";
import { normalizeNarrationText } from "./narration.js";

describe("normalizeNarrationText", () => {
  it("keeps the reader text intact while smoothing typographic pauses for speech", () => {
    expect(normalizeNarrationText("قال… «ثم—توقف»"))
      .toBe("قال، ثم، توقف");
  });

  it("removes non-spoken decorations and collapses spacing", () => {
    expect(normalizeNarrationText("أهلاً  ■■   بك"))
      .toBe("أهلاً بك");
  });
});
