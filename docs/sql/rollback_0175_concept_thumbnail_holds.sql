-- rollback_0175_concept_thumbnail_holds.sql — takes migration 0175 out again. OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the
-- app runs it.
--
-- WHEN YOU NEED IT. If the database's own prices (a series episode, a video asked for over MCP) must stop carrying a concept-thumbnail
-- channel's generated images. ROLL BACK THE WORKER FIRST: the worker refuses a hold that leaves the images out
-- (modules/credits.minimum_reservation), so with this rolled back and the worker not, every series episode and MCP video of a concept
-- channel is refused again.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if a live body is not 0175's (a later change would be undone).
--   1. Puts quote_series_episode() and start_series_episode() back to 0120's bodies and oauth_create_video() back to 0094's, byte for
--      byte, with their grants.
--   2. Drops series_episode_price(integer, text) and concept_thumbnail_credits(text). The one-argument series_episode_price is 0120's and
--      stays.
--
-- tests/security/test_sec_concept_thumbnail_holds.py applies this file to the lab database and re-applies 0175.

begin;
set local lock_timeout = '5s';

do $$
declare
  sig  text;
  want text;
  got  text;
begin
  for sig, want in values
    ('public.quote_series_episode(uuid)', '9ffa67413ea6a90ec58e3b0bc4214078'),
    ('public.start_series_episode(uuid, numeric, text, boolean)', 'df19e5e9ad49c5772dbfa458919e1399'),
    ('public.oauth_create_video(text, text, jsonb, text, text)', '73145e68348088237a95b335fc162c08')
  loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into got from pg_proc p where p.oid = to_regprocedure(sig);
    if got is distinct from want then
      raise exception 'rollback 0175: % is not 0175''s body (md5 %): read the live body first', sig, got;
    end if;
  end loop;
end $$;

-- 0120's bodies, byte for byte.
create or replace function public.quote_series_episode(p_episode uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  ep      public.series_episodes;
  v_ex    boolean;
  v_price numeric;
  v_block text;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into ep from public.series_episodes where id = p_episode;
  if ep.id is null or not public.is_org_member(ep.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_ex := public.credits_exempt(ep.org_id);
  v_block := public.series_episode_blocker(ep.id);
  v_price := case when v_ex then null else public.series_episode_price(ep.duration_s) end;
  return jsonb_build_object(
    'episode_id', ep.id, 'plan_id', ep.plan_id, 'n', ep.n, 'status', ep.status, 'duration_s', ep.duration_s,
    'exempt', v_ex,
    -- Not "0 credits": the operator's own organization holds nothing, and an unpriced episode has no price.
    'price_status', case when v_ex then 'included' when v_price is null then 'unpriced' else 'priced' end,
    'credits', v_price,
    'needs_confirmation', ep.needs_confirmation,
    'blocked_by', v_block,
    'may_start', public.is_org_member(ep.org_id, 'admin') and (not v_ex or public.is_platform_admin()),
    'startable', v_block is null and (v_ex or v_price is not null));
end
$$;

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

-- 0094's body, byte for byte.
create or replace function public.oauth_create_video(
  p_token_hash text, p_channel_id text, p_params jsonb,
  p_idem_key text default null, p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx     jsonb := public.api_begin(p_token_hash, 'oauth.videos.create', p_request_id);
  v_org   uuid;
  v_grant uuid;
  ch      public.channels;
  v_p     jsonb := coalesce(p_params, '{}'::jsonb);
  v_secs  numeric;
  v_idem  text;
  v_fp    text;
  prior   public.oauth_runs;
  jm      numeric;
  vm      public.credit_prices;
  v_price numeric;
  v_limit numeric;
  v_spent numeric;
  acc     public.credit_accounts;
  v_ref   text;
  v_job   bigint;
  v_res   jsonb;
  v_hold  jsonb;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    v_org := (ctx ->> 'org_id')::uuid;
    v_grant := (ctx ->> 'grant_id')::uuid;
    if p_idem_key is not null and p_idem_key !~ '^[A-Za-z0-9_:.-]{1,255}$' then
      return public.api_finish(ctx, public.api_err(400, 'invalid_idempotency_key',
        'idempotency_key: 1-255 characters of A-Z a-z 0-9 _ : . -'));
    end if;
    v_idem := coalesce(p_idem_key, 'auto-' || gen_random_uuid()::text);
    v_fp := md5(jsonb_build_object('c', p_channel_id, 'p', v_p)::text);

    -- A retry of the same request waits here, then finds the first one's job.
    perform pg_advisory_xact_lock(hashtextextended('oauth_run:' || v_grant::text || ':' || v_idem, 0));
    select * into prior from public.oauth_runs where grant_id = v_grant and idem_key = v_idem;
    if prior.id is not null then
      if prior.fingerprint <> v_fp then
        return public.api_finish(ctx, public.api_err(422, 'idempotency_key_reused',
          'This idempotency_key was already used with a different request.'));
      end if;
      return public.api_finish(ctx, public.api_ok(jsonb_build_object('job_id', prior.render_job_id,
        'channel_id', prior.channel_id, 'status', 'queued', 'price_credits', prior.quoted_credits), 200)
        || jsonb_build_object('replayed', true));
    end if;

    select * into ch from public.channels c where c.channel_id = p_channel_id;
    if ch.channel_id is null or ch.org_id is distinct from v_org then
      return public.api_finish(ctx, public.api_err(404, 'channel_not_found', 'No channel with that id in this workspace.'));
    elsif upper(btrim(coalesce(ch.status, ''))) <> 'ACTIVE' then
      return public.api_finish(ctx, public.api_err(409, 'channel_not_active',
        'That channel is not active. Connect it to YouTube and activate it in the Command Center first.'));
    elsif jsonb_typeof(v_p) <> 'object'
       or (v_p - array['topic','niche','duration','language','visual_style','video_provider','image_provider']) <> '{}'::jsonb
       or not public.render_job_params_valid(v_p, 'daily') then
      return public.api_finish(ctx, public.api_err(400, 'invalid_params',
        'Allowed: topic (<=300 chars), niche (<=120), duration (whole seconds, 30-3600), language (<=40), visual_style (<=300), video_provider, image_provider.'));
    end if;

    -- A limit of 0 is a read-only connection, whoever pays: the operator's exempt
    -- workspace spends nothing, so nothing below would ever count against the
    -- limit; zero is the one limit that needs no counting (Lens-386A).
    if (ctx ->> 'exempt')::boolean and (ctx ->> 'limit_credits')::numeric <= 0 then
      return public.api_finish(ctx, public.api_err(402, 'connection_limit_reached',
        'This connection is read-only: its monthly spending limit is 0.',
        jsonb_build_object('limit_credits', 0, 'spent_credits', 0, 'price_credits', 0)));
    end if;

    if not (ctx ->> 'exempt')::boolean then
      -- The length the video renders at, frozen the way the payment guard
      -- (0041) freezes it, so what is held is what runs.
      v_secs := coalesce((v_p ->> 'duration')::numeric,
                         case when jsonb_typeof(ch.agent_config -> 'target_duration_seconds') = 'number'
                              then (ch.agent_config ->> 'target_duration_seconds')::numeric end);
      if v_secs is null or v_secs <= 0 then
        return public.api_finish(ctx, public.api_err(400, 'duration_required',
          'Pass duration (seconds): this channel has no target length to price the video by.'));
      end if;
      v_secs := least(greatest(round(v_secs), 30), 3600);
      v_p := v_p || jsonb_build_object('duration', v_secs::integer);

      -- The price: the same rows and formula the render_jobs payment guard
      -- demands the hold cover. No per-minute price = unpriced = refused.
      select credits_per_unit into jm from public.credit_prices where unit = 'job_minimum';
      select * into vm from public.credit_prices where unit = 'video_minute';
      if vm.unit is null or vm.credits_per_unit is null then
        return public.api_finish(ctx, public.api_err(503, 'pricing_unavailable',
          'Video pricing is not set up on this deployment; nothing was held or charged.'));
      end if;
      v_price := public.credits_round_up(greatest(coalesce(jm, 0), vm.credits_per_unit * (1 + vm.margin) * v_secs / 60));
      if v_price is null or v_price <= 0 then
        return public.api_finish(ctx, public.api_err(503, 'pricing_unavailable',
          'Video pricing is not set up on this deployment; nothing was held or charged.'));
      end if;

      -- Everything below runs under the credit account's row lock, so two calls
      -- of one connection cannot each pass the limit and jointly exceed it.
      acc := public.credit_account_lock(v_org);
      v_limit := (ctx ->> 'limit_credits')::numeric;
      v_spent := public.oauth_grant_month_credits(v_grant);
      if v_spent + v_price > v_limit then
        return public.api_finish(ctx, public.api_err(402, 'connection_limit_reached',
          'This video would take this connection past its monthly spending limit.',
          jsonb_build_object('limit_credits', v_limit, 'spent_credits', v_spent, 'price_credits', v_price)));
      end if;

      v_ref := 'rj-oa-' || replace(gen_random_uuid()::text, '-', '');
      begin
        v_hold := public.reserve_credits(v_org, v_ref, v_price);
      exception
        when sqlstate 'NS402' then
          select * into acc from public.credit_accounts where org_id = v_org;
          -- 0094: with extra credits off, what a new video can use is the plan
          -- side only, not balance - held (which counts unspendable pack credits).
          return public.api_finish(ctx, public.api_err(402, 'insufficient_credits',
            'The workspace does not have enough credits for this video.',
            jsonb_build_object('available_credits',
                                 case when coalesce(acc.use_extra_credits, true)
                                      then greatest(acc.balance - acc.reserved, 0)
                                      else public.credit_spendable_internal(v_org) end,
                               'held_credits', acc.reserved, 'price_credits', v_price)
            || case when coalesce(acc.use_extra_credits, true) then '{}'::jsonb
                    else jsonb_build_object('extra_credits_off', true) end));
        when sqlstate 'NS429' then
          return public.api_finish(ctx, public.api_err(429, 'run_limit_reached',
            'The plan\''s limit of videos in progress at once is reached.',
            jsonb_build_object('retry_after', 60,
                               'active_runs', (select count(*) from public.credit_reservations r where r.org_id = v_org and r.status = 'open'),
                               'run_limit', public.entitlement_int_internal(v_org, 'concurrency'))));
      end;
    end if;

    insert into public.render_jobs (channel_id, kind, params, requested_by, credit_ref)
    values (ch.channel_id, 'daily', v_p, (ctx ->> 'created_by')::uuid, v_ref)
    returning id into v_job;

    insert into public.oauth_runs (grant_id, org_id, idem_key, fingerprint, credit_ref, render_job_id, channel_id, quoted_credits)
    values (v_grant, v_org, v_idem, v_fp, v_ref, v_job, ch.channel_id, v_price);

    insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail, channel_id)
    values ((ctx ->> 'created_by')::uuid, nullif(auth.jwt() ->> 'email', ''), 'agent.run', ch.channel_id,
            v_p || jsonb_build_object('via', 'mcp_oauth', 'grant_id', v_grant, 'job_id', v_job,
                                      'credit_ref', v_ref, 'price_credits', v_price), ch.channel_id);

    v_res := public.api_ok(jsonb_build_object('job_id', v_job, 'channel_id', ch.channel_id, 'status', 'queued',
                                              'price_credits', v_price), 201);
    return public.api_finish(ctx, v_res, 0);
  exception when others then
    -- Only this block is undone (the hold with it): nothing is held or queued.
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

drop function if exists public.series_episode_price(integer, text);
drop function if exists public.concept_thumbnail_credits(text);

revoke all on function public.quote_series_episode(uuid) from public, anon, authenticated, service_role;
revoke all on function public.start_series_episode(uuid, numeric, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.oauth_create_video(text, text, jsonb, text, text) from public, anon, authenticated, service_role;
grant execute on function public.quote_series_episode(uuid) to authenticated;
grant execute on function public.start_series_episode(uuid, numeric, text, boolean) to authenticated;
grant execute on function public.oauth_create_video(text, text, jsonb, text, text) to anon;

commit;
