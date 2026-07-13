create extension if not exists pgcrypto;
create schema if not exists private;

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 60),
  role text not null default 'CUSTOMER' check (role in ('CUSTOMER', 'ADMIN')),
  locale text not null default 'ar',
  theme text not null default 'light' check (theme in ('light', 'dark')),
  avatar_url text,
  bio text not null default '',
  provider text not null default '',
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', 'قارئ rethox'))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_auth_user();

create table if not exists public.books (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  author text not null,
  synopsis text not null,
  cover_url text,
  genre text not null,
  tags text[] not null default '{}',
  price_minor integer not null default 0 check (price_minor >= 0),
  currency text not null default 'SAR',
  status text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.chapters (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  position integer not null check (position > 0),
  title text not null,
  content jsonb not null default '[]'::jsonb,
  duration_ms integer not null default 0 check (duration_ms >= 0),
  is_sample boolean not null default false,
  unique (book_id, position)
);

create table if not exists public.reading_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  sentence_id text,
  position_ms integer not null default 0 check (position_ms >= 0),
  percentage numeric(5,2) not null default 0 check (percentage between 0 and 100),
  updated_at timestamptz not null default now(),
  primary key (user_id, book_id)
);

create table if not exists public.bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  sentence_id text not null,
  created_at timestamptz not null default now(),
  unique (user_id, chapter_id, sentence_id)
);

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  body text not null check (char_length(body) between 3 and 1200),
  spoiler boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, book_id)
);

create table if not exists public.chapter_comments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  body text not null check (char_length(body) between 2 and 1200),
  spoiler boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, chapter_id)
);

create table if not exists public.summaries (
  id uuid primary key default gen_random_uuid(),
  sentence_id text not null unique,
  content text not null,
  provider text not null,
  model text not null,
  created_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;
alter table public.profiles enable row level security;
alter table public.books enable row level security;
alter table public.chapters enable row level security;
alter table public.reading_progress enable row level security;
alter table public.bookmarks enable row level security;
alter table public.reviews enable row level security;
alter table public.chapter_comments enable row level security;
alter table public.summaries enable row level security;

drop policy if exists "app settings are public" on public.app_settings;
create policy "app settings are public" on public.app_settings for select using (true);
drop policy if exists "published books are public" on public.books;
create policy "published books are public" on public.books for select using (status = 'PUBLISHED');
drop policy if exists "published chapters are public" on public.chapters;
create policy "published chapters are public" on public.chapters for select using (
  exists (select 1 from public.books where books.id = chapters.book_id and books.status = 'PUBLISHED')
);
drop policy if exists "profiles own rows" on public.profiles;
create policy "profiles own rows" on public.profiles for all using (auth.uid() = id) with check (auth.uid() = id);
drop policy if exists "progress own rows" on public.reading_progress;
create policy "progress own rows" on public.reading_progress for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "bookmarks own rows" on public.bookmarks;
create policy "bookmarks own rows" on public.bookmarks for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "reviews are public" on public.reviews;
create policy "reviews are public" on public.reviews for select using (true);
drop policy if exists "authenticated users manage own reviews" on public.reviews;
create policy "authenticated users manage own reviews" on public.reviews for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "chapter comments are public" on public.chapter_comments;
create policy "chapter comments are public" on public.chapter_comments for select using (true);
drop policy if exists "authenticated users manage own chapter comments" on public.chapter_comments;
create policy "authenticated users manage own chapter comments" on public.chapter_comments for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "summaries are public" on public.summaries;
create policy "summaries are public" on public.summaries for select using (true);

insert into public.app_settings (key, value)
values ('schema_version', '{"version": 1}'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();

-- Community/auth hardening: Google-verified identities and persistent public discussions.
alter table public.reviews drop constraint if exists reviews_book_id_fkey;
alter table public.reviews drop constraint if exists reviews_user_id_fkey;
alter table public.reviews alter column book_id type text using book_id::text;
alter table public.reviews add column if not exists deleted_at timestamptz;
alter table public.reviews add constraint reviews_user_id_fkey foreign key (user_id) references public.profiles(id) on delete cascade;

alter table public.chapter_comments drop constraint if exists chapter_comments_chapter_id_fkey;
alter table public.chapter_comments drop constraint if exists chapter_comments_user_id_fkey;
alter table public.chapter_comments alter column chapter_id type text using chapter_id::text;
alter table public.chapter_comments add column if not exists deleted_at timestamptz;
alter table public.chapter_comments add constraint chapter_comments_user_id_fkey foreign key (user_id) references public.profiles(id) on delete cascade;

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url, provider, verified)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', split_part(coalesce(new.email, 'قارئ'), '@', 1)), 60),
    new.raw_user_meta_data ->> 'avatar_url',
    coalesce(new.raw_app_meta_data ->> 'provider', ''),
    new.email_confirmed_at is not null
  )
  on conflict (id) do update set
    avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
    provider = excluded.provider,
    verified = excluded.verified,
    updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert or update of email_confirmed_at, raw_app_meta_data, raw_user_meta_data on auth.users
for each row execute function private.handle_new_auth_user();

drop policy if exists "profiles own rows" on public.profiles;
drop policy if exists "reviews are public" on public.reviews;
drop policy if exists "authenticated users manage own reviews" on public.reviews;
drop policy if exists "chapter comments are public" on public.chapter_comments;
drop policy if exists "authenticated users manage own chapter comments" on public.chapter_comments;

create policy "public reads profiles" on public.profiles for select to anon, authenticated using (true);
create policy "owners update profile" on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy "public reads active reviews" on public.reviews for select to anon, authenticated using (deleted_at is null);
create policy "google users create reviews" on public.reviews for insert to authenticated with check (
  (select auth.uid()) = user_id and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.verified and p.provider = 'google')
);
create policy "owners update reviews" on public.reviews for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "public reads active comments" on public.chapter_comments for select to anon, authenticated using (deleted_at is null);
create policy "google users create comments" on public.chapter_comments for insert to authenticated with check (
  (select auth.uid()) = user_id and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.verified and p.provider = 'google')
);
create policy "owners update comments" on public.chapter_comments for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

grant select on public.profiles, public.reviews, public.chapter_comments to anon, authenticated;
grant insert on public.reviews, public.chapter_comments to authenticated;
revoke delete on public.profiles, public.reviews, public.chapter_comments from anon, authenticated;

alter table public.reading_progress drop constraint if exists reading_progress_book_id_fkey;
alter table public.reading_progress drop constraint if exists reading_progress_chapter_id_fkey;
alter table public.reading_progress alter column book_id type text using book_id::text;
alter table public.reading_progress alter column chapter_id type text using chapter_id::text;
alter table public.bookmarks drop constraint if exists bookmarks_book_id_fkey;
alter table public.bookmarks drop constraint if exists bookmarks_chapter_id_fkey;
alter table public.bookmarks alter column book_id type text using book_id::text;
alter table public.bookmarks alter column chapter_id type text using chapter_id::text;
drop policy if exists "progress own rows" on public.reading_progress;
create policy "progress own rows" on public.reading_progress for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "bookmarks own rows" on public.bookmarks;
create policy "bookmarks own rows" on public.bookmarks for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
grant select, insert, update, delete on public.reading_progress, public.bookmarks to authenticated;

-- Server-owned durable snapshot used by the Express API. No browser role can
-- read this row because it contains private account and session metadata.
create table if not exists public.rethox_state (
  id text primary key check (id = 'primary'),
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.rethox_state enable row level security;
revoke all on table public.rethox_state from public, anon, authenticated;

create or replace view public.rethox_accounts
with (security_invoker = true) as
select
  account ->> 'id' as id,
  account ->> 'name' as name,
  nullif(account ->> 'email', '') as email,
  nullif(account ->> 'phone', '') as phone,
  account ->> 'role' as role,
  account ->> 'oauthProvider' as provider,
  (account ->> 'createdAt')::timestamptz as created_at
from public.rethox_state state
cross join lateral jsonb_array_elements(coalesce(state.payload -> 'users', '[]'::jsonb)) account
where state.id = 'primary';

create or replace view public.rethox_reviews_dashboard
with (security_invoker = true) as
select review.*
from public.rethox_state state
cross join lateral jsonb_to_recordset(coalesce(state.payload -> 'reviews', '[]'::jsonb))
  as review(id text, "userId" text, "bookId" text, rating integer, body text, spoiler boolean, "createdAt" text, "updatedAt" text)
where state.id = 'primary';

create or replace view public.rethox_comments_dashboard
with (security_invoker = true) as
select comment.*
from public.rethox_state state
cross join lateral jsonb_to_recordset(coalesce(state.payload -> 'chapterComments', '[]'::jsonb))
  as comment(id text, "userId" text, "chapterId" text, rating integer, body text, spoiler boolean, "parentId" text, "createdAt" text, "updatedAt" text)
where state.id = 'primary';

revoke all on public.rethox_accounts, public.rethox_reviews_dashboard, public.rethox_comments_dashboard from public, anon, authenticated;
