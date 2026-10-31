-- Nightshift Agent Builder draft persistence. INERT: no model execution or publishing.
-- Separate from 0073 public.workflows (which has its own billing/execution contract).
-- Owner-scoped immutable revisions; changes only through one atomic RPC.
begin;

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
  document jsonb not null check (
    jsonb_typeof(document) = 'object' and octet_length(document::text) <= 150000
  ),
  created_at timestamptz not null default now(),
  primary key (draft_id, version),
  foreign key (draft_id, owner_id) references public.agent_workflow_drafts(id, owner_id) on delete cascade
);

create index agent_workflow_drafts_owner_updated_idx
on public.agent_workflow_drafts(owner_id, updated_at desc);

alter table public.agent_workflow_drafts enable row level security;
alter table public.agent_workflow_drafts force row level security;
alter table public.agent_workflow_draft_versions enable row level security;
alter table public.agent_workflow_draft_versions force row level security;

create policy agent_drafts_owner_read on public.agent_workflow_drafts
for select to authenticated using (owner_id = (select auth.uid()));
create policy agent_versions_owner_read on public.agent_workflow_draft_versions
for select to authenticated using (owner_id = (select auth.uid()));

revoke all on public.agent_workflow_drafts from public, anon, authenticated;
revoke all on public.agent_workflow_draft_versions from public, anon, authenticated;
grant select on public.agent_workflow_drafts to authenticated;
grant select on public.agent_workflow_draft_versions to authenticated;

-- Privileged RPC is deliberately narrow: all tenant and version checks are
-- performed in one transaction, with deterministic row locks.
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
  v_name text;
  v_version integer;
  v_node jsonb;
  v_edge jsonb;
  v_position record;
  v_ids text[] := array[]::text[];
  v_types jsonb := '{}'::jsonb;
  v_edges text[] := array[]::text[];
  v_id text;
  v_type text;
  v_source text;
  v_target text;
  v_from_type text;
  v_to_type text;
  v_xy jsonb;
begin
  if v_user is null then raise exception 'not_authenticated' using errcode = '42501'; end if;

  if p_document is null or jsonb_typeof(p_document) <> 'object'
     or octet_length(p_document::text) > 150000
     or p_document->>'format' <> 'nightshift.agent-draft'
     or p_document->>'layoutVersion' <> '1'
     or jsonb_typeof(p_document->'workflow') <> 'object'
     or jsonb_typeof(p_document->'positions') <> 'object'
     or (p_document->'workflow'->>'version') <> '1'
     or jsonb_typeof(p_document->'workflow'->'nodes') <> 'array'
     or jsonb_typeof(p_document->'workflow'->'edges') <> 'array'
     or jsonb_array_length(p_document->'workflow'->'nodes') > 64
     or jsonb_array_length(p_document->'workflow'->'edges') > 128
  then raise exception 'invalid_agent_draft' using errcode = '22023'; end if;


  -- Direct RPC callers cannot bypass basic schema and node registry rules.
  -- Runtime execution is not enabled, and config is deliberately empty.
  if p_document - 'format' - 'layoutVersion' - 'workflow' - 'positions' <> '{}'::jsonb
     or p_document->'workflow' - 'version' - 'name' - 'nodes' - 'edges' <> '{}'::jsonb
     or jsonb_array_length(p_document->'workflow'->'nodes') > 64 then
    raise exception 'invalid_agent_draft' using errcode = '22023';
  end if;
  for v_node in select value from jsonb_array_elements(p_document->'workflow'->'nodes') loop
    v_id := v_node->>'id';
    v_type := v_node->>'type';
    if jsonb_typeof(v_node) <> 'object'
       or v_node - 'id' - 'type' - 'label' - 'config' <> '{}'::jsonb
       or v_id is null or v_id !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'
       or v_id = any(v_ids)
       or v_type is null or v_type not in (
         'brand.input', 'product.catalog', 'prompt.compose',
         'image.generate', 'vector.generate', 'video.generate',
         'review.approval', 'asset.export'
       )
       or v_node->>'label' is null
       or jsonb_typeof(v_node->'label') <> 'string'
       or char_length(btrim(v_node->>'label')) not between 1 and 80
       or (v_node ? 'config' and v_node->'config' <> '{}'::jsonb)
    then raise exception 'invalid_agent_node' using errcode = '22023'; end if;
    v_ids := array_append(v_ids, v_id);
    v_types := jsonb_set(v_types, array[v_id], to_jsonb(v_type));
  end loop;
  for v_edge in select value from jsonb_array_elements(p_document->'workflow'->'edges') loop
    v_source := v_edge->>'source';
    v_target := v_edge->>'target';
    v_from_type := v_types->>v_source;
    v_to_type := v_types->>v_target;
    if jsonb_typeof(v_edge) <> 'object'
       or v_edge - 'source' - 'target' <> '{}'::jsonb
       or v_from_type is null or v_to_type is null
       or v_source = v_target
       or (v_source || '>' || v_target) = any(v_edges)
       or not (
           (v_from_type in ('brand.input','product.catalog') and v_to_type = 'prompt.compose')
        or (v_from_type = 'prompt.compose' and v_to_type in ('image.generate','vector.generate','video.generate'))
        or (v_from_type in ('image.generate','vector.generate','video.generate') and v_to_type = 'review.approval')
        or (v_from_type = 'review.approval' and v_to_type = 'asset.export')
       )
    then raise exception 'invalid_agent_edge' using errcode = '22023'; end if;
    v_edges := array_append(v_edges, v_source || '>' || v_target);
  end loop;
  for v_position in select key, value from jsonb_each(p_document->'positions') loop
    v_xy := v_position.value;
    if not (v_position.key = any(v_ids))
       or jsonb_typeof(v_xy) <> 'object'
       or v_xy - 'x' - 'y' <> '{}'::jsonb
       or jsonb_typeof(v_xy->'x') <> 'number'
       or jsonb_typeof(v_xy->'y') <> 'number'
    then raise exception 'invalid_agent_position' using errcode = '22023'; end if;
    if (v_xy->>'x')::numeric not between 0 and 2200
       or (v_xy->>'y')::numeric not between 0 and 1600 then
      raise exception 'invalid_agent_position' using errcode = '22023';
    end if;
  end loop;

  v_name := btrim(p_document->'workflow'->>'name');
  if v_name is null or char_length(v_name) not between 1 and 120 then
    raise exception 'invalid_agent_draft_name' using errcode = '22023';
  end if;

  if p_draft_id is null then
    if p_expected_version is not null and p_expected_version <> 0 then
      raise exception 'version_conflict' using errcode = '40001';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('agent-drafts:' || v_user::text, 0));
    if (select count(*) from public.agent_workflow_drafts where owner_id = v_user) >= 50 then
      raise exception 'agent_draft_limit' using errcode = '22023';
    end if;
    insert into public.agent_workflow_drafts(owner_id, name)
    values (v_user, v_name) returning * into v_draft;
    v_version := 1;
  else
    select * into v_draft from public.agent_workflow_drafts
    where id = p_draft_id and owner_id = v_user for update;
    if not found then raise exception 'draft_not_found' using errcode = 'P0002'; end if;
    if p_expected_version is distinct from v_draft.current_version then
      raise exception 'version_conflict' using errcode = '40001';
    end if;
    if v_draft.current_version >= 30 then
      raise exception 'draft_version_limit' using errcode = '22023';
    end if;
    v_version := v_draft.current_version + 1;
    update public.agent_workflow_drafts
    set name = v_name, current_version = v_version, updated_at = now()
    where id = v_draft.id;
  end if;

  insert into public.agent_workflow_draft_versions(draft_id, version, owner_id, document)
  values (v_draft.id, v_version, v_user, p_document);
  return query select v_draft.id, v_version;
end;
$$;

revoke all on function public.save_agent_workflow_draft(uuid, integer, jsonb) from public, anon;
grant execute on function public.save_agent_workflow_draft(uuid, integer, jsonb) to authenticated;

comment on table public.agent_workflow_drafts is 'Agent Builder plans only; no execution, API provider calls, credits or publish.';
comment on function public.save_agent_workflow_draft(uuid, integer, jsonb) is
  'User-owned atomic draft save with optimistic version check. Does not execute plans.';

commit;
