-- 0090_inbox_followups.sql: the comment inbox's follow-ups after the independent
-- re-verification of 0081 (LENS-20, ledger BR-L-120 .. BR-L-128). Additive: three new
-- columns, one setting, three new functions, and eight of 0081's own functions replaced
-- on their LATEST bodies (0081's, nothing else replaced them) with only the lines named
-- below changed (tests/test_comment_inbox_followups_migration.py pins every string
-- literal of each replaced body against 0081's).
--
--   BR-L-120  inbox_clean_text also removes the remaining default-ignorable code points
--             (U+17B4/17B5, U+180B-180F, U+FFF0-FFF8, U+1BCA0-3, U+1D173-A, U+13430-F, U+E0000-E0FFF), reads the
--             blank-looking spaces (U+00A0, U+1680, U+2000-200A, U+202F, U+205F, U+3000) as
--             ordinary spaces, and trims newlines as well as spaces: a reply of only those
--             is empty and approve_reply / edit_reply_draft refuse it (invalid_body). The
--             shared table is tests/fixtures/inbox_cleaner_cases.txt (database, worker and
--             screen read the same one).
--   BR-L-121  A per-organization share of the inbox's daily YouTube quota ceiling
--             (inbox_settings.org_share_percent, default 25, set by a platform admin with
--             set_inbox_org_share): claim_reply_post skips an organization's post once its
--             rolling-day spend (replies and reads of its channels) has used its share, and
--             one customer's 40 approvals can no longer use the whole platform's day. Posts
--             that wait for quota (the platform ceiling or the share) say so:
--             reply_posts.wait_reason = 'quota', which the card shows. The platform ceiling
--             stays.
--   BR-L-124  A comment the classifier cannot answer is tried at most three times
--             (inbox_comments.classify_attempts); inbox_comments_to_classify stops offering
--             it. (The worker also drops comments that clean to nothing before classifying.)
--   BR-L-125  inbox_draft_block also finds an approved reply by (channel_id,
--             youtube_comment_id), so a comment fetched again with a new row id is not
--             offered a draft that could never be approved.
--   BR-L-126  request_reply_draft (and the quote's may_start) need a real org_members row
--             in a customer organization, like approve_reply and retry_reply_post: a
--             platform admin who is not a member cannot press a priced draft against a
--             customer's balance. Read, quote and edit stay for support.
--   BR-L-127  approve_reply answers an approval with different words, for a draft that is
--             already approved, with NS409 already_approved instead of a replay answer.
--
-- Not changed here, listed for the owner (ledger): BR-L-122 (the ceiling is soft by the
-- posts in flight), BR-L-128 (replied comments and approver e-mails are kept).
--
-- RE-APPLYING 0081 ALONE AFTER THIS FILE puts the eight replaced functions back to 0081's
-- bodies (the new columns, the setting and the three new functions stay, and nothing breaks:
-- the old bodies do not know them). Apply 0090 again after it. In a fresh build the order
-- 0081, then 0090 is the filename order. Replay-twice safe: guarded columns, create or
-- replace, revoke-then-grant, `on conflict do nothing`.
--
-- REQUIRES 0081.

do $$
begin
  if to_regprocedure('public.approve_reply(uuid, text)') is null
     or to_regprocedure('public.inbox_quota_remaining()') is null then
    raise exception '0090 needs the comment inbox: apply 0081_comment_inbox.sql first';
  end if;
end $$;

-- 1. Columns and the share setting ------------------------------------------------------

alter table public.inbox_comments add column if not exists classify_attempts smallint not null default 0;
alter table public.reply_posts add column if not exists wait_reason text;
alter table public.inbox_settings add column if not exists org_share_percent integer not null default 25;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'reply_posts_wait_reason_check') then
    alter table public.reply_posts add constraint reply_posts_wait_reason_check
      check (wait_reason is null or wait_reason = 'quota');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inbox_settings_org_share_check') then
    alter table public.inbox_settings add constraint inbox_settings_org_share_check
      check (org_share_percent between 1 and 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inbox_comments_classify_attempts_check') then
    alter table public.inbox_comments add constraint inbox_comments_classify_attempts_check
      check (classify_attempts between 0 and 3);
  end if;
end $$;

comment on column public.reply_posts.wait_reason is
  'Comment inbox (0090): quota while the platform ceiling or the organization''s share of it holds the post back; null otherwise. Shown on the card.';
comment on column public.inbox_settings.org_share_percent is
  'Comment inbox (0090): the part of the daily YouTube quota ceiling one organization may use, in percent.';

-- 2. New functions -----------------------------------------------------------------------

-- What is left of an organization's share of the day's quota ceiling: the share of the
-- ceiling minus what the organization's channels spent (replies and reads) in the rolling day.
create or replace function public.inbox_org_quota_left(p_channel text) returns integer
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  org     uuid := public.channel_org(p_channel);
  ceiling integer;
  share   integer;
  used    numeric;
begin
  select s.daily_quota_ceiling, s.org_share_percent into ceiling, share from public.inbox_settings s where s.id;
  ceiling := coalesce(ceiling, 2000);
  share := coalesce(share, 25);
  select coalesce(sum(l.units), 0) into used
    from public.inbox_quota_ledger l
    join public.channels c on c.channel_id = l.channel_id
   where c.org_id = org and l.at > now() - interval '24 hours';
  return greatest(floor(ceiling * share / 100.0) - used, 0)::integer;
end
$$;

-- What the worker may still spend on this channel: the platform's ceiling or its
-- organization's share, whichever is lower.
create or replace function public.inbox_channel_quota_left(p_channel text) returns integer
  language sql stable security definer set search_path = public, pg_temp as $$
  select least(public.inbox_quota_remaining(), public.inbox_org_quota_left(p_channel))
$$;

-- A platform owner/admin sets one organization's share of the ceiling, in percent.
create or replace function public.set_inbox_org_share(p_percent integer) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_percent is null or p_percent < 1 or p_percent > 100 then
    raise exception 'invalid_share' using errcode = 'NS400', detail = 'between 1 and 100';
  end if;
  update public.inbox_settings set org_share_percent = p_percent, updated_by = auth.uid(), updated_at = now() where id;
  return jsonb_build_object('org_share_percent', p_percent);
end
$$;

-- 3. 0081's functions, on their latest bodies with the lines named in the header changed ---

create or replace function public.inbox_clean_text(p_text text, p_max integer) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select btrim(left(btrim(
           regexp_replace(
             regexp_replace(
               regexp_replace(replace(left(coalesce(p_text, ''), greatest(coalesce(p_max, 0), 0) * 4 + 16), E'\r\n', E'\n'),
                              E'[\\x01-\\x09\\x0b-\\x1f\\x7f]', '', 'g'),
               -- Blank-looking spaces (no-break, ogham, U+2000-200A, narrow no-break, medium
               -- mathematical, ideographic) read as ordinary spaces: a reply of only these is
               -- empty, not a blank comment.
               '[' || chr(160) || chr(5760) || chr(8192) || '-' || chr(8202) || chr(8239) || chr(8287) || chr(12288) || ']', ' ', 'g'),
             -- Invisible and format characters that no reader sees: C1 controls, soft hyphen,
             -- grapheme joiner, Arabic letter mark, Khmer inherent vowels, Hangul fillers,
             -- Mongolian free variation selectors and vowel separator, zero-width and direction
             -- marks (U+200B-200F), line/paragraph separators and the embedding/override
             -- controls (U+2028-202E), word joiner, invisible operators and the deprecated
             -- format controls (U+2060-206F), braille blank, FE00-FE0D variation selectors
             -- (FE0E/FE0F stay: they pick emoji or text style), BOM, halfwidth Hangul filler,
             -- interlinear annotation controls, Bamum/musical/Egyptian format controls, the
             -- whole of the Unicode tag plane block U+E0000-E0FFF (a hidden-text channel for prompt
             -- injection; with the variation selectors supplement) and the unassigned
             -- default-ignorables U+FFF0-FFF8.
             '[' || chr(128) || '-' || chr(159) || chr(173) || chr(847) || chr(1564) || chr(4447) || '-' || chr(4448) || chr(6068) || chr(6069) || chr(6155) || '-' || chr(6159) || chr(8203) || '-' || chr(8207) || chr(8232) || '-' || chr(8238) || chr(8288) || '-' || chr(8303) || chr(10240) || chr(12644) || chr(65024) || '-' || chr(65037) || chr(65279) || chr(65440) || chr(65520) || '-' || chr(65531) || chr(78896) || '-' || chr(78911) || chr(113824) || '-' || chr(113827) || chr(119155) || '-' || chr(119162) || chr(917504) || '-' || chr(921599) || ']',
             '', 'g')), greatest(coalesce(p_max, 0), 0)), E' \n')
$$;

create or replace function public.inbox_draft_block(p_comment uuid) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c public.inbox_comments;
  st text;
begin
  select * into c from public.inbox_comments where id = p_comment;
  if not found then
    return 'not_found';
  end if;
  if c.status = 'dismissed' then return 'dismissed'; end if;
  -- An approved reply is looked for by the YouTube comment too, not only by this row's id: a
  -- comment fetched again after its row went away has a new id (BR-L-125).
  if c.status = 'replied'
     or exists (select 1 from public.reply_intents i where i.comment_id = c.id)
     or exists (select 1 from public.reply_intents i
                 where i.channel_id = c.channel_id and i.youtube_comment_id = c.youtube_comment_id) then
    return 'already_replied';
  end if;
  if c.flagged_injection then return 'flagged'; end if;
  if c.category = 'spam' then return 'spam'; end if;
  if c.category is null then return 'not_classified'; end if;
  select d.status into st from public.reply_drafts d
   where d.comment_id = c.id and d.status in ('pending', 'drafting', 'ready') limit 1;
  if st in ('pending', 'drafting') then return 'in_progress'; end if;
  if st = 'ready' then return 'draft_exists'; end if;
  return null;
end
$$;

create or replace function public.quote_reply_draft(p_comment uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c      public.inbox_comments;
  org    uuid;
  block  text;
  price  numeric;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into c from public.inbox_comments where id = p_comment;
  if found then
    org := public.channel_org(c.channel_id);
  end if;
  if not found or org is null or not public.is_org_member(org) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  block := public.inbox_draft_block(c.id);
  price := public.reply_draft_price();
  return jsonb_build_object(
    'status', case when block is not null then 'unavailable'
                   when price is null then 'unpriced'
                   when price = 0 then 'included'
                   else 'priced' end,
    'credits', case when block is null and price is not null and price > 0 then price end,
    'reason', block,
    'exempt', public.credits_exempt(org),
    'may_start', public.is_org_member(org, 'editor')
                 and public.inbox_real_member(org, 'editor')
                 and (not public.credits_exempt(org) or public.is_platform_admin()),
    'reply_ready', public.inbox_channel_ready(c.channel_id));
end
$$;

create or replace function public.request_reply_draft(
  p_comment     uuid,
  p_max_credits numeric default null,
  p_idem        text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid    uuid := auth.uid();
  idem   text := nullif(btrim(coalesce(p_idem, '')), '');
  c      public.inbox_comments;
  org    uuid;
  prior  public.reply_drafts;
  block  text;
  price  numeric;
  did    uuid := gen_random_uuid();
  ref    text;
  res    jsonb;
  d      public.reply_drafts;
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into c from public.inbox_comments where id = p_comment;
  if found then
    org := public.channel_org(c.channel_id);
  end if;
  if not found or org is null or not public.is_org_member(org) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- A draft is charged to the customer's balance and shown to them: a real member of that
  -- organization presses it (a platform admin who is not one reads, quotes and edits for
  -- support), outside the operator's own organization (BR-L-126).
  if not public.inbox_real_member(org, 'editor') then
    raise exception 'forbidden' using errcode = '42501',
      detail = 'a reply draft is requested by a member of the channel''s organization';
  end if;
  -- The operator's organization is paid by the platform itself, and every
  -- account that existed before 0018 is a member of it (0036's rule).
  if public.credits_exempt(org) and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501',
      detail = 'drafts in the operator''s organization are started by a platform admin';
  end if;
  if idem is null or idem !~ '^[A-Za-z0-9_:.-]{8,128}$' then
    perform public.creative_refuse('invalid_idempotency_key',
      'idempotency key: 8-128 characters of A-Z a-z 0-9 _ : . -');
  end if;

  -- The organization's credit account first: two presses queue behind each
  -- other, and a replay finds the first one's committed row.
  perform public.credit_account_lock(org);

  select * into prior from public.reply_drafts where channel_id = c.channel_id and idempotency_key = idem;
  if found then
    if prior.comment_id is distinct from c.id then
      perform public.creative_refuse('idempotency_conflict',
        'this idempotency key was used for a different comment', 'NS409');
    end if;
    return jsonb_build_object('draft', jsonb_build_object('id', prior.id, 'status', prior.status,
             'quoted_credits', prior.quoted_credits), 'replay', true, 'credits_held', 0);
  end if;

  block := public.inbox_draft_block(c.id);
  if block is not null then
    if block in ('in_progress', 'draft_exists') then
      perform public.creative_refuse(block, 'a draft for this comment is already in progress', 'NS409');
    elsif block = 'already_replied' then
      perform public.creative_refuse('already_replied', 'this comment already has an approved reply', 'NS409');
    end if;
    perform public.creative_refuse('not_draftable', block);
  end if;
  if (select count(*) from public.reply_drafts x
       where x.channel_id = c.channel_id and x.created_at > now() - interval '24 hours')
     >= public.inbox_daily_cap('draft') then
    perform public.creative_refuse('daily_limit', 'this channel has reached today''s limit of reply drafts', 'NS429');
  end if;

  price := public.reply_draft_price();
  if price is null then
    perform public.creative_refuse('unpriced',
      'reply drafts have no credit price yet; a platform admin sets the reply_draft price on the Credits page');
  end if;
  if price > 0 and p_max_credits is null and not public.credits_exempt(org) then
    raise exception 'price_required' using errcode = '22023', detail = format('credits=%s', price);
  end if;
  if p_max_credits is not null and (p_max_credits = 'NaN'::numeric or p_max_credits < 0) then
    raise exception 'price_required' using errcode = '22023', detail = format('credits=%s', price);
  end if;
  if p_max_credits is not null and price > p_max_credits then
    perform public.creative_refuse('price_changed',
      format('credits=%s confirmed=%s', price, p_max_credits), 'NS409');
  end if;

  ref := 'rd:' || did::text;
  if price > 0 then
    -- NS402 'insufficient credits' (available=… needed=…) and NS429 (the plan's
    -- parallel runs) come from here, before anything is written.
    res := public.creative_platform_reserve(org, ref, price);
    if coalesce((res ->> 'exempt')::boolean, false) then
      ref := null;
    end if;
  else
    ref := null;
  end if;

  insert into public.reply_drafts
    (id, comment_id, channel_id, status, quoted_credits, credit_ref, idempotency_key, request_hash, requested_by)
  values
    (did, c.id, c.channel_id, 'pending', price, ref, idem, md5(c.id::text), uid)
  returning * into d;
  perform public.inbox_log(c.channel_id, c.id, did, 'draft_requested',
    jsonb_build_object('credits_held', case when ref is null then 0 else price end));

  return jsonb_build_object('draft', jsonb_build_object('id', d.id, 'status', d.status,
           'quoted_credits', d.quoted_credits), 'replay', false,
           'credits_held', case when ref is null then 0 else price end);
end
$$;

create or replace function public.approve_reply(p_draft uuid, p_body text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid   uuid := auth.uid();
  d     public.reply_drafts;
  c     public.inbox_comments;
  org   uuid;
  txt   text := public.inbox_clean_text(p_body, 500);
  i     public.reply_intents;
  p     public.reply_posts;
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into d from public.reply_drafts where id = p_draft;
  if found then
    org := public.channel_org(d.channel_id);
  end if;
  if not found or org is null or not public.is_org_member(org) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Public speech under the customer's name: a real member of that organization
  -- (a platform admin who is not one reads, quotes and edits, but does not approve).
  if not public.inbox_real_member(org, 'editor') then
    raise exception 'forbidden' using errcode = '42501',
      detail = 'a reply is approved by a member of the channel''s organization';
  end if;
  -- Locked only once the caller is known to be allowed: the comment first, then
  -- the draft (dismiss_inbox_comment takes them in the same order, so a person
  -- approving while a colleague sets the comment aside cannot deadlock).
  select * into c from public.inbox_comments where id = d.comment_id for update;
  select * into d from public.reply_drafts where id = p_draft for update;

  select * into i from public.reply_intents where draft_id = d.id;
  if found then
    -- The same words again is a replay. Other words are refused, with the text that is filed
    -- left alone: a second approver is told, not answered "ok" (BR-L-127).
    if i.body is distinct from txt then
      perform public.creative_refuse('already_approved', 'this draft was already approved with other words', 'NS409');
    end if;
    select * into p from public.reply_posts where intent_id = i.id;
    return jsonb_build_object('intent_id', i.id, 'post_id', p.id, 'status', p.status, 'replay', true);
  end if;

  if d.status <> 'ready' then
    perform public.creative_refuse('not_approvable', format('status=%s', d.status), 'NS409');
  end if;
  if c.status <> 'open' then
    perform public.creative_refuse('comment_closed', format('status=%s', c.status), 'NS409');
  end if;
  if c.flagged_injection or c.category is null or c.category = 'spam' then
    perform public.creative_refuse('not_draftable', 'this comment may not be replied to');
  end if;
  if char_length(txt) < 1 then
    perform public.creative_refuse('invalid_body', 'a reply cannot be empty');
  end if;
  if not public.inbox_channel_ready(c.channel_id) then
    perform public.creative_refuse('channel_not_ready',
      'the channel is not connected with permission to reply: reconnect it', 'NS409');
  end if;
  -- The daily cap is counted under a lock of its own, so concurrent approvals
  -- cannot all read "39" (BR-L-071). An advisory lock, not a row lock: nothing
  -- else takes it, so it cannot deadlock with the comment and draft locks above.
  perform pg_advisory_xact_lock(hashtext('inbox:reply:' || c.channel_id));
  if (select count(*) from public.reply_intents x
       where x.channel_id = c.channel_id and x.approved_at > now() - interval '24 hours')
     >= public.inbox_daily_cap('reply') then
    perform public.creative_refuse('daily_limit', 'this channel has reached today''s limit of replies', 'NS429');
  end if;

  begin
    insert into public.reply_intents
      (channel_id, comment_id, draft_id, video_id, youtube_comment_id, body, drafted_body, edited,
       approved_by, approved_by_email)
    values
      (c.channel_id, c.id, d.id, c.video_id, c.youtube_comment_id, txt, d.drafted_body,
       txt is distinct from d.drafted_body, uid, nullif(auth.jwt() ->> 'email', ''))
    returning * into i;
  exception when unique_violation then
    perform public.creative_refuse('already_replied', 'this comment already has an approved reply', 'NS409');
  end;
  insert into public.reply_posts (intent_id, channel_id, comment_id)
  values (i.id, c.channel_id, c.id)
  returning * into p;
  update public.reply_drafts
     set status = 'approved', body = txt, edited = i.edited, finished_at = now(), updated_at = now()
   where id = d.id;
  perform public.inbox_log(c.channel_id, c.id, d.id, 'reply_approved',
    jsonb_build_object('edited', i.edited, 'chars', char_length(txt), 'intent_id', i.id));
  return jsonb_build_object('intent_id', i.id, 'post_id', p.id, 'status', p.status, 'replay', false);
end
$$;

create or replace function public.store_inbox_comments(p_channel text, p_video text, p_comments jsonb)
  returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  n integer;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may store comments' using errcode = '42501';
  end if;
  if not exists (select 1 from public.videos v where v.video_id = p_video and v.channel_id = p_channel) then
    raise exception 'invalid_video' using errcode = 'NS400',
      detail = 'the video must belong to the channel';
  end if;
  if p_comments is null or jsonb_typeof(p_comments) <> 'array' or jsonb_array_length(p_comments) > 100 then
    raise exception 'invalid_comments' using errcode = 'NS400', detail = 'an array of at most 100 comments';
  end if;

  with src as (
    select distinct on (e ->> 'youtube_comment_id')
           e ->> 'youtube_comment_id' as yid,
           nullif(public.inbox_clean_text(e ->> 'author', 100), '') as author,
           public.inbox_clean_text(e ->> 'text', 2000) as body,
           public.inbox_parse_ts(e ->> 'published_at') as published_at,
           case when (e ->> 'category') in ('question', 'topic_request', 'praise', 'criticism', 'spam', 'off_topic')
                then e ->> 'category' end as category,
           case when (e ->> 'sentiment') in ('positive', 'negative', 'neutral', 'mixed')
                then e ->> 'sentiment' end as sentiment,
           coalesce((e ->> 'flagged') = 'true', false) as flagged
      from jsonb_array_elements(p_comments) e
     where jsonb_typeof(e) = 'object'
       and (e ->> 'youtube_comment_id') ~ '^[A-Za-z0-9_.-]{5,128}$'
     order by e ->> 'youtube_comment_id'
  ), ins as (
    insert into public.inbox_comments
      (channel_id, video_id, youtube_comment_id, author_name, body, published_at, category, sentiment, flagged_injection,
       classify_attempts)
    select p_channel, p_video, s.yid, s.author, s.body, s.published_at, s.category, s.sentiment, s.flagged,
           case when s.category is null then 1 else 0 end
      from src s
     where char_length(s.body) >= 1
    on conflict (channel_id, youtube_comment_id) do update
       set category = coalesce(public.inbox_comments.category, excluded.category),
           sentiment = coalesce(public.inbox_comments.sentiment, excluded.sentiment),
           flagged_injection = public.inbox_comments.flagged_injection or excluded.flagged_injection,
           -- Each visit that still has no answer for it is one more try, at most three (BR-L-124).
           classify_attempts = case when public.inbox_comments.category is null and excluded.category is null
                                    then least(public.inbox_comments.classify_attempts + 1, 3)
                                    else public.inbox_comments.classify_attempts end,
           updated_at = now()
     where (public.inbox_comments.category is null and excluded.category is not null)
        or (excluded.flagged_injection and not public.inbox_comments.flagged_injection)
        or (public.inbox_comments.category is null and excluded.category is null
            and public.inbox_comments.classify_attempts < 3)
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into n from ins;

  -- Bounded retention: a comment nobody acted on in 30 days goes (stored YouTube
  -- data is refreshed or removed, never kept stale).
  delete from public.inbox_comments c
   where c.channel_id = p_channel and c.status in ('open', 'dismissed')
     and c.fetched_at < now() - interval '30 days'
     and not exists (select 1 from public.reply_drafts d where d.comment_id = c.id
                      and d.status in ('pending', 'drafting', 'ready'))
     and not exists (select 1 from public.reply_intents i where i.comment_id = c.id);
  return coalesce(n, 0);
end
$$;

create or replace function public.inbox_comments_to_classify(p_channel text, p_ids text[])
  returns text[]
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may ask this' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_ids), 0) > 100 then
    raise exception 'invalid_comments' using errcode = 'NS400', detail = 'at most 100 ids';
  end if;
  return coalesce((
    select array_agg(q.i order by q.i)
      from (select distinct x as i from unnest(coalesce(p_ids, '{}'::text[])) x
             where x ~ '^[A-Za-z0-9_.-]{5,128}$'
               and not exists (select 1 from public.inbox_comments c
                                where c.channel_id = p_channel and c.youtube_comment_id = x
                                  and (c.category is not null or c.classify_attempts >= 3))) q), '{}'::text[]);
end
$$;

create or replace function public.claim_reply_post(p_worker text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  p       public.reply_posts;
  i       public.reply_intents;
  skipped uuid[] := '{}';
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may claim a reply' using errcode = '42501';
  end if;
  if coalesce(p_worker, '') !~ '^[A-Za-z0-9._:-]{1,80}$' then
    raise exception 'invalid worker' using errcode = '22023';
  end if;
  -- The platform's daily YouTube quota for this feature (BR-L-071): replies wait
  -- queued while it is used up, and one costs 50 units plus its channel check.
  if public.inbox_quota_remaining() < 60 then
    -- Said on the card, not left silent: the approved replies are waiting for quota.
    update public.reply_posts set wait_reason = 'quota', updated_at = now()
     where status = 'queued' and wait_reason is distinct from 'quota';
    return null;
  end if;
  loop
    select * into p from public.reply_posts x
     where (x.status = 'queued'
            or (x.status = 'posting' and x.claimed_at < now() - interval '15 minutes'))
       and x.id <> all (skipped)
     order by x.created_at
     limit 1
     for update skip locked;
    if not found then
      return null;
    end if;
    select * into i from public.reply_intents where id = p.intent_id;
    -- Readiness is asked again NOW, not only at approval (BR-L-070): a connection
    -- revoked, or reconnected without the comment scope, since the approval stops
    -- the reply here. A person re-queues it after reconnecting.
    if not public.inbox_channel_ready(i.channel_id) then
      update public.reply_posts
         set status = 'failed', error_code = 'channel_not_ready', worker_id = null, wait_reason = null,
             error_detail = 'the channel is no longer connected with permission to reply: reconnect it',
             finished_at = now(), updated_at = now()
       where id = p.id;
      perform public.inbox_log(p.channel_id, p.comment_id, null, 'reply_failed',
        jsonb_build_object('code', 'channel_not_ready', 'attempts', p.attempts));
      continue;
    end if;
    -- One organization's share of the day's quota (BR-L-121): when it is used up, this post waits
    -- (visibly) and the next organization's post is looked at.
    if public.inbox_org_quota_left(i.channel_id) < 60 then
      update public.reply_posts set wait_reason = 'quota', updated_at = now()
       where id = p.id and wait_reason is distinct from 'quota';
      skipped := skipped || p.id;
      continue;
    end if;
    update public.reply_posts
       set status = 'posting', worker_id = p_worker, claimed_at = now(), attempts = attempts + 1,
           wait_reason = null, updated_at = now()
     where id = p.id;
    return jsonb_build_object(
      'post_id', p.id, 'intent_id', i.id, 'channel_id', i.channel_id, 'video_id', i.video_id,
      'parent_id', i.youtube_comment_id, 'body', i.body,
      'reconcile', p.submitted_at is not null, 'submitted_at', p.submitted_at, 'attempts', p.attempts + 1);
  end loop;
end
$$;

-- 4. Privileges -----------------------------------------------------------------------------

revoke all on function public.inbox_org_quota_left(text) from public, anon, authenticated, service_role;
revoke all on function public.inbox_channel_quota_left(text) from public, anon, authenticated, service_role;
grant execute on function public.inbox_channel_quota_left(text) to service_role;
revoke all on function public.set_inbox_org_share(integer) from public, anon, authenticated, service_role;
grant execute on function public.set_inbox_org_share(integer) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Verify (run after applying; every column should read true)
-- ---------------------------------------------------------------------------------------------
-- select
--   has_function_privilege('authenticated', 'public.set_inbox_org_share(integer)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.set_inbox_org_share(integer)', 'EXECUTE')
--     and has_function_privilege('service_role', 'public.inbox_channel_quota_left(text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.inbox_channel_quota_left(text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.inbox_org_quota_left(text)', 'EXECUTE') as functions_scoped,
--   (select count(*) = 0 from pg_proc p
--     where p.proname in ('inbox_org_quota_left', 'inbox_channel_quota_left', 'set_inbox_org_share',
--                         'inbox_clean_text', 'inbox_draft_block', 'quote_reply_draft', 'request_reply_draft',
--                         'approve_reply', 'store_inbox_comments', 'inbox_comments_to_classify', 'claim_reply_post')
--       and p.prosecdef and not (p.proconfig::text like '%search_path%')) as definer_pinned,
--   (select org_share_percent from public.inbox_settings where id) between 1 and 100 as share_set;
