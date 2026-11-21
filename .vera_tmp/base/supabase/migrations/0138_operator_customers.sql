-- 0138_operator_customers.sql — the operator's Customers page (/{channel}/customers): how many people and workspaces there are,
-- and per workspace the credits it spent, bought and holds, its plan and its generations. Read-only. docs/MIGRATIONS.md "0138".
--
-- WHAT IT ADDS (three functions, no table, no column, no index, no policy; it replaces nothing)
--   operator_customer_totals()                       one row: the headline numbers.
--   operator_customer_daily(p_days)                  one row per UTC day, the last p_days days (1-90): new workspaces, credits spent,
--                                                    workspaces that spent.
--   operator_customer_accounts(p_search, p_sort, p_limit, p_offset)
--                                                    one page of workspaces (at most 100 rows), sorted in the database, with the
--                                                    number of matching workspaces on every row (total_count) for the pager.
--
-- WHERE EACH NUMBER COMES FROM (nothing here is a constant or an estimate)
--   people          auth.users: every account that signed up (created_at; last_sign_in_at as GoTrue records it).
--   workspaces      public.organizations, the operator's own (default_org_id(), credit-exempt by design) left out everywhere.
--                   A workspace has one person (0091); the person shown is its earliest owner row of org_members (the earliest
--                   member when no row says owner), the address from auth.users, else the one on the membership row.
--   credits spent   the ledger, public.credit_transactions (0020): the credits a 'capture' row took, less the credits a positive
--                   'refund' row gave back (a failed paid download is refunded that way, 0030). A 'reserve' is a hold, not a
--                   spend, and a 'release' returns a hold, so neither is counted: a job that failed charged nothing. A negative
--                   'refund' takes back a refunded PURCHASE (0021) and is not a spend either.
--   bought          'purchase' and 'subscription' rows (credits that came with a payment). granted = 'grant' rows (welcome
--                   credits, invite rewards, owner grants).
--   paid            public.payment_events (0021): one completed Paddle transaction per transaction id (the processed event when
--                   a retry left a duplicate beside it), in USD; a payment in another currency is COUNTED apart, never converted
--                   and never added as if it were dollars. Gross: before refunds, tax and fees.
--   balance         public.credit_accounts (0020): balance (credits owned, holds included) and reserved (on hold right now).
--   active          a workspace whose ledger has a capture in the window.
--   plan            the organization's highest live subscription (active, trialing, past_due), else the default plan: the rule
--                   of org_plan_internal() (0034), written as one join so a page of rows costs one query, not one per row.
--   generations     public.creative_jobs (0036): every job, and the failed ones (status failed or expired).
--   last activity   the newest of the workspace's last capture and its last generation.
--
-- WHO MAY CALL THEM: PLATFORM OWNER/ADMIN ONLY. They are SECURITY DEFINER (they read every workspace's ledger and every person's
-- address, which no customer may read) and therefore check sign-in and is_platform_admin() themselves, first, before anything is
-- read or any argument is looked at; everyone else gets 42501 with a message that names nothing. search_path is pinned. anon and
-- service_role cannot execute them: the Command Center reads them with the signed-in operator's own session and never holds the
-- service key. Nothing here writes, grants, prices or spends.
--
-- REQUIRES 0018 (organizations, org_members, is_platform_admin, default_org_id), 0020 (credit_accounts, credit_transactions),
-- 0021 (payment_events), 0034 (plans, subscriptions) and 0036 (creative_jobs). Additive and idempotent: create-or-replace of three
-- functions that did not exist; a replay changes nothing. Undo: docs/sql/rollback_0138_operator_customers.sql (owner-applied).
-- NUMBER. 0138, after 0136 (applied live) and 0137 (Character Studio, #686). This file names nothing of theirs, and neither of them
-- names anything of this file's (0137 alters no table these functions read and replaces none of the credit functions).
--
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  pair text[];
  h text;
begin
  if to_regprocedure('public.is_platform_admin()') is null
     or to_regprocedure('public.default_org_id()') is null
     or to_regclass('public.organizations') is null
     or to_regclass('public.org_members') is null then
    raise exception '0138 needs 0018_organizations.sql: apply it first';
  end if;
  if to_regclass('public.credit_accounts') is null or to_regclass('public.credit_transactions') is null then
    raise exception '0138 needs 0020_credits.sql: apply it first';
  end if;
  if to_regclass('public.payment_events') is null then
    raise exception '0138 needs 0021_credit_refunds.sql: apply it first';
  end if;
  if to_regclass('public.plans') is null or to_regclass('public.subscriptions') is null then
    raise exception '0138 needs 0034_plans_entitlements.sql: apply it first';
  end if;
  if to_regclass('public.creative_jobs') is null then
    raise exception '0138 needs 0036_creative_jobs.sql: apply it first';
  end if;
  -- Every name this file creates: absent, or this file's own body (a replay).
  foreach pair slice 1 in array array[
      ['public.operator_customer_totals()', '938bff459e8a932a7ffc9d078f0d6137'],
      ['public.operator_customer_daily(integer)', 'e80c9c92cf7a1625f02bc585ed549660'],
      ['public.operator_customer_accounts(text, text, integer, integer)', 'ed07a54a29c3110fcf03531c79c47984']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(pair[1]);
    if h is not null and h <> pair[2] then
      raise exception '0138 found % with a body that is not this file''s (md5 %): read the live body first', pair[1], h;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The headline numbers
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.operator_customer_totals()
  returns table (
    users_total             bigint,
    users_new_7d            bigint,
    users_new_30d           bigint,
    workspaces_total        bigint,
    workspaces_new_7d       bigint,
    workspaces_new_30d      bigint,
    active_7d               bigint,
    active_30d              bigint,
    credits_spent_total     numeric,
    credits_spent_30d       numeric,
    credits_purchased_total numeric,
    credits_granted_total   numeric,
    paid_usd_total          numeric,
    payments_other_currency bigint,
    balance_total           numeric,
    reserved_total          numeric
  )
  language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  v_internal uuid;
begin
  -- First, before any read: these numbers are every workspace's.
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'not available' using errcode = '42501';
  end if;
  v_internal := public.default_org_id();

  return query
  with ledger as (
    select t.org_id,
           t.created_at,
           case when t.kind = 'capture' then -t.amount
                when t.kind = 'refund' and t.amount > 0 then -t.amount
                else 0 end as spent,
           case when t.kind in ('purchase', 'subscription') then t.amount else 0 end as bought,
           case when t.kind = 'grant' then t.amount else 0 end as granted,
           (t.kind = 'capture' and t.amount < 0) as is_capture
      from public.credit_transactions t
     where t.org_id is distinct from v_internal
       and t.kind in ('capture', 'refund', 'purchase', 'subscription', 'grant')
  ),
  paid as (
    select distinct on (e.transaction_id) e.transaction_id, e.currency, e.amount_minor
      from public.payment_events e
     where e.provider = 'paddle' and e.event_type = 'transaction.completed'
       and e.status in ('processed', 'duplicate')
       and e.transaction_id is not null and e.amount_minor > 0
       and e.org_id is not null and e.org_id is distinct from v_internal
     order by e.transaction_id, (e.status = 'processed') desc, e.received_at
  )
  select
    (select count(*) from auth.users u),
    (select count(*) from auth.users u where u.created_at >= now() - interval '7 days'),
    (select count(*) from auth.users u where u.created_at >= now() - interval '30 days'),
    (select count(*) from public.organizations o where o.id is distinct from v_internal),
    (select count(*) from public.organizations o where o.id is distinct from v_internal and o.created_at >= now() - interval '7 days'),
    (select count(*) from public.organizations o where o.id is distinct from v_internal and o.created_at >= now() - interval '30 days'),
    (select count(distinct l.org_id) from ledger l where l.is_capture and l.created_at >= now() - interval '7 days'),
    (select count(distinct l.org_id) from ledger l where l.is_capture and l.created_at >= now() - interval '30 days'),
    (select coalesce(sum(l.spent), 0) from ledger l),
    (select coalesce(sum(l.spent), 0) from ledger l where l.created_at >= now() - interval '30 days'),
    (select coalesce(sum(l.bought), 0) from ledger l),
    (select coalesce(sum(l.granted), 0) from ledger l),
    (select coalesce(sum(p.amount_minor), 0) / 100.0 from paid p where p.currency = 'USD'),
    (select count(*) from paid p where p.currency is distinct from 'USD'),
    (select coalesce(sum(a.balance), 0) from public.credit_accounts a where a.org_id is distinct from v_internal),
    (select coalesce(sum(a.reserved), 0) from public.credit_accounts a where a.org_id is distinct from v_internal);
end
$$;

comment on function public.operator_customer_totals() is
  'Operator Customers page (migration 0138): people, workspaces, active workspaces, credits spent (captures less refunded captures; holds and releases never), bought, granted, paid (USD; other currencies counted apart) and outstanding. The operator''s own workspace is left out. Platform owner/admin only; read-only.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Day by day
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.operator_customer_daily(p_days integer default 30)
  returns table (
    day             date,
    signups         bigint,
    credits_spent   numeric,
    active_accounts bigint
  )
  language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  v_internal uuid;
  d_to   date;
  d_from date;
begin
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if p_days is null or p_days < 1 or p_days > 90 then
    raise exception 'p_days is 1 to 90' using errcode = '22023';
  end if;
  v_internal := public.default_org_id();
  d_to := (now() at time zone 'utc')::date;
  d_from := d_to - (p_days - 1);

  return query
  with days as (
    select g::date as dy from generate_series(d_from::timestamp, d_to::timestamp, interval '1 day') g
  ),
  ledger as (
    select (t.created_at at time zone 'utc')::date as dy,
           t.org_id,
           -t.amount as spent,
           (t.kind = 'capture' and t.amount < 0) as is_capture
      from public.credit_transactions t
     where t.org_id is distinct from v_internal
       and (t.kind = 'capture' or (t.kind = 'refund' and t.amount > 0))
       and t.created_at >= (d_from::timestamp at time zone 'utc')
  ),
  spend as (
    select l.dy, sum(l.spent) as spent, count(distinct l.org_id) filter (where l.is_capture) as active
      from ledger l
     group by l.dy
  ),
  joined as (
    select (o.created_at at time zone 'utc')::date as dy, count(*) as n
      from public.organizations o
     where o.id is distinct from v_internal
       and o.created_at >= (d_from::timestamp at time zone 'utc')
     group by 1
  )
  select d.dy, coalesce(j.n, 0), coalesce(s.spent, 0), coalesce(s.active, 0)
    from days d
    left join joined j on j.dy = d.dy
    left join spend s on s.dy = d.dy
   order by d.dy;
end
$$;

comment on function public.operator_customer_daily(integer) is
  'Operator Customers page (migration 0138): per UTC day of the last p_days (1-90), new workspaces, credits spent (captures less refunded captures) and workspaces with a capture. The operator''s own workspace is left out. Platform owner/admin only; read-only.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. One page of workspaces
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.operator_customer_accounts(
    p_search text default null, p_sort text default 'spent_total', p_limit integer default 50, p_offset integer default 0)
  returns table (
    org_id            uuid,
    name              text,
    owner_email       text,
    created_at        timestamptz,
    last_sign_in_at   timestamptz,
    last_activity_at  timestamptz,
    credits_spent_30d numeric,
    credits_spent     numeric,
    balance           numeric,
    reserved          numeric,
    credits_purchased numeric,
    credits_granted   numeric,
    paid_usd          numeric,
    payments_other_currency bigint,
    plan_id           text,
    plan_name         text,
    jobs_total        bigint,
    jobs_failed       bigint,
    total_count       bigint
  )
  language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  v_internal uuid;
  v_q    text;
  v_sort text;
begin
  -- First, before any read or any look at the arguments.
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'not available' using errcode = '42501';
  end if;
  v_sort := coalesce(p_sort, 'spent_total');
  if v_sort not in ('spent_total', 'spent_30d', 'balance', 'paid', 'signup', 'activity') then
    raise exception 'unknown sort' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'p_limit is 1 to 100 and p_offset 0 to 1000000' using errcode = '22023';
  end if;
  if p_search is not null and char_length(p_search) > 200 then
    raise exception 'the search is at most 200 characters' using errcode = '22023';
  end if;
  -- Matched as plain text (strpos), never as a pattern: a % or _ typed into the box is that character.
  v_q := nullif(lower(btrim(coalesce(p_search, ''))), '');
  v_internal := public.default_org_id();

  return query
  with person as (
    select distinct on (m.org_id) m.org_id,
           lower(coalesce(nullif(u.email, ''), nullif(m.email, ''))) as email,
           u.last_sign_in_at
      from public.org_members m
      left join auth.users u on u.id = m.user_id
     where m.org_id is distinct from v_internal
     order by m.org_id, (m.role = 'owner') desc, m.created_at, m.id
  ),
  orgs as (
    select o.id, o.name, o.created_at, p.email, p.last_sign_in_at
      from public.organizations o
      left join person p on p.org_id = o.id
     where o.id is distinct from v_internal
       and (v_q is null
            or strpos(lower(o.name), v_q) > 0
            or strpos(o.slug, v_q) > 0
            or strpos(coalesce(p.email, ''), v_q) > 0
            or o.id::text = v_q)
  ),
  ledger as (
    select t.org_id,
           coalesce(sum(case when t.kind = 'capture' then -t.amount
                             when t.kind = 'refund' and t.amount > 0 then -t.amount end), 0) as spent,
           coalesce(sum(case when t.kind = 'capture' then -t.amount
                             when t.kind = 'refund' and t.amount > 0 then -t.amount end)
                      filter (where t.created_at >= now() - interval '30 days'), 0) as spent_30d,
           coalesce(sum(t.amount) filter (where t.kind in ('purchase', 'subscription')), 0) as bought,
           coalesce(sum(t.amount) filter (where t.kind = 'grant'), 0) as granted,
           max(t.created_at) filter (where t.kind = 'capture') as last_capture
      from public.credit_transactions t
     where t.org_id in (select orgs.id from orgs)
       and t.kind in ('capture', 'refund', 'purchase', 'subscription', 'grant')
     group by t.org_id
  ),
  paid as (
    select x.org_id,
           coalesce(sum(x.amount_minor) filter (where x.currency = 'USD'), 0) / 100.0 as usd,
           count(*) filter (where x.currency is distinct from 'USD') as other
      from (select distinct on (e.transaction_id) e.transaction_id, e.org_id, e.currency, e.amount_minor
              from public.payment_events e
             where e.provider = 'paddle' and e.event_type = 'transaction.completed'
               and e.status in ('processed', 'duplicate')
               and e.transaction_id is not null and e.amount_minor > 0
               and e.org_id in (select orgs.id from orgs)
             order by e.transaction_id, (e.status = 'processed') desc, e.received_at) x
     group by x.org_id
  ),
  jobs as (
    select j.org_id, count(*) as n,
           count(*) filter (where j.status in ('failed', 'expired')) as failed,
           max(j.created_at) as last_job
      from public.creative_jobs j
     where j.org_id in (select orgs.id from orgs)
     group by j.org_id
  ),
  default_plan as (
    select pl.id, pl.name from public.plans pl where pl.is_default limit 1
  ),
  rows_ as (
    select o.id, o.name, o.email, o.created_at, o.last_sign_in_at,
           greatest(l.last_capture, jb.last_job) as last_activity,
           coalesce(l.spent_30d, 0) as spent_30d,
           coalesce(l.spent, 0) as spent,
           a.balance, a.reserved,
           coalesce(l.bought, 0) as bought,
           coalesce(l.granted, 0) as granted,
           coalesce(pd.usd, 0) as usd,
           coalesce(pd.other, 0) as other,
           coalesce(sp.id, dp.id) as plan_id,
           coalesce(sp.name, dp.name) as plan_name,
           coalesce(jb.n, 0) as n_jobs,
           coalesce(jb.failed, 0) as n_failed
      from orgs o
      left join ledger l on l.org_id = o.id
      left join paid pd on pd.org_id = o.id
      left join jobs jb on jb.org_id = o.id
      left join public.credit_accounts a on a.org_id = o.id
      left join lateral (
        select pl.id, pl.name
          from public.subscriptions s join public.plans pl on pl.id = s.plan_id
         where s.org_id = o.id and s.status in ('active', 'trialing', 'past_due')
         order by pl.sort_order desc, s.id desc
         limit 1) sp on true
      left join default_plan dp on true
  )
  select r.id, r.name, r.email, r.created_at, r.last_sign_in_at, r.last_activity,
         r.spent_30d, r.spent, r.balance, r.reserved, r.bought, r.granted, r.usd, r.other,
         r.plan_id, r.plan_name, r.n_jobs, r.n_failed,
         count(*) over ()
    from rows_ r
   order by (case v_sort when 'spent_total' then r.spent
                         when 'spent_30d' then r.spent_30d
                         when 'balance' then r.balance
                         when 'paid' then r.usd end) desc nulls last,
            (case v_sort when 'signup' then r.created_at
                         when 'activity' then r.last_activity end) desc nulls last,
            r.created_at desc, r.id
   limit p_limit offset p_offset;
end
$$;

comment on function public.operator_customer_accounts(text, text, integer, integer) is
  'Operator Customers page (migration 0138): one page (at most 100) of workspaces with the person, sign-up, last sign-in, last activity, credits spent (30 days and all time), balance, bought, granted, paid, plan and generations, sorted in the database; total_count is the number of matching workspaces. The operator''s own workspace is left out. Platform owner/admin only; read-only.';

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Privileges: signed-in sessions only (each function refuses everyone but a platform owner/admin itself)
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.operator_customer_totals() from public, anon, authenticated, service_role;
revoke all on function public.operator_customer_daily(integer) from public, anon, authenticated, service_role;
revoke all on function public.operator_customer_accounts(text, text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.operator_customer_totals() to authenticated;
grant execute on function public.operator_customer_daily(integer) to authenticated;
grant execute on function public.operator_customer_accounts(text, text, integer, integer) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. End state
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  pair text[];
begin
  foreach pair slice 1 in array array[
      ['public.operator_customer_totals()', '938bff459e8a932a7ffc9d078f0d6137'],
      ['public.operator_customer_daily(integer)', 'e80c9c92cf7a1625f02bc585ed549660'],
      ['public.operator_customer_accounts(text, text, integer, integer)', 'ed07a54a29c3110fcf03531c79c47984']] loop
    if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(pair[1])) is distinct from pair[2] then
      raise exception '0138 end state: % does not hold the body this file expects', pair[1];
    end if;
    if not has_function_privilege('authenticated', pair[1], 'EXECUTE')
       or has_function_privilege('anon', pair[1], 'EXECUTE')
       or has_function_privilege('service_role', pair[1], 'EXECUTE') then
      raise exception '0138 end state: % has the wrong grants', pair[1];
    end if;
    if exists (select 1 from pg_proc p where p.oid = to_regprocedure(pair[1])
                and (not p.prosecdef or p.provolatile <> 's'
                     or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                     or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
      raise exception '0138 end state: % is not a stable SECURITY DEFINER with a fixed search_path, or PUBLIC may call it', pair[1];
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying, as the operator in the app or in the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   bool_and(p.prosecdef) as security_definer,
--   bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE')) as signed_in_may_call_and_is_refused_inside,
--   bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE') and not has_function_privilege('service_role', p.oid, 'EXECUTE')) as anon_and_service_cannot
--   from pg_proc p
--  where p.oid in ('public.operator_customer_totals()'::regprocedure, 'public.operator_customer_daily(integer)'::regprocedure,
--                  'public.operator_customer_accounts(text, text, integer, integer)'::regprocedure);
