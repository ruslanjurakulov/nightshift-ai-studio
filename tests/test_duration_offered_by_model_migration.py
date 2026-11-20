"""supabase/migrations/0159_duration_offered_by_model.sql — a quote refuses a clip length the model does not list.

SQL does not run in this suite (tests/security/test_sec_duration_offered_by_model.py does that, against a real Postgres). These pin what
must not change by accident: creative_price is 0156's body plus exactly the one listed hunk (undo it and the rest is 0156's text byte for
byte), the money and preview functions are not replaced, the list read is the worker's own (ModelEntry.durations_s, the refusal the jobs
died of), the drift guard, the end state and the rollback name the hashes recomputed from the files, the grants, the lab knows the chain,
and every registry entry that is sold a length states the list the database will read.
"""

import hashlib
import re
import unittest
from pathlib import Path

from modules import model_registry as reg
from modules.capabilities.base import CapabilityRequest

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
NEW_TEXT = (MIG / "0159_duration_offered_by_model.sql").read_text(encoding="utf-8")
OLD_TEXT = (MIG / "0156_named_resolution_params.sql").read_text(encoding="utf-8")
ROLLBACK_TEXT = (ROOT / "docs" / "sql" / "rollback_0159_duration_offered_by_model.sql").read_text(encoding="utf-8")
LAB = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in NEW_TEXT.splitlines())


def bodies(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"(?m)^create or replace function public\.(\w+)\(.*?^\$\$;\n", text, re.S)}


def body(fn):
    return fn[fn.index("$$") + 2: fn.rindex("$$")]


def md5_of(fn):
    return hashlib.md5(re.sub(r"\s+", " ", body(fn)).encode()).hexdigest()


NEW = bodies(NEW_TEXT)
OLD = bodies(OLD_TEXT)
CP_0156 = "a70dba23b303c72f2b9f5dc5acb3b3ec"
CP_0155 = "48105e11fbd820b6f103c19b8fd1e693"

#: The one block 0159 adds, right after 0155's shape check. Nothing else may differ from 0156's body.
ANCHOR = ("    perform public.creative_refuse('invalid_params',\n"
          "      format('%s does not offer the %s shape for %s', mdl, p_params ->> 'aspect_ratio', cap));\n"
          "  end if;\n")
HUNK = ANCHOR + """  -- 0159: nor a clip length the model does not list (spec.durations_s), the list the worker checks before it calls the vendor
  -- (ModelEntry.problems: "duration <n>s is not offered by <model>"). A spec with no list, or an empty one, refuses every length (never
  -- "any length is fine"). Only when the request names one: creative_params_problem requires it for t2v, i2v, sfx and music and refuses
  -- it on every other tool. Refused here, before anything is held, rather than by the worker after the job was queued.
  if p_params ? 'duration_s'
     and not coalesce(jsonb_typeof(m_spec -> 'durations_s') = 'array'
                      and (m_spec -> 'durations_s') @> jsonb_build_array(p_params -> 'duration_s'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer a %s-second clip for %s', mdl, p_params ->> 'duration_s', cap));
  end if;
"""


class DurationOfferedByModelMigration(unittest.TestCase):
    def test_it_replaces_creative_price_only(self):
        self.assertEqual(set(NEW), {"creative_price"})
        for name in ("creative_operator_preview", "operator_preview_models", "create_creative_job", "quote_creative_job",
                     "reserve_credits", "capture_credits", "release_credits", "creative_platform_reserve", "sellable_models",
                     "creative_params_problem", "creative_quantity", "api_creative_model_ok", "route_model", "sync_model_registry",
                     "model_registry_guard"):
            self.assertNotIn(f"function public.{name}(", CODE, name)
        low = CODE.lower()
        for word in ("drop table", "drop column", "drop function", "delete from", "truncate", "alter table", "create policy",
                     "create table"):
            self.assertNotIn(word, low)
        self.assertNotRegex(low, r"\b(insert\s+into|update\s+public\.|upsert)")

    def test_creative_price_is_0156s_body_plus_exactly_the_one_hunk(self):
        new, old = NEW["creative_price"], OLD["creative_price"]
        self.assertEqual(md5_of(old), CP_0156)
        self.assertEqual(new.count(HUNK), 1)
        self.assertEqual(old.count(ANCHOR), 1)
        self.assertEqual(new.replace(HUNK, ANCHOR), old, "creative_price differs from 0156's beyond the listed hunk")
        for guard in ("model_is_available(mdl)", "not public.model_past_shutdown(r.spec)", "r.verified_at is not null",
                      "public.creative_operator_preview(p_org, r.availability, r.spec)", "preview := m_avail not in ('beta', 'ga');",
                      "does not offer the %s shape for %s", "is not sold at %s yet: that resolution has no price of its own"):
            self.assertIn(guard, new)

    def test_the_check_runs_before_anything_is_priced_and_only_when_a_length_is_named(self):
        cp = NEW["creative_price"]
        check = cp.index("if p_params ? 'duration_s'\n     and not coalesce(")
        # after the model row was read (m_spec), before the price row, the preview rate and the quantity
        self.assertLess(cp.index("into m_found, m_unit, m_ent, m_spec, m_avail"), check)
        for later in ("select * into rate from public.credit_prices where unit = m_unit;", "vusd := case",
                      "qty := public.creative_quantity(cap, p_params);"):
            self.assertLess(check, cp.index(later), later)
        block = cp[check:cp.index("end if;", check)]
        # no default: a spec that states no list is NULL, and coalesce(NULL, false) refuses (never "any length is fine")
        self.assertIn("), false) then", block)
        self.assertNotIn("else", block)
        # the number as the request sent it (a JSON number), never its text: '[4, 6, 8]' @> '["6"]' would refuse every length
        self.assertIn("jsonb_build_array(p_params -> 'duration_s')", block)
        self.assertNotIn("p_params ->> 'duration_s')", block.split("perform")[0])
        self.assertEqual(cp.count("does not offer a %s-second clip for %s"), 1)

    def test_the_list_it_reads_is_the_workers_own(self):
        # The SQL refuses a length not in spec.durations_s: ModelEntry.problems' rule, whose refusal is the one a mis-sold job dies of.
        for e in reg.load().values():
            for cap in e.capabilities:
                for n in (1, 4, 5, 6, 8, 10, 15, 60):
                    worker_refuses = f"duration {n}s is not offered by {e.id}" in e.problems(
                        CapabilityRequest(capability=cap, prompt="x", duration_s=n))
                    self.assertEqual(worker_refuses, n not in e.durations_s, (e.id, cap, n))

    def test_it_refuses_to_apply_while_an_offered_clip_model_states_no_lengths(self):
        # Applied on a stale sync it would take every such model off sale silently; it names them and the fix instead.
        guard = NEW_TEXT.index("0159: these offered models state no durations_s")
        self.assertLess(guard, NEW_TEXT.index("create or replace function"))
        block = NEW_TEXT[NEW_TEXT.rindex("do $$", 0, guard):guard]
        for needle in ("array['t2v', 'i2v', 'sfx', 'music']", "r.availability in ('beta', 'ga')", "'operator_preview'",
                       "jsonb_typeof(r.spec -> 'durations_s') is distinct from 'array'"):
            self.assertIn(needle, block)
        self.assertIn("Probe models with --sync first", NEW_TEXT)

    def test_grants(self):
        self.assertIn("revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;",
                      CODE)
        self.assertNotIn("grant ", CODE.lower())

    def test_the_drift_guard_the_end_state_the_rollback_and_the_lab_carry_the_hashes_of_the_files(self):
        new_md5 = md5_of(NEW["creative_price"])
        self.assertGreaterEqual(NEW_TEXT.count(new_md5), 3, "the guard, the end state and the verify query")
        self.assertIn(f"array['{CP_0156}', '{new_md5}']", NEW_TEXT)
        self.assertIn(f"array['{new_md5}', '{CP_0156}']", ROLLBACK_TEXT)
        # 0155's body is NOT accepted: this file was written on 0156's, and applying it on 0155's would skip 0156's hunk unseen.
        self.assertNotIn(CP_0155, CODE)
        self.assertIn("0159 found a creative_price() that is neither 0156''s body nor 0159''s", NEW_TEXT)
        first = NEW_TEXT.index("create or replace function")
        self.assertLess(NEW_TEXT.index("0159 needs 0156_named_resolution_params.sql"), first)
        self.assertLess(NEW_TEXT.index("0159 found a creative_price()"), first)
        self.assertLess(NEW_TEXT.rindex("create or replace function"), NEW_TEXT.index("The end state, asserted inside the transaction"))
        self.assertIn("set local lock_timeout = '5s';", NEW_TEXT)
        for needle in ("APPLY AS ONE TRANSACTION", "WHAT TO VERIFY BEFORE YOU APPLY", "-- Verify", "LIVE ON APPLY"):
            self.assertIn(needle, NEW_TEXT)
        self.assertIn(f'CREATIVE_PRICE_0159 = "{new_md5}"', LAB)

    def test_the_rollback_restores_0156s_text_byte_for_byte(self):
        rb = bodies(ROLLBACK_TEXT)
        self.assertEqual(set(rb), {"creative_price"})
        self.assertEqual(rb["creative_price"], OLD["creative_price"])
        self.assertIn("rollback 0159 found a creative_price() that is neither 0159''s body nor 0156''s", ROLLBACK_TEXT)
        self.assertIn("revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;",
                      ROLLBACK_TEXT)
        self.assertNotIn("drop function", ROLLBACK_TEXT.lower())
        self.assertEqual(len(re.findall(r"(?m)^begin;$", ROLLBACK_TEXT)), 1)
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK_TEXT)), 1)

    def test_the_number_is_unique_and_the_lab_knows_it_sits_on_0156(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0159"), 1)
        self.assertIn("0156", numbers)
        # 0176 (voice to video) sits on 0159's creative_price, so it goes wherever 0159 goes (after it).
        for needle in ("def take_off_0159(", "def put_back_0159(", "ON_0156 = (MIGRATION_0159.name, MIGRATION_0176.name)",
                       "ON_0155 = (MIGRATION_0156.name, *ON_0156)", "ON_0153 = (MIGRATION_0155.name, *ON_0155)"):
            self.assertIn(needle, LAB)
        # take_off_0156 takes 0159 off first, and put_back_0156 puts it back: 0156's rollback and replay refuse 0159's body.
        off = LAB[LAB.index("def take_off_0156("):LAB.index("def put_back_0156(")]
        self.assertLess(off.index("take_off_0159(session)"), off.index("rollback_0156_body()"))
        on = LAB[LAB.index("def put_back_0156("):LAB.index("CREATIVE_PRICE_0159 =")]
        self.assertIn("put_back_0159(session)", on)
        # The chain is still found from 0159's body (each has_* compares its own hash only).
        for fn, needle in (("take_off_0155", "if has_0156(session) or has_0159(session)"),
                           ("take_off_0153", "or has_0156(session) or has_0159(session)"),
                           ("take_off_0149", "or has_0156(session) or has_0159(session)"),
                           ("take_off_0139", "or has_0156(session) or has_0159(session)")):
            nxt = {"take_off_0155": "def put_back_0155(", "take_off_0153": "def put_back_0153(", "take_off_0149": "def put_back_0149(",
                   "take_off_0139": "def put_back_0139("}[fn]
            self.assertIn(needle, LAB[LAB.index(f"def {fn}("):LAB.index(nxt)], fn)

    def test_the_docs_describe_it(self):
        docs = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
        self.assertIn("## A quote refuses a clip length the model does not list (0159)", docs)
        self.assertIn("rollback_0159_duration_offered_by_model.sql", docs)


class EveryEntryStatesItsLengths(unittest.TestCase):
    """The registry side: 0159 reads spec.durations_s as --sync copies it, so every entry that is synced states a list."""

    def test_every_synced_row_carries_the_list_the_quote_reads(self):
        r = reg.load()
        for row in reg.sync_rows(list(r.values())):
            self.assertIsInstance(row["spec"].get("durations_s"), list, row["id"])
            self.assertEqual(row["spec"]["durations_s"], list(r[row["id"]].durations_s), row["id"])

    def test_the_clip_models_the_studio_offered_5_and_10_to_do_not_all_list_them(self):
        # The evidence the Studio change rests on: a fixed 5 / 10 seconds was refused by these models' own lists.
        r = reg.load()
        self.assertNotIn(5, r["veo-3.1"].durations_s)
        self.assertNotIn(10, r["veo-3.1"].durations_s)
        self.assertNotIn(5, r["ltx-2.5-pro"].durations_s)


if __name__ == "__main__":
    unittest.main()
