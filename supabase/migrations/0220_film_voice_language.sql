-- 0220_film_voice_language.sql — a film whose voice model does not speak the film's language is refused at the quote and at the
-- start, before anything is counted, priced or held. docs/MIGRATIONS.md "0220", docs/studio/S6_GAPS.md (G1).
--
-- EVIDENCE (read from the migrations, not assumed)
--   * quote_film (0198's body, unchanged here) and start_film (0198's body, unchanged here) price a film through film_price (0171's
--     body), and start_film asks film_precheck (0171's body) before its rate step. No later migration replaced either helper
--     (grep 'function public.film_price(' / 'function public.film_precheck(' across supabase/migrations: 0171 only), and no open
--     S2 branch does.
--   * film_price's narration line asks the voice model's role (film_model_problem) and its price (film_try_price), never
--     films.language (0166: en, ru, uz). An Uzbek film read by Eleven Multilingual v2 is quoted, started and held, and fails only at
--     the narration take in the TTS adapter (modules/tts_languages.refusal), after its clips were paid for (rule 6).
--   * 0214 added public.voice_language_problem(model, language) for exactly this, and proposed the line below; it changed no money
--     function, so until this file nothing behaved differently.
--
-- CHANGE (two 0171 bodies replaced, each with one marked 0220 hunk and nothing else changed)
--   film_price (0171's body)     the narration branch, the `else` after the channel-voice refusal, becomes
--                                    q := coalesce(public.film_model_problem(f.voice ->> 'model', array['tts'], 'voice.model'),
--                                                  public.voice_language_problem(f.voice ->> 'model', f.language),
--                                                  public.film_try_price(...unchanged...));
--                                the role check first, so a hidden or unavailable model still reads model_not_available and never a
--                                language reason whose detail would describe a registry row; the language second, so a refused one is
--                                never priced. The refusal is the line's own (priced: false, reason, detail), so the film's total is
--                                NULL, no quote_id is made and quote_film stores nothing start_film could accept.
--   film_precheck (0171's body)  after every model's role check, the same question for a creative_tts voice with narration. start_film
--                                raises it with its own word (NS400 voice_language_unsupported / voice_language_unknown) before the
--                                rate step: a film that became unsupported since its quote (the registry's list changed and the model
--                                was probed again) is refused before anything is counted or held.
--   The refusal detail is 0214's, unchanged: it names the remedy, "choose a voice model that lists <language>", and for Uzbek
--   "choose Eleven v3, a voice model that lists Uzbek" (v3 only, like modules/tts_languages.UZBEK_FIX). No model list is written here.
--   A supported pair is priced exactly as before: the same lines, the same total and the same quote_id.
--
-- NOT CHANGED: quote_film, start_film, every price, hold, capture, release and settle rule; the worker's functions; voice_language_problem
--   itself; every grant (create or replace keeps 0171's: no API role may execute either helper).
--
-- APPLY ORDER (the reason this is its own file, after 0214, and not applied with it)
--   1. 0214, and its Verify block.
--   2. The next registry sync (any Probe models run is one: it always passes --sync). model_registry_guard (0100) treats the new
--      spec.languages as a new claim: a verified voice model loses its verification and one on sale goes back to hidden.
--   3. Probe the four ElevenLabs tts models by name (--all skips them: all four are terms-gated), with a voice id from the account's
--      list: python tools/probe_models.py --sync --model elevenlabs-v4 --model elevenlabs-v3 --model elevenlabs-multilingual-v2
--      --model elevenlabs-flash-v2.5 --voice-id <voice id>. Each probe is a real, paid call.
--   4. The owner puts the re-verified models back on sale.
--   5. Only then this file.
--   Applied earlier, every narration film whose voice model has no spec.languages reads voice_language_unknown: fail-closed and honest
--   (rule 5: a model nobody listed languages for is never "speaks"), but no narration film can be quoted or started until the sync.
--   The guard below raises a NOTICE naming how many tts rows have no list, and refuses nothing for it.
--
-- REPLACES (md5 drift guard: the earlier body, or this file's own on a replay; whitespace runs read as one space)
--   film_price      5de6c9bb2a74079e2078cad2d91b3c34 (0171) -> 25e85c92d74e740ed66fec577652fdc5
--   film_precheck   ff4fa7e8a6386420f32ab6a3a85a778c (0171) -> 0a89da5f19fa2c6c0f6d802c02e18925
-- REQUIRES voice_language_problem(text, text) with 0214's body (6d5025fd76e3b8b4d731e2d98f65db6e).
-- REPLAY. This file replays onto itself. Re-running 0171 after it FAILS LOUDLY (0171's guard refuses this file's film_price and
--   film_precheck). rollback_0171 refuses while this file's bodies are live, and rollback_0214 refuses while film_price or
--   film_precheck calls voice_language_problem: take this file out first with its own rollback.
--
-- NUMBER. Provisionally 0220; the coordinator confirms it at merge. Needs 0171 and 0214.
-- Undo: docs/sql/rollback_0220_film_voice_language.sql (owner-applied): 0171's two bodies back, nothing else.
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).

set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
  n integer;
begin
  if to_regprocedure('public.film_price(public.films)') is null or to_regprocedure('public.film_precheck(public.films)') is null
     or to_regprocedure('public.film_model_problem(text, text[], text)') is null then
    raise exception '0220 needs the Film Studio''s money: apply 0171_films_money.sql first';
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p
   where p.oid = to_regprocedure('public.voice_language_problem(text, text)');
  if h is null then
    raise exception '0220 needs public.voice_language_problem(text, text): apply 0214_voice_language_check.sql first';
  end if;
  if h <> '6d5025fd76e3b8b4d731e2d98f65db6e' then
    raise exception '0220 found voice_language_problem(text, text) with a body that is not 0214''s (md5 %): read the live body first', h;
  end if;
  -- The two bodies this file replaces: 0171's, or this file's own (a replay).
  for r in select * from (values
      ('public.film_price(public.films)', '5de6c9bb2a74079e2078cad2d91b3c34', '25e85c92d74e740ed66fec577652fdc5'),
      ('public.film_precheck(public.films)', 'ff4fa7e8a6386420f32ab6a3a85a778c', '0a89da5f19fa2c6c0f6d802c02e18925')) v(sig, was, now_) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is null or h <> all (array[r.was, r.now_]) then
      raise exception '0220 found % with a body that is neither 0171''s nor 0220''s (md5 %): read the live body first', r.sig, h;
    end if;
  end loop;
  -- Applied before the sync (APPLY ORDER), every narration film on such a model reads voice_language_unknown. Said, not refused.
  select count(*) into n from public.model_registry m
   where 'tts' = any (m.capabilities)
     and coalesce(case when jsonb_typeof(m.spec -> 'languages') = 'array' then jsonb_array_length(m.spec -> 'languages') end, 0) = 0;
  if n > 0 then
    raise notice '0220: % tts models list no languages; a narration film on one reads voice_language_unknown until the registry is synced and the model probed again', n;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. film_precheck: 0171's body, one marked 0220 hunk
-- ───────────────────────────────────────────────────────────────────────────

-- What pricing would refuse that can be seen cheaply, as {reason, detail} or NULL: a model of the film (key frame, clip, voice) that
-- is not on sale for its role now or is Seedance, a voice model that does not speak the film's language (0220), a reference or a
-- first/last frame that is gone. start_film raises it before the rate step and before any pricing; quote_film finds the same through
-- film_price.
create or replace function public.film_precheck(p_film public.films) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  mm  record;
  bad jsonb;
begin
  for mm in select distinct m.model, m.caps, m.field from (
             select coalesce(s.keyframe_model, p_film.keyframe_model) as model, array['t2i', 'edit'] as caps, 'keyframe_model' as field
               from public.film_scenes s where s.film_id = p_film.id and s.first_frame = 'keyframe'
             union all
             select coalesce(s.clip_model, p_film.clip_model), array['i2v'], 'clip_model'
               from public.film_scenes s where s.film_id = p_film.id
             union all
             select p_film.voice ->> 'model', array['tts'], 'voice.model'
              where p_film.voice ->> 'source' = 'creative_tts'
                and exists (select 1 from public.film_scenes s where s.film_id = p_film.id and s.narration <> '')) m
            where m.model is not null order by m.field, m.model loop
    bad := public.film_model_problem(mm.model, mm.caps, mm.field);
    if bad is not null then
      return bad;
    end if;
  end loop;
  -- 0220: the voice model speaks the film's language (0214's voice_language_problem), asked after every role check above, so a
  -- hidden or unavailable voice model is still answered model_not_available and never with a language reason that would describe a
  -- registry row; and before the rate step, so a start whose film became unsupported since its quote is refused with its own word
  -- before anything is counted, priced or held. A voice with no model is left to film_price's own refusal, as before.
  if p_film.voice ->> 'source' = 'creative_tts' and p_film.voice ->> 'model' is not null
     and exists (select 1 from public.film_scenes s where s.film_id = p_film.id and s.narration <> '') then
    bad := public.voice_language_problem(p_film.voice ->> 'model', p_film.language);
    if bad is not null then
      return bad;
    end if;
  end if;
  if exists (select 1 from public.film_refs r where r.film_id = p_film.id
                and ((r.character_id is not null
                      and not exists (select 1 from public.characters c where c.id = r.character_id and c.org_id = r.org_id))
                     or (r.asset_id is not null and not public.film_asset_live(r.org_id, r.asset_id, 'image')))) then
    return jsonb_build_object('reason', 'reference_missing',
                              'detail', 'a reference picture or character no longer exists; remove it or choose another');
  end if;
  if exists (select 1 from public.film_scenes s where s.film_id = p_film.id
                and ((s.first_frame = 'asset' and not public.film_asset_live(s.org_id, s.first_frame_asset_id, 'image'))
                     or (s.last_frame = 'asset' and not public.film_asset_live(s.org_id, s.last_frame_asset_id, 'image')))) then
    return jsonb_build_object('reason', 'asset_not_usable',
                              'detail', 'a scene''s first or last frame is no longer in the library; choose another picture');
  end if;
  return null;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. film_price: 0171's body, one marked 0220 hunk
-- ───────────────────────────────────────────────────────────────────────────

-- The price of the film as it stands, line by line. Every line is priced from the backend's own rates (see 0171's header); a line that
-- cannot be priced carries its reason and makes the total NULL. Each priced line's params are exactly what was priced (the variant
-- creative_price settled on included), so the take carries them. Reads only; holds nothing.
create or replace function public.film_price(p_film public.films) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  f        public.films := p_film;
  sc       record;
  lines    jsonb := '[]'::jsonb;
  refusals jsonb := '[]'::jsonb;
  scenes_  jsonb := '[]'::jsonb;
  ln       jsonb;
  q        jsonb;
  bad      jsonb;
  params   jsonb;
  stand    uuid := public.film_stand_in(p_film.org_id);
  kmodel   text;
  cmodel   text;
  caps     text[];
  spec     jsonb;
  cap      text;
  refs_n   integer;
  ref_max  integer;
  target   numeric;
  dur      numeric;
  longest  numeric;
  sub      numeric;
  sub_ok   boolean;
  i        integer;
  total    numeric := 0;
  chars    integer;
  seconds  integer;
  minutes  integer;
  rate     public.credit_prices;
  sample   text;
  credits  numeric;
  res      text;
  label    text;
  n_scenes integer := 0;
begin
  for sc in select s.* from public.film_scenes s where s.film_id = f.id order by s.position loop
    n_scenes := n_scenes + 1;
    label := format('scene %s', sc.position + 1);
    sub := 0;
    sub_ok := true;
    kmodel := coalesce(sc.keyframe_model, f.keyframe_model);
    cmodel := coalesce(sc.clip_model, f.clip_model);

    -- The key frame (only a scene that makes its own).
    if sc.first_frame = 'keyframe' then
      ln := jsonb_build_object('line', 'keyframe', 'scene_id', sc.id, 'position', sc.position, 'shot_index', 0, 'model', kmodel);
      q := case when kmodel is not null then public.film_model_problem(kmodel, array['t2i', 'edit'], label || ' keyframe_model') end;
      if kmodel is null then
        ln := ln || jsonb_build_object('priced', false, 'reason', 'model_not_set',
                                       'detail', format('%s: choose a key-frame model', label));
      elsif q is not null then
        ln := ln || q;
      elsif btrim(sc.visual_prompt) = '' then
        ln := ln || jsonb_build_object('priced', false, 'reason', 'prompt_missing',
                                       'detail', format('%s: a key frame is made from the visual prompt; write one', label));
      else
        select m.capabilities, m.spec into caps, spec from public.model_registry m where m.id = kmodel;
        cap := case when 't2i' = any (coalesce(caps, '{}')) then 't2i' else 'edit' end;
        -- The references reach a clip through its key frame (0166): a model that cannot take them all is refused, never handed
        -- fewer than the person chose (CLAUDE.md #4).
        -- A 0047 character is all of its pictures, never one: each reaches the model.
        refs_n := (select coalesce(sum(case when r.character_id is null then 1
                                            else greatest((select count(*) from public.character_references cr
                                                            where cr.character_id = r.character_id), 1) end), 0)
                     from public.film_refs r where r.film_id = f.id and (r.scene_id is null or r.scene_id = sc.id));
        ref_max := case when jsonb_typeof(spec -> 'inputs' -> 'image_refs_max') = 'number'
                        then (spec -> 'inputs' ->> 'image_refs_max')::numeric::integer else 0 end;
        params := jsonb_build_object('prompt', sc.visual_prompt, 'aspect_ratio', f.aspect)
                  || case when f.style_kit_id is null then '{}'::jsonb else jsonb_build_object('style_kit_id', f.style_kit_id) end
                  || case when cap = 'edit' and stand is not null then jsonb_build_object('source_asset_id', stand) else '{}'::jsonb end;
        if refs_n > ref_max then
          q := jsonb_build_object('priced', false, 'reason', 'refs_not_supported',
                                  'detail', format('%s: %s takes %s reference pictures and this scene has %s; choose a model that takes them all or remove some',
                                                   label, kmodel, ref_max, refs_n));
        elsif cap = 'edit' and stand is null then
          q := jsonb_build_object('priced', false, 'reason', 'source_unavailable',
                                  'detail', format('%s: an edit model is priced against a picture of this library; add one picture', label));
        else
          q := public.film_try_price(f.org_id, cap, kmodel, params);
        end if;
        ln := ln || jsonb_build_object('capability', cap,
                                       'params', (params - 'prompt' - 'source_asset_id')
                                                 || jsonb_strip_nulls(jsonb_build_object('quality', q -> 'quality')))
              || q;
      end if;
      lines := lines || jsonb_build_array(ln);
    elsif sc.first_frame = 'asset' and not public.film_asset_live(f.org_id, sc.first_frame_asset_id, 'image') then
      refusals := refusals || jsonb_build_array(jsonb_build_object(
        'line', 'scene', 'scene_id', sc.id, 'position', sc.position, 'reason', 'asset_not_usable',
        'detail', format('%s: its first frame is no longer in the library; choose another picture', label)));
      sub_ok := false;
    end if;
    if sc.last_frame = 'asset' and not public.film_asset_live(f.org_id, sc.last_frame_asset_id, 'image') then
      refusals := refusals || jsonb_build_array(jsonb_build_object(
        'line', 'scene', 'scene_id', sc.id, 'position', sc.position, 'reason', 'asset_not_usable',
        'detail', format('%s: its last frame is no longer in the library; choose another picture', label)));
      sub_ok := false;
    end if;

    -- The clip shots: shot 1 from the first frame, shots 2-3 extend from the shot before.
    select m.spec into spec from public.model_registry m where m.id = cmodel;
    bad := case when cmodel is not null then public.film_model_problem(cmodel, array['i2v'], label || ' clip_model') end;
    target := ceil(sc.planned_seconds::numeric / sc.shot_count);
    select min(x::numeric) filter (where x::numeric >= target), max(x::numeric) into dur, longest
      from jsonb_array_elements_text(case when jsonb_typeof(spec -> 'durations_s') = 'array' then spec -> 'durations_s'
                                          else '[]'::jsonb end) x
     where x ~ '^[0-9]{1,3}(\.[0-9]+)?$';
    for i in 1 .. sc.shot_count loop
      ln := jsonb_build_object('line', case when i = 1 then 'clip' else 'extend' end, 'scene_id', sc.id, 'position', sc.position,
                               'shot_index', i, 'model', cmodel, 'capability', 'i2v');
      if cmodel is null then
        q := jsonb_build_object('priced', false, 'reason', 'model_not_set', 'detail', format('%s: choose a clip model', label));
      elsif bad is not null then
        q := bad;
      elsif dur is null then
        q := jsonb_build_object('priced', false, 'reason', 'scene_too_long_for_model',
                                'detail', case when longest is null
                                               then format('%s: %s lists no clip lengths', label, cmodel)
                                               else format('%s: %s makes at most %s s a shot, and %s s over %s shots needs %s s; give the scene more shots or fewer seconds',
                                                           label, cmodel, longest, sc.planned_seconds, sc.shot_count, target) end);
      elsif stand is null then
        q := jsonb_build_object('priced', false, 'reason', 'source_unavailable',
                                'detail', format('%s: a clip is priced against a picture of this library; add one picture', label));
      else
        res := coalesce(sc.clip_params ->> 'resolution', f.resolution);
        params := jsonb_build_object('source_asset_id', stand, 'duration_s', dur)
                  || case when res is null then '{}'::jsonb else jsonb_build_object('resolution', res) end
                  || case when sc.clip_params ? 'audio' then jsonb_build_object('audio', sc.clip_params -> 'audio') else '{}'::jsonb end
                  || case when i = sc.shot_count and sc.last_frame <> 'none' then jsonb_build_object('end_asset_id', stand)
                          else '{}'::jsonb end;
        q := public.film_try_price(f.org_id, 'i2v', cmodel, params);
        -- The variant creative_price settled on (the model's pinned resolution, silent or with sound) is part of what was priced.
        ln := ln || jsonb_build_object('duration_s', dur,
                                       'params', (params - 'source_asset_id' - 'end_asset_id')
                                                 || case when params ? 'end_asset_id' then '{"end_frame": true}'::jsonb else '{}'::jsonb end
                                                 || jsonb_strip_nulls(jsonb_build_object('resolution', q -> 'resolution',
                                                                                         'audio', q -> 'audio')));
      end if;
      lines := lines || jsonb_build_array(ln || q);
    end loop;

    -- The scene's subtotal: NULL when any of its lines is.
    select coalesce(bool_and((l ->> 'priced')::boolean), true) and sub_ok, sum((l ->> 'credits')::numeric)
      into sub_ok, sub
      from jsonb_array_elements(lines) l where l ->> 'scene_id' = sc.id::text;
    scenes_ := scenes_ || jsonb_build_array(jsonb_build_object(
      'scene_id', sc.id, 'position', sc.position, 'priced', sub_ok, 'credits', case when sub_ok then coalesce(sub, 0) end));
  end loop;
  if n_scenes = 0 then
    refusals := refusals || jsonb_build_array(jsonb_build_object('line', 'film', 'reason', 'no_scenes',
                                                                 'detail', 'the film has no scenes yet; add at least one'));
  end if;

  -- A reference that no longer exists is refused here, never dropped (0166: "the quote refuses it").
  if exists (select 1 from public.film_refs r where r.film_id = f.id
                and ((r.character_id is not null
                      and not exists (select 1 from public.characters c where c.id = r.character_id and c.org_id = r.org_id))
                     or (r.asset_id is not null and not public.film_asset_live(r.org_id, r.asset_id, 'image')))) then
    refusals := refusals || jsonb_build_array(jsonb_build_object('line', 'film', 'reason', 'reference_missing',
      'detail', 'a reference picture or character no longer exists; remove it or choose another'));
  end if;

  -- The narration: one film-level take of every scene's narration, at the voice model's rate as charged (see the header).
  select coalesce(sum(char_length(s.narration)), 0), min(s.narration) filter (where s.narration <> '')
    into chars, sample from public.film_scenes s where s.film_id = f.id;
  if chars > 0 then
    ln := jsonb_build_object('line', 'narration', 'scene_id', null, 'position', null, 'shot_index', 0,
                             'model', f.voice ->> 'model', 'capability', 'tts', 'quantity', chars);
    if f.voice is null then
      q := jsonb_build_object('priced', false, 'reason', 'voice_not_set', 'detail', 'the narration needs a voice; choose one');
    elsif f.voice ->> 'source' = 'channel' then
      q := jsonb_build_object('priced', false, 'reason', 'channel_voice_not_priced',
                              'detail', 'a channel''s own voice is not priced here; choose a voice for the film');
    else
      -- 0220: the role first (a hidden model still reads model_not_available), then the language (0214), then the price, so a
      -- voice that does not speak the film's language, or that nobody listed languages for, is never priced and never held.
      q := coalesce(public.film_model_problem(f.voice ->> 'model', array['tts'], 'voice.model'),
                    public.voice_language_problem(f.voice ->> 'model', f.language),
                    public.film_try_price(f.org_id, 'tts', f.voice ->> 'model',
                                          jsonb_build_object('prompt', left(sample, (public.film_money_limits() ->> 'tts_sample_chars')::integer),
                                                             'voice_id', f.voice ->> 'voice_id')));
      if (q ->> 'priced')::boolean then
        credits := public.credits_round_up(round(chars * (q ->> 'credits_per_unit')::numeric, 6));
        -- One provider call carries at most tts_sample_chars characters, and the Studio charges each call its minimum.
        if credits > 0 then
          credits := greatest(credits, ceil(chars / (public.film_money_limits() ->> 'tts_sample_chars')::numeric)
                                       * (q ->> 'minimum')::numeric);
        end if;
        q := q || jsonb_build_object('quantity', chars, 'credits', credits,
                                     'params', jsonb_build_object('voice_id', f.voice ->> 'voice_id'));
      end if;
    end if;
    lines := lines || jsonb_build_array(ln || q);
  end if;

  -- The assembly (with the captions our own pipeline makes from the narration): film_assembly_minute times the planned minutes,
  -- rounded up. No row: unpriced, never 0.
  select coalesce(sum(s.planned_seconds), 0) into seconds from public.film_scenes s where s.film_id = f.id;
  minutes := greatest(ceil(seconds / 60.0)::integer, 1);
  select * into rate from public.credit_prices where unit = 'film_assembly_minute';
  ln := jsonb_build_object('line', 'assembly', 'scene_id', null, 'position', null, 'shot_index', null, 'model', null,
                           'capability', null, 'quantity', minutes, 'unit', 'film_assembly_minute', 'minimum', 0,
                           'includes', case when f.captions_mode = 'none' then '[]'::jsonb else '["captions"]'::jsonb end);
  if rate.unit is null then
    ln := ln || jsonb_build_object('priced', false, 'reason', 'unpriced',
      'detail', 'film assembly has no credit price yet; a platform admin sets film_assembly_minute on the Credits page');
  else
    ln := ln || jsonb_build_object('priced', true, 'credits_per_unit', rate.credits_per_unit * (1 + rate.margin),
      'credits', public.credits_round_up(round(minutes * rate.credits_per_unit * (1 + rate.margin), 6)));
  end if;
  lines := lines || jsonb_build_array(ln);
  -- An unpriced line says so in its own credits: null, never a missing key a client could read as 0.
  select jsonb_agg(case when (l ->> 'priced')::boolean then l else l || '{"credits": null}'::jsonb end order by o)
    into lines from jsonb_array_elements(lines) with ordinality t(l, o);

  for ln in select l from jsonb_array_elements(lines) l where not (l ->> 'priced')::boolean loop
    refusals := refusals || jsonb_build_array(jsonb_build_object(
      'line', ln ->> 'line', 'scene_id', ln -> 'scene_id', 'position', ln -> 'position', 'shot_index', ln -> 'shot_index',
      'reason', ln ->> 'reason', 'detail', ln ->> 'detail'));
  end loop;
  if jsonb_array_length(refusals) = 0 then
    select sum((l ->> 'credits')::numeric) into total from jsonb_array_elements(lines) l;
  else
    total := null;
  end if;

  return jsonb_build_object(
    'film_id', f.id, 'version', f.version, 'priced', total is not null, 'total', total,
    -- The token start_film must be handed back: the version and an md5 of exactly what was priced (jsonb text is canonical).
    'quote_id', case when total is not null
                     then format('fq-%s-%s', f.version,
                                 md5(jsonb_build_object('film', f.id, 'version', f.version, 'lines', lines, 'total', total)::text)) end,
    'lines', lines, 'scenes', scenes_, 'refusals', refusals,
    'planned_seconds', seconds, 'assembly_minutes', minutes);
end
$$;

-- 0171's grants, said again (create or replace keeps them): no API role executes either helper.
revoke all on function public.film_precheck(public.films) from public, anon, authenticated, service_role;
revoke all on function public.film_price(public.films) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.film_price(public.films)', '25e85c92d74e740ed66fec577652fdc5'),
      ('public.film_precheck(public.films)', '0a89da5f19fa2c6c0f6d802c02e18925'),
      ('public.voice_language_problem(text, text)', '6d5025fd76e3b8b4d731e2d98f65db6e')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception '0220 end state: % does not hold the expected body (md5 %)', r.sig, h;
    end if;
  end loop;
  for r in select * from (values ('public.film_price(public.films)'), ('public.film_precheck(public.films)')) v(sig) loop
    if has_function_privilege('anon', r.sig, 'execute') or has_function_privilege('authenticated', r.sig, 'execute')
       or has_function_privilege('service_role', r.sig, 'execute') then
      raise exception '0220 end state: an API role may execute %', r.sig;
    end if;
  end loop;
end $$;

-- Verify (read-only, run after applying):
--   select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--    where oid in ('public.film_price(public.films)'::regprocedure, 'public.film_precheck(public.films)'::regprocedure);
--     -- 25e85c92d74e740ed66fec577652fdc5 and 0a89da5f19fa2c6c0f6d802c02e18925 (either order)
--   select id, availability, verified_at, spec -> 'languages' from public.model_registry where 'tts' = any(capabilities) order by id;
--     -- every row lists its languages, and the models the owner sells are verified and on sale again (APPLY ORDER 2-4)
--   select prosrc like '%voice_language_problem(f.voice ->> ''model'', f.language)%' from pg_proc
--    where oid = 'public.film_price(public.films)'::regprocedure;                                            -- true
--   select has_function_privilege('authenticated', 'public.film_price(public.films)', 'execute'),
--          has_function_privilege('service_role', 'public.film_precheck(public.films)', 'execute');      -- false, false
--   In the app: an Uzbek film whose voice is Eleven Multilingual v2 is quoted with its narration line unpriced
--   (voice_language_unsupported, "choose Eleven v3, a voice model that lists Uzbek"), no total and no Start.
