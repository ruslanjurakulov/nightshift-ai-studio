-- 0237_provider_spend_failed_calls.sql — a vendor call that delivered nothing is never counted as units used in the owner's
-- provider spend (owner_provider_spend, 0106).
--
-- EVIDENCE. Since PR #964 the creative and film workers write a creative_job_costs row (0037) for every call that reached a vendor,
--   including the ones that failed, timed out, answered without a file or were abandoned: price_source 'failed_call', usd_estimate
--   NULL, quantity = what was ASKED (the requested seconds, the prompt's characters; NULL for pictures). 0106's
--   owner_provider_spend sums creative_job_costs.quantity into `units` for every row of a day and provider, so a failed 10 s clip
--   read as 10 s used on the Billing page's provider spend panel (components/billing/ProviderSpendPanel.tsx). Its usd was already
--   right: the row is unpriced, so the day's usd is NULL and unpriced_rows counts it.
-- DIAGNOSIS. `units` is a measurement of use; a failed call's quantity is a request, not a measurement (CLAUDE.md #5).
-- CHANGE. One function, 0106's owner_provider_spend, two lines marked 0237 in it: a failed_call row's quantity is NULL in the scan,
--   and the units are summed when every row that is NOT a failed call says its quantity (a group of failed calls only has no units:
--   NULL, never 0). The row is still counted, as unpriced; the columns, the security, the grants and every other number are 0106's.
--   Not changed: 0184's owner_analytics_provider_spend (it counts rows and sums usd_estimate only, so a failed call is an unpriced
--   row there already), the creative_economics view (likewise), creative_job_costs and record_creative_job_cost.
-- REPLACES (drift guard, as 0230's: md5 of prosrc with every comment cut to the end of its line, then white space folded):
--   owner_provider_spend(integer) 0106's dc5aaeb7ce9899dee21104238a0fada5 -> 0237's 893a14eadc947b7065556c2d67b07530.
-- NUMBER. 0237, assigned by the coordinator for S2. Needs 0106 (the function) and 0037 (creative_job_costs.price_source).
-- Rollback: docs/sql/rollback_0237_provider_spend_failed_calls.sql (owner-applied; puts 0106's body back and asserts it).

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
-- No backslash anywhere in this file: the live apply path once rewrote backslash escapes inside SQL text (0219's header).
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regprocedure('public.owner_provider_spend(integer)') is null or to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0237 needs 0106 (owner_provider_spend) and 0018 (is_platform_admin): apply them first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'creative_job_costs' and column_name = 'price_source') then
    raise exception '0237 needs 0037 (creative_job_costs.price_source): apply it first';
  end if;
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p
   where p.oid = 'public.owner_provider_spend(integer)'::regprocedure;
  if h is null or h <> all (array['dc5aaeb7ce9899dee21104238a0fada5', '893a14eadc947b7065556c2d67b07530']) then
    raise exception '0237 found an owner_provider_spend(integer) that is neither 0106''s body nor 0237''s (md5 %): read the live body first', h;
  end if;
end $$;

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
    -- One row per mirrored cost (row_key is unique, so no row is counted twice
    -- through the key). The window is applied in the scan: an ISO-dated row must
    -- be on or after the first day; a row whose recorded_at is not an ISO date
    -- is kept (undated, never hidden). Text comparison is right for ISO dates.
    select c.unit as u, c.quantity::numeric as q, c.estimated_usd::numeric as usd_est,
           -- the provider, as billing.ts keys it (see the header)
           coalesce(nullif(lower(btrim(case
                 when c.unit = 'tts_characters' then 'elevenlabs'
                 when c.unit in ('gemini_input_tokens', 'gemini_output_tokens') then 'gemini'
                 when c.unit = 'video_gen_clips' and c.stage ~ '^broll:.+'
                   then substring(c.stage from '^broll:(.+)$')
                 when c.unit = 'image_generations' and c.stage ~ '^image:.+'
                   then substring(c.stage from '^image:(.+)$')
                 else split_part(c.unit, '_', 1) end)), ''), 'unknown') as prov,
           case when c.recorded_at ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])'
                then left(c.recorded_at, 10) end as dy,
           'v:' || c.channel_id || '|' || coalesce(nullif(c.slug, ''), nullif(c.video_id, ''), c.id::text) as run_key
      from public.video_costs c
     where c.recorded_at !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])'
        or c.recorded_at >= to_char(since, 'YYYY-MM-DD')
  ),
  allrows as (
    select dy, prov, u, q, usd_est, run_key, false as fc
      from vc
    union all
    -- 0237: a failed_call row (a vendor call that delivered nothing) carries what was ASKED, not what was used. Its quantity is
    -- left out of the units (they are what was used); the row still counts as unpriced, so the day's usd stays unknown.
    select to_char(j.recorded_at at time zone 'utc', 'YYYY-MM-DD'),
           lower(btrim(j.provider)), j.unit,
           case when j.price_source = 'failed_call' then null else j.quantity end,
           j.usd_estimate, 'j:' || j.job_id::text,
           coalesce(j.price_source = 'failed_call', false)
      from public.creative_job_costs j
     where j.recorded_at >= since::timestamp at time zone 'utc'
  )
  select a.dy,
         a.prov,
         case when count(*) filter (where a.usd_est is null) = 0 then sum(a.usd_est) end,
         sum(a.usd_est),
         count(*) filter (where a.usd_est is null),
         -- 0237: every row that is not a failed call must say its quantity (a failed call says none here); a group of
         -- failed calls only has no units (sum of nothing is NULL: unknown, never 0).
         case when count(distinct a.u) = 1 and count(a.u) = count(*) and count(a.q) = count(*) filter (where not a.fc)
              then sum(a.q) end,
         case when count(a.u) = 0 then null
              when count(distinct a.u) = 1 and count(a.u) = count(*) then min(a.u)
              else 'mixed' end,
         count(distinct a.run_key)
    from allrows a
   group by a.dy, a.prov
   order by a.dy desc nulls first, a.prov;
end
$$;

comment on function public.owner_provider_spend(integer) is
  'Provider spend per UTC day and provider, from video_costs and creative_job_costs, providers named as billing.ts names them; usd is NULL when any row is unpriced; a failed_call row (0237) is unpriced and adds nothing to units. Platform owner/admin only (migrations 0106, 0237).';

revoke all on function public.owner_provider_spend(integer) from public, anon, authenticated, service_role;
grant execute on function public.owner_provider_spend(integer) to authenticated;

-- Verify: the body is 0237's, still SECURITY DEFINER with a pinned search_path, and only a signed-in caller may execute it (the
-- function refuses all but a platform admin inside). Raises when any of it is not so.
do $$
declare
  h text;
  ok boolean;
begin
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')),
         p.prosecdef
         and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=public%')
         and has_function_privilege('authenticated', p.oid, 'EXECUTE')
         and not has_function_privilege('anon', p.oid, 'EXECUTE')
         and not has_function_privilege('service_role', p.oid, 'EXECUTE')
    into h, ok
    from pg_proc p
   where p.oid = 'public.owner_provider_spend(integer)'::regprocedure;
  if h is distinct from '893a14eadc947b7065556c2d67b07530' then
    raise exception '0237 verify: owner_provider_spend is not 0237''s body (md5 %)', h;
  end if;
  if ok is not true then
    raise exception '0237 verify: owner_provider_spend lost its security definer, its search_path or its grants';
  end if;
end $$;
