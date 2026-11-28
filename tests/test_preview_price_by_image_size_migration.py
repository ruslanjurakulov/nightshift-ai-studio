"""supabase/migrations/0243_preview_price_by_image_size.sql: an operator preview of a picture model priced by size is quoted at exactly
the requested size's reviewed figure, and a size without one stays unpriced. The two cleared Google picture rows are marked
operator_preview on that basis.

SQL does not run in this suite (tests/security/test_sec_preview_price_by_image_size_0243.py does, against a real Postgres). These pin
what must not change by accident:

* creative_price is 0228's body plus exactly two marked hunks (undo them and the rest is 0228's executed text byte for byte), and the
  new WHEN reads the size's own figure and nothing else (no other size, no largest size, no flat figure);
* the drift guard accepts only 0228's body (or this file's own, on a replay) and refuses any other by name; the end state, the rollback
  and the lab carry the hashes recomputed from the files;
* no row is written and nothing is granted; the files carry no backslash;
* the registry marks both Google rows operator_preview with every gate the owner left in place, and every size they list has a figure
  the preview rate can read (no dead end in the operator's Studio);
* the lab knows the chain, and the docs describe it.
"""

import hashlib
import re
import unittest
from pathlib import Path

from modules import model_registry as reg

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
TEXT = (MIG / "0243_preview_price_by_image_size.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0243_preview_price_by_image_size.sql").read_text(encoding="utf-8")
M0228 = (MIG / "0228_music_per_request_price.sql").read_text(encoding="utf-8")
LAB = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
DOCS = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in TEXT.splitlines())

BEFORE = "33bb0ea77aedd1ffc3df339034adc6d3"   # 0228's creative_price, the live body this file is written on
AFTER = "9268c201fd930c1f7519cc601118661e"
BS = chr(92)

HUNK_COMMENT = """  -- 0243: a model priced by picture size states one figure per size (pricing.variants.prices, keyed by spec.image_sizes), and the
  -- figure is vsize's: the size the request named (0208 above refuses a quote of such a model that names none, or one it does not
  -- list), the one the quote names, the job carries and the worker sends as imageSize. A size without its own figure is unpriced:
  -- never another size's figure, never the largest size's, never provider_usd_per_unit.
"""
HUNK_WHEN = """              when m_spec -> 'pricing' -> 'variants' ->> 'by' = 'image_size' and vsize is not null
                then m_spec -> 'pricing' -> 'variants' -> 'prices' -> vsize
"""

GOOGLE = ("gemini-3-pro-image", "gemini-nano-banana-2.1")


def md5_of(fn):
    b = fn[fn.index("$$") + 2: fn.rindex("$$")]
    return hashlib.md5(re.sub(r"\s+", " ", b).encode()).hexdigest()


def executed_body(text, tag, token):
    """The creative_price body a file executes through replace(..., chr(92)), with the backslashes put back."""
    m = re.search(rf"\${tag}\$(create or replace function public\.creative_price\(.*?\$\$)\${tag}\$", text, re.S)
    assert m, tag
    return m.group(1).replace(token, BS) + ";\n"


OLD = executed_body(M0228, "cp0228", "@@0228_BACKSLASH@@")
NEW = executed_body(TEXT, "cp0243", "@@0243_BACKSLASH@@")


class TheBody(unittest.TestCase):
    def test_the_hashes_are_the_files_own(self):
        self.assertEqual(md5_of(OLD), BEFORE)
        self.assertEqual(md5_of(NEW), AFTER)

    def test_it_is_0228s_body_plus_the_two_hunks_and_nothing_else(self):
        self.assertEqual(NEW.count(HUNK_COMMENT), 1)
        self.assertEqual(NEW.count(HUNK_WHEN), 1)
        self.assertEqual(NEW.replace(HUNK_COMMENT, "").replace(HUNK_WHEN, ""), OLD, "anything but the two hunks changed")

    def test_the_new_when_sits_in_the_preview_rate_after_0153s_and_before_the_cast(self):
        case = NEW[NEW.index("    vusd := case\n"):NEW.index("    vcost := case")]
        self.assertLess(case.index("'by' = 'quality' and tier is not null"), case.index(HUNK_WHEN))
        # Only inside the preview branch: no figure is read for a quote that is not a preview, nor where a credit price exists.
        self.assertLess(NEW.index("  if preview and m_unit is not null and rate.unit is null\n"), NEW.index(HUNK_WHEN))

    def test_the_figure_is_the_requested_sizes_and_never_another(self):
        # The key is vsize, the size the request named (0208's hunk, unchanged): never a literal size, never the largest one, never
        # provider_usd_per_unit, never a coalesce that would fall through to another figure.
        self.assertIn("-> 'prices' -> vsize\n", HUNK_WHEN)
        for wrong in ("coalesce", "'4K'", "'1K'", "provider_usd_per_unit", "max(", "jsonb_each", "order by"):
            self.assertNotIn(wrong, HUNK_WHEN, wrong)
        # vsize is set only from the request (0208), and only after the size was checked against the model's own list.
        self.assertEqual(NEW.count("vsize := "), 1)
        self.assertIn("    vsize := p_params ->> 'image_size';\n", NEW)
        self.assertLess(NEW.index("does not offer the %s size"), NEW.index("    vsize := p_params ->> 'image_size';\n"))
        self.assertIn("is sold by picture size: name image_size", NEW)

    def test_the_cast_and_the_bounds_are_0149s_unchanged(self):
        for line in ("    vcost := case when jsonb_typeof(vusd) = 'number' then (vusd #>> '{}')::numeric end;\n",
                     "    if vcost > 0 and vcost <= 100 then\n",
                     "      rate.credits_per_unit := vcost * 100;\n",
                     "      rate.margin := 0;\n"):
            self.assertEqual(NEW.count(line), 1, line)

    def test_every_guard_of_creative_price_is_kept(self):
        for needle in ("public.model_is_available(mdl)", "public.model_past_shutdown(r.spec)",
                       "public.creative_operator_preview(p_org, r.availability, r.spec)", "public.credits_per_unit_now(rate.unit)",
                       "preview := m_avail not in ('beta', 'ga');", "if cap = 'music' and m_spec -> 'pricing' ->> 'unit' = 'request' then"):
            self.assertIn(needle, NEW, needle)
        self.assertIn("language plpgsql stable security definer set search_path = public, pg_temp as $$", NEW)


class TheGuards(unittest.TestCase):
    def test_the_drift_guard_takes_only_0228s_body_or_its_own_and_refuses_by_name(self):
        self.assertIn(f"h <> all (array['{BEFORE}', '{AFTER}'])", TEXT)
        self.assertIn("0243 found a creative_price() that is neither 0228''s body nor 0243''s (md5 %)", TEXT)
        # The guard runs before the body is replaced.
        self.assertLess(TEXT.index("0243 found a creative_price()"), TEXT.index("execute replace($cp0243$"))
        # It folds white space the way every guard here does, without a backslash.
        self.assertIn("md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g'))", TEXT)
        # No older body is accepted: 0224's (0228 not applied) or 0218's.
        for old in ("ea2b58e88fe34ae18b261e5a0fbef435", "59c5c289009a874af043c534b29934ee"):
            self.assertNotIn(old, CODE)

    def test_the_end_state_and_the_verify_block_carry_the_recomputed_hash(self):
        end = TEXT[TEXT.index("-- End state"):]
        self.assertIn(f"<> '{AFTER}' then", end)
        self.assertIn("can call creative_price", end)
        verify = TEXT[TEXT.index("-- Verify (the SQL editor, after applying"):]
        self.assertIn(f"= '{AFTER}' as price_is_0243s", verify)
        self.assertTrue(all(ln.startswith("--") for ln in verify.splitlines() if ln.strip()))

    def test_the_rollback_puts_0228s_body_back_byte_for_byte_and_only_from_0243s(self):
        self.assertEqual(executed_body(ROLLBACK, "cp0228", "@@0243_BACKSLASH@@"), OLD)
        self.assertIn(f"where oid = to_regprocedure('public.creative_price(uuid, text, text, jsonb)')) = '{AFTER}'", ROLLBACK)
        end = ROLLBACK[ROLLBACK.index("-- End state"):]
        self.assertIn(f"<> '{BEFORE}' then", end)
        self.assertIn("'off') <> 'on' then\n    return;", end)
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)


class NothingElse(unittest.TestCase):
    def test_both_end_states_name_the_owner_and_a_rollback_that_does_nothing_says_so(self):
        # Breach 0243 F2: the md5 reads only the source; create or replace keeps a hand-changed owner. Lens N2: a no-op is said.
        self.assertIn("is distinct from 'postgres' then\n    raise exception '0243 end state: creative_price is not owned by postgres'",
                      TEXT)
        self.assertIn("raise exception 'rollback 0243 end state: creative_price is not owned by postgres'", ROLLBACK)
        self.assertIn("raise notice 'rollback 0243: creative_price is not 0243''s body (md5 %); nothing changed'", ROLLBACK)

    def test_it_writes_no_row_and_grants_nothing(self):
        low = CODE.lower()
        for word in ("insert into", "update public.", "delete from", "grant ", "truncate", "alter table"):
            self.assertNotIn(word, low, word)
            self.assertNotIn(word, "\n".join(ln.split("--", 1)[0] for ln in ROLLBACK.splitlines()).lower(), word)
        self.assertEqual(low.count("revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, "
                                   "authenticated, service_role;"), 1)
        self.assertEqual(low.count("create or replace function"), 1)

    def test_the_files_carry_no_backslash_and_no_price_figure(self):
        self.assertNotIn(BS, TEXT)
        self.assertNotIn(BS, ROLLBACK)
        # The repo is public: the files read the registry's figures, they never state one.
        for figure in ("0.134", "0.24", "0.0336", "0.0504", "0.113"):
            self.assertNotIn(figure, TEXT)
            self.assertNotIn(figure, ROLLBACK)

    def test_the_number_is_unique(self):
        self.assertEqual(sorted(p.name for p in MIG.glob("0243_*.sql")), ["0243_preview_price_by_image_size.sql"])


def _figure_ok(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and 0 < x <= 100


class TheRegistry(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def test_both_google_rows_are_operator_previews_and_keep_every_other_gate(self):
        for mid in GOOGLE:
            e = self.r[mid]
            with self.subTest(mid=mid):
                self.assertIs(e.raw.get("operator_preview"), True)
                self.assertIsNone(e.raw["terms_gate"])
                self.assertEqual(e.raw["api_exposure"], "web_only")
                self.assertNotIn("availability", e.raw)           # the database's: hidden, never the file's
                self.assertIs(e.raw["requires_adult"], True)
                self.assertTrue(e.raw["blocked_countries"] and e.raw["available_countries"])
                self.assertEqual(e.raw["pricing"]["variants"]["by"], "image_size")
                self.assertIn("migration 0243", " ".join(e.raw["terms_notes"]))

    def test_every_size_a_size_priced_preview_lists_has_its_own_figure(self):
        # The Studio offers exactly spec.image_sizes (lib/creative/studio.ts) and 0208 refuses any other: each must be priceable,
        # or that choice is a dead end. A figure present for a size the model does not list would be one the validator refuses.
        for e in self.r.values():
            if e.raw.get("operator_preview") is not True or e.variants_by != "image_size":
                continue
            prices = e.raw["pricing"]["variants"]["prices"]
            self.assertTrue(e.image_sizes, e.id)
            for size in e.image_sizes:
                self.assertTrue(_figure_ok(prices.get(size)), f"{e.id} {size}")

    def test_the_validator_takes_the_marked_registry(self):
        # No new field: the per-size figures were already in pricing.variants.prices, keyed by image_sizes, which the validator checks.
        import json
        self.assertEqual(reg.validate(json.loads(reg.REGISTRY_PATH.read_text(encoding="utf-8"))), [])


class TheLabAndTheDocs(unittest.TestCase):
    def test_the_lab_knows_the_chain(self):
        self.assertIn(f'CREATIVE_PRICE_0243 = "{AFTER}"', LAB)
        self.assertIn('MIGRATION_0243 = MIGRATIONS / "0243_preview_price_by_image_size.sql"', LAB)
        # 0243 comes off before 0228's rollback, and goes back on after 0228.
        off = LAB[LAB.index("def take_off_0228("):LAB.index("def put_back_0228(")]
        self.assertLess(off.index("take_off_0243(conn)"), off.index("rollback_0228_body()"))
        on = LAB[LAB.index("def put_back_0228("):LAB.index("MIGRATION_0243 =")]
        self.assertIn("put_back_0243(conn)", on)
        r0228 = LAB[LAB.index("def rollback_0228_body("):LAB.index("def has_0228(")]
        self.assertIn("return rollback_0243_body() + ", r0228)
        for fn in ("has_0159", "has_0208", "has_0218"):
            seg = LAB[LAB.index(f"def {fn}("):]
            self.assertIn("CREATIVE_PRICE_0243", seg[:seg.index("\ndef ")], fn)
        on_0124 = LAB[LAB.index("ON_0124 = ("):]
        on_0124 = on_0124[:on_0124.index(")\n")]
        self.assertTrue(on_0124.rstrip().endswith('"0243_preview_price_by_image_size.sql"'))
        self.assertLess(on_0124.index('"0228_music_per_request_price.sql"'), on_0124.index('"0243_preview_price_by_image_size.sql"'))
        self.assertIn('ON_0139 = (*(f for f in ON_0139 if f != "0243_preview_price_by_image_size.sql"), '
                      '"0243_preview_price_by_image_size.sql")', LAB)

    def test_the_docs_describe_it(self):
        self.assertIn("(0243)", DOCS)
        section = DOCS[DOCS.index("Operator preview priced by picture size (0243)"):]
        for needle in ("rollback_0243_preview_price_by_image_size.sql", BEFORE, AFTER, "unpriced", "--sync"):
            self.assertIn(needle, section)


if __name__ == "__main__":
    unittest.main()
