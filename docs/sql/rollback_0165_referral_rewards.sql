-- rollback_0165_referral_rewards.sql — takes migration 0165 (the referral programme) out again. OWNER-APPLY: paste into the
-- Supabase SQL editor. Nothing in the app runs it.
--
-- WHEN: only before any referral has been recorded. Closing the programme does NOT need this file: switching it off in the
-- operator panel (set_referral_settings, or 0092's set_friend_invite_settings) stops every new referral, and 0165 touches no
-- payment path.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) while referral_rewards holds a row (each is a money record: a reward held, paid, voided or
--      taken back, and the ledger rows that name its ref would lose their explanation), or when a function of 0165 is not
--      0165's body (a later change would be undone).
--   1. Puts 0092's friend_invite_pay_locked and my_friend_invite bodies back, byte for byte, with 0092's grants.
--   2. Unschedules the pg_cron job 'nightshift-referral-settle' when it exists.
--   3. Drops the seven functions 0165 created, referral_rewards, and the eight columns and one check 0165 added to
--      friend_invite_settings.
--   4. Asserts the end state: 0092's two bodies (md5) and none of 0165's names.

begin;
set local lock_timeout = '5s';

do $$
declare
  h text;
  pair text[];
begin
  if to_regclass('public.referral_rewards') is not null and exists (select 1 from public.referral_rewards) then
    raise exception 'rollback 0165: referral rows exist; each is a money record. Keep 0165 (switch the programme off instead)';
  end if;
  foreach pair slice 1 in array array[
      ['public.friend_invite_pay_locked(public.friend_invite_links)', 'eeae5e2f28b289aab7439beabede3a6f'],
      ['public.my_friend_invite()', '4717561b1b5c47f7e754118f15fa03ea'],
      ['public.referral_settle_locked(public.friend_invite_links)', '848d0bf6185034b56fb6bf3e417c859e'],
      ['public.claim_referral_rewards()', '7bc98186baf5f45c5b2efd210899c5fd'],
      ['public.my_referrals()', '54c02346593d9bdaacaf4beed9e7e5da'],
      ['public.referral_terms()', '11b11a0e55db31c944ddb3fb15b0d31c'],
      ['public.referral_admin()', '0be877b18ac000c7b6991943a1c00316'],
      ['public.set_referral_settings(boolean, boolean, numeric, numeric, integer, integer, integer, integer)', 'e711a0e034a7cbd1c40efd805bee2f33'],
      ['public.referral_settle_all()', 'ccfeaac4dd7b62f0096b820a48a7ae1b']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(pair[1]);
    if h is distinct from pair[2] then
      raise exception 'rollback 0165: % is not 0165''s body (md5 %): read the live body first', pair[1], h;
    end if;
  end loop;
end $$;

-- 1. 0092's bodies, as 0092 wrote them.
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
  if not s.enabled then
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
    'pending', r.user_id is null and l.id is not null and n >= s.required_joins
               and not exists (select 1 from public.friend_invite_rewards x
                                where x.email_key = public.friend_invite_mail_key(uid)));
end
$$;

revoke all on function public.friend_invite_pay_locked(public.friend_invite_links) from public, anon, authenticated, service_role;
revoke all on function public.my_friend_invite() from public, anon, service_role;
grant execute on function public.my_friend_invite() to authenticated;

-- 2. The hourly job, when pg_cron has it.
do $$
begin
  -- Nested: cron.job is planned only where pg_cron exists.
  if to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'nightshift-referral-settle') then
      perform cron.unschedule('nightshift-referral-settle');
    end if;
  end if;
end $$;

-- 3. What 0165 created.
drop function if exists public.referral_settle_all();
drop function if exists public.set_referral_settings(boolean, boolean, numeric, numeric, integer, integer, integer, integer);
drop function if exists public.referral_admin();
drop function if exists public.referral_terms();
drop function if exists public.claim_referral_rewards();
drop function if exists public.my_referrals();
drop function if exists public.referral_settle_locked(public.friend_invite_links);
drop table if exists public.referral_rewards;
alter table public.friend_invite_settings drop constraint if exists friend_invite_settings_referral_check;
alter table public.friend_invite_settings drop column if exists referral_updated_at;
alter table public.friend_invite_settings drop column if exists referral_daily_cap;
alter table public.friend_invite_settings drop column if exists referral_monthly_cap;
alter table public.friend_invite_settings drop column if exists referral_qualify_days;
alter table public.friend_invite_settings drop column if exists referral_hold_days;
alter table public.friend_invite_settings drop column if exists referral_min_credits;
alter table public.friend_invite_settings drop column if exists referral_credits;
alter table public.friend_invite_settings drop column if exists milestone_enabled;

-- 4. The end state.
do $$
declare
  h text;
  pair text[];
begin
  foreach pair slice 1 in array array[
      ['public.friend_invite_pay_locked(public.friend_invite_links)', '1cfc1f84f065d73e2cb7e84c18ca6ae2'],
      ['public.my_friend_invite()', 'b26806d4fdc88a8453e939087d53184c']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(pair[1]);
    if h is distinct from pair[2] then
      raise exception 'rollback 0165: % did not end as 0092''s body (md5 %)', pair[1], h;
    end if;
  end loop;
  if to_regclass('public.referral_rewards') is not null or to_regprocedure('public.my_referrals()') is not null then
    raise exception 'rollback 0165: a name of 0165 is still there';
  end if;
end $$;

commit;
