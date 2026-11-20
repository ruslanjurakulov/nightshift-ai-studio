-- 0183_owner_costs.sql — the owner analytics hub's costs: provider spend, provider balances, and the costs only the owner knows.
-- docs/MIGRATIONS.md "0183", docs/OWNER_ANALYTICS.md.
--
-- *** LIVE ON APPLY. *** It adds one table (owner_cost_entries, closed to every API role) and six functions. It replaces nothing and
-- alters no existing table, column, policy or trigger. Its only writes are the owner's own cost entries and, through
-- owner_analytics_balance_enter(), a provider_balances row marked source = 'manual' (the column 0012 made for exactly that).
--
-- WHY. Profit is revenue (0182) less what the business paid to run. Three sources, each said for what it is:
--   * Provider spend: what each creative job's provider cost, as the platform recorded it when the job ran (creative_job_costs,
--     0037: usd_estimate, priced from the cost table at that moment), plus the pipeline's own usage costs (video_costs, 0002).
--     A cost row with no price is UNKNOWN: it is counted (unpriced_count) and never added as 0, so a total with one is marked
--     incomplete on screen.
--   * Balances: what is left on each provider account. Only where the provider's own API reports it (the balance worker writes
--     those, source = 'api'); otherwise the owner may type one in, and it is stored as source = 'manual' with the time it was
--     entered, so the page can badge it "entered by owner on <date>". Nothing here invents a balance or calls a provider.
--   * Costs only the owner knows (servers, tools, people, …), per month, typed in by the owner. A month with no entry is "not
--     entered", never "$0 of costs".
-- No value of any kind is written by this file: the amounts live only in the database, read at runtime by the owner.
--
-- WHO. Every function checks owner_analytics_is_owner() (0182: the platform owner, not an admin) before it reads or looks at an
-- argument (42501 otherwise), and every write also needs 0107's second factor when that gate is on (NS401). Execute is granted to
-- `authenticated` only. search_path is pinned. owner_cost_entries has RLS on and no policy.
--
-- THE APP WITHOUT THIS FILE. The costs tab says it needs migration 0183 and shows no profit figure; revenue (0182) is unaffected.
--
-- REQUIRES 0002 (video_costs), 0012 (provider_balances), 0037 (creative_job_costs), 0107 (admin_aal_ok) and 0182 (owner gate,
-- internal workspaces). Additive and idempotent. Undo: docs/sql/rollback_0183_owner_costs.sql.
--
-- NUMBER. 0183, reserved for the owner analytics stream; may be renumbered at merge (live ends at 0174).
set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.owner_analytics_is_owner()') is null or to_regprocedure('public.owner_analytics_internal_org_ids()') is null then
    raise exception '0183 needs 0182_owner_analytics.sql: apply it first';
  end if;
  if to_regclass('public.creative_job_costs') is null then
    raise exception '0183 needs 0037 (creative_job_costs): apply it first';
  end if;
  if to_regclass('public.video_costs') is null then
    raise exception '0183 needs 0002 (video_costs): apply it first';
  end if;
  if to_regclass('public.provider_balances') is null then
    raise exception '0183 needs 0012_billing.sql (provider_balances): apply it first';
  end if;
  if to_regprocedure('public.admin_aal_ok()') is null then
    raise exception '0183 needs 0107_owner_safety.sql (admin_aal_ok): apply it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 0. video_costs.recorded_at is text (0002): a value that is not an instant is skipped, not a failed page
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.owner_analytics_try_instant(p text) returns timestamptz
  language plpgsql immutable set search_path = public, pg_temp
as $$
begin
  return p::timestamptz;
exception when others then
  return null;
end
$$;

comment on function public.owner_analytics_try_instant(text) is
  'Migration 0183 (internal): a text timestamp as an instant, or null when it is not one. No API role may execute it.';
revoke all on function public.owner_analytics_try_instant(text) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Provider spend, by Tashkent day, provider and model
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.owner_analytics_provider_spend(p_from timestamptz, p_to timestamptz)
  returns table (
    day            date,
    source         text,
    provider       text,
    model          text,
    internal       boolean,
    cost_rows      bigint,
    usd_known      numeric,
    unpriced_count bigint
  )
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_internal uuid[];
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '1100 days' then
    raise exception 'a window is a start before its end, at most 1100 days' using errcode = '22023';
  end if;
  v_internal := array(select public.owner_analytics_internal_org_ids());

  return query
  select (c.recorded_at at time zone 'Asia/Tashkent')::date,
         'creative'::text,
         c.provider,
         coalesce(c.vendor_model, c.route, 'unknown'),
         coalesce(c.org_id = any (v_internal), false),
         count(*),
         -- Only the priced rows are summed; the unpriced ones are counted beside it, never added as 0.
         coalesce(sum(c.usd_estimate), 0),
         count(*) filter (where c.usd_estimate is null)
    from public.creative_job_costs c
   where c.recorded_at >= p_from and c.recorded_at < p_to
   group by 1, 3, 4, 5
  union all
  -- The pipeline's own videos (the operator's channels): internal by nature, so flagged as such and left out unless asked.
  select (v.at at time zone 'Asia/Tashkent')::date,
         'pipeline'::text,
         v.unit,
         coalesce(v.stage, 'unknown'),
         true,
         count(*),
         coalesce(sum(v.estimated_usd), 0)::numeric,
         count(*) filter (where v.estimated_usd is null)
    from (select x.*, public.owner_analytics_try_instant(x.recorded_at) as at from public.video_costs x) v
   where v.at >= p_from and v.at < p_to
   group by 1, 3, 4
   order by 1, 2, 3, 4
   limit 50000;
end
$$;

comment on function public.owner_analytics_provider_spend(timestamptz, timestamptz) is
  'Migration 0183: provider cost in [p_from, p_to) by Tashkent day, source (creative jobs / the pipeline), provider and model: how many cost rows, the sum of the priced ones, and how many were unpriced (unknown, never 0). Platform owner only; read-only.';

revoke all on function public.owner_analytics_provider_spend(timestamptz, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.owner_analytics_provider_spend(timestamptz, timestamptz) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Balances: the latest reading per provider and metric, from the API or typed in by the owner
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.owner_analytics_balances()
  returns table (provider text, metric text, remaining double precision, total double precision, unit text, source text,
                 checked_at timestamptz)
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  return query
  select distinct on (b.provider, b.metric)
         b.provider, b.metric, b.remaining, b.total, b.unit, b.source, b.checked_at
    from public.provider_balances b
   order by b.provider, b.metric, b.checked_at desc, b.id desc
   limit 500;
end
$$;

comment on function public.owner_analytics_balances() is
  'Migration 0183: the newest balance reading per provider and metric, with where it came from (api = the provider said so; manual = the owner typed it in) and when. Platform owner only; read-only.';

revoke all on function public.owner_analytics_balances() from public, anon, authenticated, service_role;
grant execute on function public.owner_analytics_balances() to authenticated;

create or replace function public.owner_analytics_balance_enter(p_provider text, p_metric text, p_remaining double precision, p_unit text)
  returns bigint
  language plpgsql volatile security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_id bigint;
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if not public.admin_aal_ok() then
    raise exception 'mfa_required' using errcode = 'NS401';
  end if;
  if p_provider is null or p_provider !~ '^[a-z0-9][a-z0-9._-]{0,39}$'
     or p_metric is null or p_metric !~ '^[a-z][a-z0-9_]{0,39}$'
     or p_unit is null or p_unit !~ '^[a-z][a-z0-9_]{0,19}$'
     or p_remaining is null or p_remaining < 0 or p_remaining > 1e12 or p_remaining <> p_remaining then
    raise exception 'invalid balance' using errcode = '22023';
  end if;
  -- Stored as 'manual': the page badges it "entered by owner on <date>" and never presents it as the provider's own reading.
  insert into public.provider_balances (provider, metric, remaining, total, unit, source, checked_at)
  values (p_provider, p_metric, p_remaining, null, p_unit, 'manual', now())
  returning id into v_id;
  return v_id;
end
$$;

comment on function public.owner_analytics_balance_enter(text, text, double precision, text) is
  'Migration 0183: the owner types in a provider balance the provider''s API does not report; stored as source = manual with the time. Platform owner only, second factor when 0107''s gate is on.';

revoke all on function public.owner_analytics_balance_enter(text, text, double precision, text) from public, anon, authenticated, service_role;
grant execute on function public.owner_analytics_balance_enter(text, text, double precision, text) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Costs only the owner knows, per month
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.owner_cost_entries (
  id         bigint generated always as identity primary key,
  month      date not null check (month = date_trunc('month', month)::date),
  category   text not null check (category in ('infrastructure', 'tools', 'people', 'marketing', 'legal', 'other')),
  amount_usd numeric(14, 2) not null check (amount_usd >= 0 and amount_usd < 1e10),
  note       text check (note is null or length(note) <= 300),
  entered_by uuid not null,
  entered_at timestamptz not null default now()
);

comment on table public.owner_cost_entries is
  'Migration 0183: the owner''s own monthly costs (infrastructure, tools, people, …), typed in by the owner for the analytics hub''s profit figures. Written only by owner_analytics_cost_add / _delete; no API role reads or writes it directly.';

alter table public.owner_cost_entries enable row level security;
revoke all on table public.owner_cost_entries from public, anon, authenticated, service_role;
revoke all on sequence public.owner_cost_entries_id_seq from public, anon, authenticated, service_role;
create index if not exists owner_cost_entries_month_idx on public.owner_cost_entries (month);

create or replace function public.owner_analytics_cost_add(p_month date, p_category text, p_amount numeric, p_note text default null)
  returns bigint
  language plpgsql volatile security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_id bigint;
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if not public.admin_aal_ok() then
    raise exception 'mfa_required' using errcode = 'NS401';
  end if;
  if p_month is null or p_month <> date_trunc('month', p_month)::date or p_month > (now() at time zone 'Asia/Tashkent')::date
     or p_category is null or p_category not in ('infrastructure', 'tools', 'people', 'marketing', 'legal', 'other')
     or p_amount is null or p_amount < 0 or p_amount >= 1e10 or (p_note is not null and length(p_note) > 300) then
    raise exception 'invalid cost entry' using errcode = '22023';
  end if;
  insert into public.owner_cost_entries (month, category, amount_usd, note, entered_by)
  values (p_month, p_category, round(p_amount, 2), nullif(btrim(p_note), ''), auth.uid())
  returning id into v_id;
  return v_id;
end
$$;

create or replace function public.owner_analytics_cost_delete(p_id bigint)
  returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if not public.admin_aal_ok() then
    raise exception 'mfa_required' using errcode = 'NS401';
  end if;
  delete from public.owner_cost_entries where id = p_id;
  return found;
end
$$;

create or replace function public.owner_analytics_costs(p_from_month date, p_to_month date)
  returns table (id bigint, month date, category text, amount_usd numeric, note text, entered_by uuid, entered_at timestamptz)
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if p_from_month is null or p_to_month is null or p_to_month < p_from_month then
    raise exception 'a range of months is a first month no later than the last' using errcode = '22023';
  end if;
  return query
  select e.id, e.month, e.category, e.amount_usd, e.note, e.entered_by, e.entered_at
    from public.owner_cost_entries e
   where e.month >= date_trunc('month', p_from_month)::date and e.month <= p_to_month
   order by e.month, e.category, e.id
   limit 5000;
end
$$;

comment on function public.owner_analytics_cost_add(date, text, numeric, text) is
  'Migration 0183: the owner records one monthly cost (first day of a month, a category, an amount in USD, an optional note). Platform owner only, second factor when 0107''s gate is on.';
comment on function public.owner_analytics_cost_delete(bigint) is
  'Migration 0183: the owner deletes one of their cost entries. Platform owner only, second factor when 0107''s gate is on.';
comment on function public.owner_analytics_costs(date, date) is
  'Migration 0183: the owner''s cost entries for a range of months. Platform owner only; read-only.';

revoke all on function public.owner_analytics_cost_add(date, text, numeric, text) from public, anon, authenticated, service_role;
revoke all on function public.owner_analytics_cost_delete(bigint) from public, anon, authenticated, service_role;
revoke all on function public.owner_analytics_costs(date, date) from public, anon, authenticated, service_role;
grant execute on function public.owner_analytics_cost_add(date, text, numeric, text) to authenticated;
grant execute on function public.owner_analytics_cost_delete(bigint) to authenticated;
grant execute on function public.owner_analytics_costs(date, date) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. End state
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  sig text;
  fn  oid;
begin
  foreach sig in array array[
    'public.owner_analytics_provider_spend(timestamp with time zone, timestamp with time zone)',
    'public.owner_analytics_balances()',
    'public.owner_analytics_balance_enter(text, text, double precision, text)',
    'public.owner_analytics_cost_add(date, text, numeric, text)',
    'public.owner_analytics_cost_delete(bigint)',
    'public.owner_analytics_costs(date, date)'
  ] loop
    fn := to_regprocedure(sig);
    if fn is null then
      raise exception '0183 end state: % does not exist', sig;
    end if;
    if not has_function_privilege('authenticated', fn, 'EXECUTE')
       or has_function_privilege('anon', fn, 'EXECUTE')
       or has_function_privilege('service_role', fn, 'EXECUTE') then
      raise exception '0183 end state: % has the wrong grants', sig;
    end if;
    if exists (select 1 from pg_proc p where p.oid = fn
                and (not p.prosecdef or p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                     or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
      raise exception '0183 end state: % is not a SECURITY DEFINER with a fixed search_path, or PUBLIC may call it', sig;
    end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'public.owner_cost_entries'::regclass)
     or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r,
                              unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) pr
                 where has_table_privilege(r, 'public.owner_cost_entries', pr)) then
    raise exception '0183 end state: owner_cost_entries is not closed to the API roles';
  end if;
end $$;
