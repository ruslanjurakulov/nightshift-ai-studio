"""Exports up to 1080p sold by the started minute (migration 0136), the worker's half.

The database holds and settles the money (0136 / 0132's trigger capture the row's quote); the worker never computes or sends an amount. What
this pins: while the 1080p price is NULL the rows carry no quote and nothing changes (a speed curve and any length render as before); once a
row up to 1080p carries a quote (a frame of the list, or none for the project's own frame) it gets the same two refusals as a paid frame
above (more minutes than priced: hires_length_mismatch; a speed curve is priced at its rendered length, migration 0136), and keeps the
free exports' budget and caps.
"""

from __future__ import annotations

import unittest

from modules import editor_export
from tests.test_editor_hires_export import EXPORT, ORG, PROJECT, STORED, Base, doc, framed


def own(d, *, quoted=None, duration_s=4):
    """A row of the project's own frame (no frame columns), with or without the database's quote."""
    return {"id": EXPORT, "org_id": ORG, "project_id": PROJECT, "rev": 3, "duration_s": duration_s, "doc": d, "status": "rendering",
            "quoted_credits": quoted}


def curved(length=4.0):
    d = doc(length)
    d["tracks"][0]["clips"][0]["speed_curve"] = [{"at": 0, "speed": 0.5}, {"at": 1, "speed": 0.5}]
    return d


class WhileThePriceIsNull(Base):
    def test_an_unpriced_row_renders_as_before_curve_and_length_included(self):
        for row in (own(doc(4.0)), own(curved(4.0), duration_s=4), own(doc(61.0), duration_s=4),
                    framed("square_1080", curved(4.0), quoted=None, duration_s=4)):
            status, store, render, _ = self.run_export(row, hires=False)
            self.assertEqual((status, store.finished), ("done", [(STORED, None)]), row)
            render.assert_called_once()


class OnceThePriceIsSet(Base):
    def test_a_priced_row_up_to_1080p_renders_with_the_free_budget_and_without_the_hires_switch(self):
        for row in (own(doc(60.0), quoted=1, duration_s=60), framed("square_1080", doc(60.0), quoted=1, duration_s=60),
                    framed("vertical_1080p", doc(60.0), quoted=1, duration_s=60)):
            status, store, render, _ = self.run_export(row, hires=False)
            self.assertEqual((status, store.finished), ("done", [(STORED, None)]), row)
            self.assertEqual(render.call_args.kwargs["timeout_s"], editor_export.render_timeout_s(60.0))

    def test_a_priced_row_with_a_speed_curve_renders_at_its_priced_length_and_not_past_it(self):
        for row in (own(curved(4.0), quoted=1, duration_s=8), framed("square_1080", curved(4.0), quoted=1, duration_s=8)):
            status, _, _, _ = self.run_export(row, hires=False)
            self.assertEqual(status, "done", row)
        # 40 s of source at half speed is 80 s (2 minutes); priced as 40 s (1 minute) it is refused.
        self.assert_refused(own(curved(40.0), quoted=1, duration_s=40), "hires_length_mismatch", hires=False)

    def test_a_priced_row_that_starts_more_minutes_than_priced_is_refused(self):
        self.assert_refused(own(doc(61.0), quoted=1, duration_s=60), "hires_length_mismatch", hires=False)
        self.assert_refused(framed("youtube_720p", doc(121.0), quoted=2, duration_s=120), "hires_length_mismatch", hires=False)
        status, _, _, _ = self.run_export(own(doc(61.0), quoted=2, duration_s=61), hires=False)
        self.assertEqual(status, "done")


if __name__ == "__main__":
    unittest.main()
