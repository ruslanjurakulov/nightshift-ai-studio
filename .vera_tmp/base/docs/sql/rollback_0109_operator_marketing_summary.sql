-- rollback_0109_operator_marketing_summary.sql — takes migration 0109 out again. OWNER-APPLY: paste into the
-- Supabase SQL editor. Nothing in the app runs it.
--
-- WHEN YOU NEED IT. Almost never: 0109 is one read-only function and changes no data. After this file the operator
-- bot's /marketing answers "not available yet" and its marketing alerts send nothing; every other command works.
--
-- WHAT IT DOES. Drops operator_marketing_summary(). It touches nothing else: 0109 changed no table, policy, grant,
-- trigger or other function (0108's objects and audit_action_allowed(text) are as they were).
--
-- tests/security/test_sec_marketing_summary.py applies this file to the lab database and then re-applies 0109.

begin;

drop function if exists public.operator_marketing_summary();

commit;
