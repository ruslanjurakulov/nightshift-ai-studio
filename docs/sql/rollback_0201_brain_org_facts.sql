-- rollback_0201_brain_org_facts.sql — takes migration 0201 (the customer's Nightshift Brain facts) out again.
-- One read-only function; 0201 stores nothing, so nothing is lost. After this, the Brain dashboard (/{channel}/brain) says
-- "Nightshift Brain is not switched on for this workspace yet" where the credits, projects and memory cards were, and
-- GET /api/brain/facts answers 503 not_enabled; the channel card (S10's readers) is untouched.
set local lock_timeout = '5s';

drop function if exists public.brain_org_facts(uuid);

do $$
begin
  if to_regprocedure('public.brain_org_facts(uuid)') is not null then
    raise exception 'rollback 0201 end state: brain_org_facts is still there';
  end if;
end $$;
