-- rollback_0192_adult_attestation.sql — takes migration 0192 (the adult attestation gate) out of the quote and job path.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT COMES BACK: 0036's quote_creative_job and creative_platform_reserve, 0075's route_model, 0188's sellable_models, 0174's
--   create_creative_job and api_creative_refusal, 0147's api_create_video, 0171's quote_film, 0187's start_film, 0191's
--   oauth_creative_quote and oauth_creative_models, 0170's api_request_download and 0094's oauth_create_video, none of which asks
--   for an age answer, and no hold gate. A requires_adult model is then sold to anyone, and a person who said they are under 18 is
--   sold everything: apply this only while no requires_adult model is on sale, and say so to the owner.
-- WHAT IS KEPT: the record. adult_attestations (its rows, its RLS and its append-only triggers) stays as it is: who answered what
--   must outlive a rollback. Applying 0192 again picks it up as its own.
-- WHAT IS LOST: record_adult_attestation, my_adult_attestation, the five helpers, and the two gates (the trigger function,
--   adult_attestation_hold_gate on credit_reservations and adult_attestation_download_gate on download_requests).
--   The app's age question then answers "not available".
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if any of the thirteen bodies is not 0192's (a later change would be undone).
--   1. Puts the thirteen earlier bodies back, verbatim, with their grants.
--   2. Drops the two gate triggers and the eight 0192 functions that are not the append-only trigger's.
--   3. Asserts the end state.

begin;
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.quote_creative_job(uuid, text, text, jsonb)', 'd80ebb592f6383c7289952a3411bf758'),
      ('public.route_model(text, jsonb, text, uuid, text)', '63ee303ce0f98a24fafa6bf934578f81'),
      ('public.sellable_models(text, text)', '40f61462ddae2fc0e83a0956f4d8b75b'),
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', 'a5e00e65d1161bccd2acefb7745e659b'),
      ('public.api_creative_refusal(text, text, text)', '2553f7ab2715949762b6fc6fd7cf3300'),
      ('public.creative_platform_reserve(uuid, text, numeric)', '96d5dd0351ee79ebdbf6b649f92f9e6c'),
      ('public.quote_film(uuid, integer)', '00846d0622ab379810c633b2446436b0'),
      ('public.start_film(uuid, text, text)', '595e90f836f992699cf9e920ad646787'),
      ('public.api_create_video(text, text, jsonb, text, text, text)', 'b8ca36fa1be8f7a4837f095a6d534631'),
      ('public.oauth_creative_quote(text, text, text, jsonb, text)', 'e3340606260711781f202aff7abdcdee'),
      ('public.oauth_creative_models(text, text, text)', 'beafb530957690f51366c995468ad36f'),
      ('public.api_request_download(text, text, text, text, text, text)', '4ca4086b260f0cec97edc16acb5e2c6b'),
      ('public.oauth_create_video(text, text, jsonb, text, text)', '4c01906922aa8bb5a2205dd76fbfe992')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0192: % is not 0192''s body (md5 %): a later change would be undone; read the live body first', r.sig, h;
    end if;
  end loop;
end $$;

-- quote_creative_job: 0036's body, verbatim (0036_creative_jobs.sql).
create or replace function public.quote_creative_job(
  p_org uuid, p_capability text, p_model text, p_params jsonb default '{}'::jsonb
) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  q   jsonb;
  acc public.credit_accounts;
begin
  if auth.uid() is null or not public.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  q := public.creative_price(p_org, p_capability, p_model, p_params);
  select * into acc from public.credit_accounts where org_id = p_org;
  return q || jsonb_build_object(
    'available', case when public.credits_exempt(p_org) then null
                      else coalesce(acc.balance - acc.reserved, 0) end);
end
$$;
revoke all on function public.quote_creative_job(uuid, text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.quote_creative_job(uuid, text, text, jsonb) to authenticated;

-- route_model: 0075's body, verbatim (0075_model_router.sql).
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
begin
  if md not in ('auto', 'cheap', 'fast', 'quality') then
    perform public.creative_refuse('invalid_params', 'mode must be auto, cheap, fast or quality');
  end if;
  if surf not in ('web', 'api', 'mcp') then
    perform public.creative_refuse('invalid_params', 'unknown surface');
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
    select r.spec into sp from public.model_registry r where r.id = m;
    cands := cands || jsonb_build_array(jsonb_build_object(
      'model', m, 'credits', c,
      'quality_tier', case when jsonb_typeof(sp -> 'quality_tier') = 'number'
                           then least(greatest((sp ->> 'quality_tier')::numeric, 0), 5) else 0 end,
      'speed_tier', case when jsonb_typeof(sp -> 'speed_tier') = 'number'
                         then least(greatest((sp ->> 'speed_tier')::numeric, 0), 5) else 0 end));
  end loop;
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
    -- The failover order: at most five, the pick first.
    'candidates', (select jsonb_agg(t.e order by t.n) from jsonb_array_elements(ranked) with ordinality t(e, n)
                    where t.n <= 5));
end
$$;
revoke all on function public.route_model(text, jsonb, text, uuid, text) from public, anon, authenticated, service_role;

-- create_creative_job: 0174's body, verbatim (0174_rights_acknowledgement.sql).
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

-- sellable_models: 0188's body, verbatim (0188_recraft_web_mcp.sql).
create or replace function public.sellable_models(p_capability text default null, p_surface text default 'web')
  returns table (
    id text, display_name text, provider text, capabilities text[], availability text,
    verified_at timestamptz, credit_unit text, entitlement text,
    credits_per_unit numeric, margin numeric, spec jsonb)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_surface is null or p_surface not in ('web', 'api', 'mcp') then
    raise exception 'unknown surface %', p_surface using errcode = '22023';
  end if;
  if p_capability is not null
     and p_capability not in ('t2i', 'edit', 't2v', 'i2v', 'tts', 'sfx', 'upscale', 'remove_bg',
                              'voice_change', 'dub', 'video_upscale', 'describe', 'captions',
                              'expand', 'relight', 'erase', 'video_edit', 'video_reframe', 'video_remove_bg') then
    raise exception 'unknown capability %', p_capability using errcode = '22023';
  end if;
  -- Captions are a web tool (0072): the transcript lives in caption_tracks,
  -- which only a signed-in member's session can read. Sold through the API or
  -- MCP (api_creative_model_ok asks this function for 'api'), a key could pay
  -- for a job whose result it can never fetch. No other surface lists them,
  -- whatever the registry says.
  if p_capability = 'captions' and p_surface <> 'web' then
    return;
  end if;
  return query
    select m.id, m.display_name, m.provider, m.capabilities, m.availability, m.verified_at,
           -- 0084: the rate as charged (margin folded in) and never the margin
           -- itself. The column stays (NULL) so the return type, and every
           -- earlier migration's create-or-replace on a replay, is unchanged.
           m.credit_unit, m.entitlement, cp.credits_per_unit * (1 + cp.margin), null::numeric,
           -- The public half of spec: what a person choosing a model needs.
           -- Never provider costs, evidence, notes, the probe or the vendor id.
           jsonb_strip_nulls(jsonb_build_object(
             'output', m.spec -> 'output', 'inputs', m.spec -> 'inputs',
             'aspect_ratios', m.spec -> 'aspect_ratios',
             'aspect_ratios_by_capability', m.spec -> 'aspect_ratios_by_capability',
             'image_sizes', m.spec -> 'image_sizes', 'resolutions', m.spec -> 'resolutions',
             'durations_s', m.spec -> 'durations_s', 'audio_out', m.spec -> 'audio_out',
             'upscale_factors', m.spec -> 'upscale_factors', 'languages', m.spec -> 'languages',
             'upscale_targets', m.spec -> 'upscale_targets', 'end_frame', m.spec -> 'end_frame',
             'async', m.spec -> 'async', 'unit', m.spec -> 'pricing' -> 'unit',
             'qualities', m.spec -> 'qualities',
             'relight_looks', m.spec -> 'relight_looks',
             'default_resolution', m.spec -> 'default_resolution',
             'price_variants_by', m.spec -> 'pricing' -> 'variants' -> 'by',
             'attribution', m.spec -> 'attribution', 'api_exposure', m.spec -> 'api_exposure',
             'limits', m.spec -> 'limits', 'quality_tier', m.spec -> 'quality_tier',
             'speed_tier', m.spec -> 'speed_tier'))
      from public.model_registry m
      join public.credit_prices cp on cp.unit = m.credit_unit
     where m.availability in ('beta', 'ga')
       and m.verified_at is not null
       and m.verified_probe_id is not null
       and coalesce(m.spec ->> 'terms_gate', '') = ''
       and cp.credits_per_unit > 0
       -- 0124: the owner's switch (model_is_available is TRUE for every model until it is put in force).
       and public.model_is_available(m.id)
       -- 0125: a shutdown date the vendor announced (spec.shutdown.on) that has come ends the sale.
       and not public.model_past_shutdown(m.spec)
       -- A model sold by quality is shown only when at least one of its tiers
       -- has a price: a tier without a row is unpriced, never free.
       and (m.spec -> 'pricing' -> 'variants' ->> 'by' is distinct from 'quality'
            or exists (select 1
                         from jsonb_array_elements_text(coalesce(m.spec -> 'qualities', '[]'::jsonb)) as tiers(tier)
                         join public.credit_prices qp on qp.unit = m.credit_unit || '_' || tiers.tier
                        where qp.credits_per_unit > 0))
       -- Likewise a model sold by soundtrack, or by a resolution it pins (0070):
       -- shown only while one of its variants has a price (never free).
       and (not (coalesce(m.spec -> 'pricing' -> 'variants' ->> 'by', '') in ('audio', 'resolution_audio')
                 or (coalesce(m.spec -> 'pricing' -> 'variants' ->> 'by', '') = 'resolution'
                     and nullif(m.spec ->> 'default_resolution', '') is not null))
            or exists (select 1
                         from jsonb_object_keys(coalesce(m.spec -> 'pricing' -> 'variants' -> 'prices', '{}'::jsonb)) as vk(variant)
                         join public.credit_prices vp
                           on vp.unit = m.credit_unit || '_' || regexp_replace(lower(vk.variant), '[^a-z0-9]', '_', 'g')
                        where vp.credits_per_unit > 0))
       and (p_capability is null or p_capability = any (m.capabilities))
       -- 0188: 'web_mcp' is sold on the web and to the 'mcp' surface (our own signed-in connector), never to 'api' (the public
       -- developer API: a vendor's written permission can stop short of it). Only 'any' opens 'api'; a value this file does not
       -- know opens nothing but the web (fail closed).
       and (p_surface = 'web' or coalesce(m.spec ->> 'api_exposure', 'any') = 'any'
            or (p_surface = 'mcp' and m.spec ->> 'api_exposure' = 'web_mcp'))
       and (p_surface = 'web' or not ('captions' = any (m.capabilities)))
     order by m.provider, m.id;
end
$$;
revoke all on function public.sellable_models(text, text) from public, anon;
grant execute on function public.sellable_models(text, text) to authenticated, service_role;

-- api_creative_refusal: 0174's body, verbatim (0174_rights_acknowledgement.sql).
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

-- creative_platform_reserve: 0036's body, verbatim (0036_creative_jobs.sql).
create or replace function public.creative_platform_reserve(p_org uuid, p_ref text, p_amount numeric)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  saved text := current_setting('request.jwt.claims', true);
  out_  jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  begin
    out_ := public.reserve_credits(p_org, p_ref, p_amount);
  exception when others then
    perform set_config('request.jwt.claims', coalesce(saved, ''), true);
    raise;
  end;
  perform set_config('request.jwt.claims', coalesce(saved, ''), true);
  return out_;
end
$$;
revoke all on function public.creative_platform_reserve(uuid, text, numeric) from public, anon, authenticated, service_role;

-- quote_film: 0171's body, verbatim (0171_films_money.sql).
create or replace function public.quote_film(p_film uuid, p_version integer) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  org      uuid;
  f        public.films;
  q        jsonb;
  st       jsonb;
  avail    numeric;
  active   integer;
  slots    jsonb;
  blocked  jsonb := '[]'::jsonb;
  exempt_  boolean;
  may      boolean;
  on_      boolean;
  lim      jsonb := public.film_money_limits();
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select x.org_id into org from public.films x where x.id = p_film;
  if org is null or not public.is_org_member(org, 'viewer') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into f from public.films where id = p_film;
  if not public.film_is_editable(f.status) then
    perform public.creative_refuse('film_not_editable', format('a %s film is not quoted again', f.status), 'NS409');
  end if;
  if p_version is distinct from f.version then
    perform public.creative_refuse('film_changed', format('the film is at version %s', f.version), 'NS409');
  end if;
  perform public.film_take_rate('quote', (lim ->> 'quotes_per_hour')::integer);
  q := public.film_price(f);
  if (q ->> 'priced')::boolean then
    insert into public.film_quotes (film_id, org_id, version, quote_id, total, created_by, expires_at)
    values (f.id, org, f.version, q ->> 'quote_id', (q ->> 'total')::numeric, auth.uid(),
            now() + make_interval(mins => (lim ->> 'quote_minutes')::integer))
    on conflict (film_id, quote_id) do update set expires_at = excluded.expires_at, total = excluded.total;
  end if;
  delete from public.film_quotes where film_id = f.id and (version <> f.version or expires_at <= now());

  exempt_ := public.credits_exempt(org);
  on_ := public.film_studio_on();
  st := public.film_settings_of(org);
  avail := public.film_available(org);
  active := (select count(*) from public.film_segments s where s.org_id = org and s.status in ('queued', 'running', 'draining'));
  slots := public.org_run_slots(org);
  if not on_ then
    blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'film_studio_disabled'));
  end if;
  if (q ->> 'priced')::boolean then
    if st ->> 'max_credits_per_film' is not null and (q ->> 'total')::numeric > (st ->> 'max_credits_per_film')::numeric then
      blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'cap_exceeded', 'limit', st -> 'max_credits_per_film'));
    end if;
    if not exempt_ and (q ->> 'total')::numeric > avail then
      blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'insufficient_credits', 'available', avail,
                                                                 'needed', q -> 'total'));
    end if;
  end if;
  if active >= (st ->> 'max_active_films')::integer then
    blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'limit_reached', 'active', active,
                                                               'limit', st -> 'max_active_films'));
  end if;
  if not exempt_ and slots is not null and (slots ->> 'active')::integer >= (slots ->> 'limit')::integer then
    blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'run_slots_full', 'active', slots -> 'active',
                                                               'limit', slots -> 'limit'));
  end if;
  may := public.is_org_member(org, 'admin') and (not exempt_ or public.is_platform_admin());
  return q || jsonb_build_object(
    'exempt', exempt_, 'available', avail, 'settings', st, 'active_films', active, 'film_studio_enabled', on_,
    -- 0034 counts the film's hold as one of the plan's parallel runs for as long as it is open: the app warns before Start.
    'run_slot', jsonb_build_object('uses_run_slot', not exempt_, 'slots', slots,
                                   'max_hours', (lim ->> 'unclaimed_hours')::integer + (lim ->> 'deadline_hours')::integer
                                                + (lim ->> 'grace_hours')::integer),
    'quote_expires_at', (select x.expires_at from public.film_quotes x where x.film_id = f.id and x.quote_id = q ->> 'quote_id'),
    'blocked_by', blocked, 'may_start', may,
    'startable', (q ->> 'priced')::boolean and jsonb_array_length(blocked) = 0 and may,
    'limits', lim);
end
$$;
revoke all on function public.quote_film(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.quote_film(uuid, integer) to authenticated;

-- start_film: 0187's body, verbatim (0187_rights_acknowledgement_inputs.sql).
create or replace function public.start_film(p_film uuid, p_quote_id text, p_idempotency_key text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  org     uuid;
  f       public.films;
  s       public.film_segments;
  q       jsonb;
  st      jsonb;
  ln      jsonb;
  bad     jsonb;
  sid     uuid := gen_random_uuid();
  ref     text;
  exempt_ boolean;
  total   numeric;
  hash    text;
  asm     jsonb;
  n_takes integer := 0;
  v       integer;
  w       text;
  d       text;
  msg     text;
  fq      public.film_quotes;
  lim     jsonb := public.film_money_limits();
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select x.org_id into org from public.films x where x.id = p_film;
  if org is null or not public.is_org_member(org, 'viewer') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  exempt_ := public.credits_exempt(org);
  -- 0020's rule for a paid run; in the exempt organization the platform pays, so only its owner or admin may.
  if not public.is_org_member(org, 'admin') or (exempt_ and not public.is_platform_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$' then
    perform public.creative_refuse('invalid_idempotency_key', 'the idempotency key must be 8 to 128 letters, digits or _.:-');
  end if;
  if p_quote_id is null or p_quote_id !~ '^fq-[0-9]{1,9}-[0-9a-f]{32}$' then
    perform public.creative_refuse('invalid_params', 'quote_id must be the quote_id quote_film answered');
  end if;
  hash := md5(jsonb_build_object('film', p_film, 'quote', p_quote_id)::text);

  -- One start per organization at a time: the replay lookup, the active-film count and the hold cannot be raced.
  perform pg_advisory_xact_lock(hashtextextended('film_start:' || org::text, 0));
  select * into s from public.film_segments where org_id = org and idempotency_key = p_idempotency_key;
  if found then
    if s.request_hash <> hash then
      perform public.creative_refuse('idempotency_conflict', 'this idempotency key was used to start another film or quote', 'NS409');
    end if;
    return public.film_segment_json(s) || jsonb_build_object('ok', true, 'replayed', true);
  end if;

  -- The cheap refusals, before anything is counted or priced.
  select * into f from public.films where id = p_film for no key update;
  if not public.film_is_editable(f.status) then
    perform public.creative_refuse('film_not_startable', format('a %s film cannot be started', f.status), 'NS409');
  end if;
  if split_part(p_quote_id, '-', 2)::integer <> f.version then
    perform public.creative_refuse('film_changed',
      format('the film was edited after this quote (it is at version %s); quote it again', f.version), 'NS409');
  end if;
  if not public.film_studio_on() then
    perform public.creative_refuse('film_studio_disabled', 'Film Studio is not switched on yet; nothing was held', 'NS409');
  end if;
  -- Cheap checks of what pricing would refuse (a model off sale or turned Seedance, a reference or frame that is gone): raised with
  -- the line's own word, before anything is counted or priced.
  bad := public.film_precheck(f);
  if bad is not null then
    perform public.creative_refuse(bad ->> 'reason', bad ->> 'detail');
  end if;
  perform public.film_take_rate('start', (lim ->> 'starts_per_hour')::integer);

  -- Counted: from here every refusal is returned, so the counter commits with it. The stored quote first (no pricing yet).
  select * into fq from public.film_quotes x where x.film_id = f.id and x.quote_id = p_quote_id and x.version = f.version;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'price_changed', 'code', 'NS409',
                              'detail', 'this is not a quote of the film as it stands; quote it again');
  end if;
  if fq.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'quote_expired', 'code', 'NS409',
                              'detail', 'this quote has expired; quote it again');
  end if;
  st := public.film_settings_of(org);
  if not exempt_ and fq.total > public.film_available(org) then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_credits', 'code', 'NS402',
                              'detail', format('available=%s needed=%s', public.film_available(org), fq.total));
  end if;
  if st ->> 'max_credits_per_film' is not null and fq.total > (st ->> 'max_credits_per_film')::numeric then
    return jsonb_build_object('ok', false, 'reason', 'cap_exceeded', 'code', 'NS400',
      'detail', format('this film costs %s credits and the organization allows %s a film', fq.total, st ->> 'max_credits_per_film'));
  end if;
  if (select count(*) from public.film_segments x where x.org_id = org and x.status in ('queued', 'running', 'draining'))
     >= (st ->> 'max_active_films')::integer then
    return jsonb_build_object('ok', false, 'reason', 'limit_reached', 'code', 'NS400',
      'detail', format('at most %s films of this organization run at once; wait for one to finish', st ->> 'max_active_films'));
  end if;

  -- Then the re-pricing, at today's rates: what was confirmed is what is held, in either direction.
  q := public.film_price(f);
  if not (q ->> 'priced')::boolean then
    bad := q -> 'refusals' -> 0;
    return jsonb_build_object('ok', false, 'reason', bad ->> 'reason', 'code', 'NS400', 'detail', bad ->> 'detail');
  end if;
  total := (q ->> 'total')::numeric;
  if q ->> 'quote_id' <> p_quote_id then
    return jsonb_build_object('ok', false, 'reason', 'price_changed', 'code', 'NS409',
                              'detail', format('the price is now %s credits; quote it again', total));
  end if;
  -- 0187: a film sends the person's own files to its models too (a clip's uploaded first or last frame; a key frame's
  -- reference pictures, @characters and style kit). A model that requires a rights acknowledgement refuses here, after the
  -- price (a line refused anyway never asks) and before the hold and every take, unless THIS person (the one starting the
  -- film, who pays for it) acknowledged each such file at the CURRENT text version. The takes' jobs are written later by the
  -- worker, never through create_creative_job, so this is the only place a film asks.
  bad := public.film_acknowledgement_missing(f, uid);
  if bad is not null then
    return jsonb_build_object('ok', false, 'reason', 'acknowledgement_required', 'code', 'NS400',
      'detail', format('kind=%s version=%s subject=%s', bad ->> 'kind', coalesce(bad ->> 'text_version', 'none'), bad ->> 'subject'));
  end if;

  -- The hold: 0020's reserve_credits in the admin's own session, before anything is created. Its two refusals (NS402 with available
  -- and needed; NS429 when the plan's parallel runs are in use) are returned with their codes. Nothing is held in the exempt
  -- organization or for a total of 0.
  ref := 'fm-' || replace(sid::text, '-', '');
  if exempt_ or total = 0 then
    ref := null;
  else
    begin
      perform public.reserve_credits(org, ref, total);
    exception when sqlstate 'NS402' or sqlstate 'NS429' or sqlstate '22023' or sqlstate '23505' then
      get stacked diagnostics w = returned_sqlstate, d = pg_exception_detail, msg = message_text;
      if w in ('22023', '23505') then
        -- Not a customer's state (credits, slots) but a refusal of the hold itself: recorded, so someone looks at it.
        perform public.film_log(f.id, org, null, 'start_refused',
          jsonb_build_object('reason', 'hold_refused', 'code', w, 'quote_id', p_quote_id, 'credits', total,
                             'message', left(coalesce(nullif(d, ''), msg), 200)));
      end if;
      return jsonb_build_object('ok', false,
                                'reason', case w when 'NS402' then 'insufficient_credits' when 'NS429' then 'run_slots_full'
                                                 else 'hold_refused' end,
                                'code', w, 'detail', coalesce(nullif(d, ''), msg));
    end;
  end if;

  select l into asm from jsonb_array_elements(q -> 'lines') l where l ->> 'line' = 'assembly';
  insert into public.film_segments (id, film_id, org_id, n, purpose, film_version, quote_id, status, credit_ref, exempt,
                                    confirmed_credits, assembly_minutes, assembly_unit_credits, assembly_confirmed_credits,
                                    max_attempts, idempotency_key, request_hash, created_by)
  values (sid, f.id, org, coalesce((select max(x.n) from public.film_segments x where x.film_id = f.id), 0) + 1, 'initial',
          f.version, p_quote_id, 'queued', ref, exempt_, total, (asm ->> 'quantity')::integer,
          (asm ->> 'credits_per_unit')::numeric, (asm ->> 'credits')::numeric,
          (lim ->> 'max_attempts')::integer, p_idempotency_key, hash, uid)
  returning * into s;

  for ln in select l from jsonb_array_elements(q -> 'lines') l where l ->> 'line' in ('keyframe', 'clip', 'extend', 'narration') loop
    -- The next version of this scene (or of the film's narration), past every take an earlier segment made.
    v := coalesce((select max(t.version) from public.film_takes t
                    where t.film_id = f.id and t.scene_id is not distinct from (ln ->> 'scene_id')::uuid
                      and t.kind = case when ln ->> 'line' = 'narration' then 'narration' else t.kind end
                      and t.segment_id is distinct from sid), 0) + 1;
    insert into public.film_takes (film_id, org_id, scene_id, version, shot_index, kind, attempt, status, model, params, duration_s,
                                   segment_id, credit_unit, unit_credits, quantity, minimum_credits, confirmed_credits)
    values (f.id, org, (ln ->> 'scene_id')::uuid, v, (ln ->> 'shot_index')::smallint, ln ->> 'line', 1, 'planned', ln ->> 'model',
            coalesce(ln -> 'params', '{}'::jsonb), (ln ->> 'duration_s')::numeric, sid, ln ->> 'unit',
            (ln ->> 'credits_per_unit')::numeric, (ln ->> 'quantity')::numeric, (ln ->> 'minimum')::numeric,
            (ln ->> 'credits')::numeric);
    n_takes := n_takes + 1;
  end loop;

  update public.films set status = 'queued', pause_reason = null, pause_detail = null, updated_at = now() where id = f.id;
  perform public.film_log(f.id, org, null, 'started',
    jsonb_build_object('segment_id', sid, 'quote_id', p_quote_id, 'credits', total, 'held', ref is not null, 'exempt', exempt_,
                       'takes', n_takes, 'version', f.version));
  return public.film_segment_json(s) || jsonb_build_object('ok', true, 'replayed', false);
end
$$;
revoke all on function public.start_film(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.start_film(uuid, text, text) to authenticated;

-- api_create_video: 0147's body, verbatim (0147_mcp_free_tier.sql).
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
revoke all on function public.api_create_video(text, text, jsonb, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.api_create_video(text, text, jsonb, text, text, text) to anon;

-- oauth_creative_quote: 0191's body, verbatim.
create or replace function public.oauth_creative_quote(p_token_hash text, p_capability text, p_model text, p_params jsonb,
                                                       p_request_id text default null)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx      jsonb;
  v_org    uuid;
  v_grant  uuid;
  v_cap    text := lower(btrim(coalesce(p_capability, '')));
  v_model  text := lower(btrim(coalesce(p_model, '')));
  v_p      jsonb := coalesce(p_params, '{}'::jsonb);
  v_state  text;
  v_q      jsonb;
  v_row    public.oauth_creative_quotes;
  v_res    jsonb;
  v_spent  numeric;
  v_msg    text;
  v_detail text;
  v_sql    text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return public.api_err(401, 'invalid_token', 'The access token is missing, expired, revoked or unknown. Reconnect the app.');
  end if;
  ctx := public.oauth_ctx(p_token_hash, 'oauth.creative.quote', p_request_id);
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    v_org := (ctx ->> 'org_id')::uuid;
    v_grant := (ctx ->> 'grant_id')::uuid;
    v_res := public.oauth_creative_rate_refusal(v_grant, 'quote');
    if v_res is not null then
      return public.api_finish(ctx, v_res, 0);
    end if;
    if jsonb_typeof(v_p) <> 'object' or pg_column_size(v_p) > 16384 then
      return public.api_finish(ctx, public.api_err(400, 'invalid_params', 'params must be a JSON object (at most 16 KB).'), 0);
    end if;
    v_state := public.oauth_creative_model_state(v_cap, v_model);
    if v_state <> 'ok' then
      return public.api_finish(ctx, public.oauth_creative_state_refusal(v_state, v_model), 0);
    end if;
    begin
      -- The Studio's own price for this workspace: the model, the settings, the source file (this workspace's, live), the
      -- entitlement. Computed nowhere else.
      v_q := public.creative_price(v_org, v_cap, v_model, v_p);
      -- A connection's own quotes that ran out are of no use to anyone; a connection holds at most a few live ones (storage is a
      -- ceiling: 30 quotes a minute of up to 16 KB each would otherwise pile up).
      delete from public.oauth_creative_quotes q
       where q.grant_id = v_grant and q.job_id is null and q.expires_at < now();
      if (select count(*) from public.oauth_creative_quotes q where q.grant_id = v_grant and q.job_id is null)
         >= (public.oauth_creative_limits() ->> 'open_quotes_max')::integer then
        return public.api_finish(ctx, public.api_err(429, 'too_many_quotes',
          'This connection has too many open quotes. Create from one, or wait for them to expire.',
          jsonb_build_object('retry_after', 60)), 0);
      end if;
      -- The tier, resolution and soundtrack the price is for are written into the params, the way create_creative_job writes
      -- them into the job: what runs is what was shown, even if a model's default changes before create.
      v_p := v_p || (v_q - array(select k from jsonb_object_keys(v_q) k where k not in ('quality', 'resolution', 'audio')));
      insert into public.oauth_creative_quotes (grant_id, org_id, capability, model, params, credits, quote, expires_at)
      values (v_grant, v_org, v_cap, v_model, v_p, (v_q ->> 'credits')::numeric, v_q - 'exempt' - 'preview',
              now() + make_interval(secs => (public.oauth_creative_limits() ->> 'quote_ttl_seconds')::integer))
      returning * into v_row;
      v_spent := public.oauth_grant_month_credits(v_grant);
      v_res := public.api_ok(public.oauth_creative_quote_json(v_row)
        || jsonb_build_object('this_connection', jsonb_build_object(
             'monthly_limit_credits', (ctx ->> 'limit_credits')::numeric)
           -- Only where create applies the limit: on the credits-exempt workspace it is not a ceiling, so no number is shown as one.
           || case when public.credits_exempt(v_org) then '{}'::jsonb
                   else jsonb_build_object('left_this_month_credits', greatest((ctx ->> 'limit_credits')::numeric - v_spent, 0)) end), 201);
    exception when others then
      get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
      v_sql := sqlstate;
      v_res := public.api_creative_refusal(v_sql, v_msg, v_detail);
    end;
    return public.api_finish(ctx, v_res, 0);
  exception when others then
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'), 0);
  end;
end
$$;
revoke all on function public.oauth_creative_quote(text, text, text, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.oauth_creative_quote(text, text, text, jsonb, text) to anon;

-- oauth_creative_models: 0191's body, verbatim.
create or replace function public.oauth_creative_models(p_token_hash text, p_capability text default null, p_request_id text default null)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx    jsonb;
  v_org  uuid;
  v_cap  text := nullif(lower(btrim(coalesce(p_capability, ''))), '');
  v_paid boolean;
  v_list jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return public.api_err(401, 'invalid_token', 'The access token is missing, expired, revoked or unknown. Reconnect the app.');
  end if;
  ctx := public.oauth_ctx(p_token_hash, 'oauth.creative.models', p_request_id);
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    if v_cap is not null and not (v_cap = any (public.oauth_creative_capabilities())) then
      return public.api_finish(ctx, public.api_err(400, 'invalid_params',
        format('capability must be one of: %s.', array_to_string(public.oauth_creative_capabilities(), ', '))), 0);
    end if;
    v_org := (ctx ->> 'org_id')::uuid;
    v_paid := public.credits_exempt(v_org)
              or exists (select 1 from public.credit_transactions t where t.org_id = v_org and t.kind = 'purchase');
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', s.id, 'name', s.display_name,
             'capabilities', to_jsonb(array(select c from unnest(s.capabilities) c
                                             where public.oauth_creative_model_state(c, s.id) = 'ok' order by c)),
             'availability', s.availability,
             'spec', jsonb_strip_nulls(jsonb_build_object(
                       'output', s.spec -> 'output', 'aspect_ratios', s.spec -> 'aspect_ratios',
                       'image_sizes', s.spec -> 'image_sizes', 'resolutions', s.spec -> 'resolutions',
                       'durations_s', s.spec -> 'durations_s', 'inputs', s.spec -> 'inputs', 'audio_out', s.spec -> 'audio_out',
                       'max_prompt_chars', s.spec #> '{limits,max_prompt_chars}'))) order by s.id), '[]'::jsonb)
      into v_list
      from public.sellable_models(v_cap, 'mcp') s
     where (coalesce(s.entitlement, 'any') = 'any' or (s.entitlement = 'paid' and v_paid))
       and exists (select 1 from unnest(s.capabilities) c
                    where (v_cap is null or c = v_cap) and public.oauth_creative_model_state(c, s.id) = 'ok');
    return public.api_finish(ctx, public.api_ok(jsonb_build_object('capability', v_cap, 'models', v_list)), 0);
  exception when others then
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'), 0);
  end;
end
$$;
revoke all on function public.oauth_creative_models(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.oauth_creative_models(text, text, text) to anon;

-- api_request_download: 0170's body, verbatim.
create or replace function public.api_request_download(
  p_key_hash text, p_video_id text, p_quality text,
  p_idem_key text default null, p_fingerprint text default null, p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx     jsonb := public.api_begin(p_key_hash, 'downloads.create', p_request_id);
  v_org   uuid;
  v_ch    text;
  q       text := btrim(coalesce(p_quality, ''));
  m       public.download_masters;
  r       public.download_requests;
  why     text;
  until_  timestamptz;
  credits numeric;
  v_price bigint;
  v_spend bigint;
  acc     public.api_accounts;
  v_ref   text;
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
    select c.channel_id into v_ch from public.videos v join public.channels c on c.channel_id = v.channel_id
     where v.video_id = p_video_id and c.org_id = v_org;
    if q not in ('720p', '1080p') then
      v_res := public.api_err(400, 'invalid_params', 'quality must be 720p or 1080p.');
    elsif v_ch is null then
      v_res := public.api_err(404, 'video_not_found', 'No video with that id in this key''s organization.');
    end if;
    if v_res is not null then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
    end if;

    -- 0030's lock: the site and the API decide one (org, video, quality) at a time.
    perform pg_advisory_xact_lock(hashtextextended(format('download:%s:%s:%s', v_org, p_video_id, q), 0));
    select * into r from public.download_requests d
     where d.org_id = v_org and d.video_id = p_video_id and d.quality = q
       and (d.status in ('queued', 'processing') or (d.status = 'ready' and d.expires_at > now()))
     order by d.id desc limit 1;
    if r.id is not null then
      v_res := public.api_ok(jsonb_build_object('id', r.id, 'status', r.status, 'quality', r.quality,
                                                'price_cents', 0, 'reused', true, 'expires_at', r.expires_at));
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
    end if;

    select * into m from public.download_masters where video_id = p_video_id;
    if m.video_id is null or least(m.width, m.height) < public.download_quality_side(q) then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(404, 'no_master',
        format('No full-quality master for this video at %s. Only videos rendered on the queue worker keep one.', q))));
    end if;

    if exists (select 1 from public.download_requests d
                where d.org_id = v_org and d.video_id = p_video_id and d.quality = q
                  and d.paid_until > now() and d.status <> 'failed') then
      why := 'redownload';
      until_ := (select max(d.paid_until) from public.download_requests d
                  where d.org_id = v_org and d.video_id = p_video_id and d.quality = q and d.status <> 'failed');
    elsif (ctx ->> 'exempt')::boolean then
      why := 'exempt';
      until_ := now() + interval '7 days';
    else
      credits := public.download_credits_price(m.duration_seconds, q);
      select ceil(credits * p.cents)::bigint into v_price from public.api_prices p where p.unit = 'download_cents_per_credit';
      if v_price is null then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(503, 'pricing_unavailable',
          format('Downloads in %s are not priced on this deployment; nothing was charged.', q))));
      end if;
      until_ := now() + interval '7 days';
    end if;

    if v_price is not null and v_price > 0 then
      acc := public.api_account_lock(v_org);
      perform public.api_expire_holds_locked(v_org);
      select * into acc from public.api_accounts where org_id = v_org;
      v_spend := public.api_month_spend(v_org);
      if v_spend + v_price > (ctx ->> 'cap_cents')::bigint then
        v_res := public.api_err(402, 'monthly_limit_reached',
          'This download would take the organization past its monthly API spend limit. An owner or admin can raise it in the Developer console: Developers → Usage and billing → Monthly spend limit (up to the usage tier''s cap; paying more into the API balance raises the tier).',
          jsonb_build_object('limit_cents', (ctx ->> 'cap_cents')::bigint, 'month_spend_cents', v_spend, 'price_cents', v_price));
      elsif ctx ->> 'key_limit_cents' is not null
            and public.api_month_spend(v_org, (ctx ->> 'key_id')::uuid) + v_price > (ctx ->> 'key_limit_cents')::bigint then
        v_res := public.api_err(402, 'key_limit_reached', 'This download would take this key past its own monthly spend limit. An owner or admin can raise or remove it in the Developer console: Developers → API keys → Set limit on this key.',
          jsonb_build_object('limit_cents', (ctx ->> 'key_limit_cents')::bigint, 'price_cents', v_price));
      elsif acc.balance_cents - acc.reserved_cents < v_price then
        v_res := public.api_err(402, 'insufficient_balance',
          'Your API balance does not cover this download. Top up in the Developer console.',
          jsonb_build_object('price_cents', v_price, 'available_cents', acc.balance_cents - acc.reserved_cents));
      end if;
      if v_res is not null then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
      end if;
    end if;

    -- 0030's row, as the site writes it, filed as the key's creator; credits
    -- charged 0 (the API balance pays, below).
    insert into public.download_requests
      (org_id, channel_id, video_id, quality, status, charged, free_reason, paid_until, minutes, requested_by)
    values
      (v_org, v_ch, p_video_id, q, 'queued', 0, why, until_, round(m.duration_seconds / 60.0, 4),
       (ctx ->> 'created_by')::uuid)
    returning * into r;

    if v_price is not null and v_price > 0 then
      v_ref := 'ah-' || gen_random_uuid()::text;
      insert into public.api_holds (ref, org_id, key_id, download_request_id, amount_cents)
      values (v_ref, v_org, (ctx ->> 'key_id')::uuid, r.id, v_price);
      update public.api_accounts set reserved_cents = reserved_cents + v_price, updated_at = now()
       where org_id = v_org;
      perform public.api_log(v_org, 'hold', v_price, v_ref, (ctx ->> 'key_id')::uuid, null, null, null,
                             format('download %s of %s', q, p_video_id));
    end if;
    -- 0170: the name 0087's audit list has and the site's download route writes; 'video.download' was refused (500).
    perform public.api_audit(ctx, 'video.download_request', p_video_id, v_ch,
      jsonb_build_object('download_id', r.id, 'quality', q, 'price_cents', v_price, 'free_reason', why));

    v_res := public.api_ok(jsonb_build_object('id', r.id, 'status', r.status, 'quality', q,
                                              'price_cents', coalesce(v_price, 0), 'free_reason', why,
                                              'reused', false), 201);
    return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res), coalesce(v_price, 0));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;
revoke all on function public.api_request_download(text, text, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.api_request_download(text, text, text, text, text, text) to anon;

-- oauth_create_video: 0094's body, verbatim.
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
revoke all on function public.oauth_create_video(text, text, jsonb, text, text) from public, anon, authenticated, service_role;
grant execute on function public.oauth_create_video(text, text, jsonb, text, text) to anon;

-- The two gate triggers first (they name the trigger function), then the functions. The append-only triggers of the record stay.
drop trigger if exists adult_attestation_hold_gate on public.credit_reservations;
drop trigger if exists adult_attestation_download_gate on public.download_requests;
drop function if exists public.adult_attestation_refuse_minor();
drop function if exists public.film_adult_refusals(uuid, uuid);
drop function if exists public.record_adult_attestation(boolean, text, text);
drop function if exists public.my_adult_attestation();
drop function if exists public.adult_attestation_gate(uuid, text);
drop function if exists public.adult_attestation_missing(uuid, text);
drop function if exists public.adult_attestation_state(uuid);
drop function if exists public.model_requires_adult(jsonb);

do $$
declare
  r record;
begin
  for r in select * from (values
      ('public.quote_creative_job(uuid, text, text, jsonb)', '8494b320cece395444edec700a2f1696'),
      ('public.route_model(text, jsonb, text, uuid, text)', 'e4344e61983e7decb4b1eac73761fbf0'),
      ('public.sellable_models(text, text)', '0ab9e7da07b4347010a887c5118d5150'),
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', '88107b00b0a8c143606ed17f5898c98d'),
      ('public.api_creative_refusal(text, text, text)', 'e6ec45d0d912389a05eb2d40261c2c2a'),
      ('public.creative_platform_reserve(uuid, text, numeric)', '4a61076948e0dd8992d37de2a9016607'),
      ('public.quote_film(uuid, integer)', '8839e2cb264663acf98c6f49aaaf89a5'),
      ('public.start_film(uuid, text, text)', '5468183a8f24a48f708efcbbf9d2d22c'),
      ('public.api_create_video(text, text, jsonb, text, text, text)', 'cba47be1a674f5cea3b5d7443bc31bab'),
      ('public.oauth_creative_quote(text, text, text, jsonb, text)', 'b75707212f0ce249f4f8bce5b1079070'),
      ('public.oauth_creative_models(text, text, text)', 'bf21f463a6465cfbb45e25bef841ed1f'),
      ('public.api_request_download(text, text, text, text, text, text)', 'b59ca71d0e0379e217e47a6987c9ed0c'),
      ('public.oauth_create_video(text, text, jsonb, text, text)', '244a5779e4388525f5f345b59379029f')) v(sig, want) loop
    if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(r.sig)) is distinct from r.want then
      raise exception 'rollback 0192 end state: % is not its earlier body', r.sig;
    end if;
  end loop;
  if not has_function_privilege('authenticated', 'public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', 'EXECUTE')
     or has_function_privilege('anon', 'public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.quote_creative_job(uuid, text, text, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.quote_creative_job(uuid, text, text, jsonb)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.sellable_models(text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.route_model(text, jsonb, text, uuid, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.api_creative_refusal(text, text, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.start_film(uuid, text, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.quote_film(uuid, integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.start_film(uuid, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.creative_platform_reserve(uuid, text, numeric)', 'EXECUTE')
     or not has_function_privilege('anon', 'public.api_create_video(text, text, jsonb, text, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.api_create_video(text, text, jsonb, text, text, text)', 'EXECUTE') then
    raise exception 'rollback 0192 end state: the grants are not the earlier ones';
  end if;
  if to_regprocedure('public.record_adult_attestation(boolean, text, text)') is not null
     or to_regprocedure('public.my_adult_attestation()') is not null
     or to_regprocedure('public.adult_attestation_gate(uuid, text)') is not null
     or to_regprocedure('public.film_adult_refusals(uuid, uuid)') is not null
     or to_regprocedure('public.adult_attestation_refuse_minor()') is not null
     or exists (select 1 from pg_trigger where tgname in ('adult_attestation_hold_gate', 'adult_attestation_download_gate')) then
    raise exception 'rollback 0192 end state: a 0192 function is still there';
  end if;
  if to_regclass('public.adult_attestations') is null then
    raise exception 'rollback 0192 end state: the record (adult_attestations) is gone';
  end if;
end $$;

commit;
