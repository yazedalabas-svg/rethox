import { describe, expect, it } from "vitest";
import { groupBidiRuns, paragraphDirection } from "./bidi";

describe("mixed Arabic and English reader text", () => {
  it("keeps a consecutive English phrase as one left-to-right run", () => {
    const runs = groupBidiRuns([
      { text: "قال" },
      { text: "Julius:" },
      { text: "The" },
      { text: "Witch" },
      { text: "Beasts." },
      { text: "تقترب." },
    ]);

    expect(runs.map((run) => [run.direction, run.tokens.map((token) => token.text)])).toEqual([
      ["rtl", ["قال"]],
      ["ltr", ["Julius:", "The", "Witch", "Beasts."]],
      ["rtl", ["تقترب."]],
    ]);
  });

  it("uses the first meaningful script for a whole paragraph", () => {
    expect(paragraphDirection("رأى Julius البرج")).toBe("rtl");
    expect(paragraphDirection("The Witch Beasts arrive")).toBe("ltr");
  });
});
