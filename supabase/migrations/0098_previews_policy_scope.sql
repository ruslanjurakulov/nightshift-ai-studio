-- 0098_previews_policy_scope.sql — the private "previews" bucket is readable by
-- the channel's own people only. Removes a broad read policy that exists in the
-- live project but in no migration, and puts the scoped rule back.
--
-- WHY
--   0004 gave storage.objects a policy "previews_read": any signed-in user, any
--   object of bucket 'previews'. 0018 narrowed that same-named policy to the
--   tenant (the first folder of the object name must be a channel the caller
--   can view, or the caller is a platform admin). The live project also holds a
--   second SELECT policy, "previews_read 1dyqf8r_0" (to authenticated, USING
--   bucket_id = 'previews', no other test). That name is dashboard-generated;
--   no migration creates it. Policies are permissive and ADD UP, so with it in
--   place every signed-in user can list, read and sign every review render in
--   the bucket, whichever channel or customer it belongs to. The bucket holds
--   0 objects today, so nothing is exposed right now; the first kept preview
--   (<channel_id>/<video_id>.mp4) would be.
--
-- WHAT IT DOES (three steps; each is a separate statement and is safe on its own)
--   1. drops the policy "previews_read 1dyqf8r_0" by its exact name;
--   2. drops, by catalog lookup, any OTHER SELECT or ALL policy on
--      storage.objects whose USING or WITH CHECK names bucket 'previews' and
--      does not call accessible_channel_ids() or is_platform_admin() (a
--      dashboard suffix differs per project and per click, so the exact name
--      in step 1 is not enough on its own). Each drop is reported with a
--      NOTICE. It never touches a policy that does not name 'previews', so
--      voice_previews_read, avatars_*, and any other bucket's policy stay;
--   3. re-creates "previews_read" exactly as 0018 defines it (drop + create),
--      so the bucket ends in one known state whatever came before.
--
-- WHAT IT NEVER DOES
--   * creates a policy for anon or public, or any policy other than the scoped
--     previews_read; changes the bucket row; touches the files; touches
--     voice-previews, avatars or publish-staging.
--   * Nothing in the product changes: the browser signs previews as the
--     signed-in user (ReviewPanel, DownloadMenu) and the worker writes with the
--     service key, which bypasses RLS. Both still work; only the over-broad
--     read is gone.
--
-- ROLLBACK (safe)
--   There is nothing to roll back to: the dropped policies were a leak. If the
--   scoped rule itself ever has to be put back, re-run step 3 alone (the drop
--   if exists + create policy previews_read below). Do NOT recreate a broad
--   previews policy, with any name, from the dashboard or from SQL.
--
-- Idempotent: a second run drops nothing (the DO block finds nothing) and
-- re-creates the same policy. Requires 0004 + 0018 (accessible_channel_ids,
-- is_platform_admin) and Supabase Storage. Applied by the operator after
-- review: the security lab applies it to a scratch database, but nothing
-- applies it to the live project except whoever runs it there.
-- Storage policies are created by migrations like this one, not in the
-- dashboard (docs/SUPABASE.md, "Storage policies").

do $$
begin
  if to_regclass('storage.objects') is null then
    raise exception '0098 needs the storage schema (Supabase Storage): enable Storage on the project first';
  end if;
  if to_regprocedure('public.accessible_channel_ids(text)') is null
     or to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0098 needs migration 0018 (accessible_channel_ids, is_platform_admin) applied first';
  end if;
end $$;

-- 1. The drift policy, by name.
drop policy if exists "previews_read 1dyqf8r_0" on storage.objects;

-- 2. Any other broad read of the previews bucket, whatever the dashboard named
--    it. USING (qual) and WITH CHECK are tested separately, each on its own.
do $$
declare
  p record;
begin
  for p in
    select policyname
      from pg_policies
     where schemaname = 'storage'
       and tablename = 'objects'
       and cmd in ('SELECT', 'ALL')
       and policyname <> 'previews_read'
       and (   (qual       like '%''previews''%' and qual       !~ '(accessible_channel_ids|is_platform_admin)')
            or (with_check like '%''previews''%' and with_check !~ '(accessible_channel_ids|is_platform_admin)'))
  loop
    raise notice '0098: dropping broad previews policy % on storage.objects', quote_ident(p.policyname);
    execute format('drop policy %I on storage.objects', p.policyname);
  end loop;
end $$;

-- 3. The tenant rule, exactly as in 0018 (k): the first folder of
--    <channel_id>/<video_id>.mp4 must be a channel the caller can view.
drop policy if exists previews_read on storage.objects;
create policy previews_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'previews'
    and (
      (storage.foldername(name))[1] in (select public.accessible_channel_ids('viewer'))
      or (select public.is_platform_admin())
    )
  );

-- ─────────────────────────────────────────────────────────────────────────
-- Verify (read-only; run in the SQL editor after applying, on the live project)
-- ─────────────────────────────────────────────────────────────────────────
--   -- A. every policy on storage.objects, USING and WITH CHECK shown separately.
--   --    Expected: previews_read (SELECT, {authenticated}, qual names
--   --    accessible_channel_ids and is_platform_admin, with_check null);
--   --    voice_previews_read (SELECT, qual = bucket_id 'voice-previews' only);
--   --    avatars_select_own / insert_own / update_own / delete_own;
--   --    nothing named "previews_read 1dyqf8r_0" or "Allow ...".
--   select policyname, cmd, roles::text as roles, qual as using_expr, with_check as check_expr
--     from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--    order by policyname;
--
--   -- B. broad readers of the previews bucket. Expected: 0 rows.
--   select policyname, cmd, qual as using_expr, with_check as check_expr
--     from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--      and cmd in ('SELECT', 'ALL')
--      and (   (qual       like '%''previews''%' and qual       !~ '(accessible_channel_ids|is_platform_admin)')
--           or (with_check like '%''previews''%' and with_check !~ '(accessible_channel_ids|is_platform_admin)'));
--
--   -- C. SELECT/ALL policies that name no bucket at all (they would reach
--   --    previews too). Expected: 0 rows. Not dropped by this migration:
--   --    look at each one by hand.
--   select policyname, cmd, qual as using_expr, with_check as check_expr
--     from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--      and cmd in ('SELECT', 'ALL')
--      and coalesce(qual, '') not like '%bucket_id%' and coalesce(with_check, '') not like '%bucket_id%';
--
--   -- D. the bucket stays private. Expected: public = false.
--   select id, public from storage.buckets where id = 'previews';
