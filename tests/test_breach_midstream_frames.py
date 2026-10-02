"""BR-L-004 — a video can switch to a bigger frame mid-stream, past every
probe-time pixel cap (residual of BR-C-001 / BR-D-001 / BR-E-001).

``interpret_probe`` / ``_check_frame`` / ``_check_every_picture`` judge what
ffprobe reports, and ffprobe reports the codec parameters of the FIRST frames.
H.264 (in-band SPS), HEVC, VP9 and AV1 may switch to a bigger frame at any
later keyframe; the decoder reallocates and decodes it in full. Measured with
the bundled ffmpeg 7.0.2: 8 s of 64x64 H.264 followed by 4096x4096 frames,
concatenated into one mp4. ``ffmpeg -i`` (and so the probe) says ``64x64``;
decoding it yields 78 frames of 64x64 and then 3 of 4096x4096 (peak RSS
128 MB vs 23 MB with the cap below).

Fixed in the decoder itself, where every path meets the cap: every ffmpeg
command that decodes library media passes ``-max_pixels <MAX_PIXELS>`` as an
input option before each ``-i`` (the thumbnail and the proxy at ingest, and
every command of an editor export), and ``-xerror`` where a refused frame must
fail the job instead of yielding a short or looped output (the proxy, and an
export's segment commands — a clip whose every frame is refused would
otherwise loop under ``-stream_loop -1`` until the render's time limit). The
probe checks stay as the early, friendly refusal.

The real-ffmpeg tests lower the cap (MAX_PIXELS / DECODE_MAX_PIXELS) to
100 000 px so a small, fast fixture (64x64 then 4096x4096) shows the refusal;
the unit tests pin the real 100 MP value on every command. They skip when no
ffmpeg is available. (CI runs ``unittest discover``, so no pytest here.)
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import List, Optional
from unittest import mock

from modules import media_library as ml
from modules import render_backend as rb
from modules import render_spec as rs

S = rs.Segment
CAP = str(ml.MAX_PIXELS)
#: A cap between the fixture's small frame (64x64 = 4 096 px) and its big one
#: (4096x4096 = 16.8 MP), standing in for MAX_PIXELS in the real-ffmpeg tests.
TEST_CAP = 100_000


def _input_options(argv: List[str]) -> List[List[str]]:
    """The input options of every ``-i`` in ``argv``: the tokens between the
    previous input (or the program name) and this ``-i``."""
    groups, start = [], 1
    for i, tok in enumerate(argv):
        if tok == "-i":
            groups.append(argv[start:i])
            start = i + 2
    return groups


class CapPinMixin:
    def assertEveryInputCapped(self, argv: List[str], cap: str = CAP) -> None:
        groups = _input_options(argv)
        self.assertTrue(groups, f"no -i in {argv}")
        for opts in groups:
            self.assertIn("-max_pixels", opts, f"an input has no -max_pixels: {argv}")
            self.assertEqual(opts[opts.index("-max_pixels") + 1], cap, argv)

    def assertFailsOnDecodeError(self, argv: List[str]) -> None:
        self.assertIn("-xerror", argv[:argv.index("-i")], argv)


# ── every command pins the flag (pure, no ffmpeg) ───────────────────────────

class IngestCommandCapTests(CapPinMixin, unittest.TestCase):
    def test_cap_is_the_probe_cap(self):
        self.assertEqual(ml.MAX_PIXELS, 100_000_000)
        self.assertEqual(rs.DECODE_MAX_PIXELS, ml.MAX_PIXELS)

    def test_thumbnail_command_caps_the_decoder_for_every_picture_type(self):
        for mime, kind in ml.ALLOWED_MIME.items():
            if kind not in ("image", "video") or mime not in ml.DEMUXER:
                continue
            with self.subTest(mime=mime):
                argv = ml.thumbnail_command("ffmpeg", Path("/m/o"), Path("/m/t.jpg"), mime,
                                            5.0 if kind == "video" else None)
                self.assertEveryInputCapped(argv)

    def test_proxy_command_caps_the_decoder_and_fails_on_a_refused_frame(self):
        for mime, kind in ml.ALLOWED_MIME.items():
            if kind != "video":
                continue
            with self.subTest(mime=mime):
                argv = ml.proxy_command("ffmpeg", Path("/m/o"), Path("/m/p.mp4"), mime)
                self.assertEveryInputCapped(argv)
                self.assertFailsOnDecodeError(argv)

    def test_the_cap_follows_max_pixels(self):
        with mock.patch.object(ml, "MAX_PIXELS", 1234):
            argv = ml.proxy_command("ffmpeg", Path("/m/o"), Path("/m/p.mp4"), "video/mp4")
        self.assertEveryInputCapped(argv, "1234")


def _timeline_segments() -> List[rs.Segment]:
    return [
        S(1.0, "/m/a.mp4"),
        S(1.0, "/m/a.mp4", in_s=2.0, fit=rs.FIT_COVER, speed=1.5, fade_in_s=0.2),
        S(1.0, None, rs.KIND_COLOR),
        S(2.0, "/m/i.jpg", rs.KIND_IMAGE),
        S(0.5, "/m/a.mp4", xfade=S(1.0, "/m/b.mp4")),
        S(0.5, "/m/i.jpg", rs.KIND_IMAGE, xfade=S(1.0, "/m/b.mp4")),
    ]


class EditorRenderCapTests(CapPinMixin, unittest.TestCase):
    def test_every_timeline_segment_command_caps_every_input(self):
        for seg in _timeline_segments():
            for x264 in ((), rb.INTERMEDIATE_X264):
                cmds = rb.segment_commands("ffmpeg", seg, Path("/t/seg.mp4"), 1080, 1920, 24,
                                           seed="s", x264=x264, frame_exact=True)
                for cmd in cmds:
                    with self.subTest(kind=seg.kind, xfade=seg.xfade is not None, cmd=cmd):
                        self.assertEveryInputCapped(cmd)
                        self.assertFailsOnDecodeError(cmd)

    def test_the_segments_the_export_actually_runs_are_capped(self):
        # Through _normalize_segment, as render() runs them, with a deadline
        # as editor_export passes one.
        for seg in _timeline_segments():
            calls = []
            with mock.patch.object(rb, "_run", side_effect=lambda c, deadline=None: calls.append(c)):
                rb._normalize_segment("ffmpeg", seg, Path("/t/seg.mp4"), 1080, 1920, 24,
                                      seed="s", frame_exact=True, deadline=1e12)
            self.assertTrue(calls)
            for cmd in calls:
                self.assertEveryInputCapped(cmd)
                self.assertFailsOnDecodeError(cmd)

    def test_timeline_final_commands_cap_every_input(self):
        tracks = [rs.AudioTrack("/m/v.mp3", 2.0), rs.AudioTrack("/m/clip.mp4", 2.0, start_s=1.0)]
        specs = [
            rs.RenderSpec("/o.mp4", segments=[S(2.0, "/t/s0.mp4")], frame_exact=True),
            rs.RenderSpec("/o.mp4", segments=[S(2.0, "/t/s0.mp4")], frame_exact=True,
                          audio_tracks=tracks),
            rs.RenderSpec("/o.mp4", segments=[S(2.0, "/t/s0.mp4")], frame_exact=True,
                          audio_tracks=tracks, overlays=[rs.TextOverlay(0.0, 1.0, "hi")]),
        ]
        for spec in specs:
            with self.subTest(tracks=len(spec.audio_tracks), overlays=len(spec.overlays)):
                cmd = rs.build_ffmpeg_command(spec, "/t/list.txt", "/t/o.ass")
                self.assertEqual(cmd.count("-i"), 1 + len(spec.audio_tracks))
                self.assertEveryInputCapped(cmd)

    def test_pipeline_commands_are_unchanged(self):
        # The pipeline's own renders (frame_exact False) keep their byte-pinned
        # argv (tests/test_render_spec_legacy.py); they read no library media.
        cmd = rb.segment_commands("ffmpeg", S(2.0, "/m/a.mp4"), Path("/t/seg.mp4"), 1920, 1080, 30)[0]
        self.assertNotIn("-max_pixels", cmd)
        self.assertNotIn("-xerror", cmd)
        spec = rs.RenderSpec("/o.mp4", segments=[S(2.0, "/m/a.mp4")], audio_path="/m/v.wav")
        self.assertNotIn("-max_pixels", rs.build_ffmpeg_command(spec, "/t/list.txt"))


# ── the real decoder refuses the bigger frame (needs ffmpeg) ────────────────

def _ffmpeg() -> Optional[str]:
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        exe = shutil.which("ffmpeg")
    return exe if exe and Path(exe).exists() else None


def _run(argv: List[str]) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, timeout=300)


class MidStreamFrameSwitchTests(unittest.TestCase):
    """A real mp4 that is 64x64 for 8 s and then switches to 4096x4096."""

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
        base = [exe, "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]
        x264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-x264-params", "repeat-headers=1", "-f", "h264"]
        steps = [
            base + ["-f", "lavfi", "-i", "testsrc=s=64x64:r=10:d=8", *x264, str(tmp / "small.h264")],
            base + ["-f", "lavfi", "-i", "testsrc=s=4096x4096:r=10:d=0.3", *x264, str(tmp / "big.h264")],
        ]
        for argv in steps:
            if _run(argv).returncode != 0:
                cls._dir.cleanup()
                raise unittest.SkipTest("this ffmpeg cannot encode the H.264 fixture")
        with open(tmp / "mixed.h264", "wb") as out:
            for name in ("small.h264", "big.h264"):
                out.write((tmp / name).read_bytes())
        for src, dst in (("small.h264", "small.mp4"), ("mixed.h264", "mixed.mp4")):
            if _run(base + ["-r", "10", "-f", "h264", "-i", str(tmp / src), "-c", "copy",
                            str(tmp / dst)]).returncode != 0:
                cls._dir.cleanup()
                raise unittest.SkipTest("this ffmpeg cannot mux the fixture")
        if _run(base + ["-f", "lavfi", "-i", "testsrc=s=512x512:d=1", "-frames:v", "1",
                        str(tmp / "pic.jpg")]).returncode != 0:
            cls._dir.cleanup()
            raise unittest.SkipTest("this ffmpeg cannot write a JPEG")

    @classmethod
    def tearDownClass(cls):
        cls._dir.cleanup()

    def setUp(self):
        self.work = Path(tempfile.mkdtemp(dir=self.tmp))

    def _decoded_sizes(self, *opts: str) -> List[str]:
        p = _run([self.exe, "-hide_banner", "-nostdin", *opts, "-i", str(self.tmp / "mixed.mp4"),
                  "-vf", "showinfo", "-f", "null", "-"])
        return re.findall(r" s:(\d+x\d+) ", p.stderr)

    # Controls: the fixture is what the finding says it is.

    def test_the_header_says_64x64_but_the_decoder_meets_4096x4096(self):
        head = _run([self.exe, "-hide_banner", "-i", str(self.tmp / "mixed.mp4")]).stderr
        self.assertRegex(head, r"Video: h264.*\b64x64\b")
        self.assertNotIn("4096x4096", head)
        sizes = self._decoded_sizes()
        self.assertIn("64x64", sizes)
        self.assertIn("4096x4096", sizes)

    def test_max_pixels_refuses_the_big_frames_in_this_ffmpeg(self):
        sizes = self._decoded_sizes("-max_pixels", str(TEST_CAP))
        self.assertIn("64x64", sizes)
        self.assertNotIn("4096x4096", sizes)

    # The fix, through the real commands.

    def test_ingest_proxy_fails_instead_of_decoding_the_big_frames(self):
        proxy = self.work / "proxy.mp4"
        with mock.patch.object(ml, "MAX_PIXELS", TEST_CAP):
            argv = ml.proxy_command(self.exe, self.tmp / "mixed.mp4", proxy, "video/mp4")
        code = ml.run_tool(argv, lambda: None, timeout_s=300)
        self.assertNotEqual(code, 0, "the proxy must fail, not come out short")

    def test_ingest_proxy_of_a_clean_video_still_works_under_the_cap(self):
        proxy = self.work / "proxy.mp4"
        with mock.patch.object(ml, "MAX_PIXELS", TEST_CAP):
            argv = ml.proxy_command(self.exe, self.tmp / "small.mp4", proxy, "video/mp4")
        self.assertEqual(ml.run_tool(argv, lambda: None, timeout_s=300), 0)
        self.assertGreater(proxy.stat().st_size, 0)

    def test_ingest_of_the_switching_video_is_refused(self):
        # The whole upload path with the real ffmpeg: the probe passes (it
        # sees 64x64), the thumbnail is taken from the small frames, and the
        # proxy refuses. The real ffprobe when there is one (imageio-ffmpeg
        # ships none), else a stand-in that answers what it answers.
        class Store:
            def heartbeat(self, *a, **k):
                pass

            def register(self, **kw):
                raise AssertionError("a refused file must never be registered")

        tid = "00000000-0000-4000-8000-000000000001"
        staging, media = self.work / "staging", self.work / "media"
        staging.mkdir()
        shutil.copyfile(self.tmp / "mixed.mp4", ml.staged_path(staging, tid))
        ticket = {"id": tid, "declared_bytes": 10 * 1024 * 1024, "declared_mime": "video/mp4",
                  "original_name": "clip.mp4"}
        ffprobe = shutil.which("ffprobe")
        if ffprobe:
            seen = ml.run_probe(ffprobe, ml.staged_path(staging, tid), "video/mp4")
            self.assertEqual((seen.kind, seen.width, seen.height), ("video", 64, 64))
            probe = ml.run_probe
        else:
            probe = lambda exe, path, sniffed: ml.Probe("video", "video/mp4", 64, 64, 8.1)  # noqa: E731
        with mock.patch.object(ml, "MAX_PIXELS", TEST_CAP):
            with self.assertRaises(ml.IngestReject) as e:
                ml.ingest(ticket, store=Store(), staging_root=staging, media_root=media,
                          worker_id="w", tools=ml.Tools(ffprobe=ffprobe or "ffprobe", ffmpeg=self.exe),
                          prober=probe)
        self.assertEqual(e.exception.reason, "decode_failed")
        self.assertEqual([p for p in media.rglob("*") if p.is_file()], [])

    def test_thumbnail_refuses_a_picture_over_the_cap(self):
        thumb = self.work / "thumb.jpg"
        with mock.patch.object(ml, "MAX_PIXELS", TEST_CAP):
            argv = ml.thumbnail_command(self.exe, self.tmp / "pic.jpg", thumb, "image/jpeg", None)
        code = ml.run_tool(argv, lambda: None, timeout_s=120)
        self.assertFalse(code == 0 and thumb.is_file() and thumb.stat().st_size > 0)

    def test_editor_export_segment_fails_on_the_big_frames(self):
        seg = S(1.0, str(self.tmp / "mixed.mp4"), in_s=7.5)
        with mock.patch.object(rs, "DECODE_MAX_PIXELS", TEST_CAP, create=True):
            with self.assertRaises(rb.RenderBackendError):
                rb._normalize_segment(self.exe, seg, self.work / "seg.mp4", 64, 64, 10,
                                      frame_exact=True, deadline=_deadline(120))

    def test_editor_export_of_a_clean_clip_still_loops_under_the_cap(self):
        # -xerror with -stream_loop -1: a slot longer than its clip loops the
        # clip, as before, without a spurious error at the loop point.
        seg = S(10.0, str(self.tmp / "small.mp4"))
        out = self.work / "seg.mp4"
        with mock.patch.object(rs, "DECODE_MAX_PIXELS", TEST_CAP, create=True):
            rb._normalize_segment(self.exe, seg, out, 64, 64, 10, frame_exact=True,
                                  deadline=_deadline(120))
        self.assertGreater(out.stat().st_size, 0)


def _deadline(seconds: float) -> float:
    import time

    return time.monotonic() + seconds


if __name__ == "__main__":
    unittest.main()
