"""The polling link of every BFL adapter carries the API key, so it must be a link on bfl.ai
that the HTTP library will really connect to, and a redirect must never take the key anywhere.

Found in review: ``base.host_is`` reads a URL's host with ``urlparse``; ``requests`` (urllib3) reads
it differently, so a submit answer whose ``polling_url`` is ``https://127.0.0.1:PORT\\@api.bfl.ai/x``
passed the old check while the connection (and the ``x-key`` header) went to 127.0.0.1. The same
hole was in FLUX.2 (``image.bfl``), ``video.bfl`` and the FLUX 3 adapter.

An ATTACKER listener (a second loopback HTTPS server) records every request it gets. Nothing in
these tests may reach it. The API under test is a first loopback server.
"""

from __future__ import annotations

import unittest

from modules.capabilities import build_adapter
from modules.capabilities.base import (
    E_BAD_RESPONSE,
    E_NOT_FOUND,
    T2I,
    T2V,
    AdapterError,
    CapabilityRequest,
    ProviderTask,
)
from modules.capabilities.safe_fetch import AFTER_COMPLETION, UNCONFIRMED, checked_polling_url
from tests.loopback_vendor import FakeVendor, Resp, cleanup_certificate

KEY = "bfl-test-NOT-A-REAL-KEY-0123456789abcdef"


def tearDownModule():
    cleanup_certificate()


#: key, a request the adapter accepts, a vendor model. Each adapter follows a polling link with x-key.
ADAPTERS = (
    ("image.bfl", CapabilityRequest(T2I, "a red apple", aspect_ratio="1:1"), "flux-2-pro"),
    ("video.bfl", CapabilityRequest(T2V, "a boat at dawn"), "flux-3-video"),
    ("image.bfl3", CapabilityRequest(T2I, "a red apple", aspect_ratio="1:1", image_size="1K"), "flux-3-image"),
)


def tricky(port: int):
    """Polling links that look like bfl.ai to one URL parser and lead to the listener on another."""
    return (
        f"https://127.0.0.1:{port}\\@api.bfl.ai/v1/get_result",       # backslash before the userinfo
        f"https://127.0.0.1:{port}#@api.bfl.ai/v1/get_result",        # fragment
        f"https://127.0.0.1:{port}?@api.bfl.ai/v1/get_result",        # query
        f"https://127.0.0.1:{port}/api.bfl.ai/v1/get_result",         # IP literal, the name only in the path
        f"https://localhost:{port}/v1/get_result",                    # a name that is not the vendor's
        f"https://api.bfl.ai@127.0.0.1:{port}/v1/get_result",         # credentials in front of the real host
        f"https://api.bfl.ai:{port}/v1/get_result",                   # the right name on a non-standard port
        f"https://api.bfl.ai.127.0.0.1:{port}/v1/get_result",
        f"https://127.0.0.1:{port}\\.bfl.ai/v1/get_result",
        f"http://api.bfl.ai/v1/get_result",                           # not https
    )


class Rig(unittest.TestCase):
    def setUp(self):
        self.api, self.attacker = FakeVendor(), FakeVendor()
        self.addCleanup(self.api.close)
        self.addCleanup(self.attacker.close)
        self.attacker.on("GET", "/", Resp(200, {"status": "Ready", "result": {"sample": "https://x/o.png"}}))
        self.attacker.on("POST", "/", Resp(200, {}))
        self.env = {"BFL_API_KEY": KEY, "BFL_BASE_URL": self.api.base_url + "/v1"}

    def adapter(self, key):
        return build_adapter(key, env=self.env, session=self.api.session())

    def assertNothingReachedTheAttacker(self, what=""):
        self.assertEqual([(r.method, r.path, "x-key" in r.headers) for r in self.attacker.requests], [], what)


class PollingLinkAtSubmitTests(Rig):
    def test_a_polling_link_that_leads_off_bfl_is_refused_as_an_unconfirmed_spend_and_never_requested(self):
        for key, request, model in ADAPTERS:
            for link in tricky(self.attacker.port):
                self.api._routes.clear()
                self.api.on("POST", f"/v1/{model}", Resp(200, {"id": "t1", "polling_url": link}))
                with self.assertRaises(AdapterError, msg=(key, link)) as cm:
                    self.adapter(key).submit(request, model)
                self.assertEqual(cm.exception.code, E_BAD_RESPONSE, (key, link))
                self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), (key, link, cm.exception.message))
                self.assertFalse(cm.exception.not_accepted, (key, link))      # the task probably exists: no reroute
                self.assertNothingReachedTheAttacker((key, link))

    def test_a_missing_or_malformed_polling_link_is_refused_the_same_way(self):
        for key, request, model in ADAPTERS:
            for body in ({}, [], "text", {"polling_url": ""}, {"polling_url": None}, {"polling_url": 7},
                         {"polling_url": ["https://api.bfl.ai/x"]}):
                self.api._routes.clear()
                self.api.on("POST", f"/v1/{model}", Resp(200, body))
                with self.assertRaises(AdapterError, msg=(key, body)) as cm:
                    self.adapter(key).submit(request, model)
                self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), (key, body))


class PollingLinkAtPollTests(Rig):
    def test_a_task_id_that_leads_off_bfl_is_refused_before_any_request_and_says_the_spend_may_have_happened(self):
        for key, _, model in ADAPTERS:
            for link in tricky(self.attacker.port):
                with self.assertRaises(AdapterError, msg=(key, link)) as cm:
                    self.adapter(key).poll(ProviderTask(key, model, link))
                self.assertEqual(cm.exception.code, E_NOT_FOUND, (key, link))
                self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), (key, link, cm.exception.message))
                self.assertNothingReachedTheAttacker((key, link))
            self.assertEqual(self.api.requests, [], key)

    def test_each_adapter_pins_the_vendors_domain_and_the_standard_port_only(self):
        from modules.capabilities import ADAPTERS as ALL

        for key, _, _ in ADAPTERS:
            cls = ALL[key]
            self.assertEqual((cls.polling_domain, tuple(cls.polling_ports)), ("bfl.ai", (None, 443)), key)
            self.assertEqual(checked_polling_url("https://api.bfl.ai/v1/get_result?id=1", cls.polling_domain, cls.polling_ports),
                             "https://api.bfl.ai/v1/get_result?id=1", key)
            for bad in ("https://api.bfl.ai:8443/v1/x", "https://evil.ai/v1/x", "https://api.bfl.ai.evil.ai/x"):
                with self.assertRaises(AdapterError, msg=(key, bad)):
                    checked_polling_url(bad, cls.polling_domain, cls.polling_ports)

    def test_the_documented_polling_links_pass(self):
        for link in ("https://api.bfl.ai/v1/get_result?id=abc", "https://api.eu.bfl.ai/v1/get_result?id=abc",
                     "https://api.us1.bfl.ai/v1/get_result/abc", "https://api.bfl.ai:443/v1/get_result?id=abc"):
            self.assertEqual(checked_polling_url(link, "bfl.ai"), link)
        for link in ("https://bfl.ai.evil.io/x", "https://evilbfl.ai/x", "https://api.bfl.ai:8443/x", "https://user@api.bfl.ai/x",
                     "http://api.bfl.ai/x", "https://api.bfl.ai\\@evil.io/x", "https://api.bfl.ai/x y", "", None, 7):
            with self.assertRaises(AdapterError, msg=repr(link)):
                checked_polling_url(link, "bfl.ai")


class RedirectTests(Rig):
    """A 3xx from the API host to another host must not carry ``x-key`` there."""

    def adapter_for_loopback(self, key):
        a = self.adapter(key)
        a.polling_domain = "localhost"
        a.polling_ports = (None, 443, self.api.port)
        return a

    def test_the_submit_call_does_not_follow_a_redirect(self):
        for key, request, model in ADAPTERS:
            self.api._routes.clear()
            self.api.on("POST", f"/v1/{model}", Resp(307, headers={"Location": f"{self.attacker.base_url}/steal"}))
            with self.assertRaises(AdapterError, msg=key):
                self.adapter(key).submit(request, model)
            self.assertNothingReachedTheAttacker(key)

    def test_the_poll_call_does_not_follow_a_redirect(self):
        for key, _, model in ADAPTERS:
            self.api._routes.clear()
            self.api.requests.clear()
            self.api.on("GET", "/v1/get_result/abc", Resp(307, headers={"Location": f"{self.attacker.base_url}/steal"}))
            with self.assertRaises(AdapterError, msg=key) as cm:
                self.adapter_for_loopback(key).poll(ProviderTask(key, model, f"{self.api.base_url}/v1/get_result/abc"))
            self.assertIn("307", cm.exception.message)
            self.assertNothingReachedTheAttacker(key)
            self.assertEqual(len(self.api.seen("GET", "/v1/get_result/abc")), 1, key)

    def test_control_the_same_redirect_WOULD_carry_the_key_if_it_were_followed(self):
        # Proves the tests above can fail: with redirects on, requests forwards x-key to the other host.
        self.api.on("GET", "/v1/get_result/abc", Resp(307, headers={"Location": f"{self.attacker.base_url}/steal"}))
        a = self.adapter_for_loopback("image.bfl3")
        a.follow_redirects = True
        try:
            a.poll(ProviderTask("image.bfl3", "flux-3-image", f"{self.api.base_url}/v1/get_result/abc"))
        except AdapterError:
            pass
        self.assertEqual([r.headers.get("x-key") for r in self.attacker.requests], [KEY])

    def test_no_other_adapter_changes_how_it_follows_redirects(self):
        from modules.capabilities import ADAPTERS as ALL

        self.assertEqual(sorted(k for k, c in ALL.items() if not c.follow_redirects),
                         ["image.bfl", "image.bfl3", "video.bfl", "video.veo"])   # video.veo: its header key must not follow a 3xx


if __name__ == "__main__":
    unittest.main()
