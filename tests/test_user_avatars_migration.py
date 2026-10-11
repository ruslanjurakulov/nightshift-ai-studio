"""supabase/migrations/0097_user_avatars.sql — the private "avatars" bucket.

The behaviour runs in tests/security/test_sec_user_avatars.py (a real
Postgres). This pins, without a database, what must not change by accident:
the bucket is private, 256 KB, WebP only; the four policies name the bucket and
exactly one object name per person; nothing is granted to anon; no other
bucket's policy is touched; the migration is re-runnable and refuses to run
without the storage schema.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0097_user_avatars.sql").read_text()
CODE = re.sub(r"--[^\n]*", "", SQL)

OWN_NAME = "name = (select auth.uid())::text || '/avatar.webp'"
OWN_FOLDER = "(storage.foldername(name))[1] = (select auth.uid())::text"


class UserAvatarsMigration(unittest.TestCase):
    def test_bucket_is_private_256kb_and_webp_only(self):
        self.assertIn("values ('avatars', 'avatars', false, 262144, array['image/webp'])", CODE)
        # a re-run repairs a bucket someone flipped by hand
        self.assertIn("set public = false,", CODE)
        self.assertIn("file_size_limit = 262144,", CODE)
        self.assertIn("allowed_mime_types = array['image/webp']", CODE)

    def test_four_policies_all_authenticated_only_and_scoped_to_one_object(self):
        policies = re.findall(r"create policy (\w+) on storage\.objects\s+for (\w+) to (\w+)", CODE)
        self.assertEqual(
            sorted(policies),
            sorted([
                ("avatars_select_own", "select", "authenticated"),
                ("avatars_insert_own", "insert", "authenticated"),
                ("avatars_update_own", "update", "authenticated"),
                ("avatars_delete_own", "delete", "authenticated"),
            ]),
        )
        bodies = re.findall(r"(?:using|with check) \((.*?)\);?\s*(?=with check|drop policy|$)", CODE, re.S)
        self.assertGreaterEqual(len(bodies), 5)  # select, insert, delete + update's two halves
        for body in bodies:
            self.assertIn("bucket_id = 'avatars'", body)
            self.assertIn(OWN_FOLDER, body)
            self.assertIn(OWN_NAME, body)

    def test_update_has_both_halves_so_a_rename_cannot_leave_the_folder(self):
        m = re.search(r"create policy avatars_update_own.*?;\n", CODE, re.S)
        self.assertIsNotNone(m)
        self.assertIn("using (", m.group(0))
        self.assertIn("with check (", m.group(0))

    def test_nothing_is_granted_to_anon_or_to_other_buckets(self):
        self.assertNotRegex(CODE, r"\banon\b")
        self.assertNotRegex(CODE, r"to public")
        # every policy touches only the avatars bucket
        self.assertEqual(set(re.findall(r"bucket_id = '([\w-]+)'", CODE)), {"avatars"})
        self.assertEqual(re.findall(r"drop policy if exists (\w+) on", CODE).__len__(), 4)
        self.assertFalse(re.search(r"drop policy if exists (?!avatars_)", CODE))

    def test_no_table_is_created_and_nothing_earlier_is_dropped(self):
        self.assertNotRegex(CODE, r"create table")
        self.assertNotRegex(CODE, r"drop (table|function|bucket|schema|column)")
        self.assertNotRegex(CODE, r"delete from storage\.")

    def test_it_refuses_to_run_without_the_storage_schema(self):
        self.assertIn("to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null", CODE)
        self.assertIn("raise exception '0097 needs the storage schema", CODE)

    def test_it_says_what_it_does_not_cover(self):
        self.assertIn("Account deletion is e-mail-only today and does not cascade", SQL)
        self.assertIn("Storage checks the Content-Type HEADER", SQL)
        self.assertIn("WHAT AN OUTSIDER CAN LEARN", SQL)


if __name__ == "__main__":
    unittest.main()
