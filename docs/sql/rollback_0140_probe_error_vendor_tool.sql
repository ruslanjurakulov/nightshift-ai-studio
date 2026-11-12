-- rollback_0140_probe_error_vendor_tool.sql — takes migration 0140 (the probe log's vendor_tool_unsupported word) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT IS LOST: nothing. 0140 only widened one check constraint on public.model_probe_runs.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if the log already holds a row with error_code 'vendor_tool_unsupported': the probe log is append-only
--      and 0035's rule would not accept that row. Deploy the code without the word first, or keep 0140.
--   1. Puts 0035's check back word for word.
--   2. Asserts the end state: the check no longer accepts the word.

begin;
set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from public.model_probe_runs where error_code = 'vendor_tool_unsupported') then
    raise exception 'rollback 0140: the probe log holds vendor_tool_unsupported rows, which 0035''s check refuses; keep 0140';
  end if;
end $$;

alter table public.model_probe_runs drop constraint if exists model_probe_runs_error_code_check;
alter table public.model_probe_runs add constraint model_probe_runs_error_code_check
  check ((ok and error_code is null and error is null)
         or (not ok and error_code in ('not_configured', 'auth', 'quota', 'rate_limited', 'bad_request',
                                       'policy', 'not_found', 'unavailable', 'bad_response', 'timeout')));

do $$
declare
  def text;
begin
  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c
   where c.conrelid = 'public.model_probe_runs'::regclass and c.conname = 'model_probe_runs_error_code_check';
  if def is null or position('vendor_tool_unsupported' in def) > 0 then
    raise exception 'rollback 0140: model_probe_runs_error_code_check is not 0035''s rule (%)', def;
  end if;
end $$;

commit;
