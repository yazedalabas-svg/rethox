import { readdir, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";

type CacheEntry = { base: string; bytes: number; modifiedAt: number; files: string[] };

/** Removes the oldest complete cache pairs until their total fits the budget. */
export const trimPairedCache = async (
  directory: string,
  maxBytes: number,
  keepBase?: string,
) => {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return 0;
  const names = await readdir(directory);
  const grouped = new Map<string, string[]>();
  for (const name of names) {
    if (!/^[a-f0-9]+\.(?:mp3|json)$/i.test(name)) continue;
    const base = name.replace(/\.(?:mp3|json)$/i, "");
    grouped.set(base, [...(grouped.get(base) || []), name]);
  }
  const entries: CacheEntry[] = [];
  for (const [base, files] of grouped) {
    let bytes = 0;
    let modifiedAt = 0;
    for (const name of files) {
      const details = await stat(resolve(directory, name));
      bytes += details.size;
      modifiedAt = Math.max(modifiedAt, details.mtimeMs);
    }
    entries.push({ base, bytes, modifiedAt, files });
  }
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  let removed = 0;
  for (const entry of entries.sort((a, b) => a.modifiedAt - b.modifiedAt)) {
    if (total <= maxBytes) break;
    if (entry.base === keepBase) continue;
    await Promise.all(entry.files.map((name) => unlink(resolve(directory, name)).catch(() => undefined)));
    total -= entry.bytes;
    removed += entry.bytes;
  }
  return removed;
};
