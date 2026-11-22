-- rollback_0215_film_archive_resume.sql — takes migration 0215 (archive and resume of a paused or cancelled film, and the worker's id
-- kept out of what members read) out. OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT COMES BACK, verbatim: 0166's film_read and archive_film (only a draft or planned film archives again, and an event's detail
--   reaches members as it was written, detail.worker included); 0198's start_film, film_claim_segment and claim_creative_job (the
--   claim events record the worker's id again).
-- WHAT IS KEPT: film_segments.resumed_from, film_takes.carried_from_take_id, film_quotes.purpose / from_segment and the record checks
--   (film_segments_resume_check, film_takes_carried_check, film_quotes_purpose_check). They are the record of which segment resumed
--   which, and which takes were carried at 0; with the earlier bodies nothing writes them. Every segment, take, hold and event a
--   resume wrote stays as it is. 0171's film_segments_state_check comes back only when no segment ever resumed; otherwise the
--   superset ('resume' allowed) stays, since 0171's would refuse those rows.
-- WHAT IS LOST: rerun_film_assembly, film_assembly_retryable, film_resume_done, film_resume_precheck, film_resume_price, quote_film_resume and start_film_resume. A paused film then has no way
--   forward again (switch-on gate G1 is open again), and a paused or cancelled film cannot be archived.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if any of the twelve bodies is not 0215's (a later change would be undone), or a resume segment is still
--      open (queued / running / draining: let it settle first, or the film worker's NIGHTSHIFT_FILM_WORKER off and the sweep).
--   1. Puts the five earlier bodies back, verbatim, with their grants.
--   2. Drops the seven 0215 functions and the column grant on resumed_from.
--   3. Puts 0171's film_segments_state_check back when no segment ever resumed.
--   4. Asserts the end state.

begin;
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.film_read(uuid)', '981acaa80ff158976f8b9c70b547b270'),
      ('public.archive_film(uuid)', '55c7d0a270fd61f65d6aee32f4af3c67'),
      ('public.start_film(uuid, text, text)', '73ee48d683feae07fbb76039b35e0990'),
      ('public.film_claim_segment(text, interval)', '8f5fc37c0d0a5223e5f53e1a6e62e770'),
      ('public.claim_creative_job(text, interval)', '7a0a6d9b16d1b03a4e99a35e577e8711'),
      ('public.film_resume_done(public.film_takes)', '74a15de06371eb06e694c7e1ef75d891'),
      ('public.film_assembly_retryable(text)', 'a0b0626e246d7ee59d980bf4f1de862c'),
      ('public.rerun_film_assembly(uuid, text, text)', '04d684aebe93bcaf2dac2efb18952847'),
      ('public.film_resume_precheck(public.films, uuid)', 'aa7275ed5e8520af52cabd03c2f930d8'),
      ('public.film_resume_price(public.films)', 'aa544eda86fafc388e1932d9c0e41cc6'),
      ('public.quote_film_resume(uuid, integer)', 'c0f3ceed910051c659ef4f793bb13c65'),
      ('public.start_film_resume(uuid, text, text)', 'e516458245379bd1fb8b4ab8cf93dafe')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0215: % is not 0215''s body (md5 %): if an older file was re-run over it, apply 0215 again first, then roll back; if a later file changed it, take that file out first', r.sig, h;
    end if;
  end loop;
  if exists (select 1 from public.film_segments where purpose = 'resume' and status in ('queued', 'running', 'draining')) then
    raise exception 'rollback 0215: % resume segment(s) are open (a hold, a worker spending): let them settle first',
      (select count(*) from public.film_segments where purpose = 'resume' and status in ('queued', 'running', 'draining'));
  end if;
end $$;

-- film_read: 0166's body, verbatim (0166_films_core.sql).
create or replace function public.film_read(p_film uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'film', jsonb_build_object(
      'id', f.id, 'org_id', f.org_id, 'channel_id', f.channel_id, 'title', f.title, 'source_kind', f.source_kind,
      'source_text', f.source_text, 'language', f.language, 'aspect', f.aspect, 'target_seconds', f.target_seconds,
      'resolution', f.resolution, 'style_kit_id', f.style_kit_id, 'keyframe_model', f.keyframe_model,
      'clip_model', f.clip_model, 'voice', f.voice, 'music_asset_id', f.music_asset_id, 'music_gain_db', f.music_gain_db,
      'duck_db', f.duck_db, 'captions_mode', f.captions_mode, 'transition_default', f.transition_default,
      'status', f.status, 'pause_reason', f.pause_reason, 'pause_detail', f.pause_detail, 'version', f.version,
      'idempotency_key', f.idempotency_key, 'created_by', f.created_by, 'created_at', f.created_at,
      'updated_at', f.updated_at, 'archived_at', f.archived_at),
    'editable', public.film_is_editable(f.status),
    'style_kit_missing', f.style_kit_id is not null
                         and not exists (select 1 from public.style_kits k where k.id = f.style_kit_id and k.org_id = f.org_id),
    'music_missing', f.music_asset_id is not null and not public.film_asset_live(f.org_id, f.music_asset_id, 'audio'),
    'totals', jsonb_build_object(
      'scenes', (select count(*) from public.film_scenes s where s.film_id = f.id),
      'planned_seconds', (select coalesce(sum(s.planned_seconds), 0) from public.film_scenes s where s.film_id = f.id)),
    'refs', coalesce((select jsonb_agg(public.film_ref_json(r) order by r.position)
                        from public.film_refs r where r.film_id = f.id and r.scene_id is null), '[]'::jsonb),
    'scenes', coalesce((select jsonb_agg(jsonb_build_object(
                          'id', s.id, 'position', s.position, 'title', s.title, 'narration', s.narration,
                          'visual_prompt', s.visual_prompt, 'negative_prompt', s.negative_prompt,
                          'planned_seconds', s.planned_seconds, 'shot_count', s.shot_count,
                          'first_frame', s.first_frame, 'first_frame_asset_id', s.first_frame_asset_id,
                          'last_frame', s.last_frame, 'last_frame_asset_id', s.last_frame_asset_id,
                          'keyframe_model', s.keyframe_model, 'clip_model', s.clip_model, 'clip_params', s.clip_params,
                          'transition_in', s.transition_in, 'current_version', s.current_version, 'status', s.status,
                          'created_at', s.created_at, 'updated_at', s.updated_at,
                          'first_frame_missing', s.first_frame_asset_id is not null
                                                 and not public.film_asset_live(s.org_id, s.first_frame_asset_id, 'image'),
                          'last_frame_missing', s.last_frame_asset_id is not null
                                                and not public.film_asset_live(s.org_id, s.last_frame_asset_id, 'image'),
                          'refs', coalesce((select jsonb_agg(public.film_ref_json(r) order by r.position)
                                              from public.film_refs r where r.film_id = f.id and r.scene_id = s.id), '[]'::jsonb),
                          'takes', coalesce((select jsonb_agg(public.film_take_json(t) order by t.version, t.shot_index, t.attempt)
                                               from public.film_takes t where t.film_id = f.id and t.scene_id = s.id), '[]'::jsonb))
                          order by s.position)
                          from public.film_scenes s where s.film_id = f.id), '[]'::jsonb),
    'takes', coalesce((select jsonb_agg(public.film_take_json(t) order by t.kind, t.version, t.attempt)
                         from public.film_takes t where t.film_id = f.id and t.scene_id is null), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
                          'id', e.id, 'event', e.event, 'scene_id', e.scene_id, 'actor', e.actor, 'actor_role', e.actor_role,
                          'detail', e.detail, 'created_at', e.created_at) order by e.id desc)
                          from (select * from public.film_events e where e.film_id = f.id order by e.id desc limit 50) e),
                       '[]'::jsonb),
    'events_total', (select count(*) from public.film_events e where e.film_id = f.id),
    'events_truncated', (select count(*) > 50 from public.film_events e where e.film_id = f.id),
    'limits', public.film_limits())
  from public.films f where f.id = p_film
$$;

-- archive_film: 0166's body, verbatim.
create or replace function public.archive_film(p_film uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  lim jsonb := public.film_limits();
  org uuid;
  f   public.films;
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
  select * into f from public.films where id = p_film for no key update;
  if f.status = 'archived' then
    return public.film_read(f.id);
  end if;
  if not public.film_is_editable(f.status) then
    perform public.creative_refuse('film_not_editable', format('a %s film cannot be archived', f.status), 'NS409');
  end if;
  perform public.film_take_rate('archive', (lim ->> 'archives_per_hour')::integer);
  update public.films
     set status = 'archived', archived_at = now(), version = version + 1, updated_at = now()
   where id = f.id;
  perform public.film_log(f.id, f.org_id, null, 'archived', jsonb_build_object('from_status', f.status));
  return public.film_read(f.id);
end
$$;

-- start_film: 0198's body, verbatim (0198_film_studio_org_switch.sql).
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
  -- 0198: the platform's switch AND this organization's own (org_film_settings.film_studio_enabled, default off).
  if not public.film_studio_on_for(org) then
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

-- film_claim_segment: 0198's body, verbatim.
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
    -- 0198: a QUEUED segment of an organization whose Film Studio is off (or with the platform's switch off) is never handed out:
    -- nothing of it has begun, and film_expire_segments settles it at 0. A running or draining one may still be re-claimed, so a
    -- task already at the vendor is polled (film_begin_take and film_take_job let nothing new begin while it is off).
    if not public.film_studio_on_for(c.org_id)
       and exists (select 1 from public.film_segments x where x.id = c.id and x.status = 'queued') then
      continue;
    end if;
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
      -- 0198: the lease takes the live jobs of the segment's running takes with it. 0036's calls check only a job's worker id,
      -- so a job left the old worker's would still obey the worker that lost the lease. Segment, then job: film_take_job's order.
      update public.creative_jobs
         set worker_id = w, heartbeat_at = now(), updated_at = now()
       where film_take_id in (select t.id from public.film_takes t where t.segment_id = s.id and t.status = 'running')
         and status in ('running', 'provider_pending', 'processing', 'rendering');
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

-- claim_creative_job: 0198's body, verbatim.
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
       -- 0198: a film take's job (payer 'film') lives by its segment's lease, not by this job heartbeat: never swept here.
       and payer <> 'film'
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
       and payer <> 'film'  -- 0198: as in the scan above
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
     -- 0198: a film take's job is the film worker's (film_take_job takes a handed-back one back), never a credit worker's.
     and q.payer <> 'film'
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

revoke all on function public.film_read(uuid) from public, anon, authenticated, service_role;
revoke all on function public.archive_film(uuid) from public, anon, authenticated, service_role;
grant execute on function public.archive_film(uuid) to authenticated;
revoke all on function public.start_film(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.start_film(uuid, text, text) to authenticated;
revoke all on function public.film_claim_segment(text, interval) from public, anon, authenticated, service_role;
grant execute on function public.film_claim_segment(text, interval) to service_role;
revoke all on function public.claim_creative_job(text, interval) from public, anon, authenticated, service_role;
grant execute on function public.claim_creative_job(text, interval) to service_role;

-- 2. The seven 0215 functions.
drop function public.rerun_film_assembly(uuid, text, text);
drop function public.start_film_resume(uuid, text, text);
drop function public.quote_film_resume(uuid, integer);
drop function public.film_resume_price(public.films);
drop function public.film_resume_precheck(public.films, uuid);
drop function public.film_resume_done(public.film_takes);
drop function public.film_assembly_retryable(text);
revoke select (resumed_from) on public.film_segments from authenticated;

-- 3. 0171's film_segments_state_check (purpose 'initial' only), as 0171 wrote it, when no segment ever resumed. With one, the superset
--    stays: that row is the record, and 0171's check would refuse it.
do $$
begin
  if not exists (select 1 from public.film_segments where purpose = 'resume') then
    alter table public.film_segments drop constraint if exists film_segments_state_check;
    alter table public.film_segments add constraint film_segments_state_check
      check (n >= 1 and film_version >= 1
             and purpose in ('initial')
             and status in ('queued', 'running', 'draining', 'settled', 'released')
             and ((status in ('settled', 'released')) = (settled_at is not null))
             and ((status in ('settled', 'released')) = (captured_credits is not null))
             and (settle_reason is null or settle_reason ~ '^[a-z][a-z0-9_]{0,63}$')
             and (status <> 'queued' or (worker_id is null and claimed_at is null))
             and max_attempts between 1 and 10 and attempts between 0 and max_attempts
             and (worker_id is null or char_length(worker_id) between 1 and 120));
  end if;
end $$;

-- 4. End state.
do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.film_read(uuid)', '92f02292981b366f817bd37881e20a0f'),
      ('public.archive_film(uuid)', '9ca4e793fd81bbd4a0aecdebd59d6dc6'),
      ('public.start_film(uuid, text, text)', '7971355d754165affaf3e08904b4b078'),
      ('public.film_claim_segment(text, interval)', '40db385bb4e3893e1085ee38dcd6f49b'),
      ('public.claim_creative_job(text, interval)', '3ca4da96aabe145b34a0275ed4d1c841')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0215 end state: % is not the earlier body (md5 %)', r.sig, h;
    end if;
  end loop;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
              and proname in ('film_resume_done', 'film_assembly_retryable', 'rerun_film_assembly', 'film_resume_precheck', 'film_resume_price', 'quote_film_resume',
                              'start_film_resume'))
     or not has_function_privilege('authenticated', 'public.archive_film(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.start_film(uuid, text, text)', 'execute')
     or not has_function_privilege('service_role', 'public.film_claim_segment(text, interval)', 'execute')
     or not has_function_privilege('service_role', 'public.claim_creative_job(text, interval)', 'execute') then
    raise exception 'rollback 0215 end state: something of 0215 is still there, or a grant is not the earlier one';
  end if;
end $$;

commit;
