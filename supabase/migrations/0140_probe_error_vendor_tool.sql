-- 0140_probe_error_vendor_tool.sql — the probe log accepts one more typed failure word: vendor_tool_unsupported.
--
-- *** LIVE ON APPLY. *** Merging this file applies it to the live database. It replaces ONE check constraint on
-- public.model_probe_runs (model_probe_runs_error_code_check, 0035) with the same rule plus one word. No table, column, row, function,
-- trigger, grant or policy changes.
--
-- WHY. The first real probe of grounded-image-1.0 (Actions "Probe models", run 43286239903, 2026-11-12) was answered HTTP 400
-- "Unsupported tool type: 'image_generation'" with param "tools": the vendor refused the tool that carries the aspect ratio, not the
-- prompt. modules/capabilities/base.py now has a typed code for that answer (E_VENDOR_TOOL_UNSUPPORTED, in ERROR_CODES), so the Studio
-- and the probe log name the reason instead of a generic bad_request. record_model_probe (0035) inserts the code as given, and 0035's
-- check lists the codes word for word: without this file, a probe failing with the new word could not be recorded at all.
--
-- WHAT ELSE STORES THE WORD, unchanged by this file: creative_jobs.error_code (0036) takes any ^[a-z0-9_]{1,64}$ word; a region edit
-- maps a word it does not list to provider_error (modules/creative_worker.py region_report_code); the router's failover (0075 / 0088)
-- treats it as it treats bad_request, a refusal that is never failed over.
--
-- WHAT TO VERIFY BEFORE YOU APPLY: nothing can be lost. The new rule accepts every row the old rule accepted (it only adds a word), so
-- the constraint validates against the existing log.
--
-- APPLY AS ONE TRANSACTION (SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1): `set local lock_timeout`
-- only holds inside one. The table is append-only and small; the lock is held for the validation only.
--
-- UNDO: docs/sql/rollback_0140_probe_error_vendor_tool.sql (owner-applied).

set local lock_timeout = '5s';

-- 1. The check: the capability layer's typed codes (modules/capabilities/base.py ERROR_CODES) and the probe tool's own 'timeout'.
alter table public.model_probe_runs drop constraint if exists model_probe_runs_error_code_check;
alter table public.model_probe_runs add constraint model_probe_runs_error_code_check
  check ((ok and error_code is null and error is null)
         or (not ok and error_code in ('not_configured', 'auth', 'quota', 'rate_limited', 'bad_request',
                                       'policy', 'not_found', 'unavailable', 'bad_response', 'vendor_tool_unsupported',
                                       'timeout')));

-- 2. The end state: the constraint exists and accepts the new word.
do $$
declare
  def text;
begin
  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c
   where c.conrelid = 'public.model_probe_runs'::regclass and c.conname = 'model_probe_runs_error_code_check';
  if def is null or position('vendor_tool_unsupported' in def) = 0 then
    raise exception '0140: model_probe_runs_error_code_check does not accept vendor_tool_unsupported (%)', def;
  end if;
end $$;
