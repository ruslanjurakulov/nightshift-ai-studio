-- 0152_probe_vendor_credits.sql — the probe log keeps what the vendor itself said a probe cost, in the vendor's own credits.
--
-- *** LIVE ON APPLY. *** Merging this file applies it to the live database. It is additive: ONE nullable column on
-- public.model_probe_runs (no default, so no row is rewritten), ONE check constraint on that column, and ONE NEW overload of
-- record_model_probe that takes an eleventh argument. 0035's ten-argument record_model_probe, every other function, grant, policy,
-- trigger and row are untouched.
--
-- WHY. The first Runway probes (Actions "Probe models", 2026-11-13) cost 60 credits (gen4.5, 5 s) and 25 credits (gen4_turbo, 5 s):
-- Runway reports `cost.credits` on the finished task, modules/capabilities/video.py keeps it, and tools/probe_models.py printed it in
-- the workflow log ("ok runway-gen4.5 credits=60"). Nothing stored it, so the owner's Billing page could not count what probes spent;
-- the only record of a real vendor bill was a log line that GitHub deletes after its retention period.
--
-- WHAT IT ADDS
--   model_probe_runs.vendor_credits   numeric, NULLABLE. The vendor's own cost figure for the probe task, in the vendor's unit (Runway:
--                                     credits at $0.01, docs.dev.runwayml.com/guides/pricing, read 2026-11-13). NULL = the vendor reported
--                                     none, or the row is older than this file: unknown, never 0 (CLAUDE.md rule 5). Every row before
--                                     0152 reads NULL.
--   model_probe_runs_vendor_credits_check   NULL, or a finite number from 0 to 1,000,000 (NaN and Infinity are refused: NaN sorts
--                                     above every number in Postgres, so the upper bound refuses it too).
--   record_model_probe(... 10 arguments of 0035 ..., p_vendor_credits numeric)   the same body as 0035's, word for word, plus the one
--                                     column. p_vendor_credits has NO default on purpose: with a default, a ten-argument call would match
--                                     both overloads and Postgres would refuse it as ambiguous ("function is not unique"), which would
--                                     break every caller of the ten-argument form (the probe tool before this release, the security lab).
--                                     So a ten-argument call still reaches 0035's function, an eleven-argument call reaches this one.
--                                     The append-only trigger of 0035 stays: the figure is written with the row, never added later.
--
-- WHO MAY CALL IT: the service role only, like 0035's (EXECUTE revoked from public, anon and authenticated; granted to service_role).
-- SECURITY DEFINER with a pinned search_path, like 0035's.
--
-- THE WRITER (tools/probe_models.py) sends p_vendor_credits only when the vendor reported a figure. Against a database that has not
-- applied this file yet (or a stale PostgREST schema cache), the eleven-argument call answers 404 and nothing was written; the tool
-- then records the same probe through the ten-argument form and says the figure was not stored (docs/MIGRATIONS.md: the fallback
-- cannot duplicate a row, because the first call wrote none).
--
-- APPLY AS ONE TRANSACTION (SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1): `set local lock_timeout`
-- only holds inside one. The table is append-only and small; adding a nullable column without a default is a catalog change.
--
-- NUMBER. 0152. 0148, 0150 and 0151 are reserved by other work in flight (owner's numbering, 2026-11-13).
--
-- UNDO: docs/sql/rollback_0152_probe_vendor_credits.sql (owner-applied).

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.model_probe_runs') is null then
    raise exception '0152 needs model_probe_runs: apply 0035_model_registry.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The column and its rule
-- ───────────────────────────────────────────────────────────────────────────

alter table public.model_probe_runs add column if not exists vendor_credits numeric;

alter table public.model_probe_runs drop constraint if exists model_probe_runs_vendor_credits_check;
alter table public.model_probe_runs add constraint model_probe_runs_vendor_credits_check
  check (vendor_credits is null or (vendor_credits >= 0 and vendor_credits <= 1000000));

comment on column public.model_probe_runs.vendor_credits is
  'What the vendor reported the probe task cost, in its own credits (migration 0152). NULL = not reported or older than 0152: unknown, never 0.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The eleven-argument record_model_probe (0035's body plus the column)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.record_model_probe(
    p_model text, p_adapter text, p_vendor_model text, p_capability text, p_ok boolean,
    p_error_code text, p_error text, p_latency_ms integer, p_output_bytes bigint, p_probed_by text,
    p_vendor_credits numeric)
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
                                       latency_ms, output_bytes, probed_by, vendor_credits)
  values (p_model, p_adapter, p_vendor_model, p_capability, p_ok,
          case when p_ok then null else p_error_code end,
          case when p_ok then null else left(p_error, 500) end,
          p_latency_ms, p_output_bytes, p_probed_by, p_vendor_credits)
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

comment on function public.record_model_probe(text, text, text, text, boolean, text, text, integer, bigint, text, numeric) is
  'record_model_probe (0035) plus the vendor''s own cost figure for the probe (migration 0152). Service role only.';

revoke all on function public.record_model_probe(text, text, text, text, boolean, text, text, integer, bigint, text, numeric)
  from public, anon, authenticated;
grant execute on function public.record_model_probe(text, text, text, text, boolean, text, text, integer, bigint, text, numeric)
  to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The end state: stop the transaction if any of it is not what this file says
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  f regprocedure := 'public.record_model_probe(text, text, text, text, boolean, text, text, integer, bigint, text, numeric)'::regprocedure;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'model_probe_runs'
                    and column_name = 'vendor_credits' and data_type = 'numeric' and is_nullable = 'YES'
                    and column_default is null) then
    raise exception '0152: model_probe_runs.vendor_credits is not a nullable numeric without a default';
  end if;
  if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('authenticated', f, 'EXECUTE')
     or not has_function_privilege('service_role', f, 'EXECUTE') then
    raise exception '0152: the eleven-argument record_model_probe must be callable by the service role only';
  end if;
  if not (select prosecdef from pg_proc where oid = f)
     or not exists (select 1 from pg_proc p, unnest(p.proconfig) c where p.oid = f and c like 'search_path=%') then
    raise exception '0152: the eleven-argument record_model_probe must be security definer with a pinned search_path';
  end if;
  if to_regprocedure('public.record_model_probe(text, text, text, text, boolean, text, text, integer, bigint, text)') is null then
    raise exception '0152: 0035''s ten-argument record_model_probe must still exist';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   exists (select 1 from information_schema.columns
--            where table_schema = 'public' and table_name = 'model_probe_runs' and column_name = 'vendor_credits'
--              and is_nullable = 'YES' and column_default is null) as column_there,
--   exists (select 1 from pg_constraint where conrelid = 'public.model_probe_runs'::regclass
--            and conname = 'model_probe_runs_vendor_credits_check') as rule_there,
--   not has_function_privilege('authenticated',
--     'public.record_model_probe(text,text,text,text,boolean,text,text,integer,bigint,text,numeric)', 'EXECUTE')
--     and has_function_privilege('service_role',
--     'public.record_model_probe(text,text,text,text,boolean,text,text,integer,bigint,text,numeric)', 'EXECUTE') as service_only,
--   to_regprocedure('public.record_model_probe(text,text,text,text,boolean,text,text,integer,bigint,text)') is not null
--     as old_form_kept;
