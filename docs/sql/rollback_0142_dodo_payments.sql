-- rollback_0142_dodo_payments.sql — takes migration 0142 (a second payment provider, Dodo Payments) out again. OWNER-APPLY: paste into
-- the Supabase SQL editor. Nothing in the app runs it.
--
-- WHEN: only before any Dodo payment has been recorded. The Dodo webhook (supabase/functions/dodo-webhook) must be undeployed or its
-- secrets removed first, and PAYMENTS_PROVIDER must be back on `paddle` (docs/DODO_SETUP.md, "Rolling back"). Turning Dodo off does
-- NOT need this file: the switch and the webhook are enough, and 0142 changes nothing for Paddle.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) while a payment_events or subscriptions row names provider 'dodo' (a Dodo purchase would lose its
--      audit row and its subscription), or when a function of 0142 is not 0142's body (a later change would be undone).
--   1. Puts 0034's upsert_subscription and grant_subscription_credits bodies back, byte for byte.
--   2. Drops upsert_subscription_for and grant_subscription_credits_for.
--   3. Puts 0021's and 0034's provider and id checks back exactly ('paddle' only).
--   4. Asserts the end state: 0034's bodies (md5) and checks.

begin;
set local lock_timeout = '5s';

do $$
declare
  h text;
  pair text[];
begin
  if exists (select 1 from public.payment_events where provider = 'dodo')
     or exists (select 1 from public.subscriptions where provider = 'dodo') then
    raise exception 'rollback 0142: Dodo rows exist (payment_events / subscriptions); they would be orphaned. Keep 0142, or settle those first';
  end if;
  foreach pair slice 1 in array array[
      ['public.upsert_subscription(uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz)', '09185a96a8fb02f0c2641095d51461cc'],
      ['public.grant_subscription_credits(uuid, text, text, timestamptz, timestamptz, text, text, text, text, numeric)', 'fd0c1c169a4d3b2d05c6d826c6fe10ff'],
      ['public.upsert_subscription_for(text, uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz)', '9f9b399ce3ca3421d1ccb32c4075d6ea'],
      ['public.grant_subscription_credits_for(text, uuid, text, text, timestamptz, timestamptz, text, text, text, text, numeric)', '5424905376fab9ff1b4c229c5dc0c0ce']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(pair[1]);
    if h is distinct from pair[2] then
      raise exception 'rollback 0142: % is not 0142''s body (md5 %): read the live body first', pair[1], h;
    end if;
  end loop;
end $$;

-- 1. 0034's bodies, as 0034 wrote them.
create or replace function public.upsert_subscription(
  p_org uuid, p_subscription_id text, p_customer_id text, p_plan text, p_price_id text,
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
  perform pg_advisory_xact_lock(hashtextextended('subscription:' || coalesce(p_subscription_id, ''), 0));
  select * into s from public.subscriptions
   where provider = 'paddle' and provider_subscription_id = p_subscription_id
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
      (org_id, provider_subscription_id, provider_customer_id, plan_id, price_id, status,
       current_period_start, current_period_end, cancel_at_period_end, canceled_at, last_event_at)
    values
      (p_org, p_subscription_id, p_customer_id, p_plan, p_price_id, p_status,
       p_period_start, p_period_end, coalesce(p_cancel_at_period_end, false), p_canceled_at, p_occurred_at)
    returning * into s;
  end if;
  return jsonb_build_object('id', s.id, 'stale', false, 'status', s.status, 'plan', s.plan_id);
end
$$;

create or replace function public.grant_subscription_credits(
  p_org uuid, p_subscription_id text, p_plan text, p_period_start timestamptz, p_period_end timestamptz,
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
  perform pg_advisory_xact_lock(hashtextextended('subscription:' || coalesce(p_subscription_id, ''), 0));

  select * into prior from public.credit_transactions where external_id = ext;
  if found then
    if prior.org_id <> p_org or prior.kind <> 'subscription' then
      raise exception 'external_id already recorded for something else' using errcode = '23505';
    end if;
    return jsonb_build_object('duplicate', true, 'granted', 0, 'transaction_id', prior.id,
                              'balance', acc.balance, 'available', acc.balance - acc.reserved);
  end if;

  select * into s from public.subscriptions
   where provider = 'paddle' and provider_subscription_id = p_subscription_id
   for update;
  if not found then
    insert into public.subscriptions
      (org_id, provider_subscription_id, provider_customer_id, plan_id, price_id, status,
       current_period_start, current_period_end)
    values (p_org, p_subscription_id, p_customer_id, p_plan, p_price_id, 'active', p_period_start, p_period_end)
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

-- 2. The provider-aware twins.
drop function if exists public.upsert_subscription_for(text, uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz);
drop function if exists public.grant_subscription_credits_for(text, uuid, text, text, timestamptz, timestamptz, text, text, text, text, numeric);

-- 3. 0021's and 0034's checks.
alter table public.payment_events drop constraint if exists payment_events_provider_check;
alter table public.payment_events add constraint payment_events_provider_check check (provider in ('paddle'));
alter table public.subscriptions drop constraint if exists subscriptions_provider_check;
alter table public.subscriptions add constraint subscriptions_provider_check check (provider in ('paddle'));
alter table public.subscriptions drop constraint if exists subscriptions_provider_subscription_id_check;
alter table public.subscriptions add constraint subscriptions_provider_subscription_id_check
  check (provider_subscription_id ~ '^sub_[a-z0-9]{10,40}$');
alter table public.subscriptions drop constraint if exists subscriptions_provider_customer_id_check;
alter table public.subscriptions add constraint subscriptions_provider_customer_id_check
  check (provider_customer_id is null or provider_customer_id ~ '^ctm_[a-z0-9]{10,40}$');
alter table public.subscriptions drop constraint if exists subscriptions_price_id_check;
alter table public.subscriptions add constraint subscriptions_price_id_check
  check (price_id is null or price_id ~ '^pri_[a-z0-9]{10,40}$');

-- 4. End state.
do $$
declare
  pair text[];
  defs text;
begin
  foreach pair slice 1 in array array[
      ['public.upsert_subscription(uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz)', '60ee6ad3764dbcf6762b178f8240d5a9'],
      ['public.grant_subscription_credits(uuid, text, text, timestamptz, timestamptz, text, text, text, text, numeric)', '7947d46697f1c35d12274ffbe22709ac']] loop
    if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(pair[1])) is distinct from pair[2] then
      raise exception 'rollback 0142 end state: % is not 0034''s body', pair[1];
    end if;
    if not has_function_privilege('service_role', pair[1], 'EXECUTE') or has_function_privilege('authenticated', pair[1], 'EXECUTE') then
      raise exception 'rollback 0142 end state: % has the wrong grants', pair[1];
    end if;
  end loop;
  if to_regprocedure('public.upsert_subscription_for(text, uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz)') is not null
     or to_regprocedure('public.grant_subscription_credits_for(text, uuid, text, text, timestamptz, timestamptz, text, text, text, text, numeric)') is not null then
    raise exception 'rollback 0142 end state: a function of 0142 is still there';
  end if;
  select string_agg(conname || '=' || pg_get_constraintdef(oid), ' | ' order by conname) into defs
    from pg_constraint
   where contype = 'c' and conname in ('payment_events_provider_check', 'subscriptions_provider_check',
                                       'subscriptions_provider_subscription_id_check', 'subscriptions_provider_customer_id_check',
                                       'subscriptions_price_id_check');
  if md5(defs) is distinct from 'ec234114398cef44cceb69b2d07c1da8' then
    raise exception 'rollback 0142 end state: the checks are not 0034''s (%)', defs;
  end if;
end $$;

commit;
