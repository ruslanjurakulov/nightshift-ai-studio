-- rollback_0157_dodo_purchase_history.sql — takes migration 0157 (the Credits page's Dodo purchase history) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT IS LOST: nothing stored. 0157 added one read-only function and no table, column, row or grant on anything else. After this,
-- the Credits page's purchase history says it needs migration 0157, and the invoice route answers "not available" without calling
-- Dodo. Buying and crediting are unaffected (they never read it).
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if public.dodo_purchase_history(uuid, text) is not 0157's body (a later change would be undone).
--   1. Drops the function.
--   2. Asserts the end state: it is gone.

begin;
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.dodo_purchase_history(uuid, text)');
  if h is not null and h <> '83396f8724ca4968b7c56f2297aa0830' then
    raise exception 'rollback 0157: public.dodo_purchase_history(uuid, text) is not 0157''s body (md5 %): a later change would be undone; read the live body first', h;
  end if;
end $$;

drop function if exists public.dodo_purchase_history(uuid, text);

do $$
begin
  if to_regprocedure('public.dodo_purchase_history(uuid, text)') is not null then
    raise exception 'rollback 0157 end state: public.dodo_purchase_history(uuid, text) is still there';
  end if;
end $$;

commit;
