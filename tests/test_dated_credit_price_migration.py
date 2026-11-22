"""supabase/migrations/0224_dated_credit_price.sql — a credit price scheduled to change at an exact moment (owner decision D7).

SQL runs in tests/security/test_sec_dated_price_0224.py (a real Postgres). These pin what must not drift by accident: creative_price is
0208's body plus exactly ONE line (another stream rewrites creative_price; the smaller the hunk, the safer the merge), the hashes in
the drift guard, the end state, the Verify block, the rollback and the lab are recomputed from the files, the rollback puts 0208's
body back verbatim and keeps the owner's rows, the file inserts no price, and no API role is granted anything.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
TEXT = (MIG / "0224_dated_credit_price.sql").read_text(encoding="utf-8")
T208 = (MIG / "0208_geo_gate_and_image_size_price.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0224_dated_credit_price.sql").read_text(encoding="utf-8")
LAB = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
EXPECT = (ROOT / "tests" / "security" / "sec_expectations.py").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in TEXT.splitlines())

#: The one line 0224 adds to 0208's creative_price, right after the price-list read. Tell the stream rewriting creative_price.
LINE = ("    rate.credits_per_unit := public.credits_per_unit_now(rate.unit);  "
        "-- 0224: a dated price (credit_price_schedule) once it is in force\n")
ANCHOR = "    select * into rate from public.credit_prices where unit = m_unit;\n"


def bodies(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"(?m)^create or replace function public\.(\w+)\(.*?^\$\$;\n", text, re.S)}


def md5_of(fn):
    b = fn[fn.index("$$") + 2: fn.rindex("$$")]
    return hashlib.md5(re.sub(r"\s+", " ", b).encode()).hexdigest()


NEW = bodies(TEXT)
CP_OLD = bodies(T208)["creative_price"]


class DatedCreditPriceMigration(unittest.TestCase):
    def test_it_creates_exactly_these_functions(self):
        self.assertEqual(set(NEW), {"credit_price_schedule_guard", "credit_price_schedule_append_only", "credits_per_unit_now",
                                    "creative_price"})

    def test_creative_price_is_0208s_plus_exactly_one_line(self):
        self.assertEqual(md5_of(CP_OLD), "f61aaddd5686045961addd6f14a02c32")
        new = NEW["creative_price"]
        self.assertEqual(new.count(LINE), 1)
        self.assertEqual(new.replace(LINE, ""), CP_OLD, "creative_price differs from 0208's beyond the one line")
        self.assertIn(ANCHOR + LINE, new, "the line must follow the price-list read, inside its `if m_unit is not null`")

    def test_every_hash_is_recomputed_from_the_files(self):
        old, new = md5_of(CP_OLD), md5_of(NEW["creative_price"])
        self.assertGreaterEqual(TEXT.count(new), 4)        # header, drift guard, end state, Verify block
        self.assertGreaterEqual(TEXT.count(old), 2)        # header, drift guard
        self.assertTrue(old in ROLLBACK)
        self.assertTrue(new in ROLLBACK)
        self.assertIn(md5_of(NEW["credits_per_unit_now"]), TEXT.split("-- Verify")[0].split("-- End state")[1])
        self.assertIn(f'CREATIVE_PRICE_0224 = "{new}"', LAB)

    def test_the_guard_accepts_only_0208s_body_or_its_own(self):
        guard = TEXT.split("-- 1. The schedule")[0]
        self.assertIn(f"array['{md5_of(CP_OLD)}', '{md5_of(NEW['creative_price'])}']", guard)
        self.assertIn("raise exception '0224 found creative_price", guard)

    def test_it_inserts_no_price_and_grants_nothing(self):
        low = CODE.lower()
        self.assertNotRegex(low, r"insert\s+into")
        self.assertNotRegex(low, r"update\s+public\.")
        self.assertNotIn("grant ", low)
        self.assertNotIn("create policy", low)
        for stmt in ("revoke all on table public.credit_price_schedule from public, anon, authenticated, service_role;",
                     "revoke all on sequence public.credit_price_schedule_id_seq from public, anon, authenticated, service_role;",
                     "revoke all on function public.credits_per_unit_now(text) from public, anon, authenticated, service_role;",
                     "revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;",
                     "alter table public.credit_price_schedule enable row level security;"):
            self.assertIn(stmt, TEXT)

    def test_the_schedule_is_append_only_and_positive(self):
        self.assertIn("check (credits_per_unit > 0)", TEXT)
        self.assertIn("before update or delete on public.credit_price_schedule", TEXT)
        self.assertIn("before truncate on public.credit_price_schedule", TEXT)
        self.assertIn("before insert on public.credit_price_schedule", TEXT)
        guard = NEW["credit_price_schedule_guard"]
        self.assertIn("new.created_by := session_user;", guard)
        self.assertIn("new.created_at := now();", guard)

    def test_the_reader_prefers_the_newest_row_in_force_and_never_answers_zero(self):
        reader = NEW["credits_per_unit_now"]
        self.assertIn("s.effective_at <= now()", reader)
        self.assertIn("order by s.effective_at desc, s.id desc", reader)
        self.assertIn("from public.credit_prices cp where cp.unit = p_unit", reader)
        self.assertNotRegex(reader.split("$$")[1].split("--")[-1], r"coalesce\([^)]*,\s*0\)")
        self.assertNotIn("security definer", reader.split("$$")[0])

    def test_the_rollback_puts_0208s_body_back_verbatim_and_keeps_the_table(self):
        restored = ROLLBACK[ROLLBACK.index("execute $fn$") + len("execute $fn$"):ROLLBACK.index("$fn$;")]
        self.assertEqual(restored + ";\n", CP_OLD)
        self.assertIn("drop function if exists public.credits_per_unit_now(text);", ROLLBACK)
        self.assertNotIn("drop table", ROLLBACK.lower())
        self.assertIn("credits_per_unit_now(", ROLLBACK.split("drop function")[0])   # refuses when a later file calls the reader

    def test_the_lab_knows_0224(self):
        self.assertIn("return rollback_0224_body() + ", LAB)
        self.assertIn("put_back_0224(conn)", LAB)
        self.assertGreaterEqual(LAB.count('"0224_dated_credit_price.sql"'), 3)   # ON_0156, ON_0139, ON_0124
        self.assertIn('TABLES.update({"credit_price_schedule": Service()})', EXPECT)
        self.assertIn('FUNCTIONS.update({"credits_per_unit_now": SERVICE})', EXPECT)


if __name__ == "__main__":
    unittest.main()
