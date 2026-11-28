-- 0236_film_clip_sound_gate.sql — while the film's cut drops a clip's own sound, a scene that asks for the priced sound option is
-- refused by name (clip_sound_not_kept), at quote and at start, instead of being sold and then dropped (Breach BR-SG-01, S1).
--
-- *** LIVE ON APPLY. *** It replaces TWO functions that exist there (film_price, 0235's body plus one hunk; film_assembly_retryable,
-- 0215's body plus one hunk) and adds one column to one table (film_studio_settings.clip_sound_kept, default false). It writes no
-- other row and grants nothing.
--
-- EVIDENCE (the code, 2026-11-28; docs/studio/S2_CLIP_AUDIO.md section 1, PR #963).
--   * modules/film_timeline.py on main wrote every picture clip without "audio": true, so a take bought with its own sound
--     (clip_params.audio = true: kling-v3, seedance-1.5-pro; 0224 prices the _audio variant) came out of the assembly silent.
--   * 0218's film_price copies clip_params.audio into each clip line and creative_price charges the with-sound variant for it: the
--     person paid for sound the film never played (CLAUDE.md rules 4 and 5).
-- DIAGNOSIS. The sale and the cut disagree; the sale is the one the database can stop, now, by name.
-- CHANGE.
--   film_studio_settings.clip_sound_kept   NEW column, boolean, default FALSE (0171's one-row switch table: no API role reads or
--                                          writes it, RLS on, written only from the SQL editor). It says "the worker that renders
--                                          films keeps a clip's own sound in the cut" (modules/film_timeline.py CLIP_SOUND_IN_CUT).
--   film_price                             REPLACED on 0235's body (186d34ffb633bc56a91bbf617b0b7520: 0218's plus 0235's org-aware
--                                          model checks) with ONE hunk, every line marked
--                                          `-- 0236`: right after the clip model's check, a scene whose clip_params.audio is the JSON
--                                          true, while clip_sound_kept is not true, gets `clip_sound_not_kept` on each of its clip
--                                          lines ("scene N: clip sound is not yet kept in the final film; turn the scene's sound option
--                                          off"), exactly as a model problem is carried (priced false, so the total is NULL). A model
--                                          problem on the same scene is still named first. Nothing else changes.
--   Inherited, not replaced: quote_film (0198: film_price's refusals are the quote's), start_film (0215: re-prices with film_price
--   and answers its first refusal as {ok: false, reason}), quote_film_resume, start_film_resume and film_resume_price (0215). So the
--   refusal is server-side on every path that sells a film, and the Command Center's /api/films/[id]/start answers the same word
--   (memberSafeStart passes start_film's reason), with its sentence in lib/i18n/studio-timeline/{en,ru,uz}.ts.
--   film_assembly_retryable                REPLACED on 0215's body (82ec51dabd0ff178ec2280bc0c56e62b) with ONE hunk (two lines,
--                                          marked `-- 0236`): the S2 assembly's two new transient words, `sound_mix_failed` (an
--                                          audio-only ffmpeg of modules/film_mix.py stopped) and `asset_unprobed` (a shot's file
--                                          could not be probed for its sound track), are ones a re-run of the same takes may cure, so
--                                          rerun_film_assembly makes them again instead of answering assembly_not_retryable (Lens I2:
--                                          the worker's remedy for both is "retry the assembly", rule 6). Every other word keeps
--                                          0215's answer; clip_without_sound (re-shoot) stays not retryable.
--   film_precheck is NOT replaced: start_film always reaches film_price, and a second copy of the rule there would be a second body
--   to rebase for nothing.
-- WHAT A PERSON SEES. clip_params.audio = false, or no audio key: unchanged, the silent price. true: refused, with the fix (turn the
--   scene's sound option off). Single-price models (Veo, H3, LTX ...) never carry clip_params.audio (0224 refuses it on them): unchanged.
--   A film already started is not touched (its takes are made; the worker's own rules apply).
-- OWNER STEP (the order matters). Turn clip_sound_kept on ONLY after the media worker running the S2 clip-sound fix (this pull request:
--   modules/film_timeline.py CLIP_SOUND_IN_CUT = True, modules/film_mix.py) is deployed. Then, in the SQL editor:
--     update public.film_studio_settings set clip_sound_kept = true, updated_at = now() where id;
--   Turning it on before that worker runs would sell sound a running worker still drops.
-- ORDER. Apply after 0235 (#970: the operator preview, which replaces 0218's film_price first); Atlas's merge and apply order is
--   0235 -> 0236 -> 0239 -> 0240. This file accepts only 0235's film_price (or its own): on 0218's it refuses, with "apply 0235
--   first". The hunk is six lines in one place, right after the clip model's check, which 0235 gives the film's organization.
-- NO BACKSLASH anywhere in this file (0219's header: the live apply path once rewrote backslash escapes in SQL text). White space is
--   folded with [[:space:]]+, and the one backslash film_price's body holds (0218's clip-length pattern, kept by 0235) is written @@0236_BACKSLASH@@
--   and put back with chr(92) before the body is executed, so the body that reaches the database is byte for byte the one hashed below.
-- REPLACES (md5 of prosrc with every run of white space read as one space):
--   film_price                0235 186d34ffb633bc56a91bbf617b0b7520 -> 0236 af0fb80cce8e92fd2360aa6d5366a942
--   film_assembly_retryable   0215 82ec51dabd0ff178ec2280bc0c56e62b -> 0236 88a312d28e63be043796bcc86f024164
--   0215's own replay and rollback refuse 0236's film_assembly_retryable: take 0236 off first (its rollback), as the lab does.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; the SQL editor on the live project). Expected: one row, all true.
--   select (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = 'public.film_price(public.films)'::regprocedure)
--            = '186d34ffb633bc56a91bbf617b0b7520' as film_price_is_0235s,
--          (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = 'public.film_assembly_retryable(text)'::regprocedure)
--            = '82ec51dabd0ff178ec2280bc0c56e62b' as retryable_is_0215s,
--          to_regclass('public.film_studio_settings') is not null as switch_table_exists;
--
-- APPLY AS ONE TRANSACTION (SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1): `set local lock_timeout`
-- assumes it, and the last block asserts the end state. Idempotent: a replay finds this file's body and the column, and writes them
-- again (the switch's value is never reset by a replay).
-- Rollback: docs/sql/rollback_0236_film_clip_sound_gate.sql (owner-applied; puts 0235's and 0215's bodies back byte for byte and drops
-- the column).
-- Docs: docs/MIGRATIONS.md, "Film clip sound: refused until the cut keeps it (0236, provisional)".

set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regclass('public.film_studio_settings') is null or to_regprocedure('public.film_price(public.films)') is null then
    raise exception '0236 needs 0171_films_money.sql, 0218_creative_prompt_limits.sql and 0235_film_operator_preview.sql: apply them first';
  end if;
  -- The body this file replaces must be 0235's, or this file's own (a replay). Anything else was changed since, and replacing it would
  -- silently undo that change (the 0064/0103 lesson); 0218's body means 0235 is not applied yet (see ORDER).
  select md5(regexp_replace(x.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc x
   where x.oid = 'public.film_price(public.films)'::regprocedure;
  if h = '3c22f87be736c073d17d93e040e914e1' then
    raise exception '0236 found 0218''s film_price: apply 0235_film_operator_preview.sql first (0236 is written on its body)';
  end if;
  if h is null or h <> all (array['186d34ffb633bc56a91bbf617b0b7520', 'af0fb80cce8e92fd2360aa6d5366a942']) then
    raise exception '0236 found a film_price() that is neither 0235''s body nor 0236''s (md5 %): read the live body first', h;
  end if;
  if to_regprocedure('public.film_assembly_retryable(text)') is null then
    raise exception '0236 needs 0215_film_archive_resume.sql (film_assembly_retryable): apply it first';
  end if;
  select md5(regexp_replace(x.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc x
   where x.oid = 'public.film_assembly_retryable(text)'::regprocedure;
  if h <> all (array['82ec51dabd0ff178ec2280bc0c56e62b', '88a312d28e63be043796bcc86f024164']) then
    raise exception '0236 found a film_assembly_retryable() that is neither 0215''s body nor 0236''s (md5 %): read the live body first', h;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The switch (one column on 0171's one-row table; default off)
-- ───────────────────────────────────────────────────────────────────────────
alter table public.film_studio_settings add column if not exists clip_sound_kept boolean not null default false;

comment on column public.film_studio_settings.clip_sound_kept is
  'Migration 0236 (BR-SG-01): true once the film worker keeps a clip''s own sound in the cut (modules/film_timeline.py CLIP_SOUND_IN_CUT). While false (the default), film_price refuses a scene whose clip_params.audio is true with clip_sound_not_kept. Written only from the SQL editor, after that worker is deployed. No API role reads or writes this table.';

-- 0171's grants, said again for the new column: no API role reads or writes the table.
revoke all on public.film_studio_settings from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. film_price: 0235's body plus the one hunk marked -- 0236
-- ───────────────────────────────────────────────────────────────────────────
-- Built as text with its one backslash written @@0236_BACKSLASH@@ and put back with chr(92) (see the header), then executed; the end
-- state below checks the md5 of the body that results.
do $fp$
begin
  execute replace($fp0236$create or replace function public.film_price(p_film public.films) returns jsonb
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
      -- 0235: the film's organization, so a platform admin's operator preview in the exempt organization passes (and nobody else's).
      q := case when kmodel is not null then public.film_model_problem(kmodel, array['t2i', 'edit'], label || ' keyframe_model', f.org_id) end;
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
                  -- 0218: the negative prompt the take carries (0198), so the quote asks whether this model takes one.
                  || case when btrim(sc.negative_prompt) <> '' then jsonb_build_object('negative_prompt', sc.negative_prompt)
                          else '{}'::jsonb end
                  || case when cap = 'edit' and stand is not null then jsonb_build_object('source_asset_id', stand) else '{}'::jsonb end;
        if refs_n > ref_max then
          q := jsonb_build_object('priced', false, 'reason', 'refs_not_supported',
                                  'detail', format('%s: %s takes %s reference pictures and this scene has %s; choose a model that takes them all or remove some',
                                                   label, kmodel, ref_max, refs_n));
        -- 0235 (refs path): a film's key frame is made from words (film_take_job sends t2i), and an adapter sends references only on
        -- the capabilities it lists (registry inputs.ref_capabilities, checked against the adapter): one that does not list t2i would
        -- refuse this take at submit, after the hold. Not listed, or not stated at all, is refused here, before anything is held.
        elsif refs_n > 0 and not coalesce(jsonb_typeof(spec -> 'inputs' -> 'ref_capabilities') = 'array'
                                          and (spec -> 'inputs' -> 'ref_capabilities') ? 't2i', false) then
          q := jsonb_build_object('priced', false, 'reason', 'refs_not_supported',
                                  'detail', format('%s: %s does not take reference pictures for a key frame made from words; remove the reference pictures or choose a key-frame model that takes them',
                                                   label, kmodel));
        elsif cap = 'edit' and stand is null then
          q := jsonb_build_object('priced', false, 'reason', 'source_unavailable',
                                  'detail', format('%s: an edit model is priced against a picture of this library; add one picture', label));
        else
          q := public.film_try_price(f.org_id, cap, kmodel, params);
        end if;
        ln := ln || jsonb_build_object('capability', cap,
                                       'params', (params - 'prompt' - 'negative_prompt' - 'source_asset_id')
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
    -- 0235: the film's organization, so a platform admin's operator preview in the exempt organization passes (and nobody else's).
    bad := case when cmodel is not null then public.film_model_problem(cmodel, array['i2v'], label || ' clip_model', f.org_id) end;
    -- 0236: while the cut drops a clip's own sound (BR-SG-01), the priced sound option is refused by name, not sold to be dropped.
    if bad is null and sc.clip_params -> 'audio' = 'true'::jsonb  -- 0236
       and not coalesce((select s.clip_sound_kept from public.film_studio_settings s where s.id), false) then  -- 0236
      bad := jsonb_build_object('priced', false, 'reason', 'clip_sound_not_kept',  -- 0236
                                'detail', format('%s: clip sound is not yet kept in the final film; turn the scene''s sound option off', label));  -- 0236
    end if;  -- 0236
    target := ceil(sc.planned_seconds::numeric / sc.shot_count);
    select min(x::numeric) filter (where x::numeric >= target), max(x::numeric) into dur, longest
      from jsonb_array_elements_text(case when jsonb_typeof(spec -> 'durations_s') = 'array' then spec -> 'durations_s'
                                          else '[]'::jsonb end) x
     where x ~ '^[0-9]{1,3}(@@0236_BACKSLASH@@.[0-9]+)?$';
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
                          else '{}'::jsonb end
                  -- 0218: the words the take sends (0198: the scene's visual prompt, and its negative prompt when it has one), so the
                  -- clip model's own prompt limit and whether it takes a negative prompt are asked here, not by the worker after the hold.
                  || case when btrim(sc.visual_prompt) <> '' then jsonb_build_object('prompt', sc.visual_prompt) else '{}'::jsonb end
                  || case when btrim(sc.negative_prompt) <> '' then jsonb_build_object('negative_prompt', sc.negative_prompt)
                          else '{}'::jsonb end;
        q := public.film_try_price(f.org_id, 'i2v', cmodel, params);
        -- The variant creative_price settled on (the model's pinned resolution, silent or with sound) is part of what was priced.
        ln := ln || jsonb_build_object('duration_s', dur,
                                       'params', (params - 'source_asset_id' - 'end_asset_id' - 'prompt' - 'negative_prompt')
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
      -- 0235: the film's organization, so a platform admin's operator preview in the exempt organization passes (and nobody else's).
      q := coalesce(public.film_model_problem(f.voice ->> 'model', array['tts'], 'voice.model', f.org_id),
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
$$;$fp0236$, '@@0236_BACKSLASH@@', chr(92));
end
$fp$;
revoke all on function public.film_price(public.films) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2b. film_assembly_retryable: 0215's body plus the one hunk marked -- 0236
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.film_assembly_retryable(p_word text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_word in ('assembly_crashed', 'render_failed', 'render_timed_out', 'render_degraded', 'store_failed', 'disk_low',
                             'output_mismatch', 'captions_failed', 'captions_unavailable'), false)
         -- 0236: the film's sound mix, or the probe of a shot's file, failed: the same takes may assemble next time.
         or coalesce(p_word in ('sound_mix_failed', 'asset_unprobed'), false)  -- 0236
         -- The word was lost: the assembly's own word never reached the settle, because the sweep settled the segment at its
         -- deadline, the claim after the last lease settled it worker_lost, or the worker settled the generic assembly_failed (it
         -- raised, or could not begin). The cause is unknown, never proven deterministic, and a failed assembly is charged 0: the
         -- re-run, which costs only the assembly line, is allowed.
         or coalesce(p_word in ('deadline', 'worker_lost', 'assembly_failed'), false)
$$;
revoke all on function public.film_assembly_retryable(text) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  fp  oid := 'public.film_price(public.films)'::regprocedure;
  got text;
begin
  select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into got from pg_proc p where p.oid = fp;
  if got <> 'af0fb80cce8e92fd2360aa6d5366a942' then
    raise exception '0236 end state: film_price does not hold this file''s body (md5 %)', got;
  end if;
  if exists (select 1 from pg_proc p
              where p.oid = fp
                and (p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a
                                 where a.grantee = 0
                                    or a.grantee in (select o.oid from pg_roles o
                                                      where o.rolname in ('anon', 'authenticated', 'service_role'))))) then
    raise exception '0236 end state: film_price is executable by an API role';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = fp and p.prosecdef
                    and p.proconfig @> array['search_path=public, pg_temp']) then
    raise exception '0236 end state: film_price is not security definer with a pinned search_path';
  end if;
  select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into got from pg_proc p
   where p.oid = 'public.film_assembly_retryable(text)'::regprocedure;
  if got <> '88a312d28e63be043796bcc86f024164' then
    raise exception '0236 end state: film_assembly_retryable does not hold this file''s body (md5 %)', got;
  end if;
  if not public.film_assembly_retryable('sound_mix_failed') or not public.film_assembly_retryable('asset_unprobed')
     or public.film_assembly_retryable('clip_without_sound') or not public.film_assembly_retryable('render_failed') then
    raise exception '0236 end state: film_assembly_retryable does not answer the S2 words as this file says';
  end if;
  if has_function_privilege('anon', 'public.film_assembly_retryable(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.film_assembly_retryable(text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.film_assembly_retryable(text)', 'EXECUTE') then
    raise exception '0236 end state: film_assembly_retryable is executable by an API role';
  end if;
  if not exists (select 1 from information_schema.columns c
                  where c.table_schema = 'public' and c.table_name = 'film_studio_settings' and c.column_name = 'clip_sound_kept'
                    and c.data_type = 'boolean' and c.is_nullable = 'NO' and c.column_default = 'false') then
    raise exception '0236 end state: film_studio_settings.clip_sound_kept is not a boolean, not null, default false';
  end if;
  if has_table_privilege('anon', 'public.film_studio_settings', 'select') or has_table_privilege('authenticated', 'public.film_studio_settings', 'select')
     or has_table_privilege('anon', 'public.film_studio_settings', 'update') or has_table_privilege('authenticated', 'public.film_studio_settings', 'update')
     or has_table_privilege('service_role', 'public.film_studio_settings', 'update')
     or has_column_privilege('authenticated', 'public.film_studio_settings', 'clip_sound_kept', 'update')
     or has_column_privilege('anon', 'public.film_studio_settings', 'clip_sound_kept', 'update') then
    raise exception '0236 end state: an API role can read or write film_studio_settings';
  end if;
  if not exists (select 1 from pg_class c where c.oid = 'public.film_studio_settings'::regclass and c.relrowsecurity) then
    raise exception '0236 end state: film_studio_settings has row level security off';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
--     where oid = 'public.film_price(public.films)'::regprocedure) = 'af0fb80cce8e92fd2360aa6d5366a942' as film_price_is_0236s,
--   (select clip_sound_kept from public.film_studio_settings where id) = false as switch_off_until_the_worker_is_deployed,
--   not has_table_privilege('authenticated', 'public.film_studio_settings', 'select')
--     and not has_table_privilege('authenticated', 'public.film_studio_settings', 'update')
--     and not has_table_privilege('anon', 'public.film_studio_settings', 'select')
--     and not has_table_privilege('service_role', 'public.film_studio_settings', 'update') as switch_not_api_writable,
--   not has_function_privilege('authenticated', 'public.film_price(public.films)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.film_price(public.films)', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.film_price(public.films)', 'EXECUTE') as film_price_internal,
--   (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
--     where oid = 'public.film_assembly_retryable(text)'::regprocedure) = '88a312d28e63be043796bcc86f024164' as retryable_is_0236s,
--   public.film_assembly_retryable('sound_mix_failed') and public.film_assembly_retryable('asset_unprobed')
--     and not public.film_assembly_retryable('clip_without_sound') as s2_words_retryable;
