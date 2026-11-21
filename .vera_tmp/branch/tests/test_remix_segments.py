"""Viral Remix segment selection + scheduling (roadmap #43) — pure, offline.

The rules that keep it safe and honest: it plans ONLY for a rights-clean source
(a blocked source yields None and no clips), the strongest Shorts-sized moments
are chosen without overlap, an unmeasured segment ranks below a measured one
(null ≠ 0), and the sequence is laid out on a 12-hour cadence, strongest first."""

import unittest
from datetime import datetime, timezone

from modules import remix
from modules import remix_segments as rs


def _seg(start, end, score=None, text="x"):
    return rs.SourceSegment(start=start, end=end, text=text, score=score)


class SelectSegmentsTestCase(unittest.TestCase):
    def test_picks_strongest_non_overlapping_shorts_sized(self):
        segs = [
            _seg(0, 15, score=0.9),     # strong, fits
            _seg(10, 25, score=0.95),   # strongest, but overlaps the first
            _seg(30, 45, score=0.5),    # weaker, fits, no overlap
            _seg(50, 53, score=0.99),   # too short (<8s) → excluded
            _seg(60, 200, score=0.99),  # too long (>60s) → excluded
        ]
        chosen = rs.select_segments(segs, max_clips=2)
        spans = [(c.start, c.end) for c in chosen]
        # strongest overall (10-25) taken first, then the non-overlapping 30-45;
        # 0-15 is skipped because it overlaps 10-25.
        self.assertEqual(spans, [(10, 25), (30, 45)])

    def test_unmeasured_ranks_below_measured(self):
        segs = [_seg(0, 15, score=None), _seg(30, 45, score=0.1)]
        chosen = rs.select_segments(segs, max_clips=1)
        self.assertEqual((chosen[0].start, chosen[0].end), (30, 45))  # measured wins

    def test_zero_budget_and_nothing_fitting(self):
        self.assertEqual(rs.select_segments([_seg(0, 15, score=1)], max_clips=0), [])
        self.assertEqual(rs.select_segments([_seg(0, 3, score=1)], max_clips=3), [])  # all too short


class ScheduleClipsTestCase(unittest.TestCase):
    def test_twelve_hour_cadence_strongest_first(self):
        start = datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)
        clips = rs.schedule_clips([_seg(0, 15), _seg(30, 45), _seg(60, 75)],
                                  start_time=start, interval_hours=12)
        self.assertEqual([c.sequence for c in clips], [0, 1, 2])
        self.assertEqual(clips[0].publish_at, "2026-01-01T00:00:00+00:00")
        self.assertEqual(clips[1].publish_at, "2026-01-01T12:00:00+00:00")
        self.assertEqual(clips[2].publish_at, "2026-01-02T00:00:00+00:00")

    def test_naive_start_treated_as_utc(self):
        clips = rs.schedule_clips([_seg(0, 15)], start_time=datetime(2026, 1, 1, 6, 0))
        self.assertEqual(clips[0].publish_at, "2026-01-01T06:00:00+00:00")


class PlanShortsTestCase(unittest.TestCase):
    def _owned_source(self):
        return remix.RemixSource(source_id="v1", title="Ours", rights=remix.RIGHTS_OWNED,
                                 origin=remix.ORIGIN_OWN_CATALOG)

    def test_blocked_source_yields_no_plan(self):
        # External source with no asserted rights → remix.build_plan returns None,
        # so no clips are ever produced. The gate is upstream of selection.
        source = remix.RemixSource(source_id="x", rights=remix.RIGHTS_NONE,
                                   origin=remix.ORIGIN_EXTERNAL)
        self.assertIsNone(rs.plan_shorts(source, remix.MODE_COMMENTARY,
                                         [_seg(0, 15, score=1)], max_clips=2))

    def test_eligible_source_plans_scheduled_clips(self):
        start = datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)
        segs = [_seg(0, 15, score=0.9), _seg(30, 45, score=0.8), _seg(60, 40)]  # last invalid len
        plan = rs.plan_shorts(self._owned_source(), remix.MODE_COMPILATION, segs,
                              max_clips=3, start_time=start, interval_hours=12)
        self.assertIsNotNone(plan)
        self.assertTrue(plan.base["gate_required"])          # gate still required
        self.assertEqual(plan.clip_count, 2)                 # the two valid, ranked
        self.assertEqual(plan.interval_hours, 12)
        summary = rs.summarize(plan)
        self.assertEqual(summary["clip_count"], 2)
        self.assertEqual(summary["clips"][0]["publish_at"], "2026-01-01T00:00:00+00:00")
        self.assertEqual(summary["clips"][1]["publish_at"], "2026-01-01T12:00:00+00:00")


if __name__ == "__main__":
    unittest.main()
