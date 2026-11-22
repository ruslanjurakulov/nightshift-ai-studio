"""Migration 0214 (does a film's voice model speak the film's language), pinned as text.

What would break, and which test says so:

* the helper becoming callable by any API role (it runs inside quote_film as the owner, like film_model_problem), or losing
  security definer / its pinned search_path;
* the proposed quote_film line asking the language before the role check (a hidden model would be answered with a language
  detail naming its row instead of model_not_available), or the remedy naming the untried Eleven v4;
* a language outside the three that were checked answering "does not speak" instead of "unknown";
* the helper reading anything but the registry's own list (model_registry.spec -> 'languages'), or a missing list, row or
  language reading as "speaks" (rule 5: it must say voice_language_unknown);
* the file changing a money function: quote_film, start_film, film_price and the credit ledger are S2's, and this file only
  names the line S2 adds;
* the file not being additive (a drop, a table, an update of existing rows), or losing its Verify block;
* a rollback that does not remove the function, or removes it while quote_film still calls it;
* the migration missing from docs/MIGRATIONS.md.

The lab (tests/security/test_sec_voice_language.py) runs the same file on a real PostgreSQL; this test needs none.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0214_voice_language_check.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0214_voice_language_check.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
SIG = "public.voice_language_problem(text, text)"


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


CODE = code(SQL)


class TheFunctionIsClosedAndPinned(unittest.TestCase):
    def test_security_definer_stable_with_a_pinned_search_path(self):
        head = re.search(r"create or replace function public\.voice_language_problem\(p_model text, p_language text\)"
                         r"\s+returns jsonb\s+language plpgsql (.*?) as \$\$", CODE, re.S)
        self.assertIsNotNone(head, "the function's signature changed")
        self.assertIn("stable", head.group(1))
        self.assertIn("security definer", head.group(1))
        self.assertIn("set search_path = public, pg_temp", head.group(1))

    def test_no_role_may_execute_it(self):
        self.assertIn(f"revoke all on function {SIG} from public, anon, authenticated, service_role;", CODE)
        self.assertNotIn("grant ", CODE.lower())


class UnknownIsNeverSpeaks(unittest.TestCase):
    def body(self) -> str:
        return re.search(r"as \$\$(.*?)\$\$;", CODE.split("create or replace function public.voice_language_problem", 1)[1],
                         re.S).group(1)

    def test_it_reads_the_registry_list(self):
        b = self.body()
        self.assertIn("from public.model_registry where id = p_model", b)
        self.assertIn("m.spec -> 'languages'", b)
        self.assertIn("langs @> jsonb_build_array(lang)", b)

    def test_the_refusal_words_and_shape(self):
        b = self.body()
        self.assertEqual(b.count("'voice_language_unknown'"), 3, "no language, no row and no list each answer unknown")
        self.assertEqual(b.count("'voice_language_unsupported'"), 1)
        self.assertEqual(b.count("'priced', false"), 4)
        self.assertIn("when lang = 'uz' then '; choose Eleven v3, a voice model that lists Uzbek'", b)
        self.assertNotIn("v4", b, "v4 lists Uzbek but is untried: the remedy names v3 only, like tts_languages.UZBEK_FIX")

    def test_a_language_outside_the_three_checked_is_unknown(self):
        b = self.body()
        guard = b.index("if lang = '' or lang not in ('en', 'ru', 'uz') then")
        self.assertLess(guard, b.index("'voice_language_unsupported'"))
        self.assertIn("'voice_language_unknown'", b[guard:b.index("end if;", guard)])

    def test_the_only_null_is_after_the_list_holds_the_language(self):
        b = self.body()
        nulls = [m.start() for m in re.finditer(r"return null;", b)]
        self.assertEqual(len(nulls), 1)
        self.assertLess(b.index("if langs @> jsonb_build_array(lang) then"), nulls[0])
        # Every unknown answer comes before the one place that may say "no problem".
        self.assertTrue(all(m.start() < nulls[0] for m in re.finditer("'voice_language_unknown'", b)))


class ItIsAdditiveAndTouchesNoMoney(unittest.TestCase):
    def test_no_money_or_film_function_is_replaced(self):
        made = re.findall(r"create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)", CODE, re.I)
        self.assertEqual(made, ["voice_language_problem"])
        for word in ("credit_", "quote_film(", "start_film(", "film_price(", "insert into", "update public.", "delete from"):
            self.assertNotIn(word, CODE.lower(), word)

    def test_nothing_is_dropped_and_no_table_is_made(self):
        lowered = CODE.lower()
        self.assertNotIn("drop ", lowered)
        self.assertNotIn("create table", lowered)
        self.assertNotIn("alter table", lowered)

    def test_it_names_the_line_s2_adds_and_ends_with_a_verify_block(self):
        line = re.search(r"q := coalesce\(public\.film_model_problem\(f\.voice ->> 'model', array\['tts'\], 'voice\.model'\),\n"
                         r"--\s+public\.voice_language_problem\(f\.voice ->> 'model', f\.language\),\n"
                         r"--\s+public\.film_try_price\(", SQL)
        self.assertIsNotNone(line, "the role check first, then the language, then the price")
        self.assertIn("-- Verify (run after applying", SQL)
        self.assertIn("voice_language_unsupported", SQL.split("-- Verify", 1)[1])

    def test_it_requires_the_registry(self):
        self.assertIn("to_regclass('public.model_registry') is null", CODE)


class TheRollbackAndTheDoc(unittest.TestCase):
    def test_the_rollback_drops_it_and_refuses_while_something_calls_it(self):
        rb = code(ROLLBACK)
        self.assertIn("drop function if exists public.voice_language_problem(text, text);", rb)
        self.assertLess(rb.index("prosrc like '%voice_language_problem%'"), rb.index("drop function"))
        self.assertIn("to_regprocedure('public.voice_language_problem(text,text)') is not null", rb)

    def test_the_migration_is_in_the_migrations_doc(self):
        self.assertIn("0214_voice_language_check.sql", MIGRATIONS_DOC)
        self.assertIn("rollback_0214_voice_language_check.sql", MIGRATIONS_DOC)

    def test_the_reprobe_names_each_model_because_all_skips_gated_ones(self):
        cmd = "--sync --model elevenlabs-v4 --model elevenlabs-v3"
        for text in (SQL, MIGRATIONS_DOC):
            flat = re.sub(r"\s+", " ", text.replace("\\\n--", " ").replace("--   ", " "))
            self.assertIn(cmd, flat)
            self.assertIn("--model elevenlabs-multilingual-v2 --model elevenlabs-flash-v2.5", flat)
            self.assertNotIn("--capability tts", text)
        self.assertIn("select id, availability, verified_at from public.model_registry where 'tts' = any(capabilities);",
                      MIGRATIONS_DOC)


if __name__ == "__main__":
    unittest.main()
