-- 0196_owner_brain_facts.sql — the owner's facts for Nightshift Brain: people and plans, and system health, as compact JSON.
-- docs/MIGRATIONS.md "0196", docs/OWNER_BRAIN.md.
--
-- *** LIVE ON APPLY. *** Two read-only functions. No table, no write, nothing replaced.
--
-- WHY. The owner's Nightshift AI and the Owner Console answer questions about the whole system ("who bought which plan",
-- "did the daily bot run", "is a YouTube token dead", "what is stuck in the queue"). Those answers must come from the database,
-- server side, already summed — never from rows a browser or a model was handed — and only to the platform owner. Revenue
-- (0182 owner_analytics_money) and provider spend, top-ups and balances (0184, the Billing ledger) are NOT repeated here: the
-- app reads them from the functions that already exist, so the console and the AI cannot disagree with the analytics hub.
--
-- WHO. Platform owner only: owner_analytics_is_owner() (0182) first, before any argument is looked at (42501 otherwise), and
-- 0107's second factor when that gate is on (NS401) — a password-only session reads nothing here. Execute is granted to
-- `authenticated` only; anon and the service role cannot call either function. search_path is pinned.
--
-- WHAT IS NEVER IN THE OUTPUT. No token, secret, vault id, e-mail address, prompt, payment id or amount. A workspace is named
-- (the owner asked "who bought which plan"), a person is not. Every figure that could not be read is JSON null, never 0.
--
-- REQUIRES 0182 (owner gate, internal workspaces) and 0107 (admin_aal_ok). Additive and idempotent.
-- Undo: docs/sql/rollback_0196_owner_brain_facts.sql.
-- NUMBER. 0196 is provisional; the final number is assigned at merge.
set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.owner_analytics_is_owner()') is null then
    raise exception '0196 needs 0182_owner_analytics.sql: apply it first';
  end if;
  if to_regprocedure('public.admin_aal_ok()') is null then
    raise exception '0196 needs 0107_owner_safety.sql (admin_aal_ok): apply it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. People and plans
-- ───────────────────────────────────────────────────────────────────────────
-- Signups and activity are the people, paying is the workspaces. The operator's own and owner-flagged workspaces (0182's
-- owner_analytics_internal_org_ids) are left out of every count, as the analytics hub does by default, and the JSON says so.

create or replace function public.owner_brain_people()
  returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_internal uuid[];
  v_out jsonb;
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if not public.admin_aal_ok() then
    raise exception 'mfa_required' using errcode = 'NS401';
  end if;
  v_internal := array(select public.owner_analytics_internal_org_ids());

  with members as (
    -- A person counts once, by their earliest membership; a person only in internal workspaces is internal.
    select m.user_id, bool_and(m.org_id = any (v_internal)) as internal
      from public.org_members m
     group by m.user_id
  ),
  people as (
    select u.id, u.created_at, u.email_confirmed_at is not null as confirmed, u.last_sign_in_at,
           coalesce(mb.internal, false) as internal
      from auth.users u
      left join members mb on mb.user_id = u.id
  ),
  subs as (
    select s.org_id, s.plan_id, s.status, s.provider, s.current_period_start, s.cancel_at_period_end, s.canceled_at,
           s.last_event_at
      from public.subscriptions s
     where not (s.org_id = any (v_internal))
  )
  select jsonb_build_object(
    'as_of', now(),
    'internal_excluded', true,
    'signups', jsonb_build_object(
      'd1',  (select count(*) from people where not internal and confirmed and created_at >= now() - interval '1 day'),
      'd7',  (select count(*) from people where not internal and confirmed and created_at >= now() - interval '7 days'),
      'd30', (select count(*) from people where not internal and confirmed and created_at >= now() - interval '30 days'),
      'total', (select count(*) from people where not internal and confirmed),
      'unconfirmed_d30', (select count(*) from people where not internal and not confirmed and created_at >= now() - interval '30 days')
    ),
    -- Last sign-in only: a person can be active without signing in again (a long-lived session), so this is a floor.
    'signed_in', jsonb_build_object(
      'd7',  (select count(*) from people where not internal and last_sign_in_at >= now() - interval '7 days'),
      'd30', (select count(*) from people where not internal and last_sign_in_at >= now() - interval '30 days'),
      'basis', 'last_sign_in_at (a floor: a long session does not sign in again)'
    ),
    'paying_by_plan', coalesce((
      select jsonb_object_agg(plan_id, n) from (
        select plan_id, count(distinct org_id) as n from subs
         where status in ('active', 'trialing', 'past_due') group by plan_id
      ) x), '{}'::jsonb),
    'past_due', (select count(distinct org_id) from subs where status = 'past_due'),
    'cancelling', (select count(distinct org_id) from subs where status in ('active', 'trialing') and cancel_at_period_end),
    'canceled_d30', (select count(distinct org_id) from subs where status = 'canceled' and canceled_at >= now() - interval '30 days'),
    -- Who bought which plan, newest first: the workspace's name and the plan, never a person or a payment id.
    'recent_plan_changes', coalesce((
      select jsonb_agg(r order by r->>'at' desc) from (
        select jsonb_build_object(
                 'workspace', o.name, 'plan', s.plan_id, 'status', s.status, 'provider', s.provider,
                 'at', coalesce(s.last_event_at, s.current_period_start)) as r
          from subs s join public.organizations o on o.id = s.org_id
         order by coalesce(s.last_event_at, s.current_period_start) desc nulls last
         limit 20
      ) y), '[]'::jsonb)
  ) into v_out;
  return v_out;
end
$$;

comment on function public.owner_brain_people() is
  'Migration 0196: the owner''s people-and-plans facts for Nightshift Brain as one JSON object — confirmed signups (1/7/30 days), last sign-ins (a floor), paying workspaces by plan, past due, cancelling, canceled in 30 days, and the 20 newest plan changes by workspace name. Internal and owner-flagged workspaces are excluded. Platform owner only, second factor when 0107''s gate is on; read-only.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. System health
-- ───────────────────────────────────────────────────────────────────────────
-- What the database can say about the platform's health. What it cannot say is said as such: CI and deploys live in GitHub
-- Actions, not here ("not_in_database"); most bot events reach Supabase through a once-a-day mirror, so "no event today" is
-- not "the bot did not run" (modules/operator_bot/sources.py), and the JSON carries the mirror's own time.

create or replace function public.owner_brain_health()
  returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_since24 text := to_char((now() at time zone 'utc') - interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS');
  v_since7  text := to_char((now() at time zone 'utc') - interval '7 days', 'YYYY-MM-DD"T"HH24:MI:SS');
  v_out jsonb;
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if not public.admin_aal_ok() then
    raise exception 'mfa_required' using errcode = 'NS401';
  end if;

  select jsonb_build_object(
    'as_of', now(),
    -- system_events.ts is ISO text (some naive, some with a zone): compared as text against an ISO bound, never cast, so one
    -- malformed row cannot fail the whole answer.
    'channels', coalesce((
      select jsonb_agg(c order by c->>'channel_id') from (
        select jsonb_build_object(
          'channel_id', ch.channel_id,
          'name', ch.name,
          'status', ch.status,
          'last_run_event_at', (select max(e.ts) from public.system_events e
                                 where e.channel_id = ch.channel_id
                                   and e.event in ('system.started', 'render.completed', 'upload.completed', 'video.published',
                                                   'publish.held', 'publish.blocked', 'upload.failed', 'storyboard.ready')),
          'failures_24h', (select count(*) from public.system_events e
                            where e.channel_id = ch.channel_id and e.ts >= v_since24
                              and (e.status ilike 'fail%' or e.status ilike 'error%' or e.event like '%.failed')),
          'failures_7d', (select count(*) from public.system_events e
                           where e.channel_id = ch.channel_id and e.ts >= v_since7
                             and (e.status ilike 'fail%' or e.status ilike 'error%' or e.event like '%.failed')),
          'last_published_at', (select max(v.published_at) from public.videos v where v.channel_id = ch.channel_id),
          -- Videos a run held for a person (0016): blocked, awaiting approval, held, or repaired and waiting for review.
          'held_videos', (select count(*) from public.videos v where v.channel_id = ch.channel_id
                            and v.publish_state in ('blocked', 'awaiting_approval', 'held', 'repaired_awaiting_review')),
          -- Connected means a stored, unrevoked token exists (0022). Whether YouTube still accepts it is the bot's live check:
          -- its latest verdict is the credential row and the newest oauth failure event, both shown with their time.
          'youtube', jsonb_build_object(
            'token_stored', exists (select 1 from public.channel_token_refs t
                                     where t.channel_id = ch.channel_id and t.revoked_at is null),
            'credential_status', (select cc.status from public.channel_credentials cc
                                   where cc.channel_id = ch.channel_id and cc.provider = 'youtube'),
            'credential_checked_at', (select cc.last_verified_at from public.channel_credentials cc
                                       where cc.channel_id = ch.channel_id and cc.provider = 'youtube'),
            'last_oauth_failure_at', (select max(e.ts) from public.system_events e
                                       where e.channel_id = ch.channel_id and e.event = 'channel.oauth.failed')
          )
        ) as c
        from public.channels ch
      ) x), '[]'::jsonb),
    'queues', jsonb_build_object(
      'creative', jsonb_build_object(
        'queued', (select count(*) from public.creative_jobs j where j.status = 'queued'),
        'oldest_queued_at', (select min(j.created_at) from public.creative_jobs j where j.status = 'queued'),
        'running', (select count(*) from public.creative_jobs j
                     where j.status in ('planning', 'running', 'provider_pending', 'processing', 'rendering')),
        -- A running job whose worker has not been heard from for 10 minutes is stuck, not running.
        'stuck', (select count(*) from public.creative_jobs j
                   where j.status in ('planning', 'running', 'provider_pending', 'processing', 'rendering')
                     and coalesce(j.heartbeat_at, j.started_at, j.created_at) < now() - interval '10 minutes'),
        'failed_24h', (select count(*) from public.creative_jobs j where j.status = 'failed' and j.created_at >= now() - interval '1 day'),
        'quota_failed_24h', (select count(*) from public.creative_jobs j
                              where j.status = 'failed' and j.error_code = 'quota' and j.created_at >= now() - interval '1 day')
      ),
      'render', jsonb_build_object(
        'queued', (select count(*) from public.render_jobs r where r.status = 'queued'),
        'oldest_queued_at', (select min(r.created_at) from public.render_jobs r where r.status = 'queued'),
        'running', (select count(*) from public.render_jobs r where r.status = 'running'),
        'failed_24h', (select count(*) from public.render_jobs r where r.status = 'failed' and r.created_at >= now() - interval '1 day')
      )
    ),
    -- A worker row older than 120 s is stale (command-center/lib/workers.ts STALE_AFTER_S).
    'workers', coalesce((
      select jsonb_agg(jsonb_build_object('worker_id', w.worker_id, 'kind', w.kind, 'state', w.state, 'updated_at', w.updated_at,
                                          'stale', w.updated_at < now() - interval '120 seconds') order by w.worker_id)
        from public.worker_status w), '[]'::jsonb),
    'doctor', (select jsonb_build_object('verdict', a.title, 'at', a.at) from public.alert_events a
                where a.kind = 'operator.doctor' order by a.at desc limit 1),
    'alerts_24h', jsonb_build_object(
      'critical', (select count(*) from public.alert_events a
                    where a.at >= now() - interval '1 day' and a.severity = 'critical' and a.kind not like 'operator.%'),
      'warn', (select count(*) from public.alert_events a
                where a.at >= now() - interval '1 day' and a.severity = 'warn' and a.kind not like 'operator.%')
    ),
    'pipeline_mirror_at', (select max(vc.synced_at) from public.video_costs vc),
    'provider_readings', coalesce((
      select jsonb_object_agg(provider, checked_at) from (
        select b.provider, max(b.checked_at) as checked_at from public.provider_balances b where b.source = 'api' group by b.provider
      ) z), '{}'::jsonb),
    'ci_deploy', jsonb_build_object('state', 'not_in_database', 'where', 'GitHub Actions (deploy_web.yml, tests.yml, frontend.yml)')
  ) into v_out;
  return v_out;
end
$$;

comment on function public.owner_brain_health() is
  'Migration 0196: the owner''s system-health facts for Nightshift Brain as one JSON object — per channel the newest run evidence, failures in 24 h / 7 days, held videos and the YouTube token''s stored/verified state (no token bytes); creative and render queues (queued, oldest, running, stuck, failed); workers and their staleness; the doctor''s verdict; alerts; the pipeline mirror''s time; provider readings'' times. CI and deploys are not in the database and say so. Platform owner only, second factor when 0107''s gate is on; read-only.';

revoke all on function public.owner_brain_people() from public, anon, authenticated, service_role;
revoke all on function public.owner_brain_health() from public, anon, authenticated, service_role;
grant execute on function public.owner_brain_people() to authenticated;
grant execute on function public.owner_brain_health() to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. End state
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  sig text;
  fn  oid;
begin
  foreach sig in array array['public.owner_brain_people()', 'public.owner_brain_health()'] loop
    fn := to_regprocedure(sig);
    if fn is null then
      raise exception '0196 end state: % does not exist', sig;
    end if;
    if not has_function_privilege('authenticated', fn, 'EXECUTE')
       or has_function_privilege('anon', fn, 'EXECUTE')
       or has_function_privilege('service_role', fn, 'EXECUTE') then
      raise exception '0196 end state: % has the wrong grants', sig;
    end if;
    if exists (select 1 from pg_proc p where p.oid = fn
                and (not p.prosecdef or p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                     or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
      raise exception '0196 end state: % is not a SECURITY DEFINER with a fixed search_path, or PUBLIC may call it', sig;
    end if;
  end loop;
end $$;
