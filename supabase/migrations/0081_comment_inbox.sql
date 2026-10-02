-- 0081_comment_inbox.sql — the comment inbox: YouTube comments the pipeline
-- already reads, a drafted reply in the channel's tone, and a PERSON who
-- approves, edits or discards it. Nothing replies on its own (brief B7,
-- docs/product/GAP_ANALYSIS.md; the first "AI Manager" step).
--
-- THE RULES THIS FILE ENFORCES
--   1. A reply is posted only after an explicit, per-reply approval by a
--      signed-in editor of the channel's organization. approve_reply() is the
--      only way a reply_intents row comes to exist; it records WHO approved
--      WHICH text; the worker posts exactly that text and nothing else.
--      A draft, a model's answer or a comment can never create an intent.
--   2. An intent is APPEND-ONLY: nobody (the service key and the database
--      owner included) can edit or delete one — a trigger refuses. What
--      happens to it afterwards lives in reply_posts, one row per intent.
--   3. A reply is posted ONCE. One intent per draft and one intent per
--      comment (unique), one post per intent (unique). The worker marks
--      "submitting" BEFORE the one billable-quota call; a post that was
--      claimed again after that point is first checked against what the
--      channel already says on YouTube (the worker's reconcile) and is never
--      re-sent blind. A person's "retry" only re-queues a failed post.
--   4. Comment text is hostile input. It is stored cleaned (control and
--      direction-override characters removed, 2000 characters at most, author
--      name 100), it is data in every prompt (modules/comment_replies.py),
--      and the database refuses to draft for a comment the classifier called
--      spam, flagged as an attempt to instruct the model, or never classified.
--   5. Everything is scoped by channel -> organization through RLS (members
--      read their own organization's rows; nobody else's, anon none). No API
--      role writes a table: every write is a function below. The worker's
--      functions are executable by the service role only.
--   6. Drafting is the only thing that costs, and only if the platform sells
--      it: the price is the credit_prices row `reply_draft` (NEVER seeded
--      here). No row = 'unpriced' = nothing can be drafted, nothing held
--      (CLAUDE.md #5: unknown is never 0). With a price: quote -> the press
--      carries max_credits and one idempotency key -> hold (= the quote) ->
--      the worker drafts -> capture <= hold on a draft the person can use,
--      full release on every failure. The browser never sees the margin.
--   7. Posting uses the connected channel's own OAuth only (0022's Vault
--      token, or the operator's GitHub-secret token) and only if that token
--      was granted youtube.force-ssl, which 0022 already allows — no new
--      scope. approve_reply refuses a channel whose token is revoked or lacks
--      the scope ('channel_not_ready'). Quota: one reply costs 50 units, so a
--      channel may approve at most 40 replies a day (and request at most 200
--      drafts); a quota refusal from YouTube is recorded as 'quota_exceeded'.
--
-- WHAT IT ADDS (all new; nothing existing is replaced)
--   inbox_comments   one comment on one of the channel's videos, as stored
--   reply_drafts     one drafted reply: pending -> drafting -> ready ->
--                    approved | discarded | failed (+ the hold that paid)
--   reply_intents    the append-only record of an approval
--   reply_posts      the posting state of an intent (queued -> posting ->
--                    posted | failed) and the YouTube id of the reply
--   inbox_events     append-only audit trail of every person and worker step
--   browser:  quote_reply_draft, request_reply_draft, edit_reply_draft,
--             discard_reply_draft, approve_reply, retry_reply_post,
--             dismiss_inbox_comment                          (authenticated)
--   worker:   store_inbox_comments, claim_reply_draft, store_reply_draft,
--             fail_reply_draft, expire_reply_drafts, claim_reply_post,
--             mark_reply_submitting, finish_reply_post         (service role)
--   internal: inbox_clean_text, inbox_url_like, inbox_channel_ready,
--             inbox_daily_cap, inbox_draft_block, inbox_log, reply_draft_price
--
-- WHO MAY DO WHAT (customer words: "member of this organization")
--   read (the five tables)   members of the channel's organization, viewers
--                            included, and platform admins (0018 makes them
--                            members of every organization)
--   quote                    members; may_start only for an editor
--   draft / edit / discard / approve / retry / dismiss
--                            editors and above of the channel's organization;
--                            in the operator's own (credits-exempt) organization
--                            only a platform admin may start a draft, as 0036
--   another organization's comment, draft or post reads as not found (P0002),
--   never as forbidden: an id never confirms what exists elsewhere.
--
-- ERRORS (SQLSTATE; the message is the machine code the app maps,
-- command-center/lib/comment-inbox.ts mapInboxError)
--   42501 forbidden · P0002 not_found
--   NS400 unpriced | not_draftable (detail = the reason) | invalid_body |
--         unsafe_draft | invalid_idempotency_key | invalid_video
--   22023 price_required (detail credits=…)
--   NS409 price_changed | idempotency_conflict | in_progress | draft_exists |
--         already_replied | not_editable | not_approvable | comment_closed |
--         channel_not_ready | not_retryable | lost
--   NS429 daily_limit · NS402 insufficient credits (0020) · NS429 run limit (0034)
--
-- REQUIRES 0018 (organizations), 0020 (credits), 0022 (channel tokens), 0036
-- (creative_platform_reserve / _release, creative_refuse) and 0056 (channel
-- tone). Additive and idempotent: guarded creates, drop-then-create policies
-- and triggers, create-or-replace functions, revoke-then-grant. Safe to apply twice.

do $$
begin
  if to_regprocedure('public.is_org_member(uuid, text)') is null
     or to_regprocedure('public.accessible_channel_ids(text)') is null
     or to_regprocedure('public.channel_org(text)') is null
     or to_regprocedure('public.default_org_id()') is null then
    raise exception '0081 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regprocedure('public.reserve_credits(uuid, text, numeric)') is null
     or to_regprocedure('public.capture_credits(text, numeric, boolean)') is null
     or to_regprocedure('public.start_credit_reservation(text, uuid)') is null
     or to_regprocedure('public.credit_account_lock(uuid)') is null
     or to_regprocedure('public.credits_trusted_caller()') is null then
    raise exception '0081 needs credits: apply 0020_credits.sql first';
  end if;
  if to_regclass('public.channel_token_refs') is null then
    raise exception '0081 needs channel tokens: apply 0022_channel_tokens.sql first';
  end if;
  if to_regprocedure('public.creative_platform_reserve(uuid, text, numeric)') is null
     or to_regprocedure('public.creative_platform_release(text)') is null
     or to_regprocedure('public.creative_refuse(text, text, text)') is null then
    raise exception '0081 needs creative jobs: apply 0036_creative_jobs.sql first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'channels' and column_name = 'dna_tone') then
    raise exception '0081 needs Channel DNA: apply 0056_channel_dna.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.inbox_comments (
  id                 uuid primary key default gen_random_uuid(),
  channel_id         text not null references public.channels (channel_id) on update cascade on delete cascade,
  video_id           text not null check (video_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  youtube_comment_id text not null check (youtube_comment_id ~ '^[A-Za-z0-9_.-]{5,128}$'),
  -- A display name anyone chose: cleaned, 100 characters at most, shown as text.
  author_name        text check (author_name is null or char_length(author_name) between 1 and 100),
  -- Audience text, cleaned by inbox_clean_text: at most 2000 characters.
  body               text not null check (char_length(body) between 1 and 2000),
  published_at       timestamptz,
  -- null = the classifier did not run or did not answer: such a comment is
  -- never drafted for (a missed injection check is not a pass).
  category           text check (category is null or category in
                       ('question', 'topic_request', 'praise', 'criticism', 'spam', 'off_topic')),
  sentiment          text check (sentiment is null or sentiment in ('positive', 'negative', 'neutral', 'mixed')),
  flagged_injection  boolean not null default false,
  status             text not null default 'open' check (status in ('open', 'dismissed', 'replied')),
  fetched_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint inbox_comments_channel_comment_key unique (channel_id, youtube_comment_id),
  constraint inbox_comments_id_channel_key unique (id, channel_id)
);

create index if not exists inbox_comments_channel_idx
  on public.inbox_comments (channel_id, status, published_at desc nulls last);

comment on table public.inbox_comments is
  'Comment inbox (migration 0081): one top-level YouTube comment on a channel''s video, stored cleaned (hostile input). Written only by store_inbox_comments (service role) and the person''s dismiss/restore.';

create table if not exists public.reply_drafts (
  id              uuid primary key default gen_random_uuid(),
  comment_id      uuid not null,
  channel_id      text not null,
  status          text not null default 'pending'
                  check (status in ('pending', 'drafting', 'ready', 'approved', 'discarded', 'failed')),
  body            text check (body is null or char_length(body) between 1 and 500),
  -- The draft exactly as it was drafted, kept for the record when the person edits.
  drafted_body    text check (drafted_body is null or char_length(drafted_body) between 1 and 500),
  edited          boolean not null default false,
  quoted_credits  numeric not null default 0 check (quoted_credits >= 0),
  charged_credits numeric check (charged_credits is null or charged_credits >= 0),
  -- The 0020 hold (rd:<id>) that pays for this draft; null when nothing was held.
  credit_ref      text,
  idempotency_key text check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9_:.-]{8,128}$'),
  request_hash    text,
  requested_by    uuid not null,
  worker_id       text,
  claimed_at      timestamptz,
  error_code      text check (error_code is null or error_code ~ '^[a-z_]{1,48}$'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  finished_at     timestamptz,
  expires_at      timestamptz not null default (now() + interval '2 hours'),
  constraint reply_drafts_comment_fkey foreign key (comment_id, channel_id)
    references public.inbox_comments (id, channel_id) on delete cascade,
  constraint reply_drafts_ready_has_body check (status not in ('ready', 'approved') or body is not null)
);

-- One draft in flight (or waiting for a decision) per comment.
create unique index if not exists reply_drafts_one_live_key
  on public.reply_drafts (comment_id) where status in ('pending', 'drafting', 'ready');
create unique index if not exists reply_drafts_idem_key
  on public.reply_drafts (channel_id, idempotency_key) where idempotency_key is not null;
create index if not exists reply_drafts_queue_idx
  on public.reply_drafts (created_at) where status in ('pending', 'drafting');

comment on table public.reply_drafts is
  'Comment inbox (migration 0081): a drafted reply. Written only by the request/edit/discard/approve functions and the worker''s claim/store/fail functions. A draft is never posted: approve_reply files an intent.';

-- The record of an approval. No foreign keys on purpose: an audit row must
-- outlive the comment, the draft and the channel it names (the trigger below
-- would refuse the cascade that deleting any of them would run).
create table if not exists public.reply_intents (
  id                 uuid primary key default gen_random_uuid(),
  channel_id         text not null,
  comment_id         uuid not null,
  draft_id           uuid not null,
  video_id           text not null,
  youtube_comment_id text not null,
  -- THE text that is posted: what the person approved, character for character.
  body               text not null check (char_length(body) between 1 and 500),
  drafted_body       text,
  edited             boolean not null,
  approved_by        uuid not null,
  approved_by_email  text,
  approved_at        timestamptz not null default now(),
  constraint reply_intents_draft_key unique (draft_id),
  constraint reply_intents_comment_key unique (comment_id)
);

create index if not exists reply_intents_channel_idx on public.reply_intents (channel_id, approved_at desc);

comment on table public.reply_intents is
  'Comment inbox (migration 0081): who approved which reply text, append-only (update, delete and truncate are refused for every role). Written only by approve_reply.';

create table if not exists public.reply_posts (
  id               uuid primary key default gen_random_uuid(),
  intent_id        uuid not null unique references public.reply_intents (id),
  channel_id       text not null,
  comment_id       uuid not null,
  status           text not null default 'queued' check (status in ('queued', 'posting', 'posted', 'failed')),
  attempts         integer not null default 0,
  worker_id        text,
  claimed_at       timestamptz,
  -- Set right BEFORE the comments.insert call: a post claimed again with this
  -- set is reconciled against YouTube first, never re-sent blind.
  submitted_at     timestamptz,
  youtube_reply_id text check (youtube_reply_id is null or youtube_reply_id ~ '^[A-Za-z0-9_.-]{5,128}$'),
  error_code       text check (error_code is null or error_code in
                     ('quota_exceeded', 'rate_limited', 'token_expired', 'missing_scope', 'comment_gone',
                      'comments_disabled', 'forbidden', 'platform_error', 'outcome_unknown',
                      'channel_not_ready', 'invalid_reply')),
  -- Our own words only (an HTTP status, a reason word): never a response body.
  error_detail     text check (error_detail is null or char_length(error_detail) <= 300),
  quota_units      integer not null default 0 check (quota_units between 0 and 1000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  finished_at      timestamptz,
  constraint reply_posts_posted_check check ((status = 'posted') = (youtube_reply_id is not null)),
  constraint reply_posts_failed_check check ((status = 'failed') = (error_code is not null))
);

create index if not exists reply_posts_queue_idx
  on public.reply_posts (created_at) where status in ('queued', 'posting');
create index if not exists reply_posts_channel_idx on public.reply_posts (channel_id, created_at desc);

comment on table public.reply_posts is
  'Comment inbox (migration 0081): the posting state of an approved reply (one row per intent). Written only by approve_reply, retry_reply_post and the worker''s claim/mark/finish functions.';

create table if not exists public.inbox_events (
  id          bigint generated always as identity primary key,
  channel_id  text not null,
  comment_id  uuid,
  draft_id    uuid,
  actor       uuid,
  actor_email text,
  action      text not null check (action in
                ('draft_requested', 'draft_ready', 'draft_failed', 'draft_edited', 'draft_discarded',
                 'reply_approved', 'reply_posted', 'reply_failed', 'post_retried',
                 'comment_dismissed', 'comment_restored')),
  detail      jsonb check (detail is null or (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 1024)),
  at          timestamptz not null default now()
);

create index if not exists inbox_events_channel_idx on public.inbox_events (channel_id, at desc);

comment on table public.inbox_events is
  'Comment inbox (migration 0081): append-only audit trail. actor is the signed-in person, null for the worker. detail names facts (codes, counts), never comment or reply text.';

-- Append-only: refused for every role, the service key and the owner included.
create or replace function public.inbox_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'append_only' using errcode = '42501',
    detail = format('%s rows are never changed or removed', tg_table_name);
end
$$;

drop trigger if exists reply_intents_append_only on public.reply_intents;
create trigger reply_intents_append_only
  before update or delete on public.reply_intents
  for each row execute function public.inbox_append_only();
drop trigger if exists reply_intents_no_truncate on public.reply_intents;
create trigger reply_intents_no_truncate
  before truncate on public.reply_intents
  for each statement execute function public.inbox_append_only();

drop trigger if exists inbox_events_append_only on public.inbox_events;
create trigger inbox_events_append_only
  before update or delete on public.inbox_events
  for each row execute function public.inbox_append_only();
drop trigger if exists inbox_events_no_truncate on public.inbox_events;
create trigger inbox_events_no_truncate
  before truncate on public.inbox_events
  for each statement execute function public.inbox_append_only();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Internal helpers (executable by no API role)
-- ───────────────────────────────────────────────────────────────────────────

-- Text from outside, made safe to store and show: control characters (newline
-- kept), zero-width and direction-override characters removed, trimmed, cut.
create or replace function public.inbox_clean_text(p_text text, p_max integer) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select left(btrim(
           regexp_replace(
             regexp_replace(replace(coalesce(p_text, ''), E'\r\n', E'\n'),
                            E'[\\x01-\\x09\\x0b-\\x1f\\x7f]', '', 'g'),
             '[' || chr(128) || '-' || chr(159) || chr(8203) || '-' || chr(8207)
                 || chr(8234) || '-' || chr(8238) || chr(8294) || '-' || chr(8297) || chr(65279) || ']',
             '', 'g')), greatest(coalesce(p_max, 0), 0))
$$;

-- A link in a drafted reply. A model's answer to a hostile comment is the one
-- place a link could be smuggled in; the worker refuses it too.
create or replace function public.inbox_url_like(p_text text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_text, '') ~* '(https?:|www\.|://)'
$$;

-- Per channel, per rolling day. A reply costs 50 quota units of YouTube's
-- 10,000 a day, shared with uploads (CLAUDE.md known ceilings).
create or replace function public.inbox_daily_cap(p_kind text) returns integer
  language sql immutable set search_path = public, pg_temp as $$
  select case p_kind when 'reply' then 40 when 'draft' then 200 else 0 end
$$;

-- May a reply be posted as this channel? The token is the channel's own, active,
-- and was granted youtube.force-ssl. The operator's own channels keep their
-- GitHub-secret token (0022), which the database cannot see: the worker checks
-- its scope when it posts and records 'missing_scope'.
create or replace function public.inbox_channel_ready(p_channel text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.channels c
     where c.channel_id = p_channel
       and (c.org_id = public.default_org_id()
            or exists (select 1 from public.channel_token_refs r
                        where r.channel_id = c.channel_id and r.revoked_at is null
                          and 'https://www.googleapis.com/auth/youtube.force-ssl' = any (r.scopes))))
$$;

-- Why a comment cannot be drafted for now; null when it can.
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
  if c.status = 'replied' or exists (select 1 from public.reply_intents i where i.comment_id = c.id) then
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

create or replace function public.inbox_log(
  p_channel text, p_comment uuid, p_draft uuid, p_action text, p_detail jsonb default null
) returns void
  language sql security definer set search_path = public, pg_temp as $$
  insert into public.inbox_events (channel_id, comment_id, draft_id, actor, actor_email, action, detail)
  values (p_channel, p_comment, p_draft, auth.uid(), nullif(auth.jwt() ->> 'email', ''), p_action, p_detail)
$$;

-- The price of one reply draft, as charged (margin folded in, then 0020's
-- job_minimum floor like every other priced job). NULL = no `reply_draft` row
-- in credit_prices = unpriced = the feature is blocked. Never seeded here.
create or replace function public.reply_draft_price() returns numeric
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  rate    public.credit_prices;
  floor_c numeric;
  price   numeric;
  minimum numeric := 0;
begin
  select * into rate from public.credit_prices where unit = 'reply_draft';
  if rate.unit is null then
    return null;
  end if;
  price := public.credits_round_up(round(rate.credits_per_unit * (1 + rate.margin), 6));
  select credits_per_unit into floor_c from public.credit_prices where unit = 'job_minimum';
  if floor_c is not null then
    minimum := public.credits_round_up(floor_c);
  end if;
  if price > 0 then
    price := greatest(price, minimum);
  end if;
  return price;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The person's functions (authenticated)
-- ───────────────────────────────────────────────────────────────────────────

-- What drafting this comment would cost, and whether it can be drafted. Free.
-- Never returns the margin or the unit rate: only the credits the person pays.
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
                 and (not public.credits_exempt(org) or public.is_platform_admin()),
    'reply_ready', public.inbox_channel_ready(c.channel_id));
end
$$;

-- The priced press: one transaction — who, the state of the comment, the
-- re-quote (a higher price is price_changed and nothing is held), the hold
-- (= the quote), the draft row. The same idempotency key again returns the
-- first draft and holds nothing more.
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

-- The person changes the words of a draft that is ready. Free. The result is
-- stored cleaned; it is still only a draft until approve_reply.
create or replace function public.edit_reply_draft(p_draft uuid, p_body text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  d    public.reply_drafts;
  org  uuid;
  txt  text := public.inbox_clean_text(p_body, 500);
begin
  if auth.uid() is null then
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
  select * into d from public.reply_drafts where id = p_draft for update;
  if d.status <> 'ready' then
    perform public.creative_refuse('not_editable', 'only a draft that is ready can be edited', 'NS409');
  end if;
  if char_length(txt) < 1 then
    perform public.creative_refuse('invalid_body', 'a reply cannot be empty');
  end if;
  update public.reply_drafts
     set body = txt, edited = (txt is distinct from drafted_body), updated_at = now()
   where id = p_draft
  returning * into d;
  perform public.inbox_log(d.channel_id, d.comment_id, d.id, 'draft_edited',
    jsonb_build_object('chars', char_length(txt)));
  return jsonb_build_object('id', d.id, 'status', d.status, 'body', d.body, 'edited', d.edited);
end
$$;

-- The person throws a ready draft away. Nothing is refunded (it was made); a
-- new draft is a new, priced press. A draft in flight cannot be discarded: its
-- hold settles when the worker is done.
create or replace function public.discard_reply_draft(p_draft uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  d   public.reply_drafts;
  org uuid;
begin
  if auth.uid() is null then
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
  select * into d from public.reply_drafts where id = p_draft for update;
  if d.status = 'discarded' then
    return jsonb_build_object('id', d.id, 'status', d.status, 'already', true);
  end if;
  if d.status in ('pending', 'drafting') then
    perform public.creative_refuse('in_progress', 'the draft is still being written', 'NS409');
  end if;
  if d.status <> 'ready' then
    perform public.creative_refuse('not_editable', 'only a draft that is ready can be discarded', 'NS409');
  end if;
  update public.reply_drafts set status = 'discarded', finished_at = now(), updated_at = now()
   where id = p_draft returning * into d;
  perform public.inbox_log(d.channel_id, d.comment_id, d.id, 'draft_discarded');
  return jsonb_build_object('id', d.id, 'status', d.status, 'already', false);
end
$$;

-- THE approval. The person sends the exact text they are looking at; that
-- text (cleaned) is the intent, and the only thing the worker will post. One
-- transaction: the intent, the queued post, the draft marked approved, the
-- audit event. A second call for the same draft returns the first intent and
-- files nothing.
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
  -- Locked only once the caller is known to be allowed.
  select * into d from public.reply_drafts where id = p_draft for update;

  select * into i from public.reply_intents where draft_id = d.id;
  if found then
    select * into p from public.reply_posts where intent_id = i.id;
    return jsonb_build_object('intent_id', i.id, 'post_id', p.id, 'status', p.status, 'replay', true);
  end if;

  if d.status <> 'ready' then
    perform public.creative_refuse('not_approvable', format('status=%s', d.status), 'NS409');
  end if;
  select * into c from public.inbox_comments where id = d.comment_id for update;
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

-- A person re-queues a post that failed for a reason that may pass (quota
-- tomorrow, a reconnected channel). The worker reconciles first when the
-- earlier attempt may have reached YouTube, so this can never double-post.
create or replace function public.retry_reply_post(p_post uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  p   public.reply_posts;
  org uuid;
  was text;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into p from public.reply_posts where id = p_post;
  if found then
    org := public.channel_org(p.channel_id);
  end if;
  if not found or org is null or not public.is_org_member(org) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into p from public.reply_posts where id = p_post for update;
  if p.status = 'queued' or p.status = 'posting' then
    return jsonb_build_object('id', p.id, 'status', p.status, 'already', true);
  end if;
  if p.status <> 'failed'
     or p.error_code not in ('quota_exceeded', 'rate_limited', 'token_expired', 'missing_scope',
                             'platform_error', 'outcome_unknown', 'channel_not_ready') then
    perform public.creative_refuse('not_retryable', format('status=%s', p.status), 'NS409');
  end if;
  was := p.error_code;
  update public.reply_posts
     set status = 'queued', error_code = null, error_detail = null, worker_id = null,
         finished_at = null, updated_at = now()
   where id = p_post returning * into p;
  perform public.inbox_log(p.channel_id, p.comment_id, null, 'post_retried', jsonb_build_object('was', was));
  return jsonb_build_object('id', p.id, 'status', p.status, 'already', false);
end
$$;

-- Put a comment aside (and bring it back). A comment with an approved reply
-- cannot be put aside; one with a draft being written waits for it; a ready
-- draft is discarded with it.
create or replace function public.dismiss_inbox_comment(p_comment uuid, p_dismissed boolean default true)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  c   public.inbox_comments;
  org uuid;
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
  if not public.is_org_member(org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into c from public.inbox_comments where id = p_comment for update;
  if c.status = 'replied' or exists (select 1 from public.reply_intents i where i.comment_id = c.id) then
    perform public.creative_refuse('already_replied', 'this comment already has an approved reply', 'NS409');
  end if;
  if coalesce(p_dismissed, true) then
    if c.status = 'dismissed' then
      return jsonb_build_object('id', c.id, 'status', c.status, 'already', true);
    end if;
    if exists (select 1 from public.reply_drafts d where d.comment_id = c.id and d.status in ('pending', 'drafting')) then
      perform public.creative_refuse('in_progress', 'a draft is being written for this comment', 'NS409');
    end if;
    update public.reply_drafts set status = 'discarded', finished_at = now(), updated_at = now()
     where comment_id = c.id and status = 'ready';
    update public.inbox_comments set status = 'dismissed', updated_at = now() where id = c.id returning * into c;
    perform public.inbox_log(c.channel_id, c.id, null, 'comment_dismissed');
  else
    if c.status = 'open' then
      return jsonb_build_object('id', c.id, 'status', c.status, 'already', true);
    end if;
    update public.inbox_comments set status = 'open', updated_at = now() where id = c.id returning * into c;
    perform public.inbox_log(c.channel_id, c.id, null, 'comment_restored');
  end if;
  return jsonb_build_object('id', c.id, 'status', c.status, 'already', false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The worker's functions (service role only)
-- ───────────────────────────────────────────────────────────────────────────

-- Store comments the worker fetched for one of the channel's own videos. The
-- organization is the channel's, never the caller's input. Every field is
-- cleaned and bounded here again: the worker is not trusted with hostile text.
-- A known comment keeps its text; only a missing classification is filled in.
-- Returns how many comments were new. Old untouched comments are pruned.
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
           case when (e ->> 'published_at') ~ '^\d{4}-\d{2}-\d{2}[T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?$'
                then (e ->> 'published_at')::timestamptz end as published_at,
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
      (channel_id, video_id, youtube_comment_id, author_name, body, published_at, category, sentiment, flagged_injection)
    select p_channel, p_video, s.yid, s.author, s.body, s.published_at, s.category, s.sentiment, s.flagged
      from src s
     where char_length(s.body) >= 1
    on conflict (channel_id, youtube_comment_id) do update
       set category = coalesce(public.inbox_comments.category, excluded.category),
           sentiment = coalesce(public.inbox_comments.sentiment, excluded.sentiment),
           flagged_injection = public.inbox_comments.flagged_injection or excluded.flagged_injection,
           updated_at = now()
     where (public.inbox_comments.category is null and excluded.category is not null)
        or (excluded.flagged_injection and not public.inbox_comments.flagged_injection)
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into n from ins;

  -- Bounded retention: a comment nobody acted on in 90 days goes.
  delete from public.inbox_comments c
   where c.channel_id = p_channel and c.status in ('open', 'dismissed')
     and c.fetched_at < now() - interval '90 days'
     and not exists (select 1 from public.reply_drafts d where d.comment_id = c.id)
     and not exists (select 1 from public.reply_intents i where i.comment_id = c.id);
  return coalesce(n, 0);
end
$$;

-- The worker takes the oldest pending draft (or one whose worker died) and
-- gets the MINIMUM it needs: the cleaned comment, the video title, the
-- channel's tone line and language. No id of another table, no credential.
create or replace function public.claim_reply_draft(p_worker text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  d    public.reply_drafts;
  c    public.inbox_comments;
  ch   public.channels;
  held numeric;
  title_ text;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may claim a draft' using errcode = '42501';
  end if;
  if coalesce(p_worker, '') !~ '^[A-Za-z0-9._:-]{1,80}$' then
    raise exception 'invalid worker' using errcode = '22023';
  end if;
  select * into d from public.reply_drafts x
   where x.status = 'pending'
      or (x.status = 'drafting' and x.claimed_at < now() - interval '10 minutes')
   order by x.created_at
   limit 1
   for update skip locked;
  if not found then
    return null;
  end if;
  if d.credit_ref is not null and d.status = 'pending' then
    held := public.start_credit_reservation(d.credit_ref, public.channel_org(d.channel_id));
    if held is null then
      -- The hold is gone (released or expired): nothing may be drafted on it.
      update public.reply_drafts
         set status = 'failed', error_code = 'hold_lost', charged_credits = 0,
             finished_at = now(), updated_at = now()
       where id = d.id;
      perform public.inbox_log(d.channel_id, d.comment_id, d.id, 'draft_failed',
        jsonb_build_object('code', 'hold_lost'));
      return null;
    end if;
  end if;
  select * into c from public.inbox_comments where id = d.comment_id;
  -- Re-checked at the last moment: whatever the state when it was requested,
  -- a spam, flagged or unclassified comment is never given to a model.
  if not found or c.flagged_injection or c.category is null or c.category = 'spam' or c.status <> 'open' then
    update public.reply_drafts
       set status = 'failed', error_code = 'not_draftable', charged_credits = 0,
           finished_at = now(), updated_at = now()
     where id = d.id;
    if d.credit_ref is not null then
      perform public.credit_account_lock(public.channel_org(d.channel_id));
      perform public.creative_platform_release(d.credit_ref);
    end if;
    perform public.inbox_log(d.channel_id, d.comment_id, d.id, 'draft_failed',
      jsonb_build_object('code', 'not_draftable'));
    return null;
  end if;
  select * into ch from public.channels where channel_id = d.channel_id;
  select v.title into title_ from public.videos v where v.video_id = c.video_id;
  update public.reply_drafts
     set status = 'drafting', worker_id = p_worker, claimed_at = now(), updated_at = now()
   where id = d.id;
  return jsonb_build_object(
    'draft_id', d.id,
    'channel_name', left(coalesce(ch.name, ''), 100),
    'tone', coalesce(ch.dna_tone, ''),
    'language', coalesce(ch.agent_config ->> 'language', ''),
    'video_title', left(coalesce(title_, ''), 200),
    'comment_text', c.body,
    'category', c.category);
end
$$;

-- The worker stores what the model wrote. Cleaned, bounded, never a link; the
-- hold is captured in the same transaction (at most the hold: the quote).
create or replace function public.store_reply_draft(p_draft uuid, p_worker text, p_body text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  d   public.reply_drafts;
  org uuid;
  txt text := public.inbox_clean_text(p_body, 500);
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may store a draft' using errcode = '42501';
  end if;
  select channel_id into d.channel_id from public.reply_drafts where id = p_draft;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  org := public.channel_org(d.channel_id);
  perform public.credit_account_lock(org);
  select * into d from public.reply_drafts where id = p_draft for update;
  if d.status = 'ready' then
    return jsonb_build_object('id', d.id, 'status', d.status, 'replay', true);
  end if;
  if d.status <> 'drafting' or d.worker_id is distinct from p_worker then
    raise exception 'lost' using errcode = 'NS409', detail = 'this worker no longer holds the draft';
  end if;
  if char_length(txt) < 1 then
    raise exception 'invalid_body' using errcode = 'NS400';
  end if;
  if public.inbox_url_like(txt) then
    raise exception 'unsafe_draft' using errcode = 'NS400', detail = 'a drafted reply may not contain a link';
  end if;
  update public.reply_drafts
     set status = 'ready', body = txt, drafted_body = txt, edited = false,
         charged_credits = quoted_credits, finished_at = null, updated_at = now()
   where id = d.id;
  if d.credit_ref is not null then
    perform public.capture_credits(d.credit_ref, d.quoted_credits);
  end if;
  perform public.inbox_log(d.channel_id, d.comment_id, d.id, 'draft_ready',
    jsonb_build_object('chars', char_length(txt), 'charged', d.quoted_credits));
  return jsonb_build_object('id', d.id, 'status', 'ready', 'replay', false);
end
$$;

-- A draft that could not be made: the hold is released in full, in the same
-- transaction, whatever the reason.
create or replace function public.fail_reply_draft(p_draft uuid, p_worker text, p_code text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  d    public.reply_drafts;
  org  uuid;
  code text := coalesce(nullif(p_code, ''), 'failed');
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may fail a draft' using errcode = '42501';
  end if;
  if code !~ '^[a-z_]{1,48}$' then
    code := 'failed';
  end if;
  select channel_id into d.channel_id from public.reply_drafts where id = p_draft;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  org := public.channel_org(d.channel_id);
  perform public.credit_account_lock(org);
  select * into d from public.reply_drafts where id = p_draft for update;
  if d.status in ('failed', 'discarded') then
    return jsonb_build_object('id', d.id, 'status', d.status, 'replay', true);
  end if;
  if d.status not in ('pending', 'drafting')
     or (d.status = 'drafting' and d.worker_id is distinct from p_worker) then
    raise exception 'lost' using errcode = 'NS409', detail = 'this worker no longer holds the draft';
  end if;
  update public.reply_drafts
     set status = 'failed', error_code = code, charged_credits = 0, finished_at = now(), updated_at = now()
   where id = d.id;
  if d.credit_ref is not null then
    perform public.creative_platform_release(d.credit_ref);
  end if;
  perform public.inbox_log(d.channel_id, d.comment_id, d.id, 'draft_failed', jsonb_build_object('code', code));
  return jsonb_build_object('id', d.id, 'status', 'failed', 'replay', false);
end
$$;

-- Drafts nobody picked up, or whose worker died, give their hold back.
create or replace function public.expire_reply_drafts() returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s record;
  n integer := 0;
begin
  if not public.credits_trusted_caller() then
    raise exception 'drafts are expired by the platform only' using errcode = '42501';
  end if;
  for s in
    select x.id, x.channel_id, x.status from public.reply_drafts x
     where (x.status = 'pending' and x.expires_at <= now())
        or (x.status = 'drafting' and x.claimed_at < now() - interval '30 minutes')
     order by x.channel_id, x.id
  loop
    perform public.credit_account_lock(public.channel_org(s.channel_id));
    perform 1 from public.reply_drafts x
     where x.id = s.id and x.status = s.status for update skip locked;
    if found then
      update public.reply_drafts
         set status = 'failed', error_code = case when s.status = 'pending' then 'not_picked_up' else 'worker_lost' end,
             charged_credits = 0, finished_at = now(), updated_at = now()
       where id = s.id;
      perform public.creative_platform_release(
        (select credit_ref from public.reply_drafts where id = s.id));
      perform public.inbox_log(s.channel_id, (select comment_id from public.reply_drafts where id = s.id), s.id,
        'draft_failed', jsonb_build_object('code', 'expired'));
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;

-- The worker takes the oldest approved reply to post (or one whose worker
-- died). It gets the intent's text and the id to reply to — and whether an
-- earlier attempt may already have reached YouTube (reconcile first).
create or replace function public.claim_reply_post(p_worker text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  p public.reply_posts;
  i public.reply_intents;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may claim a reply' using errcode = '42501';
  end if;
  if coalesce(p_worker, '') !~ '^[A-Za-z0-9._:-]{1,80}$' then
    raise exception 'invalid worker' using errcode = '22023';
  end if;
  select * into p from public.reply_posts x
   where x.status = 'queued'
      or (x.status = 'posting' and x.claimed_at < now() - interval '15 minutes')
   order by x.created_at
   limit 1
   for update skip locked;
  if not found then
    return null;
  end if;
  select * into i from public.reply_intents where id = p.intent_id;
  update public.reply_posts
     set status = 'posting', worker_id = p_worker, claimed_at = now(), attempts = attempts + 1, updated_at = now()
   where id = p.id;
  return jsonb_build_object(
    'post_id', p.id, 'intent_id', i.id, 'channel_id', i.channel_id, 'video_id', i.video_id,
    'parent_id', i.youtube_comment_id, 'body', i.body,
    'reconcile', p.submitted_at is not null, 'attempts', p.attempts + 1);
end
$$;

-- Marked right before the one call that spends YouTube quota and can post.
create or replace function public.mark_reply_submitting(p_post uuid, p_worker text) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may mark a reply' using errcode = '42501';
  end if;
  update public.reply_posts
     set submitted_at = now(), updated_at = now()
   where id = p_post and status = 'posting' and worker_id = p_worker;
  return found;
end
$$;

-- The worker's verdict. A reply already recorded as posted is never changed or
-- overwritten (a late failure cannot un-post it, a second success cannot add a
-- second id). A worker that no longer holds the post is refused ('lost').
create or replace function public.finish_reply_post(
  p_post     uuid,
  p_worker   text,
  p_ok       boolean,
  p_reply_id text default null,
  p_code     text default null,
  p_detail   text default null,
  p_units    integer default 0
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  p     public.reply_posts;
  code  text := coalesce(p_code, 'platform_error');
  units integer := least(greatest(coalesce(p_units, 0), 0), 1000);
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may finish a reply' using errcode = '42501';
  end if;
  select * into p from public.reply_posts where id = p_post for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p.status = 'posted' then
    return jsonb_build_object('id', p.id, 'status', p.status, 'replay', true);
  end if;
  if p.status <> 'posting' or p.worker_id is distinct from p_worker then
    raise exception 'lost' using errcode = 'NS409', detail = 'this worker no longer holds the reply';
  end if;
  if coalesce(p_ok, false) then
    if coalesce(p_reply_id, '') !~ '^[A-Za-z0-9_.-]{5,128}$' then
      raise exception 'invalid_reply_id' using errcode = 'NS400';
    end if;
    update public.reply_posts
       set status = 'posted', youtube_reply_id = p_reply_id, error_code = null, error_detail = null,
           quota_units = quota_units + units, finished_at = now(), updated_at = now()
     where id = p.id returning * into p;
    update public.inbox_comments set status = 'replied', updated_at = now() where id = p.comment_id;
    perform public.inbox_log(p.channel_id, p.comment_id, null, 'reply_posted',
      jsonb_build_object('attempts', p.attempts, 'quota_units', p.quota_units));
  else
    if code not in ('quota_exceeded', 'rate_limited', 'token_expired', 'missing_scope', 'comment_gone',
                    'comments_disabled', 'forbidden', 'platform_error', 'outcome_unknown',
                    'channel_not_ready', 'invalid_reply') then
      code := 'platform_error';
    end if;
    update public.reply_posts
       set status = 'failed', error_code = code,
           error_detail = nullif(left(public.inbox_clean_text(p_detail, 300), 300), ''),
           quota_units = quota_units + units, finished_at = now(), updated_at = now()
     where id = p.id returning * into p;
    perform public.inbox_log(p.channel_id, p.comment_id, null, 'reply_failed',
      jsonb_build_object('code', code, 'attempts', p.attempts));
  end if;
  return jsonb_build_object('id', p.id, 'status', p.status, 'replay', false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

alter table public.inbox_comments enable row level security;
alter table public.reply_drafts enable row level security;
alter table public.reply_intents enable row level security;
alter table public.reply_posts enable row level security;
alter table public.inbox_events enable row level security;

-- No API role writes any of these tables, the service key included: every
-- write is one of the functions above.
revoke all on public.inbox_comments from public, anon, authenticated, service_role;
revoke all on public.reply_drafts from public, anon, authenticated, service_role;
revoke all on public.reply_intents from public, anon, authenticated, service_role;
revoke all on public.reply_posts from public, anon, authenticated, service_role;
revoke all on public.inbox_events from public, anon, authenticated, service_role;
grant select on public.inbox_comments to authenticated;
grant select on public.reply_drafts to authenticated;
grant select on public.reply_intents to authenticated;
grant select on public.reply_posts to authenticated;
grant select on public.inbox_events to authenticated;

-- Whoever may see the channel sees its inbox: channels_auth_read's rule.
drop policy if exists inbox_comments_select on public.inbox_comments;
create policy inbox_comments_select on public.inbox_comments
  for select to authenticated
  using (channel_id in (select public.accessible_channel_ids('viewer')));
drop policy if exists reply_drafts_select on public.reply_drafts;
create policy reply_drafts_select on public.reply_drafts
  for select to authenticated
  using (channel_id in (select public.accessible_channel_ids('viewer')));
drop policy if exists reply_intents_select on public.reply_intents;
create policy reply_intents_select on public.reply_intents
  for select to authenticated
  using (channel_id in (select public.accessible_channel_ids('viewer')));
drop policy if exists reply_posts_select on public.reply_posts;
create policy reply_posts_select on public.reply_posts
  for select to authenticated
  using (channel_id in (select public.accessible_channel_ids('viewer')));
drop policy if exists inbox_events_select on public.inbox_events;
create policy inbox_events_select on public.inbox_events
  for select to authenticated
  using (channel_id in (select public.accessible_channel_ids('viewer')));

-- Supabase hands every new function to anon and authenticated; each one is
-- narrowed explicitly. Trigger functions are not callable and need no grant.
revoke all on function public.inbox_append_only() from public, anon, authenticated, service_role;
revoke all on function public.inbox_clean_text(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.inbox_url_like(text) from public, anon, authenticated, service_role;
revoke all on function public.inbox_daily_cap(text) from public, anon, authenticated, service_role;
revoke all on function public.inbox_channel_ready(text) from public, anon, authenticated, service_role;
revoke all on function public.inbox_draft_block(uuid) from public, anon, authenticated, service_role;
revoke all on function public.inbox_log(text, uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.reply_draft_price() from public, anon, authenticated, service_role;

revoke all on function public.quote_reply_draft(uuid) from public, anon, authenticated, service_role;
revoke all on function public.request_reply_draft(uuid, numeric, text) from public, anon, authenticated, service_role;
revoke all on function public.edit_reply_draft(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.discard_reply_draft(uuid) from public, anon, authenticated, service_role;
revoke all on function public.approve_reply(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.retry_reply_post(uuid) from public, anon, authenticated, service_role;
revoke all on function public.dismiss_inbox_comment(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.quote_reply_draft(uuid) to authenticated;
grant execute on function public.request_reply_draft(uuid, numeric, text) to authenticated;
grant execute on function public.edit_reply_draft(uuid, text) to authenticated;
grant execute on function public.discard_reply_draft(uuid) to authenticated;
grant execute on function public.approve_reply(uuid, text) to authenticated;
grant execute on function public.retry_reply_post(uuid) to authenticated;
grant execute on function public.dismiss_inbox_comment(uuid, boolean) to authenticated;

revoke all on function public.store_inbox_comments(text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.claim_reply_draft(text) from public, anon, authenticated, service_role;
revoke all on function public.store_reply_draft(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.fail_reply_draft(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.expire_reply_drafts() from public, anon, authenticated, service_role;
revoke all on function public.claim_reply_post(text) from public, anon, authenticated, service_role;
revoke all on function public.mark_reply_submitting(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.finish_reply_post(uuid, text, boolean, text, text, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.store_inbox_comments(text, text, jsonb) to service_role;
grant execute on function public.claim_reply_draft(text) to service_role;
grant execute on function public.store_reply_draft(uuid, text, text) to service_role;
grant execute on function public.fail_reply_draft(uuid, text, text) to service_role;
grant execute on function public.expire_reply_drafts() to service_role;
grant execute on function public.claim_reply_post(text) to service_role;
grant execute on function public.mark_reply_submitting(uuid, text) to service_role;
grant execute on function public.finish_reply_post(uuid, text, boolean, text, text, text, integer) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select bool_and(relrowsecurity) from pg_class
--     where oid in ('public.inbox_comments'::regclass, 'public.reply_drafts'::regclass,
--                   'public.reply_intents'::regclass, 'public.reply_posts'::regclass,
--                   'public.inbox_events'::regclass)) as rls_on,
--   not has_table_privilege('authenticated', 'public.reply_intents', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.reply_posts', 'UPDATE')
--     and not has_table_privilege('service_role', 'public.reply_drafts', 'UPDATE')
--     and not has_table_privilege('anon', 'public.inbox_comments', 'SELECT') as tables_closed,
--   has_function_privilege('authenticated', 'public.approve_reply(uuid,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.approve_reply(uuid,text)', 'EXECUTE')
--     and has_function_privilege('service_role', 'public.claim_reply_post(text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.claim_reply_post(text)', 'EXECUTE')
--     as functions_scoped,
--   (select count(*) = 0 from pg_proc p
--     where p.proname in ('quote_reply_draft', 'request_reply_draft', 'edit_reply_draft', 'discard_reply_draft',
--                         'approve_reply', 'retry_reply_post', 'dismiss_inbox_comment', 'store_inbox_comments',
--                         'claim_reply_draft', 'store_reply_draft', 'fail_reply_draft', 'expire_reply_drafts',
--                         'claim_reply_post', 'mark_reply_submitting', 'finish_reply_post')
--       and not (p.prosecdef and p.proconfig::text like '%search_path%')) as definer_pinned;
--
-- Informational (not part of the all-true row): drafting stays blocked until the owner sets a price.
-- select count(*) = 0 as drafts_still_unpriced from public.credit_prices where unit = 'reply_draft';
