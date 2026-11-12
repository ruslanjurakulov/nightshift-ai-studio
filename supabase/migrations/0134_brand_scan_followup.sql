-- 0134_brand_scan_followup.sql — a failed brand scan no longer deletes a picture a person already put into a brand kit or a product.
-- (The two Low items of 0133's final delta review, docs/ADS_FACTORY.md "Known limits (Phase 2)".)
--
-- WHAT WAS WRONG
--   0133's brand_scan_fail_locked() marks deleted (media_assets.deleted_at) every picture the worker stored for a scan that fails. The
--   worker stores them BEFORE the scan finishes, and they are ordinary pictures of the organization's library, so a member can put one
--   into a brand kit (its logo) or a product (its pictures) while the scan is still running. When the scan then failed, that picture was
--   deleted from under the kit: the kit kept the id, the library no longer showed it, and the media worker removed the file.
--
-- WHAT THIS CHANGES (one function, nothing else)
--   brand_scan_fail_locked(uuid, text): 0133's body, plus two things before the delete:
--     1. the scan's candidate pictures are locked FOR UPDATE. A kit or product write that already references one holds FOR KEY SHARE on
--        it (the foreign key check), so the failure waits until that write commits or rolls back;
--     2. the delete is a separate statement, so it reads the kits and products as they are AFTER that wait (READ COMMITTED takes a new
--        snapshot per statement). It skips every picture that a brand kit or a product picture references.
--   The columns that reference media_assets from 0131's tables are exactly brand_kits.logo_asset_id and brand_product_images.asset_id
--   (brand_products, ad_campaigns, ad_campaign_products and ad_concepts hold none). The guard below checks that list against the live
--   catalogue, so a later column cannot be missed silently.
--   A skipped picture stays an ordinary library picture. The scan still fails, and its hold is still released.
--
-- LOCK ORDER (0131's rule: no function holds a row lock while it waits for an advisory lock). brand_scan_fail_locked takes NO advisory
-- lock. Its callers already hold what they hold (request_brand_scan: the organization's and the platform's advisory locks; claim_brand_scan
-- and fail_brand_scan: none) and the scan's row lock. It then takes the picture row locks. Every other writer that touches both a scan and
-- its pictures takes them in the same order (accept_brand_scan_fields: the scan row, then the pictures through its inserts). A kit or
-- product writer takes 0131's lock, then the kit row, then the picture's key-share lock, and never a scan row. So no cycle can form.
--
-- WHAT IT DOES NOT CHANGE
--   No table, column, policy, grant or trigger. No other function. No price: brand_scan_settings.price_credits stays as it is (NULL until
--   the owner's go-live step, docs/ADS_FACTORY.md "Releasing Phase 2").
--
-- NUMBER. 0134: 0132 is taken by an open pull request (the hi-res export) and 0135 is reserved for character studio.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only):
--   select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.brand_scan_fail_locked(uuid,text)'::regprocedure;
--     -- 67e8ee83bde9ec4512a3d6135c9c07ee (0133's body) before; 0134's own (below) after.
--
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor runs a file as one). Rollback: docs/sql/rollback_0134_brand_scan_followup.sql (it
-- puts 0133's body back; run it BEFORE 0133's rollback, which refuses any body but 0133's).
-- REQUIRES 0038 (media_assets), 0131 (brand_kits, brand_product_images) and 0133 (brand_scans and the body this file extends).

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.media_assets') is null then
    raise exception '0134 needs 0038_media_assets.sql: apply it first';
  end if;
  if to_regclass('public.brand_kits') is null or to_regclass('public.brand_product_images') is null then
    raise exception '0134 needs 0131_ads_factory.sql (brand_kits, brand_product_images): apply it first';
  end if;
  if to_regclass('public.brand_scans') is null or to_regprocedure('public.brand_scan_fail_locked(uuid, text)') is null then
    raise exception '0134 needs 0133_brand_scan.sql (brand_scans, brand_scan_fail_locked): apply it first';
  end if;
end $$;

-- Replaced on the body the repository says is latest (0133's). A live body that is neither 0133's nor this file's own (a replay) was
-- changed by hand after 0133: replacing it would silently undo that change, so the file refuses. md5 of prosrc with every run of white
-- space read as one space; tests/test_brand_scan_followup_migration.py recomputes both hashes from the files.
do $$
declare
  got text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into got from pg_proc p
   where p.oid = 'public.brand_scan_fail_locked(uuid, text)'::regprocedure;
  if got <> all (array['67e8ee83bde9ec4512a3d6135c9c07ee', 'fd10914ccff5aa66264ab96265e59c38']) then
    raise exception '0134 found a brand_scan_fail_locked(uuid, text) that is neither 0133''s body nor 0134''s (md5 %): read the live body first', got;
  end if;
end $$;

-- Every column of 0131's tables that references media_assets is one this file's function checks. A new one must be added to it first.
do $$
declare
  found text[];
begin
  select coalesce(array_agg(c.conrelid::regclass::text || '.' || a.attname order by c.conrelid::regclass::text, a.attname), '{}') into found
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
   where c.contype = 'f' and c.confrelid = 'public.media_assets'::regclass
     and c.conrelid in ('public.brand_kits'::regclass, 'public.brand_products'::regclass, 'public.brand_product_images'::regclass,
                        'public.ad_campaigns'::regclass, 'public.ad_campaign_products'::regclass, 'public.ad_concepts'::regclass);
  if found <> array['brand_kits.logo_asset_id', 'brand_product_images.asset_id'] then
    raise exception '0134: the brand kit and product columns that reference media_assets are % (expected brand_kits.logo_asset_id and brand_product_images.asset_id): extend brand_scan_fail_locked first', found;
  end if;
end $$;

-- Fail a scan the caller has locked, and give its hold back. creative_platform_release clears the caller's claims for the one call, so a
-- member's request (sweeping its organization's stale scan) and the worker reach release_credits alike; a hold already gone returns 0.
-- The pictures the worker stored for this scan (source pipeline, provenance origin brand_scan and this scan's id, the scan's own
-- organization) are deleted from the library as a member's delete is (deleted_at; the media worker then removes the files and gives the
-- bytes back to the quota): a failed scan leaves nothing behind. A ready scan's pictures are never touched here. 0134: a picture a brand
-- kit (its logo) or a product (its pictures) references is kept. The candidates are locked first, so a kit or product write that already
-- references one is waited for, and the delete, a statement of its own, then reads the kits and products as they are after that wait.
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
  if x.id is not null then
    perform 1 from public.media_assets
     where org_id = x.org_id and source = 'pipeline' and deleted_at is null
       and provenance ->> 'origin' = 'brand_scan' and provenance ->> 'scan_id' = x.id::text
       for update;
    update public.media_assets m
       set deleted_at = now()
     where m.org_id = x.org_id and m.source = 'pipeline' and m.deleted_at is null
       and m.provenance ->> 'origin' = 'brand_scan' and m.provenance ->> 'scan_id' = x.id::text
       and not exists (select 1 from public.brand_kits k where k.logo_asset_id = m.id)
       and not exists (select 1 from public.brand_product_images i where i.asset_id = m.id);
  end if;
end
$$;

revoke all on function public.brand_scan_fail_locked(uuid, text) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- The end state: the body is this file's, nobody but its definer callers may run it, and its callers are 0133's.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  fn  oid := 'public.brand_scan_fail_locked(uuid, text)'::regprocedure;
  got text;
  caller text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into got from pg_proc p where p.oid = fn;
  if got <> 'fd10914ccff5aa66264ab96265e59c38' then
    raise exception '0134 end state: brand_scan_fail_locked(uuid, text) does not hold this file''s body (md5 %)', got;
  end if;
  if exists (select 1 from pg_proc p
              where p.oid = fn
                and (p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a
                                 where a.grantee = 0
                                    or a.grantee in (select o.oid from pg_roles o where o.rolname in ('anon', 'authenticated', 'service_role'))))) then
    raise exception '0134 end state: brand_scan_fail_locked(uuid, text) is executable by an API role';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = fn and p.prosecdef and p.proconfig @> array['search_path=public, pg_temp']) then
    raise exception '0134 end state: brand_scan_fail_locked(uuid, text) is not security definer with a pinned search_path';
  end if;
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'brand_scan_fail_locked') <> 1 then
    raise exception '0134 end state: brand_scan_fail_locked has an overload';
  end if;
  foreach caller in array array['request_brand_scan(uuid, text, text, numeric)', 'claim_brand_scan(text)', 'fail_brand_scan(uuid, text, text)'] loop
    if position('brand_scan_fail_locked(' in (select prosrc from pg_proc where oid = ('public.' || caller)::regprocedure)) = 0 then
      raise exception '0134 end state: public.% no longer fails a scan through brand_scan_fail_locked', caller;
    end if;
  end loop;
end $$;

-- Verify (the SQL editor, after applying; should read true):
--   select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) = 'fd10914ccff5aa66264ab96265e59c38'
--     from pg_proc where oid = 'public.brand_scan_fail_locked(uuid,text)'::regprocedure;
