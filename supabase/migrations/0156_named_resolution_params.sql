-- 0156_named_resolution_params.sql — a request may name a model's own resolution (768p, 2k, 4k ...), and such a name is sold only at
-- that resolution's own price.
--
-- *** LIVE ON APPLY. *** Merging this file applies it to the live database. It replaces TWO functions that exist there and adds nothing:
-- creative_params_problem (0126's body plus one hunk) and creative_price (0153's body plus one hunk). It writes no row, alters no table,
-- policy or constraint, and grants nothing: both stay revoked from every API role.
--
-- THE EVIDENCE (live database, 2026-11-13). A t2v job for minimax-h3-max or minimax-h3 with params {"resolution": "768p", ...} is refused
-- at quote and at create with `NS400 invalid_params: resolution must be one of 480p 540p 720p 1080p 1440p 2160p`, raised by
-- creative_params_problem (called by creative_price before any model is read). The same request without `resolution` is quoted, and the job
-- is stored with resolution 768p (0070 writes the model's pinned default_resolution into the job). The model's credit unit is
-- model_minimax_h3_max_second_768p, and the registry prices MiniMax H3 by resolution variants {"768p", "2k"}.
--
-- THE DIAGNOSIS. creative_params_problem's resolution check is a closed list of six names from 0036's day, unchanged through 0126 (the
-- latest body). 0070 added the model's own list (spec.resolutions, checked in creative_price: "does not offer") and 0149 priced an
-- operator preview by the quoted resolution's figure, but neither touched the closed list, so every name outside it (768p, 2k, 4k, 360p)
-- is refused before the model is read: MiniMax H3's 768p and 2k, Vidu Q4's 2k and 4k, LTX's and Gemini Omni's 4k, Gemini Omni's 360p.
-- 0149 knew it and left it (tests/security/test_sec_preview_price_by_resolution.py pinned it as a strict xfail; docs/MIGRATIONS.md "Known
-- gap"). The Studio is not involved: it sends no `resolution` for t2v or i2v at all (command-center/lib/creative/studio.ts buildParams),
-- so it always gets the pinned default; the refusal is met by the creative API routes (they check the keys, not the values) and the
-- CLI (--resolution), which pass the name through. The worker side already speaks these names (modules/capabilities/minimax.py "768p" -> "768P", "2k" -> "2K"; vidu.py;
-- ltx.py), so nothing outside the database changes.
--
-- THE RULE.
--   * creative_params_problem: `resolution` is a string of the registry's own resolution shape, ^([0-9]{3,4}p|[24]k)$, the pattern of
--     schemas/model_registry.schema.json (tests/test_named_resolution_params_migration.py pins that the two agree). Lower case only:
--     "768P" or "2K" is refused, never read as 768p or 2k. Every name accepted before is accepted still (480p 540p 720p 1080p 1440p 2160p
--     all fit the shape), and every other answer of the function is 0126's.
--   * creative_price, unchanged from 0153 for every name accepted before: a name the model does not list is refused `invalid_params`
--     ("does not offer", 0070, unchanged and before this hunk), and a listed one is priced by 0070's video settings: on a model priced by
--     resolution that pins a default_resolution, by the variant's own unit model_<id>_<unit>_<resolution> (its credit_prices row; for 0139's
--     operator preview, 0149's figure variants.prices[<resolution>]); none of its own = `unpriced`, never another resolution's row or figure.
--   * creative_price, the ONE new hunk: a name creative_params_problem refused before 0156 is sold ONLY at its own variant's price. When
--     the settings above did not price the quote by a resolution variant (a model with one flat price; a model priced by resolution that
--     pins no default and so is sold by its base row, as 0070 sells Veo 3.1 whose 4k costs the vendor more than that row's 720p/1080p
--     figure; a capability with no resolution variants at all), such a name is refused before any rate is read: `unpriced` for t2v and
--     i2v ("is not sold at 4k yet"), `invalid_params` for any other capability ("does not offer"). Widening what a request may NAME never
--     widens what a base row SELLS. Every quote that names no resolution, or one of the six, is answered exactly as 0153 answers it.
-- Nothing goes on sale because of this file: it writes no credit_prices row and changes no availability. Today the names it opens are
-- reachable only where a variant price exists: MiniMax H3 (and H3 Lite / Highspeed / Max) for the operator's preview (0139 / 0149),
-- and any other model once the owner sets the variant's credit_prices row.
--
-- THE HUNKS (tests/test_named_resolution_params_migration.py undoes each one and compares the rest with 0126's and 0153's bodies byte for
-- byte):
--   creative_params_problem   the resolution test: the closed list of six becomes the registry's shape, and the refusal names the fix
--   creative_price            after 0070's video settings, before any rate is read: the refusal above
--
-- LOCKS AND GRANTS: unchanged. Both functions take no lock (immutable and stable) and stay revoked from public, anon, authenticated and
-- service_role.
--
-- NUMBER AND ORDER. 0156 (main ends at 0153; 0154 and 0155 are held by open branches, claude/custom-amount-credits and
-- claude/ideogram-shapes). It is written on 0126's creative_params_problem and on 0153's creative_price, so it REFUSES to apply without them,
-- and its drift guards accept only those bodies or its own. 0126's and 0153's replays and rollbacks refuse any other body: run
-- docs/sql/rollback_0156_named_resolution_params.sql FIRST (the security lab does: sec_db.take_off_0156, called by take_off_0153). If
-- another open branch replaces creative_price or creative_params_problem and merges first, this file's guard refuses its body: rebase this
-- file on that body (the hunks are small) rather than accepting both.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; the SQL editor on the live project). Expected: one row, all true.
--   select (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--            where oid = 'public.creative_params_problem(text, jsonb)'::regprocedure) = '6e815ae544cbb23d7f03845465f8ce6a' as params_is_0126s,
--          (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--            where oid = 'public.creative_price(uuid, text, text, jsonb)'::regprocedure) = '28130a014027e6ad0b7876a78d69a396' as price_is_0153s;
--
-- APPLY AS ONE TRANSACTION (SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1): `set local lock_timeout`
-- assumes it, and the last block asserts the end state. Additive and idempotent: create or replace, then revoke; a replay finds this file's
-- bodies and changes nothing.
-- Rollback: docs/sql/rollback_0156_named_resolution_params.sql (owner-applied; refuses a body that is neither 0156's nor the one it was
-- written on; puts 0126's creative_params_problem and 0153's creative_price back byte for byte). Docs: docs/MIGRATIONS.md, "A model's own
-- resolution names (0156)".

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.creative_params_problem(text, jsonb)') is null
     or to_regprocedure('public.creative_price(uuid, text, text, jsonb)') is null
     or to_regprocedure('public.creative_regions_problem(jsonb)') is null
     or to_regprocedure('public.creative_operator_preview(uuid, text, jsonb)') is null
     or to_regprocedure('public.model_past_shutdown(jsonb)') is null
     or to_regprocedure('public.model_is_available(text)') is null then
    raise exception '0156 needs 0126_region_edit_run.sql and 0153_preview_price_by_quality.sql (and 0149, 0139, 0125, 0124): apply them first';
  end if;
end $$;

-- The live bodies must be the ones this file was written on, or this file's own (a replay). Anything else was changed since (by hand, or by
-- a migration this file has not seen), and replacing it would silently undo that change (the 0064/0103 lesson). md5 of prosrc with every
-- run of white space read as one space; the test recomputes every hash from the files.
do $$
declare
  p text;
  c text;
begin
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into p from pg_proc x where x.oid = 'public.creative_params_problem(text, jsonb)'::regprocedure;
  if p is null or p <> all (array['6e815ae544cbb23d7f03845465f8ce6a', '25ee9cc62a27ad3a19e71008b04f3f36']) then
    raise exception '0156 found a creative_params_problem() that is neither 0126''s body nor 0156''s (md5 %): read the live body first', p;
  end if;
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into c from pg_proc x where x.oid = 'public.creative_price(uuid, text, text, jsonb)'::regprocedure;
  if c is null or c <> all (array['28130a014027e6ad0b7876a78d69a396', 'bcd99f06a87c0ac580a0afe1b81a63ff']) then
    raise exception '0156 found a creative_price() that is neither 0153''s body nor 0156''s (md5 %): read the live body first (0153 must be applied before 0156)', c;
  end if;
end $$;

-- 0126's params check with the registry's resolution shape (the first hunk in the header).
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
    -- 0156: the shape of a resolution name in the registry (the resolution pattern of schemas/model_registry.schema.json), so a model's own
    -- names (MiniMax H3's 768p and 2k, Vidu's 2k, LTX's 4k ...) reach creative_price. There a name the model does not list is refused
    -- (0070), and a name this list did not take before 0156 is sold only at its own variant's price (0156).
    if jsonb_typeof(p_params -> 'resolution') <> 'string'
       or (p_params ->> 'resolution') !~ '^([0-9]{3,4}p|[24]k)$' then
      return 'resolution must be a resolution the model lists (such as 720p, 768p, 1080p, 2k or 4k)';
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

revoke all on function public.creative_params_problem(text, jsonb) from public, anon, authenticated, service_role;

-- 0153's quote with a newly accepted resolution name sold only at its own variant's price (the second hunk in the header).
create or replace function public.creative_price(
  p_org uuid, p_capability text, p_model text, p_params jsonb
) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  cap     text := lower(btrim(coalesce(p_capability, '')));
  mdl     text := lower(btrim(coalesce(p_model, '')));
  problem text;
  m_unit  text;
  m_ent   text;
  m_spec  jsonb;
  m_found boolean := false;
  rate    public.credit_prices;
  floor_c numeric;
  qty     numeric;
  price   numeric;
  minimum numeric := 0;
  longest numeric;
  tier    text;
  vby     text;
  vres    text;
  vaud    text;
  variant jsonb := '{}'::jsonb;
  -- 0139: whether this quote is an operator preview (see creative_operator_preview).
  m_avail text;
  preview boolean := false;
  -- 0149: the vendor's figure for exactly the setting a preview is quoted at, and that figure as a number.
  vusd    jsonb;
  vcost   numeric;
begin
  if cap !~ '^[a-z][a-z0-9_]{0,31}$' then
    perform public.creative_refuse('invalid_params', 'capability is required');
  end if;
  if not public.creative_capability_supported(cap) then
    perform public.creative_refuse('capability_not_supported',
      format('%s cannot be generated yet on this deployment', cap));
  end if;
  if mdl !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then
    perform public.creative_refuse('invalid_params', 'model is required');
  end if;
  problem := public.creative_params_problem(cap, p_params);
  if problem is not null then
    perform public.creative_refuse('invalid_params', problem);
  end if;
  -- The input picture, recording or video (and an end frame) must be this
  -- organization's, live, and usable.
  problem := public.creative_source_problem(p_org, cap, p_params);
  if problem is not null then
    perform public.creative_refuse('source_unavailable', problem);
  end if;
  -- The style kit must be this organization's.
  problem := public.creative_style_problem(p_org, cap, p_params);
  if problem is not null then
    perform public.creative_refuse('style_unavailable', problem);
  end if;

  -- Never "allow every model" when the registry is not there (see 0036).
  if to_regclass('public.model_registry') is null then
    perform public.creative_refuse('registry_missing',
      'the model registry (migration 0035) is not applied on this deployment');
  end if;
  select true, r.credit_unit, r.entitlement, r.spec, r.availability
    into m_found, m_unit, m_ent, m_spec, m_avail
    from public.model_registry r
   where r.id = mdl
     -- 0139: or a hidden model the registry marks operator_preview, for a platform admin in the operator's own credits-exempt
     -- organization only (creative_operator_preview). Everyone else is answered exactly as before: model_not_sellable.
     and (r.availability in ('beta', 'ga') or public.creative_operator_preview(p_org, r.availability, r.spec))
     and r.verified_at is not null
     -- 0125: the same date, so a model named directly is not quoted either.
     and not public.model_past_shutdown(r.spec)
     and cap = any (r.capabilities);
  if not coalesce(m_found, false) then
    perform public.creative_refuse('model_not_sellable',
      format('%s is not available for %s', mdl, cap));
  end if;
  -- 0139: a model that is not beta or ga got here only through creative_operator_preview.
  preview := m_avail not in ('beta', 'ga');
  -- 0124: the owner temporarily switched this model (or its provider) off. Refused before anything is priced, held or charged,
  -- and never answered with another model: the person chooses. model_is_available is TRUE for every model until the switches
  -- are put in force.
  if not public.model_is_available(mdl) then
    perform public.creative_refuse('model_temporarily_off',
      format('%s is temporarily unavailable', mdl));
  end if;
  -- 0139: a plan entitlement is what a customer's plan buys; the operator's own organization has no plan, and its preview is not a sale.
  if not preview and coalesce(m_ent, 'any') not in ('any', 'paid') then
    perform public.creative_refuse('entitlement_required',
      format('%s needs the %s entitlement', mdl, m_ent));
  end if;
  if m_ent = 'paid' and not public.credits_exempt(p_org)
     and not exists (select 1 from public.credit_transactions t
                      where t.org_id = p_org and t.kind = 'purchase') then
    perform public.creative_refuse('entitlement_required',
      format('%s is available after the organization''s first credit purchase', mdl));
  end if;
  -- A factor the model was not proven (and priced) for is not sold.
  if cap = 'upscale'
     and not coalesce(jsonb_typeof(m_spec -> 'upscale_factors') = 'array'
                      and (m_spec -> 'upscale_factors') @> (p_params -> 'factor'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer a %sx upscale', mdl, p_params ->> 'factor'));
  end if;
  -- Nor a language the model was not proven (and listed) for.
  if cap = 'dub'
     and not coalesce(jsonb_typeof(m_spec -> 'languages') = 'array'
                      and (m_spec -> 'languages') @> jsonb_build_array(p_params ->> 'target_language'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not dub into %s', mdl, p_params ->> 'target_language'));
  end if;
  -- Nor a spoken language the model was not proven (and listed) for. No
  -- language at all is allowed: the provider detects it.
  if cap = 'captions' and p_params ? 'language'
     and not coalesce(jsonb_typeof(m_spec -> 'languages') = 'array'
                      and (m_spec -> 'languages') @> jsonb_build_array(p_params ->> 'language'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not transcribe %s', mdl, p_params ->> 'language'));
  end if;
  -- Nor a video target the model was not proven (and listed) for.
  if cap = 'video_upscale'
     and not coalesce(jsonb_typeof(m_spec -> 'upscale_targets') = 'array'
                      and (m_spec -> 'upscale_targets') @> jsonb_build_array(p_params ->> 'target_resolution'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not upscale a video to %s', mdl, p_params ->> 'target_resolution'));
  end if;
  -- 0099: nor a shape to extend a picture to, or a light, that the model was
  -- not proven (and listed) for. A free prompt for a relight needs no list.
  if cap = 'expand'
     and not coalesce(jsonb_typeof(m_spec -> 'aspect_ratios_by_capability' -> 'expand') = 'array'
                      and (m_spec -> 'aspect_ratios_by_capability' -> 'expand') @> jsonb_build_array(p_params ->> 'aspect_ratio'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not extend a picture to %s', mdl, p_params ->> 'aspect_ratio'));
  end if;
  if cap = 'relight' and p_params ? 'look'
     and not coalesce(jsonb_typeof(m_spec -> 'relight_looks') = 'array'
                      and (m_spec -> 'relight_looks') @> jsonb_build_array(p_params ->> 'look'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer the %s light', mdl, p_params ->> 'look'));
  end if;
  -- 0100: nor a shape to reframe a video to that the model was not proven (and
  -- listed) for.
  if cap = 'video_reframe'
     and not coalesce(jsonb_typeof(m_spec -> 'aspect_ratios_by_capability' -> 'video_reframe') = 'array'
                      and (m_spec -> 'aspect_ratios_by_capability' -> 'video_reframe') @> jsonb_build_array(p_params ->> 'aspect_ratio'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not reframe a video to %s', mdl, p_params ->> 'aspect_ratio'));
  end if;
  -- Nor an ending on a model that would drop it.
  if p_params ? 'end_asset_id' and coalesce(m_spec -> 'end_frame', 'false'::jsonb) <> 'true'::jsonb then
    perform public.creative_refuse('invalid_params',
      format('%s cannot end a clip on a chosen picture', mdl));
  end if;

  -- A quality the model does not offer is refused, never ignored: the
  -- provider would bill its own default under the quoted price (0060).
  if p_params ? 'quality'
     and not coalesce(jsonb_typeof(m_spec -> 'qualities') = 'array'
                      and (m_spec -> 'qualities') @> jsonb_build_array(p_params ->> 'quality'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer the %s quality', mdl, p_params ->> 'quality'));
  end if;

  -- One price per target when the registry prices the targets apart
  -- (model_registry.credit_unit_for): a target without its own row is
  -- unpriced, never sold at another target's rate.
  if cap = 'video_upscale' and m_unit is not null
     and m_spec -> 'pricing' -> 'variants' ->> 'by' = 'upscale_target' then
    m_unit := m_unit || '_' || regexp_replace(lower(p_params ->> 'target_resolution'), '[^a-z0-9]', '_', 'g');
  end if;
  -- One price per quality tier when the registry prices the tiers apart
  -- (model_registry.credit_unit_for: model_<id>_<unit>_<tier>). No tier named
  -- = medium, the same tier the worker sends; a tier without its own row is
  -- unpriced, never sold at another tier's rate and never at 0.
  if cap in ('t2i', 'edit') and m_unit is not null
     and m_spec -> 'pricing' -> 'variants' ->> 'by' = 'quality' then
    tier := coalesce(p_params ->> 'quality', 'medium');
    if not coalesce(jsonb_typeof(m_spec -> 'qualities') = 'array'
                    and (m_spec -> 'qualities') @> jsonb_build_array(tier), false) then
      perform public.creative_refuse('invalid_params',
        format('%s does not offer the %s quality', mdl, tier));
    end if;
    m_unit := m_unit || '_' || regexp_replace(lower(tier), '[^a-z0-9]', '_', 'g');
  end if;
  -- The video settings (0070).
  if cap in ('t2v', 'i2v') then
    vby := m_spec -> 'pricing' -> 'variants' ->> 'by';
    -- A resolution the model does not list is refused, never ignored: the
    -- vendor would render (and bill) something else under the quoted price.
    if p_params ? 'resolution'
       and not coalesce(jsonb_typeof(m_spec -> 'resolutions') = 'array'
                        and (m_spec -> 'resolutions') @> jsonb_build_array(p_params ->> 'resolution'), false) then
      perform public.creative_refuse('invalid_params',
        format('%s does not offer %s', mdl, p_params ->> 'resolution'));
    end if;
    -- A soundtrack choice only on a model that prices it apart (the worker
    -- sends the flag for no other), and only if it makes sound at all.
    if p_params ? 'audio'
       and (coalesce(vby, '') not in ('audio', 'resolution_audio')
            or coalesce(m_spec -> 'audio_out', 'false'::jsonb) <> 'true'::jsonb) then
      perform public.creative_refuse('invalid_params',
        format('%s does not offer a choice of sound', mdl));
    end if;
    -- One price per setting when the registry prices the settings apart
    -- (model_registry.credit_unit_for: model_<id>_<unit>_<resolution>_<silent|audio>).
    -- No resolution named = the model's pinned one and no audio = silent, the
    -- same the worker sends. A resolution variant counts only for a model that
    -- pins one (Veo and Wan 3.0 are still sold by their base row). A setting
    -- without its own row is unpriced, never another setting's rate, never 0.
    if m_unit is not null
       and (coalesce(vby, '') in ('audio', 'resolution_audio')
            or (coalesce(vby, '') = 'resolution' and nullif(m_spec ->> 'default_resolution', '') is not null)) then
      if vby in ('resolution', 'resolution_audio') then
        vres := coalesce(p_params ->> 'resolution', nullif(m_spec ->> 'default_resolution', ''));
        if vres is null then
          perform public.creative_refuse('unpriced',
            format('%s has no credit price yet; a platform admin sets it on the Credits page', mdl));
        end if;
      end if;
      if vby in ('audio', 'resolution_audio') then
        vaud := case when coalesce((p_params ->> 'audio')::boolean, false) then 'audio' else 'silent' end;
      end if;
      m_unit := m_unit || '_' || regexp_replace(lower(concat_ws('_', vres, vaud)), '[^a-z0-9]', '_', 'g');
      variant := jsonb_strip_nulls(jsonb_build_object(
        'resolution', vres, 'audio', case when vaud is null then null else vaud = 'audio' end));
    end if;
  end if;
  -- 0156: creative_params_problem now takes every resolution name the registry can list, and the video settings above refused one the
  -- model does not list. A name it refused before 0156 (anything but 480p 540p 720p 1080p 1440p 2160p) is sold ONLY at its own
  -- variant's price, the unit model_<id>_<unit>_<resolution> the settings above chose: never by a base row whose figure was read for
  -- another resolution (Veo 3.1 pins no resolution, so 0070 sells it by its base row, and its 4k costs the vendor more), never at one
  -- flat price, never on a capability that has no resolution variants. Refused before any rate is read, the preview's included.
  if p_params ? 'resolution' and (p_params ->> 'resolution') !~ '^(480|540|720|1080|1440|2160)p$'
     and not (variant ? 'resolution') then
    if cap not in ('t2v', 'i2v') then
      perform public.creative_refuse('invalid_params', format('%s does not offer %s', mdl, p_params ->> 'resolution'));
    end if;
    perform public.creative_refuse('unpriced',
      format('%s is not sold at %s yet: that resolution has no price of its own', mdl, p_params ->> 'resolution'));
  end if;
  if m_unit is not null then
    select * into rate from public.credit_prices where unit = m_unit;
  end if;
  -- 0139: a preview with no credit price is priced at the vendor's own cost (1 credit = 1 US cent, the convention of
  -- docs/sql/prices_2026_10_01.sql, no margin) from the reviewed registry figure, for the job's record only: the exempt
  -- organization holds and pays nothing (reserve_credits answers exempt). No credit_prices row is written, so nothing goes on
  -- sale. A figure the registry does not state stays unpriced.
  -- 0149: the figure is the one for exactly what is quoted. A model without variants states one (provider_usd_per_unit). A
  -- model priced by resolution states one per resolution (pricing.variants.prices), and the figure is vres's: the resolution the
  -- video settings above settled on (the request's, else the model's pinned default_resolution), which the job then carries and
  -- the worker sends. A resolution without its own figure is unpriced: never another resolution's figure, never
  -- provider_usd_per_unit. Any other variants.by (audio, resolution_audio, upscale_target ...) stays unpriced.
  -- 0153: a model priced by quality states one figure per tier (pricing.variants.prices), and the figure is tier's: the tier the
  -- quality settings above settled on (the request's, else medium when it names none), the one the quote names, the job carries and
  -- the worker sends. A tier without its own figure is unpriced: never another tier's figure, never provider_usd_per_unit.
  if preview and m_unit is not null and rate.unit is null
     and jsonb_typeof(m_spec -> 'pricing') = 'object' then
    vusd := case
              when not (m_spec -> 'pricing' ? 'variants') then m_spec -> 'pricing' -> 'provider_usd_per_unit'
              when m_spec -> 'pricing' -> 'variants' ->> 'by' = 'resolution' and vres is not null
                then m_spec -> 'pricing' -> 'variants' -> 'prices' -> vres
              when m_spec -> 'pricing' -> 'variants' ->> 'by' = 'quality' and tier is not null
                then m_spec -> 'pricing' -> 'variants' -> 'prices' -> tier
            end;
    -- A figure that is not a JSON number is never cast: the CASE decides the order, not an `and`.
    vcost := case when jsonb_typeof(vusd) = 'number' then (vusd #>> '{}')::numeric end;
    if vcost > 0 and vcost <= 100 then
      rate.unit := m_unit;
      rate.credits_per_unit := vcost * 100;
      rate.margin := 0;
    end if;
  end if;
  if m_unit is null or rate.unit is null then
    perform public.creative_refuse('unpriced',
      format('%s has no credit price yet; a platform admin sets it on the Credits page', mdl));
  end if;

  if cap in ('voice_change', 'dub', 'video_upscale', 'captions', 'video_edit', 'video_reframe', 'video_remove_bg') then
    -- The file's measured length, from the database — never the client's.
    qty := public.creative_source_seconds(p_org, p_params);
  else
    qty := public.creative_quantity(cap, p_params);
  end if;
  if qty is null or qty <= 0 then
    -- Unknown is never priced as 0 (CLAUDE.md #5).
    perform public.creative_refuse('source_unavailable', 'the length of the source is not known, so it cannot be priced');
  end if;
  if cap = 'video_upscale' then
    -- The vendor's longest input, as the registry states it: a model that
    -- states none is not sold a length it may refuse after the hold.
    longest := case when jsonb_typeof(m_spec -> 'limits' -> 'max_source_seconds') = 'number'
                    then (m_spec -> 'limits' ->> 'max_source_seconds')::numeric end;
    if longest is null or longest <= 0 then
      perform public.creative_refuse('model_not_sellable',
        format('%s does not state the longest video it takes', mdl));
    end if;
    if qty > longest then
      perform public.creative_refuse('source_unavailable',
        format('this model upscales videos of up to %s seconds; trim this one first', longest));
    end if;
  end if;
  if cap in ('video_edit', 'video_reframe', 'video_remove_bg') then
    -- 0100: the same rule as the upscale's, in the video ops' own words: a model
    -- that states no longest input is not sold a length it may refuse after the hold.
    longest := case when jsonb_typeof(m_spec -> 'limits' -> 'max_source_seconds') = 'number'
                    then (m_spec -> 'limits' ->> 'max_source_seconds')::numeric end;
    if longest is null or longest <= 0 then
      perform public.creative_refuse('model_not_sellable',
        format('%s does not state the longest video it takes', mdl));
    end if;
    if qty > longest then
      perform public.creative_refuse('source_unavailable',
        format('this model takes videos of up to %s seconds; trim this one first', longest));
    end if;
  end if;
  -- Rounded to 6 places before the upward cent, so numeric division noise
  -- never adds a cent (0030 does the same).
  price := public.credits_round_up(round(qty * rate.credits_per_unit * (1 + rate.margin), 6));
  select credits_per_unit into floor_c from public.credit_prices where unit = 'job_minimum';
  if floor_c is not null then
    minimum := public.credits_round_up(floor_c);
  end if;
  if price > 0 then
    price := greatest(price, minimum);
  end if;

  return jsonb_build_object(
    'credits', price, 'exempt', public.credits_exempt(p_org),
    'model', mdl, 'capability', cap, 'unit', rate.unit, 'quantity', qty,
    -- 0084: the rate as charged, never the platform's base rate and margin
    -- apart (every quote, the API's and the routed ones included).
    'credits_per_unit', rate.credits_per_unit * (1 + rate.margin), 'minimum', minimum)
    -- The tier this price is for, so what the person confirms names it.
    || case when tier is null then '{}'::jsonb else jsonb_build_object('quality', tier) end
    -- The resolution and soundtrack this price is for (0070).
    || variant
    -- 0139: a preview says so, and the Studio shows it as the operator's record, never as a price on sale.
    || case when preview then jsonb_build_object('preview', true) else '{}'::jsonb end;
end
$$;

revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  pp  oid := 'public.creative_params_problem(text, jsonb)'::regprocedure;
  cp  oid := 'public.creative_price(uuid, text, text, jsonb)'::regprocedure;
  def text;
  got text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into got from pg_proc p where p.oid = pp;
  if got <> '25ee9cc62a27ad3a19e71008b04f3f36' then
    raise exception '0156 end state: creative_params_problem does not hold this file''s body (md5 %)', got;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into got from pg_proc p where p.oid = cp;
  if got <> 'bcd99f06a87c0ac580a0afe1b81a63ff' then
    raise exception '0156 end state: creative_price does not hold this file''s body (md5 %)', got;
  end if;
  -- No API role at all. A NULL ACL would mean "default privileges", and the default includes public.
  if exists (select 1 from pg_proc p
              where p.oid in (pp, cp)
                and (p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a
                                 where a.grantee = 0
                                    or a.grantee in (select o.oid from pg_roles o
                                                      where o.rolname in ('anon', 'authenticated', 'service_role'))))) then
    raise exception '0156 end state: creative_params_problem or creative_price is executable by a role that must not call it';
  end if;
  if (select count(*) from pg_proc p where p.oid in (pp, cp) and p.proconfig @> array['search_path=public, pg_temp']) <> 2 then
    raise exception '0156 end state: creative_params_problem or creative_price has no pinned search_path';
  end if;
  if (select provolatile from pg_proc where oid = pp) <> 'i' or (select provolatile from pg_proc where oid = cp) <> 's'
     or not (select prosecdef from pg_proc where oid = cp) then
    raise exception '0156 end state: a function changed its volatility or security';
  end if;
  -- The guards every creative_price keeps (0124's switch, 0125's date) and the preview reached only through 0139's rule.
  def := pg_get_functiondef(cp);
  if position('model_is_available' in def) = 0 or position('model_past_shutdown' in def) = 0
     or position('creative_operator_preview' in def) = 0 then
    raise exception '0156 end state: creative_price lost a guard';
  end if;
  -- What this file is about, read back from the functions themselves: a model's own names pass the params check, a wrong case and an
  -- unknown shape do not, and every name accepted before still is.
  if public.creative_params_problem('t2v', '{"prompt": "x", "duration_s": 4, "resolution": "768p"}'::jsonb) is not null
     or public.creative_params_problem('t2v', '{"prompt": "x", "duration_s": 4, "resolution": "2k"}'::jsonb) is not null
     or public.creative_params_problem('t2v', '{"prompt": "x", "duration_s": 4, "resolution": "2160p"}'::jsonb) is not null
     or public.creative_params_problem('t2v', '{"prompt": "x", "duration_s": 4, "resolution": "2K"}'::jsonb) is null
     or public.creative_params_problem('t2v', '{"prompt": "x", "duration_s": 4, "resolution": "8k"}'::jsonb) is null
     or public.creative_params_problem('t2v', '{"prompt": "x", "duration_s": 4, "resolution": "768"}'::jsonb) is null then
    raise exception '0156 end state: creative_params_problem does not judge resolution names as this file says';
  end if;
  -- Nothing is on sale because of this file: it writes no price and changes no availability.
  if exists (select 1 from public.model_registry where availability in ('beta', 'ga') and coalesce(spec ->> 'terms_gate', '') <> '') then
    raise exception '0156 end state: a terms-gated model is on sale';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.creative_params_problem(text,jsonb)'::regprocedure) = '25ee9cc62a27ad3a19e71008b04f3f36' as params_is_0156s,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.creative_price(uuid,text,text,jsonb)'::regprocedure) = 'bcd99f06a87c0ac580a0afe1b81a63ff' as creative_price_is_0156s,
--   not has_function_privilege('authenticated', 'public.creative_price(uuid,text,text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.creative_price(uuid,text,text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.creative_params_problem(text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.creative_params_problem(text,jsonb)', 'EXECUTE') as functions_scoped,
--   not exists (select 1 from public.credit_prices where unit like 'model\_minimax\_h3%') as nothing_minimax_on_sale;
--
-- And the bug itself, as the platform operator in the credits-exempt organization (expected: a quote whose resolution is 768p and whose
-- unit is model_minimax_h3_max_second_768p, "preview": true; and 2k on minimax-h3 likewise):
--   select public.quote_creative_job('<exempt org id>', 't2v', 'minimax-h3-max',
--          '{"prompt": "a lighthouse at dawn", "duration_s": 6, "resolution": "768p"}'::jsonb);
