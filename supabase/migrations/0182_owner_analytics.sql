-- 0182_owner_analytics.sql — the owner analytics hub's reads: money in, people, activity and jobs, plus the audit of every export.
-- docs/MIGRATIONS.md "0182", docs/OWNER_ANALYTICS.md.
--
-- *** LIVE ON APPLY, read-only except for its own export log. *** It adds one table (owner_analytics_exports, closed to every API
-- role) and seven functions. It replaces nothing, alters no existing table, column, policy or trigger, and writes no row of anyone
-- else's. It changes nothing about payments, credits, prices, holds, publishing or privacy.
--
-- WHY. The owner presents the business from the Command Center. Everything the business knows about money is in payment_events
-- (0021), credit_lots (0034), dodo_checkout_nonces (0146) and api_ledger (0031); about people in auth.users and the tables that record
-- what they made. None of these may be read by an API role, and the Command Center reads with the signed-in session and the ANON key
-- only (no service key, CLAUDE.md #3). So each read here is a SECURITY DEFINER function that refuses everyone but the platform OWNER
-- (platform_role() = 'owner', not 'admin': revenue and the people behind it are the owner's to show) before it reads anything.
--
-- WHAT IT RETURNS, AND WHAT IT REFUSES TO INVENT (CLAUDE.md #5).
--   * Amounts are what the payment provider reported (amount_minor, tax included, in the payment's currency). A null amount stays
--     null. Nothing is converted: there is no stored exchange rate, so a non-USD payment is returned in its own currency and the app
--     counts it apart rather than adding it as dollars.
--   * Provider fees are NOT stored by either webhook. fee_minor is always null today, and the app shows fees as "unknown" and net
--     as "before provider fees". The column exists so a later migration that does store a fee changes nothing downstream.
--   * Initial vs renewal comes from the webhook's own note when it says ("(new)" / "(renewal)" from Dodo, Paddle's origin), else from
--     the order of the subscription's billed periods (credit_lots); when neither can tell, it is null — never assumed "initial".
--   * Customer country is not stored anywhere; nothing here pretends otherwise.
--   * The operator's own workspace (default_org_id()) is returned with internal = true, so the app can leave it out of revenue and
--     still say how much it left out.
--   * No e-mail, name or customer id leaves this file. People are opaque uuids; payments are the provider's transaction id (the app
--     hides those in presentation mode).
--
-- WHO MAY CALL WHAT. Execute is granted to `authenticated` only (revoked from public, anon and service_role); each function checks
-- auth.uid() and platform_role() = 'owner' first and raises 42501 for anyone else. owner_analytics_sales_all() is internal: no API
-- role may execute it, only the functions here. search_path is pinned on every function. owner_analytics_exports has RLS on and no
-- policy: only owner_analytics_record_export() writes it (as the caller, actor pinned to auth.uid()), and only
-- owner_analytics_export_log() reads it.
--
-- THE APP WITHOUT THIS FILE. Every page of the hub calls these through the owner's session; a missing function (42883 / PGRST202)
-- shows "this needs migration 0182" in place of the numbers, never zeros. Exports are refused without the audit log: an export that
-- could not be recorded is not produced.
--
-- REQUIRES 0018 (platform_role, default_org_id), 0021 (payment_events, credit_refunds), 0031 (api_ledger), 0034 (credit_lots),
-- 0036 (creative_jobs), 0054 (editor_projects, editor_exports), 0092 (friend_invite_joins), 0103 (email_preferences),
-- 0146 (dodo_checkout_nonces) and 0165 (referral_rewards).
-- Additive and idempotent: a replay changes nothing. Undo: docs/sql/rollback_0182_owner_analytics.sql (owner-applied).
--
-- NUMBER. 0182, reserved for the owner analytics stream (0182–0184). Live ends at 0174; the Supabase integration refuses a number
-- below the latest applied one, so this may be renumbered at merge. It names no object of 0175–0181.
--
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.platform_role()') is null or to_regprocedure('public.default_org_id()') is null then
    raise exception '0182 needs 0018_organizations.sql: apply it first';
  end if;
  if to_regclass('public.payment_events') is null or to_regclass('public.credit_refunds') is null then
    raise exception '0182 needs 0021_credit_refunds.sql: apply it first';
  end if;
  if to_regclass('public.api_ledger') is null then
    raise exception '0182 needs 0031_public_api.sql: apply it first';
  end if;
  if to_regclass('public.credit_lots') is null then
    raise exception '0182 needs 0034_plans_entitlements.sql: apply it first';
  end if;
  if to_regclass('public.creative_jobs') is null then
    raise exception '0182 needs 0036 (creative_jobs): apply it first';
  end if;
  if to_regclass('public.editor_projects') is null or to_regclass('public.editor_exports') is null then
    raise exception '0182 needs 0054 (editor_projects, editor_exports): apply it first';
  end if;
  if to_regclass('public.friend_invite_joins') is null then
    raise exception '0182 needs 0092 (friend_invite_joins): apply it first';
  end if;
  if to_regclass('public.email_preferences') is null then
    raise exception '0182 needs 0103 (email_preferences): apply it first';
  end if;
  if to_regclass('public.dodo_checkout_nonces') is null then
    raise exception '0182 needs 0146_dodo_payments.sql: apply it first';
  end if;
  if to_regclass('public.referral_rewards') is null then
    raise exception '0182 needs 0165_referral_rewards.sql: apply it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Who may read: the platform owner, and nobody else
-- ───────────────────────────────────────────────────────────────────────────

-- The question the pages ask before they draw anything. Never raises: a customer who types the URL gets false, and learns nothing.
create or replace function public.owner_analytics_is_owner() returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null and coalesce(public.platform_role() = 'owner', false)
$$;

comment on function public.owner_analytics_is_owner() is
  'Migration 0182: true only for the signed-in platform owner (platform_role() = ''owner''). The owner analytics hub''s page gate; every read below checks the same thing itself.';

revoke all on function public.owner_analytics_is_owner() from public, anon, authenticated, service_role;
grant execute on function public.owner_analytics_is_owner() to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Every sale, classified (internal: only the functions below call it)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.owner_analytics_sales_all()
  returns table (
    provider         text,
    payment_ref      text,
    at               timestamptz,
    org_ref          uuid,
    kind             text,
    item             text,
    charge           text,
    currency         text,
    amount_minor     bigint,
    period_start     timestamptz,
    period_end       timestamptz,
    subscription_ref bigint,
    internal         boolean
  )
  language sql stable security invoker set search_path = public, pg_temp
as $$
  with paid as (
    -- One row per payment: a webhook delivered twice is recorded 'duplicate' the second time; the 'processed' row wins.
    select distinct on (e.provider, e.transaction_id)
           e.provider, e.transaction_id, coalesce(e.occurred_at, e.received_at) as at, e.org_id, e.currency, e.amount_minor
      from public.payment_events e
     where ((e.provider = 'dodo' and e.event_type = 'payment.succeeded')
            or (e.provider = 'paddle' and e.event_type = 'transaction.completed'))
       and e.status in ('processed', 'duplicate')
       and e.transaction_id is not null
       -- A fully discounted checkout is not a sale; an amount the provider did not report stays in, as unknown.
       and (e.amount_minor is null or e.amount_minor > 0)
     order by e.provider, e.transaction_id, (e.status = 'processed') desc, e.received_at, e.event_id
  )
  select p.provider,
         p.transaction_id,
         p.at,
         p.org_id,
         case when lot.id is not null or sub_txn.note is not null then 'plan'
              when exists (select 1 from public.api_ledger a where a.external_id = p.transaction_id and a.kind = 'topup') then 'api_topup'
              when nonce.item like 'pack:%' or exists (select 1 from public.credit_transactions t
                                                      where t.external_id = p.transaction_id and t.kind = 'purchase') then 'pack'
              else 'unknown' end,
         case when lot.id is not null then lot.plan_id
              when sub_txn.note is not null then substring(sub_txn.note from '^(?:Dodo|Paddle) \S+: ([a-z0-9_-]+) plan')
              when nonce.item like 'pack:amount\_%' then 'amount'
              when nonce.item like 'pack:%' then substring(nonce.item from 6)
              else null end,
         case when sub_txn.note ~ '\((renewal|subscription_recurring)\)' then 'renewal'
              when sub_txn.note ~ '\((new|web|api)\)' then 'initial'
              when lot.id is not null then
                case when exists (select 1 from public.credit_lots l2
                                   where l2.subscription_id = lot.subscription_id and l2.source = 'subscription'
                                     and l2.period_start < lot.period_start) then 'renewal' else 'initial' end
              else null end,
         p.currency,
         p.amount_minor,
         lot.period_start,
         lot.period_end,
         lot.subscription_id,
         p.org_id is not distinct from public.default_org_id()
    from paid p
    left join lateral (
      select l.id, l.plan_id, l.period_start, l.period_end, l.subscription_id
        from public.credit_lots l
       where l.external_id = p.transaction_id and l.source = 'subscription'
       order by l.period_start limit 1
    ) lot on true
    left join lateral (
      select t.note from public.credit_transactions t
       where t.external_id = p.transaction_id and t.kind = 'subscription'
       order by t.id limit 1
    ) sub_txn on true
    left join lateral (
      select n.item from public.dodo_checkout_nonces n
       where p.provider = 'dodo' and n.consumed_by = p.transaction_id
       order by n.consumed_at limit 1
    ) nonce on true
$$;

comment on function public.owner_analytics_sales_all() is
  'Migration 0182 (internal): every credited sale, one row per payment, classified as plan / pack / api_topup / unknown, with initial vs renewal when the record says. No API role may execute it; the owner analytics functions do.';

revoke all on function public.owner_analytics_sales_all() from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Money in a window: sales, refunds and disputes
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.owner_analytics_money(p_from timestamptz, p_to timestamptz)
  returns table (
    event            text,
    at               timestamptz,
    provider         text,
    payment_ref      text,
    org_ref          uuid,
    kind             text,
    item             text,
    charge           text,
    currency         text,
    amount_minor     bigint,
    fee_minor        bigint,
    period_start     timestamptz,
    period_end       timestamptz,
    subscription_ref bigint,
    internal         boolean
  )
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  -- First, before any read or any look at the arguments.
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'a window needs a start before its end' using errcode = '22023';
  end if;

  return query
  with sales as (select * from public.owner_analytics_sales_all()),
  backs as (
    -- One row per refund or dispute. Paddle sends adjustment.created and then .updated for the same adjustment: the latest wins.
    select distinct on (e.provider, coalesce(e.adjustment_id, e.event_id))
           e.provider, e.transaction_id, e.event_type, e.adjustment_id, coalesce(e.occurred_at, e.received_at) as at,
           e.currency, e.amount_minor
      from public.payment_events e
     where e.status = 'processed'
       and e.transaction_id is not null
       and ((e.provider = 'dodo' and e.event_type in ('refund.succeeded', 'dispute.accepted', 'dispute.lost'))
            or (e.provider = 'paddle' and e.event_type in ('adjustment.created', 'adjustment.updated')))
       and coalesce(e.occurred_at, e.received_at) >= p_from and coalesce(e.occurred_at, e.received_at) < p_to
     order by e.provider, coalesce(e.adjustment_id, e.event_id), e.received_at desc, e.event_id
  )
  select 'sale'::text, s.at, s.provider, s.payment_ref, s.org_ref, s.kind, s.item, s.charge, s.currency, s.amount_minor,
         null::bigint, s.period_start, s.period_end, s.subscription_ref, s.internal
    from sales s
   where s.at >= p_from and s.at < p_to
  union all
  select case when b.event_type in ('dispute.accepted', 'dispute.lost') then 'dispute'
              when b.provider = 'paddle' and exists (select 1 from public.credit_refunds r
                                                     where r.refund_id = b.adjustment_id and r.reason = 'chargeback') then 'dispute'
              else 'refund' end,
         b.at, b.provider, b.transaction_id, s.org_ref, coalesce(s.kind, 'unknown'), s.item, s.charge,
         coalesce(b.currency, s.currency),
         -- A refund that carries no amount is unknown, not zero: the app says "refund recorded, amount unknown".
         b.amount_minor,
         null::bigint, null::timestamptz, null::timestamptz, s.subscription_ref, coalesce(s.internal, false)
    from backs b
    left join sales s on s.provider = b.provider and s.payment_ref = b.transaction_id
   order by 2, 4
   limit 50000;
end
$$;

comment on function public.owner_analytics_money(timestamptz, timestamptz) is
  'Migration 0182: the owner''s money events in [p_from, p_to): each credited sale (plan / pack / api_topup / unknown, initial or renewal when known) and each refund or dispute, with the amount the provider reported (null = not reported) and fee_minor (always null: no provider fee is stored). At most 50000 rows. Platform owner only; read-only.';

revoke all on function public.owner_analytics_money(timestamptz, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.owner_analytics_money(timestamptz, timestamptz) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. People: one row each, and the milestones of the activation funnel
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.owner_analytics_people()
  returns table (
    user_ref            uuid,
    signed_up_at        timestamptz,
    last_sign_in_at     timestamptz,
    locale              text,
    acquisition         text,
    internal            boolean,
    first_project_at    timestamptz,
    first_generation_at timestamptz,
    first_export_at     timestamptz,
    first_payment_at    timestamptz,
    first_plan          text
  )
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;

  return query
  with sales as (select * from public.owner_analytics_sales_all() s where not s.internal),
  owned as (
    -- A payment is a workspace's; a person is its payer when they own it (one person per workspace since 0091).
    select m.user_id, s.at, s.kind, s.item
      from public.org_members m
      join sales s on s.org_ref = m.org_id
     where m.role = 'owner' and m.user_id is not null
  )
  select u.id,
         u.created_at,
         u.last_sign_in_at,
         ep.locale,
         -- What is recorded, and only that: no UTM or signup-source field exists, so everyone else is null ("not recorded").
         case when exists (select 1 from public.referral_rewards r where r.invitee_id = u.id) then 'referral'
              when exists (select 1 from public.friend_invite_joins f where f.invitee_id = u.id) then 'invite'
              else null end,
         exists (select 1 from public.app_members a where a.user_id = u.id),
         (select min(p.created_at) from public.editor_projects p where p.created_by = u.id),
         (select min(j.created_at) from public.creative_jobs j where j.requested_by = u.id),
         (select min(x.finished_at) from public.editor_exports x where x.requested_by = u.id and x.status = 'done'),
         (select min(o.at) from owned o where o.user_id = u.id),
         (select o.item from owned o where o.user_id = u.id and o.kind = 'plan' order by o.at limit 1)
    from auth.users u
    left join public.email_preferences ep on ep.user_id = u.id
   order by u.created_at
   limit 100000;
end
$$;

comment on function public.owner_analytics_people() is
  'Migration 0182: one row per person (an opaque id, never an e-mail): signup and last sign-in, locale, acquisition when recorded (referral / invite, else null), whether they are on the platform roster, and when they first made a project, a generation, an export and a payment, and their first plan. At most 100000 rows. Platform owner only; read-only.';

revoke all on function public.owner_analytics_people() from public, anon, authenticated, service_role;
grant execute on function public.owner_analytics_people() to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Activity: who did something, on which Tashkent day
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.owner_analytics_activity(p_from timestamptz, p_to timestamptz)
  returns table (day date, user_ref uuid)
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'a window is a start before its end, at most 400 days' using errcode = '22023';
  end if;

  -- "Active" is an act that left a row: a generation asked for, a project made, an export asked for, or a sign-in. A page view is
  -- not here (site_page_views holds no person), so DAU here is "people who did something", and the page says so.
  return query
  select distinct (a.at at time zone 'Asia/Tashkent')::date, a.uid
    from (
      select j.created_at as at, j.requested_by as uid from public.creative_jobs j
       where j.created_at >= p_from and j.created_at < p_to and j.requested_by is not null
      union all
      select p.created_at, p.created_by from public.editor_projects p
       where p.created_at >= p_from and p.created_at < p_to and p.created_by is not null
      union all
      select x.created_at, x.requested_by from public.editor_exports x
       where x.created_at >= p_from and x.created_at < p_to
      union all
      select u.last_sign_in_at, u.id from auth.users u
       where u.last_sign_in_at >= p_from and u.last_sign_in_at < p_to
    ) a
   where not exists (select 1 from public.app_members m where m.user_id = a.uid)
   order by 1, 2
   limit 200000;
end
$$;

comment on function public.owner_analytics_activity(timestamptz, timestamptz) is
  'Migration 0182: distinct (Tashkent day, person) pairs in [p_from, p_to) where the person asked for a generation, made a project, asked for an export or signed in; the platform roster is left out. At most 400 days and 200000 rows. Platform owner only; read-only.';

revoke all on function public.owner_analytics_activity(timestamptz, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.owner_analytics_activity(timestamptz, timestamptz) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Jobs: by Tashkent day, model, kind and outcome
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.owner_analytics_jobs(p_from timestamptz, p_to timestamptz)
  returns table (
    day             date,
    kind            text,
    capability      text,
    model           text,
    status          text,
    payer           text,
    internal        boolean,
    jobs            bigint,
    credits_charged numeric,
    seconds_total   numeric,
    seconds_counted bigint
  )
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_internal uuid;
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '1100 days' then
    raise exception 'a window is a start before its end, at most 1100 days' using errcode = '22023';
  end if;
  v_internal := public.default_org_id();

  return query
  select (j.created_at at time zone 'Asia/Tashkent')::date,
         j.kind,
         j.capability,
         coalesce(j.routed_model, j.requested_model),
         j.status,
         j.payer,
         j.org_id is not distinct from v_internal,
         count(*),
         -- Credits a job was actually charged; a job that was never charged adds nothing (sum ignores the null).
         coalesce(sum(j.charged_credits), 0),
         -- Time to result: from the request to the finish, for the jobs that have both. The count says how many were timed, so
         -- an average is never drawn from fewer jobs than it seems.
         coalesce(sum(extract(epoch from (j.finished_at - j.created_at))) filter (where j.finished_at is not null), 0),
         count(*) filter (where j.finished_at is not null)
    from public.creative_jobs j
   where j.created_at >= p_from and j.created_at < p_to
   group by 1, 2, 3, 4, 5, 6, 7
   order by 1, 2, 3, 4, 5, 6, 7
   limit 50000;
end
$$;

comment on function public.owner_analytics_jobs(timestamptz, timestamptz) is
  'Migration 0182: creative jobs in [p_from, p_to) grouped by Tashkent day, kind, capability, model, status, payer and whether they are the operator''s own: count, credits charged, and the seconds from request to finish with how many jobs were timed. At most 1100 days. Platform owner only; read-only.';

revoke all on function public.owner_analytics_jobs(timestamptz, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.owner_analytics_jobs(timestamptz, timestamptz) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. The export log: who took what out, when
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.owner_analytics_exports (
  id            bigint generated always as identity primary key,
  actor_user_id uuid not null,
  what          text not null check (what ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  format        text not null check (format in ('csv', 'xlsx', 'pdf')),
  period_from   timestamptz not null,
  period_to     timestamptz not null,
  present_mode  boolean not null,
  created_at    timestamptz not null default now(),
  check (period_to > period_from)
);

comment on table public.owner_analytics_exports is
  'Migration 0182: one row per file the owner exported from the analytics hub (who, which table or report, which format and period, whether presentation mode was on, when). Written only by owner_analytics_record_export(); no API role may read or write it directly.';

alter table public.owner_analytics_exports enable row level security;
revoke all on table public.owner_analytics_exports from public, anon, authenticated, service_role;

create index if not exists owner_analytics_exports_created_idx on public.owner_analytics_exports (created_at desc);

-- The export route calls this BEFORE it builds the file, and builds nothing if it fails: an export nobody recorded is not produced.
create or replace function public.owner_analytics_record_export(
  p_what text, p_format text, p_from timestamptz, p_to timestamptz, p_present boolean
) returns bigint
  language plpgsql volatile security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_id bigint;
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if p_what is null or p_what !~ '^[a-z][a-z0-9_.-]{0,63}$' or p_format is null or p_format not in ('csv', 'xlsx', 'pdf')
     or p_from is null or p_to is null or p_to <= p_from or p_present is null then
    raise exception 'invalid export record' using errcode = '22023';
  end if;
  -- The actor is the session's own uid, never an argument: nobody records an export in another person's name.
  insert into public.owner_analytics_exports (actor_user_id, what, format, period_from, period_to, present_mode)
  values (auth.uid(), p_what, p_format, p_from, p_to, p_present)
  returning id into v_id;
  return v_id;
end
$$;

comment on function public.owner_analytics_record_export(text, text, timestamptz, timestamptz, boolean) is
  'Migration 0182: records one export from the owner analytics hub as the signed-in owner (actor pinned to auth.uid()) and returns its id. Platform owner only.';

revoke all on function public.owner_analytics_record_export(text, text, timestamptz, timestamptz, boolean) from public, anon, authenticated, service_role;
grant execute on function public.owner_analytics_record_export(text, text, timestamptz, timestamptz, boolean) to authenticated;

create or replace function public.owner_analytics_export_log(p_limit integer default 50)
  returns table (id bigint, actor_user_id uuid, what text, format text, period_from timestamptz, period_to timestamptz,
                 present_mode boolean, created_at timestamptz)
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  return query
  select e.id, e.actor_user_id, e.what, e.format, e.period_from, e.period_to, e.present_mode, e.created_at
    from public.owner_analytics_exports e
   order by e.created_at desc, e.id desc
   limit greatest(1, least(coalesce(p_limit, 50), 500));
end
$$;

comment on function public.owner_analytics_export_log(integer) is
  'Migration 0182: the newest owner analytics exports (at most 500). Platform owner only; read-only.';

revoke all on function public.owner_analytics_export_log(integer) from public, anon, authenticated, service_role;
grant execute on function public.owner_analytics_export_log(integer) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. End state
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  sig text;
  fn  oid;
begin
  foreach sig in array array[
    'public.owner_analytics_is_owner()',
    'public.owner_analytics_money(timestamp with time zone, timestamp with time zone)',
    'public.owner_analytics_people()',
    'public.owner_analytics_activity(timestamp with time zone, timestamp with time zone)',
    'public.owner_analytics_jobs(timestamp with time zone, timestamp with time zone)',
    'public.owner_analytics_record_export(text, text, timestamp with time zone, timestamp with time zone, boolean)',
    'public.owner_analytics_export_log(integer)'
  ] loop
    fn := to_regprocedure(sig);
    if fn is null then
      raise exception '0182 end state: % does not exist', sig;
    end if;
    if not has_function_privilege('authenticated', fn, 'EXECUTE')
       or has_function_privilege('anon', fn, 'EXECUTE')
       or has_function_privilege('service_role', fn, 'EXECUTE') then
      raise exception '0182 end state: % has the wrong grants', sig;
    end if;
    if exists (select 1 from pg_proc p where p.oid = fn
                and (not p.prosecdef or p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                     or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
      raise exception '0182 end state: % is not a SECURITY DEFINER with a fixed search_path, or PUBLIC may call it', sig;
    end if;
  end loop;

  fn := to_regprocedure('public.owner_analytics_sales_all()');
  if fn is null
     or has_function_privilege('authenticated', fn, 'EXECUTE')
     or has_function_privilege('anon', fn, 'EXECUTE')
     or has_function_privilege('service_role', fn, 'EXECUTE') then
    raise exception '0182 end state: owner_analytics_sales_all() is missing or an API role may call it';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.owner_analytics_exports'::regclass)
     or has_table_privilege('authenticated', 'public.owner_analytics_exports', 'SELECT')
     or has_table_privilege('anon', 'public.owner_analytics_exports', 'SELECT')
     or has_table_privilege('authenticated', 'public.owner_analytics_exports', 'INSERT') then
    raise exception '0182 end state: owner_analytics_exports is not closed to the API roles';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying, in the SQL editor, signed in as nobody: every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select to_regprocedure('public.owner_analytics_money(timestamptz, timestamptz)') is not null as has_money,
--        to_regclass('public.owner_analytics_exports') is not null as has_export_log,
--        not has_function_privilege('anon', 'public.owner_analytics_money(timestamptz, timestamptz)', 'EXECUTE') as anon_refused,
--        not has_function_privilege('authenticated', 'public.owner_analytics_sales_all()', 'EXECUTE') as helper_closed;
