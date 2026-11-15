-- Explicit owner rollback only; never run automatically. Stop new workers first.
-- Restores pre-0178 behavior, including its known gaps; frozen mode metadata is retained.
-- Apply as one transaction; no financial rows or configured prices are changed.
begin;
set local lock_timeout = '5s';
-- Hashes fold whitespace only; an unknown deployed body must be reviewed rather than overwritten.
do $$
declare sig text; before_hash text; after_hash text; got text;
begin
  for sig,before_hash,after_hash in values
    ('public.api_create_video(text,text,jsonb,text,text,text)', '06ee1b604bf84d7534443c20c63734de', '06ee1b604bf84d7534443c20c63734de'),
    ('public.oauth_create_video(text,text,jsonb,text,text)', '17922b4ead29bac512fc5f16364a7ead', '17922b4ead29bac512fc5f16364a7ead'),
    ('public.api_hold_start(text,bigint)', 'f5e41294e20af9bca35358b5164dc996', 'f5e41294e20af9bca35358b5164dc996'),
    ('public.api_video_price(numeric)', 'a303bbdad4bceeca34e7528252454a27', 'a303bbdad4bceeca34e7528252454a27'),
    ('public.series_episode_price(integer)', '1299460aaef4cc1152adc818a161526d', '1299460aaef4cc1152adc818a161526d'),
    ('public.start_credit_reservation(text,uuid)', 'abf482179ecdd9cac8dbfcfc5da21abf', 'abf482179ecdd9cac8dbfcfc5da21abf')
  loop
    select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) into got from pg_proc where oid=to_regprocedure(sig);
    if got is null or got not in (before_hash,after_hash) then
      raise exception '0178 unexpected body for %: inspect the deployment before applying',sig;
    end if;
  end loop;
end $$;

drop trigger if exists zz_render_jobs_priced_thumbnail_guard on public.render_jobs;
create or replace function public.api_create_video(
  p_key_hash text, p_channel_id text, p_params jsonb,
  p_idem_key text default null, p_fingerprint text default null, p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx     jsonb := public.api_begin(p_key_hash, 'videos.create', p_request_id);
  v_org   uuid;
  ch      public.channels;
  v_p     jsonb := coalesce(p_params, '{}'::jsonb);
  v_busy  integer;
  v_secs  numeric;
  v_price bigint;
  v_spend bigint;
  acc     public.api_accounts;
  v_ref   text;
  v_job   bigint;
  v_res   jsonb;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    v_res := public.api_idem_begin(ctx, p_idem_key, p_fingerprint);
    if v_res is not null then
      return public.api_finish(ctx, v_res);
    end if;
    v_org := (ctx ->> 'org_id')::uuid;

    select * into ch from public.channels c where c.channel_id = p_channel_id;
    if ch.channel_id is null or ch.org_id is distinct from v_org then
      v_res := public.api_err(404, 'channel_not_found', 'No channel with that id in this key''s organization.');
    elsif upper(btrim(coalesce(ch.status, ''))) <> 'ACTIVE' then
      v_res := public.api_err(409, 'channel_not_active',
        'That channel is not active. Connect it to YouTube and activate it in the Command Center first.');
    elsif jsonb_typeof(v_p) <> 'object'
       or (v_p - array['topic','niche','duration','language','visual_style',
                       'video_provider','image_provider']) <> '{}'::jsonb
       or not public.render_job_params_valid(v_p, 'daily') then
      v_res := public.api_err(400, 'invalid_params',
        'Allowed: topic (<=300 chars), niche (<=120), duration (whole seconds, 30-3600), language (<=40), visual_style (<=300), video_provider, image_provider.');
    end if;
    if v_res is not null then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
    end if;

    -- Concurrency, under a per-organization lock so two creates cannot both
    -- take the last slot.
    perform pg_advisory_xact_lock(hashtextextended('api_render_jobs:' || v_org::text, 0));
    select count(*) into v_busy
      from public.render_jobs j join public.channels c on c.channel_id = j.channel_id
     where c.org_id = v_org and j.status in ('queued', 'running');
    if v_busy >= (ctx ->> 'concurrency')::int then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(429, 'concurrency_limit_exceeded',
        format('Usage tier %s runs at most %s videos at once. Wait for one to finish.', ctx ->> 'tier', ctx ->> 'concurrency'),
        jsonb_build_object('retry_after', 60))));
    end if;

    if not (ctx ->> 'exempt')::boolean then
      v_secs := coalesce((v_p ->> 'duration')::numeric,
                         case when jsonb_typeof(ch.agent_config -> 'target_duration_seconds') = 'number'
                              then (ch.agent_config ->> 'target_duration_seconds')::numeric end);
      if v_secs is null or v_secs <= 0 then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(400, 'duration_required',
          'Pass duration (seconds): this channel has no target length to price the video by.')));
      end if;
      -- 0041 freezes the length a paid run renders at, whole seconds 30..3600
      -- (render_jobs_payment_guard). Freeze it here, in the same way, BEFORE
      -- pricing, so the hold is for the length that runs: a 10-second target
      -- renders 30 seconds and is priced as 30, and a target read again
      -- inside the insert cannot differ from the one priced.
      v_secs := least(greatest(round(v_secs), 30), 3600);
      v_p := v_p || jsonb_build_object('duration', v_secs::integer);
      v_price := public.api_video_price(v_secs);
      if v_price is null then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(503, 'pricing_unavailable',
          'The API price list is not set up on this deployment; nothing was charged.')));
      end if;

      acc := public.api_account_lock(v_org);
      perform public.api_expire_holds_locked(v_org);
      select * into acc from public.api_accounts where org_id = v_org;
      v_spend := public.api_month_spend(v_org);
      if v_spend + v_price > (ctx ->> 'cap_cents')::bigint then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(402, 'monthly_limit_reached',
          'This video would take the organization past its monthly API spend limit. An owner or admin can raise it in the Developer console: Developers → Usage and billing → Monthly spend limit (up to the usage tier''s cap; paying more into the API balance raises the tier).',
          jsonb_build_object('limit_cents', (ctx ->> 'cap_cents')::bigint, 'month_spend_cents', v_spend,
                             'price_cents', v_price))));
      end if;
      if ctx ->> 'key_limit_cents' is not null
         and public.api_month_spend(v_org, (ctx ->> 'key_id')::uuid) + v_price > (ctx ->> 'key_limit_cents')::bigint then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(402, 'key_limit_reached',
          'This video would take this key past its own monthly spend limit. An owner or admin can raise or remove it in the Developer console: Developers → API keys → Set limit on this key.',
          jsonb_build_object('limit_cents', (ctx ->> 'key_limit_cents')::bigint, 'price_cents', v_price))));
      end if;
      if acc.balance_cents - acc.reserved_cents < v_price then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(402, 'insufficient_balance',
          'Your API balance does not cover this video. Top up in the Developer console.',
          jsonb_build_object('price_cents', v_price, 'available_cents', acc.balance_cents - acc.reserved_cents))));
      end if;

      v_ref := 'ah-' || gen_random_uuid()::text;
      insert into public.api_holds (ref, org_id, key_id, amount_cents)
      values (v_ref, v_org, (ctx ->> 'key_id')::uuid, v_price);
      update public.api_accounts set reserved_cents = reserved_cents + v_price, updated_at = now()
       where org_id = v_org;
      perform public.api_log(v_org, 'hold', v_price, v_ref, (ctx ->> 'key_id')::uuid, null, null, null,
                             format('%s seconds on %s', v_secs, ch.channel_id));
    end if;

    -- 0019's insert policy, stated as the row itself: a daily job, queued, no
    -- privacy/resume/repair, filed as the key's creator.
    insert into public.render_jobs (channel_id, kind, params, requested_by, api_hold_ref)
    values (ch.channel_id, 'daily', v_p, (ctx ->> 'created_by')::uuid, v_ref)
    returning id into v_job;
    if v_ref is not null then
      update public.api_holds set render_job_id = v_job where ref = v_ref;
    end if;

    perform public.api_audit(ctx, 'agent.run', ch.channel_id, ch.channel_id,
      v_p || jsonb_build_object('backend', 'queue', 'job_id', v_job, 'api_hold_ref', v_ref, 'price_cents', v_price));

    v_res := public.api_ok(jsonb_build_object('job_id', v_job, 'channel_id', ch.channel_id, 'status', 'queued',
                                              'price_cents', v_price), 201);
    return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res), coalesce(v_price, 0));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

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
  v_img   numeric;
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
      -- 0175: a concept-thumbnail channel's run also buys up to 4 generated images,
      -- and the worker refuses a hold that leaves them out. Unpriced images are no
      -- price at all, never the price without them.
      v_img := public.concept_thumbnail_credits(ch.channel_id);
      if v_img is null then
        return public.api_finish(ctx, public.api_err(503, 'pricing_unavailable',
          'This channel makes concept thumbnails, and generated images have no price on this deployment; nothing was held or charged.'));
      end if;
      if v_img > 0 then
        v_price := public.credits_round_up(v_price + v_img);
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

create or replace function public.api_hold_start(p_ref text, p_job_id bigint) returns bigint
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  h public.api_holds;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may start an API hold' using errcode = '42501';
  end if;
  select * into h from public.api_holds where ref = p_ref;
  if h.ref is null or h.render_job_id is distinct from p_job_id then
    return null;
  end if;
  perform public.api_account_lock(h.org_id);
  select * into h from public.api_holds where ref = p_ref for update;
  if h.status <> 'open' then
    return null;
  end if;
  if h.started_at is null then
    update public.api_holds set started_at = now() where ref = p_ref;
  end if;
  return h.amount_cents;
end
$$;

create or replace function public.api_video_price(p_seconds numeric) returns bigint
  language sql stable security definer set search_path = public, pg_temp as $$
  select case when pm.cents is null or p_seconds is null or p_seconds <= 0 then null
              else greatest(ceil(p_seconds * pm.cents / 60), ceil(coalesce(mn.cents, 0)))::bigint end
    from (select (select cents from public.api_prices where unit = 'video_minute') as cents) pm,
         (select (select cents from public.api_prices where unit = 'job_minimum') as cents) mn
$$;

create or replace function public.series_episode_price(p_duration_s integer) returns numeric
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  jm     numeric;
  vm     public.credit_prices;
  amount numeric;
begin
  if p_duration_s is null or p_duration_s not between 30 and 3600 then
    return null;
  end if;
  select credits_per_unit into jm from public.credit_prices where unit = 'job_minimum';
  select * into vm from public.credit_prices where unit = 'video_minute';
  if vm.unit is null or vm.credits_per_unit is null or vm.credits_per_unit <= 0 or vm.margin is null then
    return null;
  end if;
  amount := public.credits_round_up(greatest(coalesce(jm, 0), vm.credits_per_unit * (1 + vm.margin) * p_duration_s / 60));
  if amount is null or amount <= 0 then
    return null;
  end if;
  -- credits_round_up already lands on a whole cent: round() only fixes the scale shown to the caller (15.00, not 15.0000000000000000).
  return round(amount, 2);
end
$$;

create or replace function public.start_credit_reservation(p_job_id text, p_org uuid)
  returns numeric
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r public.credit_reservations;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may start a reservation' using errcode = '42501';
  end if;
  select * into r from public.credit_reservations where job_id = p_job_id;
  if not found or r.org_id is distinct from p_org then
    return null;
  end if;
  perform public.credit_account_lock(r.org_id);
  select * into r from public.credit_reservations where job_id = p_job_id for update;
  if r.status <> 'open' then
    return null;
  end if;
  if r.started_at is null then
    update public.credit_reservations set started_at = now() where job_id = p_job_id;
  end if;
  return r.amount;
end
$$;

drop function if exists public.api_hold_start_priced(text,bigint);
drop function if exists public.render_jobs_priced_thumbnail_guard();
drop function if exists public.api_concept_video_price(numeric,text);
drop function if exists public.run_thumbnail_mode(jsonb);
commit;
