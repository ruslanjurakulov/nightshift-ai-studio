"""tools/audit_voices.py names expiring and re-routed voices, and only names them.

A Default voice stops working on 2026-12-31, and a channel narrated by one will
then stop at preflight. A Legacy voice is already read by someone else, and the
API says nothing about it. The audit has to find both, flag nothing it cannot
match, and never print anything but names and ids.
"""

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tools import audit_voices as av

ROOT = Path(__file__).resolve().parent.parent

FIXTURE_VOICES = [
    {"id": "nPczCjzI2devNBz1zQrb", "name": "Brian", "style": "deep"},        # Default
    {"id": "21m00Tcm4TlvDq8ikWAM", "name": "Rachel", "style": "calm"},       # Legacy, by name
    {"id": "pNInz6obpgDQGcFmaJgB", "name": "Adam", "style": "deep"},         # neither
]


def ch(cid, narrator, quote="narrator", language="English", provider="elevenlabs"):
    return SimpleNamespace(channel_id=cid, status="ACTIVE", agent=SimpleNamespace(
        elevenlabs_voice_id=narrator, elevenlabs_secondary_voice_id=quote, language=language, tts_provider=provider))


class Flags(unittest.TestCase):
    def test_default_legacy_and_other_are_told_apart(self):
        rows = av.collect(FIXTURE_VOICES, "pNInz6obpgDQGcFmaJgB",
                          [ch("uz-news", "JBFqnCBsd6RMkjVDRZzb", quote="XB0fDUnXU5powFXDhCwa"),
                           ch("custom", "AbCdEfGhIjKlMnOpQrSt")])
        by = {(r["source"], r["id"]): r for r in rows}
        self.assertEqual(by[("lib/voices.json", "nPczCjzI2devNBz1zQrb")]["flag"], "default")
        self.assertIn("2026-12-31", by[("lib/voices.json", "nPczCjzI2devNBz1zQrb")]["note"])
        self.assertIn("Sawyer", by[("lib/voices.json", "nPczCjzI2devNBz1zQrb")]["note"])
        self.assertEqual(by[("lib/voices.json", "21m00Tcm4TlvDq8ikWAM")]["flag"], "legacy")
        self.assertEqual(by[("lib/voices.json", "pNInz6obpgDQGcFmaJgB")]["flag"], "other")
        self.assertEqual(by[("config.ELEVENLABS_VOICE_ID", "pNInz6obpgDQGcFmaJgB")]["flag"], "other")
        # A channel's saved Default voice is found by id, with its name from the table.
        george = by[("channel uz-news narrator", "JBFqnCBsd6RMkjVDRZzb")]
        self.assertEqual((george["flag"], george["name"]), ("default", "George"))
        # An unnamed id cannot be matched against a names-only page, and says so.
        custom = by[("channel custom narrator", "AbCdEfGhIjKlMnOpQrSt")]
        self.assertEqual(custom["flag"], "other")
        self.assertIn("names only", custom["note"])

    def test_a_quote_voice_of_narrator_is_not_a_voice_id(self):
        rows = av.collect([], "", [ch("a", "", quote="narrator")])
        self.assertEqual(rows, [])

    def test_the_repository_catalogue_has_13_default_and_2_legacy_voices(self):
        """The count the PR reports; if voices.json changes, this says what the audit now finds."""
        voices = json.loads((ROOT / "command-center/lib/voices.json").read_text(encoding="utf-8"))
        flags = [r["flag"] for r in av.collect(voices, "", [])]
        self.assertEqual((flags.count("default"), flags.count("legacy"), len(flags)), (13, 2, 16))

    def test_every_default_id_is_a_voice_id_and_every_suggestion_too(self):
        for vid, (_, _, new_id) in av.DEFAULT_VOICES.items():
            self.assertRegex(vid, r"^[A-Za-z0-9]{20}$")
            self.assertRegex(new_id, r"^[A-Za-z0-9]{20}$")


class LanguageGate(unittest.TestCase):
    def test_it_lists_the_uzbek_elevenlabs_channels_that_now_stop(self):
        channels = [ch("uz", "x", language="Uzbek"), ch("ru", "x", language="Russian"),
                    ch("uz-edge", "x", language="Uzbek", provider="edge")]
        stops = av.language_gate(channels, "eleven_multilingual_v2")
        self.assertEqual([s["channel"] for s in stops], ["uz"])
        self.assertEqual(av.language_gate(channels, "eleven_v3"), [])


class ReadOnlyAndKeyless(unittest.TestCase):
    def test_the_report_prints_no_key_and_runs_from_a_file(self):
        secret = "sk_live_should_never_print_0123456789"
        rows = {"channels": [{"channel_id": "default", "name": "N", "niche": "n", "status": "ACTIVE",
                              "agent_config": {"language": "Uzbek", "tts_provider": "elevenlabs",
                                               "elevenlabs_voice_id": "XrExE9yKIg1WjnnlVkGX"}}]}
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "channels.json"
            path.write_text(json.dumps(rows), encoding="utf-8")
            out = io.StringIO()
            with patch.dict("os.environ", {"ELEVENLABS_API_KEY": secret, "SUPABASE_URL": "", "SUPABASE_SERVICE_KEY": ""}), \
                    patch("requests.get") as get, patch("requests.post") as post, contextlib.redirect_stdout(out):
                self.assertEqual(av.main(["--channels-file", str(path), "--json"]), 0)
            get.assert_not_called()
            post.assert_not_called()
        printed = out.getvalue()
        self.assertNotIn(secret, printed)
        report = json.loads(printed)
        matilda = [r for r in report["voices"] if r["source"] == "channel default narrator"]
        self.assertEqual(matilda[0]["flag"], "default")


if __name__ == "__main__":
    unittest.main()
