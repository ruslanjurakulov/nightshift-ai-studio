"""Result download and lost-answer handling shared by the first-party adapters
(modules/capabilities/safe_fetch.py), over a REAL HTTPS socket.

What each test pins is a way a result could be lost, leaked or faked:

* a link that points anywhere but the vendor's own hosts is never requested;
* the key is never sent to a result host, and a redirect is never followed;
* a file over the cap, an empty one, an HTML error page, or a stream cut short
  leaves NO file behind (and no ``.part``), never a half-written "result";
* a submit whose answer never came back is reported as possibly billed.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from modules.capabilities.base import (
    E_BAD_RESPONSE,
    E_NOT_FOUND,
    E_UNAVAILABLE,
    AdapterError,
    HttpAdapter,
    Output,
    PollResult,
    SUCCEEDED,
)
from modules.capabilities.safe_fetch import (
    UNCONFIRMED,
    SafeResultMixin,
    checked_result_url,
    sniff_image_mime,
)
from tests.loopback_vendor import FakeVendor, Resp, cleanup_certificate, closed_port_url

MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 4096
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
KEY = "sk-test-NOT-A-REAL-KEY-0123456789"


class Dummy(SafeResultMixin, HttpAdapter):
    key = "video.dummy"
    key_env = ("DUMMY_API_KEY",)
    capabilities = ()
    result_hosts = ("localhost",)


def adapter(vendor: FakeVendor, **attrs) -> Dummy:
    a = Dummy(env={"DUMMY_API_KEY": KEY}, session=vendor.session())
    a.result_ports = (None, 443, vendor.port)       # the loopback server's port; production keeps (None, 443)
    for k, v in attrs.items():
        setattr(a, k, v)
    return a


def result(url: str, mime: str = "video/mp4") -> PollResult:
    return PollResult(SUCCEEDED, [Output(mime, url=url)])


def tearDownModule():
    cleanup_certificate()


class CheckedUrlTests(unittest.TestCase):
    HOSTS = ("volces.com", "bytepluses.com")

    def test_accepts_the_vendors_own_hosts_and_their_subdomains(self):
        for url in ("https://volces.com/a.mp4", "https://x.tos-ap-southeast-1.volces.com/a/b.mp4?sig=1",
                    "https://ark.bytepluses.com:443/f"):
            self.assertEqual(checked_result_url(url, self.HOSTS), url)

    def test_refuses_everything_else_before_any_request(self):
        for url in ("http://x.volces.com/a.mp4",                  # not https
                    "https://evilvolces.com/a.mp4",               # a look-alike, not a subdomain
                    "https://volces.com.attacker.example/a.mp4",  # the vendor's name as a prefix
                    "https://attacker.example/volces.com/a.mp4",  # in the path only
                    "https://user:pw@x.volces.com/a.mp4",         # credentials in the URL
                    "https://x.volces.com:8443/a.mp4",            # an odd port
                    "https://evil.example\\.volces.com/a.mp4",    # the backslash two parsers read differently
                    "https://x.volces.com/a b.mp4",               # whitespace
                    "ftp://x.volces.com/a.mp4", "//x.volces.com/a.mp4", "", None, 7):
            with self.assertRaises(AdapterError, msg=repr(url)) as cm:
                checked_result_url(url, self.HOSTS)
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE)

    def test_no_hosts_means_nothing_is_downloaded(self):
        with self.assertRaises(AdapterError):
            checked_result_url("https://x.volces.com/a.mp4", ())


class SniffTests(unittest.TestCase):
    def test_an_inline_image_is_known_by_its_bytes_not_by_the_vendors_claim(self):
        self.assertEqual(sniff_image_mime(PNG), "image/png")
        self.assertEqual(sniff_image_mime(b"\xff\xd8\xff\xe0" + b"\x00" * 20), "image/jpeg")
        self.assertEqual(sniff_image_mime(b"RIFF\x10\x00\x00\x00WEBPVP8 " + b"\x00" * 8), "image/webp")
        self.assertIsNone(sniff_image_mime(b"<html>error</html>"))


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.vendor = FakeVendor()
        self.addCleanup(self.vendor.close)
        self.tmp = Path(tempfile.mkdtemp(prefix="safe_fetch_test_"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))

    def files(self):
        return sorted(p.name for p in self.tmp.iterdir())

    def test_a_good_clip_is_written_atomically_with_no_key_sent(self):
        self.vendor.on("GET", "/clip.mp4", Resp(200, raw=MP4, headers={"Content-Type": "video/mp4"}))
        (path,) = adapter(self.vendor).fetch(result(f"{self.vendor.base_url}/clip.mp4"), self.tmp, stem="out")
        self.assertEqual(path.read_bytes(), MP4)
        self.assertEqual(self.files(), ["out_0.mp4"])                      # no .part left
        (seen,) = self.vendor.seen("GET", "/clip.mp4")
        self.assertNotIn("authorization", seen.headers)                    # the key is not this host's credential
        self.assertNotIn(KEY, "".join(f"{k}{v}" for k, v in seen.headers.items()))

    def test_a_link_off_the_allow_list_is_never_requested(self):
        a = adapter(self.vendor, result_hosts=("volces.com",))
        with self.assertRaises(AdapterError) as cm:
            a.fetch(result(f"{self.vendor.base_url}/clip.mp4"), self.tmp)
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertEqual(self.vendor.requests, [])
        self.assertEqual(self.files(), [])

    def test_plain_http_is_never_requested(self):
        with self.assertRaises(AdapterError):
            adapter(self.vendor).fetch(result(f"http://localhost:{self.vendor.port}/clip.mp4"), self.tmp)
        self.assertEqual(self.vendor.requests, [])

    def test_a_redirect_is_refused_and_its_target_is_never_contacted(self):
        other = FakeVendor()
        self.addCleanup(other.close)
        other.on("GET", "/", Resp(200, raw=MP4))
        self.vendor.on("GET", "/clip.mp4", Resp(302, headers={"Location": f"{other.base_url}/stolen.mp4"}))
        with self.assertRaises(AdapterError) as cm:
            adapter(self.vendor).fetch(result(f"{self.vendor.base_url}/clip.mp4"), self.tmp)
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertIn("redirect", cm.exception.message)
        self.assertEqual(other.requests, [])
        self.assertEqual(self.files(), [])

    def test_a_declared_size_over_the_cap_is_refused_before_reading(self):
        # Content-Length alone says 1 TB while only 100 bytes follow: reading would end as a cut
        # stream (retryable), so a bad_response "not downloaded" proves the header was checked first.
        self.vendor.on("GET", "/big.mp4", Resp(200, raw=MP4[:100], declared_length=10**12))
        with self.assertRaises(AdapterError) as cm:
            adapter(self.vendor).fetch(result(f"{self.vendor.base_url}/big.mp4"), self.tmp)
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertIn("not downloaded", cm.exception.message)
        self.assertEqual(self.files(), [])

    def test_a_body_one_byte_over_the_cap_is_refused_and_one_at_the_cap_is_kept(self):
        self.vendor.on("GET", "/edge.mp4", Resp(200, raw=MP4))
        with self.assertRaises(AdapterError):
            adapter(self.vendor, max_result_bytes=len(MP4) - 1).fetch(result(f"{self.vendor.base_url}/edge.mp4"), self.tmp)
        self.assertEqual(self.files(), [])
        (path,) = adapter(self.vendor, max_result_bytes=len(MP4)).fetch(result(f"{self.vendor.base_url}/edge.mp4"), self.tmp)
        self.assertEqual(path.read_bytes(), MP4)

    def test_an_empty_body_is_refused_even_when_no_file_type_is_known(self):
        self.vendor.on("GET", "/empty.bin", Resp(200, raw=b""))
        dest = self.tmp / "x.bin"
        with self.assertRaises(AdapterError) as cm:
            adapter(self.vendor)._download(f"{self.vendor.base_url}/empty.bin", dest)
        self.assertIn("empty", cm.exception.message)
        self.assertEqual(self.files(), [])

    def test_a_stream_with_no_declared_size_is_stopped_at_the_cap(self):
        endless = (b"\x00" * 65536 for _ in range(200))                    # 13 MB, no Content-Length
        self.vendor.on("GET", "/endless.mp4", Resp(200, chunks=[b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 100, *endless]))
        with self.assertRaises(AdapterError) as cm:
            adapter(self.vendor, max_result_bytes=1 << 20).fetch(result(f"{self.vendor.base_url}/endless.mp4"), self.tmp)
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertIn("limit", cm.exception.message)
        self.assertEqual(self.files(), [])                                 # neither the file nor a .part

    def test_a_stream_cut_short_leaves_no_file_and_is_retryable(self):
        self.vendor.on("GET", "/cut.mp4", Resp(200, raw=MP4[:100], declared_length=len(MP4)))
        with self.assertRaises(AdapterError) as cm:
            adapter(self.vendor).fetch(result(f"{self.vendor.base_url}/cut.mp4"), self.tmp)
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)                 # the task is still the vendor's: retry
        self.assertTrue(cm.exception.retryable)
        self.assertEqual(self.files(), [])

    def test_an_html_error_page_is_not_a_clip(self):
        self.vendor.on("GET", "/oops.mp4", Resp(200, raw=b"<html><body>signed link expired</body></html>"))
        with self.assertRaises(AdapterError) as cm:
            adapter(self.vendor).fetch(result(f"{self.vendor.base_url}/oops.mp4"), self.tmp)
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertEqual(self.files(), [])

    def test_an_empty_body_is_not_a_clip(self):
        self.vendor.on("GET", "/empty.mp4", Resp(200, raw=b""))
        with self.assertRaises(AdapterError) as cm:
            adapter(self.vendor).fetch(result(f"{self.vendor.base_url}/empty.mp4"), self.tmp)
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertEqual(self.files(), [])

    def test_a_missing_file_is_not_found_not_a_crash(self):
        self.vendor.on("GET", "/gone.mp4", Resp(404, {"error": "gone"}))
        with self.assertRaises(AdapterError) as cm:
            adapter(self.vendor).fetch(result(f"{self.vendor.base_url}/gone.mp4"), self.tmp)
        self.assertEqual(cm.exception.code, E_NOT_FOUND)
        self.assertEqual(self.files(), [])

    def test_a_vendor_that_cannot_be_reached_is_unavailable(self):
        a = adapter(self.vendor)
        url = closed_port_url()
        a.result_ports = (None, 443, int(url.rsplit(":", 1)[1]))
        with self.assertRaises(AdapterError) as cm:
            a.fetch(result(url + "/clip.mp4"), self.tmp)
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)

    def test_inline_images_obey_the_cap_the_type_check_and_the_atomic_write(self):
        a = adapter(self.vendor)
        (path,) = a.fetch(PollResult(SUCCEEDED, [Output("image/png", data=PNG)]), self.tmp, stem="img")
        self.assertEqual(path.read_bytes(), PNG)
        self.assertEqual(self.files(), ["img_0.png"])
        for out, fragment in ((Output("image/png", data=b""), "empty"),
                              (Output("image/png", data=b"<html>"), "not a image/png"),
                              (Output("image/png", data=PNG * 100), "limit")):
            with self.assertRaises(AdapterError, msg=fragment) as cm:
                adapter(self.vendor, max_inline_bytes=1000).fetch(PollResult(SUCCEEDED, [out]), self.tmp, stem="bad")
            self.assertIn(fragment, cm.exception.message)
        self.assertEqual(self.files(), ["img_0.png"])


class SubmitJsonTests(unittest.TestCase):
    """The lost-answer rule: only PROOF that the vendor refused makes a failure "not accepted"."""

    def setUp(self):
        self.vendor = FakeVendor()
        self.addCleanup(self.vendor.close)

    def call(self, **attrs):
        a = Dummy(env={"DUMMY_API_KEY": KEY}, session=self.vendor.session())
        a.base_url = self.vendor.base_url
        for k, v in attrs.items():
            setattr(a, k, v)
        return a.submit_json(f"{a.base_url}/go", {"x": 1})

    def test_a_good_answer_passes_through(self):
        self.vendor.on("POST", "/go", Resp(200, {"id": "t1"}))
        self.assertEqual(self.call(), {"id": "t1"})

    def test_a_dropped_connection_after_the_request_may_have_billed(self):
        self.vendor.on("POST", "/go", Resp(drop=True))
        with self.assertRaises(AdapterError) as cm:
            self.call()
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)
        self.assertFalse(cm.exception.not_accepted)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED))
        self.assertEqual(len(self.vendor.requests), 1)                     # it did arrive

    def test_a_read_timeout_may_have_billed(self):
        self.vendor.on("POST", "/go", Resp(200, {"id": "late"}, hang_s=1.5))
        with self.assertRaises(AdapterError) as cm:
            self.call(timeout=0.4)
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)
        self.assertFalse(cm.exception.not_accepted)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED))

    def test_a_5xx_may_have_billed_even_from_a_gateway(self):
        for status in (500, 502, 504):
            vendor = FakeVendor()
            self.addCleanup(vendor.close)
            vendor.on("POST", "/go", Resp(status, {"error": "bad gateway"}))
            a = Dummy(env={"DUMMY_API_KEY": KEY}, session=vendor.session())
            with self.assertRaises(AdapterError, msg=str(status)) as cm:
                a.submit_json(f"{vendor.base_url}/go", {})
            self.assertFalse(cm.exception.not_accepted, status)
            self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), status)

    def test_a_2xx_that_is_not_json_may_have_billed(self):
        self.vendor.on("POST", "/go", Resp(200, raw=b"<html>ok</html>"))
        with self.assertRaises(AdapterError) as cm:
            self.call()
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertFalse(cm.exception.not_accepted)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED))

    def test_a_connection_that_could_not_be_opened_proves_nothing_was_sent(self):
        a = Dummy(env={"DUMMY_API_KEY": KEY}, session=self.vendor.session())
        with self.assertRaises(AdapterError) as cm:
            a.submit_json(closed_port_url() + "/go", {})
        self.assertTrue(cm.exception.not_accepted)
        self.assertNotIn(UNCONFIRMED, cm.exception.message)

    def test_an_outright_refusal_is_not_dressed_up_as_a_lost_answer(self):
        for status, body in ((401, {"error": "invalid api key"}), (402, {"error": "balance"}),
                             (429, {"error": "slow down"}), (404, {"error": "no such model"})):
            vendor = FakeVendor()
            self.addCleanup(vendor.close)
            vendor.on("POST", "/go", Resp(status, body))
            a = Dummy(env={"DUMMY_API_KEY": KEY}, session=vendor.session())
            with self.assertRaises(AdapterError, msg=str(status)) as cm:
                a.submit_json(f"{vendor.base_url}/go", {})
            self.assertTrue(cm.exception.not_accepted, status)
            self.assertNotIn(UNCONFIRMED, cm.exception.message, status)

    def test_the_vendors_own_400_about_the_request_is_not_a_lost_answer(self):
        self.vendor.on("POST", "/go", Resp(400, {"error": "bad size"}))
        with self.assertRaises(AdapterError) as cm:
            self.call()
        self.assertNotIn(UNCONFIRMED, cm.exception.message)

    def test_a_key_in_the_vendors_error_text_is_scrubbed(self):
        self.vendor.on("POST", "/go", Resp(500, {"error": f"upstream said {KEY}"}))
        with self.assertRaises(AdapterError) as cm:
            self.call()
        self.assertNotIn(KEY, cm.exception.message)


if __name__ == "__main__":
    unittest.main()
