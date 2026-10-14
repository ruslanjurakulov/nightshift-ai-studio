-- 0101_site_page_views.sql — first-party, cookieless page-view counts for the PUBLIC site.
--
-- The owner wants to know which public pages are read, without a third-party
-- tracker, a cookie, or anything that could single a visitor out. This file
-- is the whole database side of that, and it is deliberately small: ONE table
-- of daily totals and ONE function that adds one to a total.
--
-- WHAT IS STORED (and nothing else)
--   site_page_views   one row per (day, path, referring host, device, language)
--                     holding how many times that combination was viewed:
--                       day       the UTC date
--                       path      one of a CLOSED list of public marketing pages
--                                 (site_page_path_ok); never /api, never an app page
--                       ref_host  the HOST of the referring site ("news.example"),
--                                 never a path or query; '' for a direct visit;
--                                 'other' once a day's table is full (see the cap)
--                       device    'mobile' or 'desktop'
--                       lang      the language code the page was shown in ('en', 'ru', ...):
--                                 two or three lowercase letters. The list of languages the
--                                 site speaks lives in the app (lib/i18n/core.ts), which
--                                 only ever sends one of them, so adding a language needs no
--                                 migration here; 'xx' once a day's table is full.
--                       views     the count
--   There is no visitor id, no session id, no IP address, no user agent, no
--   timestamp finer than a day, and no column that could hold one: a row
--   cannot be traced to a person because no row describes a person.
--
-- WHO MAY DO WHAT
--   RLS is on and there is NO policy: no API role (anon, authenticated) can
--   read, insert, update or delete the table. Only record_page_view() writes
--   it, and it is the only thing anon may call. Reading is for the owner, in
--   the SQL editor (see "Read it" below); there is no read function on
--   purpose — the smallest surface is one write function.
--
-- WHAT record_page_view() DOES
--   * SECURITY DEFINER, search_path pinned. Validates every argument against
--     a closed list or a strict format and, if anything is wrong, returns
--     without writing and without an error (an attacker learns nothing).
--   * Platform-wide ceiling: 600 counted views a minute across everyone
--     (web_rate_counters, the same shared window the sign-up username check
--     uses, 0096). Past it a view is simply not counted.
--   * Row cap: once a day already has 3000 rows, a view whose combination has
--     no row yet is counted under referring host 'other' and language 'xx', so
--     the table cannot be grown without bound by inventing hosts or language
--     codes. The closed path list and two devices bound every other column.
--   * The Node route in front of it (app/api/pv) additionally ignores
--     Do-Not-Track / Global Privacy Control, known bots (by a closed list,
--     the user agent is never stored) and cross-site requests. A caller can
--     still call this function directly with the public anon key; the worst
--     that buys them is inflated counts of public pages, capped at 600 a
--     minute, never data.
--
-- Additive and idempotent (guarded creates, create-or-replace functions,
-- repeatable revokes). Requires 0042/0087 (web_rate_counters). Safe to run twice.
--
-- Read it (owner, SQL editor):
--   select path, sum(views) as views from public.site_page_views
--    where day >= current_date - 30 group by path order by views desc;
--   select ref_host, sum(views) as views from public.site_page_views
--    where day >= current_date - 30 and ref_host <> '' group by ref_host order by views desc limit 20;
--   select day, sum(views) as views from public.site_page_views
--    where day >= current_date - 30 group by day order by day;
--   select device, lang, sum(views) as views from public.site_page_views
--    where day >= current_date - 30 group by device, lang order by views desc;
--
-- Retention: rows are aggregate counts with no personal data; keep them. If you
-- ever want to prune: delete from public.site_page_views where day < current_date - 400;

do $$
begin
  if to_regclass('public.web_rate_counters') is null then
    raise exception '0101 needs 0042/0087 (web_rate_counters): apply 0042_web_api_hardening.sql and 0087_audit_and_rate_hardening.sql first';
  end if;
  -- The ceiling counts under 'pageview.anon@60'; the '@' form needs 0087's wider bucket check.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.web_rate_counters'::regclass
       and conname = 'web_rate_counters_bucket_check'
       and pg_get_constraintdef(oid) like '%@%'
  ) then
    raise exception '0101 needs 0087 (web_rate_counters bucket check allows @): apply 0087_audit_and_rate_hardening.sql first';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The closed list of countable pages (pure; callable by nobody via the API)
--    Must equal SITEMAP_PATHS in command-center/lib/public-paths.ts
--    (command-center/tests/page-views.test.ts compares the two).
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.site_page_path_ok(p text) returns boolean
  language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select p = any (array[
    '/', '/studio', '/pricing',
    '/solutions', '/solutions/youtube-channels', '/solutions/creative-studio', '/solutions/developers',
    '/docs/api', '/mcp', '/privacy', '/terms'
  ])
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The table: daily totals, no row about a person
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.site_page_views (
  day      date    not null,
  path     text    not null,
  ref_host text    not null default '',
  device   text    not null,
  lang     text    not null,
  views    integer not null default 0,
  primary key (day, path, ref_host, device, lang),
  constraint site_page_views_path_closed check (public.site_page_path_ok(path)),
  constraint site_page_views_ref_host_shape check (ref_host = '' or ref_host ~ '^[a-z0-9]([a-z0-9.-]{0,98}[a-z0-9])?$'),
  constraint site_page_views_device_closed check (device in ('mobile', 'desktop')),
  constraint site_page_views_lang_shape check (lang ~ '^[a-z]{2,3}$'),
  constraint site_page_views_views_positive check (views >= 0)
);
comment on table public.site_page_views is
  'Daily page-view totals for the public site (0101): per day, public path, referring HOST, device class and language. No visitor, session, IP, user agent or time of day is stored. No API role reads or writes it; record_page_view() adds one.';
alter table public.site_page_views enable row level security;
revoke all on public.site_page_views from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Count one view (the only write path)
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.record_page_view(p_path text, p_ref_host text, p_device text, p_lang text)
  returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_path   text := coalesce(p_path, '');
  v_ref    text := lower(coalesce(p_ref_host, ''));
  v_device text := coalesce(p_device, '');
  v_lang   text := coalesce(p_lang, '');
  v_day    date := (now() at time zone 'utc')::date;
  v_start  timestamptz := to_timestamp(floor(extract(epoch from now()) / 60) * 60);
  v_used   integer;
begin
  -- Anything outside the closed lists is not counted, and says nothing about why.
  if not public.site_page_path_ok(v_path)
     or v_device not in ('mobile', 'desktop')
     or v_lang !~ '^[a-z]{2,3}$' then
    return;
  end if;
  -- A host that is not a plain host name is read as a direct visit, never stored as given.
  if v_ref <> '' and v_ref !~ '^[a-z0-9]([a-z0-9.-]{0,98}[a-z0-9])?$' then
    v_ref := '';
  end if;

  -- Platform-wide ceiling: 600 counted views a minute, whoever calls and however.
  insert into public.web_rate_counters as c (user_id, bucket, window_start, count)
  values ('00000000-0000-0000-0000-000000000000', 'pageview.anon@60', v_start, 1)
  on conflict (user_id, bucket, window_start) do update set count = c.count + 1
  returning c.count into v_used;
  if v_used = 1 then
    delete from public.web_rate_counters c
     where c.user_id = '00000000-0000-0000-0000-000000000000'
       and c.bucket = 'pageview.anon@60' and c.window_start < v_start;
  end if;
  if v_used > 600 then
    return;
  end if;

  -- Row cap: a day that already holds 3000 rows takes no NEW combination by name; it is folded into 'other' / 'xx'.
  if not exists (select 1 from public.site_page_views
                  where day = v_day and path = v_path and ref_host = v_ref and device = v_device and lang = v_lang)
     and (select count(*) from public.site_page_views where day = v_day) >= 3000 then
    if v_ref <> '' then v_ref := 'other'; end if;
    v_lang := 'xx';
  end if;

  insert into public.site_page_views as s (day, path, ref_host, device, lang, views)
  values (v_day, v_path, v_ref, v_device, v_lang, 1)
  on conflict (day, path, ref_host, device, lang) do update set views = s.views + 1;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Grants (explicit; nothing is left to the default PUBLIC execute)
-- ─────────────────────────────────────────────────────────────────────────

revoke all on function public.site_page_path_ok(text) from public, anon, authenticated, service_role;

revoke all on function public.record_page_view(text, text, text, text) from public, service_role;
grant execute on function public.record_page_view(text, text, text, text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor; every column should read true)
-- ─────────────────────────────────────────────────────────────────────────
--   select (select relrowsecurity from pg_class where oid = 'public.site_page_views'::regclass) as rls_on,
--          not (select count(*) > 0 from pg_policies where tablename = 'site_page_views') as no_policy,
--          not has_table_privilege('anon', 'public.site_page_views', 'SELECT')
--            and not has_table_privilege('authenticated', 'public.site_page_views', 'SELECT')
--            and not has_table_privilege('anon', 'public.site_page_views', 'INSERT')
--            and not has_table_privilege('authenticated', 'public.site_page_views', 'UPDATE') as table_closed,
--          has_function_privilege('anon', 'public.record_page_view(text,text,text,text)', 'EXECUTE')
--            and not has_function_privilege('anon', 'public.site_page_path_ok(text)', 'EXECUTE') as function_acl,
--          public.site_page_path_ok('/pricing') and not public.site_page_path_ok('/api/v1/models')
--            and not public.site_page_path_ok('/chronos/videos') as closed_list;
