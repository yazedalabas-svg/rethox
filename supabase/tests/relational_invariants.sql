begin;

do $$
declare
  v_book text;
  v_chapter text;
  v_first jsonb;
  v_second jsonb;
  v_new jsonb;
  v_stale jsonb;
  v_position integer;
  v_chapter_percentage numeric;
  v_chapter_status text;
begin
  if exists (
    select 1
    from public.books b
    where b.status = 'PUBLISHED'
      and (select count(*) from public.chapters c where c.book_id = b.id and c.is_sample) <> 1
  ) then
    raise exception 'every published book must have exactly one sample chapter';
  end if;

  if has_table_privilege('anon', 'public.app_users', 'select')
    or has_table_privilege('anon', 'public.orders', 'select')
    or has_table_privilege('anon', 'public.entitlements', 'select')
    or has_table_privilege('anon', 'public.user_credentials', 'select') then
    raise exception 'private tables are exposed to anon';
  end if;

  if has_function_privilege(
    'anon',
    'public.complete_demo_order(text,text,text,text[],text)',
    'execute'
  ) or has_function_privilege(
    'anon',
    'public.save_reading_progress(text,text,text,text,text,integer,numeric,numeric,timestamptz)',
    'execute'
  ) then
    raise exception 'server-only functions are exposed to anon';
  end if;

  insert into public.app_users(id, role, status)
  values ('relational-verification-user', 'CUSTOMER', 'ACTIVE');

  select b.id, c.id into v_book, v_chapter
  from public.books b
  join public.chapters c on c.book_id = b.id
  where b.status = 'PUBLISHED'
  order by b.created_at, c.position
  limit 1;

  v_first := public.complete_demo_order(
    'relational-verification-order',
    'RTHX-VERIFY',
    'relational-verification-user',
    array[v_book],
    'relational-verification-idempotency'
  );
  v_second := public.complete_demo_order(
    'relational-verification-order-duplicate',
    'RTHX-VERIFY-2',
    'relational-verification-user',
    array[v_book],
    'relational-verification-idempotency'
  );
  if v_first->>'id' is distinct from v_second->>'id' then
    raise exception 'checkout idempotency failed';
  end if;

  v_new := public.save_reading_progress(
    'relational-verification-user', v_book, v_chapter,
    null, null, 111, 5, 10, now()
  );
  v_stale := public.save_reading_progress(
    'relational-verification-user', v_book, v_chapter,
    null, null, 222, 6, 20, now() - interval '1 minute'
  );
  select position_ms into v_position
  from public.reading_progress
  where user_id = 'relational-verification-user' and book_id = v_book;
  if v_position <> 111 or (v_stale->>'accepted')::boolean is distinct from false then
    raise exception 'stale progress protection failed';
  end if;

  perform public.save_reading_progress(
    'relational-verification-user', v_book, v_chapter,
    null, null, 800, 80, 80, now()
  );
  perform public.save_reading_progress(
    'relational-verification-user', v_book, v_chapter,
    null, null, 200, 20, 20, now()
  );
  select percentage into v_chapter_percentage
  from public.chapter_progress
  where user_id = 'relational-verification-user' and chapter_id = v_chapter;
  if v_chapter_percentage <> 80 then
    raise exception 'chapter progress regressed';
  end if;

  perform public.save_reading_progress(
    'relational-verification-user', v_book, v_chapter,
    null, null, 1000, 100, 100, now()
  );
  perform public.save_reading_progress(
    'relational-verification-user', v_book, v_chapter,
    null, null, 100, 10, 10, now()
  );
  select status into v_chapter_status
  from public.chapter_progress
  where user_id = 'relational-verification-user' and chapter_id = v_chapter;
  if v_chapter_status <> 'COMPLETED' then
    raise exception 'completed chapter regressed';
  end if;
end;
$$;

rollback;

select 'relational invariants passed' as result;
