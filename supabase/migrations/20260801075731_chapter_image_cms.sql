alter table public.chapter_assets
  drop constraint if exists chapter_assets_kind_check;

alter table public.chapter_assets
  add constraint chapter_assets_kind_check
  check (kind in ('CONTENT','SOURCE','PDF','IMAGE')),
  add column if not exists alt_text text,
  add column if not exists after_sentence_id text,
  add column if not exists position integer not null default 1,
  add column if not exists created_by text references public.app_users(id) on delete set null,
  add column if not exists updated_at timestamptz not null default now();

alter table public.chapter_assets
  drop constraint if exists chapter_assets_position_check;

alter table public.chapter_assets
  add constraint chapter_assets_position_check check (position > 0);

alter table public.chapters
  add column if not exists illustrations_managed boolean not null default false;

create index if not exists chapter_assets_image_order_idx
  on public.chapter_assets (chapter_id, position, created_at)
  where kind = 'IMAGE';

create index if not exists chapter_assets_created_by_idx
  on public.chapter_assets (created_by)
  where created_by is not null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chapter-images',
  'chapter-images',
  true,
  12582912,
  array['image/jpeg','image/png','image/webp','image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into public.chapter_assets (
  chapter_id, kind, bucket, object_path, content_type, version,
  alt_text, after_sentence_id, position
)
select seed.chapter_id, 'IMAGE', 'site-public', seed.object_path,
  seed.content_type, 1, seed.alt_text, seed.after_sentence_id, 1
from (values
  ('ch-rezero-6-01', '/illustrations/rezero-arc-6/chapter-01-opening.png', 'image/png', 'لوحة افتتاح الفصل الأول', null),
  ('ch-rezero-6-03', '/illustrations/rezero-arc-6/chapter-03-scene-after-rz6-c03-p0033.jpg', 'image/jpeg', 'لوحة من أحداث الفصل الثالث', 'rz6-c03-p0033'),
  ('ch-rezero-6-04', '/illustrations/rezero-arc-6/chapter-04-petra-scene.png', 'image/png', 'بترا في مشهد من الفصل الرابع', 'rz6-c04-p0024'),
  ('ch-rezero-6-08', '/illustrations/rezero-arc-6/chapter-08-earthworm.webp', 'image/webp', 'دودة الأرض الرملية في الفصل الثامن', 'rz6-c08-p0160'),
  ('ch-rezero-6-10', '/illustrations/rezero-arc-6/chapter-10-ending.jpg', 'image/jpeg', 'لوحة ختام الفصل العاشر', 'rz6-c10-p0113'),
  ('ch-rezero-6-11', '/illustrations/rezero-arc-6/chapter-11-ending.jpg', 'image/jpeg', 'لوحة ختام الفصل الحادي عشر', 'rz6-c11-p0096')
) as seed(chapter_id, object_path, content_type, alt_text, after_sentence_id)
where exists (select 1 from public.chapters c where c.id = seed.chapter_id)
on conflict (chapter_id, kind, version) do nothing;

update public.chapters c
set illustrations_managed = true
where exists (
  select 1 from public.chapter_assets a
  where a.chapter_id = c.id and a.kind = 'IMAGE'
);

revoke all on public.chapter_assets from anon, authenticated;
