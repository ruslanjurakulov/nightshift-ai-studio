-- 0161_mcp_chatgpt_client.sql — ChatGPT keeps the client it registered (MCP over OAuth, 0093 / 0147).
--
-- EVIDENCE (vendor documentation, read 2026-11-13 before this was written):
--   OpenAI, "Authentication" for plugin MCP servers (https://developers.openai.com/plugins/build/auth, where
--   https://developers.openai.com/apps-sdk/build/auth now leads): "When the MCP server uses DCR, ChatGPT calls your
--   authorization server's registration_endpoint once for the MCP server connection, receives a generated client_id, and
--   reuses that client for the connection." and "Keep the registered OAuth client and any client secret valid while the
--   MCP server connection is in use. If your authorization server expires, deletes, or replaces either credential, users
--   and reviewers may receive an invalid_client error when they connect."
--   Anthropic, "Authentication for connectors" (https://claude.com/docs/connectors/building/authentication): "DCR causes
--   Claude to register a new client on every fresh connection". Claude is not affected by what follows.
--
-- DIAGNOSIS: 0147's collector (oauth_gc, its header section 5a) deletes a client whose EVERY grant ended more than 24 hours
--   ago, and accepts the cost in its own words: "ChatGPT and others are re-added". Every ChatGPT connection ends: at the
--   latest at its 90-day absolute cap (0093), sooner when the person presses Disconnect in Developers -> Connected apps.
--   ChatGPT then signs in again WITH THE SAME client_id. More than a day later the client is gone, /oauth/authorize can only
--   show "this connection request cannot be used" (nothing is ever redirected for an unknown client, 0093), and the person
--   must delete the plugin in ChatGPT and create it again; in a workspace plugin it may not even be theirs.
--
-- CHANGE: one hunk in the 0147 branch of oauth_gc, nothing else. A client whose every redirect URI is one of ChatGPT's own
--   callbacks (https://chatgpt.com/connector_platform_oauth_redirect and https://chatgpt.com/connector/oauth/<id>, the same
--   two shapes 0147 classes as vendor) is NOT taken by that branch for 30 days after a person's last connection with it
--   ended, for at most 3 such clients per person (the 3 whose connections ended most recently). After the 30 days 0093's own
--   rules take it exactly as before: the ended grant goes at 30 days, then the client with no grant left.
--   Why 30 days: it is how long 0093 already keeps an ended grant, so no other branch changes and no row lives longer than
--   0093 would have kept it. Why 3 a person: 0147 section 5 closed approve-redeem-revoke loops that pinned rows (50 a day a
--   person); with a 30-day window and no bound, one free account could pin 1 500 vendor rows. The vendor class holds 60 000
--   rows (Claude needs one on every connection); registrations at their hourly ceiling hold 48 000 of them for a day, which
--   leaves about 12 000 that an attacker must fill with rows that outlive a day. Under 0147 an account can hold its 20 live
--   connections plus those that ended in the last day, about 40 rows, so roughly 300 accounts fill it; 0161 adds at most 3
--   kept rows an account (about 43), so roughly 280. Live connections stay the larger lever: kept clients alone would need
--   about 4 000 accounts. Who gains what: nothing new. A ChatGPT-class client's
--   code can only ever be delivered to ChatGPT's callback (0093 matches it exactly), and a kept client gives nobody a
--   connection: every sign-in still shows the consent screen and needs the person's Allow.
--   NOT covered, on purpose: a ChatGPT client nobody ever approved is still deleted after a day (0093); keeping those
--   longer would let 2 000 unapproved registrations an hour fill the vendor cap. If ChatGPT registered and its first
--   sign-in comes more than a day later, the person re-creates the plugin, and the error page now says so.
--
-- COST: the collector runs on every registration and code exchange. Its kept set reads a STORED flag
--   (oauth_clients.chatgpt, generated from oauth_chatgpt_callbacks_only like 0147's `vendor`) through a partial index, and
--   is a left anti-join, not a per-row helper call or an array test per candidate. Measured with 7 000 people holding 6
--   ended ChatGPT clients each (42 000 rows): a first version of this file took 0.5 to 1 s a collection against 0147's 60
--   to 110 ms; the helper call alone cost 290 ms of it, the flag 75 ms.
--
-- ADDS: oauth_chatgpt_callbacks_only(text[]) (immutable, internal: no API role may call it); the generated column
--   oauth_clients.chatgpt and the partial index oauth_clients_chatgpt_idx.
-- REPLACES (md5 drift guard: 0147's body, or this file's own on a replay; whitespace runs read as one space):
--   oauth_gc (0147; never redefined since). Signature, SECURITY DEFINER, the pinned search_path and the grants (none) stay.
-- NOT CHANGED: every other 0093 / 0147 function, oauth_limits(), the vendor class and its budgets, every grant; no other
--   table or column.
--
-- NUMBER. 0161, assigned to this branch: 0158 (#731) and 0159 (#745) are merged before it, 0160 belongs to another branch.
--   Needs 0093 and 0147; names nothing of 0149's to 0159's.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only):
--   select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.oauth_gc()'::regprocedure;
--   expected BEFORE b5d0423a7df82812106021e05488d9ad (0147), AFTER d9262c411e083e9f8d970224a6cad17c (this file).
-- Undo: docs/sql/rollback_0161_mcp_chatgpt_client.sql (owner-applied). Re-running 0147 after this file is refused by 0147's
--   own drift guard (oauth_gc is not a body it knows): undo 0161 first, re-run 0147, then apply 0161 again.

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regclass('public.oauth_grants') is null or to_regprocedure('public.oauth_gc()') is null then
    raise exception '0161 needs MCP over OAuth: apply 0093_mcp_oauth.sql first';
  end if;
  if to_regprocedure('public.oauth_vendor_callbacks_only(text[])') is null
     or not exists (select 1 from pg_attribute where attrelid = 'public.oauth_clients'::regclass and attname = 'vendor' and not attisdropped) then
    raise exception '0161 needs the vendor registration class: apply 0147_mcp_free_tier.sql first';
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.oauth_gc()');
  if h is null or h <> all (array['b5d0423a7df82812106021e05488d9ad', 'd9262c411e083e9f8d970224a6cad17c']) then
    raise exception '0161 found public.oauth_gc() with a body that is neither 0147''s nor 0161''s (md5 %): read the live body first', h;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.oauth_chatgpt_callbacks_only(text[])');
  if h is not null and h <> '2a5c8c75b77b0a59556852a93c6b9cb4' then
    raise exception '0161 found public.oauth_chatgpt_callbacks_only(text[]) with a body that is not this file''s (md5 %): read the live body first', h;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Which registrations are ChatGPT's
-- ───────────────────────────────────────────────────────────────────────────

-- True when every redirect URI is one of ChatGPT's own callbacks, matched exactly as 0147's vendor class matches them: the
-- stable https://chatgpt.com/connector_platform_oauth_redirect (what ChatGPT uses with a server that returns `iss` on every
-- authorization response, as this one does) and the callback-id form https://chatgpt.com/connector/oauth/<id>. A
-- registration with any other URI is not ChatGPT's.
create or replace function public.oauth_chatgpt_callbacks_only(p text[]) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select coalesce(cardinality(p), 0) > 0 and not exists (
    select 1 from unnest(p) u
     where u is null
        or not (u = 'https://chatgpt.com/connector_platform_oauth_redirect'
                or u ~ '^https://chatgpt\.com/connector/oauth/[A-Za-z0-9_-]{1,64}$'))
$$;
revoke all on function public.oauth_chatgpt_callbacks_only(text[]) from public, anon, authenticated, service_role;

-- Stored, like 0147's `vendor`, so the collector reads a flag instead of calling the helper for every grant; existing rows
-- are classed when the column is added. A later create-or-replace of the helper does NOT reclassify stored rows.
alter table public.oauth_clients
  add column if not exists chatgpt boolean generated always as (public.oauth_chatgpt_callbacks_only(redirect_uris)) stored;
create index if not exists oauth_clients_chatgpt_idx on public.oauth_clients (client_id) where chatgpt;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The collector: 0147's body plus the ChatGPT hunk (header)
-- ───────────────────────────────────────────────────────────────────────────

-- 0147's collector (0093's, plus: a client whose every grant ended more than a day ago goes too), plus 0161's ChatGPT hunk.
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
  -- 0161: ChatGPT registers ONE client per MCP server connection and signs in with it again after a disconnect or the
  -- 90-day cap (OpenAI's auth guide: delete it and the person gets invalid_client and must re-create the plugin). So a
  -- ChatGPT-only client (oauth_clients.chatgpt) is not taken here for 30 days after the person's last connection with it
  -- ended, 0093's own retention of an ended grant (after that the grant goes, and the last delete below takes the client).
  -- At most 3 such clients a person, newest ended first, so approve-redeem-revoke cannot pin more than 3 rows an account.
  -- A left anti-join over the stored flag, not a per-row helper call and not an array test per candidate: both made a
  -- collection under a ChatGPT-class flood ten times slower than 0147's (Breach on #744).
  v_ended := array(
    with kept as (
      select k.client_id from (
        select g.client_id,
               row_number() over (partition by g.user_id order by max(least(coalesce(g.revoked_at, 'infinity'::timestamptz), g.absolute_expires_at)) desc, g.client_id) as n
          from public.oauth_grants g
          join public.oauth_clients kc on kc.client_id = g.client_id
         where kc.chatgpt and g.activated_at is not null
         group by g.user_id, g.client_id
        having max(least(coalesce(g.revoked_at, 'infinity'::timestamptz), g.absolute_expires_at)) < now()
           and max(least(coalesce(g.revoked_at, 'infinity'::timestamptz), g.absolute_expires_at)) >= now() - interval '30 days'
      ) k where k.n <= 3)
    select c.client_id from public.oauth_clients c
      left join kept on kept.client_id = c.client_id
     where c.created_at < now() - interval '24 hours'
       and kept.client_id is null
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

-- ───────────────────────────────────────────────────────────────────────────
-- 3. End state
-- ───────────────────────────────────────────────────────────────────────────

do $$
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure('public.oauth_gc()')) is distinct from 'd9262c411e083e9f8d970224a6cad17c' then
    raise exception '0161 end state: public.oauth_gc() does not hold the body this file expects';
  end if;
  if exists (select 1 from pg_proc p where p.oid = 'public.oauth_gc()'::regprocedure
              and (not p.prosecdef or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                   or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp')))
     or has_function_privilege('anon', 'public.oauth_gc()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.oauth_gc()', 'EXECUTE')
     or has_function_privilege('service_role', 'public.oauth_gc()', 'EXECUTE') then
    raise exception '0161 end state: public.oauth_gc() is not an internal SECURITY DEFINER with a fixed search_path';
  end if;
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure('public.oauth_chatgpt_callbacks_only(text[])')) is distinct from '2a5c8c75b77b0a59556852a93c6b9cb4'
     or (select provolatile from pg_proc where oid = 'public.oauth_chatgpt_callbacks_only(text[])'::regprocedure) <> 'i'
     or exists (select 1 from pg_proc p where p.oid = 'public.oauth_chatgpt_callbacks_only(text[])'::regprocedure
                 and (exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                      or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp')))
     or has_function_privilege('anon', 'public.oauth_chatgpt_callbacks_only(text[])', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.oauth_chatgpt_callbacks_only(text[])', 'EXECUTE')
     or has_function_privilege('service_role', 'public.oauth_chatgpt_callbacks_only(text[])', 'EXECUTE') then
    raise exception '0161 end state: oauth_chatgpt_callbacks_only does not hold this file''s body, or an API role may call it';
  end if;
  -- ChatGPT's two callbacks are in, and nothing else is: not Claude's, not a lookalike host, not a path below the id.
  if not public.oauth_chatgpt_callbacks_only(array['https://chatgpt.com/connector_platform_oauth_redirect'])
     or not public.oauth_chatgpt_callbacks_only(array['https://chatgpt.com/connector_platform_oauth_redirect', 'https://chatgpt.com/connector/oauth/abc_D-1'])
     or public.oauth_chatgpt_callbacks_only(array['https://claude.ai/api/mcp/auth_callback'])
     or public.oauth_chatgpt_callbacks_only(array['https://chatgpt.com/connector_platform_oauth_redirect', 'https://claude.ai/api/mcp/auth_callback'])
     or public.oauth_chatgpt_callbacks_only(array['https://chatgpt.com/connector_platform_oauth_redirect/'])
     or public.oauth_chatgpt_callbacks_only(array['https://chatgpt.com.evil.example/connector_platform_oauth_redirect'])
     or public.oauth_chatgpt_callbacks_only(array['https://chatgpt.com/connector/oauth/a/b'])
     or public.oauth_chatgpt_callbacks_only(array['http://chatgpt.com/connector_platform_oauth_redirect'])
     or public.oauth_chatgpt_callbacks_only(array[null]::text[])
     or public.oauth_chatgpt_callbacks_only(array[]::text[]) then
    raise exception '0161 end state: which registrations are ChatGPT''s is not what this file defines';
  end if;
  -- `if not exists` skips a name already there, so the column's SHAPE and the index are asserted, not only their presence.
  if (select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d
        join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
       where d.adrelid = 'public.oauth_clients'::regclass and a.attname = 'chatgpt')
       is distinct from 'oauth_chatgpt_callbacks_only(redirect_uris)'
     or (select attgenerated from pg_attribute where attrelid = 'public.oauth_clients'::regclass and attname = 'chatgpt') is distinct from 's'
     or (select format_type(atttypid, atttypmod) from pg_attribute
          where attrelid = 'public.oauth_clients'::regclass and attname = 'chatgpt' and not attisdropped) is distinct from 'boolean'
     or (select pg_get_expr(i.indpred, i.indrelid) from pg_index i where i.indexrelid = to_regclass('public.oauth_clients_chatgpt_idx'))
       is distinct from 'chatgpt' then
    raise exception '0161 end state: oauth_clients.chatgpt is not the boolean generated from oauth_chatgpt_callbacks_only(redirect_uris), or its partial index is missing';
  end if;
  -- Every ChatGPT callback is also a vendor callback (the collector reads both), so the ChatGPT rule only narrows 0147's class.
  if not public.oauth_vendor_callbacks_only(array['https://chatgpt.com/connector_platform_oauth_redirect', 'https://chatgpt.com/connector/oauth/abc_D-1']) then
    raise exception '0161 end state: ChatGPT''s callbacks are not in 0147''s vendor class';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying, in the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   md5(regexp_replace((select prosrc from pg_proc where oid = 'public.oauth_gc()'::regprocedure), '\s+', ' ', 'g'))
--     = 'd9262c411e083e9f8d970224a6cad17c' as collector_is_0161s,
--   position('kc.chatgpt' in pg_get_functiondef('public.oauth_gc()'::regprocedure)) > 0
--     and position('v_ended' in pg_get_functiondef('public.oauth_gc()'::regprocedure)) > 0 as chatgpt_kept_and_ended_rows_still_go,
--   (select attgenerated = 's' from pg_attribute where attrelid = 'public.oauth_clients'::regclass and attname = 'chatgpt')
--     and to_regclass('public.oauth_clients_chatgpt_idx') is not null as chatgpt_flag_stored,
--   public.oauth_chatgpt_callbacks_only(array['https://chatgpt.com/connector_platform_oauth_redirect'])
--     and not public.oauth_chatgpt_callbacks_only(array['https://claude.ai/api/mcp/auth_callback']) as chatgpt_class_exact,
--   not has_function_privilege('anon', 'public.oauth_chatgpt_callbacks_only(text[])', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.oauth_gc()', 'EXECUTE') as helpers_internal;
-- That the collector keeps a ChatGPT client 30 days (at most 3 a person) while a Claude client still goes a day after its
-- connection ended is proven with real grants by tests/security/test_sec_mcp_chatgpt_client.py.
