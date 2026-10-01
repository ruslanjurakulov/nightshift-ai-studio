"""The timeline validators agree: modules/timeline.py (what the worker runs
before it renders) and command-center/lib/editor.ts (what the save route runs
before the database is asked) are judged on the same documents,
samples/timeline_doc_cases.json. The TypeScript half of this check is
command-center/tests/editor-timeline.test.ts.

A case that lists its "assets" is also judged on its files, the way an
export resolves them: a file of another organization is not returned at all
(exactly like a made-up id), and a file of the wrong kind for its track is
refused. The database's half of that is tests/security/test_sec_editor_audio.py."""

import json
import unittest
from pathlib import Path

from modules import timeline as tl

CASES = Path(__file__).resolve().parent.parent / "samples" / "timeline_doc_cases.json"


def resolver_for(assets: dict):
    """The case's files as the export's resolver sees them: only this
    organization's, each with its kind and a local path."""
    table = {aid: tl.ResolvedAsset(aid, kind, f"/media/{aid}", 600.0 if kind != "image" else None)
             for aid, kind in assets.items() if kind != "other_org"}
    return table.get


def verdict(case) -> list:
    problems = tl.validate(case["doc"])
    if problems or "assets" not in case:
        return problems
    try:
        tl.resolve_assets(tl.load(case["doc"]), resolver_for(case["assets"]))
    except tl.TimelineError as e:
        return e.problems
    return []


class DocCasesTestCase(unittest.TestCase):
    def test_python_validator_agrees_with_every_case(self):
        cases = json.loads(CASES.read_text(encoding="utf-8"))["cases"]
        self.assertGreater(len(cases), 40)
        for case in cases:
            with self.subTest(case["name"]):
                problems = verdict(case)
                self.assertEqual(problems == [], case["valid"], problems)

    def test_every_asset_case_says_what_the_database_answers(self):
        cases = json.loads(CASES.read_text(encoding="utf-8"))["cases"]
        for case in cases:
            if "assets" in case:
                with self.subTest(case["name"]):
                    self.assertIn(case.get("sql", "missing"), (None, "invalid_asset"))
                    # The database refuses a file exactly when it is another
                    # organization's; it never looks at which track a file is on.
                    foreign = "other_org" in case["assets"].values()
                    self.assertEqual(case["sql"] == "invalid_asset", foreign)

    def test_the_new_cases_fail_for_the_reason_their_name_gives(self):
        cases = {c["name"]: c for c in json.loads(CASES.read_text(encoding="utf-8"))["cases"]}
        needles = {
            "music gain above 12 dB": "gain_db must be a number",
            "music gain below -60 dB": "gain_db must be a number",
            "music fades longer than the music": "fade_in_s + fade_out_s is longer than the clip",
            "cross-fade longer than the next clip": "is longer than clip 'c2'",
            "cross-fade shorter than 0.2 s": "duration_s must be a number >= 0.2",
            "cross-fade longer than 2 s": "duration_s must be a number >= 0.2 and <= 2",
            "cross-fade without an overlap": "cross-fade must start 0.500 s before clip 'c1' ends",
            "cross-fade on the first clip": "a cross-fade needs a clip before it",
            "cross-fades meet inside a clip": "its cross-fades (0.600 + 0.600 s) are longer than the clip",
            "music of another organization": "is not available",
            "a video on the music track": "a A track takes audio",
            "an image on the music track": "a A track takes audio",
            "a sound on the picture track": "a V track takes video or image",
        }
        for name, needle in needles.items():
            with self.subTest(name):
                problems = verdict(cases[name])
                self.assertTrue(any(needle in p for p in problems), problems)


if __name__ == "__main__":
    unittest.main()
