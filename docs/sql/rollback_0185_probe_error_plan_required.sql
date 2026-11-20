-- rollback_0185_probe_error_plan_required.sql — takes migration 0185 (the probe log's plan_required word) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT IS LOST: nothing. 0185 only widened one check constraint on public.model_probe_runs.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if the log already holds a row with error_code 'plan_required': the probe log is append-only and
--      0143's rule would not accept that row. Deploy the code without the word first, or keep 0185.
--   1. Puts 0143's check back word for word.
--   2. Asserts the end state: the check is 0143's rule exactly, as Postgres prints it back.

begin;
set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from public.model_probe_runs where error_code = 'plan_required') then
    raise exception 'rollback 0185: the probe log holds plan_required rows, which 0143''s check refuses; keep 0185';
  end if;
end $$;

alter table public.model_probe_runs drop constraint if exists model_probe_runs_error_code_check;
alter table public.model_probe_runs add constraint model_probe_runs_error_code_check
  check ((ok and error_code is null and error is null)
         or (not ok and error_code in ('not_configured', 'auth', 'quota', 'rate_limited', 'bad_request',
                                       'policy', 'not_found', 'unavailable', 'bad_response', 'vendor_tool_unsupported',
                                       'timeout')));

do $$
declare
  def text;
begin
  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c
   where c.conrelid = 'public.model_probe_runs'::regclass and c.conname = 'model_probe_runs_error_code_check';
  if def is distinct from 'CHECK (((ok AND (error_code IS NULL) AND (error IS NULL)) OR ((NOT ok) AND (error_code = ANY (ARRAY[''not_configured''::text, ''auth''::text, ''quota''::text, ''rate_limited''::text, ''bad_request''::text, ''policy''::text, ''not_found''::text, ''unavailable''::text, ''bad_response''::text, ''vendor_tool_unsupported''::text, ''timeout''::text])))))' then
    raise exception 'rollback 0185: model_probe_runs_error_code_check is not 0143''s rule (%)', def;
  end if;
end $$;

commit;
