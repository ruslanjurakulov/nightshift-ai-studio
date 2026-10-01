-- 0054_editor_projects.sql — the video editor's projects and their exports:
-- the free tools (trim, split, speed, text on the picture) stored as data,
-- rendered by the existing ffmpeg engine (modules/timeline_render.py).
--
-- WHAT IT ADDS
--   editor_projects          one edit of one organization: a title and a
--                            timeline document (schemas/timeline.schema.json,
--                            at most 256 KB) with a revision number that goes
--                            up by one on every save. Soft-deleted.
--   editor_exports           a request to render one SAVED revision of a
--                            project: a copy of that document, its length,
--                            and where the worker got to (queued → rendering
--                            → done | failed). A finished export is a library
--                            file (media_assets, source 'render').
--   create_editor_project(org, title, doc)
--   save_editor_project(project, base_rev, title, doc)
--                            optimistic concurrency: a save based on an older
--                            revision is refused (stale_revision) instead of
--                            silently overwriting someone's newer edit.
--   delete_editor_project(project)
--                            hides it; an export still waiting is failed
--                            (project_deleted). Files already exported stay
--                            in the library.
--   request_editor_export(project, rev)
--                            queue a render of the CURRENT saved revision.
--   claim_editor_export / editor_export_heartbeat / editor_export_assets /
--   finish_editor_export     the media worker's side (service role only).
--
-- FREE, AND BOUNDED INSTEAD OF PRICED
--   Editing and exporting cost no credits: nothing here holds, charges or
--   refunds anything, and no provider is called — the render is ffmpeg on our
--   own worker. What keeps one organization from tying the worker up is a
--   set of limits, enforced here under a per-organization lock:
--     * an export is at most 30 minutes long          (too_long)
--     * one export at a time per project               (export_in_progress)
--     * three waiting or rendering per organization    (export_in_progress)
--     * twenty requested per organization per 24 hours (daily_limit)
--     * two hundred live projects per organization     (limit_reached)
--
-- NOTHING HERE PUBLISHES
--   An export becomes a file in the organization's library and nothing else.
--   Publishing stays where it was: the publish gate and publish_requests,
--   unchanged.
--
-- A DOCUMENT ONLY EVER NAMES ITS OWN ORGANIZATION'S FILES
--   Every asset_id anywhere in a document must be a live image, video or
--   audio file of the project's organization, checked on create, on every
--   save and again on export (a file deleted since is refused then). An id of
--   another organization's file is refused exactly like a made-up one
--   (invalid_asset). The worker asks again for the export it holds
--   (editor_export_assets: the export's organization, live files only) and
--   reads files by id from the media volume, so a document can never point
--   the renderer at a path. Whether the document RENDERS (times inside each
--   clip, speed 0.5–2, text length, no overlaps) is checked by the
--   Command Center before it saves and by modules/timeline.py before the
--   worker renders — the same rules, written twice, pinned by tests.
--
-- WHO MAY DO WHAT (authenticated = a signed-in browser via the anon key)
--   editor_projects,
--   editor_exports           select: members of the org · insert / update /
--                            delete: nobody directly — the functions
--   create / save / delete / request_editor_export
--                            authenticated; each checks membership of the
--                            org itself. Another org's project reads as not
--                            found; another org reads as forbidden, like a
--                            made-up one.
--   claim / heartbeat / assets / finish
--                            service role only (the media worker).
--   anon gets nothing.
--
-- ERRORS (SQLSTATE; the message is the machine word the app maps,
-- command-center/lib/editor.ts mapEditorError):
--   42501 forbidden
--   P0002 not_found
--   NS400 invalid_title | invalid_doc | doc_too_large | invalid_asset |
--         empty | too_long
--   NS409 stale_revision | export_in_progress
--   NS429 limit_reached | daily_limit
--
-- REQUIRES 0018 (organizations), 0020 (credits_trusted_caller) and 0038
-- (media_assets). Additive and idempotent: guarded creates, drop-then-create
-- policies, create-or-replace functions. Nothing existing is changed.

do $$
begin
  if to_regprocedure('public.accessible_org_ids(text)') is null
     or to_regprocedure('public.is_org_member(uuid, text)') is null then
    raise exception '0054 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regprocedure('public.credits_trusted_caller()') is null then
    raise exception '0054 needs credits_trusted_caller(): apply 0020_credits.sql first';
  end if;
  if to_regclass('public.media_assets') is null then
    raise exception '0054 needs the media library: apply 0038_media_assets.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.editor_projects (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  title      text not null check (char_length(title) between 1 and 120
                                  and title !~ '[[:cntrl:]]' and title = btrim(title)),
  doc        jsonb not null check (jsonb_typeof(doc) = 'object' and pg_column_size(doc) <= 262144),
  rev        integer not null default 1 check (rev >= 1),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists editor_projects_org_idx
  on public.editor_projects (org_id, updated_at desc) where deleted_at is null;

comment on table public.editor_projects is
  'Video editor projects (migration 0054): a title and a timeline document (schemas/timeline.schema.json) of one organization. Written only by create_editor_project / save_editor_project / delete_editor_project; members read.';

create table if not exists public.editor_exports (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  project_id   uuid not null references public.editor_projects (id) on delete cascade,
  rev          integer not null check (rev >= 1),
  -- The revision as it was when the export was asked for: a later save does
  -- not change what is being rendered.
  doc          jsonb not null check (jsonb_typeof(doc) = 'object' and pg_column_size(doc) <= 262144),
  duration_s   numeric(10,3) not null check (duration_s > 0 and duration_s <= 1800),
  status       text not null default 'queued'
               check (status in ('queued', 'rendering', 'done', 'failed')),
  reason       text check (reason is null or reason ~ '^[a-z0-9_]{1,64}$'),
  asset_id     uuid references public.media_assets (id) on delete set null,
  attempts     integer not null default 0,
  worker_id    text,
  heartbeat_at timestamptz,
  requested_by uuid not null,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  updated_at   timestamptz not null default now(),
  constraint editor_exports_done_has_file check (status <> 'done' or asset_id is not null)
);

create index if not exists editor_exports_project_idx on public.editor_exports (project_id, created_at desc);
create index if not exists editor_exports_org_idx on public.editor_exports (org_id, created_at desc);
create index if not exists editor_exports_queue_idx
  on public.editor_exports (status, created_at) where status in ('queued', 'rendering');

comment on table public.editor_exports is
  'Renders of a saved editor project revision (migration 0054). Free: no credits are held or charged. Created only by request_editor_export(); the media worker renders with the ffmpeg engine and the result is a library file (media_assets, source render). Never publishes.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Internal helpers (not callable through the API)
-- ───────────────────────────────────────────────────────────────────────────

-- A title a person typed, made storable: runs of white space folded to one
-- space, control characters removed, trimmed.
create or replace function public.editor_clean_title(p_title text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select btrim(regexp_replace(regexp_replace(coalesce(p_title, ''), '[[:space:]]+', ' ', 'g'),
                              '[[:cntrl:]]', '', 'g'))
$$;

-- Why p_doc may not be stored for p_org, as a machine word, or null when it
-- may. Checks the shape the database relies on and — the point — that every
-- asset_id ANYWHERE in it is a live image / video / audio file of p_org.
-- An id of another organization's file and a made-up id get the same word.
create or replace function public.editor_doc_problem(p_org uuid, p_doc jsonb) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  ids  text[];
  uniq integer;
  live integer;
begin
  if p_doc is null or jsonb_typeof(p_doc) <> 'object' then
    return 'invalid_doc';
  end if;
  if pg_column_size(p_doc) > 262144 then
    return 'doc_too_large';
  end if;
  if p_doc -> 'version' is distinct from '1'::jsonb
     or jsonb_typeof(p_doc -> 'tracks') is distinct from 'array'
     or jsonb_array_length(p_doc -> 'tracks') > 32 then
    return 'invalid_doc';
  end if;
  if exists (select 1 from jsonb_array_elements(p_doc -> 'tracks') t
              where jsonb_typeof(t) <> 'object' or jsonb_typeof(t -> 'clips') is distinct from 'array') then
    return 'invalid_doc';
  end if;

  -- Every asset_id at any depth, not only where a clip should have one: a
  -- field the renderer does not know is refused there, but the database
  -- does not rely on that to keep another organization's file out.
  select coalesce(array_agg(v #>> '{}'), '{}') into ids
    from jsonb_path_query(p_doc, 'lax $.**.asset_id') v;
  if exists (select 1 from unnest(ids) i
              where i is null or i !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    return 'invalid_asset';
  end if;
  select count(distinct lower(i)) into uniq from unnest(ids) i;
  if uniq > 0 then
    select count(*) into live from public.media_assets m
     where m.id in (select distinct lower(i)::uuid from unnest(ids) i)
       and m.org_id = p_org and m.deleted_at is null and m.kind in ('video', 'image', 'audio');
    if live <> uniq then
      return 'invalid_asset';
    end if;
  end if;
  return null;
end
$$;

-- How long a document plays, in seconds: where its last clip, text or
-- caption ends (a media clip lasts (out_s - in_s) / speed). Null when a time
-- is not a number — the renderer would refuse that document anyway.
create or replace function public.editor_doc_duration(p_doc jsonb) returns numeric
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  total numeric;
begin
  select max(e) into total from (
    select case
             when c ? 'end_s' then (c ->> 'end_s')::numeric
             else (c ->> 'start_s')::numeric
                  + ((c ->> 'out_s')::numeric - (c ->> 'in_s')::numeric)
                    / coalesce((c ->> 'speed')::numeric, 1)
           end as e
      from jsonb_array_elements(p_doc -> 'tracks') t,
           jsonb_array_elements(t -> 'clips') c
    union all
    select (q ->> 'end_s')::numeric
      from jsonb_array_elements(coalesce(p_doc #> '{captions,cues}', '[]'::jsonb)) q
  ) x;
  return total;
exception when others then
  return null;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Projects
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.create_editor_project(p_org uuid, p_title text, p_doc jsonb) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  title_  text := public.editor_clean_title(p_title);
  problem text;
  p       public.editor_projects;
begin
  if auth.uid() is null or p_org is null or not public.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if char_length(title_) not between 1 and 120 then
    raise exception 'invalid_title' using errcode = 'NS400', detail = 'max=120';
  end if;
  problem := public.editor_doc_problem(p_org, p_doc);
  if problem is not null then
    raise exception '%', problem using errcode = 'NS400';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('editor_projects:' || p_org::text, 0));
  if (select count(*) from public.editor_projects where org_id = p_org and deleted_at is null) >= 200 then
    raise exception 'limit_reached' using errcode = 'NS429', detail = 'max=200';
  end if;

  insert into public.editor_projects (org_id, title, doc, created_by)
  values (p_org, title_, p_doc, auth.uid())
  returning * into p;
  return p.id;
end
$$;

-- Save a new revision. p_base_rev is the revision the edit started from; any
-- other current revision means someone saved in between, and this save is
-- refused rather than quietly undoing theirs. A null title or doc keeps the
-- current one. Returns the new revision number.
create or replace function public.save_editor_project(p_project uuid, p_base_rev integer, p_title text, p_doc jsonb)
  returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  p       public.editor_projects;
  title_  text;
  problem text;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into p from public.editor_projects where id = p_project for update;
  -- Another organization's project reads as missing, never as "forbidden".
  if not found or p.deleted_at is not null or not public.is_org_member(p.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_base_rev is null or p_base_rev <> p.rev then
    raise exception 'stale_revision' using errcode = 'NS409', detail = format('current=%s', p.rev);
  end if;
  title_ := case when p_title is null then p.title else public.editor_clean_title(p_title) end;
  if char_length(title_) not between 1 and 120 then
    raise exception 'invalid_title' using errcode = 'NS400', detail = 'max=120';
  end if;
  if p_doc is not null then
    problem := public.editor_doc_problem(p.org_id, p_doc);
    if problem is not null then
      raise exception '%', problem using errcode = 'NS400';
    end if;
  end if;
  update public.editor_projects
     set title = title_, doc = coalesce(p_doc, doc), rev = rev + 1, updated_at = now()
   where id = p.id
  returning * into p;
  return p.rev;
end
$$;

create or replace function public.delete_editor_project(p_project uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  p public.editor_projects;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into p from public.editor_projects where id = p_project for update;
  if not found or p.deleted_at is not null or not public.is_org_member(p.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  update public.editor_projects set deleted_at = now(), updated_at = now() where id = p.id;
  -- Nobody is waiting for these any more. One the worker already holds is
  -- left to finish: its file lands in the library like any other.
  update public.editor_exports
     set status = 'failed', reason = 'project_deleted', finished_at = now(), updated_at = now()
   where project_id = p.id and status = 'queued';
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Exports
-- ───────────────────────────────────────────────────────────────────────────

-- Queue a render of revision p_rev, which must be the project's current one
-- (the editor saves first; an export of something the person is no longer
-- looking at would be a surprise). Free: no credit is touched.
create or replace function public.request_editor_export(p_project uuid, p_rev integer) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  p       public.editor_projects;
  problem text;
  total   numeric;
  e       public.editor_exports;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into p from public.editor_projects where id = p_project for update;
  if not found or p.deleted_at is not null or not public.is_org_member(p.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_rev is null or p_rev <> p.rev then
    raise exception 'stale_revision' using errcode = 'NS409', detail = format('current=%s', p.rev);
  end if;
  -- Again now: a file used by the project may have been deleted since it was saved.
  problem := public.editor_doc_problem(p.org_id, p.doc);
  if problem is not null then
    raise exception '%', problem using errcode = 'NS400';
  end if;
  total := public.editor_doc_duration(p.doc);
  if total is null then
    raise exception 'invalid_doc' using errcode = 'NS400';
  end if;
  if total <= 0 then
    raise exception 'empty' using errcode = 'NS400';
  end if;
  if total > 1800 then
    raise exception 'too_long' using errcode = 'NS400', detail = 'max_s=1800';
  end if;

  -- One request per organization at a time: the limits hold under parallel clicks.
  perform pg_advisory_xact_lock(hashtextextended('editor_exports:' || p.org_id::text, 0));
  if exists (select 1 from public.editor_exports
              where project_id = p.id and status in ('queued', 'rendering')) then
    raise exception 'export_in_progress' using errcode = 'NS409';
  end if;
  if (select count(*) from public.editor_exports
       where org_id = p.org_id and status in ('queued', 'rendering')) >= 3 then
    raise exception 'export_in_progress' using errcode = 'NS409', detail = 'max_active=3';
  end if;
  if (select count(*) from public.editor_exports
       where org_id = p.org_id and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'daily_limit' using errcode = 'NS429', detail = 'max=20';
  end if;

  insert into public.editor_exports (org_id, project_id, rev, doc, duration_s, requested_by)
  values (p.org_id, p.id, p.rev, p.doc, round(total, 3), auth.uid())
  returning * into e;
  return e.id;
end
$$;

-- The worker takes the oldest waiting export. A render whose worker stopped
-- beating for 15 minutes is handed out again, at most three times in all.
create or replace function public.claim_editor_export(p_worker text)
  returns setof public.editor_exports
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not public.credits_trusted_caller() then
    raise exception 'exports are rendered by the platform''s worker only' using errcode = '42501';
  end if;
  update public.editor_exports
     set status = case when attempts >= 3 then 'failed' else 'queued' end,
         reason = case when attempts >= 3 then 'worker_lost' else reason end,
         finished_at = case when attempts >= 3 then now() else finished_at end,
         worker_id = null, updated_at = now()
   where status = 'rendering' and heartbeat_at < now() - interval '15 minutes';
  return query
    update public.editor_exports e
       set status = 'rendering', worker_id = left(p_worker, 120), heartbeat_at = now(),
           attempts = e.attempts + 1, started_at = coalesce(e.started_at, now()), updated_at = now()
     where e.id = (select x.id from public.editor_exports x
                    where x.status = 'queued'
                    order by x.created_at
                    for update skip locked
                    limit 1)
    returning e.*;
end
$$;

create or replace function public.editor_export_heartbeat(p_export uuid, p_worker text) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  n integer;
begin
  if not public.credits_trusted_caller() then
    raise exception 'exports are rendered by the platform''s worker only' using errcode = '42501';
  end if;
  update public.editor_exports set heartbeat_at = now(), updated_at = now()
   where id = p_export and status = 'rendering' and worker_id = left(p_worker, 120);
  get diagnostics n = row_count;
  return n = 1;
end
$$;

-- The files an export may read: live files of the EXPORT's organization that
-- its document names. The worker builds file paths from these ids alone.
create or replace function public.editor_export_assets(p_export uuid)
  returns table (id uuid, kind text, mime text, duration_s numeric, variants text[])
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  e public.editor_exports;
begin
  if not public.credits_trusted_caller() then
    raise exception 'exports are rendered by the platform''s worker only' using errcode = '42501';
  end if;
  select * into e from public.editor_exports x where x.id = p_export;
  if not found then
    return;
  end if;
  return query
    select m.id, m.kind, m.mime, m.duration_s, m.variants
      from public.media_assets m
     where m.org_id = e.org_id and m.deleted_at is null
       and m.kind in ('video', 'image', 'audio')
       and m.id::text in (select lower(v #>> '{}') from jsonb_path_query(e.doc, 'lax $.**.asset_id') v
                           where (v #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
end
$$;

-- Done (p_asset: the rendered file, registered with source 'render' in the
-- export's organization) or failed (p_reason: a machine word). Only the
-- worker holding the export may finish it; finishing twice is a no-op that
-- returns the status it already has.
create or replace function public.finish_editor_export(p_export uuid, p_worker text, p_asset uuid, p_reason text)
  returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  e public.editor_exports;
begin
  if not public.credits_trusted_caller() then
    raise exception 'exports are rendered by the platform''s worker only' using errcode = '42501';
  end if;
  select * into e from public.editor_exports where id = p_export for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if e.status in ('done', 'failed') then
    return e.status;
  end if;
  if e.status <> 'rendering' or e.worker_id is distinct from left(p_worker, 120) then
    raise exception 'not_yours' using errcode = '55000';
  end if;
  if p_asset is not null then
    if not exists (select 1 from public.media_assets m
                    where m.id = p_asset and m.org_id = e.org_id and m.source = 'render'
                      and m.deleted_at is null) then
      raise exception 'invalid_asset' using errcode = '42501';
    end if;
    update public.editor_exports
       set status = 'done', asset_id = p_asset, reason = null, finished_at = now(), updated_at = now()
     where id = e.id;
    return 'done';
  end if;
  update public.editor_exports
     set status = 'failed',
         reason = case when p_reason ~ '^[a-z0-9_]{1,64}$' then p_reason else 'render_failed' end,
         finished_at = now(), updated_at = now()
   where id = e.id;
  return 'failed';
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

alter table public.editor_projects enable row level security;
alter table public.editor_exports enable row level security;

revoke all on public.editor_projects from public, anon, authenticated, service_role;
revoke all on public.editor_exports from public, anon, authenticated, service_role;
grant select on public.editor_projects to authenticated, service_role;
grant select on public.editor_exports to authenticated, service_role;

drop policy if exists editor_projects_select on public.editor_projects;
create policy editor_projects_select on public.editor_projects
  for select to authenticated
  using (org_id in (select public.accessible_org_ids()) and deleted_at is null);

drop policy if exists editor_exports_select on public.editor_exports;
create policy editor_exports_select on public.editor_exports
  for select to authenticated
  using (org_id in (select public.accessible_org_ids()));

revoke all on function public.editor_clean_title(text) from public, anon, authenticated, service_role;
revoke all on function public.editor_doc_problem(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.editor_doc_duration(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.create_editor_project(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.save_editor_project(uuid, integer, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.delete_editor_project(uuid) from public, anon, authenticated, service_role;
revoke all on function public.request_editor_export(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.claim_editor_export(text) from public, anon, authenticated, service_role;
revoke all on function public.editor_export_heartbeat(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.editor_export_assets(uuid) from public, anon, authenticated, service_role;
revoke all on function public.finish_editor_export(uuid, text, uuid, text) from public, anon, authenticated, service_role;

grant execute on function public.create_editor_project(uuid, text, jsonb) to authenticated;
grant execute on function public.save_editor_project(uuid, integer, text, jsonb) to authenticated;
grant execute on function public.delete_editor_project(uuid) to authenticated;
grant execute on function public.request_editor_export(uuid, integer) to authenticated;
grant execute on function public.claim_editor_export(text) to service_role;
grant execute on function public.editor_export_heartbeat(uuid, text) to service_role;
grant execute on function public.editor_export_assets(uuid) to service_role;
grant execute on function public.finish_editor_export(uuid, text, uuid, text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select bool_and(relrowsecurity) from pg_class
--     where oid in ('public.editor_projects'::regclass, 'public.editor_exports'::regclass)) as rls_on,
--   has_table_privilege('authenticated', 'public.editor_projects', 'SELECT')
--     and not has_table_privilege('authenticated', 'public.editor_projects', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.editor_projects', 'UPDATE')
--     and not has_table_privilege('authenticated', 'public.editor_projects', 'DELETE')
--     and not has_table_privilege('authenticated', 'public.editor_exports', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.editor_exports', 'UPDATE')
--     and not has_table_privilege('anon', 'public.editor_projects', 'SELECT')
--     and not has_table_privilege('anon', 'public.editor_exports', 'SELECT') as browser_scoped,
--   has_function_privilege('authenticated', 'public.save_editor_project(uuid,integer,text,jsonb)', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.request_editor_export(uuid,integer)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.create_editor_project(uuid,text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.claim_editor_export(text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.finish_editor_export(uuid,text,uuid,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.editor_export_assets(uuid)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.editor_doc_problem(uuid,jsonb)', 'EXECUTE')
--     and has_function_privilege('service_role', 'public.claim_editor_export(text)', 'EXECUTE')
--     as functions_scoped;
