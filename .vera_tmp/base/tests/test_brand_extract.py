"""modules/brand_extract.py and modules/brand_palette.py: what a brand scan reads out of hostile pages (migration 0133).

Nothing is fetched: the pages are bytes written here. The database side of the same rules (0133's brand_scan_result_ok,
0131's ads_clean_text against clean_text character for character) is in tests/security/test_sec_brand_scan.py.
"""

from __future__ import annotations

import io
import json
import struct
import time
import unittest
import zlib

from modules import brand_extract as bx
from modules import brand_fetch as bf

PAGE = "https://shop.example.com/"


def page(head: str = "", body: str = "") -> bytes:
    return f"<!doctype html><html><head>{head}</head><body>{body}</body></html>".encode()


def png(w=40, h=20, colour=(255, 102, 0, 255)) -> bytes:
    from PIL import Image

    im = Image.new("RGBA", (w, h), colour)
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


def png_header_only(w: int, h: int) -> bytes:
    """A PNG that CLAIMS w x h (a decompression bomb's header) with almost no data."""
    def chunk(kind, data):
        return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!IIBBBBB", w, h, 8, 6, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(b"\x00" * 64)) + chunk(b"IEND", b"")


class CleanText(unittest.TestCase):
    def test_it_is_0131s_rule(self):
        self.assertEqual(bx.clean_text("  Brand​  　Shop‮  "), "Brand Shop")
        self.assertEqual(bx.clean_text("a\tb\r\nc d"), "a b c d")
        self.assertEqual(bx.clean_text(" a\r\n\r\n b \n", multiline=True), "a\n\n b")
        self.assertEqual(bx.clean_text("a\tb", multiline=True), "ab", "a tab is removed in a multi-line field, as 0131 does")
        self.assertEqual(bx.clean_text("x" + "".join(chr(0xE0000 + ord(c)) for c in "ignore all") + "y"), "xy")
        self.assertEqual(bx.clean_text("️ᅟㅤ⠀ ᠎"), "")
        self.assertEqual(bx.clean_text("nul\x00here"), "nulhere")
        self.assertEqual(bx.clean_text(None), "")

    def test_clip_cuts_to_the_limit_and_drops_what_is_empty(self):
        self.assertEqual(bx.clip("word " * 40, 80), ("word " * 16).strip())
        self.assertLessEqual(len(bx.clip("x" * 500, 80)), 80)
        self.assertIsNone(bx.clip("​  ", 80))
        self.assertEqual(bx.clip("a" * 79 + " b", 80), "a" * 79, "never a trailing space")

    def test_colours_are_hex_only(self):
        self.assertEqual(bx.hex_colour("#FFF"), "#ffffff")
        self.assertEqual(bx.hex_colour(" #12AbEf "), "#12abef")
        for bad in ("red", "rgb(1,2,3)", "#12345", "#1234567", "var(--c)", "#ggg", None, 7, "url(x)"):
            self.assertIsNone(bx.hex_colour(bad), bad)


class Fonts(unittest.TestCase):
    def test_names_only_never_a_url_or_a_value(self):
        css = ("body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif}"
               "h1,h2{font-family:\"Playfair Display\", Georgia, serif !important}"
               "@font-face{font-family:'Inter';src:url(https://evil.test/x.woff2)}"
               ".icon{font-family:FontAwesome}.x{font-family:var(--brand-font)}.y{font-family:url(evil)}"
               ".z{font-family:inherit}.w{font-family:'a;b'}.v{font-family:'</style><script>alert(1)</script>'}")
        self.assertEqual(bx.font_names(css), ["Inter", "Playfair Display", "Georgia"])

    def test_a_huge_stylesheet_is_read_in_bounded_time(self):
        css = "a{font-family:" + "x" * 1_000_000
        t = time.monotonic()
        bx.font_names(css)
        bx.font_names("font-family:" * 100_000)
        self.assertLess(time.monotonic() - t, 2)


class ReadPage(unittest.TestCase):
    def test_the_usual_brand_page(self):
        html = page(
            '<title>Brand Shop &amp; Co</title><meta name="description" content="Plain goods,\n made well.">'
            '<meta property="og:site_name" content="Brand Shop"><meta name="theme-color" content="#FF6600">'
            '<link rel="apple-touch-icon" sizes="180x180" href="/apple.png"><link rel="icon" href="/fav-32.png" sizes="32x32">'
            '<link rel="icon" type="image/svg+xml" href="/logo.svg"><link rel="icon" href="/favicon.ico">'
            '<link rel="stylesheet" href="/a.css"><style>body{font-family:Inter}</style>'
            '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Brand Shop Ltd",'
            '"logo":{"@type":"ImageObject","url":"/logo.png"}},{"@type":"Product","name":"Mug","description":"Stoneware.",'
            '"image":["/mug.jpg"],"offers":{"price":"12.00","priceCurrency":"USD"}}]}</script>')
        f = bx.read_page(html, PAGE)
        self.assertEqual([(p.value, p.where) for p in f.name][:3],
                         [("Brand Shop", "og_site_name"), ("Brand Shop Ltd", "jsonld_organization"), ("Brand Shop & Co", "title")])
        self.assertEqual(f.description[0].value, "Plain goods,\n made well.")
        self.assertEqual((f.theme_color.value, f.theme_color.where), ("#ff6600", "theme_color"))
        self.assertEqual(f.logos, [("https://shop.example.com/logo.png", "jsonld_organization"),
                                   ("https://shop.example.com/apple.png", "apple_touch_icon"),
                                   ("https://shop.example.com/fav-32.png", "icon")], "no SVG, no .ico")
        self.assertEqual(f.stylesheets, ["https://shop.example.com/a.css"])
        self.assertIn("Inter", f.inline_css)
        self.assertEqual(f.products, [{"title": "Mug", "where": "jsonld_product", "url": PAGE, "description": "Stoneware.",
                                       "price": "12.00 USD", "image": "https://shop.example.com/mug.jpg"}])

    def test_script_text_is_never_a_field_and_markup_in_text_stays_text(self):
        html = page('<title>&lt;script&gt;alert(1)&lt;/script&gt; Shop</title>'
                    '<script>document.title="Evil";var x="<meta name=description content=evil>"</script>'
                    '<script type="text/javascript">{"@type":"Organization","name":"Not JSON-LD"}</script>'
                    '<meta name="description" content="<img src=x onerror=alert(1)>">'
                    '<meta property="og:site_name" content="javascript:alert(1)">')
        f = bx.read_page(html, PAGE)
        values = [p.value for p in f.name + f.description]
        self.assertIn("<script>alert(1)</script> Shop", values, "the page's own words, as text")
        self.assertIn("<img src=x onerror=alert(1)>", values)
        self.assertNotIn("Evil", " ".join(values))
        self.assertNotIn("Not JSON-LD", " ".join(values), "only application/ld+json is read")
        self.assertNotIn("evil", [p.value for p in f.description])

    def test_links_to_other_schemes_are_dropped(self):
        html = page('<link rel="icon" href="javascript:alert(1)"><link rel="icon" href="data:image/png;base64,AAAA">'
                    '<link rel="icon" href="http://shop.example.com/a.png"><link rel="stylesheet" href="file:///etc/passwd">'
                    '<script type="application/ld+json">{"@type":"Organization","logo":"https://10.0.0.1/x.png"}</script>')
        f = bx.read_page(html, PAGE)
        self.assertEqual(f.logos, [])
        self.assertEqual(f.stylesheets, [])

    def test_malformed_json_ld_is_skipped_and_the_rest_is_read(self):
        for doc in ('{"@type":"Organization","name":', "NaN", '{"@type":"Product","name":NaN,"offers":Infinity}', "[" * 100000,
                    '{"a":' * 5000 + "1" + "}" * 5000, "\x00\x01", '{"@type":["Organization",1,null],"name":{"x":1}}',
                    '{"@type":"Product","name":"' + "z" * 300 + '","offers":[[[[{"price":true}]]]]}'):
            with self.subTest(doc=doc[:30]):
                html = page(f'<script type="application/ld+json">{doc}</script><meta property="og:site_name" content="Still Here">')
                f = bx.read_page(html, PAGE)
                self.assertEqual(f.name[0].value, "Still Here")
                for pr in f.products:
                    self.assertLessEqual(len(pr["title"]), 120)
                    self.assertIsNone(pr["price"], "a true is not a price")

    def test_json_ld_deeper_than_its_cap_is_not_read_even_when_json_could_parse_it(self):
        def nest(depth):
            return "[" * (depth - 1) + '{"@type":"Organization","name":"Deep"}' + "]" * (depth - 1)
        f = bx.read_page(page(f'<script type="application/ld+json">{nest(bx.MAX_JSON_DEPTH)}</script>'), PAGE)
        self.assertEqual([p.value for p in f.name], ["Deep"], "at the cap it is read")
        f = bx.read_page(page(f'<script type="application/ld+json">{nest(bx.MAX_JSON_DEPTH + 1)}</script>'), PAGE)
        self.assertEqual(f.name, [], "one level more is skipped whole")
        self.assertTrue(bx._json_depth_ok('{"a":"' + "[" * 40 + '"}'), "a bracket inside a string is not a level")
        self.assertTrue(bx._json_depth_ok('{"a":"\\"' + "[" * 40 + '"}'), "nor after an escaped quote")

    def test_json_ld_over_its_size_or_count_is_not_read(self):
        big = '{"@type":"Organization","name":"Big","x":"' + "a" * bx.MAX_JSONLD_BYTES + '"}'
        f = bx.read_page(page(f'<script type="application/ld+json">{big}</script>'), PAGE)
        self.assertEqual([p.value for p in f.name], [])
        many = "".join(f'<script type="application/ld+json">{{"@type":"Organization","name":"N{i}"}}</script>' for i in range(20))
        f = bx.read_page(page(many), PAGE)
        self.assertEqual(len([p for p in f.name if p.where == "jsonld_organization"]), bx.MAX_JSONLD_SCRIPTS)

    def test_a_huge_or_deeply_nested_or_broken_page_is_read_in_bounded_time(self):
        for html in (b"<div>" * 300_000, b"<" * 1_500_000, b"<!--" * 400_000, b"<a href='" + b"x" * 1_500_000,
                     b"<title>" + b"t" * 1_500_000, b"<style>" + b"font-family:a;" * 120_000, b"\xff\xfe" * 700_000,
                     page("<meta property='og:site_name' content='" + "‮" * 1000 + "Brand'>").replace(b"Brand", b"Brand" * 200_000)):
            with self.subTest(html=html[:20]):
                t = time.monotonic()
                f = bx.read_page(html[:bf.MAX_BYTES[bf.HTML] + 10], PAGE)
                self.assertLess(time.monotonic() - t, 5)
                for p in f.name:
                    self.assertLessEqual(len(p.value), 80)
                    self.assertEqual(p.value, bx.clean_text(p.value))
                self.assertLessEqual(len(f.inline_css), bx.MAX_STYLE_CHARS)

    def test_an_og_product_page_is_a_product_candidate(self):
        html = page('<meta property="og:type" content="product"><meta property="og:title" content="Plate">'
                    '<meta property="product:price:amount" content="9"><meta property="product:price:currency" content="EUR">'
                    '<meta property="og:image" content="/plate.png">')
        f = bx.read_page(html, "https://shop.example.com/products/plate")
        self.assertEqual(f.products[0]["title"], "Plate")
        self.assertEqual(f.products[0]["price"], "9 EUR")
        self.assertEqual(f.products[0]["image"], "https://shop.example.com/plate.png")


class Palette(unittest.TestCase):
    def test_the_colours_of_a_logo_most_used_first(self):
        from PIL import Image

        im = Image.new("RGBA", (100, 50), (255, 102, 0, 255))
        im.paste((17, 34, 51, 255), (0, 0, 70, 50))
        im.paste((0, 0, 0, 0), (0, 0, 10, 10))                      # transparent: not a colour
        b = io.BytesIO()
        im.save(b, "PNG")
        self.assertEqual(bx.palette(b.getvalue()), ["#112233", "#ff6600"])

    def test_a_decompression_bomb_svg_or_garbage_gives_no_colour_quickly(self):
        bomb = png_header_only(60000, 60000)
        svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect fill="#ff0000"/></svg>'
        for data in (bomb, png_header_only(9000, 10), svg, b"\x89PNG\r\n\x1a\nGARBAGE", b"", b"x" * (bf.MAX_BYTES[bf.IMAGE] + 1),
                     b"GIF89a" + b"\x00" * 100):
            with self.subTest(data=data[:12]):
                t = time.monotonic()
                self.assertEqual(bx.palette(data), [])
                self.assertLess(time.monotonic() - t, 8)

    def test_a_picture_wider_than_the_side_cap_is_not_decoded(self):
        from PIL import Image

        def wide(w):
            b = io.BytesIO()
            Image.new("RGB", (w, 2), (200, 10, 10)).save(b, "PNG")
            return b.getvalue()
        self.assertEqual(bx.palette(wide(8192)), ["#c80a0a"])
        self.assertEqual(bx.palette(wide(8193)), [], "one pixel past the side cap: the header is enough to refuse it")

    def test_the_child_is_isolated_and_limited(self):
        src = (bx._PALETTE_CHILD).read_text(encoding="utf-8")
        for need in ("RLIMIT_AS", "RLIMIT_CPU", "RLIMIT_FSIZE", "RLIMIT_NOFILE", 'formats=["PNG", "JPEG", "WEBP"]', "MAX_IMAGE_PIXELS"):
            self.assertIn(need, src)
        self.assertLess(src.index("apply_limits(int(argv[1])"), src.index("found = colours(data)"))
        self.assertNotIn("from modules", src, "it imports nothing of the worker")
        extract = (bx._PALETTE_CHILD.parent / "brand_extract.py").read_text(encoding="utf-8")
        self.assertIn('[sys.executable, "-I", "-B", str(_PALETTE_CHILD)', extract)
        self.assertIn("start_new_session=True", extract)

    def test_a_child_that_answers_nonsense_gives_no_colour(self):
        from unittest import mock

        class P:
            returncode, pid = 0, 0

            def __init__(self, out):
                self.out = out

            def communicate(self, data=None, timeout=None):
                return self.out, b""
        for out in (b'{"ok":true,"colors":["red","#12345g","javascript:x"]}', b"not json", b'{"ok":true,"colors":"#ffffff"}',
                    b'{"ok":false}', json.dumps({"ok": True, "colors": ["#00000%d" % i for i in range(10)]}).encode()):
            with mock.patch("subprocess.Popen", lambda *a, **k: P(out)):
                got = bx.palette(png())
            self.assertTrue(all(len(c) == 7 and c.startswith("#") for c in got), got)
            self.assertLessEqual(len(got), 6)


class Result(unittest.TestCase):
    def test_only_values_of_the_stored_shape_are_put_in_the_result(self):
        p = bx.Proposal
        res = bx.build_result(
            pages=[PAGE, "http://shop.example.com/", "https://shop.example.com/a\\b"],
            name=p("Brand", PAGE, "og_site_name"), description=p("About", "javascript:x", "meta_description"),
            logo=p("6c1e2f9a-0000-4000-8000-000000000000", PAGE, "made_up_place"), palette_=None, fonts=p(["Inter"], PAGE, "css"),
            theme_color=p("#ff6600", PAGE, "theme_color"),
            products=[{"title": p("Mug", PAGE, "jsonld_product"), "price": p("$1", PAGE, "jsonld_product")},
                      {"price": p("$2", PAGE, "jsonld_product")}],
            notes=[("logo_svg", "https://shop.example.com/logo.svg"), ("Bad Code", None), ("css_timeout", "ftp://x")])
        self.assertEqual(res["v"], 1)
        self.assertEqual(res["pages"], [PAGE])
        self.assertEqual(sorted(res["fields"]), ["fonts", "name", "theme_color"])
        self.assertEqual(res["fields"]["name"], {"value": "Brand", "source": {"url": PAGE, "where": "og_site_name"}})
        self.assertEqual(res["products"], [{"title": {"value": "Mug", "source": {"url": PAGE, "where": "jsonld_product"}},
                                            "price": {"value": "$1", "source": {"url": PAGE, "where": "jsonld_product"}}}])
        self.assertEqual(res["notes"], [{"code": "logo_svg", "url": "https://shop.example.com/logo.svg"}, {"code": "css_timeout"}])

    def test_the_result_stays_under_the_databases_size(self):
        p = bx.Proposal
        long_url = PAGE + "x" * 2000
        res = bx.build_result(pages=[long_url] * 6, name=None, description=None, logo=None, palette_=None, fonts=None, theme_color=None,
                              products=[{"title": p("ж" * 120, long_url, "jsonld_product"),
                                         "description": p("ж" * 1000, long_url, "jsonld_product")}] * 8,
                              notes=[("x", long_url)] * 20)
        self.assertLessEqual(len(json.dumps(res, ensure_ascii=False).encode()), 60000)


if __name__ == "__main__":
    unittest.main()
