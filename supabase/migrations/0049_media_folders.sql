-- 0049_media_folders.sql — folders in the media library ("Jildlar"): a flat,
-- named place per organization that a file can be put in, so a library of a
-- few hundred files stays findable (docs/research/competitors.md: Krea
-- Assets folders, MagicLight "My Creations" projects — done our way).
--
-- WHAT IT ADDS
--   media_folders            a named folder of one organization: name 1–60
--                            characters (no control characters, no leading or
--                            trailing blanks), unique per organization ignoring
--                            case, at most 200 per organization.
--   media_assets.folder_id   the folder a file is in, or null (only in "All
--                            files"). ON DELETE SET NULL: deleting a folder
--                            puts its files back in "All files"; no file is
--                            ever deleted with a folder.
--   save_media_folder(org, folder, name)
--                            create (folder null) or rename one.
--   delete_media_folder(org, folder)
--                            remove a folder (its files stay in the library).
--   move_media_assets(org, folder_or_null, asset_ids)
--                            put 1–200 files of the org in a folder, or take
--                            them out of any folder (folder null). All or
--                            nothing.
--   media_folder_counts(org) how many live files each folder holds, and how
--                            many are in no folder — read with the caller's
--                            own rights (security invoker: RLS decides).
--
-- A FILE IS ONLY EVER IN A FOLDER OF ITS OWN ORGANIZATION (enforced twice)
--   * move_media_assets accepts only a folder of p_org and only ids of LIVE
--     assets of p_org; any other id — another organization's, a deleted one, a
--     made-up one — fails the whole call with the same refusal
--     ('invalid_asset'), so the answer says nothing about whether someone
--     else's file exists. Another organization's folder reads as not found.
--   * a BEFORE trigger on media_assets (media_assets_folder_guard, the
--     channels_style_kit_guard pattern of 0047) refuses a folder_id whose
--     folder is not the asset's organization's — for every writer, the
--     service role and the owner included, not just the function above.
--
-- WHO MAY DO WHAT (authenticated = a signed-in browser via the anon key)
--   media_folders             select: members of the org (viewer) · insert /
--                             update / delete: nobody directly — the functions
--   save_media_folder,
--   delete_media_folder,
--   move_media_assets         authenticated; each checks EDITOR membership of
--                             the org itself (a self-serve customer owns their
--                             org). Another org's folder reads as not found.
--   media_folder_counts       authenticated, security invoker: counts only
--                             what the caller may already read.
--   media_assets.folder_id    written only by move_media_assets (and set to
--                             null by the foreign key when a folder goes).
--   service_role              select only.
--   anon gets nothing.
--
-- ERRORS (SQLSTATE; the message is the machine code the app maps,
-- command-center/lib/media-folders.ts mapFolderError):
--   42501 forbidden (not signed in / not an editor of the org)
--   P0002 not_found (no such folder in this org — another org's included)
--   NS400 invalid_name | no_assets | too_many_assets | invalid_asset
--   NS409 name_taken (a folder of that name, ignoring case, exists in the org)
--   NS429 limit_reached (the org has 200 folders)
--
-- Nothing here publishes, renders, calls a model or spends a credit. Moving a
-- file changes which folder lists it and nothing else: its bytes, quota,
-- provenance and every job that used it are untouched.
--
-- REQUIRES 0018 (organizations) and 0038 (media_assets). Additive and
-- idempotent: guarded creates, a guarded column and constraint on
-- media_assets, drop-then-create policy and trigger, create-or-replace
-- functions. Nothing existing is dropped or changed.

do $$
begin
  if to_regprocedure('public.accessible_org_ids(text)') is null
     or to_regprocedure('public.is_org_member(uuid, text)') is null then
    raise exception '0049 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regclass('public.media_assets') is null then
    raise exception '0049 needs the media library: apply 0038_media_assets.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. media_folders
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.media_folders (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60
                                  and name !~ '[[:cntrl:]]' and name = btrim(name)),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- "Brand" and "brand" are the same folder to a person looking for it.
create unique index if not exists media_folders_org_name_key on public.media_folders (org_id, lower(name));

comment on table public.media_folders is
  'Media library folders (migration 0049): a flat, named place per organization (<= 200). Written only by save_media_folder() / delete_media_folder(); members read.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. media_assets.folder_id and its same-organization guard
-- ───────────────────────────────────────────────────────────────────────────

alter table public.media_assets add column if not exists folder_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'media_assets_folder_fkey') then
    alter table public.media_assets
      add constraint media_assets_folder_fkey foreign key (folder_id)
      references public.media_folders (id) on delete set null;
  end if;
end $$;

-- Listing a folder, counting it, and the foreign key's SET NULL all look
-- assets up by folder.
create index if not exists media_assets_folder_idx
  on public.media_assets (folder_id, created_at desc) where folder_id is not null;

comment on column public.media_assets.folder_id is
  'The folder this file is in (migration 0049), or null (only in All files). Must belong to the asset''s organization (media_assets_folder_guard). Written by move_media_assets().';

-- The folder must be the asset's organization's. An asset whose organization
-- changes (no path does this today) leaves its old folder behind rather than
-- being blocked by it; naming another org's folder is refused as "not found",
-- for every writer.
create or replace function public.media_assets_folder_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.folder_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.org_id is distinct from old.org_id
     and new.folder_id is not distinct from old.folder_id
     and not exists (select 1 from public.media_folders f
                      where f.id = new.folder_id and f.org_id = new.org_id) then
    new.folder_id := null;
    return new;
  end if;
  if not exists (select 1 from public.media_folders f
                  where f.id = new.folder_id and f.org_id = new.org_id) then
    raise exception 'not_found'
      using errcode = 'P0002', detail = 'a file''s folder must belong to the file''s organization';
  end if;
  return new;
end
$$;

drop trigger if exists media_assets_folder_guard on public.media_assets;
create trigger media_assets_folder_guard
  before insert or update of folder_id, org_id on public.media_assets
  for each row execute function public.media_assets_folder_guard();

-- ───────────────────────────────────────────────────────────────────────────
-- 3. save_media_folder / delete_media_folder
-- ───────────────────────────────────────────────────────────────────────────

-- A folder name a person typed, made storable: runs of white space (tabs and
-- line breaks included) folded to one space, other control characters
-- removed, trimmed.
create or replace function public.media_folder_clean_name(p_name text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select btrim(regexp_replace(regexp_replace(coalesce(p_name, ''), '[[:space:]]+', ' ', 'g'),
                              '[[:cntrl:]]', '', 'g'))
$$;

-- p_folder null: create a folder in p_org. p_folder set: rename it (its org
-- is the folder's own; p_org, if given, must agree). Returns the folder id.
create or replace function public.save_media_folder(p_org uuid, p_folder uuid, p_name text) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  f     public.media_folders;
  org_  uuid := p_org;
  name_ text := public.media_folder_clean_name(p_name);
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_folder is not null then
    select * into f from public.media_folders where id = p_folder for update;
    -- Another organization's folder reads as missing, never as "forbidden".
    if not found or not public.is_org_member(f.org_id) or (p_org is not null and p_org <> f.org_id) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    org_ := f.org_id;
  end if;
  if org_ is null or not public.is_org_member(org_, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if char_length(name_) not between 1 and 60 then
    raise exception 'invalid_name' using errcode = 'NS400', detail = 'max=60';
  end if;

  -- One writer per organization at a time: the cap and the name check hold
  -- under parallel requests.
  perform pg_advisory_xact_lock(hashtextextended('media_folders:' || org_::text, 0));

  if exists (select 1 from public.media_folders x
              where x.org_id = org_ and lower(x.name) = lower(name_) and x.id is distinct from p_folder) then
    raise exception 'name_taken' using errcode = 'NS409';
  end if;

  if p_folder is null then
    if (select count(*) from public.media_folders where org_id = org_) >= 200 then
      raise exception 'limit_reached' using errcode = 'NS429', detail = 'max=200';
    end if;
    insert into public.media_folders (org_id, name, created_by)
    values (org_, name_, auth.uid())
    returning * into f;
  else
    update public.media_folders set name = name_, updated_at = now()
     where id = f.id
    returning * into f;
  end if;
  return f.id;
end
$$;

-- Remove a folder. Its files are NOT deleted: the foreign key puts them back
-- in "All files" (folder_id null) in the same transaction.
create or replace function public.delete_media_folder(p_org uuid, p_folder uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  f public.media_folders;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into f from public.media_folders where id = p_folder for update;
  if not found or not public.is_org_member(f.org_id) or (p_org is not null and p_org <> f.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(f.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.media_folders where id = f.id;
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. move_media_assets
-- ───────────────────────────────────────────────────────────────────────────

-- Put files of p_org in p_folder (null: in no folder). Every id must be a
-- live asset of p_org, or nothing moves. Returns how many files changed
-- folder (a file already there is not counted, and is not an error).
create or replace function public.move_media_assets(p_org uuid, p_folder uuid, p_assets uuid[]) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  n     integer := coalesce(cardinality(p_assets), 0);
  uniq  integer;
  moved integer;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_org is null or not public.is_org_member(p_org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if n = 0 then
    raise exception 'no_assets' using errcode = 'NS400';
  end if;
  if n > 200 then
    raise exception 'too_many_assets' using errcode = 'NS400', detail = format('max=200 count=%s', n);
  end if;
  if array_position(p_assets, null) is not null then
    raise exception 'invalid_asset' using errcode = 'NS400';
  end if;

  if p_folder is not null then
    -- Held until commit: the folder cannot be deleted under this move.
    perform 1 from public.media_folders where id = p_folder and org_id = p_org for share;
    if not found then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
  end if;

  select count(distinct a) into uniq from unnest(p_assets) a;
  -- Lock the rows first (in id order, so two moves never deadlock): a delete
  -- or another move of the same files waits for this one.
  perform 1 from public.media_assets m
    where m.id = any (p_assets) and m.org_id = p_org and m.deleted_at is null
    order by m.id
    for update;
  if (select count(*) from public.media_assets m
       where m.id = any (p_assets) and m.org_id = p_org and m.deleted_at is null) <> uniq then
    raise exception 'invalid_asset'
      using errcode = 'NS400',
            detail = 'every file must be a live file in this organization''s library';
  end if;

  update public.media_assets m set folder_id = p_folder
   where m.id = any (p_assets) and m.org_id = p_org and m.deleted_at is null
     and m.folder_id is distinct from p_folder;
  get diagnostics moved = row_count;
  return moved;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. media_folder_counts — the caller's own view, counted
-- ───────────────────────────────────────────────────────────────────────────

-- One row per folder that holds live files, plus one with folder_id null for
-- files in no folder. Security INVOKER: media_assets' RLS applies, so a
-- caller who is not a member of p_org gets no rows at all.
create or replace function public.media_folder_counts(p_org uuid)
  returns table (folder_id uuid, assets bigint)
  language sql stable security invoker set search_path = public, pg_temp as $$
  select m.folder_id, count(*)::bigint
    from public.media_assets m
   where m.org_id = p_org and m.deleted_at is null
   group by m.folder_id
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

alter table public.media_folders enable row level security;

revoke all on public.media_folders from public, anon, authenticated, service_role;
grant select on public.media_folders to authenticated, service_role;

drop policy if exists media_folders_select on public.media_folders;
create policy media_folders_select on public.media_folders
  for select to authenticated
  using (org_id in (select public.accessible_org_ids()));

revoke all on function public.media_assets_folder_guard() from public, anon, authenticated, service_role;
revoke all on function public.media_folder_clean_name(text) from public, anon, authenticated, service_role;
revoke all on function public.save_media_folder(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.delete_media_folder(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.move_media_assets(uuid, uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.media_folder_counts(uuid) from public, anon, authenticated, service_role;

grant execute on function public.save_media_folder(uuid, uuid, text) to authenticated;
grant execute on function public.delete_media_folder(uuid, uuid) to authenticated;
grant execute on function public.move_media_assets(uuid, uuid, uuid[]) to authenticated;
grant execute on function public.media_folder_counts(uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select relrowsecurity from pg_class where oid = 'public.media_folders'::regclass) as rls_on,
--   has_table_privilege('authenticated', 'public.media_folders', 'SELECT')
--     and not has_table_privilege('authenticated', 'public.media_folders', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.media_folders', 'UPDATE')
--     and not has_table_privilege('authenticated', 'public.media_folders', 'DELETE')
--     and not has_table_privilege('authenticated', 'public.media_assets', 'UPDATE')
--     and not has_table_privilege('anon', 'public.media_folders', 'SELECT') as browser_scoped,
--   has_function_privilege('authenticated', 'public.move_media_assets(uuid,uuid,uuid[])', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.save_media_folder(uuid,uuid,text)', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.delete_media_folder(uuid,uuid)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.move_media_assets(uuid,uuid,uuid[])', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.media_folder_counts(uuid)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.media_folder_clean_name(text)', 'EXECUTE')
--     as functions_scoped,
--   exists (select 1 from information_schema.columns
--            where table_schema = 'public' and table_name = 'media_assets'
--              and column_name = 'folder_id') as asset_column,
--   exists (select 1 from pg_trigger
--            where tgname = 'media_assets_folder_guard' and not tgisinternal) as guard_on;
