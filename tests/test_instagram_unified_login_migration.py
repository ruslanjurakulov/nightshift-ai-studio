"""supabase/migrations/0197_instagram_unified_login.sql — Instagram through Unified Login, old connections kept.

Static checks of the file; the behaviour against a real Postgres is tests/security/test_sec_instagram_unified_login.py."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0197_instagram_unified_login.sql").read_text()
CODE = "\n".join(line for line in SQL.splitlines() if not line.lstrip().startswith("--"))
OLD = (ROOT / "supabase" / "migrations" / "0028_social_accounts.sql").read_text()


def store_body(sql: str) -> str:
    return sql.split("function public.store_social_account(", 1)[1].split("$$;", 1)[0]


class Migration0197(unittest.TestCase):
    def test_is_the_next_number(self):
        numbers = sorted(int(p.name[:4]) for p in (ROOT / "supabase" / "migrations").glob("[0-9][0-9][0-9][0-9]_*.sql"))
        self.assertEqual(numbers[-1], 197)
        self.assertEqual(numbers.count(197), 1)

    def test_is_additive_and_keeps_every_existing_row(self):
        self.assertNotRegex(CODE, r"\bdrop (table|function|column|policy)\b")
        # Old Instagram Login rows are kept and marked only by the absence of the new value: no update, no delete.
        self.assertNotRegex(CODE, r"\bupdate public\.social_accounts\b(?! as)")
        self.assertNotRegex(CODE, r"\bdelete from public\.social_accounts\b")
        self.assertIn("add column if not exists auth_flow", CODE)

    def test_no_token_column_and_no_new_reader(self):
        for col in re.findall(r"add column if not exists (\w+)", CODE):
            self.assertNotRegex(col, r"token|secret")
        self.assertEqual(re.findall(r"create or replace function (public\.\w+)", CODE), ["public.store_social_account"])

    def test_store_keeps_0028s_checks(self):
        body = store_body(CODE)
        for needle in ("if me is null then", "not public.is_org_member(p_org_id, 'editor')",
                       "granted <@ public.social_allowed_scopes(p_platform)", "meta has an unknown key",
                       "public.social_put_secret(", "on conflict (org_id, platform, external_id)"):
            self.assertIn(needle, body, needle)
        self.assertIn("set search_path = ''", CODE.split("function public.store_social_account(", 1)[1].split("$$", 1)[0])
        ret = body.rsplit("return jsonb_build_object(", 1)[1]
        self.assertNotRegex(ret, r"token|secret|config|business")

    def test_instagram_must_come_from_unified_login(self):
        body = store_body(CODE)
        self.assertIn("if flow is distinct from 'unified_login' then", body)
        self.assertIn("the Unified Login configuration id is required", body)
        self.assertIn("for Instagram only", body)

    def test_only_marked_hunks_differ_from_0028(self):
        def norm(text):
            text = re.sub(r"\s*-- 0197: the last three", "", text)
            text = text.replace(",\n                     'auth_flow', 'client_business_id', 'config_id')", ")")
            text = text.replace(",\n    auth_flow, client_business_id, config_id)", ")")
            text = text.replace(",\n    flow, biz, cfg)", ")")
            text = re.sub(r"[ \t]*-- 0197[^\n]*\n.*?-- /0197\n", "", text, flags=re.S)
            return re.sub(r"\s+", " ", text).strip()
        self.assertEqual(norm(store_body(SQL)), norm(store_body(OLD)))

    def test_grant_is_0028s(self):
        self.assertIn("grant execute on function public.store_social_account(uuid, text, text, text, jsonb) to authenticated;",
                      CODE)
        self.assertEqual(len(re.findall(r"^grant ", CODE, re.M)), 1)

    def test_drift_guard_and_verify_block(self):
        hashes = set(re.findall(r"'([0-9a-f]{32})'", CODE))
        self.assertEqual(len(hashes), 2, hashes)
        self.assertIn("-- Verify", SQL)


if __name__ == "__main__":
    unittest.main()
