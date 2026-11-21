-- 0196_brain_org_facts.sql: what the customer's Nightshift Brain dashboard
-- and the Nightshift AI's customer facts read about ONE organization.
-- (Stream S2. Atlas renumbers this file at merge.)
--
-- WHAT IT ADDS
--   brain_org_facts(p_org) jsonb   one compact, read-only answer for the
--     caller's own organization:
--       credits.spend_by_tool_14d / _30d   credits CHARGED (ledger captures),
--                                          grouped by what charged them
--       credits.daily_14d                  credits charged per UTC day, zeros
--                                          included (an average needs the
--                                          quiet days too)
--       credits.usage                      usage_summary(p_org), unchanged
--                                          (0094: plan, renewal, spendable)
--       projects                           the org's channels' videos, newest
--                                          first, with their latest snapshot
--       memory                             counts of saved characters, style
--                                          kits and brand domains
--
-- WHAT IT NEVER CONTAINS
--   No other organization's rows, no vendor cost (video_costs, provider
--   usage), no price list, no margin. Only what this organization was charged
--   in credits, which is already on its own Credits page. A lab test pins it
--   (tests/security/test_brain_org_facts.py).
--
-- WHO MAY CALL IT
--   A signed-in member of p_org (viewer and up). Anyone else, including a
--   member of another organization, gets null: the same answer as an org
--   that does not exist, so it cannot be used to probe. anon has no grant.
--
-- Additive: one new function, no table, no change to any existing object.

create or replace function public.brain_org_facts(p_org uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  out_ jsonb;
begin
  if p_org is null or not public.is_org_member(p_org, 'viewer') then
    return null;
  end if;

  with captured as (
    -- A capture is the final charge of one job (0020): its amount is negative.
    select t.job_id, t.created_at, -t.amount as credits
      from public.credit_transactions t
     where t.org_id = p_org
       and t.kind = 'capture'
       and t.created_at >= now() - interval '30 days'
  ), tagged as (
    -- The tool is named from the ledger reference; a creative job also says
    -- its capability (image, video and voice are told apart in the app).
    select c.created_at, c.credits,
           case
             when c.job_id like 'cj:%' then
               'cj:' || coalesce((select j.capability from public.creative_jobs j
                                   where j.org_id = p_org and j.id::text = substr(c.job_id, 4)), 'unknown')
             when c.job_id like 'rj:%' or c.job_id like 'gh:%' then 'run'
             when c.job_id like 'fm-%' then 'film'
             when c.job_id like 'ee:%' then 'export'
             when c.job_id like 'ads_factory:%' then 'ads'
             when c.job_id like 'brand_scan:%' then 'brand_scan'
             when c.job_id like 'character_swap:%' then 'character_swap'
             when c.job_id like 'rd:%' or c.job_id like 'download:%' then 'download'
             else 'other'
           end as tool
      from captured c
  ), days as (
    select (date_trunc('day', now() at time zone 'utc') - make_interval(days => g))::date as day
      from generate_series(0, 13) g
  ), owned_channels as (
    select ch.channel_id from public.channels ch where ch.org_id = p_org
  ), recent_videos as (
    select v.video_id, v.title, v.channel_id, v.published_at, v.privacy,
           (select jsonb_build_object('date', m.snapshot_date, 'views', m.views, 'likes', m.likes,
                                      'comments', m.comment_count)
              from public.metrics_snapshots m
             where m.video_id = v.video_id
             order by m.snapshot_date desc
             limit 1) as latest
      from public.videos v
     where v.channel_id in (select channel_id from owned_channels)
     order by v.published_at desc nulls last
     limit 12
  )
  select jsonb_build_object(
    'version', 1,
    'org_id', p_org,
    'generated_at', now(),
    'credits', jsonb_build_object(
      'spend_by_tool_14d', coalesce((
        select jsonb_object_agg(tool, credits) from (
          select tool, round(sum(credits), 2) as credits from tagged
           where created_at >= now() - interval '14 days' group by tool) x), '{}'::jsonb),
      'spend_by_tool_30d', coalesce((
        select jsonb_object_agg(tool, credits) from (
          select tool, round(sum(credits), 2) as credits from tagged group by tool) x), '{}'::jsonb),
      'daily_14d', (
        select jsonb_agg(jsonb_build_object(
                 'day', d.day,
                 'credits', coalesce((select round(sum(t.credits), 2) from tagged t
                                       where (t.created_at at time zone 'utc')::date = d.day), 0))
                 order by d.day)
          from days d),
      'usage', public.usage_summary(p_org)),
    'projects', jsonb_build_object(
      'videos_total', (select count(*) from public.videos v where v.channel_id in (select channel_id from owned_channels)),
      'recent_videos', coalesce((select jsonb_agg(jsonb_build_object(
                         'video_id', r.video_id, 'title', r.title, 'channel_id', r.channel_id,
                         'published_at', r.published_at, 'privacy', r.privacy, 'latest', r.latest)) from recent_videos r), '[]'::jsonb)),
    'memory', jsonb_build_object(
      'characters', (select count(*) from public.characters c where c.org_id = p_org),
      'style_kits', (select count(*) from public.style_kits s where s.org_id = p_org),
      'brand_domains', (select count(*) from public.brand_domains b where b.org_id = p_org))
  ) into out_;

  return out_;
end
$$;

revoke all on function public.brain_org_facts(uuid) from public, anon, service_role;
grant execute on function public.brain_org_facts(uuid) to authenticated;

comment on function public.brain_org_facts(uuid) is
  'The Nightshift Brain dashboard and the Nightshift AI''s customer facts for ONE organization (S2): credits charged by tool (14/30 days), a 14-day daily series, usage_summary, the org''s videos with their latest snapshot, memory counts. Members of p_org only (else null). Never another org''s rows, never a vendor cost, a price list or a margin.';
