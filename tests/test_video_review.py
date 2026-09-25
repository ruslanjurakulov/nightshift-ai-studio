"""What the review mirror does, and — more importantly — what it refuses to do.

The whole point of this module is that a human sees the video before it goes
public. That only holds if every failure leans the same way: when anything is
unknown or broken, the video waits. These tests pin that direction down, and
pin the promise that nothing here publishes.
"""

import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from modules.video_review import MAX_BYTES, VideoReview


class Disabled(unittest.TestCase):
    """Without keys the module is inert — the run must be unaffected."""

    def setUp(self):
        self.r = VideoReview(url="", service_key="")

    def test_is_disabled(self):
        self.assertFalse(self.r.enabled)

    def test_upload_is_a_no_op(self):
        self.assertIsNone(self.r.upload_preview(Path("/tmp/x.mp4"), "c", "v"))

    def test_auto_publish_reads_false(self):
        """No keys must not read as 'this channel publishes by itself'."""
        self.assertFalse(self.r.fetch_auto_publish("c"))

    def test_record_does_nothing(self):
        # Would raise on a missing file if it got as far as touching one.
        self.r.record(video_id="v", channel_id="c", video_path=Path("/nope.mp4"),
                      script_text="x", auto_publish=False)


class SafeDirection(unittest.TestCase):
    def setUp(self):
        self.r = VideoReview(url="https://x.supabase.co", service_key="k")

    @patch("modules.video_review.requests.get", side_effect=OSError("network down"))
    def test_auto_publish_is_false_when_the_lookup_fails(self, _):
        """An outage must never be read as permission to publish."""
        self.assertFalse(self.r.fetch_auto_publish("c"))

    @patch("modules.video_review.requests.get")
    def test_auto_publish_is_false_when_the_column_is_absent(self, get):
        get.return_value = MagicMock(status_code=200, json=lambda: [{}])
        get.return_value.raise_for_status = lambda: None
        self.assertFalse(self.r.fetch_auto_publish("c"))

    @patch("modules.video_review.requests.get")
    def test_auto_publish_is_true_only_when_it_says_so(self, get):
        get.return_value = MagicMock(status_code=200, json=lambda: [{"auto_publish": True}])
        get.return_value.raise_for_status = lambda: None
        self.assertTrue(self.r.fetch_auto_publish("c"))

    @patch("modules.video_review.requests.post")
    def test_an_oversized_review_copy_is_refused_rather_than_uploaded(self, post):
        """The bucket's own ceiling is 50 MB. Refuse before the wire, not on it."""
        big = MagicMock()
        big.stat.return_value = MagicMock(st_size=MAX_BYTES + 1)
        self.r.review_copy = MagicMock(return_value=(big, False))
        self.assertIsNone(self.r.upload_preview(Path("/x.mp4"), "c", "v"))
        post.assert_not_called()

    @patch("modules.video_review.requests.post", side_effect=OSError("boom"))
    def test_a_failed_upload_returns_none_instead_of_raising(self, _):
        f = MagicMock()
        f.stat.return_value = MagicMock(st_size=1024)
        f.open = MagicMock()
        self.r.review_copy = MagicMock(return_value=(f, False))
        self.assertIsNone(self.r.upload_preview(Path("/x.mp4"), "c", "v"))


class TheReviewCopy(unittest.TestCase):
    """What gets uploaded is a small cut, and a failure to make one is survivable."""

    def setUp(self):
        self.r = VideoReview(url="https://x.supabase.co", service_key="k")

    @patch("modules.video_review._ffmpeg_exe", return_value=None)
    def test_without_ffmpeg_it_falls_back_to_the_master(self, _):
        source = Path("/x.mp4")
        path, temporary = self.r.review_copy(source)
        self.assertEqual(path, source)
        self.assertFalse(temporary, "the master is not ours to delete")

    @patch("modules.video_review._ffmpeg_exe", return_value="/usr/bin/ffmpeg")
    @patch("modules.video_review.subprocess.run")
    def test_a_failed_transcode_leaves_no_temp_file_behind(self, run, _):
        run.return_value = MagicMock(returncode=1)
        with patch("modules.video_review.Path.unlink") as unlink:
            path, temporary = self.r.review_copy(Path("/x.mp4"))
        self.assertEqual(path, Path("/x.mp4"))
        self.assertFalse(temporary)
        unlink.assert_called_once()

    @patch("modules.video_review._ffmpeg_exe", return_value="/usr/bin/ffmpeg")
    @patch("modules.video_review.subprocess.run")
    def test_it_downscales_to_480p(self, run, _):
        run.return_value = MagicMock(returncode=1)  # keep it off the filesystem
        self.r.review_copy(Path("/x.mp4"))
        command = run.call_args[0][0]
        self.assertIn("scale=-2:480", command)
        self.assertIn("-movflags", command)

    @patch("modules.video_review.requests.post")
    def test_the_temp_copy_is_deleted_after_the_upload(self, post):
        post.return_value = MagicMock(status_code=200)
        tmp = MagicMock()
        tmp.stat.return_value = MagicMock(st_size=1024)
        tmp.open = MagicMock()
        self.r.review_copy = MagicMock(return_value=(tmp, True))
        self.assertEqual(self.r.upload_preview(Path("/x.mp4"), "c", "v"), "c/v.mp4")
        tmp.unlink.assert_called_once()


class ReviewStateFollowsTheChannel(unittest.TestCase):
    def setUp(self):
        self.r = VideoReview(url="https://x.supabase.co", service_key="k")
        self.r.upload_preview = MagicMock(return_value=None)
        self.r.prune = MagicMock()
        self.r._upsert_video = MagicMock(return_value=True)

    def test_manual_channel_leaves_the_video_pending(self):
        self.r.record(video_id="v", channel_id="c", video_path=Path("/x.mp4"),
                      script_text="the narration", auto_publish=False)
        patch_arg = self.r._upsert_video.call_args[0][0]
        self.assertEqual(patch_arg["review_state"], "pending")
        self.assertEqual(patch_arg["script_text"], "the narration")

    def test_auto_channel_has_nothing_waiting(self):
        self.r.record(video_id="v", channel_id="c", video_path=Path("/x.mp4"),
                      script_text="x", auto_publish=True)
        self.assertEqual(self.r._upsert_video.call_args[0][0]["review_state"], "approved")

    def test_it_only_ever_writes_the_review_fields_and_the_row_key(self):
        """No privacy, no status, no publish. The mirror does not act. The key
        and channel are there because the write may create the row."""
        self.r.record(video_id="v", channel_id="c", video_path=Path("/x.mp4"),
                      script_text="x", auto_publish=False)
        keys = set(self.r._upsert_video.call_args[0][0])
        self.assertEqual(keys, {"video_id", "channel_id", "script_text", "review_state"})


if __name__ == "__main__":
    unittest.main()
