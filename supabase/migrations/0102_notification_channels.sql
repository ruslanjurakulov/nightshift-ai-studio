-- 0102_notification_channels.sql — send the in-app notifications of 0064 to the
-- person's own Telegram chat, once they have linked it in Settings.
--
-- *** APPLYING THIS FILE CHANGES THE LIVE DATABASE. Merging it to main applies
-- *** it automatically. It stays inert until the owner creates the customer bot
-- *** and sets its environment (docs/NOTIFY_TELEGRAM_SETUP.md): with no linked
-- *** chat nothing is ever queued and nothing is ever sent.
--
-- WHAT IT ADDS
--   notification_channels      one row per linked destination (today: a
--                              Telegram private chat). The chat id lives in
--                              external_id, which no API role may read.
--   notification_link_tokens   the one-time tokens behind
--                              t.me/<bot>?start=<token>. Only the SHA-256 of a
--                              token is stored; the plaintext exists once, in
--                              the return value of notification_link_start.
--   (language: every locale column holds a bare language code, two or three
--   lower-case letters, stored when the chat is linked because the language
--   is only a browser cookie today. The set of languages is NOT fixed here:
--   the worker falls back to English for a code it has no words for.)
--   notification_preferences   sparse grid: person x event kind x channel kind.
--                              A missing row means the default (Telegram: on
--                              for the five kinds of 0064 once a chat is linked).
--                              The grid is channel-generic ('email' and
--                              'whatsapp' are allowed values) so another channel
--                              reuses it instead of adding a second preference
--                              model.
--   notification_outbox        one row per (notification, channel): what to
--                              send, to which channel, how many attempts. The
--                              worker (tools/notify_worker.py) drains it.
--   notify_telegram_updates    update ids the customer bot's webhook already
--                              handled (replay protection). NOT the operator
--                              bot's telegram_updates of 0042: two bots do not
--                              share update numbering.
--   notification_fanout()      AFTER INSERT trigger on notifications: one
--                              outbox row per active channel whose preference is
--                              on. It swallows its own failure (RAISE WARNING),
--                              so a bell row is never lost because of it.
--
-- HOW A CHAT IS LINKED (and why that proves control)
--   1. The signed-in person calls notification_link_start (rate-limited, at
--      most 3 chats). The app opens t.me/<bot>?start=<token>.
--   2. In Telegram the person presses Start. The webhook (Edge Function
--      telegram-notify-webhook; it checks the secret header in constant time)
--      calls notification_link_peek, and the bot asks "connect this chat?" with
--      two buttons.
--   3. Only the Yes button calls notification_link_consume. One UPDATE
--      claims the token (single use, 10 minutes, race-safe), requires a PRIVATE
--      chat whose id equals the sender's user id, and writes the channel.
--   A chat id taken from a message is never trusted on its own: it is stored
--   only together with a token that matched.
--
-- WHO MAY DO WHAT
--   authenticated (own rows only; another id reads as false, never "exists"):
--     notification_link_start, notification_channel_disconnect,
--     notification_channel_set_locale, notification_channel_set_paused,
--     notification_pref_set, notification_pref_effective,
--     notification_test_send.
--   service_role (the webhook and the worker; never the browser):
--     notification_link_peek, notification_link_consume,
--     notification_channel_mark, notify_telegram_update_claim,
--     claim_notification_outbox, complete_notification_outbox.
--   nobody: notification_pref_default, notification_pref_enabled,
--     notification_fanout (the trigger function).
--   Tables: RLS on. authenticated may SELECT its own channel rows through an
--   explicit column list (no external_id) and its own preference rows; every
--   write goes through the functions above. link_tokens, outbox and
--   notify_telegram_updates have no grant for any API role.
--
-- SENDING RULES THE DATABASE ENFORCES
--   * idempotent: unique idempotency_key = notification id + channel id, so a
--     notification fanned out twice queues once; a send is claimed under a
--     lease, and a claim that is lost mid-send is NEVER re-sent (it ends as
--     'unconfirmed': a missed message is better than a duplicate one).
--   * quiet failure: a blocked bot (HTTP 403) marks the channel 'blocked' and
--     drops its queued rows; retries back off (30 s doubling, capped at 1 h,
--     6 attempts), honour a rate-limit retry_after, and nothing older than 24 h
--     is sent. A paused or blocked channel is never sent to.
--   * capped: at most 30 queued messages per channel per hour (more are
--     recorded as 'skipped'), test messages 3 per hour per person.
--   * private: the outbox copies notifications.data (ids and numbers, never a
--     title, prompt or file name), and the message is built from the kind.
--
-- Additive and idempotent (guarded creates, drop-then-create policies and
-- trigger, repeatable revokes). No existing function is replaced.
-- REQUIRES 0064 (notifications) and 0042/0087 (take_web_rate). 0096
-- (user_handles) is used when present, to show a @username in the confirm step.

do $$
begin
  if to_regclass('public.notifications') is null
     or to_regprocedure('public.notification_emit(uuid, uuid, text, text, jsonb)') is null then
    raise exception '0102 needs the notifications of 0064: apply 0064_notifications.sql first';
  end if;
  if to_regprocedure('public.take_web_rate(text, integer, integer)') is null then
    raise exception '0102 needs take_web_rate: apply 0042_web_api_hardening.sql and 0087_audit_and_rate_hardening.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.notification_channels (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users (id) on delete cascade,
  kind                 text not null,
  external_id          text not null,
  label                text,
  locale               text not null default 'en',
  status               text not null default 'active',
  verified_at          timestamptz not null default now(),
  last_ok_at           timestamptz,
  last_error_code      text,
  consecutive_failures integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint notification_channels_kind_check check (kind in ('telegram')),
  constraint notification_channels_external_check
    check (char_length(external_id) between 1 and 64 and external_id ~ '^-?[0-9]{1,20}$'),
  constraint notification_channels_label_check
    check (label is null or (char_length(label) between 1 and 40 and label !~ '[[:cntrl:]]')),
  constraint notification_channels_locale_check check (locale ~ '^[a-z]{2,3}$'),
  constraint notification_channels_status_check check (status in ('active', 'paused', 'blocked')),
  constraint notification_channels_error_check
    check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,32}$')
);
-- One chat belongs to one account.
create unique index if not exists notification_channels_chat_key
  on public.notification_channels (kind, external_id);
create index if not exists notification_channels_user_idx
  on public.notification_channels (user_id, kind);

comment on table public.notification_channels is
  'Where a person receives their notifications besides the bell (0102): a linked Telegram private chat. external_id (the chat id) is never readable through the API. Written only by the notification_* functions.';

create table if not exists public.notification_link_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null,
  token_hash bytea not null,
  locale     text not null default 'en',
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now(),
  constraint notification_link_tokens_kind_check check (kind in ('telegram')),
  constraint notification_link_tokens_locale_check check (locale ~ '^[a-z]{2,3}$'),
  constraint notification_link_tokens_hash_check check (octet_length(token_hash) = 32)
);
create unique index if not exists notification_link_tokens_hash_key
  on public.notification_link_tokens (token_hash);
create index if not exists notification_link_tokens_user_idx
  on public.notification_link_tokens (user_id, kind);

comment on table public.notification_link_tokens is
  'One-time link tokens (0102): SHA-256 only, 10 minutes, single use. No API role can read or write it.';

create table if not exists public.notification_preferences (
  user_id      uuid not null references auth.users (id) on delete cascade,
  event_kind   text not null,
  channel_kind text not null,
  enabled      boolean not null,
  updated_at   timestamptz not null default now(),
  primary key (user_id, event_kind, channel_kind),
  constraint notification_preferences_event_check check (event_kind ~ '^[a-z][a-z0-9_]{2,47}$'),
  constraint notification_preferences_channel_check check (channel_kind in ('email', 'telegram', 'whatsapp'))
);

comment on table public.notification_preferences is
  'Which event goes to which channel, per person (0102). Sparse: a missing row is the default from notification_pref_default(). channel_kind is shared by every channel (email and whatsapp are allowed values), so there is one preference model.';

create table if not exists public.notification_outbox (
  id                  uuid primary key default gen_random_uuid(),
  notification_id     uuid references public.notifications (id) on delete set null,
  -- The organization the notification was about: a message is only sent while the
  -- person is still a member of it (checked again at claim time). Null for a test message.
  org_id              uuid,
  user_id             uuid not null references auth.users (id) on delete cascade,
  channel_id          uuid not null references public.notification_channels (id) on delete cascade,
  channel_kind        text not null,
  event_kind          text not null,
  ref                 text not null default '',
  data                jsonb not null default '{}'::jsonb,
  locale              text not null default 'en',
  idempotency_key     text not null,
  status              text not null default 'pending',
  attempts            integer not null default 0,
  max_attempts        integer not null default 6,
  next_attempt_at     timestamptz not null default now(),
  claimed_by          text,
  claimed_until       timestamptz,
  last_error_code     text,
  provider_message_id text,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  constraint notification_outbox_status_check
    check (status in ('pending', 'sending', 'sent', 'dead', 'skipped')),
  constraint notification_outbox_event_check
    check (event_kind in ('creative_job_completed', 'creative_job_failed', 'storyboard_ready',
                          'editor_export_done', 'credits_low', 'video_ready', 'test')),
  constraint notification_outbox_locale_check check (locale ~ '^[a-z]{2,3}$'),
  constraint notification_outbox_data_check
    check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 2048),
  constraint notification_outbox_error_check
    check (last_error_code is null or last_error_code in (
      'blocked', 'rate_limited', 'http_5xx', 'network', 'bad_request', 'unconfirmed',
      'expired', 'channel_inactive', 'capped', 'not_configured', 'not_member')),
  constraint notification_outbox_key_check check (char_length(idempotency_key) between 1 and 120)
);
create unique index if not exists notification_outbox_idempotency_key
  on public.notification_outbox (idempotency_key);
create index if not exists notification_outbox_due_idx
  on public.notification_outbox (next_attempt_at) where status = 'pending';
create index if not exists notification_outbox_channel_idx
  on public.notification_outbox (channel_id, created_at desc);

comment on table public.notification_outbox is
  'Messages waiting to go to a linked channel (0102). Filled by notification_fanout() and notification_test_send(); drained by the notify worker through claim_/complete_notification_outbox. No API role can read it.';

create table if not exists public.notify_telegram_updates (
  update_id  bigint primary key,
  claimed_at timestamptz not null default now()
);

comment on table public.notify_telegram_updates is
  'Update ids of the CUSTOMER bot already handled (0102): replay protection for its webhook. Separate from 0042 telegram_updates, which belongs to the operator bot.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Preference defaults (internal)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.notification_pref_event_ok(p text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  -- video_ready: the kind migration 0103_retention_notify adds. Listing it here is harmless
  -- before that migration (nothing writes the kind) and makes the two work together after it.
  select p = any (array['creative_job_completed', 'creative_job_failed', 'storyboard_ready',
                        'editor_export_done', 'credits_low', 'video_ready'])
$$;

-- What a person gets before they touch the grid: every event on Telegram, once
-- a chat is linked; nothing on email (a separate decision for that channel).
create or replace function public.notification_pref_default(p_event text, p_channel text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p_channel = 'telegram' and public.notification_pref_event_ok(p_event)
$$;

create or replace function public.notification_pref_enabled(p_user uuid, p_event text, p_channel text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select p.enabled from public.notification_preferences p
      where p.user_id = p_user and p.event_kind = p_event and p.channel_kind = p_channel),
    public.notification_pref_default(p_event, p_channel))
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Fan-out: a notification becomes one outbox row per active channel
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.notification_fanout() returns trigger
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ch record;
  recent integer;
begin
  begin
    for ch in select c.id, c.kind, c.locale from public.notification_channels c
               where c.user_id = new.user_id and c.status = 'active' loop
      if public.notification_pref_enabled(new.user_id, new.kind, ch.kind) then
        select count(*) into recent from public.notification_outbox o
         where o.channel_id = ch.id and o.event_kind <> 'test' and o.status <> 'skipped'
           and o.created_at > now() - interval '1 hour';
        insert into public.notification_outbox
          (notification_id, org_id, user_id, channel_id, channel_kind, event_kind, ref, data, locale,
           idempotency_key, status, last_error_code)
        values
          (new.id, new.org_id, new.user_id, ch.id, ch.kind, new.kind, new.ref, new.data, ch.locale,
           new.id::text || ':' || ch.id::text,
           case when recent >= 30 then 'skipped' else 'pending' end,
           case when recent >= 30 then 'capped' end)
        on conflict (idempotency_key) do nothing;
      end if;
    end loop;
  exception when others then
    raise warning 'notification_fanout: % (%)', sqlerrm, sqlstate;
  end;
  return new;
end
$$;

drop trigger if exists notifications_fanout on public.notifications;
create trigger notifications_fanout
  after insert on public.notifications
  for each row execute function public.notification_fanout();

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The person's own calls (authenticated)
-- ───────────────────────────────────────────────────────────────────────────

-- Start linking. {"ok": true, "token": "<56 hex>", "expires_at": ...} or
-- {"ok": false, "code": "rate_limited" | "limit" | "bad_request"}. The token
-- is about 212 bits from the server's CSPRNG (gen_random_uuid), shown once.
create or replace function public.notification_link_start(p_kind text, p_locale text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  v_token text;
  v_exp   timestamptz := now() + interval '10 minutes';
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_kind is distinct from 'telegram' or p_locale is null or p_locale !~ '^[a-z]{2,3}$' then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  if not public.take_web_rate('notify.link', 5, 3600) then
    return jsonb_build_object('ok', false, 'code', 'rate_limited');
  end if;
  if (select count(*) from public.notification_channels c where c.user_id = uid and c.kind = p_kind) >= 3 then
    return jsonb_build_object('ok', false, 'code', 'limit');
  end if;
  -- One pending link per person: a new one replaces the old.
  delete from public.notification_link_tokens t
   where t.user_id = uid and t.kind = p_kind and (t.used_at is null or t.expires_at < now());
  v_token := left(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 56);
  insert into public.notification_link_tokens (user_id, kind, token_hash, locale, expires_at)
  values (uid, p_kind, sha256(convert_to(v_token, 'UTF8')), p_locale, v_exp);
  return jsonb_build_object('ok', true, 'token', v_token, 'expires_at', v_exp);
end
$$;

-- Remove a linked channel. Its queued messages go with it. False for any id
-- that is not the caller's own (no oracle).
create or replace function public.notification_channel_disconnect(p_id uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.notification_channels where id = p_id and user_id = auth.uid();
  return found;
end
$$;

create or replace function public.notification_channel_set_locale(p_id uuid, p_locale text) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_locale is null or p_locale !~ '^[a-z]{2,3}$' then
    return false;
  end if;
  update public.notification_channels
     set locale = p_locale, updated_at = now()
   where id = p_id and user_id = auth.uid();
  return found;
end
$$;

-- Pause or resume. A blocked channel cannot be resumed from here: the person
-- has to unblock the bot in Telegram, or link again.
create or replace function public.notification_channel_set_paused(p_id uuid, p_paused boolean) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_paused is null then
    return false;
  end if;
  update public.notification_channels
     set status = case when p_paused then 'paused' else 'active' end, updated_at = now()
   where id = p_id and user_id = auth.uid() and status in ('active', 'paused');
  return found;
end
$$;

create or replace function public.notification_pref_set(p_event text, p_channel text, p_enabled boolean) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_channel is distinct from 'telegram' or not public.notification_pref_event_ok(p_event) or p_enabled is null then
    return false;
  end if;
  if not public.take_web_rate('notify.pref', 120, 3600) then
    return false;
  end if;
  insert into public.notification_preferences as np (user_id, event_kind, channel_kind, enabled)
  values (uid, p_event, p_channel, p_enabled)
  on conflict (user_id, event_kind, channel_kind)
  do update set enabled = excluded.enabled, updated_at = now();
  return true;
end
$$;

-- The grid as the person sees it: every event on Telegram, each with its
-- effective setting (their choice, else the default).
create or replace function public.notification_pref_effective() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'event', e, 'channel', 'telegram', 'enabled', public.notification_pref_enabled(uid, e, 'telegram'))
           order by o)
      from unnest(array['creative_job_completed', 'creative_job_failed', 'storyboard_ready',
                        'editor_export_done', 'credits_low', 'video_ready']) with ordinality as t(e, o)
  ), '[]'::jsonb);
end
$$;

-- Queue one test message to the caller's own active channel: 'ok',
-- 'rate_limited', or 'not_found' (also for a paused / blocked one: 'not_active').
create or replace function public.notification_test_send(p_channel_id uuid) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  ch  record;
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select c.id, c.kind, c.locale, c.status into ch
    from public.notification_channels c where c.id = p_channel_id and c.user_id = uid;
  if not found then
    return 'not_found';
  end if;
  if ch.status <> 'active' then
    return 'not_active';
  end if;
  if not public.take_web_rate('notify.test', 3, 3600) then
    return 'rate_limited';
  end if;
  insert into public.notification_outbox
    (user_id, channel_id, channel_kind, event_kind, ref, locale, idempotency_key)
  values (uid, ch.id, ch.kind, 'test', '', ch.locale, 'test:' || gen_random_uuid()::text);
  return 'ok';
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The webhook's calls (service_role only)
-- ───────────────────────────────────────────────────────────────────────────

-- Replay protection: true the first time an update id is seen.
create or replace function public.notify_telegram_update_claim(p_update_id bigint) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if p_update_id is null or p_update_id < 0 then
    return false;
  end if;
  insert into public.notify_telegram_updates (update_id) values (p_update_id)
  on conflict (update_id) do nothing;
  return found;
end
$$;

-- Is this token still good, and in which language should the bot speak?
-- Does not use it up. {"code": "ok" | "invalid" | "used" | "expired", "locale", "handle"}.
create or replace function public.notification_link_peek(p_token text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  t      record;
  v_handle text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{56}$' then
    return jsonb_build_object('code', 'invalid');
  end if;
  select k.user_id, k.locale, k.used_at, k.expires_at into t
    from public.notification_link_tokens k
   where k.token_hash = sha256(convert_to(p_token, 'UTF8')) and k.kind = 'telegram';
  if not found then
    return jsonb_build_object('code', 'invalid');
  end if;
  if t.used_at is not null then
    return jsonb_build_object('code', 'used', 'locale', t.locale);
  end if;
  if t.expires_at <= now() then
    return jsonb_build_object('code', 'expired', 'locale', t.locale);
  end if;
  -- The visible @username (0096), when there is one: it lets the person in the
  -- chat see whose account they are about to connect. Never an e-mail address.
  if to_regclass('public.user_handles') is not null then
    execute 'select h.handle from public.user_handles h where h.user_id = $1' into v_handle using t.user_id;
  end if;
  return jsonb_build_object('code', 'ok', 'locale', t.locale, 'handle', v_handle);
end
$$;

-- Connect the chat. Everything is checked before the token is used up, and the
-- claim is one row lock, so two presses cannot both win.
-- {"code": "ok" | "invalid" | "used" | "expired" | "not_private" | "already_linked" | "limit",
--  "locale": ...}
create or replace function public.notification_link_consume(
  p_token text, p_external_id text, p_label text, p_chat_type text, p_ext_user_id text
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  t        record;
  ch       record;
  v_label  text;
  v_insert boolean := false;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{56}$' then
    return jsonb_build_object('code', 'invalid');
  end if;
  -- A private chat's id is the person's own user id; a group or a channel is not a person.
  if p_chat_type is distinct from 'private' or p_external_id is null
     or p_external_id !~ '^[0-9]{1,20}$' or p_ext_user_id is distinct from p_external_id then
    return jsonb_build_object('code', 'not_private');
  end if;
  select k.id, k.user_id, k.locale, k.used_at, k.expires_at into t
    from public.notification_link_tokens k
   where k.token_hash = sha256(convert_to(p_token, 'UTF8')) and k.kind = 'telegram'
   for update;
  if not found then
    return jsonb_build_object('code', 'invalid');
  end if;
  if t.used_at is not null then
    return jsonb_build_object('code', 'used', 'locale', t.locale);
  end if;
  if t.expires_at <= now() then
    return jsonb_build_object('code', 'expired', 'locale', t.locale);
  end if;

  -- First name as the label ("Connected: Ana"): trimmed, no control characters, 40 at most.
  v_label := nullif(btrim(left(regexp_replace(coalesce(p_label, ''), '[[:cntrl:]]', '', 'g'), 40)), '');

  select c.id, c.user_id, c.status into ch
    from public.notification_channels c where c.kind = 'telegram' and c.external_id = p_external_id
   for update;
  if not found then
    v_insert := true;
  elsif ch.user_id = t.user_id then
    update public.notification_channels
       set status = 'active', label = v_label, locale = t.locale, verified_at = now(),
           last_error_code = null, consecutive_failures = 0, updated_at = now()
     where id = ch.id;
  elsif ch.status = 'blocked' then
    -- The chat blocked the bot for its old account and now asks for this one:
    -- the person in the chat decides.
    delete from public.notification_channels where id = ch.id;
    v_insert := true;
  else
    return jsonb_build_object('code', 'already_linked', 'locale', t.locale);
  end if;

  if v_insert then
    if (select count(*) from public.notification_channels c
         where c.user_id = t.user_id and c.kind = 'telegram') >= 3 then
      return jsonb_build_object('code', 'limit', 'locale', t.locale);
    end if;
    insert into public.notification_channels (user_id, kind, external_id, label, locale)
    values (t.user_id, 'telegram', p_external_id, v_label, t.locale);
  end if;

  update public.notification_link_tokens set used_at = now() where id = t.id;
  return jsonb_build_object('code', 'ok', 'locale', t.locale);
end
$$;

-- The chat's own signals: it blocked the bot, unblocked it, or typed /stop or
-- /resume. Returns the channel's locale when a row matched, else null.
-- blocked: queued messages are dropped. resume only lifts a pause (the person's
-- own /resume); unblocked only lifts a block.
create or replace function public.notification_channel_mark(p_external_id text, p_action text) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ch record;
begin
  if p_external_id is null or p_external_id !~ '^[0-9]{1,20}$'
     or p_action is null or p_action not in ('blocked', 'paused', 'resume', 'unblocked') then
    return null;
  end if;
  select c.id, c.locale, c.status into ch
    from public.notification_channels c where c.kind = 'telegram' and c.external_id = p_external_id
   for update;
  if not found then
    return null;
  end if;
  if p_action = 'blocked' and ch.status <> 'blocked' then
    update public.notification_channels
       set status = 'blocked', last_error_code = 'blocked', updated_at = now() where id = ch.id;
    update public.notification_outbox
       set status = 'skipped', last_error_code = 'blocked'
     where channel_id = ch.id and status = 'pending';
  elsif p_action = 'paused' and ch.status = 'active' then
    update public.notification_channels set status = 'paused', updated_at = now() where id = ch.id;
  elsif p_action = 'resume' and ch.status = 'paused' then
    update public.notification_channels set status = 'active', updated_at = now() where id = ch.id;
  elsif p_action = 'unblocked' and ch.status = 'blocked' then
    update public.notification_channels
       set status = 'active', last_error_code = null, consecutive_failures = 0, updated_at = now()
     where id = ch.id;
  end if;
  return ch.locale;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The worker's calls (service_role only)
-- ───────────────────────────────────────────────────────────────────────────

-- Hand out due messages under a lease. Housekeeping first: old rows go, rows
-- waiting more than 24 h are not sent, rows for a channel that is no longer
-- active or a person who left the organization are skipped, and a claim whose lease ran out is NOT sent again (the
-- worker may have sent it just before dying): it ends as 'unconfirmed'.
create or replace function public.claim_notification_outbox(
  p_worker text, p_limit integer default 10, p_lease_seconds integer default 60
) returns table (
  id uuid, channel_id uuid, external_id text, locale text, event_kind text, data jsonb, attempts integer
)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 50);
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 60), 15), 600);
begin
  if p_worker is null or char_length(p_worker) not between 1 and 80 then
    raise exception 'worker id required' using errcode = '22023';
  end if;
  delete from public.notification_outbox o
   where o.status in ('sent', 'dead', 'skipped') and o.created_at < now() - interval '30 days';
  delete from public.notify_telegram_updates u where u.claimed_at < now() - interval '3 days';
  update public.notification_outbox o
     set status = 'dead', last_error_code = 'unconfirmed'
   where o.status = 'sending' and o.claimed_until < now();
  update public.notification_outbox o
     set status = 'dead', last_error_code = 'expired'
   where o.status = 'pending' and o.created_at < now() - interval '24 hours';
  update public.notification_outbox o
     set status = 'skipped', last_error_code = 'channel_inactive'
   where o.status = 'pending'
     and exists (select 1 from public.notification_channels c where c.id = o.channel_id and c.status <> 'active');
  -- A person who left the organization is not told about it, queued or not (0064 checks
  -- membership when it writes the notification; this checks again when the message would go).
  update public.notification_outbox o
     set status = 'skipped', last_error_code = 'not_member'
   where o.status = 'pending' and o.org_id is not null
     and not exists (select 1 from public.org_members m where m.org_id = o.org_id and m.user_id = o.user_id);

  return query
  with due as (
    select o.id from public.notification_outbox o
     where o.status = 'pending' and o.next_attempt_at <= now()
     order by o.created_at
     limit v_limit
     for update skip locked
  ), taken as (
    update public.notification_outbox o
       set status = 'sending', claimed_by = p_worker,
           claimed_until = now() + make_interval(secs => v_lease), attempts = o.attempts + 1
      from due where o.id = due.id
    returning o.id, o.channel_id, o.locale, o.event_kind, o.data, o.attempts
  )
  select tk.id, tk.channel_id, c.external_id, tk.locale, tk.event_kind, tk.data, tk.attempts
    from taken tk join public.notification_channels c on c.id = tk.channel_id;
end
$$;

-- Settle one claimed message. p_outcome:
--   sent         delivered
--   retry        try again later (network down, server error, rate limit); the
--                wait is the larger of retry_after and an exponential backoff
--                with jitter; after max_attempts it is dead. p_error_code
--                'rate_limited' does not use up an attempt.
--   blocked      the chat blocked the bot or is gone: the channel is marked
--                blocked and every queued message to it is dropped, no retry.
--   dead         a permanent failure of this message (bad request, unconfirmed).
-- Only the worker that holds the lease may settle it; false otherwise.
create or replace function public.complete_notification_outbox(
  p_id uuid, p_worker text, p_outcome text, p_error_code text default null,
  p_retry_after_s integer default null, p_provider_message_id text default null
) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  o       record;
  v_code  text := case when p_error_code in ('blocked', 'rate_limited', 'http_5xx', 'network', 'bad_request',
                                             'unconfirmed', 'not_configured')
                       then p_error_code end;
  v_wait  numeric;
  v_att   integer;
begin
  select x.id, x.channel_id, x.attempts, x.max_attempts into o
    from public.notification_outbox x
   where x.id = p_id and x.status = 'sending' and x.claimed_by = p_worker
   for update;
  if not found then
    return false;
  end if;

  if p_outcome = 'sent' then
    update public.notification_outbox
       set status = 'sent', sent_at = now(), last_error_code = null, claimed_until = null,
           provider_message_id = left(p_provider_message_id, 64)
     where id = o.id;
    update public.notification_channels
       set last_ok_at = now(), consecutive_failures = 0, last_error_code = null
     where id = o.channel_id;
  elsif p_outcome = 'blocked' then
    update public.notification_outbox
       set status = 'dead', last_error_code = 'blocked', claimed_until = null where id = o.id;
    update public.notification_channels
       set status = 'blocked', last_error_code = 'blocked', updated_at = now()
     where id = o.channel_id and status <> 'blocked';
    update public.notification_outbox
       set status = 'skipped', last_error_code = 'blocked'
     where channel_id = o.channel_id and status = 'pending';
  elsif p_outcome = 'retry' then
    v_att := o.attempts;
    if v_code in ('rate_limited', 'not_configured') then
      -- Telegram asked us to wait, or the bot's token is not accepted (the worker pauses
      -- and raises an alarm): neither is a failure of this message, so no attempt is used up.
      -- Nothing older than 24 h is sent either way.
      v_att := greatest(o.attempts - 1, 0);
      update public.notification_outbox set attempts = v_att where id = o.id;
    end if;
    if v_att >= o.max_attempts then
      update public.notification_outbox
         set status = 'dead', last_error_code = coalesce(v_code, 'network'), claimed_until = null
       where id = o.id;
    else
      v_wait := greatest(least(greatest(coalesce(p_retry_after_s, 0), 0), 3600),
                         least(30 * power(2, greatest(v_att, 1) - 1), 3600)) + random() * 5;
      update public.notification_outbox
         set status = 'pending', last_error_code = coalesce(v_code, 'network'), claimed_until = null,
             claimed_by = null, next_attempt_at = now() + make_interval(secs => v_wait)
       where id = o.id;
    end if;
    update public.notification_channels
       set consecutive_failures = least(consecutive_failures + 1, 1000),
           last_error_code = coalesce(v_code, 'network')
     where id = o.channel_id;
  else
    update public.notification_outbox
       set status = 'dead', last_error_code = coalesce(v_code, 'bad_request'), claimed_until = null
     where id = o.id;
  end if;
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Access
-- ───────────────────────────────────────────────────────────────────────────

alter table public.notification_channels enable row level security;
alter table public.notification_link_tokens enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.notify_telegram_updates enable row level security;

revoke all on public.notification_channels from public, anon, authenticated, service_role;
revoke all on public.notification_link_tokens from public, anon, authenticated, service_role;
revoke all on public.notification_preferences from public, anon, authenticated, service_role;
revoke all on public.notification_outbox from public, anon, authenticated, service_role;
revoke all on public.notify_telegram_updates from public, anon, authenticated, service_role;

-- Column list on purpose: the chat id (external_id) is never readable through the API.
grant select (id, user_id, kind, label, locale, status, verified_at, last_ok_at, last_error_code, created_at)
  on public.notification_channels to authenticated;
grant select on public.notification_preferences to authenticated;

drop policy if exists notification_channels_select_own on public.notification_channels;
create policy notification_channels_select_own on public.notification_channels
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists notification_preferences_select_own on public.notification_preferences;
create policy notification_preferences_select_own on public.notification_preferences
  for select to authenticated using (user_id = (select auth.uid()));

revoke all on function public.notification_pref_event_ok(text) from public, anon, authenticated, service_role;
revoke all on function public.notification_pref_default(text, text) from public, anon, authenticated, service_role;
revoke all on function public.notification_pref_enabled(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.notification_fanout() from public, anon, authenticated, service_role;

revoke all on function public.notification_link_start(text, text) from public, anon, authenticated, service_role;
revoke all on function public.notification_channel_disconnect(uuid) from public, anon, authenticated, service_role;
revoke all on function public.notification_channel_set_locale(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.notification_channel_set_paused(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.notification_pref_set(text, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.notification_pref_effective() from public, anon, authenticated, service_role;
revoke all on function public.notification_test_send(uuid) from public, anon, authenticated, service_role;
grant execute on function public.notification_link_start(text, text) to authenticated;
grant execute on function public.notification_channel_disconnect(uuid) to authenticated;
grant execute on function public.notification_channel_set_locale(uuid, text) to authenticated;
grant execute on function public.notification_channel_set_paused(uuid, boolean) to authenticated;
grant execute on function public.notification_pref_set(text, text, boolean) to authenticated;
grant execute on function public.notification_pref_effective() to authenticated;
grant execute on function public.notification_test_send(uuid) to authenticated;

revoke all on function public.notify_telegram_update_claim(bigint) from public, anon, authenticated, service_role;
revoke all on function public.notification_link_peek(text) from public, anon, authenticated, service_role;
revoke all on function public.notification_link_consume(text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.notification_channel_mark(text, text) from public, anon, authenticated, service_role;
revoke all on function public.claim_notification_outbox(text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.complete_notification_outbox(uuid, text, text, text, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.notify_telegram_update_claim(bigint) to service_role;
grant execute on function public.notification_link_peek(text) to service_role;
grant execute on function public.notification_link_consume(text, text, text, text, text) to service_role;
grant execute on function public.notification_channel_mark(text, text) to service_role;
grant execute on function public.claim_notification_outbox(text, integer, integer) to service_role;
grant execute on function public.complete_notification_outbox(uuid, text, text, text, integer, text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select bool_and(relrowsecurity) from pg_class
--     where oid in ('public.notification_channels'::regclass, 'public.notification_link_tokens'::regclass,
--                   'public.notification_preferences'::regclass, 'public.notification_outbox'::regclass,
--                   'public.notify_telegram_updates'::regclass)) as rls_on,
--   not has_table_privilege('authenticated', 'public.notification_channels', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.notification_channels', 'UPDATE')
--     and not has_table_privilege('authenticated', 'public.notification_channels', 'DELETE')
--     and not has_column_privilege('authenticated', 'public.notification_channels', 'external_id', 'SELECT')
--     and has_column_privilege('authenticated', 'public.notification_channels', 'status', 'SELECT')
--     and not has_table_privilege('authenticated', 'public.notification_link_tokens', 'SELECT')
--     and not has_table_privilege('authenticated', 'public.notification_outbox', 'SELECT')
--     and not has_table_privilege('anon', 'public.notification_channels', 'SELECT')
--     and not has_table_privilege('service_role', 'public.notification_channels', 'SELECT') as tables_scoped,
--   has_function_privilege('authenticated', 'public.notification_link_start(text,text)', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.notification_test_send(uuid)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.notification_link_start(text,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.notification_link_consume(text,text,text,text,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.claim_notification_outbox(text,integer,integer)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.complete_notification_outbox(uuid,text,text,text,integer,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.notification_channel_mark(text,text)', 'EXECUTE')
--     and has_function_privilege('service_role', 'public.notification_link_consume(text,text,text,text,text)', 'EXECUTE')
--     and has_function_privilege('service_role', 'public.claim_notification_outbox(text,integer,integer)', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.notification_link_start(text,text)', 'EXECUTE') as functions_scoped,
--   (select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
--      from pg_proc p where p.pronamespace = 'public'::regnamespace
--       and p.proname in ('notification_pref_enabled', 'notification_fanout', 'notification_link_start',
--                         'notification_channel_disconnect', 'notification_channel_set_locale',
--                         'notification_channel_set_paused', 'notification_pref_set', 'notification_pref_effective',
--                         'notification_test_send', 'notify_telegram_update_claim', 'notification_link_peek',
--                         'notification_link_consume', 'notification_channel_mark',
--                         'claim_notification_outbox', 'complete_notification_outbox'))
--     as definer_functions_pin_search_path,
--   exists (select 1 from pg_trigger where tgname = 'notifications_fanout' and not tgisinternal) as fanout_on;
