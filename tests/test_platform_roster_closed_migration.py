"""Migration 0233: nobody changes the platform roster from a browser (BR-L-213). Static checks of the file, its rollback and the
Command Center that no longer calls what it closes; the live attacks are in tests/security/test_sec_roster_closed_0233.py.

What would break without these: the file growing a drop or a replaced body (the brief allows privileges only), a revoke that
also takes SELECT (platform_role and Approvals read the roster), a backslash the live apply path rewrites, or the dashboard
still calling a function that is now refused (a button that always fails).
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
MIG = REPO / "supabase" / "migrations" / "0233_platform_roster_closed.sql"
ROLLBACK = REPO / "docs" / "sql" / "rollback_0233_platform_roster_closed.sql"
TEXT = MIG.read_text(encoding="utf-8")
ROLLBACK_TEXT = ROLLBACK.read_text(encoding="utf-8")
ROSTER_FUNCTIONS = ("owner_add_member", "owner_set_member_role", "owner_remove_member")


def code(text: str) -> str:
    """The SQL with every `--` comment cut (no literal in these files holds two dashes)."""
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines()).lower()


class PlatformRosterClosedMigration(unittest.TestCase):
    def test_one_file_holds_the_number(self):
        self.assertEqual(len(list(MIG.parent.glob("0233_*.sql"))), 1)

    def test_it_revokes_execute_on_the_three_roster_functions_from_every_browser_role(self):
        for fn in ROSTER_FUNCTIONS:
            self.assertRegex(code(TEXT), rf"revoke all on function public\.{fn}\([^)]*\) from public, anon, authenticated;", fn)

    def test_it_revokes_the_direct_writes_and_keeps_select(self):
        sql = code(TEXT)
        self.assertIn("revoke insert, update, delete on public.app_members from anon, authenticated;", sql)
        self.assertNotRegex(sql, r"revoke[^;]*select[^;]*app_members")
        self.assertNotRegex(sql, r"revoke[^;]*service_role")
        self.assertIn("has_table_privilege('authenticated', 'public.app_members', 'select')", sql)

    def test_privileges_only_nothing_dropped_replaced_or_granted(self):
        sql = code(TEXT)
        for word in ("drop ", "create or replace", "create table", "create policy", "alter table", "alter function", "grant ",
                     "insert into", "update public.", "delete from"):
            self.assertNotIn(word, sql, word)

    def test_it_has_an_end_state_check_and_a_verify_block_and_no_backslash(self):
        self.assertIn("0233 end state:", TEXT)
        self.assertIn("-- Verify", TEXT)
        self.assertIn("APPLY AS ONE TRANSACTION", TEXT)
        self.assertIn("set local lock_timeout", code(TEXT))
        self.assertNotIn("\\", TEXT)
        self.assertNotIn("\\", ROLLBACK_TEXT)

    def test_the_end_state_names_the_fix_when_the_workspace_side_is_open(self):
        self.assertIn("apply 0091 again, then this file", TEXT)

    def test_the_rollback_is_one_transaction_and_reopens_only_what_0233_closed(self):
        self.assertRegex(ROLLBACK_TEXT, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK_TEXT)), 1)
        sql = code(ROLLBACK_TEXT)
        for fn in ROSTER_FUNCTIONS:
            self.assertRegex(sql, rf"grant execute on function public\.{fn}\([^)]*\) to authenticated;", fn)
        self.assertIn("grant insert, update, delete on public.app_members to anon, authenticated;", sql)
        self.assertNotRegex(sql, r"grant[^;]*to[^;]*(public|service_role)\b[^.]")
        self.assertNotIn("drop ", sql)

    def test_the_command_center_calls_no_roster_function_and_writes_no_roster_row(self):
        cc = REPO / "command-center"
        bad = []
        for sub in ("app", "components", "lib"):
            for p in (cc / sub).rglob("*.ts*"):
                src = p.read_text(encoding="utf-8")
                if any(fn in src for fn in ROSTER_FUNCTIONS):
                    bad.append(f"{p.relative_to(REPO)}: roster function")
                if re.search(r"""from\(\s*["'`]app_members["'`]\s*\)\s*\.\s*(insert|update|delete|upsert)""", src):
                    bad.append(f"{p.relative_to(REPO)}: app_members write")
        self.assertEqual(bad, [])
        self.assertFalse((cc / "app" / "api" / "owner" / "team").exists())
        self.assertFalse((cc / "components" / "members").exists())


if __name__ == "__main__":
    unittest.main()
