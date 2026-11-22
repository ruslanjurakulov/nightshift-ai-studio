"""A retired ElevenLabs Default voice stops a run with our remedy, never with another voice.

ElevenLabs Default voices are "no longer accessible after" 31 Dec 2026. Without
this, a channel narrated by one dies on 1 January at the voice check with a bare
vendor 404, after the run was set up, and a film narration dies at the vendor.
These tests pin that both stop earlier with the voice named, the remedy named and
nothing substituted, that the run warns while there is still time, and that the
Command Center offers what the run accepts.
"""

import logging
import re
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import MagicMock, patch

from modules import voice_retirement as vr
from modules.audio_mixer import VoiceUnavailable, verify_voice

ROOT = Path(__file__).resolve().parent.parent
GEORGE = "JBFqnCBsd6RMkjVDRZzb"   # a Default voice; ElevenLabs suggests Eldrin
ADAM = "pNInz6obpgDQGcFmaJgB"     # not a Default voice
AFTER = date(2027, 1, 1)
BEFORE = date(2026, 12, 30)


def channel(narrator=ADAM, secondary="narrator"):
    ctx = MagicMock()
    ctx.agent.tts_provider = "elevenlabs"
    ctx.agent.language = "English"
    ctx.agent.elevenlabs_voice_id = narrator
    ctx.agent.elevenlabs_secondary_voice_id = secondary
    return ctx


class TheTable(unittest.TestCase):
    def test_the_last_day_still_works_and_the_next_does_not(self):
        """'No longer accessible after' 31 Dec: refusing on the 31st would stop a run that would work."""
        self.assertIsNone(vr.refusal(GEORGE, date(2026, 12, 31)))
        self.assertIsNotNone(vr.refusal(GEORGE, AFTER))
        self.assertEqual(vr.retired_on(GEORGE), AFTER)
        self.assertEqual(vr.days_left(GEORGE, date(2026, 12, 31)), 1)
        self.assertEqual(vr.days_left(GEORGE, BEFORE), 2)
        self.assertEqual(vr.days_left(GEORGE, date(2027, 3, 1)), 0)

    def test_an_unknown_id_is_unaffected(self):
        for vid in (ADAM, "", None, "narrator", "16516516145"):
            self.assertIsNone(vr.retired_on(vid), vid)
            self.assertIsNone(vr.refusal(vid, AFTER), vid)
            self.assertIsNone(vr.days_left(vid, BEFORE), vid)

    def test_the_refusal_names_the_voice_the_date_the_list_and_substitutes_nothing(self):
        msg = vr.refusal(GEORGE, AFTER)
        for part in ("George", GEORGE, "Default voice", "31 Dec 2026", "account's own list",
                     "Agents → Voice", "No voice is substituted"):
            self.assertIn(part, msg)
        # The suggestion is a name to listen to. Its id is not offered: copying it into a channel
        # would be typing a voice id, which CLAUDE.md forbids.
        self.assertIn("Eldrin - Crisp British Baritone", msg)
        self.assertNotIn(vr.DEFAULT_VOICES[GEORGE][2], msg)

    def test_the_audit_reads_the_same_table(self):
        from tools import audit_voices as av
        self.assertIs(av.DEFAULT_VOICES, vr.DEFAULT_VOICES)
        self.assertEqual(av.DEFAULT_EXPIRES, vr.DEFAULT_EXPIRES)

    def test_the_command_center_copy_equals_the_python_table(self):
        """A picker that offers a voice the run refuses makes a person wait for a refusal."""
        ts = (ROOT / "command-center/lib/voiceRetirement.ts").read_text(encoding="utf-8")
        block = re.search(r"DEFAULT_VOICES[^=]*=\s*\{(.*?)\n\};", ts, re.S)
        self.assertIsNotNone(block, "DEFAULT_VOICES not found in voiceRetirement.ts")
        rows = re.findall(r'^\s*([A-Za-z0-9]{20}):\s*\{\s*name:\s*"([^"]+)",\s*suggested:\s*"([^"]+)",'
                          r'\s*suggestedId:\s*"([A-Za-z0-9]{20})"\s*\},', block.group(1), re.M)
        self.assertEqual({vid: (name, sug, sid) for vid, name, sug, sid in rows}, vr.DEFAULT_VOICES)
        self.assertIn(f'DEFAULT_EXPIRES = "{vr.DEFAULT_EXPIRES}"', ts)
        self.assertIn(vr.DEFAULT_VOICES_URL, ts)


@patch("modules.audio_mixer.ELEVENLABS_MODEL_ID", "eleven_multilingual_v2")
@patch("modules.audio_mixer.ELEVENLABS_RUN_VOICE_ID", "")
@patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
class ThePreflight(unittest.TestCase):
    @patch("modules.audio_mixer.requests.get")
    def test_a_retired_narrator_stops_the_run_before_any_request(self, get):
        with self.assertRaises(VoiceUnavailable) as caught:
            verify_voice(channel(narrator=GEORGE), today=AFTER)
        msg = str(caught.exception)
        self.assertIn("narrator", msg)
        self.assertIn("No voice is substituted", msg)
        get.assert_not_called()

    @patch("modules.audio_mixer.requests.get")
    def test_a_retired_quote_voice_stops_it_too(self, get):
        with self.assertRaises(VoiceUnavailable) as caught:
            verify_voice(channel(secondary=GEORGE), today=AFTER)
        self.assertIn("quote voice", str(caught.exception))
        get.assert_not_called()

    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "")
    @patch("modules.audio_mixer.requests.get")
    def test_the_retirement_is_named_before_a_missing_key(self, get):
        """Adding the key would not bring George back; the first fix named must be the one that works."""
        with self.assertRaises(VoiceUnavailable) as caught:
            verify_voice(channel(narrator=GEORGE), today=AFTER)
        self.assertIn("Default voice", str(caught.exception))

    @patch("modules.audio_mixer.requests.get")
    def test_before_the_date_it_runs_in_the_same_voice_and_warns_with_the_days_left(self, get):
        get.return_value = MagicMock(status_code=200, json=lambda: {"voice_id": GEORGE,
                                                                  "subscription": {}})
        with patch("modules.audio_mixer._verify_characters_left"), \
                self.assertLogs("modules.audio_mixer", level=logging.WARNING) as logs:
            verify_voice(channel(narrator=GEORGE), today=BEFORE)
        warned = [r for r in logs.output if "Default voice" in r]
        self.assertEqual(len(warned), 1, logs.output)
        self.assertIn("2 day(s) left", warned[0])
        # The voice asked about is the channel's own, not a replacement.
        self.assertIn(GEORGE, get.call_args.args[0])

    @patch("modules.audio_mixer.requests.get")
    def test_an_unaffected_voice_neither_warns_nor_stops(self, get):
        get.return_value = MagicMock(status_code=200, json=lambda: {"voice_id": ADAM})
        with patch("modules.audio_mixer._verify_characters_left"), \
                patch("modules.audio_mixer.logger") as log:
            verify_voice(channel(), today=AFTER)
        self.assertFalse(any("Default voice" in str(c) for c in log.warning.call_args_list))


class TheFilmNarrationAdapter(unittest.TestCase):
    def setUp(self):
        from modules import model_registry as reg
        from modules.capabilities import build_adapter

        class NoHttp:
            """Any request at all fails the test: the refusal must come before the vendor."""
            def request(self, *a, **k):
                raise AssertionError("the vendor was called")
            get = post = request

        self.entry = reg.load()["elevenlabs-v3"]
        self.adapter = build_adapter("audio.elevenlabs_tts", env={"ELEVENLABS_API_KEY": "k"}, session=NoHttp())

    def request(self, voice):
        from modules.capabilities.base import CapabilityRequest
        return CapabilityRequest("tts", "Hello", voice_id=voice, text_language="en")

    def test_problems_names_the_retirement_before_the_vendor_call(self):
        with patch("modules.voice_retirement.utc_today", return_value=AFTER):
            problems = self.adapter.problems(self.request(GEORGE), self.entry)
        self.assertTrue(any("No voice is substituted" in p for p in problems), problems)

    def test_submit_refuses_as_a_bad_request_without_calling_the_vendor(self):
        from modules.capabilities.base import E_BAD_REQUEST, AdapterError
        with patch("modules.voice_retirement.utc_today", return_value=AFTER), \
                self.assertRaises(AdapterError) as caught:
            self.adapter.submit(self.request(GEORGE), "eleven_v3")
        self.assertEqual(caught.exception.code, E_BAD_REQUEST)
        self.assertIn("George", str(caught.exception))

    def test_the_film_worker_reads_it_as_voice_not_found_not_as_edit_the_scene(self):
        """film_error_code maps a plain bad_request to "edit the scene"; a retired voice is the person's voice to
        change, so the refusal carries ElevenLabs' closed code for a voice that is gone."""
        from types import SimpleNamespace
        from modules import creative_worker as cw
        from modules.capabilities.base import AdapterError
        from modules.film_orchestrator import _vendor_code, film_error_code
        with patch("modules.voice_retirement.utc_today", return_value=AFTER), \
                self.assertRaises(AdapterError) as caught:
            self.adapter.submit(self.request(GEORGE), "eleven_v3")
        e = caught.exception
        self.assertTrue(e.not_accepted)
        wrapped = SimpleNamespace(adapter=self.adapter)  # the worker's view: a creative adapter around this one
        self.assertEqual(film_error_code(cw.error_code_of(e), vendor_code=_vendor_code(wrapped),
                                         http_status=getattr(e, "http_status", None), capability="tts"),
                         "voice_not_found")

    def test_before_the_date_the_adapter_does_not_refuse_it(self):
        with patch("modules.voice_retirement.utc_today", return_value=BEFORE):
            problems = self.adapter.problems(self.request(GEORGE), self.entry)
        self.assertFalse(any("Default voice" in p for p in problems), problems)


class TheVoiceChanger(unittest.TestCase):
    """The voice changer speaks in the chosen voice too; a retired one is refused the same way, before the upload."""

    def setUp(self):
        import tempfile
        from modules import model_registry as reg
        from modules.capabilities import build_adapter

        class NoHttp:
            def request(self, *a, **k):
                raise AssertionError("the vendor was called")
            get = post = request

        self.entry = reg.load()["elevenlabs-voice-changer"]
        self.adapter = build_adapter("audio.elevenlabs_sts", env={"ELEVENLABS_API_KEY": "k"}, session=NoHttp())
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.source = Path(self.dir.name) / "source.mp3"
        self.source.write_bytes(b"ID3fake")

    def request(self, voice):
        from modules.capabilities.base import CapabilityRequest
        return CapabilityRequest("voice_change", "", voice_id=voice, input_media=[str(self.source)])

    def test_problems_and_submit_refuse_a_retired_voice_without_calling_the_vendor(self):
        from modules.capabilities.base import E_BAD_REQUEST, AdapterError
        with patch("modules.voice_retirement.utc_today", return_value=AFTER):
            problems = self.adapter.problems(self.request(GEORGE), self.entry)
            self.assertTrue(any("No voice is substituted" in p for p in problems), problems)
            with self.assertRaises(AdapterError) as caught:
                self.adapter.submit(self.request(GEORGE), "eleven_multilingual_sts_v2")
        self.assertEqual(caught.exception.code, E_BAD_REQUEST)
        self.assertEqual(self.adapter.last_vendor_code, "voice_not_found")

    def test_before_the_date_it_is_not_refused(self):
        with patch("modules.voice_retirement.utc_today", return_value=BEFORE):
            problems = self.adapter.problems(self.request(GEORGE), self.entry)
        self.assertFalse(any("Default voice" in p for p in problems), problems)


class SynthesisWithoutPreflight(unittest.TestCase):
    def test_scene_repair_refuses_a_retired_voice_before_the_sdk(self):
        """Scene repair builds a mixer without verify_voice; it must not reach the vendor's 404 either."""
        import sys
        import tempfile
        from modules import audio_mixer
        with tempfile.TemporaryDirectory() as d, patch.object(audio_mixer, "OUTPUT_DIR", Path(d)):
            m = audio_mixer.AudioMixer("t", channel=channel(narrator=GEORGE))
        m.elevenlabs_model = "eleven_v3"
        sdk = MagicMock()
        with patch.dict(sys.modules, {"elevenlabs": sdk}), tempfile.TemporaryDirectory() as d, \
                patch("modules.voice_retirement.utc_today", return_value=AFTER):
            with self.assertRaises(VoiceUnavailable):
                m._tts_elevenlabs("Hello", GEORGE, Path(d) / "seg.mp3")
        sdk.ElevenLabs.assert_not_called()


if __name__ == "__main__":
    unittest.main()
