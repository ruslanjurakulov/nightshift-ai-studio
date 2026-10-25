"""modules/capabilities/pictures.py: a local picture is read for a vendor only if its BYTES say it is one.

``read_picture`` is the file form (an upload), ``inline_picture`` the ``data:`` URI form; both must refuse the same
things, before anything is sent, and label the picture with the type its first bytes say, never its suffix.
"""

from __future__ import annotations

import base64
import io
import os
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

    def test_a_fifo_named_like_a_picture_is_refused_and_never_blocks(self):
        import threading

        fifo = self.tmp / "x.png"
        os.mkfifo(fifo)
        box = {}

        def go():
            for fn in (pictures.read_picture, pictures.inline_picture):
                try:
                    fn(str(fifo), max_bytes=1 << 20, who="x")
                except AdapterError as e:
                    box[fn.__name__] = e
        th = threading.Thread(target=go, daemon=True)
        th.start()
        th.join(10)
        self.assertFalse(th.is_alive(), "a FIFO blocked the open")
        for name, err in box.items():
            self.assertIn("not a regular file", err.message, name)
            self.assertTrue(err.not_accepted)
        self.assertEqual(len(box), 2)

    def test_a_symlink_to_a_device_is_refused_before_a_byte_is_read(self):
        link = self.tmp / "zero.png"
        os.symlink("/dev/zero", link)
        with self.assertRaises(AdapterError) as cm:
            pictures.read_picture(str(link), max_bytes=1 << 20, who="x")
        self.assertIn("not a regular file", cm.exception.message)
        self.assertTrue(cm.exception.not_accepted)

    def test_a_symlink_to_a_regular_picture_still_works(self):
        real = self.file("real.png", encoded("PNG"))
        link = self.tmp / "link.png"
        os.symlink(real, link)
        self.assertEqual(pictures.read_picture(str(link), max_bytes=1 << 20, who="x")[0], "image/png")

    def test_a_file_that_grew_after_the_size_check_is_stopped_at_the_cap(self):
        from unittest import mock

        big = self.file("grow.png", encoded("PNG") + b"\0" * (3 << 20))
        real = os.fstat
        small = lambda fd: type("S", (), {"st_mode": real(fd).st_mode, "st_size": 100})()  # noqa: E731  (the size seen at the check)
        with mock.patch("modules.capabilities.pictures.os.fstat", small):
            with self.assertRaises(AdapterError) as cm:
                pictures.read_picture(big, max_bytes=1 << 20, who="x")
        self.assertIn("over 1 MB", cm.exception.message)

    def test_the_read_is_bounded_by_the_cap_and_an_oversized_file_is_not_read_at_all(self):
        from unittest import mock

        reads = []
        real_fdopen = os.fdopen

        class Spy:
            def __init__(self, fh):
                self.fh = fh

            def read(self, n=-1):
                reads.append(n)
                return self.fh.read(n)

            def __enter__(self):
                return self

            def __exit__(self, *a):
                self.fh.close()
                return False

        with mock.patch("modules.capabilities.pictures.os.fdopen", lambda fd, mode: Spy(real_fdopen(fd, mode))):
            pictures.read_picture(self.file("ok.png", encoded("PNG")), max_bytes=1 << 20, who="x")
            self.assertEqual(reads, [(1 << 20) + 1])                         # never an unbounded read()
            reads.clear()
            big = self.tmp / "big.png"
            with open(big, "wb") as fh:
                fh.write(encoded("PNG"))
                fh.truncate((2 << 20) + 1)
            with self.assertRaises(AdapterError):
                pictures.read_picture(str(big), max_bytes=2 << 20, who="x")
            self.assertEqual(reads, [])                                      # refused on the descriptor's size, no byte read

    def test_an_https_link_is_passed_by_inline_picture_and_is_a_path_for_read_picture(self):
        self.assertEqual(pictures.inline_picture("https://example.invalid/a.png", max_bytes=1, who="x"), "https://example.invalid/a.png")
        with self.assertRaises(AdapterError):
            pictures.read_picture("https://example.invalid/a.png", max_bytes=1 << 20, who="x")


if __name__ == "__main__":
    unittest.main()
