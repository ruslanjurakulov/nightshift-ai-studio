"""Migration 0220 (the film's voice language at the quote and the start), pinned as text.

What would break, and which test says so:

* the language asked before the role check (a hidden voice model would be answered with a language detail describing its row instead
  of model_not_available), or after the price (a refused language would be priced);
* the start's check moving after the rate step (a refused start would be counted), or before the model role checks;
* either body differing from 0171's by more than its marked 0220 hunk (a silent change to a money function);
* the file applying without 0214's exact helper, or without its drift guard, end-state and Verify blocks;
* the rollback not restoring 0171's bodies word for word, or restoring over a body that is not 0220's;
* the apply order (after 0214, the sync, the probes and re-enabling) missing from the header or docs/MIGRATIONS.md.

The lab (tests/security/test_sec_film_voice_language_0220.py) runs the same files on a real PostgreSQL; this test needs none.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0220_film_voice_language.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0220_film_voice_language.sql").read_text(encoding="utf-8")
M0171 = (ROOT / "supabase" / "migrations" / "0171_films_money.sql").read_text(encoding="utf-8")
DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")


def body(sql: str, name: str) -> str:
    m = re.search(rf"create or replace function public\.{name}\(.*?\n\$\$;", sql, re.S)
    assert m, name
    return m.group(0)


def without_0220(text: str) -> str:
    """The body with its 0220 hunk taken out: the comment lines and the added statements."""
    text = re.sub(r"(?m)^\s*-- 0220:.*\n(?:\s*-- .*\n)*", "", text)
    text = text.replace("                    public.voice_language_problem(f.voice ->> 'model', f.language),\n", "")
    text = re.sub(r"  if p_film\.voice ->> 'source' = 'creative_tts' and p_film\.voice ->> 'model' is not null\n.*?\n    end if;\n  end if;\n",
                  "", text, flags=re.S)
    return text


class TheHunks(unittest.TestCase):
    def test_film_price_asks_the_role_then_the_language_then_the_price(self):
        b = body(SQL, "film_price")
        role = b.index("public.film_model_problem(f.voice ->> 'model', array['tts'], 'voice.model')")
        lang = b.index("public.voice_language_problem(f.voice ->> 'model', f.language)")
        price = b.index("public.film_try_price(f.org_id, 'tts'")
        self.assertLess(role, lang)
        self.assertLess(lang, price)
        self.assertEqual(b.count("voice_language_problem"), 1)

    def test_the_precheck_asks_after_every_role_check_and_before_the_references(self):
        b = body(SQL, "film_precheck")
        self.assertLess(b.index("end loop;"), b.index("public.voice_language_problem(p_film.voice ->> 'model', p_film.language)"))
        self.assertLess(b.index("voice_language_problem"), b.index("'reference_missing'"))

    def test_each_body_is_0171s_but_for_its_hunk(self):
        for name in ("film_price", "film_precheck"):
            self.assertEqual(without_0220(body(SQL, name)), body(M0171, name), name)

    def test_start_film_raises_the_precheck_before_the_rate_step(self):
        start = body((ROOT / "supabase" / "migrations" / "0198_film_studio_org_switch.sql").read_text(encoding="utf-8"), "start_film")
        self.assertLess(start.index("bad := public.film_precheck(f);"), start.index("perform public.film_take_rate('start'"))

    def test_no_model_list_or_remedy_is_written_here(self):
        code = "\n".join(ln.split("--", 1)[0] for ln in SQL.splitlines())
        self.assertNotIn("Eleven v3", code)
        self.assertNotIn("elevenlabs", code)


class TheGuards(unittest.TestCase):
    def test_it_requires_0214s_exact_helper(self):
        self.assertIn("'6d5025fd76e3b8b4d731e2d98f65db6e'", SQL)
        self.assertIn("apply 0214_voice_language_check.sql first", SQL)

    def test_the_drift_guard_names_0171s_bodies(self):
        self.assertIn("'5de6c9bb2a74079e2078cad2d91b3c34'", SQL)
        self.assertIn("'ff4fa7e8a6386420f32ab6a3a85a778c'", SQL)
        self.assertIn("with a body that is neither 0171''s nor 0220''s", SQL)

    def test_it_has_an_end_state_and_a_verify_block_and_adds_no_grant(self):
        self.assertIn("0220 end state", SQL)
        self.assertIn("-- Verify (read-only, run after applying)", SQL)
        lowered = SQL.lower()
        self.assertNotIn("grant ", "\n".join(ln.split("--", 1)[0] for ln in lowered.splitlines()))
        self.assertNotIn("create table", lowered)
        self.assertNotIn("drop ", "\n".join(ln.split("--", 1)[0] for ln in lowered.splitlines()))


class TheRollbackAndTheDoc(unittest.TestCase):
    def test_the_rollback_restores_0171s_bodies_word_for_word(self):
        for name in ("film_price", "film_precheck"):
            self.assertEqual(body(ROLLBACK, name), body(M0171, name), name)
        self.assertLess(ROLLBACK.index("is missing or is not 0220''s body"), ROLLBACK.index("create or replace function"))
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)

    def test_the_apply_order_is_stated(self):
        for text in (SQL, DOC.split("(0220)", 1)[1] if "(0220)" in DOC else ""):
            self.assertIn("voice_language_unknown", text)
            self.assertIn("--model elevenlabs-multilingual-v2", text)
            self.assertIn("0214", text)


if __name__ == "__main__":
    unittest.main()
