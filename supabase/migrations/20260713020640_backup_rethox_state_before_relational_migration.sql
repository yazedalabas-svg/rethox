create schema if not exists private;

create table if not exists private.rethox_state_backups (
  id bigint generated always as identity primary key,
  source_updated_at timestamptz,
  payload jsonb not null,
  reason text not null,
  created_at timestamptz not null default now()
);

insert into private.rethox_state_backups (source_updated_at, payload, reason)
select updated_at, payload, 'before_relational_migration'
from public.rethox_state
where id = 'primary';

revoke all on table private.rethox_state_backups from public, anon, authenticated;
-- Applied migration version: 20260713020640
