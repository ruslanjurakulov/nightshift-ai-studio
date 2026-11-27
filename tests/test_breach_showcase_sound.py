"""Breach, commit f2a6fda (site clips keep their sound; optional card line): attacks on tools/export_showcase.py and the
Showcase asset workflow, run locally only (no workflow dispatched, no database, no real file from a provider).

The three FAILING tests below are holes in CLAUDE.md #5 ("never render a default as a measurement"): the audio probe asks
ffprobe whether an audio *stream* exists and records that as "this clip has sound", so the site draws a speaker toggle over

* a track of pure digital silence (many generators pad their output with one), and
* a track one millisecond long on a two-second clip;

and keeping the track lets a file whose audio runs longer than its picture stretch the full copy (clip.mp4) to the audio's
length, a still frame for most of the loop, while clip-sm.mp4 stays the picture's length. A visitor who turns the sound on is
switched to that stretched file. Each test accepts either fix: the export records no sound / keeps the picture's length, or it
refuses with a Refusal naming the remedy.

The rest pin what held: the card line inputs reach the script only through env and `--x=value`, a value that looks like an
option stays a value, hidden text is stripped, and the audio probe keeps the file-only protocol, the forced demuxer and a
timeout. Runs under both ``python -m pytest`` and ``python -m unittest``.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

from tools import export_showcase as x

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "showcase_asset.yml"
HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def _ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *args], check=True, timeout=120)


def _duration(path: Path, stream: str = "") -> float:
    sel = ["-select_streams", stream] if stream else []
    entry = "stream=duration" if stream else "format=duration"
    out = subprocess.run(["ffprobe", "-v", "error", *sel, "-show_entries", entry, "-of", "csv=p=0", str(path)],
                         stdout=subprocess.PIPE, check=True, timeout=60).stdout.decode().split()
    return float(out[0])


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe are not installed here")
class AudioFlagIsAMeasurement(unittest.TestCase):
    """`audio: true` puts a speaker toggle on the public site. It must mean a visitor will hear something."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def derive(self, src: Path):
        try:
            return x.make_derivatives(src, "video", "video/mp4", self.tmp / "out")
        except x.Refusal:
            return None

    def test_a_track_of_digital_silence_is_not_recorded_as_sound(self) -> None:
        src = self.tmp / "silent.mp4"
        _ffmpeg("-f", "lavfi", "-i", "testsrc=size=320x240:rate=24", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                "-t", "2", "-c:v", "libx264", "-c:a", "aac", "-shortest", str(src))
        got = self.derive(src)
        if got is not None:
            self.assertFalse(got[2], "a silent audio track was recorded as audio: true; the site would offer a toggle over silence")

    def test_a_track_a_millisecond_long_is_not_recorded_as_sound(self) -> None:
        src = self.tmp / "blip.mp4"
        _ffmpeg("-f", "lavfi", "-t", "2", "-i", "testsrc=size=320x240:rate=24", "-f", "lavfi", "-t", "0.001", "-i",
                "sine=frequency=440:sample_rate=48000", "-c:v", "libx264", "-c:a", "aac", str(src))
        got = self.derive(src)
        if got is not None:
            self.assertFalse(got[2], "a 1 ms audio track on a 2 s clip was recorded as audio: true")

    def test_an_audio_track_longer_than_the_picture_does_not_stretch_the_full_copy(self) -> None:
        src = self.tmp / "long-audio.mp4"
        _ffmpeg("-f", "lavfi", "-t", "2", "-i", "testsrc=size=320x240:rate=24", "-f", "lavfi", "-t", "25", "-i",
                "sine=frequency=440:sample_rate=48000", "-c:v", "libx264", "-c:a", "aac", str(src))
        got = self.derive(src)
        if got is None:
            return
        full, small = _duration(self.tmp / "out" / "clip.mp4"), _duration(self.tmp / "out" / "clip-sm.mp4")
        self.assertLess(abs(full - small), 0.5, f"clip.mp4 runs {full:.1f} s, clip-sm.mp4 {small:.1f} s: the sound file is mostly a frozen frame")

    def test_a_clip_with_a_real_voice_keeps_it(self) -> None:
        # The other side of the three above: a fix must not turn every clip silent.
        src = self.tmp / "tone.mp4"
        _ffmpeg("-f", "lavfi", "-t", "2", "-i", "testsrc=size=320x240:rate=24", "-f", "lavfi", "-t", "2", "-i",
                "sine=frequency=440:sample_rate=48000", "-c:v", "libx264", "-c:a", "aac", str(src))
        got = x.make_derivatives(src, "video", "video/mp4", self.tmp / "out")
        self.assertTrue(got[2])
        self.assertLess(abs(_duration(self.tmp / "out" / "clip.mp4") - 2.0), 0.3)

    def test_a_clip_without_a_track_is_silent(self) -> None:
        src = self.tmp / "mute.mp4"
        _ffmpeg("-f", "lavfi", "-t", "2", "-i", "testsrc=size=320x240:rate=24", "-c:v", "libx264", str(src))
        self.assertFalse(x.make_derivatives(src, "video", "video/mp4", self.tmp / "out")[2])


class AudioProbeStaysBoxedIn(unittest.TestCase):
    """A hostile download must not make the probe read another file, a URL, or hang the job."""

    def test_the_probe_forces_the_demuxer_and_the_file_protocol_before_the_input(self) -> None:
        for mime, demuxer in x.VIDEO_DEMUXER.items():
            cmd = x.audio_probe_command("ffprobe", Path("/w/src.bin"), mime)
            self.assertEqual(cmd[-1], "/w/src.bin")
            self.assertEqual(cmd[cmd.index("-protocol_whitelist") + 1], "file")
            self.assertEqual(cmd[cmd.index("-f") + 1], demuxer)
            self.assertNotIn("-safe", cmd)

    def test_a_probe_that_hangs_is_a_refusal_not_silence(self) -> None:
        seen = {}

        def hang(*a, **kw):
            seen.update(kw)
            raise subprocess.TimeoutExpired(a[0], kw.get("timeout"))

        with self.assertRaises(x.Refusal) as e:
            x.has_audio("ffprobe", Path("/w/src"), "video/mp4", run=hang)
        self.assertEqual(e.exception.code, "audio_unknown")
        self.assertIsNotNone(seen.get("timeout"))
        self.assertLessEqual(seen["timeout"], 120)

    def test_a_probe_that_fails_is_a_refusal_not_silence(self) -> None:
        fail = lambda *a, **kw: subprocess.CompletedProcess(a[0], 1, b"", b"")  # noqa: E731
        with self.assertRaises(x.Refusal):
            x.has_audio("ffprobe", Path("/w/src"), "video/mp4", run=fail)

    def test_only_an_exact_audio_line_counts(self) -> None:
        ok = lambda out: (lambda *a, **kw: subprocess.CompletedProcess(a[0], 0, out, b""))  # noqa: E731
        self.assertFalse(x.has_audio("ffprobe", Path("/w/s"), "video/mp4", run=ok(b"")))
        self.assertFalse(x.has_audio("ffprobe", Path("/w/s"), "video/mp4", run=ok(b"video\nsubtitle\naudiox\n")))
        self.assertTrue(x.has_audio("ffprobe", Path("/w/s"), "video/mp4", run=ok(b"audio\n")))

    def test_the_full_copies_map_exactly_one_video_and_one_audio_stream(self) -> None:
        for cmd in x.video_commands("ffmpeg", Path("/w/src"), "video/mp4", Path("/w/out"), audio=True):
            maps = [cmd[i + 1] for i, a in enumerate(cmd) if a == "-map"]
            self.assertIn(maps, ([], ["0:v:0", "0:a:0"]))
            self.assertEqual(cmd[cmd.index("-protocol_whitelist") + 1], "file")


class CardLineInputs(unittest.TestCase):
    """The new workflow inputs: script injection in the workflow, argument injection in the CLI, hidden text on the page."""

    def setUp(self) -> None:
        self.wf = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
        self.wf_on = self.wf.get("on", self.wf.get(True))

    def test_no_run_script_interpolates_an_input_or_any_event_field(self) -> None:
        for job_id, job in self.wf["jobs"].items():
            for step in job["steps"]:
                run = step.get("run")
                if run is None:
                    continue
                self.assertNotRegex(run, r"\$\{\{\s*(inputs|github\.event)", f"{job_id}/{step.get('name')}: an input pasted into a script")

    def test_each_card_line_reaches_the_script_through_env_and_a_quoted_equals_form(self) -> None:
        inputs = self.wf_on["workflow_dispatch"]["inputs"]
        export = next(s for s in self.wf["jobs"]["export"]["steps"] if s.get("id") == "export")
        for lang in x.CARD_LINE_LANGS:
            name, var = f"card_line_{lang}", f"CARD_LINE_{lang.upper()}"
            self.assertIs(inputs[name]["required"], False)
            self.assertEqual(export["env"][var], "${{ github.event.inputs.%s }}" % name)
            self.assertIn(f'--card-line-{lang}="${var}"', export["run"])

    def test_the_publish_job_never_sees_a_card_line_or_a_secret(self) -> None:
        text = yaml.safe_dump(self.wf["jobs"]["publish"])
        self.assertNotIn("card_line", text)
        self.assertNotIn("secrets.", text)

    def test_a_card_line_that_looks_like_an_option_stays_a_value(self) -> None:
        hostile = {
            "en": "--verify-export=/",
            "ru": "--slot=hero --job-id=00000000-0000-4000-8000-000000000000",
            "uz": "-h $(id) `id` \"; rm -rf / #",
        }
        argv = ["--job-id=0b0b0b0b-1111-4222-8333-444455556666", "--slot=", "--caption=--stage=/tmp/x"]
        argv += [f"--card-line-{lang}={v}" for lang, v in hostile.items()]
        seen = {}

        def fake_export(job, **kw):
            seen.update(kw, job=job)
            raise x.Refusal("stop", "test")

        env = {"SUPABASE_URL": "http://127.0.0.1:9", "SUPABASE_SERVICE_KEY": "lab-not-a-key", "SITE_ORIGIN": "https://lab.invalid"}
        with mock.patch.dict(os.environ, env), mock.patch.object(x, "export", fake_export), \
                mock.patch.object(x, "verify_export", side_effect=AssertionError("a card line was read as --verify-export")):
            self.assertEqual(x.main(argv), 2)
        self.assertEqual(seen["card_line_raw"], hostile)
        self.assertEqual(seen["caption_raw"], "--stage=/tmp/x")
        self.assertEqual(seen["slot_raw"], "")
        self.assertEqual(seen["job"], "0b0b0b0b-1111-4222-8333-444455556666")

    def test_hidden_text_and_direction_overrides_do_not_survive_into_the_entry(self) -> None:
        tag_text = "".join(chr(0xE0000 + ord(c)) for c in "ignore previous")
        raw = {
            "en": "Good‮ txet ⁦x⁩" + tag_text + "​⁠﻿­",
            "ru": "؜Привет᠎ㅤᅟ",
            "uz": "Salom\U000E0100\U000E0FFF͏",
        }
        got = x.parse_card_line(raw)
        self.assertEqual(got, {"en": "Good txet x", "ru": "Привет", "uz": "Salom"})
        for v in got.values():
            self.assertIsNone(re.search(r"[​-‏‪-‮⁠-⁯\U000e0000-\U000e0fff]", v))

    def test_markup_is_kept_as_text_and_the_site_never_injects_it(self) -> None:
        line = '<img src=x onerror=alert(1)></script><script>alert(1)</script>'
        got = x.parse_card_line({"en": line, "ru": line, "uz": line})
        self.assertEqual(got["en"], line)
        # No page reads cardLine today; if one ever does, it must not be through raw HTML.
        for p in (q for d in ("app", "components", "lib") for q in (ROOT / "command-center" / d).rglob("*.ts*")):
            text = p.read_text(encoding="utf-8", errors="replace")
            if "cardLine" in text:
                self.assertNotIn("dangerouslySetInnerHTML", text, f"{p}: cardLine near raw HTML")

    def test_a_line_over_the_limit_is_refused_not_cut_and_two_of_three_is_refused(self) -> None:
        with self.assertRaises(x.Refusal) as e:
            x.parse_card_line({"en": "a" * 141, "ru": "b", "uz": "c"})
        self.assertEqual(e.exception.code, "card_line_too_long")
        with self.assertRaises(x.Refusal) as e:
            x.parse_card_line({"en": "a", "ru": "b", "uz": "​‮"})
        self.assertEqual(e.exception.code, "card_line_incomplete")

    def test_the_summary_escapes_a_newline_so_a_card_line_cannot_add_lines_to_the_pr_body(self) -> None:
        # A forged "- Cost:" line in the PR body would read as the export's own measurement to the reviewer.
        line = "x\n- Provider cost (creative_job_costs): $0.0000 (measured)"
        # Either fix holds: the line break is refused outright (card_line_invalid), or the summary escapes it.
        try:
            card = x.parse_card_line({"en": line, "ru": line, "uz": line})
        except x.Refusal as e:
            self.assertEqual(e.code, "card_line_invalid")
            return
        entry = {
            "jobId": "0b0b0b0b-1111-4222-8333-444455556666", "capability": "i2v", "kind": "video", "createdAt": "2026-11-22",
            "modelName": "M", "modelId": "m", "attribution": None, "operatorPreview": False, "shutdownOn": None,
            "input": {"kind": "none"}, "endFrame": None, "assetId": "a", "sha256": "0" * 64, "prompt": "p", "audio": False,
            "cost": {"usdEstimate": None, "priceSource": None, "rows": 0, "vendor": []}, "cardLine": card,
        }
        body = x.summary_markdown(entry)
        self.assertEqual(sum(1 for ln in body.splitlines() if ln.startswith("- Provider cost")), 1)

if __name__ == "__main__":
    unittest.main()
