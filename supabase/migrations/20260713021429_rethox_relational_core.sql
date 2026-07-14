create extension if not exists pgcrypto;
create schema if not exists private;

-- Preserve the previous, mostly-empty normalized attempt for rollback/audit.
alter table if exists public.profiles rename to legacy_profiles;
alter table if exists public.books rename to legacy_books;
alter table if exists public.chapters rename to legacy_chapters;
alter table if exists public.reading_progress rename to legacy_reading_progress;
alter table if exists public.bookmarks rename to legacy_bookmarks;
alter table if exists public.reviews rename to legacy_reviews;
alter table if exists public.chapter_comments rename to legacy_chapter_comments;
alter table if exists public.summaries rename to legacy_summaries;

create table public.app_users (
  id text primary key,
  email text,
  phone text,
  role text not null default 'CUSTOMER' check (role in ('CUSTOMER','ADMIN')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','SUSPENDED','DELETED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (email),
  unique (phone)
);

create table private.user_credentials (
  user_id text primary key references public.app_users(id) on delete cascade,
  password_hash text not null,
  password_changed_at timestamptz not null default now()
);

create table private.user_identities (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.app_users(id) on delete cascade,
  provider text not null check (provider in ('email','google','supabase_phone')),
  provider_subject text not null,
  provider_email text,
  created_at timestamptz not null default now(),
  unique (provider, provider_subject)
);

create table private.user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.app_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.profiles (
  user_id text primary key references public.app_users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 60),
  avatar_url text,
  bio text not null default '' check (char_length(bio) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_settings (
  user_id text primary key references public.app_users(id) on delete cascade,
  locale text not null default 'ar',
  theme text not null default 'light' check (theme in ('light','dark')),
  identity_mode text not null default 'studio' check (identity_mode in ('studio','classic')),
  font_size numeric(5,2) not null default 1 check (font_size between 0.6 and 2.5),
  line_height numeric(5,2) not null default 2 check (line_height between 1.2 and 3.5),
  playback_rate numeric(4,2) not null default 1 check (playback_rate between 0.5 and 4),
  volume numeric(4,3) not null default 1 check (volume between 0 and 1),
  autoplay boolean not null default false,
  private_history boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.books (
  id text primary key,
  slug text not null unique,
  title text not null,
  normalized_title text not null default '',
  author text not null,
  synopsis text not null,
  price_minor integer not null default 0 check (price_minor >= 0),
  currency text not null default 'SAR' check (char_length(currency) = 3),
  genre text not null,
  cover_theme text not null default 'purple',
  cover_url text,
  page_count integer check (page_count is null or page_count >= 0),
  status text not null default 'DRAFT' check (status in ('DRAFT','PUBLISHED','ARCHIVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique
);

create table public.book_tags (
  book_id text not null references public.books(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  primary key (book_id, tag_id)
);

create table public.chapters (
  id text primary key,
  book_id text not null references public.books(id) on delete cascade,
  position integer not null check (position > 0),
  title text not null,
  duration_ms integer not null default 0 check (duration_ms >= 0),
  is_sample boolean not null default false,
  sentence_count integer not null default 0 check (sentence_count >= 0),
  status text not null default 'PUBLISHED' check (status in ('DRAFT','PUBLISHED','ARCHIVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (book_id, position)
);

create table public.chapter_assets (
  id uuid primary key default gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on delete cascade,
  kind text not null check (kind in ('CONTENT','SOURCE','PDF')),
  bucket text not null,
  object_path text not null,
  content_type text,
  byte_size bigint check (byte_size is null or byte_size >= 0),
  checksum_sha256 text,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  unique (chapter_id, kind, version)
);

create table public.audio_assets (
  id uuid primary key default gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on delete cascade,
  voice text not null default 'hamed',
  segment_position integer not null default 1 check (segment_position > 0),
  bucket text not null default 'chapter-audio',
  object_path text not null,
  codec text not null default 'mp3',
  duration_ms integer not null default 0 check (duration_ms >= 0),
  checksum_sha256 text,
  status text not null default 'READY' check (status in ('PENDING','READY','FAILED')),
  created_at timestamptz not null default now(),
  unique (chapter_id, voice, segment_position)
);

create table public.carts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique references public.app_users(id) on delete cascade,
  updated_at timestamptz not null default now()
);

create table public.cart_items (
  cart_id uuid not null references public.carts(id) on delete cascade,
  book_id text not null references public.books(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (cart_id, book_id)
);

create table public.orders (
  id text primary key,
  public_number text not null unique,
  user_id text not null references public.app_users(id),
  status text not null default 'PENDING' check (status in ('PENDING','COMPLETED','CANCELLED','REFUNDED')),
  total_minor integer not null check (total_minor >= 0),
  currency text not null check (char_length(currency) = 3),
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id text not null references public.orders(id) on delete cascade,
  book_id text not null references public.books(id),
  title_snapshot text not null,
  price_minor integer not null check (price_minor >= 0),
  unique (order_id, book_id)
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id text not null references public.orders(id) on delete cascade,
  provider text not null default 'DEMO',
  status text not null default 'COMPLETED',
  amount_minor integer not null check (amount_minor >= 0),
  external_id text,
  created_at timestamptz not null default now()
);

create table public.entitlements (
  user_id text not null references public.app_users(id) on delete cascade,
  book_id text not null references public.books(id) on delete cascade,
  order_id text references public.orders(id) on delete set null,
  source text not null default 'PURCHASE' check (source in ('PURCHASE','ADMIN','PROMO','MIGRATION')),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (user_id, book_id)
);

create table public.reading_progress (
  user_id text not null references public.app_users(id) on delete cascade,
  book_id text not null references public.books(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on delete cascade,
  sentence_id text,
  word_id text,
  position_ms integer not null default 0 check (position_ms >= 0),
  percentage numeric(5,2) not null default 0 check (percentage between 0 and 100),
  client_updated_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, book_id)
);

create table public.chapter_progress (
  user_id text not null references public.app_users(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on delete cascade,
  status text not null default 'NOT_STARTED' check (status in ('NOT_STARTED','IN_PROGRESS','COMPLETED')),
  percentage numeric(5,2) not null default 0 check (percentage between 0 and 100),
  sentence_id text,
  word_id text,
  position_ms integer not null default 0 check (position_ms >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, chapter_id)
);

create table public.bookmarks (
  id text primary key,
  user_id text not null references public.app_users(id) on delete cascade,
  book_id text not null references public.books(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on delete cascade,
  sentence_id text not null,
  note text,
  created_at timestamptz not null default now(),
  unique (user_id, chapter_id, sentence_id)
);

create table public.reading_list (
  user_id text not null references public.app_users(id) on delete cascade,
  book_id text not null references public.books(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, book_id)
);

create table public.reading_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.app_users(id) on delete cascade,
  book_id text not null references public.books(id) on delete cascade,
  chapter_id text references public.chapters(id) on delete set null,
  started_at timestamptz not null,
  ended_at timestamptz,
  active_seconds integer not null default 0 check (active_seconds >= 0),
  device_id text
);

create table public.book_reviews (
  id text primary key,
  user_id text not null references public.app_users(id) on delete cascade,
  book_id text not null references public.books(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  body text not null default '' check (char_length(body) <= 1200),
  spoiler boolean not null default false,
  moderation_status text not null default 'VISIBLE' check (moderation_status in ('VISIBLE','HIDDEN','PENDING')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, book_id)
);

create table public.chapter_comments (
  id text primary key,
  user_id text not null references public.app_users(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on delete cascade,
  parent_id text references public.chapter_comments(id) on delete cascade,
  rating smallint check (rating between 1 and 5),
  body text not null check (char_length(body) between 1 and 1200),
  spoiler boolean not null default false,
  moderation_status text not null default 'VISIBLE' check (moderation_status in ('VISIBLE','HIDDEN','PENDING')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check ((parent_id is null and rating is not null) or (parent_id is not null and rating is null))
);
create unique index rethox_v2_chapter_comments_one_rating_per_user
  on public.chapter_comments(user_id, chapter_id)
  where parent_id is null;

create table public.content_reports (
  id text primary key,
  user_id text not null references public.app_users(id) on delete cascade,
  book_id text not null references public.books(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on delete cascade,
  sentence_id text,
  message text not null check (char_length(message) between 3 and 1500),
  status text not null default 'OPEN' check (status in ('OPEN','RESOLVED','DISMISSED')),
  handled_by text references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.sentence_summaries (
  id uuid primary key default gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on delete cascade,
  sentence_id text not null,
  content text not null,
  provider text not null,
  model text not null,
  status text not null default 'READY' check (status in ('PENDING','READY','FAILED')),
  cost_minor integer not null default 0 check (cost_minor >= 0),
  created_at timestamptz not null default now(),
  unique (chapter_id, sentence_id)
);

alter table public.app_settings add column if not exists is_public boolean not null default false;

create table public.feature_flags (
  key text primary key,
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  is_public boolean not null default false,
  updated_at timestamptz not null default now()
);

create table public.admin_audit_logs (
  id text primary key,
  user_id text not null references public.app_users(id),
  action text not null,
  entity_type text,
  entity_id text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create table public.backup_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('PRE_MIGRATION','DAILY','MONTHLY','MANUAL')),
  bucket text not null default 'database-backups',
  object_path text,
  status text not null default 'PENDING' check (status in ('PENDING','COMPLETED','FAILED')),
  row_counts jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index rethox_v2_app_users_created_at_idx on public.app_users(created_at desc);
create index rethox_v2_identities_user_idx on private.user_identities(user_id);
create index rethox_v2_sessions_user_expiry_idx on private.user_sessions(user_id, expires_at desc);
create index rethox_v2_books_status_title_idx on public.books(status, normalized_title);
create index rethox_v2_chapters_book_position_idx on public.chapters(book_id, position);
create index rethox_v2_chapter_assets_chapter_idx on public.chapter_assets(chapter_id, kind);
create index rethox_v2_audio_assets_chapter_idx on public.audio_assets(chapter_id, voice, segment_position);
create index rethox_v2_orders_user_created_idx on public.orders(user_id, created_at desc);
create index rethox_v2_entitlements_user_active_idx on public.entitlements(user_id, book_id) where revoked_at is null;
create index rethox_v2_reading_progress_updated_idx on public.reading_progress(user_id, updated_at desc);
create index rethox_v2_chapter_progress_user_idx on public.chapter_progress(user_id, updated_at desc);
create index rethox_v2_reading_sessions_user_started_idx on public.reading_sessions(user_id, started_at desc);
create index rethox_v2_book_reviews_book_created_idx on public.book_reviews(book_id, created_at desc) where deleted_at is null;
create index rethox_v2_chapter_comments_chapter_created_idx on public.chapter_comments(chapter_id, created_at desc) where deleted_at is null;
create index rethox_v2_chapter_comments_parent_idx on public.chapter_comments(parent_id, created_at) where parent_id is not null and deleted_at is null;
create index rethox_v2_reports_status_created_idx on public.content_reports(status, created_at desc);
create index rethox_v2_audit_created_idx on public.admin_audit_logs(created_at desc);

create or replace function private.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['app_users','profiles','user_settings','books','chapters','book_reviews','chapter_comments','content_reports','app_settings','feature_flags'] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function private.set_updated_at()', t);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['legacy_profiles','legacy_books','legacy_chapters','legacy_reading_progress','legacy_bookmarks','legacy_reviews','legacy_chapter_comments','legacy_summaries'] loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke all on public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;

drop policy if exists "app settings are public" on public.app_settings;

create or replace function private.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.app_users (id, email, phone, role)
  values (new.id::text, lower(new.email), new.phone, 'CUSTOMER')
  on conflict (id) do update set email = excluded.email, phone = excluded.phone;
  insert into public.profiles (user_id, display_name, avatar_url)
  values (
    new.id::text,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', split_part(coalesce(new.email, 'قارئ'), '@', 1)), 60),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (user_id) do update set avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url);
  insert into public.user_settings (user_id) values (new.id::text) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert or update of email, phone, raw_user_meta_data on auth.users
for each row execute function private.handle_new_auth_user();

create or replace view public.book_rating_stats with (security_invoker = true) as
select book_id, count(*)::integer as rating_count, round(avg(rating)::numeric, 2) as rating_average
from public.book_reviews
where deleted_at is null and moderation_status = 'VISIBLE'
group by book_id;

create or replace view public.chapter_rating_stats with (security_invoker = true) as
select chapter_id, count(*)::integer as rating_count, round(avg(rating)::numeric, 2) as rating_average
from public.chapter_comments
where parent_id is null and deleted_at is null and moderation_status = 'VISIBLE'
group by chapter_id;

do $$
declare t text;
begin
  foreach t in array array[
    'app_users','profiles','user_settings','books','tags','book_tags','chapters','chapter_assets','audio_assets',
    'carts','cart_items','orders','order_items','payments','entitlements','reading_progress','chapter_progress',
    'bookmarks','reading_list','reading_sessions','book_reviews','chapter_comments','content_reports',
    'sentence_summaries','app_settings','feature_flags','admin_audit_logs','backup_runs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

create policy books_public_read on public.books for select to anon, authenticated using (status = 'PUBLISHED');
create policy chapters_public_metadata on public.chapters for select to anon, authenticated using (
  status = 'PUBLISHED' and exists (select 1 from public.books b where b.id = chapters.book_id and b.status = 'PUBLISHED')
);
create policy tags_public_read on public.tags for select to anon, authenticated using (true);
create policy book_tags_public_read on public.book_tags for select to anon, authenticated using (true);
create policy profiles_public_read on public.profiles for select to anon, authenticated using (true);
create policy reviews_public_read on public.book_reviews for select to anon, authenticated using (deleted_at is null and moderation_status = 'VISIBLE');
create policy comments_public_read on public.chapter_comments for select to anon, authenticated using (deleted_at is null and moderation_status = 'VISIBLE');
create policy public_settings_read on public.app_settings for select to anon, authenticated using (is_public);
create policy public_flags_read on public.feature_flags for select to anon, authenticated using (is_public);

grant select on public.books, public.chapters, public.tags, public.book_tags, public.profiles,
  public.book_reviews, public.chapter_comments, public.book_rating_stats, public.chapter_rating_stats to anon, authenticated;
grant select on public.app_settings, public.feature_flags to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('book-covers','book-covers',true,10485760,array['image/jpeg','image/png','image/webp']),
  ('avatars','avatars',true,5242880,array['image/jpeg','image/png','image/webp']),
  ('chapter-content','chapter-content',false,52428800,array['application/json','application/gzip']),
  ('chapter-audio','chapter-audio',false,524288000,array['audio/mpeg','audio/mp4','audio/ogg','application/vnd.apple.mpegurl']),
  ('source-documents','source-documents',false,1073741824,array['application/pdf','application/epub+zip','application/rtf','text/plain']),
  ('database-backups','database-backups',false,1073741824,array['application/json','application/gzip','application/octet-stream'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into public.app_settings (key, value, is_public) values
  ('schema_version','{"version":2,"source":"relational"}'::jsonb,true),
  ('relational_store','{"ready":false,"dual_write":true}'::jsonb,false)
on conflict (key) do update set value = excluded.value, is_public = excluded.is_public, updated_at = now();

insert into public.feature_flags (key, enabled, config, is_public) values
  ('phone_auth',false,'{}'::jsonb,true),
  ('real_payments',false,'{}'::jsonb,true),
  ('relational_read_source',false,'{}'::jsonb,false)
on conflict (key) do nothing;

revoke all on all tables in schema private from public, anon, authenticated;
-- Applied migration version: 20260713021429
