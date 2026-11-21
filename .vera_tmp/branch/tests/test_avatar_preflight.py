"""D4: a presenter that was asked for is never quietly dropped for a faceless cut."""

import ast
import os
import unittest
from pathlib import Path
from unittest import mock

from modules import avatar
from modules.avatar import AvatarConfig, AvatarUnavailable, UnsafeAvatarRequest, preflight_avatar

ROOT = Path(__file__).resolve().parent.parent
NO_CREDS = {"HIGGSFIELD_API_KEY_ID": "", "HIGGSFIELD_API_KEY_SECRET": ""}
CREDS = {"HIGGSFIELD_API_KEY_ID": "id-x", "HIGGSFIELD_API_KEY_SECRET": "secret-x"}


class Preflight(unittest.TestCase):
    def test_off_is_a_no_op_even_without_credentials(self):
        with mock.patch.dict(os.environ, NO_CREDS):
            preflight_avatar(AvatarConfig(enabled=False))

    def test_requested_without_credentials_raises_before_anything_is_spent(self):
        with mock.patch.dict(os.environ, NO_CREDS), mock.patch("requests.post") as post:
            with self.assertRaises(AvatarUnavailable) as caught:
                preflight_avatar(AvatarConfig(enabled=True, character_prompt="a friendly fox"))
        self.assertIn("HIGGSFIELD_API_KEY_ID", str(caught.exception))
        post.assert_not_called()

    def test_an_unknown_provider_raises(self):
        with self.assertRaises(AvatarUnavailable):
            preflight_avatar(AvatarConfig(enabled=True, provider="nope"))

    def test_a_real_person_reference_raises(self):
        with mock.patch.dict(os.environ, CREDS):
            with self.assertRaises(UnsafeAvatarRequest):
                preflight_avatar(AvatarConfig(enabled=True, character_prompt="a deepfake of a politician"))

    def test_a_configured_synthetic_presenter_passes(self):
        with mock.patch.dict(os.environ, CREDS):
            preflight_avatar(AvatarConfig(enabled=True, character_prompt="a friendly fox"))

    def test_generate_still_refuses_without_credentials(self):
        with mock.patch.dict(os.environ, NO_CREDS):
            with self.assertRaises(AvatarUnavailable):
                avatar.maybe_generate_presenter(AvatarConfig(enabled=True), "a fox", Path("/tmp/p.mp4"))


class MainDoesNotGoFaceless(unittest.TestCase):
    """main.py imports the whole render stack, so this reads its source: the
    handler around maybe_generate_presenter must re-raise, not carry on."""

    def test_the_presenter_failure_handler_re_raises(self):
        tree = ast.parse((ROOT / "main.py").read_text())
        handlers = [h for n in ast.walk(tree) if isinstance(n, ast.Try)
                    if any(isinstance(c, ast.Name) and c.id == "maybe_generate_presenter"
                           for b in n.body for c in ast.walk(b))
                    for h in n.handlers]
        self.assertTrue(handlers, "the presenter try/except moved; update this test")
        for h in handlers:
            self.assertTrue(any(isinstance(x, ast.Raise) for x in ast.walk(h)),
                            "a presenter that was asked for must stop the run, not render faceless")

    def test_main_runs_the_presenter_preflight_at_the_start(self):
        src = (ROOT / "main.py").read_text()
        self.assertIn("preflight_avatar(resolve_avatar_config(ctx, series_obj))", src)
        self.assertLess(src.index("preflight_avatar(resolve_avatar_config"), src.index("fetcher.generate_broll("))


if __name__ == "__main__":
    unittest.main()
