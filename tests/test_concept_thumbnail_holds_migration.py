"""supabase/migrations/0163_concept_thumbnail_holds.sql — the database prices a concept-thumbnail channel's run with
its generated images, as the worker's floor demands (modules/credits.minimum_reservation).

The behaviour is attacked for real in tests/security/test_sec_concept_thumbnail_holds.py and the "0163" tests of
test_sec_series_tables.py / test_sec_mcp_oauth.py (Postgres 16, CI job `rls`). These pin the text, so a later edit
cannot quietly break what the lab happens not to exercise:

* the three replaced bodies are 0120's / 0094's with ONLY the price changed: anything else would be a silent rewrite
  of a money function riding along;
* the rollback puts 0120's and 0094's bodies back byte for byte;
* the md5 values in the migration's drift guard, its end-state check, the rollback and the lab helper are one set;
* the image ceiling is the worker's and the Command Center's.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import credits  # noqa: E402

MIGRATIONS = ROOT / "supabase" / "migrations"
SQL = (MIGRATIONS / "0163_concept_thumbnail_holds.sql").read_text()
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0163_concept_thumbnail_holds.sql").read_text()
SEC_DB = (ROOT / "tests" / "security" / "sec_db.py").read_text()
S0120 = (MIGRATIONS / "0120_series_tables.sql").read_text()
S0094 = (MIGRATIONS / "0094_extra_credits_toggle.sql").read_text()

REPLACED = (("quote_series_episode", S0120), ("start_series_episode", S0120), ("oauth_create_video", S0094))


def fn(text: str, name: str) -> str:
    m = re.search(rf"^create or replace function public\.{name}\(.*?^\$\$;\n", text, re.S | re.M)
    assert m, name
    return m.group(0)


def changed_lines(before: str, after: str) -> tuple:
    import difflib

    diff = list(difflib.unified_diff(before.splitlines(), after.splitlines(), lineterm="", n=0))
    removed = [ln[1:] for ln in diff if ln.startswith("-") and not ln.startswith("---")]
    added = [ln[1:] for ln in diff if ln.startswith("+") and not ln.startswith("+++")]
    return removed, added


class ReplacedBodies(unittest.TestCase):
    def test_quote_changes_only_its_price_call(self):
        removed, added = changed_lines(fn(S0120, "quote_series_episode"), fn(SQL, "quote_series_episode"))
        self.assertEqual(removed, ["  v_price := case when v_ex then null else public.series_episode_price(ep.duration_s) end;"])
        self.assertIn("    (select p.channel_id from public.series_plans p where p.id = ep.plan_id)) end;", added)
        self.assertEqual(len(added), 3)

    def test_start_changes_only_its_price_call(self):
        removed, added = changed_lines(fn(S0120, "start_series_episode"), fn(SQL, "start_series_episode"))
        self.assertEqual(removed, ["    v_price := public.series_episode_price(ep.duration_s);"])
        self.assertEqual(added[-1], "    v_price := public.series_episode_price(ep.duration_s, pl.channel_id);")
        self.assertEqual(len(added), 2)

    def test_oauth_create_video_only_adds_the_image_price(self):
        removed, added = changed_lines(fn(S0094, "oauth_create_video"), fn(SQL, "oauth_create_video"))
        self.assertEqual(removed, [])
        code = [ln.strip() for ln in added if not ln.strip().startswith("--")]
        self.assertEqual(code, [
            "v_img   numeric;",
            "v_img := public.concept_thumbnail_credits(ch.channel_id);",
            "if v_img is null then",
            "return public.api_finish(ctx, public.api_err(503, 'pricing_unavailable',",
            "'This channel makes concept thumbnails, and generated images have no price on this deployment; nothing was held or charged.'));",
            "end if;",
            "if v_img > 0 then",
            "v_price := public.credits_round_up(v_price + v_img);",
            "end if;",
        ])

    def test_the_one_argument_episode_price_is_not_touched(self):
        self.assertNotIn("function public.series_episode_price(p_duration_s integer) returns", SQL)

    def test_the_rollback_restores_the_bodies_byte_for_byte(self):
        for name, source in REPLACED:
            with self.subTest(name=name):
                self.assertEqual(fn(ROLLBACK, name), fn(source, name))
        self.assertIn("drop function if exists public.series_episode_price(integer, text);", ROLLBACK)
        self.assertIn("drop function if exists public.concept_thumbnail_credits(text);", ROLLBACK)


class Hashes(unittest.TestCase):
    def hashes(self, text: str) -> set:
        return set(re.findall(r"\b[0-9a-f]{32}\b", text))

    def test_the_guard_the_end_state_the_rollback_and_the_lab_agree(self):
        before = set(re.findall(r'"([0-9a-f]{32})"', SEC_DB.split("_BEFORE_0163 = ", 1)[1].split("}", 1)[0]))
        self.assertEqual(len(before), 3)
        mig = self.hashes(SQL)
        self.assertTrue(before <= mig, "the lab's BEFORE hashes are the migration's")
        after = mig - before
        self.assertEqual(len(after), 5, "three replaced bodies and two new functions")
        self.assertTrue(self.hashes(ROLLBACK) <= after, "the rollback refuses anything but 0163's bodies")


class Contract(unittest.TestCase):
    def test_the_image_ceiling_is_the_workers(self):
        self.assertIn(f"* {credits.CONCEPT_THUMBNAIL_MAX_IMAGES};", fn(SQL, "concept_thumbnail_credits"))
        self.assertIn(f"'{credits.UNIT_IMAGE_GENERATIONS}'", fn(SQL, "concept_thumbnail_credits"))

    def test_the_helpers_are_internal_and_the_callers_keep_their_grants(self):
        self.assertIn("revoke all on function public.concept_thumbnail_credits(text) from public, anon, authenticated, service_role;", SQL)
        self.assertIn("revoke all on function public.series_episode_price(integer, text) from public, anon, authenticated, service_role;", SQL)
        self.assertNotRegex(SQL, r"grant execute on function public\.(concept_thumbnail_credits|series_episode_price)")
        for grant in ("grant execute on function public.quote_series_episode(uuid) to authenticated;",
                      "grant execute on function public.start_series_episode(uuid, numeric, text, boolean) to authenticated;",
                      "grant execute on function public.oauth_create_video(text, text, jsonb, text, text) to anon;"):
            self.assertIn(grant, SQL)
            self.assertIn(grant, ROLLBACK)

    def test_every_function_is_a_definer_with_a_pinned_search_path(self):
        for name in ("concept_thumbnail_credits", "series_episode_price(p_duration_s integer, p_channel_id"):
            m = re.search(rf"create or replace function public\.{re.escape(name)}.*?\$\$", SQL, re.S)
            self.assertIsNotNone(m, name)
            self.assertIn("security definer set search_path = public, pg_temp", m.group(0))


if __name__ == "__main__":
    unittest.main()
