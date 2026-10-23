"""AITuber presenter layer — an optional synthetic on-camera character.

Nightshift is faceless by default (stock b-roll + narration). This adds the
*option* of an AI avatar presenter — an "AITuber" — as a provider behind the
seam in modules/providers.py. It is off unless a channel/series turns it on,
and it is bound by one hard rule:

    Only SYNTHETIC characters. Never clone a real person's face, never
    impersonate a public figure, never build an avatar from a photo of a real
    individual. This is enforced in code (synthetic_only_guard), not left to
    prompt hygiene — the spec's safety section is a requirement, not advice.

Provider
--------
`HiggsfieldAvatarProvider` targets Higgsfield's public API, which uses the
documented async lifecycle: submit a generation request, then poll
`<base>/requests/<id>/status` for the result. Auth is Higgsfield's documented
`Authorization: Key <id>:<secret>` (a two-part key, not a bearer token). This
operator supplies HIGGSFIELD_API_KEY_ID / HIGGSFIELD_API_KEY_SECRET; the model
defaults to Kling 3.0 (jobs/v2/kling3_0), the most cost-effective video model
(~6 credits/generation), and HIGGSFIELD_AVATAR_ENDPOINT overrides it. Until the
credentials are set, generate() raises AvatarUnavailable with exactly what to
set, the same "no silent fallback" posture as audio_mixer.verify_voice: a broken
avatar must fail loudly, never quietly ship a wrong or empty presenter.

`FalAvatarProvider` (modules/avatar_fal.py, ``NIGHTSHIFT_AVATAR_PROVIDER=fal``) is the
pay-per-second alternative: audio-driven, intro and outro only, with a seconds and USD
ceiling checked before any request.

The presenter is wired into the render (main.py, stage 6b), behind AvatarConfig.enabled
and the publish gate, which still decides every upload.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Optional, Protocol, Sequence, Union, runtime_checkable

logger = logging.getLogger(__name__)


class AvatarUnavailable(RuntimeError):
    """Raised when an avatar was asked for but the provider cannot deliver one
    (not configured, timed out, or refused). Callers must treat this as "no
    presenter", never as a reason to ship a blank or wrong one."""


class UnsafeAvatarRequest(ValueError):
    """Raised when an avatar request names or references a real person / public
    figure. Synthetic characters only — this is a safety stop, not a warning."""


@runtime_checkable
class AvatarProvider(Protocol):
    """Generates a presenter clip for narration. Returns a local file path."""

    def generate(self, prompt: str, character_ref: Optional[str], out_path: Path) -> Path:
        ...


@dataclass(frozen=True)
class PresenterSegment:
    """One presenter clip and where it plays: ``start`` seconds into the video (the
    narration slice it was animated from began there). ``seconds`` is that slice's
    length; ``None`` for a whole-video clip that simply starts at ``start``."""

    path: Path
    start: float = 0.0
    seconds: Optional[float] = None


#: What the render receives as ``presenter_path``: one clip from 0 s (Higgsfield), or
#: several placed segments (fal: intro and outro).
Presenter = Union[Path, Sequence[PresenterSegment]]


def presenter_segments(presenter: Optional[Presenter]) -> list:
    """The placed segments for whatever the pipeline holds: nothing, one clip, or a list."""
    if presenter is None:
        return []
    if isinstance(presenter, (str, Path)):
        return [PresenterSegment(path=Path(presenter))]
    return list(presenter)


def describe_presenter(presenter: Optional[Presenter]) -> list:
    """The presenter files as strings, for events and logs."""
    return [str(seg.path) for seg in presenter_segments(presenter)]


# Markers that a reference is a real, identifiable person rather than a
# synthetic character. Deliberately conservative: when in doubt, refuse.
_REAL_PERSON_MARKERS = (
    "real person", "real people", "photo of", "photograph of", "likeness of",
    "deepfake", "face swap", "faceswap", "clone", "cloned", "lookalike",
    "impersonate", "impersonation", "celebrity", "public figure", "politician",
    "president", "actor", "actress", "singer", "influencer named",
)
# A reference that is a URL to an image/photo is treated as a real-person risk:
# a synthetic character is described, not sourced from someone's picture.
_IMAGE_URL_RE = re.compile(r"https?://\S+\.(?:png|jpe?g|webp|gif|bmp)\b", re.I)


def synthetic_only_guard(character_ref: Optional[str], prompt: str = "") -> None:
    """Refuse any request that reads as a real/identifiable person or a photo
    reference. Raises UnsafeAvatarRequest; returns None when the request is a
    plainly synthetic character description."""
    haystack = f"{character_ref or ''} {prompt or ''}".lower()
    if _IMAGE_URL_RE.search(character_ref or "") or _IMAGE_URL_RE.search(prompt or ""):
        raise UnsafeAvatarRequest(
            "Avatar references an image URL. Synthetic characters must be "
            "described, never built from a photo of a real person."
        )
    for marker in _REAL_PERSON_MARKERS:
        if marker in haystack:
            raise UnsafeAvatarRequest(
                f"Avatar request looks like a real/identifiable person ({marker!r}). "
                "Only synthetic characters are allowed."
            )


@dataclass(frozen=True)
class AvatarConfig:
    """Per-channel/series presenter settings. Off by default; a run stays
    faceless unless this is explicitly enabled."""

    enabled: bool = False
    provider: str = "higgsfield"
    # A synthetic character DESCRIPTION (never a real person / photo URL).
    character_prompt: str = ""
    character_ref: str = ""

    @staticmethod
    def from_mapping(data: Optional[dict]) -> "AvatarConfig":
        d = data or {}
        return AvatarConfig(
            enabled=bool(d.get("enabled", False)),
            provider=str(d.get("provider") or "higgsfield"),
            character_prompt=str(d.get("character_prompt") or ""),
            character_ref=str(d.get("character_ref") or ""),
        )


# Higgsfield's documented API base and status path. The auth scheme is
# `Authorization: Key <id>:<secret>` (a two-part key, NOT a bearer token), and
# a submit returns a request id polled at `<base>/requests/<id>/status`.
_HIGGSFIELD_DEFAULT_BASE = "https://api.higgsfield.ai"
# The default presenter model: Kling 3.0, whose documented job endpoint is
# `POST /jobs/v2/kling3_0`. Chosen because it is by far the most cost-effective
# video model on the plan — ~6 credits/generation (≈167 per 1,000 credits),
# versus ~32.5 for seedance (≈30 per 1,000). One presenter clip per video loops
# in the corner, so at ~6 credits a 1,000-credit month covers a daily channel
# many times over. The operator can override HIGGSFIELD_AVATAR_ENDPOINT to point
# at a different model (soul, speech2video, …) when they want one.
_HIGGSFIELD_DEFAULT_ENDPOINT = "jobs/v2/kling3_0"


@dataclass(frozen=True)
class _HiggsfieldEnv:
    api_key_id: str
    api_key_secret: str
    base_url: str
    endpoint: str

    @property
    def configured(self) -> bool:
        # base_url and endpoint both have defaults, so only the credential pair
        # is truly required from the operator — Kling 3.0 is the default model.
        return bool(self.api_key_id and self.api_key_secret and self.endpoint)

    @property
    def auth_header(self) -> str:
        return f"Key {self.api_key_id}:{self.api_key_secret}"


class HiggsfieldAvatarProvider:
    """Real AvatarProvider over Higgsfield's async submit→poll API.

    Credentials and the model path come from the environment so nothing is
    guessed:
      * HIGGSFIELD_API_KEY_ID      — the key id half of the credential
      * HIGGSFIELD_API_KEY_SECRET  — the key secret half
      * HIGGSFIELD_AVATAR_ENDPOINT — optional; the model path. Defaults to
        ``jobs/v2/kling3_0`` (Kling 3.0 — the cost-effective default). Override
        to point at another model (soul, speech2video, …).
      * HIGGSFIELD_API_BASE        — optional; defaults to https://api.higgsfield.ai
    When the credential pair is missing, generate() raises AvatarUnavailable
    naming exactly what to set.
    """

    def __init__(self, *, poll_interval: float = 5.0, max_polls: int = 60):
        self.poll_interval = poll_interval
        self.max_polls = max_polls

    def _env(self) -> _HiggsfieldEnv:
        return _HiggsfieldEnv(
            api_key_id=os.getenv("HIGGSFIELD_API_KEY_ID", "").strip(),
            api_key_secret=os.getenv("HIGGSFIELD_API_KEY_SECRET", "").strip(),
            base_url=(os.getenv("HIGGSFIELD_API_BASE", "").strip() or _HIGGSFIELD_DEFAULT_BASE).rstrip("/"),
            endpoint=(os.getenv("HIGGSFIELD_AVATAR_ENDPOINT", "").strip() or _HIGGSFIELD_DEFAULT_ENDPOINT).lstrip("/"),
        )

    def preflight(self) -> None:
        """Raise ``AvatarUnavailable`` when the credentials are missing. No request."""
        if not self._env().configured:
            raise AvatarUnavailable(
                "Higgsfield avatar is not configured. Set HIGGSFIELD_API_KEY_ID and "
                "HIGGSFIELD_API_KEY_SECRET (the model defaults to Kling 3.0, "
                "jobs/v2/kling3_0, ~6 credits/generation; override with "
                "HIGGSFIELD_AVATAR_ENDPOINT, and HIGGSFIELD_API_BASE defaults to "
                "https://api.higgsfield.ai). No presenter is generated until then "
                "(a blank/wrong avatar is never shipped)."
            )

    def generate(self, prompt: str, character_ref: Optional[str], out_path: Path) -> Path:
        # 1) Safety first — a real-person request never even reaches the network.
        synthetic_only_guard(character_ref, prompt)

        self.preflight()
        env = self._env()

        import requests  # local import: this module is usable (config/guard) without it

        # Higgsfield's documented scheme: `Authorization: Key <id>:<secret>`.
        headers = {"Authorization": env.auth_header}
        submit_url = f"{env.base_url}/{env.endpoint.lstrip('/')}"
        body = {"prompt": prompt}
        if character_ref:
            body["character"] = character_ref

        resp = requests.post(submit_url, json=body, headers=headers, timeout=30)
        resp.raise_for_status()
        submitted = resp.json() if resp.content else {}
        job_id = submitted.get("id") or submitted.get("job_id") or submitted.get("request_id")
        if not job_id:
            raise AvatarUnavailable(f"Higgsfield submit returned no job id: {submitted!r}")

        # Poll the documented status endpoint: <base>/requests/<id>/status. If the
        # submit response handed back an explicit status link, prefer it. Field
        # access stays defensive across the common shapes (status/state,
        # url/output_url/video_url); verify against the live API before enabling.
        status_url = (
            submitted.get("status_url")
            or (submitted.get("links") or {}).get("status")
            or f"{env.base_url}/requests/{job_id}/status"
        )
        for _ in range(self.max_polls):
            poll = requests.get(status_url, headers=headers, timeout=30)
            poll.raise_for_status()
            data = poll.json() if poll.content else {}
            state = str(data.get("status") or data.get("state") or "").lower()
            if state in ("completed", "succeeded", "success", "done"):
                url = (
                    data.get("url") or data.get("output_url") or data.get("video_url")
                    or (data.get("result") or {}).get("url")
                )
                if not url:
                    raise AvatarUnavailable(f"Higgsfield job {job_id} finished with no output url")
                return self._download(url, out_path)
            if state in ("failed", "error", "canceled", "cancelled"):
                raise AvatarUnavailable(f"Higgsfield job {job_id} failed: {data!r}")
            time.sleep(self.poll_interval)
        raise AvatarUnavailable(f"Higgsfield job {job_id} did not finish after {self.max_polls} polls")

    @staticmethod
    def _download(url: str, out_path: Path) -> Path:
        import requests

        out_path.parent.mkdir(parents=True, exist_ok=True)
        with requests.get(url, stream=True, timeout=120) as r:
            r.raise_for_status()
            with open(out_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=1 << 16):
                    if chunk:
                        f.write(chunk)
        return out_path


def avatar_provider(config: AvatarConfig) -> Optional[AvatarProvider]:
    """The provider for a config, or None when avatars are off. A factory so a
    future provider can be selected by name without call sites changing."""
    if not config.enabled:
        return None
    name = (config.provider or "").strip().lower()
    if name == "higgsfield":
        return HiggsfieldAvatarProvider()
    if name == "fal":
        from modules.avatar_fal import FalAvatarProvider  # local: pulls in the image router

        return FalAvatarProvider()
    raise AvatarUnavailable(f"Unknown avatar provider {config.provider!r} (use 'higgsfield' or 'fal')")


def preflight_avatar(config: AvatarConfig) -> None:
    """Before the run spends anything: when a presenter was requested, raise
    ``AvatarUnavailable`` / ``UnsafeAvatarRequest`` if it cannot be made (unknown
    provider, missing credentials, a real-person reference). A no-op when avatars
    are off. No network request."""
    if not config.enabled:
        return
    provider = avatar_provider(config)
    synthetic_only_guard(config.character_ref or None, config.character_prompt)
    check = getattr(provider, "preflight", None)
    if callable(check):
        check()


# -- pipeline helpers -------------------------------------------------------
# Kept here (not in main.py) so a run's avatar decision is unit-testable without
# importing the render pipeline, which pulls heavy MoviePy dependencies.

# Discrete env vars, so a deploy can turn the presenter on channel-wide without
# a JSON blob. A per-channel mapping (see resolve_avatar_config) still wins.
_ENABLED_ENV = "NIGHTSHIFT_AVATAR_ENABLED"
_PROVIDER_ENV = "NIGHTSHIFT_AVATAR_PROVIDER"
_PROMPT_ENV = "NIGHTSHIFT_AVATAR_CHARACTER_PROMPT"
_REF_ENV = "NIGHTSHIFT_AVATAR_CHARACTER_REF"
_JSON_ENV = "NIGHTSHIFT_AVATAR"  # a full AvatarConfig mapping as JSON


def _truthy(value) -> bool:
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def resolve_avatar_config(channel_ctx=None, series_obj=None) -> AvatarConfig:
    """Decide whether this run has a presenter, and which character.

    Precedence, least to most specific (later overrides earlier):
      1. ``NIGHTSHIFT_AVATAR`` — a whole config mapping as JSON (deploy default).
      2. Discrete ``NIGHTSHIFT_AVATAR_*`` env vars.
      3. A per-channel ``avatar`` mapping on the channel context, if one exists.
    The result is **off unless something explicitly turns it on** — a run with
    nothing configured stays faceless, exactly as today. When enabled without an
    explicit character description, the series' ``visual_style`` seeds the look,
    so a Series can carry its presenter's appearance without new DB columns.
    Never raises: a malformed source is logged and ignored, not fatal."""
    merged: dict = {}

    raw_json = os.getenv(_JSON_ENV, "").strip()
    if raw_json:
        try:
            data = json.loads(raw_json)
            if isinstance(data, dict):
                merged.update(data)
            else:
                logger.warning("%s is not a JSON object — ignoring", _JSON_ENV)
        except Exception as e:
            logger.warning("Could not parse %s (%s) — ignoring", _JSON_ENV, e)

    if os.getenv(_ENABLED_ENV) is not None:
        merged["enabled"] = _truthy(os.getenv(_ENABLED_ENV))
    for env_key, field in ((_PROVIDER_ENV, "provider"), (_PROMPT_ENV, "character_prompt"), (_REF_ENV, "character_ref")):
        val = os.getenv(env_key)
        if val:
            merged[field] = val

    ctx_avatar = getattr(channel_ctx, "avatar", None)
    if isinstance(ctx_avatar, dict):
        merged.update(ctx_avatar)

    config = AvatarConfig.from_mapping(merged)

    # Seed the character's look from the series only when enabled and no explicit
    # description was given — a Series' visual_style is the natural place for it.
    if config.enabled and not config.character_prompt and series_obj is not None:
        visual = getattr(series_obj, "visual_style", "") or ""
        if visual:
            config = replace(config, character_prompt=visual)
    return config


def presenter_layout(video_w: int, video_h: int, *, corner: str = "bottom-right",
                     scale: float = 0.28, margin_frac: float = 0.03) -> dict:
    """Geometry for the presenter overlay: a corner inset sized to a fraction of
    the frame, with a small margin. Pure arithmetic, so the placement is tested
    without rendering. Returns width/height/x/y in pixels (top-left origin)."""
    scale = min(max(float(scale), 0.05), 0.6)
    w = max(1, int(round(video_w * scale)))
    h = max(1, int(round(video_h * scale)))
    margin = int(round(min(video_w, video_h) * max(margin_frac, 0.0)))
    right_x = max(0, video_w - w - margin)
    bottom_y = max(0, video_h - h - margin)
    positions = {
        "bottom-right": (right_x, bottom_y),
        "bottom-left": (margin, bottom_y),
        "top-right": (right_x, margin),
        "top-left": (margin, margin),
    }
    x, y = positions.get(corner, positions["bottom-right"])
    return {"w": w, "h": h, "x": x, "y": y}


def presenter_narration(slug_dir: Path, mixed_audio: Path) -> Path:
    """The audio that drives a speaking presenter: the clean narration the mixer saved
    (``<slug>/audio/narration.mp3``, speech only, same timeline as the mix), else the final
    mix. Music under a lip-sync makes it worse, and the two files have the same length."""
    clean = Path(slug_dir) / "audio" / "narration.mp3"
    return clean if clean.exists() else Path(mixed_audio)


def planned_presenter_usd(config: AvatarConfig) -> float:
    """What the presenter is about to cost at most, for the run's spend gate. Only the
    pay-per-second provider has a figure; Higgsfield's credits are not priced here."""
    if not config.enabled or (config.provider or "").strip().lower() != "fal":
        return 0.0
    from modules.avatar_fal import FalAvatarSettings

    return FalAvatarSettings.from_env().planned_usd()


def maybe_generate_presenter(config: AvatarConfig, prompt: str, out_path: Path, *,
                             narration_path: Optional[Path] = None,
                             frame_size: Optional[tuple] = None,
                             on_spend=None) -> Optional[Presenter]:
    """Generate the presenter for this run, or None when the run is faceless.

    * Avatars off (the default) → ``None``: the run renders faceless, unchanged.
    * On → the configured provider generates it. There is **no silent
      fallback**: an enabled-but-unconfigured provider raises ``AvatarUnavailable``
      and an unsafe request raises ``UnsafeAvatarRequest``. The pipeline lets
      both stop the run (``main.py`` re-raises after recording the failure): a
      presenter that was asked for is never quietly dropped for a faceless cut.
    * A provider with ``generate_segments`` (fal) is audio-driven: it is given the
      narration, the frame size and ``on_spend`` (a ledger hook) and returns placed
      ``PresenterSegment``s; any other provider returns one clip path.
    """
    if not config.enabled:
        return None
    provider = avatar_provider(config)
    if provider is None:  # defensive: enabled but factory returned nothing
        return None
    character_prompt = (prompt or config.character_prompt or "").strip()
    segmented = getattr(provider, "generate_segments", None)
    if callable(segmented):
        if narration_path is None:
            raise AvatarUnavailable("This presenter is driven by the narration audio, and none was given.")
        return segmented(character_prompt, config.character_ref or None, Path(out_path),
                         narration_path=Path(narration_path), frame_size=frame_size or (1280, 720),
                         on_spend=on_spend)
    return provider.generate(character_prompt, config.character_ref or None, Path(out_path))
