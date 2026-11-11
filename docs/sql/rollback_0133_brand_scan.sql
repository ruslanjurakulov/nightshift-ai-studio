-- rollback_0133_brand_scan.sql — takes migration 0133 (Ads Factory, Phase 2: the brand scan) out again. OWNER-APPLY: paste into the Supabase
-- SQL editor. Nothing in the app runs it.
--
-- WHEN YOU NEED IT. If the brand scan's tables and functions must be withdrawn. To only STOP scans, take the scan off sale (no deploy, nothing
-- lost):   update public.brand_scan_settings set price_credits = null;   and to stop domain checks too:   ... set platform_daily_checks = 0;
-- To only HIDE it, switch NIGHTSHIFT_ADS_BRAND_SCAN off (the page and the worker then do nothing).
--
-- READ THIS FIRST: 0133 replaced nothing, so there is no earlier body to put back; this file only DROPS what 0133 added. Domains, checks and
-- scans are things people asked for (a scan may have been paid for), so the file REFUSES (changes nothing) while any of the three tables
-- holds a row, or while a scan is still requested or running (its hold would be left open), unless you say in the same transaction that the
-- rows may go:
--     set local nightshift.brand_scan_rollback_delete_rows = 'yes';
-- (right after `begin;` below; a scan in flight still refuses: let the worker finish it, or fail it with fail_brand_scan first). Copy the
-- rows out first if they matter:   select * from public.brand_scans; select * from public.brand_domains;
-- Kits and products a person accepted from a scan are 0131's rows and STAY (their source reads 'scan'); pictures the worker stored stay in
-- the media library. No credit moves: a captured scan stays captured. The security_events rows of the settings trail stay.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES if a function of 0133 does not hold 0133's body (a later migration changed it), if a scan is in flight, or if a table holds a
--      row and the line above was not set. A function that is already gone is skipped (a second run changes nothing).
--   1. Drops the ten callable functions.  2. Drops the four tables.  3. Drops the nine internal functions.  4. Asserts nothing is left.
-- ORDER. Roll this back BEFORE docs/sql/rollback_0131_ads_factory.sql: 0133's checks use 0131's text rules, so 0131's rollback refuses
-- while 0133 is in place.
--
-- tests/security/test_sec_brand_scan.py applies this file to a copy of the lab database and re-applies 0133.

begin;
set local lock_timeout = '5s';

do $$
declare
  r    record;
  got  text;
  t    text;
  n    bigint;
  rows bigint := 0;
begin
  for r in
    select * from (values
      ('public.ads_hosting_parent(text)', '45b9424f94ca9f4b9f7e9065418ed46b'),
      ('public.ads_scan_host_ok(text)', '1034a7f8c6322e8f03d58d08f7704425'),
      ('public.ads_scan_url_ok(text)', 'd734d3fedb41ffed175eae91287e449c'),
      ('public.brand_scan_field_ok(jsonb, text)', '353d784aab148ab2af4324383bdeae51'),
      ('public.brand_scan_result_ok(jsonb)', '05e268084c5d68c2291897ce2f759d44'),
      ('public.brand_scan_price()', '596c0cd1d82759855ae5496b6acf20b0'),
      ('public.brand_scan_fail_locked(uuid, text)', '67e8ee83bde9ec4512a3d6135c9c07ee'),
      ('public.brand_scan_settings_guard()', 'd55aaee7b70dc8655a5fb02f3682a5bb'),
      ('public.brand_scan_settings_trail()', '8274499327749e163dd9d306e47339ea'),
      ('public.request_domain_verification(uuid, text)', '5cf3a05a1cd6291caa58b7bfb4f41ab7'),
      ('public.check_domain_verification(uuid)', 'b90fdc7e1117c05bca74fd6d3ed9fdbf'),
      ('public.quote_brand_scan(uuid)', 'ba5d8b562c6893d8b0ef49ff4392d8b2'),
      ('public.request_brand_scan(uuid, text, text, numeric)', 'e696f6295465ae9b321766aea7a40b99'),
      ('public.accept_brand_scan_fields(uuid, uuid, text[])', '8ccc1bdaec64c9cfdb579485ea655059'),
      ('public.claim_domain_check(text)', '82141353f6d88e824d4d299fa34b8890'),
      ('public.finish_domain_check(uuid, text, boolean, text)', '62b0880595b8713fa3ba8d93c146c7f0'),
      ('public.claim_brand_scan(text)', 'ccab2f97d979a930735b44fed06b237f'),
      ('public.finish_brand_scan(uuid, text, jsonb)', '0b99232ecc4459e5b4e344fdee9eab81'),
      ('public.fail_brand_scan(uuid, text, text)', '0e47d8da1effbdbadd16f309a3263c45')
    ) v(sig, want)
  loop
    select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) into got from pg_proc where oid = to_regprocedure(r.sig);
    if got is not null and got <> r.want then
      raise exception 'rollback 0133: % is not 0133''s body (md5 %): a later change would be undone; read the live body first', r.sig, got;
    end if;
  end loop;
  if to_regclass('public.brand_scans') is not null then
    execute 'select count(*) from public.brand_scans where status in (''requested'', ''running'')' into n;
    if n > 0 then
      raise exception 'rollback 0133: a brand scan is still requested or running (its credit hold is open); let it finish or fail it first';
    end if;
  end if;
  foreach t in array array['brand_domains', 'brand_domain_checks', 'brand_scans'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from public.%I', t) into n;
      rows := rows + n;
    end if;
  end loop;
  if rows > 0 and coalesce(current_setting('nightshift.brand_scan_rollback_delete_rows', true), '') <> 'yes' then
    raise exception 'rollback 0133: the brand scan tables hold % row(s) that people asked for; copy them out, then set local nightshift.brand_scan_rollback_delete_rows = ''yes'' in this transaction to delete them', rows;
  end if;
end $$;

-- 1. The functions an API role could call.
drop function if exists public.request_domain_verification(uuid, text);
drop function if exists public.check_domain_verification(uuid);
drop function if exists public.quote_brand_scan(uuid);
drop function if exists public.request_brand_scan(uuid, text, text, numeric);
drop function if exists public.accept_brand_scan_fields(uuid, uuid, text[]);
drop function if exists public.claim_domain_check(text);
drop function if exists public.finish_domain_check(uuid, text, boolean, text);
drop function if exists public.claim_brand_scan(text);
drop function if exists public.finish_brand_scan(uuid, text, jsonb);
drop function if exists public.fail_brand_scan(uuid, text, text);

-- 2. The tables (children first; no cascade).
drop table if exists public.brand_domain_checks;
drop table if exists public.brand_scans;
drop table if exists public.brand_domains;
-- The settings row refuses DELETE and TRUNCATE (its guard); DROP TABLE is neither, and takes the guard's triggers with it.
drop table if exists public.brand_scan_settings;

-- 3. The internal functions (nothing uses them now).
drop function if exists public.brand_scan_fail_locked(uuid, text);
drop function if exists public.brand_scan_price();
drop function if exists public.brand_scan_result_ok(jsonb);
drop function if exists public.brand_scan_field_ok(jsonb, text);
drop function if exists public.ads_scan_url_ok(text);
drop function if exists public.ads_scan_host_ok(text);
drop function if exists public.ads_hosting_parent(text);
drop function if exists public.brand_scan_settings_guard();
drop function if exists public.brand_scan_settings_trail();

-- 4. The end state.
do $$
begin
  if exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace
              and c.relname in ('brand_domains', 'brand_domain_checks', 'brand_scans', 'brand_scan_settings')) then
    raise exception 'rollback 0133 end state: a table of 0133 is still there';
  end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
              and p.proname in ('ads_hosting_parent', 'ads_scan_host_ok', 'ads_scan_url_ok', 'brand_scan_field_ok', 'brand_scan_result_ok',
                                'brand_scan_price', 'brand_scan_fail_locked', 'brand_scan_settings_guard', 'brand_scan_settings_trail',
                                'request_domain_verification', 'check_domain_verification', 'quote_brand_scan', 'request_brand_scan',
                                'accept_brand_scan_fields', 'claim_domain_check', 'finish_domain_check', 'claim_brand_scan',
                                'finish_brand_scan', 'fail_brand_scan')) then
    raise exception 'rollback 0133 end state: a function of 0133 is still there';
  end if;
end $$;

commit;
