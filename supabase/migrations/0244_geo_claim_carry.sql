-- 0244_geo_claim_carry.sql — a film take and a workflow step carry the country their start verified, so a film or a workflow on a
-- model with a country list (every Google row) can run; and a start the country gate would refuse later is refused at the start.
--
-- *** LIVE ON APPLY. *** No model on sale today has a country list that the gate refuses for a member's own request, and every Google
--   model is off sale or hidden; what changes is that the day one opens, a film or workflow on it runs in an allowed country instead
--   of being refused take by take.
--
-- EVIDENCE (read from the migrations and measured in the lab, not assumed):
--   * 0208 and 0230's trigger creative_jobs_geo_gate lets a creative job on a model with a country list through only for a country
--     the database trusts: geo_claim_country(), the claim our web server signs into request.headers -> 'x-nightshift-geo'
--     (v1.<CC>.<user id>.<expiry>.<HMAC>), bound to auth.uid() and alive at most 300 seconds, read in the visitor's own request.
--   * A Film Studio take's job is written by 0198's film_take_job, called by the film worker with the service key: no visitor, no
--     claim. Every take on a Google model is refused NS400 country_unverified (0208's header says so), after start_film has held the
--     whole film's credits: a film on a Google model can never finish, and it fails only once the worker reaches the take.
--   * A workflow step after the first is made by 0231's workflow_advance_locked at an advance, as the run's starter (api_act_as): from
--     the worker's poll or another member's page the claim is missing or someone else's, so the step is refused country_unverified
--     and the run fails after its first step was paid for.
--   * The live bodies, read 2026-11-28 05:24Z (md5 of prosrc, white space folded), each produced by the file named here (traced by
--     applying the chain one file at a time in the lab, tests/security/test_sec_geo_claim_carry_0244.py pins it):
--     start_film 37d467f86ed6350598144c4252568e1f and start_film_resume 9f1444b6d34991c9964a0200986a43bb (0215), film_take_job
--     8a28484a7992a4aa2195d78878f3b399 and film_fail_locked 0676b7e0f3e3549348044a8915a246cc (0198), start_workflow_run
--     04d4ac338fbce93ceec279aac3fce89d (0226), workflow_advance_locked 37fda6dc6caf182483f10314d166579c and create_creative_job
--     88c83aa87050731c96ce8a0a5bb28b0a (0231), creative_jobs_geo_gate 6d28388da6b6b927b0da500524fe0325 (0230), geo_claim_country
--     add85b6752c03be6882a59a0ff8017ba (0208).
--
-- CHANGE (additive; five bodies replaced with marked 0244 hunks, one closed table and three internal functions added):
--   creative_geo_carry                 NEW, closed (row security on, no policy, nothing granted to anon, authenticated or
--     service_role; a trigger refuses every UPDATE): one row per film segment or workflow run whose start carried a valid claim,
--     with the country, when it was recorded and by whom. Written only inside start_film, start_film_resume and start_workflow_run,
--     from geo_claim_country()'s own answer: never a parameter, an input, a film field or a JSON value a client sends.
--   creative_geo_refusal(model, country)  NEW, internal: 0230's allow and block rule, moved out of the gate unchanged in what it
--     answers (the same words, country_unverified and country_blocked, and the same sentences). The gate and the three starts ask
--     this one copy.
--   creative_geo_carried(job row)      NEW, internal: the country a new creative_jobs row carries, or NULL. A film take's job only
--     while film_take_job names that take (nightshift.geo_carry_take, set for its one insert), for a running take with no job yet of
--     a running or draining segment, before film_segments.deadline_at (the 20 hours film_claim_segment gives the segment, the film's
--     money deadline); a workflow step's job only while workflow_advance_locked names the step's key (0231's
--     nightshift.workflow_step_key, set for its one create_creative_job call), for that pending step of a running run, made as the
--     run's starter, within 24 hours of the run's start (the bound workflow_advance_locked ends a run at: confirmation_expired).
--   creative_jobs_geo_gate (0230's body)  asks creative_geo_refusal; on INSERT, a carried country first, then this request's claim
--     as before. A model change (the worker's failover) and every other row read only the request's own claim, as before.
--   start_film, start_film_resume (0215's bodies)  read geo_claim_country() once, right after the re-pricing (film_price,
--     film_resume_price), ask every line's model, and RETURN {ok: false, reason: country_unverified | country_blocked, code: NS400}
--     before the rights acknowledgement and the hold (the start is counted, like every refusal after the count); the new segment's
--     country is recorded right after it is written.
--   start_workflow_run (0226's body)   reads the claim once after the adult gate, asks every step's model, and RAISES the refusal
--     (NS400, the step named) before the account is read or anything held; the run's country is recorded right after it is written.
--   film_take_job (0198's body)        names the take in nightshift.geo_carry_take around its one insert.
--   creative_geo_carry_prune()          NEW, internal: deletes a recorded country 30 days after its film segment settled (settled or
--     released, by settled_at) or its workflow run ended (completed, failed or cancelled, by finished_at); an open one is kept. Run
--     daily by the pg_cron job nightshift-geo-carry-prune (03:23 UTC), scheduled here where pg_cron is enabled (unscheduled first, so a
--     replay leaves one job; the end state asserts it). Where pg_cron is not enabled the file says so in a NOTICE.
--
-- NOT CHANGED: geo_claim_country (0208's body, checked), the trigger itself, workflow_advance_locked and create_creative_job (0231's,
--   whose step key this file relies on; checked to carry it), film_fail_locked (a take the gate refuses ends through it as before),
--   film_price and film_precheck (stream S2's: 0235, 0236, 0239 and 0241 replace them; this file reads neither), every price, hold and
--   capture. The API and MCP make jobs through create_creative_job with no claim and no carried row: still refused. A recorded country
--   is never reused for another segment, film or run, never extended (the deadline is the segment's or the run's own), never
--   refreshed but by a new start. There is no publish path here (CLAUDE.md rule 2).
--
-- REPLACES (drift guard: 0230's fingerprint, md5 of prosrc with every `--` comment cut to the end of its line, chr(10) or chr(13),
--   then white space folded with [[:space:]]+; the earlier body or this file's own; anything else is refused by name):
--   start_film               4aa8012b7eca6329a0030396bcce92c6 (0215) -> c74f5b0b9801a28bd12880daf9aee0a2
--                            folded only: 37d467f86ed6350598144c4252568e1f -> 6d349217df4b2c6603dfbc2f6554da0a
--   start_film_resume        4c8892ce1e05a8a547697138c603c118 (0215) -> 192f2cb98924afcc3e99eed13b9536a8
--                            folded only: 9f1444b6d34991c9964a0200986a43bb -> 24102dfae2c4ff76fb25d203d1e45d63
--   film_take_job            19a8f09549092d04cdf7af1de227f209 (0198) -> 2fd626ca8e92c9d83069c870b1875bc2
--                            folded only: 8a28484a7992a4aa2195d78878f3b399 -> 2c9726302a1e9a71a10bc0e50d5aedfd
--   start_workflow_run       b0a9e7fbe96d4ce89ad98698e75ff001 (0226) -> 5004bc19dba5249a2573f4dc0fea1980
--                            folded only: 04d4ac338fbce93ceec279aac3fce89d -> 42fe869f91544e4a6a9b9aabb7eb0d8d
--   creative_jobs_geo_gate   6a7b6f2b075c4775ee83808932f88bd0 (0230) -> 9168636478a1cbeb1a4de2ff50afaae0
--                            folded only: 6d28388da6b6b927b0da500524fe0325 -> ad88abf3ef2c71bc0817e7dfb9db3acc
--   geo_claim_country() is checked to be 0208's body (6cb8abcd7ab3dff8fb2a4ce33afa58d6, folded add85b6752c03be6882a59a0ff8017ba).
-- REPLAY. This file replays onto itself (each body is asked on its own: a database on which one earlier file was replayed takes this
--   file again). Re-running 0215, 0226, 0230 or 0238 after it FAILS LOUDLY (their guards refuse these bodies, or 0230's gate): take this file out first.
--   Re-running 0198 or 0073 after it SILENTLY puts the older film_take_job or start_workflow_run back (neither guards it), and
--   re-running 0208 silently puts 0208's gate back: apply 0230 and this file again after. Each such state fails closed (a take or a
--   step is refused country_unverified, as before this file). rollback_0215, rollback_0226 and rollback_0230 refuse while this file's
--   bodies are live; rollback_0171 and rollback_0073 cannot drop a table creative_geo_carry references: take this file out first.
--
-- APP. The workflow routes already send the signed claim for a run with a gated step (Run now, advance), and the film start route
--   (app/api/films/[id]/start) sends it for a project with a gated model (the same helper, lib/server/geo-claim.ts). A resume has no
--   web route yet: start_film_resume reads the claim the same way, and without one it refuses a gated project country_unverified,
--   with nothing held (fails closed; accepted as a known gap until that route exists).
--
-- NUMBER. 0244, assigned to stream S10 (0243 is S10's creative_price, a separate PR; 0240 is reserved by S2). Needs 0036, 0073, 0198,
--   0208, 0215, 0226, 0230, 0231. Independent of S2's 0235, 0236, 0239 and 0241 (none of them replaces these bodies) and of 0243.
-- Rollback: docs/sql/rollback_0244_geo_claim_carry.sql (owner-applied): the five earlier bodies back verbatim, the three functions and
--   the table dropped, the pg_cron job unscheduled.
--
-- NO BACKSLASH in this file or its rollback (an apply tool can rewrite escape sequences).
--
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).

set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  if to_regprocedure('public.geo_claim_country()') is null or to_regprocedure('public.creative_jobs_geo_gate()') is null
     or to_regprocedure('public.creative_refuse(text, text, text)') is null then
    raise exception '0244 needs 0208 (geo_claim_country), 0230 (creative_jobs_geo_gate) and 0036 (creative_refuse): apply them first';
  end if;
  if to_regprocedure('public.start_film_resume(uuid, text, text)') is null or to_regprocedure('public.film_take_job(uuid, text)') is null
     or to_regclass('public.film_segments') is null then
    raise exception '0244 needs Film Studio (0171, 0198, 0215): apply 0215_film_archive_resume.sql first';
  end if;
  if to_regprocedure('public.is_org_spender(uuid, text)') is null or to_regclass('public.workflow_runs') is null then
    raise exception '0244 needs 0226 (start_workflow_run on is_org_spender) and 0073 (workflow_runs): apply them first';
  end if;
  -- A step carries its run's country only while workflow_advance_locked names the step's key for its one create_creative_job call,
  -- and create_creative_job refuses a wf: key it did not name (0231). Without both, a step would carry nothing (it would fail closed).
  if coalesce((select position('nightshift.workflow_step_key' in prosrc) > 0 from pg_proc
                 where oid = to_regprocedure('public.workflow_advance_locked(uuid, boolean)')), false) is not true
     or coalesce((select position('nightshift.workflow_step_key' in prosrc) > 0 from pg_proc
                 where oid = to_regprocedure('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)')), false) is not true then
    raise exception '0244 needs 0231 (the workflow step key in workflow_advance_locked and create_creative_job): apply 0231_cancel_audit.sql first';
  end if;
  -- What the gate trusts is 0208's claim reader, unchanged (0230's fingerprint).
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = 'public.geo_claim_country()'::regprocedure;
  if h is distinct from '6cb8abcd7ab3dff8fb2a4ce33afa58d6' then
    raise exception '0244 found a geo_claim_country() that is not 0208''s body (md5 %): read it first', h;
  end if;
  -- The five bodies this file replaces: the earlier one, or this file's own (a replay). Each is asked on its own, so a database on
  -- which one earlier file was replayed takes this file again.
  for r in select * from (values
      ('public.start_film(uuid, text, text)', '4aa8012b7eca6329a0030396bcce92c6', 'c74f5b0b9801a28bd12880daf9aee0a2', '0215'),
      ('public.start_film_resume(uuid, text, text)', '4c8892ce1e05a8a547697138c603c118', '192f2cb98924afcc3e99eed13b9536a8', '0215'),
      ('public.film_take_job(uuid, text)', '19a8f09549092d04cdf7af1de227f209', '2fd626ca8e92c9d83069c870b1875bc2', '0198'),
      ('public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)', 'b0a9e7fbe96d4ce89ad98698e75ff001', '5004bc19dba5249a2573f4dc0fea1980', '0226'),
      ('public.creative_jobs_geo_gate()', '6a7b6f2b075c4775ee83808932f88bd0', '9168636478a1cbeb1a4de2ff50afaae0', '0230')) v(sig, was, now_, src) loop
    select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is null or h <> all (array[r.was, r.now_]) then
      raise exception '0244 found % with a body that is neither %''s nor 0244''s (md5 %): read the live body first', r.sig, r.src, h;
    end if;
  end loop;
  -- A table of this name that is not this file's is not taken over.
  if to_regclass('public.creative_geo_carry') is not null
     and (select array_agg(attname::text order by attnum) from pg_attribute
           where attrelid = to_regclass('public.creative_geo_carry') and attnum > 0 and not attisdropped)
         is distinct from array['id', 'film_segment_id', 'workflow_run_id', 'country', 'recorded_at', 'recorded_by'] then
    raise exception '0244 found a table public.creative_geo_carry that is not this file''s: read it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Where a start's country is kept (closed: no API role reads or writes it)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.creative_geo_carry (
  id              bigint generated always as identity primary key,
  film_segment_id uuid unique references public.film_segments (id) on delete cascade,
  workflow_run_id uuid unique references public.workflow_runs (id) on delete cascade,
  country         text not null,
  recorded_at     timestamptz not null default now(),
  recorded_by     uuid not null,
  constraint creative_geo_carry_one_start check (num_nonnulls(film_segment_id, workflow_run_id) = 1),
  constraint creative_geo_carry_country_shape check (country ~ '^[A-Z]{2}$')
);

comment on table public.creative_geo_carry is
  'The country a film segment''s or a workflow run''s start read from the starter''s signed claim (migration 0244), which its takes or steps carry to creative_jobs_geo_gate until that start''s deadline. Written only by start_film, start_film_resume and start_workflow_run; never updated; no API role reads or writes it.';

alter table public.creative_geo_carry enable row level security;
revoke all on table public.creative_geo_carry from public, anon, authenticated, service_role;
revoke all on sequence public.creative_geo_carry_id_seq from public, anon, authenticated, service_role;

-- Never extended, never refreshed: a recorded country changes only by a new start, which is a new row. (Row security is not asked of
-- the table's owner, so the definer functions could update it; this trigger refuses them too.)
create or replace function public.creative_geo_carry_frozen() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  raise exception 'creative_geo_carry is written once by a start and never changed' using errcode = '42501';
end
$$;
revoke all on function public.creative_geo_carry_frozen() from public, anon, authenticated, service_role;

drop trigger if exists creative_geo_carry_frozen on public.creative_geo_carry;
create trigger creative_geo_carry_frozen before update on public.creative_geo_carry
  for each row execute function public.creative_geo_carry_frozen();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The gate's rule, in one place, and what a take or a step carries
-- ───────────────────────────────────────────────────────────────────────────

-- 0230's allow and block rule, moved out of the gate unchanged in what it answers, so that the gate and the three starts ask one copy.
-- NULL: the model may run in this country, or has no country list (then no country is needed). Otherwise reason and detail, the words
-- and sentences 0230's gate raised. p_country NULL is "no trusted country".
create or replace function public.creative_geo_refusal(p_model text, p_country text) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  lst  jsonb;
  al   jsonb;
  prov text;
  deny boolean;
begin
  select r.spec -> 'blocked_countries', r.spec -> 'available_countries', r.provider into lst, al, prov
    from public.model_registry r where r.id = p_model;
  -- 0230: a row with the key available_countries (any value, JSON null included) is asked even with no deny-list (BR-S6-05).
  deny := not (lst is null or lst = 'null'::jsonb or lst = '[]'::jsonb);
  if not deny and al is null then
    return null;
  end if;
  -- A model with a country list: only a country this database can trust. None is refused, never let through as "unknown".
  if p_country is null then
    return jsonb_build_object('reason', 'country_unverified',
      'detail', format('%s is sold only where the country of the request is confirmed by the web app; nothing was held', p_model));
  end if;
  -- A list of any other shape fails closed.
  if deny and (jsonb_typeof(lst) <> 'array' or lst ? p_country) then
    return jsonb_build_object('reason', 'country_blocked',
      'detail', format('%s is not available in this region; nothing was held', p_model));
  end if;
  -- 0230 (BR-S6-04): a row with available_countries, or a Google row with any country list, runs only in a country on that
  -- allow-list; a code on neither list is unknown, and unknown is refused; a list of another shape fails closed.
  if al is not null or prov = 'google' then
    if al is null or jsonb_typeof(al) <> 'array' or not (al ? p_country) then
      return jsonb_build_object('reason', 'country_unverified',
        'detail', format('%s is sold only in the regions its vendor lists, and the country of the request is not one of them; nothing was held', p_model));
    end if;
  end if;
  return null;
end
$$;
revoke all on function public.creative_geo_refusal(text, text) from public, anon, authenticated, service_role;

-- The country a new creative_jobs row carries from its start, or NULL. Only for the row the start's own path is writing, now:
--   a film take's job: film_take_job names the take in nightshift.geo_carry_take for its one insert; the take is running and has no job
--     yet, its model is the row's, and its segment is running or draining, recorded a country at its start, and is before its
--     deadline (film_segments.deadline_at, the 20 hours film_claim_segment gives it);
--   a workflow step's job: workflow_advance_locked names the step's key in nightshift.workflow_step_key for its one
--     create_creative_job call (0231), and the row holds that key; the step is pending with the row's model and capability, the run
--     is running and not being stopped, the row is made as the run's starter, its start recorded a country, and the run is within
--     24 hours of its start (the bound workflow_advance_locked ends it at, confirmation_expired).
-- Neither setting is one a caller can name (set_config is pg_catalog's, which PostgREST does not expose, and no exposed function sets
-- either); and even named, the row has to be that take's or that step's, which only those two functions write.
create or replace function public.creative_geo_carried(j public.creative_jobs) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c   text;
  k   text;
  run uuid;
  idx integer;
begin
  if j.payer = 'film' and j.film_take_id is not null then
    if j.film_take_id::text is distinct from nullif(current_setting('nightshift.geo_carry_take', true), '') then
      return null;
    end if;
    select g.country into c
      from public.film_takes t
      join public.film_segments s on s.id = t.segment_id
      join public.creative_geo_carry g on g.film_segment_id = s.id
     where t.id = j.film_take_id and t.org_id = j.org_id and s.org_id = j.org_id and s.film_id = t.film_id
       and t.status = 'running' and t.creative_job_id is null and t.model = j.requested_model
       and s.status in ('running', 'draining') and s.deadline_at is not null and now() <= s.deadline_at;
    return c;
  end if;
  k := nullif(current_setting('nightshift.workflow_step_key', true), '');
  if k is null or j.idempotency_key is distinct from k
     or k !~ '^wf:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,4}$' then
    return null;
  end if;
  run := split_part(k, ':', 2)::uuid;
  idx := split_part(k, ':', 3)::integer;
  select g.country into c
    from public.workflow_runs r
    join public.workflow_run_steps s on s.run_id = r.id and s.step_index = idx
    join public.creative_geo_carry g on g.workflow_run_id = r.id
   where r.id = run and r.org_id = j.org_id and s.org_id = j.org_id
     and r.status = 'running' and r.cancel_requested_at is null
     and s.status = 'pending' and s.model = j.requested_model and s.capability = j.capability
     and j.requested_by is not distinct from r.started_by
     and r.created_at >= now() - interval '24 hours';
  return c;
end
$$;
revoke all on function public.creative_geo_carried(public.creative_jobs) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The gate (0230's body: its rule moved into creative_geo_refusal, the carried country added; 0244 lines marked)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.creative_jobs_geo_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m   text := coalesce(new.routed_model, new.requested_model);
  c   text;
  bad jsonb;
begin
  -- A row that does not change its model is not asked again (a status, a heartbeat, a result).
  if tg_op = 'UPDATE' and new.routed_model is not distinct from old.routed_model then
    return new;
  end if;
  -- 0244: 0230's allow and block rule lives in creative_geo_refusal now, the one copy the film and workflow starts ask too. Asked
  -- with no country first: a model with no country list is not asked, and no claim is read for it.
  if public.creative_geo_refusal(m, null) is null then
    return new;
  end if;
  -- 0244: a new row that is a film take's job (film_take_job) or a workflow step's (workflow_advance_locked) carries the country
  -- its start recorded, for that film segment or run only, before its deadline (creative_geo_carried). Any other row, and a
  -- model change, reads only this request's own signed claim (geo_claim_country), as before: the API, MCP, the worker's failover
  -- and a direct create_creative_job have none and are refused.
  if tg_op = 'INSERT' then
    c := public.creative_geo_carried(new);
  end if;
  if c is null then
    c := public.geo_claim_country();
  end if;
  bad := public.creative_geo_refusal(m, c);
  if bad is not null then
    perform public.creative_refuse(bad ->> 'reason', bad ->> 'detail');
  end if;
  return new;
end
$$;

revoke all on function public.creative_jobs_geo_gate() from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The film starts (0215's bodies, marked 0244 hunks) and the take's job (0198's body, one marked hunk)
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
  -- 0244: the starter's country, read once from this request's signed claim, and a line's country refusal.
  geo_c   text;
  geo_bad jsonb;
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
  -- 0215 (the owner's decision, 22 Nov): spending an organization's credits takes a seat in it. 0043's accessible_org_ids makes a
  -- platform owner or admin an admin of every organization; that stays read-only support access, and only an owner or admin
  -- MEMBER (org_members) holds the organization's credits. In the exempt organization the credits are the platform's own, so its
  -- platform owner or admin may, as before. Who may call is refused before anything is counted.
  if not public.is_org_spender(org, 'admin') then
    perform public.creative_refuse('not_a_member',
      'you are not an owner or admin member of this workspace; ask the workspace''s owner to add you as a member', 'NS400');
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
    -- 0215: the segment as a member may read it: never the worker's id (the host name and process id by default), which 0171's
    -- column grant withholds and a replay after the claim would otherwise hand back.
    return (public.film_segment_json(s) - 'worker_id') || jsonb_build_object('ok', true, 'replayed', true);
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
  -- 0215: the cap is the whole film's (0171: "no film whose total is above it may start"): a film back at draft after a paid
  -- segment counts what it already captured too (film_captured).
  if st ->> 'max_credits_per_film' is not null
     and public.film_captured(f.id) + fq.total > (st ->> 'max_credits_per_film')::numeric then
    return jsonb_build_object('ok', false, 'reason', 'cap_exceeded', 'code', 'NS400',
      'detail', format('this film has cost %s credits, starting it costs %s more, and the organization allows %s a film',
                       public.film_captured(f.id), fq.total, st ->> 'max_credits_per_film'));
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
  -- 0244: a take's creative job is written later, by the worker, in a transaction that carries no visitor, so the country gate
  -- (creative_jobs_geo_gate) has no claim to read then. The country is read HERE, in the starter's own request, from the claim our
  -- web server signed for this person (geo_claim_country; never a parameter, never a field of the film), and every line's model is
  -- asked the gate's own question (creative_geo_refusal, the one copy of 0230's allow and block rule) after the re-pricing (film_price) and before
  -- the hold: a film the gate would refuse take by take is refused now, by name, with nothing held. Returned, like every refusal
  -- after the count.
  geo_c := public.geo_claim_country();
  for ln in select l from jsonb_array_elements(q -> 'lines') l where l ? 'model' loop
    geo_bad := public.creative_geo_refusal(ln ->> 'model', geo_c);
    if geo_bad is not null then
      return jsonb_build_object('ok', false, 'reason', geo_bad ->> 'reason', 'code', 'NS400', 'detail', geo_bad ->> 'detail');
    end if;
  end loop;
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
  -- 0244: the country THIS segment's takes carry to the gate, and only until the segment's own deadline (film_segments.deadline_at,
  -- set when the worker claims it). Written once, here, for a new segment: never updated (creative_geo_carry_frozen), never read
  -- for another segment, another film or a direct create_creative_job. No claim, nothing recorded (the takes then carry nothing).
  if geo_c is not null then
    insert into public.creative_geo_carry (film_segment_id, country, recorded_by) values (sid, geo_c, uid);
  end if;

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

revoke all on function public.start_film(uuid, text, text) from public, anon, service_role;
grant execute on function public.start_film(uuid, text, text) to authenticated;

create or replace function public.start_film_resume(p_film uuid, p_quote_id text, p_idempotency_key text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  org     uuid;
  f       public.films;
  s       public.film_segments;
  g       uuid;
  q       jsonb;
  st      jsonb;
  ln      jsonb;
  bad     jsonb;
  ct      public.film_takes;
  sid     uuid := gen_random_uuid();
  ref     text;
  exempt_ boolean;
  total   numeric;
  hash    text;
  asm     jsonb;
  n_takes integer := 0;
  n_carry integer := 0;
  v       integer;
  w       text;
  d       text;
  msg     text;
  fq      public.film_quotes;
  gs      public.film_segments;
  rerun   boolean;
  paid    numeric;
  lim     jsonb := public.film_money_limits();
  -- 0244: the starter's country, read once from this request's signed claim, and a line's country refusal.
  geo_c   text;
  geo_bad jsonb;
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
  -- 0215 (the owner's decision, 22 Nov): spending an organization's credits takes a seat in it. 0043's accessible_org_ids makes a
  -- platform owner or admin an admin of every organization; that stays read-only support access, and only an owner or admin
  -- MEMBER (org_members) holds the organization's credits. In the exempt organization the credits are the platform's own, so its
  -- platform owner or admin may, as before. Who may call is refused before anything is counted.
  if not public.is_org_spender(org, 'admin') then
    perform public.creative_refuse('not_a_member',
      'you are not an owner or admin member of this workspace; ask the workspace''s owner to add you as a member', 'NS400');
  end if;
  -- 0192's adult refusals, first once the caller is known to be the organization's admin, as start_film asks them.
  bad := public.film_adult_refusals(p_film, uid) -> 0;
  if bad is not null then
    perform public.creative_refuse(bad ->> 'reason', bad ->> 'detail');
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$' then
    perform public.creative_refuse('invalid_idempotency_key', 'the idempotency key must be 8 to 128 letters, digits or _.:-');
  end if;
  if p_quote_id is null or p_quote_id !~ '^fq-[0-9]{1,9}-[0-9a-f]{32}$' then
    perform public.creative_refuse('invalid_params', 'quote_id must be the quote_id quote_film_resume answered');
  end if;
  -- Never the same hash as start_film's for the same film and quote: a key used to start a film never replays as a resume.
  hash := md5(jsonb_build_object('film', p_film, 'quote', p_quote_id, 'purpose', 'resume')::text);

  -- start_film's own lock: one start or resume per organization at a time, so the replay lookup, the active-film count and the hold
  -- cannot be raced, by a second resume or by a start.
  perform pg_advisory_xact_lock(hashtextextended('film_start:' || org::text, 0));
  select * into s from public.film_segments where org_id = org and idempotency_key = p_idempotency_key;
  if found then
    if s.request_hash <> hash then
      perform public.creative_refuse('idempotency_conflict', 'this idempotency key was used to start another film or quote', 'NS409');
    end if;
    return (public.film_segment_json(s) - 'worker_id') || jsonb_build_object('ok', true, 'replayed', true);
  end if;

  -- The cheap refusals, before anything is counted or priced.
  select * into f from public.films where id = p_film for no key update;
  if f.status <> 'paused' then
    -- A film this resume (or another) already took on is queued or running: a new key is refused here, never a second segment.
    perform public.creative_refuse('film_not_resumable',
      case when f.status = 'cancelled' then 'a cancelled film is not resumed; archive it, or make a new film from its storyboard'
           else format('a %s film cannot be resumed; only a paused one can', f.status) end, 'NS409');
  end if;
  if split_part(p_quote_id, '-', 2)::integer <> f.version then
    perform public.creative_refuse('film_changed',
      format('the film was edited after this quote (it is at version %s); quote it again', f.version), 'NS409');
  end if;
  if not public.film_studio_on_for(org) then
    perform public.creative_refuse('film_studio_disabled', 'Film Studio is not switched on yet; nothing was held', 'NS409');
  end if;
  select x.id into g from public.film_segments x where x.film_id = f.id order by x.n desc limit 1;
  if exists (select 1 from public.film_segments x where x.film_id = f.id and x.status in ('queued', 'running', 'draining')) then
    perform public.creative_refuse('film_not_resumable', 'this film is running already', 'NS409');
  end if;
  bad := public.film_resume_precheck(f, g);
  if bad is not null then
    perform public.creative_refuse(bad ->> 'reason', bad ->> 'detail',
                                   case when bad ->> 'reason' = 'nothing_to_resume' then 'NS409' else 'NS400' end);
  end if;
  -- A re-run of the assembly (it failed, and every take is done and carried): only for a failure the same takes may cure. The word
  -- is the segment's settle_reason, which the worker settles a failed assembly with (modules/film_orchestrator.py, _assembly).
  select * into gs from public.film_segments where id = g;
  rerun := gs.assembly_status = 'failed'
           and not exists (select 1 from public.film_takes t where t.segment_id = g
                            group by t.kind, t.scene_id, t.shot_index having not bool_or(public.film_resume_done(t)));
  if rerun and not public.film_assembly_retryable(gs.settle_reason) then
    perform public.creative_refuse('assembly_not_retryable', format('word=%s', coalesce(gs.settle_reason, 'none')), 'NS409');
  end if;
  -- Two re-runs in a row that ended with a lost word: no third for free; a person (support) looks at why the assembly dies.
  if rerun and public.film_lost_reruns(g) >= 2 then
    perform public.creative_refuse('assembly_not_retryable',
      format('word=%s reruns=%s', gs.settle_reason, public.film_lost_reruns(g)), 'NS409');
  end if;
  -- What the quote carried must still be what it was: each take completed, with the same result and last frame, both still in the
  -- library. Anything else since the quote is a changed film, refused before anything is counted. The files are locked FOR SHARE
  -- first and stay locked to commit, so none of them can be soft-deleted between this check and the carried copies below.
  perform 1 from public.media_assets a
   where a.id in (select (c ->> k)::uuid
                    from public.film_quotes x, jsonb_array_elements(coalesce(x.carried, '[]'::jsonb)) c,
                         unnest(array['result_asset_id', 'result_last_frame_asset_id']) k
                   where x.film_id = f.id and x.quote_id = p_quote_id and x.purpose = 'resume' and x.from_segment = g
                     and c ->> k is not null)
   order by a.id
     for share;
  if exists (select 1 from public.film_quotes x, jsonb_array_elements(coalesce(x.carried, '[]'::jsonb)) c
              where x.film_id = f.id and x.quote_id = p_quote_id and x.purpose = 'resume' and x.from_segment = g
                and not exists (select 1 from public.film_takes t
                                 where t.id = (c ->> 'take_id')::uuid and t.segment_id = g
                                   and t.result_asset_id is not distinct from (c ->> 'result_asset_id')::uuid
                                   and t.result_last_frame_asset_id is not distinct from (c ->> 'result_last_frame_asset_id')::uuid
                                   and public.film_resume_done(t))) then
    perform public.creative_refuse('film_changed',
      'a take this quote carries changed or its file was deleted since the quote; quote the resume again', 'NS409');
  end if;
  perform public.film_take_rate('start', (lim ->> 'starts_per_hour')::integer);

  -- Counted: from here every refusal is returned, so the counter commits with it. The stored resume quote first (no pricing yet).
  select * into fq from public.film_quotes x
   where x.film_id = f.id and x.quote_id = p_quote_id and x.version = f.version and x.purpose = 'resume' and x.from_segment = g;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'price_changed', 'code', 'NS409',
                              'detail', 'this is not a resume quote of the film as it stands; quote the resume again');
  end if;
  if fq.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'quote_expired', 'code', 'NS409',
                              'detail', 'this quote has expired; quote the resume again');
  end if;
  st := public.film_settings_of(org);
  if not exempt_ and fq.total > public.film_available(org) then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_credits', 'code', 'NS402',
                              'detail', format('available=%s needed=%s', public.film_available(org), fq.total));
  end if;
  -- The cap is the whole film's (0171: "no film whose total is above it may start"): what its segments captured plus this resume.
  paid := public.film_captured(f.id);
  if st ->> 'max_credits_per_film' is not null and paid + fq.total > (st ->> 'max_credits_per_film')::numeric then
    return jsonb_build_object('ok', false, 'reason', 'cap_exceeded', 'code', 'NS400',
      'detail', format('this film has cost %s credits, resuming it costs %s more, and the organization allows %s a film', paid,
                       fq.total, st ->> 'max_credits_per_film'));
  end if;
  if (select count(*) from public.film_segments x where x.org_id = org and x.status in ('queued', 'running', 'draining'))
     >= (st ->> 'max_active_films')::integer then
    return jsonb_build_object('ok', false, 'reason', 'limit_reached', 'code', 'NS400',
      'detail', format('at most %s films of this organization run at once; wait for one to finish', st ->> 'max_active_films'));
  end if;

  -- Then the re-pricing of what is left, at today's rates: what was confirmed is what is held, in either direction.
  q := public.film_resume_price(f);
  if not (q ->> 'priced')::boolean then
    bad := q -> 'refusals' -> 0;
    return jsonb_build_object('ok', false, 'reason', bad ->> 'reason', 'code', 'NS400', 'detail', bad ->> 'detail');
  end if;
  total := (q ->> 'total')::numeric;
  if q ->> 'quote_id' <> p_quote_id then
    return jsonb_build_object('ok', false, 'reason', 'price_changed', 'code', 'NS409',
                              'detail', format('resuming now costs %s credits; quote the resume again', total));
  end if;
  -- 0244: a take's creative job is written later, by the worker, in a transaction that carries no visitor, so the country gate
  -- (creative_jobs_geo_gate) has no claim to read then. The country is read HERE, in the starter's own request, from the claim our
  -- web server signed for this person (geo_claim_country; never a parameter, never a field of the film), and every line's model is
  -- asked the gate's own question (creative_geo_refusal, the one copy of 0230's allow and block rule) after the re-pricing of what is left (film_resume_price) and before
  -- the hold: a film the gate would refuse take by take is refused now, by name, with nothing held. Returned, like every refusal
  -- after the count.
  geo_c := public.geo_claim_country();
  for ln in select l from jsonb_array_elements(q -> 'lines') l where l ? 'model' loop
    geo_bad := public.creative_geo_refusal(ln ->> 'model', geo_c);
    if geo_bad is not null then
      return jsonb_build_object('ok', false, 'reason', geo_bad ->> 'reason', 'code', 'NS400', 'detail', geo_bad ->> 'detail');
    end if;
  end loop;
  -- 0187's rights acknowledgement, asked of the person who resumes (and pays) exactly as start_film asks it.
  bad := public.film_acknowledgement_missing(f, uid);
  if bad is not null then
    return jsonb_build_object('ok', false, 'reason', 'acknowledgement_required', 'code', 'NS400',
      'detail', format('kind=%s version=%s subject=%s', bad ->> 'kind', coalesce(bad ->> 'text_version', 'none'), bad ->> 'subject'));
  end if;

  -- The hold, for the resume total only: 0020's reserve_credits in the admin's own session, before anything is created, with
  -- start_film's answers to its refusals.
  ref := 'fm-' || replace(sid::text, '-', '');
  if exempt_ or total = 0 then
    ref := null;
  else
    begin
      perform public.reserve_credits(org, ref, total);
    exception when sqlstate 'NS402' or sqlstate 'NS429' or sqlstate '22023' or sqlstate '23505' then
      get stacked diagnostics w = returned_sqlstate, d = pg_exception_detail, msg = message_text;
      if w in ('22023', '23505') then
        perform public.film_log(f.id, org, null, 'start_refused',
          jsonb_build_object('reason', 'hold_refused', 'code', w, 'quote_id', p_quote_id, 'credits', total, 'resume', true,
                             'message', left(coalesce(nullif(d, ''), msg), 200)));
      end if;
      return jsonb_build_object('ok', false,
                                'reason', case w when 'NS402' then 'insufficient_credits' when 'NS429' then 'run_slots_full'
                                                 else 'hold_refused' end,
                                'code', w, 'detail', coalesce(nullif(d, ''), msg));
    end;
  end if;

  select l into asm from jsonb_array_elements(q -> 'lines') l where l ->> 'line' = 'assembly';
  insert into public.film_segments (id, film_id, org_id, n, purpose, resumed_from, film_version, quote_id, status, credit_ref, exempt,
                                    confirmed_credits, assembly_minutes, assembly_unit_credits, assembly_confirmed_credits,
                                    max_attempts, idempotency_key, request_hash, created_by)
  values (sid, f.id, org, coalesce((select max(x.n) from public.film_segments x where x.film_id = f.id), 0) + 1, 'resume', g,
          f.version, p_quote_id, 'queued', ref, exempt_, total, (asm ->> 'quantity')::integer,
          (asm ->> 'credits_per_unit')::numeric, (asm ->> 'credits')::numeric,
          (lim ->> 'max_attempts')::integer, p_idempotency_key, hash, uid)
  returning * into s;
  -- 0244: the country THIS segment's takes carry to the gate, and only until the segment's own deadline (film_segments.deadline_at,
  -- set when the worker claims it). Written once, here, for a new segment: never updated (creative_geo_carry_frozen), never read
  -- for another segment, another film or a direct create_creative_job. No claim, nothing recorded (the takes then carry nothing).
  if geo_c is not null then
    insert into public.creative_geo_carry (film_segment_id, country, recorded_by) values (sid, geo_c, uid);
  end if;

  -- The carried takes: a copy of each take the earlier segment completed, in this segment, completed, at 0, with the same result and
  -- last frame, so 0198's film_take_job finds a next take's inputs here and the assembly cuts this segment's takes. Never charged:
  -- film_takes_carried_check holds it in the table. The version is the next of its scene (or of the narration), as start_film
  -- numbers a take, so every take of a scene in this segment is one version.
  for ct in select t.* from public.film_takes t
             where t.id in (select (c ->> 'take_id')::uuid from jsonb_array_elements(q -> 'carried') c)
             order by t.scene_id nulls last, t.shot_index, t.id loop
    v := coalesce((select max(t.version) from public.film_takes t
                    where t.film_id = f.id and t.scene_id is not distinct from ct.scene_id
                      and t.kind = case when ct.kind = 'narration' then 'narration' else t.kind end
                      and t.segment_id is distinct from sid), 0) + 1;
    insert into public.film_takes (film_id, org_id, scene_id, version, shot_index, kind, attempt, status, model, prompt_final, params,
                                   duration_s, first_frame_asset_id, last_frame_asset_id, reference_asset_ids, result_asset_id,
                                   result_last_frame_asset_id, segment_id, credit_unit, unit_credits, quantity, minimum_credits,
                                   confirmed_credits, charged_credits, charge_basis, output_seconds, started_at, finished_at,
                                   carried_from_take_id)
    values (f.id, org, ct.scene_id, v, ct.shot_index, ct.kind, 1, 'completed', ct.model, ct.prompt_final, ct.params, ct.duration_s,
            ct.first_frame_asset_id, ct.last_frame_asset_id, ct.reference_asset_ids, ct.result_asset_id,
            ct.result_last_frame_asset_id, sid, ct.credit_unit, ct.unit_credits, ct.quantity, ct.minimum_credits,
            0, 0, 'carried_not_charged', ct.output_seconds, ct.started_at, ct.finished_at, ct.id);
    n_carry := n_carry + 1;
  end loop;
  -- A carried extend continues the carried copy of the shot before it, not the earlier segment's row.
  update public.film_takes c
     set parent_take_id = p.id
    from public.film_takes o, public.film_takes p
   where c.segment_id = sid and c.carried_from_take_id = o.id and o.parent_take_id is not null
     and p.segment_id = sid and p.carried_from_take_id = o.parent_take_id;

  for ln in select l from jsonb_array_elements(q -> 'lines') l where l ->> 'line' in ('keyframe', 'clip', 'extend', 'narration') loop
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
  perform public.film_log(f.id, org, null, case when rerun then 'assembly_rerun' else 'resumed' end,
    jsonb_build_object('segment_id', sid, 'resumed_from', g, 'quote_id', p_quote_id, 'credits', total, 'held', ref is not null,
                       'exempt', exempt_, 'takes', n_takes, 'carried', n_carry, 'version', f.version,
                       'original_remaining', q -> 'original_remaining')
    || case when rerun then jsonb_build_object('previous_failure', gs.settle_reason) else '{}'::jsonb end);
  return (public.film_segment_json(s) - 'worker_id')
         || jsonb_build_object('ok', true, 'replayed', false, 'resumed_from', g, 'carried', n_carry, 'rerun', rerun);
end
$$;

revoke all on function public.start_film_resume(uuid, text, text) from public, anon, service_role;
grant execute on function public.start_film_resume(uuid, text, text) to authenticated;

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
    -- 0244: this one insert names its take, so the country gate may read the country the take's segment recorded at its start
    -- (creative_geo_carried). Cleared right after; a refusal's rollback of this block puts it back by itself.
    perform set_config('nightshift.geo_carry_take', t.id::text, true);
    insert into public.creative_jobs (org_id, kind, capability, mode, requested_model, params, status, worker_id, attempts,
                                      max_attempts, started_at, heartbeat_at, expires_at, payer, film_take_id, credit_unit, quantity,
                                      quoted_credits, requested_by)
    values (t.org_id, 'generate', cap, 'exact', t.model, jp, 'running', w, 1, 1, now(), now(),
            greatest(coalesce(s.deadline_at, now()), now()) + interval '2 hours', 'film', t.id, t.credit_unit, t.quantity, 0,
            s.created_by)
    returning * into j;
    perform set_config('nightshift.geo_carry_take', '', true);   -- 0244
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

revoke all on function public.film_take_job(uuid, text) from public, anon, authenticated;
grant execute on function public.film_take_job(uuid, text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The workflow start (0226's body, marked 0244 hunks)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.start_workflow_run(
  p_run uuid,
  p_workflow uuid,
  p_version integer,
  p_inputs jsonb default '{}'::jsonb,
  p_max_credits numeric default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  w       public.workflows;
  prior   public.workflow_runs;
  vals    jsonb;
  hash_   text;
  q       jsonb;
  total   numeric;
  acc     public.credit_accounts;
  st      record;
  -- 0244: the starter's country, read once from this request's signed claim, and a step's country refusal.
  geo_c   text;
  geo_bad jsonb;
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_run is null then
    perform public.creative_refuse('invalid_params', 'a run id is required');
  end if;
  select * into w from public.workflows where id = p_workflow;
  if not found or w.archived_at is not null or not public.is_org_member(w.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(w.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The operator's organization is paid by the platform: only a platform admin
  -- spends there (create_creative_job asks the same of every step).
  if public.credits_exempt(w.org_id) and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501',
      detail = 'runs in the operator''s organization are started by a platform admin';
  end if;
  -- 0226 (the owner's decision, 22 Nov; 0215's is_org_spender): spending an organization's credits takes a seat in it. 0043's
  -- accessible_org_ids makes a platform owner or admin an admin of every organization; that stays read-only support access. In the
  -- exempt organization the credits are the platform's own, so its platform owner or admin may, as before. Before the account is locked, a replay answered or a run written.
  if not public.is_org_spender(w.org_id, 'editor') then
    perform public.creative_refuse('not_a_member', 'you are not an owner, admin or editor member of this workspace; ask the workspace''s owner to add you as a member', 'NS400');
  end if;
  if p_max_credits is null or p_max_credits < 0 then
    perform public.creative_refuse('confirm_price', 'the confirmed total is required');
  end if;

  -- The account first: every create (and reserve) for this organization queues
  -- behind it, so a replay of the same run finds the first one's committed rows.
  perform public.credit_account_lock(w.org_id);

  hash_ := md5(jsonb_build_object('workflow', p_workflow, 'inputs', coalesce(p_inputs, '{}'::jsonb),
                                  'max', round(p_max_credits, 2)::text)::text);
  select * into prior from public.workflow_runs where id = p_run;
  if found then
    -- The same id under another organization, another workflow, other inputs or
    -- another confirmed total is a different request: refused without saying
    -- anything about what it collided with.
    if prior.org_id <> w.org_id or prior.request_hash is distinct from hash_ then
      perform public.creative_refuse('idempotency_conflict',
        'this run id was used for a different request', 'NS409');
    end if;
    perform public.workflow_advance_locked(prior.id);
    return public.workflow_run_json(prior.id) || jsonb_build_object('replay', true);
  end if;

  if p_version is distinct from w.version then
    perform public.creative_refuse('workflow_changed',
      format('the workflow is now version %s, not %s', w.version, p_version), 'NS409');
  end if;

  vals := public.workflow_bind_inputs(w, p_inputs);
  q := public.workflow_quote_steps(w, vals);
  -- 0192: every step's adult problem before step 1 is held (rule 6, as film_adult_refusals for a film): a person who said they are
  -- under 18 starts nothing (adult_only_service); a step whose model's vendor terms are 18+ needs an adult answer
  -- (adult_attestation_required, the model named). The later steps ask again when they are made, as the confirmer.
  for st in select v, ord from jsonb_array_elements(w.steps) with ordinality as t(v, ord) loop
    perform public.adult_attestation_gate(uid, st.v ->> 'model');
  end loop;
  -- 0244: a later step is made at an advance, often from no visitor's request (the worker's poll, another member's page), where the
  -- country gate has no claim of the starter's to read. The country is read HERE, in the starter's own request, from the claim our
  -- web server signed for this person (geo_claim_country; never a parameter or an input), and every step's model is asked the
  -- gate's own question (creative_geo_refusal) before the account is read or anything held: a run the gate would refuse at a later
  -- step is refused now, by name.
  geo_c := public.geo_claim_country();
  for st in select v, ord from jsonb_array_elements(w.steps) with ordinality as t(v, ord) loop
    geo_bad := public.creative_geo_refusal(st.v ->> 'model', geo_c);
    if geo_bad is not null then
      perform public.creative_refuse(geo_bad ->> 'reason', format('step %s: %s', st.ord, geo_bad ->> 'detail'));
    end if;
  end loop;
  -- 0174: named, before the generic 'unpriced': which steps need the Studio's acknowledgement (workflow_quote_steps).
  if exists (select 1 from jsonb_array_elements(q -> 'steps') e where e.value ->> 'reason' = 'acknowledgement_required') then
    perform public.creative_refuse('acknowledgement_required',
      format('step(s) %s use a model that asks you to confirm your rights to its input; make them in the Studio',
             (select string_agg(((e.value ->> 'step_index')::integer + 1)::text, ', ') from jsonb_array_elements(q -> 'steps') e
               where e.value ->> 'reason' = 'acknowledgement_required')));
  end if;
  if not (q ->> 'priced')::boolean then
    perform public.creative_refuse('unpriced',
      format('step(s) %s cannot be priced, so the workflow has no price',
             (select string_agg((u.x::integer + 1)::text, ', ') from jsonb_array_elements_text(q -> 'unpriced_steps') u(x))));
  end if;
  total := (q ->> 'total')::numeric;
  if round(p_max_credits, 2) <> round(total, 2) then
    perform public.creative_refuse('price_changed',
      format('price=%s confirmed=%s', total, round(p_max_credits, 2)), 'NS409');
  end if;
  if not public.credits_exempt(w.org_id) then
    select * into acc from public.credit_accounts where org_id = w.org_id;
    if coalesce(acc.balance - acc.reserved, 0) < total then
      perform public.creative_refuse('insufficient_credits',
        format('available=%s needed=%s', coalesce(acc.balance - acc.reserved, 0), total), 'NS402');
    end if;
  end if;

  insert into public.workflow_runs
    (id, org_id, workflow_id, workflow_name, workflow_version, inputs, max_credits, request_hash, started_by)
  values
    (p_run, w.org_id, w.id, w.name, w.version, vals, round(total, 2), hash_, uid);
  -- 0244: the country this run's steps carry to the gate, until the run's own deadline (created_at + 24 hours, the bound
  -- workflow_advance_locked ends a run at: confirmation_expired). Written once, for a new run; never updated, never read for another run.
  if geo_c is not null then
    insert into public.creative_geo_carry (workflow_run_id, country, recorded_by) values (p_run, geo_c, uid);
  end if;
  for st in select v, ord from jsonb_array_elements(w.steps) with ordinality as t(v, ord) loop
    insert into public.workflow_run_steps (run_id, step_index, org_id, capability, model, params, quoted_credits)
    values (p_run, st.ord - 1, w.org_id, st.v ->> 'capability', st.v ->> 'model',
            public.workflow_fill_params(st.v -> 'params', vals),
            (q -> 'steps' -> (st.ord - 1)::integer ->> 'credits')::numeric);
  end loop;

  perform public.workflow_advance_locked(p_run, true);
  return public.workflow_run_json(p_run) || jsonb_build_object('replay', false);
end
$$;

revoke all on function public.start_workflow_run(uuid, uuid, integer, jsonb, numeric) from public, anon, service_role;
grant execute on function public.start_workflow_run(uuid, uuid, integer, jsonb, numeric) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The prune: a recorded country goes 30 days after its start settled
-- ───────────────────────────────────────────────────────────────────────────

-- A recorded country is kept only while some start may still use it, and a while after for whoever reads why a take was refused:
-- 30 days after its film segment settled (settled or released, by settled_at) or its workflow run ended (completed, failed or
-- cancelled, by finished_at). A row whose segment or run is still open, or has no settle time, is kept. Daily, by pg_cron (below).
create or replace function public.creative_geo_carry_prune() returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  n integer;
begin
  delete from public.creative_geo_carry g
   where exists (select 1 from public.film_segments s
                  where s.id = g.film_segment_id and s.status in ('settled', 'released') and s.settled_at < now() - interval '30 days')
      or exists (select 1 from public.workflow_runs r
                  where r.id = g.workflow_run_id and r.status in ('completed', 'failed', 'cancelled')
                    and r.finished_at < now() - interval '30 days');
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function public.creative_geo_carry_prune() from public, anon, authenticated, service_role;

-- Daily at 03:23 UTC, when pg_cron is enabled (as 0111, 0164 and 0212 schedule theirs; unscheduled first, so a replay leaves one job).
-- Where pg_cron exists a failed schedule fails the file (the end state asserts the job); where it does not, a NOTICE says so.
do $$
begin
  if to_regprocedure('cron.schedule(text, text, text)') is not null
     and to_regprocedure('cron.unschedule(text)') is not null
     and to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'nightshift-geo-carry-prune') then
      perform cron.unschedule('nightshift-geo-carry-prune');
    end if;
    perform cron.schedule('nightshift-geo-carry-prune', '23 3 * * *', 'select public.creative_geo_carry_prune()');
  else
    raise notice '%', '0244: pg_cron is not enabled, so the daily prune of creative_geo_carry was NOT scheduled. To schedule it: enable '
      || 'pg_cron in the Supabase dashboard (Database -> Extensions -> pg_cron), then apply 0244 again. Until then nothing deletes a '
      || 'recorded country (select public.creative_geo_carry_prune() in the SQL editor does it by hand)';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- End state (refuses the whole transaction if any of it is not so)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  r record;
  g record;
  n bigint;
begin
  for r in select * from (values
      ('public.start_film(uuid, text, text)', 'c74f5b0b9801a28bd12880daf9aee0a2', 'authenticated'),
      ('public.start_film_resume(uuid, text, text)', '192f2cb98924afcc3e99eed13b9536a8', 'authenticated'),
      ('public.film_take_job(uuid, text)', '2fd626ca8e92c9d83069c870b1875bc2', 'service_role'),
      ('public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)', '5004bc19dba5249a2573f4dc0fea1980', 'authenticated'),
      ('public.creative_jobs_geo_gate()', '9168636478a1cbeb1a4de2ff50afaae0', null),
      ('public.creative_geo_refusal(text, text)', 'd896cd83b199454f5f37787a6af400f6', null),
      ('public.creative_geo_carried(public.creative_jobs)', '79baa87e012afeebcbbf53ad21022a2f', null),
      ('public.creative_geo_carry_frozen()', 'c72db59fcc595adb4b2921ceb587d50e', null),
      ('public.creative_geo_carry_prune()', '5beece74ec3a197212ad07057396951d', null)) v(sig, want, who) loop
    if (select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) from pg_proc p where p.oid = to_regprocedure(r.sig)) is distinct from r.want then
      raise exception '0244 end state: % is not 0244''s body', r.sig;
    end if;
    if not (select p.prosecdef and p.proconfig = array['search_path=public, pg_temp'] and pg_get_userbyid(p.proowner) = 'postgres'
              from pg_proc p where p.oid = to_regprocedure(r.sig)) then
      raise exception '0244 end state: % is not a SECURITY DEFINER owned by postgres with a pinned search_path', r.sig;
    end if;
    for g in select * from unnest(array['anon', 'authenticated', 'service_role']) role_ loop
      if has_function_privilege(g.role_, r.sig, 'EXECUTE') is distinct from coalesce(g.role_ = r.who, false) then
        raise exception '0244 end state: EXECUTE on % for % is not what this file grants', r.sig, g.role_;
      end if;
    end loop;
  end loop;
  if not exists (select 1 from pg_trigger t where t.tgrelid = 'public.creative_jobs'::regclass and t.tgname = 'creative_jobs_geo_gate'
                    and t.tgfoid = 'public.creative_jobs_geo_gate()'::regprocedure and not t.tgisinternal and t.tgenabled = 'O') then
    raise exception '0244 end state: creative_jobs has no enabled creative_jobs_geo_gate trigger on this function';
  end if;
  if not exists (select 1 from pg_trigger t where t.tgrelid = 'public.creative_geo_carry'::regclass and t.tgname = 'creative_geo_carry_frozen'
                    and t.tgfoid = 'public.creative_geo_carry_frozen()'::regprocedure and t.tgenabled = 'O') then
    raise exception '0244 end state: creative_geo_carry is not frozen against updates';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.creative_geo_carry'::regclass)
     or pg_get_userbyid((select relowner from pg_class where oid = 'public.creative_geo_carry'::regclass)) <> 'postgres' then
    raise exception '0244 end state: creative_geo_carry is not owned by postgres with row level security on';
  end if;
  for g in select * from unnest(array['anon', 'authenticated', 'service_role']) role_ loop
    if has_table_privilege(g.role_, 'public.creative_geo_carry', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       or has_any_column_privilege(g.role_, 'public.creative_geo_carry', 'SELECT, INSERT, UPDATE, REFERENCES') then
      raise exception '0244 end state: % holds a privilege on creative_geo_carry', g.role_;
    end if;
  end loop;
  -- Dynamic, because cron.job is not there to be planned against where pg_cron is not installed. Never silent live: present, the job
  -- must be this file's, once.
  if to_regprocedure('cron.schedule(text, text, text)') is not null and to_regprocedure('cron.unschedule(text)') is not null
     and to_regclass('cron.job') is not null then
    execute 'select count(*) from cron.job where jobname = ''nightshift-geo-carry-prune'' and schedule = ''23 3 * * *'' '
            'and command = ''select public.creative_geo_carry_prune()''' into n;
    if n <> 1 then
      raise exception '0244 end state: pg_cron is installed but the job nightshift-geo-carry-prune is not this file''s, once';
    end if;
  end if;
end $$;

notify pgrst, 'reload schema';

-- Verify (the SQL editor, after applying; every column should read true):
--   select
--     (select md5(regexp_replace(regexp_replace(prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) from pg_proc where oid = 'public.start_film(uuid, text, text)'::regprocedure) = 'c74f5b0b9801a28bd12880daf9aee0a2' as start_film_0244,
--     (select md5(regexp_replace(regexp_replace(prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) from pg_proc where oid = 'public.start_film_resume(uuid, text, text)'::regprocedure) = '192f2cb98924afcc3e99eed13b9536a8' as start_film_resume_0244,
--     (select md5(regexp_replace(regexp_replace(prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) from pg_proc where oid = 'public.film_take_job(uuid, text)'::regprocedure) = '2fd626ca8e92c9d83069c870b1875bc2' as film_take_job_0244,
--     (select md5(regexp_replace(regexp_replace(prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) from pg_proc where oid = 'public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)'::regprocedure) = '5004bc19dba5249a2573f4dc0fea1980' as start_workflow_run_0244,
--     (select md5(regexp_replace(regexp_replace(prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) from pg_proc where oid = 'public.creative_jobs_geo_gate()'::regprocedure) = '9168636478a1cbeb1a4de2ff50afaae0' as creative_jobs_geo_gate_0244,
--     (select relrowsecurity from pg_class where oid = 'public.creative_geo_carry'::regclass) as carry_rls,
--     not has_table_privilege('authenticated', 'public.creative_geo_carry', 'SELECT, INSERT, UPDATE, DELETE') as carry_closed,
--     not has_function_privilege('authenticated', 'public.creative_geo_refusal(text, text)', 'EXECUTE') as rule_internal;
