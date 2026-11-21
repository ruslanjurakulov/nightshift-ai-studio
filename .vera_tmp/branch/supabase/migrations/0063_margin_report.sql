-- 0063_margin_report.sql — the operator's margin report: per model, capability
-- and UTC day, what a creative generation cost at the provider next to what it
-- earned, with failed / cancelled / expired jobs kept out of revenue and
-- flagged (docs/CREATIVE_OS_PLAN.md §4; the Command Center's /margin page).
--
-- WHAT IT ADDS
--   operator_margin_report(p_from, p_to)   one function, no table. Read-only.
--
-- WHERE EACH NUMBER COMES FROM (nothing here is a constant)
--   provider cost   creative_job_costs.usd_estimate (0037): what the worker
--                   recorded against a job, from the price it had configured
--                   for the provider's unit. api_prices and credit_prices are
--                   what the platform SELLS at, never what a provider charges,
--                   so neither is read as a cost.
--   credits sold    creative_jobs.charged_credits of completed jobs paid in
--                   credits (0036).
--   revenue         the credits a job spent, valued at what the organization
--                   actually paid for the lot they came from: credit_lot_moves
--                   (0034) says which lots a job's capture spent, and a pack or
--                   plan lot is valued at amount_minor / credits of its Paddle
--                   transaction (payment_events, 0021). So a pack bought at one
--                   price and a plan bought at another are each valued at their
--                   own, and a discounted purchase at what was paid.
--                   This is the gross grand total Paddle charged: tax is not
--                   taken out and Paddle's fee is not deducted, so "gross
--                   margin" here means before tax and payment fees.
--
-- UNKNOWN IS NEVER 0 (CLAUDE.md #5). A number is NULL, with a flag saying why,
-- whenever any part of it is unknown:
--   provider_usd_*   NULL when any cost row of a job is unpriced, or when a job
--                    that reached the provider has no cost row at all (the
--                    worker never recorded it). A job that never began a
--                    billable call (submit_started_at null) costs a known 0.
--   revenue_usd      NULL when any credit a job spent cannot be valued: an
--                    adjustment lot (carry-over, may or may not have been
--                    bought), a lot whose purchase is not a USD payment event,
--                    a refunded purchase, a subscription lot that an upgrade
--                    topped up (its amount no longer matches one payment), a
--                    charge with no lot trace (made before 0034), or a job paid
--                    from the API balance (priced in cents, not credits).
--                    Credits from a grant lot (welcome credits, operator grants)
--                    are not unknown: they were free, and are reported as such.
--   margin_*         NULL unless both revenue and the cost of completed jobs
--                    are known, and revenue is above 0 (a percentage of 0).
--
-- FAILED / RELEASED JOBS. A job that ended failed, cancelled or expired charged
-- nothing (its hold was released), so it adds no revenue. It still may have
-- cost real provider money; that is reported apart as provider_usd_released and
-- the row carries the 'released_jobs' flag. Jobs still in flight are not
-- counted anywhere. Jobs of the operator's own organization (default_org_id)
-- pay nothing by design, so they are counted in jobs_internal and left out of
-- revenue and cost both.
--
-- WHO MAY CALL IT: PLATFORM OWNER/ADMIN ONLY. The function is SECURITY DEFINER
-- (it reads tables no customer may read) and therefore checks
-- is_platform_admin() itself, first, before it touches anything; a customer
-- gets 42501. search_path is pinned. anon cannot execute it and neither can
-- service_role: the Command Center reads it with the signed-in operator's own
-- session and never holds the service key.
--
-- NO TABLE IS ADDED, so there is no new RLS to switch on; the tables it reads
-- keep their own (the Verify query checks they still have it).
--
-- REQUIRES 0018 (is_platform_admin, default_org_id), 0021 (payment_events,
-- credit_refunds), 0034 (credit_lots, credit_lot_moves), 0036 (creative_jobs)
-- and 0037 (creative_job_costs). Additive and idempotent: create-or-replace of
-- a function that did not exist; nothing else is changed.

do $$
begin
  if to_regprocedure('public.is_platform_admin()') is null
     or to_regprocedure('public.default_org_id()') is null then
    raise exception '0063 needs 0018_organizations.sql: apply it first';
  end if;
  if to_regclass('public.payment_events') is null or to_regclass('public.credit_refunds') is null then
    raise exception '0063 needs 0021_credit_refunds.sql: apply it first';
  end if;
  if to_regclass('public.credit_lots') is null or to_regclass('public.credit_lot_moves') is null then
    raise exception '0063 needs 0034_plans_entitlements.sql: apply it first';
  end if;
  if to_regclass('public.creative_jobs') is null then
    raise exception '0063 needs 0036_creative_jobs.sql: apply it first';
  end if;
  if to_regclass('public.creative_job_costs') is null then
    raise exception '0063 needs 0037_provider_costs.sql: apply it first';
  end if;
end $$;

create or replace function public.operator_margin_report(p_from date default null, p_to date default null)
  returns table (
    day                    date,
    model                  text,
    capability             text,
    jobs_completed         bigint,
    jobs_released          bigint,
    jobs_internal          bigint,
    credits_sold           numeric,
    credits_released       numeric,
    credits_paid           numeric,
    credits_free           numeric,
    credits_unvalued       numeric,
    revenue_usd            numeric,
    provider_usd           numeric,
    provider_usd_released  numeric,
    jobs_uncosted          bigint,
    jobs_released_uncosted bigint,
    margin_usd             numeric,
    margin_pct             numeric,
    flags                  text[]
  )
  language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  d_to   date := coalesce(p_to, (now() at time zone 'utc')::date);
  d_from date := coalesce(p_from, coalesce(p_to, (now() at time zone 'utc')::date) - 29);
begin
  -- First, before any read: this function sees every organization's money.
  if not public.is_platform_admin() then
    raise exception 'platform admin only' using errcode = '42501';
  end if;
  if d_from > d_to or d_to - d_from > 365 then
    raise exception 'the report covers at most 366 days, from before to' using errcode = '22023';
  end if;

  return query
  with jobs as (
    select j.id, j.org_id, j.capability as cap,
           coalesce(j.routed_model, j.requested_model) as mdl,
           (coalesce(j.finished_at, j.created_at) at time zone 'utc')::date as dy,
           j.status, j.payer, j.credit_ref, j.quoted_credits,
           coalesce(j.charged_credits, 0) as charged,
           j.submit_started_at,
           (j.org_id = public.default_org_id()) as internal
      from public.creative_jobs j
     where j.status in ('completed', 'failed', 'cancelled', 'expired')
       and (coalesce(j.finished_at, j.created_at) at time zone 'utc')::date between d_from and d_to
  ),
  cost as (
    select c.job_id,
           count(*) as n,
           count(*) filter (where c.usd_estimate is null) as unpriced,
           sum(c.usd_estimate) as usd
      from public.creative_job_costs c
      join jobs on jobs.id = c.job_id
     group by c.job_id
  ),
  -- One USD payment per Paddle transaction: the processed event when a retry
  -- left a duplicate beside it.
  paid as (
    select distinct on (e.transaction_id) e.transaction_id, e.credits, e.amount_minor
      from public.payment_events e
     where e.provider = 'paddle' and e.event_type = 'transaction.completed'
       and e.status in ('processed', 'duplicate')
       and e.transaction_id is not null
       and e.credits > 0 and e.amount_minor > 0 and e.currency = 'USD'
     order by e.transaction_id, (e.status = 'processed') desc, e.received_at
  ),
  -- What one credit of a lot was bought for. NULL = not knowable.
  lot_value as (
    select l.id as lot_id, l.source,
           case when l.source in ('pack', 'subscription')
                     and p.transaction_id is not null
                     and abs(l.amount - p.credits) < 0.005
                     and not exists (select 1 from public.credit_refunds r
                                      where r.purchase_external_id = l.external_id)
                then p.amount_minor / 100.0 / p.credits end as usd_per_credit
      from public.credit_lots l
      left join paid p on p.transaction_id = l.external_id
  ),
  spend as (
    select m.job_id as credit_ref,
           sum(-m.remaining_delta) as spent,
           sum(-m.remaining_delta) filter (where v.usd_per_credit is not null) as paid_credits,
           sum(-m.remaining_delta * v.usd_per_credit) as paid_usd,
           sum(-m.remaining_delta) filter (where v.source = 'grant') as free_credits
      from public.credit_lot_moves m
      join lot_value v on v.lot_id = m.lot_id
     where m.kind = 'spend'
       and m.job_id in (select jobs.credit_ref from jobs where jobs.credit_ref is not null)
     group by m.job_id
  ),
  per_job as (
    select jobs.*,
           (jobs.status = 'completed' and not jobs.internal) as is_sold,
           (jobs.status <> 'completed' and not jobs.internal) as is_released,
           (jobs.status = 'completed' and not jobs.internal and jobs.payer = 'api_balance') as is_api,
           (coalesce(cost.unpriced, 0) = 0
            and (coalesce(cost.n, 0) > 0 or jobs.submit_started_at is null)) as costed,
           coalesce(cost.usd, 0) as cost_usd,
           case when jobs.status = 'completed' and not jobs.internal and jobs.payer = 'credits'
                then jobs.charged else 0 end as sold,
           coalesce(spend.paid_credits, 0) as paid_credits,
           coalesce(spend.paid_usd, 0) as paid_usd,
           coalesce(spend.free_credits, 0) as free_credits,
           greatest(case when jobs.status = 'completed' and not jobs.internal and jobs.payer = 'credits'
                         then jobs.charged else 0 end
                    - coalesce(spend.paid_credits, 0) - coalesce(spend.free_credits, 0), 0) as unvalued
      from jobs
      left join cost on cost.job_id = jobs.id
      left join spend on spend.credit_ref = jobs.credit_ref
  ),
  agg as (
    select pj.dy, pj.mdl, pj.cap,
           count(*) filter (where pj.is_sold) as jobs_completed,
           count(*) filter (where pj.is_released) as jobs_released,
           count(*) filter (where pj.internal) as jobs_internal,
           count(*) filter (where pj.is_api) as jobs_api,
           coalesce(sum(pj.sold), 0) as credits_sold,
           coalesce(sum(pj.quoted_credits) filter (where pj.is_released and pj.payer = 'credits'), 0) as credits_released,
           coalesce(sum(pj.paid_credits) filter (where pj.is_sold), 0) as credits_paid,
           coalesce(sum(pj.free_credits) filter (where pj.is_sold), 0) as credits_free,
           coalesce(sum(pj.unvalued) filter (where pj.is_sold), 0) as credits_unvalued,
           coalesce(sum(pj.paid_usd) filter (where pj.is_sold), 0) as paid_usd,
           coalesce(sum(pj.cost_usd) filter (where pj.is_sold), 0) as cost_sold,
           coalesce(sum(pj.cost_usd) filter (where pj.is_released), 0) as cost_released,
           count(*) filter (where pj.is_sold and not pj.costed) as uncosted,
           count(*) filter (where pj.is_released and not pj.costed) as released_uncosted
      from per_job pj
     group by pj.dy, pj.mdl, pj.cap
  ),
  calc as (
    select a.*,
           case when a.jobs_api > 0 or a.credits_unvalued > 0.005 then null else a.paid_usd end as rev,
           case when a.uncosted > 0 then null else a.cost_sold end as prov,
           case when a.released_uncosted > 0 then null else a.cost_released end as prov_rel
      from agg a
  )
  select c.dy, c.mdl, c.cap,
         c.jobs_completed, c.jobs_released, c.jobs_internal,
         c.credits_sold, c.credits_released, c.credits_paid, c.credits_free, c.credits_unvalued,
         c.rev, c.prov, c.prov_rel,
         c.uncosted, c.released_uncosted,
         case when c.rev is null or c.prov is null then null else c.rev - c.prov end,
         case when c.rev is null or c.prov is null or c.rev <= 0 then null
              else round((c.rev - c.prov) / c.rev * 100, 2) end,
         array_remove(array[
           case when c.jobs_released > 0 then 'released_jobs' end,
           case when c.uncosted > 0 or c.released_uncosted > 0 then 'unpriced_cost' end,
           case when c.credits_unvalued > 0.005 then 'unvalued_credits' end,
           case when c.jobs_api > 0 then 'api_balance_jobs' end,
           case when c.credits_free > 0 then 'free_credits' end,
           case when c.jobs_internal > 0 then 'internal_jobs' end
         ], null)
    from calc c
   order by c.dy desc, c.mdl, c.cap;
end
$$;

comment on function public.operator_margin_report(date, date) is
  'Operator margin report per model, capability and UTC day (migration 0063): provider cost vs revenue at what the credits were bought for. NULL = unknown, never 0. Platform owner/admin only; read-only.';

-- ── Privileges ──────────────────────────────────────────────────────────────

revoke all on function public.operator_margin_report(date, date) from public, anon, authenticated, service_role;
grant execute on function public.operator_margin_report(date, date) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   p.prosecdef as security_definer,
--   exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%') as search_path_pinned,
--   has_function_privilege('authenticated', p.oid, 'EXECUTE') as signed_in_may_call_it_and_is_refused_inside,
--   not has_function_privilege('anon', p.oid, 'EXECUTE')
--     and not has_function_privilege('service_role', p.oid, 'EXECUTE') as anon_and_service_cannot,
--   (select bool_and(relrowsecurity) from pg_class
--     where oid in ('public.creative_jobs'::regclass, 'public.creative_job_costs'::regclass,
--                   'public.credit_lots'::regclass, 'public.credit_lot_moves'::regclass,
--                   'public.payment_events'::regclass, 'public.credit_refunds'::regclass)) as source_tables_keep_rls
--   from pg_proc p
--  where p.oid = 'public.operator_margin_report(date,date)'::regprocedure;
