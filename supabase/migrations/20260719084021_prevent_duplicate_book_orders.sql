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
  v_currency_count integer;
  v_distinct_count integer;
  v_found_count integer;
begin
  if p_idempotency_key is null or char_length(p_idempotency_key) < 8 then
    raise exception 'invalid_idempotency_key';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('rethox-order:' || p_idempotency_key, 0)
  );

  select * into v_order
  from public.orders
  where idempotency_key = p_idempotency_key;
  if found then
    return to_jsonb(v_order);
  end if;

  -- Different carts for the same buyer must not race past the ownership check.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('rethox-buyer-order:' || p_user_id, 0)
  );

  if not exists (
    select 1 from public.app_users where id = p_user_id and status = 'ACTIVE'
  ) then
    raise exception 'buyer_not_found';
  end if;

  select count(distinct item) into v_distinct_count from unnest(p_book_ids) item;
  select count(*), coalesce(sum(price_minor), 0), min(currency), count(distinct currency)
    into v_found_count, v_total, v_currency, v_currency_count
  from public.books
  where id = any(p_book_ids) and status = 'PUBLISHED';
  if v_distinct_count = 0 or v_found_count <> v_distinct_count then
    raise exception 'book_unavailable';
  end if;
  if v_currency_count <> 1 then
    raise exception 'mixed_currencies_not_supported';
  end if;

  if exists (
    select 1
    from public.entitlements
    where user_id = p_user_id
      and book_id = any(p_book_ids)
      and revoked_at is null
  ) then
    raise exception 'book_already_owned';
  end if;

  insert into public.orders(
    id, public_number, user_id, status, total_minor, currency,
    idempotency_key, completed_at
  ) values (
    p_order_id, p_public_number, p_user_id, 'COMPLETED', v_total,
    coalesce(v_currency, 'SAR'), p_idempotency_key, now()
  ) returning * into v_order;

  insert into public.order_items(order_id, book_id, title_snapshot, price_minor)
  select p_order_id, id, title, price_minor
  from public.books
  where id = any(p_book_ids);

  insert into public.payments(order_id, provider, status, amount_minor)
  values (p_order_id, 'DEMO', 'COMPLETED', v_total);

  insert into public.entitlements(user_id, book_id, order_id, source)
  select p_user_id, id, p_order_id, 'PURCHASE'
  from public.books
  where id = any(p_book_ids);

  return to_jsonb(v_order);
end;
$$;

revoke all on function public.complete_demo_order(text,text,text,text[],text)
from public, anon, authenticated;
grant execute on function public.complete_demo_order(text,text,text,text[],text)
to service_role;
