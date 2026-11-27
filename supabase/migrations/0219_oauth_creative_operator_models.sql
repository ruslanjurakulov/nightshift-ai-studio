-- 0219_oauth_creative_operator_models.sql — the operator's own workspace may generate, through its own connected assistant, with the
-- models the Studio sells on the web; no ByteDance model is ever offered to any connected assistant; and every quote, generation
-- and audit row records by which route the model was offered.
--
-- WHY. The owner makes the site's first-party marketing samples (cinematic clips) through our own MCP connection, from the
--   operator's own workspace (S9, docs/studio/S9_MCP_CREATIVE.md "Models"). 0191 offers a connected assistant only a model whose
--   vendor allows our connector (sellable_models(cap, 'mcp'): api_exposure web_mcp or any) AND that the registry switched on for
--   assistants (spec.mcp_oauth_exposure). Both are about a THIRD party: the end user of another workspace, generating through their
--   own assistant. 32 of the 34 video models are web_only, so today the operator cannot make one clip that way. Decision (Atlas, for
--   the owner, 2026-11-22): in the operator's own organization (public.default_org_id(), the one organization credits_exempt()
--   names), a connected assistant is our own Studio use, not exposure to a third party, so it may use what the Studio itself sells
--   on the web. Every other workspace keeps 0191/0192's answers.
--
-- WHAT IT ADDS
--   * oauth_creative_operator_org(org): true only for the operator's own organization. It is credits_exempt(org) under a name that
--     says what is being asked here, so a reader of the judgement below does not have to know that "never pays" and "is the
--     operator" are the same organization today (0020). Not callable by any API role.
--   * oauth_creative_bytedance(model): true for any model by ByteDance / BytePlus, by id (seedance / seedream), provider, adapter
--     (video.seedance*, image.seedream*) or the vendor's own model id. Such a model is 'not_offered' to EVERY connected assistant,
--     the operator's included: BytePlus's service terms §4.2.3 forbid re-integrating its video API into an AI content-creation tool
--     (docs/FILM_STUDIO.md, "Models"; 0166's film_check_model refuses Seedance for the same reason). Seedream (pictures) is
--     included: the same vendor, the same terms, and an assistant connector is that kind of tool.
--     ByteDance models stay hidden on every surface, the web Studio included, until a terms review says otherwise (BytePlus service
--     terms §4.2.3).
--   * oauth_creative_org_model_state(org, capability, model): the one judgement the list, the quote and the create now share.
--       - a ByteDance model: 'not_offered', for everyone;
--       - otherwise 0191's oauth_creative_model_state(capability, model), unchanged and called as it is, for every organization;
--       - only in the operator's organization, and only where that answer is 'not_offered': the same gates again WITHOUT the two
--         third-party ones (the per-model switch for assistants and the 'mcp' surface), i.e. one of the API's capabilities (never
--         captions), no blocked_countries, no rights acknowledgement ('acknowledgement_required'), the owner's switch
--         ('temporarily_off'), and on sale in the Studio on the web (sellable_models(cap, 'web'): verified, probed, priced, switched
--         on, not past its shutdown, no terms gate). Passing all of them is 'ok_operator'.
--     So a non-operator organization gets exactly 0191's answer for every model, except that a ByteDance model can never be 'ok'
--     (none is today: no ByteDance model has mcp_oauth_exposure, and seedance-1.5-pro's api_exposure becomes web_only in the
--     registry file with this change).
--   * exposure on oauth_creative_quotes and oauth_creative_jobs: text not null default 'mcp', check in ('mcp', 'operator'). Every
--     existing row is 'mcp', which is what it was.
--
-- REPLACES (md5 drift guards: the earlier body, or this file's own on a replay; whitespace runs read as one space):
--   oauth_creative_models (0192's body, marked hunks): the org-aware judgement; the operator's workspace lists from
--     sellable_models(cap, 'web'); every model carries operator_only (true only for a model this workspace reaches by the operator
--     route, with an availability_note); still no price, no terms notes, the model's shape only.
--     beafb530957690f51366c995468ad36f -> 3c19fec218d8b140008495a635e57317
--   oauth_creative_quote (0192's body, marked hunks): the org-aware judgement; the quote stores exposure; an operator-route quote's
--     answer says operator_only: true (any other quote's answer is unchanged).
--     e3340606260711781f202aff7abdcdee -> 13c960060df92c6e250c6f5e95dddab9
--   oauth_creative_create (0191's body, marked hunks): the judgement is asked again for the quote's own organization, and a quote
--     whose route no longer holds is refused (409 quote_exposure_changed, nothing held); the job row and the 'creative.generate'
--     audit row record the quote's exposure. Still exactly the quoted capability, model, params and credits: no swap.
--     527ce6685df6651507bb9fbd186a1c0c -> 86e36ace55f20829fa7c4da91f9eef9f
--   Signatures, SECURITY DEFINER, the pinned search_path and the grants (anon only) stay as 0191 made them.
-- NOT CHANGED: oauth_creative_model_state (0191's body, guarded here because the new judgement calls it), oauth_creative_state_refusal,
--   oauth_creative_get, oauth_media_list, oauth_ctx, create_creative_job, creative_price, sellable_models, every price, hold, capture,
--   refund and rate rule, the connection's monthly limit (not applied in the credits-exempt workspace, as since 0191), and every
--   model's data: this file writes no model_registry row (seedance-1.5-pro's api_exposure is the registry file's, applied by the
--   registry sync). Nothing here publishes anything: a generation's files stay private in the workspace's library.
--
-- NUMBER. 0219, assigned by the S9 lead (renumbered from 0218, which is creative_price's). Needs 0191 and 0192 (the bodies it
--   replaces) and 0218 (applied before it; the guard below reads its marker); replaces nothing 0208 or 0218 replaces.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only):
--   select p.oid::regprocedure, md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc p
--    where p.oid in ('public.oauth_creative_models(text, text, text)'::regprocedure,
--                    'public.oauth_creative_quote(text, text, text, jsonb, text)'::regprocedure,
--                    'public.oauth_creative_create(text, uuid, text, text)'::regprocedure,
--                    'public.oauth_creative_model_state(text, text)'::regprocedure);
--   expected BEFORE beafb530957690f51366c995468ad36f (0192), e3340606260711781f202aff7abdcdee (0192), 527ce6685df6651507bb9fbd186a1c0c (0191),
--   45811a3b219fa2414b3820c34ee247de (0191, unchanged); AFTER 3c19fec218d8b140008495a635e57317, 13c960060df92c6e250c6f5e95dddab9, 86e36ace55f20829fa7c4da91f9eef9f,
--   45811a3b219fa2414b3820c34ee247de.
-- Undo: docs/sql/rollback_0219_oauth_creative_operator_models.sql (owner-applied; it keeps the exposure columns and their record).

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  if to_regclass('public.oauth_creative_quotes') is null
     or to_regprocedure('public.oauth_creative_model_state(text, text)') is null then
    raise exception '0219 needs 0191_mcp_oauth_creative.sql: apply it first';
  end if;
  if to_regprocedure('public.adult_attestation_gate(uuid, text)') is null then
    raise exception '0219 needs 0192_adult_attestation.sql: apply it first';
  end if;
  -- 0218 (creative_price refuses an over-long prompt, a negative prompt the model does not take, and a seed) applies first: the
  -- operator route quotes through creative_price, and the apply order is 0208 -> 0218 -> 0219. Its marker is its own refusal word.
  if to_regprocedure('public.creative_price(uuid, text, text, jsonb)') is null
     or (select position('seed_not_supported' in p.prosrc) from pg_proc p
          where p.oid = to_regprocedure('public.creative_price(uuid, text, text, jsonb)')) = 0 then
    raise exception '0219 needs 0218_creative_prompt_limits.sql: apply it first';
  end if;
  if to_regprocedure('public.credits_exempt(uuid)') is null or to_regprocedure('public.default_org_id()') is null then
    raise exception '0219 needs 0018 and 0020 (the operator''s organization and credits_exempt): apply them first';
  end if;
  for r in select * from (values
      ('public.oauth_creative_models(text, text, text)', 'beafb530957690f51366c995468ad36f', '3c19fec218d8b140008495a635e57317', '0192'),
      ('public.oauth_creative_quote(text, text, text, jsonb, text)', 'e3340606260711781f202aff7abdcdee', '13c960060df92c6e250c6f5e95dddab9', '0192'),
      ('public.oauth_creative_create(text, uuid, text, text)', '527ce6685df6651507bb9fbd186a1c0c', '86e36ace55f20829fa7c4da91f9eef9f', '0191'),
      -- Not replaced, but the new judgement calls it and relies on what it answers: 0191's body only.
      ('public.oauth_creative_model_state(text, text)', '45811a3b219fa2414b3820c34ee247de', '45811a3b219fa2414b3820c34ee247de', '0191')) v(sig, before, after, src) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is null or h <> all (array[r.before, r.after]) then
      raise exception '0219 found % with a body that is neither %''s nor 0219''s (md5 %): read the live body first', r.sig, r.src, h;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The route, recorded on every quote and every generation
-- ───────────────────────────────────────────────────────────────────────────

-- 'mcp': the model is offered to connected apps (0191's judgement). 'operator': only by the operator route, in the operator's own
-- workspace (this file). The default is what every existing row was.
alter table public.oauth_creative_quotes add column if not exists exposure text not null default 'mcp';
alter table public.oauth_creative_quotes drop constraint if exists oauth_creative_quotes_exposure_check;
alter table public.oauth_creative_quotes add constraint oauth_creative_quotes_exposure_check check (exposure in ('mcp', 'operator'));
alter table public.oauth_creative_jobs add column if not exists exposure text not null default 'mcp';
alter table public.oauth_creative_jobs drop constraint if exists oauth_creative_jobs_exposure_check;
alter table public.oauth_creative_jobs add constraint oauth_creative_jobs_exposure_check check (exposure in ('mcp', 'operator'));

comment on column public.oauth_creative_quotes.exposure is
  '0219: why this connection could use the model: mcp (offered to connected apps) or operator (the operator''s own workspace only).';
comment on column public.oauth_creative_jobs.exposure is
  '0219: the route of the quote that paid for this generation: mcp or operator.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The judgement
-- ───────────────────────────────────────────────────────────────────────────

-- The operator's own organization: credits_exempt (0020) is exactly "is public.default_org_id()". Named for what this file asks,
-- so that the judgement reads as a policy ("first-party use") and a future change to who pays cannot silently widen it unnoticed:
-- a test pins that this is the body.
create or replace function public.oauth_creative_operator_org(p_org uuid) returns boolean
  language sql stable set search_path = public, pg_temp as $$
  select public.credits_exempt(p_org)
$$;

-- Any ByteDance / BytePlus model, however it is named: never offered to a connected assistant (BytePlus service terms §4.2.3,
-- docs/FILM_STUDIO.md). By the requested id itself too, so a model that is not (or not yet) in the registry reads the same.
create or replace function public.oauth_creative_bytedance(p_model text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select lower(btrim(coalesce(p_model, ''))) ~ '(seedance|seedream)'
      or exists (select 1 from public.model_registry m
                  where m.id = lower(btrim(coalesce(p_model, '')))
                    and (lower(m.provider) in ('bytedance', 'byteplus')
                         or m.adapter ~* '^(video\.seedance|image\.seedream)'
                         or coalesce(m.spec ->> 'vendor_model', '') ~* '(seedance|seedream)'
                         or lower(coalesce(m.spec ->> 'vendor', '')) in ('bytedance', 'byteplus')))
$$;

-- Whether THIS organization's connected assistant may generate with this model for this capability, in one word:
--   ok | ok_operator | not_offered | acknowledgement_required | temporarily_off
-- 'ok' is 0191's answer (offered to connected apps); 'ok_operator' is reached only in the operator's own organization, for a model
-- that fails nothing but the two third-party gates. The list, the quote and the create all ask this, so the three never disagree.
create or replace function public.oauth_creative_org_model_state(p_org uuid, p_capability text, p_model text) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  cap   text := lower(btrim(coalesce(p_capability, '')));
  mdl   text := lower(btrim(coalesce(p_model, '')));
  v     text;
  r     public.model_registry;
  ack   jsonb;
begin
  if public.oauth_creative_bytedance(mdl) then
    return 'not_offered';
  end if;
  v := public.oauth_creative_model_state(cap, mdl);
  -- Every organization but the operator's, and every answer but 'not_offered', is 0191's, word for word.
  if v <> 'not_offered' or not public.oauth_creative_operator_org(p_org) then
    return v;
  end if;
  -- The operator route: 0191's gates in 0191's order, without the per-model switch for assistants and the 'mcp' surface (both are
  -- about a third party's end user; this is our own Studio use).
  if not (cap = any (public.oauth_creative_capabilities())) then
    return 'not_offered';
  end if;
  select * into r from public.model_registry m where m.id = mdl;
  if r.id is null or not (cap = any (r.capabilities)) or 'captions' = any (r.capabilities) then
    return 'not_offered';
  end if;
  -- No address to check a country against, for the operator's assistant either.
  if r.spec ? 'blocked_countries' then
    return 'not_offered';
  end if;
  -- The rights acknowledgement is a person's act in the Studio; no assistant gives it, for the operator either.
  ack := coalesce(r.spec -> 'requires_acknowledgement', '[]'::jsonb);
  if jsonb_typeof(ack) <> 'array' or jsonb_array_length(ack) > 0
     or coalesce(jsonb_array_length(case when jsonb_typeof(to_jsonb(r) -> 'requires_acknowledgement') = 'array'
                                         then to_jsonb(r) -> 'requires_acknowledgement' end), 0) > 0
     or (to_jsonb(r) ? 'requires_acknowledgement'
         and jsonb_typeof(to_jsonb(r) -> 'requires_acknowledgement') not in ('array', 'null')) then
    return 'acknowledgement_required';
  end if;
  if not public.model_is_available(r.id)
     and r.availability in ('beta', 'ga') and r.verified_at is not null then
    return 'temporarily_off';
  end if;
  -- On sale in the Studio itself: verified, probed, priced, switched on, not past its shutdown, no terms gate.
  if not exists (select 1 from public.sellable_models(cap, 'web') s where s.id = r.id) then
    return 'not_offered';
  end if;
  return 'ok_operator';
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The list: 0192's oauth_creative_models, marked hunks
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.oauth_creative_models(p_token_hash text, p_capability text default null, p_request_id text default null)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx    jsonb;
  v_org  uuid;
  v_cap  text := nullif(lower(btrim(coalesce(p_capability, ''))), '');
  v_paid boolean;
  v_list jsonb;
  -- 0219: the operator's own workspace (oauth_creative_operator_org) also lists what the Studio sells on the web.
  v_op   boolean;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return public.api_err(401, 'invalid_token', 'The access token is missing, expired, revoked or unknown. Reconnect the app.');
  end if;
  ctx := public.oauth_ctx(p_token_hash, 'oauth.creative.models', p_request_id);
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    if v_cap is not null and not (v_cap = any (public.oauth_creative_capabilities())) then
      return public.api_finish(ctx, public.api_err(400, 'invalid_params',
        format('capability must be one of: %s.', array_to_string(public.oauth_creative_capabilities(), ', '))), 0);
    end if;
    v_org := (ctx ->> 'org_id')::uuid;
    v_paid := public.credits_exempt(v_org)
              or exists (select 1 from public.credit_transactions t where t.org_id = v_org and t.kind = 'purchase');
    v_op := public.oauth_creative_operator_org(v_org);
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', s.id, 'name', s.display_name,
             -- 0219: the org-aware judgement; 'ok_operator' is reached only in the operator's own workspace.
             'capabilities', to_jsonb(array(select c from unnest(s.capabilities) c
                                             where public.oauth_creative_org_model_state(v_org, c, s.id) in ('ok', 'ok_operator')
                                             order by c)),
             -- 0219: true when this workspace reaches the model only by the operator route (first-party use), so the assistant
             -- never reads it as offered to connected apps in general. false everywhere else, so the key always means the same.
             'operator_only', not x.via_mcp,
             'availability', s.availability,
             'spec', jsonb_strip_nulls(jsonb_build_object(
                       'output', s.spec -> 'output', 'aspect_ratios', s.spec -> 'aspect_ratios',
                       'image_sizes', s.spec -> 'image_sizes', 'resolutions', s.spec -> 'resolutions',
                       'durations_s', s.spec -> 'durations_s', 'inputs', s.spec -> 'inputs', 'audio_out', s.spec -> 'audio_out',
                       -- 0192: an adults-only model is listed (we never pretend a model does not exist) and marked, from
                       -- sellable_models' own public spec; the quote refuses it to anyone without an adult answer.
                       'requires_adult', s.spec -> 'requires_adult',
                       'max_prompt_chars', s.spec #> '{limits,max_prompt_chars}')))
             || case when x.via_mcp then '{}'::jsonb
                     else jsonb_build_object('availability_note', 'Operator workspace only (first-party use).') end
             order by s.id), '[]'::jsonb)
      into v_list
      -- 0219: the operator's workspace starts from the web's list (the Studio's own: verified, probed, priced, switched on, not
      -- past its shutdown, no terms gate) and the judgement below narrows it; every other workspace from 0188's 'mcp' surface, as
      -- before.
      from public.sellable_models(v_cap, case when v_op then 'web' else 'mcp' end) s
      cross join lateral (select coalesce(bool_or(public.oauth_creative_org_model_state(v_org, c, s.id) = 'ok'), false) as via_mcp
                            from unnest(s.capabilities) c) x
     where (coalesce(s.entitlement, 'any') = 'any' or (s.entitlement = 'paid' and v_paid))
       and exists (select 1 from unnest(s.capabilities) c
                    where (v_cap is null or c = v_cap)
                      and public.oauth_creative_org_model_state(v_org, c, s.id) in ('ok', 'ok_operator'));
    return public.api_finish(ctx, public.api_ok(jsonb_build_object('capability', v_cap, 'models', v_list)), 0);
  exception when others then
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'), 0);
  end;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The quote: 0192's oauth_creative_quote, marked hunks
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.oauth_creative_quote(p_token_hash text, p_capability text, p_model text, p_params jsonb,
                                                       p_request_id text default null)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx      jsonb;
  v_org    uuid;
  v_grant  uuid;
  v_cap    text := lower(btrim(coalesce(p_capability, '')));
  v_model  text := lower(btrim(coalesce(p_model, '')));
  v_p      jsonb := coalesce(p_params, '{}'::jsonb);
  v_state  text;
  -- 0219: why this connection may use the model, stored with the quote: 'mcp' (offered to connected apps) or 'operator'.
  v_exp    text;
  v_q      jsonb;
  v_row    public.oauth_creative_quotes;
  v_res    jsonb;
  v_spent  numeric;
  v_msg    text;
  v_detail text;
  v_sql    text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return public.api_err(401, 'invalid_token', 'The access token is missing, expired, revoked or unknown. Reconnect the app.');
  end if;
  ctx := public.oauth_ctx(p_token_hash, 'oauth.creative.quote', p_request_id);
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    v_org := (ctx ->> 'org_id')::uuid;
    v_grant := (ctx ->> 'grant_id')::uuid;
    v_res := public.oauth_creative_rate_refusal(v_grant, 'quote');
    if v_res is not null then
      return public.api_finish(ctx, v_res, 0);
    end if;
    if jsonb_typeof(v_p) <> 'object' or pg_column_size(v_p) > 16384 then
      return public.api_finish(ctx, public.api_err(400, 'invalid_params', 'params must be a JSON object (at most 16 KB).'), 0);
    end if;
    -- 0219: the org-aware judgement (the operator's own workspace may also reach a model by the operator route).
    v_state := public.oauth_creative_org_model_state(v_org, v_cap, v_model);
    if v_state not in ('ok', 'ok_operator') then
      return public.api_finish(ctx, public.oauth_creative_state_refusal(v_state, v_model), 0);
    end if;
    v_exp := case when v_state = 'ok_operator' then 'operator' else 'mcp' end;
    begin
      -- The Studio's own price for this workspace: the model, the settings, the source file (this workspace's, live), the
      -- entitlement. Computed nowhere else.
      v_q := public.creative_price(v_org, v_cap, v_model, v_p);
      -- 0192: the Studio's adult gate, for the person who connected the app (oauth_ctx acted as them): someone who said they are
      -- under 18 is refused every model (adult_only_service), and a model whose vendor's terms are 18+ needs an adult answer
      -- (adult_attestation_required). After the price, as in the Studio, and raised inside this block, so the answer is
      -- api_creative_refusal's typed 403 / 428 and no quote is stored for create to spend.
      perform public.adult_attestation_gate(auth.uid(), v_model);
      -- A connection's own quotes that ran out are of no use to anyone; a connection holds at most a few live ones (storage is a
      -- ceiling: 30 quotes a minute of up to 16 KB each would otherwise pile up).
      delete from public.oauth_creative_quotes q
       where q.grant_id = v_grant and q.job_id is null and q.expires_at < now();
      if (select count(*) from public.oauth_creative_quotes q where q.grant_id = v_grant and q.job_id is null)
         >= (public.oauth_creative_limits() ->> 'open_quotes_max')::integer then
        return public.api_finish(ctx, public.api_err(429, 'too_many_quotes',
          'This connection has too many open quotes. Create from one, or wait for them to expire.',
          jsonb_build_object('retry_after', 60)), 0);
      end if;
      -- The tier, resolution and soundtrack the price is for are written into the params, the way create_creative_job writes
      -- them into the job: what runs is what was shown, even if a model's default changes before create.
      v_p := v_p || (v_q - array(select k from jsonb_object_keys(v_q) k where k not in ('quality', 'resolution', 'audio')));
      insert into public.oauth_creative_quotes (grant_id, org_id, capability, model, params, credits, quote, expires_at, exposure)
      values (v_grant, v_org, v_cap, v_model, v_p, (v_q ->> 'credits')::numeric, v_q - 'exempt' - 'preview',
              now() + make_interval(secs => (public.oauth_creative_limits() ->> 'quote_ttl_seconds')::integer), v_exp)
      returning * into v_row;
      v_spent := public.oauth_grant_month_credits(v_grant);
      v_res := public.api_ok(public.oauth_creative_quote_json(v_row)
        -- 0219: an operator-route quote says so; any other quote's answer is unchanged.
        || case when v_exp = 'operator' then jsonb_build_object('operator_only', true) else '{}'::jsonb end
        || jsonb_build_object('this_connection', jsonb_build_object(
             'monthly_limit_credits', (ctx ->> 'limit_credits')::numeric)
           -- Only where create applies the limit: on the credits-exempt workspace it is not a ceiling, so no number is shown as one.
           || case when public.credits_exempt(v_org) then '{}'::jsonb
                   else jsonb_build_object('left_this_month_credits', greatest((ctx ->> 'limit_credits')::numeric - v_spent, 0)) end), 201);
    exception when others then
      get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
      v_sql := sqlstate;
      v_res := public.api_creative_refusal(v_sql, v_msg, v_detail);
    end;
    return public.api_finish(ctx, v_res, 0);
  exception when others then
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'), 0);
  end;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The create: 0191's oauth_creative_create, marked hunks
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.oauth_creative_create(p_token_hash text, p_quote_id uuid, p_idem_key text,
                                                        p_request_id text default null)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx      jsonb;
  v_org    uuid;
  v_grant  uuid;
  v_idem   text := btrim(coalesce(p_idem_key, ''));
  v_key    text;
  prior    public.oauth_creative_jobs;
  q        public.oauth_creative_quotes;
  j        public.creative_jobs;
  acc      public.credit_accounts;
  v_state  text;
  v_price  numeric;
  v_limit  numeric;
  v_spent  numeric;
  v_out    jsonb;
  v_res    jsonb;
  v_msg    text;
  v_detail text;
  v_sql    text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return public.api_err(401, 'invalid_token', 'The access token is missing, expired, revoked or unknown. Reconnect the app.');
  end if;
  ctx := public.oauth_ctx(p_token_hash, 'oauth.creative.create', p_request_id);
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    v_org := (ctx ->> 'org_id')::uuid;
    v_grant := (ctx ->> 'grant_id')::uuid;
    if v_idem = '' then
      return public.api_finish(ctx, public.api_err(400, 'idempotency_key_required',
        'Send an idempotency_key: a generation spends credits, and a retry must not spend twice.'), 0);
    end if;
    if v_idem !~ '^[A-Za-z0-9_:.-]{1,255}$' then
      return public.api_finish(ctx, public.api_err(400, 'invalid_idempotency_key',
        'idempotency_key: 1-255 characters of A-Z a-z 0-9 _ : . -'), 0);
    end if;
    if p_quote_id is null then
      return public.api_finish(ctx, public.api_err(400, 'quote_required',
        'Send the quote_id of a quote this connection made: a generation runs only at a price the person was shown.'), 0);
    end if;

    -- One create at a time per connection, so its monthly limit cannot be raced past and a retry finds the first one's row.
    -- (Lock order as in api_creative_create: this lock first, then the credit account inside.)
    perform pg_advisory_xact_lock(hashtextextended('oauth_creative:' || v_grant::text, 0));

    -- A replay of the same key answers the first generation and costs nothing more (no rate unit either).
    select * into prior from public.oauth_creative_jobs where grant_id = v_grant and idem_key = v_idem;
    if prior.job_id is not null then
      if prior.quote_id is distinct from p_quote_id then
        return public.api_finish(ctx, public.api_err(422, 'idempotency_key_reused',
          'This idempotency_key was already used for a different quote.'), 0);
      end if;
      select * into j from public.creative_jobs where id = prior.job_id and org_id = v_org;
      return public.api_finish(ctx, public.api_ok(public.api_creative_job_json(j) || jsonb_build_object('replayed', true), 200), 0);
    end if;

    v_res := public.oauth_creative_rate_refusal(v_grant, 'create');
    if v_res is not null then
      return public.api_finish(ctx, v_res, 0);
    end if;

    -- Only this connection's own quote: another connection's, even in the same workspace, reads exactly like an unknown id.
    select * into q from public.oauth_creative_quotes where id = p_quote_id and grant_id = v_grant and org_id = v_org for update;
    if q.id is null then
      return public.api_finish(ctx, public.api_err(404, 'quote_not_found',
        'No quote with that id for this connection. Quote again (quote_creative).'), 0);
    end if;
    if q.job_id is not null then
      return public.api_finish(ctx, public.api_err(409, 'quote_used',
        'That quote already paid for a generation. Quote again for another one.', jsonb_build_object('job_id', q.job_id)), 0);
    end if;
    if q.expires_at <= now() then
      return public.api_finish(ctx, public.api_err(409, 'quote_expired',
        'That quote has expired. Quote again, tell the person the price, and create only if they agree.',
        jsonb_build_object('expired_at', q.expires_at)), 0);
    end if;
    -- The model may have been switched off since the quote.
    -- 0219: the org-aware judgement, asked again now, and it must still be the reason the quote recorded: a quote made by one
    -- route is never spent by the other (nothing is held; the assistant quotes again and the person sees the new answer).
    v_state := public.oauth_creative_org_model_state(v_org, q.capability, q.model);
    if v_state not in ('ok', 'ok_operator') then
      return public.api_finish(ctx, public.oauth_creative_state_refusal(v_state, q.model), 0);
    end if;
    if (case when v_state = 'ok_operator' then 'operator' else 'mcp' end) is distinct from q.exposure then
      return public.api_finish(ctx, public.api_err(409, 'quote_exposure_changed',
        'How this model is offered to this connection changed since the quote. Nothing was held. Quote again and confirm the price with the person.',
        jsonb_build_object('model', q.model)), 0);
    end if;
    -- A limit of 0 is a read-only connection, whoever pays: a generation can be priced at 0, so `spent + 0 > 0` would let one
    -- through on a paying workspace too (Lens).
    if (ctx ->> 'limit_credits')::numeric <= 0 then
      return public.api_finish(ctx, public.api_err(402, 'connection_limit_reached',
        'This connection is read-only: its monthly spending limit is 0.',
        -- What was spent is counted, never assumed to be 0: the limit may have been lowered after spending.
        jsonb_build_object('limit_credits', 0, 'spent_credits', public.oauth_grant_month_credits(v_grant),
                           'price_credits', q.credits)), 0);
    end if;

    begin
      -- The price now, for exactly what was quoted: anything but the same number is refused, never charged.
      v_price := (public.creative_price(v_org, q.capability, q.model, q.params) ->> 'credits')::numeric;
      if v_price is distinct from q.credits then
        v_res := public.api_err(409, 'price_changed',
          'The price changed since the quote. Nothing was held. Quote again and confirm the new price with the person.',
          jsonb_build_object('quoted_credits', q.credits, 'price_credits', v_price));
      end if;
      if v_res is null and not (ctx ->> 'exempt')::boolean then
        acc := public.credit_account_lock(v_org);
        v_limit := (ctx ->> 'limit_credits')::numeric;
        v_spent := public.oauth_grant_month_credits(v_grant);
        if v_spent + q.credits > v_limit then
          v_res := public.api_err(402, 'connection_limit_reached',
            'This generation would take this connection past its monthly spending limit.',
            jsonb_build_object('limit_credits', v_limit, 'spent_credits', v_spent, 'price_credits', q.credits));
        end if;
      end if;
      if v_res is null then
        -- Namespaced by the connection: no other connection or key of the workspace can replay it. 'oa-' + 64 hex fits 0036's rule.
        v_key := 'oa-' || encode(sha256(convert_to(v_grant::text || ':' || v_idem, 'UTF8')), 'hex');
        -- The Studio's own function, as the person who connected the app (oauth_ctx acted as them): membership, the model, the price,
        -- max_credits (the quote), the hold and the job, atomically.
        v_out := public.create_creative_job(v_org, q.capability, q.model, q.params, 'exact', v_key, q.credits);
        select * into j from public.creative_jobs where id = (v_out -> 'job' ->> 'id')::uuid and org_id = v_org;
        if j.id is null then
          raise exception 'job missing after create' using errcode = 'XX000';
        end if;
        -- What is held is what the person was shown, or nothing at all (this raise undoes the hold and the job).
        if j.quoted_credits is distinct from q.credits then
          perform public.creative_refuse('price_changed', format('price=%s confirmed=%s', j.quoted_credits, q.credits), 'NS409');
        end if;
        -- 0219: the route the quote recorded (and the check above confirmed) is the job's.
        insert into public.oauth_creative_jobs (job_id, grant_id, org_id, quote_id, idem_key, credit_ref, quoted_credits, exposure)
        values (j.id, v_grant, v_org, q.id, v_idem, j.credit_ref, j.quoted_credits, q.exposure);
        update public.oauth_creative_quotes set job_id = j.id where id = q.id;
        insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail, channel_id)
        values ((ctx ->> 'created_by')::uuid, nullif(auth.jwt() ->> 'email', ''), 'creative.generate', j.id::text,
                jsonb_build_object('org_id', v_org, 'capability', q.capability, 'model', q.model,
                                   'quoted_credits', j.quoted_credits, 'credit_ref', j.credit_ref,
                                   'via', 'mcp_oauth', 'grant_id', v_grant, 'quote_id', q.id,
                                   -- 0219
                                   'exposure', q.exposure), null);
        v_res := public.api_ok(public.api_creative_job_json(j), 201);
      end if;
    exception when others then
      -- This block is undone: no job, no hold, no link row, the quote still unused. The request still counts.
      get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
      v_sql := sqlstate;
      if v_sql = 'NS402' then
        select * into acc from public.credit_accounts where org_id = v_org;
        v_res := public.api_err(402, 'insufficient_credits',
          'The workspace does not have enough credits for this generation. Nothing was held.',
          jsonb_build_object('available_credits',
                               case when coalesce(acc.use_extra_credits, true)
                                    then greatest(coalesce(acc.balance, 0) - coalesce(acc.reserved, 0), 0)
                                    else public.credit_spendable_internal(v_org) end,
                             'held_credits', coalesce(acc.reserved, 0), 'price_credits', q.credits)
          || case when coalesce(acc.use_extra_credits, true) then '{}'::jsonb
                  else jsonb_build_object('extra_credits_off', true) end);
      elsif v_sql = 'NS409' and btrim(coalesce(v_msg, '')) = 'price_changed' then
        v_res := public.api_err(409, 'price_changed',
          'The price changed since the quote. Nothing was held. Quote again and confirm the new price with the person.',
          jsonb_build_object('quoted_credits', q.credits));
      elsif btrim(coalesce(v_msg, '')) = 'acknowledgement_required' then
        -- 0174's refusal inside create_creative_job, should a model need it after all: the person confirms in the Studio.
        v_res := public.oauth_creative_state_refusal('acknowledgement_required', q.model);
      else
        v_res := public.api_creative_refusal(v_sql, v_msg, v_detail);
      end if;
    end;
    return public.api_finish(ctx, v_res, 0);
  exception when others then
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'), 0);
  end;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Privileges: the doors stay anon's; the three helpers are nobody's
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.oauth_creative_models(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_creative_quote(text, text, text, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_creative_create(text, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.oauth_creative_models(text, text, text) to anon;
grant execute on function public.oauth_creative_quote(text, text, text, jsonb, text) to anon;
grant execute on function public.oauth_creative_create(text, uuid, text, text) to anon;
revoke all on function public.oauth_creative_operator_org(uuid) from public, anon, authenticated, service_role;
revoke all on function public.oauth_creative_bytedance(text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_creative_org_model_state(uuid, text, text) from public, anon, authenticated, service_role;

-- End state: refuse to finish with the wrong shape.
do $$
declare
  fn regprocedure;
begin
  foreach fn in array array['public.oauth_creative_models(text, text, text)'::regprocedure,
                            'public.oauth_creative_quote(text, text, text, jsonb, text)'::regprocedure,
                            'public.oauth_creative_create(text, uuid, text, text)'::regprocedure] loop
    if not has_function_privilege('anon', fn, 'EXECUTE')
       or has_function_privilege('authenticated', fn, 'EXECUTE')
       or has_function_privilege('service_role', fn, 'EXECUTE') then
      raise exception '0219 end state: % has the wrong grants', fn;
    end if;
    if exists (select 1 from pg_proc p where p.oid = fn
                and (not p.prosecdef or p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                     or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
      raise exception '0219 end state: % is not a SECURITY DEFINER with a fixed search_path, or PUBLIC may call it', fn;
    end if;
  end loop;
  foreach fn in array array['public.oauth_creative_operator_org(uuid)'::regprocedure,
                            'public.oauth_creative_bytedance(text)'::regprocedure,
                            'public.oauth_creative_org_model_state(uuid, text, text)'::regprocedure,
                            'public.oauth_creative_model_state(text, text)'::regprocedure] loop
    if has_function_privilege('anon', fn, 'EXECUTE') or has_function_privilege('authenticated', fn, 'EXECUTE')
       or has_function_privilege('service_role', fn, 'EXECUTE') then
      raise exception '0219 end state: % may be called by an API role', fn;
    end if;
  end loop;
  if not public.oauth_creative_operator_org(public.default_org_id())
     or public.oauth_creative_operator_org(null)
     or public.oauth_creative_operator_org('00000000-0000-0000-0000-000000000002'::uuid) then
    raise exception '0219 end state: the operator route is not exactly the operator''s own organization';
  end if;
  if not public.oauth_creative_bytedance('seedance-1.5-pro') or not public.oauth_creative_bytedance('Seedream-5.0-pro')
     or public.oauth_creative_org_model_state(public.default_org_id(), 'i2v', 'seedance-2.0') <> 'not_offered' then
    raise exception '0219 end state: a ByteDance model is not refused';
  end if;
  if has_table_privilege('anon', 'public.oauth_creative_quotes', 'SELECT')
     or has_table_privilege('authenticated', 'public.oauth_creative_jobs', 'SELECT')
     or has_table_privilege('authenticated', 'public.oauth_creative_quotes', 'UPDATE')
     or has_table_privilege('service_role', 'public.oauth_creative_jobs', 'UPDATE') then
    raise exception '0219 end state: an API role can reach a record table';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying, in the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select public.oauth_creative_operator_org(public.default_org_id()) as operator_route_is_the_operators_org,
--        not public.oauth_creative_operator_org(gen_random_uuid()) as no_other_org,
--        not exists (select 1 from public.model_registry m
--                     where public.oauth_creative_bytedance(m.id)
--                       and public.oauth_creative_org_model_state(public.default_org_id(), m.capabilities[1], m.id) <> 'not_offered')
--          as no_bytedance_model_for_the_operator,
--        not exists (select 1 from public.model_registry m, unnest(m.capabilities) c
--                     where public.oauth_creative_org_model_state(gen_random_uuid(), c, m.id) = 'ok_operator') as customers_never_operator,
--        (select count(*) from public.oauth_creative_quotes where exposure not in ('mcp', 'operator')) = 0 as exposure_recorded,
--        public.oauth_creative_quote(repeat('0', 64), 't2i', 'x', '{}'::jsonb, null) ->> 'status' = '401' as quote_refuses_unknown_token,
--        not has_function_privilege('anon', 'public.oauth_creative_org_model_state(uuid, text, text)', 'EXECUTE') as judgement_private;

-- PostgREST reads the replaced doors' definitions now, not at its next restart.
notify pgrst, 'reload schema';
