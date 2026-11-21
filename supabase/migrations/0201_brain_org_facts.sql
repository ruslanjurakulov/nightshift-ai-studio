-- 0201_brain_org_facts.sql: what the customer's Nightshift Brain dashboard
-- and the Nightshift AI's customer facts read about ONE organization.
-- (Stream S2; number 0201 assigned by Atlas.)
--
-- WHAT IT ADDS
--   brain_org_facts(p_org) jsonb   one compact, read-only answer for the
--     caller's own organization:
--       credits.spend_by_tool_14d / _30d   credits CHARGED (ledger captures net
--                                          of a refund of the same job), grouped
--                                          by what charged them
--       credits.window_start / history_start  the 14-day window, and when this
--                                          org could first have spent in it
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
--   (tests/security/test_sec_brain_org_facts.py).
--
-- WHO MAY CALL IT
--   A signed-in member of p_org (viewer and up), through is_org_member (0018),
--   which also lets a platform owner/admin through, exactly as RLS already
--   shows them every org. Anyone else, including a member of another
--   organization, gets null: the same answer as an org that does not exist,
--   so it cannot be used to probe. anon and the service key have no grant.
--   A caller (S5's Nightshift AI) passes the session's own open org, never a
--   number from a prompt.
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

  with bounds as (
    -- One window for every 14-day figure: today and the 13 calendar days (UTC) before it. The series, the bars and the
    -- forecast then add up to the same total. history_start is when this org could first have spent (it may be younger
    -- than the window): a forecast divides by the days that really passed, not by 14.
    select (date_trunc('day', now() at time zone 'utc') - interval '13 days') at time zone 'utc' as win_start,
           (select o.created_at from public.organizations o where o.id = p_org) as org_created
  ), charged as (
    -- What a job finally cost: its capture (negative) net of any refund of the same job (positive, 0030's download
    -- refund). A purchase refund carries no job_id and is not spend.
    select t.job_id, t.created_at, -t.amount as credits
      from public.credit_transactions t
     where t.org_id = p_org
       and t.kind in ('capture', 'refund')
       and t.job_id is not null
       and t.created_at >= now() - interval '30 days'
  ), tagged as (
    -- The tool is named from the ledger reference as production writes it (lib/credits.ts newCreditRef, the
    -- per-feature refs in 0031/0036/0076/0080/0081/0093/0120/0132/0133/0137/0171). A creative job also says its
    -- capability, looked up by its uuid in this org only.
    select c.created_at, c.credits,
           case
             when c.job_id ~ '^cj:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
               'cj:' || coalesce((select j.capability from public.creative_jobs j
                                   where j.id = substr(c.job_id, 4)::uuid and j.org_id = p_org), 'unknown')
             when c.job_id like 'rj-sr-%' then 'scene_regenerate'
             when c.job_id like 'rj-%' or c.job_id like 'gh-%' or c.job_id like 'ah-%' then 'run'
             when c.job_id like 'fm-%' then 'film'
             when c.job_id like 'ee:%' then 'export'
             when c.job_id like 'bs:%' then 'brand_scan'
             when c.job_id like 'cs:%' then 'character_swap'
             when c.job_id like 'rp-%' then 'repurpose'
             when c.job_id like 'rd:%' then 'reply_draft'
             when c.job_id like 'download:%' then 'download'
             else 'other'
           end as tool
      from charged c
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
      'window_start', (select win_start from bounds),
      'history_start', (select greatest(win_start, coalesce(org_created, win_start)) from bounds),
      'spend_by_tool_14d', coalesce((
        select jsonb_object_agg(tool, credits) from (
          select tool, round(sum(credits), 2) as credits from tagged
           where created_at >= (select win_start from bounds) group by tool) x), '{}'::jsonb),
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
