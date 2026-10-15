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

    def test_the_grade_cases_fail_for_the_reason_their_name_gives(self):
        cases = {c["name"]: c for c in json.loads(CASES.read_text(encoding="utf-8"))["cases"]}
        needles = {
            "grade brightness above 1": "grade: brightness must be a number >= -1 and <= 1",
            "grade brightness below -1": "grade: brightness must be a number >= -1 and <= 1",
            "grade contrast above 2": "grade: contrast must be a number >= 0 and <= 2",
            "grade contrast below 0": "grade: contrast must be a number >= 0 and <= 2",
            "grade saturation above 3": "grade: saturation must be a number >= 0 and <= 3",
            "grade saturation below 0": "grade: saturation must be a number >= 0 and <= 3",
            "grade value as text": "grade: brightness must be a number",
            "grade value as boolean": "grade: contrast must be a number",
            "grade value null": "grade: saturation must be a number",
            "grade without saturation": "grade: saturation is missing",
            "grade with a hue field": "grade: hue is not a known field",
            "grade that is not an object": "grade must be an object",
            "grade that is null": "grade must be an object",
            "grade on a music clip": "grade is not a known field",
        }
        for name, needle in needles.items():
            with self.subTest(name):
                problems = verdict(cases[name])
                self.assertTrue(any(needle in p for p in problems), problems)
        for name in ("grade on a clip", "grade at the ends of every range",
                     "grade at the other ends of every range", "neutral grade"):
            with self.subTest(name):
                self.assertEqual(verdict(cases[name]), [])

    def test_the_overlay_cases_fail_for_the_reason_their_name_gives(self):
        cases = {c["name"]: c for c in json.loads(CASES.read_text(encoding="utf-8"))["cases"]}
        needles = {
            "overlays that is not a list": "overlays must be a list",
            "overlays that is null": "overlays must be a list",
            "seventeen overlays": "overlays: at most 16",
            "overlay that is not an object": "must be an object",
            "overlay with a path field": "path is not a known field",
            "overlay with a rotation field": "rotation is not a known field",
            "overlay without an asset": "asset_id is missing",
            "overlay asset that is not a uuid": "asset_id must be a uuid",
            "overlay without an end": "end_s is missing",
            "overlay ending before it starts": "end_s (1) must be greater than start_s (4)",
            "overlay of zero length": "must be greater than start_s",
            "overlay shorter than one frame": "shorter than one frame",
            "overlay starting below zero": "start_s must be a number",
            "overlay time as text": "start_s must be a number",
            "overlay x below 0": "x must be a number >= 0 and <= 1",
            "overlay x above 1": "x must be a number >= 0 and <= 1",
            "overlay y below 0": "y must be a number >= 0 and <= 1",
            "overlay y above 1": "y must be a number >= 0 and <= 1",
            "overlay width below 0.05": "w must be a number >= 0.05 and <= 1",
            "overlay width above 1": "w must be a number >= 0.05 and <= 1",
            "overlay width zero": "w must be a number >= 0.05 and <= 1",
            "overlay opacity below 0": "opacity must be a number >= 0 and <= 1",
            "overlay opacity above 1": "opacity must be a number >= 0 and <= 1",
            "overlay x as text": "x must be a number",
            "overlay width as boolean": "w must be a number",
            "overlay opacity null": "opacity must be a number",
            "overlay with a bad id": "id must be 1-64 letters",
            "overlay id used by a clip": "id 'c1' is already used",
            "two overlays with one id": "id 'o1' is already used",
            "overlay of another organization": "is not available",
            "a sound as an overlay": "an overlay takes video or image",
            "five video overlays": "at most 4 video overlays",
        }
        for name, needle in needles.items():
            with self.subTest(name):
                problems = verdict(cases[name])
                self.assertTrue(any(needle in p for p in problems), problems)
        for name in ("overlay picture with every field", "overlay with only the required fields",
                     "overlay at the low ends of every range", "overlay at the high ends of every range",
                     "overlays that share time and a file", "an empty overlays list",
                     "overlay running past the end of the picture", "overlay video",
                     "sixteen overlays", "overlays on a document with captions", "four video overlays"):
            with self.subTest(name):
                self.assertEqual(verdict(cases[name]), [])

    def test_the_transition_style_cases_fail_for_the_reason_their_name_gives(self):
        cases = {c["name"]: c for c in json.loads(CASES.read_text(encoding="utf-8"))["cases"]}
        needles = {
            "cross-fade with an unknown style": "style must be one of",
            "cross-fade with xfade's custom style": "style must be one of",
            "cross-fade style in capitals": "style must be one of",
            "cross-fade style with a trailing newline": "style must be one of",
            "cross-fade style with an expression": "style must be one of",
            "cross-fade style as a number": "style must be one of",
            "cross-fade style null": "style must be one of",
            "cross-fade style as a list": "style must be one of",
            "cross-fade style empty": "style must be one of",
            "style on a dip to black": "a style is only for a crossfade",
            "style on a cut": "a style is only for a crossfade",
            "transition with a direction field": "direction is not a known field",
            "styled cross-fade on the first clip": "a cross-fade needs a clip before it",
        }
        for name, needle in needles.items():
            with self.subTest(name):
                problems = verdict(cases[name])
                self.assertTrue(any(needle in p for p in problems), problems)
        for name in ("cross-fade with every style", "cross-fade with the plain fade style written out",
                     "cross-fade with a dissolve style", "cross-fade with a circle style at the shortest length",
                     "cross-fade with a slide style at the longest length"):
            with self.subTest(name):
                self.assertEqual(verdict(cases[name]), [])

    def test_the_text_look_cases_fail_for_the_reason_their_name_gives(self):
        cases = {c["name"]: c for c in json.loads(CASES.read_text(encoding="utf-8"))["cases"]}
        needles = {
            "shadow below 0": "shadow must be a number >= 0 and <= 20",
            "shadow above 20": "shadow must be a number >= 0 and <= 20",
            "shadow as text": "shadow must be a number",
            "shadow as boolean": "shadow must be a number",
            "shadow null": "shadow must be a number",
            "box colour that is not a colour": "box_color must be a #RRGGBB colour",
            "box colour with three digits": "box_color must be a #RRGGBB colour",
            "box colour with a trailing newline": "box_color must be a #RRGGBB colour",
            "box colour as a number": "box_color must be a #RRGGBB colour",
            "box opacity above 1": "box_opacity must be a number >= 0 and <= 1",
            "box opacity below 0": "box_opacity must be a number >= 0 and <= 1",
            "box opacity as text": "box_opacity must be a number",
            "box opacity without a box colour": "box_opacity needs a box_color",
            "text with a rotation field": "rotation is not a known field",
            "shadow on the captions style": "shadow is not a known field",
            "box on the captions style": "box_color is not a known field",
        }
        for name, needle in needles.items():
            with self.subTest(name):
                problems = verdict(cases[name])
                self.assertTrue(any(needle in p for p in problems), problems)
        for name in ("text with a shadow", "text with the largest shadow", "text with a zero shadow",
                     "text with a box", "text with a box at an opacity", "text with a clear box",
                     "text with a solid box", "text with a box and a shadow and an outline",
                     "text with every look at the other ends"):
            with self.subTest(name):
                self.assertEqual(verdict(cases[name]), [])

    def test_the_shape_cases_fail_for_the_reason_their_name_gives(self):
        cases = {c["name"]: c for c in json.loads(CASES.read_text(encoding="utf-8"))["cases"]}
        new_msg = "text can only use Latin and Cyrillic letters, digits and common punctuation"
        needles = {
            "shapes that is not a list": "shapes must be a list",
            "shapes that is null": "shapes must be a list",
            "thirteen shapes": "shapes: at most 12",
            "shape that is not an object": "must be an object",
            "shape of an unknown kind": "kind must be one of",
            "shape without a kind": "kind is missing",
            "shape kind as a number": "kind must be one of",
            "shape kind with a trailing newline": "kind must be one of",
            "shape kind in capitals": "kind must be one of",
            "shape with a path field": "path is not a known field",
            "shape with an asset id": "asset_id is not a known field",
            "shape with a chroma field": "chroma is not a known field",
            "shape ending before it starts": "end_s (1) must be greater than start_s (4)",
            "shape of zero length": "must be greater than start_s",
            "shape shorter than one frame": "shorter than one frame",
            "shape starting below zero": "start_s must be a number",
            "shape time as text": "start_s must be a number",
            "shape x below 0": "x must be a number >= 0 and <= 1",
            "shape x above 1": "x must be a number >= 0 and <= 1",
            "shape y below 0": "y must be a number >= 0 and <= 1",
            "shape y above 1": "y must be a number >= 0 and <= 1",
            "shape width below 0.05": "w must be a number >= 0.05 and <= 1",
            "shape width above 1": "w must be a number >= 0.05 and <= 1",
            "shape opacity below 0": "opacity must be a number >= 0 and <= 1",
            "shape opacity above 1": "opacity must be a number >= 0 and <= 1",
            "shape x as boolean": "x must be a number",
            "shape colour that is not a colour": "color must be a #RRGGBB colour",
            "shape colour with three digits": "color must be a #RRGGBB colour",
            "shape colour with a trailing newline": "color must be a #RRGGBB colour",
            "shape colour as a number": "color must be a #RRGGBB colour",
            "shape outline above 0.5": "outline must be a number >= 0 and <= 0.5",
            "shape outline below 0": "outline must be a number >= 0 and <= 0.5",
            "shape outline as text": "outline must be a number",
            "shape aspect below 0.2": "aspect must be a number >= 0.2 and <= 5",
            "shape aspect above 5": "aspect must be a number >= 0.2 and <= 5",
            "aspect on a circle": "aspect does not apply to a circle",
            "outline on an arrow": "outline does not apply to a arrow",
            "outline on a line": "outline does not apply to a line",
            "arrow direction that is unknown": "dir must be one of",
            "direction on a circle": "dir does not apply to a circle",
            "thickness below the least": "thick must be a number >= 0.002 and <= 0.05",
            "thickness above the most": "thick must be a number >= 0.002 and <= 0.05",
            "thickness on a rectangle": "thick does not apply to a rect",
            "progress edge that is unknown": "edge must be one of",
            "edge on an arrow": "edge does not apply to a arrow",
            "text on a circle": "text does not apply to a circle",
            "pill without text": "text is missing",
            "pill with empty text": "text must be non-empty text of at most 24 characters",
            "pill with blank text": "text must be non-empty text of at most 24 characters",
            "pill text of 25 characters": "text must be non-empty text of at most 24 characters",
            "pill text of 25 emoji": "text must be non-empty text of at most 24 characters",
            "pill text of 24 emoji": new_msg,
            "pill text with an emoji": new_msg,
            "pill text in Japanese": new_msg,
            "pill text in Arabic": new_msg,
            "pill text in Greek": new_msg,
            "pill text with a Hangul filler": new_msg,
            "pill text with a soft hyphen": new_msg,
            "pill text with a no-break space": new_msg,
            "pill text with an arrow": new_msg,
            "pill text with a combining accent": new_msg,
            "shapes too big for the export's memory at 1440p": "(memory)",
            "shapes with four full pictures too big for the memory at 1440p": "to render with the picture overlays",
            "shapes with eight full pictures too big for the memory at 1440p": "to render with the picture overlays",
            "shapes with four full pictures too big for the memory in portrait 1440p": "to render with the picture overlays",
            "shapes too big for the export's memory in 4K": "(memory)",
            "too many small shapes in 4K": "(memory)",
            "shapes that take too long to render on a long timeline": "(render time)",
            "pill text with a line break": "text can only use Latin and Cyrillic letters, digits and common punctuation",
            "pill text with a control character": "text can only use Latin and Cyrillic letters, digits and common punctuation",
            "pill text with a zero-width joiner": "text can only use Latin and Cyrillic letters, digits and common punctuation",
            "pill text with a line separator": "text can only use Latin and Cyrillic letters, digits and common punctuation",
            "pill text as a number": "text must be non-empty text",
            "progress bar with a position": "x does not apply to a progress",
            "progress bar with a width": "w does not apply to a progress",
            "progress bar with a move": "move does not apply to a progress",
            "progress bar with a slide entrance": "a progress bar takes only ['fade'] as anim_in",
            "progress bar with a pop exit": "a progress bar takes only ['fade'] as anim_out",
            "shape with a typewriter entrance": "anim_in must be one of",
            "shape animation length without its animation": "anim_in_s needs anim_in",
            "shape animation shorter than the least": "anim_in_s must be a number >= 0.1 and <= 2",
            "shape animations longer than the span": "the animations (2.5 s) are longer than the item is shown",
            "shape move to an opacity": "opacity is not a known field",
            "shape move to nothing": "give at least one of ['x', 'y', 'w']",
            "shape move to x above 1": "x must be a number >= 0 and <= 1",
            "shape move to a width below 0.05": "w must be a number >= 0.05 and <= 1",
            "shape move without a target": "to is missing",
            "shape move that is not an object": "move must be an object",
            "shape id used by a clip": "id 'c1' is already used",
            "two shapes with one id": "id 's1' is already used",
            "shape with a bad id": "id must be 1-64 letters",
            "overlays and shapes past the layer limit": "overlays and shapes together: at most 16 (got 17)",
            "shape id used by an overlay": "id 'o1' is already used",
        }
        for name, needle in needles.items():
            with self.subTest(name):
                problems = verdict(cases[name])
                self.assertTrue(any(needle in p for p in problems), problems)
        valid = [n for n, c in cases.items() if c["valid"] and n.startswith(("shape", "pill text", "twelve shapes", "an empty shapes", "the same shapes", "a few small shapes", "many small shapes", "a full-width line"))]
        self.assertGreater(len(valid), 20)
        for name in valid:
            with self.subTest(name):
                self.assertEqual(verdict(cases[name]), [])

    def test_the_ducking_cases_fail_for_the_reason_their_name_gives(self):
        cases = {c["name"]: c for c in json.loads(CASES.read_text(encoding="utf-8"))["cases"]}
        needles = {
            "duck amount below 1 dB": "duck: amount_db must be a number >= 1 and <= 40",
            "duck amount above 40 dB": "duck: amount_db must be a number >= 1 and <= 40",
            "duck attack below 0.05 s": "duck: attack_s must be a number >= 0.05 and <= 2",
            "duck release above 5 s": "duck: release_s must be a number >= 0.1 and <= 5",
            "duck without an amount": "duck: amount_db is missing",
            "duck with a compressor field": "duck: ratio is not a known field",
            "duck that is not an object": "duck must be an object",
            "duck on a speech track": "a speech track cannot be lowered under speech",
            "a role that is not music or speech": "role must be one of ['music', 'speech']",
            "duck on the picture track": "duck is not a known field",
            "role on a text track": "role is not a known field",
        }
        for name, needle in needles.items():
            with self.subTest(name):
                problems = verdict(cases[name])
                self.assertTrue(any(needle in p for p in problems), problems)


if __name__ == "__main__":
    unittest.main()
