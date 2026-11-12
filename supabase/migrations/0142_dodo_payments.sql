-- 0142_dodo_payments.sql — lets the payment tables and the two subscription functions carry a second provider, Dodo Payments.
-- Owner decision 2026-11-12: take payments through Dodo Payments (Merchant of Record); Paddle declined the account. docs/DODO_SETUP.md.
--
-- *** LIVE ON APPLY, AND CHANGES NOTHING FOR PADDLE. *** No row is written or changed. Nothing calls the new names until the
-- dodo-webhook Edge Function is deployed with its secrets, and no customer reaches a Dodo checkout until the Command Center's
-- PAYMENTS_PROVIDER is `dodo` (default `paddle`). The Paddle webhook keeps calling the two functions it always called, with the
-- same arguments, and gets the same answer: each is now one line that calls its provider-aware twin with 'paddle', and the twin
-- is 0034's body plus the hunks listed below (tests/test_dodo_payments_migration.py takes the hunks out and compares byte for byte).
--
-- WHAT IT CHANGES
--   payment_events_provider_check            'paddle' -> 'paddle' or 'dodo'. The webhook audit row of each provider; (provider, event_id)
--                                            stays the primary key, so a Dodo webhook-id can never collide with a Paddle event id.
--   subscriptions_provider_check             'paddle' -> 'paddle' or 'dodo'.
--   subscriptions_provider_subscription_id_check / _provider_customer_id_check / _price_id_check
--                                            each id's shape now depends on the row's provider. A Paddle row must match EXACTLY the
--                                            0034 pattern it matched before (sub_ / ctm_ / pri_ + 10-40 lowercase alphanumerics). A Dodo
--                                            row: sub_ / cus_ / pdt_ + 3-64 ASCII letters and digits (Dodo's documented examples are
--                                            mixed case: sub_Iuaq622bbmmfOGrVTqdXv, cus_TV52uJWWXt2yIoBBxpjaa, pdt_0NVbdIG3JNg9Yc8ey5JHW).
--                                            price_id holds the Dodo PRODUCT id (Dodo has no separate price object).
-- WHAT IT ADDS (service role only, like the functions they generalise)
--   upsert_subscription_for(provider, ...)   0034's upsert_subscription body with: the provider checked ('paddle' | 'dodo', else
--                                            22023), the row looked up and inserted under that provider, and the advisory lock keyed
--                                            'subscription:<id>' for Paddle (unchanged) and 'subscription:dodo:<id>' for Dodo.
--   grant_subscription_credits_for(provider, ...)
--                                            0034's grant_subscription_credits body with the same four hunks. The credit ledger, the
--                                            lots, the pro-rata top-up, the period-over rule and the idempotency on the external id are
--                                            the same lines: there is ONE body for both providers.
-- WHAT IT REPLACES (md5 drift guard: 0034's body, or this file's own on a replay)
--   upsert_subscription(...)                 -> select upsert_subscription_for('paddle', <the same arguments>)
--   grant_subscription_credits(...)          -> select grant_subscription_credits_for('paddle', <the same arguments>)
--   Their signatures, defaults, grants (service_role only), SECURITY DEFINER and pinned search_path stay as 0034 made them.
-- NOT CHANGED: add_purchased_credits, refund_purchased_credits, record_payment_event (they never named a provider in a way Dodo needs
-- changed: record_payment_event takes the provider as an argument and the check above now admits 'dodo'), the ledger, the lots, RLS.
-- NOT COVERED YET (docs/DODO_SETUP.md, "Before you switch"): the margin report (0063) and the operator's Customers page (0138) read
-- paid amounts from Paddle rows only, so a Dodo payment shows there as not knowable / not counted until a follow-up migration.
--
-- NUMBER. 0142: 0140 and 0141 are taken by other work in progress; this file names nothing of theirs. Needs 0021 and 0034.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; md5 of the body with every run of white space read as one space):
--   select p.oid::regprocedure, md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc p
--    where proname in ('upsert_subscription', 'grant_subscription_credits', 'upsert_subscription_for', 'grant_subscription_credits_for');
--   expected BEFORE (0034): upsert_subscription 60ee6ad3764dbcf6762b178f8240d5a9 · grant_subscription_credits 7947d46697f1c35d12274ffbe22709ac
--   expected AFTER:         upsert_subscription 09185a96a8fb02f0c2641095d51461cc · grant_subscription_credits fd0c1c169a4d3b2d05c6d826c6fe10ff
--                           upsert_subscription_for 9f9b399ce3ca3421d1ccb32c4075d6ea · grant_subscription_credits_for 5424905376fab9ff1b4c229c5dc0c0ce
-- Undo: docs/sql/rollback_0142_dodo_payments.sql (owner-applied; refuses while any Dodo row exists).

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  h text;
  trio text[];
begin
  if to_regclass('public.payment_events') is null or to_regclass('public.subscriptions') is null
     or to_regprocedure('public.record_payment_event(text, text, text, timestamptz, text, text, uuid, text, text, numeric, text, bigint)') is null
     or to_regprocedure('public.refund_purchased_credits(text, text, numeric, text, text)') is null then
    raise exception '0142 needs payment events and plans: apply 0021_credit_refunds.sql and 0034_plans_entitlements.sql first';
  end if;
  -- Each function this file replaces: 0034's body, or this file's own (a replay).
  foreach trio slice 1 in array array[
      ['public.upsert_subscription(uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz)',
       '60ee6ad3764dbcf6762b178f8240d5a9', '09185a96a8fb02f0c2641095d51461cc'],
      ['public.grant_subscription_credits(uuid, text, text, timestamptz, timestamptz, text, text, text, text, numeric)',
       '7947d46697f1c35d12274ffbe22709ac', 'fd0c1c169a4d3b2d05c6d826c6fe10ff']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(trio[1]);
    if h is null or h <> all (array[trio[2], trio[3]]) then
      raise exception '0142 found % with a body that is neither 0034''s nor 0142''s (md5 %): read the live body first', trio[1], h;
    end if;
  end loop;
  -- Each name this file creates: absent, or this file's own body.
  foreach trio slice 1 in array array[
      ['public.upsert_subscription_for(text, uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz)',
       '9f9b399ce3ca3421d1ccb32c4075d6ea', ''],
      ['public.grant_subscription_credits_for(text, uuid, text, text, timestamptz, timestamptz, text, text, text, text, numeric)',
       '5424905376fab9ff1b4c229c5dc0c0ce', '']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(trio[1]);
    if h is not null and h <> trio[2] then
      raise exception '0142 found % with a body that is not this file''s (md5 %): read the live body first', trio[1], h;
    end if;
  end loop;
  -- What it builds on and leaves alone: the ledger's two money functions and the audit write, as the repo has them.
  foreach trio slice 1 in array array[
      ['public.add_purchased_credits(uuid, numeric, text, text)', 'b331d54dfbae652b3cd047a599370373', ''],
      ['public.refund_purchased_credits(text, text, numeric, text, text)', '766daf507d4e70711b8622aebbea7705', ''],
      ['public.record_payment_event(text, text, text, timestamptz, text, text, uuid, text, text, numeric, text, bigint)',
       '2e6e988bdffe612dacba03baaaf525ec', '']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(trio[1]);
    if h is distinct from trio[2] then
      raise exception '0142 found % with a body that is not the one it was written against (md5 %): read the live body first', trio[1], h;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The provider checks
-- ───────────────────────────────────────────────────────────────────────────

alter table public.payment_events drop constraint if exists payment_events_provider_check;
alter table public.payment_events add constraint payment_events_provider_check
  check (provider in ('paddle', 'dodo'));

alter table public.subscriptions drop constraint if exists subscriptions_provider_check;
alter table public.subscriptions add constraint subscriptions_provider_check
  check (provider in ('paddle', 'dodo'));
-- A Paddle row keeps 0034's exact pattern: nothing a Paddle event could write before is refused, and nothing new is admitted for it.
alter table public.subscriptions drop constraint if exists subscriptions_provider_subscription_id_check;
alter table public.subscriptions add constraint subscriptions_provider_subscription_id_check
  check ((provider = 'paddle' and provider_subscription_id ~ '^sub_[a-z0-9]{10,40}$')
         or (provider = 'dodo' and provider_subscription_id ~ '^sub_[A-Za-z0-9]{3,64}$'));
alter table public.subscriptions drop constraint if exists subscriptions_provider_customer_id_check;
alter table public.subscriptions add constraint subscriptions_provider_customer_id_check
  check (provider_customer_id is null
         or (provider = 'paddle' and provider_customer_id ~ '^ctm_[a-z0-9]{10,40}$')
         or (provider = 'dodo' and provider_customer_id ~ '^cus_[A-Za-z0-9]{3,64}$'));
alter table public.subscriptions drop constraint if exists subscriptions_price_id_check;
alter table public.subscriptions add constraint subscriptions_price_id_check
  check (price_id is null
         or (provider = 'paddle' and price_id ~ '^pri_[a-z0-9]{10,40}$')
         or (provider = 'dodo' and price_id ~ '^pdt_[A-Za-z0-9]{3,64}$'));

comment on table public.subscriptions is
  'Subscriptions of a payment provider (0034 Paddle; 0142 also Dodo Payments), one row each, kept in step by that provider''s webhook (service role). A live status (active, trialing, past_due) gives the organization its plan''s entitlements; credits come only from paid transactions (grant_subscription_credits_for). price_id is the provider''s price (Paddle pri_) or product (Dodo pdt_). Ids only: no card or personal data.';
comment on table public.payment_events is
  'Webhook events received from a payment provider (migration 0021; 0142 adds dodo), one row per (provider, event id): the outcome and why. rejected = paid but not credited (unknown organization, price or amount) — needs a person; failed = will be retried by the provider. Ids and amounts only; no personal or card data.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. One body per subscription function, for every provider
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.upsert_subscription_for(
  p_provider text, p_org uuid, p_subscription_id text, p_customer_id text, p_plan text, p_price_id text,
  p_status text, p_period_start timestamptz, p_period_end timestamptz,
  p_cancel_at_period_end boolean, p_canceled_at timestamptz, p_occurred_at timestamptz
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s public.subscriptions;
begin
  if not public.credits_trusted_caller() then
    raise exception 'subscriptions are recorded by the platform only' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('paddle', 'dodo') then
    raise exception 'unknown payment provider %', p_provider using errcode = '22023';
  end if;
  if p_org is null or not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'unknown organization' using errcode = '22023';
  end if;
  if p_plan is not null and not exists (select 1 from public.plans where id = p_plan) then
    raise exception 'unknown plan %', p_plan using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('active', 'trialing', 'past_due', 'paused', 'canceled') then
    raise exception 'unknown subscription status %', p_status using errcode = '22023';
  end if;

  -- One decision per subscription at a time.
  perform pg_advisory_xact_lock(hashtextextended('subscription:' || case when p_provider = 'paddle' then '' else p_provider || ':' end
                                           || coalesce(p_subscription_id, ''), 0));
  select * into s from public.subscriptions
   where provider = p_provider and provider_subscription_id = p_subscription_id
   for update;
  if found then
    if s.org_id <> p_org then
      raise exception 'subscription already recorded for another organization' using errcode = '23505';
    end if;
    if s.last_event_at is not null and p_occurred_at is not null and p_occurred_at < s.last_event_at then
      return jsonb_build_object('id', s.id, 'stale', true, 'status', s.status, 'plan', s.plan_id);
    end if;
    update public.subscriptions
       set provider_customer_id = coalesce(p_customer_id, provider_customer_id),
           plan_id = coalesce(p_plan, plan_id),
           price_id = coalesce(p_price_id, price_id),
           status = p_status,
           current_period_start = coalesce(p_period_start, current_period_start),
           current_period_end = coalesce(p_period_end, current_period_end),
           cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
           canceled_at = coalesce(p_canceled_at, canceled_at),
           last_event_at = coalesce(p_occurred_at, last_event_at),
           updated_at = now()
     where id = s.id
    returning * into s;
  else
    if p_plan is null then
      raise exception 'a new subscription needs a known plan' using errcode = '22023';
    end if;
    insert into public.subscriptions
      (provider, org_id, provider_subscription_id, provider_customer_id, plan_id, price_id, status,
       current_period_start, current_period_end, cancel_at_period_end, canceled_at, last_event_at)
    values
      (p_provider, p_org, p_subscription_id, p_customer_id, p_plan, p_price_id, p_status,
       p_period_start, p_period_end, coalesce(p_cancel_at_period_end, false), p_canceled_at, p_occurred_at)
    returning * into s;
  end if;
  return jsonb_build_object('id', s.id, 'stale', false, 'status', s.status, 'plan', s.plan_id);
end
$$;

create or replace function public.grant_subscription_credits_for(
  p_provider text, p_org uuid, p_subscription_id text, p_plan text, p_period_start timestamptz, p_period_end timestamptz,
  p_external_id text, p_note text default null, p_customer_id text default null, p_price_id text default null,
  p_paid_share numeric default 1
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ext   text := btrim(coalesce(p_external_id, ''));
  plan_ public.plans;
  s     public.subscriptions;
  lot   public.credit_lots;
  acc   public.credit_accounts;
  prior public.credit_transactions;
  add_  numeric := 0;
  frac  numeric;
  txn   bigint;
  lid   bigint;
begin
  if not public.credits_trusted_caller() then
    raise exception 'subscription credits are granted by the platform only' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('paddle', 'dodo') then
    raise exception 'unknown payment provider %', p_provider using errcode = '22023';
  end if;
  if ext = '' or length(ext) > 200 then
    raise exception 'external_id is required' using errcode = '22023';
  end if;
  select * into plan_ from public.plans where id = p_plan;
  if not found then
    raise exception 'unknown plan %', p_plan using errcode = '22023';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    raise exception 'a billing period needs a start before its end' using errcode = '22023';
  end if;
  if p_paid_share is null or p_paid_share < 0 or p_paid_share > 1 then
    raise exception 'paid share must be between 0 and 1' using errcode = '22023';
  end if;

  acc := public.credit_account_lock(p_org);
  perform pg_advisory_xact_lock(hashtextextended('subscription:' || case when p_provider = 'paddle' then '' else p_provider || ':' end
                                           || coalesce(p_subscription_id, ''), 0));

  select * into prior from public.credit_transactions where external_id = ext;
  if found then
    if prior.org_id <> p_org or prior.kind <> 'subscription' then
      raise exception 'external_id already recorded for something else' using errcode = '23505';
    end if;
    return jsonb_build_object('duplicate', true, 'granted', 0, 'transaction_id', prior.id,
                              'balance', acc.balance, 'available', acc.balance - acc.reserved);
  end if;

  select * into s from public.subscriptions
   where provider = p_provider and provider_subscription_id = p_subscription_id
   for update;
  if not found then
    insert into public.subscriptions
      (provider, org_id, provider_subscription_id, provider_customer_id, plan_id, price_id, status,
       current_period_start, current_period_end)
    values (p_provider, p_org, p_subscription_id, p_customer_id, p_plan, p_price_id, 'active', p_period_start, p_period_end)
    returning * into s;
  elsif s.org_id <> p_org then
    raise exception 'subscription already recorded for another organization' using errcode = '23505';
  end if;

  if p_period_end <= now() then
    return jsonb_build_object('duplicate', false, 'granted', 0, 'reason', 'period_over',
                              'balance', acc.balance, 'available', acc.balance - acc.reserved);
  end if;

  select * into lot from public.credit_lots
   where subscription_id = s.id and source = 'subscription' and period_end = p_period_end
   for update;
  if not found then
    -- Rounded down to the cent: a discount never rounds into extra credits.
    add_ := trunc(plan_.monthly_credits * p_paid_share, 2);
    if add_ > 0 then
      insert into public.credit_lots
        (org_id, source, amount, remaining, expires_at, external_id, subscription_id, plan_id,
         period_start, period_end, allowance, note)
      values
        (p_org, 'subscription', add_, add_, p_period_end, ext, s.id, p_plan,
         p_period_start, p_period_end, plan_.monthly_credits,
         left(format('%s plan, period %s – %s', plan_.name,
                     to_char(p_period_start at time zone 'UTC', 'YYYY-MM-DD'),
                     to_char(p_period_end at time zone 'UTC', 'YYYY-MM-DD')), 500))
      returning id into lid;
    end if;
  elsif plan_.monthly_credits > coalesce(lot.allowance, lot.amount) then
    frac := greatest(least(extract(epoch from (p_period_end - now()))
                           / nullif(extract(epoch from (lot.period_end - lot.period_start)), 0), 1), 0);
    add_ := trunc((plan_.monthly_credits - coalesce(lot.allowance, lot.amount)) * coalesce(frac, 0) * p_paid_share, 2);
    lid := lot.id;
    update public.credit_lots
       set amount = amount + add_, remaining = remaining + add_,
           allowance = plan_.monthly_credits, plan_id = p_plan, updated_at = now()
     where id = lot.id;
  end if;

  if add_ > 0 then
    update public.credit_accounts set balance = balance + add_, updated_at = now()
     where org_id = p_org
    returning * into acc;
    txn := public.credit_log(p_org, 'subscription', add_, null, ext,
                             coalesce(nullif(btrim(p_note), ''), format('%s plan credits', plan_.name)));
    update public.credit_lots set created_txn = coalesce(created_txn, txn) where id = lid;
    perform public.credit_lot_move(p_org, lid, txn, null, case when lot.id is null then 'grant' else 'topup' end, add_, 0);
  end if;

  -- A renewal: the previous period's lot has run out now.
  perform public.credit_expire_lots_locked(p_org);
  select * into acc from public.credit_accounts where org_id = p_org;

  return jsonb_build_object('duplicate', false, 'granted', add_, 'transaction_id', txn, 'lot_id', lid,
                            'balance', acc.balance, 'available', acc.balance - acc.reserved);
end
$$;

-- The Paddle webhook's two calls, unchanged for it: the same signature, defaults and answer, through the one body above.
create or replace function public.upsert_subscription(
  p_org uuid, p_subscription_id text, p_customer_id text, p_plan text, p_price_id text,
  p_status text, p_period_start timestamptz, p_period_end timestamptz,
  p_cancel_at_period_end boolean, p_canceled_at timestamptz, p_occurred_at timestamptz
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  return public.upsert_subscription_for('paddle', p_org, p_subscription_id, p_customer_id, p_plan, p_price_id,
                                        p_status, p_period_start, p_period_end,
                                        p_cancel_at_period_end, p_canceled_at, p_occurred_at);
end
$$;

create or replace function public.grant_subscription_credits(
  p_org uuid, p_subscription_id text, p_plan text, p_period_start timestamptz, p_period_end timestamptz,
  p_external_id text, p_note text default null, p_customer_id text default null, p_price_id text default null,
  p_paid_share numeric default 1
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  return public.grant_subscription_credits_for('paddle', p_org, p_subscription_id, p_plan, p_period_start, p_period_end,
                                               p_external_id, p_note, p_customer_id, p_price_id, p_paid_share);
end
$$;

comment on function public.upsert_subscription_for(text, uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz) is
  'A provider''s subscription.* state (migration 0142; 0034''s upsert_subscription body under a provider): ''paddle'' or ''dodo''. An event older than the last one applied changes nothing; a new subscription needs a known plan. Service role only.';
comment on function public.grant_subscription_credits_for(text, uuid, text, text, timestamptz, timestamptz, text, text, text, text, numeric) is
  'A provider''s paid plan period -> that period''s credits (migration 0142; 0034''s grant_subscription_credits body under a provider): idempotent per external id and per (subscription, period end), pro rata on a mid-period upgrade, nothing for a period already over. Service role only.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Privileges: the platform only, exactly like 0034's two
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.upsert_subscription_for(text, uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function public.grant_subscription_credits_for(text, uuid, text, text, timestamptz, timestamptz, text, text, text, text, numeric)
  from public, anon, authenticated;
grant execute on function public.upsert_subscription_for(text, uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz)
  to service_role;
grant execute on function public.grant_subscription_credits_for(text, uuid, text, text, timestamptz, timestamptz, text, text, text, text, numeric)
  to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. End state
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  pair text[];
  defs text;
begin
  foreach pair slice 1 in array array[
      ['public.upsert_subscription(uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz)', '09185a96a8fb02f0c2641095d51461cc'],
      ['public.grant_subscription_credits(uuid, text, text, timestamptz, timestamptz, text, text, text, text, numeric)', 'fd0c1c169a4d3b2d05c6d826c6fe10ff'],
      ['public.upsert_subscription_for(text, uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz)', '9f9b399ce3ca3421d1ccb32c4075d6ea'],
      ['public.grant_subscription_credits_for(text, uuid, text, text, timestamptz, timestamptz, text, text, text, text, numeric)', '5424905376fab9ff1b4c229c5dc0c0ce']] loop
    if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(pair[1])) is distinct from pair[2] then
      raise exception '0142 end state: % does not hold the body this file expects', pair[1];
    end if;
    if not has_function_privilege('service_role', pair[1], 'EXECUTE')
       or has_function_privilege('anon', pair[1], 'EXECUTE')
       or has_function_privilege('authenticated', pair[1], 'EXECUTE') then
      raise exception '0142 end state: % has the wrong grants (service role only)', pair[1];
    end if;
    if exists (select 1 from pg_proc p where p.oid = to_regprocedure(pair[1])
                and (not p.prosecdef or p.provolatile <> 'v'
                     or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                     or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
      raise exception '0142 end state: % is not a volatile SECURITY DEFINER with a fixed search_path, or PUBLIC may call it', pair[1];
    end if;
  end loop;
  -- The checks: exactly these definitions (a Paddle row keeps 0034's patterns).
  select string_agg(conname || '=' || pg_get_constraintdef(oid), ' | ' order by conname) into defs
    from pg_constraint
   where contype = 'c' and conname in ('payment_events_provider_check', 'subscriptions_provider_check',
                                       'subscriptions_provider_subscription_id_check', 'subscriptions_provider_customer_id_check',
                                       'subscriptions_price_id_check');
  if md5(defs) is distinct from '0bd392d5168a2de8fb871e400200e7cc' then
    raise exception '0142 end state: the provider checks are not this file''s (%)', defs;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying, in the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select count(*) from pg_proc where proname in ('upsert_subscription_for', 'grant_subscription_credits_for') and prosecdef) = 2
--     as definer_functions,
--   not has_function_privilege('authenticated',
--     'public.grant_subscription_credits_for(text, uuid, text, text, timestamptz, timestamptz, text, text, text, text, numeric)', 'EXECUTE')
--     and has_function_privilege('service_role',
--     'public.grant_subscription_credits_for(text, uuid, text, text, timestamptz, timestamptz, text, text, text, text, numeric)', 'EXECUTE')
--     as service_only,
--   (select count(*) from public.subscriptions where provider = 'dodo') = 0 as no_dodo_rows_yet;
