"""Tests for modules.video_providers — the b-roll video-provider router.

No network: the generic client's HTTP session is replaced with a stub, and
config attributes are monkeypatched, so submit → poll → download is exercised
end to end without a request leaving the process.
"""

import unittest
from pathlib import Path
from unittest import mock

import config
from modules import video_providers as vp
from modules.minimax_broll import GenerationSpec


def _spec(i=0):
    return GenerationSpec(prompt="a cinematic shot of Rome", duration_seconds=6, section_index=i, keyword="rome")


class _Resp:
    def __init__(self, payload=None, *, chunks=None):
        self._payload = payload or {}
        self._chunks = chunks or []
    def raise_for_status(self):
        return None
    def json(self):
        return self._payload
    def iter_content(self, chunk_size=0):
        yield from self._chunks
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


class RouterDefaultsTestCase(unittest.TestCase):
    def test_default_provider_is_minimax(self):
        with mock.patch.object(config, "VIDEO_PROVIDER", "minimax"):
            self.assertEqual(vp.active_provider(), "minimax")

    def test_minimax_enablement_is_unchanged(self):
        # is_enabled() for minimax must track MINIMAX_BROLL_ENABLED exactly.
        with mock.patch.object(config, "VIDEO_PROVIDER", "minimax"):
            with mock.patch.object(config, "MINIMAX_BROLL_ENABLED", True):
                self.assertTrue(vp.is_enabled())
            with mock.patch.object(config, "MINIMAX_BROLL_ENABLED", False):
                self.assertFalse(vp.is_enabled())

    def test_minimax_active_model(self):
        with mock.patch.object(config, "VIDEO_PROVIDER", "minimax"), \
             mock.patch.object(config, "MINIMAX_H3_MODEL", "MiniMax-H3"):
            self.assertEqual(vp.active_model(), "MiniMax-H3")

    def test_unknown_provider_is_off(self):
        with mock.patch.object(config, "VIDEO_PROVIDER", "nope"):
            self.assertFalse(vp.is_enabled())
            self.assertIsNone(vp.get_client())


class HiggsfieldEnablementTestCase(unittest.TestCase):
    def test_needs_key_and_opt_in(self):
        with mock.patch.object(config, "VIDEO_PROVIDER", "higgsfield"):
            with mock.patch.object(config, "HIGGSFIELD_API_KEY", ""), \
                 mock.patch.object(config, "VIDEO_GEN_OPT_IN", True):
                self.assertFalse(vp.is_enabled())          # no key
                self.assertIsNone(vp.get_client())
            with mock.patch.object(config, "HIGGSFIELD_API_KEY", "k"), \
                 mock.patch.object(config, "VIDEO_GEN_OPT_IN", False):
                self.assertFalse(vp.is_enabled())          # not opted in
            with mock.patch.object(config, "HIGGSFIELD_API_KEY", "k"), \
                 mock.patch.object(config, "VIDEO_GEN_OPT_IN", True):
                self.assertTrue(vp.is_enabled())
                self.assertIsInstance(vp.get_client(), vp.GenericAsyncVideoClient)

    def test_active_model_reads_config(self):
        with mock.patch.object(config, "VIDEO_PROVIDER", "higgsfield"), \
             mock.patch.object(config, "HIGGSFIELD_MODEL", "higgsfield-dop"):
            self.assertEqual(vp.active_model(), "higgsfield-dop")


class GenericClientTestCase(unittest.TestCase):
    def _client(self):
        cfg = vp.VideoProviderConfig(
            name="Test", api_key="secret-key", base_url="https://api.test",
            model="m", submit_path="/submit", query_path="/jobs/{id}",
        )
        return vp.GenericAsyncVideoClient(cfg)

    def test_no_key_returns_none(self):
        cfg = vp.VideoProviderConfig(
            name="Test", api_key="", base_url="https://api.test",
            model="m", submit_path="/submit", query_path="/jobs/{id}",
        )
        client = vp.GenericAsyncVideoClient(cfg)
        self.assertIsNone(client.generate(_spec(), Path("/tmp/none.mp4")))

    def test_full_flow_downloads_a_file(self):
        client = self._client()
        client.session = mock.Mock()
        client.session.post.return_value = _Resp({"id": "job-1"})
        client.session.get.side_effect = [
            _Resp({"status": "processing"}),
            _Resp({"status": "completed", "url": "https://cdn.test/out.mp4"}),
            _Resp(chunks=[b"\x00\x01\x02\x03"]),   # the download
        ]
        with mock.patch.object(vp.time, "sleep", lambda *_: None):
            import tempfile, os
            dest = Path(tempfile.mkdtemp()) / "clip.mp4"
            out = client.generate(_spec(3), dest)
        self.assertEqual(out, dest)
        self.assertTrue(dest.exists() and dest.stat().st_size > 0)

    def test_submit_failure_returns_none(self):
        client = self._client()
        client.session = mock.Mock()
        client.session.post.side_effect = RuntimeError("boom")
        self.assertIsNone(client.generate(_spec(), Path("/tmp/x.mp4")))

    def test_reported_failure_status_returns_none(self):
        client = self._client()
        client.session = mock.Mock()
        client.session.post.return_value = _Resp({"id": "job-2"})
        client.session.get.return_value = _Resp({"status": "failed"})
        with mock.patch.object(vp.time, "sleep", lambda *_: None):
            self.assertIsNone(client.generate(_spec(), Path("/tmp/x.mp4")))


class HelpersTestCase(unittest.TestCase):
    def test_unwrap_flattens_one_level(self):
        self.assertEqual(vp._unwrap({"data": {"id": "x"}}).get("id"), "x")
        self.assertEqual(vp._unwrap({"id": "y"}).get("id"), "y")
        self.assertEqual(vp._unwrap("nope"), {})

    def test_first_picks_first_present(self):
        self.assertEqual(vp._first({"a": "", "b": "v"}, ("a", "b")), "v")
        self.assertIsNone(vp._first({}, ("a", "b")))


if __name__ == "__main__":
    unittest.main()
