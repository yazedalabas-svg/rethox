alter table public.backup_runs
  add column if not exists period_key text;
create unique index if not exists rethox_v2_backup_period_key_idx
  on public.backup_runs(period_key)
  where period_key is not null;
-- Applied migration version: 20260713024334
