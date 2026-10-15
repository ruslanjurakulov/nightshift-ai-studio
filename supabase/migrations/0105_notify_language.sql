-- 0105_notify_language.sql — a language the person CHOOSES for the customer
-- notifications: the Telegram bot and the e-mails each run in it, from the first
-- reply to the last button.
--
-- *** APPLYING THIS FILE CHANGES THE LIVE DATABASE. Merging it to main applies
-- *** it automatically. It is additive for every caller that sends a supported
-- *** language (en, ru, uz: the only ones the app has ever sent) and refuses any
-- *** other; rows that somehow hold another code are set to English first.
--
-- WHAT IT ADDS
--   notify_language_ok(text)   the ONE allow-list of notification languages
--                              (today en, ru, uz). Every locale column below checks
--                              it and every function that takes a language calls
--                              it. The wording lives in
--                              supabase/functions/_shared/notify-i18n/ (a registry
--                              and one data file per language, read by the bot
--                              and by the Python workers); a test fails until the
--                              list here and the registry are the same set.
--                              ADDING A LANGUAGE: replace this one function (one
--                              line), add the data file and the registry line.
--                              No table or constraint is touched.
--   locale CHECKs              notification_channels, notification_link_tokens,
--                              notification_outbox and email_preferences: the old
--                              "two or three lower-case letters" shape is replaced
--                              by notify_language_ok(locale). The Telegram language
--                              is the existing notification_channels.locale (per
--                              chat, already readable by its owner through the
--                              column grant of 0102); no new Telegram column is
--                              needed.
--   email_preferences.locale_chosen
--                              false until the person picks the e-mail language in
--                              Settings. The app reports the language it is shown
--                              in (email_prefs_set(p_locale), 0103), and that
--                              report is the default; once chosen, a report never
--                              overwrites the choice. No API role has any grant on
--                              the table, so nothing new is reachable.
--   notification_channel_set_locale_by_chat(chat, language)
--                              the bot's /language and its language buttons
--                              (service key only): reads, or changes, the language
--                              of the channel linked to THAT chat.
--   email_prefs_set_language(language)
--                              the Settings selector for the e-mail language
--                              (authenticated; the caller's own row).
--
-- REPLACED (0102 / 0103 bodies verbatim, plus the language rule; same signatures
-- and grants)
--   notification_link_start        the language must be on the allow-list
--   notification_channel_set_locale  the same; also moves the chat's still-waiting
--                                  messages to the new language, so a message
--                                  queued before the change does not arrive in the old one
--   email_prefs_get                answers locale_chosen too
--   email_prefs_set                the allow-list; a reported language is ignored
--                                  once the person has chosen one
--
-- WHO MAY DO WHAT is unchanged: no table gains a grant, no policy changes, the
-- chat id stays unreadable, and the two new functions are closed to the other
-- role (the bot's to the service key, the selector's to a signed-in person).
--
-- Nothing here spends, renders, publishes or changes a price. Idempotent.
--
-- REQUIRES 0102 (notification_channels, ...) and 0103 (email_preferences, ...).

do $$
begin
  if to_regclass('public.notification_channels') is null
     or to_regprocedure('public.notification_link_start(text, text)') is null then
    raise exception '0105 needs the notification channels: apply 0102_notification_channels.sql first';
  end if;
  if to_regclass('public.email_preferences') is null
     or to_regprocedure('public.email_prefs_set(boolean, integer, text)') is null then
    raise exception '0105 needs the e-mail preferences: apply 0103_retention_notify.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The allow-list
-- ───────────────────────────────────────────────────────────────────────────

-- null is not a language (a bare comparison would answer null, which a check
-- constraint reads as "passed").
create or replace function public.notify_language_ok(p text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p = any (array['en', 'ru', 'uz']), false)
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Every stored language is on it
-- ───────────────────────────────────────────────────────────────────────────

update public.notification_channels set locale = 'en' where not public.notify_language_ok(locale);
update public.notification_link_tokens set locale = 'en' where not public.notify_language_ok(locale);
update public.notification_outbox set locale = 'en' where not public.notify_language_ok(locale);
update public.email_preferences set locale = 'en' where not public.notify_language_ok(locale);

-- The old checks (a language-shaped code) go, whatever they were named; the
-- allow-list takes their place.
do $$
declare
  t record;
  c record;
begin
  for t in select * from (values
      ('notification_channels'), ('notification_link_tokens'), ('notification_outbox'), ('email_preferences')
    ) as v(name)
  loop
    for c in
      select con.conname from pg_constraint con
       where con.conrelid = ('public.' || t.name)::regclass and con.contype = 'c'
         and pg_get_constraintdef(con.oid) like '%locale%'
    loop
      execute format('alter table public.%I drop constraint %I', t.name, c.conname);
    end loop;
    execute format('alter table public.%I add constraint %I check (public.notify_language_ok(locale))',
                   t.name, t.name || '_locale_check');
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. E-mail: a chosen language stays chosen
-- ───────────────────────────────────────────────────────────────────────────

alter table public.email_preferences add column if not exists locale_chosen boolean not null default false;

comment on column public.email_preferences.locale_chosen is
  'True once the person picked the e-mail language in Settings (0105): the app''s own language report (email_prefs_set p_locale) then no longer changes it.';

create or replace function public.email_prefs_get() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  p public.email_preferences;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into p from public.email_preferences where user_id = auth.uid();
  if not found then
    -- The defaults, as the worker applies them: ready mail on, weekly off.
    return jsonb_build_object('ready', true, 'weekly_every_days', null, 'locale', 'en',
                              'locale_chosen', false, 'stored', false);
  end if;
  return jsonb_build_object('ready', p.ready_enabled, 'weekly_every_days', p.weekly_every_days,
                            'locale', p.locale, 'locale_chosen', p.locale_chosen, 'stored', true);
end
$$;

-- Each argument left null stays as it is. p_weekly: 0 = off, 7 or 14 days.
-- p_locale is the language the app is shown in (sent once per visit and with
-- each save): it is the default for the mails until the person chooses one.
create or replace function public.email_prefs_set(
  p_ready boolean default null, p_weekly integer default null, p_locale text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_weekly is not null and p_weekly not in (0, 7, 14) then
    raise exception 'bad_frequency' using errcode = '22023';
  end if;
  if p_locale is not null and not public.notify_language_ok(p_locale) then
    raise exception 'bad_locale' using errcode = '22023';
  end if;
  insert into public.email_preferences (user_id) values (uid) on conflict (user_id) do nothing;
  update public.email_preferences
     set ready_enabled = coalesce(p_ready, ready_enabled),
         -- The right-hand sides read the OLD row: a first switch-on starts the clock.
         weekly_since = case when p_weekly is null then weekly_since
                             when p_weekly = 0 then null
                             when weekly_every_days is null then now()
                             else weekly_since end,
         weekly_every_days = case when p_weekly is null then weekly_every_days
                                  when p_weekly = 0 then null
                                  else p_weekly::smallint end,
         -- A reported language never overrides one the person chose.
         locale = case when p_locale is not null and not locale_chosen then p_locale else locale end,
         updated_at = now()
   where user_id = uid;
  return public.email_prefs_get();
end
$$;

-- The Settings selector: the person's own choice of the e-mail language.
create or replace function public.email_prefs_set_language(p_locale text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not public.notify_language_ok(p_locale) then
    raise exception 'bad_locale' using errcode = '22023';
  end if;
  insert into public.email_preferences (user_id) values (uid) on conflict (user_id) do nothing;
  update public.email_preferences
     set locale = p_locale, locale_chosen = true, updated_at = now()
   where user_id = uid;
  return public.email_prefs_get();
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Telegram: the language of a chat
-- ───────────────────────────────────────────────────────────────────────────

-- 0102's body, with the allow-list instead of the letter shape.
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
  if p_kind is distinct from 'telegram' or not public.notify_language_ok(p_locale) then
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

-- 0102's body, with the allow-list, and the chat's waiting messages follow the
-- new language. False for any id that is not the caller's own (no oracle).
create or replace function public.notification_channel_set_locale(p_id uuid, p_locale text) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_found boolean;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not public.notify_language_ok(p_locale) then
    return false;
  end if;
  update public.notification_channels
     set locale = p_locale, updated_at = now()
   where id = p_id and user_id = auth.uid();
  v_found := found;
  if v_found then
    update public.notification_outbox set locale = p_locale where channel_id = p_id and status = 'pending';
  end if;
  return v_found;
end
$$;

-- The bot's /language and its language buttons. With p_locale null: the language
-- of the channel linked to this chat. With a language: change it first. Returns
-- the (new) language, or null when no channel is linked to this chat or the
-- language is not on the allow-list (nothing changes then). The chat id is the
-- webhook's verified private-chat id; the channel found is that chat's own.
create or replace function public.notification_channel_set_locale_by_chat(
  p_external_id text, p_locale text default null
) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ch record;
begin
  if p_external_id is null or p_external_id !~ '^[0-9]{1,20}$' then
    return null;
  end if;
  if p_locale is not null and not public.notify_language_ok(p_locale) then
    return null;
  end if;
  select c.id, c.locale into ch
    from public.notification_channels c where c.kind = 'telegram' and c.external_id = p_external_id
   for update;
  if not found then
    return null;
  end if;
  if p_locale is null then
    return ch.locale;
  end if;
  update public.notification_channels set locale = p_locale, updated_at = now() where id = ch.id;
  update public.notification_outbox set locale = p_locale where channel_id = ch.id and status = 'pending';
  return p_locale;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Access (the same shape as 0102 and 0103)
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.notify_language_ok(text) from public, anon, authenticated, service_role;

revoke all on function public.notification_channel_set_locale_by_chat(text, text) from public, anon, authenticated, service_role;
grant execute on function public.notification_channel_set_locale_by_chat(text, text) to service_role;

revoke all on function public.email_prefs_set_language(text) from public, anon, authenticated, service_role;
grant execute on function public.email_prefs_set_language(text) to authenticated;

-- Replaced in place: the grants survive, restated so this file reads on its own.
revoke all on function public.notification_link_start(text, text) from public, anon, authenticated, service_role;
revoke all on function public.notification_channel_set_locale(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.email_prefs_get() from public, anon, authenticated, service_role;
revoke all on function public.email_prefs_set(boolean, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.notification_link_start(text, text) to authenticated;
grant execute on function public.notification_channel_set_locale(uuid, text) to authenticated;
grant execute on function public.email_prefs_get() to authenticated;
grant execute on function public.email_prefs_set(boolean, integer, text) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   public.notify_language_ok('uz') and not public.notify_language_ok('de') and not public.notify_language_ok(null)
--     and not public.notify_language_ok('en_US') and not public.notify_language_ok('EN') as allow_list,
--   (select count(*) = 4 from pg_constraint
--     where conname in ('notification_channels_locale_check', 'notification_link_tokens_locale_check',
--                       'notification_outbox_locale_check', 'email_preferences_locale_check')
--       and pg_get_constraintdef(oid) like '%notify_language_ok%') as checks_use_it,
--   not has_table_privilege('authenticated', 'public.email_preferences', 'SELECT')
--     and not has_table_privilege('service_role', 'public.email_preferences', 'SELECT')
--     and not has_column_privilege('authenticated', 'public.notification_channels', 'external_id', 'SELECT')
--     and has_column_privilege('authenticated', 'public.notification_channels', 'locale', 'SELECT') as tables_unchanged,
--   has_function_privilege('service_role', 'public.notification_channel_set_locale_by_chat(text,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.notification_channel_set_locale_by_chat(text,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.notification_channel_set_locale_by_chat(text,text)', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.email_prefs_set_language(text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.email_prefs_set_language(text)', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.email_prefs_set_language(text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.notify_language_ok(text)', 'EXECUTE') as functions_scoped,
--   (select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
--      from pg_proc p where p.pronamespace = 'public'::regnamespace
--       and p.proname in ('notification_link_start', 'notification_channel_set_locale',
--                         'notification_channel_set_locale_by_chat', 'email_prefs_get', 'email_prefs_set',
--                         'email_prefs_set_language')) as definer_functions_pin_search_path;
