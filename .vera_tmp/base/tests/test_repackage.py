"""Re-package detection: find published videos whose CTR is well below the
channel's own median. The rules under test are that it measures against the
channel baseline (not a hardcoded number), never invents a 0 for an unmeasured
video, needs enough data before flagging anything, and leaves Shorts and
too-new / too-old videos alone."""

import unittest
from datetime import datetime, timedelta, timezone

from modules import repackage as rp

NOW = datetime(2026, 9, 12, tzinfo=timezone.utc)


def _video(vid, days_old, fmt="long", title="T"):
    published = (NOW - timedelta(days=days_old)).isoformat()
    return {"video_id": vid, "title": title, "published_at": published, "video_format": fmt}


def _m(ctr, impressions, views=1000):
    return {"impression_ctr": ctr, "impressions": impressions, "views": views}


class FindCandidatesTestCase(unittest.TestCase):
    def test_flags_the_below_median_video(self):
        videos = [_video("a", 30), _video("b", 30), _video("c", 30), _video("weak", 30)]
        metrics = {
            "a": _m(0.10, 2000), "b": _m(0.10, 2000), "c": _m(0.12, 2000),
            "weak": _m(0.04, 2000),  # ~40% of the ~0.10 median → below 0.6×
        }
        out = rp.find_candidates(videos, metrics, now=NOW)
        ids = [c.video_id for c in out]
        self.assertIn("weak", ids)
        self.assertNotIn("a", ids)

    def test_unmeasured_video_is_never_a_candidate(self):
        # null ≠ 0: a video with no metrics is unknown, not a zero-CTR failure.
        videos = [_video("a", 30), _video("b", 30), _video("c", 30), _video("unknown", 30)]
        metrics = {"a": _m(0.10, 2000), "b": _m(0.10, 2000), "c": _m(0.10, 2000)}
        out = rp.find_candidates(videos, metrics, now=NOW)
        self.assertNotIn("unknown", [c.video_id for c in out])

    def test_needs_a_baseline_before_flagging(self):
        # Two measured videos is not enough to know what "normal" is.
        videos = [_video("a", 30), _video("weak", 30)]
        metrics = {"a": _m(0.10, 2000), "weak": _m(0.01, 2000)}
        self.assertEqual(rp.find_candidates(videos, metrics, now=NOW, min_baseline=3), [])

    def test_low_impressions_excluded(self):
        # Too few impressions → CTR too noisy to judge, so it neither sets the
        # baseline nor gets flagged.
        videos = [_video("a", 30), _video("b", 30), _video("c", 30), _video("tiny", 30)]
        metrics = {
            "a": _m(0.10, 2000), "b": _m(0.10, 2000), "c": _m(0.10, 2000),
            "tiny": _m(0.001, 50),
        }
        out = rp.find_candidates(videos, metrics, now=NOW)
        self.assertNotIn("tiny", [c.video_id for c in out])

    def test_too_new_and_too_old_excluded(self):
        videos = [_video("a", 30), _video("b", 30), _video("c", 30),
                  _video("fresh", 2), _video("ancient", 400)]
        metrics = {k: _m(0.02, 2000) for k in ("a", "b", "c", "fresh", "ancient")}
        # Baseline is a/b/c; fresh & ancient are out of the age window entirely.
        out_ids = [c.video_id for c in rp.find_candidates(videos, metrics, now=NOW)]
        self.assertNotIn("fresh", out_ids)
        self.assertNotIn("ancient", out_ids)

    def test_shorts_are_left_alone(self):
        videos = [_video("a", 30), _video("b", 30), _video("c", 30), _video("s", 30, fmt="short")]
        metrics = {k: _m(0.10, 2000) for k in ("a", "b", "c")}
        metrics["s"] = _m(0.001, 5000)
        self.assertNotIn("s", [c.video_id for c in rp.find_candidates(videos, metrics, now=NOW)])

    def test_worst_first_ordering(self):
        videos = [_video("a", 30), _video("b", 30), _video("c", 30),
                  _video("bad", 30), _video("worse", 30)]
        metrics = {
            "a": _m(0.10, 2000), "b": _m(0.10, 2000), "c": _m(0.10, 2000),
            "bad": _m(0.05, 2000), "worse": _m(0.02, 2000),
        }
        out = rp.find_candidates(videos, metrics, now=NOW)
        self.assertEqual([c.video_id for c in out], ["worse", "bad"])

    def test_candidate_reports_its_numbers(self):
        videos = [_video("a", 30), _video("b", 30), _video("c", 30), _video("weak", 30)]
        metrics = {"a": _m(0.10, 2000), "b": _m(0.10, 2000), "c": _m(0.10, 2000),
                   "weak": _m(0.03, 1500, views=250)}
        c = rp.find_candidates(videos, metrics, now=NOW)[0]
        self.assertEqual(c.video_id, "weak")
        self.assertEqual(c.impressions, 1500)
        self.assertEqual(c.views, 250)
        self.assertGreater(c.channel_median_ctr, 0)
        self.assertIn("median", c.reason)

    def test_empty_inputs(self):
        self.assertEqual(rp.find_candidates([], {}, now=NOW), [])
        self.assertEqual(rp.find_candidates(None, None, now=NOW), [])

    def test_summarize(self):
        videos = [_video("a", 30), _video("b", 30), _video("c", 30), _video("weak", 30)]
        metrics = {"a": _m(0.10, 2000), "b": _m(0.10, 2000), "c": _m(0.10, 2000),
                   "weak": _m(0.03, 2000)}
        out = rp.find_candidates(videos, metrics, now=NOW)
        summary = rp.summarize(out)
        self.assertEqual(summary["count"], 1)
        self.assertEqual(summary["video_ids"], ["weak"])
        self.assertEqual(summary["worst"]["video_id"], "weak")

    def test_bad_timestamp_is_skipped_not_crashed(self):
        videos = [_video("a", 30), _video("b", 30), _video("c", 30)]
        videos.append({"video_id": "bad", "title": "T", "published_at": "not-a-date",
                       "video_format": "long"})
        metrics = {k: _m(0.10, 2000) for k in ("a", "b", "c", "bad")}
        out_ids = [c.video_id for c in rp.find_candidates(videos, metrics, now=NOW)]
        self.assertNotIn("bad", out_ids)  # unparseable date → excluded, no crash


if __name__ == "__main__":
    unittest.main()
