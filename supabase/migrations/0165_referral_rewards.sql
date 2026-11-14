-- 0165_referral_rewards.sql — the referral programme: a person who invites a friend earns credits when the friend's first
-- PAYMENT has cleared a hold, not when the friend signs up. Owner decision 2026-11-14. docs/MIGRATIONS.md "0165".
--
-- *** WHAT CHANGES ON APPLY (and nothing else) ***
--   1. The referral reward has its OWN switch, friend_invite_settings.referral_enabled, added OFF. Nothing is paid until a
--      platform owner/admin turns it on (set_referral_settings, behind owner_guard: second factor, rate limit). 0092's
--      `enabled` (true on live when this was written) only keeps links and joins working, as it did.
--   2. 0092's sign-up milestone (5 confirmed sign-ups pay 100 credits once) is switched OFF: milestone_enabled is added
--      false, not copied from `enabled`. Sign-ups alone can be farmed with throwaway mailboxes (docs/security/LEDGER.md
--      BR-S-010). Live had 0 links and 0 joins, so nothing earned is lost; the operator can turn it back on deliberately.
--   3. referral_open_periods is created EMPTY: the programme has never been open, and a join or a payment counts only when it
--      falls inside a period the reward was open (each on/off of set_referral_settings opens or closes one, audited).
--   4. join_friend_invite (0092) waits at most 2 seconds for its link lock (one hunk) instead of without bound, so a settle in
--      progress cannot hold a new account's join hostage; the app retries it once and keeps the cookie on a failure.
--   5. The ledger's lot trigger (0034, credit_transactions_apply_lots) takes an 'adjust' row's credits from a named lot first
--      when the caller names one (one hunk, setting nightshift.adjust_lot_first): a referral clawback takes back the
--      reward's own credits before plan or pack credits. No other writer sets it; every other row behaves as before.
--   6. With pg_cron installed, job 'nightshift-referral-settle' runs referral_settle_all(50) every 5 minutes. While the
--      reward is off it finds nothing to do.
-- No webhook, purchase, refund or reservation function, no RLS policy and no existing table's rows are changed.
--
-- THE RULE (enforced here, not in the app)
--   * A friend is someone who joined through the link under 0092's rules (a NEW account: made after the link, at most 3 days
--     before it joined; e-mail confirmed; not the owner nor the owner's mailbox; one account and one mailbox once), and whose
--     join fell inside an open period. A join made while the programme was closed never counts, even after it reopens.
--   * A PAYMENT is a purchase or subscription ledger row whose provider event for that transaction (paddle
--     transaction.completed / dodo payment.succeeded, processed) charged more than 0 at FULL PRICE: the webhook marks every
--     discounted or promo payment (paddle-webhook appends " · discounted (…)" to the event detail; dodo-webhook credits no
--     discounted payment at all). A row without such an event (a $0 trial, a promo, a discount) is not a payment: it neither
--     qualifies nor uses up the workspace's chance.
--   * The friend qualifies with the FIRST payment EVER of a workspace the friend CREATED (created_by) after their account was
--     made, and owned before that payment, made inside an open period and within referral_qualify_days (60) of the account's
--     creation, of at least referral_min_credits (default 1000). Anchored on the account, not the join, so a join recorded
--     late does not void the friend's workspace. Why full price and a floor: an allowed promo books full credits at any paid
--     share (99% off at $0.01), so "more than 0" alone is not money; a full-price payment of >= referral_min_credits costs the
--     catalogue price of those credits. As a second line, a USD payment must also be at least half the minimum's base price
--     (1 credit = 1 US cent, the Starter pack's own rate; half leaves room for regional pricing): referral_min_credits / 2
--     cents. Other currencies rely on the full-price rule. One referral per friend, per mailbox and per payment, for good.
--   * Void, recorded and never paid: the referrer is a member of the paying workspace, or the friend of the link's workspace,
--     when it qualifies or when it is due ('member'; org_members keeps no history, so "was" is what these two moments saw);
--     the friend's workspace and one of the referrer's share a subscription customer at the payment provider ('same_payer';
--     one-time payments carry no payer identity here and there is no device signal, so those checks cannot run); the
--     payment is reversed during the hold ('refunded').
--   * Reversed means: a credit_refunds row for the payment (0021), OR the provider's own event for that transaction says
--     refund, chargeback or dispute and a person must act (paddle adjustment.* approved and booked, or rejected for a person;
--     dodo refund.succeeded, dispute.accepted / lost / expired). The second kind is counted on the operator's panel.
--   * The reward (referral_credits, 200; a CHECK keeps it at most referral_min_credits) is held referral_hold_days (30, at
--     least 7) after the payment, then paid as one 'grant' row 'referral-reward:<ref>' (an opaque uuid, never the friend's
--     id) authored by the referrer, at most referral_monthly_cap (10) per referrer per UTC month and referral_daily_cap (50)
--     per UTC day platform-wide; a capped reward waits.
--   * A reversal after the payout claws the reward back from the reward's own lot first, as far as credits are available
--     (balance - reserved, after expiring what is past its date). What is not available stays OWED (status 'clawing') and
--     every later settle takes more ('referral-clawback:<ref>:<n>', authored by nobody: the platform) until nothing is owed:
--     a hold placed to dodge the clawback only delays it. The balance never goes negative.
--
-- WHEN IT SETTLES. referral_settle_locked(link), under the referrer's link row lock, in one order everywhere: the link row,
-- then the daily cap's advisory lock, then the credit account.
--   claim_referral_rewards()  the referrer's Credits page (server-side, their own session); at most 60 an hour a person.
--   referral_settle_all(n)    service role and pg_cron: the n links settled longest ago (skip locked), one run row each call
--                             in referral_settle_runs, read back by referral_admin() with whether the schedule exists.
-- Joins older than referral_qualify_days + 2 days are no longer looked at for a NEW referral.
-- A link goes only when its owner's account is deleted (an operator step, a data request). Its referrals are then not settled
-- any more: a held reward is never paid to an account that is gone, and a clawback still owed stays owed; referral_admin()
-- counts these ('orphaned') for the operator to decide. Settling them by referrer_id would mean paying or charging a
-- workspace whose person no longer exists, which is not a decision for a job to make.
--
-- WHAT IT ADDS
--   friend_invite_settings  + referral_enabled, milestone_enabled, referral_credits, referral_min_credits, referral_hold_days,
--                             referral_qualify_days, referral_monthly_cap, referral_daily_cap, referral_updated_at.
--   friend_invite_links     + referral_settled_at (which links the batch settles next).
--   referral_rewards        one row per friend whose first payment was seen. referral_settle_runs: the settle job's log.
--   referral_open_periods   one row per time the reward was switched on (opened_at) and off (closed_at).
--                           All three: RLS on, no policy, every privilege (and their sequences') revoked.
--   referral_payment_reversed(text) / referral_payment_paid(text) / referral_was_open(timestamptz) / referral_settle_locked(link)
--                                                                         internal (no API role)
--   claim_referral_rewards() / my_referrals()                             AUTHENTICATED, the caller's own
--   referral_terms()                                                      ANON and AUTHENTICATED (the public /referral)
--   referral_admin() / set_referral_settings(...)                         a platform owner/admin (owner_guard on the setter)
--   referral_settle_all(integer)                                          service role and pg_cron
-- WHAT IT REPLACES (md5 drift guard: the earlier body, or this file's own on a replay)
--   friend_invite_pay_locked (0092)       'off' while milestone_enabled is off.
--   my_friend_invite (0092)               'pending' is false while milestone_enabled is off.
--   join_friend_invite (0092)             lock_timeout 2s before the link lock.
--   credit_transactions_apply_lots (0034) an 'adjust' row may name the lot it spends first.
--
-- NUMBER. 0165 (assigned): 0163 and 0164 are other open pull requests. Needs 0018, 0020, 0021, 0034, 0042, 0092 and 0107;
-- names nothing of 0108-0164.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; md5 of the body with every run of white space read as one space):
--   select p.oid::regprocedure, md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc p
--    where proname in ('friend_invite_pay_locked', 'my_friend_invite', 'join_friend_invite', 'credit_transactions_apply_lots');
--   expected BEFORE: friend_invite_pay_locked 1cfc1f84f065d73e2cb7e84c18ca6ae2 · my_friend_invite b26806d4fdc88a8453e939087d53184c
--                    join_friend_invite 549632bae0dbb002dc66200d7f6c0998 · credit_transactions_apply_lots 8ab35cff8ac8a145403b0e6eca735697
--   expected AFTER: the md5 pairs in the guard below (docs/MIGRATIONS.md "0165" lists them too).
-- Undo: docs/sql/rollback_0165_referral_rewards.sql (owner-applied; refuses while any referral row exists).

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  h text;
  trio text[];
begin
  if to_regclass('public.friend_invite_settings') is null or to_regclass('public.friend_invite_links') is null
     or to_regclass('public.friend_invite_joins') is null or to_regclass('public.friend_invite_rewards') is null then
    raise exception '0165 needs Invite friends: apply 0092_friend_invites.sql first';
  end if;
  if to_regclass('public.credit_transactions') is null or to_regprocedure('public.credit_account_lock(uuid)') is null then
    raise exception '0165 needs credits: apply 0020_credits.sql first';
  end if;
  if to_regclass('public.credit_refunds') is null or to_regclass('public.payment_events') is null then
    raise exception '0165 needs credit refunds and payment events: apply 0021_credit_refunds.sql first';
  end if;
  if to_regclass('public.subscriptions') is null or to_regprocedure('public.credit_expire_lots_locked(uuid)') is null then
    raise exception '0165 needs plans and lots: apply 0034_plans_entitlements.sql first';
  end if;
  if to_regprocedure('public.is_platform_admin()') is null or to_regclass('public.org_members') is null then
    raise exception '0165 needs organizations: apply 0018_organizations.sql first';
  end if;
  if to_regprocedure('public.take_web_rate(text, integer, integer)') is null then
    raise exception '0165 needs the web rate limit: apply 0042_web_api_hardening.sql first';
  end if;
  if to_regprocedure('public.owner_guard(text, integer)') is null or to_regprocedure('public.security_event_log(text, text, text, jsonb)') is null then
    raise exception '0165 needs the owner guard: apply 0107_owner_safety.sql first';
  end if;
  -- Each function this file replaces: the earlier body, or this file's own (a replay).
  foreach trio slice 1 in array array[
      ['public.friend_invite_pay_locked(public.friend_invite_links)', '1cfc1f84f065d73e2cb7e84c18ca6ae2', 'eeae5e2f28b289aab7439beabede3a6f'],
      ['public.my_friend_invite()', 'b26806d4fdc88a8453e939087d53184c', '4717561b1b5c47f7e754118f15fa03ea'],
      ['public.join_friend_invite(text)', '549632bae0dbb002dc66200d7f6c0998', '8bc6fb874e4e65cf7378bddbfa3768d6'],
      ['public.credit_transactions_apply_lots()', '8ab35cff8ac8a145403b0e6eca735697', 'fcd28a68b841d8d539d3798f919a0d01']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(trio[1]);
    if h is null or h <> all (array[trio[2], trio[3]]) then
      raise exception '0165 found % with a body that is neither the earlier one nor 0165''s (md5 %): read the live body first', trio[1], h;
    end if;
  end loop;
  -- Each name this file creates: absent, or this file's own body.
  foreach trio slice 1 in array array[
      ['public.referral_payment_reversed(text)', 'c7ca11fcf4bf7e283ee77e43d7770a1b', ''],
      ['public.referral_payment_paid(text)', '0a53c4290c5046ccc3a6accdd46d9e9c', ''],
      ['public.referral_was_open(timestamptz)', '492d74b160d3bcf29d09a82d288e2a7e', ''],
      ['public.referral_settle_locked(public.friend_invite_links)', 'aa1546a79a9a655bd278de1fad4d794a', ''],
      ['public.claim_referral_rewards()', '273fcc22a8e8116b86b57bcf03cf8ddb', ''],
      ['public.my_referrals()', 'c0ff6ab6e0f6ee0df46c44ddb6b2df8f', ''],
      ['public.referral_terms()', 'e2be2f76972e1e707e0ce4d52f47cf53', ''],
      ['public.referral_admin()', '6881c7fc37602e907793b0178bf5a73f', ''],
      ['public.set_referral_settings(boolean, boolean, numeric, numeric, integer, integer, integer, integer)', 'c57ae2b4cd2d14bab35fbd85e9775cdf', ''],
      ['public.referral_settle_all(integer)', '5e640e5905f7d7b974b47c4e4af5b748', '']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(trio[1]);
    if h is not null and h <> trio[2] then
      raise exception '0165 found % with a body that is not this file''s (md5 %): read the live body first', trio[1], h;
    end if;
  end loop;
  -- What it builds on, as the repository has it: the account lock (0034) and the owner guard (0107).
  foreach trio slice 1 in array array[
      ['public.credit_account_lock(uuid)', 'e65c08be376f40a30c02d1a8502bf154', '']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(trio[1]);
    if h is distinct from trio[2] then
      raise exception '0165 found % with a body that is not the one it was written against (md5 %): read the live body first', trio[1], h;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The programme's switches and numbers (one row, 0092)
-- ───────────────────────────────────────────────────────────────────────────

-- Both switches are added OFF and are never copied from 0092's `enabled` (see "WHAT CHANGES ON APPLY"). A replay finds the
-- columns there and changes nothing.
alter table public.friend_invite_settings add column if not exists referral_enabled boolean not null default false;
alter table public.friend_invite_settings add column if not exists milestone_enabled boolean not null default false;
alter table public.friend_invite_settings add column if not exists referral_credits numeric(14,2) not null default 200;
alter table public.friend_invite_settings add column if not exists referral_min_credits numeric(14,2) not null default 1000;
alter table public.friend_invite_settings add column if not exists referral_hold_days integer not null default 30;
alter table public.friend_invite_settings add column if not exists referral_qualify_days integer not null default 60;
alter table public.friend_invite_settings add column if not exists referral_monthly_cap integer not null default 10;
alter table public.friend_invite_settings add column if not exists referral_daily_cap integer not null default 50;
alter table public.friend_invite_settings add column if not exists referral_updated_at timestamptz not null default now();

-- A hold shorter than a week cannot see a refund; a reward above the smallest payment that earns it would make paying for a
-- friend's account a way to mint credits.
alter table public.friend_invite_settings drop constraint if exists friend_invite_settings_referral_check;
alter table public.friend_invite_settings add constraint friend_invite_settings_referral_check
  check (referral_credits > 0 and referral_credits <= 100000
         and referral_min_credits >= 1 and referral_min_credits <= 1000000
         and referral_credits <= referral_min_credits
         and referral_hold_days between 7 and 180
         and referral_qualify_days between 1 and 365
         and referral_monthly_cap between 1 and 1000
         and referral_daily_cap between 0 and 10000);

comment on column public.friend_invite_settings.referral_enabled is
  'The referral reward (0165): off until a platform owner/admin turns it on. 0092''s `enabled` only keeps links and joins working.';
comment on column public.friend_invite_settings.milestone_enabled is
  '0092''s sign-up milestone (required_joins joins pay reward_credits once). Off (0165): sign-ups alone can be farmed with throwaway mailboxes (BR-S-010).';

alter table public.friend_invite_links add column if not exists referral_settled_at timestamptz;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The referrals and the settle log
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.referral_rewards (
  -- The friend's account and mailbox: one referral per person, for good. No foreign key: the row is a money record and
  -- outlives a deleted account, like friend_invite_rewards (0092).
  invitee_id           uuid primary key,
  invitee_email_key    text not null unique check (invitee_email_key ~ '^[0-9a-f]{64}$'),
  -- The opaque key of the ledger rows: the referrer reads their own ledger, and it must not name the friend.
  ref                  uuid not null unique default gen_random_uuid(),
  join_id              bigint,
  referrer_id          uuid not null,
  link_id              bigint not null,
  org_id               uuid not null references public.organizations (id) on delete restrict,
  invitee_org_id       uuid not null,
  purchase_external_id text not null unique check (length(purchase_external_id) between 1 and 200),
  purchase_kind        text not null check (purchase_kind in ('purchase', 'subscription')),
  purchased_at         timestamptz not null,
  credits              numeric(14,2) not null check (credits > 0),
  status               text not null check (status in ('held', 'paid', 'void', 'clawing', 'clawed')),
  void_reason          text check (void_reason is null or void_reason in ('refunded', 'same_payer', 'member')),
  -- What reported the reversal: a credit_refunds row ('refund') or only the provider's event ('event', a person's case).
  reversed_by          text check (reversed_by is null or reversed_by in ('refund', 'event')),
  release_at           timestamptz not null,
  paid_at              timestamptz,
  clawed               numeric(14,2) not null default 0 check (clawed >= 0),
  claw_shortfall       numeric(14,2) not null default 0 check (claw_shortfall >= 0),
  claw_n               integer not null default 0 check (claw_n >= 0),
  clawed_at            timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check ((status = 'void') = (void_reason is not null)),
  check ((status in ('paid', 'clawing', 'clawed')) = (paid_at is not null)),
  check ((status in ('clawing', 'clawed')) = (clawed_at is not null)),
  check (clawed + claw_shortfall = case when status in ('clawing', 'clawed') then credits else 0 end),
  check (status <> 'clawing' or claw_shortfall > 0),
  check (status <> 'clawed' or claw_shortfall = 0)
);
create index if not exists referral_rewards_referrer_idx on public.referral_rewards (referrer_id, status, release_at);
create index if not exists referral_rewards_paid_idx on public.referral_rewards (paid_at) where paid_at is not null;
comment on table public.referral_rewards is
  'One row per friend whose first qualifying payment was seen (0165): held until release_at, then paid (a grant, external_id referral-reward:<ref>), void (reversed during the hold, the same payer, or a membership overlap), clawing (reversed after payment, part still owed) or clawed (all taken back). No API role has a privilege on this table.';
alter table public.referral_rewards enable row level security;
revoke all on public.referral_rewards from public, anon, authenticated, service_role;

create table if not exists public.referral_settle_runs (
  id          bigint generated always as identity primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz not null default now(),
  links       integer not null check (links >= 0),
  changed     integer not null check (changed >= 0),
  failed      integer not null check (failed >= 0),
  error       text check (error is null or length(error) <= 500)
);
create index if not exists referral_settle_runs_at_idx on public.referral_settle_runs (started_at desc);
comment on table public.referral_settle_runs is
  'One row per referral_settle_all() call (0165): how many links, changes and failures, and the last failure''s message. Kept 30 days. Read by referral_admin(). No API role has a privilege on this table.';
alter table public.referral_settle_runs enable row level security;
revoke all on public.referral_settle_runs from public, anon, authenticated, service_role;

-- When the reward was open. A join and a payment count only inside one of these: switching the reward off and on again
-- does not let what happened while it was closed count afterwards. Written only by set_referral_settings, in its audit.
create table if not exists public.referral_open_periods (
  id         bigint generated always as identity primary key,
  opened_at  timestamptz not null default now(),
  closed_at  timestamptz,
  opened_by  uuid,
  closed_by  uuid,
  check (closed_at is null or closed_at >= opened_at)
);
-- At most one open period at a time.
create unique index if not exists referral_open_periods_one_open on public.referral_open_periods ((true)) where closed_at is null;
comment on table public.referral_open_periods is
  'The times the referral reward was on (0165): one row per switch-on (opened_at) and its switch-off (closed_at, null while open). Written by set_referral_settings only. No API role has a privilege on this table.';
alter table public.referral_open_periods enable row level security;
revoke all on public.referral_open_periods from public, anon, authenticated, service_role;

-- Supabase's default privileges also give the API roles the identity columns' sequences: taken back.
do $$
declare
  seq text;
begin
  foreach seq in array array[pg_get_serial_sequence('public.referral_settle_runs', 'id'),
                             pg_get_serial_sequence('public.referral_open_periods', 'id')] loop
    execute format('revoke all on sequence %s from public, anon, authenticated, service_role', seq);
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The four replaced bodies (one hunk each)
-- ───────────────────────────────────────────────────────────────────────────

-- Pay the owner of `p_link` if the reward is earned and there is room today.
-- The link row is ALREADY LOCKED by the caller (for update). Returns
-- 'paid' (now, or earlier), 'none' (not earned yet), 'off' (switch is off) or
-- 'cap' (earned; today's platform-wide cap is full: pending).
create or replace function public.friend_invite_pay_locked(p_link public.friend_invite_links) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s       public.friend_invite_settings;
  n       integer;
  acc     public.credit_accounts;
  k       text;
  marker  text := 'invite-reward:' || p_link.user_id::text;
  day0    timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
begin
  if exists (select 1 from public.friend_invite_rewards where user_id = p_link.user_id) then
    return 'paid';
  end if;
  select * into s from public.friend_invite_settings;
  -- 0165: the sign-up milestone has its own switch, off unless the operator turned it on.
  if not s.enabled or not s.milestone_enabled then
    return 'off';
  end if;
  select count(*) into n from public.friend_invite_joins where link_id = p_link.id and counted;
  if n < s.required_joins then
    return 'none';
  end if;
  -- One reward per mailbox, for good: an account deleted and made again on the
  -- same mailbox (a new user id, so a new link and a fresh marker) earns nothing.
  k := public.friend_invite_mail_key(p_link.user_id);
  if k is null or exists (select 1 from public.friend_invite_rewards where email_key = k) then
    return 'none';
  end if;

  -- One platform-wide lock for the cap: two rewards completing together
  -- count each other. Taken after the link row, before the account row, by
  -- every caller (no other function takes either).
  perform pg_advisory_xact_lock(hashtextextended('friend_invite_rewards', 0));
  if (select count(*) from public.friend_invite_rewards where created_at >= day0) >= s.daily_reward_cap then
    return 'cap';
  end if;

  begin
    insert into public.friend_invite_rewards (user_id, link_id, org_id, credits, joins, email_key)
    values (p_link.user_id, p_link.id, p_link.org_id, s.reward_credits, n, k);
    perform public.credit_account_lock(p_link.org_id);
    update public.credit_accounts
       set balance = balance + s.reward_credits, updated_at = now()
     where org_id = p_link.org_id
    returning * into acc;
    -- Written like credit_log() writes a row, but authored by the OWNER:
    -- credit_log stamps auth.uid(), which in a join is the new person, and a
    -- member can read created_by on their own ledger.
    insert into public.credit_transactions
      (org_id, kind, amount, balance_after, reserved_after, external_id, note, created_by)
    values
      (p_link.org_id, 'grant', s.reward_credits, acc.balance, acc.reserved, marker, 'invite reward', p_link.user_id);
  exception when unique_violation then
    -- Paid by another call a moment ago (reward row or ledger marker): this
    -- subtransaction, balance included, is undone.
    return 'paid';
  end;
  return 'paid';
end
$$;

-- The caller's own link and progress. Counts only: no invitee id, e-mail or time.
create or replace function public.my_friend_invite() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  s   public.friend_invite_settings;
  l   public.friend_invite_links;
  r   public.friend_invite_rewards;
  n   integer := 0;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into s from public.friend_invite_settings;
  select * into l from public.friend_invite_links where user_id = uid;
  select * into r from public.friend_invite_rewards where user_id = uid;
  if l.id is not null then
    select count(*) into n from public.friend_invite_joins where link_id = l.id and counted;
  end if;
  return jsonb_build_object(
    'enabled', s.enabled,
    'required', s.required_joins,
    'reward', s.reward_credits,
    'link', case when l.id is null then null
                 else jsonb_build_object('token', l.token, 'created_at', l.created_at, 'org_id', l.org_id) end,
    'joined', case when r.user_id is not null then r.joins else least(n, s.required_joins) end,
    'paid', r.user_id is not null,
    'credits_paid', r.credits,
    -- 0165: a milestone that is switched off is not waiting to be paid.
    'pending', r.user_id is null and l.id is not null and n >= s.required_joins and s.milestone_enabled
               and not exists (select 1 from public.friend_invite_rewards x
                                where x.email_key = public.friend_invite_mail_key(uid)));
end
$$;

-- The signed-in NEW account says "I came through this link", after its e-mail
-- is confirmed. Returns {"status": ...} and never an error for a business
-- refusal, so a caller learns no more than its own outcome:
--   counted | not_counted | already | duplicate | existing | self | unconfirmed
--   | off | paused | invalid
create or replace function public.join_friend_invite(p_token text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid       uuid := auth.uid();
  tok       text := lower(btrim(coalesce(p_token, '')));
  s         public.friend_invite_settings;
  l         public.friend_invite_links;
  u         record;
  v_key     text;
  owner_key text;
  n         integer;
  counted_  boolean;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into s from public.friend_invite_settings;
  if not s.enabled then
    return jsonb_build_object('status', 'off');
  end if;
  if tok !~ '^[0-9a-f]{32}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into l from public.friend_invite_links where token = tok;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;
  -- Joins to one link run one after another from here on.
  -- 0165: waiting at most 2 seconds for a settle that holds the link; past that the call fails (55P03)
  -- and the app retries it, keeping the person's cookie.
  perform set_config('lock_timeout', '2s', true);
  select * into l from public.friend_invite_links where id = l.id for update;

  select id, email, email_confirmed_at, created_at into u from auth.users where id = uid;
  if u.id is null or u.email_confirmed_at is null then
    return jsonb_build_object('status', 'unconfirmed');
  end if;
  if uid = l.user_id then
    return jsonb_build_object('status', 'self');
  end if;
  -- Brand new: made after the link existed, and not long ago.
  if u.created_at < l.created_at or u.created_at < now() - interval '3 days' then
    return jsonb_build_object('status', 'existing');
  end if;
  v_key := public.friend_invite_mail_key(uid);
  if v_key is null then
    return jsonb_build_object('status', 'unconfirmed');
  end if;
  owner_key := public.friend_invite_mail_key(l.user_id);
  if owner_key is not distinct from v_key then
    return jsonb_build_object('status', 'self');
  end if;

  if exists (select 1 from public.friend_invite_joins where invitee_id = uid) then
    -- A second callback for the same account: nothing new is counted, and a
    -- reward that was waiting for room is tried again.
    perform public.friend_invite_pay_locked(l);
    return jsonb_build_object('status', 'already');
  end if;
  if exists (select 1 from public.friend_invite_joins where email_key = v_key) then
    return jsonb_build_object('status', 'duplicate');
  end if;
  if (select count(*) from public.friend_invite_joins
       where link_id = l.id and created_at > now() - interval '1 hour') >= s.link_hourly_cap then
    return jsonb_build_object('status', 'paused');
  end if;

  select count(*) into n from public.friend_invite_joins where link_id = l.id and counted;
  counted_ := n < s.required_joins
              and not exists (select 1 from public.friend_invite_rewards where user_id = l.user_id);
  begin
    insert into public.friend_invite_joins (link_id, invitee_id, email_key, counted)
    values (l.id, uid, v_key, counted_);
  exception when unique_violation then
    return jsonb_build_object('status', 'duplicate');
  end;
  if counted_ and n + 1 >= s.required_joins then
    perform public.friend_invite_pay_locked(l);
  end if;
  return jsonb_build_object('status', case when counted_ then 'counted' else 'not_counted' end);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The ledger drives the lots
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.credit_transactions_apply_lots() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  amt    numeric := new.amount;
  prefer bigint;
  src    text;
begin
  if new.kind in ('subscription', 'expire') or amt = 0 then
    return null;
  end if;
  if new.kind = 'reserve' then
    perform public.credit_lots_hold_locked(new.org_id, new.job_id, amt, new.id);
  elsif new.kind = 'release' then
    perform public.credit_lots_release_locked(new.org_id, new.job_id, amt, new.id);
    perform public.credit_expire_lots_locked(new.org_id);
  elsif new.kind = 'capture' and new.job_id is not null
        and exists (select 1 from public.credit_reservations r where r.job_id = new.job_id) then
    perform public.credit_lots_capture_locked(new.org_id, new.job_id, -amt, new.id);
  elsif new.kind = 'refund' and amt > 0 then
    perform public.credit_lots_restore_locked(new.org_id, new.job_id, amt, new.id);
    perform public.credit_expire_lots_locked(new.org_id);
  elsif amt > 0 then
    src := case new.kind when 'purchase' then 'pack' when 'grant' then 'grant' else 'adjustment' end;
    perform public.credit_lots_add_locked(new.org_id, src, amt, public.credit_lot_expiry(src),
                                          new.external_id, new.id, new.note);
  else
    if new.kind = 'refund' then
      select id into prefer from public.credit_lots
       where org_id = new.org_id
         and external_id = nullif(current_setting('nightshift.refund_of', true), '');
    -- 0165: an 'adjust' row may name the lot it takes from first (a referral clawback takes the reward's own lot).
    elsif new.kind = 'adjust' then
      select id into prefer from public.credit_lots
       where org_id = new.org_id
         and external_id = nullif(current_setting('nightshift.adjust_lot_first', true), '');
    end if;
    perform public.credit_lots_spend_locked(new.org_id, -amt, new.job_id, new.id, prefer);
  end if;
  return null;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Settling one referrer (internal)
-- ───────────────────────────────────────────────────────────────────────────

-- Was this payment reversed? 'refund' when a credit_refunds row took credits back for it (0021), 'event' when only the
-- payment provider's own event says so and a person has to act (the webhook recorded it rejected), null when neither.
create or replace function public.referral_payment_reversed(p_ext text) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when exists (select 1 from public.credit_refunds f where f.purchase_external_id = p_ext) then 'refund'
    when exists (select 1 from public.payment_events e
                  where e.transaction_id = p_ext
                    and e.status in ('processed', 'duplicate', 'rejected')
                    and ((e.provider = 'paddle' and e.event_type in ('adjustment.created', 'adjustment.updated'))
                         or (e.provider = 'dodo' and e.event_type in ('refund.succeeded', 'dispute.accepted', 'dispute.lost',
                                                                       'dispute.expired')))) then 'event'
  end
$$;

-- Is this ledger row a payment? The provider's own event for that transaction, credited, charged more than 0, at full price
-- (paddle-webhook appends " · discounted (…)" to the detail of any discounted or promo payment; dodo-webhook credits none).
create or replace function public.referral_payment_paid(p_ext text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.payment_events e
     where e.transaction_id = p_ext
       and ((e.provider = 'paddle' and e.event_type = 'transaction.completed')
            or (e.provider = 'dodo' and e.event_type = 'payment.succeeded'))
       and e.status in ('processed', 'duplicate')
       and e.amount_minor > 0
       and position(' · discounted' in coalesce(e.detail, '')) = 0)
$$;

-- Was the reward open at this moment (inside an opened, not yet closed period)?
create or replace function public.referral_was_open(p_at timestamptz) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.referral_open_periods p
                  where p.opened_at <= p_at and (p.closed_at is null or p_at < p.closed_at))
$$;

-- The link row is ALREADY LOCKED by the caller (for update). Qualifies, voids, pays and claws back this referrer's referrals,
-- and returns how many rows changed. Lock order: the link row, the daily cap's advisory lock, the credit account.
create or replace function public.referral_settle_locked(p_link public.friend_invite_links) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s       public.friend_invite_settings;
  j       public.friend_invite_joins;
  t       public.credit_transactions;
  r       public.referral_rewards;
  acc     public.credit_accounts;
  same    boolean;
  member  boolean;
  born    timestamptz;
  rev     text;
  m       integer;
  owed    numeric;
  taken   numeric;
  marker  text;
  changed integer := 0;
  month0  timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  day0    timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
begin
  select * into s from public.friend_invite_settings;

  -- 1. Qualify. While the reward is on, every recent friend of this link without a referral is looked at once more.
  if s.referral_enabled then
    for j in
      select * from public.friend_invite_joins jj
       where jj.link_id = p_link.id
         -- A join made while the programme was closed never counts, even after it reopens.
         and public.referral_was_open(jj.created_at)
         -- A join past its payment window (and two days of settle lag) can no longer qualify: not looked at again.
         and jj.created_at >= now() - make_interval(days => s.referral_qualify_days + 2)
         and not exists (select 1 from public.referral_rewards x
                          where x.invitee_id = jj.invitee_id or x.invitee_email_key = jj.email_key)
       order by jj.created_at, jj.id
    loop
      -- Anchored on the friend's ACCOUNT (0092 admits only an account made at most 3 days before it joins): a join recorded
      -- late, after the friend already made a workspace and paid, does not void that workspace.
      select u.created_at into born from auth.users u where u.id = j.invitee_id;
      continue when born is null;
      -- The friend's workspace: one they CREATED after their account was made and owned before paying, and its FIRST
      -- payment ever. Rows that are not payments (no full-price, positive-money provider event: a $0 trial, a promo, a
      -- discount) are skipped and use up nothing. An older workspace that promotes a new account to owner never qualifies.
      select tx.* into t
        from public.organizations o
        join public.org_members own on own.org_id = o.id and own.user_id = j.invitee_id and own.role = 'owner'
        join public.credit_transactions tx on tx.org_id = o.id
       where o.created_by = j.invitee_id
         and o.created_at >= born
         and o.id <> p_link.org_id
         and not public.credits_exempt(o.id)
         and own.created_at <= tx.created_at
         and tx.kind in ('purchase', 'subscription')
         and tx.external_id is not null
         and public.referral_payment_paid(tx.external_id)
         and not exists (select 1 from public.credit_transactions p
                          where p.org_id = o.id and p.kind in ('purchase', 'subscription') and p.external_id is not null
                            and (p.created_at < tx.created_at or (p.created_at = tx.created_at and p.id < tx.id))
                            and public.referral_payment_paid(p.external_id))
       order by tx.created_at, tx.id
       limit 1;
      continue when t.id is null;
      -- That first payment, and only it, decides: big enough, within the window from the account, made while the programme
      -- was open, not already a referral, and (in USD) at least half the minimum's base price.
      continue when t.amount < s.referral_min_credits
                 or t.created_at < born
                 or t.created_at >= born + make_interval(days => s.referral_qualify_days)
                 or not public.referral_was_open(t.created_at)
                 or exists (select 1 from public.referral_rewards x where x.purchase_external_id = t.external_id)
                 or exists (select 1 from public.payment_events e
                             where e.transaction_id = t.external_id and e.currency = 'USD'
                               and e.status in ('processed', 'duplicate')
                               and e.amount_minor < ceil(s.referral_min_credits / 2));

      member := exists (select 1 from public.org_members om where om.org_id = t.org_id and om.user_id = p_link.user_id)
                or exists (select 1 from public.org_members om where om.org_id = p_link.org_id and om.user_id = j.invitee_id);
      -- The one payer identity the platform keeps: a subscription's customer at the payment provider.
      same := exists (
        select 1 from public.subscriptions a
          join public.subscriptions b on b.provider = a.provider and b.provider_customer_id = a.provider_customer_id
         where a.org_id = t.org_id and a.provider_customer_id is not null
           and (b.org_id = p_link.org_id
                or exists (select 1 from public.org_members om where om.org_id = b.org_id and om.user_id = p_link.user_id)));

      insert into public.referral_rewards
        (invitee_id, invitee_email_key, join_id, referrer_id, link_id, org_id, invitee_org_id,
         purchase_external_id, purchase_kind, purchased_at, credits, status, void_reason, release_at)
      values
        (j.invitee_id, j.email_key, j.id, p_link.user_id, p_link.id, p_link.org_id, t.org_id,
         t.external_id, t.kind, t.created_at, s.referral_credits,
         case when member or same then 'void' else 'held' end,
         case when member then 'member' when same then 'same_payer' end,
         t.created_at + make_interval(days => s.referral_hold_days))
      on conflict do nothing;
      if found then
        changed := changed + 1;
      end if;
    end loop;
  end if;

  -- 2. A payment reversed during the hold: the referral is void, and is never paid.
  update public.referral_rewards x
     set status = 'void', void_reason = 'refunded', reversed_by = public.referral_payment_reversed(x.purchase_external_id),
         updated_at = now()
   where x.referrer_id = p_link.user_id and x.status = 'held'
     and public.referral_payment_reversed(x.purchase_external_id) is not null;
  get diagnostics m = row_count;
  changed := changed + m;

  -- 3. Pay what is due, oldest first, while this referrer's month and the platform's day have room.
  select count(*) into m from public.referral_rewards
   where referrer_id = p_link.user_id and paid_at >= month0;
  for r in
    select * from public.referral_rewards x
     where x.referrer_id = p_link.user_id and x.status = 'held' and x.release_at <= now()
     order by x.release_at, x.invitee_id
  loop
    -- Looked at again at the moment of paying: a reversal or a membership that appeared since step 2.
    rev := public.referral_payment_reversed(r.purchase_external_id);
    if rev is not null then
      update public.referral_rewards set status = 'void', void_reason = 'refunded', reversed_by = rev, updated_at = now()
       where invitee_id = r.invitee_id;
      changed := changed + 1;
      continue;
    end if;
    if exists (select 1 from public.org_members om where om.org_id = r.invitee_org_id and om.user_id = p_link.user_id)
       or exists (select 1 from public.org_members om where om.org_id = r.org_id and om.user_id = r.invitee_id) then
      update public.referral_rewards set status = 'void', void_reason = 'member', updated_at = now()
       where invitee_id = r.invitee_id;
      changed := changed + 1;
      continue;
    end if;
    exit when m >= s.referral_monthly_cap;
    -- One platform-wide lock for the day's cap: two referrers paid together count each other.
    perform pg_advisory_xact_lock(hashtextextended('referral_rewards', 0));
    exit when (select count(*) from public.referral_rewards where paid_at >= day0) >= s.referral_daily_cap;
    marker := 'referral-reward:' || r.ref::text;
    begin
      acc := public.credit_account_lock(r.org_id);
      update public.credit_accounts
         set balance = balance + r.credits, updated_at = now()
       where org_id = r.org_id
      returning * into acc;
      -- Authored by the referrer, like 0092's reward: in pg_cron or the service role auth.uid() is nobody.
      insert into public.credit_transactions
        (org_id, kind, amount, balance_after, reserved_after, external_id, note, created_by)
      values
        (r.org_id, 'grant', r.credits, acc.balance, acc.reserved, marker, 'referral reward', p_link.user_id);
      update public.referral_rewards set status = 'paid', paid_at = now(), updated_at = now()
       where invitee_id = r.invitee_id;
    exception when unique_violation then
      -- The ledger already holds this reward (written outside this function): this subtransaction, balance included, is
      -- undone, and the row says what the ledger says rather than being paid again.
      update public.referral_rewards
         set status = 'paid', updated_at = now(),
             paid_at = (select created_at from public.credit_transactions where external_id = marker)
       where invitee_id = r.invitee_id;
    end;
    m := m + 1;
    changed := changed + 1;
  end loop;

  -- 4. A payment reversed after the reward was paid: take it back, from the reward's own lot first, as far as credits are
  --    available; what is not is still owed, and every later settle takes more until nothing is owed.
  for r in
    select * from public.referral_rewards x
     where x.referrer_id = p_link.user_id
       and (x.status = 'clawing'
            or (x.status = 'paid' and public.referral_payment_reversed(x.purchase_external_id) is not null))
     order by x.paid_at, x.invitee_id
  loop
    -- The same order as step 3: the advisory lock before the account.
    perform pg_advisory_xact_lock(hashtextextended('referral_rewards', 0));
    perform public.credit_account_lock(r.org_id);
    -- Lots past their date first (0034), so "available" is what the lots can actually give back.
    perform public.credit_expire_lots_locked(r.org_id);
    select * into acc from public.credit_accounts where org_id = r.org_id;
    owed := case when r.status = 'clawing' then r.claw_shortfall else r.credits end;
    taken := least(owed, greatest(acc.balance - acc.reserved, 0));
    if taken > 0 then
      update public.credit_accounts
         set balance = balance - taken, updated_at = now()
       where org_id = r.org_id
      returning * into acc;
      -- The lot trigger (0034, one hunk in this file) spends the reward's own lot first for this row.
      perform set_config('nightshift.adjust_lot_first', 'referral-reward:' || r.ref::text, true);
      -- Authored by nobody (the platform), with the reason in the note: the referrer did not take these credits.
      insert into public.credit_transactions
        (org_id, kind, amount, balance_after, reserved_after, external_id, note, created_by)
      values
        (r.org_id, 'adjust', -taken, acc.balance, acc.reserved,
         'referral-clawback:' || r.ref::text || ':' || (r.claw_n + 1)::text,
         case when taken < owed
              then format('system: referral reward taken back after the payment was reversed: %s of %s credits now, %s still owed',
                          taken, owed, owed - taken)
              else format('system: referral reward taken back after the payment was reversed: %s credits', taken) end,
         null);
      perform set_config('nightshift.adjust_lot_first', '', true);
    end if;
    update public.referral_rewards
       set status = case when owed - taken > 0 then 'clawing' else 'clawed' end,
           clawed = r.clawed + taken,
           claw_shortfall = owed - taken,
           claw_n = r.claw_n + case when taken > 0 then 1 else 0 end,
           clawed_at = coalesce(r.clawed_at, now()),
           reversed_by = coalesce(r.reversed_by, public.referral_payment_reversed(r.purchase_external_id)),
           updated_at = now()
     where invitee_id = r.invitee_id;
    if r.status = 'paid' or taken > 0 then
      changed := changed + 1;
    end if;
  end loop;

  return changed;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The referrer's side
-- ───────────────────────────────────────────────────────────────────────────

-- The caller's own link and referral counts. Counts and the programme's numbers only: never a friend's id, mailbox,
-- workspace, payment, amount or the time of a payment (the next hold's end is a day, not a moment).
create or replace function public.my_referrals() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  uid    uuid := auth.uid();
  s      public.friend_invite_settings;
  l      public.friend_invite_links;
  mr     public.friend_invite_rewards;
  month0 timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into s from public.friend_invite_settings;
  select * into l from public.friend_invite_links where user_id = uid;
  select * into mr from public.friend_invite_rewards where user_id = uid;
  return jsonb_build_object(
    -- Open = the reward is on and links work (0092's switch).
    'enabled', s.referral_enabled and s.enabled,
    'credits', s.referral_credits,
    'min_credits', s.referral_min_credits,
    'hold_days', s.referral_hold_days,
    'qualify_days', s.referral_qualify_days,
    'monthly_cap', s.referral_monthly_cap,
    'link', case when l.id is null then null
                 else jsonb_build_object('token', l.token, 'created_at', l.created_at) end,
    -- Where rewards are added: the workspace the link was made in (it may not be the one on screen).
    'org', case when l.id is null then null
                else (select jsonb_build_object('id', o.id, 'name', o.name) from public.organizations o where o.id = l.org_id) end,
    'joined', case when l.id is null then 0
                   else (select count(*) from public.friend_invite_joins where link_id = l.id) end,
    'held', (select count(*) from public.referral_rewards where referrer_id = uid and status = 'held'),
    'due', (select count(*) from public.referral_rewards where referrer_id = uid and status = 'held' and release_at <= now()),
    'next_release_on', (select to_char(min(release_at) at time zone 'UTC', 'YYYY-MM-DD') from public.referral_rewards
                         where referrer_id = uid and status = 'held' and release_at > now()),
    'paid', (select count(*) from public.referral_rewards where referrer_id = uid and status = 'paid'),
    'earned', (select coalesce(sum(credits), 0) from public.referral_rewards where referrer_id = uid and status = 'paid'),
    'paid_this_month', (select count(*) from public.referral_rewards where referrer_id = uid and paid_at >= month0),
    'clawed', (select count(*) from public.referral_rewards where referrer_id = uid and status in ('clawing', 'clawed')),
    'clawed_credits', (select coalesce(sum(clawed), 0) from public.referral_rewards
                        where referrer_id = uid and status in ('clawing', 'clawed')),
    'claw_owed', (select coalesce(sum(claw_shortfall), 0) from public.referral_rewards where referrer_id = uid and status = 'clawing'),
    'void', (select count(*) from public.referral_rewards where referrer_id = uid and status = 'void'),
    'milestone_credits', mr.credits);
end
$$;

-- The caller's own referrals settled now (the Credits page, server-side), then read. At most 60 settles an hour a person
-- (take_web_rate, 0042): past that, the answer is the plain read.
create or replace function public.claim_referral_rewards() returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  l   public.friend_invite_links;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if public.take_web_rate('referral.claim', 60, 3600) then
    select * into l from public.friend_invite_links where user_id = uid for update;
    if l.id is not null then
      perform public.referral_settle_locked(l);
      update public.friend_invite_links set referral_settled_at = now() where id = l.id;
    end if;
  end if;
  return public.my_referrals();
end
$$;

-- The public terms page: the switch and the numbers, nothing about any person. new_account_days is join_friend_invite's
-- "made no more than 3 days ago" (0092, a constant of its body, not a setting); tests/test_referral_rewards_migration.py
-- keeps the two equal, so the terms never state a rule the join does not apply.
create or replace function public.referral_terms() returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'enabled', s.referral_enabled and s.enabled,
    'credits', s.referral_credits,
    'min_credits', s.referral_min_credits,
    'hold_days', s.referral_hold_days,
    'qualify_days', s.referral_qualify_days,
    'monthly_cap', s.referral_monthly_cap,
    'daily_cap', s.referral_daily_cap,
    'link_hourly_cap', s.link_hourly_cap,
    'new_account_days', 3,
    'updated_at', s.referral_updated_at)
    from public.friend_invite_settings s
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The operator's side
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.referral_admin() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s      public.friend_invite_settings;
  run    public.referral_settle_runs;
  sched  boolean := false;
  day0   timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  month0 timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
begin
  if not public.is_platform_admin() then
    raise exception 'only a platform owner or admin may read this' using errcode = '42501';
  end if;
  select * into s from public.friend_invite_settings;
  select * into run from public.referral_settle_runs order by started_at desc, id desc limit 1;
  -- Read dynamically: cron.job exists only where pg_cron is installed.
  if to_regclass('cron.job') is not null then
    execute 'select exists (select 1 from cron.job where jobname = $1)' into sched using 'nightshift-referral-settle';
  end if;
  return jsonb_build_object(
    'enabled', s.referral_enabled,
    'links_open', s.enabled,
    'milestone_enabled', s.milestone_enabled,
    'open_since', (select opened_at from public.referral_open_periods where closed_at is null),
    'credits', s.referral_credits,
    'min_credits', s.referral_min_credits,
    'hold_days', s.referral_hold_days,
    'qualify_days', s.referral_qualify_days,
    'monthly_cap', s.referral_monthly_cap,
    'daily_cap', s.referral_daily_cap,
    'updated_at', s.referral_updated_at,
    'schedule', sched,
    'last_run', case when run.id is null then null
                     else jsonb_build_object('at', run.finished_at, 'links', run.links, 'changed', run.changed,
                                             'failed', run.failed, 'error', run.error) end,
    'runs_failed_24h', (select count(*) from public.referral_settle_runs where failed > 0 and started_at > now() - interval '24 hours'),
    'links', (select count(*) from public.friend_invite_links),
    'joins', (select count(*) from public.friend_invite_joins),
    'held', (select count(*) from public.referral_rewards where status = 'held'),
    'due', (select count(*) from public.referral_rewards where status = 'held' and release_at <= now()),
    'paid', (select count(*) from public.referral_rewards where status = 'paid'),
    'paid_today', (select count(*) from public.referral_rewards where paid_at >= day0),
    'credits_month', coalesce((select sum(credits) from public.referral_rewards where paid_at >= month0), 0),
    'credits_total', coalesce((select sum(credits) from public.referral_rewards where status in ('paid', 'clawing', 'clawed')), 0),
    'void_refunded', (select count(*) from public.referral_rewards where void_reason = 'refunded'),
    'void_same_payer', (select count(*) from public.referral_rewards where void_reason = 'same_payer'),
    'void_member', (select count(*) from public.referral_rewards where void_reason = 'member'),
    'clawed', (select count(*) from public.referral_rewards where status in ('clawing', 'clawed')),
    'claw_owed', coalesce((select sum(claw_shortfall) from public.referral_rewards where status = 'clawing'), 0),
    'reversed_by_event', (select count(*) from public.referral_rewards where reversed_by = 'event'),
    -- Referrals whose link is gone (the referrer's account was deleted): no longer settled, an operator's decision.
    'orphaned', (select count(*) from public.referral_rewards x
                  where x.status in ('held', 'paid', 'clawing')
                    and not exists (select 1 from public.friend_invite_links l where l.id = x.link_id)),
    'milestone_rewards', (select count(*) from public.friend_invite_rewards));
end
$$;

-- The money settings: the platform owner/admin, through owner_guard (0107: the second factor when the owner switched the gate
-- on, and a rate limit), with the old and the new values written to the audit trail and the security events in the same
-- transaction. Answers referral_admin(), or owner_guard's refusal ({ok: false, error, message}).
create or replace function public.set_referral_settings(
  p_enabled boolean, p_milestone_enabled boolean, p_credits numeric, p_min_credits numeric,
  p_hold_days integer, p_qualify_days integer, p_monthly_cap integer, p_daily_cap integer
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  g      jsonb;
  s      public.friend_invite_settings;
  n      public.friend_invite_settings;
  c      numeric := public.credits_round_up(p_credits);
  mn     numeric := public.credits_round_up(p_min_credits);
  detail jsonb;
begin
  g := public.owner_guard('referral_settings', 10);
  if g is not null then
    return g;
  end if;
  if p_enabled is null or p_milestone_enabled is null
     or c is null or c <= 0 or c > 100000
     or mn is null or mn < 1 or mn > 1000000 or c > mn
     or p_hold_days is null or p_hold_days not between 7 and 180
     or p_qualify_days is null or p_qualify_days not between 1 and 365
     or p_monthly_cap is null or p_monthly_cap not between 1 and 1000
     or p_daily_cap is null or p_daily_cap not between 0 and 10000 then
    raise exception 'a setting is out of range' using errcode = '22023';
  end if;
  select * into s from public.friend_invite_settings for update;
  update public.friend_invite_settings
     set referral_enabled = p_enabled,
         -- A reward needs joins: turning it on also opens links (0092's switch). Turning it off leaves links as they are.
         enabled = enabled or p_enabled,
         milestone_enabled = p_milestone_enabled,
         referral_credits = c,
         referral_min_credits = mn,
         referral_hold_days = p_hold_days,
         referral_qualify_days = p_qualify_days,
         referral_monthly_cap = p_monthly_cap,
         referral_daily_cap = p_daily_cap,
         -- The public terms are dated by this: it moves only when something a referrer is promised moves.
         referral_updated_at = case
           when (s.referral_enabled, s.referral_credits, s.referral_min_credits, s.referral_hold_days, s.referral_qualify_days,
                 s.referral_monthly_cap, s.referral_daily_cap)
                is distinct from (p_enabled, c, mn, p_hold_days, p_qualify_days, p_monthly_cap, p_daily_cap)
           then now() else s.referral_updated_at end,
         updated_by = auth.uid(),
         updated_at = now()
   where id
  returning * into n;
  -- The open periods: off -> on opens one, on -> off closes it. A join or a payment counts only inside one.
  if p_enabled and not s.referral_enabled then
    insert into public.referral_open_periods (opened_at, opened_by) values (now(), auth.uid());
  elsif s.referral_enabled and not p_enabled then
    update public.referral_open_periods set closed_at = now(), closed_by = auth.uid() where closed_at is null;
  end if;
  detail := jsonb_build_object(
    'period', case when p_enabled and not s.referral_enabled then 'opened'
                   when s.referral_enabled and not p_enabled then 'closed' end,
    'old', jsonb_build_object('referral_enabled', s.referral_enabled, 'links_open', s.enabled, 'milestone_enabled', s.milestone_enabled,
                              'credits', s.referral_credits, 'min_credits', s.referral_min_credits, 'hold_days', s.referral_hold_days,
                              'qualify_days', s.referral_qualify_days, 'monthly_cap', s.referral_monthly_cap,
                              'daily_cap', s.referral_daily_cap),
    'new', jsonb_build_object('referral_enabled', n.referral_enabled, 'links_open', n.enabled, 'milestone_enabled', n.milestone_enabled,
                              'credits', n.referral_credits, 'min_credits', n.referral_min_credits, 'hold_days', n.referral_hold_days,
                              'qualify_days', n.referral_qualify_days, 'monthly_cap', n.referral_monthly_cap,
                              'daily_cap', n.referral_daily_cap));
  -- The two records 0107's owner actions write (owner_audit), under an action the audit allow-list already has.
  insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id)
  values (auth.uid(), 'billing.settings', 'referral programme', detail, null);
  perform public.security_event_log('referral.settings', 'critical', 'referral programme', detail);
  return public.referral_admin();
end
$$;

-- The n links settled longest ago, one after another; a link another call holds is skipped and comes first next time. One
-- referrer's failure is counted (and named, without any token) and does not stop the others. Every call leaves one row in
-- referral_settle_runs (kept 30 days), which the operator's panel reads.
create or replace function public.referral_settle_all(p_limit integer default 50) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  l       public.friend_invite_links;
  t0      timestamptz := clock_timestamp();
  links   integer := 0;
  changed integer := 0;
  failed  integer := 0;
  err     text;
begin
  if not public.credits_trusted_caller() then
    raise exception 'referrals are settled by the platform only' using errcode = '42501';
  end if;
  for l in
    select * from public.friend_invite_links fl
     where exists (select 1 from public.friend_invite_joins j where j.link_id = fl.id)
     order by fl.referral_settled_at nulls first, fl.id
     limit greatest(1, least(coalesce(p_limit, 50), 500))
     for update skip locked
  loop
    links := links + 1;
    begin
      changed := changed + public.referral_settle_locked(l);
    exception when others then
      failed := failed + 1;
      err := left(format('link %s: %s %s', l.id, sqlstate, sqlerrm), 500);
      raise warning 'referral_settle_all: %', err;
    end;
    update public.friend_invite_links set referral_settled_at = now() where id = l.id;
  end loop;
  insert into public.referral_settle_runs (started_at, finished_at, links, changed, failed, error)
  values (t0, clock_timestamp(), links, changed, failed, err);
  delete from public.referral_settle_runs where started_at < now() - interval '30 days';
  return jsonb_build_object('links', links, 'changed', changed, 'failed', failed);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Who may call what
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.friend_invite_pay_locked(public.friend_invite_links) from public, anon, authenticated, service_role;
revoke all on function public.my_friend_invite() from public, anon, service_role;
grant execute on function public.my_friend_invite() to authenticated;
revoke all on function public.join_friend_invite(text) from public, anon, service_role;
grant execute on function public.join_friend_invite(text) to authenticated;
revoke all on function public.credit_transactions_apply_lots() from public, anon, authenticated, service_role;

revoke all on function public.referral_payment_reversed(text) from public, anon, authenticated, service_role;
revoke all on function public.referral_payment_paid(text) from public, anon, authenticated, service_role;
revoke all on function public.referral_was_open(timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.referral_settle_locked(public.friend_invite_links) from public, anon, authenticated, service_role;
revoke all on function public.claim_referral_rewards() from public, anon, service_role;
revoke all on function public.my_referrals() from public, anon, service_role;
revoke all on function public.referral_admin() from public, anon, service_role;
revoke all on function public.set_referral_settings(boolean, boolean, numeric, numeric, integer, integer, integer, integer)
  from public, anon, service_role;
grant execute on function public.claim_referral_rewards() to authenticated;
grant execute on function public.my_referrals() to authenticated;
grant execute on function public.referral_admin() to authenticated;
grant execute on function public.set_referral_settings(boolean, boolean, numeric, numeric, integer, integer, integer, integer)
  to authenticated;

revoke all on function public.referral_terms() from public, service_role;
grant execute on function public.referral_terms() to anon, authenticated;

revoke all on function public.referral_settle_all(integer) from public, anon, authenticated;
grant execute on function public.referral_settle_all(integer) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. Every 5 minutes, when pg_cron is enabled (the referrer's own Credits page settles too)
-- ───────────────────────────────────────────────────────────────────────────

do $$
begin
  if to_regprocedure('cron.schedule(text, text, text)') is not null
     and to_regprocedure('cron.unschedule(text)') is not null
     and to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'nightshift-referral-settle') then
      perform cron.unschedule('nightshift-referral-settle');
    end if;
    perform cron.schedule('nightshift-referral-settle', '*/5 * * * *', 'select public.referral_settle_all(50)');
  else
    raise notice '0165: pg_cron is not enabled, so no schedule was created; the operator panel says so. Enable pg_cron and run 0165 again to create it';
  end if;
exception when others then
  -- All or nothing: a failed schedule undoes the unschedule above (this block is one subtransaction).
  raise notice '0165: pg_cron schedule not created (%); the operator panel says so', sqlerrm;
end $$;

-- Verify (run after applying; every column should read true):
--   select
--     (select not referral_enabled and not milestone_enabled from public.friend_invite_settings) as both_switches_off,
--     not exists (select 1 from public.referral_open_periods where closed_at is null) as never_open_yet,
--     (select bool_and(relrowsecurity) from pg_class
--       where oid in ('public.referral_rewards'::regclass, 'public.referral_settle_runs'::regclass,
--                     'public.referral_open_periods'::regclass)) as rls_on,
--     not exists (select 1 from information_schema.role_table_grants
--                  where table_schema = 'public' and table_name in ('referral_rewards', 'referral_settle_runs', 'referral_open_periods')
--                    and grantee in ('anon', 'authenticated', 'public', 'service_role')) as no_table_grants,
--     has_function_privilege('anon', 'public.referral_terms()', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.my_referrals()', 'EXECUTE')
--       and has_function_privilege('authenticated', 'public.claim_referral_rewards()', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.referral_settle_all(integer)', 'EXECUTE')
--       and has_function_privilege('service_role', 'public.referral_settle_all(integer)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.referral_settle_locked(public.friend_invite_links)', 'EXECUTE')
--       as acl_ok,
--     exists (select 1 from pg_trigger where tgrelid = 'public.credit_transactions'::regclass
--              and tgname = 'credit_transactions_append_only') as ledger_still_append_only;
