"""Migration 0169 (an API download audits a name the audit list has), pinned as text.

What would break, and which test says so:

* the function drifting from 0147's while the name is changed (a price, hold or refusal silently altered): 0169's
  api_request_download must be 0147's body plus exactly the one hunk listed here, byte for byte;
* the fix turning into a wider audit list: 0169 defines nothing but api_request_download, and no migration adds
  'video.download' to audit_action_allowed;
* md5 pins that no longer describe the files, grants that are not 0147's, a rollback that does not put 0147's body back
  verbatim, the number not documented.

The lab (tests/security/test_sec_api_download.py) runs the same file on a real PostgreSQL; this test needs none.
"""

from __future__ import annotations

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
M0147 = (MIG / "0147_mcp_free_tier.sql").read_text(encoding="utf-8")
M0169 = (MIG / "0169_api_download_audit.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0169_api_download_audit.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
SITE_ROUTE = (ROOT / "command-center" / "app" / "api" / "downloads" / "route.ts").read_text(encoding="utf-8")

SIG = "public.api_request_download(text, text, text, text, text, text)"
BODY_0147 = "055003f8a2fb5390bbd1b5f7820e6e2e"
BODY_0169 = "45fbea9ff56a77c0144993c43a4451da"
HUNK = (
    "    perform public.api_audit(ctx, 'video.download', p_video_id, v_ch,\n",
    "    -- 0169: the name 0087's audit list has and the site's download route writes; 'video.download' was refused (500).\n"
    "    perform public.api_audit(ctx, 'video.download_request', p_video_id, v_ch,\n",
)


def definition(text: str, name: str) -> str:
    m = re.search(rf"^create or replace function public\.{re.escape(name)}\(.*?^\$\$;$", text, re.S | re.M)
    assert m, name
    return m.group(0)


def pg_md5(defn: str) -> str:
    """md5(regexp_replace(prosrc, '\\s+', ' ', 'g')), the hash every drift guard in this repository uses."""
    body = defn.split("as $$", 1)[1].rsplit("$$;", 1)[0]
    return hashlib.md5(re.sub(r"[ \t\n\r\f\v]+", " ", body).encode()).hexdigest()


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


class BuiltOn0147(unittest.TestCase):
    def test_the_function_is_0147s_body_plus_the_one_hunk(self):
        before = definition(M0147, "api_request_download")
        self.assertEqual(before.count(HUNK[0]), 1)
        self.assertEqual(definition(M0169, "api_request_download"), before.replace(HUNK[0], HUNK[1]))

    def test_no_migration_between_0147_and_0169_redefines_it(self):
        later = [p.name for p in sorted(MIG.glob("*.sql"))
                 if "0147" < p.name[:4] < "0169"
                 and re.search(r"create or replace function public\.api_request_download\(", p.read_text(encoding="utf-8"))]
        self.assertEqual(later, [], "api_request_download was redefined after 0147: rebuild 0169 on the newer body")

    def test_it_defines_only_that_function_and_changes_no_table(self):
        self.assertEqual(re.findall(r"create or replace function public\.(\w+)\(", code(M0169)), ["api_request_download"])
        outside = code(M0169.replace(definition(M0169, "api_request_download"), ""))
        self.assertNotRegex(outside, r"(?i)\b(create\s+table|alter\s+table|create\s+policy|create\s+trigger|drop\s+\w+|insert\s+into|update\s+public|delete\s+from)\b")

    def test_the_md5_pins_describe_the_bodies(self):
        self.assertEqual(pg_md5(definition(M0147, "api_request_download")), BODY_0147)
        self.assertEqual(pg_md5(definition(M0169, "api_request_download")), BODY_0169)
        self.assertGreaterEqual(M0169.count(BODY_0147), 2, "header and drift guard name 0147's body")
        self.assertGreaterEqual(M0169.count(BODY_0169), 4, "header, drift guard, end state and Verify name 0169's body")

    def test_the_grants_are_0147s_anon_only(self):
        self.assertIn(f"revoke all on function {SIG} from public, anon, authenticated, service_role;", M0169)
        self.assertEqual(re.findall(r"grant execute on function (.*?);", code(M0169)), [f"{SIG} to anon"])
        self.assertIn("language plpgsql volatile security definer set search_path = public, pg_temp as $$",
                      definition(M0169, "api_request_download"))


class TheNameIsTheSitesAndTheListIsNotWidened(unittest.TestCase):
    def test_the_api_writes_the_name_the_sites_download_route_writes(self):
        self.assertIn('action: "video.download_request"', SITE_ROUTE)
        body = definition(M0169, "api_request_download")
        self.assertEqual(re.findall(r"api_audit\(ctx, '([a-z_.]+)'", body), ["video.download_request"])

    def test_no_migration_puts_the_old_name_on_the_audit_list(self):
        for p in sorted(MIG.glob("*.sql")):
            text = p.read_text(encoding="utf-8")
            for m in re.finditer(r"create or replace function public\.audit_action_allowed\(.*?^\$\$;$", text, re.S | re.M):
                self.assertNotIn("'video.download'", m.group(0), p.name)
                self.assertIn("'video.download_request'", m.group(0), p.name)


class TheRollbackAndTheDoc(unittest.TestCase):
    def test_the_rollback_puts_0147s_body_back_verbatim_with_its_grants(self):
        self.assertEqual(definition(ROLLBACK, "api_request_download"), definition(M0147, "api_request_download"))
        self.assertIn(BODY_0169, ROLLBACK)
        self.assertIn(BODY_0147, ROLLBACK)
        self.assertEqual(re.findall(r"grant execute on function (.*?);", code(ROLLBACK)), [f"{SIG} to anon"])
        self.assertTrue(ROLLBACK.rstrip().endswith("commit;") and "\nbegin;\n" in ROLLBACK)

    def test_the_file_says_how_to_apply_verify_and_undo(self):
        self.assertIn("APPLY AS ONE TRANSACTION", M0169)
        self.assertIn("set local lock_timeout = '5s';", M0169)
        self.assertIn("-- Verify (run after applying", M0169)
        self.assertIn("rollback_0169_api_download_audit.sql", M0169)
        self.assertIn("0169, provisional", M0169)

    def test_the_migration_is_documented(self):
        self.assertIn("(0169)", MIGRATIONS_DOC)
        self.assertIn("0169_api_download_audit.sql", MIGRATIONS_DOC)
        self.assertIn("rollback_0169_api_download_audit.sql", MIGRATIONS_DOC)


if __name__ == "__main__":
    unittest.main()
