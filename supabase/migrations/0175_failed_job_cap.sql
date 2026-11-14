-- 0175_failed_job_cap.sql — an organization whose creative jobs failed or were refused 5 times in a rolling 24 hours starts no
-- new one until the oldest of those leaves the window. Refused before anything is held, with the remedy.
--
-- EVIDENCE:
--   * Owner decision, 2026-11-14: seven models go on sale with 0173, open to every account. A creative job that fails or is
--     refused releases its whole hold (creative_end_locked, 0036: charged_credits = 0), so the customer pays nothing for it.
--   * Some of those refusals come AFTER the vendor generated: Ideogram answers is_image_safe:false on a finished picture
--     (modules/capabilities/image.py, "the vendor marked the image unsafe" -> policy); a task polled to FAILED ends the same
--     way (creative_worker._poll -> the adapter's code, or provider_error). If the vendor bills those calls, a free account
--     with 100 welcome credits can loop them and our spend has no bound: nothing in create_creative_job (0174) counts failures.
--   * The owner approved: at most 5 failed or refused creative jobs per organization per rolling 24 hours; after that, new
--     creative jobs are refused before any hold, with a clear remedy.
--
-- DIAGNOSIS: every creative_jobs row is written by create_creative_job (0036 to 0174; the Studio, the public API's
--   api_creative_create, the MCP server through the API, region edit, and each workflow step through workflow_advance_locked).
--   A workflow run is confirmed and started by start_workflow_run before its steps create their jobs. Those two are the doors.
--
-- WHICH FAILURES COUNT (creative_failed_job_codes(), a closed list; status = 'failed', finished_at in the last 24 hours):
--     policy               the vendor's safety filter refused the prompt or the result (E_POLICY, incl. is_image_safe:false)
--     bad_request          the request itself is wrong (E_BAD_REQUEST): the person changes the input
--     invalid_params       a setting the worker found invalid
--     source_unavailable   the input file is gone or unusable (the person deleted or replaced it)
--     source_too_large     the input file is larger than the model takes
--     provider_error       the vendor failed the task without a narrower code (a late failure), or an adapter raised without one
--   NOT counted, because they are not the customer's doing (a closed list is the safe direction: a code a later worker adds is
--   not counted until a migration names it): an outage or quota of a provider (unavailable, unreachable, network,
--   rate_limited, quota, provider_quota, auth, not_configured), a stale registry or our adapter (not_found, bad_response,
--   vendor_tool_unsupported, adapter_missing), our own worker (worker_error, worker_lost, submit_interrupted, provider_timeout
--   (our worker's poll deadline), output_lost, result_not_stored, credits_unavailable, hold_below_quote, no_credit_hold,
--   hold_not_open), a model switched off (model_temporarily_off), the region editor's no_region_applied and
--   region_quote_mismatch (a region is edited by several vendor calls whose own codes are mixed; the editor is off by default,
--   NIGHTSHIFT_REGION_EDITOR), and every job that ended expired or cancelled rather than failed.
--
-- CHANGE (additive; four function bodies replaced, one marked hunk each):
--   creative_failed_job_codes()      the list above (immutable).
--   creative_failed_job_gate(org)    counts the org's counted failures in the last 24 hours. At 5 or more it raises NS429
--     'failed_job_limit' with detail 'failed=<n> limit=5 retry_at=<YYYY-MM-DDTHH:MI:SSZ>': retry_at is the moment the count
--     drops below the limit, i.e. when the (n - 5 + 1)-th oldest counted failure leaves the window (with exactly 5, the
--     oldest). The operator's credits-exempt organization (credits_exempt) is not counted. The limit is a NAMED CONSTANT in
--     this function (failed_job_limit = 5): no existing settings table covers creative jobs, so changing it is a migration,
--     reviewed like one.
--   index creative_jobs_failed_window_idx (org_id, status, finished_at): the count reads only that window.
--   create_creative_job (0174's body): the gate after the idempotent replay (a job already made is answered, never refused) and
--     BEFORE the routing, the price, the acknowledgement, the ceiling, the hold and the job row. Nothing is held.
--   start_workflow_run (0174's body): the same gate after the run's replay and before the run row; nothing is held.
--   workflow_advance_locked (0083's body): a step whose job is refused by the gate WAITS (like run_limit_reached: the window
--     moves on its own) under its own word 'failed_job_limit', not as "your plan's runs are busy" (CLAUDE.md rule 5).
--   api_creative_refusal (0174's body): NS429 failed_job_limit answers 429 failed_job_limit with the count, the limit and
--     retry_at, and the remedy (change the prompt or the input, try after the time, or contact support). The MCP server
--     answers through the API.
--
-- THE RACE BOUND. Creates for one organization queue on its credit account (credit_account_lock, taken before the gate), so
--   each counts every failure committed before it. A job that is still running is not a failure yet: when the 5th counted
--   failure lands, the jobs accepted earlier and not finished can still fail. So within any 24 hours the counted failures are
--   at most 4 + A, where A is the number of the org's jobs that were accepted and unfinished when the last create was allowed;
--   jobs that hold credits are bounded by the plan's parallel-run limit (0034, NS429 run_limit_reached). No create is allowed
--   once 5 are recorded, however many race. tests/security/test_sec_failed_job_cap.py measures this.
--
-- REPLACES (md5 drift guard: the earlier body, or this file's own on a replay; whitespace runs read as one space):
--   create_creative_job 88107b00b0a8c143606ed17f5898c98d, start_workflow_run 8b3c4b4afbc19e6f336c09b4692ad7ed and
--   api_creative_refusal e6ec45d0d912389a05eb2d40261c2c2a (0174), workflow_advance_locked 2d63f9fb091efa71d8ae466cba0b42db
--   (0083). Signatures, SECURITY DEFINER, the pinned search_path and the grants stay as they were (restated below).
-- NOT CHANGED: workflow_quote_steps (a quote holds nothing and is not refused; start is), quote_creative_job, creative_price,
--   every price, hold and ledger rule, every model's availability, the worker.
--
-- REPLAY. This file replays onto itself (drift guards accept its own bodies; create index if not exists). The EARLIER files do
--   NOT protect it: 0174's guard accepts 0174's bodies only, so re-running 0174 after this file fails loudly, but 0083 has no
--   guard and re-running it SILENTLY puts back a workflow_advance_locked that calls the refusal run_limit_reached. Undo 0175
--   (its rollback) before re-running 0174 or 0083, then apply 0175 again, and run the Verify query below.
--
-- NUMBER. 0175: 0171, 0172 and 0173 are held by open pull requests and 0174 (#780) replaces create_creative_job; this file is
--   built on 0174's bodies and auto-applies to the live database on merge, so it merges AFTER 0174. Needs 0020, 0036, 0083, 0174.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only):
--   select p.oid::regprocedure, md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc p
--    where p.oid in ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)'::regprocedure,
--                    'public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)'::regprocedure,
--                    'public.workflow_advance_locked(uuid, boolean)'::regprocedure,
--                    'public.api_creative_refusal(text, text, text)'::regprocedure);
--   expected BEFORE the four md5s under REPLACES; AFTER 1ddd39a69de4153e36d02aa372ed5e60, 3a7d8eb57e48badff9ab7e321e6c52f6, b46b5f42927697ebbb8176f8ce527c6d, a5db9f56ba2e83c285beaace621217d8 (this file).
-- Undo: docs/sql/rollback_0175_failed_job_cap.sql (owner-applied). It puts the four earlier bodies back and drops the two new
--   functions and the index. No row is written by this file, so there is nothing else to undo.

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  if to_regprocedure('public.credits_exempt(uuid)') is null or to_regprocedure('public.credit_account_lock(uuid)') is null then
    raise exception '0175 needs the credits: apply 0020_credits.sql first';
  end if;
  if to_regprocedure('public.creative_refuse(text, text, text)') is null or to_regclass('public.creative_jobs') is null then
    raise exception '0175 needs the creative jobs: apply 0036_creative_jobs.sql first';
  end if;
  if to_regprocedure('public.acknowledge_rights(text, text, text, text)') is null then
    raise exception '0175 is built on 0174''s create_creative_job: apply 0174_rights_acknowledgement.sql first';
  end if;
  -- The four bodies this file replaces: the earlier one, or this file's own (a replay).
  for r in select * from (values
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', '88107b00b0a8c143606ed17f5898c98d', '1ddd39a69de4153e36d02aa372ed5e60', '0174'),
      ('public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)', '8b3c4b4afbc19e6f336c09b4692ad7ed', '3a7d8eb57e48badff9ab7e321e6c52f6', '0174'),
      ('public.workflow_advance_locked(uuid, boolean)', '2d63f9fb091efa71d8ae466cba0b42db', 'b46b5f42927697ebbb8176f8ce527c6d', '0083'),
      ('public.api_creative_refusal(text, text, text)', 'e6ec45d0d912389a05eb2d40261c2c2a', 'a5db9f56ba2e83c285beaace621217d8', '0174')) v(sig, was, now_, src) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is null or h <> all (array[r.was, r.now_]) then
      raise exception '0175 found % with a body that is neither %''s nor 0175''s (md5 %): read the live body first', r.sig, r.src, h;
    end if;
  end loop;
  -- The functions this file creates: absent, or this file's own bodies (a replay).
  for r in select * from (values
      ('public.creative_failed_job_codes()', '2abde1f23d4729dec2ee73935f0c1c6c'),
      ('public.creative_failed_job_gate(uuid)', 'db8553de657fe2ee8c801879fe8b8735')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is not null and h <> r.want then
      raise exception '0175 found % with a body that is not this file''s (md5 %): read the live body first', r.sig, h;
    end if;
  end loop;
  -- The index this file creates: absent, or this file's own columns.
  if to_regclass('public.creative_jobs_failed_window_idx') is not null
     and pg_get_indexdef(to_regclass('public.creative_jobs_failed_window_idx'))
         <> 'CREATE INDEX creative_jobs_failed_window_idx ON public.creative_jobs USING btree (org_id, status, finished_at)' then
    raise exception '0175 found an index creative_jobs_failed_window_idx that is not this file''s: read it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Which failures count, and the gate
-- ───────────────────────────────────────────────────────────────────────────

-- The window's count reads (org_id, status = 'failed', finished_at > now() - 24 h) and nothing else.
create index if not exists creative_jobs_failed_window_idx on public.creative_jobs (org_id, status, finished_at);

-- The customer's doing, or a vendor task that failed: see WHICH FAILURES COUNT in the header. A closed list, so a code a later
-- worker writes is not held against a customer until a migration names it here.
create or replace function public.creative_failed_job_codes() returns text[]
  language sql immutable set search_path = public, pg_temp as $$
  select array['policy', 'bad_request', 'invalid_params', 'source_unavailable', 'source_too_large', 'provider_error']::text[]
$$;

-- Raises NS429 'failed_job_limit' when p_org has failed_job_limit or more counted failures in the last 24 hours. Called by
-- create_creative_job and start_workflow_run under the org's credit account lock, before anything is held.
create or replace function public.creative_failed_job_gate(p_org uuid) returns void
  language plpgsql stable set search_path = public, pg_temp as $$
declare
  -- The owner's number (2026-11-14). A named constant, not a setting: no settings table covers creative jobs, and a change is a
  -- migration, reviewed like one.
  failed_job_limit constant integer := 5;
  n     integer;
  frees timestamptz;
begin
  -- The operator's organization is paid by the platform and only a platform admin spends there (create_creative_job).
  if p_org is null or public.credits_exempt(p_org) then
    return;
  end if;
  select count(*) into n
    from public.creative_jobs j
   where j.org_id = p_org and j.status = 'failed' and j.finished_at > now() - interval '24 hours'
     and j.error_code = any (public.creative_failed_job_codes());
  if n < failed_job_limit then
    return;
  end if;
  -- When the count drops below the limit: the (n - limit + 1)-th oldest counted failure leaves the window then.
  select j.finished_at + interval '24 hours' into frees
    from public.creative_jobs j
   where j.org_id = p_org and j.status = 'failed' and j.finished_at > now() - interval '24 hours'
     and j.error_code = any (public.creative_failed_job_codes())
   order by j.finished_at, j.id
  offset n - failed_job_limit
   limit 1;
  perform public.creative_refuse('failed_job_limit',
    format('failed=%s limit=%s retry_at=%s', n, failed_job_limit,
           to_char(frees at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), 'NS429');
end
$$;

revoke all on function public.creative_failed_job_codes() from public, anon, authenticated, service_role;
revoke all on function public.creative_failed_job_gate(uuid) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The job start path: 0174's create_creative_job, one marked hunk
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

  -- 0175: an organization with 5 failed or refused jobs in the last 24 hours (creative_failed_job_gate) starts no new one.
  -- Here: after the replay (a job already made is answered, never refused), under the account lock (concurrent creates
  -- queue behind it and each counts what the one before it committed), and before the price, the ceiling, the hold and
  -- the job row: nothing is held. The operator's credits-exempt organization is not counted.
  perform public.creative_failed_job_gate(p_org);

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
revoke all on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) from public, anon, authenticated, service_role;
grant execute on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Workflows: 0174's start_workflow_run, one marked hunk
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.start_workflow_run(
  p_run uuid,
  p_workflow uuid,
  p_version integer,
  p_inputs jsonb default '{}'::jsonb,
  p_max_credits numeric default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  w       public.workflows;
  prior   public.workflow_runs;
  vals    jsonb;
  hash_   text;
  q       jsonb;
  total   numeric;
  acc     public.credit_accounts;
  st      record;
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_run is null then
    perform public.creative_refuse('invalid_params', 'a run id is required');
  end if;
  select * into w from public.workflows where id = p_workflow;
  if not found or w.archived_at is not null or not public.is_org_member(w.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(w.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The operator's organization is paid by the platform: only a platform admin
  -- spends there (create_creative_job asks the same of every step).
  if public.credits_exempt(w.org_id) and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501',
      detail = 'runs in the operator''s organization are started by a platform admin';
  end if;
  if p_max_credits is null or p_max_credits < 0 then
    perform public.creative_refuse('confirm_price', 'the confirmed total is required');
  end if;

  -- The account first: every create (and reserve) for this organization queues
  -- behind it, so a replay of the same run finds the first one's committed rows.
  perform public.credit_account_lock(w.org_id);

  hash_ := md5(jsonb_build_object('workflow', p_workflow, 'inputs', coalesce(p_inputs, '{}'::jsonb),
                                  'max', round(p_max_credits, 2)::text)::text);
  select * into prior from public.workflow_runs where id = p_run;
  if found then
    -- The same id under another organization, another workflow, other inputs or
    -- another confirmed total is a different request: refused without saying
    -- anything about what it collided with.
    if prior.org_id <> w.org_id or prior.request_hash is distinct from hash_ then
      perform public.creative_refuse('idempotency_conflict',
        'this run id was used for a different request', 'NS409');
    end if;
    perform public.workflow_advance_locked(prior.id);
    return public.workflow_run_json(prior.id) || jsonb_build_object('replay', true);
  end if;

  -- 0175: the same gate as create_creative_job, before the run row and before anything is held. A replay of a run already
  -- started was answered above.
  perform public.creative_failed_job_gate(w.org_id);

  if p_version is distinct from w.version then
    perform public.creative_refuse('workflow_changed',
      format('the workflow is now version %s, not %s', w.version, p_version), 'NS409');
  end if;

  vals := public.workflow_bind_inputs(w, p_inputs);
  q := public.workflow_quote_steps(w, vals);
  -- 0174: named, before the generic 'unpriced': which steps need the Studio's acknowledgement (workflow_quote_steps).
  if exists (select 1 from jsonb_array_elements(q -> 'steps') e where e.value ->> 'reason' = 'acknowledgement_required') then
    perform public.creative_refuse('acknowledgement_required',
      format('step(s) %s use a model that asks you to confirm your rights to its input; make them in the Studio',
             (select string_agg(((e.value ->> 'step_index')::integer + 1)::text, ', ') from jsonb_array_elements(q -> 'steps') e
               where e.value ->> 'reason' = 'acknowledgement_required')));
  end if;
  if not (q ->> 'priced')::boolean then
    perform public.creative_refuse('unpriced',
      format('step(s) %s cannot be priced, so the workflow has no price',
             (select string_agg((u.x::integer + 1)::text, ', ') from jsonb_array_elements_text(q -> 'unpriced_steps') u(x))));
  end if;
  total := (q ->> 'total')::numeric;
  if round(p_max_credits, 2) <> round(total, 2) then
    perform public.creative_refuse('price_changed',
      format('price=%s confirmed=%s', total, round(p_max_credits, 2)), 'NS409');
  end if;
  if not public.credits_exempt(w.org_id) then
    select * into acc from public.credit_accounts where org_id = w.org_id;
    if coalesce(acc.balance - acc.reserved, 0) < total then
      perform public.creative_refuse('insufficient_credits',
        format('available=%s needed=%s', coalesce(acc.balance - acc.reserved, 0), total), 'NS402');
    end if;
  end if;

  insert into public.workflow_runs
    (id, org_id, workflow_id, workflow_name, workflow_version, inputs, max_credits, request_hash, started_by)
  values
    (p_run, w.org_id, w.id, w.name, w.version, vals, round(total, 2), hash_, uid);
  for st in select v, ord from jsonb_array_elements(w.steps) with ordinality as t(v, ord) loop
    insert into public.workflow_run_steps (run_id, step_index, org_id, capability, model, params, quoted_credits)
    values (p_run, st.ord - 1, w.org_id, st.v ->> 'capability', st.v ->> 'model',
            public.workflow_fill_params(st.v -> 'params', vals),
            (q -> 'steps' -> (st.ord - 1)::integer ->> 'credits')::numeric);
  end loop;

  perform public.workflow_advance_locked(p_run, true);
  return public.workflow_run_json(p_run) || jsonb_build_object('replay', false);
end
$$;
revoke all on function public.start_workflow_run(uuid, uuid, integer, jsonb, numeric) from public, anon, authenticated, service_role;
grant execute on function public.start_workflow_run(uuid, uuid, integer, jsonb, numeric) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. A waiting workflow step: 0083's workflow_advance_locked, one marked hunk
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
        out_ := public.create_creative_job(
          r.org_id, s.capability, s.model, params, 'exact',
          'wf:' || r.id::text || ':' || s.step_index::text, s.quoted_credits);
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
          -- 0175: the failed-job limit is NS429 too, and it passes too (the window moves); the step waits under its own word.
          when sqlstate = 'NS429' and sqlerrm = 'failed_job_limit' then 'failed_job_limit'
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
revoke all on function public.workflow_advance_locked(uuid, boolean) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The public API's answer: 0174's api_creative_refusal, one marked hunk
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.api_creative_refusal(p_state text, p_msg text, p_detail text)
  returns jsonb
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  word text := btrim(coalesce(p_msg, ''));
  det  text := left(coalesce(p_detail, ''), 300);
  m    text[];
  extra jsonb := case when det <> '' and det <> word then jsonb_build_object('detail', det) else '{}'::jsonb end;
begin
  case p_state
    when '42501' then
      return public.api_err(403, 'forbidden', 'This key may not start generations in this organization.');
    when 'P0002' then
      return public.api_err(404, 'job_not_found', 'No generation with that id for this key.');
    when '22023' then
      return public.api_err(400, 'invalid_params', 'The request has a parameter this API does not accept.');
    when 'NS402' then
      m := regexp_match(coalesce(p_detail, ''), 'available=(-?[0-9.]+)\s+needed=([0-9.]+)');
      return public.api_err(402, 'insufficient_credits',
        'The organization does not have enough credits for this generation. Nothing was held.',
        case when m is null then '{}'::jsonb
             else jsonb_build_object('available_credits', m[1]::numeric, 'needed_credits', m[2]::numeric) end);
    when 'NS429' then
      -- 0175: too many failed or refused generations in 24 hours. The detail names the count, the limit and the moment the
      -- count drops below the limit (UTC); without it the answer says so and names no number.
      if word = 'failed_job_limit' then
        m := regexp_match(coalesce(p_detail, ''),
          'failed=([0-9]+)\s+limit=([0-9]+)\s+retry_at=([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}:[0-9]{2}):([0-9]{2})Z');
        if m is null then
          return public.api_err(429, 'failed_job_limit',
            'Too many generations in this organization failed or were refused in the last 24 hours, so new ones are paused for now. Nothing was held or charged. Change the prompt or the input file, or contact support.');
        end if;
        return public.api_err(429, 'failed_job_limit',
          format('%s generations in this organization failed or were refused in the last 24 hours (the limit is %s), so new ones are paused. Nothing was held or charged. Try again after %s %s UTC; change the prompt or the input file (a refusal is usually the provider''s safety filter), or contact support.',
                 m[1], m[2], m[3], m[4]),
          jsonb_build_object('failed_jobs', m[1]::int, 'limit', m[2]::int,
                             'retry_at', m[3] || 'T' || m[4] || ':' || m[5] || 'Z'));
      end if;
      m := regexp_match(coalesce(p_detail, ''), 'active=([0-9]+)\s+limit=([0-9]+)');
      return public.api_err(429, 'run_limit_reached',
        'All of the plan''s parallel runs are in use. Wait for one to finish.',
        jsonb_build_object('retry_after', 60) || case when m is null then '{}'::jsonb
             else jsonb_build_object('active', m[1]::int, 'limit', m[2]::int) end);
    when 'NS409' then
      if word = 'price_changed' then
        return public.api_err(409, 'price_changed',
          'The price is now above max_credits. Quote again and confirm the new price.', extra);
      elsif word = 'idempotency_conflict' then
        return public.api_err(422, 'idempotency_key_reused',
          'This Idempotency-Key was already used for a different generation.');
      -- 0075: the router's pick changed since the quote.
      elsif word = 'route_changed' then
        return public.api_err(409, 'route_changed',
          'The automatic choice changed since the quote. Quote again and confirm the new choice.', extra);
      end if;
    when 'NS400' then
      return case word
        when 'registry_missing' then public.api_err(503, 'registry_missing', 'The model registry is not set up on this deployment.')
        when 'model_not_sellable' then public.api_err(422, 'model_not_sellable', 'That model is not available for this capability through the API.', extra)
        when 'entitlement_required' then public.api_err(403, 'entitlement_required', 'The organization''s plan does not include this model.', extra)
        when 'unpriced' then public.api_err(422, 'unpriced', 'That model has no price yet, so it cannot be sold.')
        when 'capability_not_supported' then public.api_err(422, 'capability_not_supported', 'That capability cannot be generated on this deployment.', extra)
        when 'source_unavailable' then public.api_err(422, 'source_unavailable', 'A media-library file in the request is not available to this organization.', extra)
        -- 0174: the model needs the person to confirm their rights to an input file; the API has no call for that.
        when 'acknowledgement_required' then public.api_err(428, 'acknowledgement_required', 'This model needs a person to confirm, in the Studio, their rights to the input file (for example the consent of every person shown). Confirm it there, then retry. Nothing was held or charged.', extra)
        when 'style_unavailable' then public.api_err(422, 'style_unavailable', 'The style kit in the request is not available to this organization.')
        when 'mode_not_supported' then public.api_err(422, 'mode_not_supported', 'Only mode "exact" (the model you named) is available.')
        -- 0075: no available, priced model of this plan takes these settings.
        when 'no_model_available' then public.api_err(422, 'no_model_available', 'No available, priced model can make this with these settings.', extra)
        -- 0124: the owner switched this model off for now. Nothing was held or charged; the caller chooses another or waits.
        when 'model_temporarily_off' then public.api_err(503, 'model_temporarily_off', 'That model is temporarily unavailable. Nothing was held or charged. Choose another model, or try again later.', extra)
        when 'invalid_idempotency_key' then public.api_err(400, 'invalid_idempotency_key', 'Idempotency-Key: 1-255 characters of A-Z a-z 0-9 _ : . -')
        else public.api_err(400, 'invalid_params', 'The request has a parameter this API does not accept.', extra)
      end;
    else
      null;
  end case;
  return public.api_err(500, 'internal_error',
    'The request failed inside the database. Nothing was created or charged; retry with backoff.');
end
$$;
revoke all on function public.api_creative_refusal(text, text, text) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. End state (refuses the whole transaction if any of it is not so)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  r record;
begin
  for r in select * from (values
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', '1ddd39a69de4153e36d02aa372ed5e60'),
      ('public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)', '3a7d8eb57e48badff9ab7e321e6c52f6'),
      ('public.workflow_advance_locked(uuid, boolean)', 'b46b5f42927697ebbb8176f8ce527c6d'),
      ('public.api_creative_refusal(text, text, text)', 'a5db9f56ba2e83c285beaace621217d8'),
      ('public.creative_failed_job_codes()', '2abde1f23d4729dec2ee73935f0c1c6c'),
      ('public.creative_failed_job_gate(uuid)', 'db8553de657fe2ee8c801879fe8b8735')) v(sig, want) loop
    if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(r.sig)) is distinct from r.want then
      raise exception '0175 end state: % is not 0175''s body', r.sig;
    end if;
  end loop;
  -- The two doors a member calls stay SECURITY DEFINER with the pinned search_path, executable by signed-in users only.
  for r in select * from (values
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', true),
      ('public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)', true),
      ('public.workflow_advance_locked(uuid, boolean)', false)) v(sig, member) loop
    if exists (select 1 from pg_proc p where p.oid = to_regprocedure(r.sig)
                and (not p.prosecdef or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                     or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp')))
       or has_function_privilege('anon', r.sig, 'EXECUTE')
       or has_function_privilege('service_role', r.sig, 'EXECUTE')
       or has_function_privilege('authenticated', r.sig, 'EXECUTE') is distinct from r.member then
      raise exception '0175 end state: % is not a SECURITY DEFINER with the pinned search_path and the intended grants', r.sig;
    end if;
  end loop;
  -- Internal: no API role calls these; the gate is not a way to read another organization's failures.
  for r in select * from unnest(array['public.api_creative_refusal(text, text, text)', 'public.creative_failed_job_codes()',
                                      'public.creative_failed_job_gate(uuid)']) sig,
                         unnest(array['anon', 'authenticated', 'service_role']) role_ loop
    if has_function_privilege(r.role_, r.sig, 'EXECUTE') then
      raise exception '0175 end state: % may call %', r.role_, r.sig;
    end if;
  end loop;
  if pg_get_indexdef(to_regclass('public.creative_jobs_failed_window_idx'))
     is distinct from 'CREATE INDEX creative_jobs_failed_window_idx ON public.creative_jobs USING btree (org_id, status, finished_at)' then
    raise exception '0175 end state: the failed-window index is missing or not this file''s';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying, AND after any manual replay of 0083 or 0174; every column should read true). A false gate column
-- means an older file was re-run over this one and the cap is gone: apply 0175 again (see REPLAY above).
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.create_creative_job(uuid,text,text,jsonb,text,text,numeric)'::regprocedure) = '1ddd39a69de4153e36d02aa372ed5e60' as job_gate,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.start_workflow_run(uuid,uuid,integer,jsonb,numeric)'::regprocedure) = '3a7d8eb57e48badff9ab7e321e6c52f6'         as workflow_start_gate,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.workflow_advance_locked(uuid,boolean)'::regprocedure) = 'b46b5f42927697ebbb8176f8ce527c6d'                        as workflow_wait_word,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.api_creative_refusal(text,text,text)'::regprocedure) = 'a5db9f56ba2e83c285beaace621217d8'                         as api_answer,
--   public.creative_failed_job_codes() = array['policy','bad_request','invalid_params','source_unavailable','source_too_large','provider_error'] as counted_codes,
--   to_regclass('public.creative_jobs_failed_window_idx') is not null                                                as window_index,
--   not has_function_privilege('authenticated', 'public.creative_failed_job_gate(uuid)', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.creative_failed_job_gate(uuid)', 'EXECUTE')             as gate_internal;
