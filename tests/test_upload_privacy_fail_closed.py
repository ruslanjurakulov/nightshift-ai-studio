"""An upload must always tell YouTube its privacy, and only one of the three words.

YouTube's 2026-11-02 revision: unverified API projects are no longer locked to
private, and an upload with no ``status.privacyStatus`` defaults to PUBLIC. The
explicit field is now the only thing between a misconfigured run and a public
video (CLAUDE.md rule 2), so these pin that it is always sent and that anything
but private/unlisted/public stops the upload before a byte is sent.
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import made_for_kids as mfk
from modules import youtube_uploader as yu
from tests.test_made_for_kids import channel
from tests import test_youtube_uploader as tyu

PLAIN = mfk.decide(channel())


class UploadPrivacyFailsClosed(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.video = Path(tmp.name) / "video.mp4"
        self.video.write_bytes(b"not really an mp4")
        self.sent = []

    def upload(self, privacy, default="private"):
        up = tyu.uploader(service=tyu.UploadWiringTestCase()._service(self.sent))
        with mock.patch.object(yu, "YOUTUBE_PRIVACY", default):
            return up.upload(self.video, tyu.script("A ship."), privacy=privacy, made_for_kids=PLAIN)

    def test_every_valid_privacy_is_sent_explicitly(self):
        for privacy in ("private", "unlisted", "public"):
            self.sent.clear()
            self.upload(privacy)
            self.assertEqual(self.sent[-1]["body"]["status"]["privacyStatus"], privacy)

    def test_no_privacy_given_sends_the_private_default_explicitly(self):
        self.upload(None)
        self.assertEqual(self.sent[-1]["body"]["status"]["privacyStatus"], "private")

    def test_an_empty_YOUTUBE_PRIVACY_uploads_nothing_rather_than_omit_the_field(self):
        # An env var that is set but empty: argparse never validates a default, so "" reaches here.
        with self.assertRaises(yu.InvalidPrivacy):
            self.upload(None, default="")
        self.assertEqual(self.sent, [])

    def test_a_typo_or_odd_case_uploads_nothing(self):
        for bad in ("Private", "privat", " private", "PUBLIC", "hidden", "none"):
            self.sent.clear()
            with self.assertRaises(yu.InvalidPrivacy, msg=bad):
                self.upload(bad)
            self.assertEqual(self.sent, [], bad)

    def test_the_refusal_names_the_fix(self):
        with self.assertRaises(yu.InvalidPrivacy) as cm:
            self.upload("hidden")
        self.assertIn("YOUTUBE_PRIVACY", str(cm.exception))
        self.assertIn("nothing was uploaded", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
