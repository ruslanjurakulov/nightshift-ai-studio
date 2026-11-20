-- 0199_adult_attestation.sql — a recorded, server-enforced adult (18+) attestation, and a gate in front of every quote and job.
--
-- EVIDENCE:
--   * The Gemini API terms (and some other vendors' terms) require their users to be 18 or older. The registry now says so per
--     model: a top-level "requires_adult": true (schemas/model_registry.schema.json, commit 69d0446), which the registry sync copies
--     into model_registry.spec like every other static fact (spec ->> 'requires_adult').
--   * Today the signup checkbox records nothing on the server, and a Google OAuth signup never shows it: the database has no answer
--     for anyone, so nothing can refuse on it.
--
-- DIAGNOSIS: nothing in the quote or job path (quote_creative_job 0036, route_model 0075, create_creative_job 0174) knows a person's
--   age answer. A checkbox in a browser does not change that (CLAUDE.md rule 3: the browser never decides). The database has to
--   hold the answer and refuse, before anything is held (rule 6). 0174 is the precedent: an append-only record plus a gate.
--
-- CHANGE (additive; five function bodies replaced, each with marked 0199 hunks and nothing else changed):
--   adult_attestations   one row per person (user_id = auth.uid() as record_adult_attestation() read it): adult (true = confirmed
--     18 or older, false = said under 18), terms_version (the words they answered, ^[a-z0-9._-]{1,40}$), method (email_signup,
--     google, welcome, create), created_at. The FIRST answer stands: a trigger refuses UPDATE, DELETE and TRUNCATE for every role,
--     the owner included, and no API role (the service key included) inserts. A member reads only their own row (RLS).
--   record_adult_attestation(adult, terms_version, method)   the only write path (authenticated). NS401 not_signed_in without a
--     session; NS400 invalid_params for a null answer, a bad version or an unknown method. insert ... on conflict (user_id) do
--     nothing: a second call writes nothing and answers the stored row ({state, recorded: false, created_at}).
--   my_adult_attestation()   {state: adult | minor | none} for the session (authenticated).
--   model_requires_adult(spec), adult_attestation_state(user), adult_attestation_missing(user, model),
--     adult_attestation_gate(user, model), adult_attestations_append_only()   internal.
--   THE GATE (adult_attestation_gate): a person whose row says adult = false is refused EVERY model, NS400 'adult_only_service'
--     (Nightshift is for adults). A person without a row with adult = true is refused a model whose spec requires_adult is true,
--     NS400 'adult_attestation_required' (the remedy: confirm you are 18 or older in the app). Fails closed: a requires_adult of any
--     shape but true, false or null (a string, a number, an object) reads as true. A person with no row and a model without the
--     flag: unchanged.
--   quote_creative_job (0036's body, one marked hunk): the gate after the price (a model refused anyway never asks, as 0174).
--   create_creative_job (0174's body, one marked hunk): the gate after the price and BEFORE 0174's acknowledgement, the price
--     ceiling, the hold and the job row. An idempotent replay of a job already made is answered before it.
--   route_model (0075's body, four marked hunks): a minor is refused adult_only_service in every mode; a requires_adult model is
--     left out of the candidates for a person without an adult attestation (the route picks among the others; the stored
--     failover list never names it); only when nothing else is left is the route refused adult_attestation_required. It serves
--     quote_creative_route, the API's routed quote and a routed create_creative_job alike.
--   sellable_models (0125's body, one marked hunk): such a model is STILL listed; its public spec object carries
--     requires_adult: true so the app marks it "for adults only". No other column or key changes.
--   api_creative_refusal (0174's body, one marked hunk): adult_attestation_required (428, with the remedy) and adult_only_service
--     (403). There is no API call to attest: a key acts as its creator and an MCP grant as its person (api_act_as), so the person
--     is auth.uid() exactly as for 0174's acknowledgements, and attests in the app.
--
-- A DELETED ACCOUNT. As 0174's record: user_id has no foreign key to auth.users, so deleting an auth user neither cascades into
--   this table nor is blocked by it, and the row outlives the account (the append-only trigger would refuse a cascade anyway).
--   An auth user id is a fresh uuid, never reused, so a new account starts with no answer and is asked again.
--
-- WHICH PATHS ARE COVERED. Every creative_jobs row is written by create_creative_job (the Studio, the public API, the MCP server,
--   region edit, each workflow step); every member quote is quote_creative_job or quote_creative_route; the API's quotes call the
--   same two. NOT covered here: the Film Studio's own pricing and segments (0171 prices through creative_price and writes its own
--   jobs), and a workflow quote (workflow_quote_steps prices through creative_price; its steps are refused when they are created).
--
-- REPLACES (md5 drift guard: the earlier body, or this file's own on a replay; whitespace runs read as one space):
--   quote_creative_job (0036), route_model (0075), sellable_models (0125), create_creative_job and api_creative_refusal (0174);
--   none redefined since. Signatures, SECURITY DEFINER (or not), the pinned search_path and the grants stay as they were (restated).
-- NOT CHANGED: creative_price, creative_route_quote, quote_creative_route, reroute_creative_job, every price, hold and ledger rule,
--   every model's availability.
--
-- REPLAY. This file replays safely onto itself. 0174, 0125 and 0124 refuse to replay over it (their drift guards accept only their
--   own bodies), but 0036 and 0075 do NOT protect it: re-running either after this file SILENTLY puts the old quote_creative_job /
--   route_model (0075 also create_creative_job and api_creative_refusal) back and removes the gate. Undo 0199 first (its rollback),
--   re-run the older file, then apply 0199 again; after any manual replay run the Verify query below.
--
-- NUMBER. 0199 is a placeholder; it is renumbered at merge. Needs 0018, 0031, 0035, 0036, 0075, 0124, 0125 and 0174.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only):
--   select p.oid::regprocedure, md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc p
--    where p.oid in ('public.quote_creative_job(uuid, text, text, jsonb)'::regprocedure,
--                    'public.route_model(text, jsonb, text, uuid, text)'::regprocedure,
--                    'public.sellable_models(text, text)'::regprocedure,
--                    'public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)'::regprocedure,
--                    'public.api_creative_refusal(text, text, text)'::regprocedure);
--   expected BEFORE quote_creative_job 8494b320cece395444edec700a2f1696 (0036), route_model e4344e61983e7decb4b1eac73761fbf0 (0075),
--     sellable_models ea8add748052456a6ef8898b4c87d610 (0125), create_creative_job 88107b00b0a8c143606ed17f5898c98d (0174),
--     api_creative_refusal e6ec45d0d912389a05eb2d40261c2c2a (0174);
--   AFTER ce54b243814e7e8205e8f2c200f05adc, 446a8891a780d38237af38e46c24349a, baeea1418bed413cab7bcf7bf5113ecd,
--     5d373e69b2b33c9a461a245d46c0047f, 689a675e9ff2d1b6df46ccd89f351589 (this file).
-- Undo: docs/sql/rollback_0199_adult_attestation.sql (owner-applied). It puts the five earlier bodies back and drops the two calls
--   and the helpers. It KEEPS the record: adult_attestations (with its append-only triggers) stays, and applying 0199 again picks
--   it up as its own.

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  if to_regprocedure('public.is_org_member(uuid, text)') is null then
    raise exception '0199 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regclass('public.model_registry') is null then
    raise exception '0199 needs the model registry: apply 0035_model_registry.sql first';
  end if;
  if to_regprocedure('public.creative_refuse(text, text, text)') is null then
    raise exception '0199 needs the creative jobs: apply 0036_creative_jobs.sql first';
  end if;
  if to_regprocedure('public.model_past_shutdown(jsonb)') is null then
    raise exception '0199 needs 0125_model_shutdown.sql: apply it first';
  end if;
  if to_regprocedure('public.rights_acknowledgement_missing(uuid, uuid, text, jsonb)') is null then
    raise exception '0199 needs 0174_rights_acknowledgement.sql: apply it first';
  end if;
  -- The five bodies this file replaces: the earlier one, or this file's own (a replay).
  for r in select * from (values
      ('public.quote_creative_job(uuid, text, text, jsonb)', '8494b320cece395444edec700a2f1696', 'ce54b243814e7e8205e8f2c200f05adc', '0036'),
      ('public.route_model(text, jsonb, text, uuid, text)', 'e4344e61983e7decb4b1eac73761fbf0', '446a8891a780d38237af38e46c24349a', '0075'),
      ('public.sellable_models(text, text)', 'ea8add748052456a6ef8898b4c87d610', 'baeea1418bed413cab7bcf7bf5113ecd', '0125'),
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', '88107b00b0a8c143606ed17f5898c98d', '5d373e69b2b33c9a461a245d46c0047f', '0174'),
      ('public.api_creative_refusal(text, text, text)', 'e6ec45d0d912389a05eb2d40261c2c2a', '689a675e9ff2d1b6df46ccd89f351589', '0174')) v(sig, was, now_, src) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is null or h <> all (array[r.was, r.now_]) then
      raise exception '0199 found % with a body that is neither %''s nor 0199''s (md5 %): read the live body first', r.sig, r.src, h;
    end if;
  end loop;
  -- The table this file creates: absent, or this file's own.
  if to_regclass('public.adult_attestations') is not null
     and not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'adult_attestations' and column_name = 'method') then
    raise exception '0199 found a table public.adult_attestations that is not this file''s (no column method): read it first';
  end if;
  -- The functions this file creates: absent, or this file's own bodies (a replay).
  for r in select * from (values
      ('public.adult_attestations_append_only()', 'ce2c60277252f9a41df2a05a092ceca6'),
      ('public.model_requires_adult(jsonb)', 'a0ad0ce0fd931548e661a92e715203fc'),
      ('public.adult_attestation_state(uuid)', 'b7180d2d587a0c26eee1da4be501f2aa'),
      ('public.adult_attestation_missing(uuid, text)', 'beb6abf28866d73d9a25c491558c2a2f'),
      ('public.adult_attestation_gate(uuid, text)', '1d3164b00888ae30cb7d829678053389'),
      ('public.record_adult_attestation(boolean, text, text)', 'a6b1ed2e7bd0cd3703a3039229fb1bfc'),
      ('public.my_adult_attestation()', 'd7f73015d0aceca2a120220b36989b2d')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is not null and h <> r.want then
      raise exception '0199 found % with a body that is not this file''s (md5 %): read the live body first', r.sig, h;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The record (append-only, one row per person)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.adult_attestations (
  -- auth.uid() of the person, as record_adult_attestation() read it. No foreign key, as 0174's record: the answer outlives the
  -- account, and deleting an auth user is neither blocked by it nor cascades into it (header, A DELETED ACCOUNT).
  user_id       uuid primary key,
  -- true: confirmed 18 or older. false: said under 18, and then nothing is sold to them.
  adult         boolean not null,
  -- The version of the words they answered (command-center names it); bounded, so the record cannot carry free text.
  terms_version text not null,
  -- Where the question was answered.
  method        text not null,
  created_at    timestamptz not null default now(),
  constraint adult_attestations_terms_version_check check (terms_version ~ '^[a-z0-9._-]{1,40}$'),
  constraint adult_attestations_method_check check (method in ('email_signup', 'google', 'welcome', 'create'))
);

comment on table public.adult_attestations is
  'Who confirmed they are 18 or older, or said they are not, under which words and where (migration 0199). One row per person, the first answer; append-only; written only by record_adult_attestation(); each person reads only their own row.';

create or replace function public.adult_attestations_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'adult_attestations is append-only' using errcode = '42501';
end
$$;

drop trigger if exists adult_attestations_append_only on public.adult_attestations;
create trigger adult_attestations_append_only
  before update or delete on public.adult_attestations
  for each row execute function public.adult_attestations_append_only();

drop trigger if exists adult_attestations_no_truncate on public.adult_attestations;
create trigger adult_attestations_no_truncate
  before truncate on public.adult_attestations
  for each statement execute function public.adult_attestations_append_only();

alter table public.adult_attestations enable row level security;
revoke all on public.adult_attestations from public, anon, authenticated, service_role;
grant select on public.adult_attestations to authenticated, service_role;
drop policy if exists adult_attestations_select_own on public.adult_attestations;
create policy adult_attestations_select_own on public.adult_attestations
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The helpers (internal)
-- ───────────────────────────────────────────────────────────────────────────

-- Fails closed: true is true, false and null (or absent) are false, and anything else (a string "false", a number, an object)
-- reads as true. A value nobody can read is not a licence to sell to someone who never said they are an adult.
create or replace function public.model_requires_adult(p_spec jsonb) returns boolean
  language plpgsql immutable set search_path = public, pg_temp as $$
begin
  case coalesce(jsonb_typeof(p_spec -> 'requires_adult'), 'null')
    when 'null' then
      return false;
    when 'boolean' then
      return (p_spec -> 'requires_adult')::boolean;
    else
      return true;
  end case;
end
$$;

-- 'adult', 'minor' or 'none' (no row, or no person).
create or replace function public.adult_attestation_state(p_user uuid) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  a boolean;
begin
  if p_user is null then
    return 'none';
  end if;
  select adult into a from public.adult_attestations where user_id = p_user;
  if not found then
    return 'none';
  end if;
  return case when a then 'adult' else 'minor' end;
end
$$;

-- True when the model requires an adult and this person has no row with adult = true. An unknown model requires nothing here:
-- creative_price refuses it.
create or replace function public.adult_attestation_missing(p_user uuid, p_model text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  sp jsonb;
begin
  select r.spec into sp from public.model_registry r where r.id = lower(btrim(coalesce(p_model, '')));
  if not found or not public.model_requires_adult(sp) then
    return false;
  end if;
  return public.adult_attestation_state(p_user) <> 'adult';
end
$$;

-- The gate: raises, or returns nothing. adult_only_service first: a person who said they are under 18 is refused every model.
create or replace function public.adult_attestation_gate(p_user uuid, p_model text) returns void
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if public.adult_attestation_state(p_user) = 'minor' then
    perform public.creative_refuse('adult_only_service', 'this service is for adults (18 or older)');
  end if;
  if public.adult_attestation_missing(p_user, p_model) then
    perform public.creative_refuse('adult_attestation_required',
      format('model=%s is for adults only; confirm you are 18 or older in the app', lower(btrim(coalesce(p_model, '')))));
  end if;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The two calls the app makes
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.record_adult_attestation(p_adult boolean, p_terms_version text, p_method text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid  uuid := auth.uid();
  row_ public.adult_attestations;
  ins  boolean;
begin
  if uid is null then
    raise exception 'not_signed_in' using errcode = 'NS401', detail = 'sign in, then confirm your age';
  end if;
  if p_adult is null then
    perform public.creative_refuse('invalid_params', 'adult must be true or false');
  end if;
  if p_terms_version is null or p_terms_version !~ '^[a-z0-9._-]{1,40}$' then
    perform public.creative_refuse('invalid_params', 'terms_version: 1-40 characters of a-z 0-9 . _ -');
  end if;
  if p_method is null or p_method not in ('email_signup', 'google', 'welcome', 'create') then
    perform public.creative_refuse('invalid_params', 'method must be email_signup, google, welcome or create');
  end if;
  -- The first answer stands: a second call (another tab, a retry, a changed mind) writes nothing and is told what is stored.
  insert into public.adult_attestations (user_id, adult, terms_version, method)
  values (uid, p_adult, p_terms_version, p_method)
  on conflict (user_id) do nothing
  returning * into row_;
  ins := found;
  if not ins then
    select * into row_ from public.adult_attestations where user_id = uid;
  end if;
  return jsonb_build_object('state', case when row_.adult then 'adult' else 'minor' end,
                            'recorded', ins, 'created_at', row_.created_at);
end
$$;

create or replace function public.my_adult_attestation() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not_signed_in' using errcode = 'NS401', detail = 'sign in first';
  end if;
  return jsonb_build_object('state', public.adult_attestation_state(uid));
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The member quote: 0036's quote_creative_job, one marked hunk
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.quote_creative_job(
  p_org uuid, p_capability text, p_model text, p_params jsonb default '{}'::jsonb
) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  q   jsonb;
  acc public.credit_accounts;
begin
  if auth.uid() is null or not public.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  q := public.creative_price(p_org, p_capability, p_model, p_params);
  -- 0199: someone who said they are under 18 is refused every model (adult_only_service); a model whose vendor's terms are 18+
  -- (spec.requires_adult) is refused to anyone without an adult attestation (adult_attestation_required). After the price, as
  -- 0174 (a model refused anyway never asks), and the quote is raised, so the price is not shown either.
  perform public.adult_attestation_gate(auth.uid(), q ->> 'model');
  select * into acc from public.credit_accounts where org_id = p_org;
  return q || jsonb_build_object(
    'available', case when public.credits_exempt(p_org) then null
                      else coalesce(acc.balance - acc.reserved, 0) end);
end
$$;
revoke all on function public.quote_creative_job(uuid, text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.quote_creative_job(uuid, text, text, jsonb) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The router: 0075's route_model, four marked hunks (quote_creative_route, the API's routed quote, a routed job)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.route_model(
  p_capability text, p_params jsonb, p_mode text, p_org uuid, p_surface text default 'web'
) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  cap     text := lower(btrim(coalesce(p_capability, '')));
  md      text := lower(btrim(coalesce(p_mode, '')));
  surf    text := coalesce(p_surface, 'web');
  problem text;
  ids     text[];
  m       text;
  sp      jsonb;
  q       jsonb;
  c       numeric;
  cands   jsonb := '[]'::jsonb;
  ranked  jsonb;
  top     jsonb;
  reason  text;
  -- 0199: priced candidates left out because this person has no adult attestation.
  adult_skipped integer := 0;
begin
  if md not in ('auto', 'cheap', 'fast', 'quality') then
    perform public.creative_refuse('invalid_params', 'mode must be auto, cheap, fast or quality');
  end if;
  if surf not in ('web', 'api', 'mcp') then
    perform public.creative_refuse('invalid_params', 'unknown surface');
  end if;
  -- 0199: someone who said they are under 18 gets nothing, in any mode (the same word as an exact quote or job).
  if public.adult_attestation_state(auth.uid()) = 'minor' then
    perform public.creative_refuse('adult_only_service', 'this service is for adults (18 or older)');
  end if;
  -- What does not depend on the model, once, with creative_price's own
  -- refusals: a bad prompt or another organization's picture reads the same
  -- in every mode (and never as "no model").
  if cap !~ '^[a-z][a-z0-9_]{0,31}$' then
    perform public.creative_refuse('invalid_params', 'capability is required');
  end if;
  if not public.creative_capability_supported(cap) then
    perform public.creative_refuse('capability_not_supported',
      format('%s cannot be generated yet on this deployment', cap));
  end if;
  problem := public.creative_params_problem(cap, p_params);
  if problem is not null then
    perform public.creative_refuse('invalid_params', problem);
  end if;
  problem := public.creative_source_problem(p_org, cap, p_params);
  if problem is not null then
    perform public.creative_refuse('source_unavailable', problem);
  end if;
  problem := public.creative_style_problem(p_org, cap, p_params);
  if problem is not null then
    perform public.creative_refuse('style_unavailable', problem);
  end if;

  -- The models this surface sells for the capability (none: a capability
  -- sellable_models does not know yet).
  begin
    select array_agg(s.id order by s.id) into ids from public.sellable_models(cap, surf) s;
  exception when sqlstate '22023' then
    ids := null;
  end;
  foreach m in array coalesce(ids, '{}'::text[]) loop
    -- Priced for THESE params and THIS organization, or not a candidate.
    begin
      q := public.creative_price(p_org, cap, m, p_params);
    exception when sqlstate 'NS400' then
      continue;
    end;
    c := (q ->> 'credits')::numeric;
    if c is null or c <= 0 then
      continue;
    end if;
    -- 0199: a model whose vendor's terms are 18+ is not a candidate for a person without an adult attestation. The route picks
    -- among the others, and the failover list (stored from these candidates) never reaches it either.
    if public.adult_attestation_missing(auth.uid(), m) then
      adult_skipped := adult_skipped + 1;
      continue;
    end if;
    select r.spec into sp from public.model_registry r where r.id = m;
    cands := cands || jsonb_build_array(jsonb_build_object(
      'model', m, 'credits', c,
      'quality_tier', case when jsonb_typeof(sp -> 'quality_tier') = 'number'
                           then least(greatest((sp ->> 'quality_tier')::numeric, 0), 5) else 0 end,
      'speed_tier', case when jsonb_typeof(sp -> 'speed_tier') = 'number'
                         then least(greatest((sp ->> 'speed_tier')::numeric, 0), 5) else 0 end));
  end loop;
  -- 0199: nothing left but models that need an adult attestation: the remedy is the attestation, not another setting.
  if jsonb_array_length(cands) = 0 and adult_skipped > 0 then
    perform public.creative_refuse('adult_attestation_required',
      format('every model that can make this is for adults only (%s); confirm you are 18 or older in the app', adult_skipped));
  end if;
  if jsonb_array_length(cands) = 0 then
    perform public.creative_refuse('no_model_available',
      'no available, priced model can make this with these settings');
  end if;

  select jsonb_agg(x.e order by x.k1, x.k2, x.k3, x.k4, x.e ->> 'model') into ranked
    from (select e,
                 case md when 'cheap' then (e ->> 'credits')::numeric
                         when 'fast' then -(e ->> 'speed_tier')::numeric
                         when 'quality' then -(e ->> 'quality_tier')::numeric
                         else case when (e ->> 'quality_tier')::numeric >= 4 then 0 else 1 end end as k1,
                 case md when 'cheap' then -(e ->> 'quality_tier')::numeric
                         when 'fast' then (e ->> 'credits')::numeric
                         when 'quality' then (e ->> 'credits')::numeric
                         else case when (e ->> 'quality_tier')::numeric >= 4 then 0
                                   else -(e ->> 'quality_tier')::numeric end end as k2,
                 case md when 'cheap' then -(e ->> 'speed_tier')::numeric
                         when 'fast' then -(e ->> 'quality_tier')::numeric
                         when 'quality' then -(e ->> 'speed_tier')::numeric
                         else (e ->> 'credits')::numeric end as k3,
                 case md when 'auto' then -(e ->> 'speed_tier')::numeric else 0 end as k4
            from jsonb_array_elements(cands) e) x;
  top := ranked -> 0;
  reason := case when jsonb_array_length(ranked) = 1 then 'only_option'
                 when md = 'cheap' then 'cheapest'
                 when md = 'fast' then 'fastest'
                 when md = 'quality' then 'best_quality'
                 when (top ->> 'quality_tier')::numeric >= 4 then 'best_value'
                 else 'best_available' end;
  return jsonb_build_object(
    'model', top ->> 'model', 'credits', top -> 'credits', 'mode', md, 'reason', reason,
    'quality_tier', top -> 'quality_tier', 'speed_tier', top -> 'speed_tier', 'surface', surf,
    'considered', jsonb_array_length(ranked),
    -- The failover order: at most five, the pick first.
    'candidates', (select jsonb_agg(t.e order by t.n) from jsonb_array_elements(ranked) with ordinality t(e, n)
                    where t.n <= 5));
end
$$;
revoke all on function public.route_model(text, jsonb, text, uuid, text) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The job start path: 0174's create_creative_job, one marked hunk
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.create_creative_job(
  p_org uuid,
  p_capability text,
  p_model text,
  p_params jsonb default '{}'::jsonb,
  p_mode text default 'exact',
  p_idempotency_key text default null,
  p_max_credits numeric default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid   uuid := auth.uid();
  md    text := lower(btrim(coalesce(p_mode, 'exact')));
  idem  text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  hash_ text;
  prior public.creative_jobs;
  q     jsonb;
  price numeric;
  jid   uuid := gen_random_uuid();
  ref   text;
  res   jsonb;
  j     public.creative_jobs;
  jparams jsonb;
  -- 0075: the router's pick and the surface it was made for.
  surf  text;
  rt    jsonb;
  -- 0174: the first input this person has not acknowledged, for a model that requires an acknowledgement.
  ack   jsonb;
begin
  if uid is null or not public.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The exempt organization's generations are paid by the platform itself,
  -- and every account that existed before 0018 is a member of it: only a
  -- platform owner/admin may spend there (reserve_credits asks for its admins
  -- too, before answering exempt).
  if public.credits_exempt(p_org) and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501',
      detail = 'generations in the operator''s organization are started by a platform admin';
  end if;
  if md not in ('exact', 'auto', 'cheap', 'fast', 'quality') then
    perform public.creative_refuse('invalid_params', 'mode must be exact, auto, cheap, fast or quality');
  end if;
  -- Router modes need route_model() and failover, which are not built yet: a
  -- job only ever runs the model the person picked.
  -- 0075: they are built (route_model): this refusal now stands only for a
  -- database without the router.
  if md <> 'exact' and to_regprocedure('public.route_model(text, jsonb, text, uuid, text)') is null then
    perform public.creative_refuse('mode_not_supported',
      'only exact mode (the model you picked) is available on this deployment');
  end if;
  if idem is not null and idem !~ '^[A-Za-z0-9_:.-]{1,255}$' then
    perform public.creative_refuse('invalid_idempotency_key',
      'idempotency key: 1-255 characters of A-Z a-z 0-9 _ : . -');
  end if;

  -- The org's credit account, locked for the rest of this transaction: every
  -- create (and reserve_credits itself) for this org queues behind it, so two
  -- concurrent creates cannot both spend the same available credits, and a
  -- replay of the same idempotency key finds the first one's committed row.
  perform public.credit_account_lock(p_org);

  hash_ := md5(jsonb_build_object('capability', lower(btrim(coalesce(p_capability, ''))),
                                  'model', lower(btrim(coalesce(p_model, ''))),
                                  'mode', md, 'params', coalesce(p_params, 'null'::jsonb))::text);
  if idem is not null then
    select * into prior from public.creative_jobs
     where org_id = p_org and idempotency_key = idem;
    if found then
      if prior.request_hash is distinct from hash_ then
        perform public.creative_refuse('idempotency_conflict',
          'this idempotency key was used for a different request', 'NS409');
      end if;
      return jsonb_build_object('job', public.creative_job_json(prior), 'replay', true);
    end if;
  end if;

  -- Holds of this org's jobs that nobody will run give their credits back
  -- before this one is checked against the balance.
  perform public.creative_expire_locked(p_org);

  -- 0075: a routed job (auto / cheap / fast / quality) runs the model its quote
  -- named, at the price it showed, and nothing else. Both come back with the
  -- press; the router is asked again here, under the account lock, and a
  -- different pick (a price, a probe or a plan changed since the quote) is
  -- refused for a new quote, never run in its place. The surface is the web
  -- unless api_creative_create said otherwise for this transaction (it can
  -- only narrow the list: the API sells a subset of the web's models).
  if md <> 'exact' then
    if nullif(btrim(coalesce(p_model, '')), '') is null or p_max_credits is null then
      perform public.creative_refuse('invalid_params',
        'a routed job names the model and the price its quote showed: quote first, then confirm both');
    end if;
    surf := coalesce(nullif(current_setting('nightshift.creative_surface', true), ''), 'web');
    if surf not in ('web', 'api', 'mcp') then
      surf := 'web';
    end if;
    rt := public.route_model(p_capability, p_params, md, p_org, surf);
    if (rt ->> 'model') is distinct from lower(btrim(p_model)) then
      perform public.creative_refuse('route_changed',
        'the automatic choice changed since the quote; quote again and confirm the new choice', 'NS409');
    end if;
  end if;

  q := public.creative_price(p_org, p_capability, p_model, p_params);
  price := (q ->> 'credits')::numeric;
  -- 0199: after the price and before 0174's acknowledgement, the ceiling, the hold and the job row: a person who said they are
  -- under 18 is refused every model (adult_only_service), and a requires_adult model is refused to a person without an adult
  -- attestation (adult_attestation_required). The person is auth.uid(): the session, or the key's / grant's person for the API
  -- and MCP (api_act_as). A replay of a job already created was answered above; a routed pick was made without such a model.
  perform public.adult_attestation_gate(uid, q ->> 'model');
  -- 0174: a model whose provider (or the law) makes the person confirm their rights to an input refuses here: after the
  -- price (a model refused anyway never asks) and before the ceiling, the hold and the job row, unless THIS person
  -- acknowledged THIS input in THIS organization at the CURRENT text version (rights_acknowledgement_missing). A replay of
  -- a job already created was answered above.
  ack := public.rights_acknowledgement_missing(p_org, uid, q ->> 'model', p_params);
  if ack is not null then
    perform public.creative_refuse('acknowledgement_required',
      format('kind=%s version=%s subject=%s', ack ->> 'kind', coalesce(ack ->> 'text_version', 'none'), ack ->> 'subject'));
  end if;
  if p_max_credits is not null and price > p_max_credits then
    perform public.creative_refuse('price_changed',
      format('price=%s confirmed=%s', price, p_max_credits), 'NS409');
  end if;

  -- The tier the quote priced is the tier the job carries (0060): stored in
  -- the job's params so the worker sends EXACTLY it and never a default of its
  -- own. Absent from the request = the quote's default, written down here.
  jparams := p_params;
  if q ? 'quality' then
    jparams := coalesce(p_params, '{}'::jsonb) || jsonb_build_object('quality', q ->> 'quality');
  end if;
  -- Likewise the resolution and soundtrack of a video (0070): written down as
  -- priced, so the worker sends exactly them and never a default of its own.
  if q ? 'resolution' then
    jparams := coalesce(jparams, '{}'::jsonb) || jsonb_build_object('resolution', q ->> 'resolution');
  end if;
  if q ? 'audio' then
    jparams := coalesce(jparams, '{}'::jsonb) || jsonb_build_object('audio', (q ->> 'audio')::boolean);
  end if;

  ref := 'cj:' || jid::text;
  if price > 0 then
    -- NS402 'insufficient credits' (available=… needed=…) comes from here.
    res := public.creative_platform_reserve(p_org, ref, price);
    if coalesce((res ->> 'exempt')::boolean, false) then
      ref := null;
    end if;
  else
    ref := null;
  end if;

  insert into public.creative_jobs
    (id, org_id, kind, capability, mode, requested_model, routed_model, params, status,
     payer, credit_ref, credit_unit, quantity, quoted_credits, idempotency_key, request_hash,
     requested_by, expires_at)
  values
    (jid, p_org, 'generate', q ->> 'capability', md, q ->> 'model', q ->> 'model',
     jparams, 'queued', 'credits', ref, q ->> 'unit', (q ->> 'quantity')::numeric, price,
     idem, hash_, uid, now() + interval '2 hours')
  returning * into j;
  -- 0075: what the router decided, written by this function only. The
  -- hold is the pick's price, like exact (BR-L-020): max_credits only
  -- refused a higher one. Members read the reason; the candidates are
  -- the platform's (creative_job_routes, BR-L-022).
  if md <> 'exact' then
    update public.creative_jobs
       set routed_credits = price,
           routing = jsonb_build_object('reason', rt ->> 'reason', 'surface', surf)
     where id = jid
    returning * into j;
    insert into public.creative_job_routes (job_id, quality_tier, candidates, tried)
    values (jid, coalesce((rt ->> 'quality_tier')::numeric, 0), coalesce(rt -> 'candidates', '[]'::jsonb),
            jsonb_build_array(rt ->> 'model'));
    perform public.creative_job_log(jid, p_org, 'routed', 'queued',
      jsonb_build_object('mode', md, 'model', rt ->> 'model', 'reason', rt ->> 'reason',
                         'credits', price));
  end if;
  perform public.creative_job_log(jid, p_org, 'created', 'queued',
    jsonb_build_object('quoted_credits', price, 'held', ref is not null));

  return jsonb_build_object('job', public.creative_job_json(j), 'replay', false);
end
$$;
revoke all on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) from public, anon, authenticated, service_role;
grant execute on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. The list: 0125's sellable_models, one marked hunk (the model stays listed, marked)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.sellable_models(p_capability text default null, p_surface text default 'web')
  returns table (
    id text, display_name text, provider text, capabilities text[], availability text,
    verified_at timestamptz, credit_unit text, entitlement text,
    credits_per_unit numeric, margin numeric, spec jsonb)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_surface is null or p_surface not in ('web', 'api', 'mcp') then
    raise exception 'unknown surface %', p_surface using errcode = '22023';
  end if;
  if p_capability is not null
     and p_capability not in ('t2i', 'edit', 't2v', 'i2v', 'tts', 'sfx', 'upscale', 'remove_bg',
                              'voice_change', 'dub', 'video_upscale', 'describe', 'captions',
                              'expand', 'relight', 'erase', 'video_edit', 'video_reframe', 'video_remove_bg') then
    raise exception 'unknown capability %', p_capability using errcode = '22023';
  end if;
  -- Captions are a web tool (0072): the transcript lives in caption_tracks,
  -- which only a signed-in member's session can read. Sold through the API or
  -- MCP (api_creative_model_ok asks this function for 'api'), a key could pay
  -- for a job whose result it can never fetch. No other surface lists them,
  -- whatever the registry says.
  if p_capability = 'captions' and p_surface <> 'web' then
    return;
  end if;
  return query
    select m.id, m.display_name, m.provider, m.capabilities, m.availability, m.verified_at,
           -- 0084: the rate as charged (margin folded in) and never the margin
           -- itself. The column stays (NULL) so the return type, and every
           -- earlier migration's create-or-replace on a replay, is unchanged.
           m.credit_unit, m.entitlement, cp.credits_per_unit * (1 + cp.margin), null::numeric,
           -- The public half of spec: what a person choosing a model needs.
           -- Never provider costs, evidence, notes, the probe or the vendor id.
           jsonb_strip_nulls(jsonb_build_object(
             'output', m.spec -> 'output', 'inputs', m.spec -> 'inputs',
             'aspect_ratios', m.spec -> 'aspect_ratios',
             'aspect_ratios_by_capability', m.spec -> 'aspect_ratios_by_capability',
             'image_sizes', m.spec -> 'image_sizes', 'resolutions', m.spec -> 'resolutions',
             'durations_s', m.spec -> 'durations_s', 'audio_out', m.spec -> 'audio_out',
             'upscale_factors', m.spec -> 'upscale_factors', 'languages', m.spec -> 'languages',
             'upscale_targets', m.spec -> 'upscale_targets', 'end_frame', m.spec -> 'end_frame',
             'async', m.spec -> 'async', 'unit', m.spec -> 'pricing' -> 'unit',
             'qualities', m.spec -> 'qualities',
             'relight_looks', m.spec -> 'relight_looks',
             'default_resolution', m.spec -> 'default_resolution',
             'price_variants_by', m.spec -> 'pricing' -> 'variants' -> 'by',
             'attribution', m.spec -> 'attribution', 'api_exposure', m.spec -> 'api_exposure',
             -- 0199: the vendor's terms are 18+: still listed (never hidden), and the app marks it "for adults only".
             'requires_adult', case when public.model_requires_adult(m.spec) then true end,
             'limits', m.spec -> 'limits', 'quality_tier', m.spec -> 'quality_tier',
             'speed_tier', m.spec -> 'speed_tier'))
      from public.model_registry m
      join public.credit_prices cp on cp.unit = m.credit_unit
     where m.availability in ('beta', 'ga')
       and m.verified_at is not null
       and m.verified_probe_id is not null
       and coalesce(m.spec ->> 'terms_gate', '') = ''
       and cp.credits_per_unit > 0
       -- 0124: the owner's switch (model_is_available is TRUE for every model until it is put in force).
       and public.model_is_available(m.id)
       -- 0125: a shutdown date the vendor announced (spec.shutdown.on) that has come ends the sale.
       and not public.model_past_shutdown(m.spec)
       -- A model sold by quality is shown only when at least one of its tiers
       -- has a price: a tier without a row is unpriced, never free.
       and (m.spec -> 'pricing' -> 'variants' ->> 'by' is distinct from 'quality'
            or exists (select 1
                         from jsonb_array_elements_text(coalesce(m.spec -> 'qualities', '[]'::jsonb)) as tiers(tier)
                         join public.credit_prices qp on qp.unit = m.credit_unit || '_' || tiers.tier
                        where qp.credits_per_unit > 0))
       -- Likewise a model sold by soundtrack, or by a resolution it pins (0070):
       -- shown only while one of its variants has a price (never free).
       and (not (coalesce(m.spec -> 'pricing' -> 'variants' ->> 'by', '') in ('audio', 'resolution_audio')
                 or (coalesce(m.spec -> 'pricing' -> 'variants' ->> 'by', '') = 'resolution'
                     and nullif(m.spec ->> 'default_resolution', '') is not null))
            or exists (select 1
                         from jsonb_object_keys(coalesce(m.spec -> 'pricing' -> 'variants' -> 'prices', '{}'::jsonb)) as vk(variant)
                         join public.credit_prices vp
                           on vp.unit = m.credit_unit || '_' || regexp_replace(lower(vk.variant), '[^a-z0-9]', '_', 'g')
                        where vp.credits_per_unit > 0))
       and (p_capability is null or p_capability = any (m.capabilities))
       and (p_surface = 'web' or coalesce(m.spec ->> 'api_exposure', 'any') <> 'web_only')
       and (p_surface = 'web' or not ('captions' = any (m.capabilities)))
     order by m.provider, m.id;
end
$$;
revoke all on function public.sellable_models(text, text) from public, anon;
grant execute on function public.sellable_models(text, text) to authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. The public API's answer: 0174's api_creative_refusal, one marked hunk
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.api_creative_refusal(p_state text, p_msg text, p_detail text)
  returns jsonb
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  word text := btrim(coalesce(p_msg, ''));
  det  text := left(coalesce(p_detail, ''), 300);
  m    text[];
  extra jsonb := case when det <> '' and det <> word then jsonb_build_object('detail', det) else '{}'::jsonb end;
begin
  case p_state
    when '42501' then
      return public.api_err(403, 'forbidden', 'This key may not start generations in this organization.');
    when 'P0002' then
      return public.api_err(404, 'job_not_found', 'No generation with that id for this key.');
    when '22023' then
      return public.api_err(400, 'invalid_params', 'The request has a parameter this API does not accept.');
    when 'NS402' then
      m := regexp_match(coalesce(p_detail, ''), 'available=(-?[0-9.]+)\s+needed=([0-9.]+)');
      return public.api_err(402, 'insufficient_credits',
        'The organization does not have enough credits for this generation. Nothing was held.',
        case when m is null then '{}'::jsonb
             else jsonb_build_object('available_credits', m[1]::numeric, 'needed_credits', m[2]::numeric) end);
    when 'NS429' then
      m := regexp_match(coalesce(p_detail, ''), 'active=([0-9]+)\s+limit=([0-9]+)');
      return public.api_err(429, 'run_limit_reached',
        'All of the plan''s parallel runs are in use. Wait for one to finish.',
        jsonb_build_object('retry_after', 60) || case when m is null then '{}'::jsonb
             else jsonb_build_object('active', m[1]::int, 'limit', m[2]::int) end);
    when 'NS409' then
      if word = 'price_changed' then
        return public.api_err(409, 'price_changed',
          'The price is now above max_credits. Quote again and confirm the new price.', extra);
      elsif word = 'idempotency_conflict' then
        return public.api_err(422, 'idempotency_key_reused',
          'This Idempotency-Key was already used for a different generation.');
      -- 0075: the router's pick changed since the quote.
      elsif word = 'route_changed' then
        return public.api_err(409, 'route_changed',
          'The automatic choice changed since the quote. Quote again and confirm the new choice.', extra);
      end if;
    when 'NS400' then
      return case word
        when 'registry_missing' then public.api_err(503, 'registry_missing', 'The model registry is not set up on this deployment.')
        when 'model_not_sellable' then public.api_err(422, 'model_not_sellable', 'That model is not available for this capability through the API.', extra)
        when 'entitlement_required' then public.api_err(403, 'entitlement_required', 'The organization''s plan does not include this model.', extra)
        when 'unpriced' then public.api_err(422, 'unpriced', 'That model has no price yet, so it cannot be sold.')
        when 'capability_not_supported' then public.api_err(422, 'capability_not_supported', 'That capability cannot be generated on this deployment.', extra)
        when 'source_unavailable' then public.api_err(422, 'source_unavailable', 'A media-library file in the request is not available to this organization.', extra)
        -- 0174: the model needs the person to confirm their rights to an input file; the API has no call for that.
        when 'acknowledgement_required' then public.api_err(428, 'acknowledgement_required', 'This model needs a person to confirm, in the Studio, their rights to the input file (for example the consent of every person shown). Confirm it there, then retry. Nothing was held or charged.', extra)
        -- 0199: the model's vendor's terms are 18+ and the key's person has not confirmed their age (in the app; the API has no call
        -- for it), or that person said they are under 18 (nothing is sold to them).
        when 'adult_attestation_required' then public.api_err(428, 'adult_attestation_required', 'This model is for adults only: its provider''s terms require users to be 18 or older. Confirm you are 18 or older in the app, then retry. Nothing was held or charged.', extra)
        when 'adult_only_service' then public.api_err(403, 'adult_only_service', 'Nightshift is for adults (18 or older). Nothing was held or charged.')
        when 'style_unavailable' then public.api_err(422, 'style_unavailable', 'The style kit in the request is not available to this organization.')
        when 'mode_not_supported' then public.api_err(422, 'mode_not_supported', 'Only mode "exact" (the model you named) is available.')
        -- 0075: no available, priced model of this plan takes these settings.
        when 'no_model_available' then public.api_err(422, 'no_model_available', 'No available, priced model can make this with these settings.', extra)
        -- 0124: the owner switched this model off for now. Nothing was held or charged; the caller chooses another or waits.
        when 'model_temporarily_off' then public.api_err(503, 'model_temporarily_off', 'That model is temporarily unavailable. Nothing was held or charged. Choose another model, or try again later.', extra)
        when 'invalid_idempotency_key' then public.api_err(400, 'invalid_idempotency_key', 'Idempotency-Key: 1-255 characters of A-Z a-z 0-9 _ : . -')
        else public.api_err(400, 'invalid_params', 'The request has a parameter this API does not accept.', extra)
      end;
    else
      null;
  end case;
  return public.api_err(500, 'internal_error',
    'The request failed inside the database. Nothing was created or charged; retry with backoff.');
end
$$;
revoke all on function public.api_creative_refusal(text, text, text) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 9. Privileges
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.adult_attestations_append_only() from public, anon, authenticated, service_role;
revoke all on function public.model_requires_adult(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.adult_attestation_state(uuid) from public, anon, authenticated, service_role;
revoke all on function public.adult_attestation_missing(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.adult_attestation_gate(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.record_adult_attestation(boolean, text, text) from public, anon, authenticated, service_role;
revoke all on function public.my_adult_attestation() from public, anon, authenticated, service_role;
grant execute on function public.record_adult_attestation(boolean, text, text) to authenticated;
grant execute on function public.my_adult_attestation() to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 10. End state (refuses the whole transaction if any of it is not so)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  r record;
begin
  for r in select * from (values
      ('public.quote_creative_job(uuid, text, text, jsonb)', 'ce54b243814e7e8205e8f2c200f05adc'),
      ('public.route_model(text, jsonb, text, uuid, text)', '446a8891a780d38237af38e46c24349a'),
      ('public.sellable_models(text, text)', 'baeea1418bed413cab7bcf7bf5113ecd'),
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', '5d373e69b2b33c9a461a245d46c0047f'),
      ('public.api_creative_refusal(text, text, text)', '689a675e9ff2d1b6df46ccd89f351589')) v(sig, want) loop
    if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(r.sig)) is distinct from r.want then
      raise exception '0199 end state: % is not 0199''s body', r.sig;
    end if;
  end loop;
  -- (signature, authenticated may execute, service_role may execute)
  for r in select * from (values
      ('public.quote_creative_job(uuid, text, text, jsonb)', true, false),
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', true, false),
      ('public.sellable_models(text, text)', true, true),
      ('public.record_adult_attestation(boolean, text, text)', true, false),
      ('public.my_adult_attestation()', true, false),
      ('public.route_model(text, jsonb, text, uuid, text)', false, false),
      ('public.adult_attestation_state(uuid)', false, false),
      ('public.adult_attestation_missing(uuid, text)', false, false),
      ('public.adult_attestation_gate(uuid, text)', false, false)) v(sig, member, svc) loop
    if exists (select 1 from pg_proc p where p.oid = to_regprocedure(r.sig)
                and (not p.prosecdef or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                     or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp')))
       or to_regprocedure(r.sig) is null
       or has_function_privilege('anon', r.sig, 'EXECUTE')
       or has_function_privilege('service_role', r.sig, 'EXECUTE') is distinct from r.svc
       or has_function_privilege('authenticated', r.sig, 'EXECUTE') is distinct from r.member then
      raise exception '0199 end state: % is not a SECURITY DEFINER with the pinned search_path and the intended grants', r.sig;
    end if;
  end loop;
  for r in select * from unnest(array['public.api_creative_refusal(text, text, text)', 'public.model_requires_adult(jsonb)']) sig,
                         unnest(array['anon', 'authenticated', 'service_role']) role_ loop
    if has_function_privilege(r.role_, r.sig, 'EXECUTE') then
      raise exception '0199 end state: % may call %', r.role_, r.sig;
    end if;
  end loop;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.adult_attestations'::regclass) then
    raise exception '0199 end state: row level security is off on adult_attestations';
  end if;
  for r in select * from unnest(array['anon', 'authenticated', 'service_role']) role_,
                         unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) priv loop
    if has_table_privilege(r.role_, 'public.adult_attestations', r.priv) then
      raise exception '0199 end state: % may % on adult_attestations (only record_adult_attestation writes)', r.role_, r.priv;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.adult_attestations', 'SELECT') then
    raise exception '0199 end state: anon may read adult_attestations';
  end if;
  if (select count(*) from pg_trigger where tgrelid = 'public.adult_attestations'::regclass
        and tgname in ('adult_attestations_append_only', 'adult_attestations_no_truncate') and not tgisinternal) <> 2 then
    raise exception '0199 end state: an append-only trigger of adult_attestations is missing';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying, AND after any manual replay of 0036 or 0075; every column should read true). A false gate column
-- means an older file was re-run over this one and the adult gate is gone there: apply 0199 again (see REPLAY above).
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.quote_creative_job(uuid,text,text,jsonb)'::regprocedure) = 'ce54b243814e7e8205e8f2c200f05adc'                     as quote_gate,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.route_model(text,jsonb,text,uuid,text)'::regprocedure) = '446a8891a780d38237af38e46c24349a'                        as route_gate,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.sellable_models(text,text)'::regprocedure) = 'baeea1418bed413cab7bcf7bf5113ecd'                                  as listed_for_adults,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.create_creative_job(uuid,text,text,jsonb,text,text,numeric)'::regprocedure) = '5d373e69b2b33c9a461a245d46c0047f' as job_gate,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.api_creative_refusal(text,text,text)'::regprocedure) = '689a675e9ff2d1b6df46ccd89f351589'                     as api_answer,
--   (select count(*) = 2 from pg_trigger where tgrelid = 'public.adult_attestations'::regclass
--     and tgname in ('adult_attestations_append_only', 'adult_attestations_no_truncate'))                                 as append_only,
--   not has_table_privilege('service_role', 'public.adult_attestations', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.adult_attestations', 'UPDATE')
--     and not has_table_privilege('anon', 'public.adult_attestations', 'SELECT')                                          as grants,
--   has_function_privilege('authenticated', 'public.record_adult_attestation(boolean,text,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.record_adult_attestation(boolean,text,text)', 'EXECUTE')             as rpc_grants;
