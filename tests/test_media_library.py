"""modules/media_library.py — the worker side of the media library (0038).

What would break: a path built from anything but an id (traversal), a type
taken from the extension or the declared MIME instead of the content (spoof),
a playlist / concat script reaching ffmpeg's auto-detection, an oversize or
empty staged file registered, a purge deleting a path the database supplied,
or the Python allowlist drifting from the SQL one."""

import hashlib
import os
import re
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path

from modules import media_library as ml

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0038_media_assets.sql").read_text()

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 40
MP4 = b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41" + b"\x00" * 16
M4A = b"\x00\x00\x00\x20ftypM4A \x00\x00\x02\x00M4A isom" + b"\x00" * 16
MOV = b"\x00\x00\x00\x14ftypqt  \x00\x00\x02\x00qt  " + b"\x00" * 16


def fn_sql(name):
    return SQL.split(f"function public.{name}(", 1)[1].split("$$;", 1)[0]


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
        for variant in ("original", "thumb", "proxy"):
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
            if kind != "caption":
                self.assertIn(mime, ml.DEMUXER, mime)


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


class Ingest(unittest.TestCase):
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
