"""The audit trail's list of actions is the application's own list (0087).

Migration 0087's ``audit_action_allowed`` refuses an action the Command Center
does not write, and ``lib/server/audit.ts`` swallows a failed audit write by
design: a ``logAudit({ action: "new.thing" })`` added without a line in the
migration is a silently lost audit row. This reads the sources and the
migration and fails on the difference. The database half (what the function
accepts and refuses, who the row names) is tests/security/test_sec_breach_audit.py.
"""

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
COMMAND_CENTER = REPO / "command-center"
MIGRATION = REPO / "supabase" / "migrations" / "0087_audit_and_rate_hardening.sql"

ACTION = re.compile(
    r"""action:\s*(?:[^"'`,}]*?\?\s*)?["'`]([A-Za-z_.${}]+)["'`](?:\s*:\s*["'`]([A-Za-z_.${}]+)["'`])?""")


def database_actions():
    text = MIGRATION.read_text(encoding="utf-8")
    block = re.search(r"coalesce\(p_action, ''\) = any \(array\[(.*?)\]::text\[\]\)", text, re.S).group(1)
    return set(re.findall(r"'([a-z_.]+)'", block))


def logged_actions():
    seen = set()
    for root in ("app", "lib"):
        for path in (COMMAND_CENTER / root).rglob("*.ts*"):
            text = path.read_text(encoding="utf-8")
            if "logAudit" not in text:
                continue
            for call in re.finditer(r"logAudit\(\{(.*?)\}\)", text, re.S):
                for pair in ACTION.findall(call.group(1)):
                    seen.update(a for a in pair if a)
    return seen


class AuditActions(unittest.TestCase):
    def test_every_action_the_command_center_logs_is_in_the_database_list(self):
        literal = {a for a in logged_actions() if "$" not in a}
        self.assertGreaterEqual(len(literal), 40, f"the scan found too few actions: {sorted(literal)}")
        self.assertEqual(sorted(literal - database_actions()), [],
                         "logAudit actions the database would refuse (add them to audit_action_allowed in a migration)")

    def test_the_actions_the_sql_functions_write_themselves_are_in_the_list(self):
        written = set()
        for path in (REPO / "supabase" / "migrations").glob("*.sql"):
            text = path.read_text(encoding="utf-8")
            for insert in re.finditer(r"insert into public\.app_audit_log.*?values\s*\((.*?)\)\s*;", text, re.S | re.I):
                written.update(re.findall(r"'([a-z_]+\.[a-z_.]+)'", insert.group(1)))
        self.assertTrue({"api_key.create", "api.activate"} <= written, sorted(written))
        self.assertEqual(sorted(written - database_actions()), [])

    def test_the_value_built_actions_are_covered_by_the_two_patterns(self):
        built = {a for a in logged_actions() if "$" in a}
        self.assertEqual(sorted(built), ["learning.${parsed.decision}", "social.${account.platform}.disconnect"])
        connect = (COMMAND_CENTER / "lib" / "server" / "social-connect.ts").read_text(encoding="utf-8")
        self.assertIn("`social.${platform}.connect`", connect)
        self.assertIn("`social.${platform}.connect_failed`", connect)
        platforms = (COMMAND_CENTER / "lib" / "social-accounts.ts").read_text(encoding="utf-8")
        self.assertIn('SOCIAL_PLATFORMS = ["instagram", "tiktok"]', platforms,
                      "a platform was added: extend audit_action_allowed")
        learnings = (COMMAND_CENTER / "lib" / "learnings.ts").read_text(encoding="utf-8")
        self.assertIn('b.decision !== "approve" && b.decision !== "reject"', learnings,
                      "a decision was added: extend audit_action_allowed")
        text = MIGRATION.read_text(encoding="utf-8")
        self.assertIn(r"'^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'", text)
        self.assertIn(r"'^learning\.(approve|reject)$'", text)


if __name__ == "__main__":
    unittest.main()
