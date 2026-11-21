-- 0198_film_studio_org_switch.sql — Film Studio P3: a switch per organization, and the take's creative job, which 0171's contract
-- names but no function writes.
--
-- EVIDENCE (read from the migrations, not assumed):
--   * 0171's only switch is film_studio_settings.film_studio_enabled, one row for the whole platform. Turning it on turns Film Studio
--     on for every organization at once; there is no way to open it to one workspace first.
--   * 0171's contract says P3 creates each take's creative job (payer 'film', film_take_id, no hold of its own), but no function does,
--     and no API role may insert into creative_jobs (0036 grants select only, the service key included). film_begin_take does not
--     create it either. The inputs a take is made from (its first frame, end frame, references) are recorded on film_takes
--     (first_frame_asset_id, last_frame_asset_id, reference_asset_ids), which no service function writes.
--
--   * The owner wants 15-30 s adverts as films; 0166's film_limits().target_seconds_min is 60 and films_format_check repeats it.
--   * Breach, Lens and Sentinel on #853 (tests/security/test_sec_film_worker_breach.py): 0036's credit queue swept and claimed payer
--     'film' jobs; a lease that changed hands left the take's job obeying the old worker; ending a take (0171's film_fail_locked)
--     never ended its job; "off" was asked at the start and the claim only; any member could cancel a film take's job; every take
--     job notified the starter.
--
-- CHANGE (additive; nine function bodies replaced, each with marked 0198 hunks and nothing else changed; four functions added; one
-- check constraint replaced by a superset; one trigger's WHEN narrowed):
--   org_film_settings.film_studio_enabled   NEW column, boolean not null default false: every organization starts off.
--   film_studio_on_for(org)                 NEW. The platform's switch AND the organization's. Service role only.
--   set_org_film_studio_enabled(org, on)    NEW. A platform owner or admin through owner_guard (second factor, a rate limit), or the
--     SQL editor, exactly like 0171's set_film_studio_enabled; a change writes a security_events row (film_studio.org_enabled).
--     Executable by authenticated (owner_guard refuses everyone but a platform owner/admin), never by anon or the service role.
--   quote_film (0192's body, one hunk)      film_studio_enabled and blocked_by film_studio_disabled read film_studio_on_for(org), so
--     the quote never says startable for a start that will refuse.
--   start_film (0192's body, one hunk)      refuses film_studio_disabled (the existing word, NS409, before anything is counted)
--     unless film_studio_on_for(org).
--   film_claim_segment (0171's body, two hunks)  skips a QUEUED segment of an organization for which film_studio_on_for is false
--     (nothing of it began; film_expire_segments, unchanged, settles it at 0); a running one may still be re-claimed, so a task at the
--     vendor is polled. And the lease takes the live jobs of the segment's running takes to the new holder.
--   claim_creative_job (0036's body, three hunks)  payer 'film' is never swept nor picked by the credit queue.
--   cancel_creative_job (0036's body, one hunk)    a film take's job reads as not_found (films are cancelled by film_cancel_segment).
--   film_fail_locked (0171's body, one hunk)       ending a take ends its creative job (creative_end_locked), on every path.
--   film_begin_take (0171's body, one hunk)        refuses film_studio_disabled while off; film_take_job refuses a new job too.
--   film_settle_locked (0171's body, one hunk)     a settled segment leaves no live take job.
--   trigger creative_jobs_notify (0064)            its WHEN adds payer <> 'film'; notify_creative_job_ended is unchanged.
--   film_limits (0166's body, one hunk)     target_seconds_min 60 -> 10; films_format_check (0166's) the same, 10-1200. The scene
--     rule (3-30 s, 1-3 shots) and every other limit are unchanged. Replaced only when the live check is 0166's (60) or this
--     file's (10), by its quoted words and its bounds.
--   film_take_inputs(take)                  NEW, internal: a take's recorded input pictures by role, for the worker to copy by id.
--   film_take_job(take, worker)             NEW, service role only: the running take's creative job, written for the worker that holds
--     the segment's lease (see its comment). Idempotent: a take has one job, ever.
--
-- NOT CHANGED: the platform switch stays OFF (this file never writes film_studio_settings). Every price, hold, capture, release and
--   settle rule of 0171; film_take_succeeded / film_take_failed / film_settle_segment / film_expire_segments; 0034's run slots. A take's
--   job holds nothing and is charged nothing (quoted 0, payer 'film'): finish_creative_job captures for payer 'credits' only (0126).
--   There is no publish path here (CLAUDE.md rule 2).
--
-- REPLACES (md5 drift guard: the earlier body, or this file's own on a replay; whitespace runs read as one space):
--   quote_film           00846d0622ab379810c633b2446436b0 (0192) -> 99d01240ed2df7fb002f674df8891608
--   start_film           595e90f836f992699cf9e920ad646787 (0192) -> 7971355d754165affaf3e08904b4b078
--   film_claim_segment   fddd014f8cbcb72603da0b792cc0d31a (0171) -> 40db385bb4e3893e1085ee38dcd6f49b
--   film_limits          9ddbb45ad45efa76265b4f1b22c048bb (0166) -> dd9419b91f777a78d0d2b28539b2fb8a
--   claim_creative_job   37d708494c1cf39578b0988d58e7f932 (0036) -> 3ca4da96aabe145b34a0275ed4d1c841
--   cancel_creative_job  3d7c99b7d355194102fb5982747ccad5 (0036) -> 2720d62c17ae26bce439a28280964575
--   film_fail_locked     5c479bb1bff1c0e6218ef9424ddeca49 (0171) -> 0676b7e0f3e3549348044a8915a246cc
--   film_begin_take      3f949fee189a8ef37ef776e5a30ec182 (0171) -> ab9ec7bc2c1e94bfa4835bea2e9f5be4
--   film_settle_locked   19938f367460c80103dc97eb7f1fee35 (0171) -> 7caa68e2b6698c81e34c4f965950adf9
-- REPLAY. This file replays onto itself. Re-running 0192 after it FAILS LOUDLY (0192's guard refuses this file's quote_film and
--   start_film). Re-running 0171 after it fails loudly too (0171's guard refuses this file's film_claim_segment, film_fail_locked,
--   film_begin_take and film_settle_locked), and so does 0166 (its guard refuses this file's film_limits). Re-running 0036 after it
--   SILENTLY puts the old claim_creative_job and cancel_creative_job back (0036 has no drift guard), and re-running 0064 puts the
--   old trigger WHEN back: apply 0198 again after either, then run the Verify query.
--   rollback_0192 refuses while this file's bodies are live: take this file out first.
--
-- LOCKS WHILE APPLYING. ALTER TABLE on org_film_settings (one column with a constant default: no rewrite) and on films (the check,
--   which scans the table once) take ACCESS EXCLUSIVE on each until commit. `set local lock_timeout = '5s'` makes the file fail instead of queueing behind a start.
--
-- NUMBER. Provisionally 0198; the coordinator confirms it at merge. Needs 0018, 0036, 0038, 0047, 0107, 0117, 0166, 0171, 0187, 0192.
-- Undo: docs/sql/rollback_0198_film_studio_org_switch.sql (owner-applied): the nine earlier bodies, 0064's trigger and 0166's check back (refused
--   while a film targets less than 60 s), the four functions dropped, the column kept (a column dropped would lose who was switched on; with the earlier bodies nothing reads it).
--
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).

set local lock_timeout = '5s';

do $$
declare
  r    record;
  h    text;
  d    text;
  lits text[];
begin
  if to_regclass('public.film_segments') is null or to_regclass('public.org_film_settings') is null
     or to_regprocedure('public.film_studio_on()') is null or to_regprocedure('public.film_lock_take(uuid, text)') is null then
    raise exception '0198 needs the Film Studio''s money: apply 0171_films_money.sql first';
  end if;
  if to_regprocedure('public.film_adult_refusals(uuid, uuid)') is null then
    raise exception '0198 is built on 0192''s quote_film and start_film: apply 0192_adult_attestation.sql first';
  end if;
  if to_regprocedure('public.owner_guard(text, integer)') is null
     or to_regprocedure('public.security_event_log(text, text, text, jsonb)') is null then
    raise exception '0198 needs owner_guard and security_event_log: apply 0107_owner_safety.sql first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'creative_jobs' and column_name = 'film_take_id') then
    raise exception '0198 needs creative_jobs.film_take_id: apply 0171_films_money.sql first';
  end if;
  -- The nine bodies this file replaces: the earlier one, or this file's own (a replay).
  for r in select * from (values
      ('public.quote_film(uuid, integer)', '00846d0622ab379810c633b2446436b0', '99d01240ed2df7fb002f674df8891608', '0192'),
      ('public.start_film(uuid, text, text)', '595e90f836f992699cf9e920ad646787', '7971355d754165affaf3e08904b4b078', '0192'),
      ('public.film_claim_segment(text, interval)', 'fddd014f8cbcb72603da0b792cc0d31a', '40db385bb4e3893e1085ee38dcd6f49b', '0171'),
      ('public.film_limits()', '9ddbb45ad45efa76265b4f1b22c048bb', 'dd9419b91f777a78d0d2b28539b2fb8a', '0166'),
      ('public.claim_creative_job(text, interval)', '37d708494c1cf39578b0988d58e7f932', '3ca4da96aabe145b34a0275ed4d1c841', '0036'),
      ('public.cancel_creative_job(uuid)', '3d7c99b7d355194102fb5982747ccad5', '2720d62c17ae26bce439a28280964575', '0036'),
      ('public.film_fail_locked(uuid, text, text, text, numeric)', '5c479bb1bff1c0e6218ef9424ddeca49', '0676b7e0f3e3549348044a8915a246cc', '0171'),
      ('public.film_begin_take(uuid, text)', '3f949fee189a8ef37ef776e5a30ec182', 'ab9ec7bc2c1e94bfa4835bea2e9f5be4', '0171'),
      ('public.film_settle_locked(uuid, uuid, text)', '19938f367460c80103dc97eb7f1fee35', '7caa68e2b6698c81e34c4f965950adf9', '0171')) v(sig, was, now_, src) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is null or h <> all (array[r.was, r.now_]) then
      raise exception '0198 found % with a body that is neither %''s nor 0198''s (md5 %): read the live body first', r.sig, r.src, h;
    end if;
  end loop;
  -- The check this file replaces: 0166's (60-1200 s) or this file's (10-1200 s), compared as its quoted words and its bounds.
  select pg_get_constraintdef(oid) into d from pg_constraint where conrelid = 'public.films'::regclass and conname = 'films_format_check';
  select array_agg(distinct m[1] order by m[1]) into lits from regexp_matches(coalesce(d, ''), '''([^'']*)''', 'g') m;
  if d is null
     or lits is distinct from (select array_agg(x order by x) from unnest(array['en', 'ru', 'uz', '16:9', '9:16', '1:1', '480p', '720p',
                                                                                '768p', '1080p', '2k', '4k']) x)
     or d not like '%target_seconds <= 1200%'
     or (d not like '%target_seconds >= 60)%' and d not like '%target_seconds >= 10)%') then
    raise exception '0198 found films_format_check that is not 0166''s or this file''s (%): read it first', d;
  end if;
  -- The notification trigger this file narrows: 0064's WHEN, or this file's.
  select pg_get_triggerdef(g.oid) into d from pg_trigger g
   where g.tgrelid = 'public.creative_jobs'::regclass and g.tgname = 'creative_jobs_notify' and not g.tgisinternal;
  if d is null or d not like '%notify_creative_job_ended()%'
     or regexp_replace(d, '\s+', ' ', 'g') not like '%AFTER UPDATE OF status ON public.creative_jobs FOR EACH ROW WHEN%' then
    raise exception '0198 found the creative_jobs_notify trigger that is not 0064''s or this file''s (%): read it first', d;
  end if;
  -- The functions this file creates: absent, or this file's own bodies (a replay).
  for r in select * from (values
      ('public.film_studio_on_for(uuid)', 'e5397c4d359a3113825272463fe93c06'),
      ('public.set_org_film_studio_enabled(uuid, boolean)', '7b56b06164a91b5651172470088e867a'),
      ('public.film_take_inputs(public.film_takes)', 'c8dc8dfa8b68639a5fd00be52b235ee9'),
      ('public.film_take_job(uuid, text)', '8a28484a7992a4aa2195d78878f3b399')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is not null and h <> r.want then
      raise exception '0198 found % with a body that is not this file''s (md5 %): read the live body first', r.sig, h;
    end if;
  end loop;
  -- The column this file adds: absent, or this file's own.
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'org_film_settings' and column_name = 'film_studio_enabled'
                and (data_type <> 'boolean' or is_nullable <> 'NO' or column_default is distinct from 'false')) then
    raise exception '0198 found org_film_settings.film_studio_enabled that is not this file''s (boolean not null default false): read it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The organization's own switch
-- ───────────────────────────────────────────────────────────────────────────

-- Off by default: a row that does not exist yet, and every row that exists today, is an organization that has not been switched on.
alter table public.org_film_settings add column if not exists film_studio_enabled boolean not null default false;
comment on column public.org_film_settings.film_studio_enabled is
  'Film Studio for this organization (migration 0198), default false. Both this and film_studio_settings.film_studio_enabled must be on for start_film to start a film and for film_claim_segment to hand one of its segments to a worker. Changed only by set_org_film_studio_enabled, which writes a security_events row.';

-- The one question every caller asks: the platform's switch AND this organization's. A missing row is off.
create or replace function public.film_studio_on_for(p_org uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select public.film_studio_on()
         and coalesce((select s.film_studio_enabled from public.org_film_settings s where s.org_id = p_org), false)
$$;

-- The organization's switch has one writer, shaped like 0171's set_film_studio_enabled: a platform owner/admin through owner_guard
-- (42501 for anyone else, then the second factor and a rate limit), or the SQL editor. A change writes one security_events row in the
-- same transaction; a change that cannot be audited rolls back with it.
create or replace function public.set_org_film_studio_enabled(p_org uuid, p_on boolean) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  invoker text := case when coalesce(current_setting('role', true), 'none') = 'none' then session_user::text
                       else current_setting('role', true) end;
  editor  boolean := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '') = ''
                     and invoker not in ('anon', 'authenticated', 'service_role', 'authenticator')
                     and pg_has_role(invoker::name, 'postgres', 'member');
  g       jsonb;
  was     boolean;
begin
  if not editor then
    g := public.owner_guard('film_studio_org', 10);
    if g is not null then
      return g;
    end if;
  end if;
  if p_on is null then
    raise exception 'set_org_film_studio_enabled takes true or false' using errcode = '22023';
  end if;
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  insert into public.org_film_settings (org_id) values (p_org) on conflict (org_id) do nothing;
  select s.film_studio_enabled into was from public.org_film_settings s where s.org_id = p_org for update;
  if was is distinct from p_on then
    update public.org_film_settings
       set film_studio_enabled = p_on, updated_by = auth.uid(), updated_at = now()
     where org_id = p_org;
    perform public.security_event_log('film_studio.org_enabled', 'notice', p_org::text,
      jsonb_build_object('from', was, 'to', p_on, 'via', case when editor then 'sql_editor' else 'admin' end));
  end if;
  return jsonb_build_object('ok', true, 'org_id', p_org, 'enabled', p_on, 'changed', was is distinct from p_on);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The take's creative job (the worker's; service role only)
-- ───────────────────────────────────────────────────────────────────────────

-- The input pictures a take records (0166's frame roles), as the worker copies them from the media volume by id: role, asset id,
-- MIME type and stored variants. Only live files of the take's organization are listed.
create or replace function public.film_take_inputs(t public.film_takes) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('role', x.role, 'asset_id', a.id, 'mime', a.mime, 'kind', a.kind,
                                               'variants', to_jsonb(a.variants)) order by x.o), '[]'::jsonb)
    from (select 'first' as role, t.first_frame_asset_id as id, 0 as o
          union all select 'end', t.last_frame_asset_id, 1
          union all select 'reference', r.id, 1 + r.n from unnest(t.reference_asset_ids) with ordinality r(id, n)) x
    join public.media_assets a on a.id = x.id and a.org_id = t.org_id and a.deleted_at is null
$$;

-- A running take's creative job: 0171's contract (payer 'film', film_take_id, no hold of its own, quoted 0, so finish_creative_job
-- captures nothing) written for the worker that holds the segment's lease, already claimed by it ('running', its worker id), so the
-- creative worker's queue never hands it to a worker that settles credit-paid jobs. requested_by is the person who started the film,
-- as 0187 requires (creative_job_style asks their rights acknowledgement) and 0117's voice guard reads. The inputs are decided HERE,
-- from the storyboard and the takes this segment completed, never named by the caller, and recorded on the take by role:
--   keyframe   t2i from the scene's visual prompt, with the film's and the scene's reference pictures (a character is all of its
--              pictures) as references. An edit-only key-frame model has no picture to edit: refused (bad_request), never guessed.
--   clip       i2v from the first frame: the scene's key frame take's result, the scene's own picture, or (first_frame = previous)
--              the previous scene's last shot's extracted last frame; with an end frame when the quote priced one (params.end_frame):
--              the scene's picture or the next scene's key frame take's result.
--   extend     i2v from the previous shot's extracted last frame (parent_take_id = that shot).
--   narration  tts of the film's language with the voice priced; the scenes' texts are returned for the worker to voice, one scene
--              at a time on the film's clock (docs/FILM_STUDIO.md, P4a), and are never stored on the job.
-- A missing input answers {ok: false, reason: 'input_missing'} and writes nothing: the worker fails the take (bad_request).
-- Switched off (film_studio_on_for): no new job is written (NS409 film_studio_disabled); a job already submitted may be resumed.
-- Called again for a take that has its job, it answers that job (replayed: true), handed to this worker when it is still live, so a
-- worker that took over resumes the same job and never makes a second one (creative_jobs_film_take_key and film_takes_job_key also
-- say so).
create or replace function public.film_take_job(p_take uuid, p_worker text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  t      public.film_takes := public.film_lock_take(p_take, p_worker);
  w      text := left(btrim(coalesce(p_worker, '')), 120);
  s      public.film_segments;
  f      public.films;
  sc     public.film_scenes;
  nb     public.film_scenes;
  j      public.creative_jobs;
  cap    text;
  jp     jsonb;
  first_ uuid;
  last_  uuid;
  parent uuid;
  rfs    uuid[] := '{}';
  narr   jsonb := null;
  msg    text;
  hint_  text;
begin
  select * into s from public.film_segments where id = t.segment_id;
  if t.status <> 'running' or s.status not in ('running', 'draining') then
    perform public.creative_refuse('take_not_running', format('the take is %s and its segment %s', t.status, s.status), 'NS409');
  end if;
  select * into f from public.films where id = t.film_id;
  if t.kind = 'narration' then
    select jsonb_agg(jsonb_build_object('scene_id', x.id, 'position', x.position, 'planned_seconds', x.planned_seconds,
                                        'narration', x.narration) order by x.position)
      into narr from public.film_scenes x where x.film_id = t.film_id;
  end if;
  if t.creative_job_id is not null then
    select * into j from public.creative_jobs where id = t.creative_job_id;
    -- Switched off (the platform's or the organization's switch): a job that never reached the vendor is not started now; one
    -- whose submit began may still be resumed and polled, so a task the vendor may be billing is never abandoned.
    if j.submit_started_at is null and j.provider_task_id is null and not public.film_studio_on_for(t.org_id) then
      perform public.creative_refuse('film_studio_disabled', 'Film Studio is switched off: no new take is sent', 'NS409');
    end if;
    -- A worker that took over the segment's lease (its predecessor died) takes over the take's live job with it: 0036's calls
    -- (advance, attach, finish) check the job's worker id (film_claim_segment already moved it; this covers a job the queue
    -- handed back). A job the creative queue handed back ('queued') is taken back as its claim would (polled when it has a task
    -- id). A job that ended stays ended.
    update public.creative_jobs
       set worker_id = w, heartbeat_at = now(), updated_at = now(),
           status = case when status = 'queued' then case when provider_task_id is not null then 'provider_pending' else 'running' end
                         else status end
     where id = t.creative_job_id and status in ('queued', 'running', 'provider_pending', 'processing', 'rendering');
    select * into j from public.creative_jobs where id = t.creative_job_id;
    return jsonb_build_object('ok', true, 'replayed', true, 'job_id', j.id, 'job_status', j.status, 'capability', j.capability,
                              'params', j.params, 'provider_task_id', j.provider_task_id,
                              'submit_started', j.submit_started_at is not null, 'job_worker', j.worker_id,
                              'inputs', public.film_take_inputs(t), 'narration', narr);
  end if;
  -- Switched off: no new job, so no new paid provider call (the same rule film_begin_take holds).
  if not public.film_studio_on_for(t.org_id) then
    perform public.creative_refuse('film_studio_disabled', 'Film Studio is switched off: no new take is sent', 'NS409');
  end if;
  if t.scene_id is not null then
    select * into sc from public.film_scenes where id = t.scene_id;
  end if;

  if t.kind = 'keyframe' then
    if not exists (select 1 from public.model_registry m where m.id = t.model and 't2i' = any (m.capabilities)) then
      return jsonb_build_object('ok', false, 'reason', 'bad_request',
        'detail', 'this key-frame model edits a picture and the scene names none to edit; choose a model that makes a picture from words');
    end if;
    cap := 't2i';
    select coalesce(array_agg(x.id order by x.o1, x.o2, x.o3), '{}') into rfs from (
      select r.asset_id as id, (r.scene_id is not null)::int as o1, r.position as o2, 0 as o3
        from public.film_refs r where r.film_id = t.film_id and (r.scene_id is null or r.scene_id = t.scene_id) and r.asset_id is not null
      union all
      select cr.asset_id, (r.scene_id is not null)::int, r.position, cr.position
        from public.film_refs r join public.character_references cr on cr.character_id = r.character_id and cr.org_id = r.org_id
       where r.film_id = t.film_id and (r.scene_id is null or r.scene_id = t.scene_id) and r.character_id is not null) x;
    if cardinality(rfs) > 16 or exists (select 1 from unnest(rfs) r(id) where not public.film_asset_live(t.org_id, r.id, 'image')) then
      return jsonb_build_object('ok', false, 'reason', 'input_missing',
                                'detail', 'a reference picture of this scene is gone or there are more than 16; edit the references');
    end if;
    jp := t.params || jsonb_build_object('prompt', sc.visual_prompt)
              || case when btrim(sc.negative_prompt) <> '' then jsonb_build_object('negative_prompt', sc.negative_prompt)
                      else '{}'::jsonb end;
  elsif t.kind in ('clip', 'extend') then
    cap := 'i2v';
    if t.kind = 'extend' then
      select x.id, x.result_last_frame_asset_id into parent, first_ from public.film_takes x
       where x.segment_id = t.segment_id and x.scene_id = t.scene_id and x.kind in ('clip', 'extend')
         and x.shot_index = t.shot_index - 1 and x.status = 'completed'
       order by x.attempt desc limit 1;
    elsif sc.first_frame = 'keyframe' then
      select x.result_asset_id into first_ from public.film_takes x
       where x.segment_id = t.segment_id and x.scene_id = t.scene_id and x.kind = 'keyframe' and x.status = 'completed'
       order by x.attempt desc limit 1;
    elsif sc.first_frame = 'asset' then
      first_ := sc.first_frame_asset_id;
    else
      select * into nb from public.film_scenes x where x.film_id = t.film_id and x.position < sc.position
       order by x.position desc limit 1;
      select x.result_last_frame_asset_id into first_ from public.film_takes x
       where x.segment_id = t.segment_id and x.scene_id = nb.id and x.kind in ('clip', 'extend')
         and x.shot_index = nb.shot_count and x.status = 'completed'
       order by x.attempt desc limit 1;
    end if;
    if t.params ? 'end_frame' then
      if sc.last_frame = 'asset' then
        last_ := sc.last_frame_asset_id;
      elsif sc.last_frame = 'next_keyframe' then
        select * into nb from public.film_scenes x where x.film_id = t.film_id and x.position > sc.position
         order by x.position limit 1;
        select x.result_asset_id into last_ from public.film_takes x
         where x.segment_id = t.segment_id and x.scene_id = nb.id and x.kind = 'keyframe' and x.status = 'completed'
         order by x.attempt desc limit 1;
      end if;
      if last_ is null or not public.film_asset_live(t.org_id, last_, 'image') then
        return jsonb_build_object('ok', false, 'reason', 'input_missing',
                                  'detail', 'the picture this shot must end on is not there; shoot it again');
      end if;
    end if;
    if first_ is null or not public.film_asset_live(t.org_id, first_, 'image') then
      return jsonb_build_object('ok', false, 'reason', 'input_missing',
                                'detail', 'the picture this shot starts from is not there; shoot the shot before it again');
    end if;
    jp := (t.params - 'end_frame') || jsonb_build_object('source_asset_id', first_, 'prompt', sc.visual_prompt)
              || case when btrim(sc.negative_prompt) <> '' then jsonb_build_object('negative_prompt', sc.negative_prompt)
                      else '{}'::jsonb end
              || case when last_ is not null then jsonb_build_object('end_asset_id', last_) else '{}'::jsonb end;
  elsif t.kind = 'narration' then
    cap := 'tts';
    -- 0117's guard reads every tts insert as a TEST (a voice still 'testing' passes for its owner); a film narrates for real, so
    -- the voice must be usable for 'use' by the person who started it.
    if not public.voice_usable_by(s.created_by, t.params ->> 'voice_id', t.org_id, f.channel_id, 'use') then
      return jsonb_build_object('ok', false, 'reason', 'voice_not_found',
                                'detail', 'the film''s voice is not one its starter may narrate with; pick another voice');
    end if;
    jp := t.params || jsonb_build_object('language', f.language);
  else
    return jsonb_build_object('ok', false, 'reason', 'bad_request', 'detail', format('a %s take is not made by this worker', t.kind));
  end if;

  begin
    insert into public.creative_jobs (org_id, kind, capability, mode, requested_model, params, status, worker_id, attempts,
                                      max_attempts, started_at, heartbeat_at, expires_at, payer, film_take_id, credit_unit, quantity,
                                      quoted_credits, requested_by)
    values (t.org_id, 'generate', cap, 'exact', t.model, jp, 'running', w, 1, 1, now(), now(),
            greatest(coalesce(s.deadline_at, now()), now()) + interval '2 hours', 'film', t.id, t.credit_unit, t.quantity, 0,
            s.created_by)
    returning * into j;
  exception when sqlstate '42501' then
    -- 0117's voice guard: the voice the film was priced with is not one its starter may use any more.
    get stacked diagnostics msg = message_text, hint_ = pg_exception_hint;
    if hint_ = 'voice_not_allowed' then
      return jsonb_build_object('ok', false, 'reason', 'voice_not_found',
                                'detail', 'the film''s voice is no longer available to the person who started it; pick another voice');
    end if;
    raise;
  end;
  update public.film_takes
     set creative_job_id = j.id, first_frame_asset_id = first_, last_frame_asset_id = last_, reference_asset_ids = rfs,
         parent_take_id = coalesce(parent, parent_take_id), prompt_final = left(jp ->> 'prompt', 8000), updated_at = now()
   where id = t.id
  returning * into t;
  return jsonb_build_object('ok', true, 'replayed', false, 'job_id', j.id, 'job_status', j.status, 'capability', cap,
                            'params', jp, 'provider_task_id', null, 'submit_started', false, 'job_worker', j.worker_id,
                            'inputs', public.film_take_inputs(t), 'narration', narr);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The quote and the start: 0192's bodies, one marked 0198 hunk each
-- ───────────────────────────────────────────────────────────────────────────

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
  -- 0198: the platform's switch AND this organization's own (org_film_settings.film_studio_enabled, default off), the same
  -- answer start_film gives, so the quote never reads startable for a start that refuses film_studio_disabled.
  on_ := public.film_studio_on_for(org);
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

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The claim: 0171's body, one marked 0198 hunk
-- ───────────────────────────────────────────────────────────────────────────

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

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The shortest film: 10 seconds (0166's film_limits, one marked hunk, and 0166's films_format_check with the same number)
-- ───────────────────────────────────────────────────────────────────────────
-- A 15-30 s advert is a film of 1-3 scenes of 3-30 s each; 0166 held a film's target to 60-1200 s. save_film and create_film_draft
-- read the number from film_limits (and film_json hands it to the app); the table check repeats it, so both move together.

create or replace function public.film_limits() returns jsonb
  language sql immutable set search_path = public, pg_temp as $$
  -- 0198: a film may target 10 seconds (a 15-30 s advert of 1-3 scenes); the scene rule (3-30 s) is unchanged.
  select jsonb_build_object(
    'max_scenes', 60, 'scene_seconds_min', 3, 'scene_seconds_max', 30, 'max_shots', 3,
    'max_film_seconds', 1200, 'target_seconds_min', 10, 'target_seconds_max', 1200,
    'max_topic_chars', 2000, 'max_script_chars', 40000, 'max_title_chars', 120,
    'max_narration_chars', 2000, 'max_prompt_chars', 2000, 'max_negative_chars', 1000,
    'max_film_refs', 16, 'max_scene_refs', 8, 'max_open_drafts', 50, 'max_patch_bytes', 2000000,
    'max_films_total', 500, 'max_events_per_film', 5000,
    'creates_per_hour', 30, 'saves_per_hour', 240, 'archives_per_hour', 60)
$$;
revoke all on function public.film_limits() from public, anon, authenticated, service_role;

alter table public.films drop constraint if exists films_format_check;
alter table public.films add constraint films_format_check
  check (language in ('en', 'ru', 'uz')
         and aspect in ('16:9', '9:16', '1:1')
         and target_seconds between 10 and 1200
         and (resolution is null or resolution in ('480p', '720p', '768p', '1080p', '2k', '4k')));

-- ───────────────────────────────────────────────────────────────────────────
-- 6. A film take's job is the film worker's alone (0036's queue and cancel, one marked hunk each or three)
-- ───────────────────────────────────────────────────────────────────────────
-- EVIDENCE (Breach and Lens on #853, tests/security/test_sec_film_worker_breach.py): 0036's claim_creative_job swept every stale
-- running job and picked every queued one, payer 'film' included. A film worker that stopped (a deploy) left a job whose own
-- heartbeat lapsed with the segment's: the credit worker ended it worker_lost with the paid task id still stored, and the film's
-- next claim submitted attempt 2, a second vendor call. And any member could cancel a film take's job.

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
revoke all on function public.claim_creative_job(text, interval) from public, anon, authenticated, service_role;
grant execute on function public.claim_creative_job(text, interval) to service_role;

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
  -- 0198: a film take's job is cancelled with its film (film_cancel_segment), never by a member here: it reads as missing.
  if not found or not public.is_org_member(j.org_id) or j.payer = 'film' then
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

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Ending a take ends its job; nothing new begins while off (0171's bodies, one marked hunk each)
-- ───────────────────────────────────────────────────────────────────────────

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
  -- 0198: ending a take ends its creative job, here, in the same transaction, for every path that ends a take (failed,
  -- rejected as too short, lost to the sweep or the last lease): a job left live would still obey its worker after the take
  -- was ended or retried. The caller holds film, segment and take; creative_end_locked takes the account, then the job.
  if t.creative_job_id is not null then
    perform public.creative_end_locked(t.creative_job_id, 'failed', coalesce(p_code, 'provider_error'), coalesce(p_error, p_code));
  end if;
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
  -- 0198: switched off (the platform's or the organization's switch), nothing new begins: the same rule as film_take_job's.
  if not public.film_studio_on_for(t.org_id) then
    perform public.creative_refuse('film_studio_disabled', 'Film Studio is switched off: no new take begins', 'NS409');
  end if;
  update public.film_takes set status = 'running', started_at = now(), updated_at = now() where id = t.id returning * into t;
  return public.film_take_money_json(t) || jsonb_build_object('began', true);
end
$$;
revoke all on function public.film_begin_take(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.film_begin_take(uuid, text) to service_role;

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
  -- 0198: a settled segment leaves no live take job behind (a completed take whose job was never finished, say): each is
  -- ended now, so nothing can be sent or completed for a film whose money is settled.
  perform public.creative_end_locked(j.id, 'failed', 'segment_settled', 'the film''s segment was settled')
     from public.creative_jobs j
    where j.film_take_id in (select x.id from public.film_takes x where x.segment_id = s.id)
      and j.status in ('queued', 'running', 'provider_pending', 'processing', 'rendering');
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

-- A film take's job is the film's record, not a Studio generation the person waits on: it notifies nobody (0064's trigger, with
-- payer 'film' added to its WHEN; its function is unchanged). Without this, every take, and every retried one, sends the starter a
-- "generation finished" or "failed" notification.
drop trigger if exists creative_jobs_notify on public.creative_jobs;
create trigger creative_jobs_notify
  after update of status on public.creative_jobs
  for each row
  when (new.status in ('completed', 'failed', 'expired') and old.status is distinct from new.status and new.payer <> 'film')
  execute function public.notify_creative_job_ended();

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Privileges
-- ───────────────────────────────────────────────────────────────────────────

-- Members read their organization's switch beside 0171's settings columns (column grant; RLS as 0171 set it).
grant select (film_studio_enabled) on public.org_film_settings to authenticated;

revoke all on function public.film_studio_on_for(uuid) from public, anon, authenticated, service_role;
grant execute on function public.film_studio_on_for(uuid) to service_role;
revoke all on function public.set_org_film_studio_enabled(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_org_film_studio_enabled(uuid, boolean) to authenticated;
revoke all on function public.film_take_inputs(public.film_takes) from public, anon, authenticated, service_role;
revoke all on function public.film_take_job(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.film_take_job(uuid, text) to service_role;
-- The replaced bodies keep their earlier grants (create or replace keeps them); restated so a replay leaves the same state.
revoke all on function public.quote_film(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.quote_film(uuid, integer) to authenticated;
revoke all on function public.start_film(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.start_film(uuid, text, text) to authenticated;
revoke all on function public.film_claim_segment(text, interval) from public, anon, authenticated, service_role;
grant execute on function public.film_claim_segment(text, interval) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.film_studio_on_for(uuid)', 'e5397c4d359a3113825272463fe93c06'),
      ('public.set_org_film_studio_enabled(uuid, boolean)', '7b56b06164a91b5651172470088e867a'),
      ('public.film_take_inputs(public.film_takes)', 'c8dc8dfa8b68639a5fd00be52b235ee9'),
      ('public.film_take_job(uuid, text)', '8a28484a7992a4aa2195d78878f3b399'),
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
      raise exception '0198 end state: % does not hold this file''s body (md5 %)', r.sig, h;
    end if;
  end loop;
  if not has_function_privilege('authenticated', 'public.set_org_film_studio_enabled(uuid, boolean)', 'execute')
     or has_function_privilege('anon', 'public.set_org_film_studio_enabled(uuid, boolean)', 'execute')
     or has_function_privilege('service_role', 'public.set_org_film_studio_enabled(uuid, boolean)', 'execute')
     or not has_function_privilege('service_role', 'public.film_studio_on_for(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.film_studio_on_for(uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.film_take_job(uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.film_take_job(uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.film_take_job(uuid, text)', 'execute')
     or has_function_privilege('service_role', 'public.film_take_inputs(public.film_takes)', 'execute')
     or has_function_privilege('authenticated', 'public.film_take_inputs(public.film_takes)', 'execute')
     or not has_function_privilege('authenticated', 'public.start_film(uuid, text, text)', 'execute')
     or has_function_privilege('service_role', 'public.start_film(uuid, text, text)', 'execute')
     or not has_function_privilege('service_role', 'public.film_claim_segment(text, interval)', 'execute')
     or has_function_privilege('authenticated', 'public.film_claim_segment(text, interval)', 'execute')
     or has_table_privilege('authenticated', 'public.org_film_settings', 'update')
     or has_table_privilege('service_role', 'public.org_film_settings', 'update')
     or has_table_privilege('service_role', 'public.creative_jobs', 'insert') then
    raise exception '0198 end state: a grant is not what this file sets';
  end if;
  if not exists (select 1 from pg_trigger g where g.tgrelid = 'public.creative_jobs'::regclass and g.tgname = 'creative_jobs_notify'
                    and pg_get_triggerdef(g.oid) like '%payer <> ''film''%') then
    raise exception '0198 end state: creative_jobs_notify still notifies a film take''s job';
  end if;
  if has_function_privilege('anon', 'public.cancel_creative_job(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.cancel_creative_job(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.claim_creative_job(text, interval)', 'execute')
     or not has_function_privilege('service_role', 'public.claim_creative_job(text, interval)', 'execute')
     or has_function_privilege('authenticated', 'public.film_begin_take(uuid, text)', 'execute')
     or has_function_privilege('service_role', 'public.film_fail_locked(uuid, text, text, text, numeric)', 'execute') then
    raise exception '0198 end state: a grant of a replaced body is not its earlier one';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.films'::regclass and conname = 'films_format_check'
                    and pg_get_constraintdef(oid) like '%target_seconds >= 10)%')
     or (public.film_limits() ->> 'target_seconds_min')::integer <> 10 then
    raise exception '0198 end state: a film''s shortest target is not 10 s';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'org_film_settings' and column_name = 'film_studio_enabled'
                    and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false') then
    raise exception '0198 end state: org_film_settings.film_studio_enabled is missing';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (read-only, run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.start_film(uuid,text,text)'::regprocedure) = '7971355d754165affaf3e08904b4b078'                as start_asks_the_org,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.film_claim_segment(text,interval)'::regprocedure) = '40db385bb4e3893e1085ee38dcd6f49b'      as claim_asks_the_org,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.quote_film(uuid,integer)'::regprocedure) = '99d01240ed2df7fb002f674df8891608'                 as quote_asks_the_org,
--   exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'org_film_settings'
--             and column_name = 'film_studio_enabled' and column_default = 'false')                    as org_switch_default_off,
--   not exists (select 1 from public.org_film_settings where film_studio_enabled)                       as no_org_switched_on_yet,
--   not public.film_studio_on()                                                                          as platform_switch_still_off,
--   (public.film_limits() ->> 'target_seconds_min')::integer = 10                                        as ten_second_films,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.claim_creative_job(text,interval)'::regprocedure) = '3ca4da96aabe145b34a0275ed4d1c841'      as credit_queue_skips_films,
--   (select pg_get_triggerdef(g.oid) like '%payer <> ''film''%' from pg_trigger g
--     where g.tgrelid = 'public.creative_jobs'::regclass and g.tgname = 'creative_jobs_notify')          as film_jobs_notify_nobody,
--   has_function_privilege('service_role', 'public.film_take_job(uuid, text)', 'execute')
--     and not has_function_privilege('authenticated', 'public.film_take_job(uuid, text)', 'execute')
--     and not has_function_privilege('anon', 'public.set_org_film_studio_enabled(uuid, boolean)', 'execute') as grants_ok;
--   -- no_org_switched_on_yet and platform_switch_still_off read true right after applying; they turn false only when an owner
--   -- switches Film Studio on (set_org_film_studio_enabled, set_film_studio_enabled), each audited in security_events.
