import { describe, expect, it } from "vitest";
import { alignBoundaries, formatTime, mergeUnique, normalizeWord } from "./utils";

describe("reader utilities", () => {
  it("formats media time", () => expect(formatTime(65_000)).toBe("01:05"));
  it("does not duplicate cart ids", () => expect(mergeUnique(["a"], "a")).toEqual(["a"]));
});

describe("normalizeWord", () => {
  it("strips diacritics and punctuation", () =>
    expect(normalizeWord("قَالَ:")).toBe(normalizeWord("قال")));
  it("normalizes punctuation-only text to empty", () =>
    expect(normalizeWord("،")).toBe(""));
});

describe("alignBoundaries", () => {
  const makeTokens = (words: string[]) =>
    words.map((text, index) => ({
      id: `t${index}`,
      text,
      sentenceIndex: Math.floor(index / 5),
    }));

  it("maps boundaries onto tokens in order", () => {
    const tokens = makeTokens(["حين", "وصلت", "نور", "إلى", "السور"]);
    const mapped = alignBoundaries(
      tokens.map(({ text }) => ({ text })),
      tokens,
    );
    expect(mapped.map((item) => item?.id)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
  });

  it("does not drift when the engine emits punctuation-only boundaries (long-text desync bug)", () => {
    const words = Array.from({ length: 120 }, (_, index) => `كلمة${index}`);
    const tokens = makeTokens(words);
    // The TTS engine reports a punctuation boundary after every word.
    const boundaries = words.flatMap((text) => [{ text }, { text: "،" }]);
    const mapped = alignBoundaries(boundaries, tokens);
    words.forEach((_, index) => {
      expect(mapped[index * 2]?.id).toBe(`t${index}`);
      expect(mapped[index * 2 + 1]).toBeNull();
    });
    // The last word maps to the last token — and nothing before it does.
    const lastHits = mapped.filter((item) => item?.id === `t${words.length - 1}`);
    expect(lastHits).toHaveLength(1);
  });

  it("keeps later words in sync when a boundary has no matching token", () => {
    const tokens = makeTokens(["قال", "الحارس", "من", "خلف", "الزجاج"]);
    const boundaries = [
      { text: "قال" },
      { text: "xyz" }, // engine artifact that matches no token
      { text: "الحارس" },
      { text: "من" },
      { text: "خلف" },
      { text: "الزجاج" },
    ];
    const mapped = alignBoundaries(boundaries, tokens);
    expect(mapped[1]).toBeNull();
    expect(mapped.filter(Boolean).map((item) => item?.id)).toEqual([
      "t0",
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
  });

  it("skips display tokens the engine merged over", () => {
    const tokens = makeTokens(["في", "مكتبة", "صغيرة", "على", "أطراف"]);
    const boundaries = [{ text: "في" }, { text: "صغيرة" }, { text: "أطراف" }];
    const mapped = alignBoundaries(boundaries, tokens);
    expect(mapped.map((item) => item?.id)).toEqual(["t0", "t2", "t4"]);
  });
});
