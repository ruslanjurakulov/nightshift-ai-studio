"""An upload must always tell YouTube its privacy, and only one of the three words.

YouTube's 2026-11-02 revision: unverified API projects are no longer locked to
private, and an upload with no ``status.privacyStatus`` defaults to PUBLIC. The
explicit field is now the only thing between a misconfigured run and a public
video (CLAUDE.md rule 2), so these pin that it is always sent and that anything
but private/unlisted/public stops the upload before a byte is sent.
"""
import json
import subprocess
import sys
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



class RunRefusesBeforeAnythingIsPaid(unittest.TestCase):
    """main.run() checks the privacy right after the auto-publish clamp, before any stage spends.

    The reachable route: a channel whose auto-publish switch is ON passes the request through the clamp, and the
    made-for-kids hold only rewrites public/unlisted, so junk arrived at the upload after research, script, voice and
    render were paid for. Runs in a child interpreter for the reason tests/test_auto_publish_never_public.py gives.
    """

    _CHILD = """
import json, os, sys, tempfile
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import main
from modules.channels import ChannelContext
ctx = ChannelContext.from_dict(json.loads(sys.argv[2]))
reached = []
os.chdir(tempfile.mkdtemp())
out = {}
with patch.object(main, "resolve_channel", return_value=ctx), \\
        patch.object(main, "verify_voice", side_effect=lambda *a, **k: reached.append("voice")):
    try:
        main.run(privacy=sys.argv[3], channel=ctx.channel_id)
        out["raised"] = None
    except Exception as e:
        out["raised"], out["message"] = type(e).__name__, str(e)
out["reached"] = reached
print("RESULT " + json.dumps(out))
"""

    def drive(self, privacy, auto_publish=True):
        from pathlib import Path
        root = str(Path(__file__).resolve().parent.parent)
        row = {"channel_id": "news", "name": "news", "niche": "tech", "status": "ACTIVE",
               "agent_config": {"language": "English"},
               "credential_ref": {"youtube_channel_id": "UCnews", "verified_at": "2026-09-01T00:00:00Z"},
               "auto_publish": auto_publish}
        proc = subprocess.run([sys.executable, "-I", "-c", self._CHILD, root, json.dumps(row), privacy],
                              capture_output=True, text=True, timeout=300, cwd=tempfile.gettempdir())
        line = next((l for l in proc.stdout.splitlines() if l.startswith("RESULT ")), None)
        self.assertIsNotNone(line, proc.stderr[-2000:])
        return json.loads(line[len("RESULT "):])

    def test_switch_on_and_junk_privacy_stops_before_the_first_stage(self):
        for bad in ("hidden", "Private", "privat"):
            out = self.drive(bad)
            self.assertEqual(out["raised"], "InvalidPrivacy", (bad, out))
            self.assertIn("the run did not start", out["message"])
            self.assertEqual(out["reached"], [], bad)

    def test_switch_off_clamps_junk_to_private_and_does_not_refuse(self):
        # Off means "never public": the clamp turns anything into private, which is valid, so the privacy check
        # is not what stops this run (whatever later stage does, it is not InvalidPrivacy).
        out = self.drive("hidden", auto_publish=False)
        self.assertNotEqual(out["raised"], "InvalidPrivacy", out)


if __name__ == "__main__":
    unittest.main()
