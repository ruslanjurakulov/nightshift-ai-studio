-- 0051_upload_into_folder.sql — a file uploaded while a folder is open lands
-- in that folder (Library v3, finishing 0049). Until now every upload went to
-- "All files" and had to be moved by hand afterwards.
--
-- WHAT IT ADDS
--   media_uploads.folder_id  the folder the person asked the file to go in, or
--                            null (All files). ON DELETE SET NULL: deleting
--                            the folder while the file is on its way sends it
--                            to All files; no upload ever fails because of it.
--   request_upload(org, filename, mime, bytes, project_id, folder_id)
--                            NEW overload, six arguments, none defaulted: 0044's
--                            function body (every check unchanged: sign-in,
--                            membership, type allowlist, extension vs type,
--                            size cap, in-flight cap, quota under the org's
--                            lock, server-full) plus the folder check below,
--                            and the folder stored on the ticket.
--   request_upload(org, filename, mime, bytes, project_id default null)
--                            0044's five-argument function, now a thin call
--                            of the six-argument one with no folder — exactly
--                            what it did before. It is kept (not dropped) so a
--                            Command Center deployed before this migration, or
--                            one that names no folder, keeps working. No
--                            argument list matches both (PostgREST picks by
--                            argument names: only a call that names
--                            p_folder_id reaches the six-argument one, and it
--                            must name all six).
--   register_asset           0038's function, same signature; for an upload
--                            it now puts the asset in the ticket's folder —
--                            RE-CHECKED there (the folder must still exist
--                            and be the ticket's organization's, locked FOR
--                            KEY SHARE until commit so it cannot be deleted
--                            between the check and the insert). A folder that
--                            is gone means All files, never a failure: the
--                            file was paid for in time and bytes. The answer
--                            also says which folder (folder_id) it went in.
--
-- THE FOLDER CHECK at request time (request_upload, six arguments)
--   folder null    All files — anyone who may upload (a member), as before.
--   folder given   the caller must be an EDITOR of the org (filing a file is
--                  a folder write, the rule move_media_assets keeps: a viewer
--                  may upload, into All files only), and the folder must be
--                  one of p_org's. Another organization's folder and a
--                  made-up id get the SAME refusal (P0002, detail
--                  reason=folder_not_found): an id confirms nothing across
--                  organizations.
--   The folder comes from the ticket, which only request_upload writes; the
--   worker never names one (register_asset has no folder argument), and the
--   media_assets_folder_guard trigger of 0049 refuses any folder of another
--   organization for every writer anyway.
--
-- ERRORS added (SQLSTATE; detail is the machine word lib/media.ts
-- mapMediaError reads):
--   42501 detail reason=folder_forbidden  a viewer named a folder
--   P0002 detail reason=folder_not_found  no such folder in this org
--   (every 0038 / 0044 error is unchanged)
--
-- Nothing here publishes, renders, calls a model or spends a credit. The
-- quota, the size cap and the in-flight cap are 0044's, untouched.
--
-- REQUIRES 0038 (media library), 0044 (its latest request_upload) and 0049
-- (media_folders). Additive and idempotent: a guarded column and constraint,
-- create-or-replace functions (0044's request_upload and 0038's register_asset
-- are the latest definitions on main; no later migration redefines them),
-- revoke-then-grant. Nothing is dropped.

do $$
begin
  if to_regprocedure('public.request_upload(uuid, text, text, bigint, uuid)') is null
     or to_regprocedure('public.media_ext_mime(text)') is null then
    raise exception '0051 needs the media library: apply 0038_media_assets.sql and 0044_media_heic.sql first';
  end if;
  if to_regclass('public.media_folders') is null then
    raise exception '0051 needs media library folders: apply 0049_media_folders.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. media_uploads.folder_id
-- ───────────────────────────────────────────────────────────────────────────

alter table public.media_uploads add column if not exists folder_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'media_uploads_folder_fkey') then
    alter table public.media_uploads
      add constraint media_uploads_folder_fkey foreign key (folder_id)
      references public.media_folders (id) on delete set null;
  end if;
end $$;

-- The foreign key's SET NULL looks tickets up by folder when one is deleted.
create index if not exists media_uploads_folder_idx
  on public.media_uploads (folder_id) where folder_id is not null;

comment on column public.media_uploads.folder_id is
  'The folder the file should land in (migration 0051), or null (All files). Set only by request_upload(); re-checked by register_asset(); a deleted folder sets it to null.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. request_upload — 0044's function plus the folder
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.request_upload(
  p_org uuid, p_filename text, p_mime text, p_bytes bigint, p_project_id uuid, p_folder_id uuid
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  name_    text := public.media_clean_name(p_filename);
  mime_    text := public.media_normalize_mime(p_mime, public.media_clean_name(p_filename));
  kind_    text;
  ext_mime text;
  cfg      public.media_storage_settings;
  q        public.org_storage_quota;
  lim      bigint;
  pending  bigint;
  inflight integer;
  t        public.media_uploads;
begin
  if auth.uid() is null then
    raise exception 'sign in to upload' using errcode = '42501';
  end if;
  if p_org is null or not public.is_org_member(p_org) then
    raise exception 'only a member of this organization may upload to its library' using errcode = '42501';
  end if;

  -- Filing a file is a folder write: editors only, as move_media_assets. The
  -- role is checked before the folder is looked up, so a viewer learns
  -- nothing about which folder ids exist.
  if p_folder_id is not null then
    if not public.is_org_member(p_org, 'editor') then
      raise exception 'only an editor of this organization may upload into a folder'
        using errcode = '42501', detail = 'reason=folder_forbidden',
              hint = 'Upload to All files, or ask an editor to move the file.';
    end if;
    -- Another organization's folder reads exactly like one that does not exist.
    perform 1 from public.media_folders f where f.id = p_folder_id and f.org_id = p_org;
    if not found then
      raise exception 'no such folder in this organization'
        using errcode = 'P0002', detail = 'reason=folder_not_found';
    end if;
  end if;

  kind_ := public.media_mime_kind(mime_);
  if kind_ is null then
    raise exception 'this file type is not accepted'
      using errcode = 'NS415', detail = 'reason=unsupported_type',
            hint = 'Images (JPEG, PNG, WebP, GIF, HEIC, HEIF), video (MP4, MOV, WebM, MKV), audio (MP3, M4A, WAV, OGG, FLAC, AAC) and captions (VTT, SRT).';
  end if;
  -- An extension that names a different kind of media (photo.png sent as
  -- video/mp4) or no media at all (clip.exe) is refused here; the worker
  -- checks the content itself later, whatever passes this.
  if name_ ~ '\.[A-Za-z0-9]{1,5}$' then
    ext_mime := public.media_ext_mime(substring(name_ from '\.([A-Za-z0-9]{1,5})$'));
    if ext_mime is null or public.media_mime_kind(ext_mime) <> kind_ then
      raise exception 'the file name''s extension does not match its type'
        using errcode = 'NS415', detail = 'reason=extension_mismatch';
    end if;
  end if;

  select * into cfg from public.media_storage_settings where id;
  if p_bytes is null or p_bytes <= 0 then
    raise exception 'the file is empty' using errcode = '22023';
  end if;
  if p_bytes > cfg.max_upload_bytes or (kind_ = 'caption' and p_bytes > 2097152) then
    raise exception 'the file is larger than an upload may be'
      using errcode = 'NS413',
            detail = format('max=%s', case when kind_ = 'caption' then least(cfg.max_upload_bytes, 2097152)
                                           else cfg.max_upload_bytes end);
  end if;

  -- Under the org's quota lock: parallel requests queue here, so they cannot
  -- both fit under the limit that only one of them fits under.
  q := public.media_quota_lock(p_org);
  perform public.media_uploads_sweep(p_org);

  select count(*) into inflight from public.media_uploads u
   where u.org_id = p_org and u.status in ('requested', 'receiving', 'uploaded', 'ingesting');
  if inflight >= cfg.max_pending_uploads then
    raise exception 'too many uploads in progress for this organization'
      using errcode = 'NS429', detail = format('in_flight=%s max=%s', inflight, cfg.max_pending_uploads);
  end if;

  lim := coalesce(q.limit_bytes, cfg.default_quota_bytes);
  pending := public.media_pending_bytes(p_org);
  if q.used_bytes + pending + p_bytes > lim then
    raise exception 'not enough storage left for this file'
      using errcode = 'NS507',
            detail = format('used=%s pending=%s limit=%s requested=%s', q.used_bytes, pending, lim, p_bytes),
            hint = 'Delete assets you no longer need, or ask the platform owner for more storage.';
  end if;
  -- The server as a whole. No number about other organizations is returned.
  if (select coalesce(sum(x.used_bytes), 0) from public.org_storage_quota x)
     + (select coalesce(sum(coalesce(u.received_bytes, u.declared_bytes)), 0) from public.media_uploads u
         where u.status in ('requested', 'receiving', 'uploaded', 'ingesting'))
     + p_bytes > cfg.max_total_bytes then
    raise exception 'the server''s media storage is full'
      using errcode = 'NS507', detail = 'reason=server_full',
            hint = 'The platform owner has to free space or raise media_storage_settings.max_total_bytes.';
  end if;

  insert into public.media_uploads
    (org_id, project_id, folder_id, original_name, declared_mime, declared_bytes, status, expires_at, created_by)
  values
    (p_org, p_project_id, p_folder_id, name_, mime_, p_bytes, 'requested',
     now() + make_interval(mins => cfg.ticket_ttl_minutes), auth.uid())
  returning * into t;

  return jsonb_build_object('ticket', t.id, 'kind', kind_, 'mime', mime_, 'name', name_,
                            'max_bytes', p_bytes, 'expires_at', t.expires_at, 'folder_id', t.folder_id);
end
$$;

-- 0044's five-argument function: the same checks, no folder (All files).
create or replace function public.request_upload(
  p_org uuid, p_filename text, p_mime text, p_bytes bigint, p_project_id uuid default null
) returns jsonb
  language sql volatile security definer set search_path = public, pg_temp as $$
  select public.request_upload(p_org, p_filename, p_mime, p_bytes, p_project_id, null::uuid)
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. register_asset — 0038's function; an upload lands in its ticket's folder
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
-- 4. Privileges (0038's for the existing two; the same for the new overload)
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.request_upload(uuid, text, text, bigint, uuid) from public, anon, authenticated, service_role;
revoke all on function public.request_upload(uuid, text, text, bigint, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.register_asset(uuid, uuid, text, text, bigint, text, text, integer, integer, numeric, jsonb, bigint, text[], uuid, uuid, uuid, text, uuid) from public, anon, authenticated, service_role;

grant execute on function public.request_upload(uuid, text, text, bigint, uuid) to authenticated;
grant execute on function public.request_upload(uuid, text, text, bigint, uuid, uuid) to authenticated;
grant execute on function public.register_asset(uuid, uuid, text, text, bigint, text, text, integer, integer, numeric, jsonb, bigint, text[], uuid, uuid, uuid, text, uuid) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   exists (select 1 from information_schema.columns
--            where table_schema = 'public' and table_name = 'media_uploads'
--              and column_name = 'folder_id') as upload_column,
--   exists (select 1 from pg_constraint
--            where conname = 'media_uploads_folder_fkey' and confdeltype = 'n') as folder_fk_set_null,
--   has_function_privilege('authenticated', 'public.request_upload(uuid,text,text,bigint,uuid,uuid)', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.request_upload(uuid,text,text,bigint,uuid)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.request_upload(uuid,text,text,bigint,uuid,uuid)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.request_upload(uuid,text,text,bigint,uuid)', 'EXECUTE')
--     as request_scoped,
--   has_function_privilege('service_role',
--       'public.register_asset(uuid,uuid,text,text,bigint,text,text,integer,integer,numeric,jsonb,bigint,text[],uuid,uuid,uuid,text,uuid)',
--       'EXECUTE')
--     and not has_function_privilege('authenticated',
--       'public.register_asset(uuid,uuid,text,text,bigint,text,text,integer,integer,numeric,jsonb,bigint,text[],uuid,uuid,uuid,text,uuid)',
--       'EXECUTE') as register_scoped,
--   not has_table_privilege('authenticated', 'public.media_uploads', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.media_uploads', 'UPDATE') as uploads_read_only,
--   (select count(*) = 2 from pg_proc
--     where proname = 'request_upload' and pronamespace = 'public'::regnamespace) as two_overloads;
