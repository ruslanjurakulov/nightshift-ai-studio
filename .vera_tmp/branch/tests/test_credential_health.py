"""The credential preflight tells the truth about a run's keys before it spends:
a missing REQUIRED key blocks the run, a missing publish token blocks only the
upload (not the render), an ElevenLabs key is required only when the run uses it,
and nothing here ever prints a secret or makes a network call."""

import unittest
from unittest.mock import patch

from modules import credential_health as ch
from modules.credential_health import CredentialCheck, HealthReport, check_run_credentials


class _FakeAgent:
    def __init__(self, tts_provider="edge"):
        self.tts_provider = tts_provider


class _FakeChannel:
    def __init__(self, channel_id="default", tts_provider="edge"):
        self.channel_id = channel_id
        self.agent = _FakeAgent(tts_provider)


def _config(gemini="g", pexels="p", eleven="", tts="edge"):
    cfg = type("cfg", (), {})()
    cfg.GEMINI_API_KEY = gemini
    cfg.PEXELS_API_KEY = pexels
    cfg.ELEVENLABS_API_KEY = eleven
    cfg.TTS_PROVIDER = tts
    return cfg


class ReportShapeTestCase(unittest.TestCase):
    def test_report_ok_ignores_publish_token(self):
        report = HealthReport("default", (
            CredentialCheck("gemini", "ok", required=True),
            CredentialCheck("youtube_token", "missing", required_for_publish=True),
        ))
        # A missing publish token does NOT make the report not-ok: the run can
        # still render and be held for review.
        self.assertTrue(report.ok)
        self.assertEqual([c.name for c in report.publish_blocking], ["youtube_token"])
        self.assertEqual(report.blocking, [])

    def test_missing_required_blocks(self):
        report = HealthReport("default", (CredentialCheck("gemini", "missing", required=True),))
        self.assertFalse(report.ok)
        self.assertEqual([c.name for c in report.blocking], ["gemini"])


class CheckRunCredentialsTestCase(unittest.TestCase):
    def _run(self, cfg, channel):
        # credential_status is imported lazily inside _youtube_check; patch it to
        # avoid touching real token files.
        with patch.dict("sys.modules"), \
             patch("config.GEMINI_API_KEY", cfg.GEMINI_API_KEY, create=True), \
             patch("config.PEXELS_API_KEY", cfg.PEXELS_API_KEY, create=True), \
             patch("config.ELEVENLABS_API_KEY", cfg.ELEVENLABS_API_KEY, create=True), \
             patch("config.TTS_PROVIDER", cfg.TTS_PROVIDER, create=True), \
             patch("modules.channel_credentials.credential_status",
                   return_value=type("s", (), {"is_connected": False, "detail": "no token"})()):
            return check_run_credentials(channel)

    def test_all_present_edge_is_ok(self):
        report = self._run(_config(), _FakeChannel(tts_provider="edge"))
        self.assertTrue(report.ok)  # gemini+pexels present; edge needs no key
        names = {c.name for c in report.checks}
        self.assertIn("gemini", names)
        self.assertIn("pexels", names)
        self.assertNotIn("elevenlabs", names)  # not flagged for an edge run

    def test_missing_gemini_blocks(self):
        report = self._run(_config(gemini=""), _FakeChannel())
        self.assertFalse(report.ok)
        self.assertIn("gemini", [c.name for c in report.blocking])

    def test_elevenlabs_required_only_when_used(self):
        # Channel narrates with ElevenLabs but no key → blocking.
        report = self._run(_config(eleven=""), _FakeChannel(tts_provider="elevenlabs"))
        self.assertIn("elevenlabs", [c.name for c in report.blocking])
        # With the key present it passes.
        ok = self._run(_config(eleven="k"), _FakeChannel(tts_provider="elevenlabs"))
        self.assertTrue(ok.ok)

    def test_missing_youtube_token_blocks_publish_not_run(self):
        report = self._run(_config(), _FakeChannel())
        self.assertTrue(report.ok)  # run can proceed
        self.assertIn("youtube_token", [c.name for c in report.publish_blocking])

    def test_never_raises_on_bad_channel(self):
        # A channel object that throws on attribute access must not crash the check.
        class Bad:
            @property
            def channel_id(self):
                raise RuntimeError("boom")
        report = self._run(_config(), Bad())
        self.assertIsInstance(report, HealthReport)

    def test_report_dict_has_no_secret(self):
        report = self._run(_config(gemini="supersecret"), _FakeChannel())
        blob = str(report.to_dict())
        self.assertNotIn("supersecret", blob)  # only presence, never the value


if __name__ == "__main__":
    unittest.main()
