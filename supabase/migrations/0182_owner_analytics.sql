-- 0182_owner_analytics.sql — the owner analytics hub's reads: money in, people, activity and jobs, plus the audit of every export.
-- docs/MIGRATIONS.md "0182", docs/OWNER_ANALYTICS.md.
--
-- *** LIVE ON APPLY, read-only except for its own two tables. *** It adds two tables (owner_analytics_exports and
-- owner_analytics_internal_orgs, both closed to every API role), ten functions and one index on dodo_checkout_nonces (consumed_by).
-- It replaces nothing, alters no existing column, policy or trigger, and writes no row of anyone
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
--   * Internal and test workspaces are returned with internal = true, so the app leaves them out of every figure by default (with
--     a toggle to include them) and still says how much it left out. Internal is: the operator's default workspace, any workspace
--     owned by an account on the platform roster (app_members), and any workspace the owner flagged by hand in
--     owner_analytics_internal_orgs (a demo or test account under another address). No workspace id is written in this file.
--   * Credits granted by the owner are never revenue: revenue is only what a payment provider's webhook recorded.
--   * No e-mail, name or customer id leaves this file. People are opaque uuids; payments are the provider's transaction id (the app
--     hides those in presentation mode).
--
-- WHO MAY CALL WHAT. Execute is granted to `authenticated` only (revoked from public, anon and service_role); each function checks
-- auth.uid() and platform_role() = 'owner' first and raises 42501 for anyone else. owner_analytics_sales_all() is internal: no API
-- role may execute it, only the functions here. search_path is pinned on every function. owner_analytics_exports has RLS on and no
-- policy: only owner_analytics_record_export() writes it (with the actor column pinned to auth.uid()), and only
-- owner_analytics_export_log() reads it. owner_analytics_internal_orgs likewise: only owner_analytics_set_internal() writes it
-- and owner_analytics_internal_list() reads it; owner_analytics_internal_org_ids() is internal like sales_all.
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
  if to_regclass('public.email_preferences') is null
     or not exists (select 1 from pg_attribute where attrelid = 'public.email_preferences'::regclass and attname = 'locale_chosen' and not attisdropped) then
    raise exception '0182 needs 0103 and 0105 (email_preferences.locale_chosen): apply them first';
  end if;
  if to_regclass('public.dodo_checkout_nonces') is null then
    raise exception '0182 needs 0146_dodo_payments.sql: apply it first';
  end if;
  if to_regprocedure('public.admin_aal_ok()') is null then
    raise exception '0182 needs 0107_owner_safety.sql (admin_aal_ok): apply it first';
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
-- 1b. Internal and test workspaces: never counted unless the owner asks to include them
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.owner_analytics_internal_orgs (
  org_id     uuid primary key references public.organizations (id) on delete cascade,
  reason     text not null check (length(btrim(reason)) between 1 and 200),
  flagged_by uuid not null,
  flagged_at timestamptz not null default now()
);

comment on table public.owner_analytics_internal_orgs is
  'Migration 0182: workspaces the owner marked as internal or test (a demo account, a QA workspace). The analytics hub leaves them out of every figure by default. Written only by owner_analytics_set_internal(); no API role reads or writes it directly.';

alter table public.owner_analytics_internal_orgs enable row level security;
revoke all on table public.owner_analytics_internal_orgs from public, anon, authenticated, service_role;

-- Internal: every workspace the figures leave out by default. Only the functions here call it.
create or replace function public.owner_analytics_internal_org_ids()
  returns setof uuid
  language sql stable security invoker set search_path = public, pg_temp
as $$
  select public.default_org_id()
  union
  select f.org_id from public.owner_analytics_internal_orgs f
  union
  -- A workspace owned by the operator's own team is the operator's testing, whatever address it was opened under. Owner and
  -- admin roles only: an admin may add anyone to the roster as a viewer, and that must not be a way to move a paying
  -- customer's revenue out of the owner's figures.
  select m.org_id from public.org_members m
    join public.app_members a on a.user_id = m.user_id and a.role in ('owner', 'admin')
   where m.role = 'owner' and m.user_id is not null
$$;

comment on function public.owner_analytics_internal_org_ids() is
  'Migration 0182 (internal): the workspaces the owner analytics hub treats as internal — the default workspace, those owned by a platform roster account, and those flagged in owner_analytics_internal_orgs. No API role may execute it.';

revoke all on function public.owner_analytics_internal_org_ids() from public, anon, authenticated, service_role;

create or replace function public.owner_analytics_set_internal(p_org uuid, p_internal boolean, p_reason text default null)
  returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  -- The platform's own second-factor gate (0107): with admin_aal2_required on, a password-only session must not take the
  -- business out of the building, nor change what counts as revenue. NS401 so the app can say "enter your code", not "forbidden".
  if not public.admin_aal_ok() then
    raise exception 'mfa_required' using errcode = 'NS401';
  end if;
  if p_org is null or p_internal is null then
    raise exception 'a workspace and a flag are required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'no such workspace' using errcode = '22023';
  end if;
  if p_internal then
    if p_reason is null or length(btrim(p_reason)) not between 1 and 200 then
      raise exception 'say why this workspace is internal (1 to 200 characters)' using errcode = '22023';
    end if;
    insert into public.owner_analytics_internal_orgs (org_id, reason, flagged_by)
    values (p_org, btrim(p_reason), auth.uid())
    on conflict (org_id) do update set reason = excluded.reason, flagged_by = excluded.flagged_by, flagged_at = now();
  else
    delete from public.owner_analytics_internal_orgs where org_id = p_org;
  end if;
  return p_internal;
end
$$;

comment on function public.owner_analytics_set_internal(uuid, boolean, text) is
  'Migration 0182: the owner marks a workspace internal / test (with a reason) or clears the mark. Changes only what the analytics hub counts by default; nothing about the workspace itself. Platform owner only.';

revoke all on function public.owner_analytics_set_internal(uuid, boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.owner_analytics_set_internal(uuid, boolean, text) to authenticated;

create or replace function public.owner_analytics_internal_list()
  returns table (org_id uuid, name text, source text, reason text, flagged_at timestamptz)
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  return query
  select o.id,
         o.name,
         case when o.id = public.default_org_id() then 'default'
              when f.org_id is not null then 'flag'
              else 'roster' end,
         f.reason,
         f.flagged_at
    from public.organizations o
    left join public.owner_analytics_internal_orgs f on f.org_id = o.id
   where o.id in (select public.owner_analytics_internal_org_ids())
   order by 3, o.name
   limit 500;
end
$$;

comment on function public.owner_analytics_internal_list() is
  'Migration 0182: the workspaces the analytics hub treats as internal, and why (default, roster-owned, or flagged with a reason). Platform owner only; read-only.';

revoke all on function public.owner_analytics_internal_list() from public, anon, authenticated, service_role;
grant execute on function public.owner_analytics_internal_list() to authenticated;

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
                -- An earlier billed period proves a renewal. No earlier one proves nothing (a fully discounted first period leaves
                -- no lot), so it is null — not "initial".
                case when exists (select 1 from public.credit_lots l2
                                   where l2.subscription_id = lot.subscription_id and l2.source = 'subscription'
                                     and l2.period_start < lot.period_start) then 'renewal' else null end
              else null end,
         p.currency,
         p.amount_minor,
         lot.period_start,
         lot.period_end,
         lot.subscription_id,
         coalesce(p.org_id = any (io.ids), false)
    from paid p
    cross join (select array(select public.owner_analytics_internal_org_ids()) as ids) io
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
     -- 'rejected' with an amount: the money went back to the customer, but the webhook could not size the credits to take
     -- back (a partial refund of an API top-up). The cash still left, so it is a refund here.
     where (e.status = 'processed' or (e.status = 'rejected' and e.amount_minor is not null))
       and e.transaction_id is not null
       and ((e.provider = 'dodo' and e.event_type in ('refund.succeeded', 'dispute.accepted', 'dispute.lost'))
            or (e.provider = 'paddle' and e.event_type in ('adjustment.created', 'adjustment.updated')))
     order by e.provider, coalesce(e.adjustment_id, e.event_id), (e.status = 'processed') desc, e.received_at desc, e.event_id
  ),
  uncredited as (
    -- Money that arrived but was not credited (a webhook decision of 'rejected': a plan change, a discount it could not size,
    -- another currency, bad metadata). Real cash, so it is returned — as its own event, never folded into credited sales, and
    -- only when the same payment was not credited under another delivery.
    select distinct on (e.provider, e.transaction_id)
           e.provider, e.transaction_id, coalesce(e.occurred_at, e.received_at) as at, e.org_id, e.currency, e.amount_minor
      from public.payment_events e
     where ((e.provider = 'dodo' and e.event_type = 'payment.succeeded')
            or (e.provider = 'paddle' and e.event_type = 'transaction.completed'))
       and e.status = 'rejected'
       and e.transaction_id is not null
       and (e.amount_minor is null or e.amount_minor > 0)
       and not exists (select 1 from public.payment_events c
                        where c.provider = e.provider and c.transaction_id = e.transaction_id
                          and c.event_type = e.event_type and c.status in ('processed', 'duplicate'))
     order by e.provider, e.transaction_id, e.received_at, e.event_id
  ),
  io as (select array(select public.owner_analytics_internal_org_ids()) as ids)
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
   where b.at >= p_from and b.at < p_to
  union all
  select 'uncredited'::text, u.at, u.provider, u.transaction_id, u.org_id, 'unknown'::text, null::text, null::text, u.currency,
         u.amount_minor, null::bigint, null::timestamptz, null::timestamptz, null::bigint,
         coalesce(u.org_id = any (io.ids), false)
    from uncredited u, io
   where u.at >= p_from and u.at < p_to
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
    confirmed           boolean,
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

  -- Each milestone is one grouped scan joined by hash, not a subquery per person: per-person min() over unindexed columns is
  -- people x jobs row visits, which times out long before the business is large.
  return query
  with io as (select array(select public.owner_analytics_internal_org_ids()) as ids),
  sales as (select * from public.owner_analytics_sales_all() s where not s.internal),
  owned as (
    -- A payment is a workspace's; a person is its payer when they own it (one person per workspace since 0091).
    select m.user_id, s.at, s.kind, s.item
      from public.org_members m
      join sales s on s.org_ref = m.org_id
     where m.role = 'owner' and m.user_id is not null
  ),
  pay  as (select o.user_id, min(o.at) as at from owned o group by o.user_id),
  plan as (select distinct on (o.user_id) o.user_id, o.item from owned o where o.kind = 'plan' order by o.user_id, o.at),
  gen  as (select j.requested_by as uid, min(j.created_at) as at from public.creative_jobs j
            where j.requested_by is not null group by j.requested_by),
  proj as (select p.created_by as uid, min(p.created_at) as at from public.editor_projects p
            where p.created_by is not null group by p.created_by),
  expo as (select x.requested_by as uid, min(x.finished_at) as at from public.editor_exports x
            where x.status = 'done' group by x.requested_by),
  ref  as (select r.invitee_id as uid from public.referral_rewards r group by r.invitee_id),
  inv  as (select f.invitee_id as uid from public.friend_invite_joins f group by f.invitee_id),
  roster as (select a.user_id as uid from public.app_members a
              where a.user_id is not null and a.role in ('owner', 'admin') group by a.user_id),
  internal_owner as (select m.user_id as uid from public.org_members m, io
                      where m.role = 'owner' and m.user_id is not null and m.org_id = any (io.ids) group by m.user_id)
  select u.id,
         u.created_at,
         -- An unconfirmed address is a signup attempt, not a person: returned, so the page counts confirmed signups only.
         u.email_confirmed_at is not null,
         u.last_sign_in_at,
         -- Only a language the person chose: the column defaults to 'en' for rows other code created, which is not a choice.
         case when ep.locale_chosen then ep.locale end,
         -- What is recorded, and only that: no UTM or signup-source field exists, so everyone else is null ("not recorded").
         case when ref.uid is not null then 'referral' when inv.uid is not null then 'invite' else null end,
         -- On the roster, or the owner of an internal workspace (a demo account under another address).
         roster.uid is not null or internal_owner.uid is not null,
         proj.at,
         gen.at,
         expo.at,
         pay.at,
         plan.item
    from auth.users u
    left join public.email_preferences ep on ep.user_id = u.id
    left join pay on pay.user_id = u.id
    left join plan on plan.user_id = u.id
    left join gen on gen.uid = u.id
    left join proj on proj.uid = u.id
    left join expo on expo.uid = u.id
    left join ref on ref.uid = u.id
    left join inv on inv.uid = u.id
    left join roster on roster.uid = u.id
    left join internal_owner on internal_owner.uid = u.id
   order by u.created_at, u.id
   limit 100000;
end
$$;

comment on function public.owner_analytics_people() is
  'Migration 0182: one row per person (an opaque id, never an e-mail): signup, whether the address is confirmed, last sign-in, locale, acquisition when recorded (referral / invite, else null), whether they are on the platform roster, and when they first made a project, a generation, an export and a payment, and their first plan. At most 100000 rows. Platform owner only; read-only.';

revoke all on function public.owner_analytics_people() from public, anon, authenticated, service_role;
grant execute on function public.owner_analytics_people() to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Activity: who did something, on which Tashkent day
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.owner_analytics_activity(p_from timestamptz, p_to timestamptz)
  returns table (day date, user_ref uuid, internal boolean)
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

  -- "Active" is an act that left a row: a generation asked for, a project made, an export asked for. Sign-ins are not counted:
  -- auth.users keeps only the LAST one, so each new sign-in would erase the person's earlier active day from history. A page view
  -- is not here either (site_page_views holds no person), so DAU here is "people who made something", and the page says so.
  return query
  with io as (select array(select public.owner_analytics_internal_org_ids()) as ids)
  select d.day, d.uid,
         -- The roster and the owners of internal workspaces: returned flagged, so the hub leaves them out unless asked.
         exists (select 1 from public.app_members m where m.user_id = d.uid and m.role in ('owner', 'admin'))
           or exists (select 1 from public.org_members om, io
                       where om.user_id = d.uid and om.role = 'owner' and om.org_id = any (io.ids))
    from (select distinct (a.at at time zone 'Asia/Tashkent')::date as day, a.uid
    from (
      select j.created_at as at, j.requested_by as uid from public.creative_jobs j
       where j.created_at >= p_from and j.created_at < p_to and j.requested_by is not null
      union all
      select p.created_at, p.created_by from public.editor_projects p
       where p.created_at >= p_from and p.created_at < p_to and p.created_by is not null
      union all
      select x.created_at, x.requested_by from public.editor_exports x
       where x.created_at >= p_from and x.created_at < p_to
    ) a) d
   order by 1, 2
   limit 200000;
end
$$;

comment on function public.owner_analytics_activity(timestamptz, timestamptz) is
  'Migration 0182: distinct (Tashkent day, person) pairs in [p_from, p_to) where the person asked for a generation, made a project, or asked for an export, each flagged internal when the person is on the roster or owns an internal workspace. At most 400 days and 200000 rows. Platform owner only; read-only.';

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
    credits_counted bigint,
    seconds_total   numeric,
    seconds_counted bigint
  )
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_internal uuid[];
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '1100 days' then
    raise exception 'a window is a start before its end, at most 1100 days' using errcode = '22023';
  end if;
  v_internal := array(select public.owner_analytics_internal_org_ids());

  return query
  select (j.created_at at time zone 'Asia/Tashkent')::date,
         j.kind,
         j.capability,
         coalesce(j.routed_model, j.requested_model),
         j.status,
         j.payer,
         coalesce(j.org_id = any (v_internal), false),
         count(*),
         -- Credits a job was actually charged; a job that was never charged adds nothing (sum ignores the null).
         coalesce(sum(j.charged_credits), 0),
         -- How many jobs carry a charge at all: a running or API-paid job has none, and must not read as a free one.
         count(j.charged_credits),
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
revoke all on sequence public.owner_analytics_exports_id_seq from public, anon, authenticated, service_role;

-- The one index this file adds to an existing table: the sale classifier looks a Dodo payment's checkout up by the payment that
-- spent it, which had no index. dodo_checkout_nonces is small (one row per opened checkout), so building it here is quick.
create index if not exists dodo_checkout_nonces_consumed_by_idx on public.dodo_checkout_nonces (consumed_by) where consumed_by is not null;

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
  -- The platform's own second-factor gate (0107): with admin_aal2_required on, a password-only session must not take the
  -- business out of the building, nor change what counts as revenue. NS401 so the app can say "enter your code", not "forbidden".
  if not public.admin_aal_ok() then
    raise exception 'mfa_required' using errcode = 'NS401';
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
    'public.owner_analytics_export_log(integer)',
    'public.owner_analytics_set_internal(uuid, boolean, text)',
    'public.owner_analytics_internal_list()'
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

  fn := to_regprocedure('public.owner_analytics_internal_org_ids()');
  if fn is null
     or has_function_privilege('authenticated', fn, 'EXECUTE')
     or has_function_privilege('anon', fn, 'EXECUTE')
     or has_function_privilege('service_role', fn, 'EXECUTE') then
    raise exception '0182 end state: owner_analytics_internal_org_ids() is missing or an API role may call it';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.owner_analytics_internal_orgs'::regclass)
     or has_table_privilege('authenticated', 'public.owner_analytics_internal_orgs', 'SELECT')
     or has_table_privilege('authenticated', 'public.owner_analytics_internal_orgs', 'INSERT') then
    raise exception '0182 end state: owner_analytics_internal_orgs is not closed to the API roles';
  end if;

  fn := to_regprocedure('public.owner_analytics_sales_all()');
  if fn is null
     or has_function_privilege('authenticated', fn, 'EXECUTE')
     or has_function_privilege('anon', fn, 'EXECUTE')
     or has_function_privilege('service_role', fn, 'EXECUTE') then
    raise exception '0182 end state: owner_analytics_sales_all() is missing or an API role may call it';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.owner_analytics_exports'::regclass)
     or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r,
                              unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) pr,
                              unnest(array['public.owner_analytics_exports', 'public.owner_analytics_internal_orgs']) t
                 where has_table_privilege(r, t, pr)) then
    raise exception '0182 end state: owner_analytics_exports or owner_analytics_internal_orgs is not closed to the API roles';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying, in the SQL editor, signed in as nobody: every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select to_regprocedure('public.owner_analytics_money(timestamptz, timestamptz)') is not null as has_money,
--        to_regclass('public.owner_analytics_exports') is not null as has_export_log,
--        not has_function_privilege('anon', 'public.owner_analytics_money(timestamptz, timestamptz)', 'EXECUTE') as anon_refused,
--        not has_function_privilege('authenticated', 'public.owner_analytics_sales_all()', 'EXECUTE') as helper_closed;
