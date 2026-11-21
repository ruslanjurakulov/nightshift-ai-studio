-- 0128_upload_parent_asset.sql — an edited picture remembers the picture it was made from (image editor, finishing 0038 / 0051).
-- The image editor (docs/IMAGE_EDITOR.md) saves its result as a NEW library file through the upload ticket, and the ticket had no
-- parent argument, so the new file was tied to the original by NAME only. media_assets.parent_asset_id (0038) already exists, with
-- ON DELETE SET NULL and a version number, and the worker already writes it for AI edits; only the upload path could not set it.
--
-- WHAT IT ADDS (no new column on media_assets, no new table, no new grant)
--   media_uploads.parent_asset_id   the picture the file is an edit of, or null. ON DELETE SET NULL (a purge of the parent while the
--                                   file is on its way unlinks it; no upload ever fails because of it). Written only by request_upload.
--   request_upload(org, filename, mime, bytes, project_id, folder_id, parent_asset_id)
--                                   NEW overload, seven arguments, none defaulted (a default would make a six-name call ambiguous for
--                                   PostgREST). A thin wrapper: sign-in and membership (0038's refusals, same words), THEN the parent
--                                   check below, THEN the six-argument function (0051: every other gate unchanged: type, extension, size,
--                                   in-flight, quota, folder), then it stamps the parent on the ticket it just made. One transaction:
--                                   any refusal rolls the ticket back. The five- and six-argument functions are NOT touched.
--   register_asset                  0051's function, same signature. For an upload it now takes the parent from the TICKET (never from
--                                   the caller) and RE-CHECKS it: still this organization's, not deleted, still an image, and the new
--                                   file itself is an image (what the worker found in it). Gone = no
--                                   link, never a failed upload (as 0051 does for a folder). The rest of the body is 0051's, byte for
--                                   byte: every added line carries the marker "0128" (tests/test_upload_parent_migration.py takes them
--                                   out and compares what is left with 0051's body).
--
-- THE PARENT CHECK at request time
--   The parent must be a LIVE IMAGE of p_org, the organization the caller is a member of, and the upload itself must be an image (kind
--   derived as request_upload derives it: jpeg, png, webp, gif, heic, heif; a video, sound or caption naming a parent is refused the
--   same way). Another organization's picture, a deleted one, a file of another kind and a made-up id get the SAME refusal (P0002, detail reason=parent_not_found): the id confirms nothing
--   across organizations. The check runs only after membership, so a stranger and the anon key get 0038's refusal and learn nothing.
--   Any member may link (the same people who may upload and who can already read the parent); filing into a folder stays editors-only.
--   No client id is trusted: the database reads the parent itself, under the caller's identity (auth.uid()).
--
-- WHAT THIS CANNOT DO
--   * read anything: the link is a uuid of a row of the SAME organization, whose reads are 0038's policies (unchanged);
--   * link across organizations: refused at request time, re-checked at register time, and the worker's own check (0038) stays;
--   * be set by a client directly: media_uploads has no INSERT / UPDATE grant for any API role (0038), and nothing here adds one;
--   * add a SECURITY DEFINER surface beyond the two it replaces/extends: the new overload is granted to authenticated only, like the
--     five- and six-argument ones, revoked from public / anon / service_role, fixed search_path.
--
-- ORDER AND ROLL-OUT. Safe in either order with the Command Center and the worker: before this runs the Command Center's seven-argument call
-- gets PGRST202 and saves without a link (it says so: parent_applied false); an older worker simply does not read the new column.
-- Needs 0051. Replaces one function: refuses (changes nothing) if the live register_asset() is neither 0051's body nor this file's.
-- Additive and idempotent (a guarded column and constraint, create-or-replace, revoke-then-grant). Nothing is dropped.
-- Nothing here publishes, renders, calls a model or spends a credit; the quota, size and in-flight caps are 0044's / 0051's, untouched.
-- Undo: docs/sql/rollback_0128_upload_parent_asset.sql (owner-applied).

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regprocedure('public.request_upload(uuid, text, text, bigint, uuid, uuid)') is null
     or to_regprocedure('public.register_asset(uuid, uuid, text, text, bigint, text, text, integer, integer, numeric, jsonb, bigint, text[], uuid, uuid, uuid, text, uuid)') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'media_uploads' and column_name = 'folder_id') then
    raise exception '0128 needs the media library with upload folders: apply 0038, 0044, 0049 and 0051 first';
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h
    from pg_proc p
   where p.oid = 'public.register_asset(uuid, uuid, text, text, bigint, text, text, integer, integer, numeric, jsonb, bigint, text[], uuid, uuid, uuid, text, uuid)'::regprocedure;
  if h not in ('233cdbb722c76a434f08d929bafa4e27', 'b00d6820a4bc02e37e79222f78ca1e0e') then
    raise exception '0128 found a register_asset() that is neither 0051''s body nor 0128''s (md5 %): read the live body first', h;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. media_uploads.parent_asset_id
-- ───────────────────────────────────────────────────────────────────────────

alter table public.media_uploads add column if not exists parent_asset_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'media_uploads_parent_asset_fkey') then
    alter table public.media_uploads
      add constraint media_uploads_parent_asset_fkey foreign key (parent_asset_id)
      references public.media_assets (id) on delete set null;
  end if;
end $$;

-- The foreign key's SET NULL looks tickets up by parent when one is purged.
create index if not exists media_uploads_parent_asset_idx
  on public.media_uploads (parent_asset_id) where parent_asset_id is not null;

comment on column public.media_uploads.parent_asset_id is
  'The picture this upload is an edit of (migration 0128), or null. Set only by request_upload() after it checked the picture is a live image of the same organization; re-checked by register_asset(); a purged parent sets it to null.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. request_upload — seven arguments: 0051's function plus the parent
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.request_upload(
  p_org uuid, p_filename text, p_mime text, p_bytes bigint, p_project_id uuid, p_folder_id uuid, p_parent_asset_id uuid
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  parent_ uuid;
  out_    jsonb;
begin
  -- 0038's two refusals, word for word, BEFORE anything about the parent is looked up.
  if auth.uid() is null then
    raise exception 'sign in to upload' using errcode = '42501';
  end if;
  if p_org is null or not public.is_org_member(p_org) then
    raise exception 'only a member of this organization may upload to its library' using errcode = '42501';
  end if;

  if p_parent_asset_id is not null then
    -- Another organization's picture, a deleted one, a video and a made-up id read exactly alike.
    select a.id into parent_ from public.media_assets a
     where a.id = p_parent_asset_id and a.org_id = p_org and a.deleted_at is null and a.kind = 'image';
    -- Only a picture can be an edit of a picture: a video, audio or caption ticket naming a parent gets the same refusal (the Command
    -- Center then saves it unlinked). The kind is the one request_upload itself derives from the declared type and the name (0044:
    -- jpeg, png, webp, gif, heic and heif are images).
    if parent_ is null
       or public.media_mime_kind(public.media_normalize_mime(p_mime, public.media_clean_name(p_filename))) is distinct from 'image' then
      raise exception 'no such picture in this organization'
        using errcode = 'P0002', detail = 'reason=parent_not_found';
    end if;
  end if;

  -- Every other gate (type, extension, size, in-flight, quota, folder) is 0051's, unchanged.
  out_ := public.request_upload(p_org, p_filename, p_mime, p_bytes, p_project_id, p_folder_id);

  if parent_ is not null then
    update public.media_uploads set parent_asset_id = parent_ where id = (out_ ->> 'ticket')::uuid;
  end if;
  return out_ || jsonb_build_object('parent_asset_id', parent_);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. register_asset — 0051's function; an upload is linked to its ticket's parent
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.register_asset(
  p_asset_id uuid,
  p_org uuid,
  p_kind text,
  p_mime text,
  p_bytes bigint,
  p_sha256 text,
  p_source text,
  p_width integer default null,
  p_height integer default null,
  p_duration_s numeric default null,
  p_provenance jsonb default '{}'::jsonb,
  p_derived_bytes bigint default 0,
  p_variants text[] default '{}'::text[],
  p_upload_id uuid default null,
  p_parent_asset_id uuid default null,
  p_project_id uuid default null,
  p_original_name text default null,
  p_created_by uuid default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  a       public.media_assets;
  t       public.media_uploads;
  parent  public.media_assets;
  org     uuid := p_org;
  project uuid := p_project_id;
  name_   text := case when p_original_name is null then null else public.media_clean_name(p_original_name) end;
  creator uuid := p_created_by;
  folder_ uuid;
  ver     integer := 1;
begin
  if not public.credits_trusted_caller() then
    raise exception 'assets are registered by the platform''s worker only' using errcode = '42501';
  end if;
  if p_asset_id is null then
    raise exception 'an asset id is required' using errcode = '22023';
  end if;

  select * into a from public.media_assets where id = p_asset_id;
  if found then
    return jsonb_build_object('id', a.id, 'storage_key', a.storage_key, 'reused', true, 'folder_id', a.folder_id);
  end if;

  if p_source = 'upload' then
    if p_upload_id is null then
      raise exception 'an uploaded asset needs its ticket' using errcode = '22023';
    end if;
    select * into t from public.media_uploads where id = p_upload_id for update;
    if not found then
      raise exception 'no such upload' using errcode = 'P0002';
    end if;
    if t.status = 'ingested' and t.asset_id is not null then
      select * into a from public.media_assets where id = t.asset_id;
      return jsonb_build_object('id', a.id, 'storage_key', a.storage_key, 'reused', true, 'folder_id', a.folder_id);
    end if;
    if t.status <> 'ingesting' then
      raise exception 'the upload is %, not ingesting', t.status using errcode = '55000';
    end if;
    if p_org is not null and p_org <> t.org_id then
      raise exception 'the upload belongs to another organization' using errcode = '42501';
    end if;
    if p_bytes > t.declared_bytes then
      raise exception 'the file is larger than the upload declared' using errcode = '22023';
    end if;
    org := t.org_id;
    project := t.project_id;
    name_ := t.original_name;
    creator := t.created_by;
    -- The ticket's folder, if it is still there and still this organization's.
    -- FOR KEY SHARE: a delete of the folder waits for this insert, and its
    -- SET NULL then takes the new file back to All files too. Gone (or never
    -- this org's) = All files: never a reason to lose an upload.
    if t.folder_id is not null then
      select f.id into folder_ from public.media_folders f
       where f.id = t.folder_id and f.org_id = t.org_id
       for key share;
    end if;
    -- 0128 the ticket's parent (the picture an edit was made from), re-checked HERE like the folder: still this organization's,
    -- 0128 still live, still a picture. Anything else (deleted meanwhile, purged) means no link, never a failed upload. FOR KEY
    -- 0128 SHARE: a purge of the parent waits for this insert, and its SET NULL then takes the link off the new file too. Only
    -- 0128 when the worker named no parent itself (it never does for an upload); the same-organization check and version = parent's
    -- 0128 + 1 further down then run on it exactly as for any parent. Only an IMAGE can be an edit of a picture (p_kind is what the
    -- 0128 worker found in the file, not what was declared): a video or sound registered from a ticket that names a parent has no link.
    if p_parent_asset_id is null and t.parent_asset_id is not null and p_kind = 'image' then   -- 0128
      select pa.id into p_parent_asset_id from public.media_assets pa   -- 0128
       where pa.id = t.parent_asset_id and pa.org_id = t.org_id and pa.deleted_at is null and pa.kind = 'image'   -- 0128
       for key share;   -- 0128
    end if;   -- 0128
  elsif p_upload_id is not null then
    raise exception 'only an uploaded asset has a ticket' using errcode = '22023';
  end if;

  if org is null then
    raise exception 'an asset needs its organization' using errcode = '22023';
  end if;

  if p_parent_asset_id is not null then
    select * into parent from public.media_assets where id = p_parent_asset_id;
    -- A version of another organization's asset is not a thing.
    if not found or parent.org_id <> org then
      raise exception 'the parent asset is not in this organization' using errcode = '42501';
    end if;
    ver := parent.version + 1;
  end if;

  perform public.media_quota_lock(org);

  insert into public.media_assets
    (id, org_id, project_id, kind, storage, bytes, derived_bytes, mime, width, height, duration_s,
     sha256, source, provenance, variants, original_name, parent_asset_id, version, upload_id, created_by,
     folder_id)
  values
    (p_asset_id, org, project, p_kind, 'local', p_bytes, greatest(coalesce(p_derived_bytes, 0), 0), p_mime,
     p_width, p_height, round(p_duration_s, 3), lower(p_sha256), p_source, coalesce(p_provenance, '{}'::jsonb),
     coalesce(p_variants, '{}'::text[]), name_, p_parent_asset_id, ver, p_upload_id, creator,
     folder_)
  returning * into a;

  -- Generated and rendered outputs are recorded even over the limit — the
  -- work was paid for, and losing it would be the worse failure. The org's
  -- next upload is refused instead.
  update public.org_storage_quota
     set used_bytes = used_bytes + a.bytes + a.derived_bytes, updated_at = now()
   where org_id = org;

  if p_source = 'upload' then
    update public.media_uploads
       set status = 'ingested', asset_id = a.id, received_bytes = a.bytes, reason = null, error = null,
           finished_at = now(), updated_at = now()
     where id = p_upload_id;
  end if;

  return jsonb_build_object('id', a.id, 'storage_key', a.storage_key, 'reused', false, 'folder_id', a.folder_id);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Privileges (0051's for the existing ones; the same for the new overload)
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.request_upload(uuid, text, text, bigint, uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.register_asset(uuid, uuid, text, text, bigint, text, text, integer, integer, numeric, jsonb, bigint, text[], uuid, uuid, uuid, text, uuid) from public, anon, authenticated, service_role;

grant execute on function public.request_upload(uuid, text, text, bigint, uuid, uuid, uuid) to authenticated;
grant execute on function public.register_asset(uuid, uuid, text, text, bigint, text, text, integer, integer, numeric, jsonb, bigint, text[], uuid, uuid, uuid, text, uuid) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The end state (the transaction does not commit unless it holds)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  reg  oid := 'public.register_asset(uuid, uuid, text, text, bigint, text, text, integer, integer, numeric, jsonb, bigint, text[], uuid, uuid, uuid, text, uuid)'::regprocedure;
  req7 oid := to_regprocedure('public.request_upload(uuid, text, text, bigint, uuid, uuid, uuid)');
  role_name text;
  priv text;
begin
  if req7 is null then
    raise exception '0128 end state: the seven-argument request_upload() is missing';
  end if;
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = reg) <> 'b00d6820a4bc02e37e79222f78ca1e0e'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = req7) <> '026ca0dd20027163049ff0fea7f0e170' then
    raise exception '0128 end state: a function does not hold this file''s body';
  end if;
  if (select count(*) from pg_proc where proname = 'request_upload' and pronamespace = 'public'::regnamespace) <> 3 then
    raise exception '0128 end state: request_upload() does not have exactly three overloads';
  end if;
  if not (has_function_privilege('authenticated', req7, 'EXECUTE')
          and not has_function_privilege('anon', req7, 'EXECUTE')
          and not has_function_privilege('service_role', req7, 'EXECUTE')
          and has_function_privilege('service_role', reg, 'EXECUTE')
          and not has_function_privilege('authenticated', reg, 'EXECUTE')
          and not has_function_privilege('anon', reg, 'EXECUTE')) then
    raise exception '0128 end state: a function has the wrong grants';
  end if;
  if exists (select 1 from pg_proc p where p.oid in (reg, req7)
              and (p.proacl is null or not p.prosecdef
                   or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
                   or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))) then
    raise exception '0128 end state: a function is public, not SECURITY DEFINER or has no fixed search_path';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'media_uploads_parent_asset_fkey'
                   and conrelid = 'public.media_uploads'::regclass and confdeltype = 'n' and convalidated) then
    raise exception '0128 end state: the parent foreign key is missing or is not ON DELETE SET NULL';
  end if;
  -- No API role can write the column: the table's INSERT / UPDATE stay with nobody (0038).
  foreach role_name in array array['anon', 'authenticated'] loop
    foreach priv in array array['insert', 'update', 'delete', 'truncate'] loop
      if has_table_privilege(role_name, 'public.media_uploads', priv)
         or has_column_privilege(role_name, 'public.media_uploads', 'parent_asset_id', 'insert')
         or has_column_privilege(role_name, 'public.media_uploads', 'parent_asset_id', 'update') then
        raise exception '0128 end state: % can write media_uploads', role_name;
      end if;
    end loop;
  end loop;
  if has_column_privilege('service_role', 'public.media_uploads', 'parent_asset_id', 'update')
     or has_column_privilege('service_role', 'public.media_uploads', 'parent_asset_id', 'insert') then
    raise exception '0128 end state: service_role can write media_uploads.parent_asset_id';
  end if;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   exists (select 1 from information_schema.columns
--            where table_schema = 'public' and table_name = 'media_uploads' and column_name = 'parent_asset_id') as upload_column,
--   exists (select 1 from pg_constraint
--            where conname = 'media_uploads_parent_asset_fkey' and confdeltype = 'n') as parent_fk_set_null,
--   has_function_privilege('authenticated', 'public.request_upload(uuid,text,text,bigint,uuid,uuid,uuid)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.request_upload(uuid,text,text,bigint,uuid,uuid,uuid)', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.request_upload(uuid,text,text,bigint,uuid,uuid,uuid)', 'EXECUTE')
--     as request_scoped,
--   has_function_privilege('service_role',
--       'public.register_asset(uuid,uuid,text,text,bigint,text,text,integer,integer,numeric,jsonb,bigint,text[],uuid,uuid,uuid,text,uuid)', 'EXECUTE')
--     and not has_function_privilege('authenticated',
--       'public.register_asset(uuid,uuid,text,text,bigint,text,text,integer,integer,numeric,jsonb,bigint,text[],uuid,uuid,uuid,text,uuid)', 'EXECUTE')
--     as register_scoped,
--   not has_table_privilege('authenticated', 'public.media_uploads', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.media_uploads', 'UPDATE') as uploads_read_only,
--   (select count(*) = 3 from pg_proc where proname = 'request_upload' and pronamespace = 'public'::regnamespace) as three_overloads;
--
-- How many edited pictures have a parent so far (after the editor is switched on):
--   select count(*) from public.media_assets a join public.media_uploads u on u.asset_id = a.id where u.parent_asset_id is not null and a.parent_asset_id = u.parent_asset_id;
