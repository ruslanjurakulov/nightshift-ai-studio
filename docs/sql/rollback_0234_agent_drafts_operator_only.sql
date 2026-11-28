-- rollback_0234_agent_drafts_operator_only.sql — takes migration 0234 (operators only for the Agent Builder draft functions) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor, as one transaction. Nothing in the app runs it. Idempotent.
--
-- WHAT COMES BACK: 0130's save_agent_workflow_draft and delete_agent_workflow_draft, verbatim (md5 c5175b042a9118080b0d4f12906c202d
--   and 7b72f3679d8e9de439d753738f8b66bc with comments cut and white space folded, 0234's fingerprint; 7fe9d1359748e6e311f95678843a6b2e
--   and ef7540b121198f0b79cde9f8975a5c95 folded only, as rollback_0130 pins them). Any signed-in person may then save and delete their
--   own drafts through PostgREST with the browser key again, whatever the web gate says (the finding 0234 closed is open again). The
--   Command Center's routes keep refusing non-operators (requireOperator) either way.
-- WHAT IS KEPT: the grants (EXECUTE for authenticated only: neither file changes them), the tables, their policies and every draft.
-- WHAT IT DOES: 0. REFUSES (changes nothing) if either function is neither 0234's body nor 0130's (a later file changed it: take that
--   out first). 1. Puts 0130's bodies back. 2. Asserts the end state.
-- No backslash anywhere in this file (0219's header): comments are cut with chr(10) / chr(13), white space folded with [[:space:]]+.

begin;
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p
   where p.oid = to_regprocedure('public.save_agent_workflow_draft(uuid, integer, jsonb)');
  if h is null or h <> all (array['a95607774a410e65ccdefb1989557946', 'c5175b042a9118080b0d4f12906c202d']) then
    raise exception 'rollback 0234: save_agent_workflow_draft() is neither 0234''s body nor 0130''s (md5 %): read it first', h;
  end if;
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p
   where p.oid = to_regprocedure('public.delete_agent_workflow_draft(uuid)');
  if h is null or h <> all (array['5a506ee8e5b1fd93419b2fce831e3093', '7b72f3679d8e9de439d753738f8b66bc']) then
    raise exception 'rollback 0234: delete_agent_workflow_draft() is neither 0234''s body nor 0130''s (md5 %): read it first', h;
  end if;
end $$;

-- 0130's save.
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

-- 0130's delete.
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

-- 0130's grants, as they were (create or replace keeps them; said again so the end state below is this file's own).
revoke all on function public.save_agent_workflow_draft(uuid, integer, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.delete_agent_workflow_draft(uuid) from public, anon, authenticated, service_role;
grant execute on function public.save_agent_workflow_draft(uuid, integer, jsonb) to authenticated;
grant execute on function public.delete_agent_workflow_draft(uuid) to authenticated;

do $$
declare
  save_fn regprocedure := 'public.save_agent_workflow_draft(uuid, integer, jsonb)'::regprocedure;
  delete_fn regprocedure := 'public.delete_agent_workflow_draft(uuid)'::regprocedure;
begin
  if (select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) from pg_proc p where p.oid = save_fn) is distinct from 'c5175b042a9118080b0d4f12906c202d' then
    raise exception 'rollback 0234 end state: save_agent_workflow_draft() is not 0130''s body';
  end if;
  if (select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) from pg_proc p where p.oid = delete_fn) is distinct from '7b72f3679d8e9de439d753738f8b66bc' then
    raise exception 'rollback 0234 end state: delete_agent_workflow_draft() is not 0130''s body';
  end if;
  if not (has_function_privilege('authenticated', save_fn, 'EXECUTE')
          and not has_function_privilege('anon', save_fn, 'EXECUTE')
          and not has_function_privilege('service_role', save_fn, 'EXECUTE')
          and has_function_privilege('authenticated', delete_fn, 'EXECUTE')
          and not has_function_privilege('anon', delete_fn, 'EXECUTE')
          and not has_function_privilege('service_role', delete_fn, 'EXECUTE')) then
    raise exception 'rollback 0234 end state: a draft function has the wrong grants (0130: EXECUTE for authenticated only)';
  end if;
  -- The same shape checks 0234's own end state makes: the DDL above sets them, these catch a hand-edited copy.
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
        and proname in ('save_agent_workflow_draft', 'delete_agent_workflow_draft')) <> 2 then
    raise exception 'rollback 0234 end state: a draft function has an unexpected overload';
  end if;
  if exists (select 1 from pg_proc p where p.oid in (save_fn, delete_fn)
              and (not p.prosecdef
                   or p.proacl is null
                   or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""')
                   or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))) then
    raise exception 'rollback 0234 end state: a draft function is not SECURITY DEFINER, is public or has no empty search_path';
  end if;
end $$;

commit;
