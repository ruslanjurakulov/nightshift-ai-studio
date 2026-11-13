-- 0157_dodo_purchase_history.sql — the Credits page's purchase history (invoices), from the platform's own record of what a
-- Dodo payment credited. Read-only. docs/MIGRATIONS.md "0157".
--
-- *** LIVE ON APPLY, read-only. *** It adds ONE function and nothing else: no table, column, row, index, policy or trigger, and it
-- replaces nothing. Nothing calls it until the Command Center sells through Dodo (PAYMENTS_PROVIDER=dodo).
--
-- WHY. An owner who bought credits wants the list Ideogram's billing page shows: each payment, what it bought, when, for how much,
-- whether it was refunded, and its invoice. Everything the platform knows about a payment is in payment_events (0021), which no API
-- role may read (it holds every organization's webhook outcomes), so the Command Center, which uses the member's own session and
-- the ANON key only, cannot list it. This function hands an owner or admin of ONE organization the rows of THEIR organization's
-- credited Dodo payments, and only these columns. The invoice PDF itself is Dodo's (Merchant of Record) and is fetched by the
-- Command Center's server from Dodo on demand, after this function has said the payment is this organization's.
--
-- WHAT ONE ROW SAYS (one per Dodo payment that credited this organization; newest first; at most 100)
--   payment_id      Dodo's payment id (pay_…), the external id the credits were booked under.
--   item            what the checkout signed: 'pack:<id>' (a pack), 'pack:amount_<cents>' (a typed amount), from the checkout nonce the
--                   payment spent (0146); 'plan' for a plan period (booked as a 'subscription' ledger row); null when neither is
--                   known (the page writes "—", never a guess).
--   credits         the credits the webhook recorded for it.
--   amount_minor    what Dodo reported as charged, in the currency's smallest unit, tax included (total_amount); currency with it.
--   paid_at         when Dodo says the event occurred, else when the platform received it.
--   refunded_minor  the sum of processed refunds of this payment that carry an amount in the same currency (0 when none).
--   refund_unsized  true when a processed refund carries no amount, or another currency: the page then says "refund recorded",
--                   never "partly" or "fully".
--   chargeback      true when a lost or accepted dispute took the credits back.
-- Payments that were rejected, ignored or are still failing (paid but not credited: a person's case, docs/DODO_SETUP.md
-- "Kuzatish") are NOT here: this is a history of what was bought and credited, and saying "paid" of one would be a claim we did
-- not book.
--
-- WHO MAY CALL IT, AND WHAT IT REVEALS. SECURITY DEFINER (payment_events and dodo_checkout_nonces are closed to every API role).
-- The caller must be signed in (auth.uid()) and an owner or admin of p_org (is_org_member(p_org, 'admin'), 0018: the same bar as
-- buying, dodo_issue_checkout_nonce): a member, a viewer, another organization's owner and anon get 42501 and read nothing. It
-- returns only the columns above: never the event id, detail text, user id, customer, e-mail or anything of another organization.
-- Execute is granted to `authenticated` only (revoked from public, anon and service_role). search_path is pinned. It writes,
-- prices, spends and starts nothing.
--
-- INPUT. p_org: the organization. p_payment: null for the list, or one payment id (^pay_[A-Za-z0-9]{3,64}$, else 22023 and nothing
-- is read): the invoice route asks "is this payment this organization's?" this way before it calls Dodo.
--
-- THE APP WITHOUT THIS FILE. The Credits page calls it only while Dodo sells; a missing function (42883 / PGRST202) leaves the
-- history panel saying the history needs this migration, and any other error says it could not be read. The invoice route answers
-- "not available" without calling Dodo.
--
-- REQUIRES 0018 (is_org_member), 0021 (payment_events), 0034 (the 'subscription' ledger kind) and 0146 (dodo_checkout_nonces).
-- Additive and idempotent: create-or-replace of a function that did not exist; a replay changes nothing. Undo:
-- docs/sql/rollback_0157_dodo_purchase_history.sql (owner-applied).
--
-- NUMBER. 0157 (first written as 0154). 0155 (#728) and 0156 (claude/named-resolution-params) are held by other work, and the
-- Supabase integration refuses a number below the latest applied one. It names no object of 0147 to 0153 (0155 and 0156 are not on
-- this branch; it creates one new function and replaces nothing, so it cannot collide with them unless they create the same name).
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; the SQL editor on the live project). Expected: one row, all true.
--   select to_regprocedure('public.dodo_purchase_history(uuid, text)') is null as function_is_new,
--          to_regprocedure('public.is_org_member(uuid, text)') is not null as has_0018,
--          to_regclass('public.payment_events') is not null as has_0021,
--          to_regclass('public.dodo_checkout_nonces') is not null as has_0146;
--
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regprocedure('public.is_org_member(uuid, text)') is null then
    raise exception '0157 needs 0018_organizations.sql: apply it first';
  end if;
  if to_regclass('public.payment_events') is null then
    raise exception '0157 needs 0021_credit_refunds.sql: apply it first';
  end if;
  if to_regclass('public.dodo_checkout_nonces') is null then
    raise exception '0157 needs 0146_dodo_payments.sql: apply it first';
  end if;
  -- The one name this file creates: absent, or this file's own body (a replay).
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.dodo_purchase_history(uuid, text)');
  if h is not null and h <> '83396f8724ca4968b7c56f2297aa0830' then
    raise exception '0157 found public.dodo_purchase_history(uuid, text) with a body that is not this file''s (md5 %): read the live body first', h;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. One organization's credited Dodo payments
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.dodo_purchase_history(p_org uuid, p_payment text default null)
  returns table (
    payment_id     text,
    item           text,
    credits        numeric,
    amount_minor   bigint,
    currency       text,
    paid_at        timestamptz,
    refunded_minor bigint,
    refund_unsized boolean,
    chargeback     boolean
  )
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_org is null or not public.is_org_member(p_org, 'admin') then
    raise exception 'only an owner or admin of the organization reads its purchases' using errcode = '42501';
  end if;
  if p_payment is not null and p_payment !~ '^pay_[A-Za-z0-9]{3,64}$' then
    raise exception 'invalid payment id' using errcode = '22023';
  end if;

  return query
    with credited as (
      -- One row per payment: the same payment delivered under a second webhook id is recorded 'duplicate'; the 'processed' one,
      -- which carries the credits, wins.
      select distinct on (e.transaction_id)
             e.transaction_id,
             e.credits,
             e.amount_minor,
             e.currency,
             coalesce(e.occurred_at, e.received_at) as at
        from public.payment_events e
       where e.provider = 'dodo'
         and e.event_type = 'payment.succeeded'
         and e.status in ('processed', 'duplicate')
         and e.org_id = p_org
         and e.transaction_id is not null
         and (p_payment is null or e.transaction_id = p_payment)
       order by e.transaction_id, (e.status = 'processed') desc, e.received_at, e.event_id
    )
    select c.transaction_id,
           coalesce(
             -- What the checkout signed (0146: the nonce a pack or typed-amount payment spends names its consumer, the payment).
             (select n.item from public.dodo_checkout_nonces n
               where n.org_id = p_org and n.consumed_by = c.transaction_id
               order by n.consumed_at limit 1),
             -- A plan period spends no nonce of its own (the subscription did); its credits are a 'subscription' ledger row.
             (select 'plan'::text from public.credit_transactions t
               where t.org_id = p_org and t.external_id = c.transaction_id and t.kind = 'subscription' limit 1)),
           c.credits,
           c.amount_minor,
           c.currency,
           c.at,
           coalesce(rf.refunded, 0)::bigint,
           coalesce(rf.unsized, false),
           coalesce(rf.chargeback, false)
      from credited c
      left join lateral (
        select sum(r.amount_minor) filter (where r.event_type = 'refund.succeeded' and r.amount_minor is not null
                                             and r.currency is not distinct from c.currency) as refunded,
               bool_or(r.event_type = 'refund.succeeded' and (r.amount_minor is null or r.currency is distinct from c.currency)) as unsized,
               bool_or(r.event_type in ('dispute.accepted', 'dispute.lost')) as chargeback
          from public.payment_events r
         where r.provider = 'dodo'
           and r.transaction_id = c.transaction_id
           and r.status = 'processed'
           and r.event_type in ('refund.succeeded', 'dispute.accepted', 'dispute.lost')
      ) rf on true
     order by c.at desc, c.transaction_id desc
     limit 100;
end
$$;

comment on function public.dodo_purchase_history(uuid, text) is
  'Migration 0157: an owner or admin''s list of the Dodo payments that credited their organization (payment id, signed item, credits, amount charged incl. tax, when, refunds, chargeback), newest first, at most 100; or one payment by id. Read-only; nothing of another organization. The Credits page''s purchase history and the invoice route''s ownership check.';

revoke all on function public.dodo_purchase_history(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.dodo_purchase_history(uuid, text) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. End state
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  fn oid := to_regprocedure('public.dodo_purchase_history(uuid, text)');
begin
  if fn is null then
    raise exception '0157 end state: public.dodo_purchase_history(uuid, text) does not exist';
  end if;
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = fn) is distinct from '83396f8724ca4968b7c56f2297aa0830' then
    raise exception '0157 end state: public.dodo_purchase_history(uuid, text) does not hold the body this file expects';
  end if;
  if not has_function_privilege('authenticated', fn, 'EXECUTE')
     or has_function_privilege('anon', fn, 'EXECUTE')
     or has_function_privilege('service_role', fn, 'EXECUTE') then
    raise exception '0157 end state: public.dodo_purchase_history(uuid, text) has the wrong grants';
  end if;
  if exists (select 1 from pg_proc p where p.oid = fn
              and (not p.prosecdef or p.provolatile <> 's' or p.proacl is null
                   or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                   or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
    raise exception '0157 end state: public.dodo_purchase_history(uuid, text) is not a stable SECURITY DEFINER with a fixed search_path, or PUBLIC may call it';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying, in the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select p.prosecdef as security_definer,
--        p.provolatile = 's' as read_only,
--        p.proconfig @> array['search_path=public, pg_temp'] as search_path_pinned,
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') as signed_in_may_call,
--        not has_function_privilege('anon', p.oid, 'EXECUTE') and not has_function_privilege('service_role', p.oid, 'EXECUTE') as anon_and_service_cannot
--   from pg_proc p
--  where p.oid = 'public.dodo_purchase_history(uuid, text)'::regprocedure;
--
-- What an owner would be shown (the SQL editor runs as postgres, which has no auth.uid(): read the rows directly instead).
-- select transaction_id, status, credits, amount_minor, currency, coalesce(occurred_at, received_at) as at
--   from public.payment_events
--  where provider = 'dodo' and event_type = 'payment.succeeded' and status in ('processed', 'duplicate')
--  order by at desc limit 20;
