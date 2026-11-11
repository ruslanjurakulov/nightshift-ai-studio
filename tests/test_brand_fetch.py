"""modules/brand_fetch.py: the brand scan's fetcher (docs/ADS_FACTORY.md, Phase 2, "The fetch").

Real sockets, nothing on the internet. A TLS server on 127.0.0.1 plays the customer's site with a certificate signed by
a throw-away CA made here with ``openssl``; an ATTACKER listener on 127.0.0.1 counts every connection that reaches it.
The scan gets a ``_TestNet``: a resolver that maps the test's names to addresses the test chose, and a connect that
sends the two addresses the test calls "the site" to the TLS server and EVERY other address to the attacker. So a scan
that dialled a private answer, a rebound answer or a redirect target it should have refused is seen by the attacker,
and each test asserts the attacker saw nothing.

The addresses that stand for the site are globally routable ones (they pass the address rule as any real site would);
nothing ever connects to them, the test connect routes them to loopback. The address rule itself has no switch: a
resolver answering 127.0.0.1 is refused like any other (``DefaultPathHasNoWayAround``).
"""

from __future__ import annotations

import gzip
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from modules import brand_fetch as bf
from modules.brand_fetch import BrandFetchError, Budget, SiteScan, _TestNet

ROOT = Path(__file__).resolve().parent.parent

SITE = "brand-shop.test"
WWW = "www.brand-shop.test"
SITE_IP = "93.184.215.14"        # stands for the site; routed to the TLS server
WWW_IP = "93.184.215.15"
OTHER_IP = "151.101.1.1"         # a public answer for a name the scan must not follow; routed to the attacker
SITE_ADDRS = {SITE_IP, WWW_IP}

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64

_CERTS: dict = {}


def setUpModule():
    d = Path(tempfile.mkdtemp(prefix="brand_fetch_ca_"))
    _CERTS["dir"] = d

    def run(*args):
        subprocess.run(["openssl", *args], check=True, capture_output=True, timeout=60, cwd=d)

    run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", "ca.key", "-out", "ca.pem",
        "-subj", "/CN=Brand Fetch Test CA", "-addext", "basicConstraints=critical,CA:TRUE",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign")
    run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", f"/CN={SITE}")
    (d / "ext.cnf").write_text(f"subjectAltName=DNS:{SITE},DNS:*.{SITE}\nbasicConstraints=CA:FALSE\n"
                               "keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
    run("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2",
        "-out", "leaf.pem", "-extfile", "ext.cnf")


def tearDownModule():
    shutil.rmtree(_CERTS.pop("dir"), ignore_errors=True)


def client_tls() -> ssl.SSLContext:
    return ssl.create_default_context(cafile=str(_CERTS["dir"] / "ca.pem"))


# ── the servers ───────────────────────────────────────────────────────────────────────────────────────────────────

def answer(status=200, body=b"", ctype="text/html; charset=utf-8", headers=(), length=True) -> bytes:
    lines = [f"HTTP/1.1 {status} X"]
    if ctype:
        lines.append(f"Content-Type: {ctype}")
    lines += list(headers)
    if length:
        lines.append(f"Content-Length: {len(body)}")
    lines.append("Connection: close")
    return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + body


def redirect(location, status=302) -> bytes:
    return answer(status, b"", ctype="", headers=(f"Location: {location}",))


class Seen:
    def __init__(self, host, path, headers):
        self.host, self.path, self.headers = host, path, headers


class SiteServer:
    """A TLS server on 127.0.0.1 answering by (Host, path); robots.txt is a 404 unless a test sets one."""

    def __init__(self):
        self.ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.ctx.load_cert_chain(str(_CERTS["dir"] / "leaf.pem"), str(_CERTS["dir"] / "leaf.key"))
        self.sni = []
        self.ctx.sni_callback = lambda s, name, c: self.sni.append(name)
        self.routes, self.seen, self._lock = {}, [], threading.Lock()
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(64)
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self._loop, daemon=True).start()

    def on(self, path, spec, host=SITE):
        self.routes[(host, path)] = spec
        return self

    def paths(self, host=SITE):
        with self._lock:
            return [s.path for s in self.seen if s.host == host]

    def _loop(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn):
        try:
            conn.settimeout(10)
            tls = self.ctx.wrap_socket(conn, server_side=True)
        except (OSError, ssl.SSLError):
            conn.close()
            return
        try:
            data = b""
            while b"\r\n\r\n" not in data and len(data) < 65536:
                chunk = tls.recv(4096)
                if not chunk:
                    return
                data += chunk
            lines = data.split(b"\r\n\r\n", 1)[0].decode("latin-1").split("\r\n")
            _, path, _ = lines[0].split(" ")
            headers = {}
            for line in lines[1:]:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
            host = headers.get("host", "")
            with self._lock:
                self.seen.append(Seen(host, path, headers))
                spec = self.routes.get((host, path), answer(404, b"no", ctype="text/plain"))
            if callable(spec):
                spec(tls)
            else:
                tls.sendall(spec)
        except (OSError, ssl.SSLError, ValueError):
            pass
        finally:
            try:
                tls.close()
            except OSError:
                pass

    def close(self):
        self.sock.close()


class Attacker:
    """Counts every connection that reaches it. Every test asserts zero."""

    def __init__(self):
        self.hits = 0
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(64)
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            self.hits += 1
            conn.close()

    def close(self):
        self.sock.close()


class Base(unittest.TestCase):
    def setUp(self):
        self.server, self.attacker = SiteServer(), Attacker()
        self.addCleanup(self.server.close)
        self.addCleanup(self.attacker.close)
        self.resolved, self.dialed = [], []
        self.names = {SITE: [SITE_IP], WWW: [WWW_IP]}

    def tearDown(self):
        time.sleep(0.02)                      # let an accept that is in flight land before the count is read
        self.assertEqual(self.attacker.hits, 0, "a connection reached the attacker")

    def net(self, tls=None) -> _TestNet:
        def resolve(host):
            self.resolved.append(host)
            v = self.names.get(host)
            if v is None:
                raise socket.gaierror(socket.EAI_NONAME, "unknown")
            return v() if callable(v) else v

        def connect(ip, timeout):
            self.dialed.append(ip)
            port = self.server.port if ip in SITE_ADDRS else self.attacker.port
            return socket.create_connection(("127.0.0.1", port), timeout=timeout)

        return _TestNet(resolve=resolve, connect=connect, tls=tls or client_tls())

    def scan(self, url=f"https://{SITE}/", budget=None, tls=None) -> SiteScan:
        return SiteScan(url, budget=budget, _test_net=self.net(tls))

    def refused(self, code, fn, *args):
        with self.assertRaises(BrandFetchError) as cm:
            fn(*args)
        self.assertEqual(cm.exception.code, code, cm.exception.message)
        return cm.exception


# ── the address rule ──────────────────────────────────────────────────────────────────────────────────────────────

REFUSED_ADDRESSES = [
    ("10.0.0.7", "private"), ("172.16.5.4", "private"), ("192.168.1.1", "private"),
    ("127.0.0.1", "loopback"), ("127.8.9.10", "loopback"), ("::1", "loopback"),
    ("169.254.1.1", "link-local"), ("fe80::1", "link-local"), ("fe80::1%1", "scoped"),
    ("100.64.0.1", "carrier-grade"), ("100.127.255.254", "carrier-grade"),
    ("224.0.0.1", "multicast"), ("239.255.255.250", "multicast"), ("ff02::1", "multicast"), ("ff0e::1", "multicast"),
    ("240.0.0.1", "reserved"), ("255.255.255.255", "reserved"),
    ("0.0.0.0", "unspecified"), ("::", "unspecified"),
    ("169.254.169.254", "metadata"), ("fd00:ec2::254", "metadata"), ("100.100.100.200", "metadata"),
    ("fc00::1", "private"), ("fd12:3456::1", "private"), ("fec0::1", "site-local"),
    ("::ffff:127.0.0.1", "IPv4-mapped"), ("::ffff:10.0.0.1", "IPv4-mapped"), ("::ffff:8.8.8.8", "IPv4-mapped"),
    ("::ffff:169.254.169.254", "IPv4-mapped"),
    ("::127.0.0.1", "IPv4-compatible"), ("::10.0.0.1", "IPv4-compatible"), ("::8.8.8.8", "IPv4-compatible"),
    ("2002:7f00:1::", "6to4 address of a loopback"), ("2002:a00:1::1", "6to4 address of a private"),
    ("2002:a9fe:a9fe::", "6to4 address of a cloud metadata"), ("2002:808:808::1", "6to4"),
    # Teredo: server 65.54.227.120, client obfuscated (XOR 0xffffffff) — 127.0.0.1 and 10.0.0.1 here.
    ("2001:0:4136:e378:8000:63bf:80ff:fffe", "Teredo address of a loopback"),
    ("2001:0:4136:e378:8000:63bf:f5ff:fffe", "Teredo address of a private"),
    ("64:ff9b::7f00:1", "NAT64 address of a loopback"), ("64:ff9b::a00:1", "NAT64 address of a private"),
    ("64:ff9b::a9fe:a9fe", "NAT64 address of a cloud metadata"), ("64:ff9b::6440:1", "NAT64 address of a carrier"),
    ("64:ff9b:1::a00:1", "local-use NAT64"),
    ("192.0.2.1", "documentation"), ("198.51.100.1", "documentation"), ("203.0.113.1", "documentation"),
    ("2001:db8::1", "documentation"), ("3fff::1", "documentation"),
    ("198.18.0.1", "benchmarking"), ("192.0.0.8", "IETF protocol"), ("192.0.0.192", "IETF protocol"),
    ("192.88.99.1", "6to4 relay"), ("0.1.2.3", "this network"), ("100::1", "reserved"), ("0:1::1", "(::/8)"),
    ("2001:2::1", "IETF protocol"), ("5f00::1", "SRv6"), ("4000::1", "outside IPv6 global unicast"),
    ("e000::1", "outside IPv6 global unicast"),
    # Public embeddings: a NAT64 or Teredo address is refused whatever it carries (a worker behind DNS64 cannot scan).
    ("64:ff9b::808:808", "a NAT64 address"), ("2001:0:4136:e378:8000:63bf:f7f7:f7f7", "a Teredo address"),
    ("not-an-ip", "not an IP"),
]
PUBLIC_ADDRESSES = ["93.184.215.14", "8.8.8.8", "1.1.1.1", "2606:4700::1111", "2a00:1450:4001:81c::200e"]


class AddressRule(Base):
    def test_every_refused_class_is_named(self):
        for addr, word in REFUSED_ADDRESSES:
            with self.subTest(addr=addr):
                problem = bf.address_problem(addr)
                self.assertIsNotNone(problem, addr)
                self.assertIn(word, problem)

    def test_public_addresses_pass(self):
        for addr in PUBLIC_ADDRESSES:
            self.assertIsNone(bf.address_problem(addr), addr)

    def test_a_name_that_resolves_to_any_refused_class_is_never_dialled(self):
        for addr, word in REFUSED_ADDRESSES:
            with self.subTest(addr=addr):
                self.names[SITE] = [addr]
                e = self.refused(bf.E_NOT_PUBLIC, self.scan().home)
                self.assertIn(word, e.message)
        self.assertEqual(self.dialed, [])

    def test_one_private_answer_among_public_ones_refuses_the_name(self):
        for answers in ([SITE_IP, "10.0.0.1"], ["10.0.0.1", SITE_IP], [SITE_IP, "::ffff:127.0.0.1"]):
            self.names[SITE] = answers
            self.refused(bf.E_NOT_PUBLIC, self.scan().home)
        self.assertEqual(self.dialed, [])

    def test_no_answer_or_a_failed_lookup_is_a_dns_error(self):
        self.names[SITE] = []
        self.refused(bf.E_DNS, self.scan().home)
        del self.names[SITE]
        self.refused(bf.E_DNS, self.scan().home)
        self.assertEqual(self.dialed, [])


class DefaultPathHasNoWayAround(unittest.TestCase):
    """Production code never passes ``_test_net``: the system resolver and connect are used, and the rule holds there."""

    def test_the_system_resolver_answering_loopback_is_refused_and_nothing_connects(self):
        connects = []
        real = socket.getaddrinfo

        def fake(host, *a, **k):
            if host == SITE + ".":
                return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]
            return real(host, *a, **k)

        with mock.patch.object(socket, "getaddrinfo", fake), \
                mock.patch.object(socket.socket, "connect", lambda s, addr: connects.append(addr)):
            with self.assertRaises(BrandFetchError) as cm:
                SiteScan(f"https://{SITE}/").home()
        self.assertEqual(cm.exception.code, bf.E_NOT_PUBLIC)
        self.assertIn("loopback", cm.exception.message)
        self.assertEqual(connects, [])

    def test_the_test_hook_cannot_switch_the_rule_off_either(self):
        net = _TestNet(resolve=lambda h: ["127.0.0.1"], connect=lambda ip, t: self.fail("dialled"), tls=client_tls())
        with self.assertRaises(BrandFetchError) as cm:
            SiteScan(f"https://{SITE}/", _test_net=net).home()
        self.assertEqual(cm.exception.code, bf.E_NOT_PUBLIC)

    def test_only_a_real_test_hook_object_is_accepted(self):
        class Lookalike:
            resolve = connect = tls = None
        with self.assertRaises(TypeError):
            SiteScan(f"https://{SITE}/", _test_net=Lookalike())

    def test_the_default_tls_context_verifies_the_name_on_tls_1_2_or_later(self):
        ctx = bf._system_tls()
        self.assertTrue(ctx.check_hostname)
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
        self.assertGreaterEqual(ctx.minimum_version, ssl.TLSVersion.TLSv1_2)

    def test_nothing_but_this_module_and_its_tests_names_the_test_hook_or_imports_the_module(self):
        files = [ROOT / "main.py", ROOT / "config.py", *(ROOT / "modules").rglob("*.py"), *(ROOT / "tools").rglob("*.py"),
                 *(ROOT / "deploy").rglob("*.py"),
                 *(p for p in (ROOT / "command-center").rglob("*.py") if "node_modules" not in p.parts)]
        self.assertIn(ROOT / "deploy" / "build-worker-env.py", files, "the widened scan really reaches deploy/")
        hook, users = [], []
        for path in files:
            if path.name == "brand_fetch.py":
                continue
            text = path.read_text(encoding="utf-8")
            if "_TestNet" in text or "_test_net" in text:
                hook.append(path.name)
            if "brand_fetch" in text:
                users.append(path.name)
        self.assertEqual(hook, [])
        self.assertEqual(users, [], "the fetcher is dark: wiring it into a job is a later, owner-approved step")

    def test_no_http_library_that_follows_redirects_or_keeps_cookies_is_used(self):
        src = (ROOT / "modules" / "brand_fetch.py").read_text(encoding="utf-8")
        for banned in ("import requests", "import urllib3", "from urllib3", "urllib.request", "allow_redirects",
                       "http.cookiejar", "create_connection("):
            self.assertNotIn(banned, src)


# ── the URL rule ──────────────────────────────────────────────────────────────────────────────────────────────────

REFUSED_ENTRY = [
    None, "", "http://brand-shop.test/", "HTTPS://brand-shop.test/", "ftp://brand-shop.test/",
    "https://brand-shop.test:443/", "https://brand-shop.test:8443/", "https://brand-shop.test:/",
    "https://user:pw@brand-shop.test/", "https://user@brand-shop.test/", "https://:@brand-shop.test/",
    "https://bränd-shop.test/", "https://brand-shop.tést/", "https://BRAND-shop.test/",
    "https://127.0.0.1/", "https://[::1]/", "https://localhost/", "https://brand-shop.test./", "https://a.1/",
    "https://-brand.test/", "https://brand-.test/", "https://brand_shop.test/",
    "https://brand-shop.test\\@evil.test/", "https://brand-shop.test/\n", "https://brand-shop.test/a b",
    "https://brand-shop.test?x=1", "https://brand-shop.test#x", "https://brand-shop.test/" + "a" * 300,
    "https://a.b", "https://brand-shop.test/\x7f",
    # 0131 lets a backslash through in the path; the worker does not (two URL parsers disagree on it).
    "https://brand-shop.test/a\\b",
]
ACCEPTED_ENTRY = ["https://brand-shop.test", "https://brand-shop.test/", "https://xn--brnd-shop-r5a.test/x?y=1",
                  "https://www.brand-shop.co.uk/p/1", "https://a.co"]


class UrlRule(Base):
    def test_the_entry_url_is_held_to_0131s_shape(self):
        for url in REFUSED_ENTRY:
            with self.subTest(url=url):
                with self.assertRaises(BrandFetchError) as cm:
                    SiteScan(url, _test_net=self.net())
                self.assertEqual(cm.exception.code, bf.E_BAD_URL)
        for url in ACCEPTED_ENTRY:
            bf.check_entry_url(url)
        self.assertEqual(self.resolved, [])

    def test_the_mirrored_pattern_is_0131s(self):
        sql = (ROOT / "supabase" / "migrations" / "0131_ads_factory.sql").read_text(encoding="utf-8")
        self.assertIn(r"char_length(p_url) between 12 and 300", sql)
        self.assertIn(r"'^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(xn--[a-z0-9-]{1,59}|[a-z]{2,63})"
                      r"(/[\x21-\x7e]*)?$'", sql)
        self.assertIn(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:xn--[a-z0-9-]{1,59}|[a-z]{2,63}))"
                      r"(/[\x21-\x7e]*)?\Z", bf._SHAPE.pattern)

    def test_a_derived_url_is_brought_to_the_shape_or_refused(self):
        base = f"https://{SITE}/a/b"
        self.assertEqual(bf.derive_url(base, "../c?q=1#frag"), f"https://{SITE}/c?q=1")
        self.assertEqual(bf.derive_url(base, f"https://{SITE}:443/x"), f"https://{SITE}/x")
        self.assertEqual(bf.derive_url(base, "https://WWW.Brand-Shop.test/X"), "https://www.brand-shop.test/X")
        self.assertEqual(bf.derive_url(base, "/ü ber"), f"https://{SITE}/%C3%BC%20ber")
        self.assertEqual(bf.derive_url(base, "//other-brand.test/x"), "https://other-brand.test/x")
        for ref in ("http://brand-shop.test/", "https://brand-shop.test:8443/", "https://u@brand-shop.test/",
                    "https://u:p@brand-shop.test/", "javascript:alert(1)", "mailto:a@b.test", "data:text/html,x",
                    "https://bränd.test/", "https://10.0.0.1/", "https://[::1]/", "https://brand-shop.test\\evil.test/",
                    "https://brand-shop.test:99999/", "   ", "/" + "a" * 3000, "/a\\b"):
            with self.subTest(ref=ref):
                with self.assertRaises(BrandFetchError) as cm:
                    bf.derive_url(base, ref)
                self.assertEqual(cm.exception.code, bf.E_BAD_URL)

    def test_the_site_rule_is_the_entry_host_its_subdomains_and_the_www_apex_twin(self):
        self.assertTrue(bf.same_site(SITE, SITE))
        self.assertTrue(bf.same_site("www.brand-shop.test", SITE))
        self.assertTrue(bf.same_site(SITE, "www.brand-shop.test"))
        self.assertTrue(bf.same_site("cdn.shop.brand-shop.test", "shop.brand-shop.test"))
        self.assertTrue(bf.same_site("img.www.brand-shop.test", "www.brand-shop.test"))
        self.assertFalse(bf.same_site("store.brand-shop.test", "www.brand-shop.test"), "a sibling is not the entry")
        self.assertFalse(bf.same_site("brand-shop.test", "shop.brand-shop.test"), "the parent is not the entry")
        self.assertFalse(bf.same_site("www2.brand-shop.test", "www.brand-shop.test"))
        self.assertFalse(bf.same_site("evilbrand-shop.test", SITE))
        self.assertFalse(bf.same_site("brand-shop.test.evil.test", SITE))
        self.assertFalse(bf.same_site("other-brand.test", SITE))
        self.assertFalse(bf.same_site("evil.co.uk", "shop.co.uk"))
        self.assertFalse(bf.same_site("www.test", "w.test"))
        for parent in ("myshopify.com", "github.io", "vercel.app", "s3.amazonaws.com", "netlify.app"):
            with self.subTest(parent=parent):
                self.assertFalse(bf.same_site(f"victim.{parent}", f"attacker.{parent}"), "tenants are not one site")
                self.assertFalse(bf.same_site(f"www.victim.{parent}", f"attacker.{parent}"))

    def test_a_redirect_to_a_sibling_of_the_entry_host_is_not_followed_or_resolved(self):
        # The shared-hosting shape: attacker.<parent> sending the scan to victim.<parent>. Here the entry is the www host
        # and the sibling is store.<parent>; the certificate covers both, so only the site rule can stop it.
        self.names["store.brand-shop.test"] = [OTHER_IP]
        self.server.on("/", redirect("https://store.brand-shop.test/"), host=WWW)
        self.refused(bf.E_OFF_SITE, self.scan(f"https://{WWW}/").home)
        self.assertNotIn("store.brand-shop.test", self.resolved)


# ── a scan that works ─────────────────────────────────────────────────────────────────────────────────────────────

HOME = (b"<html><head><title>Brand</title></head><body>"
        b"<a href='/about'>About</a> <a href=\"/products/a\">A</a> <a href='/products/a#top'>A again</a>"
        b"<a href='https://other-brand.test/x'>Other</a> <a href='//www.brand-shop.test/w'>www</a>"
        b"<a href='mailto:hi@brand-shop.test'>mail</a> <a href='javascript:alert(1)'>js</a>"
        b"<a href='/products/b?c=1&amp;d=2'>B</a> <a href='http://brand-shop.test/plain'>plain</a>"
        b"<a href='https://brand-shop.test:8443/port'>port</a></body></html>")


class HappyPath(Base):
    def setUp(self):
        super().setUp()
        self.server.on("/", answer(200, HOME, headers=("Set-Cookie: session=abc; Path=/",)))
        for p in ("/about", "/products/a", "/products/b?c=1&d=2"):
            self.server.on(p, answer(200, b"<html>" + p.encode() + b"</html>"))

    def test_home_and_same_host_pages_product_pages_first(self):
        pages, skipped = self.scan().pages()
        self.assertEqual([p.url for p in pages], [f"https://{SITE}/", f"https://{SITE}/products/a",
                                                  f"https://{SITE}/products/b?c=1&d=2", f"https://{SITE}/about"])
        self.assertEqual(skipped, [])
        self.assertEqual({p.content_type for p in pages}, {"text/html"})
        self.assertEqual(pages[1].body, b"<html>/products/a</html>")
        self.assertEqual(self.server.paths(WWW), [], "a link to another host is not a page of this one")
        self.assertNotIn("/plain", self.server.paths())
        self.assertNotIn("/port", self.server.paths())

    def test_robots_is_read_first_and_the_request_is_honest_and_stateless(self):
        self.scan().pages()
        seen = self.server.seen
        self.assertEqual(seen[0].path, "/robots.txt")
        self.assertEqual(len([s for s in seen if s.path == "/robots.txt"]), 1, "one robots.txt per host per scan")
        for s in seen:
            self.assertEqual(s.host, SITE)
            self.assertIn("Nightshift", s.headers["user-agent"])
            self.assertIn("https://nightshift-ai.studio/", s.headers["user-agent"])
            self.assertEqual(s.headers["accept-encoding"], "identity")
            self.assertNotIn("cookie", s.headers, "a Set-Cookie is never sent back")
            self.assertNotIn("authorization", s.headers)
        self.assertEqual(set(self.server.sni), {SITE}, "SNI carries the name, not the address")
        self.assertEqual(self.resolved, [SITE], "one lookup for the whole scan")
        self.assertEqual(set(self.dialed), {SITE_IP})

    def test_assets_are_read_with_their_own_caps_and_types(self):
        self.server.on("/s.css", answer(200, b"body{font-family:Inter}", ctype="text/css"))
        self.server.on("/logo.png", answer(200, PNG, ctype="image/png"))
        self.server.on("/logo.jpg", answer(200, JPEG, ctype="image/jpeg"), host=WWW)
        s = self.scan()
        self.assertEqual(s.css(f"https://{SITE}/s.css").body, b"body{font-family:Inter}")
        self.assertEqual(s.image(f"https://{SITE}/logo.png").content_type, "image/png")
        self.assertEqual(s.image(f"https://{WWW}/logo.jpg").url, f"https://{WWW}/logo.jpg")


class LinkList(unittest.TestCase):
    def test_it_is_bounded_and_same_host(self):
        html = b"".join(b"<a href='/p/%d'>x</a><a href='https://evil.test/%d'>y</a>" % (i, i) for i in range(3000))
        links = bf.same_host_links(html, f"https://{SITE}/")
        self.assertEqual(len(links), bf.MAX_LINKS)
        self.assertTrue(all(u.startswith(f"https://{SITE}/p/") for u in links))
        self.assertEqual(bf.same_host_links(html, f"https://{SITE}/", limit=3),
                         [f"https://{SITE}/p/0", f"https://{SITE}/p/1", f"https://{SITE}/p/2"])

    def test_hostile_markup_ends_the_list_quietly(self):
        for html in (b"<a href='/x'>" + b"<" * 100000, b"\xff\xfe<a href='/y'", b"<a href=" + b"'" * 5000):
            bf.same_host_links(html, f"https://{SITE}/")


# ── redirects ─────────────────────────────────────────────────────────────────────────────────────────────────────

class Redirects(Base):
    def test_a_redirect_to_the_www_host_of_the_same_site_is_followed_and_checked(self):
        self.server.on("/", redirect(f"https://{WWW}/"))
        self.server.on("/", answer(200, b"<html>www</html>"), host=WWW)
        page = self.scan().home()
        self.assertEqual(page.url, f"https://{WWW}/")
        self.assertEqual(self.server.paths(WWW), ["/robots.txt", "/"], "the new host's robots.txt is read first")
        self.assertEqual(self.resolved, [SITE, WWW])

    def test_a_redirect_location_is_normalised_before_it_is_checked(self):
        self.server.on("/", redirect("https://WWW.Brand-Shop.test:443/Start"))
        self.server.on("/Start", answer(200, b"<html>www</html>"), host=WWW)
        self.assertEqual(self.scan().home().url, f"https://{WWW}/Start")

    def test_a_redirect_to_a_same_site_host_with_a_private_address_is_refused(self):
        self.names["internal.brand-shop.test"] = ["10.0.0.8"]
        self.server.on("/", redirect("https://internal.brand-shop.test/admin"))
        self.refused(bf.E_NOT_PUBLIC, self.scan().home)
        self.assertNotIn("10.0.0.8", self.dialed)

    def test_redirects_to_refused_shapes_are_not_followed(self):
        for loc in ("http://brand-shop.test/", f"https://{SITE}:8443/", "https://10.0.0.1/", "https://[::1]/",
                    f"https://u:p@{SITE}/", "https://169.254.169.254/latest/meta-data/"):
            with self.subTest(loc=loc):
                self.server.on("/", redirect(loc))
                self.refused(bf.E_BAD_URL, self.scan().home)
        self.assertEqual(set(self.dialed), {SITE_IP})

    def test_a_redirect_to_another_domain_is_not_followed_or_even_resolved(self):
        self.names["other-brand.test"] = [OTHER_IP]
        for loc in ("https://other-brand.test/", "//other-brand.test/x", "https://brand-shop.test.other-brand.test/"):
            self.server.on("/", redirect(loc, 301))
            self.refused(bf.E_OFF_SITE, self.scan().home)
        self.assertEqual(set(self.resolved), {SITE})

    def test_three_hops_are_followed_and_a_fourth_is_not(self):
        for i in range(1, 5):
            self.server.on(f"/r{i}", redirect(f"/r{i + 1}", (301, 302, 303, 307, 308)[i % 5]))
        self.server.on("/r5", answer(200, b"<html>end</html>"))
        self.assertEqual(self.scan(f"https://{SITE}/r2").home().url, f"https://{SITE}/r5")
        self.server.seen.clear()
        self.refused(bf.E_TOO_MANY_REDIRECTS, self.scan(f"https://{SITE}/r1").home)
        self.assertNotIn("/r5", self.server.paths())

    def test_a_redirect_without_a_location_or_another_3xx_is_refused(self):
        self.server.on("/", answer(302, b"", ctype=""))
        self.refused(bf.E_REDIRECT, self.scan().home)
        self.server.on("/", answer(304, b"", ctype=""))
        self.refused(bf.E_HTTP, self.scan().home)


class Rebinding(Base):
    def test_the_first_answer_is_pinned_for_the_whole_scan(self):
        answers = [[SITE_IP], ["127.0.0.1"], ["10.0.0.1"]]
        self.names[SITE] = lambda: answers.pop(0) if len(answers) > 1 else answers[0]
        self.server.on("/", answer(200, b"<a href='/products/a'>a</a><a href='/products/b'>b</a>"))
        self.server.on("/products/a", answer(200, b"a"))
        self.server.on("/products/b", redirect(f"https://{SITE}/products/a"))
        pages, skipped = self.scan().pages()
        self.assertEqual(len(pages), 3)
        self.assertEqual(self.resolved, [SITE], "the name is never looked up twice")
        self.assertEqual(set(self.dialed), {SITE_IP})


# ── bounds ────────────────────────────────────────────────────────────────────────────────────────────────────────

def chunked(ctype, chunk, count):
    def send(tls):
        tls.sendall(f"HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nTransfer-Encoding: chunked\r\n\r\n".encode())
        for _ in range(count):
            tls.sendall(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
        tls.sendall(b"0\r\n\r\n")
    return send


def drip(head: bytes, body: bytes, every: float):
    def send(tls):
        tls.sendall(head)
        for i in range(len(body)):
            tls.sendall(body[i:i + 1])
            time.sleep(every)
    return send


class Caps(Base):
    def test_a_declared_length_over_the_cap_is_refused_before_the_body(self):
        cases = [("/", bf.HTML, "text/html", bf.MAX_BYTES[bf.HTML] + 1), ("/s.css", bf.CSS, "text/css", 256 * 1024 + 1),
                 ("/i.png", bf.IMAGE, "image/png", 5 * 1024 * 1024 + 1)]
        for path, kind, ctype, n in cases:
            with self.subTest(kind=kind):
                head = f"HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {n}\r\n\r\n".encode()
                self.server.on(path, head + PNG)          # the body never comes: only the header can refuse it in time
                s = self.scan(budget=Budget(3))
                fetch = {bf.HTML: s.home, bf.CSS: s.css, bf.IMAGE: s.image}[kind]
                args = () if kind == bf.HTML else (f"https://{SITE}{path}",)
                e = self.refused(bf.E_TOO_LARGE, fetch, *args)
                self.assertIn(str(n), e.message)

    def test_the_caps_are_the_documented_numbers(self):
        self.assertEqual(bf.MAX_BYTES, {"html": 1536 * 1024, "css": 256 * 1024, "image": 5 * 1024 * 1024,
                                        "robots": 500 * 1024})
        self.assertEqual(bf.MAX_COUNT, {"html": 6, "css": 4, "image": 6})
        self.assertEqual((bf.CONNECT_TIMEOUT_S, bf.READ_TIMEOUT_S, bf.SCAN_WALL_CLOCK_S, bf.MAX_HOPS), (5, 10, 30, 3))

    def test_a_body_with_no_length_is_stopped_at_the_cap(self):
        self.server.on("/", chunked("text/html", b"x" * 65536, 30))
        self.refused(bf.E_TOO_LARGE, self.scan().home)
        self.server.on("/s.css", chunked("text/css", b"x" * 4096, 70))
        self.refused(bf.E_TOO_LARGE, self.scan().css, f"https://{SITE}/s.css")

    def test_a_body_just_under_the_cap_is_read(self):
        self.server.on("/s.css", chunked("text/css", b"x" * 1024, 256))
        self.assertEqual(len(self.scan().css(f"https://{SITE}/s.css").body), 256 * 1024)

    def test_a_header_flood_is_stopped(self):
        flood = "".join(f"X-Pad-{i}: {'p' * 2000}\r\n" for i in range(40))
        self.server.on("/", f"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n{flood}Content-Length: 2\r\n\r\nok".encode())
        self.refused(bf.E_TOO_LARGE, self.scan().home)

    def test_the_counts_per_kind(self):
        self.server.on("/", answer(200, b"<html></html>"))
        for i in range(8):
            self.server.on(f"/p{i}", answer(200, b"<html></html>"))
            self.server.on(f"/s{i}.css", answer(200, b"a{}", ctype="text/css"))
            self.server.on(f"/i{i}.png", answer(200, PNG, ctype="image/png"))
        s = self.scan()
        s.home()
        for i in range(5):
            s.page(f"https://{SITE}/p{i}")
        self.refused(bf.E_LIMIT, s.page, f"https://{SITE}/p5")
        for i in range(4):
            s.css(f"https://{SITE}/s{i}.css")
        self.refused(bf.E_LIMIT, s.css, f"https://{SITE}/s4.css")
        for i in range(6):
            s.image(f"https://{SITE}/i{i}.png")
        self.refused(bf.E_LIMIT, s.image, f"https://{SITE}/i6.png")
        paths = self.server.paths()
        self.assertNotIn("/p5", paths)
        self.assertNotIn("/s4.css", paths)
        self.assertNotIn("/i6.png", paths)

    def test_pages_ask_for_at_most_six(self):
        links = b"".join(b"<a href='/products/%d'>p</a>" % i for i in range(20))
        self.server.on("/", answer(200, links))
        for i in range(20):
            self.server.on(f"/products/{i}", answer(200, b"<html></html>"))
        pages, _ = self.scan().pages()
        self.assertEqual(len(pages), 6)
        self.assertEqual(len([p for p in self.server.paths() if p.startswith("/products/")]), 5)

    def test_a_page_on_another_host_is_refused_even_on_the_same_site(self):
        self.server.on("/", answer(200, b"<html></html>"))
        s = self.scan()
        self.refused(bf.E_LIMIT, s.page, f"https://{SITE}/x")      # the home page first
        s.home()
        self.refused(bf.E_OFF_SITE, s.page, f"https://{WWW}/x")
        self.assertEqual(self.server.paths(WWW), [])

    def test_an_asset_on_another_domain_is_not_fetched(self):
        self.names["cdn.other-brand.test"] = [OTHER_IP]
        s = self.scan()
        self.refused(bf.E_OFF_SITE, s.css, "https://cdn.other-brand.test/s.css")
        self.refused(bf.E_OFF_SITE, s.image, "https://cdn.other-brand.test/logo.png")
        self.assertEqual(self.resolved, [])


class WallClock(Base):
    def test_a_slow_drip_body_is_cut_at_the_scan_budget(self):
        head = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 100\r\n\r\n"
        self.server.on("/", drip(head, b"x" * 100, 0.1))
        t = time.monotonic()
        self.refused(bf.E_TIMEOUT, self.scan(budget=Budget(1.0)).home)
        self.assertLess(time.monotonic() - t, 2.5)

    def test_slow_drip_headers_are_cut_too(self):
        self.server.on("/", drip(b"", b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n" + b"X: y\r\n" * 50, 0.05))
        t = time.monotonic()
        self.refused(bf.E_TIMEOUT, self.scan(budget=Budget(1.0)).home)
        self.assertLess(time.monotonic() - t, 2.5)

    def test_one_budget_spans_every_call_of_the_scan(self):
        now = [0.0]
        budget = Budget(30, clock=lambda: now[0])
        self.server.on("/", answer(200, b"<a href='/products/a'>a</a>"))
        s = self.scan(budget=budget)
        s.home()
        now[0] = 30.0
        self.refused(bf.E_TIMEOUT, s.page, f"https://{SITE}/products/a")
        self.assertNotIn("/products/a", self.server.paths())

    def test_the_connect_wait_is_capped_by_what_is_left_of_the_budget(self):
        net = self.net()
        waits = []

        def connect(ip, timeout):
            waits.append(timeout)
            return net.connect(ip, timeout)

        self.server.on("/", answer(200, b"<html></html>"))
        SiteScan(f"https://{SITE}/", budget=Budget(2), _test_net=_TestNet(net.resolve, connect, net.tls)).home()
        self.assertTrue(waits and all(w <= 2 for w in waits), waits)

    def test_a_caller_cannot_buy_a_longer_budget(self):
        self.assertLessEqual(Budget(3600).remaining(), bf.SCAN_WALL_CLOCK_S)
        self.assertLessEqual(Budget(-5).remaining(), 0)


class Encodings(Base):
    def test_a_compressed_answer_is_refused(self):
        body = gzip.compress(b"<html>" + b"a" * 10000 + b"</html>")
        self.server.on("/", answer(200, body, headers=("Content-Encoding: gzip",)))
        self.refused(bf.E_COMPRESSED, self.scan().home)
        self.server.on("/", answer(200, body, headers=("Content-Encoding: br",)))
        self.refused(bf.E_COMPRESSED, self.scan().home)
        self.assertEqual({s.headers["accept-encoding"] for s in self.server.seen}, {"identity"})

    def test_a_transfer_coding_other_than_chunked_is_refused(self):
        body = gzip.compress(b"<html></html>")
        self.server.on("/", answer(200, body, headers=("Transfer-Encoding: gzip, chunked",), length=False))
        self.refused(bf.E_COMPRESSED, self.scan().home)

    def test_identity_is_read(self):
        self.server.on("/", answer(200, b"<html>ok</html>", headers=("Content-Encoding: identity",)))
        self.assertEqual(self.scan().home().body, b"<html>ok</html>")


class ContentTypes(Base):
    def test_a_wrong_type_for_the_kind_is_refused(self):
        self.server.on("/", answer(200, b"{}", ctype="application/json"))
        self.refused(bf.E_CONTENT_TYPE, self.scan().home)
        self.server.on("/", answer(200, b"<html></html>", ctype=""))
        self.refused(bf.E_CONTENT_TYPE, self.scan().home)
        self.server.on("/x.css", answer(200, b"<html></html>", ctype="text/html"))
        self.refused(bf.E_CONTENT_TYPE, self.scan().css, f"https://{SITE}/x.css")
        self.server.on("/x.png", answer(200, b"<html></html>", ctype="text/html"))
        self.refused(bf.E_CONTENT_TYPE, self.scan().image, f"https://{SITE}/x.png")
        self.server.on("/x.gif", answer(200, b"GIF89a", ctype="image/gif"))
        self.refused(bf.E_CONTENT_TYPE, self.scan().image, f"https://{SITE}/x.gif")

    def test_svg_is_refused_as_svg(self):
        self.server.on("/logo.svg", answer(200, b"<svg onload='x()'/>", ctype="image/svg+xml"))
        self.refused(bf.E_SVG, self.scan().image, f"https://{SITE}/logo.svg")
        self.server.on("/", answer(200, b"<svg/>", ctype="image/svg+xml; charset=utf-8"))
        self.refused(bf.E_SVG, self.scan().home)

    def test_a_picture_whose_bytes_are_another_type_is_refused(self):
        self.server.on("/a.png", answer(200, JPEG, ctype="image/png"))
        self.refused(bf.E_CONTENT_TYPE, self.scan().image, f"https://{SITE}/a.png")
        self.server.on("/b.png", answer(200, b"", ctype="image/png"))
        self.refused(bf.E_CONTENT_TYPE, self.scan().image, f"https://{SITE}/b.png")

    def test_an_error_status_is_refused(self):
        for status in (404, 500, 403, 206):
            self.server.on("/", answer(status, b"<html></html>"))
            self.refused(bf.E_HTTP, self.scan().home)


class Robots(Base):
    def test_a_disallow_for_our_agent_is_honoured(self):
        self.server.on("/robots.txt", answer(200, b"User-agent: NightshiftBrandScan\nDisallow: /products/\n",
                                             ctype="text/plain"))
        self.server.on("/", answer(200, b"<a href='/products/a'>a</a><a href='/about'>b</a>"))
        self.server.on("/about", answer(200, b"<html></html>"))
        pages, skipped = self.scan().pages()
        self.assertEqual([p.url for p in pages], [f"https://{SITE}/", f"https://{SITE}/about"])
        self.assertEqual(skipped, [(f"https://{SITE}/products/a", bf.E_ROBOTS)])
        self.assertNotIn("/products/a", self.server.paths())

    def test_disallow_everything_for_every_agent_stops_the_scan_at_robots(self):
        self.server.on("/robots.txt", answer(200, b"User-agent: *\nDisallow: /\n", ctype="text/plain"))
        self.refused(bf.E_ROBOTS, self.scan().home)
        self.assertEqual(self.server.paths(), ["/robots.txt"])

    def test_rules_for_another_agent_do_not_apply(self):
        self.server.on("/robots.txt", answer(200, b"User-agent: OtherBot\nDisallow: /\n", ctype="text/plain"))
        self.server.on("/", answer(200, b"<html></html>"))
        self.scan().home()

    def test_a_missing_robots_allows_and_an_unreadable_one_disallows(self):
        self.server.on("/", answer(200, b"<html></html>"))
        self.scan().home()                                            # the default 404
        for bad in (answer(503, b"", ctype="text/plain"), redirect("https://other-brand.test/robots.txt"),
                    answer(200, gzip.compress(b"User-agent: *\nAllow: /\n"), ctype="text/plain",
                           headers=("Content-Encoding: gzip",))):
            self.server.on("/robots.txt", bad)
            self.refused(bf.E_ROBOTS, self.scan().home)
        self.assertEqual(self.server.paths().count("/"), 1)

    def test_a_redirected_request_meets_the_new_hosts_robots(self):
        self.server.on("/", redirect(f"https://{WWW}/"))
        self.server.on("/robots.txt", answer(200, b"User-agent: *\nDisallow: /\n", ctype="text/plain"), host=WWW)
        self.refused(bf.E_ROBOTS, self.scan().home)
        self.assertEqual(self.server.paths(WWW), ["/robots.txt"])


class Certificates(Base):
    def test_a_certificate_for_another_name_is_refused(self):
        self.names["evil-brand.test"] = [SITE_IP]       # the site's server answers, with a certificate that lacks this name
        e = self.refused(bf.E_TLS, self.scan("https://evil-brand.test/").home)
        self.assertIn("certificate", e.message)
        self.assertEqual(self.server.seen, [])

    def test_a_certificate_from_an_untrusted_issuer_is_refused(self):
        import certifi                                   # the public roots: the test CA is not among them
        self.refused(bf.E_TLS, self.scan(tls=ssl.create_default_context(cafile=certifi.where())).home)
        self.assertEqual(self.server.seen, [])

    def test_a_tls_context_that_does_not_verify_the_name_is_refused_before_connecting(self):
        ctx = client_tls()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        self.refused(bf.E_TLS, self.scan(tls=ctx).home)
        ctx2 = client_tls()
        ctx2.check_hostname = False
        self.refused(bf.E_TLS, self.scan(tls=ctx2).home)
        self.assertEqual(self.dialed, [])


# ── the name lookup inside the budget ─────────────────────────────────────────────────────────────────────────────

class Lookups(Base):
    def test_a_slow_resolver_is_cut_at_the_scan_budget(self):
        def slow():
            time.sleep(3)
            return [SITE_IP]
        self.names[SITE] = slow
        t = time.monotonic()
        self.refused(bf.E_TIMEOUT, self.scan(budget=Budget(0.5)).home)
        self.assertLess(time.monotonic() - t, 1.5)
        self.assertEqual(self.dialed, [])

    def test_a_slow_resolver_is_cut_at_the_connect_timeout_inside_a_long_budget(self):
        release = threading.Event()
        self.addCleanup(release.set)
        self.names[SITE] = lambda: release.wait(10) and [SITE_IP]
        with mock.patch.object(bf, "CONNECT_TIMEOUT_S", 0.3):
            t = time.monotonic()
            e = self.refused(bf.E_DNS, self.scan(budget=Budget(30)).home)
        self.assertLess(time.monotonic() - t, 1.5)
        self.assertIn("did not resolve within", e.message)

    def test_after_the_deadline_no_new_name_is_looked_up(self):
        now = [0.0]
        s = self.scan(budget=Budget(30, clock=lambda: now[0]))
        self.server.on("/", answer(200, b"<html></html>"))
        s.home()
        now[0] = 31.0
        for call in (lambda: s.css(f"https://{WWW}/s.css"), lambda: s.image(f"https://img.{SITE}/a.png"),
                     lambda: s._addresses(f"late.{SITE}")):
            self.refused(bf.E_TIMEOUT, call)
        self.assertEqual(self.resolved, [SITE])
        self.assertEqual(s._looked_up, {SITE}, "a name refused for time does not use up the name cap either")

    def test_at_most_four_distinct_names_per_scan(self):
        for name in ("a", "b", "c"):
            self.names[f"{name}.{SITE}"] = [SITE_IP]
            self.server.on("/s.css", answer(200, b"a{}", ctype="text/css"), host=f"{name}.{SITE}")
        self.server.on("/s.css", answer(200, b"a{}", ctype="text/css"))
        s = self.scan()
        for host in (SITE, f"a.{SITE}", f"b.{SITE}", f"c.{SITE}"):
            s.css(f"https://{host}/s.css")
        self.names[f"d.{SITE}"] = [SITE_IP]
        e = self.refused(bf.E_LIMIT, s.image, f"https://d.{SITE}/i.png")
        self.assertIn("4 host names", e.message)
        self.assertNotIn(f"d.{SITE}", self.resolved)
        self.assertEqual(bf.MAX_HOSTS, 4)

    def test_a_refused_or_failed_lookup_still_counts_toward_the_cap(self):
        self.names[f"a.{SITE}"] = ["10.0.0.1"]
        self.names[f"b.{SITE}"] = []
        s = self.scan()
        self.refused(bf.E_NOT_PUBLIC, s.css, f"https://a.{SITE}/s.css")
        self.refused(bf.E_DNS, s.css, f"https://b.{SITE}/s.css")
        for name in ("c", "d"):                               # not in the resolver's map: the lookup fails
            self.refused(bf.E_DNS, s.css, f"https://{name}.{SITE}/s.css")
        self.refused(bf.E_LIMIT, s.image, f"https://{SITE}/i.png")
        self.assertNotIn(SITE, self.resolved)

    def test_the_system_resolver_asks_for_the_absolute_name(self):
        asked = []

        def fake(host, *a, **k):
            asked.append(host)
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (SITE_IP, 443))]

        with mock.patch.object(socket, "getaddrinfo", fake):
            self.assertEqual(bf._system_resolve(SITE), [SITE_IP])
        self.assertEqual(asked, [SITE + "."], "no resolv.conf search domain may be tried")

    def test_the_trust_store_is_loaded_once_per_scan(self):
        self.server.on("/", answer(200, b"<html></html>"))
        calls = []
        real = bf._system_tls

        def counting():
            calls.append(1)
            return real()

        net = self.net()
        # The default TLS path with the test's connect: build the scan without a TLS override.
        s = SiteScan(f"https://{SITE}/", _test_net=net)
        s._tls = None
        with mock.patch.object(bf, "_system_tls", counting):
            for _ in range(3):
                with self.assertRaises(BrandFetchError):     # the public roots do not trust the test CA
                    s.css(f"https://{SITE}/s{_}.css")
        self.assertEqual(len(calls), 1)


# ── robots.txt rules (RFC 9309) ───────────────────────────────────────────────────────────────────────────────────

class RobotsMatching(unittest.TestCase):
    def rules(self, text):
        return bf.RobotsRules(text)

    def test_wildcards_anchors_longest_match_and_ties(self):
        r = self.rules("User-agent: *\nDisallow: /*.json$\nDisallow: /private\nAllow: /private/ok\n"
                       "Disallow: /tie\nAllow: /tie\nDisallow: /a*b*c\n")
        cases = {"/x.json": False, "/x.json?y=1": True, "/dir/x.json": False, "/private/x": False,
                 "/private/ok/1": True, "/tie": True, "/a-b-c": False, "/a-c-b": True, "/": True}
        for path, want in cases.items():
            self.assertEqual(r.allowed(path), want, path)

    def test_disallow_star_and_dollar(self):
        self.assertFalse(self.rules("User-agent: *\nDisallow: /*\n").allowed("/"))
        self.assertFalse(self.rules("User-agent: *\nDisallow: /*\n").allowed("/products/a"))
        r = self.rules("User-agent: *\nDisallow: /$\n")
        self.assertFalse(r.allowed("/"))
        self.assertTrue(r.allowed("/about"))

    def test_our_group_wins_over_star_and_groups_are_merged(self):
        r = self.rules("User-agent: *\nDisallow: /\n\nUser-agent: NightshiftBrandScan\nAllow: /\nDisallow: /a\n\n"
                       "User-agent: other\nDisallow: /b\n\nuser-agent: nightshift\nDisallow: /c\n")
        self.assertTrue(r.allowed("/b"))
        self.assertFalse(r.allowed("/a"))
        self.assertFalse(r.allowed("/c"), "a group for the brand name applies too, merged with ours")
        two = self.rules("User-agent: other\nUser-agent: NightshiftBrandScan/2\nDisallow: /x\n")
        self.assertFalse(two.allowed("/x"))

    def test_rules_before_any_group_and_empty_disallow_are_ignored(self):
        r = self.rules("Disallow: /\nUser-agent: *\nDisallow:\nCrawl-delay: 10\nSitemap: https://x.test/s.xml\n")
        self.assertTrue(r.allowed("/"))

    def test_percent_escapes_compare_in_one_spelling(self):
        r = self.rules("User-agent: *\nDisallow: /caf%c3%a9\nDisallow: /ü\n")
        self.assertFalse(r.allowed("/caf%C3%A9/menu"))
        self.assertFalse(r.allowed("/%C3%BC"))

    def test_robots_txt_itself_is_always_allowed(self):
        self.assertTrue(self.rules("User-agent: *\nDisallow: /\n").allowed("/robots.txt"))

    def test_a_pattern_made_of_stars_cannot_make_the_match_slow(self):
        r = self.rules("User-agent: *\nDisallow: /" + "*a" * 2000 + "*b\n")
        t = time.monotonic()
        self.assertTrue(r.allowed("/" + "a" * 2040))
        self.assertLess(time.monotonic() - t, 0.5)


class RobotsOverTheWire(Base):
    def test_a_byte_order_mark_does_not_lose_the_first_group(self):
        self.server.on("/robots.txt", answer(200, b"\xef\xbb\xbfUser-agent: *\nDisallow: /\n", ctype="text/plain"))
        self.refused(bf.E_ROBOTS, self.scan().home)
        self.assertEqual(self.server.paths(), ["/robots.txt"])

    def test_rules_are_read_whatever_the_content_type(self):
        for ctype in ("application/octet-stream", "text/html", ""):
            with self.subTest(ctype=ctype):
                self.server.on("/robots.txt", answer(200, b"User-agent: *\nDisallow: /\n", ctype=ctype))
                self.refused(bf.E_ROBOTS, self.scan().home)
        self.assertNotIn("/", self.server.paths())

    def test_disallow_star_and_dollar_over_the_wire(self):
        self.server.on("/", answer(200, b"<a href='/about'>a</a>"))
        self.server.on("/about", answer(200, b"<html></html>"))
        self.server.on("/robots.txt", answer(200, b"User-agent: NightshiftBrandScan\nDisallow: /$\n", ctype="text/plain"))
        self.refused(bf.E_ROBOTS, self.scan().home)
        s = self.scan(f"https://{SITE}/about")
        self.assertEqual(s.home().url, f"https://{SITE}/about")
        self.server.on("/robots.txt", answer(200, b"User-agent: *\nDisallow: /*\n", ctype="text/plain"))
        self.refused(bf.E_ROBOTS, self.scan(f"https://{SITE}/about").home)

    def test_a_query_is_part_of_what_the_rules_match(self):
        self.server.on("/robots.txt", answer(200, b"User-agent: *\nDisallow: /*?sort=\n", ctype="text/plain"))
        self.server.on("/p?sort=price", answer(200, b"<html></html>"))
        self.refused(bf.E_ROBOTS, self.scan(f"https://{SITE}/p?sort=price").home)
        self.assertNotIn("/p?sort=price", self.server.paths())


# ── framing past the body cap ─────────────────────────────────────────────────────────────────────────────────────

class Framing(Base):
    def test_a_trailer_flood_after_a_full_body_is_stopped(self):
        def send(tls):
            tls.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/css\r\nTransfer-Encoding: chunked\r\n\r\n")
            for _ in range(256):
                tls.sendall(b"400\r\n" + b"x" * 1024 + b"\r\n")
            tls.sendall(b"0\r\n")
            for i in range(60):                               # ~120 KiB of trailer: past MAX_FRAMING_BYTES
                tls.sendall(b"X-T-%d: %s\r\n" % (i, b"t" * 2000))
            tls.sendall(b"\r\n")
        self.server.on("/s.css", send)
        self.refused(bf.E_TOO_LARGE, self.scan().css, f"https://{SITE}/s.css")

    def test_a_short_trailer_after_a_full_body_is_read(self):
        def send(tls):
            tls.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/css\r\nTransfer-Encoding: chunked\r\n\r\n")
            for _ in range(256):
                tls.sendall(b"400\r\n" + b"x" * 1024 + b"\r\n")
            tls.sendall(b"0\r\nX-T: " + b"t" * 20000 + b"\r\n\r\n")
        self.server.on("/s.css", send)
        self.assertEqual(len(self.scan().css(f"https://{SITE}/s.css").body), 256 * 1024)

    def test_a_chunk_extension_flood_is_stopped(self):
        def send(tls):
            tls.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/css\r\nTransfer-Encoding: chunked\r\n\r\n")
            for _ in range(400):                              # 1 byte of body per ~60 KiB of extension
                tls.sendall(b"1;ext=" + b"e" * 60000 + b"\r\nx\r\n")
            tls.sendall(b"0\r\n\r\n")
        self.server.on("/s.css", send)
        self.refused(bf.E_TOO_LARGE, self.scan().css, f"https://{SITE}/s.css")

    def test_the_framing_allowance_is_the_documented_number(self):
        self.assertEqual((bf.MAX_FRAMING_BYTES, bf.MAX_HEADER_BYTES), (64 * 1024, 64 * 1024))


class LinkParsingInsideTheBudget(Base):
    def test_a_home_page_that_used_up_the_budget_is_not_parsed(self):
        now = [0.0]
        self.server.on("/", answer(200, b"<a href='/products/a'>a</a>"))
        s = self.scan(budget=Budget(30, clock=lambda: now[0]))
        real_home = s.home

        def slow_home():
            page = real_home()
            now[0] = 31.0
            return page

        s.home = slow_home
        with mock.patch.object(bf, "same_host_links", side_effect=AssertionError("parsed after the deadline")):
            self.refused(bf.E_TIMEOUT, s.pages)

    def test_no_page_is_started_once_the_parse_used_up_the_budget(self):
        now = [0.0]
        self.server.on("/", answer(200, b"<a href='/products/a'>a</a>"))
        s = self.scan(budget=Budget(30, clock=lambda: now[0]))
        real = bf.same_host_links

        def slow_parse(*a, **k):
            now[0] = 31.0
            return real(*a, **k)

        with mock.patch.object(bf, "same_host_links", slow_parse):
            self.refused(bf.E_TIMEOUT, s.pages)
        self.assertEqual(s._count[bf.HTML], 1, "no page request was even counted")

    def test_the_budget_is_checked_around_the_link_list(self):
        now = [0.0]
        self.server.on("/", answer(200, b"<a href='/products/a'>a</a>"))
        s = self.scan(budget=Budget(30, clock=lambda: now[0]))
        real = bf.same_host_links

        def slow_parse(*a, **k):
            now[0] = 31.0                                     # the parse used up the scan
            return real(*a, **k)

        with mock.patch.object(bf, "same_host_links", slow_parse):
            self.refused(bf.E_TIMEOUT, s.pages)
        self.assertNotIn("/products/a", self.server.paths())


if __name__ == "__main__":
    unittest.main()
