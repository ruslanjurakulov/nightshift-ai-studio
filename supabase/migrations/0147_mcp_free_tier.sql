-- 0147_mcp_free_tier.sql — connecting an AI app with OAuth (MCP, 0093) on EVERY plan, Free included, limited by site credits;
-- the API-key door's two spend-limit refusals name where the limit is raised; one rate unit per OAuth tool call, not two.
-- Owner decision (2026-11-13): "Connect an app" (Claude, ChatGPT, ...) is open on every plan and limited only by site credits;
-- the API-key door (prepaid USD balance, activation, docs/API.md) is unchanged.
--
-- *** LIVE ON APPLY. *** A Free workspace can approve a connection on the consent screen from the moment this is applied, and a
-- connection that 0093 had paused for the plan (`paused_plan`) works again on its next call with no reconnect.
--
-- 1. EVERY PLAN MAY CONNECT (the plan gate goes; the credit rule was already there)
--    Evidence: `mcp` (0034, enforced by 0093) is read by exactly seven functions, all 0093's: oauth_ctx (every call),
--    oauth_begin_authorization (Free got no request row), oauth_decide_authorization, oauth_exchange_code, oauth_refresh
--    (`subscription_required`), oauth_check (`entitled`) and oauth_my_grants (`paused_plan`). No other function, route or
--    worker reads it (grep of supabase/, command-center/, modules/), so nothing that should stay paid depends on it.
--    Decision: take the check out of those seven rather than set Free's row to true. The owner's rule is about the door, not a
--    plan: a per-plan row would let a new plan, a default (a lapsed subscription falls to it) or one UPDATE close the door again
--    for some workspaces, and keep `subscription_required` / `paused_plan` alive for a rule that no longer exists. The key is set
--    back to `planned` (stored, checked nowhere, never advertised: 0034's meaning), true for every plan and by default, so the
--    pricing matrix and the Usage page stop showing "Free: no", and the catalog does not contradict the rule.
--    What still limits a connection, unchanged: the credits a video holds (reserve_credits inside 0094's oauth_create_video,
--    refused with `insufficient_credits` before anything is held when the workspace has too few; credits from any source count:
--    welcome 0027, packs, plan credits, subject to the workspace's own "use extra credits" switch 0094), the connection's monthly
--    credit limit, the plan's videos at once (`run_limit_reached`), 120 requests a minute, the scopes, revocation, the workspace
--    membership check, and the operator's exemption. Adding credits (a pack OR a plan) makes the same connection work on its next
--    call: every check is live.
--
-- 2. THE API-KEY DOOR'S SPEND LIMITS SAY WHERE THEY ARE RAISED (rule 6; #707 bug 9)
--    api_create_video and api_request_download are 0042's bodies (never redefined since) with ONE change each: the sentences of
--    `monthly_limit_reached` and `key_limit_reached` name the Developer console place that raises the limit. Codes, statuses,
--    details, order of checks and every other line are byte for byte 0042's (tests/test_mcp_free_tier_migration.py).
--
-- 3. ONE RATE UNIT PER OAUTH TOOL CALL (#707's design, with its reviewer's constraints)
--    The MCP route calls oauth_check (the only read of the token's resource binding and scopes) and then each tool's api_*
--    function, whose api_begin -> oauth_ctx took a second unit: 120 a minute meant about 60 tool calls.
--      oauth_check_credits (grant_id, request_id, created_at; primary key (grant_id, request_id)). RLS on, no grant to any API
--        role. Its foreign key to oauth_grants is DEFERRABLE INITIALLY DEFERRED only so the end-state block below can exercise
--        the two helpers on a made-up grant inside a block it rolls back, without creating a person or a workspace here; a
--        deleted grant still takes its rows with it (a cascade is never deferred).
--      oauth_check_credit_put(grant, request id): after oauth_check has counted the request and let it through (never on a 401
--        or a 429), one credit for (grant, request id) when the id has the route's shape ^req_[A-Za-z0-9]{24}$
--        (lib/api/http.ts newRequestId), `on conflict do nothing`, and that grant's credits older than 2 minutes are pruned.
--      oauth_check_credit_take(grant, request id): one DELETE ... RETURNING of that credit if it is younger than a minute.
--        Two calls racing for one credit: the second waits on the row and finds it gone, so exactly one is free.
--      oauth_ctx: when it took a credit it READS this minute's count instead of incrementing it, and keeps `v_used > v_rpm`, so
--        the call the check admitted is not refused for the check's own unit; otherwise it takes a unit as before. Every other
--        check of oauth_ctx (the token, the endpoint allow-list, the workspace membership, the scope) still runs.
--    Invariant: every oauth_check still costs one unit and makes at most ONE later call free. A batch of N tool calls costs N
--    units (the API-key door's count); calling the functions directly with a forged or reused request id gains at most the one
--    call its own counted check paid for. Pruned per grant, a grant holds at most about two minutes of admitted checks.
--    One fixed minute can SEE up to about 240 tool calls: a check admitted at 0:59 leaves a credit its call may spend at
--    1:00, inside the next minute's 120. Over any two minutes the count stays 240 (120 a minute sustained), and every call
--    that makes a video is still bound by the workspace's credits and the connection's monthly limit.
--
-- 4. AN AI VENDOR'S SHARED SERVERS CAN REGISTER FOR EVERY PERSON (dynamic client registration, RFC 7591)
--    Evidence (vendor documentation, checked before this was built): Claude registers a NEW client on every fresh connection
--    and all of Anthropic's traffic comes from one published range (160.79.104.0/21); ChatGPT registers once per MCP server
--    connection. 0093 allowed 10 registrations an address an hour, 300 an hour in total and 20 000 rows: the "address" is the
--    vendor's server, not the person, so the 11th Claude user in an hour was refused (`rate_limited`, 429).
--    Decision: a registration whose EVERY redirect URI is one of the vendors' own callbacks is its own class (oauth_clients
--    .vendor, generated from the URIs by oauth_vendor_callbacks_only, so it cannot disagree with them):
--      https://claude.ai/api/mcp/auth_callback, https://chatgpt.com/connector_platform_oauth_redirect,
--      https://chatgpt.com/connector/oauth/<id> (<id>: 1 to 64 of A-Z a-z 0-9 _ -), Grok's
--      https://grok.com/connectors-oauth-exchange-code/ (with its trailing slash), and Gemini's
--      https://oauth-redirect.googleusercontent.com/r/<seg> and /a/<seg> (Google's MCP OAuth guide lists /r/* and /a/*
--      without defining *; <seg> is ONE path segment of 1 to 128 of A-Z a-z 0-9 . _ ~ -, starting with a letter or digit;
--      Google's -sandbox / -test hosts stay ordinary). Any other shape is the ordinary class: it still registers, at the
--      old limits, so a vendor whose real callback differs is throttled as before, never refused outright.
--    It gets 300 an address an hour, 2 000 an hour in total and its own 60 000-row cap; the ordinary class keeps exactly 0093's
--    10 / 300 / 20 000, counted over ordinary rows only, so neither class can spend the other's budget. Why that is not an abuse
--    hole: the code of a vendor-class client can only ever be delivered to the vendor's own callback (0093 matches it exactly),
--    so registering one gains an attacker nothing but a row. Saturating the vendor ceiling takes 7 addresses where the
--    ordinary one took 30: the hourly ceiling is the trade-off, one number in oauth_limits().
--    oauth_register_client is 0093's body with four hunks (the class, the per-class counts, the per-class row cap);
--    oauth_limits gains the three numbers.
--
-- 5. ROWS STAY BOUNDED NOW THAT FREE CAN APPROVE (review of #713)
--    Found: 0093's collector (oauth_gc) deletes a registration nobody approved after a day, but never one that has a grant,
--    and keeps a revoked grant 30 days; the 20-connection cap counts live grants only. So register, approve, redeem the code
--    (the attacker holds the PKCE verifier), revoke, repeat: every cycle kept a registration alive a month. Before 0147 that
--    needed a paid plan; with Free able to approve, one free account could fill a class's row cap (the vendor's 60 000 in
--    about 30 hours at its ceiling, the ordinary 20 000 in about 67) and close registration for every real user for a month.
--    Two changes, both needed:
--      a. oauth_gc (0093's body plus one hunk) also deletes a client whose EVERY grant ended (revoked, or past its absolute
--         expiry) more than 24 hours ago, with those grants. Chosen over "revoked grants stop counting" because that would
--         leave the rows themselves unbounded (the hourly ceiling times 30 days is 1.4 million vendor rows), and over
--         shortening every revoked grant's 30 days because a client with one live grant must keep its rows. Nothing reads an
--         ended grant: its tokens are revoked or expired, its runs (idempotency, the monthly limit) matter only while it can
--         call, and the audit log keeps mcp.connect / mcp.disconnect by id. The cost: an app whose connection was revoked
--         more than a day ago is an unknown client; Claude registers anew on every connection anyway, ChatGPT and others are
--         re-added (0093 already dropped such a client 30 days after its last authorization).
--      b. oauth_decide_authorization refuses a new connection (`too_many_connections_today`) once 50 were approved by that
--         person, or 200 in that workspace, in the last 24 hours, revoked ones included. 50 is far above a real person:
--         Claude makes one connection per fresh connect, and 20 can be live at once; 200 is four admins at that pace. It caps
--         how fast one account can make rows at all; the per-workspace lock makes the counts exact under concurrent approvals.
--    What a class can hold now: registrations made in the last 24 hours (hourly ceiling x 24: 48 000 vendor, 7 200
--    ordinary, both under their caps), plus clients that still have a live grant or one that ended less than a day ago,
--    which is at most 20 live + 20 just-ended per account. So a flood held at the ceiling cannot fill a class; filling one
--    takes roughly 300 accounts each holding its 20 live connections, the same exposure a paid plan had before (visible in
--    oauth_grants, and revoking them frees the rows a day later).
--
-- REPLACES (md5 drift guard: the earlier body, or this file's own on a replay; whitespace runs read as one space)
--   oauth_ctx, oauth_check, oauth_begin_authorization, oauth_decide_authorization, oauth_exchange_code, oauth_refresh,
--   oauth_my_grants, oauth_limits, oauth_register_client, oauth_gc (0093; never redefined since), api_create_video, api_request_download (0042; never redefined since).
--   Signatures, SECURITY DEFINER, the pinned search_path and the grants stay as those migrations made them (restated below).
-- ADDS: oauth_check_credits, oauth_check_credit_put / _take, oauth_vendor_callbacks_only, the generated column
--   oauth_clients.vendor and its index, two indexes on oauth_grants (client_id; org_id, created_at) for the collector and
--   the daily counts, and oauth_mcp_entitlement_before_0147 (each plan's `mcp` value before this file, for the rollback).
-- NOT CHANGED: oauth_create_video / oauth_get_balance (0094), oauth_get_job (0111), api_begin (0093), oauth_rate_take,
--   oauth_token_state, oauth_redirect_uri_ok, the credit ledger, the audit list, any other table or column of 0093.
--
-- NUMBER. 0147: live is at 0146 (#702, 2026-11-13); 0148 is reserved by another branch. Names nothing of 0143's, 0145's or
-- 0146's. Needs 0034, 0042, 0093 (and 0094 for the credit refusal the connection relies on).
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only):
--   select p.oid::regprocedure, md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc p
--    where pronamespace = 'public'::regnamespace and proname in ('oauth_ctx', 'oauth_check', 'oauth_begin_authorization',
--          'oauth_decide_authorization', 'oauth_exchange_code', 'oauth_refresh', 'oauth_my_grants', 'api_create_video',
--          'api_request_download');
--   expected BEFORE (0093 / 0042) and AFTER: in the drift guard right below.
-- Undo: docs/sql/rollback_0147_mcp_free_tier.sql (owner-applied). It puts the plan gate back: Free connections pause again.

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  h text;
  trio text[];
begin
  if to_regclass('public.oauth_grants') is null or to_regclass('public.oauth_rate_counters') is null
     or to_regprocedure('public.oauth_rate_take(uuid)') is null
     or to_regprocedure('public.oauth_token_state(text)') is null then
    raise exception '0147 needs MCP over OAuth: apply 0093_mcp_oauth.sql first';
  end if;
  if to_regclass('public.entitlement_keys') is null or to_regclass('public.plan_entitlements') is null then
    raise exception '0147 needs plans and entitlements: apply 0034_plans_entitlements.sql first';
  end if;
  -- Each function this file replaces: the body it was written on, or this file's own (a replay).
  foreach trio slice 1 in array array[
      ['public.oauth_ctx(text, text, text)', 'bcd7e88f9a62af2ebdf3623dca73c014', 'fe42c9e4f53a6c9aaba40077ce905cdc'],
      ['public.oauth_check(text, text)', '43271cf097d7e56cada31febe5eb0efe', '7b53e3c9b4b6c6c74daa9eff3fe028bc'],
      ['public.oauth_begin_authorization(uuid, text, text, text, text, text, text, text)', 'df8f5a04ee8ee2188502ad3c69382d52', '1d77b561efdb9347dc9465e66fa87e8c'],
      ['public.oauth_decide_authorization(text, boolean, numeric, text)', '84227fee357456de62c5b22e7a4d30d6', '3b5236152d66117425e44e2d5132b9eb'],
      ['public.oauth_exchange_code(text, uuid, text, text, text, text, text)', '991015aa1d7bf75ad9396382b55c9e07', '1d682787edc3c06691d537cd65039842'],
      ['public.oauth_refresh(text, uuid, text, text, text)', '5e6602cf0b679ccc06b151a1c3c2c7f4', '3d8ff8c8084563f79ab7d09cfd87a2a6'],
      ['public.oauth_my_grants()', '1ce7826facd2f15a241d594bbed9768c', '595922d17683b2e0620612f60c5d10c3'],
      ['public.oauth_limits()', '26991d89b0f198dd4016b5156a8b0be1', 'c2d715dcc24280d63b065ca0bf6db92d'],
      ['public.oauth_register_client(text, text[], text)', '4ca23a05570337e930413dd109b7c78c', '51d0b4f6ee421aa0fd276b09c108da2f'],
      ['public.oauth_gc()', '4db1c8c636cef1a4413c80a0cb48b9b5', 'db1e58fa3381bced067a36b44b476ebf'],
      ['public.api_create_video(text, text, jsonb, text, text, text)', 'c054107143ba7bbfaaaff861d5575ecb', 'cba47be1a674f5cea3b5d7443bc31bab'],
      ['public.api_request_download(text, text, text, text, text, text)', 'b89909c57a27a5ab7d0fa3368f1a3677', '055003f8a2fb5390bbd1b5f7820e6e2e']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(trio[1]);
    if h is null or h <> all (array[trio[2], trio[3]]) then
      raise exception '0147 found % with a body that is neither the one it was written on nor 0147''s (md5 %): read the live body first', trio[1], h;
    end if;
  end loop;
  -- Each name this file creates: absent, or this file's own body.
  foreach trio slice 1 in array array[
      ['public.oauth_check_credit_put(uuid, text)', 'b50cfb0cfaa7d8a57512f3381d6b72e3', ''],
      ['public.oauth_check_credit_take(uuid, text)', '7092b99bdaef02719f247dcd26d77c08', ''],
      ['public.oauth_vendor_callbacks_only(text[])', 'e4c9b0824b91bc3c6ff3b10e91934a74', '']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(trio[1]);
    if h is not null and h <> trio[2] then
      raise exception '0147 found % with a body that is not this file''s (md5 %): read the live body first', trio[1], h;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The check's credit: one free call per counted check
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.oauth_check_credits (
  grant_id   uuid not null references public.oauth_grants (id) on delete cascade deferrable initially deferred,
  request_id text not null check (request_id ~ '^req_[A-Za-z0-9]{24}$'),
  created_at timestamptz not null default now(),
  primary key (grant_id, request_id)
);
alter table public.oauth_check_credits enable row level security;
revoke all on table public.oauth_check_credits from public, anon, authenticated, service_role;
comment on table public.oauth_check_credits is
  '0147: one credit per (connection, request id) that oauth_check counted and let through; the first oauth_ctx of that request takes it instead of a second rate unit. RLS on, no API role has access; only the definer functions touch it.';

-- After oauth_check counted and admitted a request: one credit for it. Only the route's request-id shape is kept, so a caller
-- inventing ids cannot fill the table with rows of its own making, and the grant's stale credits go with every new one.
create or replace function public.oauth_check_credit_put(p_grant uuid, p_request_id text) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if p_grant is null or coalesce(p_request_id, '') !~ '^req_[A-Za-z0-9]{24}$' then
    return;
  end if;
  delete from public.oauth_check_credits c where c.grant_id = p_grant and c.created_at < now() - interval '2 minutes';
  insert into public.oauth_check_credits (grant_id, request_id) values (p_grant, p_request_id)
  on conflict (grant_id, request_id) do nothing;
end
$$;

-- True when this call took the credit its request's check left. One statement, so of two calls racing for one credit the second
-- waits on the row lock, re-reads, finds the row gone and is counted: one check never pays for two calls.
create or replace function public.oauth_check_credit_take(p_grant uuid, p_request_id text) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_taken boolean;
begin
  if p_grant is null or coalesce(p_request_id, '') !~ '^req_[A-Za-z0-9]{24}$' then
    return false;
  end if;
  delete from public.oauth_check_credits c
   where c.grant_id = p_grant and c.request_id = p_request_id and c.created_at > now() - interval '1 minute'
  returning true into v_taken;
  return coalesce(v_taken, false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1b. The vendor class of a registration
-- ───────────────────────────────────────────────────────────────────────────

-- True when every redirect URI is an AI vendor's own callback, matched exactly (the id of a ChatGPT connector and the one
-- path segment of Google's redirect by shape). A registration with even one other URI is ordinary: its code could go
-- somewhere that is not the vendor. Google's own test hosts (oauth-redirect-sandbox / -test) are deliberately ordinary: the
-- class is for the production servers that register for every person. A Gemini segment starts with a letter or digit so
-- a dot-only segment cannot climb out of /r/ or /a/ (the host stays Google's either way).
create or replace function public.oauth_vendor_callbacks_only(p text[]) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select coalesce(cardinality(p), 0) > 0 and not exists (
    select 1 from unnest(p) u
     where u is null
        or not (u = any (array['https://claude.ai/api/mcp/auth_callback',
                               'https://chatgpt.com/connector_platform_oauth_redirect',
                               'https://grok.com/connectors-oauth-exchange-code/']::text[])
                or u ~ '^https://chatgpt\.com/connector/oauth/[A-Za-z0-9_-]{1,64}$'
                or u ~ '^https://oauth-redirect\.googleusercontent\.com/[ra]/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$'))
$$;
revoke all on function public.oauth_vendor_callbacks_only(text[]) from public, anon, authenticated, service_role;

-- Generated, so the class is always what the stored URIs say; existing rows are classed when the column is added. STORED: the
-- value is computed when a row is written, so a later create-or-replace of oauth_vendor_callbacks_only does NOT reclassify
-- rows already there (PostgreSQL does not recompute a stored column when the function changes). A later change to the
-- class must rewrite the column itself (for example `update public.oauth_clients set redirect_uris = redirect_uris`).
alter table public.oauth_clients
  add column if not exists vendor boolean generated always as (public.oauth_vendor_callbacks_only(redirect_uris)) stored;
create index if not exists oauth_clients_vendor_idx on public.oauth_clients (vendor, created_at);
-- The collector looks up a client's grants (0093 had no index on it), and oauth_decide_authorization counts a workspace's
-- connections of the last day.
create index if not exists oauth_grants_client_idx on public.oauth_grants (client_id);
create index if not exists oauth_grants_org_created_idx on public.oauth_grants (org_id, created_at);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. 0093's OAuth functions: no plan gate; oauth_check leaves the credit, oauth_ctx takes it; registration by class
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.oauth_ctx(p_hash text, p_endpoint text, p_request_id text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  st       jsonb := public.oauth_token_state(p_hash);
  v_scope  text;
  v_grant  uuid;
  v_org    uuid;
  v_user   uuid;
  v_exempt boolean;
  v_rpm    integer := (public.oauth_limits() ->> 'rpm')::integer;
  v_minute timestamptz := date_trunc('minute', now());
  v_used   integer;
  v_reset  integer;
  ctx      jsonb;
begin
  if st is null then
    -- Exactly what an unknown API key gets, so the two doors answer alike.
    return public.api_err(401, 'invalid_api_key', 'The API key is missing, malformed, revoked or unknown.');
  end if;
  v_grant := (st ->> 'grant_id')::uuid;
  v_org := (st ->> 'org_id')::uuid;
  v_user := (st ->> 'user_id')::uuid;
  v_exempt := public.credits_exempt(v_org);

  v_reset := greatest(1, ceil(extract(epoch from (v_minute + interval '1 minute' - now())))::integer);
  -- 0147: the MCP route's oauth_check already took this request's unit and left a credit for its request id,
  -- so the first call of that request reads this minute's count instead of taking a second unit (with two
  -- units per tool call, 120 a minute meant about 60 tool calls). The test below stays `>`, so the call the
  -- check admitted is not refused for the check's own unit; any other call is counted as before.
  if public.oauth_check_credit_take(v_grant, p_request_id) then
    select coalesce(max(c.count), 0) into v_used from public.oauth_rate_counters c
     where c.grant_id = v_grant and c.minute = v_minute;
  else
    v_used := public.oauth_rate_take(v_grant);
  end if;

  ctx := jsonb_build_object('ok', true, 'key_id', null, 'grant_id', v_grant, 'oauth', true, 'org_id', v_org,
    'created_by', v_user, 'exempt', v_exempt, 'rpm', v_rpm, 'scopes', st -> 'scopes',
    'limit_credits', st -> 'limit_credits',
    'remaining', greatest(0, v_rpm - v_used), 'reset', v_reset,
    'endpoint', coalesce(p_endpoint, 'unknown'), 'request_id', p_request_id);

  if v_used > v_rpm then
    return public.api_finish(ctx, public.api_err(429, 'rate_limit_exceeded',
      format('This connection is limited to %s requests per minute.', v_rpm),
      jsonb_build_object('retry_after', v_reset)));
  end if;

  begin
    v_scope := public.oauth_endpoint_scope(p_endpoint);
    if v_scope is null then
      return public.api_finish(ctx, public.api_err(403, 'not_available_for_connected_apps',
        'This action is not available to connected apps. It needs an API key.'));
    end if;

    -- 0147: no plan check. Every plan may connect an app; a video it makes is held through reserve_credits
    -- (insufficient_credits when the workspace has too few) and capped by the connection's monthly limit.

    perform public.api_act_as(v_user);
    if not public.is_org_member(v_org, 'admin') then
      return public.api_finish(ctx, public.api_err(403, 'workspace_access_lost',
        'The person who connected this app no longer has access to its workspace. Reconnect the app.'));
    end if;

    if v_scope <> 'any' and not (v_scope = any (array(select jsonb_array_elements_text(st -> 'scopes')))) then
      return public.api_finish(ctx, public.api_err(403, 'insufficient_scope',
        format('This connection was not given the %s permission.', v_scope),
        jsonb_build_object('required_scope', v_scope)));
    end if;

    update public.oauth_grants set last_used_at = now()
     where id = v_grant and (last_used_at is null or last_used_at < now() - interval '1 minute');
  exception when others then
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
  return ctx;
end
$$;

create or replace function public.oauth_check(p_token_hash text, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  st jsonb := public.oauth_token_state(p_token_hash);
begin
  if st is null then
    return public.api_err(401, 'invalid_token', 'The access token is missing, expired, revoked or unknown. Reconnect the app.');
  end if;
  if public.oauth_rate_take((st ->> 'grant_id')::uuid) > (public.oauth_limits() ->> 'rpm')::integer then
    return public.api_err(429, 'rate_limit_exceeded', 'This connection is sending too many requests.',
                          jsonb_build_object('retry_after', 30));
  end if;
  -- 0147: only a check that was counted and let through leaves a credit, so a refused or invalid check
  -- gives nothing away. `entitled` is always true now (every plan may connect); kept for the answer's shape.
  perform public.oauth_check_credit_put((st ->> 'grant_id')::uuid, p_request_id);
  return public.api_ok(jsonb_build_object('resource', st -> 'resource', 'scopes', st -> 'scopes',
    'entitled', true));
end
$$;

create or replace function public.oauth_begin_authorization(
  p_client_id uuid, p_redirect_uri text, p_code_challenge text, p_method text, p_state text,
  p_scope text, p_resource text, p_secret_hash text
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user   uuid := auth.uid();
  c        public.oauth_clients;
  v_org    uuid;
  v_scopes text[];
  lim      jsonb := public.oauth_limits();
  v_plan   text;
  v_name   text;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into c from public.oauth_clients where client_id = p_client_id;
  if c.client_id is null then
    return jsonb_build_object('ok', false, 'error', 'unknown_client');
  end if;
  -- Exact string match against what the client registered; until it matches,
  -- nothing is ever sent to the URI.
  if p_redirect_uri is null or not (p_redirect_uri = any (c.redirect_uris)) then
    return jsonb_build_object('ok', false, 'error', 'redirect_mismatch');
  end if;
  if coalesce(p_method, '') <> 'S256' then
    return jsonb_build_object('ok', false, 'redirect_ok', true, 'error', 'invalid_request',
      'description', 'PKCE with code_challenge_method=S256 is required.');
  end if;
  if coalesce(p_code_challenge, '') !~ '^[A-Za-z0-9_-]{43}$' then
    return jsonb_build_object('ok', false, 'redirect_ok', true, 'error', 'invalid_request',
      'description', 'code_challenge must be the base64url SHA-256 of the verifier.');
  end if;
  if p_state is not null and (char_length(p_state) > 512 or p_state ~ '[[:cntrl:]]') then
    return jsonb_build_object('ok', false, 'redirect_ok', true, 'error', 'invalid_request', 'description', 'state is too long.');
  end if;
  if coalesce(p_resource, '') !~ '^https?://[^[:space:]#]{1,255}$' then
    return jsonb_build_object('ok', false, 'redirect_ok', true, 'error', 'invalid_target', 'description', 'resource must be the MCP server URL.');
  end if;
  if coalesce(p_secret_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'server_error');
  end if;

  -- Unknown scope words are ignored (RFC 6749 3.3: the server may grant less);
  -- nothing asked for means everything the server offers.
  v_scopes := array(select s from unnest(public.oauth_scopes_supported()) s
                     where p_scope is not null and s = any (string_to_array(btrim(p_scope), ' ')));
  if cardinality(v_scopes) = 0 then
    v_scopes := public.oauth_scopes_supported();
  end if;

  v_org := public.oauth_workspace(v_user);
  if v_org is null then
    return jsonb_build_object('ok', false, 'redirect_ok', true, 'error', 'no_workspace');
  end if;
  select o.name into v_name from public.organizations o where o.id = v_org;
  v_plan := public.org_plan_internal(v_org);

  -- 0147: every plan may approve, Free included. `entitled` below stays true for the consent page's shape.

  delete from public.oauth_auth_requests where expires_at < now();
  delete from public.oauth_auth_requests where id in (
    select id from public.oauth_auth_requests where user_id = v_user order by created_at desc
     offset (lim ->> 'max_pending_requests')::int - 1);
  insert into public.oauth_auth_requests
    (secret_hash, user_id, org_id, client_id, redirect_uri, code_challenge, state, scopes, resource)
  values (p_secret_hash, v_user, v_org, c.client_id, p_redirect_uri, p_code_challenge, p_state, v_scopes, p_resource);

  return jsonb_build_object('ok', true, 'entitled', true, 'client_name', c.client_name,
    'redirect_uri', p_redirect_uri, 'workspace_name', v_name, 'plan', v_plan, 'scopes', to_jsonb(v_scopes),
    'default_limit_credits', (lim ->> 'default_limit_credits')::numeric,
    'max_limit_credits', (lim ->> 'max_limit_credits')::numeric,
    'exempt', public.credits_exempt(v_org));
end
$$;

create or replace function public.oauth_decide_authorization(p_secret_hash text, p_allow boolean, p_limit numeric, p_code_hash text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user  uuid := auth.uid();
  r       public.oauth_auth_requests;
  lim     jsonb := public.oauth_limits();
  g       uuid;
  v_limit numeric := p_limit;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if coalesce(p_secret_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  -- Single use: the row is taken (and deleted) by the person it was made for.
  delete from public.oauth_auth_requests
   where secret_hash = p_secret_hash and user_id = v_user
  returning * into r;
  if r.id is null or r.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  if not coalesce(p_allow, false) then
    return jsonb_build_object('ok', true, 'allowed', false, 'redirect_uri', r.redirect_uri, 'state', r.state,
                              'client_id', r.client_id);
  end if;

  if v_limit is null or v_limit < 0 or v_limit > (lim ->> 'max_limit_credits')::numeric or v_limit <> trunc(v_limit) then
    return jsonb_build_object('ok', false, 'error', 'invalid_limit', 'max_limit_credits', (lim ->> 'max_limit_credits')::numeric);
  end if;
  if coalesce(p_code_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'server_error');
  end if;
  -- 0147: no plan check: every plan may connect an app (credits and the connection's own limit bound it).
  perform public.api_act_as(v_user);
  if not public.is_org_member(r.org_id, 'admin') then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  -- 0147: one approval at a time per workspace, so two concurrent approvals cannot both pass the counts below.
  perform pg_advisory_xact_lock(hashtextextended('oauth_decide:' || r.org_id::text, 0));
  if (select count(*) from public.oauth_grants where user_id = v_user and revoked_at is null
         and absolute_expires_at > now()) >= (lim ->> 'max_grants_per_user')::int then
    return jsonb_build_object('ok', false, 'error', 'too_many_connections');
  end if;
  -- 0147: the live cap above does not count a revoked connection, and a revoked one kept its registration alive, so with
  -- Free able to approve, approve-redeem-revoke made rows for nothing. Connections approved in the last 24 hours, revoked
  -- ones included, are capped per person and per workspace (the collector frees an ended one's rows a day later).
  if (select count(*) from public.oauth_grants where user_id = v_user and created_at > now() - interval '24 hours')
       >= (lim ->> 'max_new_grants_per_user_day')::int
     or (select count(*) from public.oauth_grants where org_id = r.org_id and created_at > now() - interval '24 hours')
       >= (lim ->> 'max_new_grants_per_org_day')::int then
    return jsonb_build_object('ok', false, 'error', 'too_many_connections_today');
  end if;

  insert into public.oauth_grants (user_id, org_id, client_id, scopes, resource, monthly_limit_credits)
  values (v_user, r.org_id, r.client_id, r.scopes, r.resource, v_limit)
  returning id into g;
  insert into public.oauth_codes (code_hash, grant_id, client_id, redirect_uri, code_challenge, resource)
  values (p_code_hash, g, r.client_id, r.redirect_uri, r.code_challenge, r.resource);
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
  values (v_user, nullif(auth.jwt() ->> 'email', ''), 'mcp.connect', g::text,
          jsonb_build_object('org_id', r.org_id, 'client_id', r.client_id, 'scopes', to_jsonb(r.scopes), 'limit_credits', v_limit));
  return jsonb_build_object('ok', true, 'allowed', true, 'redirect_uri', r.redirect_uri, 'state', r.state,
                            'client_id', r.client_id);
end
$$;

create or replace function public.oauth_exchange_code(
  p_code_hash text, p_client_id uuid, p_redirect_uri text, p_verifier text, p_resource text,
  p_access_hash text, p_refresh_hash text
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  lim  jsonb := public.oauth_limits();
  cd   public.oauth_codes;
  g    public.oauth_grants;
  bad  jsonb := jsonb_build_object('ok', false, 'error', 'invalid_grant');
  -- RFC 7636 4.2: base64url (no padding) of SHA-256(verifier). A SHA-256 is 44
  -- base64 characters, so no line break is ever inserted.
  v_challenge text;
begin
  if coalesce(p_code_hash, '') !~ '^[0-9a-f]{64}$' or coalesce(p_access_hash, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_refresh_hash, '') !~ '^[0-9a-f]{64}$' or p_access_hash = p_refresh_hash
     or coalesce(p_verifier, '') !~ '^[A-Za-z0-9._~-]{43,128}$' then
    return bad;
  end if;
  v_challenge := translate(rtrim(encode(sha256(convert_to(p_verifier, 'UTF8')), 'base64'), '='), '+/', '-_');
  select * into cd from public.oauth_codes where code_hash = p_code_hash for update;
  if cd.code_hash is null then
    return bad;
  end if;
  select * into g from public.oauth_grants where id = cd.grant_id for update;
  -- A code redeemed twice means it leaked: whatever it already produced dies.
  if cd.used_at is not null then
    perform public.oauth_revoke_grant_locked(cd.grant_id, 'code_reuse');
    return bad;
  end if;
  if cd.expires_at < now() or g.id is null or g.revoked_at is not null then
    return bad;
  end if;
  -- Bound to client + redirect_uri + resource + the PKCE challenge. Digests are
  -- compared, so the comparison time says nothing about the secret. A wrong
  -- verifier or redirect burns the code (the one holding it is not the client).
  if cd.client_id is distinct from p_client_id
     or cd.redirect_uri is distinct from p_redirect_uri
     or sha256(convert_to(v_challenge, 'UTF8')) <> sha256(convert_to(cd.code_challenge, 'UTF8')) then
    update public.oauth_codes set used_at = now() where code_hash = p_code_hash;
    perform public.oauth_revoke_grant_locked(cd.grant_id, 'client');
    return bad;
  end if;
  if p_resource is not null and p_resource is distinct from cd.resource then
    return jsonb_build_object('ok', false, 'error', 'invalid_target');
  end if;
  -- 0147: no plan check: every plan may connect an app (credits and the connection's own limit bound it).

  update public.oauth_codes set used_at = now() where code_hash = p_code_hash;
  update public.oauth_grants set activated_at = now() where id = g.id;
  update public.oauth_clients set last_authorized_at = now() where client_id = g.client_id;
  insert into public.oauth_tokens (token_hash, grant_id, kind, expires_at) values
    (p_access_hash, g.id, 'access', now() + make_interval(secs => (lim ->> 'access_ttl_seconds')::int)),
    (p_refresh_hash, g.id, 'refresh',
     least(now() + make_interval(days => (lim ->> 'refresh_ttl_days')::int), g.absolute_expires_at));
  return jsonb_build_object('ok', true, 'scope', array_to_string(g.scopes, ' '),
                            'expires_in', (lim ->> 'access_ttl_seconds')::int, 'resource', g.resource);
end
$$;

create or replace function public.oauth_refresh(
  p_refresh_hash text, p_client_id uuid, p_resource text, p_new_access_hash text, p_new_refresh_hash text
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  lim  jsonb := public.oauth_limits();
  t    public.oauth_tokens;
  g    public.oauth_grants;
  bad  jsonb := jsonb_build_object('ok', false, 'error', 'invalid_grant');
begin
  if coalesce(p_refresh_hash, '') !~ '^[0-9a-f]{64}$' or coalesce(p_new_access_hash, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_new_refresh_hash, '') !~ '^[0-9a-f]{64}$' or p_new_access_hash = p_new_refresh_hash then
    return bad;
  end if;
  select * into t from public.oauth_tokens where token_hash = p_refresh_hash and kind = 'refresh' for update;
  if t.token_hash is null then
    return bad;
  end if;
  select * into g from public.oauth_grants where id = t.grant_id for update;
  if g.id is null or g.client_id is distinct from p_client_id then
    return bad;
  end if;
  -- Rotation with reuse detection: a refresh token is good once. Seeing a spent
  -- one means two parties hold it, so the whole grant (every token) is revoked.
  if t.used_at is not null then
    perform public.oauth_revoke_grant_locked(g.id, 'reuse');
    return bad;
  end if;
  if t.revoked_at is not null or g.revoked_at is not null or t.expires_at < now() or g.absolute_expires_at < now()
     or g.activated_at is null then
    return bad;
  end if;
  if p_resource is not null and p_resource is distinct from g.resource then
    return jsonb_build_object('ok', false, 'error', 'invalid_target');
  end if;
  -- 0147: no plan check: every plan may connect an app (credits and the connection's own limit bound it).

  update public.oauth_tokens set used_at = now() where token_hash = p_refresh_hash;
  update public.oauth_tokens set revoked_at = now() where grant_id = g.id and kind = 'access' and revoked_at is null;
  insert into public.oauth_tokens (token_hash, grant_id, kind, expires_at) values
    (p_new_access_hash, g.id, 'access', now() + make_interval(secs => (lim ->> 'access_ttl_seconds')::int)),
    (p_new_refresh_hash, g.id, 'refresh',
     least(now() + make_interval(days => (lim ->> 'refresh_ttl_days')::int), g.absolute_expires_at));
  if random() < 0.05 then
    perform public.oauth_gc();
  end if;
  return jsonb_build_object('ok', true, 'scope', array_to_string(g.scopes, ' '),
                            'expires_in', (lim ->> 'access_ttl_seconds')::int, 'resource', g.resource);
end
$$;

create or replace function public.oauth_my_grants() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  -- 0147: the plan never pauses a connection any more; `status` stays for the list's shape.
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', g.id, 'client_name', c.client_name, 'redirect_uris', to_jsonb(c.redirect_uris),
             'scopes', to_jsonb(g.scopes), 'created_at', g.created_at, 'last_used_at', g.last_used_at,
             'monthly_limit_credits', g.monthly_limit_credits,
             'spent_this_month_credits', public.oauth_grant_month_credits(g.id),
             'status', 'active')
           order by g.created_at desc)
      from public.oauth_grants g join public.oauth_clients c on c.client_id = g.client_id
     where g.user_id = v_user and g.activated_at is not null and g.revoked_at is null
       and g.absolute_expires_at > now()), '[]'::jsonb);
end
$$;

create or replace function public.oauth_limits() returns jsonb
  language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'default_limit_credits', 500, 'max_limit_credits', 20000,
    'rpm', 120, 'access_ttl_seconds', 3600, 'refresh_ttl_days', 30, 'absolute_days', 90, 'code_ttl_seconds', 60,
    'max_grants_per_user', 20, 'max_pending_requests', 5,
    'register_per_ip_hour', 10, 'register_global_hour', 300, 'max_clients', 20000,
    -- 0147: a registration whose every redirect URI is an AI vendor's own callback (oauth_vendor_callbacks_only) is its
    -- own class: the vendor's shared servers register for every person (Claude on each fresh connection), so 10 an
    -- address throttled the 11th person an hour. Hourly ceiling x the collector's 24 hours stays under the class's row cap.
    'register_vendor_per_ip_hour', 300, 'register_vendor_global_hour', 2000, 'max_vendor_clients', 60000,
    -- 0147: connections approved per person and per workspace in a rolling day, revoked ones included. With Free able to
    -- approve, approve-and-revoke must not be a free way to make rows (oauth_decide_authorization, oauth_gc).
    'max_new_grants_per_user_day', 50, 'max_new_grants_per_org_day', 200)
$$;

create or replace function public.oauth_register_client(p_name text, p_redirect_uris text[], p_ip text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  lim     jsonb := public.oauth_limits();
  v_name  text := public.oauth_visible_name(p_name);
  v_uris  text[];
  u       text;
  v_ip    text;
  v_id    uuid;
  v_vendor boolean;
begin
  -- A name that shows nothing, is over 80 characters or passes itself off as
  -- Nightshift is refused (RFC 7591 invalid_client_metadata).
  if public.oauth_client_name_problem(p_name) is not null then
    return jsonb_build_object('ok', false, 'error', 'invalid_client_metadata',
      'description', 'client_name: 1 to 80 visible characters, and not a name that contains "Nightshift".');
  end if;
  if p_redirect_uris is null or cardinality(p_redirect_uris) not between 1 and 5 then
    return jsonb_build_object('ok', false, 'error', 'invalid_redirect_uri', 'description', 'Register 1 to 5 redirect URIs.');
  end if;
  foreach u in array p_redirect_uris loop
    if not public.oauth_redirect_uri_ok(u) then
      return jsonb_build_object('ok', false, 'error', 'invalid_redirect_uri',
        'description', 'Redirect URIs must be https, or http on localhost / 127.0.0.1 / [::1], with no fragment, userinfo or wildcard.');
    end if;
  end loop;
  v_uris := array(select distinct x from unnest(p_redirect_uris) x order by 1);
  -- 0147: the class this registration is counted in (the same test as oauth_clients.vendor, which is generated from it).
  v_vendor := public.oauth_vendor_callbacks_only(v_uris);

  v_ip := encode(sha256(convert_to(left(coalesce(p_ip, ''), 80) || ':' || (select pepper from public.oauth_settings), 'UTF8')), 'hex');

  perform pg_advisory_xact_lock(hashtextextended('oauth_register', 0));
  -- The two hourly counts are index probes; a refused call stops here. The
  -- collector (scans of the token and grant tables) runs only for a call that
  -- is about to be accepted, so a flood of refused calls cannot make the
  -- database scan those tables once per call (Lens-386A).
  -- 0147: each class has its own per-address and hourly budgets, so a flood of one cannot spend the other's.
  if (select count(*) from public.oauth_clients where ip_hash = v_ip and vendor = v_vendor and created_at > now() - interval '1 hour')
       >= (lim ->> case when v_vendor then 'register_vendor_per_ip_hour' else 'register_per_ip_hour' end)::int
     or (select count(*) from public.oauth_clients where vendor = v_vendor and created_at > now() - interval '1 hour')
       >= (lim ->> case when v_vendor then 'register_vendor_global_hour' else 'register_global_hour' end)::int then
    return jsonb_build_object('ok', false, 'error', 'rate_limited', 'description', 'Too many registrations; try again later.');
  end if;
  perform public.oauth_gc();
  if (select count(*) from public.oauth_clients where vendor = v_vendor)
       >= (lim ->> case when v_vendor then 'max_vendor_clients' else 'max_clients' end)::int then
    return jsonb_build_object('ok', false, 'error', 'rate_limited', 'description', 'Registration is closed for now; try again later.');
  end if;

  insert into public.oauth_clients (client_name, redirect_uris, ip_hash)
  values (v_name, v_uris, v_ip) returning client_id into v_id;
  return jsonb_build_object('ok', true, 'client_id', v_id, 'client_name', v_name, 'redirect_uris', to_jsonb(v_uris));
end
$$;

-- 0093's collector, plus: a client whose every grant ended more than a day ago goes too (header, section 5).
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

-- ───────────────────────────────────────────────────────────────────────────
-- 3. 0042's two spending API functions: the spend-limit refusals name the remedy
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.api_create_video(
  p_key_hash text, p_channel_id text, p_params jsonb,
  p_idem_key text default null, p_fingerprint text default null, p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx     jsonb := public.api_begin(p_key_hash, 'videos.create', p_request_id);
  v_org   uuid;
  ch      public.channels;
  v_p     jsonb := coalesce(p_params, '{}'::jsonb);
  v_busy  integer;
  v_secs  numeric;
  v_price bigint;
  v_spend bigint;
  acc     public.api_accounts;
  v_ref   text;
  v_job   bigint;
  v_res   jsonb;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    v_res := public.api_idem_begin(ctx, p_idem_key, p_fingerprint);
    if v_res is not null then
      return public.api_finish(ctx, v_res);
    end if;
    v_org := (ctx ->> 'org_id')::uuid;

    select * into ch from public.channels c where c.channel_id = p_channel_id;
    if ch.channel_id is null or ch.org_id is distinct from v_org then
      v_res := public.api_err(404, 'channel_not_found', 'No channel with that id in this key''s organization.');
    elsif upper(btrim(coalesce(ch.status, ''))) <> 'ACTIVE' then
      v_res := public.api_err(409, 'channel_not_active',
        'That channel is not active. Connect it to YouTube and activate it in the Command Center first.');
    elsif jsonb_typeof(v_p) <> 'object'
       or (v_p - array['topic','niche','duration','language','visual_style',
                       'video_provider','image_provider']) <> '{}'::jsonb
       or not public.render_job_params_valid(v_p, 'daily') then
      v_res := public.api_err(400, 'invalid_params',
        'Allowed: topic (<=300 chars), niche (<=120), duration (whole seconds, 30-3600), language (<=40), visual_style (<=300), video_provider, image_provider.');
    end if;
    if v_res is not null then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
    end if;

    -- Concurrency, under a per-organization lock so two creates cannot both
    -- take the last slot.
    perform pg_advisory_xact_lock(hashtextextended('api_render_jobs:' || v_org::text, 0));
    select count(*) into v_busy
      from public.render_jobs j join public.channels c on c.channel_id = j.channel_id
     where c.org_id = v_org and j.status in ('queued', 'running');
    if v_busy >= (ctx ->> 'concurrency')::int then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(429, 'concurrency_limit_exceeded',
        format('Usage tier %s runs at most %s videos at once. Wait for one to finish.', ctx ->> 'tier', ctx ->> 'concurrency'),
        jsonb_build_object('retry_after', 60))));
    end if;

    if not (ctx ->> 'exempt')::boolean then
      v_secs := coalesce((v_p ->> 'duration')::numeric,
                         case when jsonb_typeof(ch.agent_config -> 'target_duration_seconds') = 'number'
                              then (ch.agent_config ->> 'target_duration_seconds')::numeric end);
      if v_secs is null or v_secs <= 0 then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(400, 'duration_required',
          'Pass duration (seconds): this channel has no target length to price the video by.')));
      end if;
      -- 0041 freezes the length a paid run renders at, whole seconds 30..3600
      -- (render_jobs_payment_guard). Freeze it here, in the same way, BEFORE
      -- pricing, so the hold is for the length that runs: a 10-second target
      -- renders 30 seconds and is priced as 30, and a target read again
      -- inside the insert cannot differ from the one priced.
      v_secs := least(greatest(round(v_secs), 30), 3600);
      v_p := v_p || jsonb_build_object('duration', v_secs::integer);
      v_price := public.api_video_price(v_secs);
      if v_price is null then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(503, 'pricing_unavailable',
          'The API price list is not set up on this deployment; nothing was charged.')));
      end if;

      acc := public.api_account_lock(v_org);
      perform public.api_expire_holds_locked(v_org);
      select * into acc from public.api_accounts where org_id = v_org;
      v_spend := public.api_month_spend(v_org);
      if v_spend + v_price > (ctx ->> 'cap_cents')::bigint then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(402, 'monthly_limit_reached',
          'This video would take the organization past its monthly API spend limit. An owner or admin can raise it in the Developer console: Developers → Usage and billing → Monthly spend limit (up to the usage tier''s cap; paying more into the API balance raises the tier).',
          jsonb_build_object('limit_cents', (ctx ->> 'cap_cents')::bigint, 'month_spend_cents', v_spend,
                             'price_cents', v_price))));
      end if;
      if ctx ->> 'key_limit_cents' is not null
         and public.api_month_spend(v_org, (ctx ->> 'key_id')::uuid) + v_price > (ctx ->> 'key_limit_cents')::bigint then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(402, 'key_limit_reached',
          'This video would take this key past its own monthly spend limit. An owner or admin can raise or remove it in the Developer console: Developers → API keys → Set limit on this key.',
          jsonb_build_object('limit_cents', (ctx ->> 'key_limit_cents')::bigint, 'price_cents', v_price))));
      end if;
      if acc.balance_cents - acc.reserved_cents < v_price then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(402, 'insufficient_balance',
          'Your API balance does not cover this video. Top up in the Developer console.',
          jsonb_build_object('price_cents', v_price, 'available_cents', acc.balance_cents - acc.reserved_cents))));
      end if;

      v_ref := 'ah-' || gen_random_uuid()::text;
      insert into public.api_holds (ref, org_id, key_id, amount_cents)
      values (v_ref, v_org, (ctx ->> 'key_id')::uuid, v_price);
      update public.api_accounts set reserved_cents = reserved_cents + v_price, updated_at = now()
       where org_id = v_org;
      perform public.api_log(v_org, 'hold', v_price, v_ref, (ctx ->> 'key_id')::uuid, null, null, null,
                             format('%s seconds on %s', v_secs, ch.channel_id));
    end if;

    -- 0019's insert policy, stated as the row itself: a daily job, queued, no
    -- privacy/resume/repair, filed as the key's creator.
    insert into public.render_jobs (channel_id, kind, params, requested_by, api_hold_ref)
    values (ch.channel_id, 'daily', v_p, (ctx ->> 'created_by')::uuid, v_ref)
    returning id into v_job;
    if v_ref is not null then
      update public.api_holds set render_job_id = v_job where ref = v_ref;
    end if;

    perform public.api_audit(ctx, 'agent.run', ch.channel_id, ch.channel_id,
      v_p || jsonb_build_object('backend', 'queue', 'job_id', v_job, 'api_hold_ref', v_ref, 'price_cents', v_price));

    v_res := public.api_ok(jsonb_build_object('job_id', v_job, 'channel_id', ch.channel_id, 'status', 'queued',
                                              'price_cents', v_price), 201);
    return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res), coalesce(v_price, 0));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

create or replace function public.api_request_download(
  p_key_hash text, p_video_id text, p_quality text,
  p_idem_key text default null, p_fingerprint text default null, p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx     jsonb := public.api_begin(p_key_hash, 'downloads.create', p_request_id);
  v_org   uuid;
  v_ch    text;
  q       text := btrim(coalesce(p_quality, ''));
  m       public.download_masters;
  r       public.download_requests;
  why     text;
  until_  timestamptz;
  credits numeric;
  v_price bigint;
  v_spend bigint;
  acc     public.api_accounts;
  v_ref   text;
  v_res   jsonb;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    v_res := public.api_idem_begin(ctx, p_idem_key, p_fingerprint);
    if v_res is not null then
      return public.api_finish(ctx, v_res);
    end if;
    v_org := (ctx ->> 'org_id')::uuid;
    select c.channel_id into v_ch from public.videos v join public.channels c on c.channel_id = v.channel_id
     where v.video_id = p_video_id and c.org_id = v_org;
    if q not in ('720p', '1080p') then
      v_res := public.api_err(400, 'invalid_params', 'quality must be 720p or 1080p.');
    elsif v_ch is null then
      v_res := public.api_err(404, 'video_not_found', 'No video with that id in this key''s organization.');
    end if;
    if v_res is not null then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
    end if;

    -- 0030's lock: the site and the API decide one (org, video, quality) at a time.
    perform pg_advisory_xact_lock(hashtextextended(format('download:%s:%s:%s', v_org, p_video_id, q), 0));
    select * into r from public.download_requests d
     where d.org_id = v_org and d.video_id = p_video_id and d.quality = q
       and (d.status in ('queued', 'processing') or (d.status = 'ready' and d.expires_at > now()))
     order by d.id desc limit 1;
    if r.id is not null then
      v_res := public.api_ok(jsonb_build_object('id', r.id, 'status', r.status, 'quality', r.quality,
                                                'price_cents', 0, 'reused', true, 'expires_at', r.expires_at));
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
    end if;

    select * into m from public.download_masters where video_id = p_video_id;
    if m.video_id is null or least(m.width, m.height) < public.download_quality_side(q) then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(404, 'no_master',
        format('No full-quality master for this video at %s. Only videos rendered on the queue worker keep one.', q))));
    end if;

    if exists (select 1 from public.download_requests d
                where d.org_id = v_org and d.video_id = p_video_id and d.quality = q
                  and d.paid_until > now() and d.status <> 'failed') then
      why := 'redownload';
      until_ := (select max(d.paid_until) from public.download_requests d
                  where d.org_id = v_org and d.video_id = p_video_id and d.quality = q and d.status <> 'failed');
    elsif (ctx ->> 'exempt')::boolean then
      why := 'exempt';
      until_ := now() + interval '7 days';
    else
      credits := public.download_credits_price(m.duration_seconds, q);
      select ceil(credits * p.cents)::bigint into v_price from public.api_prices p where p.unit = 'download_cents_per_credit';
      if v_price is null then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(503, 'pricing_unavailable',
          format('Downloads in %s are not priced on this deployment; nothing was charged.', q))));
      end if;
      until_ := now() + interval '7 days';
    end if;

    if v_price is not null and v_price > 0 then
      acc := public.api_account_lock(v_org);
      perform public.api_expire_holds_locked(v_org);
      select * into acc from public.api_accounts where org_id = v_org;
      v_spend := public.api_month_spend(v_org);
      if v_spend + v_price > (ctx ->> 'cap_cents')::bigint then
        v_res := public.api_err(402, 'monthly_limit_reached',
          'This download would take the organization past its monthly API spend limit. An owner or admin can raise it in the Developer console: Developers → Usage and billing → Monthly spend limit (up to the usage tier''s cap; paying more into the API balance raises the tier).',
          jsonb_build_object('limit_cents', (ctx ->> 'cap_cents')::bigint, 'month_spend_cents', v_spend, 'price_cents', v_price));
      elsif ctx ->> 'key_limit_cents' is not null
            and public.api_month_spend(v_org, (ctx ->> 'key_id')::uuid) + v_price > (ctx ->> 'key_limit_cents')::bigint then
        v_res := public.api_err(402, 'key_limit_reached', 'This download would take this key past its own monthly spend limit. An owner or admin can raise or remove it in the Developer console: Developers → API keys → Set limit on this key.',
          jsonb_build_object('limit_cents', (ctx ->> 'key_limit_cents')::bigint, 'price_cents', v_price));
      elsif acc.balance_cents - acc.reserved_cents < v_price then
        v_res := public.api_err(402, 'insufficient_balance',
          'Your API balance does not cover this download. Top up in the Developer console.',
          jsonb_build_object('price_cents', v_price, 'available_cents', acc.balance_cents - acc.reserved_cents));
      end if;
      if v_res is not null then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
      end if;
    end if;

    -- 0030's row, as the site writes it, filed as the key's creator; credits
    -- charged 0 (the API balance pays, below).
    insert into public.download_requests
      (org_id, channel_id, video_id, quality, status, charged, free_reason, paid_until, minutes, requested_by)
    values
      (v_org, v_ch, p_video_id, q, 'queued', 0, why, until_, round(m.duration_seconds / 60.0, 4),
       (ctx ->> 'created_by')::uuid)
    returning * into r;

    if v_price is not null and v_price > 0 then
      v_ref := 'ah-' || gen_random_uuid()::text;
      insert into public.api_holds (ref, org_id, key_id, download_request_id, amount_cents)
      values (v_ref, v_org, (ctx ->> 'key_id')::uuid, r.id, v_price);
      update public.api_accounts set reserved_cents = reserved_cents + v_price, updated_at = now()
       where org_id = v_org;
      perform public.api_log(v_org, 'hold', v_price, v_ref, (ctx ->> 'key_id')::uuid, null, null, null,
                             format('download %s of %s', q, p_video_id));
    end if;
    perform public.api_audit(ctx, 'video.download', p_video_id, v_ch,
      jsonb_build_object('download_id', r.id, 'quality', q, 'price_cents', v_price, 'free_reason', why));

    v_res := public.api_ok(jsonb_build_object('id', r.id, 'status', r.status, 'quality', q,
                                              'price_cents', coalesce(v_price, 0), 'free_reason', why,
                                              'reused', false), 201);
    return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res), coalesce(v_price, 0));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The `mcp` entitlement: checked nowhere any more, true for every plan
-- ───────────────────────────────────────────────────────────────────────────
-- `planned` is 0034's word for "stored, checked nowhere, never advertised": the pricing matrix (lib/plans.ts) and the Usage
-- page (0094 usage_summary) list enforced keys only, so neither says "Free: no" any more. The values are set true so the
-- catalog never contradicts the rule, overwriting 0093's Free row on purpose (that row is what this migration retires).

update public.entitlement_keys
   set status = 'planned', default_value = 'true'::jsonb,
       note = '0147: checked nowhere. Connecting an AI app with OAuth is open to every plan and limited by site credits (reserve_credits) and each connection''s monthly limit. 0093 checked it per plan.'
 where key = 'mcp';
-- Each plan's value as it was, kept for the rollback: an admin may have set a paid plan false, and the rollback must put that
-- back rather than guess. On a replay nothing already saved is overwritten (`do nothing`), so the record is always the value
-- before 0147 first touched it. RLS on and no API role, like every table of 0093.
create table if not exists public.oauth_mcp_entitlement_before_0147 (
  plan_id  text primary key,
  value    jsonb not null,
  saved_at timestamptz not null default now()
);
alter table public.oauth_mcp_entitlement_before_0147 enable row level security;
revoke all on table public.oauth_mcp_entitlement_before_0147 from public, anon, authenticated, service_role;
comment on table public.oauth_mcp_entitlement_before_0147 is
  '0147: each plan''s `mcp` entitlement value before 0147 set it true; read only by docs/sql/rollback_0147_mcp_free_tier.sql, which restores and drops it.';
insert into public.oauth_mcp_entitlement_before_0147 (plan_id, value)
select plan_id, value from public.plan_entitlements where key = 'mcp'
on conflict (plan_id) do nothing;
update public.plan_entitlements set value = 'true'::jsonb where key = 'mcp' and value is distinct from 'true'::jsonb;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Grants: create or replace keeps them; restated so a partial earlier run cannot leave one wider
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.oauth_check_credit_put(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_check_credit_take(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_ctx(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_limits() from public, anon, authenticated, service_role;
revoke all on function public.oauth_vendor_callbacks_only(text[]) from public, anon, authenticated, service_role;
revoke all on function public.oauth_gc() from public, anon, authenticated, service_role;

revoke all on function public.oauth_check(text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_register_client(text, text[], text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_exchange_code(text, uuid, text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_refresh(text, uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_create_video(text, text, jsonb, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_request_download(text, text, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.oauth_check(text, text) to anon;
grant execute on function public.oauth_register_client(text, text[], text) to anon;
grant execute on function public.oauth_exchange_code(text, uuid, text, text, text, text, text) to anon;
grant execute on function public.oauth_refresh(text, uuid, text, text, text) to anon;
grant execute on function public.api_create_video(text, text, jsonb, text, text, text) to anon;
grant execute on function public.api_request_download(text, text, text, text, text, text) to anon;

revoke all on function public.oauth_begin_authorization(uuid, text, text, text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_decide_authorization(text, boolean, numeric, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_my_grants() from public, anon, authenticated, service_role;
grant execute on function public.oauth_begin_authorization(uuid, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.oauth_decide_authorization(text, boolean, numeric, text) to authenticated;
grant execute on function public.oauth_my_grants() to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. End state
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  pair text[];
  g    uuid := gen_random_uuid();
  rid  text := 'req_' || substr(md5(g::text), 1, 24);
begin
  foreach pair slice 1 in array array[
      ['public.oauth_ctx(text, text, text)', 'fe42c9e4f53a6c9aaba40077ce905cdc', ''],
      ['public.oauth_check_credit_put(uuid, text)', 'b50cfb0cfaa7d8a57512f3381d6b72e3', ''],
      ['public.oauth_check_credit_take(uuid, text)', '7092b99bdaef02719f247dcd26d77c08', ''],
      ['public.oauth_gc()', 'db1e58fa3381bced067a36b44b476ebf', ''],
      ['public.oauth_check(text, text)', '7b53e3c9b4b6c6c74daa9eff3fe028bc', 'anon'],
      ['public.oauth_register_client(text, text[], text)', '51d0b4f6ee421aa0fd276b09c108da2f', 'anon'],
      ['public.oauth_exchange_code(text, uuid, text, text, text, text, text)', '1d682787edc3c06691d537cd65039842', 'anon'],
      ['public.oauth_refresh(text, uuid, text, text, text)', '3d8ff8c8084563f79ab7d09cfd87a2a6', 'anon'],
      ['public.api_create_video(text, text, jsonb, text, text, text)', 'cba47be1a674f5cea3b5d7443bc31bab', 'anon'],
      ['public.api_request_download(text, text, text, text, text, text)', '055003f8a2fb5390bbd1b5f7820e6e2e', 'anon'],
      ['public.oauth_begin_authorization(uuid, text, text, text, text, text, text, text)', '1d77b561efdb9347dc9465e66fa87e8c', 'authenticated'],
      ['public.oauth_decide_authorization(text, boolean, numeric, text)', '3b5236152d66117425e44e2d5132b9eb', 'authenticated'],
      ['public.oauth_my_grants()', '595922d17683b2e0620612f60c5d10c3', 'authenticated']] loop
    if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(pair[1])) is distinct from pair[2] then
      raise exception '0147 end state: % does not hold the body this file expects', pair[1];
    end if;
    if exists (select 1 from pg_proc p where p.oid = to_regprocedure(pair[1])
                and (not p.prosecdef or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                     or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
      raise exception '0147 end state: % is not a SECURITY DEFINER with a fixed search_path, or PUBLIC may call it', pair[1];
    end if;
    if has_function_privilege('anon', pair[1], 'EXECUTE') is distinct from (pair[3] = 'anon')
       or has_function_privilege('authenticated', pair[1], 'EXECUTE') is distinct from (pair[3] = 'authenticated')
       or has_function_privilege('service_role', pair[1], 'EXECUTE') then
      raise exception '0147 end state: % has the wrong grants (expected only %)', pair[1], coalesce(nullif(pair[3], ''), 'none');
    end if;
  end loop;
  -- The two plain helpers (not definers): this file's bodies, and no API role may call them.
  foreach pair slice 1 in array array[
      ['public.oauth_limits()', 'c2d715dcc24280d63b065ca0bf6db92d'],
      ['public.oauth_vendor_callbacks_only(text[])', 'e4c9b0824b91bc3c6ff3b10e91934a74']] loop
    if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(pair[1])) is distinct from pair[2]
       or has_function_privilege('anon', pair[1], 'EXECUTE') or has_function_privilege('authenticated', pair[1], 'EXECUTE')
       or has_function_privilege('service_role', pair[1], 'EXECUTE') then
      raise exception '0147 end state: % does not hold this file''s body, or an API role may call it', pair[1];
    end if;
  end loop;
  if (select attgenerated from pg_attribute where attrelid = 'public.oauth_clients'::regclass and attname = 'vendor') is distinct from 's'
     or not public.oauth_vendor_callbacks_only(array['https://claude.ai/api/mcp/auth_callback'])
     or not public.oauth_vendor_callbacks_only(array['https://chatgpt.com/connector_platform_oauth_redirect', 'https://chatgpt.com/connector/oauth/abc_D-1'])
     or public.oauth_vendor_callbacks_only(array['https://claude.ai/api/mcp/auth_callback', 'https://evil.example/cb'])
     or public.oauth_vendor_callbacks_only(array['https://claude.ai/api/mcp/auth_callback/'])
     or public.oauth_vendor_callbacks_only(array['https://chatgpt.com/connector/oauth/a/b'])
     or not public.oauth_vendor_callbacks_only(array['https://grok.com/connectors-oauth-exchange-code/'])
     or public.oauth_vendor_callbacks_only(array['https://grok.com/connectors-oauth-exchange-code'])
     or not public.oauth_vendor_callbacks_only(array['https://oauth-redirect.googleusercontent.com/r/my-project-1',
                                                     'https://oauth-redirect.googleusercontent.com/a/abc.Def_9'])
     or public.oauth_vendor_callbacks_only(array['https://oauth-redirect.googleusercontent.com/r/a/b'])
     or public.oauth_vendor_callbacks_only(array['https://oauth-redirect.googleusercontent.com/r/..'])
     or public.oauth_vendor_callbacks_only(array['https://oauth-redirect-sandbox.googleusercontent.com/r/my-project-1'])
     or public.oauth_vendor_callbacks_only(array[]::text[]) then
    raise exception '0147 end state: the vendor class of a registration is not what this file defines';
  end if;
  -- `if not exists` objects are skipped when a name is already there, so their SHAPE is asserted, not only their presence.
  if (select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d
        join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
       where d.adrelid = 'public.oauth_clients'::regclass and a.attname = 'vendor')
       is distinct from 'oauth_vendor_callbacks_only(redirect_uris)'
     or (select format_type(atttypid, atttypmod) from pg_attribute
          where attrelid = 'public.oauth_clients'::regclass and attname = 'vendor' and not attisdropped) is distinct from 'boolean' then
    raise exception '0147 end state: oauth_clients.vendor is not the boolean generated from oauth_vendor_callbacks_only(redirect_uris)';
  end if;
  if (select array_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull order by a.attnum)
        from pg_attribute a where a.attrelid = 'public.oauth_check_credits'::regclass and a.attnum > 0 and not a.attisdropped)
       is distinct from array['grant_id:uuid:true', 'request_id:text:true', 'created_at:timestamp with time zone:true']
     or not exists (select 1 from pg_constraint k where k.conrelid = 'public.oauth_check_credits'::regclass and k.contype = 'p'
                     and (select array_agg(a.attname order by x.ord) from unnest(k.conkey) with ordinality x(n, ord)
                            join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.n) = array['grant_id', 'request_id']::name[])
     or not exists (select 1 from pg_constraint k where k.conrelid = 'public.oauth_check_credits'::regclass and k.contype = 'f'
                     and k.confrelid = 'public.oauth_grants'::regclass and k.confdeltype = 'c'
                     and (select array_agg(a.attname) from unnest(k.conkey) x(n)
                            join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.n) = array['grant_id']::name[])
     or not exists (select 1 from pg_constraint k where k.conrelid = 'public.oauth_check_credits'::regclass and k.contype = 'c'
                     and position('^req_[A-Za-z0-9]{24}$' in pg_get_constraintdef(k.oid)) > 0) then
    raise exception '0147 end state: oauth_check_credits is not (grant_id uuid -> oauth_grants on delete cascade, request_id text checked to the req_ shape, created_at), keyed by (grant_id, request_id)';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.oauth_check_credits'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.oauth_mcp_entitlement_before_0147'::regclass)
     or exists (select 1 from information_schema.role_table_grants
                 where table_schema = 'public' and table_name in ('oauth_check_credits', 'oauth_mcp_entitlement_before_0147')
                   and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')) then
    raise exception '0147 end state: oauth_check_credits and oauth_mcp_entitlement_before_0147 must have RLS on and no API role privilege';
  end if;
  if to_regclass('public.oauth_grants_client_idx') is null or to_regclass('public.oauth_grants_org_created_idx') is null
     or (public.oauth_limits() ->> 'max_new_grants_per_user_day')::int <> 50
     or (public.oauth_limits() ->> 'max_new_grants_per_org_day')::int <> 200 then
    raise exception '0147 end state: the daily connection caps or the collector''s indexes are missing';
  end if;
  if (select status from public.entitlement_keys where key = 'mcp') is distinct from 'planned'
     or exists (select 1 from public.plan_entitlements where key = 'mcp' and value is distinct from 'true'::jsonb) then
    raise exception '0147 end state: the mcp entitlement is not retired (planned, true for every plan)';
  end if;
  -- The credit, exercised on a made-up grant in a block that is always rolled back (nothing is left behind): the first call
  -- of a checked request is free, a SECOND call with the same request id is counted, an id of another shape earns nothing,
  -- and a credit older than a minute is not taken.
  begin
    perform public.oauth_check_credit_put(g, rid);
    if not public.oauth_check_credit_take(g, rid) then
      raise exception '0147 end state: the first call of a checked request did not take its credit';
    end if;
    if public.oauth_check_credit_take(g, rid) then
      raise exception '0147 end state: a second call with the same request id was not counted';
    end if;
    perform public.oauth_check_credit_put(g, 'req_tooshort');
    perform public.oauth_check_credit_put(g, rid || 'x');
    if (select count(*) from public.oauth_check_credits where grant_id = g) <> 0 then
      raise exception '0147 end state: a request id of another shape earned a credit';
    end if;
    insert into public.oauth_check_credits (grant_id, request_id, created_at) values (g, rid, now() - interval '61 seconds');
    if public.oauth_check_credit_take(g, rid) then
      raise exception '0147 end state: a credit older than a minute was taken';
    end if;
    raise exception using errcode = 'NSP47', message = '0147 probe done';
  exception when sqlstate 'NSP47' then
    null;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying, in the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select status = 'planned' from public.entitlement_keys where key = 'mcp')
--     and not exists (select 1 from public.plan_entitlements where key = 'mcp' and value <> 'true'::jsonb) as every_plan_may_connect,
--   position('has_entitlement' in pg_get_functiondef('public.oauth_ctx(text,text,text)'::regprocedure)) = 0
--     and position('has_entitlement' in pg_get_functiondef('public.oauth_begin_authorization(uuid,text,text,text,text,text,text,text)'::regprocedure)) = 0
--     as no_plan_gate,
--   position('oauth_check_credit_take' in pg_get_functiondef('public.oauth_ctx(text,text,text)'::regprocedure)) > 0
--     and position('oauth_check_credit_put' in pg_get_functiondef('public.oauth_check(text,text)'::regprocedure)) > 0 as one_unit_per_call,
--   (select relrowsecurity from pg_class where oid = 'public.oauth_check_credits'::regclass)
--     and not has_table_privilege('anon', 'public.oauth_check_credits', 'SELECT')
--     and not has_table_privilege('service_role', 'public.oauth_check_credits', 'SELECT') as credits_closed,
--   not has_function_privilege('anon', 'public.oauth_check_credit_take(uuid,text)', 'EXECUTE') as helpers_internal,
--   position('Developers → API keys' in pg_get_functiondef('public.api_create_video(text,text,jsonb,text,text,text)'::regprocedure)) > 0
--     and position('Developers → Usage and billing' in pg_get_functiondef('public.api_request_download(text,text,text,text,text,text)'::regprocedure)) > 0
--     as spend_limits_name_the_remedy,
--   (select attgenerated = 's' from pg_attribute where attrelid = 'public.oauth_clients'::regclass and attname = 'vendor')
--     and (public.oauth_limits() ->> 'register_vendor_per_ip_hour')::int = 300 as vendor_registrations_classed,
--   (public.oauth_limits() ->> 'max_new_grants_per_user_day')::int = 50
--     and position('too_many_connections_today' in pg_get_functiondef('public.oauth_decide_authorization(text,boolean,numeric,text)'::regprocedure)) > 0
--     and position('v_ended' in pg_get_functiondef('public.oauth_gc()'::regprocedure)) > 0 as revoked_connections_do_not_pin_rows,
--   (select count(*) from public.oauth_mcp_entitlement_before_0147) > 0 as plan_values_saved_for_the_rollback;
-- The second oauth_ctx of one request id being counted is asserted by the end-state block above on every apply, and with real
-- grants and tokens by tests/security/test_sec_mcp_free_tier.py.
