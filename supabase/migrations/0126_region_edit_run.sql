-- 0126_region_edit_run.sql — Region editor, the run step: a region edit is an ordinary `edit` creative job that carries `params.regions`, priced
-- per region and settled per region. docs/REGION_EDITOR.md ("What is missing"), PR claude/region-editor-run.
--
-- *** LIVE ON APPLY. *** Merging this file applies it to the live database. It replaces THREE functions that exist there
-- (creative_params_problem, creative_quantity, finish_creative_job) and adds TWO internal ones (creative_regions_problem,
-- creative_region_outcomes). Read "WHAT TO VERIFY BEFORE YOU APPLY" below first. It rewrites no row, alters no table, trigger, policy or
-- constraint, and grants NOTHING to anon, to authenticated or to anyone who did not already hold it (the two new functions are revoked from
-- every API role; the three replaced ones keep the privileges they have). It calls no provider and moves no credit by itself.
--
-- DARK. Until something sends `regions`, every replaced function answers exactly what it answered before, for every input that has no
-- `regions` and no `region_feather` key (those two keys are the only new thing any of them reads; tests/security/test_sec_region_edit_run.py pins
-- that a request without them is judged, priced and settled as before). The Command Center sends them only from its own run route, which
-- answers 404 until the owner sets NIGHTSHIFT_REGION_EDITOR=on, and the creative worker fails a job that carries them (hold released in full,
-- nothing charged) unless the same variable is on in ITS environment. The generic /api/creative routes still refuse the keys (PARAM_KEYS).
-- A signed-in member can call create_creative_job directly with the keys, as for any creative job: the job is priced and held like any other
-- and, with the worker switch off, ends failed with the whole hold released.
--
-- NUMBER. 0126. The highest on main is 0124 (the owner model switch, merged as #612). One open pull request holds a migration: #616
-- (0125_model_shutdown.sql, renumbered from 0123 when 0124 merged); no other open pull request adds one (checked with gh api against the open
-- pull requests and their files, 2026-10-25). 0123 is unused on main. OVERLAP, checked line by line: NONE with 0124 (merged) or 0125 (#616).
-- 0124 replaced sellable_models, creative_price, advance_creative_job, api_creative_model_ok and api_creative_refusal, and #616 replaces
-- creative_price and sellable_models; this file replaces NONE of those, so it pins no stale body of theirs. creative_price,
-- create_creative_job and the API functions only CALL creative_params_problem and creative_quantity, which is why this file needs none of them
-- changed: the quote of a region edit is the ordinary quote of n units, whoever asks for it. The three bodies this file replaces are the same
-- on main after 0124 as before it (0124 does not touch them), and none of the files replaces a body another one pins, so they apply in any
-- order. If #616 merges first, this file still applies unchanged.
--
-- APPLY AS ONE TRANSACTION: the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1. `set local lock_timeout`
-- and the drift guards assume it, and the last block of this file asserts the end state, so a half-applied file cannot be left behind.
--
-- WHAT A REGION EDIT IS. A creative job of capability `edit`, exact mode, whose params are
--     {"source_asset_id": <library picture>, "quality": <the model's own tier, optional>,
--      "regions": [ {"id", "name", "rect": {"x","y","w","h"}, "prompt"} ... 1 to 5 ... ], "region_feather": 2..8 (optional)}
--   and nothing else: any other key (a prompt, a negative prompt, a seed, a shape, a style kit ...) is refused, because the worker would
--   ignore it. Each region has a unique id of a-z 0-9 _ - (1 to 32), a name (1 to 60 characters), one line of plain text for the words (1 to
--   1000 characters) and a rectangle of whole pixels (x, y from 0; w, h from 16; no side beyond 32768). Whether the rectangle lies inside THE
--   PICTURE is not decided here (the database does not read the picture's size into this check): the Command Center checks it against the
--   library's recorded size before it asks for a price, and the worker refuses a region that is outside the real picture, which costs nothing.
--   A brush bitmap per region is NOT part of this file (a `brush` key is refused): it needs the bitmap's ownership checked in
--   creative_source_problem and creative_job_source, and the editor has no brush yet.
--
-- THE MONEY (0020 / 0036 / 0075 unchanged; the rules live in finish_creative_job below)
--   * Price. creative_quantity('edit', params with regions) = the number of regions n, so the ordinary quote (creative_price, which every start
--     and every quote goes through) is n units of the model's `edit` unit, at the tier named in params, rounded up once to the cent and never
--     below the job minimum: the same arithmetic as every other creative quote. n = 1 is exactly an ordinary edit's price. For n > 1 it is
--     the price of n units (see "a difference from the sum of n separate quotes" in the pull request).
--   * Hold. create_creative_job holds that quote (0036), for the whole job, as it does for every job. A request refused before it (any
--     params problem, an unpriced model, a price above the confirmed maximum, too few credits) holds and charges nothing.
--   * Settlement. The worker reports the outcome of EVERY region (applied, failed or refused, a failed or refused one with a code from a
--     closed list: creative_region_outcomes) and finish_creative_job counts the applied ones. Each region's share of the hold is
--     quoted_credits / n. It charges applied/n of the hold, rounded UP to the cent (so never less than the exact share, at most one cent
--     more, never above the hold), and capture_credits releases the rest in the same transaction, once. All applied: the whole hold. None
--     applied: the job ends `failed` (error_code no_region_applied), result keeps the per-region outcomes, the whole hold is released,
--     nothing is charged. Finishing twice, or a retried call, changes nothing (0036's rule: a final job is returned as it is).
--   * Guards. A completed region edit must have exactly one stored result (attach_creative_job_assets, 0046) or finish_creative_job refuses:
--     nothing is charged for pixels that were never stored. The job's quantity must equal the number of regions in its params, or the job ends
--     failed (region_quote_mismatch) and the hold is released: a quote that does not match its params charges nothing. A `p_charge` that
--     does not equal what the regions make is refused; it never sets the price.
--   * Job-level endings are 0036's, untouched: a worker that gives up, a cancelled or expired job, a lost worker and a submit that was
--     interrupted all release the whole hold through creative_end_locked.
--
-- WHAT IT REPLACES (each is its latest body, character for character, plus the lines marked `-- 0126`):
--   creative_params_problem(text, jsonb)   0100's body: the keys regions and region_feather are known, refused outside an edit, checked by the
--                                          new creative_regions_problem when present, and an edit with regions needs no prompt of its own.
--   creative_quantity(text, jsonb)         0099's body: an edit with regions is priced by the number of its regions.
--   finish_creative_job(...)               0075's body (0036's plus the routed cap): the per-region settlement above.
--   NEW creative_regions_problem(jsonb)    the closed shape of regions and region_feather (immutable, no table read, no API role).
--   NEW creative_region_outcomes(jsonb, jsonb)   the closed shape of the worker's report (immutable, no API role).
-- The three replaced bodies are md5-pinned below, as 0120 / 0122 do: the file refuses to replace a body it has not seen (the 0064 / 0103 drift lesson).
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; run as the SQL editor on the live project). Each hash is md5 of the function body with every run
-- of white space read as one space. The file checks them itself and raises on any other value, but read them first:
--     select 'creative_params_problem' as fn, md5(regexp_replace(prosrc, '\s+', ' ', 'g')) as md5
--       from pg_proc where oid = 'public.creative_params_problem(text, jsonb)'::regprocedure
--     union all select 'creative_quantity', md5(regexp_replace(prosrc, '\s+', ' ', 'g'))
--       from pg_proc where oid = 'public.creative_quantity(text, jsonb)'::regprocedure
--     union all select 'finish_creative_job', md5(regexp_replace(prosrc, '\s+', ' ', 'g'))
--       from pg_proc where oid = 'public.finish_creative_job(uuid, text, boolean, numeric, jsonb, text, text)'::regprocedure;
--   expected BEFORE (0100 / 0099 / 0075 are the latest bodies; 0126 is not applied):
--     creative_params_problem   8f5525f8a44442ab477c412c3d013fee
--     creative_quantity         e6e1d85bcd4a4cde42f94546a697e352
--     finish_creative_job       37e306c9def112dd53d83d9eba0a1c49
--   and the two new names must not exist yet (expected: no row):
--     select proname from pg_proc where oid in (to_regprocedure('public.creative_regions_problem(jsonb)'),
--                                               to_regprocedure('public.creative_region_outcomes(jsonb, jsonb)'));
--   expected AFTER (the last block of this file asserts the same, inside the transaction):
--     creative_params_problem   6e815ae544cbb23d7f03845465f8ce6a
--     creative_quantity         02446e3ae600ea3504cdbea5a59829e8
--     finish_creative_job       6af709d6345f32e8eef6e9dd64d04c44
--     creative_regions_problem  5603be6af36c813d2799eb581bb971cd
--     creative_region_outcomes  193f0ef7a0aa427fd113fdceac9ea954
--   If a live value is anything else, STOP: something was applied by hand after 0100 / 0099 / 0075, and replacing the body would silently undo it.
--
-- Additive and idempotent: create or replace, revoke, grant. A second run finds the 0126 bodies and changes nothing. An applied migration is
-- never edited. Rollback: docs/sql/rollback_0126_region_edit_run.sql (refuses while a region edit is still in flight).
-- REQUIRES 0100 (creative_params_problem), 0099 (creative_quantity), 0075 (finish_creative_job, routed_credits), 0046 (result_asset_ids) and 0020.

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.creative_jobs') is null
     or to_regprocedure('public.creative_params_problem(text, jsonb)') is null
     or to_regprocedure('public.creative_quantity(text, jsonb)') is null
     or to_regprocedure('public.finish_creative_job(uuid, text, boolean, numeric, jsonb, text, text)') is null
     or to_regprocedure('public.creative_json_int(jsonb, numeric, numeric)') is null
     or to_regprocedure('public.creative_end_locked(uuid, text, text, text)') is null
     or to_regprocedure('public.creative_job_json(public.creative_jobs)') is null
     or to_regprocedure('public.credits_round_up(numeric)') is null
     or to_regprocedure('public.capture_credits(text, numeric, boolean)') is null then
    raise exception '0126 needs the creative jobs (0036 and later) and the credits (0020): apply them first';
  end if;
  if not exists (select 1 from pg_attribute
                  where attrelid = 'public.creative_jobs'::regclass and attname = 'routed_credits' and not attisdropped)
     or not exists (select 1 from pg_attribute
                     where attrelid = 'public.creative_jobs'::regclass and attname = 'result_asset_ids' and not attisdropped) then
    raise exception '0126 needs creative_jobs.routed_credits (0075) and result_asset_ids (0046): apply them first';
  end if;
  -- 0100 is the body creative_params_problem is replaced from: on an older one this file would take the video ops away.
  if position('video_remove_bg' in pg_get_functiondef('public.creative_params_problem(text, jsonb)'::regprocedure)) = 0 then
    raise exception '0126 needs 0100_video_ai_ops.sql (its creative_params_problem): apply it first';
  end if;
end $$;

-- The bodies this file replaces are replaced on what the REPO says is latest. If the live database holds another body (something applied by hand
-- since: the 0064 / 0103 drift lesson), replacing it would silently undo that change, so the file refuses. Each pair is (the latest body before
-- this file, this file's own body, which is what a replay sees); compared as md5 of prosrc with every run of white space read as one space.
-- tests/test_region_edit_run_migration.py recomputes every hash from the migration files. The two new names are checked the same way: absent, or
-- already this file's.
do $$
declare
  p text;
  q text;
  f text;
  rp text;
  ro text;
begin
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into p from pg_proc x where x.oid = 'public.creative_params_problem(text, jsonb)'::regprocedure;
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into q from pg_proc x where x.oid = 'public.creative_quantity(text, jsonb)'::regprocedure;
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into f
    from pg_proc x where x.oid = 'public.finish_creative_job(uuid, text, boolean, numeric, jsonb, text, text)'::regprocedure;
  if p is null or p <> all (array['8f5525f8a44442ab477c412c3d013fee', '6e815ae544cbb23d7f03845465f8ce6a']) then
    raise exception '0126 found a creative_params_problem() that is neither 0100''s body nor 0126''s (md5 %): read the live body first', p;
  end if;
  if q is null or q <> all (array['e6e1d85bcd4a4cde42f94546a697e352', '02446e3ae600ea3504cdbea5a59829e8']) then
    raise exception '0126 found a creative_quantity() that is neither 0099''s body nor 0126''s (md5 %): read the live body first', q;
  end if;
  if f is null or f <> all (array['37e306c9def112dd53d83d9eba0a1c49', '6af709d6345f32e8eef6e9dd64d04c44']) then
    raise exception '0126 found a finish_creative_job() that is neither 0075''s body nor 0126''s (md5 %): read the live body first', f;
  end if;
  if to_regprocedure('public.creative_regions_problem(jsonb)') is not null then
    select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into rp from pg_proc x where x.oid = 'public.creative_regions_problem(jsonb)'::regprocedure;
    if rp <> '5603be6af36c813d2799eb581bb971cd' then
      raise exception '0126 found a creative_regions_problem() that is not 0126''s body (md5 %): read the live body first', rp;
    end if;
  end if;
  if to_regprocedure('public.creative_region_outcomes(jsonb, jsonb)') is not null then
    select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into ro from pg_proc x where x.oid = 'public.creative_region_outcomes(jsonb, jsonb)'::regprocedure;
    if ro <> '193f0ef7a0aa427fd113fdceac9ea954' then
      raise exception '0126 found a creative_region_outcomes() that is not 0126''s body (md5 %): read the live body first', ro;
    end if;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The closed shapes (new, internal: no API role may call them)
-- ───────────────────────────────────────────────────────────────────────────

-- Why a region edit's params cannot be sent, or null. Called by creative_params_problem when `regions` or `region_feather` is there.
create or replace function public.creative_regions_problem(p_params jsonb)
  returns text
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  k    text;
  r    jsonb;
  c    jsonb;
  i    integer := 0;
  ids  text[] := '{}';
  -- Control characters, the Unicode line / paragraph separators (U+2028, U+2029) and NEL (U+0085): one line of plain text.
  ctl  constant text := '[[:cntrl:]' || chr(133) || chr(8232) || chr(8233) || ']';
begin
  -- A region edit takes the picture, its regions, the edge blend and the render tier (which only prices the model's own tiers) and
  -- nothing else: a setting that would be silently ignored is refused.
  for k in select jsonb_object_keys(p_params) loop
    if k not in ('source_asset_id', 'quality', 'regions', 'region_feather') then
      return format('%s does not apply to an edit with regions', k);
    end if;
  end loop;
  if p_params ? 'region_feather' and not public.creative_json_int(p_params -> 'region_feather', 2, 8) then
    return 'region_feather must be a whole number from 2 to 8';
  end if;
  if not p_params ? 'regions' then
    return 'region_feather needs regions';
  end if;
  if jsonb_typeof(p_params -> 'regions') is distinct from 'array'
     or jsonb_array_length(p_params -> 'regions') not between 1 and 5 then
    return 'regions must be a list of 1 to 5 regions';
  end if;
  for r in select x.value from jsonb_array_elements(p_params -> 'regions') x loop
    i := i + 1;
    if jsonb_typeof(r) <> 'object' then
      return format('region %s must be an object', i);
    end if;
    for k in select jsonb_object_keys(r) loop
      if k not in ('id', 'name', 'rect', 'prompt') then
        return format('region %s: unknown field %s', i, k);
      end if;
    end loop;
    if jsonb_typeof(r -> 'id') is distinct from 'string' or (r ->> 'id') !~ '^[a-z0-9][a-z0-9_-]{0,31}$' then
      return format('region %s: id must be 1 to 32 characters of a-z, 0-9, _ or -', i);
    end if;
    if (r ->> 'id') = any (ids) then
      return format('region %s: id is used twice', i);
    end if;
    ids := ids || (r ->> 'id');
    if jsonb_typeof(r -> 'name') is distinct from 'string'
       or char_length(btrim(r ->> 'name')) = 0 or char_length(r ->> 'name') > 60 or (r ->> 'name') ~ ctl then
      return format('region %s: name must be 1 to 60 characters of plain text on one line', i);
    end if;
    if jsonb_typeof(r -> 'prompt') is distinct from 'string' or char_length(btrim(r ->> 'prompt')) = 0 then
      return format('region %s: words are required', i);
    end if;
    if char_length(r ->> 'prompt') > 1000 or (r ->> 'prompt') ~ ctl then
      return format('region %s: words must be plain text on one line of at most 1000 characters', i);
    end if;
    c := r -> 'rect';
    if jsonb_typeof(c) is distinct from 'object' then
      return format('region %s: rect must be an object with x, y, w and h', i);
    end if;
    for k in select jsonb_object_keys(c) loop
      if k not in ('x', 'y', 'w', 'h') then
        return format('region %s: rect has x, y, w and h only', i);
      end if;
    end loop;
    if not public.creative_json_int(c -> 'x', 0, 32768) or not public.creative_json_int(c -> 'y', 0, 32768)
       or not public.creative_json_int(c -> 'w', 16, 32768) or not public.creative_json_int(c -> 'h', 16, 32768) then
      return format('region %s: x and y are whole pixels from 0, w and h whole pixels from 16', i);
    end if;
    if (c ->> 'x')::numeric + (c ->> 'w')::numeric > 32768 or (c ->> 'y')::numeric + (c ->> 'h')::numeric > 32768 then
      return format('region %s: the rectangle is larger than any picture', i);
    end if;
  end loop;
  return null;
end
$$;

-- Why the worker's report of a region edit cannot be taken, or the report with `regions` reduced to {id, status, code}. Raises 22023.
create or replace function public.creative_region_outcomes(p_params jsonb, p_result jsonb)
  returns jsonb
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  asked jsonb := p_params -> 'regions';
  got   jsonb;
  n     integer;
  i     integer;
  e     jsonb;
  k     text;
  st    text;
  cd    text;
  outs  jsonb := '[]'::jsonb;
  -- The reasons a region can end without being applied, as words the app translates: the vendor's own text is never stored here.
  codes constant text[] := array['not_configured', 'auth', 'quota', 'rate_limited', 'bad_request', 'policy', 'not_found',
                                 'unavailable', 'bad_response', 'provider_error', 'region_invalid', 'region_too_small',
                                 'region_out_of_bounds', 'crop_unavailable', 'pixel_lock_failed'];
begin
  if jsonb_typeof(asked) is distinct from 'array' then
    raise exception 'the job has no regions' using errcode = '22023';
  end if;
  if p_result is null or jsonb_typeof(p_result) <> 'object' or jsonb_typeof(p_result -> 'regions') is distinct from 'array' then
    raise exception 'a region edit reports the outcome of every region' using errcode = '22023';
  end if;
  got := p_result -> 'regions';
  n := jsonb_array_length(asked);
  if jsonb_array_length(got) <> n then
    raise exception 'a region edit reports exactly one outcome per region' using errcode = '22023';
  end if;
  for i in 0 .. n - 1 loop
    e := got -> i;
    if jsonb_typeof(e) <> 'object' then
      raise exception 'a region outcome is an object' using errcode = '22023';
    end if;
    for k in select jsonb_object_keys(e) loop
      if k not in ('id', 'status', 'code') then
        raise exception 'a region outcome has an id, a status and a code only' using errcode = '22023';
      end if;
    end loop;
    if (e ->> 'id') is distinct from ((asked -> i) ->> 'id') then
      raise exception 'the outcomes come in the order of the regions' using errcode = '22023';
    end if;
    if jsonb_typeof(e -> 'status') is distinct from 'string' or (e ->> 'status') not in ('applied', 'failed', 'refused') then
      raise exception 'a region is applied, failed or refused' using errcode = '22023';
    end if;
    st := e ->> 'status';
    if st = 'applied' then
      if e ? 'code' and jsonb_typeof(e -> 'code') <> 'null' then
        raise exception 'an applied region has no code' using errcode = '22023';
      end if;
      outs := outs || jsonb_build_array(jsonb_build_object('id', e ->> 'id', 'status', st));
    else
      cd := e ->> 'code';
      if jsonb_typeof(e -> 'code') is distinct from 'string' or cd <> all (codes) then
        raise exception 'a region that was not applied names one of the closed reasons' using errcode = '22023';
      end if;
      outs := outs || jsonb_build_array(jsonb_build_object('id', e ->> 'id', 'status', st, 'code', cd));
    end if;
  end loop;
  return p_result || jsonb_build_object('regions', outs);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The replaced functions (their latest bodies plus the lines marked 0126)
-- ───────────────────────────────────────────────────────────────────────────

-- 0100's creative_params_problem, plus the region keys (header).
create or replace function public.creative_params_problem(p_capability text, p_params jsonb)
  returns text
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  k        text;
  timed    boolean := p_capability in ('t2v', 'sfx', 'music', 'i2v');
  -- The voice tools and captions (0072): a recording is the whole input.
  voiced   boolean := p_capability in ('voice_change', 'dub', 'captions');
  -- The video tools (0052): a video is the whole input.
  filmed   boolean := p_capability = 'video_upscale';
  -- The video ops (0100): a library video is the input, a video the output.
  clipped  boolean := p_capability in ('video_edit', 'video_reframe', 'video_remove_bg');
  -- Their words: video_edit is asked by its prompt alone; the others take none.
  unworded boolean := p_capability in ('video_reframe', 'video_remove_bg');
  -- video_reframe: the SHAPE is the ask (expand's rule for a video).
  reframed boolean := p_capability = 'video_reframe';
  -- describe (0055): a picture is the whole input; the output is text.
  told     boolean := p_capability = 'describe';
  sourced  boolean := p_capability in ('edit', 'i2v', 'upscale', 'remove_bg', 'voice_change', 'dub',
                                       'video_upscale', 'describe', 'captions',
                                       'expand', 'relight', 'erase',
                                       'video_edit', 'video_reframe', 'video_remove_bg');
  -- The output keeps the source's shape: framing settings would be ignored.
  reshaped boolean := p_capability in ('upscale', 'remove_bg', 'video_upscale', 'relight', 'erase',
                                       'video_edit', 'video_remove_bg');
  -- expand (0099): the picture is the whole input, but its SHAPE is the ask.
  grown    boolean := p_capability = 'expand';
  prompted boolean := p_capability not in ('i2v', 'upscale', 'remove_bg', 'voice_change', 'dub', 'video_upscale',
                                           'describe', 'captions', 'expand', 'relight',
                                           'video_reframe', 'video_remove_bg');
  -- The capabilities a look can steer.
  styled   boolean := p_capability in ('t2i', 't2v', 'edit', 'i2v');
  uuid_re  constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  -- 0126: an edit that carries `regions` is a region edit (docs/REGION_EDITOR.md): its words are the regions' own.
  regioned boolean := coalesce(p_capability = 'edit' and p_params ? 'regions', false);
  problem  text;
begin
  if p_params is null or jsonb_typeof(p_params) <> 'object' then
    return 'params must be a JSON object';
  end if;
  if octet_length(p_params::text) > 16384 then
    return 'params are too large';
  end if;
  for k in select jsonb_object_keys(p_params) loop
    if k not in ('prompt', 'negative_prompt', 'aspect_ratio', 'resolution', 'duration_s',
                 'voice_id', 'seed', 'source_asset_id', 'factor', 'style_kit_id', 'target_language',
                 'target_resolution', 'end_asset_id', 'language', 'quality', 'audio', 'look',
                 -- 0126
                 'regions', 'region_feather') then
      return format('unknown parameter %s', k);
    end if;
  end loop;
  -- 0126: regions and region_feather belong to an edit and to nothing else. The closed rules (1 to 5 regions, each with an id, a
  -- name, a rectangle and words; every other parameter refused) are creative_regions_problem's.
  if p_params ? 'regions' and p_capability <> 'edit' then
    return format('regions does not apply to %s', p_capability);
  end if;
  if p_params ? 'region_feather' and p_capability <> 'edit' then
    return format('region_feather does not apply to %s', p_capability);
  end if;
  if regioned or p_params ? 'region_feather' then
    problem := public.creative_regions_problem(p_params);
    if problem is not null then
      return problem;
    end if;
  end if;
  if (p_capability = 'remove_bg' or voiced or filmed or told or unworded) and p_params ? 'prompt' then
    return format('prompt does not apply to %s', p_capability);
  end if;
  -- 0126: a region edit has no prompt of its own (creative_regions_problem refuses the key): each region carries its words.
  if (prompted and not regioned) or p_params ? 'prompt' then
    if jsonb_typeof(p_params -> 'prompt') is distinct from 'string'
       or char_length(btrim(p_params ->> 'prompt')) = 0 then
      return 'prompt is required';
    end if;
    if char_length(p_params ->> 'prompt') > 4000 then
      return 'prompt is longer than 4000 characters';
    end if;
  end if;
  if p_params ? 'negative_prompt' then
    if reshaped or grown or reframed or voiced or told then
      return format('negative_prompt does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'negative_prompt') <> 'string'
       or char_length(p_params ->> 'negative_prompt') > 2000 then
      return 'negative_prompt must be text of at most 2000 characters';
    end if;
  end if;
  if p_params ? 'aspect_ratio' then
    if reshaped then
      return format('aspect_ratio does not apply to %s: the result keeps the source''s shape', p_capability);
    end if;
    if voiced or told then
      return format('aspect_ratio does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'aspect_ratio') <> 'string'
       or (p_params ->> 'aspect_ratio') !~ '^[1-9][0-9]?:[1-9][0-9]?$' then
      return 'aspect_ratio must look like 16:9';
    end if;
  end if;
  if grown then
    -- expand (0099): required, and one shape of the closed list. The model must
    -- list it too (creative_price).
    if jsonb_typeof(p_params -> 'aspect_ratio') is distinct from 'string'
       or (p_params ->> 'aspect_ratio') not in ('16:9', '9:16', '1:1', '4:3', '3:4') then
      return 'aspect_ratio must be one of 16:9, 9:16, 1:1, 4:3, 3:4 for expand';
    end if;
  end if;
  if reframed then
    -- video_reframe (0100): required, one shape of the closed list (expand's). The
    -- model must list it too (creative_price).
    if jsonb_typeof(p_params -> 'aspect_ratio') is distinct from 'string'
       or (p_params ->> 'aspect_ratio') not in ('16:9', '9:16', '1:1', '4:3', '3:4') then
      return 'aspect_ratio must be one of 16:9, 9:16, 1:1, 4:3, 3:4 for video_reframe';
    end if;
  end if;
  if p_params ? 'resolution' then
    if filmed then
      return 'resolution does not apply to video_upscale: name the result''s size as target_resolution';
    end if;
    if reshaped or grown or reframed or voiced or told then
      return format('resolution does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'resolution') <> 'string'
       or (p_params ->> 'resolution') !~ '^(480|540|720|1080|1440|2160)p$' then
      return 'resolution must be one of 480p 540p 720p 1080p 1440p 2160p';
    end if;
  end if;
  if timed then
    if not public.creative_json_int(p_params -> 'duration_s', 1, 60) then
      return 'duration_s must be a whole number of seconds from 1 to 60';
    end if;
  elsif p_params ? 'duration_s' then
    -- The voice and video tools are priced by the file's own length (the database's).
    return format('duration_s does not apply to %s', p_capability);
  end if;
  if p_capability = 'voice_change' then
    -- Required, and a voice of the account (20 letters and digits), never a
    -- default: the person picks the voice they pay for.
    if jsonb_typeof(p_params -> 'voice_id') is distinct from 'string'
       or (p_params ->> 'voice_id') !~ '^[A-Za-z0-9]{20}$' then
      return 'voice_id (a voice of the account: 20 letters and digits) is required for voice_change';
    end if;
  elsif p_params ? 'voice_id' then
    if p_capability <> 'tts' then
      return format('voice_id does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'voice_id') <> 'string'
       or (p_params ->> 'voice_id') !~ '^[A-Za-z0-9_-]{1,64}$' then
      return 'voice_id must be 1-64 letters, digits, _ or -';
    end if;
  end if;
  if p_params ? 'seed' then
    if reshaped or grown or reframed or voiced or told then
      return format('seed does not apply to %s', p_capability);
    end if;
    if not public.creative_json_int(p_params -> 'seed', 0, 2147483647) then
      return 'seed must be a whole number from 0 to 2147483647';
    end if;
  end if;
  if sourced then
    if jsonb_typeof(p_params -> 'source_asset_id') is distinct from 'string'
       or (p_params ->> 'source_asset_id') !~ uuid_re then
      if voiced then
        return format('source_asset_id (the id of an audio or video file in the media library) is required for %s',
                      p_capability);
      end if;
      if filmed or clipped then
        return format('source_asset_id (the id of a video in the media library) is required for %s', p_capability);
      end if;
      return format('source_asset_id (the id of an image in the media library) is required for %s', p_capability);
    end if;
  elsif p_params ? 'source_asset_id' then
    return format('source_asset_id does not apply to %s', p_capability);
  end if;
  if p_capability = 'upscale' then
    -- Separate statements: the cast only ever sees a whole JSON number.
    if not public.creative_json_int(p_params -> 'factor', 2, 4) then
      return 'factor must be 2 or 4';
    end if;
    if (p_params ->> 'factor')::numeric = 3 then
      return 'factor must be 2 or 4';
    end if;
  elsif p_params ? 'factor' then
    return format('factor does not apply to %s', p_capability);
  end if;
  if filmed then
    -- The explicit allow-list (the vendor's targets); the model must list it too.
    if jsonb_typeof(p_params -> 'target_resolution') is distinct from 'string'
       or (p_params ->> 'target_resolution') not in ('720p', '1k', '2k', '4k') then
      return 'target_resolution must be one of 720p, 1k, 2k, 4k';
    end if;
  elsif p_params ? 'target_resolution' then
    return format('target_resolution does not apply to %s', p_capability);
  end if;
  if p_params ? 'end_asset_id' then
    if p_capability <> 'i2v' then
      return format('end_asset_id does not apply to %s', p_capability);
    end if;
    -- Absent means "no end frame"; a present key must name one (never null).
    if jsonb_typeof(p_params -> 'end_asset_id') is distinct from 'string'
       or (p_params ->> 'end_asset_id') !~ uuid_re then
      return 'end_asset_id must be the id of an image in the media library';
    end if;
  end if;
  if p_capability = 'dub' then
    -- The explicit allow-list: a language nobody offered is never "close enough".
    if jsonb_typeof(p_params -> 'target_language') is distinct from 'string'
       or (p_params ->> 'target_language') not in ('uz', 'ru', 'en') then
      return 'target_language must be one of uz, ru, en';
    end if;
  elsif p_params ? 'target_language' then
    return format('target_language does not apply to %s', p_capability);
  end if;
  if p_params ? 'language' then
    -- describe (0055: absent = English) and captions (0072: the language
    -- spoken in the recording; absent = the provider detects it). The
    -- explicit allow-list either way.
    if not (told or p_capability = 'captions') then
      return format('language does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'language') is distinct from 'string'
       or (p_params ->> 'language') not in ('en', 'ru', 'uz') then
      return 'language must be one of en, ru, uz';
    end if;
  end if;
  if p_params ? 'quality' then
    -- The render quality of a picture model that bills by it (0060): t2i and
    -- edit only, the explicit allow-list. Whether THIS model offers the tier
    -- (and has a price for it) is creative_price's question. Absent = medium.
    if p_capability not in ('t2i', 'edit') then
      return format('quality does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'quality') is distinct from 'string'
       or (p_params ->> 'quality') not in ('low', 'medium', 'high') then
      return 'quality must be one of low, medium, high';
    end if;
  end if;
  if p_params ? 'audio' then
    -- The soundtrack of a video (0070): t2v and i2v only, a JSON boolean.
    -- Whether THIS model offers the choice is creative_price's question.
    -- Absent = silent.
    if p_capability not in ('t2v', 'i2v') then
      return format('audio does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'audio') is distinct from 'boolean' then
      return 'audio must be true or false';
    end if;
  end if;
  if p_params ? 'look' then
    -- relight (0099): the light, from the closed list. The model must list it
    -- too (creative_price).
    if p_capability <> 'relight' then
      return format('look does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'look') is distinct from 'string'
       or (p_params ->> 'look') not in ('soft', 'warm', 'cool', 'golden_hour', 'dramatic', 'studio') then
      return 'look must be one of soft, warm, cool, golden_hour, dramatic, studio';
    end if;
  end if;
  if p_capability = 'relight' and (p_params ? 'look') = (p_params ? 'prompt') then
    -- A choice OR a short prompt, never both and never neither: what is sent
    -- to the provider is exactly one thing the person asked for.
    return 'relight takes a look or a short prompt: send exactly one of them';
  end if;
  if p_capability in ('expand', 'relight', 'erase') and p_params ? 'prompt' then
    -- Short, one line of plain text: it is a few words about the picture, not a brief.
    -- Control characters, the Unicode line / paragraph separators (U+2028, U+2029) and NEL (U+0085).
    if (p_params ->> 'prompt') ~ ('[[:cntrl:]' || chr(133) || chr(8232) || chr(8233) || ']') then
      return format('prompt must be plain text on one line for %s', p_capability);
    end if;
    if p_capability = 'erase' and char_length(p_params ->> 'prompt') > 200 then
      return 'the object to erase is named in at most 200 characters';
    end if;
    if p_capability <> 'erase' and char_length(p_params ->> 'prompt') > 300 then
      return format('prompt is longer than 300 characters for %s', p_capability);
    end if;
  end if;
  if p_capability = 'video_edit' then
    -- 0100: what to change, as a short line of plain text (prompt itself is
    -- required above, as for every capability that is asked by words).
    -- Control characters, the Unicode line / paragraph separators and NEL (as 0099's picture ops).
    if (p_params ->> 'prompt') ~ ('[[:cntrl:]' || chr(133) || chr(8232) || chr(8233) || ']') then
      return 'prompt must be plain text on one line for video_edit';
    end if;
    if char_length(p_params ->> 'prompt') > 500 then
      return 'prompt is longer than 500 characters for video_edit';
    end if;
  end if;
  if p_params ? 'style_kit_id' then
    if not styled then
      return format('style_kit_id does not apply to %s', p_capability);
    end if;
    -- Absent means "no style"; a present key must name one (never null).
    if jsonb_typeof(p_params -> 'style_kit_id') is distinct from 'string'
       or (p_params ->> 'style_kit_id') !~ uuid_re then
      return 'style_kit_id must be the id of a style kit';
    end if;
  end if;
  return null;
end
$$;

-- 0099's creative_quantity, plus the region count.
create or replace function public.creative_quantity(p_capability text, p_params jsonb) returns numeric
  language sql immutable set search_path = public, pg_temp as $$
  select case
    -- 0126: a region edit is one edit by the model per region (1 to 5: creative_regions_problem), priced like any other quantity.
    when p_capability = 'edit' and jsonb_typeof(p_params -> 'regions') = 'array' then jsonb_array_length(p_params -> 'regions')::numeric
    when p_capability in ('t2i', 'edit', 'remove_bg') then 1::numeric
    when p_capability in ('t2v', 'sfx', 'music', 'i2v') then (p_params ->> 'duration_s')::numeric
    when p_capability = 'tts' then char_length(p_params ->> 'prompt')::numeric
    when p_capability = 'upscale' then power((p_params ->> 'factor')::numeric / 2, 2)
    when p_capability = 'describe' then 1::numeric
    -- 0099: one picture in, one picture out, whatever the shape or the light.
    when p_capability in ('expand', 'relight', 'erase') then 1::numeric
  end
$$;

-- 0075's finish_creative_job (0036's plus the routed cap), plus the per-region settlement.
create or replace function public.finish_creative_job(
  p_job uuid, p_worker text, p_ok boolean,
  p_charge numeric default null, p_result jsonb default null,
  p_error_code text default null, p_error text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  j       public.creative_jobs;
  w       text := left(btrim(coalesce(p_worker, '')), 120);
  charge  numeric;
  charged numeric := 0;
  code    text;
  -- 0126: a region edit is settled per region (below).
  n_regions integer;
  n_applied integer;
begin
  if not public.credits_trusted_caller() then
    raise exception 'creative jobs are finished by the platform''s worker only' using errcode = '42501';
  end if;
  select * into j from public.creative_jobs where id = p_job;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform public.credit_account_lock(j.org_id);
  select * into j from public.creative_jobs where id = p_job for update;
  if j.status in ('completed', 'failed', 'cancelled', 'expired') then
    return public.creative_job_json(j);
  end if;
  if j.worker_id is distinct from w then
    raise exception 'this creative job belongs to another worker' using errcode = '42501';
  end if;

  if not coalesce(p_ok, false) then
    code := case when coalesce(p_error_code, '') ~ '^[a-z0-9_]{1,64}$' then p_error_code
                 else 'provider_error' end;
    perform public.creative_end_locked(p_job, 'failed', code, coalesce(p_error, code));
    select * into j from public.creative_jobs where id = p_job;
    return public.creative_job_json(j);
  end if;

  if j.provider_task_id is null then
    raise exception 'a completed job needs its provider task id' using errcode = '22023';
  end if;
  if p_result is not null and (jsonb_typeof(p_result) <> 'object' or octet_length(p_result::text) > 16384) then
    raise exception 'result must be a JSON object of at most 16 KB' using errcode = '22023';
  end if;
  -- 0126: a region edit (an edit with params.regions) is charged by its regions. The hold is the price of n regions (creative_quantity = n,
  -- held at create); each region's share is quoted_credits / n. The worker reports the outcome of EVERY region (applied, failed or refused,
  -- with a closed code: creative_region_outcomes); the database counts the applied ones and charges their shares, rounded up to the cent
  -- like every amount, never above the hold. A region that failed or was refused is not charged: its share is released by capture_credits
  -- below, in this transaction, once. No region applied: the job ends failed, the whole hold released, nothing charged. A charge the worker
  -- names must be the one the regions make; it is never what sets the price.
  if j.capability = 'edit' and jsonb_typeof(j.params -> 'regions') = 'array' then
    n_regions := jsonb_array_length(j.params -> 'regions');
    if j.quantity is distinct from n_regions then
      -- The hold was made for another number of regions than these params carry: nothing is charged on a quote that does not match.
      perform public.creative_end_locked(p_job, 'failed', 'region_quote_mismatch',
        'the held quote is not the price of these regions; nothing was charged');
      select * into j from public.creative_jobs where id = p_job;
      return public.creative_job_json(j);
    end if;
    p_result := public.creative_region_outcomes(j.params, p_result);
    select count(*) into n_applied from jsonb_array_elements(p_result -> 'regions') o where o ->> 'status' = 'applied';
    if n_applied = 0 then
      update public.creative_jobs set result = p_result, updated_at = now() where id = p_job;
      perform public.creative_end_locked(p_job, 'failed', 'no_region_applied',
        'no region could be applied; nothing was charged');
      select * into j from public.creative_jobs where id = p_job;
      return public.creative_job_json(j);
    end if;
    -- Charging for pixels that were never stored would be charging for nothing.
    if cardinality(j.result_asset_ids) <> 1 then
      raise exception 'a region edit with applied regions has exactly one stored result' using errcode = '22023';
    end if;
    if p_charge is not null
       and public.credits_round_up(p_charge) is distinct from public.credits_round_up(j.quoted_credits * n_applied / n_regions) then
      raise exception 'a region edit is charged by its applied regions, not by the worker' using errcode = '22023';
    end if;
    p_charge := j.quoted_credits * n_applied / n_regions;
  end if;
  charge := public.credits_round_up(coalesce(p_charge, j.quoted_credits));
  -- 0075: a routed job is charged at most the price of the model that made
  -- it (after a failover, a model that may cost less than the hold).
  if j.routed_credits is not null and charge > j.routed_credits then
    charge := j.routed_credits;
  end if;
  if charge < 0 or charge > j.quoted_credits then
    raise exception 'a charge of % is not within the hold of %', charge, j.quoted_credits
      using errcode = '22023';
  end if;
  if j.payer = 'credits' and j.credit_ref is not null
     and exists (select 1 from public.credit_reservations where job_id = j.credit_ref) then
    -- 0 when the hold is no longer open (it expired): the job still completes,
    -- and what was charged is what the ledger says.
    charged := coalesce(public.capture_credits(j.credit_ref, charge, false), 0);
  end if;
  update public.creative_jobs
     set status = 'completed', charged_credits = charged, result = p_result,
         error_code = null, error = null, worker_id = null,
         finished_at = now(), updated_at = now()
   where id = p_job
  returning * into j;
  perform public.creative_job_log(p_job, j.org_id, 'completed', 'completed',
    jsonb_build_object('charged', charged));
  return public.creative_job_json(j);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Privileges: nothing new for any API role
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.creative_regions_problem(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_region_outcomes(jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_params_problem(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_quantity(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.finish_creative_job(uuid, text, boolean, numeric, jsonb, text, text) from public, anon, authenticated, service_role;
grant execute on function public.finish_creative_job(uuid, text, boolean, numeric, jsonb, text, text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
-- If any of this is false the whole file rolls back (apply as one transaction). It restates the pins above and tries the rules on sample params.
do $$
declare
  src constant text := '00000000-0000-4000-8000-000000000000';
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.creative_params_problem(text, jsonb)'::regprocedure) <> '6e815ae544cbb23d7f03845465f8ce6a'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.creative_quantity(text, jsonb)'::regprocedure) <> '02446e3ae600ea3504cdbea5a59829e8'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.finish_creative_job(uuid, text, boolean, numeric, jsonb, text, text)'::regprocedure) <> '6af709d6345f32e8eef6e9dd64d04c44'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.creative_regions_problem(jsonb)'::regprocedure) <> '5603be6af36c813d2799eb581bb971cd'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.creative_region_outcomes(jsonb, jsonb)'::regprocedure) <> '193f0ef7a0aa427fd113fdceac9ea954' then
    raise exception '0126 end state: a replaced or new function does not hold this file''s body';
  end if;
  if has_function_privilege('anon', 'public.creative_regions_problem(jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.creative_regions_problem(jsonb)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.creative_regions_problem(jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.creative_region_outcomes(jsonb, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.creative_region_outcomes(jsonb, jsonb)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.creative_region_outcomes(jsonb, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.finish_creative_job(uuid, text, boolean, numeric, jsonb, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.finish_creative_job(uuid, text, boolean, numeric, jsonb, text, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.finish_creative_job(uuid, text, boolean, numeric, jsonb, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.creative_params_problem(text, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.creative_params_problem(text, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.creative_quantity(text, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.creative_quantity(text, jsonb)', 'EXECUTE') then
    raise exception '0126 end state: a function is executable by a role it must not be';
  end if;
  if public.creative_params_problem('edit', jsonb_build_object('source_asset_id', src, 'regions', jsonb_build_array(
       jsonb_build_object('id', 'r1', 'name', 'Sky', 'prompt', 'make it dusk', 'rect', jsonb_build_object('x', 0, 'y', 0, 'w', 64, 'h', 64))))) is not null
     or public.creative_params_problem('edit', jsonb_build_object('source_asset_id', src, 'prompt', 'x')) is not null
     or public.creative_params_problem('t2i', jsonb_build_object('prompt', 'x', 'regions', '[]'::jsonb)) is null
     or public.creative_params_problem('edit', jsonb_build_object('source_asset_id', src, 'regions', '[]'::jsonb)) is null
     or public.creative_params_problem('edit', jsonb_build_object('source_asset_id', src, 'prompt', 'x', 'regions', jsonb_build_array(
       jsonb_build_object('id', 'r1', 'name', 'Sky', 'prompt', 'make it dusk', 'rect', jsonb_build_object('x', 0, 'y', 0, 'w', 64, 'h', 64))))) is null then
    raise exception '0126 end state: creative_params_problem does not judge a region edit as designed';
  end if;
  if public.creative_quantity('edit', jsonb_build_object('regions', jsonb_build_array('{}'::jsonb, '{}'::jsonb, '{}'::jsonb))) <> 3
     or public.creative_quantity('edit', jsonb_build_object('prompt', 'x')) <> 1 then
    raise exception '0126 end state: creative_quantity does not count the regions of a region edit';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor on the live project after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     public.creative_quantity('edit', '{"regions":[{},{}]}') = 2 and public.creative_quantity('edit', '{"prompt":"x"}') = 1 as quantity_counts_regions,
--     public.creative_params_problem('edit', '{"source_asset_id":"00000000-0000-4000-8000-000000000000","prompt":"x","regions":[]}') is not null as regions_need_their_own_words,
--     public.creative_params_problem('t2i', '{"prompt":"x","regions":[]}') is not null as regions_only_on_edit,
--     not has_function_privilege('anon', 'public.creative_regions_problem(jsonb)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.creative_region_outcomes(jsonb,jsonb)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.finish_creative_job(uuid,text,boolean,numeric,jsonb,text,text)', 'EXECUTE') as no_new_door;
--
-- Region edits made so far (expected: none until the owner switches NIGHTSHIFT_REGION_EDITOR on):
--   select id, status, quoted_credits, charged_credits, error_code from public.creative_jobs where params ? 'regions' order by created_at desc limit 20;
