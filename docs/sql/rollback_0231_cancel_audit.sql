-- rollback_0231_cancel_audit.sql — takes migration 0231 (a workflow step's job is cancelled by the run's rule, every cancel is
-- recorded, a browser writes no cancel row) out. OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT COMES BACK: 0198's cancel_creative_job, verbatim (any member cancels any job, a workflow step's included; nothing is recorded
--   in the database), and 0087's insert rule for the two cancel actions (a browser may write them again). The rows 0231 wrote stay:
--   they are the record of who cancelled.
-- REFUSES (changes nothing) if cancel_creative_job is not 0231's body (a later change would be undone).

begin;
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.cancel_creative_job(uuid)');
  if h is distinct from 'c210f8e4684e154d40f7029b5c94b893' then
    raise exception 'rollback 0231: public.cancel_creative_job(uuid) is not 0231''s body (md5 %): if an older file was re-run over it, apply 0231 again first, then roll back; if a later file changed it, take that file out first', h;
  end if;
end $$;

-- cancel_creative_job: 0198's body, verbatim.
create or replace function public.cancel_creative_job(p_job uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  j public.creative_jobs;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into j from public.creative_jobs where id = p_job;
  -- Another organization's job reads as missing, not as forbidden: ids never
  -- confirm what exists elsewhere.
  -- 0198: a film take's job is cancelled with its film (film_cancel_segment), never by a member here: it reads as missing.
  if not found or not public.is_org_member(j.org_id) or j.payer = 'film' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform public.credit_account_lock(j.org_id);
  select * into j from public.creative_jobs where id = p_job for update;
  if j.status in ('cancelled', 'failed', 'expired', 'completed') then
    return jsonb_build_object('job', public.creative_job_json(j), 'released', 0,
                              'already', true);
  end if;
  if not (j.status = 'queued' and j.provider_task_id is null and j.submit_started_at is null)
     and not (j.status = 'running' and j.submit_started_at is null) then
    perform public.creative_refuse('not_cancellable',
      'the provider is already working on this job', 'NS409');
  end if;
  perform public.creative_end_locked(p_job, 'cancelled', 'cancelled', 'cancelled by a member');
  select * into j from public.creative_jobs where id = p_job;
  return jsonb_build_object('job', public.creative_job_json(j), 'already', false);
end
$$;

revoke all on function public.cancel_creative_job(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cancel_creative_job(uuid) to authenticated;

drop policy if exists app_audit_log_no_cancel_rows on public.app_audit_log;

do $$
declare
  h text;
begin
  select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.cancel_creative_job(uuid)');
  if h is distinct from '2720d62c17ae26bce439a28280964575' then
    raise exception 'rollback 0231 end state: public.cancel_creative_job(uuid) is not 0198''s body (md5 %)', h;
  end if;
  if exists (select 1 from pg_policy where polrelid = 'public.app_audit_log'::regclass and polname = 'app_audit_log_no_cancel_rows') then
    raise exception 'rollback 0231 end state: the policy app_audit_log_no_cancel_rows is still there';
  end if;
end $$;

commit;
