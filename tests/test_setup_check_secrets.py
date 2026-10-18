"""D14: tools/setup_check.py prints 'set' / 'missing' for secrets - never a
prefix and never a length (CLAUDE.md non-negotiable #1)."""

import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tools import setup_check

GEMINI = "AIzaPREFIXsentinel0123456789abcdefgh"
PEXELS = "pexelsSENTINELvalue0123456789abcdef"
TOKEN_JSON = '{"refresh_token": "1//SECRETtokenSENTINEL0123456789"}'


def run_print_secrets(reveal=False):
    buf = io.StringIO()
    with tempfile.TemporaryDirectory() as t:
        (Path(t) / "youtube_token.json").write_text(TOKEN_JSON)
        env = {"GEMINI_API_KEY": GEMINI, "PEXELS_API_KEY": PEXELS}
        with mock.patch.object(setup_check, "ROOT", Path(t)), mock.patch.dict(os.environ, env, clear=False), \
                contextlib.redirect_stdout(buf):
            os.environ.pop("YOUTUBE_CHANNEL_ID", None)
            setup_check.print_secrets(reveal)
    return buf.getvalue()


class SetupCheckSecrets(unittest.TestCase):
    def test_default_output_has_only_set_or_missing(self):
        out = run_print_secrets()
        self.assertIn("GEMINI_API_KEY\n  set", out)
        self.assertIn("PEXELS_API_KEY\n  set", out)
        self.assertIn("YOUTUBE_CHANNEL_ID\n  missing", out)
        self.assertIn("YOUTUBE_CLIENT_SECRET_JSON\n  missing", out)
        self.assertIn("YOUTUBE_TOKEN_JSON\n  set", out)

    def test_no_prefix_no_length_no_value(self):
        out = run_print_secrets()
        for secret in (GEMINI, PEXELS, TOKEN_JSON):
            self.assertNotIn(secret[:6], out)
            self.assertNotIn(secret[:3] + "...", out)
            self.assertNotIn(str(len(secret)), out)
        self.assertNotIn("chars", out)
        self.assertNotIn("starts", out)

    def test_reveal_is_still_the_explicit_opt_in_for_pasting(self):
        out = run_print_secrets(reveal=True)
        self.assertIn(GEMINI, out)


if __name__ == "__main__":
    unittest.main()
