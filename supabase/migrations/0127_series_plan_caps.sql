-- 0127_series_plan_caps.sql — Series Factory, finding F4: a per-USER and a PLATFORM-WIDE daily cap on series plans, inside the database function
-- that creates a plan request. docs/SERIES_FACTORY.md, "Hard conditions before request_series_plan may be granted" (F4).
--
-- *** LIVE ON APPLY. *** Merging this file applies it to the live database. It replaces ONE function that exists there (request_series_plan,
-- the eight-argument one of 0122), adds ONE table (series_plan_cap_settings, one row) and two internal trigger functions. It GRANTS NOTHING:
-- request_series_plan is executable by nobody before this file and by nobody after it (the file refuses to run if it finds it otherwise), so
-- no plan can be requested through an API role either way, and no existing row is read, written or rewritten. It calls no provider, moves no
-- credit and touches no queue worker, publishing or privacy rule. The caps only become reachable the day the owner grants the function, which is
-- a separate decision with the steps in docs/SERIES_FACTORY.md ("What the owner must do, in order").
--
-- WHY. Each plan costs ONE generate on the platform's shared model key plus up to CHRONOS_TOPIC_GATE_MODEL_CALLS niche questions, each up to
-- GEMINI_MAX_RETRIES HTTP attempts, and the customer is charged nothing. The only cap 0120 built is per ORGANIZATION (5 per 24 hours), and one
-- account can own ten organizations (create_organization), so one person could request 50 plans a day, and a handful of people could spend
-- the free quota of the shared key. Two more caps close that, counted in the database from the plan rows (never from anything the client sends):
--   series_user_cap     plans ONE PERSON (series_plans.requested_by, in any organization) has requested in the last 24 hours. Default 3.
--   series_global_cap   plans ALL organizations have requested in the last 24 hours, the operator's own included. Default 30.
-- Both count a failed or expired plan too (a model call was spent), exactly as the organization cap does, and both are checked AFTER the
-- idempotency replay, so a retry of a press that was accepted is answered with that plan and is never refused by a cap.
--
-- WHAT A REFUSAL IS. The function raises (NS429, the code 0120's rate_limited already uses) with a message that is one of two closed words,
-- series_user_cap or series_global_cap. The whole call rolls back: no plan row, no queue row, not even the expiry sweep that ran before the
-- check. The user's refusal carries `limit=3 per 24 hours` in its detail (their own number); the platform's carries NO detail, so a customer
-- never learns how large the platform's daily quota is. Neither carries any vendor text; the function never calls a vendor.
-- The order of the refusals: organization cap (rate_limited, 0120), then person (series_user_cap), then platform (series_global_cap).
--
-- CONCURRENCY. 0120 serialises the presses of one organization with a transaction-scoped advisory lock. That does not serialise one person's
-- presses in two organizations, nor two people, so this file adds ONE more lock, a platform-wide one, always taken after the organization's (so
-- two requests cannot wait on each other), and reads both counts only after it: concurrent requests cannot exceed a cap by racing. It is held for
-- the rest of the (short) request transaction; with a cap of tens a day that queue is never long. A lock per person would add nothing, because
-- every request already holds the platform lock from before the counts to the commit (the lab proves it with real threads).
--
-- THE OWNER'S NUMBERS (series_plan_cap_settings). One row: user_daily_cap (default 3) and global_daily_cap (default 30), each a whole number
-- 0..1000 / 0..10000; 0 refuses every request (a pause that needs no deploy). Changed in the SQL editor only, as 0124's
-- model_availability_settings is: RLS is on with NO policy and every privilege is revoked from public, anon, authenticated and service_role,
-- so no signed-in member and no key can read or write it; the row cannot be deleted or emptied (a trigger, for the table owner too); a change
-- of a number leaves a security_events row (kind series.plan.caps) and never fails the change it observes. A missing row (only a superuser can
-- remove it) reads as the defaults 3 and 30, never as "no cap". The seed insert is `on conflict do nothing`, so a replay never undoes what the
-- owner set. Change a number, e.g.:   update public.series_plan_cap_settings set user_daily_cap = 5, global_daily_cap = 50;
--
-- NUMBER. 0127: the highest on main is 0126 (the region edit run). 0123 is unused on main (owner model-API-keys migration reserved it) and
-- is not taken here, as the task that asked for this file named 0127. No open pull request adds a migration: checked with gh api against the
-- open pull requests and their files at push time (open: #624-#629, none touches supabase/; #623 merged without a migration). 0124, 0125 and 0126 replace no object this
-- file touches and this file replaces none of theirs, so they apply in any order relative to it (tests/security/test_sec_series_plan_caps.py
-- applies them in both orders and compares the end states).
--
-- APPLY AS ONE TRANSACTION: the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1. `set local lock_timeout`
-- and the drift guard assume it, and the last block of this file asserts the end state, so a half-applied file cannot be left behind.
--
-- WHAT IT REPLACES (its latest body, character for character, plus the lines marked `-- 0127`; nothing of 0122's text is changed or removed):
--   request_series_plan(text, text, integer, text, integer, text, text, text)   0122's body + two declarations, the platform lock,
--                                                                               the read of the settings and the two checks. Same signature,
--                                                                               so no old function is left behind and no new door is made.
-- WHAT IT ADDS: series_plan_cap_settings (table), series_plan_cap_settings_guard() and series_plan_cap_settings_trail() (trigger functions,
-- revoked from every API role).
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; run as the SQL editor on the live project). The hash is md5 of the function body with every run
-- of white space read as one space. The file checks it itself and raises on any other value, but read it first:
--     select 'request_series_plan' as fn, md5(regexp_replace(prosrc, '\s+', ' ', 'g')) as md5
--       from pg_proc where oid = 'public.request_series_plan(text, text, integer, text, integer, text, text, text)'::regprocedure;
--   expected BEFORE (0122 is applied, 0127 is not):   request_series_plan   e38342a6c8511d5eadb1f99ab38fb6aa
--   expected AFTER (the last block of this file asserts the same, inside the transaction):
--                                                     request_series_plan   1053b80a2f37ebe4fabf52f7fba270c6
--                                                     series_plan_cap_settings_guard   f5926f72cbc28d220d1d1ca69e68f824
--                                                     series_plan_cap_settings_trail   0a6f8889d38226086213cf4b6d9a33e0
--   and nobody may hold EXECUTE on it (expected: no row; a NULL proacl would mean "default privileges", and the default includes public):
--     select a.grantee::regrole from pg_proc p, aclexplode(p.proacl) a
--      where p.oid = 'public.request_series_plan(text, text, integer, text, integer, text, text, text)'::regprocedure
--        and (a.grantee = 0 or a.grantee in ('anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole));
--   and the two new names must not exist yet (expected: no row):
--     select to_regclass('public.series_plan_cap_settings');
--   If a live value is anything else, STOP: something was applied by hand after 0122, and replacing the body would silently undo it. If the
--   function IS executable by an API role, STOP as well: it was granted by hand, so replacing its body is a live change to a callable and a
--   decision for a person (this file refuses in both cases and changes nothing).
--
-- Additive and idempotent: create table if not exists, drop constraint then add, create or replace, drop trigger then create, seed `on conflict do
-- nothing`. A second run finds the 0127 body and changes nothing (the owner's numbers included). An applied migration is never edited.
-- Rollback: docs/sql/rollback_0127_series_plan_caps.sql (puts 0122's body back byte for byte, drops the table; run it BEFORE
-- docs/sql/rollback_0122_series_template_carrier.sql, which refuses a body that is not 0122's).
-- REQUIRES 0122 (the eight-argument request_series_plan), 0120 (series_plans.requested_by, created_at frozen by series_plans_terms_frozen) and
-- 0107 (security_event_log).

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.series_plans') is null then
    raise exception '0127 needs 0120_series_tables.sql (series_plans): apply it first';
  end if;
  if not exists (select 1 from pg_attribute where attrelid = 'public.series_plans'::regclass and attname = 'requested_by' and not attisdropped)
     or not exists (select 1 from pg_attribute where attrelid = 'public.series_plans'::regclass and attname = 'created_at' and not attisdropped) then
    raise exception '0127 needs series_plans.requested_by and created_at (0120): apply it first';
  end if;
  if to_regprocedure('public.request_series_plan(text, text, integer, text, integer, text, text, text)') is null then
    raise exception '0127 needs 0122_series_template_carrier.sql (the eight-argument request_series_plan): apply it first';
  end if;
  if to_regprocedure('public.security_event_log(text, text, text, jsonb)') is null then
    raise exception '0127 needs 0107_owner_safety.sql (security_event_log): apply it first';
  end if;
end $$;

-- The body this file replaces is replaced on what the REPO says is latest (0122's). If the live database holds another body (something applied
-- by hand after 0122: the 0064 / 0103 drift lesson), replacing it would silently undo that change, so the file refuses. The pair is (0122's
-- body, this file's own body, which is what a replay sees), compared as md5 of prosrc with every run of white space read as one space.
-- tests/test_series_plan_caps_migration.py recomputes both hashes from the migration files. The function must also be executable by nobody:
-- no public, no anon, authenticated or service_role, and an ACL that is not NULL (a grant made by hand makes this a live change to a callable).
-- The two new trigger functions, if they already exist (a replay), must be this file's.
do $$
declare
  r  text;
  gd text;
  tr text;
  fn oid := to_regprocedure('public.request_series_plan(text, text, integer, text, integer, text, text, text)');
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into r from pg_proc p where p.oid = fn;
  if r is null or r <> all (array['e38342a6c8511d5eadb1f99ab38fb6aa', '1053b80a2f37ebe4fabf52f7fba270c6']) then
    raise exception '0127 found a request_series_plan() that is neither 0122''s body nor 0127''s (md5 %): read the live body first', r;
  end if;
  if exists (select 1 from pg_proc p
              where p.oid = fn
                and (p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a
                                 where a.grantee = 0
                                    or a.grantee in (select o.oid from pg_roles o where o.rolname in ('anon', 'authenticated', 'service_role'))))) then
    raise exception '0127 found request_series_plan() executable by public or by an API role: it is meant to be granted to nobody, so replacing its body is a decision for a person';
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into gd from pg_proc p where p.oid = to_regprocedure('public.series_plan_cap_settings_guard()');
  if gd is not null and gd <> 'f5926f72cbc28d220d1d1ca69e68f824' then
    raise exception '0127 found a series_plan_cap_settings_guard() that is not 0127''s body (md5 %): read the live body first', gd;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into tr from pg_proc p where p.oid = to_regprocedure('public.series_plan_cap_settings_trail()');
  if tr is not null and tr <> '0a6f8889d38226086213cf4b6d9a33e0' then
    raise exception '0127 found a series_plan_cap_settings_trail() that is not 0127''s body (md5 %): read the live body first', tr;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The owner's numbers: one row, no API role has any privilege on it
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.series_plan_cap_settings (
  id               boolean primary key default true,
  user_daily_cap   integer not null default 3,
  global_daily_cap integer not null default 30,
  updated_at       timestamptz not null default now()
);

alter table public.series_plan_cap_settings drop constraint if exists series_plan_cap_settings_one_row;
alter table public.series_plan_cap_settings add constraint series_plan_cap_settings_one_row check (id);
alter table public.series_plan_cap_settings drop constraint if exists series_plan_cap_settings_numbers;
alter table public.series_plan_cap_settings add constraint series_plan_cap_settings_numbers
  check (user_daily_cap between 0 and 1000 and global_daily_cap between 0 and 10000);

comment on table public.series_plan_cap_settings is
  'One row (migration 0127): the most series plans one person (user_daily_cap, default 3) and all organizations together (global_daily_cap, default 30) may request in a rolling 24 hours. 0 refuses every request. Read only by request_series_plan; changed in the SQL editor only, and a trigger leaves a mark in security_events.';

insert into public.series_plan_cap_settings (id) values (true) on conflict (id) do nothing;

alter table public.series_plan_cap_settings enable row level security;
revoke all on public.series_plan_cap_settings from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Triggers: the row cannot be deleted or emptied; a change to it leaves a mark
-- ───────────────────────────────────────────────────────────────────────────

-- The row is edited (SQL editor), never deleted or emptied. A missing row would read as the defaults, which is the safe direction, but the
-- owner would not see why their numbers stopped applying.
create or replace function public.series_plan_cap_settings_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'series_plan_cap_settings keeps its one row' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end
$$;

revoke all on function public.series_plan_cap_settings_guard() from public, anon, authenticated, service_role;

drop trigger if exists series_plan_cap_settings_guard on public.series_plan_cap_settings;
create trigger series_plan_cap_settings_guard
  before update or delete on public.series_plan_cap_settings
  for each row execute function public.series_plan_cap_settings_guard();
drop trigger if exists series_plan_cap_settings_no_truncate on public.series_plan_cap_settings;
create trigger series_plan_cap_settings_no_truncate
  before truncate on public.series_plan_cap_settings
  for each statement execute function public.series_plan_cap_settings_guard();

-- A change of a number (the SQL editor is the only way to make one) leaves a security_events row. It can never fail the write it observes: in an
-- emergency the owner must be able to lower a cap.
create or replace function public.series_plan_cap_settings_trail() returns trigger
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  begin
    if new.user_daily_cap is distinct from old.user_daily_cap or new.global_daily_cap is distinct from old.global_daily_cap then
      perform public.security_event_log('series.plan.caps', 'warning', 'series_plan_cap_settings',
        jsonb_build_object('user_daily_cap', jsonb_build_array(old.user_daily_cap, new.user_daily_cap),
                           'global_daily_cap', jsonb_build_array(old.global_daily_cap, new.global_daily_cap)));
    end if;
  exception when others then
    raise warning 'series plan caps trail failed: %', sqlerrm;
  end;
  return null;
end
$$;

revoke all on function public.series_plan_cap_settings_trail() from public, anon, authenticated, service_role;

drop trigger if exists series_plan_cap_settings_trail on public.series_plan_cap_settings;
create trigger series_plan_cap_settings_trail
  after update on public.series_plan_cap_settings
  for each row execute function public.series_plan_cap_settings_trail();

-- ───────────────────────────────────────────────────────────────────────────
-- 3. request_series_plan: 0122's body + the two caps
-- ───────────────────────────────────────────────────────────────────────────

-- Same signature as 0122's, so create or replace keeps the function's privileges (granted to nobody) and leaves no second function behind. The
-- revoke after it is a no-op that states the intent; the guard above and the end state below are what refuse anything else.

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
  -- 0127: the person's and the platform's daily caps (series_plan_cap_settings), read below under their locks
  v_ucap   integer;
  v_gcap   integer;
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

  -- 0127 (finding F4): the organization cap above does not stop one account that owns many organizations, nor a handful of accounts, from
  -- spending the shared model key. Two more caps, counted here from the plan rows and never from the client: the plans ONE PERSON has requested
  -- in 24 hours (in any organization) and the plans ALL organizations have. A failed or expired plan counts too (a model call was spent), and
  -- both come after the idempotency replay above, so a retry of an accepted press is never refused by a cap. The organization lock does not
  -- serialise a person's presses in two organizations, nor two people, so the caps take ONE more lock, a platform-wide one, after the
  -- organization's (always in that order, so two requests cannot wait on each other), and read both counts under it: concurrent requests cannot
  -- both pass either cap. (A lock per person would add nothing: every request holds the platform lock from before the counts to the commit.)
  -- A refusal raises, so the whole request rolls back (no plan, no queue row) and its message is a closed word. The platform's carries no
  -- number: a customer is not told how large the daily quota is. A missing settings row reads as the defaults, not as "no cap".
  perform pg_advisory_xact_lock(hashtextextended('series_plan_global', 0));
  select s.user_daily_cap, s.global_daily_cap into v_ucap, v_gcap from public.series_plan_cap_settings s;
  v_ucap := coalesce(v_ucap, 3);
  v_gcap := coalesce(v_gcap, 30);
  if (select count(*) from public.series_plans
       where requested_by = uid and created_at > now() - interval '24 hours') >= v_ucap then
    raise exception 'series_user_cap' using errcode = 'NS429', detail = format('limit=%s per 24 hours', v_ucap);
  end if;
  if (select count(*) from public.series_plans
       where created_at > now() - interval '24 hours') >= v_gcap then
    raise exception 'series_global_cap' using errcode = 'NS429';
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

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
-- If any of this is false the whole file rolls back (apply as one transaction). It restates the pins above: the function holds this file's body
-- and is executable by nobody, the table has its one row with the check, no API role has any privilege on it, row level security is on, and
-- the two triggers are bound.
do $$
declare
  fn oid := to_regprocedure('public.request_series_plan(text, text, integer, text, integer, text, text, text)');
  role_name text;
  priv text;
begin
  if fn is null then
    raise exception '0127 end state: the eight-argument request_series_plan() does not exist';
  end if;
  if to_regprocedure('public.request_series_plan(text, text, integer, text, integer, text, text)') is not null then
    raise exception '0127 end state: a seven-argument request_series_plan() exists';
  end if;
  if exists (select 1 from pg_proc p
              where p.oid = fn
                and (p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a
                                 where a.grantee = 0
                                    or a.grantee in (select o.oid from pg_roles o where o.rolname in ('anon', 'authenticated', 'service_role'))))) then
    raise exception '0127 end state: request_series_plan() is executable by public or an API role, and it must be granted to nobody';
  end if;
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = fn) <> '1053b80a2f37ebe4fabf52f7fba270c6'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.series_plan_cap_settings_guard()'::regprocedure) <> 'f5926f72cbc28d220d1d1ca69e68f824'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.series_plan_cap_settings_trail()'::regprocedure) <> '0a6f8889d38226086213cf4b6d9a33e0' then
    raise exception '0127 end state: a function does not hold this file''s body';
  end if;
  if (select count(*) from public.series_plan_cap_settings) <> 1 then
    raise exception '0127 end state: series_plan_cap_settings does not hold exactly one row';
  end if;
  if not exists (select 1 from pg_class where oid = 'public.series_plan_cap_settings'::regclass and relrowsecurity) then
    raise exception '0127 end state: series_plan_cap_settings has no row level security';
  end if;
  if exists (select 1 from pg_policy where polrelid = 'public.series_plan_cap_settings'::regclass) then
    raise exception '0127 end state: series_plan_cap_settings has a policy, and it must have none';
  end if;
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    foreach priv in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
      if has_table_privilege(role_name, 'public.series_plan_cap_settings', priv) then
        raise exception '0127 end state: % holds % on series_plan_cap_settings', role_name, priv;
      end if;
    end loop;
  end loop;
  if (select count(*) from pg_constraint where conrelid = 'public.series_plan_cap_settings'::regclass
        and conname in ('series_plan_cap_settings_one_row', 'series_plan_cap_settings_numbers') and convalidated) <> 2 then
    raise exception '0127 end state: the checks of series_plan_cap_settings are missing or not validated';
  end if;
  if (select count(*) from pg_trigger where tgrelid = 'public.series_plan_cap_settings'::regclass and not tgisinternal
        and tgname in ('series_plan_cap_settings_guard', 'series_plan_cap_settings_no_truncate', 'series_plan_cap_settings_trail')) <> 3 then
    raise exception '0127 end state: a trigger of series_plan_cap_settings is missing';
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
--     position('series_global_cap' in pg_get_functiondef('public.request_series_plan(text,text,integer,text,integer,text,text,text)'::regprocedure)) > 0
--       and position('series_user_cap' in pg_get_functiondef('public.request_series_plan(text,text,integer,text,integer,text,text,text)'::regprocedure)) > 0
--       as caps_in_the_function,
--     (select user_daily_cap = 3 and global_daily_cap = 30 from public.series_plan_cap_settings) as default_numbers_if_untouched,
--     not has_table_privilege('authenticated', 'public.series_plan_cap_settings', 'SELECT')
--       and not has_table_privilege('anon', 'public.series_plan_cap_settings', 'SELECT')
--       and not has_table_privilege('service_role', 'public.series_plan_cap_settings', 'SELECT') as settings_closed_to_api_roles;
--
-- How many plans the last 24 hours hold, per person and in all (what the caps count; expected: none while the function is granted to nobody):
--   select requested_by, count(*) from public.series_plans where created_at > now() - interval '24 hours' group by 1 order by 2 desc;
