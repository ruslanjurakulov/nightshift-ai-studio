#!/usr/bin/env python3
"""S6: how much singing is in a piece of music? Measurement only (CLAUDE.md rule 8).

Nothing in the product imports this file, nothing here decides anything, and it calls no vendor. ``measure(path)`` returns
NUMBERS and no verdict: which threshold separates "instrumental" from "sung" is what the Lyria probe run
(tools/lyria_vocal_probe.py, docs/MEASUREMENT.md "Lyria vocal activity (S6)") is for. Detectors and licences:
docs/research/vocal-activity-detection.md.

    python tools/vocal_activity.py FILE [--no-silero]     # one JSON line of numbers
    python tools/vocal_activity.py --fetch-only            # download and verify the pinned weights
    python tools/vocal_activity.py --synthetic tone        # cold load + one pass on a generated 440 Hz tone

Three signals, each on its own question:
  1. Open-Unmix UMX-HQ, the VOCALS model only (MIT code, MIT weights): the vocals stem is separated from the mix, and the
     per-second RMS of that stem relative to the mix is reported in dB. A separator always leaks a little of the mix into
     the stem, so a pure instrumental does not read minus infinity; the run's negatives are what show where the leak sits.
  2. PANNs Cnn14 (MIT code vendored in tools/vendor_panns/, CC BY 4.0 weights) on the full mix in 10 s windows: the
     per-window maximum probability over the AudioSet voice classes, and which class won, by name. The class indices are
     read from PANNs' own label CSV (pinned by hash), never typed by hand.
  3. Optional: Silero VAD (MIT) on the vocal stem at 16 kHz: seconds of speech-like activity.

Fail closed (rules 4 and 5). A weight whose sha256 differs, a model that does not load, a decoder that fails, an output of
the wrong shape or with NaN in it: ``MeasurementError``. There is no partial result: a check either ran and has numbers, or
the whole call raised. A check that was not asked for (Silero with ``--no-silero``) says "not requested", never zero.

The public log rule: the output is numbers and class names only. No audio, no path to an audio file, no text.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import resource
import shutil
import subprocess
import sys
import tempfile
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Mapping, Optional, Sequence

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class MeasurementError(RuntimeError):
    """A check did not run, or ran and produced something that cannot be read as a measurement. Never a verdict."""


@dataclass(frozen=True)
class Pinned:
    name: str
    url: str
    sha256: str
    size: int
    licence: str


#: Zenodo 3370489 ("Open-Unmix UMX-HQ", licence "MIT License"). The md5 Zenodo lists (d918985fad0fedf6d9ce89e279aa7218)
#: matched the downloaded file on 2026-11-28, and the sha256 below was computed from that file; its first 8 hex digits are
#: the "b62c91ce" in the file name (torch.hub's own convention), a second, independent confirmation.
UMX_VOCALS = Pinned(
    "vocals-b62c91ce.pth",
    "https://zenodo.org/records/3370489/files/vocals-b62c91ce.pth?download=1",
    "b62c91cedbc7a066f1778ead5b5cecb377aa3a46a31af1cce7c5c8769339d083",
    35637796,
    "MIT",
)
#: Zenodo 3987831 (PANNs pretrained models, CC BY 4.0, attribution in THIRD_PARTY_NOTICES). Zenodo's md5
#: (541141fa2ee191a88f24a3219fff024e) matched the downloaded file on 2026-11-28; the sha256 was computed from it.
PANNS_CNN14 = Pinned(
    "Cnn14_mAP=0.431.pth",
    "https://zenodo.org/records/3987831/files/Cnn14_mAP%3D0.431.pth?download=1",
    "0dc499e40e9761ef5ea061ffc77697697f277f6a960894903df3ada000e34b31",
    327428481,
    "CC-BY-4.0",
)
#: Entries of the UMX-HQ checkpoint that belong to Open-Unmix's pre-1.0 layout and have no parameter in 1.3.0.
UMX_LEGACY_KEYS = ("stft.window", "transform.0.window")
#: PANNs' own label file (the AudioSet ontology's 527 classes in the model's output order), at a pinned commit.
PANNS_LABELS = Pinned(
    "class_labels_indices.csv",
    "https://raw.githubusercontent.com/qiuqiangkong/audioset_tagging_cnn/"
    "d2f4b8c18eab44737fcc0de1248ae21eb43f6aa4/metadata/class_labels_indices.csv",
    "cdd1049833c4b86127c2773ac0d14a2754b6a6d0d1798002ed5c66e699708429",
    14675,
    "AudioSet ontology labels (CC BY 4.0), shipped in the MIT repository",
)
#: The Silero VAD model file inside the silero-vad 6.2.1 wheel (requirements-measure.txt). Pinned so a different file under
#: the same version is refused rather than measured with.
SILERO_JIT_SHA256 = "e1122837f4154c511485fe0b9c64455f7b929c96fbb8d79fbdb336383ebd3720"

#: Scout's voice classes, by their exact display names in PANNS_LABELS. "Narration" is "Narration, monologue" there.
VOICE_CLASSES = ("Speech", "Singing", "Choir", "Yodeling", "Chant", "Mantra", "Child singing", "Synthetic singing", "Rapping",
                 "Humming", "Vocal music", "A capella", "Whispering", "Narration, monologue")
#: Two singing classes Scout's list does not name. Reported apart so the run can see whether they matter, without changing
#: what the voice-class maximum means.
EXTRA_SINGING_CLASSES = ("Male singing", "Female singing")

#: Candidate thresholds for the vocal-to-mix ratio. Which one (if any) separates the classes is the run's finding.
THRESHOLDS_DB = (-30.0, -25.0, -20.0, -15.0, -10.0)
UMX_RATE = 44100
PANNS_RATE = 32000
SILERO_RATE = 16000
PANNS_WINDOW_S = 10
#: A song longer than this is refused, not cut: a measurement of the first N minutes is not a measurement of the file.
MAX_DURATION_S = 600.0
#: The ratio of a second with no vocal energy at all, so that the summary is a finite number (and says so: "floor").
FLOOR_DB = -120.0
#: A mix second quieter than this (full scale = 1.0) is digital silence: its ratio is undefined and it is counted apart.
SILENT_RMS = 1e-6


def cache_dir() -> Path:
    return Path(os.environ.get("VOCAL_MEASURE_CACHE") or (Path.home() / ".cache" / "nightshift-vocal-measure"))


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(pin: Pinned, cache: Optional[Path] = None, *, download: Optional[Callable[[str, Path, int], None]] = None) -> Path:
    """The pinned file, from the cache or downloaded, and ONLY if its sha256 is the pinned one. A cached file that does not
    match is an error to look at (a corrupted or replaced cache), never silently re-downloaded over."""
    cache = cache or cache_dir()
    path = cache / pin.name
    if path.exists():
        got = sha256_file(path)
        if got != pin.sha256:
            raise MeasurementError(f"{pin.name}: the cached file's sha256 is not the pinned one; delete {cache} and fetch again")
        return path
    cache.mkdir(parents=True, exist_ok=True)
    tmp = cache / (pin.name + ".part")
    try:
        (download or _download)(pin.url, tmp, pin.size)
        got = sha256_file(tmp)
        if got != pin.sha256:
            raise MeasurementError(f"{pin.name}: the downloaded file's sha256 is not the pinned one; not used")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()
    return path


def _download(url: str, dest: Path, size: int) -> None:
    import requests

    with requests.get(url, stream=True, timeout=120, allow_redirects=True) as r:
        if r.status_code != 200:
            raise MeasurementError(f"download of {url} answered HTTP {r.status_code}")
        got = 0
        with open(dest, "wb") as fh:
            for chunk in r.iter_content(1 << 20):
                got += len(chunk)
                if got > size:
                    raise MeasurementError(f"download of {url} is larger than the pinned {size} bytes")
                fh.write(chunk)
    if got != size:
        raise MeasurementError(f"download of {url} is {got} bytes, the pin says {size}")


def voice_class_indices(labels_csv: Path, names: Sequence[str] = VOICE_CLASSES) -> Dict[str, int]:
    """Display name -> output index, read from PANNs' label CSV. Every name must be there exactly once, and the file must
    have the model's 527 rows in index order: a file that disagrees is refused, so a class is never read off the wrong output."""
    with open(labels_csv, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    if len(rows) != 527:
        raise MeasurementError(f"the PANNs label file has {len(rows)} classes, the model has 527")
    by_name: Dict[str, List[int]] = {}
    for n, row in enumerate(rows):
        try:
            idx = int(row["index"])
        except (KeyError, TypeError, ValueError):
            raise MeasurementError("the PANNs label file has no usable 'index' column") from None
        if idx != n:
            raise MeasurementError("the PANNs label file is not in index order")
        by_name.setdefault(row.get("display_name", ""), []).append(idx)
    out: Dict[str, int] = {}
    for name in names:
        hits = by_name.get(name, [])
        if len(hits) != 1:
            raise MeasurementError(f"the PANNs label file names {name!r} {len(hits)} times, not once")
        out[name] = hits[0]
    return out


# ── decoding ──────────────────────────────────────────────────────────────────────────

def ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        exe = shutil.which("ffmpeg")
        if not exe:
            raise MeasurementError("no ffmpeg: install requirements-measure.txt (imageio-ffmpeg)") from None
        return exe


def decode(path: Path, rate: int, channels: int) -> np.ndarray:
    """``(channels, samples)`` float32 in [-1, 1] at ``rate``. ffmpeg's own resampler, so every detector gets its rate from
    the same source file rather than from a copy of a copy."""
    cmd = [ffmpeg_exe(), "-v", "error", "-nostdin", "-i", str(path), "-map", "0:a:0", "-ac", str(channels), "-ar", str(rate),
           "-f", "f32le", "-acodec", "pcm_f32le", "-t", str(MAX_DURATION_S + 1), "pipe:1"]
    proc = subprocess.run(cmd, capture_output=True, timeout=300)
    if proc.returncode != 0:
        # ffmpeg's stderr names the file; it is not passed on (the log is public), only that it failed.
        raise MeasurementError(f"ffmpeg could not decode the audio (exit {proc.returncode})")
    pcm = np.frombuffer(proc.stdout, dtype="<f4")
    if pcm.size == 0 or pcm.size % channels:
        raise MeasurementError("the audio decoded to no samples")
    pcm = pcm.reshape(-1, channels).T.copy()
    if not np.isfinite(pcm).all():
        raise MeasurementError("the decoded audio has non-finite samples")
    if pcm.shape[1] / rate > MAX_DURATION_S:
        raise MeasurementError(f"the audio is longer than {MAX_DURATION_S:.0f} s; refused, not truncated")
    return pcm


# ── the detectors ─────────────────────────────────────────────────────────────────────

class Detectors:
    """The three models behind one interface, so a test can stand in for them without torch. Each method raises
    ``MeasurementError`` rather than return something that could be read as "nothing found"."""

    voice_indices: Mapping[str, int]
    extra_indices: Mapping[str, int]
    load_s: Dict[str, float]
    versions: Dict[str, str]

    def separate_vocals(self, mix: np.ndarray) -> np.ndarray:          # (2, n) at 44.1 kHz -> (2, n)
        raise NotImplementedError

    def panns_probs(self, window: np.ndarray) -> np.ndarray:           # (n,) at 32 kHz -> (527,)
        raise NotImplementedError

    def silero_speech_s(self, stem: np.ndarray) -> float:              # (2, n) at 44.1 kHz -> seconds
        raise NotImplementedError

    has_silero: bool = False


class TorchDetectors(Detectors):
    def __init__(self, cache: Optional[Path] = None, *, silero: bool = True):
        try:
            import torch
        except Exception as e:
            raise MeasurementError(f"torch is not installed ({type(e).__name__}): install requirements-measure.txt") from None
        self._torch = torch
        torch.set_num_threads(max(1, os.cpu_count() or 1))
        self.load_s = {}
        self.versions = {"torch": torch.__version__}
        umx_path = fetch(UMX_VOCALS, cache)
        cnn_path = fetch(PANNS_CNN14, cache)
        labels = fetch(PANNS_LABELS, cache)
        self.voice_indices = voice_class_indices(labels)
        self.extra_indices = voice_class_indices(labels, EXTRA_SINGING_CLASSES)

        t = time.perf_counter()
        try:
            import openunmix
            from openunmix import utils as umx_utils
            from openunmix.model import OpenUnmix, Separator

            # UMX-HQ's vocals model with the settings openunmix.umxhq_spec uses, loaded STRICT: upstream loads with
            # strict=False, which would run a model whose layers silently kept their random initial weights.
            max_bin = umx_utils.bandwidth_to_max_bin(rate=44100.0, n_fft=4096, bandwidth=16000)
            target = OpenUnmix(nb_bins=4096 // 2 + 1, nb_channels=2, hidden_size=512, max_bin=max_bin)
            state = torch.load(umx_path, map_location="cpu", weights_only=True)
            # The 2019 checkpoint also carries three entries of the model's older layout (its own STFT window and rate),
            # which today's OpenUnmix computes instead of storing. Exactly those are dropped, the rate is checked, and every
            # other key must match both ways.
            rate = state.pop("sample_rate", None)
            if rate is not None and float(rate) != 44100.0:
                raise MeasurementError(f"the Open-Unmix checkpoint is for {float(rate):g} Hz, not 44100")
            for legacy in UMX_LEGACY_KEYS:
                state.pop(legacy, None)
            target.load_state_dict(state, strict=True)
            target.eval()
            # residual=True: one target plus "everything else", so the Wiener step (niter=1, as umxhq) has two sources.
            self._separator = Separator(target_models={"vocals": target}, niter=1, residual=True, n_fft=4096, n_hop=1024,
                                        nb_channels=2, sample_rate=44100.0, wiener_win_len=300, filterbank="torch")
            self._separator.freeze()
            self.versions["openunmix"] = getattr(openunmix, "__version__", "1.3.0")
        except MeasurementError:
            raise
        except Exception as e:
            raise MeasurementError(f"Open-Unmix vocals model did not load ({type(e).__name__}: {e})"[:300]) from None
        self.load_s["umx_vocals"] = time.perf_counter() - t

        t = time.perf_counter()
        try:
            from tools.vendor_panns.cnn14 import Cnn14

            ckpt = torch.load(cnn_path, map_location="cpu", weights_only=True)
            model = Cnn14()
            # strict: the DFT kernels and the mel matrix start at zero and MUST come from the checkpoint (cnn14.py).
            model.load_state_dict(ckpt["model"] if isinstance(ckpt, dict) and "model" in ckpt else ckpt, strict=True)
            model.eval()
            self._cnn14 = model
        except Exception as e:
            raise MeasurementError(f"PANNs Cnn14 did not load ({type(e).__name__}: {e})"[:300]) from None
        self.load_s["panns_cnn14"] = time.perf_counter() - t

        self.has_silero = silero
        if silero:
            t = time.perf_counter()
            try:
                import silero_vad
                from importlib import resources

                jit = Path(str(resources.files("silero_vad.data").joinpath("silero_vad.jit")))
                if sha256_file(jit) != SILERO_JIT_SHA256:
                    raise MeasurementError("the Silero VAD model file's sha256 is not the pinned one")
                self._silero = silero_vad.load_silero_vad(onnx=False)
                self._silero_ts = silero_vad.get_speech_timestamps
                self.versions["silero_vad"] = getattr(silero_vad, "__version__", "")
            except MeasurementError:
                raise
            except Exception as e:
                raise MeasurementError(f"Silero VAD did not load ({type(e).__name__}: {e})"[:300]) from None
            self.load_s["silero_vad"] = time.perf_counter() - t

    def separate_vocals(self, mix: np.ndarray) -> np.ndarray:
        torch = self._torch
        try:
            with torch.inference_mode():
                est = self._separator(torch.from_numpy(np.ascontiguousarray(mix))[None])
            return est[0, 0].numpy().astype(np.float32)
        except Exception as e:
            raise MeasurementError(f"Open-Unmix separation failed ({type(e).__name__})") from None

    def panns_probs(self, window: np.ndarray) -> np.ndarray:
        torch = self._torch
        try:
            with torch.inference_mode():
                return self._cnn14(torch.from_numpy(np.ascontiguousarray(window, dtype=np.float32))[None])[0].numpy()
        except Exception as e:
            raise MeasurementError(f"PANNs inference failed ({type(e).__name__})") from None

    def silero_speech_s(self, stem: np.ndarray) -> float:
        torch = self._torch
        try:
            import torchaudio.functional as AF

            mono = torch.from_numpy(np.ascontiguousarray(stem.mean(axis=0), dtype=np.float32))
            x16 = AF.resample(mono, UMX_RATE, SILERO_RATE)
            spans = self._silero_ts(x16, self._silero, sampling_rate=SILERO_RATE, return_seconds=True)
            return float(sum(float(s["end"]) - float(s["start"]) for s in spans))
        except Exception as e:
            raise MeasurementError(f"Silero VAD failed ({type(e).__name__})") from None


def load_detectors(cache: Optional[Path] = None, *, silero: bool = True) -> Detectors:
    return TorchDetectors(cache, silero=silero)


# ── the numbers ───────────────────────────────────────────────────────────────────────

def _rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64)))) if x.size else 0.0


def per_second_ratio_db(mix: np.ndarray, stem: np.ndarray, rate: int) -> tuple:
    """(ratios_db for each non-silent second, silent seconds). A trailing part shorter than half a second is not a second."""
    n = mix.shape[1]
    out: List[float] = []
    silent = 0
    for start in range(0, n, rate):
        end = min(n, start + rate)
        if end - start < rate // 2:
            break
        m = _rms(mix[:, start:end])
        if m < SILENT_RMS:
            silent += 1
            continue
        v = _rms(stem[:, start:end])
        out.append(FLOOR_DB if v <= 0 else max(FLOOR_DB, 20.0 * math.log10(v / m)))
    return out, silent


def _longest_run(flags: Sequence[bool]) -> int:
    best = cur = 0
    for f in flags:
        cur = cur + 1 if f else 0
        best = max(best, cur)
    return best


def ratio_summary(ratios: Sequence[float], silent: int) -> dict:
    if not ratios:
        # Every second was silence: there is nothing to summarise, and that is said, never written as "no vocals".
        return {"seconds": 0, "silent_seconds": silent, "p50_db": None, "p90_db": None, "max_db": None, "thresholds": {}}
    arr = np.asarray(ratios, dtype=np.float64)
    thresholds = {}
    for th in THRESHOLDS_DB:
        above = [r > th for r in ratios]
        thresholds[f"{th:g}"] = {"share_above": round(sum(above) / len(above), 4), "longest_run_s": _longest_run(above)}
    return {"seconds": len(ratios), "silent_seconds": silent, "p50_db": round(float(np.percentile(arr, 50)), 2),
            "p90_db": round(float(np.percentile(arr, 90)), 2), "max_db": round(float(arr.max()), 2),
            "floor_db": FLOOR_DB, "thresholds": thresholds}


def panns_windows(mono: np.ndarray, rate: int = PANNS_RATE, seconds: int = PANNS_WINDOW_S) -> List[np.ndarray]:
    """10 s windows, back to back. The last one is zero-padded when it is at least 1 s long (a shorter tail is dropped)."""
    size = rate * seconds
    out = []
    for start in range(0, mono.shape[0], size):
        w = mono[start:start + size]
        if w.shape[0] < rate:
            break
        if w.shape[0] < size:
            w = np.concatenate([w, np.zeros(size - w.shape[0], dtype=w.dtype)])
        out.append(w)
    return out


def _check_probs(p: np.ndarray) -> np.ndarray:
    p = np.asarray(p, dtype=np.float64)
    if p.shape != (527,) or not np.isfinite(p).all() or p.min() < 0 or p.max() > 1:
        raise MeasurementError("PANNs returned something that is not 527 probabilities")
    return p


def _peak_rss_mb() -> float:
    # Linux reports kilobytes. This is the PROCESS peak since start (Python, torch, every model), which is what a worker pays.
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0, 1)


def measure(path, *, detectors: Optional[Detectors] = None, silero: bool = True, cache: Optional[Path] = None,
            decoder: Callable[[Path, int, int], np.ndarray] = decode) -> dict:
    """Numbers only, no verdict. Raises ``MeasurementError`` when any requested check did not run."""
    path = Path(path)
    loaded_here = detectors is None
    t = time.perf_counter()
    det = detectors if detectors is not None else load_detectors(cache, silero=silero)
    load_wall = time.perf_counter() - t
    if silero and not det.has_silero:
        raise MeasurementError("Silero VAD was asked for and is not loaded")

    t = time.perf_counter()
    mix = decoder(path, UMX_RATE, 2)
    mono32 = decoder(path, PANNS_RATE, 1)[0]
    decode_s = time.perf_counter() - t
    duration_s = mix.shape[1] / UMX_RATE

    t = time.perf_counter()
    stem = np.asarray(det.separate_vocals(mix))
    if stem.shape != mix.shape or not np.isfinite(stem).all():
        raise MeasurementError("Open-Unmix returned a vocals stem of the wrong shape or with non-finite samples")
    umx_s = time.perf_counter() - t
    ratios, silent = per_second_ratio_db(mix, stem, UMX_RATE)

    t = time.perf_counter()
    windows = panns_windows(mono32)
    if not windows:
        raise MeasurementError("the audio is shorter than one PANNs window (1 s)")
    win_max: List[float] = []
    win_class: List[str] = []
    class_max = {name: 0.0 for name in det.voice_indices}
    extra_max = {name: 0.0 for name in det.extra_indices}
    for w in windows:
        p = _check_probs(det.panns_probs(w))
        best_name, best = None, -1.0
        for name, idx in det.voice_indices.items():
            class_max[name] = max(class_max[name], float(p[idx]))
            if p[idx] > best:
                best_name, best = name, float(p[idx])
        for name, idx in det.extra_indices.items():
            extra_max[name] = max(extra_max[name], float(p[idx]))
        win_max.append(best)
        win_class.append(best_name)
    panns_s = time.perf_counter() - t
    top = int(np.argmax(win_max))

    if silero:
        t = time.perf_counter()
        speech_s = float(det.silero_speech_s(stem))
        if not math.isfinite(speech_s) or speech_s < 0:
            raise MeasurementError("Silero VAD returned a duration that is not a number of seconds")
        silero_out = {"ran": True, "speech_s": round(speech_s, 2), "speech_share": round(speech_s / duration_s, 4),
                      "inference_s": round(time.perf_counter() - t, 3)}
    else:
        silero_out = {"ran": False, "reason": "not requested"}

    return {
        "duration_s": round(duration_s, 3),
        "checks": {"umx_vocals": "ran", "panns_cnn14": "ran", "silero_vad": "ran" if silero else "not requested"},
        "umx_vocal_to_mix": ratio_summary(ratios, silent),
        "panns": {
            "windows": len(windows),
            "window_s": PANNS_WINDOW_S,
            "voice_max": round(max(win_max), 4),
            "voice_mean": round(float(np.mean(win_max)), 4),
            "voice_max_class": win_class[top],
            "window_max": [round(v, 4) for v in win_max],
            "class_max": {k: round(v, 4) for k, v in class_max.items()},
            "extra_singing_class_max": {k: round(v, 4) for k, v in extra_max.items()},
        },
        "silero": silero_out,
        "timing_s": {
            "model_load": round(load_wall, 3) if loaded_here else None,
            "model_load_each": {k: round(v, 3) for k, v in getattr(det, "load_s", {}).items()},
            "decode": round(decode_s, 3),
            "umx": round(umx_s, 3),
            "panns": round(panns_s, 3),
        },
        "peak_rss_mb": _peak_rss_mb(),
        "versions": dict(getattr(det, "versions", {})),
    }


# ── synthetic inputs for a smoke run ──────────────────────────────────────────────────

def synth(kind: str, seconds: float = 12.0, rate: int = UMX_RATE) -> np.ndarray:
    """``tone``: a 440 Hz sine. ``voicelike``: a 120-220 Hz pulse train with vibrato through three vowel formants, over a soft
    chord. Neither is music or a voice; they exercise the pipeline and show the separator's floor, nothing more."""
    t = np.arange(int(seconds * rate)) / rate
    if kind == "tone":
        y = 0.3 * np.sin(2 * np.pi * 440.0 * t)
        return np.stack([y, y]).astype(np.float32)
    if kind != "voicelike":
        raise ValueError(kind)
    f0 = 170 + 50 * np.sin(2 * np.pi * 0.25 * t) + 4 * np.sin(2 * np.pi * 5.5 * t)
    phase = 2 * np.pi * np.cumsum(f0) / rate
    src = np.zeros_like(t)
    for k in range(1, 40):
        src += np.sin(k * phase) / k
    spec = np.fft.rfft(src)
    freqs = np.fft.rfftfreq(src.size, 1 / rate)
    env = sum(np.exp(-0.5 * ((freqs - fc) / bw) ** 2) * g for fc, bw, g in ((700, 90, 1.0), (1200, 110, 0.6), (2600, 160, 0.3)))
    voice = np.fft.irfft(spec * env, n=src.size)
    voice *= (0.5 + 0.5 * (np.sin(2 * np.pi * 0.5 * t) > -0.3))   # phrases with breaths
    voice = 0.25 * voice / (np.abs(voice).max() or 1.0)
    chord = sum(0.05 * np.sin(2 * np.pi * f * t) for f in (130.8, 164.8, 196.0))
    y = voice + chord
    return np.stack([y, y]).astype(np.float32)


def write_wav(path: Path, audio: np.ndarray, rate: int = UMX_RATE) -> None:
    pcm = (np.clip(audio.T, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(audio.shape[0])
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("file", nargs="?")
    ap.add_argument("--no-silero", action="store_true")
    ap.add_argument("--fetch-only", action="store_true", help="download and verify the pinned weights, then stop")
    ap.add_argument("--synthetic", choices=("tone", "voicelike"), help="measure a generated signal (deleted afterwards)")
    ap.add_argument("--cache", type=Path)
    args = ap.parse_args(argv)
    try:
        if args.fetch_only:
            for pin in (UMX_VOCALS, PANNS_CNN14, PANNS_LABELS):
                fetch(pin, args.cache)
            print(json.dumps({"fetched": [p.name for p in (UMX_VOCALS, PANNS_CNN14, PANNS_LABELS)], "sha256": "pinned, matched"}))
            return 0
        if args.synthetic:
            tmp = Path(tempfile.mkdtemp(prefix="vam-"))
            try:
                wav = tmp / "synthetic.wav"
                write_wav(wav, synth(args.synthetic))
                out = measure(wav, silero=not args.no_silero, cache=args.cache)
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
            out["input"] = f"synthetic:{args.synthetic}"
            print(json.dumps(out, sort_keys=True))
            return 0
        if not args.file:
            ap.error("name a file, or --synthetic, or --fetch-only")
        print(json.dumps(measure(args.file, silero=not args.no_silero, cache=args.cache), sort_keys=True))
        return 0
    except MeasurementError as e:
        print(json.dumps({"error": "measurement_failed", "detail": str(e)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
