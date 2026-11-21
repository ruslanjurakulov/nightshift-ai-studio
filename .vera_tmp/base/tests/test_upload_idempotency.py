"""Upload idempotency: one run never lands on the channel twice.

The load-bearing properties, all against a mocked YouTube client:
  * every tracked upload carries the run marker as its first tag, within the
    500-character tag budget;
  * an ambiguous failure (timeout, reset, 5xx) is reconciled by marker before
    any retry, and a found video id is reused;
  * a definitive failure (4xx, missing file) is raised and never retried;
  * when the lookup itself fails, nothing is retried;
  * a later attempt of the same run reuses the video id an earlier one got,
    or looks the marker up first when the earlier insert never reported back;
  * with no attempt, the upload is the old single shot.
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from modules import run_checkpoint
from modules import upload_idempotency as ui
from modules.script_engine import Script
from modules.youtube_uploader import MAX_TAGS, YouTubeUploader


class FakeHttpError(Exception):
    """Shaped like googleapiclient.errors.HttpError: status on .resp."""

    def __init__(self, status):
        super().__init__(f"HTTP {status}")
        self.resp = type("Resp", (), {"status": status})()


class _Exec:
    def __init__(self, fn):
        self._fn = fn

    def execute(self):
        return self._fn()


class FakeYouTube:
    """Just enough of the Data API: inserts follow a scripted list of outcomes
    (a video id, or an exception); the channel's uploads are a list of
    (video_id, tags)."""

    def __init__(self, insert_outcomes, uploads=None, lookup_error=None,
                 land_on_ambiguous=False):
        self.insert_outcomes = list(insert_outcomes)
        self.uploads = list(uploads or [])
        self.lookup_error = lookup_error
        self.land_on_ambiguous = land_on_ambiguous
        self.inserts = []
        self.thumbnail_calls = 0
        self.lookups = 0

    # videos.insert / videos.list
    def videos(self):
        yt = self

        class Videos:
            def insert(self, **kwargs):
                yt.inserts.append(kwargs)
                outcome = yt.insert_outcomes.pop(0)

                class Req:
                    def next_chunk(self_inner):
                        if isinstance(outcome, BaseException):
                            if yt.land_on_ambiguous:
                                yt.uploads.insert(0, ("landed-id", kwargs["body"]["snippet"]["tags"]))
                            raise outcome
                        yt.uploads.insert(0, (outcome, kwargs["body"]["snippet"]["tags"]))
                        return None, {"id": outcome}

                return Req()

            def list(self, part, id):
                def run():
                    if yt.lookup_error:
                        raise yt.lookup_error
                    wanted = id.split(",")
                    return {"items": [
                        {"id": vid, "snippet": {"tags": tags}}
                        for vid, tags in yt.uploads if vid in wanted
                    ]}
                return _Exec(run)

        return Videos()

    def channels(self):
        yt = self

        class Channels:
            def list(self, **kwargs):
                def run():
                    yt.lookups += 1
                    if yt.lookup_error:
                        raise yt.lookup_error
                    return {"items": [{"contentDetails": {"relatedPlaylists": {"uploads": "UU1"}}}]}
                return _Exec(run)

        return Channels()

    def playlistItems(self):
        yt = self

        class Items:
            def list(self, **kwargs):
                return _Exec(lambda: {"items": [
                    {"contentDetails": {"videoId": vid}} for vid, _ in yt.uploads[:kwargs["maxResults"]]
                ]})

        return Items()

    def thumbnails(self):
        yt = self

        class Thumbs:
            def set(self, **kwargs):
                def run():
                    yt.thumbnail_calls += 1
                    return {}
                return _Exec(run)

        return Thumbs()


def _script(tags=None):
    return Script(
        topic="A sunken ship", title="T", title_ab="", description="d",
        tags=tags if tags is not None else ["history"], hook_sentence="", sections=[],
        thumbnail_prompt_a="", thumbnail_prompt_b="", thumbnail_overlay_text="",
        open_loops=[],
    )


def _uploader(service):
    obj = object.__new__(YouTubeUploader)
    obj.channel = None
    obj.token_file = Path("nonexistent-token.json")
    obj.target_channel_id = ""
    obj.service = service
    return obj


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        run_checkpoint.record_stage("topic", run_checkpoint.STAGE_SCRIPT, root=self.root)
        self.video = self.root / "video.mp4"
        self.video.write_bytes(b"not really an mp4")
        p = patch.object(ui, "_sleep", lambda s: None)
        p.start()
        self.addCleanup(p.stop)

    def attempt(self):
        return ui.begin("topic", "chan", root=self.root)

    def upload(self, service, attempt, **kw):
        return _uploader(service).upload(self.video, _script(**kw), attempt=attempt)


class MarkerTestCase(Base):
    def test_marker_is_stable_per_run_and_short(self):
        a, b = self.attempt(), self.attempt()
        self.assertEqual(a.marker, b.marker)
        self.assertTrue(a.marker.startswith("nsrun-"))
        self.assertEqual(len(a.marker), 18)
        self.assertNotIn(" ", a.marker)

    def test_a_new_run_of_the_same_topic_gets_a_new_marker(self):
        first = self.attempt().marker
        run_checkpoint.clear("topic", root=self.root)   # the run published
        with patch.object(run_checkpoint, "_now_iso", return_value="2099-01-01T00:00:00+00:00"):
            run_checkpoint.record_stage("topic", run_checkpoint.STAGE_SCRIPT, root=self.root)
        self.assertNotEqual(first, self.attempt().marker)

    def test_without_a_checkpoint_each_attempt_is_unique(self):
        a = ui.begin("no-checkpoint", "chan", root=self.root)
        b = ui.begin("no-checkpoint", "chan", root=self.root)
        self.assertNotEqual(a.marker, b.marker)

    def test_marker_is_the_first_tag_and_the_budget_holds(self):
        yt = FakeYouTube(["vid1"])
        long_tags = [f"tag number {i}" for i in range(80)]   # well over 500 chars
        attempt = self.attempt()
        self.upload(yt, attempt, tags=long_tags)
        tags = yt.inserts[0]["body"]["snippet"]["tags"]
        self.assertEqual(tags[0], attempt.marker)
        used = sum(len(t) + (2 if " " in t else 0) + 1 for t in tags)
        self.assertLessEqual(used, MAX_TAGS)

    def test_without_an_attempt_no_marker_is_added(self):
        yt = FakeYouTube(["vid1"])
        _uploader(yt).upload(self.video, _script())
        self.assertEqual(yt.inserts[0]["body"]["snippet"]["tags"], ["history"])


class ClassificationTestCase(unittest.TestCase):
    def test_transport_and_5xx_are_ambiguous(self):
        self.assertTrue(ui.is_ambiguous(TimeoutError()))
        self.assertTrue(ui.is_ambiguous(ConnectionResetError()))
        self.assertTrue(ui.is_ambiguous(FakeHttpError(503)))

    def test_4xx_and_local_errors_are_definitive(self):
        self.assertFalse(ui.is_ambiguous(FakeHttpError(400)))
        self.assertFalse(ui.is_ambiguous(FakeHttpError(403)))
        self.assertFalse(ui.is_ambiguous(FileNotFoundError()))
        self.assertFalse(ui.is_ambiguous(ValueError()))


class AmbiguousFailureTestCase(Base):
    def test_a_landed_upload_is_found_and_reused_not_uploaded_again(self):
        yt = FakeYouTube([TimeoutError("read timed out")], land_on_ambiguous=True)
        attempt = self.attempt()
        result = self.upload(yt, attempt)
        self.assertEqual(result["id"], "landed-id")
        self.assertEqual(len(yt.inserts), 1)
        self.assertEqual(attempt.state, ui.STATE_UPLOADED)

    def test_absent_after_lookup_retries_exactly_once(self):
        yt = FakeYouTube([ConnectionResetError(), "vid2"])
        result = self.upload(yt, self.attempt())
        self.assertEqual(result["id"], "vid2")
        self.assertEqual(len(yt.inserts), 2)
        self.assertEqual(yt.lookups, len(ui.LOOKUP_DELAYS))

    def test_repeated_ambiguity_stops_after_one_retry(self):
        yt = FakeYouTube([TimeoutError(), TimeoutError(), "never"])
        attempt = self.attempt()
        with self.assertRaises(ui.UploadAmbiguousError):
            self.upload(yt, attempt)
        self.assertEqual(len(yt.inserts), 2)
        # Left "started" so the next attempt looks the marker up first.
        self.assertTrue(ui.begin("topic", "chan", root=self.root).needs_lookup)

    def test_a_failed_lookup_never_retries(self):
        yt = FakeYouTube([FakeHttpError(502), "never"], lookup_error=FakeHttpError(500))
        with self.assertRaises(ui.UploadAmbiguousError):
            self.upload(yt, self.attempt())
        self.assertEqual(len(yt.inserts), 1)


class DefinitiveFailureTestCase(Base):
    def test_a_4xx_is_raised_and_not_retried(self):
        yt = FakeYouTube([FakeHttpError(403), "never"])
        attempt = self.attempt()
        with self.assertRaises(FakeHttpError):
            self.upload(yt, attempt)
        self.assertEqual(len(yt.inserts), 1)
        self.assertEqual(yt.lookups, 0)
        self.assertEqual(attempt.state, ui.STATE_FAILED)
        self.assertFalse(ui.begin("topic", "chan", root=self.root).needs_lookup)


class LaterAttemptTestCase(Base):
    def test_a_recorded_video_id_is_reused_and_finished_steps_skipped(self):
        yt = FakeYouTube(["vid1"])
        thumb = self.root / "thumb.jpg"
        thumb.write_bytes(b"jpg")
        first = self.attempt()
        _uploader(yt).upload(self.video, _script(), thumbnail_path=thumb, attempt=first)
        self.assertEqual(yt.thumbnail_calls, 1)
        # The run crashed after the upload; --resume runs the upload stage again.
        again = self.attempt()
        self.assertEqual(again.video_id, "vid1")
        result = _uploader(yt).upload(self.video, _script(), thumbnail_path=thumb, attempt=again)
        self.assertEqual(result["id"], "vid1")
        self.assertEqual(len(yt.inserts), 1)
        self.assertEqual(yt.thumbnail_calls, 1)

    def test_an_insert_that_never_reported_back_is_looked_up_first(self):
        attempt = self.attempt()
        attempt.mark_started()          # the process died mid-insert...
        yt = FakeYouTube(["never"], uploads=[("landed-id", [attempt.marker])])  # ...and it landed
        result = self.upload(yt, self.attempt())
        self.assertEqual(result["id"], "landed-id")
        self.assertEqual(yt.inserts, [])

    def test_an_unverifiable_earlier_attempt_is_not_uploaded_over(self):
        self.attempt().mark_started()
        yt = FakeYouTube(["never"], lookup_error=TimeoutError())
        with self.assertRaises(ui.UploadAmbiguousError):
            self.upload(yt, self.attempt())
        self.assertEqual(yt.inserts, [])

    def test_a_recorded_video_deleted_by_a_human_is_uploaded_anew(self):
        attempt = self.attempt()
        attempt.mark_uploaded("deleted-id")
        yt = FakeYouTube(["vid-new"])
        result = self.upload(yt, self.attempt())
        self.assertEqual(result["id"], "vid-new")
        self.assertEqual(len(yt.inserts), 1)

    def test_ledger_holds_no_secrets(self):
        attempt = self.attempt()
        attempt.mark_uploaded("vid1")
        raw = json.loads(ui.attempt_path("topic", self.root).read_text())
        self.assertEqual(set(raw), {"slug", "channel_id", "run_epoch", "marker", "state",
                                    "video_id", "steps", "started_at", "updated_at"})


if __name__ == "__main__":
    unittest.main()
