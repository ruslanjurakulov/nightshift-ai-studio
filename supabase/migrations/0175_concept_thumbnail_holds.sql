-- 0175 — a concept-thumbnail channel's run is priced with its generated images, wherever the database prices it.
--
-- WHY. A channel with agent_config.thumbnail_mode = 'concept' (0158) buys up to 4 generated images per run, on the
-- worker's keys. The Command Center's hold adds them (lib/credits.ts withConceptThumbnail), and the worker now refuses a
-- hold that leaves them out (modules/credits.minimum_reservation): a browser could otherwise reserve the bare floor and
-- the capture is capped at the hold, so the platform paid for the images. Two holds are priced HERE, not by the
-- Command Center, and left them out — a series episode (0120 series_episode_price) and a video asked for over MCP
-- (0094 oauth_create_video). Without this migration the worker refuses both on a concept channel, and a refused
-- episode blocks every later episode of its series.
--
-- WHAT. One price for the add-on, concept_thumbnail_credits(channel): 0 for a frame channel; 4 x image_generations x
-- (1 + margin) for a concept one; NULL when image_generations has no price (unknown, never 0 — the run would be
-- refused). Read like modules/credits.concept_thumbnail_on: only the JSON string "concept", case and surrounding white
-- space ignored. A two-argument series_episode_price(duration, channel) adds it to the one-argument price, rounded the
-- way the worker rounds (floor first, then floor + images); quote_series_episode, start_series_episode and
-- oauth_create_video are their latest bodies (0120, 0120, 0094 — not redefined since) with only the price call
-- changed. The one-argument series_episode_price is unchanged.
--
-- APPLY THIS BEFORE deploying the worker change that refuses holds without the images (the same pull request).
--
-- NUMBER. 0175 (drafted as 0163, then 0169): main ends at 0170, which production has applied, and a migration numbered below the
--   latest applied one is rejected or skipped by the Supabase CLI/integration (docs/MIGRATIONS.md, 0116); 0171 to 0174 are claimed
--   by open branches. Nothing merged from 0164 to 0170 names quote_series_episode, start_series_episode, oauth_create_video,
--   concept_thumbnail_credits or series_episode_price.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only, the SQL editor on the live project). md5 of each body with every run of white space read
-- as one space; the file checks them itself and raises on any other value:
--     select 'quote_series_episode' as fn, md5(regexp_replace(prosrc, '\s+', ' ', 'g')) as md5
--       from pg_proc where oid = 'public.quote_series_episode(uuid)'::regprocedure
--     union all select 'start_series_episode', md5(regexp_replace(prosrc, '\s+', ' ', 'g'))
--       from pg_proc where oid = 'public.start_series_episode(uuid, numeric, text, boolean)'::regprocedure
--     union all select 'oauth_create_video', md5(regexp_replace(prosrc, '\s+', ' ', 'g'))
--       from pg_proc where oid = 'public.oauth_create_video(text, text, jsonb, text, text)'::regprocedure;
--   expected BEFORE (0120 and 0094 applied, 0175 not):
--     quote_series_episode         9ba908b7888b5cab0281b8cf87e8659a
--     start_series_episode         f3598d71d76e780b6973f88d8a743d2b
--     oauth_create_video           244a5779e4388525f5f345b59379029f
--   expected AFTER (the last block of this file asserts the same, inside the transaction):
--     quote_series_episode         9ffa67413ea6a90ec58e3b0bc4214078
--     start_series_episode         df19e5e9ad49c5772dbfa458919e1399
--     oauth_create_video           73145e68348088237a95b335fc162c08
--     concept_thumbnail_credits    93ecebafdd6738762a480f75527fd508
--     series_episode_price(i, t)   c27ede9c11d262b6047a93e0f81f4042
--   If a live value is anything else, STOP: something was applied by hand, and replacing the body would silently undo it.
--
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1). Additive and
-- idempotent: a second run finds this file's bodies and changes nothing. Rollback: docs/sql/rollback_0175_concept_thumbnail_holds.sql.
-- REQUIRES 0094 (oauth_create_video's latest body), 0120 (the series tables, quote_series_episode's and start_series_episode's latest
-- bodies, series_episode_price) and 0158 (thumbnail_mode is an administrator's to change).

set local lock_timeout = '5s';

do $$
declare
  q text;
  st text;
  o text;
  c text;
  sp text;
begin
  if to_regprocedure('public.series_episode_price(integer)') is null then
    raise exception '0175 needs 0120_series_tables.sql (series_episode_price): apply it first';
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into q
    from pg_proc p where p.oid = to_regprocedure('public.quote_series_episode(uuid)');
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into st
    from pg_proc p where p.oid = to_regprocedure('public.start_series_episode(uuid, numeric, text, boolean)');
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into o
    from pg_proc p where p.oid = to_regprocedure('public.oauth_create_video(text, text, jsonb, text, text)');
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into c
    from pg_proc p where p.oid = to_regprocedure('public.concept_thumbnail_credits(text)');
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into sp
    from pg_proc p where p.oid = to_regprocedure('public.series_episode_price(integer, text)');
  if q is null or q <> all (array['9ba908b7888b5cab0281b8cf87e8659a', '9ffa67413ea6a90ec58e3b0bc4214078']) then
    raise exception '0175 found a quote_series_episode() that is neither 0120''s body nor 0175''s (md5 %): read the live body first', q;
  end if;
  if st is null or st <> all (array['f3598d71d76e780b6973f88d8a743d2b', 'df19e5e9ad49c5772dbfa458919e1399']) then
    raise exception '0175 found a start_series_episode() that is neither 0120''s body nor 0175''s (md5 %): read the live body first', st;
  end if;
  if o is null or o <> all (array['244a5779e4388525f5f345b59379029f', '73145e68348088237a95b335fc162c08']) then
    raise exception '0175 found an oauth_create_video() that is neither 0094''s body nor 0175''s (md5 %): read the live body first', o;
  end if;
  if c is not null and c <> '93ecebafdd6738762a480f75527fd508' then
    raise exception '0175 found a concept_thumbnail_credits() that is not this file''s body (md5 %): read the live body first', c;
  end if;
  if sp is not null and sp <> 'c27ede9c11d262b6047a93e0f81f4042' then
    raise exception '0175 found a series_episode_price(integer, text) that is not this file''s body (md5 %): read the live body first', sp;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The add-on's price
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.concept_thumbnail_credits(p_channel_id text) returns numeric
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_cfg jsonb;
  ig    public.credit_prices;
begin
  select c.agent_config into v_cfg from public.channels c where c.channel_id = p_channel_id;
  -- coalesce: a missing key, a null column or a non-string value is frame mode, never "unknown, so maybe concept".
  -- The trimmed characters are exactly Python's str.strip() set (str.isspace), not the locale's \s: a value the worker
  -- reads as concept and this read as frame would price the episode without the images, and the worker would refuse it.
  if not coalesce(jsonb_typeof(v_cfg -> 'thumbnail_mode') = 'string'
                  and lower(regexp_replace(v_cfg ->> 'thumbnail_mode',
                        '^[\t\n\v\f\r\x1c-\x20\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x20\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$',
                        '', 'g')) = 'concept', false) then
    return 0;
  end if;
  select * into ig from public.credit_prices where unit = 'image_generations';
  -- modules/credits.parse_prices: a missing, negative or non-finite rate is unpriced; such a margin is 0. (numeric accepts 'NaN',
  -- and NaN >= 0 holds in Postgres, so the table's check does not keep it out.)
  if ig.unit is null or ig.credits_per_unit is null or ig.credits_per_unit < 0 or ig.credits_per_unit = 'NaN'::numeric then
    return null;
  end if;
  -- 4: CONCEPT_THUMBNAIL_MAX_IMAGES (modules/credits.py, lib/credits.ts) — one image per A/B arm, at most 4 arms.
  return ig.credits_per_unit
         * (1 + case when ig.margin is null or ig.margin < 0 or ig.margin = 'NaN'::numeric then 0 else ig.margin end) * 4;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. A series episode, priced for its channel
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.series_episode_price(p_duration_s integer, p_channel_id text) returns numeric
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_base numeric := public.series_episode_price(p_duration_s);
  v_img  numeric;
begin
  if v_base is null then
    return null;
  end if;
  v_img := public.concept_thumbnail_credits(p_channel_id);
  if v_img is null then
    return null;           -- unpriced images: the episode is unpriced, never priced without them
  end if;
  if v_img = 0 then
    return v_base;
  end if;
  return round(public.credits_round_up(v_base + v_img), 2);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. quote_series_episode and start_series_episode (0120's bodies; only the price call changes)
-- ───────────────────────────────────────────────────────────────────────────

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
  -- 0175: the episode's channel decides one add-on (concept thumbnails), as the worker's floor does.
  v_price := case when v_ex then null else public.series_episode_price(ep.duration_s,
    (select p.channel_id from public.series_plans p where p.id = ep.plan_id)) end;
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
    -- 0175: what the worker's floor demands of this channel's run (modules/credits.minimum_reservation).
    v_price := public.series_episode_price(ep.duration_s, pl.channel_id);
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

-- ───────────────────────────────────────────────────────────────────────────
-- 4. A video asked for over MCP (0094's body; only the price changes)
-- ───────────────────────────────────────────────────────────────────────────

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

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Grants: the two helpers are internal; the callers keep 0120's / 0094's grants
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.concept_thumbnail_credits(text) from public, anon, authenticated, service_role;
revoke all on function public.series_episode_price(integer, text) from public, anon, authenticated, service_role;
revoke all on function public.quote_series_episode(uuid) from public, anon, authenticated, service_role;
revoke all on function public.start_series_episode(uuid, numeric, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.oauth_create_video(text, text, jsonb, text, text) from public, anon, authenticated, service_role;
grant execute on function public.quote_series_episode(uuid) to authenticated;
grant execute on function public.start_series_episode(uuid, numeric, text, boolean) to authenticated;
grant execute on function public.oauth_create_video(text, text, jsonb, text, text) to anon;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. End state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  sig  text;
  want text;
  got  text;
  r    text;
begin
  for sig, want in values
    ('public.quote_series_episode(uuid)', '9ffa67413ea6a90ec58e3b0bc4214078'),
    ('public.start_series_episode(uuid, numeric, text, boolean)', 'df19e5e9ad49c5772dbfa458919e1399'),
    ('public.oauth_create_video(text, text, jsonb, text, text)', '73145e68348088237a95b335fc162c08'),
    ('public.concept_thumbnail_credits(text)', '93ecebafdd6738762a480f75527fd508'),
    ('public.series_episode_price(integer, text)', 'c27ede9c11d262b6047a93e0f81f4042')
  loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into got from pg_proc p where p.oid = to_regprocedure(sig);
    if got is distinct from want then
      raise exception '0175 end state: % has md5 %, not %', sig, got, want;
    end if;
  end loop;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r, 'public.concept_thumbnail_credits(text)', 'EXECUTE')
       or has_function_privilege(r, 'public.series_episode_price(integer, text)', 'EXECUTE') then
      raise exception '0175 end state: % may call an internal price helper', r;
    end if;
  end loop;
end $$;
