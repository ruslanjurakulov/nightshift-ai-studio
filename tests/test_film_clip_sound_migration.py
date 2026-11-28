"""0236 (supabase/migrations/0236_film_clip_sound_gate.sql), read as text: what would break if these failed is a film_price that
differs from 0235's in more than its one marked hunk (an unreviewed change to how every film is priced), a backslash the live apply
path could rewrite, a switch that defaults on (selling sound before the worker that keeps it is deployed), or a rollback that does
not put 0235's body back byte for byte. The database behaviour is pinned in tests/security/test_sec_film_clip_sound_0236.py."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "supabase" / "migrations" / "0236_film_clip_sound_gate.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0236_film_clip_sound_gate.sql").read_text(encoding="utf-8")
M0235 = (ROOT / "supabase" / "migrations" / "0235_film_operator_preview.sql").read_text(encoding="utf-8")
M0215 = (ROOT / "supabase" / "migrations" / "0215_film_archive_resume.sql").read_text(encoding="utf-8")
RETRYABLE = r"(create or replace function public\.film_assembly_retryable\(p_word text\).*?\n\$\$;)"


def body_of(text: str) -> str:
    m = re.search(r"\$fp0236\$(create or replace function public\.film_price\(.*?\n\$\$;)\$fp0236\$", text, re.S)
    assert m, "no film_price body"
    return m.group(1).replace("@@0236_BACKSLASH@@", "\\")


def body_0235() -> str:
    """0235's film_price as the database receives it (its chr(92) placeholder put back)."""
    m = re.search(r"\$fp0235\$(create or replace function public\.film_price\(.*?\n\$\$;)\$fp0235\$", M0235, re.S)
    return m.group(1).replace("@@0235_BACKSLASH@@", "\\")


class FilmClipSoundMigration(unittest.TestCase):
    def test_the_body_is_0235s_plus_only_the_marked_hunk(self):
        lines = body_of(MIGRATION).splitlines(keepends=True)
        hunk = [ln for ln in lines if ln.rstrip().endswith("-- 0236")]
        self.assertEqual(len(hunk), 5)
        undone = [ln for ln in lines if not ln.rstrip().endswith("-- 0236") and not ln.lstrip().startswith("-- 0236:")]
        self.assertEqual("".join(undone), body_0235())

    def test_film_assembly_retryable_is_0215s_plus_only_the_marked_hunk_and_the_rollback_puts_it_back(self):
        ours = re.search(RETRYABLE, MIGRATION, re.S).group(1)
        lines = ours.splitlines(keepends=True)
        self.assertEqual(sum(1 for ln in lines if ln.rstrip().endswith("-- 0236")), 1)
        undone = [ln for ln in lines if not ln.rstrip().endswith("-- 0236") and not ln.lstrip().startswith("-- 0236:")]
        theirs = re.search(RETRYABLE, M0215, re.S).group(1)
        self.assertEqual("".join(undone), theirs)
        self.assertIn("'sound_mix_failed', 'asset_unprobed'", ours)
        self.assertEqual(re.search(RETRYABLE, ROLLBACK, re.S).group(1), theirs)
        self.assertIn("array['82ec51dabd0ff178ec2280bc0c56e62b', '88a312d28e63be043796bcc86f024164']", MIGRATION)

    def test_the_rollback_puts_0235s_body_back_byte_for_byte(self):
        self.assertEqual(body_of(ROLLBACK), body_0235())
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
        new = "af0fb80cce8e92fd2360aa6d5366a942"
        self.assertIn(f"array['186d34ffb633bc56a91bbf617b0b7520', '{new}']", MIGRATION)
        self.assertIn(f"if got <> '{new}' then", MIGRATION)
        self.assertIn(f"0235 186d34ffb633bc56a91bbf617b0b7520 -> 0236 {new}", MIGRATION)
        self.assertIn(f"array['{new}', '186d34ffb633bc56a91bbf617b0b7520']", ROLLBACK)
        # On 0218's body (0235 not applied) it refuses with the fix, never replacing it.
        self.assertIn("apply 0235_film_operator_preview.sql first", MIGRATION)

    def test_the_order_after_0235_is_stated(self):
        self.assertIn("0235 -> 0236 -> 0239 -> 0240", MIGRATION)


if __name__ == "__main__":
    unittest.main()
