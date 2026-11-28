-- 0250_music_in_job_path_lists.sql — sellable_models knows `music`: the last closed capability list on the creative job path that
-- did not. Stream S6; number assigned by Atlas.
--
-- *** LIVE ON APPLY. *** It changes NO answer for any capability but music, and puts nothing on sale. It replaces two functions and
--   writes no row; no grant changes:
--     sellable_models (0192's body): `music` is in its list of known capabilities, and, as captions, music is listed on the web and
--       on no other surface (BR-S6-06: without that second hunk the API would sell a music row whose api_exposure is 'any');
--     api_creative_model_ok (0188's body): its "temporarily off" word leaves music out, as it leaves captions out.
--
-- EVIDENCE (measured in a PG16 lab with every migration through 0238 applied, 2026-11-28).
--   * 0228 added `music` to model_registry_capabilities_check, model_probe_runs_capability_check, creative_params_problem and
--     creative_price. creative_capability_supported (0100) and creative_quantity (0126) already named it.
--   * sellable_models (last replaced by 0192) still raised 22023 "unknown capability music" for p_capability = 'music', on every
--     surface. Its callers, with a music model lit and priced in the lab:
--       - route_model (0196) catches 22023 and reads it as "no candidates": every routed (auto, cheap, fast, quality) music quote and
--         job answered no_model_available, with a model on sale (a silent dead end, not a refusal that names the cause);
--       - reroute_creative_job (0208, the worker's failover) does NOT catch it: a routed music job's failover raised 22023 in the
--         worker instead of moving the job to its next candidate or returning null;
--       - api_creative_model_ok / api_creative_models (0188, 0162) answered a music call with 22023 read as invalid_params, the
--         word for a capability that does not exist. Music is web_only (Lyria's registry entry; the API list leaves it out), so the
--         right answer there is "not sold through the API".
--   * BR-S6-06 (Breach, on 0250's first draft): knowing music on every surface let sellable_models('music', 'api') list a music row
--     whose api_exposure is 'any' or absent (absent reads as 'any'), and api_creative_quote / api_creative_create, exact and routed
--     (creative_route_quote, route_model), quoted, held and queued it for an API key. The 22023 had kept music off the API by
--     accident; the public route checks API_CREATIVE_CAPABILITIES only on its model list. Fixed here the way 0072/0192 keep
--     captions off the API and MCP: an early return for p_capability = 'music' off the web, and the same row filter for the full list
--     (p_capability null). Reproduced by tests/security/test_sec_breach_music_0250.py.
--   * The exact (Studio) path never asks sellable_models: quote_creative_job and create_creative_job price through creative_price,
--     so an exact music job was already quoted, held and claimed. The task brief said "every music job would fail"; that is true of
--     routed jobs and the failover, not of exact ones.
--
-- SWEEP (every closed capability list on the job path, read from the LIVE body: the last migration that replaces each function on
--   main; md5 is the comment-cut fingerprint 0230 introduced, folded-only in brackets where 0192's or 0228's guards pin that one).
--   MUST ADD music (changed here):
--     sellable_models(text, text)             0192  85aaba9a2ec82dc7f276dd2135b4c7cf [40f61462ddae2fc0e83a0956f4d8b75b]
--       its `not in (...)` list of known capabilities; raised 22023 for music (above). Music is web only here (BR-S6-06).
--     api_creative_model_ok(text, text)       0188  861978aa7b3d2d072433a9f6f8d7e857 [cbe9f5d42dcdcfddb604d4a30c2f80ae]
--       its "temporarily off" branch excludes captions by name; music joins it (below).
--   ALREADY KNOW music (unchanged):
--     creative_capability_supported(text)     0100  c727aa5796222618ff0654aa04dcbb7d  `in (...)` names music
--     creative_params_problem(text, jsonb)    0228  ec909e6459c3d5affdd717cf4354d9d7  timed list names music
--     creative_price(uuid, text, text, jsonb) 0228  1a684c0853ea1851223265336c09cc85  per-request music hunk
--     creative_quantity(text, jsonb)          0126  eeda25b45fc0da93b0971cd45bb929ad  timed list names music
--     model_registry_capabilities_check, model_probe_runs_capability_check (CHECKs)  0228  name music
--   NO CLOSED LIST (call the functions above or none; unchanged):
--     quote_creative_job 0192 06395a0fac4e12df9c0da87842593d32, create_creative_job 0231 bb7c09fade56559b257d0ddb606d043d,
--     cancel_creative_job 0231 4deedb395b359d3092ee3e94f2a8ae02, claim_creative_job 0215 28154667410a27cdfdbbf30a6d053ac3,
--     advance_creative_job 0124 f441475895ac8de11c126016b85162a2, finish_creative_job 0126 ae1d6a64290154de1480400aca12a8ca (its only
--     branch is a region edit's), attach_creative_job_assets 0046 03cc5a3b9595dbaef5c75ef643ca2bec, expire_creative_jobs 0036
--     146c16db0342d74499a46e8b7f5d673b, creative_end_locked 0036 622e898bb88beead0db1d8faa68ff8f6, capture_credits 0020
--     b4a8a46437e03eb0602fdf46d17f09fb, creative_platform_reserve 0192 65e335869f64ab0b00f1862464dfae09, creative_platform_release
--     0036 df9f6f555ad9d540907cc589ff46523d (the hold, capture and refund paths), route_model 0196 df763904c9076dd49837ada0d3805469,
--     quote_creative_route 0075 be0dec8c08957c0944329759ccf60b32, creative_route_quote 0196 322afd9dd5233f5d8fd4f525d21b46fb,
--     reroute_creative_job 0208 9e6576a5e71af85d7bca268797a9e1ff, creative_jobs_route_recorded 0075 8e556145222fead0bd59823b956631ca
--     (the router, 0075), creative_operator_preview 0139 ca8654e202cf46029350aaa3111c4c5d, operator_preview_models 0139
--     e8e5ef6791024990ac9bf6af6d5a2022 (the operator preview), creative_jobs_geo_gate 0230 6a7b6f2b075c4775ee83808932f88bd0,
--     notify_creative_job_ended 0064 b9a8aabe9371f4653ce50ddcd6feb9bf, public_models_on_sale 0193 d3c14bf162c197611471862a9f0d4ddc.
--     creative_jobs.capability's CHECK is a shape (^[a-z][a-z0-9_]{0,31}$), not a list; no credit or price table names a capability.
--     The library: media_mime_kind 0044 57c8500cc1591b6ce3983c06ae4e399d maps audio/mpeg (Lyria's MP3) to audio, and
--     media_assets_kind_check allows audio; no SQL library or provenance writer branches on capability.
--   CORRECTLY EXCLUDE music (unchanged, and must stay so):
--     api_creative_models(text, text, text)   0162  848d269f057463e0a7fbfa638864cd56  the API's list (API_CREATIVE_CAPABILITIES,
--       command-center/lib/api/operations.ts, pinned equal by tests/test_api_creative_models_migration.py): music is web_only.
--     oauth_creative_capabilities()           0191  441badea98cdab9adfc58c116a94779c  connected assistants: the API's list.
--     oauth_creative_model_state(text, text)  0191  294f8718e9256f840dbe1799dd75131b  and oauth_creative_org_model_state (0219,
--       6fefb08e3f85f10a2aa5d214d60c8a90), oauth_creative_models (0219, a3d86be5c4f3e9a72379c38b7e9b5e0c): gated by that list first
--       (and by blocked_countries, which Lyria has), so they answer not_offered before sellable_models is asked.
--     api_creative_model_ok's sale answer asks sellable_models for 'api', which after this file never lists music (BR-S6-06):
--       the exact API path (api_creative_quote / api_creative_create) refuses it as not sold through the API.
--     film_check_model 0166 6b3aae8fcd8468604c644b7d6e10e0a5, film_model_problem 0171 d828ee349aa5da3aa05ea9db4d8f1b94, film_price
--       0218 beff044dd6641ed67aa929a485c57108, film_precheck 0171 ff4fa7e8a6386420f32ab6a3a85a778c, film_resume_precheck 0215
--       aa7275ed5e8520af52cabd03c2f930d8, film_take_job 0198 19a8f09549092d04cdf7af1de227f209, film_apply_settings 0166
--       da20b967d1e104486a33544ee5356fef, film_save_scenes 0166 c6045cea06548b16ac903f8d689e35d0: a film's takes are key frames
--       (t2i, edit), clips (i2v) and narration (tts) only; a film has no music take.
--     creative_style_problem 0048 28ff9cf051008d83031e90bad82ef0a2, creative_job_style 0187 3326de2c6784917f93ee37e4a037ce18: a
--       look steers pictures and clips (t2i, t2v, edit, i2v), not a song.
--     creative_source_problem 0100 1fc78429317768f393293a0bdb3f66fa, creative_job_source 0052 9f9902e9db308314890d0a3c75abf470:
--       music takes no input file; anything not listed has no source to check.
--     workflow_makes_picture / workflow_takes_picture 0073 (9af722d2d16503fc4d55b8a0be4d7bb9 / 9e191800bfd00671129285ee766cd339):
--       which steps make or take a picture; a song is neither.
--     ai_chat_set_model 0199 e20b91784ca19561a47b1a8688ba87c2: the chat's model is a describe model.
--   STAY UNKNOWN: the two registry-only capabilities (REGISTRY_ONLY_CAPABILITIES in modules/capabilities/base.py, the video
--     soundtrack and the character swap). This file does not name them (tests/test_sonilo.py keeps every migration from
--     doing so); sellable_models still raises 22023 for both (tests/security/test_sec_music_job_path_0250.py).
--
-- CHANGE. sellable_models: 0192's body, with `'music'` appended to its list of known capabilities, and two marked hunks that keep
--   music to the web (the captions pattern). api_creative_model_ok: 0188's body, `p_capability <> 'captions'` widened to
--   `not in ('captions', 'music')`. Nothing else.
-- REPLACES (drift guard: md5 of prosrc with every `--` comment cut to the end of its line, chr(10) or chr(13), then white space
--   folded, 0230's fingerprint; the pattern is written [-][-] so that no literal in this file holds two dashes in a row):
--   sellable_models(text, text) 0192's 85aaba9a2ec82dc7f276dd2135b4c7cf -> 0250's 58c81cd592628820d3bd348353e6a5a8.
--   (Folded only: 40f61462ddae2fc0e83a0956f4d8b75b -> c6320684517e3487a8f536105d2d25a2.) No migration after 0192 replaces it.
--   api_creative_model_ok(text, text) 0188's 861978aa7b3d2d072433a9f6f8d7e857 -> 0250's ab087bc94fd3b9337f94d8dbea5b56ea.
--   (Folded only: cbe9f5d42dcdcfddb604d4a30c2f80ae -> 38d1ab91f7a18f4ff6fe10dbf642e3da.) No migration after 0188 replaces it.
--   A replay of 0250 is a no-op. A replay of 0192, 0188, 0125 or 0124 refuses (their guards); a replay of an older file that
--   replaces sellable_models (0035 to 0100) puts an older body back: apply the chain after it again, ending with 0192 and 0250.
-- ORDER. Apply after 0228, 0230 and 0238 (as numbered). Needs only 0192's body; on a database without 0228 the registry still
--   refuses a music row, so listing music here sells nothing (a NOTICE says so).
-- No backslash anywhere in this file (0219's header: the live apply path once rewrote backslash escapes inside SQL text).
-- Rollback: docs/sql/rollback_0250_music_in_job_path_lists.sql (owner-applied; refuses while a music model is on sale, else puts
--   0192's and 0188's bodies back and asserts them).

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regprocedure('public.sellable_models(text, text)') is null then
    raise exception '0250 needs 0035 (sellable_models) and 0192 (its live body): apply them first';
  end if;
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p
   where p.oid = 'public.sellable_models(text, text)'::regprocedure;
  if h is null or h <> all (array['85aaba9a2ec82dc7f276dd2135b4c7cf', '58c81cd592628820d3bd348353e6a5a8']) then
    raise exception '0250 found a sellable_models() that is neither 0192''s body nor 0250''s (md5 %): a migration after 0192 changed it, or an older one was replayed over it; read the live body first', h;
  end if;
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p
   where p.oid = to_regprocedure('public.api_creative_model_ok(text, text)');
  if h is null or h <> all (array['861978aa7b3d2d072433a9f6f8d7e857', 'ab087bc94fd3b9337f94d8dbea5b56ea']) then
    raise exception '0250 found an api_creative_model_ok() that is neither 0188''s body nor 0250''s (md5 %): a migration after 0188 changed it, or an older one was replayed over it; read the live body first', h;
  end if;
  if position('''music''' in coalesce(pg_get_constraintdef((select oid from pg_constraint
                                                             where conname = 'model_registry_capabilities_check')), '')) = 0 then
    raise notice '0250: model_registry_capabilities_check does not list music (0228 is not applied): no music row can exist, so this file sells nothing until 0228 is applied';
  end if;
end $$;

-- 0192's sellable_models, with music known on the web and on no other surface (0250's lines are marked).
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
                              'expand', 'relight', 'erase', 'video_edit', 'video_reframe', 'video_remove_bg',
                              -- 0250: 0228 lets a registry row, a probe and a price name music. Left out here, a routed music quote
                              -- found no model and a worker failover raised 22023 (unknown capability).
                              'music') then
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
  -- 0250 (BR-S6-06): music is a web tool, as captions are. Before 0250 the 22023 above kept it off the API and MCP by accident;
  -- once known, a music row whose api_exposure is 'any' (or absent, which reads as 'any') would be quoted, held and queued for an
  -- API key. No surface but the web lists it, whatever the registry row says.
  if p_capability = 'music' and p_surface <> 'web' then
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
             -- 0192: the vendor's terms are 18+: still listed (never hidden), and the app marks it "for adults only".
             'requires_adult', case when public.model_requires_adult(m.spec) then true end,
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
       -- 0250 (BR-S6-06): nor a music row in the API's or MCP's full list (p_capability null), as captions above.
       and (p_surface = 'web' or not ('music' = any (m.capabilities)))
     order by m.provider, m.id;
end
$$;

revoke all on function public.sellable_models(text, text) from public, anon;
grant execute on function public.sellable_models(text, text) to authenticated, service_role;

-- 0188's api_creative_model_ok, with music kept out of its "temporarily off" word (0250's line is marked): a music model the owner
-- switched off would otherwise answer an API key "temporarily unavailable", the word for a model the API sells.
create or replace function public.api_creative_model_ok(p_capability text, p_model text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  -- 0124: a model the owner switched off that the API would otherwise sell is refused with its own word, so a caller is told "temporarily
  -- unavailable" and not "not available through the API". Nothing is held. Every other model is judged as before.
  if not public.model_is_available(p_model)
     and exists (select 1 from public.model_registry r
                  where r.id = p_model and p_capability = any (r.capabilities)
                    and r.availability in ('beta', 'ga') and r.verified_at is not null
                    -- 0188: only a model the API would otherwise sell ('any') gets the "temporarily off" word here.
                    and coalesce(r.spec ->> 'api_exposure', 'any') = 'any'
                    -- 0250 (BR-S6-06): nor music, which no surface but the web sells (sellable_models).
                    and p_capability not in ('captions', 'music')) then
    perform public.creative_refuse('model_temporarily_off', format('%s is temporarily unavailable', p_model));
  end if;
  return exists (select 1 from public.sellable_models(p_capability, 'api') s where s.id = p_model);
end
$$;
revoke all on function public.api_creative_model_ok(text, text) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- End state (refuses the whole transaction if any of it is not so)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  n bigint;
  st text;
begin
  if (select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) from pg_proc p
       where p.oid = 'public.sellable_models(text, text)'::regprocedure) is distinct from '58c81cd592628820d3bd348353e6a5a8' then
    raise exception '0250 end state: sellable_models() is not 0250''s body';
  end if;
  if not (select prosecdef and proconfig = array['search_path=public, pg_temp'] from pg_proc
           where oid = 'public.sellable_models(text, text)'::regprocedure) then
    raise exception '0250 end state: sellable_models() is not SECURITY DEFINER with a pinned search_path';
  end if;
  if has_function_privilege('anon', 'public.sellable_models(text, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.sellable_models(text, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.sellable_models(text, text)', 'EXECUTE') then
    raise exception '0250 end state: sellable_models() grants are not 0192''s (authenticated and service_role only)';
  end if;
  if (select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) from pg_proc p
       where p.oid = 'public.api_creative_model_ok(text, text)'::regprocedure) is distinct from 'ab087bc94fd3b9337f94d8dbea5b56ea' then
    raise exception '0250 end state: api_creative_model_ok() is not 0250''s body';
  end if;
  if not (select prosecdef and proconfig = array['search_path=public, pg_temp'] from pg_proc
           where oid = 'public.api_creative_model_ok(text, text)'::regprocedure)
     or has_function_privilege('anon', 'public.api_creative_model_ok(text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.api_creative_model_ok(text, text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.api_creative_model_ok(text, text)', 'EXECUTE') then
    raise exception '0250 end state: api_creative_model_ok() is not 0188''s definer function closed to every API role';
  end if;
  -- BR-S6-06: no music row on the API's or MCP's list, by capability or in the full list, whatever its api_exposure says.
  if exists (select 1 from public.sellable_models(null, 'api') x where 'music' = any (x.capabilities))
     or exists (select 1 from public.sellable_models(null, 'mcp') x where 'music' = any (x.capabilities))
     or exists (select 1 from public.sellable_models('music', 'api'))
     or exists (select 1 from public.sellable_models('music', 'mcp')) then
    raise exception '0250 end state: sellable_models() lists a music model off the web';
  end if;
  -- Music is known on every surface (each call raised 22023 before this file); a name nobody registered still is not.
  select count(*) into n from public.sellable_models('music', 'web');
  select count(*) into n from public.sellable_models('music', 'api');
  select count(*) into n from public.sellable_models('music', 'mcp');
  begin
    select count(*) into n from public.sellable_models('no_such_capability', 'web');
    st := 'none';
  exception when sqlstate '22023' then
    st := '22023';
  end;
  if st <> '22023' then
    raise exception '0250 end state: sellable_models() answered a capability nobody registered instead of refusing it as unknown';
  end if;
end $$;

-- Verify (the SQL editor, after applying; every column should read true. Where 0250 is not on, music_is_known raises 22023
-- unknown capability music instead):
--   select
--     (select md5(regexp_replace(regexp_replace(prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g'))
--        from pg_proc where oid = 'public.sellable_models(text,text)'::regprocedure) = '58c81cd592628820d3bd348353e6a5a8' as sellable_is_0250s,
--     (select count(*) from public.sellable_models('music', 'web')) >= 0 as music_is_known,
--     position('''music''' in pg_get_constraintdef((select oid from pg_constraint where conname = 'model_registry_capabilities_check'))) > 0 as registry_knows_music,
--     has_function_privilege('authenticated', 'public.sellable_models(text,text)', 'EXECUTE') as members_can_list,
--     not has_function_privilege('anon', 'public.sellable_models(text,text)', 'EXECUTE') as anon_cannot_list,
--     (select md5(regexp_replace(regexp_replace(prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g'))
--        from pg_proc where oid = 'public.api_creative_model_ok(text,text)'::regprocedure) = 'ab087bc94fd3b9337f94d8dbea5b56ea' as model_ok_is_0250s,
--     not exists (select 1 from public.sellable_models(null, 'api') x where 'music' = any (x.capabilities)) as no_music_on_the_api,
--     not exists (select 1 from public.sellable_models(null, 'mcp') x where 'music' = any (x.capabilities)) as no_music_on_mcp;
