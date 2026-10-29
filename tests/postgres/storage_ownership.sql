-- Appended ONLY to the disposable 0003 copy. No persistent objects or grants.
do $diagnostic$
declare evidence jsonb;
begin
  select jsonb_build_object(
    'current_user', current_user, 'session_user', session_user,
    'superuser', (select rolsuper from pg_roles where rolname=current_user),
    'tables', (select jsonb_agg(jsonb_build_object(
      'table', c.relname, 'owner', r.rolname,
      'owner_usage', pg_has_role(current_user,c.relowner,'USAGE'),
      'owner_member', pg_has_role(current_user,c.relowner,'MEMBER')) order by c.relname)
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      join pg_roles r on r.oid=c.relowner
      where n.nspname='storage' and c.relname in ('objects','buckets')),
    'memberships', (select jsonb_agg(jsonb_build_object(
      'member', member.rolname, 'granted', parent.rolname, 'inherit', am.inherit_option))
      from pg_auth_members am join pg_roles member on member.oid=am.member
      join pg_roles parent on parent.oid=am.roleid
      where member.rolname in (current_user,session_user) or parent.rolname like '%storage%')
  ) into evidence;
  raise notice 'X6_EVIDENCE %', evidence;
end $diagnostic$;
