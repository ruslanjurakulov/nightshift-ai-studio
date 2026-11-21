-- rollback_0131_ads_factory.sql — takes migration 0131 (Ads Factory, Phase 1) out again. OWNER-APPLY: paste into the Supabase SQL editor.
-- Nothing in the app runs it.
--
-- WHEN YOU NEED IT. If the Ads Factory tables and functions must be withdrawn. To only HIDE the feature, switch NIGHTSHIFT_ADS_FACTORY off on
-- the Command Center (the page and /api/ads/* then answer 404); that needs no rollback and loses nothing. The switch does not close the
-- database: a signed-in editor can still call the ten functions directly through PostgREST, within the caps (0 in every cap stops creates).
-- To only move a cap, run e.g.   update public.ads_factory_cap_settings set kits_per_org = 10;   (0 refuses every create, a pause).
--
-- READ THIS FIRST: 0131 replaced nothing, so there is no earlier body to put back; this file only DROPS what 0131 added. That includes the six
-- content tables. Brand kits, products, campaigns and concepts are things people typed, so the file REFUSES (changes nothing) while any of the
-- six holds a row, unless you say in the same transaction that the rows may go:
--     set local nightshift.ads_rollback_delete_rows = 'yes';
-- (put that line right after `begin;` below). Copy the rows out first if they matter:
--     select * from public.brand_kits; select * from public.brand_products; select * from public.ad_campaigns; select * from public.ad_concepts;
-- The owner's cap numbers go with ads_factory_cap_settings (the defaults 5 / 20 / 20 / 24 return if 0131 is applied again). The security_events
-- rows that recorded changes of the numbers (kind ads.factory.caps) stay. No media library file, credit, job or other table is touched.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES if a function of 0131 does not hold 0131's body (a later migration changed it: rolling back would silently undo that), or if a
--      content table holds a row and the line above was not set. A function that is already gone is skipped (a second run changes nothing).
--   1. Drops the ten member functions.
--   2. Drops the seven tables (their policies, triggers, indexes and constraints go with them).
--   3. Drops the twelve internal functions (after the tables: the checks and triggers of the tables use them).
--   4. Asserts the end state: nothing of 0131 is left.
-- ORDER. 0131 depends on nothing after 0107 and nothing depends on it: a later Ads Factory migration (Phase 2 and on) must be rolled back
-- BEFORE this one, and this file refuses then (its drops are not `cascade`, so a foreign key from a later table stops it).
--
-- tests/security/test_sec_ads_factory.py applies this file to a copy of the lab database and re-applies 0131.

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
      ('public.ads_clean_text(text, boolean)', 'eb0cb2be33ffcb6213e858d445863bb2'),
      ('public.ads_text_ok(text, integer, integer, boolean)', '52994765248e75d72c40c690113819ce'),
      ('public.ads_text_list_ok(text[], integer, integer)', '3a5bd8e451a350dd799c9b49f6bb5061'),
      ('public.ads_palette_ok(text[])', '94dfa0449defc9f2907f6e7ba9a00243'),
      ('public.ads_closed_list_ok(text[], text[], integer, integer)', 'd932104160cc4768d10342395e74128d'),
      ('public.ads_site_url_ok(text)', '798012d1ead26b8383414e2720740fe9'),
      ('public.ads_storyboard_ok(jsonb)', 'b4576417d2448f8478888786eff3d912'),
      ('public.ads_check_images(uuid, uuid[], integer)', 'db5500a074148d993bd0a677720e7aae'),
      ('public.ads_asset_guard()', '3d8efe4d0763c2d88f35b54da1cfd025'),
      ('public.ad_concepts_guard()', '8f2f17776e0e93af231a1aec923ead88'),
      ('public.ads_factory_cap_settings_guard()', '51dafe4ec2c9f35974e9ff8289a6106b'),
      ('public.ads_factory_cap_settings_trail()', '986d228f1ab027e44e8a6837a1a49b3e'),
      ('public.save_brand_kit(uuid, uuid, text, text, uuid, text[], text[], text)', '28551886babbea8267dccf3422d03745'),
      ('public.delete_brand_kit(uuid)', '2635341c6f8197af5a99b91d7f8ffcfb'),
      ('public.save_brand_product(uuid, uuid, text, text, text, uuid[])', 'f00193c3989a989981f0d8179108c201'),
      ('public.delete_brand_product(uuid)', 'aca660b2900525114369e581ee8eedd4'),
      ('public.save_ad_campaign(uuid, uuid, text, text, text, text[], text[], uuid[])', '48077ccfd1968be7f3535d9777db2c6f'),
      ('public.delete_ad_campaign(uuid)', '03100c6f93d056b76cc6e839ba17f2f7'),
      ('public.add_ad_concepts(uuid, text, jsonb)', '3dc299ada52f732782fb21b443327c21'),
      ('public.update_ad_concept(uuid, text, text, text, text, jsonb)', 'bcc4a24774ed10f0f32b6b49a1b4b31c'),
      ('public.set_ad_concept_status(uuid, text)', '2dc00601b38a309c19176bb786bac11b'),
      ('public.delete_ad_concept(uuid)', 'b7d4b35b581b130191efb1b29423c41f')
    ) v(sig, want)
  loop
    select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) into got from pg_proc where oid = to_regprocedure(r.sig);
    if got is not null and got <> r.want then
      raise exception 'rollback 0131: % is not 0131''s body (md5 %): a later change would be undone; read the live body first', r.sig, got;
    end if;
  end loop;
  foreach t in array array['brand_kits', 'brand_products', 'brand_product_images', 'ad_campaigns', 'ad_campaign_products', 'ad_concepts'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from public.%I', t) into n;
      rows := rows + n;
    end if;
  end loop;
  if rows > 0 and coalesce(current_setting('nightshift.ads_rollback_delete_rows', true), '') <> 'yes' then
    raise exception 'rollback 0131: the Ads Factory tables hold % row(s) that people wrote; copy them out, then set local nightshift.ads_rollback_delete_rows = ''yes'' in this transaction to delete them', rows;
  end if;
end $$;

-- 1. The functions a member could call.
drop function if exists public.save_brand_kit(uuid, uuid, text, text, uuid, text[], text[], text);
drop function if exists public.delete_brand_kit(uuid);
drop function if exists public.save_brand_product(uuid, uuid, text, text, text, uuid[]);
drop function if exists public.delete_brand_product(uuid);
drop function if exists public.save_ad_campaign(uuid, uuid, text, text, text, text[], text[], uuid[]);
drop function if exists public.delete_ad_campaign(uuid);
drop function if exists public.add_ad_concepts(uuid, text, jsonb);
drop function if exists public.update_ad_concept(uuid, text, text, text, text, jsonb);
drop function if exists public.set_ad_concept_status(uuid, text);
drop function if exists public.delete_ad_concept(uuid);

-- 2. The tables (children first; no cascade: a later table that references one of these stops the rollback).
drop table if exists public.ad_concepts;
drop table if exists public.ad_campaign_products;
drop table if exists public.ad_campaigns;
drop table if exists public.brand_product_images;
drop table if exists public.brand_products;
drop table if exists public.brand_kits;
-- The settings row refuses DELETE and TRUNCATE (its guard); DROP TABLE is neither, and takes the guard's triggers with it.
drop table if exists public.ads_factory_cap_settings;

-- 3. The internal functions (nothing uses them now).
drop function if exists public.ads_clean_text(text, boolean);
drop function if exists public.ads_text_ok(text, integer, integer, boolean);
drop function if exists public.ads_text_list_ok(text[], integer, integer);
drop function if exists public.ads_palette_ok(text[]);
drop function if exists public.ads_closed_list_ok(text[], text[], integer, integer);
drop function if exists public.ads_site_url_ok(text);
drop function if exists public.ads_storyboard_ok(jsonb);
drop function if exists public.ads_check_images(uuid, uuid[], integer);
drop function if exists public.ads_asset_guard();
drop function if exists public.ad_concepts_guard();
drop function if exists public.ads_factory_cap_settings_guard();
drop function if exists public.ads_factory_cap_settings_trail();

-- 4. The end state.
do $$
begin
  if to_regclass('public.brand_kits') is not null or to_regclass('public.brand_products') is not null
     or to_regclass('public.brand_product_images') is not null or to_regclass('public.ad_campaigns') is not null
     or to_regclass('public.ad_campaign_products') is not null or to_regclass('public.ad_concepts') is not null
     or to_regclass('public.ads_factory_cap_settings') is not null then
    raise exception 'rollback 0131 end state: a table of 0131 is still there';
  end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
              and (p.proname like 'ads\_%' or p.proname = 'ad_concepts_guard'
                   or p.proname in ('save_brand_kit', 'delete_brand_kit', 'save_brand_product', 'delete_brand_product', 'save_ad_campaign',
                                    'delete_ad_campaign', 'add_ad_concepts', 'update_ad_concept', 'set_ad_concept_status', 'delete_ad_concept'))) then
    raise exception 'rollback 0131 end state: a function of 0131 is still there';
  end if;
end $$;

commit;
