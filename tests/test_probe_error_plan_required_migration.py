"""supabase/migrations/0185_probe_error_plan_required.sql — the probe log accepts the plan_required code.

What would break without these tests: E_PLAN_REQUIRED (modules/capabilities/base.py) raised by a probe whose account's plan does
not allow the request, and ``record_model_probe`` (0035) refused by the check constraint, so the probe could not be recorded and the
workflow stopped on a database error instead of naming the plan; or 0185 changing anything beyond that one constraint.
"""

from __future__ import annotations

import re
import unittest

from modules.capabilities.base import E_PLAN_REQUIRED, ERROR_CODES
from tests.test_probe_error_vendor_tool_migration import MIG, ROOT, code, newest, ordered, printed, words

TEXT = (MIG / "0185_probe_error_plan_required.sql").read_text(encoding="utf-8")
M0143 = (MIG / "0143_probe_error_vendor_tool.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0185_probe_error_plan_required.sql").read_text(encoding="utf-8")


class Check(unittest.TestCase):
    def test_it_is_the_newest_check_and_lists_exactly_the_adapter_codes(self):
        self.assertEqual(newest(), "0185_probe_error_plan_required.sql")
        self.assertEqual(words(TEXT), set(ERROR_CODES) | {"timeout"})
        self.assertIn(E_PLAN_REQUIRED, words(TEXT))

    def test_it_only_adds_the_word_to_0143s_rule(self):
        self.assertEqual(words(TEXT) - words(M0143), {"plan_required"})
        self.assertEqual(words(M0143) - words(TEXT), set())

    def test_it_changes_nothing_but_that_constraint(self):
        body = code(TEXT)
        self.assertEqual(re.findall(r"(?i)alter table\s+([\w.]+)", body), ["public.model_probe_runs"] * 2)
        for verb in ("create table", "create or replace function", "create function", "grant ", "revoke ", "create policy",
                     "drop table", "drop function", "insert into", "update public", "delete from"):
            self.assertNotIn(verb, body.lower(), verb)

    def test_it_is_live_on_apply_one_transaction_and_verifies_its_end_state(self):
        self.assertIn("LIVE ON APPLY", TEXT)
        self.assertIn("APPLY AS ONE TRANSACTION", TEXT)
        self.assertIn("set local lock_timeout", code(TEXT))
        self.assertEqual(printed(TEXT), ordered(TEXT))


class Rollback(unittest.TestCase):
    def test_the_rollback_refuses_rows_it_would_orphan_and_restores_0143s_words(self):
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)
        self.assertIn("where error_code = 'plan_required'", ROLLBACK)
        self.assertEqual(words(ROLLBACK), words(M0143))
        self.assertEqual(printed(ROLLBACK), ordered(ROLLBACK))


if __name__ == "__main__":
    unittest.main()
