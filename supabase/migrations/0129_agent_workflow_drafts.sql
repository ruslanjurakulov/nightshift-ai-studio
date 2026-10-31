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
