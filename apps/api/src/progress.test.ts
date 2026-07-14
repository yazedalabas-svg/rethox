import { describe, expect, it } from "vitest";
import { safeClientTimestamp, weightedBookProgress } from "./progress.js";
import type { Chapter } from "./types.js";

const chapter = (id: string, position: number, sentenceCount: number): Chapter => ({
  id,
  bookId: "book",
  title: id,
  position,
  durationMs: 1,
  isSample: position === 1,
  sentences: [],
  sentenceCount,
});

describe("weightedBookProgress", () => {
  const chapters = [chapter("short", 1, 10), chapter("long", 2, 90)];

  it("weights progress by chapter content size", () => {
    expect(weightedBookProgress(chapters, "short", 100)).toBe(10);
    expect(weightedBookProgress(chapters, "long", 50)).toBe(55);
  });

  it("clamps invalid percentages", () => {
    expect(weightedBookProgress(chapters, "short", -10)).toBe(0);
    expect(weightedBookProgress(chapters, "long", 120)).toBe(100);
  });
});

describe("safeClientTimestamp", () => {
  it("clamps future timestamps to the server clock", () => {
    expect(safeClientTimestamp("2026-07-14T00:00:00.000Z", Date.parse("2026-07-13T00:00:00.000Z")))
      .toBe("2026-07-13T00:00:00.000Z");
  });
});
