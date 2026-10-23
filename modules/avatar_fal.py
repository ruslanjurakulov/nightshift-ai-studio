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
* **Ledgered.** What fal billed is written to the cost ledger as an explicit
  estimate (``avatar_seconds``, stage ``avatar:fal``), so the run and daily USD
  caps in ``modules/spend_guard.py`` see it.
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
default model. Nothing here was run against the live service.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, Optional, Tuple

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
        return FalAvatarSettings(
            model=(str(env.get(MODEL_ENV, "") or "").strip().strip("/") or DEFAULT_MODEL),
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

        headers = {"Authorization": f"Key {self._key()}"}
        width, height = frame_size
        portrait = out_dir / "presenter_portrait.png"
        if not (portrait.exists() and portrait.stat().st_size > 0):
            description = (prompt or "").strip() or _DEFAULT_CHARACTER
            made = self._portrait(_PORTRAIT_PROMPT.format(character=description), portrait, width, height,
                                  settings.image_model, self._key())
            if not made or not Path(made).exists() or Path(made).stat().st_size <= 0:
                raise AvatarUnavailable("The presenter portrait could not be generated (fal.ai returned no image); "
                                        "no presenter was generated.")
            if on_spend:
                on_spend("image_generations", 1.0, "image:fal", PORTRAIT_USD)
        portrait_hash = hashlib.sha256(portrait.read_bytes()).hexdigest()
        portrait_url = None

        segments = []
        for name, start, seconds in plan:
            clip_path = out_dir / f"presenter_{name}.mp4"
            audio_file = self.audio.cut(narration_path, start, start + seconds, out_dir / f"presenter_{name}.mp3")
            audio_bytes = Path(audio_file).read_bytes()
            key = hashlib.sha256(audio_bytes + portrait_hash.encode() + settings.model.encode()).hexdigest()
            if self._cached(clip_path, key):
                logger.info("Presenter %s reused from an earlier attempt (nothing billed)", name)
            else:
                if portrait_url is None:
                    portrait_url = self._upload(portrait.read_bytes(), "image/png", portrait.name, headers)
                audio_url = self._upload(audio_bytes, "audio/mpeg", Path(audio_file).name, headers)
                billed = self._render(settings, headers, portrait_url, audio_url, clip_path, seconds)
                if on_spend:
                    on_spend(AVATAR_SECONDS, billed, LEDGER_STAGE, round(billed * settings.usd_per_second, 6))
                clip_path.with_suffix(".json").write_text(json.dumps({"key": key}), encoding="utf-8")
            segments.append(PresenterSegment(path=clip_path, start=start, seconds=seconds))
        return segments

    @staticmethod
    def _cached(clip: Path, key: str) -> bool:
        """A clip from an earlier attempt of this run is reused only when it was made from
        this exact audio, portrait and model: a lip-sync for other words must never ship."""
        try:
            if not (clip.exists() and clip.stat().st_size > 0):
                return False
            return json.loads(clip.with_suffix(".json").read_text(encoding="utf-8")).get("key") == key
        except (OSError, ValueError):
            return False

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
        import requests

        try:
            resp = getattr(self.session, method)(url, **kw)
        except requests.RequestException as e:
            raise AvatarUnavailable(f"fal.ai {what} failed ({type(e).__name__}); no presenter was generated.") from e
        return resp

    def _upload(self, data: bytes, content_type: str, file_name: str, headers: dict) -> str:
        resp = self._request("post", f"{REST_BASE}/storage/upload/initiate?storage_type=fal-cdn-v3", "upload",
                             json={"file_name": file_name, "content_type": content_type}, headers=headers, timeout=30)
        if not 200 <= resp.status_code < 300:
            raise self._refused("upload", resp)
        info = resp.json() if resp.content else {}
        upload_url, file_url = info.get("upload_url"), info.get("file_url")
        if not (upload_url and file_url):
            raise AvatarUnavailable("fal.ai upload returned no upload_url/file_url; no presenter was generated.")
        put = self._request("put", upload_url, "upload", data=data, headers={"Content-Type": content_type},
                            timeout=120)
        if not 200 <= put.status_code < 300:
            raise self._refused("upload", put)
        return file_url

    def _render(self, settings: FalAvatarSettings, headers: dict, image_url: str, audio_url: str,
                dest: Path, seconds: float) -> float:
        """Submit, poll, fetch, download. Returns the output seconds fal reports (what it bills)."""
        body = {"image_url": image_url, "audio_url": audio_url, "prompt": _VIDEO_PROMPT}
        resp = self._request("post", f"{QUEUE_BASE}/{settings.model}", "submit", json=body, headers=headers,
                             timeout=30)
        if not 200 <= resp.status_code < 300:
            raise self._refused("submit", resp)
        submitted = resp.json() if resp.content else {}
        request_id = submitted.get("request_id")
        if not request_id:
            raise AvatarUnavailable(f"fal.ai submit returned no request_id: {submitted!r}")
        base = f"{QUEUE_BASE}/{settings.model}/requests/{request_id}"
        status_url = submitted.get("status_url") or f"{base}/status"
        response_url = submitted.get("response_url") or base
        cancel_url = submitted.get("cancel_url") or f"{base}/cancel"

        deadline = self._monotonic() + self.timeout_s
        failures = 0
        while True:
            try:
                poll = self._request("get", status_url, "status check", headers=headers, timeout=30)
            except AvatarUnavailable:
                # A dropped connection says nothing about a job that is already running (and billing).
                if failures >= 3:
                    raise
                failures += 1
                poll = None
            if poll is None:
                pass
            elif 200 <= poll.status_code < 300:
                failures = 0
                state = poll.json() if poll.content else {}
                if str(state.get("status") or "").upper() == "COMPLETED":
                    if state.get("error"):
                        raise AvatarUnavailable(f"fal.ai request {request_id} failed: {state.get('error')}")
                    break
            elif poll.status_code in (429, 500, 502, 503, 504) and failures < 3:
                failures += 1
            else:
                raise self._refused("status check", poll)
            if self._monotonic() >= deadline:
                self._cancel(cancel_url, headers)
                raise AvatarUnavailable(
                    f"fal.ai request {request_id} did not finish in {self.timeout_s:g} s; cancelled (a request that "
                    "had already started may still be billed). No presenter was generated."
                )
            self._sleep(self.poll_interval)

        result = self._request("get", response_url, "result", headers=headers, timeout=30)
        if not 200 <= result.status_code < 300:
            raise self._refused("result", result)
        data = result.json() if result.content else {}
        video = data.get("video") if isinstance(data, dict) else None
        url = video.get("url") if isinstance(video, dict) else None
        if not url:
            raise AvatarUnavailable(f"fal.ai request {request_id} finished with no video url")
        self._download(url, dest)
        billed = data.get("duration")
        if isinstance(billed, bool) or not isinstance(billed, (int, float)) or not 0 < billed < float("inf"):
            billed = seconds
        return float(billed)

    def _cancel(self, cancel_url: str, headers: dict) -> None:
        try:
            self.session.put(cancel_url, headers=headers, timeout=30)
        except Exception as e:  # best effort: the timeout error that follows is the news
            logger.warning("fal.ai cancel failed (%s)", type(e).__name__)

    def _download(self, url: str, dest: Path) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        resp = self._request("get", url, "download", stream=True, timeout=120)
        if not 200 <= resp.status_code < 300:
            raise self._refused("download", resp)
        with open(dest, "wb") as fh:
            for chunk in resp.iter_content(chunk_size=1 << 16):
                if chunk:
                    fh.write(chunk)
        if dest.stat().st_size <= 0:
            raise AvatarUnavailable("fal.ai returned an empty video file; no presenter was generated.")


class _HttpError(Exception):
    """Carries a response in the shape ``image_providers.refusal_category`` reads."""

    def __init__(self, response):
        super().__init__("HTTP error")
        self.response = response
