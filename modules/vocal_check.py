"""S6: is a Lyria song sung? The approved rule, the chunked separation it is measured with, and the client of the music-check
service that measures it.

THE RULE (docs/MEASUREMENT.md section 10, "Decision rule, approved 2026-11-28", set from run 46132895972: a smoke measurement,
n = 5). A song asked for as instrumental is refused as sung when ANY of these holds:

  1. ``returned_singing`` on Google's text block (modules/capabilities/google_interactions.py, unchanged);
  2. UMX: the share of seconds whose vocal stem is above -10 dB relative to the mix is at least 0.30;
  3. PANNs: the largest voice-class probability over 10 s windows is at least 0.10.

A refusal is an after-completion ``bad_response``: refunded (the hold is released, never captured), never retried on another
model. A detector that did not run, timed out or answered something unreadable is ``check_did_not_run``, and the song is refused
too (rules 4 and 5): an absent number is never read as "no vocals".

WHERE IT RUNS. The detectors (torch, about 360 MB of weights) never load in the creative worker. A separate service,
tools/music_check_server.py, runs tools/vocal_activity.py's own detectors on one song at a time, in a child process per song, and
answers two numbers. ``MusicCheckClient`` is the worker's side of that: it sends the MP3 bytes and reads the numbers back.

    NIGHTSHIFT_MUSIC_CHECK_URL         the service, e.g. http://music-check:8765 (unset: every Lyria job is refused before any call)
    NIGHTSHIFT_MUSIC_CHECK_TIMEOUT_S   how long one song's check may take, waiting for the service's lock included (default 900)

Nothing in this file imports torch or the measurement tool: the adapter imports it, and it must stay light.
"""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass
from typing import Callable, List, Mapping, Optional
from urllib.parse import urlsplit

import numpy as np

# ── the rule ──────────────────────────────────────────────────────────────────────

#: docs/MEASUREMENT.md section 10, run 46132895972. Positives 0.661 to 0.849, negatives 0.000 and 0.054 (the saxophone hard
#: negative N2): the threshold sits 5.6 times above the worst negative and 2.2 times below the weakest positive.
UMX_STEP_DB = -10.0
UMX_SHARE_REFUSED_AT = 0.30
#: Same section and run. Positives 0.201 to 0.351, negatives 0.032 and 0.039: 2.6 times above the worst negative, 2 times below
#: the weakest positive. The maximum over ALL voice classes, because the winning class is not reliable (P1 read Humming, P2 Speech).
PANNS_VOICE_MAX_REFUSED_AT = 0.10
MEASURED_IN_RUN = "46132895972"

#: The two numbers the service answers, by their wire names.
UMX_FIELD = "umx_share_above_minus10_db"
PANNS_FIELD = "panns_voice_max"

#: The job code of a check that did not run. Distinct from ``bad_response`` (it heard singing) so an operator sees which it was.
CHECK_DID_NOT_RUN = "check_did_not_run"


class CheckDidNotRun(Exception):
    """The vocal check has no numbers for this song. Never a verdict of "instrumental"."""


@dataclass(frozen=True)
class Signals:
    umx_share_above: float
    panns_voice_max: float


def _share(value, name: str) -> float:
    # bool is an int in Python: True must not read as a share of 1.0.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CheckDidNotRun(f"the {name} is missing or not a number")
    v = float(value)
    if not math.isfinite(v) or v < 0.0 or v > 1.0:
        raise CheckDidNotRun(f"the {name} is not a number between 0 and 1")
    return v


def parse_signals(obj) -> Signals:
    """The service's answer as ``Signals``, or ``CheckDidNotRun``. Both numbers must be there: one detector's number never
    stands in for the other's (each one alone separated the five samples, but the rule is both)."""
    if not isinstance(obj, Mapping):
        raise CheckDidNotRun("the music check answered something that is not a JSON object")
    return Signals(_share(obj.get(UMX_FIELD), "UMX vocal share"), _share(obj.get(PANNS_FIELD), "PANNs voice maximum"))


def signals_from_measurement(measured: Mapping) -> Signals:
    """The rule's two numbers out of ``tools/vocal_activity.measure()``'s result. A song whose every second is digital silence
    has no UMX share at all (ratio_summary says so), and that is a check that did not run, not a share of zero."""
    try:
        umx = measured["umx_vocal_to_mix"]["thresholds"][f"{UMX_STEP_DB:g}"]["share_above"]
    except (KeyError, TypeError):
        raise CheckDidNotRun("the UMX measurement has no share above -10 dB (every second silent, or no stem)") from None
    try:
        panns = measured["panns"]["voice_max"]
    except (KeyError, TypeError):
        raise CheckDidNotRun("the PANNs measurement has no voice maximum") from None
    return Signals(_share(umx, "UMX vocal share"), _share(panns, "PANNs voice maximum"))


def sung_by(signals: Signals) -> List[str]:
    """Which audio signals call this song sung (empty: neither). Pure: the thresholds above, nothing else."""
    out = []
    if signals.umx_share_above >= UMX_SHARE_REFUSED_AT:
        out.append(f"UMX vocal share above {UMX_STEP_DB:g} dB {signals.umx_share_above:.3f} >= {UMX_SHARE_REFUSED_AT:.2f}")
    if signals.panns_voice_max >= PANNS_VOICE_MAX_REFUSED_AT:
        out.append(f"PANNs voice maximum {signals.panns_voice_max:.3f} >= {PANNS_VOICE_MAX_REFUSED_AT:.2f}")
    return out


def refused_as_sung(returned_singing: bool, signals: Optional[Signals]) -> bool:
    """The whole rule. ``signals`` None means the audio check did not run, and that is never an acceptance."""
    if returned_singing:
        return True
    if signals is None:
        raise CheckDidNotRun("the audio check did not run")
    return bool(sung_by(signals))


# ── chunked separation ────────────────────────────────────────────────────────────

#: UMX holds the whole song's spectrogram and its LSTM state at once: 3.2 GB of peak RSS for a 3-minute song on the runner
#: (MEASUREMENT.md section 10). In 30 s windows the peak no longer grows with the song.
CHUNK_S = 30.0
#: The windows overlap by 5 s and are crossfaded there, so each model sees context on both sides of every seam and no second of
#: the song is measured only at a window's edge (where a bidirectional LSTM has context on one side only).
OVERLAP_S = 5.0


def _crossfade_weights(length: int, overlap: int, first: bool, last: bool) -> np.ndarray:
    """LINEAR ramps, so that in every overlap the two windows' weights add up to exactly 1. Linear and not equal-power because the
    two windows' stems in an overlap are two estimates of the SAME signal (correlated, nearly in phase): a linear fade keeps their
    amplitude, while an equal-power fade (whose squares add to 1) would lift a correlated signal by up to 3 dB mid-seam and read a
    seam as louder vocals than the song has. Equal-power is for joining two different signals."""
    w = np.ones(length, dtype=np.float64)
    ramp = (np.arange(overlap, dtype=np.float64) + 0.5) / overlap
    if not first:
        w[:overlap] = ramp
    if not last:
        w[length - overlap:] = 1.0 - ramp
    return w


def window_starts(n: int, size: int, overlap: int) -> List[int]:
    """Where each window starts. Every window is ``size`` long except the last, which ends at the song's end and is always longer
    than the overlap (so its fade-in lies inside it)."""
    if n <= size:
        return [0]
    hop = size - overlap
    starts = [0]
    while starts[-1] + size < n:
        starts.append(starts[-1] + hop)
    return starts


def chunked_separate(separate: Callable[[np.ndarray], np.ndarray], mix: np.ndarray, rate: int,
                     chunk_s: float = CHUNK_S, overlap_s: float = OVERLAP_S) -> np.ndarray:
    """``separate`` (a ``(channels, n) -> (channels, n)`` separator) run on overlapping windows of ``mix`` and stitched back with
    a linear crossfade. A window whose stem has the wrong shape or a non-finite sample fails the whole song: a stem with a hole in
    it would read as a quiet stretch, which is the wrong direction to be wrong in."""
    mix = np.asarray(mix)
    if mix.ndim != 2:
        raise ValueError("mix must be (channels, samples)")
    size, overlap = int(round(chunk_s * rate)), int(round(overlap_s * rate))
    if not 0 < overlap < size:
        raise ValueError("the overlap must be shorter than the window")
    n = mix.shape[1]
    starts = window_starts(n, size, overlap)
    if len(starts) == 1:
        return _checked(separate(mix), mix.shape)
    out = np.zeros(mix.shape, dtype=np.float64)
    for i, start in enumerate(starts):
        end = min(n, start + size)
        part = mix[:, start:end]
        stem = _checked(separate(np.ascontiguousarray(part)), part.shape)
        out[:, start:end] += stem * _crossfade_weights(end - start, overlap, i == 0, i == len(starts) - 1)
    return out.astype(mix.dtype if np.issubdtype(mix.dtype, np.floating) else np.float32)


def _checked(stem, shape) -> np.ndarray:
    stem = np.asarray(stem)
    if stem.shape != tuple(shape) or not np.isfinite(stem).all():
        # The measurement tool's own error type is not imported here (it would pull the tool into the adapter); the server
        # maps any exception of the measurement to "check did not run".
        raise CheckDidNotRun("the separator returned a window of the wrong shape or with non-finite samples")
    return stem


def chunked_separator(separate: Callable[[np.ndarray], np.ndarray], rate: int) -> Callable[[np.ndarray], np.ndarray]:
    """``separate`` made chunked, in the shape ``tools/vocal_activity.measure(separate=...)`` takes."""
    return lambda mix: chunked_separate(separate, mix, rate)


# ── the client ────────────────────────────────────────────────────────────────────

URL_ENV = "NIGHTSHIFT_MUSIC_CHECK_URL"
TIMEOUT_ENV = "NIGHTSHIFT_MUSIC_CHECK_TIMEOUT_S"
#: One 3-minute song took 17 to 27 s of UMX and 5.6 to 7.2 s of PANNs on a 2-core runner, plus a model load per song (the child
#: process). The creative worker runs up to 4 jobs at once and the service checks one song at a time, so a song may first wait
#: for three others: 900 s covers four songs of about a minute each with a margin of more than three times.
DEFAULT_TIMEOUT_S = 900.0
MIN_TIMEOUT_S, MAX_TIMEOUT_S = 30.0, 3600.0
CONNECT_TIMEOUT_S = 5.0
#: How long to wait before asking again when the service answers "busy" (another song holds its lock).
BUSY_RETRY_S = 3.0
NOT_CONFIGURED_REMEDY = (f"the music check is not configured on this worker: set {URL_ENV} to the music-check service "
                         "(tools/music_check_server.py); no Lyria song is made without it")


class MusicCheckNotReady(Exception):
    """The service cannot check a song now (unreachable, or not enough memory). Raised BEFORE anything is paid for."""


def timeout_from(env: Mapping[str, str]) -> float:
    raw = (env.get(TIMEOUT_ENV) or "").strip()
    if not raw:
        return DEFAULT_TIMEOUT_S
    try:
        v = float(raw)
    except ValueError:
        raise ValueError(f"{TIMEOUT_ENV} is not a number of seconds") from None
    if not math.isfinite(v) or not MIN_TIMEOUT_S <= v <= MAX_TIMEOUT_S:
        raise ValueError(f"{TIMEOUT_ENV} must be between {MIN_TIMEOUT_S:g} and {MAX_TIMEOUT_S:g} seconds")
    return v


def checked_url(raw: str) -> str:
    """``raw`` without a trailing slash when it is a plain http(s) address with a host and no user, query or fragment."""
    parts = urlsplit((raw or "").strip())
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password \
            or parts.query or parts.fragment:
        raise ValueError(f"{URL_ENV} must be an http(s) address such as http://music-check:8765")
    return f"{parts.scheme}://{parts.netloc}{parts.path.rstrip('/')}"


class MusicCheckClient:
    def __init__(self, url: str, *, timeout_s: float = DEFAULT_TIMEOUT_S, session=None,
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic):
        import requests

        self.url = checked_url(url)
        self.timeout_s = float(timeout_s)
        self.session = session if session is not None else requests.Session()
        # The service is on the worker's own network: no proxy from the environment may stand in front of it.
        self.session.trust_env = False
        self.sleep = sleep
        self.clock = clock

    @classmethod
    def from_env(cls, env: Mapping[str, str], **kw) -> Optional["MusicCheckClient"]:
        """None when the URL is not set. A URL or timeout that is set but malformed raises: a typo is not "not configured"."""
        raw = (env.get(URL_ENV) or "").strip()
        if not raw:
            return None
        return cls(raw, timeout_s=timeout_from(env), **kw)

    def ready(self) -> None:
        """Raises ``MusicCheckNotReady`` with the remedy unless the service answers that it can check a song now. A service that
        is busy with another song is ready (the song waits for the lock); one short of memory or out of reach is not."""
        try:
            r = self.session.get(self.url + "/ready", timeout=(CONNECT_TIMEOUT_S, 10.0), allow_redirects=False)
        except Exception as e:
            raise MusicCheckNotReady(f"the music-check service did not answer ({type(e).__name__}): start it, or fix "
                                     f"{URL_ENV}") from None
        body = _json(r)
        if r.status_code == 200 and isinstance(body, dict) and body.get("ready") is True:
            return
        remedy = body.get("remedy") if isinstance(body, dict) and isinstance(body.get("remedy"), str) else None
        raise MusicCheckNotReady((remedy or f"the music-check service is not ready (HTTP {r.status_code})")[:300])

    def measure(self, audio: bytes, mime: str = "audio/mpeg") -> Signals:
        """The song's two numbers, or ``CheckDidNotRun``. Waits (asking again) while the service is busy with another song,
        until the timeout; every other answer that is not the two numbers is a check that did not run."""
        import requests

        deadline = self.clock() + self.timeout_s
        while True:
            left = deadline - self.clock()
            if left <= 0:
                raise CheckDidNotRun(f"the music check did not answer within {self.timeout_s:g} s")
            try:
                r = self.session.post(self.url + "/check", data=audio, headers={"Content-Type": mime},
                                      timeout=(min(CONNECT_TIMEOUT_S, left), left), allow_redirects=False)
            except requests.exceptions.Timeout:
                raise CheckDidNotRun(f"the music check did not answer within {self.timeout_s:g} s") from None
            except Exception as e:
                raise CheckDidNotRun(f"the music-check service could not be reached ({type(e).__name__})") from None
            body = _json(r)
            if r.status_code == 503 and isinstance(body, dict) and body.get("code") == "busy":
                self.sleep(min(BUSY_RETRY_S, max(0.0, deadline - self.clock())))
                continue
            if r.status_code != 200:
                code = body.get("code") if isinstance(body, dict) and isinstance(body.get("code"), str) else None
                remedy = body.get("remedy") if isinstance(body, dict) and isinstance(body.get("remedy"), str) else None
                said = "; ".join(x[:200] for x in (code, remedy) if x)
                raise CheckDidNotRun(f"the music check answered HTTP {r.status_code}" + (f" ({said})" if said else ""))
            return parse_signals(body)


def _json(r):
    try:
        return json.loads(r.content[:65536].decode("utf-8")) if r.content and len(r.content) <= 65536 else None
    except (ValueError, UnicodeDecodeError):
        return None
