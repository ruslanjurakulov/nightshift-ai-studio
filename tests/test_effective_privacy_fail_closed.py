"""effective_privacy fails CLOSED when the Command Center switch could not be read (audit H7).

``ChannelContext.ui_auto_publish`` is None when the source carried no switch: a registry
outage (the legacy ``default`` channel is then synthesized with no database row), a
channels.json row, a database from before migration 0004. None used to read as
"unrestricted" and return the requested privacy unchanged, so a Supabase blip between the
``resolve`` job and the run would have let ``--privacy public`` through. Unknown now means
private. A clear True (let it through to the publish gate) and a clear False (clamp) are
exactly what they were.
"""

from __future__ import annotations

import unittest

from modules.channels import ChannelContext, effective_privacy, legacy_default_channel

REQUESTED = ("public", "unlisted", "private", "PUBLIC", "", None, "bogus")


class EffectivePrivacyTableTestCase(unittest.TestCase):
    def test_none_clamps_to_private_whatever_was_asked(self):
        for asked in REQUESTED:
            with self.subTest(asked=asked):
                self.assertEqual(effective_privacy(asked, None), "private")

    def test_a_clear_false_still_clamps_to_private(self):
        for asked in REQUESTED:
            with self.subTest(asked=asked):
                self.assertEqual(effective_privacy(asked, False), "private")

    def test_a_clear_true_still_passes_the_request_through_unchanged(self):
        for asked in REQUESTED:
            with self.subTest(asked=asked):
                self.assertEqual(effective_privacy(asked, True), asked)

    def test_anything_that_is_not_plainly_true_clamps(self):
        for junk in ("true", "True", 1, 0, "", [], {}):
            for asked in ("public", "unlisted"):
                with self.subTest(junk=junk, asked=asked):
                    self.assertEqual(effective_privacy(asked, junk), "private")

    def test_never_returns_anything_more_open_than_asked_for_private(self):
        for state in (True, False, None):
            self.assertEqual(effective_privacy("private", state), "private")


class SynthesizedFallbackTestCase(unittest.TestCase):
    """The registry-outage path: the legacy default is synthesized with no switch."""

    def test_the_synthesized_default_carries_no_switch_and_so_uploads_private(self):
        ctx = legacy_default_channel()
        self.assertIsNone(ctx.ui_auto_publish)
        self.assertEqual(effective_privacy("public", ctx.ui_auto_publish), "private")

    def test_a_code_built_context_is_private_too(self):
        ctx = ChannelContext(channel_id="default", name="X", niche="h")
        self.assertEqual(effective_privacy("public", ctx.ui_auto_publish), "private")


if __name__ == "__main__":
    unittest.main()
