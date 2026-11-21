-- 0097_user_avatars.sql — a private profile photo per person (the "avatars" bucket).
--
-- The owner asked for a round photo, as on Instagram, that replaces the
-- first-letter circle wherever it is shown. A photo is private: workspaces are
-- single-person and no feature shows one person's picture to another, so the
-- only person who can ever read, write or delete an avatar is the one it
-- belongs to.
--
-- WHAT IT ADDS
--   storage bucket "avatars"   private (public = false), 256 KB per object,
--                              image/jpeg only. The Command Center re-encodes
--                              every upload to a 256x256 JPEG in the browser
--                              (a canvas cannot encode WebP in Safari, so JPEG
--                              is the one format every browser can produce),
--                              and /api/avatar re-checks the bytes on the
--                              server; the limits here are the third fence,
--                              not the first.
--   four policies on storage.objects (select / insert / update / delete), all
--   scoped to bucket 'avatars' and to ONE object name per person:
--       <auth.uid()>/avatar.jpg
--   Nothing else is writable or readable: not another file name in the same
--   folder, not a sub-folder ('<uid>/x/avatar.jpg'), not another person's
--   folder, not a different case or a trailing slash. The version marker (a
--   number, used only to bust the browser cache) lives in the person's auth
--   user_metadata as avatar_v, so there is no profile table to add or to leak.
--
-- WHO MAY DO WHAT
--   authenticated  own object only, for all four verbs (see above).
--   anon           nothing: every policy is "to authenticated", and anon has no
--                  policy here at all.
--   service_role   bypasses RLS as always; the Command Center never uses it
--                  for avatars (the route runs as the signed-in user).
--   No policy of any OTHER bucket is created, changed or dropped. Policies on
--   storage.objects are permissive and add up, so a hand-made dashboard policy
--   on bucket 'avatars' (or one without a bucket test) would widen this; the
--   Verify block at the bottom lists them.
--
-- WHAT AN OUTSIDER CAN LEARN
--   Nothing. A signed-out request, or a signed-in request for somebody else's
--   folder, sees no rows (select), and an insert/update/delete is refused or
--   matches zero rows: whether a given person has a photo, when it changed, or
--   what it is cannot be learned from the database or the bucket. The bucket is
--   private, so there is no public URL, and the file name carries no e-mail
--   address (only the opaque user id the person already knows).
--
-- NOT HANDLED HERE (said plainly, because it is easy to assume)
--   * Account deletion is e-mail-only today and does not cascade into Storage:
--     the object stays until someone removes it. The row-less design means
--     there is no foreign key to hang an "on delete cascade" on.
--   * Storage checks the Content-Type HEADER of an upload against
--     allowed_mime_types, not the bytes; the route validates the bytes
--     (JPEG structure, dimensions, size, no metadata) before it uploads.
--
-- Additive and idempotent (upsert of the bucket, drop-if-exists / create of
-- the policies). Requires Supabase Storage (the storage schema). Safe to run
-- twice. Applied by the operator after review, not by CI.

do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise exception '0097 needs the storage schema (Supabase Storage): enable Storage on the project first';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The bucket
-- ─────────────────────────────────────────────────────────────────────────

-- DO UPDATE, not DO NOTHING (0004 / 0026 use the latter): a re-run must leave
-- the bucket private with these limits even if somebody flipped it by hand.
-- 262144 = 256 KB; a 256x256 JPEG at q0.85 is normally 15-30 KB.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 262144, array['image/jpeg'])
on conflict (id) do update
  set public = false,
      file_size_limit = 262144,
      allowed_mime_types = array['image/jpeg'];

-- ─────────────────────────────────────────────────────────────────────────
-- 2. One object per person, readable and writable by that person only
-- ─────────────────────────────────────────────────────────────────────────

-- The name test is an exact equality on '<uid>/avatar.jpg'; the folder test
-- repeats the first-segment rule so a reader of the policy sees the intent.
-- auth.uid() is NULL for anon, which makes every comparison NULL (refused).

drop policy if exists avatars_select_own on storage.objects;
create policy avatars_select_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and name = (select auth.uid())::text || '/avatar.jpg'
  );

drop policy if exists avatars_insert_own on storage.objects;
create policy avatars_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and name = (select auth.uid())::text || '/avatar.jpg'
  );

-- UPDATE needs both halves: USING picks the row that may be changed, WITH
-- CHECK stops a rename that would move the object to another name or folder.
-- (An upsert from the route is an insert, or an update of the same name.)
drop policy if exists avatars_update_own on storage.objects;
create policy avatars_update_own on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and name = (select auth.uid())::text || '/avatar.jpg'
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and name = (select auth.uid())::text || '/avatar.jpg'
  );

drop policy if exists avatars_delete_own on storage.objects;
create policy avatars_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and name = (select auth.uid())::text || '/avatar.jpg'
  );

-- ─────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor; every row should read true)
-- ─────────────────────────────────────────────────────────────────────────
--   select (select not public and file_size_limit = 262144 and allowed_mime_types = array['image/jpeg']
--             from storage.buckets where id = 'avatars') as bucket_ok,
--          (select count(*) = 4 from pg_policies
--            where schemaname = 'storage' and tablename = 'objects' and policyname like 'avatars\_%\_own') as four_policies,
--          (select bool_and(roles = '{authenticated}') from pg_policies
--            where schemaname = 'storage' and tablename = 'objects' and policyname like 'avatars\_%\_own') as authenticated_only;
--
--   -- Any policy that could widen access to the bucket (should return no rows):
--   select policyname, cmd, roles, coalesce(qual, with_check) as expr from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--      and policyname not like 'avatars\_%\_own'
--      and coalesce(qual, with_check, '') not like '%bucket_id%';
