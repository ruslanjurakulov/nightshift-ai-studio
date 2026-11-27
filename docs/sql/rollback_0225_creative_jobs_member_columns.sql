-- Rollback of 0225_creative_jobs_member_columns.sql (owner-applied, one transaction): gives `authenticated` back 0036's SELECT on
-- the whole of public.creative_jobs, so every member of a workspace reads worker_id and provider_task_id again (BR-0036-01 and
-- BR-S-031 reopen). Only that grant changes.
--
-- NOT UNDONE: the redaction of detail.worker in film_events and creative_job_events (BR-0036-02). The worker ids were replaced
-- by left(md5(id), 12) and are not stored anywhere else; nothing can or should put them back.
begin;

set local lock_timeout = '5s';

revoke select on public.creative_jobs from authenticated;  -- the column grants go with it
grant select on public.creative_jobs to authenticated;

do $$
begin
  if not has_table_privilege('authenticated', 'public.creative_jobs', 'SELECT') then
    raise exception 'rollback_0225: authenticated does not hold SELECT on creative_jobs';
  end if;
end $$;

commit;
