"""modules/media_library.py — the worker side of the media library (0038).

What would break: a path built from anything but an id (traversal), a type
taken from the extension or the declared MIME instead of the content (spoof),
a playlist / concat script reaching ffmpeg's auto-detection, an oversize or
empty staged file registered, a purge deleting a path the database supplied,
or the Python allowlist drifting from the SQL one.

HEIC / HEIF (migration 0044) adds: the type read from the ISO-BMFF brand BEFORE
the generic MP4 fallthrough, AVIF refused, a .heic name or a declared HEIF type
that needs HEIF content, a header-size check before decoding, a child process
for the decode, and a rejected ticket (never a ready asset) when it fails. The
real-HEIC tests generate a file with pillow-heif and run it through the real
worker code path; they are skipped, with the reason named, only when
pillow-heif is not installed."""

import hashlib
import io
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

from modules import media_library as ml

try:  # pillow-heif makes the real HEIC files below; the worker needs it too
    import pillow_heif
    from PIL import Image, ImageCms

    pillow_heif.register_heif_opener()
    HAVE_HEIF = True
except Exception:  # pragma: no cover - depends on the machine
    HAVE_HEIF = False
NEEDS_HEIF = unittest.skipUnless(HAVE_HEIF, "pillow-heif is not installed (pip install pillow-heif): "
                                            "the real-HEIC tests need it to generate and decode a photo")

ROOT = Path(__file__).resolve().parent.parent
SQL_0038 = (ROOT / "supabase" / "migrations" / "0038_media_assets.sql").read_text()
SQL_0044 = (ROOT / "supabase" / "migrations" / "0044_media_heic.sql").read_text()
SQL = SQL_0038

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 40
MP4 = b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41" + b"\x00" * 16
M4A = b"\x00\x00\x00\x20ftypM4A \x00\x00\x02\x00M4A isom" + b"\x00" * 16
MOV = b"\x00\x00\x00\x14ftypqt  \x00\x00\x02\x00qt  " + b"\x00" * 16


def fn_sql(name):
    """The LATEST definition: 0044 redefines the type helpers, 0038 has the rest."""
    src = SQL_0044 if f"function public.{name}(" in SQL_0044 else SQL_0038
    return src.split(f"function public.{name}(", 1)[1].split("$$;", 1)[0]


class Paths(unittest.TestCase):
    def test_only_canonical_uuids_become_paths(self):
        good = str(uuid.uuid4())
        self.assertEqual(ml.canonical_id(good), good)
        for bad in ("../etc/passwd", "..", "", None, good.upper(), good + "/x", good[:-1] + "/",
                    good + "\x00", "x" * 36, f"../{good}", good.replace("-", "")):
            with self.assertRaises(ValueError, msg=repr(bad)):
                ml.canonical_id(bad)

    def test_storage_key_matches_the_sql_generated_column(self):
        self.assertIn("storage_key     text generated always as (substr(id::text, 1, 2) || '/' || id::text) stored",
                      SQL)
        aid = "3f2b8c1e-0000-4000-8000-000000000001"
        self.assertEqual(ml.storage_key(aid), "3f/" + aid)

    def test_files_stay_inside_the_media_root(self):
        root = Path("/srv/media")
        aid = str(uuid.uuid4())
        for variant in ("original", "thumb", "proxy", "display"):
            p = ml.asset_file(root, aid, variant)
            self.assertEqual(p.parent, root / aid[:2] / aid)
            self.assertEqual(os.path.commonpath([str(root), os.path.realpath(p)]), str(root))
        with self.assertRaises(ValueError):
            ml.asset_file(root, aid, "../../etc/passwd")
        with self.assertRaises(ValueError):
            ml.asset_file(root, "../../../etc", "original")

    def test_staged_name_is_the_ticket_id_only(self):
        tid = str(uuid.uuid4())
        self.assertEqual(ml.staged_path(Path("/s"), tid), Path(f"/s/{tid}.upload"))
        for bad in ("../../x", "a/b", "evil.mp4", tid + "\x00.mp4"):
            with self.assertRaises(ValueError):
                ml.staged_path(Path("/s"), bad)


class Allowlist(unittest.TestCase):
    def test_python_allowlist_equals_the_sql_one(self):
        body = fn_sql("media_mime_kind")
        sql_kinds = dict(re.findall(r"when '([^']+)' then '([^']+)'", body))
        self.assertEqual(sql_kinds, ml.ALLOWED_MIME)
        ext_body = fn_sql("media_ext_mime")
        sql_ext = dict(re.findall(r"when '([^']+)' then '([^']+)'", ext_body))
        self.assertEqual(sql_ext, ml.EXT_MIME)

    def test_nothing_executable_by_a_browser_is_allowed(self):
        for mime in ("image/svg+xml", "text/html", "application/pdf", "application/zip",
                     "application/octet-stream", "text/javascript", "application/x-mpegurl"):
            self.assertNotIn(mime, ml.ALLOWED_MIME)

    def test_every_sniffable_media_type_has_a_forced_demuxer(self):
        for mime, kind in ml.ALLOWED_MIME.items():
            # HEIF is decoded by pillow-heif, never opened by ffmpeg: no demuxer on purpose.
            if kind != "caption" and mime not in ml.HEIF_MIMES:
                self.assertIn(mime, ml.DEMUXER, mime)
        for mime in ml.HEIF_MIMES:
            self.assertNotIn(mime, ml.DEMUXER)


class Sniff(unittest.TestCase):
    def test_media_by_content(self):
        cases = {
            PNG: "image/png", JPEG: "image/jpeg", b"GIF89a" + b"\x00" * 10: "image/gif",
            b"RIFF\x00\x00\x00\x00WEBPVP8 ": "image/webp", b"RIFF\x00\x00\x00\x00WAVEfmt ": "audio/wav",
            MP4: "video/mp4", M4A: "audio/mp4", MOV: "video/quicktime",
            b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\x82\x84webm": "video/webm",
            b"\x1a\x45\xdf\xa3\xa3\x42\x86\x81\x01\x42\x82\x88matroska": "video/x-matroska",
            b"OggS\x00\x02": "audio/ogg", b"fLaC\x00\x00": "audio/flac", b"ID3\x04\x00\x00": "audio/mpeg",
            b"\xff\xfb\x90\x64": "audio/mpeg", b"\xff\xf1\x50\x80": "audio/aac",
            b"WEBVTT\n\n00:00.000 --> 00:01.000\nhi\n": "text/vtt",
            "﻿WEBVTT\n".encode(): "text/vtt",
            b"1\n00:00:00,000 --> 00:00:01,000\nhello\n": "application/x-subrip",
        }
        for head, want in cases.items():
            self.assertEqual(ml.sniff(head), want, head[:12])

    def test_non_media_is_refused_whatever_it_is_called(self):
        for head in (
            b"<!DOCTYPE html><html><script>alert(1)</script>",
            b"<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>",
            b"\x7fELF\x02\x01\x01\x00", b"MZ\x90\x00\x03\x00", b"%PDF-1.7\n", b"PK\x03\x04\x14\x00",
            b"ffconcat version 1.0\nfile '/etc/passwd'\n",
            b"#EXTM3U\n#EXT-X-VERSION:3\nhttp://169.254.169.254/latest\n",
            b"RIFF\x00\x00\x00\x00AVI LIST", b"\x1a\x45\xdf\xa3\x00\x00\x00\x00",
            b"WEBVTTX\n", b"just some text\n", b"", b"\x00\x01",
        ):
            self.assertIsNone(ml.sniff(head), head[:16])


class Declared(unittest.TestCase):
    def test_content_kind_must_match_declared_and_extension(self):
        ml.check_declared("image/png", "image/png", "photo.png")
        ml.check_declared("image/png", "image/jpeg", "photo.jpg")  # same kind: fine
        ml.check_declared("image/png", "image/png", "no-extension")
        ml.check_declared("audio/mp4", "audio/mp4", "voice.m4a")
        with self.assertRaises(ml.IngestReject) as e:
            ml.check_declared("image/png", "video/mp4", "clip.mp4")
        self.assertEqual(e.exception.reason, "type_mismatch")
        # An .m4a written with a generic MP4 brand is still accepted as audio;
        # ffprobe decides from its streams.
        ml.check_declared("video/mp4", "audio/mp4", "voice.m4a")
        with self.assertRaises(ml.IngestReject):
            ml.check_declared("video/mp4", "image/png", "x.png")
        for name in ("photo.mp4", "photo.exe", "photo.svg", "photo.png.html"):
            with self.assertRaises(ml.IngestReject) as e:
                ml.check_declared("image/png", "image/png", name)
            self.assertEqual(e.exception.reason, "extension_mismatch", name)


def _probe(streams, duration=None):
    fmt = {} if duration is None else {"duration": str(duration)}
    return {"streams": streams, "format": fmt}


class InterpretProbe(unittest.TestCase):
    def test_mp4_with_sound_only_is_audio(self):
        p = ml.interpret_probe("video/mp4", _probe([{"codec_type": "audio"}], 3.2))
        self.assertEqual((p.kind, p.mime, p.duration), ("audio", "audio/mp4", 3.2))

    def test_audio_carrying_video_is_refused(self):
        with self.assertRaises(ml.IngestReject) as e:
            ml.interpret_probe("audio/ogg", _probe([{"codec_type": "video", "width": 9, "height": 9},
                                                     {"codec_type": "audio"}], 2))
        self.assertEqual(e.exception.reason, "type_mismatch")

    def test_cover_art_does_not_make_an_mp3_a_video(self):
        p = ml.interpret_probe("audio/mpeg", _probe([
            {"codec_type": "audio"},
            {"codec_type": "video", "width": 500, "height": 500, "disposition": {"attached_pic": 1}}], 60))
        self.assertEqual(p.kind, "audio")

    def test_no_streams_or_no_length_is_not_media(self):
        for sniffed, data in (("image/png", _probe([])), ("video/mp4", _probe([{"codec_type": "video",
                                                                                  "width": 10, "height": 10}])),
                              ("audio/wav", _probe([], 1.0))):
            with self.assertRaises(ml.IngestReject):
                ml.interpret_probe(sniffed, data)

    def test_absurd_dimensions_refused(self):
        with self.assertRaises(ml.IngestReject) as e:
            ml.interpret_probe("image/png", _probe([{"codec_type": "video", "width": 20000, "height": 10}]))
        self.assertEqual(e.exception.reason, "too_large_dimensions")

    def test_probe_is_forced_to_the_sniffed_demuxer_and_local_files(self):
        argv = ml.probe_command("ffprobe", Path("/s/x.upload"), "video/mp4")
        self.assertEqual(argv[argv.index("-f") + 1], "mov")
        self.assertEqual(argv[argv.index("-protocol_whitelist") + 1], "file")
        for cmd in (ml.thumbnail_command("ffmpeg", Path("/a"), Path("/b"), "video/webm", 3.0),
                    ml.proxy_command("ffmpeg", Path("/a"), Path("/b"), "video/webm")):
            self.assertEqual(cmd[cmd.index("-protocol_whitelist") + 1], "file")
            self.assertEqual(cmd[cmd.index("-f") + 1], "matroska")


class FakeStore:
    def __init__(self):
        self.registered = []
        self.rejected = []
        self.purged = []
        self.candidates = []

    def heartbeat(self, *_a):
        pass

    def register(self, **kw):
        self.registered.append(kw)
        return {"id": kw["asset_id"], "storage_key": ml.storage_key(kw["asset_id"]), "reused": False}

    def reject(self, tid, worker, reason, detail):
        self.rejected.append((tid, reason))

    def purge_candidates(self, limit=50):
        return list(self.candidates)

    def mark_purged(self, aid):
        self.purged.append(aid)


class IngestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.staging = self.tmp / "staging"
        self.media = self.tmp / "media"
        self.staging.mkdir()
        self.media.mkdir()
        self.store = FakeStore()
        self.tools = ml.find_tools() or ml.Tools("ffprobe", "ffmpeg")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def ticket(self, data: bytes, *, mime: str, name: str, declared=None):
        tid = str(uuid.uuid4())
        ml.staged_path(self.staging, tid).write_bytes(data)
        return {"id": tid, "declared_mime": mime, "original_name": name,
                "declared_bytes": len(data) if declared is None else declared}

    def run_ticket(self, t, **kw):
        return ml.process_ticket(t, store=self.store, staging_root=self.staging, media_root=self.media,
                                 worker_id="w", tools=self.tools, **kw)

    def media_files(self):
        return [p for p in self.media.rglob("*") if p.is_file()]

    def assert_rejected(self, t, reason):
        self.assertEqual(self.run_ticket(t), "rejected")
        self.assertEqual(self.store.rejected[-1], (t["id"], reason))
        self.assertEqual(self.store.registered, [])
        self.assertEqual(self.media_files(), [])
        self.assertFalse(ml.staged_path(self.staging, t["id"]).exists(), "staged file must be removed")


class Ingest(IngestCase):
    def test_html_renamed_to_mp4_is_rejected_as_unsupported(self):
        t = self.ticket(b"<html><script>alert(document.cookie)</script></html>", mime="video/mp4", name="x.mp4")
        self.assert_rejected(t, "unsupported_type")

    def test_concat_script_never_reaches_ffprobe(self):
        called = []

        def prober(*a):
            called.append(a)
            raise AssertionError("ffprobe must not see this")

        t = self.ticket(b"ffconcat version 1.0\nfile '/etc/passwd'\n", mime="video/mp4", name="x.mp4")
        self.assertEqual(self.run_ticket(t, prober=prober), "rejected")
        self.assertEqual(self.store.rejected[-1][1], "unsupported_type")
        self.assertEqual(called, [])

    def test_png_declared_as_video_is_a_type_mismatch(self):
        t = self.ticket(PNG, mime="video/mp4", name="clip.mp4")
        self.assert_rejected(t, "type_mismatch")

    def test_png_named_exe_is_an_extension_mismatch(self):
        t = self.ticket(PNG, mime="image/png", name="payload.exe")
        self.assert_rejected(t, "extension_mismatch")

    def test_file_larger_than_declared_is_rejected(self):
        t = self.ticket(PNG, mime="image/png", name="a.png", declared=len(PNG) - 1)
        self.assert_rejected(t, "too_large")

    def test_empty_and_missing_files_are_rejected(self):
        t = self.ticket(b"", mime="image/png", name="a.png", declared=10)
        self.assert_rejected(t, "empty")
        t = {"id": str(uuid.uuid4()), "declared_mime": "image/png", "original_name": "a.png", "declared_bytes": 9}
        self.assert_rejected(t, "file_missing")

    def test_symlinked_staged_file_is_not_followed(self):
        secret = self.tmp / "secret.png"
        secret.write_bytes(PNG)
        tid = str(uuid.uuid4())
        ml.staged_path(self.staging, tid).symlink_to(secret)
        t = {"id": tid, "declared_mime": "image/png", "original_name": "a.png", "declared_bytes": 999}
        self.assertEqual(self.run_ticket(t), "rejected")
        self.assertEqual(self.store.rejected[-1][1], "file_missing")
        self.assertTrue(secret.exists())

    def test_ticket_id_with_traversal_is_skipped(self):
        t = {"id": "../../etc/passwd", "declared_mime": "image/png", "original_name": "a.png",
             "declared_bytes": 9}
        self.assertEqual(self.run_ticket(t), "skipped")
        self.assertEqual(self.store.rejected, [])

    def test_caption_is_checked_as_text(self):
        good = b"WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n"
        t = self.ticket(good, mime="text/vtt", name="subs.vtt")
        self.assertEqual(self.run_ticket(t), "ingested")
        reg = self.store.registered[-1]
        self.assertEqual((reg["kind"], reg["mime"], reg["variants"]), ("caption", "text/vtt", []))
        self.assertEqual(reg["sha256"], hashlib.sha256(good).hexdigest())

    def test_caption_without_cues_is_rejected(self):
        t = self.ticket(b"WEBVTT\n\nnothing here\n", mime="text/vtt", name="subs.vtt")
        self.assert_rejected(t, "not_media")

    def _gen(self, name, *args):
        out = self.tmp / name
        subprocess.run(["ffmpeg", "-v", "error", "-y", *args, str(out)], check=True, timeout=120)
        return out.read_bytes()

    @unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe not installed")
    def test_real_video_is_stored_under_its_id_with_thumb_and_proxy(self):
        data = self._gen("v.mp4", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-f", "lavfi",
                         "-i", "sine=frequency=440", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                         "-c:a", "aac", "-shortest")
        t = self.ticket(data, mime="video/mp4", name="../../etc/clip.mp4")
        self.assertEqual(self.run_ticket(t), "ingested")
        reg = self.store.registered[-1]
        aid = reg["asset_id"]
        folder = self.media / aid[:2] / aid
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ["original", "proxy.mp4", "thumb.jpg"])
        self.assertEqual((folder / "original").read_bytes(), data)
        self.assertEqual(reg["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual((reg["kind"], reg["mime"], reg["width"], reg["height"]), ("video", "video/mp4", 640, 360))
        self.assertEqual(reg["variants"], ["thumb", "proxy"])
        self.assertEqual(reg["derived_bytes"],
                         (folder / "thumb.jpg").stat().st_size + (folder / "proxy.mp4").stat().st_size)
        self.assertEqual(reg["upload_id"], t["id"])
        self.assertIsNone(reg["org"], "the org comes from the ticket in SQL, never from the worker")
        self.assertFalse(ml.staged_path(self.staging, t["id"]).exists())
        # Nothing named after the upload anywhere on disk.
        self.assertFalse([p for p in self.tmp.rglob("*clip*")])

    @unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe not installed")
    def test_real_image_and_audio(self):
        png = self._gen("p.png", "-f", "lavfi", "-i", "testsrc=size=64x48", "-frames:v", "1")
        t = self.ticket(png, mime="image/png", name="p.png")
        self.assertEqual(self.run_ticket(t), "ingested")
        self.assertEqual(self.store.registered[-1]["variants"], ["thumb"])
        wav = self._gen("a.wav", "-f", "lavfi", "-i", "sine", "-t", "1")
        t = self.ticket(wav, mime="audio/wav", name="a.wav")
        self.assertEqual(self.run_ticket(t), "ingested")
        reg = self.store.registered[-1]
        self.assertEqual((reg["kind"], reg["variants"], reg["derived_bytes"]), ("audio", [], 0))
        self.assertAlmostEqual(reg["duration_s"], 1.0, places=1)

    @unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe not installed")
    def test_mp4_header_with_garbage_is_not_media(self):
        t = self.ticket(MP4 + os.urandom(4096), mime="video/mp4", name="x.mp4")
        self.assertEqual(self.run_ticket(t), "rejected")
        self.assertIn(self.store.rejected[-1][1], ("not_media", "no_video_stream", "decode_failed"))
        self.assertEqual(self.media_files(), [])


# ── HEIC / HEIF (0044) ───────────────────────────────────────────────────────


def box(kind: bytes, payload: bytes = b"") -> bytes:
    return struct.pack(">I", 8 + len(payload)) + kind + payload


def ftyp(major: bytes, *compat: bytes, minor: bytes = b"\x00\x00\x00\x00") -> bytes:
    return box(b"ftyp", major + minor + b"".join(compat))


def jpeg_markers(data: bytes) -> list:
    """The marker bytes of a JPEG up to the start of the scan (APPn, DQT, ...)."""
    assert data[:2] == b"\xff\xd8"
    out, pos = [], 2
    while pos + 4 <= len(data):
        assert data[pos] == 0xFF, "not at a marker"
        marker = data[pos + 1]
        out.append(marker)
        if marker == 0xDA:  # start of scan
            break
        pos += 2 + struct.unpack(">H", data[pos + 2:pos + 4])[0]
    return out


def heic_bytes(size=(400, 200), *, orientation=None, gps=False, icc=False, fmt="HEIF", quality=80) -> bytes:
    """A real photo: a red field with a blue block at the top-left, written by
    pillow-heif. orientation / gps / icc make it look like an iPhone's."""
    im = Image.new("RGB", size, (200, 30, 30))
    im.paste((0, 0, 255), (0, 0, size[0] // 4, size[1] // 4))
    kw = {}
    if orientation or gps:
        ex = Image.Exif()
        if orientation:
            ex[274] = orientation
        ex[0x010F] = "AcmePhone"
        if gps:
            g = ex.get_ifd(0x8825)
            g[1], g[2], g[3], g[4] = "N", (41.0, 18.0, 30.0), "E", (69.0, 13.0, 40.0)
        kw["exif"] = ex.tobytes()
    if icc:
        kw["icc_profile"] = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    buf = io.BytesIO()
    im.save(buf, format=fmt, quality=quality, **kw)
    return buf.getvalue()


def png_bytes(size=(32, 24)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (1, 2, 3)).save(buf, format="PNG")
    return buf.getvalue()


def with_ispe(data: bytes, width: int, height: int) -> bytes:
    """The same file claiming a different picture size in its header (a
    decompression-bomb shaped file that is a few kB on disk)."""
    i = data.find(b"ispe")
    assert i > 0
    out = bytearray(data)
    out[i + 8:i + 16] = struct.pack(">II", width, height)
    return bytes(out)


class HeifSniff(unittest.TestCase):
    def test_heic_family_by_brand_before_the_mp4_fallthrough(self):
        for major in (b"heic", b"heix", b"hevc", b"hevx"):
            self.assertEqual(ml.sniff(ftyp(major, b"mif1", major) + b"\x00" * 64), "image/heic", major)
        # The iPhone's own layout: heic major, mif1 / heic / miaf compatible.
        self.assertEqual(ml.sniff(ftyp(b"heic", b"mif1", b"heic", b"miaf")), "image/heic")
        # A generic HEIF brand names HEVC as compatible: HEIF.
        self.assertEqual(ml.sniff(ftyp(b"mif1", b"mif1", b"heic")), "image/heif")
        self.assertEqual(ml.sniff(ftyp(b"msf1", b"msf1", b"hevc")), "image/heif")
        # Before this change a HEIC read as video/mp4.
        self.assertNotEqual(ml.sniff(ftyp(b"heic", b"mif1")), "video/mp4")

    def test_avif_and_codec_less_heif_are_refused(self):
        self.assertIsNone(ml.sniff(ftyp(b"avif", b"avif", b"mif1", b"miaf")))
        self.assertIsNone(ml.sniff(ftyp(b"avis", b"avis", b"msf1")))
        # AVIF listed as a compatible brand of an otherwise HEIC-looking file.
        self.assertIsNone(ml.sniff(ftyp(b"heic", b"mif1", b"avif")))
        # mif1 alone does not say HEVC (AVIF without its brand, JPEG, ...).
        self.assertIsNone(ml.sniff(ftyp(b"mif1", b"mif1", b"miaf")))
        self.assertIsNone(ml.sniff(ftyp(b"mif1")))

    def test_video_and_audio_brands_are_unchanged(self):
        self.assertEqual(ml.sniff(ftyp(b"isom", b"isom", b"iso2", b"avc1", b"mp41")), "video/mp4")
        self.assertEqual(ml.sniff(ftyp(b"mp42", b"isom")), "video/mp4")
        self.assertEqual(ml.sniff(ftyp(b"qt  ", b"qt  ")), "video/quicktime")
        self.assertEqual(ml.sniff(ftyp(b"M4A ", b"M4A ", b"isom")), "audio/mp4")
        # A video that merely lists heic as a compatible brand is still a video.
        self.assertEqual(ml.sniff(ftyp(b"isom", b"isom", b"heic")), "video/mp4")

    def test_ftyp_parsing_is_bounded(self):
        # A box size larger than the head, or a lying small one, never reads past it.
        self.assertEqual(ml.sniff(b"\xff\xff\xff\xffftypheic" + b"\x00" * 4 + b"mif1heic"), "image/heic")
        self.assertEqual(ml.sniff(b"\x00\x00\x00\x08ftypheic" + b"\x00" * 8), "video/mp4")  # size < 16: no HEIF claim


class HeifContainer(unittest.TestCase):
    def check(self, data: bytes) -> bool:
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "x"
            f.write_bytes(data)
            return ml.heif_has_image_item(f)

    def meta(self, handler=b"pict", pitm=True) -> bytes:
        kids = box(b"hdlr", b"\x00" * 8 + handler + b"\x00" * 12) + (box(b"pitm", b"\x00" * 6) if pitm else b"")
        return box(b"meta", b"\x00\x00\x00\x00" + kids)

    def test_needs_a_picture_item(self):
        head = ftyp(b"heic", b"mif1", b"heic")
        self.assertTrue(self.check(head + self.meta() + box(b"mdat", b"\x00" * 100)))
        self.assertFalse(self.check(head))  # a brand alone is not a picture
        self.assertFalse(self.check(head + self.meta(b"vide")))
        self.assertFalse(self.check(head + self.meta(pitm=False)))
        self.assertFalse(self.check(head + box(b"mdat", b"\x00" * 100)))

    def test_garbage_and_lying_boxes_are_false_not_errors(self):
        head = ftyp(b"heic", b"mif1")
        for tail in (b"", b"\x00", os.urandom(300), b"\xff\xff\xff\xffmeta" + b"\x00" * 40,
                     b"\x00\x00\x00\x04meta", struct.pack(">I", 0) + b"free"):
            self.assertFalse(self.check(head + tail), tail[:8])
        # A huge meta is not read into memory.
        self.assertFalse(self.check(head + struct.pack(">I", ml.HEIF_META_MAX_BYTES + 100) + b"meta"))

    def test_box_walk_is_capped(self):
        head = ftyp(b"heic", b"mif1")
        self.assertFalse(self.check(head + box(b"free") * 200 + self.meta()))


class HeifDeclared(unittest.TestCase):
    def test_a_heic_name_or_type_requires_heif_content(self):
        for sniffed, declared, name, reason in (
            ("image/png", "image/png", "photo.heic", "extension_mismatch"),
            ("image/jpeg", "image/jpeg", "IMG_0001.HEIC", "extension_mismatch"),
            ("image/jpeg", "image/heic", "photo.jpg", "type_mismatch"),
            ("image/png", "image/heif", "photo", "type_mismatch"),
            ("image/webp", "image/png", "x.heif", "extension_mismatch"),
        ):
            with self.assertRaises(ml.IngestReject, msg=name) as e:
                ml.check_declared(sniffed, declared, name)
            self.assertEqual(e.exception.reason, reason, name)
        # a video or audio is still refused by the kind rule, as before
        with self.assertRaises(ml.IngestReject):
            ml.check_declared("video/mp4", "image/heic", "clip.heic")

    def test_heif_content_is_accepted_under_any_image_name(self):
        ml.check_declared("image/heic", "image/heic", "IMG_0001.HEIC")
        ml.check_declared("image/heic", "image/heif", "photo.heif")
        ml.check_declared("image/heif", "image/heic", "photo.heic")
        ml.check_declared("image/heic", "image/jpeg", "photo.jpg")  # converted name: the content decides
        ml.check_declared("image/heic", "image/heic", "no-extension")
        for name in ("clip.mp4", "voice.m4a", "photo.exe", "photo.svg"):
            with self.assertRaises(ml.IngestReject, msg=name):
                ml.check_declared("image/heic", "image/heic", name)
        with self.assertRaises(ml.IngestReject):
            ml.check_declared("image/heic", "video/mp4", "photo.heic")


@NEEDS_HEIF
class HeicIngest(IngestCase):
    """Real HEIC files, decoded by the real worker code path (a child process)."""

    def stored(self, reg):
        return self.media / reg["asset_id"][:2] / reg["asset_id"]

    def test_an_iphone_style_photo_is_stored_untouched_with_thumb_and_display(self):
        data = heic_bytes((400, 200), orientation=6, gps=True, icc=True)
        # The input really carries what must not leak: EXIF with GPS, and a profile.
        probe = Image.open(io.BytesIO(data))
        self.assertTrue(probe.info.get("exif"))
        self.assertTrue(probe.getexif().get_ifd(0x8825))
        t = self.ticket(data, mime="image/heic", name="../../DCIM/IMG_0001.HEIC")
        self.assertEqual(self.run_ticket(t), "ingested")
        reg = self.store.registered[-1]
        folder = self.stored(reg)
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ["display.jpg", "original", "thumb.jpg"])
        # The original is byte-copied; its hash is the file's.
        self.assertEqual((folder / "original").read_bytes(), data)
        self.assertEqual(reg["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual((reg["kind"], reg["mime"]), ("image", "image/heic"))
        self.assertEqual(reg["variants"], ["thumb", "display"])
        self.assertEqual(reg["derived_bytes"], (folder / "thumb.jpg").stat().st_size
                         + (folder / "display.jpg").stat().st_size)
        self.assertGreater(reg["derived_bytes"], 0)
        # Orientation 6 is applied exactly once: 400x200 stored -> 200x400 shown.
        self.assertEqual((reg["width"], reg["height"]), (200, 400))
        for name, longest in (("display.jpg", 400), ("thumb.jpg", 400)):
            raw = (folder / name).read_bytes()
            im = Image.open(io.BytesIO(raw))
            self.assertEqual((im.format, im.mode, im.size), ("JPEG", "RGB", (200, 400)), name)
            self.assertLessEqual(max(im.size), longest)
            # No EXIF, GPS, XMP or colour profile: no APPn segment except JFIF.
            self.assertEqual([m for m in jpeg_markers(raw) if 0xE0 <= m <= 0xEF and m != 0xE0], [], name)
            self.assertEqual(dict(im.getexif()), {}, name)
            self.assertNotIn(b"Exif", raw)
            self.assertNotIn(b"ICC_PROFILE", raw)
            self.assertNotIn(b"ns.adobe.com", raw)
            # The blue block (top-left of the stored picture) is at the top RIGHT after one
            # clockwise turn, and the red field elsewhere: rotated once, not twice.
            r, g, b = im.getpixel((190, 8))
            self.assertGreater(b, 150, name)
            self.assertLess(r, 100, name)
            r, g, b = im.getpixel((8, 8))
            self.assertGreater(r, 150, name)
        self.assertFalse(ml.staged_path(self.staging, t["id"]).exists())
        self.assertEqual(reg["upload_id"], t["id"])
        self.assertIsNone(reg["org"])

    def test_display_is_at_most_2048_and_thumb_at_most_480(self):
        data = heic_bytes((3000, 1500), quality=40)
        t = self.ticket(data, mime="image/heic", name="big.heic")
        self.assertEqual(self.run_ticket(t), "ingested")
        reg = self.store.registered[-1]
        self.assertEqual((reg["width"], reg["height"]), (3000, 1500))  # the original's size
        folder = self.stored(reg)
        self.assertEqual(Image.open(folder / "display.jpg").size, (2048, 1024))
        self.assertEqual(Image.open(folder / "thumb.jpg").size, (480, 240))

    def test_heic_content_named_jpg_is_stored_as_heic(self):
        data = heic_bytes((64, 48))
        t = self.ticket(data, mime="image/jpeg", name="photo.jpg")
        self.assertEqual(self.run_ticket(t), "ingested")
        reg = self.store.registered[-1]
        self.assertEqual((reg["mime"], reg["variants"]), ("image/heic", ["thumb", "display"]))
        self.assertEqual((self.stored(reg) / "original").read_bytes(), data)

    def test_a_heif_brand_file_is_typed_image_heif(self):
        data = bytearray(heic_bytes((64, 48)))
        # Re-brand as a generic HEIF file that lists HEVC as compatible (what some
        # cameras write): the major brand mif1, the compatible list unchanged.
        self.assertEqual(data[4:12], b"ftypheic")
        data[8:12] = b"mif1"
        t = self.ticket(bytes(data), mime="image/heif", name="photo.heif")
        self.assertEqual(self.run_ticket(t), "ingested")
        self.assertEqual(self.store.registered[-1]["mime"], "image/heif")

    def test_a_tiled_grid_photo_like_an_iphones_is_decoded_whole(self):
        # iPhones write big pictures as a grid of tiles; the decode must hand back the whole picture.
        before = pillow_heif.options.GRID_TILE_SIZE
        pillow_heif.options.GRID_TILE_SIZE = 512
        try:
            buf = io.BytesIO()
            Image.linear_gradient("L").resize((2000, 1500)).convert("RGB").save(buf, format="HEIF", quality=60)
        finally:
            pillow_heif.options.GRID_TILE_SIZE = before
        data = buf.getvalue()
        self.assertIn(b"grid", data)
        t = self.ticket(data, mime="image/heic", name="grid.heic")
        self.assertEqual(self.run_ticket(t), "ingested")
        reg = self.store.registered[-1]
        self.assertEqual((reg["width"], reg["height"]), (2000, 1500))
        folder = self.stored(reg)
        self.assertEqual(Image.open(folder / "display.jpg").size, (2000, 1500))
        # the gradient runs top to bottom: the tiles are in the right places
        im = Image.open(folder / "display.jpg").convert("L")
        self.assertLess(im.getpixel((1000, 20)), im.getpixel((1000, 1480)))
        self.assertLess(im.getpixel((10, 700)), im.getpixel((10, 1400)))

    def test_png_and_jpeg_renamed_heic_are_rejected(self):
        self.assert_rejected(self.ticket(png_bytes(), mime="image/heic", name="photo.heic"), "type_mismatch")
        self.assert_rejected(self.ticket(png_bytes(), mime="image/png", name="photo.heic"), "extension_mismatch")
        buf = io.BytesIO()
        Image.new("RGB", (8, 8)).save(buf, format="JPEG")
        self.assert_rejected(self.ticket(buf.getvalue(), mime="image/jpeg", name="IMG_1.HEIC"),
                             "extension_mismatch")

    def test_avif_is_rejected_whatever_it_is_called(self):
        try:
            avif = heic_bytes((64, 48), fmt="AVIF")
        except Exception as e:  # pragma: no cover - an AV1 encoder is not in every build
            self.skipTest(f"this pillow-heif cannot write AVIF ({type(e).__name__})")
        self.assertIn(b"avif", avif[:32])
        for name, mime in (("a.avif", "image/avif"), ("a.heic", "image/heic"), ("a.jpg", "image/jpeg")):
            self.assert_rejected(self.ticket(avif, mime=mime, name=name), "unsupported_type")

    def test_oversized_pixel_dimensions_are_refused_before_decoding(self):
        data = heic_bytes((400, 200))
        for w, h in ((20000, 100), (100, 20000), (11000, 10000), (100000, 100000)):
            t = self.ticket(with_ispe(data, w, h), mime="image/heic", name="bomb.heic")
            self.assert_rejected(t, "too_large_dimensions")

    def test_the_decoder_reads_the_size_first(self):
        data = with_ispe(heic_bytes((400, 200)), 11000, 10000)
        f = self.tmp / "bomb"
        f.write_bytes(data)
        out = self.tmp / "o"
        out.mkdir()
        t0 = time.monotonic()
        with self.assertRaises(ml.IngestReject) as e:
            ml.decode_heic(f, out, lambda: None)
        self.assertEqual(e.exception.reason, "too_large_dimensions")
        self.assertEqual(list(out.iterdir()), [])
        self.assertLess(time.monotonic() - t0, 30)

    def test_corrupt_pictures_are_rejected_never_stored(self):
        data = heic_bytes((400, 200), quality=90)
        cut = data[: len(data) - max(40, len(data) // 3)]  # the end of the picture data is missing
        self.assertEqual(ml.sniff(cut[:4096]), "image/heic")
        self.assertEqual(self.run_ticket(self.ticket(cut, mime="image/heic", name="cut.heic")), "rejected")
        self.assertIn(self.store.rejected[-1][1], ("decode_failed", "not_media"))
        # A good brand and nothing behind it.
        t = self.ticket(ftyp(b"heic", b"mif1", b"heic") + os.urandom(2000), mime="image/heic", name="junk.heic")
        self.assert_rejected(t, "not_media")
        # Right container, wrong bytes where the picture is.
        mdat = data.rfind(b"mdat")
        scrambled = data[: mdat + 8] + os.urandom(len(data) - mdat - 8)
        self.assertEqual(self.run_ticket(self.ticket(scrambled, mime="image/heic", name="x.heic")), "rejected")
        self.assertEqual(self.store.registered, [])
        self.assertEqual(self.media_files(), [])

    def test_a_decode_that_takes_too_long_is_killed_and_rejected(self):
        t = self.ticket(heic_bytes((64, 48)), mime="image/heic", name="slow.heic")
        # A limit no decode can meet: the first 1 ms wait ends before a child
        # Python process can even start, so the timeout path is certain on any
        # machine (a 50 ms limit lost the race on a fast CI runner).
        slow = lambda *a: ml.decode_heic(*a, timeout_s=0.0, beat_s=0.001)  # noqa: E731
        self.assertEqual(self.run_ticket(t, decoder=slow), "rejected")
        self.assertEqual(self.store.rejected[-1], (t["id"], "timeout"))
        self.assertEqual(self.media_files(), [])

    def test_the_child_has_a_memory_limit(self):
        t = self.ticket(heic_bytes((2000, 1500)), mime="image/heic", name="x.heic")
        tiny = lambda *a: ml.decode_heic(*a, mem_bytes=64 * 1024 * 1024)  # noqa: E731
        self.assertEqual(self.run_ticket(t, decoder=tiny), "rejected")
        self.assertEqual(self.store.rejected[-1], (t["id"], "decode_failed"))
        self.assertEqual(self.media_files(), [])
        # ... and the same file decodes under the real limit.
        t = self.ticket(heic_bytes((2000, 1500)), mime="image/heic", name="x.heic")
        self.assertEqual(self.run_ticket(t), "ingested")

    def test_a_big_picture_hits_the_limit_while_decoding(self):
        # The decoder loads fine under 300 MB; the 24 megapixels do not fit.
        im = Image.linear_gradient("L").resize((6000, 4000)).convert("RGB")
        buf = io.BytesIO()
        im.save(buf, format="HEIF", quality=50)
        f = self.tmp / "big.heic"
        f.write_bytes(buf.getvalue())
        out = self.tmp / "o"
        out.mkdir()
        with self.assertRaises(ml.IngestReject) as e:
            ml.decode_heic(f, out, lambda: None, mem_bytes=300 * 1024 * 1024)
        self.assertEqual(e.exception.reason, "decode_failed")
        self.assertIn("memory", e.exception.detail)
        self.assertEqual(list(out.iterdir()), [])
        # The same picture is fine under the real limit.
        self.assertEqual(ml.decode_heic(f, out, lambda: None), (6000, 4000))

    def test_the_child_gets_an_argv_and_no_secrets(self):
        os.environ["SUPABASE_SERVICE_KEY"] = "do-not-leak"
        self.addCleanup(os.environ.pop, "SUPABASE_SERVICE_KEY", None)
        seen = {}
        real = subprocess.Popen

        def spy(argv, **kw):
            seen.update(argv=argv, kw=kw)
            return real(argv, **kw)

        t = self.ticket(heic_bytes((64, 48)), mime="image/heic", name="x.heic")
        with mock.patch.object(ml.subprocess, "Popen", spy):
            self.assertEqual(self.run_ticket(t), "ingested")
        self.assertIsInstance(seen["argv"], list)
        self.assertFalse(seen["kw"].get("shell"))
        self.assertNotIn("SUPABASE_SERVICE_KEY", seen["kw"]["env"])
        self.assertNotIn("do-not-leak", "".join(map(str, seen["kw"]["env"].values())))
        self.assertTrue(seen["kw"]["start_new_session"])

    def test_decode_is_refused_when_the_decoder_is_not_installed(self):
        t = self.ticket(heic_bytes((64, 48)), mime="image/heic", name="x.heic")
        with mock.patch.object(ml, "heic_available", lambda: False):
            self.assertEqual(self.run_ticket(t), "rejected")
        self.assertEqual(self.store.rejected[-1], (t["id"], "heic_unavailable"))
        self.assertEqual(self.store.registered, [])
        self.assertEqual(self.media_files(), [])
        # Nothing else is affected: a caption still ingests.
        cap = self.ticket(b"WEBVTT\n\n00:00.000 --> 00:01.000\nhi\n", mime="text/vtt", name="c.vtt")
        with mock.patch.object(ml, "heic_available", lambda: False):
            self.assertEqual(self.run_ticket(cap), "ingested")

    def test_a_missing_decoder_module_in_the_child_is_reported_as_unavailable(self):
        f = self.tmp / "p.heic"
        f.write_bytes(heic_bytes((64, 48)))
        out = self.tmp / "o"
        out.mkdir()
        # -S drops site-packages, so pillow_heif cannot be found: the child's own
        # answer for "not installed" (exit 4, reason unavailable), nothing written.
        child = Path(ml.__file__).with_name("heic_decode.py")
        proc = subprocess.run([sys.executable, "-S", str(child), str(f), str(out), str(2 ** 31), "60"],
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 4, proc.stdout + proc.stderr)
        self.assertIn('"reason":"unavailable"', proc.stdout)
        self.assertEqual(list(out.iterdir()), [])

    def test_heic_is_not_passed_to_ffprobe_or_ffmpeg(self):
        def boom(*a, **k):
            raise AssertionError("ffprobe / ffmpeg must not see a HEIC")

        t = self.ticket(heic_bytes((64, 48)), mime="image/heic", name="x.heic")
        self.assertEqual(self.run_ticket(t, prober=boom, runner=boom), "ingested")



class RegisterFailure(unittest.TestCase):
    def test_a_database_hiccup_leaves_the_ticket_for_a_retry(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            staging, media = tmp / "s", tmp / "m"
            staging.mkdir()
            media.mkdir()
            store = FakeStore()

            def down(**_kw):
                raise RuntimeError("register_asset: HTTP 503")

            store.register = down
            tid = str(uuid.uuid4())
            data = b"WEBVTT\n\n00:00.000 --> 00:01.000\nhi\n"
            ml.staged_path(staging, tid).write_bytes(data)
            t = {"id": tid, "declared_mime": "text/vtt", "original_name": "a.vtt", "declared_bytes": len(data)}
            out = ml.process_ticket(t, store=store, staging_root=staging, media_root=media, worker_id="w",
                                    tools=ml.Tools("ffprobe", "ffmpeg"))
            self.assertEqual(out, "retry")
            self.assertEqual(store.rejected, [])
            self.assertTrue(ml.staged_path(staging, tid).exists(), "the staged file is kept for the retry")
            self.assertEqual([p for p in media.rglob("*") if p.is_file()], [], "no orphaned files")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class Housekeeping(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_purge_removes_only_the_id_derived_folder(self):
        media = self.tmp / "media"
        aid, other = str(uuid.uuid4()), str(uuid.uuid4())
        for a in (aid, other):
            (media / a[:2] / a).mkdir(parents=True, exist_ok=True)
            (media / a[:2] / a / "original").write_bytes(b"x")
        store = FakeStore()
        store.candidates = [{"id": aid, "storage_key": ml.storage_key(aid)},
                            {"id": other, "storage_key": "../../somewhere"},
                            {"id": "../..", "storage_key": ".."}]
        self.assertEqual(ml.purge_deleted(store, media), 1)
        self.assertEqual(store.purged, [aid])
        self.assertFalse((media / aid[:2] / aid).exists())
        self.assertTrue((media / other[:2] / other / "original").exists())

    def test_gc_staging_removes_only_old_files(self):
        old, new = self.tmp / "old.upload", self.tmp / "new.upload"
        old.write_bytes(b"x")
        new.write_bytes(b"x")
        past = time.time() - ml.STAGING_MAX_AGE_S - 10
        os.utime(old, (past, past))
        self.assertEqual(ml.gc_staging(self.tmp), 1)
        self.assertFalse(old.exists())
        self.assertTrue(new.exists())


if __name__ == "__main__":
    unittest.main()
