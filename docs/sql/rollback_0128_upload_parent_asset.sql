-- rollback_0128_upload_parent_asset.sql — takes migration 0128 out again. OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app
-- runs it.
--
-- WHEN YOU NEED IT. If an edited picture must stop remembering its original at upload time. The Command Center needs no change first: its
-- seven-argument call then gets "function not found", saves the file WITHOUT a link and says so (parent_applied false), exactly as before 0128.
--
-- READ THIS FIRST. What is NOT undone: pictures that were already registered keep media_assets.parent_asset_id and their version number
-- (0038's own column, which AI edits use too); this file never touches media_assets. What IS lost: the parent recorded on upload tickets
-- (media_uploads.parent_asset_id is dropped), which matters only for tickets still in flight, so the file REFUSES while one exists.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if the live register_asset() is not 0128's body (a later change would be undone), if the seven-argument
--      request_upload() is not 0128's body, or if a ticket in flight (requested / receiving / uploaded / ingesting) carries a parent.
--   1. Puts register_asset() back to 0051's body, byte for byte (create or replace keeps its privileges: service_role only).
--   2. Drops the seven-argument request_upload(), the index, the foreign key and the column media_uploads.parent_asset_id.
--   3. Asserts the end state: 0051's hash, two request_upload overloads left, grants as before 0128.
--
-- tests/security/test_sec_upload_parent.py applies this file to a copy of the lab database and re-applies 0128.

begin;
set local lock_timeout = '5s';

do $$
declare
  r text;
  q text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into r
    from pg_proc p
   where p.oid = to_regprocedure('public.register_asset(uuid, uuid, text, text, bigint, text, text, integer, integer, numeric, jsonb, bigint, text[], uuid, uuid, uuid, text, uuid)');
  if r is distinct from 'b00d6820a4bc02e37e79222f78ca1e0e' then
    raise exception 'rollback 0128: register_asset() is not 0128''s body (md5 %): a later change would be undone; read the live body first', r;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into q
    from pg_proc p where p.oid = to_regprocedure('public.request_upload(uuid, text, text, bigint, uuid, uuid, uuid)');
  if q is distinct from '026ca0dd20027163049ff0fea7f0e170' then
    raise exception 'rollback 0128: the seven-argument request_upload() is missing or is not 0128''s body (md5 %)', q;
  end if;
  if exists (select 1 from public.media_uploads where parent_asset_id is not null and status in ('requested', 'receiving', 'uploaded', 'ingesting')) then
    raise exception 'rollback 0128: an upload in flight carries a parent; wait until it is ingested or expired, then run this again';
  end if;
end $$;

-- 1. 0051's body, verbatim.
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

-- 2. The seven-argument function and the ticket column.
drop function public.request_upload(uuid, text, text, bigint, uuid, uuid, uuid);
drop index if exists public.media_uploads_parent_asset_idx;
alter table public.media_uploads drop constraint if exists media_uploads_parent_asset_fkey;
alter table public.media_uploads drop column if exists parent_asset_id;

-- 3. The end state.
do $$
declare
  reg oid := 'public.register_asset(uuid, uuid, text, text, bigint, text, text, integer, integer, numeric, jsonb, bigint, text[], uuid, uuid, uuid, text, uuid)'::regprocedure;
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = reg) <> '233cdbb722c76a434f08d929bafa4e27' then
    raise exception 'rollback 0128 end state: register_asset() does not hold 0051''s body';
  end if;
  if (select count(*) from pg_proc where proname = 'request_upload' and pronamespace = 'public'::regnamespace) <> 2 then
    raise exception 'rollback 0128 end state: request_upload() does not have exactly two overloads';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'media_uploads' and column_name = 'parent_asset_id') then
    raise exception 'rollback 0128 end state: the column is still there';
  end if;
  if not (has_function_privilege('service_role', reg, 'EXECUTE') and not has_function_privilege('authenticated', reg, 'EXECUTE')
          and not has_function_privilege('anon', reg, 'EXECUTE')) then
    raise exception 'rollback 0128 end state: register_asset() has the wrong grants';
  end if;
end $$;

commit;
