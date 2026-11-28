-- rollback_0241_film_scene_dialogue.sql — takes migration 0241 (a film scene's own sound and its spoken lines) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor, as one transaction. Nothing in the app runs it. Idempotent.
--
-- WHAT COMES BACK: 0166's film_save_scenes, verbatim (md5 c836631256f669318c9ef499d7c4c54b, white space folded): sound_role and dialogue are unknown
--   fields again. And 0236's film_price, verbatim (b873f893f3f185b3eab3698d349f3379): no scene has a sound role to refuse, and a clip prompt is the
--   visual prompt alone again.
-- WHAT GOES: film_scenes.sound_role and film_scenes.dialogue (their values with them), film_scenes_sound_check, and the helpers
--   film_dialogue, film_dialogue_prompt, film_clip_prompt and film_sound_problem.
-- WHAT IT DOES: 0. REFUSES (changes nothing) if film_save_scenes is neither 0241's body nor 0166's, or film_price neither 0241's nor
--   0236's (a later file changed it: take that out first); and while any scene holds a sound role or lines, unless this is set first,
--   in the same transaction, by someone who means to throw them away:
--     set local nightshift.rollback_0241_discard_sound = 'on';
--   1. Puts 0166's and 0236's bodies back. 2. Drops the helpers, the constraint and the columns. 3. Asserts the end state.
-- A worker running modules/film_orchestrator.py from 0241's pull request reads both columns (FilmRest.scenes): roll that worker back
--   too, or its scene read is refused by PostgREST (an unknown column) and no film take begins.
-- No backslash anywhere in this file (0219's header): 0236's one backslash is written @@0241_BACKSLASH@@ and put back with chr(92).

begin;
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p
   where p.oid = to_regprocedure('public.film_save_scenes(public.films, jsonb)');
  if h is null or h <> all (array['5d6e6eebe280645e6c5ef186dc48629a', 'c836631256f669318c9ef499d7c4c54b']) then
    raise exception 'rollback 0241: film_save_scenes is neither 0241''s body nor 0166''s (md5 %): read it first', h;
  end if;
  select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p
   where p.oid = to_regprocedure('public.film_price(public.films)');
  if h is null or h <> all (array['81e7a2dd0701068508e2663b495683cb', 'b873f893f3f185b3eab3698d349f3379']) then
    raise exception 'rollback 0241: film_price is neither 0241''s body nor 0236''s (md5 %): read it first', h;
  end if;
  if exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'film_scenes'
                and c.column_name = 'dialogue')
     and coalesce(current_setting('nightshift.rollback_0241_discard_sound', true), '') <> 'on' then
    execute 'select count(*) from public.film_scenes where sound_role is not null or dialogue is not null' into h;
    if h::integer > 0 then
      raise exception 'rollback 0241: % scene(s) hold a sound role or spoken lines, which this would delete: set local nightshift.rollback_0241_discard_sound = ''on'' first if you mean to', h;
    end if;
  end if;
end $$;

-- 0166's body.
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
            perform public.film_check_model(m, case when ck = 'keyframe_model' then array['t2i', 'edit'] else array['i2v'] end,
                                             format('%s %s', label, ck));
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

-- 0236's body.
do $fp$
begin
  execute replace($fp0241$create or replace function public.film_price(p_film public.films) returns jsonb
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
                  -- 0218: the negative prompt the take carries (0198), so the quote asks whether this model takes one.
                  || case when btrim(sc.negative_prompt) <> '' then jsonb_build_object('negative_prompt', sc.negative_prompt)
                          else '{}'::jsonb end
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
    bad := case when cmodel is not null then public.film_model_problem(cmodel, array['i2v'], label || ' clip_model') end;
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
     where x ~ '^[0-9]{1,3}(@@0241_BACKSLASH@@.[0-9]+)?$';
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
      q := coalesce(public.film_model_problem(f.voice ->> 'model', array['tts'], 'voice.model'),
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
$$;$fp0241$, '@@0241_BACKSLASH@@', chr(92));
end
$fp$;
revoke all on function public.film_price(public.films) from public, anon, authenticated, service_role;

drop function if exists public.film_sound_problem(text, jsonb, jsonb, text, text);
drop function if exists public.film_dialogue(jsonb, text);
drop function if exists public.film_clip_prompt(text, jsonb);
drop function if exists public.film_dialogue_prompt(jsonb);
alter table public.film_scenes drop constraint if exists film_scenes_sound_check;
alter table public.film_scenes drop column if exists dialogue;
alter table public.film_scenes drop column if exists sound_role;

do $$
declare
  got text;
begin
  select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into got from pg_proc p
   where p.oid = 'public.film_save_scenes(public.films, jsonb)'::regprocedure;
  if got <> 'c836631256f669318c9ef499d7c4c54b' then
    raise exception 'rollback 0241 end state: film_save_scenes is not 0166''s body (md5 %)', got;
  end if;
  select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into got from pg_proc p
   where p.oid = 'public.film_price(public.films)'::regprocedure;
  if got <> 'b873f893f3f185b3eab3698d349f3379' then
    raise exception 'rollback 0241 end state: film_price is not 0236''s body (md5 %)', got;
  end if;
  if exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'film_scenes'
                and c.column_name in ('sound_role', 'dialogue')) then
    raise exception 'rollback 0241 end state: film_scenes.sound_role or dialogue is still there';
  end if;
  if to_regprocedure('public.film_dialogue(jsonb, text)') is not null
     or to_regprocedure('public.film_sound_problem(text, jsonb, jsonb, text, text)') is not null
     or to_regprocedure('public.film_clip_prompt(text, jsonb)') is not null
     or to_regprocedure('public.film_dialogue_prompt(jsonb)') is not null then
    raise exception 'rollback 0241 end state: a 0241 helper is still there';
  end if;
  if has_function_privilege('anon', 'public.film_price(public.films)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.film_price(public.films)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.film_price(public.films)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.film_save_scenes(public.films, jsonb)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.film_save_scenes(public.films, jsonb)', 'EXECUTE') then
    raise exception 'rollback 0241 end state: film_price or film_save_scenes is executable by an API role';
  end if;
end $$;

commit;
