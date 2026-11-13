-- rollback_0161_mcp_chatgpt_client.sql — takes migration 0161 (ChatGPT keeps the client it registered) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT IS LOST: nothing stored. 0161 changed which rows the collector deletes and added one internal helper. After this,
-- 0147's collector is back: a ChatGPT client whose every connection ended more than a day ago is deleted again on the next
-- collection, and ChatGPT's next sign-in with it is refused as an unknown app (the person re-creates the plugin).
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if public.oauth_gc() is not 0161's body (a later change would be undone).
--   1. Puts 0147's oauth_gc back, verbatim, with 0147's grants (none).
--   2. Drops public.oauth_chatgpt_callbacks_only(text[]) (only 0161's collector read it).
--   3. Asserts the end state: oauth_gc is 0147's body and an internal SECURITY DEFINER, and the helper is gone.

begin;
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.oauth_gc()');
  if h is distinct from 'ad18c0ed443ca49fd2943c1325bac788' then
    raise exception 'rollback 0161: public.oauth_gc() is not 0161''s body (md5 %): a later change would be undone; read the live body first', h;
  end if;
end $$;

-- 0147's collector, verbatim (0147_mcp_free_tier.sql).
create or replace function public.oauth_gc() returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_ended uuid[];
begin
  delete from public.oauth_auth_requests where ctid in (
    select ctid from public.oauth_auth_requests where expires_at < now() limit 200);
  delete from public.oauth_grants where ctid in (
    select ctid from public.oauth_grants
     where (activated_at is null and created_at < now() - interval '1 hour')
        or (revoked_at is not null and revoked_at < now() - interval '30 days')
        or absolute_expires_at < now() - interval '30 days'
     limit 200);
  delete from public.oauth_tokens where ctid in (
    select ctid from public.oauth_tokens where expires_at < now() - interval '1 day' limit 500);
  -- 0147: a client whose EVERY grant ended (revoked, or past its absolute expiry) more than 24 hours ago goes, with those
  -- grants. 0093 kept a revoked grant 30 days and never collected a client that had one, so approve-redeem-revoke kept a
  -- registration alive a month, and with Free able to approve one account could fill a class's row cap. Nothing reads an
  -- ended grant (its tokens are dead; its runs matter only while it can call; the audit log keeps it by id). Only grants
  -- that ended are deleted, so a grant made meanwhile for the same client stays, and so does its client.
  v_ended := array(
    select c.client_id from public.oauth_clients c
     where c.created_at < now() - interval '24 hours'
       and exists (select 1 from public.oauth_grants g where g.client_id = c.client_id)
       and not exists (select 1 from public.oauth_grants g where g.client_id = c.client_id
                        and coalesce(g.revoked_at, 'infinity'::timestamptz) >= now() - interval '24 hours'
                        and g.absolute_expires_at >= now() - interval '24 hours')
       -- Not while a person is on the consent screen for it (deleting the client would cascade to that request and turn
       -- their Allow into `expired`: a vendor that reuses one client id, as ChatGPT does, reconnecting after a day), nor
       -- within a day of its last authorization.
       and not exists (select 1 from public.oauth_auth_requests r where r.client_id = c.client_id and r.expires_at > now())
       and coalesce(c.last_authorized_at, c.created_at) < now() - interval '24 hours'
     limit 200);
  if cardinality(v_ended) > 0 then
    delete from public.oauth_grants g where g.client_id = any (v_ended)
       and (g.revoked_at < now() - interval '24 hours' or g.absolute_expires_at < now() - interval '24 hours');
    begin
      delete from public.oauth_clients c where c.client_id = any (v_ended)
         and not exists (select 1 from public.oauth_grants g where g.client_id = c.client_id);
    exception when foreign_key_violation then
      -- A connection approved for one of them while this ran: it keeps its client, and housekeeping never fails the
      -- registration or exchange that called it.
      null;
    end;
  end if;
  delete from public.oauth_clients c where c.ctid in (
    select c2.ctid from public.oauth_clients c2
     where c2.created_at < now() - interval '24 hours'
       and coalesce(c2.last_authorized_at, c2.created_at) < now() - case when c2.last_authorized_at is null then interval '24 hours' else interval '30 days' end
       and not exists (select 1 from public.oauth_grants g where g.client_id = c2.client_id)
     limit 200);
end
$$;

revoke all on function public.oauth_gc() from public, anon, authenticated, service_role;

drop function if exists public.oauth_chatgpt_callbacks_only(text[]);

do $$
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure('public.oauth_gc()'))
       is distinct from 'b5d0423a7df82812106021e05488d9ad'
     or exists (select 1 from pg_proc p where p.oid = 'public.oauth_gc()'::regprocedure
                 and (not p.prosecdef or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                      or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp')))
     or has_function_privilege('anon', 'public.oauth_gc()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.oauth_gc()', 'EXECUTE')
     or has_function_privilege('service_role', 'public.oauth_gc()', 'EXECUTE') then
    raise exception 'rollback 0161 end state: public.oauth_gc() is not 0147''s internal SECURITY DEFINER body';
  end if;
  if to_regprocedure('public.oauth_chatgpt_callbacks_only(text[])') is not null then
    raise exception 'rollback 0161 end state: public.oauth_chatgpt_callbacks_only(text[]) is still there';
  end if;
end $$;

commit;
