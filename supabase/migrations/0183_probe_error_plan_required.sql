-- 0183_probe_error_plan_required.sql — the probe log accepts one more typed failure word: plan_required.
--
-- *** LIVE ON APPLY. *** Merging this file applies it to the live database. It replaces ONE check constraint on
-- public.model_probe_runs (model_probe_runs_error_code_check, 0035 / 0143) with the same rule plus one word. No table, column, row,
-- function, trigger, grant or policy changes.
--
-- WHY. A real ElevenLabs call on 2026-11-20 was answered HTTP 402 {"detail":{"type":"payment_required","code":"paid_plan_required"}}:
-- the account is on the free plan and the voice asked for was a library voice. 402 is also ElevenLabs' status for an empty balance,
-- which needs the opposite fix (topping up a free plan does not unlock library voices). modules/capabilities/base.py now has a typed
-- code for the plan (E_PLAN_REQUIRED, in ERROR_CODES), matched on ElevenLabs' own code, not the status. record_model_probe (0035)
-- inserts the code as given, and the check lists the codes word for word: without this file, a probe failing with the new word could
-- not be recorded at all.
--
-- WHAT ELSE STORES THE WORD, unchanged by this file: creative_jobs.error_code (0036) takes any ^[a-z0-9_]{1,64}$ word; a region edit
-- maps a word it does not list to provider_error (modules/creative_worker.py region_report_code); the router's failover (0075 / 0088)
-- does not list it, so a plan refusal is never failed over (another model on the same account has the same plan).
--
-- WHAT TO VERIFY BEFORE YOU APPLY: nothing can be lost. The new rule accepts every row the old rule accepted (it only adds a word), so
-- the constraint validates against the existing log.
--
-- APPLY AS ONE TRANSACTION (SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1): `set local lock_timeout`
-- only holds inside one. The table is append-only and small; the lock is held for the validation only.
--
-- NUMBER. 0183, after 0182 (the last file on main when this was written); 0175-0181 are left to the work that reserved them.
--
-- UNDO: docs/sql/rollback_0183_probe_error_plan_required.sql (owner-applied).

set local lock_timeout = '5s';

-- 1. The check: the capability layer's typed codes (modules/capabilities/base.py ERROR_CODES) and the probe tool's own 'timeout'.
alter table public.model_probe_runs drop constraint if exists model_probe_runs_error_code_check;
alter table public.model_probe_runs add constraint model_probe_runs_error_code_check
  check ((ok and error_code is null and error is null)
         or (not ok and error_code in ('not_configured', 'auth', 'quota', 'rate_limited', 'bad_request',
                                       'policy', 'not_found', 'unavailable', 'bad_response', 'vendor_tool_unsupported',
                                       'plan_required', 'timeout')));

-- 2. Verify: the constraint is exactly the rule above, as Postgres prints it back (the 0143 form plus one word), so a word that is
--    missing, misspelt or extra stops the transaction.
do $$
declare
  def text;
begin
  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c
   where c.conrelid = 'public.model_probe_runs'::regclass and c.conname = 'model_probe_runs_error_code_check';
  if def is distinct from 'CHECK (((ok AND (error_code IS NULL) AND (error IS NULL)) OR ((NOT ok) AND (error_code = ANY (ARRAY[''not_configured''::text, ''auth''::text, ''quota''::text, ''rate_limited''::text, ''bad_request''::text, ''policy''::text, ''not_found''::text, ''unavailable''::text, ''bad_response''::text, ''vendor_tool_unsupported''::text, ''plan_required''::text, ''timeout''::text])))))' then
    raise exception '0183: model_probe_runs_error_code_check is not the expected rule (%)', def;
  end if;
end $$;
