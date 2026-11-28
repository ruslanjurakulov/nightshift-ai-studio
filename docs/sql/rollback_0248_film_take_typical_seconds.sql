-- rollback_0248_film_take_typical_seconds.sql — removes 0248's one function. Owner-applied, one transaction. No backslash.
begin;
set local lock_timeout = '5s';
drop function if exists public.film_take_typical_seconds(uuid);
do $$
begin
  if to_regprocedure('public.film_take_typical_seconds(uuid)') is not null then
    raise exception 'rollback 0248: film_take_typical_seconds is still there';
  end if;
end $$;
commit;
