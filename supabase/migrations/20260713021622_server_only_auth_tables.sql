-- These tables live in the exposed schema so the Express service-role client
-- can use PostgREST. Browser roles receive no grants and RLS has no policies.
alter table private.user_credentials set schema public;
alter table private.user_identities set schema public;
alter table private.user_sessions set schema public;

alter table public.user_credentials enable row level security;
alter table public.user_identities enable row level security;
alter table public.user_sessions enable row level security;

revoke all on public.user_credentials, public.user_identities, public.user_sessions
from public, anon, authenticated;

create index rethox_v2_credentials_changed_idx
  on public.user_credentials(password_changed_at desc);
-- Applied migration version: 20260713021622
