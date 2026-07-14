create index if not exists rethox_v2_sessions_active_user_expiry_idx
  on public.user_sessions(user_id, expires_at desc)
  where revoked_at is null;

-- Older demo orders predate the payments repository. Preserve their audit trail
-- without changing order or entitlement ownership.
insert into public.payments(order_id, provider, status, amount_minor, external_id)
select o.id, 'DEMO', 'COMPLETED', o.total_minor, 'legacy:' || o.id
from public.orders o
where o.status = 'COMPLETED'
  and not exists (select 1 from public.payments p where p.order_id = o.id);

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

  -- Serialize retries with the same key. Without this lock, two simultaneous
  -- requests can race between SELECT and INSERT and return a unique violation.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('rethox-order:' || p_idempotency_key, 0)
  );

  select * into v_order
  from public.orders
  where idempotency_key = p_idempotency_key;
  if found then
    return to_jsonb(v_order);
  end if;

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
  where id = any(p_book_ids)
  on conflict (user_id, book_id) do update set revoked_at = null;

  return to_jsonb(v_order);
end;
$$;

revoke all on function public.complete_demo_order(text,text,text,text[],text)
from public, anon, authenticated;
grant execute on function public.complete_demo_order(text,text,text,text[],text)
to service_role;

create or replace function public.save_reading_progress(
  p_user_id text,
  p_book_id text,
  p_chapter_id text,
  p_sentence_id text,
  p_word_id text,
  p_position_ms integer,
  p_book_percentage numeric,
  p_chapter_percentage numeric,
  p_client_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_progress public.reading_progress;
  v_existing_client_updated_at timestamptz;
  v_client_updated_at timestamptz := least(coalesce(p_client_updated_at, now()), now());
  v_overall_percentage numeric(5,2);
  v_is_sample boolean;
begin
  if not exists (
    select 1 from public.app_users where id = p_user_id and status = 'ACTIVE'
  ) then
    raise exception 'user_not_found';
  end if;

  select c.is_sample into v_is_sample
  from public.chapters c
  where c.id = p_chapter_id and c.book_id = p_book_id and c.status = 'PUBLISHED';
  if not found then
    raise exception 'chapter_not_found';
  end if;
  if not v_is_sample and not exists (
    select 1 from public.entitlements e
    where e.user_id = p_user_id and e.book_id = p_book_id and e.revoked_at is null
  ) then
    raise exception 'book_not_owned';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('rethox-progress:' || p_user_id || ':' || p_book_id, 0)
  );

  select client_updated_at into v_existing_client_updated_at
  from public.reading_progress
  where user_id = p_user_id and book_id = p_book_id;
  if found and v_client_updated_at < coalesce(
    v_existing_client_updated_at,
    '-infinity'::timestamptz
  ) then
    return jsonb_build_object('accepted', false);
  end if;

  -- chapter_progress stores the furthest point reached and never regresses.
  -- reading_progress below separately stores the latest exact resume location.
  insert into public.chapter_progress(
    user_id, chapter_id, status, percentage, sentence_id, word_id,
    position_ms, updated_at
  ) values (
    p_user_id, p_chapter_id,
    case when p_chapter_percentage >= 99.5 then 'COMPLETED' else 'IN_PROGRESS' end,
    least(100, greatest(0, p_chapter_percentage)), p_sentence_id, p_word_id,
    greatest(0, p_position_ms), now()
  )
  on conflict (user_id, chapter_id) do update set
    status = case
      when public.chapter_progress.status = 'COMPLETED'
        or greatest(public.chapter_progress.percentage, excluded.percentage) >= 99.5
      then 'COMPLETED'
      else 'IN_PROGRESS'
    end,
    percentage = greatest(public.chapter_progress.percentage, excluded.percentage),
    sentence_id = case
      when excluded.percentage >= public.chapter_progress.percentage
      then excluded.sentence_id else public.chapter_progress.sentence_id
    end,
    word_id = case
      when excluded.percentage >= public.chapter_progress.percentage
      then excluded.word_id else public.chapter_progress.word_id
    end,
    position_ms = case
      when excluded.percentage >= public.chapter_progress.percentage
      then excluded.position_ms else public.chapter_progress.position_ms
    end,
    updated_at = now();

  -- Weight chapters by sentence count so a tiny chapter does not count the
  -- same as a very long one. Furthest chapter percentages make this monotonic.
  select least(100, greatest(0,
    coalesce(
      sum(greatest(c.sentence_count, 1) * coalesce(cp.percentage, 0))
        / nullif(sum(greatest(c.sentence_count, 1)), 0),
      0
    )
  )) into v_overall_percentage
  from public.chapters c
  left join public.chapter_progress cp
    on cp.chapter_id = c.id and cp.user_id = p_user_id
  where c.book_id = p_book_id and c.status = 'PUBLISHED';

  insert into public.reading_progress(
    user_id, book_id, chapter_id, sentence_id, word_id, position_ms,
    percentage, client_updated_at, updated_at
  ) values (
    p_user_id, p_book_id, p_chapter_id, p_sentence_id, p_word_id,
    greatest(0, p_position_ms), v_overall_percentage, v_client_updated_at, now()
  )
  on conflict (user_id, book_id) do update set
    chapter_id = excluded.chapter_id,
    sentence_id = excluded.sentence_id,
    word_id = excluded.word_id,
    position_ms = excluded.position_ms,
    percentage = excluded.percentage,
    client_updated_at = excluded.client_updated_at,
    updated_at = now()
  returning * into v_progress;

  return jsonb_build_object('accepted', true, 'progress', to_jsonb(v_progress));
end;
$$;

revoke all on function public.save_reading_progress(text,text,text,text,text,integer,numeric,numeric,timestamptz)
from public, anon, authenticated;
grant execute on function public.save_reading_progress(text,text,text,text,text,integer,numeric,numeric,timestamptz)
to service_role;
