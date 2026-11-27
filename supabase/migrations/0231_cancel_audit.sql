-- 0231_cancel_audit.sql — stopping something is recorded, and a workflow run is stopped only by its own rule. Breach 0226-R3-1 and
-- 0226-R3-2, found attacking 0226's "who cancelled a run is recorded".
--
-- EVIDENCE (read from the migrations and measured in the lab, not assumed):
--   * 0198's cancel_creative_job (0036's body, the film hunk added) asks only is_org_member(j.org_id): any seat, a viewer's included.
--     A workflow run's running step is an ordinary creative job, and 0073's workflow_advance_locked ends the run failed when its
--     step's job is cancelled. So a viewer stops a member's run through its step, which cancel_workflow_run (editor, 0073) refuses.
--   * Nothing records such a cancel in the database: the creative job route's logAudit('creative.cancel') writes a row with no
--     channel, which 0087's app_audit_log_insert refuses to anyone but a platform admin (the route swallows the refusal). A seatless
--     platform admin who stops a customer's run this way leaves no row naming them, although 0226 keeps cancel open to staff on the
--     ground that the database records who stopped a run.
--   * 0087's insert rule lets a signed-in person write workflow.cancel themselves (a platform admin: with no channel, the shape the
--     database writes), so 0226's record could be padded with stops that never happened (the actor stays the caller's own).
--
-- CHANGE (additive; one body replaced with two marked 0231 hunks, one restrictive policy added):
--   cancel_creative_job (0198's body)   a job that is a workflow run's step asks an editor of the organization (cancel_workflow_run's
--     rule; platform staff pass it, as they pass that one, and may restrict a customer's run, never widen it); any other job keeps
--     0036's rule (any member, a viewer's cancel of an ordinary job unchanged). Every cancel that happened writes a creative.cancel
--     row in app_audit_log: the signed-in person (app_audit_log_stamp writes the confirmed e-mail), the job and its organization.
--     cancel_workflow_run calls it for the run's running step, so a run's stop writes both rows. The refusal comes before the
--     account lock, the job's row lock and anything written; a job that had already ended answers as before and writes nothing.
--   app_audit_log_no_cancel_rows        restrictive, for a browser's own insert: refuses workflow.cancel and creative.cancel, which
--     only the two functions write (they run as the table's owner, which row security does not ask; the table does not FORCE it).
--     Every other action keeps 0087's rule. The two actions stay on 0087's list: app_audit_log_stamp checks it for the definer's
--     insert too.
--   The app: the creative job route no longer writes its own creative.cancel row (the database writes the one row). No other app
--     code writes either action (the workflow route stopped in 0226).
--
-- REPLACES (md5 drift guard: 0198's body, or this file's own on a replay; whitespace runs read as one space):
--   cancel_creative_job   2720d62c17ae26bce439a28280964575 (0198) -> c210f8e4684e154d40f7029b5c94b893
-- REPLAY. This file replays onto itself. Re-running 0036 after it silently puts 0036's cancel_creative_job back: apply this file
--   again after. Re-running 0198 after it fails loudly (0198's guards refuse the later bodies of 0215 and 0226 already).
--
-- NUMBER. Provisionally 0231 (0230 is S6's). Needs 0226 (cancel_workflow_run's workflow.cancel row; its guard asks for 0226's body),
--   0087, 0198.
-- Undo: docs/sql/rollback_0231_cancel_audit.sql (owner-applied): 0198's body back, the policy dropped; the rows written stay.
--
-- NO BACKSLASH in this file or its rollback (an apply tool can rewrite escape sequences).
--
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).

set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  -- 0226 first: cancel_workflow_run writes the workflow.cancel row this file refuses to a browser (its route no longer writes one).
  select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.cancel_workflow_run(uuid)');
  if h is distinct from '427ead0896b4881c0739b944997c6b50' then
    raise exception '0231 needs 0226''s cancel_workflow_run (md5 427ead0896b4881c0739b944997c6b50; found %): apply 0226_org_spender_everywhere.sql first', h;
  end if;
  select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.cancel_creative_job(uuid)');
  if h is null or h <> all (array['2720d62c17ae26bce439a28280964575', 'c210f8e4684e154d40f7029b5c94b893']) then
    raise exception '0231 found public.cancel_creative_job(uuid) with a body that is neither 0198''s nor 0231''s (md5 %): read the live body first', h;
  end if;
  if exists (select 1 from pg_policy where polrelid = 'public.app_audit_log'::regclass and polname = 'app_audit_log_no_cancel_rows'
                and (polcmd <> 'a' or polpermissive or pg_get_expr(polwithcheck, polrelid) is distinct from
                     '(action <> ALL (ARRAY[''workflow.cancel''::text, ''creative.cancel''::text]))')) then
    raise exception '0231 found a policy app_audit_log_no_cancel_rows on public.app_audit_log that is not this file''s: read it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. cancel_creative_job (0198's body, two marked 0231 hunks: the step's rule, the record)
-- ───────────────────────────────────────────────────────────────────────────
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
  -- 0231 (Breach 0226-R3-1): a workflow run's step is an ordinary creative job, and cancelling it ends the run at its next advance.
  -- Stopping a run is cancel_workflow_run's to decide (an editor, 0073), so the step's job asks the same rule here: a viewer who
  -- could not stop the run cannot stop it through its step either. Platform staff pass it, as they pass cancel_workflow_run's (they
  -- may restrict a customer's run, never widen it), and are recorded below. Any other job keeps 0036's rule (any member).
  if exists (select 1 from public.workflow_run_steps ws where ws.job_id = j.id)
     and not public.is_org_member(j.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
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
  -- 0231: who cancelled is recorded in the database, for every caller of every job (the route's own row was refused by RLS for a
  -- customer, whose row carries no channel): the signed-in person (app_audit_log_stamp writes the confirmed e-mail), the job and its
  -- organization. Only a cancel that happened; an answer that the job had already ended writes nothing.
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
  values (auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'creative.cancel', p_job::text,
          jsonb_build_object('org_id', j.org_id, 'capability', j.capability));
  return jsonb_build_object('job', public.creative_job_json(j), 'already', false);
end
$$;

revoke all on function public.cancel_creative_job(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cancel_creative_job(uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. A browser writes no cancel row of its own (Breach 0226-R3-2)
-- ───────────────────────────────────────────────────────────────────────────
-- 0087's app_audit_log_insert lets a signed-in person write any listed action for a channel of theirs (a platform admin: with no
-- channel). The two cancel actions are now the database's own record of who stopped something: written only by cancel_workflow_run
-- and cancel_creative_job, which run as the table's owner and so are not asked by row security (the table does not FORCE it). A
-- restrictive policy refuses them to a browser's own insert and leaves every other action as 0087 has it. The action stays on
-- 0087's list, because app_audit_log_stamp checks the list for the definer's insert too (it sees the browser's role).
drop policy if exists app_audit_log_no_cancel_rows on public.app_audit_log;
create policy app_audit_log_no_cancel_rows on public.app_audit_log as restrictive for insert to authenticated
  with check (action not in ('workflow.cancel', 'creative.cancel'));

-- ───────────────────────────────────────────────────────────────────────────
-- The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  h text;
begin
  select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.cancel_creative_job(uuid)');
  if h is distinct from 'c210f8e4684e154d40f7029b5c94b893' then
    raise exception '0231 end state: public.cancel_creative_job(uuid) does not hold this file''s body (md5 %)', h;
  end if;
  if not has_function_privilege('authenticated', 'public.cancel_creative_job(uuid)', 'execute')
     or has_function_privilege('anon', 'public.cancel_creative_job(uuid)', 'execute')
     or has_function_privilege('service_role', 'public.cancel_creative_job(uuid)', 'execute') then
    raise exception '0231 end state: a grant on public.cancel_creative_job(uuid) is not what this file sets';
  end if;
  if not exists (select 1 from pg_policy where polrelid = 'public.app_audit_log'::regclass and polname = 'app_audit_log_no_cancel_rows'
                    and polcmd = 'a' and not polpermissive) then
    raise exception '0231 end state: the restrictive policy app_audit_log_no_cancel_rows is missing';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (read-only, run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc p where p.oid = to_regprocedure('public.cancel_creative_job(uuid)')) = 'c210f8e4684e154d40f7029b5c94b893' as cancel_records,
--   exists (select 1 from pg_policy where polrelid = 'public.app_audit_log'::regclass and polname = 'app_audit_log_no_cancel_rows'
--             and not polpermissive) as browser_writes_no_cancel_row;
