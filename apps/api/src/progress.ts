import type { Chapter } from "./types.js";

const chapterWeight = (chapter: Chapter) =>
  Math.max(1, chapter.sentenceCount ?? chapter.sentences.length);

/** Estimate whole-book progress by content weight rather than chapter count. */
export const weightedBookProgress = (
  chapters: Chapter[],
  chapterId: string,
  chapterPercentage: number,
) => {
  const ordered = [...chapters].sort((a, b) => a.position - b.position);
  const current = ordered.find((chapter) => chapter.id === chapterId);
  if (!current || !ordered.length) return 0;
  const totalWeight = ordered.reduce((sum, chapter) => sum + chapterWeight(chapter), 0);
  const completedWeight = ordered.reduce((sum, chapter) => {
    const weight = chapterWeight(chapter);
    if (chapter.position < current.position) return sum + weight;
    if (chapter.id === current.id)
      return sum + weight * Math.min(100, Math.max(0, chapterPercentage)) / 100;
    return sum;
  }, 0);
  const percentage = Math.min(100, Math.max(0, completedWeight / totalWeight * 100));
  // Match PostgreSQL numeric(5,2) and avoid floating point drift in the API.
  return Math.round(percentage * 100) / 100;
};

export const safeClientTimestamp = (value: string | undefined, now = Date.now()) => {
  const parsed = value ? Date.parse(value) : now;
  if (!Number.isFinite(parsed)) return new Date(now).toISOString();
  // A future client clock must not block legitimate progress writes.
  return new Date(Math.min(parsed, now)).toISOString();
};
