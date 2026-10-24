-- 0121_voice_job_gates.sql — Custom Voice, the gates the migration needs before the owner may switch the worker on
-- (docs/CUSTOM_VOICE.md, "Gates before the owner may enable NIGHTSHIFT_VOICE_CLONING": G2, G3, and "Hard conditions" 2).
--
-- LIVE ON APPLY. This file changes two functions that exist on the live database (claim_voice_job, channel_voice_config_problem) and adds
-- three. It rewrites no row of any table (the only rows it ever touches are queue rows of voice_clone_jobs, and only when a worker
-- calls claim_voice_job, or an operator calls voice_requeue_overdue, after the file is applied). It alters no table, trigger or policy,
-- grants nothing to anon or to authenticated that was not already granted, and does NOT grant request_voice_clone (that stays a
-- separate decision). Nothing in the application, a workflow or a service calls the new functions; tools/voice_worker.py --sweep is the
-- one caller and nothing starts it.
--
-- NUMBER. 0121: the highest on main is 0120 (0118 is unused, 0119 and 0120 are merged) and no open pull request adds a migration (checked
-- with gh api, 2026-10-24).
--
-- APPLY AS ONE TRANSACTION: the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1. The lock_timeout
-- below is `set local`, and a half-applied file (the oracle closed but the queue function not yet replaced, or the reverse) is not a
-- state anyone designed for. Every statement is create-or-replace, revoke, grant: a replay changes nothing.
--
-- WHAT IT DOES
--   G2. claim_voice_job (0117's body, character for character, plus ONE marked block) now ENDS a clone job whose profile is no longer
--       waiting for its verification (the owner deleted it, or it was rejected) and queues what that profile still needs. Before this, a
--       clone job that a worker had parked (the operator's or the provider's fault: the job is not answered, its 30-minute lease runs
--       out) and whose profile the owner then deleted went back to `queued` and stayed there for ever: claim_voice_job hands out a clone
--       only for a pending profile, delete_voice cancels only jobs that are queued at that moment, so nothing ever ended it. Its live
--       (profile, kind) row made purge_voice_records answer `job_outstanding`, which blocks the deletion of the user's account and of the
--       organization (voice_profiles.user_id / org_id are foreign keys), and the provider sweep that a finished clone would have queued
--       was never queued. The block ends such a job once (status `cancelled` if it was never claimed, `expired` if it was: a claimed
--       attempt may have created a voice whose answer was lost; error_code `profile_not_pending`), and queues
--         * purge_sample, which also sweeps a voice labelled for the profile out of the provider account when no voice id was recorded
--           (modules/voice_worker.py), when the job had been claimed or the sample is not yet purged; and
--         * delete_provider, when a provider voice id is recorded.
--       A running job whose lease has NOT run out is left to its worker (finish_voice_clone answers it, and queues the deletion itself for
--       a deleted profile). Only profiles that are `deleted` or `rejected` are touched: never a live voice or its kept sample.
--   G3. voice_requeue_overdue(p_older_than interval) and voice_overdue_report(), service role only.
--       * The re-queue puts a purge_sample or delete_provider job that FAILED for good back in the queue with its attempts reset. At most
--         20 jobs per call, oldest first; only jobs that failed more than p_older_than ago (1 hour to 30 days, default 3 hours); never a
--         clone job; one job per (profile, kind), and none where a live job of the same kind exists. A purge_sample only while the profile's
--         sample is `purge_pending` and the profile is not waiting for its verification; a delete_provider only for a profile that is
--         `deleted`, has a recorded voice id and has no succeeded deletion. So it can never resurrect work for a profile where that work must
--         not run, and never deletes a live voice.
--       * The report returns counts and ages in seconds, in closed fields, and no id, name or user of anyone.
--   ORACLE. channel_voice_config_problem(channel, org, old, new) was executable by every signed-in user and answers a key where the id is a
--       clone that cannot be used on that channel and NULL otherwise: a stranger could confirm that a 20-character id is somebody's clone.
--       0117's body is kept as channel_voice_config_problem_core (callable by nobody) and the function of the same name is now a wrapper
--       that gives the exact answer to the service role (and to a session with no API claims), and to the channels guard (a write the caller
--       is already making to a channel they can write), and to any other caller ONLY when the caller is a member of the channel's
--       organization AND the voice is the caller's own or was requested in that same organization. For every other caller an id they cannot
--       see answers NULL, exactly as an id that is no voice does; the lookups run either way, so the work done is the same.
--       The Run-now route (lib/server/run-voice.ts) calls it as the signed-in member and keeps working for the member's own and the
--       organization's voices; the Actions pre-flight (modules/voice_gate.py) calls it with the service key and is unchanged.
--       RESIDUAL (not closed here, by design): the entry guards of 0117 (a Studio tts job, a render job, a write of a channel's
--       agent_config) refuse a clone that the writer may not use, which is what makes them guards; anyone who can write to one of those
--       tables can therefore still test a KNOWN id by trying to use it. The ids are 62^20 values and are not listed anywhere; see
--       docs/CUSTOM_VOICE.md.
--
-- DRIFT GUARD. Both replaced functions are replaced on the bodies the REPO says are latest (0117's; no later migration redefines either).
-- If the live database holds another body (something applied by hand since: the 0064/0103 lesson), replacing it would silently undo that
-- change, so the file refuses. Compared as md5 of the body (prosrc) with every run of white space read as one space; the second hash of
-- each pair is this file's own body, which is what a replay sees. tests/test_voice_job_gates_migration.py recomputes all of them from the
-- migration files. The three new names are checked the same way: if one already exists it must be this file's.
--
-- Rollback: docs/sql/rollback_0121_voice_job_gates.sql (puts 0117's two bodies back byte for byte, drops the three functions; a queue row
-- this file's claim_voice_job already ended stays ended).
-- REQUIRES 0117 (the voice tables and functions), 0020 (credits_trusted_caller).

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.voice_profiles') is null or to_regclass('public.voice_clone_jobs') is null then
    raise exception '0121 needs 0117_voice_profiles.sql (the voice tables): apply it first';
  end if;
  if to_regprocedure('public.claim_voice_job(text)') is null
     or to_regprocedure('public.channel_voice_config_problem(text, uuid, jsonb, jsonb)') is null
     or to_regprocedure('public.voice_usable_by(uuid, text, uuid, text, text, text)') is null
     or to_regprocedure('public.voice_caller_member(uuid, text)') is null
     or to_regprocedure('public.voice_id_norm(jsonb)') is null then
    raise exception '0121 needs 0117_voice_profiles.sql (the voice functions): apply it first';
  end if;
  if to_regprocedure('public.credits_trusted_caller()') is null then
    raise exception '0121 needs 0020 (credits_trusted_caller): apply it first';
  end if;
end $$;

do $$
declare
  c text;
  p text;
  k text;
  r text;
  o text;
begin
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into c from pg_proc x where x.oid = 'public.claim_voice_job(text)'::regprocedure;
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into p
    from pg_proc x where x.oid = 'public.channel_voice_config_problem(text, uuid, jsonb, jsonb)'::regprocedure;
  if c is null or c <> all (array['67507f43dda86e10823aaca82f5892d9', '099164c525a8f561e84b0c2bc21c7b1e']) then
    raise exception '0121 found a claim_voice_job() that is neither 0117''s body nor 0121''s (md5 %): read the live body first', c;
  end if;
  if p is null or p <> all (array['70d9a82242920aa92d57faadde0f39c3', '09c300ba15b8ed7e339829f9d7be5d30']) then
    raise exception '0121 found a channel_voice_config_problem() that is neither 0117''s body nor 0121''s (md5 %): read the live body first', p;
  end if;
  -- The new names: absent, or already this file's own (a replay).
  if to_regprocedure('public.channel_voice_config_problem_core(text, uuid, jsonb, jsonb)') is not null then
    select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into k
      from pg_proc x where x.oid = 'public.channel_voice_config_problem_core(text, uuid, jsonb, jsonb)'::regprocedure;
    if k <> '70d9a82242920aa92d57faadde0f39c3' then
      raise exception '0121 found a channel_voice_config_problem_core() that is not 0121''s body (md5 %): read the live body first', k;
    end if;
  end if;
  if to_regprocedure('public.voice_requeue_overdue(interval)') is not null then
    select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into r from pg_proc x where x.oid = 'public.voice_requeue_overdue(interval)'::regprocedure;
    if r <> '2dcc9a7acd6266526b1bc800350c1fa2' then
      raise exception '0121 found a voice_requeue_overdue() that is not 0121''s body (md5 %): read the live body first', r;
    end if;
  end if;
  if to_regprocedure('public.voice_overdue_report()') is not null then
    select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into o from pg_proc x where x.oid = 'public.voice_overdue_report()'::regprocedure;
    if o <> '0524f35c86125a361085046105e11d6d' then
      raise exception '0121 found a voice_overdue_report() that is not 0121''s body (md5 %): read the live body first', o;
    end if;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. ORACLE: 0117's channel_voice_config_problem, body character for character, under a name nobody can call
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.channel_voice_config_problem_core(p_channel text, p_org uuid, p_old jsonb, p_new jsonb)
  returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  k text;
  v text;
  o jsonb := case when jsonb_typeof(p_old) = 'object' then p_old else '{}'::jsonb end;
  n jsonb := case when jsonb_typeof(p_new) = 'object' then p_new else '{}'::jsonb end;
begin
  foreach k in array array['elevenlabs_voice_id', 'elevenlabs_secondary_voice_id'] loop
    if (o -> k) is not distinct from (n -> k) or not n ? k or jsonb_typeof(n -> k) = 'null' then
      continue;
    end if;
    -- A voice id is a JSON string. The reader would still turn a number (12345678901234567890 is a possible id) or a list into text
    -- and use it, so any other type, SET by this write, is refused outright.
    if jsonb_typeof(n -> k) <> 'string' then
      return k;
    end if;
    v := public.voice_id_norm(n -> k);
    if v is null then
      continue;
    end if;
    if not public.voice_usable_by(null, v, p_org, p_channel, 'use',
         case k when 'elevenlabs_voice_id' then 'narrator' else 'secondary' end) then
      return k;
    end if;
  end loop;
  return null;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. ORACLE: the function the roles call, now a wrapper that decides who is told the truth
-- ───────────────────────────────────────────────────────────────────────────

-- Who is told what. The exact answer of the core (a key, or NULL) goes to:
--   * the service role and a session with no API claims at all (credits_trusted_caller(): the Actions pre-flight, the SQL editor);
--   * the channels guard, channels_config_guard(), which asks from inside its own trigger (pg_trigger_depth() > 0). That is a write to
--     the channels table by a caller who already passed the table's policy for that row, or a definer function (create_channel,
--     set_channel_dna, attach_voice_to_channel) that checked the caller itself. The guard must keep refusing a custom voice that is not
--     attached whoever writes, so this answer is never masked; nothing a caller sends through the API can raise the trigger depth.
-- Anybody else (a signed-in user calling it through the API) is told the truth only when they are a member of the channel's
-- organization, found from the channel row and never from the p_org they pass, AND the voice named is one they may know exists: their
-- own, or one requested in that same organization. Otherwise the answer is NULL, which is also what an id that is no voice gets.
-- The two lookups run whatever the core said, so a masked answer costs the same as an unmasked one. A value that is not a JSON string
-- is refused by the core whoever asks (it says nothing about anyone's voices), and so is here.
create or replace function public.channel_voice_config_problem(p_channel text, p_org uuid, p_old jsonb, p_new jsonb)
  returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  k       text;
  probe   text;
  v       text;
  pr      public.voice_profiles;
  is_one  boolean;
  ch_org  uuid;
  member  boolean;
  visible boolean;
begin
  k := public.channel_voice_config_problem_core(p_channel, p_org, p_old, p_new);
  if public.credits_trusted_caller() or pg_trigger_depth() > 0 then
    return k;
  end if;
  probe := coalesce(k, 'elevenlabs_voice_id');
  v := public.voice_id_norm(case when jsonb_typeof(p_new) = 'object' then p_new -> probe end);
  select * into pr from public.voice_profiles
   where lower(provider_voice_id) = v
   order by (status = 'deleted'), created_at
   limit 1;
  is_one := found;
  select c.org_id into ch_org from public.channels c where c.channel_id = p_channel;
  member := public.voice_caller_member(ch_org, 'viewer');
  visible := coalesce(is_one and member and (pr.user_id = auth.uid() or pr.org_id = ch_org), false);
  if k is not null and is_one and not visible then
    return null;
  end if;
  return k;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. G2: claim_voice_job, 0117's body character for character, plus ONE marked block
-- ───────────────────────────────────────────────────────────────────────────

-- Hand out the oldest job that can run. First: a clone request nobody uploaded a sample for within 2 hours lapses (the profile is
-- rejected); (0121) a clone job whose profile was deleted or rejected is ended and its cleanup queued; a running job whose lease is
-- older than 30 minutes goes back to the queue, or fails once its attempts are spent. A clone job is handed out only once its sample
-- object exists in the bucket. Returns NULL when there is nothing to do.
create or replace function public.claim_voice_job(p_worker text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  j      public.voice_clone_jobs;
  pr     public.voice_profiles;
  w      text := nullif(btrim(coalesce(p_worker, '')), '');
  path_  text;
begin
  if w is null or char_length(w) > 120 then
    raise exception 'a worker name is required' using errcode = '22023';
  end if;
  -- lapse
  update public.voice_profiles p set status = 'rejected', reject_reason = 'sample_timeout'
   where p.status = 'pending_verification'
     and exists (select 1 from public.voice_clone_jobs q
                  where q.profile_id = p.id and q.kind = 'clone' and q.status = 'queued'
                    and q.created_at < now() - interval '2 hours')
     and not exists (select 1 from storage.objects o where o.bucket_id = 'voice-samples'
                      and o.name like p.user_id::text || '/' || p.id::text || '/sample.%');
  update public.voice_clone_jobs q set status = 'expired', finished_at = now(), error_code = 'sample_timeout'
   where q.kind = 'clone' and q.status = 'queued' and q.created_at < now() - interval '2 hours'
     and exists (select 1 from public.voice_profiles p where p.id = q.profile_id and p.status = 'rejected');
  -- 0121 (G2): a clone job whose profile is deleted or rejected can never be handed out (a clone is claimed only for a pending
  -- profile), so it would stay queued, or go back to the queue when a parked attempt's lease runs out, for ever; its live (profile, kind)
  -- row blocks purge_voice_records (job_outstanding) and with it the deletion of the account and the organization. End it, once, and
  -- queue what the profile still needs: the sample purge (which sweeps a voice labelled for the profile out of the provider account when
  -- no id was recorded) when the job was ever claimed or the sample is not purged yet, and the provider deletion when an id is recorded.
  -- cancelled: it never ran; expired: a claimed attempt may have created a voice whose answer was lost. A running job whose lease has not
  -- run out is its worker's (finish_voice_clone answers it). Only deleted and rejected profiles: never a live voice or its kept sample.
  with ended as (
    update public.voice_clone_jobs q
       set status = case when q.attempts = 0 then 'cancelled' else 'expired' end,
           worker_id = null, finished_at = now(), error_code = 'profile_not_pending'
      from public.voice_profiles p
     where p.id = q.profile_id and q.kind = 'clone' and p.status in ('deleted', 'rejected')
       and (q.status = 'queued' or (q.status = 'running' and q.heartbeat_at < now() - interval '30 minutes'))
    returning q.profile_id, q.user_id, q.attempts
  ), gone as (
    select e.profile_id, e.user_id, e.attempts, p.provider_voice_id, p.sample_state
      from ended e join public.voice_profiles p on p.id = e.profile_id
  ), marked as (
    update public.voice_profiles p set sample_state = 'purge_pending'
      from gone g where p.id = g.profile_id and p.sample_state = 'stored'
    returning p.id
  ), provider as (
    insert into public.voice_clone_jobs (profile_id, user_id, kind)
    select g.profile_id, g.user_id, 'delete_provider' from gone g where g.provider_voice_id is not null
    on conflict (profile_id, kind) where status in ('queued', 'running') do nothing
    returning id
  )
  insert into public.voice_clone_jobs (profile_id, user_id, kind)
  select g.profile_id, g.user_id, 'purge_sample' from gone g
   where g.attempts > 0 or g.sample_state in ('stored', 'purge_pending')
  on conflict (profile_id, kind) where status in ('queued', 'running') do nothing;
  -- lost workers
  update public.voice_clone_jobs q
     set status = case when q.attempts < q.max_attempts then 'queued' else 'failed' end,
         worker_id = null,
         finished_at = case when q.attempts < q.max_attempts then null else now() end,
         error_code = case when q.attempts < q.max_attempts then q.error_code else 'worker_lost' end
   where q.status = 'running' and q.heartbeat_at < now() - interval '30 minutes';
  -- A clone lost three times is rejected and its recording (a biometric sample) is queued for removal, never left behind.
  with lost as (
    update public.voice_profiles p set status = 'rejected', reject_reason = 'worker_lost', sample_state = 'purge_pending'
     where p.status = 'pending_verification'
       and exists (select 1 from public.voice_clone_jobs q
                    where q.profile_id = p.id and q.kind = 'clone' and q.status = 'failed' and q.error_code = 'worker_lost')
    returning p.id, p.user_id
  )
  insert into public.voice_clone_jobs (profile_id, user_id, kind)
  select l.id, l.user_id, 'purge_sample' from lost l
  on conflict (profile_id, kind) where status in ('queued', 'running') do nothing;

  select q.* into j
    from public.voice_clone_jobs q
    join public.voice_profiles p on p.id = q.profile_id
   where q.status = 'queued'
     and (q.kind <> 'clone' or (p.status = 'pending_verification' and exists (
            select 1 from storage.objects o where o.bucket_id = 'voice-samples'
               and o.name like p.user_id::text || '/' || p.id::text || '/sample.%')))
   order by q.created_at
   limit 1
   for update of q skip locked;
  if not found then
    return null;
  end if;
  select * into pr from public.voice_profiles where id = j.profile_id;
  update public.voice_clone_jobs
     set status = 'running', attempts = attempts + 1, worker_id = w, heartbeat_at = now(),
         started_at = coalesce(started_at, now())
   where id = j.id
  returning * into j;
  if j.kind = 'clone' then
    select o.name into path_ from public.voice_profiles p2, storage.objects o
     where p2.id = pr.id and o.bucket_id = 'voice-samples'
       and o.name like p2.user_id::text || '/' || p2.id::text || '/sample.%'
     order by o.created_at limit 1;
    update public.voice_profiles set sample_state = 'stored' where id = pr.id and sample_state = 'awaiting';
  end if;
  return jsonb_build_object(
    'job_id', j.id, 'kind', j.kind, 'attempts', j.attempts, 'profile_id', pr.id, 'user_id', pr.user_id,
    'owner_ref', pr.owner_ref, 'status', pr.status, 'keep_sample', pr.keep_sample,
    'sample_path', path_, 'sample_prefix', pr.user_id::text || '/' || pr.id::text || '/',
    'phrase', j.phrase, 'provider', pr.provider, 'provider_voice_id', pr.provider_voice_id);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. G3: re-queue what failed for good, and report what is overdue (service role only)
-- ───────────────────────────────────────────────────────────────────────────

-- Put purge_sample / delete_provider jobs that FAILED for good back in the queue with their attempts reset, so the 90-minute horizon of
-- the worker's parking is not the last word. Bounded: at most 20 per call, oldest first, only those that failed more than p_older_than
-- ago (between 1 hour and 30 days). Never a clone job. Never where it must not run:
--   purge_sample   only while the profile's sample_state is purge_pending and the profile is not waiting for its verification;
--   delete_provider only for a profile that is deleted, has a recorded voice id, and has no succeeded deletion.
-- Of the failed jobs of one (profile, kind) only the newest is put back, and not when a live job of that kind exists (the unique index
-- on live jobs would otherwise refuse the whole call). The error word stays as the reason it failed until the next answer replaces it.
-- Returns counts only: {requeued, purge_sample, delete_provider}.
create or replace function public.voice_requeue_overdue(p_older_than interval default interval '3 hours') returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  cap     constant integer := 20;
  n_purge integer;
  n_prov  integer;
begin
  if p_older_than is null or p_older_than < interval '1 hour' or p_older_than > interval '30 days' then
    raise exception 'voice_requeue_overdue: the age must be between 1 hour and 30 days' using errcode = '22023';
  end if;
  with newest as (
    select distinct on (q.profile_id, q.kind) q.id, q.finished_at
      from public.voice_clone_jobs q
      join public.voice_profiles p on p.id = q.profile_id
     where q.status = 'failed' and q.kind in ('purge_sample', 'delete_provider')
       and q.finished_at < now() - p_older_than
       and (   (q.kind = 'purge_sample' and p.sample_state = 'purge_pending' and p.status <> 'pending_verification')
            or (q.kind = 'delete_provider' and p.status = 'deleted' and p.provider_voice_id is not null
                and not exists (select 1 from public.voice_clone_jobs d
                                 where d.profile_id = q.profile_id and d.kind = 'delete_provider' and d.status = 'succeeded')))
       and not exists (select 1 from public.voice_clone_jobs l
                        where l.profile_id = q.profile_id and l.kind = q.kind and l.status in ('queued', 'running'))
     order by q.profile_id, q.kind, q.finished_at desc, q.id
  ), picked as (
    select j.id
      from public.voice_clone_jobs j
      join newest n on n.id = j.id
     order by n.finished_at, j.id
     limit cap
       for update of j skip locked
  ), done as (
    update public.voice_clone_jobs j
       set status = 'queued', attempts = 0, worker_id = null, heartbeat_at = null, finished_at = null
     where j.id in (select id from picked) and j.status = 'failed'
    returning j.kind
  )
  select count(*) filter (where kind = 'purge_sample'), count(*) filter (where kind = 'delete_provider')
    into n_purge, n_prov from done;
  return jsonb_build_object('requeued', n_purge + n_prov, 'purge_sample', n_purge, 'delete_provider', n_prov);
end
$$;

-- What is overdue, as counts and ages in whole seconds (NULL when there is none: an age of 0 would read as "just now"). No id, name, user
-- or error text of anyone. A deleted or rejected profile whose cleanup is late shows in the lines below; once a worker runs and
-- voice_requeue_overdue() has been called, each line should read count 0.
--   failed_purge_sample      a sample purge that failed for good and whose sample is still waiting          (age: since it failed)
--   failed_delete_provider   a provider deletion that failed for good for a voice that is still there      (age: since it failed)
--   late_queued              a purge / deletion queued or running for more than 3 hours                    (age: since it was queued)
--   stranded_clone           a queued clone job of a deleted or rejected profile (claim_voice_job ends it) (age: since it was queued)
--   purge_without_job        a sample waiting to be purged with no purge job queued, running or failed     (age: since the voice was deleted
--                            or requested)
--   provider_without_job     a deleted voice with a recorded id and no deletion queued, running, failed    (age: since it was deleted)
--                            or done
-- A profile can still appear in more than one line (a late job of a profile whose other cleanup is missing); `total` is their sum.
create or replace function public.voice_overdue_report() returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  with
  fp as (
    select count(*) as n, floor(extract(epoch from now() - min(q.finished_at)))::bigint as s
      from public.voice_clone_jobs q join public.voice_profiles p on p.id = q.profile_id
     where q.kind = 'purge_sample' and q.status = 'failed' and p.sample_state = 'purge_pending'),
  fd as (
    select count(*) as n, floor(extract(epoch from now() - min(q.finished_at)))::bigint as s
      from public.voice_clone_jobs q join public.voice_profiles p on p.id = q.profile_id
     where q.kind = 'delete_provider' and q.status = 'failed' and p.status = 'deleted' and p.provider_voice_id is not null
       and not exists (select 1 from public.voice_clone_jobs d
                        where d.profile_id = q.profile_id and d.kind = 'delete_provider' and d.status = 'succeeded')),
  lq as (
    select count(*) as n, floor(extract(epoch from now() - min(q.created_at)))::bigint as s
      from public.voice_clone_jobs q
     where q.kind in ('purge_sample', 'delete_provider') and q.status in ('queued', 'running')
       and q.created_at < now() - interval '3 hours'),
  sc as (
    select count(*) as n, floor(extract(epoch from now() - min(q.created_at)))::bigint as s
      from public.voice_clone_jobs q join public.voice_profiles p on p.id = q.profile_id
     where q.kind = 'clone' and q.status = 'queued' and p.status in ('deleted', 'rejected')),
  pj as (
    select count(*) as n, floor(extract(epoch from now() - min(coalesce(p.deleted_at, p.created_at))))::bigint as s
      from public.voice_profiles p
     where p.sample_state = 'purge_pending'
       and not exists (select 1 from public.voice_clone_jobs q
                        where q.profile_id = p.id and q.kind = 'purge_sample' and q.status in ('queued', 'running', 'failed'))),
  dj as (
    select count(*) as n, floor(extract(epoch from now() - min(p.deleted_at)))::bigint as s
      from public.voice_profiles p
     where p.status = 'deleted' and p.provider_voice_id is not null
       and not exists (select 1 from public.voice_clone_jobs q
                        where q.profile_id = p.id and q.kind = 'delete_provider' and q.status in ('queued', 'running', 'failed', 'succeeded')))
  select jsonb_build_object(
    'failed_purge_sample',    jsonb_build_object('count', fp.n, 'oldest_seconds', fp.s),
    'failed_delete_provider', jsonb_build_object('count', fd.n, 'oldest_seconds', fd.s),
    'late_queued',            jsonb_build_object('count', lq.n, 'oldest_seconds', lq.s),
    'stranded_clone',         jsonb_build_object('count', sc.n, 'oldest_seconds', sc.s),
    'purge_without_job',      jsonb_build_object('count', pj.n, 'oldest_seconds', pj.s),
    'provider_without_job',   jsonb_build_object('count', dj.n, 'oldest_seconds', dj.s),
    'total',                  fp.n + fd.n + lq.n + sc.n + pj.n + dj.n)
    from fp, fd, lq, sc, pj, dj
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Grants: revoke from everyone, then grant narrowly (the same ones 0117 made for the two replaced functions)
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.channel_voice_config_problem_core(text, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.channel_voice_config_problem(text, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.claim_voice_job(text) from public, anon, authenticated, service_role;
revoke all on function public.voice_requeue_overdue(interval) from public, anon, authenticated, service_role;
revoke all on function public.voice_overdue_report() from public, anon, authenticated, service_role;

-- The channels guard runs as the caller (security invoker, as in 0086) and the Run-now route calls it as the signed-in member: both
-- still need EXECUTE; what the wrapper answers is decided inside it (above).
grant execute on function public.channel_voice_config_problem(text, uuid, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.claim_voice_job(text) to service_role;
grant execute on function public.voice_requeue_overdue(interval) to service_role;
grant execute on function public.voice_overdue_report() to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor on the live project after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     position('0121' in pg_get_functiondef('public.claim_voice_job(text)'::regprocedure)) > 0 as claim_has_g2_block,
--     position('channel_voice_config_problem_core' in pg_get_functiondef('public.channel_voice_config_problem(text,uuid,jsonb,jsonb)'::regprocedure)) > 0
--       as oracle_wrapper_in_place,
--     has_function_privilege('authenticated', 'public.channel_voice_config_problem(text,uuid,jsonb,jsonb)', 'EXECUTE')
--       and has_function_privilege('service_role', 'public.channel_voice_config_problem(text,uuid,jsonb,jsonb)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.channel_voice_config_problem(text,uuid,jsonb,jsonb)', 'EXECUTE') as oracle_grants,
--     not has_function_privilege('authenticated', 'public.channel_voice_config_problem_core(text,uuid,jsonb,jsonb)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.channel_voice_config_problem_core(text,uuid,jsonb,jsonb)', 'EXECUTE')
--       as core_is_closed,
--     has_function_privilege('service_role', 'public.voice_requeue_overdue(interval)', 'EXECUTE')
--       and has_function_privilege('service_role', 'public.voice_overdue_report()', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.voice_requeue_overdue(interval)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.voice_overdue_report()', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.voice_overdue_report()', 'EXECUTE') as g3_service_only,
--     not has_function_privilege('anon', 'public.request_voice_clone(text,jsonb,text,boolean,text,uuid)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.request_voice_clone(text,jsonb,text,boolean,text,uuid)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.request_voice_clone(text,jsonb,text,boolean,text,uuid)', 'EXECUTE')
--       as request_voice_clone_still_granted_to_nobody;
--
-- The report, as the service role would see it (a database owner session can call it too; expected: every count 0 once a worker runs):
--   select public.voice_overdue_report();
