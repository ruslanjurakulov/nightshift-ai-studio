-- rollback_0138_operator_customers.sql — takes migration 0138 (the operator's Customers page) out again. OWNER-APPLY: paste into the
-- Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT IS LOST: nothing but the page's numbers. 0138 added three read-only functions and no table, column, row or grant on anything
-- else; the ledger, the accounts, the payments and the jobs they read are untouched by both files. After this, the Customers page
-- says the migration is not applied.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if a function of 0138 is not 0138's body (a later change would be undone).
--   1. Drops the three functions.
--   2. Asserts the end state: none of them is left.

begin;
set local lock_timeout = '5s';

do $$
declare
  h text;
  pair text[];
begin
  foreach pair slice 1 in array array[
      ['public.operator_customer_totals()', '938bff459e8a932a7ffc9d078f0d6137'],
      ['public.operator_customer_daily(integer)', 'e80c9c92cf7a1625f02bc585ed549660'],
      ['public.operator_customer_accounts(text, text, integer, integer)', 'ed07a54a29c3110fcf03531c79c47984']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(pair[1]);
    if h is not null and h <> pair[2] then
      raise exception 'rollback 0138: % is not 0138''s body (md5 %): a later change would be undone; read the live body first', pair[1], h;
    end if;
  end loop;
end $$;

drop function if exists public.operator_customer_totals();
drop function if exists public.operator_customer_daily(integer);
drop function if exists public.operator_customer_accounts(text, text, integer, integer);

do $$
begin
  if to_regprocedure('public.operator_customer_totals()') is not null
     or to_regprocedure('public.operator_customer_daily(integer)') is not null
     or to_regprocedure('public.operator_customer_accounts(text, text, integer, integer)') is not null then
    raise exception 'rollback 0138 end state: a function of 0138 is still there';
  end if;
end $$;

commit;
