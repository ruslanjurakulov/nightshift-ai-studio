"""D5: QC reads black and frozen picture PER SCENE, not only whole-video totals.

The whole-video rules (a black run of ten seconds, a quarter of the video) were
written for long scenes. A video made of short scenes can lose one whole scene to
a dead stock source, or to the compositor's solid filler, and stay under every
total: a six-second black scene is "only a warning" there. These rules ask a
different question of the same measurements: is there a scene a viewer saw
nothing in? Their findings are QC *blocks*, which the publish gate already turns
into a held video (``publish_gate._check_video_qc``); nothing here publishes or
approves anything.

The mocked tests feed the exact text ffmpeg prints. The last class generates a
real clip with ffmpeg (skipped where ffmpeg is absent; CI has it through
imageio-ffmpeg) so the filter chain itself is exercised, including a Ken-Burns-like
slow zoom that must NOT read as frozen.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from modules import video_qc
from tests.test_video_qc import FakeFfmpeg, QcTestCase, banner, scan_output

# Five 6-second scenes: short enough that no single black or frozen run reaches
# the whole-video thresholds (10 s, a quarter of the video).
SHORT = [
    {"section": f"s{i}", "start_ms": i * 6_000, "end_ms": (i + 1) * 6_000} for i in range(5)
]


def freeze_lines(*runs):
    """stderr text of freezedetect for runs given as (start, end-or-None)."""
    lines = []
    for a, b in runs:
        lines.append(f"[freezedetect @ 0x3] lavfi.freezedetect.freeze_start: {a}")
        if b is not None:
            lines.append(f"[freezedetect @ 0x3] lavfi.freezedetect.freeze_duration: {b - a}")
            lines.append(f"[freezedetect @ 0x3] lavfi.freezedetect.freeze_end: {b}")
    return lines


class SceneQc(QcTestCase):
    def qc_short(self, black=(), frozen=(), decoded_s=30.0):
        stdout, stderr = scan_output(decoded_s=decoded_s, black=black)
        stderr += "\n".join(freeze_lines(*frozen)) + "\n"
        fake = FakeFfmpeg(banner().replace("00:01:00.02", "00:00:30.02"), scan=(stdout, stderr))
        return self.qc(fake, narration_duration_s=30.0, timeline=SHORT)


class BlackSceneTests(SceneQc):
    def test_a_whole_black_scene_blocks_even_when_the_totals_stay_small(self):
        report = self.qc_short(black=[(12.0, 18.0)])          # scene s002, 6 s of 30 s
        self.assertIn("video_qc_scene_black:s002", report.blocks)
        self.assertFalse(report.ok)

    def test_the_scene_is_named_in_the_report_measurements(self):
        report = self.qc_short(black=[(12.0, 18.0)])
        self.assertEqual(report.measured["scene_black"], {"s002": 1.0})

    def test_half_a_black_scene_is_not_a_scene_block(self):
        report = self.qc_short(black=[(12.0, 15.0)])
        self.assertEqual([b for b in report.blocks if "scene" in b], [])

    def test_a_run_that_straddles_two_scenes_blocks_neither(self):
        report = self.qc_short(black=[(9.0, 15.0)])           # half of s001, half of s002
        self.assertEqual([b for b in report.blocks if "scene" in b], [])

    def test_a_scene_too_short_to_judge_is_never_blocked(self):
        timeline = [{"section": "a", "start_ms": 0, "end_ms": 2_000},
                    {"section": "b", "start_ms": 2_000, "end_ms": 30_000}]
        stdout, stderr = scan_output(decoded_s=30.0, black=[(0.0, 2.0)])
        fake = FakeFfmpeg(banner().replace("00:01:00.02", "00:00:30.02"), scan=(stdout, stderr))
        report = self.qc(fake, narration_duration_s=30.0, timeline=timeline)
        self.assertEqual([b for b in report.blocks if "scene" in b], [])

    def test_no_black_means_no_scene_findings_and_a_recorded_pass(self):
        report = self.qc_short()
        self.assertEqual(report.blocks, [])
        self.assertEqual(report.measured["scene_black"], {})
        self.assertEqual({c.name: c.status for c in report.checks}["scenes"], "pass")

    def test_without_a_scene_timeline_the_per_scene_reading_is_unknown_not_clean(self):
        fake = FakeFfmpeg(banner(), scan=scan_output(black=[(12.0, 18.0)]))
        report = self.qc(fake, timeline=[])
        self.assertIn("video_qc_scenes_unchecked", report.warnings)
        self.assertEqual({c.name: c.status for c in report.checks}["scenes"], "skipped")


class FrozenSceneTests(SceneQc):
    def test_a_whole_frozen_scene_blocks(self):
        report = self.qc_short(frozen=[(6.0, 12.0)])           # scene s001
        self.assertIn("video_qc_scene_frozen:s001", report.blocks)

    def test_a_freeze_that_runs_to_the_end_is_closed_at_the_decoded_end(self):
        # ffmpeg prints no freeze_end when the picture is still frozen at EOF.
        report = self.qc_short(frozen=[(24.0, None)], decoded_s=30.0)
        self.assertIn("video_qc_scene_frozen:s004", report.blocks)
        self.assertEqual(report.measured["frozen_segments"][0]["end_s"], 30.0)

    def test_a_short_freeze_is_not_a_finding(self):
        report = self.qc_short(frozen=[(7.0, 9.5)])
        self.assertEqual(report.blocks, [])
        self.assertEqual(report.warnings, [])

    def test_a_long_partial_freeze_warns_but_does_not_block(self):
        report = self.qc_short(frozen=[(6.0, 10.5)])           # 4.5 s of s001's 6 s: 75 %
        self.assertEqual(report.blocks, [])
        self.assertIn("video_qc_frozen:4.5s@s001", report.warnings)

    def test_a_black_scene_is_reported_once_not_also_as_frozen(self):
        report = self.qc_short(black=[(6.0, 12.0)], frozen=[(6.0, 12.0)])
        self.assertEqual([b for b in report.blocks if "scene" in b], ["video_qc_scene_black:s001"])
        self.assertEqual([w for w in report.warnings if "frozen" in w], [])

    def test_a_scan_that_could_not_run_measures_nothing_and_never_blocks(self):
        fake = FakeFfmpeg(banner(), scan_exc=subprocess.TimeoutExpired("ffmpeg", 1200))
        report = self.qc(fake)
        self.assertNotIn("frozen_segments", report.measured)
        self.assertEqual(report.blocks, [])


class ScanCommandTests(SceneQc):
    def test_the_decode_pass_detects_freezes_outside_the_caption_band(self):
        fake = FakeFfmpeg(banner())
        self.qc(fake)
        scan_cmd = [c for c in fake.calls if "null" in c][0]
        chain = scan_cmd[scan_cmd.index("-vf") + 1]
        # Burnt-in word captions change a small part of every frame and would hide a
        # frozen picture behind them: the band they sit in is cropped away first.
        self.assertIn("blackdetect=", chain)
        self.assertLess(chain.index("crop="), chain.index("freezedetect="))
        self.assertIn("freezedetect=n=-60dB", chain)


def _ffmpeg():
    try:
        return video_qc._ffmpeg_exe()
    except Exception:
        return None


@unittest.skipUnless(_ffmpeg() or shutil.which("ffmpeg"), "ffmpeg is not installed here")
class RealFfmpegTests(unittest.TestCase):
    """One generated clip, five 6-second scenes: moving picture, black, a frozen
    still, a Ken-Burns-like slow zoom of a still, moving picture again."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.video = Path(cls.tmp.name) / "final_video.mp4"
        ff = video_qc._ffmpeg_exe()
        size, fps = "640x360", 30
        moving = f"testsrc2=s={size}:r={fps}:d=6"
        parts = [
            moving,
            f"color=c=black:s={size}:r={fps}:d=6",
            # one frame, held: a stock clip stuck on its last frame
            f"testsrc2=s={size}:r={fps}:d=0.04,loop=loop=-1:size=1,trim=duration=6,setpts=N/({fps}*TB)",
            # a textured still with the compositor's slow zoom (12 % over the scene)
            f"nullsrc=s=1280x720:r={fps}:d=6,geq=r='random(1)*255':g='random(1)*255':b='random(1)*255',"
            f"gblur=sigma=6,zoompan=z='1+0.12*on/180':d=1:s={size}:fps={fps}",
            moving,
        ]
        cmd = [ff, "-y", "-hide_banner", "-loglevel", "error"]
        for p in parts:
            cmd += ["-f", "lavfi", "-i", p]
        cmd += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=30",
                "-filter_complex", "".join(f"[{i}:v]format=yuv420p,setsar=1[v{i}];" for i in range(5))
                + "".join(f"[v{i}]" for i in range(5)) + "concat=n=5:v=1:a=0[v]",
                "-map", "[v]", "-map", "5:a", "-c:v", "libx264", "-c:a", "aac", "-shortest", str(cls.video)]
        done = subprocess.run(cmd, capture_output=True, text=True)
        if done.returncode != 0 or not cls.video.exists():
            raise unittest.SkipTest("this ffmpeg could not build the test clip: " + done.stderr[-300:])
        with patch("modules.video_qc._expected_format", return_value=(640, 360, 30.0)):
            cls.report = video_qc.run(cls.video, narration_duration_s=30.0, timeline=SHORT,
                                      write_report=False)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_the_black_scene_is_found_by_its_id(self):
        self.assertIn("video_qc_scene_black:s001", self.report.blocks)
        self.assertNotIn("video_qc_scene_frozen:s001", self.report.blocks)   # reported once, as black

    def test_the_frozen_scene_is_found_by_its_id(self):
        self.assertIn("video_qc_scene_frozen:s002", self.report.blocks)

    def test_moving_picture_and_a_slow_zoom_are_not_flagged(self):
        flagged = {b.rsplit(":", 1)[-1] for b in self.report.blocks if "scene" in b}
        self.assertEqual(flagged, {"s001", "s002"}, self.report.blocks)
        self.assertFalse([w for w in self.report.warnings if "frozen" in w and "s003" in w])


if __name__ == "__main__":
    unittest.main()
