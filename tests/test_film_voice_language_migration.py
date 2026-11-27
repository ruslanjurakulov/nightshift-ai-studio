"""Migration 0220 (the film's voice language at the quote and the start), pinned as text.

What would break, and which test says so:

* the language asked before the role check (a hidden voice model would be answered with a language detail describing its row instead
  of model_not_available), or after the price (a refused language would be priced);
* the start's check moving after the rate step (a refused start would be counted), or before the model role checks;
* film_price differing from 0218's (live in production) by more than its marked 0220 hunk and the one backslash-free regex, or
  film_precheck from 0171's by more than its hunk (a silent change to a money function);
* the file applying without 0214's exact helper or on 0171's film_price, or without its drift guard, end-state and Verify blocks;
* the rollback not restoring 0218's film_price and 0171's film_precheck byte for byte, or restoring over a body that is not 0220's;
* a backslash in either file (an apply tool may rewrite an escape sequence; the md5 folds use '[[:space:]]+');
* the apply order (after 0214, the sync, the probes and re-enabling) missing from the header or docs/MIGRATIONS.md.

The lab (tests/security/test_sec_film_voice_language_0220.py) runs the same files on a real PostgreSQL; this test needs none.
"""

from __future__ import annotations

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0220_film_voice_language.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0220_film_voice_language.sql").read_text(encoding="utf-8")
M0171 = (ROOT / "supabase" / "migrations" / "0171_films_money.sql").read_text(encoding="utf-8")
M0218 = (ROOT / "supabase" / "migrations" / "0218_creative_prompt_limits.sql").read_text(encoding="utf-8")
#: The body each one is written on: film_price is 0218's (it replaced 0171's, and production has it), film_precheck 0171's.
BASE = {"film_price": M0218, "film_precheck": M0171}
#: 0218's clip-length filter, and the same regex as this file writes it (a bracketed dot is a literal dot): no backslash.
ESCAPED_DOT = "x ~ '^[0-9]{1,3}(" + chr(92) + ".[0-9]+)?$'"
BRACKET_DOT = "x ~ '^[0-9]{1,3}([.][0-9]+)?$'"
MARKER = "<<chr92>>"
DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")


def body(sql: str, name: str) -> str:
    m = re.search(rf"create or replace function public\.{name}\(.*?\n\$\$;", sql, re.S)
    assert m, name
    return m.group(0)


def md5_of(fn: str) -> str:
    b = fn[fn.index("$$") + 2: fn.rindex("$$")]
    return hashlib.md5(re.sub(r"\s+", " ", b).encode()).hexdigest()


def rollback_film_price() -> str:
    """The film_price statement the rollback EXECUTEs, with chr(92) put back where its marker stands."""
    m = re.search(r"execute replace\(\$fp0218\$(create or replace function public\.film_price\(.*?\n\$\$)\n\$fp0218\$, "
                  r"'<<chr92>>', chr\(92\)\);", ROLLBACK, re.S)
    assert m
    assert m.group(1).count(MARKER) == 1
    return m.group(1).replace(MARKER, chr(92)) + ";"


def without_0220(text: str) -> str:
    """The body with its 0220 hunk taken out: the comment lines and the added statements (and the regex written back as 0218's)."""
    text = text.replace(BRACKET_DOT, ESCAPED_DOT)
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

    def test_each_body_is_its_base_but_for_its_hunk(self):
        for name, base in BASE.items():
            self.assertEqual(without_0220(body(SQL, name)), body(base, name), name)

    def test_film_price_keeps_0218s_prompt_lines(self):
        b = body(SQL, "film_price")
        self.assertIn("-- 0218: the negative prompt the take carries (0198)", b)
        self.assertIn("'params', (params - 'source_asset_id' - 'end_asset_id' - 'prompt' - 'negative_prompt')", b)
        self.assertIn("'params', (params - 'prompt' - 'negative_prompt' - 'source_asset_id')", b)

    def test_the_md5s_in_the_header_are_the_bodies(self):
        self.assertEqual(md5_of(body(M0218, "film_price")), "3c22f87be736c073d17d93e040e914e1")
        self.assertEqual(md5_of(body(SQL, "film_price")), "b8ae113d06a5b873d95c19fc1016c5fb")
        self.assertEqual(md5_of(body(M0171, "film_precheck")), "ff4fa7e8a6386420f32ab6a3a85a778c")
        self.assertEqual(md5_of(body(SQL, "film_precheck")), "0a89da5f19fa2c6c0f6d802c02e18925")

    def test_neither_file_holds_a_backslash(self):
        for name, text in (("0220", SQL), ("rollback_0220", ROLLBACK)):
            self.assertNotIn(chr(92), text, name)
            self.assertIn("'[[:space:]]+'", text, name)

    def test_start_film_raises_the_precheck_before_the_rate_step(self):
        for f in ("0198_film_studio_org_switch.sql", "0215_film_archive_resume.sql"):  # 0215's start_film is the live one
            start = body((ROOT / "supabase" / "migrations" / f).read_text(encoding="utf-8"), "start_film")
            self.assertLess(start.index("bad := public.film_precheck(f);"), start.index("perform public.film_take_rate('start'"), f)

    def test_no_model_list_or_remedy_is_written_here(self):
        code = "\n".join(ln.split("--", 1)[0] for ln in SQL.splitlines())
        self.assertNotIn("Eleven v3", code)
        self.assertNotIn("elevenlabs", code)


class TheGuards(unittest.TestCase):
    def test_it_requires_0214s_exact_helper(self):
        self.assertIn("'6d5025fd76e3b8b4d731e2d98f65db6e'", SQL)
        self.assertIn("apply 0214_voice_language_check.sql first", SQL)

    def test_the_drift_guard_accepts_0218s_film_price_and_0171s_precheck_only(self):
        guard = SQL[SQL.index("-- The two bodies this file replaces"):SQL.index("end loop;")]
        self.assertIn("('public.film_price(public.films)', '3c22f87be736c073d17d93e040e914e1', 'b8ae113d06a5b873d95c19fc1016c5fb', '0218')",
                      guard)
        self.assertIn("('public.film_precheck(public.films)', 'ff4fa7e8a6386420f32ab6a3a85a778c', '0a89da5f19fa2c6c0f6d802c02e18925', '0171')",
                      guard)
        self.assertNotIn("5de6c9bb2a74079e2078cad2d91b3c34", guard, "production has 0218: 0171's film_price is no longer a base")
        self.assertIn("with a body that is neither %''s nor 0220''s", SQL)
        self.assertIn("apply 0218_creative_prompt_limits.sql first", SQL)

    def test_it_has_an_end_state_and_a_verify_block_and_adds_no_grant(self):
        self.assertIn("0220 end state", SQL)
        self.assertIn("-- Verify (read-only, run after applying)", SQL)
        lowered = SQL.lower()
        self.assertNotIn("grant ", "\n".join(ln.split("--", 1)[0] for ln in lowered.splitlines()))
        self.assertNotIn("create table", lowered)
        self.assertNotIn("drop ", "\n".join(ln.split("--", 1)[0] for ln in lowered.splitlines()))


class TheRollbackAndTheDoc(unittest.TestCase):
    def test_the_rollback_restores_0218s_film_price_and_0171s_precheck_byte_for_byte(self):
        self.assertEqual(rollback_film_price(), body(M0218, "film_price"))
        self.assertEqual(body(ROLLBACK, "film_precheck"), body(M0171, "film_precheck"))
        self.assertIn("'3c22f87be736c073d17d93e040e914e1', '0218'", ROLLBACK)
        self.assertLess(ROLLBACK.index("is missing or is not 0220''s body"), ROLLBACK.index("create or replace function"))
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)

    def test_the_apply_order_is_stated(self):
        for text in (SQL, DOC.split("(0220)", 1)[1] if "(0220)" in DOC else ""):
            self.assertIn("voice_language_unknown", text)
            self.assertIn("--model elevenlabs-multilingual-v2", text)
            self.assertIn("0214", text)
            self.assertIn("0218", text)


if __name__ == "__main__":
    unittest.main()
