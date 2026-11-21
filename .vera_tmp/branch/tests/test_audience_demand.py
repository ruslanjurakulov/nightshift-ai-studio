"""Tests for modules.audience_demand.

Plain stdlib unittest, plain dict fixtures -- this module makes no external
calls so no mocking is needed.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.audience_demand import AudienceDemandEngine, DemandSignal


def make_record(comment_id, text, category="topic_request", sentiment="neutral"):
    return {
        "comment_id": comment_id,
        "sentiment": sentiment,
        "category": category,
        "text": text,
    }


class AudienceDemandEngineTests(unittest.TestCase):
    def test_near_duplicate_topic_requests_group_together(self):
        records = [
            make_record(1, "cover Genghis Khan"),
            make_record(2, "do a video on Genghis Khan please"),
            make_record(3, "Genghis Khan next!!"),
        ]
        engine = AudienceDemandEngine()
        signals = engine.analyze(records)

        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0].mention_count, 3)
        self.assertEqual(set(signals[0].example_comment_ids), {1, 2, 3})

    def test_unrelated_topic_request_stays_separate(self):
        records = [
            make_record(1, "cover Genghis Khan"),
            make_record(2, "do a video on Genghis Khan please"),
            make_record(3, "please make a video about the Roman aqueducts"),
        ]
        engine = AudienceDemandEngine()
        signals = engine.analyze(records)

        self.assertEqual(len(signals), 2)
        counts = sorted(s.mention_count for s in signals)
        self.assertEqual(counts, [1, 2])

    def test_non_topic_request_categories_excluded(self):
        records = [
            make_record(1, "cover Genghis Khan"),
            make_record(2, "great video, loved it!", category="praise"),
            make_record(3, "what camera do you use?", category="question"),
            make_record(4, "this is spam buy my product", category="spam"),
        ]
        engine = AudienceDemandEngine()
        signals = engine.analyze(records)

        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0].mention_count, 1)
        self.assertEqual(signals[0].example_comment_ids, [1])

    def test_empty_input_returns_empty_list(self):
        engine = AudienceDemandEngine()
        self.assertEqual(engine.analyze([]), [])
        self.assertEqual(engine.analyze(None), [])

    def test_all_non_topic_request_returns_empty_list(self):
        records = [
            make_record(1, "great video!", category="praise"),
            make_record(2, "what mic do you use?", category="question"),
        ]
        engine = AudienceDemandEngine()
        self.assertEqual(engine.analyze(records), [])

    def test_single_unique_request_returns_one_signal_with_count_one(self):
        records = [make_record(1, "please cover the fall of Rome")]
        engine = AudienceDemandEngine()
        signals = engine.analyze(records)

        self.assertEqual(len(signals), 1)
        self.assertIsInstance(signals[0], DemandSignal)
        self.assertEqual(signals[0].mention_count, 1)
        self.assertEqual(signals[0].topic_phrase, "please cover the fall of Rome")
        self.assertEqual(signals[0].example_comment_ids, [1])

    def test_results_sorted_descending_by_mention_count(self):
        records = [
            make_record(1, "cover Genghis Khan"),
            make_record(2, "do a video on Genghis Khan please"),
            make_record(3, "Genghis Khan next!!"),
            make_record(4, "please make a video about the Roman aqueducts"),
            make_record(5, "aqueducts of Rome, please cover this next"),
            make_record(6, "totally different one-off request about pyramids"),
        ]
        engine = AudienceDemandEngine()
        signals = engine.analyze(records)

        counts = [s.mention_count for s in signals]
        self.assertEqual(counts, sorted(counts, reverse=True))
        self.assertEqual(counts[0], 3)

    def test_custom_similarity_threshold_changes_grouping(self):
        records = [
            make_record(1, "cover Genghis Khan"),
            make_record(2, "do a video on Genghis Khan please"),
            make_record(3, "Genghis Khan next!!"),
        ]

        loose_engine = AudienceDemandEngine(similarity_threshold=0.3)
        loose_signals = loose_engine.analyze(records)
        self.assertEqual(len(loose_signals), 1)
        self.assertEqual(loose_signals[0].mention_count, 3)

        strict_engine = AudienceDemandEngine(similarity_threshold=0.99)
        strict_signals = strict_engine.analyze(records)
        self.assertGreater(len(strict_signals), 1)
        self.assertTrue(all(s.mention_count == 1 for s in strict_signals))


if __name__ == "__main__":
    unittest.main()
