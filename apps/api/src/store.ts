import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Store } from "./types.js";
import { emptyStore } from "./seed.js";

const dataDir = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : resolve(process.cwd(), "data");
const file = resolve(dataDir, "runtime-store.json");
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
const writeLocal = () => {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
  renameSync(temporary, file);
};
const queueRemoteWrite = () => {
  if (!remoteStore) return;
  const snapshot = JSON.parse(JSON.stringify(state)) as Store;
  // Shipped catalog/content already lives in the immutable deploy seed. Keeping
  // it out of every user-data snapshot makes each comment/progress write small
  // and prevents large novels from overwhelming PostgREST.
  if (seeded?.books?.length) {
    const shippedIds = new Set(seeded.books.map((book) => book.id));
    snapshot.books = snapshot.books.filter((book) => !shippedIds.has(book.id));
  }
  remoteWrite = remoteWrite
    .then(async () => {
      const { error } = await remoteStore!.from("rethox_state").upsert({
        id: "primary",
        payload: snapshot,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
    })
    .catch((error) => console.error("Supabase state persistence failed", error));
};
export const save = () => {
  writeLocal();
  queueRemoteWrite();
};
export const connectRemoteStore = async (client: SupabaseClient | null) => {
  if (!client) return false;
  remoteStore = client;
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
    if (seeded?.books?.length) {
      const shippedIds = new Set(seeded.books.map((book) => book.id));
      remote.books = [
        ...seeded.books,
        ...(remote.books || []).filter((book) => !shippedIds.has(book.id)),
      ];
    }
    remote.books = remote.books.filter((book) => visibleBookIds.has(book.id));
    state = remote;
    writeLocal();
  } else {
    queueRemoteWrite();
    await remoteWrite;
  }
  return true;
};
export const reset = () => { state=emptyStore(); save(); };
