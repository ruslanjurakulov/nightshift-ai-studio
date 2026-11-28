"""BR-L-211 residual (a): the upscale prices, checks and uploads a remuxed
copy of the member's file, never the file as it came.

Evidence (Breach, round 3 finding 2; mp4pack.py): several H.264 / HEVC access
units packed into one MP4 sample read as one packet each. h264p8.mp4 is 240
fps x 5 s (1200 frames) rewritten 8 to a sample: ffprobe and the container
read say 150 frames at 30 fps, and it was submitted at the 60 fps ceiling's
price. ``-c copy`` to MPEG-TS splits it back into 1200 packets.

Measured before the change (ffmpeg 6.1.1): a remux MP4 -> MP4 keeps 150
samples with or without ``h264_mp4toannexb``; MP4 -> TS -> MP4 writes 1200,
but drops the display matrix (rotation=90 is gone), and the imageio-ffmpeg
7.0.2 build of the Probe models runner segfaults opening any TS file. The raw
Annex B stream read back splits them as well (1200, both versions) but keeps
no timing. So the upload copy is the plain remux and the raw stream is only
counted; the parser may not find more frames than the copy has samples.

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
import threading
import time
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


def _rebuild_moov(src: Path, dst: Path, entries: tuple, config: bytes, edit) -> None:
    """Rewrite the one codec configuration box (``config``: avcC / hvcC) of a
    sample entry in ``entries`` with ``edit(payload) -> payload``. The file
    must keep moov after mdat (ffmpeg's default), so no chunk offset moves."""
    b = src.read_bytes()
    containers = {b"moov", b"trak", b"mdia", b"minf", b"stbl"}

    def parse(s, e):
        out, i = [], s
        while i + 8 <= e:
            n, t = struct.unpack(">I4s", b[i:i + 8])
            hdr = 8
            if n == 1:
                n, hdr = struct.unpack(">Q", b[i + 8:i + 16])[0], 16
            if n == 0:
                n = e - i
            out.append((t, i, n, hdr))
            i += n
        return out

    def box(t, payload):
        return struct.pack(">I4s", 8 + len(payload), t) + payload

    def entry(t, i, n, hdr):
        if t not in entries:
            return b[i:i + n]
        return box(t, b[i + 8:i + 86] + b"".join(rebuild(*c) for c in parse(i + 86, i + n)))

    def rebuild(t, i, n, hdr):
        payload = b[i + hdr:i + n]
        if t in containers:
            payload = b"".join(rebuild(*c) for c in parse(i + hdr, i + n))
        elif t == b"stsd":
            payload = b[i + 8:i + 16] + b"".join(entry(*c) for c in parse(i + 16, i + n))
        elif t == config:
            payload = edit(payload)
        return box(t, payload)

    top = parse(0, len(b))
    order = [t for t, *_ in top]
    assert order.index(b"mdat") < order.index(b"moov"), order
    dst.write_bytes(b"".join(rebuild(*c) if c[0] == b"moov" else b[c[1]:c[1] + c[2]] for c in top))


def bloat_avcc(src: Path, dst: Path, count: int, size: int) -> None:
    """Breach's avcc_bloat.py (#966 round 1, F1): ``count`` junk PPS of
    ``size`` bytes ahead of the real one (pps_id ue(v) >= 511, so every
    decoder drops them). ``h264_mp4toannexb`` writes the whole extradata
    before every IDR: 1.95 MB x 600 IDRs filled 2.34 GB of the worker's disk."""
    junk = struct.pack(">H", size) + bytes([0x0C]) + b"\xff" * (size - 2) + b"\x80"

    def edit(p):
        i = 6
        for _ in range(p[5] & 0x1F):
            i += 2 + struct.unpack(">H", p[i:i + 2])[0]
        npps, j = p[i], i + 1
        for _ in range(npps):
            j += 2 + struct.unpack(">H", p[j:j + 2])[0]
        return p[:i] + bytes([count + npps]) + junk * count + p[i + 1:j] + p[j:]

    _rebuild_moov(src, dst, (b"avc1", b"avc3"), b"avcC", edit)


def bloat_hvcc(src: Path, dst: Path, count: int) -> None:
    """Breach's hvcc_bloat.py: one more hvcC array of ``count`` SEI prefix
    units (type 39) of about 65 KB each, which ``hevc_mp4toannexb`` writes
    before every IRAP picture like the parameter sets."""
    pl = 65000
    nal = bytes([39 << 1, 1, 5]) + b"\xff" * (pl // 255) + bytes([pl % 255]) + b"\xaa" * pl + b"\x80"
    arr = bytes([39]) + struct.pack(">H", count) + (struct.pack(">H", len(nal)) + nal) * count

    def edit(p):
        return p[:22] + bytes([p[22] + 1]) + arr + p[23:]

    _rebuild_moov(src, dst, (b"hvc1", b"hev1"), b"hvcC", edit)


def pack2(src: Path, dst: Path, k: int, ticks_per_sample: int) -> None:
    """Breach's pack2.py (#966 round 1, F2): a one-track MP4 / MOV rebuilt so
    each sample holds ``k`` consecutive coded pictures of ANY codec, each
    sample lasting ``ticks_per_sample``, with mdhd / mvhd / tkhd rewritten to
    match: the container then reads 1/k of the pictures at a rate it chose."""
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
    samples, s = [], 0
    for c in range(nco):
        o = offs[c]
        for _ in range([e[1] for e in stsc if e[0] <= c + 1][-1]):
            samples.append(b[o:o + sizes[s]])
            o += sizes[s]
            s += 1
    mi, mn = find([b"moov", b"trak", b"mdia", b"mdhd"])
    mdhd = bytearray(b[mi:mi + mn])
    ti, tn = find([b"moov", b"trak", b"tkhd"])
    tkhd = bytearray(b[ti:ti + tn])
    vi, vn = find([b"moov", b"mvhd"])
    mvhd = bytearray(b[vi:vi + vn])
    hi, hn = find([b"moov", b"trak", b"mdia", b"hdlr"])
    hdlr = b[hi:hi + hn]
    minf = find([b"moov", b"trak", b"mdia", b"minf"])
    (xi, xn), (di, dn) = (find([name], minf[0] + 8, minf[0] + minf[1]) for name in (b"vmhd", b"dinf"))
    vmhd, dinf = b[xi:xi + xn], b[di:di + dn]
    assert mdhd[8] == 0 and mvhd[8] == 0 and tkhd[8] == 0, "version 1 headers are not handled"
    groups = [b"".join(samples[g:g + k]) for g in range(0, len(samples), k)]
    secs = len(groups) * ticks_per_sample / struct.unpack(">I", mdhd[20:24])[0]
    mdhd[24:28] = struct.pack(">I", len(groups) * ticks_per_sample)
    mvts = struct.unpack(">I", mvhd[20:24])[0]
    mvhd[24:28] = struct.pack(">I", round(secs * mvts))
    tkhd[28:32] = struct.pack(">I", round(secs * mvts))

    def B(t, body):
        return struct.pack(">I4s", 8 + len(body), t) + body

    def F(t, body):
        return B(t, b"\x00\x00\x00\x00" + body)

    ftyp = B(b"ftyp", b"isom\x00\x00\x02\x00isomiso2avc1mp41")

    def moov(mdat_off):
        st = B(b"stbl", stsd + F(b"stts", struct.pack(">III", 1, len(groups), ticks_per_sample))
               + F(b"stss", struct.pack(">II", 1, 1)) + F(b"stsc", struct.pack(">IIII", 1, 1, len(groups), 1))
               + F(b"stsz", struct.pack(">II", 0, len(groups)) + b"".join(struct.pack(">I", len(g)) for g in groups))
               + F(b"stco", struct.pack(">II", 1, mdat_off)))
        trak = B(b"trak", bytes(tkhd) + B(b"mdia", bytes(mdhd) + hdlr + B(b"minf", vmhd + dinf + st)))
        return B(b"moov", bytes(mvhd) + trak)

    off = len(ftyp) + len(moov(0)) + 8
    dst.write_bytes(ftyp + moov(off) + B(b"mdat", b"".join(groups)))


class FolderPeak:
    """The largest total size of the files under a folder, sampled every few
    milliseconds by a thread of its own while the code under test runs."""

    def __init__(self, folder: Path):
        self.folder, self.peak, self._stop = Path(folder), 0, threading.Event()
        self._thread = threading.Thread(target=self._watch, daemon=True)

    def _watch(self):
        while not self._stop.is_set():
            total = 0
            for root, _, files in os.walk(self.folder):
                for f in files:
                    try:
                        total += os.path.getsize(os.path.join(root, f))
                    except OSError:
                        pass
            self.peak = max(self.peak, total)
            time.sleep(0.005)

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._thread.join(5)
        return False


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
        self.assertEqual(norm.access_units, 1200)
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

        def keep(src, reading, work, **kw):
            norm = real(src, reading, work, **kw)
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
                                                 codec="h264", extradata=40)
        made = []
        real = a.normalize_of
        a.normalize_of = lambda src, reading, work, **kw: made.append(work) or real(src, reading, work, **kw)
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
        seen, counts = [], []
        real, real_count = fl.run, video._count_access_units

        def watch(argv, **kw):
            seen.append((list(argv), kw))
            return real(argv, **kw)

        def count(producer, counter, **kw):
            counts.append((producer, counter, kw))
            return real_count(producer, counter, **kw)

        with mock.patch.object(video.ffmpeg_limits, "run", side_effect=watch), \
                mock.patch.object(video, "_count_access_units", side_effect=count):
            norm = video.normalize_for_upload(clip, video.read_frames(str(clip)), self.work())
        self.assertEqual(norm.access_units, 48)
        self.assertEqual(len(seen), 1, "the copy is the one ffmpeg that writes a file")
        argv, kw = seen[0]
        self.assertGreater(kw["timeout_s"], 0)
        self.assertEqual(kw["fsize_bytes"], video.RunwayVideoUpscaleAdapter.MAX_BYTES + 1,
                         "the copy is capped at the most Runway takes")
        self.assertEqual(argv[argv.index("-map") + 1], "0:0", "the stream read_frames counted")
        (producer, counter, ckw), = counts
        self.assertGreater(ckw["timeout"], 0)
        self.assertGreater(ckw["max_bytes"], 0)
        prefix = fl.limited_argv([], fsize_bytes=video._PIPE_ONLY_FSIZE)
        inner = []
        for full in (producer, counter):
            self.assertEqual(full[:len(prefix)], prefix, "the count runs under the address-space limit")
            inner.append(full[len(prefix):])
        self.assertIn("h264_mp4toannexb", inner[0])
        self.assertEqual(inner[0][-1], "pipe:1")
        self.assertEqual(inner[1][inner[1].index("-protocol_whitelist") + 1], "pipe")
        self.assertEqual(inner[1][inner[1].index("-f") + 1], "h264")
        for one, whitelisted in ((argv, "file"), (inner[0], "file"), (inner[1], "pipe")):
            with self.subTest(argv=one[-1]):
                src = one.index("-i")
                self.assertEqual(one[one.index("-protocol_whitelist") + 1], whitelisted)
                self.assertLess(one.index("-f"), src, "the demuxer is named, never guessed")
                self.assertEqual(one[one.index("-max_pixels") + 1], str(ml.decoder_max_pixels("video/mp4")))
                self.assertLess(one.index("-max_pixels"), src)
                self.assertEqual(one[one.index("-threads") + 1], str(fl.DECODE_THREADS))
                self.assertEqual(one[one.index("-c") + 1], "copy")
                for encode in ("-c:v", "-vcodec", "-vf", "-filter_complex", "-crf", "-b:v"):
                    self.assertNotIn(encode, one)


class CopyCheckPins(_Tmp):
    """The checks on the copy, with the reading and the remux faked."""

    def _run(self, source, copy, *, copy_bytes=4096, units=None):
        src = self.tmp / "source.mp4"
        src.write_bytes(b"\x00" * 4096)
        works = []

        def normalize(path, reading, work, **kw):
            works.append(work)
            out = work / path.name
            with open(out, "wb") as fh:
                fh.truncate(copy_bytes)
            return video.Normalized(out, units)

        def fps_of(path):
            return source if Path(path) == src else copy

        a = _adapter()
        a.fps_of, a.normalize_of = fps_of, normalize
        err = _submit(a, src)
        for w in works:
            self.assertFalse(w.exists(), "the work folder must always be removed")
        return err, a.session.calls

    def R(self, frames=60, seconds=2.0, length=2.0, rate=None, avg=30.0):
        return video.FrameReading(rate=rate if rate is not None else frames / seconds, avg=avg, frames=frames,
                                  seconds=seconds, length=length, index=0, codec="h264", extradata=40)

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

    def test_a_source_over_30_seconds_or_of_unknown_length_is_refused_before_any_remux(self):
        # #966 round 1 (Lens H1 a): fail early, before the remux spends the
        # worker's disk and time on a file that can never be sent.
        for source, words in ((self.R(930, 31.0, 31.0), "runs 31.0 seconds; the upscale takes up to 30"),
                              (self.R(length=None), "length could not be read")):
            with self.subTest(words=words):
                called = []
                src = self.tmp / "source.mp4"
                src.write_bytes(b"\x00" * 4096)
                a = _adapter()
                a.fps_of = lambda _p, r=source: r
                a.normalize_of = lambda *args, **kw: called.append(args)
                err = _submit(a, src)
                self.assertIsNotNone(err)
                self.assertIn(words, err.message)
                self.assertEqual(called, [], "the remux must not run")
                self.assertEqual(a.session.calls, [])

    def test_a_copy_whose_length_is_unknown_is_refused(self):
        self.assertRefused("length could not be read", self.R(length=None), self.R(length=None))

    def test_a_copy_read_over_the_ceiling_is_refused(self):
        self.assertRefused("takes up to 60", self.R(), self.R(rate=240.0, avg=240.0))

    def test_a_parsed_count_above_the_copys_samples_is_refused(self):
        # The raw stream's timing is the demuxer's 25 fps default: never read.
        self.assertRefused("keeps several frames in one sample (120 frames in 60 samples)", self.R(), self.R(),
                           units=120)
        self.assertRefused("runs at 240 frames a second", self.R(), self.R(), units=480)
        self.assertRefused("could not be counted", self.R(), self.R(seconds=0.0, rate=30.0), units=60)

    def test_a_parser_that_finds_fewer_frames_than_samples_passes(self):
        # A field-coded stream kept a field to a sample: the quote overstates, never understates.
        err, calls = self._run(self.R(), self.R(), units=30)
        self.assertIsNone(err, err and err.message)


def _watched(a, peaks):
    """The adapter's real remux, with the work folder's size sampled while it runs."""
    real = a.normalize_of

    def watch(src, reading, work, **kw):
        with FolderPeak(work) as w:
            try:
                return real(src, reading, work, **kw)
            finally:
                peaks.append(w)

    a.normalize_of = watch
    return a


@unittest.skipUnless(HAVE_TOOLS and "libx264" in ENCODERS, "needs ffmpeg (libx264) and ffprobe")
class ExtradataBloatPins(_Tmp):
    """#966 round 1, Lens H1 = Breach F1: the Annex B count step filled the
    worker's disk. ``*_mp4toannexb`` writes the whole extradata before every
    IDR / IRAP: a 2 MB file with a 1.95 MB avcC and 600 IDRs wrote 2.34 GB,
    Breach's 16.6 MB bloat.mp4 4 GB, and both were submitted. Each pin failed
    on 9ee3835d6."""

    def _intra(self, encoder, extra=(), seconds=2):
        clip = self.tmp / f"intra_{encoder}.mp4"
        _ffmpeg("-f", "lavfi", "-i", f"testsrc=size=64x64:rate=60:duration={seconds}", "-c:v", encoder, *extra,
                "-an", str(clip))
        return clip

    def assertRefusedBounded(self, bloated, words):
        source = video.read_frames(str(bloated))
        self.assertIsNone(source.refusal)
        self.assertGreater(source.extradata, video.MAX_EXTRADATA_BYTES, "the forgery did not take")
        peaks = []
        a = _watched(_adapter(), peaks)
        err = _submit(a, bloated)
        self.assertIsNotNone(err, "a file whose extradata multiplies on every keyframe was submitted")
        self.assertEqual(err.code, E_BAD_REQUEST)
        self.assertIn(words, err.message)
        self.assertIn("export it again", err.message)
        self.assertEqual(a.session.calls, [], "nothing may be uploaded or POSTed before the refusal")
        # Refused before the copy is even written: the folder never held more
        # than the source itself could.
        for w in peaks:
            self.assertLessEqual(w.peak, bloated.stat().st_size, f"the work folder reached {w.peak} bytes")

    def test_br_l_211_a_big_avcc_is_refused_before_any_copy_and_the_work_folder_stays_bounded(self):
        # 8 junk PPS of 60 000 bytes: 480 KB of avcC before each of 120 IDRs,
        # 57 MB of raw stream (and as much again in its MP4) on 9ee3835d6.
        bloated = self.tmp / "bigavcc.mp4"
        bloat_avcc(self._intra("libx264", ("-preset", "ultrafast", "-g", "1")), bloated, 8, 60000)
        self.assertRefusedBounded(bloated, "codec header")

    @unittest.skipUnless("libx265" in ENCODERS, "needs libx265")
    def test_br_l_211_an_sei_bloated_hvcc_is_refused_before_any_copy_and_the_work_folder_stays_bounded(self):
        bloated = self.tmp / "bighvcc.mp4"
        bloat_hvcc(self._intra("libx265", ("-preset", "ultrafast", "-x265-params", "keyint=1:log-level=error")),
                   bloated, 8)
        self.assertRefusedBounded(bloated, "codec header")

    def test_br_l_211_the_bound_holds_without_ffprobe_too(self):
        # The Probe models runner reads the sample description from the boxes.
        bloated = self.tmp / "bigavcc.mp4"
        bloat_avcc(self._intra("libx264", ("-preset", "ultrafast", "-g", "1")), bloated, 8, 60000)
        with hide_ffprobe():
            self.assertGreater(video.read_frames(str(bloated)).extradata, video.MAX_EXTRADATA_BYTES)
            a = _adapter()
            err = _submit(a, bloated)
        self.assertIsNotNone(err)
        self.assertIn("codec header", err.message)
        self.assertEqual(a.session.calls, [])

    def test_real_parameter_sets_stay_far_under_the_bound(self):
        # Measured 2026-11-28 (ffmpeg 6.1.1): x264 35-48 bytes, x265 2.4-2.5 KB
        # (its settings SEI), HDR10 x265 with mastering display 2540 bytes.
        clips = [self._intra("libx264", ("-preset", "ultrafast", "-pix_fmt", "yuv422p10le", "-profile:v", "high422"))]
        if "libx265" in ENCODERS:
            hdr = self.tmp / "hdr10.mp4"
            _ffmpeg("-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=1", "-c:v", "libx265", "-preset",
                    "ultrafast", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", "-x265-params",
                    "log-level=error:hdr10=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:"
                    "master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):"
                    "max-cll=1000,400", str(hdr))
            clips.append(hdr)
        for clip in clips:
            for hidden in (False, True):
                with self.subTest(clip=clip.name, ffprobe_hidden=hidden):
                    if hidden:
                        with hide_ffprobe():
                            got = video.read_frames(str(clip)).extradata
                    else:
                        got = video.read_frames(str(clip)).extradata
                    self.assertIsNotNone(got)
                    self.assertLess(got, video.MAX_EXTRADATA_BYTES // 16)

    def test_the_access_unit_count_writes_nothing_to_disk(self):
        # On 9ee3835d6 the raw stream and its MP4 were written beside the copy.
        clip = self._intra("libx264", ("-preset", "ultrafast", "-g", "1"), seconds=4)
        source = video.read_frames(str(clip))
        work = self.work()
        with FolderPeak(work) as w:
            norm = video.normalize_for_upload(clip, source, work)
        self.assertEqual(norm.access_units, 240)
        self.assertEqual(sorted(p.name for p in work.rglob("*")), [clip.name], "only the copy is written")
        self.assertLessEqual(w.peak, norm.path.stat().st_size)


@unittest.skipUnless(HAVE_TOOLS and "libx264" in ENCODERS, "needs ffmpeg (libx264) and ffprobe")
class OutputCapPins(_Tmp):
    """Every ffmpeg output of the upscale has a size cap, and reaching it is a
    refusal, never a reading: a truncated stream counts fewer frames, and
    fewer passes the access-unit check."""

    def test_a_copy_that_would_pass_the_cap_is_refused_and_never_grows_past_it(self):
        clip = self.tmp / "clip.mp4"
        _ffmpeg("-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=2", "-c:v", "libx264", "-preset",
                "ultrafast", str(clip))
        cap = 20_000
        self.assertGreater(clip.stat().st_size, cap)
        work = self.work()
        with FolderPeak(work) as w, self.assertRaises(AdapterError) as cm:
            video.normalize_for_upload(clip, video.read_frames(str(clip)), work, max_bytes=cap)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertIn("larger than the", cm.exception.message)
        self.assertLessEqual(w.peak, cap + 1)

    def test_the_file_size_limit_reaches_the_child_and_a_write_past_it_fails_without_a_core(self):
        code = ("import resource,sys\n"
                "assert resource.getrlimit(resource.RLIMIT_FSIZE)[0] == 4096, resource.getrlimit(resource.RLIMIT_FSIZE)\n"
                "f = open(sys.argv[1], 'wb')\n"
                "try:\n    f.write(b'x' * 8192); f.flush()\nexcept OSError as e:\n    sys.exit(7 if e.errno == 27 else 8)\n")
        out = self.tmp / "big.bin"
        argv = fl.limited_argv([sys.executable, "-I", "-S", "-c", code, str(out)], fsize_bytes=4096)
        done = subprocess.run(argv, capture_output=True, timeout=60)
        self.assertEqual(done.returncode, 7, done.stderr)
        self.assertLessEqual(out.stat().st_size, 4096)
        # Without the keyword the limit is the host's, as before.
        plain = fl.limited_argv(["true"])
        self.assertNotIn("4096", plain)

    def _children(self, produce, count_code="import sys\nfor l in sys.stdin.buffer: sys.stdout.buffer.write(b'0, 1\\n')\n"):
        return ([sys.executable, "-I", "-S", "-c", produce], [sys.executable, "-I", "-S", "-c", count_code])

    def test_a_stream_over_its_byte_cap_is_refused_not_counted(self):
        produce = "import sys\nfor _ in range(64): sys.stdout.buffer.write(b'x' * 65535 + b'\\n')\n"
        a, b = self._children(produce)
        with self.assertRaises(AdapterError) as cm:
            video._count_access_units(a, b, timeout=60, max_bytes=1_000_000, what="H.264 MP4")
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertIn("export it again", cm.exception.message)

    def test_a_producer_that_fails_half_way_is_refused_not_a_short_count(self):
        produce = "import sys\nsys.stdout.buffer.write(b'a\\n' * 10); sys.stdout.flush(); sys.exit(3)\n"
        a, b = self._children(produce)
        with self.assertRaises(AdapterError):
            video._count_access_units(a, b, timeout=60, max_bytes=1_000_000, what="H.264 MP4")

    def test_a_counter_that_fails_is_refused_and_header_lines_are_not_packets(self):
        produce = "import sys\nsys.stdout.buffer.write(b'a\\n' * 10)\n"
        a, b = self._children(produce, "import sys\nsys.stdin.buffer.read(); sys.exit(1)\n")
        with self.assertRaises(AdapterError):
            video._count_access_units(a, b, timeout=60, max_bytes=1_000_000, what="H.264 MP4")
        counted = "import sys\nsys.stdin.buffer.read()\nsys.stdout.write('#tb 0: 1/25\\n#media_type 0: video\\n' + '0, 1, 2\\n' * 5)\n"
        a, b = self._children(produce, counted)
        self.assertEqual(video._count_access_units(a, b, timeout=60, max_bytes=1_000_000, what="H.264 MP4"), 5)

    def test_a_count_that_runs_out_of_time_is_refused(self):
        a, b = self._children("import time\ntime.sleep(60)\n")
        started = time.monotonic()
        with self.assertRaises(AdapterError) as cm:
            video._count_access_units(a, b, timeout=1, max_bytes=1_000_000, what="H.264 MP4")
        self.assertIn("too long to prepare", cm.exception.message)
        self.assertLess(time.monotonic() - started, 20)


@unittest.skipUnless(HAVE_TOOLS and "libx264" in ENCODERS, "needs ffmpeg (libx264) and ffprobe")
class CodecAllowListPins(_Tmp):
    """#966 round 1, Breach F2: 8 pictures packed into each sample of an
    MPEG-2, MPEG-4 Part 2, Motion JPEG or ProRes file read 150 frames at 30
    fps and were submitted; their raw parsers find 1200. Only the codecs
    whose packing the upscale handles are taken (h264 and hevc through the
    parser count, vp9 and av1 by decoding). Each failed on 9ee3835d6."""

    def _packed(self, encoder, suffix, extra=()):
        clean, packed = self.tmp / f"{encoder}{suffix}", self.tmp / f"{encoder}p8{suffix}"
        _ffmpeg("-f", "lavfi", "-i", "testsrc=size=64x64:rate=60:duration=2", "-c:v", encoder, *extra, "-an",
                str(clean))
        # 120 pictures, 8 to a sample, each sample 1/30 s: 15 samples at 30 fps.
        b = clean.read_bytes()
        i = b.index(b"stts")
        delta = struct.unpack(">I", b[i + 16:i + 20])[0]
        pack2(clean, packed, 8, 2 * delta)
        return packed

    def test_br_l_211_packed_pictures_of_codecs_without_a_parser_count_are_refused_before_upload(self):
        cases = [("mpeg2video", ".mp4", ()), ("mpeg4", ".mp4", ()), ("mjpeg", ".mp4", ()),
                 ("prores_ks", ".mov", ("-profile:v", "0"))]
        for encoder, suffix, extra in cases:
            if encoder not in ENCODERS:
                continue
            with self.subTest(encoder=encoder):
                packed = self._packed(encoder, suffix, extra)
                a = _adapter()
                err = _submit(a, packed)
                self.assertIsNotNone(err, f"{encoder}: 8 pictures a sample were submitted")
                self.assertEqual(err.code, E_BAD_REQUEST)
                self.assertIn("export it again as H.264 or HEVC MP4", err.message)
                self.assertEqual(a.session.calls, [])

    def test_prores_is_refused_without_ffprobe_too(self):
        if "prores_ks" not in ENCODERS:
            self.skipTest("needs prores_ks")
        packed = self._packed("prores_ks", ".mov", ("-profile:v", "0"))
        with hide_ffprobe():
            a = _adapter()
            err = _submit(a, packed)
        self.assertIsNotNone(err)
        self.assertIn("export it again as H.264 or HEVC MP4", err.message)
        self.assertEqual(a.session.calls, [])


@unittest.skipUnless(HAVE_TOOLS and "libx264" in ENCODERS, "needs ffmpeg (libx264) and ffprobe")
class RemedyPins(_Tmp):
    def test_a_sound_track_that_cannot_be_copied_names_the_sound(self):
        # A MOV with IMA ADPCM sound, named .mp4: the picture copies, the MP4
        # muxer has no tag for the sound. "Export it as H.264 MP4" would not fix it.
        src = self.tmp / "adpcm.mp4"
        _ffmpeg("-f", "lavfi", "-i", "testsrc=size=64x64:rate=30:duration=1", "-f", "lavfi", "-i",
                "sine=duration=1", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "adpcm_ima_qt", "-f", "mov",
                str(src))
        a = _adapter()
        err = _submit(a, src)
        self.assertIsNotNone(err)
        self.assertIn("sound", err.message)
        self.assertNotIn("H.264 MP4", err.message)
        self.assertEqual(a.session.calls, [])


class StaleWorkSweepPins(_Tmp):
    """A worker killed mid-upscale (OOM, a deploy) leaves its work folder, a
    copy of a member's video, in the temp folder: the next upscale removes
    those older than an hour, and only those."""

    def test_only_old_upscale_folders_of_this_user_are_removed(self):
        old, fresh, other = (self.tmp / n for n in ("nightshift-upscale-old", "nightshift-upscale-new", "keep-me"))
        for d in (old, fresh, other):
            d.mkdir()
            (d / "source.mp4").write_bytes(b"x" * 10)
        target = self.tmp / "target"
        target.mkdir()
        link = self.tmp / "nightshift-upscale-link"
        link.symlink_to(target)
        hour_ago = time.time() - 2 * 3600
        for d in (old, other, link):
            os.utime(d, (hour_ago, hour_ago), follow_symlinks=False)
        video.sweep_stale_work(self.tmp)
        self.assertFalse(old.exists())
        self.assertTrue(fresh.exists())
        self.assertTrue(other.exists())
        self.assertTrue(target.exists(), "a link is never followed")

    def test_the_upscale_sweeps_before_it_makes_its_own_folder(self):
        old = self.tmp / "nightshift-upscale-stale"
        old.mkdir()
        hour_ago = time.time() - 2 * 3600
        os.utime(old, (hour_ago, hour_ago))
        src = self.tmp / "x.mp4"
        src.write_bytes(b"\x00" * 1024)
        a = _adapter()
        a.fps_of = lambda _p: video.FrameReading(refusal="stop here")
        with mock.patch.object(video.tempfile, "gettempdir", return_value=str(self.tmp)):
            err = _submit(a, src)
        self.assertEqual(err.message, "stop here")
        self.assertFalse(old.exists())


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
