-- 0185_owner_fx_rates.sql — frozen exchange rates for the owner's income register (inputs for an accountant, in UZS).
-- docs/MIGRATIONS.md "0185", docs/OWNER_ANALYTICS.md "Tax register".
--
-- *** LIVE ON APPLY. *** It adds one table (owner_fx_rates, closed to every API role) and three functions. It replaces nothing and
-- alters no existing object.
--
-- WHY. The owner (an individual, no company registered) needs an income register an accountant can work from: each payment, in
-- its currency, and its UZS equivalent. The platform stores no exchange rate, and inventing one — today's rate for a payment of
-- last March, or a rate from memory — would put a made-up number in a document about tax. So the rate is FROZEN by the owner:
-- one rate per day and currency, typed from the source the owner's accountant names (the Central Bank of Uzbekistan's official
-- rate is the usual one), with the source written beside it. The register shows a UZS amount only for a payment whose day has
-- a frozen rate; every other row says "no rate stored", and a total that depends on one is marked incomplete. Nothing here
-- fetches a rate, and nothing here is a tax declaration.
--
-- WHO. Owner only (0182's owner_analytics_is_owner), writes also need 0107's second factor (NS401) and pass a rate limit
-- (0184's owner_costs_write_guard). Execute granted to `authenticated` only. RLS on, no policy.
--
-- THE APP WITHOUT THIS FILE. The register lists payments in their own currency and says UZS needs migration 0185.
--
-- REQUIRES 0182 and 0184 (owner_costs_write_guard). Additive and idempotent. Undo: docs/sql/rollback_0185_owner_fx_rates.sql.
-- NUMBER. 0185, assigned at merge.
set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.owner_analytics_is_owner()') is null then
    raise exception '0185 needs 0182_owner_analytics.sql: apply it first';
  end if;
  if to_regprocedure('public.owner_costs_write_guard()') is null then
    raise exception '0185 needs 0184_owner_costs.sql (owner_costs_write_guard): apply it first';
  end if;
end $$;

create table if not exists public.owner_fx_rates (
  id           bigint generated always as identity primary key,
  rate_date    date not null check (isfinite(rate_date) and rate_date >= date '2020-01-01'),
  currency     text not null check (currency ~ '^[A-Z]{3}$' and currency <> 'UZS'),
  uzs_per_unit numeric(18, 4) not null check (uzs_per_unit > 0 and uzs_per_unit < 1e9),
  source       text not null check (length(btrim(source)) between 1 and 120),
  entered_by   uuid not null,
  entered_at   timestamptz not null default now(),
  unique (rate_date, currency)
);

comment on table public.owner_fx_rates is
  'Migration 0185: exchange rates the owner froze for the income register (UZS per unit of a currency, on a day, from a named source such as the Central Bank of Uzbekistan). Written only by owner_analytics_fx_set / _delete; no API role reads or writes it directly. Never fetched, never guessed.';

alter table public.owner_fx_rates enable row level security;
revoke all on table public.owner_fx_rates from public, anon, authenticated, service_role;
revoke all on sequence public.owner_fx_rates_id_seq from public, anon, authenticated, service_role;

create or replace function public.owner_analytics_fx_set(p_date date, p_currency text, p_uzs numeric, p_source text)
  returns bigint
  language plpgsql volatile security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_id bigint;
begin
  perform public.owner_costs_write_guard();
  if p_date is null or not isfinite(p_date) or p_date < date '2020-01-01' or p_date > (now() at time zone 'Asia/Tashkent')::date
     or p_currency is null or p_currency !~ '^[A-Z]{3}$' or p_currency = 'UZS'
     or p_uzs is null or round(p_uzs, 4) <= 0 or round(p_uzs, 4) >= 1e9 or p_uzs <> p_uzs
     or p_source is null or length(btrim(p_source)) not between 1 and 120
     -- A source is named: one made only of invisible or blank characters (NBSP, zero-width space, tabs) names nothing.
     or p_source !~ '[[:alnum:]]' then
    raise exception 'invalid rate' using errcode = '22023';
  end if;
  -- One rate per day and currency: setting it again replaces it (a typo is corrected, not stacked).
  insert into public.owner_fx_rates (rate_date, currency, uzs_per_unit, source, entered_by)
  values (p_date, p_currency, round(p_uzs, 4), btrim(p_source), auth.uid())
  on conflict (rate_date, currency) do update
    set uzs_per_unit = excluded.uzs_per_unit, source = excluded.source, entered_by = excluded.entered_by, entered_at = now()
  returning id into v_id;
  return v_id;
end
$$;

create or replace function public.owner_analytics_fx_delete(p_date date, p_currency text)
  returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  perform public.owner_costs_write_guard();
  delete from public.owner_fx_rates where rate_date = p_date and currency = p_currency;
  return found;
end
$$;

create or replace function public.owner_analytics_fx_rates(p_from date, p_to date)
  returns table (rate_date date, currency text, uzs_per_unit numeric, source text, entered_at timestamptz)
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 1100 then
    raise exception 'a range of days is a first day no later than the last, at most 1100 days' using errcode = '22023';
  end if;
  return query
  select r.rate_date, r.currency, r.uzs_per_unit, r.source, r.entered_at
    from public.owner_fx_rates r
   where r.rate_date between p_from and p_to
   order by r.rate_date, r.currency
   limit 5000;
end
$$;

comment on function public.owner_analytics_fx_set(date, text, numeric, text) is
  'Migration 0185: the owner freezes one exchange rate (UZS per unit of a currency on a day, and its source); setting it again replaces it. Platform owner only, second factor when 0107''s gate is on, rate limited.';
comment on function public.owner_analytics_fx_delete(date, text) is
  'Migration 0185: the owner removes one frozen rate. Platform owner only, second factor when 0107''s gate is on, rate limited.';
comment on function public.owner_analytics_fx_rates(date, date) is
  'Migration 0185: the frozen rates for a range of days. Platform owner only; read-only.';

revoke all on function public.owner_analytics_fx_set(date, text, numeric, text) from public, anon, authenticated, service_role;
revoke all on function public.owner_analytics_fx_delete(date, text) from public, anon, authenticated, service_role;
revoke all on function public.owner_analytics_fx_rates(date, date) from public, anon, authenticated, service_role;
grant execute on function public.owner_analytics_fx_set(date, text, numeric, text) to authenticated;
grant execute on function public.owner_analytics_fx_delete(date, text) to authenticated;
grant execute on function public.owner_analytics_fx_rates(date, date) to authenticated;

do $$
declare
  sig text;
  fn  oid;
begin
  foreach sig in array array[
    'public.owner_analytics_fx_set(date, text, numeric, text)',
    'public.owner_analytics_fx_delete(date, text)',
    'public.owner_analytics_fx_rates(date, date)'
  ] loop
    fn := to_regprocedure(sig);
    if fn is null then
      raise exception '0185 end state: % does not exist', sig;
    end if;
    if not has_function_privilege('authenticated', fn, 'EXECUTE')
       or has_function_privilege('anon', fn, 'EXECUTE')
       or has_function_privilege('service_role', fn, 'EXECUTE') then
      raise exception '0185 end state: % has the wrong grants', sig;
    end if;
    if exists (select 1 from pg_proc p where p.oid = fn
                and (not p.prosecdef or p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                     or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
      raise exception '0185 end state: % is not a SECURITY DEFINER with a fixed search_path, or PUBLIC may call it', sig;
    end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'public.owner_fx_rates'::regclass)
     or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r,
                              unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) pr
                 where has_table_privilege(r, 'public.owner_fx_rates', pr)) then
    raise exception '0185 end state: owner_fx_rates is not closed to the API roles';
  end if;
end $$;
