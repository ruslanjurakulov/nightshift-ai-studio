"""The AITuber presenter through fal.ai (``NIGHTSHIFT_AVATAR_PROVIDER=fal``).

Why this exists: Higgsfield credits are a monthly commitment, fal.ai is prepaid and
pay-per-second. The presenter is the only part of a run that is optional AND
expensive, so this provider is built around not spending:

* **Audio-driven, short.** The avatar model animates a portrait to a piece of
  speech. Only an intro slice and an outro slice of the narration get a face
  (default 15 s each, at most 30 s each); the rest of the video stays faceless.
* **A ceiling, checked first.** Seconds and USD are compared with their caps
  before the first request of any kind (the portrait included). Over a cap is
  ``AvatarUnavailable`` and nothing was sent.
* **Ledgered before it can be lost.** The planned slice seconds are written to the
  cost ledger as an explicit estimate (``avatar_seconds``, stage ``avatar:fal``) the
  moment fal says a request is COMPLETED, before the result is fetched or the video
  downloaded, so a failure after that point never leaves paid-for work unrecorded.
  A request whose submit answer was lost, or that timed out while running, is
  recorded at the planned amount under stage ``avatar:fal:unconfirmed`` (it may or
  may not have been billed; counting it is the safe error). fal's reported
  ``duration`` is never used for the ledger, so an odd value cannot inflate it.
* **Resumable, never resubmitted.** The request id and its URLs are saved beside the
  clip before polling starts. A rerun of the same run polls and fetches that request
  instead of submitting (and paying for) another. Result fetch and download are
  retried a few times with a short backoff.
* **Contained.** Every URL the server hands back must be https on a fal host, the key
  goes only to ``queue.fal.run`` and ``rest.fal.ai``, redirects are never followed, and
  a download is capped at 200 MB.
* **Synthetic only.** ``synthetic_only_guard`` runs before anything else. The
  portrait is generated from the character description; no photo is ever sent.

What was checked against fal.ai's published schema (2026-10, not by a live call):
the queue host ``queue.fal.run``, ``POST /<model id>`` taking ``image_url`` and
``audio_url`` (both required) and ``prompt``, the ``IN_QUEUE`` / ``IN_PROGRESS`` /
``COMPLETED`` statuses with ``status_url`` / ``response_url`` / ``cancel_url`` in the
submit response, a failure also being ``COMPLETED`` (the result call carries the
error), the result ``{"video": {"url"}, "duration"}``, the two-step CDN upload
(``POST rest.fal.ai/storage/upload/initiate`` giving ``upload_url`` and
``file_url``, then a PUT of the bytes) and ``$0.0562`` per output second for the
default model. Follow-up URLs (status, result, cancel) use only ``owner/app``
(``fal-ai/kling-video``): adding the endpoint path returns 405, so the fallback used
when a submit answer omits them is built that way. Nothing here was run against the
live service.

fal's CDN is public by link. Every upload (the portrait and the narration slice, which
is unpublished speech) is therefore sent with the documented
``X-Fal-Object-Lifecycle-Preference`` header asking for an expiry of one hour, and the
submit asks for the output to expire in a day. The header is from fal's file-access
documentation; it has NOT been verified against the live service, so treat the files
as link-public until it has been seen to work.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, Optional, Tuple
from urllib.parse import urlsplit

from modules.avatar import (
    AvatarUnavailable,
    PresenterSegment,
    synthetic_only_guard,
)

logger = logging.getLogger(__name__)

#: Kling AI Avatar v2 Standard: the cheaper tier ($0.0562 per output second on its model page).
DEFAULT_MODEL = "fal-ai/kling-video/ai-avatar/v2/standard"
#: The portrait: FLUX.1 schnell, $0.003 per megapixel on its model page.
DEFAULT_IMAGE_MODEL = "fal-ai/flux/schnell"

QUEUE_BASE = "https://queue.fal.run"
REST_BASE = "https://rest.fal.ai"

#: The only hosts the FAL_KEY is ever sent to.
KEY_HOSTS = ("queue.fal.run", "rest.fal.ai")
#: Every host a server-supplied URL may name (the host itself or a subdomain of it).
#: One place, kept small: the queue, the REST/storage API, and the CDN/run domains.
FAL_HOSTS = KEY_HOSTS + ("fal.run", "fal.media")

#: A downloaded presenter clip larger than this is refused (a 30 s clip is a few MB).
MAX_VIDEO_BYTES = 200 * 1024 * 1024
#: Result fetch and download are tried this many times, with a doubling backoff.
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_S = 2.0
#: How long fal keeps what we upload / what it renders (documented lifecycle header).
INPUT_EXPIRY_S = 3600
OUTPUT_EXPIRY_S = 86400
_LIFECYCLE_HEADER = "X-Fal-Object-Lifecycle-Preference"
_TRANSIENT_STATUS = (429, 500, 502, 503, 504)

#: Ledger unit for presenter seconds. Kept out of cost_ledger's priced units on
#: purpose: the price is the avatar's own setting (below), not CHRONOS_PRICE_*.
AVATAR_SECONDS = "avatar_seconds"
LEDGER_STAGE = "avatar:fal"

# Settings, all optional. Every one is a repository VARIABLE (never a secret).
MODEL_ENV = "NIGHTSHIFT_AVATAR_FAL_MODEL"
IMAGE_MODEL_ENV = "NIGHTSHIFT_AVATAR_FAL_IMAGE_MODEL"
INTRO_ENV = "NIGHTSHIFT_AVATAR_INTRO_SECONDS"
OUTRO_ENV = "NIGHTSHIFT_AVATAR_OUTRO_SECONDS"
MAX_SECONDS_ENV = "NIGHTSHIFT_AVATAR_MAX_SECONDS"
PRICE_ENV = "NIGHTSHIFT_AVATAR_FAL_USD_PER_SECOND"
MAX_USD_ENV = "NIGHTSHIFT_AVATAR_MAX_USD"

DEFAULT_SEGMENT_SECONDS = 15.0
#: No segment may be longer than this, whatever the variable says.
SEGMENT_HARD_CAP_SECONDS = 30.0
DEFAULT_MAX_SECONDS = 30.0
#: No run may buy more presenter seconds than this, whatever the variable says.
RUN_HARD_CAP_SECONDS = 60.0
#: An estimate for fal's price per output second; the model page quotes $0.0562.
DEFAULT_USD_PER_SECOND = 0.06
#: The default model's published price: the ledger and the caps never use less for it.
DEFAULT_MODEL_USD_PER_SECOND = 0.0562
#: No avatar model costs less than this per output second; a lower setting is a mistake.
MIN_USD_PER_SECOND = 0.01
#: A generous upper bound for the one portrait (about $0.003 on the default model).
PORTRAIT_USD = 0.01
#: A slice shorter than this is not sent: fal's minimum audio length is not
#: published, so a sliver is skipped rather than paid for and possibly refused.
MIN_SEGMENT_SECONDS = 2.0

_VIDEO_PROMPT = "A presenter speaking naturally to the camera, with small natural head movement."
_PORTRAIT_PROMPT = (
    "Front-facing head-and-shoulders portrait of an invented, stylized character, looking at the "
    "camera with a closed relaxed mouth, plain uncluttered background, soft even lighting. "
    "Character: {character}"
)
_DEFAULT_CHARACTER = "a friendly, approachable presenter in a smart casual outfit"


# -- settings ---------------------------------------------------------------

def _number(env: Mapping[str, str], name: str, default: float, *, minimum: float,
            maximum: Optional[float] = None, allow_zero: bool = False) -> float:
    """A positive finite number from ``name``; empty means ``default``. A value that
    is not a number, is not finite or is out of range is refused with a warning and
    the default stays (a typo must never remove a brake). Above ``maximum`` it is
    clamped down to it."""
    raw = str(env.get(name, "") or "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        value = float("nan")
    if not math.isfinite(value) or value < 0 or (value == 0 and not allow_zero) or (0 < value < minimum):
        logger.warning("%s=%r is not a usable number; using the default %s", name, raw, default)
        return default
    if maximum is not None and value > maximum:
        logger.warning("%s=%s is above the hard cap %s; using the cap", name, raw, maximum)
        return maximum
    return value


_WARNED: set = set()


def _warn_once(message: str) -> None:
    """A loud warning, once per distinct message per process (settings are read many times)."""
    if message not in _WARNED:
        _WARNED.add(message)
        logger.warning(message)


@dataclass(frozen=True)
class FalAvatarSettings:
    model: str
    image_model: str
    intro_seconds: float
    outro_seconds: float
    max_seconds: float
    usd_per_second: float
    max_usd: float

    @staticmethod
    def from_env(env: Optional[Mapping[str, str]] = None) -> "FalAvatarSettings":
        env = os.environ if env is None else env
        max_seconds = _number(env, MAX_SECONDS_ENV, DEFAULT_MAX_SECONDS, minimum=0.0,
                              maximum=RUN_HARD_CAP_SECONDS)
        price = _number(env, PRICE_ENV, DEFAULT_USD_PER_SECOND, minimum=0.0)
        model = str(env.get(MODEL_ENV, "") or "").strip().strip("/") or DEFAULT_MODEL
        price_set = bool(str(env.get(PRICE_ENV, "") or "").strip())
        if price < MIN_USD_PER_SECOND:
            _warn_once(f"{PRICE_ENV}={price:g} is below any real price (floor ${MIN_USD_PER_SECOND:g}/s): the "
                       f"floor is used. A price set too low makes the ledger and the USD caps understate real spend.")
            price = MIN_USD_PER_SECOND
        if model == DEFAULT_MODEL:
            # The published price is a floor for its own model: a stale low setting cannot hide spend.
            price = max(price, DEFAULT_MODEL_USD_PER_SECOND)
        elif not price_set:
            _warn_once(f"{MODEL_ENV}={model} is not the default model and {PRICE_ENV} is not set: the assumed "
                       f"${price:g}/s is the default model's price, so the ledger and the USD caps may understate "
                       f"real spend. Set {PRICE_ENV} to this model's price on fal.ai.")
        return FalAvatarSettings(
            model=model,
            image_model=(str(env.get(IMAGE_MODEL_ENV, "") or "").strip().strip("/") or DEFAULT_IMAGE_MODEL),
            intro_seconds=_number(env, INTRO_ENV, DEFAULT_SEGMENT_SECONDS, minimum=0.0,
                                  maximum=SEGMENT_HARD_CAP_SECONDS, allow_zero=True),
            outro_seconds=_number(env, OUTRO_ENV, DEFAULT_SEGMENT_SECONDS, minimum=0.0,
                                  maximum=SEGMENT_HARD_CAP_SECONDS, allow_zero=True),
            max_seconds=max_seconds,
            usd_per_second=price,
            # Derived from the seconds cap and the price unless the operator pins it lower or higher.
            max_usd=_number(env, MAX_USD_ENV, round(max_seconds * price + PORTRAIT_USD, 6), minimum=0.0),
        )

    def planned_seconds(self) -> float:
        return self.intro_seconds + self.outro_seconds

    def planned_usd(self, seconds: Optional[float] = None) -> float:
        s = self.planned_seconds() if seconds is None else seconds
        return round(s * self.usd_per_second + PORTRAIT_USD, 6)


def check_ceilings(settings: FalAvatarSettings, seconds: float) -> None:
    """Raise ``AvatarUnavailable`` when ``seconds`` of presenter would break the
    seconds cap or the USD cap. Pure arithmetic: called before any request."""
    if seconds > settings.max_seconds + 1e-9:
        raise AvatarUnavailable(
            f"The fal presenter would render {seconds:g} s but {MAX_SECONDS_ENV} allows {settings.max_seconds:g} s "
            f"per run (hard cap {RUN_HARD_CAP_SECONDS:g} s). Nothing was sent or spent. Lower "
            f"{INTRO_ENV}/{OUTRO_ENV} or raise {MAX_SECONDS_ENV}."
        )
    usd = settings.planned_usd(seconds)
    if usd > settings.max_usd + 1e-9:
        raise AvatarUnavailable(
            f"The fal presenter would cost about ${usd:.2f} ({seconds:g} s at ${settings.usd_per_second:g}/s plus the "
            f"portrait) but {MAX_USD_ENV} allows ${settings.max_usd:.2f}. Nothing was sent or spent. Lower "
            f"{INTRO_ENV}/{OUTRO_ENV} or raise {MAX_USD_ENV}."
        )


def plan_slices(narration_seconds: float, settings: FalAvatarSettings) -> list:
    """``[(label, start, seconds), ...]``: the intro from the start of the narration and
    the outro ending where it ends, never overlapping, none shorter than
    ``MIN_SEGMENT_SECONDS``. A short narration gets what fits (the whole of it, once)."""
    n = max(0.0, float(narration_seconds))
    plan = []
    intro = min(settings.intro_seconds, n)
    if intro >= MIN_SEGMENT_SECONDS:
        plan.append(("intro", 0.0, intro))
    else:
        intro = 0.0
    outro = min(settings.outro_seconds, n - intro)
    if outro >= MIN_SEGMENT_SECONDS:
        plan.append(("outro", round(n - outro, 3), outro))
    return plan


# -- audio ------------------------------------------------------------------

class PydubAudio:
    """Length and slicing of the narration. pydub decodes through ffmpeg, which the
    audio stage already needs; tests pass a fake instead."""

    def length_s(self, path: Path) -> float:
        from pydub import AudioSegment

        return len(AudioSegment.from_file(str(path))) / 1000.0

    def cut(self, path: Path, start_s: float, end_s: float, dest: Path) -> Path:
        from pydub import AudioSegment

        segment = AudioSegment.from_file(str(path))[int(start_s * 1000):int(end_s * 1000)]
        dest.parent.mkdir(parents=True, exist_ok=True)
        segment.export(str(dest), format="mp3", bitrate="128k")
        return dest


def _default_portrait(prompt: str, dest: Path, width: int, height: int, image_model: str,
                      api_key: str) -> Optional[Path]:
    """The portrait through the existing fal image client (same FAL_KEY, same endpoint)."""
    from modules import image_providers

    client = image_providers.FalImageClient(api_key=api_key)
    client.model = image_model
    try:
        return client.generate(prompt, dest, width=width, height=height)
    except image_providers.ImageProviderUnavailable as e:
        raise AvatarUnavailable(f"The presenter portrait was refused: {e}") from e


# -- URLs the server hands back ---------------------------------------------

_SAFE_URL = re.compile(r"[\x21-\x5b\x5d-\x7e]+")  # printable ASCII, no space, no backslash
_HOSTNAME = re.compile(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*")


def _urllib3_host(url: str) -> Optional[str]:
    """The host urllib3 (what ``requests`` connects with) reads from ``url``."""
    from urllib3.util import parse_url

    try:
        host = parse_url(url).host
    except Exception:  # LocationParseError and friends: not a URL we can vouch for
        return None
    return host.lower() if host else None


def checked_url(url, what: str, *, key_host: bool = False) -> str:
    """A server-supplied URL, or ``AvatarUnavailable``. It must be https, on a fal host,
    without credentials or an odd port. ``key_host`` (status, result, cancel) must be
    exactly a host the FAL_KEY may be sent to. A link that points anywhere else is a
    sign something is wrong, and the key (or the work) is not handed to it."""
    parts, host, port, userinfo = None, "", None, False
    # Printable ASCII only, no whitespace, no backslash: those are exactly the characters on which
    # two URL parsers disagree about the host (`https://evil.com\\.fal.media` is "evil.com" to the
    # connection library and ".fal.media" to urlsplit), so they are refused outright.
    if isinstance(url, str) and _SAFE_URL.fullmatch(url):
        try:
            parts = urlsplit(url)
            host = (parts.hostname or "").lower()
            port = parts.port
            userinfo = bool(parts.username or parts.password)
            # The host the HTTP library will really connect to must be the one just read.
            if not _HOSTNAME.fullmatch(host) or _urllib3_host(url) != host:
                parts, host = None, ""
        except ValueError:
            parts, host, port, userinfo = None, "", None, False
    if key_host:
        host_ok = host in KEY_HOSTS
    else:
        host_ok = any(host == h or host.endswith("." + h) for h in FAL_HOSTS)
    if not (parts and parts.scheme == "https" and host_ok and port in (None, 443) and not userinfo):
        raise AvatarUnavailable(
            f"fal.ai returned a {what} that is not an https address on a fal.ai host "
            f"({(host or 'unparsable')!r}); it was not used and no key was sent to it."
        )
    return url


class _Network(AvatarUnavailable):
    """The connection failed or timed out: the request may or may not have arrived."""


class _Transient(Exception):
    """A step that is worth trying again (retried by ``_retry``)."""


# -- the provider -----------------------------------------------------------

SpendHook = Callable[[str, float, str, Optional[float]], None]


class FalAvatarProvider:
    """Presenter clips (intro and outro) from fal.ai's queue API. See the module docstring."""

    def __init__(self, *, session=None, audio=None, portrait=None, sleep=time.sleep,
                 monotonic=time.monotonic, poll_interval: float = 5.0, timeout_s: float = 600.0,
                 env: Optional[Mapping[str, str]] = None):
        self._session = session
        self.audio = audio or PydubAudio()
        self._portrait = portrait or _default_portrait
        self._sleep = sleep
        self._monotonic = monotonic
        self.poll_interval = poll_interval
        self.timeout_s = timeout_s
        self._env = env

    # configuration ---------------------------------------------------------
    def _environ(self) -> Mapping[str, str]:
        return os.environ if self._env is None else self._env

    def settings(self) -> FalAvatarSettings:
        return FalAvatarSettings.from_env(self._environ())

    def _key(self) -> str:
        return str(self._environ().get("FAL_KEY", "") or "").strip()

    @property
    def session(self):
        if self._session is None:
            import requests  # local: the module is importable (settings, plan) without it

            self._session = requests.Session()
        return self._session

    def preflight(self) -> None:
        """No request. Raises ``AvatarUnavailable`` for a missing key or a configured
        presenter that already breaks a ceiling."""
        if not self._key():
            raise AvatarUnavailable(
                "The fal.ai presenter is not configured. Set FAL_KEY (a repository SECRET; the same key the fal "
                "image provider uses) and top up the fal.ai account, which is prepaid. The model defaults to "
                f"{DEFAULT_MODEL} (override with {MODEL_ENV}). No presenter is generated until then."
            )
        s = self.settings()
        if s.planned_seconds() <= 0:
            raise AvatarUnavailable(
                f"The fal presenter is on but {INTRO_ENV} and {OUTRO_ENV} are both 0: there is nothing to render. "
                "Set one of them, or turn NIGHTSHIFT_AVATAR_ENABLED off."
            )
        check_ceilings(s, s.planned_seconds())

    def generate(self, prompt, character_ref, out_path):
        # The Higgsfield-shaped call has no narration to drive the face with.
        synthetic_only_guard(character_ref, prompt)
        raise AvatarUnavailable("The fal presenter is audio-driven: it needs the narration. Use generate_segments().")

    # the work --------------------------------------------------------------
    def generate_segments(self, prompt: str, character_ref: Optional[str], out_path: Path, *,
                          narration_path: Path, frame_size: Tuple[int, int] = (1280, 720),
                          on_spend: Optional[SpendHook] = None) -> list:
        # 1) Safety first: a real-person request never reaches the network.
        synthetic_only_guard(character_ref, prompt)
        self.preflight()
        settings = self.settings()
        out_dir = Path(out_path).parent
        narration_path = Path(narration_path)

        try:
            narration_s = self.audio.length_s(narration_path)
        except Exception as e:
            raise AvatarUnavailable(f"Could not read the narration {narration_path.name} "
                                    f"({type(e).__name__}: {e}); no presenter was generated.") from e
        plan = plan_slices(narration_s, settings)
        if not plan:
            raise AvatarUnavailable(
                f"The narration is {narration_s:.1f} s, too short for a presenter slice "
                f"(minimum {MIN_SEGMENT_SECONDS:g} s). Turn NIGHTSHIFT_AVATAR_ENABLED off for such videos."
            )
        # 2) The ceiling, before the first request of any kind.
        check_ceilings(settings, sum(seconds for _label, _start, seconds in plan))

        _require_writable(out_dir)  # a full or read-only disk stops the run before the portrait is bought
        headers = {"Authorization": f"Key {self._key()}"}
        portrait = self._make_portrait(prompt, out_dir, frame_size, settings, on_spend)
        portrait_hash = hashlib.sha256(portrait.read_bytes()).hexdigest()
        portrait_url = None

        segments = []
        for name, start, seconds in plan:
            clip_path = out_dir / f"presenter_{name}.mp4"
            try:
                audio_file = Path(self.audio.cut(narration_path, start, start + seconds,
                                                 out_dir / f"presenter_{name}.mp3"))
                audio_bytes = audio_file.read_bytes()
            except OSError as e:
                raise AvatarUnavailable(f"Could not write the {name} audio slice ({_why(e)}); nothing was "
                                        "submitted.") from None
            key = hashlib.sha256(audio_bytes + portrait_hash.encode() + settings.model.encode()).hexdigest()
            state = _load_state(clip_path, key)
            if state.get("done") is True and clip_path.exists() and clip_path.stat().st_size > 0:
                logger.info("Presenter %s reused from an earlier attempt (nothing billed)", name)
            else:
                def inputs():
                    nonlocal portrait_url
                    if portrait_url is None:
                        portrait_url = self._upload(portrait.read_bytes(), "image/png", portrait.name, headers)
                    return portrait_url, self._upload(audio_bytes, "audio/mpeg", audio_file.name, headers)

                self._make_clip(settings, headers, clip_path, state, seconds, inputs, on_spend)
            segments.append(PresenterSegment(path=clip_path, start=start, seconds=seconds))
        return segments

    def _make_portrait(self, prompt, out_dir: Path, frame_size, settings, on_spend) -> Path:
        """The synthetic portrait. Reused only when it was made from this same character
        description, model and frame shape: a changed character gets a new face."""
        portrait = out_dir / "presenter_portrait.png"
        width, height = frame_size
        description = (prompt or "").strip() or _DEFAULT_CHARACTER
        full_prompt = _PORTRAIT_PROMPT.format(character=description)
        key = hashlib.sha256(f"{full_prompt}|{settings.image_model}|{width}x{height}".encode()).hexdigest()
        if portrait.exists() and portrait.stat().st_size > 0 and _load_state(portrait, key).get("done"):
            return portrait
        try:
            made = self._portrait(full_prompt, portrait, width, height, settings.image_model, self._key())
        except OSError as e:
            raise AvatarUnavailable(f"Could not write the presenter portrait ({_why(e)}); nothing was "
                                    "submitted.") from None
        if not made or not Path(made).exists() or Path(made).stat().st_size <= 0:
            raise AvatarUnavailable("The presenter portrait could not be generated (fal.ai returned no image); "
                                    "no presenter was generated.")
        if on_spend:
            on_spend("image_generations", 1.0, "image:fal", PORTRAIT_USD)
        _persist(portrait, {"key": key, "done": True}, "the portrait note")
        return portrait

    # one clip --------------------------------------------------------------
    def _make_clip(self, settings, headers, clip_path: Path, state: dict, seconds: float, inputs, on_spend) -> None:
        """Submit (or resume), wait, fetch, download. The spend is ledgered the moment fal says
        COMPLETED, and the request is saved before polling, so no failure after paying
        leaves the money unrecorded or makes a rerun pay again."""
        req = _valid_request(state.get("request"))
        if "request" in state and req is None:
            # Whatever a damaged or hand-edited sidecar holds is not a request we can resume.
            logger.warning("Ignoring a malformed saved fal.ai request for %s; a new one will be submitted",
                           clip_path.name)
            state.pop("request", None)
            state["ledgered"] = False
        if req:
            logger.info("Resuming fal.ai request %s from an earlier attempt (nothing is submitted again)",
                        req["id"])
        else:
            # A placeholder first: a full or read-only disk must stop the run BEFORE anything is
            # uploaded or submitted, not after money is spent and the request id is lost.
            _persist(clip_path, state, "the presenter state")
            image_url, audio_url = inputs()
            req = self._submit(settings, headers, image_url, audio_url, seconds, on_spend)
            state["request"], state["ledgered"] = req, False
            try:
                _save_state(clip_path, state)  # BEFORE polling: a crash from here on can resume, not resubmit
            except OSError as e:
                # Accepted, but its id cannot be kept: cancel it, count it as spent, and stop. Never a raw OSError.
                self._cancel(req["cancel_url"], headers)
                self._record(on_spend, settings, seconds, unconfirmed=True)
                raise AvatarUnavailable(
                    f"fal.ai accepted the request but its id could not be saved ({_why(e)}), so it cannot be "
                    "resumed. It was cancelled and MAY STILL BE BILLED (recorded in the cost ledger as "
                    "unconfirmed). Free disk space or fix the permissions, then rerun."
                ) from None

        self._wait(req, settings, headers, clip_path, state, seconds, on_spend)
        if state.get("ledgered") is not True:
            self._record(on_spend, settings, seconds)
            state["ledgered"] = True
            _persist(clip_path, state, "the presenter state")

        try:
            url = self._retry("result", lambda: self._fetch_result(req, headers))
            self._retry("download", lambda: self._download(url, clip_path))
        except _Final as e:
            # The request itself is unusable (not a hiccup): a rerun must submit afresh.
            self._forget(clip_path, state)
            raise AvatarUnavailable(str(e)) from None
        state["done"] = True
        _persist(clip_path, state, "the presenter state")

    def _record(self, on_spend, settings, seconds: float, *, unconfirmed: bool = False) -> None:
        if on_spend:
            on_spend(AVATAR_SECONDS, seconds, LEDGER_STAGE + (":unconfirmed" if unconfirmed else ""),
                     round(seconds * settings.usd_per_second, 6))

    def _submit(self, settings, headers, image_url: str, audio_url: str, seconds: float, on_spend) -> dict:
        body = {"image_url": image_url, "audio_url": audio_url, "prompt": _VIDEO_PROMPT}
        lost = ("fal.ai submit got no usable answer, so the request MAY HAVE BEEN ACCEPTED AND BILLED "
                f"(recorded in the cost ledger as unconfirmed, about {seconds:g} s). A rerun submits again.")
        try:
            resp = self._request("post", f"{QUEUE_BASE}/{settings.model}", "submit", json=body,
                                 headers={**headers, _LIFECYCLE_HEADER: _lifecycle(OUTPUT_EXPIRY_S)}, timeout=30)
        except _Network:
            self._record(on_spend, settings, seconds, unconfirmed=True)
            raise AvatarUnavailable(lost) from None
        if resp.status_code >= 500:
            self._record(on_spend, settings, seconds, unconfirmed=True)
            raise AvatarUnavailable(f"{lost} (HTTP {resp.status_code})")
        if not 200 <= resp.status_code < 300:
            raise self._refused("submit", resp)  # a refusal: nothing was accepted, nothing was billed
        try:
            data = _json(resp, "submit")
            request_id = data.get("request_id")
            if not request_id or not isinstance(request_id, str):
                raise AvatarUnavailable("fal.ai submit returned no request_id")
            base = f"{QUEUE_BASE}/{'/'.join(settings.model.split('/')[:2])}/requests/{request_id}"
            return {
                "id": request_id,
                "status_url": checked_url(data.get("status_url") or f"{base}/status", "status_url", key_host=True),
                "response_url": checked_url(data.get("response_url") or base, "response_url", key_host=True),
                "cancel_url": checked_url(data.get("cancel_url") or f"{base}/cancel", "cancel_url", key_host=True),
            }
        except AvatarUnavailable as e:
            self._record(on_spend, settings, seconds, unconfirmed=True)
            raise AvatarUnavailable(f"{e}. {lost}") from None

    def _wait(self, req: dict, settings, headers, clip_path: Path, state: dict, seconds: float, on_spend) -> None:
        deadline = self._monotonic() + self.timeout_s
        failures = 0
        last = ""
        while True:
            try:
                poll = self._request("get", checked_url(req["status_url"], "status_url", key_host=True),
                                     "status check", headers=headers, timeout=30)
            except _Network:
                # A dropped connection says nothing about a job that is already running (and billing).
                if failures >= 3:
                    raise
                failures += 1
                poll = None
            if poll is None:
                pass
            elif 200 <= poll.status_code < 300:
                failures = 0
                try:
                    data = _json(poll, "status check")
                except AvatarUnavailable as e:
                    self._abandon(req, headers, clip_path, state, settings, seconds, on_spend, last, str(e))
                last = str(data.get("status") or "").upper()
                if last == "COMPLETED":
                    if data.get("error"):
                        self._forget(clip_path, state)
                        raise AvatarUnavailable(f"fal.ai request {req['id']} failed: {data.get('error')}")
                    return
            elif poll.status_code in _TRANSIENT_STATUS and failures < 3:
                failures += 1
            else:
                if poll.status_code in (404, 410):
                    self._forget(clip_path, state)  # gone (expired): a rerun submits a new one
                raise self._refused("status check", poll)
            if self._monotonic() >= deadline:
                self._abandon(req, headers, clip_path, state, settings, seconds, on_spend, last,
                              f"fal.ai request {req['id']} did not finish in {self.timeout_s:g} s")
            self._sleep(self.poll_interval)

    def _abandon(self, req, headers, clip_path, state, settings, seconds, on_spend, last_status, reason):
        """Give up on a request: cancel it (best effort), count it as unconfirmed spend when it had
        started running, forget it so a rerun starts clean, and stop with the reason."""
        self._cancel(req["cancel_url"], headers)
        started = last_status == "IN_PROGRESS"
        if started:
            self._record(on_spend, settings, seconds, unconfirmed=True)
        self._forget(clip_path, state)
        raise AvatarUnavailable(
            f"{reason}; cancelled." + (" It had started, so it MAY STILL BE BILLED (recorded in the cost ledger "
                                       "as unconfirmed)." if started else "") + " No presenter was generated."
        )

    @staticmethod
    def _forget(clip_path: Path, state: dict) -> None:
        state.pop("request", None)
        state["ledgered"] = False
        try:
            _save_state(clip_path, state)
        except OSError as e:  # the error being raised by the caller matters more than this note
            logger.warning("Could not update the presenter state (%s); a rerun may find a stale request", _why(e))

    def _fetch_result(self, req: dict, headers: dict) -> str:
        try:
            result = self._request("get", checked_url(req["response_url"], "response_url", key_host=True),
                                   "result", headers=headers, timeout=30)
        except _Network as e:
            raise _Transient(str(e)) from None
        if result.status_code in _TRANSIENT_STATUS:
            raise _Transient(f"HTTP {result.status_code}")
        if not 200 <= result.status_code < 300:
            raise _Final(str(self._refused("result", result)))
        try:
            data = _json(result, "result")
        except AvatarUnavailable as e:
            raise _Final(str(e)) from None
        video = data.get("video")
        url = video.get("url") if isinstance(video, dict) else None
        if not url:
            raise _Final(f"fal.ai request {req['id']} finished with no video url")
        try:
            return checked_url(url, "video url")
        except AvatarUnavailable as e:
            raise _Final(str(e)) from None

    def _download(self, url: str, dest: Path) -> None:
        import requests

        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + ".part")
        try:
            resp = self._request("get", url, "download", stream=True, timeout=120)
        except _Network as e:
            raise _Transient(str(e)) from None
        if resp.status_code in _TRANSIENT_STATUS:
            raise _Transient(f"HTTP {resp.status_code}")
        if not 200 <= resp.status_code < 300:
            raise _Final(str(self._refused("download", resp)))
        try:
            declared = int((getattr(resp, "headers", None) or {}).get("Content-Length") or 0)
        except (TypeError, ValueError):
            declared = 0
        if declared > MAX_VIDEO_BYTES:
            raise _Final(f"fal.ai video is {declared} bytes, over the {MAX_VIDEO_BYTES} byte limit; not downloaded.")
        size = 0
        try:
            with open(part, "wb") as fh:
                for chunk in resp.iter_content(chunk_size=1 << 16):
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > MAX_VIDEO_BYTES:
                        raise _Final(f"fal.ai video is over the {MAX_VIDEO_BYTES} byte limit; download stopped.")
                    fh.write(chunk)
        except requests.RequestException as e:
            part.unlink(missing_ok=True)
            raise _Transient(type(e).__name__) from None
        except _Final:
            part.unlink(missing_ok=True)
            raise
        if size <= 0:
            part.unlink(missing_ok=True)
            raise _Final("fal.ai returned an empty video file; no presenter was generated.")
        os.replace(part, dest)

    def _retry(self, what: str, attempt):
        last = ""
        for i in range(RETRY_ATTEMPTS):
            try:
                return attempt()
            except _Transient as e:
                last = str(e)
                if i + 1 < RETRY_ATTEMPTS:
                    self._sleep(RETRY_BACKOFF_S * (2 ** i))
        raise AvatarUnavailable(
            f"fal.ai {what} failed {RETRY_ATTEMPTS} times ({last}). The request had already completed and is "
            "recorded in the cost ledger; a rerun of this run resumes it without paying again."
        )

    # HTTP ------------------------------------------------------------------
    def _refused(self, what: str, resp) -> AvatarUnavailable:
        """A non-2xx answer as an ``AvatarUnavailable`` that names the fix. Never carries the key."""
        from modules import image_providers

        status = getattr(resp, "status_code", None)
        category = image_providers.refusal_category(_HttpError(resp))
        if category:
            reason, remedy = image_providers._REFUSALS[category]
            return AvatarUnavailable(f"fal.ai {what}: it {reason} (HTTP {status}). Fix: {remedy}")
        detail = (getattr(resp, "text", "") or "")[:200].replace("\n", " ")
        return AvatarUnavailable(f"fal.ai {what} failed (HTTP {status}): {detail}")

    def _request(self, method: str, url: str, what: str, **kw):
        """One HTTP call. Redirects are never followed (a redirect would carry the key, or the
        work, to a host that was not checked); a connection failure is ``_Network``."""
        import requests

        try:
            return getattr(self.session, method)(url, allow_redirects=False, **kw)
        except requests.RequestException as e:
            raise _Network(f"fal.ai {what} failed ({type(e).__name__})") from e

    def _cancel(self, cancel_url: str, headers: dict) -> None:
        try:
            self.session.put(checked_url(cancel_url, "cancel_url", key_host=True), headers=headers, timeout=30,
                             allow_redirects=False)
        except Exception as e:  # best effort: the error that follows is the news
            logger.warning("fal.ai cancel failed (%s)", type(e).__name__)

    def _upload(self, data: bytes, content_type: str, file_name: str, headers: dict) -> str:
        resp = self._request("post", f"{REST_BASE}/storage/upload/initiate?storage_type=fal-cdn-v3", "upload",
                             json={"file_name": file_name, "content_type": content_type},
                             headers={**headers, _LIFECYCLE_HEADER: _lifecycle(INPUT_EXPIRY_S)}, timeout=30)
        if not 200 <= resp.status_code < 300:
            raise self._refused("upload", resp)
        info = _json(resp, "upload")
        upload_url = checked_url(info.get("upload_url"), "upload_url")
        file_url = checked_url(info.get("file_url"), "file_url")
        # The signed upload URL carries its own authority: no Authorization header goes with it.
        put = self._request("put", upload_url, "upload", data=data, headers={"Content-Type": content_type},
                            timeout=120)
        if not 200 <= put.status_code < 300:
            raise self._refused("upload", put)
        return file_url


class _Final(Exception):
    """A step that failed for good (the request is unusable); its message is the reason."""


def _lifecycle(expiry_s: int) -> str:
    return json.dumps({"expiration_duration_seconds": expiry_s})


def _json(resp, what: str) -> dict:
    """The answer's JSON object, or ``AvatarUnavailable`` (never a raw ValueError)."""
    try:
        data = resp.json()
    except ValueError:
        data = None
    if not isinstance(data, dict):
        raise AvatarUnavailable(f"fal.ai {what} answered with something that is not a JSON object")
    return data


def _load_state(path: Path, key: str) -> dict:
    """The sidecar of a clip or portrait: what was made, from which inputs, and which request is
    in flight. A sidecar for other inputs (other words, character or model) is ignored."""
    try:
        data = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("key") == key:
            return data
    except (OSError, ValueError):
        pass
    return {"key": key}


def _why(e: OSError) -> str:
    """What went wrong with a file, without the path or any content."""
    return e.strerror or type(e).__name__


def _persist(path: Path, state: dict, what: str) -> None:
    """``_save_state`` that can only fail as ``AvatarUnavailable`` (a full or read-only disk)."""
    try:
        _save_state(path, state)
    except OSError as e:
        raise AvatarUnavailable(f"Could not save {what} ({_why(e)}). Free disk space or fix the permissions of the "
                                "output folder, then rerun.") from None


def _require_writable(directory: Path) -> None:
    """Prove the output folder takes a file, before any request is made."""
    probe = Path(directory) / ".presenter_write_check"
    try:
        Path(directory).mkdir(parents=True, exist_ok=True)
        probe.write_bytes(b"ok")
        probe.unlink()
    except OSError as e:
        raise AvatarUnavailable(f"The output folder cannot be written ({_why(e)}); nothing was sent or spent. "
                                "Free disk space or fix the permissions, then rerun.") from None


def _valid_request(req) -> Optional[dict]:
    """A saved request that can really be resumed, else None. Only the four fields are kept, and
    each URL must still pass the host check: a sidecar is a file, and files get damaged or edited."""
    if not isinstance(req, dict) or not isinstance(req.get("id"), str) or not req["id"]:
        return None
    try:
        return {"id": req["id"],
                "status_url": checked_url(req.get("status_url"), "saved status_url", key_host=True),
                "response_url": checked_url(req.get("response_url"), "saved response_url", key_host=True),
                "cancel_url": checked_url(req.get("cancel_url"), "saved cancel_url", key_host=True)}
    except AvatarUnavailable:
        return None


def _save_state(path: Path, state: dict) -> None:
    """Atomically (a temp file, then replace): a crash never leaves half a sidecar."""
    side = path.with_suffix(".json")
    tmp = side.with_name(side.name + ".tmp")
    tmp.write_text(json.dumps(state), encoding="utf-8")
    os.replace(tmp, side)


class _HttpError(Exception):
    """Carries a response in the shape ``image_providers.refusal_category`` reads."""

    def __init__(self, response):
        super().__init__("HTTP error")
        self.response = response
