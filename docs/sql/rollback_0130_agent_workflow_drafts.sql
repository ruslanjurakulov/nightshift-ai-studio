-- rollback_0130_agent_workflow_drafts.sql — takes migration 0130 out again. OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the
-- app runs it.
--
-- WHEN YOU NEED IT. If the Agent Builder's private drafts must go. Turn NIGHTSHIFT_AGENT_DRAFTS_ENABLED off first (the routes then answer 404
-- and never reach the database). The Command Center needs no other change: with the flag on and this applied, a route answers 503.
--
-- READ THIS FIRST. What IS lost: every saved plan and every saved version of it (the two tables are dropped). Nothing else depends on
-- them: no other table, function, policy or worker reads them, and nothing in them was ever executed, billed or published. So the file
-- REFUSES while any plan exists, unless you un-comment the override line under `begin;` (nightshift.rollback_0130_discard_drafts), in this
-- same paste, on purpose.
--
-- WHAT IT DOES, in one transaction, holding an ACCESS EXCLUSIVE lock on both tables from before the check to the end (no plan can be saved
-- between the check and the drop; a save in progress is waited for, within lock_timeout, and then counted):
--   0. REFUSES (changes nothing) if save_agent_workflow_draft() or delete_agent_workflow_draft() is not 0130's body (a later change would be
--      undone), or if any plan exists and the override is not set.
--   1. Drops the two functions.
--   2. Drops the two tables (their policies, index and constraints go with them).
--   3. Asserts the end state: nothing of 0130 left.
--
-- tests/security/test_sec_agent_workflow_drafts.py applies this file to a copy of the lab database and re-applies 0130.

begin;
set local lock_timeout = '5s';
-- set local nightshift.rollback_0130_discard_drafts = 'on';
lock table public.agent_workflow_drafts, public.agent_workflow_draft_versions in access exclusive mode;

do $$
declare
  h text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h
    from pg_proc p where p.oid = to_regprocedure('public.save_agent_workflow_draft(uuid, integer, jsonb)');
  if h is distinct from '475b08e3a582fd812fac8c17fb60627a' then
    raise exception 'rollback 0130: save_agent_workflow_draft() is missing or is not 0130''s body (md5 %): a later change would be undone; read the live body first', h;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h
    from pg_proc p where p.oid = to_regprocedure('public.delete_agent_workflow_draft(uuid)');
  if h is distinct from 'ef7540b121198f0b79cde9f8975a5c95' then
    raise exception 'rollback 0130: delete_agent_workflow_draft() is missing or is not 0130''s body (md5 %): a later change would be undone; read the live body first', h;
  end if;
  if exists (select 1 from public.agent_workflow_drafts)
     and coalesce(current_setting('nightshift.rollback_0130_discard_drafts', true), '') <> 'on' then
    raise exception 'rollback 0130: % plans exist and would be deleted; export what must be kept, then set the override line of this file on purpose',
      (select count(*) from public.agent_workflow_drafts);
  end if;
end $$;

-- 1. The functions.
drop function public.save_agent_workflow_draft(uuid, integer, jsonb);
drop function public.delete_agent_workflow_draft(uuid);

-- 2. The tables (versions first: they reference the plans).
drop table public.agent_workflow_draft_versions;
drop table public.agent_workflow_drafts;

-- 3. End state.
do $$
begin
  if to_regclass('public.agent_workflow_drafts') is not null or to_regclass('public.agent_workflow_draft_versions') is not null
     or exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                  and proname in ('save_agent_workflow_draft', 'delete_agent_workflow_draft')) then
    raise exception 'rollback 0130 end state: something of 0130 is still there';
  end if;
end $$;

commit;
