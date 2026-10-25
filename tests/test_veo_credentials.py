"""Where a Veo call (and the Google key in its header) may go: the model id and the submit path as configured, the host a result link names,
and redirects.

What would break without these: a deprecated id dodging the shutdown guard with a trailing dot or hyphen, a %-encoded letter, full-width
letters or an invisible character; a VEO_SUBMIT_PATH that sends the call (and the key) to a path nobody checked; the key sent to
``evil.example`` because ``urlparse`` and ``requests`` read ``https://evil.example\\@generativelanguage.googleapis.com/x`` differently; and a
3xx taking the session's key header to wherever the answer points.
"""

from __future__ import annotations

import unittest
from unittest import mock

import requests
from urllib3.util import parse_url

import config
from modules import model_registry as reg
from modules import video_providers as vp
from modules.capabilities import build_adapter
from modules.capabilities.base import PENDING, AdapterError, CapabilityRequest, ProviderTask, host_is
from modules.minimax_broll import VideoModelUnavailable
from tests.test_capabilities import FakeResp, FakeSession
from tests.test_video_provider_shapes import FakeResp as VFakeResp
from tests.test_video_provider_shapes import FakeSession as VFakeSession

KEY = "AIzaSy-test-NOT-A-REAL-KEY-0123456789abcdef"
GOOGLE = "generativelanguage.googleapis.com"
TEMPLATE = "/v1beta/models/{model}:predictLongRunning"


def veo_config(**values):
    base = {"VEO_API_KEY": KEY, "VEO_MODEL": "", "VEO_BASE_URL": f"https://{GOOGLE}", "VEO_SUBMIT_PATH": TEMPLATE}
    base.update(values)
    with mock.patch.multiple(config, **base, create=True):
        return vp._veo_config()


class ModelIdSpellingTests(unittest.TestCase):
    def test_a_deprecated_id_cannot_dodge_the_guard_with_a_trailing_dot_or_hyphen_or_an_encoding(self):
        spellings = (
            "veo-3.1-generate-preview.", "veo-3.1-generate-preview-", "-veo-3.1-generate-preview", ".veo-3.1-generate-preview",
            "veo-3.1-generate-preview%3ApredictLongRunning", "veo%2D3.1%2Dgenerate%2Dpreview", "veo-3.1-generate-previe%77",
            "ｖｅｏ-3.1-generate-preview",                      # full-width letters, NFKC folds them
            "veo-3.1-gene​rate-preview", "veo-3.1⁠-generate-preview", "veo-3.1-generate-preview​",
            "%2e%2e/veo-3.1-generate-preview",
        )
        for s in spellings:
            with self.subTest(repr(s)):
                problem = veo_config(VEO_MODEL=s).config_problem
                self.assertIn("2026-10-22", problem, problem)

    def test_a_longer_or_different_id_is_not_mistaken_for_a_listed_one(self):
        for ok in ("veo-3.1-generate-preview-001", "xveo-3.1-generate-preview", "veo-3.1-generate-preview2", "veo-3.1-generate-previews"):
            with self.subTest(ok):
                self.assertEqual(reg.names_id(ok, "veo-3.1-generate-preview"), False)
        self.assertEqual(veo_config(VEO_MODEL="veo-3.1-generate-preview-001").config_problem, "")

    def test_the_bare_id_must_start_and_end_with_a_letter_or_digit(self):
        for bad in ("veo-test.", "veo-test-", ".veo-test", "-veo-test", "veo--", "a"):
            with self.subTest(bad):
                problem = veo_config(VEO_MODEL=bad).config_problem
                if bad == "a":
                    self.assertEqual(problem, "")             # one character is a (silly) bare id
                else:
                    self.assertIn("must be a bare model id", problem)
        self.assertEqual(veo_config(VEO_MODEL="veo-test.1-x").config_problem, "")


class SubmitPathTests(unittest.TestCase):
    def test_only_the_one_documented_template_is_accepted(self):
        self.assertEqual(veo_config(VEO_MODEL="veo-test-model").config_problem, "")
        bad = (
            "/v1beta/models/{model}:predictLongRunning/", "/v1beta/models/{model}:predictLongRunning?x=1", "/v1/models/{model}:predictLongRunning",
            "/v1beta/models/{model}:predictLongRunnin%67", "/v1beta/models/%7Bmodel%7D:predictLongRunning", "//evil.example/v1beta",
            "/v1beta/models/{model}:predictLongRunning ", "/v1beta/models/../models/{model}:predictLongRunning",
            "/v1beta/models/veo-test-model:predictLongRunning", "/v1beta/models/{model}:predictLongRunning​",
        )
        for path in bad:
            with self.subTest(repr(path)):
                problem = veo_config(VEO_MODEL="veo-test-model", VEO_SUBMIT_PATH=path).config_problem
                self.assertIn("VEO_SUBMIT_PATH must be exactly", problem)

    def test_a_deprecated_id_written_into_the_path_in_any_spelling_still_names_the_id_first(self):
        for path in ("/v1beta/models/veo-3.1-generate-preview.:predictLongRunning", "/v1beta/models/veo-3.1-generat%65-preview:predictLongRunning",
                     "/v1beta/models/veo-3.1-generate​-preview:predictLongRunning"):
            with self.subTest(path):
                self.assertIn("2026-10-22", veo_config(VEO_MODEL="veo-test-model", VEO_SUBMIT_PATH=path).config_problem)
        self.assertIn("2025-11-12", veo_config(VEO_MODEL="veo-test-model",
                                               VEO_SUBMIT_PATH="/v1beta/models/veo-3.0-generate-previe%77:predictLongRunning").config_problem)


class LegacyRedirectTests(unittest.TestCase):
    """The legacy B-roll client keeps the key in a header of the SESSION: requests drops only Authorization on a cross-host redirect."""

    def client(self, posts=(), gets=()):
        with mock.patch.multiple(config, VEO_API_KEY=KEY, VEO_MODEL="veo-test-model", VEO_SUBMIT_PATH=TEMPLATE,
                                 VEO_BASE_URL=f"https://{GOOGLE}", create=True):
            c = vp.GenericAsyncVideoClient(vp._veo_config())
        c.session = VFakeSession(posts, gets)
        return c

    def spec(self):
        from tests.test_video_provider_shapes import _spec

        return _spec(4)

    def test_submit_never_follows_a_redirect_and_says_so(self):
        c = self.client(posts=[VFakeResp({}, status=302, headers={"Location": "https://evil.example/steal"})])
        with self.assertRaises(VideoModelUnavailable) as cm:
            c.submit(self.spec())
        self.assertIn("redirect", str(cm.exception))
        self.assertIs(c.session.calls[0]["allow_redirects"], False)

    def test_a_poll_never_follows_a_redirect_and_does_not_retry_into_one(self):
        c = self.client(gets=[VFakeResp({}, status=307, headers={"Location": "https://evil.example/steal"})] * 3)
        with self.assertRaises(VideoModelUnavailable) as cm:
            c._await("models/veo-test-model/operations/o1")
        self.assertIn("redirect", str(cm.exception))
        self.assertEqual(len(c.session.calls), 1)
        self.assertIs(c.session.calls[0]["allow_redirects"], False)


class ResultLinkHostTests(unittest.TestCase):
    EVIL = f"https://evil.example\\@{GOOGLE}/v1beta/files/f1:download?alt=media"

    def test_a_differential_check_urlparse_and_requests_disagree_about_the_backslash_and_host_is_the_one_that_sides_with_requests(self):
        from urllib.parse import urlparse

        prepared = requests.Request("GET", self.EVIL).prepare()
        connects_to = parse_url(prepared.url).host
        self.assertEqual(urlparse(self.EVIL).hostname, GOOGLE)            # the old reading: Google
        self.assertNotEqual(connects_to, GOOGLE)                           # what requests really connects to
        self.assertFalse(host_is(self.EVIL, GOOGLE))

    def test_host_is_refuses_every_url_whose_host_is_not_plainly_the_one_asked_for(self):
        for u in (self.EVIL, f"https://user@{GOOGLE}/x", f"https://{GOOGLE}:8443/x", f"https://{GOOGLE}.evil.example/x",
                  f"https://{GOOGLE} /x", f"https://{GOOGLE}\t/x", f"http://{GOOGLE}/x", f"https://{GOOGLE}/x\n", f"https://ɡoogle.example/x",
                  f"https://evil.example/{GOOGLE}", f"https://evil.example#@{GOOGLE}/x", "https://"):
            with self.subTest(repr(u)):
                self.assertFalse(host_is(u, GOOGLE))
        for u in (f"https://{GOOGLE}/v1beta/files/f:download?alt=media", f"https://{GOOGLE}:443/x", f"https://API.{GOOGLE}/x".replace("API.", "")):
            self.assertTrue(host_is(u, GOOGLE), u)

    def test_the_veo_adapter_never_hands_the_key_to_a_look_alike_link(self):
        done = {"done": True, "response": {"generateVideoResponse": {"generatedSamples": [{"video": {"uri": self.EVIL}}]}}}
        session = FakeSession([("GET", "/operations/op1", FakeResp(200, done))])
        a = build_adapter("video.veo", env={"VEO_API_KEY": KEY}, session=session)
        with self.assertRaises(AdapterError) as cm:
            a.poll(ProviderTask("video.veo", "veo-test-model", "models/veo-test-model/operations/op1"))
        self.assertIn("not a Gemini API file URL", cm.exception.message)
        self.assertEqual([c[0] for c in session.calls], ["GET"])         # the status poll only, no download, no key anywhere else

    def test_the_veo_adapter_follows_no_redirect_on_any_call(self):
        session = FakeSession([("POST", ":predictLongRunning", FakeResp(302, headers={"Location": "https://evil.example/x"})),
                               ("GET", "/operations/op1", FakeResp(302, headers={"Location": "https://evil.example/x"}))])
        a = build_adapter("video.veo", env={"VEO_API_KEY": KEY}, session=session)
        with self.assertRaises(AdapterError):
            a.submit(CapabilityRequest("t2v", "a boat", duration_s=4), "veo-test-model")
        with self.assertRaises(AdapterError):
            a.poll(ProviderTask("video.veo", "veo-test-model", "models/veo-test-model/operations/op1"))
        for call in session.calls:
            self.assertIs(call[2].get("allow_redirects"), False, call[:2])


class LoopbackRedirectTests(unittest.TestCase):
    """The real sockets: a 307 from the API host to another host must not carry ``x-goog-api-key`` there (requests drops only Authorization)."""

    def setUp(self):
        from tests.loopback_vendor import FakeVendor

        self.api, self.attacker = FakeVendor(), FakeVendor()
        self.addCleanup(self.api.close)
        self.addCleanup(self.attacker.close)

    def veo(self):
        return build_adapter("video.veo", env={"VEO_API_KEY": KEY, "VEO_BASE_URL": self.api.base_url}, session=self.api.session())

    def go(self, a):
        from tests.loopback_vendor import Resp

        self.api.on("POST", "/v1beta/models/", Resp(307, headers={"Location": f"{self.attacker.base_url}/steal"}))
        self.api.on("GET", "/v1beta/models/", Resp(307, headers={"Location": f"{self.attacker.base_url}/steal"}))
        try:
            a.submit(CapabilityRequest("t2v", "a boat", duration_s=4), "veo-test-model")
        except AdapterError:
            pass
        try:
            a.poll(ProviderTask("video.veo", "veo-test-model", "models/veo-test-model/operations/op1"))
        except AdapterError:
            pass

    def test_neither_call_sends_the_key_to_the_other_host(self):
        self.go(self.veo())
        self.assertEqual(self.attacker.requests, [])
        self.assertEqual(len(self.api.requests), 2)                       # each call made once, none repeated at the redirect

    def test_control_the_same_redirects_WOULD_carry_the_key_if_they_were_followed(self):
        a = self.veo()
        a.follow_redirects = True
        self.go(a)
        self.assertIn(KEY, [r.headers.get("x-goog-api-key") for r in self.attacker.requests])


if __name__ == "__main__":
    unittest.main()
