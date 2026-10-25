"""modules/capabilities/pictures.py: a local picture is read for a vendor only if its BYTES say it is one.

``read_picture`` is the file form (an upload), ``inline_picture`` the ``data:`` URI form; both must refuse the same
things, before anything is sent, and label the picture with the type its first bytes say, never its suffix.
"""

from __future__ import annotations

import base64
import io
import tempfile
import unittest
from pathlib import Path

from modules.capabilities import pictures
from modules.capabilities.base import E_BAD_REQUEST, AdapterError


def encoded(fmt: str) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (10, 20, 30)).save(buf, fmt)
    return buf.getvalue()


class PictureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="pictures_test_"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))

    def file(self, name: str, body: bytes) -> str:
        p = self.tmp / name
        p.write_bytes(body)
        return str(p)

    def test_the_mime_is_the_one_the_bytes_say_whatever_the_suffix(self):
        for fmt, mime in (("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")):
            body = encoded(fmt)
            got_mime, got = pictures.read_picture(self.file("liar.png", body), max_bytes=1 << 20, who="x")
            self.assertEqual((got_mime, got), (mime, body), fmt)
            uri = pictures.inline_picture(self.file("liar.jpg", body), max_bytes=1 << 20, who="x")
            self.assertEqual(uri, f"data:{mime};base64,{base64.b64encode(body).decode()}", fmt)

    def test_both_forms_refuse_the_same_things_with_the_same_words_and_as_not_accepted(self):
        cases = {
            "gone.png": None,                                                   # missing
            "notes.png": b"DB_PASSWORD=hunter2\n" * 20,                          # wears a picture suffix
            "page.webp": b"<html>login</html>",
            "empty.png": b"",
            "a.gif": encoded("GIF"),                                            # a picture, but not a type taken
            "notes.txt": encoded("PNG"),                                        # a picture with another suffix
        }
        for name, body in cases.items():
            ref = self.file(name, body) if body is not None else str(self.tmp / name)
            with self.assertRaises(AdapterError, msg=name) as a:
                pictures.read_picture(ref, max_bytes=1 << 20, who="x")
            with self.assertRaises(AdapterError, msg=name) as b:
                pictures.inline_picture(ref, max_bytes=1 << 20, who="x")
            self.assertEqual((a.exception.code, a.exception.message), (b.exception.code, b.exception.message), name)
            self.assertEqual(a.exception.code, E_BAD_REQUEST, name)
            self.assertTrue(a.exception.not_accepted, name)

    def test_the_size_cap_is_checked_before_the_file_is_read(self):
        big = self.tmp / "big.png"
        with open(big, "wb") as fh:
            fh.write(encoded("PNG"))
            fh.truncate((2 << 20) + 1)
        with self.assertRaises(AdapterError) as cm:
            pictures.read_picture(str(big), max_bytes=2 << 20, who="x")
        self.assertIn("over 2 MB", cm.exception.message)
        self.assertTrue(cm.exception.not_accepted)

    def test_an_https_link_is_passed_by_inline_picture_and_is_a_path_for_read_picture(self):
        self.assertEqual(pictures.inline_picture("https://example.invalid/a.png", max_bytes=1, who="x"), "https://example.invalid/a.png")
        with self.assertRaises(AdapterError):
            pictures.read_picture("https://example.invalid/a.png", max_bytes=1 << 20, who="x")


if __name__ == "__main__":
    unittest.main()
