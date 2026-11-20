-- rollback_0179_rights_acknowledgement_inputs.sql — takes migration 0179 out: the rights acknowledgement (0174) again asks only
-- about params.source_asset_id and params.end_asset_id of the model a job is created for.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT COMES BACK: 0174's rights_acknowledgement_missing and workflow_quote_steps, 0088's reroute_creative_job, 0171's start_film and
--   0048's creative_job_style, verbatim, with their
--   grants. The four holes 0179 closed (failover, style kit pictures, @character pictures, films) are open again: apply this only
--   while no model on sale requires an acknowledgement (today only runway-gen4.5 and runway-gen4-turbo do, and neither is sold).
-- WHAT IS LOST: rights_acknowledgement_subjects, rights_acknowledgement_missing_among and film_acknowledgement_missing.
-- WHAT IS KEPT: every table and row (0179 changed none).
--
-- REFUSES (changes nothing) if any of the five bodies is not 0179's: a later change would be undone.

begin;
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.rights_acknowledgement_missing(uuid, uuid, text, jsonb)', 'e7baea73e6c790ed3e8d01b797aa3732'),
      ('public.reroute_creative_job(uuid, text, text)', '9dfc81eb3e77555ee9e04c53b22c84e9'),
      ('public.start_film(uuid, text, text)', '0cfb804e3e5d415957df0106b65ef75b'),
      ('public.workflow_quote_steps(public.workflows, jsonb)', '67c328c45c253481c2f41718aca0fcc7'),
      ('public.creative_job_style(uuid, text)', 'a7395eb11514a2c8b0db2c08e991fffc')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0179: % is not 0179''s body (md5 %): a later change would be undone; read the live body first', r.sig, h;
    end if;
  end loop;
end $$;

-- rights_acknowledgement_missing: 0174's body, verbatim (0174_rights_acknowledgement.sql).
create or replace function public.rights_acknowledgement_missing(p_org uuid, p_user uuid, p_model text, p_params jsonb)
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
    for s in select x from (values (1, case when jsonb_typeof(p_params) = 'object' then p_params ->> 'source_asset_id' end),
                                   (2, case when jsonb_typeof(p_params) = 'object' then p_params ->> 'end_asset_id' end)) t(n, x)
              where x is not null order by n loop
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

-- reroute_creative_job: 0088's body, verbatim (0088_router_failover_reason.sql).
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

-- start_film: 0171's body, verbatim (0171_films_money.sql).
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

-- workflow_quote_steps: 0174's body, verbatim (0174_rights_acknowledgement.sql).
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

-- creative_job_style: 0048's body, verbatim (0048_creative_style_inputs.sql).
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

revoke all on function public.rights_acknowledgement_missing(uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.reroute_creative_job(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.reroute_creative_job(uuid, text, text) to service_role;
revoke all on function public.start_film(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.start_film(uuid, text, text) to authenticated;
revoke all on function public.workflow_quote_steps(public.workflows, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_job_style(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.creative_job_style(uuid, text) to service_role;

drop function if exists public.film_acknowledgement_missing(public.films, uuid);
drop function if exists public.rights_acknowledgement_missing_among(uuid, uuid, text, text[]);
drop function if exists public.rights_acknowledgement_subjects(uuid, jsonb);

do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.rights_acknowledgement_missing(uuid, uuid, text, jsonb)', '426ea90d162535b0ee6f10e752e5fe26'),
      ('public.reroute_creative_job(uuid, text, text)', '55d07640bb22798e2a74bb661ac4f8d0'),
      ('public.start_film(uuid, text, text)', '63510a6d9c456e66f658353bab592d38'),
      ('public.workflow_quote_steps(public.workflows, jsonb)', '8f9f42da9844571a18a285d87bcffc84'),
      ('public.creative_job_style(uuid, text)', '75dec758272fcad658e1712fdc7f708e')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0179 end state: % is not the earlier body (md5 %)', r.sig, h;
    end if;
  end loop;
  if to_regprocedure('public.rights_acknowledgement_subjects(uuid, jsonb)') is not null
     or to_regprocedure('public.rights_acknowledgement_missing_among(uuid, uuid, text, text[])') is not null
     or to_regprocedure('public.film_acknowledgement_missing(public.films, uuid)') is not null then
    raise exception 'rollback 0179 end state: a 0179 function is still there';
  end if;
end $$;

commit;
