-- PNG artwork is commonly much larger than JPEG/WebP. Match the managed
-- storage limits to the API upload limit supported by the current plan.
update storage.buckets
set file_size_limit = 52428800
where id in ('book-covers', 'chapter-images');
