"""A speech-like test recording for the clean-voice tests (tests/test_editor_parity4.py) and the cost measurement in
docs/editor-render-fields.md section 18. The repository holds no voice recording, so this one is made: voiced
syllables (a 105-140 Hz harmonic series shaped by three formants, 150-300 ms each, with pauses), sibilant bursts
(5-9 kHz noise), and under it what a cheap microphone in a room adds: a steady hiss and a 50 Hz mains hum. Seeded,
so the same call is the same file. Mono, 48 kHz, 16-bit WAV.

Besides the mixed signal it returns the voiced and the sibilant parts on their own, so a test can measure the
voice, the "s" sounds and the pauses separately."""

import wave
from pathlib import Path

import numpy as np

RATE = 48000


def make(seconds=8.0, seed=7, level_db=-26.0, hiss_db=-50.0, hum_db=-34.0):
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    t = np.arange(n) / RATE
    voice = np.zeros(n)
    sib = np.zeros(n)
    pos = 0.3
    while pos < seconds - 0.5:
        if rng.random() < 0.25:
            d = rng.uniform(0.08, 0.15)
            a, b = int(pos * RATE), int((pos + d) * RATE)
            spec = np.fft.rfft(rng.standard_normal(b - a))
            f = np.fft.rfftfreq(b - a, 1 / RATE)
            spec[(f < 5000) | (f > 9000)] = 0
            burst = np.fft.irfft(spec, b - a)
            sib[a:b] += burst / (np.std(burst) + 1e-9) * np.sin(np.linspace(0, np.pi, b - a)) * 0.5
            pos += d + 0.03
        d = rng.uniform(0.15, 0.3)
        a, b = int(pos * RATE), int((pos + d) * RATE)
        f0 = rng.uniform(105, 140)
        tt = t[a:b] - t[a]
        sig = np.zeros(b - a)
        formants = [(rng.uniform(500, 800), 1.0), (rng.uniform(1100, 1800), 0.5), (rng.uniform(2400, 3000), 0.25)]
        for k in range(1, 40):
            fk = f0 * k
            if fk > 5000:
                break
            g = sum(amp * np.exp(-((fk - fc) / 120.0) ** 2) for fc, amp in formants) + 0.02
            sig += g / k ** 0.5 * np.sin(2 * np.pi * fk * tt + rng.uniform(0, 6.28))
        voice[a:b] += sig * np.sin(np.linspace(0, np.pi, b - a)) ** 0.6 * rng.uniform(0.4, 1.0)
        pos += d + (rng.uniform(0.3, 0.7) if rng.random() < 0.2 else rng.uniform(0.02, 0.08))
    speech = voice / np.max(np.abs(voice)) + sib * 0.6
    gain = 10 ** (level_db / 20) / np.sqrt(np.mean(speech ** 2))
    hiss = rng.standard_normal(n) * 10 ** (hiss_db / 20)
    hum = np.sin(2 * np.pi * 50 * t) * np.sqrt(2) * 10 ** (hum_db / 20)
    return np.clip(speech * gain + hiss + hum, -1, 1), voice, sib


def write(path, seconds=8.0, **kw):
    """Write the recording to ``path`` (a WAV); returns (voice mask, sibilant mask) as boolean sample arrays."""
    x, voice, sib = make(seconds, **kw)
    with wave.open(str(Path(path)), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(RATE)
        f.writeframes((x * 32767).astype("<i2").tobytes())
    return np.abs(voice) > 1e-3, np.abs(sib) > 1e-3
