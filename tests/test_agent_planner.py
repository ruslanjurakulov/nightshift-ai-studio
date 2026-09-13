"""Tests for modules.agent_planner — the daily autopilot planning layer."""

import unittest
from dataclasses import dataclass
from typing import Optional

from modules import agent_planner as ap


@dataclass
class _Opp:
    topic: str
    score: float
    source: str
    rationale: str


class _Recommender:
    def __init__(self, opps):
        self._opps = opps
    def suggest_topics(self, limit=5, since=None):
        return self._opps[:limit]


class _Boom:
    def suggest_topics(self, limit=5, since=None):
        raise RuntimeError("db down")


class KeywordsTestCase(unittest.TestCase):
    def test_drops_stopwords_and_short_tokens(self):
        kws = ap.keywords_from_topic("The fall of the Roman Empire")
        self.assertIn("roman", kws)
        self.assertIn("empire", kws)
        self.assertNotIn("the", kws)
        self.assertNotIn("of", kws)

    def test_dedupes_and_limits(self):
        kws = ap.keywords_from_topic("space space galaxy stars nebula cosmos quasar pulsar", limit=3)
        self.assertEqual(len(kws), 3)
        self.assertEqual(kws[0], "space")  # deduped


class PromptsTestCase(unittest.TestCase):
    def test_all_three_modalities_mention_topic(self):
        prompts = ap.build_prompts("black holes", ["black", "holes"])
        for key in ("video", "image", "voice"):
            self.assertIn("black holes", prompts[key])
        self.assertIn("no on-screen text", prompts["video"])


class BuildPlanTestCase(unittest.TestCase):
    def test_builds_from_top_opportunity(self):
        rec = _Recommender([
            _Opp("The lost city of Petra", 0.82, "both", "high velocity across 3 trackers"),
            _Opp("second", 0.5, "trend", "lower"),
        ])
        plan = ap.build_plan(rec, channel_id="hist", video_provider="higgsfield", voice_provider="elevenlabs")
        self.assertIsNotNone(plan)
        self.assertEqual(plan.topic, "The lost city of Petra")
        self.assertEqual(plan.source, "both")
        self.assertEqual(plan.score, 0.82)
        self.assertEqual(plan.video_provider, "higgsfield")
        self.assertEqual(plan.voice_provider, "elevenlabs")
        self.assertIn("petra", plan.keywords)
        self.assertIn("The lost city of Petra", plan.prompts["video"])

    def test_empty_recommender_returns_none(self):
        self.assertIsNone(ap.build_plan(_Recommender([]), channel_id="x"))

    def test_recommender_failure_returns_none(self):
        self.assertIsNone(ap.build_plan(_Boom(), channel_id="x"))

    def test_blank_topic_skipped(self):
        self.assertIsNone(ap.build_plan(_Recommender([_Opp("   ", 0.9, "trend", "r")])))

    def test_non_numeric_score_becomes_none(self):
        rec = _Recommender([_Opp("Topic", float("nan"), "trend", "r")])
        plan = ap.build_plan(rec)
        self.assertIsNotNone(plan)
        self.assertIsNone(plan.score)   # NaN → None, never a fake 0.0


class SummarizeTestCase(unittest.TestCase):
    def test_truncates_rationale_and_keeps_fields(self):
        rec = _Recommender([_Opp("Topic X", 0.4, "demand", "y" * 500)])
        plan = ap.build_plan(rec, video_provider="minimax", voice_provider="edge")
        summary = ap.summarize(plan)
        self.assertEqual(summary["topic"], "Topic X")
        self.assertLessEqual(len(summary["rationale"]), 280)
        self.assertEqual(summary["source"], "demand")
        self.assertEqual(summary["video_provider"], "minimax")
        self.assertIn("keywords", summary)


if __name__ == "__main__":
    unittest.main()
