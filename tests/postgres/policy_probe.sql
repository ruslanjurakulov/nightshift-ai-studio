-- Disposable diagnostic only. The policy is rolled back even on success.
do $probe$
declare
  succeeded boolean := false;
  result_state text;
begin
  if current_user <> 'postgres' or session_user <> 'postgres'
     or (select rolsuper from pg_roles where rolname = current_user) then
    raise exception 'unexpected diagnostic identity';
  end if;
  if exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass
             and polname = 'nightshift_x6_rollback_probe') then
    raise exception 'probe name already exists';
  end if;
  begin
    create policy nightshift_x6_rollback_probe on storage.objects
      for select to authenticated using (false);
    -- Roll back this subtransaction; no probe policy can be committed.
    raise exception using errcode = 'PZ001', message = 'rollback successful probe';
  exception
    when sqlstate 'PZ001' then succeeded := true;
    when others then get stacked diagnostics result_state = returned_sqlstate;
  end;
  raise notice 'X6_POLICY_PROBE %', jsonb_build_object(
    'current_user', current_user, 'session_user', session_user,
    'policy_created', succeeded, 'sqlstate', result_state,
    'policy_absent', not exists (select 1 from pg_policy
      where polrelid = 'storage.objects'::regclass
      and polname = 'nightshift_x6_rollback_probe'),
    'supautils_registered', exists (select 1 from pg_settings
      where name = 'supautils.policy_grants' and context = 'sighup'));
end $probe$;
