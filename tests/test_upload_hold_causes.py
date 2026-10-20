"""Distinct hold causes for an upload YouTube refused, and a privacy it did not honour (audit M12).

A ``videos.insert`` that fails used to be one word, ``upload_failed``, whatever YouTube said. "Out
of quota today" (wait until tomorrow), "this channel hit its upload limit" (wait longer) and "the
connection to the channel is broken" (reconnect) need three different responses from the owner, so
each gets its own closed word in ``hold_detail.cause``. The words are fixed; an exception's text
is never stored, so a token that leaked into an error message cannot reach the row.

Also: YouTube may keep an upload private whatever was asked for (an API project that has not
passed the audit). The insert's own response says what it did, and a video recorded as the
privacy that was REQUESTED instead of the one YouTube APPLIED would read as published when it is
not.

No network: every error is a fake carrying the shape googleapiclient's ``HttpError`` has.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from modules import held_video, youtube_uploader
from modules.script_engine import Script
from modules.youtube_uploader import YouTubeUploader, reconcile_privacy


class FakeHttpError(Exception):
    """The attributes of googleapiclient.errors.HttpError this code reads."""

    def __init__(self, status, reason=None, via="content"):
        super().__init__(f"<HttpError {status}>")
        self.resp = type("R", (), {"status": status})()
        errors = [{"reason": reason, "domain": "youtube.quota"}] if reason else []
        doc = {"error": {"code": status, "message": "do not store me ya29.SECRET", "errors": errors}}
        self.content = json.dumps(doc).encode("utf-8")
        self.error_details = errors if via == "details" else ""


class RefreshError(Exception):
    """google.auth.exceptions.RefreshError, by name (the code matches the type name)."""


class UploadFailureCauseTestCase(unittest.TestCase):
    def cause(self, exc):
        return held_video.upload_failure_cause(exc)

    def test_quota_exceeded_is_its_own_cause(self):
        self.assertEqual(self.cause(FakeHttpError(403, "quotaExceeded")), "quota_exceeded")
        self.assertEqual(self.cause(FakeHttpError(403, "dailyLimitExceeded")), "quota_exceeded")

    def test_upload_limit_exceeded_is_its_own_cause(self):
        self.assertEqual(self.cause(FakeHttpError(400, "uploadLimitExceeded")), "upload_limit_exceeded")

    def test_the_reason_is_read_from_error_details_too(self):
        self.assertEqual(self.cause(FakeHttpError(403, "quotaExceeded", via="details")), "quota_exceeded")

    def test_a_broken_connection_to_the_channel_is_its_own_cause(self):
        self.assertEqual(self.cause(RefreshError("invalid_grant: Token has been expired or revoked.")),
                         "token_expired")
        self.assertEqual(self.cause(FakeHttpError(401, "authError")), "token_expired")

    def test_everything_else_stays_upload_failed(self):
        for exc in (FakeHttpError(500, "backendError"), FakeHttpError(400, "invalidTags"),
                    FakeHttpError(403, "rateLimitExceeded"), FakeHttpError(403, "forbidden"),
                    FakeHttpError(503), TimeoutError("timed out"), FileNotFoundError("x"),
                    ValueError("boom"), RuntimeError("quotaExceeded")):
            with self.subTest(exc=repr(exc)):
                self.assertEqual(self.cause(exc), "upload_failed")

    def test_message_text_alone_never_picks_a_cause(self):
        # Only YouTube's structured reason does: free text can say anything.
        self.assertEqual(self.cause(RuntimeError("quotaExceeded uploadLimitExceeded invalid_grant")),
                         "upload_failed")

    def test_the_answer_is_always_a_word_from_the_closed_list(self):
        for exc in (FakeHttpError(403, "quotaExceeded"), RefreshError("x"), ValueError("ya29.SECRET")):
            self.assertIn(self.cause(exc), held_video.HOLD_CAUSES)

    def test_the_new_words_are_in_the_closed_list(self):
        for word in ("upload_failed", "quota_exceeded", "upload_limit_exceeded", "token_expired"):
            self.assertIn(word, held_video.HOLD_CAUSES)


class HeldRecordKeepsTheCauseTestCase(unittest.TestCase):
    def test_each_cause_word_reaches_hold_detail(self):
        for word in held_video.HOLD_CAUSES:
            with self.subTest(word=word):
                detail = held_video.gate_detail("held", {"allowed": True, "reason": word})
                self.assertEqual(detail["cause"], word)

    def test_a_word_outside_the_list_is_dropped_not_stored(self):
        detail = held_video.gate_detail("held", {"allowed": True, "reason": "quotaExceeded ya29.SECRET"})
        self.assertNotIn("cause", detail)
        self.assertNotIn("SECRET", repr(detail))


class ReconcilePrivacyTestCase(unittest.TestCase):
    """(requested, observed) -> (recorded, limit, mismatch)."""

    def test_table(self):
        cases = [
            # requested, observed, recorded, limit(downstream), mismatch
            ("private", "private", "private", "private", False),
            ("public", "public", "public", "public", False),
            ("unlisted", "unlisted", "unlisted", "unlisted", False),
            ("public", "private", "private", "private", True),      # YouTube forced it private
            ("public", "unlisted", "unlisted", "unlisted", True),
            ("unlisted", "private", "private", "private", True),
            ("private", "public", "public", "private", True),       # anomaly: recorded as it IS, never widened
            ("private", "unlisted", "unlisted", "private", True),
            ("public", None, "public", "public", False),            # not observed: nothing to say
            ("public", "", "public", "public", False),
            ("public", "weird", "public", "public", False),         # an unknown word is not evidence
            ("PUBLIC", "public", "public", "public", False),
        ]
        for requested, observed, recorded, limit, mismatch in cases:
            with self.subTest(requested=requested, observed=observed):
                got = reconcile_privacy(requested, observed)
                self.assertEqual((got.recorded, got.limit, got.mismatch), (recorded, limit, mismatch))

    def test_downstream_is_never_wider_than_requested(self):
        order = {"private": 0, "unlisted": 1, "public": 2}
        for requested in order:
            for observed in list(order) + [None, "weird"]:
                got = reconcile_privacy(requested, observed)
                self.assertLessEqual(order[got.limit], order[requested])


class UploaderObservesPrivacyTestCase(unittest.TestCase):
    """The privacy in videos.insert's own response is what upload() reports."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.video = Path(self._tmp.name) / "video.mp4"
        self.video.write_bytes(b"not really an mp4")

    def uploader(self, response):
        class Insert:
            def next_chunk(self_inner):
                return None, response

        class Videos:
            def insert(self_inner, **kw):
                return Insert()

        class Service:
            def videos(self_inner):
                return Videos()

        obj = object.__new__(YouTubeUploader)
        obj.channel = None
        obj.token_file = Path("none.json")
        obj.target_channel_id = ""
        obj.service = Service()
        return obj

    def script(self):
        return Script(topic="t", title="T", title_ab="", description="d", tags=["a"], hook_sentence="",
                      sections=[], thumbnail_prompt_a="", thumbnail_prompt_b="",
                      thumbnail_overlay_text="", open_loops=[])

    def test_the_applied_privacy_is_reported(self):
        out = self.uploader({"id": "vid1", "status": {"privacyStatus": "private"}}).upload(
            self.video, self.script(), privacy="public")
        self.assertEqual(out["id"], "vid1")
        self.assertEqual(out["privacy"], "private")

    def test_a_response_without_a_status_reports_nothing_rather_than_the_request(self):
        out = self.uploader({"id": "vid1"}).upload(self.video, self.script(), privacy="public")
        self.assertNotIn("privacy", out)


class MainWiringTestCase(unittest.TestCase):
    """main.py is too large to drive from a unit test; pin the seams instead."""

    @classmethod
    def setUpClass(cls):
        import ast

        cls.src = (Path(__file__).resolve().parent.parent / "main.py").read_text(encoding="utf-8")
        tree = ast.parse(cls.src)
        cls.run_fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "run")
        cls.ast = ast

    def calls(self, name):
        return [c for c in self.ast.walk(self.run_fn) if isinstance(c, self.ast.Call)
                and self.ast.unparse(c.func).endswith(name)]

    def test_the_failed_upload_hold_carries_the_classified_cause(self):
        held = [c for c in self.calls("_record_held_run")
                if "upload_cause" in self.ast.unparse(c)]
        self.assertEqual(len(held), 1)
        self.assertIn('"reason": upload_cause', self.ast.unparse(held[0]).replace("'", '"'))
        self.assertIn("upload_cause = held_video.upload_failure_cause(e)", self.src)

    def test_the_failed_upload_event_names_the_cause_too(self):
        failed = [c for c in self.calls("events.emit") if "UPLOAD_FAILED" in self.ast.unparse(c)]
        self.assertTrue(failed and all("upload_cause" in self.ast.unparse(c) for c in failed))

    def test_the_row_and_the_events_record_what_youtube_applied(self):
        for name in ("record_video", "held_video.promote"):
            for c in self.calls(name):
                kw = {k.arg: self.ast.unparse(k.value) for k in c.keywords}
                if "privacy" in kw and "published_at" in kw:      # the long video's row, not the Short's
                    self.assertEqual(kw["privacy"], "recorded_privacy", name)
        published = [c for c in self.calls("events.emit") if "VIDEO_PUBLISHED" in self.ast.unparse(c)]
        self.assertEqual(len(published), 1)
        self.assertIn('"privacy": recorded_privacy', self.ast.unparse(published[0]).replace("'", '"'))

    def test_the_short_never_goes_wider_than_the_request(self):
        short = [c for c in self.calls("_publish_short")]
        self.assertEqual(len(short), 1)
        kw = {k.arg: self.ast.unparse(k.value) for k in short[0].keywords}
        self.assertEqual(kw["privacy"], "short_privacy")


if __name__ == "__main__":
    unittest.main()
