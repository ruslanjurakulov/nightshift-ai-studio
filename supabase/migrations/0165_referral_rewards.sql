-- 0165_referral_rewards.sql — the referral programme: a person who invites a friend earns credits when the friend's first
-- qualifying PAYMENT has cleared a hold, not when the friend signs up. Owner decision 2026-11-14. docs/MIGRATIONS.md "0165".
--
-- *** LIVE ON APPLY, AND PAYS NOTHING UNTIL THE OPERATOR SAYS SO. *** The programme's switch is 0092's
-- friend_invite_settings.enabled (default OFF). No payment path is touched: no webhook function, no ledger function, no trigger
-- on the ledger or the refunds is added or changed. A referral is judged by READING the ledger (0020/0034) and the refunds
-- (0021) afterwards, under the referrer's own link lock, so a webhook that is slow, retried or failing is exactly as safe as it
-- was before this file.
--
-- WHY (rule 8: the evidence, then the change). 0092 pays 100 credits once five new, e-mail-confirmed people have joined through
-- a link. That reward is earned by sign-ups alone, and docs/security/LEDGER.md BR-S-010 records the consequence: five throwaway
-- but confirmed mailboxes earn it, once per account a person controls. A reward that needs a friend's real payment, held long
-- enough to see a refund, cannot be farmed with mailboxes.
--
-- THE RULE (enforced here, not in the app)
--   * A friend is someone who joined through the link under 0092's rules, unchanged: a NEW account (made after the link, at most
--     3 days before it confirmed), e-mail confirmed, not the link's owner, not the owner's mailbox (gmail dots, +tags and
--     googlemail.com folded), one account and one mailbox once, at most link_hourly_cap joins per link per hour.
--   * The friend qualifies with their FIRST payment of at least referral_min_credits credits (default 1000, the Starter pack)
--     within referral_qualify_days (default 60) of joining: a 'purchase' or 'subscription' row of the ledger (only the payment
--     webhooks write those kinds, through add_purchased_credits / grant_subscription_credits[_for], service role only), in a
--     workspace the friend OWNS, that the referrer is not a member of, and that pays (not the operator's own, credits_exempt).
--     The earliest such payment decides, once: a referral is one row per friend for good (primary key on the friend's account,
--     unique on the friend's mailbox, unique on the payment), so refund-and-pay-again, a second workspace or a deleted and
--     re-made account does not qualify a second time.
--   * Same payer: when the friend's workspace and one of the referrer's workspaces have a subscription with the same payment
--     provider customer id (the only payer identity the platform stores: subscriptions.provider_customer_id, 0034/0146), the
--     referral is void ('same_payer'). One-time pack payments carry no payer identity in this database, and there is no
--     device signal anywhere in it; those two checks cannot run, and nothing here pretends they did.
--   * The reward (referral_credits, default 200; never more than referral_min_credits — a CHECK, so a reward can never exceed
--     the payment that earned it) is HELD for referral_hold_days (default 30) after the payment. A refund or chargeback of that
--     payment (any credit_refunds row for its external id, 0021) during the hold voids it ('refunded'); it is never paid.
--   * After the hold it is paid into the workspace the referrer made the link in: one 'grant' row through the ledger,
--     external_id 'referral-reward:<referral ref>' (the ledger's unique external_id, 0020, is the idempotency key; the ref is
--     a random uuid of this file's row, so the referrer's ledger never carries the friend's account id), authored by the
--     referrer, an ordinary grant lot (0034). At most referral_monthly_cap (default 10) rewards per referrer per UTC calendar
--     month, and at most referral_daily_cap (default 50) across the platform per UTC day: a reward that is due when either is
--     full stays held and is paid as soon as there is room. Nothing is lost, nothing is paid twice.
--   * Clawback: a refund or chargeback that arrives AFTER the reward was paid takes the reward back once — at most what the
--     referrer's workspace has available (balance - reserved, after expiring what is past its date), like 0021's refunds; the
--     part already spent is recorded as claw_shortfall, never a negative balance. One 'adjust' row, external_id
--     'referral-clawback:<ref>'.
--   * The 0092 sign-up milestone is now a switch of its own, milestone_enabled: OFF on a fresh database and on one where the
--     programme was off when this file applied; ON only where the operator had the programme running then, so applying this
--     file never changes the rules of a programme that is live. The operator turns it off (or on) in the same panel.
--   * Closing the programme (enabled off) qualifies no new referral; rewards already held are still paid when their hold ends,
--     and refunds still void and claw back.
--
-- WHEN IT RUNS. Each referrer's referrals are settled by referral_settle_locked(), under that referrer's link row lock
-- (select ... for update — the same lock 0092's joins take), so two settles for one referrer run one after another:
--   claim_referral_rewards()  the referrer's own Credits page (server-side, the member's session), then reads my_referrals();
--   referral_settle_all()     every link, hourly, by pg_cron when it is installed (job 'nightshift-referral-settle'); the
--                             service role may call it too. Busy links are skipped (skip locked) and done next time.
-- Lock order everywhere: the link row, then the advisory lock of the daily cap, then the workspace's credit account.
--
-- WHAT IT ADDS
--   friend_invite_settings     + milestone_enabled, referral_credits, referral_min_credits, referral_hold_days,
--                                referral_qualify_days, referral_monthly_cap, referral_daily_cap, referral_updated_at.
--   referral_rewards           one row per friend who made a qualifying payment: held | paid | void | clawed. RLS on, no
--                              policy, every privilege revoked: read only through the functions below.
--   referral_settle_locked(link)            internal (no API role): the rule above, for one referrer.
--   claim_referral_rewards()                AUTHENTICATED: the caller's own referrals settled, then my_referrals().
--   my_referrals()                          AUTHENTICATED: the caller's own link and counts — never a friend's id, mailbox,
--                                           workspace, payment or date of joining.
--   referral_terms()                        ANON and AUTHENTICATED: the programme's switch and numbers, for the public terms.
--   referral_admin()                        a platform owner/admin: the numbers and platform-wide counts.
--   set_referral_settings(...)              a platform owner/admin: the switch, the milestone switch and the numbers.
--   referral_settle_all()                   service role (and pg_cron): every referrer.
-- WHAT IT REPLACES (md5 drift guard: 0092's body, or this file's own on a replay)
--   friend_invite_pay_locked(link)   one hunk: returns 'off' when milestone_enabled is off.
--   my_friend_invite()               one hunk: 'pending' is false while milestone_enabled is off.
-- NOT CHANGED: join_friend_invite, create_friend_invite, claim_friend_invite_reward, friend_invite_peek, friend_invite_admin,
-- set_friend_invite_settings, every payment, ledger, lot and refund function, every trigger, RLS of every existing table.
--
-- NUMBER. 0165 (assigned): 0163 and 0164 are other open pull requests. Needs 0018, 0020, 0021, 0034 and 0092; names nothing of
-- 0100-0164.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; md5 of the body with every run of white space read as one space):
--   select p.oid::regprocedure, md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc p
--    where proname in ('friend_invite_pay_locked', 'my_friend_invite', 'referral_settle_locked', 'claim_referral_rewards',
--                      'my_referrals', 'referral_terms', 'referral_admin', 'set_referral_settings', 'referral_settle_all');
--   expected BEFORE (0092): friend_invite_pay_locked 1cfc1f84f065d73e2cb7e84c18ca6ae2 · my_friend_invite b26806d4fdc88a8453e939087d53184c
--   expected AFTER: the md5 pairs in the guard below (docs/MIGRATIONS.md "0165" lists them too).
--   select enabled from public.friend_invite_settings;   -- true means the 0092 milestone stays ON after this file (see above)
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
  if to_regclass('public.credit_refunds') is null then
    raise exception '0165 needs credit refunds: apply 0021_credit_refunds.sql first';
  end if;
  if to_regclass('public.subscriptions') is null or to_regprocedure('public.credit_expire_lots_locked(uuid)') is null then
    raise exception '0165 needs plans and lots: apply 0034_plans_entitlements.sql first';
  end if;
  if to_regprocedure('public.is_platform_admin()') is null or to_regclass('public.org_members') is null then
    raise exception '0165 needs organizations: apply 0018_organizations.sql first';
  end if;
  -- Each function this file replaces: 0092's body, or this file's own (a replay).
  foreach trio slice 1 in array array[
      ['public.friend_invite_pay_locked(public.friend_invite_links)', '1cfc1f84f065d73e2cb7e84c18ca6ae2', 'eeae5e2f28b289aab7439beabede3a6f'],
      ['public.my_friend_invite()', 'b26806d4fdc88a8453e939087d53184c', '4717561b1b5c47f7e754118f15fa03ea']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(trio[1]);
    if h is null or h <> all (array[trio[2], trio[3]]) then
      raise exception '0165 found % with a body that is neither 0092''s nor 0165''s (md5 %): read the live body first', trio[1], h;
    end if;
  end loop;
  -- Each name this file creates: absent, or this file's own body.
  foreach trio slice 1 in array array[
      ['public.referral_settle_locked(public.friend_invite_links)', '848d0bf6185034b56fb6bf3e417c859e', ''],
      ['public.claim_referral_rewards()', '7bc98186baf5f45c5b2efd210899c5fd', ''],
      ['public.my_referrals()', '54c02346593d9bdaacaf4beed9e7e5da', ''],
      ['public.referral_terms()', '11b11a0e55db31c944ddb3fb15b0d31c', ''],
      ['public.referral_admin()', '0be877b18ac000c7b6991943a1c00316', ''],
      ['public.set_referral_settings(boolean, boolean, numeric, numeric, integer, integer, integer, integer)', 'e711a0e034a7cbd1c40efd805bee2f33', ''],
      ['public.referral_settle_all()', 'ccfeaac4dd7b62f0096b820a48a7ae1b', '']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(trio[1]);
    if h is not null and h <> trio[2] then
      raise exception '0165 found % with a body that is not this file''s (md5 %): read the live body first', trio[1], h;
    end if;
  end loop;
  -- What it reads and builds on, as the repository has them: the ledger's lock and the lots' expiry (0034), the join (0092).
  foreach trio slice 1 in array array[
      ['public.credit_account_lock(uuid)', 'e65c08be376f40a30c02d1a8502bf154', ''],
      ['public.join_friend_invite(text)', '549632bae0dbb002dc66200d7f6c0998', '']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(trio[1]);
    if h is distinct from trio[2] then
      raise exception '0165 found % with a body that is not the one it was written against (md5 %): read the live body first', trio[1], h;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The programme's numbers (one row, 0092)
-- ───────────────────────────────────────────────────────────────────────────

-- The milestone keeps running only where the programme was running when this file applied: added without a default, set from
-- `enabled` once, then given its default. A replay finds the column filled and changes nothing.
alter table public.friend_invite_settings add column if not exists milestone_enabled boolean;
update public.friend_invite_settings set milestone_enabled = enabled where milestone_enabled is null;
alter table public.friend_invite_settings alter column milestone_enabled set default false;
alter table public.friend_invite_settings alter column milestone_enabled set not null;

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

comment on column public.friend_invite_settings.milestone_enabled is
  '0092''s sign-up milestone (required_joins joins pay reward_credits once). Off unless the operator turns it on (0165): sign-ups alone can be farmed with throwaway mailboxes (BR-S-010).';
comment on column public.friend_invite_settings.referral_credits is
  'Credits paid to a referrer per friend whose first qualifying payment cleared the hold (0165). Never above referral_min_credits.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The referrals
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.referral_rewards (
  -- The friend's account and mailbox: one referral per person, for good. No foreign key: the row is a money record and
  -- outlives a deleted account, like friend_invite_rewards (0092).
  invitee_id           uuid primary key,
  invitee_email_key    text not null unique check (invitee_email_key ~ '^[0-9a-f]{64}$'),
  -- The opaque key of the ledger rows ('referral-reward:<ref>', 'referral-clawback:<ref>'): the referrer reads their own
  -- ledger, and it must not name the friend.
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
  status               text not null check (status in ('held', 'paid', 'void', 'clawed')),
  void_reason          text check (void_reason is null or void_reason in ('refunded', 'same_payer')),
  release_at           timestamptz not null,
  paid_at              timestamptz,
  clawed               numeric(14,2) not null default 0 check (clawed >= 0),
  claw_shortfall       numeric(14,2) not null default 0 check (claw_shortfall >= 0),
  clawed_at            timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check ((status = 'void') = (void_reason is not null)),
  check ((status in ('paid', 'clawed')) = (paid_at is not null)),
  check ((status = 'clawed') = (clawed_at is not null)),
  check (clawed + claw_shortfall = case when status = 'clawed' then credits else 0 end)
);
create index if not exists referral_rewards_referrer_idx on public.referral_rewards (referrer_id, status, release_at);
create index if not exists referral_rewards_paid_idx on public.referral_rewards (paid_at) where paid_at is not null;
comment on table public.referral_rewards is
  'One row per friend whose first qualifying payment was seen (0165): held until release_at, then paid (a grant on the referrer''s ledger, external_id referral-reward:<ref>), void (refunded during the hold, or the same payer), or clawed (refunded after it was paid; clawed + claw_shortfall = credits). No API role has a privilege on this table.';
alter table public.referral_rewards enable row level security;
revoke all on public.referral_rewards from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The 0092 milestone gets its own switch (two hunks, nothing else)
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

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Settling one referrer (internal)
-- ───────────────────────────────────────────────────────────────────────────

-- The link row is ALREADY LOCKED by the caller (for update). Qualifies, voids, pays and claws back this referrer's referrals,
-- and returns how many rows changed.
create or replace function public.referral_settle_locked(p_link public.friend_invite_links) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s       public.friend_invite_settings;
  j       public.friend_invite_joins;
  t       public.credit_transactions;
  r       public.referral_rewards;
  acc     public.credit_accounts;
  same    boolean;
  m       integer;
  taken   numeric;
  marker  text;
  changed integer := 0;
  month0  timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  day0    timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
begin
  select * into s from public.friend_invite_settings;

  -- 1. Qualify. While the programme is open, every friend of this link without a referral is looked at: their earliest
  --    payment that qualifies decides, once.
  if s.enabled then
    for j in
      select * from public.friend_invite_joins jj
       where jj.link_id = p_link.id
         and not exists (select 1 from public.referral_rewards x
                          where x.invitee_id = jj.invitee_id or x.invitee_email_key = jj.email_key)
       order by jj.created_at, jj.id
    loop
      -- Driven from the friend's own workspaces (org_members_user_idx, then the ledger's (org_id, created_at) index): a
      -- settle looks at a handful of rows per friend, never the whole ledger.
      select tx.* into t
        from public.org_members own
        join public.credit_transactions tx on tx.org_id = own.org_id
       where own.user_id = j.invitee_id and own.role = 'owner'
         and tx.kind in ('purchase', 'subscription')
         and tx.amount >= s.referral_min_credits
         and tx.external_id is not null
         and tx.created_at >= j.created_at
         and tx.created_at < j.created_at + make_interval(days => s.referral_qualify_days)
         and tx.org_id <> p_link.org_id
         and not public.credits_exempt(tx.org_id)
         and not exists (select 1 from public.org_members om
                          where om.org_id = tx.org_id and om.user_id = p_link.user_id)
         and not exists (select 1 from public.referral_rewards x where x.purchase_external_id = tx.external_id)
       order by tx.created_at, tx.id
       limit 1;
      continue when t.id is null;

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
         case when same then 'void' else 'held' end, case when same then 'same_payer' end,
         t.created_at + make_interval(days => s.referral_hold_days))
      on conflict do nothing;
      if found then
        changed := changed + 1;
      end if;
    end loop;
  end if;

  -- 2. A refund or chargeback of the payment during the hold: the referral is void, and is never paid.
  update public.referral_rewards x
     set status = 'void', void_reason = 'refunded', updated_at = now()
   where x.referrer_id = p_link.user_id and x.status = 'held'
     and exists (select 1 from public.credit_refunds f where f.purchase_external_id = x.purchase_external_id);
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

  -- 4. A refund or chargeback after the reward was paid takes it back, once, as far as the credits are still there.
  for r in
    select * from public.referral_rewards x
     where x.referrer_id = p_link.user_id and x.status = 'paid'
       and exists (select 1 from public.credit_refunds f where f.purchase_external_id = x.purchase_external_id)
     order by x.paid_at, x.invitee_id
  loop
    perform public.credit_account_lock(r.org_id);
    -- Lots past their date first (0034), so "available" is what the lots can actually give back.
    perform public.credit_expire_lots_locked(r.org_id);
    select * into acc from public.credit_accounts where org_id = r.org_id;
    taken := least(r.credits, greatest(acc.balance - acc.reserved, 0));
    update public.credit_accounts
       set balance = balance - taken, updated_at = now()
     where org_id = r.org_id
    returning * into acc;
    insert into public.credit_transactions
      (org_id, kind, amount, balance_after, reserved_after, external_id, note, created_by)
    values
      (r.org_id, 'adjust', -taken, acc.balance, acc.reserved, 'referral-clawback:' || r.ref::text,
       case when taken < r.credits
            then format('referral reward taken back after a refund: %s of %s credits (%s already spent, not recovered)',
                        taken, r.credits, r.credits - taken)
            else format('referral reward taken back after a refund: %s credits', taken) end,
       p_link.user_id);
    update public.referral_rewards
       set status = 'clawed', clawed = taken, claw_shortfall = r.credits - taken, clawed_at = now(), updated_at = now()
     where invitee_id = r.invitee_id;
    changed := changed + 1;
  end loop;

  return changed;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The referrer's side
-- ───────────────────────────────────────────────────────────────────────────

-- The caller's own link and referral counts. Counts and the programme's numbers only: never a friend's id, mailbox,
-- workspace, payment, amount or date.
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
    'enabled', s.enabled,
    'credits', s.referral_credits,
    'min_credits', s.referral_min_credits,
    'hold_days', s.referral_hold_days,
    'qualify_days', s.referral_qualify_days,
    'monthly_cap', s.referral_monthly_cap,
    'link', case when l.id is null then null
                 else jsonb_build_object('token', l.token, 'created_at', l.created_at) end,
    'joined', case when l.id is null then 0
                   else (select count(*) from public.friend_invite_joins where link_id = l.id) end,
    'held', (select count(*) from public.referral_rewards where referrer_id = uid and status = 'held'),
    'due', (select count(*) from public.referral_rewards where referrer_id = uid and status = 'held' and release_at <= now()),
    'next_release_at', (select min(release_at) from public.referral_rewards
                         where referrer_id = uid and status = 'held' and release_at > now()),
    'paid', (select count(*) from public.referral_rewards where referrer_id = uid and status = 'paid'),
    'earned', (select coalesce(sum(credits), 0) from public.referral_rewards where referrer_id = uid and status = 'paid'),
    'paid_this_month', (select count(*) from public.referral_rewards where referrer_id = uid and paid_at >= month0),
    'clawed', (select count(*) from public.referral_rewards where referrer_id = uid and status = 'clawed'),
    'clawed_credits', (select coalesce(sum(clawed), 0) from public.referral_rewards where referrer_id = uid and status = 'clawed'),
    'void', (select count(*) from public.referral_rewards where referrer_id = uid and status = 'void'),
    'milestone_credits', mr.credits);
end
$$;

-- The caller's own referrals settled now (the Credits page, server-side), then read. Nothing to settle without a link.
create or replace function public.claim_referral_rewards() returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  l   public.friend_invite_links;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into l from public.friend_invite_links where user_id = uid for update;
  if l.id is not null then
    perform public.referral_settle_locked(l);
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
    'enabled', s.enabled,
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
  day0   timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  month0 timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
begin
  if not public.is_platform_admin() then
    raise exception 'only a platform owner or admin may read this' using errcode = '42501';
  end if;
  select * into s from public.friend_invite_settings;
  return jsonb_build_object(
    'enabled', s.enabled,
    'milestone_enabled', s.milestone_enabled,
    'credits', s.referral_credits,
    'min_credits', s.referral_min_credits,
    'hold_days', s.referral_hold_days,
    'qualify_days', s.referral_qualify_days,
    'monthly_cap', s.referral_monthly_cap,
    'daily_cap', s.referral_daily_cap,
    'updated_at', s.referral_updated_at,
    'links', (select count(*) from public.friend_invite_links),
    'joins', (select count(*) from public.friend_invite_joins),
    'held', (select count(*) from public.referral_rewards where status = 'held'),
    'due', (select count(*) from public.referral_rewards where status = 'held' and release_at <= now()),
    'paid', (select count(*) from public.referral_rewards where status = 'paid'),
    'paid_today', (select count(*) from public.referral_rewards where paid_at >= day0),
    'credits_month', coalesce((select sum(credits) from public.referral_rewards where paid_at >= month0), 0),
    'credits_total', coalesce((select sum(credits) from public.referral_rewards where status in ('paid', 'clawed')), 0),
    'void_refunded', (select count(*) from public.referral_rewards where void_reason = 'refunded'),
    'void_same_payer', (select count(*) from public.referral_rewards where void_reason = 'same_payer'),
    'clawed', (select count(*) from public.referral_rewards where status = 'clawed'),
    'claw_shortfall', coalesce((select sum(claw_shortfall) from public.referral_rewards where status = 'clawed'), 0),
    'milestone_rewards', (select count(*) from public.friend_invite_rewards));
end
$$;

create or replace function public.set_referral_settings(
  p_enabled boolean, p_milestone_enabled boolean, p_credits numeric, p_min_credits numeric,
  p_hold_days integer, p_qualify_days integer, p_monthly_cap integer, p_daily_cap integer
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s public.friend_invite_settings;
  c numeric := public.credits_round_up(p_credits);
  n numeric := public.credits_round_up(p_min_credits);
begin
  if not public.is_platform_admin() then
    raise exception 'only a platform owner or admin may change this' using errcode = '42501';
  end if;
  if p_enabled is null or p_milestone_enabled is null
     or c is null or c <= 0 or c > 100000
     or n is null or n < 1 or n > 1000000 or c > n
     or p_hold_days is null or p_hold_days not between 7 and 180
     or p_qualify_days is null or p_qualify_days not between 1 and 365
     or p_monthly_cap is null or p_monthly_cap not between 1 and 1000
     or p_daily_cap is null or p_daily_cap not between 0 and 10000 then
    raise exception 'a setting is out of range' using errcode = '22023';
  end if;
  select * into s from public.friend_invite_settings for update;
  update public.friend_invite_settings
     set enabled = p_enabled,
         milestone_enabled = p_milestone_enabled,
         referral_credits = c,
         referral_min_credits = n,
         referral_hold_days = p_hold_days,
         referral_qualify_days = p_qualify_days,
         referral_monthly_cap = p_monthly_cap,
         referral_daily_cap = p_daily_cap,
         -- The public terms are dated by this: it moves only when something a referrer is promised moves.
         referral_updated_at = case
           when (s.enabled, s.referral_credits, s.referral_min_credits, s.referral_hold_days, s.referral_qualify_days,
                 s.referral_monthly_cap, s.referral_daily_cap)
                is distinct from (p_enabled, c, n, p_hold_days, p_qualify_days, p_monthly_cap, p_daily_cap)
           then now() else s.referral_updated_at end,
         updated_by = auth.uid(),
         updated_at = now()
   where id;
  return public.referral_admin();
end
$$;

-- Every referrer, one link at a time; a link another call holds is skipped and done next time. One referrer's failure is
-- reported in the answer (and as a warning in the job's log) and does not stop the others.
create or replace function public.referral_settle_all() returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  l       public.friend_invite_links;
  links   integer := 0;
  changed integer := 0;
  failed  integer := 0;
begin
  if not public.credits_trusted_caller() then
    raise exception 'referrals are settled by the platform only' using errcode = '42501';
  end if;
  for l in
    select * from public.friend_invite_links fl
     where exists (select 1 from public.friend_invite_joins j where j.link_id = fl.id)
     order by fl.id
     for update skip locked
  loop
    links := links + 1;
    begin
      changed := changed + public.referral_settle_locked(l);
    exception when others then
      failed := failed + 1;
      raise warning 'referral_settle_all: link % was not settled (%: %)', l.id, sqlstate, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('links', links, 'changed', changed, 'failed', failed);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Who may call what
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.friend_invite_pay_locked(public.friend_invite_links) from public, anon, authenticated, service_role;
revoke all on function public.my_friend_invite() from public, anon, service_role;
grant execute on function public.my_friend_invite() to authenticated;

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

revoke all on function public.referral_settle_all() from public, anon, authenticated;
grant execute on function public.referral_settle_all() to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. Hourly, when pg_cron is enabled (the referrer's own Credits page settles too)
-- ───────────────────────────────────────────────────────────────────────────

do $$
begin
  if to_regprocedure('cron.schedule(text, text, text)') is not null
     and to_regprocedure('cron.unschedule(text)') is not null
     and to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'nightshift-referral-settle') then
      perform cron.unschedule('nightshift-referral-settle');
    end if;
    perform cron.schedule('nightshift-referral-settle', '41 * * * *', 'select public.referral_settle_all()');
  else
    raise notice '0165: pg_cron is not enabled, so no schedule was created; a referrer''s Credits page still settles their referrals';
  end if;
exception when others then
  -- All or nothing: a failed schedule undoes the unschedule above (this block is one subtransaction).
  raise notice '0165: pg_cron schedule not created (%); a referrer''s Credits page still settles their referrals', sqlerrm;
end $$;

-- Verify (run after applying; every column should read true):
--   select
--     (select count(*) = 1 from public.friend_invite_settings) as one_settings_row,
--     (select relrowsecurity from pg_class where oid = 'public.referral_rewards'::regclass) as rls_on,
--     not exists (select 1 from information_schema.role_table_grants
--                  where table_schema = 'public' and table_name = 'referral_rewards'
--                    and grantee in ('anon', 'authenticated', 'public', 'service_role')) as no_table_grants,
--     has_function_privilege('anon', 'public.referral_terms()', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.my_referrals()', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.claim_referral_rewards()', 'EXECUTE')
--       and has_function_privilege('authenticated', 'public.claim_referral_rewards()', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.referral_settle_all()', 'EXECUTE')
--       and has_function_privilege('service_role', 'public.referral_settle_all()', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.referral_settle_locked(public.friend_invite_links)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.referral_settle_locked(public.friend_invite_links)', 'EXECUTE')
--       as acl_ok,
--     exists (select 1 from pg_trigger where tgrelid = 'public.credit_transactions'::regclass
--              and tgname = 'credit_transactions_append_only') as ledger_still_append_only;
