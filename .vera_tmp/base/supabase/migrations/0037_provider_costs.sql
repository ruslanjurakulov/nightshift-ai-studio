-- 0037_provider_costs.sql — what each creative job cost the platform at the
-- provider, next to what it charged in credits (docs/CREATIVE_OS_PLAN.md §4).
--
-- WHAT IT ADDS
--   creative_job_costs   one row per provider charge of a creative job (0036):
--                        provider, route, vendor model, the provider's unit and
--                        quantity, and usd_estimate — NULL unless the worker
--                        had a configured price for that unit (price_source
--                        names where it came from). Unknown is never 0.
--                        Append-only: nobody may update or delete a row.
--   record_creative_job_cost(...)   service role only (the creative worker)
--   creative_economics   per model and day: jobs completed, credits captured,
--                        provider USD where every cost row of the day was
--                        priced (otherwise NULL, with the unpriced count), for
--                        the admin economics page (plan PR 7).
--
-- WHO MAY DO WHAT: PLATFORM OWNER/ADMIN ONLY. This is the platform's own
-- margin, never shown to an organization's members — not even their own
-- jobs' rows. The view runs with the CALLER's rights (security_invoker) and
-- also filters on is_platform_admin() itself, so it can never show more than
-- the tables would. anon gets nothing.
--
-- REQUIRES 0018 (is_platform_admin) and 0036 (creative_jobs). Additive and
-- idempotent: guarded creates, drop-then-create policies and triggers,
-- create-or-replace functions and view.

do $$
begin
  if to_regclass('public.creative_jobs') is null then
    raise exception '0037 needs 0036_creative_jobs.sql: apply it first';
  end if;
  if to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0037 needs 0018_organizations.sql: apply it first';
  end if;
end $$;

create table if not exists public.creative_job_costs (
  id            bigserial primary key,
  job_id        uuid not null references public.creative_jobs (id) on delete restrict,
  org_id        uuid not null references public.organizations (id) on delete restrict,
  provider      text not null,
  route         text,
  vendor_model  text,
  unit          text,
  quantity      numeric(18,4),
  usd_estimate  numeric(14,6),
  price_source  text,
  recorded_at   timestamptz not null default now()
);

alter table public.creative_job_costs drop constraint if exists creative_job_costs_values_check;
alter table public.creative_job_costs add constraint creative_job_costs_values_check
  check (provider ~ '^[a-z0-9][a-z0-9._-]{0,39}$'
         and (route is null or route ~ '^[a-z0-9][a-z0-9._:-]{0,63}$')
         and (vendor_model is null or char_length(vendor_model) between 1 and 200)
         and (unit is null or unit ~ '^[a-z][a-z0-9_]{0,39}$')
         and (quantity is null or quantity >= 0)
         and (usd_estimate is null or usd_estimate >= 0)
         and (price_source is null or char_length(price_source) between 1 and 300)
         -- A USD figure always says where its price came from.
         and (usd_estimate is null or price_source is not null));

create index if not exists creative_job_costs_job_idx on public.creative_job_costs (job_id);
create index if not exists creative_job_costs_day_idx on public.creative_job_costs (recorded_at);

comment on table public.creative_job_costs is
  'Provider cost of creative jobs (migration 0037). usd_estimate is NULL unless priced; price_source says from where. Platform admins only; append-only.';

create or replace function public.creative_job_costs_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'creative_job_costs is append-only' using errcode = '42501';
end
$$;

drop trigger if exists creative_job_costs_append_only on public.creative_job_costs;
create trigger creative_job_costs_append_only
  before update or delete on public.creative_job_costs
  for each row execute function public.creative_job_costs_append_only();

drop trigger if exists creative_job_costs_no_truncate on public.creative_job_costs;
create trigger creative_job_costs_no_truncate
  before truncate on public.creative_job_costs
  for each statement execute function public.creative_job_costs_append_only();

-- The worker's one write. The organization is taken from the job, never from
-- the caller.
create or replace function public.record_creative_job_cost(
  p_job uuid, p_provider text, p_route text default null, p_vendor_model text default null,
  p_unit text default null, p_quantity numeric default null,
  p_usd numeric default null, p_price_source text default null
) returns bigint
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  org uuid;
  out_id bigint;
begin
  if not public.credits_trusted_caller() then
    raise exception 'provider costs are recorded by the platform''s worker only' using errcode = '42501';
  end if;
  select org_id into org from public.creative_jobs where id = p_job;
  if org is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  insert into public.creative_job_costs
    (job_id, org_id, provider, route, vendor_model, unit, quantity, usd_estimate, price_source)
  values
    (p_job, org, lower(btrim(p_provider)), nullif(btrim(coalesce(p_route, '')), ''),
     nullif(btrim(coalesce(p_vendor_model, '')), ''), nullif(btrim(coalesce(p_unit, '')), ''),
     p_quantity, p_usd,
     case when p_usd is null then nullif(btrim(coalesce(p_price_source, '')), '')
          else coalesce(nullif(btrim(coalesce(p_price_source, '')), ''), 'unspecified') end)
  returning id into out_id;
  return out_id;
end
$$;

-- Per model and UTC day. usd is summed only when EVERY cost row of that model
-- and day is priced; otherwise it is NULL and unpriced_cost_rows says why —
-- a partial sum would read as the whole cost.
create or replace view public.creative_economics
  with (security_invoker = true) as
  with jobs as (
    select j.routed_model as model, (j.finished_at at time zone 'utc')::date as day,
           count(*) as jobs_completed,
           sum(coalesce(j.charged_credits, 0)) as credits_captured
      from public.creative_jobs j
     where j.status = 'completed'
     group by 1, 2
  ), costs as (
    select j.routed_model as model, (c.recorded_at at time zone 'utc')::date as day,
           count(*) as cost_rows,
           count(*) filter (where c.usd_estimate is null) as unpriced_cost_rows,
           sum(c.usd_estimate) as usd_priced
      from public.creative_job_costs c
      join public.creative_jobs j on j.id = c.job_id
     group by 1, 2
  )
  select coalesce(jobs.model, costs.model) as model,
         coalesce(jobs.day, costs.day) as day,
         coalesce(jobs.jobs_completed, 0) as jobs_completed,
         coalesce(jobs.credits_captured, 0) as credits_captured,
         coalesce(costs.cost_rows, 0) as cost_rows,
         coalesce(costs.unpriced_cost_rows, 0) as unpriced_cost_rows,
         case when coalesce(costs.cost_rows, 0) > 0 and costs.unpriced_cost_rows = 0
              then costs.usd_priced end as provider_usd
    from jobs full join costs on costs.model = jobs.model and costs.day = jobs.day
   where public.is_platform_admin();

comment on view public.creative_economics is
  'Creative jobs per model and UTC day: credits captured vs provider USD (NULL unless every cost row was priced). Platform owner/admin only (migration 0037).';

-- ── Privileges and RLS ──────────────────────────────────────────────────────

alter table public.creative_job_costs enable row level security;

revoke all on public.creative_job_costs from public, anon, authenticated, service_role;
revoke all on sequence public.creative_job_costs_id_seq from public, anon, authenticated, service_role;
grant select on public.creative_job_costs to authenticated, service_role;

drop policy if exists creative_job_costs_select on public.creative_job_costs;
create policy creative_job_costs_select on public.creative_job_costs
  for select to authenticated
  using ((select public.is_platform_admin()));

revoke all on public.creative_economics from public, anon, authenticated, service_role;
grant select on public.creative_economics to authenticated, service_role;

revoke all on function public.creative_job_costs_append_only() from public, anon, authenticated, service_role;
revoke all on function public.record_creative_job_cost(uuid, text, text, text, text, numeric, numeric, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_creative_job_cost(uuid, text, text, text, text, numeric, numeric, text)
  to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select relrowsecurity from pg_class where oid = 'public.creative_job_costs'::regclass) as rls_on,
--   not has_table_privilege('anon', 'public.creative_job_costs', 'SELECT')
--     and not has_table_privilege('anon', 'public.creative_economics', 'SELECT')
--     and not has_table_privilege('authenticated', 'public.creative_job_costs', 'INSERT')
--     and not has_table_privilege('service_role', 'public.creative_job_costs', 'UPDATE') as locked,
--   (select coalesce(bool_or(o = 'security_invoker=true'), false)
--      from pg_class c, unnest(c.reloptions) o
--     where c.oid = 'public.creative_economics'::regclass) as view_runs_as_caller,
--   not has_function_privilege('authenticated',
--     'public.record_creative_job_cost(uuid,text,text,text,text,numeric,numeric,text)', 'EXECUTE')
--     as record_is_service_only;
