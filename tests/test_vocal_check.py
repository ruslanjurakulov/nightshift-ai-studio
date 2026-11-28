"""S6: the approved Lyria vocal rule, the chunked separation, the music-check client and service, and the wiring into the adapter
and the creative worker (modules/vocal_check.py, tools/music_check_server.py). Offline: the models are stubbed (a real-model test
runs only where torch and the pinned weights are present), the service is a loopback HTTP server, Google is tests/loopback_vendor.

What would break without these tests:

* a sung song accepted because the thresholds drifted from the five measured samples (docs/MEASUREMENT.md section 10), or because
  one detector's absent number read as "no vocals";
* a vocal sitting on a 30 s seam lost between two windows of the chunked UMX, or chunking changing the numbers;
* a music check that timed out, answered 500, garbage, half the numbers, or was down, and the song delivered anyway;
* a Lyria song paid for while no music check is configured, reachable or has memory;
* a refused song CAPTURED and refunded later: it must end through the worker's failure path (finish ok=false), which releases the
  whole hold, and never through finish ok=true;
* two songs measured at once in a service sized for one, or a check started with less than 1.5 GB free;
* the per-song child process failing quietly, or its failure read as numbers.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import model_registry as reg
from modules import vocal_check as vc
from modules.capabilities import build_adapter
from modules.capabilities.base import E_BAD_RESPONSE, E_NOT_CONFIGURED, E_UNAVAILABLE, MUSIC, AdapterError, CapabilityRequest
from modules.capabilities.safe_fetch import AFTER_COMPLETION
from tests.loopback_vendor import FakeVendor, Resp, cleanup_certificate
from tests.music_check_fakes import INSTRUMENTAL, FakeMusicCheck, with_check
from tests.test_creative_worker import FakeCredits, FakeQueue
from tools import music_check_server as srv
from tools import vocal_activity as va

ROOT = Path(__file__).resolve().parent.parent
KEY = "AIzaSy-test-NOT-A-REAL-KEY-0123456789abcdef"
LYRIA, VENDOR, POST = "google-lyria-3.5", "lyria-3.5", "/v1beta/interactions"
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 4096
RATE = va.UMX_RATE

#: docs/MEASUREMENT.md section 10, run 46132895972: (UMX share above -10 dB, PANNs voice max), copied from the results table.
MEASURED = {"P1": (0.849, 0.245), "P2": (0.661, 0.351), "P3": (0.694, 0.201), "N1": (0.000, 0.032), "N2": (0.054, 0.039)}


def tearDownModule():
    cleanup_certificate()


# ── the rule ──────────────────────────────────────────────────────────────────────

class RuleTests(unittest.TestCase):
    def test_every_measured_positive_is_refused_and_both_negatives_accepted(self):
        for name, (umx, panns) in MEASURED.items():
            with self.subTest(name):
                self.assertEqual(vc.refused_as_sung(False, vc.Signals(umx, panns)), name.startswith("P"))

    def test_each_signal_alone_separates_the_five_samples(self):
        # The rule keeps both as independent signals: either one going missing must not be what lets a sung song through.
        for name, (umx, panns) in MEASURED.items():
            with self.subTest(name):
                self.assertEqual(umx >= vc.UMX_SHARE_REFUSED_AT, name.startswith("P"))
                self.assertEqual(panns >= vc.PANNS_VOICE_MAX_REFUSED_AT, name.startswith("P"))

    def test_the_thresholds_are_the_approved_ones(self):
        self.assertEqual((vc.UMX_STEP_DB, vc.UMX_SHARE_REFUSED_AT, vc.PANNS_VOICE_MAX_REFUSED_AT, vc.MEASURED_IN_RUN),
                         (-10.0, 0.30, 0.10, "46132895972"))
        self.assertIn(vc.UMX_STEP_DB, va.THRESHOLDS_DB)

    def test_at_the_threshold_is_refused(self):
        self.assertTrue(vc.sung_by(vc.Signals(0.30, 0.0)))
        self.assertTrue(vc.sung_by(vc.Signals(0.0, 0.10)))
        self.assertFalse(vc.sung_by(vc.Signals(0.2999, 0.0999)))

    def test_the_text_check_still_refuses_on_its_own_and_no_numbers_is_never_a_pass(self):
        self.assertTrue(vc.refused_as_sung(True, None))
        self.assertTrue(vc.refused_as_sung(True, INSTRUMENTAL))
        with self.assertRaises(vc.CheckDidNotRun):
            vc.refused_as_sung(False, None)

    def test_an_absent_or_odd_number_is_a_check_that_did_not_run(self):
        good = {vc.UMX_FIELD: 0.0, vc.PANNS_FIELD: 0.03}
        self.assertEqual(vc.parse_signals(good), vc.Signals(0.0, 0.03))
        for bad in ({}, {vc.UMX_FIELD: 0.0}, {vc.PANNS_FIELD: 0.0}, {**good, vc.UMX_FIELD: None}, {**good, vc.UMX_FIELD: "0"},
                    {**good, vc.PANNS_FIELD: True}, {**good, vc.PANNS_FIELD: float("nan")}, {**good, vc.UMX_FIELD: 1.5},
                    {**good, vc.UMX_FIELD: -0.1}, [0.0, 0.0], "ok", None):
            with self.subTest(bad=bad), self.assertRaises(vc.CheckDidNotRun):
                vc.parse_signals(bad)

    def test_a_song_of_pure_silence_has_no_share_and_did_not_run(self):
        silent = {"umx_vocal_to_mix": va.ratio_summary([], 120), "panns": {"voice_max": 0.0}}
        with self.assertRaises(vc.CheckDidNotRun):
            vc.signals_from_measurement(silent)


# ── chunked separation ────────────────────────────────────────────────────────────

def _band(x: np.ndarray, lo: float, hi: float) -> np.ndarray:
    spec = np.fft.rfft(x, axis=-1)
    f = np.fft.rfftfreq(x.shape[-1], 1 / RATE)
    spec[..., (f < lo) | (f > hi)] = 0
    return np.fft.irfft(spec, n=x.shape[-1], axis=-1)


def _edge_blind(sep, edge_s: float):
    """A separator that is blind for ``edge_s`` at both ends of whatever it is given: what a model with no context beyond a window
    edge does at worst."""
    def run(m):
        out = np.array(sep(m), dtype=np.float64)
        k = int(edge_s * RATE)
        out[:, :k] = 0
        out[:, -k:] = 0
        return out
    return run


def _song(seconds: float, vocal=(27.0, 33.0)) -> np.ndarray:
    t = np.arange(int(seconds * RATE)) / RATE
    bed = 0.2 * np.sin(2 * np.pi * 110 * t)                                  # the "band": low
    voice = 0.2 * np.sin(2 * np.pi * 700 * t) * ((t >= vocal[0]) & (t < vocal[1]))   # the "voice": mid, only around the seam
    y = bed + voice
    return np.stack([y, y]).astype(np.float32)


class ChunkedTests(unittest.TestCase):
    def test_the_windows_cover_the_song_and_the_last_one_holds_its_fade(self):
        size, ov = 30 * RATE, 5 * RATE
        for seconds in (1, 30, 30.5, 31, 55, 56, 179.9, 180, 600):
            n = int(seconds * RATE)
            starts = vc.window_starts(n, size, ov)
            with self.subTest(seconds=seconds):
                self.assertEqual(starts[0], 0)
                self.assertGreaterEqual(starts[-1] + size, n)
                for a, b in zip(starts, starts[1:]):
                    self.assertEqual(b - a, size - ov)
                if len(starts) > 1:
                    self.assertGreater(n - starts[-1], ov)

    def test_the_crossfade_weights_add_to_one_everywhere(self):
        n = int(97.3 * RATE)
        ones = np.ones((2, n), dtype=np.float32)
        out = vc.chunked_separate(lambda m: m, ones, RATE)
        self.assertTrue(np.allclose(out, 1.0, atol=1e-6))

    def test_chunked_equals_whole_track_for_a_separator_without_edges(self):
        # A frequency mask on each window is (nearly) local: chunked and whole must agree, to the per-second ratio.
        sep = lambda m: _band(m, 400, 2000)  # noqa: E731
        for seconds in (20.0, 61.0, 180.0):
            mix = _song(seconds, vocal=(10.0, seconds - 5))
            with self.subTest(seconds=seconds):
                whole, chunked = sep(mix), vc.chunked_separate(sep, mix, RATE)
                rw, _ = va.per_second_ratio_db(mix, whole, RATE)
                rc, _ = va.per_second_ratio_db(mix, chunked, RATE)
                self.assertEqual(len(rw), len(rc))
                self.assertLess(max(abs(a - b) for a, b in zip(rw, rc) if a > -60), 0.5)
                sw, sc = va.ratio_summary(rw, 0), va.ratio_summary(rc, 0)
                self.assertAlmostEqual(sw["thresholds"]["-10"]["share_above"], sc["thresholds"]["-10"]["share_above"], places=2)

    def test_a_vocal_exactly_on_the_seam_is_still_caught(self):
        # The first window ends at 30 s: the voice runs 27 to 33 s, across it. The separator is blind for 1.5 s at every window edge.
        mix = _song(60.0)
        sep = _edge_blind(lambda m: _band(m, 400, 2000), 1.5)
        stem = vc.chunked_separate(sep, mix, RATE)
        ratios, _ = va.per_second_ratio_db(mix, stem, RATE)
        for second in range(27, 33):
            self.assertGreater(ratios[second], vc.UMX_STEP_DB, f"second {second}")
        # ...where windows cut back to back, with no overlap, would lose it around the seam (the reason for the overlap).
        cut = np.concatenate([sep(mix[:, :30 * RATE]), sep(mix[:, 30 * RATE:])], axis=1)
        lost, _ = va.per_second_ratio_db(mix, cut, RATE)
        self.assertTrue(any(lost[s] <= vc.UMX_STEP_DB for s in (28, 29, 30, 31)))

    def test_linear_not_equal_power_so_a_seam_is_not_louder(self):
        # Two windows' estimates of the same signal, faded: the stitched stem equals the stem (an equal-power fade would lift it).
        mix = _song(70.0, vocal=(0.0, 70.0))
        stem = vc.chunked_separate(lambda m: m * 0.5, mix, RATE)
        self.assertTrue(np.allclose(stem, mix * 0.5, atol=1e-6))

    def test_a_bad_window_fails_the_whole_song(self):
        mix = _song(70.0)
        calls = []

        def sep(m):
            calls.append(m.shape[1])
            out = m.copy()
            if len(calls) == 2:
                out[0, 0] = np.nan
            return out
        with self.assertRaises(vc.CheckDidNotRun):
            vc.chunked_separate(sep, mix, RATE)
        with self.assertRaises(vc.CheckDidNotRun):
            vc.chunked_separate(lambda m: m[:, :-1], mix, RATE)

    def test_the_server_measures_through_the_tool_with_chunked_umx(self):
        # tools/vocal_activity's own measure() and detectors; chunked UMX; numbers only.
        from tests.test_vocal_activity import Stub, decoder_for

        seen = []

        class Counting(Stub):
            def separate_vocals(self, m):
                seen.append(m.shape[1])
                return super().separate_vocals(m)

        out = srv.measure_file(Path("/nonexistent.mp3"), detectors=Counting(gain=1.0), decoder=decoder_for(_song(70.0)))
        self.assertEqual(seen, [30 * RATE, 30 * RATE, 20 * RATE])
        self.assertEqual(out[vc.UMX_FIELD], 1.0)
        self.assertEqual(out[vc.PANNS_FIELD], 0.8)
        self.assertEqual(set(out), {vc.UMX_FIELD, vc.PANNS_FIELD, "duration_s", "peak_rss_mb", "timing_s"})


def _real_models_here() -> bool:
    cache = os.environ.get("VOCAL_MEASURE_CACHE")
    if not cache or not (Path(cache) / va.UMX_VOCALS.name).is_file():
        return False
    try:
        import openunmix  # noqa: F401
        import torch  # noqa: F401
    except Exception:
        return False
    return True


@unittest.skipUnless(_real_models_here(), "needs torch, openunmix and the pinned weights (VOCAL_MEASURE_CACHE)")
class RealModelTests(unittest.TestCase):
    """The same two properties with the real UMX-HQ vocals model: a voice-like signal on the 30 s seam, and chunked against whole."""

    @classmethod
    def setUpClass(cls):
        cls.det = va.load_detectors(silero=False)

    def test_a_voice_on_the_seam_reads_the_same_chunked_and_whole(self):
        bed = va.synth("tone", 60.0) * 0.3
        voice = va.synth("voicelike", 60.0)
        t = np.arange(bed.shape[1]) / RATE
        mix = (bed + voice * ((t >= 26.0) & (t < 34.0))).astype(np.float32)
        whole = self.det.separate_vocals(mix)
        chunked = vc.chunked_separate(self.det.separate_vocals, mix, RATE)
        rw, _ = va.per_second_ratio_db(mix, whole, RATE)
        rc, _ = va.per_second_ratio_db(mix, chunked, RATE)
        for second in range(26, 34):
            self.assertGreater(rc[second], vc.UMX_STEP_DB, f"second {second}: {rc[second]:.1f} dB")
            self.assertLess(abs(rc[second] - rw[second]), 3.0, f"second {second}")
        sw = va.ratio_summary(rw, 0)["thresholds"]["-10"]["share_above"]
        sc = va.ratio_summary(rc, 0)["thresholds"]["-10"]["share_above"]
        self.assertLess(abs(sw - sc), 0.05)


# ── the client, against a loopback service ────────────────────────────────────────

class Script:
    """What the fake service answers, one entry per request: (status, body bytes or a dict, delay seconds)."""

    def __init__(self, answers):
        self.answers = list(answers)
        self.requests = []


def serve(script: Script):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _answer(self):
            n = int(self.headers.get("Content-Length") or 0)
            script.requests.append((self.command, self.path, self.rfile.read(n) if n else b""))
            status, body, delay = script.answers.pop(0) if script.answers else (500, b"", 0)
            if delay:
                time.sleep(delay)
            data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
            try:
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except OSError:
                pass

        do_GET = do_POST = _answer

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


NUMBERS = {vc.UMX_FIELD: 0.0, vc.PANNS_FIELD: 0.032, "duration_s": 180.0}


class ClientTests(unittest.TestCase):
    def client(self, answers, **kw):
        self.script = Script(answers)
        httpd, url = serve(self.script)
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        kw.setdefault("timeout_s", 5.0)
        return vc.MusicCheckClient(url, sleep=lambda s: None, **kw)

    def test_the_two_numbers_come_back_and_the_song_was_sent_as_is(self):
        c = self.client([(200, NUMBERS, 0)])
        self.assertEqual(c.measure(MP3), vc.Signals(0.0, 0.032))
        (method, path, body), = self.script.requests
        self.assertEqual((method, path, body), ("POST", "/check", MP3))

    def test_every_failure_is_a_check_that_did_not_run(self):
        cases = {
            "non-200": [(500, {"code": "check_failed"}, 0)],
            "memory": [(503, {"code": "insufficient_memory", "remedy": srv.LOW_MEMORY_REMEDY}, 0)],
            "malformed": [(200, b"<html>not json</html>", 0)],
            "missing field": [(200, {vc.UMX_FIELD: 0.0}, 0)],
            "null field": [(200, {vc.UMX_FIELD: 0.0, vc.PANNS_FIELD: None}, 0)],
            "a redirect": [(302, b"", 0)],
        }
        for name, answers in cases.items():
            with self.subTest(name), self.assertRaises(vc.CheckDidNotRun):
                self.client(answers).measure(MP3)

    def test_the_memory_refusal_names_its_remedy(self):
        with self.assertRaises(vc.CheckDidNotRun) as cm:
            self.client([(503, {"code": "insufficient_memory", "remedy": srv.LOW_MEMORY_REMEDY}, 0)]).measure(MP3)
        self.assertIn("1.5 GB free", str(cm.exception))

    def test_a_check_slower_than_the_timeout_did_not_run(self):
        c = self.client([(200, NUMBERS, 2.0)], timeout_s=0.5)
        t = time.monotonic()
        with self.assertRaises(vc.CheckDidNotRun) as cm:
            c.measure(MP3)
        self.assertLess(time.monotonic() - t, 1.8)
        self.assertIn("did not answer within", str(cm.exception))

    def test_a_service_that_is_down_did_not_run(self):
        httpd, url = serve(Script([]))
        httpd.shutdown()
        httpd.server_close()
        with self.assertRaises(vc.CheckDidNotRun):
            vc.MusicCheckClient(url, timeout_s=2.0).measure(MP3)
        with self.assertRaises(vc.MusicCheckNotReady):
            vc.MusicCheckClient(url, timeout_s=2.0).ready()

    def test_busy_is_asked_again_within_the_timeout_and_never_after_it(self):
        busy = (503, {"code": "busy"}, 0)
        self.assertEqual(self.client([busy, busy, (200, NUMBERS, 0)]).measure(MP3), vc.Signals(0.0, 0.032))
        self.assertEqual(len(self.script.requests), 3)
        ticks = iter([0.0, 0.0, 10.0, 10.0, 99.0, 99.0])
        c = self.client([busy] * 10, timeout_s=30.0, clock=lambda: next(ticks))
        with self.assertRaises(vc.CheckDidNotRun):
            c.measure(MP3)
        self.assertEqual(len(self.script.requests), 2)

    def test_ready_reads_the_service_and_names_the_remedy(self):
        self.client([(200, {"ready": True, "busy": True}, 0)]).ready()
        with self.assertRaises(vc.MusicCheckNotReady) as cm:
            self.client([(503, {"ready": False, "code": "insufficient_memory", "remedy": srv.LOW_MEMORY_REMEDY}, 0)]).ready()
        self.assertIn("1.5 GB free", str(cm.exception))
        for answer in ((200, {"ready": "yes"}, 0), (200, b"ok", 0), (500, b"", 0)):
            with self.subTest(answer=answer), self.assertRaises(vc.MusicCheckNotReady):
                self.client([answer]).ready()

    def test_the_env(self):
        self.assertIsNone(vc.MusicCheckClient.from_env({}))
        c = vc.MusicCheckClient.from_env({vc.URL_ENV: "http://music-check:8765/"})
        self.assertEqual((c.url, c.timeout_s), ("http://music-check:8765", vc.DEFAULT_TIMEOUT_S))
        self.assertGreaterEqual(vc.DEFAULT_TIMEOUT_S, 4 * 180)
        self.assertEqual(vc.MusicCheckClient.from_env({vc.URL_ENV: "http://x:1", vc.TIMEOUT_ENV: "120"}).timeout_s, 120.0)
        for bad in ({vc.URL_ENV: "ftp://x"}, {vc.URL_ENV: "http://u:p@x:1"}, {vc.URL_ENV: "http://x:1/?a=1"},
                    {vc.URL_ENV: "http://x:1", vc.TIMEOUT_ENV: "soon"}, {vc.URL_ENV: "http://x:1", vc.TIMEOUT_ENV: "1"},
                    {vc.URL_ENV: "http://x:1", vc.TIMEOUT_ENV: "nan"}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                vc.MusicCheckClient.from_env(bad)


# ── the adapter ───────────────────────────────────────────────────────────────────

def _answer(text="[Instrumental]") -> dict:
    return {"id": "v1_lyria-1", "status": "completed", "model": VENDOR,
            "steps": [{"type": "model_output", "content": [{"type": "text", "text": text},
                                                           {"type": "audio", "mime_type": "audio/mpeg",
                                                            "data": base64.b64encode(MP3).decode()}]}]}


def music(**kw) -> CapabilityRequest:
    return CapabilityRequest(**{**dict(capability=MUSIC, prompt="a calm solo piano piece"), **kw})


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.vendor = FakeVendor()
        self.addCleanup(self.vendor.close)
        self.env = {"GEMINI_API_KEY": KEY, "GEMINI_BASE_URL": self.vendor.base_url + "/v1beta"}

    def lyria(self, check=None, env=None):
        a = build_adapter("audio.google_lyria", env=env or self.env, session=self.vendor.session())
        return with_check(a, check) if check is not False else a

    def test_an_instrumental_song_is_measured_and_delivered(self):
        self.vendor.on("POST", POST, Resp(200, _answer()))
        check = FakeMusicCheck()
        (out,) = self.lyria(check).submit(music(), VENDOR).outputs
        self.assertEqual(out.data, MP3)
        self.assertEqual(check.sent, [MP3])

    def test_a_song_the_audio_calls_sung_is_refused_after_completion_and_never_moved(self):
        for name, (umx, panns) in MEASURED.items():
            if not name.startswith("P"):
                continue
            with self.subTest(name):
                self.vendor.on("POST", POST, Resp(200, _answer()))
                with self.assertRaises(AdapterError) as cm:
                    self.lyria(FakeMusicCheck(vc.Signals(umx, panns))).submit(music(), VENDOR)
                e = cm.exception
                self.assertEqual(e.code, E_BAD_RESPONSE)
                self.assertTrue(e.message.startswith(AFTER_COMPLETION))
                self.assertIn("heard singing", e.message)
                self.assertFalse(e.not_accepted)

    def test_a_check_that_did_not_run_refuses_with_its_own_code(self):
        for err in (vc.CheckDidNotRun("the music check answered HTTP 500"), RuntimeError("client bug")):
            with self.subTest(err=type(err).__name__):
                self.vendor.on("POST", POST, Resp(200, _answer()))
                with self.assertRaises(AdapterError) as cm:
                    self.lyria(FakeMusicCheck(error=err)).submit(music(), VENDOR)
                e = cm.exception
                self.assertEqual(e.code, vc.CHECK_DID_NOT_RUN)
                self.assertTrue(e.message.startswith(AFTER_COMPLETION))
                self.assertFalse(e.not_accepted)
                self.assertFalse(e.retryable)

    def test_no_url_refuses_before_anything_is_sent(self):
        a = self.lyria(check=False)
        with self.assertRaises(AdapterError) as cm:
            a.submit(music(), VENDOR)
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertTrue(cm.exception.not_accepted)
        self.assertIn(vc.URL_ENV, cm.exception.message)
        self.assertEqual(self.vendor.seen("POST", POST), [])
        with self.assertRaises(AdapterError) as cm:
            a.ready(music())
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)

    def test_ready_refuses_an_unreachable_or_short_service_before_anything_is_sent(self):
        with self.assertRaises(AdapterError) as cm:
            self.lyria(FakeMusicCheck(not_ready=srv.LOW_MEMORY_REMEDY)).ready(music())
        self.assertEqual((cm.exception.code, cm.exception.not_accepted), (E_UNAVAILABLE, True))
        self.assertIn("1.5 GB free", cm.exception.message)
        self.lyria(FakeMusicCheck()).ready(music())

    def test_the_text_check_still_runs_first(self):
        self.vendor.on("POST", POST, Resp(200, _answer(text="[Verse]\nHello my love, sing with me")))
        check = FakeMusicCheck()
        with self.assertRaises(AdapterError) as cm:
            self.lyria(check).submit(music(), VENDOR)
        self.assertIn("returned singing", cm.exception.message)
        self.assertEqual(check.sent, [])

    def test_the_adapter_does_not_load_the_detectors(self):
        import ast

        for f in (ROOT / "modules" / "vocal_check.py", ROOT / "modules" / "capabilities" / "google_interactions.py"):
            names = set()
            for node in ast.walk(ast.parse(f.read_text(encoding="utf-8"))):
                if isinstance(node, ast.Import):
                    names |= {a.name for a in node.names}
                elif isinstance(node, ast.ImportFrom):
                    names.add(node.module or "")
            for heavy in ("torch", "openunmix", "tools.vocal_activity", "tools.vendor_panns"):
                self.assertFalse(any(n == heavy or n.startswith(heavy + ".") for n in names), f"{f.name} imports {heavy}")


# ── the worker: money ─────────────────────────────────────────────────────────────

JOB = "0f0e0d0c-0b0a-4000-8000-0000000000a6"
ORG = "11111111-2222-3333-4444-555555555555"


def music_job(**over):
    j = {"id": JOB, "org_id": ORG, "capability": "music", "mode": "exact", "payer": "credits",
         "requested_model": LYRIA, "routed_model": LYRIA, "params": {"prompt": "a calm solo piano piece"},
         "status": "running", "provider_task_id": None, "credit_ref": f"cj:{JOB}", "quoted_credits": 6}
    j.update(over)
    return j


class WorkerMoneyTests(unittest.TestCase):
    """S2's constraint: a refused song ends through finish(ok=false) (0126's finish_creative_job, whose failure branch is
    creative_end_locked -> release of the whole hold), never through finish(ok=true), which captures."""

    def setUp(self):
        self.vendor = FakeVendor()
        self.addCleanup(self.vendor.close)
        self.env = {"GEMINI_API_KEY": KEY, "GEMINI_BASE_URL": self.vendor.base_url + "/v1beta"}
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def run_job(self, check):
        adapter = build_adapter("audio.google_lyria", env=self.env, session=self.vendor.session())
        if check is not None:
            with_check(adapter, check)
        ra = ca.RegistryAdapter(reg.load()[LYRIA], adapter, sync_store={})
        q = FakeQueue(music_job())
        w = cw.CreativeWorker(q, lambda m: ra if m == LYRIA else None, worker_id="w1", out_dir=self.tmp,
                              credits=FakeCredits(), enforce=True, sleep=lambda s: None, heartbeat_seconds=0)
        self.assertTrue(w.run_once())
        return q

    def settlements(self, q):
        return [c for c in q.calls if c[0] == "finish"]

    def test_a_sung_song_ends_failed_and_is_never_captured(self):
        self.vendor.on("POST", POST, Resp(200, _answer()))
        q = self.run_job(FakeMusicCheck(vc.Signals(*MEASURED["P2"])))
        self.assertEqual(self.settlements(q), [("finish", False, "bad_response")])
        self.assertIsNone(q.finished["charge"])
        self.assertIn("heard singing", q.finished["error"])
        self.assertEqual(len(self.vendor.seen("POST", POST)), 1)          # one song made, no second model asked
        self.assertNotIn(("advance", "processing", None), q.calls)       # nothing was stored as a result

    def test_a_check_that_did_not_run_ends_failed_and_is_never_captured(self):
        self.vendor.on("POST", POST, Resp(200, _answer()))
        q = self.run_job(FakeMusicCheck(error=vc.CheckDidNotRun("the music check did not answer within 900 s")))
        self.assertEqual(self.settlements(q), [("finish", False, vc.CHECK_DID_NOT_RUN)])
        self.assertIsNone(q.finished["charge"])

    def test_an_instrumental_song_is_the_only_one_that_reaches_finish_ok(self):
        self.vendor.on("POST", POST, Resp(200, _answer()))
        q = self.run_job(FakeMusicCheck())
        self.assertEqual(self.settlements(q), [("finish", True, None)])

    def test_no_url_ends_the_job_before_submitting_and_google_is_never_asked(self):
        self.vendor.on("POST", POST, Resp(200, _answer()))
        q = self.run_job(None)
        self.assertEqual(self.settlements(q), [("finish", False, E_NOT_CONFIGURED)])
        self.assertNotIn(("advance", "submitting", None), q.calls)
        self.assertEqual(self.vendor.seen("POST", POST), [])
        self.assertIn(vc.URL_ENV, q.finished["error"])

    def test_a_service_short_of_memory_ends_the_job_before_submitting(self):
        self.vendor.on("POST", POST, Resp(200, _answer()))
        q = self.run_job(FakeMusicCheck(not_ready=srv.LOW_MEMORY_REMEDY))
        self.assertEqual(self.settlements(q), [("finish", False, E_UNAVAILABLE)])
        self.assertNotIn(("advance", "submitting", None), q.calls)
        self.assertEqual(self.vendor.seen("POST", POST), [])
        self.assertIn("1.5 GB free", q.finished["error"])


# ── the service ───────────────────────────────────────────────────────────────────

class ServiceTests(unittest.TestCase):
    def test_the_lock_serialises_two_checks(self):
        gate, started = threading.Event(), threading.Event()
        live, peak = [0], [0]

        def run(path):
            live[0] += 1
            peak[0] = max(peak[0], live[0])
            started.set()
            gate.wait(5)
            live[0] -= 1
            return dict(NUMBERS)

        checker = srv.Checker(run=run, memory=lambda: None)
        first = threading.Thread(target=checker.check, args=(MP3,))
        first.start()
        self.assertTrue(started.wait(5))
        with self.assertRaises(srv.Refused) as cm:
            checker.check(MP3)
        self.assertEqual((cm.exception.status, cm.exception.code), (503, "busy"))
        self.assertIsNone(checker.ready())          # busy is ready: the next song waits its turn
        gate.set()
        first.join(5)
        self.assertEqual(checker.check(MP3), NUMBERS)
        self.assertEqual(peak[0], 1)

    def test_two_clients_at_once_over_http_both_get_numbers_one_at_a_time(self):
        live, peak = [0], [0]
        lock = threading.Lock()

        def run(path):
            with lock:
                live[0] += 1
                peak[0] = max(peak[0], live[0])
            time.sleep(0.3)
            with lock:
                live[0] -= 1
            return dict(NUMBERS)

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.make_handler(srv.Checker(run=run, memory=lambda: None)))
        httpd.daemon_threads = True
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        url = f"http://127.0.0.1:{httpd.server_address[1]}"
        results = []

        def one():
            results.append(vc.MusicCheckClient(url, timeout_s=10.0, sleep=lambda s: time.sleep(0.05)).measure(MP3))

        threads = [threading.Thread(target=one) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        self.assertEqual(results, [vc.Signals(0.0, 0.032)] * 2)
        self.assertEqual(peak[0], 1)

    def test_input_is_bounded_and_sniffed(self):
        checker = srv.Checker(run=lambda p: self.fail("measured"), memory=lambda: None)
        for body, code in ((b"", "empty"), (b"<html>" + b"x" * 64, "not_audio"), (b"\x89PNG" + b"x" * 64, "not_audio"),
                           (b"ID3" + b"x" * (srv.MAX_BYTES), "too_large")):
            with self.subTest(code=code), self.assertRaises(srv.Refused) as cm:
                checker.check(body)
            self.assertEqual(cm.exception.code, code)
        self.assertEqual(srv.sniff(b"RIFF\x00\x00\x00\x00WAVEfmt "), ".wav")
        self.assertEqual(srv.sniff(MP3[:16]), ".mp3")
        self.assertEqual(srv.sniff(b"\xff\xfb\x90\x64"), ".mp3")

    def test_an_oversized_body_is_refused_without_being_read(self):
        import http.client

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.make_handler(srv.Checker(run=lambda p: {}, memory=lambda: None)))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)
        conn.putrequest("POST", "/check")
        conn.putheader("Content-Length", str(srv.MAX_BYTES + 1))
        conn.endheaders()
        r = conn.getresponse()
        self.assertEqual((r.status, json.loads(r.read())["code"]), (413, "too_large"))

    def test_the_memory_precheck_refuses_under_one_and_a_half_gigabytes(self):
        checker = srv.Checker(run=lambda p: self.fail("measured"),
                              memory=lambda: srv.memory_refusal(lambda: srv.MIN_FREE_BYTES - 1))
        with self.assertRaises(srv.Refused) as cm:
            checker.check(MP3)
        self.assertEqual((cm.exception.status, cm.exception.code, cm.exception.remedy),
                         (503, "insufficient_memory", "the music check needs 1.5 GB free on the worker"))
        self.assertIsNotNone(checker.ready())
        self.assertIsNone(srv.memory_refusal(lambda: srv.MIN_FREE_BYTES))
        self.assertEqual(srv.memory_refusal(lambda: None).code, "insufficient_memory")   # unreadable is not "enough"

    def test_the_bind_address_must_be_internal(self):
        for ok in ("127.0.0.1", "::1", "10.1.2.3", "172.18.0.4", "192.168.1.9", "localhost"):
            self.assertEqual(srv.internal_bind(ok), ok)
        for bad in ("0.0.0.0", "::", "8.8.8.8", "169.254.1.1"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                srv.internal_bind(bad)


GIB = 1 << 30


class CgroupTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))
        self.meminfo = self.root / "meminfo"
        self.meminfo.write_text(f"MemTotal: {16 * GIB // 1024} kB\nMemAvailable: {12 * GIB // 1024} kB\n")

    def write(self, rel, text):
        p = self.root / "cg" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def free(self):
        return srv.free_memory_bytes(self.root / "cg", self.meminfo)

    def test_v2_is_max_minus_current_less_inactive_cache(self):
        self.write("memory.max", str(2 * GIB))
        self.write("memory.current", str(GIB))
        self.write("memory.stat", "anon 1\ninactive_file 0\n")
        self.assertEqual(self.free(), GIB)
        self.assertIsNotNone(srv.memory_refusal(self.free))
        self.write("memory.stat", f"anon 1\ninactive_file {GIB // 2}\n")
        self.assertEqual(self.free(), GIB + GIB // 2)
        self.assertIsNone(srv.memory_refusal(self.free))

    def test_v2_without_a_limit_is_the_hosts_available_memory(self):
        self.write("memory.max", "max\n")
        self.write("memory.current", str(GIB))
        self.assertEqual(self.free(), 12 * GIB)

    def test_v1_fallback(self):
        self.write("memory/memory.limit_in_bytes", str(3 * GIB))
        self.write("memory/memory.usage_in_bytes", str(2 * GIB))
        self.write("memory/memory.stat", "cache 5\ntotal_inactive_file 0\n")
        self.assertEqual(self.free(), GIB)
        self.assertIsNotNone(srv.memory_refusal(self.free))
        self.write("memory/memory.limit_in_bytes", "9223372036854771712")
        self.assertEqual(self.free(), 12 * GIB)

    def test_the_host_caps_a_generous_cgroup(self):
        self.meminfo.write_text(f"MemAvailable: {GIB // 1024} kB\n")
        self.write("memory.max", str(8 * GIB))
        self.write("memory.current", "0")
        self.assertEqual(self.free(), GIB)

    def test_an_unreadable_cgroup_is_refused(self):
        self.write("memory.max", "garbage")
        self.write("memory.current", str(GIB))
        self.assertIsNone(self.free())
        self.assertIsNotNone(srv.memory_refusal(self.free))


class ChildTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.song = self.tmp / "song.mp3"
        self.song.write_bytes(MP3)

    def run_with(self, code, timeout_s=20.0):
        return srv.run_child(self.song, timeout_s=timeout_s, command=lambda p: [sys.executable, "-c", code, str(p)])

    def test_the_child_returns_numbers(self):
        out = self.run_with(f"import json; print(json.dumps({json.dumps(NUMBERS)}))")
        self.assertEqual(vc.parse_signals(out), vc.Signals(0.0, 0.032))

    def test_a_failing_child_is_a_failure_with_its_reason(self):
        code = ("import json, sys; print(json.dumps({'error': 'MeasurementError', 'detail': 'PANNs Cnn14 did not load'}), "
                "file=sys.stderr); sys.exit(1)")
        with self.assertRaises(srv.Refused) as cm:
            self.run_with(code)
        self.assertEqual(cm.exception.code, "check_failed")
        self.assertIn("PANNs Cnn14 did not load", cm.exception.remedy)

    def test_a_child_that_answers_half_the_numbers_or_hangs_is_a_failure(self):
        with self.assertRaises(srv.Refused):
            self.run_with(f"import json; print(json.dumps({{'{vc.UMX_FIELD}': 0.0}}))")
        with self.assertRaises(srv.Refused):
            self.run_with("print('hello')")
        with self.assertRaises(srv.Refused) as cm:
            self.run_with("import time; time.sleep(30)", timeout_s=0.5)
        self.assertIn("did not finish", cm.exception.remedy)

    def test_the_real_child_entrypoint_propagates_a_measurement_failure(self):
        # The server's own --child, on a file the decoder cannot read (or without torch here): exit 1 and a reason, never numbers.
        bad = self.tmp / "song.wav"
        bad.write_bytes(b"RIFF\x00\x00\x00\x00WAVE" + b"\x00" * 64)
        # A cache whose files do not match their pins: refused without a download, wherever torch is installed.
        cache = self.tmp / "cache"
        cache.mkdir()
        for pin in (va.UMX_VOCALS, va.PANNS_CNN14, va.PANNS_LABELS):
            (cache / pin.name).write_bytes(b"not the pinned file")
        env = {**os.environ, "VOCAL_MEASURE_CACHE": str(cache)}
        with self.assertRaises(srv.Refused) as cm:
            srv.run_child(bad, timeout_s=120.0, env=env)
        self.assertEqual(cm.exception.code, "check_failed")
        self.assertIn("exit 1", cm.exception.remedy)


if __name__ == "__main__":
    unittest.main()
