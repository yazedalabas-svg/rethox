export const formatTime = (ms: number) =>
  `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

export const mergeUnique = (current: string[], value: string) =>
  current.includes(value) ? current : [...current, value];

export const normalizeWord = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();

// Maps TTS word boundaries onto the chapter's display tokens. The engine may
// emit boundaries that have no matching token (punctuation, split words); those
// must map to null WITHOUT consuming a token, otherwise the mapping drifts
// forward on long text until it pins to the last word.
export const alignBoundaries = (
  boundaries: { text: string }[],
  tokens: { id: string; text: string; sentenceIndex: number }[],
  lookahead = 12,
): ({ id: string; sentenceIndex: number } | null)[] => {
  let cursor = 0;
  return boundaries.map((boundary) => {
    const target = normalizeWord(boundary.text);
    if (!target) return null;
    for (
      let index = cursor;
      index < Math.min(tokens.length, cursor + lookahead);
      index += 1
    ) {
      const candidate = normalizeWord(tokens[index].text);
      if (
        candidate &&
        (candidate === target ||
          candidate.includes(target) ||
          target.includes(candidate))
      ) {
        cursor = index + 1;
        return { id: tokens[index].id, sentenceIndex: tokens[index].sentenceIndex };
      }
    }
    return null;
  });
};
