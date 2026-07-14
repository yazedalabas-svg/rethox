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
declare v_progress public.reading_progress;
begin
  if not exists (select 1 from public.app_users where id = p_user_id and status = 'ACTIVE') then
    raise exception 'user_not_found';
  end if;
  if not exists (
    select 1 from public.chapters c where c.id = p_chapter_id and c.book_id = p_book_id
  ) then
    raise exception 'chapter_not_found';
  end if;

  insert into public.reading_progress(
    user_id, book_id, chapter_id, sentence_id, word_id, position_ms,
    percentage, client_updated_at, updated_at
  ) values (
    p_user_id, p_book_id, p_chapter_id, p_sentence_id, p_word_id,
    greatest(0, p_position_ms), least(100, greatest(0, p_book_percentage)),
    p_client_updated_at, now()
  )
  on conflict (user_id, book_id) do update set
    chapter_id = excluded.chapter_id,
    sentence_id = excluded.sentence_id,
    word_id = excluded.word_id,
    position_ms = excluded.position_ms,
    percentage = excluded.percentage,
    client_updated_at = excluded.client_updated_at,
    updated_at = now()
  where excluded.client_updated_at >= coalesce(public.reading_progress.client_updated_at, '-infinity'::timestamptz)
  returning * into v_progress;

  if v_progress.user_id is not null then
    insert into public.chapter_progress(
      user_id, chapter_id, status, percentage, sentence_id, word_id, position_ms, updated_at
    ) values (
      p_user_id, p_chapter_id,
      case when p_chapter_percentage >= 99.5 then 'COMPLETED' else 'IN_PROGRESS' end,
      least(100, greatest(0, p_chapter_percentage)), p_sentence_id, p_word_id,
      greatest(0, p_position_ms), now()
    )
    on conflict (user_id, chapter_id) do update set
      status = excluded.status,
      percentage = excluded.percentage,
      sentence_id = excluded.sentence_id,
      word_id = excluded.word_id,
      position_ms = excluded.position_ms,
      updated_at = excluded.updated_at;
  end if;

  return coalesce(to_jsonb(v_progress), '{}'::jsonb);
end;
$$;

revoke all on function public.save_reading_progress(text,text,text,text,text,integer,numeric,numeric,timestamptz)
from public, anon, authenticated;
grant execute on function public.save_reading_progress(text,text,text,text,text,integer,numeric,numeric,timestamptz)
to service_role;
-- Applied migration version: 20260713024054
