-- 0107_owner_safety.sql — server-side, audited, capped, lockout-safe owner actions, and the
-- database half of the second factor. EVERYTHING IS SWITCHED OFF OR UNUSED UNTIL A LATER CHANGE.
--
-- *** APPLYING THIS FILE CHANGES THE LIVE DATABASE. Merging it to main applies it
-- *** automatically, and an applied migration is never edited: fix by a new forward
-- *** migration. The owner authorised migrations for this work.
--
-- WHAT "DORMANT" MEANS HERE
--   * The gate flag (owner_security_settings.admin_aal2_required) is FALSE. While it is false,
--     admin_aal_ok() answers true to everyone, so the new owner functions are limited only by
--     "must be a platform owner/admin", their own caps and the audit trail.
--   * Nothing in the app calls any of the new functions yet (the Command Center still writes
--     credit_prices / app_members and calls grant_credits straight from the browser). A later,
--     separately reviewed change wires the screens behind NIGHTSHIFT_OWNER_RPC.
--   * NO existing policy, grant, trigger body, function or table is changed, with ONE exception:
--     audit_action_allowed(text) is redefined to ADD seven action names (its whole 0093 list is
--     copied verbatim). platform_role(), is_platform_admin(), accessible_org_ids(), grant_credits()
--     and every RLS policy are untouched, so a password-only (aal1) admin still sees and does exactly
--     what they did before this file.
--   * The only thing that runs on every request after this file is three AFTER-row logging
--     triggers (app_members, credit_prices, owner_security_settings) that write a row to
--     security_events. They can never fail or roll back the write they observe (see 5).
--
-- WHAT IT ADDS
--  1. owner_security_settings   one row (the primary key is the constant true). The flag and the
--                               numbers every owner function reads. No API role has any privilege on
--                               it; read through owner_security_get() (platform admin only); changed
--                               in the Supabase SQL editor (the break-glass is one UPDATE).
--                                 admin_aal2_required   false      the database gate (see 2)
--                                 recent_mfa_minutes    480        how old the authenticator code may be
--                                                                  (5 .. 1440) while the gate is on
--                                 grant_max_per_call    100000     credits in one owner_grant_credits call.
--                                                                  1 credit is about 1 US cent of vendor
--                                                                  cost and about $0.01 retail
--                                                                  (CREATIVE_OS_PLAN.md), so 100,000 credits
--                                                                  = about $1,000 (the old only cap was
--                                                                  100,000,000 = about $1,000,000)
--                                 grant_max_per_24h     500000     credits minted through grants, all
--                                                                  actors together, in any rolling 24 h
--                                                                  = about $5,000
--                                 price_max_change_ratio 3         a price may move by at most this factor
--                                                                  (up or down) without an explicit confirm
--                                 reverse_window_days   14         how long a grant can be reversed
--  2. admin_aal_ok()            the second-factor test, never a lockout (see below). Plus the internal
--                               admin_mfa_state(), enable_admin_mfa(), disable_admin_mfa(),
--                               owner_security_get().
--  3. Owner actions (all SECURITY DEFINER, search_path pinned, platform owner/admin only, each calls
--                    admin_aal_ok() and a per-person rate limit, each writes an app_audit_log row AND a
--                    security_events row in the SAME transaction as the change, so an audit that cannot
--                    be written stops the change):
--       owner_grant_credits(org, credits, reason, idempotency_key)   per-call cap, rolling 24 h cap,
--                               idempotent on credit_transactions.external_id, returns the balance
--       owner_reverse_grant(transaction_id, reason)                  bounded by what is left, records the shortfall
--       owner_set_credit_price / owner_delete_credit_price / owner_restore_credit_price
--                               credit_price_history (old and new, append-only), ratio and bounds guard
--       owner_add_member / owner_set_member_role / owner_remove_member
--                               last-owner guard, no self change, only an owner mints or touches admins/owners
--  4. security_events           append-only (a BEFORE UPDATE/DELETE row trigger and a BEFORE TRUNCATE
--                               trigger refuse, for everyone including the owner role and the SQL editor).
--                               No API role reads or writes it; platform admins read it through
--                               owner_security_events(limit); the service key (the operator bot) may SELECT.
--  5. Trails on the tables the browser still writes: AFTER INSERT/UPDATE/DELETE row triggers on
--                               app_members and credit_prices (and AFTER UPDATE on the settings row) write
--                               a security_events row, and on credit_prices a credit_price_history row for a
--                               DIRECT write, so a price a browser deleted can be restored. DECISION: these
--                               triggers wrap their logging in a BEGIN ... EXCEPTION block; a logging error
--                               becomes a WARNING and the business write goes on. A trigger that could fail
--                               the write would turn an audit problem into a refused price change or a locked
--                               roster. The owner functions are the opposite: their audit is NOT swallowed.
--  6. audit_action_allowed()    0093's list verbatim plus: credits.grant, credits.reverse, credits.price,
--                               member.add, member.role, member.remove, security.gate. (member.* is a prefix
--                               the operator bot already alerts on.)
--
-- THE GATE AND WHY IT CANNOT LOCK THE OWNER OUT (admin_aal_ok)
--   gate off                                                         -> true
--   gate on, caller has NO verified factor in auth.mfa_factors       -> true  (a code cannot be asked of
--                                                                      someone who has none)
--   gate on, verified factor, JWT aal <> 'aal2' (or missing)         -> false (the password alone is not enough)
--   gate on, verified factor, aal2, the newest TOTP/WebAuthn entry of the JWT amr claim older than
--   recent_mfa_minutes                                               -> false (sign in again and type the code)
--   gate on, verified factor, aal2, no readable amr timestamp        -> true
--   auth.mfa_factors unreadable                                      -> true  (and enable_admin_mfa refuses)
--   enable_admin_mfa() refuses unless EVERY owner/admin row of app_members is bound to an account with at
--   least two verified factors, and the caller holds a fresh aal2 session. disable_admin_mfa() needs
--   admin_aal_ok() (so a stolen password cannot switch the gate off, but an admin without a factor can).
--   Break-glass for a lost authenticator, in the Supabase SQL editor (runs as the database owner):
--       update public.owner_security_settings set admin_aal2_required = false;
--   The gate lives ONLY in the new owner functions. It is not in platform_role(): reads and every existing
--   page keep working for an aal1 admin. Closing the direct browser paths is a later migration.
--
-- Known limits, stated plainly
--   * grant_credits() and the browser's direct writes still work and are not capped; they are only observed
--     (security_events for app_members / credit_prices; the ledger's created_by for a grant). The 24 h cap
--     counts manual grant_credits rows too (kind grant, no external id, created_by set).
--   * An owner_reverse_grant removes credits in the ledger's normal spend order, which is not necessarily
--     from the lot the grant created; the total is right, the lot attribution may differ.
--   * An admin who has no factor is never gated (the lockout rule). The gate protects accounts that enrolled.
--     That includes an admin added AFTER the gate is switched on: until they enrol they are not gated, so
--     add admins only after they have enrolled (owner_admin_factors() lists every owner/admin with the
--     number of verified factors).
--   * A reversal does not give the 24 h grant cap back (a grant that was reversed still counts), and a
--     grant can be reversed once (the ledger's unique external id owner-reverse:<id>).
--
-- Additive and idempotent: create ... if not exists, create or replace for NEW functions (and for the one
-- permitted redefinition), drop-then-create for the new triggers and policies, seed ON CONFLICT DO NOTHING.
-- REQUIRES 0007/0018 (app_members, is_platform_admin), 0008/0087 (app_audit_log, its stamp trigger),
-- 0020/0034 (credits, lots), 0042/0087 (take_web_rate), 0043 (my_confirmed_email, platform_role).

-- If the lock for a trigger or the index below cannot be had within 5 seconds, this file fails as a
-- whole (nothing is half applied) and can be applied again, instead of queueing behind a long
-- transaction and stalling every writer of those tables. SET LOCAL: it lasts for this file's
-- transaction only, and is a no-op (with a warning) if a runner applies statements one by one.
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.app_members') is null or to_regclass('public.app_audit_log') is null
     or to_regclass('public.credit_prices') is null or to_regclass('public.credit_transactions') is null
     or to_regclass('public.credit_accounts') is null or to_regclass('public.organizations') is null then
    raise exception '0107 needs the roster, audit trail and credits tables: apply 0007, 0008, 0018 and 0020 first';
  end if;
  if to_regclass('public.credit_lots') is null then
    raise exception '0107 needs 0034_plans_entitlements.sql (credit_lots): apply it first';
  end if;
  if to_regprocedure('public.is_platform_admin()') is null or to_regprocedure('public.platform_role()') is null
     or to_regprocedure('public.my_confirmed_email()') is null then
    raise exception '0107 needs 0018 / 0043 (is_platform_admin, platform_role, my_confirmed_email): apply them first';
  end if;
  if to_regprocedure('public.credit_account_lock(uuid)') is null
     or to_regprocedure('public.credit_log(uuid, text, numeric, text, text, text)') is null
     or to_regprocedure('public.credits_round_up(numeric)') is null then
    raise exception '0107 needs the credit ledger functions of 0020: apply it first';
  end if;
  if to_regprocedure('public.take_web_rate(text, integer, integer)') is null then
    raise exception '0107 needs 0042_web_api_hardening.sql (take_web_rate): apply it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.owner_security_settings (
  id                      boolean primary key default true,
  admin_aal2_required     boolean not null default false,
  recent_mfa_minutes      integer not null default 480,
  grant_max_per_call      bigint  not null default 100000,
  grant_max_per_24h       bigint  not null default 500000,
  price_max_change_ratio  numeric not null default 3,
  reverse_window_days     integer not null default 14,
  updated_at              timestamptz not null default now(),
  updated_by              uuid
);

alter table public.owner_security_settings drop constraint if exists owner_security_settings_single_row;
alter table public.owner_security_settings add constraint owner_security_settings_single_row check (id);
alter table public.owner_security_settings drop constraint if exists owner_security_settings_recent_check;
alter table public.owner_security_settings add constraint owner_security_settings_recent_check
  check (recent_mfa_minutes between 5 and 1440);
alter table public.owner_security_settings drop constraint if exists owner_security_settings_grant_call_check;
alter table public.owner_security_settings add constraint owner_security_settings_grant_call_check
  check (grant_max_per_call between 1 and 100000000);
alter table public.owner_security_settings drop constraint if exists owner_security_settings_grant_day_check;
alter table public.owner_security_settings add constraint owner_security_settings_grant_day_check
  check (grant_max_per_24h between 1 and 1000000000);
alter table public.owner_security_settings drop constraint if exists owner_security_settings_ratio_check;
alter table public.owner_security_settings add constraint owner_security_settings_ratio_check
  check (price_max_change_ratio > 1 and price_max_change_ratio <= 1000);
alter table public.owner_security_settings drop constraint if exists owner_security_settings_window_check;
alter table public.owner_security_settings add constraint owner_security_settings_window_check
  check (reverse_window_days between 1 and 365);

comment on table public.owner_security_settings is
  'One row (id is always true). admin_aal2_required is the database half of the second factor (OFF by default); the other columns are the caps the owner_* functions enforce. No API role can read or write it: owner_security_get() reads it, the SQL editor changes it. Break-glass: update public.owner_security_settings set admin_aal2_required = false;';

insert into public.owner_security_settings (id) values (true) on conflict (id) do nothing;

-- Append-only trail of security-relevant events. Written by the owner functions (kind = the audit
-- action) and by the triggers below (kind roster.* / price.* / settings.*).
create table if not exists public.security_events (
  id             bigserial primary key,
  at             timestamptz not null default now(),
  kind           text not null,
  severity       text not null default 'notice',
  actor_user_id  uuid,
  actor_email    text,
  actor_role     text,
  target         text,
  detail         jsonb not null default '{}'::jsonb
);

alter table public.security_events drop constraint if exists security_events_kind_check;
alter table public.security_events add constraint security_events_kind_check
  check (char_length(kind) between 1 and 80);
alter table public.security_events drop constraint if exists security_events_severity_check;
alter table public.security_events add constraint security_events_severity_check
  check (severity in ('info', 'notice', 'warning', 'critical'));
alter table public.security_events drop constraint if exists security_events_target_check;
alter table public.security_events add constraint security_events_target_check
  check (target is null or char_length(target) <= 200);
alter table public.security_events drop constraint if exists security_events_detail_check;
alter table public.security_events add constraint security_events_detail_check
  check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 4096);

create index if not exists security_events_at_idx on public.security_events (at desc, id desc);
create index if not exists security_events_kind_idx on public.security_events (kind, at desc);

comment on table public.security_events is
  'Append-only security trail (migration 0107). Written by the owner_* functions and by AFTER triggers on app_members, credit_prices and owner_security_settings. Nothing updates or deletes a row, not even the table owner. Platform admins read it with owner_security_events(limit).';

-- Every price change, with the old and the new figures; the way back for owner_restore_credit_price.
create table if not exists public.credit_price_history (
  id                    bigserial primary key,
  at                    timestamptz not null default now(),
  unit                  text not null,
  action                text not null,
  old_credits_per_unit  numeric(18,8),
  old_margin            numeric(6,4),
  old_note              text,
  new_credits_per_unit  numeric(18,8),
  new_margin            numeric(6,4),
  new_note              text,
  actor_user_id         uuid,
  reason                text,
  source                text not null default 'rpc',
  restored_from         bigint
);

alter table public.credit_price_history drop constraint if exists credit_price_history_action_check;
alter table public.credit_price_history add constraint credit_price_history_action_check
  check (action in ('set', 'delete', 'restore'));
alter table public.credit_price_history drop constraint if exists credit_price_history_source_check;
alter table public.credit_price_history add constraint credit_price_history_source_check
  check (source in ('rpc', 'direct'));
alter table public.credit_price_history drop constraint if exists credit_price_history_reason_check;
alter table public.credit_price_history add constraint credit_price_history_reason_check
  check (reason is null or char_length(reason) <= 300);

create index if not exists credit_price_history_unit_idx on public.credit_price_history (unit, id desc);

comment on table public.credit_price_history is
  'Append-only price history (migration 0107): one row per change of a credit_prices row, with the old and the new rate, margin and note. source rpc = an owner_*_credit_price function (with its reason); direct = a write the browser made straight to credit_prices.';

-- The rolling 24 h grant cap reads recent 'grant' rows of the whole ledger; this keeps that read small
-- (a partial index over the few grant rows, not the reserve/capture traffic). credit_transactions
-- only ever gets INSERTs, so the build waits for in-flight writers for at most the 5 s above.
create index if not exists credit_transactions_grant_created_idx
  on public.credit_transactions (created_at) where kind = 'grant';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Small internal helpers (no API role may call them)
-- ───────────────────────────────────────────────────────────────────────────

-- A uniform refusal: {"ok": false, "error": <code>, "message": <text>, ...extra}.
create or replace function public.owner_err(p_code text, p_message text, p_extra jsonb default null)
  returns jsonb
  language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', false, 'error', p_code, 'message', p_message) || coalesce(p_extra, '{}'::jsonb)
$$;

-- Nothing deletes or rewrites these tables, and nothing empties them.
create or replace function public.owner_security_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception '% is append-only: record a new row instead', tg_table_name using errcode = '42501';
end
$$;

-- The settings row can be edited but never removed (a missing row would read as "gate off").
create or replace function public.owner_security_settings_no_delete() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'owner_security_settings keeps its one row: update it instead' using errcode = '42501';
end
$$;

create or replace function public.owner_security_settings_stamp() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end
$$;

drop trigger if exists security_events_append_only on public.security_events;
create trigger security_events_append_only
  before update or delete on public.security_events
  for each row execute function public.owner_security_append_only();
drop trigger if exists security_events_no_truncate on public.security_events;
create trigger security_events_no_truncate
  before truncate on public.security_events
  for each statement execute function public.owner_security_append_only();

drop trigger if exists credit_price_history_append_only on public.credit_price_history;
create trigger credit_price_history_append_only
  before update or delete on public.credit_price_history
  for each row execute function public.owner_security_append_only();
drop trigger if exists credit_price_history_no_truncate on public.credit_price_history;
create trigger credit_price_history_no_truncate
  before truncate on public.credit_price_history
  for each statement execute function public.owner_security_append_only();

drop trigger if exists owner_security_settings_no_delete on public.owner_security_settings;
create trigger owner_security_settings_no_delete
  before delete on public.owner_security_settings
  for each row execute function public.owner_security_settings_no_delete();
drop trigger if exists owner_security_settings_no_truncate on public.owner_security_settings;
create trigger owner_security_settings_no_truncate
  before truncate on public.owner_security_settings
  for each statement execute function public.owner_security_settings_no_delete();
drop trigger if exists owner_security_settings_stamp on public.owner_security_settings;
create trigger owner_security_settings_stamp
  before update on public.owner_security_settings
  for each row execute function public.owner_security_settings_stamp();

-- One security_events row. The actor is the session's answer (never an argument): the account, its
-- CONFIRMED address and the API role the request SET (null for the SQL editor).
create or replace function public.security_event_log(p_kind text, p_severity text, p_target text, p_detail jsonb)
  returns bigint
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_id bigint;
begin
  insert into public.security_events (kind, severity, actor_user_id, actor_email, actor_role, target, detail)
  values (left(coalesce(p_kind, 'event'), 80), coalesce(p_severity, 'notice'), auth.uid(),
          public.my_confirmed_email(), nullif(current_setting('role', true), 'none'),
          left(p_target, 200), coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end
$$;

-- An owner action's two records: the audit row the Command Center's Audit page shows, and the
-- security event. Not swallowed: if either cannot be written, the whole action rolls back.
create or replace function public.owner_audit(p_action text, p_target text, p_detail jsonb, p_severity text default 'notice')
  returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id)
  values (auth.uid(), p_action, left(p_target, 200), p_detail, null);
  perform public.security_event_log(p_action, p_severity, p_target, p_detail);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The second-factor test
-- ───────────────────────────────────────────────────────────────────────────

-- The whole decision as a document. p_assume_on answers "if the gate were on, would THIS session pass?"
-- (enable_admin_mfa uses it so the owner never switches the gate on under their own feet).
create or replace function public.admin_mfa_state(p_assume_on boolean default false) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s            public.owner_security_settings;
  v_uid        uuid := auth.uid();
  v_claims     jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_aal        text := nullif(v_claims ->> 'aal', '');
  v_gate       boolean;
  v_has        boolean := false;
  v_known      boolean := true;
  v_newest     bigint;
  v_age        bigint;
  v_ok         boolean;
  v_why        text;
begin
  select * into s from public.owner_security_settings limit 1;
  v_gate := coalesce(s.admin_aal2_required, false) or coalesce(p_assume_on, false);

  if v_uid is not null then
    begin
      select exists (select 1 from auth.mfa_factors f where f.user_id = v_uid and f.status = 'verified') into v_has;
    exception when others then
      v_has := false;
      v_known := false;
    end;
  end if;

  -- The newest authenticator entry of the token's amr claim (an array of {method, timestamp}).
  if jsonb_typeof(v_claims -> 'amr') = 'array' then
    begin
      select max(case when (e ->> 'timestamp') ~ '^[0-9]{1,12}$' then (e ->> 'timestamp')::bigint end)
        into v_newest
        from jsonb_array_elements(v_claims -> 'amr') e
       where jsonb_typeof(e) = 'object' and (e ->> 'method') in ('totp', 'webauthn', 'phone', 'mfa/totp', 'mfa/webauthn', 'mfa/phone');
    exception when others then
      v_newest := null;
    end;
  end if;
  if v_newest is not null then
    v_age := floor(extract(epoch from now()) - v_newest);
  end if;

  if not v_gate then
    v_ok := true;  v_why := 'gate_off';
  elsif v_uid is null or not v_has then
    v_ok := true;  v_why := case when v_known then 'no_factor' else 'factors_unreadable' end;
  elsif v_aal is distinct from 'aal2' then
    v_ok := false; v_why := 'aal1';
  elsif v_age is not null and v_age > coalesce(s.recent_mfa_minutes, 480) * 60 then
    v_ok := false; v_why := 'stale_mfa';
  else
    v_ok := true;  v_why := 'aal2';
  end if;

  return jsonb_build_object('ok', v_ok, 'why', v_why, 'gate_on', coalesce(s.admin_aal2_required, false),
                            'aal', v_aal, 'has_verified_factor', v_has, 'factors_readable', v_known,
                            'mfa_age_seconds', v_age, 'recent_mfa_minutes', coalesce(s.recent_mfa_minutes, 480));
end
$$;

-- True when the caller may use the owner actions as far as the second factor goes. See the header
-- for the lockout rules: only an account that HAS a verified factor can ever be refused.
create or replace function public.admin_aal_ok() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((public.admin_mfa_state(false) ->> 'ok')::boolean, true)
$$;

-- The common front door of every owner action: signed in and a platform owner/admin (anything else is
-- a 42501 refusal, as everywhere in this schema), then the second factor, then a per-person rate limit.
-- Returns null to go on, or the refusal document to hand back.
create or replace function public.owner_guard(p_action text, p_rate integer default 30) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'only a platform owner or admin may do this' using errcode = '42501';
  end if;
  if not public.admin_aal_ok() then
    return public.owner_err('mfa_required',
      'Confirm your authenticator code again (sign in and type the code), then retry.',
      jsonb_build_object('why', public.admin_mfa_state(false) ->> 'why'));
  end if;
  if not public.take_web_rate('owner:' || p_action, p_rate, 600) then
    return public.owner_err('rate_limited', 'Too many requests. Wait a few minutes and retry.');
  end if;
  return null;
end
$$;

-- Owners and admins with their verified-factor counts (internal; raises when auth.mfa_factors is unreadable).
create or replace function public.owner_admin_factors() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'email', m.email, 'role', m.role, 'bound', m.user_id is not null,
           'verified_factors', coalesce(f.n, 0)) order by m.created_at, m.email), '[]'::jsonb)
    into v
    from public.app_members m
    left join lateral (select count(*)::integer as n from auth.mfa_factors x
                        where x.user_id = m.user_id and x.status = 'verified') f on true
   where m.role in ('owner', 'admin');
  return v;
end
$$;

-- The Security page's self-check and the numbers the owner functions use. Platform owner/admin only.
create or replace function public.owner_security_get() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s        public.owner_security_settings;
  v_admins jsonb;
  v_known  boolean := true;
  v_ready  boolean;
begin
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'only a platform owner or admin may do this' using errcode = '42501';
  end if;
  select * into s from public.owner_security_settings limit 1;
  begin
    v_admins := public.owner_admin_factors();
  exception when others then
    v_admins := '[]'::jsonb;
    v_known := false;
  end;
  v_ready := v_known and jsonb_array_length(v_admins) > 0
             and not exists (select 1 from jsonb_array_elements(v_admins) a
                              where not (a ->> 'bound')::boolean or (a ->> 'verified_factors')::integer < 2);
  return jsonb_build_object(
    'ok', true,
    'settings', jsonb_build_object(
      'admin_aal2_required', s.admin_aal2_required, 'recent_mfa_minutes', s.recent_mfa_minutes,
      'grant_max_per_call', s.grant_max_per_call, 'grant_max_per_24h', s.grant_max_per_24h,
      'price_max_change_ratio', s.price_max_change_ratio, 'reverse_window_days', s.reverse_window_days,
      'updated_at', s.updated_at),
    'caller', public.admin_mfa_state(false),
    'would_block_after_enable', not coalesce((public.admin_mfa_state(true) ->> 'ok')::boolean, true),
    'admins', v_admins,
    'factors_readable', v_known,
    'can_enable', v_ready);
end
$$;

-- Switch the database gate ON. Refuses unless every owner/admin is bound to an account with at least two
-- verified factors (so no admin can be left without a way in), the factors can be read, and THIS session
-- would pass the gate (fresh aal2). Never raises for a reason the owner can act on: it answers.
create or replace function public.enable_admin_mfa() returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s         public.owner_security_settings;
  v_admins  jsonb;
  v_missing jsonb;
  v_me      jsonb;
begin
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'only a platform owner or admin may do this' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('nightshift.owner'), hashtext('settings'));
  select * into s from public.owner_security_settings for update;
  if s.admin_aal2_required then
    return jsonb_build_object('ok', true, 'enabled', true, 'already', true);
  end if;
  begin
    v_admins := public.owner_admin_factors();
  exception when others then
    return public.owner_err('factors_unreadable', 'The second-factor table could not be read, so the gate was not switched on.');
  end;
  if jsonb_array_length(v_admins) = 0 then
    return public.owner_err('no_admins', 'There is no owner or admin on the roster.');
  end if;
  select coalesce(jsonb_agg(a), '[]'::jsonb) into v_missing
    from jsonb_array_elements(v_admins) a
   where not (a ->> 'bound')::boolean or (a ->> 'verified_factors')::integer < 2;
  if jsonb_array_length(v_missing) > 0 then
    return public.owner_err('admins_need_two_factors',
      'Every owner and admin needs a bound account with at least two verified authenticators first.',
      jsonb_build_object('missing', v_missing));
  end if;
  v_me := public.admin_mfa_state(true);
  if not (v_me ->> 'ok')::boolean then
    return public.owner_err('session_not_fresh',
      'Sign in again and type your authenticator code, then switch the gate on.', jsonb_build_object('why', v_me ->> 'why'));
  end if;
  update public.owner_security_settings set admin_aal2_required = true;
  perform public.owner_audit('security.gate', 'admin_aal2_required',
    jsonb_build_object('enabled', true, 'admins', jsonb_array_length(v_admins)), 'critical');
  return jsonb_build_object('ok', true, 'enabled', true, 'already', false);
end
$$;

-- Switch the gate OFF. A platform admin who passes the gate (aal2 when they have a factor) or has no
-- factor. A password-only admin with a factor is refused, so a stolen password cannot open the door;
-- the owner then uses the SQL-editor break-glass from the header.
create or replace function public.disable_admin_mfa() returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s public.owner_security_settings;
begin
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'only a platform owner or admin may do this' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('nightshift.owner'), hashtext('settings'));
  select * into s from public.owner_security_settings for update;
  if not s.admin_aal2_required then
    return jsonb_build_object('ok', true, 'enabled', false, 'already', true);
  end if;
  if not public.admin_aal_ok() then
    return public.owner_err('mfa_required',
      'Confirm your authenticator code first. If you lost the authenticator, run in the Supabase SQL editor: update public.owner_security_settings set admin_aal2_required = false;');
  end if;
  update public.owner_security_settings set admin_aal2_required = false;
  perform public.owner_audit('security.gate', 'admin_aal2_required', jsonb_build_object('enabled', false), 'critical');
  return jsonb_build_object('ok', true, 'enabled', false, 'already', false);
end
$$;

-- The newest security events, newest first (platform owner/admin only).
create or replace function public.owner_security_events(p_limit integer default 100) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
begin
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'only a platform owner or admin may do this' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(e) order by e.id desc)
                     from (select * from public.security_events order by id desc limit v_limit) e), '[]'::jsonb);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Credits: grant and reverse
-- ───────────────────────────────────────────────────────────────────────────

-- Lock order for every owner grant: the rolling-cap lock first, then the organization's account lock
-- (credit_account_lock), so two grants can never wait on each other. The ledger primitives are the
-- ones grant_credits / add_purchased_credits use (credit_account_lock, credit_log); the 0034 trigger
-- on the ledger creates the lot.
create or replace function public.owner_grant_credits(
  p_org uuid, p_credits numeric, p_reason text, p_idempotency_key text
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  g       jsonb;
  s       public.owner_security_settings;
  v_amt   numeric;
  v_why   text := btrim(coalesce(p_reason, ''));
  v_key   text := btrim(coalesce(p_idempotency_key, ''));
  v_ext   text;
  v_acc   public.credit_accounts;
  v_prior public.credit_transactions;
  v_used  numeric;
  v_txn   bigint;
begin
  g := public.owner_guard('grant_credits', 20);
  if g is not null then return g; end if;
  select * into s from public.owner_security_settings limit 1;

  if p_org is null or not exists (select 1 from public.organizations where id = p_org) then
    return public.owner_err('unknown_org', 'That organization does not exist.');
  end if;
  if p_org = public.default_org_id() then
    return public.owner_err('exempt_org', 'The operator organization never pays, so it holds no credits.');
  end if;
  if p_credits is null or not (p_credits > 0 and p_credits < 'Infinity'::numeric) then
    return public.owner_err('bad_amount', 'The amount must be a positive number of credits.');
  end if;
  if p_credits > s.grant_max_per_call then
    return public.owner_err('per_call_cap', 'That is more than one grant may give.',
      jsonb_build_object('requested', p_credits, 'cap', s.grant_max_per_call));
  end if;
  v_amt := public.credits_round_up(p_credits);
  if v_amt > s.grant_max_per_call then
    return public.owner_err('per_call_cap', 'That is more than one grant may give.',
      jsonb_build_object('requested', v_amt, 'cap', s.grant_max_per_call));
  end if;
  if char_length(v_why) < 8 or char_length(v_why) > 300 then
    return public.owner_err('reason_required', 'Give a reason of 8 to 300 characters.');
  end if;
  if v_key !~ '^[A-Za-z0-9_-]{8,100}$' then
    return public.owner_err('idempotency_key_required', 'A request key of 8 to 100 letters, digits, - or _ is required.');
  end if;
  v_ext := 'owner-grant:' || v_key;

  perform pg_advisory_xact_lock(hashtext('nightshift.owner'), hashtext('grant_cap'));
  v_acc := public.credit_account_lock(p_org);

  select * into v_prior from public.credit_transactions where external_id = v_ext;
  if found then
    if v_prior.org_id <> p_org or v_prior.kind <> 'grant' or v_prior.amount <> v_amt then
      return public.owner_err('key_reused', 'That request key was already used for a different grant.');
    end if;
    return jsonb_build_object('ok', true, 'duplicate', true, 'transaction_id', v_prior.id, 'credits', v_prior.amount,
                              'balance', v_acc.balance, 'available', v_acc.balance - v_acc.reserved);
  end if;

  select coalesce(sum(t.amount), 0) into v_used
    from public.credit_transactions t
   where t.kind = 'grant' and t.created_at > now() - interval '24 hours'
     and (t.external_id like 'owner-grant:%' or (t.external_id is null and t.created_by is not null));
  if v_used + v_amt > s.grant_max_per_24h then
    return public.owner_err('daily_cap', 'The 24 hour grant limit would be exceeded.',
      jsonb_build_object('granted_24h', v_used, 'requested', v_amt, 'cap', s.grant_max_per_24h));
  end if;

  begin
    update public.credit_accounts set balance = balance + v_amt, updated_at = now()
     where org_id = p_org returning * into v_acc;
    v_txn := public.credit_log(p_org, 'grant', v_amt, null, v_ext, 'owner grant: ' || v_why);
  exception
    when unique_violation then
      return public.owner_err('key_reused', 'That request key was already used for a different grant.');
    when numeric_value_out_of_range then
      return public.owner_err('balance_limit', 'The balance would be too large.');
  end;

  perform public.owner_audit('credits.grant', p_org::text,
    jsonb_build_object('org', p_org, 'credits', v_amt, 'transaction_id', v_txn, 'reason', v_why,
                       'idempotency_key', v_key, 'balance_after', v_acc.balance, 'granted_24h_after', v_used + v_amt),
    'notice');
  return jsonb_build_object('ok', true, 'duplicate', false, 'transaction_id', v_txn, 'credits', v_amt,
                            'balance', v_acc.balance, 'available', v_acc.balance - v_acc.reserved,
                            'granted_24h', v_used + v_amt, 'cap_per_call', s.grant_max_per_call, 'cap_24h', s.grant_max_per_24h);
end
$$;

-- Take back (part of) a grant: bounded by what the grant's lot still holds and by the organization's
-- available credits; the rest is recorded as a shortfall. One reversal per grant (the ledger's unique
-- external id), so a retry is a no-op that answers duplicate.
create or replace function public.owner_reverse_grant(p_transaction_id bigint, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  g       jsonb;
  s       public.owner_security_settings;
  t       public.credit_transactions;
  l       public.credit_lots;
  v_acc   public.credit_accounts;
  v_prior public.credit_transactions;
  v_why   text := btrim(coalesce(p_reason, ''));
  v_ext   text;
  v_unspent numeric;
  v_take  numeric;
  v_txn   bigint;
begin
  g := public.owner_guard('reverse_grant', 20);
  if g is not null then return g; end if;
  select * into s from public.owner_security_settings limit 1;
  if char_length(v_why) < 8 or char_length(v_why) > 300 then
    return public.owner_err('reason_required', 'Give a reason of 8 to 300 characters.');
  end if;

  select * into t from public.credit_transactions where id = p_transaction_id;
  if not found or t.kind <> 'grant' then
    return public.owner_err('not_a_grant', 'That ledger row is not a grant.');
  end if;
  -- Owner grants and manual grant_credits rows only; welcome credits, invite rewards and the like are not.
  if not (t.external_id like 'owner-grant:%' or (t.external_id is null and t.created_by is not null)) then
    return public.owner_err('not_reversible', 'Only a grant given by an owner or admin can be reversed here.');
  end if;
  if t.created_at < now() - make_interval(days => s.reverse_window_days) then
    return public.owner_err('too_old', 'That grant is older than the reversal window.',
      jsonb_build_object('window_days', s.reverse_window_days));
  end if;

  v_ext := 'owner-reverse:' || t.id;
  v_acc := public.credit_account_lock(t.org_id);
  select * into v_prior from public.credit_transactions where external_id = v_ext;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'transaction_id', v_prior.id, 'reversed', -v_prior.amount,
                              'shortfall', t.amount + v_prior.amount, 'balance', v_acc.balance);
  end if;

  select * into l from public.credit_lots where created_txn = t.id;
  v_unspent := case when found then greatest(l.remaining - l.held, 0) else t.amount end;
  v_take := least(t.amount, v_unspent, greatest(v_acc.balance - v_acc.reserved, 0));
  if v_take <= 0 then
    return public.owner_err('nothing_to_reverse', 'None of that grant is left to take back.',
      jsonb_build_object('granted', t.amount, 'shortfall', t.amount));
  end if;

  begin
    update public.credit_accounts set balance = balance - v_take, updated_at = now()
     where org_id = t.org_id returning * into v_acc;
    v_txn := public.credit_log(t.org_id, 'adjust', -v_take, null, v_ext,
                               'owner reversal of grant #' || t.id || ': ' || v_why);
  exception
    when unique_violation then
      return public.owner_err('already_reversed', 'That grant was already reversed.');
    when sqlstate 'NS402' then
      return public.owner_err('nothing_to_reverse', 'None of that grant is left to take back.',
        jsonb_build_object('granted', t.amount, 'shortfall', t.amount));
  end;

  perform public.owner_audit('credits.reverse', t.org_id::text,
    jsonb_build_object('org', t.org_id, 'grant_transaction_id', t.id, 'granted', t.amount, 'reversed', v_take,
                       'shortfall', t.amount - v_take, 'transaction_id', v_txn, 'reason', v_why, 'balance_after', v_acc.balance),
    'warning');
  return jsonb_build_object('ok', true, 'duplicate', false, 'transaction_id', v_txn, 'granted', t.amount,
                            'reversed', v_take, 'shortfall', t.amount - v_take, 'balance', v_acc.balance,
                            'available', v_acc.balance - v_acc.reserved);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Credit prices: set, delete, restore (with history)
-- ───────────────────────────────────────────────────────────────────────────

-- The one place a price is written by an owner function. Not callable through the API.
-- p_keep_note: true = a null p_note keeps the current note (set); false = p_note is written as given (restore).
create or replace function public.owner_price_write(
  p_unit text, p_rate numeric, p_margin numeric, p_note text, p_keep_note boolean, p_delete boolean,
  p_action text, p_reason text, p_confirm boolean, p_restored_from bigint
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  c_max_rate constant numeric := 1000000;
  s        public.owner_security_settings;
  o        public.credit_prices;
  v_old    boolean := false;
  v_unit   text := btrim(coalesce(p_unit, ''));
  v_rate   numeric;
  v_margin numeric;
  v_note   text;
  v_need   text;
  v_r      numeric;
  v_c      numeric;
  v_hist   bigint;
  v_detail jsonb;
  v_old_j  jsonb;
  v_new_j  jsonb;
begin
  select * into s from public.owner_security_settings limit 1;
  if v_unit !~ '^[a-z][a-z0-9_]{0,62}$' then
    return public.owner_err('bad_unit', 'The unit name is not valid.');
  end if;
  perform pg_advisory_xact_lock(hashtext('nightshift.owner_price'), hashtext(v_unit));
  select * into o from public.credit_prices where unit = v_unit for update;
  v_old := found;
  v_old_j := case when v_old then jsonb_build_object('credits_per_unit', o.credits_per_unit, 'margin', o.margin) end;

  if p_delete then
    if not v_old then
      return public.owner_err('no_such_price', 'That unit has no price to delete.');
    end if;
    v_need := 'delete';
  else
    if p_rate is null or not (p_rate >= 0 and p_rate < 'Infinity'::numeric) or p_rate > c_max_rate then
      return public.owner_err('bad_rate', 'The rate must be a number from 0 to 1,000,000.', jsonb_build_object('max', c_max_rate));
    end if;
    if p_margin is null or not (p_margin >= 0 and p_margin <= 10) then
      return public.owner_err('bad_margin', 'The margin must be a number from 0 to 10.');
    end if;
    v_rate := round(p_rate, 8);
    v_margin := round(p_margin, 4);
    if v_rate = 0 and p_rate > 0 then
      return public.owner_err('bad_rate', 'That rate is too small to store.');
    end if;
    v_note := case when p_note is null and p_keep_note and v_old then o.note else nullif(btrim(coalesce(p_note, '')), '') end;
    if v_note is not null and char_length(v_note) > 300 then
      return public.owner_err('bad_note', 'The note may be at most 300 characters.');
    end if;
    v_new_j := jsonb_build_object('credits_per_unit', v_rate, 'margin', v_margin);
    if v_old and o.credits_per_unit = v_rate and o.margin = v_margin and o.note is not distinct from v_note then
      return jsonb_build_object('ok', true, 'unchanged', true, 'unit', v_unit, 'old', v_old_j, 'new', v_new_j);
    end if;
    if v_rate = 0 then
      v_need := 'zero';
    elsif v_old then
      if o.credits_per_unit = 0 then
        v_need := 'was_zero';
      else
        v_r := v_rate / o.credits_per_unit;
        v_c := (v_rate * (1 + v_margin)) / (o.credits_per_unit * (1 + o.margin));
        if v_r > s.price_max_change_ratio or v_r < 1 / s.price_max_change_ratio
           or v_c > s.price_max_change_ratio or v_c < 1 / s.price_max_change_ratio then
          v_need := 'ratio';
        end if;
      end if;
    end if;
  end if;

  if v_need is not null and not coalesce(p_confirm, false) then
    return public.owner_err('confirm_required', 'This is a big price change. Confirm it explicitly to go on.',
      jsonb_build_object('reason', v_need, 'old', v_old_j, 'new', v_new_j, 'max_ratio', s.price_max_change_ratio,
                         'rate_ratio', round(v_r, 4), 'charged_ratio', round(v_c, 4)));
  end if;

  -- Tell the trail trigger this write is ours (it then skips its own history row).
  perform set_config('nightshift.owner_rpc', '1', true);
  if p_delete then
    delete from public.credit_prices where unit = v_unit;
  else
    insert into public.credit_prices (unit, credits_per_unit, margin, note)
    values (v_unit, v_rate, v_margin, v_note)
    on conflict (unit) do update
      set credits_per_unit = excluded.credits_per_unit, margin = excluded.margin, note = excluded.note;
  end if;
  perform set_config('nightshift.owner_rpc', '', true);

  insert into public.credit_price_history
    (unit, action, old_credits_per_unit, old_margin, old_note, new_credits_per_unit, new_margin, new_note,
     actor_user_id, reason, source, restored_from)
  values
    (v_unit, case when p_delete then 'delete' when p_action = 'restore' then 'restore' else 'set' end,
     o.credits_per_unit, o.margin, o.note,
     case when p_delete then null else v_rate end, case when p_delete then null else v_margin end,
     case when p_delete then null else v_note end,
     auth.uid(), left(nullif(btrim(coalesce(p_reason, '')), ''), 300), 'rpc', p_restored_from)
  returning id into v_hist;
  -- (o is empty when the unit is new, so the old_* columns above are null.)

  v_detail := jsonb_build_object('unit', v_unit, 'history_id', v_hist, 'action', p_action, 'old', v_old_j,
                                 'new', case when p_delete then null else v_new_j end,
                                 'reason', left(nullif(btrim(coalesce(p_reason, '')), ''), 300));
  perform public.owner_audit('credits.price', v_unit, v_detail, case when p_delete or v_rate = 0 then 'warning' else 'notice' end);
  return jsonb_build_object('ok', true, 'unchanged', false, 'history_id', v_hist, 'unit', v_unit,
                            'action', p_action, 'old', v_old_j, 'new', case when p_delete then null else v_new_j end);
end
$$;

create or replace function public.owner_set_credit_price(
  p_unit text, p_credits_per_unit numeric, p_margin numeric, p_note text default null,
  p_reason text default null, p_confirm_big_change boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  g jsonb;
begin
  g := public.owner_guard('credit_price', 60);
  if g is not null then return g; end if;
  return public.owner_price_write(p_unit, p_credits_per_unit, p_margin, p_note, true, false, 'set',
                                  p_reason, p_confirm_big_change, null);
end
$$;

-- Deleting a price is always a big change: p_confirm_big_change must be true.
create or replace function public.owner_delete_credit_price(
  p_unit text, p_reason text default null, p_confirm_big_change boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  g jsonb;
begin
  g := public.owner_guard('credit_price', 60);
  if g is not null then return g; end if;
  return public.owner_price_write(p_unit, null, null, null, false, true, 'delete', p_reason, p_confirm_big_change, null);
end
$$;

-- Put a unit back to what it was BEFORE history row p_history_id changed it (a price that row created
-- is removed again). Goes through the same bounds and confirm guard as any other change.
create or replace function public.owner_restore_credit_price(
  p_history_id bigint, p_reason text default null, p_confirm_big_change boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  g jsonb;
  h public.credit_price_history;
begin
  g := public.owner_guard('credit_price', 60);
  if g is not null then return g; end if;
  select * into h from public.credit_price_history where id = p_history_id;
  if not found then
    return public.owner_err('no_such_history', 'That history entry does not exist.');
  end if;
  if h.old_credits_per_unit is null then
    return public.owner_price_write(h.unit, null, null, null, false, true, 'restore', p_reason, p_confirm_big_change, h.id);
  end if;
  return public.owner_price_write(h.unit, h.old_credits_per_unit, h.old_margin, h.old_note, false, false, 'restore',
                                  p_reason, p_confirm_big_change, h.id);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The roster: add, change role, remove
-- ───────────────────────────────────────────────────────────────────────────

-- Roster changes are serialised by one lock; the last-owner count is taken under it.
create or replace function public.owner_add_member(p_email text, p_role text, p_reason text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  g        jsonb;
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_caller text;
  v_why    text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
  v_id     uuid;
begin
  g := public.owner_guard('member', 30);
  if g is not null then return g; end if;
  if p_role is null or p_role not in ('owner', 'admin', 'editor', 'viewer') then
    return public.owner_err('bad_role', 'The role must be owner, admin, editor or viewer.');
  end if;
  if char_length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return public.owner_err('bad_email', 'That is not a valid e-mail address.');
  end if;
  perform pg_advisory_xact_lock(hashtext('nightshift.owner'), hashtext('roster'));
  v_caller := public.platform_role();
  if p_role in ('owner', 'admin') and v_caller is distinct from 'owner' then
    return public.owner_err('owner_required', 'Only an owner can add an admin or an owner.');
  end if;
  begin
    insert into public.app_members (email, role, created_by) values (v_email, p_role, auth.uid()) returning id into v_id;
  exception when unique_violation then
    return public.owner_err('already_member', 'That address is already on the roster.');
  end;
  perform public.owner_audit('member.add', v_email,
    jsonb_build_object('member_id', v_id, 'email', v_email, 'role', p_role, 'reason', v_why),
    case when p_role in ('owner', 'admin') then 'critical' else 'notice' end);
  return jsonb_build_object('ok', true, 'member_id', v_id, 'email', v_email, 'role', p_role);
end
$$;

create or replace function public.owner_set_member_role(p_member uuid, p_role text, p_reason text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  g        jsonb;
  m        public.app_members;
  v_caller text;
  v_why    text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
  v_others integer;
begin
  g := public.owner_guard('member', 30);
  if g is not null then return g; end if;
  if p_role is null or p_role not in ('owner', 'admin', 'editor', 'viewer') then
    return public.owner_err('bad_role', 'The role must be owner, admin, editor or viewer.');
  end if;
  perform pg_advisory_xact_lock(hashtext('nightshift.owner'), hashtext('roster'));
  select * into m from public.app_members where id = p_member for update;
  if not found then
    return public.owner_err('no_such_member', 'That person is not on the roster.');
  end if;
  v_caller := public.platform_role();
  if m.user_id = auth.uid() or (m.user_id is null and lower(m.email) = public.my_confirmed_email()) then
    return public.owner_err('self_change', 'You cannot change your own role. Ask another owner.');
  end if;
  if m.role = p_role then
    return jsonb_build_object('ok', true, 'unchanged', true, 'member_id', m.id, 'role', m.role);
  end if;
  if (m.role in ('owner', 'admin') or p_role in ('owner', 'admin')) and v_caller is distinct from 'owner' then
    return public.owner_err('owner_required', 'Only an owner can change an admin or an owner, or make one.');
  end if;
  if m.role = 'owner' then
    select count(*) into v_others
      from public.app_members o join auth.users u on u.id = o.user_id
     where o.role = 'owner' and o.id <> m.id and u.email_confirmed_at is not null;
    if v_others < 1 then
      return public.owner_err('last_owner', 'This is the only owner with a confirmed account. Make another owner first.');
    end if;
  end if;
  update public.app_members set role = p_role where id = m.id;
  perform public.owner_audit('member.role', m.email,
    jsonb_build_object('member_id', m.id, 'email', m.email, 'from', m.role, 'to', p_role, 'reason', v_why),
    case when m.role in ('owner', 'admin') or p_role in ('owner', 'admin') then 'critical' else 'notice' end);
  return jsonb_build_object('ok', true, 'unchanged', false, 'member_id', m.id, 'from', m.role, 'role', p_role);
end
$$;

create or replace function public.owner_remove_member(p_member uuid, p_reason text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  g        jsonb;
  m        public.app_members;
  v_caller text;
  v_why    text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
  v_others integer;
begin
  g := public.owner_guard('member', 30);
  if g is not null then return g; end if;
  perform pg_advisory_xact_lock(hashtext('nightshift.owner'), hashtext('roster'));
  select * into m from public.app_members where id = p_member for update;
  if not found then
    return public.owner_err('no_such_member', 'That person is not on the roster.');
  end if;
  v_caller := public.platform_role();
  if m.user_id = auth.uid() or (m.user_id is null and lower(m.email) = public.my_confirmed_email()) then
    return public.owner_err('self_change', 'You cannot remove yourself. Ask another owner.');
  end if;
  if m.role in ('owner', 'admin') and v_caller is distinct from 'owner' then
    return public.owner_err('owner_required', 'Only an owner can remove an admin or an owner.');
  end if;
  if m.role = 'owner' then
    select count(*) into v_others
      from public.app_members o join auth.users u on u.id = o.user_id
     where o.role = 'owner' and o.id <> m.id and u.email_confirmed_at is not null;
    if v_others < 1 then
      return public.owner_err('last_owner', 'This is the only owner with a confirmed account. Make another owner first.');
    end if;
  end if;
  delete from public.app_members where id = m.id;
  perform public.owner_audit('member.remove', m.email,
    jsonb_build_object('member_id', m.id, 'email', m.email, 'role', m.role, 'reason', v_why),
    case when m.role in ('owner', 'admin') then 'critical' else 'notice' end);
  return jsonb_build_object('ok', true, 'member_id', m.id, 'removed_role', m.role);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Trails on what the browser still writes directly (they observe; they never block)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.app_members_security_trail() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_kind   text;
  v_sev    text;
  v_target text;
  v_detail jsonb;
begin
  begin
    if tg_op = 'INSERT' then
      v_kind := 'roster.add';
      v_sev := case when new.role in ('owner', 'admin') then 'critical' else 'notice' end;
      v_target := new.email;
      v_detail := jsonb_build_object('member_id', new.id, 'email', new.email, 'role', new.role, 'bound', new.user_id is not null);
    elsif tg_op = 'UPDATE' then
      if new.role is distinct from old.role then
        v_kind := 'roster.role';
        v_sev := case when old.role in ('owner', 'admin') or new.role in ('owner', 'admin') then 'critical' else 'notice' end;
        v_detail := jsonb_build_object('member_id', new.id, 'email', new.email, 'from', old.role, 'to', new.role);
      elsif new.user_id is distinct from old.user_id then
        v_kind := 'roster.bind';
        v_sev := case when new.role in ('owner', 'admin') then 'warning' else 'info' end;
        v_detail := jsonb_build_object('member_id', new.id, 'email', new.email, 'role', new.role, 'bound', new.user_id is not null);
      elsif lower(new.email) is distinct from lower(old.email) then
        v_kind := 'roster.email';
        v_sev := 'warning';
        v_detail := jsonb_build_object('member_id', new.id, 'from', old.email, 'to', new.email, 'role', new.role);
      else
        return null;
      end if;
      v_target := new.email;
    else
      v_kind := 'roster.remove';
      v_sev := case when old.role in ('owner', 'admin') then 'critical' else 'notice' end;
      v_target := old.email;
      v_detail := jsonb_build_object('member_id', old.id, 'email', old.email, 'role', old.role, 'bound', old.user_id is not null);
    end if;
    perform public.security_event_log(v_kind, v_sev, v_target, v_detail);
  exception when others then
    raise warning 'security trail (app_members) failed: %', sqlerrm;
  end;
  return null;
end
$$;

create or replace function public.credit_prices_security_trail() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_unit   text;
  v_kind   text;
  v_sev    text;
  v_detail jsonb;
begin
  v_unit := case when tg_op = 'DELETE' then old.unit else new.unit end;
  if tg_op = 'UPDATE' and new.credits_per_unit = old.credits_per_unit and new.margin = old.margin
     and new.note is not distinct from old.note then
    return null;
  end if;
  begin
    v_kind := case tg_op when 'INSERT' then 'price.add' when 'UPDATE' then 'price.change' else 'price.remove' end;
    v_sev := case when tg_op = 'DELETE' then 'warning' when new.credits_per_unit = 0 then 'critical' else 'notice' end;
    v_detail := jsonb_build_object('unit', v_unit,
      'old', case when tg_op <> 'INSERT' then jsonb_build_object('credits_per_unit', old.credits_per_unit, 'margin', old.margin) end,
      'new', case when tg_op <> 'DELETE' then jsonb_build_object('credits_per_unit', new.credits_per_unit, 'margin', new.margin) end,
      'via', case when coalesce(current_setting('nightshift.owner_rpc', true), '') = '1' then 'owner_function' else 'direct' end);
    perform public.security_event_log(v_kind, v_sev, v_unit, v_detail);
  exception when others then
    raise warning 'security trail (credit_prices) failed: %', sqlerrm;
  end;
  -- A direct write also gets a history row, so a deleted or overwritten price can be restored.
  begin
    if coalesce(current_setting('nightshift.owner_rpc', true), '') <> '1' then
      insert into public.credit_price_history
        (unit, action, old_credits_per_unit, old_margin, old_note, new_credits_per_unit, new_margin, new_note,
         actor_user_id, source)
      values
        (v_unit, case when tg_op = 'DELETE' then 'delete' else 'set' end,
         case when tg_op <> 'INSERT' then old.credits_per_unit end, case when tg_op <> 'INSERT' then old.margin end,
         case when tg_op <> 'INSERT' then old.note end,
         case when tg_op <> 'DELETE' then new.credits_per_unit end, case when tg_op <> 'DELETE' then new.margin end,
         case when tg_op <> 'DELETE' then new.note end,
         auth.uid(), 'direct');
    end if;
  exception when others then
    raise warning 'price history (credit_prices) failed: %', sqlerrm;
  end;
  return null;
end
$$;

-- Flipping the gate or a cap in the SQL editor leaves a mark too (the actor is empty there).
create or replace function public.owner_security_settings_trail() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  begin
    perform public.security_event_log('settings.change',
      case when new.admin_aal2_required is distinct from old.admin_aal2_required then 'critical' else 'warning' end,
      'owner_security_settings',
      jsonb_build_object('admin_aal2_required', jsonb_build_array(old.admin_aal2_required, new.admin_aal2_required),
                         'recent_mfa_minutes', jsonb_build_array(old.recent_mfa_minutes, new.recent_mfa_minutes),
                         'grant_max_per_call', jsonb_build_array(old.grant_max_per_call, new.grant_max_per_call),
                         'grant_max_per_24h', jsonb_build_array(old.grant_max_per_24h, new.grant_max_per_24h),
                         'price_max_change_ratio', jsonb_build_array(old.price_max_change_ratio, new.price_max_change_ratio),
                         'reverse_window_days', jsonb_build_array(old.reverse_window_days, new.reverse_window_days)));
  exception when others then
    raise warning 'security trail (owner_security_settings) failed: %', sqlerrm;
  end;
  return null;
end
$$;

drop trigger if exists app_members_security_trail on public.app_members;
create trigger app_members_security_trail
  after insert or update or delete on public.app_members
  for each row execute function public.app_members_security_trail();

drop trigger if exists credit_prices_security_trail on public.credit_prices;
create trigger credit_prices_security_trail
  after insert or update or delete on public.credit_prices
  for each row execute function public.credit_prices_security_trail();

drop trigger if exists owner_security_settings_trail on public.owner_security_settings;
create trigger owner_security_settings_trail
  after update on public.owner_security_settings
  for each row execute function public.owner_security_settings_trail();

-- ───────────────────────────────────────────────────────────────────────────
-- 8. The audit action list: 0093's body verbatim plus this file's seven actions
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.audit_action_allowed(p_action text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_action, '') = any (array[
    'agent.run', 'api.activate', 'api.monthly_limit', 'api.topup_checkout', 'api_key.access', 'api_key.create',
    'api_key.revoke', 'billing.portal', 'billing.refresh', 'billing.settings', 'billing.topup', 'captions.delete',
    'channel.dna.update', 'channel.youtube.connect', 'channel.youtube.connect_failed', 'channel.youtube.disconnect',
    'character.create', 'character.delete', 'character.update', 'creative.cancel', 'creative.generate',
    'editor.export_request', 'editor.project_create', 'editor.project_delete', 'editor.send_asset',
    'media.delete', 'media.folder_create', 'media.folder_delete', 'media.folder_rename', 'media.move',
    'media.upload_request', 'model.availability', 'scene.regenerate', 'secret.write', 'series.create',
    'series.update', 'storyboard.approve', 'storyboard.discard', 'storyboard.edit', 'storyboard.reopen',
    'style_kit.add_library', 'style_kit.attach', 'style_kit.create', 'style_kit.delete', 'style_kit.detach',
    'style_kit.update', 'variable.write', 'video.download_request', 'video.publish_request', 'video.repurpose',
    'workflow.cancel', 'workflow.delete', 'workflow.run', 'workflow.save',
    -- 0093: connecting, disconnecting and re-limiting an AI app (oauth_* functions).
    'mcp.connect', 'mcp.disconnect', 'mcp.disconnect_all', 'mcp.limit',
    -- 0107: the owner actions (owner_* functions) and the second-factor gate.
    'credits.grant', 'credits.reverse', 'credits.price', 'member.add', 'member.role', 'member.remove', 'security.gate',
    -- The comment inbox (0081, in review when this was written): its routes audit
    -- through their own helper, auditInbox().
    'inbox.draft.discard', 'inbox.draft.edit', 'inbox.draft.request', 'inbox.reply.approve', 'inbox.reply.retry'
  ]::text[])
  or coalesce(p_action, '') ~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'
  or coalesce(p_action, '') ~ '^learning\.(approve|reject)$'
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 9. Who may do what
-- ───────────────────────────────────────────────────────────────────────────

alter table public.owner_security_settings enable row level security;
alter table public.security_events enable row level security;
alter table public.credit_price_history enable row level security;

-- No policy on the first two: no API role reads or writes them (definer functions only).
revoke all on public.owner_security_settings from public, anon, authenticated, service_role;
revoke all on public.security_events from public, anon, authenticated, service_role;
revoke all on public.credit_price_history from public, anon, authenticated, service_role;
revoke all on sequence public.security_events_id_seq from public, anon, authenticated, service_role;
revoke all on sequence public.credit_price_history_id_seq from public, anon, authenticated, service_role;

-- The operator bot (service key) may read the trail; nobody writes it except the definer functions.
grant select on public.security_events to service_role;
-- A platform admin reads the price history directly (the Credits page); no one writes it.
grant select on public.credit_price_history to authenticated, service_role;

drop policy if exists credit_price_history_select on public.credit_price_history;
create policy credit_price_history_select on public.credit_price_history
  for select to authenticated using ((select public.is_platform_admin()));

-- Internal helpers and trigger functions: not callable by any API role.
revoke all on function public.owner_err(text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.owner_security_append_only() from public, anon, authenticated, service_role;
revoke all on function public.owner_security_settings_no_delete() from public, anon, authenticated, service_role;
revoke all on function public.owner_security_settings_stamp() from public, anon, authenticated, service_role;
revoke all on function public.security_event_log(text, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.owner_audit(text, text, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.admin_mfa_state(boolean) from public, anon, authenticated, service_role;
revoke all on function public.owner_guard(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.owner_admin_factors() from public, anon, authenticated, service_role;
revoke all on function public.owner_price_write(text, numeric, numeric, text, boolean, boolean, text, text, boolean, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.app_members_security_trail() from public, anon, authenticated, service_role;
revoke all on function public.credit_prices_security_trail() from public, anon, authenticated, service_role;
revoke all on function public.owner_security_settings_trail() from public, anon, authenticated, service_role;
revoke all on function public.audit_action_allowed(text) from public, anon, authenticated, service_role;

-- Signed-in callers (each checks platform owner/admin itself, except admin_aal_ok which only reports).
revoke all on function public.admin_aal_ok() from public, anon, authenticated, service_role;
revoke all on function public.owner_security_get() from public, anon, authenticated, service_role;
revoke all on function public.enable_admin_mfa() from public, anon, authenticated, service_role;
revoke all on function public.disable_admin_mfa() from public, anon, authenticated, service_role;
revoke all on function public.owner_security_events(integer) from public, anon, authenticated, service_role;
revoke all on function public.owner_grant_credits(uuid, numeric, text, text) from public, anon, authenticated, service_role;
revoke all on function public.owner_reverse_grant(bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.owner_set_credit_price(text, numeric, numeric, text, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.owner_delete_credit_price(text, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.owner_restore_credit_price(bigint, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.owner_add_member(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.owner_set_member_role(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.owner_remove_member(uuid, text) from public, anon, authenticated, service_role;

grant execute on function public.admin_aal_ok() to authenticated;
grant execute on function public.owner_security_get() to authenticated;
grant execute on function public.enable_admin_mfa() to authenticated;
grant execute on function public.disable_admin_mfa() to authenticated;
grant execute on function public.owner_security_events(integer) to authenticated;
grant execute on function public.owner_grant_credits(uuid, numeric, text, text) to authenticated;
grant execute on function public.owner_reverse_grant(bigint, text) to authenticated;
grant execute on function public.owner_set_credit_price(text, numeric, numeric, text, text, boolean) to authenticated;
grant execute on function public.owner_delete_credit_price(text, text, boolean) to authenticated;
grant execute on function public.owner_restore_credit_price(bigint, text, boolean) to authenticated;
grant execute on function public.owner_add_member(text, text, text) to authenticated;
grant execute on function public.owner_set_member_role(uuid, text, text) to authenticated;
grant execute on function public.owner_remove_member(uuid, text) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     (select count(*) = 1 and bool_and(not admin_aal2_required) from public.owner_security_settings) as gate_off_one_row,
--     (select count(*) = 3 from pg_trigger where not tgisinternal and tgname in
--        ('app_members_security_trail', 'credit_prices_security_trail', 'owner_security_settings_trail')) as trails,
--     exists (select 1 from pg_indexes where indexname = 'credit_transactions_grant_created_idx') as grant_index,
--     not has_table_privilege('authenticated', 'public.owner_security_settings', 'SELECT')
--       and not has_table_privilege('authenticated', 'public.security_events', 'SELECT')
--       and not has_table_privilege('anon', 'public.credit_price_history', 'SELECT') as tables_closed,
--     has_function_privilege('authenticated', 'public.owner_grant_credits(uuid,numeric,text,text)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.owner_grant_credits(uuid,numeric,text,text)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.owner_guard(text,integer)', 'EXECUTE') as functions_scoped,
--     (select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
--        from pg_proc p where p.pronamespace = 'public'::regnamespace
--         and p.proname in ('admin_aal_ok', 'admin_mfa_state', 'enable_admin_mfa', 'disable_admin_mfa', 'owner_guard',
--           'owner_grant_credits', 'owner_reverse_grant', 'owner_set_credit_price', 'owner_delete_credit_price',
--           'owner_restore_credit_price', 'owner_add_member', 'owner_set_member_role', 'owner_remove_member',
--           'owner_security_get', 'owner_security_events', 'security_event_log', 'owner_audit')) as definer_pins_search_path,
--     public.audit_action_allowed('credits.grant') and public.audit_action_allowed('member.remove')
--       and public.audit_action_allowed('security.gate') and public.audit_action_allowed('mcp.limit') as audit_list;
--
-- ROLLBACK (a new forward migration, never an edit; nothing here is referenced by the app yet):
--   drop trigger if exists app_members_security_trail on public.app_members;
--   drop trigger if exists credit_prices_security_trail on public.credit_prices;
--   (then drop the functions and the three tables, and restore audit_action_allowed to 0093's body)
