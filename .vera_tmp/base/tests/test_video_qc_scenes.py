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
    def qc_short(self, black=(), frozen=(), decoded_s=30.0, **kw):
        stdout, stderr = scan_output(decoded_s=decoded_s, black=black)
        stderr += "\n".join(freeze_lines(*frozen)) + "\n"
        fake = FakeFfmpeg(banner().replace("00:01:00.02", "00:00:30.02"), scan=(stdout, stderr))
        return self.qc(fake, narration_duration_s=30.0, timeline=SHORT, **kw)


class BlackSceneTests(SceneQc):
    def test_a_whole_black_scene_blocks_even_when_the_totals_stay_small(self):
        report = self.qc_short(black=[(12.0, 18.0)], frozen=[(12.0, 18.0)])   # s002, 6 s of 30 s
        self.assertIn("video_qc_scene_black:s002", report.blocks)
        self.assertFalse(report.ok)

    def test_the_scene_is_named_in_the_report_measurements(self):
        report = self.qc_short(black=[(12.0, 18.0)], frozen=[(12.0, 18.0)])
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


class DarkButMovingTests(SceneQc):
    """blackdetect calls a frame black when 98 % of its pixels are dark, so a sparse
    night sky or a heading on a dark ground reads black while the picture moves.
    A scene is a dead scene only when it is black AND still (F1 of the review)."""

    def test_a_black_scene_that_is_not_frozen_does_not_block(self):
        report = self.qc_short(black=[(12.0, 18.0)])
        self.assertEqual([b for b in report.blocks if "scene" in b], [])

    def test_it_is_a_warning_so_a_person_still_sees_it(self):
        report = self.qc_short(black=[(12.0, 18.0)])
        self.assertIn("video_qc_scene_dark:s002", report.warnings)

    def test_black_with_less_than_half_the_scene_frozen_does_not_block(self):
        report = self.qc_short(black=[(12.0, 18.0)], frozen=[(12.0, 14.9)])        # 48 % frozen
        self.assertEqual([b for b in report.blocks if "scene" in b], [])

    def test_black_with_half_the_scene_frozen_blocks(self):
        report = self.qc_short(black=[(12.0, 18.0)], frozen=[(12.0, 15.0)])        # 50 % frozen
        self.assertIn("video_qc_scene_black:s002", report.blocks)

    def test_a_frozen_but_not_black_scene_still_blocks_as_frozen(self):
        report = self.qc_short(frozen=[(12.0, 18.0)])
        self.assertIn("video_qc_scene_frozen:s002", report.blocks)


class StaticCardTests(SceneQc):
    """A designed card (title, chapter, quote, stat, evidence) is still on purpose."""

    def test_a_scene_named_static_is_not_blocked_for_being_black_or_frozen(self):
        report = self.qc_short(black=[(12.0, 18.0)], frozen=[(12.0, 18.0)], static_scene_ids=["s002"])
        self.assertEqual([b for b in report.blocks if "scene" in b], [])
        self.assertEqual(report.measured["scene_static"], ["s002"])

    def test_the_other_scenes_are_still_judged(self):
        report = self.qc_short(black=[(6.0, 12.0), (12.0, 18.0)], frozen=[(6.0, 12.0), (12.0, 18.0)],
                               static_scene_ids=["s002"])
        self.assertEqual([b for b in report.blocks if "scene" in b], ["video_qc_scene_black:s001"])

    def test_nothing_is_static_unless_the_caller_says_so(self):
        report = self.qc_short(black=[(12.0, 18.0)], frozen=[(12.0, 18.0)])
        self.assertEqual(report.measured["scene_static"], [])
        self.assertIn("video_qc_scene_black:s002", report.blocks)

    def test_the_whole_video_gates_are_unchanged_by_static_scenes(self):
        # ten seconds of black is a hole whatever the scene is called
        timeline = [{"section": "a", "start_ms": 0, "end_ms": 30_000}]
        stdout, stderr = scan_output(decoded_s=30.0, black=[(5.0, 16.0)])
        fake = FakeFfmpeg(banner().replace("00:01:00.02", "00:00:30.02"), scan=(stdout, stderr))
        report = self.qc(fake, narration_duration_s=30.0, timeline=timeline, static_scene_ids=["s000"])
        self.assertTrue(any(b.startswith("video_qc_black:") for b in report.blocks))

    # -- a recipe is only an intention: the default compositor ignores it ------------
    # The director gives every section a recipe on every run (stat_counter for a
    # numbers-heavy sentence, quote_card for a quote ...), and the default moviepy
    # render draws that scene as an ordinary still or stock clip. Only a scene that
    # Remotion really rendered is a card; anything else keeps the per-scene blocks.

    @staticmethod
    def project(*recipes):
        from types import SimpleNamespace as NS
        return NS(scenes=[NS(id=f"s{i:03d}", shot=NS(recipe=r)) for i, r in enumerate(recipes)])

    RECIPES = ("title_card", "slow_push", "evidence_card", "lateral_pan", "chapter_card", "no_such_recipe")

    @staticmethod
    def rendered(**by_scene):
        return {"backend_by_scene": by_scene}

    def test_cards_that_remotion_rendered_are_static(self):
        sr = self.rendered(s000="remotion", s001="ffmpeg", s002="remotion", s003="ffmpeg",
                           s004="remotion", s005="remotion")
        self.assertEqual(video_qc.static_scene_ids(self.project(*self.RECIPES), sr),
                         ["s000", "s002", "s004"])

    def test_a_motion_recipe_is_not_static_even_when_remotion_rendered_it(self):
        sr = self.rendered(s001="remotion", s003="remotion")
        self.assertEqual(video_qc.static_scene_ids(self.project(*self.RECIPES), sr), [])

    def test_a_card_recipe_with_the_default_render_is_not_static(self):
        # The reproduced case: a stat_counter scene drawn by moviepy as a Ken-Burns still.
        project = self.project("title_card", "stat_counter", "quote_card")
        for scene_render in (None, {}, {"backend_by_scene": {}}, {"backend_by_scene": {"s001": "ffmpeg"}}):
            with self.subTest(scene_render=scene_render):
                self.assertEqual(video_qc.static_scene_ids(project, scene_render), [])
        self.assertEqual(video_qc.static_scene_ids(project), [])

    def test_a_scene_that_fell_back_from_remotion_to_ffmpeg_is_not_static(self):
        # scene_render records the backend that actually produced the scene.
        project = self.project("title_card")
        self.assertEqual(video_qc.static_scene_ids(project, self.rendered(s000="ffmpeg")), [])

    def test_a_malformed_render_record_means_nothing_is_skipped_and_never_raises(self):
        project = self.project("title_card")
        for bad in ("remotion", 7, ["remotion"], {"backend_by_scene": None}, {"backend_by_scene": ["s000"]},
                    {"backend_by_scene": "s000"}, {"backend_by_scene": {"s000": None}}):
            with self.subTest(bad=bad):
                self.assertEqual(video_qc.static_scene_ids(project, bad), [])

    def test_no_ir_project_means_no_static_scenes_and_no_crash(self):
        sr = self.rendered(s000="remotion")
        self.assertEqual(video_qc.static_scene_ids(None, sr), [])
        self.assertEqual(video_qc.static_scene_ids(object(), sr), [])

    def test_a_dead_scene_with_a_card_recipe_but_a_default_render_still_blocks(self):
        project = self.project("title_card", "evidence_card", "stat_counter", "slow_push", "slow_push")
        ids = video_qc.static_scene_ids(project, None)
        report = self.qc_short(black=[(12.0, 18.0)], frozen=[(12.0, 18.0)], static_scene_ids=ids)
        self.assertIn("video_qc_scene_black:s002", report.blocks)

    def test_the_same_dead_scene_is_skipped_when_remotion_really_drew_the_card(self):
        project = self.project("title_card", "evidence_card", "stat_counter", "slow_push", "slow_push")
        ids = video_qc.static_scene_ids(project, self.rendered(s002="remotion"))
        report = self.qc_short(black=[(12.0, 18.0)], frozen=[(12.0, 18.0)], static_scene_ids=ids)
        self.assertEqual([b for b in report.blocks if "scene" in b], [])


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


class FilterMissingTests(SceneQc):
    """If this ffmpeg has no freezedetect, the whole decode pass used to fail and
    black, silence and truncation went unmeasured with it (F2 of the review)."""

    class NoFreezeFfmpeg(FakeFfmpeg):
        def __call__(self, cmd, **kw):
            if "-f" in cmd and "null" in cmd and "-vf" in cmd and "freezedetect" in cmd[cmd.index("-vf") + 1]:
                self.calls.append(cmd)
                return subprocess.CompletedProcess(
                    cmd, 1, "", "[AVFilterGraph @ 0x1] No such filter: 'freezedetect'\nError reinitializing filters!\n")
            return super().__call__(cmd, **kw)

    def run_without_freeze(self, black=()):
        fake = self.NoFreezeFfmpeg(banner().replace("00:01:00.02", "00:00:30.02"),
                                   scan=scan_output(decoded_s=30.0, black=black))
        return fake, self.qc(fake, narration_duration_s=30.0, timeline=SHORT)

    def test_the_pass_is_retried_once_without_the_freeze_filter(self):
        fake, _ = self.run_without_freeze()
        scans = [c for c in fake.calls if "null" in c]
        self.assertEqual(len(scans), 2)
        self.assertNotIn("freezedetect", scans[1][scans[1].index("-vf") + 1])

    def test_black_is_still_measured_and_the_whole_video_rule_still_blocks(self):
        _, report = self.run_without_freeze(black=[(5.0, 16.0)])
        self.assertTrue(any(b.startswith("video_qc_black:") for b in report.blocks))
        self.assertEqual({c.name: c.status for c in report.checks}["decode"], "pass")

    def test_the_per_scene_reading_is_unknown_not_clean(self):
        _, report = self.run_without_freeze(black=[(12.0, 18.0)])
        self.assertIn("video_qc_scenes_unchecked", report.warnings)
        self.assertEqual({c.name: c.status for c in report.checks}["scenes"], "skipped")
        self.assertEqual([b for b in report.blocks if "scene" in b], [])

    def test_a_pass_that_fails_for_another_reason_is_not_retried(self):
        fake = FakeFfmpeg(banner(), scan=("frame=1\nout_time_us=1000000\n", "Invalid data found\n"), scan_rc=1)
        self.qc(fake)
        self.assertEqual(len([c for c in fake.calls if "null" in c]), 1)


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


def _build(video: Path, parts, audio_s: float, size="640x360", fps=30):
    """Concatenate lavfi sources into one mp4 with a tone, as the render would give."""
    ff = video_qc._ffmpeg_exe()
    cmd = [ff, "-y", "-hide_banner", "-loglevel", "error"]
    for p in parts:
        cmd += ["-f", "lavfi", "-i", p]
    n = len(parts)
    cmd += ["-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=44100:duration={audio_s}",
            "-filter_complex", "".join(f"[{i}:v]format=yuv420p,setsar=1[v{i}];" for i in range(n))
            + "".join(f"[v{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[v]",
            "-map", "[v]", "-map", f"{n}:a", "-c:v", "libx264", "-c:a", "aac", "-shortest", str(video)]
    done = subprocess.run(cmd, capture_output=True, text=True)
    if done.returncode != 0 or not video.exists():
        raise unittest.SkipTest("this ffmpeg could not build the test clip: " + done.stderr[-300:])


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


@unittest.skipUnless(_ffmpeg() or shutil.which("ffmpeg"), "ffmpeg is not installed here")
class DarkStaticSceneRealFfmpegTests(unittest.TestCase):
    """Cards and skies the reviewer found false holds on, built with ffmpeg:
    s000 a title card (#0b0b10, a bar 6 % of the width), s001 a short heading
    (under 2 % bright pixels), s002 a sparse night sky that slowly zooms,
    s003 moving picture. Ten seconds each, so every one is judged."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.video = Path(cls.tmp.name) / "final_video.mp4"
        size, fps = "640x360", 30
        card = (f"color=c=0x0b0b10:s={size}:r={fps}:d=10,"
                "drawbox=x=300:y=170:w=38:h=14:color=white:t=fill")           # 6 % of the width
        heading = (f"color=c=0x0b0b10:s={size}:r={fps}:d=10,"
                   "drawbox=x=290:y=170:w=60:h=16:color=white:t=fill")        # about 0.4 % of the pixels
        sky = (f"nullsrc=s=1280x720:r={fps}:d=10,"
               "geq=lum='if(gt(random(1),0.9985),255,4)':cb=128:cr=128,"
               f"zoompan=z='1+0.12*on/300':d=1:s={size}:fps={fps}")
        moving = f"testsrc2=s={size}:r={fps}:d=10"
        cls.timeline = [{"section": f"s{i}", "start_ms": i * 10_000, "end_ms": (i + 1) * 10_000}
                        for i in range(4)]
        _build(cls.video, [card, heading, sky, moving], 40)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def report(self, **kw):
        with patch("modules.video_qc._expected_format", return_value=(640, 360, 30.0)):
            return video_qc.run(self.video, narration_duration_s=40.0, timeline=self.timeline,
                                write_report=False, **kw)

    def scene_blocks(self, report):
        return {b.rsplit(":", 1)[-1] for b in report.blocks if "scene" in b}

    def test_a_sparse_night_sky_that_moves_is_not_held(self):
        report = self.report()
        self.assertNotIn("s002", self.scene_blocks(report), report.measured.get("scene_frozen"))

    def test_moving_picture_is_not_held(self):
        self.assertNotIn("s003", self.scene_blocks(self.report()))

    def test_cards_are_held_unless_the_caller_says_they_are_cards(self):
        # Why the caller must say so: a still card IS black-and-frozen to ffmpeg.
        self.assertTrue({"s000", "s001"} <= self.scene_blocks(self.report()))

    def test_cards_named_static_pass(self):
        report = self.report(static_scene_ids=["s000", "s001"])
        self.assertEqual(self.scene_blocks(report), set(), report.blocks)


if __name__ == "__main__":
    unittest.main()
