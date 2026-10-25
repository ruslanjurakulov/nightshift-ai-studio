-- 0122_series_template_carrier.sql — Series Factory: the carrier for a format template ("myth vs fact", "top 5 countdown", "one question, one
-- answer") from the plan form to the planner. docs/SERIES_FACTORY.md, "Format templates". LIVE ON APPLY: it replaces three live functions and
-- one live callable; read "WHAT TO VERIFY BEFORE YOU APPLY" below first.
--
-- WHY A MIGRATION. A format chosen in the browser has nowhere to go today: request_series_plan() takes seven arguments and stores none of them as
-- a format, render_job_params_valid() refuses any key it does not know on a planning job, and the payment guard refuses a planning job that
-- differs from its plan in any parameter. So the id travels in three places that agree, and the database holds the word that decides which:
--   series_plans.template_id   the format the plan was asked for (NULL = none). Frozen with the other terms of the plan.
--   the planning job's params  an optional `template` key, the same word, only on a series_plan job.
--   request_series_plan(..., p_template)   the only writer of both.
--
-- WHAT THIS DOES NOT DO.
--   * It GRANTS NOTHING. request_series_plan is still callable by nobody: the new eight-argument function is revoked from public, anon,
--     authenticated and service_role exactly as 0120 revoked the seven-argument one, and the old one is DROPPED (a new signature is a new
--     function; leaving the old one would leave a second door). tests/test_series_template_migration.py::Dormant and the lab test fail if any
--     migration grants it. The grant stays a separate owner decision with the conditions in docs/SERIES_FACTORY.md.
--   * It writes no row, rewrites no row and calls no provider. A column with no default is added (null for every existing row: no rewrite).
--   * It does not touch credits, holds, the queue worker, publishing or privacy. A planning job is still paid by nobody (0120).
--   * It does not add a template to the database as data: the three ids are a CLOSED LIST written in three places (the CHECK below, the request
--     function and the params validator); adding a fourth format is a new migration, on purpose.
--
-- NUMBER. 0122: the highest on main is 0121 (#594). No open pull request adds a migration: checked again at push time with gh api (open: #602 and
-- #606-#609, none touches supabase/; #599-#601, #603, #604 and #605 merged without one). Number 0118 is still unused.
--
-- APPLY AS ONE TRANSACTION: the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1. `set local lock_timeout`
-- and the drift guards assume it, and the last block of this file asserts the end state, so a half-applied file cannot be left behind.
--
-- WHAT IT REPLACES (each is its latest body, character for character, plus lines marked `-- 0122`):
--   render_job_params_valid(jsonb, text)   0120's body + the optional `template` key (a string of the closed list, series_plan jobs only)
--   render_jobs_payment_guard()            0120's body + two lines inside the series-plan block: the job's `template` must equal the plan's
--   series_plans_terms_frozen()            0120's body + one line: template_id never changes after the request
--   request_series_plan                    DROPPED as (text,text,integer,text,integer,text,text), CREATED as (..., p_template text default null);
--                                          0120's body + the validation, the hash, the column and the job param, all marked
-- The two functions that decide money-adjacent rules (the payment guard and the params validator) are md5-pinned below as 0120 did: the file
-- refuses to replace a body it has not seen (the 0064 / 0103 drift lesson).
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; run as the SQL editor on the live project). Each hash is md5 of the function body with every run
-- of white space read as one space. The file checks them itself and raises on any other value, but read them first:
--     select 'render_job_params_valid' as fn,  md5(regexp_replace(prosrc, '\s+', ' ', 'g')) as md5
--       from pg_proc where oid = 'public.render_job_params_valid(jsonb, text)'::regprocedure
--     union all select 'render_jobs_payment_guard', md5(regexp_replace(prosrc, '\s+', ' ', 'g'))
--       from pg_proc where oid = 'public.render_jobs_payment_guard()'::regprocedure
--     union all select 'series_plans_terms_frozen', md5(regexp_replace(prosrc, '\s+', ' ', 'g'))
--       from pg_proc where oid = 'public.series_plans_terms_frozen()'::regprocedure
--     union all select 'request_series_plan(7 args)', md5(regexp_replace(prosrc, '\s+', ' ', 'g'))
--       from pg_proc where oid = 'public.request_series_plan(text, text, integer, text, integer, text, text)'::regprocedure;
--   expected BEFORE (0120 is applied, 0122 is not):
--     render_job_params_valid      f2ea81f1d5bd9a8632f421f2c3aefba6
--     render_jobs_payment_guard    40039657e1c139399ff866d45831f07f
--     series_plans_terms_frozen    02ea97a4de9e71ed4bcda87975b7dbe0
--     request_series_plan (7 args) 7594635cffff8567001e07cbc784c5fc
--   and nobody may hold EXECUTE on the 7-argument function (expected: no row):
--     select a.grantee::regrole from pg_proc p, aclexplode(p.proacl) a
--      where p.oid = 'public.request_series_plan(text, text, integer, text, integer, text, text)'::regprocedure
--        and (a.grantee = 0 or a.grantee in ('anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole));
--   (a NULL proacl would mean "default privileges": the file refuses that too, because the default includes public.)
--   expected AFTER (the last block of this file asserts the same, inside the transaction):
--     render_job_params_valid      a9367e46ea79e8d57ce1c876333b5508
--     render_jobs_payment_guard    3807936ade6801fa20da292e27fa7f64
--     series_plans_terms_frozen    4c3b97a9d5d400a9a8cf900aa23c5ab2
--     request_series_plan (8 args) e38342a6c8511d5eadb1f99ab38fb6aa
--   If a live value is anything else, STOP: something was applied by hand after 0120, and replacing the body would silently undo it.
--
-- Additive and idempotent: add column if not exists, drop constraint then add, create or replace, revoke. A second run finds the 0122 bodies and
-- changes nothing. An applied migration is never edited. Rollback: docs/sql/rollback_0122_series_template_carrier.sql.
-- REQUIRES 0120 (series_plans, request_series_plan, the series_plan queue kind) and, through it, everything 0120 requires.

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.series_plans') is null or to_regclass('public.series_episodes') is null then
    raise exception '0122 needs 0120_series_tables.sql (series_plans): apply it first';
  end if;
  if to_regprocedure('public.series_plans_terms_frozen()') is null
     or to_regprocedure('public.finish_series_plan(uuid, boolean, text, jsonb, jsonb, jsonb, text, text)') is null
     or coalesce(to_regprocedure('public.request_series_plan(text, text, integer, text, integer, text, text)'),
                 to_regprocedure('public.request_series_plan(text, text, integer, text, integer, text, text, text)')) is null then
    raise exception '0122 needs the functions of 0120_series_tables.sql: apply it first';
  end if;
  if not exists (select 1 from pg_attribute where attrelid = 'public.render_jobs'::regclass and attname = 'series_plan_id' and not attisdropped) then
    raise exception '0122 needs render_jobs.series_plan_id (0120): apply it first';
  end if;
  if to_regprocedure('public.render_job_params_valid(jsonb, text)') is null or to_regprocedure('public.render_jobs_payment_guard()') is null then
    raise exception '0122 needs render_job_params_valid and render_jobs_payment_guard (0120)';
  end if;
  -- create or replace keeps a trigger bound; if either trigger is gone the rule it carries would never run.
  if not exists (select 1 from pg_trigger where tgrelid = 'public.render_jobs'::regclass and tgname = 'render_jobs_payment_guard' and not tgisinternal) then
    raise exception '0122 found no render_jobs_payment_guard trigger on render_jobs: re-apply 0041/0076 first';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.series_plans'::regclass and tgname = 'series_plans_terms_frozen' and not tgisinternal) then
    raise exception '0122 found no series_plans_terms_frozen trigger on series_plans: re-apply 0120 first';
  end if;
end $$;

-- The bodies this file replaces are replaced on what the REPO says is latest (0120's). If the live database holds another body (something applied
-- by hand after 0120: the 0064 / 0103 drift lesson), replacing it would silently undo that change, so the file refuses. Each pair is
-- (0120's body, this file's own body, which is what a replay sees); compared as md5 of prosrc with every run of white space read as one space.
-- tests/test_series_template_migration.py recomputes every hash from the migration files.
--
-- request_series_plan: the seven-argument function is dropped further down, and only if it is 0120's body AND granted to nobody (no public, no
-- anon, authenticated or service_role, and an ACL that is not NULL). A grant made by hand would make this a live change to a callable, and that
-- is a decision for a person. The eight-argument function, if it already exists (a replay), must be this file's body.
do $$
declare
  v  text;
  g  text;
  t  text;
  r7 text;
  r8 text;
  old_oid oid := to_regprocedure('public.request_series_plan(text, text, integer, text, integer, text, text)');
  new_oid oid := to_regprocedure('public.request_series_plan(text, text, integer, text, integer, text, text, text)');
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into v
    from pg_proc p where p.oid = 'public.render_job_params_valid(jsonb, text)'::regprocedure;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into g
    from pg_proc p where p.oid = 'public.render_jobs_payment_guard()'::regprocedure;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into t
    from pg_proc p where p.oid = 'public.series_plans_terms_frozen()'::regprocedure;
  if v is null or v <> all (array['f2ea81f1d5bd9a8632f421f2c3aefba6', 'a9367e46ea79e8d57ce1c876333b5508']) then
    raise exception '0122 found a render_job_params_valid() that is neither 0120''s body nor 0122''s (md5 %): read the live body first', v;
  end if;
  if g is null or g <> all (array['40039657e1c139399ff866d45831f07f', '3807936ade6801fa20da292e27fa7f64']) then
    raise exception '0122 found a render_jobs_payment_guard() that is neither 0120''s body nor 0122''s (md5 %): read the live body first', g;
  end if;
  if t is null or t <> all (array['02ea97a4de9e71ed4bcda87975b7dbe0', '4c3b97a9d5d400a9a8cf900aa23c5ab2']) then
    raise exception '0122 found a series_plans_terms_frozen() that is neither 0120''s body nor 0122''s (md5 %): read the live body first', t;
  end if;

  if old_oid is not null then
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into r7 from pg_proc p where p.oid = old_oid;
    if r7 <> '7594635cffff8567001e07cbc784c5fc' then
      raise exception '0122 found a seven-argument request_series_plan() that is not 0120''s body (md5 %): read the live body first', r7;
    end if;
    if exists (select 1 from pg_proc p
                where p.oid = old_oid
                  and (p.proacl is null
                       or exists (select 1 from aclexplode(p.proacl) a
                                   where a.grantee = 0
                                      or a.grantee in (select r.oid from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role'))))) then
      raise exception '0122 found request_series_plan() executable by public or by an API role: it is meant to be granted to nobody, so dropping it is a decision for a person';
    end if;
  end if;
  if new_oid is not null then
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into r8 from pg_proc p where p.oid = new_oid;
    if r8 <> 'e38342a6c8511d5eadb1f99ab38fb6aa' then
      raise exception '0122 found an eight-argument request_series_plan() that is not 0122''s body (md5 %): read the live body first', r8;
    end if;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The carrier: series_plans.template_id
-- ───────────────────────────────────────────────────────────────────────────

-- NULL for every existing row and for every plan made without a format. Nullable, no default: adding it rewrites nothing.
alter table public.series_plans add column if not exists template_id text;

comment on column public.series_plans.template_id is
  'The format template the plan was asked for (migration 0122): one of myth_vs_fact, top5_countdown, one_question_one_answer, or NULL for none. Written only by request_series_plan, frozen with the other terms of the plan. A request to the planning model: the outline is not checked against it.';

-- The closed list (the same three words are in request_series_plan and render_job_params_valid below, and in modules/series_planner.py and
-- command-center/lib/seriesTemplates.ts). NULL passes: no format is the normal case.
alter table public.series_plans drop constraint if exists series_plans_template_check;
alter table public.series_plans add constraint series_plans_template_check
  check (template_id is null or template_id in ('myth_vs_fact', 'top5_countdown', 'one_question_one_answer'));

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The plan's terms stay fixed: template_id joins them
-- ───────────────────────────────────────────────────────────────────────────

-- series_plans_terms_frozen: 0120's body verbatim, plus the one line marked 0122. The trigger (before update, 0120) is not recreated: create or
-- replace keeps it bound.

create or replace function public.series_plans_terms_frozen() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.channel_id is distinct from old.channel_id
     or new.series_id is distinct from old.series_id
     or new.topic is distinct from old.topic
     or new.niche is distinct from old.niche
     or new.language is distinct from old.language
     or new.n_episodes is distinct from old.n_episodes
     or new.duration_s is distinct from old.duration_s
     -- 0122: the format is a term of the plan, as the topic is
     or new.template_id is distinct from old.template_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.request_hash is distinct from old.request_hash
     or new.requested_by is distinct from old.requested_by
     or new.created_at is distinct from old.created_at
     or (old.render_job_id is not null and new.render_job_id is distinct from old.render_job_id)
     or old.status <> 'requested' then
    raise exception 'a series plan''s terms are fixed when it is requested, and an ended plan is final'
      using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function public.series_plans_terms_frozen() from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The queue: a planning job may carry the format
-- ───────────────────────────────────────────────────────────────────────────

-- render_job_params_valid: 0120's body verbatim, plus the lines marked 0122 (one key in the allowed list, one block, one key in the planning
-- kind's rule). Still IMMUTABLE: it sits in the render_jobs_params_check CHECK and in the api_* functions, so it cannot read a table. It checks the
-- SHAPE of `template` (a string of the closed list, on a series_plan job only); that the job's template is its plan's is the payment guard's check.

create or replace function public.render_job_params_valid(p jsonb, p_kind text)
  returns boolean
  language plpgsql immutable as $$
declare
  k text;
  allowed text[] := array['topic','niche','privacy','duration','language','visual_style',
                          'video_provider','image_provider','tts_model','voice_id','resume','repair_scenes',
                          'publish_hint','series','template'];
  has_repair boolean;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any(allowed)) then
      return false;
    end if;
  end loop;

  foreach k in array array['topic','niche','language','visual_style','repair_scenes'] loop
    if p ? k and jsonb_typeof(p -> k) <> 'string' then
      return false;
    end if;
  end loop;
  if length(coalesce(p ->> 'topic', '')) > 300
     or length(coalesce(p ->> 'niche', '')) > 120
     or length(coalesce(p ->> 'language', '')) > 40
     or length(coalesce(p ->> 'visual_style', '')) > 300
     or length(coalesce(p ->> 'repair_scenes', '')) > 120 then
    return false;
  end if;

  if p ? 'duration' then
    if jsonb_typeof(p -> 'duration') <> 'number' then
      return false;
    end if;
    if (p ->> 'duration')::numeric <> trunc((p ->> 'duration')::numeric)
       or (p ->> 'duration')::numeric not between 30 and 3600 then
      return false;
    end if;
  end if;

  if p ? 'privacy' and (jsonb_typeof(p -> 'privacy') <> 'string'
                        or p ->> 'privacy' not in ('private', 'unlisted', 'public')) then
    return false;
  end if;
  if p ? 'video_provider' and (jsonb_typeof(p -> 'video_provider') <> 'string'
      or p ->> 'video_provider' not in ('minimax','higgsfield','kling','veo','seedance','wan')) then
    return false;
  end if;
  if p ? 'image_provider' and (jsonb_typeof(p -> 'image_provider') <> 'string'
      or p ->> 'image_provider' not in ('pexels','leonardo','gpt-image','nano-banana',
                                         'flux','ideogram','fal')) then
    return false;
  end if;
  if p ? 'tts_model' and (jsonb_typeof(p -> 'tts_model') <> 'string'
      or p ->> 'tts_model' not in ('eleven_v3','eleven_multilingual_v2',
                                   'eleven_flash_v2_5','eleven_turbo_v2_5')) then
    return false;
  end if;
  if p ? 'voice_id' and (jsonb_typeof(p -> 'voice_id') <> 'string'
      or p ->> 'voice_id' !~ '^[A-Za-z0-9]{20}$') then
    return false;
  end if;
  -- 0029: which account the video is for — a hint, never an instruction.
  if p ? 'publish_hint' and (jsonb_typeof(p -> 'publish_hint') <> 'string'
      or p ->> 'publish_hint' !~ '^(youtube|instagram|tiktok):[A-Za-z0-9._-]{1,128}$') then
    return false;
  end if;
  -- 0120: which series an episode's run belongs to. A slug (the shape modules/series.py accepts), so it can name nothing else: no path, no
  -- flag, no line break. Never on a repair, which re-renders scenes of a run that is already made.
  if p ? 'series' and (jsonb_typeof(p -> 'series') <> 'string'
                       or p ->> 'series' !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
                       or p_kind = 'repair') then
    return false;
  end if;
  -- 0122: the format of a planning job. A string, one of the closed list, and only on a series_plan job (an ordinary run, a repair and
  -- the API functions take none). `is distinct from`, so a NULL kind cannot slip past.
  if p ? 'template' and (jsonb_typeof(p -> 'template') <> 'string'
                         or p ->> 'template' not in ('myth_vs_fact', 'top5_countdown', 'one_question_one_answer')
                         or p_kind is distinct from 'series_plan') then
    return false;
  end if;
  if p ? 'resume' and jsonb_typeof(p -> 'resume') <> 'boolean' then
    return false;
  end if;

  has_repair := length(btrim(coalesce(p ->> 'repair_scenes', ''))) > 0;
  -- 0120: a series-planning job is ONE model call about a topic. It carries the topic, the niche, the language and the series it is for, and
  -- nothing a run takes (no length, provider, voice, resume or repair). 0122 adds the format it was asked for.
  if p_kind = 'series_plan' then
    return not has_repair
       and (p - array['topic','niche','language','series','template']) = '{}'::jsonb
       and length(btrim(coalesce(p ->> 'topic', ''))) > 0
       and length(btrim(coalesce(p ->> 'niche', ''))) > 0;
  end if;
  if p_kind = 'repair' then
    return has_repair and coalesce((p ->> 'resume')::boolean, false) = false;
  end if;
  return not has_repair;
end
$$;


-- render_jobs_payment_guard: 0120's body verbatim, plus the two lines marked 0122 inside the series-plan block. The trigger itself (before insert,
-- 0041/0076) is not recreated: create or replace keeps it bound.

create or replace function public.render_jobs_payment_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org   uuid;
  v_cfg   jsonb;
  v_secs  numeric;
  r       public.credit_reservations;
  h       public.api_holds;
  jm      numeric;
  vm      public.credit_prices;
  v_need  numeric;
  sr      public.scene_regenerations;
  sp      public.series_plans;
begin
  -- 0120: a job linked to a series plan is the one job its request queued -- a planning job (one model call, paid by nobody: planning is free
  -- to the customer and capped per organization per day) -- for every organization, the operator's included. Placed before the channel
  -- check below on purpose: an EDITOR requests a plan (request_series_plan checks that), and the browser's own insert policy admits only
  -- kind 'daily', so a signed-in browser cannot insert this row itself whatever it puts in the column.
  if new.series_plan_id is not null then
    select * into sp from public.series_plans where id = new.series_plan_id;
    if sp.id is null or new.kind <> 'series_plan' or sp.channel_id <> new.channel_id
       or sp.status <> 'requested' or sp.render_job_id is not null
       or new.credit_ref is not null or new.api_hold_ref is not null or new.scene_regeneration_id is not null
       or new.params ->> 'topic' is distinct from sp.topic
       or new.params ->> 'niche' is distinct from sp.niche
       or new.params ->> 'language' is distinct from sp.language
       or new.params ->> 'series' is distinct from sp.series_id
       -- 0122: the format on the job is the format the plan was asked for (both absent is fine; one of them alone is not)
       or new.params ->> 'template' is distinct from sp.template_id
       or (new.params - array['topic','niche','language','series','template']) <> '{}'::jsonb then
      raise exception 'render job refused: it is not the job its series plan queued'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- A signed-in browser that may not start runs on this channel gets the
  -- insert policy's refusal here, before anything below can tell it whether
  -- a channel or a hold exists. (The API functions run with the key's anon
  -- role and do their own channel check; the service key is trusted.)
  if coalesce(auth.role(), '') = 'authenticated'
     and not (new.channel_id in (select public.accessible_channel_ids('admin'))) then
    raise exception 'new row violates row-level security policy for table "render_jobs"'
      using errcode = '42501';
  end if;

  select c.org_id, c.agent_config into v_org, v_cfg
    from public.channels c where c.channel_id = new.channel_id;
  if v_org is null then
    raise exception 'render job refused: channel % belongs to no organization', new.channel_id
      using errcode = '42501';
  end if;
  -- 0076: a job linked to a scene regeneration is the one job its request
  -- queued — a repair of that scene, with that regeneration's own hold —
  -- for every organization, the operator's included.
  if new.scene_regeneration_id is not null then
    select * into sr from public.scene_regenerations where id = new.scene_regeneration_id;
    if sr.id is null or new.kind <> 'repair' or sr.channel_id <> new.channel_id
       or sr.status <> 'queued' or sr.render_job_id is not null
       or sr.credit_ref is distinct from new.credit_ref or new.api_hold_ref is not null
       or new.params ->> 'repair_scenes' is distinct from sr.scene_id
       or new.params ->> 'topic' is distinct from sr.slug
       or coalesce((new.params ->> 'resume')::boolean, false) then
      raise exception 'render job refused: it is not the job its scene regeneration queued'
        using errcode = '42501';
    end if;
  end if;
  -- The operator's own organization never pays (0020) and its runs keep the
  -- channel's own target length, exactly as before this migration.
  if public.credits_exempt(v_org) then
    return new;
  end if;

  -- 0111 (audit D8): the platform chooses the providers of a customer's run. A run is priced flat
  -- (credit_prices / api_prices), so a customer who named Veo or Kling would spend a funded vendor
  -- key at a price that does not cover it. The routes already refuse both fields (browser, API,
  -- MCP); this is the same rule in the one place no route can be bypassed. A blank or null value is
  -- not a choice and passes here; render_job_params_valid still refuses it as a provider id.
  -- Insert only: a queued job's params are frozen afterwards by render_jobs_terms_frozen.
  if coalesce(nullif(btrim(new.params ->> 'video_provider'), ''),
              nullif(btrim(new.params ->> 'image_provider'), '')) is not null then
    raise exception 'render job refused: video_provider and image_provider cannot be set for this organization'
      using errcode = '42501',
            hint = 'Leave them out: the platform chooses the providers of a paid run.';
  end if;

  -- C2: a customer run is paid for — whatever NIGHTSHIFT_CREDITS_ENFORCE says.
  if new.credit_ref is null and new.api_hold_ref is null then
    raise exception 'render job refused: a run for this organization must carry its credit hold'
      using errcode = '42501',
            hint = 'Start it from the Command Center with credits enforced (NIGHTSHIFT_CREDITS_ENFORCE).';
  end if;
  if new.credit_ref is not null and new.api_hold_ref is not null then
    raise exception 'render job refused: a run is paid by one hold, not two' using errcode = '42501';
  end if;

  -- 0076: a scene regeneration is priced per scene, not per minute of video.
  -- Its hold is its own (the reference the request placed): open, never
  -- started, this organization's, and at least the quote. The whole-video
  -- length floor below does not apply to one scene, and no length is frozen.
  if new.scene_regeneration_id is not null then
    select * into r from public.credit_reservations where job_id = new.credit_ref;
    if r.job_id is null or r.org_id is distinct from v_org or r.status <> 'open'
       or r.started_at is not null or sr.quoted_credits is null or r.amount < sr.quoted_credits then
      raise exception 'render job refused: its credit hold is not this scene regeneration''s open hold'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- C1: freeze the length the hold is for. A job that names its length keeps
  -- it (render_jobs_params_check holds it to whole seconds, 30..3600); one
  -- that does not gets the channel's target as it is NOW, capped the same way.
  new.params := coalesce(new.params, '{}'::jsonb);
  if new.params ? 'duration' then
    if jsonb_typeof(new.params -> 'duration') <> 'number' then
      raise exception 'render job refused: duration must be a whole number of seconds'
        using errcode = '22023';
    end if;
    v_secs := (new.params ->> 'duration')::numeric;
  else
    if jsonb_typeof(v_cfg -> 'target_duration_seconds') = 'number' then
      v_secs := (v_cfg ->> 'target_duration_seconds')::numeric;
    end if;
    if v_secs is null or v_secs <= 0 then
      raise exception 'render job refused: a paid run needs a length'
        using errcode = '22023',
              hint = 'Choose a length, or set the channel''s target length.';
    end if;
    v_secs := least(greatest(round(v_secs), 30), 3600);
    new.params := new.params || jsonb_build_object('duration', v_secs::integer);
  end if;

  if new.api_hold_ref is not null then
    -- (a) is the policy's; here: the hold is this organization's, open, and
    -- not already paying for another job or a download. 0031's
    -- api_create_video priced it for this length in this same transaction.
    select * into h from public.api_holds where ref = new.api_hold_ref;
    if h.ref is null or h.org_id is distinct from v_org or h.status <> 'open'
       or h.started_at is not null or h.render_job_id is not null
       or h.download_request_id is not null then
      raise exception 'render job refused: its API balance hold is not an open, unused hold of this organization'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- (b) the credit hold: this organization's, a queue reference, open, never
  -- started (a started hold is paying for a run already), not expired.
  if new.credit_ref !~ '^rj-' then
    raise exception 'render job refused: a queued run is paid by a queue credit hold (rj-…)'
      using errcode = '42501';
  end if;
  select * into r from public.credit_reservations where job_id = new.credit_ref;
  if r.job_id is null or r.org_id is distinct from v_org or r.status <> 'open'
     or r.started_at is not null or r.created_at < now() - interval '3 hours' then
    raise exception 'render job refused: its credit hold is not an open, unused hold of this organization'
      using errcode = '42501';
  end if;

  -- The hold covers the frozen length: modules/credits.minimum_reservation.
  -- job_minimum is a flat floor (margin ignored, as in reserve_credits);
  -- video_minute is credits per minute with its margin. Unset = no floor.
  select credits_per_unit into jm from public.credit_prices where unit = 'job_minimum';
  select * into vm from public.credit_prices where unit = 'video_minute';
  v_need := greatest(coalesce(jm, 0),
                     coalesce(vm.credits_per_unit * (1 + vm.margin) * v_secs / 60, 0));
  v_need := public.credits_round_up(v_need);
  if v_need > 0 and r.amount < v_need then
    raise exception 'render job refused: its credit hold does not cover a run of % seconds', v_secs::integer
      using errcode = '22023',
            hint = 'Reserve for the length you run, or choose a shorter one.';
  end if;
  return new;
end
$$;


revoke all on function public.render_jobs_payment_guard() from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. request_series_plan: a new signature is a new function
-- ───────────────────────────────────────────────────────────────────────────

-- 0120's body verbatim, plus the lines marked 0122: p_template (default NULL, so PostgREST's named-argument call and the seven-argument positional
-- call both reach it unchanged), its validation, its place in the idempotency hash, the column and the job param. REVOKED FROM EVERYONE right
-- after it is created, exactly as 0120 revoked the old signature, and granted to nobody.

create or replace function public.request_series_plan(
  p_channel text, p_topic text, p_n integer, p_language text, p_duration_s integer, p_series text, p_idem text,
  p_template text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid      uuid := auth.uid();
  ch       public.channels;
  se       public.content_series;
  v_org    uuid;
  v_topic  text := btrim(coalesce(p_topic, ''));
  v_lang   text := coalesce(nullif(btrim(coalesce(p_language, '')), ''), 'English');
  v_series text := nullif(btrim(coalesce(p_series, '')), '');
  v_niche  text;
  v_hash   text;
  prior    public.series_plans;
  v_id     uuid := gen_random_uuid();
  v_job    bigint;
  v_limit  integer := public.series_plan_daily_limit();
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into ch from public.channels where channel_id = p_channel;
  -- A channel that does not exist and a channel of another organization are the same answer.
  if ch.channel_id is null or ch.org_id is null or not public.is_org_member(ch.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_org := ch.org_id;
  if not public.is_org_member(v_org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_idem is null or p_idem !~ '^[A-Za-z0-9_:.-]{8,128}$' then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;
  if char_length(v_topic) not between 1 and 300 or v_topic ~ '[[:cntrl:]]' then
    raise exception 'invalid_topic' using errcode = '22023';
  end if;
  if p_n is null or p_n not in (3, 4) then
    raise exception 'invalid_episode_count' using errcode = '22023';
  end if;
  if p_duration_s is null or p_duration_s not between 30 and 3600 then
    raise exception 'invalid_duration' using errcode = '22023';
  end if;
  if v_lang !~ '^[A-Za-z][A-Za-z -]{0,39}$' then
    raise exception 'invalid_language' using errcode = '22023';
  end if;
  -- 0122: the format is NULL (none asked for) or exactly one of the closed list. Not trimmed, not lower-cased, not defaulted: an empty string, another
  -- case or an unknown word is refused, never read as "no format" (the same list is in series_plans_template_check and render_job_params_valid).
  if p_template is not null and p_template not in ('myth_vs_fact', 'top5_countdown', 'one_question_one_answer') then
    raise exception 'invalid_template' using errcode = '22023';
  end if;

  -- The series, when one is named, is this channel's own (a series id is global; another channel's is not found, not "forbidden").
  if v_series is not null then
    select * into se from public.content_series where series_id = v_series and channel_id = ch.channel_id;
    if se.series_id is null then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
  end if;
  -- The niche is the series' or the channel's, from the database; the browser does not choose it. A plan with no niche has no
  -- off-niche screening at all (modules/series_planner: no_niche), so it is refused before anything is queued (rule 6).
  v_niche := left(btrim(regexp_replace(coalesce(nullif(btrim(coalesce(se.niche, '')), ''), ch.niche, ''), '[[:cntrl:]]', ' ', 'g')), 120);
  v_niche := btrim(v_niche);
  if v_niche = '' then
    raise exception 'no_niche' using errcode = '22023';
  end if;

  -- Presses of one organization take turns: a double click, a second tab or a second editor waits here, then sees the first one's row, and two
  -- concurrent requests cannot both pass the cap.
  perform pg_advisory_xact_lock(hashtextextended('series_plan:' || v_org::text, 0));

  -- 0122: the format is part of what was asked, so a replay with another format is idempotency_conflict. With NO format the object is exactly
  -- 0120's, so the hash of a request without a format is the one 0120 computed (a plan made before this migration still replays).
  v_hash := md5((jsonb_build_object('channel', ch.channel_id, 'topic', v_topic, 'n', p_n, 'language', v_lang,
                                    'duration', p_duration_s, 'series', v_series)
                 || case when p_template is null then '{}'::jsonb else jsonb_build_object('template', p_template) end)::text);
  select * into prior from public.series_plans where org_id = v_org and idempotency_key = p_idem;
  if prior.id is not null then
    if prior.request_hash <> v_hash then
      raise exception 'idempotency_conflict' using errcode = 'NS409';
    end if;
    -- The same press again (a retry, a replay): its plan and job, nothing queued twice.
    return jsonb_build_object('id', prior.id, 'status', prior.status, 'render_job_id', prior.render_job_id, 'replayed', true);
  end if;

  -- A plan that was never finished frees its channel after two hours, and its queue row with it (only if no worker has it).
  with expired as (
    update public.series_plans
       set status = 'failed', error_code = 'expired', error = 'planning did not finish in time', finished_at = now()
     where channel_id = ch.channel_id and status = 'requested' and created_at < now() - interval '2 hours'
    returning id)
  update public.render_jobs j
     set status = 'cancelled', finished_at = now(), error = 'the series plan expired before a worker took it'
   where j.series_plan_id in (select id from expired) and j.status = 'queued';

  if exists (select 1 from public.series_plans where channel_id = ch.channel_id and status = 'requested') then
    raise exception 'plan_in_progress' using errcode = 'NS409';
  end if;
  if (select count(*) from public.series_plans
       where org_id = v_org and created_at > now() - interval '24 hours') >= v_limit then
    raise exception 'rate_limited' using errcode = 'NS429', detail = format('limit=%s per 24 hours', v_limit);
  end if;

  insert into public.series_plans (id, org_id, channel_id, series_id, topic, niche, language, n_episodes, duration_s, template_id,
                                   idempotency_key, request_hash, requested_by)
  values (v_id, v_org, ch.channel_id, v_series, v_topic, v_niche, v_lang, p_n, p_duration_s, p_template, p_idem, v_hash, uid);

  -- The planning job: one model call, no length, no provider, no voice, no hold. render_jobs_payment_guard checks it is exactly the job this
  -- plan queued (0122: the format included; a NULL format is stripped, so the job then carries none).
  insert into public.render_jobs (channel_id, kind, params, requested_by, series_plan_id)
  values (ch.channel_id, 'series_plan',
          jsonb_strip_nulls(jsonb_build_object('topic', v_topic, 'niche', v_niche, 'language', v_lang, 'series', v_series,
                                               'template', p_template)),
          uid, v_id)
  returning id into v_job;
  update public.series_plans set render_job_id = v_job where id = v_id;

  return jsonb_build_object('id', v_id, 'status', 'requested', 'render_job_id', v_job, 'replayed', false);
end
$$;


revoke all on function public.request_series_plan(text, text, integer, text, integer, text, text, text) from public, anon, authenticated, service_role;

-- The old signature goes: it is not the one the application calls once p_template exists, and keeping it would keep a second function to
-- review, revoke and grant. The guard above proved it is 0120's body and executable by nobody. No cascade: if anything depends on it, this fails
-- and the whole file rolls back.
drop function if exists public.request_series_plan(text, text, integer, text, integer, text, text);

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
-- If any of this is false the whole file rolls back (apply as one transaction). It restates the pins above: the three replaced bodies are this
-- file's, the old signature is gone, the new one exists and is executable by nobody, and the column is the right type with the right check.
do $$
declare
  new_oid oid := to_regprocedure('public.request_series_plan(text, text, integer, text, integer, text, text, text)');
begin
  if to_regprocedure('public.request_series_plan(text, text, integer, text, integer, text, text)') is not null then
    raise exception '0122 end state: the seven-argument request_series_plan() is still there';
  end if;
  if new_oid is null then
    raise exception '0122 end state: the eight-argument request_series_plan() does not exist';
  end if;
  if exists (select 1 from pg_proc p
              where p.oid = new_oid
                and (p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a
                                 where a.grantee = 0
                                    or a.grantee in (select r.oid from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role'))))) then
    raise exception '0122 end state: request_series_plan() is executable by public or an API role, and it must be granted to nobody';
  end if;
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.render_job_params_valid(jsonb, text)'::regprocedure) <> 'a9367e46ea79e8d57ce1c876333b5508'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.render_jobs_payment_guard()'::regprocedure) <> '3807936ade6801fa20da292e27fa7f64'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.series_plans_terms_frozen()'::regprocedure) <> '4c3b97a9d5d400a9a8cf900aa23c5ab2'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = new_oid) <> 'e38342a6c8511d5eadb1f99ab38fb6aa' then
    raise exception '0122 end state: a replaced function does not hold this file''s body';
  end if;
  if not exists (select 1 from pg_attribute
                  where attrelid = 'public.series_plans'::regclass and attname = 'template_id' and atttypid = 'text'::regtype and not attisdropped and not attnotnull) then
    raise exception '0122 end state: series_plans.template_id is not a nullable text column';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.series_plans'::regclass and conname = 'series_plans_template_check' and convalidated) then
    raise exception '0122 end state: series_plans_template_check is missing or not validated';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor on the live project after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     not has_function_privilege('authenticated', 'public.request_series_plan(text,text,integer,text,integer,text,text,text)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.request_series_plan(text,text,integer,text,integer,text,text,text)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.request_series_plan(text,text,integer,text,integer,text,text,text)', 'EXECUTE')
--       as still_granted_to_nobody,
--     to_regprocedure('public.request_series_plan(text,text,integer,text,integer,text,text)') is null as old_signature_gone,
--     (select pg_get_constraintdef(oid) like '%top5_countdown%' from pg_constraint
--       where conrelid = 'public.series_plans'::regclass and conname = 'series_plans_template_check') as template_check,
--     position('0122' in pg_get_functiondef('public.render_jobs_payment_guard()'::regprocedure)) > 0
--       and position('0122' in pg_get_functiondef('public.render_job_params_valid(jsonb,text)'::regprocedure)) > 0
--       and position('0122' in pg_get_functiondef('public.series_plans_terms_frozen()'::regprocedure)) > 0 as three_replaced,
--     public.render_job_params_valid('{"topic":"t","niche":"n","template":"myth_vs_fact"}', 'series_plan')
--       and not public.render_job_params_valid('{"topic":"t","niche":"n","template":"nope"}', 'series_plan')
--       and not public.render_job_params_valid('{"topic":"t","template":"myth_vs_fact"}', 'daily')
--       and not public.render_job_params_valid('{"topic":"t","niche":"n","template":null}', 'series_plan') as template_key_checked;
--
-- Plans that asked for a format (expected: none while request_series_plan is granted to nobody):
--   select id, channel_id, template_id, created_at from public.series_plans where template_id is not null;
