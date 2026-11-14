"""Migration 0158 (the concept-thumbnail settings are an organization administrator's), read as text.

The behaviour (an editor and a viewer are refused, an administrator, the owner and the service role are not, an
unrelated edit or a whole blob carried back unchanged still passes, create_channel holds the keys, the rollback and the
replay) is attacked in a real database by tests/security/test_sec_thumbnail_concept_lock.py. This file pins what must
hold on every laptop: the keys the lock holds are exactly the keys the worker reads, 0086's controls are kept, the
browser-roles-only convention is kept, and the rollback puts 0086's list back byte for byte.
"""

import re
import unittest
from pathlib import Path

from modules import thumbnail_concept as tc
from modules.channels import AgentConfig

REPO = Path(__file__).resolve().parent.parent
MIGRATIONS = REPO / "supabase" / "migrations"
SQL = (MIGRATIONS / "0158_thumbnail_concept_admin_lock.sql").read_text(encoding="utf-8")
M86 = (MIGRATIONS / "0086_channel_config_lock.sql").read_text(encoding="utf-8")
M119 = (MIGRATIONS / "0119_channel_settings_guard.sql").read_text(encoding="utf-8")
ROLLBACK = (REPO / "docs" / "sql" / "rollback_0158_thumbnail_concept_admin_lock.sql").read_text(encoding="utf-8")


def code(text):
    return "\n".join(line.split("--", 1)[0].rstrip() for line in text.splitlines())


def keys_of(pattern, text):
    m = re.search(pattern, code(text), re.S)
    assert m, pattern
    return re.findall(r"'([a-z_]+)'", m.group(1))


CONTROLS = r"function public\.channel_admin_controls\(\) returns text\[\].*?select array\[(.*?)\]::text\[\]"


class ThumbnailConceptLockMigration(unittest.TestCase):
    def test_the_number_is_taken_once(self):
        self.assertEqual([p.name for p in MIGRATIONS.glob("0158_*.sql")], ["0158_thumbnail_concept_admin_lock.sql"])

    def test_the_lock_holds_exactly_the_keys_the_worker_reads(self):
        held = keys_of(r"keys\s+constant text\[\] := array\[(.*?)\];", SQL)
        self.assertEqual(sorted(held), ["thumbnail_concept", "thumbnail_mode"])
        agent = AgentConfig.from_dict({"thumbnail_mode": "concept", "thumbnail_concept": {"image_provider": "flux"}})
        self.assertEqual(tc.settings_from_agent(agent).mode, "concept")
        self.assertTrue({"thumbnail_mode", "thumbnail_concept"} <= set(agent.to_dict()))

    def test_create_channel_sees_0086s_controls_plus_the_two(self):
        self.assertEqual(keys_of(CONTROLS, SQL), keys_of(CONTROLS, M86) + ["thumbnail_mode", "thumbnail_concept"])
        self.assertNotIn("create or replace function public.create_channel", SQL)
        self.assertNotIn("create or replace function public.channels_config_guard", SQL)

    def test_only_the_browser_roles_are_held_and_the_refusal_is_named(self):
        body = code(SQL)
        self.assertIn("if current_user not in ('authenticated', 'anon') then", body)
        self.assertIn("public.is_org_member(org, 'admin')", body)
        self.assertIn("errcode = '42501', hint = 'thumbnail_concept_lock'", body)
        self.assertIn("'thumbnail_concept_lock:", body)
        self.assertNotIn("security definer", body.lower())
        self.assertIn("revoke all on function public.channels_thumbnail_concept_guard() from public, anon, authenticated, service_role;", body)

    def test_the_atomic_patch_function_cannot_write_either_key(self):
        allowed = keys_of(r"allowed constant text\[\] := array\[(.*?)\];", M119)
        self.assertFalse({"thumbnail_mode", "thumbnail_concept"} & set(allowed))

    def test_it_is_idempotent_guarded_and_verifiable(self):
        body = code(SQL)
        self.assertIn("drop trigger if exists channels_thumbnail_concept_guard on public.channels;", body)
        self.assertIn("set local lock_timeout", body)
        self.assertIn("neither 0086''s list nor 0158''s", body)
        self.assertIn("-- Verify", SQL)

    def test_the_rollback_puts_0086s_list_back_and_drops_only_this_files_objects(self):
        self.assertEqual(keys_of(CONTROLS, ROLLBACK), keys_of(CONTROLS, M86))
        self.assertIn("drop trigger if exists channels_thumbnail_concept_guard on public.channels;", ROLLBACK)
        self.assertIn("drop function if exists public.channels_thumbnail_concept_guard();", ROLLBACK)
        self.assertEqual(len(re.findall(r"(?im)^\s*drop ", code(ROLLBACK))), 2)


if __name__ == "__main__":
    unittest.main()
