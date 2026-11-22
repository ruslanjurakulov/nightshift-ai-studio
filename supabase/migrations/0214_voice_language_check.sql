-- 0214_voice_language_check.sql — does a film's voice model speak the film's language? Asked before the hold, never after.
--
-- WHY. quote_film (0171, the narration branch) checks the voice model's role and price, never films.language (0166: en, ru, uz).
-- An Uzbek film read by Eleven Multilingual v2, which ElevenLabs' own model page does not list for Uzbek, is quoted and its
-- credits are held; it fails only at the narration take, in the TTS adapter (modules/capabilities/audio.py, through
-- modules/tts_languages.refusal), after the clips were already paid for. Refusing late is the right failure for the take (rule 4:
-- no other model is picked), but it is the wrong place to discover it (rule 6: fail before anything is spent).
-- docs/studio/S6_GAPS.md, gap G1.
--
-- WHAT. One helper, public.voice_language_problem(model, language), read from the registry: model_registry.spec -> 'languages'.
-- schemas/model_registry.json now lists, for every tts entry, the languages modules/tts_languages.MODEL_LANGUAGES holds for its
-- vendor model (tests/test_tts_registry_languages.py keeps the two equal), and `tools/probe_models.py --sync` copies it into spec.
--   the model lists the language                      -> NULL (no problem)
--   the model has a languages list without it         -> {priced: false, reason: 'voice_language_unsupported', detail}
--   no row, no languages list, no language given,
--   or a language outside en/ru/uz                    -> {priced: false, reason: 'voice_language_unknown', detail}
-- Unknown is never "speaks" (rule 5): a model nobody wrote a list for is refused, not waved through. The lists hold only the three
-- languages modules/tts_languages checked (VERIFIED_LANGUAGES), so a fourth missing from a list is not known to be unspoken: it is
-- unknown too, never unsupported. The answer has the same shape
-- as film_model_problem's and film_try_price's refusals (0171), so a quote line can carry it as it is.
--
-- WHAT IT DOES NOT DO. It changes no money function: quote_film, start_film and film_price are S2's (docs/studio/PROGRAM.md), and
-- until S2 calls this nothing behaves differently. The one line S2 adds, in quote_film's narration branch (the `else` after the
-- channel-voice refusal), puts this second in the existing coalesce, after the role check and before the price, so a refused
-- language is never priced or held:
--
--     q := coalesce(public.film_model_problem(f.voice ->> 'model', array['tts'], 'voice.model'),
--                   public.voice_language_problem(f.voice ->> 'model', f.language),
--                   public.film_try_price(...unchanged...));
--
-- The role check goes first on purpose: a hidden or unavailable model must be answered model_not_available, never with a
-- language reason whose detail would name a registry row the member cannot otherwise see.
--
-- start_film should ask the same before its rate step (film_precheck), for the same reason.
--
-- NOTE ON THE SYNC. model_registry_guard (0100) clears a model's verification when spec.languages changes, and sends one on sale
-- (beta/ga) back to hidden, because a language list is part of what a probe proved. The first sync after this registry change
-- therefore un-verifies whichever of the four ElevenLabs TTS models is verified today, until each is probed again. The Probe
-- models workflow always passes --sync, so ANY probe run, of any model, is that sync. --all skips terms-gated entries (all four
-- are gated plan_required:scale), so probe each by name, with a voice id from the account's list (--voice-id or
-- ELEVENLABS_VOICE_ID):
--     python tools/probe_models.py --sync --model elevenlabs-v4 --model elevenlabs-v3 \
--       --model elevenlabs-multilingual-v2 --model elevenlabs-flash-v2.5 --voice-id <voice id>
-- or one Probe models workflow run per id. That is the guard doing its job, not a bug. Deploy order: docs/MIGRATIONS.md (0214).
--
-- Security definer with a pinned search_path so quote_film (itself security definer) may call it whatever role asks for the
-- quote: it runs as its owner, so no role is granted execute (like film_model_problem). Nobody calls it directly; it
-- reads registry rows a caller has no business enumerating one model id at a time.
-- Requires 0035 (model_registry). Additive and idempotent: create or replace, nothing dropped.
-- Undo: docs/sql/rollback_0214_voice_language_check.sql (owner-applied).
-- APPLY AS ONE TRANSACTION.

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.model_registry') is null then
    raise exception '0214 needs public.model_registry: apply 0035 first';
  end if;
end
$$;

create or replace function public.voice_language_problem(p_model text, p_language text) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  lang  text := lower(btrim(coalesce(p_language, '')));
  m     public.model_registry;
  langs jsonb;
  -- The person reads the language by name (only the three checked languages reach a sentence that names one).
  said  text;
begin
  said := case lang when 'uz' then 'Uzbek' when 'ru' then 'Russian' when 'en' then 'English' end;
  if lang = '' or lang not in ('en', 'ru', 'uz') then
    return jsonb_build_object('priced', false, 'reason', 'voice_language_unknown',
                              'detail', case when lang = '' then 'the film has no language set, so nobody can say the voice speaks it; choose the film''s language'
                                             else 'only English, Russian and Uzbek were checked for voice models; choose one of them' end);
  end if;
  select * into m from public.model_registry where id = p_model;
  if not found then
    return jsonb_build_object('priced', false, 'reason', 'voice_language_unknown',
                              'detail', 'this voice model is not known, so nobody can say it speaks ' || said
                                        || '; choose a voice model that lists it');
  end if;
  langs := m.spec -> 'languages';
  -- A list that is missing, empty or not a list is not a claim anyone made: unknown, never "speaks" (rule 5).
  if langs is null or jsonb_typeof(langs) <> 'array' or jsonb_array_length(langs) = 0 then
    return jsonb_build_object('priced', false, 'reason', 'voice_language_unknown',
                              'detail', left(m.display_name, 80) || ' does not list the languages it speaks, so nobody can say it speaks '
                                        || said || '; choose a voice model that lists it');
  end if;
  if langs @> jsonb_build_array(lang) then
    return null;
  end if;
  -- Only v3 is named as the Uzbek fix, like modules/tts_languages.UZBEK_FIX: v4 lists Uzbek but has not been tried here.
  return jsonb_build_object('priced', false, 'reason', 'voice_language_unsupported',
                            'detail', left(m.display_name, 80) || ' does not speak ' || said
                                      || case when lang = 'uz' then '; choose Eleven v3, a voice model that lists Uzbek'
                                              else '; choose a voice model that lists ' || said end);
end
$$;

revoke all on function public.voice_language_problem(text, text) from public, anon, authenticated, service_role;

-- Verify (run after applying, and after the next registry sync):
--   select id, spec -> 'languages' from public.model_registry where 'tts' = any(capabilities) order by id;
--     -- every row lists its languages; elevenlabs-v4 and -v3 list uz, multilingual-v2 and flash-v2.5 do not
--   select public.voice_language_problem('elevenlabs-multilingual-v2', 'uz') ->> 'reason';  -- voice_language_unsupported
--   select public.voice_language_problem('elevenlabs-v4', 'uz');                            -- null
--   select public.voice_language_problem('no-such-model', 'uz') ->> 'reason';               -- voice_language_unknown
--   select public.voice_language_problem('elevenlabs-v4', 'de') ->> 'reason';               -- voice_language_unknown
--   select has_function_privilege('anon', 'public.voice_language_problem(text, text)', 'execute'),
--          has_function_privilege('authenticated', 'public.voice_language_problem(text, text)', 'execute'),
--          has_function_privilege('service_role', 'public.voice_language_problem(text, text)', 'execute');  -- false x3
--   select id, availability, verified_at from public.model_registry where 'tts' = any(capabilities);
