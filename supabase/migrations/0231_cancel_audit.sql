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
-- AND (Breach round 4, on 0231 itself):
--   * 0073's workflow_advance_locked makes step N's job under the key 'wf:<run>:<N>', and 0036's create_creative_job key is unique
--     per organization, not per caller. A viewer may create jobs and reads run ids, so it took a later step's key first (and cancelled
--     that job: nothing spent); the step then failed idempotency_conflict and the run ended, around cancel_workflow_run's rule and
--     with no workflow.cancel row (0231-R4-1, medium; pre-existing since 0073).
--   * 0226's cancel_workflow_run wrote its workflow.cancel row whatever the run's status: calling it again on a run that had ended
--     added a row naming the caller for a stop that never happened (0231-R4-2, low).
--
-- CHANGE (additive; four bodies replaced with marked 0231 hunks, one restrictive policy added):
--   cancel_creative_job (0198's body)     a job that is a workflow run's step asks an editor of the organization (cancel_workflow_run's
--     rule; platform staff pass it, as they pass that one, and may restrict a customer's run, never widen it); any other job keeps
--     0036's rule (any member, a viewer's cancel of an ordinary job unchanged). Every cancel that happened writes a creative.cancel
--     row in app_audit_log: the signed-in person (app_audit_log_stamp writes the confirmed e-mail), the job and its organization.
--     The refusal comes before the account lock, the job's row lock and anything written; a job that had already ended answers as
--     before and writes nothing.
--   create_creative_job (0226's body)     a key beginning wf: is refused NS400 invalid_idempotency_key (the detail names the remedy)
--     unless it is the exact key workflow_advance_locked names, for its one call, in the transaction-local setting
--     nightshift.workflow_step_key. No exposed function sets a setting a caller names (set_config is pg_catalog's, which PostgREST
--     does not expose; every exposed function that calls it names a fixed setting), and the API and connected apps make their own
--     keys (api-..., oa-...). Before anything is locked.
--   workflow_advance_locked (0192's body) names the step's key in that setting right before its create_creative_job call and clears
--     it right after (a refusal's rollback puts it back by itself).
--   cancel_workflow_run (0226's body)     writes its workflow.cancel row only inside the branch where the run was running; a call on a
--     run that had already ended answers as before and writes nothing. The rest of 0226's body is unchanged.
--   app_audit_log_no_cancel_rows          restrictive, for a browser's own insert: refuses workflow.cancel and creative.cancel, which
--     only the two cancel functions write (they run as the table's owner, which row security does not ask; the table does not FORCE
--     it). Every other action keeps 0087's rule. The two actions stay on 0087's list: app_audit_log_stamp checks it for the
--     definer's insert too, and this file refuses to apply when either is missing from it.
--   The app: the creative job route no longer writes its own creative.cancel row (the database writes the one row). No other app
--     code writes either action (the workflow route stopped in 0226).
--
-- REPLACES (md5 drift guard: the earlier body, or this file's own on a replay; whitespace runs read as one space):
--   cancel_creative_job      2720d62c17ae26bce439a28280964575 (0198) -> c210f8e4684e154d40f7029b5c94b893
--   create_creative_job      ab939bb64ef626e30c1438c6030d8801 (0226) -> 88c83aa87050731c96ce8a0a5bb28b0a
--   workflow_advance_locked  553dd9f65b62541fd3653ed55288ae46 (0192) -> 37fda6dc6caf182483f10314d166579c
--   cancel_workflow_run      427ead0896b4881c0739b944997c6b50 (0226) -> c09c0dbdd8207bab0fc6d3175276fbf2
-- REPLAY (measured on a database at this file's end state). This file replays onto itself. Re-running 0036, 0060, 0070, 0073,
--   0074, 0075 or 0083 after it silently puts an older body back: apply this file again after. Re-running 0174, 0192, 0198 or 0226
--   after it fails loudly (their guards refuse these bodies) and changes nothing.
--
-- NUMBER. Provisionally 0231 (0230 is S6's). Needs 0226 (create_creative_job's and cancel_workflow_run's bodies; the guard asks
--   for them), 0192 (workflow_advance_locked's body), 0198 (cancel_creative_job's) and 0087 (app_audit_log and its action list).
-- Undo: docs/sql/rollback_0231_cancel_audit.sql (owner-applied): the four earlier bodies back, verbatim, the policy dropped; the
--   rows written stay.
--
-- NO BACKSLASH in this file or its rollback (an apply tool can rewrite escape sequences).
--
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).

set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  -- 0226 first: cancel_workflow_run's workflow.cancel row and create_creative_job are 0226's bodies, which this file builds on.
  if to_regprocedure('public.is_org_spender(uuid, text)') is null then
    raise exception '0231 needs 0226 (and 0215''s is_org_spender): apply 0226_org_spender_everywhere.sql first';
  end if;
  -- The two actions this file writes must be on 0087's list: app_audit_log_stamp refuses any other, and inside cancel_workflow_run
  -- the refusal of its step's cancel would be swallowed (Breach note on round 4).
  if not public.audit_action_allowed('creative.cancel') or not public.audit_action_allowed('workflow.cancel') then
    raise exception '0231 needs creative.cancel and workflow.cancel on audit_action_allowed''s list (0087): put them back first';
  end if;
  for r in select * from (values
      ('public.cancel_creative_job(uuid)', '2720d62c17ae26bce439a28280964575', 'c210f8e4684e154d40f7029b5c94b893', '0198'),
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', 'ab939bb64ef626e30c1438c6030d8801', '88c83aa87050731c96ce8a0a5bb28b0a', '0226'),
      ('public.workflow_advance_locked(uuid, boolean)', '553dd9f65b62541fd3653ed55288ae46', '37fda6dc6caf182483f10314d166579c', '0192'),
      ('public.cancel_workflow_run(uuid)', '427ead0896b4881c0739b944997c6b50', 'c09c0dbdd8207bab0fc6d3175276fbf2', '0226')) v(sig, was, now_, src) loop
    select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is null or h <> all (array[r.was, r.now_]) then
      raise exception '0231 found % with a body that is neither %''s nor 0231''s (md5 %): read the live body first', r.sig, r.src, h;
    end if;
  end loop;
  if exists (select 1 from pg_policy where polrelid = 'public.app_audit_log'::regclass and polname = 'app_audit_log_no_cancel_rows'
                and (polcmd <> 'a' or polpermissive or pg_get_expr(polwithcheck, polrelid) is distinct from
                     '(action <> ALL (ARRAY[''workflow.cancel''::text, ''creative.cancel''::text]))')) then
    raise exception '0231 found a policy app_audit_log_no_cancel_rows on public.app_audit_log that is not this file''s: read it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. cancel_creative_job (0198's body, marked 0231 hunks)
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

-- ───────────────────────────────────────────────────────────────────────────
-- 2. create_creative_job (0226's body, marked 0231 hunks)
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.create_creative_job(
  p_org uuid,
  p_capability text,
  p_model text,
  p_params jsonb default '{}'::jsonb,
  p_mode text default 'exact',
  p_idempotency_key text default null,
  p_max_credits numeric default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid   uuid := auth.uid();
  md    text := lower(btrim(coalesce(p_mode, 'exact')));
  idem  text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  hash_ text;
  prior public.creative_jobs;
  q     jsonb;
  price numeric;
  jid   uuid := gen_random_uuid();
  ref   text;
  res   jsonb;
  j     public.creative_jobs;
  jparams jsonb;
  -- 0075: the router's pick and the surface it was made for.
  surf  text;
  rt    jsonb;
  -- 0174: the first input this person has not acknowledged, for a model that requires an acknowledgement.
  ack   jsonb;
begin
  if uid is null or not public.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The exempt organization's generations are paid by the platform itself,
  -- and every account that existed before 0018 is a member of it: only a
  -- platform owner/admin may spend there (reserve_credits asks for its admins
  -- too, before answering exempt).
  if public.credits_exempt(p_org) and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501',
      detail = 'generations in the operator''s organization are started by a platform admin';
  end if;
  -- 0226 (the owner's decision, 22 Nov; 0215's is_org_spender): spending an organization's credits takes a seat in it. 0043's
  -- accessible_org_ids makes a platform owner or admin an admin of every organization; that stays read-only support access. In the
  -- exempt organization the credits are the platform's own, so its platform owner or admin may, as before. Asked of the session's person, an API key's or a connected app's (api_act_as) and a workflow's confirmer
  -- (workflow_advance_locked acts as them), before the account is locked, a replay answered or anything priced or held.
  if not public.is_org_spender(p_org, 'viewer') then
    perform public.creative_refuse('not_a_member', 'you are not a member of this workspace; ask the workspace''s owner to add you as a member', 'NS400');
  end if;
  if md not in ('exact', 'auto', 'cheap', 'fast', 'quality') then
    perform public.creative_refuse('invalid_params', 'mode must be exact, auto, cheap, fast or quality');
  end if;
  -- Router modes need route_model() and failover, which are not built yet: a
  -- job only ever runs the model the person picked.
  -- 0075: they are built (route_model): this refusal now stands only for a
  -- database without the router.
  if md <> 'exact' and to_regprocedure('public.route_model(text, jsonb, text, uuid, text)') is null then
    perform public.creative_refuse('mode_not_supported',
      'only exact mode (the model you picked) is available on this deployment');
  end if;
  if idem is not null and idem !~ '^[A-Za-z0-9_:.-]{1,255}$' then
    perform public.creative_refuse('invalid_idempotency_key',
      'idempotency key: 1-255 characters of A-Z a-z 0-9 _ : . -');
  end if;
  -- 0231 (Breach 0231-R4-1): keys beginning wf: are a workflow run's own steps ('wf:<run>:<step>', made by workflow_advance_locked).
  -- A key is unique per organization, and run ids are readable by every member, so a member who took a later step's key first made
  -- that step fail (idempotency_conflict) and stopped the run around cancel_workflow_run's rule. Only the exact key the advance is
  -- making now, which it names in a transaction-local setting right before this call, may begin with wf:. No exposed function sets a
  -- setting a caller names, and the API and connected apps make their own keys (api-..., oa-...). Before anything is locked.
  if idem like 'wf:%' and idem is distinct from nullif(current_setting('nightshift.workflow_step_key', true), '') then
    perform public.creative_refuse('invalid_idempotency_key',
      'keys beginning wf: belong to a workflow run''s own steps: choose a key that does not begin with wf:');
  end if;

  -- The org's credit account, locked for the rest of this transaction: every
  -- create (and reserve_credits itself) for this org queues behind it, so two
  -- concurrent creates cannot both spend the same available credits, and a
  -- replay of the same idempotency key finds the first one's committed row.
  perform public.credit_account_lock(p_org);

  hash_ := md5(jsonb_build_object('capability', lower(btrim(coalesce(p_capability, ''))),
                                  'model', lower(btrim(coalesce(p_model, ''))),
                                  'mode', md, 'params', coalesce(p_params, 'null'::jsonb))::text);
  if idem is not null then
    select * into prior from public.creative_jobs
     where org_id = p_org and idempotency_key = idem;
    if found then
      if prior.request_hash is distinct from hash_ then
        perform public.creative_refuse('idempotency_conflict',
          'this idempotency key was used for a different request', 'NS409');
      end if;
      return jsonb_build_object('job', public.creative_job_json(prior), 'replay', true);
    end if;
  end if;

  -- Holds of this org's jobs that nobody will run give their credits back
  -- before this one is checked against the balance.
  perform public.creative_expire_locked(p_org);

  -- 0075: a routed job (auto / cheap / fast / quality) runs the model its quote
  -- named, at the price it showed, and nothing else. Both come back with the
  -- press; the router is asked again here, under the account lock, and a
  -- different pick (a price, a probe or a plan changed since the quote) is
  -- refused for a new quote, never run in its place. The surface is the web
  -- unless api_creative_create said otherwise for this transaction (it can
  -- only narrow the list: the API sells a subset of the web's models).
  if md <> 'exact' then
    if nullif(btrim(coalesce(p_model, '')), '') is null or p_max_credits is null then
      perform public.creative_refuse('invalid_params',
        'a routed job names the model and the price its quote showed: quote first, then confirm both');
    end if;
    surf := coalesce(nullif(current_setting('nightshift.creative_surface', true), ''), 'web');
    if surf not in ('web', 'api', 'mcp') then
      surf := 'web';
    end if;
    rt := public.route_model(p_capability, p_params, md, p_org, surf);
    if (rt ->> 'model') is distinct from lower(btrim(p_model)) then
      perform public.creative_refuse('route_changed',
        'the automatic choice changed since the quote; quote again and confirm the new choice', 'NS409');
    end if;
  end if;

  q := public.creative_price(p_org, p_capability, p_model, p_params);
  price := (q ->> 'credits')::numeric;
  -- 0192: after the price and before 0174's acknowledgement, the ceiling, the hold and the job row: a person who said they are
  -- under 18 is refused every model (adult_only_service), and a requires_adult model is refused to a person without an adult
  -- attestation (adult_attestation_required). The person is auth.uid(): the session, or the key's / grant's person for the API
  -- and MCP (api_act_as). A replay of a job already created was answered above; a routed pick was made without such a model.
  perform public.adult_attestation_gate(uid, q ->> 'model');
  -- 0174: a model whose provider (or the law) makes the person confirm their rights to an input refuses here: after the
  -- price (a model refused anyway never asks) and before the ceiling, the hold and the job row, unless THIS person
  -- acknowledged THIS input in THIS organization at the CURRENT text version (rights_acknowledgement_missing). A replay of
  -- a job already created was answered above.
  ack := public.rights_acknowledgement_missing(p_org, uid, q ->> 'model', p_params);
  if ack is not null then
    perform public.creative_refuse('acknowledgement_required',
      format('kind=%s version=%s subject=%s', ack ->> 'kind', coalesce(ack ->> 'text_version', 'none'), ack ->> 'subject'));
  end if;
  if p_max_credits is not null and price > p_max_credits then
    perform public.creative_refuse('price_changed',
      format('price=%s confirmed=%s', price, p_max_credits), 'NS409');
  end if;

  -- The tier the quote priced is the tier the job carries (0060): stored in
  -- the job's params so the worker sends EXACTLY it and never a default of its
  -- own. Absent from the request = the quote's default, written down here.
  jparams := p_params;
  if q ? 'quality' then
    jparams := coalesce(p_params, '{}'::jsonb) || jsonb_build_object('quality', q ->> 'quality');
  end if;
  -- Likewise the resolution and soundtrack of a video (0070): written down as
  -- priced, so the worker sends exactly them and never a default of its own.
  if q ? 'resolution' then
    jparams := coalesce(jparams, '{}'::jsonb) || jsonb_build_object('resolution', q ->> 'resolution');
  end if;
  if q ? 'audio' then
    jparams := coalesce(jparams, '{}'::jsonb) || jsonb_build_object('audio', (q ->> 'audio')::boolean);
  end if;

  ref := 'cj:' || jid::text;
  if price > 0 then
    -- NS402 'insufficient credits' (available=… needed=…) comes from here.
    res := public.creative_platform_reserve(p_org, ref, price);
    if coalesce((res ->> 'exempt')::boolean, false) then
      ref := null;
    end if;
  else
    ref := null;
  end if;

  insert into public.creative_jobs
    (id, org_id, kind, capability, mode, requested_model, routed_model, params, status,
     payer, credit_ref, credit_unit, quantity, quoted_credits, idempotency_key, request_hash,
     requested_by, expires_at)
  values
    (jid, p_org, 'generate', q ->> 'capability', md, q ->> 'model', q ->> 'model',
     jparams, 'queued', 'credits', ref, q ->> 'unit', (q ->> 'quantity')::numeric, price,
     idem, hash_, uid, now() + interval '2 hours')
  returning * into j;
  -- 0075: what the router decided, written by this function only. The
  -- hold is the pick's price, like exact (BR-L-020): max_credits only
  -- refused a higher one. Members read the reason; the candidates are
  -- the platform's (creative_job_routes, BR-L-022).
  if md <> 'exact' then
    update public.creative_jobs
       set routed_credits = price,
           routing = jsonb_build_object('reason', rt ->> 'reason', 'surface', surf)
     where id = jid
    returning * into j;
    insert into public.creative_job_routes (job_id, quality_tier, candidates, tried)
    values (jid, coalesce((rt ->> 'quality_tier')::numeric, 0), coalesce(rt -> 'candidates', '[]'::jsonb),
            jsonb_build_array(rt ->> 'model'));
    perform public.creative_job_log(jid, p_org, 'routed', 'queued',
      jsonb_build_object('mode', md, 'model', rt ->> 'model', 'reason', rt ->> 'reason',
                         'credits', price));
  end if;
  perform public.creative_job_log(jid, p_org, 'created', 'queued',
    jsonb_build_object('quoted_credits', price, 'held', ref is not null));

  return jsonb_build_object('job', public.creative_job_json(j), 'replay', false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. workflow_advance_locked (0192's body, marked 0231 hunks)
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.workflow_advance_locked(p_run uuid, p_strict boolean default false)
  returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r        public.workflow_runs;
  s        public.workflow_run_steps;
  j        public.creative_jobs;
  out_     jsonb;
  params   jsonb;
  pr       record;
  src_job  public.creative_jobs;
  asset    uuid;
  committed numeric;
  why_code text;
  why      text;
  detail   text;
  guard    integer := 0;
  -- BR-L-011: the step could not start for a reason that passes; it waits.
  wait_    boolean := false;
  -- 0192: the session's claims while a later step is made as the member who confirmed the run (see below).
  saved_c  text;  -- 0192
  saved_s  text;  -- 0192
  saved_e  text;  -- 0192
begin
  select * into r from public.workflow_runs where id = p_run for update;
  if not found then
    return;
  end if;
  loop
    guard := guard + 1;
    exit when guard > 8;
    exit when r.status <> 'running';

    select * into s from public.workflow_run_steps
     where run_id = r.id and status in ('pending', 'running')
     order by step_index limit 1;

    if not found then
      -- Every step is settled and none failed (a failure ends the run below).
      update public.workflow_runs
         set status = 'completed', finished_at = now(), updated_at = now(),
             charged_credits = (select coalesce(sum(charged_credits), 0) from public.workflow_run_steps where run_id = r.id)
       where id = r.id returning * into r;
      exit;
    end if;

    if s.status = 'running' then
      select * into j from public.creative_jobs where id = s.job_id;
      if j.status = 'completed' then
        update public.workflow_run_steps
           set status = 'completed', charged_credits = coalesce(j.charged_credits, 0),
               finished_at = coalesce(j.finished_at, now())
         where run_id = s.run_id and step_index = s.step_index;
        update public.workflow_runs
           set updated_at = now(),
               charged_credits = (select coalesce(sum(charged_credits), 0) from public.workflow_run_steps where run_id = r.id)
         where id = r.id returning * into r;
        continue;
      elsif j.status in ('failed', 'cancelled', 'expired') then
        update public.workflow_run_steps
           set status = case when j.status = 'cancelled' then 'cancelled' else 'failed' end,
               charged_credits = 0, error_code = coalesce(j.error_code, j.status), error = left(j.error, 2000),
               finished_at = coalesce(j.finished_at, now())
         where run_id = s.run_id and step_index = s.step_index;
        -- Later steps were never created, so they never held anything.
        update public.workflow_run_steps set status = 'skipped'
         where run_id = r.id and status = 'pending';
        update public.workflow_runs
           set status = case when r.cancel_requested_at is not null then 'cancelled' else 'failed' end,
               error_code = case when r.cancel_requested_at is not null then 'cancelled' else 'step_failed' end,
               error = format('step %s did not finish (%s); later steps were not started and nothing was held for them',
                              s.step_index + 1, coalesce(j.error_code, j.status)),
               finished_at = now(), updated_at = now(),
               charged_credits = (select coalesce(sum(charged_credits), 0) from public.workflow_run_steps where run_id = r.id)
         where id = r.id returning * into r;
        exit;
      else
        exit; -- the job is still being made
      end if;
    end if;

    -- s is the next step to start; every step before it has completed.
    if r.cancel_requested_at is not null then
      update public.workflow_run_steps set status = 'skipped' where run_id = r.id and status = 'pending';
      update public.workflow_runs
         set status = 'cancelled', error_code = 'cancelled', finished_at = now(), updated_at = now(),
             charged_credits = (select coalesce(sum(charged_credits), 0) from public.workflow_run_steps where run_id = r.id)
       where id = r.id returning * into r;
      exit;
    end if;

    why_code := null;
    wait_ := false;
    if r.created_at < now() - interval '24 hours' then
      why_code := 'confirmation_expired';
      why := 'the price was confirmed more than 24 hours ago; run the workflow again to confirm it afresh';
    end if;

    -- BR-L-006: a later step spends on the confirmation of the member who
    -- pressed Run now, whoever's page carries the run on. Once that member may
    -- no longer run things in the run's organization, nothing more starts.
    if why_code is null and s.step_index > 0
       and not public.workflow_confirmer_may_spend(r.started_by, r.org_id) then
      why_code := 'confirmation_revoked';
      why := 'the member who confirmed this run may no longer run workflows in this organization';
    end if;

    if why_code is null then
      -- Fill in the file an earlier step made.
      params := s.params;
      for pr in select key, value from jsonb_each(s.params) loop
        if jsonb_typeof(pr.value) = 'object' and pr.value ? '$step' then
          asset := null;
          select cj.* into src_job
            from public.workflow_run_steps ss
            join public.creative_jobs cj on cj.id = ss.job_id
           where ss.run_id = r.id and ss.step_index = (pr.value ->> '$step')::integer
             and ss.status = 'completed' and cj.org_id = r.org_id;
          asset := case when found then src_job.result_asset_ids[1] end;
          if asset is null then
            why_code := 'missing_output';
            why := format('step %s made no file for this step to start from', (pr.value ->> '$step')::integer + 1);
          else
            params := params || jsonb_build_object(pr.key, asset::text);
          end if;
        end if;
      end loop;
    end if;

    if why_code is null then
      -- The steps together may not pass what was confirmed.
      select coalesce(sum(quoted_credits), 0) into committed
        from public.workflow_run_steps where run_id = r.id and status in ('running', 'completed');
      if committed + s.quoted_credits > r.max_credits then
        why_code := 'over_confirmed_total';
        why := 'starting this step would pass the total that was confirmed';
      end if;
    end if;

    if why_code is null then
      begin
        -- 0192: a step spends on the confirmation of the member who pressed Run now (BR-L-006), so it is made AS that member:
        -- create_creative_job's gates (the adult answer, membership, rights acknowledgements) read the confirmer, never whoever's
        -- page carries the run on. A minor viewer neither fails an adult's paid run nor, as an adult viewer, makes an adults-only
        -- step for a member without an answer (or a paid one for a member who answered "under 18" after Run now). Only this
        -- internal function acts as the confirmer, and only for a run of theirs; a direct create_creative_job is still the caller's.
        saved_c := current_setting('request.jwt.claims', true);
        saved_s := current_setting('request.jwt.claim.sub', true);
        saved_e := current_setting('request.jwt.claim.email', true);
        perform public.api_act_as(r.started_by);
        -- 0231 (Breach 0231-R4-1): create_creative_job takes a wf: key only when it is the one named here, for this call only (the
        -- block's rollback puts the setting back on a refusal, and it is cleared right after).
        perform set_config('nightshift.workflow_step_key', 'wf:' || r.id::text || ':' || s.step_index::text, true);
        out_ := public.create_creative_job(
          r.org_id, s.capability, s.model, params, 'exact',
          'wf:' || r.id::text || ':' || s.step_index::text, s.quoted_credits);
        perform set_config('nightshift.workflow_step_key', '', true);   -- 0231
        -- 0192: the session is the viewer's again (on a refusal the block's rollback puts the claims back by itself).
        perform set_config('request.jwt.claims', coalesce(saved_c, ''), true);
        perform set_config('request.jwt.claim.sub', coalesce(saved_s, ''), true);
        perform set_config('request.jwt.claim.email', coalesce(saved_e, ''), true);
        if out_ is null or (out_ -> 'job' ->> 'id') is null or (out_ -> 'job' ->> 'org_id')::uuid <> r.org_id then
          raise exception 'creative job not created' using errcode = 'NS400';
        end if;
        -- BR-L-005: a step flips to running in the same transaction that creates
        -- its job, so its own start is never a replay. A replay means a job was
        -- made beforehand under this step's key (keys and run ids are readable
        -- by members): it was not priced against this step's confirmed price and
        -- is never adopted.
        if coalesce((out_ ->> 'replay')::boolean, false) then
          raise exception 'idempotency_conflict' using errcode = 'NS409',
            detail = 'a job already holds this step''s idempotency key; it was not made by this run';
        end if;
        update public.workflow_run_steps
           set status = 'running', job_id = (out_ -> 'job' ->> 'id')::uuid, started_at = now()
         where run_id = s.run_id and step_index = s.step_index;
        -- BR-L-011: a step that waited starts with no stale reason on it.
        update public.workflow_run_steps set error_code = null, error = null
         where run_id = s.run_id and step_index = s.step_index and error_code is not null;
        update public.workflow_runs set updated_at = now() where id = r.id;
        continue;
      exception when others then
        get stacked diagnostics detail = pg_exception_detail;
        -- A transient failure (SQLSTATE class 40: deadlock victim, serialization
        -- failure) is not a refusal: raised, nothing is committed, and the step
        -- is still pending for the next poll. Never a failed, already-paid run.
        if sqlstate like '40%' then
          raise;
        end if;
        if p_strict and s.step_index = 0 then
          raise;
        end if;
        -- BR-L-011: the plan's parallel runs all in use (NS429, 0034's hold
        -- trigger) or a balance short for this step (NS402, reserve_credits)
        -- passes: another job finishes, credits are added. The job and its hold
        -- were rolled back with this block, so the step waits, holding nothing.
        wait_ := sqlstate in ('NS429', 'NS402');
        why_code := case
          when sqlstate = 'NS402' then 'insufficient_credits'
          when sqlstate = 'NS429' then 'run_limit_reached'
          when sqlstate = '42501' then 'forbidden'
          when sqlstate in ('NS400', 'NS409') and sqlerrm ~ '^[a-z0-9_]{1,64}$' then sqlerrm
          else 'refused' end;
        why := left(coalesce(nullif(detail, ''), sqlerrm), 500);
      end;
    end if;

    -- BR-L-011: waiting, not failed. The step stays pending with the reason on
    -- record (written only when it changed, so a polling page does not rewrite
    -- it), later steps stay pending, and the run stays running. The next
    -- advance tries again; after 24 hours confirmation_expired (above) ends it.
    if wait_ then
      update public.workflow_run_steps set error_code = why_code, error = why
       where run_id = s.run_id and step_index = s.step_index and status = 'pending'
         and (error_code is distinct from why_code or error is distinct from why);
      exit;
    end if;

    -- This step could not start (or its input is missing): it fails, the run
    -- with it, and the steps after it are skipped without ever being created.
    update public.workflow_run_steps
       set status = 'failed', charged_credits = 0, error_code = why_code, error = why, finished_at = now()
     where run_id = s.run_id and step_index = s.step_index;
    update public.workflow_run_steps set status = 'skipped' where run_id = r.id and status = 'pending';
    update public.workflow_runs
       set status = 'failed', error_code = 'step_failed',
           error = format('step %s could not start (%s); later steps were not started and nothing was held for them',
                          s.step_index + 1, why_code),
           finished_at = now(), updated_at = now(),
           charged_credits = (select coalesce(sum(charged_credits), 0) from public.workflow_run_steps where run_id = r.id)
     where id = r.id returning * into r;
    exit;
  end loop;
  -- BR-L-011: a step that was waiting and is now skipped (Stop, or a step
  -- before it failed) never started; it keeps no waiting reason.
  update public.workflow_run_steps set error_code = null, error = null
   where run_id = r.id and status = 'skipped' and error_code is not null;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. cancel_workflow_run (0226's body, marked 0231 hunks)
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.cancel_workflow_run(p_run uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r public.workflow_runs;
  s public.workflow_run_steps;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into r from public.workflow_runs where id = p_run;
  if not found or not public.is_org_member(r.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(r.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The account, then the run: the order Run now and advance take (BR-L-005).
  perform public.credit_account_lock(r.org_id);
  select * into r from public.workflow_runs where id = p_run for update;
  if r.status = 'running' then
    update public.workflow_runs set cancel_requested_at = coalesce(cancel_requested_at, now()), updated_at = now()
     where id = p_run;
    select * into s from public.workflow_run_steps where run_id = p_run and status = 'running';
    if found then
      begin
        perform public.cancel_creative_job(s.job_id);
      exception when others then
        -- A transient failure is raised (nothing committed; Stop can be pressed again).
        if sqlstate like '40%' then
          raise;
        end if;
        -- Already with the provider (not_cancellable): it runs to the end.
        null;
      end;
    end if;
    perform public.workflow_advance_locked(p_run);
    -- 0226 (Atlas, 27 Nov): platform staff may stop a run in any organization (they may restrict, never widen), so who stopped it is
    -- recorded here, in the database, for every caller (a direct call never passed the route's own log): the audit row names the
    -- actor (app_audit_log_stamp writes the signed-in person) and the run's organization. Nothing else changes.
    -- 0231 (Breach 0231-R4-2): only a stop that happened: the row is written inside this branch, for a run that was running. A call
    -- on a run that had already ended answers as before and writes nothing.
    insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
    values (auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'workflow.cancel', p_run::text,
            jsonb_build_object('org_id', r.org_id, 'status', r.status));
  end if;
  return public.workflow_run_json(p_run);
end
$$;

-- The replaced bodies keep their earlier grants (create or replace keeps them); restated so a replay leaves the same state.
revoke all on function public.cancel_creative_job(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cancel_creative_job(uuid) to authenticated;
revoke all on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) from public, anon, authenticated, service_role;
grant execute on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) to authenticated;
revoke all on function public.workflow_advance_locked(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.cancel_workflow_run(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cancel_workflow_run(uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. A browser writes no cancel row of its own (Breach 0226-R3-2)
-- ───────────────────────────────────────────────────────────────────────────
-- 0087's app_audit_log_insert lets a signed-in person write any listed action for a channel of theirs (a platform admin: with no
-- channel). The two cancel actions are now the database's own record of who stopped something: written only by cancel_workflow_run
-- and cancel_creative_job, which run as the table's owner and so are not asked by row security (the table does not FORCE it). A
-- restrictive policy refuses them to a browser's own insert and leaves every other action as 0087 has it. The actions stay on
-- 0087's list, because app_audit_log_stamp checks the list for the definer's insert too (it sees the browser's role).
drop policy if exists app_audit_log_no_cancel_rows on public.app_audit_log;
create policy app_audit_log_no_cancel_rows on public.app_audit_log as restrictive for insert to authenticated
  with check (action not in ('workflow.cancel', 'creative.cancel'));

-- ───────────────────────────────────────────────────────────────────────────
-- The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.cancel_creative_job(uuid)', 'c210f8e4684e154d40f7029b5c94b893'),
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', '88c83aa87050731c96ce8a0a5bb28b0a'),
      ('public.workflow_advance_locked(uuid, boolean)', '37fda6dc6caf182483f10314d166579c'),
      ('public.cancel_workflow_run(uuid)', 'c09c0dbdd8207bab0fc6d3175276fbf2')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception '0231 end state: % does not hold this file''s body (md5 %)', r.sig, h;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.cancel_creative_job(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.cancel_creative_job(uuid)', 'execute')
     or has_function_privilege('service_role', 'public.cancel_creative_job(uuid)', 'execute')
     or has_function_privilege('anon', 'public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', 'execute')
     or not has_function_privilege('authenticated', 'public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', 'execute')
     or has_function_privilege('service_role', 'public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', 'execute')
     or has_function_privilege('anon', 'public.workflow_advance_locked(uuid, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.workflow_advance_locked(uuid, boolean)', 'execute')
     or has_function_privilege('service_role', 'public.workflow_advance_locked(uuid, boolean)', 'execute')
     or has_function_privilege('anon', 'public.cancel_workflow_run(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.cancel_workflow_run(uuid)', 'execute')
     or has_function_privilege('service_role', 'public.cancel_workflow_run(uuid)', 'execute') then
    raise exception '0231 end state: a grant is not what this file sets';
  end if;
  if not exists (select 1 from pg_policy where polrelid = 'public.app_audit_log'::regclass and polname = 'app_audit_log_no_cancel_rows'
                    and polcmd = 'a' and not polpermissive) then
    raise exception '0231 end state: the restrictive policy app_audit_log_no_cancel_rows is missing';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (read-only, run after applying; every row should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select v.sig, md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) = v.want as is_0231s
--   from (values
--     ('public.cancel_creative_job(uuid)', 'c210f8e4684e154d40f7029b5c94b893'),
--     ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', '88c83aa87050731c96ce8a0a5bb28b0a'),
--     ('public.workflow_advance_locked(uuid, boolean)', '37fda6dc6caf182483f10314d166579c'),
--     ('public.cancel_workflow_run(uuid)', 'c09c0dbdd8207bab0fc6d3175276fbf2')
--   ) v(sig, want) left join pg_proc p on p.oid = to_regprocedure(v.sig);
-- select exists (select 1 from pg_policy where polrelid = 'public.app_audit_log'::regclass and polname = 'app_audit_log_no_cancel_rows'
--                  and not polpermissive) as browser_writes_no_cancel_row;
