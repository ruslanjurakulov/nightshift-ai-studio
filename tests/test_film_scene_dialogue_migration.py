"""0241 (supabase/migrations/0241_film_scene_dialogue.sql), read as text: what would break if these failed is a film_save_scenes that
differs from 0166's, or a film_price that differs from 0236's, in more than their marked hunks (an unreviewed change to how every
storyboard is saved or every film is priced), a backslash the live apply path could rewrite, a column an API role may write, or a
rollback that does not put both bodies back byte for byte. The database behaviour is pinned in
tests/security/test_sec_film_dialogue_0241.py."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "supabase" / "migrations" / "0241_film_scene_dialogue.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0241_film_scene_dialogue.sql").read_text(encoding="utf-8")
M0166 = (ROOT / "supabase" / "migrations" / "0166_films_core.sql").read_text(encoding="utf-8")
M0236 = (ROOT / "supabase" / "migrations" / "0236_film_clip_sound_gate.sql").read_text(encoding="utf-8")
SAVE = r"(create or replace function public\.film_save_scenes\(p_film public\.films, p_scenes jsonb\).*?\n\$\$;)"

SAVE_OLD, SAVE_NEW = "c836631256f669318c9ef499d7c4c54b", "5d6e6eebe280645e6c5ef186dc48629a"
PRICE_OLD, PRICE_NEW = "b873f893f3f185b3eab3698d349f3379", "81e7a2dd0701068508e2663b495683cb"


def price_of(text: str, tag: str) -> str:
    m = re.search(rf"\${tag}\$(create or replace function public\.film_price\(.*?\n\$\$;)\${tag}\$", text, re.S)
    assert m, "no film_price body"
    return m.group(1).replace(f"@@{tag[2:]}_BACKSLASH@@", "\\")


def undo(body: str) -> str:
    lines = body.splitlines(keepends=True)
    return "".join(ln for ln in lines if not ln.rstrip().endswith("-- 0241") and not ln.lstrip().startswith("-- 0241:"))


def marked(body: str) -> int:
    return sum(1 for ln in body.splitlines() if ln.rstrip().endswith("-- 0241"))


class FilmSceneDialogueMigration(unittest.TestCase):
    def test_film_save_scenes_is_0166s_plus_only_the_marked_hunks(self):
        ours = re.search(SAVE, MIGRATION, re.S).group(1)
        self.assertEqual(marked(ours), 23)
        self.assertEqual(undo(ours), re.search(SAVE, M0166, re.S).group(1))

    def test_film_price_is_0236s_plus_only_the_marked_hunks(self):
        ours = price_of(MIGRATION, "fp0241")
        self.assertEqual(marked(ours), 6)
        self.assertEqual(undo(ours), price_of(M0236, "fp0236"))
        # 0236's own hunk is still there, untouched, and named first.
        self.assertLess(ours.index("'clip_sound_not_kept'"), ours.index("public.film_sound_problem("))

    def test_the_rollback_puts_0166s_and_0236s_bodies_back_byte_for_byte(self):
        self.assertEqual(re.search(SAVE, ROLLBACK, re.S).group(1), re.search(SAVE, M0166, re.S).group(1))
        self.assertEqual(price_of(ROLLBACK, "fp0241"), price_of(M0236, "fp0236"))
        for what in ("drop column if exists dialogue", "drop column if exists sound_role",
                     "drop constraint if exists film_scenes_sound_check", "drop function if exists public.film_dialogue(jsonb, text)",
                     "drop function if exists public.film_sound_problem(text, jsonb, jsonb, text, text)",
                     "nightshift.rollback_0241_discard_sound"):
            self.assertIn(what, ROLLBACK)

    def test_no_backslash_anywhere(self):
        self.assertNotIn("\\", MIGRATION)
        self.assertNotIn("\\", ROLLBACK)

    def test_the_guards_end_states_header_and_rollback_name_the_same_md5s(self):
        self.assertIn(f"array['{SAVE_OLD}', '{SAVE_NEW}']", MIGRATION)
        self.assertIn(f"array['{PRICE_OLD}', '{PRICE_NEW}']", MIGRATION)
        self.assertIn(f"if got <> '{SAVE_NEW}' then", MIGRATION)
        self.assertIn(f"if got <> '{PRICE_NEW}' then", MIGRATION)
        self.assertIn(f"0166 {SAVE_OLD} -> 0241 {SAVE_NEW}", MIGRATION)
        self.assertIn(f"0236 {PRICE_OLD} -> 0241 {PRICE_NEW}", MIGRATION)
        self.assertIn(f"array['{SAVE_NEW}', '{SAVE_OLD}']", ROLLBACK)
        self.assertIn(f"array['{PRICE_NEW}', '{PRICE_OLD}']", ROLLBACK)
        # 0166's own guard names the body this file replaces.
        self.assertIn(f"('public.film_save_scenes(public.films, jsonb)', '{SAVE_OLD}')", M0166)
        self.assertIn(f"0236 {PRICE_OLD}", M0236)

    def test_no_api_role_is_granted_anything_and_the_helpers_are_revoked(self):
        self.assertNotRegex(MIGRATION, r"(?im)^\s*grant\s")
        for sig in ("film_dialogue_prompt(jsonb)", "film_clip_prompt(text, jsonb)", "film_dialogue(jsonb, text)",
                    "film_sound_problem(text, jsonb, jsonb, text, text)", "film_save_scenes(public.films, jsonb)",
                    "film_price(public.films)"):
            self.assertIn(f"revoke all on function public.{sig} from public, anon, authenticated, service_role;", MIGRATION)

    def test_the_columns_are_additive_nullable_and_checked(self):
        self.assertIn("add column if not exists sound_role text;", MIGRATION)
        self.assertIn("add column if not exists dialogue jsonb;", MIGRATION)
        self.assertIn("sound_role in ('dialogue', 'ambience', 'muted')", MIGRATION)
        self.assertIn("((dialogue is not null) = (sound_role is not distinct from 'dialogue'))", MIGRATION)

    def test_the_header_states_the_dependency_the_overlap_and_the_limits_sources(self):
        self.assertIn("PR #973", MIGRATION)
        self.assertIn("3ddb729f4", MIGRATION)
        self.assertIn("0235 (PR #970", MIGRATION)
        self.assertIn("CAP.name, CAP.line", MIGRATION)
        self.assertIn("max_prompt_chars", MIGRATION)

    def test_0241_keeps_br_0236_01_audio_is_still_booleans_only(self):
        # film_save_scenes' clip_params branch is 0166's, unchanged: clip_params.audio must be true or false.
        ours = re.search(SAVE, MIGRATION, re.S).group(1)
        self.assertIn("clip_params.audio must be true or false", ours)
        self.assertNotIn("-- 0241", ours[ours.index("if r.v ? 'clip_params' then"):ours.index("if r.v ? 'transition_in' then")])


if __name__ == "__main__":
    unittest.main()
