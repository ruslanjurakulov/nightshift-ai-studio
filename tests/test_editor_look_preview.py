"""The editor preview's look curves are the export's (the other half of
command-center/tests/editor-fx-preview.test.ts).

The preview draws a named look (vintage, cinematic, cool, warm, high-contrast,
sepia) with an SVG filter built from the same control points the export gives
ffmpeg ``curves`` / ``colorchannelmixer``. The points live in
``samples/clip_look_curves.json``; this test pins the export's table to that
file and the TypeScript test pins the preview's table to it, so neither side can
change a look without the other noticing. It compares numbers, not pixels: a
browser's filter and ffmpeg's cubic spline are two renderers.
"""

import json
import unittest
from pathlib import Path

from modules import render_backend
from modules import timeline as tl

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "samples" / "clip_look_curves.json"


class LookCurvesMatchThePreview(unittest.TestCase):
    def setUp(self):
        self.fixture = json.loads(FIXTURE.read_text())

    def test_the_export_curves_are_the_fixtures(self):
        got = {k: {ch: [list(p) for p in pts] for ch, pts in v.items()}
               for k, v in render_backend._FILTER_CURVES.items()}
        self.assertEqual(got, self.fixture["curves"])

    def test_the_sepia_matrix_is_the_fixtures(self):
        self.assertEqual([list(r) for r in render_backend._SEPIA], self.fixture["sepia"])

    def test_every_named_look_but_mono_and_sepia_has_curves(self):
        names = set(self.fixture["curves"]) | {"mono", "sepia"}
        self.assertEqual(names, set(tl.FILTERS))


if __name__ == "__main__":
    unittest.main()
