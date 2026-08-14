export type TextDirection = "rtl" | "ltr";

// A word-by-word renderer turns every word into its own button. In an RTL
// paragraph that can make a consecutive English phrase visually reverse. Keep
// each contiguous directional run together so the browser's bidi algorithm can
// lay out the complete phrase in its native reading direction.
const rtlCharacter = /[\u0590-\u08ff\ufb1d-\ufdfd\ufe70-\ufefc]/u;
const ltrCharacter = /[A-Za-z\u00c0-\u024f\u1e00-\u1eff0-9]/u;

export const textDirection = (text: string): TextDirection | null => {
  const rtlIndex = text.search(rtlCharacter);
  const ltrIndex = text.search(ltrCharacter);
  if (rtlIndex < 0 && ltrIndex < 0) return null;
  if (rtlIndex < 0) return "ltr";
  if (ltrIndex < 0) return "rtl";
  return rtlIndex < ltrIndex ? "rtl" : "ltr";
};

export const paragraphDirection = (text: string): TextDirection =>
  textDirection(text) || "rtl";

export const groupBidiRuns = <T extends { text: string }>(tokens: T[]) => {
  const runs: { direction: TextDirection; tokens: T[] }[] = [];
  for (const token of tokens) {
    // Punctuation and symbols follow the nearest preceding run. This keeps
    // closing quotes and full stops with the English or Arabic phrase they end.
    const direction = textDirection(token.text) || runs.at(-1)?.direction || "rtl";
    const previous = runs.at(-1);
    if (previous?.direction === direction) previous.tokens.push(token);
    else runs.push({ direction, tokens: [token] });
  }
  return runs;
};
