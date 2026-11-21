-- 0108_marketing_posts.sql — the database half of the brand-channel poster (Telegram first). EVERYTHING
-- IS SWITCHED OFF AND NOTHING CALLS IT. Design: docs/MARKETING_POSTS.md.
--
-- *** APPLYING THIS FILE CHANGES THE LIVE DATABASE. Merging it to main applies it
-- *** automatically, and an applied migration is never edited: fix by a new forward
-- *** migration (docs/MIGRATIONS.md).
--
-- WHAT "DORMANT" MEANS HERE
--   * marketing_settings.enabled is FALSE. While it is false, claim_marketing_post() hands out nothing,
--     whatever is approved. Turning it on is a deliberate act (owner_marketing_kill(false, reason), or one
--     UPDATE in the SQL editor), and both leave a mark.
--   * Nothing in the app, the workers or the workflows calls any new function or reads any new table. The
--     owner page, the Telegram sender and the drafting worker are later changes.
--   * NO existing table, policy, grant, trigger or function is changed, with ONE exception:
--     audit_action_allowed(text) is redefined to ADD eight action names (its whole 0107 list is copied
--     verbatim). Every name it allowed before it still allows.
--   * No trigger is put on an existing table.
--
-- WHAT IT ADDS
--  1. marketing_settings   one row (the primary key is the constant true):
--                            enabled              false   the database kill switch
--                            max_per_7d           2       posts in any rolling 7 days (CHECK 0..2)
--                            facts_max_age_hours  24      how old a price post's facts may be when approved
--                            approval_ttl_hours   72      how long an approval lasts (CHECK 1..72)
--  2. marketing_posts      one row per post: kind news | showcase | price, a target (only 'telegram' for now,
--                          a column so Instagram can come later), the three language texts, the status
--                          machine, the approval (who, when, the hash of exactly what was approved) and the
--                          send record. idempotency_key is unique, so the same thing can never be drafted twice.
--  3. showcase_assets      the explicit "this video is public" list. Closed (no policy, no grant) and limited
--                          to the operator's own organization by a CHECK. The owner functions that fill it
--                          (showcase.mark / showcase.revoke) are a later change.
--  4. The status machine is a TRIGGER, so it holds for every API role, the owner functions and the worker,
--     and it also catches a careless write in the SQL editor. It is NOT a defence against the database owner:
--     a superuser can still disable the trigger, set session_replication_role = replica, or update
--     marketing_settings directly, and so step around the cap and the kill switch. Those two protect against
--     bugs and against every API caller, not against the owner of the database.
--         draft -> approved -> sending -> sent | failed | dead
--         draft -> rejected          draft | approved -> expired
--         approved -> draft          only by an edit (the approval is void), never by a bare status write
--         sending -> approved        only for a request that never left (rate limit, refused connection)
--     Any other move is refused (23514). A draft becomes approved only with the approver, the time and a hash
--     equal to the hash of the content as it stands: kind, target, media, link and the three texts, that is,
--     everything the sender will put in the message. Content cannot change once a post is
--     sending or later; an edit of an approved post sends it back to draft and clears the approval, so what
--     goes out is exactly what the owner saw. Final rows (sent, failed, dead, rejected, expired) are frozen,
--     and no row is ever deleted: a deleted row would also forget its idempotency key and let a news item
--     be drafted again.
--  5. Owner functions (SECURITY DEFINER, search_path pinned, platform owner/admin only; each goes through
--     owner_guard(): signed in, is_platform_admin(), admin_aal_ok(), a per-person rate limit; each writes
--     app_audit_log AND security_events through owner_audit() in the SAME transaction, so an audit that
--     cannot be written stops the change):
--         owner_marketing_get()                       the settings and the week's count (read)
--         owner_marketing_edit(id, texts)             draft or approved; an approved post goes back to draft
--         owner_marketing_approve(id, content_hash)   the hash the owner saw; refuses if the post changed, and
--                                                     refuses (poster_off) while the switch is off, so an
--                                                     approval cannot lapse unsent and burn its news key
--         owner_marketing_reject(id, reason)          draft, or approved (voided first)
--         owner_marketing_kill(kill, reason)          kill = true stops claims; false re-arms (needs a reason)
--  6. Worker functions (SECURITY DEFINER, EXECUTE for service_role ONLY):
--         marketing_draft_upsert(...)                 idempotent; only a draft the owner has not edited is
--                                                     ever updated
--         claim_marketing_post(worker, lease, target) at most ONE post, under an advisory lock
--         complete_marketing_post(...)                sent | failed | dead | retry (never-left only)
--  7. audit_action_allowed(): 0107's list verbatim plus marketing.edit, marketing.approve, marketing.reject,
--     marketing.send, marketing.fail, marketing.kill, showcase.mark, showcase.revoke.
--
-- HOW A POST CAN AND CANNOT GO OUT (claim_marketing_post)
--   One advisory lock serialises every claim and every approval, then in this order:
--     1. housekeeping: a lease that ran out ends as dead / unconfirmed and is NEVER sent again (Telegram has
--        no idempotency token; a missed post is better than a duplicate: the same rule as 0102); an approval
--        past expires_at ends as expired; a draft older than 30 days ends as expired.
--     2. enabled = false                                          -> nothing
--     3. posts sent, sending or dead in the last 7 days >= max_per_7d  -> nothing
--        (dead counts: an unconfirmed send may be on the channel, so it keeps its slot)
--     4. the oldest approved post whose approval has not expired, was given less than 72 h ago, whose
--        approved_hash equals the hash of the content as it stands, and whose retry time has come -> one row.
--   A post that fails 4 is skipped, not touched; it expires.
--
-- Known limits, stated plainly
--   * Nothing here knows whether Telegram really has the message. 'sent' is the worker's word.
--   * The text limits are in characters as PostgreSQL counts them (code points). Telegram counts UTF-16
--     units; the allowance below is generous and docs/news/ is far under it.
--   * Owner-typed text is not checked against docs/news/banned-claims.json here: that list is enforced on
--     the repository's news files (tests/test_news_format.py). The owner page is the place for a live check.
--   * Turn the 0107 admin_aal2 gate on BEFORE re-arming the poster. Until it is on, a password-only admin
--     session passes owner_guard() and could approve a public post.
--   * A showcase post must also join a LIVE showcase_assets row at claim time; that belongs to the showcase
--     slice, which also adds the owner functions that fill the table. This file only requires media.
--   * The cap counts all targets together. When a second target exists, a post to both counts twice.
--
-- Additive and idempotent: create ... if not exists, create or replace for NEW functions (and for the one
-- permitted redefinition), drop-then-create for constraints, triggers and policies, the seed is
-- ON CONFLICT DO NOTHING (a replay keeps whatever the owner set).
-- REQUIRES 0107 (owner_guard, owner_audit, owner_err, admin_aal_ok), 0018 (organizations, default_org_id,
-- is_platform_admin), 0008/0087 (app_audit_log).

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.owner_guard(text, integer)') is null
     or to_regprocedure('public.owner_audit(text, text, jsonb, text)') is null
     or to_regprocedure('public.owner_err(text, text, jsonb)') is null
     or to_regprocedure('public.admin_aal_ok()') is null then
    raise exception '0108 needs 0107_owner_safety.sql (owner_guard, owner_audit, owner_err, admin_aal_ok): apply it first';
  end if;
  if to_regprocedure('public.is_platform_admin()') is null or to_regprocedure('public.default_org_id()') is null
     or to_regclass('public.organizations') is null then
    raise exception '0108 needs 0018_organizations.sql (organizations, default_org_id, is_platform_admin): apply it first';
  end if;
  if to_regprocedure('public.audit_action_allowed(text)') is null or to_regclass('public.app_audit_log') is null then
    raise exception '0108 needs the audit trail of 0008 / 0087 (audit_action_allowed, app_audit_log): apply them first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Settings: one row, everything off
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.marketing_settings (
  id                   boolean primary key default true,
  enabled              boolean not null default false,
  max_per_7d           integer not null default 2,
  facts_max_age_hours  integer not null default 24,
  approval_ttl_hours   integer not null default 72,
  updated_at           timestamptz not null default now(),
  updated_by           uuid
);

alter table public.marketing_settings drop constraint if exists marketing_settings_single_row;
alter table public.marketing_settings add constraint marketing_settings_single_row check (id);
alter table public.marketing_settings drop constraint if exists marketing_settings_max_check;
alter table public.marketing_settings add constraint marketing_settings_max_check check (max_per_7d between 0 and 2);
alter table public.marketing_settings drop constraint if exists marketing_settings_facts_check;
alter table public.marketing_settings add constraint marketing_settings_facts_check check (facts_max_age_hours between 1 and 168);
alter table public.marketing_settings drop constraint if exists marketing_settings_ttl_check;
alter table public.marketing_settings add constraint marketing_settings_ttl_check check (approval_ttl_hours between 1 and 72);

comment on table public.marketing_settings is
  'One row (id is always true). enabled = false is the kill switch: claim_marketing_post() hands out nothing. max_per_7d is capped at 2 by a CHECK. No API role can read or write it: owner_marketing_get() reads it, owner_marketing_kill() and the SQL editor change it. Break-glass: update public.marketing_settings set enabled = false where id;';

insert into public.marketing_settings (id) values (true) on conflict (id) do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Small internal helpers (no API role may call them)
-- ───────────────────────────────────────────────────────────────────────────

-- Exactly the keys uz, ru, en; each a non-empty string without surrounding whitespace, control or invisible
-- characters (a new line inside is allowed); each at most 1000 characters. The combined message (three blocks, their labels
-- and a link: 160 characters of allowance) must fit Telegram's 4096, or the 1024 of a photo or video caption
-- when the post carries media.
create or replace function public.marketing_texts_ok(p_texts jsonb, p_has_media boolean) returns boolean
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  k     text[];
  v_u   text;
  v_r   text;
  v_e   text;
begin
  if p_texts is null or jsonb_typeof(p_texts) <> 'object' then
    return false;
  end if;
  select array_agg(x order by x) into k from jsonb_object_keys(p_texts) x;
  if k is distinct from array['en', 'ru', 'uz']::text[] then
    return false;
  end if;
  if jsonb_typeof(p_texts -> 'uz') <> 'string' or jsonb_typeof(p_texts -> 'ru') <> 'string'
     or jsonb_typeof(p_texts -> 'en') <> 'string' then
    return false;
  end if;
  v_u := p_texts ->> 'uz';
  v_r := p_texts ->> 'ru';
  v_e := p_texts ->> 'en';
  -- No whitespace at either end (the callers trim all of it first, new lines and tabs included), no control
  -- character except a new line inside, and no invisible or direction-changing character: zero-width and
  -- format characters (U+200B-200F, U+2060-2064, U+FEFF, U+00AD), line and paragraph separators and the
  -- bidi embeddings and overrides (U+2028-202E), bidi isolates (U+2066-2069), and the C1 controls (U+0080-009F,
  -- which include U+0085).
  if v_u ~ '^\s|\s$' or v_r ~ '^\s|\s$' or v_e ~ '^\s|\s$'
     or (v_u || v_r || v_e) ~ '[\x01-\x09\x0b-\x1f\x7f-\x9f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]' then
    return false;
  end if;
  if char_length(v_u) not between 1 and 1000 or char_length(v_r) not between 1 and 1000
     or char_length(v_e) not between 1 and 1000 then
    return false;
  end if;
  return char_length(v_u) + char_length(v_r) + char_length(v_e) + 160
         <= case when coalesce(p_has_media, false) then 1024 else 4096 end;
end
$$;

-- The fingerprint of what a reader would see: kind, target, media, link and the three texts, each length-prefixed so
-- no two different posts can share one input string. Approval stores it; the claim recomputes it.
create or replace function public.marketing_post_hash(p_kind text, p_target text, p_texts jsonb, p_media text, p_link text)
  returns text
  language sql immutable set search_path = public, pg_temp as $$
  select encode(sha256(convert_to(
    char_length(coalesce(p_kind, '')) || ':' || coalesce(p_kind, '') || ';' ||
    char_length(coalesce(p_target, '')) || ':' || coalesce(p_target, '') || ';' ||
    char_length(coalesce(p_media, '')) || ':' || coalesce(p_media, '') || ';' ||
    char_length(coalesce(p_link, '')) || ':' || coalesce(p_link, '') || ';' ||
    char_length(coalesce(p_texts ->> 'uz', '')) || ':' || coalesce(p_texts ->> 'uz', '') || ';' ||
    char_length(coalesce(p_texts ->> 'ru', '')) || ':' || coalesce(p_texts ->> 'ru', '') || ';' ||
    char_length(coalesce(p_texts ->> 'en', '')) || ':' || coalesce(p_texts ->> 'en', ''), 'UTF8')), 'hex')
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Posts
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.marketing_posts (
  id                   uuid primary key default gen_random_uuid(),
  idempotency_key      text not null,
  kind                 text not null,
  target               text not null default 'telegram',
  status               text not null default 'draft',
  texts                jsonb not null,
  media_path           text,
  link                 text,
  source_ref           text not null,
  facts                jsonb not null default '{}'::jsonb,
  facts_as_of          timestamptz,
  content_hash         text not null default '',
  approved_by          uuid,
  approved_at          timestamptz,
  approved_hash        text,
  expires_at           timestamptz,
  edited_by            uuid,
  edited_at            timestamptz,
  rejected_by          uuid,
  rejected_at          timestamptz,
  reject_reason        text,
  claimed_by           text,
  claimed_at           timestamptz,
  claimed_until        timestamptz,
  attempts             integer not null default 0,
  max_attempts         integer not null default 3,
  next_attempt_at      timestamptz not null default now(),
  sent_at              timestamptz,
  provider_message_id  text,
  last_error_code      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.marketing_posts drop constraint if exists marketing_posts_kind_check;
alter table public.marketing_posts add constraint marketing_posts_kind_check check (kind in ('news', 'showcase', 'price'));
-- Only Telegram exists. A second target is a new forward migration that widens this list together with its sender.
alter table public.marketing_posts drop constraint if exists marketing_posts_target_check;
alter table public.marketing_posts add constraint marketing_posts_target_check check (target in ('telegram'));
alter table public.marketing_posts drop constraint if exists marketing_posts_status_check;
alter table public.marketing_posts add constraint marketing_posts_status_check
  check (status in ('draft', 'approved', 'sending', 'sent', 'failed', 'dead', 'rejected', 'expired'));
-- news:<slug> | showcase:<asset id> | price:<plan-set hash>:<yyyy-mm>: the key starts with the kind.
alter table public.marketing_posts drop constraint if exists marketing_posts_key_check;
alter table public.marketing_posts add constraint marketing_posts_key_check
  check (char_length(idempotency_key) <= 120 and idempotency_key ~ ('^' || kind || ':[A-Za-z0-9._:,-]{1,100}$'));
alter table public.marketing_posts drop constraint if exists marketing_posts_texts_check;
alter table public.marketing_posts add constraint marketing_posts_texts_check
  check (public.marketing_texts_ok(texts, media_path is not null));
-- Media lives in the public showcase bucket only, never in a private one.
alter table public.marketing_posts drop constraint if exists marketing_posts_media_check;
alter table public.marketing_posts add constraint marketing_posts_media_check
  check (media_path is null or (media_path ~ '^showcase/[A-Za-z0-9._/-]{1,200}$' and media_path !~ '\.\.'));
-- A showcase post is a video: no media, no post. (At claim time it must also join a live showcase_assets row;
-- that join belongs to the showcase slice.)
alter table public.marketing_posts drop constraint if exists marketing_posts_showcase_media_check;
alter table public.marketing_posts add constraint marketing_posts_showcase_media_check
  check (kind <> 'showcase' or media_path is not null);
-- The link is a path on our own site; the sender puts the origin in front. It is part of the hash.
alter table public.marketing_posts drop constraint if exists marketing_posts_link_check;
alter table public.marketing_posts add constraint marketing_posts_link_check
  check (link is null or (link ~ '^/[a-z0-9][a-z0-9/_-]{0,78}$' and link !~ '//' and link !~ '\.\.'));
alter table public.marketing_posts drop constraint if exists marketing_posts_source_check;
alter table public.marketing_posts add constraint marketing_posts_source_check
  check ((kind = 'news' and source_ref ~ '^pr:#[0-9]{1,7}$')
      or (kind = 'price' and source_ref ~ '^plan:[a-z0-9_.:,-]{1,100}$')
      or (kind = 'showcase' and source_ref ~ '^asset:[0-9a-f-]{36}$'));
alter table public.marketing_posts drop constraint if exists marketing_posts_facts_check;
alter table public.marketing_posts add constraint marketing_posts_facts_check
  check (jsonb_typeof(facts) = 'object' and octet_length(facts::text) <= 8192);
-- A price is only as true as the moment it was read: no timestamp, no price post.
alter table public.marketing_posts drop constraint if exists marketing_posts_price_facts_check;
alter table public.marketing_posts add constraint marketing_posts_price_facts_check
  check (kind <> 'price' or facts_as_of is not null);
alter table public.marketing_posts drop constraint if exists marketing_posts_hash_check;
alter table public.marketing_posts add constraint marketing_posts_hash_check
  check ((content_hash = '' or content_hash ~ '^[0-9a-f]{64}$') and (approved_hash is null or approved_hash ~ '^[0-9a-f]{64}$'));
alter table public.marketing_posts drop constraint if exists marketing_posts_attempts_check;
alter table public.marketing_posts add constraint marketing_posts_attempts_check
  check (attempts >= 0 and max_attempts between 1 and 5);
alter table public.marketing_posts drop constraint if exists marketing_posts_provider_id_check;
alter table public.marketing_posts add constraint marketing_posts_provider_id_check
  check (provider_message_id is null or char_length(provider_message_id) <= 64);
alter table public.marketing_posts drop constraint if exists marketing_posts_reason_check;
alter table public.marketing_posts add constraint marketing_posts_reason_check
  check (reject_reason is null or char_length(reject_reason) <= 300);
alter table public.marketing_posts drop constraint if exists marketing_posts_worker_check;
alter table public.marketing_posts add constraint marketing_posts_worker_check
  check (claimed_by is null or char_length(claimed_by) between 1 and 80);
-- The closed list of reasons a post did not go out (the page names the fix for each).
alter table public.marketing_posts drop constraint if exists marketing_posts_error_check;
alter table public.marketing_posts add constraint marketing_posts_error_check
  check (last_error_code is null or last_error_code in
    ('blocked', 'bad_request', 'not_configured', 'rate_limited', 'network', 'http_5xx', 'unconfirmed', 'expired'));
-- Which columns each status may and must carry.
alter table public.marketing_posts drop constraint if exists marketing_posts_state_check;
alter table public.marketing_posts add constraint marketing_posts_state_check check (
     (status = 'draft' and approved_by is null and approved_at is null and approved_hash is null and expires_at is null
        and claimed_by is null and claimed_at is null and claimed_until is null and sent_at is null)
  or (status = 'approved' and approved_by is not null and approved_at is not null and approved_hash is not null
        and expires_at is not null and claimed_by is null and claimed_at is null and claimed_until is null and sent_at is null)
  or (status = 'sending' and approved_hash is not null and claimed_by is not null and claimed_at is not null
        and claimed_until is not null and sent_at is null)
  or (status = 'sent' and approved_hash is not null and sent_at is not null)
  or (status in ('failed', 'dead') and approved_hash is not null and last_error_code is not null and sent_at is null)
  or (status = 'rejected' and approved_hash is null and sent_at is null and rejected_at is not null)
  or (status = 'expired' and sent_at is null)
);

create unique index if not exists marketing_posts_idempotency_key on public.marketing_posts (idempotency_key);
-- The cap reads the posts that took a slot in the last 7 days; the claim reads the approved ones.
create index if not exists marketing_posts_slot_idx on public.marketing_posts (claimed_at) where claimed_at is not null;
create index if not exists marketing_posts_approved_idx on public.marketing_posts (approved_at) where status = 'approved';
create index if not exists marketing_posts_created_idx on public.marketing_posts (created_at desc);

comment on table public.marketing_posts is
  'Posts for the brand channel (migration 0108). A platform admin may SELECT; every write goes through the owner_marketing_* and the worker functions. Nothing publishes without approved_hash equal to the hash of the content as it stands. Never deleted.';

-- The status machine and the content freeze (see the header, 4).
create or replace function public.marketing_posts_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_changed boolean;
begin
  new.content_hash := public.marketing_post_hash(new.kind, new.target, new.texts, new.media_path, new.link);
  new.updated_at := now();

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a marketing post starts as a draft' using errcode = '23514';
    end if;
    return new;
  end if;

  if old.status in ('sent', 'failed', 'dead', 'rejected', 'expired') then
    raise exception 'marketing post % is final (%): draft a new one instead', old.id, old.status using errcode = '23514';
  end if;
  if new.id is distinct from old.id or new.idempotency_key is distinct from old.idempotency_key
     or new.kind is distinct from old.kind or new.target is distinct from old.target
     or new.source_ref is distinct from old.source_ref or new.created_at is distinct from old.created_at then
    raise exception 'marketing post identity (id, key, kind, target, source) never changes' using errcode = '23514';
  end if;
  if old.status <> 'draft' and (new.facts is distinct from old.facts or new.facts_as_of is distinct from old.facts_as_of) then
    raise exception 'the facts of a post are fixed once it is approved' using errcode = '23514';
  end if;

  v_changed := new.content_hash is distinct from old.content_hash;
  if v_changed then
    if old.status = 'draft' then
      null;
    elsif old.status = 'approved' and new.status in ('approved', 'draft') then
      -- An edit after approval: the approval is void and the post is a draft again.
      new.status := 'draft';
      new.approved_by := null;
      new.approved_at := null;
      new.approved_hash := null;
      new.expires_at := null;
    else
      raise exception 'the content of a post that is being sent cannot change' using errcode = '23514';
    end if;
  end if;

  if new.status is distinct from old.status then
    if not ((old.status = 'draft' and new.status in ('approved', 'rejected', 'expired'))
         or (old.status = 'approved' and new.status in ('sending', 'expired', 'draft'))
         or (old.status = 'sending' and new.status in ('sent', 'failed', 'dead', 'approved'))) then
      raise exception 'illegal marketing status move: % -> %', old.status, new.status using errcode = '23514';
    end if;

    if new.status = 'approved' then
      if new.approved_by is null or new.approved_at is null or new.expires_at is null
         or new.approved_hash is distinct from new.content_hash then
        raise exception 'an approval needs the approver, the time, an expiry and the hash of the content as it stands'
          using errcode = '23514';
      end if;
      if old.status = 'draft' and new.expires_at <= now() then
        raise exception 'an approval must expire in the future' using errcode = '23514';
      end if;
      if old.status = 'sending' and (new.claimed_by is not null or new.claimed_until is not null or new.claimed_at is not null) then
        raise exception 'a retried post gives up its claim' using errcode = '23514';
      end if;
    elsif new.status = 'sending' then
      if new.approved_hash is distinct from new.content_hash or new.approved_hash is distinct from old.approved_hash
         or old.expires_at <= now() then
        raise exception 'only a post with a current, matching approval may be sent' using errcode = '23514';
      end if;
    elsif new.status = 'draft' then
      if new.approved_hash is not null then
        raise exception 'a post goes back to draft only with its approval cleared' using errcode = '23514';
      end if;
    end if;
  elsif new.status = 'approved' and (new.approved_hash is distinct from old.approved_hash
        or new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at) then
    raise exception 'an approval is not rewritten in place' using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function public.marketing_posts_no_delete() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  raise exception 'marketing_posts keeps every row (its key is what stops a repeat): change the status instead' using errcode = '42501';
end
$$;

drop trigger if exists marketing_posts_guard on public.marketing_posts;
create trigger marketing_posts_guard
  before insert or update on public.marketing_posts
  for each row execute function public.marketing_posts_guard();
drop trigger if exists marketing_posts_no_delete on public.marketing_posts;
create trigger marketing_posts_no_delete
  before delete on public.marketing_posts
  for each row execute function public.marketing_posts_no_delete();
drop trigger if exists marketing_posts_no_truncate on public.marketing_posts;
create trigger marketing_posts_no_truncate
  before truncate on public.marketing_posts
  for each statement execute function public.marketing_posts_no_delete();

-- The settings row can be edited but never removed (a missing row would read as "enabled is not false").
create or replace function public.marketing_settings_no_delete() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  raise exception 'marketing_settings keeps its one row: update it instead' using errcode = '42501';
end
$$;

create or replace function public.marketing_settings_stamp() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end
$$;

-- Flipping the switch or a limit in the SQL editor leaves a mark in security_events (the actor is empty
-- there). It observes: a logging failure becomes a warning and never blocks the change.
create or replace function public.marketing_settings_trail() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  begin
    perform public.security_event_log('marketing.settings',
      case when new.enabled is distinct from old.enabled and new.enabled then 'critical' else 'warning' end,
      'marketing_settings',
      jsonb_build_object('enabled', jsonb_build_array(old.enabled, new.enabled),
                         'max_per_7d', jsonb_build_array(old.max_per_7d, new.max_per_7d),
                         'facts_max_age_hours', jsonb_build_array(old.facts_max_age_hours, new.facts_max_age_hours),
                         'approval_ttl_hours', jsonb_build_array(old.approval_ttl_hours, new.approval_ttl_hours)));
  exception when others then
    raise warning 'security trail (marketing_settings) failed: %', sqlerrm;
  end;
  return null;
end
$$;

drop trigger if exists marketing_settings_no_delete on public.marketing_settings;
create trigger marketing_settings_no_delete
  before delete on public.marketing_settings
  for each row execute function public.marketing_settings_no_delete();
drop trigger if exists marketing_settings_no_truncate on public.marketing_settings;
create trigger marketing_settings_no_truncate
  before truncate on public.marketing_settings
  for each statement execute function public.marketing_settings_no_delete();
drop trigger if exists marketing_settings_stamp on public.marketing_settings;
create trigger marketing_settings_stamp
  before update on public.marketing_settings
  for each row execute function public.marketing_settings_stamp();
drop trigger if exists marketing_settings_trail on public.marketing_settings;
create trigger marketing_settings_trail
  after update on public.marketing_settings
  for each row execute function public.marketing_settings_trail();

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Showcase assets: closed, operator's own organization only
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.showcase_assets (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations (id),
  source_video_ref  text not null,
  storage_path      text not null,
  marked_by         uuid not null,
  marked_at         timestamptz not null default now(),
  revoked_at        timestamptz,
  revoked_by        uuid
);

-- A customer's video can never be marked: only the operator's own organization qualifies.
alter table public.showcase_assets drop constraint if exists showcase_assets_org_check;
alter table public.showcase_assets add constraint showcase_assets_org_check check (org_id = public.default_org_id());
alter table public.showcase_assets drop constraint if exists showcase_assets_path_check;
alter table public.showcase_assets add constraint showcase_assets_path_check
  check (storage_path ~ '^showcase/[A-Za-z0-9._/-]{1,200}$' and storage_path !~ '\.\.');
alter table public.showcase_assets drop constraint if exists showcase_assets_ref_check;
alter table public.showcase_assets add constraint showcase_assets_ref_check
  check (char_length(source_video_ref) between 1 and 200);
alter table public.showcase_assets drop constraint if exists showcase_assets_revoke_check;
alter table public.showcase_assets add constraint showcase_assets_revoke_check
  check ((revoked_at is null) = (revoked_by is null));

create unique index if not exists showcase_assets_live_ref on public.showcase_assets (source_video_ref) where revoked_at is null;

comment on table public.showcase_assets is
  'Videos the owner explicitly made public (migration 0108, closed: no policy, no grant). Operator organization only. Filled by showcase.mark / showcase.revoke functions in a later change.';

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The rolling count behind the cap
-- ───────────────────────────────────────────────────────────────────────────

-- Posts that took a slot in the last 7 days: sent, being sent, or lost in flight (dead may be on the channel).
-- Internal; callers hold the cap advisory lock when the answer decides something.
create or replace function public.marketing_cap_used() returns integer
  language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from public.marketing_posts p
   where p.status in ('sending', 'sent', 'dead')
     and coalesce(p.sent_at, p.claimed_at) > now() - interval '7 days'
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Owner functions (signed in, platform owner/admin, second factor, rate limit, audit)
-- ───────────────────────────────────────────────────────────────────────────

-- The settings and the week's count, for the owner page. Read only: no audit, like owner_security_get().
create or replace function public.owner_marketing_get() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s         public.marketing_settings;
  v_waiting integer;
begin
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'only a platform owner or admin may do this' using errcode = '42501';
  end if;
  select * into s from public.marketing_settings limit 1;
  select count(*)::integer into v_waiting from public.marketing_posts p
   where p.status = 'approved' and p.expires_at > now();
  return jsonb_build_object('ok', true, 'enabled', s.enabled, 'max_per_7d', s.max_per_7d,
                            'facts_max_age_hours', s.facts_max_age_hours, 'approval_ttl_hours', s.approval_ttl_hours,
                            'used_7d', public.marketing_cap_used(), 'approved_waiting', v_waiting,
                            'updated_at', s.updated_at);
end
$$;

-- Change the three texts of a draft or an approved post. An approved post goes back to draft (the trigger
-- clears the approval): the owner approves the new words again.
create or replace function public.owner_marketing_edit(p_id uuid, p_texts jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  g       jsonb;
  p       public.marketing_posts;
  v_texts jsonb;
  v_new   public.marketing_posts;
begin
  g := public.owner_guard('marketing_edit', 30);
  if g is not null then return g; end if;

  select * into p from public.marketing_posts where id = p_id for update;
  if not found then
    return public.owner_err('no_such_post', 'That post does not exist.');
  end if;
  if p.status not in ('draft', 'approved') then
    return public.owner_err('not_editable', 'Only a draft or an approved post can be edited.',
      jsonb_build_object('status', p.status));
  end if;
  if p_texts is null or jsonb_typeof(p_texts) <> 'object' or jsonb_typeof(p_texts -> 'uz') <> 'string'
     or jsonb_typeof(p_texts -> 'ru') <> 'string' or jsonb_typeof(p_texts -> 'en') <> 'string' then
    return public.owner_err('bad_texts', 'Give the Uzbek, Russian and English texts.');
  end if;
  v_texts := jsonb_build_object('uz', regexp_replace(p_texts ->> 'uz', '^\s+|\s+$', '', 'g'),
                                'ru', regexp_replace(p_texts ->> 'ru', '^\s+|\s+$', '', 'g'),
                                'en', regexp_replace(p_texts ->> 'en', '^\s+|\s+$', '', 'g'));
  if (select count(*) from jsonb_object_keys(p_texts)) <> 3 or not public.marketing_texts_ok(v_texts, p.media_path is not null) then
    return public.owner_err('bad_texts',
      'Each language needs a text without control, invisible or direction-changing characters; the three together must fit one message (a caption when there is media).');
  end if;
  if v_texts = p.texts then
    return jsonb_build_object('ok', true, 'unchanged', true, 'id', p.id, 'status', p.status, 'content_hash', p.content_hash);
  end if;

  update public.marketing_posts set texts = v_texts, edited_by = auth.uid(), edited_at = now()
   where id = p.id returning * into v_new;

  perform public.owner_audit('marketing.edit', p.id::text,
    jsonb_build_object('post_id', p.id, 'kind', p.kind, 'from_status', p.status, 'approval_voided', p.status = 'approved',
                       'chars', jsonb_build_object('uz', char_length(v_texts ->> 'uz'), 'ru', char_length(v_texts ->> 'ru'),
                                                   'en', char_length(v_texts ->> 'en')),
                       'content_hash', v_new.content_hash),
    case when p.status = 'approved' then 'warning' else 'notice' end);
  return jsonb_build_object('ok', true, 'unchanged', false, 'id', v_new.id, 'status', v_new.status,
                            'content_hash', v_new.content_hash, 'approval_voided', p.status = 'approved');
end
$$;

-- Approve a draft. p_content_hash is the hash of the content the owner is looking at (the content_hash column):
-- if the post changed in the meantime the approval is refused, so the owner can only approve what they saw.
create or replace function public.owner_marketing_approve(p_id uuid, p_content_hash text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  g         jsonb;
  s         public.marketing_settings;
  p         public.marketing_posts;
  v_used    integer;
  v_waiting integer;
  v_new     public.marketing_posts;
begin
  g := public.owner_guard('marketing_approve', 20);
  if g is not null then return g; end if;
  if p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' then
    return public.owner_err('content_hash_required', 'Approve the post you are looking at: its content hash is required.');
  end if;

  perform pg_advisory_xact_lock(hashtext('nightshift.marketing'), hashtext('cap'));
  select * into s from public.marketing_settings limit 1;
  select * into p from public.marketing_posts where id = p_id for update;
  if not found then
    return public.owner_err('no_such_post', 'That post does not exist.');
  end if;
  -- An approval that lapsed but has not been swept yet is expired now: say so, never "already approved".
  if p.status = 'approved' and p.expires_at <= now() then
    update public.marketing_posts set status = 'expired', last_error_code = 'expired' where id = p.id;
    return public.owner_err('expired', 'That approval has lapsed and the post is expired. Draft it again.',
      jsonb_build_object('expires_at', p.expires_at));
  end if;
  if p.status = 'approved' and p.approved_hash = p.content_hash and p_content_hash = p.content_hash then
    return jsonb_build_object('ok', true, 'already', true, 'id', p.id, 'status', p.status, 'expires_at', p.expires_at);
  end if;
  if p.status <> 'draft' then
    return public.owner_err('not_draft', 'Only a draft can be approved.', jsonb_build_object('status', p.status));
  end if;
  -- While the poster is off nothing can be claimed, so an approval would lapse unsent and use up the post's key
  -- (a news item is drafted once). Re-arm first, then approve.
  if s.enabled is not true then
    return public.owner_err('poster_off', 'The poster is switched off. Switch it on first, then approve.');
  end if;
  if p_content_hash <> p.content_hash then
    return public.owner_err('content_changed', 'The post changed since you opened it. Read it again before approving.',
      jsonb_build_object('content_hash', p.content_hash));
  end if;
  if p.kind = 'price' and (p.facts_as_of is null or p.facts_as_of < now() - make_interval(hours => s.facts_max_age_hours)) then
    return public.owner_err('facts_stale', 'The facts this price post was built from are too old. Draft it again.',
      jsonb_build_object('facts_as_of', p.facts_as_of, 'max_age_hours', s.facts_max_age_hours));
  end if;
  v_used := public.marketing_cap_used();
  select count(*)::integer into v_waiting from public.marketing_posts x
   where x.status = 'approved' and x.expires_at > now() and x.id <> p.id;
  if v_used + v_waiting >= s.max_per_7d then
    return public.owner_err('cap_full', 'The weekly limit of posts is already used or promised.',
      jsonb_build_object('used_7d', v_used, 'approved_waiting', v_waiting, 'max_per_7d', s.max_per_7d));
  end if;

  update public.marketing_posts
     set status = 'approved', approved_by = auth.uid(), approved_at = now(), approved_hash = p.content_hash,
         expires_at = now() + make_interval(hours => s.approval_ttl_hours)
   where id = p.id returning * into v_new;

  perform public.owner_audit('marketing.approve', p.id::text,
    jsonb_build_object('post_id', p.id, 'kind', p.kind, 'target', p.target, 'content_hash', p.content_hash,
                       'expires_at', v_new.expires_at, 'used_7d', v_used, 'approved_waiting', v_waiting),
    'warning');
  return jsonb_build_object('ok', true, 'already', false, 'id', v_new.id, 'status', v_new.status,
                            'expires_at', v_new.expires_at, 'content_hash', v_new.content_hash);
end
$$;

-- Reject a draft, or withdraw an approved post (its approval is voided first, both moves are legal ones).
create or replace function public.owner_marketing_reject(p_id uuid, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  g     jsonb;
  p     public.marketing_posts;
  v_why text := btrim(coalesce(p_reason, ''));
begin
  g := public.owner_guard('marketing_reject', 30);
  if g is not null then return g; end if;
  if char_length(v_why) < 8 or char_length(v_why) > 300 then
    return public.owner_err('reason_required', 'Give a reason of 8 to 300 characters.');
  end if;

  select * into p from public.marketing_posts where id = p_id for update;
  if not found then
    return public.owner_err('no_such_post', 'That post does not exist.');
  end if;
  if p.status not in ('draft', 'approved') then
    return public.owner_err('not_rejectable', 'Only a draft or an approved post can be rejected.',
      jsonb_build_object('status', p.status));
  end if;
  if p.status = 'approved' then
    update public.marketing_posts
       set status = 'draft', approved_by = null, approved_at = null, approved_hash = null, expires_at = null
     where id = p.id;
  end if;
  update public.marketing_posts
     set status = 'rejected', rejected_by = auth.uid(), rejected_at = now(), reject_reason = v_why
   where id = p.id;

  perform public.owner_audit('marketing.reject', p.id::text,
    jsonb_build_object('post_id', p.id, 'kind', p.kind, 'from_status', p.status, 'reason', v_why),
    'notice');
  return jsonb_build_object('ok', true, 'id', p.id, 'status', 'rejected', 'from_status', p.status);
end
$$;

-- The kill switch. p_kill = true stops every claim at once (approved posts wait, then expire). p_kill = false
-- arms the poster again and needs a reason, because that is the one step that lets approved posts go public.
create or replace function public.owner_marketing_kill(p_kill boolean default true, p_reason text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  g     jsonb;
  s     public.marketing_settings;
  v_why text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
begin
  g := public.owner_guard('marketing_kill', 20);
  if g is not null then return g; end if;
  if p_kill is null then
    return public.owner_err('bad_arguments', 'Say whether to stop (true) or re-arm (false).');
  end if;
  if not p_kill and (v_why is null or char_length(v_why) < 8) then
    return public.owner_err('reason_required', 'Re-arming the poster needs a reason of 8 to 300 characters.');
  end if;

  perform pg_advisory_xact_lock(hashtext('nightshift.marketing'), hashtext('settings'));
  select * into s from public.marketing_settings for update;
  if s.enabled = not p_kill then
    return jsonb_build_object('ok', true, 'already', true, 'enabled', s.enabled);
  end if;
  update public.marketing_settings set enabled = not p_kill where id;

  perform public.owner_audit('marketing.kill', 'marketing_settings',
    jsonb_build_object('enabled', not p_kill, 'was', s.enabled, 'reason', v_why),
    case when p_kill then 'warning' else 'critical' end);
  return jsonb_build_object('ok', true, 'already', false, 'enabled', not p_kill);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. The worker's calls (service_role only)
-- ───────────────────────────────────────────────────────────────────────────

-- Create the draft of a thing, once. The same key again changes nothing unless the post is still a draft that
-- NO PERSON has edited (then the new words replace the old: a news file was edited before anyone looked at it).
-- A draft the owner edited, or an approved post the owner edited back to draft, keeps the owner's words. A key that names
-- a different kind, target or source is refused. Returns {ok, id, status, created, updated} or {ok:false, error}.
create or replace function public.marketing_draft_upsert(
  p_idempotency_key text, p_kind text, p_texts jsonb, p_source_ref text,
  p_facts jsonb default '{}'::jsonb, p_facts_as_of timestamptz default null,
  p_media_path text default null, p_target text default 'telegram', p_link text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_id    uuid;
  p       public.marketing_posts;
  v_texts jsonb;
  v_upd   boolean := false;
begin
  if p_kind is null or p_kind not in ('news', 'showcase', 'price') then
    return public.owner_err('bad_kind', 'kind must be news, showcase or price.');
  end if;
  if p_target is distinct from 'telegram' then
    return public.owner_err('bad_target', 'Only the telegram target exists.');
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) > 120
     or p_idempotency_key !~ ('^' || p_kind || ':[A-Za-z0-9._:,-]{1,100}$') then
    return public.owner_err('bad_key', 'The key must start with the kind and a colon, then 1 to 100 safe characters.');
  end if;
  if p_texts is null or jsonb_typeof(p_texts) <> 'object' or jsonb_typeof(p_texts -> 'uz') <> 'string'
     or jsonb_typeof(p_texts -> 'ru') <> 'string' or jsonb_typeof(p_texts -> 'en') <> 'string' then
    return public.owner_err('bad_texts', 'Give the Uzbek, Russian and English texts.');
  end if;
  v_texts := jsonb_build_object('uz', regexp_replace(p_texts ->> 'uz', '^\s+|\s+$', '', 'g'),
                                'ru', regexp_replace(p_texts ->> 'ru', '^\s+|\s+$', '', 'g'),
                                'en', regexp_replace(p_texts ->> 'en', '^\s+|\s+$', '', 'g'));
  if (select count(*) from jsonb_object_keys(p_texts)) <> 3 or not public.marketing_texts_ok(v_texts, p_media_path is not null) then
    return public.owner_err('bad_texts', 'The texts are empty, too long, or hold control, invisible or direction-changing characters.');
  end if;
  if p_facts is null or jsonb_typeof(p_facts) <> 'object' or octet_length(p_facts::text) > 8192 then
    return public.owner_err('bad_facts', 'facts must be a JSON object of at most 8192 bytes.');
  end if;
  if p_kind = 'price' and p_facts_as_of is null then
    return public.owner_err('facts_as_of_required', 'A price post needs the time its facts were read.');
  end if;
  if p_media_path is not null and (p_media_path !~ '^showcase/[A-Za-z0-9._/-]{1,200}$' or p_media_path ~ '\.\.') then
    return public.owner_err('bad_media', 'Media must live in the public showcase bucket.');
  end if;
  if p_kind = 'showcase' and p_media_path is null then
    return public.owner_err('media_required', 'A showcase post needs its video.');
  end if;
  if p_link is not null and (p_link !~ '^/[a-z0-9][a-z0-9/_-]{0,78}$' or p_link ~ '//' or p_link ~ '\.\.') then
    return public.owner_err('bad_link', 'The link must be a path on our own site such as /pricing.');
  end if;
  if p_source_ref is null or not ((p_kind = 'news' and p_source_ref ~ '^pr:#[0-9]{1,7}$')
       or (p_kind = 'price' and p_source_ref ~ '^plan:[a-z0-9_.:,-]{1,100}$')
       or (p_kind = 'showcase' and p_source_ref ~ '^asset:[0-9a-f-]{36}$')) then
    return public.owner_err('bad_source', 'source_ref must be pr:#N, plan:<ids> or asset:<uuid> to match the kind.');
  end if;

  insert into public.marketing_posts (idempotency_key, kind, target, texts, media_path, link, source_ref, facts, facts_as_of)
  values (p_idempotency_key, p_kind, p_target, v_texts, p_media_path, p_link, p_source_ref, p_facts, p_facts_as_of)
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('ok', true, 'id', v_id, 'status', 'draft', 'created', true, 'updated', false);
  end if;

  select * into p from public.marketing_posts where idempotency_key = p_idempotency_key for update;
  if p.kind <> p_kind or p.target <> p_target or p.source_ref <> p_source_ref then
    return public.owner_err('key_reused', 'That key already names a different post.');
  end if;
  if p.status = 'draft' and p.edited_at is null
     and (p.texts <> v_texts or p.media_path is distinct from p_media_path or p.link is distinct from p_link
          or p.facts <> p_facts or p.facts_as_of is distinct from p_facts_as_of) then
    update public.marketing_posts
       set texts = v_texts, media_path = p_media_path, link = p_link, facts = p_facts, facts_as_of = p_facts_as_of
     where id = p.id;
    v_upd := true;
  end if;
  return jsonb_build_object('ok', true, 'id', p.id, 'status', p.status, 'created', false, 'updated', v_upd,
                            'owner_edited', p.edited_at is not null);
end
$$;

-- Hand out ONE approved post under a lease, or nothing. See the header ("HOW A POST CAN AND CANNOT GO OUT").
create or replace function public.claim_marketing_post(
  p_worker text, p_lease_seconds integer default 120, p_target text default 'telegram'
) returns table (
  post_id uuid, kind text, target text, texts jsonb, media_path text, link text, attempts integer,
  content_hash text, claimed_until timestamptz
)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  s       public.marketing_settings;
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 120), 30), 600);
  v_id    uuid;
begin
  if p_worker is null or char_length(p_worker) not between 1 and 80 then
    raise exception 'worker id required' using errcode = '22023';
  end if;
  if p_target is distinct from 'telegram' then
    raise exception 'unknown target' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('nightshift.marketing'), hashtext('cap'));

  -- A lease that ran out is NOT sent again (the worker may have sent just before it died).
  update public.marketing_posts x
     set status = 'dead', last_error_code = 'unconfirmed'
   where x.status = 'sending' and x.claimed_until < now();
  update public.marketing_posts x
     set status = 'expired', last_error_code = 'expired'
   where x.status = 'approved' and x.expires_at <= now();
  update public.marketing_posts x
     set status = 'expired'
   where x.status = 'draft' and x.created_at < now() - interval '30 days';

  select * into s from public.marketing_settings limit 1;
  if s.enabled is not true then
    return;
  end if;
  if public.marketing_cap_used() >= s.max_per_7d then
    return;
  end if;

  select x.id into v_id
    from public.marketing_posts x
   where x.status = 'approved' and x.target = p_target
     and x.expires_at > now() and x.approved_at > now() - interval '72 hours'
     and x.next_attempt_at <= now()
     and x.approved_hash = public.marketing_post_hash(x.kind, x.target, x.texts, x.media_path, x.link)
   order by x.approved_at, x.id
   limit 1
   for update skip locked;
  if v_id is null then
    return;
  end if;

  update public.marketing_posts x
     set status = 'sending', claimed_by = p_worker, claimed_at = now(),
         claimed_until = now() + make_interval(secs => v_lease), attempts = x.attempts + 1
   where x.id = v_id;

  return query
  select x.id, x.kind, x.target, x.texts, x.media_path, x.link, x.attempts, x.content_hash, x.claimed_until
    from public.marketing_posts x where x.id = v_id;
end
$$;

-- Settle one claimed post. p_outcome:
--   sent    delivered (p_provider_message_id is the channel message id)
--   failed  NOT delivered, for a known reason (blocked, bad_request, not_configured, rate_limited, ...)
--   retry   the request NEVER LEFT (rate_limited, not_configured, network = refused before sending): the post
--           goes back to approved and is claimed again after the wait, until max_attempts. Any other code
--           with 'retry' is treated as dead / unconfirmed: a request that may have arrived is not repeated.
--   dead    the request may have reached the channel and the answer was lost (unconfirmed)
-- Only the worker holding the claim may settle it; false otherwise.
create or replace function public.complete_marketing_post(
  p_id uuid, p_worker text, p_outcome text, p_error_code text default null,
  p_retry_after_s integer default null, p_provider_message_id text default null
) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  p       public.marketing_posts;
  v_code  text := case when p_error_code in ('blocked', 'bad_request', 'not_configured', 'rate_limited', 'network',
                                             'http_5xx', 'unconfirmed', 'expired') then p_error_code end;
  v_att   integer;
  v_wait  numeric;
begin
  if p_outcome is null or p_outcome not in ('sent', 'failed', 'retry', 'dead') then
    raise exception 'unknown outcome' using errcode = '22023';
  end if;
  select * into p from public.marketing_posts x
   where x.id = p_id and x.status = 'sending' and x.claimed_by = p_worker for update;
  if not found then
    return false;
  end if;

  if p_outcome = 'retry' and (v_code is null or v_code not in ('rate_limited', 'not_configured', 'network')) then
    p_outcome := 'dead';
    v_code := 'unconfirmed';
  end if;

  if p_outcome = 'sent' then
    update public.marketing_posts
       set status = 'sent', sent_at = now(), last_error_code = null, claimed_until = null,
           provider_message_id = left(p_provider_message_id, 64)
     where id = p.id;
    perform public.owner_audit('marketing.send', p.id::text,
      jsonb_build_object('post_id', p.id, 'kind', p.kind, 'target', p.target, 'attempts', p.attempts,
                         'content_hash', p.content_hash), 'notice');
  elsif p_outcome = 'retry' then
    v_att := p.attempts;
    if v_code in ('rate_limited', 'not_configured') then
      v_att := greatest(p.attempts - 1, 0);   -- not a failure of this post
    end if;
    if v_att >= p.max_attempts then
      update public.marketing_posts
         set status = 'failed', last_error_code = v_code, attempts = v_att
       where id = p.id;
      perform public.owner_audit('marketing.fail', p.id::text,
        jsonb_build_object('post_id', p.id, 'kind', p.kind, 'outcome', 'failed', 'code', v_code, 'attempts', v_att), 'warning');
    else
      v_wait := greatest(least(greatest(coalesce(p_retry_after_s, 0), 0), 3600),
                         least(30 * power(2, greatest(v_att, 1) - 1), 3600)) + random() * 5;
      update public.marketing_posts
         set status = 'approved', last_error_code = v_code, attempts = v_att, claimed_by = null, claimed_at = null,
             claimed_until = null, next_attempt_at = now() + make_interval(secs => v_wait)
       where id = p.id;
    end if;
  elsif p_outcome = 'dead' then
    update public.marketing_posts
       set status = 'dead', last_error_code = coalesce(v_code, 'unconfirmed'), claimed_until = null
     where id = p.id;
    perform public.owner_audit('marketing.fail', p.id::text,
      jsonb_build_object('post_id', p.id, 'kind', p.kind, 'outcome', 'dead', 'code', coalesce(v_code, 'unconfirmed'),
                         'attempts', p.attempts), 'critical');
  else
    update public.marketing_posts
       set status = 'failed', last_error_code = coalesce(v_code, 'bad_request'), claimed_until = null
     where id = p.id;
    perform public.owner_audit('marketing.fail', p.id::text,
      jsonb_build_object('post_id', p.id, 'kind', p.kind, 'outcome', 'failed', 'code', coalesce(v_code, 'bad_request'),
                         'attempts', p.attempts), 'warning');
  end if;
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. The audit action list: 0107's body verbatim plus this file's eight actions
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.audit_action_allowed(p_action text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_action, '') = any (array[
    'agent.run', 'api.activate', 'api.monthly_limit', 'api.topup_checkout', 'api_key.access', 'api_key.create',
    'api_key.revoke', 'billing.portal', 'billing.refresh', 'billing.settings', 'billing.topup', 'captions.delete',
    'channel.dna.update', 'channel.youtube.connect', 'channel.youtube.connect_failed', 'channel.youtube.disconnect',
    'character.create', 'character.delete', 'character.update', 'creative.cancel', 'creative.generate',
    'editor.export_request', 'editor.project_create', 'editor.project_delete', 'editor.send_asset',
    'media.delete', 'media.folder_create', 'media.folder_delete', 'media.folder_rename', 'media.move',
    'media.upload_request', 'model.availability', 'scene.regenerate', 'secret.write', 'series.create',
    'series.update', 'storyboard.approve', 'storyboard.discard', 'storyboard.edit', 'storyboard.reopen',
    'style_kit.add_library', 'style_kit.attach', 'style_kit.create', 'style_kit.delete', 'style_kit.detach',
    'style_kit.update', 'variable.write', 'video.download_request', 'video.publish_request', 'video.repurpose',
    'workflow.cancel', 'workflow.delete', 'workflow.run', 'workflow.save',
    -- 0093: connecting, disconnecting and re-limiting an AI app (oauth_* functions).
    'mcp.connect', 'mcp.disconnect', 'mcp.disconnect_all', 'mcp.limit',
    -- 0107: the owner actions (owner_* functions) and the second-factor gate.
    'credits.grant', 'credits.reverse', 'credits.price', 'member.add', 'member.role', 'member.remove', 'security.gate',
    -- 0108: the brand-channel posts (owner_marketing_*, the poster worker) and the showcase marking (later).
    'marketing.edit', 'marketing.approve', 'marketing.reject', 'marketing.send', 'marketing.fail', 'marketing.kill',
    'showcase.mark', 'showcase.revoke',
    -- The comment inbox (0081, in review when this was written): its routes audit
    -- through their own helper, auditInbox().
    'inbox.draft.discard', 'inbox.draft.edit', 'inbox.draft.request', 'inbox.reply.approve', 'inbox.reply.retry'
  ]::text[])
  or coalesce(p_action, '') ~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'
  or coalesce(p_action, '') ~ '^learning\.(approve|reject)$'
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 9. Who may do what
-- ───────────────────────────────────────────────────────────────────────────

alter table public.marketing_settings enable row level security;
alter table public.marketing_posts enable row level security;
alter table public.showcase_assets enable row level security;

revoke all on public.marketing_settings from public, anon, authenticated, service_role;
revoke all on public.marketing_posts from public, anon, authenticated, service_role;
revoke all on public.showcase_assets from public, anon, authenticated, service_role;

-- A platform admin reads the posts (the owner page); nobody writes except the definer functions.
grant select on public.marketing_posts to authenticated;
drop policy if exists marketing_posts_select_admin on public.marketing_posts;
create policy marketing_posts_select_admin on public.marketing_posts
  for select to authenticated using ((select public.is_platform_admin()));

-- Internal helpers and trigger functions: not callable by any API role.
revoke all on function public.marketing_texts_ok(jsonb, boolean) from public, anon, authenticated, service_role;
revoke all on function public.marketing_post_hash(text, text, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function public.marketing_cap_used() from public, anon, authenticated, service_role;
revoke all on function public.marketing_posts_guard() from public, anon, authenticated, service_role;
revoke all on function public.marketing_posts_no_delete() from public, anon, authenticated, service_role;
revoke all on function public.marketing_settings_no_delete() from public, anon, authenticated, service_role;
revoke all on function public.marketing_settings_stamp() from public, anon, authenticated, service_role;
revoke all on function public.marketing_settings_trail() from public, anon, authenticated, service_role;
revoke all on function public.audit_action_allowed(text) from public, anon, authenticated, service_role;

-- Signed-in callers (each checks platform owner/admin itself).
revoke all on function public.owner_marketing_get() from public, anon, authenticated, service_role;
revoke all on function public.owner_marketing_edit(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.owner_marketing_approve(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.owner_marketing_reject(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.owner_marketing_kill(boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.owner_marketing_get() to authenticated;
grant execute on function public.owner_marketing_edit(uuid, jsonb) to authenticated;
grant execute on function public.owner_marketing_approve(uuid, text) to authenticated;
grant execute on function public.owner_marketing_reject(uuid, text) to authenticated;
grant execute on function public.owner_marketing_kill(boolean, text) to authenticated;

-- The poster worker (the service key): nothing else.
revoke all on function public.marketing_draft_upsert(text, text, jsonb, text, jsonb, timestamptz, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_marketing_post(text, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.complete_marketing_post(uuid, text, text, text, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.marketing_draft_upsert(text, text, jsonb, text, jsonb, timestamptz, text, text, text) to service_role;
grant execute on function public.claim_marketing_post(text, integer, text) to service_role;
grant execute on function public.complete_marketing_post(uuid, text, text, text, integer, text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     (select count(*) = 1 and bool_and(not enabled) and bool_and(max_per_7d = 2) from public.marketing_settings) as off_one_row,
--     (select bool_and(relrowsecurity) from pg_class
--       where oid in ('public.marketing_settings'::regclass, 'public.marketing_posts'::regclass,
--                     'public.showcase_assets'::regclass)) as rls_on,
--     not has_table_privilege('authenticated', 'public.marketing_posts', 'INSERT')
--       and not has_table_privilege('authenticated', 'public.marketing_posts', 'UPDATE')
--       and has_table_privilege('authenticated', 'public.marketing_posts', 'SELECT')
--       and not has_table_privilege('anon', 'public.marketing_posts', 'SELECT')
--       and not has_table_privilege('service_role', 'public.marketing_posts', 'SELECT')
--       and not has_table_privilege('authenticated', 'public.marketing_settings', 'SELECT')
--       and not has_table_privilege('authenticated', 'public.showcase_assets', 'SELECT') as tables_closed,
--     has_function_privilege('service_role', 'public.claim_marketing_post(text,integer,text)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.claim_marketing_post(text,integer,text)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.claim_marketing_post(text,integer,text)', 'EXECUTE')
--       and has_function_privilege('authenticated', 'public.owner_marketing_approve(uuid,text)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.owner_marketing_approve(uuid,text)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.marketing_post_hash(text,text,jsonb,text,text)', 'EXECUTE') as functions_scoped,
--     (select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
--        from pg_proc p where p.pronamespace = 'public'::regnamespace
--         and p.proname in ('owner_marketing_get', 'owner_marketing_edit', 'owner_marketing_approve',
--           'owner_marketing_reject', 'owner_marketing_kill', 'marketing_draft_upsert', 'claim_marketing_post',
--           'complete_marketing_post', 'marketing_cap_used', 'marketing_posts_guard')) as definer_pins_search_path,
--     (select count(*) = 3 from pg_trigger where not tgisinternal and tgrelid = 'public.marketing_posts'::regclass) as status_triggers,
--     public.audit_action_allowed('marketing.approve') and public.audit_action_allowed('showcase.revoke')
--       and public.audit_action_allowed('credits.grant') and public.audit_action_allowed('mcp.limit') as audit_list;
--
-- ROLLBACK (owner-applied, docs/sql/rollback_0108_marketing_posts.sql; nothing references these objects yet):
--   drops the three tables and every function above, and puts audit_action_allowed back to 0107's body.
