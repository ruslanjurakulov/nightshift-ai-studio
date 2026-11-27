-- rollback_0219_oauth_creative_operator_models.sql — takes migration 0219 (the operator route for connected assistants, the ByteDance
-- refusal, the recorded exposure) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT COMES BACK: 0192's oauth_creative_models and oauth_creative_quote and 0191's oauth_creative_create, verbatim, with their grants
--   (anon only). Every workspace, the operator's included, then gets 0191's judgement again: only a model switched on for assistants
--   and allowed on the 'mcp' surface. An open operator-route quote is then refused at create as model_not_offered (0191's create
--   asks 0191's judgement), so nothing quoted by the operator route can be spent after this.
-- WHAT IS KEPT: the record. The exposure columns of oauth_creative_quotes and oauth_creative_jobs (and their checks) stay, so which
--   generation was made by which route outlives a rollback; 0191's and 0192's inserts leave them at their default 'mcp'. Applying
--   0219 again picks them up as its own.
-- WHAT IS LOST: oauth_creative_operator_org, oauth_creative_bytedance and oauth_creative_org_model_state. The ByteDance refusal then
--   rests on the registry file alone (no ByteDance model is switched on for assistants or exposed past the web, and
--   tests/test_no_bytedance_assistant.py keeps it so).
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if one of the three doors is not 0219's body (a later change would be undone).
--   1. Puts the three earlier bodies back, verbatim, with their grants.
--   2. Drops the three 0219 helpers.
--   3. Asserts the end state.

begin;
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.oauth_creative_models(text, text, text)', '3c19fec218d8b140008495a635e57317'),
      ('public.oauth_creative_quote(text, text, text, jsonb, text)', '13c960060df92c6e250c6f5e95dddab9'),
      ('public.oauth_creative_create(text, uuid, text, text)', '86e36ace55f20829fa7c4da91f9eef9f')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0219: % is not 0219''s body (md5 %): if an older file was re-run over it, apply 0219 again first, then roll back; if a later file changed it, take that file out first', r.sig, h;
    end if;
  end loop;
end $$;

-- oauth_creative_models: 0192's body, verbatim.
create or replace function public.oauth_creative_models(p_token_hash text, p_capability text default null, p_request_id text default null)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx    jsonb;
  v_org  uuid;
  v_cap  text := nullif(lower(btrim(coalesce(p_capability, ''))), '');
  v_paid boolean;
  v_list jsonb;
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
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', s.id, 'name', s.display_name,
             'capabilities', to_jsonb(array(select c from unnest(s.capabilities) c
                                             where public.oauth_creative_model_state(c, s.id) = 'ok' order by c)),
             'availability', s.availability,
             'spec', jsonb_strip_nulls(jsonb_build_object(
                       'output', s.spec -> 'output', 'aspect_ratios', s.spec -> 'aspect_ratios',
                       'image_sizes', s.spec -> 'image_sizes', 'resolutions', s.spec -> 'resolutions',
                       'durations_s', s.spec -> 'durations_s', 'inputs', s.spec -> 'inputs', 'audio_out', s.spec -> 'audio_out',
                       -- 0192: an adults-only model is listed (we never pretend a model does not exist) and marked, from
                       -- sellable_models' own public spec; the quote refuses it to anyone without an adult answer.
                       'requires_adult', s.spec -> 'requires_adult',
                       'max_prompt_chars', s.spec #> '{limits,max_prompt_chars}'))) order by s.id), '[]'::jsonb)
      into v_list
      from public.sellable_models(v_cap, 'mcp') s
     where (coalesce(s.entitlement, 'any') = 'any' or (s.entitlement = 'paid' and v_paid))
       and exists (select 1 from unnest(s.capabilities) c
                    where (v_cap is null or c = v_cap) and public.oauth_creative_model_state(c, s.id) = 'ok');
    return public.api_finish(ctx, public.api_ok(jsonb_build_object('capability', v_cap, 'models', v_list)), 0);
  exception when others then
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'), 0);
  end;
end
$$;
revoke all on function public.oauth_creative_models(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.oauth_creative_models(text, text, text) to anon;

-- oauth_creative_quote: 0192's body, verbatim.
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
    v_state := public.oauth_creative_model_state(v_cap, v_model);
    if v_state <> 'ok' then
      return public.api_finish(ctx, public.oauth_creative_state_refusal(v_state, v_model), 0);
    end if;
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
      insert into public.oauth_creative_quotes (grant_id, org_id, capability, model, params, credits, quote, expires_at)
      values (v_grant, v_org, v_cap, v_model, v_p, (v_q ->> 'credits')::numeric, v_q - 'exempt' - 'preview',
              now() + make_interval(secs => (public.oauth_creative_limits() ->> 'quote_ttl_seconds')::integer))
      returning * into v_row;
      v_spent := public.oauth_grant_month_credits(v_grant);
      v_res := public.api_ok(public.oauth_creative_quote_json(v_row)
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
revoke all on function public.oauth_creative_quote(text, text, text, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.oauth_creative_quote(text, text, text, jsonb, text) to anon;

-- oauth_creative_create: 0191's body, verbatim.
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
    v_state := public.oauth_creative_model_state(q.capability, q.model);
    if v_state <> 'ok' then
      return public.api_finish(ctx, public.oauth_creative_state_refusal(v_state, q.model), 0);
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
        insert into public.oauth_creative_jobs (job_id, grant_id, org_id, quote_id, idem_key, credit_ref, quoted_credits)
        values (j.id, v_grant, v_org, q.id, v_idem, j.credit_ref, j.quoted_credits);
        update public.oauth_creative_quotes set job_id = j.id where id = q.id;
        insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail, channel_id)
        values ((ctx ->> 'created_by')::uuid, nullif(auth.jwt() ->> 'email', ''), 'creative.generate', j.id::text,
                jsonb_build_object('org_id', v_org, 'capability', q.capability, 'model', q.model,
                                   'quoted_credits', j.quoted_credits, 'credit_ref', j.credit_ref,
                                   'via', 'mcp_oauth', 'grant_id', v_grant, 'quote_id', q.id), null);
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
revoke all on function public.oauth_creative_create(text, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.oauth_creative_create(text, uuid, text, text) to anon;

drop function if exists public.oauth_creative_org_model_state(uuid, text, text);
drop function if exists public.oauth_creative_bytedance(text);
drop function if exists public.oauth_creative_operator_org(uuid);

do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.oauth_creative_models(text, text, text)', 'beafb530957690f51366c995468ad36f'),
      ('public.oauth_creative_quote(text, text, text, jsonb, text)', 'e3340606260711781f202aff7abdcdee'),
      ('public.oauth_creative_create(text, uuid, text, text)', '527ce6685df6651507bb9fbd186a1c0c')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0219 end state: % is not the earlier body (md5 %)', r.sig, h;
    end if;
    if not has_function_privilege('anon', r.sig, 'EXECUTE') or has_function_privilege('authenticated', r.sig, 'EXECUTE')
       or has_function_privilege('service_role', r.sig, 'EXECUTE') then
      raise exception 'rollback 0219 end state: % has the wrong grants', r.sig;
    end if;
  end loop;
  if to_regprocedure('public.oauth_creative_org_model_state(uuid, text, text)') is not null then
    raise exception 'rollback 0219 end state: the org-aware judgement is still there';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
