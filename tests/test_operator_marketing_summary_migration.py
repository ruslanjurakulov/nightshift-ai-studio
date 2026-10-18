"""Migration 0109 (operator_marketing_summary(), the operator bot's read of the brand-channel poster) is ONE read-only
function. These are the checks that need no database: they read the file and fail if it ever grows a second object,
touches an existing one, loses its pinned search_path, is granted to a role that is not the service key, or starts to
return a post's words. The behaviour (who can call it, the counts, no text, replay, rollback) is attacked in
tests/security/test_sec_marketing_summary.py.

Why tests/test_marketing_posts_migration.py (0108's "nothing in the application uses it" allow-list) needed no change:
the bot calls 0109's function and never names a 0108 table or function, so that scan still finds nobody new. The second
test below pins exactly that from the other side: the ONLY place outside the migration, its rollback, the docs and the
tests that names operator_marketing_summary is the operator bot.
"""

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FILE = REPO / "supabase" / "migrations" / "0109_operator_marketing_summary.sql"
SQL = FILE.read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())
ROLLBACK = (REPO / "docs" / "sql" / "rollback_0109_operator_marketing_summary.sql").read_text(encoding="utf-8")
AUDIT_0108 = (REPO / "supabase" / "migrations" / "0108_marketing_posts.sql").read_text(encoding="utf-8")

FUNCTION = "operator_marketing_summary"
#: The keys of the answer (and of last_failure): the whole of what the bot can learn.
ANSWER_KEYS = ["ok", "counts", "used_7d", "max_per_7d", "enabled", "last_sent_at", "last_sent_kind", "last_failure"]
FAILURE_KEYS = ["status", "last_error_code", "kind", "at"]
#: Columns of marketing_posts that are a post's content, identity or destination: none may be returned.
CONTENT_COLUMNS = ("texts", "link", "media_path", "facts", "facts_as_of", "idempotency_key", "source_ref", "content_hash",
                   "approved_hash", "approved_by", "edited_by", "rejected_by", "reject_reason", "provider_message_id",
                   "claimed_by", "target")


def body():
    return re.search(r"create or replace function public\.operator_marketing_summary\(\).*?\n\$\$;", CODE, re.S).group(0)


class OperatorMarketingSummaryMigration(unittest.TestCase):
    def test_the_number_is_free_and_the_file_is_the_next_one(self):
        numbered = sorted(p.name for p in (REPO / "supabase" / "migrations").glob("0109_*.sql"))
        self.assertEqual(numbered, ["0109_operator_marketing_summary.sql"])
        self.assertTrue((REPO / "supabase" / "migrations" / "0108_marketing_posts.sql").exists())

    def test_it_defines_one_function_and_nothing_else(self):
        self.assertEqual(re.findall(r"create or replace function public\.(\w+)", CODE), [FUNCTION])
        for forbidden in (r"create\s+table", r"create\s+trigger", r"create\s+policy", r"create\s+index", r"create\s+(unique\s+)?index",
                          r"\balter\s", r"\bdrop\s", r"\binsert\s", r"\bupdate\s", r"\bdelete\s", r"\btruncate\b",
                          r"audit_action_allowed", r"owner_audit", r"app_audit_log", r"security_events"):
            self.assertIsNone(re.search(forbidden, CODE, re.I), forbidden)
        statements = re.findall(r"(?m)^(set local|do|create or replace function|comment on function|revoke|grant)\b", CODE)
        self.assertEqual(statements, ["set local", "do", "create or replace function", "comment on function", "revoke", "grant"])

    def test_it_is_a_stable_definer_with_a_pinned_search_path_and_no_arguments(self):
        head = body().split("$$")[0]
        self.assertIn("operator_marketing_summary() returns jsonb", head)
        self.assertIn("language plpgsql stable security definer set search_path = public, pg_temp", head)

    def test_only_the_service_key_may_execute_it(self):
        self.assertEqual(re.findall(r"(?m)^revoke\s.*?;", CODE, re.S),
                         [f"revoke all on function public.{FUNCTION}() from public, anon, authenticated, service_role;"])
        self.assertEqual(re.findall(r"(?m)^grant\s.*?;", CODE, re.S),
                         [f"grant execute on function public.{FUNCTION}() to service_role;"])
        self.assertLess(CODE.index("revoke all"), CODE.index("grant execute"))
        # and it does not hand the service key the tables it deliberately cannot read (0108)
        self.assertNotRegex(CODE, r"grant\s+(select|all|insert|update|delete)\b")

    def test_it_reads_only_the_poster_tables_and_the_cap(self):
        reads = set(re.findall(r"\b(?:from|join)\s+(?:unnest\(|public\.)?(\w+)", body()))
        self.assertTrue({"marketing_posts", "marketing_settings"} <= reads)
        self.assertEqual(set(re.findall(r"public\.(\w+)", body())) - {FUNCTION},
                         {"marketing_settings", "marketing_posts", "marketing_cap_used"})

    def test_the_answer_has_exactly_the_documented_keys_and_no_content_column(self):
        build = body()[body().index("return jsonb_build_object("):]
        top = re.findall(r"^\s{4}'(\w+)',", build, re.M)
        self.assertEqual(top, ANSWER_KEYS)
        fail = build[build.index("'last_failure'"):]
        self.assertEqual(re.findall(r"^\s{6}'(\w+)',", fail, re.M), FAILURE_KEYS)
        # nothing a post says, and no identity, is selected at all
        selects = "\n".join(re.findall(r"select\b.*?;", body(), re.S | re.I))
        for column in CONTENT_COLUMNS:
            self.assertNotRegex(selects, rf"\b{column}\b", column)
        self.assertNotRegex(selects, r"select\s+p\.id\b|select\s+\*|\bp\.\*|\bto_jsonb\(|row_to_json")
        # every status is counted, so a status with no post is a measured zero
        for status in ("draft", "approved", "sending", "sent", "failed", "dead", "rejected", "expired"):
            self.assertIn(f"'{status}'", body())

    def test_it_writes_nothing(self):
        self.assertIsNone(re.search(r"\b(insert|update|delete|truncate|perform|raise|set_config|pg_advisory)\b", body(), re.I))

    def test_it_is_dormant_and_additive_and_the_guard_names_only_what_0108_made(self):
        self.assertRegex(CODE, r"(?m)^set local lock_timeout = '5s';")
        self.assertNotRegex(CODE, r"(?m)^set (?!local)")
        for needle in ("to_regclass('public.marketing_posts') is null", "to_regclass('public.marketing_settings') is null",
                       "to_regprocedure('public.marketing_cap_used()') is null"):
            self.assertIn(needle, CODE)
        for obj in ("marketing_posts", "marketing_settings", "marketing_cap_used"):
            self.assertRegex(AUDIT_0108, rf"(table if not exists|function) public\.{obj}\b")
        self.assertIn("0108", re.search(r"raise exception '([^']*)'", CODE).group(1))

    def test_the_header_and_the_verify_block_are_there(self):
        for needle in ("APPLYING THIS FILE CHANGES THE LIVE DATABASE", "Verify (run as the SQL editor", "ROLLBACK (owner-applied",
                       "rollback_0109_operator_marketing_summary.sql"):
            self.assertIn(needle, SQL)

    def test_the_rollback_drops_exactly_the_function(self):
        code = "\n".join(line.split("--", 1)[0] for line in ROLLBACK.splitlines())
        self.assertEqual([s.strip() for s in code.split(";") if s.strip()],
                         ["begin", f"drop function if exists public.{FUNCTION}()", "commit"])

    def test_only_the_operator_bot_names_the_function_outside_the_migration_docs_and_tests(self):
        skip = {"node_modules", ".next", "__pycache__", ".git"}
        users = set()
        for root in ("command-center/app", "command-center/lib", "command-center/components", "modules", "tools", "main.py",
                     "supabase/functions", ".github", "deploy"):
            base = REPO / root
            files = [base] if base.is_file() else [p for p in base.rglob("*") if p.is_file() and not skip & set(p.parts)] if base.exists() else []
            for p in files:
                if p.suffix in (".ts", ".tsx", ".py", ".js", ".yml", ".yaml", ".sql", ".sh", ".json") and \
                        FUNCTION in p.read_text(encoding="utf-8", errors="ignore"):
                    users.add(str(p.relative_to(REPO)))
        self.assertIn("modules/operator_bot/sources.py", users)           # the one call
        self.assertTrue(all(u.startswith("modules/operator_bot/") for u in users), sorted(users))


if __name__ == "__main__":
    unittest.main()
