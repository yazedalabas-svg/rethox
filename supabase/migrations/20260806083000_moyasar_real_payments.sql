-- Real Moyasar payments.
--
-- The demo checkout created an order and granted entitlements in one step. A
-- real payment happens outside our database, so the flow is split in two:
--
--   1. create_pending_order  -- reserves the order, grants nothing
--   2. complete_paid_order   -- runs only after the API verified the payment
--                               directly with Moyasar, and re-checks that the
--                               amount actually charged matches the order
--
-- Nothing here trusts an amount supplied by a browser.

-- One Moyasar payment must never settle two orders.
create unique index if not exists payments_external_id_key
  on public.payments (external_id)
  where external_id is not null;

create or replace function public.create_pending_order(
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

  -- Reuse an unpaid order for the same cart instead of stacking duplicates.
  select * into v_order
  from public.orders
  where idempotency_key = p_idempotency_key;
  if found then
    return to_jsonb(v_order);
  end if;

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

  -- Moyasar rejects amounts under one unit of currency.
  if v_total < 100 then
    raise exception 'amount_below_minimum';
  end if;

  insert into public.orders(
    id, public_number, user_id, status, total_minor, currency, idempotency_key
  ) values (
    p_order_id, p_public_number, p_user_id, 'PENDING', v_total,
    coalesce(v_currency, 'SAR'), p_idempotency_key
  ) returning * into v_order;

  insert into public.order_items(order_id, book_id, title_snapshot, price_minor)
  select p_order_id, id, title, price_minor
  from public.books
  where id = any(p_book_ids);

  return to_jsonb(v_order);
end;
$$;

create or replace function public.attach_order_payment(
  p_order_id text,
  p_external_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer;
begin
  select total_minor into v_total from public.orders where id = p_order_id;
  if not found then
    raise exception 'order_not_found';
  end if;

  insert into public.payments(order_id, provider, status, amount_minor, external_id)
  values (p_order_id, 'MOYASAR', 'PENDING', v_total, p_external_id)
  on conflict (external_id) do nothing;
end;
$$;

create or replace function public.complete_paid_order(
  p_order_id text,
  p_external_id text,
  p_amount_minor integer,
  p_currency text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('rethox-order-settle:' || p_order_id, 0)
  );

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'order_not_found';
  end if;

  -- Moyasar retries webhooks; a settled order simply reports itself again.
  if v_order.status = 'COMPLETED' then
    return to_jsonb(v_order);
  end if;
  if v_order.status <> 'PENDING' then
    raise exception 'order_not_payable';
  end if;

  -- The charge must match what we priced. A mismatch means the payment was
  -- built somewhere other than create_pending_order, so refuse to settle it.
  if p_amount_minor is distinct from v_order.total_minor then
    raise exception 'amount_mismatch';
  end if;
  if upper(p_currency) is distinct from upper(v_order.currency) then
    raise exception 'currency_mismatch';
  end if;

  update public.orders
  set status = 'COMPLETED', completed_at = now()
  where id = p_order_id
  returning * into v_order;

  insert into public.payments(order_id, provider, status, amount_minor, external_id)
  values (p_order_id, 'MOYASAR', 'COMPLETED', p_amount_minor, p_external_id)
  on conflict (external_id) do update
    set status = 'COMPLETED',
        amount_minor = excluded.amount_minor;

  insert into public.entitlements(user_id, book_id, order_id, source)
  select v_order.user_id, item.book_id, p_order_id, 'PURCHASE'
  from public.order_items item
  where item.order_id = p_order_id
  on conflict (user_id, book_id) do update
    set revoked_at = null,
        order_id = excluded.order_id;

  return to_jsonb(v_order);
end;
$$;

create or replace function public.fail_order(
  p_order_id text,
  p_external_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('rethox-order-settle:' || p_order_id, 0)
  );

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'order_not_found';
  end if;

  -- A late failure event must never strip a buyer of a paid order.
  if v_order.status <> 'PENDING' then
    return to_jsonb(v_order);
  end if;

  update public.orders
  set status = 'CANCELLED'
  where id = p_order_id
  returning * into v_order;

  insert into public.payments(order_id, provider, status, amount_minor, external_id)
  values (p_order_id, 'MOYASAR', 'FAILED', v_order.total_minor, p_external_id)
  on conflict (external_id) do update set status = 'FAILED';

  return to_jsonb(v_order);
end;
$$;

revoke all on function public.create_pending_order(text,text,text,text[],text)
  from public, anon, authenticated;
revoke all on function public.attach_order_payment(text,text)
  from public, anon, authenticated;
revoke all on function public.complete_paid_order(text,text,integer,text)
  from public, anon, authenticated;
revoke all on function public.fail_order(text,text)
  from public, anon, authenticated;

grant execute on function public.create_pending_order(text,text,text,text[],text)
  to service_role;
grant execute on function public.attach_order_payment(text,text)
  to service_role;
grant execute on function public.complete_paid_order(text,text,integer,text)
  to service_role;
grant execute on function public.fail_order(text,text)
  to service_role;
