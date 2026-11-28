"""0236 (supabase/migrations/0236_film_clip_sound_gate.sql), read as text: what would break if these failed is a film_price that
differs from 0218's in more than its one marked hunk (an unreviewed change to how every film is priced), a backslash the live apply
path could rewrite, a switch that defaults on (selling sound before the worker that keeps it is deployed), or a rollback that does
not put 0218's body back byte for byte. The database behaviour is pinned in tests/security/test_sec_film_clip_sound_0236.py."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "supabase" / "migrations" / "0236_film_clip_sound_gate.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0236_film_clip_sound_gate.sql").read_text(encoding="utf-8")
M0218 = (ROOT / "supabase" / "migrations" / "0218_creative_prompt_limits.sql").read_text(encoding="utf-8")


def body_of(text: str) -> str:
    m = re.search(r"\$fp0236\$(create or replace function public\.film_price\(.*?\n\$\$;)\$fp0236\$", text, re.S)
    assert m, "no film_price body"
    return m.group(1).replace("@@0236_BACKSLASH@@", "\\")


def body_0218() -> str:
    m = re.search(r"(create or replace function public\.film_price\(p_film public\.films\).*?\n\$\$;)", M0218, re.S)
    return m.group(1)


class FilmClipSoundMigration(unittest.TestCase):
    def test_the_body_is_0218s_plus_only_the_marked_hunk(self):
        lines = body_of(MIGRATION).splitlines(keepends=True)
        hunk = [ln for ln in lines if ln.rstrip().endswith("-- 0236")]
        self.assertEqual(len(hunk), 5)
        undone = [ln for ln in lines if not ln.rstrip().endswith("-- 0236") and not ln.lstrip().startswith("-- 0236:")]
        self.assertEqual("".join(undone), body_0218())

    def test_the_rollback_puts_0218s_body_back_byte_for_byte(self):
        self.assertEqual(body_of(ROLLBACK), body_0218())
        self.assertIn("drop column if exists clip_sound_kept", ROLLBACK)

    def test_no_backslash_anywhere(self):
        self.assertNotIn("\\", MIGRATION)
        self.assertNotIn("\\", ROLLBACK)

    def test_the_switch_defaults_off_and_is_read_where_it_refuses(self):
        self.assertIn("add column if not exists clip_sound_kept boolean not null default false", MIGRATION)
        self.assertIn("(select s.clip_sound_kept from public.film_studio_settings s where s.id), false)", body_of(MIGRATION))
        self.assertNotRegex(MIGRATION, r"(?i)grant\s+\w+.*film_studio_settings")
        self.assertNotRegex(MIGRATION, r"(?i)update public\.film_studio_settings set clip_sound_kept = true(?!, updated_at)")

    def test_the_guard_end_state_and_header_name_the_same_md5s(self):
        new = "b873f893f3f185b3eab3698d349f3379"
        self.assertIn(f"array['3c22f87be736c073d17d93e040e914e1', '{new}']", MIGRATION)
        self.assertIn(f"if got <> '{new}' then", MIGRATION)
        self.assertIn(f"0218 3c22f87be736c073d17d93e040e914e1 -> 0236 {new}", MIGRATION)
        self.assertIn(f"array['{new}', '3c22f87be736c073d17d93e040e914e1']", ROLLBACK)

    def test_the_overlap_with_0235_is_stated(self):
        self.assertIn("0235", MIGRATION)
        self.assertIn("Whichever of the two", MIGRATION)
        self.assertIn("merges second rebases", MIGRATION)


if __name__ == "__main__":
    unittest.main()
