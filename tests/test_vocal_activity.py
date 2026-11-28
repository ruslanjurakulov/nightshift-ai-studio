"""tools/vocal_activity.py, the S6 measurement library. Offline: the models and the decoder are stubbed, nothing is downloaded.

What would break without these tests:

* a weight file whose sha256 is not the pinned one being used anyway (or a bad download left in the cache);
* a model that failed to load, a separator that returned garbage, or a PANNs output that is not 527 probabilities ending in a
  result that LOOKS complete, which a later threshold would read as "no vocals" (rules 4 and 5);
* Silero reading 0 seconds when it never ran;
* the voice classes read off the wrong outputs because a label file disagreed with the model;
* the numbers themselves: a stem 20 dB below the mix must read -20 dB.
"""

from __future__ import annotations

import builtins
import csv
import hashlib
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from tools import vocal_activity as va

RATE = va.UMX_RATE


def mix(seconds=12.0):
    t = np.arange(int(seconds * RATE)) / RATE
    y = (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    return np.stack([y, y])


def decoder_for(audio):
    def dec(path, rate, channels):
        if rate == RATE and channels == 2:
            return audio
        n = int(audio.shape[1] * rate / RATE)
        return np.zeros((channels, n), dtype=np.float32) + 0.01
    return dec


class Stub(va.Detectors):
    def __init__(self, *, gain=0.1, probs=None, silero=True, fail=None):
        names = va.VOICE_CLASSES
        self.voice_indices = {n: i for i, n in enumerate(names)}
        self.extra_indices = {n: 100 + i for i, n in enumerate(va.EXTRA_SINGING_CLASSES)}
        self.load_s, self.versions = {}, {"stub": "1"}
        self.gain, self.probs, self.has_silero, self.fail = gain, probs, silero, fail

    def separate_vocals(self, m):
        if self.fail == "umx":
            raise va.MeasurementError("Open-Unmix separation failed (RuntimeError)")
        if self.fail == "umx_shape":
            return m[:, :-10]
        if self.fail == "umx_nan":
            out = m * self.gain
            out[0, 5] = np.nan
            return out
        return m * self.gain

    def panns_probs(self, w):
        if self.probs is not None:
            return self.probs
        p = np.zeros(527)
        p[self.voice_indices["Singing"]] = 0.8
        p[self.voice_indices["Speech"]] = 0.3
        return p

    def silero_speech_s(self, stem):
        if self.fail == "silero":
            raise va.MeasurementError("Silero VAD failed (RuntimeError)")
        return 2.5


def measure(det, *, silero=True, audio=None):
    return va.measure(Path("/nonexistent.mp3"), detectors=det, silero=silero, decoder=decoder_for(mix() if audio is None else audio))


class NumbersTests(unittest.TestCase):
    def test_a_stem_twenty_db_down_reads_minus_twenty(self):
        r = measure(Stub(gain=0.1))
        u = r["umx_vocal_to_mix"]
        self.assertEqual((u["p50_db"], u["p90_db"], u["max_db"]), (-20.0, -20.0, -20.0))
        self.assertEqual(u["seconds"], 12)
        self.assertEqual(u["thresholds"]["-25"], {"share_above": 1.0, "longest_run_s": 12})
        self.assertEqual(u["thresholds"]["-15"], {"share_above": 0.0, "longest_run_s": 0})
        self.assertEqual(r["duration_s"], 12.0)

    def test_panns_reports_the_window_max_and_the_winning_class_by_name(self):
        r = measure(Stub())
        p = r["panns"]
        self.assertEqual((p["windows"], p["voice_max"], p["voice_max_class"], p["voice_mean"]), (2, 0.8, "Singing", 0.8))
        self.assertEqual(set(p["class_max"]), set(va.VOICE_CLASSES))
        self.assertEqual(set(p["extra_singing_class_max"]), set(va.EXTRA_SINGING_CLASSES))

    def test_no_verdict_is_returned(self):
        r = measure(Stub())
        flat = repr(r).lower()
        for word in ("verdict", "instrumental", "vocals_present", "passed", "is_vocal"):
            self.assertNotIn(word, flat)

    def test_digital_silence_is_counted_apart_never_as_no_vocals(self):
        r = measure(Stub(), audio=np.zeros((2, RATE * 3), dtype=np.float32))
        u = r["umx_vocal_to_mix"]
        self.assertEqual((u["seconds"], u["silent_seconds"], u["p50_db"]), (0, 3, None))

    def test_versions_are_read_from_what_is_installed(self):
        from importlib import metadata

        v = va.installed_versions()
        self.assertEqual(set(v), set(va.MEASURED_WITH))
        self.assertEqual(v["numpy"], metadata.version("numpy"))
        with mock.patch.object(metadata, "version", side_effect=metadata.PackageNotFoundError("torch")):
            self.assertEqual(set(va.installed_versions().values()), {"not installed"})

    def test_longest_run(self):
        self.assertEqual(va._longest_run([True, True, False, True, True, True, False]), 3)


class FailClosedTests(unittest.TestCase):
    def test_a_failing_or_garbled_check_raises_never_a_partial_result(self):
        for fail in ("umx", "umx_shape", "umx_nan", "silero"):
            with self.subTest(fail=fail), self.assertRaises(va.MeasurementError):
                measure(Stub(fail=fail))
        for bad in (np.zeros(526), np.full(527, np.nan), np.full(527, 1.5), np.full(527, -0.1)):
            with self.subTest(probs=bad.shape), self.assertRaises(va.MeasurementError):
                measure(Stub(probs=bad))

    def test_silero_asked_for_but_not_loaded_raises(self):
        with self.assertRaises(va.MeasurementError):
            measure(Stub(silero=False), silero=True)

    def test_silero_not_requested_says_so_and_is_not_zero(self):
        r = measure(Stub(silero=False), silero=False)
        self.assertEqual(r["silero"], {"ran": False, "reason": "not requested"})
        self.assertEqual(r["checks"]["silero_vad"], "not requested")
        r = measure(Stub())
        self.assertEqual((r["silero"]["ran"], r["silero"]["speech_s"]), (True, 2.5))

    def test_a_model_that_fails_to_load_raises_from_measure(self):
        with mock.patch.object(va, "load_detectors", side_effect=va.MeasurementError("PANNs Cnn14 did not load")):
            with self.assertRaises(va.MeasurementError):
                va.measure(Path("/nonexistent.mp3"), decoder=decoder_for(mix()))

    def test_without_torch_the_detectors_do_not_load(self):
        real = builtins.__import__

        def no_torch(name, *a, **k):
            if name == "torch" or name.startswith("torch."):
                raise ImportError("no torch")
            return real(name, *a, **k)

        with mock.patch.dict(sys.modules, {"torch": None}), mock.patch.object(builtins, "__import__", no_torch):
            with self.assertRaises(va.MeasurementError):
                va.TorchDetectors(Path(tempfile.gettempdir()) / "unused")


class FetchTests(unittest.TestCase):
    def setUp(self):
        self.cache = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.cache, True)
        self.body = b"model weights"
        self.pin = va.Pinned("w.pth", "https://zenodo.org/x", hashlib.sha256(self.body).hexdigest(), len(self.body), "MIT")

    def writer(self, data):
        def dl(url, dest, size):
            Path(dest).write_bytes(data)
        return dl

    def test_a_download_with_the_wrong_hash_is_refused_and_not_kept(self):
        with self.assertRaises(va.MeasurementError):
            va.fetch(self.pin, self.cache, download=self.writer(b"tampered"))
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_a_cached_file_with_the_wrong_hash_is_refused_not_replaced(self):
        (self.cache / "w.pth").write_bytes(b"tampered")
        with self.assertRaises(va.MeasurementError):
            va.fetch(self.pin, self.cache, download=lambda *a: self.fail("re-downloaded over a bad cache"))
        self.assertEqual((self.cache / "w.pth").read_bytes(), b"tampered")

    def test_the_pinned_file_is_used(self):
        p = va.fetch(self.pin, self.cache, download=self.writer(self.body))
        self.assertEqual(p.read_bytes(), self.body)
        self.assertEqual(va.fetch(self.pin, self.cache, download=lambda *a: self.fail("downloaded twice")), p)

    def test_a_bad_weight_fails_the_detector_load(self):
        # The real loader goes through fetch for every file: a mismatched UMX file stops it before any model is built.
        (self.cache / va.UMX_VOCALS.name).write_bytes(b"not the model")
        fake_torch = mock.MagicMock(__version__="0-test")
        with mock.patch.dict(sys.modules, {"torch": fake_torch}):
            with self.assertRaises(va.MeasurementError) as cm:
                va.TorchDetectors(self.cache)
        self.assertIn("sha256", str(cm.exception))

    def test_the_pins_are_full_sha256_and_the_umx_name_matches_its_hash(self):
        for pin in (va.UMX_VOCALS, va.PANNS_CNN14, va.PANNS_LABELS):
            self.assertRegex(pin.sha256, r"^[0-9a-f]{64}$")
            self.assertTrue(pin.url.startswith("https://"))
        # torch.hub's convention: the file name carries the first 8 hex digits of its sha256.
        self.assertTrue(va.UMX_VOCALS.sha256.startswith("b62c91ce"))
        self.assertRegex(va.SILERO_JIT_SHA256, r"^[0-9a-f]{64}$")


class LabelTests(unittest.TestCase):
    def write(self, names):
        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d, True)
        p = d / "labels.csv"
        with open(p, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["index", "mid", "display_name"])
            for i, n in enumerate(names):
                w.writerow([i, f"/m/{i}", n])
        return p

    def full(self):
        names = [f"Class {i}" for i in range(527)]
        for i, n in enumerate(va.VOICE_CLASSES + va.EXTRA_SINGING_CLASSES):
            names[i * 3] = n
        return names

    def test_indices_come_from_the_file(self):
        idx = va.voice_class_indices(self.write(self.full()))
        self.assertEqual(idx["Speech"], 0)
        self.assertEqual(idx["Singing"], 3)

    def test_a_file_that_disagrees_with_the_model_is_refused(self):
        names = self.full()
        missing = [n if n != "Choir" else "Choir!" for n in names]
        dup = list(names)
        dup[1] = "Singing"
        for bad in (missing, dup, names[:526]):
            with self.subTest(n=len(bad)), self.assertRaises(va.MeasurementError):
                va.voice_class_indices(self.write(bad))


if __name__ == "__main__":
    unittest.main()
