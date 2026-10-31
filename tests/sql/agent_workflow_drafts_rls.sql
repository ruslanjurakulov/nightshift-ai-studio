-- Disposable, transaction-rolled-back ownership test for migration 0129.
-- RUN ONLY ON AN ISOLATED SUPABASE INSTANCE. Not a production migration.
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
values
  ('a1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'agent-owner-1@invalid.example', '', now(), now()),
  ('b2000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'agent-owner-2@invalid.example', '', now(), now());

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);

do $$
declare
  v_id uuid;
  v_version integer;
  v_count integer;
  v_doc jsonb := '{
    "format":"nightshift.agent-draft",
    "layoutVersion":1,
    "workflow":{"version":1,"name":"Tenant isolation test","nodes":[
      {"id":"brand","type":"brand.input","label":"Brand","config":{}},
      {"id":"prompt","type":"prompt.compose","label":"Prompt","config":{}},
      {"id":"image","type":"image.generate","label":"Image","config":{}},
      {"id":"review","type":"review.approval","label":"Approval","config":{}},
      {"id":"export","type":"asset.export","label":"Export","config":{}}
    ],"edges":[
      {"source":"brand","target":"prompt"},
      {"source":"prompt","target":"image"},
      {"source":"image","target":"review"},
      {"source":"review","target":"export"}
    ]},
    "positions":{}
  }'::jsonb;
begin
  if has_table_privilege('authenticated', 'public.agent_workflow_drafts', 'INSERT')
     or has_table_privilege('authenticated', 'public.agent_workflow_draft_versions', 'UPDATE') then
    raise exception 'TEST FAIL: authenticated has table-write privileges';
  end if;

  select saved_id, saved_version into v_id, v_version
    from public.save_agent_workflow_draft(null, null, v_doc);
  if v_id is null or v_version <> 1 then raise exception 'TEST FAIL: first save'; end if;

  select saved_version into v_version
    from public.save_agent_workflow_draft(v_id, 1, v_doc);
  if v_version <> 2 then raise exception 'TEST FAIL: second save'; end if;

  begin
    perform public.save_agent_workflow_draft(v_id, 1, v_doc);
    raise exception 'TEST FAIL: stale version unexpectedly accepted';
  exception when serialization_failure then null;
  end;

  begin
    perform public.save_agent_workflow_draft(v_id, 2,
      jsonb_set(v_doc, '{workflow,nodes,2,config}', '{"apiKey":"forbidden"}'::jsonb));
    raise exception 'TEST FAIL: direct RPC accepted provider config';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.save_agent_workflow_draft(v_id, 2,
      jsonb_set(v_doc, '{workflow,nodes,2,type}', '"shell.execute"'::jsonb));
    raise exception 'TEST FAIL: direct RPC accepted unknown node type';
  exception when invalid_parameter_value then null;
  end;

  perform set_config('request.jwt.claim.sub', 'b2000000-0000-4000-8000-000000000002', true);
  select count(*) into v_count from public.agent_workflow_drafts where id = v_id;
  if v_count <> 0 then raise exception 'TEST FAIL: another owner can SELECT the draft'; end if;
  select count(*) into v_count from public.agent_workflow_draft_versions where draft_id = v_id;
  if v_count <> 0 then raise exception 'TEST FAIL: another owner can SELECT versions'; end if;
  begin
    perform public.save_agent_workflow_draft(v_id, 2, v_doc);
    raise exception 'TEST FAIL: another owner can overwrite a draft';
  exception when no_data_found then null;
  end;

  perform set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
  select count(*) into v_count from public.agent_workflow_draft_versions where draft_id = v_id;
  if v_count <> 2 then raise exception 'TEST FAIL: own revision history not available'; end if;
  raise notice 'TEST PASS: user isolation, immutable versions, optimistic locking and no table writes';
end $$;

rollback;
