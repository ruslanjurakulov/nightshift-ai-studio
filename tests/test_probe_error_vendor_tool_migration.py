"""supabase/migrations/0143_probe_error_vendor_tool.sql — the probe log accepts every typed code the adapters can raise.

What would break without these tests: a code added to ``ERROR_CODES`` (modules/capabilities/base.py) that the probe log's check
constraint refuses. ``record_model_probe`` (0035) inserts the code as given, so the probe of a model failing with that code could not
be recorded at all, and the workflow would stop on the database error instead of naming the reason.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from modules.capabilities.base import E_VENDOR_TOOL_UNSUPPORTED, ERROR_CODES

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
TEXT = (MIG / "0143_probe_error_vendor_tool.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0143_probe_error_vendor_tool.sql").read_text(encoding="utf-8")
M0035 = (MIG / "0035_model_registry.sql").read_text(encoding="utf-8")
NAME = "model_probe_runs_error_code_check"


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def words(sql: str) -> set:
    m = re.search(rf"add constraint {NAME}\s+check \((.*?)\);", code(sql), re.S)
    assert m, NAME
    return set(re.findall(r"'([a-z0-9_]+)'", m.group(1)))


def ordered(sql: str) -> list:
    m = re.search(rf"add constraint {NAME}\s+check \((.*?)\);", code(sql), re.S)
    assert m, NAME
    return re.findall(r"'([a-z0-9_]+)'", m.group(1))


def printed(sql: str) -> list:
    """The words of the end-state assert: ``def is distinct from 'CHECK (... ARRAY[''word''::text, ...])'``."""
    m = re.search(r"if def is distinct from '(CHECK .*?)' then", code(sql))
    assert m, "the end-state assert compares the whole printed rule"
    return re.findall(r"''([a-z0-9_]+)''::text", m.group(1))


def newest() -> str:
    found = None
    for path in sorted(MIG.glob("*.sql")):
        if re.search(rf"add constraint {NAME}\b", code(path.read_text(encoding="utf-8"))):
            found = path
    assert found, NAME
    return found.name


class Check(unittest.TestCase):
    def test_the_newest_check_lists_exactly_the_adapter_codes_and_the_probe_tools_timeout(self):
        # 0187 widened the check again (plan_required); the newest file is the one that must match the adapters.
        newest_text = (MIG / newest()).read_text(encoding="utf-8")
        self.assertEqual(words(newest_text), set(ERROR_CODES) | {"timeout"})
        self.assertIn(E_VENDOR_TOOL_UNSUPPORTED, words(TEXT))

    def test_it_only_adds_the_word_to_0035s_rule(self):
        self.assertEqual(words(TEXT) - words(M0035), {"vendor_tool_unsupported"})
        self.assertEqual(words(M0035) - words(TEXT), set())
        self.assertIn("check ((ok and error_code is null and error is null)", TEXT)

    def test_it_changes_nothing_but_that_constraint(self):
        body = code(TEXT)
        self.assertEqual(re.findall(r"(?i)alter table\s+([\w.]+)", body), ["public.model_probe_runs"] * 2)
        for verb in ("create table", "create or replace function", "create function", "grant ", "revoke ", "create policy",
                     "drop table", "drop function", "insert into", "update public", "delete from"):
            self.assertNotIn(verb, body.lower(), verb)

    def test_the_file_says_it_is_live_on_apply_and_one_transaction_and_checks_its_end_state(self):
        self.assertIn("LIVE ON APPLY", TEXT)
        self.assertIn("APPLY AS ONE TRANSACTION", TEXT)
        self.assertIn("set local lock_timeout", code(TEXT))
        # The end state is the whole rule as Postgres prints it back, the same words in the same order as the add constraint.
        self.assertEqual(printed(TEXT), ordered(TEXT))

    def test_the_printed_rule_lists_the_same_words_as_the_constraint(self):
        self.assertEqual(set(printed(TEXT)), words(TEXT))
        self.assertEqual(set(printed(ROLLBACK)), words(ROLLBACK))
        self.assertEqual(printed(ROLLBACK), ordered(ROLLBACK))


class Rollback(unittest.TestCase):
    def test_the_rollback_is_one_transaction_refuses_rows_it_would_orphan_and_restores_0035s_words(self):
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)
        self.assertIn("where error_code = 'vendor_tool_unsupported'", ROLLBACK)
        self.assertEqual(words(ROLLBACK), words(M0035))


if __name__ == "__main__":
    unittest.main()
