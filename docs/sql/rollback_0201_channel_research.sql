-- rollback_0201_channel_research.sql — takes migration 0201 (channel research) out.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT IS LOST: the research caches (public YouTube statistics, at most 30 days old by construction), the competitor lists customers
--   typed, the topic results, the own-channel analytics totals and the research queue. Nothing there is anyone's money or a record of
--   who approved what: every number can be fetched again after 0201 is re-applied, and the competitor lists would have to be typed
--   again (say so to the owner first).
-- WHAT COMES BACK: youtube_quota_ledger's source CHECK as 0116 wrote it (visibility only), after the ledger's research rows are deleted
--   (they would violate it). 0116's five-argument youtube_quota_take is untouched by 0201 and stays.
-- The page /{channel}/research then reads "not enabled here" (the functions are missing), and the worker's research step logs the
--   404 once and does nothing.

begin;
set local lock_timeout = '5s';

drop function if exists public.research_own_channel(text);
drop function if exists public.research_competitors_view(text);
drop function if exists public.research_topic_channels(text, text);
drop function if exists public.research_comment_themes(text, integer);
drop function if exists public.research_request_refresh(text, text, text);
drop function if exists public.research_add_competitor(text, text);
drop function if exists public.research_remove_competitor(text, uuid);
drop function if exists public.research_claim_request(text);
drop function if exists public.research_finish_request(bigint, text, text, text, integer);
drop function if exists public.research_store_channels(jsonb);
drop function if exists public.research_store_videos(jsonb);
drop function if exists public.research_resolve_competitor(uuid, text);
drop function if exists public.research_store_topic(bigint, text[]);
drop function if exists public.research_store_own(bigint, text, integer, bigint, bigint, bigint, bigint);
drop function if exists public.research_purge_stale();
drop function if exists public.youtube_quota_take(text, integer, integer, uuid, integer, text);
drop function if exists public.research_answer(text, boolean, timestamptz, jsonb, jsonb);
drop function if exists public.research_remedy(text, text);
drop function if exists public.research_last_request(text, text, text);
drop function if exists public.research_channel_json(text);
drop function if exists public.research_videos_json(text, integer);
drop function if exists public.research_channel_access(text, text);
drop function if exists public.research_topic_norm(text);
drop function if exists public.research_parse_ref(text);
drop function if exists public.research_stopwords();
drop function if exists public.research_min_interval(text);
drop function if exists public.research_clean(text, integer);
drop function if exists public.research_channel_confirmed(text);
drop function if exists public.research_draft_answer(text);
drop function if exists public.research_own_videos_json(text, integer, text);
drop function if exists public.research_own_videos_json(text, integer);
drop function if exists public.research_current_youtube_id(text);

drop table if exists public.research_requests;
drop table if exists public.research_own_analytics;
drop table if exists public.research_own_videos;
drop table if exists public.research_topic_results;
drop table if exists public.research_video_cache;
drop table if exists public.research_channel_cache;
drop table if exists public.research_competitors;
-- After research_requests: its error_code CHECK calls this function.
drop function if exists public.research_error_words();

delete from public.youtube_quota_ledger where source in ('research', 'research_search');
alter table public.youtube_quota_ledger drop constraint if exists youtube_quota_ledger_source_check;
alter table public.youtube_quota_ledger add constraint youtube_quota_ledger_source_check check (source in ('visibility'));

do $$
begin
  if to_regclass('public.research_requests') is not null or to_regprocedure('public.research_own_channel(text)') is not null
     or to_regprocedure('public.youtube_quota_take(text, integer, integer, uuid, integer, text)') is not null then
    raise exception 'rollback 0201: something of 0201 is still here';
  end if;
  if to_regprocedure('public.youtube_quota_take(text, integer, integer, uuid, integer)') is null then
    raise exception 'rollback 0201: 0116''s youtube_quota_take is missing (this rollback must not touch it)';
  end if;
end $$;

commit;
