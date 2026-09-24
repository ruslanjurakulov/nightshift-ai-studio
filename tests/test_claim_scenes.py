"""Claim <-> scene linkage: every claim knows its scene, every scene its claims.

Load-bearing:
  * ids are stable and follow the IR contract (claim c000-1 lives in scene s000);
  * a scene's claims carry the checker's verdict for that exact sentence only;
  * a sentence the checker never saw (checker crashed, or the hook A/B swapped
    the opening after the check) is "not_checked" and needs human review —
    never borrowed from another sentence, never read as accurate;
  * nothing here raises into the pipeline.
"""

import unittest

from modules import claim_scenes
from modules.claim_extractor import extract_claims, extract_section_claims
from modules.fact_checker import _make_result
from modules.script_engine import Script, ScriptSection


def _script(*narrations):
    return Script(
        topic="t", title="T", title_ab="", description="", tags=[], hook_sentence="",
        sections=[ScriptSection(name=f"S{i}", narration=n, duration_hint=10, cut_interval=5.0)
                  for i, n in enumerate(narrations)],
        thumbnail_prompt_a="", thumbnail_prompt_b="", thumbnail_overlay_text="", open_loops=[],
    )


SCRIPT = _script(
    "The Titanic sank in April 1912. [SFX: waves] Subscribe for more!",
    "Over fifteen hundred people died that night. The ship carried twenty lifeboats.",
    "Why did it happen?",
)


class ExtractionTestCase(unittest.TestCase):
    def test_ids_follow_the_scene_contract(self):
        claims = extract_section_claims(SCRIPT)
        self.assertEqual([c.claim_id for c in claims], ["c000-1", "c001-1", "c001-2"])
        self.assertEqual([c.scene_id for c in claims], ["s000", "s001", "s001"])
        self.assertEqual(claims[0].text, "The Titanic sank in April 1912.")

    def test_same_claims_as_the_flat_extractor_for_well_punctuated_scripts(self):
        self.assertEqual([c.text for c in extract_section_claims(SCRIPT)], extract_claims(SCRIPT))

    def test_a_sentence_never_straddles_two_scenes(self):
        script = _script("The ship left Southampton on a Wednesday", "It struck an iceberg four days later.")
        claims = extract_section_claims(script)
        self.assertEqual([c.section_index for c in claims], [0, 1])

    def test_odd_inputs_do_not_raise(self):
        self.assertEqual(extract_section_claims(None), [])
        self.assertEqual(extract_section_claims(""), [])
        self.assertEqual(extract_section_claims("The ship sank in the year 1912.")[0].claim_id, "c000-1")


class AnnotateTestCase(unittest.TestCase):
    def setUp(self):
        self.claims = extract_section_claims(SCRIPT)
        self.results = [
            _make_result(self.claims[0].text, "likely_accurate", "Well documented."),
            _make_result(self.claims[1].text, "likely_accurate", "About 1,500."),
            _make_result(self.claims[2].text, "likely_inaccurate", "It carried 20 — true, but see…"),
        ]

    def test_each_scene_lists_its_claims_with_status(self):
        scenes = claim_scenes.annotate_scenes(SCRIPT, self.claims, self.results)
        self.assertEqual([s["id"] for s in scenes], ["s000", "s001", "s002"])
        self.assertEqual(scenes[0]["claim_ids"], ["c000-1"])
        self.assertEqual(scenes[1]["claim_ids"], ["c001-1", "c001-2"])
        self.assertEqual(scenes[2]["claim_ids"], [])
        self.assertEqual(scenes[1]["claims"][1]["status"], "likely_inaccurate")
        self.assertTrue(scenes[1]["claims"][1]["requires_human_review"])
        self.assertFalse(scenes[0]["claims"][0]["requires_human_review"])
        # The original scene-plan fields are all still there.
        self.assertEqual(scenes[0]["name"], "S0")
        self.assertIn("narration", scenes[0])

    def test_checker_that_did_not_run_is_not_checked_never_accurate(self):
        scenes = claim_scenes.annotate_scenes(SCRIPT, self.claims, None)
        statuses = {c["status"] for s in scenes for c in s["claims"]}
        self.assertEqual(statuses, {claim_scenes.STATUS_NOT_CHECKED})
        self.assertTrue(all(c["requires_human_review"] for s in scenes for c in s["claims"]))

    def test_a_swapped_opening_is_not_credited_with_the_old_verdict(self):
        # Hook A/B "B": the opening is replaced AFTER the fact-check ran.
        swapped = _script("Nobody expected the unsinkable ship to go down.", *[s.narration for s in SCRIPT.sections[1:]])
        scenes = claim_scenes.annotate_scenes(swapped, self.claims, self.results)
        self.assertEqual(scenes[0]["claims"][0]["status"], claim_scenes.STATUS_NOT_CHECKED)
        self.assertEqual(scenes[0]["claim_ids"], ["c000-1u"])   # never collides with c000-1
        self.assertEqual(scenes[1]["claims"][0]["status"], "likely_accurate")

    def test_misaligned_results_are_never_paired(self):
        shuffled = list(reversed(self.results))
        scenes = claim_scenes.annotate_scenes(SCRIPT, self.claims, shuffled)
        # Only the middle pair happens to line up (c001-1 <-> itself).
        self.assertEqual(scenes[0]["claims"][0]["status"], claim_scenes.STATUS_NOT_CHECKED)
        self.assertEqual(scenes[1]["claims"][0]["status"], "likely_accurate")

    def test_a_broken_script_returns_the_plain_plan_or_nothing(self):
        class Broken:
            def scene_plan(self):
                raise RuntimeError("boom")
        self.assertEqual(claim_scenes.annotate_scenes(Broken(), self.claims, self.results), [])


class RecordsTestCase(unittest.TestCase):
    def test_fact_check_rows_keep_old_keys_and_gain_ids(self):
        claims = extract_section_claims(SCRIPT)
        results = [_make_result(c.text, "unverifiable", "?") for c in claims]
        rows = claim_scenes.fact_check_records(claims, results)
        self.assertEqual(rows[2]["claim_id"], "c001-2")
        self.assertEqual(rows[2]["scene_id"], "s001")
        for key in ("claim", "verdict", "reasoning", "requires_human_review"):
            self.assertIn(key, rows[0])

    def test_rows_without_matching_claims_get_no_ids(self):
        rows = claim_scenes.fact_check_records(None, [_make_result("x y z w", "unverifiable", "")])
        self.assertNotIn("claim_id", rows[0])


if __name__ == "__main__":
    unittest.main()
