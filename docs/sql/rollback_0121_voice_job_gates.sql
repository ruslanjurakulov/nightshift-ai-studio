-- rollback_0121_voice_job_gates.sql — takes migration 0121 out again. OWNER-APPLY: paste into the Supabase SQL editor.
-- Nothing in the app runs it.
--
-- WHEN YOU NEED IT. If the oracle restriction refuses an answer the Run-now route must get, or claim_voice_job misbehaves.
-- READ THIS FIRST: after it, (1) any signed-in user can again ask channel_voice_config_problem about any channel and any 20-character id and
-- learn whether the id is somebody's clone (the oracle the migration closed), (2) a clone job whose profile was deleted while a worker had
-- parked it is no longer ended by claim_voice_job, so it can stay queued and block purge_voice_records, and (3) voice_requeue_overdue() and
-- voice_overdue_report() are gone, so `tools/voice_worker.py --sweep` reports that they are not available (revert it too, or do not run it).
--
-- WHAT IT DOES, in one transaction:
--   1. Refuses to run if claim_voice_job() or channel_voice_config_problem() is neither 0121's body nor 0117's (something redefined either
--      since: running this would silently undo that change). Compared as md5 of the body with every run of white space read as one space.
--   2. Puts channel_voice_config_problem() back to 0117's body, byte for byte, and claim_voice_job() back to 0117's body, byte for byte,
--      with their grants (authenticated + service_role, and service_role only).
--   3. Drops channel_voice_config_problem_core(), voice_requeue_overdue(interval) and voice_overdue_report().
-- It rewrites no row. A queue row that claim_voice_job already ended (status cancelled / expired, error profile_not_pending) stays ended, and a
-- purge or deletion job it queued stays queued.
--
-- tests/security/test_sec_voice_job_gates.py applies this file to the lab database and re-applies 0121.

begin;
set local lock_timeout = '5s';

do $$
declare
  c text;
  p text;
begin
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into c from pg_proc x where x.oid = 'public.claim_voice_job(text)'::regprocedure;
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into p
    from pg_proc x where x.oid = 'public.channel_voice_config_problem(text, uuid, jsonb, jsonb)'::regprocedure;
  if c is null or c <> all (array['67507f43dda86e10823aaca82f5892d9', '099164c525a8f561e84b0c2bc21c7b1e']) then
    raise exception 'rollback 0121 found a claim_voice_job() that is neither 0121''s body nor 0117''s (md5 %): read the live body first', c;
  end if;
  if p is null or p <> all (array['70d9a82242920aa92d57faadde0f39c3', '09c300ba15b8ed7e339829f9d7be5d30']) then
    raise exception 'rollback 0121 found a channel_voice_config_problem() that is neither 0121''s body nor 0117''s (md5 %): read the live body first', p;
  end if;
end $$;

-- 0117's body.
create or replace function public.channel_voice_config_problem(p_channel text, p_org uuid, p_old jsonb, p_new jsonb)
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

-- 0117's body.
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

revoke all on function public.channel_voice_config_problem(text, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.claim_voice_job(text) from public, anon, authenticated, service_role;
grant execute on function public.channel_voice_config_problem(text, uuid, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.claim_voice_job(text) to service_role;

drop function if exists public.channel_voice_config_problem_core(text, uuid, jsonb, jsonb);
drop function if exists public.voice_requeue_overdue(interval);
drop function if exists public.voice_overdue_report();

commit;
