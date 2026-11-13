"""supabase/migrations/0155_shape_offered_by_model.sql — a quote refuses a shape the model does not list.

SQL does not run in this suite (tests/security/test_sec_shape_offered_by_model.py does that, against a real Postgres). These pin what
must not change by accident: creative_price is 0153's body plus exactly the one listed hunk (undo it and the rest is 0153's text byte
for byte), the money and preview functions are not replaced, the list read is the worker's own (ModelEntry.aspects_for), the drift
guard, the end state and the rollback name the hashes recomputed from the files, the grants, the lab knows the chain, and every
registry entry states the list the database will read.
"""

import hashlib
import re
import unittest
from pathlib import Path

from modules import model_registry as reg
from modules.capabilities.base import CapabilityRequest

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
NEW_TEXT = (MIG / "0155_shape_offered_by_model.sql").read_text(encoding="utf-8")
OLD_TEXT = (MIG / "0153_preview_price_by_quality.sql").read_text(encoding="utf-8")
ROLLBACK_TEXT = (ROOT / "docs" / "sql" / "rollback_0155_shape_offered_by_model.sql").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in NEW_TEXT.splitlines())


def bodies(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"(?m)^create or replace function public\.(\w+)\(.*?^\$\$;\n", text, re.S)}


def body(fn):
    return fn[fn.index("$$") + 2: fn.rindex("$$")]


def md5_of(fn):
    return hashlib.md5(re.sub(r"\s+", " ", body(fn)).encode()).hexdigest()


NEW = bodies(NEW_TEXT)
OLD = bodies(OLD_TEXT)
CP_0153 = "28130a014027e6ad0b7876a78d69a396"

#: The one block 0155 adds, right after 0100's video_reframe check. Nothing else may differ from 0153's body.
ANCHOR = ("    perform public.creative_refuse('invalid_params',\n"
          "      format('%s does not reframe a video to %s', mdl, p_params ->> 'aspect_ratio'));\n"
          "  end if;\n")
HUNK = ANCHOR + """  -- 0155: nor any shape the model does not list for this capability: spec.aspect_ratios_by_capability[cap] when it names
  -- some, else spec.aspect_ratios, the same list the worker checks before it calls the vendor (ModelEntry.aspects_for). An
  -- empty list is a model that makes its own shape, so any shape is refused. Refused here, before anything is held, rather
  -- than by the worker after the job was queued. Each branch casts nothing: the CASE decides the order, not an `and`.
  if p_params ? 'aspect_ratio'
     and not coalesce(case
                        when jsonb_typeof(m_spec -> 'aspect_ratios_by_capability' -> cap) = 'array'
                             and m_spec -> 'aspect_ratios_by_capability' -> cap <> '[]'::jsonb
                          then (m_spec -> 'aspect_ratios_by_capability' -> cap) @> jsonb_build_array(p_params ->> 'aspect_ratio')
                        when jsonb_typeof(m_spec -> 'aspect_ratios') = 'array'
                          then (m_spec -> 'aspect_ratios') @> jsonb_build_array(p_params ->> 'aspect_ratio')
                      end, false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer the %s shape for %s', mdl, p_params ->> 'aspect_ratio', cap));
  end if;
"""


class ShapeOfferedByModelMigration(unittest.TestCase):
    def test_it_replaces_creative_price_only(self):
        self.assertEqual(set(NEW), {"creative_price"})
        for name in ("creative_operator_preview", "operator_preview_models", "create_creative_job", "quote_creative_job",
                     "reserve_credits", "capture_credits", "release_credits", "creative_platform_reserve", "sellable_models",
                     "creative_params_problem", "api_creative_model_ok", "route_model", "sync_model_registry",
                     "model_registry_guard"):
            self.assertNotIn(f"function public.{name}(", CODE, name)
        low = CODE.lower()
        for word in ("drop table", "drop column", "drop function", "delete from", "truncate", "alter table", "create policy",
                     "create table"):
            self.assertNotIn(word, low)
        self.assertNotRegex(low, r"\b(insert\s+into|update\s+public\.|upsert)")

    def test_creative_price_is_0153s_body_plus_exactly_the_one_hunk(self):
        new, old = NEW["creative_price"], OLD["creative_price"]
        self.assertEqual(md5_of(old), CP_0153)
        self.assertEqual(new.count(HUNK), 1)
        self.assertEqual(old.count(ANCHOR), 1)
        self.assertEqual(new.replace(HUNK, ANCHOR), old, "creative_price differs from 0153's beyond the listed hunk")
        for guard in ("model_is_available(mdl)", "not public.model_past_shutdown(r.spec)", "r.verified_at is not null",
                      "public.creative_operator_preview(p_org, r.availability, r.spec)", "preview := m_avail not in ('beta', 'ga');",
                      "when m_spec -> 'pricing' -> 'variants' ->> 'by' = 'quality' and tier is not null"):
            self.assertIn(guard, new)

    def test_the_check_runs_before_anything_is_priced_and_only_when_a_shape_is_named(self):
        cp = NEW["creative_price"]
        check = cp.index("if p_params ? 'aspect_ratio'\n     and not coalesce(case")
        # after the model row was read (m_spec), before the price row, the preview rate and the quantity
        self.assertLess(cp.index("into m_found, m_unit, m_ent, m_spec, m_avail"), check)
        for later in ("select * into rate from public.credit_prices where unit = m_unit;", "vusd := case",
                      "qty := public.creative_quantity(cap, p_params);"):
            self.assertLess(check, cp.index(later), later)
        # no ELSE: a spec that states no list is NULL, and coalesce(NULL, false) refuses (never "any shape is fine")
        block = cp[check:cp.index("end if;", check)]
        self.assertNotIn("else", block)
        self.assertIn("end, false) then", block)
        self.assertEqual(cp.count("does not offer the %s shape for %s"), 1)

    def test_the_list_it_reads_is_the_workers_own(self):
        # The SQL narrows by aspect_ratios_by_capability[cap] when it names some, else aspect_ratios: ModelEntry.aspects_for, whose
        # refusal is the one the live jobs died of. Pinned on the registry entries that narrow, so the two cannot drift apart.
        for e in reg.load().values():
            for cap in e.capabilities:
                by_cap = list(e.aspect_ratios_by_capability.get(cap) or ())
                sql_reads = by_cap if by_cap else list(e.aspect_ratios)
                self.assertEqual(tuple(sql_reads), e.aspects_for(cap), (e.id, cap))
                for shape in ("16:9", "4:3", "21:9"):
                    worker_refuses = f"aspect ratio {shape} is not offered for {cap} by {e.id}" in e.problems(
                        CapabilityRequest(capability=cap, prompt="x", aspect_ratio=shape))
                    self.assertEqual(worker_refuses, shape not in sql_reads, (e.id, cap, shape))

    def test_grants(self):
        self.assertIn("revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;",
                      CODE)
        self.assertNotIn("grant ", CODE.lower())

    def test_the_drift_guard_the_end_state_and_the_rollback_carry_the_hashes_of_the_files(self):
        new_md5 = md5_of(NEW["creative_price"])
        self.assertGreaterEqual(NEW_TEXT.count(new_md5), 3, "the guard, the end state and the verify query")
        self.assertIn(f"array['{CP_0153}', '{new_md5}']", NEW_TEXT)
        self.assertIn(f"array['{new_md5}', '{CP_0153}']", ROLLBACK_TEXT)
        # 0149's body is NOT accepted: this file was written on 0153's, and applying it on 0149's would skip 0153's hunks unseen.
        self.assertNotIn("728241a09e56f65e19efc460afea7355", CODE)
        self.assertIn("0155 found a creative_price() that is neither 0153''s body nor 0155''s", NEW_TEXT)
        self.assertLess(NEW_TEXT.index("0155 needs 0153_preview_price_by_quality.sql"), NEW_TEXT.index("create or replace function"))
        self.assertLess(NEW_TEXT.index("0155 found a creative_price()"), NEW_TEXT.index("create or replace function"))
        self.assertLess(NEW_TEXT.rindex("create or replace function"), NEW_TEXT.index("The end state, asserted inside the transaction"))
        self.assertIn("set local lock_timeout = '5s';", NEW_TEXT)
        for needle in ("APPLY AS ONE TRANSACTION", "WHAT TO VERIFY BEFORE YOU APPLY", "-- Verify", "LIVE ON APPLY"):
            self.assertIn(needle, NEW_TEXT)
        lab = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
        self.assertIn(f'CREATIVE_PRICE_0155 = "{new_md5}"', lab)

    def test_the_rollback_restores_0153s_text_byte_for_byte(self):
        rb = bodies(ROLLBACK_TEXT)
        self.assertEqual(set(rb), {"creative_price"})
        self.assertEqual(rb["creative_price"], OLD["creative_price"])
        self.assertIn("rollback 0155 found a creative_price() that is neither 0155''s body nor 0153''s", ROLLBACK_TEXT)
        self.assertIn("revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;",
                      ROLLBACK_TEXT)
        self.assertNotIn("drop function", ROLLBACK_TEXT.lower())
        self.assertEqual(len(re.findall(r"(?m)^begin;$", ROLLBACK_TEXT)), 1)
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK_TEXT)), 1)

    def test_the_number_is_unique_and_the_lab_knows_it_sits_on_0153(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0155"), 1)
        self.assertIn("0153", numbers)
        lab = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
        for needle in ("def take_off_0155(", "def put_back_0155(", "ON_0153 = (MIGRATION_0155.name,)",
                       "ON_0149 = (MIGRATION_0153.name, *ON_0153)", "ON_0139 = (MIGRATION_0149.name, *ON_0149)"):
            self.assertIn(needle, lab)
        # take_off_0153 takes 0155 off first, and put_back_0153 puts it back: 0153's rollback and replay refuse 0155's body.
        off = lab[lab.index("def take_off_0153("):lab.index("def put_back_0153(")]
        self.assertLess(off.index("take_off_0155(session)"), off.index("rollback_0153_body()"))
        on = lab[lab.index("def put_back_0153("):lab.index("CREATIVE_PRICE_0155 =")]
        self.assertIn("put_back_0155(session)", on)
        # take_off_0149 and take_off_0139 must still find the chain when the live body is 0155's.
        off49 = lab[lab.index("def take_off_0149("):lab.index("def put_back_0149(")]
        self.assertIn("if has_0153(session) or has_0155(session):", off49)
        off39 = lab[lab.index("def take_off_0139("):lab.index("def put_back_0139(")]
        self.assertIn("or has_0155(session):", off39)


class EveryEntryStatesItsShapes(unittest.TestCase):
    """The registry side: 0155 reads spec.aspect_ratios as --sync copies it, so every entry that is synced states a list."""

    def test_every_synced_row_carries_the_list_the_quote_reads(self):
        r = reg.load()
        for row in reg.sync_rows(list(r.values())):
            self.assertIsInstance(row["spec"].get("aspect_ratios"), list, row["id"])
            self.assertEqual(row["spec"]["aspect_ratios"], list(r[row["id"]].aspect_ratios), row["id"])

    def test_the_ideogram_entries_that_failed_live_now_list_16_9(self):
        r = reg.load()
        for mid in ("ideogram-4", "ideogram-4.5"):
            self.assertIn("16:9", r[mid].aspects_for("t2i"), mid)


if __name__ == "__main__":
    unittest.main()
