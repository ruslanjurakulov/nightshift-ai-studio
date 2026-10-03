-- 0092_friend_invites.sql — "Invite friends": one link per person, 100 credits
-- to the link's owner when 5 new people have joined through it.
--
-- WHAT IT ADDS
--   friend_invite_settings  one row: the operator's switch and numbers.
--                           enabled (DEFAULT OFF — nothing is paid until the
--                           operator turns it on), required_joins (5),
--                           reward_credits (100), daily_reward_cap (20 rewards
--                           per UTC day, platform-wide), link_hourly_cap (10
--                           joins per link per hour).
--   friend_invite_links     ONE row per person: the link's token and the
--                           organization its reward is paid into.
--   friend_invite_joins     one row per new account that came through a link
--                           (counted or not). invitee_id and email_key are
--                           UNIQUE: one account, and one mailbox, joins once.
--   friend_invite_rewards   one row per person, ever: the reward was paid.
--                           user_id is the primary key — a second reward is a
--                           constraint violation, not a business rule.
--
-- THE RULES (enforced here, not in the app)
--   * A join counts only when the new account's e-mail is CONFIRMED
--     (auth.users.email_confirmed_at), the account was created AFTER the link
--     existed and no more than 3 days ago, it is not the link's owner (nor the
--     same mailbox as the owner: gmail dots, +tags and googlemail.com are
--     folded with welcome_email_key, 0042), and no other account on that
--     mailbox has joined. An existing account that opens a link counts for
--     nothing.
--   * The same link may be used by many people. The first required_joins
--     counted joins pay the owner ONCE, through the credit ledger: one 'grant'
--     row, external_id 'invite-reward:<owner id>' (the ledger's unique index
--     on external_id, 0020, is the idempotency key). Later joiners are
--     recorded but not counted, and nothing more is ever paid to that person.
--     "That person" is the account AND its mailbox (folded like the joins'):
--     the reward row keeps the owner's mailbox key, which outlives the account,
--     so deleting the account (an operator step: GDPR request) and signing up
--     again on the same mailbox cannot earn it a second time — the same
--     guarantee welcome_credit_claims (0042) gives the welcome credits.
--     The people who join get nothing from this feature.
--   * Joins are serialised per link (select ... for update) and the daily cap
--     is taken under one advisory lock, so two people completing the 5th join
--     at the same moment pay once, and the cap cannot be overshot.
--   * When the daily cap is full (or the switch is off) at the 5th join, the
--     reward is simply PENDING: the owner's page calls claim_friend_invite_reward()
--     and it is paid as soon as there is room. Nothing is lost, nothing is paid twice.
--   * The reward goes into the organization the owner created the link in
--     (an owner/admin of it, not the operator's own organization, which never
--     pays). It is an ordinary grant: same lot, same expiry policy (0034),
--     spendable exactly like the welcome credits and no other way.
--
-- WHO MAY DO WHAT
--   No API role has any privilege on the four tables (RLS on, no policy, all
--   privileges revoked). Everything goes through SECURITY DEFINER functions
--   with a pinned search_path:
--     create_friend_invite(org)   signed in, e-mail confirmed, admin of org; idempotent
--     my_friend_invite()          the caller's OWN link and progress (counts only —
--                                 never an invitee's id or e-mail)
--     claim_friend_invite_reward() the caller's own reward, if earned and there is room
--     join_friend_invite(token)   the new account itself, after it confirmed its e-mail
--     friend_invite_peek(token)   anon: is this link live? (boolean only)
--     friend_invite_admin() / set_friend_invite_settings(...)   platform owner/admin
--
-- THE TOKEN. 128 random bits (hex, 32 characters). It is stored in the clear
-- in a table nobody can read through the API, because the owner must be able
-- to see and copy their link again and the link is meant to be posted
-- publicly: knowing it lets a stranger do exactly what any recipient can do
-- (register a new, e-mail-confirmed account, which the caps bound). It never
-- appears in a list, in a join row, in the ledger or in the audit trail.
-- There is no "regenerate": a new link would reset the count, and a reward
-- already paid must not be earnable again.
--
-- Additive and idempotent: guarded creates, create-or-replace functions,
-- repeatable revokes. Requires 0018 (organizations), 0020 (credits), 0034
-- (lots, via the ledger trigger) and 0042 (take_web_rate, welcome_email_key).
-- Safe to run twice.

do $$
begin
  if to_regprocedure('public.welcome_email_key(text)') is null then
    raise exception '0092 needs 0042 (welcome_email_key): apply 0042_web_api_hardening.sql first';
  end if;
  if to_regclass('public.credit_transactions') is null then
    raise exception '0092 needs credits: apply 0020_credits.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.friend_invite_settings (
  id               boolean primary key default true check (id),
  enabled          boolean not null default false,
  required_joins   integer not null default 5 check (required_joins between 1 and 100),
  reward_credits   numeric(14,2) not null default 100 check (reward_credits > 0 and reward_credits <= 100000),
  daily_reward_cap integer not null default 20 check (daily_reward_cap between 0 and 10000),
  link_hourly_cap  integer not null default 10 check (link_hourly_cap between 1 and 1000),
  updated_by       uuid,
  updated_at       timestamptz not null default now()
);
insert into public.friend_invite_settings (id) values (true) on conflict (id) do nothing;
comment on table public.friend_invite_settings is
  'The invite programme''s switch (default OFF) and numbers (0092). One row. Changed only by set_friend_invite_settings(), which refuses anyone but a platform owner/admin.';
alter table public.friend_invite_settings enable row level security;
revoke all on public.friend_invite_settings from public, anon, authenticated;

create table if not exists public.friend_invite_links (
  id         bigint generated always as identity primary key,
  user_id    uuid not null unique references auth.users (id) on delete cascade,
  org_id     uuid not null references public.organizations (id) on delete restrict,
  token      text not null unique check (token ~ '^[0-9a-f]{32}$'),
  created_at timestamptz not null default now()
);
comment on table public.friend_invite_links is
  'One invite link per person (0092). token is 128 random bits and is readable only by its owner, through my_friend_invite(). org_id is where the reward is paid. No API role has a privilege on this table.';
alter table public.friend_invite_links enable row level security;
revoke all on public.friend_invite_links from public, anon, authenticated;

create table if not exists public.friend_invite_joins (
  id         bigint generated always as identity primary key,
  link_id    bigint not null references public.friend_invite_links (id) on delete cascade,
  invitee_id uuid not null unique,
  email_key  text not null unique check (email_key ~ '^[0-9a-f]{64}$'),
  counted    boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists friend_invite_joins_link_idx on public.friend_invite_joins (link_id, created_at);
comment on table public.friend_invite_joins is
  'A new, e-mail-confirmed account that came through a link (0092). invitee_id and email_key (SHA-256 of the normalised mailbox, as welcome_credit_claims) are unique: one account and one mailbox join once. counted = it counted toward the reward. The owner never reads this table.';
alter table public.friend_invite_joins enable row level security;
revoke all on public.friend_invite_joins from public, anon, authenticated;

create table if not exists public.friend_invite_rewards (
  user_id    uuid primary key,
  link_id    bigint,
  org_id     uuid not null references public.organizations (id) on delete restrict,
  credits    numeric(14,2) not null check (credits > 0),
  joins      integer not null check (joins > 0),
  email_key  text check (email_key ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
-- The owner's mailbox key (as in friend_invite_joins): one reward per mailbox
-- for good, even after the account is deleted and made again. Added with
-- "if not exists" so a database that already ran an earlier draft gets it too.
alter table public.friend_invite_rewards add column if not exists email_key text;
create unique index if not exists friend_invite_rewards_mailbox_key on public.friend_invite_rewards (email_key);
create index if not exists friend_invite_rewards_day_idx on public.friend_invite_rewards (created_at);
comment on table public.friend_invite_rewards is
  'The reward paid to a link owner (0092): one row per person and per mailbox, for good (primary key on user_id, unique email_key). Its ledger row has external_id invite-reward:<user id>.';
alter table public.friend_invite_rewards enable row level security;
revoke all on public.friend_invite_rewards from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Internals (not callable through the API)
-- ───────────────────────────────────────────────────────────────────────────

-- 128 random bits as 32 hex characters, from gen_random_uuid()'s strong random
-- source. Bytes 6 and 8 of a UUID carry its version and variant bits and are
-- skipped: 14 bytes from one UUID plus 2 from another.
create or replace function public.friend_invite_token() returns text
  language plpgsql volatile set search_path = public, pg_temp as $$
declare
  a   bytea := uuid_send(gen_random_uuid());
  b   bytea := uuid_send(gen_random_uuid());
  out text := '';
  i   integer;
begin
  for i in 0..15 loop
    continue when i in (6, 8);
    out := out || lpad(to_hex(get_byte(a, i)), 2, '0');
  end loop;
  return out || lpad(to_hex(get_byte(b, 0)), 2, '0') || lpad(to_hex(get_byte(b, 1)), 2, '0');
end
$$;

-- The mailbox key (same as welcome_credit_claims.email_key) of an auth user.
create or replace function public.friend_invite_mail_key(p_user uuid) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
  select encode(sha256(convert_to(public.welcome_email_key(u.email), 'UTF8')), 'hex')
    from auth.users u
   where u.id = p_user and public.welcome_email_key(u.email) is not null
$$;

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

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The owner's side
-- ───────────────────────────────────────────────────────────────────────────

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
    'pending', r.user_id is null and l.id is not null and n >= s.required_joins
               and not exists (select 1 from public.friend_invite_rewards x
                                where x.email_key = public.friend_invite_mail_key(uid)));
end
$$;

-- Make the caller's link (once). Refused while the switch is off, for an
-- unconfirmed account, for someone who is not an admin of `p_org`, and for the
-- operator's own organization (it never pays). A second call returns the same link.
create or replace function public.create_friend_invite(p_org uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  s   public.friend_invite_settings;
  i   integer := 0;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.users u where u.id = uid and u.email_confirmed_at is not null) then
    raise exception 'confirm your e-mail first' using errcode = '42501';
  end if;
  if not exists (select 1 from public.friend_invite_links where user_id = uid) then
    select * into s from public.friend_invite_settings;
    if not s.enabled then
      raise exception 'invites are not open' using errcode = 'NS403';
    end if;
    if not public.is_org_member(p_org, 'admin') or public.credits_exempt(p_org) then
      raise exception 'this workspace cannot receive invite credits' using errcode = '42501';
    end if;
    if exists (select 1 from public.friend_invite_rewards x where x.email_key = public.friend_invite_mail_key(uid)) then
      raise exception 'invite credits were already paid to this mailbox' using errcode = '42501';
    end if;
    loop
      begin
        insert into public.friend_invite_links (user_id, org_id, token)
        values (uid, p_org, public.friend_invite_token())
        on conflict (user_id) do nothing;
        exit;
      exception when unique_violation then
        -- a token collision (2^-128): draw again
        i := i + 1;
        if i > 5 then raise; end if;
      end;
    end loop;
  end if;
  return public.my_friend_invite();
end
$$;

-- The owner's own reward, if earned and there is room today (page load).
create or replace function public.claim_friend_invite_reward() returns jsonb
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
    perform public.friend_invite_pay_locked(l);
  end if;
  return public.my_friend_invite();
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The new person's side
-- ───────────────────────────────────────────────────────────────────────────

-- Is this link live right now? A boolean and nothing else: not whose it is,
-- not why it is not. Anon may ask (the landing page runs signed out); the
-- token is 128 bits, so asking is not a way to find one.
create or replace function public.friend_invite_peek(p_token text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    lower(btrim(p_token)) ~ '^[0-9a-f]{32}$'
    and (select enabled from public.friend_invite_settings)
    and exists (select 1 from public.friend_invite_links where token = lower(btrim(p_token))),
    false)
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
-- 5. The operator's side
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.friend_invite_admin() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s    public.friend_invite_settings;
  day0 timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
begin
  if not public.is_platform_admin() then
    raise exception 'only a platform owner or admin may read this' using errcode = '42501';
  end if;
  select * into s from public.friend_invite_settings;
  return jsonb_build_object(
    'enabled', s.enabled,
    'required_joins', s.required_joins,
    'reward_credits', s.reward_credits,
    'daily_reward_cap', s.daily_reward_cap,
    'link_hourly_cap', s.link_hourly_cap,
    'links', (select count(*) from public.friend_invite_links),
    'joins', (select count(*) from public.friend_invite_joins where counted),
    'joins_uncounted', (select count(*) from public.friend_invite_joins where not counted),
    'rewards', (select count(*) from public.friend_invite_rewards),
    'rewards_today', (select count(*) from public.friend_invite_rewards where created_at >= day0),
    'credits_today', coalesce((select sum(credits) from public.friend_invite_rewards where created_at >= day0), 0),
    'credits_total', coalesce((select sum(credits) from public.friend_invite_rewards), 0),
    'pending', (select count(*) from public.friend_invite_links l
                 where not exists (select 1 from public.friend_invite_rewards r where r.user_id = l.user_id)
                   and (select count(*) from public.friend_invite_joins j where j.link_id = l.id and j.counted) >= s.required_joins));
end
$$;

create or replace function public.set_friend_invite_settings(
  p_enabled boolean, p_required_joins integer, p_reward_credits numeric,
  p_daily_reward_cap integer, p_link_hourly_cap integer default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not public.is_platform_admin() then
    raise exception 'only a platform owner or admin may change this' using errcode = '42501';
  end if;
  if p_enabled is null
     or p_required_joins is null or p_required_joins not between 1 and 100
     or p_reward_credits is null or p_reward_credits <= 0 or p_reward_credits > 100000
     or p_daily_reward_cap is null or p_daily_reward_cap not between 0 and 10000
     or (p_link_hourly_cap is not null and p_link_hourly_cap not between 1 and 1000) then
    raise exception 'a setting is out of range' using errcode = '22023';
  end if;
  update public.friend_invite_settings
     set enabled = p_enabled,
         required_joins = p_required_joins,
         reward_credits = public.credits_round_up(p_reward_credits),
         daily_reward_cap = p_daily_reward_cap,
         link_hourly_cap = coalesce(p_link_hourly_cap, link_hourly_cap),
         updated_by = auth.uid(),
         updated_at = now()
   where id;
  return public.friend_invite_admin();
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Who may call what
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.friend_invite_token() from public, anon, authenticated, service_role;
revoke all on function public.friend_invite_mail_key(uuid) from public, anon, authenticated, service_role;
revoke all on function public.friend_invite_pay_locked(public.friend_invite_links) from public, anon, authenticated, service_role;

revoke all on function public.my_friend_invite() from public, anon, service_role;
revoke all on function public.create_friend_invite(uuid) from public, anon, service_role;
revoke all on function public.claim_friend_invite_reward() from public, anon, service_role;
revoke all on function public.join_friend_invite(text) from public, anon, service_role;
revoke all on function public.friend_invite_admin() from public, anon, service_role;
revoke all on function public.set_friend_invite_settings(boolean, integer, numeric, integer, integer) from public, anon, service_role;
grant execute on function public.my_friend_invite() to authenticated;
grant execute on function public.create_friend_invite(uuid) to authenticated;
grant execute on function public.claim_friend_invite_reward() to authenticated;
grant execute on function public.join_friend_invite(text) to authenticated;
grant execute on function public.friend_invite_admin() to authenticated;
grant execute on function public.set_friend_invite_settings(boolean, integer, numeric, integer, integer) to authenticated;

revoke all on function public.friend_invite_peek(text) from public, service_role;
grant execute on function public.friend_invite_peek(text) to anon, authenticated;

-- Verify (expect every column true):
--   select
--     (select count(*) = 1 and not bool_or(enabled) from public.friend_invite_settings) as one_row_switch_off,
--     not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace
--                  and c.relname in ('friend_invite_settings', 'friend_invite_links', 'friend_invite_joins', 'friend_invite_rewards')
--                  and not c.relrowsecurity) as rls_on,
--     not exists (select 1 from information_schema.role_table_grants
--                  where table_schema = 'public' and grantee in ('anon', 'authenticated', 'public')
--                    and table_name like 'friend_invite_%') as no_table_grants,
--     has_function_privilege('anon', 'public.friend_invite_peek(text)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.join_friend_invite(text)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.my_friend_invite()', 'EXECUTE')
--       and has_function_privilege('authenticated', 'public.join_friend_invite(text)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.friend_invite_pay_locked(public.friend_invite_links)', 'EXECUTE') as acl_ok,
--     exists (select 1 from pg_trigger where tgrelid = 'public.credit_transactions'::regclass
--              and tgname = 'credit_transactions_append_only') as ledger_still_append_only;
