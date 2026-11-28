-- rollback_0226_org_spender_everywhere.sql — takes migration 0226 (only a member spends an organization's credits, on every path)
-- out. OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT COMES BACK, verbatim: the twenty-eight earlier bodies below. A platform owner or admin with no seat in an organization may again
--   spend its credits on these paths (0043's accessible_org_ids), and an API key or a connected app made by one keeps spending there.
--   The film paths keep 0215's rule (take 0215 out for those).
-- WHAT IS KEPT: everything else. 0226 added no table, column or function; nothing it refused was written.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if any of the twenty-eight bodies is not 0226's (a later change would be undone).
--   1. Puts the earlier bodies back, verbatim, with their grants.
--   2. Asserts the end state.
--
-- The bodies (md5, whitespace runs read as one space; earlier -> 0226):
--   reserve_credits            admin   20800909ce4fdbcff87c5a99e735299f (0094) -> 0fc6122a91a6287c632a59f2855a0d14
--   create_creative_job        viewer  a5e00e65d1161bccd2acefb7745e659b (0192) -> ab939bb64ef626e30c1438c6030d8801
--   start_workflow_run         editor  67c4d21342ed9c6c144ec2559d4b34cc (0192) -> 04d4ac338fbce93ceec279aac3fce89d
--   advance_workflow_run       editor  a349d79c4f1ca791135002cef82193a9 (0074) -> a6c798fb11095202b6a71498eef45f35
--   approve_storyboard         admin   69885e5eb4dfebc05f2ca44a51a03a6a (0057) -> 36b3874c4cb8737c907f46e65e237ad0
--   request_scene_regenerate   admin   2fed9d76de1030b44f0121e86e2fb663 (0085) -> 511456091d187f15a98c2b45fc922e87
--   request_repurpose          admin   8771b0e2f943e7ff424482c4c1bbb50d (0080) -> 924ce2a73e0bb9eb1818a59ee5a10adb
--   start_series_episode       admin   f3598d71d76e780b6973f88d8a743d2b (0120) -> e7c93eed4a138fb703cb82408c7dc173
--   request_editor_export      editor  b6c3cdf6e63c02ce982b4f046df63c63 (0136) -> 9320aa81226161a59ca36b1699e51f18
--   request_brand_scan         editor  e696f6295465ae9b321766aea7a40b99 (0133) -> 38861da61bc8723b95897ab1fd23c0e4
--   request_character_swap     editor  8b25050c082a66baf873ff871380ebc3 (0137) -> 83c3388e4124add9522eef573776486d
--   request_download           editor  268af77d1e00070cb96a7c98baeb51b1 (0094) -> f4ae9d569094dc50f5e9df5b36f327f0
--   render_jobs_payment_guard  admin   3807936ade6801fa20da292e27fa7f64 (0122) -> 5f39cc352da2a0a8fd96bcc9b4ce8dd2
--   create_api_key             admin   4b311587d0f62ade8334beec83049e01 (0042) -> c751606e0eafff55b916e603c1d78f2e
--   api_begin                  admin   8b3b4fb4f4a5ab698584bc4f30e9fd14 (0093) -> 9ff0b39b5c5f86b82a4df3054b1908e8
--   oauth_ctx                  admin   fe42c9e4f53a6c9aaba40077ce905cdc (0147) -> 8cf90c6006cf30dc492c56fbfdcdb789
--   workflow_confirmer_may_spend editor  bf5b3922c06fb82f832de36394e88ef7 (0074) -> f3869c81bfc92baa38380830943f9985
--   ai_chat_start              editor  f2365e962c429bd2640e5b3b155a32d5 (0199) -> a8f1f8c7b6880c44fe0ccdb32e2ccbc5
--   ai_chat_reserve_turn       editor  7c89309bd1e2c15109d3824cc1104df8 (0199) -> e105fa9373fac86e9a36cf4a945a21b4
--   set_api_key_access         admin   31a0ee1c15ba91f948446f95c8aeb1d2 (0062) -> 3255e1411d0d2ec9d5a85121e62d1dd3
--   set_api_key_limit          admin   538ad2e8ed9ab8eac10e11e3e60ba655 (0031) -> c2b04ddeacdc908d02be94360bcc8e66
--   api_activate               admin   8cc2ead31d60e2c809c9e2ca4f161b90 (0031) -> 345750e4dfb8abdf49076e222b9ed22d
--   ai_chat_plan_session       editor  872b3f926f9dcf658b8a8efc097397f5 (0211) -> 75c679292759d14dc51ba865f32d6f8e
--   ai_chat_plan_begin         editor  bcb630a57a5be419f80e5a9e2b9ce588 (0211) -> 2002d73eb60ad129f7318416ba560da6
--   ai_chat_plan_end           editor  5b94856b084a3941a39eb825baa8ed5e (0211) -> 4df6a1c4054bcacedf971a0b79f997d6
--   api_set_monthly_limit      admin   de4c4102641f01de27a71dd57db6b13f (0031) -> 573c8790a6db4affd8a0ee58928fea75
--   oauth_decide_authorization admin   3b5236152d66117425e44e2d5132b9eb (0147) -> 86a1707d0dd3bd7feba84454206e821b
--   cancel_workflow_run        editor  d168fa9af136f070ae655c951a95cc0e (0074) -> 427ead0896b4881c0739b944997c6b50

begin;
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.reserve_credits(uuid, text, numeric)', '0fc6122a91a6287c632a59f2855a0d14'),
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', 'ab939bb64ef626e30c1438c6030d8801'),
      ('public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)', '04d4ac338fbce93ceec279aac3fce89d'),
      ('public.advance_workflow_run(uuid)', 'a6c798fb11095202b6a71498eef45f35'),
      ('public.approve_storyboard(uuid, numeric, text)', '36b3874c4cb8737c907f46e65e237ad0'),
      ('public.request_scene_regenerate(text, text, text, text, numeric, text)', '511456091d187f15a98c2b45fc922e87'),
      ('public.request_repurpose(text, jsonb, numeric, text)', '924ce2a73e0bb9eb1818a59ee5a10adb'),
      ('public.start_series_episode(uuid, numeric, text, boolean)', 'e7c93eed4a138fb703cb82408c7dc173'),
      ('public.request_editor_export(uuid, integer, text, numeric)', '9320aa81226161a59ca36b1699e51f18'),
      ('public.request_brand_scan(uuid, text, text, numeric)', '38861da61bc8723b95897ab1fd23c0e4'),
      ('public.request_character_swap(uuid, uuid, uuid, uuid[], text, text, text, uuid, numeric, text)', '83c3388e4124add9522eef573776486d'),
      ('public.request_download(text, text, numeric)', 'f4ae9d569094dc50f5e9df5b36f327f0'),
      ('public.render_jobs_payment_guard()', '5f39cc352da2a0a8fd96bcc9b4ce8dd2'),
      ('public.create_api_key(uuid, text, bigint)', 'c751606e0eafff55b916e603c1d78f2e'),
      ('public.api_begin(text, text, text)', '9ff0b39b5c5f86b82a4df3054b1908e8'),
      ('public.oauth_ctx(text, text, text)', '8cf90c6006cf30dc492c56fbfdcdb789'),
      ('public.workflow_confirmer_may_spend(uuid, uuid)', 'f3869c81bfc92baa38380830943f9985'),
      ('public.ai_chat_start(uuid, text)', 'a8f1f8c7b6880c44fe0ccdb32e2ccbc5'),
      ('public.ai_chat_reserve_turn(uuid, text, boolean, text)', 'e105fa9373fac86e9a36cf4a945a21b4'),
      ('public.set_api_key_access(uuid, text[], integer, numeric)', '3255e1411d0d2ec9d5a85121e62d1dd3'),
      ('public.set_api_key_limit(uuid, bigint)', 'c2b04ddeacdc908d02be94360bcc8e66'),
      ('public.api_activate(uuid, text)', '345750e4dfb8abdf49076e222b9ed22d'),
      ('public.ai_chat_plan_session(uuid)', '75c679292759d14dc51ba865f32d6f8e'),
      ('public.ai_chat_plan_begin(uuid, bigint, integer)', '2002d73eb60ad129f7318416ba560da6'),
      ('public.ai_chat_plan_end(uuid, integer, text, text)', '4df6a1c4054bcacedf971a0b79f997d6'),
      ('public.api_set_monthly_limit(uuid, bigint)', '573c8790a6db4affd8a0ee58928fea75'),
      ('public.oauth_decide_authorization(text, boolean, numeric, text)', '86a1707d0dd3bd7feba84454206e821b'),
      ('public.cancel_workflow_run(uuid)', '427ead0896b4881c0739b944997c6b50')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0226: % is not 0226''s body (md5 %): if an older file was re-run over it, apply 0226 again first, then roll back; if a later file changed it, take that file out first', r.sig, h;
    end if;
  end loop;
end $$;

-- reserve_credits: 0094's body, verbatim.
create or replace function public.reserve_credits(p_org uuid, p_job_id text, p_amount numeric)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  amt     numeric := public.credits_round_up(p_amount);
  job     text := btrim(coalesce(p_job_id, ''));
  acc     public.credit_accounts;
  floor_c numeric;
  avail   numeric;
  spend_  numeric;
begin
  if not (public.credits_trusted_caller() or public.is_org_member(p_org, 'admin')) then
    raise exception 'only an owner or admin of this organization may start a paid run'
      using errcode = '42501';
  end if;
  if job !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$' then
    raise exception 'invalid job reference' using errcode = '22023';
  end if;
  if public.credits_exempt(p_org) then
    return jsonb_build_object('exempt', true, 'job_id', job, 'reserved', 0);
  end if;
  if amt is null or amt <= 0 or amt > 100000000 then
    raise exception 'amount must be a positive number of credits' using errcode = '22023';
  end if;
  -- The platform's floor. A browser can call this function directly with any
  -- amount, and a capture never exceeds its hold, so a hold smaller than the
  -- floor would be a cheap run.
  select credits_per_unit into floor_c from public.credit_prices where unit = 'job_minimum';
  if floor_c is not null and amt < public.credits_round_up(floor_c) then
    raise exception 'reservation below the platform minimum of % credits', public.credits_round_up(floor_c)
      using errcode = '22023';
  end if;

  acc := public.credit_account_lock(p_org);
  -- Stale holds of this org first, so a failed dispatch hours ago does not
  -- keep this run from starting. Runs as the definer: the caller's own claims
  -- would not pass expire's trusted-caller check, so call the release directly.
  perform public.credit_release_locked(c.job_id,
            case when c.started_at is null then 'expired: the run never started'
                 else 'expired: the run never settled' end)
     from public.credit_reservations c
    where c.org_id = p_org and c.status = 'open'
      and ((c.started_at is null and c.created_at < now() - interval '3 hours')
           or (c.started_at is not null and c.started_at < now() - interval '24 hours'));
  select * into acc from public.credit_accounts where org_id = p_org;

  if exists (select 1 from public.credit_reservations where job_id = job) then
    raise exception 'a reservation for this job already exists' using errcode = '23505';
  end if;

  avail := acc.balance - acc.reserved;
  if avail < amt then
    raise exception 'insufficient credits'
      using errcode = 'NS402',
            detail = format('available=%s needed=%s', avail, amt),
            hint = 'Add credits to this organization, or start a shorter run.';
  end if;

  -- 0094: with extra credits off, the run may start only on credit that is not
  -- a top-up pack. Refused here, before any hold, with the figures the person
  -- needs: what the plan side can pay, what the run needs, what is waiting in
  -- packs. The same NS402 code as an empty balance.
  if not acc.use_extra_credits then
    spend_ := public.credit_spendable_internal(p_org);
    if spend_ < amt then
      raise exception 'insufficient credits'
        using errcode = 'NS402',
              detail = format('available=%s needed=%s extra_off=1 extra=%s', spend_, amt, greatest(avail - spend_, 0)),
              hint = 'Extra credits are off for this organization. Turn them on, add credits, or upgrade the plan.';
    end if;
  end if;

  insert into public.credit_reservations (job_id, org_id, amount, created_by)
  values (job, p_org, amt, auth.uid());
  update public.credit_accounts
     set reserved = reserved + amt, updated_at = now()
   where org_id = p_org
  returning * into acc;
  perform public.credit_log(p_org, 'reserve', amt, job, null, null);

  return jsonb_build_object('exempt', false, 'job_id', job, 'reserved', amt,
                            'balance', acc.balance, 'available', acc.balance - acc.reserved);
end
$$;

-- create_creative_job: 0192's body, verbatim.
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

-- start_workflow_run: 0192's body, verbatim.
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

  if p_version is distinct from w.version then
    perform public.creative_refuse('workflow_changed',
      format('the workflow is now version %s, not %s', w.version, p_version), 'NS409');
  end if;

  vals := public.workflow_bind_inputs(w, p_inputs);
  q := public.workflow_quote_steps(w, vals);
  -- 0192: every step's adult problem before step 1 is held (rule 6, as film_adult_refusals for a film): a person who said they are
  -- under 18 starts nothing (adult_only_service); a step whose model's vendor terms are 18+ needs an adult answer
  -- (adult_attestation_required, the model named). The later steps ask again when they are made, as the confirmer.
  for st in select v, ord from jsonb_array_elements(w.steps) with ordinality as t(v, ord) loop
    perform public.adult_attestation_gate(uid, st.v ->> 'model');
  end loop;
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

-- advance_workflow_run: 0074's body, verbatim.
create or replace function public.advance_workflow_run(p_run uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r public.workflow_runs;
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
  if public.credits_exempt(r.org_id) and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The account, then the run (inside workflow_advance_locked): the order
  -- Run now takes, so a re-sent Run now and this poll queue instead of
  -- deadlocking (BR-L-005).
  perform public.credit_account_lock(r.org_id);
  perform public.workflow_advance_locked(p_run);
  return public.workflow_run_json(p_run);
end
$$;

-- approve_storyboard: 0057's body, verbatim.
create or replace function public.approve_storyboard(p_storyboard uuid, p_amount numeric, p_backend text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  sb      public.storyboards;
  v_org   uuid;
  v_ref   text;
  v_held  numeric;
  v_job   bigint;
  v_res   jsonb;
  jm      numeric;
  vm      public.credit_prices;
  v_need  numeric;
begin
  sb := public.storyboard_lock_for_runner(p_storyboard);
  if p_backend is null or p_backend not in ('queue', 'actions') then
    raise exception 'invalid_backend' using errcode = '22023';
  end if;
  -- Before anything is held: a second press, a replay or a second admin
  -- waits on the lock above and stops here.
  if sb.status <> 'ready' then
    raise exception 'storyboard_not_ready' using errcode = 'NS409', detail = sb.status;
  end if;

  v_org := public.channel_org(sb.channel_id);
  if v_org is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if not public.credits_exempt(v_org) then
    if p_amount is null then
      raise exception 'price_required' using errcode = '22023';
    end if;
    -- The floor for THIS storyboard's length — what render_jobs_payment_guard
    -- (0041) requires of a queued run of that length, and what the Actions
    -- runner checks (modules/credits.minimum_reservation). A browser can call
    -- this function directly with any amount; it cannot buy a render below it.
    select credits_per_unit into jm from public.credit_prices where unit = 'job_minimum';
    select * into vm from public.credit_prices where unit = 'video_minute';
    v_need := public.credits_round_up(greatest(
      coalesce(jm, 0),
      coalesce(vm.credits_per_unit * (1 + vm.margin) * sb.duration_s / 60, 0)));
    if v_need > 0 and public.credits_round_up(p_amount) < v_need then
      raise exception 'below_floor' using errcode = '22023', detail = format('needed=%s', v_need);
    end if;
    -- One reference per approval of this storyboard: reserve_credits refuses a
    -- reused one (23505), so no path holds twice for the same press.
    v_ref := case p_backend when 'queue' then 'rj-' else 'gh-' end
             || 'sb' || (sb.approvals + 1)::text || '-' || replace(sb.id::text, '-', '');
    v_res := public.reserve_credits(v_org, v_ref, p_amount);
    if coalesce((v_res ->> 'exempt')::boolean, false) then
      v_ref := null;
    else
      v_held := (v_res ->> 'reserved')::numeric;
    end if;
  end if;

  update public.storyboards
     set status = 'approved', decided_by = auth.uid(), decided_at = now(),
         approvals = approvals + 1, backend = p_backend,
         credit_ref = v_ref, credits_held = v_held
   where id = sb.id;

  if p_backend = 'queue' then
    -- The render resumes this run from its approved script: the topic names
    -- the run (its slug), and the length is the one just priced. The 0041
    -- trigger checks the hold against that length like any queued run.
    insert into public.render_jobs (channel_id, kind, params, requested_by, credit_ref)
    values (sb.channel_id, 'daily',
            jsonb_build_object('topic', sb.topic, 'duration', sb.duration_s, 'resume', true),
            auth.uid(), v_ref)
    returning id into v_job;
    update public.storyboards set render_job_id = v_job where id = sb.id;
  end if;

  return jsonb_build_object(
    'id', sb.id, 'status', 'approved', 'backend', p_backend,
    'credit_ref', v_ref, 'credits_held', v_held, 'render_job_id', v_job,
    'topic', sb.topic, 'duration_s', sb.duration_s, 'channel_id', sb.channel_id);
end
$$;

-- request_scene_regenerate: 0085's body, verbatim.
create or replace function public.request_scene_regenerate(
  p_video text, p_scene text, p_prompt text, p_source text, p_max_credits numeric, p_idem text
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v        public.videos;
  v_org    uuid;
  v_exempt boolean;
  v_prompt text := nullif(btrim(coalesce(p_prompt, '')), '');
  v_source text := coalesce(nullif(btrim(coalesce(p_source, '')), ''), 'same');
  v_hash   text;
  prior    public.scene_regenerations;
  plan     jsonb;
  price    jsonb;
  v_price  numeric;
  v_id     uuid := gen_random_uuid();
  v_ref    text;
  v_res    jsonb;
  v_job    bigint;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v from public.videos where video_id = p_video;
  -- The Run now rule: an admin of the channel's organization. A viewer or
  -- editor, another organization, and a video that does not exist all get
  -- the same refusal before anything is looked at.
  if v.video_id is null or not (v.channel_id in (select public.accessible_channel_ids('admin'))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_org := public.channel_org(v.channel_id);
  if v_org is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_idem is null or p_idem !~ '^[A-Za-z0-9_:.-]{8,128}$' then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;
  if p_scene is null or p_scene !~ '^s[0-9]{3,4}$' then
    raise exception 'invalid_scene' using errcode = '22023';
  end if;
  if v_source not in ('same', 'stock') then
    raise exception 'invalid_source' using errcode = '22023';
  end if;
  if v_prompt is not null and (char_length(v_prompt) > 1000 or v_prompt ~ '[[:cntrl:]]') then
    raise exception 'invalid_prompt' using errcode = '22023';
  end if;

  -- Presses on one video take turns: a double click, a second tab or a second
  -- admin waits here, then sees the first one's row.
  perform pg_advisory_xact_lock(hashtextextended('scene_regenerate:' || v.video_id, 0));

  v_hash := md5(jsonb_build_object('video', v.video_id, 'scene', p_scene, 'source', v_source,
                                   'prompt', v_prompt)::text);
  select * into prior from public.scene_regenerations
   where org_id = v_org and idempotency_key = p_idem;
  if prior.id is not null then
    if prior.request_hash <> v_hash then
      raise exception 'idempotency_conflict' using errcode = 'NS409';
    end if;
    -- The same press again (a retry, a replay): its job, nothing held twice.
    return jsonb_build_object('id', prior.id, 'status', prior.status, 'render_job_id', prior.render_job_id,
                              'credits_held', prior.quoted_credits, 'credit_ref', prior.credit_ref,
                              'replayed', true);
  end if;

  if public.scene_regen_published(v) then
    raise exception 'published' using errcode = 'NS409';
  end if;
  if coalesce(v.slug, '') !~ '^[a-z0-9][a-z0-9-]{0,63}$' then
    raise exception 'scene_unavailable' using errcode = 'NS400', detail = 'no_run';
  end if;
  if exists (select 1 from public.scene_regenerations
              where video_id = v.video_id and status in ('queued', 'running')) then
    raise exception 'in_progress' using errcode = 'NS409';
  end if;
  plan := public.scene_regen_plan(v.manifest, p_scene, v_source);
  if not coalesce((plan ->> 'ok')::boolean, false) then
    raise exception 'scene_unavailable' using errcode = 'NS400', detail = plan ->> 'reason';
  end if;

  v_exempt := public.credits_exempt(v_org);
  if not v_exempt then
    price := public.scene_regen_price(plan);
    if price ->> 'status' <> 'priced' then
      raise exception 'unpriced' using errcode = 'NS400';
    end if;
    v_price := (price ->> 'credits')::numeric;
    -- The press carries the price the person saw; without one nothing is spent.
    if p_max_credits is null then
      raise exception 'price_required' using errcode = '22023', detail = format('credits=%s', v_price);
    end if;
    -- 0085 (BR-L-044): numeric orders NaN and Infinity above every price, so
    -- "v_price > NaN" is false and the press would have carried no ceiling.
    -- A ceiling must be a number; anything else is no price at all.
    if p_max_credits = 'NaN'::numeric or p_max_credits = 'Infinity'::numeric
       or p_max_credits = '-Infinity'::numeric then
      raise exception 'price_required' using errcode = '22023', detail = format('credits=%s', v_price);
    end if;
    if v_price > p_max_credits then
      raise exception 'price_changed' using errcode = 'NS409', detail = format('credits=%s', v_price);
    end if;
    v_ref := 'rj-sr-' || replace(v_id::text, '-', '');
    -- The hold is the quote. reserve_credits checks the caller is an admin of
    -- the organization, the balance, the plan's parallel limit and the floor.
    v_res := public.reserve_credits(v_org, v_ref, v_price);
    if coalesce((v_res ->> 'exempt')::boolean, false) then
      v_ref := null;
      v_price := null;
    end if;
  end if;

  insert into public.scene_regenerations (
    id, org_id, channel_id, video_id, slug, scene_id, requested_source, source_kind, provider, model,
    explicit_stock, prompt, generated_clips, stock_assets, previous_asset_ids, quoted_credits, credit_ref,
    idempotency_key, request_hash, requested_by)
  values (
    v_id, v_org, v.channel_id, v.video_id, v.slug, p_scene, v_source, plan ->> 'source_kind',
    plan ->> 'provider', plan ->> 'model', coalesce((plan ->> 'explicit_stock')::boolean, false), v_prompt,
    (plan ->> 'generated')::integer, (plan ->> 'stock')::integer,
    array(select jsonb_array_elements_text(plan -> 'asset_ids')), v_price, v_ref,
    p_idem, v_hash, auth.uid());

  -- The render job: a repair of this one scene of this run (the run's slug is
  -- the topic scene_repair.find_run locates it by). Never resume, never a
  -- privacy: the worker runs it private and holds the new cut for review.
  insert into public.render_jobs (channel_id, kind, params, requested_by, credit_ref, scene_regeneration_id)
  values (v.channel_id, 'repair', jsonb_build_object('topic', v.slug, 'repair_scenes', p_scene),
          auth.uid(), v_ref, v_id)
  returning id into v_job;
  update public.scene_regenerations set render_job_id = v_job where id = v_id;

  return jsonb_build_object('id', v_id, 'status', 'queued', 'render_job_id', v_job,
                            'credits_held', v_price, 'credit_ref', v_ref, 'replayed', false);
end
$$;

-- request_repurpose: 0080's body, verbatim.
create or replace function public.request_repurpose(
  p_video text, p_clips jsonb, p_max_credits numeric, p_idem text
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v        public.videos;
  v_org    uuid;
  v_exempt boolean;
  v_state  text;
  v_hash   text;
  prior    public.repurpose_requests;
  plan     jsonb;
  price    jsonb;
  v_price  numeric;
  v_unit   numeric;
  v_floor  numeric;
  v_id     uuid := gen_random_uuid();
  v_ref    text;
  v_res    jsonb;
  c        jsonb;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v from public.videos where video_id = p_video;
  -- The Run now rule: an admin of the channel's organization. A viewer or
  -- editor, another organization, and a video that does not exist all get
  -- the same refusal before anything is looked at.
  if v.video_id is null or not (v.channel_id in (select public.accessible_channel_ids('admin'))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_org := public.channel_org(v.channel_id);
  if v_org is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_idem is null or p_idem !~ '^[A-Za-z0-9_:.-]{8,128}$' then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;
  plan := public.repurpose_plan(v.manifest, p_clips);
  if plan ->> 'reason' = 'invalid_clips' then
    raise exception 'invalid_clips' using errcode = '22023';
  end if;

  -- Presses on one video take turns: a double click, a second tab or a second
  -- admin waits here, then sees the first one's row.
  perform pg_advisory_xact_lock(hashtextextended('repurpose:' || v.video_id, 0));

  v_hash := md5(jsonb_build_object('video', v.video_id, 'clips', (
    select coalesce(jsonb_agg(jsonb_build_array(e ->> 'first', e ->> 'last')), '[]'::jsonb)
      from jsonb_array_elements(case when jsonb_typeof(p_clips) = 'array' then p_clips else '[]'::jsonb end) e
     where jsonb_typeof(e) = 'object'))::text);
  select * into prior from public.repurpose_requests
   where org_id = v_org and idempotency_key = p_idem;
  if prior.id is not null then
    if prior.request_hash <> v_hash then
      raise exception 'idempotency_conflict' using errcode = 'NS409';
    end if;
    -- The same press again (a retry, a replay): its row, nothing held twice.
    return jsonb_build_object('id', prior.id, 'status', prior.status, 'clip_count', prior.clip_count,
                              'credits_held', prior.quoted_credits, 'credit_ref', prior.credit_ref,
                              'replayed', true);
  end if;

  v_state := public.repurpose_master_state(v);
  if v_state is not null then
    raise exception 'clips_unavailable' using errcode = 'NS400', detail = v_state;
  end if;
  if exists (select 1 from public.repurpose_requests
              where video_id = v.video_id and status in ('queued', 'running')) then
    raise exception 'in_progress' using errcode = 'NS409';
  end if;
  if not coalesce((plan ->> 'ok')::boolean, false) then
    raise exception 'clips_unavailable' using errcode = 'NS400', detail = plan ->> 'reason';
  end if;

  v_exempt := public.credits_exempt(v_org);
  if not v_exempt then
    price := public.repurpose_price(jsonb_array_length(plan -> 'clips'));
    if price ->> 'status' <> 'priced' then
      raise exception 'unpriced' using errcode = 'NS400';
    end if;
    v_price := (price ->> 'credits')::numeric;
    v_unit := (price ->> 'unit_credits')::numeric;
    v_floor := (price ->> 'floor_credits')::numeric;
    -- The press carries the price the person saw; without one nothing is spent.
    if p_max_credits is null then
      raise exception 'price_required' using errcode = '22023', detail = format('credits=%s', v_price);
    end if;
    if v_price > p_max_credits then
      raise exception 'price_changed' using errcode = 'NS409', detail = format('credits=%s', v_price);
    end if;
    v_ref := 'rp-' || replace(v_id::text, '-', '');
    -- The hold is the quote. reserve_credits checks the caller is an admin of
    -- the organization, the balance and the platform floor.
    v_res := public.reserve_credits(v_org, v_ref, v_price);
    if coalesce((v_res ->> 'exempt')::boolean, false) then
      v_ref := null;
      v_price := null;
      v_unit := null;
      v_floor := null;
    end if;
  end if;

  insert into public.repurpose_requests (
    id, org_id, channel_id, video_id, slug, clip_count, unit_credits, floor_credits, quoted_credits,
    credit_ref, idempotency_key, request_hash, requested_by)
  values (
    v_id, v_org, v.channel_id, v.video_id, v.slug, jsonb_array_length(plan -> 'clips'), v_unit, v_floor,
    v_price, v_ref, p_idem, v_hash, auth.uid());
  for c in select e from jsonb_array_elements(plan -> 'clips') e loop
    insert into public.repurpose_clips (
      request_id, org_id, channel_id, master_id, ordinal, first_scene, last_scene, scene_ids,
      start_s, end_s, duration_s)
    values (
      v_id, v_org, v.channel_id, v.video_id, (c ->> 'position')::integer, c ->> 'first', c ->> 'last',
      array(select jsonb_array_elements_text(c -> 'scene_ids')),
      (c ->> 'start_s')::numeric, (c ->> 'end_s')::numeric, (c ->> 'duration_s')::numeric);
  end loop;

  return jsonb_build_object('id', v_id, 'status', 'queued', 'clip_count', jsonb_array_length(plan -> 'clips'),
                            'credits_held', v_price, 'credit_ref', v_ref, 'replayed', false);
end
$$;

-- start_series_episode: 0120's body, verbatim.
create or replace function public.start_series_episode(
  p_episode uuid, p_max_credits numeric, p_idem text, p_confirmed boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  ep      public.series_episodes;
  pl      public.series_plans;
  v_ex    boolean;
  v_hash  text;
  v_block text;
  v_price numeric;
  v_ref   text;
  v_res   jsonb;
  v_held  numeric;
  v_job   bigint;
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into ep from public.series_episodes where id = p_episode;
  -- A missing episode and another organization's episode are the same answer.
  if ep.id is null or not public.is_org_member(ep.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- The rule reserve_credits applies: an admin of the organization starts a paid run. The operator's own organization is paid by the platform:
  -- only a platform administrator spends there.
  if not public.is_org_member(ep.org_id, 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_ex := public.credits_exempt(ep.org_id);
  if v_ex and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_idem is distinct from 'se:' || ep.id::text then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;
  if p_max_credits is not null and (p_max_credits < 0 or p_max_credits > 100000000) then
    raise exception 'invalid_max_credits' using errcode = '22023';
  end if;

  -- The account first: every hold of this organization queues behind it, so a second press waits here and then finds the first one's rows.
  perform public.credit_account_lock(ep.org_id);
  select * into pl from public.series_plans where id = ep.plan_id for update;
  select * into ep from public.series_episodes where id = p_episode for update;

  v_hash := md5(jsonb_build_object('episode', ep.id, 'max', case when v_ex then null else round(p_max_credits, 2)::text end,
                                   'confirmed', coalesce(p_confirmed, false))::text);
  if ep.status = 'started' then
    if ep.request_hash is distinct from v_hash then
      raise exception 'idempotency_conflict' using errcode = 'NS409';
    end if;
    return public.series_episode_json(ep.id) || jsonb_build_object('replayed', true);
  end if;

  v_block := public.series_episode_blocker(ep.id);
  if v_block is not null then
    raise exception '%', v_block using errcode = 'NS409';
  end if;
  if ep.needs_confirmation and not coalesce(p_confirmed, false) then
    raise exception 'confirmation_required' using errcode = 'NS400';
  end if;
  -- A series that cannot run stops here, before anything is held (main.py would stop it after the hold was taken).
  if pl.series_id is not null and not exists (
       select 1 from public.content_series s
        where s.series_id = pl.series_id and s.channel_id = pl.channel_id and upper(btrim(s.status)) = 'ACTIVE') then
    raise exception 'series_not_runnable' using errcode = 'NS409';
  end if;

  if not v_ex then
    v_price := public.series_episode_price(ep.duration_s);
    if v_price is null then
      raise exception 'unpriced' using errcode = 'NS400';
    end if;
    if p_max_credits is null then
      raise exception 'price_required' using errcode = '22023', detail = format('credits=%s', v_price);
    end if;
    if round(p_max_credits, 2) <> v_price then
      raise exception 'price_changed' using errcode = 'NS409', detail = format('credits=%s', v_price);
    end if;
    v_ref := 'rj-se-' || replace(ep.id::text, '-', '');
    -- The hold is the price. reserve_credits checks the caller is an admin of the organization and the balance (NS402 when short).
    v_res := public.reserve_credits(ep.org_id, v_ref, v_price);
    if coalesce((v_res ->> 'exempt')::boolean, false) then
      v_ref := null;
    else
      v_held := (v_res ->> 'reserved')::numeric;
    end if;
  end if;

  -- The run: an ordinary 'daily' job with an explicit topic, this episode's length and its series. render_jobs_payment_guard checks the hold
  -- covers that length like any queued run.
  insert into public.render_jobs (channel_id, kind, params, requested_by, credit_ref)
  values (pl.channel_id, 'daily',
          jsonb_strip_nulls(jsonb_build_object('topic', ep.topic, 'niche', pl.niche, 'language', pl.language,
                                               'duration', ep.duration_s, 'series', pl.series_id)),
          uid, v_ref)
  returning id into v_job;

  update public.series_episodes
     set status = 'started', idempotency_key = p_idem, request_hash = v_hash, credit_ref = v_ref, credits_held = v_held,
         render_job_id = v_job, started_by = uid, started_at = now()
   where id = ep.id;

  return public.series_episode_json(ep.id) || jsonb_build_object('replayed', false);
end
$$;

-- request_editor_export: 0136's body, verbatim.
create or replace function public.request_editor_export(p_project uuid, p_rev integer, p_frame text, p_max_credits numeric) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  p       public.editor_projects;
  problem text;
  total   numeric;
  e       public.editor_exports;
  frame_id text;   -- 0129
  frame_w  integer;   -- 0129
  frame_h  integer;   -- 0129
  own      boolean := p_frame = 'project';   -- 0136
  terms    jsonb;   -- 0132
  price    numeric;   -- 0132
  hold_c   numeric;   -- 0132
  ref      text;   -- 0132
  held     jsonb;   -- 0132
  why      text;   -- 0132
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into p from public.editor_projects where id = p_project for update;
  if not found or p.deleted_at is not null or not public.is_org_member(p.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- 0129 the frame, from the database's own closed list and only AFTER membership: null, a made-up word, a padded or upper-case id
  -- 0129 and a size typed as text are one refusal. Width and height are read from the list, never from the caller.
  select f.id, f.width, f.height into frame_id, frame_w, frame_h from public.editor_export_frame(p_frame) f;   -- 0129
  -- 0136 'project' is the project's OWN frame (exported without a frame on the row, as the two-argument function does), sold only up to
  -- 0136 1080p: its width and height are the document's, two whole numbers, never the caller's.
  if own and jsonb_typeof(p.doc -> 'width') = 'number' and jsonb_typeof(p.doc -> 'height') = 'number'   -- 0136
     and p.doc ->> 'width' ~ '^[1-9][0-9]{0,4}$' and p.doc ->> 'height' ~ '^[1-9][0-9]{0,4}$' then   -- 0136
    frame_w := (p.doc ->> 'width')::integer;   -- 0136
    frame_h := (p.doc ->> 'height')::integer;   -- 0136
    if frame_w::bigint * frame_h > 2073600 then   -- 0136
      raise exception 'hires_needs_paid_export' using errcode = 'NS400', detail = 'max_px=2073600';   -- 0136
    end if;   -- 0136
  elsif frame_id is null then   -- 0136 replaces: if frame_id is null then   -- 0129
    raise exception 'invalid_frame' using errcode = 'NS400';   -- 0129
  end if;   -- 0129
  -- 0132 only a frame above 1080p is sold here; a free one keeps going through the three-argument function.
  if frame_w::bigint * frame_h <= 2073600 and public.editor_export_price_1080p() is null then   -- 0136 replaces: if frame_w::bigint * frame_h <= 2073600 then   -- 0132
    raise exception 'invalid_frame' using errcode = 'NS400', detail = 'not a paid frame';   -- 0132
  end if;   -- 0132
  -- 0132 spending the organization's credits is an editor's (a viewer may still ask for a free export), and in the exempt organization a
  -- 0132 platform owner's or admin's (as a creative job, 0036).
  if not public.is_org_member(p.org_id, 'editor') or (public.credits_exempt(p.org_id) and not public.is_platform_admin()) then   -- 0132
    raise exception 'forbidden' using errcode = '42501', detail = 'a paid export is asked by an editor or above';   -- 0132
  end if;   -- 0132
  if p_rev is null or p_rev <> p.rev then
    raise exception 'stale_revision' using errcode = 'NS409', detail = format('current=%s', p.rev);
  end if;
  -- Again now: a file used by the project may have been deleted since it was saved.
  problem := public.editor_doc_problem(p.org_id, p.doc);
  if problem is not null then
    raise exception '%', problem using errcode = 'NS400';
  end if;
  total := public.editor_doc_rendered_length(p.doc);   -- 0136 replaces: total := public.editor_doc_duration(p.doc);
  if total is null then
    raise exception 'invalid_doc' using errcode = 'NS400';
  end if;
  if total <= 0 then
    raise exception 'empty' using errcode = 'NS400';
  end if;
  if total > 1800 then
    raise exception 'too_long' using errcode = 'NS400', detail = 'max_s=1800';
  end if;
  -- 0136 a speed curve is sold at its RENDERED length (editor_doc_rendered_length integrates it, as the renderer does): 0132's refusal goes.
  -- 0136 replaces: -- 0132 a speed curve is not sold: editor_doc_duration does not integrate one and the renderer does, so the length priced here would not
  -- 0136 replaces: -- 0132 be the length rendered (a 45 s range at a quarter of the speed is 180 s on screen).
  -- 0136 replaces: if jsonb_path_exists(p.doc, 'lax $.tracks[*].clips[*].speed_curve') then   -- 0132
  -- 0136 replaces:   raise exception 'hires_speed_curve' using errcode = 'NS400';   -- 0132
  -- 0136 replaces: end if;   -- 0132
  -- 0132 the tier's cap and price, before anything is locked or held. The length is the one the row will store (rounded to the ms).
  terms := public.editor_export_hires_terms(frame_w, frame_h, round(total, 3));   -- 0132
  if round(total, 3) > (terms ->> 'max_s')::numeric then   -- 0132
    raise exception 'hires_too_long' using errcode = 'NS400', detail = format('max_s=%s', terms ->> 'max_s');   -- 0132
  end if;   -- 0132
  if jsonb_typeof(p.doc -> 'fps') = 'number' and (p.doc ->> 'fps')::numeric > (terms ->> 'max_fps')::numeric then   -- 0132
    raise exception 'hires_fps' using errcode = 'NS400', detail = format('max_fps=%s', terms ->> 'max_fps');   -- 0132
  end if;   -- 0132
  -- 0132 the charge (what done captures) and the hold (the charge raised to job_minimum, which reserve_credits demands of any hold).
  price := (terms ->> 'credits')::numeric;   -- 0132
  hold_c := (terms ->> 'hold')::numeric;   -- 0132
  if price is null then   -- 0132
    raise exception 'not_on_sale' using errcode = 'NS403';   -- 0132
  end if;   -- 0132
  -- 0132 the caller's number is compared with the CHARGE, never the hold. NaN and the infinities are numerics too, and a comparison with
  -- 0132 NaN is never true: they are refused like a missing number.
  if p_max_credits is null or not (p_max_credits between 0 and 100000000) or price > p_max_credits then   -- 0132
    raise exception 'price_changed' using errcode = 'NS409', detail = format('price=%s confirmed=%s', price, p_max_credits);   -- 0132
  end if;   -- 0132
  if hold_c is null or hold_c < price then   -- 0132
    raise exception '0132: the hold % is below the charge %', hold_c, price;   -- 0132
  end if;   -- 0132

  -- One request per organization at a time: the limits hold under parallel clicks.
  perform pg_advisory_xact_lock(hashtextextended('editor_exports:' || p.org_id::text, 0));
  -- 0129 one at a time per project PER FRAME SIZE: the same picture twice is refused, another size is another file. An export in
  -- 0129 flight without a frame is the size of the document it copied (jsonb compares numbers by value, and never raises on a doc
  -- 0129 whose width is not a number). The organization's three in flight and twenty a day below are 0054's lines, unchanged, and
  -- 0129 each frame counts as one.
  if exists (select 1 from public.editor_exports
              where project_id = p.id and status in ('queued', 'rendering') and coalesce(to_jsonb(frame_width), doc -> 'width') = to_jsonb(frame_w) and coalesce(to_jsonb(frame_height), doc -> 'height') = to_jsonb(frame_h)) then   -- 0129 replaces: where project_id = p.id and status in ('queued', 'rendering')) then
    raise exception 'export_in_progress' using errcode = 'NS409';
  end if;
  if (select count(*) from public.editor_exports
       where org_id = p.org_id and status in ('queued', 'rendering')) >= 3 then
    raise exception 'export_in_progress' using errcode = 'NS409', detail = 'max_active=3';
  end if;
  if (select count(*) from public.editor_exports
       where org_id = p.org_id and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'daily_limit' using errcode = 'NS429', detail = 'max=20';
  end if;

  insert into public.editor_exports (org_id, project_id, rev, doc, duration_s, requested_by)
  values (p.org_id, p.id, p.rev, p.doc, round(total, 3), auth.uid())
  returning * into e;
  -- 0132 the hold, keyed by the export: after every limit, so a refused request holds nothing. Too few credits for the HOLD roll the whole
  -- 0132 call back. Started at once, so reserve_credits' sweep of holds nobody started (three hours) cannot return it while the export waits.
  ref := 'ee:' || e.id::text;   -- 0132
  begin   -- 0132
    held := public.creative_platform_reserve(p.org_id, ref, hold_c);   -- 0132
  exception when sqlstate 'NS402' then   -- 0132
    get stacked diagnostics why = pg_exception_detail;   -- 0132
    raise exception 'insufficient_credits' using errcode = 'NS402', detail = format('hold=%s charge=%s %s', hold_c, price, why);   -- 0132
  when sqlstate 'NS429' then   -- 0132
    get stacked diagnostics why = pg_exception_detail;   -- 0132
    raise exception 'parallel_runs' using errcode = 'NS429', detail = why;   -- 0132
  end;   -- 0132
  if coalesce((held ->> 'exempt')::boolean, false) then   -- 0132
    ref := null;   -- 0132
  else   -- 0132
    perform public.editor_export_money('start', ref, null);   -- 0132
  end if;   -- 0132
  -- 0129 the frame is stamped on the row this call just made, in the same transaction: nobody ever sees it without one.
  update public.editor_exports   -- 0129
     set frame_preset = frame_id, frame_width = case when own then null else frame_w end, frame_height = case when own then null else frame_h end, quoted_credits = price, held_credits = case when ref is null then null else hold_c end, credit_ref = ref   -- 0136 replaces: set frame_preset = frame_id, frame_width = frame_w, frame_height = frame_h, quoted_credits = price, held_credits = case when ref is null then null else hold_c end, credit_ref = ref   -- 0132 replaces: set frame_preset = frame_id, frame_width = frame_w, frame_height = frame_h   -- 0129
   where id = e.id;   -- 0129
  return e.id;
end
$$;

-- request_brand_scan: 0133's body, verbatim.
-- This body holds a backslash. A backslash can be rewritten on its way through an apply tool, so this file holds none:
-- the statement is run through EXECUTE, each backslash spelled <0226:backslash> and turned back into chr(92). Its source is unchanged.
do $bs0226$
begin
  execute replace($fn0226$create or replace function public.request_brand_scan(p_org uuid, p_url text, p_idem text, p_max_credits numeric) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  v_url   text;
  v_host  text;
  v_hash  text;
  v_price numeric;
  v_floor numeric;
  v_hold  numeric;
  v_cap   integer;
  v_ocap  integer;
  v_id    uuid := gen_random_uuid();
  v_ref   text;
  res     jsonb;
  prior   public.brand_scans;
  d       public.brand_domains;
  stale   record;
begin
  if uid is null or p_org is null or not public.is_org_member(p_org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The operator's organization is paid for by the platform: only a platform admin spends there (create_creative_job's rule).
  if public.credits_exempt(p_org) and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501',
      detail = 'scans in the operator''s organization are started by a platform admin';
  end if;
  -- Read only now, after sign-in and the role.
  v_url := btrim(coalesce(p_url, ''));
  if v_url = '' or not public.ads_site_url_ok(v_url) or position(E'<0226:backslash><0226:backslash>' in v_url) > 0 then
    raise exception 'invalid_url' using errcode = 'NS400';
  end if;
  v_host := substring(v_url from '^https://([^/]+)');
  if public.ads_hosting_parent(v_host) then
    raise exception 'hosting_parent' using errcode = 'NS400';
  end if;
  if not public.ads_scan_host_ok(v_host) then
    raise exception 'invalid_url' using errcode = 'NS400';
  end if;
  if p_idem is null or p_idem !~ '^[A-Za-z0-9_:.-]{8,128}$' then
    raise exception 'invalid_idempotency_key' using errcode = 'NS400';
  end if;
  -- NaN and the infinities are numerics too, and a comparison with NaN is never true: refused before anything reads them.
  if p_max_credits is not null and not (p_max_credits between 0 and 1000) then
    raise exception 'price_changed' using errcode = 'NS409';
  end if;
  v_hash := md5(jsonb_build_object('url', v_url, 'max_credits', p_max_credits)::text);

  -- Presses of one organization take turns (a double click, a second tab, a second editor): the replay and the counts below are exact.
  perform pg_advisory_xact_lock(hashtextextended('brand_scan:' || p_org::text, 0));
  select * into prior from public.brand_scans where org_id = p_org and idempotency_key = p_idem;
  if prior.id is not null then
    if prior.request_hash <> v_hash then
      raise exception 'idempotency_conflict' using errcode = 'NS409';
    end if;
    return jsonb_build_object('id', prior.id, 'status', prior.status, 'credits', prior.price_credits, 'replayed', true);
  end if;

  v_price := public.brand_scan_price();
  if v_price is null then
    raise exception 'not_on_sale' using errcode = 'NS409';
  end if;
  if p_max_credits is null or v_price > p_max_credits then
    raise exception 'price_changed' using errcode = 'NS409', detail = format('price=%s', v_price);
  end if;

  -- The most specific verified domain that covers the host: itself, or a parent of it.
  select * into d from public.brand_domains
   where org_id = p_org and verified_at is not null
     and (host = v_host or right(v_host, char_length(host) + 1) = '.' || host)
   order by char_length(host) desc
   limit 1;
  if d.id is null then
    raise exception 'domain_not_verified' using errcode = 'NS409';
  end if;

  -- This organization's share of the day (all statuses: a failed scan released its hold, so it cost nothing), under its own lock and before
  -- the platform's. No number in the refusal.
  select s.platform_daily_scans, s.org_daily_scans into v_cap, v_ocap from public.brand_scan_settings s;
  v_cap := coalesce(v_cap, 500);
  v_ocap := coalesce(v_ocap, 20);
  if (select count(*) from public.brand_scans where org_id = p_org and created_at > now() - interval '24 hours') >= v_ocap then
    raise exception 'org_daily_limit' using errcode = 'NS429';
  end if;

  -- Platform-wide, after the organization's lock (0127's order, so two requests never wait on each other). Its refusal carries no number.
  perform pg_advisory_xact_lock(hashtextextended('brand_scan_global', 0));
  -- This organization's scan that nobody took in time, or whose worker went quiet, gives its place and its hold back first.
  for stale in
    select id from public.brand_scans
     where org_id = p_org
       and ((status = 'requested' and created_at < now() - interval '2 hours')
            or (status = 'running' and claimed_at < now() - interval '15 minutes'))
     for update
  loop
    perform public.brand_scan_fail_locked(stale.id, 'expired');
  end loop;
  if exists (select 1 from public.brand_scans where org_id = p_org and status in ('requested', 'running')) then
    raise exception 'scan_in_progress' using errcode = 'NS409';
  end if;
  if (select count(*) from public.brand_scans where created_at > now() - interval '24 hours') >= v_cap then
    raise exception 'platform_busy' using errcode = 'NS429';
  end if;

  -- The hold: the price this function computed, raised to job_minimum (reserve_credits refuses any hold below it), under a reference it
  -- made, never the caller's. Only the price is captured when the scan finishes (finish_brand_scan); the rest of the hold goes back then,
  -- and all of it on a failure. Not enough credits for the hold is said as such (scan_hold_unavailable, with both numbers); NS429 (the
  -- plan's parallel runs) comes through as it is.
  if v_price > 0 then
    select credits_per_unit into v_floor from public.credit_prices where unit = 'job_minimum';
    v_hold := trim_scale(round(greatest(v_price, coalesce(public.credits_round_up(v_floor), 0)), 2));
    if v_hold < v_price then
      raise exception 'brand scan hold % is below its price %', v_hold, v_price;
    end if;
    v_ref := 'bs:' || v_id::text;
    begin
      res := public.creative_platform_reserve(p_org, v_ref, v_hold);
    exception when sqlstate 'NS402' then
      raise exception 'scan_hold_unavailable' using errcode = 'NS402', detail = format('hold=%s price=%s', v_hold, v_price);
    end;
    if coalesce((res ->> 'exempt')::boolean, false) then
      v_ref := null;
    end if;
  end if;
  insert into public.brand_scans (id, org_id, domain_id, requested_by, url, host, status, price_credits, credit_ref, idempotency_key,
                                  request_hash)
  values (v_id, p_org, d.id, uid, v_url, v_host, 'requested', case when v_ref is null then 0 else v_price end, v_ref, p_idem, v_hash);
  return jsonb_build_object('id', v_id, 'status', 'requested', 'credits', case when v_ref is null then 0 else v_price end,
                            'replayed', false);
end
$$$fn0226$, '<0226:backslash>', chr(92));
end $bs0226$;

-- request_character_swap: 0137's body, verbatim.
create or replace function public.request_character_swap(p_org uuid, p_project uuid, p_input uuid, p_refs uuid[], p_prompt text, p_model text,
                                                         p_resolution text, p_consent uuid, p_max_credits numeric, p_idem text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  v_hash  text;
  prob    text;
  v_secs  numeric;
  charge  numeric;
  v_hold  numeric;
  v_id    uuid := gen_random_uuid();
  v_ref   text;
  res     jsonb;
  prior   public.character_swap_jobs;
  c       public.character_swap_consents;
  s       public.character_swap_settings;
begin
  if uid is null or p_org is null or not public.is_org_member(p_org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The operator's organization is paid for by the platform: only a platform admin spends there (create_creative_job's rule).
  if public.credits_exempt(p_org) and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501',
      detail = 'swaps in the operator''s organization are started by a platform admin';
  end if;
  -- Read only now, after sign-in and the role.
  if p_resolution is null or p_resolution not in ('720p', '1080p') then
    raise exception 'invalid_resolution' using errcode = 'NS400';
  end if;
  prob := public.character_swap_prompt_problem(p_prompt);
  if prob is not null then
    raise exception '%', prob using errcode = 'NS400';
  end if;
  if p_idem is null or p_idem !~ '^[A-Za-z0-9_:.-]{8,128}$' then
    raise exception 'invalid_idempotency_key' using errcode = 'NS400';
  end if;
  -- NaN and the infinities are numerics too, and a comparison with NaN is never true: refused before anything reads them.
  if p_max_credits is not null and not (p_max_credits between 0 and 100000) then
    raise exception 'price_changed' using errcode = 'NS409';
  end if;
  v_hash := md5(jsonb_build_object('project', p_project, 'input', p_input, 'refs', to_jsonb(p_refs), 'prompt', p_prompt, 'model', p_model,
                                   'resolution', p_resolution, 'consent', p_consent, 'max_credits', p_max_credits)::text);

  -- Presses of one organization take turns (a double click, a second tab, a second editor): the replay and the counts below are exact.
  perform pg_advisory_xact_lock(hashtextextended('character_swap:' || p_org::text, 0));
  select * into prior from public.character_swap_jobs where org_id = p_org and idempotency_key = p_idem;
  if prior.id is not null then
    if prior.request_hash <> v_hash then
      raise exception 'idempotency_conflict' using errcode = 'NS409';
    end if;
    return jsonb_build_object('id', prior.id, 'status', prior.status, 'credits', prior.charge_credits, 'hold', prior.hold_credits,
                              'replayed', true);
  end if;

  -- The input and the pictures, locked FOR SHARE after the organization's lock (0131's order) and judged under it: a delete cannot slip
  -- between this check and the insert.
  perform 1 from public.media_assets where org_id = p_org and (id = p_input or id = any (coalesce(p_refs, '{}'))) for share;
  prob := public.character_swap_input_problem(p_org, p_model, p_input, p_refs);
  if prob is not null then
    raise exception '%', prob using errcode = 'NS400';
  end if;
  if p_project is not null
     and not exists (select 1 from public.editor_projects where id = p_project and org_id = p_org and deleted_at is null) then
    raise exception 'project_unavailable' using errcode = 'NS400';
  end if;
  select duration_s into v_secs from public.media_assets where id = p_input;

  charge := public.character_swap_charge(p_model, p_resolution, v_secs);
  if charge is null then
    raise exception 'not_on_sale' using errcode = 'NS409';
  end if;
  if p_max_credits is null or charge > p_max_credits then
    raise exception 'price_changed' using errcode = 'NS409', detail = format('charge=%s', charge);
  end if;

  -- The consent this request rests on: the same person, organization, model, video and pictures in the same order, within the hour, and
  -- not the consent of another job.
  select * into c from public.character_swap_consents
   where id = p_consent and org_id = p_org and user_id = uid and model_id = p_model and input_asset_id = p_input
     and reference_asset_ids = p_refs and created_at > now() - interval '1 hour';
  if c.id is null or exists (select 1 from public.character_swap_jobs where consent_id = p_consent) then
    raise exception 'consent_required' using errcode = 'NS409';
  end if;

  -- This organization's share of the day (all statuses), under its own lock and before the platform's. No number in the refusal.
  select * into s from public.character_swap_settings;
  if (select count(*) from public.character_swap_jobs where org_id = p_org and created_at > now() - interval '24 hours')
     >= coalesce(s.org_daily_jobs, 10) then
    raise exception 'org_daily_limit' using errcode = 'NS429';
  end if;
  -- This organization's job that nobody took in time, or whose worker went quiet, gives its place and its hold back first.
  perform public.character_swap_sweep(p_org);
  if exists (select 1 from public.character_swap_jobs where org_id = p_org and status in ('requested', 'running')) then
    raise exception 'job_in_progress' using errcode = 'NS409';
  end if;
  -- Platform-wide, after the organization's lock (0127's order, so two requests never wait on each other). No number.
  perform pg_advisory_xact_lock(hashtextextended('character_swap_global', 0));
  if (select count(*) from public.character_swap_jobs where status in ('requested', 'running')) >= coalesce(s.platform_in_flight, 20)
     or (select count(*) from public.character_swap_jobs where created_at > now() - interval '24 hours') >= coalesce(s.platform_daily_jobs, 200) then
    raise exception 'platform_busy' using errcode = 'NS429';
  end if;

  -- The hold: the charge raised to job_minimum, under a reference this function made, never the caller's. Only the charge is captured
  -- (finish_character_swap); the rest of the hold goes back then, and all of it on a failure or a cancel.
  v_hold := 0;
  if charge > 0 then
    v_hold := public.character_swap_hold(charge);
    if v_hold < charge then
      raise exception 'character swap hold % is below its charge %', v_hold, charge;
    end if;
    v_ref := 'cs:' || v_id::text;
    begin
      res := public.creative_platform_reserve(p_org, v_ref, v_hold);
    exception when sqlstate 'NS402' then
      raise exception 'swap_hold_unavailable' using errcode = 'NS402', detail = format('hold=%s charge=%s', v_hold, charge);
    end;
    if coalesce((res ->> 'exempt')::boolean, false) then
      v_ref := null;
      v_hold := 0;
      charge := 0;
    end if;
  end if;
  insert into public.character_swap_jobs (id, org_id, project_id, requested_by, model_id, resolution, input_asset_id, reference_asset_ids,
                                          prompt, consent_id, input_seconds, billed_seconds, charge_credits, hold_credits, credit_ref,
                                          status, idempotency_key, request_hash)
  values (v_id, p_org, p_project, uid, p_model, p_resolution, p_input, p_refs, p_prompt, p_consent, v_secs, ceil(v_secs)::integer, charge,
          v_hold, v_ref, 'requested', p_idem, v_hash);
  return jsonb_build_object('id', v_id, 'status', 'requested', 'credits', charge, 'hold', v_hold, 'replayed', false);
end
$$;

-- request_download: 0094's body, verbatim.
create or replace function public.request_download(
  p_video_id text, p_quality text, p_max_credits numeric default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  vid     text := btrim(coalesce(p_video_id, ''));
  q       text := btrim(coalesce(p_quality, ''));
  org     uuid;
  ch      text;
  m       public.download_masters;
  r       public.download_requests;
  paid    public.download_requests;
  rate    public.credit_prices;
  floor_c numeric;
  mins    numeric;
  price   numeric := 0;
  why     text;
  until_  timestamptz;
  acc     public.credit_accounts;
  txn     bigint;
  s       record;
  spend_  numeric;
begin
  if auth.uid() is null then
    raise exception 'sign in to download' using errcode = '42501';
  end if;
  if q not in ('720p', '1080p') then
    raise exception 'quality must be 720p or 1080p' using errcode = '22023';
  end if;
  select c.org_id, c.channel_id into org, ch
    from public.videos v join public.channels c on c.channel_id = v.channel_id
   where v.video_id = vid;
  if ch is null or org is null then
    raise exception 'video not found' using errcode = 'P0002';
  end if;
  -- Spending credits: an editor or above of THAT organization, never a viewer.
  if not public.is_org_member(org, 'editor') then
    raise exception 'only an owner, admin or editor of this organization may buy a download'
      using errcode = '42501';
  end if;

  -- One decision per (org, video, quality) at a time: a double click waits
  -- here and then finds the first one's row.
  perform pg_advisory_xact_lock(hashtextextended(format('download:%s:%s:%s', org, vid, q), 0));

  -- No worker picked it up for two hours (the worker is off): give it back.
  for s in
    select d.id from public.download_requests d
     where d.org_id = org and d.status = 'queued' and d.created_at < now() - interval '2 hours'
  loop
    perform public.download_fail_locked(s.id, 'not_picked_up',
      'no worker picked the download up within 2 hours; the credits were refunded');
  end loop;

  -- Already on its way, or still downloadable: the same row, nothing charged.
  select * into r from public.download_requests d
   where d.org_id = org and d.video_id = vid and d.quality = q
     and (d.status in ('queued', 'processing') or (d.status = 'ready' and d.expires_at > now()))
   order by d.id desc limit 1;
  if found then
    return jsonb_build_object('id', r.id, 'status', r.status, 'quality', r.quality,
                              'charged', 0, 'reused', true, 'expires_at', r.expires_at);
  end if;

  select * into m from public.download_masters where video_id = vid;
  if not found or least(m.width, m.height) < public.download_quality_side(q) then
    raise exception 'no full-quality master for this video at %', q
      using errcode = 'NS404',
            hint = 'Only videos rendered on the queue worker keep a master; re-run the video there.';
  end if;
  mins := round(m.duration_seconds / 60.0, 4);

  select * into paid from public.download_requests d
   where d.org_id = org and d.video_id = vid and d.quality = q
     and d.paid_until > now() and d.status <> 'failed'
   order by d.id desc limit 1;
  if found then
    why := 'redownload';
    until_ := paid.paid_until;
  elsif public.credits_exempt(org) then
    why := 'exempt';
    until_ := now() + interval '7 days';
  else
    select * into rate from public.credit_prices where unit = format('download_%s_minute', q);
    if not found then
      raise exception 'downloads in % are not priced yet', q
        using errcode = 'NS400', hint = 'A platform admin sets the download price on the Credits page.';
    end if;
    select credits_per_unit into floor_c from public.credit_prices where unit = 'download_minimum';
    -- Rounded to 6 places before ceil, so numeric division noise (1.6666…7)
    -- never adds a whole credit; lib/downloads.ts downloadCharge does the same.
    price := greatest(ceil(round(m.duration_seconds * rate.credits_per_unit * (1 + rate.margin) / 60.0, 6)),
                      ceil(round(coalesce(floor_c, 0), 6)));
    if p_max_credits is not null and price > p_max_credits then
      raise exception 'the price changed'
        using errcode = 'NS409', detail = format('price=%s confirmed=%s', price, p_max_credits);
    end if;
    until_ := now() + interval '7 days';
  end if;

  if price > 0 then
    acc := public.credit_account_lock(org);
    if acc.balance - acc.reserved < price then
      raise exception 'insufficient credits'
        using errcode = 'NS402',
              detail = format('available=%s needed=%s', acc.balance - acc.reserved, price),
              hint = 'Add credits to this organization.';
    end if;
    -- 0094: a download is a paid action that does not go through
    -- reserve_credits (it is charged on the spot), so the switch is enforced
    -- here too: with extra credits off it may be paid only from credit that is
    -- not a top-up pack, and the charge below skips pack lots (the same NS402
    -- refusal and figures as a refused run).
    if not acc.use_extra_credits then
      spend_ := public.credit_spendable_internal(org);
      if spend_ < price then
        raise exception 'insufficient credits'
          using errcode = 'NS402',
                detail = format('available=%s needed=%s extra_off=1 extra=%s', spend_, price, greatest(acc.balance - acc.reserved - spend_, 0)),
                hint = 'Extra credits are off for this organization. Turn them on, add credits, or upgrade the plan.';
      end if;
    end if;
  end if;

  insert into public.download_requests
    (org_id, channel_id, video_id, quality, status, charged, free_reason, paid_until, minutes, requested_by)
  values
    (org, ch, vid, q, 'queued', price, why, until_, mins, auth.uid())
  returning * into r;

  if price > 0 then
    update public.credit_accounts
       set balance = balance - price, updated_at = now()
     where org_id = org
    returning * into acc;
    perform set_config('nightshift.no_pack_spend', case when acc.use_extra_credits then '' else '1' end, true);
    txn := public.credit_log(org, 'capture', -price, 'download:' || r.id, null,
                             format('download %s of %s (%s min)', q, vid, mins));
    perform set_config('nightshift.no_pack_spend', '', true);
    update public.download_requests set charge_txn = txn where id = r.id;
  end if;

  return jsonb_build_object('id', r.id, 'status', r.status, 'quality', q, 'charged', price,
                            'free_reason', why, 'reused', false,
                            'balance', acc.balance, 'available', acc.balance - acc.reserved);
end
$$;

-- render_jobs_payment_guard: 0122's body, verbatim.
create or replace function public.render_jobs_payment_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org   uuid;
  v_cfg   jsonb;
  v_secs  numeric;
  r       public.credit_reservations;
  h       public.api_holds;
  jm      numeric;
  vm      public.credit_prices;
  v_need  numeric;
  sr      public.scene_regenerations;
  sp      public.series_plans;
begin
  -- 0120: a job linked to a series plan is the one job its request queued -- a planning job (one model call, paid by nobody: planning is free
  -- to the customer and capped per organization per day) -- for every organization, the operator's included. Placed before the channel
  -- check below on purpose: an EDITOR requests a plan (request_series_plan checks that), and the browser's own insert policy admits only
  -- kind 'daily', so a signed-in browser cannot insert this row itself whatever it puts in the column.
  if new.series_plan_id is not null then
    select * into sp from public.series_plans where id = new.series_plan_id;
    if sp.id is null or new.kind <> 'series_plan' or sp.channel_id <> new.channel_id
       or sp.status <> 'requested' or sp.render_job_id is not null
       or new.credit_ref is not null or new.api_hold_ref is not null or new.scene_regeneration_id is not null
       or new.params ->> 'topic' is distinct from sp.topic
       or new.params ->> 'niche' is distinct from sp.niche
       or new.params ->> 'language' is distinct from sp.language
       or new.params ->> 'series' is distinct from sp.series_id
       -- 0122: the format on the job is the format the plan was asked for (both absent is fine; one of them alone is not)
       or new.params ->> 'template' is distinct from sp.template_id
       or (new.params - array['topic','niche','language','series','template']) <> '{}'::jsonb then
      raise exception 'render job refused: it is not the job its series plan queued'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- A signed-in browser that may not start runs on this channel gets the
  -- insert policy's refusal here, before anything below can tell it whether
  -- a channel or a hold exists. (The API functions run with the key's anon
  -- role and do their own channel check; the service key is trusted.)
  if coalesce(auth.role(), '') = 'authenticated'
     and not (new.channel_id in (select public.accessible_channel_ids('admin'))) then
    raise exception 'new row violates row-level security policy for table "render_jobs"'
      using errcode = '42501';
  end if;

  select c.org_id, c.agent_config into v_org, v_cfg
    from public.channels c where c.channel_id = new.channel_id;
  if v_org is null then
    raise exception 'render job refused: channel % belongs to no organization', new.channel_id
      using errcode = '42501';
  end if;
  -- 0076: a job linked to a scene regeneration is the one job its request
  -- queued — a repair of that scene, with that regeneration's own hold —
  -- for every organization, the operator's included.
  if new.scene_regeneration_id is not null then
    select * into sr from public.scene_regenerations where id = new.scene_regeneration_id;
    if sr.id is null or new.kind <> 'repair' or sr.channel_id <> new.channel_id
       or sr.status <> 'queued' or sr.render_job_id is not null
       or sr.credit_ref is distinct from new.credit_ref or new.api_hold_ref is not null
       or new.params ->> 'repair_scenes' is distinct from sr.scene_id
       or new.params ->> 'topic' is distinct from sr.slug
       or coalesce((new.params ->> 'resume')::boolean, false) then
      raise exception 'render job refused: it is not the job its scene regeneration queued'
        using errcode = '42501';
    end if;
  end if;
  -- The operator's own organization never pays (0020) and its runs keep the
  -- channel's own target length, exactly as before this migration.
  if public.credits_exempt(v_org) then
    return new;
  end if;

  -- 0111 (audit D8): the platform chooses the providers of a customer's run. A run is priced flat
  -- (credit_prices / api_prices), so a customer who named Veo or Kling would spend a funded vendor
  -- key at a price that does not cover it. The routes already refuse both fields (browser, API,
  -- MCP); this is the same rule in the one place no route can be bypassed. A blank or null value is
  -- not a choice and passes here; render_job_params_valid still refuses it as a provider id.
  -- Insert only: a queued job's params are frozen afterwards by render_jobs_terms_frozen.
  if coalesce(nullif(btrim(new.params ->> 'video_provider'), ''),
              nullif(btrim(new.params ->> 'image_provider'), '')) is not null then
    raise exception 'render job refused: video_provider and image_provider cannot be set for this organization'
      using errcode = '42501',
            hint = 'Leave them out: the platform chooses the providers of a paid run.';
  end if;

  -- C2: a customer run is paid for — whatever NIGHTSHIFT_CREDITS_ENFORCE says.
  if new.credit_ref is null and new.api_hold_ref is null then
    raise exception 'render job refused: a run for this organization must carry its credit hold'
      using errcode = '42501',
            hint = 'Start it from the Command Center with credits enforced (NIGHTSHIFT_CREDITS_ENFORCE).';
  end if;
  if new.credit_ref is not null and new.api_hold_ref is not null then
    raise exception 'render job refused: a run is paid by one hold, not two' using errcode = '42501';
  end if;

  -- 0076: a scene regeneration is priced per scene, not per minute of video.
  -- Its hold is its own (the reference the request placed): open, never
  -- started, this organization's, and at least the quote. The whole-video
  -- length floor below does not apply to one scene, and no length is frozen.
  if new.scene_regeneration_id is not null then
    select * into r from public.credit_reservations where job_id = new.credit_ref;
    if r.job_id is null or r.org_id is distinct from v_org or r.status <> 'open'
       or r.started_at is not null or sr.quoted_credits is null or r.amount < sr.quoted_credits then
      raise exception 'render job refused: its credit hold is not this scene regeneration''s open hold'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- C1: freeze the length the hold is for. A job that names its length keeps
  -- it (render_jobs_params_check holds it to whole seconds, 30..3600); one
  -- that does not gets the channel's target as it is NOW, capped the same way.
  new.params := coalesce(new.params, '{}'::jsonb);
  if new.params ? 'duration' then
    if jsonb_typeof(new.params -> 'duration') <> 'number' then
      raise exception 'render job refused: duration must be a whole number of seconds'
        using errcode = '22023';
    end if;
    v_secs := (new.params ->> 'duration')::numeric;
  else
    if jsonb_typeof(v_cfg -> 'target_duration_seconds') = 'number' then
      v_secs := (v_cfg ->> 'target_duration_seconds')::numeric;
    end if;
    if v_secs is null or v_secs <= 0 then
      raise exception 'render job refused: a paid run needs a length'
        using errcode = '22023',
              hint = 'Choose a length, or set the channel''s target length.';
    end if;
    v_secs := least(greatest(round(v_secs), 30), 3600);
    new.params := new.params || jsonb_build_object('duration', v_secs::integer);
  end if;

  if new.api_hold_ref is not null then
    -- (a) is the policy's; here: the hold is this organization's, open, and
    -- not already paying for another job or a download. 0031's
    -- api_create_video priced it for this length in this same transaction.
    select * into h from public.api_holds where ref = new.api_hold_ref;
    if h.ref is null or h.org_id is distinct from v_org or h.status <> 'open'
       or h.started_at is not null or h.render_job_id is not null
       or h.download_request_id is not null then
      raise exception 'render job refused: its API balance hold is not an open, unused hold of this organization'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- (b) the credit hold: this organization's, a queue reference, open, never
  -- started (a started hold is paying for a run already), not expired.
  if new.credit_ref !~ '^rj-' then
    raise exception 'render job refused: a queued run is paid by a queue credit hold (rj-…)'
      using errcode = '42501';
  end if;
  select * into r from public.credit_reservations where job_id = new.credit_ref;
  if r.job_id is null or r.org_id is distinct from v_org or r.status <> 'open'
     or r.started_at is not null or r.created_at < now() - interval '3 hours' then
    raise exception 'render job refused: its credit hold is not an open, unused hold of this organization'
      using errcode = '42501';
  end if;

  -- The hold covers the frozen length: modules/credits.minimum_reservation.
  -- job_minimum is a flat floor (margin ignored, as in reserve_credits);
  -- video_minute is credits per minute with its margin. Unset = no floor.
  select credits_per_unit into jm from public.credit_prices where unit = 'job_minimum';
  select * into vm from public.credit_prices where unit = 'video_minute';
  v_need := greatest(coalesce(jm, 0),
                     coalesce(vm.credits_per_unit * (1 + vm.margin) * v_secs / 60, 0));
  v_need := public.credits_round_up(v_need);
  if v_need > 0 and r.amount < v_need then
    raise exception 'render job refused: its credit hold does not cover a run of % seconds', v_secs::integer
      using errcode = '22023',
            hint = 'Reserve for the length you run, or choose a shorter one.';
  end if;
  return new;
end
$$;

-- create_api_key: 0042's body, verbatim.
create or replace function public.create_api_key(
  p_org uuid, p_name text, p_monthly_limit_cents bigint default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  b62      constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  v_name   text := btrim(coalesce(p_name, ''));
  v_active integer;
  v_secret text := '';
  v_bytes  bytea;
  v_byte   integer;
  v_key    text;
  i        integer;
  k        public.api_keys;
begin
  if auth.uid() is null or not public.is_org_member(p_org, 'admin') then
    raise exception 'only an owner or admin of this organization may create API keys' using errcode = '42501';
  end if;
  if not exists (select 1 from public.api_settings where org_id = p_org and activated_at is not null) then
    raise exception 'activate the API first' using errcode = 'NS403';
  end if;
  if char_length(v_name) not between 1 and 60 then
    raise exception 'name the key (1 to 60 characters)' using errcode = '22023';
  end if;
  if p_monthly_limit_cents is not null and (p_monthly_limit_cents < 0 or p_monthly_limit_cents > 100000000) then
    raise exception 'limit out of range' using errcode = '22023';
  end if;
  -- Two tabs creating the eleventh key at once: one waits for the other.
  perform pg_advisory_xact_lock(hashtextextended('api_keys:' || p_org::text, 0));
  select count(*) into v_active from public.api_keys where org_id = p_org and revoked_at is null;
  if v_active >= 10 then
    raise exception 'this organization already has 10 active API keys; revoke one first' using errcode = 'NS409';
  end if;

  -- 43 base62 characters (256 bits) from gen_random_uuid(), which draws on
  -- the server's strong random source. Bytes 6 and 8 carry the UUID version
  -- and variant bits and are skipped; a byte >= 248 (4 * 62) is redrawn so
  -- every character is equally likely.
  while char_length(v_secret) < 43 loop
    v_bytes := uuid_send(gen_random_uuid());
    for i in 0..15 loop
      continue when i in (6, 8);
      v_byte := get_byte(v_bytes, i);
      continue when v_byte >= 248;
      v_secret := v_secret || substr(b62, v_byte % 62 + 1, 1);
      exit when char_length(v_secret) = 43;
    end loop;
  end loop;
  v_key := 'nsk_live_' || v_secret;

  insert into public.api_keys (org_id, name, key_hash, monthly_limit_cents, created_by)
  values (p_org, v_name, encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), p_monthly_limit_cents, auth.uid())
  returning * into k;
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
  values (auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'api_key.create', k.id::text,
          jsonb_build_object('org_id', p_org, 'name', v_name));
  -- The only copy of the key leaves in this result.
  return jsonb_build_object('id', k.id, 'name', k.name, 'created_at', k.created_at, 'key', v_key);
end
$$;

-- api_begin: 0093's body, verbatim.
create or replace function public.api_begin(p_key_hash text, p_endpoint text, p_request_id text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  k        public.api_keys;
  s        public.api_settings;
  acc      public.api_accounts;
  v_exempt boolean;
  v_tier   integer;
  lim      record;
  v_rpm    integer;
  v_scope  text;
  v_minute timestamptz := date_trunc('minute', now());
  v_used   integer;
  v_reset  integer;
  ctx      jsonb;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    return public.api_err(401, 'invalid_api_key', 'The API key is missing, malformed, revoked or unknown.');
  end if;
  select * into k from public.api_keys where key_hash = p_key_hash;
  -- 0093: a hash that is no API key may be a connected app's access token: it
  -- gets its own checks (oauth_ctx) and an allow-list of endpoints.
  if k.id is null then
    return public.oauth_ctx(p_key_hash, p_endpoint, p_request_id);
  end if;
  if k.revoked_at is not null then
    return public.api_err(401, 'invalid_api_key', 'The API key is missing, malformed, revoked or unknown.');
  end if;
  select * into s from public.api_settings where org_id = k.org_id;
  if s.activated_at is null then
    return public.api_err(403, 'api_not_activated',
      'The API is not activated for this organization. An owner or admin can activate it in the Developer console.');
  end if;

  v_exempt := public.credits_exempt(k.org_id);
  select * into acc from public.api_accounts where org_id = k.org_id;
  v_tier := public.api_tier_for(coalesce(acc.paid_total_cents, 0), v_exempt);
  select * into lim from public.api_tier_limits(v_tier);
  v_rpm := least(lim.rpm, coalesce(k.rpm_limit, lim.rpm));

  v_reset := greatest(1, ceil(extract(epoch from (v_minute + interval '1 minute' - now())))::integer);
  insert into public.api_rate_counters as c (key_id, minute, count)
  values (k.id, v_minute, 1)
  on conflict (key_id, minute) do update set count = c.count + 1
  returning c.count into v_used;
  if v_used = 1 then
    delete from public.api_rate_counters c where c.key_id = k.id and c.minute < v_minute;
  end if;

  ctx := jsonb_build_object('ok', true, 'key_id', k.id, 'org_id', k.org_id,
    'created_by', k.created_by, 'tier', v_tier, 'exempt', v_exempt,
    'rpm', v_rpm, 'concurrency', lim.concurrency,
    'scopes', to_jsonb(coalesce(k.scopes, public.api_legacy_scopes())),
    'cap_cents', case when v_exempt then null
                      else least(lim.monthly_cap_cents, coalesce(s.monthly_limit_cents, lim.monthly_cap_cents)) end,
    'key_limit_cents', k.monthly_limit_cents,
    'remaining', greatest(0, v_rpm - v_used), 'reset', v_reset,
    'endpoint', coalesce(p_endpoint, 'unknown'), 'request_id', p_request_id);

  if v_used > v_rpm then
    return public.api_finish(ctx, public.api_err(429, 'rate_limit_exceeded',
      format('This key is limited to %s requests per minute on usage tier %s.', v_rpm, v_tier),
      jsonb_build_object('retry_after', v_reset)));
  end if;

  begin
    perform public.api_act_as(k.created_by);
    if not public.is_org_member(k.org_id, 'admin') then
      return public.api_finish(ctx, public.api_err(403, 'key_owner_not_admin',
        'The person who created this key is no longer an owner or admin of its organization. An admin must create a new key.'));
    end if;

    -- 0062: what this key may do. A key made before 0062 (scopes null) keeps
    -- the three scopes it always had and nothing new; an endpoint with no
    -- scope of its own is refused, never allowed.
    v_scope := public.api_endpoint_scope(p_endpoint);
    if v_scope is not null and not (v_scope = any (coalesce(k.scopes, public.api_legacy_scopes()))) then
      return public.api_finish(ctx, public.api_err(403, 'insufficient_scope',
        format('This key does not have the %s scope.', v_scope),
        jsonb_build_object('required_scope', v_scope)));
    end if;

    update public.api_keys set last_used_at = now()
     where id = k.id and (last_used_at is null or last_used_at < now() - interval '1 minute');
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
  return ctx;
end
$$;

-- oauth_ctx: 0147's body, verbatim.
create or replace function public.oauth_ctx(p_hash text, p_endpoint text, p_request_id text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  st       jsonb := public.oauth_token_state(p_hash);
  v_scope  text;
  v_grant  uuid;
  v_org    uuid;
  v_user   uuid;
  v_exempt boolean;
  v_rpm    integer := (public.oauth_limits() ->> 'rpm')::integer;
  v_minute timestamptz := date_trunc('minute', now());
  v_used   integer;
  v_reset  integer;
  ctx      jsonb;
begin
  if st is null then
    -- Exactly what an unknown API key gets, so the two doors answer alike.
    return public.api_err(401, 'invalid_api_key', 'The API key is missing, malformed, revoked or unknown.');
  end if;
  v_grant := (st ->> 'grant_id')::uuid;
  v_org := (st ->> 'org_id')::uuid;
  v_user := (st ->> 'user_id')::uuid;
  v_exempt := public.credits_exempt(v_org);

  v_reset := greatest(1, ceil(extract(epoch from (v_minute + interval '1 minute' - now())))::integer);
  -- 0147: the MCP route's oauth_check already took this request's unit and left a credit for its request id,
  -- so the first call of that request reads this minute's count instead of taking a second unit (with two
  -- units per tool call, 120 a minute meant about 60 tool calls). The test below stays `>`, so the call the
  -- check admitted is not refused for the check's own unit; any other call is counted as before.
  if public.oauth_check_credit_take(v_grant, p_request_id) then
    select coalesce(max(c.count), 0) into v_used from public.oauth_rate_counters c
     where c.grant_id = v_grant and c.minute = v_minute;
  else
    v_used := public.oauth_rate_take(v_grant);
  end if;

  ctx := jsonb_build_object('ok', true, 'key_id', null, 'grant_id', v_grant, 'oauth', true, 'org_id', v_org,
    'created_by', v_user, 'exempt', v_exempt, 'rpm', v_rpm, 'scopes', st -> 'scopes',
    'limit_credits', st -> 'limit_credits',
    'remaining', greatest(0, v_rpm - v_used), 'reset', v_reset,
    'endpoint', coalesce(p_endpoint, 'unknown'), 'request_id', p_request_id);

  if v_used > v_rpm then
    return public.api_finish(ctx, public.api_err(429, 'rate_limit_exceeded',
      format('This connection is limited to %s requests per minute.', v_rpm),
      jsonb_build_object('retry_after', v_reset)));
  end if;

  begin
    v_scope := public.oauth_endpoint_scope(p_endpoint);
    if v_scope is null then
      return public.api_finish(ctx, public.api_err(403, 'not_available_for_connected_apps',
        'This action is not available to connected apps. It needs an API key.'));
    end if;

    -- 0147: no plan check. Every plan may connect an app; a video it makes is held through reserve_credits
    -- (insufficient_credits when the workspace has too few) and capped by the connection's monthly limit.

    perform public.api_act_as(v_user);
    if not public.is_org_member(v_org, 'admin') then
      return public.api_finish(ctx, public.api_err(403, 'workspace_access_lost',
        'The person who connected this app no longer has access to its workspace. Reconnect the app.'));
    end if;

    if v_scope <> 'any' and not (v_scope = any (array(select jsonb_array_elements_text(st -> 'scopes')))) then
      return public.api_finish(ctx, public.api_err(403, 'insufficient_scope',
        format('This connection was not given the %s permission.', v_scope),
        jsonb_build_object('required_scope', v_scope)));
    end if;

    update public.oauth_grants set last_used_at = now()
     where id = v_grant and (last_used_at is null or last_used_at < now() - interval '1 minute');
  exception when others then
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
  return ctx;
end
$$;

-- workflow_confirmer_may_spend: 0074's body, verbatim.
create or replace function public.workflow_confirmer_may_spend(p_user uuid, p_org uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  with pr as (
    select case
      when public.app_members_empty() then
        case when exists (select 1 from public.org_members m
                           where m.org_id = public.default_org_id() and m.user_id = p_user) then 'owner' end
      else coalesce(
        (select a.role from public.app_members a where a.user_id = p_user),
        (select a.role from public.app_members a, auth.users u
          where u.id = p_user and u.email_confirmed_at is not null
            and a.user_id is null
            and nullif(lower(btrim(coalesce(u.email, ''))), '') is not null
            and lower(a.email) = lower(btrim(u.email))
          limit 1))
    end as role
  )
  select p_user is not null and p_org is not null and (
    case when public.credits_exempt(p_org) then
      exists (select 1 from pr where pr.role in ('owner', 'admin'))
    else
      exists (select 1 from pr where pr.role in ('owner', 'admin'))
      or (p_org = public.default_org_id()
          and exists (select 1 from pr where public.app_role_rank(pr.role) >= public.app_role_rank('editor')))
      or exists (select 1 from public.org_members m
                  where m.org_id = p_org and m.user_id = p_user
                    and public.app_role_rank(m.role) >= public.app_role_rank('editor'))
    end)
$$;

-- ai_chat_start: 0199's body, verbatim.
create or replace function public.ai_chat_start(p_org uuid, p_channel text) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
  v_cap integer;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  -- Planning a video is a maker's act: an editor or above, as creating one is (a viewer cannot spend the workspace's turns).
  if p_org is null or not public.is_org_member(p_org, 'editor') then
    perform public.creative_refuse('forbidden', 'an editor of this workspace can use Nightshift AI', 'NS403');
  end if;
  if (select count(*) from public.ai_chat_sessions x where x.created_by = v_user and x.created_at > now() - interval '24 hours')
     >= (select sessions_per_user_daily from public.ai_chat_settings where id) then
    perform public.creative_refuse('chat_daily_cap', 'too many new conversations today', 'NS429');
  end if;
  if p_channel is not null and not exists (select 1 from public.channels c where c.channel_id = p_channel and c.org_id = p_org) then
    perform public.creative_refuse('channel_not_found', 'that channel is not in this workspace', 'NS404');
  end if;
  v_cap := public.ai_chat_cap(p_org);
  if (v_cap is null and public.ai_chat_trial_left(p_org) = 0) or v_cap = 0 then
    perform public.creative_refuse('chat_plan_required', 'Nightshift AI is on the Plus, Pro and Business plans', 'NS402');
  end if;
  insert into public.ai_chat_sessions (org_id, channel_id, created_by, model)
  values (p_org, p_channel, v_user, (select model from public.ai_chat_settings where id)) returning id into v_id;
  return v_id;
end
$$;

-- ai_chat_reserve_turn: 0199's body, verbatim.
-- This body holds a backslash. A backslash can be rewritten on its way through an apply tool, so this file holds none:
-- the statement is run through EXECUTE, each backslash spelled <0226:backslash> and turned back into chr(92). Its source is unchanged.
do $bs0226$
begin
  execute replace($fn0226$create or replace function public.ai_chat_reserve_turn(p_session uuid, p_text text, p_retry boolean default false,
                                                      p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  s public.ai_chat_sessions;
  v_max integer;
  v_cap integer;
  v_used integer;
  v_call uuid;
  -- Every whitespace a person can type, not only spaces (Breach: a message of tabs and newlines took a turn), and the invisible ones
  -- (zero-width, word joiner, BOM) removed first, so a message of NBSPs or zero-width spaces is empty (Lens on 0199).
  -- Breach on 0199 added the rest that render as nothing: soft hyphen, joiners, bidi marks, variation selectors, tags, fillers.
  v_text text := btrim(regexp_replace(coalesce(p_text, ''),
                         E'[<0226:backslash>u00AD<0226:backslash>u034F<0226:backslash>u180E<0226:backslash>u200B-<0226:backslash>u200F<0226:backslash>u202A-<0226:backslash>u202E<0226:backslash>u2060-<0226:backslash>u2064<0226:backslash>uFEFF<0226:backslash>uFE00-<0226:backslash>uFE0F<0226:backslash>U000E0000-<0226:backslash>U000E007F]', '', 'g'),
                       E' <0226:backslash>t<0226:backslash>r<0226:backslash>n<0226:backslash>f<0226:backslash>u0085<0226:backslash>u00A0<0226:backslash>u115F<0226:backslash>u1160<0226:backslash>u1680<0226:backslash>u2000<0226:backslash>u2001<0226:backslash>u2002<0226:backslash>u2003<0226:backslash>u2004<0226:backslash>u2005<0226:backslash>u2006<0226:backslash>u2007<0226:backslash>u2008<0226:backslash>u2009<0226:backslash>u200A<0226:backslash>u2028<0226:backslash>u2029<0226:backslash>u202F<0226:backslash>u205F<0226:backslash>u2800<0226:backslash>u3000<0226:backslash>u3164<0226:backslash>uFFA0' || chr(11));
  st public.ai_chat_settings;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into s from public.ai_chat_sessions where id = p_session and created_by = v_user;
  if not found or not public.is_org_member(s.org_id, 'editor') then
    perform public.creative_refuse('session_not_found', 'no such conversation', 'NS404');
  end if;
  if s.step = 'created' then
    perform public.creative_refuse('session_closed', 'this plan was handed off; start a new conversation', 'NS409');
  end if;
  if p_request_id is not null and p_request_id !~ '^[A-Za-z0-9_-]{8,64}$' then
    perform public.creative_refuse('invalid_params', 'a request id is 8 to 64 letters, digits, - or _');
  end if;
  select * into st from public.ai_chat_settings where id;
  v_max := st.max_input_chars;
  if coalesce(p_retry, false) then
    if (select m.role from public.ai_chat_messages m where m.session_id = s.id order by m.id desc limit 1) is distinct from 'user' then
      perform public.creative_refuse('nothing_to_retry', 'the last message was answered', 'NS409');
    end if;
  elsif v_text = '' then
    perform public.creative_refuse('invalid_params', 'say something first');
  end if;
  if char_length(v_text) > coalesce(v_max, 2000) then
    perform public.creative_refuse('message_too_long', format('at most %s characters', coalesce(v_max, 2000)));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_chat:' || s.org_id::text, 0));
  -- The same press again (a network retry): answered as a duplicate, with nothing written (under the lock: two copies racing find
  -- each other, and the unique index is the last word).
  -- The refusal names the conversation the first copy went to: a retried Start finds its own (Lens on 0199).
  if p_request_id is not null and exists (select 1 from public.ai_chat_calls c where c.user_id = v_user and c.request_id = p_request_id) then
    perform public.creative_refuse('duplicate_request',
      coalesce((select c.session_id::text from public.ai_chat_calls c where c.user_id = v_user and c.request_id = p_request_id), ''), 'NS409');
  end if;
  v_cap := public.ai_chat_cap(s.org_id);
  v_used := public.ai_chat_used(s.org_id);
  if v_cap is null then
    -- The lifetime trial, counted under the same workspace lock as the cap (two tabs cannot both take the last one).
    if public.ai_chat_trial_left(s.org_id) = 0 then
      perform public.creative_refuse('chat_plan_required', 'Nightshift AI is on the Plus, Pro and Business plans', 'NS402');
    end if;
  elsif v_cap = 0 then
    perform public.creative_refuse('chat_plan_required', 'Nightshift AI is on the Plus, Pro and Business plans', 'NS402');
  elsif v_used >= v_cap then
    perform public.creative_refuse('chat_daily_cap', format('used=%s limit=%s', v_used, v_cap), 'NS429');
  end if;
  -- The person's own turns everywhere, and the platform's: under their own locks, after the workspace's, always in this order.
  perform pg_advisory_xact_lock(hashtextextended('ai_chat_user:' || v_user::text, 0));
  -- Every outcome counts here, not_sent too: a member can reserve and finish their own calls by hand, and each writes rows
  -- (Lens and Breach on 0199: not_sent passed every cap). The plan cap is the one that forgives what was not their doing.
  if (select count(*) from public.ai_chat_calls c where c.user_id = v_user and c.created_at > now() - interval '24 hours')
     >= st.per_user_daily then
    perform public.creative_refuse('chat_daily_cap', 'your own daily limit across workspaces is reached', 'NS429');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_chat_global', 0));
  if (select count(*) from public.ai_chat_calls c where c.created_at > now() - interval '24 hours') >= st.global_daily then
    perform public.creative_refuse('chat_unavailable', 'Nightshift AI has reached its daily limit; try again later', 'NS503');
  end if;
  if not coalesce(p_retry, false) then
    insert into public.ai_chat_messages (session_id, created_by, role, content) values (s.id, v_user, 'user', v_text);
  end if;
  insert into public.ai_chat_calls (org_id, user_id, session_id, model, request_id)
  values (s.org_id, v_user, s.id, (select model from public.ai_chat_settings where id), p_request_id) returning id into v_call;
  update public.ai_chat_sessions set updated_at = now() where id = s.id;
  return jsonb_build_object('call_id', v_call, 'used', v_used + 1, 'limit', v_cap,
                            'trial_left', case when v_cap is null then public.ai_chat_trial_left(s.org_id) end);
end
$$$fn0226$, '<0226:backslash>', chr(92));
end $bs0226$;

-- set_api_key_access: 0062's body, verbatim.
create or replace function public.set_api_key_access(
  p_key_id uuid, p_scopes text[], p_rpm_limit integer, p_creative_monthly_credits numeric
) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  k        public.api_keys;
  v_scopes text[];
begin
  select * into k from public.api_keys where id = p_key_id;
  if k.id is null or auth.uid() is null or not public.is_org_member(k.org_id, 'admin') then
    raise exception 'only an owner or admin of the key''s organization may change it' using errcode = '42501';
  end if;
  if k.revoked_at is not null then
    raise exception 'this key is revoked' using errcode = '22023';
  end if;
  v_scopes := array(select distinct s from unnest(coalesce(p_scopes, '{}'::text[])) s order by s);
  if cardinality(v_scopes) = 0 or not public.api_scopes_valid(v_scopes) then
    raise exception 'choose at least one valid scope' using errcode = '22023';
  end if;
  if p_rpm_limit is not null and p_rpm_limit not between 1 and 300 then
    raise exception 'requests per minute: 1 to 300' using errcode = '22023';
  end if;
  if p_creative_monthly_credits is not null and p_creative_monthly_credits not between 0 and 100000000 then
    raise exception 'credit limit out of range' using errcode = '22023';
  end if;
  update public.api_keys
     set scopes = v_scopes, rpm_limit = p_rpm_limit, creative_monthly_credits = p_creative_monthly_credits
   where id = p_key_id;
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
  values (auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'api_key.access', p_key_id::text,
          jsonb_build_object('org_id', k.org_id, 'scopes', to_jsonb(v_scopes), 'rpm_limit', p_rpm_limit,
                             'creative_monthly_credits', p_creative_monthly_credits));
  return true;
end
$$;

-- set_api_key_limit: 0031's body, verbatim.
create or replace function public.set_api_key_limit(p_key_id uuid, p_cents bigint) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  k public.api_keys;
begin
  select * into k from public.api_keys where id = p_key_id;
  if k.id is null or auth.uid() is null or not public.is_org_member(k.org_id, 'admin') then
    raise exception 'only an owner or admin of the key''s organization may change it' using errcode = '42501';
  end if;
  if p_cents is not null and (p_cents < 0 or p_cents > 100000000) then
    raise exception 'limit out of range' using errcode = '22023';
  end if;
  update public.api_keys set monthly_limit_cents = p_cents where id = p_key_id;
  return true;
end
$$;

-- api_activate: 0031's body, verbatim.
create or replace function public.api_activate(p_org uuid, p_terms_version text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s public.api_settings;
begin
  if auth.uid() is null or not public.is_org_member(p_org, 'admin') then
    raise exception 'only an owner or admin of this organization may activate the API' using errcode = '42501';
  end if;
  if not public.api_org_eligible(p_org) then
    raise exception 'buy any credit pack first; the API can be activated after the first purchase'
      using errcode = 'NS403';
  end if;
  if coalesce(p_terms_version, '') !~ '^[a-z0-9.-]{1,40}$' then
    raise exception 'accept the API terms' using errcode = '22023';
  end if;
  insert into public.api_settings (org_id, activated_at, activated_by, terms_version, updated_by)
  values (p_org, now(), auth.uid(), p_terms_version, auth.uid())
  on conflict (org_id) do update
     set activated_at = coalesce(public.api_settings.activated_at, now()),
         activated_by = coalesce(public.api_settings.activated_by, auth.uid()),
         terms_version = excluded.terms_version, updated_at = now(), updated_by = auth.uid()
  returning * into s;
  perform public.api_account_lock(p_org);
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
  values (auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'api.activate', p_org::text,
          jsonb_build_object('terms_version', p_terms_version));
  return jsonb_build_object('activated_at', s.activated_at, 'terms_version', s.terms_version);
end
$$;

-- ai_chat_plan_session: 0211's body, verbatim.
create or replace function public.ai_chat_plan_session(p_session uuid) returns public.ai_chat_sessions
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  s public.ai_chat_sessions;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into s from public.ai_chat_sessions where id = p_session and created_by = v_user for update;
  if not found or not public.is_org_member(s.org_id, 'editor') then
    perform public.creative_refuse('session_not_found', 'no such conversation', 'NS404');
  end if;
  if s.step = 'created' then
    perform public.creative_refuse('session_closed', 'this plan was handed off; start a new conversation', 'NS409');
  end if;
  return s;
end
$$;

-- ai_chat_plan_begin: 0211's body, verbatim.
create or replace function public.ai_chat_plan_begin(p_session uuid, p_proposal bigint, p_index integer) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  s public.ai_chat_sessions;
  l public.ai_chat_plan_leases;
  v_attempt integer;
  v_expires timestamptz;
  v_had boolean;
begin
  s := public.ai_chat_plan_session(p_session);
  if p_proposal is null or p_proposal < 0 or p_index is null or p_index not between 0 and 2 then
    perform public.creative_refuse('invalid_params', 'a proposal and an outline index (0 to 2)');
  end if;
  select * into l from public.ai_chat_plan_leases where session_id = s.id for update;
  -- Kept now: the sweep's UPDATE below resets FOUND.
  v_had := found;
  if v_had and l.state = 'running' and l.expires_at > now() then
    -- The detail is the lease's end, so the second tab can say how long to wait and then read the outcome.
    perform public.creative_refuse('plan_running', to_char(l.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'NS409');
  end if;
  if v_had and l.state = 'running' then
    -- The plan before this one ran out of time (its server is gone or stalled): every call it made, from its start to its expiry,
    -- that is still pending is a failure with unknown tokens. The whole lease, up to its last second (Lens L4): a call made just
    -- before the expiry is that dead plan's too, and a late finish of it is then refused (call_not_found), never counted twice.
    -- No turn made after the expiry is touched.
    --
    -- Locks: this function holds the session row (ai_chat_plan_session), then the lease, then these calls; 0199's
    -- ai_chat_finish_turn holds a call, then the session. The two orders are opposite, so the calls are taken SKIP LOCKED: a call a
    -- finish is holding right now is being finished by it and is left alone, and this function never waits on a call lock while it
    -- holds the session, so the two cannot deadlock.
    update public.ai_chat_calls c
       set outcome = 'vendor_error', tokens_in = null, tokens_out = null, finished_at = now()
     where c.id in (select x.id from public.ai_chat_calls x
                     where x.session_id = s.id and x.user_id = v_user and x.outcome = 'pending'
                       and x.created_at >= l.started_at and x.created_at <= l.expires_at
                       for update skip locked);
  end if;
  v_attempt := case when v_had then l.attempt + 1 else 1 end;
  v_expires := now() + interval '320 seconds';
  insert into public.ai_chat_plan_leases (session_id, created_by, proposal_id, scenario_index, attempt, state, reason,
                                          started_at, expires_at, finished_at)
  values (s.id, v_user, p_proposal, p_index, v_attempt, 'running', null, now(), v_expires, null)
  on conflict (session_id) do update
     set created_by = excluded.created_by, proposal_id = excluded.proposal_id, scenario_index = excluded.scenario_index,
         attempt = excluded.attempt, state = 'running', reason = null, started_at = excluded.started_at,
         expires_at = excluded.expires_at, finished_at = null;
  return jsonb_build_object(
    'attempt', v_attempt,
    'expires_at', to_char(v_expires at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'user_left', greatest(0, (select per_user_daily from public.ai_chat_settings where id)
                             - (select count(*)::integer from public.ai_chat_calls c
                                 where c.user_id = v_user and c.created_at > now() - interval '24 hours')));
end
$$;

-- ai_chat_plan_end: 0211's body, verbatim.
create or replace function public.ai_chat_plan_end(p_session uuid, p_attempt integer, p_state text, p_reason text) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s public.ai_chat_sessions;
  l public.ai_chat_plan_leases;
begin
  s := public.ai_chat_plan_session(p_session);
  if p_state is null or p_state not in ('failed', 'done') then
    perform public.creative_refuse('invalid_params', 'a plan ends failed or done');
  end if;
  if p_reason is not null and p_reason !~ '^[a-z][a-z0-9_]{0,39}$' then
    perform public.creative_refuse('invalid_params', 'a reason is a short machine word');
  end if;
  select * into l from public.ai_chat_plan_leases where session_id = s.id for update;
  if not found or l.attempt is distinct from p_attempt or l.state <> 'running' then
    perform public.creative_refuse('plan_not_current', 'that plan is no longer the running one', 'NS409');
  end if;
  update public.ai_chat_plan_leases set state = p_state, reason = p_reason, finished_at = now() where session_id = s.id;
end
$$;

-- api_set_monthly_limit: 0031's body, verbatim.
create or replace function public.api_set_monthly_limit(p_org uuid, p_cents bigint) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public.is_org_member(p_org, 'admin') then
    raise exception 'only an owner or admin may change the monthly limit' using errcode = '42501';
  end if;
  if p_cents is not null and (p_cents < 0 or p_cents > 100000000) then
    raise exception 'limit out of range' using errcode = '22023';
  end if;
  update public.api_settings set monthly_limit_cents = p_cents, updated_at = now(), updated_by = auth.uid()
   where org_id = p_org and activated_at is not null;
  if not found then
    raise exception 'activate the API first' using errcode = 'NS403';
  end if;
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
  values (auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'api.monthly_limit', p_org::text,
          jsonb_build_object('monthly_limit_cents', p_cents));
  return true;
end
$$;

-- oauth_decide_authorization: 0147's body, verbatim.
create or replace function public.oauth_decide_authorization(p_secret_hash text, p_allow boolean, p_limit numeric, p_code_hash text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user  uuid := auth.uid();
  r       public.oauth_auth_requests;
  lim     jsonb := public.oauth_limits();
  g       uuid;
  v_limit numeric := p_limit;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if coalesce(p_secret_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  -- Single use: the row is taken (and deleted) by the person it was made for.
  delete from public.oauth_auth_requests
   where secret_hash = p_secret_hash and user_id = v_user
  returning * into r;
  if r.id is null or r.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  if not coalesce(p_allow, false) then
    return jsonb_build_object('ok', true, 'allowed', false, 'redirect_uri', r.redirect_uri, 'state', r.state,
                              'client_id', r.client_id);
  end if;

  if v_limit is null or v_limit < 0 or v_limit > (lim ->> 'max_limit_credits')::numeric or v_limit <> trunc(v_limit) then
    return jsonb_build_object('ok', false, 'error', 'invalid_limit', 'max_limit_credits', (lim ->> 'max_limit_credits')::numeric);
  end if;
  if coalesce(p_code_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'server_error');
  end if;
  -- 0147: no plan check: every plan may connect an app (credits and the connection's own limit bound it).
  perform public.api_act_as(v_user);
  if not public.is_org_member(r.org_id, 'admin') then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  -- 0147: one approval at a time per workspace, so two concurrent approvals cannot both pass the counts below.
  perform pg_advisory_xact_lock(hashtextextended('oauth_decide:' || r.org_id::text, 0));
  if (select count(*) from public.oauth_grants where user_id = v_user and revoked_at is null
         and absolute_expires_at > now()) >= (lim ->> 'max_grants_per_user')::int then
    return jsonb_build_object('ok', false, 'error', 'too_many_connections');
  end if;
  -- 0147: the live cap above does not count a revoked connection, and a revoked one kept its registration alive, so with
  -- Free able to approve, approve-redeem-revoke made rows for nothing. Connections approved in the last 24 hours, revoked
  -- ones included, are capped per person and per workspace (the collector frees an ended one's rows a day later).
  if (select count(*) from public.oauth_grants where user_id = v_user and created_at > now() - interval '24 hours')
       >= (lim ->> 'max_new_grants_per_user_day')::int
     or (select count(*) from public.oauth_grants where org_id = r.org_id and created_at > now() - interval '24 hours')
       >= (lim ->> 'max_new_grants_per_org_day')::int then
    return jsonb_build_object('ok', false, 'error', 'too_many_connections_today');
  end if;

  insert into public.oauth_grants (user_id, org_id, client_id, scopes, resource, monthly_limit_credits)
  values (v_user, r.org_id, r.client_id, r.scopes, r.resource, v_limit)
  returning id into g;
  insert into public.oauth_codes (code_hash, grant_id, client_id, redirect_uri, code_challenge, resource)
  values (p_code_hash, g, r.client_id, r.redirect_uri, r.code_challenge, r.resource);
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
  values (v_user, nullif(auth.jwt() ->> 'email', ''), 'mcp.connect', g::text,
          jsonb_build_object('org_id', r.org_id, 'client_id', r.client_id, 'scopes', to_jsonb(r.scopes), 'limit_credits', v_limit));
  return jsonb_build_object('ok', true, 'allowed', true, 'redirect_uri', r.redirect_uri, 'state', r.state,
                            'client_id', r.client_id);
end
$$;

-- cancel_workflow_run: 0074's body, verbatim.
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
  end if;
  return public.workflow_run_json(p_run);
end
$$;

revoke all on function public.reserve_credits(uuid, text, numeric) from public, anon, authenticated, service_role;
grant execute on function public.reserve_credits(uuid, text, numeric) to authenticated;
grant execute on function public.reserve_credits(uuid, text, numeric) to service_role;
revoke all on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) from public, anon, authenticated, service_role;
grant execute on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) to authenticated;
revoke all on function public.start_workflow_run(uuid, uuid, integer, jsonb, numeric) from public, anon, authenticated, service_role;
grant execute on function public.start_workflow_run(uuid, uuid, integer, jsonb, numeric) to authenticated;
revoke all on function public.advance_workflow_run(uuid) from public, anon, authenticated, service_role;
grant execute on function public.advance_workflow_run(uuid) to authenticated;
revoke all on function public.approve_storyboard(uuid, numeric, text) from public, anon, authenticated, service_role;
grant execute on function public.approve_storyboard(uuid, numeric, text) to authenticated;
revoke all on function public.request_scene_regenerate(text, text, text, text, numeric, text) from public, anon, authenticated, service_role;
grant execute on function public.request_scene_regenerate(text, text, text, text, numeric, text) to authenticated;
revoke all on function public.request_repurpose(text, jsonb, numeric, text) from public, anon, authenticated, service_role;
grant execute on function public.request_repurpose(text, jsonb, numeric, text) to authenticated;
revoke all on function public.start_series_episode(uuid, numeric, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.start_series_episode(uuid, numeric, text, boolean) to authenticated;
revoke all on function public.request_editor_export(uuid, integer, text, numeric) from public, anon, authenticated, service_role;
grant execute on function public.request_editor_export(uuid, integer, text, numeric) to authenticated;
revoke all on function public.request_brand_scan(uuid, text, text, numeric) from public, anon, authenticated, service_role;
grant execute on function public.request_brand_scan(uuid, text, text, numeric) to authenticated;
revoke all on function public.request_character_swap(uuid, uuid, uuid, uuid[], text, text, text, uuid, numeric, text) from public, anon, authenticated, service_role;
grant execute on function public.request_character_swap(uuid, uuid, uuid, uuid[], text, text, text, uuid, numeric, text) to authenticated;
revoke all on function public.request_download(text, text, numeric) from public, anon, authenticated, service_role;
grant execute on function public.request_download(text, text, numeric) to authenticated;
revoke all on function public.render_jobs_payment_guard() from public, anon, authenticated, service_role;
grant execute on function public.render_jobs_payment_guard() to service_role;
revoke all on function public.create_api_key(uuid, text, bigint) from public, anon, authenticated, service_role;
grant execute on function public.create_api_key(uuid, text, bigint) to authenticated;
revoke all on function public.api_begin(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_ctx(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.workflow_confirmer_may_spend(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_start(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.ai_chat_start(uuid, text) to authenticated;
revoke all on function public.ai_chat_reserve_turn(uuid, text, boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.ai_chat_reserve_turn(uuid, text, boolean, text) to authenticated;
revoke all on function public.set_api_key_access(uuid, text[], integer, numeric) from public, anon, authenticated, service_role;
grant execute on function public.set_api_key_access(uuid, text[], integer, numeric) to authenticated;
revoke all on function public.set_api_key_limit(uuid, bigint) from public, anon, authenticated, service_role;
grant execute on function public.set_api_key_limit(uuid, bigint) to authenticated;
revoke all on function public.api_activate(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.api_activate(uuid, text) to authenticated;
revoke all on function public.ai_chat_plan_session(uuid) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_plan_begin(uuid, bigint, integer) from public, anon, authenticated, service_role;
grant execute on function public.ai_chat_plan_begin(uuid, bigint, integer) to authenticated;
revoke all on function public.ai_chat_plan_end(uuid, integer, text, text) from public, anon, authenticated, service_role;
grant execute on function public.ai_chat_plan_end(uuid, integer, text, text) to authenticated;
revoke all on function public.api_set_monthly_limit(uuid, bigint) from public, anon, authenticated, service_role;
grant execute on function public.api_set_monthly_limit(uuid, bigint) to authenticated;
revoke all on function public.oauth_decide_authorization(text, boolean, numeric, text) from public, anon, authenticated, service_role;
grant execute on function public.oauth_decide_authorization(text, boolean, numeric, text) to authenticated;
revoke all on function public.cancel_workflow_run(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cancel_workflow_run(uuid) to authenticated;

do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.reserve_credits(uuid, text, numeric)', '20800909ce4fdbcff87c5a99e735299f'),
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', 'a5e00e65d1161bccd2acefb7745e659b'),
      ('public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)', '67c4d21342ed9c6c144ec2559d4b34cc'),
      ('public.advance_workflow_run(uuid)', 'a349d79c4f1ca791135002cef82193a9'),
      ('public.approve_storyboard(uuid, numeric, text)', '69885e5eb4dfebc05f2ca44a51a03a6a'),
      ('public.request_scene_regenerate(text, text, text, text, numeric, text)', '2fed9d76de1030b44f0121e86e2fb663'),
      ('public.request_repurpose(text, jsonb, numeric, text)', '8771b0e2f943e7ff424482c4c1bbb50d'),
      ('public.start_series_episode(uuid, numeric, text, boolean)', 'f3598d71d76e780b6973f88d8a743d2b'),
      ('public.request_editor_export(uuid, integer, text, numeric)', 'b6c3cdf6e63c02ce982b4f046df63c63'),
      ('public.request_brand_scan(uuid, text, text, numeric)', 'e696f6295465ae9b321766aea7a40b99'),
      ('public.request_character_swap(uuid, uuid, uuid, uuid[], text, text, text, uuid, numeric, text)', '8b25050c082a66baf873ff871380ebc3'),
      ('public.request_download(text, text, numeric)', '268af77d1e00070cb96a7c98baeb51b1'),
      ('public.render_jobs_payment_guard()', '3807936ade6801fa20da292e27fa7f64'),
      ('public.create_api_key(uuid, text, bigint)', '4b311587d0f62ade8334beec83049e01'),
      ('public.api_begin(text, text, text)', '8b3b4fb4f4a5ab698584bc4f30e9fd14'),
      ('public.oauth_ctx(text, text, text)', 'fe42c9e4f53a6c9aaba40077ce905cdc'),
      ('public.workflow_confirmer_may_spend(uuid, uuid)', 'bf5b3922c06fb82f832de36394e88ef7'),
      ('public.ai_chat_start(uuid, text)', 'f2365e962c429bd2640e5b3b155a32d5'),
      ('public.ai_chat_reserve_turn(uuid, text, boolean, text)', '7c89309bd1e2c15109d3824cc1104df8'),
      ('public.set_api_key_access(uuid, text[], integer, numeric)', '31a0ee1c15ba91f948446f95c8aeb1d2'),
      ('public.set_api_key_limit(uuid, bigint)', '538ad2e8ed9ab8eac10e11e3e60ba655'),
      ('public.api_activate(uuid, text)', '8cc2ead31d60e2c809c9e2ca4f161b90'),
      ('public.ai_chat_plan_session(uuid)', '872b3f926f9dcf658b8a8efc097397f5'),
      ('public.ai_chat_plan_begin(uuid, bigint, integer)', 'bcb630a57a5be419f80e5a9e2b9ce588'),
      ('public.ai_chat_plan_end(uuid, integer, text, text)', '5b94856b084a3941a39eb825baa8ed5e'),
      ('public.api_set_monthly_limit(uuid, bigint)', 'de4c4102641f01de27a71dd57db6b13f'),
      ('public.oauth_decide_authorization(text, boolean, numeric, text)', '3b5236152d66117425e44e2d5132b9eb'),
      ('public.cancel_workflow_run(uuid)', 'd168fa9af136f070ae655c951a95cc0e')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0226 end state: % is not the earlier body (md5 %)', r.sig, h;
    end if;
  end loop;
end $$;

commit;
