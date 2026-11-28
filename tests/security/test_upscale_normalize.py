"""BR-L-211 residual (a): the upscale prices, checks and uploads a remuxed
copy of the member's file, never the file as it came.

Evidence (Breach, round 3 finding 2; mp4pack.py): several H.264 / HEVC access
units packed into one MP4 sample read as one packet each. h264p8.mp4 is 240
fps x 5 s (1200 frames) rewritten 8 to a sample: ffprobe and the container
read say 150 frames at 30 fps, and it was submitted at the 60 fps ceiling's
price. ``-c copy`` to MPEG-TS splits it back into 1200 packets.

Measured before the change (ffmpeg 6.1.1): a remux MP4 -> MP4 keeps 150
samples with or without ``h264_mp4toannexb``; MP4 -> TS -> MP4 writes 1200,
but the TS round trip drops the display matrix (rotation=90 is gone). So the
upload copy is the plain remux and the TS file is only counted; the two must
hold the same frames.

What would break: a packed file submitted at the container's rate; a
re-encode slipped in (CLAUDE.md #4); a file other than the measured copy
uploaded; the sound or a phone's rotation silently dropped; the remux run
outside ffmpeg_limits; a probe that keeps a hostile file's whole stderr in
the worker's memory.

Self-contained (the security lab installs only its own requirements); real
files are built at test time, never committed. Bridged into the ordinary
Tests job by tests/test_video_tools.py.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from modules import ffmpeg_limits as fl
from modules import media_library as ml
from modules.capabilities import build_adapter
from modules.capabilities import video
from modules.capabilities.base import E_BAD_REQUEST, AdapterError, CapabilityRequest

KEY = "key_TOPSECRET-runway-normalize-0123456789"
ENV = {"RUNWAYML_API_SECRET": KEY}
UPLOAD = "https://runway-uploads.s3.amazonaws.com/"
TICKET = {"uploadUrl": UPLOAD, "fields": {"key": "ephemeral/abc/source.mp4"}, "runwayUri": "runway://ephemeral/abc"}
TASK = "1f2e3d4c-5b6a-4789-8abc-def012345678"

HAVE_TOOLS = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def _encoders() -> str:
    if not HAVE_TOOLS:
        return ""
    try:
        return subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True,
                              timeout=60).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


ENCODERS = _encoders()


class _Resp:
    def __init__(self, status=200, body=None):
        self.status_code, self._body = status, body
        self.text = json.dumps(body) if body is not None else ""
        self.headers = {}
        self.content = b""

    def json(self):
        return self._body


class _Session:
    """Records every call; reads an uploaded file while it is still open, so a
    test can compare the bytes that left with the copy that was measured."""

    def __init__(self, routes):
        self.routes, self.calls, self.uploaded = list(routes), [], []

    def request(self, method, url, **kw):
        if kw.get("files"):
            name, fh, mime = kw["files"]["file"]
            self.uploaded.append((name, fh.read(), mime))
        self.calls.append((method, url))
        for m, frag, resp in self.routes:
            if m == method and frag in url:
                return resp
        raise AssertionError(f"unexpected {method} {url}")


def _routes(estimate=34):
    return [("POST", "/v1/uploads", _Resp(200, TICKET)), ("POST", UPLOAD, _Resp(204)),
            ("POST", "/v1/video_upscale", _Resp(200, {"id": TASK, "estimatedCost": {"credits": estimate}}))]


def _adapter():
    return build_adapter("video.runway_upscale", env=ENV, session=_Session(_routes()))


def _submit(a, path, target="4k"):
    try:
        a.submit(CapabilityRequest("video_upscale", input_media=(str(path),), upscale_target=target),
                 "magnific_video_upscaler_creative")
    except AdapterError as e:
        return e
    return None


def _ffmpeg(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True, timeout=180, capture_output=True)


def _streams(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                          "stream=index,codec_type,codec_name:stream_side_data=rotation:stream_disposition=attached_pic",
                          "-of", "json", str(path)], capture_output=True, check=True, timeout=60).stdout
    return json.loads(out)["streams"]


def mp4pack(src: Path, dst: Path, k: int) -> None:
    """Breach's mp4pack.py (round 3): rebuild a one-track MP4 so each sample
    holds ``k`` consecutive length-prefixed access units, each sample lasting
    ``k`` of the original's. The container then reads the rate / k and the
    frames / k; the bitstream is untouched."""
    b = src.read_bytes()

    def atoms(s, e):
        i = s
        while i < e:
            n, t = struct.unpack(">I4s", b[i:i + 8])
            if n == 1:
                n = struct.unpack(">Q", b[i + 8:i + 16])[0]
            yield t, i, n
            i += n

    def find(path, s=0, e=None):
        e = len(b) if e is None else e
        for t, i, n in atoms(s, e):
            if t == path[0]:
                if len(path) == 1:
                    return i, n
                return find(path[1:], i + (16 if t == b"stsd" else 8), i + n)
        raise AssertionError(f"{path[0]!r} not found")

    stbl = find([b"moov", b"trak", b"mdia", b"minf", b"stbl"])

    def box(name):
        return find([name], stbl[0] + 8, stbl[0] + stbl[1])

    i, n = box(b"stsd")
    stsd = b[i:i + n]
    i, _ = box(b"stsz")
    cnt = struct.unpack(">I", b[i + 16:i + 20])[0]
    sizes = struct.unpack(">%dI" % cnt, b[i + 20:i + 20 + 4 * cnt])
    i, _ = box(b"stco")
    nco = struct.unpack(">I", b[i + 12:i + 16])[0]
    offs = struct.unpack(">%dI" % nco, b[i + 16:i + 16 + 4 * nco])
    i, _ = box(b"stsc")
    nsc = struct.unpack(">I", b[i + 12:i + 16])[0]
    stsc = [struct.unpack(">III", b[i + 16 + 12 * j:i + 28 + 12 * j]) for j in range(nsc)]
    i, _ = box(b"stts")
    delta = struct.unpack(">II", b[i + 16:i + 24])[1]
    samples, s = [], 0
    for c in range(nco):
        o = offs[c]
        for _ in range([e[1] for e in stsc if e[0] <= c + 1][-1]):
            samples.append(b[o:o + sizes[s]])
            o += sizes[s]
            s += 1
    piece = {name: b[i:i + n] for name, (i, n) in (
        ("mdhd", find([b"moov", b"trak", b"mdia", b"mdhd"])), ("tkhd", find([b"moov", b"trak", b"tkhd"])),
        ("mvhd", find([b"moov", b"mvhd"])), ("hdlr", find([b"moov", b"trak", b"mdia", b"hdlr"])))}
    minf = find([b"moov", b"trak", b"mdia", b"minf"])
    (vi, vn), (di, dn) = (find([name], minf[0] + 8, minf[0] + minf[1]) for name in (b"vmhd", b"dinf"))
    vmhd, dinf = b[vi:vi + vn], b[di:di + dn]
    groups = [b"".join(samples[g:g + k]) for g in range(0, len(samples), k)]

    def B(t, body):
        return struct.pack(">I4s", 8 + len(body), t) + body

    def F(t, body):
        return B(t, b"\x00\x00\x00\x00" + body)

    ftyp = B(b"ftyp", b"isom\x00\x00\x02\x00isomiso2avc1mp41")

    def moov(mdat_off):
        st = B(b"stbl", stsd + F(b"stts", struct.pack(">III", 1, len(groups), delta * k))
               + F(b"stss", struct.pack(">II", 1, 1)) + F(b"stsc", struct.pack(">IIII", 1, 1, len(groups), 1))
               + F(b"stsz", struct.pack(">II", 0, len(groups)) + b"".join(struct.pack(">I", len(g)) for g in groups))
               + F(b"stco", struct.pack(">II", 1, mdat_off)))
        trak = B(b"trak", piece["tkhd"] + B(b"mdia", piece["mdhd"] + piece["hdlr"] + B(b"minf", vmhd + dinf + st)))
        return B(b"moov", piece["mvhd"] + trak)

    off = len(ftyp) + len(moov(0)) + 8
    dst.write_bytes(ftyp + moov(off) + B(b"mdat", b"".join(groups)))


def hide_ffprobe():
    real = shutil.which
    return mock.patch.object(video.shutil, "which", lambda name, *a, **k: None if name == "ffprobe" else real(name, *a, **k))


class _Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def work(self) -> Path:
        """A folder of its own, as the adapter's mkdtemp is: the copy keeps the source's name."""
        return Path(tempfile.mkdtemp(dir=self.tmp))


@unittest.skipUnless(HAVE_TOOLS and "libx264" in ENCODERS, "needs ffmpeg (libx264) and ffprobe")
class PackedAccessUnitPins(_Tmp):
    """Residual (a) with real bytes: each failed on #955's head, which
    submitted the packed files at 30 fps."""

    def _packed(self, encoder, k=8, rate=240, seconds=5, extra=()):
        clean, packed = self.tmp / f"{encoder}_{rate}.mp4", self.tmp / f"{encoder}p{k}.mp4"
        _ffmpeg("-f", "lavfi", "-i", f"testsrc=size=64x64:rate={rate}:duration={seconds}", "-c:v", encoder,
                *extra, "-an", str(clean))
        mp4pack(clean, packed, k)
        return packed

    def assertPackedRefused(self, packed, words):
        source = video.read_frames(str(packed))
        # The forgery holds: the file itself reads at the container's rate.
        self.assertIsNone(source.refusal)
        self.assertEqual((source.frames, source.rate), (150, 30.0))
        norm = video.normalize_for_upload(packed, source, self.work())
        self.assertEqual(video.read_frames(str(norm.parsed)).frames, 1200)
        a = _adapter()
        err = _submit(a, packed)
        self.assertIsNotNone(err, "a packed file was submitted at its container's rate")
        self.assertEqual(err.code, E_BAD_REQUEST)
        self.assertIn(words, err.message)
        self.assertNotIn(KEY, err.message)
        self.assertEqual(a.session.calls, [], "nothing may be uploaded or POSTed before the refusal")

    def test_br_l_211_h264_with_8_access_units_a_sample_is_counted_1200_and_refused_over_the_ceiling(self):
        self.assertPackedRefused(self._packed("libx264", extra=("-preset", "ultrafast")),
                                 "this video runs at 240 frames a second of picture")

    @unittest.skipUnless("libx265" in ENCODERS, "needs libx265")
    def test_br_l_211_hevc_with_8_access_units_a_sample_is_counted_1200_and_refused_over_the_ceiling(self):
        self.assertPackedRefused(self._packed("libx265", extra=("-preset", "ultrafast", "-x265-params",
                                                                "log-level=error")),
                                 "this video runs at 240 frames a second of picture")

    def test_br_l_211_packing_under_the_ceiling_is_still_refused_as_packed(self):
        # 48 fps packed 4 to a sample: 24 samples at 12 fps, 96 frames at 48 a
        # second. Under the ceiling either way, but the container's count is
        # not the decoder's, so what Runway bills is not what was priced.
        packed = self._packed("libx264", k=4, rate=48, seconds=2, extra=("-preset", "ultrafast"))
        a = _adapter()
        err = _submit(a, packed)
        self.assertIsNotNone(err, "a packed file under the ceiling was submitted")
        self.assertIn("keeps several frames in one sample (96 frames in 24 samples)", err.message)
        self.assertIn("export it again", err.message)
        self.assertEqual(a.session.calls, [])


@unittest.skipUnless(HAVE_TOOLS and "libx264" in ENCODERS, "needs ffmpeg (libx264) and ffprobe")
class NormalizedUploadPins(_Tmp):
    def _recording(self, a):
        """Wrap the real remux to keep what it produced, before it is cleaned up."""
        made = []
        real = a.normalize_of

        def keep(src, reading, work):
            norm = real(src, reading, work)
            made.append((norm.path, norm.path.read_bytes()))
            return norm

        a.normalize_of = keep
        return made

    def test_the_live_probe_clip_passes_and_exactly_the_normalized_copy_is_uploaded(self):
        from tools.probe_models import probe_video  # noqa: PLC0415

        clip = probe_video(self.tmp / "probe_video.mp4")
        for hidden in (False, True):
            # True is the Probe models runner: no ffprobe, the container read.
            with self.subTest(ffprobe_hidden=hidden):
                a = _adapter()
                made = self._recording(a)
                if hidden:
                    with hide_ffprobe():
                        err = _submit(a, clip, "720p")
                else:
                    err = _submit(a, clip, "720p")
                self.assertIsNone(err, err and err.message)
                (path, copy_bytes), = made
                (name, sent, mime), = a.session.uploaded
                self.assertEqual(sent, copy_bytes, "the upload must be the copy that was measured")
                self.assertNotEqual(sent, clip.read_bytes(), "the member's file went as it came")
                self.assertEqual((name, mime), ("probe_video.mp4", "video/mp4"))
                self.assertFalse(path.exists(), "the copy must be removed once it is uploaded")
                self.assertFalse(path.parent.exists())
                self.assertEqual(a.estimated_credits(TASK), 34.0)
                self.assertEqual(a.counted_frames(TASK), 48)

    def test_a_file_that_cannot_be_remuxed_is_refused_before_any_upload(self):
        bad = self.tmp / "source.mp4"
        bad.write_bytes(b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + os.urandom(4096))
        a = _adapter()
        # The reading is made to pass, so only the remux can stop it.
        a.fps_of = lambda _p: video.FrameReading(rate=30.0, avg=30.0, frames=60, seconds=2.0, length=2.0, index=0,
                                                 codec="h264")
        made = []
        real = a.normalize_of
        a.normalize_of = lambda src, reading, work: made.append(work) or real(src, reading, work)
        err = _submit(a, bad)
        self.assertIsNotNone(err, "an unreadable file was uploaded")
        self.assertEqual(err.code, E_BAD_REQUEST)
        self.assertIn("could not be rewritten without re-encoding", err.message)
        self.assertIn("export it again as H.264 MP4", err.message)
        self.assertEqual(a.session.calls, [])
        self.assertFalse(made[0].exists(), "the work folder must be removed after a refusal")

    def test_the_copy_keeps_the_picture_its_sound_and_its_rotation_and_nothing_else(self):
        v, cover, src = self.tmp / "v.mp4", self.tmp / "cover.png", self.tmp / "phone.mp4"
        _ffmpeg("-f", "lavfi", "-i", "testsrc=size=64x48:rate=30:duration=2", "-f", "lavfi", "-i",
                "sine=frequency=440:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
                "-shortest", str(v))
        _ffmpeg("-f", "lavfi", "-i", "color=c=red:s=16x16:d=1", "-frames:v", "1", str(cover))
        rotated = self.tmp / "rot.mp4"
        _ffmpeg("-display_rotation", "90", "-i", str(v), "-c", "copy", str(rotated))
        _ffmpeg("-i", str(rotated), "-i", str(cover), "-map", "0", "-map", "1", "-c", "copy",
                "-disposition:v:1", "attached_pic", str(src))
        reading = video.read_frames(str(src))
        norm = video.normalize_for_upload(src, reading, self.work())
        got = _streams(norm.path)
        self.assertEqual([(s["codec_type"], s["codec_name"]) for s in got], [("video", "h264"), ("audio", "aac")],
                         "one picture and its sound, stream-copied; no cover art")
        rot = [d.get("rotation") for d in got[0].get("side_data_list", [])]
        self.assertIn(90, rot, "the copy must keep the phone's rotation (the TS round trip drops it)")
        copy = video.read_frames(str(norm.path))
        self.assertEqual((copy.frames, copy.codec), (reading.frames, "h264"))

    def test_the_remux_never_re_encodes_and_runs_under_the_member_media_limits(self):
        clip = self.tmp / "clip.mp4"
        _ffmpeg("-f", "lavfi", "-i", "testsrc=size=64x48:rate=24:duration=2", "-c:v", "libx264",
                "-preset", "ultrafast", str(clip))
        seen = []
        real = fl.run

        def watch(argv, **kw):
            seen.append((list(argv), kw))
            return real(argv, **kw)

        with mock.patch.object(video.ffmpeg_limits, "run", side_effect=watch):
            norm = video.normalize_for_upload(clip, video.read_frames(str(clip)), self.work())
        self.assertTrue(norm.parsed)
        self.assertEqual(len(seen), 3, "the copy, then the TS that splits access units, then its count")
        for argv, kw in seen:
            with self.subTest(argv=argv[-1]):
                self.assertGreater(kw["timeout_s"], 0)
                src = argv.index("-i")
                self.assertEqual(argv[argv.index("-protocol_whitelist") + 1], "file")
                self.assertLess(argv.index("-f"), src, "the demuxer is named, never guessed")
                self.assertEqual(argv[argv.index("-max_pixels") + 1], str(ml.decoder_max_pixels("video/mp4")))
                self.assertLess(argv.index("-max_pixels"), src)
                self.assertEqual(argv[argv.index("-threads") + 1], str(fl.DECODE_THREADS))
                self.assertEqual(argv[argv.index("-c") + 1], "copy")
                for encode in ("-c:v", "-vcodec", "-vf", "-filter_complex", "-crf", "-b:v"):
                    self.assertNotIn(encode, argv)
        self.assertEqual(seen[0][0][seen[0][0].index("-map") + 1], "0:0", "the stream read_frames counted")
        self.assertIn("h264_mp4toannexb", seen[1][0])


class CopyCheckPins(_Tmp):
    """The checks on the copy, with the reading and the remux faked."""

    def _run(self, source, copy, *, copy_bytes=4096, parsed=None):
        src = self.tmp / "source.mp4"
        src.write_bytes(b"\x00" * 4096)
        works = []

        def normalize(path, reading, work):
            works.append(work)
            out = work / path.name
            with open(out, "wb") as fh:
                fh.truncate(copy_bytes)
            p = None
            if parsed is not None:
                p = work / "parsed.mp4"
                p.write_bytes(b"\x00" * 1024)
            return video.Normalized(out, p)

        def fps_of(path):
            p = Path(path)
            if p.name == "parsed.mp4":
                return parsed
            return source if p == src else copy

        a = _adapter()
        a.fps_of, a.normalize_of = fps_of, normalize
        err = _submit(a, src)
        for w in works:
            self.assertFalse(w.exists(), "the work folder must always be removed")
        return err, a.session.calls

    def R(self, frames=60, seconds=2.0, length=2.0, rate=None, avg=30.0):
        return video.FrameReading(rate=rate if rate is not None else frames / seconds, avg=avg, frames=frames,
                                  seconds=seconds, length=length, index=0, codec="h264")

    def assertRefused(self, words, *args, **kw):
        err, calls = self._run(*args, **kw)
        self.assertIsNotNone(err, "the upscale was submitted")
        self.assertEqual(err.code, E_BAD_REQUEST)
        self.assertIn(words, err.message)
        self.assertEqual(calls, [], "nothing may be uploaded or POSTed before the refusal")

    def test_an_agreeing_copy_is_uploaded(self):
        err, calls = self._run(self.R(), self.R(61))
        self.assertIsNone(err, err and err.message)
        self.assertEqual([c[1].rsplit("/", 1)[-1] for c in calls if "/v1/" in c[1]], ["uploads", "video_upscale"])

    def test_a_copy_with_other_frames_than_the_file_is_refused(self):
        self.assertRefused("holds 50 frames in 2.0 seconds where the file reads 60 in 2.0", self.R(), self.R(50))

    def test_a_copy_of_another_length_is_refused(self):
        self.assertRefused("where the file reads 60 in 2.0", self.R(), self.R(60, 1.5, rate=40.0))

    def test_a_copy_over_200_mb_is_refused(self):
        self.assertRefused("outside the 512 bytes to 200 MB", self.R(), self.R(), copy_bytes=200 * 1024 * 1024 + 1)

    def test_a_copy_over_30_seconds_is_refused(self):
        long = self.R(930, 31.0, 31.0)
        self.assertRefused("runs 31.0 seconds; the upscale takes up to 30", long, long)

    def test_a_copy_whose_length_is_unknown_is_refused(self):
        self.assertRefused("length could not be read", self.R(length=None), self.R(length=None))

    def test_a_copy_read_over_the_ceiling_is_refused(self):
        self.assertRefused("takes up to 60", self.R(), self.R(rate=240.0, avg=240.0))

    def test_a_parsed_count_that_differs_from_the_copy_is_refused(self):
        self.assertRefused("keeps several frames in one sample (120 frames in 60 samples)", self.R(), self.R(),
                           parsed=self.R(120, 3.0, rate=40.0))


class BoundedProbePins(unittest.TestCase):
    """Lens on #955: ``_ffprobe_run`` used ``capture_output``, which keeps the
    whole stderr (and stdout) in the worker; RLIMIT_AS bounds only the child."""

    def _child(self, code):
        return [sys.executable, "-I", "-S", "-c", code]

    def test_a_flood_of_stderr_is_kept_as_its_tail_and_its_markers(self):
        marker = fl.REFUSAL_MARKERS[0]
        code = ("import sys\nw=sys.stderr.buffer.write\nw(b'%s\\n')\n"
                "for _ in range(320): w(b'x' * 65536)\nsys.stdout.write('{}')\n" % marker.decode())
        out = video._bounded_run(self._child(code), timeout=60)
        self.assertEqual(out.stdout, b"{}")
        self.assertLessEqual(len(out.stderr), fl.TAIL_BYTES + 200, "20 MB of stderr must not be kept")
        self.assertIn(marker, out.stderr, "a refusal early in a long stderr must survive the tail")
        self.assertIn("larger than the upscale accepts", video._decode_refusal(out.stderr, "VP9 WebM"))

    def test_an_answer_larger_than_any_reading_is_unknown(self):
        code = "import sys\nsys.stdout.write('{\"streams\": [' + '{},' * (%d // 3) + '{}]}')\n" % video._PROBE_STDOUT_MAX
        self.assertIsNone(video._bounded_run(self._child(code), timeout=60).stdout)
        self.assertEqual(video._ffprobe_run(self._child(code), 60), (None, b""))

    def test_a_timeout_kills_the_child_and_carries_the_evidence(self):
        marker = fl.REFUSAL_MARKERS[1]
        code = "import sys,time\nsys.stderr.buffer.write(b'%s\\n'); sys.stderr.flush()\ntime.sleep(60)\n" % marker.decode()
        with self.assertRaises(subprocess.TimeoutExpired) as cm:
            video._bounded_run(self._child(code), timeout=1)
        self.assertIn(marker, cm.exception.stderr)

    def test_the_decode_is_stopped_at_its_first_refusal(self):
        marker = fl.REFUSAL_MARKERS[0]
        code = ("import sys,time\nsys.stderr.buffer.write(b'%s\\n'); sys.stderr.flush()\ntime.sleep(60)\n"
                % marker.decode())
        out = video._bounded_run(self._child(code), timeout=30, kill_on_refusal=True)
        self.assertNotEqual(out.returncode, 0)
        self.assertIn(marker, out.stderr)


if __name__ == "__main__":
    unittest.main()
