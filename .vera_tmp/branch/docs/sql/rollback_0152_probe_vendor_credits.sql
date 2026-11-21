-- rollback_0152_probe_vendor_credits.sql — takes migration 0152 (the probe log's vendor_credits) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT IS LOST: the vendor-reported credits of every probe recorded since 0152 (the column is dropped with its values). The probes
-- themselves stay: model_probe_runs is append-only and no row is deleted.
--
-- ORDER: deploy a probe tool that no longer sends p_vendor_credits first, or keep 0152. A tool that still sends it would get 404 on the
-- eleven-argument call and record the probe through 0035's ten-argument form (tools/probe_models.py), so nothing breaks, but every
-- probe would log that its figure was not stored.
--
-- WHAT IT DOES, in one transaction:
--   1. Drops the eleven-argument record_model_probe (0035's ten-argument form is untouched).
--   2. Drops the check constraint and the column.
--   3. Asserts the end state.

begin;
set local lock_timeout = '5s';

drop function if exists public.record_model_probe(text, text, text, text, boolean, text, text, integer, bigint, text, numeric);
alter table public.model_probe_runs drop constraint if exists model_probe_runs_vendor_credits_check;
alter table public.model_probe_runs drop column if exists vendor_credits;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'model_probe_runs' and column_name = 'vendor_credits') then
    raise exception 'rollback 0152: model_probe_runs.vendor_credits is still there';
  end if;
  if to_regprocedure('public.record_model_probe(text, text, text, text, boolean, text, text, integer, bigint, text)') is null then
    raise exception 'rollback 0152: 0035''s record_model_probe is missing';
  end if;
end $$;

commit;
