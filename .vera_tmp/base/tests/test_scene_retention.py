"""Scene-level retention (modules/scene_retention.py) and its learning proposals.

What these pin:

* the curve is mapped onto the IR's REAL scene windows by interpolation, and a
  scene the curve does not cover — before YouTube's first 1% point, a scene
  without times, a video without a duration, a curve too thin to use — reads as
  unknown (None), never 0;
* the worst scene is the one that loses viewers FASTEST, not the longest one;
* the Python and TypeScript twins agree: both run
  samples/scene_retention_cases.json;
* scene learnings are proposed only past the evidence floor (MIN_CURVES
  distinct videos per group), as PENDING retention learnings, and a missing
  Supabase / manifest / curve simply proposes nothing.
"""

import json
import unittest
from pathlib import Path
from unittest.mock import MagicMock

from modules import learning_memory as lm
from modules import scene_retention as sr
from modules.retention_analyzer import MIN_CURVES

CASES = json.loads(
    (Path(__file__).resolve().parent.parent / "samples" / "scene_retention_cases.json").read_text("utf-8")
)

LINEAR = [
    {"elapsed_ratio": r / 10, "watch_ratio": 1 - r / 20, "measured_date": "2026-09-01"}
    for r in range(0, 11)
]  # 1.0 at 0% falling to 0.5 at 100%: 0.5 of the audience per video length


class SharedCaseTests(unittest.TestCase):
    """The cases the TS twin also runs — a divergence fails on both sides."""

    def test_every_mapping_case(self):
        for case in CASES["mapping"]:
            with self.subTest(case["name"]):
                got = [r.to_dict() for r in sr.map_scenes(case["scenes"], case["points"], case["duration_s"])]
                self.assertEqual(len(got), len(case["expected"]))
                for g, e in zip(got, case["expected"]):
                    for key, want in e.items():
                        if want is None or isinstance(want, str):
                            self.assertEqual(g[key], want, f"{e['scene_id']}.{key}")
                        else:
                            self.assertIsNotNone(g[key], f"{e['scene_id']}.{key} is unknown")
                            self.assertAlmostEqual(g[key], want, places=6, msg=f"{e['scene_id']}.{key}")

    def test_every_duration_case(self):
        for case in CASES["duration"]:
            with self.subTest(case["name"]):
                self.assertEqual(sr.video_duration(case["manifest"], case["scenes"]), case["expected"])


class MappingTests(unittest.TestCase):
    def test_interpolate_refuses_to_extrapolate_either_side(self):
        curve = sr.clean_curve([{"elapsed_ratio": r, "watch_ratio": 0.5} for r in (0.1, 0.2, 0.3, 0.4, 0.5)])
        self.assertIsNone(sr.interpolate(curve, 0.05))
        self.assertIsNone(sr.interpolate(curve, 0.55))
        self.assertEqual(sr.interpolate(curve, 0.1), 0.5)
        self.assertEqual(sr.interpolate(curve, 0.5), 0.5)

    def test_last_scene_end_rounding_past_100_percent_is_still_measured(self):
        # end_s / duration can come out a hair above 1.0 in floating point.
        [row] = sr.map_scenes([{"id": "s000", "start_s": 50.0, "end_s": 100.0000001}], LINEAR, 100.0)
        self.assertAlmostEqual(row.retention_end, 0.5)

    def test_the_worst_scene_is_the_fastest_loss_not_the_longest_scene(self):
        rows = sr.map_scenes([
            {"id": "s000", "start_s": 0, "end_s": 80},    # long, steady decay
            {"id": "s001", "start_s": 80, "end_s": 100},  # short, same slope
        ], LINEAR, 100)
        self.assertGreater(rows[0].drop, rows[1].drop)
        self.assertAlmostEqual(rows[0].drop_per_min, rows[1].drop_per_min)
        # Equal rate: the larger raw drop breaks the tie, then scene order.
        self.assertEqual([r.rank for r in rows], [1, 2])

    def test_malformed_input_never_raises_and_reads_unknown(self):
        self.assertEqual(sr.map_scenes(None, None, None), [])
        rows = sr.map_scenes([{"id": "s000", "start_s": "soon", "end_s": True}, "not a scene"], LINEAR, 100)
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0].drop)
        self.assertIsNone(rows[0].rank)
        self.assertEqual(sr.clean_curve([{"elapsed_ratio": "x"}, None, 3]), [])

    def test_for_video_reads_scenes_type_and_recipe_from_the_manifest(self):
        manifest = {
            "audio": {"duration_s": 100},
            "scenes": [
                {"id": "s000", "index": 0, "type": "hook", "start_s": 0, "end_s": 20,
                 "shot": {"recipe": "slow_push"}},
                {"id": "s001", "index": 1, "type": "story", "start_s": 20, "end_s": 100, "shot": None},
            ],
        }
        rows = sr.for_video(manifest, LINEAR)
        self.assertEqual([(r.scene_id, r.type, r.recipe) for r in rows],
                         [("s000", "hook", "slow_push"), ("s001", "story", None)])
        self.assertTrue(sr.has_data(rows))
        self.assertEqual(sr.for_video(None, LINEAR), [])
        self.assertFalse(sr.has_data(sr.for_video(manifest, LINEAR[:3])))


def _scene(video, sid, rate, type_="story", recipe=None):
    return sr.SceneRetention(
        scene_id=sid, index=0, type=type_, recipe=recipe, start_s=0.0, end_s=60.0,
        retention_start=1.0, retention_end=1.0 - rate, drop=rate, drop_per_min=rate,
    )


def _channel(n_videos, parallax_rate=0.30, other_rate=0.10):
    """n videos, each with one steep "parallax" scene and two ordinary ones."""
    return [
        (f"v{i}", [
            _scene(f"v{i}", "s000", other_rate, recipe="slow_push"),
            _scene(f"v{i}", "s001", parallax_rate, recipe="parallax"),
            _scene(f"v{i}", "s002", other_rate, recipe="slow_push"),
        ])
        for i in range(n_videos)
    ]


class SceneProposalTests(unittest.TestCase):
    def test_below_the_video_floor_nothing_is_proposed(self):
        self.assertEqual(lm.scene_retention_proposals(_channel(MIN_CURVES - 1)), [])

    def test_a_recipe_that_loses_viewers_faster_is_a_pending_retention_learning(self):
        props = lm.scene_retention_proposals(_channel(MIN_CURVES), observed_on="2026-09-25")
        worse = [p for p in props if p.dedup_key == "retention:scene_recipe:worse:parallax"]
        self.assertEqual(len(worse), 1)
        p = worse[0]
        self.assertEqual(p.kind, lm.KIND_RETENTION)
        self.assertIn("parallax", p.observation)
        self.assertEqual(p.evidence["channel_median_drop_per_min"], 0.1)
        self.assertEqual(p.evidence["group_median_drop_per_min"], 0.3)
        self.assertEqual(p.evidence["scenes"], MIN_CURVES)
        self.assertEqual(p.confidence, lm.sample_confidence(MIN_CURVES))
        self.assertEqual(p.to_row("history")["status"], lm.STATUS_PENDING)
        # The group that IS every measured scene ("story") is never compared with itself.
        self.assertFalse(any("scene_type" in q.dedup_key for q in props))

    def test_a_group_seen_in_too_few_videos_is_not_judged(self):
        videos = _channel(MIN_CURVES, parallax_rate=0.10)
        videos[0][1][1] = _scene("v0", "s001", 0.9, recipe="map_zoom")
        keys = {p.dedup_key for p in lm.scene_retention_proposals(videos)}
        self.assertFalse(any("map_zoom" in k for k in keys))

    def test_no_positive_channel_loss_means_no_ratio_and_no_proposal(self):
        self.assertEqual(lm.scene_retention_proposals(_channel(5, parallax_rate=0.0, other_rate=0.0)), [])

    def test_unknown_scenes_do_not_count_as_zero_loss(self):
        videos = _channel(MIN_CURVES)
        unknown = sr.SceneRetention(scene_id="s003", index=3, type="story", recipe="slow_push",
                                    start_s=None, end_s=None, retention_start=None,
                                    retention_end=None, drop=None, drop_per_min=None)
        for _, rows in videos:
            rows.extend([unknown] * 5)
        [p] = [p for p in lm.scene_retention_proposals(videos) if "parallax" in p.dedup_key]
        self.assertEqual(p.evidence["channel_scenes"], 3 * MIN_CURVES)
        self.assertEqual(p.evidence["channel_median_drop_per_min"], 0.1)


class SceneInputTests(unittest.TestCase):
    def _manifest(self):
        return {"audio": {"duration_s": 100}, "scenes": [
            {"id": "s000", "type": "hook", "start_s": 0, "end_s": 50},
            {"id": "s001", "type": "story", "start_s": 50, "end_s": 100},
        ]}

    def test_reads_manifests_from_supabase_and_curves_from_the_local_store(self):
        sync = MagicMock(enabled=True)
        sync.select.return_value = [
            {"video_id": "v1", "manifest": self._manifest(), "video_format": "long"},
            {"video_id": "short1", "manifest": self._manifest(), "video_format": "short"},
            {"video_id": "v2", "manifest": None},
            {"video_id": "v3", "manifest": self._manifest()},  # no curve measured
        ]
        store = MagicMock()
        store.retention_curve.side_effect = lambda vid: LINEAR if vid == "v1" else []
        out = lm.scene_retention_inputs(store, "history", sync)
        self.assertEqual([v for v, _ in out], ["v1"])
        _, params = sync.select.call_args[0]
        self.assertEqual(params["channel_id"], "eq.history")
        self.assertEqual(params["manifest"], "not.is.null")

    def test_without_supabase_the_source_is_empty(self):
        self.assertEqual(lm.scene_retention_inputs(MagicMock(), "history", None), [])
        self.assertEqual(lm.scene_retention_inputs(MagicMock(), "history", MagicMock(enabled=False)), [])

    def test_a_failing_curve_read_costs_only_that_video(self):
        sync = MagicMock(enabled=True)
        sync.select.return_value = [
            {"video_id": "v1", "manifest": self._manifest()},
            {"video_id": "v2", "manifest": self._manifest()},
        ]
        store = MagicMock()
        store.retention_curve.side_effect = lambda vid: (_ for _ in ()).throw(RuntimeError("locked")) \
            if vid == "v1" else LINEAR
        self.assertEqual([v for v, _ in lm.scene_retention_inputs(store, "history", sync)], ["v2"])

    def test_gather_proposals_without_sync_is_unchanged(self):
        store = MagicMock()
        store.list_channel_topic_performance.return_value = []
        store.list_videos.return_value = []
        with unittest.mock.patch("modules.experiments.experiments_for_channel", return_value=[]):
            self.assertEqual(lm.gather_proposals(store, "history", "2026-09-25"), [])


if __name__ == "__main__":
    unittest.main()
