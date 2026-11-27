"""supabase/migrations/0228_music_per_request_price.sql: the database knows `music`, and a model priced per request (Google Lyria 3.5,
"per song") is quoted for one request with no duration. Nothing goes on sale.

SQL does not run in this suite (tests/security/test_sec_music_per_request_0228.py does, against a real Postgres, with S10's 0224
applied first). These pin what must not change by accident:

* each replaced body is the old body plus exactly the one marked 0228 hunk (undo it and the rest is the old text byte for byte):
  creative_params_problem is 0218's, creative_price is 0218's with 0224's one line;
* the drift guard accepts only those two old bodies (or this file's own, on a replay), so 0228 never lands on 0218's creative_price
  alone; the end state, the rollback and the lab carry the hashes recomputed from the files;
* `music` is the only value added to 0100's two capability checks;
* no row is written (no price is seeded) and nothing is granted; the files carry no backslash;
* the code keeps `music` registry-only until 0228 is confirmed live;
* the docs describe it.
"""

import hashlib
import re
import unittest
from pathlib import Path

from modules.capabilities.base import MUSIC, REGISTRY_ONLY_CAPABILITIES

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
TEXT = (MIG / "0228_music_per_request_price.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0228_music_per_request_price.sql").read_text(encoding="utf-8")
M0218 = (MIG / "0218_creative_prompt_limits.sql").read_text(encoding="utf-8")
M0100 = (MIG / "0100_video_ai_ops.sql").read_text(encoding="utf-8")
LAB = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in TEXT.splitlines())

BEFORE = {"creative_params_problem": "cb7ad6cd459f31259445bedd1a4a0c88", "creative_price": "ea2b58e88fe34ae18b261e5a0fbef435"}
AFTER = {"creative_params_problem": "0570bb5a1f749b7e3d556c87443bf17b", "creative_price": "c586c11789c90db275ddbe03c6fb1000"}
BS = chr(92)
TOKEN = "@@0228_BACKSLASH@@"
#: 0224's one line in 0218's creative_price (tests/test_creative_prompt_limits_migration.py pins the same line).
ANCHOR_0224 = "    select * into rate from public.credit_prices where unit = m_unit;\n"
LINE_0224 = ("    rate.credits_per_unit := public.credits_per_unit_now(rate.unit);  -- 0224: a dated price (credit_price_schedule) "
             "once it is in force\n")

HUNK_PP_OLD = """  if timed then
    if not public.creative_json_int(p_params -> 'duration_s', 1, 60) then"""
HUNK_PRICE_ANCHOR = """    qty := public.creative_quantity(cap, p_params);
  end if;
"""


def md5_of(fn):
    b = fn[fn.index("$$") + 2: fn.rindex("$$")]
    return hashlib.md5(re.sub(r"\s+", " ", b).encode()).hexdigest()


def plain_body(text, name):
    m = re.search(rf"(?m)^create or replace function public\.{name}\(.*?^\$\$;\n", text, re.S)
    assert m, name
    return m.group(0)


def executed_body(text, tag):
    """The creative_price body a file executes through replace(..., chr(92)), with the backslashes put back."""
    m = re.search(rf"\${tag}\$(create or replace function public\.creative_price\(.*?\$\$)\${tag}\$", text, re.S)
    assert m, tag
    return m.group(1).replace(TOKEN, BS) + ";\n"


def hunk_of(text, start, end):
    i = text.index(start)
    return text[i:text.index(end, i) + len(end)]


class TheBodies(unittest.TestCase):
    def test_creative_params_problem_is_0218s_plus_one_hunk(self):
        old = plain_body(M0218, "creative_params_problem")
        new = plain_body(TEXT, "creative_params_problem")
        self.assertEqual(md5_of(old), BEFORE["creative_params_problem"])
        self.assertEqual(md5_of(new), AFTER["creative_params_problem"])
        hunk = hunk_of(new, "  if timed then\n    -- 0228:", "'duration_s', 1, 60) then")
        self.assertEqual(new.replace(hunk, HUNK_PP_OLD), old, "anything but the one hunk changed")
        self.assertIn("not (p_capability = 'music' and not p_params ? 'duration_s')", hunk)

    def test_creative_price_is_0224s_plus_one_hunk(self):
        old = plain_body(M0218, "creative_price").replace(ANCHOR_0224, ANCHOR_0224 + LINE_0224)
        self.assertEqual(md5_of(old), BEFORE["creative_price"])
        new = executed_body(TEXT, "cp0228")
        self.assertEqual(md5_of(new), AFTER["creative_price"])
        hunk = hunk_of(new, "  -- 0228: a model the registry prices per request", "is required', mdl));\n  end if;\n")
        self.assertEqual(new.replace(hunk, ""), old, "anything but the one hunk changed")
        self.assertIn("if m_spec -> 'pricing' ->> 'unit' = 'request' then\n    qty := 1;", hunk)
        self.assertIn("elsif cap = 'music' and not p_params ? 'duration_s' then", hunk)
        self.assertIn("perform public.creative_refuse('invalid_params'", hunk)
        # Right after the quantity is read, before the unknown-length refusal: a per-request model is never "length unknown".
        self.assertEqual(new.index(hunk), new.index(HUNK_PRICE_ANCHOR) + len(HUNK_PRICE_ANCHOR))

    def test_the_rollback_puts_the_old_bodies_back_byte_for_byte(self):
        m = re.search(r"\$pp0218\$(create or replace function public\.creative_params_problem\(.*?\$\$;)\$pp0218\$", ROLLBACK, re.S)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1) + "\n", plain_body(M0218, "creative_params_problem"))
        self.assertEqual(md5_of(m.group(1)), BEFORE["creative_params_problem"])
        self.assertEqual(md5_of(executed_body(ROLLBACK, "cp0224")), BEFORE["creative_price"])


class TheGuards(unittest.TestCase):
    def test_the_drift_guard_takes_only_0218s_params_and_0224s_price_or_its_own(self):
        self.assertIn(f"array['{BEFORE['creative_params_problem']}', '{AFTER['creative_params_problem']}']", TEXT)
        self.assertIn(f"array['{BEFORE['creative_price']}', '{AFTER['creative_price']}']", TEXT)
        # 0218's creative_price alone (no 0224) is not accepted: 0228 is written on 0224's line.
        self.assertNotIn("59c5c289009a874af043c534b29934ee'", CODE)
        self.assertIn("to_regprocedure('public.credits_per_unit_now(text)') is null", TEXT)

    def test_the_end_state_and_the_lab_carry_the_recomputed_hashes(self):
        for h in AFTER.values():
            self.assertIn(f"<> '{h}' then", TEXT)
            self.assertIn(h, ROLLBACK)
        self.assertIn(f'CREATIVE_PRICE_0228 = "{AFTER["creative_price"]}"', LAB)
        self.assertIn(f'CREATIVE_PARAMS_PROBLEM_0228 = "{AFTER["creative_params_problem"]}"', LAB)
        off = LAB[LAB.index("def take_off_0218("):LAB.index("def put_back_0218(")]
        self.assertLess(off.index("take_off_0228(conn)"), off.index("rollback_0218_body()"))
        self.assertIn("put_back_0228(conn)", LAB[LAB.index("def put_back_0218("):LAB.index("def migration_0218_lab(")])
        self.assertIn("rollback_0228_body() +", LAB[LAB.index("def rollback_0208_body("):LAB.index("def take_off_0208(")])


class TheChecks(unittest.TestCase):
    @staticmethod
    def values(text, name):
        m = re.search(rf"add constraint {name}\s+check \((.*?)\);", text, re.S)
        assert m, name
        return re.findall(r"'([a-z0-9_]+)'", m.group(1))

    def test_music_is_the_only_value_added_to_each_check(self):
        for name in ("model_registry_capabilities_check", "model_probe_runs_capability_check"):
            self.assertEqual(self.values(TEXT, name), self.values(M0100, name) + ["music"], name)
        self.assertIn("cardinality(capabilities) between 1 and 19", TEXT)

    def test_the_rollback_takes_it_out_again_but_never_deletes_a_row(self):
        for name in ("model_registry_capabilities_check", "model_probe_runs_capability_check"):
            self.assertEqual(self.values(ROLLBACK, name), self.values(M0100, name), name)
        low = "\n".join(line.split("--", 1)[0] for line in ROLLBACK.splitlines()).lower()
        self.assertNotIn("delete from", low)
        self.assertIn("names music; take it out first", ROLLBACK)


class NothingElse(unittest.TestCase):
    def test_it_writes_no_row_and_grants_nothing(self):
        low = CODE.lower()
        for word in ("insert into", "update public.", "delete from", "grant ", "truncate"):
            self.assertNotIn(word, low, word)
        self.assertEqual(low.count("revoke all on function"), 2)

    def test_no_price_is_seeded_for_lyria(self):
        self.assertNotRegex(CODE.lower(), r"insert[^;]*credit_prices")

    def test_the_files_carry_no_backslash(self):
        self.assertNotIn(BS, TEXT)
        self.assertNotIn(BS, ROLLBACK)

    def test_the_code_keeps_music_registry_only_until_0228_is_confirmed_live(self):
        self.assertIn(MUSIC, REGISTRY_ONLY_CAPABILITIES)

    def test_the_number_is_unique(self):
        self.assertEqual(sorted(p.name[:4] for p in MIG.glob("*.sql")).count("0228"), 1)

    def test_the_docs_describe_it(self):
        docs = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
        self.assertIn("(0228)", docs)
        self.assertIn("rollback_0228_music_per_request_price.sql", docs)


if __name__ == "__main__":
    unittest.main()
