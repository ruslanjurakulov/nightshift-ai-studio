-- 0202_channel_research.sql — channel research on our OWN YouTube Data API calls: the customer's own channel (its public numbers and
-- its YouTube Analytics totals), up to 20 competitor channels the customer names, the channels YouTube lists for a topic, and themes in
-- the channel's own inbox comments. Read by the page /{channel}/research and by the Studio chat ("Nightshift AI") as tools
-- (docs/studio/RESEARCH_TOOLS.md). vidIQ is NOT used here: its terms (§5(t)) forbid redistributing its data or building a competing
-- product on it, so nothing in this file or in modules/channel_research.py touches it.
--
-- *** APPLYING THIS FILE CHANGES THE LIVE DATABASE. Merging it to main applies it automatically, and an applied migration is never
-- *** edited: fix by a new forward migration (docs/MIGRATIONS.md).
--
-- THE RULES THIS FILE CARRIES (YouTube API Services Developer Policies, read 2026-11-21):
--   * Data about channels that did not authorize us (another channel's title, handle, statistics, its videos) may be stored for at
--     most 30 days, then refreshed or deleted. Every cached row has fetched_at; research_purge_stale() deletes what is older (the worker
--     calls it every cycle), and every reader ignores a row older than 30 days, so a purge that did not run is still never shown.
--   * The API's numbers are shown as the API gave them. Nothing here derives a metric (no ratio, no outlier or velocity score, no
--     sentiment, no sum across channels): no column, no expression. A hidden subscriber count is subscribers_hidden = true with
--     subscriber_count NULL ("hidden" on the page, rule 5), and a number the API did not give is NULL, never 0.
--   * The comment themes are Nightshift's own grouping of the channel's own inbox (0081), labelled as such (source 'nightshift'). A
--     comment's words are audience text: returned only under keys named untrusted_*, never put into an instruction.
--
-- WHAT IT ADDS
--  1. research_competitors      the channels a customer named (URL, @handle or UC… id), pending until the worker resolves the reference
--       with channels.list; unresolvable reads not_found (rule 7's spirit: a typed name is not a channel until YouTube says so). At most
--       20 per channel, unique per (channel, YouTube channel).
--  2. research_channel_cache, research_video_cache   public statistics as YouTube returned them, keyed by YouTube id, with fetched_at.
--  3. research_topic_results    the channel ids search.list returned for an organization's topic, in YouTube's order.
--  4. research_own_analytics    the customer's own channel's YouTube Analytics totals (authorized data, the channel's own token),
--       and research_own_videos, its own newest uploads (private and unlisted included), scoped to the channel: only a video YouTube
--       reports public is also written to the shared video cache. Both are shown only while the channel stays connected.
--  5. research_requests         the queue: one open request per (channel, kind, topic); a duplicate press returns the open one.
--  6. youtube_quota_ledger      its source CHECK gains 'research' (units of the shared 10,000-unit bucket) and 'research_search'
--       (search.list calls, YouTube's own bucket), dropped and re-added additively: 'visibility' keeps its meaning and its rows. A
--       youtube_quota_take() overload with p_source writes those two sources; 0116's five-argument function is untouched and still
--       counts 'visibility' only, so neither feature can spend the other's ceiling.
--  7. functions. Readers (a member, viewer and up): research_own_channel, research_competitors_view, research_topic_channels,
--       research_comment_themes, each answering {status, fetched_at, source, data, remedy, remedy_code, last_request}. Writers (editor
--       and up): research_request_refresh, research_add_competitor, research_remove_competitor; they write a row and stop (rule 3).
--       The worker (service key only): research_claim_request, research_finish_request, research_store_channels,
--       research_store_videos, research_resolve_competitor, research_store_topic, research_store_own, research_purge_stale.
--
-- WHAT IT DOES NOT DO. No YouTube call is made from the database or from a browser: the queue worker (tools/queue_worker.py,
-- modules/channel_research.py) makes every one, after taking the units from the ledger. It publishes nothing, changes no video and no
-- existing row, and touches no credit: research is a platform cost, capped per day (1,500 shared units and 30 searches project-wide,
-- three topic searches per organization per Pacific day).
--
-- Additive and idempotent: create table if not exists, guarded constraint swap, create or replace, drop policy/trigger then create,
-- revoke then grant. Rollback: docs/sql/rollback_0202_channel_research.sql.
-- REQUIRES 0018 (is_org_member, channel_org), 0020 (credits_trusted_caller), 0087 (take_web_rate), 0116 (youtube_quota_ledger,
-- visibility_channel_connected). 0081 (inbox_comments) is optional: without it the comment themes answer not_enabled.

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.channels') is null then
    raise exception '0202 needs channels: apply 0001 first';
  end if;
  if to_regprocedure('public.is_org_member(uuid, text)') is null or to_regprocedure('public.credits_trusted_caller()') is null then
    raise exception '0202 needs 0018_organizations.sql and 0020_credits.sql (is_org_member, credits_trusted_caller): apply them first';
  end if;
  if to_regprocedure('public.take_web_rate(text, integer, integer)') is null then
    raise exception '0202 needs 0087_audit_and_rate_hardening.sql (take_web_rate): apply it first';
  end if;
  if to_regclass('public.youtube_quota_ledger') is null
     or to_regprocedure('public.visibility_channel_connected(text)') is null then
    raise exception '0202 needs 0116_visibility_requests.sql (youtube_quota_ledger, visibility_channel_connected): apply it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables (all closed: RLS on, no policy, no grant; the functions below are the only way in or out)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.research_competitors (
  id                  uuid primary key default gen_random_uuid(),
  channel_id          text not null references public.channels (channel_id) on update cascade on delete cascade,
  org_id              uuid not null,
  -- The customer's reference, normalized: '@handle' (lower case) or a 'UC…' id. Never a full URL (the parser keeps only the part
  -- that names the channel), so nothing typed here is ever fetched as a link.
  input_ref           text not null check (input_ref ~ '^(@[^[:space:][:cntrl:]/?#&=@%<>"''\\]{3,30}|UC[A-Za-z0-9_-]{22})$'),
  ref_kind            text not null check (ref_kind in ('handle', 'id')),
  -- NULL until YouTube said which channel the reference names.
  youtube_channel_id  text check (youtube_channel_id is null or youtube_channel_id ~ '^UC[A-Za-z0-9_-]{22}$'),
  -- own_channel: the reference turned out to name this channel itself (an @handle of its own), refused once YouTube said so.
  status              text not null default 'pending' check (status in ('pending', 'resolved', 'not_found', 'own_channel', 'invalid_ref')),
  added_by            uuid,
  created_at          timestamptz not null default now(),
  resolved_at         timestamptz,
  constraint research_competitors_resolved_has_id check ((status = 'resolved') = (youtube_channel_id is not null)),
  constraint research_competitors_channel_ref_key unique (channel_id, input_ref),
  constraint research_competitors_channel_youtube_key unique (channel_id, youtube_channel_id)
);

create index if not exists research_competitors_channel_idx on public.research_competitors (channel_id, created_at);

-- A database that ran an earlier draft of this file has the status CHECK without own_channel / invalid_ref: swapped in place, every
-- existing row stays valid (the new list is a superset).
alter table public.research_competitors drop constraint if exists research_competitors_status_check;
alter table public.research_competitors add constraint research_competitors_status_check
  check (status in ('pending', 'resolved', 'not_found', 'own_channel', 'invalid_ref'));

-- A lookup YouTube refused without saying the channel does not exist (an HTTP 400 on forHandle): recorded on THAT row, which stays
-- pending, so one odd handle neither fails the whole refresh nor passes for "not found". After three in a row it is invalid_ref.
alter table public.research_competitors add column if not exists last_error text
  check (last_error is null or last_error in ('lookup_failed'));
alter table public.research_competitors add column if not exists last_error_at timestamptz;
alter table public.research_competitors add column if not exists lookup_failures integer not null default 0
  check (lookup_failures between 0 and 100);

comment on table public.research_competitors is
  'Channel research (migration 0202): a competitor channel a customer named. pending until the worker resolved it with channels.list; not_found when YouTube knows no such channel. Written only by research_add_competitor / research_remove_competitor / research_resolve_competitor.';

create table if not exists public.research_channel_cache (
  youtube_channel_id   text primary key check (youtube_channel_id ~ '^UC[A-Za-z0-9_-]{22}$'),
  title                text check (title is null or char_length(title) <= 200),
  handle               text check (handle is null or char_length(handle) <= 64),
  -- NULL with subscribers_hidden = true: the channel hides its count. NULL with false: the API did not say.
  subscriber_count     bigint check (subscriber_count is null or subscriber_count >= 0),
  subscribers_hidden   boolean not null default false,
  view_count           bigint check (view_count is null or view_count >= 0),
  video_count          bigint check (video_count is null or video_count >= 0),
  uploads_playlist_id  text check (uploads_playlist_id is null or uploads_playlist_id ~ '^[A-Za-z0-9_-]{2,64}$'),
  fetched_at           timestamptz not null default now(),
  constraint research_channel_cache_hidden_is_null check (not subscribers_hidden or subscriber_count is null)
);

comment on table public.research_channel_cache is
  'Channel research (0202): a channel''s public statistics exactly as channels.list returned them. Non-authorized data: deleted 30 days after fetched_at (research_purge_stale) and never read after that.';

create table if not exists public.research_video_cache (
  video_id            text primary key check (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  youtube_channel_id  text not null check (youtube_channel_id ~ '^UC[A-Za-z0-9_-]{22}$'),
  title               text check (title is null or char_length(title) <= 200),
  published_at        timestamptz,
  view_count          bigint check (view_count is null or view_count >= 0),
  -- NULL: the channel hides likes, or comments are off. Never 0 for "not said".
  like_count          bigint check (like_count is null or like_count >= 0),
  comment_count       bigint check (comment_count is null or comment_count >= 0),
  fetched_at          timestamptz not null default now()
);

create index if not exists research_video_cache_channel_idx
  on public.research_video_cache (youtube_channel_id, published_at desc nulls last);

comment on table public.research_video_cache is
  'Channel research (0202): a video''s public statistics exactly as videos.list returned them. Deleted 30 days after fetched_at.';

create table if not exists public.research_topic_results (
  id                   bigint generated always as identity primary key,
  org_id               uuid not null,
  topic_norm           text not null check (char_length(topic_norm) between 2 and 80),
  -- In the order search.list returned them (its relevance), at most 10.
  youtube_channel_ids  text[] not null default '{}' check (cardinality(youtube_channel_ids) <= 10),
  fetched_at           timestamptz not null default now(),
  constraint research_topic_results_org_topic_key unique (org_id, topic_norm)
);

comment on table public.research_topic_results is
  'Channel research (0202): which channels YouTube''s search.list (type=channel) returned for an organization''s topic. Deleted 30 days after fetched_at.';

create table if not exists public.research_own_analytics (
  channel_id                 text not null references public.channels (channel_id) on update cascade on delete cascade,
  period_days                integer not null check (period_days between 1 and 90),
  youtube_channel_id         text not null check (youtube_channel_id ~ '^UC[A-Za-z0-9_-]{22}$'),
  -- YouTube Analytics reports.query totals over the period, as returned. NULL = the report did not include the metric.
  views                      bigint check (views is null or views >= 0),
  estimated_minutes_watched  bigint check (estimated_minutes_watched is null or estimated_minutes_watched >= 0),
  subscribers_gained         bigint check (subscribers_gained is null or subscribers_gained >= 0),
  subscribers_lost           bigint check (subscribers_lost is null or subscribers_lost >= 0),
  fetched_at                 timestamptz not null default now(),
  primary key (channel_id, period_days)
);

comment on table public.research_own_analytics is
  'Channel research (0202): the customer''s own channel''s YouTube Analytics totals for the last period_days, read with that channel''s own token. Each metric as reported, never combined.';

-- The customer's OWN newest uploads, read with the channel's own token, which also sees private and unlisted ones. Scoped to the
-- channel (never the shared research_video_cache, which any organization naming that YouTube channel as a competitor reads: a
-- channel's private upload list is its own business, and Nightshift uploads private by default, rule 2). Only a video YouTube says is
-- public is ALSO written to the shared cache.
create table if not exists public.research_own_videos (
  channel_id      text not null references public.channels (channel_id) on update cascade on delete cascade,
  video_id        text not null check (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  title           text check (title is null or char_length(title) <= 200),
  published_at    timestamptz,
  view_count      bigint check (view_count is null or view_count >= 0),
  like_count      bigint check (like_count is null or like_count >= 0),
  comment_count   bigint check (comment_count is null or comment_count >= 0),
  -- As videos.list part=status reported it; NULL = not reported (then it is never shared).
  privacy_status  text check (privacy_status is null or privacy_status in ('public', 'unlisted', 'private')),
  fetched_at      timestamptz not null default now(),
  primary key (channel_id, video_id)
);

-- Which YouTube channel the token reached when these were read: shown only while it is still the channel's confirmed account.
alter table public.research_own_videos add column if not exists youtube_channel_id text
  check (youtube_channel_id is null or youtube_channel_id ~ '^UC[A-Za-z0-9_-]{22}$');

comment on table public.research_own_videos is
  'Channel research (0202): the customer''s own newest uploads (private and unlisted included), read with its own token and readable only through research_own_channel by that channel''s members. Deleted after 30 days or when the channel is no longer connected.';

create table if not exists public.research_requests (
  id            bigint generated always as identity primary key,
  channel_id    text not null references public.channels (channel_id) on update cascade on delete cascade,
  org_id        uuid not null,
  kind          text not null check (kind in ('own_channel', 'competitors', 'topic')),
  topic         text check (topic is null or char_length(topic) between 2 and 80),
  requested_by  uuid,
  status        text not null default 'queued'
                check (status in ('queued', 'running', 'done', 'failed', 'budget_exhausted', 'not_connected')),
  -- A closed word (research_error_words()), never a provider's text.
  error_code    text,
  attempts      integer not null default 0 check (attempts between 0 and 10),
  claimed_by    text check (claimed_by is null or claimed_by ~ '^[A-Za-z0-9._:-]{1,80}$'),
  lease_until   timestamptz,
  quota_units   integer not null default 0 check (quota_units >= 0),
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  constraint research_requests_topic_kind check ((kind = 'topic') = (topic is not null)),
  constraint research_requests_finished check ((status in ('queued', 'running')) = (finished_at is null))
);

-- The competitors a claim handed the worker (its snapshot). A competitor not in it, added while the request ran however close to the
-- claim, gets a follow-up round: comparing ids, not clocks, is what cannot miss one committed a moment after the claim read.
alter table public.research_requests add column if not exists claimed_competitor_ids uuid[];

-- One open request per (channel, kind, topic): a second press, or two tabs at once, finds the first instead of spending twice.
create unique index if not exists research_requests_one_open
  on public.research_requests (channel_id, kind, coalesce(topic, ''))
  where status in ('queued', 'running');
create index if not exists research_requests_queue_idx on public.research_requests (status, created_at);
create index if not exists research_requests_channel_idx on public.research_requests (channel_id, kind, created_at desc);
create index if not exists research_requests_org_day_idx on public.research_requests (org_id, kind, created_at);

comment on table public.research_requests is
  'Channel research (0202): a person asked for fresh numbers. Written by research_request_refresh / research_add_competitor (a row, nothing else: rule 3); carried out by the queue worker, which alone calls YouTube.';

-- The error words a request may end with, shared with modules/channel_research.py (tests/test_channel_research.py pins the two equal).
create or replace function public.research_error_words() returns text[]
  language sql immutable set search_path = public, pg_temp as $$
  select array['not_configured', 'quota', 'auth', 'not_found', 'scope_missing', 'token_expired', 'channel_mismatch',
               'rate_limited', 'platform_error', 'budget', 'not_connected', 'interrupted', 'worker_error']
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'research_requests_error_word'
                   and conrelid = 'public.research_requests'::regclass) then
    alter table public.research_requests add constraint research_requests_error_word
      check (error_code is null or error_code = any (public.research_error_words()));
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The quota ledger: two more sources, the same table and the same day
-- ───────────────────────────────────────────────────────────────────────────

-- 0116 wrote the CHECK inline, so Postgres named it youtube_quota_ledger_source_check. Dropped and added back with 'visibility' still
-- in it: every existing row stays valid, and 0116's functions (which only ever write 'visibility') behave exactly as before.
alter table public.youtube_quota_ledger drop constraint if exists youtube_quota_ledger_source_check;
alter table public.youtube_quota_ledger add constraint youtube_quota_ledger_source_check
  check (source in ('visibility', 'research', 'research_search'));

-- 0116's rule with the source named: take p_units, or answer false when that would pass p_ceiling (the source's whole Pacific day,
-- project-wide: the all-zero org row) or p_org_ceiling (this organization's share of it). Only the research sources: 'visibility'
-- keeps its one writer (0116's five-argument function), so a call here can never spend publish-when-approved's day.
create or replace function public.youtube_quota_take(
  p_project text, p_units integer, p_ceiling integer, p_org uuid, p_org_ceiling integer, p_source text
) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_day   date := (now() at time zone 'America/Los_Angeles')::date;
  v_all   constant uuid := '00000000-0000-0000-0000-000000000000';
  v_total integer;
  v_org   integer;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may spend quota' using errcode = '42501';
  end if;
  if coalesce(p_source, '') not in ('research', 'research_search')
     or coalesce(p_project, '') !~ '^[a-z0-9._-]{1,64}$' or p_units is null or p_units not between 1 and 200
     or p_ceiling is null or p_ceiling not between 0 and 10000
     or p_org is null or p_org = v_all or p_org_ceiling is null or p_org_ceiling not between 0 and 10000 then
    raise exception 'invalid quota request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('youtube_quota:' || p_project, 0));
  select coalesce(max(l.units) filter (where l.org_id = v_all), 0), coalesce(max(l.units) filter (where l.org_id = p_org), 0)
    into v_total, v_org
    from public.youtube_quota_ledger l
   where l.day = v_day and l.project = p_project and l.source = p_source;
  if v_total + p_units > p_ceiling or v_org + p_units > p_org_ceiling then
    return false;
  end if;
  insert into public.youtube_quota_ledger as l (day, project, source, org_id, units)
  values (v_day, p_project, p_source, v_all, p_units)
  on conflict (day, project, source, org_id) do update set units = l.units + p_units, updated_at = now();
  insert into public.youtube_quota_ledger as l (day, project, source, org_id, units)
  values (v_day, p_project, p_source, p_org, p_units)
  on conflict (day, project, source, org_id) do update set units = l.units + p_units, updated_at = now();
  delete from public.youtube_quota_ledger where day < v_day - 14;
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Internal helpers (no API role calls them; the functions below run as their owner)
-- ───────────────────────────────────────────────────────────────────────────

-- The channel's organization, for a caller who is a member with at least p_min_role. The organization comes from the CHANNEL row
-- (0116's rule): a caller who cannot see the channel gets exactly the answer a missing channel gets.
create or replace function public.research_channel_access(p_channel text, p_min_role text) returns uuid
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  org uuid;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_channel is null or p_channel !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select c.org_id into org from public.channels c where c.channel_id = p_channel;
  if org is null or not public.is_org_member(org) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(org, p_min_role) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return org;
end
$$;

-- A topic as it is stored and matched: trimmed, lower case, inner spaces collapsed; NULL when it is not a usable topic.
create or replace function public.research_topic_norm(p_topic text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select case
           when v is null or char_length(v) not between 2 and 80 or v ~ '[[:cntrl:]<>]' then null
           else v
         end
    from (select lower(regexp_replace(btrim(coalesce(p_topic, '')), '\s+', ' ', 'g')) as v) s
$$;

-- A competitor reference as typed (a YouTube URL, an @handle or a UC… id) -> {kind, ref}, or NULL. Only the part that names the
-- channel is kept: a /c/ or /user/ custom URL is refused (channels.list cannot resolve it reliably), and so is a bare word, which
-- could be a name, a handle or neither.
create or replace function public.research_parse_ref(p_ref text) returns jsonb
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v text := btrim(coalesce(p_ref, ''));
  head text;
begin
  if char_length(v) not between 3 and 300 or v ~ '[[:cntrl:][:space:]]' then
    return null;
  end if;
  if v ~* '^(https?://)?((www|m)\.)?youtube\.com/' then
    v := regexp_replace(v, '^(https?://)?((www|m)\.)?youtube\.com/', '', 'i');
    v := split_part(split_part(v, '?', 1), '#', 1);
    head := split_part(v, '/', 1);
    if head ~ '^@' then
      v := head;
    elsif lower(head) = 'channel' then
      v := split_part(v, '/', 2);
      if v !~ '^UC[A-Za-z0-9_-]{22}$' then
        return null;
      end if;
    else
      return null;
    end if;
  end if;
  if v ~ '^UC[A-Za-z0-9_-]{22}$' then
    return jsonb_build_object('kind', 'id', 'ref', v);
  end if;
  -- YouTube's handle alphabet: letters (any script), digits, underscore, hyphen and period. Anything else ("!", "$") is not a handle.
  if v ~ '^@[[:alpha:][:digit:]_.-]{3,30}$' then
    return jsonb_build_object('kind', 'handle', 'ref', lower(v));
  end if;
  return null;
end
$$;

-- The sentence the page and the chat show for a closed word, and the word they translate it by.
create or replace function public.research_remedy(p_status text, p_error text) returns jsonb
  language sql immutable set search_path = public, pg_temp as $$
  select case
    -- YouTube's own quota first: it ends a request budget_exhausted too, and its remedy is not ours to reset.
    when p_error = 'quota' then jsonb_build_object('remedy_code', 'quota',
      'remedy', 'YouTube''s daily quota for this project is used up; it resets at midnight Pacific time.')
    when p_status = 'budget_exhausted' or p_error = 'budget' then jsonb_build_object('remedy_code', 'budget',
      'remedy', 'Today''s research budget is used; it resets at midnight Pacific time.')
    -- A draft: never confirmed against YouTube (rule 7). Nothing is fetched for it, and no search is spent on it.
    when p_error = 'not_confirmed' then jsonb_build_object('remedy_code', 'connect',
      'remedy', 'Connect the channel to YouTube first.')
    when p_status = 'not_connected' or p_error = 'not_connected' then jsonb_build_object('remedy_code', 'connect',
      'remedy', 'Connect this channel to YouTube on the Channels page, then refresh.')
    when p_error = 'not_configured' then jsonb_build_object('remedy_code', 'not_configured',
      'remedy', 'Research isn''t set up on this server yet; contact support.')
    when p_error = 'auth' then jsonb_build_object('remedy_code', 'auth',
      'remedy', 'Research can''t reach YouTube because of a setup problem on our side; contact support.')
    when p_error in ('scope_missing', 'token_expired') then jsonb_build_object('remedy_code', 'reconnect',
      'remedy', 'Reconnect this channel on the Channels page so Nightshift may read its analytics.')
    when p_error = 'channel_mismatch' then jsonb_build_object('remedy_code', 'channel_mismatch',
      'remedy', 'The connected YouTube account is not this channel: reconnect it with the right account on the Channels page.')
    when p_error = 'not_found' then jsonb_build_object('remedy_code', 'not_found',
      'remedy', 'YouTube does not know this channel: check the link or the @handle.')
    when p_status = 'failed' then jsonb_build_object('remedy_code', 'retry', 'remedy', 'The refresh did not finish; try again later.')
    else '{}'::jsonb
  end
$$;

-- One reader answer. status: refreshing while a request is open; ok when there is fresh data; otherwise what the last request ended
-- as (not_connected, budget_exhausted) or no_data. A remedy is attached whenever the LAST request ended badly, data or not, so the
-- page can say "the last refresh did not finish" next to numbers that are older than the person thinks.
create or replace function public.research_answer(
  p_source text, p_has_data boolean, p_fetched_at timestamptz, p_data jsonb, p_last jsonb
) returns jsonb
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  st     text;
  last_s text := p_last ->> 'status';
  rem    jsonb := '{}'::jsonb;
begin
  if last_s in ('failed', 'budget_exhausted', 'not_connected') then
    rem := public.research_remedy(last_s, p_last ->> 'error_code');
  end if;
  st := case
          when last_s in ('queued', 'running') then 'refreshing'
          when p_has_data then 'ok'
          when last_s in ('not_connected', 'budget_exhausted') then last_s
          else 'no_data'
        end;
  -- Every string inside a youtube-sourced answer's data (a channel or video title, a handle) was written by whoever owns that
  -- channel: the flag tells the chat to treat all of it as data, never as an instruction (docs/studio/RESEARCH_TOOLS.md).
  return jsonb_build_object('status', st, 'fetched_at', p_fetched_at, 'source', p_source, 'data', coalesce(p_data, 'null'::jsonb),
                            'last_request', p_last, 'untrusted_strings', p_source = 'youtube') || rem;
end
$$;

-- The newest request of one kind (and topic) for a channel, as the readers show it: no worker internals.
create or replace function public.research_last_request(p_channel text, p_kind text, p_topic text) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', r.id, 'status', r.status, 'error_code', r.error_code, 'created_at', r.created_at,
                            'finished_at', r.finished_at)
    from public.research_requests r
   where r.channel_id = p_channel and r.kind = p_kind and r.topic is not distinct from p_topic
   order by r.created_at desc, r.id desc
   limit 1
$$;

-- One cached channel, fresh (under 30 days) or NULL. Exactly the API's fields; nothing computed from them.
create or replace function public.research_channel_json(p_youtube_channel_id text) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('youtube_channel_id', c.youtube_channel_id, 'title', c.title, 'handle', c.handle,
                            'subscriber_count', c.subscriber_count, 'subscribers_hidden', c.subscribers_hidden,
                            'view_count', c.view_count, 'video_count', c.video_count, 'fetched_at', c.fetched_at)
    from public.research_channel_cache c
   where c.youtube_channel_id = p_youtube_channel_id and c.fetched_at > now() - interval '30 days'
$$;

-- A channel's newest cached videos, fresh only, newest first.
create or replace function public.research_videos_json(p_youtube_channel_id text, p_limit integer) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(v.j order by v.published_at desc nulls last, v.video_id), '[]'::jsonb)
    from (select x.video_id, x.published_at,
                 jsonb_build_object('video_id', x.video_id, 'title', x.title, 'published_at', x.published_at,
                                    'view_count', x.view_count, 'like_count', x.like_count, 'comment_count', x.comment_count,
                                    'fetched_at', x.fetched_at) as j
            from public.research_video_cache x
           where x.youtube_channel_id = p_youtube_channel_id and x.fetched_at > now() - interval '30 days'
           order by x.published_at desc nulls last, x.video_id
           limit greatest(1, least(coalesce(p_limit, 10), 20))) v
$$;

-- Is the channel an account YouTube confirmed (rule 7)? The registry's rule (ChannelRegistry.active / is_verified, migration 0005):
-- credential_ref carries verified_at AND youtube_channel_id, or it is the operator's 'default' channel; a live YouTube connection
-- (0022 / 0116's visibility_channel_connected) is YouTube saying so too. A row made from a typed name and nothing else is a draft:
-- research neither fetches for it nor spends a search on it.
create or replace function public.research_channel_confirmed(p_channel text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select c.channel_id = 'default'
        or (coalesce(c.credential_ref ->> 'verified_at', '') <> '' and coalesce(c.credential_ref ->> 'youtube_channel_id', '') <> '')
        or public.visibility_channel_connected(c.channel_id)
      from public.channels c where c.channel_id = p_channel), false)
$$;

-- The YouTube channel this channel is confirmed as now: its verified credential_ref, else its live connection's, else the credential
-- row's. NULL when nothing says (then nothing contradicts a stored answer either).
create or replace function public.research_current_youtube_id(p_channel text) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select nullif(c.credential_ref ->> 'youtube_channel_id', '') from public.channels c where c.channel_id = p_channel),
    (select nullif(r.youtube_channel_id, '') from public.channel_token_refs r
      where r.channel_id = p_channel and r.vault_secret_id is not null and r.revoked_at is null),
    (select nullif(cc.youtube_channel_id, '') from public.channel_credentials cc
      where cc.channel_id = p_channel and cc.provider = 'youtube' and cc.status = 'connected'))
$$;

-- What every reader answers for a draft channel.
create or replace function public.research_draft_answer(p_source text) returns jsonb
  language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object('status', 'not_connected', 'fetched_at', null, 'source', p_source, 'data', null, 'last_request', null,
                            'untrusted_strings', p_source = 'youtube') || public.research_remedy(null, 'not_confirmed')
$$;

-- An earlier draft of this file defined it without the YouTube channel id it is filtered by.
drop function if exists public.research_own_videos_json(text, integer);
-- The channel's own newest uploads (its members only), fresh only, newest first, with the privacy YouTube reported.
create or replace function public.research_own_videos_json(p_channel text, p_limit integer, p_youtube_channel_id text) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(v.j order by v.published_at desc nulls last, v.video_id), '[]'::jsonb)
    from (select x.video_id, x.published_at,
                 jsonb_build_object('video_id', x.video_id, 'title', x.title, 'published_at', x.published_at,
                                    'view_count', x.view_count, 'like_count', x.like_count, 'comment_count', x.comment_count,
                                    'privacy_status', x.privacy_status, 'fetched_at', x.fetched_at) as j
            from public.research_own_videos x
           where x.channel_id = p_channel and x.fetched_at > now() - interval '30 days'
             and x.youtube_channel_id is not distinct from p_youtube_channel_id
           order by x.published_at desc nulls last, x.video_id
           limit greatest(1, least(coalesce(p_limit, 10), 20))) v
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Readers: the tool contract (docs/studio/RESEARCH_TOOLS.md)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.research_own_channel(p_channel text) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  org   uuid;
  a     public.research_own_analytics;
  ch    jsonb;
  last  jsonb;
  data  jsonb;
begin
  org := public.research_channel_access(p_channel, 'viewer');
  if not public.research_channel_confirmed(p_channel) then
    return public.research_draft_answer('youtube');
  end if;
  last := public.research_last_request(p_channel, 'own_channel', null);
  -- Authorized data, held only while the channel's owner keeps the connection: a disconnected channel's analytics are not shown
  -- (and the purge deletes them).
  if not public.visibility_channel_connected(p_channel) then
    return public.research_answer('youtube', false, null, null, last)
           || jsonb_build_object('status', 'not_connected') || public.research_remedy('not_connected', null);
  end if;
  select * into a from public.research_own_analytics x
   where x.channel_id = p_channel and x.period_days = 28 and x.fetched_at > now() - interval '30 days';
  -- Read with a token that reached another YouTube account than the one the channel is confirmed as now (reconnected to a different
  -- account since): not this channel's numbers. Nothing of it is shown; the fix is the right connection.
  if a.channel_id is not null and public.research_current_youtube_id(p_channel) is not null
     and a.youtube_channel_id <> public.research_current_youtube_id(p_channel) then
    return public.research_answer('youtube', false, null, null, last) || public.research_remedy(null, 'channel_mismatch');
  end if;
  if a.channel_id is not null then
    ch := public.research_channel_json(a.youtube_channel_id);
    data := jsonb_build_object(
      'youtube_channel_id', a.youtube_channel_id,
      'channel', ch,
      'analytics', jsonb_build_object('period_days', a.period_days, 'views', a.views,
                                      'estimated_minutes_watched', a.estimated_minutes_watched,
                                      'subscribers_gained', a.subscribers_gained, 'subscribers_lost', a.subscribers_lost,
                                      'fetched_at', a.fetched_at),
      'recent_videos', public.research_own_videos_json(p_channel, 10, a.youtube_channel_id));
    return public.research_answer('youtube', true, a.fetched_at, data, last);
  end if;
  return public.research_answer('youtube', false, null, null, last);
end
$$;

create or replace function public.research_competitors_view(p_channel text) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  org      uuid;
  last     jsonb;
  items    jsonb;
  newest   timestamptz;
  n        integer;
begin
  org := public.research_channel_access(p_channel, 'viewer');
  if not public.research_channel_confirmed(p_channel) then
    return public.research_draft_answer('youtube');
  end if;
  last := public.research_last_request(p_channel, 'competitors', null);
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'input_ref', r.input_ref, 'status', r.status, 'youtube_channel_id', r.youtube_channel_id,
           'created_at', r.created_at, 'resolved_at', r.resolved_at, 'last_error', r.last_error, 'last_error_at', r.last_error_at,
           'channel', case when r.status = 'resolved' then public.research_channel_json(r.youtube_channel_id) end,
           'videos', case when r.status = 'resolved' then public.research_videos_json(r.youtube_channel_id, 10) else '[]'::jsonb end)
         order by r.created_at, r.id), '[]'::jsonb),
         count(*)
    into items, n
    from public.research_competitors r
   where r.channel_id = p_channel;
  select max(c.fetched_at) into newest
    from public.research_competitors r
    join public.research_channel_cache c on c.youtube_channel_id = r.youtube_channel_id
   where r.channel_id = p_channel and c.fetched_at > now() - interval '30 days';
  return public.research_answer('youtube', n > 0, newest, jsonb_build_object('competitors', items, 'max', 20), last);
end
$$;

-- p_topic NULL: the organization's topics with fresh results (newest first), so the page and the chat can offer them again.
create or replace function public.research_topic_channels(p_channel text, p_topic text default null) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  org    uuid;
  t      text;
  res    public.research_topic_results;
  last   jsonb;
  chans  jsonb;
  topics jsonb;
begin
  org := public.research_channel_access(p_channel, 'viewer');
  if not public.research_channel_confirmed(p_channel) then
    return public.research_draft_answer('youtube');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('topic', x.topic_norm, 'fetched_at', x.fetched_at) order by x.fetched_at desc), '[]'::jsonb)
    into topics
    from (select topic_norm, fetched_at from public.research_topic_results
           where org_id = org and fetched_at > now() - interval '30 days' order by fetched_at desc limit 10) x;
  if p_topic is null then
    return public.research_answer('youtube', jsonb_array_length(topics) > 0, null,
                                  jsonb_build_object('topic', null, 'channels', '[]'::jsonb, 'recent_topics', topics), null);
  end if;
  t := public.research_topic_norm(p_topic);
  if t is null then
    return jsonb_build_object('status', 'no_data', 'fetched_at', null, 'source', 'youtube', 'error', 'invalid_topic',
                              'data', jsonb_build_object('topic', null, 'channels', '[]'::jsonb, 'recent_topics', topics),
                              'last_request', null, 'untrusted_strings', true);
  end if;
  last := public.research_last_request(p_channel, 'topic', t);
  select * into res from public.research_topic_results x
   where x.org_id = org and x.topic_norm = t and x.fetched_at > now() - interval '30 days';
  if res.id is null then
    return public.research_answer('youtube', false, null,
                                  jsonb_build_object('topic', t, 'channels', '[]'::jsonb, 'recent_topics', topics), last);
  end if;
  -- In YouTube's order; a channel whose statistics are not cached (or are older than 30 days) is left out, never shown empty.
  select coalesce(jsonb_agg(public.research_channel_json(u.id) order by u.ord), '[]'::jsonb) into chans
    from unnest(res.youtube_channel_ids) with ordinality as u(id, ord)
   where public.research_channel_json(u.id) is not null;
  return public.research_answer('youtube', true, res.fetched_at,
                                jsonb_build_object('topic', t, 'channels', chans, 'recent_topics', topics), last);
end
$$;

-- Words too common to be a theme, in the three languages the product speaks. Short on purpose: a stop list that grows until the
-- groups look right is a list that hides what the audience actually said.
create or replace function public.research_stopwords() returns text[]
  language sql immutable set search_path = public, pg_temp as $$
  select array[
    'the','and','for','you','your','this','that','with','are','was','but','not','have','has','had','just','like','from','what',
    'how','why','who','all','can','its','it''s','they','them','his','her','she','him','our','out','get','got','one','more','very',
    'really','about','would','could','should','there','their','then','than','when','will','also','been','were','here','some',
    'any','did','does','doing','don''t','im','i''m','me','my','we','so','too','is','it','in','on','of','to','a','an','or','be',
    'video','videos','channel','please','thanks','thank',
    'это','как','что','так','для','все','всё','его','она','они','оно','мне','меня','вас','вам','нас','нам','был','была','были',
    'есть','нет','уже','еще','ещё','очень','только','когда','тоже','или','если','вот','там','тут','где','кто','чем','при','про',
    'без','над','под','было','будет','можно','надо','вы','мы','он','не','на','по','за','из','от','до','видео','канал','спасибо',
    'va','bu','shu','uchun','bilan','ham','juda','endi','lekin','yoki','emas','edi','men','sen','siz','biz','ular','nima',
    'qanday','nega','bor','yoʻq','yo''q','kerak','mana','ekan','deb','degan','video','kanal','rahmat'
  ]
$$;

create or replace function public.research_comment_themes(p_channel text, p_days integer default 28) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  org      uuid;
  d        integer := greatest(1, least(coalesce(p_days, 28), 30));
  total    integer;
  newest   timestamptz;
  qs       jsonb;
  qn       integer;
  words    jsonb;
begin
  org := public.research_channel_access(p_channel, 'viewer');
  if not public.research_channel_confirmed(p_channel) then
    return public.research_draft_answer('nightshift');
  end if;
  -- 0081 not applied: the inbox does not exist here, which is not the same as "nobody commented".
  if to_regclass('public.inbox_comments') is null then
    return jsonb_build_object('status', 'not_enabled', 'fetched_at', null, 'source', 'nightshift', 'data', null,
                              'last_request', null);
  end if;
  -- One statement, so the five answers are about the same comments. Newest first, at most 2,000: a theme is what many said lately.
  with c as (
    select x.id, x.video_id, x.body, coalesce(x.published_at, x.fetched_at) as at
      from public.inbox_comments x
     where x.channel_id = p_channel
       and coalesce(x.published_at, x.fetched_at) >= now() - make_interval(days => d)
       and x.fetched_at > now() - interval '30 days'
       and x.category is distinct from 'spam'
       -- The inbox's classifier flagged it as a prompt injection: never sampled for the chat, not even as untrusted text.
       and x.flagged_injection is not true
     order by coalesce(x.published_at, x.fetched_at) desc
     limit 2000
  ), toks as (
    select distinct c.id, w.w
      from c, lateral regexp_split_to_table(lower(c.body), '[[:space:][:punct:]«»“”„‘’—–…¿¡؟،？！。、]+') as w(w)
     where char_length(w.w) between 3 and 40 and w.w !~ '^[0-9]+$' and not (w.w = any (public.research_stopwords()))
  ), top as (
    select t.w, count(*)::integer as n from toks t group by t.w having count(*) >= 2 order by count(*) desc, t.w limit 10
  )
  select (select count(*) from c),
         (select max(c.at) from c),
         (select count(*) from c where c.body ~ '[?？؟]'),
         (select coalesce(jsonb_agg(jsonb_build_object('untrusted_text', left(s.body, 280), 'video_id', s.video_id,
                                                       'published_at', s.at) order by s.at desc), '[]'::jsonb)
            from (select * from c where c.body ~ '[?？؟]' order by c.at desc limit 5) s),
         (select coalesce(jsonb_agg(jsonb_build_object(
                   'untrusted_word', top.w, 'count', top.n,
                   'samples', (select coalesce(jsonb_agg(jsonb_build_object('untrusted_text', left(s.body, 280),
                                                                            'video_id', s.video_id, 'published_at', s.at)
                                                         order by s.at desc), '[]'::jsonb)
                                 from (select c.body, c.video_id, c.at from c
                                        where exists (select 1 from toks k where k.id = c.id and k.w = top.w)
                                        order by c.at desc limit 3) s))
                 order by top.n desc, top.w), '[]'::jsonb)
            from top)
    into total, newest, qn, qs, words;
  return jsonb_build_object(
    'status', case when total > 0 then 'ok' else 'no_data' end,
    'fetched_at', newest,
    'source', 'nightshift',
    'label', 'grouped by Nightshift, not YouTube data',
    'data', jsonb_build_object('period_days', d, 'total_comments', total,
                               'questions', jsonb_build_object('count', qn, 'samples', qs),
                               'words', words),
    'last_request', null);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Writers: a row, and stop (rule 3)
-- ───────────────────────────────────────────────────────────────────────────

-- How long a finished refresh counts as fresh enough that another press would only spend the day's budget again.
create or replace function public.research_min_interval(p_kind text) returns interval
  language sql immutable set search_path = public, pg_temp as $$
  select case when p_kind = 'topic' then interval '24 hours' else interval '1 hour' end
$$;

create or replace function public.research_request_refresh(p_channel text, p_kind text, p_topic text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid    uuid := auth.uid();
  org    uuid;
  t      text;
  open_r public.research_requests;
  rid    bigint;
  done_at timestamptz;
  today  integer;
begin
  org := public.research_channel_access(p_channel, 'editor');
  if not public.research_channel_confirmed(p_channel) then
    return jsonb_build_object('ok', false, 'error', 'not_connected') || public.research_remedy(null, 'not_confirmed');
  end if;
  if coalesce(p_kind, '') not in ('own_channel', 'competitors', 'topic') then
    return jsonb_build_object('ok', false, 'error', 'invalid_kind');
  end if;
  if p_kind = 'topic' then
    t := public.research_topic_norm(p_topic);
    if t is null then
      return jsonb_build_object('ok', false, 'error', 'invalid_topic');
    end if;
  end if;
  if not public.take_web_rate('research_refresh', 30, 3600) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('research:' || p_channel || ':' || p_kind || ':' || coalesce(t, ''), 0));
  select * into open_r from public.research_requests r
   where r.channel_id = p_channel and r.kind = p_kind and r.topic is not distinct from t and r.status in ('queued', 'running');
  if open_r.id is not null then
    return jsonb_build_object('ok', true, 'status', 'already_queued', 'request_id', open_r.id);
  end if;
  if p_kind = 'own_channel' and not public.visibility_channel_connected(p_channel) then
    return jsonb_build_object('ok', false, 'error', 'not_connected') || public.research_remedy('not_connected', null);
  end if;
  if p_kind = 'competitors' and not exists (select 1 from public.research_competitors c where c.channel_id = p_channel) then
    return jsonb_build_object('ok', false, 'error', 'no_competitors');
  end if;
  -- Fresh enough already: say when, and spend nothing.
  if p_kind = 'topic' then
    select x.fetched_at into done_at from public.research_topic_results x where x.org_id = org and x.topic_norm = t;
  else
    select max(r.finished_at) into done_at from public.research_requests r
     where r.channel_id = p_channel and r.kind = p_kind and r.status = 'done';
  end if;
  -- A competitor still waiting to be resolved is never "recent": the last refresh ran before it was added.
  if done_at is not null and done_at > now() - public.research_min_interval(p_kind)
     and not (p_kind = 'competitors'
              and exists (select 1 from public.research_competitors c where c.channel_id = p_channel and c.status = 'pending')) then
    return jsonb_build_object('ok', true, 'status', 'recent', 'request_id', null, 'fetched_at', done_at,
                              'next_at', done_at + public.research_min_interval(p_kind));
  end if;
  if p_kind = 'topic' then
    -- Three topic searches per organization per Pacific day, counted here before anything is queued (the worker's ledger counts
    -- them again: an organization's share of the project's 30 search calls).
    perform pg_advisory_xact_lock(hashtextextended('research_topic:' || org::text, 0));
    select count(*) into today from public.research_requests r
     where r.org_id = org and r.kind = 'topic'
       and (r.created_at at time zone 'America/Los_Angeles')::date = (now() at time zone 'America/Los_Angeles')::date
       and coalesce(r.error_code, '') not in ('not_configured', 'budget', 'quota');
    if today >= 3 then
      return jsonb_build_object('ok', false, 'error', 'daily_limit') || public.research_remedy('budget_exhausted', null);
    end if;
  end if;
  insert into public.research_requests (channel_id, org_id, kind, topic, requested_by)
  values (p_channel, org, p_kind, t, uid)
  on conflict (channel_id, kind, coalesce(topic, '')) where status in ('queued', 'running') do nothing
  returning id into rid;
  if rid is null then
    select r.id into rid from public.research_requests r
     where r.channel_id = p_channel and r.kind = p_kind and r.topic is not distinct from t and r.status in ('queued', 'running');
    return jsonb_build_object('ok', true, 'status', 'already_queued', 'request_id', rid);
  end if;
  return jsonb_build_object('ok', true, 'status', 'queued', 'request_id', rid);
end
$$;

create or replace function public.research_add_competitor(p_channel text, p_ref text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid    uuid := auth.uid();
  org    uuid;
  parsed jsonb;
  ref    text;
  own    text;
  cid    uuid;
  n      integer;
  rid    bigint;
begin
  org := public.research_channel_access(p_channel, 'editor');
  if not public.research_channel_confirmed(p_channel) then
    return jsonb_build_object('ok', false, 'error', 'not_connected') || public.research_remedy(null, 'not_confirmed');
  end if;
  parsed := public.research_parse_ref(p_ref);
  if parsed is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_ref');
  end if;
  ref := parsed ->> 'ref';
  select nullif(c.credential_ref ->> 'youtube_channel_id', '') into own from public.channels c where c.channel_id = p_channel;
  if own is not null and own = ref then
    return jsonb_build_object('ok', false, 'error', 'own_channel');
  end if;
  if not public.take_web_rate('research_competitor', 40, 3600) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('research_competitors:' || p_channel, 0));
  select r.id into cid from public.research_competitors r
   where r.channel_id = p_channel and (r.input_ref = ref or r.youtube_channel_id = ref);
  if cid is not null then
    return jsonb_build_object('ok', true, 'id', cid, 'already', true);
  end if;
  select count(*) into n from public.research_competitors r where r.channel_id = p_channel;
  if n >= 20 then
    return jsonb_build_object('ok', false, 'error', 'limit_reached', 'max', 20);
  end if;
  insert into public.research_competitors (channel_id, org_id, input_ref, ref_kind, added_by, created_at)
  values (p_channel, org, ref, parsed ->> 'kind', uid, clock_timestamp())
  returning id into cid;
  -- The worker resolves it on its next cycle: one open 'competitors' request carries every pending reference. Not subject to the
  -- one-hour rule (a new name needs resolving); the worker refreshes only what is older than an hour, so this stays cheap.
  insert into public.research_requests (channel_id, org_id, kind, topic, requested_by)
  values (p_channel, org, 'competitors', null, uid)
  on conflict (channel_id, kind, coalesce(topic, '')) where status in ('queued', 'running') do nothing
  returning id into rid;
  return jsonb_build_object('ok', true, 'id', cid, 'already', false, 'status', 'pending', 'request_id', rid);
end
$$;

create or replace function public.research_remove_competitor(p_channel text, p_id uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  org uuid;
  n   integer;
begin
  org := public.research_channel_access(p_channel, 'editor');
  if p_id is null then
    return jsonb_build_object('ok', true, 'removed', false);
  end if;
  -- Limited like adding: remove + add again is otherwise a way around the one-hour rule.
  if not public.take_web_rate('research_competitor_remove', 40, 3600) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  -- Scoped by the channel the caller may edit: another channel's id removes nothing and answers the same as a missing one.
  delete from public.research_competitors r where r.id = p_id and r.channel_id = p_channel;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'removed', n > 0);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The worker (service key only)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.research_claim_request(p_worker text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r     public.research_requests;
  ch    public.channels;
  comps jsonb;
  i     integer;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may claim research' using errcode = '42501';
  end if;
  if coalesce(p_worker, '') !~ '^[A-Za-z0-9._:-]{1,80}$' then
    raise exception 'invalid worker id' using errcode = '22023';
  end if;
  -- A worker that died mid-request: its lease ran out. Back to the queue, or ended after its third claim.
  update public.research_requests
     set status = 'failed', error_code = 'interrupted', finished_at = now(), claimed_by = null, lease_until = null
   where status = 'running' and lease_until < now() and attempts >= 3;
  update public.research_requests
     set status = 'queued', claimed_by = null, lease_until = null
   where status = 'running' and lease_until < now();
  -- A request queued while its channel was confirmed is not carried out once it is not (disconnected, its confirmation gone): it
  -- ends not_connected here, before the worker spends anything on it (rule 7).
  for i in 1..50 loop
    select * into r from public.research_requests
     where status = 'queued'
     order by created_at, id
     limit 1
     for update skip locked;
    if r.id is null then
      return null;
    end if;
    exit when public.research_channel_confirmed(r.channel_id);
    update public.research_requests
       set status = 'not_connected', error_code = 'not_connected', finished_at = now(), claimed_by = null, lease_until = null
     where id = r.id;
    r := null;
  end loop;
  if r.id is null then
    return null;
  end if;
  update public.research_requests
     set status = 'running', claimed_by = p_worker, lease_until = now() + interval '10 minutes',
         attempts = least(attempts + 1, 10), started_at = coalesce(started_at, now())
   where id = r.id;
  select * into ch from public.channels c where c.channel_id = r.channel_id;
  if r.kind = 'competitors' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', c.id, 'input_ref', c.input_ref, 'ref_kind', c.ref_kind, 'status', c.status,
             'youtube_channel_id', c.youtube_channel_id,
             -- The cached channel this reference names, if any (a re-added competitor reuses a fresh cache at no cost): its id, or for an
             -- @handle the channel whose handle it is.
             'cached_id', k.youtube_channel_id,
             'channel_fetched_at', k.fetched_at,
             'videos_fetched_at', (select max(v.fetched_at) from public.research_video_cache v where v.youtube_channel_id = k.youtube_channel_id),
             'uploads_playlist_id', k.uploads_playlist_id)
           order by c.created_at), '[]'::jsonb)
      into comps
      from public.research_competitors c
      left join lateral (
        select x.youtube_channel_id, x.fetched_at, x.uploads_playlist_id
          from public.research_channel_cache x
         where x.fetched_at > now() - interval '30 days'
           and (x.youtube_channel_id = coalesce(c.youtube_channel_id, case when c.ref_kind = 'id' then c.input_ref end)
                or (c.youtube_channel_id is null and c.ref_kind = 'handle' and lower(x.handle) = c.input_ref))
         order by x.fetched_at desc
         limit 1) k on true
     where c.channel_id = r.channel_id and c.status in ('pending', 'resolved');
    update public.research_requests
       set claimed_competitor_ids = coalesce((select array_agg(c.id) from public.research_competitors c
                                               where c.channel_id = r.channel_id and c.status in ('pending', 'resolved')), '{}')
     where id = r.id;
  end if;
  return jsonb_build_object('id', r.id, 'channel_id', r.channel_id, 'org_id', r.org_id, 'kind', r.kind, 'topic', r.topic,
                            'attempts', r.attempts + 1, 'youtube_channel_id', nullif(ch.credential_ref ->> 'youtube_channel_id', ''),
                            -- The database's clock: the worker's cutoff for "rows written before this fetch began" (complete batches).
                            'started_at', coalesce(r.started_at, now()),
                            'competitors', coalesce(comps, '[]'::jsonb));
end
$$;

create or replace function public.research_finish_request(
  p_request_id bigint, p_worker text, p_status text, p_error_code text, p_units integer
) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  n integer;
  r public.research_requests;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may finish research' using errcode = '42501';
  end if;
  if coalesce(p_status, '') not in ('done', 'failed', 'budget_exhausted', 'not_connected')
     or (p_error_code is not null and not (p_error_code = any (public.research_error_words())))
     or (p_status = 'done') <> (p_error_code is null) then
    raise exception 'invalid research result' using errcode = '22023';
  end if;
  update public.research_requests
     set status = p_status, error_code = p_error_code, finished_at = now(), claimed_by = null, lease_until = null,
         quota_units = quota_units + greatest(coalesce(p_units, 0), 0)
   where id = p_request_id and status = 'running' and claimed_by = p_worker
  returning * into r;
  get diagnostics n = row_count;
  -- A competitor added while this request was running was not in what the worker claimed: queue the next round now, so it is not left
  -- pending until somebody presses Refresh (the add found this request open and queued nothing of its own).
  -- Only for a channel still confirmed (rule 7), and asked for by the person who added the late competitor: the request row records
  -- who asked, and that was them.
  if n > 0 and r.kind = 'competitors' and p_status = 'done' and public.research_channel_confirmed(r.channel_id) then
    insert into public.research_requests (channel_id, org_id, kind, topic, requested_by)
    -- Only a competitor added after this request started names who asked; otherwise nobody in particular did (null).
    select r.channel_id, r.org_id, 'competitors', null, case when late.created_at >= r.started_at then late.added_by end
      from (select c.added_by, c.created_at from public.research_competitors c
             where c.channel_id = r.channel_id and c.status = 'pending'
               and not (c.id = any (coalesce(r.claimed_competitor_ids, '{}')))
             order by c.created_at desc limit 1) late
    on conflict (channel_id, kind, coalesce(topic, '')) where status in ('queued', 'running') do nothing;
  end if;
  return n > 0;
end
$$;

-- Cleaned like the inbox cleans audience text: control characters out, trimmed, at most n characters. A title is someone else's text
-- and is shown as text, never as markup.
create or replace function public.research_clean(p_text text, p_max integer) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select nullif(left(btrim(regexp_replace(coalesce(p_text, ''), '[[:cntrl:]]+', ' ', 'g')), p_max), '')
$$;

create or replace function public.research_store_channels(p_rows jsonb) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  n integer;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may store research' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 50 then
    raise exception 'invalid research rows' using errcode = '22023';
  end if;
  insert into public.research_channel_cache as c
    (youtube_channel_id, title, handle, subscriber_count, subscribers_hidden, view_count, video_count, uploads_playlist_id, fetched_at)
  select x.youtube_channel_id, public.research_clean(x.title, 200), public.research_clean(x.handle, 64),
         case when coalesce(x.subscribers_hidden, false) then null else x.subscriber_count end,
         coalesce(x.subscribers_hidden, false), x.view_count, x.video_count, x.uploads_playlist_id, now()
    from jsonb_to_recordset(p_rows) as x(youtube_channel_id text, title text, handle text, subscriber_count bigint,
                                         subscribers_hidden boolean, view_count bigint, video_count bigint, uploads_playlist_id text)
  on conflict (youtube_channel_id) do update
     set title = excluded.title, handle = excluded.handle, subscriber_count = excluded.subscriber_count,
         subscribers_hidden = excluded.subscribers_hidden, view_count = excluded.view_count, video_count = excluded.video_count,
         uploads_playlist_id = excluded.uploads_playlist_id, fetched_at = excluded.fetched_at;
  get diagnostics n = row_count;
  -- YouTube just answered for these channels: a competitor list in active use is re-confirmed here, so the 30-day reset (purge)
  -- only reaches a reference nobody refreshed for 30 days.
  -- Only where this answer confirms THIS reference: an id reference by its id, an @handle only when the answer still carries that
  -- handle (another tenant's id lookup says nothing about whether a handle still names the same channel).
  update public.research_competitors c
     set resolved_at = now()
    from jsonb_to_recordset(p_rows) as x(youtube_channel_id text, handle text)
   where c.status = 'resolved'
     and c.youtube_channel_id = x.youtube_channel_id
     and (c.ref_kind = 'id' or lower(x.handle) = c.input_ref);
  return n;
end
$$;

-- Videos as videos.list returned them. Three kinds of row in one batch:
--   * a public lookup (the API key): {video_id, youtube_channel_id, ...} -> the shared cache;
--   * a channel's complete list marker {youtube_channel_id, complete: true} (no video_id): the shared cache's other rows for that
--     channel are deleted, so a video that went private, or was deleted, disappears instead of lingering for 30 days;
--   * an own-channel row {own_request_id, privacy_status, ...} (the channel's own token, which sees private uploads): stored for that
--     request's channel only (research_own_videos, whose other rows for the channel are replaced), and ALSO in the shared cache only
--     when privacy_status is 'public'. One that YouTube reports private or unlisted is taken OUT of the shared cache.
create or replace function public.research_store_videos(p_rows jsonb) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  n       integer := 0;
  m       integer;
  own_rid bigint;
  r       public.research_requests;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may store research' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 51 then
    raise exception 'invalid research rows' using errcode = '22023';
  end if;
  create temporary table if not exists pg_temp.research_tmp_videos (
    video_id text, youtube_channel_id text, title text, published_at timestamptz, view_count bigint, like_count bigint,
    comment_count bigint, own_request_id bigint, privacy_status text, complete boolean, fetched_since timestamptz
  ) on commit drop;
  truncate pg_temp.research_tmp_videos;
  insert into pg_temp.research_tmp_videos
  select x.video_id, x.youtube_channel_id, public.research_clean(x.title, 200), x.published_at, x.view_count, x.like_count,
         x.comment_count, x.own_request_id, x.privacy_status, coalesce(x.complete, false), x.fetched_since
    from jsonb_to_recordset(p_rows) as x(video_id text, youtube_channel_id text, title text, published_at timestamptz,
                                         view_count bigint, like_count bigint, comment_count bigint, own_request_id bigint,
                                         privacy_status text, complete boolean, fetched_since timestamptz);
  if exists (select 1 from pg_temp.research_tmp_videos where video_id is null and not complete) then
    raise exception 'invalid research rows' using errcode = '22023';
  end if;
  select min(own_request_id) into own_rid from pg_temp.research_tmp_videos;
  if own_rid is not null then
    if exists (select 1 from pg_temp.research_tmp_videos
                where own_request_id is distinct from own_rid or (complete and video_id is not null)
                   or (video_id is null and not complete)) then
      raise exception 'an own-channel batch is one request''s, and only that' using errcode = '22023';
    end if;
    select * into r from public.research_requests where id = own_rid and kind = 'own_channel' and status = 'running';
    if r.id is null then
      return 0;
    end if;
    -- The batch is the channel's whole newest list (an empty playlist is one complete marker): everything else goes.
    delete from public.research_own_videos o
     where o.channel_id = r.channel_id
       and o.video_id not in (select t.video_id from pg_temp.research_tmp_videos t where t.video_id is not null);
    insert into public.research_own_videos as o
      (channel_id, video_id, youtube_channel_id, title, published_at, view_count, like_count, comment_count, privacy_status, fetched_at)
    select r.channel_id, t.video_id, t.youtube_channel_id, t.title, t.published_at, t.view_count, t.like_count, t.comment_count,
           case when t.privacy_status in ('public', 'unlisted', 'private') then t.privacy_status end, now()
      from pg_temp.research_tmp_videos t
     where t.video_id is not null
    on conflict (channel_id, video_id) do update
       set youtube_channel_id = excluded.youtube_channel_id, title = excluded.title, published_at = excluded.published_at,
           view_count = excluded.view_count, like_count = excluded.like_count, comment_count = excluded.comment_count,
           privacy_status = excluded.privacy_status, fetched_at = excluded.fetched_at;
    get diagnostics n = row_count;
    -- Not public (any more): out of what other organizations read.
    delete from public.research_video_cache v
     using pg_temp.research_tmp_videos t where v.video_id = t.video_id and t.privacy_status in ('private', 'unlisted');
    delete from pg_temp.research_tmp_videos where privacy_status is distinct from 'public';
  end if;
  -- A complete list replaces the channel's cached videos: those written before this fetch began (fetched_since) and not in it. A
  -- row another worker wrote for the same channel while this one was fetching is newer than that, and stays.
  delete from public.research_video_cache v
   using (select youtube_channel_id, min(coalesce(fetched_since, now())) as since
            from pg_temp.research_tmp_videos where complete group by youtube_channel_id) c
   where v.youtube_channel_id = c.youtube_channel_id
     and v.fetched_at < c.since
     and v.video_id not in (select t.video_id from pg_temp.research_tmp_videos t
                             where t.video_id is not null and t.youtube_channel_id = c.youtube_channel_id);
  insert into public.research_video_cache as v
    (video_id, youtube_channel_id, title, published_at, view_count, like_count, comment_count, fetched_at)
  select t.video_id, t.youtube_channel_id, t.title, t.published_at, t.view_count, t.like_count, t.comment_count, now()
    from pg_temp.research_tmp_videos t
   where t.video_id is not null
  on conflict (video_id) do update
     set youtube_channel_id = excluded.youtube_channel_id, title = excluded.title, published_at = excluded.published_at,
         view_count = excluded.view_count, like_count = excluded.like_count, comment_count = excluded.comment_count,
         fetched_at = excluded.fetched_at;
  get diagnostics m = row_count;
  return n + m;
end
$$;

-- What YouTube said a reference names: p_youtube_channel_id, or NULL for "no such channel". A reference that turns out to name a
-- channel already in the list (an @handle and the same channel's UC… id) is removed as the duplicate it is: 'duplicate'.
create or replace function public.research_resolve_competitor(p_id uuid, p_youtube_channel_id text) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r public.research_competitors;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may resolve research' using errcode = '42501';
  end if;
  if p_youtube_channel_id is not null and p_youtube_channel_id !~ '^UC[A-Za-z0-9_-]{22}$' then
    raise exception 'invalid youtube channel id' using errcode = '22023';
  end if;
  select * into r from public.research_competitors where id = p_id for update;
  if r.id is null then
    return 'gone';
  end if;
  if p_youtube_channel_id is null then
    update public.research_competitors set status = 'not_found', youtube_channel_id = null, resolved_at = now(), last_error = null, last_error_at = null, lookup_failures = 0 where id = p_id;
    return 'not_found';
  end if;
  -- An @handle that turned out to be this channel's own: refused, said so (status own_channel), never compared with itself.
  if exists (select 1 from public.channels c
              where c.channel_id = r.channel_id and c.credential_ref ->> 'youtube_channel_id' = p_youtube_channel_id) then
    update public.research_competitors set status = 'own_channel', youtube_channel_id = null, resolved_at = now(), last_error = null, last_error_at = null, lookup_failures = 0 where id = p_id;
    return 'own_channel';
  end if;
  if exists (select 1 from public.research_competitors x
              where x.channel_id = r.channel_id and x.youtube_channel_id = p_youtube_channel_id and x.id <> p_id) then
    delete from public.research_competitors where id = p_id;
    return 'duplicate';
  end if;
  update public.research_competitors
     set status = 'resolved', youtube_channel_id = p_youtube_channel_id, resolved_at = now(),
         last_error = null, last_error_at = null, lookup_failures = 0
   where id = p_id;
  return 'resolved';
end
$$;

-- One failed lookup of a pending reference (HTTP 400, not "no such channel"): counted on the row, which stays pending; the third in a
-- row makes it invalid_ref, a terminal state the person fixes by removing it and adding the channel's link.
create or replace function public.research_competitor_lookup_failed(p_id uuid) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_status text;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may record a lookup' using errcode = '42501';
  end if;
  update public.research_competitors
     set lookup_failures = lookup_failures + 1, last_error = 'lookup_failed', last_error_at = now(),
         status = case when lookup_failures + 1 >= 3 then 'invalid_ref' else status end,
         resolved_at = case when lookup_failures + 1 >= 3 then now() else resolved_at end
   where id = p_id and status = 'pending'
  returning status into v_status;
  return coalesce(v_status, 'gone');
end
$$;

-- The org and the topic come from the REQUEST, not from the worker's arguments: a result can only land where it was asked for.
create or replace function public.research_store_topic(p_request_id bigint, p_youtube_channel_ids text[]) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r public.research_requests;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may store research' using errcode = '42501';
  end if;
  if p_youtube_channel_ids is null or cardinality(p_youtube_channel_ids) > 10
     or exists (select 1 from unnest(p_youtube_channel_ids) u(id) where u.id is null or u.id !~ '^UC[A-Za-z0-9_-]{22}$') then
    raise exception 'invalid topic result' using errcode = '22023';
  end if;
  select * into r from public.research_requests where id = p_request_id and kind = 'topic' and status = 'running';
  if r.id is null then
    return false;
  end if;
  insert into public.research_topic_results as t (org_id, topic_norm, youtube_channel_ids, fetched_at)
  values (r.org_id, r.topic, p_youtube_channel_ids, now())
  on conflict (org_id, topic_norm) do update set youtube_channel_ids = excluded.youtube_channel_ids, fetched_at = excluded.fetched_at;
  return true;
end
$$;

-- The channel's own analytics. The channel comes from the request; a token that reaches a different YouTube channel than the one this
-- channel was confirmed as (credential_ref.youtube_channel_id, 0005) stores nothing and answers 'channel_mismatch'.
create or replace function public.research_store_own(
  p_request_id bigint, p_youtube_channel_id text, p_period_days integer,
  p_views bigint, p_minutes bigint, p_gained bigint, p_lost bigint
) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r    public.research_requests;
  want text;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may store research' using errcode = '42501';
  end if;
  if coalesce(p_youtube_channel_id, '') !~ '^UC[A-Za-z0-9_-]{22}$' or p_period_days is null or p_period_days not between 1 and 90 then
    raise exception 'invalid analytics result' using errcode = '22023';
  end if;
  select * into r from public.research_requests where id = p_request_id and kind = 'own_channel' and status = 'running';
  if r.id is null then
    return 'gone';
  end if;
  select nullif(c.credential_ref ->> 'youtube_channel_id', '') into want from public.channels c where c.channel_id = r.channel_id;
  if want is not null and want <> p_youtube_channel_id then
    return 'channel_mismatch';
  end if;
  insert into public.research_own_analytics as a
    (channel_id, period_days, youtube_channel_id, views, estimated_minutes_watched, subscribers_gained, subscribers_lost, fetched_at)
  values (r.channel_id, p_period_days, p_youtube_channel_id, p_views, p_minutes, p_gained, p_lost, now())
  on conflict (channel_id, period_days) do update
     set youtube_channel_id = excluded.youtube_channel_id, views = excluded.views,
         estimated_minutes_watched = excluded.estimated_minutes_watched, subscribers_gained = excluded.subscribers_gained,
         subscribers_lost = excluded.subscribers_lost, fetched_at = excluded.fetched_at;
  return 'ok';
end
$$;

-- The 30-day rule, carried out. Called by the worker every cycle; the readers ignore older rows anyway, so a purge that did not run
-- shows nothing stale. Finished requests are kept 30 days too (they count today's topic searches and say what the last refresh did).
create or replace function public.research_purge_stale() returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_channels integer;
  v_videos   integer;
  v_topics   integer;
  v_own      integer;
  v_requests integer;
  v_own_videos integer;
  v_unconnected integer;
  v_resolved integer;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may purge research' using errcode = '42501';
  end if;
  delete from public.research_channel_cache where fetched_at < now() - interval '30 days';
  get diagnostics v_channels = row_count;
  delete from public.research_video_cache where fetched_at < now() - interval '30 days';
  get diagnostics v_videos = row_count;
  delete from public.research_topic_results where fetched_at < now() - interval '30 days';
  get diagnostics v_topics = row_count;
  delete from public.research_own_analytics where fetched_at < now() - interval '30 days';
  get diagnostics v_own = row_count;
  delete from public.research_own_videos where fetched_at < now() - interval '30 days';
  get diagnostics v_own_videos = row_count;
  -- Authorized data is kept only while the owner keeps the connection.
  delete from public.research_own_analytics a where not public.visibility_channel_connected(a.channel_id);
  get diagnostics v_unconnected = row_count;
  delete from public.research_own_videos o where not public.visibility_channel_connected(o.channel_id);
  -- Which YouTube channel a reference names is YouTube's answer too: after 30 days it is asked again (pending), not kept.
  with reset as (
    update public.research_competitors
       set status = 'pending', youtube_channel_id = null, resolved_at = null
     where status in ('resolved', 'not_found', 'own_channel') and resolved_at < now() - interval '30 days'
       -- Not under a running competitors request: it would finish without them and queue nothing. The next purge reaches them.
       and not exists (select 1 from public.research_requests q
                        where q.channel_id = research_competitors.channel_id and q.kind = 'competitors' and q.status = 'running')
    returning channel_id, org_id
  ), asked as (
    -- ... and asked: one competitors request per affected confirmed channel, so none waits on "checking" with nothing queued.
    insert into public.research_requests (channel_id, org_id, kind, topic, requested_by)
    select distinct x.channel_id, ch.org_id, 'competitors', null::text, null::uuid
      from reset x join public.channels ch on ch.channel_id = x.channel_id
     where public.research_channel_confirmed(x.channel_id)
    on conflict (channel_id, kind, coalesce(topic, '')) where status in ('queued', 'running') do nothing
    returning 1
  )
  select (select count(*) from reset) into v_resolved;
  delete from public.research_requests where finished_at < now() - interval '30 days';
  get diagnostics v_requests = row_count;
  return jsonb_build_object('channels', v_channels, 'videos', v_videos, 'topics', v_topics, 'own', v_own + v_unconnected,
                            'own_videos', v_own_videos, 'competitors_reset', v_resolved, 'requests', v_requests);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Who may do what
-- ───────────────────────────────────────────────────────────────────────────

alter table public.research_competitors enable row level security;
alter table public.research_channel_cache enable row level security;
alter table public.research_video_cache enable row level security;
alter table public.research_topic_results enable row level security;
alter table public.research_own_analytics enable row level security;
alter table public.research_requests enable row level security;
alter table public.research_own_videos enable row level security;

-- No API role reads or writes any of them directly, the service key included: every read and write is a function above.
revoke all on public.research_competitors from public, anon, authenticated, service_role;
revoke all on public.research_channel_cache from public, anon, authenticated, service_role;
revoke all on public.research_video_cache from public, anon, authenticated, service_role;
revoke all on public.research_topic_results from public, anon, authenticated, service_role;
revoke all on public.research_own_analytics from public, anon, authenticated, service_role;
revoke all on public.research_requests from public, anon, authenticated, service_role;
revoke all on public.research_own_videos from public, anon, authenticated, service_role;
revoke all on sequence public.research_topic_results_id_seq from public, anon, authenticated, service_role;
revoke all on sequence public.research_requests_id_seq from public, anon, authenticated, service_role;

-- Internal helpers: nobody calls them from the API.
revoke all on function public.research_error_words() from public, anon, authenticated, service_role;
revoke all on function public.research_channel_access(text, text) from public, anon, authenticated, service_role;
revoke all on function public.research_topic_norm(text) from public, anon, authenticated, service_role;
revoke all on function public.research_parse_ref(text) from public, anon, authenticated, service_role;
revoke all on function public.research_remedy(text, text) from public, anon, authenticated, service_role;
revoke all on function public.research_answer(text, boolean, timestamptz, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.research_last_request(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.research_channel_json(text) from public, anon, authenticated, service_role;
revoke all on function public.research_videos_json(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.research_stopwords() from public, anon, authenticated, service_role;
revoke all on function public.research_min_interval(text) from public, anon, authenticated, service_role;
revoke all on function public.research_clean(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.research_channel_confirmed(text) from public, anon, authenticated, service_role;
revoke all on function public.research_draft_answer(text) from public, anon, authenticated, service_role;
revoke all on function public.research_own_videos_json(text, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.research_current_youtube_id(text) from public, anon, authenticated, service_role;

-- A signed-in member (each function checks the organization and the role itself): not anon, not the service key.
revoke all on function public.research_own_channel(text) from public, anon, authenticated, service_role;
revoke all on function public.research_competitors_view(text) from public, anon, authenticated, service_role;
revoke all on function public.research_topic_channels(text, text) from public, anon, authenticated, service_role;
revoke all on function public.research_comment_themes(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.research_request_refresh(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.research_add_competitor(text, text) from public, anon, authenticated, service_role;
revoke all on function public.research_remove_competitor(text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.research_own_channel(text) to authenticated;
grant execute on function public.research_competitors_view(text) to authenticated;
grant execute on function public.research_topic_channels(text, text) to authenticated;
grant execute on function public.research_comment_themes(text, integer) to authenticated;
grant execute on function public.research_request_refresh(text, text, text) to authenticated;
grant execute on function public.research_add_competitor(text, text) to authenticated;
grant execute on function public.research_remove_competitor(text, uuid) to authenticated;

-- The worker: the service key only.
revoke all on function public.youtube_quota_take(text, integer, integer, uuid, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.research_claim_request(text) from public, anon, authenticated, service_role;
revoke all on function public.research_finish_request(bigint, text, text, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.research_store_channels(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.research_store_videos(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.research_resolve_competitor(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.research_store_topic(bigint, text[]) from public, anon, authenticated, service_role;
revoke all on function public.research_store_own(bigint, text, integer, bigint, bigint, bigint, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.research_purge_stale() from public, anon, authenticated, service_role;
grant execute on function public.youtube_quota_take(text, integer, integer, uuid, integer, text) to service_role;
grant execute on function public.research_claim_request(text) to service_role;
grant execute on function public.research_finish_request(bigint, text, text, text, integer) to service_role;
grant execute on function public.research_store_channels(jsonb) to service_role;
grant execute on function public.research_store_videos(jsonb) to service_role;
grant execute on function public.research_resolve_competitor(uuid, text) to service_role;
grant execute on function public.research_store_topic(bigint, text[]) to service_role;
grant execute on function public.research_store_own(bigint, text, integer, bigint, bigint, bigint, bigint) to service_role;
grant execute on function public.research_purge_stale() to service_role;
revoke all on function public.research_competitor_lookup_failed(uuid) from public, anon, authenticated, service_role;
grant execute on function public.research_competitor_lookup_failed(uuid) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     (select bool_and(relrowsecurity) from pg_class
--       where oid in ('public.research_competitors'::regclass, 'public.research_channel_cache'::regclass,
--                     'public.research_video_cache'::regclass, 'public.research_topic_results'::regclass,
--                     'public.research_own_analytics'::regclass, 'public.research_requests'::regclass,
--                     'public.research_own_videos'::regclass)) as rls_on,
--     not has_table_privilege('authenticated', 'public.research_requests', 'INSERT')
--       and not has_table_privilege('authenticated', 'public.research_channel_cache', 'SELECT')
--       and not has_table_privilege('service_role', 'public.research_video_cache', 'INSERT')
--       and not has_table_privilege('anon', 'public.research_competitors', 'SELECT') as nobody_touches_tables,
--     has_function_privilege('authenticated', 'public.research_own_channel(text)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.research_own_channel(text)', 'EXECUTE')
--       and has_function_privilege('authenticated', 'public.research_request_refresh(text,text,text)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.research_claim_request(text)', 'EXECUTE')
--       and has_function_privilege('service_role', 'public.research_claim_request(text)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.youtube_quota_take(text,integer,integer,uuid,integer,text)', 'EXECUTE')
--       as functions_scoped,
--     (select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
--        from pg_proc p where p.pronamespace = 'public'::regnamespace
--         and p.proname in ('research_own_channel', 'research_competitors_view', 'research_topic_channels',
--                           'research_comment_themes', 'research_request_refresh', 'research_add_competitor',
--                           'research_remove_competitor', 'research_claim_request', 'research_finish_request',
--                           'research_store_channels', 'research_store_videos', 'research_resolve_competitor',
--                           'research_store_topic', 'research_store_own', 'research_purge_stale')) as definers_pin_search_path,
--     (select pg_get_constraintdef(oid) like '%visibility%' and pg_get_constraintdef(oid) like '%research_search%'
--        from pg_constraint where conname = 'youtube_quota_ledger_source_check') as ledger_sources,
--     to_regprocedure('public.youtube_quota_take(text,integer,integer,uuid,integer)') is not null as visibility_quota_unchanged;
