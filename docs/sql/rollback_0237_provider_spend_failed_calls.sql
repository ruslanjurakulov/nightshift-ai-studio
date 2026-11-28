-- rollback_0237_provider_spend_failed_calls.sql — puts 0106's owner_provider_spend back (a failed_call row's quantity is then
-- summed into units again). Owner-applied, one transaction. No backslash anywhere in this file.
begin;
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p
   where p.oid = 'public.owner_provider_spend(integer)'::regprocedure;
  if h is null or h <> all (array['dc5aaeb7ce9899dee21104238a0fada5', '893a14eadc947b7065556c2d67b07530']) then
    raise exception 'rollback 0237 found an owner_provider_spend(integer) that is neither 0106''s body nor 0237''s (md5 %)', h;
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
    select dy, prov, u, q, usd_est, run_key
      from vc
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
         case when count(distinct a.u) = 1 and count(a.u) = count(*) and count(a.q) = count(*)
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
  'Provider spend per UTC day and provider, from video_costs and creative_job_costs, providers named as billing.ts names them; usd is NULL when any row is unpriced. Platform owner/admin only (migration 0106).';

revoke all on function public.owner_provider_spend(integer) from public, anon, authenticated, service_role;
grant execute on function public.owner_provider_spend(integer) to authenticated;

do $$
declare
  h text;
begin
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p
   where p.oid = 'public.owner_provider_spend(integer)'::regprocedure;
  if h is distinct from 'dc5aaeb7ce9899dee21104238a0fada5' then
    raise exception 'rollback 0237: owner_provider_spend is not 0106''s body (md5 %)', h;
  end if;
end $$;

commit;
