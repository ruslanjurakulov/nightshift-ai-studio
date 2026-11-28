-- 0241_film_scene_dialogue.sql — a film scene's own sound and its spoken lines get a saved home: film_scenes.sound_role and
-- film_scenes.dialogue, written only through save_film (film_save_scenes), and quoted only where the film can keep them.
--
-- *** LIVE ON APPLY. *** It adds two nullable columns and one check constraint to film_scenes (every existing row reads null: the
-- default role), adds four internal helpers, and replaces TWO functions that exist there: film_save_scenes (0239's body plus three
-- marked hunks) and film_price (0239's body plus two marked hunks). It writes no row and grants nothing.
--
-- ORDER: 0235 -> 0236 -> 0239 -> 0240 -> 0241. This file is written on 0239's film_price and film_save_scenes (PR #981, branch
-- claude/nsai-s2-keyframe-refs-quote, which carries 0235 (#970) and 0236 (#973); none merged when this was written) and needs 0236's
-- film_studio_settings.clip_sound_kept switch: it refuses to apply without them. 0240 (#978) touches no film function and applies
-- before this file.
--
-- EVIDENCE (the code, 2026-11-28).
--   * modules/film_timeline.py (0236's worker) gives every scene a sound role, dialogue / ambience / muted, and reads it from the
--     scene's sound_role; film_scenes had no such column, so every role was a default and no scene could be "dialogue" (the music
--     never ducked under in-clip speech, and a dialogue scene's clip was made without its lines).
--   * film_scenes has ONE visual_prompt (0166), which 0198's film_take_job sends to the key frame AND the clip. S1 (#969) therefore
--     refuses in-clip speech (command-center/lib/brain/logic.ts CLIP_PROMPT_SAVED = false): an image model told 'says: "..."' draws
--     the words.
--   * modules/film_orchestrator.without_unused_sound asks a single-price model that speaks for no sound outside a dialogue scene
--     (Atlas, 28 Nov), so with no dialogue scene possible a film could never carry in-clip speech at all.
-- DIAGNOSIS. The lines need a column of their own that reaches the clip prompt only, and the role a column the worker reads; the quote
--   must refuse what the film could not keep (BR-SG-01's rule, CLAUDE.md 4 and 6).
-- CHANGE.
--   film_scenes.sound_role   NEW text, null = the default (0236's rule: ambience when a take bought the priced sound, else muted).
--                            'dialogue' | 'ambience' | 'muted' (film_scenes_sound_check).
--   film_scenes.dialogue     NEW jsonb, null or a list of 1 to 6 lines {speaker, line, lang}, lang 'uz' | 'ru' | 'en'. Present exactly
--                            when sound_role = 'dialogue' (film_scenes_sound_check).
--                            lang is explicit per line, not the film's language: a film's language is its narration's and its
--                            captions' (0166 films.language), a character may speak another, and the line's language is what the
--                            clip prompt names and what S6's per-language probe (uz / ru / en) is measured against.
--   film_dialogue(jsonb, text)            NEW, the one parser (called by film_save_scenes): known keys only (an unknown key is never
--                                         echoed, 0218 F2); speaker and line are text, cleaned with 0166's film_clean_text (single
--                                         line) and REFUSED, not silently changed, when cleaning would change more than the outer
--                                         spaces (a line break, a control or invisible character, an unusual or repeated space); never
--                                         empty; no ASCII double quote (it would end the quoted line in the clip prompt: use « » or
--                                         single quotes); speaker at most 80 characters, line at most 300, at most 6 lines, and the
--                                         lines at most 1000 characters as the clip prompt writes them (film_dialogue_prompt).
--   film_dialogue_prompt(jsonb)           NEW, the lines as the clip prompt says them:  <speaker> says in <Uzbek|Russian|English>: "<line>"
--                                         joined by one space. modules/film_orchestrator.dialogue_prompt writes the same text (the lab
--                                         pins the two equal).
--   film_clip_prompt(text, jsonb)         NEW, a spoken scene's clip prompt: the visual prompt, a line break, then the lines.
--   film_sound_problem(text, jsonb, jsonb, text, text)  NEW, what film_price refuses about a scene's chosen role (below).
--   film_save_scenes         REPLACED on 0239's body (4115ba8800b1b1a702585267d27af17c; 0166's, then 0235's, then 0239's key-frame hunk) with three hunks, every line marked `-- 0241`:
--                            the two keys are known; sound_role and dialogue are parsed, and the merged scene is checked (lines only on a
--                            dialogue scene; a dialogue scene has lines; a dialogue scene is ONE shot, because its lines go into that
--                            shot's clip prompt and an extend would be made without them or speak them again); both columns are then
--                            written. Every refusal is creative_refuse('invalid_params', ...) with the fix in its sentence, as 0166's and 0239's are.
--   film_price               REPLACED on 0239's body (02016cc4a695a54c5693a5066247269b; 0218's, 0235's, 0236's, 0239's) with two hunks, every line marked `-- 0241`:
--                            (1) right after 0236's hunk, a scene whose sound_role is set gets film_sound_problem's refusal on each of its
--                            clip lines, carried exactly as a model problem is (priced false, total NULL), a model problem or 0236's
--                            refusal on the same scene named first:
--                              clip_sound_not_kept   a dialogue or ambience scene while film_studio_settings.clip_sound_kept is off
--                                                    (0236's word and switch: a worker that drops clip sound would drop the lines too)
--                              dialogue_needs_sound  a dialogue scene on a clip model that makes no sound (registry audio_out false),
--                                                    or on one that sells its sound apart (variants by audio / resolution_audio:
--                                                    kling-v3, seedance-1.5-pro) without the scene's sound option (clip_params.audio)
--                              ambience_not_kept     an ambience scene whose sound is not bought: a model that speaks is asked for no
--                                                    sound outside a spoken scene (Atlas, 28 Nov, S2 section 9.1 point 5), and a silent
--                                                    model has none, so the cut would refuse it as clip_without_sound after the spend
--                              sound_option_unused   a muted scene that buys the priced sound option (S2 section 9.1 point 2: never
--                                                    buy sound the film will not play)
--                            A dialogue scene on a model that speaks inside one price (Veo, H3, LTX, Seedance 2.x ...) is priced
--                            exactly as today: nothing is added to its line, and the worker asks the vendor for the sound itself.
--                            (2) a dialogue scene's clip line asks creative_price about the prompt the worker will send (film_clip_prompt),
--                            so a prompt over the model's own limit (0218: spec.limits.max_prompt_chars, UTF-16 units) is
--                            prompt_too_long at the quote, before anything is held. The line's own params (what start_film copies into
--                            the take and the quote_id hashes) leave the prompt out exactly as before.
--   Inherited, not replaced: save_film (0166: it passes the scenes to film_save_scenes), quote_film, start_film, quote_film_resume,
--   start_film_resume and film_resume_price (they re-price through film_price). film_take_job (0198) is NOT replaced: it still sends
--   the visual prompt alone, to the key frame and to the clip; the worker (modules/film_orchestrator.py, this pull request) adds the
--   lines to the CLIP prompt only, reading them through FilmRest.scenes, and asks a single-price model with a sound switch for sound
--   in a dialogue scene. The key frame never sees a line.
-- LIMITS, and where they come from (all counted in code points; the quote's prompt_too_long re-counts the composed prompt in UTF-16 units
--   against the chosen model). speaker 80 and line 300 are S1's own caps (command-center/lib/brain/logic.ts CAP.name, CAP.line), and 6
--   lines a scene is S1's (readScenario: dialogue.slice(0, 6)). 1000 for the lines as written into the prompt is half of 2000, the
--   smallest max_prompt_chars of any i2v model that makes sound (schemas/model_registry.json: Veo 3.1, Kling v3, Seedance, LTX, Grok
--   Imagine, Vidu, Gemini Omni at 2000; HappyHorse 2500; MiniMax H3 7000), so the lines alone never take more than half of the smallest
--   prompt a speaking model accepts; the scene's own visual prompt (0166: at most 2000) and the lines are then asked together.
-- WHAT A PERSON SEES. Nothing changes for a scene that sets neither key (both null). No browser writes either column directly: no API
--   role has a column privilege on them (members do not read them yet either: 0166 grants members a fixed column list, and no screen
--   shows the lines; a later pull request that adds the editor grants them on purpose).
-- OWNER STEP. None beyond 0236's: turn film_studio_settings.clip_sound_kept on only once a worker with modules/film_orchestrator.py and
--   modules/film_timeline.py from THIS pull request is deployed (0236's worker does not read the lines: a dialogue scene sold to it
--   would be made without them). Until then a dialogue or ambience scene is refused clip_sound_not_kept.
-- OVERLAP. 0235, 0236 and 0239 each replace film_price in that order, and 0235 and 0239 film_save_scenes; this file is last. A file
--   that changes either body before this one merges means rebasing these hunks onto it: the drift guard, end state and rollback name
--   the base md5, and the lab's take_off_0239 takes 0241 off first.
-- NO BACKSLASH anywhere in this file (0219's header: the live apply path once rewrote backslash escapes in SQL text). White space is
--   folded with [[:space:]]+; film_price's one backslash (0218's clip-length pattern) is written @@0241_BACKSLASH@@ and put back with
--   chr(92) before the body is executed, so the body that reaches the database is byte for byte the one hashed below; a line break is
--   chr(10).
-- REPLACES (md5 of prosrc with every run of white space read as one space):
--   film_save_scenes   0239 4115ba8800b1b1a702585267d27af17c -> 0241 50942d89b6c407fc7438fe158cdd8115
--   film_price         0239 02016cc4a695a54c5693a5066247269b -> 0241 3607297484f191d45ff9a1f63a11c5b5
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; the SQL editor on the live project). Expected: one row, all true.
--   select (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
--            where oid = 'public.film_save_scenes(public.films, jsonb)'::regprocedure) = '4115ba8800b1b1a702585267d27af17c' as save_scenes_is_0239s,
--          (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
--            where oid = 'public.film_price(public.films)'::regprocedure) = '02016cc4a695a54c5693a5066247269b' as film_price_is_0239s,
--          (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'film_studio_settings'
--            and column_name = 'clip_sound_kept') = 1 as switch_exists;
--
-- APPLY AS ONE TRANSACTION (SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1): `set local lock_timeout`
-- assumes it, and the last block asserts the end state. Idempotent: a replay finds this file's bodies and columns, and writes the same.
-- Rollback: docs/sql/rollback_0241_film_scene_dialogue.sql (owner-applied; refuses while any scene holds a sound role or lines unless
-- told to discard them; puts 0239's two bodies back byte for byte, drops the helpers, the constraint and the columns).
-- Docs: docs/MIGRATIONS.md, "A film scene's own sound and its spoken lines (0241)".

set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regclass('public.film_scenes') is null or to_regprocedure('public.film_clean_text(text, boolean)') is null
     or to_regprocedure('public.creative_refuse(text, text, text)') is null then
    raise exception '0241 needs 0166_films_core.sql: apply it first';
  end if;
  if not exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'film_studio_settings'
                    and c.column_name = 'clip_sound_kept') then
    raise exception '0241 needs 0236_film_clip_sound_gate.sql (PR #973, the clip sound switch): apply it first';
  end if;
  -- The bodies this file replaces must be 0239's, or this file's own (a replay). Anything else was changed since, and replacing it
  -- would silently undo that change (the 0064/0103 lesson); 0236's or 0235's body means 0239 is not applied yet (see ORDER).
  select md5(regexp_replace(x.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc x
   where x.oid = to_regprocedure('public.film_save_scenes(public.films, jsonb)');
  if h is null or h <> all (array['4115ba8800b1b1a702585267d27af17c', '50942d89b6c407fc7438fe158cdd8115']) then
    raise exception '0241 found a film_save_scenes() that is neither 0239''s body nor 0241''s (md5 %): apply 0239_film_keyframe_refs_quote.sql first, or read the live body', h;
  end if;
  select md5(regexp_replace(x.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc x
   where x.oid = to_regprocedure('public.film_price(public.films)');
  if h is null or h <> all (array['02016cc4a695a54c5693a5066247269b', '3607297484f191d45ff9a1f63a11c5b5']) then
    raise exception '0241 found a film_price() that is neither 0239''s body nor 0241''s (md5 %): apply 0239_film_keyframe_refs_quote.sql first, or read the live body', h;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The columns (nullable: every existing scene keeps the default role)
-- ───────────────────────────────────────────────────────────────────────────
alter table public.film_scenes add column if not exists sound_role text;
alter table public.film_scenes add column if not exists dialogue jsonb;

-- The shape only; what a line may hold is film_dialogue's, the one writer's. The shot count is checked there too, on the merged scene
-- (a table check would refuse the half-written row of a save that changes the shots and the lines together).
alter table public.film_scenes drop constraint if exists film_scenes_sound_check;
alter table public.film_scenes add constraint film_scenes_sound_check
  check ((sound_role is null or sound_role in ('dialogue', 'ambience', 'muted'))
         and (dialogue is null or (jsonb_typeof(dialogue) = 'array' and jsonb_array_length(dialogue) between 1 and 6
                                   and octet_length(dialogue::text) <= 8000))
         and ((dialogue is not null) = (sound_role is not distinct from 'dialogue')));

comment on column public.film_scenes.sound_role is
  'Migration 0241 (S2): the scene''s own sound, dialogue | ambience | muted; null = the default (modules/film_timeline.py: ambience when a take bought the priced sound, else muted). Written only by film_save_scenes.';
comment on column public.film_scenes.dialogue is
  'Migration 0241 (S2): the lines spoken in the scene''s clip, [{speaker, line, lang}], lang uz | ru | en; only on a dialogue scene. They reach the clip prompt only (modules/film_orchestrator.py), never a key frame. Written only by film_save_scenes.';

-- 0166's grants, said again for the new columns: the trusted backend reads whole rows; no API role writes a film_scenes column, and a
-- member reads only 0166's list (these two are not on it).
revoke insert, update, delete on public.film_scenes from public, anon, authenticated;
revoke all (sound_role, dialogue) on public.film_scenes from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The helpers (internal: no API role may call them)
-- ───────────────────────────────────────────────────────────────────────────

-- The lines as the clip prompt says them. modules/film_orchestrator.py dialogue_prompt writes the same text.
create or replace function public.film_dialogue_prompt(p_lines jsonb) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select string_agg(format('%s says in %s: "%s"', x.l ->> 'speaker',
                           case x.l ->> 'lang' when 'uz' then 'Uzbek' when 'ru' then 'Russian' when 'en' then 'English' end,
                           x.l ->> 'line'), ' ' order by x.o)
    from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) with ordinality x(l, o)
$$;

-- A spoken scene's clip prompt: its visual prompt, a line break, its lines. modules/film_orchestrator.py clip_prompt is the same.
create or replace function public.film_clip_prompt(p_visual text, p_lines jsonb) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select case when jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then p_visual
              when btrim(coalesce(p_visual, '')) = '' then public.film_dialogue_prompt(p_lines)
              else p_visual || chr(10) || public.film_dialogue_prompt(p_lines) end
$$;

-- The one parser of a scene's lines (film_save_scenes). Returns the stored list, or null for a JSON null (the lines removed).
create or replace function public.film_dialogue(p_v jsonb, p_label text) returns jsonb
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  r     record;
  k     text;
  f     text;
  raw   text;
  one   jsonb;
  lines jsonb := '[]'::jsonb;
  label text;
  n     integer;
begin
  if p_v is null or jsonb_typeof(p_v) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_v) <> 'array' then
    perform public.creative_refuse('invalid_params',
      format('%s: dialogue must be a list of lines {speaker, line, lang}, or null to remove them', p_label));
  end if;
  if jsonb_array_length(p_v) not between 1 and 6 then
    perform public.creative_refuse('invalid_params',
      format('%s: dialogue has %s lines and a scene has 1 to 6; send null to remove them', p_label, jsonb_array_length(p_v)));
  end if;
  for r in select v, ord from jsonb_array_elements(p_v) with ordinality as t(v, ord) loop
    label := format('%s dialogue line %s', p_label, r.ord);
    if jsonb_typeof(r.v) <> 'object' then
      perform public.creative_refuse('invalid_params', format('%s must be an object {speaker, line, lang}', label));
    end if;
    for k in select jsonb_object_keys(r.v) loop
      -- Never the key itself in the sentence (0218 F2: a caller's text read back as the server's words).
      if k not in ('speaker', 'line', 'lang') then
        perform public.creative_refuse('invalid_params', format('%s has an unknown field; a line has only speaker, line and lang', label));
      end if;
    end loop;
    one := '{}'::jsonb;
    foreach f in array array['speaker', 'line'] loop
      if jsonb_typeof(r.v -> f) is distinct from 'string' then
        perform public.creative_refuse('invalid_params', format('%s: %s is required and must be text', label, f));
      end if;
      raw := r.v ->> f;
      -- Refused, not cleaned: a line is spoken as written, and a hidden character is an instruction channel to the clip model.
      if public.film_clean_text(raw, false) <> btrim(raw, ' ') then
        perform public.creative_refuse('invalid_params',
          format('%s: %s holds a line break, a control or invisible character, or an unusual or repeated space; write it as one plain line',
                 label, f));
      end if;
      raw := btrim(raw, ' ');
      if raw = '' then
        perform public.creative_refuse('invalid_params', format('%s: %s must not be empty; write it, or remove the line', label, f));
      end if;
      n := case f when 'speaker' then 80 else 300 end;
      if char_length(raw) > n then
        perform public.creative_refuse('invalid_params',
          format('%s: %s is %s characters and at most %s fit; shorten it, or split the line in two', label, f, char_length(raw), n));
      end if;
      if position('"' in raw) > 0 then
        perform public.creative_refuse('invalid_params',
          format('%s: %s holds a double quote, which would end the quoted line in the clip prompt; use « » or single quotes', label, f));
      end if;
      one := one || jsonb_build_object(f, raw);
    end loop;
    if jsonb_typeof(r.v -> 'lang') is distinct from 'string' or (r.v ->> 'lang') not in ('uz', 'ru', 'en') then
      perform public.creative_refuse('invalid_params', format('%s: lang must be uz, ru or en, the language the line is spoken in', label));
    end if;
    lines := lines || jsonb_build_array(one || jsonb_build_object('lang', r.v ->> 'lang'));
  end loop;
  n := char_length(public.film_dialogue_prompt(lines));
  if n > 1000 then
    perform public.creative_refuse('invalid_params',
      format('%s: the lines come to %s characters in the clip prompt and at most 1000 fit; shorten or remove a line', p_label, n));
  end if;
  return lines;
end
$$;

-- What film_price refuses about a scene's chosen sound role, or null. p_spec is the clip model's registry spec.
create or replace function public.film_sound_problem(p_role text, p_clip_params jsonb, p_spec jsonb, p_model text, p_label text)
  returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p_role is null then null
    when p_role in ('dialogue', 'ambience')
         and not coalesce((select s.clip_sound_kept from public.film_studio_settings s where s.id), false) then
      jsonb_build_object('priced', false, 'reason', 'clip_sound_not_kept',
        'detail', format('%s: clip sound is not yet kept in the final film; set the scene''s sound to muted%s', p_label,
                         case when p_role = 'dialogue' then ' and remove its spoken lines' else '' end))
    when p_role = 'dialogue' and coalesce(p_spec -> 'audio_out', 'false'::jsonb) <> 'true'::jsonb then
      jsonb_build_object('priced', false, 'reason', 'dialogue_needs_sound',
        'detail', format('%s: %s makes no sound, so the scene''s lines would never be heard; choose a clip model that makes sound',
                         p_label, p_model))
    when p_role = 'dialogue' and coalesce(p_spec #>> '{pricing,variants,by}', '') in ('audio', 'resolution_audio')
         and p_clip_params -> 'audio' is distinct from 'true'::jsonb then
      jsonb_build_object('priced', false, 'reason', 'dialogue_needs_sound',
        'detail', format('%s: %s sells its sound apart and the scene''s lines need it; turn the scene''s sound option on', p_label, p_model))
    when p_role = 'ambience'
         and not (coalesce(p_spec #>> '{pricing,variants,by}', '') in ('audio', 'resolution_audio')
                  and coalesce(p_spec -> 'audio_out', 'false'::jsonb) = 'true'::jsonb
                  and p_clip_params -> 'audio' = 'true'::jsonb) then
      jsonb_build_object('priced', false, 'reason', 'ambience_not_kept',
        'detail', format('%s: only a clip whose sound was bought keeps its ambience (a model that speaks is asked for no sound outside a spoken scene); choose a clip model that sells its sound apart and turn the scene''s sound option on, or set the scene''s sound to muted',
                         p_label))
    when p_role = 'muted' and p_clip_params -> 'audio' = 'true'::jsonb then
      jsonb_build_object('priced', false, 'reason', 'sound_option_unused',
        'detail', format('%s: the scene''s sound is muted, so its sound option would be paid for and never heard; turn the sound option off',
                         p_label))
  end
$$;

revoke all on function public.film_dialogue_prompt(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.film_clip_prompt(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.film_dialogue(jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.film_sound_problem(text, jsonb, jsonb, text, text) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. film_save_scenes: 0239's body plus the three hunks marked -- 0241
-- ───────────────────────────────────────────────────────────────────────────
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
      continue when k in ('sound_role', 'dialogue');  -- 0241
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

    -- 0241: the scene's own sound and its spoken lines (S2, docs/studio/S2_CLIP_AUDIO.md section 7); this is their only writer.
    if r.v ? 'sound_role' then  -- 0241
      x := r.v -> 'sound_role';  -- 0241
      if jsonb_typeof(x) <> 'null' and (jsonb_typeof(x) <> 'string' or (x #>> '{}') not in ('dialogue', 'ambience', 'muted')) then  -- 0241
        perform public.creative_refuse('invalid_params', format('%s: sound_role must be dialogue, ambience, muted, or null for the default', label));  -- 0241
      end if;  -- 0241
      sc.sound_role := x #>> '{}';  -- 0241
    end if;  -- 0241
    if r.v ? 'dialogue' then  -- 0241
      sc.dialogue := public.film_dialogue(r.v -> 'dialogue', label);  -- 0241
    end if;  -- 0241
    if sc.dialogue is not null and sc.sound_role is distinct from 'dialogue' then  -- 0241
      perform public.creative_refuse('invalid_params', format('%s: spoken lines are kept only on a scene whose sound_role is dialogue; set sound_role to dialogue, or send dialogue null to remove the lines', label));  -- 0241
    end if;  -- 0241
    if sc.sound_role = 'dialogue' and sc.dialogue is null then  -- 0241
      perform public.creative_refuse('invalid_params', format('%s: a dialogue scene needs its lines; send dialogue with 1 to 6 lines, or set sound_role to ambience, muted or null', label));  -- 0241
    end if;  -- 0241
    if sc.sound_role = 'dialogue' and sc.shot_count <> 1 then  -- 0241
      perform public.creative_refuse('invalid_params', format('%s: a spoken scene is one shot (its lines go into that shot''s clip prompt); set shot_count to 1, or split the scene into one scene a shot', label));  -- 0241
    end if;  -- 0241
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
    if r.v ? 'sound_role' or r.v ? 'dialogue' then  -- 0241
      update public.film_scenes set sound_role = sc.sound_role, dialogue = sc.dialogue where id = sc.id;  -- 0241
    end if;  -- 0241
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
-- 4. film_price: 0239's body plus the two hunks marked -- 0241
-- ───────────────────────────────────────────────────────────────────────────
-- Built as text with its one backslash written @@0241_BACKSLASH@@ and put back with chr(92) (see the header), then executed; the end
-- state below checks the md5 of the body that results.
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
    -- 0236: while the cut drops a clip's own sound (BR-SG-01), the priced sound option is refused by name, not sold to be dropped.
    if bad is null and sc.clip_params -> 'audio' = 'true'::jsonb  -- 0236
       and not coalesce((select s.clip_sound_kept from public.film_studio_settings s where s.id), false) then  -- 0236
      bad := jsonb_build_object('priced', false, 'reason', 'clip_sound_not_kept',  -- 0236
                                'detail', format('%s: clip sound is not yet kept in the final film; turn the scene''s sound option off', label));  -- 0236
    end if;  -- 0236
    -- 0241: a scene's own sound role (S2) is sold only where the film can keep it; the sentence names the fix (film_sound_problem).
    if bad is null and cmodel is not null and sc.sound_role is not null then  -- 0241
      bad := public.film_sound_problem(sc.sound_role, sc.clip_params, spec, cmodel, label);  -- 0241
    end if;  -- 0241
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
        -- 0241: a spoken scene's clip prompt carries its lines (film_clip_prompt), so the model's own limit is asked about those words.
        if sc.sound_role = 'dialogue' then  -- 0241
          params := params || jsonb_build_object('prompt', public.film_clip_prompt(sc.visual_prompt, sc.dialogue));  -- 0241
        end if;  -- 0241
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
$$$fp0241$, '@@0241_BACKSLASH@@', chr(92));
end
$fp$;
revoke all on function public.film_price(public.films) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  got text;
  fn  text;
  r   text;
begin
  select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into got from pg_proc p
   where p.oid = 'public.film_save_scenes(public.films, jsonb)'::regprocedure;
  if got <> '50942d89b6c407fc7438fe158cdd8115' then
    raise exception '0241 end state: film_save_scenes does not hold this file''s body (md5 %)', got;
  end if;
  select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into got from pg_proc p
   where p.oid = 'public.film_price(public.films)'::regprocedure;
  if got <> '3607297484f191d45ff9a1f63a11c5b5' then
    raise exception '0241 end state: film_price does not hold this file''s body (md5 %)', got;
  end if;
  foreach fn in array array['public.film_save_scenes(public.films, jsonb)', 'public.film_price(public.films)',
                            'public.film_sound_problem(text, jsonb, jsonb, text, text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = fn::regprocedure and p.prosecdef
                      and p.proconfig @> array['search_path=public, pg_temp']) then
      raise exception '0241 end state: % is not security definer with a pinned search_path', fn;
    end if;
  end loop;
  foreach fn in array array['public.film_save_scenes(public.films, jsonb)', 'public.film_price(public.films)',
                            'public.film_sound_problem(text, jsonb, jsonb, text, text)', 'public.film_dialogue(jsonb, text)',
                            'public.film_dialogue_prompt(jsonb)', 'public.film_clip_prompt(text, jsonb)'] loop
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(r, fn, 'EXECUTE') then
        raise exception '0241 end state: % is executable by %', fn, r;
      end if;
    end loop;
    if exists (select 1 from pg_proc p where p.oid = fn::regprocedure
                  and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))) then
      raise exception '0241 end state: % is executable by PUBLIC', fn;
    end if;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if has_column_privilege(r, 'public.film_scenes', 'sound_role', 'SELECT') or has_column_privilege(r, 'public.film_scenes', 'sound_role', 'UPDATE')
       or has_column_privilege(r, 'public.film_scenes', 'sound_role', 'INSERT') or has_column_privilege(r, 'public.film_scenes', 'dialogue', 'SELECT')
       or has_column_privilege(r, 'public.film_scenes', 'dialogue', 'UPDATE') or has_column_privilege(r, 'public.film_scenes', 'dialogue', 'INSERT') then
      raise exception '0241 end state: % can read or write film_scenes.sound_role or dialogue', r;
    end if;
  end loop;
  if (select count(*) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'film_scenes'
        and ((c.column_name = 'sound_role' and c.data_type = 'text') or (c.column_name = 'dialogue' and c.data_type = 'jsonb'))
        and c.is_nullable = 'YES' and c.column_default is null) <> 2 then
    raise exception '0241 end state: film_scenes.sound_role (text) and dialogue (jsonb) are not both nullable with no default';
  end if;
  if not exists (select 1 from pg_constraint c where c.conrelid = 'public.film_scenes'::regclass and c.conname = 'film_scenes_sound_check'
                    and c.contype = 'c' and c.convalidated) then
    raise exception '0241 end state: film_scenes_sound_check is missing';
  end if;
  if public.film_clip_prompt('A kitchen at dawn.', '[{"speaker": "Aziz", "line": "Salom, dada!", "lang": "uz"}, {"speaker": "Dad", "line": "Hi.", "lang": "en"}]'::jsonb)
     <> 'A kitchen at dawn.' || chr(10) || 'Aziz says in Uzbek: "Salom, dada!" Dad says in English: "Hi."'
     or public.film_clip_prompt('A kitchen at dawn.', null) <> 'A kitchen at dawn.' then
    raise exception '0241 end state: film_clip_prompt does not write the lines as modules/film_orchestrator.py does';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
--     where oid = 'public.film_save_scenes(public.films, jsonb)'::regprocedure) = '50942d89b6c407fc7438fe158cdd8115' as save_scenes_is_0241s,
--   (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
--     where oid = 'public.film_price(public.films)'::regprocedure) = '3607297484f191d45ff9a1f63a11c5b5' as film_price_is_0241s,
--   (select count(*) from public.film_scenes where sound_role is not null or dialogue is not null) = 0 as no_scene_has_a_role_yet,
--   not has_column_privilege('authenticated', 'public.film_scenes', 'dialogue', 'SELECT')
--     and not has_column_privilege('authenticated', 'public.film_scenes', 'dialogue', 'UPDATE')
--     and not has_column_privilege('anon', 'public.film_scenes', 'dialogue', 'SELECT') as lines_not_api_readable_or_writable,
--   not has_function_privilege('authenticated', 'public.film_dialogue(jsonb, text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.film_sound_problem(text, jsonb, jsonb, text, text)', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.film_price(public.films)', 'EXECUTE') as helpers_internal,
--   (select clip_sound_kept from public.film_studio_settings where id) as clip_sound_kept_turned_on_by_the_owner;
