-- rollback_0134_brand_scan_followup.sql — takes migration 0134 out again. OWNER-APPLY: paste into the Supabase SQL editor.
-- Nothing in the app runs it.
--
-- WHEN YOU NEED IT. If 0134's brand_scan_fail_locked() misbehaves, or before 0133's rollback (which refuses any body but 0133's).
-- READ THIS FIRST: after it, a failed brand scan again deletes from the library every picture it stored, also one a person has put into
-- a brand kit or a product while the scan was running (the kit keeps the id; the picture is gone).
--
-- WHAT IT DOES, in one transaction:
--   1. Refuses to run if brand_scan_fail_locked(uuid, text) is neither 0134's body nor 0133's (a later migration redefined it: running
--      this would silently undo that change). Compared as md5 of the body with every run of white space read as one space.
--   2. Puts brand_scan_fail_locked(uuid, text) back to 0133's body, character for character, and its grants (none to any API role).
-- No row is rewritten: a picture 0134 kept stays as it is.
--
-- tests/security/test_sec_brand_scan_followup.py applies this file to the lab database and re-applies 0134.

begin;
set local lock_timeout = '5s';

do $$
declare
  got text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into got from pg_proc p
   where p.oid = to_regprocedure('public.brand_scan_fail_locked(uuid, text)');
  if got is null or got <> all (array['fd10914ccff5aa66264ab96265e59c38', '67e8ee83bde9ec4512a3d6135c9c07ee']) then
    raise exception 'rollback 0134 found a brand_scan_fail_locked(uuid, text) that is neither 0134''s body nor 0133''s (md5 %): read the live body first', got;
  end if;
end $$;

-- 0133's body.
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
    update public.media_assets
       set deleted_at = now()
     where org_id = x.org_id and source = 'pipeline' and deleted_at is null
       and provenance ->> 'origin' = 'brand_scan' and provenance ->> 'scan_id' = x.id::text;
  end if;
end
$$;

revoke all on function public.brand_scan_fail_locked(uuid, text) from public, anon, authenticated, service_role;

do $$
begin
  if (select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) from pg_proc p
       where p.oid = 'public.brand_scan_fail_locked(uuid, text)'::regprocedure) <> '67e8ee83bde9ec4512a3d6135c9c07ee' then
    raise exception 'rollback 0134: brand_scan_fail_locked(uuid, text) does not hold 0133''s body';
  end if;
end $$;

commit;

-- Verify (should read true):
--   select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) = '67e8ee83bde9ec4512a3d6135c9c07ee'
--     from pg_proc where oid = 'public.brand_scan_fail_locked(uuid,text)'::regprocedure;
