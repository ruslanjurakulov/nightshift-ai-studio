"""Tests for modules/topic_manager.py, focused on the content-planner queue
integration added alongside tools/run_intelligence_poll.py's producer side
(_try_queued_topic / pick_topic checking ContentPlanner before spending a
Gemini call).

OriginalityEngine, TopicRecommender, and PerformanceAnalyzer are mocked out
(their own behavior is covered by tests/test_originality_engine.py,
tests/test_topic_recommender.py, and tests/test_performance_analyzer.py
respectively) so these tests isolate the queue-check control flow itself.
Crucially, PerformanceAnalyzer must be mocked here even though this file
doesn't test its output: an unmocked PerformanceAnalyzer() constructs a
real default StateStore(), which opens/creates the actual project
history/chronos.db file as a side effect — exactly what these tests use a
tempdir for everything else to avoid.
ContentPlanner is real, tempdir-backed — its own dedup/lifecycle behavior is
already covered by tests/test_content_planner.py, but exercising the real
thing here proves the integration actually calls it correctly (real
mark_published/mark_skipped side effects, not just mock call assertions).
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from modules.content_planner import ContentPlanner
from modules.originality_engine import OriginalityResult


def _null_feedback_engine() -> MagicMock:
    """A FeedbackEngine stand-in that contributes no learned-score prompt text,
    so it never opens the real StateStore during these tests."""
    fake = MagicMock()
    fake.topic_scores_as_prompt_text.return_value = ""
    return fake


class TopicManagerQueueIntegrationTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.history_path = Path(self._tmpdir.name) / "topics.json"
        self.calendar_path = Path(self._tmpdir.name) / "content_calendar.json"

        import config
        self._orig_history_file = config.TOPIC_HISTORY_FILE
        config.TOPIC_HISTORY_FILE = self.history_path

    def tearDown(self):
        import config
        config.TOPIC_HISTORY_FILE = self._orig_history_file
        self._tmpdir.cleanup()

    def _patch(self, target, **kwargs):
        """patch.object-style helper that keeps the patch alive for the rest
        of the test (via addCleanup) instead of only within a `with` block —
        pick_topic() is called after construction, outside any narrower
        `with patch(...)` a helper method could otherwise use, so the mocks
        for make_client/generate_with_retry etc. must still be active then.
        """
        patcher = patch(target, **kwargs)
        mock_obj = patcher.start()
        self.addCleanup(patcher.stop)
        return mock_obj

    def _make_manager(self, originality_check_result=None, gemini_text="A Freshly Generated Topic"):
        """Builds a TopicManager with make_client/generate_with_retry/
        OriginalityEngine mocked out (patches remain active for the rest of
        the test, including the pick_topic() call made after this returns),
        but a real tempdir-backed ContentPlanner and a mocked TopicRecommender
        forced to return no suggestions (prompt-text rendering isn't this
        file's concern — see tests/test_topic_recommender.py for that).
        """
        fake_originality = MagicMock()
        fake_originality.check.return_value = originality_check_result
        fake_originality.register.return_value = None

        fake_recommender = MagicMock()
        fake_recommender.suggest_topics_as_prompt_text.return_value = ""

        fake_performance_analyzer = MagicMock()
        fake_performance_analyzer.analyze_videos_as_prompt_text.return_value = ""

        fake_feedback_engine = MagicMock()
        fake_feedback_engine.topic_scores_as_prompt_text.return_value = ""

        gen_mock = MagicMock()
        gen_mock.text = gemini_text

        self._patch("modules.topic_manager.make_client", return_value=MagicMock())
        self._patch("modules.topic_manager.generate_with_retry", return_value=gen_mock)
        self._patch("modules.topic_manager.OriginalityEngine", return_value=fake_originality)
        self._patch("modules.topic_manager.TopicRecommender", return_value=fake_recommender)
        self._patch("modules.topic_manager.PerformanceAnalyzer", return_value=fake_performance_analyzer)
        self._patch("modules.topic_manager.FeedbackEngine", return_value=fake_feedback_engine)
        self._patch("modules.topic_manager.ContentPlanner", side_effect=lambda: ContentPlanner(store_path=self.calendar_path))

        from modules.topic_manager import TopicManager
        return TopicManager()

    def test_empty_queue_falls_through_to_gemini(self):
        result = OriginalityResult(is_duplicate=False, needs_review=False, closest_match=None, semantic_score=0.0, lexical_score=0.0)
        tm = self._make_manager(originality_check_result=result, gemini_text="Gemini's Pick")

        topic = tm.pick_topic("history mysteries")

        self.assertEqual(topic, "Gemini's Pick")

    def test_queued_topic_is_used_without_a_gemini_call(self):
        planner = ContentPlanner(store_path=self.calendar_path)
        planner.enqueue("The Lost Colony of Roanoke", source="manual", rationale="test seed")

        result = OriginalityResult(is_duplicate=False, needs_review=False, closest_match=None, semantic_score=0.0, lexical_score=0.0)
        tm = self._make_manager(originality_check_result=result, gemini_text="SHOULD NOT BE USED")

        with patch("modules.topic_manager.generate_with_retry") as gen_mock:
            topic = tm.pick_topic("history mysteries")
            gen_mock.assert_not_called()

        self.assertEqual(topic, "The Lost Colony of Roanoke")

        # Picking a queued topic only *reserves* it — it is not "published" the
        # instant it is chosen. Publishing happens later, on real upload success
        # (see mark_queue_entry_published / test_queue_entry_lifecycle_advances).
        entries = planner.list_entries()
        self.assertEqual(entries[0].status, "reserved")

    def test_queue_entry_lifecycle_advances_only_on_real_progress(self):
        """The reserved entry advances to rendered, then published, only when
        the run tells the manager those things actually happened — never at
        pick time."""
        planner = ContentPlanner(store_path=self.calendar_path)
        entry = planner.enqueue("The Antikythera Mechanism", source="manual")

        result = OriginalityResult(is_duplicate=False, needs_review=False, closest_match=None, semantic_score=0.0, lexical_score=0.0)
        tm = self._make_manager(originality_check_result=result, gemini_text="UNUSED")

        tm.pick_topic("history mysteries")
        self.assertEqual(planner.list_entries()[0].status, "reserved")

        tm.mark_queue_entry_rendered()
        self.assertEqual(planner.list_entries()[0].status, "rendered")

        tm.mark_queue_entry_published()
        self.assertEqual(planner.list_entries()[0].status, "published")

    def test_queue_transitions_are_a_noop_for_a_gemini_topic(self):
        """When the topic was generated by Gemini (nothing reserved), the
        render/publish bookkeeping calls do nothing and never raise."""
        result = OriginalityResult(is_duplicate=False, needs_review=False, closest_match=None, semantic_score=0.0, lexical_score=0.0)
        tm = self._make_manager(originality_check_result=result, gemini_text="A Gemini Topic")

        topic = tm.pick_topic("history mysteries")
        self.assertEqual(topic, "A Gemini Topic")

        # No reservation was made; these must be safe no-ops.
        tm.mark_queue_entry_rendered()
        tm.mark_queue_entry_published()

    def test_queued_topic_hard_blocked_falls_back_to_gemini_and_marks_skipped(self):
        planner = ContentPlanner(store_path=self.calendar_path)
        entry = planner.enqueue("A Duplicate Topic", source="manual")

        blocked = OriginalityResult(is_duplicate=True, needs_review=False, closest_match="A Duplicate Topic (already used)", semantic_score=0.95, lexical_score=0.9)
        clear = OriginalityResult(is_duplicate=False, needs_review=False, closest_match=None, semantic_score=0.0, lexical_score=0.0)
        tm = self._make_manager(originality_check_result=blocked, gemini_text="Fresh Fallback Topic")
        # Only the QUEUED topic is a duplicate; the fresh one is not. (This test
        # used to mark every candidate a duplicate and pass on pick_topic's old
        # "use the last one anyway" fallback, which no longer exists.)
        tm.originality.check.side_effect = lambda topic: blocked if topic == "A Duplicate Topic" else clear

        topic = tm.pick_topic("history mysteries")

        self.assertEqual(topic, "Fresh Fallback Topic")
        entries = {e.entry_id: e for e in planner.list_entries()}
        self.assertEqual(entries[entry.entry_id].status, "skipped")

    def test_queued_topic_needs_review_is_used_anyway(self):
        planner = ContentPlanner(store_path=self.calendar_path)
        planner.enqueue("A Near-Duplicate Topic", source="manual")

        flagged = OriginalityResult(is_duplicate=False, needs_review=True, closest_match="Something Similar", semantic_score=0.82, lexical_score=0.7)
        tm = self._make_manager(originality_check_result=flagged, gemini_text="SHOULD NOT BE USED")

        topic = tm.pick_topic("history mysteries")

        self.assertEqual(topic, "A Near-Duplicate Topic")

    def test_content_planner_construction_failure_falls_back_to_gemini(self):
        fake_originality = MagicMock()
        fake_originality.check.return_value = OriginalityResult(is_duplicate=False, needs_review=False, closest_match=None, semantic_score=0.0, lexical_score=0.0)

        fake_recommender = MagicMock()
        fake_recommender.suggest_topics_as_prompt_text.return_value = ""

        fake_performance_analyzer = MagicMock()
        fake_performance_analyzer.analyze_videos_as_prompt_text.return_value = ""

        gen_mock = MagicMock()
        gen_mock.text = "Gemini Fallback"

        with patch("modules.topic_manager.make_client", return_value=MagicMock()), \
             patch("modules.topic_manager.generate_with_retry", return_value=gen_mock), \
             patch("modules.topic_manager.OriginalityEngine", return_value=fake_originality), \
             patch("modules.topic_manager.TopicRecommender", return_value=fake_recommender), \
             patch("modules.topic_manager.PerformanceAnalyzer", return_value=fake_performance_analyzer), \
             patch("modules.topic_manager.FeedbackEngine", return_value=_null_feedback_engine()), \
             patch("modules.topic_manager.ContentPlanner", side_effect=RuntimeError("disk full")):
            from modules.topic_manager import TopicManager
            tm = TopicManager()  # must not raise
            self.assertIsNone(tm.content_planner)
            topic = tm.pick_topic("history mysteries")

        self.assertEqual(topic, "Gemini Fallback")

    def test_performance_context_is_appended_to_the_gemini_prompt(self):
        result = OriginalityResult(is_duplicate=False, needs_review=False, closest_match=None, semantic_score=0.0, lexical_score=0.0)
        tm = self._make_manager(originality_check_result=result, gemini_text="Gemini's Pick")
        tm.performance_analyzer.analyze_videos_as_prompt_text.return_value = (
            "Past video performance, for context only -- not a formula to copy:\n"
            '- "Ancient Rome Secrets" (The Fall of Rome) — 100.0 views/day'
        )

        with patch("modules.topic_manager.generate_with_retry", return_value=MagicMock(text="Gemini's Pick")) as gen_mock:
            tm.pick_topic("history mysteries")

        prompt_used = gen_mock.call_args[0][2]
        self.assertIn("Ancient Rome Secrets", prompt_used)
        self.assertIn("not a formula to copy", prompt_used)

    def test_performance_analyzer_construction_failure_degrades_gracefully(self):
        fake_originality = MagicMock()
        fake_originality.check.return_value = OriginalityResult(is_duplicate=False, needs_review=False, closest_match=None, semantic_score=0.0, lexical_score=0.0)

        fake_recommender = MagicMock()
        fake_recommender.suggest_topics_as_prompt_text.return_value = ""

        gen_mock = MagicMock()
        gen_mock.text = "Gemini's Pick"

        with patch("modules.topic_manager.make_client", return_value=MagicMock()), \
             patch("modules.topic_manager.generate_with_retry", return_value=gen_mock), \
             patch("modules.topic_manager.OriginalityEngine", return_value=fake_originality), \
             patch("modules.topic_manager.TopicRecommender", return_value=fake_recommender), \
             patch("modules.topic_manager.PerformanceAnalyzer", side_effect=RuntimeError("disk full")), \
             patch("modules.topic_manager.FeedbackEngine", return_value=_null_feedback_engine()), \
             patch("modules.topic_manager.ContentPlanner", side_effect=lambda: ContentPlanner(store_path=self.calendar_path)):
            from modules.topic_manager import TopicManager
            tm = TopicManager()  # must not raise
            self.assertIsNone(tm.performance_analyzer)
            topic = tm.pick_topic("history mysteries")

        self.assertEqual(topic, "Gemini's Pick")

    def _construct_with_patched_collaborators(self, channel):
        """Build a TopicManager with every collaborator patched to a bare mock,
        returning the TopicRecommender patch so a test can assert how it was
        constructed. No pick_topic() call — this is about construction wiring."""
        with patch("modules.topic_manager.make_client", return_value=MagicMock()), \
             patch("modules.topic_manager.OriginalityEngine", return_value=MagicMock()), \
             patch("modules.topic_manager.TopicRecommender", return_value=MagicMock()) as recommender, \
             patch("modules.topic_manager.PerformanceAnalyzer", return_value=MagicMock()), \
             patch("modules.topic_manager.FeedbackEngine", return_value=MagicMock()), \
             patch("modules.topic_manager.ContentPlanner", return_value=MagicMock()):
            from modules.topic_manager import TopicManager
            TopicManager(channel=channel)
        return recommender

    def test_recommender_is_scoped_to_the_channel(self):
        """The class docstring promises every collaborator is scoped to the
        channel. The recommender's competitor and audience-demand inputs are
        channel-owned, so it must receive the channel id like ContentPlanner,
        PerformanceAnalyzer, and FeedbackEngine do — otherwise one channel's
        demand signals leak into another channel's topic prompt."""
        fake_channel = MagicMock()
        fake_channel.channel_id = "chan-history-123"

        recommender = self._construct_with_patched_collaborators(fake_channel)

        recommender.assert_called_once_with(channel_id="chan-history-123")

    def test_recommender_is_unscoped_for_a_single_channel_run(self):
        """No channel means the pre-multi-channel behaviour: channel_id=None,
        which TopicRecommender treats as "every row, unscoped"."""
        recommender = self._construct_with_patched_collaborators(None)

        recommender.assert_called_once_with(channel_id=None)


if __name__ == "__main__":
    unittest.main()
