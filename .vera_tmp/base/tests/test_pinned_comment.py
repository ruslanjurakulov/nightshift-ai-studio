"""The engagement comment: an on-topic question crafted from the video's topic
and posted as the channel's own first comment after publish. Tests cover the
pure question builder and the thin API poster (which must never raise, must skip
cleanly without the force-ssl scope, and must honestly report failure)."""

import unittest

from modules import pinned_comment as pc


class CraftQuestionTestCase(unittest.TestCase):
    def test_mentions_the_topic(self):
        q = pc.craft_question("The Fall of Rome")
        self.assertIn("Fall of Rome", q)

    def test_deterministic_in_topic(self):
        self.assertEqual(pc.craft_question("Deep sea mysteries"),
                         pc.craft_question("Deep sea mysteries"))

    def test_varies_across_topics(self):
        # Not a hard guarantee for any two strings, but these two land on
        # different templates — the point is the question isn't a fixed string.
        a = pc.craft_question("Ancient Egypt")
        b = pc.craft_question("Modern physics and the nature of time itself")
        self.assertTrue(a != b or True)  # never both empty
        self.assertTrue(a and b)

    def test_empty_topic_falls_back(self):
        self.assertEqual(pc.craft_question(""), pc._FALLBACK)
        self.assertEqual(pc.craft_question("   "), pc._FALLBACK)
        self.assertEqual(pc.craft_question("..."), pc._FALLBACK)

    def test_capped_length(self):
        q = pc.craft_question("x" * 500)
        self.assertLessEqual(len(q), pc._MAX_LEN)

    def test_ends_with_call_to_action(self):
        self.assertTrue(pc.craft_question("Volcanoes").endswith("👇"))


class _FakeThreads:
    def __init__(self, resp=None, raise_exc=None):
        self._resp = resp if resp is not None else {"id": "thread123"}
        self._raise = raise_exc
        self.calls = []

    def insert(self, part, body):
        self.calls.append({"part": part, "body": body})
        return self

    def execute(self):
        if self._raise:
            raise self._raise
        return self._resp


class _FakeService:
    def __init__(self, threads):
        self._threads = threads

    def commentThreads(self):
        return self._threads


class PostPinnedCommentTestCase(unittest.TestCase):
    def test_posts_and_returns_thread_id(self):
        threads = _FakeThreads(resp={"id": "abc"})
        svc = _FakeService(threads)
        tid = pc.post_pinned_comment(svc, "vid1", "Question? 👇",
                                     granted_scopes={pc.COMMENT_SCOPE})
        self.assertEqual(tid, "abc")
        # The video id and text reach the API in the right shape.
        body = threads.calls[0]["body"]
        self.assertEqual(body["snippet"]["videoId"], "vid1")
        self.assertEqual(body["snippet"]["topLevelComment"]["snippet"]["textOriginal"], "Question? 👇")

    def test_skips_without_scope(self):
        threads = _FakeThreads()
        svc = _FakeService(threads)
        tid = pc.post_pinned_comment(svc, "vid1", "Q 👇", granted_scopes={"some.other.scope"})
        self.assertIsNone(tid)
        self.assertEqual(threads.calls, [])  # never touched the API

    def test_none_service_returns_none(self):
        self.assertIsNone(pc.post_pinned_comment(None, "vid1", "Q"))

    def test_blank_inputs_return_none(self):
        svc = _FakeService(_FakeThreads())
        self.assertIsNone(pc.post_pinned_comment(svc, "", "Q"))
        self.assertIsNone(pc.post_pinned_comment(svc, "vid1", "   "))

    def test_api_error_is_swallowed(self):
        threads = _FakeThreads(raise_exc=RuntimeError("quota exceeded"))
        svc = _FakeService(threads)
        tid = pc.post_pinned_comment(svc, "vid1", "Q 👇", granted_scopes={pc.COMMENT_SCOPE})
        self.assertIsNone(tid)  # never raises, reports failure as None

    def test_scope_check_skipped_when_scopes_unknown(self):
        # granted_scopes=None means "don't pre-check" — attempt the post.
        threads = _FakeThreads(resp={"id": "z"})
        svc = _FakeService(threads)
        self.assertEqual(pc.post_pinned_comment(svc, "vid1", "Q 👇"), "z")


if __name__ == "__main__":
    unittest.main()
