-- 0130_agent_workflow_drafts.sql — private, versioned storage for Agent Builder plans (docs/product/AGENT_NODE_BUILDER.md, Phase 2A).
-- INERT: a stored plan is data only. Nothing here runs a model, calls a provider, holds or charges a credit, or publishes anything.
-- Separate from 0073 public.workflows (which has its own billing and execution contract): no table, function or policy of 0073 is touched.
--
-- WHAT IT ADDS
--   agent_workflow_drafts           one row per plan: owner (auth.users), name, current_version. ONE PERSON's rows: not the organization's,
--                                   not the operator's. Signed-in users may SELECT their own rows (RLS: owner_id = auth.uid()); no API role
--                                   may INSERT, UPDATE, DELETE or TRUNCATE (the grants are revoked from anon, authenticated AND service_role:
--                                   Supabase's default privileges hand every new table to service_role).
--   agent_workflow_draft_versions   the saved documents, immutable once written, at most 30 kept per plan (the oldest is pruned by the save
--                                   that would make it 31). Same read rule, same revoked writes. A CHECK caps a stored document at 150000 bytes.
--   save_agent_workflow_draft(id, expected_version, document)
--                                   SECURITY DEFINER, search_path ''. The ONLY write path. Checks, in order: sign-in (not_authenticated,
--                                   42501) → the document (below; 22023 with the function's own message) → for a new plan (id null): the
--                                   expected version is null or 0 (version_conflict, 40001), and under a per-person advisory lock, fewer than
--                                   50 plans (agent_draft_limit, 22023) → for an existing plan: it is the caller's (draft_not_found, P0002:
--                                   another person's id reads exactly like a made-up one), locked FOR UPDATE, and its current version is the
--                                   expected one (version_conflict) → the new version, pruning the oldest stored one past 30.
--   delete_agent_workflow_draft(id) SECURITY DEFINER, search_path ''. The owner removes a plan and every version of it (draft_not_found for
--                                   another person's or a made-up id, not_authenticated without a sign-in).
--   Both functions: EXECUTE for authenticated only (revoked from public, anon and service_role).
--
-- THE DOCUMENT (the same rules as command-center/lib/agent-graph.ts + lib/agent-draft.ts; every guard fails closed: a missing key, a key of
-- the wrong JSON type and an unknown key are all refusals, never a NULL that slips through an OR chain)
--   exactly {format, layoutVersion, workflow, positions}; format "nightshift.agent-draft"; layoutVersion 1; at most 150000 bytes
--     (agent_draft_too_large);
--   workflow exactly {version, name, nodes, edges}; version 1; name a string of 1-120 characters (raw, not trimmed) with a visible character
--     and none of the refused characters below (invalid_agent_draft_name); at most 64 nodes and 128 edges;
--   a node exactly {id, type, label} or {id, type, label, config}; id ^[A-Za-z][A-Za-z0-9_-]{0,63}$, unique; type one of the eight of the
--     registry; label a string like the name, 1-80 characters; config, when present, exactly {} (no provider keys, endpoints or settings
--     before a reviewed config schema exists) (invalid_agent_node);
--   an edge exactly {source, target}, both strings naming nodes, no duplicate, and of an allowed kind (brand/catalog → prompt → image/
--     vector/video → review → export); every export node has an incoming edge, so every path to it passes a review (invalid_agent_edge).
--     A self-edge or a cycle cannot be written: no kind connects to itself and the kinds only go forward;
--   positions: keys are node ids; each value exactly {x, y}, each a JSON integer written as plain digits, x 0-2200, y 0-1600 — compared as
--     text and small integers, so no number, however large or long, reaches a numeric cast (invalid_agent_position).
--   REFUSED CHARACTERS in a name or a label: the class of BR-L-120 (modules/comment_replies.py _STRIP, 0081 inbox_clean_text) plus the line
--     feed: C0 and C1 controls and DEL, soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul and Khmer fillers, Mongolian
--     selectors, zero-width and direction marks and embeddings/overrides/isolates (U+200B-200F, U+2028-202E, U+2060-206F), braille blank,
--     variation selectors FE00-FE0D, BOM, interlinear annotation controls, Egyptian/Bamum/musical format controls and the whole tag block
--     U+E0000-E0FFF. A stored label cannot reorder, hide or colour what is shown next to it.
--
-- RLS. Enabled on both tables, NOT forced: the two functions are SECURITY DEFINER owned by the role that applies this file, which owns the
-- tables and therefore is not subject to their (unforced) policies; with no write grant to any API role, the functions are the only writers.
-- This is the repository's pattern (0054, 0120, ...). On the live project that role is `postgres` (bypassrls), so forcing would change
-- nothing there; it is left off so the file does not depend on that attribute.
--
-- WHILE THE PAGE FLAG IS OFF. NIGHTSHIFT_AGENT_DRAFTS_ENABLED hides the web routes only. Once this file is applied, any signed-in user can
-- call the two functions through PostgREST with the browser key, within the limits above (50 plans, 30 versions each, 150 KB a version).
-- That is the intended exposure: the data is the caller's own and nothing in it executes.
--
-- ORDER AND ROLL-OUT. Needs auth.users (Supabase) and nothing of this repository. The Command Center routes answer 404 until the flag is on,
-- and a route that reaches a database without this file answers 503 (function or table not found). Not idempotent on purpose: a second
-- run stops at the first CREATE TABLE and changes nothing. Undo: docs/sql/rollback_0130_agent_workflow_drafts.sql (owner-applied).
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; every query must return null / 0):
--   select to_regclass('public.agent_workflow_drafts'), to_regclass('public.agent_workflow_draft_versions');
--   select count(*) from pg_proc where pronamespace = 'public'::regnamespace
--     and proname in ('save_agent_workflow_draft', 'delete_agent_workflow_draft');
--   select count(*) from pg_stat_activity where xact_start < now() - interval '1 minute' and state <> 'idle';   -- long transactions
--
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
-- The foreign key to auth.users takes a SHARE ROW EXCLUSIVE lock on auth.users (sign-ups wait behind it): give up after 5 s, changing nothing,
-- rather than queue every sign-up behind a long transaction.
set local lock_timeout = '5s';

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table public.agent_workflow_drafts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  current_version integer not null default 1 check (current_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id)
);

create table public.agent_workflow_draft_versions (
  draft_id uuid not null references public.agent_workflow_drafts(id) on delete cascade,
  version integer not null check (version > 0),
  owner_id uuid not null,
  document jsonb not null constraint agent_workflow_draft_versions_document_shape check (
    jsonb_typeof(document) = 'object' and octet_length(document::text) <= 150000
  ),
  created_at timestamptz not null default now(),
  primary key (draft_id, version),
  foreign key (draft_id, owner_id) references public.agent_workflow_drafts(id, owner_id) on delete cascade
);

create index agent_workflow_drafts_owner_updated_idx
on public.agent_workflow_drafts(owner_id, updated_at desc);

alter table public.agent_workflow_drafts enable row level security;
alter table public.agent_workflow_draft_versions enable row level security;

create policy agent_drafts_owner_read on public.agent_workflow_drafts
for select to authenticated using (owner_id = (select auth.uid()));
create policy agent_versions_owner_read on public.agent_workflow_draft_versions
for select to authenticated using (owner_id = (select auth.uid()));

revoke all on public.agent_workflow_drafts from public, anon, authenticated, service_role;
revoke all on public.agent_workflow_draft_versions from public, anon, authenticated, service_role;
grant select on public.agent_workflow_drafts to authenticated;
grant select on public.agent_workflow_draft_versions to authenticated;

comment on table public.agent_workflow_drafts is 'Agent Builder plans only; no execution, API provider calls, credits or publish.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The save
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.save_agent_workflow_draft(
  p_draft_id uuid,
  p_expected_version integer,
  p_document jsonb
) returns table(saved_id uuid, saved_version integer)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_draft public.agent_workflow_drafts%rowtype;
  v_version integer;
  v_node jsonb;
  v_edge jsonb;
  v_position record;
  v_ids text[] := array[]::text[];
  v_types jsonb := '{}'::jsonb;
  v_edges text[] := array[]::text[];
  v_targets text[] := array[]::text[];
  v_id text;
  v_type text;
  v_label text;
  v_source text;
  v_target text;
  v_from_type text;
  v_to_type text;
  v_xy jsonb;
  -- BR-L-120's class (modules/comment_replies.py _STRIP) plus the line feed: never in a name or a label.
  v_refused constant text := '[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || chr(173) || chr(847) || chr(1564)
    || chr(4447) || chr(4448) || chr(6068) || chr(6069) || chr(6155) || '-' || chr(6159) || chr(8203) || '-' || chr(8207)
    || chr(8232) || '-' || chr(8238) || chr(8288) || '-' || chr(8303) || chr(10240) || chr(12644) || chr(65024) || '-' || chr(65037)
    || chr(65279) || chr(65440) || chr(65520) || '-' || chr(65531) || chr(78896) || '-' || chr(78911) || chr(113824) || '-' || chr(113827)
    || chr(119155) || '-' || chr(119162) || chr(917504) || '-' || chr(921599) || ']';
  -- A name or a label needs one character that is not a space (ASCII or one of the blank-looking spaces).
  v_visible constant text := '[^ ' || chr(160) || chr(5760) || chr(8192) || '-' || chr(8202) || chr(8239) || chr(8287) || chr(12288) || ']';
begin
  if v_user is null then raise exception 'not_authenticated' using errcode = '42501'; end if;

  if p_document is null or jsonb_typeof(p_document) is distinct from 'object' then
    raise exception 'invalid_agent_draft' using errcode = '22023';
  end if;
  if octet_length(p_document::text) > 150000 then
    raise exception 'agent_draft_too_large' using errcode = '22023';
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys(p_document) k)
       is distinct from array['format', 'layoutVersion', 'positions', 'workflow']
     or p_document->'format' is distinct from '"nightshift.agent-draft"'::jsonb
     or p_document->'layoutVersion' is distinct from '1'::jsonb
     or jsonb_typeof(p_document->'workflow') is distinct from 'object'
     or jsonb_typeof(p_document->'positions') is distinct from 'object'
  then raise exception 'invalid_agent_draft' using errcode = '22023'; end if;
  if (select array_agg(k order by k) from jsonb_object_keys(p_document->'workflow') k)
       is distinct from array['edges', 'name', 'nodes', 'version']
     or p_document->'workflow'->'version' is distinct from '1'::jsonb
     or jsonb_typeof(p_document->'workflow'->'nodes') is distinct from 'array'
     or jsonb_typeof(p_document->'workflow'->'edges') is distinct from 'array'
  then raise exception 'invalid_agent_draft' using errcode = '22023'; end if;
  if jsonb_array_length(p_document->'workflow'->'nodes') > 64
     or jsonb_array_length(p_document->'workflow'->'edges') > 128
  then raise exception 'invalid_agent_draft' using errcode = '22023'; end if;

  if jsonb_typeof(p_document->'workflow'->'name') is distinct from 'string'
     or char_length(p_document->'workflow'->>'name') not between 1 and 120
     or (p_document->'workflow'->>'name') ~ v_refused
     or (p_document->'workflow'->>'name') !~ v_visible
  then raise exception 'invalid_agent_draft_name' using errcode = '22023'; end if;

  -- Direct RPC callers cannot bypass the schema and the node registry. Config is deliberately empty.
  for v_node in select value from jsonb_array_elements(p_document->'workflow'->'nodes') loop
    -- Each type is checked before anything reads into it (SQL does not promise to stop an OR at its first true term).
    if jsonb_typeof(v_node) is distinct from 'object' then
      raise exception 'invalid_agent_node' using errcode = '22023';
    end if;
    if (select array_agg(k order by k) from jsonb_object_keys(v_node) k) is distinct from array['id', 'label', 'type']
          and (select array_agg(k order by k) from jsonb_object_keys(v_node) k) is distinct from array['config', 'id', 'label', 'type']
       or jsonb_typeof(v_node->'id') is distinct from 'string'
       or jsonb_typeof(v_node->'label') is distinct from 'string'
       or (v_node ? 'config' and v_node->'config' is distinct from '{}'::jsonb)
    then raise exception 'invalid_agent_node' using errcode = '22023'; end if;
    v_id := v_node->>'id';
    v_type := v_node->>'type';  -- any JSON type: only the text of a string can equal a registry name below
    v_label := v_node->>'label';
    if v_id !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'
       or v_id = any(v_ids)
       or v_type not in (
         'brand.input', 'product.catalog', 'prompt.compose',
         'image.generate', 'vector.generate', 'video.generate',
         'review.approval', 'asset.export'
       )
       or char_length(v_label) not between 1 and 80
       or v_label ~ v_refused
       or v_label !~ v_visible
    then raise exception 'invalid_agent_node' using errcode = '22023'; end if;
    v_ids := array_append(v_ids, v_id);
    v_types := jsonb_set(v_types, array[v_id], to_jsonb(v_type));
  end loop;

  for v_edge in select value from jsonb_array_elements(p_document->'workflow'->'edges') loop
    if jsonb_typeof(v_edge) is distinct from 'object' then
      raise exception 'invalid_agent_edge' using errcode = '22023';
    end if;
    if (select array_agg(k order by k) from jsonb_object_keys(v_edge) k) is distinct from array['source', 'target']
       or jsonb_typeof(v_edge->'source') is distinct from 'string'
       or jsonb_typeof(v_edge->'target') is distinct from 'string'
    then raise exception 'invalid_agent_edge' using errcode = '22023'; end if;
    v_source := v_edge->>'source';
    v_target := v_edge->>'target';
    v_from_type := v_types->>v_source;
    v_to_type := v_types->>v_target;
    -- An unknown end has no type and is refused first (the kind rule alone would be NULL there). No kind below connects to itself and
    -- the kinds only go forward: a self-edge or a cycle cannot pass.
    if v_from_type is null or v_to_type is null
       or (v_source || '>' || v_target) = any(v_edges)
       or not (
           (v_from_type in ('brand.input', 'product.catalog') and v_to_type = 'prompt.compose')
        or (v_from_type = 'prompt.compose' and v_to_type in ('image.generate', 'vector.generate', 'video.generate'))
        or (v_from_type in ('image.generate', 'vector.generate', 'video.generate') and v_to_type = 'review.approval')
        or (v_from_type = 'review.approval' and v_to_type = 'asset.export'))
    then raise exception 'invalid_agent_edge' using errcode = '22023'; end if;
    v_edges := array_append(v_edges, v_source || '>' || v_target);
    v_targets := array_append(v_targets, v_target);
  end loop;
  -- An export with no incoming edge would be an export without a review (lib/agent-graph.ts: every path to it passes one).
  if exists (select 1 from jsonb_each_text(v_types) t where t.value = 'asset.export' and not (t.key = any(v_targets))) then
    raise exception 'invalid_agent_edge' using errcode = '22023';
  end if;

  for v_position in select key, value from jsonb_each(p_document->'positions') loop
    v_xy := v_position.value;
    if not (v_position.key = any(v_ids)) or jsonb_typeof(v_xy) is distinct from 'object' then
      raise exception 'invalid_agent_position' using errcode = '22023';
    end if;
    if (select array_agg(k order by k) from jsonb_object_keys(v_xy) k) is distinct from array['x', 'y']
       or jsonb_typeof(v_xy->'x') is distinct from 'number'
       or jsonb_typeof(v_xy->'y') is distinct from 'number'
       -- Plain digits only (no sign, fraction or exponent), at most four: the cast below cannot overflow.
       or (v_xy->>'x') !~ '^[0-9]{1,4}$'
       or (v_xy->>'y') !~ '^[0-9]{1,4}$'
    then raise exception 'invalid_agent_position' using errcode = '22023'; end if;
    if (v_xy->>'x')::integer > 2200 or (v_xy->>'y')::integer > 1600 then
      raise exception 'invalid_agent_position' using errcode = '22023';
    end if;
  end loop;

  if p_draft_id is null then
    if p_expected_version is not null and p_expected_version <> 0 then
      raise exception 'version_conflict' using errcode = '40001';
    end if;
    -- One person's creates queue here, so two at once cannot both see 49 plans.
    perform pg_advisory_xact_lock(hashtextextended('agent-drafts:' || v_user::text, 0));
    if (select count(*) from public.agent_workflow_drafts where owner_id = v_user) >= 50 then
      raise exception 'agent_draft_limit' using errcode = '22023';
    end if;
    insert into public.agent_workflow_drafts(owner_id, name)
    values (v_user, p_document->'workflow'->>'name') returning * into v_draft;
    v_version := 1;
  else
    select * into v_draft from public.agent_workflow_drafts
    where id = p_draft_id and owner_id = v_user for update;
    if not found then raise exception 'draft_not_found' using errcode = 'P0002'; end if;
    if p_expected_version is distinct from v_draft.current_version then
      raise exception 'version_conflict' using errcode = '40001';
    end if;
    v_version := v_draft.current_version + 1;
    update public.agent_workflow_drafts
    set name = p_document->'workflow'->>'name', current_version = v_version, updated_at = now()
    where id = v_draft.id;
    -- Keep the newest 30: this save is the 30th kept, so everything older than the newest 29 before it goes.
    delete from public.agent_workflow_draft_versions
    where draft_id = v_draft.id and version <= v_version - 30;
  end if;

  insert into public.agent_workflow_draft_versions(draft_id, version, owner_id, document)
  values (v_draft.id, v_version, v_user, p_document);
  return query select v_draft.id, v_version;
end;
$$;

comment on function public.save_agent_workflow_draft(uuid, integer, jsonb) is
  'User-owned atomic draft save with optimistic version check; keeps the newest 30 versions. Does not execute plans.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The delete
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.delete_agent_workflow_draft(p_draft_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  -- The versions go with it (on delete cascade). Another person's id reads exactly like a made-up one.
  delete from public.agent_workflow_drafts where id = p_draft_id and owner_id = v_user;
  if not found then raise exception 'draft_not_found' using errcode = 'P0002'; end if;
end;
$$;

comment on function public.delete_agent_workflow_draft(uuid) is
  'The owner deletes one Agent Builder draft and all of its versions.';

revoke all on function public.save_agent_workflow_draft(uuid, integer, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.delete_agent_workflow_draft(uuid) from public, anon, authenticated, service_role;
grant execute on function public.save_agent_workflow_draft(uuid, integer, jsonb) to authenticated;
grant execute on function public.delete_agent_workflow_draft(uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. End state (raises, and so rolls the whole file back, if anything is not as written above)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  save_fn regprocedure := 'public.save_agent_workflow_draft(uuid, integer, jsonb)'::regprocedure;
  delete_fn regprocedure := 'public.delete_agent_workflow_draft(uuid)'::regprocedure;
  tbl text;
  role_name text;
  priv text;
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
        and proname in ('save_agent_workflow_draft', 'delete_agent_workflow_draft')) <> 2 then
    raise exception '0130 end state: a draft function has an unexpected overload';
  end if;
  if not (has_function_privilege('authenticated', save_fn, 'EXECUTE')
          and not has_function_privilege('anon', save_fn, 'EXECUTE')
          and not has_function_privilege('service_role', save_fn, 'EXECUTE')
          and has_function_privilege('authenticated', delete_fn, 'EXECUTE')
          and not has_function_privilege('anon', delete_fn, 'EXECUTE')
          and not has_function_privilege('service_role', delete_fn, 'EXECUTE')) then
    raise exception '0130 end state: a draft function has the wrong grants';
  end if;
  if exists (select 1 from pg_proc p where p.oid in (save_fn, delete_fn)
              and (not p.prosecdef
                   or p.proacl is null
                   or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""')
                   or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))) then
    raise exception '0130 end state: a draft function is not SECURITY DEFINER, is public or has no empty search_path';
  end if;
  foreach tbl in array array['public.agent_workflow_drafts', 'public.agent_workflow_draft_versions'] loop
    if not (select relrowsecurity from pg_class where oid = tbl::regclass) then
      raise exception '0130 end state: % has no row level security', tbl;
    end if;
    if (select count(*) from pg_policy where polrelid = tbl::regclass) <> 1
       or exists (select 1 from pg_policy where polrelid = tbl::regclass
                    and (polcmd <> 'r' or not polpermissive
                         or polroles <> array['authenticated'::regrole::oid]
                         or pg_get_expr(polqual, polrelid) !~ '^\(owner_id = \( SELECT auth\.uid\(\) AS uid\)\)$')) then
      raise exception '0130 end state: % must have exactly its one owner-only read policy', tbl;
    end if;
    if not has_table_privilege('authenticated', tbl, 'SELECT')
       or has_table_privilege('anon', tbl, 'SELECT')
       or has_table_privilege('service_role', tbl, 'SELECT') then
      raise exception '0130 end state: % is readable by the wrong roles', tbl;
    end if;
    foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
      foreach priv in array array['insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
        if has_table_privilege(role_name, tbl, priv) then
          raise exception '0130 end state: % has % on %', role_name, priv, tbl;
        end if;
      end loop;
    end loop;
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'agent_workflow_draft_versions_document_shape'
                   and conrelid = 'public.agent_workflow_draft_versions'::regclass and contype = 'c' and convalidated) then
    raise exception '0130 end state: the document size check is missing';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   has_function_privilege('authenticated', 'public.save_agent_workflow_draft(uuid,integer,jsonb)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.save_agent_workflow_draft(uuid,integer,jsonb)', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.save_agent_workflow_draft(uuid,integer,jsonb)', 'EXECUTE') as save_scoped,
--   has_function_privilege('authenticated', 'public.delete_agent_workflow_draft(uuid)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.delete_agent_workflow_draft(uuid)', 'EXECUTE') as delete_scoped,
--   not has_table_privilege('authenticated', 'public.agent_workflow_drafts', 'INSERT')
--     and not has_table_privilege('service_role', 'public.agent_workflow_draft_versions', 'SELECT') as tables_read_only,
--   (select relrowsecurity from pg_class where oid = 'public.agent_workflow_drafts'::regclass) as rls_on;
