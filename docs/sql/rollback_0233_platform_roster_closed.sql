-- Owner-applied rollback of 0233_platform_roster_closed.sql.
-- Re-grants exactly what 0233 revoked, as 0107 and the Supabase default privileges had it: EXECUTE on the three roster functions
-- to authenticated (not anon, not public: 0107 never granted those), and INSERT, UPDATE, DELETE on public.app_members to anon and
-- authenticated (RLS stays on; the 0007/0018 policies decide again). Nothing is dropped or replaced, so nothing else is undone.
-- After this a signed-in platform owner or admin can again change the operator's roster from a browser (BR-L-213 reopens).
-- No backslash anywhere in this file.
begin;
set local lock_timeout = '5s';

grant execute on function public.owner_add_member(text, text, text) to authenticated;
grant execute on function public.owner_set_member_role(uuid, text, text) to authenticated;
grant execute on function public.owner_remove_member(uuid, text) to authenticated;
grant insert, update, delete on public.app_members to anon, authenticated;

do $$
begin
  if not has_function_privilege('authenticated', 'public.owner_add_member(text,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.owner_add_member(text,text,text)', 'EXECUTE')
     or not has_table_privilege('authenticated', 'public.app_members', 'INSERT') then
    raise exception 'rollback 0233: the grants are not as 0107 had them';
  end if;
end
$$;

commit;
