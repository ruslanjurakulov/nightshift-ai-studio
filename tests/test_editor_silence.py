"""Silence removal (editor parity 2): the editor finds the quiet parts of a clip's own sound in the
browser (command-center/lib/editorSilence.ts) with ffmpeg's ``silencedetect`` rule, block-wise. This
half holds the detector to ffmpeg itself: samples/silence_cases.json names a set of signals (tone and
near-silence, mono and stereo, thresholds either side of the quiet level) and what the bundled ffmpeg's
``silencedetect`` reports on each; the test makes each signal again with numpy, runs the real ffmpeg,
and compares. command-center/tests/editor-silence.test.ts makes the same signals and holds the
TypeScript detector to the same answers (to within one 10 ms block).

No document field is involved: the cuts are ordinary splits and deletions."""

import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CASES = ROOT / "samples" / "silence_cases.json"


def _ffmpeg():
    try:
        from modules import render_backend
        exe = render_backend.resolve_ffmpeg()
        subprocess.run([exe, "-version"], capture_output=True, check=True)
        return exe
    except Exception:
        return None


def signal(case):
    """The case's samples, interleaved float32 (numpy), exactly as the TypeScript test makes them."""
    import numpy as np
    rate = case["rate"]
    chans = []
    for ch in range(case["channels"]):
        parts = []
        for part in case["parts"]:
            kind, seconds, amp, freq = part[0], part[1], part[2], part[3]
            if isinstance(amp, list):
                amp = amp[ch]
            n = int(round(seconds * rate))
            t = np.arange(n, dtype=np.float64) / rate
            parts.append((amp * np.sin(2 * np.pi * freq * t)).astype(np.float32))
        chans.append(np.concatenate(parts))
    return np.stack(chans, axis=1).reshape(-1)


def ffmpeg_silences(exe, case, threshold_db, min_s):
    with tempfile.TemporaryDirectory() as d:
        raw = Path(d) / "s.f32"
        signal(case).tofile(raw)
        proc = subprocess.run([exe, "-hide_banner", "-nostats", "-f", "f32le", "-ar", str(case["rate"]), "-ac",
                               str(case["channels"]), "-i", str(raw), "-af",
                               f"silencedetect=noise={threshold_db}dB:d={min_s}", "-f", "null", "-"],
                              capture_output=True, text=True)
        assert proc.returncode == 0, proc.stderr[-400:]
    starts = [float(x) for x in re.findall(r"silence_start: (-?[0-9.]+)", proc.stderr)]
    ends = [float(x) for x in re.findall(r"silence_end: ([0-9.]+)", proc.stderr)]
    return [[round(a, 3), round(b, 3)] for a, b in zip(starts, ends)]


class SilenceCasesTestCase(unittest.TestCase):
    def test_the_cases_are_what_the_real_ffmpeg_reports(self):
        exe = _ffmpeg()
        if not exe:
            self.skipTest("ffmpeg not available")
        cases = json.loads(CASES.read_text(encoding="utf-8"))["cases"]
        self.assertGreaterEqual(len(cases), 6)
        for case in cases:
            for probe in case["probes"]:
                with self.subTest(case=case["name"], probe=probe):
                    got = ffmpeg_silences(exe, case, probe["threshold_db"], probe["min_s"])
                    self.assertEqual(len(got), len(probe["silences"]), got)
                    for (a, b), (x, y) in zip(got, probe["silences"]):
                        self.assertAlmostEqual(a, x, delta=0.002)
                        self.assertAlmostEqual(b, y, delta=0.002)

    def test_every_case_has_a_silence_and_a_probe_that_finds_none(self):
        cases = json.loads(CASES.read_text(encoding="utf-8"))["cases"]
        self.assertTrue(any(p["silences"] for c in cases for p in c["probes"]))
        self.assertTrue(any(not p["silences"] for c in cases for p in c["probes"]))


if __name__ == "__main__":
    unittest.main()
