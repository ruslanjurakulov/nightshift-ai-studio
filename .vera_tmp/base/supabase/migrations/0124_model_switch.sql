-- 0124_model_switch.sql — the owner's per-model and per-provider ON/OFF switch (docs/MODEL_SWITCH.md).
--
-- *** LIVE ON APPLY. *** Merging this file applies it to the live database. It replaces FIVE functions that exist there
-- (sellable_models, creative_price, advance_creative_job, api_creative_model_ok, api_creative_refusal) and one RLS policy
-- (model_registry_select). DARK: every line it adds to them asks model_is_available(), which answers TRUE for every model
-- until model_availability_settings.enforced is set to true, by hand, in the SQL editor. Until then the replaced functions
-- return exactly what they returned before, to the byte, and no switch can be recorded. It rewrites no row of any existing table.
--
-- NUMBER. 0124: the highest on main is 0122 (the Series Factory template carrier, merged as #610); 0123 belongs to the owner model-API-keys
-- migration (branch claude/owner-model-api-keys, not merged when this was written), so 0124 cannot collide with it (checked with gh api
-- against all 613 remote branches and the open pull requests, 2026-10-25). 0113 and 0118 are unused on main already, so a gap is normal
-- here (tests/security/sec_db.py: "numbers need not be contiguous"). If 0123 merges after this file, the order does not matter: the two
-- touch no common object.
--
-- APPLY AS ONE TRANSACTION: the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1. The lock_timeout
-- below is `set local`; a half-applied file (the policy changed but the function it calls not yet created, or the reverse) is not a state
-- anyone designed for. Every statement is create-if-not-exists, create-or-replace, drop-then-create, revoke or grant: a replay changes
-- nothing (the seed row is `on conflict do nothing`, so it never undoes what the owner set).
--
-- WHAT IT IS FOR
--   All API keys are connected, but the vendor balance of one provider ran out. The owner turns that provider (or one model) OFF in the
--   Command Center; users stop being offered it and stop being able to start it, nothing is charged or held for it, and nothing is
--   quietly replaced by another model. Later the owner turns it ON again. This is a TEMPORARY, OPERATIONAL pause. It is not the sale
--   lifecycle of 0035 (model_registry.availability: hidden/beta/ga/disabled, which needs a real probe to come back): that column is not
--   touched, and a model switched back ON is exactly as sellable as it was before.
--
-- WHAT IT ADDS
--   model_availability_settings  one row. enforced (default FALSE: the dark switch), auto_suggest (default FALSE: the optional alert) and
--                                its two numbers. No API role has any privilege on it. Changed in the SQL editor only; every change
--                                writes a row to model_availability_log (a trigger), the actor being empty there.
--   model_availability           the switches: (scope 'model'|'provider', target, enabled, reason, note, who, when). NO ROW = ENABLED.
--                                A row with enabled = false hides; a row with enabled = true records the last turn-on. Nobody writes it
--                                but owner_set_model_switch(). No API role has any privilege on it.
--                                reason is a closed list (out_of_funds, vendor_outage, terms_review, other) and is required for OFF.
--   model_availability_log       append-only (a trigger refuses update, delete and truncate, for the table owner too): every change,
--                                who, when, why, the state before, the jobs it stopped.
--   model_availability_alerts    the optional auto-suggestion (see 5 below). A row only says "this provider may be out of funds".
--
-- THE EFFECTIVE RULE (model_is_available)
--   enforced = false            every model is available (today's behaviour, unchanged).
--   enforced = true             a model is NOT available when its own row says enabled = false, or its provider's row does.
--                               A model row with enabled = true does NOT override a provider that is OFF: the model row can only turn
--                               one model off, which is the whole point of having it under a provider that is on.
--   Nothing else decides it. A model that is not in the registry is "available" here (the registry checks, not this).
--
-- WHO MAY DO WHAT
--   owner_model_switches, owner_model_switch_preview, owner_set_model_switch, owner_model_alert_dismiss
--                                signed-in PLATFORM OWNER only (platform_role() = 'owner'; an admin who is not the owner is refused).
--                                The writers go through owner_guard() first: platform admin, the second-factor test of 0107 and a
--                                rate limit; and write the change, model_availability_log and security_events in ONE transaction,
--                                so an audit that cannot be written stops the change.
--   model_is_available(text)     authenticated, service_role. The RLS policy below needs it executable by the reader. It answers a
--                                boolean and names no reason. To a caller who is neither a platform admin nor the platform's own
--                                (credits_trusted_caller) a model that is not on sale and proven, or not in the registry, always
--                                answers TRUE: a customer cannot use it to learn that a hidden model exists.
--   models_switched_off()        authenticated, service_role. The ids only: no reason, no note, no who. A user is told "temporarily
--                                unavailable", never "out of funds" (the vendor account's state is the platform's, BR-L-021).
--   model_switch_state()         service_role only (the queue worker's pre-spend gate, modules/model_switch.py).
--   every other new function     nobody (called by the definer functions above).
--   anon                         nothing at all.
--   A refused call. owner_guard() (0107) runs first and takes one slot of the CALLER'S OWN rate limit (60 calls in 10 minutes for these
--   writers) before the owner test: a platform admin who is not the owner is refused with 'owner_required' and has used one slot of
--   that limit; the refusal writes no switch, no log row and no security event. A caller who is not a platform admin is refused before
--   anything is counted.
--   The audit log is append-only against DML only: the triggers refuse update, delete and truncate for every role including the table
--   owner, but a superuser can still drop or alter the table or disable the triggers (the SQL editor is the owner's own door, as for
--   every table of this schema). Row-level protection, not a tamper-proof ledger.
--
-- WHAT IS ENFORCED, AND WHERE (server side; the Command Center only draws it)
--   1. sellable_models()                    omits a switched-off model: every picker that reads it (Models page, Studio parameters,
--                                           captions, AI tools, API/MCP) loses it at once.
--   2. model_registry_select (RLS policy)   a customer's direct read of the registry (the Studio's model list) loses it; a platform
--                                           admin still sees every row (the Command Center subtracts models_switched_off()).
--   3. creative_price()                     refuses 'model_temporarily_off' (NS400) BEFORE anything is priced. Every quote and every
--                                           start goes through it: quote_creative_job, create_creative_job (exact and routed),
--                                           quote_creative_route / route_model (a switched-off model is no candidate), the workflow
--                                           quotes and steps, the API (api_creative_quote / api_creative_create) and MCP, and the
--                                           failover (reroute_creative_job). Nothing is held and nothing is charged for a refusal.
--   4. api_creative_model_ok() / api_creative_refusal()
--                                           the API names the refusal honestly ('model_temporarily_off', HTTP 503, nothing held)
--                                           instead of "not available through the API".
--   5. advance_creative_job('submitting')   the LAST gate before the vendor is called: a job that was created before the switch and
--                                           has not been sent is ended here, hold released.
--   6. owner_set_model_switch(OFF)          stops, in the same transaction, the jobs that have not been sent, in BATCHES of at most 200
--                                           per call (below).
--   Outside this file: modules/model_switch.py + tools/queue_worker.py stop a channel-pipeline run (daily/repair/series episode,
--   scene regeneration) BEFORE the worker spends, when the PROVIDER it would use is switched off. That gate is provider-level, video and
--   image providers only, off by default (NIGHTSHIFT_MODEL_SWITCH), fails open when the state is unreadable, and does NOT cover:
--   ElevenLabs (text to speech, sound effects, captions), AssemblyAI, Runway, Luma, xAI, stock footage, GitHub Actions runs of main.py,
--   or a model-level switch. docs/MODEL_SWITCH.md lists them.
--
-- THE IN-FLIGHT RULE (exact; tests/security/test_sec_model_switch.py pins every line)
--   A creative job is SENT once submit_started_at or provider_task_id is set (the first is written before the vendor call, the
--   second after it). SENT jobs are never touched by a switch: they run to the end, are charged on success and released on failure,
--   exactly as before. A job NOT SENT (status queued or running, no submit_started_at, no provider_task_id) when its model is
--   switched OFF is STOPPED: status 'failed', error_code 'model_temporarily_off', charged 0, its hold released in the same
--   transaction (creative_end_locked), a job event logged, the user notified like any failed job (with the credits returned).
--   Never re-routed to another model, never re-queued, never resumed on switch-on: the person starts it again.
--   A job whose submit started a moment before the switch committed is SENT and continues.
--   Workflow runs: each step is an ordinary job; a stopped step fails that step and the run, as any failed job does (0083 makes
--   only NS429/NS402 wait). Steps already charged stay charged for the output they made.
--   BATCHES. One call of owner_set_model_switch(OFF) stops at most 200 unsent jobs (an API call has an 8 s statement_timeout). The switch
--   row is written whole on the first call, so the model is hidden and refused at once whatever remains; the answer says
--   {jobs_stopped, remaining, complete} and the Command Center calls the same OFF again until remaining is 0 (or a call stops none,
--   which means workers hold the rest). A job the sweep has not reached cannot be sent: advance_creative_job refuses it at the last
--   gate. So the sweep is tidiness (credits returned at once), never the protection.
--   RATE CEILING, honestly. Every call goes through owner_guard() -> take_web_rate('owner:model_switch', 60, 600): a fixed 10-minute window
--   of 60 calls for this owner, shared by every owner_set_model_switch call. So one window can stop at most 60 x 200 = 12,000 jobs, not
--   more; a longer queue is finished by the last gate, or by calling again once the window rolls. A sweep may use up to all 60 slots, and
--   then ANOTHER switch change in the same window is answered 'rate_limited' for up to 10 minutes. Each batch call is an unconditional
--   OFF, plain and complete: if the owner presses ON from a second tab while a sweep is running, the next batch call turns it OFF again.
--   Each call writes one model_availability_log row and one security_events row, so a long sweep is many rows (that is the audit).
--
-- 5. THE OPTIONAL ALERT (model_availability_settings.auto_suggest, default FALSE; follow-up decision, see docs/MODEL_SWITCH.md)
--   When on, an AFTER trigger on creative_jobs counts jobs that failed with the typed code 'quota' (the capability layer's word for a
--   spent vendor balance or quota; 'auth' is a bad key and needs the opposite remedy, so it is NOT counted) on one provider inside
--   suggest_window_minutes. At suggest_threshold it records ONE open alert per provider. It NEVER hides anything and never changes
--   a switch; it only appears in the owner's Models section. The trigger cannot fail or slow the job's own write (it is inert when
--   the switch is off, wrapped in an exception block, and fires only on a failure with code 'quota').
--
-- DRIFT GUARD. The five replaced functions are replaced on the bodies the REPO says are latest (sellable_models and creative_price
-- 0100's, advance_creative_job 0036's, api_creative_model_ok 0062's, api_creative_refusal 0075's; no later migration redefines
-- them). If the live database holds another body (something applied by hand since: the 0064/0103 lesson), replacing it would silently
-- undo that change, so the file refuses. Compared as md5 of the body (prosrc) with every run of white space read as one space; the
-- second hash of each pair is this file's own body, which is what a replay sees. The policy is checked by what it says. The new names
-- are checked the same way: if one already exists it must be this file's. tests/test_model_switch_migration.py recomputes every hash
-- from the migration files.
--
-- Rollback: docs/sql/rollback_0124_model_switch.sql (puts the five bodies and the policy back byte for byte, drops everything new).
-- REQUIRES 0035 (registry), 0036 (creative jobs), 0075 (routing), 0100 (latest bodies), 0107 (owner_guard, owner_err,
-- security_event_log), 0043 (platform_role, my_confirmed_email), 0020 (credits_trusted_caller, credit_account_lock).

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.model_registry') is null or to_regclass('public.creative_jobs') is null then
    raise exception '0124 needs 0035_model_registry.sql and 0036_creative_jobs.sql: apply them first';
  end if;
  if to_regprocedure('public.creative_end_locked(uuid, text, text, text)') is null
     or to_regprocedure('public.credit_account_lock(uuid)') is null
     or to_regprocedure('public.credits_trusted_caller()') is null then
    raise exception '0124 needs 0036 / 0020 (creative_end_locked, credit_account_lock, credits_trusted_caller): apply them first';
  end if;
  if to_regprocedure('public.owner_guard(text, integer)') is null
     or to_regprocedure('public.owner_err(text, text, jsonb)') is null
     or to_regprocedure('public.security_event_log(text, text, text, jsonb)') is null then
    raise exception '0124 needs 0107_owner_safety.sql (owner_guard, owner_err, security_event_log): apply it first';
  end if;
  if to_regprocedure('public.platform_role()') is null or to_regprocedure('public.my_confirmed_email()') is null
     or to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0124 needs 0018 / 0043 (platform_role, my_confirmed_email, is_platform_admin): apply them first';
  end if;
  -- The five bodies this file replaces are the ones 0100 / 0036 / 0062 / 0075 left; anything older is refused below by its hash, but
  -- a database that never had them has nothing to replace.
  if to_regprocedure('public.sellable_models(text, text)') is null
     or to_regprocedure('public.creative_price(uuid, text, text, jsonb)') is null
     or to_regprocedure('public.advance_creative_job(uuid, text, text, text, jsonb)') is null
     or to_regprocedure('public.api_creative_model_ok(text, text)') is null
     or to_regprocedure('public.api_creative_refusal(text, text, text)') is null then
    raise exception '0124 needs 0036, 0062, 0075 and 0100 (the functions it replaces): apply them first';
  end if;
end $$;

do $$
declare
  s text;
  c text;
  a text;
  m text;
  r text;
  q text;
  wc_null boolean;
  cmd "char";
  perm boolean;
  roles_ok boolean;
begin
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into s from pg_proc x where x.oid = 'public.sellable_models(text, text)'::regprocedure;
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into c from pg_proc x where x.oid = 'public.creative_price(uuid, text, text, jsonb)'::regprocedure;
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into a from pg_proc x where x.oid = 'public.advance_creative_job(uuid, text, text, text, jsonb)'::regprocedure;
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into m from pg_proc x where x.oid = 'public.api_creative_model_ok(text, text)'::regprocedure;
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into r from pg_proc x where x.oid = 'public.api_creative_refusal(text, text, text)'::regprocedure;
  if s is null or s <> all (array['b201b1f412aa3143f75dac75bdaefd4f', '70f1639c6ce5cbf175b2673d8d543d44']) then
    raise exception '0124 found a sellable_models() that is neither 0100''s body nor 0124''s (md5 %): read the live body first', s;
  end if;
  if c is null or c <> all (array['eadab9d3784815c44becebcc6d1f7ec9', 'dc2bdbd68e43c4b85d9dbfd6b5ee83ee']) then
    raise exception '0124 found a creative_price() that is neither 0100''s body nor 0124''s (md5 %): read the live body first', c;
  end if;
  if a is null or a <> all (array['37eb30fb8923c65d97ed386b1ce1b642', '758e3dc731acf7bc6af319d45198873a']) then
    raise exception '0124 found an advance_creative_job() that is neither 0036''s body nor 0124''s (md5 %): read the live body first', a;
  end if;
  if m is null or m <> all (array['53d674624d8ce35d7bed3d005880de7f', '80ab200d384f44306987c88629f103af']) then
    raise exception '0124 found an api_creative_model_ok() that is neither 0062''s body nor 0124''s (md5 %): read the live body first', m;
  end if;
  if r is null or r <> all (array['16f5c0c0427953bdb2ca574708014cd6', '2253296a9c1ac2e5de3c25a2a726398e']) then
    raise exception '0124 found an api_creative_refusal() that is neither 0075''s body nor 0124''s (md5 %): read the live body first', r;
  end if;

  -- The policy 0035 made, as it reads (or this file's own, on a replay). A policy that says anything else was changed by hand. Compared
  -- as the whole deparsed expression, white space, the ::text casts and the schema name dropped (so a Postgres version that prints them
  -- differently does not matter), against the two texts it may have: 0035's and 0124's. The with-check is empty for both, the command is
  -- select, the policy is permissive, and it applies to exactly the role authenticated (not anon, not public, not one more role).
  select regexp_replace(pg_get_expr(p.polqual, p.polrelid), '\s+|::text|public\.', '', 'gi'), p.polwithcheck is null, p.polcmd, p.polpermissive,
         p.polroles = array[(select r.oid from pg_roles r where r.rolname = 'authenticated')]::oid[]
    into q, wc_null, cmd, perm, roles_ok
    from pg_policy p where p.polrelid = 'public.model_registry'::regclass and p.polname = 'model_registry_select';
  if q is null
     or q <> all (array['(is_platform_admin()OR((availability=ANY(ARRAY[''beta'',''ga'']))AND(verified_atISNOTNULL)))', '(is_platform_admin()OR((availability=ANY(ARRAY[''beta'',''ga'']))AND(verified_atISNOTNULL)ANDmodel_is_available(id)))'])
     or not wc_null or cmd <> 'r' or not perm or not coalesce(roles_ok, false) then
    raise exception '0124 found a model_registry_select policy that is not 0035''s (or 0124''s): read the live policy first';
  end if;
end $$;

-- Every new name is absent, or already this file's own (a replay).
do $$
declare
  want constant text[][] := array[
    ['public.model_is_available(text)',                  'ae7c34277c6ae5fe19328356aab9697e'],
    ['public.models_switched_off()',                     'e949f74917b2593b4b1112485b8b40b9'],
    ['public.model_switch_state()',                      'ad22387e72826e6a06e4e217c00b7ef2'],
    ['public.model_switch_job_model(public.creative_jobs)', 'd558cad9334c15f6623a568207fd0f23'],
    ['public.model_switch_target_models(text, text)',    '8d1fc0853715e19819525806d9bc8024'],
    ['public.model_switch_stop_jobs(text[])',            'a56ebd78d306de492c321451df405b1f'],
    ['public.model_switch_counts(text[])',               'c269b63c0e555cc92d72d2ab8e04e535'],
    ['public.model_availability_log_append_only()',      '15126c28f8d797ecb711b051f0cb54f3'],
    ['public.model_availability_settings_guard()',       '6612d9bc787db608fea08ad671779487'],
    ['public.model_availability_settings_trail()',       'ff3cfe8c1e00e0b8dc483a7fbffb51be'],
    ['public.model_switch_note_quota()',                 '3aa43a78f5f080084af8befeadf6d42e'],
    ['public.owner_model_switches()',                    '36947a634cbc0d8956eb053a1c5a5d5a'],
    ['public.owner_model_switch_preview(text, text)',    '838c3927da48c5852df38574eb61b7d8'],
    ['public.owner_set_model_switch(text, text, boolean, text, text, boolean)', '7954b93c8ba875c192b691c5c512dab3'],
    ['public.owner_model_alert_dismiss(bigint)',         '925aa435e837121d03ba1c062601119d']
  ];
  i integer;
  h text;
begin
  for i in 1 .. array_length(want, 1) loop
    if to_regprocedure(want[i][1]) is not null then
      select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into h from pg_proc x where x.oid = to_regprocedure(want[i][1]);
      if h <> want[i][2] then
        raise exception '0124 found % that is not 0124''s body (md5 %): read the live body first', want[i][1], h;
      end if;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables (no API role has any privilege on any of them; the definer functions are the only door)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.model_availability_settings (
  id                     boolean primary key default true,
  enforced               boolean not null default false,
  auto_suggest           boolean not null default false,
  suggest_threshold      integer not null default 3,
  suggest_window_minutes integer not null default 60,
  updated_at             timestamptz not null default now()
);

alter table public.model_availability_settings drop constraint if exists model_availability_settings_one_row;
alter table public.model_availability_settings add constraint model_availability_settings_one_row check (id);
alter table public.model_availability_settings drop constraint if exists model_availability_settings_numbers;
alter table public.model_availability_settings add constraint model_availability_settings_numbers
  check (suggest_threshold between 2 and 50 and suggest_window_minutes between 5 and 1440);

comment on table public.model_availability_settings is
  'One row (migration 0124). enforced = false (the default) makes every model available: the owner''s switches are not in force. auto_suggest = false (the default) keeps the optional "may be out of funds" alert off. Changed in the SQL editor only; a trigger logs every change.';

insert into public.model_availability_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.model_availability (
  scope            text not null,
  target           text not null,
  enabled          boolean not null,
  reason           text,
  note             text,
  changed_by       uuid,
  changed_by_email text,
  changed_at       timestamptz not null default now(),
  primary key (scope, target)
);

alter table public.model_availability drop constraint if exists model_availability_scope_check;
alter table public.model_availability add constraint model_availability_scope_check
  check (scope in ('model', 'provider'));
-- The same shapes model_registry accepts for its id and its provider (0035).
alter table public.model_availability drop constraint if exists model_availability_target_check;
alter table public.model_availability add constraint model_availability_target_check
  check ((scope = 'model' and target ~ '^[a-z0-9][a-z0-9.-]{1,39}$')
         or (scope = 'provider' and target ~ '^[a-z0-9-]{2,32}$'));
-- OFF needs one of four words (coalesce: a NULL reason must not pass a CHECK); ON carries none. The note is short, one line, plain text.
alter table public.model_availability drop constraint if exists model_availability_reason_check;
alter table public.model_availability add constraint model_availability_reason_check
  check ((enabled and reason is null and note is null)
         or (not enabled and coalesce(reason in ('out_of_funds', 'vendor_outage', 'terms_review', 'other'), false)
             and (note is null or (char_length(note) between 1 and 200 and note !~ '[[:cntrl:]]'))));

comment on table public.model_availability is
  'The owner''s switches (migration 0124). NO ROW = ENABLED. A row with enabled = false hides the model (scope model) or every model of the provider (scope provider) from users while model_availability_settings.enforced is true. Written only by owner_set_model_switch().';

create table if not exists public.model_availability_log (
  id               bigint generated always as identity primary key,
  at               timestamptz not null default now(),
  kind             text not null,
  scope            text,
  target           text,
  enabled          boolean,
  previous_enabled boolean,
  reason           text,
  note             text,
  jobs_stopped     integer not null default 0,
  in_flight        integer not null default 0,
  actor_user_id    uuid,
  actor_email      text,
  detail           jsonb not null default '{}'::jsonb
);

alter table public.model_availability_log drop constraint if exists model_availability_log_kind_check;
alter table public.model_availability_log add constraint model_availability_log_kind_check
  check (kind in ('switch', 'settings', 'alert_dismissed'));
alter table public.model_availability_log drop constraint if exists model_availability_log_sizes_check;
alter table public.model_availability_log add constraint model_availability_log_sizes_check
  check (jobs_stopped >= 0 and in_flight >= 0
         and (note is null or char_length(note) <= 200)
         and jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 2048);

create index if not exists model_availability_log_at_idx on public.model_availability_log (at desc, id desc);

comment on table public.model_availability_log is
  'Append-only record of every change to the owner''s model switches (migration 0124): who, when, why, the state before and the jobs it stopped. Nothing updates or deletes a row, not even the table owner. Read through owner_model_switches().';

create table if not exists public.model_availability_alerts (
  id             bigint generated always as identity primary key,
  provider       text not null,
  kind           text not null default 'may_be_out_of_funds',
  status         text not null default 'open',
  failures       integer not null,
  window_minutes integer not null,
  first_at       timestamptz not null default now(),
  last_at        timestamptz not null default now(),
  dismissed_at   timestamptz,
  dismissed_by   uuid
);

alter table public.model_availability_alerts drop constraint if exists model_availability_alerts_check;
alter table public.model_availability_alerts add constraint model_availability_alerts_check
  check (provider ~ '^[a-z0-9-]{2,32}$' and kind in ('may_be_out_of_funds') and status in ('open', 'dismissed')
         and failures >= 1 and window_minutes between 5 and 1440
         and ((status = 'open' and dismissed_at is null) or (status = 'dismissed' and dismissed_at is not null)));

create unique index if not exists model_availability_alerts_open_key
  on public.model_availability_alerts (provider, kind) where status = 'open';

comment on table public.model_availability_alerts is
  'The optional auto-suggestion (migration 0124, model_availability_settings.auto_suggest, default off): a provider whose jobs failed with the typed code quota at least suggest_threshold times in suggest_window_minutes. It only says so; nothing is hidden by it.';

alter table public.model_availability_settings enable row level security;
alter table public.model_availability enable row level security;
alter table public.model_availability_log enable row level security;
alter table public.model_availability_alerts enable row level security;

revoke all on public.model_availability_settings from public, anon, authenticated, service_role;
revoke all on public.model_availability from public, anon, authenticated, service_role;
revoke all on public.model_availability_log from public, anon, authenticated, service_role;
revoke all on public.model_availability_alerts from public, anon, authenticated, service_role;
revoke all on sequence public.model_availability_log_id_seq from public, anon, authenticated, service_role;
revoke all on sequence public.model_availability_alerts_id_seq from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Triggers: the log cannot be rewritten; the settings row cannot be deleted; a change to it leaves a mark
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.model_availability_log_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'model_availability_log is append-only' using errcode = '42501';
end
$$;

drop trigger if exists model_availability_log_append_only on public.model_availability_log;
create trigger model_availability_log_append_only
  before update or delete on public.model_availability_log
  for each row execute function public.model_availability_log_append_only();
drop trigger if exists model_availability_log_no_truncate on public.model_availability_log;
create trigger model_availability_log_no_truncate
  before truncate on public.model_availability_log
  for each statement execute function public.model_availability_log_append_only();

-- The settings row is edited (SQL editor), never deleted or emptied: a missing row would read as "not in force", which is the safe
-- direction, but the owner would not see why the switches stopped.
create or replace function public.model_availability_settings_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'model_availability_settings keeps its one row' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists model_availability_settings_guard on public.model_availability_settings;
create trigger model_availability_settings_guard
  before update or delete on public.model_availability_settings
  for each row execute function public.model_availability_settings_guard();
drop trigger if exists model_availability_settings_no_truncate on public.model_availability_settings;
create trigger model_availability_settings_no_truncate
  before truncate on public.model_availability_settings
  for each statement execute function public.model_availability_settings_guard();

-- A change of the settings row (the SQL editor is the only way to make one) leaves a mark in the log and in security_events. It can
-- never fail the write it observes: in an emergency the owner must be able to set enforced back to false.
create or replace function public.model_availability_settings_trail() returns trigger
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  d jsonb;
begin
  begin
    if new.enforced is distinct from old.enforced or new.auto_suggest is distinct from old.auto_suggest
       or new.suggest_threshold is distinct from old.suggest_threshold
       or new.suggest_window_minutes is distinct from old.suggest_window_minutes then
      d := jsonb_build_object(
        'enforced', jsonb_build_array(old.enforced, new.enforced),
        'auto_suggest', jsonb_build_array(old.auto_suggest, new.auto_suggest),
        'suggest_threshold', jsonb_build_array(old.suggest_threshold, new.suggest_threshold),
        'suggest_window_minutes', jsonb_build_array(old.suggest_window_minutes, new.suggest_window_minutes));
      insert into public.model_availability_log (kind, actor_user_id, actor_email, detail)
      values ('settings', auth.uid(), public.my_confirmed_email(), d);
      perform public.security_event_log('model.switch.settings',
        case when new.enforced is distinct from old.enforced then 'critical' else 'warning' end,
        'model_availability_settings', d);
    end if;
  exception when others then
    raise warning 'model switch trail (settings) failed: %', sqlerrm;
  end;
  return null;
end
$$;

drop trigger if exists model_availability_settings_trail on public.model_availability_settings;
create trigger model_availability_settings_trail
  after update on public.model_availability_settings
  for each row execute function public.model_availability_settings_trail();

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The read path (the one definition of "available")
-- ───────────────────────────────────────────────────────────────────────────

-- THE definition of "available". TRUE for everything until the owner's switches are put in force (enforced), so that applying this
-- file changes nothing. A model is off when its own row says so or its provider's does; a model row that says "on" does not
-- override a provider that is off.
-- NO EXISTENCE ORACLE. A signed-in customer may call this directly (the registry policy needs it executable by the reader). To such a
-- caller a model that is not on sale and proven (hidden, unproven, disabled, or not in the registry at all) always reads TRUE, so a
-- hidden id and a made-up id cannot be told apart by asking whether they are available. A platform admin and the platform's own
-- callers (the workers; credits_trusted_caller) get the real answer for every id.
create or replace function public.model_is_available(p_model text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  m    text := lower(btrim(coalesce(p_model, '')));
  prov text;
  seen boolean;
begin
  if m = '' or not coalesce((select s.enforced from public.model_availability_settings s), false) then
    return true;
  end if;
  select r.provider, (r.availability in ('beta', 'ga') and r.verified_at is not null) into prov, seen
    from public.model_registry r where r.id = m;
  if not coalesce(seen, false) and not (public.is_platform_admin() or public.credits_trusted_caller()) then
    return true;
  end if;
  return not exists (
    select 1 from public.model_availability a
     where not a.enabled
       and ((a.scope = 'model' and a.target = m)
            or (a.scope = 'provider' and prov is not null and a.target = prov)));
end
$$;

-- The ids a signed-in user is not offered right now, and nothing else: no reason, no note, no who. The Command Center subtracts them
-- where it reads the registry directly (a platform admin's read is not filtered by the policy) and to say "temporarily unavailable"
-- over a model a project already has selected. Only models a customer could be offered at all (on sale and proven: the registry
-- policy's own test): a model that is still hidden or unproven is not in a customer's list, so its id is not told to them here either.
create or replace function public.models_switched_off() returns text[]
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(r.id order by r.id), '{}'::text[])
    from public.model_registry r
   where r.availability in ('beta', 'ga') and r.verified_at is not null
     and not public.model_is_available(r.id)
$$;

-- What the queue worker asks before it spends on a channel-pipeline run (modules/model_switch.py): which providers and models are off.
-- The service role only; ids only.
create or replace function public.model_switch_state() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  enf boolean := coalesce((select s.enforced from public.model_availability_settings s), false);
begin
  if not public.credits_trusted_caller() then
    raise exception 'the model switches are read by the platform''s workers only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'enforced', enf,
    'providers', case when enf then coalesce((select jsonb_agg(a.target order by a.target)
                                                from public.model_availability a
                                               where a.scope = 'provider' and not a.enabled), '[]'::jsonb)
                      else '[]'::jsonb end,
    'models', case when enf then coalesce((select jsonb_agg(a.target order by a.target)
                                             from public.model_availability a
                                            where a.scope = 'model' and not a.enabled), '[]'::jsonb)
                   else '[]'::jsonb end);
end
$$;

-- The model a creative job runs (the worker's own rule): the person's pick for exact, the router's for the others.
create or replace function public.model_switch_job_model(p_job public.creative_jobs) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select case when p_job.mode = 'exact' then p_job.requested_model
              else coalesce(p_job.routed_model, p_job.requested_model) end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Stopping jobs that were not sent, and counting them
-- ───────────────────────────────────────────────────────────────────────────

-- The registry models a switch applies to: the one model, or every model of the provider. NULL when the target is not in the registry.
create or replace function public.model_switch_target_models(p_scope text, p_target text) returns text[]
  language sql stable security definer set search_path = public, pg_temp as $$
  select case
           when p_scope = 'model' then
             (select array_agg(r.id) from public.model_registry r where r.id = lower(btrim(coalesce(p_target, ''))))
           when p_scope = 'provider' then
             (select array_agg(r.id order by r.id) from public.model_registry r where r.provider = lower(btrim(coalesce(p_target, ''))))
         end
$$;

-- Creative jobs on these models that are still on the platform's side of the vendor (waiting: queued, or claimed but not sent) and
-- those already with the vendor (in_flight). The line between them is the one the in-flight rule draws: submit_started_at or
-- provider_task_id set = sent.
create or replace function public.model_switch_counts(p_models text[]) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'queued',    count(*) filter (where j.status = 'queued' and j.provider_task_id is null and j.submit_started_at is null),
    'running',   count(*) filter (where j.status = 'running' and j.provider_task_id is null and j.submit_started_at is null),
    'waiting',   count(*) filter (where j.status in ('queued', 'running') and j.provider_task_id is null and j.submit_started_at is null),
    'in_flight', count(*) filter (where j.provider_task_id is not null or j.submit_started_at is not null))
    from public.creative_jobs j
   where j.status in ('queued', 'running', 'provider_pending', 'processing')
     and public.model_switch_job_model(j) = any (p_models)
$$;

-- THE IN-FLIGHT RULE, switch side: the jobs on these models that have not been sent to the vendor are ended, their holds released, in
-- the caller's transaction. Accounts are locked in one order (organization, then job, re-checked under the lock: the order every sweep
-- of 0036 takes); a job a worker holds a moment ago is skipped, and is stopped by advance_creative_job at its last gate instead.
-- BOUNDED: at most 200 jobs per call, so one call stays far inside the API's statement_timeout (8 s) however long the queue is. The
-- caller learns how many are left (owner_set_model_switch: remaining) and calls again. Nothing depends on the sweep being finished: a
-- job it has not reached cannot be sent either, because advance_creative_job refuses it at the last gate.
create or replace function public.model_switch_stop_jobs(p_models text[]) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s record;
  n integer := 0;
begin
  for s in
    select j.id, j.org_id from public.creative_jobs j
     where j.status in ('queued', 'running') and j.provider_task_id is null and j.submit_started_at is null
       and public.model_switch_job_model(j) = any (p_models)
     order by j.org_id, j.id
     limit 200
  loop
    perform public.credit_account_lock(s.org_id);
    perform 1 from public.creative_jobs j
      where j.id = s.id and j.status in ('queued', 'running') and j.provider_task_id is null and j.submit_started_at is null
      for update skip locked;
    if found then
      perform public.creative_end_locked(s.id, 'failed', 'model_temporarily_off',
        'this model was switched off before the job was sent to the vendor; nothing was submitted and the credits were released');
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The optional alert (inert unless model_availability_settings.auto_suggest)
-- ───────────────────────────────────────────────────────────────────────────

-- The optional alert. Inert unless model_availability_settings.auto_suggest; fires only for a job that just failed with the typed code
-- 'quota'; records one open alert per provider; never touches a switch. Wrapped so that a failure here can never undo the job's own
-- finish (its refund).
create or replace function public.model_switch_note_quota() returns trigger
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  st   public.model_availability_settings;
  prov text;
  n    integer;
begin
  begin
    select * into st from public.model_availability_settings;
    if not coalesce(st.auto_suggest, false) then
      return null;
    end if;
    select r.provider into prov from public.model_registry r where r.id = public.model_switch_job_model(new);
    if prov is null then
      return null;
    end if;
    select count(*) into n
      from public.creative_jobs j
      join public.model_registry r on r.id = public.model_switch_job_model(j)
     where r.provider = prov and j.status = 'failed' and j.error_code = 'quota'
       and j.finished_at >= now() - make_interval(mins => st.suggest_window_minutes);
    if n >= st.suggest_threshold then
      insert into public.model_availability_alerts (provider, failures, window_minutes)
      values (prov, n, st.suggest_window_minutes)
      on conflict (provider, kind) where status = 'open'
      do update set failures = excluded.failures, window_minutes = excluded.window_minutes, last_at = now();
    end if;
  exception when others then
    raise warning 'model switch alert failed: %', sqlerrm;
  end;
  return null;
end
$$;

drop trigger if exists model_switch_note_quota on public.creative_jobs;
create trigger model_switch_note_quota
  after update of status on public.creative_jobs
  for each row
  when (new.status = 'failed' and old.status is distinct from 'failed' and new.error_code = 'quota')
  execute function public.model_switch_note_quota();

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The owner's functions
-- ───────────────────────────────────────────────────────────────────────────

-- The owner's Models section, in one document: the settings, every provider with its models and their switches, the open alerts and
-- the last 50 changes. Ids, closed words and the owner's own notes: no key, no price, no spec.
create or replace function public.owner_model_switches() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  st public.model_availability_settings;
begin
  if auth.uid() is null or not public.is_platform_admin() or public.platform_role() is distinct from 'owner' then
    raise exception 'only the platform owner may do this' using errcode = '42501';
  end if;
  select * into st from public.model_availability_settings;
  return jsonb_build_object(
    'enforced', coalesce(st.enforced, false),
    'auto_suggest', coalesce(st.auto_suggest, false),
    'suggest_threshold', st.suggest_threshold,
    'suggest_window_minutes', st.suggest_window_minutes,
    'providers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'provider', pr.provider,
               'switch', (select jsonb_build_object('enabled', a.enabled, 'reason', a.reason, 'note', a.note,
                                                    'changed_at', a.changed_at, 'changed_by_email', a.changed_by_email)
                            from public.model_availability a where a.scope = 'provider' and a.target = pr.provider),
               'hidden', coalesce(st.enforced, false)
                         and exists (select 1 from public.model_availability a
                                      where a.scope = 'provider' and a.target = pr.provider and not a.enabled),
               'models', (select coalesce(jsonb_agg(jsonb_build_object(
                             'id', m.id, 'display_name', m.display_name, 'capabilities', to_jsonb(m.capabilities),
                             'availability', m.availability,
                             'switch', (select jsonb_build_object('enabled', a.enabled, 'reason', a.reason, 'note', a.note,
                                                                  'changed_at', a.changed_at, 'changed_by_email', a.changed_by_email)
                                          from public.model_availability a where a.scope = 'model' and a.target = m.id),
                             'hidden', not public.model_is_available(m.id)) order by m.id), '[]'::jsonb)
                            from public.model_registry m where m.provider = pr.provider)
             ) order by pr.provider)
        from (select distinct r.provider from public.model_registry r) pr), '[]'::jsonb),
    'alerts', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'provider', x.provider, 'kind', x.kind, 'failures', x.failures,
                                          'window_minutes', x.window_minutes, 'first_at', x.first_at, 'last_at', x.last_at)
                       order by x.last_at desc)
        from public.model_availability_alerts x where x.status = 'open'), '[]'::jsonb),
    'log', coalesce((
      select jsonb_agg(to_jsonb(l) order by l.id desc)
        from (select id, at, kind, scope, target, enabled, previous_enabled, reason, note, jobs_stopped, in_flight,
                     actor_email, detail
                from public.model_availability_log order by id desc limit 50) l), '[]'::jsonb));
end
$$;

-- What turning a target OFF would touch, for the confirmation: jobs not yet sent (they would be stopped and their credits returned)
-- and jobs already with the vendor (they finish). Counts only.
create or replace function public.owner_model_switch_preview(p_scope text, p_target text) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  ids text[];
begin
  if auth.uid() is null or not public.is_platform_admin() or public.platform_role() is distinct from 'owner' then
    raise exception 'only the platform owner may do this' using errcode = '42501';
  end if;
  ids := public.model_switch_target_models(lower(btrim(coalesce(p_scope, ''))), p_target);
  if ids is null then
    return public.owner_err('unknown_target', 'That model or provider is not in the registry.');
  end if;
  return jsonb_build_object('ok', true, 'models', cardinality(ids)) || public.model_switch_counts(ids);
end
$$;

-- Turn a model or a provider OFF or ON. OFF needs one of the four reasons and stops the jobs that were not sent (the in-flight rule);
-- when there are such jobs it refuses until the caller confirms (the answer carries their number). Everything is written in this one
-- transaction: the switch, the jobs' ends and releases, the log row and the security event.
-- BOUNDED SWEEP: one call stops at most 200 jobs. The answer carries jobs_stopped and remaining (jobs on the target that were not sent and
-- are still waiting) and complete = (remaining = 0); the switch row itself is written whole on the first call, so the model is already
-- hidden and refused whatever remains, and the owner is told to run the same OFF again until remaining is 0. A job left over cannot be
-- sent in the meantime (advance_creative_job stops it at its last gate).
-- Every call is an unconditional OFF, plain and complete (an ON pressed in another tab mid-sweep is overridden by the next call), and
-- writes one log row and one security event. owner_guard allows 60 calls per fixed 10 minutes ('owner:model_switch', shared by every call
-- of this function): at most 60 x 200 = 12,000 jobs per window, and a sweep may leave another switch change rate_limited for up to 10
-- minutes. Leftovers are still stopped at the last gate.
create or replace function public.owner_set_model_switch(
  p_scope text, p_target text, p_enabled boolean, p_reason text default null, p_note text default null,
  p_confirm boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  g       jsonb;
  st      public.model_availability_settings;
  sc      text := lower(btrim(coalesce(p_scope, '')));
  tg      text := lower(btrim(coalesce(p_target, '')));
  rs      text := nullif(lower(btrim(coalesce(p_reason, ''))), '');
  nt      text := nullif(btrim(coalesce(p_note, '')), '');
  ids     text[];
  prev    public.model_availability;
  had     boolean;
  cnt     jsonb;
  stopped integer := 0;
  v_email text := public.my_confirmed_email();
  v_eff   boolean;
begin
  g := public.owner_guard('model_switch', 60);
  if g is not null then
    return g;
  end if;
  if public.platform_role() is distinct from 'owner' then
    return public.owner_err('owner_required', 'Only the platform owner may switch models.');
  end if;
  select * into st from public.model_availability_settings;
  if not coalesce(st.enforced, false) then
    return public.owner_err('not_enforced', 'Model switches are not in force on this deployment. Nothing was changed.');
  end if;
  if sc not in ('model', 'provider') then
    return public.owner_err('bad_scope', 'scope must be model or provider');
  end if;
  if p_enabled is null then
    return public.owner_err('bad_enabled', 'enabled must be true or false');
  end if;
  ids := public.model_switch_target_models(sc, tg);
  if ids is null then
    return public.owner_err('unknown_target', 'That model or provider is not in the registry.');
  end if;
  if p_enabled then
    -- Turning ON carries no reason: the last word stays in the log.
    rs := null;
    nt := null;
  else
    if rs is null or not (rs = any (array['out_of_funds', 'vendor_outage', 'terms_review', 'other'])) then
      return public.owner_err('bad_reason', 'Choose one of: out_of_funds, vendor_outage, terms_review, other.');
    end if;
    if nt is not null and (char_length(nt) > 200 or nt ~ '[[:cntrl:]]') then
      return public.owner_err('bad_note', 'The note is at most 200 characters on one line.');
    end if;
  end if;

  -- One switch at a time, so two tabs cannot interleave the sweep below.
  perform pg_advisory_xact_lock(hashtextextended('model_switch', 0));
  select * into prev from public.model_availability a where a.scope = sc and a.target = tg for update;
  had := found;
  if not p_enabled then
    cnt := public.model_switch_counts(ids);
    if (cnt ->> 'waiting')::integer > 0 and not coalesce(p_confirm, false) then
      return public.owner_err('confirm_required',
        'Jobs that were not sent yet would be stopped and their credits returned. Confirm to go on.', cnt);
    end if;
  end if;

  insert into public.model_availability (scope, target, enabled, reason, note, changed_by, changed_by_email, changed_at)
  values (sc, tg, p_enabled, rs, nt, auth.uid(), v_email, now())
  on conflict (scope, target) do update
    set enabled = excluded.enabled, reason = excluded.reason, note = excluded.note,
        changed_by = excluded.changed_by, changed_by_email = excluded.changed_by_email, changed_at = excluded.changed_at;

  if not p_enabled then
    stopped := public.model_switch_stop_jobs(ids);
  end if;
  cnt := public.model_switch_counts(ids);
  select bool_and(public.model_is_available(i)) into v_eff from unnest(ids) i;

  insert into public.model_availability_log
    (kind, scope, target, enabled, previous_enabled, reason, note, jobs_stopped, in_flight, actor_user_id, actor_email, detail)
  values ('switch', sc, tg, p_enabled, case when had then prev.enabled end, rs, nt, stopped,
          coalesce((cnt ->> 'in_flight')::integer, 0), auth.uid(), v_email,
          jsonb_build_object('models', cardinality(ids), 'effective_available', v_eff,
                             'remaining', coalesce((cnt ->> 'waiting')::integer, 0)));
  perform public.security_event_log('model.switch', case when p_enabled then 'notice' else 'warning' end, sc || ':' || tg,
    jsonb_build_object('enabled', p_enabled, 'reason', rs, 'jobs_stopped', stopped, 'models', cardinality(ids),
                       'remaining', coalesce((cnt ->> 'waiting')::integer, 0)));

  return jsonb_build_object('ok', true, 'scope', sc, 'target', tg, 'enabled', p_enabled, 'effective_available', v_eff,
                            'jobs_stopped', stopped, 'in_flight', coalesce((cnt ->> 'in_flight')::integer, 0),
                            'remaining', case when p_enabled then 0 else coalesce((cnt ->> 'waiting')::integer, 0) end,
                            'complete', p_enabled or coalesce((cnt ->> 'waiting')::integer, 0) = 0);
end
$$;

create or replace function public.owner_model_alert_dismiss(p_id bigint) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  g jsonb;
  a public.model_availability_alerts;
begin
  g := public.owner_guard('model_switch_alert', 60);
  if g is not null then
    return g;
  end if;
  if public.platform_role() is distinct from 'owner' then
    return public.owner_err('owner_required', 'Only the platform owner may do this.');
  end if;
  update public.model_availability_alerts
     set status = 'dismissed', dismissed_at = now(), dismissed_by = auth.uid()
   where id = p_id and status = 'open'
  returning * into a;
  if not found then
    return public.owner_err('no_such_alert', 'That alert is not open.');
  end if;
  insert into public.model_availability_log (kind, scope, target, actor_user_id, actor_email, detail)
  values ('alert_dismissed', 'provider', a.provider, auth.uid(), public.my_confirmed_email(),
          jsonb_build_object('alert', a.id, 'failures', a.failures));
  return jsonb_build_object('ok', true, 'id', a.id);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. The enforcement: five replaced functions (each is the earlier body with lines ADDED, marked "0124") and one policy
-- ───────────────────────────────────────────────────────────────────────────

-- 0100's sellable_models, plus one predicate.
create or replace function public.sellable_models(p_capability text default null, p_surface text default 'web')
  returns table (
    id text, display_name text, provider text, capabilities text[], availability text,
    verified_at timestamptz, credit_unit text, entitlement text,
    credits_per_unit numeric, margin numeric, spec jsonb)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_surface is null or p_surface not in ('web', 'api', 'mcp') then
    raise exception 'unknown surface %', p_surface using errcode = '22023';
  end if;
  if p_capability is not null
     and p_capability not in ('t2i', 'edit', 't2v', 'i2v', 'tts', 'sfx', 'upscale', 'remove_bg',
                              'voice_change', 'dub', 'video_upscale', 'describe', 'captions',
                              'expand', 'relight', 'erase', 'video_edit', 'video_reframe', 'video_remove_bg') then
    raise exception 'unknown capability %', p_capability using errcode = '22023';
  end if;
  -- Captions are a web tool (0072): the transcript lives in caption_tracks,
  -- which only a signed-in member's session can read. Sold through the API or
  -- MCP (api_creative_model_ok asks this function for 'api'), a key could pay
  -- for a job whose result it can never fetch. No other surface lists them,
  -- whatever the registry says.
  if p_capability = 'captions' and p_surface <> 'web' then
    return;
  end if;
  return query
    select m.id, m.display_name, m.provider, m.capabilities, m.availability, m.verified_at,
           -- 0084: the rate as charged (margin folded in) and never the margin
           -- itself. The column stays (NULL) so the return type, and every
           -- earlier migration's create-or-replace on a replay, is unchanged.
           m.credit_unit, m.entitlement, cp.credits_per_unit * (1 + cp.margin), null::numeric,
           -- The public half of spec: what a person choosing a model needs.
           -- Never provider costs, evidence, notes, the probe or the vendor id.
           jsonb_strip_nulls(jsonb_build_object(
             'output', m.spec -> 'output', 'inputs', m.spec -> 'inputs',
             'aspect_ratios', m.spec -> 'aspect_ratios',
             'aspect_ratios_by_capability', m.spec -> 'aspect_ratios_by_capability',
             'image_sizes', m.spec -> 'image_sizes', 'resolutions', m.spec -> 'resolutions',
             'durations_s', m.spec -> 'durations_s', 'audio_out', m.spec -> 'audio_out',
             'upscale_factors', m.spec -> 'upscale_factors', 'languages', m.spec -> 'languages',
             'upscale_targets', m.spec -> 'upscale_targets', 'end_frame', m.spec -> 'end_frame',
             'async', m.spec -> 'async', 'unit', m.spec -> 'pricing' -> 'unit',
             'qualities', m.spec -> 'qualities',
             'relight_looks', m.spec -> 'relight_looks',
             'default_resolution', m.spec -> 'default_resolution',
             'price_variants_by', m.spec -> 'pricing' -> 'variants' -> 'by',
             'attribution', m.spec -> 'attribution', 'api_exposure', m.spec -> 'api_exposure',
             'limits', m.spec -> 'limits', 'quality_tier', m.spec -> 'quality_tier',
             'speed_tier', m.spec -> 'speed_tier'))
      from public.model_registry m
      join public.credit_prices cp on cp.unit = m.credit_unit
     where m.availability in ('beta', 'ga')
       and m.verified_at is not null
       and m.verified_probe_id is not null
       and coalesce(m.spec ->> 'terms_gate', '') = ''
       and cp.credits_per_unit > 0
       -- 0124: the owner's switch (model_is_available is TRUE for every model until it is put in force).
       and public.model_is_available(m.id)
       -- A model sold by quality is shown only when at least one of its tiers
       -- has a price: a tier without a row is unpriced, never free.
       and (m.spec -> 'pricing' -> 'variants' ->> 'by' is distinct from 'quality'
            or exists (select 1
                         from jsonb_array_elements_text(coalesce(m.spec -> 'qualities', '[]'::jsonb)) as tiers(tier)
                         join public.credit_prices qp on qp.unit = m.credit_unit || '_' || tiers.tier
                        where qp.credits_per_unit > 0))
       -- Likewise a model sold by soundtrack, or by a resolution it pins (0070):
       -- shown only while one of its variants has a price (never free).
       and (not (coalesce(m.spec -> 'pricing' -> 'variants' ->> 'by', '') in ('audio', 'resolution_audio')
                 or (coalesce(m.spec -> 'pricing' -> 'variants' ->> 'by', '') = 'resolution'
                     and nullif(m.spec ->> 'default_resolution', '') is not null))
            or exists (select 1
                         from jsonb_object_keys(coalesce(m.spec -> 'pricing' -> 'variants' -> 'prices', '{}'::jsonb)) as vk(variant)
                         join public.credit_prices vp
                           on vp.unit = m.credit_unit || '_' || regexp_replace(lower(vk.variant), '[^a-z0-9]', '_', 'g')
                        where vp.credits_per_unit > 0))
       and (p_capability is null or p_capability = any (m.capabilities))
       and (p_surface = 'web' or coalesce(m.spec ->> 'api_exposure', 'any') <> 'web_only')
       and (p_surface = 'web' or not ('captions' = any (m.capabilities)))
     order by m.provider, m.id;
end
$$;

-- 0100's creative_price, plus one refusal.
create or replace function public.creative_price(
  p_org uuid, p_capability text, p_model text, p_params jsonb
) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  cap     text := lower(btrim(coalesce(p_capability, '')));
  mdl     text := lower(btrim(coalesce(p_model, '')));
  problem text;
  m_unit  text;
  m_ent   text;
  m_spec  jsonb;
  m_found boolean := false;
  rate    public.credit_prices;
  floor_c numeric;
  qty     numeric;
  price   numeric;
  minimum numeric := 0;
  longest numeric;
  tier    text;
  vby     text;
  vres    text;
  vaud    text;
  variant jsonb := '{}'::jsonb;
begin
  if cap !~ '^[a-z][a-z0-9_]{0,31}$' then
    perform public.creative_refuse('invalid_params', 'capability is required');
  end if;
  if not public.creative_capability_supported(cap) then
    perform public.creative_refuse('capability_not_supported',
      format('%s cannot be generated yet on this deployment', cap));
  end if;
  if mdl !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then
    perform public.creative_refuse('invalid_params', 'model is required');
  end if;
  problem := public.creative_params_problem(cap, p_params);
  if problem is not null then
    perform public.creative_refuse('invalid_params', problem);
  end if;
  -- The input picture, recording or video (and an end frame) must be this
  -- organization's, live, and usable.
  problem := public.creative_source_problem(p_org, cap, p_params);
  if problem is not null then
    perform public.creative_refuse('source_unavailable', problem);
  end if;
  -- The style kit must be this organization's.
  problem := public.creative_style_problem(p_org, cap, p_params);
  if problem is not null then
    perform public.creative_refuse('style_unavailable', problem);
  end if;

  -- Never "allow every model" when the registry is not there (see 0036).
  if to_regclass('public.model_registry') is null then
    perform public.creative_refuse('registry_missing',
      'the model registry (migration 0035) is not applied on this deployment');
  end if;
  select true, r.credit_unit, r.entitlement, r.spec
    into m_found, m_unit, m_ent, m_spec
    from public.model_registry r
   where r.id = mdl
     and r.availability in ('beta', 'ga')
     and r.verified_at is not null
     and cap = any (r.capabilities);
  if not coalesce(m_found, false) then
    perform public.creative_refuse('model_not_sellable',
      format('%s is not available for %s', mdl, cap));
  end if;
  -- 0124: the owner temporarily switched this model (or its provider) off. Refused before anything is priced, held or charged,
  -- and never answered with another model: the person chooses. model_is_available is TRUE for every model until the switches
  -- are put in force.
  if not public.model_is_available(mdl) then
    perform public.creative_refuse('model_temporarily_off',
      format('%s is temporarily unavailable', mdl));
  end if;
  if coalesce(m_ent, 'any') not in ('any', 'paid') then
    perform public.creative_refuse('entitlement_required',
      format('%s needs the %s entitlement', mdl, m_ent));
  end if;
  if m_ent = 'paid' and not public.credits_exempt(p_org)
     and not exists (select 1 from public.credit_transactions t
                      where t.org_id = p_org and t.kind = 'purchase') then
    perform public.creative_refuse('entitlement_required',
      format('%s is available after the organization''s first credit purchase', mdl));
  end if;
  -- A factor the model was not proven (and priced) for is not sold.
  if cap = 'upscale'
     and not coalesce(jsonb_typeof(m_spec -> 'upscale_factors') = 'array'
                      and (m_spec -> 'upscale_factors') @> (p_params -> 'factor'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer a %sx upscale', mdl, p_params ->> 'factor'));
  end if;
  -- Nor a language the model was not proven (and listed) for.
  if cap = 'dub'
     and not coalesce(jsonb_typeof(m_spec -> 'languages') = 'array'
                      and (m_spec -> 'languages') @> jsonb_build_array(p_params ->> 'target_language'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not dub into %s', mdl, p_params ->> 'target_language'));
  end if;
  -- Nor a spoken language the model was not proven (and listed) for. No
  -- language at all is allowed: the provider detects it.
  if cap = 'captions' and p_params ? 'language'
     and not coalesce(jsonb_typeof(m_spec -> 'languages') = 'array'
                      and (m_spec -> 'languages') @> jsonb_build_array(p_params ->> 'language'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not transcribe %s', mdl, p_params ->> 'language'));
  end if;
  -- Nor a video target the model was not proven (and listed) for.
  if cap = 'video_upscale'
     and not coalesce(jsonb_typeof(m_spec -> 'upscale_targets') = 'array'
                      and (m_spec -> 'upscale_targets') @> jsonb_build_array(p_params ->> 'target_resolution'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not upscale a video to %s', mdl, p_params ->> 'target_resolution'));
  end if;
  -- 0099: nor a shape to extend a picture to, or a light, that the model was
  -- not proven (and listed) for. A free prompt for a relight needs no list.
  if cap = 'expand'
     and not coalesce(jsonb_typeof(m_spec -> 'aspect_ratios_by_capability' -> 'expand') = 'array'
                      and (m_spec -> 'aspect_ratios_by_capability' -> 'expand') @> jsonb_build_array(p_params ->> 'aspect_ratio'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not extend a picture to %s', mdl, p_params ->> 'aspect_ratio'));
  end if;
  if cap = 'relight' and p_params ? 'look'
     and not coalesce(jsonb_typeof(m_spec -> 'relight_looks') = 'array'
                      and (m_spec -> 'relight_looks') @> jsonb_build_array(p_params ->> 'look'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer the %s light', mdl, p_params ->> 'look'));
  end if;
  -- 0100: nor a shape to reframe a video to that the model was not proven (and
  -- listed) for.
  if cap = 'video_reframe'
     and not coalesce(jsonb_typeof(m_spec -> 'aspect_ratios_by_capability' -> 'video_reframe') = 'array'
                      and (m_spec -> 'aspect_ratios_by_capability' -> 'video_reframe') @> jsonb_build_array(p_params ->> 'aspect_ratio'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not reframe a video to %s', mdl, p_params ->> 'aspect_ratio'));
  end if;
  -- Nor an ending on a model that would drop it.
  if p_params ? 'end_asset_id' and coalesce(m_spec -> 'end_frame', 'false'::jsonb) <> 'true'::jsonb then
    perform public.creative_refuse('invalid_params',
      format('%s cannot end a clip on a chosen picture', mdl));
  end if;

  -- A quality the model does not offer is refused, never ignored: the
  -- provider would bill its own default under the quoted price (0060).
  if p_params ? 'quality'
     and not coalesce(jsonb_typeof(m_spec -> 'qualities') = 'array'
                      and (m_spec -> 'qualities') @> jsonb_build_array(p_params ->> 'quality'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer the %s quality', mdl, p_params ->> 'quality'));
  end if;

  -- One price per target when the registry prices the targets apart
  -- (model_registry.credit_unit_for): a target without its own row is
  -- unpriced, never sold at another target's rate.
  if cap = 'video_upscale' and m_unit is not null
     and m_spec -> 'pricing' -> 'variants' ->> 'by' = 'upscale_target' then
    m_unit := m_unit || '_' || regexp_replace(lower(p_params ->> 'target_resolution'), '[^a-z0-9]', '_', 'g');
  end if;
  -- One price per quality tier when the registry prices the tiers apart
  -- (model_registry.credit_unit_for: model_<id>_<unit>_<tier>). No tier named
  -- = medium, the same tier the worker sends; a tier without its own row is
  -- unpriced, never sold at another tier's rate and never at 0.
  if cap in ('t2i', 'edit') and m_unit is not null
     and m_spec -> 'pricing' -> 'variants' ->> 'by' = 'quality' then
    tier := coalesce(p_params ->> 'quality', 'medium');
    if not coalesce(jsonb_typeof(m_spec -> 'qualities') = 'array'
                    and (m_spec -> 'qualities') @> jsonb_build_array(tier), false) then
      perform public.creative_refuse('invalid_params',
        format('%s does not offer the %s quality', mdl, tier));
    end if;
    m_unit := m_unit || '_' || regexp_replace(lower(tier), '[^a-z0-9]', '_', 'g');
  end if;
  -- The video settings (0070).
  if cap in ('t2v', 'i2v') then
    vby := m_spec -> 'pricing' -> 'variants' ->> 'by';
    -- A resolution the model does not list is refused, never ignored: the
    -- vendor would render (and bill) something else under the quoted price.
    if p_params ? 'resolution'
       and not coalesce(jsonb_typeof(m_spec -> 'resolutions') = 'array'
                        and (m_spec -> 'resolutions') @> jsonb_build_array(p_params ->> 'resolution'), false) then
      perform public.creative_refuse('invalid_params',
        format('%s does not offer %s', mdl, p_params ->> 'resolution'));
    end if;
    -- A soundtrack choice only on a model that prices it apart (the worker
    -- sends the flag for no other), and only if it makes sound at all.
    if p_params ? 'audio'
       and (coalesce(vby, '') not in ('audio', 'resolution_audio')
            or coalesce(m_spec -> 'audio_out', 'false'::jsonb) <> 'true'::jsonb) then
      perform public.creative_refuse('invalid_params',
        format('%s does not offer a choice of sound', mdl));
    end if;
    -- One price per setting when the registry prices the settings apart
    -- (model_registry.credit_unit_for: model_<id>_<unit>_<resolution>_<silent|audio>).
    -- No resolution named = the model's pinned one and no audio = silent, the
    -- same the worker sends. A resolution variant counts only for a model that
    -- pins one (Veo and Wan 3.0 are still sold by their base row). A setting
    -- without its own row is unpriced, never another setting's rate, never 0.
    if m_unit is not null
       and (coalesce(vby, '') in ('audio', 'resolution_audio')
            or (coalesce(vby, '') = 'resolution' and nullif(m_spec ->> 'default_resolution', '') is not null)) then
      if vby in ('resolution', 'resolution_audio') then
        vres := coalesce(p_params ->> 'resolution', nullif(m_spec ->> 'default_resolution', ''));
        if vres is null then
          perform public.creative_refuse('unpriced',
            format('%s has no credit price yet; a platform admin sets it on the Credits page', mdl));
        end if;
      end if;
      if vby in ('audio', 'resolution_audio') then
        vaud := case when coalesce((p_params ->> 'audio')::boolean, false) then 'audio' else 'silent' end;
      end if;
      m_unit := m_unit || '_' || regexp_replace(lower(concat_ws('_', vres, vaud)), '[^a-z0-9]', '_', 'g');
      variant := jsonb_strip_nulls(jsonb_build_object(
        'resolution', vres, 'audio', case when vaud is null then null else vaud = 'audio' end));
    end if;
  end if;
  if m_unit is not null then
    select * into rate from public.credit_prices where unit = m_unit;
  end if;
  if m_unit is null or rate.unit is null then
    perform public.creative_refuse('unpriced',
      format('%s has no credit price yet; a platform admin sets it on the Credits page', mdl));
  end if;

  if cap in ('voice_change', 'dub', 'video_upscale', 'captions', 'video_edit', 'video_reframe', 'video_remove_bg') then
    -- The file's measured length, from the database — never the client's.
    qty := public.creative_source_seconds(p_org, p_params);
  else
    qty := public.creative_quantity(cap, p_params);
  end if;
  if qty is null or qty <= 0 then
    -- Unknown is never priced as 0 (CLAUDE.md #5).
    perform public.creative_refuse('source_unavailable', 'the length of the source is not known, so it cannot be priced');
  end if;
  if cap = 'video_upscale' then
    -- The vendor's longest input, as the registry states it: a model that
    -- states none is not sold a length it may refuse after the hold.
    longest := case when jsonb_typeof(m_spec -> 'limits' -> 'max_source_seconds') = 'number'
                    then (m_spec -> 'limits' ->> 'max_source_seconds')::numeric end;
    if longest is null or longest <= 0 then
      perform public.creative_refuse('model_not_sellable',
        format('%s does not state the longest video it takes', mdl));
    end if;
    if qty > longest then
      perform public.creative_refuse('source_unavailable',
        format('this model upscales videos of up to %s seconds; trim this one first', longest));
    end if;
  end if;
  if cap in ('video_edit', 'video_reframe', 'video_remove_bg') then
    -- 0100: the same rule as the upscale's, in the video ops' own words: a model
    -- that states no longest input is not sold a length it may refuse after the hold.
    longest := case when jsonb_typeof(m_spec -> 'limits' -> 'max_source_seconds') = 'number'
                    then (m_spec -> 'limits' ->> 'max_source_seconds')::numeric end;
    if longest is null or longest <= 0 then
      perform public.creative_refuse('model_not_sellable',
        format('%s does not state the longest video it takes', mdl));
    end if;
    if qty > longest then
      perform public.creative_refuse('source_unavailable',
        format('this model takes videos of up to %s seconds; trim this one first', longest));
    end if;
  end if;
  -- Rounded to 6 places before the upward cent, so numeric division noise
  -- never adds a cent (0030 does the same).
  price := public.credits_round_up(round(qty * rate.credits_per_unit * (1 + rate.margin), 6));
  select credits_per_unit into floor_c from public.credit_prices where unit = 'job_minimum';
  if floor_c is not null then
    minimum := public.credits_round_up(floor_c);
  end if;
  if price > 0 then
    price := greatest(price, minimum);
  end if;

  return jsonb_build_object(
    'credits', price, 'exempt', public.credits_exempt(p_org),
    'model', mdl, 'capability', cap, 'unit', rate.unit, 'quantity', qty,
    -- 0084: the rate as charged, never the platform's base rate and margin
    -- apart (every quote, the API's and the routed ones included).
    'credits_per_unit', rate.credits_per_unit * (1 + rate.margin), 'minimum', minimum)
    -- The tier this price is for, so what the person confirms names it.
    || case when tier is null then '{}'::jsonb else jsonb_build_object('quality', tier) end
    -- The resolution and soundtrack this price is for (0070).
    || variant;
end
$$;

-- 0036's advance_creative_job, plus the last gate before the vendor is called.
create or replace function public.advance_creative_job(
  p_job uuid, p_worker text, p_step text,
  p_provider_task_id text default null, p_route jsonb default null
) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  j public.creative_jobs;
  w text := left(btrim(coalesce(p_worker, '')), 120);
  tid text := nullif(btrim(coalesce(p_provider_task_id, '')), '');
  g0 public.creative_jobs; -- 0124: the job as it stood before the gate below
begin
  if not public.credits_trusted_caller() then
    raise exception 'creative jobs are run by the platform''s worker only' using errcode = '42501';
  end if;
  -- 0124: the LAST gate before the vendor is called. A job that was created before its model was switched off and has not been
  -- sent (no submit_started_at, no provider_task_id) is ended here with its hold released, and the worker is told it is not
  -- its job to send any more. Done before this function locks the job: creative_end_locked takes the organization's account
  -- first and the job second, the order every function of 0036 takes. A job whose submit began first is sent and continues.
  if p_step = 'submitting' then
    select * into g0 from public.creative_jobs where id = p_job;
    if found and g0.worker_id is not distinct from w and g0.status = 'running'
       and g0.submit_started_at is null and g0.provider_task_id is null
       and not public.model_is_available(public.model_switch_job_model(g0)) then
      perform public.creative_end_locked(p_job, 'failed', 'model_temporarily_off',
        'this model was switched off before the job was sent to the vendor; nothing was submitted and the credits were released');
      return false;
    end if;
  end if;
  select * into j from public.creative_jobs where id = p_job for update;
  if not found or j.worker_id is distinct from w then
    return false;
  end if;
  if p_step = 'submitting' then
    if j.status <> 'running' or j.submit_started_at is not null or j.provider_task_id is not null then
      return false;
    end if;
    update public.creative_jobs
       set submit_started_at = now(), heartbeat_at = now(), updated_at = now()
     where id = p_job;
  elsif p_step = 'submitted' then
    if j.status <> 'running' or j.submit_started_at is null or j.provider_task_id is not null
       or tid is null or char_length(tid) > 512 then
      return false;
    end if;
    update public.creative_jobs
       set provider_task_id = tid, status = 'provider_pending',
           route = coalesce(p_route, route), heartbeat_at = now(), updated_at = now()
     where id = p_job;
  elsif p_step = 'processing' then
    if j.status <> 'provider_pending' then
      return false;
    end if;
    update public.creative_jobs
       set status = 'processing', heartbeat_at = now(), updated_at = now()
     where id = p_job;
  elsif p_step = 'requeue' then
    if j.status not in ('running', 'provider_pending', 'processing')
       or (j.submit_started_at is not null and j.provider_task_id is null) then
      return false;
    end if;
    update public.creative_jobs
       set status = 'queued', worker_id = null, attempts = greatest(j.attempts - 1, 0),
           updated_at = now()
     where id = p_job;
  else
    raise exception 'unknown step' using errcode = '22023';
  end if;
  perform public.creative_job_log(p_job, j.org_id, p_step,
    (select status from public.creative_jobs where id = p_job),
    case when p_step = 'submitted' then jsonb_build_object('task', true) end);
  return true;
end
$$;

-- 0062's api_creative_model_ok: a switched-off model that is otherwise on sale through the API raises the honest refusal.
create or replace function public.api_creative_model_ok(p_capability text, p_model text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  -- 0124: a model the owner switched off that the API would otherwise sell is refused with its own word, so a caller is told "temporarily
  -- unavailable" and not "not available through the API". Nothing is held. Every other model is judged as before.
  if not public.model_is_available(p_model)
     and exists (select 1 from public.model_registry r
                  where r.id = p_model and p_capability = any (r.capabilities)
                    and r.availability in ('beta', 'ga') and r.verified_at is not null
                    and coalesce(r.spec ->> 'api_exposure', 'any') <> 'web_only'
                    and p_capability <> 'captions') then
    perform public.creative_refuse('model_temporarily_off', format('%s is temporarily unavailable', p_model));
  end if;
  return exists (select 1 from public.sellable_models(p_capability, 'api') s where s.id = p_model);
end
$$;

-- 0075's api_creative_refusal, plus the word for the new refusal.
create or replace function public.api_creative_refusal(p_state text, p_msg text, p_detail text)
  returns jsonb
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  word text := btrim(coalesce(p_msg, ''));
  det  text := left(coalesce(p_detail, ''), 300);
  m    text[];
  extra jsonb := case when det <> '' and det <> word then jsonb_build_object('detail', det) else '{}'::jsonb end;
begin
  case p_state
    when '42501' then
      return public.api_err(403, 'forbidden', 'This key may not start generations in this organization.');
    when 'P0002' then
      return public.api_err(404, 'job_not_found', 'No generation with that id for this key.');
    when '22023' then
      return public.api_err(400, 'invalid_params', 'The request has a parameter this API does not accept.');
    when 'NS402' then
      m := regexp_match(coalesce(p_detail, ''), 'available=(-?[0-9.]+)\s+needed=([0-9.]+)');
      return public.api_err(402, 'insufficient_credits',
        'The organization does not have enough credits for this generation. Nothing was held.',
        case when m is null then '{}'::jsonb
             else jsonb_build_object('available_credits', m[1]::numeric, 'needed_credits', m[2]::numeric) end);
    when 'NS429' then
      m := regexp_match(coalesce(p_detail, ''), 'active=([0-9]+)\s+limit=([0-9]+)');
      return public.api_err(429, 'run_limit_reached',
        'All of the plan''s parallel runs are in use. Wait for one to finish.',
        jsonb_build_object('retry_after', 60) || case when m is null then '{}'::jsonb
             else jsonb_build_object('active', m[1]::int, 'limit', m[2]::int) end);
    when 'NS409' then
      if word = 'price_changed' then
        return public.api_err(409, 'price_changed',
          'The price is now above max_credits. Quote again and confirm the new price.', extra);
      elsif word = 'idempotency_conflict' then
        return public.api_err(422, 'idempotency_key_reused',
          'This Idempotency-Key was already used for a different generation.');
      -- 0075: the router's pick changed since the quote.
      elsif word = 'route_changed' then
        return public.api_err(409, 'route_changed',
          'The automatic choice changed since the quote. Quote again and confirm the new choice.', extra);
      end if;
    when 'NS400' then
      return case word
        when 'registry_missing' then public.api_err(503, 'registry_missing', 'The model registry is not set up on this deployment.')
        when 'model_not_sellable' then public.api_err(422, 'model_not_sellable', 'That model is not available for this capability through the API.', extra)
        when 'entitlement_required' then public.api_err(403, 'entitlement_required', 'The organization''s plan does not include this model.', extra)
        when 'unpriced' then public.api_err(422, 'unpriced', 'That model has no price yet, so it cannot be sold.')
        when 'capability_not_supported' then public.api_err(422, 'capability_not_supported', 'That capability cannot be generated on this deployment.', extra)
        when 'source_unavailable' then public.api_err(422, 'source_unavailable', 'A media-library file in the request is not available to this organization.', extra)
        when 'style_unavailable' then public.api_err(422, 'style_unavailable', 'The style kit in the request is not available to this organization.')
        when 'mode_not_supported' then public.api_err(422, 'mode_not_supported', 'Only mode "exact" (the model you named) is available.')
        -- 0075: no available, priced model of this plan takes these settings.
        when 'no_model_available' then public.api_err(422, 'no_model_available', 'No available, priced model can make this with these settings.', extra)
        -- 0124: the owner switched this model off for now. Nothing was held or charged; the caller chooses another or waits.
        when 'model_temporarily_off' then public.api_err(503, 'model_temporarily_off', 'That model is temporarily unavailable. Nothing was held or charged. Choose another model, or try again later.', extra)
        when 'invalid_idempotency_key' then public.api_err(400, 'invalid_idempotency_key', 'Idempotency-Key: 1-255 characters of A-Z a-z 0-9 _ : . -')
        else public.api_err(400, 'invalid_params', 'The request has a parameter this API does not accept.', extra)
      end;
    else
      null;
  end case;
  return public.api_err(500, 'internal_error',
    'The request failed inside the database. Nothing was created or charged; retry with backoff.');
end
$$;

-- 0035's policy, plus the switch for a customer's direct read. A platform admin still reads every row.
drop policy if exists model_registry_select on public.model_registry;
create policy model_registry_select on public.model_registry
  for select to authenticated
  using (public.is_platform_admin()
         or (availability in ('beta', 'ga') and verified_at is not null and public.model_is_available(id)));

-- ───────────────────────────────────────────────────────────────────────────
-- 8. Privileges (the replaced functions keep their earlier grants, stated again)
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.model_availability_log_append_only() from public, anon, authenticated, service_role;
revoke all on function public.model_availability_settings_guard() from public, anon, authenticated, service_role;
revoke all on function public.model_availability_settings_trail() from public, anon, authenticated, service_role;
revoke all on function public.model_switch_note_quota() from public, anon, authenticated, service_role;
revoke all on function public.model_switch_job_model(public.creative_jobs) from public, anon, authenticated, service_role;
revoke all on function public.model_switch_target_models(text, text) from public, anon, authenticated, service_role;
revoke all on function public.model_switch_counts(text[]) from public, anon, authenticated, service_role;
revoke all on function public.model_switch_stop_jobs(text[]) from public, anon, authenticated, service_role;

revoke all on function public.model_is_available(text) from public, anon, authenticated, service_role;
revoke all on function public.models_switched_off() from public, anon, authenticated, service_role;
revoke all on function public.model_switch_state() from public, anon, authenticated, service_role;
grant execute on function public.model_is_available(text) to authenticated, service_role;
grant execute on function public.models_switched_off() to authenticated, service_role;
grant execute on function public.model_switch_state() to service_role;

revoke all on function public.owner_model_switches() from public, anon, authenticated, service_role;
revoke all on function public.owner_model_switch_preview(text, text) from public, anon, authenticated, service_role;
revoke all on function public.owner_set_model_switch(text, text, boolean, text, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.owner_model_alert_dismiss(bigint) from public, anon, authenticated, service_role;
grant execute on function public.owner_model_switches() to authenticated;
grant execute on function public.owner_model_switch_preview(text, text) to authenticated;
grant execute on function public.owner_set_model_switch(text, text, boolean, text, text, boolean) to authenticated;
grant execute on function public.owner_model_alert_dismiss(bigint) to authenticated;

revoke all on function public.sellable_models(text, text) from public, anon;
grant execute on function public.sellable_models(text, text) to authenticated, service_role;
revoke all on function public.advance_creative_job(uuid, text, text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.advance_creative_job(uuid, text, text, text, jsonb) to service_role;
revoke all on function public.api_creative_model_ok(text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_creative_refusal(text, text, text) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select count(*) = 1 and bool_and(not enforced) and bool_and(not auto_suggest) from public.model_availability_settings) as dark,
--   not exists (select 1 from public.model_availability) as no_switch_recorded,
--   (select bool_and(relrowsecurity) from pg_class where oid in ('public.model_availability_settings'::regclass,
--      'public.model_availability'::regclass, 'public.model_availability_log'::regclass,
--      'public.model_availability_alerts'::regclass)) as rls_on,
--   not has_table_privilege('authenticated', 'public.model_availability', 'SELECT')
--     and not has_table_privilege('authenticated', 'public.model_availability', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.model_availability', 'UPDATE')
--     and not has_table_privilege('service_role', 'public.model_availability', 'SELECT')
--     and not has_table_privilege('anon', 'public.model_availability', 'SELECT')
--     and not has_table_privilege('authenticated', 'public.model_availability_log', 'SELECT')
--     and not has_table_privilege('authenticated', 'public.model_availability_settings', 'SELECT')
--     and not has_table_privilege('authenticated', 'public.model_availability_alerts', 'SELECT') as tables_closed,
--   has_function_privilege('authenticated', 'public.model_is_available(text)', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.models_switched_off()', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.model_is_available(text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.model_switch_state()', 'EXECUTE')
--     and has_function_privilege('service_role', 'public.model_switch_state()', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.owner_set_model_switch(text,text,boolean,text,text,boolean)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.owner_set_model_switch(text,text,boolean,text,text,boolean)', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.owner_set_model_switch(text,text,boolean,text,text,boolean)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.model_switch_stop_jobs(text[])', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.sellable_models(text,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.sellable_models(text,text)', 'EXECUTE')
--     and has_function_privilege('service_role', 'public.advance_creative_job(uuid,text,text,text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.advance_creative_job(uuid,text,text,text,jsonb)', 'EXECUTE') as functions_scoped,
--   (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and p.prosecdef
--       and (p.proname like 'model\_switch\_%' or p.proname like 'model\_availability\_%' or p.proname like 'owner\_model\_%'
--            or p.proname in ('model_is_available', 'models_switched_off'))
--       and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) = 0 as definer_functions_pin_search_path,
--   position('model_is_available' in pg_get_functiondef('public.sellable_models(text,text)'::regprocedure)) > 0
--     and position('model_temporarily_off' in pg_get_functiondef('public.creative_price(uuid,text,text,jsonb)'::regprocedure)) > 0
--     and position('model_temporarily_off' in pg_get_functiondef('public.advance_creative_job(uuid,text,text,text,jsonb)'::regprocedure)) > 0
--     and position('model_temporarily_off' in pg_get_functiondef('public.api_creative_model_ok(text,text)'::regprocedure)) > 0
--     and position('model_temporarily_off' in pg_get_functiondef('public.api_creative_refusal(text,text,text)'::regprocedure)) > 0 as gates_in_place,
--   exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'model_registry'
--            and policyname = 'model_registry_select' and qual like '%model_is_available%') as policy_in_place,
--   (select count(*) = 1 from pg_trigger where tgname = 'model_switch_note_quota' and not tgisinternal) as alert_trigger,
--   -- Dark: with enforced = false every registry model is available, so nothing changed for anyone.
--   not exists (select 1 from public.model_registry r where not public.model_is_available(r.id))
--     or (select enforced from public.model_availability_settings) as nothing_hidden_while_dark;
