-- 0162_api_creative_models.sql — two read-only API functions for the MCP Studio tools: the models an API key's organization can
-- generate with today, and a generation's result files.
--
-- WHY A MIGRATION. The MCP server (command-center/lib/api/mcp.ts) calls the database with the ANON key and the API key's hash, like
-- every /api/v1 route; it never has a session or the service key. Two things the new tools need have no door for such a caller:
--   * which models the key's organization may generate with: sellable_models() is granted to `authenticated` only (0125), and its
--     answer is not per organization (it lists `paid` models to an organization that has bought nothing, which create then refuses);
--   * a generation's result files: api_creative_get (0062) returns result_asset_ids, but not the file's type and variants, which the
--     server needs to sign a link to it (lib/server/media.ts signedMediaPath binds the asset id, variant and type), and media_assets
--     is readable only under a member's session (RLS).
--
-- WHAT IT ADDS (nothing else changes: no table, column, policy, constraint, row, or existing function body is touched).
--   * api_creative_models(p_key_hash, p_capability, p_request_id): a key with the creative:quote scope gets the models its organization
--     can generate with through the API, optionally for one capability. It is api_begin's caller like every API function (the key,
--     activation, the key creator's admin role, the tier's request limit and the scope are checked there, and the request is counted
--     and logged). The list is sellable_models(capability, 'api') — the same set api_creative_model_ok() lets api_creative_create sell —
--     narrowed to what this organization's create would accept: entitlement `any`, or `paid` once the organization has bought credits
--     (or is credits-exempt), the same two branches as creative_price's entitlement check (0156). Every other entitlement is a plan
--     feature create refuses, so it is not listed. No price is listed: a model priced by quality, resolution or soundtrack has no single
--     rate, and the quote (api_creative_quote) is the only price a caller may act on. The scope is creative:quote (listing what can be
--     quoted is part of quoting), so api_endpoint_scope (0062) is not replaced; the request is logged as `creative.models`.
--   * api_creative_job_files(p_key_hash, p_job_id, p_request_id): api_creative_get's answer for a generation THIS KEY started (the same
--     ownership rule, byte for byte: the job, its api_creative_jobs row with this key's id, both in the key's organization), plus `files`:
--     each result asset still in the library (not deleted) and stored on the server's own volume (`local`, the only storage the signed
--     file route serves) with its kind, type, size and variants. Scope creative:read (endpoint creative.get).
--
-- An access token of a connected app (0093) reaches neither: api_begin hands it to oauth_ctx, whose oauth_endpoint_scope has no entry
-- for creative.quote or creative.get, so it is answered 403 not_available_for_connected_apps (and lib/api/mcp-oauth.ts refuses both
-- function names before the network). Nothing here holds, charges or moves a credit: generation stays api_creative_create's, and the
-- worker's capture and release are unchanged.
--
-- Rollback: docs/sql/rollback_0162_api_creative_models.sql (drops the two functions; nothing else to undo).

set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regprocedure('public.api_begin(text, text, text)') is null then
    raise exception '0162 needs 0031_public_api.sql: apply it first';
  end if;
  if to_regprocedure('public.api_creative_get(text, uuid, text)') is null then
    raise exception '0162 needs 0062_api_creative.sql: apply it first';
  end if;
  if to_regprocedure('public.sellable_models(text, text)') is null then
    raise exception '0162 needs 0035_model_registry.sql: apply it first';
  end if;
  if to_regclass('public.media_assets') is null then
    raise exception '0162 needs 0038_media_assets.sql: apply it first';
  end if;
  -- The two names this file creates: absent, or this file's own bodies (a replay).
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.api_creative_models(text, text, text)');
  if h is not null and h <> 'c71d2d0fe6e76d5ed2cd8975b8ad73c3' then
    raise exception '0162 found public.api_creative_models(text, text, text) with a body that is not this file''s (md5 %): read the live body first', h;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.api_creative_job_files(text, uuid, text)');
  if h is not null and h <> '010344fe500657f32873d04f6d666b14' then
    raise exception '0162 found public.api_creative_job_files(text, uuid, text) with a body that is not this file''s (md5 %): read the live body first', h;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The models this key's organization can generate with
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.api_creative_models(
  p_key_hash text, p_capability text default null, p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx    jsonb := public.api_begin(p_key_hash, 'creative.quote', p_request_id);
  v_org  uuid;
  v_cap  text := nullif(lower(btrim(coalesce(p_capability, ''))), '');
  v_paid boolean;
  v_list jsonb;
  v_msg    text;
  v_detail text;
  v_state  text;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  -- The scope is creative:quote's; the log says what was asked.
  ctx := ctx || jsonb_build_object('endpoint', 'creative.models');
  v_org := (ctx ->> 'org_id')::uuid;
  begin
    begin
      -- creative_price's entitlement rule (0156): `paid` needs a purchase, or a credits-exempt organization.
      v_paid := public.credits_exempt(v_org)
                or exists (select 1 from public.credit_transactions t where t.org_id = v_org and t.kind = 'purchase');
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', s.id,
               'name', s.display_name,
               'capabilities', to_jsonb(s.capabilities),
               'availability', s.availability,
               'spec', s.spec - 'api_exposure') order by s.id), '[]'::jsonb)
        into v_list
        from public.sellable_models(v_cap, 'api') s
       where coalesce(s.entitlement, 'any') = 'any'
          or (s.entitlement = 'paid' and v_paid);
      return public.api_finish(ctx, public.api_ok(jsonb_build_object('capability', v_cap, 'models', v_list)));
    exception when others then
      get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
      v_state := sqlstate;
      -- An unknown capability is sellable_models' 22023: the same 400 invalid_params a quote answers.
      return public.api_finish(ctx, public.api_creative_refusal(v_state, v_msg, v_detail));
    end;
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. A generation this key started, with its result files
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.api_creative_job_files(
  p_key_hash text, p_job_id uuid, p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx     jsonb := public.api_begin(p_key_hash, 'creative.get', p_request_id);
  j       public.creative_jobs;
  v_files jsonb;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    -- api_creative_get's ownership rule (0062): a job this key started, in this key's organization.
    select c.* into j
      from public.creative_jobs c
      join public.api_creative_jobs a on a.job_id = c.id
     where c.id = p_job_id
       and a.key_id = (ctx ->> 'key_id')::uuid
       and a.org_id = c.org_id
       and c.org_id = (ctx ->> 'org_id')::uuid;
    if j.id is null then
      return public.api_finish(ctx, public.api_err(404, 'job_not_found', 'No generation with that id for this key.'));
    end if;
    -- The job's own outputs, still in the library and on the server's volume: the only files the signed route can serve.
    select coalesce(jsonb_agg(jsonb_build_object(
             'asset_id', m.id, 'kind', m.kind, 'mime', m.mime, 'variants', to_jsonb(m.variants),
             'width', m.width, 'height', m.height, 'duration_s', m.duration_s)
             order by array_position(j.result_asset_ids, m.id)), '[]'::jsonb)
      into v_files
      from public.media_assets m
     where m.id = any (j.result_asset_ids)
       and m.org_id = j.org_id
       and m.deleted_at is null
       and m.storage = 'local';
    return public.api_finish(ctx, public.api_ok(public.api_creative_job_json(j) || jsonb_build_object('files', v_files)));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Privileges: the anon role (PostgREST with the anon key), like every api_* entry point; nobody else
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.api_creative_models(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_creative_job_files(text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.api_creative_models(text, text, text) to anon;
grant execute on function public.api_creative_job_files(text, uuid, text) to anon;

-- End state: refuse to finish with the wrong shape.
do $$
declare
  fn regprocedure;
begin
  foreach fn in array array['public.api_creative_models(text, text, text)'::regprocedure,
                            'public.api_creative_job_files(text, uuid, text)'::regprocedure] loop
    if not has_function_privilege('anon', fn, 'EXECUTE')
       or has_function_privilege('authenticated', fn, 'EXECUTE')
       or has_function_privilege('service_role', fn, 'EXECUTE') then
      raise exception '0162 end state: % has the wrong grants', fn;
    end if;
    if exists (select 1 from pg_proc p where p.oid = fn
                and (not p.prosecdef or p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                     or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
      raise exception '0162 end state: % is not a SECURITY DEFINER with a fixed search_path, or PUBLIC may call it', fn;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying, in the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select p.oid::regprocedure as fn,
--        p.prosecdef as security_definer,
--        p.proconfig @> array['search_path=public, pg_temp'] as search_path_pinned,
--        has_function_privilege('anon', p.oid, 'EXECUTE') as anon_may_call,
--        not has_function_privilege('authenticated', p.oid, 'EXECUTE')
--          and not has_function_privilege('service_role', p.oid, 'EXECUTE') as nobody_else
--   from pg_proc p
--  where p.oid in ('public.api_creative_models(text, text, text)'::regprocedure,
--                  'public.api_creative_job_files(text, uuid, text)'::regprocedure);
--
-- A malformed key is refused before anything is read (no key needed to check this):
-- select public.api_creative_models('not-a-key', null, null) ->> 'status' = '401' as models_refuse_a_bad_key,
--        public.api_creative_job_files('not-a-key', gen_random_uuid(), null) ->> 'status' = '401' as files_refuse_a_bad_key;
