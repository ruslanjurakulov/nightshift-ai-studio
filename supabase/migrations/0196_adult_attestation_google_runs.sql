-- 0196_adult_attestation_google_runs.sql — a video run spends on Google, so it needs an adult answer; a failover never picks an
-- adults-only model for someone without one; a routed answer says how many such models it left out.
--
-- EVIDENCE (S10, #830 merged): the twelve Google rows of the registry carry requires_adult, so a member with no answer is refused
--   Gemini in the Studio (0192). But a video run never names a registry model: the pipeline calls Gemini by vendor id for every
--   text stage (modules/gemini_client.py is its only text client; config.py GEMINI_MODEL and the GEMINI_MODEL_* stage variables,
--   config.py:228-259), and optionally Veo (video_provider 'veo', modules/video_providers.py:120) and Nano Banana (image_provider
--   'nano-banana', modules/image_providers.py:173-182) for footage. 0192's run gate on render_jobs refuses only a minor, so a
--   member who never answered spends on Google through Run now. 0192's own header names the gap.
-- DIAGNOSIS: the run's Google use is a property of the run, not of a model row, so 0192's model check cannot see it.
--
-- CHANGE (additive; five bodies replaced, each with marked 0196 hunks and nothing else changed; one trigger re-pointed):
--   render_run_google_stages(kind, params)   internal, immutable: which stages of a run go to Google. 'text' for every daily run
--     and every series plan (no channel or run field picks another text provider: AgentConfig, modules/channels.py:176, has none);
--     'video' when params.video_provider is 'veo'; 'image' when params.image_provider is 'nano-banana'; a provider of any shape but
--     a string or null counts as Google (fails closed). A scene repair is 'repair': its generator is the scene's own and is not read
--     here, so it counts as Google too (fail closed). The defaults the pipeline uses when a run names no footage provider
--     (CHRONOS_VIDEO_PROVIDER, default minimax, config.py:97; CHRONOS_IMAGE_PROVIDER, default pexels, config.py:169) live in the
--     runner's environment, which the database cannot read; they do not change the verdict, because the text stages are Google on
--     every run. command-center/lib/runBackend.ts runGoogleStages() is the same rule for the Actions dispatch, which writes no row.
--   adult_attestation_run_gate()   the trigger function now behind 0192's adult_attestation_run_gate on render_jobs (BEFORE INSERT):
--     a minor is refused adult_only_service, as before; a person in whose session the row is written who has no adult answer is
--     refused adult_attestation_required when the run uses Google (the remedy: confirm you are 18 or older on Create). No session
--     (the scheduler, the dispatcher, the worker) passes, as before.
--   api_create_video, oauth_create_video (0192's bodies, one marked hunk each): the same rule as a typed 428 before the price and
--     the hold.
--   route_model (0192's body, one marked hunk): the answer carries adult_skipped, how many adults-only models it left out (rule 5);
--     creative_route_quote (0075's body, one marked hunk) passes it on, so the routed quote a person reads says it too.
--   reroute_creative_job (0187's body, one marked hunk): a failover skips a candidate the job's requester has no adult answer for,
--     as it skips one they gave no rights acknowledgement for.
--
-- WHICH RUNS ARE ASKED, and how: Run now on the queue (the browser's insert) and on Actions (/api/agent/run asks first: the dispatch
--   writes no row); a series episode, a scene repair and, on the queue, an approved storyboard (their render_jobs rows; on Actions
--   the approval writes none, so /api/storyboards/[id]/approve asks first, by the same rule as Run now); the video API and the MCP
--   connection's video (typed 428). The scheduled daily run is written with no session and is never refused here. A hold the person
--   took before the refused insert stays open until it is released or expires, as after any refused insert; /api/agent/run asks
--   before it reserves, so Run now takes none.
--
-- REPLACES (md5 drift guard: the earlier body, or this file's own on a replay; whitespace runs read as one space):
--   creative_route_quote (0075): before 1b88440452f8fa7df45be3187fadcbda, after a00bbb719f3ef0b4b7a89d5e24a9d80a
--   route_model (0192): before 63ee303ce0f98a24fafa6bf934578f81, after 102366cbcd31d2d81b1bb67b90a4ed4b
--   api_create_video (0192): before b8ca36fa1be8f7a4837f095a6d534631, after 1e42321dd44b027750d0d76b12321811
--   oauth_create_video (0192): before 0b1807540e03ba06c0d98695a451c147, after 3775691c931eb209ed0b38c625a851a4
--   reroute_creative_job (0187): before 88ddf301ce242fafe8a8051d16ceab9e, after 4e43d78523acacf10799497afef0d39a
-- REPLAY. This file replays onto itself. 0192 and 0187 refuse to replay over it (their drift guards), but 0075 does NOT: re-running
--   it puts the old creative_route_quote back silently (and refuses nothing). Undo 0196 first (its rollback), re-run the older file,
--   then apply 0196 again, and run the Verify query below.
-- NUMBER. 0196 (0194 and 0195 are held by #821). Needs 0075, 0187 and 0192.
-- Undo: docs/sql/rollback_0196_adult_attestation_google_runs.sql (owner-applied): the five earlier bodies back, the trigger pointed
--   at 0192's adult_attestation_refuse_minor again, the two new functions dropped (the five earlier bodies, with 0075's).

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
  f text;
begin
  if to_regprocedure('public.adult_attestation_state(uuid)') is null or to_regprocedure('public.adult_attestation_refuse_minor()') is null then
    raise exception '0196 needs 0192_adult_attestation.sql: apply it first';
  end if;
  for r in select * from (values
      ('public.creative_route_quote(uuid, text, text, jsonb, text)', '1b88440452f8fa7df45be3187fadcbda', 'a00bbb719f3ef0b4b7a89d5e24a9d80a', '0075'),
      ('public.route_model(text, jsonb, text, uuid, text)', '63ee303ce0f98a24fafa6bf934578f81', '102366cbcd31d2d81b1bb67b90a4ed4b', '0192'),
      ('public.api_create_video(text, text, jsonb, text, text, text)', 'b8ca36fa1be8f7a4837f095a6d534631', '1e42321dd44b027750d0d76b12321811', '0192'),
      ('public.oauth_create_video(text, text, jsonb, text, text)', '0b1807540e03ba06c0d98695a451c147', '3775691c931eb209ed0b38c625a851a4', '0192'),
      ('public.reroute_creative_job(uuid, text, text)', '88ddf301ce242fafe8a8051d16ceab9e', '4e43d78523acacf10799497afef0d39a', '0187')) v(sig, was, now_, src) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is null or h <> all (array[r.was, r.now_]) then
      raise exception '0196 found % with a body that is neither %''s nor 0196''s (md5 %): read the live body first', r.sig, r.src, h;
    end if;
  end loop;
  -- 0192's run gate, pointed at 0192's function, or at this file's (a replay).
  select p.proname into f from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'public.render_jobs'::regclass and t.tgname = 'adult_attestation_run_gate' and not t.tgisinternal;
  if f is null or f not in ('adult_attestation_refuse_minor', 'adult_attestation_run_gate') then
    raise exception '0196 found render_jobs'' adult_attestation_run_gate missing or calling % (0192''s calls adult_attestation_refuse_minor): read it first', f;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Which stages of a run go to Google
-- ───────────────────────────────────────────────────────────────────────────

-- The same rule as command-center/lib/runBackend.ts runGoogleStages() (tests/test_adult_attestation_google_runs_migration.py pins
-- that both name the same providers and that the pipeline has no other text client).
create or replace function public.render_run_google_stages(p_kind text, p_params jsonb) returns text[]
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  p   jsonb := coalesce(p_params, '{}'::jsonb);
  out_ text[] := '{}';
begin
  case coalesce(p_kind, '')
    when 'daily', 'series_plan' then
      -- Topic, research, script, fact-check, packaging: Gemini, on every run (config.GEMINI_MODEL and its stage variables).
      out_ := out_ || 'text'::text;
    when 'repair' then
      -- The scene's own generator, not read here: counted as Google (fails closed).
      out_ := out_ || 'repair'::text;
    else
      out_ := out_ || 'unknown'::text;
  end case;
  if jsonb_typeof(p) = 'object' then
    if (jsonb_typeof(p -> 'video_provider') = 'string' and p ->> 'video_provider' = 'veo')
       or coalesce(jsonb_typeof(p -> 'video_provider'), 'null') not in ('string', 'null') then
      out_ := out_ || 'video'::text;
    end if;
    if (jsonb_typeof(p -> 'image_provider') = 'string' and p ->> 'image_provider' = 'nano-banana')
       or coalesce(jsonb_typeof(p -> 'image_provider'), 'null') not in ('string', 'null') then
      out_ := out_ || 'image'::text;
    end if;
  end if;
  return out_;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The run gate on render_jobs: a minor gets nothing; a run on Google needs an adult answer
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.adult_attestation_run_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  st  text := public.adult_attestation_state(auth.uid());
  g   text[];
begin
  if st = 'minor' then
    perform public.creative_refuse('adult_only_service', 'this service is for adults (18 or older); nothing was held');
  end if;
  -- No session (the scheduler, the dispatcher, the worker): not a person's request, never refused here.
  if uid is not null and st <> 'adult' then
    g := public.render_run_google_stages(new.kind, new.params);
    if cardinality(g) > 0 then
      perform public.creative_refuse('adult_attestation_required',
        format('this run uses Google (%s), whose terms are 18+; confirm you are 18 or older on Create', array_to_string(g, ', ')));
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists adult_attestation_run_gate on public.render_jobs;
create trigger adult_attestation_run_gate
  before insert on public.render_jobs
  for each row execute function public.adult_attestation_run_gate();

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The router: 0192's route_model, one marked hunk (adult_skipped)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.route_model(
  p_capability text, p_params jsonb, p_mode text, p_org uuid, p_surface text default 'web'
) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  cap     text := lower(btrim(coalesce(p_capability, '')));
  md      text := lower(btrim(coalesce(p_mode, '')));
  surf    text := coalesce(p_surface, 'web');
  problem text;
  ids     text[];
  m       text;
  sp      jsonb;
  q       jsonb;
  c       numeric;
  cands   jsonb := '[]'::jsonb;
  ranked  jsonb;
  top     jsonb;
  reason  text;
  -- 0192: priced candidates left out because this person has no adult attestation.
  adult_skipped integer := 0;
begin
  if md not in ('auto', 'cheap', 'fast', 'quality') then
    perform public.creative_refuse('invalid_params', 'mode must be auto, cheap, fast or quality');
  end if;
  if surf not in ('web', 'api', 'mcp') then
    perform public.creative_refuse('invalid_params', 'unknown surface');
  end if;
  -- 0192: someone who said they are under 18 gets nothing, in any mode (the same word as an exact quote or job).
  if public.adult_attestation_state(auth.uid()) = 'minor' then
    perform public.creative_refuse('adult_only_service', 'this service is for adults (18 or older)');
  end if;
  -- What does not depend on the model, once, with creative_price's own
  -- refusals: a bad prompt or another organization's picture reads the same
  -- in every mode (and never as "no model").
  if cap !~ '^[a-z][a-z0-9_]{0,31}$' then
    perform public.creative_refuse('invalid_params', 'capability is required');
  end if;
  if not public.creative_capability_supported(cap) then
    perform public.creative_refuse('capability_not_supported',
      format('%s cannot be generated yet on this deployment', cap));
  end if;
  problem := public.creative_params_problem(cap, p_params);
  if problem is not null then
    perform public.creative_refuse('invalid_params', problem);
  end if;
  problem := public.creative_source_problem(p_org, cap, p_params);
  if problem is not null then
    perform public.creative_refuse('source_unavailable', problem);
  end if;
  problem := public.creative_style_problem(p_org, cap, p_params);
  if problem is not null then
    perform public.creative_refuse('style_unavailable', problem);
  end if;

  -- The models this surface sells for the capability (none: a capability
  -- sellable_models does not know yet).
  begin
    select array_agg(s.id order by s.id) into ids from public.sellable_models(cap, surf) s;
  exception when sqlstate '22023' then
    ids := null;
  end;
  foreach m in array coalesce(ids, '{}'::text[]) loop
    -- Priced for THESE params and THIS organization, or not a candidate.
    begin
      q := public.creative_price(p_org, cap, m, p_params);
    exception when sqlstate 'NS400' then
      continue;
    end;
    c := (q ->> 'credits')::numeric;
    if c is null or c <= 0 then
      continue;
    end if;
    -- 0192: a model whose vendor's terms are 18+ is not a candidate for a person without an adult attestation. The route picks
    -- among the others, and the failover list (stored from these candidates) never reaches it either.
    if public.adult_attestation_missing(auth.uid(), m) then
      adult_skipped := adult_skipped + 1;
      continue;
    end if;
    select r.spec into sp from public.model_registry r where r.id = m;
    cands := cands || jsonb_build_array(jsonb_build_object(
      'model', m, 'credits', c,
      'quality_tier', case when jsonb_typeof(sp -> 'quality_tier') = 'number'
                           then least(greatest((sp ->> 'quality_tier')::numeric, 0), 5) else 0 end,
      'speed_tier', case when jsonb_typeof(sp -> 'speed_tier') = 'number'
                         then least(greatest((sp ->> 'speed_tier')::numeric, 0), 5) else 0 end));
  end loop;
  -- 0192: nothing left but models that need an adult attestation: the remedy is the attestation, not another setting.
  if jsonb_array_length(cands) = 0 and adult_skipped > 0 then
    perform public.creative_refuse('adult_attestation_required',
      format('every model that can make this is for adults only (%s); confirm you are 18 or older in the app', adult_skipped));
  end if;
  if jsonb_array_length(cands) = 0 then
    perform public.creative_refuse('no_model_available',
      'no available, priced model can make this with these settings');
  end if;

  select jsonb_agg(x.e order by x.k1, x.k2, x.k3, x.k4, x.e ->> 'model') into ranked
    from (select e,
                 case md when 'cheap' then (e ->> 'credits')::numeric
                         when 'fast' then -(e ->> 'speed_tier')::numeric
                         when 'quality' then -(e ->> 'quality_tier')::numeric
                         else case when (e ->> 'quality_tier')::numeric >= 4 then 0 else 1 end end as k1,
                 case md when 'cheap' then -(e ->> 'quality_tier')::numeric
                         when 'fast' then (e ->> 'credits')::numeric
                         when 'quality' then (e ->> 'credits')::numeric
                         else case when (e ->> 'quality_tier')::numeric >= 4 then 0
                                   else -(e ->> 'quality_tier')::numeric end end as k2,
                 case md when 'cheap' then -(e ->> 'speed_tier')::numeric
                         when 'fast' then -(e ->> 'quality_tier')::numeric
                         when 'quality' then -(e ->> 'speed_tier')::numeric
                         else (e ->> 'credits')::numeric end as k3,
                 case md when 'auto' then -(e ->> 'speed_tier')::numeric else 0 end as k4
            from jsonb_array_elements(cands) e) x;
  top := ranked -> 0;
  reason := case when jsonb_array_length(ranked) = 1 then 'only_option'
                 when md = 'cheap' then 'cheapest'
                 when md = 'fast' then 'fastest'
                 when md = 'quality' then 'best_quality'
                 when (top ->> 'quality_tier')::numeric >= 4 then 'best_value'
                 else 'best_available' end;
  return jsonb_build_object(
    'model', top ->> 'model', 'credits', top -> 'credits', 'mode', md, 'reason', reason,
    'quality_tier', top -> 'quality_tier', 'speed_tier', top -> 'speed_tier', 'surface', surf,
    'considered', jsonb_array_length(ranked),
    -- 0196: how many models that could make this were left out because they are for adults only and this person has no adult
    -- answer (rule 5): a "best_quality" pick that skipped one is the best of what was allowed, and the answer says so.
    'adult_skipped', adult_skipped,
    -- The failover order: at most five, the pick first.
    'candidates', (select jsonb_agg(t.e order by t.n) from jsonb_array_elements(ranked) with ordinality t(e, n)
                    where t.n <= 5));
end
$$;
revoke all on function public.route_model(text, jsonb, text, uuid, text) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3b. The routed quote: 0075's creative_route_quote, one marked hunk (passes adult_skipped on)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.creative_route_quote(
  p_org uuid, p_capability text, p_mode text, p_params jsonb, p_surface text
) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  md  text := lower(btrim(coalesce(p_mode, '')));
  rt  jsonb;
  q   jsonb;
  dn  text;
  acc public.credit_accounts;
begin
  if auth.uid() is null or not public.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if md not in ('auto', 'cheap', 'fast', 'quality') then
    perform public.creative_refuse('invalid_params',
      'mode must be auto, cheap, fast or quality (exact: quote the model itself)');
  end if;
  rt := public.route_model(p_capability, p_params, md, p_org, p_surface);
  q := public.creative_price(p_org, p_capability, rt ->> 'model', p_params);
  select r.display_name into dn from public.model_registry r where r.id = rt ->> 'model';
  select * into acc from public.credit_accounts where org_id = p_org;
  -- The price, never the platform's economics behind it (BR-G-001 / BR-L-023).
  return (q - 'margin' - 'credits_per_unit') || jsonb_build_object(
    'mode', md, 'routed_model', rt ->> 'model', 'route_reason', rt ->> 'reason',
    'display_name', dn, 'quality_tier', rt -> 'quality_tier', 'speed_tier', rt -> 'speed_tier',
    -- 0196: how many adults-only models the route left out for this person (route_model's adult_skipped): a "best quality" pick
    -- is the best of what this person may use, and the quote says so (rule 5). 0 when none was.
    'adult_skipped', coalesce(rt -> 'adult_skipped', '0'::jsonb),
    'available', case when public.credits_exempt(p_org) then null
                      else coalesce(acc.balance - acc.reserved, 0) end);
end
$$;
revoke all on function public.creative_route_quote(uuid, text, text, jsonb, text) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The video API: 0192's api_create_video, one marked hunk
-- ───────────────────────────────────────────────────────────────────────────

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
    -- 0192: the key acts as its creator, and an MCP grant as its person (api_act_as), so auth.uid() is the person. Someone who said
    -- they are under 18 gets no video: asked before the price and the API hold, and in an exempt organization too (which takes no
    -- hold at all). Answered as a 403 that says why; an error raised inside this block would read as a 500 "retry".
    if public.adult_attestation_state(auth.uid()) = 'minor' then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(403, 'adult_only_service',
        'Nightshift is for adults (18 or older). Nothing was held or charged.')));
    end if;

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
    -- 0196: a video run spends on Google (render_run_google_stages: the research and the script are always Gemini's), whose terms
    -- are 18+, so the key's person needs an adult answer, as for a Google model in the Studio. A typed 428 with the remedy, after the
    -- request's own checks and before the price and the API hold.
    if public.adult_attestation_state(auth.uid()) <> 'adult'
       and cardinality(public.render_run_google_stages('daily', v_p)) > 0 then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(428, 'adult_attestation_required',
        'This video is made with Google''s Gemini (its research and script), and Google''s terms require users to be 18 or older. Confirm you are 18 or older on Create in the app, then retry. Nothing was held or charged.',
        jsonb_build_object('google_stages', to_jsonb(public.render_run_google_stages('daily', v_p))))));
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
revoke all on function public.api_create_video(text, text, jsonb, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.api_create_video(text, text, jsonb, text, text, text) to anon;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The MCP connection's video: 0192's oauth_create_video, one marked hunk
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
    -- 0192: the connection acts as its person. Someone who said they are under 18 gets no new video: refused after a replay of the
    -- same key is answered (a job made before the answer is that job, not a false "nothing was held"), and before the channel,
    -- the price and the hold, as a 403 that says why (the hold gate alone would be caught by this block's "when others" as a 500).
    if public.adult_attestation_state(auth.uid()) = 'minor' then
      return public.api_finish(ctx, public.api_err(403, 'adult_only_service',
        'Nightshift is for adults (18 or older). Nothing was held or charged.'));
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
    -- 0196: as api_create_video: a run spends on Google, so the connection's person needs an adult answer (a typed 428, after the
    -- request's own checks and before the price and the hold; a replay of a job made before is answered above, as that job).
    if public.adult_attestation_state(auth.uid()) <> 'adult'
       and cardinality(public.render_run_google_stages('daily', v_p)) > 0 then
      return public.api_finish(ctx, public.api_err(428, 'adult_attestation_required',
        'This video is made with Google''s Gemini (its research and script), and Google''s terms require users to be 18 or older. Confirm you are 18 or older on Create in the app, then retry. Nothing was held or charged.',
        jsonb_build_object('google_stages', to_jsonb(public.render_run_google_stages('daily', v_p)))));
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
revoke all on function public.oauth_create_video(text, text, jsonb, text, text) from public, anon, authenticated, service_role;
grant execute on function public.oauth_create_video(text, text, jsonb, text, text) to anon;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The failover: 0187's reroute_creative_job, one marked hunk
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.reroute_creative_job(p_job uuid, p_worker text, p_code text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  w     text := left(btrim(coalesce(p_worker, '')), 120);
  code  text := lower(btrim(coalesce(p_code, '')));
  org   uuid;
  j     public.creative_jobs;
  tried jsonb;
  rr    public.creative_job_routes;
  surf  text;
  q0    numeric;
  cq    numeric;
  cand  jsonb;
  m     text;
  q     jsonb;
  price numeric;
  jparams jsonb;
begin
  if not public.credits_trusted_caller() then
    raise exception 'creative jobs are run by the platform''s worker only' using errcode = '42501';
  end if;
  -- Only a failure that PROVES no vendor task exists (header, BR-L-019):
  -- never 'unavailable' (a timeout or a 5xx: the vendor may be billing), never
  -- a refusal of the request itself (policy, bad_request). Anything else
  -- returns before the row is touched: its submit_started_at stands.
  if code not in ('unreachable', 'rate_limited', 'quota', 'auth', 'not_configured', 'not_found',
                  'adapter_missing') then
    return null;
  end if;
  select org_id into org from public.creative_jobs where id = p_job;
  if org is null then
    return null;
  end if;
  perform public.credit_account_lock(org);
  select * into j from public.creative_jobs where id = p_job for update;
  if j.worker_id is distinct from w or j.status <> 'running' or j.provider_task_id is not null then
    return null;
  end if;
  -- exact never fails over: the person's model, or nothing.
  if j.mode = 'exact' or j.routing is null then
    return null;
  end if;
  select * into rr from public.creative_job_routes where job_id = p_job for update;
  if not found then
    return null;
  end if;
  tried := rr.tried;
  if jsonb_array_length(tried) >= 3 then
    return null;
  end if;
  surf := coalesce(j.routing ->> 'surface', 'web');
  q0 := coalesce(rr.quality_tier, 0);
  for cand in select t.e from jsonb_array_elements(rr.candidates)
                             with ordinality t(e, n) order by t.n loop
    m := cand ->> 'model';
    continue when m is null or tried ? m;
    cq := coalesce((cand ->> 'quality_tier')::numeric, 0);
    continue when j.mode = 'quality' and cq <> q0;
    continue when j.mode = 'auto' and cq < q0;
    continue when not exists (select 1 from public.sellable_models(j.capability, surf) s where s.id = m);
    -- 0187: a failover never sends an input to a model that would have refused it at create_creative_job: a candidate that
    -- requires a rights acknowledgement the job's requester has not given for every input (rights_acknowledgement_missing:
    -- the source and end files, the style kit's and the mentioned @characters' pictures) is skipped. A job with no requester
    -- has nobody who could have acknowledged, so every such candidate is skipped (fail closed).
    continue when public.rights_acknowledgement_missing(j.org_id, j.requested_by, m, j.params) is not null;
    -- 0196: nor to a model whose vendor's terms are 18+ when the job's requester has no adult answer (adult_attestation_missing,
    -- 0192): create_creative_job would have refused it. A job with no requester skips every such candidate (fail closed).
    continue when public.adult_attestation_missing(j.requested_by, m);
    begin
      -- The job's own params: the settings the person's quote priced.
      q := public.creative_price(j.org_id, j.capability, m, j.params);
    exception when sqlstate 'NS400' then
      continue;
    end;
    price := (q ->> 'credits')::numeric;
    continue when price is null or price <= 0 or price > j.quoted_credits;
    -- No dearer than the hold, which is the quote (BR-L-020).
    -- The variant this model is priced at is what the worker sends (0060 / 0070).
    jparams := j.params;
    if q ? 'quality' then
      jparams := jparams || jsonb_build_object('quality', q ->> 'quality');
    end if;
    if q ? 'resolution' then
      jparams := jparams || jsonb_build_object('resolution', q ->> 'resolution');
    end if;
    if q ? 'audio' then
      jparams := jparams || jsonb_build_object('audio', (q ->> 'audio')::boolean);
    end if;
    -- The row describes the model that runs now: its price, unit and quantity
    -- (BR-L-024). submit_started_at is cleared ONLY here, where no task can
    -- exist: the worker submits a new one to the new model.
    update public.creative_jobs
       set fallback_from = j.routed_model, fallback_reason = 'unavailable', routed_model = m,
           routed_credits = price, params = jparams, submit_started_at = null,
           credit_unit = coalesce(q ->> 'unit', j.credit_unit),
           quantity = coalesce((q ->> 'quantity')::numeric, j.quantity),
           heartbeat_at = now(), updated_at = now()
     where id = p_job;
    -- The real reason is the platform's: it stays in the platform-only route
    -- row, and the member-readable row and log say only 'unavailable'.
    update public.creative_job_routes r
       set tried = r.tried || to_jsonb(m), reasons = r.reasons || to_jsonb(code)
     where r.job_id = p_job;
    perform public.creative_job_log(p_job, j.org_id, 'rerouted', 'running',
      jsonb_build_object('from', j.routed_model, 'to', m, 'code', 'unavailable', 'credits', price));
    -- The worker sends exactly these params to the new model.
    return jsonb_build_object('model', m, 'credits', price, 'params', jparams);
  end loop;
  return null;
end
$$;
revoke all on function public.reroute_creative_job(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.reroute_creative_job(uuid, text, text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Privileges
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.render_run_google_stages(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.adult_attestation_run_gate() from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. End state (refuses the whole transaction if any of it is not so)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  r record;
begin
  for r in select * from (values
      ('public.creative_route_quote(uuid, text, text, jsonb, text)', 'a00bbb719f3ef0b4b7a89d5e24a9d80a'),
      ('public.route_model(text, jsonb, text, uuid, text)', '102366cbcd31d2d81b1bb67b90a4ed4b'),
      ('public.api_create_video(text, text, jsonb, text, text, text)', '1e42321dd44b027750d0d76b12321811'),
      ('public.oauth_create_video(text, text, jsonb, text, text)', '3775691c931eb209ed0b38c625a851a4'),
      ('public.reroute_creative_job(uuid, text, text)', '4e43d78523acacf10799497afef0d39a')) v(sig, want) loop
    if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(r.sig)) is distinct from r.want then
      raise exception '0196 end state: % is not 0196''s body', r.sig;
    end if;
  end loop;
  if not exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                  where t.tgrelid = 'public.render_jobs'::regclass and t.tgname = 'adult_attestation_run_gate'
                    and p.proname = 'adult_attestation_run_gate' and t.tgtype = 7 and t.tgqual is null and t.tgenabled = 'O') then
    raise exception '0196 end state: render_jobs'' run gate is not BEFORE INSERT on adult_attestation_run_gate()';
  end if;
  for r in select * from unnest(array['public.render_run_google_stages(text, jsonb)', 'public.adult_attestation_run_gate()']) sig,
                         unnest(array['anon', 'authenticated', 'service_role']) role_ loop
    if has_function_privilege(r.role_, r.sig, 'EXECUTE') then
      raise exception '0196 end state: % may call %', r.role_, r.sig;
    end if;
  end loop;
  if not (select p.prosecdef from pg_proc p where p.oid = 'public.adult_attestation_run_gate()'::regprocedure) then
    raise exception '0196 end state: the run gate is not SECURITY DEFINER';
  end if;
  if not has_function_privilege('anon', 'public.api_create_video(text, text, jsonb, text, text, text)', 'EXECUTE')
     or not has_function_privilege('anon', 'public.oauth_create_video(text, text, jsonb, text, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.reroute_creative_job(uuid, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.route_model(text, jsonb, text, uuid, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.creative_route_quote(uuid, text, text, jsonb, text)', 'EXECUTE') then
    raise exception '0196 end state: a replaced function''s grants are not the ones its file left';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying, and after any manual replay of 0192 or 0187; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.route_model(text,jsonb,text,uuid,text)'::regprocedure) = '102366cbcd31d2d81b1bb67b90a4ed4b' as route_model_0196,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.api_create_video(text,text,jsonb,text,text,text)'::regprocedure) = '1e42321dd44b027750d0d76b12321811' as api_create_video_0196,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.oauth_create_video(text,text,jsonb,text,text)'::regprocedure) = '3775691c931eb209ed0b38c625a851a4' as oauth_create_video_0196,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.reroute_creative_job(uuid,text,text)'::regprocedure) = '4e43d78523acacf10799497afef0d39a' as reroute_creative_job_0196,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.creative_route_quote(uuid,text,text,jsonb,text)'::regprocedure) = 'a00bbb719f3ef0b4b7a89d5e24a9d80a' as creative_route_quote_0196,
--   (select p.proname = 'adult_attestation_run_gate' from pg_trigger t join pg_proc p on p.oid = t.tgfoid
--     where t.tgrelid = 'public.render_jobs'::regclass and t.tgname = 'adult_attestation_run_gate')                as run_gate_google,
--   public.render_run_google_stages('daily', '{}'::jsonb) = array['text']                                                as text_is_google;
