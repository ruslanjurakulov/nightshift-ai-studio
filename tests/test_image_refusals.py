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

    def __init__(self, payload=None, status=200, text="", chunks=(), headers=None):
        self._payload, self.status_code, self.text, self._chunks = payload or {}, status, text, chunks
        self.headers = headers or {}

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

    def test_openai_insufficient_quota_429_raises(self):
        body = ('{"error":{"message":"You exceeded your current quota, please check your plan and '
                'billing details.","type":"insufficient_quota","code":"insufficient_quota"}}')
        with self.assertRaises(ip.ImageProviderUnavailable) as ctx:
            _client(ip.OpenAIImageClient, _Session(posts=[_Resp(status=429, text=body)])).generate("a city", self.dest)
        self.assertIn("quota", str(ctx.exception))

    def test_openai_billing_hard_limit_400_raises_as_quota(self):
        body = '{"error":{"code":"billing_hard_limit_reached","message":"Billing hard limit has been reached"}}'
        with self.assertRaises(ip.ImageProviderUnavailable) as ctx:
            _client(ip.OpenAIImageClient, _Session(posts=[_Resp(status=400, text=body)])).generate("a city", self.dest)
        self.assertIn("quota", str(ctx.exception))
        self.assertIn("top up", ctx.exception.remedy)

    def test_gemini_daily_quota_429_raises(self):
        body = ('{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and '
                'billing details.","status":"RESOURCE_EXHAUSTED","details":[{"violations":[{"quotaId":'
                '"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}')
        with self.assertRaises(ip.ImageProviderUnavailable):
            _client(ip.GeminiImageClient, _Session(posts=[_Resp(status=429, text=body)])).generate("a city", self.dest)

    def test_fal_exhausted_balance_403_is_money_not_a_bad_key(self):
        with self.assertRaises(ip.ImageProviderUnavailable) as ctx:
            _client(ip.FalImageClient, _Session(posts=[_Resp(status=403, text='{"detail":"Exhausted balance. Top up your balance at fal.ai/dashboard/billing."}')])
                    ).generate("a city", self.dest)
        self.assertIn("top up", ctx.exception.remedy)
        self.assertNotIn("check the provider's API key", ctx.exception.remedy)

    def test_bfl_and_ideogram_402_raise_as_quota(self):
        for cls in (ip.FluxClient, ip.IdeogramClient):
            with self.subTest(cls=cls.__name__):
                with self.assertRaises(ip.ImageProviderUnavailable) as ctx:
                    _client(cls, _Session(posts=[_Resp(status=402, text='{"detail":"Insufficient credits"}')])).generate("a city", self.dest)
                self.assertIn("quota", str(ctx.exception))


#: Realistic per-minute / unclassifiable 429 bodies that waiting fixes: they must NOT stop the run.
RPM_429 = {
    "openai_rpm": ('{"error":{"message":"Rate limit reached for gpt-image-2 in organization org-x on requests per '
                   'min (RPM): Limit 5, Used 5, Requested 1. Please try again in 12s. Visit https://platform.openai.com/'
                   'account/rate-limits to learn more. You can increase your rate limit by adding a payment method to '
                   'your account at https://platform.openai.com/account/billing.","type":"requests","code":"rate_limit_exceeded"}}'),
    "gemini_per_minute": ('{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and '
                          'billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/'
                          'generate_content_free_tier_requests, limit: 5, model: gemini-3.1-flash-image-preview '
                          'Please retry in 27.4s.","status":"RESOURCE_EXHAUSTED"}}'),
    "bfl": '{"detail":"Too Many Requests"}',
    "ideogram": '{"error":"Rate limit exceeded"}',
    "empty": "",
}


class TransientRateLimitsStaySoft(unittest.TestCase):
    def setUp(self):
        self.dest = Path(tempfile.mkdtemp()) / "img.jpg"

    def test_realistic_429_bodies_are_not_refusals(self):
        for name, body in RPM_429.items():
            with self.subTest(name=name):
                err = requests.HTTPError("429", response=_Resp(status=429, text=body))
                self.assertIsNone(ip.refusal_category(err))
        # ...and a Retry-After header alone makes a 429 transient
        err = requests.HTTPError("429", response=_Resp(status=429, text="", headers={"Retry-After": "3"}))
        self.assertIsNone(ip.refusal_category(err))

    def test_a_transient_429_is_waited_out_once_then_succeeds(self):
        ok = _Resp({"data": [{"b64_json": "/9j/4AAQ"}]})
        slow = _Resp(status=429, text=RPM_429["openai_rpm"], headers={"Retry-After": "7"})
        session = _Session(posts=[slow, ok])
        sleeps = []
        with mock.patch("time.sleep", sleeps.append):
            path = _client(ip.OpenAIImageClient, session).generate("a city", self.dest)
        self.assertIsNotNone(path)
        self.assertEqual(sleeps, [7.0])
        self.assertEqual(session.posts, [])

    def test_the_wait_is_capped(self):
        slow = _Resp(status=429, text="", headers={"Retry-After": "600"})
        session = _Session(posts=[slow, _Resp(status=500)])
        sleeps = []
        with mock.patch("time.sleep", sleeps.append), self.assertLogs(ip.logger, level="WARNING"):
            self.assertIsNone(_client(ip.OpenAIImageClient, session).generate("a city", self.dest))
        self.assertEqual(sleeps, [ip.RETRY_AFTER_CAP_S])

    def test_a_429_that_stays_limited_goes_soft_after_one_retry(self):
        for name, body in RPM_429.items():
            with self.subTest(name=name):
                session = _Session(posts=[_Resp(status=429, text=body), _Resp(status=429, text=body)])
                sleeps = []
                with mock.patch("time.sleep", sleeps.append), self.assertLogs(ip.logger, level="WARNING"):
                    self.assertIsNone(_client(ip.OpenAIImageClient, session).generate("a city", self.dest))
                self.assertLessEqual(len(sleeps), 1)
                self.assertEqual(len(session.posts), 0 if sleeps else 1)

    def test_an_unclassifiable_429_with_no_signal_is_not_retried(self):
        session = _Session(posts=[_Resp(status=429, text="")])
        with mock.patch("time.sleep", side_effect=AssertionError("must not wait")), \
                self.assertLogs(ip.logger, level="WARNING"):
            self.assertIsNone(_client(ip.OpenAIImageClient, session).generate("a city", self.dest))


class PolicyAndSafetyWording(unittest.TestCase):
    def setUp(self):
        self.dest = Path(tempfile.mkdtemp()) / "img.jpg"

    def test_the_word_safety_alone_is_not_a_policy_block(self):
        err = requests.HTTPError("400", response=_Resp(status=400, text='{"error":"invalid size; see the safety of the grid"}'))
        self.assertIsNone(ip.refusal_category(err))

    def test_a_content_policy_block_raises(self):
        blocked = _Resp(status=400, text='{"error":{"code":"moderation_blocked"}}')
        with self.assertRaises(ip.ImageProviderUnavailable) as ctx:
            _client(ip.OpenAIImageClient, _Session(posts=[blocked])).generate("a city", self.dest)
        self.assertIn("content policy", str(ctx.exception))
        self.assertIn("turn image generation off", ctx.exception.remedy)
        self.assertNotIn("reword the section keywords", ctx.exception.remedy)

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


class MainStagePreflight(unittest.TestCase):
    """main._preflight_pictures is what run() calls before any paid stage."""

    def test_an_unusable_image_generator_stops_the_run_and_records_why(self):
        import main
        with mock.patch.multiple(config, IMAGE_PROVIDER="flux", IMAGE_GEN_OPT_IN=True, BFL_API_KEY=""), \
                mock.patch.object(main.events, "emit") as emit:
            with self.assertRaises(ip.ImageProviderUnavailable):
                main._preflight_pictures(mock.MagicMock(), None, "chan")
        self.assertEqual(emit.call_args.kwargs["metadata"]["stage"], "preflight")
        self.assertIn("BFL_API_KEY", emit.call_args.kwargs["metadata"]["error"])

    def test_nothing_requested_passes_quietly(self):
        import main
        with mock.patch.multiple(config, IMAGE_PROVIDER="pexels", IMAGE_GEN_OPT_IN=False), \
                mock.patch.dict("os.environ", {"NIGHTSHIFT_AVATAR_ENABLED": "0"}), \
                mock.patch.object(main.events, "emit") as emit:
            main._preflight_pictures(mock.MagicMock(avatar=None), None, "chan")
        emit.assert_not_called()

    def test_run_calls_it_before_the_script_is_paid_for(self):
        src = (Path(__file__).resolve().parent.parent / "main.py").read_text()
        self.assertLess(src.index("_preflight_pictures(ctx, series_obj, channel_id)"), src.index("fetcher.generate_images("))

    def test_stills_are_generated_before_clips_are_paid_for(self):
        src = (Path(__file__).resolve().parent.parent / "main.py").read_text()
        self.assertLess(src.index("fetcher.generate_images("), src.index("fetcher.generate_broll("))


if __name__ == "__main__":
    unittest.main()
