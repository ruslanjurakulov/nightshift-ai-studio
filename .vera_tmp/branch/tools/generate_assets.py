#!/usr/bin/env python3
"""Synthesize placeholder SFX and music beds so the pipeline has audio to mix.

These are generated, royalty-free-by-construction WAV files — no downloads, no
licensing questions. They are deliberately simple: swap in real recordings from
Freesound/Pixabay later by dropping files with the same names into assets/sfx/
and assets/music/. The mixer looks up assets by name, so replacing a file needs
no code change.

Run:  python tools/generate_assets.py
"""

import math
import struct
import wave
from pathlib import Path

import numpy as np

SR = 44100  # sample rate
ASSETS = Path(__file__).resolve().parent.parent / "assets"


# ── primitives ──────────────────────────────────────────────────────────────

def _t(duration: float) -> np.ndarray:
    return np.linspace(0, duration, int(SR * duration), endpoint=False)


def _noise(duration: float) -> np.ndarray:
    return np.random.uniform(-1, 1, int(SR * duration))


def _sine(freq, duration: float, phase: float = 0.0) -> np.ndarray:
    t = _t(duration)
    f = np.full_like(t, freq) if np.isscalar(freq) else np.asarray(freq)[: len(t)]
    return np.sin(2 * np.pi * np.cumsum(f) / SR + phase)


def _env(signal: np.ndarray, attack=0.01, decay=None, power=2.0) -> np.ndarray:
    """Attack ramp then exponential-ish decay over the remainder."""
    n = len(signal)
    a = max(1, int(SR * attack))
    env = np.ones(n)
    env[:a] = np.linspace(0, 1, a)
    tail = n - a
    if tail > 0:
        env[a:] = np.linspace(1, 0, tail) ** power
    return signal * env


def _lowpass(x: np.ndarray, cutoff_hz: float) -> np.ndarray:
    """One-pole lowpass — enough to take the harshness off white noise."""
    alpha = 1.0 - math.exp(-2 * math.pi * cutoff_hz / SR)
    out = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc += alpha * (v - acc)
        out[i] = acc
    return out


def _norm(x: np.ndarray, peak: float = 0.85) -> np.ndarray:
    m = np.max(np.abs(x))
    return x * (peak / m) if m > 0 else x


def _write(path: Path, mono: np.ndarray, stereo_spread: bool = True):
    """Write 16-bit stereo WAV. pydub reads WAV without needing ffmpeg."""
    mono = _norm(mono)
    if stereo_spread:
        # tiny delay on the right channel for width
        d = int(SR * 0.004)
        right = np.concatenate([np.zeros(d), mono])[: len(mono)]
    else:
        right = mono
    interleaved = np.empty(len(mono) * 2)
    interleaved[0::2] = mono
    interleaved[1::2] = right
    pcm = np.clip(interleaved * 32767, -32768, 32767).astype("<i2")

    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


# ── sound effects ───────────────────────────────────────────────────────────
# Names must match the [SFX:...] cues listed in script_engine.SCRIPT_SYSTEM_PROMPT.

def sfx_whoosh():
    d = 0.7
    sweep = np.geomspace(200, 3000, int(SR * d))
    body = _lowpass(_noise(d), 4000) * 0.8 + _sine(sweep, d) * 0.2
    return _env(body, attack=0.15, power=2.5)


def sfx_deep_boom():
    d = 1.6
    sub = _sine(np.geomspace(90, 35, int(SR * d)), d)
    click = _env(_noise(0.05), attack=0.001, power=4)
    out = _env(sub, attack=0.005, power=1.6)
    out[: len(click)] += click * 0.35
    return out


def sfx_paper_turn():
    d = 0.45
    crinkle = _lowpass(_noise(d), 7000)
    # two bursts: grab, then release
    env = np.ones(len(crinkle))
    env[: int(SR * 0.1)] = np.linspace(0, 1, int(SR * 0.1))
    env[int(SR * 0.15):] *= np.linspace(1, 0, len(env) - int(SR * 0.15)) ** 1.5
    return crinkle * env * 0.7


def sfx_dramatic_sting():
    d = 2.2
    root = 110.0
    chord = sum(_sine(root * r, d) for r in (1.0, 1.5, 2.0, 3.0))
    shimmer = _lowpass(_noise(d), 6000) * 0.15
    return _env(chord / 4 + shimmer, attack=0.01, power=1.4)


def sfx_thunder_crack():
    d = 2.4
    crack = _env(_lowpass(_noise(0.35), 9000), attack=0.002, power=3)
    rumble = _env(_lowpass(_noise(d), 220), attack=0.05, power=1.2)
    out = rumble * 0.7
    out[: len(crack)] += crack
    return out


def sfx_heartbeat():
    d = 1.4
    out = np.zeros(int(SR * d))
    for offset, gain in ((0.0, 1.0), (0.32, 0.75)):
        thump = _env(_sine(np.geomspace(70, 45, int(SR * 0.22)), 0.22),
                     attack=0.008, power=2.2) * gain
        s = int(SR * offset)
        out[s:s + len(thump)] += thump
    return out


def sfx_clock_tick():
    d = 1.0
    out = np.zeros(int(SR * d))
    for offset in (0.0, 0.5):
        tick = _env(_lowpass(_noise(0.03), 6000), attack=0.001, power=5)
        s = int(SR * offset)
        out[s:s + len(tick)] += tick
    return out


def sfx_suspense_riser():
    d = 3.5
    sweep = np.geomspace(120, 2400, int(SR * d))
    tone = _sine(sweep, d)
    noise = _lowpass(_noise(d), 5000) * 0.4
    ramp = np.linspace(0, 1, int(SR * d)) ** 2
    return (tone * 0.6 + noise) * ramp


def sfx_glass_shatter():
    d = 1.2
    out = _env(_noise(0.08), attack=0.001, power=4) * 0.9
    out = np.concatenate([out, np.zeros(int(SR * d) - len(out))])
    rng = np.random.default_rng(7)
    for _ in range(40):  # scattered shards
        start = int(SR * rng.uniform(0.02, 0.9))
        shard = _env(_sine(rng.uniform(2000, 7000), 0.06), attack=0.001, power=4)
        shard *= rng.uniform(0.1, 0.4)
        out[start:start + len(shard)] += shard[: len(out) - start]
    return out


def sfx_choir_hit():
    d = 2.6
    root = 146.83  # D3
    voices = sum(_sine(root * r * (1 + 0.004 * i), d)
                 for i, r in enumerate((1.0, 1.2, 1.5, 2.0, 2.4, 3.0)))
    return _env(voices / 6, attack=0.08, power=1.3)


def sfx_eerie_wind():
    d = 4.0
    base = _lowpass(_noise(d), 900)
    # slow amplitude wobble
    wobble = 0.6 + 0.4 * np.sin(2 * np.pi * 0.25 * _t(d))
    whistle = _sine(400 + 120 * np.sin(2 * np.pi * 0.15 * _t(d)), d) * 0.12
    return (base * wobble + whistle) * 0.8


def sfx_fire_crackle():
    d = 3.0
    bed = _lowpass(_noise(d), 1800) * 0.35
    rng = np.random.default_rng(3)
    out = bed.copy()
    for _ in range(60):
        start = int(SR * rng.uniform(0, d - 0.1))
        pop = _env(_noise(0.02), attack=0.001, power=5) * rng.uniform(0.2, 0.8)
        out[start:start + len(pop)] += pop[: len(out) - start]
    return out


SFX = {
    "whoosh": sfx_whoosh,
    "deep_boom": sfx_deep_boom,
    "paper_turn": sfx_paper_turn,
    "dramatic_sting": sfx_dramatic_sting,
    "thunder_crack": sfx_thunder_crack,
    "heartbeat": sfx_heartbeat,
    "clock_tick": sfx_clock_tick,
    "suspense_riser": sfx_suspense_riser,
    "glass_shatter": sfx_glass_shatter,
    "choir_hit": sfx_choir_hit,
    "eerie_wind": sfx_eerie_wind,
    "fire_crackle": sfx_fire_crackle,
}


# ── music beds ──────────────────────────────────────────────────────────────
# Names must match audio_mixer.MUSIC_VOLUME_MAP. Each is a seamless-ish loop the
# mixer tiles to fill the video, so they are built to a whole number of bars.

def _pad(root: float, ratios, duration: float, detune=0.003) -> np.ndarray:
    """Sustained chord pad."""
    return sum(
        _sine(root * r * (1 + detune * i), duration)
        for i, r in enumerate(ratios)
    ) / len(ratios)


def _pulse(freq: float, duration: float, bpm: float, gain=0.5) -> np.ndarray:
    """Rhythmic bass pulse on the beat."""
    out = np.zeros(int(SR * duration))
    beat = 60.0 / bpm
    n_beats = int(duration / beat)
    for i in range(n_beats):
        hit = _env(_sine(freq, min(beat * 0.9, 0.4)), attack=0.005, power=2.0)
        s = int(SR * i * beat)
        out[s:s + len(hit)] += hit[: len(out) - s] * gain
    return out


def music_intro_high():
    """Energetic — drives the hook."""
    d, bpm = 16.0, 100
    root = 110.0
    pad = _pad(root, (1.0, 1.5, 2.0, 2.5), d) * 0.5
    bass = _pulse(root / 2, d, bpm, gain=0.6)
    arp = np.zeros(int(SR * d))
    beat = 60.0 / bpm
    for i in range(int(d / (beat / 2))):
        note = root * 4 * (1.0, 1.25, 1.5, 2.0)[i % 4]
        hit = _env(_sine(note, beat * 0.4), attack=0.003, power=2.5) * 0.18
        s = int(SR * i * beat / 2)
        arp[s:s + len(hit)] += hit[: len(arp) - s]
    return pad + bass + arp


def music_story_low():
    """Quiet, unobtrusive — sits far under narration."""
    d = 24.0
    root = 98.0  # G2
    pad = _pad(root, (1.0, 1.2, 1.5), d, detune=0.002) * 0.7
    # slow swell so it breathes
    swell = 0.75 + 0.25 * np.sin(2 * np.pi * (1 / 12.0) * _t(d))
    sub = _sine(root / 2, d) * 0.25
    return (pad * swell + sub) * 0.8


def music_climax_high():
    """Tense and loud — the peak."""
    d, bpm = 16.0, 120
    root = 146.83  # D3
    pad = _pad(root, (1.0, 1.19, 1.5, 2.0), d, detune=0.005) * 0.55
    bass = _pulse(root / 4, d, bpm, gain=0.7)
    riser = np.linspace(0, 1, int(SR * d)) ** 1.5
    strings = _sine(root * 3, d) * 0.15 * riser
    return pad + bass + strings


def music_outro():
    """Resolving, calmer — the payoff."""
    d = 20.0
    root = 130.81  # C3
    pad = _pad(root, (1.0, 1.25, 1.5, 2.0), d) * 0.6
    fade = np.concatenate([
        np.ones(int(SR * d * 0.6)),
        np.linspace(1, 0.25, int(SR * d) - int(SR * d * 0.6)),
    ])
    sub = _sine(root / 2, d) * 0.2
    return (pad + sub) * fade


MUSIC = {
    "intro_high": music_intro_high,
    "story_low": music_story_low,
    "climax_high": music_climax_high,
    "outro": music_outro,
}


def _needed(kind: str, name: str) -> Path | None:
    """Path to write, or None when the asset already exists in any format.

    The mixer looks up mp3 before wav, so a real recording dropped in as
    <name>.mp3 always wins over anything generated here — and we skip it
    entirely rather than writing a wav that would never be read.
    """
    folder = ASSETS / kind
    for ext in ("mp3", "wav", "ogg"):
        if (folder / f"{name}.{ext}").exists():
            return None
    return folder / f"{name}.wav"


def ensure_assets(verbose: bool = True) -> int:
    """Generate any missing SFX/music. Existing files are never overwritten."""
    written = 0
    for kind, table in (("sfx", SFX), ("music", MUSIC)):
        for name, fn in table.items():
            path = _needed(kind, name)
            if path is None:
                continue
            _write(path, fn())
            written += 1
            if verbose:
                print(f"  {kind}/{path.name}")
    return written


def main():
    written = ensure_assets()
    total = len(SFX) + len(MUSIC)
    if written:
        print(f"\n{written} of {total} assets generated in {ASSETS}")
    else:
        print(f"All {total} assets already present in {ASSETS} — nothing to do.")
    print("Drop real recordings in as <name>.mp3 to override any of them.")


if __name__ == "__main__":
    main()
