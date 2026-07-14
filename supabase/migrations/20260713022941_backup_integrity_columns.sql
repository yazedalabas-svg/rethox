alter table public.backup_runs
  add column if not exists byte_size bigint check (byte_size is null or byte_size >= 0),
  add column if not exists checksum_sha256 text;
-- Applied migration version: 20260713022941
