"""main._preflight_held_thumbnail: a run stops, before it spends anything, when its
credit hold was checked for frame thumbnails and the channel now makes concept ones.

What would break without these: the runner checks the hold against the channel's
settings (modules/credits.minimum_reservation), but main.py reads them again, later,
from its own registry load. An organization administrator (migration 0158) switching
concept thumbnails on in between would have a frame-priced hold pay for up to four
generated images on the worker's keys, and the capture is capped at the hold.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import credits  # noqa: E402

ENV = credits.HELD_THUMBNAIL_MODE_ENV


def ctx(mode: str):
    return SimpleNamespace(agent=SimpleNamespace(thumbnail_mode=mode, thumbnail_concept={}))


class HeldThumbnailPreflight(unittest.TestCase):
    def setUp(self):
        import main  # noqa: PLC0415 — heavy; only this class needs it
        self.main = main

    def test_concept_switched_on_after_a_frame_hold_stops_the_run_and_records_why(self):
        with mock.patch.object(self.main.events, "emit") as emit:
            with self.assertRaises(credits.HeldTermsRefused) as stop:
                self.main._preflight_held_thumbnail(ctx("concept"), "news", env={ENV: "frame"})
        self.assertIn("nothing was spent", str(stop.exception))
        (args, kw), = emit.call_args_list
        self.assertEqual(args[0], self.main.events.AGENT_FAILED)
        self.assertEqual(kw["status"], self.main.events.STATUS_FAILED)
        self.assertEqual(kw["metadata"]["stage"], "preflight")

    def test_the_mode_the_hold_covered_runs_and_records_nothing(self):
        cases = (("concept", {ENV: "concept"}), ("frame", {ENV: "frame"}), ("frame", {ENV: "concept"}),
                 ("concept", {}))                     # no hold was checked: the operator's own runs
        for mode, env in cases:
            with self.subTest(mode=mode, env=env), mock.patch.object(self.main.events, "emit") as emit:
                self.main._preflight_held_thumbnail(ctx(mode), "news", env=env)
                emit.assert_not_called()

    def test_the_run_reads_concept_exactly_as_its_thumbnail_step_does(self):
        # " Concept " is concept to the thumbnail step (normalize_mode), so it must be to this stop too.
        with mock.patch.object(self.main.events, "emit"), self.assertRaises(credits.HeldTermsRefused):
            self.main._preflight_held_thumbnail(ctx(" Concept "), "news", env={ENV: "frame"})


if __name__ == "__main__":
    unittest.main()
