"""D4: a generator that was chosen on purpose is not silently swapped for stock.

A refusal that re-running will not fix (credentials, quota or billing, a
content-policy block) raises ``ImageProviderUnavailable`` and stops the run.
Only "the model returned nothing" (timeout, empty answer, a server error)
stays a soft fall-back to stock for that one section. No network: every client
gets a recorded session.
"""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import requests

import config
from modules import image_providers as ip
from modules.media_fetcher import MediaFetcher

KEY = "k-secret-do-not-leak"


class _Resp:
    """A response that raises requests.HTTPError (with itself as .response) on >= 400."""

    def __init__(self, payload=None, status=200, text="", chunks=()):
        self._payload, self.status_code, self.text, self._chunks = payload or {}, status, text, chunks

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}", response=self)

    def json(self):
        return self._payload

    def iter_content(self, chunk_size=0):
        yield from self._chunks

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _Session:
    def __init__(self, posts=(), gets=()):
        self.posts, self.gets = list(posts), list(gets)

    def post(self, url, **kw):
        return self.posts.pop(0)

    def get(self, url, **kw):
        return self.gets.pop(0)


def _client(cls, session):
    c = cls(api_key=KEY)
    c.session = session
    return c


GENERATORS = (ip.OpenAIImageClient, ip.GeminiImageClient, ip.FluxClient, ip.IdeogramClient, ip.FalImageClient)


class RefusalsStopTheRun(unittest.TestCase):
    def setUp(self):
        self.dest = Path(tempfile.mkdtemp()) / "img.jpg"

    def test_auth_and_quota_statuses_raise_for_every_generator(self):
        for cls in GENERATORS:
            for status, word in ((401, "credentials"), (403, "credentials"), (402, "quota")):
                with self.subTest(cls=cls.__name__, status=status):
                    with self.assertRaises(ip.ImageProviderUnavailable) as ctx:
                        _client(cls, _Session(posts=[_Resp(status=status)])).generate("a city", self.dest)
                    self.assertIn(word, str(ctx.exception))
                    self.assertIn(f"HTTP {status}", str(ctx.exception))
                    self.assertNotIn(KEY, str(ctx.exception))

    def test_a_billing_429_raises_but_a_plain_rate_limit_stays_soft(self):
        quota = _Resp(status=429, text='{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}')
        with self.assertRaises(ip.ImageProviderUnavailable) as ctx:
            _client(ip.OpenAIImageClient, _Session(posts=[quota])).generate("a city", self.dest)
        self.assertIn("quota", str(ctx.exception))
        slow = _Resp(status=429, text="Too many requests, slow down")
        with self.assertLogs(ip.logger, level="WARNING"):
            self.assertIsNone(_client(ip.OpenAIImageClient, _Session(posts=[slow])).generate("a city", self.dest))

    def test_a_content_policy_block_raises(self):
        blocked = _Resp(status=400, text='{"error":{"code":"moderation_blocked"}}')
        with self.assertRaises(ip.ImageProviderUnavailable) as ctx:
            _client(ip.OpenAIImageClient, _Session(posts=[blocked])).generate("a city", self.dest)
        self.assertIn("content policy", str(ctx.exception))

    def test_flux_moderated_status_raises(self):
        s = _Session(posts=[_Resp({"polling_url": "https://api.bfl.ai/p"})],
                     gets=[_Resp({"status": "Content Moderated"})])
        with self.assertRaises(ip.ImageProviderUnavailable):
            _client(ip.FluxClient, s).generate("a city", self.dest, interval=0)

    def test_leonardo_auth_refusal_raises(self):
        c = ip.LeonardoClient(api_key=KEY)
        c.session = _Session(posts=[_Resp(status=401)])
        with self.assertRaises(ip.ImageProviderUnavailable):
            c.generate("a city", self.dest)


class NothingBackStaysSoft(unittest.TestCase):
    def setUp(self):
        self.dest = Path(tempfile.mkdtemp()) / "img.jpg"

    def test_server_errors_and_timeouts_return_none(self):
        for cls in GENERATORS:
            for first in (_Resp(status=500), _Resp(status=503), requests.Timeout("slow")):
                with self.subTest(cls=cls.__name__, first=type(first).__name__):
                    session = _Session(posts=[first])
                    if isinstance(first, Exception):
                        session.post = mock.Mock(side_effect=first)
                    with self.assertLogs(ip.logger, level="WARNING"):
                        self.assertIsNone(_client(cls, session).generate("a city", self.dest))

    def test_an_empty_answer_returns_none(self):
        with self.assertLogs(ip.logger, level="WARNING"):
            self.assertIsNone(_client(ip.OpenAIImageClient, _Session(posts=[_Resp({"data": []})]))
                              .generate("a city", self.dest))

    def test_a_403_on_the_result_download_is_an_expired_link_not_a_refusal(self):
        s = _Session(posts=[_Resp({"data": [{"url": "https://cdn.test/x.jpg"}]})],
                     gets=[_Resp(status=403)])
        with self.assertLogs(ip.logger, level="WARNING"):
            self.assertIsNone(_client(ip.OpenAIImageClient, s).generate("a city", self.dest))


class FetcherAndPreflight(unittest.TestCase):
    def _fetcher(self, d):
        f = MediaFetcher.__new__(MediaFetcher)
        f.image_dir = Path(d)
        f.provenance = {}
        return f

    def test_generate_images_lets_a_refusal_through_instead_of_going_stock(self):
        client = mock.MagicMock()
        client.generate.side_effect = ip.ImageProviderUnavailable("X", "m", "refused", "fix it")
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(ip, "is_enabled", return_value=True):
            with self.assertRaises(ip.ImageProviderUnavailable):
                self._fetcher(d).generate_images([{"keywords": ["rome"]}], "Rome", client=client, max_images=1)

    def test_generate_images_still_swallows_an_unexpected_error_for_one_image(self):
        client = mock.MagicMock()
        client.generate.side_effect = RuntimeError("boom")
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(ip, "is_enabled", return_value=True):
            out = self._fetcher(d).generate_images([{"keywords": ["rome"]}], "Rome", client=client, max_images=1)
        self.assertEqual(out, [])

    def test_requested_but_unusable_raises_instead_of_returning_no_images(self):
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.multiple(config, IMAGE_PROVIDER="flux", IMAGE_GEN_OPT_IN=True, BFL_API_KEY=""):
            with self.assertRaises(ip.ImageProviderUnavailable) as ctx:
                self._fetcher(d).generate_images([{"keywords": ["rome"]}], "Rome")
        self.assertIn("BFL_API_KEY", ctx.exception.remedy)

    def test_preflight_cases(self):
        with mock.patch.multiple(config, IMAGE_PROVIDER="pexels", IMAGE_GEN_OPT_IN=True):
            ip.preflight()    # stock is the default, nothing asked for
        with mock.patch.multiple(config, IMAGE_PROVIDER="flux", IMAGE_GEN_OPT_IN=False, BFL_API_KEY=""):
            ip.preflight()    # off
        with mock.patch.multiple(config, IMAGE_PROVIDER="midjourney", IMAGE_GEN_OPT_IN=True):
            with self.assertRaises(ip.ImageProviderUnavailable):
                ip.preflight()
        with mock.patch.multiple(config, IMAGE_PROVIDER="flux", IMAGE_GEN_OPT_IN=True, BFL_API_KEY=KEY):
            ip.preflight()    # usable


if __name__ == "__main__":
    unittest.main()
