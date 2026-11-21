"""The default narration provider follows the ElevenLabs key: ElevenLabs when
one is configured (the better voice, a real retention lever), edge otherwise —
because elevenlabs without a key would fail verify_voice, which never falls back
(a wrong voice is worse than no video). An explicit TTS_PROVIDER always wins."""

import importlib
import os
import unittest
from unittest.mock import patch


def _reload_config():
    import config
    return importlib.reload(config)


class TtsDefaultTestCase(unittest.TestCase):
    def test_defaults_to_elevenlabs_when_key_present(self):
        with patch.dict(os.environ, {"ELEVENLABS_API_KEY": "abc"}, clear=False):
            os.environ.pop("TTS_PROVIDER", None)
            cfg = _reload_config()
            self.assertEqual(cfg.TTS_PROVIDER, "elevenlabs")

    def test_defaults_to_edge_without_key(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ELEVENLABS_API_KEY", None)
            os.environ.pop("TTS_PROVIDER", None)
            cfg = _reload_config()
            self.assertEqual(cfg.TTS_PROVIDER, "edge")

    def test_explicit_provider_wins_over_key(self):
        with patch.dict(os.environ, {"ELEVENLABS_API_KEY": "abc", "TTS_PROVIDER": "edge"}, clear=False):
            cfg = _reload_config()
            self.assertEqual(cfg.TTS_PROVIDER, "edge")  # a channel can choose edge on purpose

    def tearDown(self):
        # Leave the imported config back at the ambient environment's values.
        _reload_config()


if __name__ == "__main__":
    unittest.main()
