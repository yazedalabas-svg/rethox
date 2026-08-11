import "./env.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { supabaseAdmin } from "./integrations.js";
import {
  markRelationalReady,
  relationalCounts,
  syncRelationalStore,
} from "./relational-store.js";
import type { Book, Store } from "./types.js";

const client = supabaseAdmin;
if (!client)
  throw new Error("SUPABASE_URL and server secret are required");

const dataRoot = resolve(process.cwd(), "data");
const webPublicRoot = resolve(process.cwd(), "../web/public");
const runtimePath = resolve(dataRoot, "runtime-store.json");
const seedPath = resolve(dataRoot, "deploy-seed.json");
if (!existsSync(runtimePath) || !existsSync(seedPath))
  throw new Error("runtime-store.json and deploy-seed.json are required");

const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as Store;
const seed = JSON.parse(readFileSync(seedPath, "utf8")) as Store;
const visibleBookIds = new Set(
  (process.env.VISIBLE_BOOK_IDS || "book-rezero-arc-6,book-reverend-insanity,book-mushoku-tensei")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);
const shippedIds = new Set(seed.books.map((book) => book.id));
runtime.books = [
  ...seed.books,
  ...(runtime.books || []).filter((book) => !shippedIds.has(book.id)),
].map((book) =>
  visibleBookIds.has(book.id) ? book : { ...book, status: "DRAFT" as const },
);
runtime.reviews ??= [];
runtime.chapterComments ??= [];
runtime.readingList ??= [];
runtime.reports ??= [];
runtime.auditLogs ??= [];

const checksum = (body: Buffer) =>
  createHash("sha256").update(body).digest("hex");

const upload = async (
  bucket: string,
  objectPath: string,
  body: Buffer,
  contentType: string,
) => {
  const { error } = await client.storage
    .from(bucket)
    .upload(objectPath, body, { contentType, upsert: true });
  if (error) throw new Error(`upload ${bucket}/${objectPath}: ${error.message}`);
  return {
    bucket,
    object_path: objectPath,
    byte_size: body.length,
    checksum_sha256: checksum(body),
  };
};

const upsertBatches = async (table: string, rows: Record<string, any>[]) => {
  for (let index = 0; index < rows.length; index += 400) {
    const { error } = await client
      .from(table)
      .upsert(rows.slice(index, index + 400));
    if (error) throw new Error(`upsert ${table}: ${error.message}`);
  }
};

const migrateBookContent = async (book: Book) => {
  const assetRows: Record<string, any>[] = [];
  const externalGroups = new Map<string, typeof book.chapters>();
  const inlineChapters = book.chapters.filter((chapter) => {
    if (!chapter.contentFile) return true;
    externalGroups.set(chapter.contentFile, [
      ...(externalGroups.get(chapter.contentFile) || []),
      chapter,
    ]);
    return false;
  });

  if (inlineChapters.length) {
    const body = gzipSync(
      Buffer.from(JSON.stringify({ bookId: book.id, chapters: inlineChapters })),
      { level: 9 },
    );
    const object = await upload(
      "chapter-content",
      `${book.id}/inline-chapters.v1.json.gz`,
      body,
      "application/gzip",
    );
    inlineChapters.forEach((chapter) =>
      assetRows.push({
        chapter_id: chapter.id,
        kind: "CONTENT",
        ...object,
        content_type: "application/gzip",
        version: 1,
        locator: { chapterId: chapter.id },
      }),
    );
  }

  for (const [contentFile, chapters] of externalGroups) {
    const source = resolve(dataRoot, contentFile);
    if (!source.startsWith(dataRoot) || !existsSync(source))
      throw new Error(`missing chapter volume: ${contentFile}`);
    const body = gzipSync(readFileSync(source), { level: 9 });
    const safeName = basename(contentFile).replace(/[^\p{L}\p{N}._-]+/gu, "-");
    const object = await upload(
      "chapter-content",
      `${book.id}/volumes/${safeName}.gz`,
      body,
      "application/gzip",
    );
    chapters.forEach((chapter) =>
      assetRows.push({
        chapter_id: chapter.id,
        kind: "CONTENT",
        ...object,
        content_type: "application/gzip",
        version: 1,
        locator: { chapterId: chapter.id },
      }),
    );
  }
  await upsertBatches("chapter_assets", assetRows);
};

const migrateBookFiles = async (book: Book) => {
  const assets: Record<string, any>[] = [];
  if (book.coverUrl?.startsWith("/")) {
    const source = resolve(webPublicRoot, book.coverUrl.slice(1));
    if (source.startsWith(webPublicRoot) && existsSync(source)) {
      const extension = extname(source).toLowerCase() || ".webp";
      const mime = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
      const object = await upload("book-covers", `${book.id}/cover${extension}`, readFileSync(source), mime);
      assets.push({ book_id: book.id, kind: "COVER", ...object, content_type: mime });
    }
  }
  if (book.documentFile) {
    const source = resolve(dataRoot, book.documentFile);
    if (source.startsWith(dataRoot) && existsSync(source)) {
      const extension = extname(source).toLowerCase();
      const kind = extension === ".pdf" ? "PDF" : extension === ".epub" ? "EPUB" : "SOURCE";
      const mime = extension === ".pdf" ? "application/pdf" : extension === ".epub" ? "application/epub+zip" : "application/octet-stream";
      const object = await upload("source-documents", `${book.id}/${basename(source)}`, readFileSync(source), mime);
      assets.push({ book_id: book.id, kind, ...object, content_type: mime });
    }
  }
  await upsertBatches("book_assets", assets);
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupBody = gzipSync(readFileSync(runtimePath), { level: 9 });
const backupObject = await upload(
  "database-backups",
  `pre-relational/${stamp}-runtime-store.json.gz`,
  backupBody,
  "application/gzip",
);
const { data: backupRun, error: backupError } = await client
  .from("backup_runs")
  .insert({
    kind: "PRE_MIGRATION",
    ...backupObject,
    status: "PENDING",
  })
  .select("id")
  .single();
if (backupError) throw new Error(`create backup run: ${backupError.message}`);

await syncRelationalStore(client, runtime, { migration: true });
for (const book of runtime.books) {
  await migrateBookContent(book);
  await migrateBookFiles(book);
}

const counts = await relationalCounts(client);
const expected = {
  app_users: runtime.users.length,
  orders: runtime.orders.length,
  entitlements: runtime.entitlements.length,
  reading_progress: runtime.progress.length,
  bookmarks: runtime.bookmarks.length,
  book_reviews: runtime.reviews.length,
  chapter_comments: runtime.chapterComments.length,
  books: runtime.books.length,
  chapters: runtime.books.reduce((sum, book) => sum + book.chapters.length, 0),
};
for (const [key, value] of Object.entries(expected)) {
  if (counts[key] !== value)
    throw new Error(`count mismatch ${key}: expected ${value}, found ${counts[key]}`);
}

await markRelationalReady(client);
const { error: finishError } = await client
  .from("backup_runs")
  .update({ status: "COMPLETED", completed_at: new Date().toISOString(), row_counts: counts })
  .eq("id", backupRun.id);
if (finishError) throw new Error(`finish backup run: ${finishError.message}`);

console.log(JSON.stringify({ migrated: true, counts, backup: backupObject.object_path }, null, 2));
