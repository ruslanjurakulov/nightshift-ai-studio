"""YouTube: what ``status.containsSyntheticMedia`` and the description line do to
the videos.insert body, and — as important — what they must NOT do."""

import tempfile
import unittest
from pathlib import Path

from modules import ai_disclosure as ad
from modules import youtube_uploader
from tests.test_youtube_uploader import UploadWiringTestCase, script, uploader

LABELLED = ad.decide("auto", ad.Signals(generated_clips=2), language="english")
CLEAN = ad.decide("auto", ad.Signals(), language="english")
NEVER = ad.decide("never", ad.Signals(generated_clips=2))
BASE_STATUS = {"privacyStatus": "private", "selfDeclaredMadeForKids": False}


class YoutubeBody(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.video = Path(self._tmp.name) / "video.mp4"
        self.video.write_bytes(b"not really an mp4")
        self.sent = []
        self.up = uploader(service=UploadWiringTestCase()._service(self.sent))

    def body(self, **kw):
        self.sent.clear()
        kw.setdefault("privacy", "private")
        self.up.upload(self.video, kw.pop("script", script("A ship.")), **kw)
        return self.sent[-1]["body"]

    def test_without_a_decision_the_body_is_what_it_always_was(self):
        self.assertEqual(self.body()["status"], BASE_STATUS)
        self.assertEqual(self.body()["snippet"]["description"], "A ship.")

    def test_a_label_of_true_sets_the_flag_and_nothing_else_in_status(self):
        status = self.body(ai_disclosure=LABELLED)["status"]
        self.assertEqual(status, {**BASE_STATUS, "containsSyntheticMedia": True})

    def test_a_clean_or_never_decision_sends_no_field_at_all(self):
        # Absence is YouTube's "no": a body identical to the one sent before this existed.
        for decision in (CLEAN, NEVER):
            body = self.body(ai_disclosure=decision)
            self.assertEqual(body["status"], BASE_STATUS)
            self.assertEqual(body["snippet"]["description"], "A ship.")

    def test_the_flag_never_changes_the_privacy(self):
        for privacy in ("private", "unlisted"):
            self.assertEqual(self.body(ai_disclosure=LABELLED, privacy=privacy)["status"]["privacyStatus"], privacy)

    def test_the_line_is_added_to_the_description_once(self):
        d = self.body(ai_disclosure=LABELLED)["snippet"]["description"]
        self.assertEqual(d, f"A ship.\n\n{ad.STANDARD_LINES['en']}")
        # A second pass over text that already carries it does not stack another.
        again = self.body(ai_disclosure=LABELLED, description_override=d)["snippet"]["description"]
        self.assertEqual(again.count(ad.STANDARD_LINES["en"]), 1)

    def test_the_line_wins_over_the_watch_next_block_when_only_one_fits(self):
        line = ad.STANDARD_LINES["en"]
        base = "x" * (youtube_uploader.MAX_DESCRIPTION - len(line) - 2 - 5)
        suffix = "▶ WATCH NEXT\nhttps://youtu.be/abc"
        d = self.body(ai_disclosure=LABELLED, script=script(base), description_suffix=suffix)["snippet"]["description"]
        self.assertTrue(d.endswith(line))
        self.assertNotIn("WATCH NEXT", d)

    SUFFIX = "▶ WATCH NEXT\nhttps://youtu.be/abc"

    def test_watch_next_is_measured_in_bytes_after_a_russian_line(self):
        # append_watch_next counts characters (4900); a Cyrillic description of 2420 letters is ~2500 characters but
        # nearly 5000 bytes, so the block used to push it past YouTube's limit.
        ru = ad.decide("always", ad.Signals(), language="russian")
        base = "я" * ((youtube_uploader.MAX_DESCRIPTION - 2 - len(ru.line.encode()) - 10) // 2)
        d = self.body(ai_disclosure=ru, script=script(base), description_suffix=self.SUFFIX)["snippet"]["description"]
        self.assertLessEqual(len(d.encode("utf-8")), youtube_uploader.MAX_DESCRIPTION)
        self.assertTrue(d.endswith(ru.line))
        self.assertNotIn("WATCH NEXT", d)

    def test_watch_next_is_measured_in_bytes_without_a_label_too(self):
        d = self.body(script=script("я" * 2490), description_suffix=self.SUFFIX)["snippet"]["description"]
        self.assertLessEqual(len(d.encode("utf-8")), youtube_uploader.MAX_DESCRIPTION)
        self.assertNotIn("WATCH NEXT", d)

    def test_watch_next_is_kept_when_it_fits_in_bytes(self):
        d = self.body(ai_disclosure=LABELLED, script=script("a" * 1000), description_suffix=self.SUFFIX)[
            "snippet"]["description"]
        self.assertTrue(d.startswith("a" * 1000))
        self.assertIn(ad.STANDARD_LINES["en"], d)
        self.assertTrue(d.endswith(self.SUFFIX))
        self.assertLess(d.index(ad.STANDARD_LINES["en"]), d.index("WATCH NEXT"))

    def test_ascii_window_at_the_limit(self):
        # Every size around the edge: the result never exceeds 5000 bytes, and the line (when it fits) is kept.
        line = ad.STANDARD_LINES["en"]
        for room in range(-3, 4):
            base = "x" * (youtube_uploader.MAX_DESCRIPTION - len(line) - 2 - len(self.SUFFIX) - 2 + room)
            d = self.body(ai_disclosure=LABELLED, script=script(base), description_suffix=self.SUFFIX)[
                "snippet"]["description"]
            self.assertLessEqual(len(d.encode("utf-8")), youtube_uploader.MAX_DESCRIPTION, room)
            self.assertIn(line, d, room)

    def test_a_line_that_does_not_fit_is_dropped_but_the_flag_is_kept(self):
        body = self.body(ai_disclosure=LABELLED, script=script("x" * youtube_uploader.MAX_DESCRIPTION))
        self.assertEqual(body["snippet"]["description"], "x" * youtube_uploader.MAX_DESCRIPTION)
        self.assertTrue(body["status"]["containsSyntheticMedia"])

    def test_the_limit_is_in_bytes_for_cyrillic_text(self):
        ru = ad.decide("always", ad.Signals(), language="russian")
        long_ru = "я" * 2490  # 4980 bytes: the line (well over 20 bytes) cannot fit
        body = self.body(ai_disclosure=ru, script=script(long_ru))
        self.assertEqual(body["snippet"]["description"], long_ru)
        self.assertTrue(body["status"]["containsSyntheticMedia"])

    def test_russian_and_uzbek_channels_get_their_own_wording(self):
        for language, code in (("russian", "ru"), ("uzbek", "uz")):
            dec = ad.decide("always", ad.Signals(), language=language)
            self.assertTrue(self.body(ai_disclosure=dec)["snippet"]["description"].endswith(ad.STANDARD_LINES[code]))

    def test_a_channels_own_wording_replaces_the_standard_one(self):
        dec = ad.decide("always", ad.Signals(), custom_text="Made with AI tools.")
        self.assertTrue(self.body(ai_disclosure=dec)["snippet"]["description"].endswith("Made with AI tools."))

    def test_line_switched_off_still_sends_the_flag(self):
        dec = ad.decide("always", ad.Signals(), line_enabled=False)
        body = self.body(ai_disclosure=dec)
        self.assertEqual(body["snippet"]["description"], "A ship.")
        self.assertTrue(body["status"]["containsSyntheticMedia"])

    def test_a_short_is_labelled_like_its_long_video(self):
        body = self.body(ai_disclosure=LABELLED, description_override="Full video: https://youtu.be/x")
        self.assertTrue(body["status"]["containsSyntheticMedia"])
        self.assertTrue(body["snippet"]["description"].startswith("Full video: https://youtu.be/x"))
        self.assertIn(ad.STANDARD_LINES["en"], body["snippet"]["description"])


class PipelineWiring(unittest.TestCase):
    """main.py cannot be imported without the render stack, so the wiring is pinned at the source: both uploads
    (the long video and its Short) must carry the decision, and the label is recorded as an event after upload."""

    SRC = (Path(__file__).resolve().parent.parent / "main.py").read_text(encoding="utf-8")

    def test_the_long_video_and_its_short_both_pass_the_decision(self):
        self.assertEqual(self.SRC.count("ai_disclosure=ai_decision,"), 2)  # long upload + the Short's upload
        self.assertIn("ai_decision=ai_decision,", self.SRC)

    def test_the_decision_is_recorded_after_a_successful_upload(self):
        i = self.SRC.rindex("events.emit(ai_disclosure.EVENT")
        self.assertGreater(i, self.SRC.index("events.VIDEO_PUBLISHED"))

    def test_the_short_gets_its_own_record_under_its_own_video_id(self):
        # An Instagram / TikTok post of a Short reads the Short's record; without one it would read "unknown".
        i = self.SRC.index("events.emit(ai_disclosure.EVENT")
        short = self.SRC[i:i + 400]
        self.assertIn('video_id=uploaded["id"]', short)
        self.assertGreater(i, self.SRC.index("events.SHORT_COMPLETED"))
        self.assertLess(i, self.SRC.index("def slugify"))
        self.assertIn("ai_signals=ai_signals,", self.SRC)


if __name__ == "__main__":
    unittest.main()
