-- 0133_brand_scan.sql — Ads Factory, Phase 2: the brand scan (docs/ADS_FACTORY.md, "Phase 2: brand scan").
-- A person proves they own a domain with a DNS TXT record, asks for one priced scan of a page on it, and a worker reads a few public pages of
-- that site (modules/brand_fetch.py), proposes brand fields with where each came from, and the person copies the fields they choose into a
-- brand kit, one by one. Nothing is accepted automatically, nothing calls a model.
--
-- *** LIVE ON APPLY. *** Merging this file applies it to the live database. It ADDS four tables, nine internal functions, five functions a
-- signed-in member may call and five the platform's worker calls (service_role). It replaces NOTHING that exists there: no existing function,
-- table, column, policy or grant is changed (tests/test_brand_scan_migration.py pins that no `create or replace` names an older function and
-- no `alter table` an older table; the last block asserts the end state). It is DARK in the application: the Command Center shows the scan
-- only with NIGHTSHIFT_ADS_BRAND_SCAN=on, and the worker (tools/brand_scan_worker.py) claims nothing while that switch is off. The DATABASE
-- is not dark: the five member functions are granted to `authenticated` from the moment this applies, so a signed-in editor can ask for a
-- domain check or a scan directly through PostgREST. That is why the scan is NOT ON SALE until the owner sets a price: the seed price is
-- NULL and request_brand_scan refuses `not_on_sale` while it is (the domain functions only write a token and queue a DNS check nobody
-- claims while the worker is off; both have caps). Rows made that way are real rows: the rollback refuses while any exist unless told.
--
-- WHAT IT DOES NOT DO. No model is called, nothing is published, no video's privacy changes, nothing in a browser fetches a site or a DNS
-- record (the worker does, docs/ADS_FACTORY.md "The fetch"). A scan never writes a brand kit by itself: accept_brand_scan_fields copies only
-- the fields a person names, through 0131's cleaning and caps.
--
-- NUMBER. 0133: the highest on main is 0131 (#669's parent, Ads Factory Phase 1). 0132 is reserved by another open pull request (the hi-res
-- export) and is not taken here; this file names nothing it adds, and it names nothing this file adds, so they apply in either order.
--
-- APPLY AS ONE TRANSACTION: the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1. `set local lock_timeout`
-- assumes it, and the last block asserts the end state, so a half-applied file cannot be left behind.
--
-- WHAT IT ADDS
--   brand_domains        a host an organization says it owns: the host (a lower-case DNS name, never a bare public suffix or a shared hosting
--                        parent such as co.uk or myshopify.com: ads_hosting_parent), a random token, and when the worker last found the TXT
--                        record `nightshift-verify=<token>` at `_nightshift.<host>` (verified_at, verified_by: who asked for that check).
--                        An underscore label, not the apex: the apex's TXT records are SPF and others' tokens, and `_nightshift` keeps ours
--                        apart (RFC 8552's convention, as `_acme-challenge` and `_dmarc`). At most 10 per organization.
--   brand_domain_checks  one row per "Check now": who asked, when the worker took it, what it found (ok, a closed code). The worker's queue.
--   brand_scans          one priced scan: the entry URL (0131's site shape), its host, the verified domain it ran under, status
--                        requested | running | ready | failed, a closed error code, the result (bounded jsonb: proposed fields, each with the
--                        page and the place it came from: brand_scan_result_ok), the credits held / charged, an idempotency key and request
--                        hash, and which fields a person accepted into which kit.
--   brand_scan_settings  one row: price_credits (NULL = not on sale; the seed), platform_daily_scans (500), platform_daily_checks (5000).
--
-- OWNERSHIP (the owner's decision: the strong form). A scan runs only under a VERIFIED domain of the same organization that is the scan's host
-- or a parent of it (verified shop.com covers www.shop.com and shop.com; it does not cover shop.co.uk or othershop.com). The worker reads the
-- TXT record again when it starts the scan and fails the scan (`ownership_not_proven`, credits released) if it is gone. The record is read over
-- DNS-over-HTTPS from one fixed public resolver (modules/dns_txt.py): the answer arrives over TLS, so nobody on the path can forge it, and only
-- a TXT record at `_nightshift.<host>` ITSELF counts (a CNAME pointing elsewhere does not).
--
-- MONEY (the owner's decision: priced per scan, at cost, the price itself limits volume). The price is brand_scan_settings.price_credits, never
-- anything the client sends, and it is NOT raised to the platform's job_minimum (the owner's decision: a scan costs its own price). But
-- reserve_credits refuses any hold below job_minimum, and no shared money function is changed here, so request_brand_scan HOLDS
-- greatest(price, job_minimum) (reserve_credits, through 0036's creative_platform_reserve after checking the editor role itself, exactly as
-- create_creative_job does), the worker's finish CAPTURES exactly the price (capture_credits, which releases the rest of the hold in the same
-- transaction), and a failure RELEASES the whole hold (release_credits); a scan nobody took within 2 hours, or whose worker went quiet for 15
-- minutes, is failed and released by the next claim or request. With job_minimum 30 and a price of 1: 30 held while it runs, 1 charged. A
-- person without the hold available is refused `scan_hold_unavailable` (NS402, detail hold=… price=…). The caller confirms the price it was
-- shown (p_max_credits, compared with the charged price, never the hold): a higher price is `price_changed`, never charged. The exempt organization (the operator's) is not charged, and only a platform admin may
-- scan there (create_creative_job's rule). A hold counts as one of the plan's parallel runs (0034), as every hold does.
--
-- CAPS. One scan in flight per organization (a unique index: requested or running). Platform-wide per 24 hours: scans (all statuses, failed
-- ones too) and domain checks, under one platform lock taken AFTER the organization's (0127's order). The platform's refusal carries no
-- number. 10 domains per organization and one check per domain per 15 seconds are fixed, not settings.
--
-- LOCK ORDER. As 0131: no function holds a row lock while it waits for an advisory lock. request_brand_scan / request_domain_verification /
-- check_domain_verification read without a lock, check sign-in and the role, take the organization's lock ('brand_scan:' || org), then the
-- platform's where it counts a cap, and only then touch rows (the credit account inside reserve_credits). accept_brand_scan_fields takes
-- 0131's organization lock ('ads_factory:' || org, because it writes kits and products under 0131's caps) and then locks the kit row, as
-- 0131's writers do. The worker's functions take no advisory lock: a scan row, then the credit account (capture / release lock the account).
--
-- TEXT. Every string the worker proposes is checked here as 0131 stores text (ads_text_ok: no control or invisible character, no run of
-- spaces, within the length) and copied into a kit only through ads_clean_text and 0131's checks. Colours are #rrggbb, fonts are names
-- (ads_text_list_ok), pictures are live images of the organization's own library (ads_check_images): the worker stores a logo or a product
-- picture through the media library (register_asset sniffs and records it), never a link to the site.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; the SQL editor on the live project). None of the names may exist yet (expected: no row):
--     select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace
--       and c.relname in ('brand_domains', 'brand_domain_checks', 'brand_scans', 'brand_scan_settings');
--     select p.oid::regprocedure from pg_proc p where p.pronamespace = 'public'::regnamespace
--       and p.proname in ('ads_hosting_parent', 'ads_scan_host_ok', 'ads_scan_url_ok', 'brand_scan_field_ok', 'brand_scan_result_ok',
--                         'brand_scan_price', 'brand_scan_fail_locked', 'brand_scan_settings_guard', 'brand_scan_settings_trail',
--                         'request_domain_verification', 'check_domain_verification', 'quote_brand_scan', 'request_brand_scan',
--                         'accept_brand_scan_fields', 'claim_domain_check', 'finish_domain_check', 'claim_brand_scan', 'finish_brand_scan',
--                         'fail_brand_scan');
--   The prerequisites (expected: one row, all true):
--     select to_regprocedure('public.ads_clean_text(text, boolean)') is not null, to_regprocedure('public.ads_check_images(uuid, uuid[], integer)') is not null,
--            to_regprocedure('public.creative_platform_reserve(uuid, text, numeric)') is not null,
--            to_regprocedure('public.creative_platform_release(text)') is not null,
--            to_regprocedure('public.capture_credits(text, numeric, boolean)') is not null,
--            to_regprocedure('public.start_credit_reservation(text, uuid)') is not null;
--
-- Additive and idempotent: create table if not exists, drop constraint then add, create or replace, drop trigger / policy then create, revoke
-- then grant, seed `on conflict do nothing` (a replay never undoes the owner's price). An applied migration is never edited.
-- Rollback: docs/sql/rollback_0133_brand_scan.sql (drops exactly what this file added; refuses while rows exist unless told they may go).
-- REQUIRES 0018 (organizations, is_org_member, accessible_org_ids, is_platform_admin), 0020 / 0034 / 0094 (credits), 0036
-- (creative_platform_reserve / creative_platform_release), 0038 (media_assets), 0107 (security_event_log) and 0131 (brand kits and the text
-- rules).

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.is_org_member(uuid, text)') is null or to_regprocedure('public.accessible_org_ids(text)') is null
     or to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0133 needs 0018_organizations.sql: apply it first';
  end if;
  if to_regprocedure('public.capture_credits(text, numeric, boolean)') is null or to_regprocedure('public.release_credits(text)') is null
     or to_regprocedure('public.start_credit_reservation(text, uuid)') is null or to_regprocedure('public.credits_exempt(uuid)') is null
     or to_regprocedure('public.credits_trusted_caller()') is null then
    raise exception '0133 needs 0020_credits.sql: apply it first';
  end if;
  if to_regprocedure('public.creative_platform_reserve(uuid, text, numeric)') is null
     or to_regprocedure('public.creative_platform_release(text)') is null then
    raise exception '0133 needs 0036_creative_jobs.sql (creative_platform_reserve / creative_platform_release): apply it first';
  end if;
  if to_regprocedure('public.security_event_log(text, text, text, jsonb)') is null then
    raise exception '0133 needs 0107_owner_safety.sql (security_event_log): apply it first';
  end if;
  if to_regclass('public.brand_kits') is null or to_regprocedure('public.ads_clean_text(text, boolean)') is null
     or to_regprocedure('public.ads_text_ok(text, integer, integer, boolean)') is null
     or to_regprocedure('public.ads_check_images(uuid, uuid[], integer)') is null then
    raise exception '0133 needs 0131_ads_factory.sql (brand kits and the text rules): apply it first';
  end if;
end $$;

-- A function of one of this file's names that already exists must be this file's (a replay). md5 of prosrc with every run of white space
-- read as one space; tests/test_brand_scan_migration.py recomputes every hash from this file.
do $$
declare
  r   record;
  got text;
begin
  for r in
    select * from (values
      ('public.ads_hosting_parent(text)', '45b9424f94ca9f4b9f7e9065418ed46b'),
      ('public.ads_scan_host_ok(text)', '1034a7f8c6322e8f03d58d08f7704425'),
      ('public.ads_scan_url_ok(text)', 'd734d3fedb41ffed175eae91287e449c'),
      ('public.brand_scan_field_ok(jsonb, text)', '353d784aab148ab2af4324383bdeae51'),
      ('public.brand_scan_result_ok(jsonb)', '05e268084c5d68c2291897ce2f759d44'),
      ('public.brand_scan_price()', '596c0cd1d82759855ae5496b6acf20b0'),
      ('public.brand_scan_fail_locked(uuid, text)', '2ed1f012de9cb7e16df70d7cc748cc91'),
      ('public.brand_scan_settings_guard()', 'd55aaee7b70dc8655a5fb02f3682a5bb'),
      ('public.brand_scan_settings_trail()', 'c5f5e10faae661c30f58a25e2ff5b5aa'),
      ('public.request_domain_verification(uuid, text)', '5cf3a05a1cd6291caa58b7bfb4f41ab7'),
      ('public.check_domain_verification(uuid)', '9da8c07a8a5d7fc194b796eb8c35a2d6'),
      ('public.quote_brand_scan(uuid)', 'ba5d8b562c6893d8b0ef49ff4392d8b2'),
      ('public.request_brand_scan(uuid, text, text, numeric)', '812a6131a465414f5b0235f6f705fe5a'),
      ('public.accept_brand_scan_fields(uuid, uuid, text[])', '33e5092fed2d2b50b594eae230aaffb1'),
      ('public.claim_domain_check(text)', '82141353f6d88e824d4d299fa34b8890'),
      ('public.finish_domain_check(uuid, text, boolean, text)', '62b0880595b8713fa3ba8d93c146c7f0'),
      ('public.claim_brand_scan(text)', 'ccab2f97d979a930735b44fed06b237f'),
      ('public.finish_brand_scan(uuid, text, jsonb)', '0b99232ecc4459e5b4e344fdee9eab81'),
      ('public.fail_brand_scan(uuid, text, text)', '0e47d8da1effbdbadd16f309a3263c45')
    ) v(sig, want)
  loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into got from pg_proc p where p.oid = to_regprocedure(r.sig);
    if got is not null and got <> r.want then
      raise exception '0133 found a % that is not 0133''s body (md5 %): read the live body first', r.sig, got;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Shapes (internal: no API role may call them)
-- ───────────────────────────────────────────────────────────────────────────

-- A bare public suffix or a shared hosting parent: every tenant is a subdomain of it, so it is not one site and nobody can own it. The same
-- short explicit list as modules/brand_fetch.py (HOSTING_PARENTS, COUNTRY_SECOND_LEVEL; tests/test_brand_scan_migration.py pins them equal):
-- not a public-suffix list. A tenant (shop.myshopify.com) or a site under a country second level (shop.co.uk) is not one.
create or replace function public.ads_hosting_parent(p_host text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_host, '') in ('myshopify.com', 'github.io', 'vercel.app', 'netlify.app', 'herokuapp.com', 's3.amazonaws.com',
                                  'blogspot.com', 'pages.dev', 'web.app', 'firebaseapp.com', 'azurewebsites.net')
      or coalesce(p_host, '') ~ '^(ac|co|com|edu|gov|ltd|me|mil|net|nic|or|org|plc|sch)\.[a-z]{2}$'
$$;

-- A host a domain row or a scan names: a lower-case DNS name of 0131's site shape (letters in the last label or punycode, no IP literal, no
-- port, no underscore), at most 253 characters, and not a hosting parent.
create or replace function public.ads_scan_host_ok(p_host text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p_host is not null
     and char_length(p_host) between 4 and 253
     and p_host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(xn--[a-z0-9-]{1,59}|[a-z]{2,63})$'
     and not public.ads_hosting_parent(p_host)
$$;

-- A URL the worker reports a field came from: 0131's site shape with the longer limit of a link found on the way (2048 characters, the
-- worker's MAX_DERIVED_URL_CHARS). It is shown to a person as text and never fetched by anything that reads it from here.
create or replace function public.ads_scan_url_ok(p_url text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p_url is not null
     and char_length(p_url) between 12 and 2048
     and p_url ~ '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(xn--[a-z0-9-]{1,59}|[a-z]{2,63})(/[\x21-\x7e]*)?$'
     and position(E'\\' in p_url) = 0
$$;

-- One proposed field: exactly {value, source}, source exactly {url, where} with `where` from the closed list of places the worker reads, and
-- the value of the kind p_kind names (0131's limits: a name 1..80, a description 1..1000 multi-line, a product title 1..120, a price 1..40,
-- a palette 1..8 #rrggbb, fonts 1..4 names, a colour #rrggbb, a picture the uuid of a library asset).
create or replace function public.brand_scan_field_ok(p_field jsonb, p_kind text) returns boolean
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v    jsonb;
  src  jsonb;
  arr  text[];
begin
  if p_field is null or jsonb_typeof(p_field) <> 'object' or (select count(*) from jsonb_object_keys(p_field)) <> 2
     or not (p_field ? 'value') or not (p_field ? 'source') then
    return false;
  end if;
  src := p_field -> 'source';
  if jsonb_typeof(src) <> 'object' or (select count(*) from jsonb_object_keys(src)) <> 2
     or jsonb_typeof(src -> 'url') is distinct from 'string' or jsonb_typeof(src -> 'where') is distinct from 'string'
     or not public.ads_scan_url_ok(src ->> 'url')
     or (src ->> 'where') not in ('title', 'meta_description', 'og_site_name', 'og_title', 'og_description', 'og_image', 'twitter_title',
                                  'twitter_description', 'twitter_image', 'jsonld_organization', 'jsonld_product', 'icon',
                                  'apple_touch_icon', 'theme_color', 'css', 'logo_palette') then
    return false;
  end if;
  v := p_field -> 'value';
  if p_kind in ('name', 'title', 'price', 'description', 'product_description') then
    if jsonb_typeof(v) is distinct from 'string' then
      return false;
    end if;
    return case p_kind
      when 'name' then public.ads_text_ok(v #>> '{}', 1, 80, false)
      when 'title' then public.ads_text_ok(v #>> '{}', 1, 120, false)
      when 'price' then public.ads_text_ok(v #>> '{}', 1, 40, false)
      else public.ads_text_ok(v #>> '{}', 1, 1000, true) end;
  elsif p_kind in ('color') then
    return jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^#[0-9a-f]{6}$';
  elsif p_kind in ('asset') then
    return jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  elsif p_kind in ('palette', 'fonts') then
    if jsonb_typeof(v) is distinct from 'array' or jsonb_array_length(v) = 0
       or exists (select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'string') then
      return false;
    end if;
    arr := array(select jsonb_array_elements_text(v));
    if p_kind = 'palette' then
      return public.ads_palette_ok(arr);
    end if;
    return public.ads_text_list_ok(arr, 4, 60);
  end if;
  return false;
end
$$;

-- The result of a scan, as the worker reports it. At most 64 KB, and exactly this shape (any other key, type or length is refused, so what
-- a person reviews is what the database checked):
--   { "v": 1,
--     "pages":    [ up to 6 URLs read ],
--     "fields":   { "name"?, "description"?, "logo"?, "palette"?, "fonts"?, "theme_color"?: a field (brand_scan_field_ok) },
--     "products": [ up to 8 of { "title": field, "description"?, "price"?, "image"?: field } ],
--     "notes":    [ up to 20 of { "code": a closed word, "url"?: a URL } ]  what was skipped and why (an SVG logo, a robots rule ...) }
create or replace function public.brand_scan_result_ok(p_result jsonb) returns boolean
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  k   text;
  e   jsonb;
  f   jsonb;
begin
  if p_result is null or jsonb_typeof(p_result) <> 'object' or octet_length(p_result::text) > 65536 then
    return false;
  end if;
  if exists (select 1 from jsonb_object_keys(p_result) x where x not in ('v', 'pages', 'fields', 'products', 'notes'))
     or (p_result -> 'v') is distinct from '1'::jsonb then
    return false;
  end if;
  if jsonb_typeof(p_result -> 'pages') is distinct from 'array' or jsonb_array_length(p_result -> 'pages') > 6
     or exists (select 1 from jsonb_array_elements(p_result -> 'pages') x
                 where jsonb_typeof(x) <> 'string' or not public.ads_scan_url_ok(x #>> '{}')) then
    return false;
  end if;
  f := p_result -> 'fields';
  if jsonb_typeof(f) is distinct from 'object' then
    return false;
  end if;
  for k in select jsonb_object_keys(f) loop
    if not public.brand_scan_field_ok(f -> k, case k when 'name' then 'name' when 'description' then 'description' when 'logo' then 'asset'
                                                      when 'palette' then 'palette' when 'fonts' then 'fonts' when 'theme_color' then 'color'
                                                      else '-' end) then
      return false;
    end if;
  end loop;
  if jsonb_typeof(p_result -> 'products') is distinct from 'array' or jsonb_array_length(p_result -> 'products') > 8 then
    return false;
  end if;
  for e in select x from jsonb_array_elements(p_result -> 'products') x loop
    if jsonb_typeof(e) <> 'object' or not (e ? 'title') then
      return false;
    end if;
    for k in select jsonb_object_keys(e) loop
      if not public.brand_scan_field_ok(e -> k, case k when 'title' then 'title' when 'description' then 'product_description'
                                                        when 'price' then 'price' when 'image' then 'asset' else '-' end) then
        return false;
      end if;
    end loop;
  end loop;
  if jsonb_typeof(p_result -> 'notes') is distinct from 'array' or jsonb_array_length(p_result -> 'notes') > 20 then
    return false;
  end if;
  for e in select x from jsonb_array_elements(p_result -> 'notes') x loop
    if jsonb_typeof(e) <> 'object'
       or exists (select 1 from jsonb_object_keys(e) x where x not in ('code', 'url'))
       or jsonb_typeof(e -> 'code') is distinct from 'string' or (e ->> 'code') !~ '^[a-z0-9_]{1,64}$'
       or (e ? 'url' and (jsonb_typeof(e -> 'url') <> 'string' or not public.ads_scan_url_ok(e ->> 'url'))) then
      return false;
    end if;
  end loop;
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.brand_domains (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations (id) on delete cascade,
  host               text not null,
  token              text not null,
  requested_by       uuid,
  created_at         timestamptz not null default now(),
  verified_at        timestamptz,
  verified_by        uuid,
  check_requested_at timestamptz,
  last_checked_at    timestamptz,
  last_check_code    text,
  constraint brand_domains_id_org_key unique (id, org_id),
  constraint brand_domains_org_host_key unique (org_id, host)
);

comment on table public.brand_domains is
  'A host an organization says it owns (migration 0133, docs/ADS_FACTORY.md Phase 2), and whether the worker found the TXT record nightshift-verify=<token> at _nightshift.<host>. Written only by request_domain_verification / finish_domain_check; members read.';
comment on column public.brand_domains.token is
  'Random (122 bits), per organization and host. The person puts it in their DNS zone, so it is not a secret; it proves that whoever controls the zone put THIS organization''s token there.';

alter table public.brand_domains drop constraint if exists brand_domains_shape_check;
alter table public.brand_domains add constraint brand_domains_shape_check
  check (public.ads_scan_host_ok(host)
         and token ~ '^[0-9a-f]{32}$'
         and ((verified_at is null) = (verified_by is null))
         and (last_check_code is null or last_check_code ~ '^[a-z0-9_]{1,64}$'));

create table if not exists public.brand_domain_checks (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  domain_id    uuid not null,
  requested_by uuid,
  requested_at timestamptz not null default now(),
  claimed_at   timestamptz,
  worker_id    text,
  finished_at  timestamptz,
  ok           boolean,
  code         text,
  constraint brand_domain_checks_domain_fkey foreign key (domain_id, org_id)
    references public.brand_domains (id, org_id) on delete cascade
);

comment on table public.brand_domain_checks is
  'One "Check now" of a domain''s TXT record (migration 0133): who asked, when the worker took it, what it found. The worker''s queue (claim_domain_check / finish_domain_check); members read.';

alter table public.brand_domain_checks drop constraint if exists brand_domain_checks_state_check;
alter table public.brand_domain_checks add constraint brand_domain_checks_state_check
  check ((finished_at is null) = (ok is null) and (finished_at is null) = (code is null)
         and (code is null or code ~ '^[a-z0-9_]{1,64}$')
         and (worker_id is null or char_length(worker_id) between 1 and 120));

create index if not exists brand_domain_checks_pending_idx on public.brand_domain_checks (requested_at) where finished_at is null;
create index if not exists brand_domain_checks_domain_idx on public.brand_domain_checks (domain_id, requested_at desc);
create index if not exists brand_domain_checks_org_idx on public.brand_domain_checks (org_id);

create table if not exists public.brand_scans (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  domain_id        uuid references public.brand_domains (id) on delete set null,
  requested_by     uuid,
  url              text not null,
  host             text not null,
  status           text not null default 'requested',
  error_code       text,
  result           jsonb,
  price_credits    numeric not null default 0,
  credit_ref       text,
  charged_credits  numeric,
  idempotency_key  text not null,
  request_hash     text not null,
  worker_id        text,
  claimed_at       timestamptz,
  finished_at      timestamptz,
  -- The kit the last accept wrote into. No foreign key on purpose: 0131's rollback must not depend on this table (a kit deleted later leaves
  -- the id behind, and the page then shows no kit).
  kit_id           uuid,
  accepted_fields  text[] not null default '{}',
  accepted_by      uuid,
  accepted_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint brand_scans_idem_key unique (org_id, idempotency_key)
);

comment on table public.brand_scans is
  'One priced brand scan (migration 0133): the entry URL, the verified domain it ran under, the status, and the proposed fields with where each came from. Written only by request_brand_scan, the worker (claim / finish / fail_brand_scan) and accept_brand_scan_fields; members read. A result is a PROPOSAL: nothing reaches a brand kit until a person accepts a field.';

alter table public.brand_scans drop constraint if exists brand_scans_shape_check;
alter table public.brand_scans add constraint brand_scans_shape_check
  check (public.ads_site_url_ok(url) and position(E'\\' in url) = 0
         and public.ads_scan_host_ok(host)
         and status in ('requested', 'running', 'ready', 'failed')
         and ((status = 'failed') = (error_code is not null))
         and (error_code is null or error_code ~ '^[a-z0-9_]{1,64}$')
         and ((status = 'ready') = (result is not null))
         and (result is null or public.brand_scan_result_ok(result))
         and price_credits >= 0 and (charged_credits is null or charged_credits >= 0)
         and (credit_ref is null or credit_ref ~ '^bs:[0-9a-f-]{36}$')
         and idempotency_key ~ '^[A-Za-z0-9_:.-]{8,128}$'
         and request_hash ~ '^[0-9a-f]{32}$'
         and (worker_id is null or char_length(worker_id) between 1 and 120)
         and coalesce(array_ndims(accepted_fields), 1) = 1
         and cardinality(accepted_fields) <= 15
         and array_position(accepted_fields, null) is null
         and array_to_string(accepted_fields, ',')
             ~ '^((name|description|site_url|logo|palette|fonts|theme_color|product:[0-7])(,(name|description|site_url|logo|palette|fonts|theme_color|product:[0-7]))*)?$'
         and ((accepted_at is null) = (accepted_by is null)));

-- One scan in flight per organization: a second press while one runs is scan_in_progress, and two racing presses cannot both insert.
create unique index if not exists brand_scans_one_in_flight on public.brand_scans (org_id) where status in ('requested', 'running');
create index if not exists brand_scans_created_idx on public.brand_scans (created_at);
create index if not exists brand_scans_queue_idx on public.brand_scans (created_at) where status = 'requested';
create index if not exists brand_scans_org_idx on public.brand_scans (org_id, created_at desc);
create index if not exists brand_scans_domain_idx on public.brand_scans (domain_id) where domain_id is not null;

create table if not exists public.brand_scan_settings (
  id                    boolean primary key default true,
  -- NULL: not on sale (the seed). 0: free. Otherwise the credits one scan costs (charged as is; the HOLD is raised to job_minimum).
  price_credits         numeric,
  platform_daily_scans  integer not null default 500,
  platform_daily_checks integer not null default 5000,
  updated_at            timestamptz not null default now()
);

alter table public.brand_scan_settings drop constraint if exists brand_scan_settings_one_row;
alter table public.brand_scan_settings add constraint brand_scan_settings_one_row check (id);
alter table public.brand_scan_settings drop constraint if exists brand_scan_settings_numbers;
alter table public.brand_scan_settings add constraint brand_scan_settings_numbers
  check ((price_credits is null or price_credits between 0 and 1000)
         and platform_daily_scans between 0 and 100000 and platform_daily_checks between 0 and 100000);

comment on table public.brand_scan_settings is
  'One row (migration 0133): price_credits per brand scan (NULL = not on sale, the seed), and the platform-wide caps per 24 hours on scans (platform_daily_scans, default 500) and domain checks (platform_daily_checks, default 5000). 0 refuses all. Changed in the SQL editor only; a trigger leaves a mark in security_events.';

insert into public.brand_scan_settings (id) values (true) on conflict (id) do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The settings row: never deleted, every change leaves a mark
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.brand_scan_settings_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'brand_scan_settings keeps its one row' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists brand_scan_settings_guard on public.brand_scan_settings;
create trigger brand_scan_settings_guard
  before update or delete on public.brand_scan_settings
  for each row execute function public.brand_scan_settings_guard();
drop trigger if exists brand_scan_settings_no_truncate on public.brand_scan_settings;
create trigger brand_scan_settings_no_truncate
  before truncate on public.brand_scan_settings
  for each statement execute function public.brand_scan_settings_guard();

-- A change of the price or a cap leaves a security_events row (kind ads.brand_scan.settings). It can never fail the change it observes.
create or replace function public.brand_scan_settings_trail() returns trigger
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  begin
    if new.price_credits is distinct from old.price_credits or new.platform_daily_scans is distinct from old.platform_daily_scans
       or new.platform_daily_checks is distinct from old.platform_daily_checks then
      perform public.security_event_log('ads.brand_scan.settings', 'warning', 'brand_scan_settings',
        jsonb_build_object('price_credits', jsonb_build_array(old.price_credits, new.price_credits),
                           'platform_daily_scans', jsonb_build_array(old.platform_daily_scans, new.platform_daily_scans),
                           'platform_daily_checks', jsonb_build_array(old.platform_daily_checks, new.platform_daily_checks)));
    end if;
  exception when others then
    raise warning 'brand scan settings trail failed: %', sqlerrm;
  end;
  return null;
end
$$;

drop trigger if exists brand_scan_settings_trail on public.brand_scan_settings;
create trigger brand_scan_settings_trail
  after update on public.brand_scan_settings
  for each row execute function public.brand_scan_settings_trail();

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The price, and ending a scan
-- ───────────────────────────────────────────────────────────────────────────

-- The price of one scan now, what is CHARGED: NULL (not on sale), 0 (free), or the setting rounded up to the cent. It is not raised to the
-- platform's job_minimum (the owner exempted the scan); the hold is (request_brand_scan). A missing settings row reads as NOT ON SALE.
create or replace function public.brand_scan_price() returns numeric
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_price numeric;
begin
  select s.price_credits into v_price from public.brand_scan_settings s;
  if v_price is null then
    return null;
  end if;
  v_price := public.credits_round_up(v_price);
  -- At most two places, as the hold and the ledger keep it (credits_round_up already went up to the cent), and no trailing zeros: 2, 4.01.
  return trim_scale(round(v_price, 2));
end
$$;

-- Fail a scan the caller has locked, and give its hold back. creative_platform_release clears the caller's claims for the one call, so a
-- member's request (sweeping its organization's stale scan) and the worker reach release_credits alike; a hold already gone returns 0.
create or replace function public.brand_scan_fail_locked(p_scan uuid, p_code text) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  x public.brand_scans;
begin
  update public.brand_scans
     set status = 'failed', error_code = case when coalesce(p_code, '') ~ '^[a-z0-9_]{1,64}$' then p_code else 'worker_error' end,
         result = null, finished_at = now(), updated_at = now()
   where id = p_scan and status in ('requested', 'running')
  returning * into x;
  if x.id is not null and x.credit_ref is not null then
    perform public.creative_platform_release(x.credit_ref);
  end if;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Domains: ask for a token, ask for a check (members); the worker's side (service_role)
-- ───────────────────────────────────────────────────────────────────────────

-- Ask to prove p_host for p_org (an editor). Returns the TXT record to add; asking again for the same host returns the same token. At most 10
-- hosts per organization. The host is a bare DNS name (lower-cased, one final dot dropped); a public suffix or a shared hosting parent is
-- `hosting_parent`, anything else not of the shape `invalid_host`.
create or replace function public.request_domain_verification(p_org uuid, p_host text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_host text;
  d      public.brand_domains;
begin
  if auth.uid() is null or p_org is null or not public.is_org_member(p_org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Read only now, after sign-in and the role.
  v_host := lower(btrim(coalesce(p_host, '')));
  if right(v_host, 1) = '.' then
    v_host := left(v_host, -1);
  end if;
  if public.ads_hosting_parent(v_host) then
    raise exception 'hosting_parent' using errcode = 'NS400';
  end if;
  if not public.ads_scan_host_ok(v_host) then
    raise exception 'invalid_host' using errcode = 'NS400';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('brand_scan:' || p_org::text, 0));
  select * into d from public.brand_domains where org_id = p_org and host = v_host;
  if d.id is null then
    if (select count(*) from public.brand_domains where org_id = p_org) >= 10 then
      raise exception 'limit_reached' using errcode = 'NS429', detail = 'max=10';
    end if;
    insert into public.brand_domains (org_id, host, token, requested_by)
    values (p_org, v_host, replace(gen_random_uuid()::text, '-', ''), auth.uid())
    returning * into d;
  end if;
  return jsonb_build_object('id', d.id, 'host', d.host, 'record_name', '_nightshift.' || d.host,
                            'record_value', 'nightshift-verify=' || d.token, 'verified_at', d.verified_at,
                            'last_checked_at', d.last_checked_at, 'last_check_code', d.last_check_code);
end
$$;

-- "Check now" (an editor): queue one DNS check of the domain's TXT record for the worker. A check already waiting is answered again (a
-- double click queues one); a new one is refused within 15 seconds of the last (`too_soon`, with retry_after in seconds) and when the
-- platform's daily number of checks is reached (`platform_busy`, no number).
create or replace function public.check_domain_verification(p_domain uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  d      public.brand_domains;
  c      public.brand_domain_checks;
  v_last timestamptz;
  v_cap  integer;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into d from public.brand_domains where id = p_domain;
  -- Another organization's domain reads as missing. No lock yet (0131's order).
  if not found or not public.is_org_member(d.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(d.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('brand_scan:' || d.org_id::text, 0));
  select * into c from public.brand_domain_checks where domain_id = d.id and finished_at is null order by requested_at limit 1;
  if c.id is not null then
    return jsonb_build_object('check_id', c.id, 'domain_id', d.id, 'pending', true, 'replayed', true);
  end if;
  select max(requested_at) into v_last from public.brand_domain_checks where domain_id = d.id;
  if v_last is not null and v_last > now() - interval '15 seconds' then
    raise exception 'too_soon' using errcode = 'NS429',
      detail = format('retry_after=%s', greatest(1, ceil(extract(epoch from (v_last + interval '15 seconds' - now())))::integer));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('brand_domain_check_global', 0));
  select s.platform_daily_checks into v_cap from public.brand_scan_settings s;
  v_cap := coalesce(v_cap, 5000);
  if (select count(*) from public.brand_domain_checks where requested_at > now() - interval '24 hours') >= v_cap then
    raise exception 'platform_busy' using errcode = 'NS429';
  end if;
  insert into public.brand_domain_checks (org_id, domain_id, requested_by) values (d.org_id, d.id, auth.uid())
  returning * into c;
  update public.brand_domains set check_requested_at = c.requested_at where id = d.id;
  return jsonb_build_object('check_id', c.id, 'domain_id', d.id, 'pending', true, 'replayed', false);
end
$$;

-- The worker takes the oldest waiting check (service_role). A check taken more than 5 minutes ago and never finished is closed as
-- `worker_lost`, one nobody took within an hour as `expired`: the person presses again. Returns NULL when there is nothing to do.
create or replace function public.claim_domain_check(p_worker text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  w text := left(btrim(coalesce(p_worker, '')), 120);
  c public.brand_domain_checks;
  d public.brand_domains;
begin
  if not public.credits_trusted_caller() then
    raise exception 'domain checks are run by the platform''s worker only' using errcode = '42501';
  end if;
  if w = '' then
    raise exception 'a worker id is required' using errcode = '22023';
  end if;
  update public.brand_domain_checks
     set finished_at = now(), ok = false, code = case when claimed_at is null then 'expired' else 'worker_lost' end
   where finished_at is null
     and ((claimed_at is null and requested_at < now() - interval '1 hour') or claimed_at < now() - interval '5 minutes');
  select * into c from public.brand_domain_checks
   where finished_at is null and claimed_at is null
   order by requested_at
   for update skip locked
   limit 1;
  if c.id is null then
    return null;
  end if;
  update public.brand_domain_checks set claimed_at = now(), worker_id = w where id = c.id;
  select * into d from public.brand_domains where id = c.domain_id;
  return jsonb_build_object('check_id', c.id, 'domain_id', d.id, 'org_id', d.org_id, 'host', d.host, 'token', d.token);
end
$$;

-- What the worker found (service_role). ok: the record named this domain's token, so the domain is verified (by the person who asked for
-- this check). A definite "no" (`no_record`: no TXT at the name; `mismatch`: TXT there, but not this token) also takes a verification away:
-- the zone no longer says this organization holds the name. A failure to ask (`dns_error`, `timeout`, ...) leaves the domain as it was.
-- Finishing a check twice changes nothing.
create or replace function public.finish_domain_check(p_check uuid, p_worker text, p_ok boolean, p_code text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  w      text := left(btrim(coalesce(p_worker, '')), 120);
  c      public.brand_domain_checks;
  v_code text;
begin
  if not public.credits_trusted_caller() then
    raise exception 'domain checks are run by the platform''s worker only' using errcode = '42501';
  end if;
  select * into c from public.brand_domain_checks where id = p_check for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if c.finished_at is not null then
    return jsonb_build_object('check_id', c.id, 'ok', c.ok, 'code', c.code, 'replayed', true);
  end if;
  if c.worker_id is distinct from w then
    raise exception 'this check belongs to another worker' using errcode = '42501';
  end if;
  v_code := case when coalesce(p_ok, false) then 'verified'
                 when coalesce(p_code, '') ~ '^[a-z0-9_]{1,64}$' and p_code <> 'verified' then p_code
                 else 'dns_error' end;
  update public.brand_domain_checks set finished_at = now(), ok = coalesce(p_ok, false), code = v_code where id = c.id;
  update public.brand_domains
     set last_checked_at = now(), last_check_code = v_code,
         verified_at = case when v_code = 'verified' then now() when v_code in ('no_record', 'mismatch') then null else verified_at end,
         verified_by = case when v_code = 'verified' then c.requested_by when v_code in ('no_record', 'mismatch') then null else verified_by end
   where id = c.domain_id;
  return jsonb_build_object('check_id', c.id, 'ok', coalesce(p_ok, false), 'code', v_code, 'replayed', false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Scans: the quote and the request (members)
-- ───────────────────────────────────────────────────────────────────────────

-- What a scan would cost this organization now (any member): on_sale false while the price is NULL. `credits` is what a finished scan is
-- charged; `hold` is what request_brand_scan holds while it runs (the price raised to job_minimum, which reserve_credits demands of any
-- hold; the rest is released when the scan finishes); `exempt` says the operator's organization pays nothing.
create or replace function public.quote_brand_scan(p_org uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_price numeric;
  v_floor numeric;
  v_hold  numeric;
begin
  if auth.uid() is null or p_org is null or not public.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_price := public.brand_scan_price();
  v_hold := v_price;
  if v_price > 0 then
    select credits_per_unit into v_floor from public.credit_prices where unit = 'job_minimum';
    v_hold := trim_scale(round(greatest(v_price, coalesce(public.credits_round_up(v_floor), 0)), 2));
  end if;
  return jsonb_build_object('on_sale', v_price is not null, 'credits', v_price, 'hold', v_hold, 'exempt', public.credits_exempt(p_org));
end
$$;

-- Ask for one scan of p_url (an editor). p_idem is the press's own id (8..128 of A-Z a-z 0-9 _ : . -): the same press again answers the
-- first one's scan; the same id with another URL or price is `idempotency_conflict`. p_max_credits is the price the person was shown: a
-- higher price now is `price_changed`, never charged. The URL is 0131's site shape (and no backslash, which the worker refuses); its host must
-- be a VERIFIED domain of this organization or a subdomain of one (`domain_not_verified`). Refusals, in order: forbidden, invalid_url,
-- hosting_parent, invalid_idempotency_key, idempotency_conflict (or the replay), not_on_sale, price_changed, domain_not_verified,
-- scan_in_progress, platform_busy, scan_hold_unavailable (NS402: the hold, the price raised to job_minimum, is not available; detail
-- hold=… price=…), and NS429 parallel run limit from the hold. A refusal changes nothing. The hold is greatest(price, job_minimum); the
-- scan's price_credits is the price, which finish_brand_scan captures (the rest of the hold is released then).
create or replace function public.request_brand_scan(p_org uuid, p_url text, p_idem text, p_max_credits numeric) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  v_url   text;
  v_host  text;
  v_hash  text;
  v_price numeric;
  v_floor numeric;
  v_hold  numeric;
  v_cap   integer;
  v_id    uuid := gen_random_uuid();
  v_ref   text;
  res     jsonb;
  prior   public.brand_scans;
  d       public.brand_domains;
  stale   record;
begin
  if uid is null or p_org is null or not public.is_org_member(p_org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The operator's organization is paid for by the platform: only a platform admin spends there (create_creative_job's rule).
  if public.credits_exempt(p_org) and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501',
      detail = 'scans in the operator''s organization are started by a platform admin';
  end if;
  -- Read only now, after sign-in and the role.
  v_url := btrim(coalesce(p_url, ''));
  if v_url = '' or not public.ads_site_url_ok(v_url) or position(E'\\' in v_url) > 0 then
    raise exception 'invalid_url' using errcode = 'NS400';
  end if;
  v_host := substring(v_url from '^https://([^/]+)');
  if public.ads_hosting_parent(v_host) then
    raise exception 'hosting_parent' using errcode = 'NS400';
  end if;
  if not public.ads_scan_host_ok(v_host) then
    raise exception 'invalid_url' using errcode = 'NS400';
  end if;
  if p_idem is null or p_idem !~ '^[A-Za-z0-9_:.-]{8,128}$' then
    raise exception 'invalid_idempotency_key' using errcode = 'NS400';
  end if;
  v_hash := md5(jsonb_build_object('url', v_url, 'max_credits', p_max_credits)::text);

  -- Presses of one organization take turns (a double click, a second tab, a second editor): the replay and the counts below are exact.
  perform pg_advisory_xact_lock(hashtextextended('brand_scan:' || p_org::text, 0));
  select * into prior from public.brand_scans where org_id = p_org and idempotency_key = p_idem;
  if prior.id is not null then
    if prior.request_hash <> v_hash then
      raise exception 'idempotency_conflict' using errcode = 'NS409';
    end if;
    return jsonb_build_object('id', prior.id, 'status', prior.status, 'credits', prior.price_credits, 'replayed', true);
  end if;

  v_price := public.brand_scan_price();
  if v_price is null then
    raise exception 'not_on_sale' using errcode = 'NS409';
  end if;
  if p_max_credits is null or v_price > p_max_credits then
    raise exception 'price_changed' using errcode = 'NS409', detail = format('price=%s', v_price);
  end if;

  -- The most specific verified domain that covers the host: itself, or a parent of it.
  select * into d from public.brand_domains
   where org_id = p_org and verified_at is not null
     and (host = v_host or right(v_host, char_length(host) + 1) = '.' || host)
   order by char_length(host) desc
   limit 1;
  if d.id is null then
    raise exception 'domain_not_verified' using errcode = 'NS409';
  end if;

  -- Platform-wide, after the organization's lock (0127's order, so two requests never wait on each other). Its refusal carries no number.
  perform pg_advisory_xact_lock(hashtextextended('brand_scan_global', 0));
  -- This organization's scan that nobody took in time, or whose worker went quiet, gives its place and its hold back first.
  for stale in
    select id from public.brand_scans
     where org_id = p_org
       and ((status = 'requested' and created_at < now() - interval '2 hours')
            or (status = 'running' and claimed_at < now() - interval '15 minutes'))
     for update
  loop
    perform public.brand_scan_fail_locked(stale.id, 'expired');
  end loop;
  if exists (select 1 from public.brand_scans where org_id = p_org and status in ('requested', 'running')) then
    raise exception 'scan_in_progress' using errcode = 'NS409';
  end if;
  select s.platform_daily_scans into v_cap from public.brand_scan_settings s;
  v_cap := coalesce(v_cap, 500);
  if (select count(*) from public.brand_scans where created_at > now() - interval '24 hours') >= v_cap then
    raise exception 'platform_busy' using errcode = 'NS429';
  end if;

  -- The hold: the price this function computed, raised to job_minimum (reserve_credits refuses any hold below it), under a reference it
  -- made, never the caller's. Only the price is captured when the scan finishes (finish_brand_scan); the rest of the hold goes back then,
  -- and all of it on a failure. Not enough credits for the hold is said as such (scan_hold_unavailable, with both numbers); NS429 (the
  -- plan's parallel runs) comes through as it is.
  if v_price > 0 then
    select credits_per_unit into v_floor from public.credit_prices where unit = 'job_minimum';
    v_hold := trim_scale(round(greatest(v_price, coalesce(public.credits_round_up(v_floor), 0)), 2));
    v_ref := 'bs:' || v_id::text;
    begin
      res := public.creative_platform_reserve(p_org, v_ref, v_hold);
    exception when sqlstate 'NS402' then
      raise exception 'scan_hold_unavailable' using errcode = 'NS402', detail = format('hold=%s price=%s', v_hold, v_price);
    end;
    if coalesce((res ->> 'exempt')::boolean, false) then
      v_ref := null;
    end if;
  end if;
  insert into public.brand_scans (id, org_id, domain_id, requested_by, url, host, status, price_credits, credit_ref, idempotency_key,
                                  request_hash)
  values (v_id, p_org, d.id, uid, v_url, v_host, 'requested', case when v_ref is null then 0 else v_price end, v_ref, p_idem, v_hash);
  return jsonb_build_object('id', v_id, 'status', 'requested', 'credits', case when v_ref is null then 0 else v_price end,
                            'replayed', false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Scans: the worker's side (service_role)
-- ───────────────────────────────────────────────────────────────────────────

-- Take the oldest requested scan. First every stale scan is failed and released (one nobody took within 2 hours: `expired`; one whose worker
-- went quiet for 15 minutes: `worker_lost`). The hold is marked started (start_credit_reservation); a hold that is gone fails the scan
-- (`hold_missing`) and nothing is returned for it. The answer carries what the worker needs: the URL, the verified domain's host and token
-- (it reads the TXT record again before it fetches anything). NULL when there is nothing to do.
create or replace function public.claim_brand_scan(p_worker text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  w     text := left(btrim(coalesce(p_worker, '')), 120);
  x     public.brand_scans;
  d     public.brand_domains;
  stale record;
begin
  if not public.credits_trusted_caller() then
    raise exception 'brand scans are run by the platform''s worker only' using errcode = '42501';
  end if;
  if w = '' then
    raise exception 'a worker id is required' using errcode = '22023';
  end if;
  for stale in
    select id, status from public.brand_scans
     where (status = 'requested' and created_at < now() - interval '2 hours')
        or (status = 'running' and claimed_at < now() - interval '15 minutes')
     for update skip locked
  loop
    perform public.brand_scan_fail_locked(stale.id, case when stale.status = 'requested' then 'expired' else 'worker_lost' end);
  end loop;
  select * into x from public.brand_scans where status = 'requested' order by created_at for update skip locked limit 1;
  if x.id is null then
    return null;
  end if;
  if x.credit_ref is not null and public.start_credit_reservation(x.credit_ref, x.org_id) is null then
    perform public.brand_scan_fail_locked(x.id, 'hold_missing');
    return null;
  end if;
  update public.brand_scans set status = 'running', worker_id = w, claimed_at = now(), updated_at = now() where id = x.id
  returning * into x;
  select * into d from public.brand_domains where id = x.domain_id;
  return jsonb_build_object('scan_id', x.id, 'org_id', x.org_id, 'url', x.url, 'host', x.host, 'domain_host', d.host,
                            'token', d.token, 'credits', x.price_credits);
end
$$;

-- The worker's result (service_role): checked here (brand_scan_result_ok: the shape, every length, every text clean; every picture a live
-- image of THIS organization's library), then the hold is captured and the scan is ready. A result that fails a check is `invalid_result`
-- (NS400) and changes nothing: the worker then fails the scan, and the hold is released. Finishing twice returns the first answer.
create or replace function public.finish_brand_scan(p_scan uuid, p_worker text, p_result jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  w       text := left(btrim(coalesce(p_worker, '')), 120);
  x       public.brand_scans;
  v_ids   uuid[];
  charged numeric := 0;
begin
  if not public.credits_trusted_caller() then
    raise exception 'brand scans are run by the platform''s worker only' using errcode = '42501';
  end if;
  select * into x from public.brand_scans where id = p_scan for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if x.status in ('ready', 'failed') then
    return jsonb_build_object('id', x.id, 'status', x.status, 'charged', x.charged_credits, 'replayed', true);
  end if;
  if x.status <> 'running' or x.worker_id is distinct from w then
    raise exception 'this scan belongs to another worker' using errcode = '42501';
  end if;
  if not public.brand_scan_result_ok(p_result) then
    raise exception 'invalid_result' using errcode = 'NS400';
  end if;
  select coalesce(array_agg(distinct a::uuid), '{}') into v_ids
    from (select p_result #>> '{fields,logo,value}' as a
          union all
          select e #>> '{image,value}' from jsonb_array_elements(p_result -> 'products') e) q
   where a is not null;
  perform public.ads_check_images(x.org_id, v_ids, 9);
  if x.credit_ref is not null and exists (select 1 from public.credit_reservations where job_id = x.credit_ref) then
    -- 0 when the hold is no longer open (it expired): the scan is still ready, and what was charged is what the ledger says.
    charged := coalesce(public.capture_credits(x.credit_ref, x.price_credits, false), 0);
  end if;
  update public.brand_scans
     set status = 'ready', result = p_result, charged_credits = charged, finished_at = now(), updated_at = now()
   where id = x.id;
  return jsonb_build_object('id', x.id, 'status', 'ready', 'charged', charged, 'replayed', false);
end
$$;

-- The worker could not finish (service_role): the scan fails with a closed code (anything else reads `worker_error`) and the hold is released.
-- Failing twice, or failing a finished scan, changes nothing.
create or replace function public.fail_brand_scan(p_scan uuid, p_worker text, p_code text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  w text := left(btrim(coalesce(p_worker, '')), 120);
  x public.brand_scans;
begin
  if not public.credits_trusted_caller() then
    raise exception 'brand scans are run by the platform''s worker only' using errcode = '42501';
  end if;
  select * into x from public.brand_scans where id = p_scan for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if x.status in ('ready', 'failed') then
    return jsonb_build_object('id', x.id, 'status', x.status, 'error_code', x.error_code, 'replayed', true);
  end if;
  if x.status <> 'running' or x.worker_id is distinct from w then
    raise exception 'this scan belongs to another worker' using errcode = '42501';
  end if;
  perform public.brand_scan_fail_locked(x.id, p_code);
  select * into x from public.brand_scans where id = p_scan;
  return jsonb_build_object('id', x.id, 'status', x.status, 'error_code', x.error_code, 'replayed', false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. Accepting fields into a brand kit (members)
-- ───────────────────────────────────────────────────────────────────────────

-- Copy the fields a person chose from a READY scan into a brand kit (an editor). p_kit NULL: a new kit (source 'scan'; it needs `name`
-- among the fields, and counts against 0131's kits_per_org); p_kit set: that kit of the scan's own organization, only the chosen fields
-- change. Fields: name, description (the site's own words, into the kit's voice notes), site_url (the scanned URL), logo, palette,
-- theme_color (put first in the palette), fonts, and product:0 .. product:7 (each a new product of the kit, source 'scan', with its picture;
-- 0131's products_per_kit). Every text goes through ads_clean_text and 0131's lengths again, every picture through ads_check_images (a
-- picture deleted from the library since the scan is refused). A field the scan did not propose is `invalid_fields`. Returns the kit id.
create or replace function public.accept_brand_scan_fields(p_scan uuid, p_kit uuid, p_fields text[]) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  x        public.brand_scans;
  k        public.brand_kits;
  f        jsonb;
  pr       jsonb;
  fld      text;
  v_name   text;
  v_voice  text;
  v_logo   uuid;
  v_pal    text[];
  v_fonts  text[];
  v_title  text;
  v_desc   text;
  v_price  text;
  v_img    uuid;
  v_cap    integer;
  v_pid    uuid;
  n        integer;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into x from public.brand_scans where id = p_scan;
  if not found or not public.is_org_member(x.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(x.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if x.status <> 'ready' then
    raise exception 'scan_not_ready' using errcode = 'NS409';
  end if;
  n := coalesce(cardinality(p_fields), 0);
  if n = 0 or n > 15 or array_ndims(p_fields) <> 1 or array_position(p_fields, null) is not null
     or (select count(distinct a) from unnest(p_fields) a) <> n then
    raise exception 'invalid_fields' using errcode = 'NS400';
  end if;
  f := x.result -> 'fields';
  foreach fld in array p_fields loop
    if fld !~ '^(name|description|site_url|logo|palette|fonts|theme_color|product:[0-7])$'
       or (fld like 'product:%' and jsonb_array_length(x.result -> 'products') <= substr(fld, 9)::integer)
       or (fld not like 'product:%' and fld <> 'site_url' and not (f ? fld)) then
      raise exception 'invalid_fields' using errcode = 'NS400', detail = format('field=%s', left(fld, 20));
    end if;
  end loop;
  if p_kit is null and not ('name' = any (p_fields)) then
    raise exception 'name_required' using errcode = 'NS400';
  end if;

  -- 0131's organization lock: kits and products are written, and 0131's caps counted, exactly as save_brand_kit / save_brand_product do.
  perform pg_advisory_xact_lock(hashtextextended('ads_factory:' || x.org_id::text, 0));
  if p_kit is not null then
    select * into k from public.brand_kits where id = p_kit for no key update;
    if not found or k.org_id <> x.org_id then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
  end if;
  select * into x from public.brand_scans where id = p_scan for no key update;
  if not found or x.status <> 'ready' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  -- The values, cleaned again as 0131 stores them.
  if 'name' = any (p_fields) then
    v_name := public.ads_clean_text(f #>> '{name,value}', false);
    if char_length(v_name) not between 1 and 80 then
      raise exception 'invalid_fields' using errcode = 'NS400', detail = 'field=name';
    end if;
  end if;
  if 'description' = any (p_fields) then
    v_voice := public.ads_clean_text(f #>> '{description,value}', true);
    if char_length(v_voice) not between 1 and 1000 then
      raise exception 'invalid_fields' using errcode = 'NS400', detail = 'field=description';
    end if;
  end if;
  if 'logo' = any (p_fields) then
    v_logo := (f #>> '{logo,value}')::uuid;
    perform public.ads_check_images(x.org_id, array[v_logo], 1);
  end if;
  if 'palette' = any (p_fields) or 'theme_color' = any (p_fields) then
    v_pal := case when 'theme_color' = any (p_fields) then array[lower(f #>> '{theme_color,value}')] else '{}' end;
    if 'palette' = any (p_fields) then
      v_pal := v_pal || array(select lower(e) from jsonb_array_elements_text(f #> '{palette,value}') e);
    elsif p_kit is not null then
      v_pal := v_pal || k.palette;
    end if;
    -- First occurrence of each colour, in order, at most 8.
    v_pal := array(select c from (select c, min(o) as o from unnest(v_pal) with ordinality u(c, o) group by c) q order by o limit 8);
    if not public.ads_palette_ok(v_pal) then
      raise exception 'invalid_fields' using errcode = 'NS400', detail = 'field=palette';
    end if;
  end if;
  if 'fonts' = any (p_fields) then
    v_fonts := array(select public.ads_clean_text(e, false) from jsonb_array_elements_text(f #> '{fonts,value}') e);
    if not public.ads_text_list_ok(v_fonts, 4, 60) then
      raise exception 'invalid_fields' using errcode = 'NS400', detail = 'field=fonts';
    end if;
  end if;

  if p_kit is null then
    select s.kits_per_org into v_cap from public.ads_factory_cap_settings s;
    v_cap := coalesce(v_cap, 5);
    if (select count(*) from public.brand_kits where org_id = x.org_id) >= v_cap then
      raise exception 'limit_reached' using errcode = 'NS429', detail = format('max=%s', v_cap);
    end if;
    insert into public.brand_kits (org_id, name, site_url, logo_asset_id, palette, fonts, voice_notes, source, created_by)
    values (x.org_id, v_name, case when 'site_url' = any (p_fields) then x.url end, v_logo, coalesce(v_pal, '{}'), coalesce(v_fonts, '{}'),
            coalesce(v_voice, ''), 'scan', auth.uid())
    returning * into k;
  else
    update public.brand_kits
       set name = coalesce(v_name, name),
           site_url = case when 'site_url' = any (p_fields) then x.url else site_url end,
           logo_asset_id = case when 'logo' = any (p_fields) then v_logo else logo_asset_id end,
           palette = coalesce(v_pal, palette),
           fonts = coalesce(v_fonts, fonts),
           voice_notes = coalesce(v_voice, voice_notes),
           updated_at = now()
     where id = k.id
    returning * into k;
  end if;

  -- Products: each chosen candidate becomes a new product of the kit.
  foreach fld in array p_fields loop
    continue when fld not like 'product:%';
    pr := x.result -> 'products' -> substr(fld, 9)::integer;
    select s.products_per_kit into v_cap from public.ads_factory_cap_settings s;
    v_cap := coalesce(v_cap, 20);
    if (select count(*) from public.brand_products where kit_id = k.id) >= v_cap then
      raise exception 'limit_reached' using errcode = 'NS429', detail = format('max=%s', v_cap);
    end if;
    v_title := public.ads_clean_text(pr #>> '{title,value}', false);
    v_desc  := public.ads_clean_text(pr #>> '{description,value}', true);
    v_price := public.ads_clean_text(pr #>> '{price,value}', false);
    if char_length(v_title) not between 1 and 120 or char_length(v_desc) > 1000 or char_length(v_price) > 40 then
      raise exception 'invalid_fields' using errcode = 'NS400', detail = format('field=%s', fld);
    end if;
    v_img := (pr #>> '{image,value}')::uuid;
    if v_img is not null then
      perform public.ads_check_images(x.org_id, array[v_img], 1);
    end if;
    insert into public.brand_products (kit_id, org_id, title, description, price_text, source, created_by)
    values (k.id, k.org_id, v_title, v_desc, v_price, 'scan', auth.uid())
    returning id into v_pid;
    if v_img is not null then
      insert into public.brand_product_images (product_id, org_id, asset_id, position) values (v_pid, k.org_id, v_img, 0);
    end if;
  end loop;

  update public.brand_scans
     set kit_id = k.id,
         accepted_fields = array(select distinct a from unnest(accepted_fields || p_fields) a order by a),
         accepted_by = auth.uid(), accepted_at = now(), updated_at = now()
   where id = x.id;
  return k.id;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 9. RLS and grants: a member reads; nobody writes through the API
-- ───────────────────────────────────────────────────────────────────────────

alter table public.brand_domains enable row level security;
alter table public.brand_domain_checks enable row level security;
alter table public.brand_scans enable row level security;
alter table public.brand_scan_settings enable row level security;

revoke all on public.brand_domains, public.brand_domain_checks, public.brand_scans, public.brand_scan_settings
  from public, anon, authenticated, service_role;
grant select on public.brand_domains, public.brand_domain_checks, public.brand_scans to authenticated, service_role;

drop policy if exists brand_domains_select on public.brand_domains;
create policy brand_domains_select on public.brand_domains
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists brand_domain_checks_select on public.brand_domain_checks;
create policy brand_domain_checks_select on public.brand_domain_checks
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists brand_scans_select on public.brand_scans;
create policy brand_scans_select on public.brand_scans
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

revoke all on function public.ads_hosting_parent(text) from public, anon, authenticated, service_role;
revoke all on function public.ads_scan_host_ok(text) from public, anon, authenticated, service_role;
revoke all on function public.ads_scan_url_ok(text) from public, anon, authenticated, service_role;
revoke all on function public.brand_scan_field_ok(jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.brand_scan_result_ok(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.brand_scan_price() from public, anon, authenticated, service_role;
revoke all on function public.brand_scan_fail_locked(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.brand_scan_settings_guard() from public, anon, authenticated, service_role;
revoke all on function public.brand_scan_settings_trail() from public, anon, authenticated, service_role;
revoke all on function public.request_domain_verification(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.check_domain_verification(uuid) from public, anon, authenticated, service_role;
revoke all on function public.quote_brand_scan(uuid) from public, anon, authenticated, service_role;
revoke all on function public.request_brand_scan(uuid, text, text, numeric) from public, anon, authenticated, service_role;
revoke all on function public.accept_brand_scan_fields(uuid, uuid, text[]) from public, anon, authenticated, service_role;
revoke all on function public.claim_domain_check(text) from public, anon, authenticated, service_role;
revoke all on function public.finish_domain_check(uuid, text, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.claim_brand_scan(text) from public, anon, authenticated, service_role;
revoke all on function public.finish_brand_scan(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.fail_brand_scan(uuid, text, text) from public, anon, authenticated, service_role;

grant execute on function public.request_domain_verification(uuid, text) to authenticated;
grant execute on function public.check_domain_verification(uuid) to authenticated;
grant execute on function public.quote_brand_scan(uuid) to authenticated;
grant execute on function public.request_brand_scan(uuid, text, text, numeric) to authenticated;
grant execute on function public.accept_brand_scan_fields(uuid, uuid, text[]) to authenticated;
grant execute on function public.claim_domain_check(text) to service_role;
grant execute on function public.finish_domain_check(uuid, text, boolean, text) to service_role;
grant execute on function public.claim_brand_scan(text) to service_role;
grant execute on function public.finish_brand_scan(uuid, text, jsonb) to service_role;
grant execute on function public.fail_brand_scan(uuid, text, text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 10. The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  r         record;
  got       text;
  fn        oid;
  t         text;
  role_name text;
  priv      text;
begin
  for r in
    select * from (values
      ('public.ads_hosting_parent(text)', '45b9424f94ca9f4b9f7e9065418ed46b', ''),
      ('public.ads_scan_host_ok(text)', '1034a7f8c6322e8f03d58d08f7704425', ''),
      ('public.ads_scan_url_ok(text)', 'd734d3fedb41ffed175eae91287e449c', ''),
      ('public.brand_scan_field_ok(jsonb, text)', '353d784aab148ab2af4324383bdeae51', ''),
      ('public.brand_scan_result_ok(jsonb)', '05e268084c5d68c2291897ce2f759d44', ''),
      ('public.brand_scan_price()', '596c0cd1d82759855ae5496b6acf20b0', ''),
      ('public.brand_scan_fail_locked(uuid, text)', '2ed1f012de9cb7e16df70d7cc748cc91', ''),
      ('public.brand_scan_settings_guard()', 'd55aaee7b70dc8655a5fb02f3682a5bb', ''),
      ('public.brand_scan_settings_trail()', 'c5f5e10faae661c30f58a25e2ff5b5aa', ''),
      ('public.request_domain_verification(uuid, text)', '5cf3a05a1cd6291caa58b7bfb4f41ab7', 'authenticated'),
      ('public.check_domain_verification(uuid)', '9da8c07a8a5d7fc194b796eb8c35a2d6', 'authenticated'),
      ('public.quote_brand_scan(uuid)', 'ba5d8b562c6893d8b0ef49ff4392d8b2', 'authenticated'),
      ('public.request_brand_scan(uuid, text, text, numeric)', '812a6131a465414f5b0235f6f705fe5a', 'authenticated'),
      ('public.accept_brand_scan_fields(uuid, uuid, text[])', '33e5092fed2d2b50b594eae230aaffb1', 'authenticated'),
      ('public.claim_domain_check(text)', '82141353f6d88e824d4d299fa34b8890', 'service_role'),
      ('public.finish_domain_check(uuid, text, boolean, text)', '62b0880595b8713fa3ba8d93c146c7f0', 'service_role'),
      ('public.claim_brand_scan(text)', 'ccab2f97d979a930735b44fed06b237f', 'service_role'),
      ('public.finish_brand_scan(uuid, text, jsonb)', '0b99232ecc4459e5b4e344fdee9eab81', 'service_role'),
      ('public.fail_brand_scan(uuid, text, text)', '0e47d8da1effbdbadd16f309a3263c45', 'service_role')
    ) v(sig, want, grantee)
  loop
    fn := to_regprocedure(r.sig);
    if fn is null then
      raise exception '0133 end state: % does not exist', r.sig;
    end if;
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into got from pg_proc p where p.oid = fn;
    if got <> r.want then
      raise exception '0133 end state: % does not hold this file''s body (md5 %)', r.sig, got;
    end if;
    -- Exactly one API role, or none, may call it. A NULL ACL would mean "default privileges", and the default includes public.
    if exists (select 1 from pg_proc p
                where p.oid = fn
                  and (p.proacl is null
                       or exists (select 1 from aclexplode(p.proacl) a
                                   where a.grantee = 0
                                      or a.grantee in (select o.oid from pg_roles o
                                                        where o.rolname in ('anon', 'authenticated', 'service_role')
                                                          and o.rolname <> r.grantee)))) then
      raise exception '0133 end state: % is executable by a role that must not call it', r.sig;
    end if;
    if r.grantee <> '' and not has_function_privilege(r.grantee, fn, 'execute') then
      raise exception '0133 end state: % is not executable by %', r.sig, r.grantee;
    end if;
    if not exists (select 1 from pg_proc p where p.oid = fn and p.proconfig @> array['search_path=public, pg_temp']) then
      raise exception '0133 end state: % has no pinned search_path', r.sig;
    end if;
  end loop;
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname in ('request_domain_verification', 'check_domain_verification', 'quote_brand_scan', 'request_brand_scan',
                          'accept_brand_scan_fields', 'claim_domain_check', 'finish_domain_check', 'claim_brand_scan', 'finish_brand_scan',
                          'fail_brand_scan')) <> 10 then
    raise exception '0133 end state: a callable function has an overload';
  end if;

  foreach t in array array['brand_domains', 'brand_domain_checks', 'brand_scans', 'brand_scan_settings'] loop
    if not exists (select 1 from pg_class where oid = ('public.' || t)::regclass and relrowsecurity) then
      raise exception '0133 end state: % has no row level security', t;
    end if;
    foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
      foreach priv in array array['insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
        if has_table_privilege(role_name, 'public.' || t, priv) then
          raise exception '0133 end state: % holds % on %', role_name, priv, t;
        end if;
      end loop;
    end loop;
    if has_table_privilege('anon', 'public.' || t, 'select') then
      raise exception '0133 end state: anon reads %', t;
    end if;
    if t = 'brand_scan_settings' then
      if exists (select 1 from pg_policy where polrelid = ('public.' || t)::regclass)
         or has_table_privilege('authenticated', 'public.' || t, 'select') or has_table_privilege('service_role', 'public.' || t, 'select') then
        raise exception '0133 end state: % is readable by an API role or has a policy', t;
      end if;
    elsif (select count(*) from pg_policy where polrelid = ('public.' || t)::regclass) <> 1
          or not exists (select 1 from pg_policy where polrelid = ('public.' || t)::regclass and polname = t || '_select' and polcmd = 'r'
                            and polroles = array[(select oid from pg_roles where rolname = 'authenticated')]) then
      raise exception '0133 end state: % does not have exactly its one SELECT policy for authenticated', t;
    end if;
  end loop;

  if (select count(*) from public.brand_scan_settings) <> 1 then
    raise exception '0133 end state: brand_scan_settings does not hold exactly one row';
  end if;
  if (select count(*) from pg_constraint
       where contype = 'c' and convalidated
         and conname in ('brand_domains_shape_check', 'brand_domain_checks_state_check', 'brand_scans_shape_check',
                         'brand_scan_settings_one_row', 'brand_scan_settings_numbers')) <> 5 then
    raise exception '0133 end state: a check is missing or not validated';
  end if;
  if to_regclass('public.brand_scans_one_in_flight') is null then
    raise exception '0133 end state: the one-scan-in-flight index is missing';
  end if;
  if (select count(*) from pg_trigger where not tgisinternal
        and (tgrelid, tgname) in (('public.brand_scan_settings'::regclass, 'brand_scan_settings_guard'),
                                  ('public.brand_scan_settings'::regclass, 'brand_scan_settings_no_truncate'),
                                  ('public.brand_scan_settings'::regclass, 'brand_scan_settings_trail'))) <> 3 then
    raise exception '0133 end state: a trigger is missing';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (the SQL editor, after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     (select price_credits is null from public.brand_scan_settings) as not_on_sale_until_the_owner_sets_a_price,
--     (select platform_daily_scans = 500 and platform_daily_checks = 5000 from public.brand_scan_settings) as default_caps_if_untouched,
--     has_function_privilege('authenticated', 'public.request_brand_scan(uuid,text,text,numeric)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.request_brand_scan(uuid,text,text,numeric)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.finish_brand_scan(uuid,text,jsonb)', 'EXECUTE')
--       and has_function_privilege('service_role', 'public.finish_brand_scan(uuid,text,jsonb)', 'EXECUTE') as grants,
--     not has_table_privilege('authenticated', 'public.brand_scan_settings', 'SELECT') as settings_closed;
-- Put the scan on sale (the owner's decision; the pull request proposes the number and its cost basis):
--   update public.brand_scan_settings set price_credits = 1;
