-- 0073_workflow_apps.sql — Workflow apps: a saved, reusable list of 2-6 creative
-- steps with named inputs and a "Run now" that is priced as ONE total.
--
-- WHAT IT ADDS
--   workflows           one saved definition of an organization: a name, up to
--                       six named inputs (a text, or a library asset) and two to
--                       six steps. A step is an ordinary creative job described
--                       as data: a capability, a model and the params, where a
--                       param may name an input ({"$input": "name"}) or, for the
--                       source picture, the first file an EARLIER step made
--                       ({"$step": 0}).
--   workflow_runs       one press of "Run now": the inputs it was given, the
--                       total the member confirmed (max_credits) and where it
--                       got to. The run id is chosen by the caller and is the
--                       replay token: pressing twice answers the first run.
--   workflow_run_steps  each step of a run: its confirmed price, the creative
--                       job that pays for it (once it has started), what was
--                       charged and why it failed, if it did.
--   save_workflow, delete_workflow, quote_workflow, start_workflow_run,
--   advance_workflow_run, cancel_workflow_run
--                       the only write paths. Nothing here writes a table
--                       directly: no insert, update or delete for anyone, the
--                       service key included (it bypasses RLS, not privileges).
--
-- THE MONEY (this is the point of the file)
--   * ONE TOTAL. quote_workflow prices every step with creative_price — the
--     function behind /api/creative/quote, so a step costs exactly what it would
--     in the Studio — and sums them. A step that cannot be priced for ANY reason
--     (no price row, model not on sale, a source that is not this organization's,
--     a length that is not known) makes the total NULL ("unpriced"), never 0, and
--     start_workflow_run refuses it.
--   * CONFIRMED. start_workflow_run takes max_credits = the total the member
--     confirmed and refuses (price_changed) unless it equals the total as priced
--     NOW, in either direction: what was confirmed is what is run. It also takes
--     the workflow's version, so a workflow edited after the quote cannot be run
--     under the old price (workflow_changed).
--   * ORDINARY JOBS. Each step is created by create_creative_job — the same call
--     as a Studio generation, membership checks, sellable model, hold = quote,
--     capture <= hold, release on failure — with p_max_credits = THAT STEP'S
--     confirmed price, so no step can cost more than it was confirmed at, and the
--     steps together cannot pass the confirmed total (checked again before each
--     start). The idempotency key of a step is 'wf:<run id>:<step index>'.
--   * HELD WHEN STARTED. Only the first step is created when the run starts. The
--     next is created, and only then held, when the one before it has completed.
--     A step that fails (provider failure, a refused hold, a price that moved) fails
--     the run: later steps are marked skipped and were never created, so they
--     never held anything, and the failed step's own hold is released by
--     finish_creative_job / creative_end_locked as for any job.
--   * AT THE START THE WHOLE TOTAL MUST BE AVAILABLE (insufficient_credits
--     otherwise, before anything is held), so a run seldom stops half way for
--     want of credits; the later holds are still taken one at a time.
--   * A confirmation is good for 24 hours: a step still waiting after that is
--     failed (confirmation_expired), not started on an old yes.
--
-- WHO ADVANCES A RUN
--   advance_workflow_run is called by a signed-in member of the organization
--   (the run page polls it), because create_creative_job needs the member's own
--   session. While nobody has the run open, no step is started and nothing is
--   held — the run simply waits, and carries on when someone opens it.
--
-- NOTHING HERE PUBLISHES. A step makes a library file and nothing else;
--   publishing stays behind the publish gate and publish_requests, unchanged.
--
-- STEP INPUTS FROM EARLIER STEPS, AND THEIR PRICE
--   A chained step (its source picture is an earlier step's output) does not
--   have that picture yet when it is quoted. Its price does not depend on WHICH
--   picture (edit / remove_bg: one image; i2v: duration_s; upscale: the factor),
--   so it is quoted by creative_price itself against a stand-in: a live,
--   usable picture of the organization's library. None in the library: the step
--   is unpriced and the total with it. Steps whose price DOES depend on the
--   source (voice_change, dub, video_upscale: the file's seconds) may not take
--   a step's output at all (refused when saving). The real price is computed
--   again, with the real picture, when the step starts, and must not exceed the
--   confirmed one.
--
-- WHO MAY DO WHAT (members only; "editor" below is the role that may change work
--   in 0018's ladder — viewers read)
--   workflows, workflow_runs, workflow_run_steps
--       select: members of the organization · no insert / update / delete
--   save_workflow, delete_workflow, start_workflow_run, advance_workflow_run,
--   cancel_workflow_run
--       members who may edit (the member who spends credits is one of them)
--   quote_workflow
--       any member
--   anon gets nothing at all. The helpers are executable by no API role.
--   Another organization's workflow or run reads exactly like one that does not
--   exist (P0002 not_found).
--
-- ERRORS (SQLSTATE; the message is the machine code the app maps)
--   42501 forbidden · P0002 not_found
--   NS400 invalid_params | invalid_inputs | unpriced | confirm_price |
--         limit_reached | invalid_idempotency_key
--   NS409 price_changed | workflow_changed | idempotency_conflict
--   NS402 insufficient credits (details: available=… needed=…)
--
-- REQUIRES 0018 (organizations), 0020 (credits), 0036 and the later creative
-- migrations (creative_price, create_creative_job). It replaces NO earlier
-- function: every creative function is called as it stands. Additive and
-- idempotent: guarded creates, drop-then-create policies, create-or-replace
-- functions of this file's own names.

do $$
begin
  if to_regprocedure('public.is_org_member(uuid, text)') is null
     or to_regprocedure('public.accessible_org_ids(text)') is null then
    raise exception '0073 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regprocedure('public.credit_account_lock(uuid)') is null
     or to_regprocedure('public.credits_exempt(uuid)') is null then
    raise exception '0073 needs the credits ledger: apply 0020_credits.sql first';
  end if;
  if to_regprocedure('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)') is null
     or to_regprocedure('public.cancel_creative_job(uuid)') is null
     or to_regprocedure('public.creative_price(uuid, text, text, jsonb)') is null
     or to_regprocedure('public.creative_params_problem(text, jsonb)') is null
     or to_regprocedure('public.creative_picture_problem(uuid, uuid, text)') is null
     or to_regprocedure('public.creative_capability_supported(text)') is null then
    raise exception '0073 needs the creative jobs: apply 0036 and the creative migrations (through 0052) first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.workflows (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete restrict,
  name        text not null,
  inputs      jsonb not null default '[]'::jsonb,
  steps       jsonb not null,
  version     integer not null default 1,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);

alter table public.workflows drop constraint if exists workflows_shape_check;
alter table public.workflows add constraint workflows_shape_check
  check (char_length(name) between 1 and 80
         and name = btrim(name)
         and jsonb_typeof(inputs) = 'array' and jsonb_array_length(inputs) <= 6
         and jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 2 and 6
         and octet_length(inputs::text) <= 8192 and octet_length(steps::text) <= 65536
         and version >= 1);

-- A workflow's id and organization together: the runs below reference the pair,
-- so a run can never name another organization's workflow.
create unique index if not exists workflows_id_org_key on public.workflows (id, org_id);
create index if not exists workflows_org_idx
  on public.workflows (org_id, updated_at desc) where archived_at is null;

comment on table public.workflows is
  'A saved list of 2-6 creative steps with named inputs (migration 0073). Written only by save_workflow / delete_workflow; read by members of the organization.';

create table if not exists public.workflow_runs (
  id                  uuid primary key,
  org_id              uuid not null references public.organizations (id) on delete restrict,
  workflow_id         uuid not null,
  workflow_name       text not null,
  workflow_version    integer not null,
  status              text not null default 'running',
  inputs              jsonb not null default '{}'::jsonb,
  max_credits         numeric(14,2) not null,
  charged_credits     numeric(14,2) not null default 0,
  request_hash        text not null,
  started_by          uuid,
  cancel_requested_at timestamptz,
  error_code          text,
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  finished_at         timestamptz,
  constraint workflow_runs_workflow_fk
    foreign key (workflow_id, org_id) references public.workflows (id, org_id) on delete restrict
);

alter table public.workflow_runs drop constraint if exists workflow_runs_check;
alter table public.workflow_runs add constraint workflow_runs_check
  check (status in ('running', 'completed', 'failed', 'cancelled')
         and max_credits >= 0
         and charged_credits >= 0 and charged_credits <= max_credits
         and jsonb_typeof(inputs) = 'object' and octet_length(inputs::text) <= 16384
         and (error_code is null or error_code ~ '^[a-z0-9_]{1,64}$')
         and (error is null or char_length(error) <= 2000));

create unique index if not exists workflow_runs_id_org_key on public.workflow_runs (id, org_id);
create index if not exists workflow_runs_org_idx on public.workflow_runs (org_id, created_at desc);
create index if not exists workflow_runs_workflow_idx on public.workflow_runs (workflow_id, created_at desc);

comment on table public.workflow_runs is
  'One press of Run now (migration 0073): the confirmed total (max_credits) and where the run got to. The id is the replay token. Written only by start_workflow_run / advance_workflow_run / cancel_workflow_run.';

create table if not exists public.workflow_run_steps (
  run_id          uuid not null,
  step_index      smallint not null,
  org_id          uuid not null,
  capability      text not null,
  model           text not null,
  params          jsonb not null,
  status          text not null default 'pending',
  quoted_credits  numeric(14,2) not null,
  job_id          uuid references public.creative_jobs (id) on delete restrict,
  charged_credits numeric(14,2),
  error_code      text,
  error           text,
  started_at      timestamptz,
  finished_at     timestamptz,
  primary key (run_id, step_index),
  -- A step belongs to the run's organization, in the database and not only in
  -- the function that wrote it.
  constraint workflow_run_steps_run_fk
    foreign key (run_id, org_id) references public.workflow_runs (id, org_id) on delete restrict
);

alter table public.workflow_run_steps drop constraint if exists workflow_run_steps_check;
alter table public.workflow_run_steps add constraint workflow_run_steps_check
  check (step_index between 0 and 5
         and status in ('pending', 'running', 'completed', 'failed', 'cancelled', 'skipped')
         and quoted_credits >= 0
         and (charged_credits is null or (charged_credits >= 0 and charged_credits <= quoted_credits))
         and jsonb_typeof(params) = 'object' and octet_length(params::text) <= 16384
         and (error_code is null or error_code ~ '^[a-z0-9_]{1,64}$')
         and (error is null or char_length(error) <= 2000)
         -- A step that has not started has no job; one that has, has exactly one.
         and ((status in ('pending', 'skipped') and job_id is null)
              or (status in ('running', 'completed') and job_id is not null)
              or status in ('failed', 'cancelled')));

-- One creative job pays for at most one step, ever.
create unique index if not exists workflow_run_steps_job_key
  on public.workflow_run_steps (job_id) where job_id is not null;
create index if not exists workflow_run_steps_org_idx on public.workflow_run_steps (org_id, run_id);

comment on table public.workflow_run_steps is
  'The steps of a run (migration 0073): confirmed price, the creative job once started, charge and failure. A step that was never started has no job and held nothing.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Helpers (not callable through the API)
-- ───────────────────────────────────────────────────────────────────────────

-- Which capabilities leave a picture a later step may start from.
create or replace function public.workflow_makes_picture(p_capability text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p_capability in ('t2i', 'edit', 'upscale', 'remove_bg')
$$;

-- Which capabilities may start from the picture an earlier step made: the ones
-- whose price does not depend on which picture it is.
create or replace function public.workflow_takes_picture(p_capability text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p_capability in ('edit', 'i2v', 'upscale', 'remove_bg', 'describe')
$$;

-- Why this definition cannot be saved, or null. Shapes are checked here; what
-- each step's params mean is creative_params_problem's, run on the params with
-- every binding replaced by a well-formed placeholder, so the rules for a step
-- are the Studio's rules and are never written twice.
create or replace function public.workflow_definition_problem(p_inputs jsonb, p_steps jsonb)
  returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  nil     constant text := '00000000-0000-0000-0000-000000000000';
  names   text[] := '{}';
  kinds   jsonb := '{}'::jsonb;
  i       record;
  st      record;
  pr      record;
  k       text;
  idx     integer;
  cap     text;
  probe   jsonb;
  bound   jsonb;
  src     integer;
  problem text;
begin
  if jsonb_typeof(p_inputs) is distinct from 'array' or jsonb_array_length(p_inputs) > 6 then
    return 'inputs must be a list of at most 6';
  end if;
  if jsonb_typeof(p_steps) is distinct from 'array' or jsonb_array_length(p_steps) not between 2 and 6 then
    return 'a workflow has 2 to 6 steps';
  end if;
  if octet_length(p_inputs::text) > 8192 or octet_length(p_steps::text) > 65536 then
    return 'the workflow is too large';
  end if;

  for i in select v, ord from jsonb_array_elements(p_inputs) with ordinality as t(v, ord) loop
    if jsonb_typeof(i.v) <> 'object' then
      return format('input %s must be an object', i.ord);
    end if;
    for k in select jsonb_object_keys(i.v) loop
      if k not in ('name', 'kind', 'label') then
        return format('input %s: unknown field %s', i.ord, k);
      end if;
    end loop;
    if jsonb_typeof(i.v -> 'name') is distinct from 'string'
       or (i.v ->> 'name') !~ '^[a-z][a-z0-9_]{0,31}$' then
      return format('input %s: name must be 1-32 lowercase letters, digits or _, starting with a letter', i.ord);
    end if;
    if (i.v ->> 'name') = any (names) then
      return format('input %s: the name %s is used twice', i.ord, i.v ->> 'name');
    end if;
    if (i.v ->> 'kind') is distinct from 'text' and (i.v ->> 'kind') is distinct from 'asset' then
      return format('input %s: kind must be text or asset', i.ord);
    end if;
    if i.v ? 'label' and (jsonb_typeof(i.v -> 'label') <> 'string' or char_length(i.v ->> 'label') > 60) then
      return format('input %s: label must be text of at most 60 characters', i.ord);
    end if;
    names := names || (i.v ->> 'name');
    kinds := kinds || jsonb_build_object(i.v ->> 'name', i.v ->> 'kind');
  end loop;

  for st in select v, ord from jsonb_array_elements(p_steps) with ordinality as t(v, ord) loop
    idx := st.ord - 1;
    if jsonb_typeof(st.v) <> 'object' then
      return format('step %s must be an object', st.ord);
    end if;
    for k in select jsonb_object_keys(st.v) loop
      if k not in ('capability', 'model', 'params', 'label') then
        return format('step %s: unknown field %s', st.ord, k);
      end if;
    end loop;
    cap := st.v ->> 'capability';
    if jsonb_typeof(st.v -> 'capability') is distinct from 'string'
       or not public.creative_capability_supported(cap) then
      return format('step %s: this kind of step is not available', st.ord);
    end if;
    if jsonb_typeof(st.v -> 'model') is distinct from 'string'
       or (st.v ->> 'model') !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then
      return format('step %s: model is required', st.ord);
    end if;
    if st.v ? 'label' and (jsonb_typeof(st.v -> 'label') <> 'string' or char_length(st.v ->> 'label') > 60) then
      return format('step %s: label must be text of at most 60 characters', st.ord);
    end if;
    if jsonb_typeof(st.v -> 'params') is distinct from 'object' then
      return format('step %s: params must be an object', st.ord);
    end if;

    probe := '{}'::jsonb;
    for pr in select key, value from jsonb_each(st.v -> 'params') loop
      if jsonb_typeof(pr.value) = 'object' then
        -- A binding: exactly one of $input / $step, and nothing else.
        if (select count(*) from jsonb_object_keys(pr.value)) <> 1 then
          return format('step %s: %s must name one input or one step', st.ord, pr.key);
        end if;
        if pr.value ? '$input' then
          if jsonb_typeof(pr.value -> '$input') is distinct from 'string' or not (kinds ? (pr.value ->> '$input')) then
            return format('step %s: %s names an input that is not declared', st.ord, pr.key);
          end if;
          if pr.key in ('prompt', 'negative_prompt') then
            if kinds ->> (pr.value ->> '$input') <> 'text' then
              return format('step %s: %s needs a text input', st.ord, pr.key);
            end if;
            bound := to_jsonb('x'::text);
          elsif pr.key in ('source_asset_id', 'end_asset_id') then
            if kinds ->> (pr.value ->> '$input') <> 'asset' then
              return format('step %s: %s needs a library file input', st.ord, pr.key);
            end if;
            bound := to_jsonb(nil);
          else
            return format('step %s: %s cannot come from an input', st.ord, pr.key);
          end if;
        elsif pr.value ? '$step' then
          if pr.key <> 'source_asset_id' then
            return format('step %s: only the source picture may come from an earlier step', st.ord);
          end if;
          if jsonb_typeof(pr.value -> '$step') <> 'number'
             or not public.creative_json_int(pr.value -> '$step', 0, 5) then
            return format('step %s: the earlier step must be named by its number', st.ord);
          end if;
          src := (pr.value ->> '$step')::integer;
          if src >= idx then
            return format('step %s: the source must come from an EARLIER step', st.ord);
          end if;
          if not public.workflow_takes_picture(cap) then
            return format('step %s: a %s step cannot start from another step''s file', st.ord, cap);
          end if;
          if not public.workflow_makes_picture(p_steps -> src ->> 'capability') then
            return format('step %s: step %s does not make a picture', st.ord, src + 1);
          end if;
          bound := to_jsonb(nil);
        else
          return format('step %s: %s must name an input or a step', st.ord, pr.key);
        end if;
        probe := probe || jsonb_build_object(pr.key, bound);
      else
        probe := probe || jsonb_build_object(pr.key, pr.value);
      end if;
    end loop;

    problem := public.creative_params_problem(cap, probe);
    if problem is not null then
      return format('step %s: %s', st.ord, problem);
    end if;
  end loop;
  return null;
end
$$;

-- The values for a workflow's inputs, checked: every declared input given,
-- none undeclared, text within the prompt limit, a file as a uuid. Returns the
-- cleaned object. (That a file is a live file of THIS organization is decided
-- later, by the price, which reads another organization's id as a missing one.)
create or replace function public.workflow_bind_inputs(p_wf public.workflows, p_values jsonb)
  returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  i   record;
  k   text;
  v   jsonb;
  out_ jsonb := '{}'::jsonb;
  uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if p_values is null then
    p_values := '{}'::jsonb;
  end if;
  if jsonb_typeof(p_values) <> 'object' then
    perform public.creative_refuse('invalid_inputs', 'the inputs must be an object');
  end if;
  if octet_length(p_values::text) > 16384 then
    perform public.creative_refuse('invalid_inputs', 'the inputs are too large');
  end if;
  for k in select jsonb_object_keys(p_values) loop
    if not exists (select 1 from jsonb_array_elements(p_wf.inputs) d where d ->> 'name' = k) then
      perform public.creative_refuse('invalid_inputs', format('unknown input %s', k));
    end if;
  end loop;
  for i in select d from jsonb_array_elements(p_wf.inputs) d loop
    v := p_values -> (i.d ->> 'name');
    if v is null then
      perform public.creative_refuse('invalid_inputs', format('%s is required', i.d ->> 'name'));
    end if;
    if i.d ->> 'kind' = 'text' then
      if jsonb_typeof(v) <> 'string' or char_length(btrim(v #>> '{}')) = 0 then
        perform public.creative_refuse('invalid_inputs', format('%s must be text', i.d ->> 'name'));
      end if;
      if char_length(v #>> '{}') > 4000 then
        perform public.creative_refuse('invalid_inputs', format('%s is longer than 4000 characters', i.d ->> 'name'));
      end if;
      out_ := out_ || jsonb_build_object(i.d ->> 'name', v);
    else
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ uuid_re then
        perform public.creative_refuse('invalid_inputs',
          format('%s must be the id of a file in the media library', i.d ->> 'name'));
      end if;
      out_ := out_ || jsonb_build_object(i.d ->> 'name', lower(v #>> '{}'));
    end if;
  end loop;
  return out_;
end
$$;

-- A step's params with its input bindings filled in. A {"$step": n} binding is
-- left as it is (the file does not exist yet) — unless p_stand_in is given, which
-- stands in for it, for pricing only.
create or replace function public.workflow_fill_params(p_params jsonb, p_values jsonb, p_stand_in text default null)
  returns jsonb
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  pr   record;
  out_ jsonb := '{}'::jsonb;
begin
  for pr in select key, value from jsonb_each(p_params) loop
    if jsonb_typeof(pr.value) = 'object' and pr.value ? '$input' then
      out_ := out_ || jsonb_build_object(pr.key, p_values -> (pr.value ->> '$input'));
    elsif jsonb_typeof(pr.value) = 'object' and pr.value ? '$step' and p_stand_in is not null then
      out_ := out_ || jsonb_build_object(pr.key, p_stand_in);
    else
      out_ := out_ || jsonb_build_object(pr.key, pr.value);
    end if;
  end loop;
  return out_;
end
$$;

-- The price of every step and their total, for these (already cleaned) inputs.
-- Each step is priced by creative_price, as /api/creative/quote does; a step the
-- database cannot price says why and makes the total null.
create or replace function public.workflow_quote_steps(p_wf public.workflows, p_values jsonb)
  returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  st      record;
  params  jsonb;
  stand   text;
  q       jsonb;
  steps_  jsonb := '[]'::jsonb;
  total   numeric := 0;
  bad     integer[] := '{}';
  chained boolean;
  acc     public.credit_accounts;
begin
  for st in select v, ord from jsonb_array_elements(p_wf.steps) with ordinality as t(v, ord) loop
    chained := exists (select 1 from jsonb_each(st.v -> 'params') e
                        where jsonb_typeof(e.value) = 'object' and e.value ? '$step');
    stand := null;
    if chained then
      select a.id::text into stand
        from public.media_assets a
       where a.org_id = p_wf.org_id and a.kind = 'image'
         and a.deleted_at is null and a.purged_at is null
         and public.creative_picture_problem(p_wf.org_id, a.id, 'source_asset_id') is null
       order by a.created_at desc, a.id
       limit 1;
    end if;
    params := public.workflow_fill_params(st.v -> 'params', p_values, stand);
    begin
      if chained and stand is null then
        raise exception 'source_unavailable' using errcode = 'NS400';
      end if;
      q := public.creative_price(p_wf.org_id, st.v ->> 'capability', st.v ->> 'model', params);
      steps_ := steps_ || jsonb_build_array(jsonb_build_object(
        'step_index', st.ord - 1, 'capability', st.v ->> 'capability', 'model', st.v ->> 'model',
        'priced', true, 'credits', (q ->> 'credits')::numeric, 'unit', q ->> 'unit',
        'quantity', (q ->> 'quantity')::numeric, 'chained', chained));
      total := total + (q ->> 'credits')::numeric;
    exception when others then
      -- Never a zero: the step is unpriced and carries the database's own
      -- machine word (unpriced, model_not_sellable, source_unavailable, …).
      steps_ := steps_ || jsonb_build_array(jsonb_build_object(
        'step_index', st.ord - 1, 'capability', st.v ->> 'capability', 'model', st.v ->> 'model',
        'priced', false, 'credits', null,
        'reason', case when sqlerrm ~ '^[a-z0-9_]{1,64}$' then sqlerrm else 'unpriced' end,
        'chained', chained));
      bad := bad || (st.ord - 1)::integer;
    end;
  end loop;
  select * into acc from public.credit_accounts where org_id = p_wf.org_id;
  return jsonb_build_object(
    'workflow_id', p_wf.id, 'version', p_wf.version, 'steps', steps_,
    'priced', cardinality(bad) = 0,
    'total', case when cardinality(bad) = 0 then total end,
    'unpriced_steps', to_jsonb(bad),
    'exempt', public.credits_exempt(p_wf.org_id),
    'available', case when public.credits_exempt(p_wf.org_id) then null
                      else coalesce(acc.balance - acc.reserved, 0) end);
end
$$;

-- The run and its steps as the app shows them (never the request hash).
create or replace function public.workflow_run_json(p_run uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'run', to_jsonb(r) - 'request_hash',
    'steps', coalesce((
      select jsonb_agg(jsonb_build_object(
               'step_index', s.step_index, 'capability', s.capability, 'model', s.model,
               'status', s.status, 'quoted_credits', s.quoted_credits,
               'charged_credits', s.charged_credits, 'job_id', s.job_id,
               'job_status', j.status, 'result_asset_ids', to_jsonb(j.result_asset_ids),
               'error_code', s.error_code, 'error', s.error,
               'started_at', s.started_at, 'finished_at', s.finished_at)
             order by s.step_index)
        from public.workflow_run_steps s
        left join public.creative_jobs j on j.id = s.job_id
       where s.run_id = r.id), '[]'::jsonb))
  from public.workflow_runs r where r.id = p_run
$$;

-- Take a run as far as it can go right now. The caller has checked that the
-- member may act on this organization; this locks the run, then (inside
-- create_creative_job) the credit account — the order every function here
-- takes, and the creative functions never touch a run, so they cannot meet it
-- the other way round.
--
-- One call may settle a finished step and start the next. p_strict: a refusal of
-- the FIRST step is raised (the run is not stored, nothing was held) instead of
-- stored as a failed run — "Run now" then answers with the real reason.
create or replace function public.workflow_advance_locked(p_run uuid, p_strict boolean default false)
  returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r        public.workflow_runs;
  s        public.workflow_run_steps;
  j        public.creative_jobs;
  out_     jsonb;
  params   jsonb;
  pr       record;
  src_job  public.creative_jobs;
  asset    uuid;
  committed numeric;
  why_code text;
  why      text;
  detail   text;
  guard    integer := 0;
begin
  select * into r from public.workflow_runs where id = p_run for update;
  if not found then
    return;
  end if;
  loop
    guard := guard + 1;
    exit when guard > 8;
    exit when r.status <> 'running';

    select * into s from public.workflow_run_steps
     where run_id = r.id and status in ('pending', 'running')
     order by step_index limit 1;

    if not found then
      -- Every step is settled and none failed (a failure ends the run below).
      update public.workflow_runs
         set status = 'completed', finished_at = now(), updated_at = now(),
             charged_credits = (select coalesce(sum(charged_credits), 0) from public.workflow_run_steps where run_id = r.id)
       where id = r.id returning * into r;
      exit;
    end if;

    if s.status = 'running' then
      select * into j from public.creative_jobs where id = s.job_id;
      if j.status = 'completed' then
        update public.workflow_run_steps
           set status = 'completed', charged_credits = coalesce(j.charged_credits, 0),
               finished_at = coalesce(j.finished_at, now())
         where run_id = s.run_id and step_index = s.step_index;
        update public.workflow_runs
           set updated_at = now(),
               charged_credits = (select coalesce(sum(charged_credits), 0) from public.workflow_run_steps where run_id = r.id)
         where id = r.id returning * into r;
        continue;
      elsif j.status in ('failed', 'cancelled', 'expired') then
        update public.workflow_run_steps
           set status = case when j.status = 'cancelled' then 'cancelled' else 'failed' end,
               charged_credits = 0, error_code = coalesce(j.error_code, j.status), error = left(j.error, 2000),
               finished_at = coalesce(j.finished_at, now())
         where run_id = s.run_id and step_index = s.step_index;
        -- Later steps were never created, so they never held anything.
        update public.workflow_run_steps set status = 'skipped'
         where run_id = r.id and status = 'pending';
        update public.workflow_runs
           set status = case when r.cancel_requested_at is not null then 'cancelled' else 'failed' end,
               error_code = case when r.cancel_requested_at is not null then 'cancelled' else 'step_failed' end,
               error = format('step %s did not finish (%s); later steps were not started and nothing was held for them',
                              s.step_index + 1, coalesce(j.error_code, j.status)),
               finished_at = now(), updated_at = now(),
               charged_credits = (select coalesce(sum(charged_credits), 0) from public.workflow_run_steps where run_id = r.id)
         where id = r.id returning * into r;
        exit;
      else
        exit; -- the job is still being made
      end if;
    end if;

    -- s is the next step to start; every step before it has completed.
    if r.cancel_requested_at is not null then
      update public.workflow_run_steps set status = 'skipped' where run_id = r.id and status = 'pending';
      update public.workflow_runs
         set status = 'cancelled', error_code = 'cancelled', finished_at = now(), updated_at = now(),
             charged_credits = (select coalesce(sum(charged_credits), 0) from public.workflow_run_steps where run_id = r.id)
       where id = r.id returning * into r;
      exit;
    end if;

    why_code := null;
    if r.created_at < now() - interval '24 hours' then
      why_code := 'confirmation_expired';
      why := 'the price was confirmed more than 24 hours ago; run the workflow again to confirm it afresh';
    end if;

    if why_code is null then
      -- Fill in the file an earlier step made.
      params := s.params;
      for pr in select key, value from jsonb_each(s.params) loop
        if jsonb_typeof(pr.value) = 'object' and pr.value ? '$step' then
          asset := null;
          select cj.* into src_job
            from public.workflow_run_steps ss
            join public.creative_jobs cj on cj.id = ss.job_id
           where ss.run_id = r.id and ss.step_index = (pr.value ->> '$step')::integer
             and ss.status = 'completed' and cj.org_id = r.org_id;
          asset := case when found then src_job.result_asset_ids[1] end;
          if asset is null then
            why_code := 'missing_output';
            why := format('step %s made no file for this step to start from', (pr.value ->> '$step')::integer + 1);
          else
            params := params || jsonb_build_object(pr.key, asset::text);
          end if;
        end if;
      end loop;
    end if;

    if why_code is null then
      -- The steps together may not pass what was confirmed.
      select coalesce(sum(quoted_credits), 0) into committed
        from public.workflow_run_steps where run_id = r.id and status in ('running', 'completed');
      if committed + s.quoted_credits > r.max_credits then
        why_code := 'over_confirmed_total';
        why := 'starting this step would pass the total that was confirmed';
      end if;
    end if;

    if why_code is null then
      begin
        out_ := public.create_creative_job(
          r.org_id, s.capability, s.model, params, 'exact',
          'wf:' || r.id::text || ':' || s.step_index::text, s.quoted_credits);
        if out_ is null or (out_ -> 'job' ->> 'id') is null or (out_ -> 'job' ->> 'org_id')::uuid <> r.org_id then
          raise exception 'creative job not created' using errcode = 'NS400';
        end if;
        update public.workflow_run_steps
           set status = 'running', job_id = (out_ -> 'job' ->> 'id')::uuid, started_at = now()
         where run_id = s.run_id and step_index = s.step_index;
        update public.workflow_runs set updated_at = now() where id = r.id;
        continue;
      exception when others then
        get stacked diagnostics detail = pg_exception_detail;
        if p_strict and s.step_index = 0 then
          raise;
        end if;
        why_code := case
          when sqlstate = 'NS402' then 'insufficient_credits'
          when sqlstate = 'NS429' then 'run_limit_reached'
          when sqlstate = '42501' then 'forbidden'
          when sqlstate in ('NS400', 'NS409') and sqlerrm ~ '^[a-z0-9_]{1,64}$' then sqlerrm
          else 'refused' end;
        why := left(coalesce(nullif(detail, ''), sqlerrm), 500);
      end;
    end if;

    -- This step could not start (or its input is missing): it fails, the run
    -- with it, and the steps after it are skipped without ever being created.
    update public.workflow_run_steps
       set status = 'failed', charged_credits = 0, error_code = why_code, error = why, finished_at = now()
     where run_id = s.run_id and step_index = s.step_index;
    update public.workflow_run_steps set status = 'skipped' where run_id = r.id and status = 'pending';
    update public.workflow_runs
       set status = 'failed', error_code = 'step_failed',
           error = format('step %s could not start (%s); later steps were not started and nothing was held for them',
                          s.step_index + 1, why_code),
           finished_at = now(), updated_at = now(),
           charged_credits = (select coalesce(sum(charged_credits), 0) from public.workflow_run_steps where run_id = r.id)
     where id = r.id returning * into r;
    exit;
  end loop;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The browser's calls (signed-in members, through the Command Center)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.save_workflow(
  p_org uuid,
  p_workflow uuid default null,
  p_name text default null,
  p_inputs jsonb default '[]'::jsonb,
  p_steps jsonb default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  nm      text := btrim(coalesce(p_name, ''));
  w       public.workflows;
  problem text;
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_workflow is not null then
    -- Another organization's workflow reads as missing, not as forbidden.
    select * into w from public.workflows where id = p_workflow;
    if not found or w.archived_at is not null or not public.is_org_member(w.org_id) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    if not public.is_org_member(w.org_id, 'editor') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    p_org := w.org_id;
  elsif p_org is null or not public.is_org_member(p_org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if char_length(nm) not between 1 and 80 then
    perform public.creative_refuse('invalid_params', 'the name must be 1 to 80 characters');
  end if;
  problem := public.workflow_definition_problem(coalesce(p_inputs, '[]'::jsonb), p_steps);
  if problem is not null then
    perform public.creative_refuse('invalid_params', problem);
  end if;

  -- One writer per organization at a time, so the count below cannot be passed.
  perform pg_advisory_xact_lock(hashtextextended('workflows:' || p_org::text, 0));
  if p_workflow is null then
    if (select count(*) from public.workflows where org_id = p_org and archived_at is null) >= 50 then
      perform public.creative_refuse('limit_reached', 'an organization keeps at most 50 workflows');
    end if;
    insert into public.workflows (org_id, name, inputs, steps, created_by)
    values (p_org, nm, coalesce(p_inputs, '[]'::jsonb), p_steps, uid)
    returning * into w;
  else
    update public.workflows
       set name = nm, inputs = coalesce(p_inputs, '[]'::jsonb), steps = p_steps,
           version = version + 1, updated_at = now()
     where id = p_workflow
    returning * into w;
  end if;
  return to_jsonb(w);
end
$$;

create or replace function public.delete_workflow(p_workflow uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  w public.workflows;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into w from public.workflows where id = p_workflow;
  if not found or not public.is_org_member(w.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(w.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Hidden, not deleted: its runs keep the definition they were started with.
  update public.workflows set archived_at = coalesce(archived_at, now()), updated_at = now()
   where id = p_workflow returning * into w;
  return jsonb_build_object('id', w.id, 'archived', true);
end
$$;

-- What "Run now" would cost, before anything is held: every step priced the way
-- the Studio prices it, and ONE total — or null when any step is unpriced.
create or replace function public.quote_workflow(p_workflow uuid, p_inputs jsonb default '{}'::jsonb)
  returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  w public.workflows;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into w from public.workflows where id = p_workflow and archived_at is null;
  if not found or not public.is_org_member(w.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return public.workflow_quote_steps(w, public.workflow_bind_inputs(w, p_inputs));
end
$$;

-- Run now. p_run is the caller's replay token; p_version the workflow version
-- the price was quoted for; p_max_credits the total the member confirmed.
create or replace function public.start_workflow_run(
  p_run uuid,
  p_workflow uuid,
  p_version integer,
  p_inputs jsonb default '{}'::jsonb,
  p_max_credits numeric default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  w       public.workflows;
  prior   public.workflow_runs;
  vals    jsonb;
  hash_   text;
  q       jsonb;
  total   numeric;
  acc     public.credit_accounts;
  st      record;
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_run is null then
    perform public.creative_refuse('invalid_params', 'a run id is required');
  end if;
  select * into w from public.workflows where id = p_workflow;
  if not found or w.archived_at is not null or not public.is_org_member(w.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(w.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The operator's organization is paid by the platform: only a platform admin
  -- spends there (create_creative_job asks the same of every step).
  if public.credits_exempt(w.org_id) and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501',
      detail = 'runs in the operator''s organization are started by a platform admin';
  end if;
  if p_max_credits is null or p_max_credits < 0 then
    perform public.creative_refuse('confirm_price', 'the confirmed total is required');
  end if;

  -- The account first: every create (and reserve) for this organization queues
  -- behind it, so a replay of the same run finds the first one's committed rows.
  perform public.credit_account_lock(w.org_id);

  hash_ := md5(jsonb_build_object('workflow', p_workflow, 'inputs', coalesce(p_inputs, '{}'::jsonb),
                                  'max', round(p_max_credits, 2)::text)::text);
  select * into prior from public.workflow_runs where id = p_run;
  if found then
    -- The same id under another organization, another workflow, other inputs or
    -- another confirmed total is a different request: refused without saying
    -- anything about what it collided with.
    if prior.org_id <> w.org_id or prior.request_hash is distinct from hash_ then
      perform public.creative_refuse('idempotency_conflict',
        'this run id was used for a different request', 'NS409');
    end if;
    perform public.workflow_advance_locked(prior.id);
    return public.workflow_run_json(prior.id) || jsonb_build_object('replay', true);
  end if;

  if p_version is distinct from w.version then
    perform public.creative_refuse('workflow_changed',
      format('the workflow is now version %s, not %s', w.version, p_version), 'NS409');
  end if;

  vals := public.workflow_bind_inputs(w, p_inputs);
  q := public.workflow_quote_steps(w, vals);
  if not (q ->> 'priced')::boolean then
    perform public.creative_refuse('unpriced',
      format('step(s) %s cannot be priced, so the workflow has no price',
             (select string_agg((u.x::integer + 1)::text, ', ') from jsonb_array_elements_text(q -> 'unpriced_steps') u(x))));
  end if;
  total := (q ->> 'total')::numeric;
  if round(p_max_credits, 2) <> round(total, 2) then
    perform public.creative_refuse('price_changed',
      format('price=%s confirmed=%s', total, round(p_max_credits, 2)), 'NS409');
  end if;
  if not public.credits_exempt(w.org_id) then
    select * into acc from public.credit_accounts where org_id = w.org_id;
    if coalesce(acc.balance - acc.reserved, 0) < total then
      perform public.creative_refuse('insufficient_credits',
        format('available=%s needed=%s', coalesce(acc.balance - acc.reserved, 0), total), 'NS402');
    end if;
  end if;

  insert into public.workflow_runs
    (id, org_id, workflow_id, workflow_name, workflow_version, inputs, max_credits, request_hash, started_by)
  values
    (p_run, w.org_id, w.id, w.name, w.version, vals, round(total, 2), hash_, uid);
  for st in select v, ord from jsonb_array_elements(w.steps) with ordinality as t(v, ord) loop
    insert into public.workflow_run_steps (run_id, step_index, org_id, capability, model, params, quoted_credits)
    values (p_run, st.ord - 1, w.org_id, st.v ->> 'capability', st.v ->> 'model',
            public.workflow_fill_params(st.v -> 'params', vals),
            (q -> 'steps' -> (st.ord - 1)::integer ->> 'credits')::numeric);
  end loop;

  perform public.workflow_advance_locked(p_run, true);
  return public.workflow_run_json(p_run) || jsonb_build_object('replay', false);
end
$$;

-- Carry a run forward: settle the step that finished and start the next. Safe to
-- call as often as the page likes — it starts nothing that has started, and a
-- step's job carries the idempotency key 'wf:<run>:<step>'.
create or replace function public.advance_workflow_run(p_run uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r public.workflow_runs;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into r from public.workflow_runs where id = p_run;
  if not found or not public.is_org_member(r.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(r.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if public.credits_exempt(r.org_id) and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.workflow_advance_locked(p_run);
  return public.workflow_run_json(p_run);
end
$$;

-- Stop a run: steps not started are skipped (nothing was held for them), the
-- step being made is cancelled if the provider has not started on it, and
-- otherwise finishes and is charged like any job.
create or replace function public.cancel_workflow_run(p_run uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r public.workflow_runs;
  s public.workflow_run_steps;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into r from public.workflow_runs where id = p_run;
  if not found or not public.is_org_member(r.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(r.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into r from public.workflow_runs where id = p_run for update;
  if r.status = 'running' then
    update public.workflow_runs set cancel_requested_at = coalesce(cancel_requested_at, now()), updated_at = now()
     where id = p_run;
    select * into s from public.workflow_run_steps where run_id = p_run and status = 'running';
    if found then
      begin
        perform public.cancel_creative_job(s.job_id);
      exception when others then
        -- Already with the provider (not_cancellable): it runs to the end.
        null;
      end;
    end if;
    perform public.workflow_advance_locked(p_run);
  end if;
  return public.workflow_run_json(p_run);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

alter table public.workflows enable row level security;
alter table public.workflow_runs enable row level security;
alter table public.workflow_run_steps enable row level security;

-- Rows change only through the functions above: no direct write for anyone,
-- the service key included.
revoke all on public.workflows, public.workflow_runs, public.workflow_run_steps
  from public, anon, authenticated, service_role;
grant select on public.workflows, public.workflow_runs, public.workflow_run_steps
  to authenticated, service_role;

drop policy if exists workflows_select on public.workflows;
create policy workflows_select on public.workflows
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists workflow_runs_select on public.workflow_runs;
create policy workflow_runs_select on public.workflow_runs
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists workflow_run_steps_select on public.workflow_run_steps;
create policy workflow_run_steps_select on public.workflow_run_steps
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

revoke all on function public.workflow_makes_picture(text) from public, anon, authenticated, service_role;
revoke all on function public.workflow_takes_picture(text) from public, anon, authenticated, service_role;
revoke all on function public.workflow_definition_problem(jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.workflow_bind_inputs(public.workflows, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.workflow_fill_params(jsonb, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.workflow_quote_steps(public.workflows, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.workflow_run_json(uuid) from public, anon, authenticated, service_role;
revoke all on function public.workflow_advance_locked(uuid, boolean) from public, anon, authenticated, service_role;

revoke all on function public.save_workflow(uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.delete_workflow(uuid) from public, anon, authenticated, service_role;
revoke all on function public.quote_workflow(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.start_workflow_run(uuid, uuid, integer, jsonb, numeric) from public, anon, authenticated, service_role;
revoke all on function public.advance_workflow_run(uuid) from public, anon, authenticated, service_role;
revoke all on function public.cancel_workflow_run(uuid) from public, anon, authenticated, service_role;
grant execute on function public.save_workflow(uuid, uuid, text, jsonb, jsonb) to authenticated;
grant execute on function public.delete_workflow(uuid) to authenticated;
grant execute on function public.quote_workflow(uuid, jsonb) to authenticated;
grant execute on function public.start_workflow_run(uuid, uuid, integer, jsonb, numeric) to authenticated;
grant execute on function public.advance_workflow_run(uuid) to authenticated;
grant execute on function public.cancel_workflow_run(uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   to_regclass('public.workflows') is not null
--     and to_regclass('public.workflow_runs') is not null
--     and to_regclass('public.workflow_run_steps') is not null          as tables_exist,
--   (select bool_and(c.relrowsecurity) from pg_class c
--     where c.oid in ('public.workflows'::regclass, 'public.workflow_runs'::regclass,
--                     'public.workflow_run_steps'::regclass))           as rls_on,
--   not has_table_privilege('authenticated', 'public.workflows', 'insert')
--     and not has_table_privilege('authenticated', 'public.workflow_runs', 'update')
--     and not has_table_privilege('service_role', 'public.workflow_run_steps', 'delete') as no_direct_writes,
--   has_function_privilege('authenticated', 'public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)', 'execute')
--     and not has_function_privilege('anon', 'public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)', 'execute')
--     and not has_function_privilege('authenticated', 'public.workflow_advance_locked(uuid, boolean)', 'execute') as grants_ok,
--   (select bool_and(p.proconfig @> array['search_path=public, pg_temp'])
--      from pg_proc p
--     where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proname like '%workflow%') as search_path_pinned;
