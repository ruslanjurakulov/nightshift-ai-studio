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
-- WHAT IT DOES (a guard that checks the prerequisites, then four statements)
--   1. drops the policy "previews_read 1dyqf8r_0" by its exact name;
--   2. a BEST-EFFORT clean-up of look-alikes, by catalog lookup: it drops any
--      other PERMISSIVE SELECT or ALL policy on storage.objects whose USING or
--      WITH CHECK names bucket 'previews' (the literal 'previews', or a text
--      array literal such as '{previews,x}') and does not call
--      accessible_channel_ids() or is_platform_admin(). Each drop is reported
--      with a NOTICE. It never touches a policy that does not match, so
--      voice_previews_read, avatars_*, other buckets' policies, and RESTRICTIVE
--      policies (a hardening guard that names previews) stay;
--   3+4. re-create "previews_read" exactly as 0018 defines it (drop + create),
--      so the bucket ends in one known state whatever came before.
--
-- THE CLEAN-UP IN STEP 2 IS A HEURISTIC, NOT A CATCH-ALL
--   It removes the known drift and the common dashboard-style forms. It cannot
--   prove that an arbitrary expression is broad, and it is deliberately not an
--   allowlist drop (that could remove a legitimate future policy). Known
--   survivors, each pinned by a test in tests/security/test_sec_previews_policy.py
--   and each CAUGHT by the strict allowlist query in the Verify block below:
--     * a policy that reaches the bucket without the literal: bucket_id <>
--       'avatars'; bucket_id like 'prev%'; bucket_id ~ '^prev';
--       bucket_id = 'prev' || 'iews'; bucket_id in (select id from
--       storage.buckets where ...); a policy with no bucket test at all;
--     * a broad policy that also contains a scoping function word, so the
--       scoped-looking test passes it: bucket_id = 'previews' OR (foldername
--       in accessible_channel_ids(...)); ... AND (is_platform_admin() OR true).
--   So: after applying, run the allowlist query (Verify, 1). It is the check
--   that counts; the NOTICEs only say what step 2 happened to remove.
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
-- RUN IT WHOLE
--   Statements 3 and 4 (drop previews_read, create previews_read) belong
--   together: run the file in one go (one execute / one SQL-editor run). Running
--   only the drop leaves previews unreadable for everyone until the create runs
--   (fail-closed: no leak, the review panel just cannot sign). Statements 1 and
--   2 may run alone.
--
-- ROLLBACK (safe)
--   There is nothing to roll back to: the dropped policies were a leak. If the
--   scoped rule itself ever has to be put back, re-run statements 3 and 4 (the
--   drop if exists + create policy previews_read below) together. Do NOT
--   recreate a broad previews policy, with any name, from the dashboard or from
--   SQL.
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

-- 2. Best effort: other permissive reads that name the previews bucket without
--    tenant scoping, whatever the dashboard called them. USING (qual) and WITH
--    CHECK are tested separately, each on its own. Heuristic: see the header.
do $$
declare
  p record;
  named  constant text := '(''previews''|\{([^}'']*,)?previews(,[^}'']*)?\}'')';
  scoped constant text := '(accessible_channel_ids|is_platform_admin)';
begin
  for p in
    select policyname
      from pg_policies
     where schemaname = 'storage'
       and tablename = 'objects'
       and permissive = 'PERMISSIVE'
       and cmd in ('SELECT', 'ALL')
       and policyname <> 'previews_read'
       and (   (qual       ~ named and qual       !~ scoped)
            or (with_check ~ named and with_check !~ scoped))
  loop
    raise notice '0098: dropping policy % on storage.objects (names bucket previews, no tenant scoping)', quote_ident(p.policyname);
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
--   -- 1. THE CHECK THAT COUNTS: strict allowlist. Expected: 0 rows. Any row is
--   --    a policy this repo did not create (or a name to add here deliberately):
--   --    read its expressions with query 2, decide, and drop it by migration.
--   select policyname, cmd, roles::text as roles, permissive, qual as using_expr, with_check as check_expr
--     from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--      and policyname not in ('avatars_delete_own', 'avatars_insert_own', 'avatars_select_own',
--                             'avatars_update_own', 'previews_read', 'voice_previews_read');
--
--   -- 2. every policy on storage.objects, USING and WITH CHECK shown separately.
--   --    Expected: previews_read (SELECT, {authenticated}, PERMISSIVE, qual names
--   --    accessible_channel_ids and is_platform_admin, with_check null);
--   --    voice_previews_read (SELECT, qual = bucket_id 'voice-previews' only);
--   --    avatars_select_own / insert_own / update_own / delete_own.
--   select policyname, cmd, roles::text as roles, permissive, qual as using_expr, with_check as check_expr
--     from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--    order by policyname;
--
--   -- 3. what step 2 looks for (the heuristic). Expected: 0 rows. Passing this
--   --    does NOT prove there is no leak; query 1 does.
--   select policyname, cmd, qual as using_expr, with_check as check_expr
--     from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--      and permissive = 'PERMISSIVE' and cmd in ('SELECT', 'ALL')
--      and (   (qual       ~ '(''previews''|\{([^}'']*,)?previews(,[^}'']*)?\}'')' and qual       !~ '(accessible_channel_ids|is_platform_admin)')
--           or (with_check ~ '(''previews''|\{([^}'']*,)?previews(,[^}'']*)?\}'')' and with_check !~ '(accessible_channel_ids|is_platform_admin)'));
--
--   -- 4. SELECT/ALL policies that name no bucket at all (they would reach
--   --    previews too). Expected: 0 rows. Not dropped by this migration.
--   select policyname, cmd, qual as using_expr, with_check as check_expr
--     from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--      and cmd in ('SELECT', 'ALL')
--      and coalesce(qual, '') not like '%bucket_id%' and coalesce(with_check, '') not like '%bucket_id%';
--
--   -- 5. policies on the OTHER tables of the storage schema (buckets, ...).
--   --    Expected: 0 rows, or ones you know. The repo creates none and the lab
--   --    does not model the real storage schema, so this was NOT verified
--   --    against a real project.
--   select tablename, policyname, cmd, roles::text as roles, qual as using_expr
--     from pg_policies
--    where schemaname = 'storage' and tablename <> 'objects';
--
--   -- 6. the bucket stays private. Expected: one row, public = false. ZERO rows
--   --    means the previews bucket row does not exist (not that it is private).
--   select id, public from storage.buckets where id = 'previews';
