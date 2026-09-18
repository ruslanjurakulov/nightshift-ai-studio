"""Tests for modules.image_providers — the Leonardo image-gen router.

No network: the client's HTTP session is stubbed and config is monkeypatched,
so submit → poll → download runs end to end without a request leaving.
"""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import config
from modules import image_providers as ip


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


class RouterTestCase(unittest.TestCase):
    def test_default_provider_off(self):
        with mock.patch.object(config, "IMAGE_PROVIDER", "pexels"):
            self.assertEqual(ip.active_provider(), "pexels")
            self.assertFalse(ip.is_enabled())
            self.assertIsNone(ip.get_client())

    def test_leonardo_needs_key_and_opt_in(self):
        with mock.patch.object(config, "IMAGE_PROVIDER", "leonardo"):
            with mock.patch.object(config, "LEONARDO_API_KEY", ""), \
                 mock.patch.object(config, "IMAGE_GEN_OPT_IN", True):
                self.assertFalse(ip.is_enabled())
                self.assertIsNone(ip.get_client())
            with mock.patch.object(config, "LEONARDO_API_KEY", "k"), \
                 mock.patch.object(config, "IMAGE_GEN_OPT_IN", False):
                self.assertFalse(ip.is_enabled())
            with mock.patch.object(config, "LEONARDO_API_KEY", "k"), \
                 mock.patch.object(config, "IMAGE_GEN_OPT_IN", True):
                self.assertTrue(ip.is_enabled())
                self.assertIsInstance(ip.get_client(), ip.LeonardoClient)

    def test_active_model_reads_config(self):
        with mock.patch.object(config, "IMAGE_PROVIDER", "leonardo"), \
             mock.patch.object(config, "LEONARDO_MODEL_ID", "kino-xl"):
            self.assertEqual(ip.active_model(), "kino-xl")


class LeonardoClientTestCase(unittest.TestCase):
    def _client(self):
        return ip.LeonardoClient(api_key="secret-key")

    def test_no_key_returns_none(self):
        client = ip.LeonardoClient(api_key="")
        self.assertIsNone(client.generate("a prompt", Path("/tmp/none.jpg")))

    def test_blank_prompt_returns_none(self):
        self.assertIsNone(self._client().generate("   ", Path("/tmp/none.jpg")))

    def test_full_flow_downloads_an_image(self):
        client = self._client()
        client.session = mock.Mock()
        client.session.post.return_value = _Resp({"sdGenerationJob": {"generationId": "gen-1"}})
        client.session.get.side_effect = [
            _Resp({"generations_by_pk": {"status": "PENDING", "generated_images": []}}),
            _Resp({"generations_by_pk": {"status": "COMPLETE",
                                          "generated_images": [{"url": "https://cdn.test/out.jpg"}]}}),
            _Resp(chunks=[b"\xff\xd8\xff\xe0"]),   # the download
        ]
        with mock.patch.object(ip.time, "sleep", lambda *_: None):
            dest = Path(tempfile.mkdtemp()) / "still.jpg"
            out = client.generate("a lost city", dest)
        self.assertEqual(out, dest)
        self.assertTrue(dest.exists() and dest.stat().st_size > 0)

    def test_submit_failure_returns_none(self):
        client = self._client()
        client.session = mock.Mock()
        client.session.post.side_effect = RuntimeError("boom")
        self.assertIsNone(client.generate("x", Path("/tmp/x.jpg")))

    def test_reported_failure_returns_none(self):
        client = self._client()
        client.session = mock.Mock()
        client.session.post.return_value = _Resp({"sdGenerationJob": {"generationId": "gen-2"}})
        client.session.get.return_value = _Resp({"generations_by_pk": {"status": "FAILED"}})
        with mock.patch.object(ip.time, "sleep", lambda *_: None):
            self.assertIsNone(client.generate("x", Path("/tmp/x.jpg")))


if __name__ == "__main__":
    unittest.main()
