-- 0103_retention_notify.sql — a reason and a way back for a returning person:
-- a "your video is ready" notification, a "ready" e-mail and an opt-in weekly
-- summary, each with the channel it is about.
--
-- WHAT IT ADDS
--   notifications.kind       + 'video_ready' (widens the 0064 check; nothing removed).
--   notify_video_ready()     the missing producer: a run that finished and now
--                            WAITS FOR A PERSON (a videos row held for review,
--                            for the second approver, or a repair's new cut)
--                            tells the members who may decide (an admin or an
--                            owner of the channel's organization — the same
--                            audience as storyboard_ready). Data: the video id,
--                            the channel id, the state. Never a title.
--   notify_storyboard_ready() REPLACED (0064's body, verbatim, plus one key):
--                            the notification now carries the channel's id, so
--                            the bell and the e-mail can name the channel.
--   email_preferences        one row per person: ready e-mail on/off, the
--                            weekly summary's frequency (off / 7 / 14 days),
--                            the language code the e-mails are written in (the app
--                            reports the language the person last used; see the
--                            note on languages below), and the
--                            random token behind the one-click unsubscribe link.
--   email_deliveries         the ledger that makes sending idempotent: one row
--                            per (person, kind, ref), claimed with a lease by the
--                            e-mail worker, then sent / skipped / dead.
--   email_prefs_get / email_prefs_set      the person's own switches (authenticated).
--   email_unsubscribe(token, scope)        the signed-out, one-click opt-out
--                                          (anon + authenticated).
--   email_worker_online()    true when the e-mail worker has reported to
--                            worker_status (0045) in the last 3 minutes. The
--                            Settings switches are shown only then: a switch
--                            for mail nothing is sending would be a promise
--                            nobody keeps (authenticated; reveals nothing else).
--   email_claim_ready / email_claim_weekly / email_complete
--                            the e-mail worker's three functions (service key only).
--
-- WHO MAY DO WHAT
--   email_preferences, email_deliveries   no API role has any grant on either: RLS is
--                   on with no policy, every grant is revoked, and the rows are
--                   reached only through the functions below. The unsubscribe
--                   token therefore never travels to a browser: the only place
--                   it is read is email_claim_*, which hands it to the worker so
--                   the link can be put in the e-mail.
--   email_prefs_*   authenticated; they touch only auth.uid()'s own row.
--   email_unsubscribe   anon and authenticated. The token is 64 hex characters
--                   made from two random UUIDs (about 240 bits), compared by
--                   index lookup; a wrong or malformed token answers 'invalid'
--                   and nothing else, an unknown one reads exactly like a
--                   known-but-malformed one. It can only turn mail OFF.
--   email_claim_* / email_complete   service_role only. They are the only readers
--                   of notifications and auth.users on the e-mail path.
--
-- WHAT IS SENT, AND WHEN
--   ready    an in-app 'video_ready' or 'editor_export_done' notification, claimed
--            within 6 hours of being written (a "ready" mail a day late is noise,
--            and it keeps the first deploy from mailing a backlog). Transactional:
--            ON unless the person turns it off.
--   weekly   OPT-IN (the row says weekly_every_days is null until the person picks
--            a frequency). The first summary is due one interval after opting in.
--            A period with nothing to say (no video made, nothing waiting) is
--            recorded as 'skipped' and not mailed.
--   Both are re-checked against email_preferences at claim time, so an
--   unsubscribe made after a notification was written is honoured.
--   A notification carries no title and no prompt, so neither does a mail.
--
-- LANGUAGES
--   The account does not store a language today (it is a browser cookie), so the
--   best available source is stored here: the app reports the language the person
--   last used (email_prefs_set(p_locale)). The column is a code, never an allow-list;
--   the worker renders from templates keyed by code and writes English for a code it
--   has no template for.
--
-- NO INVENTED NUMBERS
--   The weekly digest counts rows that exist (notifications, held videos, ready
--   storyboards) and reads credits as the account holds them. With several
--   credit-bearing organizations, no account, or the platform's exempt
--   organization, credits_available is null — never 0 standing in for unknown.
--   No price appears anywhere here.
--
-- Nothing here spends, renders, publishes or changes a price, and no existing
-- function other than notify_storyboard_ready is replaced. Additive and
-- idempotent: guarded creates, drop-then-create constraints and triggers.
--
-- REQUIRES 0064 (notifications), 0045 (worker_status, optional: without it the switches stay hidden), 0016 (videos.publish_state), 0018 (organizations,
-- channels.org_id), 0020 (credits), 0057 (storyboards).

do $$
begin
  if to_regclass('public.notifications') is null
     or to_regprocedure('public.notification_emit_org_role(uuid, text, text, jsonb, text)') is null then
    raise exception '0103 needs the notifications: apply 0064_notifications.sql first';
  end if;
  if to_regclass('public.storyboards') is null then
    raise exception '0103 needs the storyboards: apply 0057_storyboard_review.sql first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'videos' and column_name = 'publish_state') then
    raise exception '0103 needs the held videos: apply 0016_held_videos.sql first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'channels' and column_name = 'org_id') then
    raise exception '0103 needs the channel owners: apply 0018_organizations.sql first';
  end if;
  if to_regclass('public.credit_accounts') is null or to_regprocedure('public.credits_exempt(uuid)') is null then
    raise exception '0103 needs the credit accounts: apply 0020_credits.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. A new kind
-- ───────────────────────────────────────────────────────────────────────────

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('creative_job_completed', 'creative_job_failed', 'storyboard_ready',
                  'editor_export_done', 'credits_low', 'video_ready'));

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Producers
-- ───────────────────────────────────────────────────────────────────────────

-- 0064's body, unchanged except for 'channel_id' in the data: a storyboard
-- belongs to one channel, and the person should see which.
create or replace function public.notify_storyboard_ready() returns trigger
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  org uuid;
begin
  begin
    select c.org_id into org from public.channels c where c.channel_id = new.channel_id;
    perform public.notification_emit_org_role(org, 'storyboard_ready', new.id::text,
      jsonb_build_object('storyboard_id', new.id, 'scenes', jsonb_array_length(new.scenes),
                         'channel_id', new.channel_id), 'admin');
  exception when others then
    raise warning 'notify_storyboard_ready: % (%)', sqlerrm, sqlstate;
  end;
  return new;
end
$$;

-- A run finished and now waits for a person. 'blocked' is not "ready" (the gate
-- refused it; there is nothing to approve) and 'uploaded' is not either (a
-- person already decided, or auto-publish did, and the held row's earlier
-- notification stands). The ref carries the state, so a repair's new cut tells
-- the person again while a row re-written in the same state does not.
create or replace function public.notify_video_ready() returns trigger
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  org uuid;
begin
  begin
    if new.publish_state is null
       or new.publish_state not in ('held', 'awaiting_approval', 'repaired_awaiting_review') then
      return new;
    end if;
    if tg_op = 'UPDATE' and old.publish_state is not distinct from new.publish_state then
      return new;
    end if;
    select c.org_id into org from public.channels c where c.channel_id = new.channel_id;
    if org is null then
      return new;
    end if;
    perform public.notification_emit_org_role(org, 'video_ready',
      left(new.video_id, 50) || ':' || new.publish_state,
      jsonb_build_object('video_id', left(new.video_id, 60), 'channel_id', new.channel_id,
                         'state', new.publish_state), 'admin');
  exception when others then
    raise warning 'notify_video_ready: % (%)', sqlerrm, sqlstate;
  end;
  return new;
end
$$;

drop trigger if exists videos_notify_ready on public.videos;
create trigger videos_notify_ready
  after insert or update of publish_state on public.videos
  for each row
  when (new.publish_state in ('held', 'awaiting_approval', 'repaired_awaiting_review'))
  execute function public.notify_video_ready();

-- ───────────────────────────────────────────────────────────────────────────
-- 3. E-mail: preferences and the delivery ledger
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.email_preferences (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  -- Transactional: "your video is ready". On until the person says no.
  ready_enabled     boolean not null default true,
  -- The weekly summary is opt-in: null = off. 7 or 14 days between summaries.
  weekly_every_days smallint check (weekly_every_days in (7, 14)),
  weekly_since      timestamptz,
  -- A language CODE (two or three lowercase letters), not an allow-list: the
  -- product's languages grow, and the e-mail renderer, which owns the list of
  -- languages it can write, falls back to English for a code it does not know.
  locale            text not null default 'en' check (locale ~ '^[a-z]{2,3}$'),
  -- 64 hex characters, two random UUIDs. Unguessable, revocable (replace the
  -- value), and never selectable by an API role.
  unsubscribe_token text not null unique
                    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
                    check (unsubscribe_token ~ '^[0-9a-f]{64}$'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check ((weekly_every_days is null) = (weekly_since is null))
);

comment on table public.email_preferences is
  'Per-person e-mail switches (migration 0103). Reached only through email_prefs_get / email_prefs_set / email_unsubscribe and the worker functions; no API role has a grant on it, so the unsubscribe token never reaches a browser.';

create table if not exists public.email_deliveries (
  user_id       uuid not null references auth.users (id) on delete cascade,
  kind          text not null check (kind in ('video_ready', 'editor_export_done', 'weekly')),
  ref           text not null check (char_length(ref) between 1 and 80 and ref !~ '[[:cntrl:]]'),
  status        text not null default 'claimed' check (status in ('claimed', 'sent', 'skipped', 'dead')),
  attempts      integer not null default 0 check (attempts between 0 and 5),
  claimed_by    text check (claimed_by is null or claimed_by ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  claimed_until timestamptz,
  error_code    text check (error_code is null or error_code ~ '^[a-z0-9_]{1,40}$'),
  created_at    timestamptz not null default now(),
  done_at       timestamptz,
  primary key (user_id, kind, ref)
);

create index if not exists email_deliveries_weekly_idx
  on public.email_deliveries (user_id, done_at desc) where kind = 'weekly';

comment on table public.email_deliveries is
  'One row per e-mail the worker has claimed, sent, skipped or given up on (migration 0103): the idempotency key is (user_id, kind, ref), the same triple as the notification it mirrors. Never holds an address, a body or provider text — only a machine code.';

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The person's own switches
-- ───────────────────────────────────────────────────────────────────────────

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
    return jsonb_build_object('ready', true, 'weekly_every_days', null, 'locale', 'en', 'stored', false);
  end if;
  return jsonb_build_object('ready', p.ready_enabled, 'weekly_every_days', p.weekly_every_days,
                            'locale', p.locale, 'stored', true);
end
$$;

-- Each argument left null stays as it is. p_weekly: 0 = off, 7 or 14 days.
-- The language is how the browser tells us what to write in: the app sends it
-- once per visit, and the Settings page when it is changed.
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
  if p_locale is not null and p_locale !~ '^[a-z]{2,3}$' then
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
         locale = coalesce(p_locale, locale),
         updated_at = now()
   where user_id = uid;
  return public.email_prefs_get();
end
$$;

-- The one-click opt-out behind the link in every e-mail. No session: the token
-- is the authority, and the only thing it can do is switch mail off.
-- scope: 'ready' | 'weekly' | 'all'.
create or replace function public.email_unsubscribe(p_token text, p_scope text) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' or p_scope is null or p_scope not in ('ready', 'weekly', 'all') then
    return 'invalid';
  end if;
  update public.email_preferences
     set ready_enabled = case when p_scope in ('ready', 'all') then false else ready_enabled end,
         weekly_every_days = case when p_scope in ('weekly', 'all') then null else weekly_every_days end,
         weekly_since = case when p_scope in ('weekly', 'all') then null else weekly_since end,
         updated_at = now()
   where unsubscribe_token = p_token;
  return case when found then 'ok' else 'invalid' end;
end
$$;

-- Is anything actually sending? The e-mail worker reports to worker_status
-- (migration 0045) as kind 'other' under an id that starts with 'email-', and
-- only when it is configured. A bare boolean: no worker id, no detail.
create or replace function public.email_worker_online() returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if to_regclass('public.worker_status') is null then
    return false;
  end if;
  return exists (select 1 from public.worker_status w
                  where w.kind = 'other' and w.worker_id like 'email-%'
                    and w.state in ('starting', 'running')
                    and w.updated_at > now() - interval '180 seconds');
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The weekly digest (internal) and the worker's functions (service key only)
-- ───────────────────────────────────────────────────────────────────────────

-- What the summary says, from rows that exist. Null when there is nothing to say.
create or replace function public.email_weekly_digest(p_user uuid, p_days integer) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  since timestamptz := now() - make_interval(days => p_days);
  videos_made integer;
  exports_made integer;
  generations_made integer;
  waiting_videos integer;
  waiting_boards integer;
  per_channel jsonb;
  credits numeric;
begin
  select count(distinct n.data ->> 'video_id') into videos_made
    from public.notifications n
   where n.user_id = p_user and n.kind = 'video_ready' and n.created_at >= since
     and exists (select 1 from public.org_members m where m.user_id = p_user and m.org_id = n.org_id);
  select count(*) into exports_made
    from public.notifications n
   where n.user_id = p_user and n.kind = 'editor_export_done' and n.created_at >= since
     and exists (select 1 from public.org_members m where m.user_id = p_user and m.org_id = n.org_id);
  select count(*) into generations_made
    from public.notifications n
   where n.user_id = p_user and n.kind = 'creative_job_completed' and n.created_at >= since
     and exists (select 1 from public.org_members m where m.user_id = p_user and m.org_id = n.org_id);

  -- Waiting for a decision: the same two rules the Home page applies (a held
  -- row has neither a publish time nor a privacy; a storyboard is 'ready').
  select count(*) into waiting_videos
    from public.videos v
    join public.channels c on c.channel_id = v.channel_id
   where v.published_at is null and v.privacy is null
     and exists (select 1 from public.org_members m where m.user_id = p_user and m.org_id = c.org_id);
  select count(*) into waiting_boards
    from public.storyboards s
    join public.channels c on c.channel_id = s.channel_id
   where s.status = 'ready'
     and exists (select 1 from public.org_members m where m.user_id = p_user and m.org_id = c.org_id);

  if coalesce(videos_made, 0) + coalesce(exports_made, 0) + coalesce(generations_made, 0)
     + coalesce(waiting_videos, 0) + coalesce(waiting_boards, 0) = 0 then
    return null;
  end if;

  select coalesce(jsonb_agg(x.o order by x.sort desc, x.name), '[]'::jsonb) into per_channel
    from (
      select c.name,
             coalesce(h.k, 0) + coalesce(b.k, 0) + coalesce(mk.k, 0) as sort,
             jsonb_build_object('id', c.channel_id, 'name', c.name,
                                'avatar', c.credential_ref ->> 'youtube_thumbnail',
                                'made', coalesce(mk.k, 0),
                                'waiting_videos', coalesce(h.k, 0),
                                'waiting_storyboards', coalesce(b.k, 0)) as o
        from public.channels c
        left join (select v.channel_id, count(*) k from public.videos v
                    where v.published_at is null and v.privacy is null group by 1) h on h.channel_id = c.channel_id
        left join (select s.channel_id, count(*) k from public.storyboards s
                    where s.status = 'ready' group by 1) b on b.channel_id = c.channel_id
        left join (select n.data ->> 'channel_id' as channel_id, count(distinct n.data ->> 'video_id') k
                     from public.notifications n
                    where n.user_id = p_user and n.kind = 'video_ready' and n.created_at >= since
                    group by 1) mk on mk.channel_id = c.channel_id
       where exists (select 1 from public.org_members m where m.user_id = p_user and m.org_id = c.org_id)
         and coalesce(h.k, 0) + coalesce(b.k, 0) + coalesce(mk.k, 0) > 0
       order by 2 desc, c.name
       limit 8
    ) x;

  -- Credits as held, only when there is exactly one credit-bearing account to
  -- speak about; otherwise unknown, which is not 0.
  select case when count(*) = 1 then max(a.balance - a.reserved) end into credits
    from public.org_members m
    join public.credit_accounts a on a.org_id = m.org_id
   where m.user_id = p_user and not public.credits_exempt(m.org_id);

  return jsonb_build_object(
    'days', p_days,
    'videos_made', videos_made, 'exports_made', exports_made, 'generations_made', generations_made,
    'waiting_videos', waiting_videos, 'waiting_storyboards', waiting_boards,
    'channels', per_channel,
    'credits_available', credits);
end
$$;

-- Claim up to p_limit "ready" mails: each a notification written in the last 6
-- hours, not yet mailed, for a person whose address is confirmed and who has
-- not switched ready mail off. Returns a json array; each element is
-- everything the worker needs to write one mail (and nothing else).
create or replace function public.email_claim_ready(
  p_worker text, p_limit integer default 20, p_lease_seconds integer default 300
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  n record;
  addr text;
  confirmed timestamptz;
  pref public.email_preferences;
  ch jsonb;
  claimed integer;
  taken integer := 0;
  result jsonb := '[]'::jsonb;
begin
  if p_worker is null or p_worker !~ '^[A-Za-z0-9_.:-]{1,64}$' then
    raise exception 'bad_worker' using errcode = '22023';
  end if;
  p_limit := greatest(1, least(coalesce(p_limit, 20), 100));
  p_lease_seconds := greatest(30, least(coalesce(p_lease_seconds, 300), 3600));
  delete from public.email_deliveries where created_at < now() - interval '60 days';

  for n in
    select x.id, x.user_id, x.org_id, x.kind, x.ref, x.data, x.created_at
      from public.notifications x
     where x.kind in ('video_ready', 'editor_export_done')
       and x.created_at > now() - interval '6 hours'
       and not exists (select 1 from public.email_deliveries d
                        where d.user_id = x.user_id and d.kind = x.kind and d.ref = x.ref
                          and (d.status <> 'claimed' or d.claimed_until > now()))
     order by x.created_at, x.id
     limit p_limit * 4
  loop
    exit when taken >= p_limit;

    select u.email, u.email_confirmed_at into addr, confirmed from auth.users u where u.id = n.user_id;
    if not found or addr is null or addr = '' or confirmed is null then
      insert into public.email_deliveries (user_id, kind, ref, status, error_code, done_at)
      values (n.user_id, n.kind, n.ref, 'skipped', 'no_address', now())
      on conflict (user_id, kind, ref) do nothing;
      continue;
    end if;

    select * into pref from public.email_preferences where user_id = n.user_id;
    if found and not pref.ready_enabled then
      insert into public.email_deliveries (user_id, kind, ref, status, error_code, done_at)
      values (n.user_id, n.kind, n.ref, 'skipped', 'opted_out', now())
      on conflict (user_id, kind, ref) do nothing;
      continue;
    end if;
    if not found then
      insert into public.email_preferences (user_id) values (n.user_id) on conflict (user_id) do nothing;
      select * into pref from public.email_preferences where user_id = n.user_id;
    end if;

    insert into public.email_deliveries (user_id, kind, ref, status, attempts, claimed_by, claimed_until)
    values (n.user_id, n.kind, n.ref, 'claimed', 1, p_worker, now() + make_interval(secs => p_lease_seconds))
    on conflict (user_id, kind, ref) do update
       set attempts = public.email_deliveries.attempts + 1,
           claimed_by = excluded.claimed_by,
           claimed_until = excluded.claimed_until
     where public.email_deliveries.status = 'claimed'
       and public.email_deliveries.claimed_until <= now()
       and public.email_deliveries.attempts < 5;
    get diagnostics claimed = row_count;
    if claimed = 0 then
      continue;
    end if;

    -- The channel the mail is about: only one the notification's own
    -- organization owns, so an id in the data can never name another tenant's.
    ch := null;
    if n.data ? 'channel_id' then
      select jsonb_build_object('id', c.channel_id, 'name', c.name,
                                'avatar', c.credential_ref ->> 'youtube_thumbnail')
        into ch
        from public.channels c
       where c.channel_id = n.data ->> 'channel_id' and c.org_id = n.org_id;
    end if;

    taken := taken + 1;
    result := result || jsonb_build_array(jsonb_build_object(
      'user_id', n.user_id, 'email', addr, 'locale', pref.locale, 'token', pref.unsubscribe_token,
      'kind', n.kind, 'ref', n.ref, 'data', n.data, 'created_at', n.created_at, 'channel', ch));
  end loop;
  return result;
end
$$;

-- Claim up to p_limit weekly summaries that are due. A summary with nothing to
-- say is recorded as 'skipped' (the period is used up) and is not returned.
create or replace function public.email_claim_weekly(
  p_worker text, p_limit integer default 20, p_lease_seconds integer default 300
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  p public.email_preferences;
  addr text;
  confirmed timestamptz;
  last_done timestamptz;
  digest jsonb;
  day_ref text := to_char(now() at time zone 'utc', 'YYYY-MM-DD');
  claimed integer;
  taken integer := 0;
  result jsonb := '[]'::jsonb;
begin
  if p_worker is null or p_worker !~ '^[A-Za-z0-9_.:-]{1,64}$' then
    raise exception 'bad_worker' using errcode = '22023';
  end if;
  p_limit := greatest(1, least(coalesce(p_limit, 20), 100));
  p_lease_seconds := greatest(30, least(coalesce(p_lease_seconds, 300), 3600));

  for p in
    select * from public.email_preferences where weekly_every_days is not null order by weekly_since, user_id
  loop
    exit when taken >= p_limit;

    select max(d.done_at) into last_done from public.email_deliveries d
     where d.user_id = p.user_id and d.kind = 'weekly' and d.status in ('sent', 'skipped', 'dead');
    -- Due one interval after the last summary (sent, skipped or given up), or
    -- after the person opted in.
    continue when coalesce(last_done, p.weekly_since, p.updated_at)
                  + make_interval(days => p.weekly_every_days) > now();
    -- Someone else holds it right now.
    continue when exists (select 1 from public.email_deliveries d
                           where d.user_id = p.user_id and d.kind = 'weekly'
                             and d.status = 'claimed' and d.claimed_until > now());

    select u.email, u.email_confirmed_at into addr, confirmed from auth.users u where u.id = p.user_id;
    if not found or addr is null or addr = '' or confirmed is null then
      insert into public.email_deliveries (user_id, kind, ref, status, error_code, done_at)
      values (p.user_id, 'weekly', day_ref, 'skipped', 'no_address', now())
      on conflict (user_id, kind, ref) do nothing;
      continue;
    end if;

    digest := public.email_weekly_digest(p.user_id, p.weekly_every_days);
    if digest is null then
      insert into public.email_deliveries (user_id, kind, ref, status, error_code, done_at)
      values (p.user_id, 'weekly', day_ref, 'skipped', 'nothing_to_say', now())
      on conflict (user_id, kind, ref) do nothing;
      continue;
    end if;

    insert into public.email_deliveries (user_id, kind, ref, status, attempts, claimed_by, claimed_until)
    values (p.user_id, 'weekly', day_ref, 'claimed', 1, p_worker, now() + make_interval(secs => p_lease_seconds))
    on conflict (user_id, kind, ref) do update
       set attempts = public.email_deliveries.attempts + 1,
           claimed_by = excluded.claimed_by,
           claimed_until = excluded.claimed_until
     where public.email_deliveries.status = 'claimed'
       and public.email_deliveries.claimed_until <= now()
       and public.email_deliveries.attempts < 5;
    get diagnostics claimed = row_count;
    if claimed = 0 then
      continue;
    end if;

    taken := taken + 1;
    result := result || jsonb_build_array(jsonb_build_object(
      'user_id', p.user_id, 'email', addr, 'locale', p.locale, 'token', p.unsubscribe_token,
      'kind', 'weekly', 'ref', day_ref, 'digest', digest));
  end loop;
  return result;
end
$$;

-- The worker's verdict on a claimed mail: 'sent', 'retry' (a lease backoff;
-- the fifth failed attempt gives up) or 'dead' (a permanent refusal). True when
-- a claimed row was updated.
create or replace function public.email_complete(
  p_user uuid, p_kind text, p_ref text, p_outcome text, p_error text default null
) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if p_outcome is null or p_outcome not in ('sent', 'retry', 'dead') then
    raise exception 'bad_outcome' using errcode = '22023';
  end if;
  if p_error is not null and p_error !~ '^[a-z0-9_]{1,40}$' then
    p_error := 'error';
  end if;
  update public.email_deliveries d
     set status = case when p_outcome = 'sent' then 'sent'
                       when p_outcome = 'dead' or d.attempts >= 5 then 'dead'
                       else 'claimed' end,
         claimed_until = case when p_outcome = 'retry' and d.attempts < 5
                              then now() + make_interval(mins => 2 * d.attempts) else null end,
         error_code = case when p_outcome = 'sent' then null else p_error end,
         done_at = case when p_outcome = 'sent' or p_outcome = 'dead' or d.attempts >= 5 then now() else null end
   where d.user_id = p_user and d.kind = p_kind and d.ref = p_ref and d.status = 'claimed';
  return found;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Access
-- ───────────────────────────────────────────────────────────────────────────

alter table public.email_preferences enable row level security;
alter table public.email_deliveries enable row level security;
revoke all on public.email_preferences from public, anon, authenticated, service_role;
revoke all on public.email_deliveries from public, anon, authenticated, service_role;
-- No policy on either table: with RLS on, that is a refusal for every API role.

revoke all on function public.notify_video_ready() from public, anon, authenticated, service_role;
revoke all on function public.notify_storyboard_ready() from public, anon, authenticated, service_role;
revoke all on function public.email_weekly_digest(uuid, integer) from public, anon, authenticated, service_role;

revoke all on function public.email_prefs_get() from public, anon, authenticated, service_role;
revoke all on function public.email_prefs_set(boolean, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.email_prefs_get() to authenticated;
grant execute on function public.email_prefs_set(boolean, integer, text) to authenticated;

revoke all on function public.email_worker_online() from public, anon, authenticated, service_role;
grant execute on function public.email_worker_online() to authenticated;

revoke all on function public.email_unsubscribe(text, text) from public, anon, authenticated, service_role;
grant execute on function public.email_unsubscribe(text, text) to anon, authenticated;

revoke all on function public.email_claim_ready(text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.email_claim_weekly(text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.email_complete(uuid, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.email_claim_ready(text, integer, integer) to service_role;
grant execute on function public.email_claim_weekly(text, integer, integer) to service_role;
grant execute on function public.email_complete(uuid, text, text, text, text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select relrowsecurity from pg_class where oid = 'public.email_preferences'::regclass)
--     and (select relrowsecurity from pg_class where oid = 'public.email_deliveries'::regclass) as rls_on,
--   not has_table_privilege('authenticated', 'public.email_preferences', 'SELECT')
--     and not has_table_privilege('anon', 'public.email_preferences', 'SELECT')
--     and not has_table_privilege('service_role', 'public.email_preferences', 'SELECT')
--     and not has_table_privilege('authenticated', 'public.email_deliveries', 'SELECT')
--     and not has_table_privilege('service_role', 'public.email_deliveries', 'SELECT') as tables_closed,
--   has_function_privilege('authenticated', 'public.email_prefs_set(boolean,integer,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.email_prefs_set(boolean,integer,text)', 'EXECUTE')
--     and has_function_privilege('anon', 'public.email_unsubscribe(text,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.email_claim_ready(text,integer,integer)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.email_claim_weekly(text,integer,integer)', 'EXECUTE')
--     and has_function_privilege('service_role', 'public.email_claim_ready(text,integer,integer)', 'EXECUTE')
--     and has_function_privilege('service_role', 'public.email_complete(uuid,text,text,text,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.email_weekly_digest(uuid,integer)', 'EXECUTE') as functions_scoped,
--   (select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
--      from pg_proc p where p.pronamespace = 'public'::regnamespace
--       and p.proname in ('notify_video_ready', 'notify_storyboard_ready', 'email_prefs_get', 'email_prefs_set',
--                         'email_unsubscribe', 'email_weekly_digest', 'email_claim_ready', 'email_claim_weekly',
--                         'email_complete', 'email_worker_online')) as definer_functions_pin_search_path,
--   exists (select 1 from pg_trigger where tgname = 'videos_notify_ready' and not tgisinternal) as video_trigger_on,
--   (select pg_get_constraintdef(oid) like '%video_ready%' from pg_constraint
--     where conname = 'notifications_kind_check' and conrelid = 'public.notifications'::regclass) as kind_accepted;
