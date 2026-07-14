import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";

const backupTables = [
  "app_users",
  "profiles",
  "user_settings",
  "user_credentials",
  "user_identities",
  "user_sessions",
  "books",
  "tags",
  "book_tags",
  "chapters",
  "book_assets",
  "chapter_assets",
  "audio_assets",
  "carts",
  "cart_items",
  "orders",
  "order_items",
  "payments",
  "entitlements",
  "reading_progress",
  "chapter_progress",
  "bookmarks",
  "reading_list",
  "reading_sessions",
  "book_reviews",
  "chapter_comments",
  "content_reports",
  "sentence_summaries",
  "app_settings",
  "feature_flags",
  "admin_audit_logs",
] as const;

const readTable = async (client: SupabaseClient, table: string) => {
  const rows: unknown[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client
      .from(table)
      .select("*")
      .range(from, from + 999);
    if (error) throw new Error(`backup ${table}: ${error.message}`);
    const page = data || [];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
};

const periodFor = (kind: "DAILY" | "MONTHLY" | "MANUAL", now: Date) => {
  const day = now.toISOString().slice(0, 10);
  if (kind === "DAILY") return `DAILY:${day}`;
  if (kind === "MONTHLY") return `MONTHLY:${day.slice(0, 7)}`;
  return `MANUAL:${now.toISOString()}:${randomUUID()}`;
};

export const createRelationalBackup = async (
  client: SupabaseClient,
  kind: "DAILY" | "MONTHLY" | "MANUAL",
) => {
  const now = new Date();
  const periodKey = periodFor(kind, now);
  const { data: existing, error: existingError } = await client
    .from("backup_runs")
    .select("*")
    .eq("period_key", periodKey)
    .maybeSingle();
  if (existingError) throw new Error(`backup lookup: ${existingError.message}`);
  if (existing?.status === "COMPLETED") return existing;

  const { data: run, error: runError } = await client
    .from("backup_runs")
    .upsert(
      {
        kind,
        period_key: periodKey,
        bucket: "database-backups",
        status: "PENDING",
        error_message: null,
      },
      { onConflict: "period_key" },
    )
    .select("id")
    .single();
  if (runError) throw new Error(`backup run: ${runError.message}`);

  try {
    const data: Record<string, unknown[]> = {};
    const rowCounts: Record<string, number> = {};
    for (const table of backupTables) {
      data[table] = await readTable(client, table);
      rowCounts[table] = data[table].length;
    }
    const body = gzipSync(
      Buffer.from(
        JSON.stringify({
          format: "rethox-relational-backup-v1",
          createdAt: now.toISOString(),
          tables: data,
        }),
      ),
      { level: 9 },
    );
    const objectPath = `${kind.toLowerCase()}/${periodKey.replace(/[:]/g, "-")}.json.gz`;
    const { error: uploadError } = await client.storage
      .from("database-backups")
      .upload(objectPath, body, {
        contentType: "application/gzip",
        upsert: true,
      });
    if (uploadError) throw uploadError;
    const checksum = createHash("sha256").update(body).digest("hex");
    const { data: completed, error: completeError } = await client
      .from("backup_runs")
      .update({
        object_path: objectPath,
        byte_size: body.length,
        checksum_sha256: checksum,
        row_counts: rowCounts,
        status: "COMPLETED",
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id)
      .select("*")
      .single();
    if (completeError) throw completeError;
    return completed;
  } catch (error) {
    await client
      .from("backup_runs")
      .update({
        status: "FAILED",
        error_message: String(error).slice(0, 1000),
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    throw error;
  }
};

export const startBackupScheduler = (client: SupabaseClient) => {
  const run = async () => {
    await createRelationalBackup(client, "DAILY");
    if (new Date().getUTCDate() === 1)
      await createRelationalBackup(client, "MONTHLY");
  };
  void run().catch((error) => console.error("scheduled backup failed", error));
  const timer = setInterval(
    () => void run().catch((error) => console.error("scheduled backup failed", error)),
    6 * 60 * 60 * 1000,
  );
  timer.unref();
};
