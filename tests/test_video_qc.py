"""Deterministic video QC (modules/video_qc.py) and its place in the gate.

ffmpeg is mocked throughout: each test feeds the exact text ffmpeg/ffprobe
prints for one failure mode, so what is pinned is our reading of that text and
the severity we give it — not whichever ffmpeg the container happens to have.
"""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from modules import publish_gate, video_qc

BANNER = """Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'final_video.mp4':
  Metadata:
    title           : Terror of the Deep
  Duration: 00:01:00.02, start: 0.000000, bitrate: 2500 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), {w}x{h} [SAR 1:1 DAR 16:9], 2400 kb/s, {fps} fps, 30 tbr, 15360 tbn (default)
{audio}At least one output file must be specified
"""
AUDIO_LINE = "  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)\n"

TIMELINE = [
    {"section": "hook", "start_ms": 0, "end_ms": 20_000},
    {"section": "story", "start_ms": 20_000, "end_ms": 45_000},
    {"section": "outro", "start_ms": 45_000, "end_ms": 60_000},
]


def banner(w=1920, h=1080, fps="30", audio=True):
    return BANNER.format(w=w, h=h, fps=fps, audio=AUDIO_LINE if audio else "")


def scan_output(decoded_s=60.02, black=(), silence=(), errors=()):
    """(stdout, stderr) of the blackdetect/silencedetect decode pass."""
    stdout = f"frame=100\nout_time_us={int(decoded_s * 1_000_000)}\nprogress=end\n"
    lines = []
    for a, b in black:
        lines.append(f"[blackdetect @ 0x1] black_start:{a} black_end:{b} black_duration:{b - a}")
    for a, b in silence:
        lines.append(f"[silencedetect @ 0x2] silence_start: {a}")
        if b is not None:
            lines.append(f"[silencedetect @ 0x2] silence_end: {b} | silence_duration: {b - a}")
    lines.extend(errors)
    return stdout, "\n".join(lines) + "\n"


class FakeFfmpeg:
    """Stands in for subprocess.run: the probe gets the banner, the decode pass
    gets the scan output."""

    def __init__(self, probe_stderr, scan=None, scan_rc=0, scan_exc=None):
        self.probe_stderr = probe_stderr
        self.scan = scan or scan_output()
        self.scan_rc = scan_rc
        self.scan_exc = scan_exc
        self.calls = []

    def __call__(self, cmd, **kwargs):
        self.calls.append(cmd)
        if "-f" in cmd and "null" in cmd:
            if self.scan_exc:
                raise self.scan_exc
            out, err = self.scan
            return subprocess.CompletedProcess(cmd, self.scan_rc, out, err)
        return subprocess.CompletedProcess(cmd, 1, "", self.probe_stderr)


class QcTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.video = Path(self.tmp.name) / "final_video.mp4"
        self.video.write_bytes(b"0" * 200_000)
        patchers = [
            patch("modules.video_qc._ffprobe_exe", return_value=None),
            patch("modules.video_qc._ffmpeg_exe", return_value="/usr/bin/ffmpeg"),
            patch("modules.video_qc._expected_format", return_value=(1920, 1080, 30.0)),
        ]
        for p in patchers:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.tmp.cleanup)

    def qc(self, fake, **kw):
        kw.setdefault("narration_duration_s", 60.0)
        kw.setdefault("timeline", TIMELINE)
        with patch("modules.video_qc.subprocess.run", side_effect=fake):
            return video_qc.run(self.video, **kw)


class CleanRenderTests(QcTestCase):
    def test_a_clean_render_passes_every_check_and_writes_the_report(self):
        report = self.qc(FakeFfmpeg(banner()))
        self.assertEqual(report.blocks, [])
        self.assertEqual(report.warnings, [])
        statuses = {c.name: c.status for c in report.checks}
        for name in ("streams", "resolution", "fps", "duration", "decode", "black", "silence"):
            self.assertEqual(statuses[name], "pass", name)
        written = json.loads((self.video.parent / "qc_report.json").read_text())
        self.assertTrue(written["ok"])
        self.assertEqual(written["measured"]["width"], 1920)

    def test_the_metadata_title_word_terror_is_not_a_decode_error(self):
        report = self.qc(FakeFfmpeg(banner(), scan=scan_output(errors=["    title : Terror"])))
        self.assertEqual(report.measured["decode_errors"], 0)

    def test_short_pauses_and_a_fade_are_not_findings(self):
        fake = FakeFfmpeg(banner(), scan=scan_output(black=[(0.0, 1.2)], silence=[(30.0, 32.5)]))
        report = self.qc(fake)
        self.assertEqual(report.blocks, [])
        self.assertEqual(report.warnings, [])


class ContainerTests(QcTestCase):
    def test_a_missing_audio_stream_blocks(self):
        report = self.qc(FakeFfmpeg(banner(audio=False)))
        self.assertIn("video_qc_no_audio_stream", report.blocks)

    def test_the_decode_pass_skips_silencedetect_when_there_is_no_audio(self):
        fake = FakeFfmpeg(banner(audio=False))
        self.qc(fake)
        scan_cmd = [c for c in fake.calls if "null" in c][0]
        self.assertIn("-an", scan_cmd)
        self.assertNotIn("-af", scan_cmd)

    def test_an_unreadable_file_blocks(self):
        err = "[in#0] Error opening input: Invalid data found when processing input\n"
        report = self.qc(FakeFfmpeg(err))
        self.assertEqual(report.blocks, ["video_qc_unreadable"])

    def test_a_missing_file_blocks(self):
        self.video.unlink()
        report = self.qc(FakeFfmpeg(banner()))
        self.assertEqual(report.blocks, ["video_qc_file_missing"])

    def test_a_wrong_resolution_or_fps_warns_but_does_not_block(self):
        report = self.qc(FakeFfmpeg(banner(w=1280, h=720, fps="25")))
        self.assertEqual(report.blocks, [])
        self.assertIn("video_qc_resolution:1280x720", report.warnings)
        self.assertIn("video_qc_fps:25", report.warnings)

    def test_29_97_fps_counts_as_30(self):
        report = self.qc(FakeFfmpeg(banner(fps="29.97")))
        self.assertNotIn("fps", " ".join(report.warnings))

    def test_ffprobe_json_is_used_when_present(self):
        probe_json = json.dumps({
            "format": {"duration": "60.02"},
            "streams": [
                {"codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080,
                 "avg_frame_rate": "30000/1001"},
                {"codec_type": "audio", "codec_name": "aac"},
            ],
        })

        def fake(cmd, **kw):
            if cmd[0] == "/usr/bin/ffprobe":
                return subprocess.CompletedProcess(cmd, 0, probe_json, "")
            out, err = scan_output()
            return subprocess.CompletedProcess(cmd, 0, out, err)

        with patch("modules.video_qc._ffprobe_exe", return_value="/usr/bin/ffprobe"):
            report = self.qc(fake)
        self.assertEqual(report.blocks, [])
        self.assertAlmostEqual(report.measured["fps"], 29.97, places=2)


class DurationTests(QcTestCase):
    def test_drift_within_codec_rounding_passes(self):
        report = self.qc(FakeFfmpeg(banner()), narration_duration_s=59.9)
        self.assertEqual(report.warnings, [])

    def test_half_a_second_to_a_second_warns(self):
        report = self.qc(FakeFfmpeg(banner()), narration_duration_s=59.3)
        self.assertEqual(report.blocks, [])
        self.assertTrue(any(w.startswith("video_qc_duration_drift") for w in report.warnings))

    def test_more_than_a_second_off_the_narration_blocks(self):
        report = self.qc(FakeFfmpeg(banner()), narration_duration_s=75.0)
        self.assertTrue(any(b.startswith("video_qc_duration_mismatch:-15") for b in report.blocks))

    def test_the_timeline_end_is_used_when_no_audio_file_is_given(self):
        report = self.qc(FakeFfmpeg(banner()), narration_duration_s=None)
        self.assertEqual(report.measured["narration_source"], "timeline")
        self.assertEqual(report.measured["narration_s"], 60.0)

    def test_an_unknown_narration_is_unchecked_not_passed(self):
        report = self.qc(FakeFfmpeg(banner()), narration_duration_s=None, timeline=None)
        self.assertIn("video_qc_duration_unchecked", report.warnings)
        self.assertEqual({c.name: c.status for c in report.checks}["duration"], "skipped")
        self.assertIsNone(report.measured["narration_s"])


class DecodeTests(QcTestCase):
    def test_a_file_that_stops_decoding_early_is_truncated(self):
        fake = FakeFfmpeg(banner(), scan=scan_output(decoded_s=21.4, errors=[
            "[h264 @ 0x1] Invalid NAL unit size (470 > 118).",
        ]))
        report = self.qc(fake)
        self.assertIn("video_qc_truncated:21.4s", report.blocks)

    def test_decode_errors_on_a_complete_file_warn(self):
        fake = FakeFfmpeg(banner(), scan=scan_output(errors=[
            "[h264 @ 0x1] error while decoding MB 12 4, bytestream -5",
            "[h264 @ 0x1] concealing 200 DC, 200 AC, 200 MV errors in P frame",
        ]))
        report = self.qc(fake)
        self.assertEqual(report.blocks, [])
        self.assertIn("video_qc_decode_errors:2", report.warnings)

    def test_a_scan_that_times_out_is_a_warning_never_a_block(self):
        fake = FakeFfmpeg(banner(), scan_exc=subprocess.TimeoutExpired("ffmpeg", 1200))
        report = self.qc(fake)
        self.assertEqual(report.blocks, [])
        self.assertIn("video_qc_errored:scan:TimeoutExpired", report.warnings)
        statuses = {c.name: c.status for c in report.checks}
        self.assertEqual(statuses["black"], "error")


class BlackAndSilenceTests(QcTestCase):
    def test_a_long_black_run_blocks_and_names_the_scene(self):
        fake = FakeFfmpeg(banner(), scan=scan_output(black=[(22.0, 34.0)]))
        report = self.qc(fake)
        self.assertIn("video_qc_black:12.0s@s001", report.blocks)
        span = report.measured["black_segments"][0]
        self.assertEqual(span["scene_ids"], ["s001"])

    def test_a_short_black_run_warns(self):
        fake = FakeFfmpeg(banner(), scan=scan_output(black=[(19.0, 22.0)]))
        report = self.qc(fake)
        self.assertEqual(report.blocks, [])
        self.assertIn("video_qc_black:3.0s@s000", report.warnings)
        self.assertEqual(report.measured["black_segments"][0]["scene_ids"], ["s000", "s001"])

    def test_many_short_black_runs_adding_up_to_a_quarter_block(self):
        runs = [(i * 4.0, i * 4.0 + 1.9) for i in range(9)]  # 17.1s of 60s
        report = self.qc(FakeFfmpeg(banner(), scan=scan_output(black=runs)))
        self.assertTrue(any(b.startswith("video_qc_black:") for b in report.blocks))

    def test_a_dropped_narration_segment_blocks(self):
        fake = FakeFfmpeg(banner(), scan=scan_output(silence=[(46.0, 58.5)]))
        report = self.qc(fake)
        self.assertIn("video_qc_silence:12.5s@s002", report.blocks)

    def test_a_silence_that_runs_to_the_end_is_closed_at_the_decoded_end(self):
        fake = FakeFfmpeg(banner(), scan=scan_output(decoded_s=60.0, silence=[(54.0, None)]))
        report = self.qc(fake)
        self.assertEqual(report.measured["silent_segments"][0]["end_s"], 60.0)
        self.assertIn("video_qc_silence:6.0s@s002", report.warnings)


class NeverRaisesTests(QcTestCase):
    def test_no_ffmpeg_at_all_is_a_skip_warning(self):
        with patch("modules.video_qc._ffmpeg_exe", return_value=None):
            report = self.qc(FakeFfmpeg(banner()))
        self.assertEqual(report.blocks, [])
        self.assertIn("video_qc_skipped:no_ffmpeg", report.warnings)

    def test_an_unexpected_crash_is_a_warning(self):
        with patch("modules.video_qc._run_checks", side_effect=RuntimeError("boom")):
            report = video_qc.run(self.video)
        self.assertEqual(report.blocks, [])
        self.assertIn("video_qc_errored:RuntimeError", report.warnings)

    def test_a_none_path_does_not_raise(self):
        report = video_qc.run(None)
        self.assertIn("video_qc_file_missing", report.blocks)


# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------


def gate_script():
    return SimpleNamespace(
        topic="A Real Topic", title="A Title", description="d",
        sections=[SimpleNamespace(narration="One."), SimpleNamespace(narration="Two.")],
    )


class NoDuplicates:
    def check(self, topic):
        return SimpleNamespace(is_duplicate=False, needs_review=False)


class GateIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.video = Path(self.tmp.name) / "final_video.mp4"
        self.video.write_bytes(b"0" * 200_000)

    def evaluate(self, qc, gate=None, video=True):
        return publish_gate.evaluate(
            script=gate_script(),
            video_path=self.video if video else None,
            fact_results=[],
            channel=SimpleNamespace(agent=SimpleNamespace(publish_gate=gate or {})),
            originality=NoDuplicates(),
            qc_report=qc,
        )

    def test_severe_qc_findings_block_the_upload(self):
        qc = video_qc.QcReport(blocks=["video_qc_no_audio_stream"], warnings=["video_qc_fps:25"])
        d = self.evaluate(qc)
        self.assertFalse(d.allowed)
        self.assertIn("video_qc_no_audio_stream", d.blocks)
        self.assertIn("video_qc_fps:25", d.warnings)
        self.assertIn("video_qc", d.checks_run)

    def test_turning_off_sanity_blocking_downgrades_qc_to_warnings(self):
        qc = video_qc.QcReport(blocks=["video_qc_truncated:21.4s"])
        d = self.evaluate(qc, gate={"block_on_sanity": False})
        self.assertTrue(d.allowed)
        self.assertIn("video_qc_truncated:21.4s", d.warnings)

    def test_a_crashed_qc_check_never_blocks(self):
        qc = video_qc.QcReport(warnings=["video_qc_errored:scan:TimeoutExpired"])
        d = self.evaluate(qc)
        self.assertTrue(d.allowed)
        self.assertIn("video_qc_errored:scan:TimeoutExpired", d.warnings)

    def test_a_malformed_report_is_a_warning(self):
        class Broken:
            @property
            def blocks(self):
                raise ValueError("bad")

        d = self.evaluate(Broken())
        self.assertTrue(d.allowed)
        self.assertIn("video_qc_errored:ValueError", d.warnings)

    def test_qc_that_did_not_run_is_recorded_not_passed(self):
        d = self.evaluate(None)
        self.assertTrue(d.allowed)
        self.assertIn("video_qc_not_run", d.warnings)
        self.assertNotIn("video_qc", d.checks_run)

    def test_no_video_path_means_no_qc_warning(self):
        d = self.evaluate(None, video=False)
        self.assertNotIn("video_qc_not_run", d.warnings)

    def test_the_gate_event_carries_the_measurements_but_no_local_path(self):
        qc = video_qc.QcReport(video_path="/runner/secret/place.mp4",
                               measured={"duration_s": 60.0})
        meta = self.evaluate(qc).to_metadata()
        self.assertEqual(meta["video_qc"]["measured"]["duration_s"], 60.0)
        self.assertNotIn("/runner/secret", json.dumps(meta))

    def test_gate_metadata_shape_is_unchanged_without_qc(self):
        meta = self.evaluate(None).to_metadata()
        self.assertNotIn("video_qc", meta)


class MainWiringTests(unittest.TestCase):
    def test_main_passes_the_qc_report_into_the_gate(self):
        """The gate can only use what main hands it; a refactor that drops the
        argument would silently turn QC back into a report nobody reads."""
        import ast

        tree = ast.parse(Path(__file__).resolve().parents[1].joinpath("main.py").read_text())
        calls = [
            n for n in ast.walk(tree)
            if isinstance(n, ast.Call) and ast.unparse(n.func) == "publish_gate.evaluate"
        ]
        self.assertTrue(calls)
        for call in calls:
            self.assertIn("qc_report", [k.arg for k in call.keywords])


if __name__ == "__main__":
    unittest.main()
