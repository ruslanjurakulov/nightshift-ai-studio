"""supabase/migrations/0098_previews_policy_scope.sql, read as text (no database).

The behaviour is attacked in tests/security/test_sec_previews_policy.py; this
file only pins what must never drift in the file itself: the exact drop, the
single scoped policy, no policy for anon/public, and a rollback note that
cannot be followed into a broad policy."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILE = ROOT / "supabase" / "migrations" / "0098_previews_policy_scope.sql"


def code(sql):
    return "\n".join(l for l in sql.splitlines() if not l.lstrip().startswith("--"))


class PreviewsPolicyMigration(unittest.TestCase):
    sql = FILE.read_text(encoding="utf-8")

    def test_it_is_the_only_0098(self):
        self.assertEqual([p.name for p in FILE.parent.glob("0098_*.sql")], [FILE.name])

    def test_it_drops_the_dashboard_policy_by_its_exact_name(self):
        self.assertIn('drop policy if exists "previews_read 1dyqf8r_0" on storage.objects;', code(self.sql))

    def test_the_only_policy_it_creates_is_the_scoped_previews_read_for_authenticated(self):
        creates = re.findall(r"create policy\s+(\S+)\s+on storage\.objects\s+for (\w+) to (\w+)", code(self.sql))
        self.assertEqual(creates, [("previews_read", "select", "authenticated")])
        body = code(self.sql).split("create policy previews_read", 1)[1]
        for needle in ("bucket_id = 'previews'", "accessible_channel_ids('viewer')", "is_platform_admin()"):
            self.assertIn(needle, body)
        self.assertNotRegex(code(self.sql), r"(?i)\bto\s+(anon|public)\b")

    def test_it_touches_no_other_bucket_and_no_data(self):
        c = code(self.sql)
        for word in ("avatars", "voice-previews", "publish-staging", "storage.buckets", "delete from", "update storage", "insert into"):
            self.assertNotIn(word, c, word)

    def test_the_dynamic_part_reads_using_and_check_separately_and_never_coalesces(self):
        c = code(self.sql)
        self.assertIn("qual       ~ named and qual       !~ scoped", c)
        self.assertIn("with_check ~ named and with_check !~ scoped", c)
        self.assertNotIn("coalesce", c)
        self.assertIn("cmd in ('SELECT', 'ALL')", c)
        self.assertIn("permissive = 'PERMISSIVE'", c)
        self.assertIn("policyname <> 'previews_read'", c)

    def test_the_header_gives_a_safe_rollback_and_no_broad_policy_to_paste(self):
        head = re.sub(r"\s*\n--\s*", " ", "\n".join(l for l in self.sql.splitlines() if l.startswith("--")))
        self.assertIn("ROLLBACK (safe)", head)
        self.assertIn("Do NOT recreate a broad", head)
        self.assertIn("Verify", head)
        self.assertIn("HEURISTIC, NOT A CATCH-ALL", head)
        self.assertIn("RUN IT WHOLE", head)
        # the strict allowlist is the first verify query
        self.assertLess(head.index("1. THE CHECK THAT COUNTS: strict allowlist"), head.index("2. every policy on storage.objects"))
        for name in ("avatars_delete_own", "avatars_insert_own", "avatars_select_own", "avatars_update_own",
                     "previews_read", "voice_previews_read"):
            self.assertIn(f"'{name}'", head)
        self.assertIn("tablename <> 'objects'", head)
        # no commented-out statement that would recreate a broad reader
        self.assertNotRegex(head, r"(?is)create policy[^;]*using\s*\(\s*bucket_id\s*=\s*'previews'\s*\)")


if __name__ == "__main__":
    unittest.main()
