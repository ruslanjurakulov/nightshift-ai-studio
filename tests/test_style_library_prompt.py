"""The Style Library reaches a generation through the style-kit path that
already exists — there is no second path, and no Python copy of the library.

An organization that adds a library style (migration 0065) gets an ordinary
style kit: a name, a description and NO reference images. From there the
creative worker reads it (0048 creative_job_style) and
modules/creative_style.py appends the description to the prompt as "Look: ...".
These tests feed every built-in description (read from the TypeScript source,
so the list cannot drift) through that real code, and pin what the kit table
and the worker will and will not accept:

* a reference-less kit with a description is a usable look, never "unusable",
  and never dropped silently (CLAUDE.md #4);
* every description fits the style kit's own description CHECK (read from
  0047), so "Add to my styles" cannot fail for one style only;
* the typed prompt is kept exactly as typed and the guide is appended after it;
* a description cannot break out of the guide's markers.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

from modules import creative_style as cs

ROOT = Path(__file__).resolve().parent.parent
LIBRARY = (ROOT / "command-center" / "lib" / "styles" / "library.ts").read_text(encoding="utf-8")
SQL_0047 = (ROOT / "supabase" / "migrations" / "0047_style_kits_characters.sql").read_text(encoding="utf-8")
SQL_0065 = (ROOT / "supabase" / "migrations" / "0065_style_library.sql").read_text(encoding="utf-8")

ORG = "4b1d0000-0000-4000-8000-000000000001"
KIT = "4b1d0000-0000-4000-8000-00000000c0de"


def library():
    """(id, description) for every built-in style, as written in the TypeScript."""
    out = []
    pattern = re.compile(r'\n    id: "([a-z0-9-]+)",.*?\n    description:\s*\n?\s*("(?:[^"\\]|\\.)*"),\n', re.S)
    for m in pattern.finditer(LIBRARY):
        out.append((m.group(1), json.loads(m.group(2))))
    return out


def library_kit_answer(description):
    """What creative_job_style returns for a library kit: a description, no references."""
    return {"ok": True, "org_id": ORG, "kit": {"id": KIT, "org_id": ORG, "description": description, "references": []},
            "characters": []}


class StyleLibraryPromptTest(unittest.TestCase):
    def test_the_source_is_read_whole(self):
        styles = library()
        self.assertGreaterEqual(len(styles), 24)
        ids = [i for i, _ in styles]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(styles), LIBRARY.count('\n    id: "'))

    def test_every_description_fits_the_kit_tables_own_limit(self):
        limit = int(re.search(r"description text not null default '' check \(char_length\(description\) <= (\d+)\)", SQL_0047).group(1))
        self.assertEqual(limit, 2000)
        for style_id, description in library():
            self.assertLessEqual(len(description), limit, style_id)
            self.assertGreaterEqual(len(description), 1, style_id)
            # 0065 and save_style_kit strip control characters; a description with one would change on the way in.
            self.assertIsNone(re.search(r"[\x00-\x1f\x7f]", description), style_id)
            self.assertEqual(description, description.strip(), style_id)

    def test_a_library_kit_without_pictures_is_a_usable_look(self):
        for style_id, description in library():
            inputs = cs.parse_answer(library_kit_answer(description), org_id=ORG, kit_id=KIT, prompt="a lighthouse at dawn")
            self.assertIsNotNone(inputs.kit, style_id)
            self.assertEqual(inputs.kit.references, ())
            # No pictures to send, yet nothing is "unusable": the description is the whole look.
            self.assertEqual(cs.unusable(inputs, []), [], style_id)

    def test_the_description_is_appended_after_the_typed_prompt_as_the_look(self):
        for style_id, description in library():
            inputs = cs.parse_answer(library_kit_answer(description), org_id=ORG, kit_id=KIT, prompt="a lighthouse at dawn")
            text = cs.compose_prompt("a lighthouse at dawn", inputs, [])
            self.assertTrue(text.startswith("a lighthouse at dawn\n\n" + cs.GUIDE_START + "\nLook: "), style_id)
            self.assertTrue(text.endswith(cs.GUIDE_END), style_id)
            # One line, whitespace folded — and every word of the direction survives.
            self.assertEqual(text.count("Look: "), 1)
            look = text.split("Look: ", 1)[1].rsplit("\n" + cs.GUIDE_END, 1)[0]
            self.assertEqual(look, " ".join(description.split()), style_id)
            self.assertIn("stock-AI look", look)

    def test_a_description_leaves_room_in_a_typical_prompt_limit(self):
        # The worker refuses a prompt the descriptions make longer than the model takes, so the
        # library is written to stay well under the Studio's 4000-character prompt box.
        for style_id, description in library():
            inputs = cs.parse_answer(library_kit_answer(description), org_id=ORG, kit_id=KIT, prompt="x" * 1000)
            composed = cs.compose_prompt("x" * 1000, inputs, [])
            self.assertLess(cs.prompt_units(composed), 2600, style_id)

    def test_nothing_in_a_description_can_close_the_guide_early(self):
        for style_id, description in library():
            self.assertNotIn(cs.GUIDE_START, description, style_id)
            self.assertNotIn(cs.GUIDE_END, description, style_id)
            self.assertNotIn("@", description, style_id)  # a description is never read as a character mention


class Migration0065Test(unittest.TestCase):
    """What the worker relies on stays true: a library kit is just a kit row."""

    def code(self):
        return "\n".join(line.split("--")[0] for line in SQL_0065.splitlines())

    def test_the_worker_reads_kits_without_requiring_references(self):
        # 0048's creative_job_style left-joins references into a possibly empty list.
        sql_0048 = (ROOT / "supabase" / "migrations" / "0048_creative_style_inputs.sql").read_text(encoding="utf-8")
        self.assertIn("coalesce((", sql_0048)
        self.assertIn("'[]'::jsonb))", sql_0048)

    def test_it_adds_one_function_and_one_column_and_touches_no_generation_code(self):
        code = self.code()
        self.assertEqual(re.findall(r"create or replace function public\.(\w+)\(", code), ["add_library_style_kit"])
        self.assertEqual(len(re.findall(r"add column if not exists", code)), 1)
        self.assertNotRegex(code, r"creative_jobs|creative_job_style|reserve_credits|capture_credits")

    def test_every_earlier_style_function_is_left_as_it_was(self):
        code = self.code()
        for name in ("save_style_kit", "save_character", "style_check_assets", "style_clean_text",
                     "creative_job_style", "creative_style_problem", "creative_params_problem"):
            self.assertNotIn(f"function public.{name}", code, name)

    def test_the_two_description_checks_agree(self):
        self.assertIn("char_length(desc_) not between 1 and 2000", SQL_0065)
        self.assertIn("char_length(description) <= 2000", SQL_0047)
        self.assertIn("char_length(name_) not between 1 and 60", SQL_0065)
        self.assertIn("char_length(name) between 1 and 60", SQL_0047)


if __name__ == "__main__":
    unittest.main()
