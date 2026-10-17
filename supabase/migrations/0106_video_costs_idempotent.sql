-- 0106_video_costs_idempotent.sql — the nightly mirror stops multiplying the
-- provider-cost rows, and the owner gets one small aggregate to read instead of
-- thousands of raw rows.
--
-- *** APPLYING THIS FILE CHANGES THE LIVE DATABASE. Merging it to main applies
-- *** it automatically. It is additive: one nullable column, one index and one
-- *** new function. No row is read, changed or deleted; no existing function,
-- *** policy, grant, trigger or constraint is touched.
--
-- WHY
--   modules/supabase_sync.py re-sent EVERY local video_costs row each night
--   with no conflict key (the table has none), so a row was stored once per
--   night: spend would have been multiplied by the number of nights since it
--   was recorded. The table is empty today, so nothing is inflated yet; this
--   closes the door before it fills.
--
-- WHAT IT ADDS
--   video_costs.row_key   text, NULLABLE, no default. The mirror fills it with a
--                         deterministic hash of the row (see modules/
--                         supabase_sync.py, video_cost_row_key) and upserts with
--                         on_conflict=row_key + ignore-duplicates, so re-sending
--                         history is a no-op. Rows written before this migration
--                         keep NULL and are never touched.
--   video_costs_row_key_uidx   UNIQUE index on (row_key). A plain index, NOT a
--                         partial one: PostgREST's on_conflict=row_key cannot
--                         carry the "where row_key is not null" predicate that
--                         Postgres needs to match a partial unique index (it
--                         answers 42P10), and Postgres already treats NULLs as
--                         distinct in a unique index, so any number of NULL
--                         rows coexist. Created on an empty table: instant.
--   owner_provider_spend(p_days)   platform owner/admin only. What the platform
--                         paid each provider per UTC day, from video_costs
--                         (de-duplicated by coalesce(row_key, id::text)) and
--                         creative_job_costs, as a few hundred rows at most
--                         (days x providers). A follow-up switches the Billing
--                         page to it; this migration changes no page.
--
-- owner_provider_spend: columns
--   day            'YYYY-MM-DD' (UTC) as text; NULL for a video_costs row whose
--                  recorded_at is not an ISO date (shown, never hidden).
--   provider       the provider that billed: for generated media the provider
--                  named by the stage ('broll:minimax' -> minimax), otherwise
--                  the first word of the unit (gemini, tts, render, pexels...);
--                  for creative jobs the recorded provider. Lower-cased.
--   usd            sum of usd_estimate, NULL when ANY row of that day and
--                  provider is unpriced. Unknown is never 0: a partial sum would
--                  read as the whole cost (the rule of 0037 creative_economics).
--   usd_priced     the sum of the priced rows only (a floor when unpriced_rows
--                  is above 0); NULL when no row is priced.
--   unpriced_rows  rows with no usd_estimate.
--   units          sum of quantity when every row shares one unit, else NULL
--                  (tokens and seconds do not add up).
--   unit           that unit, or 'mixed'.
--   runs           distinct videos / creative jobs behind the rows.
--
-- WHO MAY CALL IT: PLATFORM OWNER/ADMIN ONLY, like operator_margin_report (0063).
-- SECURITY DEFINER (it reads rows no customer may read), is_platform_admin() is
-- checked first, before any read, a customer gets 42501. search_path is pinned.
-- EXECUTE: authenticated only; revoked from public, anon and service_role. No
-- text argument reaches SQL text: the only argument is an integer.
--
-- NOT CHANGED: grants on video_costs, its RLS policies, and every function of an
-- earlier migration. A viewer of a channel who may already read that channel's
-- video_costs rows will also see the new row_key column: a hash of the row's own
-- fields, nothing more.
--
-- REQUIRES 0002 (video_costs), 0018 (is_platform_admin, which also adds the
-- video_costs policies), 0036/0037 (creative_job_costs). Idempotent.
--
-- ROLLBACK (only if nothing depends on it; the mirror of the same release must be
-- rolled back first, or it would 400 on the missing column and skip the table):
--   drop function if exists public.owner_provider_spend(integer);
--   drop index if exists public.video_costs_row_key_uidx;
--   alter table public.video_costs drop column if exists row_key;

do $$
begin
  if to_regclass('public.video_costs') is null then
    raise exception '0106 needs video_costs: apply 0002_measurement.sql first';
  end if;
  if to_regclass('public.creative_job_costs') is null then
    raise exception '0106 needs creative_job_costs: apply 0037_provider_costs.sql first';
  end if;
  if to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0106 needs is_platform_admin(): apply 0018_organizations.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The mirror's idempotency key
-- ───────────────────────────────────────────────────────────────────────────

alter table public.video_costs add column if not exists row_key text;

comment on column public.video_costs.row_key is
  'Deterministic hash of the row that the nightly mirror sends (migration 0106); NULL on rows older than that. Unique, so a re-sent row is ignored.';

create unique index if not exists video_costs_row_key_uidx on public.video_costs (row_key);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. What the platform paid each provider, per UTC day (owner/admin only)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.owner_provider_spend(p_days integer default 30)
  returns table (
    day           text,
    provider      text,
    usd           numeric,
    usd_priced    numeric,
    unpriced_rows bigint,
    units         numeric,
    unit          text,
    runs          bigint
  )
  language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  -- 1..180 days, today included; null means the default 30.
  n     integer := least(180, greatest(1, coalesce(p_days, 30)));
  since date    := (now() at time zone 'utc')::date - (n - 1);
begin
  -- First, before any read: this function sees the platform's whole spend.
  if not public.is_platform_admin() then
    raise exception 'platform admin only' using errcode = '42501';
  end if;

  return query
  with vc as (
    -- One row per mirrored cost. Rows that carry a row_key collapse by it (a
    -- duplicate that slipped in some other way still counts once); rows from
    -- before 0106 have none and stand on their own id.
    select distinct on (coalesce(c.row_key, c.id::text))
           c.unit as u, c.quantity::numeric as q, c.estimated_usd::numeric as usd_est,
           lower(btrim(coalesce(nullif(substring(c.stage from '^(?:broll|image):(.+)$'), ''),
                                split_part(c.unit, '_', 1)))) as prov,
           -- ISO date only; anything else is undated, not an error.
           case when c.recorded_at ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])'
                then left(c.recorded_at, 10) end as dy,
           'v:' || c.channel_id || '|' || coalesce(nullif(c.slug, ''), nullif(c.video_id, ''), c.id::text) as run_key
      from public.video_costs c
     order by coalesce(c.row_key, c.id::text), c.id
  ),
  allrows as (
    select dy, prov, u, q, usd_est, run_key
      from vc
     where dy is null or dy >= to_char(since, 'YYYY-MM-DD')
    union all
    select to_char(j.recorded_at at time zone 'utc', 'YYYY-MM-DD'),
           lower(btrim(j.provider)), j.unit, j.quantity, j.usd_estimate, 'j:' || j.job_id::text
      from public.creative_job_costs j
     where j.recorded_at >= since::timestamp at time zone 'utc'
  )
  select a.dy,
         a.prov,
         case when count(*) filter (where a.usd_est is null) = 0 then sum(a.usd_est) end,
         sum(a.usd_est),
         count(*) filter (where a.usd_est is null),
         case when count(distinct a.u) = 1 and count(*) filter (where a.u is null) = 0
              then sum(a.q) end,
         case when count(distinct a.u) = 1 and count(*) filter (where a.u is null) = 0
              then min(a.u) else 'mixed' end,
         count(distinct a.run_key)
    from allrows a
   group by a.dy, a.prov
   order by a.dy desc nulls first, a.prov;
end
$$;

comment on function public.owner_provider_spend(integer) is
  'Provider spend per UTC day and provider, from video_costs (de-duplicated) and creative_job_costs; usd is NULL when any row is unpriced. Platform owner/admin only (migration 0106).';

revoke all on function public.owner_provider_spend(integer) from public, anon, authenticated, service_role;
grant execute on function public.owner_provider_spend(integer) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   exists (select 1 from information_schema.columns
--            where table_schema = 'public' and table_name = 'video_costs' and column_name = 'row_key') as column_there,
--   (select indisunique and indpred is null from pg_index
--     where indexrelid = 'public.video_costs_row_key_uidx'::regclass) as unique_and_not_partial,
--   p.prosecdef as security_definer,
--   exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%') as search_path_pinned,
--   has_function_privilege('authenticated', p.oid, 'EXECUTE') as signed_in_may_call_it_and_is_refused_inside,
--   not has_function_privilege('anon', p.oid, 'EXECUTE')
--     and not has_function_privilege('service_role', p.oid, 'EXECUTE') as anon_and_service_cannot
--   from pg_proc p
--  where p.oid = 'public.owner_provider_spend(integer)'::regprocedure;
