"""What a brand scan reads out of the pages the fetcher brought back (docs/ADS_FACTORY.md, Phase 2, "Extraction").

Input: bytes the fetcher already capped (``modules/brand_fetch.py``: a page at most 1.5 MB, a stylesheet 256 KB).
Output: PROPOSED fields, each with the page and the place it came from; the person accepts them one by one
(migration 0133, ``accept_brand_scan_fields``). No model is called and nothing here fetches anything.

Every string is untrusted. It is read once by the HTML parser (character references decoded once, by the parser), then
``clean_text``: exactly 0131's ``ads_clean_text`` (control characters, every character nobody sees, the Unicode tag
block, the variation selectors and the fillers removed; blank-looking spaces read as one space; tests/security pins the
two equal, character for character), then cut to 0131's length for the field. A field that is empty after that is not
proposed. Nothing is rendered as HTML (the page shows text), and a script's text is never read as anything but a
JSON-LD document of at most ``MAX_JSONLD_BYTES`` and ``MAX_JSON_DEPTH`` levels; a ``<script>`` that is not JSON-LD is
skipped whole, so ``<script>alert(1)</script>`` is never a title, a name or a description.

What is read: ``<title>``, the meta description, Open Graph and Twitter cards, ``theme-color``, JSON-LD ``Organization``
(and its kinds: ``Brand``, ``Store``, ``OnlineStore``, ``LocalBusiness``) and ``Product``, icon and logo candidates
(``<link rel=icon / apple-touch-icon>``; never an SVG, which the fetcher refuses), and ``font-family`` NAMES from inline
``<style>`` and linked stylesheets (no font is downloaded; a name is letters, digits, space, dot, underscore, apostrophe
and hyphen, never a URL or a CSS value). The palette is read from the logo by ``modules/brand_palette.py`` in a child
process (``palette``).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from modules import brand_fetch as bf

# ── text, as 0131 stores it ───────────────────────────────────────────────────────────────────────────────────────

#: 0131's ads_clean_text class, single-line (the multi-line class keeps U+000A). tests/security pins the two equal.
_INVISIBLE_RANGES = ("\u0001-\u001f\u007f-\u009f­͏؜ᅟᅠ឴឵᠋-᠏​-‏ -‮"
                     "⁠-⁯⠀ㅤ︀-️﻿ﾠ￰-￻\U00013430-\U0001343f\U0001bca0-\U0001bca3"
                     "\U0001d173-\U0001d17a\U000e0000-\U000e0fff")
_INVISIBLE_ONE = re.compile(f"[{_INVISIBLE_RANGES}]")
_INVISIBLE_MULTI = re.compile("[\u0001-\u0009\u000b-\u001f" + _INVISIBLE_RANGES[len("\u0001-\u001f"):] + "]")
_BREAKS_ONE = re.compile("[\u0009-\u000d  ]+")
_SPACES = re.compile("[    -   　]+")


def clean_text(text, *, multiline: bool = False) -> str:
    """0131's ``ads_clean_text``: a one-line field reads a run of line breaks and tabs as one space; a multi-line field
    folds \\r\\n and \\r to \\n and keeps line breaks only; every character of the class is removed; a run of spaces
    (blank-looking ones too) is one space; spaces and line breaks are trimmed from both ends. A NUL (which a database text
    cannot hold) is removed first."""
    s = "" if text is None else str(text).replace("\x00", "")
    if multiline:
        s = re.sub("\r\n?", "\n", s)
        s = _INVISIBLE_MULTI.sub("", s)
    else:
        s = _BREAKS_ONE.sub(" ", s)
        s = _INVISIBLE_ONE.sub("", s)
    return _SPACES.sub(" ", s).strip(" \n")


def clip(text, limit: int, *, multiline: bool = False) -> Optional[str]:
    """Cleaned and at most ``limit`` characters (cut at the last space when there is one in the last fifth), or None when
    nothing a person can read is left."""
    s = clean_text(text, multiline=multiline)
    if len(s) > limit:
        cut = s[:limit]
        space = cut.rfind(" ")
        if space >= limit * 4 // 5:
            cut = cut[:space]
        s = clean_text(cut, multiline=multiline)
    return s or None


#: 0131's font NAME (ads_text_list_ok): starts with a letter or digit; letters, digits, space . _ ' -; at most 60.
_FONT_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9 ._'-]{0,59}\Z")
_GENERIC_FONTS = frozenset({
    "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace",
    "ui-rounded", "math", "emoji", "fangsong", "inherit", "initial", "unset", "revert", "revert-layer", "-apple-system",
    "blinkmacsystemfont", "apple color emoji", "segoe ui emoji", "segoe ui symbol", "noto color emoji",
})
_HEX = re.compile(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\Z")


def hex_colour(value) -> Optional[str]:
    """``#rgb`` or ``#rrggbb`` as lower-case ``#rrggbb``; anything else (a name, rgb(), a variable) is None."""
    m = _HEX.match(clean_text(value)) if isinstance(value, str) else None
    if not m:
        return None
    h = m.group(1).lower()
    return "#" + ("".join(c * 2 for c in h) if len(h) == 3 else h)


# ── the HTML ──────────────────────────────────────────────────────────────────────────────────────────────────────

MAX_TITLE_CHARS = 4096
MAX_JSONLD_BYTES = 256 * 1024
MAX_JSONLD_SCRIPTS = 8
MAX_JSON_DEPTH = 32
MAX_STYLE_CHARS = 256 * 1024
MAX_STYLESHEETS = 4
MAX_JSON_NODES = 2000

_META_NAMES = frozenset({"description", "theme-color", "twitter:title", "twitter:description", "twitter:image",
                         "twitter:image:src", "application-name"})
_META_PROPERTIES = frozenset({"og:title", "og:description", "og:site_name", "og:image", "og:image:secure_url", "og:type",
                              "product:price:amount", "product:price:currency", "og:price:amount", "og:price:currency"})


class _Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title: Optional[str] = None
        self._in_title = False
        self._title_buf: List[str] = []
        self.meta: Dict[str, str] = {}
        self.icons: List[Tuple[str, str, int]] = []          # (rel, href, size)
        self.stylesheets: List[str] = []
        self.jsonld: List[str] = []
        self.styles: List[str] = []
        self._style_chars = 0
        self._script: Optional[List[str]] = None
        self._script_bytes = 0
        self._in_style = False

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs if k}
        if tag == "title" and self.title is None:
            self._in_title = True
        elif tag == "meta":
            key = (a.get("name") or "").strip().lower()
            prop = (a.get("property") or "").strip().lower()
            content = a.get("content")
            if content is not None:
                if key in _META_NAMES and key not in self.meta:
                    self.meta[key] = content
                if prop in _META_PROPERTIES and prop not in self.meta:
                    self.meta[prop] = content
        elif tag == "link":
            rel = " ".join((a.get("rel") or "").lower().split())
            href = a.get("href") or ""
            if not href or len(href) > bf.MAX_LINK_CHARS:
                return
            if rel in ("icon", "shortcut icon", "apple-touch-icon", "apple-touch-icon-precomposed") and len(self.icons) < 32:
                if (a.get("type") or "").lower() == "image/svg+xml" or href.lower().split("?", 1)[0].endswith((".svg", ".ico")):
                    return
                sizes = re.findall(r"(\d{1,4})x\d{1,4}", (a.get("sizes") or "").lower())
                self.icons.append((rel, href, max((int(x) for x in sizes), default=0)))
            elif "stylesheet" in rel.split() and len(self.stylesheets) < MAX_STYLESHEETS * 4:
                self.stylesheets.append(href)
        elif tag == "script":
            if (a.get("type") or "").strip().lower() == "application/ld+json" and len(self.jsonld) < MAX_JSONLD_SCRIPTS:
                self._script, self._script_bytes = [], 0
            else:
                self._script = None                            # any other script: its text is skipped whole
        elif tag == "style":
            self._in_style = True

    def handle_endtag(self, tag):
        if tag == "title" and self._in_title:
            self._in_title = False
            self.title = "".join(self._title_buf)
        elif tag == "script":
            if self._script is not None and self._script_bytes <= MAX_JSONLD_BYTES:
                self.jsonld.append("".join(self._script))
            self._script = None
        elif tag == "style":
            self._in_style = False

    def handle_data(self, data):
        if self._in_title and sum(map(len, self._title_buf)) < MAX_TITLE_CHARS:
            self._title_buf.append(data[:MAX_TITLE_CHARS])
        elif self._script is not None:
            self._script_bytes += len(data.encode("utf-8", "replace"))
            if self._script_bytes <= MAX_JSONLD_BYTES:
                self._script.append(data)
        elif self._in_style and self._style_chars < MAX_STYLE_CHARS:
            chunk = data[:MAX_STYLE_CHARS - self._style_chars]
            self.styles.append(chunk)
            self._style_chars += len(chunk)


def _json_depth_ok(text: str) -> bool:
    """No more than MAX_JSON_DEPTH levels of [ and { (outside strings), checked before ``json.loads`` sees the text."""
    depth, in_str, esc = 0, False, False
    for ch in text:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch in "[{":
            depth += 1
            if depth > MAX_JSON_DEPTH:
                return False
        elif ch in "]}":
            depth -= 1
    return True


def _types(node: dict) -> List[str]:
    t = node.get("@type")
    if isinstance(t, str):
        return [t]
    if isinstance(t, list):
        return [x for x in t if isinstance(x, str)][:8]
    return []


_ORG_TYPES = frozenset({"Organization", "Brand", "Store", "OnlineStore", "LocalBusiness", "Corporation", "OnlineBusiness"})


def _url_of(value) -> Optional[str]:
    """An image or logo value of JSON-LD: a string, an ImageObject (url / contentUrl), or a list of those (the first)."""
    for _ in range(4):
        if isinstance(value, list):
            value = value[0] if value else None
        elif isinstance(value, dict):
            value = value.get("url") or value.get("contentUrl")
        else:
            break
    return value if isinstance(value, str) else None


def _jsonld_nodes(texts: Sequence[str]) -> List[dict]:
    """Every object of the JSON-LD documents (``@graph`` and nested values walked), at most MAX_JSON_NODES."""
    out: List[dict] = []
    for text in texts:
        if len(text.encode("utf-8", "replace")) > MAX_JSONLD_BYTES or not _json_depth_ok(text):
            continue
        try:
            doc = json.loads(text, parse_constant=lambda _c: None)
        except (ValueError, RecursionError):
            continue
        stack = [doc]
        while stack and len(out) < MAX_JSON_NODES:
            v = stack.pop()
            if isinstance(v, dict):
                out.append(v)
                stack.extend(x for x in v.values() if isinstance(x, (dict, list)))
            elif isinstance(v, list):
                stack.extend(x for x in v[:200] if isinstance(x, (dict, list)))
    return out


# ── CSS ───────────────────────────────────────────────────────────────────────────────────────────────────────────

_FONT_FAMILY = re.compile(r"font-family\s*:\s*([^;{}]{1,300})", re.IGNORECASE)


def font_names(css: str) -> List[str]:
    """The font family NAMES a stylesheet uses, in order of first use, without generic families, CSS-wide keywords,
    variables, or icon fonts. Never a URL: a name is 0131's shape or it is dropped."""
    seen: Dict[str, int] = {}
    for m in _FONT_FAMILY.finditer(css[:MAX_STYLE_CHARS]):
        for raw in m.group(1).split(","):
            name = raw.replace("!important", "").strip()
            if name[:1] in ("'", '"'):
                # A quoted name is read only when its closing quote is there too: 'a;b' cut at the ';' is no name.
                if len(name) < 2 or name[-1] != name[0]:
                    continue
                name = name[1:-1].strip()
            low = name.lower()
            if not name or low in _GENERIC_FONTS or "var(" in low or any(w in low for w in ("icon", "awesome", "glyph")):
                continue
            if not _FONT_NAME.match(name):
                continue
            seen[name] = seen.get(name, 0) + 1
    return sorted(seen, key=lambda n: -seen[n])


# ── one page, and the whole scan ──────────────────────────────────────────────────────────────────────────────────

@dataclass
class Proposal:
    """A proposed value with where it came from (0133's field: ``{value, source: {url, where}}``)."""

    value: object
    url: str
    where: str

    def as_field(self) -> dict:
        return {"value": self.value, "source": {"url": self.url, "where": self.where}}


@dataclass
class PageFacts:
    url: str
    name: List[Proposal] = field(default_factory=list)
    description: List[Proposal] = field(default_factory=list)
    theme_color: Optional[Proposal] = None
    logos: List[Tuple[str, str]] = field(default_factory=list)          # (absolute URL, where)
    stylesheets: List[str] = field(default_factory=list)
    inline_css: str = ""
    products: List[dict] = field(default_factory=list)


def _derive(page_url: str, ref) -> Optional[str]:
    if not isinstance(ref, str):
        return None
    try:
        return bf.derive_url(page_url, ref)
    except bf.BrandFetchError:
        return None


def _price_text(offers) -> Optional[str]:
    for _ in range(3):
        if isinstance(offers, list):
            offers = offers[0] if offers else None
    if not isinstance(offers, dict):
        return None
    price = offers.get("price", offers.get("lowPrice"))
    if isinstance(price, bool) or not isinstance(price, (str, int, float)):
        return None
    currency = offers.get("priceCurrency")
    text = f"{price} {currency}" if isinstance(currency, str) else f"{price}"
    return clip(text, 40)


def read_page(html: bytes, page_url: str) -> PageFacts:
    """Everything one page proposes. Hostile markup ends the reading where the parser got to."""
    p = _Page()
    try:
        p.feed(html[:bf.MAX_BYTES[bf.HTML]].decode("utf-8", errors="replace"))
        p.close()
    except Exception:  # noqa: BLE001 — a parser error on hostile markup keeps what was read
        pass
    f = PageFacts(page_url)
    m = p.meta
    for key, where in (("og:site_name", "og_site_name"),):
        v = clip(m.get(key), 80)
        if v:
            f.name.append(Proposal(v, page_url, where))
    for key, where in (("description", "meta_description"), ("og:description", "og_description"),
                       ("twitter:description", "twitter_description")):
        v = clip(m.get(key), 1000, multiline=True)
        if v:
            f.description.append(Proposal(v, page_url, where))
    colour = hex_colour(m.get("theme-color"))
    if colour:
        f.theme_color = Proposal(colour, page_url, "theme_color")
    nodes = _jsonld_nodes(p.jsonld)
    for node in nodes:
        types = _types(node)
        if _ORG_TYPES.intersection(types):
            v = clip(node.get("name"), 80) if isinstance(node.get("name"), str) else None
            if v:
                f.name.append(Proposal(v, page_url, "jsonld_organization"))
            d = clip(node.get("description"), 1000, multiline=True) if isinstance(node.get("description"), str) else None
            if d:
                f.description.append(Proposal(d, page_url, "jsonld_organization"))
            logo = _derive(page_url, _url_of(node.get("logo")))
            if logo:
                f.logos.append((logo, "jsonld_organization"))
        if "Product" in types and len(f.products) < 8:
            title = clip(node.get("name"), 120) if isinstance(node.get("name"), str) else None
            if title:
                f.products.append({
                    "title": title, "where": "jsonld_product", "url": page_url,
                    "description": clip(node.get("description"), 1000, multiline=True) if isinstance(node.get("description"), str) else None,
                    "price": _price_text(node.get("offers")),
                    "image": _derive(page_url, _url_of(node.get("image"))),
                })
    if not any(pr["where"] == "jsonld_product" for pr in f.products) and (m.get("og:type") or "").strip().lower() == "product":
        title = clip(m.get("og:title"), 120)
        if title:
            amount, cur = m.get("product:price:amount") or m.get("og:price:amount"), m.get("product:price:currency") or m.get("og:price:currency")
            f.products.append({
                "title": title, "where": "og_title", "url": page_url,
                "description": clip(m.get("og:description"), 1000, multiline=True),
                "price": clip(f"{amount} {cur or ''}", 40) if amount else None,
                "image": _derive(page_url, m.get("og:image:secure_url") or m.get("og:image")),
            })
    title = clip(p.title, 80)
    if title:
        f.name.append(Proposal(title, page_url, "title"))
    tw = clip(m.get("twitter:title"), 80)
    if tw:
        f.name.append(Proposal(tw, page_url, "twitter_title"))
    og = clip(m.get("og:title"), 80)
    if og:
        f.name.append(Proposal(og, page_url, "og_title"))
    for rel, href, size in sorted(p.icons, key=lambda x: (x[0].startswith("apple-touch-icon") is False, -x[2])):
        u = _derive(page_url, href)
        if u:
            f.logos.append((u, "apple_touch_icon" if rel.startswith("apple") else "icon"))
    f.stylesheets = [u for u in (_derive(page_url, h) for h in p.stylesheets) if u][:MAX_STYLESHEETS]
    f.inline_css = "".join(p.styles)
    return f


# ── the palette, from the logo, in a child process ───────────────────────────────────────────────────────────────

_PALETTE_CHILD = Path(__file__).resolve().parent / "brand_palette.py"
PALETTE_TIMEOUT_S = 10.0
PALETTE_MEM_BYTES = 768 * 1024 * 1024
PALETTE_CPU_S = 8


def palette(image: bytes, *, timeout_s: float = PALETTE_TIMEOUT_S) -> List[str]:
    """Up to 6 ``#rrggbb`` colours of a PNG / JPEG / WEBP picture, most used first, or [] when it cannot be read. The
    picture is decoded by ``modules/brand_palette.py`` in a CHILD process (argv only, a near-empty environment so no
    key travels, its own session so a timeout kills it whole, memory / CPU / file limits it sets on itself before
    Pillow opens anything, and a pixel-count check before any pixel is decoded)."""
    if not isinstance(image, (bytes, bytearray)) or not image or len(image) > bf.MAX_BYTES[bf.IMAGE]:
        return []
    argv = [sys.executable, "-I", "-B", str(_PALETTE_CHILD), str(PALETTE_MEM_BYTES), str(PALETTE_CPU_S)]
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8", "OMP_NUM_THREADS": "1",
           "PYTHONDONTWRITEBYTECODE": "1", "MALLOC_ARENA_MAX": "2"}
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
                                cwd="/", close_fds=True, start_new_session=True)
    except OSError:
        return []
    started = time.monotonic()
    try:
        out, _ = proc.communicate(bytes(image), timeout=timeout_s)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, 9)
        except OSError:
            proc.kill()
        proc.communicate()
        return []
    if proc.returncode != 0 or time.monotonic() - started > timeout_s:
        return []
    try:
        answer = json.loads(out[:4096].decode("utf-8", "replace").strip().splitlines()[-1])
    except (ValueError, IndexError):
        return []
    colours = answer.get("colors") if isinstance(answer, dict) and answer.get("ok") is True else None
    if not isinstance(colours, list):
        return []
    clean: List[str] = []
    for c in colours[:6]:
        h = hex_colour(c) if isinstance(c, str) and len(c) == 7 else None
        if h and h not in clean:
            clean.append(h)
    return clean


# ── the result 0133 stores ───────────────────────────────────────────────────────────────────────────────────────

_WHERE = frozenset({"title", "meta_description", "og_site_name", "og_title", "og_description", "og_image", "twitter_title",
                    "twitter_description", "twitter_image", "jsonld_organization", "jsonld_product", "icon",
                    "apple_touch_icon", "theme_color", "css", "logo_palette"})
_NOTE = re.compile(r"[a-z0-9_]{1,64}\Z")


def _url_ok(u) -> bool:
    try:
        bf._shape(u, bf.MAX_DERIVED_URL_CHARS)
    except bf.BrandFetchError:
        return False
    return "\\" not in u


def build_result(*, pages: Sequence[str], name: Optional[Proposal], description: Optional[Proposal],
                 logo: Optional[Proposal], palette_: Optional[Proposal], fonts: Optional[Proposal],
                 theme_color: Optional[Proposal], products: Sequence[dict], notes: Sequence[Tuple[str, Optional[str]]]) -> dict:
    """The jsonb 0133's ``brand_scan_result_ok`` accepts, built only from values that already have its shape: a field
    whose source URL or place is not one of the allowed shapes is left out, never repaired."""
    def ok(p: Optional[Proposal]) -> bool:
        return p is not None and p.where in _WHERE and _url_ok(p.url)

    fields = {}
    for key, p in (("name", name), ("description", description), ("logo", logo), ("palette", palette_), ("fonts", fonts),
                   ("theme_color", theme_color)):
        if ok(p):
            fields[key] = p.as_field()
    prods = []
    for pr in products[:8]:
        if not ok(pr.get("title")):
            continue
        item = {"title": pr["title"].as_field()}
        for k in ("description", "price", "image"):
            if ok(pr.get(k)):
                item[k] = pr[k].as_field()
        prods.append(item)
    out_notes = []
    for code, url in notes:
        if len(out_notes) >= 20 or not _NOTE.match(code or ""):
            continue
        out_notes.append({"code": code, "url": url} if url and _url_ok(url) else {"code": code})
    result = {"v": 1, "pages": [u for u in pages if _url_ok(u)][:6], "fields": fields, "products": prods, "notes": out_notes}
    while len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > 60000 and (result["notes"] or result["products"]):
        (result["notes"] or result["products"]).pop()
    return result
