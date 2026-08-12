import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Store } from "./types.js";
import { emptyStore } from "./seed.js";
import { loadRelationalStore, syncCatalog, syncRelationalStore } from "./relational-store.js";

const dataDir = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : resolve(process.cwd(), "data");
const file = resolve(dataDir, "runtime-store.json");
const progressFile = resolve(dataDir, "runtime-progress.json");
const sessionsFile = resolve(dataDir, "runtime-sessions.json");
const deploySeed = resolve(process.cwd(), "data/deploy-seed.json");
const visibleBookIds = new Set(
  (process.env.VISIBLE_BOOK_IDS || "book-rezero-arc-6,book-reverend-insanity,book-mushoku-tensei,book-reader-view")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);
let state:Store;
let seeded:Store | null = null;
let remoteStore: SupabaseClient | null = null;
let remoteWrite: Promise<void> = Promise.resolve();
let relationalEnabled = false;
let lastRemoteErrorAt: string | null = null;
let legacyProgressCheckpointTimer: ReturnType<typeof setTimeout> | null = null;
const mergeLatestProgress = (...sources: Store["progress"][]) => {
  const progressByKey = new Map<string, Store["progress"][number]>();
  for (const source of sources) {
    for (const item of source) {
      const key = `${item.userId}:${item.bookId}`;
      const current = progressByKey.get(key);
      if (!current || item.updatedAt > current.updatedAt) progressByKey.set(key, item);
    }
  }
  return [...progressByKey.values()];
};
// Refreshes the shipped catalog from the immutable deploy seed (titles,
// chapter structure, pricing, ...) while keeping each chapter's *current*
// illustrations. Illustrations uploaded through the admin panel live only in
// Supabase (chapter_assets), never in the seed file — blindly overwriting a
// shipped book with the raw seed on every boot silently reverted every
// admin-added image back to whatever static illustrations shipped in git.
const applyShippedCatalog = (books: Store["books"]): Store["books"] => {
  if (!seeded?.books?.length) return books;
  const shippedIds = new Set(seeded.books.map((book) => book.id));
  const currentById = new Map(books.map((book) => [book.id, book]));
  const refreshed = seeded.books.map((seededBook) => {
    const current = currentById.get(seededBook.id);
    if (!current) return seededBook;
    const currentChaptersById = new Map(current.chapters.map((chapter) => [chapter.id, chapter]));
    return {
      ...seededBook,
      chapters: seededBook.chapters.map((chapter) => {
        const currentChapter = currentChaptersById.get(chapter.id);
        return currentChapter ? { ...chapter, illustrations: currentChapter.illustrations } : chapter;
      }),
    };
  });
  return [...refreshed, ...books.filter((book) => !shippedIds.has(book.id))];
};
try {
  seeded = existsSync(deploySeed)
    ? JSON.parse(readFileSync(deploySeed, "utf8"))
    : null;
  state = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : seeded ?? emptyStore();
} catch { state = emptyStore(); }
state.reviews ??= [];
state.chapterComments ??= [];
state.readingList ??= [];
state.reports ??= [];
state.progress ??= [];
// Session rotations happen far more often than catalog/account writes. Keep a
// tiny journal so login/refresh/logout never serialize the full novel store.
try {
  const journal = existsSync(sessionsFile)
    ? JSON.parse(readFileSync(sessionsFile, "utf8")) as Store["refreshTokens"]
    : null;
  if (journal) state.refreshTokens = journal;
} catch {
  // Fall back to the last complete store snapshot if the optional journal is corrupt.
}
// The progress journal is intentionally separate from the large legacy store.
// It lets frequent reader checkpoints survive a local restart without
// serializing the catalog, accounts, orders and comments on every tick.
try {
  const journal = existsSync(progressFile)
    ? JSON.parse(readFileSync(progressFile, "utf8")) as Store["progress"]
    : [];
  state.progress = mergeLatestProgress(state.progress, journal);
} catch {
  // A corrupt optional journal must not prevent the durable relational store
  // or the last complete local snapshot from starting.
}
// A persistent Render disk can contain an older catalog. Merge shipped books on
// every boot while preserving accounts, orders, reviews and reading progress.
state.books = applyShippedCatalog(state.books);
state.books = state.books.filter((book) => visibleBookIds.has(book.id));
export const db = () => state;
const writeAtomicJson = (target: string, value: unknown) => {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  renameSync(temporary, target);
};
const writeLocal = () => {
  writeAtomicJson(file, state);
  writeAtomicJson(progressFile, state.progress);
  writeAtomicJson(sessionsFile, state.refreshTokens);
};
const queueRemoteWrite = (
  options: { skipRelational?: boolean } = {},
): Promise<void> => {
  if (!remoteStore) return Promise.resolve();
  const client = remoteStore;
  const relationalSnapshot = relationalEnabled && !options.skipRelational
    ? JSON.parse(JSON.stringify(state)) as Store
    : null;
  const snapshot = JSON.parse(JSON.stringify(state)) as Store;
  // Shipped catalog/content already lives in the immutable deploy seed. Keeping
  // it out of every user-data snapshot makes each comment/progress write small
  // and prevents large novels from overwhelming PostgREST.
  if (seeded?.books?.length) {
    const shippedIds = new Set(seeded.books.map((book) => book.id));
    snapshot.books = snapshot.books.filter((book) => !shippedIds.has(book.id));
  }
  const operation = remoteWrite.then(async () => {
    const { error } = await client.from("rethox_state").upsert({
      id: "primary",
      payload: snapshot,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    if (relationalSnapshot)
      await syncRelationalStore(client, relationalSnapshot);
    lastRemoteErrorAt = null;
  });
  // Keep subsequent writes serial after a failure, while returning the rejecting
  // operation to the request that initiated it. An API request must not report
  // success when its durable Supabase write did not complete.
  remoteWrite = operation.catch((error) => {
    lastRemoteErrorAt = new Date().toISOString();
    console.error("Supabase state persistence failed", error);
  });
  return operation;
};
export const save = (options: { skipRelational?: boolean } = {}) => {
  writeLocal();
  return queueRemoteWrite(options);
};
export const saveSessionChange = (change: {
  issued?: Store["refreshTokens"][number];
  revokedHashes?: string[];
}) => {
  writeAtomicJson(sessionsFile, state.refreshTokens);
  if (!remoteStore) return Promise.resolve();
  if (!relationalEnabled) return queueRemoteWrite({ skipRelational: true });
  const client = remoteStore;
  const revokedHashes = [...new Set(change.revokedHashes || [])];
  const operation = remoteWrite.then(async () => {
    if (change.issued) {
      const { error } = await client.from("user_sessions").upsert({
        user_id: change.issued.userId,
        token_hash: change.issued.hash,
        expires_at: change.issued.expiresAt,
        revoked_at: null,
      }, { onConflict: "token_hash" });
      if (error) throw error;
    }
    if (revokedHashes.length) {
      const { error } = await client
        .from("user_sessions")
        .update({ revoked_at: new Date().toISOString() })
        .in("token_hash", revokedHashes);
      if (error) throw error;
    }
    lastRemoteErrorAt = null;
  });
  remoteWrite = operation.catch((error) => {
    lastRemoteErrorAt = new Date().toISOString();
    console.error("Supabase session persistence failed", error);
  });
  return operation;
};
// Progress is already committed atomically to reading_progress/chapter_progress.
// Keep the local disk current immediately, and only coalesce the legacy state
// snapshot as a rollback checkpoint instead of rewriting it every few seconds.
export const saveProgressCheckpoint = () => {
  writeAtomicJson(progressFile, state.progress);
  if (!remoteStore || legacyProgressCheckpointTimer) return Promise.resolve();
  const delay = Math.max(
    60_000,
    Number(process.env.LEGACY_PROGRESS_CHECKPOINT_MS || 5 * 60_000),
  );
  legacyProgressCheckpointTimer = setTimeout(() => {
    legacyProgressCheckpointTimer = null;
    void queueRemoteWrite({ skipRelational: true }).catch(() => undefined);
  }, delay);
  legacyProgressCheckpointTimer.unref?.();
  return Promise.resolve();
};
export const connectRemoteStore = async (client: SupabaseClient | null) => {
  if (!client) return false;
  try {
    const relational = await loadRelationalStore(client, seeded?.books || state.books);
    if (relational) {
      state = relational;
      state.books = applyShippedCatalog(state.books);
      state.books = state.books.filter((book) => visibleBookIds.has(book.id));
      await syncCatalog(client, state.books);
      relationalEnabled = true;
      remoteStore = client;
      lastRemoteErrorAt = null;
      writeLocal();
      return true;
    }
    const { data, error } = await client
      .from("rethox_state")
      .select("payload")
      .eq("id", "primary")
      .maybeSingle();
    if (error) throw error;
    if (data?.payload && typeof data.payload === "object") {
      const remote = data.payload as Store;
      remote.reviews ??= [];
      remote.chapterComments ??= [];
      remote.readingList ??= [];
      remote.reports ??= [];
      remote.progress = mergeLatestProgress(remote.progress || [], state.progress);
      remote.books = applyShippedCatalog(remote.books || []);
      remote.books = remote.books.filter((book) => visibleBookIds.has(book.id));
      state = remote;
      remoteStore = client;
      writeLocal();
    } else {
      remoteStore = client;
      await queueRemoteWrite();
    }
    lastRemoteErrorAt = null;
    return true;
  } catch (error) {
    remoteStore = null;
    relationalEnabled = false;
    lastRemoteErrorAt = new Date().toISOString();
    throw error;
  }
};
export const persistenceStatus = () => ({
  remoteConnected: Boolean(remoteStore),
  relationalEnabled,
  lastRemoteErrorAt,
});
export const reset = () => { state=emptyStore(); return save(); };
