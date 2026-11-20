-- 0187_rights_acknowledgement_inputs.sql — the rights acknowledgement (0174) asks about every file a job SENDS, on the model it
-- RUNS: failover, style kit pictures, @character pictures and the Film Studio.
--
-- EVIDENCE (tests/security/test_sec_breach_rights_ack_bypass.py and test_sec_breach_rights_ack_films.py, Breach on #780; each
--   failed on main at 0174 and passes on this file):
--   * failover: an auto-mode job created for a model that requires nothing is moved by reroute_creative_job (0088), with the same
--     params and the same uploaded photo, to the next candidate, which may require likeness_photo. reroute never asked.
--   * style kits: params.style_kit_id hands the kit's reference pictures to the provider (0048 creative_job_style); 0174's
--     rights_acknowledgement_missing read only params.source_asset_id and params.end_asset_id.
--   * @characters: an @name in the prompt hands that character's pictures to the provider (0048), with no params key at all.
--   * films: start_film (0171) prices, holds and plans a clip take whose first frame is the person's upload, for a clip model that
--     requires likeness_photo; the worker writes the take's creative job directly (payer 'film'), never through
--     create_creative_job, so nothing ever asked. 0174's header left the Film Studio to a follow-up: this is it.
--
-- DIAGNOSIS: 0174 asked about two params keys of the model a job was CREATED for. The files a job sends are more than those two
--   keys, and the model it runs can change after it was created. Each path that decides "this model gets these files" has to ask.
--
-- CHANGE (additive; five function bodies replaced, four of them with marked hunks; three functions added):
--   rights_acknowledgement_subjects(org, params)   NEW. Every file a generation sends: source, end, the style kit's live pictures,
--     every live picture of every mentioned @character (the same regular expression and 16-name limit as 0048). A style_kit_id
--     that is not a uuid is kept as a subject that can never be acknowledged (fail closed).
--   rights_acknowledgement_missing_among(org, user, model, subjects[])   NEW. 0174's loop over a list of files.
--   rights_acknowledgement_missing(org, user, model, params)   0174's signature, now among(subjects(params)). create_creative_job
--     (and so the Studio, the public API, the MCP server, region edit and every workflow step) asks through it unchanged.
--   reroute_creative_job (0088's body, one marked hunk): a candidate that rights_acknowledgement_missing refuses for the job's
--     requester (creative_jobs.requested_by) is skipped, exactly like one off sale or dearer than the hold. No requester: skipped.
--   film_acknowledgement_missing(film, user)   NEW. Per scene: the clip model with the uploaded first/last frame; for a key frame
--     scene, the key frame model with the film's and the scene's reference pictures, their characters' pictures and the style kit.
--   start_film (0171's body, one marked hunk): after the re-pricing and BEFORE the hold, the segment and every take, returns
--     {ok:false, reason:'acknowledgement_required', code:'NS400', detail:'kind=… version=… subject=…'} (the detail is the shape
--     the Studio's dialog already parses). quote_film does not ask: a quote holds nothing (0174's rule). The Timeline names the
--     refusal and its remedy (lib/i18n/studio-timeline/*: confirm the picture once in the Studio, or choose another model).
--   workflow_quote_steps (0174's body, one marked hunk): a step on such a model whose params send the person's pictures without
--     naming a file (a style kit, an @character) is refused at the quote and the start, before any hold, like 0174's file inputs.
--   creative_job_style (0048's body, one marked hunk): the kit's and characters' pictures are read when the job RUNS; asked again
--     there, for the model that runs and the job's requester, so a picture added after the job was created is never handed out
--     unacknowledged (the worker fails the job before any paid call). A creative job written without requested_by (the Film
--     Studio's P3 worker, not on main yet) has nobody's acknowledgement and is refused there for such a model: P3 must write the
--     film starter as requested_by.
--
-- NOT CHANGED: which models require an acknowledgement (only the two Runway models, both unsold), every availability, every price,
--   hold and ledger rule, quote_film, sellable_models, route_model, create_creative_job, start_workflow_run (it refuses on
--   workflow_quote_steps' answer).
--   The gate is latent today: no model on sale requires an acknowledgement.
--
-- NUMBER. 0187 (assigned by Atlas; 0175 to 0178 are held elsewhere). Needs 0047, 0048, 0088, 0171 and 0174. It names nothing of
--   0175 to 0178.
--
-- REPLACES (md5 drift guard: the earlier body, or this file's own on a replay; whitespace runs read as one space):
--   rights_acknowledgement_missing and workflow_quote_steps (0174), reroute_creative_job (0088), start_film (0171),
--   creative_job_style (0048).
-- REPLAY. This file replays onto itself. Re-running 0174 after it FAILS LOUDLY (0174's guard refuses this file's
--   rights_acknowledgement_missing). Re-running 0088 or 0171 after it SILENTLY puts the old body back: apply 0187 again, then
--   run the Verify query at the end of this file.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only):
--   select p.oid::regprocedure, md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc p
--    where p.oid in ('public.rights_acknowledgement_missing(uuid, uuid, text, jsonb)'::regprocedure,
--                    'public.reroute_creative_job(uuid, text, text)'::regprocedure,
--                    'public.start_film(uuid, text, text)'::regprocedure,
--                    'public.workflow_quote_steps(public.workflows, jsonb)'::regprocedure,
--                    'public.creative_job_style(uuid, text)'::regprocedure);
--   expected BEFORE 426ea90d162535b0ee6f10e752e5fe26 (0174), 55d07640bb22798e2a74bb661ac4f8d0 (0088), 63510a6d9c456e66f658353bab592d38 (0171), 8f9f42da9844571a18a285d87bcffc84 (0174),
--     75dec758272fcad658e1712fdc7f708e (0048);
--   AFTER e7baea73e6c790ed3e8d01b797aa3732, 88ddf301ce242fafe8a8051d16ceab9e, 5468183a8f24a48f708efcbbf9d2d22c, f77e276ac50f195c746064a5633e36db, 6d8def7530c6aff386ac691eeb616115 (this file).
-- Undo: docs/sql/rollback_0187_rights_acknowledgement_inputs.sql (owner-applied): the five earlier bodies back, the three new
--   functions dropped. No table or row is touched by this file or its rollback.

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  if to_regprocedure('public.rights_acknowledgement_required(text)') is null
     or to_regclass('public.rights_acknowledgements') is null then
    raise exception '0187 needs the rights acknowledgement: apply 0174_rights_acknowledgement.sql first';
  end if;
  if to_regclass('public.style_kit_references') is null or to_regclass('public.character_references') is null then
    raise exception '0187 needs the style kits and characters: apply 0047_style_kits_characters.sql first';
  end if;
  if to_regclass('public.film_refs') is null or to_regprocedure('public.start_film(uuid, text, text)') is null then
    raise exception '0187 needs the Film Studio: apply 0166_films_core.sql and 0171_films_money.sql first';
  end if;
  for r in select * from (values
      ('public.rights_acknowledgement_missing(uuid, uuid, text, jsonb)', '426ea90d162535b0ee6f10e752e5fe26', 'e7baea73e6c790ed3e8d01b797aa3732', '0174'),
      ('public.reroute_creative_job(uuid, text, text)', '55d07640bb22798e2a74bb661ac4f8d0', '88ddf301ce242fafe8a8051d16ceab9e', '0088'),
      ('public.start_film(uuid, text, text)', '63510a6d9c456e66f658353bab592d38', '5468183a8f24a48f708efcbbf9d2d22c', '0171'),
      ('public.workflow_quote_steps(public.workflows, jsonb)', '8f9f42da9844571a18a285d87bcffc84', 'f77e276ac50f195c746064a5633e36db', '0174'),
      ('public.creative_job_style(uuid, text)', '75dec758272fcad658e1712fdc7f708e', '6d8def7530c6aff386ac691eeb616115', '0048')) v(sig, was, now_, src) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is null or h <> all (array[r.was, r.now_]) then
      raise exception '0187 found % with a body that is neither %''s nor 0187''s (md5 %): read the live body first', r.sig, r.src, h;
    end if;
  end loop;
  for r in select * from (values
      ('public.rights_acknowledgement_subjects(uuid, jsonb)', '8de7e1ebe43848d31f556a0f7e4047a9'),
      ('public.rights_acknowledgement_missing_among(uuid, uuid, text, text[])', 'f3a844885ec3b4fc3b0d45dc80f5e65b'),
      ('public.film_acknowledgement_missing(public.films, uuid)', '557f17de613be61b95da87fa34d5556f')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is not null and h <> r.want then
      raise exception '0187 found % with a body that is not this file''s (md5 %): read the live body first', r.sig, h;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Every file a job sends, and the first one this person has not acknowledged
-- ───────────────────────────────────────────────────────────────────────────

-- The files a generation with these params sends to its model, in order, each once: the source and end files (0156), then the
-- style kit's reference pictures (0047/0048, in the kit's order), then the reference pictures of every @character the prompt
-- mentions (in order of first mention, at most 16 names, exactly as creative_job_style and modules/creative_style.py read
-- them). Deleted or purged pictures are left out because the worker never sends them. A style_kit_id that is not a uuid is
-- returned as it is, and it can never be acknowledged: a malformed id fails closed instead of meaning "no kit".
create or replace function public.rights_acknowledgement_subjects(p_org uuid, p_params jsonb) returns text[]
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  out_ text[] := '{}';
  kit  text;
begin
  if jsonb_typeof(p_params) is distinct from 'object' then
    return out_;
  end if;
  out_ := array_remove(array[p_params ->> 'source_asset_id', p_params ->> 'end_asset_id'], null);
  kit := p_params ->> 'style_kit_id';
  if kit is not null then
    if kit !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      out_ := out_ || kit;
    else
      out_ := out_ || array(
        select r.asset_id::text
          from public.style_kit_references r
          join public.media_assets a on a.id = r.asset_id
         where r.kit_id = kit::uuid and r.org_id = p_org and a.org_id = p_org
           and a.deleted_at is null and a.purged_at is null
         order by r.position);
    end if;
  end if;
  out_ := out_ || array(
    with mentioned as (
      select lower(m.x[1]) as name, min(m.o) as first_at
        from regexp_matches(coalesce(p_params ->> 'prompt', ''),
                            '(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{2,32})(?![A-Za-z0-9_])', 'g')
             with ordinality as m(x, o)
       group by lower(m.x[1])
       order by min(m.o)
       limit 16
    )
    select r.asset_id::text
      from mentioned
      join public.characters c on c.name = mentioned.name and c.org_id = p_org
      join public.character_references r on r.character_id = c.id and r.org_id = p_org
      join public.media_assets a on a.id = r.asset_id
     where a.org_id = p_org and a.deleted_at is null and a.purged_at is null
     order by mentioned.first_at, r.position);
  return array(select x from unnest(out_) with ordinality u(x, n) group by x order by min(n));
end
$$;

-- 0174's loop, over a list of files instead of two params keys: the first (kind, subject) of p_subjects that p_user has not
-- acknowledged in p_org at the current text version, or NULL. An entry that is not a uuid counts as not acknowledged.
create or replace function public.rights_acknowledgement_missing_among(p_org uuid, p_user uuid, p_model text, p_subjects text[])
  returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  kinds text[] := public.rights_acknowledgement_required(p_model);
  k     text;
  v     text;
  s     text;
begin
  if cardinality(kinds) = 0 then
    return null;
  end if;
  foreach k in array kinds loop
    select text_version into v from public.rights_acknowledgement_kinds where kind = k;
    for s in select x from unnest(coalesce(p_subjects, '{}')) with ordinality u(x, n) where x is not null order by n loop
      if v is null
         or s !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or not exists (select 1 from public.rights_acknowledgements a
                         where a.org_id = p_org and a.user_id = p_user and a.kind = k
                           and a.text_version = v and a.subject_asset_id = s::uuid) then
        return jsonb_build_object('kind', k, 'text_version', v, 'subject', s);
      end if;
    end loop;
  end loop;
  return null;
end
$$;

-- 0174's signature and contract, now over every file the job sends (rights_acknowledgement_subjects). create_creative_job,
-- workflow steps (through create_creative_job) and reroute_creative_job all ask through this one function.
create or replace function public.rights_acknowledgement_missing(p_org uuid, p_user uuid, p_model text, p_params jsonb)
  returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  -- Most models require nothing: answered before the prompt is read for @names.
  if cardinality(public.rights_acknowledgement_required(p_model)) = 0 then
    return null;
  end if;
  return public.rights_acknowledgement_missing_among(p_org, p_user, p_model,
                                                     public.rights_acknowledgement_subjects(p_org, p_params));
end
$$;

-- The first file of a film that p_user has not acknowledged for a model of the film that requires it, or NULL. Per scene, in
-- scene order: the clip model (the scene's, else the film's) with the scene's uploaded first and last frames and the pictures of
-- every @character its visual prompt mentions; then, for a scene whose first frame is a key frame, the key frame model with the
-- film's and the scene's reference pictures, every picture of their characters, the @characters of the visual prompt (the key
-- frame's params.prompt, which the worker reads for @names), and the film's style kit pictures. A key frame the film makes itself is the model's output,
-- not the person's file, and is not asked about.
create or replace function public.film_acknowledgement_missing(p_film public.films, p_user uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  r    record;
  miss jsonb;
  kit  text[] := public.rights_acknowledgement_subjects(p_film.org_id,
                   case when p_film.style_kit_id is null then '{}'::jsonb
                        else jsonb_build_object('style_kit_id', p_film.style_kit_id) end);
begin
  for r in
    select s.position, 1 as part, coalesce(s.clip_model, p_film.clip_model) as model,
           array_remove(array[case when s.first_frame = 'asset' then s.first_frame_asset_id::text end,
                              case when s.last_frame = 'asset' then s.last_frame_asset_id::text end], null)
           || public.rights_acknowledgement_subjects(p_film.org_id, jsonb_build_object('prompt', s.visual_prompt)) as subjects
      from public.film_scenes s
     where s.film_id = p_film.id
    union all
    select s.position, 2, coalesce(s.keyframe_model, p_film.keyframe_model),
           array(select x.id from (
                   select fr.position as p, 0 as q, fr.asset_id::text as id
                     from public.film_refs fr
                    where fr.film_id = p_film.id and (fr.scene_id is null or fr.scene_id = s.id) and fr.asset_id is not null
                   union all
                   select fr.position, cr.position, cr.asset_id::text
                     from public.film_refs fr
                     join public.character_references cr on cr.character_id = fr.character_id and cr.org_id = p_film.org_id
                     join public.media_assets a on a.id = cr.asset_id
                    where fr.film_id = p_film.id and (fr.scene_id is null or fr.scene_id = s.id)
                      and a.deleted_at is null and a.purged_at is null) x
                 order by x.p, x.q)
           || public.rights_acknowledgement_subjects(p_film.org_id, jsonb_build_object('prompt', s.visual_prompt)) || kit
      from public.film_scenes s
     where s.film_id = p_film.id and s.first_frame = 'keyframe'
     order by 1, 2
  loop
    continue when r.model is null or cardinality(r.subjects) = 0;
    miss := public.rights_acknowledgement_missing_among(p_film.org_id, p_user, r.model, r.subjects);
    if miss is not null then
      return miss;
    end if;
  end loop;
  return null;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Failover asks for the model it moves to (0088's body, one marked hunk)
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
    update public.creative_jobs
       set fallback_from = j.routed_model, fallback_reason = 'unavailable', routed_model = m,
           routed_credits = price, params = jparams, submit_started_at = null,
           credit_unit = coalesce(q ->> 'unit', j.credit_unit),
           quantity = coalesce((q ->> 'quantity')::numeric, j.quantity),
           heartbeat_at = now(), updated_at = now()
     where id = p_job;
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

-- ───────────────────────────────────────────────────────────────────────────
-- 3. A film asks before it holds (0171's body, one marked hunk)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.start_film(p_film uuid, p_quote_id text, p_idempotency_key text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  org     uuid;
  f       public.films;
  s       public.film_segments;
  q       jsonb;
  st      jsonb;
  ln      jsonb;
  bad     jsonb;
  sid     uuid := gen_random_uuid();
  ref     text;
  exempt_ boolean;
  total   numeric;
  hash    text;
  asm     jsonb;
  n_takes integer := 0;
  v       integer;
  w       text;
  d       text;
  msg     text;
  fq      public.film_quotes;
  lim     jsonb := public.film_money_limits();
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select x.org_id into org from public.films x where x.id = p_film;
  if org is null or not public.is_org_member(org, 'viewer') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  exempt_ := public.credits_exempt(org);
  -- 0020's rule for a paid run; in the exempt organization the platform pays, so only its owner or admin may.
  if not public.is_org_member(org, 'admin') or (exempt_ and not public.is_platform_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$' then
    perform public.creative_refuse('invalid_idempotency_key', 'the idempotency key must be 8 to 128 letters, digits or _.:-');
  end if;
  if p_quote_id is null or p_quote_id !~ '^fq-[0-9]{1,9}-[0-9a-f]{32}$' then
    perform public.creative_refuse('invalid_params', 'quote_id must be the quote_id quote_film answered');
  end if;
  hash := md5(jsonb_build_object('film', p_film, 'quote', p_quote_id)::text);

  -- One start per organization at a time: the replay lookup, the active-film count and the hold cannot be raced.
  perform pg_advisory_xact_lock(hashtextextended('film_start:' || org::text, 0));
  select * into s from public.film_segments where org_id = org and idempotency_key = p_idempotency_key;
  if found then
    if s.request_hash <> hash then
      perform public.creative_refuse('idempotency_conflict', 'this idempotency key was used to start another film or quote', 'NS409');
    end if;
    return public.film_segment_json(s) || jsonb_build_object('ok', true, 'replayed', true);
  end if;

  -- The cheap refusals, before anything is counted or priced.
  select * into f from public.films where id = p_film for no key update;
  if not public.film_is_editable(f.status) then
    perform public.creative_refuse('film_not_startable', format('a %s film cannot be started', f.status), 'NS409');
  end if;
  if split_part(p_quote_id, '-', 2)::integer <> f.version then
    perform public.creative_refuse('film_changed',
      format('the film was edited after this quote (it is at version %s); quote it again', f.version), 'NS409');
  end if;
  if not public.film_studio_on() then
    perform public.creative_refuse('film_studio_disabled', 'Film Studio is not switched on yet; nothing was held', 'NS409');
  end if;
  -- Cheap checks of what pricing would refuse (a model off sale or turned Seedance, a reference or frame that is gone): raised with
  -- the line's own word, before anything is counted or priced.
  bad := public.film_precheck(f);
  if bad is not null then
    perform public.creative_refuse(bad ->> 'reason', bad ->> 'detail');
  end if;
  perform public.film_take_rate('start', (lim ->> 'starts_per_hour')::integer);

  -- Counted: from here every refusal is returned, so the counter commits with it. The stored quote first (no pricing yet).
  select * into fq from public.film_quotes x where x.film_id = f.id and x.quote_id = p_quote_id and x.version = f.version;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'price_changed', 'code', 'NS409',
                              'detail', 'this is not a quote of the film as it stands; quote it again');
  end if;
  if fq.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'quote_expired', 'code', 'NS409',
                              'detail', 'this quote has expired; quote it again');
  end if;
  st := public.film_settings_of(org);
  if not exempt_ and fq.total > public.film_available(org) then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_credits', 'code', 'NS402',
                              'detail', format('available=%s needed=%s', public.film_available(org), fq.total));
  end if;
  if st ->> 'max_credits_per_film' is not null and fq.total > (st ->> 'max_credits_per_film')::numeric then
    return jsonb_build_object('ok', false, 'reason', 'cap_exceeded', 'code', 'NS400',
      'detail', format('this film costs %s credits and the organization allows %s a film', fq.total, st ->> 'max_credits_per_film'));
  end if;
  if (select count(*) from public.film_segments x where x.org_id = org and x.status in ('queued', 'running', 'draining'))
     >= (st ->> 'max_active_films')::integer then
    return jsonb_build_object('ok', false, 'reason', 'limit_reached', 'code', 'NS400',
      'detail', format('at most %s films of this organization run at once; wait for one to finish', st ->> 'max_active_films'));
  end if;

  -- Then the re-pricing, at today's rates: what was confirmed is what is held, in either direction.
  q := public.film_price(f);
  if not (q ->> 'priced')::boolean then
    bad := q -> 'refusals' -> 0;
    return jsonb_build_object('ok', false, 'reason', bad ->> 'reason', 'code', 'NS400', 'detail', bad ->> 'detail');
  end if;
  total := (q ->> 'total')::numeric;
  if q ->> 'quote_id' <> p_quote_id then
    return jsonb_build_object('ok', false, 'reason', 'price_changed', 'code', 'NS409',
                              'detail', format('the price is now %s credits; quote it again', total));
  end if;
  -- 0187: a film sends the person's own files to its models too (a clip's uploaded first or last frame; a key frame's
  -- reference pictures, @characters and style kit). A model that requires a rights acknowledgement refuses here, after the
  -- price (a line refused anyway never asks) and before the hold and every take, unless THIS person (the one starting the
  -- film, who pays for it) acknowledged each such file at the CURRENT text version. The takes' jobs are written later by the
  -- worker, never through create_creative_job, so this is the only place a film asks.
  bad := public.film_acknowledgement_missing(f, uid);
  if bad is not null then
    return jsonb_build_object('ok', false, 'reason', 'acknowledgement_required', 'code', 'NS400',
      'detail', format('kind=%s version=%s subject=%s', bad ->> 'kind', coalesce(bad ->> 'text_version', 'none'), bad ->> 'subject'));
  end if;

  -- The hold: 0020's reserve_credits in the admin's own session, before anything is created. Its two refusals (NS402 with available
  -- and needed; NS429 when the plan's parallel runs are in use) are returned with their codes. Nothing is held in the exempt
  -- organization or for a total of 0.
  ref := 'fm-' || replace(sid::text, '-', '');
  if exempt_ or total = 0 then
    ref := null;
  else
    begin
      perform public.reserve_credits(org, ref, total);
    exception when sqlstate 'NS402' or sqlstate 'NS429' or sqlstate '22023' or sqlstate '23505' then
      get stacked diagnostics w = returned_sqlstate, d = pg_exception_detail, msg = message_text;
      if w in ('22023', '23505') then
        -- Not a customer's state (credits, slots) but a refusal of the hold itself: recorded, so someone looks at it.
        perform public.film_log(f.id, org, null, 'start_refused',
          jsonb_build_object('reason', 'hold_refused', 'code', w, 'quote_id', p_quote_id, 'credits', total,
                             'message', left(coalesce(nullif(d, ''), msg), 200)));
      end if;
      return jsonb_build_object('ok', false,
                                'reason', case w when 'NS402' then 'insufficient_credits' when 'NS429' then 'run_slots_full'
                                                 else 'hold_refused' end,
                                'code', w, 'detail', coalesce(nullif(d, ''), msg));
    end;
  end if;

  select l into asm from jsonb_array_elements(q -> 'lines') l where l ->> 'line' = 'assembly';
  insert into public.film_segments (id, film_id, org_id, n, purpose, film_version, quote_id, status, credit_ref, exempt,
                                    confirmed_credits, assembly_minutes, assembly_unit_credits, assembly_confirmed_credits,
                                    max_attempts, idempotency_key, request_hash, created_by)
  values (sid, f.id, org, coalesce((select max(x.n) from public.film_segments x where x.film_id = f.id), 0) + 1, 'initial',
          f.version, p_quote_id, 'queued', ref, exempt_, total, (asm ->> 'quantity')::integer,
          (asm ->> 'credits_per_unit')::numeric, (asm ->> 'credits')::numeric,
          (lim ->> 'max_attempts')::integer, p_idempotency_key, hash, uid)
  returning * into s;

  for ln in select l from jsonb_array_elements(q -> 'lines') l where l ->> 'line' in ('keyframe', 'clip', 'extend', 'narration') loop
    -- The next version of this scene (or of the film's narration), past every take an earlier segment made.
    v := coalesce((select max(t.version) from public.film_takes t
                    where t.film_id = f.id and t.scene_id is not distinct from (ln ->> 'scene_id')::uuid
                      and t.kind = case when ln ->> 'line' = 'narration' then 'narration' else t.kind end
                      and t.segment_id is distinct from sid), 0) + 1;
    insert into public.film_takes (film_id, org_id, scene_id, version, shot_index, kind, attempt, status, model, params, duration_s,
                                   segment_id, credit_unit, unit_credits, quantity, minimum_credits, confirmed_credits)
    values (f.id, org, (ln ->> 'scene_id')::uuid, v, (ln ->> 'shot_index')::smallint, ln ->> 'line', 1, 'planned', ln ->> 'model',
            coalesce(ln -> 'params', '{}'::jsonb), (ln ->> 'duration_s')::numeric, sid, ln ->> 'unit',
            (ln ->> 'credits_per_unit')::numeric, (ln ->> 'quantity')::numeric, (ln ->> 'minimum')::numeric,
            (ln ->> 'credits')::numeric);
    n_takes := n_takes + 1;
  end loop;

  update public.films set status = 'queued', pause_reason = null, pause_detail = null, updated_at = now() where id = f.id;
  perform public.film_log(f.id, org, null, 'started',
    jsonb_build_object('segment_id', sid, 'quote_id', p_quote_id, 'credits', total, 'held', ref is not null, 'exempt', exempt_,
                       'takes', n_takes, 'version', f.version));
  return public.film_segment_json(s) || jsonb_build_object('ok', true, 'replayed', false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3b. A workflow asks about every picture a step sends (0174's body, one marked hunk)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.workflow_quote_steps(p_wf public.workflows, p_values jsonb)
  returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  st      record;
  params  jsonb;
  stand   text;
  q       jsonb;
  steps_  jsonb := '[]'::jsonb;
  total   numeric := 0;
  bad     integer[] := '{}';
  chained boolean;
  acc     public.credit_accounts;
begin
  for st in select v, ord from jsonb_array_elements(p_wf.steps) with ordinality as t(v, ord) loop
    chained := exists (select 1 from jsonb_each(st.v -> 'params') e
                        where jsonb_typeof(e.value) = 'object' and e.value ? '$step');
    stand := null;
    if chained then
      select a.id::text into stand
        from public.media_assets a
       where a.org_id = p_wf.org_id and a.kind = 'image'
         and a.deleted_at is null and a.purged_at is null
         and public.creative_picture_problem(p_wf.org_id, a.id, 'source_asset_id') is null
       order by a.created_at desc, a.id
       limit 1;
    end if;
    params := public.workflow_fill_params(st.v -> 'params', p_values, stand);
    begin
      if chained and stand is null then
        raise exception 'source_unavailable' using errcode = 'NS400';
      end if;
      -- 0174: a step whose model makes the person confirm their rights to its input cannot run in a workflow: an input an
      -- earlier step makes does not exist yet, and a later step may run in another member's session. Refused before any
      -- hold, at the quote and at the start (start_workflow_run); such a model is used from the Studio.
      if cardinality(public.rights_acknowledgement_required(st.v ->> 'model')) > 0
         and jsonb_typeof(st.v -> 'params') = 'object'
         and (st.v -> 'params') ?| array['source_asset_id', 'end_asset_id'] then
        raise exception 'acknowledgement_required' using errcode = 'NS400';
      end if;
      -- 0187: the same for a step whose params name no file but still send the person's pictures (a style kit, an @character in
      -- its prompt): refused here, before any hold, and not at that step's own create_creative_job after earlier steps were paid
      -- for, in whichever member's session advances the run.
      if cardinality(public.rights_acknowledgement_required(st.v ->> 'model')) > 0
         and cardinality(public.rights_acknowledgement_subjects(p_wf.org_id, params)) > 0 then
        raise exception 'acknowledgement_required' using errcode = 'NS400';
      end if;
      q := public.creative_price(p_wf.org_id, st.v ->> 'capability', st.v ->> 'model', params);
      steps_ := steps_ || jsonb_build_array(jsonb_build_object(
        'step_index', st.ord - 1, 'capability', st.v ->> 'capability', 'model', st.v ->> 'model',
        'priced', true, 'credits', (q ->> 'credits')::numeric, 'unit', q ->> 'unit',
        'quantity', (q ->> 'quantity')::numeric, 'chained', chained));
      total := total + (q ->> 'credits')::numeric;
    exception when others then
      -- Never a zero: the step is unpriced and carries the database's own
      -- machine word (unpriced, model_not_sellable, source_unavailable, …).
      steps_ := steps_ || jsonb_build_array(jsonb_build_object(
        'step_index', st.ord - 1, 'capability', st.v ->> 'capability', 'model', st.v ->> 'model',
        'priced', false, 'credits', null,
        'reason', case when sqlerrm ~ '^[a-z0-9_]{1,64}$' then sqlerrm else 'unpriced' end,
        'chained', chained));
      bad := bad || (st.ord - 1)::integer;
    end;
  end loop;
  select * into acc from public.credit_accounts where org_id = p_wf.org_id;
  return jsonb_build_object(
    'workflow_id', p_wf.id, 'version', p_wf.version, 'steps', steps_,
    'priced', cardinality(bad) = 0,
    'total', case when cardinality(bad) = 0 then total end,
    'unpriced_steps', to_jsonb(bad),
    'exempt', public.credits_exempt(p_wf.org_id),
    'available', case when public.credits_exempt(p_wf.org_id) then null
                      else coalesce(acc.balance - acc.reserved, 0) end);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3c. The worker's style read asks again (0048's body, one marked hunk)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.creative_job_style(p_job uuid, p_worker text) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  j       public.creative_jobs;
  w       text := left(btrim(coalesce(p_worker, '')), 120);
  problem text;
  kit     jsonb := null;
  chars   jsonb := '[]'::jsonb;
begin
  if not public.credits_trusted_caller() then
    raise exception 'creative jobs are run by the platform''s worker only' using errcode = '42501';
  end if;
  select * into j from public.creative_jobs where id = p_job;
  -- Read before the paid call only: once 'submitting' is recorded the request
  -- has been built, and nothing is handed out again.
  if not found or j.worker_id is distinct from w or j.status <> 'running'
     or j.submit_started_at is not null then
    return jsonb_build_object('ok', false, 'problem', 'the job is not this worker''s to start');
  end if;
  -- 0187: the kit's and the characters' pictures are read here, when the job runs, and may have changed since
  -- create_creative_job asked about them (a picture added to a character while the job waited). Asked again, for the model
  -- that runs and the person who asked for the job: nothing unacknowledged is handed out, and the worker fails the job
  -- before any paid call (its hold is released).
  if public.rights_acknowledgement_missing(j.org_id, j.requested_by, coalesce(j.routed_model, j.requested_model), j.params) is not null then
    return jsonb_build_object('ok', false, 'problem',
      'a style kit or character picture of this job was changed and nobody confirmed the rights to it; confirm it in the Studio and start again');
  end if;
  if j.capability not in ('t2i', 't2v', 'edit', 'i2v') then
    return jsonb_build_object('ok', true, 'org_id', j.org_id, 'kit', null, 'characters', '[]'::jsonb);
  end if;

  if j.params ? 'style_kit_id' then
    problem := public.creative_style_problem(j.org_id, j.capability, j.params);
    if problem is not null then
      return jsonb_build_object('ok', false, 'problem', problem);
    end if;
    select jsonb_build_object(
             'id', k.id, 'org_id', k.org_id, 'description', k.description,
             'references', coalesce((
               select jsonb_agg(jsonb_build_object('asset_id', a.id, 'org_id', a.org_id, 'mime', a.mime,
                                                   'variants', to_jsonb(a.variants))
                                order by r.position)
                 from public.style_kit_references r
                 join public.media_assets a on a.id = r.asset_id
                where r.kit_id = k.id and r.org_id = j.org_id and a.org_id = j.org_id
                  and a.kind = 'image' and a.deleted_at is null and a.purged_at is null
                  and (a.mime in ('image/jpeg', 'image/png', 'image/webp')
                       or (a.mime in ('image/heic', 'image/heif') and 'display' = any (a.variants)))
             ), '[]'::jsonb))
      into kit
      from public.style_kits k
     where k.id = (j.params ->> 'style_kit_id')::uuid and k.org_id = j.org_id;
  end if;

  -- @names, as the worker reads them (modules/creative_style.py MENTION_RE):
  -- '@' not preceded by a letter, digit, '_' or '@', then 2-32 of [A-Za-z0-9_]
  -- not followed by another. Lower-cased: 0047 stores names lower-case.
  with mentioned as (
    select lower(m.x[1]) as name, min(m.o) as first_at
      from regexp_matches(coalesce(j.params ->> 'prompt', ''),
                          '(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{2,32})(?![A-Za-z0-9_])', 'g')
           with ordinality as m(x, o)
     group by lower(m.x[1])
     order by min(m.o)
     limit 16
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'org_id', c.org_id, 'name', c.name, 'description', c.description,
           'references', coalesce((
             select jsonb_agg(jsonb_build_object('asset_id', a.id, 'org_id', a.org_id, 'mime', a.mime,
                                                 'variants', to_jsonb(a.variants))
                              order by r.position)
               from public.character_references r
               join public.media_assets a on a.id = r.asset_id
              where r.character_id = c.id and r.org_id = j.org_id and a.org_id = j.org_id
                and a.kind = 'image' and a.deleted_at is null and a.purged_at is null
                and (a.mime in ('image/jpeg', 'image/png', 'image/webp')
                     or (a.mime in ('image/heic', 'image/heif') and 'display' = any (a.variants)))
           ), '[]'::jsonb))
         order by mentioned.first_at), '[]'::jsonb)
    into chars
    from mentioned
    join public.characters c on c.name = mentioned.name and c.org_id = j.org_id;

  return jsonb_build_object('ok', true, 'org_id', j.org_id, 'kit', kit, 'characters', chars);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Privileges: the replaced functions keep theirs; the new ones are internal
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.rights_acknowledgement_subjects(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.rights_acknowledgement_missing_among(uuid, uuid, text, text[]) from public, anon, authenticated, service_role;
revoke all on function public.film_acknowledgement_missing(public.films, uuid) from public, anon, authenticated, service_role;
revoke all on function public.rights_acknowledgement_missing(uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.reroute_creative_job(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.reroute_creative_job(uuid, text, text) to service_role;
revoke all on function public.start_film(uuid, text, text) from public, anon, service_role;
grant execute on function public.start_film(uuid, text, text) to authenticated;
revoke all on function public.workflow_quote_steps(public.workflows, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_job_style(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.creative_job_style(uuid, text) to service_role;

-- The end state, checked in the same transaction.
do $$
declare
  r record;
begin
  for r in select * from (values
      ('public.rights_acknowledgement_subjects(uuid, jsonb)', false, false),
      ('public.rights_acknowledgement_missing_among(uuid, uuid, text, text[])', false, false),
      ('public.film_acknowledgement_missing(public.films, uuid)', false, false),
      ('public.rights_acknowledgement_missing(uuid, uuid, text, jsonb)', false, false),
      ('public.reroute_creative_job(uuid, text, text)', false, true),
      ('public.start_film(uuid, text, text)', true, false),
      ('public.creative_job_style(uuid, text)', false, true)) v(sig, member, service) loop
    if exists (select 1 from pg_proc p where p.oid = to_regprocedure(r.sig)
                and (not p.prosecdef or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                     or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp')))
       or has_function_privilege('anon', r.sig, 'EXECUTE')
       or has_function_privilege('authenticated', r.sig, 'EXECUTE') is distinct from r.member
       or has_function_privilege('service_role', r.sig, 'EXECUTE') is distinct from r.service then
      raise exception '0187 end state: % is not a SECURITY DEFINER with the pinned search_path and the intended grants', r.sig;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying, AND after any manual replay of 0088 or 0171; every column should read true).
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.rights_acknowledgement_missing(uuid,uuid,text,jsonb)'::regprocedure) = 'e7baea73e6c790ed3e8d01b797aa3732' as every_input,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.reroute_creative_job(uuid,text,text)'::regprocedure) = '88ddf301ce242fafe8a8051d16ceab9e'                  as failover_asks,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.start_film(uuid,text,text)'::regprocedure) = '5468183a8f24a48f708efcbbf9d2d22c'                              as film_asks,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.workflow_quote_steps(public.workflows,jsonb)'::regprocedure) = 'f77e276ac50f195c746064a5633e36db'               as workflow_asks,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.creative_job_style(uuid,text)'::regprocedure) = '6d8def7530c6aff386ac691eeb616115'                              as worker_asks;
