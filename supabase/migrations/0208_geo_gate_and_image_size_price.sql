-- 0208_geo_gate_and_image_size_price.sql — the database refuses a job on a model with a country list unless our web server vouches
-- for the request's country; and a picture model priced by size is quoted at the size asked for, never at one flat rate.
--
-- *** LIVE ON APPLY. *** Merging this file applies it to the live database. It changes NO answer for any model on sale today:
--   * the country gate acts only on a model whose model_registry.spec carries blocked_countries, and 0142's CHECK keeps every such model
--     off sale (beta/ga). The one change a person could see: a platform admin's operator preview (0139) of a hidden model with a list
--     needs a signed country too.
--   * image_size is a new parameter, accepted only by a model priced by size (spec.pricing.variants.by = image_size); every such row in
--     schemas/model_registry.json today has a terms_gate, so none is on sale. Every other quote is answered exactly as 0159 answers it,
--     except that a request naming image_size (refused as an unknown parameter until now) is refused with a sentence that says why.
--
-- PART A. THE COUNTRY GATE (docs/GEO_BLOCK.md "The database's own check")
-- EVIDENCE. The web routes refuse a model by country (lib/server/geo.ts), but create_creative_job (0075 / 0192), start_workflow_run
--   (0073) and advance_workflow_run (0074) are granted to `authenticated`, and the browser holds the anon key and the session: a member
--   can call them straight through PostgREST and skip every route (0142's header; docs/GEO_BLOCK.md "What it cannot do"). Google's
--   terms make its models an ALLOW-list (Gemini API Additional Terms, effective March 23, 2026: "You may only access the Services (or
--   make API Clients available to users) within an available region"), so before any Google model can open, the database itself must
--   refuse a job whose country nobody trustworthy vouched for.
-- DIAGNOSIS. The database cannot see an address. What it can see is the HTTP request's headers (PostgREST writes them to
--   request.headers for the transaction, as 0101's review links read them). A member can send any header, so a header is worth
--   something only if a member cannot make it: an HMAC the web server signs with a key the member never holds.
-- DESIGN (option a of the three compared in VERA_REPORT.md: (b) a per-request setting reduces to a header a member can also send;
--   (c) revoking create_creative_job from members and calling it with the service key breaks CLAUDE.md #3 and rewrites every caller):
--   geo_claim_country()   reads request.headers -> 'x-nightshift-geo' = v1.<CC>.<user id>.<expiry>.<hex HMAC-SHA256>, and answers the
--     country only when the shape is exact, the user id is auth.uid(), the expiry is in the next 300 seconds and the HMAC matches the
--     key in Vault (secret nightshift_geo_claim_key). Anything else is null. Not callable by any API role (no oracle to test claims).
--   creative_jobs_geo_gate()  BEFORE INSERT OR UPDATE OF routed_model on creative_jobs: for a model with a non-empty blocked_countries,
--     no trusted country = NS400 country_unverified; a country on the list (or a list of another shape) = NS400 country_blocked. One
--     trigger on the one table every path writes (create_creative_job, a workflow step, an MCP or API create, a Film Studio take, the
--     worker's failover), so no door is missed and none needs its body replaced. Raised inside the creating transaction, so the hold
--     taken before the insert rolls back with it.
--   What it does NOT do: store the country (it lives in the one transaction); lift 0142 (a model with a list stays off sale until a
--   later migration decides to open one, which this gate makes honest); vouch for a request with no visitor (the worker, a Film
--   Studio take, a workflow step carried on by another member's page, the API, MCP): those are refused for a gated model.
-- BEFORE IT IS USEFUL: create the Vault secret once (SQL editor, owner; the value is never written in a file):
--     select vault.create_secret('<the same 32+ character value as the web's NIGHTSHIFT_GEO_CLAIM_KEY>', 'nightshift_geo_claim_key');
--   Without it every job on a gated model is refused country_unverified, which today is every job nobody can make anyway.
--
-- PART B. PRICE BY PICTURE SIZE
-- EVIDENCE. The registry prices four Gemini picture models (and Flux 3, Krea 3) by size: pricing.variants.by = image_size, one
--   credit_prices unit per size, model_<id>_<unit>_<size> (modules/model_registry.py credit_unit_for; the validator lists them). The
--   worker sends params.image_size as the vendor's imageSize (modules/capabilities/image.py: "512 / 1K / 2K / 4K: priced per size").
--   But creative_params_problem (0156) refused image_size as an unknown parameter and creative_price (0159) never read the variant, so
--   such a model could only be quoted at its base row with no size, and the vendor then billed its own default size.
-- CHANGE. creative_params_problem (0156's body, two marked hunks): image_size is accepted for t2i and edit, one of 512 1K 2K 4K.
--   creative_price (0159's body, three marked hunks): a size on a model not priced by size, or one it does not list, is refused; a
--   model priced by size must be asked a size (refused otherwise, never priced at the base row) and is priced by the size's own row
--   (a size without one is `unpriced`); the quote names the size. The router treats each refusal as "not a candidate".
--   Not changed: sellable_models still lists a size-priced model on its base row (Found, not done in the report); an operator preview
--   of a size-priced model with no credit row stays unpriced (0149's figure is not read per size).
--
-- REPLACES (md5 drift guard, white space folded): creative_params_problem (0156) before 25ee9cc62a27ad3a19e71008b04f3f36, after
--   7ccde072309a637d9b07e59f1be45d20; creative_price (0159) before dafc5edae0000e741ac1b19bd0075790, after f61aaddd5686045961addd6f14a02c32.
--   The lab chain: sec_db.take_off_0159 takes this file off first (0159's and 0156's rollbacks refuse any other body).
--   creative_regions_problem (0126) before 5603be6af36c813d2799eb581bb971cd, after bcf4c3e85a977c984ab53a9f00a4cfb6 (B3: a region
--   edit may name image_size, so a model sold by size can run one); reroute_creative_job (0196) before 4e43d78523acacf10799497afef0d39a,
--   after 7ebae97d8b932edbf565a394c5b9ca56 (C: a candidate the country gate refuses is skipped; before, the trigger's NS400 on the
--   routed_model update aborted the whole failover, every later candidate with it).
-- NUMBER. 0208 provisional (0203 #857, 0204 #859, 0205 #873; 0206 and 0207 reserved). Needs 0035, 0036, 0101's pattern
--   (request.headers), 0126, 0156, 0159, 0196, pgcrypto (Supabase: schema extensions) and Supabase Vault.
-- Rollback: docs/sql/rollback_0208_geo_gate_and_image_size_price.sql (owner-applied).

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  if to_regclass('public.creative_jobs') is null or to_regclass('public.model_registry') is null
     or to_regprocedure('public.creative_refuse(text, text, text)') is null then
    raise exception '0208 needs 0035 (model_registry) and 0036 (creative_jobs, creative_refuse): apply them first';
  end if;
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception '0208 needs Supabase Vault (vault.decrypted_secrets): enable the vault extension, then run this file again';
  end if;
  -- Either schema (Supabase puts pgcrypto in extensions); one coalesce, so tests/test_migration_prerequisites.py does not read
  -- public.hmac as an object an earlier migration must create (an extension's function is not one).
  if coalesce(to_regprocedure('extensions.hmac(text, text, text)'), to_regprocedure('public.hmac(text, text, text)')) is null then
    raise exception '0208 needs pgcrypto''s hmac(text, text, text) in schema extensions (Supabase) or public: enable pgcrypto first';
  end if;
  for r in select * from (values
      ('public.creative_params_problem(text, jsonb)', '25ee9cc62a27ad3a19e71008b04f3f36', '7ccde072309a637d9b07e59f1be45d20', '0156'),
      ('public.creative_price(uuid, text, text, jsonb)', 'dafc5edae0000e741ac1b19bd0075790', 'f61aaddd5686045961addd6f14a02c32', '0159'),
      ('public.creative_regions_problem(jsonb)', '5603be6af36c813d2799eb581bb971cd', 'bcf4c3e85a977c984ab53a9f00a4cfb6', '0126'),
      ('public.reroute_creative_job(uuid, text, text)', '4e43d78523acacf10799497afef0d39a', '7ebae97d8b932edbf565a394c5b9ca56', '0196')) v(sig, was, now_, src) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is null or h <> all (array[r.was, r.now_]) then
      raise exception '0208 found % with a body that is neither %''s nor 0208''s (md5 %): read the live body first', r.sig, r.src, h;
    end if;
  end loop;
end $$;

-- A missing key is not an error (nothing on sale needs it), but it is said, with the remedy. So is a Google model with no country
-- list: the gate acts only on a row whose spec carries blocked_countries, and the list reaches the database only through the registry
-- sync (python tools/probe_models.py --sync, which calls sync_model_registry). Until it has run, a Google row is not gated at all: 0142 keeps it off sale, but nothing here does.
do $$
declare
  n bigint;
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'nightshift_geo_claim_key') then
    raise notice '0208: no Vault secret nightshift_geo_claim_key yet: every job on a model with a country list is refused until the owner creates it (see the header)';
  end if;
  select count(*) into n from public.model_registry r
   where r.provider = 'google'
     and coalesce(r.spec -> 'blocked_countries', 'null'::jsonb) in ('null'::jsonb, '[]'::jsonb);
  if n > 0 then
    raise notice '0208: % google row(s) in model_registry have no blocked_countries: the registry sync has not run since the list was added, so the country gate does not act on them; run python tools/probe_models.py --sync first (docs/GEO_BLOCK.md, opening steps)', n;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- A1. The country our web server signed for this request
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.geo_claim_country() returns text
  language plpgsql stable security definer set search_path = extensions, public, pg_temp as $$
declare
  hdrs  text := nullif(current_setting('request.headers', true), '');
  raw   text;
  parts text[];
  k     text;
  now_s numeric := floor(extract(epoch from clock_timestamp()));
begin
  if hdrs is null then
    return null;
  end if;
  -- PostgREST writes request.headers as JSON; anything else is no claim (never an error that a caller could read as "allowed").
  begin
    raw := hdrs::json ->> 'x-nightshift-geo';
  exception when others then
    return null;
  end;
  -- v1.<country>.<user id>.<expiry, epoch seconds>.<hex HMAC-SHA256 of the first four parts>: command-center/lib/server/geo-claim.ts.
  if raw is null
     or raw !~ '^v1\.[A-Z]{2}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9]{1,12}\.[0-9a-f]{64}$' then
    return null;
  end if;
  parts := string_to_array(raw, '.');
  -- Made for this person (a claim another session got cannot be replayed here), and alive: the server signs it with an expiry
  -- 120 seconds ahead; one more than 300 seconds ahead was not signed by it.
  if parts[3]::uuid is distinct from auth.uid() then
    return null;
  end if;
  if parts[4]::numeric < now_s or parts[4]::numeric > now_s + 300 then
    return null;
  end if;
  -- The key lives in Vault and in the web server's environment, nowhere else. No key (or a stub) vouches for nothing.
  select s.decrypted_secret into k from vault.decrypted_secrets s where s.name = 'nightshift_geo_claim_key' limit 1;
  if k is null or char_length(k) < 32 then
    return null;
  end if;
  if encode(hmac(array_to_string(parts[1:4], '.'), k, 'sha256'), 'hex') <> parts[5] then
    return null;
  end if;
  return parts[2];
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- A2. The gate on creative_jobs
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.creative_jobs_geo_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m   text := coalesce(new.routed_model, new.requested_model);
  lst jsonb;
  c   text;
begin
  -- A row that does not change its model is not asked again (a status, a heartbeat, a result).
  if tg_op = 'UPDATE' and new.routed_model is not distinct from old.routed_model then
    return new;
  end if;
  select r.spec -> 'blocked_countries' into lst from public.model_registry r where r.id = m;
  if lst is null or lst = 'null'::jsonb or lst = '[]'::jsonb then
    return new;
  end if;
  -- A model with a country list: only a country this database can trust (geo_claim_country: signed by our web server for this
  -- person, seconds ago). No claim at all is a member calling create_creative_job straight through PostgREST, the worker moving a
  -- job onto this model (it has no visitor), or a Film Studio take: refused, never let through as "unknown".
  c := public.geo_claim_country();
  if c is null then
    perform public.creative_refuse('country_unverified',
      format('%s is sold only where the country of the request is confirmed by the web app; nothing was held', m));
  end if;
  -- A list of any other shape fails closed.
  if jsonb_typeof(lst) <> 'array' or lst ? c then
    perform public.creative_refuse('country_blocked', format('%s is not available in this region; nothing was held', m));
  end if;
  return new;
end
$$;

drop trigger if exists creative_jobs_geo_gate on public.creative_jobs;
create trigger creative_jobs_geo_gate
  before insert or update of routed_model on public.creative_jobs
  for each row execute function public.creative_jobs_geo_gate();

revoke all on function public.geo_claim_country() from public, anon, authenticated, service_role;
revoke all on function public.creative_jobs_geo_gate() from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- B1. The parameter: 0156's creative_params_problem, two marked hunks (0208)
-- ───────────────────────────────────────────────────────────────────────────

-- 0156's params check, also taking a picture size (0208).
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
                 'regions', 'region_feather',
                 -- 0208
                 'image_size') then
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
  -- 0208: the size of a picture from a model that bills by it (the registry schema's closed list): t2i and edit only. Whether THIS
  -- model is sold by size and lists the size (and has a price for it) is creative_price's question. Absent = no size named.
  if p_params ? 'image_size' then
    if p_capability not in ('t2i', 'edit') then
      return format('image_size does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'image_size') is distinct from 'string'
       or (p_params ->> 'image_size') not in ('512', '1K', '2K', '4K') then
      return 'image_size must be one of 512, 1K, 2K, 4K';
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

-- ───────────────────────────────────────────────────────────────────────────
-- B2. The price: 0159's creative_price, three marked hunks (0208)
-- ───────────────────────────────────────────────────────────────────────────

-- 0159's quote, also priced by picture size (0208).
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
  -- 0208: the picture size this quote is for (spec.pricing.variants.by = image_size).
  vsize   text;
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
  -- 0155: nor any shape the model does not list for this capability: spec.aspect_ratios_by_capability[cap] when it names
  -- some, else spec.aspect_ratios, the same list the worker checks before it calls the vendor (ModelEntry.aspects_for). An
  -- empty list is a model that makes its own shape, so any shape is refused. Refused here, before anything is held, rather
  -- than by the worker after the job was queued. Each branch casts nothing: the CASE decides the order, not an `and`.
  if p_params ? 'aspect_ratio'
     and not coalesce(case
                        when jsonb_typeof(m_spec -> 'aspect_ratios_by_capability' -> cap) = 'array'
                             and m_spec -> 'aspect_ratios_by_capability' -> cap <> '[]'::jsonb
                          then (m_spec -> 'aspect_ratios_by_capability' -> cap) @> jsonb_build_array(p_params ->> 'aspect_ratio')
                        when jsonb_typeof(m_spec -> 'aspect_ratios') = 'array'
                          then (m_spec -> 'aspect_ratios') @> jsonb_build_array(p_params ->> 'aspect_ratio')
                      end, false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer the %s shape for %s', mdl, p_params ->> 'aspect_ratio', cap));
  end if;
  -- 0159: nor a clip length the model does not list (spec.durations_s), the list the worker checks before it calls the vendor
  -- (ModelEntry.problems: "duration <n>s is not offered by <model>"). A spec with no list, or an empty one, refuses every length (never
  -- "any length is fine"). Only when the request names one: creative_params_problem requires it for t2v, i2v, sfx and music and refuses
  -- it on every other tool. Refused here, before anything is held, rather than by the worker after the job was queued.
  if p_params ? 'duration_s'
     and not coalesce(jsonb_typeof(m_spec -> 'durations_s') = 'array'
                      and (m_spec -> 'durations_s') @> jsonb_build_array(p_params -> 'duration_s'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer a %s-second clip for %s', mdl, p_params ->> 'duration_s', cap));
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
  -- 0208: a picture size only on a model whose price follows it (spec.pricing.variants.by = image_size) and that lists the size
  -- (spec.image_sizes, the list the worker checks: ModelEntry.problems "image size <s> is not offered by <model>"). On any other
  -- model the size would reach a vendor that bills its own way under a price that was not read for it: refused, never ignored.
  if p_params ? 'image_size'
     and (coalesce(m_spec -> 'pricing' -> 'variants' ->> 'by', '') <> 'image_size'
          or not coalesce(jsonb_typeof(m_spec -> 'image_sizes') = 'array'
                          and (m_spec -> 'image_sizes') @> jsonb_build_array(p_params ->> 'image_size'), false)) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer the %s size', mdl, p_params ->> 'image_size'));
  end if;
  -- 0208: one price per size when the registry prices the sizes apart (model_registry.credit_unit_for: model_<id>_<unit>_<size>).
  -- The size must be named: the worker sends it as the vendor's imageSize, and with none the vendor makes (and bills) its own
  -- default under a price read for no size. A size without its own row is unpriced: never another size's rate, never the base row.
  if cap in ('t2i', 'edit') and m_unit is not null
     and m_spec -> 'pricing' -> 'variants' ->> 'by' = 'image_size' then
    vsize := p_params ->> 'image_size';
    if vsize is null then
      perform public.creative_refuse('invalid_params',
        format('%s is sold by picture size: name image_size', mdl));
    end if;
    m_unit := m_unit || '_' || regexp_replace(lower(vsize), '[^a-z0-9]', '_', 'g');
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
    -- 0208: the picture size this price is for.
    || case when vsize is null then '{}'::jsonb else jsonb_build_object('image_size', vsize) end
    -- The resolution and soundtrack this price is for (0070).
    || variant
    -- 0139: a preview says so, and the Studio shows it as the operator's record, never as a price on sale.
    || case when preview then jsonb_build_object('preview', true) else '{}'::jsonb end;
end
$$;

revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- B3. A region edit at a size: 0126's creative_regions_problem, one marked hunk (0208)
-- ───────────────────────────────────────────────────────────────────────────

-- 0126's closed list of a region edit's params refused image_size, so a model sold by size (creative_price refuses one with no
-- size) could never run a region edit at all, and lib/regionEdit/run.ts had no size to send.
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
  -- A region edit takes the picture, its regions, the edge blend, the render tier (which only prices the model's own tiers) and the
  -- picture size (0208: the value is creative_params_problem's, the model's list creative_price's) and nothing else: a setting that would be silently ignored is refused.
  for k in select jsonb_object_keys(p_params) loop
    if k not in ('source_asset_id', 'quality', 'regions', 'region_feather',
                 -- 0208
                 'image_size') then
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

revoke all on function public.creative_regions_problem(jsonb) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- C. The failover: 0196's reroute_creative_job, one marked hunk (0208)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.reroute_creative_job(p_job uuid, p_worker text, p_code text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  w     text := left(btrim(coalesce(p_worker, '')), 120);
  code  text := lower(btrim(coalesce(p_code, '')));
  org   uuid;
  j     public.creative_jobs;
  tried jsonb;
  rr    public.creative_job_routes;
  surf  text;
  q0    numeric;
  cq    numeric;
  cand  jsonb;
  m     text;
  q     jsonb;
  price numeric;
  jparams jsonb;
begin
  if not public.credits_trusted_caller() then
    raise exception 'creative jobs are run by the platform''s worker only' using errcode = '42501';
  end if;
  -- Only a failure that PROVES no vendor task exists (header, BR-L-019):
  -- never 'unavailable' (a timeout or a 5xx: the vendor may be billing), never
  -- a refusal of the request itself (policy, bad_request). Anything else
  -- returns before the row is touched: its submit_started_at stands.
  if code not in ('unreachable', 'rate_limited', 'quota', 'auth', 'not_configured', 'not_found',
                  'adapter_missing') then
    return null;
  end if;
  select org_id into org from public.creative_jobs where id = p_job;
  if org is null then
    return null;
  end if;
  perform public.credit_account_lock(org);
  select * into j from public.creative_jobs where id = p_job for update;
  if j.worker_id is distinct from w or j.status <> 'running' or j.provider_task_id is not null then
    return null;
  end if;
  -- exact never fails over: the person's model, or nothing.
  if j.mode = 'exact' or j.routing is null then
    return null;
  end if;
  select * into rr from public.creative_job_routes where job_id = p_job for update;
  if not found then
    return null;
  end if;
  tried := rr.tried;
  if jsonb_array_length(tried) >= 3 then
    return null;
  end if;
  surf := coalesce(j.routing ->> 'surface', 'web');
  q0 := coalesce(rr.quality_tier, 0);
  for cand in select t.e from jsonb_array_elements(rr.candidates)
                             with ordinality t(e, n) order by t.n loop
    m := cand ->> 'model';
    continue when m is null or tried ? m;
    cq := coalesce((cand ->> 'quality_tier')::numeric, 0);
    continue when j.mode = 'quality' and cq <> q0;
    continue when j.mode = 'auto' and cq < q0;
    continue when not exists (select 1 from public.sellable_models(j.capability, surf) s where s.id = m);
    -- 0187: a failover never sends an input to a model that would have refused it at create_creative_job: a candidate that
    -- requires a rights acknowledgement the job's requester has not given for every input (rights_acknowledgement_missing:
    -- the source and end files, the style kit's and the mentioned @characters' pictures) is skipped. A job with no requester
    -- has nobody who could have acknowledged, so every such candidate is skipped (fail closed).
    continue when public.rights_acknowledgement_missing(j.org_id, j.requested_by, m, j.params) is not null;
    -- 0196: nor to a model whose vendor's terms are 18+ when the job's requester has no adult answer (adult_attestation_missing,
    -- 0192): create_creative_job would have refused it. A job with no requester skips every such candidate (fail closed).
    continue when public.adult_attestation_missing(j.requested_by, m);
    begin
      -- The job's own params: the settings the person's quote priced.
      q := public.creative_price(j.org_id, j.capability, m, j.params);
    exception when sqlstate 'NS400' then
      continue;
    end;
    price := (q ->> 'credits')::numeric;
    continue when price is null or price <= 0 or price > j.quoted_credits;
    -- No dearer than the hold, which is the quote (BR-L-020).
    -- The variant this model is priced at is what the worker sends (0060 / 0070).
    jparams := j.params;
    if q ? 'quality' then
      jparams := jparams || jsonb_build_object('quality', q ->> 'quality');
    end if;
    if q ? 'resolution' then
      jparams := jparams || jsonb_build_object('resolution', q ->> 'resolution');
    end if;
    if q ? 'audio' then
      jparams := jparams || jsonb_build_object('audio', (q ->> 'audio')::boolean);
    end if;
    -- The row describes the model that runs now: its price, unit and quantity
    -- (BR-L-024). submit_started_at is cleared ONLY here, where no task can
    -- exist: the worker submits a new one to the new model.
    -- 0208: moving the job onto m fires creative_jobs_geo_gate, and the worker has no visitor whose country a web request vouched
    -- for: a model with a country list refuses (NS400). That candidate is skipped like any other refusal above, never an error that
    -- aborts the whole failover and with it every candidate after it (the update rolls back with its block).
    begin
      update public.creative_jobs
         set fallback_from = j.routed_model, fallback_reason = 'unavailable', routed_model = m,
             routed_credits = price, params = jparams, submit_started_at = null,
             credit_unit = coalesce(q ->> 'unit', j.credit_unit),
             quantity = coalesce((q ->> 'quantity')::numeric, j.quantity),
             heartbeat_at = now(), updated_at = now()
       where id = p_job;
    exception when sqlstate 'NS400' then
      continue;
    end;
    -- The real reason is the platform's: it stays in the platform-only route
    -- row, and the member-readable row and log say only 'unavailable'.
    update public.creative_job_routes r
       set tried = r.tried || to_jsonb(m), reasons = r.reasons || to_jsonb(code)
     where r.job_id = p_job;
    perform public.creative_job_log(p_job, j.org_id, 'rerouted', 'running',
      jsonb_build_object('from', j.routed_model, 'to', m, 'code', 'unavailable', 'credits', price));
    -- The worker sends exactly these params to the new model.
    return jsonb_build_object('model', m, 'credits', price, 'params', jparams);
  end loop;
  return null;
end
$$;
-- create or replace keeps 0196's grants (service_role only); the end state below checks that no other API role may call it.

-- ───────────────────────────────────────────────────────────────────────────
-- End state (refuses the whole transaction if any of it is not so)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  r record;
begin
  for r in select * from (values
      ('public.creative_params_problem(text, jsonb)', '7ccde072309a637d9b07e59f1be45d20'),
      ('public.creative_price(uuid, text, text, jsonb)', 'f61aaddd5686045961addd6f14a02c32'),
      ('public.geo_claim_country()', 'add85b6752c03be6882a59a0ff8017ba'),
      ('public.creative_jobs_geo_gate()', '71468a6f60d2659cd44199a3c834dc69'),
      ('public.creative_regions_problem(jsonb)', 'bcf4c3e85a977c984ab53a9f00a4cfb6'),
      ('public.reroute_creative_job(uuid, text, text)', '7ebae97d8b932edbf565a394c5b9ca56')) v(sig, want) loop
    if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(r.sig)) is distinct from r.want then
      raise exception '0208 end state: % is not 0208''s body', r.sig;
    end if;
  end loop;
  if not exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                  where t.tgrelid = 'public.creative_jobs'::regclass and t.tgname = 'creative_jobs_geo_gate'
                    and p.proname = 'creative_jobs_geo_gate' and not t.tgisinternal and t.tgenabled = 'O') then
    raise exception '0208 end state: creative_jobs has no enabled creative_jobs_geo_gate trigger';
  end if;
  for r in select * from unnest(array['public.geo_claim_country()', 'public.creative_jobs_geo_gate()',
                                      'public.creative_price(uuid, text, text, jsonb)',
                                      'public.creative_params_problem(text, jsonb)',
                                      'public.creative_regions_problem(jsonb)']) sig,
                         unnest(array['anon', 'authenticated', 'service_role']) role_ loop
    if has_function_privilege(r.role_, r.sig, 'EXECUTE') then
      raise exception '0208 end state: % may call %', r.role_, r.sig;
    end if;
  end loop;
  if not (select prosecdef from pg_proc where oid = 'public.geo_claim_country()'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.creative_jobs_geo_gate()'::regprocedure) then
    raise exception '0208 end state: the country gate''s functions are not SECURITY DEFINER';
  end if;
  -- The rules on sample params (no table is read): a size for a picture passes, anything else is refused.
  if public.creative_params_problem('t2i', '{"prompt": "x", "image_size": "2K"}'::jsonb) is not null
     or public.creative_params_problem('t2i', '{"prompt": "x", "image_size": "8K"}'::jsonb) is null
     or public.creative_params_problem('t2v', '{"prompt": "x", "duration_s": 4, "image_size": "1K"}'::jsonb) is null then
    raise exception '0208 end state: creative_params_problem does not read image_size as this file says';
  end if;
  if public.creative_params_problem('edit', '{"source_asset_id": "00000000-0000-0000-0000-000000000001", "image_size": "2K",
        "regions": [{"id": "a", "name": "a", "rect": {"x": 0, "y": 0, "w": 16, "h": 16}, "prompt": "x"}]}'::jsonb) is not null
     or public.creative_params_problem('edit', '{"source_asset_id": "00000000-0000-0000-0000-000000000001", "image_size": "8K",
        "regions": [{"id": "a", "name": "a", "rect": {"x": 0, "y": 0, "w": 16, "h": 16}, "prompt": "x"}]}'::jsonb) is null then
    raise exception '0208 end state: a region edit does not read image_size as this file says';
  end if;
  if has_function_privilege('anon', 'public.reroute_creative_job(uuid, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.reroute_creative_job(uuid, text, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.reroute_creative_job(uuid, text, text)', 'EXECUTE') then
    raise exception '0208 end state: reroute_creative_job is not callable by the worker (service_role) only';
  end if;
end $$;

-- Verify (the SQL editor, after applying; every column should read true):
--   select
--     (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--       where oid = 'public.creative_price(uuid,text,text,jsonb)'::regprocedure) = 'f61aaddd5686045961addd6f14a02c32' as creative_price_0208,
--     (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--       where oid = 'public.creative_params_problem(text,jsonb)'::regprocedure) = '7ccde072309a637d9b07e59f1be45d20' as params_problem_0208,
--     exists (select 1 from pg_trigger where tgrelid = 'public.creative_jobs'::regclass and tgname = 'creative_jobs_geo_gate') as geo_gate,
--     exists (select 1 from vault.decrypted_secrets where name = 'nightshift_geo_claim_key') as geo_key_in_vault;
