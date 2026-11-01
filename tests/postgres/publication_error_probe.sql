-- Reproduce the caught duplicate in 0001 without modifying production SQL.
-- The table is already a member after schema.sql, so this cannot add a member.
do $probe$
declare duplicate_seen boolean := false;
begin
  if current_user <> 'postgres' or session_user <> 'postgres' then
    raise exception 'unexpected diagnostic identity';
  end if;
  if not exists (select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'channels') then
    raise exception 'missing duplicate-publication precondition';
  end if;
  begin
    alter publication supabase_realtime add table public.channels;
    raise exception 'duplicate publication unexpectedly succeeded';
  exception when duplicate_object then duplicate_seen := true;
  end;
  raise notice 'X6_DUPLICATE %', jsonb_build_object('duplicate_seen', duplicate_seen);
end $probe$;
