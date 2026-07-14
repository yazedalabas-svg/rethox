alter table public.chapter_comments
  drop constraint if exists chapter_comments_body_check1;
alter table public.chapter_comments
  add constraint chapter_comments_body_length_check
  check (char_length(body) <= 1200 and (parent_id is null or char_length(body) >= 1));
-- Applied migration version: 20260713023649
