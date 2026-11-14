-- rollback_0165_referral_rewards.sql — takes migration 0165 (the referral programme) out again. OWNER-APPLY: paste into the
-- Supabase SQL editor. Nothing in the app runs it.
--
-- WHEN: only before any referral has been recorded. Closing the programme does NOT need this file: switching the reward off in
-- the operator panel (set_referral_settings) stops every new referral.
--
-- WHAT IT DOES, in one transaction:
--   0. Locks referral_rewards (access exclusive: no settle can add a row between the check and the drop), then REFUSES
--      (changes nothing) while it holds a row (each is a money record: a reward held, paid, voided or taken back, and the
--      ledger rows that name its ref would lose their explanation), or when a function of 0165 is not 0165's body.
--   1. Puts 0092's friend_invite_pay_locked, my_friend_invite and join_friend_invite and 0034's
--      credit_transactions_apply_lots back, byte for byte, with their grants.
--   2. Unschedules the pg_cron job 'nightshift-referral-settle' when it exists.
--   3. Drops the functions, the three tables and the columns 0165 added.
--   4. Asserts the end state: the four earlier bodies (md5) and none of 0165's names.

begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.referral_rewards') is not null then
    lock table public.referral_rewards in access exclusive mode;
  end if;
end $$;

do $$
declare
  h text;
  pair text[];
begin
  if to_regclass('public.referral_rewards') is not null and exists (select 1 from public.referral_rewards) then
    raise exception 'rollback 0165: referral rows exist; each is a money record. Keep 0165 (switch the reward off instead)';
  end if;
  foreach pair slice 1 in array array[
      ['public.friend_invite_pay_locked(public.friend_invite_links)', 'eeae5e2f28b289aab7439beabede3a6f'],
      ['public.my_friend_invite()', '4717561b1b5c47f7e754118f15fa03ea'],
      ['public.join_friend_invite(text)', '8bc6fb874e4e65cf7378bddbfa3768d6'],
      ['public.credit_transactions_apply_lots()', 'fcd28a68b841d8d539d3798f919a0d01'],
      ['public.referral_payment_reversed(text)', 'c7ca11fcf4bf7e283ee77e43d7770a1b'],
      ['public.referral_payment_paid(text)', '0a53c4290c5046ccc3a6accdd46d9e9c'],
      ['public.referral_was_open(timestamptz)', '492d74b160d3bcf29d09a82d288e2a7e'],
      ['public.referral_settle_locked(public.friend_invite_links)', 'aa1546a79a9a655bd278de1fad4d794a'],
      ['public.claim_referral_rewards()', '273fcc22a8e8116b86b57bcf03cf8ddb'],
      ['public.my_referrals()', 'c0ff6ab6e0f6ee0df46c44ddb6b2df8f'],
      ['public.referral_terms()', 'e2be2f76972e1e707e0ce4d52f47cf53'],
      ['public.referral_admin()', '6881c7fc37602e907793b0178bf5a73f'],
      ['public.set_referral_settings(boolean, boolean, numeric, numeric, integer, integer, integer, integer)', 'c57ae2b4cd2d14bab35fbd85e9775cdf'],
      ['public.referral_settle_all(integer)', '5e640e5905f7d7b974b47c4e4af5b748']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(pair[1]);
    if h is distinct from pair[2] then
      raise exception 'rollback 0165: % is not 0165''s body (md5 %): read the live body first', pair[1], h;
    end if;
  end loop;
end $$;

-- 1. The earlier bodies, as 0092 and 0034 wrote them.
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
    end if;
    perform public.credit_lots_spend_locked(new.org_id, -amt, new.job_id, new.id, prefer);
  end if;
  return null;
end
$$;

revoke all on function public.friend_invite_pay_locked(public.friend_invite_links) from public, anon, authenticated, service_role;
revoke all on function public.my_friend_invite() from public, anon, service_role;
grant execute on function public.my_friend_invite() to authenticated;
revoke all on function public.join_friend_invite(text) from public, anon, service_role;
grant execute on function public.join_friend_invite(text) to authenticated;
revoke all on function public.credit_transactions_apply_lots() from public, anon, authenticated, service_role;

-- 2. The job, when pg_cron has it.
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
drop function if exists public.referral_settle_all(integer);
drop function if exists public.set_referral_settings(boolean, boolean, numeric, numeric, integer, integer, integer, integer);
drop function if exists public.referral_admin();
drop function if exists public.referral_terms();
drop function if exists public.my_referrals();
drop function if exists public.claim_referral_rewards();
drop function if exists public.referral_settle_locked(public.friend_invite_links);
drop function if exists public.referral_was_open(timestamptz);
drop function if exists public.referral_payment_paid(text);
drop function if exists public.referral_payment_reversed(text);
drop table if exists public.referral_open_periods;
drop table if exists public.referral_settle_runs;
drop table if exists public.referral_rewards;
alter table public.friend_invite_links drop column if exists referral_settled_at;
alter table public.friend_invite_settings drop constraint if exists friend_invite_settings_referral_check;
alter table public.friend_invite_settings drop column if exists referral_updated_at;
alter table public.friend_invite_settings drop column if exists referral_daily_cap;
alter table public.friend_invite_settings drop column if exists referral_monthly_cap;
alter table public.friend_invite_settings drop column if exists referral_qualify_days;
alter table public.friend_invite_settings drop column if exists referral_hold_days;
alter table public.friend_invite_settings drop column if exists referral_min_credits;
alter table public.friend_invite_settings drop column if exists referral_credits;
alter table public.friend_invite_settings drop column if exists milestone_enabled;
alter table public.friend_invite_settings drop column if exists referral_enabled;

-- 4. The end state.
do $$
declare
  h text;
  pair text[];
begin
  foreach pair slice 1 in array array[
      ['public.friend_invite_pay_locked(public.friend_invite_links)', '1cfc1f84f065d73e2cb7e84c18ca6ae2'],
      ['public.my_friend_invite()', 'b26806d4fdc88a8453e939087d53184c'],
      ['public.join_friend_invite(text)', '549632bae0dbb002dc66200d7f6c0998'],
      ['public.credit_transactions_apply_lots()', '8ab35cff8ac8a145403b0e6eca735697']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(pair[1]);
    if h is distinct from pair[2] then
      raise exception 'rollback 0165: % did not end as the earlier body (md5 %)', pair[1], h;
    end if;
  end loop;
  if to_regclass('public.referral_rewards') is not null or to_regprocedure('public.my_referrals()') is not null then
    raise exception 'rollback 0165: a name of 0165 is still there';
  end if;
end $$;

commit;
