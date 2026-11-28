-- 0239_film_keyframe_refs_quote.sql — a film's key frame is quoted the way its take and the worker really make it: an edit-only
-- key-frame model, the style kit's and @characters' pictures beside the film's references, a deleted character picture and more than
-- 16 references are refused at the quote, by name, before anything is held; and a character given more pictures after Start fails its
-- take by name in the worker, before the provider call.
--
-- DEPENDS ON 0235 (0235_film_operator_preview.sql) BEING APPLIED FIRST: film_price, film_apply_settings and film_save_scenes are
-- replaced on 0235's bodies, and the drift guard below refuses any other. It replaces neither start_film nor film_take_job (0198's,
-- which a later file replaces): what the take must re-check is checked by the worker.
--
-- EVIDENCE (Breach, against 0235's head 23ee434fb in the local lab; tests/security/test_sec_breach_0235_refs_take.py, each test failing
-- before this file): every case below is a film that quote_film priced, start_film held, and the first key-frame take refused. No
-- credit is lost (a failed take is charged 0 and the hold is released), but the quote promised a film that cannot be made.
--   B1 film_check_model(m, ['t2i','edit']) passes a model on sale only for edit (the live registry has one: krea-3-regional) as the
--      film's keyframe_model (film_apply_settings) and as a scene's (film_save_scenes); film_price prices it on edit against the
--      stand-in picture; film_take_job (0198) makes every key frame as t2i and answers bad_request "this key-frame model edits a picture".
--   B2 film_price counts film_refs only. The worker (FilmOrchestrator._inputs) asked CreativeWorker._style for the style kit's and the
--      @characters' pictures with every one of the model's reference slots (RegistryAdapter.style_support: image_refs_max minus the
--      take's own input files, none on t2i), THEN put the film's references in front: one film reference plus any kit on a
--      3-reference model was 4 pictures, and RegistryAdapter.submit refuses more than image_refs_max as bad_request.
--   B3 a style kit or a mentioned @character with no description, on a key-frame model that takes no reference on t2i (GPT Image,
--      Flux, ...): with no film_refs 0235's refs check never asks, and the worker refuses ("has no description and this model cannot
--      use its pictures") after the hold.
--   B4 film_price's reference_missing asks only that a reference character exists; film_take_job asks that every one of its pictures is
--      live and answers input_missing.
--   B5 a character given more pictures after Start (save_character is not locked by a running film) reaches film_take_job, which checks
--      only <= 16, above the model's image_refs_max; the adapter refuses it at submit.
--   B6 image_refs_max may be up to 30 (the schema), film_price priced 17..30 references, film_take_job refuses more than 16.
-- DIAGNOSIS. The quote asked a smaller question than the take: it did not know the key frame is t2i only, did not count what the worker
--   adds beside the film's references, did not ask that a character's pictures are live, and took the model's limit above the take's.
--   For B2 the overflow came from the worker, not the quote: the style pictures are trimmed to the slots the model leaves (0048's design,
--   creative_style.pick_references), but the film's references were never counted against those slots.
-- CHANGE.
--   film_apply_settings, film_save_scenes (0235's bodies, one hunk each)
--     a key-frame model must be on sale for t2i: after 0235's film_check_model (the id, Seedance first, on sale for a role), one more
--     film_model_problem(m, ['t2i']) refuses model_not_available with the remedy ("choose a key-frame model that makes a picture from
--     words"). The clip model and the voice are not touched.
--   film_price (0235's body, hunks marked `-- 0239`)
--     B1 the same refusal on the key-frame line, for a film saved before this file;
--     B2/B3 the style path: the worker's own arithmetic, in SQL. The film references the take carries (refs_k, film_take_job's count)
--        leave slots = image_refs_max - refs_k when the model lists t2i in inputs.ref_capabilities, else 0; the kit and the mentioned
--        characters (creative_job_style's pictures: live, a readable image; its @name pattern on the visual prompt, at most 16 names)
--        are picked in turns exactly as creative_style.pick_references does (each character in order of mention, then the kit, a
--        picture shared by two going once); one with no description that gets none of its pictures is refused
--        `style_needs_description`, naming it and the remedy ("add a description to the style kit or character, or choose a key-frame
--        model that takes reference pictures");
--     B4 a reference character any of whose pictures is no longer live is refused reference_missing, naming it;
--     B6 more than 16 references on a key frame is refused refs_not_supported (film_take_job's own limit, whatever the model states).
--   modules/film_orchestrator.py (B5, the worker side): FilmOrchestrator._inputs counts the references film_take_job hands the take
--     against the model's image_refs_max before anything else is read or sent, and fails the take bad_request, naming the counts and
--     the remedy, before the provider call (a take failed before the vendor is charged 0, 0171). Chosen over snapshotting the references
--     at Start (a new column and a start_film change) and over a film_take_job hunk (a later file replaces film_take_job): one check
--     where the take's inputs are already in hand, failing closed. RegistryAdapter.submit's own guard stays behind it.
--   modules/film_orchestrator.py (B2, the worker side): the style kit and the @characters get only the slots the film's references
--     leave (CreativeWorker._style(..., reserved_slots=len(film refs))), so the request never exceeds image_refs_max, and the quote
--     above counts it the same way.
--   Inherited, not replaced: quote_film, start_film, film_resume_price (they call film_price), save_film, create_film_draft (they call
--   film_apply_settings and film_save_scenes), film_precheck and film_resume_precheck (start and resume re-price through film_price
--   before their hold, so they need no copy of these checks).
-- WHAT IS NOT COVERED (residuals, named):
--   * The style kit's and characters' descriptions lengthen the prompt (creative_style.compose_prompt); the worker refuses a composed
--     prompt over the model's limit after the hold. Named in 0218 and still open: this file does not compose the prompt in SQL.
--   * A kit or character changed after Start (a description cleared, pictures deleted) is read again by the worker and may still fail
--     its take after the hold (charged 0, released); the count of the film's own references is asked again by the worker (B5).
--   * film_take_job still answers input_missing for more than 16 references; the quote now refuses them first (B6).
--   * A style kit with more pictures than the slots left is sent the first of them (0048's design, unchanged): fewer kit pictures is
--     how the Studio has always steered a small model, and the quote never promised more.
-- NO BACKSLASH anywhere in this file (0219's header). White space is folded with [[:space:]]+, and film_price's one backslash (0218's
--   clip-length pattern) is written @@0239_BACKSLASH@@ and put back with chr(92) before the body is executed.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; the SQL editor on the live project). Expected: one row, all true.
--   select (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = 'public.film_price(public.films)'::regprocedure)
--            = '186d34ffb633bc56a91bbf617b0b7520' as film_price_is_0235s,
--          (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = 'public.film_apply_settings(public.films, jsonb, text[])'::regprocedure)
--            = 'f5cdf963343a4b722333eaf0d13bd840' as film_apply_settings_is_0235s,
--          (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = 'public.film_save_scenes(public.films, jsonb)'::regprocedure)
--            = 'd2d32abea21beb742eea14d92ad6e9fd' as film_save_scenes_is_0235s;
--
-- APPLY AS ONE TRANSACTION (SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1): `set local lock_timeout`
-- assumes it, and the last block asserts the end state. Idempotent: a replay finds this file's bodies and writes them again.
-- Deploy the worker (modules/film_orchestrator.py, modules/creative_worker.py) with it: the quote now counts the style slots the way the
-- new worker fills them. An old worker with this file still overflows on B2 (a film reference plus a style kit on a small model) and
-- has no B5 check: the take is refused at submit, charged 0, as before this file.
-- Rollback: docs/sql/rollback_0239_film_keyframe_refs_quote.sql (owner-applied; puts the three bodies back byte for byte).
-- Docs: docs/MIGRATIONS.md, "Film Studio: a key frame is quoted the way it is made (0239, provisional)".

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.film_check_model(text, text[], text, uuid)') is null
     or to_regprocedure('public.film_model_problem(text, text[], text, uuid)') is null then
    raise exception '0239 needs 0235_film_operator_preview.sql (the four-argument film_check_model / film_model_problem): apply it first';
  end if;
  if to_regprocedure('public.film_asset_live(uuid, uuid, text)') is null
     or to_regprocedure('public.creative_job_style(uuid, text)') is null then
    raise exception '0239 needs 0166 (film_asset_live) and 0048 / 0187 (creative_job_style, whose reading the quote mirrors): apply them first';
  end if;
end $$;

-- Each body this file replaces must be the one it was written on, or this file's own (a replay). Anything else was changed since, and
-- replacing it would silently undo that change (the 0064/0103 lesson).
do $$
declare
  r record;
  h text;
begin
  for r in
    select * from (values
      ('public.film_apply_settings(public.films, jsonb, text[])', 'f5cdf963343a4b722333eaf0d13bd840', '9a2ae594cb08df36973c7e656a7f1c9d', '0235'),
      ('public.film_save_scenes(public.films, jsonb)', 'd2d32abea21beb742eea14d92ad6e9fd', '4115ba8800b1b1a702585267d27af17c', '0235'),
      ('public.film_price(public.films)', '186d34ffb633bc56a91bbf617b0b7520', 'a3be47c473036b97121df607ffb911e2', '0235')
    ) v(sig, was, now_, src)
  loop
    select md5(regexp_replace(x.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc x where x.oid = to_regprocedure(r.sig);
    if h is null or h <> all (array[r.was, r.now_]) then
      raise exception '0239 found a % that is neither %''s body nor 0239''s (md5 %): read the live body first', r.sig, r.src, h;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Save: an edit-only model is not a key-frame model (0235's bodies, one hunk each)
-- ───────────────────────────────────────────────────────────────────────────

-- 0235's settings of a patch, with the key-frame role's own check marked 0239.
create or replace function public.film_apply_settings(p_film public.films, p_patch jsonb, p_keys text[])
  returns public.films
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  f   public.films := p_film;
  kv  record;
  v   jsonb;
  k   text;
  m   text;
  lim jsonb := public.film_limits();
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    perform public.creative_refuse('invalid_params', 'the settings must be an object');
  end if;
  for kv in select key, value from jsonb_each(p_patch) loop
    v := kv.value;
    if not kv.key = any (p_keys) then
      perform public.creative_refuse('invalid_params', format('unknown field %s', kv.key));
    end if;
    case kv.key
      when 'title' then
        f.title := public.film_text(v, 'title', 1, (lim ->> 'max_title_chars')::integer, false);
      when 'source_text' then
        f.source_text := public.film_text(v, 'source_text', 1,
          case when f.source_kind = 'topic' then (lim ->> 'max_topic_chars')::integer else (lim ->> 'max_script_chars')::integer end,
          true);
      when 'channel_id' then
        if jsonb_typeof(v) = 'null' then
          f.channel_id := null;
        elsif jsonb_typeof(v) <> 'string' or public.channel_org(v #>> '{}') is distinct from f.org_id then
          -- Another organization's channel and a channel that does not exist answer the same.
          perform public.creative_refuse('invalid_params', 'channel_id is not a channel of this organization');
        else
          f.channel_id := v #>> '{}';
        end if;
      when 'language' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('en', 'ru', 'uz') then
          perform public.creative_refuse('invalid_params', 'language must be en, ru or uz');
        end if;
        f.language := v #>> '{}';
      when 'aspect' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('16:9', '9:16', '1:1') then
          perform public.creative_refuse('invalid_params', 'aspect must be 16:9, 9:16 or 1:1');
        end if;
        f.aspect := v #>> '{}';
      when 'target_seconds' then
        if not public.creative_json_int(v, (lim ->> 'target_seconds_min')::numeric, (lim ->> 'target_seconds_max')::numeric) then
          perform public.creative_refuse('invalid_params',
            format('target_seconds must be a whole number from %s to %s', lim ->> 'target_seconds_min', lim ->> 'target_seconds_max'));
        end if;
        f.target_seconds := (v #>> '{}')::numeric::integer;
      when 'resolution' then
        if jsonb_typeof(v) = 'null' then
          f.resolution := null;
        elsif jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('480p', '720p', '768p', '1080p', '2k', '4k') then
          perform public.creative_refuse('invalid_params', 'resolution must be one of 480p, 720p, 768p, 1080p, 2k, 4k');
        else
          f.resolution := v #>> '{}';
        end if;
      when 'style_kit_id' then
        f.style_kit_id := public.film_uuid(v, 'style_kit_id');
        if f.style_kit_id is not null
           and not exists (select 1 from public.style_kits s where s.id = f.style_kit_id and s.org_id = f.org_id) then
          perform public.creative_refuse('invalid_params', 'style_kit_id is not a style kit of this organization');
        end if;
      when 'keyframe_model', 'clip_model' then
        if jsonb_typeof(v) = 'null' then
          m := null;
        elsif jsonb_typeof(v) <> 'string' then
          perform public.creative_refuse('invalid_params', format('%s must be a model id', kv.key));
        else
          m := v #>> '{}';
          if m is distinct from (case when kv.key = 'keyframe_model' then p_film.keyframe_model else p_film.clip_model end) then
            -- 0235: the film's organization, so a platform admin's operator preview in the exempt organization passes (and nobody else's).
            perform public.film_check_model(m, case when kv.key = 'keyframe_model' then array['t2i', 'edit'] else array['i2v'] end,
                                             kv.key, f.org_id);
            -- 0239: a key frame is made from words (film_take_job sends t2i and refuses a model without it), so a model on sale only
            -- for editing a picture cannot be the key-frame model: refused here, by name, never priced and then refused at the take.
            if kv.key = 'keyframe_model' and public.film_model_problem(m, array['t2i'], kv.key, f.org_id) is not null then
              perform public.creative_refuse('model_not_available',
                format('%s: %s is not on sale for making a picture from words, and a key frame is made from words; choose a key-frame model that makes a picture from words',
                       kv.key, m));
            end if;
          end if;
        end if;
        if kv.key = 'keyframe_model' then f.keyframe_model := m; else f.clip_model := m; end if;
      when 'voice' then
        if jsonb_typeof(v) = 'null' then
          f.voice := null;
        else
          if jsonb_typeof(v) <> 'object' then
            perform public.creative_refuse('invalid_params', 'voice must be an object');
          end if;
          for k in select jsonb_object_keys(v) loop
            if k not in ('source', 'model', 'voice_id') then
              perform public.creative_refuse('invalid_params', format('voice: unknown field %s', k));
            end if;
          end loop;
          if (v ->> 'source') is distinct from 'creative_tts' and (v ->> 'source') is distinct from 'channel' then
            perform public.creative_refuse('invalid_params', 'voice.source must be creative_tts or channel');
          end if;
          if v ->> 'source' = 'channel' then
            -- The channel's own configured voice: nothing else to name (the run checks it with verify_voice, rule 4).
            if v ? 'model' or v ? 'voice_id' then
              perform public.creative_refuse('invalid_params', 'voice: a channel voice takes no model or voice_id');
            end if;
          else
            if jsonb_typeof(v -> 'voice_id') is distinct from 'string' or (v ->> 'voice_id') !~ '^[A-Za-z0-9_-]{1,64}$' then
              perform public.creative_refuse('invalid_params', 'voice.voice_id must be a voice id from the list');
            end if;
            if jsonb_typeof(v -> 'model') is distinct from 'string' then
              perform public.creative_refuse('invalid_params', 'voice.model must be a model id');
            end if;
            if (v ->> 'model') is distinct from (p_film.voice ->> 'model') then
              -- 0235: the film's organization, so a platform admin's operator preview in the exempt organization passes (and nobody else's).
              perform public.film_check_model(v ->> 'model', array['tts'], 'voice.model', f.org_id);
            end if;
          end if;
          f.voice := v;
        end if;
      when 'music_asset_id' then
        f.music_asset_id := public.film_check_asset(f.org_id, v, 'audio', 'music_asset_id');
      when 'music_gain_db', 'duck_db' then
        if jsonb_typeof(v) = 'null' then
          m := null;
        elsif jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric not between -40 and 0
              or (v #>> '{}')::numeric <> round((v #>> '{}')::numeric, 1) then
          perform public.creative_refuse('invalid_params', format('%s must be a number from -40 to 0, in steps of 0.1', kv.key));
        else
          m := v #>> '{}';
        end if;
        if kv.key = 'music_gain_db' then f.music_gain_db := m::numeric; else f.duck_db := m::numeric; end if;
      when 'captions_mode' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('sidecar', 'burn', 'both', 'none') then
          perform public.creative_refuse('invalid_params', 'captions_mode must be sidecar, burn, both or none');
        end if;
        f.captions_mode := v #>> '{}';
      when 'transition_default' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('cut', 'dip_to_black', 'crossfade') then
          perform public.creative_refuse('invalid_params', 'transition_default must be cut, dip_to_black or crossfade');
        end if;
        f.transition_default := v #>> '{}';
    end case;
  end loop;
  if f.voice ->> 'source' = 'channel' and f.channel_id is null then
    perform public.creative_refuse('invalid_params', 'voice: a channel voice needs the film to have a channel');
  end if;
  return f;
end
$$;
revoke all on function public.film_apply_settings(public.films, jsonb, text[]) from public, anon, authenticated, service_role;

-- 0235's scenes of a patch, with a scene's key-frame role's own check marked 0239.
create or replace function public.film_save_scenes(p_film public.films, p_scenes jsonb) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  lim    jsonb := public.film_limits();
  r      record;
  k      text;
  ids    uuid[] := '{}';
  sid    uuid;
  sc     public.film_scenes;
  old    public.film_scenes;
  label  text;
  x      jsonb;
  m      text;
  ck     text;
  is_new boolean;
begin
  if p_scenes is null or jsonb_typeof(p_scenes) <> 'array' then
    perform public.creative_refuse('invalid_params', 'scenes must be a list');
  end if;
  if jsonb_array_length(p_scenes) > (lim ->> 'max_scenes')::integer then
    perform public.creative_refuse('limit_reached', format('a film has at most %s scenes', lim ->> 'max_scenes'));
  end if;

  -- Which existing scenes the list keeps: each named once, each this film's.
  for r in select v, ord from jsonb_array_elements(p_scenes) with ordinality as t(v, ord) loop
    label := format('scene %s', r.ord);
    if jsonb_typeof(r.v) <> 'object' then
      perform public.creative_refuse('invalid_params', format('%s must be an object', label));
    end if;
    for k in select jsonb_object_keys(r.v) loop
      if k not in ('id', 'title', 'narration', 'visual_prompt', 'negative_prompt', 'planned_seconds', 'shot_count',
                   'first_frame', 'first_frame_asset_id', 'last_frame', 'last_frame_asset_id', 'keyframe_model', 'clip_model',
                   'clip_params', 'transition_in', 'refs') then
        perform public.creative_refuse('invalid_params', format('%s: unknown field %s', label, k));
      end if;
    end loop;
    if r.v ? 'id' then
      sid := public.film_uuid(r.v -> 'id', label || ' id');
      if sid is null or not exists (select 1 from public.film_scenes s where s.id = sid and s.film_id = p_film.id) then
        perform public.creative_refuse('invalid_params', format('%s: id is not a scene of this film', label));
      end if;
      if sid = any (ids) then
        perform public.creative_refuse('invalid_params', format('%s: the same scene is listed twice', label));
      end if;
      ids := ids || sid;
    end if;
  end loop;

  -- The scenes left out are deleted (their own references with them), unless something was already made for them.
  if exists (select 1 from public.film_takes t
              where t.film_id = p_film.id and t.scene_id is not null and not (t.scene_id = any (ids))) then
    perform public.creative_refuse('scene_has_takes', 'a scene that has takes cannot be deleted', 'NS409');
  end if;
  delete from public.film_scenes where film_id = p_film.id and not (id = any (ids));

  set constraints public.film_scenes_position_key deferred;
  for r in select v, ord from jsonb_array_elements(p_scenes) with ordinality as t(v, ord) loop
    label := format('scene %s', r.ord);
    is_new := not (r.v ? 'id');
    if is_new then
      old := null;
      sc := null;
      sc.id := gen_random_uuid();
      sc.title := ''; sc.narration := ''; sc.visual_prompt := ''; sc.negative_prompt := '';
      sc.shot_count := 1; sc.first_frame := 'keyframe'; sc.last_frame := 'none';
      sc.clip_params := '{}'::jsonb; sc.status := 'draft';
      if not (r.v ? 'planned_seconds') then
        perform public.creative_refuse('invalid_params', format('%s: planned_seconds is required', label));
      end if;
    else
      select * into old from public.film_scenes where id = (r.v ->> 'id')::uuid;
      sc := old;
    end if;
    sc.position := r.ord - 1;

    if r.v ? 'title' then
      sc.title := public.film_text(r.v -> 'title', label || ' title', 0, (lim ->> 'max_title_chars')::integer, false);
    end if;
    if r.v ? 'narration' then
      sc.narration := public.film_text(r.v -> 'narration', label || ' narration', 0, (lim ->> 'max_narration_chars')::integer, true);
    end if;
    if r.v ? 'visual_prompt' then
      sc.visual_prompt := public.film_text(r.v -> 'visual_prompt', label || ' visual_prompt', 0,
                                           (lim ->> 'max_prompt_chars')::integer, true);
    end if;
    if r.v ? 'negative_prompt' then
      sc.negative_prompt := public.film_text(r.v -> 'negative_prompt', label || ' negative_prompt', 0,
                                             (lim ->> 'max_negative_chars')::integer, true);
    end if;
    if r.v ? 'planned_seconds' then
      if not public.creative_json_int(r.v -> 'planned_seconds', (lim ->> 'scene_seconds_min')::numeric,
                                      (lim ->> 'scene_seconds_max')::numeric) then
        perform public.creative_refuse('invalid_params', format('%s: planned_seconds must be a whole number from %s to %s',
                                                                label, lim ->> 'scene_seconds_min', lim ->> 'scene_seconds_max'));
      end if;
      sc.planned_seconds := (r.v ->> 'planned_seconds')::numeric::integer;
    end if;
    if r.v ? 'shot_count' then
      if not public.creative_json_int(r.v -> 'shot_count', 1, (lim ->> 'max_shots')::numeric) then
        perform public.creative_refuse('invalid_params', format('%s: shot_count must be 1 to %s', label, lim ->> 'max_shots'));
      end if;
      sc.shot_count := (r.v ->> 'shot_count')::numeric::smallint;
    end if;
    if r.v ? 'first_frame' then
      if jsonb_typeof(r.v -> 'first_frame') is distinct from 'string'
         or (r.v ->> 'first_frame') not in ('keyframe', 'asset', 'previous') then
        perform public.creative_refuse('invalid_params', format('%s: first_frame must be keyframe, asset or previous', label));
      end if;
      sc.first_frame := r.v ->> 'first_frame';
    end if;
    if r.v ? 'first_frame_asset_id' then
      sc.first_frame_asset_id := public.film_check_asset(p_film.org_id, r.v -> 'first_frame_asset_id', 'image',
                                                          label || ' first_frame_asset_id');
    end if;
    if r.v ? 'last_frame' then
      if jsonb_typeof(r.v -> 'last_frame') is distinct from 'string'
         or (r.v ->> 'last_frame') not in ('none', 'asset', 'next_keyframe') then
        perform public.creative_refuse('invalid_params', format('%s: last_frame must be none, asset or next_keyframe', label));
      end if;
      sc.last_frame := r.v ->> 'last_frame';
    end if;
    if r.v ? 'last_frame_asset_id' then
      sc.last_frame_asset_id := public.film_check_asset(p_film.org_id, r.v -> 'last_frame_asset_id', 'image',
                                                         label || ' last_frame_asset_id');
    end if;
    -- A picture is kept only while its mode uses it, so switching a scene back to `keyframe` or `none` needs no second field.
    if sc.first_frame <> 'asset' then sc.first_frame_asset_id := null; end if;
    if sc.last_frame <> 'asset' then sc.last_frame_asset_id := null; end if;
    if sc.position = 0 and sc.first_frame = 'previous' then
      perform public.creative_refuse('invalid_params', format('%s: the first scene has no previous scene to continue from', label));
    end if;
    if sc.first_frame = 'asset' and sc.first_frame_asset_id is null then
      perform public.creative_refuse('invalid_params', format('%s: first_frame asset needs first_frame_asset_id', label));
    end if;
    if sc.last_frame = 'asset' and sc.last_frame_asset_id is null then
      perform public.creative_refuse('invalid_params', format('%s: last_frame asset needs last_frame_asset_id', label));
    end if;

    foreach ck in array array['keyframe_model', 'clip_model'] loop
      if r.v ? ck then
        x := r.v -> ck;
        if jsonb_typeof(x) = 'null' then
          m := null;
        elsif jsonb_typeof(x) <> 'string' then
          perform public.creative_refuse('invalid_params', format('%s: %s must be a model id', label, ck));
        else
          m := x #>> '{}';
          if m is distinct from (case when ck = 'keyframe_model' then old.keyframe_model else old.clip_model end) then
            -- 0235: the film's organization, so a platform admin's operator preview in the exempt organization passes (and nobody else's).
            perform public.film_check_model(m, case when ck = 'keyframe_model' then array['t2i', 'edit'] else array['i2v'] end,
                                             format('%s %s', label, ck), p_film.org_id);
            -- 0239: a key frame is made from words (film_take_job sends t2i and refuses a model without it), so a model on sale only
            -- for editing a picture cannot be a scene's key-frame model: refused here, by name, never priced and then refused at the take.
            if ck = 'keyframe_model' and public.film_model_problem(m, array['t2i'], format('%s %s', label, ck), p_film.org_id) is not null then
              perform public.creative_refuse('model_not_available',
                format('%s %s: %s is not on sale for making a picture from words, and a key frame is made from words; choose a key-frame model that makes a picture from words',
                       label, ck, m));
            end if;
          end if;
        end if;
        if ck = 'keyframe_model' then sc.keyframe_model := m; else sc.clip_model := m; end if;
      end if;
    end loop;

    if r.v ? 'clip_params' then
      x := r.v -> 'clip_params';
      if jsonb_typeof(x) <> 'object' then
        perform public.creative_refuse('invalid_params', format('%s: clip_params must be an object', label));
      end if;
      for k in select jsonb_object_keys(x) loop
        -- Our narration is the soundtrack, so a clip's own audio is a choice a person makes, never a default.
        if k = 'audio' then
          if jsonb_typeof(x -> 'audio') <> 'boolean' then
            perform public.creative_refuse('invalid_params', format('%s: clip_params.audio must be true or false', label));
          end if;
        elsif k = 'resolution' then
          if jsonb_typeof(x -> 'resolution') <> 'string'
             or (x ->> 'resolution') not in ('480p', '720p', '768p', '1080p', '2k', '4k') then
            perform public.creative_refuse('invalid_params', format('%s: clip_params.resolution is not one of the resolutions', label));
          end if;
        else
          perform public.creative_refuse('invalid_params', format('%s: clip_params: unknown field %s', label, k));
        end if;
      end loop;
      sc.clip_params := x;
    end if;
    if r.v ? 'transition_in' then
      x := r.v -> 'transition_in';
      if jsonb_typeof(x) = 'null' then
        sc.transition_in := null;
      elsif jsonb_typeof(x) <> 'string' or (x #>> '{}') not in ('cut', 'dip_to_black', 'crossfade') then
        perform public.creative_refuse('invalid_params', format('%s: transition_in must be cut, dip_to_black or crossfade', label));
      else
        sc.transition_in := x #>> '{}';
      end if;
    end if;

    if is_new then
      insert into public.film_scenes (id, film_id, org_id, position, title, narration, visual_prompt, negative_prompt,
                                      planned_seconds, shot_count, first_frame, first_frame_asset_id, last_frame,
                                      last_frame_asset_id, keyframe_model, clip_model, clip_params, transition_in, status)
      values (sc.id, p_film.id, p_film.org_id, sc.position, sc.title, sc.narration, sc.visual_prompt, sc.negative_prompt,
              sc.planned_seconds, sc.shot_count, sc.first_frame, sc.first_frame_asset_id, sc.last_frame,
              sc.last_frame_asset_id, sc.keyframe_model, sc.clip_model, sc.clip_params, sc.transition_in, sc.status);
    else
      update public.film_scenes
         set position = sc.position, title = sc.title, narration = sc.narration, visual_prompt = sc.visual_prompt,
             negative_prompt = sc.negative_prompt, planned_seconds = sc.planned_seconds, shot_count = sc.shot_count,
             first_frame = sc.first_frame, first_frame_asset_id = sc.first_frame_asset_id, last_frame = sc.last_frame,
             last_frame_asset_id = sc.last_frame_asset_id, keyframe_model = sc.keyframe_model, clip_model = sc.clip_model,
             clip_params = sc.clip_params, transition_in = sc.transition_in, updated_at = now()
       where id = sc.id;
    end if;
    if r.v ? 'refs' then
      perform public.film_save_refs(p_film, sc.id, r.v -> 'refs', (lim ->> 'max_scene_refs')::integer, label || ' ref');
    end if;
  end loop;
  set constraints public.film_scenes_position_key immediate;
  return jsonb_array_length(p_scenes);
end
$$;
revoke all on function public.film_save_scenes(public.films, jsonb) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The quote: the key frame counted the way the take and the worker make it (0235's film_price, hunks marked 0239)
-- ───────────────────────────────────────────────────────────────────────────

-- Built as text with its one backslash (0218's clip-length pattern) written @@0239_BACKSLASH@@ and put back with chr(92), then executed;
-- the end state below checks the md5 of the body that results.
do $fp$
begin
  execute replace($fp0239$create or replace function public.film_price(p_film public.films) returns jsonb
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
  refs_k   integer;  -- 0239: the film references the take carries (film_take_job's own count)
  slots    integer;  -- 0239: the model's references left for the style kit's and @characters' pictures
  owners   jsonb;    -- 0239: the kit and the mentioned characters, as the worker reads them
  own      jsonb;    -- 0239
  seen     text[];   -- 0239
  got      text[];   -- 0239
  lost     text[];   -- 0239
  depth    integer;  -- 0239
  n_picked integer;  -- 0239
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
      -- 0239: the key frame is made from words (film_take_job sends t2i and refuses a model without it): a model on sale only for
      -- editing a picture is refused here, by name, before anything is held.
      if q is null and kmodel is not null
         and public.film_model_problem(kmodel, array['t2i'], label || ' keyframe_model', f.org_id) is not null then
        q := jsonb_build_object('priced', false, 'reason', 'model_not_available',
                                'detail', format('%s: %s is not on sale for making a picture from words, and a key frame is made from words; choose a key-frame model that makes a picture from words',
                                                 label, kmodel));
      end if;
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
        -- 0239 (style path): the worker (film_orchestrator._inputs, creative_worker._style) puts the film's references in front and
        -- gives the style kit's and the @characters' pictures only the slots they leave (creative_style.pick_references: in turns,
        -- each character in order of mention and then the kit, a picture shared by two going once). A kit or character with no
        -- description that gets none of its pictures would reach the model as nothing, and the worker refuses that take after the
        -- hold (rule 4): it is counted here exactly that way and refused by name. The pictures are the ones creative_job_style hands
        -- out (live, an image the vendors read), the @names its pattern finds in the visual prompt (the take's prompt), at most 16.
        refs_k := (select count(*) from public.film_refs r
                    where r.film_id = f.id and (r.scene_id is null or r.scene_id = sc.id) and r.asset_id is not null)
                  + (select count(*) from public.film_refs r
                       join public.character_references cr on cr.character_id = r.character_id and cr.org_id = r.org_id
                      where r.film_id = f.id and (r.scene_id is null or r.scene_id = sc.id) and r.character_id is not null);
        slots := case when jsonb_typeof(spec -> 'inputs' -> 'ref_capabilities') = 'array'
                           and (spec -> 'inputs' -> 'ref_capabilities') ? 't2i'
                      then greatest(ref_max - refs_k, 0) else 0 end;
        select coalesce(jsonb_agg(x.o order by x.k1, x.k2), '[]'::jsonb) into owners from (
          select 0 as k1, mn.first_at as k2,
                 jsonb_build_object('name', '@' || c.name, 'described', coalesce(c.description, '') ~ '[^[:space:]]',
                   'refs', coalesce((select jsonb_agg(a.id::text order by cr.position)
                                       from public.character_references cr join public.media_assets a on a.id = cr.asset_id
                                      where cr.character_id = c.id and cr.org_id = f.org_id and a.org_id = f.org_id
                                        and a.kind = 'image' and a.deleted_at is null and a.purged_at is null
                                        and (a.mime in ('image/jpeg', 'image/png', 'image/webp')
                                             or (a.mime in ('image/heic', 'image/heif') and 'display' = any (a.variants)))), '[]'::jsonb)) as o
            from (select lower(m.x[1]) as name, min(m.o) as first_at
                    from regexp_matches(coalesce(sc.visual_prompt, ''),
                                        '(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{2,32})(?![A-Za-z0-9_])', 'g') with ordinality as m(x, o)
                   group by lower(m.x[1]) order by min(m.o) limit 16) mn
            join public.characters c on c.name = mn.name and c.org_id = f.org_id
          union all
          select 1, 0,
                 jsonb_build_object('name', 'the style kit', 'described', coalesce(k.description, '') ~ '[^[:space:]]',
                   'refs', coalesce((select jsonb_agg(a.id::text order by kr.position)
                                       from public.style_kit_references kr join public.media_assets a on a.id = kr.asset_id
                                      where kr.kit_id = k.id and kr.org_id = f.org_id and a.org_id = f.org_id
                                        and a.kind = 'image' and a.deleted_at is null and a.purged_at is null
                                        and (a.mime in ('image/jpeg', 'image/png', 'image/webp')
                                             or (a.mime in ('image/heic', 'image/heif') and 'display' = any (a.variants)))), '[]'::jsonb))
            from public.style_kits k where k.id = f.style_kit_id and k.org_id = f.org_id) x;
        seen := '{}';
        got := '{}';
        n_picked := 0;
        depth := 0;
        while n_picked < slots
              and exists (select 1 from jsonb_array_elements(owners) e where jsonb_array_length(e -> 'refs') > depth) loop
          for own in select e from jsonb_array_elements(owners) with ordinality t(e, i) order by t.i loop
            if jsonb_array_length(own -> 'refs') > depth and n_picked < slots and not ((own -> 'refs' ->> depth) = any (seen)) then
              seen := seen || (own -> 'refs' ->> depth);
              got := got || (own ->> 'name');
              n_picked := n_picked + 1;
            end if;
          end loop;
          depth := depth + 1;
        end loop;
        select coalesce(array_agg(e ->> 'name' order by t.i), '{}') into lost
          from jsonb_array_elements(owners) with ordinality t(e, i)
         where not (e ->> 'described')::boolean and not ((e ->> 'name') = any (got));
        if refs_n > ref_max then
          q := jsonb_build_object('priced', false, 'reason', 'refs_not_supported',
                                  'detail', format('%s: %s takes %s reference pictures and this scene has %s; choose a model that takes them all or remove some',
                                                   label, kmodel, ref_max, refs_n));
        -- 0239: film_take_job sends a key frame at most 16 reference pictures, whatever the model states (the schema allows 30).
        elsif refs_k > 16 then
          q := jsonb_build_object('priced', false, 'reason', 'refs_not_supported',
                                  'detail', format('%s: a key frame carries at most 16 reference pictures and this scene has %s; remove some',
                                                   label, refs_k));
        -- 0235 (refs path): a film's key frame is made from words (film_take_job sends t2i), and an adapter sends references only on
        -- the capabilities it lists (registry inputs.ref_capabilities, checked against the adapter): one that does not list t2i would
        -- refuse this take at submit, after the hold. Not listed, or not stated at all, is refused here, before anything is held.
        elsif refs_n > 0 and not coalesce(jsonb_typeof(spec -> 'inputs' -> 'ref_capabilities') = 'array'
                                          and (spec -> 'inputs' -> 'ref_capabilities') ? 't2i', false) then
          q := jsonb_build_object('priced', false, 'reason', 'refs_not_supported',
                                  'detail', format('%s: %s does not take reference pictures for a key frame made from words; remove the reference pictures or choose a key-frame model that takes them',
                                                   label, kmodel));
        -- 0239 (style path): see above.
        elsif cardinality(lost) > 0 then
          q := jsonb_build_object('priced', false, 'reason', 'style_needs_description',
                                  'detail', format('%s: %s %s no description, and %s takes none of %s pictures for this key frame; add a description to the style kit or character, or choose a key-frame model that takes reference pictures',
                                                   label, array_to_string(lost, ' and '),
                                                   case when cardinality(lost) = 1 then 'has' else 'have' end, kmodel,
                                                   case when cardinality(lost) = 1 then 'its' else 'their' end));
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
    target := ceil(sc.planned_seconds::numeric / sc.shot_count);
    select min(x::numeric) filter (where x::numeric >= target), max(x::numeric) into dur, longest
      from jsonb_array_elements_text(case when jsonb_typeof(spec -> 'durations_s') = 'array' then spec -> 'durations_s'
                                          else '[]'::jsonb end) x
     where x ~ '^[0-9]{1,3}(@@0239_BACKSLASH@@.[0-9]+)?$';
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
  -- 0239: a character is all of its pictures (0166), and the take asks that every one is still in the library (film_take_job): a
  -- picture deleted since is refused here, by name, never priced and then refused at the take.
  if exists (select 1 from public.film_refs r
               join public.character_references cr on cr.character_id = r.character_id and cr.org_id = r.org_id
              where r.film_id = f.id and r.character_id is not null
                and not public.film_asset_live(r.org_id, cr.asset_id, 'image')) then
    refusals := refusals || jsonb_build_array(jsonb_build_object('line', 'film', 'reason', 'reference_missing',
      'detail', 'a picture of a reference character was deleted from the library; remove it from the character, or remove the character from the references'));
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
$$$fp0239$, '@@0239_BACKSLASH@@', chr(92));
end
$fp$;
revoke all on function public.film_price(public.films) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  r   record;
  fn  oid;
  got text;
begin
  for r in
    select * from (values
      ('public.film_apply_settings(public.films, jsonb, text[])', '9a2ae594cb08df36973c7e656a7f1c9d', false),
      ('public.film_save_scenes(public.films, jsonb)', '4115ba8800b1b1a702585267d27af17c', false),
      ('public.film_price(public.films)', 'a3be47c473036b97121df607ffb911e2', false)
    ) v(sig, want, service)
  loop
    fn := to_regprocedure(r.sig);
    if fn is null then
      raise exception '0239 end state: % does not exist', r.sig;
    end if;
    select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into got from pg_proc p where p.oid = fn;
    if got <> r.want then
      raise exception '0239 end state: % does not hold the expected body (md5 %)', r.sig, got;
    end if;
    -- No NULL ACL (the default includes public), no anon or authenticated, and the service role only where the worker calls it.
    if exists (select 1 from pg_proc p
                where p.oid = fn
                  and (p.proacl is null
                       or exists (select 1 from aclexplode(p.proacl) a
                                   where a.grantee = 0
                                      or a.grantee in (select o.oid from pg_roles o where o.rolname in ('anon', 'authenticated')))))
       or has_function_privilege('service_role', fn, 'EXECUTE') is distinct from r.service then
      raise exception '0239 end state: % does not have the intended grants', r.sig;
    end if;
    if not exists (select 1 from pg_proc p where p.oid = fn and p.prosecdef
                      and p.proconfig @> array['search_path=public, pg_temp']) then
      raise exception '0239 end state: % is not security definer with a pinned search_path', r.sig;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (read-only; run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
--     where oid = 'public.film_price(public.films)'::regprocedure) = 'a3be47c473036b97121df607ffb911e2' as film_price_is_0239s,
--   (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
--     where oid = 'public.film_apply_settings(public.films, jsonb, text[])'::regprocedure) = '9a2ae594cb08df36973c7e656a7f1c9d' as film_apply_settings_is_0239s,
--   (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
--     where oid = 'public.film_save_scenes(public.films, jsonb)'::regprocedure) = '4115ba8800b1b1a702585267d27af17c' as film_save_scenes_is_0239s,
--   not has_function_privilege('authenticated', 'public.film_price(public.films)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.film_price(public.films)', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.film_price(public.films)', 'EXECUTE') as grants_ok;
