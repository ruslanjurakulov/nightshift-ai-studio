"""Lens round 3 (BR-L-007 .. BR-L-010): what an ffmpeg child that decodes
member media may cost, and what it must still accept.

* BR-L-008 (regression of #352): ``-xerror`` refused damaged but playable
  uploads (a truncated recording, a few flipped bytes) and failed whole editor
  exports. Dropped; a frame the decoder refuses is caught from stderr instead
  (``ffmpeg_limits.REFUSAL_MARKERS``).
* BR-L-009 (regression of #352): ``-max_pixels`` counts the width rounded up
  to 64, so a still at exactly the upload cap (10000x10000) was refused by
  the decoder. The decoder cap now carries that row padding.
* BR-L-007: a big CODED frame behind a tiny crop window passes
  ``-max_pixels`` (it checks the cropped size). Every member-media ffmpeg runs
  under an address-space limit with two threads, and the media library
  refuses a decode that needed far more memory than its declared frame.
* BR-L-010: a per-frame cap is not a memory or time budget. A lower cap for
  video (8192x4352), a decode budget (area x fps x duration) and a proxy time
  limit proportionate to the declared work.

Measured with the bundled ffmpeg 7.0.2 (the numbers are in
docs/security/LEDGER.md). The real-ffmpeg tests build small fixtures and,
where the real limit would need a big one, lower the limit instead; the unit
tests pin the real values. They skip without ffmpeg. (CI runs ``unittest
discover``, so no pytest here.)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from typing import List, Optional
from unittest import mock

from modules import media_library as ml
from modules import render_backend as rb
from modules import render_spec as rs

S = rs.Segment
MP4_HEAD = b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41" + b"\x00" * 16


def _ffmpeg() -> Optional[str]:
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        exe = shutil.which("ffmpeg")
    return exe if exe and Path(exe).exists() else None


def _run(argv: List[str]) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, timeout=300)


def _deadline(seconds: float) -> float:
    return time.monotonic() + seconds


def _video(width, height, duration="5", **extra) -> dict:
    return {"streams": [{"codec_type": "video", "width": width, "height": height, **extra}],
            "format": {"duration": duration}}


class _Store:
    def __init__(self):
        self.registered = []

    def heartbeat(self, *a, **k):
        pass

    def register(self, **kw):
        self.registered.append(kw)
        return {"id": kw["asset_id"], "reused": False}


def _ingest(test: unittest.TestCase, src: Path, probe_data: dict, *, exe: str = "ffmpeg", runner=None):
    """Run ``ml.ingest`` on a copy of ``src`` with a prober that answers
    ``probe_data`` (the bundled ffmpeg ships no ffprobe). Returns (store,
    files under media)."""
    tmp = Path(tempfile.mkdtemp())
    test.addCleanup(shutil.rmtree, tmp, True)
    staging, media = tmp / "staging", tmp / "media"
    staging.mkdir()
    media.mkdir()
    tid = str(uuid.uuid4())
    shutil.copyfile(src, ml.staged_path(staging, tid))
    ticket = {"id": tid, "declared_mime": "video/mp4", "original_name": "clip.mp4",
              "declared_bytes": src.stat().st_size}
    store = _Store()
    kw = {"runner": runner} if runner else {}
    try:
        ml.ingest(ticket, store=store, staging_root=staging, media_root=media, worker_id="w",
                  tools=ml.Tools("ffprobe", exe),
                  prober=lambda _exe, _path, sniffed: ml.interpret_probe(sniffed, probe_data), **kw)
    finally:
        files = [p for p in media.rglob("*") if p.is_file()]
    return store, files


# ── BR-L-010: the probe-time caps and budget (pure) ─────────────────────────

class VideoCapAndBudgetTests(unittest.TestCase):
    def assertRefused(self, data, reason, sniffed="video/mp4"):
        with self.assertRaises(ml.IngestReject) as e:
            ml.interpret_probe(sniffed, data)
        self.assertEqual(e.exception.reason, reason)

    def test_a_100_megapixel_video_frame_is_refused_and_a_still_is_not(self):
        # Accepted for video before BR-L-010 (the still cap applied to both).
        self.assertRefused(_video(10_000, 10_000), "too_large_dimensions")
        self.assertRefused(_video(9984, 10_016), "too_large_dimensions")   # Lens's g99.mp4
        p = ml.interpret_probe("image/jpeg", _video(10_000, 10_000, duration=""))
        self.assertEqual((p.kind, p.width, p.height), ("image", 10_000, 10_000))

    def test_8k_uhd_and_dci_stay_accepted_in_both_orientations(self):
        for w, h in ((7680, 4320), (4320, 7680), (8192, 4320), (4320, 8192), (8192, 4352), (4352, 8192)):
            with self.subTest(size=(w, h)):
                p = ml.interpret_probe("video/mp4", _video(w, h, avg_frame_rate="30/1"))
                self.assertEqual((p.kind, p.width, p.height), ("video", w, h))

    def test_the_decode_budget_refuses_too_much_video_for_its_size(self):
        for w, h, fps, minutes in ((7680, 4320, "30/1", 20), (3840, 2160, "60/1", 40),
                                   (3840, 2160, "30/1", 75), (1920, 1080, "30/1", 5 * 60),
                                   (1280, 720, "60/1", 11 * 60)):
            with self.subTest(size=(w, h), fps=fps, minutes=minutes):
                self.assertRefused(_video(w, h, str(minutes * 60), avg_frame_rate=fps), "too_long")

    def test_ordinary_long_videos_stay_accepted(self):
        """The legitimate matrix: phone and camera clips at their usual
        lengths, a long 1080p recording, a VFR phone clip whose rate reads
        0/0, and audio-like 360p for 24 hours."""
        cases = (
            (7680, 4320, "30/1", 15), (8192, 4320, "24/1", 15), (3840, 2160, "60/1", 30),
            (3840, 2160, "30000/1001", 60), (1920, 1080, "30/1", 4 * 60), (1920, 1080, "60/1", 2 * 60),
            (1280, 720, "30/1", 10 * 60), (1080, 1920, "0/0", 2 * 60), (640, 360, "30/1", 24 * 60),
            (1920, 1080, "240/1", 30),
        )
        for w, h, fps, minutes in cases:
            with self.subTest(size=(w, h), fps=fps, minutes=minutes):
                p = ml.interpret_probe("video/mp4", _video(w, h, str(minutes * 60), avg_frame_rate=fps))
                self.assertEqual((p.kind, p.width, p.height), ("video", w, h))

    def test_the_budget_counts_the_coded_frame_and_the_frame_rate(self):
        self.assertEqual(ml.DECODE_BUDGET_PX, 10 ** 12)
        # Under the budget at its display size, over it at its coded size.
        self.assertRefused(_video(1920, 1080, str(4 * 3600), avg_frame_rate="30/1",
                                  coded_width=3840, coded_height=2160), "too_long")
        # An implausible average falls back to the base rate, then to 60.
        self.assertEqual(ml.frame_rate({"avg_frame_rate": "90000/1", "r_frame_rate": "25/1"}), 25.0)
        self.assertEqual(ml.frame_rate({"avg_frame_rate": "0/0", "r_frame_rate": "1000/1"}), ml.ASSUMED_FPS)
        self.assertEqual(ml.frame_rate({}), 60.0)
        self.assertAlmostEqual(ml.frame_rate({"avg_frame_rate": "30000/1001"}), 29.97, places=2)

    def test_the_proxy_time_limit_follows_the_declared_work(self):
        short = ml.interpret_probe("video/mp4", _video(1920, 1080, "10", avg_frame_rate="30/1"))
        t_short = ml.proxy_timeout_s(short, 20 * 1024 * 1024)
        self.assertGreaterEqual(t_short, ml.PROXY_TIMEOUT_BASE_S)
        self.assertLess(t_short, 300)
        long = ml.interpret_probe("video/mp4", _video(1920, 1080, str(3 * 3600), avg_frame_rate="30/1"))
        self.assertGreater(ml.proxy_timeout_s(long, 10 * 1024 ** 3), 3600)
        self.assertLessEqual(ml.proxy_timeout_s(long, 10 * 1024 ** 3), ml.PROXY_TIMEOUT_S)
        # Every file the budget admits gets a limit its work fits in at the
        # slowest measured rate (HEVC 10-bit, one cpu: 190 Mpx/s; CABAC 5.6 MB/s).
        edge = ml.interpret_probe("video/mp4", _video(7680, 4320, str(15 * 60), avg_frame_rate="30/1"))
        nbytes = 9 * 1024 ** 3
        self.assertGreater(ml.proxy_timeout_s(edge, nbytes), edge.work_px / 190e6 + nbytes / 5.6e6)
        # A stand-in probe with no work recorded keeps the old ceiling.
        self.assertEqual(ml.proxy_timeout_s(ml.Probe("video", "video/mp4", 64, 64, 5.0), 1), ml.PROXY_TIMEOUT_S)

    def test_ingest_gives_the_proxy_its_proportionate_limit(self):
        seen = []

        def runner(argv, beat, **kw):
            seen.append((argv, kw))
            Path(argv[-1]).write_bytes(b"\xff\xd8\xff" + b"0" * 64)
            return 0

        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        src = tmp / "clip.mp4"
        src.write_bytes(MP4_HEAD)
        store, _ = _ingest(self, src, _video(1920, 1080, "10", avg_frame_rate="30/1"), runner=runner)
        self.assertEqual(len(store.registered), 1)
        (_, thumb_kw), (proxy_argv, proxy_kw) = seen
        self.assertEqual(thumb_kw["timeout_s"], ml.THUMB_TIMEOUT_S)
        self.assertLess(proxy_kw["timeout_s"], 300)
        self.assertEqual(proxy_kw["frame_px"], 1920 * 1080)


# ── the commands: caps, threads, no -xerror (pure) ──────────────────────────

class CommandLimitTests(unittest.TestCase):
    def test_decoder_cap_carries_the_row_padding_for_every_accepted_frame(self):
        """BR-L-009: ff_get_buffer checks FFALIGN(w, 64) * h. For every frame
        the upload check accepts, that is within the decoder cap."""
        for cap, mime in ((ml.MAX_PIXELS, "image/jpeg"), (ml.VIDEO_MAX_PIXELS, "video/mp4")):
            dec = ml.decoder_max_pixels(mime)
            self.assertEqual(dec, cap + 63 * ml.MAX_SIDE)
            for h in (1, 4320, 4352, 6103, 8192, 10_000, 10_016, ml.MAX_SIDE):
                w = min(ml.MAX_SIDE, cap // h)
                for w in (w, w - 1, w - 63, max(1, w - 64)):
                    if w < 1 or w * h > cap:
                        continue
                    with self.subTest(cap=cap, w=w, h=h):
                        self.assertLessEqual(-(-w // 64) * 64 * h, dec)
        self.assertEqual(rs.decoder_max_pixels(rs.DECODE_MAX_PIXELS), ml.decoder_max_pixels("image/png"))
        self.assertEqual(rs.decoder_max_pixels(rs.DECODE_VIDEO_MAX_PIXELS), ml.decoder_max_pixels("video/webm"))

    def test_ingest_commands_pin_threads_and_carry_no_xerror(self):
        for argv in (ml.proxy_command("ffmpeg", Path("/m/o"), Path("/m/p.mp4"), "video/mp4"),
                     ml.thumbnail_command("ffmpeg", Path("/m/o"), Path("/m/t.jpg"), "image/png", None)):
            with self.subTest(argv=argv[:6]):
                self.assertNotIn("-xerror", argv)
                i = argv.index("-i")
                self.assertEqual(argv[i - 2:i], ["-threads", "2"])
                self.assertIn("-filter_threads", argv[:i])
        proxy = ml.proxy_command("ffmpeg", Path("/m/o"), Path("/m/p.mp4"), "video/mp4")
        # The proxy's encoder threads too: their count would grow with the host.
        self.assertEqual(proxy[proxy.index("-pix_fmt") + 2:proxy.index("-pix_fmt") + 4], ["-threads", "2"])

    def test_export_commands_carry_no_xerror_and_pin_every_thread_count(self):
        """Measured with the counts of a bigger host forced: auto encoder
        threads failed the memory limit on a 1080p segment from an 8K clip
        (48 threads) and from a 720p one (96)."""
        cmds = []
        for seg in (S(1.0, "/m/a.mp4"), S(1.0, "/m/i.jpg", rs.KIND_IMAGE),
                    S(0.5, "/m/a.mp4", xfade=S(1.0, "/m/i.jpg", rs.KIND_IMAGE))):
            cmds += rb.segment_commands("ffmpeg", seg, Path("/t/s.mp4"), 1080, 1920, 24, frame_exact=True)
        cmds.append(rs.build_ffmpeg_command(rs.RenderSpec("/o.mp4", segments=[S(2.0, "/t/s0.mp4")],
                                                          frame_exact=True), "/t/list.txt"))
        for cmd in cmds:
            with self.subTest(cmd=cmd[:8]):
                self.assertNotIn("-xerror", cmd)
                self.assertEqual(cmd[-3:-1], ["-threads", "4"])
                self.assertEqual(cmd[1:5], ["-filter_threads", "2", "-filter_complex_threads", "2"])
        thumb = ml.thumbnail_command("ffmpeg", Path("/m/o"), Path("/m/t.jpg"), "image/png", None)
        self.assertEqual(thumb[-5:-3], ["-threads", "2"])


# ── the runner: limit, threads' environment, refusal, memory (needs a child) ──

class LimitedRunnerTests(unittest.TestCase):
    def setUp(self):
        from modules import ffmpeg_limits

        self.fl = ffmpeg_limits

    def _py(self, code: str) -> List[str]:
        return [sys.executable, "-c", code]

    def test_the_child_runs_under_the_address_space_limit(self):
        self.assertEqual(self.fl.CHILD_MEM_BYTES, 2 * 1024 ** 3)
        code = ("import resource,sys,os;s,h=resource.getrlimit(resource.RLIMIT_AS);"
                f"sys.exit(0 if s==h=={2 * 1024 ** 3} and os.environ.get('MALLOC_ARENA_MAX')=='2' else 3)")
        out = self.fl.run(self._py(code), timeout_s=60)
        self.assertEqual(out.returncode, 0)
        out = self.fl.run(self._py("import resource,sys;sys.exit(0 if resource.getrlimit(resource.RLIMIT_AS)[0]"
                                   f"=={256 * 1024 ** 2} else 3)"), timeout_s=60, mem_bytes=256 * 1024 ** 2)
        self.assertEqual(out.returncode, 0)

    def test_an_allocation_over_the_limit_fails_in_the_child(self):
        out = self.fl.run(self._py("b=bytearray(600*1024*1024)"), timeout_s=60, mem_bytes=256 * 1024 ** 2)
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("MemoryError", out.tail)

    def test_a_refusal_on_stderr_stops_the_child_at_once(self):
        code = ("import sys,time;sys.stderr.write('[h264] Picture size 4096x4096 exceeds specified max pixel "
                "count 100000, see the documentation\\n');sys.stderr.flush();time.sleep(60)")
        t0 = time.monotonic()
        out = self.fl.run(self._py(code), timeout_s=120)
        self.assertLess(time.monotonic() - t0, 30)
        self.assertTrue(out.refused)
        self.assertFalse(out.ok)
        for marker in (b"get_buffer() failed", b"Cannot allocate memory"):
            with self.subTest(marker=marker):
                out = self.fl.run(self._py(f"import sys;sys.stderr.write({marker.decode()!r})"), timeout_s=60)
                self.assertTrue(out.refused)

    def test_ordinary_decode_errors_are_not_a_refusal(self):
        code = ("import sys\nfor i in range(20000):\n sys.stderr.write('[h264] error while decoding MB 54 31, "
                "bytestream 5498\\n')")
        out = self.fl.run(self._py(code), timeout_s=60)
        self.assertTrue(out.ok, out)
        self.assertLessEqual(len(out.tail), self.fl.TAIL_BYTES)

    def test_a_marker_split_across_reads_is_still_seen(self):
        code = ("import sys,time;sys.stderr.write('x'*65530+'get_buf');sys.stderr.flush();time.sleep(0.2);"
                "sys.stderr.write('fer() failed\\n')")
        self.assertTrue(self.fl.run(self._py(code), timeout_s=60).refused)

    def test_the_time_limit_kills_and_reaps(self):
        out = self.fl.run(self._py("import time;time.sleep(60)"), timeout_s=0.5)
        self.assertTrue(out.timed_out)
        self.assertIsNone(out.returncode)

    def test_the_childs_own_peak_memory_is_reported(self):
        out = self.fl.run(self._py("b=bytearray(300*1024*1024);b[::4096]=b'x'*len(b[::4096])"), timeout_s=60)
        self.assertEqual(out.returncode, 0)
        self.assertGreater(out.peak_rss_bytes, 250 * 1024 ** 2)

    def test_run_tool_refuses_a_decode_far_bigger_than_its_frame(self):
        self.assertEqual(ml.expected_rss_bytes(64 * 64), ml.RSS_BASE_BYTES + 160 * 4096)
        self.assertGreater(ml.expected_rss_bytes(8192 * 4352), self.fl.CHILD_MEM_BYTES)
        hog = self._py("b=bytearray(300*1024*1024);b[::4096]=b'x'*len(b[::4096])")
        with mock.patch.object(ml, "RSS_BASE_BYTES", 128 * 1024 ** 2):
            self.assertEqual(ml.run_tool(hog, lambda: None, timeout_s=60, frame_px=64 * 64), ml.REFUSED_EXIT)
            self.assertEqual(ml.run_tool(hog, lambda: None, timeout_s=60, frame_px=None), 0)
            self.assertEqual(ml.run_tool(hog, lambda: None, timeout_s=60, frame_px=3840 * 2160), 0)

    def test_run_tool_timeout_is_the_timeout_reason(self):
        with self.assertRaises(ml.IngestReject) as e:
            ml.run_tool(self._py("import time;time.sleep(60)"), lambda: None, timeout_s=0.3, beat_s=0.1)
        self.assertEqual(e.exception.reason, "timeout")


# ── the real decoder (needs ffmpeg) ─────────────────────────────────────────

class RealDecoderTests(unittest.TestCase):
    """Fixtures: a clean 320x240 clip with sound, the same truncated to 70 %
    (a crashed recording) and with 40 bytes flipped inside the picture data
    (mp4 and mkv); a 64x64 clip that switches to an 8192x8192 coded frame
    behind a 64x64 crop window (Lens's BR-L-007 file at a quarter of the
    size); stills at the upload cap."""

    tmp: Path
    exe: str

    @classmethod
    def setUpClass(cls):
        exe = _ffmpeg()
        if not exe:
            raise unittest.SkipTest("no ffmpeg on this machine")
        cls.exe = exe
        cls._dir = tempfile.TemporaryDirectory()
        cls.tmp = tmp = Path(cls._dir.name)
        q = [exe, "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]
        h264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-f", "h264"]
        steps = [
            q + ["-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=6", "-f", "lavfi", "-i", "sine=d=6",
                 "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac",
                 "-movflags", "+faststart", str(tmp / "clean.mp4")],
            q + ["-i", str(tmp / "clean.mp4"), "-c", "copy", str(tmp / "clean.mkv")],
            q + ["-f", "lavfi", "-i", "testsrc=s=64x64:r=10:d=8", *h264, "-x264-params", "repeat-headers=1",
                 str(tmp / "small.h264")],
            q + ["-f", "lavfi", "-i", "color=c=gray:s=8192x8192:r=10:d=0.5", *h264,
                 "-x264-params", "repeat-headers=1:crop-rect=0,0,8128,8128", str(tmp / "big.h264")],
        ]
        for argv in steps:
            if _run(argv).returncode != 0:
                cls._dir.cleanup()
                raise unittest.SkipTest("this ffmpeg cannot build the fixtures")
        with open(tmp / "crop.h264", "wb") as out:
            out.write((tmp / "small.h264").read_bytes() + (tmp / "big.h264").read_bytes())
        for src, dst in (("small.h264", "small.mp4"), ("crop.h264", "crop.mp4")):
            if _run(q + ["-r", "10", "-f", "h264", "-i", str(tmp / src), "-c", "copy", str(tmp / dst)]).returncode:
                cls._dir.cleanup()
                raise unittest.SkipTest("this ffmpeg cannot mux the fixtures")
        data = (tmp / "clean.mp4").read_bytes()
        (tmp / "trunc.mp4").write_bytes(data[:int(len(data) * 0.7)])
        for name in ("clean.mp4", "clean.mkv"):
            b = bytearray((tmp / name).read_bytes())
            for i in range(40):
                b[int(len(b) * (0.3 + 0.5 * i / 40))] ^= 0xFF
            (tmp / ("flip" + Path(name).suffix)).write_bytes(bytes(b))

    @classmethod
    def tearDownClass(cls):
        cls._dir.cleanup()

    def setUp(self):
        self.work = Path(tempfile.mkdtemp(dir=self.tmp))

    def _proxy(self, name: str, mime: str = "video/mp4", **kw) -> int:
        return ml.run_tool(ml.proxy_command(self.exe, self.tmp / name, self.work / "p.mp4", mime),
                           lambda: None, timeout_s=300, **kw)

    # BR-L-008

    def test_damaged_but_playable_videos_still_get_a_proxy(self):
        for name, mime in (("trunc.mp4", "video/mp4"), ("flip.mp4", "video/mp4"),
                           ("flip.mkv", "video/x-matroska"), ("clean.mp4", "video/mp4")):
            with self.subTest(name=name):
                self.assertEqual(self._proxy(name, mime), 0)
                self.assertGreater((self.work / "p.mp4").stat().st_size, 0)

    def test_damaged_clips_still_render_in_an_export(self):
        for name in ("trunc.mp4", "flip.mp4", "flip.mkv"):
            for slot in (5.0, 12.0):
                with self.subTest(name=name, slot=slot):
                    out = self.work / f"seg-{name}-{slot}.mp4"
                    rb._normalize_segment(self.exe, S(slot, str(self.tmp / name)), out, 320, 240, 30,
                                          frame_exact=True, deadline=_deadline(120))
                    self.assertGreater(out.stat().st_size, 0)

    # BR-L-009

    def test_stills_at_the_upload_cap_get_a_thumbnail(self):
        q = [self.exe, "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]
        for w, h in ((10_000, 10_000), (12_000, 8333), (9984, 10_016)):
            with self.subTest(size=(w, h)):
                self.assertLessEqual(w * h, ml.MAX_PIXELS)
                pic = self.work / f"{w}x{h}.jpg"
                if _run(q + ["-f", "lavfi", "-i", f"color=c=gray:s={w}x{h}:d=1", "-frames:v", "1",
                             str(pic)]).returncode:
                    self.skipTest("this ffmpeg cannot write the still")
                thumb = self.work / f"t{w}.jpg"
                argv = ml.thumbnail_command(self.exe, pic, thumb, "image/jpeg", None)
                self.assertEqual(ml.run_tool(argv, lambda: None, timeout_s=120), 0)
                self.assertGreater(thumb.stat().st_size, 0)
                pic.unlink()

    def test_a_video_at_the_video_cap_gets_a_proxy(self):
        clip = self.work / "dci.mp4"
        if _run([self.exe, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi",
                 "-i", "color=c=gray:s=8192x4352:r=24:d=0.25", "-c:v", "libx264", "-preset", "ultrafast",
                 "-pix_fmt", "yuv420p", str(clip)]).returncode:
            self.skipTest("this ffmpeg cannot encode 8192x4352")
        self.assertEqual(ml.run_tool(ml.proxy_command(self.exe, clip, self.work / "p.mp4", "video/mp4"),
                                     lambda: None, timeout_s=300), 0)

    def test_hdr10_hevc_gets_a_proxy(self):
        clip = self.work / "hdr.mp4"
        params = ("log-level=error:hdr10=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:"
                  "master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):"
                  "max-cll=1000,400")
        if _run([self.exe, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi",
                 "-i", "testsrc2=s=640x360:r=30:d=1", "-c:v", "libx265", "-preset", "ultrafast",
                 "-pix_fmt", "yuv420p10le", "-x265-params", params, "-tag:v", "hvc1", str(clip)]).returncode:
            self.skipTest("this ffmpeg has no libx265")
        self.assertEqual(ml.run_tool(ml.proxy_command(self.exe, clip, self.work / "p.mp4", "video/mp4"),
                                     lambda: None, timeout_s=300), 0)

    # BR-L-007

    def test_the_crop_window_file_says_64x64(self):
        head = _run([self.exe, "-hide_banner", "-i", str(self.tmp / "crop.mp4")]).stderr
        self.assertRegex(head, r"Video: h264.*\b64x64\b")

    def test_a_big_coded_frame_behind_a_crop_window_is_refused_at_ingest(self):
        # The real base (512 MB) needs Lens's 14336x14336 file (1787 MB peak);
        # this quarter-size fixture peaks near 570 MB, so the base is lowered
        # to 256 MB, still above the clean 64x64 clip's ~140 MB.
        probe = _video(64, 64, "8.5", avg_frame_rate="10/1")
        with mock.patch.object(ml, "RSS_BASE_BYTES", 256 * 1024 ** 2, create=True):
            with self.assertRaises(ml.IngestReject) as e:
                _ingest(self, self.tmp / "crop.mp4", probe, exe=self.exe)
            self.assertEqual(e.exception.reason, "decode_failed")
            store, files = _ingest(self, self.tmp / "small.mp4", _video(64, 64, "8", avg_frame_rate="10/1"),
                                   exe=self.exe)
            self.assertEqual(len(store.registered), 1)

    def test_under_a_tight_limit_the_decoder_refusal_fails_the_run(self):
        # The address-space limit, scaled to the fixture: 448 MiB still runs
        # the clean clip, and the decoder cannot get the big coded frame.
        from modules import ffmpeg_limits

        with mock.patch.object(ffmpeg_limits, "CHILD_MEM_BYTES", 448 * 1024 ** 2):
            self.assertEqual(self._proxy("crop.mp4"), ml.REFUSED_EXIT)
            self.assertEqual(self._proxy("clean.mp4"), 0)
            with self.assertRaises(rb.RenderRefused):
                rb._normalize_segment(self.exe, S(2.0, str(self.tmp / "crop.mp4"), in_s=7.5),
                                      self.work / "seg.mp4", 64, 64, 10, frame_exact=True,
                                      deadline=_deadline(120))


# ── the upscale's frame-rate probe (Lens coverage note) ─────────────────────

class UpscaleFpsProbeTests(unittest.TestCase):
    def test_the_fps_probe_reads_only_the_file_as_its_type(self):
        from modules.capabilities import video

        seen = []

        def fake_run(argv, **kw):
            seen.append((argv, kw))
            return subprocess.CompletedProcess(argv, 0, b'{"streams":[{"avg_frame_rate":"30/1"}]}', b"")

        with mock.patch.object(video.shutil, "which", return_value="/usr/bin/ffprobe"), \
                mock.patch.object(video.subprocess, "run", side_effect=fake_run):
            for name, demuxer in (("a.mp4", "mov"), ("a.MOV", "mov"), ("a.webm", "matroska"),
                                  ("a.mkv", "matroska"), ("a.bin", None)):
                with self.subTest(name=name):
                    self.assertEqual(video.video_fps(f"/m/{name}"), 30.0)
                    argv, kw = seen[-1]
                    self.assertEqual(argv[argv.index("-protocol_whitelist") + 1], "file")
                    if demuxer:
                        self.assertEqual(argv[argv.index("-f") + 1], demuxer)
                    else:
                        self.assertNotIn("-f", argv)
                    self.assertLess(argv.index("-protocol_whitelist"), argv.index(f"/m/{name}"))
                    self.assertEqual(kw["timeout"], 30)


# ── an export: a refusal is render_failed, and is not redone ────────────────

class ExportRefusalTests(unittest.TestCase):
    def test_a_refused_segment_is_not_redone_one_at_a_time(self):
        calls = []

        def refuse(cmd, deadline=None):
            calls.append(cmd)
            raise rb.RenderRefused("refused")

        spec = rs.RenderSpec(str(Path(tempfile.mkdtemp()) / "o.mp4"),
                             segments=[S(1.0, "/m/a.mp4"), S(1.0, "/m/b.mp4")], frame_exact=True)
        with mock.patch.object(rb, "_run", side_effect=refuse):
            with self.assertRaises(rb.RenderRefused):
                rb.render(spec, ffmpeg="ffmpeg", jobs=1, timeout_s=60)
        self.assertEqual(len(calls), 1, "a refused file is refused again: no sequential redo")

    def test_a_refusal_ends_the_export_as_render_failed(self):
        from modules import editor_export

        aid = "11111111-1111-4111-8111-111111111111"
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, True)
        f = ml.asset_file(root, aid, "original")
        f.parent.mkdir(parents=True)
        f.write_bytes(b"x")

        def refused(doc, resolver, out, **kw):
            raise rb.RenderRefused("ffmpeg refused a frame")

        class Store:
            finished = []

            def export_assets(self, eid):
                return [{"id": aid, "kind": "video", "mime": "video/mp4", "duration_s": 20, "variants": []}]

            def export_heartbeat(self, *a):
                return True

            def finish_export(self, *a):
                self.finished.append(a)
                return "failed"

        doc = {"version": 1, "width": 64, "height": 36, "fps": 30, "tracks": [
            {"id": "v1", "kind": "V", "clips": [
                {"id": "c1", "asset_id": aid, "start_s": 0, "in_s": 0, "out_s": 10}]}]}
        store = Store()
        eid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
        status = editor_export.run_export(
            {"id": eid, "org_id": "00000000-0000-4000-8000-000000000001",
             "project_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "rev": 1, "duration_s": 10, "doc": doc},
            store=store, media_root=root, worker_id="w1", tools=ml.Tools("ffprobe", "ffmpeg"),
            render=refused, has_audio=lambda p, m: False, heartbeat_s=0.01)
        self.assertEqual(status, "failed")
        self.assertEqual(store.finished[-1][2:], (None, "render_failed"))
        self.assertFalse((root / editor_export.WORK_DIRNAME / eid).exists())


if __name__ == "__main__":
    unittest.main()
