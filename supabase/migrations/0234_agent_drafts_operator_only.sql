-- 0234_agent_drafts_operator_only.sql — the database half of "the Agent Builder is operators only until launch" (owner decision,
-- 28 Nov; PR #960, which gates the /agent-builder page and its four routes with guardOperatorPage / requireOperator).
--
-- *** LIVE ON APPLY. *** From the moment it commits, a signed-in person who is not a platform owner or admin can no longer save or
--   delete an Agent Builder draft through the database. Nothing is deleted: drafts saved before this file stay, and their owners still
--   read them (0130's owner-only SELECT policies are not touched), but a non-operator can no longer delete them. No customer can reach them through the app either way (the page is
--   a 404 for them and the routes answer 403).
--
-- EVIDENCE. Breach, in the lab (throwaway Postgres 16 with the lab migrations): an authenticated non-admin called
--   save_agent_workflow_draft and delete_agent_workflow_draft (0130) straight through PostgREST with the browser key and was served,
--   whatever NIGHTSHIFT_AGENT_DRAFTS_ENABLED and the page guard said. 0130's header names that exposure as intended ("the data is the
--   caller's own"); the owner's decision changed the intent, so the web gate alone left the database door open.
--   tests/security/test_sec_agent_drafts_operator_only_0234.py keeps the repro (a customer's save and delete are refused).
-- DIAGNOSIS. Both functions check only sign-in. Revoking EXECUTE from authenticated is not the fix: both bind to auth.uid(), and the
--   Command Center's routes call them as the signed-in operator with the browser key, so a revoke would refuse the operator too.
-- CHANGE. Both functions, 0130's bodies verbatim, with one marked check right after 0130's sign-in check: unless
--   public.is_platform_admin() (0018: platform owner or admin, the same function the Command Center's isOperator() asks) is true, the
--   call raises operator_only with SQLSTATE 42501, the code 0130 gives not_authenticated (and 0227 gives operator_required). A NULL
--   answer is no; an error inside the check aborts the call: the check can only refuse, never let a call through.
--   Order of refusals: not_authenticated (no sign-in) -> operator_only -> 0130's document, limit, owner and version checks, unchanged.
--   Not changed: the grants (EXECUTE for authenticated only, exactly 0130's, stated again below and asserted), SECURITY DEFINER with
--   search_path '', the tables, their RLS and policies, the comments on both functions.
-- REPLACES (drift guard: md5 of prosrc with every `--` comment cut to the end of its line, chr(10) or chr(13), and then every run of
--   white space folded to one space, 0230's fingerprint; neither body holds `--` inside a string literal; the pattern is written
--   [-][-] so that no literal in this file holds one):
--   save_agent_workflow_draft(uuid, integer, jsonb)  0130's c5175b042a9118080b0d4f12906c202d -> 0234's a95607774a410e65ccdefb1989557946
--   delete_agent_workflow_draft(uuid)                0130's 7b72f3679d8e9de439d753738f8b66bc -> 0234's 5a506ee8e5b1fd93419b2fce831e3093
--   (Folded only, as docs/sql/rollback_0130_agent_workflow_drafts.sql pins them: save 7fe9d1359748e6e311f95678843a6b2e ->
--   3ec1e1922060eb771bf57be879d5bfb2, delete ef7540b121198f0b79cde9f8975a5c95 -> 2f7e029a513675feeed6aded38622c63. That rollback
--   refuses 0234's bodies: take 0234 out first.) No migration between 0130 and this one replaces either function.
-- IDEMPOTENT. A second run finds 0234's bodies, which the guard accepts, and writes the same bodies again.
-- NUMBER. 0234, assigned by Atlas (0233 is taken). Needs 0130 (the functions) and 0018 (is_platform_admin). Independent of 0230.
-- Rollback: docs/sql/rollback_0234_agent_drafts_operator_only.sql (owner-applied; puts 0130's bodies back and asserts them).

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
-- No backslash anywhere in this file: the live apply path once rewrote backslash escapes inside SQL text (0219's header).
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regprocedure('public.save_agent_workflow_draft(uuid, integer, jsonb)') is null
     or to_regprocedure('public.delete_agent_workflow_draft(uuid)') is null
     or to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0234 needs 0130 (save_agent_workflow_draft, delete_agent_workflow_draft) and 0018 (is_platform_admin): apply them first';
  end if;
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p
   where p.oid = 'public.save_agent_workflow_draft(uuid, integer, jsonb)'::regprocedure;
  if h is null or h <> all (array['c5175b042a9118080b0d4f12906c202d', 'a95607774a410e65ccdefb1989557946']) then
    raise exception '0234 found a save_agent_workflow_draft() that is neither 0130''s body nor 0234''s (md5 %): read the live body first', h;
  end if;
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p
   where p.oid = 'public.delete_agent_workflow_draft(uuid)'::regprocedure;
  if h is null or h <> all (array['7b72f3679d8e9de439d753738f8b66bc', '5a506ee8e5b1fd93419b2fce831e3093']) then
    raise exception '0234 found a delete_agent_workflow_draft() that is neither 0130''s body nor 0234''s (md5 %): read the live body first', h;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The save: 0130's body, with 0234's check after the sign-in check
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
  -- 0234: operators only until launch. is_platform_admin() is the check the Command Center's isOperator() asks; a NULL is no,
  -- and an error in it fails the call, so the check can only refuse.
  if not coalesce(public.is_platform_admin(), false) then raise exception 'operator_only' using errcode = '42501'; end if;

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
       or jsonb_typeof(v_node->'type') is distinct from 'string'
       or (v_node ? 'config' and v_node->'config' is distinct from '{}'::jsonb)
    then raise exception 'invalid_agent_node' using errcode = '22023'; end if;
    v_id := v_node->>'id';
    v_type := v_node->>'type';  -- a string (checked above): a JSON null would make every test on it NULL
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

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The delete: 0130's body, with the same check
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
  -- 0234: operators only until launch. is_platform_admin() is the check the Command Center's isOperator() asks; a NULL is no,
  -- and an error in it fails the call, so the check can only refuse.
  if not coalesce(public.is_platform_admin(), false) then raise exception 'operator_only' using errcode = '42501'; end if;
  -- The versions go with it (on delete cascade). Another person's id reads exactly like a made-up one.
  delete from public.agent_workflow_drafts where id = p_draft_id and owner_id = v_user;
  if not found then raise exception 'draft_not_found' using errcode = 'P0002'; end if;
end;
$$;

-- 0130's grants, stated again (create or replace keeps them; this file restricts the bodies, never who may call).
revoke all on function public.save_agent_workflow_draft(uuid, integer, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.delete_agent_workflow_draft(uuid) from public, anon, authenticated, service_role;
grant execute on function public.save_agent_workflow_draft(uuid, integer, jsonb) to authenticated;
grant execute on function public.delete_agent_workflow_draft(uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. End state (refuses the whole transaction if any of it is not so)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  save_fn regprocedure := 'public.save_agent_workflow_draft(uuid, integer, jsonb)'::regprocedure;
  delete_fn regprocedure := 'public.delete_agent_workflow_draft(uuid)'::regprocedure;
begin
  if (select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) from pg_proc p where p.oid = save_fn) is distinct from 'a95607774a410e65ccdefb1989557946' then
    raise exception '0234 end state: save_agent_workflow_draft() is not 0234''s body';
  end if;
  if (select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) from pg_proc p where p.oid = delete_fn) is distinct from '5a506ee8e5b1fd93419b2fce831e3093' then
    raise exception '0234 end state: delete_agent_workflow_draft() is not 0234''s body';
  end if;
  if exists (select 1 from pg_proc p where p.oid in (save_fn, delete_fn)
              and (position('public.is_platform_admin()' in p.prosrc) = 0 or position('operator_only' in p.prosrc) = 0)) then
    raise exception '0234 end state: a draft function lacks the operator check';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
        and proname in ('save_agent_workflow_draft', 'delete_agent_workflow_draft')) <> 2 then
    raise exception '0234 end state: a draft function has an unexpected overload';
  end if;
  if not (has_function_privilege('authenticated', save_fn, 'EXECUTE')
          and not has_function_privilege('anon', save_fn, 'EXECUTE')
          and not has_function_privilege('service_role', save_fn, 'EXECUTE')
          and has_function_privilege('authenticated', delete_fn, 'EXECUTE')
          and not has_function_privilege('anon', delete_fn, 'EXECUTE')
          and not has_function_privilege('service_role', delete_fn, 'EXECUTE')) then
    raise exception '0234 end state: a draft function has the wrong grants (0130: EXECUTE for authenticated only)';
  end if;
  if exists (select 1 from pg_proc p where p.oid in (save_fn, delete_fn)
              and (not p.prosecdef
                   or p.proacl is null
                   or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""')
                   or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))) then
    raise exception '0234 end state: a draft function is not SECURITY DEFINER, is public or has no empty search_path';
  end if;
end $$;

-- Verify (the SQL editor, after applying; every column should read true):
--   select
--     (select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) from pg_proc p
--        where p.oid = 'public.save_agent_workflow_draft(uuid, integer, jsonb)'::regprocedure) = 'a95607774a410e65ccdefb1989557946' as save_0234,
--     (select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) from pg_proc p
--        where p.oid = 'public.delete_agent_workflow_draft(uuid)'::regprocedure) = '5a506ee8e5b1fd93419b2fce831e3093' as delete_0234,
--     has_function_privilege('authenticated', 'public.save_agent_workflow_draft(uuid,integer,jsonb)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.save_agent_workflow_draft(uuid,integer,jsonb)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.save_agent_workflow_draft(uuid,integer,jsonb)', 'EXECUTE') as save_grants_0130,
--     has_function_privilege('authenticated', 'public.delete_agent_workflow_draft(uuid)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.delete_agent_workflow_draft(uuid)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.delete_agent_workflow_draft(uuid)', 'EXECUTE') as delete_grants_0130;
