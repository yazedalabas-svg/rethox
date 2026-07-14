import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Store } from "./types.js";
import { emptyStore } from "./seed.js";
import { loadRelationalStore, syncRelationalStore } from "./relational-store.js";

const dataDir = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : resolve(process.cwd(), "data");
const file = resolve(dataDir, "runtime-store.json");
const progressFile = resolve(dataDir, "runtime-progress.json");
const deploySeed = resolve(process.cwd(), "data/deploy-seed.json");
const visibleBookIds = new Set(
  (process.env.VISIBLE_BOOK_IDS || "book-rezero-arc-6,book-reverend-insanity")
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
if (seeded?.books?.length) {
  const shippedIds = new Set(seeded.books.map((book) => book.id));
  state.books = [
    ...seeded.books,
    ...state.books.filter((book) => !shippedIds.has(book.id)),
  ];
}
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
      state.books = state.books.filter((book) => visibleBookIds.has(book.id));
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
      if (seeded?.books?.length) {
        const shippedIds = new Set(seeded.books.map((book) => book.id));
        remote.books = [
          ...seeded.books,
          ...(remote.books || []).filter((book) => !shippedIds.has(book.id)),
        ];
      }
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
