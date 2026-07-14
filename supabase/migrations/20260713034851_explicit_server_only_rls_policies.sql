do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'admin_audit_logs', 'app_users', 'audio_assets', 'backup_runs',
    'book_assets', 'bookmarks', 'cart_items', 'carts', 'chapter_assets',
    'chapter_progress', 'content_reports', 'entitlements', 'order_items',
    'orders', 'payments', 'reading_list', 'reading_progress',
    'reading_sessions', 'rethox_state', 'sentence_summaries',
    'user_credentials', 'user_identities', 'user_sessions', 'user_settings'
  ]
  loop
    if not exists (
      select 1
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = table_name
        and p.polname = 'server_only_deny'
    ) then
      execute format(
        'create policy server_only_deny on public.%I for all to anon, authenticated using (false) with check (false)',
        table_name
      );
    end if;
  end loop;
end;
$$;
-- Applied migration version: 20260713034851
