-- 0035_model_registry.sql — the model registry: which generative models exist,
-- and which of them may be sold (docs/CREATIVE_OS_PLAN.md §3.2, §4).
--
-- The static facts about a model (capabilities, adapter, vendor model id,
-- resolutions, prices' sources, terms) live in git, in
-- schemas/model_registry.json, where they are reviewed. This file adds the
-- database half: availability, and proof that the model actually works.
--
-- WHAT IT ADDS
--   model_registry     one row per model, synced from the JSON by
--                      tools/probe_models.py --sync (service role). Columns the
--                      file owns: display_name, provider, adapter, capabilities,
--                      credit_unit (a credit_prices unit, 0020), entitlement
--                      (the plan entitlement a model needs, e.g.
--                      'models_video:premium' — plain text, the 0034 catalog is
--                      on another branch), spec (everything else). Columns the
--                      DATABASE owns: availability, verified_at, verified_by,
--                      verified_probe_id.
--   model_probe_runs   append-only log of every probe call: which model,
--                      adapter and vendor model were called, whether it worked
--                      and the typed error code if not. Written only by the
--                      probe tool (service role, record_model_probe).
--
-- THE RULE: A MODEL IS SOLD ONLY AFTER A REAL CALL WORKED (CLAUDE.md #5)
--   * availability in ('beta','ga') requires verified_at — a CHECK, so no path
--     (admin, service key, a future function) can skip it;
--   * verified_at is not a value anyone types: it is copied from a successful
--     model_probe_runs row for the same model, adapter and vendor model
--     (trigger), and only the service role writes probe rows;
--   * when the file changes what is called (adapter, vendor model,
--     capabilities), the proof no longer applies: verification is cleared and
--     a beta/ga model drops back to hidden (trigger);
--   * a model whose vendor terms are not yet satisfied (spec.terms_gate: Luma's
--     written consent, ElevenLabs' Scale plan, …) cannot be beta/ga (CHECK);
--   * sellable_models() additionally requires a credit_prices row with a
--     positive price for the model's credit_unit — an unpriced model is never
--     free (rule #5), it is not for sale.
--
-- WHO SEES WHAT
--   anon                nothing (no grant).
--   signed-in users     rows that are beta/ga AND verified, and only the
--                       public columns (not spec: it carries provider USD
--                       costs and internal notes — economics are platform-only).
--                       sellable_models() returns the public part of spec.
--   platform admin      every row, full spec, through model_registry_admin();
--                       may change availability, display_name, credit_unit and
--                       entitlement (column grants + RLS). Never spec or
--                       verification: those come from the reviewed file and
--                       from real probes.
--   service role        sync_model_registry(), record_model_probe().
--
-- Additive and idempotent: safe to run twice.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.model_registry (
  id                 text primary key,
  display_name       text not null,
  provider           text not null,
  adapter            text not null,
  capabilities       text[] not null,
  spec               jsonb not null default '{}'::jsonb,
  availability       text not null default 'hidden',
  verified_at        timestamptz,
  verified_by        text,
  verified_probe_id  bigint,
  credit_unit        text,
  entitlement        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.model_registry is
  'Generative models (migration 0035). Static facts are synced from schemas/model_registry.json; availability beta/ga requires verified_at, which only a successful model_probe_runs row can set.';

alter table public.model_registry drop constraint if exists model_registry_id_check;
alter table public.model_registry add constraint model_registry_id_check
  check (id ~ '^[a-z0-9][a-z0-9.-]{1,39}$');
alter table public.model_registry drop constraint if exists model_registry_provider_check;
alter table public.model_registry add constraint model_registry_provider_check
  check (provider ~ '^[a-z0-9-]{2,32}$');
alter table public.model_registry drop constraint if exists model_registry_display_name_check;
alter table public.model_registry add constraint model_registry_display_name_check
  check (length(display_name) between 1 and 80);
alter table public.model_registry drop constraint if exists model_registry_adapter_check;
alter table public.model_registry add constraint model_registry_adapter_check
  check (adapter ~ '^(image|video|audio)\.[a-z0-9_]+$');
alter table public.model_registry drop constraint if exists model_registry_capabilities_check;
alter table public.model_registry add constraint model_registry_capabilities_check
  check (cardinality(capabilities) between 1 and 6
         and capabilities <@ array['t2i','edit','t2v','i2v','tts','sfx']::text[]);
alter table public.model_registry drop constraint if exists model_registry_spec_check;
alter table public.model_registry add constraint model_registry_spec_check
  check (jsonb_typeof(spec) = 'object' and pg_column_size(spec) <= 32768);
alter table public.model_registry drop constraint if exists model_registry_availability_check;
alter table public.model_registry add constraint model_registry_availability_check
  check (availability in ('hidden', 'beta', 'ga', 'disabled'));
-- The same shape credit_prices.unit accepts (0020), so a unit can be priced.
alter table public.model_registry drop constraint if exists model_registry_credit_unit_check;
alter table public.model_registry add constraint model_registry_credit_unit_check
  check (credit_unit is null or credit_unit ~ '^[a-z][a-z0-9_]{0,62}$');
alter table public.model_registry drop constraint if exists model_registry_entitlement_check;
alter table public.model_registry add constraint model_registry_entitlement_check
  check (entitlement is null or entitlement ~ '^[a-z][a-z0-9_]{1,40}(:[a-z0-9_]{1,20})?$');
alter table public.model_registry drop constraint if exists model_registry_verified_by_check;
alter table public.model_registry add constraint model_registry_verified_by_check
  check (verified_by is null or length(verified_by) between 1 and 120);
-- Verified means both: when, and which probe proved it.
alter table public.model_registry drop constraint if exists model_registry_verified_pair;
alter table public.model_registry add constraint model_registry_verified_pair
  check ((verified_at is null) = (verified_probe_id is null));
-- THE rule: nothing is offered before a real call has worked.
alter table public.model_registry drop constraint if exists model_registry_verified_before_sale;
alter table public.model_registry add constraint model_registry_verified_before_sale
  check (availability not in ('beta', 'ga') or verified_at is not null);
-- Vendor terms first: a gated model cannot be offered at all.
alter table public.model_registry drop constraint if exists model_registry_terms_before_sale;
alter table public.model_registry add constraint model_registry_terms_before_sale
  check (availability not in ('beta', 'ga') or coalesce(spec ->> 'terms_gate', '') = '');
alter table public.model_registry drop constraint if exists model_registry_unit_before_sale;
alter table public.model_registry add constraint model_registry_unit_before_sale
  check (availability not in ('beta', 'ga') or credit_unit is not null);

create table if not exists public.model_probe_runs (
  id            bigint generated always as identity primary key,
  model_id      text not null references public.model_registry (id) on delete restrict,
  adapter       text not null,
  vendor_model  text not null,
  capability    text not null,
  ok            boolean not null,
  error_code    text,
  error         text,
  latency_ms    integer,
  output_bytes  bigint,
  probed_by     text not null,
  created_at    timestamptz not null default now()
);

comment on table public.model_probe_runs is
  'Append-only log of real probe calls (migration 0035), written by tools/probe_models.py with the service role. A successful row is the only thing that can make a model verified.';

alter table public.model_probe_runs drop constraint if exists model_probe_runs_capability_check;
alter table public.model_probe_runs add constraint model_probe_runs_capability_check
  check (capability in ('t2i', 'edit', 't2v', 'i2v', 'tts', 'sfx'));
alter table public.model_probe_runs drop constraint if exists model_probe_runs_vendor_model_check;
alter table public.model_probe_runs add constraint model_probe_runs_vendor_model_check
  check (vendor_model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and adapter ~ '^(image|video|audio)\.[a-z0-9_]+$');
-- The capability layer's typed codes (modules/capabilities/base.py ERROR_CODES).
alter table public.model_probe_runs drop constraint if exists model_probe_runs_error_code_check;
alter table public.model_probe_runs add constraint model_probe_runs_error_code_check
  check ((ok and error_code is null and error is null)
         or (not ok and error_code in ('not_configured', 'auth', 'quota', 'rate_limited', 'bad_request',
                                       'policy', 'not_found', 'unavailable', 'bad_response', 'timeout')));
alter table public.model_probe_runs drop constraint if exists model_probe_runs_sizes_check;
alter table public.model_probe_runs add constraint model_probe_runs_sizes_check
  check ((error is null or length(error) <= 500)
         and (latency_ms is null or latency_ms >= 0)
         and (output_bytes is null or output_bytes >= 0)
         and length(probed_by) between 1 and 120);

create index if not exists model_probe_runs_model_idx on public.model_probe_runs (model_id, created_at desc);

-- Tables reference each other: the proof must be a real probe row.
alter table public.model_registry drop constraint if exists model_registry_verified_probe_fk;
alter table public.model_registry add constraint model_registry_verified_probe_fk
  foreign key (verified_probe_id) references public.model_probe_runs (id) on delete restrict;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Triggers: verification is earned, and lost when the model changes
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.model_registry_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.model_probe_runs;
begin
  new.updated_at := now();
  -- What is called changed → the old probe proves nothing about the new call.
  if tg_op = 'UPDATE' and (new.adapter is distinct from old.adapter
      or new.capabilities is distinct from old.capabilities
      or new.spec -> 'vendor_model' is distinct from old.spec -> 'vendor_model'
      or new.spec -> 'vendor_model_by_capability' is distinct from old.spec -> 'vendor_model_by_capability') then
    if new.verified_probe_id is not distinct from old.verified_probe_id then
      new.verified_at := null;
      new.verified_by := null;
      new.verified_probe_id := null;
      if new.availability in ('beta', 'ga') then
        new.availability := 'hidden';
      end if;
    end if;
  end if;
  -- A (new) proof must be a successful probe of THIS model as it is now.
  if new.verified_probe_id is not null
     and (tg_op = 'INSERT' or new.verified_probe_id is distinct from old.verified_probe_id
          or new.verified_at is distinct from old.verified_at) then
    select * into p from public.model_probe_runs where id = new.verified_probe_id;
    if not found or not p.ok or p.model_id <> new.id or p.adapter <> new.adapter
       or not (p.vendor_model = new.spec ->> 'vendor_model'
               or p.vendor_model in (select jsonb_each_text.value
                                       from jsonb_each_text(coalesce(new.spec -> 'vendor_model_by_capability', '{}'::jsonb)))) then
      raise exception 'model %: verified_probe_id must be a successful probe of this model, adapter and vendor model', new.id
        using errcode = '23514';
    end if;
    new.verified_at := p.created_at;
  end if;
  if new.verified_probe_id is null and new.verified_at is not null then
    raise exception 'model %: verified_at is set only from a probe run', new.id using errcode = '23514';
  end if;
  return new;
end
$$;

drop trigger if exists model_registry_guard on public.model_registry;
create trigger model_registry_guard before insert or update on public.model_registry
  for each row execute function public.model_registry_guard();

create or replace function public.model_probe_runs_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'model_probe_runs is append-only' using errcode = '42501';
end
$$;

drop trigger if exists model_probe_runs_append_only on public.model_probe_runs;
create trigger model_probe_runs_append_only before update or delete on public.model_probe_runs
  for each row execute function public.model_probe_runs_append_only();

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Functions
-- ───────────────────────────────────────────────────────────────────────────

-- What a signed-in user may be offered. p_surface is where the offer is made:
-- 'web' (the Command Center), 'api' or 'mcp' — a model whose vendor forbids
-- third-party API exposure (spec.api_exposure = 'web_only', FLUX) is never
-- offered on the last two. Entitlement (the org's plan) is returned, not yet
-- enforced here: 0034 lands on another branch and PR 2's quote checks it.
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
  if p_capability is not null and p_capability not in ('t2i', 'edit', 't2v', 'i2v', 'tts', 'sfx') then
    raise exception 'unknown capability %', p_capability using errcode = '22023';
  end if;
  return query
    select m.id, m.display_name, m.provider, m.capabilities, m.availability, m.verified_at,
           m.credit_unit, m.entitlement, cp.credits_per_unit, cp.margin,
           -- The public half of spec: what a person choosing a model needs.
           -- Never provider costs, evidence, notes, the probe or the vendor id.
           jsonb_strip_nulls(jsonb_build_object(
             'output', m.spec -> 'output', 'inputs', m.spec -> 'inputs',
             'aspect_ratios', m.spec -> 'aspect_ratios',
             'aspect_ratios_by_capability', m.spec -> 'aspect_ratios_by_capability',
             'image_sizes', m.spec -> 'image_sizes', 'resolutions', m.spec -> 'resolutions',
             'durations_s', m.spec -> 'durations_s', 'audio_out', m.spec -> 'audio_out',
             'async', m.spec -> 'async', 'unit', m.spec -> 'pricing' -> 'unit',
             'attribution', m.spec -> 'attribution', 'api_exposure', m.spec -> 'api_exposure',
             'limits', m.spec -> 'limits', 'quality_tier', m.spec -> 'quality_tier',
             'speed_tier', m.spec -> 'speed_tier'))
      from public.model_registry m
      join public.credit_prices cp on cp.unit = m.credit_unit
     where m.availability in ('beta', 'ga')
       and m.verified_at is not null
       and m.verified_probe_id is not null
       and coalesce(m.spec ->> 'terms_gate', '') = ''
       and cp.credits_per_unit > 0
       and (p_capability is null or p_capability = any (m.capabilities))
       and (p_surface = 'web' or coalesce(m.spec ->> 'api_exposure', 'any') <> 'web_only')
     order by m.provider, m.id;
end
$$;

-- The whole registry, for the operator's admin page (PR 7).
create or replace function public.model_registry_admin()
  returns setof public.model_registry
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform admin only' using errcode = '42501';
  end if;
  return query select * from public.model_registry order by provider, id;
end
$$;

-- Upsert the reviewed file's static facts. Never touches availability or
-- verification directly (the guard trigger clears verification when what is
-- called changes). A model that left the file is disabled, not deleted: its
-- probe history stays, and it can never be sold by accident.
create or replace function public.sync_model_registry(p_rows jsonb) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r jsonb;
  n integer := 0;
  ids text[] := '{}';
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'p_rows must be a non-empty array' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into public.model_registry as m (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement)
    values (r ->> 'id', r ->> 'display_name', r ->> 'provider', r ->> 'adapter',
            array(select jsonb_array_elements_text(r -> 'capabilities')),
            coalesce(r -> 'spec', '{}'::jsonb), r ->> 'credit_unit', r ->> 'entitlement')
    on conflict (id) do update
      set display_name = excluded.display_name, provider = excluded.provider,
          adapter = excluded.adapter, capabilities = excluded.capabilities, spec = excluded.spec,
          credit_unit = excluded.credit_unit, entitlement = excluded.entitlement,
          availability = case when m.availability = 'disabled' and m.spec ->> 'removed_from_file' = 'true'
                              then 'hidden' else m.availability end;
    ids := ids || (r ->> 'id');
    n := n + 1;
  end loop;
  update public.model_registry
     set availability = 'disabled', spec = spec || '{"removed_from_file": true}'::jsonb
   where not (id = any (ids)) and availability <> 'disabled';
  return n;
end
$$;

-- Record one probe call; a success of the model as it is now verifies it.
-- Returns the probe row's id.
create or replace function public.record_model_probe(
    p_model text, p_adapter text, p_vendor_model text, p_capability text, p_ok boolean,
    p_error_code text, p_error text, p_latency_ms integer, p_output_bytes bigint, p_probed_by text)
  returns bigint
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  m public.model_registry;
  run_id bigint;
begin
  select * into m from public.model_registry where id = p_model for update;
  if not found then
    raise exception 'unknown model %', p_model using errcode = '22023';
  end if;
  insert into public.model_probe_runs (model_id, adapter, vendor_model, capability, ok, error_code, error,
                                       latency_ms, output_bytes, probed_by)
  values (p_model, p_adapter, p_vendor_model, p_capability, p_ok,
          case when p_ok then null else p_error_code end,
          case when p_ok then null else left(p_error, 500) end,
          p_latency_ms, p_output_bytes, p_probed_by)
  returning id into run_id;
  if p_ok and p_adapter = m.adapter
     and (p_vendor_model = m.spec ->> 'vendor_model'
          or p_vendor_model in (select value from jsonb_each_text(coalesce(m.spec -> 'vendor_model_by_capability', '{}'::jsonb)))) then
    update public.model_registry
       set verified_probe_id = run_id, verified_by = p_probed_by
     where id = p_model;
  end if;
  return run_id;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Grants and row-level security
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.model_registry_guard() from public, anon, authenticated;
revoke all on function public.model_probe_runs_append_only() from public, anon, authenticated;

revoke all on function public.sellable_models(text, text) from public, anon;
grant execute on function public.sellable_models(text, text) to authenticated, service_role;

revoke all on function public.model_registry_admin() from public, anon;
grant execute on function public.model_registry_admin() to authenticated, service_role;

revoke all on function public.sync_model_registry(jsonb) from public, anon, authenticated;
grant execute on function public.sync_model_registry(jsonb) to service_role;

revoke all on function public.record_model_probe(text, text, text, text, boolean, text, text, integer, bigint, text)
  from public, anon, authenticated;
grant execute on function public.record_model_probe(text, text, text, text, boolean, text, text, integer, bigint, text)
  to service_role;

alter table public.model_registry enable row level security;
alter table public.model_probe_runs enable row level security;

-- model_registry: signed-in users read the public columns of sellable rows;
-- a platform admin updates the operator's columns; the service role syncs
-- through the functions above (it bypasses RLS, not privileges).
revoke all on public.model_registry from anon, authenticated, service_role;
grant select (id, display_name, provider, adapter, capabilities, availability, verified_at,
              credit_unit, entitlement, created_at, updated_at)
  on public.model_registry to authenticated;
grant update (availability, display_name, credit_unit, entitlement) on public.model_registry to authenticated;
grant select, insert, update on public.model_registry to service_role;

drop policy if exists model_registry_select on public.model_registry;
create policy model_registry_select on public.model_registry
  for select to authenticated
  using (public.is_platform_admin() or (availability in ('beta', 'ga') and verified_at is not null));

drop policy if exists model_registry_admin_update on public.model_registry;
create policy model_registry_admin_update on public.model_registry
  for update to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- model_probe_runs: the operator reads them; only record_model_probe writes.
revoke all on public.model_probe_runs from anon, authenticated, service_role;
grant select on public.model_probe_runs to authenticated, service_role;
revoke all on sequence public.model_probe_runs_id_seq from anon, authenticated, service_role;

drop policy if exists model_probe_runs_select on public.model_probe_runs;
create policy model_probe_runs_select on public.model_probe_runs
  for select to authenticated
  using (public.is_platform_admin());

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select bool_and(relrowsecurity) from pg_class where oid in (
--     'public.model_registry'::regclass, 'public.model_probe_runs'::regclass)) as rls_on,
--   not has_table_privilege('anon', 'public.model_registry', 'SELECT')
--     and not has_table_privilege('anon', 'public.model_probe_runs', 'SELECT') as anon_reads_nothing,
--   not has_column_privilege('authenticated', 'public.model_registry', 'spec', 'SELECT')
--     and not has_column_privilege('authenticated', 'public.model_registry', 'verified_at', 'UPDATE')
--     and not has_column_privilege('authenticated', 'public.model_registry', 'spec', 'UPDATE') as columns_narrow,
--   not has_table_privilege('authenticated', 'public.model_probe_runs', 'INSERT')
--     and not has_table_privilege('service_role', 'public.model_probe_runs', 'INSERT') as probes_only_via_function,
--   not has_function_privilege('anon', 'public.sellable_models(text,text)', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.sellable_models(text,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.record_model_probe(text,text,text,text,boolean,text,text,integer,bigint,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.sync_model_registry(jsonb)', 'EXECUTE') as grants_narrow,
--   not exists (select 1 from public.model_registry
--                where availability in ('beta', 'ga') and verified_at is null) as nothing_unverified_on_sale;
