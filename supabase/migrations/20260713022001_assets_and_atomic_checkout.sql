alter table public.chapter_assets
  add column if not exists locator jsonb not null default '{}'::jsonb;

create table public.book_assets (
  id uuid primary key default gen_random_uuid(),
  book_id text not null references public.books(id) on delete cascade,
  kind text not null check (kind in ('COVER','SOURCE','PDF','EPUB')),
  bucket text not null,
  object_path text not null,
  content_type text,
  byte_size bigint check (byte_size is null or byte_size >= 0),
  checksum_sha256 text,
  created_at timestamptz not null default now(),
  unique (book_id, kind, object_path)
);
alter table public.book_assets enable row level security;
revoke all on public.book_assets from anon, authenticated;
create index rethox_v2_book_assets_book_idx on public.book_assets(book_id, kind);

create or replace function public.complete_demo_order(
  p_order_id text,
  p_public_number text,
  p_user_id text,
  p_book_ids text[],
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_total integer;
  v_currency text;
  v_distinct_count integer;
  v_found_count integer;
begin
  select * into v_order from public.orders where idempotency_key = p_idempotency_key;
  if found then
    return to_jsonb(v_order);
  end if;

  if not exists (select 1 from public.app_users where id = p_user_id and status = 'ACTIVE') then
    raise exception 'buyer_not_found';
  end if;

  select count(distinct item) into v_distinct_count from unnest(p_book_ids) item;
  select count(*), coalesce(sum(price_minor), 0), min(currency)
    into v_found_count, v_total, v_currency
  from public.books
  where id = any(p_book_ids) and status = 'PUBLISHED';
  if v_distinct_count = 0 or v_found_count <> v_distinct_count then
    raise exception 'book_unavailable';
  end if;

  insert into public.orders(id, public_number, user_id, status, total_minor, currency, idempotency_key, completed_at)
  values (p_order_id, p_public_number, p_user_id, 'COMPLETED', v_total, coalesce(v_currency, 'SAR'), p_idempotency_key, now())
  returning * into v_order;

  insert into public.order_items(order_id, book_id, title_snapshot, price_minor)
  select p_order_id, id, title, price_minor from public.books where id = any(p_book_ids);

  insert into public.payments(order_id, provider, status, amount_minor)
  values (p_order_id, 'DEMO', 'COMPLETED', v_total);

  insert into public.entitlements(user_id, book_id, order_id, source)
  select p_user_id, id, p_order_id, 'PURCHASE' from public.books where id = any(p_book_ids)
  on conflict (user_id, book_id) do update set revoked_at = null;

  return to_jsonb(v_order);
end;
$$;

revoke all on function public.complete_demo_order(text,text,text,text[],text) from public, anon, authenticated;
grant execute on function public.complete_demo_order(text,text,text,text[],text) to service_role;
-- Applied migration version: 20260713022001
