-- rollback_0198_film_studio_org_switch.sql — takes migration 0198 (Film Studio's switch per organization, the take's creative job,
-- the credit queue's film rule) out. OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT COMES BACK, verbatim: 0192's quote_film and start_film; 0171's film_claim_segment, film_fail_locked, film_begin_take and
--   film_settle_locked; 0036's claim_creative_job and cancel_creative_job; 0064's creative_jobs_notify trigger WHEN; 0166's
--   film_limits and films_format_check: a film targets 60-1200 s again (REFUSED while any film targets less than 60 s: edit or
--   archive those first). The platform's switch alone decides again, for every organization at once, and the credit queue again
--   sweeps and claims payer 'film' jobs: stop the film worker (NIGHTSHIFT_FILM_WORKER off) and let its segments settle first.
-- WHAT IS KEPT: org_film_settings.film_studio_enabled (who was switched on is a record; with the earlier bodies nothing reads it), and
--   every creative job and take a worker wrote through film_take_job (they are the record of what ran and what it cost).
-- WHAT IS LOST: film_studio_on_for, set_org_film_studio_enabled, film_take_inputs and film_take_job. The film worker
--   (tools/film_worker.py) then cannot make a take.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if any of the nine bodies is not 0198's (a later change would be undone), or a film targets < 60 s.
--   1. Puts the nine earlier bodies, 0064's trigger and 0166's check back, verbatim, with their grants.
--   2. Drops the four 0198 functions.
--   3. Asserts the end state.

begin;
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.quote_film(uuid, integer)', '99d01240ed2df7fb002f674df8891608'),
      ('public.start_film(uuid, text, text)', '7971355d754165affaf3e08904b4b078'),
      ('public.film_claim_segment(text, interval)', '40db385bb4e3893e1085ee38dcd6f49b'),
      ('public.film_limits()', 'dd9419b91f777a78d0d2b28539b2fb8a'),
      ('public.claim_creative_job(text, interval)', '3ca4da96aabe145b34a0275ed4d1c841'),
      ('public.cancel_creative_job(uuid)', '2720d62c17ae26bce439a28280964575'),
      ('public.film_fail_locked(uuid, text, text, text, numeric)', '0676b7e0f3e3549348044a8915a246cc'),
      ('public.film_begin_take(uuid, text)', 'ab9ec7bc2c1e94bfa4835bea2e9f5be4'),
      ('public.film_settle_locked(uuid, uuid, text)', '7caa68e2b6698c81e34c4f965950adf9')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0198: % is not 0198''s body (md5 %): if an older file was re-run over it, apply 0198 again first, then roll back; if a later file changed it, take that file out first', r.sig, h;
    end if;
  end loop;
  if exists (select 1 from public.films where target_seconds < 60) then
    raise exception 'rollback 0198: % film(s) target less than 60 s, which 0166''s check refuses: edit their length or archive them first',
      (select count(*) from public.films where target_seconds < 60);
  end if;
end $$;

-- quote_film: 0192's body, verbatim (0192_adult_attestation.sql).
create or replace function public.quote_film(p_film uuid, p_version integer) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  org      uuid;
  f        public.films;
  q        jsonb;
  st       jsonb;
  avail    numeric;
  active   integer;
  slots    jsonb;
  blocked  jsonb := '[]'::jsonb;
  exempt_  boolean;
  may      boolean;
  on_      boolean;
  lim      jsonb := public.film_money_limits();
  adult_   jsonb;  -- 0192: the film's adult refusals
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select x.org_id into org from public.films x where x.id = p_film;
  if org is null or not public.is_org_member(org, 'viewer') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into f from public.films where id = p_film;
  if not public.film_is_editable(f.status) then
    perform public.creative_refuse('film_not_editable', format('a %s film is not quoted again', f.status), 'NS409');
  end if;
  if p_version is distinct from f.version then
    perform public.creative_refuse('film_changed', format('the film is at version %s', f.version), 'NS409');
  end if;
  perform public.film_take_rate('quote', (lim ->> 'quotes_per_hour')::integer);
  q := public.film_price(f);
  -- 0192: someone who said they are under 18 is refused the whole film (adult_only_service), and each model of the film whose
  -- vendor's terms are 18+ (spec.requires_adult) is refused, by name, to anyone without an adult attestation
  -- (adult_attestation_required). Said here, in the quote the person reads before Start (rule 6), and such a quote is not one that
  -- can be started: unpriced, no quote_id, so nothing is stored for start_film to accept.
  adult_ := public.film_adult_refusals(f.id, auth.uid());
  if jsonb_array_length(adult_) > 0 then
    q := q || jsonb_build_object('priced', false, 'total', null, 'quote_id', null,
                                 'refusals', coalesce(q -> 'refusals', '[]'::jsonb) || adult_);
  end if;
  if (q ->> 'priced')::boolean then
    insert into public.film_quotes (film_id, org_id, version, quote_id, total, created_by, expires_at)
    values (f.id, org, f.version, q ->> 'quote_id', (q ->> 'total')::numeric, auth.uid(),
            now() + make_interval(mins => (lim ->> 'quote_minutes')::integer))
    on conflict (film_id, quote_id) do update set expires_at = excluded.expires_at, total = excluded.total;
  end if;
  delete from public.film_quotes where film_id = f.id and (version <> f.version or expires_at <= now());

  exempt_ := public.credits_exempt(org);
  on_ := public.film_studio_on();
  st := public.film_settings_of(org);
  avail := public.film_available(org);
  active := (select count(*) from public.film_segments s where s.org_id = org and s.status in ('queued', 'running', 'draining'));
  slots := public.org_run_slots(org);
  if not on_ then
    blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'film_studio_disabled'));
  end if;
  if (q ->> 'priced')::boolean then
    if st ->> 'max_credits_per_film' is not null and (q ->> 'total')::numeric > (st ->> 'max_credits_per_film')::numeric then
      blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'cap_exceeded', 'limit', st -> 'max_credits_per_film'));
    end if;
    if not exempt_ and (q ->> 'total')::numeric > avail then
      blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'insufficient_credits', 'available', avail,
                                                                 'needed', q -> 'total'));
    end if;
  end if;
  if active >= (st ->> 'max_active_films')::integer then
    blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'limit_reached', 'active', active,
                                                               'limit', st -> 'max_active_films'));
  end if;
  if not exempt_ and slots is not null and (slots ->> 'active')::integer >= (slots ->> 'limit')::integer then
    blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'run_slots_full', 'active', slots -> 'active',
                                                               'limit', slots -> 'limit'));
  end if;
  may := public.is_org_member(org, 'admin') and (not exempt_ or public.is_platform_admin());
  return q || jsonb_build_object(
    'exempt', exempt_, 'available', avail, 'settings', st, 'active_films', active, 'film_studio_enabled', on_,
    -- 0034 counts the film's hold as one of the plan's parallel runs for as long as it is open: the app warns before Start.
    'run_slot', jsonb_build_object('uses_run_slot', not exempt_, 'slots', slots,
                                   'max_hours', (lim ->> 'unclaimed_hours')::integer + (lim ->> 'deadline_hours')::integer
                                                + (lim ->> 'grace_hours')::integer),
    'quote_expires_at', (select x.expires_at from public.film_quotes x where x.film_id = f.id and x.quote_id = q ->> 'quote_id'),
    'blocked_by', blocked, 'may_start', may,
    'startable', (q ->> 'priced')::boolean and jsonb_array_length(blocked) = 0 and may,
    'limits', lim);
end
$$;
revoke all on function public.quote_film(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.quote_film(uuid, integer) to authenticated;

-- start_film: 0192's body, verbatim (0192_adult_attestation.sql).
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
  -- 0192: the quote's adult refusals again, first of all once the caller is known to be the organization's admin: before the key and
  -- the quote are read, a replay is answered, the start is counted, anything is priced, held or written. A person who said they
  -- are under 18 starts nothing; a model of the film that is for adults only needs an adult attestation first.
  bad := public.film_adult_refusals(p_film, uid) -> 0;
  if bad is not null then
    perform public.creative_refuse(bad ->> 'reason', bad ->> 'detail');
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
revoke all on function public.start_film(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.start_film(uuid, text, text) to authenticated;

-- film_claim_segment: 0171's body, verbatim (0171_films_money.sql).
create or replace function public.film_claim_segment(p_worker text, p_stale_after interval default interval '10 minutes')
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  w    text := left(btrim(coalesce(p_worker, '')), 120);
  c    record;
  s    public.film_segments;
  lim  jsonb := public.film_money_limits();
  st   text;
  msg  text;
begin
  if w = '' then
    raise exception 'film_claim_segment: p_worker is required' using errcode = '22023';
  end if;
  if p_stale_after is null or p_stale_after < interval '1 minute' then
    raise exception 'film_claim_segment: p_stale_after must be at least a minute' using errcode = '22023';
  end if;
  for c in select x.id, x.film_id, x.org_id from public.film_segments x
            where x.status = 'queued'
               or (x.status in ('running', 'draining') and (x.heartbeat_at is null or x.heartbeat_at < now() - p_stale_after))
            order by x.created_at, x.id loop
    st := null;
    begin
      perform 1 from public.films where id = c.film_id for no key update skip locked;
      if not found then
        continue;
      end if;
      select * into s from public.film_segments where id = c.id for update skip locked;
      if not found or not (s.status = 'queued'
                           or (s.status in ('running', 'draining') and (s.heartbeat_at is null or s.heartbeat_at < now() - p_stale_after))) then
        continue;
      end if;
      if s.status = 'queued' then
        if s.credit_ref is not null and public.start_credit_reservation(s.credit_ref, s.org_id) is null then
          perform public.film_settle_locked(s.film_id, s.id, 'hold_expired');
          continue;
        end if;
        update public.film_segments
           set status = 'running', claimed_at = now(), deadline_at = now() + make_interval(hours => (lim ->> 'deadline_hours')::integer)
         where id = s.id;
        update public.films set status = 'running', updated_at = now() where id = s.film_id and status = 'queued';
      elsif s.attempts >= s.max_attempts then
        -- Every lease is used and the last worker went quiet: end what it left in flight, and settle with what was made.
        perform public.film_lose_inflight_locked(s.id);
        perform public.film_settle_locked(s.film_id, s.id, 'worker_lost');
        continue;
      end if;
      update public.film_segments
         set worker_id = w, heartbeat_at = now(), attempts = attempts + 1, updated_at = now()
       where id = s.id
      returning * into s;
      perform public.film_log(s.film_id, s.org_id, null, 'segment_claimed',
                              jsonb_build_object('segment_id', s.id, 'worker', w, 'attempt', s.attempts, 'status', s.status));
      return public.film_segment_json(s) || jsonb_build_object(
        'takes_list', coalesce((select jsonb_agg(public.film_take_money_json(t) order by t.scene_id nulls last, t.shot_index, t.attempt)
                                  from public.film_takes t where t.segment_id = s.id), '[]'::jsonb));
    exception when others then
      -- One segment that cannot be claimed never takes the claim down for every other film.
      st := sqlstate;
      msg := sqlerrm;
      raise warning 'film_claim_segment: segment % skipped (%: %)', c.id, st, msg;
    end;
    -- Written after the block, whose writes were rolled back with it, so the record survives.
    if st is not null then
      perform public.film_record_skip(c.film_id, c.org_id, c.id, 'claim', st, msg);
    end if;
  end loop;
  return null;
end
$$;
revoke all on function public.film_claim_segment(text, interval) from public, anon, authenticated, service_role;
grant execute on function public.film_claim_segment(text, interval) to service_role;

-- film_limits: 0166's body, verbatim (0166_films_core.sql).
create or replace function public.film_limits() returns jsonb
  language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'max_scenes', 60, 'scene_seconds_min', 3, 'scene_seconds_max', 30, 'max_shots', 3,
    'max_film_seconds', 1200, 'target_seconds_min', 60, 'target_seconds_max', 1200,
    'max_topic_chars', 2000, 'max_script_chars', 40000, 'max_title_chars', 120,
    'max_narration_chars', 2000, 'max_prompt_chars', 2000, 'max_negative_chars', 1000,
    'max_film_refs', 16, 'max_scene_refs', 8, 'max_open_drafts', 50, 'max_patch_bytes', 2000000,
    'max_films_total', 500, 'max_events_per_film', 5000,
    'creates_per_hour', 30, 'saves_per_hour', 240, 'archives_per_hour', 60)
$$;
revoke all on function public.film_limits() from public, anon, authenticated, service_role;

-- claim_creative_job: 0036's body, verbatim (0036_creative_jobs.sql).
create or replace function public.claim_creative_job(
  p_worker text, p_stale_after interval default interval '10 minutes'
) returns setof public.creative_jobs
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  c record;
  s record;
  v_id uuid;
  w text := left(btrim(coalesce(p_worker, '')), 120);
begin
  if not public.credits_trusted_caller() then
    raise exception 'creative jobs are claimed by the platform''s worker only' using errcode = '42501';
  end if;
  if w = '' then
    raise exception 'p_worker is required' using errcode = '22023';
  end if;

  for c in
    select id, org_id from public.creative_jobs
     where status in ('running', 'provider_pending', 'processing', 'rendering')
       and coalesce(heartbeat_at, started_at, created_at) < now() - p_stale_after
     order by org_id, id
  loop
    -- Account first, then the job, re-checked under its lock (a heartbeat
    -- may have arrived since the scan).
    perform public.credit_account_lock(c.org_id);
    select id, attempts, max_attempts, provider_task_id, submit_started_at into s
      from public.creative_jobs
     where id = c.id
       and status in ('running', 'provider_pending', 'processing', 'rendering')
       and coalesce(heartbeat_at, started_at, created_at) < now() - p_stale_after
     for update skip locked;
    if not found then
      continue;
    end if;
    if s.submit_started_at is not null and s.provider_task_id is null then
      perform public.creative_end_locked(s.id, 'failed', 'submit_interrupted',
        'the worker stopped while submitting to the provider; it is never submitted twice, and the credits were released');
    elsif s.attempts >= s.max_attempts then
      perform public.creative_end_locked(s.id, 'failed', 'worker_lost',
        format('worker lost (no heartbeat) on the last of %s attempts; the credits were released', s.max_attempts));
    else
      update public.creative_jobs
         set status = 'queued', worker_id = null, updated_at = now()
       where id = s.id;
      perform public.creative_job_log(s.id, c.org_id,
        'requeued', 'queued', jsonb_build_object('reason', 'no heartbeat'));
    end if;
  end loop;

  perform public.creative_expire_locked(null);

  select q.id into v_id
    from public.creative_jobs q
   where q.status = 'queued'
   order by (q.provider_task_id is null), q.created_at, q.id
   for update skip locked
   limit 1;
  if v_id is null then
    return;
  end if;

  return query
    update public.creative_jobs j
       set status = case when j.provider_task_id is not null then 'provider_pending' else 'running' end,
           worker_id = w, attempts = j.attempts + 1,
           started_at = coalesce(j.started_at, now()), heartbeat_at = now(), updated_at = now()
     where j.id = v_id
    returning j.*;
  perform public.creative_job_log(v_id, (select org_id from public.creative_jobs where id = v_id),
    'claimed', (select status from public.creative_jobs where id = v_id),
    jsonb_build_object('worker', w));
end
$$;
revoke all on function public.claim_creative_job(text, interval) from public, anon, authenticated, service_role;
grant execute on function public.claim_creative_job(text, interval) to service_role;

-- cancel_creative_job: 0036's body, verbatim (0036_creative_jobs.sql).
create or replace function public.cancel_creative_job(p_job uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  j public.creative_jobs;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into j from public.creative_jobs where id = p_job;
  -- Another organization's job reads as missing, not as forbidden: ids never
  -- confirm what exists elsewhere.
  if not found or not public.is_org_member(j.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform public.credit_account_lock(j.org_id);
  select * into j from public.creative_jobs where id = p_job for update;
  if j.status in ('cancelled', 'failed', 'expired', 'completed') then
    return jsonb_build_object('job', public.creative_job_json(j), 'released', 0,
                              'already', true);
  end if;
  if not (j.status = 'queued' and j.provider_task_id is null and j.submit_started_at is null)
     and not (j.status = 'running' and j.submit_started_at is null) then
    perform public.creative_refuse('not_cancellable',
      'the provider is already working on this job', 'NS409');
  end if;
  perform public.creative_end_locked(p_job, 'cancelled', 'cancelled', 'cancelled by a member');
  select * into j from public.creative_jobs where id = p_job;
  return jsonb_build_object('job', public.creative_job_json(j), 'already', false);
end
$$;
revoke all on function public.cancel_creative_job(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cancel_creative_job(uuid) to authenticated;

-- film_fail_locked: 0171's body, verbatim (0171_films_money.sql).
create or replace function public.film_fail_locked(p_take uuid, p_failure text, p_code text, p_error text, p_units_done numeric)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  t      public.film_takes;
  s      public.film_segments;
  nt     public.film_takes;
  bill   text;
  charge numeric := 0;
  basis  text;
begin
  select * into t from public.film_takes where id = p_take;
  select * into s from public.film_segments where id = t.segment_id;
  -- M1: what a failed take delivered is not the organization's to keep: the files its creative job registered and the files whose
  -- provenance names it are soft-deleted with the failure, in this transaction, within film_discard_assets' guard.
  perform public.film_discard_assets(t.org_id, t.id, null, null);
  if t.attempt < 1 + (public.film_money_limits() ->> 'retries_per_take')::integer
     and s.status = 'running' and (s.deadline_at is null or now() <= s.deadline_at) and p_failure <> 'worker_lost' then
    update public.film_takes
       set status = 'superseded', charged_credits = 0, charge_basis = 'retried_not_charged', error_code = p_code, error = p_error,
           updated_at = now(), finished_at = now()
     where id = t.id
    returning * into t;
    insert into public.film_takes (film_id, org_id, scene_id, version, shot_index, kind, parent_take_id, attempt, status, model, params,
                                   duration_s, first_frame_asset_id, last_frame_asset_id, reference_asset_ids, reshoot, segment_id,
                                   credit_unit, unit_credits, quantity, minimum_credits, confirmed_credits)
    values (t.film_id, t.org_id, t.scene_id, t.version, t.shot_index, t.kind, t.parent_take_id, t.attempt + 1, 'planned', t.model,
            t.params, t.duration_s, t.first_frame_asset_id, t.last_frame_asset_id, t.reference_asset_ids, t.reshoot, t.segment_id,
            t.credit_unit, t.unit_credits, t.quantity, t.minimum_credits, t.confirmed_credits)
    returning * into nt;
    perform public.film_log(t.film_id, t.org_id, t.scene_id, 'take_retried',
      jsonb_build_object('take_id', t.id, 'retry_take_id', nt.id, 'kind', t.kind, 'failure', p_failure, 'error_code', p_code,
                         'charged', 0));
    return public.film_take_money_json(t) || jsonb_build_object('retry_take_id', nt.id);
  end if;
  -- A take that delivers nothing is charged nothing, as the Studio charges a failed job nothing; the basis records what the vendor
  -- is known to have billed the platform, which the platform absorbs (see the header).
  if p_failure = 'moderated' then
    bill := public.film_moderation_billing(t.model);
    basis := case bill when 'billed' then 'moderated_vendor_billed' when 'not_billed' then 'moderated_vendor_not_billed'
                       else 'moderated_vendor_billing_unknown' end;
  elsif p_failure = 'worker_lost' then
    basis := 'worker_lost_not_charged';
  elsif t.kind = 'narration' and coalesce(p_units_done, 0) > 0 then
    -- Part of the text was voiced, but a narration with a hole in it is thrown away: nothing was delivered.
    basis := 'partial_not_delivered';
  else
    basis := 'failed_not_charged';
  end if;
  update public.film_takes
     set status = 'failed', charged_credits = charge, charge_basis = basis, error_code = p_code, error = p_error,
         updated_at = now(), finished_at = now()
   where id = t.id
  returning * into t;
  perform public.film_log(t.film_id, t.org_id, t.scene_id, 'take_failed',
    jsonb_build_object('take_id', t.id, 'kind', t.kind, 'failure', p_failure, 'error_code', p_code,
                       'confirmed', t.confirmed_credits, 'charged', charge, 'basis', basis, 'units_done', p_units_done));
  return public.film_take_money_json(t);
end
$$;
revoke all on function public.film_fail_locked(uuid, text, text, text, numeric) from public, anon, authenticated, service_role;

-- film_begin_take: 0171's body, verbatim (0171_films_money.sql).
create or replace function public.film_begin_take(p_take uuid, p_worker text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  t   public.film_takes := public.film_lock_take(p_take, p_worker);
  s   public.film_segments;
  why text;
begin
  select * into s from public.film_segments where id = t.segment_id;
  if t.status = 'running' then
    return public.film_take_money_json(t) || jsonb_build_object('began', true);
  end if;
  if s.status <> 'running' then
    perform public.creative_refuse('not_running', format('the segment is %s: nothing new begins', s.status), 'NS409');
  end if;
  if s.deadline_at is not null and now() > s.deadline_at then
    perform public.creative_refuse('not_running', 'the segment is past its deadline: settle it', 'NS409');
  end if;
  if t.status <> 'planned' then
    perform public.creative_refuse('take_not_planned', format('the take is %s', t.status), 'NS409');
  end if;
  if s.credit_ref is not null then
    if not exists (select 1 from public.credit_reservations r where r.job_id = s.credit_ref and r.status = 'open') then
      why := 'hold_lost';
    elsif exists (select 1 from public.credit_refund_recoveries r
                   where r.org_id = s.org_id and r.collected + r.lapsed < r.owed and s.credit_ref = any (r.holds)) then
      why := 'refund_pending';
    end if;
  end if;
  if why is not null then
    perform public.film_cancel_segment(s.id, why);
    select * into t from public.film_takes where id = p_take;
    return coalesce(public.film_take_money_json(t), jsonb_build_object('id', p_take))
           || jsonb_build_object('began', false, 'reason', why);
  end if;
  update public.film_takes set status = 'running', started_at = now(), updated_at = now() where id = t.id returning * into t;
  return public.film_take_money_json(t) || jsonb_build_object('began', true);
end
$$;
revoke all on function public.film_begin_take(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.film_begin_take(uuid, text) to service_role;

-- film_settle_locked: 0171's body, verbatim (0171_films_money.sql).
create or replace function public.film_settle_locked(p_film uuid, p_segment uuid, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s       public.film_segments;
  why     text;
  owed    numeric;
  got     numeric := 0;
  status_ text;
  ran     boolean;
  removed uuid[] := '{}';
begin
  select * into s from public.film_segments where id = p_segment and film_id = p_film;
  if s.status in ('settled', 'released') then
    return public.film_segment_json(s);
  end if;
  why := coalesce(s.settle_reason, p_reason);
  update public.film_takes
     set status = 'skipped', charged_credits = 0, charge_basis = 'not_started', updated_at = now(), finished_at = now()
   where segment_id = s.id and status in ('planned', 'queued');
  if s.assembly_status = 'planned' then
    update public.film_segments set assembly_status = 'skipped', assembly_charged_credits = 0 where id = s.id;
  end if;
  select * into s from public.film_segments where id = s.id;
  owed := (select coalesce(sum(t.charged_credits), 0) from public.film_takes t where t.segment_id = s.id)
          + coalesce(s.assembly_charged_credits, 0);
  if owed > s.confirmed_credits then
    raise exception 'film_settle_locked: charges % exceed the confirmed % of segment %', owed, s.confirmed_credits, s.id;
  end if;
  ran := owed > 0 or s.assembly_status = 'completed'
         or exists (select 1 from public.film_takes t where t.segment_id = s.id and t.status = 'completed');
  if s.credit_ref is not null then
    if owed > 0 then
      got := public.capture_credits(s.credit_ref, owed, false);
    else
      perform public.release_credits(s.credit_ref);
    end if;
  end if;
  status_ := case when got > 0 then 'settled' else 'released' end;
  update public.film_segments
     set status = status_, captured_credits = got, settled_at = now(), settle_reason = why, worker_id = null, updated_at = now()
   where id = s.id
  returning * into s;
  if not ran then
    -- Nothing was charged and nothing was made: the film goes back to its storyboard, editable and startable again. The takes that
    -- never began (skipped, all at 0) go, so 0166's save_film can delete their scenes; one a creative job names stays (that job's
    -- record). The started and segment_settled events keep what happened.
    with d as (
      delete from public.film_takes t
       where t.segment_id = s.id and t.status = 'skipped' and t.creative_job_id is null
         and not exists (select 1 from public.creative_jobs j where j.film_take_id = t.id)
      returning t.id)
    select coalesce(array_agg(d.id order by d.id), '{}'::uuid[]) into removed from d;
    update public.films
       set status = 'draft', pause_reason = case when why = 'cancelled' then null else why end, pause_detail = null,
           updated_at = now()
     where id = p_film;
  else
    update public.films
       set status = case when why = 'completed' then 'ready' when why = 'cancelled' then 'cancelled' else 'paused' end,
           pause_reason = case when why in ('completed', 'cancelled') then null else why end,
           pause_detail = null, updated_at = now()
     where id = p_film;
  end if;
  perform public.film_log(p_film, s.org_id, null, 'segment_settled',
    jsonb_build_object('segment_id', s.id, 'reason', why, 'confirmed', s.confirmed_credits, 'charged', owed, 'captured', got,
                       'exempt', s.exempt, 'back_to_draft', not ran, 'takes_removed', cardinality(removed),
                       'removed_take_ids', to_jsonb(removed))
    || case when s.credit_ref is not null and got < owed then jsonb_build_object('not_captured', owed - got) else '{}'::jsonb end);
  return public.film_segment_json(s);
end
$$;
revoke all on function public.film_settle_locked(uuid, uuid, text) from public, anon, authenticated, service_role;

alter table public.films drop constraint if exists films_format_check;
alter table public.films add constraint films_format_check
  check (language in ('en', 'ru', 'uz')
         and aspect in ('16:9', '9:16', '1:1')
         and target_seconds between 60 and 1200
         and (resolution is null or resolution in ('480p', '720p', '768p', '1080p', '2k', '4k')));

-- creative_jobs_notify: 0064's WHEN, verbatim (0064_notifications.sql).
drop trigger if exists creative_jobs_notify on public.creative_jobs;
create trigger creative_jobs_notify
  after update of status on public.creative_jobs
  for each row
  when (new.status in ('completed', 'failed', 'expired') and old.status is distinct from new.status)
  execute function public.notify_creative_job_ended();

-- The members' read of the kept column goes with it: the column is a record, not a thing the app shows any more.
revoke select (film_studio_enabled) on public.org_film_settings from authenticated;
drop function if exists public.film_take_job(uuid, text);
drop function if exists public.film_take_inputs(public.film_takes);
drop function if exists public.set_org_film_studio_enabled(uuid, boolean);
drop function if exists public.film_studio_on_for(uuid);

do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.quote_film(uuid, integer)', '00846d0622ab379810c633b2446436b0'),
      ('public.start_film(uuid, text, text)', '595e90f836f992699cf9e920ad646787'),
      ('public.film_claim_segment(text, interval)', 'fddd014f8cbcb72603da0b792cc0d31a'),
      ('public.film_limits()', '9ddbb45ad45efa76265b4f1b22c048bb'),
      ('public.claim_creative_job(text, interval)', '37d708494c1cf39578b0988d58e7f932'),
      ('public.cancel_creative_job(uuid)', '3d7c99b7d355194102fb5982747ccad5'),
      ('public.film_fail_locked(uuid, text, text, text, numeric)', '5c479bb1bff1c0e6218ef9424ddeca49'),
      ('public.film_begin_take(uuid, text)', '3f949fee189a8ef37ef776e5a30ec182'),
      ('public.film_settle_locked(uuid, uuid, text)', '19938f367460c80103dc97eb7f1fee35')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0198 end state: % is not the earlier body (md5 %)', r.sig, h;
    end if;
  end loop;
  if to_regprocedure('public.film_take_job(uuid, text)') is not null
     or to_regprocedure('public.set_org_film_studio_enabled(uuid, boolean)') is not null
     or to_regprocedure('public.film_studio_on_for(uuid)') is not null then
    raise exception 'rollback 0198 end state: a 0198 function is still there';
  end if;
  if exists (select 1 from pg_trigger g where g.tgrelid = 'public.creative_jobs'::regclass and g.tgname = 'creative_jobs_notify'
                and pg_get_triggerdef(g.oid) like '%payer%') then
    raise exception 'rollback 0198 end state: creative_jobs_notify is not 0064''s';
  end if;
end $$;

commit;
