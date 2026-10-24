"""Tests for modules/avatar.py — the AITuber presenter layer.

The load-bearing guarantees: the synthetic-only safety guard actually refuses
real/identifiable people (in code, not prose), an unconfigured provider fails
loudly rather than shipping a blank presenter, and the guard runs before any
network call."""

import os
import unittest
from pathlib import Path
from unittest.mock import patch

from modules.avatar import (
    AvatarConfig,
    AvatarProvider,
    AvatarUnavailable,
    HiggsfieldAvatarProvider,
    UnsafeAvatarRequest,
    avatar_provider,
    maybe_generate_presenter,
    presenter_layout,
    resolve_avatar_config,
    synthetic_only_guard,
)

_ENV_KEYS = (
    "HIGGSFIELD_API_KEY_ID", "HIGGSFIELD_API_KEY_SECRET",
    "HIGGSFIELD_API_BASE", "HIGGSFIELD_AVATAR_ENDPOINT",
)
_AVATAR_ENV_KEYS = (
    "NIGHTSHIFT_AVATAR", "NIGHTSHIFT_AVATAR_ENABLED", "NIGHTSHIFT_AVATAR_PROVIDER",
    "NIGHTSHIFT_AVATAR_CHARACTER_PROMPT", "NIGHTSHIFT_AVATAR_CHARACTER_REF",
)


class SyntheticOnlyGuardTestCase(unittest.TestCase):
    def test_allows_synthetic_character(self):
        # A described, invented character is fine — no exception.
        synthetic_only_guard("a stylized cartoon owl narrator, neon purple", "history mysteries")
        synthetic_only_guard(None, "a friendly 3D robot host")

    def test_refuses_real_person_markers(self):
        for ref in [
            "a photo of my friend John",
            "deepfake of a famous actor",
            "clone this celebrity's face",
            "the current president",
            "lookalike of a popular singer",
        ]:
            with self.assertRaises(UnsafeAvatarRequest):
                synthetic_only_guard(ref, "")

    def test_refuses_image_url_reference(self):
        with self.assertRaises(UnsafeAvatarRequest):
            synthetic_only_guard("https://example.com/someone.jpg", "")


class AvatarConfigTestCase(unittest.TestCase):
    def test_off_by_default(self):
        self.assertFalse(AvatarConfig.from_mapping(None).enabled)
        self.assertFalse(AvatarConfig.from_mapping({}).enabled)

    def test_parses_fields(self):
        cfg = AvatarConfig.from_mapping({
            "enabled": True, "provider": "higgsfield",
            "character_prompt": "a cartoon fox", "character_ref": "fox-v1",
        })
        self.assertTrue(cfg.enabled)
        self.assertEqual(cfg.character_prompt, "a cartoon fox")


class ProviderFactoryTestCase(unittest.TestCase):
    def test_none_when_disabled(self):
        self.assertIsNone(avatar_provider(AvatarConfig(enabled=False)))

    def test_higgsfield_when_enabled(self):
        p = avatar_provider(AvatarConfig(enabled=True, provider="higgsfield"))
        self.assertIsInstance(p, HiggsfieldAvatarProvider)
        self.assertIsInstance(p, AvatarProvider)  # conforms to the protocol

    def test_unknown_provider_raises(self):
        with self.assertRaises(AvatarUnavailable):
            avatar_provider(AvatarConfig(enabled=True, provider="nope"))


class HiggsfieldProviderTestCase(unittest.TestCase):
    def setUp(self):
        # Ensure a clean, unconfigured environment for these tests.
        self._patcher = patch.dict(os.environ, {k: "" for k in _ENV_KEYS}, clear=False)
        self._patcher.start()
        self.addCleanup(self._patcher.stop)

    def test_unconfigured_raises_avatar_unavailable(self):
        with self.assertRaises(AvatarUnavailable):
            HiggsfieldAvatarProvider().generate("a cartoon owl", "owl-v1", Path("/tmp/x.mp4"))

    def test_guard_runs_before_config_check(self):
        # An unsafe request must be refused even before we look at credentials.
        with self.assertRaises(UnsafeAvatarRequest):
            HiggsfieldAvatarProvider().generate("host", "deepfake of a celebrity", Path("/tmp/x.mp4"))

    def test_submit_poll_happy_path(self):
        class FakeResp:
            def __init__(self, payload):
                self._payload = payload
                self.content = b"x"

            def raise_for_status(self):
                pass

            def json(self):
                return self._payload

        env = {
            "HIGGSFIELD_API_KEY_ID": "id123", "HIGGSFIELD_API_KEY_SECRET": "sec456",
            "HIGGSFIELD_API_BASE": "https://api.higgsfield.ai",
            "HIGGSFIELD_AVATAR_ENDPOINT": "higgsfield-ai/soul/v2/standard",
        }
        with patch.dict(os.environ, env, clear=False), \
             patch("requests.post", return_value=FakeResp({"id": "job-1"})) as post, \
             patch("requests.get", return_value=FakeResp({"status": "completed", "url": "https://x/v.mp4"})) as get, \
             patch.object(HiggsfieldAvatarProvider, "_download", return_value=Path("/tmp/out.mp4")) as dl:
            out = HiggsfieldAvatarProvider(poll_interval=0).generate("a cartoon owl", "owl-v1", Path("/tmp/out.mp4"))
        self.assertEqual(out, Path("/tmp/out.mp4"))
        post.assert_called_once()
        get.assert_called()
        dl.assert_called_once()
        # Higgsfield's documented auth scheme — `Key <id>:<secret>`, not Bearer.
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Key id123:sec456")
        # Submit hits the model path; polling hits the documented status endpoint.
        self.assertEqual(post.call_args.args[0], "https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard")
        self.assertEqual(get.call_args.args[0], "https://api.higgsfield.ai/requests/job-1/status")

    def test_endpoint_defaults_to_kling(self):
        # The model path is optional: it defaults to Kling 3.0 (the cost pick),
        # so only the credential pair is required to be configured.
        env = {"HIGGSFIELD_API_KEY_ID": "id", "HIGGSFIELD_API_KEY_SECRET": "sec"}
        with patch.dict(os.environ, {k: "" for k in _ENV_KEYS}, clear=False):
            for k in _ENV_KEYS:
                os.environ.pop(k, None)
            os.environ.update(env)
            e = HiggsfieldAvatarProvider()._env()
        self.assertTrue(e.configured)
        self.assertEqual(e.endpoint, "jobs/v2/kling3_0")

    def test_base_url_defaults_when_unset(self):
        # HIGGSFIELD_API_BASE is optional: the credential pair + model path are
        # enough, and the base defaults to the documented host.
        env = {
            "HIGGSFIELD_API_KEY_ID": "id", "HIGGSFIELD_API_KEY_SECRET": "sec",
            "HIGGSFIELD_AVATAR_ENDPOINT": "higgsfield-ai/soul/v2/standard",
            "HIGGSFIELD_API_BASE": "",
        }
        with patch.dict(os.environ, env, clear=False):
            os.environ.pop("HIGGSFIELD_API_BASE", None)
            env_obj = HiggsfieldAvatarProvider()._env()
        self.assertTrue(env_obj.configured)
        self.assertEqual(env_obj.base_url, "https://api.higgsfield.ai")
        self.assertEqual(env_obj.auth_header, "Key id:sec")


class _FakeSeries:
    def __init__(self, visual_style=""):
        self.visual_style = visual_style


class _FakeCtx:
    def __init__(self, avatar=None):
        if avatar is not None:
            self.avatar = avatar


class ResolveAvatarConfigTestCase(unittest.TestCase):
    def setUp(self):
        # A clean slate so ambient env can't turn the presenter on unexpectedly.
        self._patcher = patch.dict(os.environ, {k: "" for k in _AVATAR_ENV_KEYS}, clear=False)
        self._patcher.start()
        self.addCleanup(self._patcher.stop)
        for k in _AVATAR_ENV_KEYS:
            os.environ.pop(k, None)

    def test_off_by_default(self):
        # Nothing configured: the run stays faceless.
        self.assertFalse(resolve_avatar_config().enabled)
        self.assertFalse(resolve_avatar_config(_FakeCtx(), _FakeSeries("neon owl")).enabled)

    def test_enabled_via_env(self):
        with patch.dict(os.environ, {"NIGHTSHIFT_AVATAR_ENABLED": "true"}):
            self.assertTrue(resolve_avatar_config().enabled)

    def test_a_blank_enabled_variable_is_unset_so_the_json_enabled_stands(self):
        # An undefined Actions variable arrives as "" (or spaces). It used to read as "set to false" and
        # silently switched off a presenter the NIGHTSHIFT_AVATAR JSON had enabled.
        for blank in ("", " ", " \t\n"):
            with self.subTest(blank=blank), patch.dict(
                    os.environ, {"NIGHTSHIFT_AVATAR": '{"enabled": true, "provider": "fal"}',
                                 "NIGHTSHIFT_AVATAR_ENABLED": blank}):
                cfg = resolve_avatar_config()
                self.assertTrue(cfg.enabled)
                self.assertEqual(cfg.provider, "fal")

    def test_a_blank_enabled_variable_alone_stays_off(self):
        for blank in ("", "   "):
            with self.subTest(blank=blank), patch.dict(os.environ, {"NIGHTSHIFT_AVATAR_ENABLED": blank}):
                self.assertFalse(resolve_avatar_config().enabled)

    def test_an_explicit_enabled_variable_still_overrides_the_json_either_way(self):
        on_json = '{"enabled": true}'
        off_json = '{"enabled": false}'
        for value, json_env, expected in (
                ("0", on_json, False), ("false", on_json, False), (" false ", on_json, False),
                ("no", on_json, False), ("1", off_json, True), ("true", off_json, True),
                (" 1 ", off_json, True), ("1", on_json, True), ("0", off_json, False)):
            with self.subTest(value=value, json=json_env), patch.dict(
                    os.environ, {"NIGHTSHIFT_AVATAR": json_env, "NIGHTSHIFT_AVATAR_ENABLED": value}):
                self.assertIs(resolve_avatar_config().enabled, expected)

    def test_the_channel_mapping_still_beats_a_blank_or_explicit_variable(self):
        for value in ("", "1", "0"):
            with self.subTest(value=value), patch.dict(os.environ, {"NIGHTSHIFT_AVATAR_ENABLED": value}):
                self.assertFalse(resolve_avatar_config(_FakeCtx(avatar={"enabled": False})).enabled)

    def test_channel_mapping_overrides_env(self):
        with patch.dict(os.environ, {"NIGHTSHIFT_AVATAR_ENABLED": "true"}):
            cfg = resolve_avatar_config(_FakeCtx(avatar={"enabled": False}))
        self.assertFalse(cfg.enabled)  # per-channel setting wins

    def test_series_visual_style_seeds_prompt_when_enabled(self):
        with patch.dict(os.environ, {"NIGHTSHIFT_AVATAR_ENABLED": "true"}):
            cfg = resolve_avatar_config(_FakeCtx(), _FakeSeries("a stylized 3D fox host"))
        self.assertEqual(cfg.character_prompt, "a stylized 3D fox host")

    def test_explicit_prompt_not_overwritten_by_series(self):
        env = {"NIGHTSHIFT_AVATAR_ENABLED": "true", "NIGHTSHIFT_AVATAR_CHARACTER_PROMPT": "a cartoon owl"}
        with patch.dict(os.environ, env):
            cfg = resolve_avatar_config(_FakeCtx(), _FakeSeries("a fox"))
        self.assertEqual(cfg.character_prompt, "a cartoon owl")

    def test_a_whitespace_only_prompt_or_ref_is_unset_not_a_blank_description(self):
        # A repository variable holding only spaces must behave like an empty one: the series' look still seeds the
        # character, and a blank reference never reaches the synthetic-only guard.
        env = {"NIGHTSHIFT_AVATAR_ENABLED": "true", "NIGHTSHIFT_AVATAR_CHARACTER_PROMPT": "   ",
               "NIGHTSHIFT_AVATAR_CHARACTER_REF": " \t "}
        with patch.dict(os.environ, env):
            cfg = resolve_avatar_config(_FakeCtx(), _FakeSeries("a stylized 3D fox host"))
        self.assertEqual(cfg.character_prompt, "a stylized 3D fox host")
        self.assertEqual(cfg.character_ref, "")

    def test_a_real_prompt_is_kept_without_its_surrounding_spaces(self):
        with patch.dict(os.environ, {"NIGHTSHIFT_AVATAR_ENABLED": "true",
                                     "NIGHTSHIFT_AVATAR_CHARACTER_PROMPT": "  a cartoon owl \n"}):
            self.assertEqual(resolve_avatar_config().character_prompt, "a cartoon owl")

    def test_series_ignored_when_disabled(self):
        # A visual style must not turn the presenter on by itself.
        cfg = resolve_avatar_config(_FakeCtx(), _FakeSeries("a fox"))
        self.assertFalse(cfg.enabled)
        self.assertEqual(cfg.character_prompt, "")

    def test_json_env_parses(self):
        with patch.dict(os.environ, {"NIGHTSHIFT_AVATAR": '{"enabled": true, "provider": "higgsfield"}'}):
            self.assertTrue(resolve_avatar_config().enabled)

    def test_malformed_json_env_is_ignored(self):
        with patch.dict(os.environ, {"NIGHTSHIFT_AVATAR": "{not json"}):
            self.assertFalse(resolve_avatar_config().enabled)  # ignored, not fatal


class PresenterLayoutTestCase(unittest.TestCase):
    def test_within_bounds_bottom_right(self):
        lay = presenter_layout(1920, 1080)
        self.assertGreater(lay["w"], 0)
        self.assertGreater(lay["h"], 0)
        self.assertLessEqual(lay["x"] + lay["w"], 1920)
        self.assertLessEqual(lay["y"] + lay["h"], 1080)
        # Bottom-right: the inset sits past the horizontal/vertical midpoint.
        self.assertGreater(lay["x"], 1920 // 2)
        self.assertGreater(lay["y"], 1080 // 2)

    def test_scale_is_clamped(self):
        big = presenter_layout(1000, 1000, scale=5.0)   # absurd → clamped
        self.assertLessEqual(big["w"], 600)
        small = presenter_layout(1000, 1000, scale=0.0)  # zero → clamped up
        self.assertGreaterEqual(small["w"], 50)

    def test_corners_differ(self):
        tl = presenter_layout(1920, 1080, corner="top-left")
        br = presenter_layout(1920, 1080, corner="bottom-right")
        self.assertLess(tl["x"], br["x"])
        self.assertLess(tl["y"], br["y"])


class MaybeGeneratePresenterTestCase(unittest.TestCase):
    def test_none_when_disabled(self):
        self.assertIsNone(
            maybe_generate_presenter(AvatarConfig(enabled=False), "a fox", Path("/tmp/p.mp4")))

    def test_enabled_but_unconfigured_raises(self):
        # No silent fallback: an enabled provider with no credentials fails loud.
        with patch.dict(os.environ, {k: "" for k in _ENV_KEYS}, clear=False):
            for k in _ENV_KEYS:
                os.environ.pop(k, None)
            with self.assertRaises(AvatarUnavailable):
                maybe_generate_presenter(
                    AvatarConfig(enabled=True, provider="higgsfield", character_prompt="a fox"),
                    "a fox", Path("/tmp/p.mp4"))

    def test_happy_path_delegates_to_provider(self):
        class FakeProvider:
            def __init__(self):
                self.calls = []

            def generate(self, prompt, ref, out):
                self.calls.append((prompt, ref, out))
                return Path("/tmp/out.mp4")

        fake = FakeProvider()
        with patch("modules.avatar.avatar_provider", return_value=fake):
            out = maybe_generate_presenter(
                AvatarConfig(enabled=True, character_prompt="a cartoon owl", character_ref="owl-1"),
                "", Path("/tmp/out.mp4"))
        self.assertEqual(out, Path("/tmp/out.mp4"))
        self.assertEqual(fake.calls[0][0], "a cartoon owl")  # prompt fell back to config
        self.assertEqual(fake.calls[0][1], "owl-1")


if __name__ == "__main__":
    unittest.main()
