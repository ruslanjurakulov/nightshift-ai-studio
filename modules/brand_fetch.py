"""The network half of the Ads Factory brand scan (docs/ADS_FACTORY.md, Phase 2, "The fetch"). Dark: nothing imports it yet.

The scan reads a CUSTOMER's site, so the host is whatever a person typed, not a vendor on an allow-list
(``modules/capabilities/safe_fetch.py`` keeps that list for result links; it is not loosened here). Any name can
resolve to a private address, so the shape check 0131 does in the database (``ads_site_url_ok``) is not an SSRF
control. This module is:

* **The URL.** https, no port but 443, no userinfo, printable ASCII; an IDN host must arrive as punycode. The entry
  URL is held to 0131's exact shape (``ads_site_url_ok``), so the worker reads only what the database accepted, and
  one thing more is refused: a backslash, which 0131 lets through in the path and on which URL parsers disagree. A
  URL found on the way (a redirect, a link, a stylesheet) is brought to the same shape (host lower-cased, ``:443``
  dropped, non-ASCII in the path percent-encoded) and held to it with a longer length limit.
  The host is read by ONE parser (the 0131 pattern) and that host is the one resolved, connected to and named in SNI
  and Host, so two URL parsers cannot disagree about where the request goes.
* **The address.** The name is resolved ONCE per scan (``getaddrinfo`` of the absolute name, so no search domain is
  tried; in a thread waited for within the budget, since the customer runs the name server; at most ``MAX_HOSTS``
  names per scan) and the scan refuses unless EVERY answer is public (``address_problem``: this module's own table of
  special-use ranges, IPv6 only inside 2000::/3, not ``ipaddress``'s flags alone). The socket is opened to that resolved address and TLS verifies the certificate for
  the NAME (SNI and Host carry it): there is no second lookup, so DNS rebinding cannot move the target between the
  check and the connect, and a later request in the same scan reuses the pinned answer.
* **Redirects** are read, never followed by a library: at most ``MAX_HOPS``, each re-checked (shape, port, the
  address of a host not seen yet in this scan, robots.txt) and kept on the entry host, its subdomains or its
  www / apex twin (``same_site``).
* **Bounds.** Connect 5 s, read 10 s, 30 s of wall clock for the whole scan (one ``Budget`` across every call, every
  socket wait capped by what is left of it, so a server dripping one byte at a time cannot outlive it). Byte caps per
  kind, checked against Content-Length and again while reading; counts per kind (6 pages, 4 stylesheets, 6 images).
  A content-type allow-list per kind; SVG is refused (it is a document, not a picture). ``Accept-Encoding: identity``
  and a compressed answer is refused, so there is no decoder to bomb.
* **Manners.** robots.txt of a host is read before anything else on it and its rules for our user agent are honoured
  (RFC 9309 matching: ``*`` and ``$``, the longest pattern wins, Allow wins a tie; ``RobotsRules``);
  the user agent names Nightshift and where to reach us. No cookie is kept or sent, no credential, no script is run.

What it returns is bytes, the final URL and the content type (``Fetched``). Extraction (title, Open Graph, JSON-LD,
palette, fonts) is a later step and is not here; the only HTML read here is the bounded same-host link list the
six-page limit needs (``same_host_links``).

Known limits:
* **The site rule is narrow on purpose.** There is no public-suffix list (no dependency carries one), so instead of
  guessing a registrable domain ``same_site`` allows only the entry host, its subdomains and the www / apex swap. A
  site whose home page redirects to a sibling (``shop.com`` to ``store.shop.com`` is fine; ``www.shop.com`` to
  ``store.shop.com`` is not, nor ``shop.co.uk`` to ``shop.com``) fails that request; the person types the host the
  site really lives on. Tenants of one shared hosting domain (``a.github.io``, ``b.myshopify.com``) cannot redirect
  the scan into each other.
* **NAT64, 6to4 and Teredo.** Every address in ``64:ff9b::/96`` (and the local-use ``64:ff9b:1::/48``), in 6to4
  ``2002::/16`` and in Teredo ``2001::/32`` is refused, public embedding or not (they sit in this module's deny
  table or outside 2000::/3); the message names a private embedding when there is one. A worker on an IPv6-only
  network behind DNS64 cannot scan.
* **robots.txt** is honoured for Allow / Disallow (groups for ``NightshiftBrandScan`` or ``Nightshift``, else ``*``);
  Crawl-delay is not waited for (a scan is at most a dozen requests). It is parsed whatever its content type. One
  that cannot be read (5xx, too large, compressed, off-site redirect) is read as "disallow everything" (RFC 9309
  section 2.3.1.4).
* **A lookup that is abandoned keeps its thread** until the system resolver gives up on its own (``getaddrinfo``
  cannot be cancelled); the scan has moved on and never uses the answer.
"""

from __future__ import annotations

import http.client
import io
import ipaddress
import re
import socket
import ssl
import threading
import time
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Callable, Dict, List, Optional, Sequence, Tuple
from urllib.parse import quote, urljoin, urlsplit

from modules.capabilities.safe_fetch import _SAFE_URL, sniff_image_mime

# ── limits (docs/ADS_FACTORY.md, Phase 2, "The fetch") ─────────────────────────────────────────────────────────────

CONNECT_TIMEOUT_S = 5.0
READ_TIMEOUT_S = 10.0
#: The whole scan, every request together. A caller may pass a shorter budget, never a longer one.
SCAN_WALL_CLOCK_S = 30.0
#: Redirects followed for one request (the request itself plus at most this many hops).
MAX_HOPS = 3
#: Distinct host names one scan may look up (the entry host, its www twin and two more): a site cannot make the
#: worker resolve names for it without end.
MAX_HOSTS = 4
PORT = 443

HTML, CSS, IMAGE, ROBOTS = "html", "css", "image", "robots"
MAX_BYTES = {HTML: 1536 * 1024, CSS: 256 * 1024, IMAGE: 5 * 1024 * 1024, ROBOTS: 500 * 1024}
MAX_COUNT = {HTML: 6, CSS: 4, IMAGE: 6}
#: Status line and headers together may not be larger than this (``http.client`` alone allows 100 lines of 64 KiB).
MAX_HEADER_BYTES = 64 * 1024
#: Bytes a body may carry beyond its cap in chunk framing (and what the header read buffered ahead) before the read stops.
MAX_FRAMING_BYTES = 64 * 1024
ALLOWED_TYPES = {
    HTML: ("text/html",),
    CSS: ("text/css",),
    IMAGE: ("image/png", "image/jpeg", "image/webp"),
}
ACCEPT = {HTML: "text/html", CSS: "text/css", IMAGE: "image/png, image/jpeg, image/webp", ROBOTS: "text/plain"}

#: The name robots.txt rules are matched against, and the honest user agent around it.
ROBOTS_TOKEN = "NightshiftBrandScan"
USER_AGENT = (f"{ROBOTS_TOKEN}/1.0 (+https://nightshift-ai.studio/; reads a few public pages of a site "
              f"whose owner asked Nightshift to scan it)")

#: The link list the page limit is chosen from is at most this long, each link at most this many characters.
MAX_LINKS = 200
MAX_LINK_CHARS = 2048
#: A URL found on the way (redirect, link, asset) may be longer than the 300 characters of the entry URL.
MAX_DERIVED_URL_CHARS = 2048

# ── errors, results, the budget ───────────────────────────────────────────────────────────────────────────────────

E_BAD_URL = "bad_url"
E_NOT_PUBLIC = "not_public"
E_DNS = "dns"
E_CONNECT = "connect"
E_TLS = "tls"
E_REDIRECT = "redirect"
E_TOO_MANY_REDIRECTS = "too_many_redirects"
E_OFF_SITE = "off_site"
E_HTTP = "http_status"
E_CONTENT_TYPE = "content_type"
E_SVG = "svg"
E_COMPRESSED = "compressed"
E_TOO_LARGE = "too_large"
E_TIMEOUT = "timeout"
E_ROBOTS = "robots"
E_LIMIT = "limit"
E_BAD_RESPONSE = "bad_response"


class BrandFetchError(Exception):
    """A refusal or a failure, with a machine-readable ``code``. Nothing was kept from the request that raised it."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code, self.message = code, message


@dataclass(frozen=True)
class Fetched:
    """One answer: the URL it finally came from (after the redirects followed), its media type, its bytes."""

    url: str
    content_type: str
    body: bytes
    kind: str


class Budget:
    """The wall clock of one scan, shared by every request in it. Every socket wait is capped by what is left."""

    def __init__(self, seconds: float = SCAN_WALL_CLOCK_S, *, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self.deadline = clock() + max(0.0, min(float(seconds), SCAN_WALL_CLOCK_S))

    def remaining(self) -> float:
        return self.deadline - self._clock()

    def check(self) -> None:
        """Refuse to start anything once the wall clock has run out."""
        self.timeout(0.0)

    def timeout(self, cap: float) -> float:
        """The timeout for the next wait: ``cap`` or what is left of the scan, whichever is shorter."""
        left = self.remaining()
        if left <= 0:
            raise BrandFetchError(E_TIMEOUT, "the scan's wall clock ran out")
        return min(cap, left)


# ── the address rule ──────────────────────────────────────────────────────────────────────────────────────────────

_METADATA = frozenset(ipaddress.ip_address(a) for a in ("169.254.169.254", "fd00:ec2::254", "100.100.100.200"))
_NAT64_WKP = ipaddress.ip_network("64:ff9b::/96")
_NAT64_LOCAL = ipaddress.ip_network("64:ff9b:1::/48")
_IPV4_COMPATIBLE = ipaddress.ip_network("::/96")
_TEREDO = ipaddress.ip_network("2001::/32")
_SIX_TO_FOUR = ipaddress.ip_network("2002::/16")
#: Every IPv6 address the scan may connect to is global unicast (RFC 4291); nothing outside it is a web site.
_GLOBAL_UNICAST = ipaddress.ip_network("2000::/3")


def _table(*rows: Tuple[str, str]) -> Tuple[Tuple[ipaddress._BaseNetwork, str], ...]:
    return tuple((ipaddress.ip_network(net), f"{label} ({net})") for net, label in rows)


#: The special-use ranges (IANA's registries), written out here so the rule does not depend on which ``ipaddress``
#: tables the Python in the worker happens to carry (they changed in 3.11.10 / 3.12.4 / 3.13). Order matters only for
#: the message: the first row that holds the address names it.
_DENY_V4 = _table(
    ("0.0.0.0/8", "a 'this network' address"),
    ("10.0.0.0/8", "a private address"),
    ("100.64.0.0/10", "a carrier-grade NAT address"),
    ("127.0.0.0/8", "a loopback address"),
    ("169.254.0.0/16", "a link-local address"),
    ("172.16.0.0/12", "a private address"),
    ("192.0.0.0/24", "an IETF protocol assignment address"),
    ("192.0.2.0/24", "a documentation address"),
    ("192.88.99.0/24", "a 6to4 relay anycast address"),
    ("192.168.0.0/16", "a private address"),
    ("198.18.0.0/15", "a benchmarking address"),
    ("198.51.100.0/24", "a documentation address"),
    ("203.0.113.0/24", "a documentation address"),
    ("224.0.0.0/4", "a multicast address"),
    ("240.0.0.0/4", "a reserved address"),
)
_DENY_V6 = _table(
    ("::/8", "a reserved address"),
    ("100::/8", "a reserved address (discard-only and unassigned)"),
    ("2001::/23", "an IETF protocol assignment address"),
    ("2001:db8::/32", "a documentation address"),
    ("2002::/16", "a 6to4 address"),
    ("3fff::/20", "a documentation address"),
    ("5f00::/16", "an SRv6 SID address"),
    ("fc00::/7", "a unique local (private) address"),
    ("fe80::/10", "a link-local address"),
    ("fec0::/10", "a site-local address"),
    ("ff00::/8", "a multicast address"),
)


def _listed(a, table) -> Optional[str]:
    for net, label in table:
        if a in net:
            return label
    return None


def _v4_problem(a: ipaddress.IPv4Address) -> Optional[str]:
    if a in _METADATA:
        return "a cloud metadata address"
    if a.is_unspecified:
        return "the unspecified address"
    listed = _listed(a, _DENY_V4)
    if listed:
        return listed
    # The stdlib's own view, behind the table: a range the table misses and a newer Python knows is still refused.
    if a.is_loopback or a.is_link_local or a.is_multicast or a.is_reserved or a.is_private or not a.is_global:
        return "an address that is not globally routable"
    return None


def address_problem(addr: str) -> Optional[str]:
    """Why ``addr`` (an IP address as text, as ``getaddrinfo`` gives it) may not be connected to, or None when it is
    public. The rule is this module's own table (``_DENY_V4`` / ``_DENY_V6``, plus "IPv6 must be global unicast"),
    with the classes that embed an IPv4 address named first; ``ipaddress``'s flags only back it up, because Python's
    tables have changed between patch releases and several of them call a multicast, an IPv4-compatible or a NAT64
    address global."""
    try:
        a = ipaddress.ip_address(addr)
    except ValueError:
        return "not an IP address"
    if a in _METADATA:
        return "a cloud metadata address"
    if isinstance(a, ipaddress.IPv4Address):
        return _v4_problem(a)
    if a.scope_id:
        return "a scoped (link-local) IPv6 address"
    if a.ipv4_mapped is not None:
        return f"an IPv4-mapped IPv6 address (of {a.ipv4_mapped})"
    if a.is_loopback:
        return "a loopback address"
    if a.is_unspecified:
        return "the unspecified address"
    if a in _IPV4_COMPATIBLE:
        return f"an IPv4-compatible IPv6 address (of {ipaddress.IPv4Address(int(a) & 0xFFFFFFFF)})"
    if a in _SIX_TO_FOUR:
        inner = _v4_problem(ipaddress.IPv4Address((int(a) >> 80) & 0xFFFFFFFF))
        return f"a 6to4 address of {inner}" if inner else "a 6to4 address"
    if a in _TEREDO:
        server, client = a.teredo
        inner = _v4_problem(client) or _v4_problem(server)
        return f"a Teredo address of {inner}" if inner else "a Teredo address"
    if a in _NAT64_WKP:
        inner = _v4_problem(ipaddress.IPv4Address(int(a) & 0xFFFFFFFF))
        return f"a NAT64 address of {inner}" if inner else "a NAT64 address"
    if a in _NAT64_LOCAL:
        return "a local-use NAT64 address"
    listed = _listed(a, _DENY_V6)
    if listed:
        return listed
    if a not in _GLOBAL_UNICAST:
        return "an address outside IPv6 global unicast (2000::/3)"
    if a.is_link_local or a.is_site_local or a.is_multicast or a.is_reserved or a.is_private or not a.is_global:
        return "an address that is not globally routable"
    return None


# ── the URL rule ──────────────────────────────────────────────────────────────────────────────────────────────────

#: 0131's ``ads_site_url_ok`` pattern, anchored with \Z (Python's ``$`` also matches before a final newline; Postgres's
#: does not). Group 1 is the host: the one parser this module reads a host with.
_SHAPE = re.compile(r"https://((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:xn--[a-z0-9-]{1,59}|[a-z]{2,63}))"
                    r"(/[\x21-\x7e]*)?\Z")
#: What ``quote`` leaves alone in a derived path: printable ASCII except the characters URL parsers disagree on.
_QUOTE_SAFE = "".join(chr(c) for c in range(0x21, 0x7F) if chr(c) not in '\\"<>^`{|}%') + "%"

def _shape(url, max_chars: int) -> Tuple[str, str]:
    """``(host, request target)`` for a URL of 0131's shape, else ``bad_url``."""
    if not isinstance(url, str) or not (12 <= len(url) <= max_chars) or not _SAFE_URL.fullmatch(url):
        raise BrandFetchError(E_BAD_URL, "the address is not printable ASCII https of an allowed length")
    m = _SHAPE.match(url)
    if not m:
        raise BrandFetchError(E_BAD_URL, "the address is not https://<dns name>[/path] (no port, no password, no IP "
                                         "literal; an international name must be written in punycode, xn--)")
    path = (m.group(2) or "/").split("#", 1)[0] or "/"
    return m.group(1), path


def check_entry_url(url) -> Tuple[str, str]:
    """The entry URL, held to exactly what 0131's ``ads_site_url_ok`` accepts (12 to 300 characters)."""
    return _shape(url, 300)


def derive_url(base: str, ref: str) -> str:
    """``ref`` (a Location header, an href) read against ``base`` and brought to the shape: the scheme and host
    lower-cased, an explicit :443 dropped, every other port, any userinfo and any scheme but https refused,
    non-ASCII in the path percent-encoded, the fragment dropped. Then the same shape check as the entry URL."""
    if not isinstance(ref, str) or not ref.strip() or len(ref) > MAX_DERIVED_URL_CHARS:
        raise BrandFetchError(E_BAD_URL, "an empty or over-long address")
    joined = urljoin(base, ref.strip())
    try:
        parts = urlsplit(joined)
        port = parts.port
    except ValueError:
        raise BrandFetchError(E_BAD_URL, "an address whose port cannot be read") from None
    if parts.scheme.lower() != "https":
        raise BrandFetchError(E_BAD_URL, f"a {parts.scheme or 'relative'!s} address; only https is read")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise BrandFetchError(E_BAD_URL, "an address with a user name or password")
    if port not in (None, PORT):
        raise BrandFetchError(E_BAD_URL, f"port {port}; only {PORT} is read")
    host = (parts.hostname or "").lower()
    if "\\" in joined or not host.isascii():
        raise BrandFetchError(E_BAD_URL, "an address with a backslash or a non-ASCII host (punycode it: xn--)")
    path = quote(parts.path or "/", safe=_QUOTE_SAFE)
    query = quote(parts.query, safe=_QUOTE_SAFE)
    out = f"https://{host}{path}" + (f"?{query}" if query else "")
    _shape(out, MAX_DERIVED_URL_CHARS)
    return out


def same_site(host: str, entry: str) -> bool:
    """``host`` is the entry host, a subdomain of it, or its www / apex twin (``www.shop.com`` and ``shop.com``). Nothing
    wider: on a shared hosting domain (``*.myshopify.com``, ``*.github.io``, ``*.vercel.app``) every tenant is a
    subdomain of the same parent, and one tenant must not be able to redirect the scan into another."""
    if host == entry or host.endswith("." + entry):          # the www twin of an apex is one of its subdomains
        return True
    return entry.startswith("www.") and host == entry[4:]


# ── the link list (the only HTML read here) ───────────────────────────────────────────────────────────────────────

class _Links(HTMLParser):
    def __init__(self, limit: int):
        super().__init__(convert_charrefs=True)
        self.hrefs: List[str] = []
        self.limit = limit

    def handle_starttag(self, tag, attrs):
        if tag != "a" or len(self.hrefs) >= self.limit:
            return
        for k, v in attrs:
            if k == "href" and v and len(v) <= MAX_LINK_CHARS:
                self.hrefs.append(v)
                return


def same_host_links(html: bytes, page_url: str, limit: int = MAX_LINKS) -> List[str]:
    """The https links of ``html`` on the page's own host, in document order, each once, at most ``limit``, the page
    itself left out. The body is at most the HTML cap already; only ``<a href>`` is read, ``<base>`` is ignored (a
    base on another host would only move links off the host, and those are dropped)."""
    host, _ = _shape(page_url, MAX_DERIVED_URL_CHARS)
    parser = _Links(MAX_LINKS * 4)
    try:
        parser.feed(html[:MAX_BYTES[HTML]].decode("utf-8", errors="replace"))
        parser.close()
    except Exception:  # a parser error on hostile markup ends the list where it got to
        pass
    seen, out = {page_url.split("#", 1)[0]}, []
    for href in parser.hrefs:
        try:
            url = derive_url(page_url, href)
        except BrandFetchError:
            continue
        if _shape(url, MAX_DERIVED_URL_CHARS)[0] != host or url in seen:
            continue
        seen.add(url)
        out.append(url)
        if len(out) >= limit:
            break
    return out


def _product_first(urls: Sequence[str]) -> List[str]:
    """Product pages first (a path segment that names one), the rest after, each group in document order."""
    def productish(u: str) -> bool:
        path = urlsplit(u).path.lower()
        return any(seg in ("product", "products", "p", "item", "items", "shop") for seg in path.split("/"))
    return [u for u in urls if productish(u)] + [u for u in urls if not productish(u)]


# ── robots.txt (RFC 9309) ─────────────────────────────────────────────────────────────────────────────────────────

#: The group names that address this scanner: its product token, and the brand name a site owner would write.
_ROBOTS_AGENTS = frozenset({ROBOTS_TOKEN.lower(), "nightshift"})


def _robots_norm(s: str) -> str:
    """A path or a pattern in one spelling: non-ASCII and unsafe characters percent-encoded, escapes upper-cased."""
    return re.sub(r"%[0-9a-fA-F]{2}", lambda m: m.group(0).upper(), quote(s, safe=_QUOTE_SAFE))


def _robots_match(pattern: str, path: str) -> bool:
    """RFC 9309 section 2.2.3: ``*`` is any run of characters, a final ``$`` anchors the end, everything else is a
    prefix match. Done by splitting on ``*`` and finding each piece leftmost, not with a regex: a pattern from the
    site with many ``*`` must not be able to make the match backtrack."""
    anchored = pattern.endswith("$")
    if anchored:
        pattern = pattern[:-1]
    parts = pattern.split("*")
    if not path.startswith(parts[0]):
        return False
    pos = len(parts[0])
    if len(parts) == 1:
        return pos == len(path) if anchored else True
    for piece in parts[1:-1]:
        i = path.find(piece, pos)
        if i < 0:
            return False
        pos = i + len(piece)
    last = parts[-1]
    if anchored:
        return len(path) - len(last) >= pos and path.endswith(last)
    return path.find(last, pos) >= 0


class RobotsRules:
    """The Allow / Disallow rules of one robots.txt that apply to this scanner (RFC 9309): the groups naming us, all of
    them merged, else the ``*`` groups merged. The longest matching pattern decides; on a tie Allow wins; no match
    allows. Crawl-delay and Sitemap are read past, not honoured."""

    def __init__(self, text: str = ""):
        groups: List[Tuple[List[str], List[Tuple[bool, str]]]] = []
        current, in_rules = None, False
        for raw in text.splitlines():
            line = raw.split("#", 1)[0].strip()
            if ":" not in line:
                continue
            key, value = (p.strip() for p in line.split(":", 1))
            key = key.lower()
            if key == "user-agent":
                if current is None or in_rules:
                    current, in_rules = ([], []), False
                    groups.append(current)
                current[0].append(value.split("/", 1)[0].strip().lower())
            elif key in ("allow", "disallow") and current is not None:
                in_rules = True
                if value.startswith(("/", "*")):              # an empty Disallow is no rule (RFC 9309 2.2.2)
                    current[1].append((key == "allow", _robots_norm(value)))
        ours = [rules for agents, rules in groups if _ROBOTS_AGENTS.intersection(agents)]
        if not ours:
            ours = [rules for agents, rules in groups if "*" in agents]
        self.rules: List[Tuple[bool, str]] = [r for rules in ours for r in rules]

    def allowed(self, target: str) -> bool:
        """``target`` is a request target (path and query)."""
        path = _robots_norm(target)
        if path == "/robots.txt":
            return True
        best: Optional[Tuple[int, bool]] = None
        for allow, pattern in self.rules:
            if _robots_match(pattern, path):
                key = (len(pattern), allow)                    # longer wins; on a tie True (Allow) > False
                if best is None or key > best:
                    best = key
        return True if best is None else best[1]


# ── the connection ────────────────────────────────────────────────────────────────────────────────────────────────

def _system_resolve(host: str) -> List[str]:
    # The absolute name (a final dot): no search domain of the worker's resolv.conf is tried, so "shop.test" cannot
    # come back as "shop.test.internal.corp".
    infos = socket.getaddrinfo(host + ".", PORT, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
    return [info[4][0] for info in infos]


def _system_connect(ip: str, timeout: float) -> socket.socket:
    a = ipaddress.ip_address(ip)
    family = socket.AF_INET6 if a.version == 6 else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.settimeout(timeout)
        sock.connect((str(a), PORT))
    except BaseException:
        sock.close()
        raise
    return sock


def _system_tls() -> ssl.SSLContext:
    try:
        import certifi
        ctx = ssl.create_default_context(cafile=certifi.where())
    except ImportError:  # requests ships certifi; the system store is the fallback, never "no verification"
        ctx = ssl.create_default_context()
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return ctx


@dataclass(frozen=True)
class _TestNet:
    """TESTS ONLY. Production code never builds one (tests/test_brand_fetch.py pins that nothing but this module and its
    tests names it). It replaces the resolver, the TCP connect and the trust store, so a test can map a name to an
    address of its choosing and that address to a loopback server. It cannot switch the address rule off: every answer
    ``resolve`` gives is still checked by ``address_problem``, and the TLS context must still verify the name."""

    resolve: Callable[[str], Sequence[str]]
    connect: Callable[[str, float], socket.socket]
    tls: ssl.SSLContext


class _DeadlineSocket:
    """What ``http.client`` reads and writes through: every wait capped by the read timeout and the scan's budget, and
    no more than ``limit`` bytes read in all (the header cap while the headers are read, then the body's)."""

    def __init__(self, sock: ssl.SSLSocket, budget: Budget, limit: int):
        self._sock, self._budget, self.limit, self.read_total = sock, budget, limit, 0

    def sendall(self, data: bytes) -> None:
        self._sock.settimeout(self._budget.timeout(READ_TIMEOUT_S))
        self._sock.sendall(data)

    def makefile(self, mode: str = "rb", *args, **kwargs):
        return io.BufferedReader(_DeadlineRaw(self), 8192)

    def recv_into(self, b) -> int:
        self._sock.settimeout(self._budget.timeout(READ_TIMEOUT_S))
        n = self._sock.recv_into(b, min(len(b), self.limit + 1 - self.read_total))
        self.read_total += n
        if self.read_total > self.limit:
            raise BrandFetchError(E_TOO_LARGE, "the answer is larger than its cap; stopped reading")
        return n

    def close(self) -> None:
        try:
            self._sock.close()
        except OSError:
            pass


class _DeadlineRaw(io.RawIOBase):
    def __init__(self, owner: _DeadlineSocket):
        self._owner = owner

    def readable(self) -> bool:
        return True

    def readinto(self, b) -> int:
        return self._owner.recv_into(b)


class _Conn(http.client.HTTPConnection):
    """An HTTP/1.1 connection over a socket that is already open and already TLS: ``http.client`` only frames."""

    def __init__(self, host: str, sock: _DeadlineSocket):
        super().__init__(host, PORT)
        self.sock = sock

    def connect(self):  # never reached: the socket is given, and a reconnect would mean a second lookup
        raise BrandFetchError(E_CONNECT, "a reconnect was attempted")


@dataclass(frozen=True)
class _Answer:
    status: int
    location: Optional[str]
    content_type: str
    body: bytes


# ── the scan ──────────────────────────────────────────────────────────────────────────────────────────────────────

class SiteScan:
    """One scan of one site: one budget, one pinned address per host, one robots.txt per host, the per-kind counts."""

    def __init__(self, url: str, *, budget: Optional[Budget] = None, _test_net: Optional[_TestNet] = None):
        if _test_net is not None and not isinstance(_test_net, _TestNet):
            raise TypeError("_test_net is for tests only")
        self.start_url = url
        self.host, _ = check_entry_url(url)
        self.budget = budget or Budget()
        self._net = _test_net
        self._pinned: Dict[str, Tuple[str, ...]] = {}
        self._robots: Dict[str, Optional[RobotsRules]] = {}
        self._looked_up: set = set()
        self._tls: Optional[ssl.SSLContext] = _test_net.tls if _test_net is not None else None
        self._count = {HTML: 0, CSS: 0, IMAGE: 0}
        #: The host pages are read from: the home page's final host once it is known.
        self.page_host: Optional[str] = None

    # -- what a caller asks for ------------------------------------------------------------------------------------
    def home(self) -> Fetched:
        page = self._counted(HTML, self.start_url)
        self.page_host = _shape(page.url, MAX_DERIVED_URL_CHARS)[0]
        return page

    def page(self, url: str) -> Fetched:
        """A page on the home page's host (``home()`` first)."""
        if self.page_host is None:
            raise BrandFetchError(E_LIMIT, "the home page is read first")
        if _shape(url, MAX_DERIVED_URL_CHARS)[0] != self.page_host:
            raise BrandFetchError(E_OFF_SITE, "pages are read from the home page's own host only")
        return self._counted(HTML, url)

    def css(self, url: str) -> Fetched:
        return self._counted(CSS, url)

    def image(self, url: str) -> Fetched:
        return self._counted(IMAGE, url)

    def pages(self) -> Tuple[List[Fetched], List[Tuple[str, str]]]:
        """The home page and up to five same-host pages it links to (product pages first). Returns the pages read and
        ``(url, code)`` for each one that was refused; the home page failing, or the budget running out, raises."""
        first = self.home()
        got, skipped = [first], []
        self.budget.check()
        links = _product_first(same_host_links(first.body, first.url))[:MAX_COUNT[HTML] - 1]
        self.budget.check()
        for url in links:
            try:
                got.append(self.page(url))
            except BrandFetchError as e:
                if e.code == E_TIMEOUT:
                    raise
                skipped.append((url, e.code))
        return got, skipped

    # -- the rules -------------------------------------------------------------------------------------------------
    def _counted(self, kind: str, url: str) -> Fetched:
        if self._count[kind] >= MAX_COUNT[kind]:
            raise BrandFetchError(E_LIMIT, f"at most {MAX_COUNT[kind]} {kind} requests per scan")
        self._count[kind] += 1
        return self._get(url, kind)

    def _get(self, url: str, kind: str) -> Fetched:
        current = url
        for hop in range(MAX_HOPS + 1):
            self.budget.check()
            host, target = _shape(current, MAX_DERIVED_URL_CHARS)
            if not same_site(host, self.host):
                raise BrandFetchError(E_OFF_SITE, f"{host} is not on the scanned site ({self.host}); not read")
            if kind != ROBOTS and not self._allowed(host, target):
                raise BrandFetchError(E_ROBOTS, f"robots.txt of {host} disallows {ROBOTS_TOKEN} here")
            ans = self._request(host, target, kind)
            if ans.location is None:
                return Fetched(current, ans.content_type, ans.body, kind)
            if hop == MAX_HOPS:
                raise BrandFetchError(E_TOO_MANY_REDIRECTS, f"more than {MAX_HOPS} redirects")
            current = derive_url(current, ans.location)
        raise AssertionError("unreachable")

    def _allowed(self, host: str, target: str) -> bool:
        if host not in self._robots:
            self._robots[host] = self._read_robots(host)
        rules = self._robots[host]
        return rules is not None and rules.allowed(target)

    def _read_robots(self, host: str) -> Optional[RobotsRules]:
        """The rules of ``host``; None means "disallow everything" (it could not be read)."""
        try:
            got = self._get(f"https://{host}/robots.txt", ROBOTS)
        except BrandFetchError as e:
            if e.code == E_HTTP and getattr(e, "status", 0) and 400 <= e.status < 500:
                return RobotsRules()      # RFC 9309: unavailable (4xx) = no rules
            if e.code in (E_TIMEOUT, E_NOT_PUBLIC, E_DNS, E_CONNECT, E_TLS, E_LIMIT):
                raise                     # the scan is over / the host cannot be read anyway: say that, not "robots"
            return None                   # 5xx, too large, compressed, an off-site or endless redirect: disallow all
        # Whatever the content type says: a site that serves its rules as text/html or octet-stream still meant them.
        # utf-8-sig: a byte-order mark would otherwise glue itself to the first "User-agent" and lose that group.
        return RobotsRules(got.body.decode("utf-8-sig", errors="replace"))

    def _addresses(self, host: str) -> Tuple[str, ...]:
        """The pinned answers for ``host``: resolved once per scan, every one public, or a refusal."""
        if host in self._pinned:
            return self._pinned[host]
        self.budget.check()
        if host not in self._looked_up and len(self._looked_up) >= MAX_HOSTS:
            raise BrandFetchError(E_LIMIT, f"at most {MAX_HOSTS} host names per scan; {host} was not looked up")
        self._looked_up.add(host)
        answers = list(dict.fromkeys(self._resolve_within_budget(host)))
        if not answers:
            raise BrandFetchError(E_DNS, f"{host} has no address")
        for a in answers:
            problem = address_problem(a)
            if problem:
                raise BrandFetchError(E_NOT_PUBLIC, f"{host} resolves to {problem}; nothing was requested")
        self._pinned[host] = tuple(answers)
        return self._pinned[host]

    def _resolve_within_budget(self, host: str) -> List[str]:
        """``getaddrinfo`` has no timeout of its own and the customer runs the name server, so it runs in a thread that
        is waited for at most the connect timeout or what is left of the scan. A lookup that does not come back in
        time is abandoned (the thread ends on its own; its answer is never used)."""
        resolve = self._net.resolve if self._net is not None else _system_resolve
        wait = self.budget.timeout(CONNECT_TIMEOUT_S)
        box: Dict[str, object] = {}

        def run():
            try:
                box["answers"] = list(resolve(host))
            except (OSError, UnicodeError) as e:
                box["error"] = e

        t = threading.Thread(target=run, name="brand-fetch-dns", daemon=True)
        t.start()
        t.join(wait)
        if t.is_alive():
            if wait < CONNECT_TIMEOUT_S or self.budget.remaining() <= 0:
                raise BrandFetchError(E_TIMEOUT, "the scan's wall clock ran out while a name was being looked up")
            raise BrandFetchError(E_DNS, f"{host} did not resolve within {wait:g} s")
        if "error" in box:
            raise BrandFetchError(E_DNS, f"{host} did not resolve ({type(box['error']).__name__})")
        return box.get("answers", [])

    def _open(self, host: str) -> ssl.SSLSocket:
        connect = self._net.connect if self._net is not None else _system_connect
        if self._tls is None:
            self._tls = _system_tls()      # the trust store is read once per scan, not once per request
        tls = self._tls
        if not tls.check_hostname or tls.verify_mode != ssl.CERT_REQUIRED:
            raise BrandFetchError(E_TLS, "a TLS context that does not verify the certificate's name is refused")
        last = "no address"
        for ip in self._addresses(host):
            try:
                raw = connect(ip, self.budget.timeout(CONNECT_TIMEOUT_S))
            except BrandFetchError:
                raise
            except OSError as e:
                last = type(e).__name__
                continue
            try:
                raw.settimeout(self.budget.timeout(READ_TIMEOUT_S))
                return tls.wrap_socket(raw, server_hostname=host)
            except ssl.SSLError as e:
                raw.close()
                raise BrandFetchError(E_TLS, f"TLS with {host} failed ({e.reason or type(e).__name__}); the "
                                             f"certificate must be valid for the name") from None
            except (OSError, BrandFetchError) as e:
                raw.close()
                if isinstance(e, BrandFetchError):
                    raise
                self._timeout_or(E_CONNECT, f"TLS with {host} did not complete ({type(e).__name__})")
        raise BrandFetchError(E_CONNECT, f"could not connect to {host} ({last})")

    def _timeout_or(self, code: str, message: str):
        if self.budget.remaining() <= 0:
            raise BrandFetchError(E_TIMEOUT, "the scan's wall clock ran out")
        raise BrandFetchError(code, message)

    def _request(self, host: str, target: str, kind: str) -> _Answer:
        cap = MAX_BYTES[kind]
        sock = _DeadlineSocket(self._open(host), self.budget, MAX_HEADER_BYTES)
        conn = _Conn(host, sock)
        try:
            try:
                conn.putrequest("GET", target, skip_host=True, skip_accept_encoding=True)
                for k, v in (("Host", host), ("User-Agent", USER_AGENT), ("Accept", ACCEPT[kind]),
                             ("Accept-Encoding", "identity"), ("Connection", "close")):
                    conn.putheader(k, v)
                conn.endheaders()
                resp = conn.getresponse()
                sock.limit = sock.read_total + cap + MAX_FRAMING_BYTES
                return self._answer(resp, kind, cap)
            except (socket.timeout, TimeoutError):
                self._timeout_or(E_TIMEOUT, f"{host} did not answer within {READ_TIMEOUT_S:g} s")
            except (http.client.HTTPException, ValueError) as e:
                raise BrandFetchError(E_BAD_RESPONSE, f"{host} sent an answer that is not HTTP/1.1 "
                                                      f"({type(e).__name__})") from None
            except OSError as e:
                self._timeout_or(E_CONNECT, f"the connection to {host} failed ({type(e).__name__})")
        finally:
            conn.close()
            sock.close()
        raise AssertionError("unreachable")

    def _answer(self, resp: http.client.HTTPResponse, kind: str, cap: int) -> _Answer:
        status = resp.status
        if status in (301, 302, 303, 307, 308):
            location = resp.getheader("Location")
            if not location:
                raise BrandFetchError(E_REDIRECT, f"HTTP {status} without a Location")
            return _Answer(status, location, "", b"")
        if status != 200:
            err = BrandFetchError(E_HTTP, f"HTTP {status}")
            err.status = status
            raise err
        encoding = (resp.getheader("Content-Encoding") or "").strip().lower()
        if encoding not in ("", "identity"):
            raise BrandFetchError(E_COMPRESSED, f"the answer is {encoding}-encoded; only identity is read")
        transfer = resp.getheader("Transfer-Encoding")
        if transfer is not None and transfer.strip().lower() != "chunked":
            raise BrandFetchError(E_COMPRESSED, f"transfer coding {transfer!r} is refused")
        ctype = (resp.getheader("Content-Type") or "").split(";", 1)[0].strip().lower()
        if kind != ROBOTS:
            if ctype == "image/svg+xml":
                raise BrandFetchError(E_SVG, "SVG is a document that can carry script; it is not read")
            if ctype not in ALLOWED_TYPES[kind]:
                raise BrandFetchError(E_CONTENT_TYPE, f"{ctype or 'no content type'} is not one of "
                                                      f"{', '.join(ALLOWED_TYPES[kind])}")
        declared = resp.getheader("Content-Length")
        if declared is not None:
            try:
                n = int(declared)
            except ValueError:
                raise BrandFetchError(E_BAD_RESPONSE, "an unreadable Content-Length") from None
            if n > cap:
                raise BrandFetchError(E_TOO_LARGE, f"the answer is {n} bytes, over the {cap} byte cap; not read")
        body = bytearray()
        while True:
            chunk = resp.read(min(64 * 1024, cap + 1 - len(body)))
            if not chunk:
                break
            body += chunk
            if len(body) > cap:
                raise BrandFetchError(E_TOO_LARGE, f"the answer is over the {cap} byte cap; stopped reading")
        if kind == IMAGE and sniff_image_mime(bytes(body[:16])) != ctype:
            raise BrandFetchError(E_CONTENT_TYPE, f"the bytes are not a {ctype} picture")
        return _Answer(status, None, ctype, bytes(body))
