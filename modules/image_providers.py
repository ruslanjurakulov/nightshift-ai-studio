"""Image-generation provider router — on-topic stills from the selected generator.

Backgrounds have always come from Pexels stock photos (media_fetcher.fetch_images),
which the compositor gives a Ken Burns move. This adds an OPTIONAL generated-image
source: when enabled, the selected generator renders a bespoke on-topic still
for a few sections instead of the nearest stock match. It mirrors the b-roll video router
(modules/video_providers.py) exactly:

* **Off by default.** ``IMAGE_PROVIDER`` defaults to ``"pexels"`` — generation
  is off and images come from stock exactly as before. A generator runs only when
  it is selected AND its key is set AND ``CHRONOS_ENABLE_IMAGE_GEN`` is on.
* **Providers** (``PROVIDERS``): Leonardo.Ai, OpenAI GPT Image, Google Gemini
  image ("Nano Banana"), Black Forest Labs FLUX.2, Ideogram 3, and fal.ai (any of
  its text-to-image models by id). ``CHRONOS_IMAGE_MODEL`` picks a model for the
  selected one; empty means ``DEFAULT_MODELS``.
* **Never breaks a render.** Every failure (auth, quota, a job that never
  finishes, an odd response) is caught, logged without the key, and returns
  ``None`` for that one image — the section falls back to stock.
* **A key is never logged**, and endpoints/model are env-overridable so they can
  be pinned to Leonardo's current API without a code change.
"""

from __future__ import annotations

import base64
import logging
import os
import time
from pathlib import Path
from typing import Optional, Sequence

import requests

import config

logger = logging.getLogger(__name__)

_ID_KEYS = ("generationId", "id", "sdGenerationJobId")
_STATUS_KEYS = ("status", "state")
_SUCCESS = {"complete", "completed", "finished", "done", "ready", "success"}
_FAILURE = {"failed", "error", "canceled", "cancelled"}


def _first(d: dict, keys: Sequence[str]) -> Optional[object]:
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ""):
            return d.get(k)
    return None


def active_provider() -> str:
    """Selected image provider id. Defaults to 'pexels' (generation off)."""
    return (getattr(config, "IMAGE_PROVIDER", "pexels") or "pexels").strip().lower()


#: Generator id -> the config attribute holding its key. "pexels" is stock, not here.
KEY_ATTRS = {
    "leonardo": "LEONARDO_API_KEY",
    "gpt-image": "OPENAI_API_KEY",
    "nano-banana": "GEMINI_API_KEY",
    "flux": "BFL_API_KEY",
    "ideogram": "IDEOGRAM_API_KEY",
    "fal": "FAL_KEY",
}

#: The model each generator uses when CHRONOS_IMAGE_MODEL is empty.
DEFAULT_MODELS = {
    "gpt-image": "gpt-image-2",
    "nano-banana": "gemini-3.1-flash-image-preview",
    "flux": "flux-2-pro",
    "ideogram": "V_3",
    "fal": "fal-ai/flux-2-pro",
}

#: Every provider id the pipeline accepts (the workflow's choice list mirrors it).
PROVIDERS = ("pexels",) + tuple(KEY_ATTRS)


def _key(provider: str) -> str:
    attr = KEY_ATTRS.get(provider)
    return str(getattr(config, attr, "") or "") if attr else ""


def is_enabled() -> bool:
    """True only when a generation provider is selected, keyed, and opted in."""
    provider = active_provider()
    if provider not in KEY_ATTRS:
        return False
    return bool(_key(provider)) and bool(getattr(config, "IMAGE_GEN_OPT_IN", False))


def active_model() -> str:
    provider = active_provider()
    if provider == "leonardo":
        return getattr(config, "IMAGE_MODEL", "") or getattr(config, "LEONARDO_MODEL_ID", "")
    if provider in DEFAULT_MODELS:
        return getattr(config, "IMAGE_MODEL", "") or DEFAULT_MODELS[provider]
    return ""


def get_client():
    """A client for the selected image provider, or ``None`` when unconfigured."""
    provider = active_provider()
    cls = _CLIENTS.get(provider)
    if cls is None:
        return None
    client = cls()
    return client if client.api_key else None


def _aspect(width: int, height: int) -> str:
    """"16:9"-style ratio for the providers that take one instead of pixels."""
    if width <= 0 or height <= 0:
        return "16:9"
    r = width / height
    for name, value in (("16:9", 16 / 9), ("9:16", 9 / 16), ("1:1", 1.0), ("4:3", 4 / 3),
                        ("3:4", 3 / 4), ("3:2", 3 / 2), ("2:3", 2 / 3)):
        if abs(r - value) < 0.03:
            return name
    return "16:9" if r > 1 else "9:16"


def _round16(n: int) -> int:
    return max(16, int(round(n / 16.0)) * 16)


class _Base:
    """Shared plumbing: a session, a download, and base64 → file. Never raises."""

    name = "image"

    def __init__(self, *, api_key: Optional[str] = None, timeout: int = 60):
        provider = self.provider_id
        self.api_key = api_key if api_key is not None else _key(provider)
        self.model = getattr(config, "IMAGE_MODEL", "") or DEFAULT_MODELS.get(provider, "")
        self.timeout = timeout
        self.session = requests.Session()

    provider_id = ""

    def _warn(self, what: str, e: Exception) -> None:
        # The exception text of requests never carries our header values; the
        # key is only ever in headers.
        logger.warning("%s %s failed (%s: %s) — using stock image instead",
                       self.name, what, type(e).__name__, e)

    def _download(self, url: str, dest: Path, headers: Optional[dict] = None) -> Optional[Path]:
        try:
            with self.session.get(url, stream=True, timeout=self.timeout, headers=headers) as resp:
                resp.raise_for_status()
                dest.parent.mkdir(parents=True, exist_ok=True)
                with open(dest, "wb") as fh:
                    for chunk in resp.iter_content(chunk_size=1 << 16):
                        if chunk:
                            fh.write(chunk)
        except Exception as e:
            self._warn("download", e)
            return None
        return dest if dest.exists() and dest.stat().st_size > 0 else None

    def _write_b64(self, data: str, dest: Path) -> Optional[Path]:
        try:
            raw = base64.b64decode(data, validate=False)
        except Exception as e:
            self._warn("decode", e)
            return None
        if not raw:
            return None
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(raw)
        return dest


class OpenAIImageClient(_Base):
    """OpenAI GPT Image (``POST /v1/images/generations``). GPT image models
    always answer with base64 (``data[0].b64_json``); ``response_format`` is not
    sent because those models reject it."""

    name = "OpenAI image"
    provider_id = "gpt-image"

    def __init__(self, **kw):
        super().__init__(**kw)
        self.base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        # "high" plans and reviews first and takes many times longer.
        self.quality = os.getenv("CHRONOS_OPENAI_IMAGE_QUALITY", "medium").strip() or "medium"

    def generate(self, prompt: str, out_path, *, width: int = 1024, height: int = 576) -> Optional[Path]:
        if not self.api_key or not (prompt or "").strip():
            return None
        # Width and height must be multiples of 16; 1536x864 is 16:9.
        scale = 1536 / max(width, height)
        size = f"{_round16(width * scale)}x{_round16(height * scale)}"
        body = {"model": self.model, "prompt": prompt.strip(), "n": 1, "size": size,
                "quality": self.quality, "output_format": "jpeg"}
        try:
            resp = self.session.post(f"{self.base_url}/images/generations", json=body,
                                     headers={"Authorization": f"Bearer {self.api_key}"},
                                     timeout=max(self.timeout, 180))
            resp.raise_for_status()
            items = resp.json().get("data") or []
        except Exception as e:
            self._warn("generation", e)
            return None
        first = items[0] if items and isinstance(items[0], dict) else {}
        if first.get("b64_json"):
            return self._write_b64(first["b64_json"], Path(out_path))
        if first.get("url"):
            return self._download(first["url"], Path(out_path))
        logger.warning("OpenAI image: no image in the response")
        return None


class GeminiImageClient(_Base):
    """Google Gemini native image generation ("Nano Banana") through
    ``generateContent`` with ``responseModalities: ["IMAGE"]``. The key goes in
    the ``x-goog-api-key`` header, never the URL."""

    name = "Gemini image"
    provider_id = "nano-banana"

    def __init__(self, **kw):
        super().__init__(**kw)
        self.base_url = os.getenv("GEMINI_BASE_URL",
                                  "https://generativelanguage.googleapis.com/v1beta").rstrip("/")

    def generate(self, prompt: str, out_path, *, width: int = 1024, height: int = 576) -> Optional[Path]:
        if not self.api_key or not (prompt or "").strip():
            return None
        body = {
            "contents": [{"parts": [{"text": prompt.strip()}]}],
            "generationConfig": {
                "responseModalities": ["IMAGE"],
                "imageConfig": {"aspectRatio": _aspect(width, height)},
            },
        }
        try:
            resp = self.session.post(f"{self.base_url}/models/{self.model}:generateContent", json=body,
                                     headers={"x-goog-api-key": self.api_key}, timeout=max(self.timeout, 120))
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            self._warn("generation", e)
            return None
        for cand in data.get("candidates") or []:
            parts = ((cand or {}).get("content") or {}).get("parts") or []
            for part in parts:
                inline = (part or {}).get("inlineData") or (part or {}).get("inline_data")
                if isinstance(inline, dict) and inline.get("data"):
                    return self._write_b64(inline["data"], Path(out_path))
        logger.warning("Gemini image: no image in the response (blocked or text-only)")
        return None


class FluxClient(_Base):
    """Black Forest Labs FLUX (``POST https://api.bfl.ai/v1/<model>``, header
    ``x-key``): submit, poll the returned ``polling_url`` until ``Ready``, then
    download ``result.sample`` at once (it expires in minutes)."""

    name = "FLUX"
    provider_id = "flux"

    def __init__(self, **kw):
        super().__init__(**kw)
        self.base_url = os.getenv("BFL_BASE_URL", "https://api.bfl.ai/v1").rstrip("/")

    def generate(self, prompt: str, out_path, *, width: int = 1024, height: int = 576,
                 max_attempts: int = 60, interval: float = 2.0) -> Optional[Path]:
        if not self.api_key or not (prompt or "").strip():
            return None
        headers = {"x-key": self.api_key, "accept": "application/json"}
        body = {"prompt": prompt.strip(), "width": _round16(width), "height": _round16(height)}
        try:
            resp = self.session.post(f"{self.base_url}/{self.model}", json=body, headers=headers,
                                     timeout=self.timeout)
            resp.raise_for_status()
            job = resp.json()
        except Exception as e:
            self._warn("submit", e)
            return None
        poll = job.get("polling_url") if isinstance(job, dict) else None
        if not poll and isinstance(job, dict) and job.get("id"):
            poll = f"{self.base_url}/get_result?id={job['id']}"
        if not poll:
            logger.warning("FLUX: no polling URL in the response")
            return None
        for _ in range(max(1, max_attempts)):
            try:
                r = self.session.get(poll, headers=headers, timeout=self.timeout)
                r.raise_for_status()
                data = r.json()
            except Exception as e:
                self._warn("poll", e)
                return None
            status = str(data.get("status") or "")
            if status == "Ready":
                sample = (data.get("result") or {}).get("sample")
                return self._download(sample, Path(out_path)) if sample else None
            if status in ("Error", "Failed", "Content Moderated", "Request Moderated", "Task not found"):
                logger.warning("FLUX generation ended with status %r", status)
                return None
            time.sleep(max(0.0, interval))
        logger.warning("FLUX generation did not finish in time")
        return None


class IdeogramClient(_Base):
    """Ideogram 3 (``POST https://api.ideogram.ai/v1/ideogram-v3/generate``,
    multipart form, header ``Api-Key``); the answer holds ``data[0].url``."""

    name = "Ideogram"
    provider_id = "ideogram"

    def __init__(self, **kw):
        super().__init__(**kw)
        self.base_url = os.getenv("IDEOGRAM_BASE_URL", "https://api.ideogram.ai").rstrip("/")

    def generate(self, prompt: str, out_path, *, width: int = 1024, height: int = 576) -> Optional[Path]:
        if not self.api_key or not (prompt or "").strip():
            return None
        form = {"prompt": (None, prompt.strip()),
                "aspect_ratio": (None, _aspect(width, height).replace(":", "x")),
                "rendering_speed": (None, os.getenv("CHRONOS_IDEOGRAM_SPEED", "DEFAULT") or "DEFAULT")}
        try:
            resp = self.session.post(f"{self.base_url}/v1/ideogram-v3/generate", files=form,
                                     headers={"Api-Key": self.api_key}, timeout=max(self.timeout, 120))
            resp.raise_for_status()
            items = resp.json().get("data") or []
        except Exception as e:
            self._warn("generation", e)
            return None
        url = items[0].get("url") if items and isinstance(items[0], dict) else None
        if not url:
            logger.warning("Ideogram: no image in the response")
            return None
        return self._download(url, Path(out_path))


class FalImageClient(_Base):
    """fal.ai synchronous run (``POST https://fal.run/<model id>``, header
    ``Authorization: Key …``) — one key for many models (FLUX, Seedream, Imagen,
    Qwen-Image, Recraft …); ``CHRONOS_IMAGE_MODEL`` names the one to use."""

    name = "fal.ai"
    provider_id = "fal"

    def __init__(self, **kw):
        super().__init__(**kw)
        self.base_url = os.getenv("FAL_BASE_URL", "https://fal.run").rstrip("/")

    def generate(self, prompt: str, out_path, *, width: int = 1024, height: int = 576) -> Optional[Path]:
        if not self.api_key or not (prompt or "").strip():
            return None
        aspect = _aspect(width, height)
        size = {"16:9": "landscape_16_9", "9:16": "portrait_16_9", "1:1": "square_hd",
                "4:3": "landscape_4_3", "3:4": "portrait_4_3"}.get(aspect, "landscape_16_9")
        body = {"prompt": prompt.strip(), "image_size": size, "num_images": 1}
        try:
            resp = self.session.post(f"{self.base_url}/{self.model.strip('/')}", json=body,
                                     headers={"Authorization": f"Key {self.api_key}"},
                                     timeout=max(self.timeout, 180))
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            self._warn("generation", e)
            return None
        images = data.get("images") if isinstance(data, dict) else None
        if not images and isinstance(data, dict) and isinstance(data.get("image"), dict):
            images = [data["image"]]
        url = images[0].get("url") if images and isinstance(images[0], dict) else None
        if not url:
            logger.warning("fal.ai: no image in the response")
            return None
        if url.startswith("data:") and "," in url:
            return self._write_b64(url.split(",", 1)[1], Path(out_path))
        return self._download(url, Path(out_path))


class LeonardoClient:
    """Leonardo.Ai text-to-image: submit a generation, poll it, download the
    first image. Matches ``generate(prompt, out_path) -> Optional[Path]``. Never
    raises."""

    def __init__(self, *, api_key: Optional[str] = None, timeout: int = 30):
        self.api_key = api_key if api_key is not None else getattr(config, "LEONARDO_API_KEY", "")
        self.base_url = getattr(config, "LEONARDO_BASE_URL", "https://cloud.leonardo.ai/api/rest/v1").rstrip("/")
        self.model_id = getattr(config, "IMAGE_MODEL", "") or getattr(config, "LEONARDO_MODEL_ID", "")
        self.timeout = timeout
        self.session = requests.Session()
        if self.api_key:
            self.session.headers.update({
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            })

    def _submit(self, prompt: str, width: int, height: int) -> Optional[str]:
        body = {"prompt": prompt, "num_images": 1, "width": width, "height": height}
        if self.model_id:
            body["modelId"] = self.model_id
        try:
            resp = self.session.post(f"{self.base_url}/generations", json=body, timeout=self.timeout)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            logger.warning("Leonardo submit failed (%s: %s) — using stock image instead",
                           type(e).__name__, e)
            return None
        # The id sits under `sdGenerationJob` in Leonardo's response.
        job = data.get("sdGenerationJob") if isinstance(data.get("sdGenerationJob"), dict) else data
        gid = _first(job, _ID_KEYS)
        return str(gid) if gid is not None else None

    def _poll(self, gen_id: str, *, max_attempts: int = 40, interval: float = 3.0) -> Optional[str]:
        for _ in range(max(1, max_attempts)):
            try:
                resp = self.session.get(f"{self.base_url}/generations/{gen_id}", timeout=self.timeout)
                resp.raise_for_status()
                data = resp.json()
            except Exception as e:
                logger.warning("Leonardo poll failed (%s: %s)", type(e).__name__, e)
                return None
            # Result nests under `generations_by_pk`.
            gen = data.get("generations_by_pk") if isinstance(data.get("generations_by_pk"), dict) else data
            status = str(_first(gen, _STATUS_KEYS) or "").strip().lower()
            images = gen.get("generated_images") if isinstance(gen, dict) else None
            url = None
            if isinstance(images, list) and images:
                first = images[0]
                if isinstance(first, dict):
                    url = first.get("url") or first.get("motionMP4URL")
            if url and (not status or status in _SUCCESS):
                return str(url)
            if status in _FAILURE:
                logger.warning("Leonardo generation %s reported status %r", gen_id, status)
                return None
            time.sleep(max(0.0, interval))
        logger.warning("Leonardo generation %s did not finish in time", gen_id)
        return None

    def _download(self, url: str, dest: Path) -> Optional[Path]:
        try:
            with self.session.get(url, stream=True, timeout=self.timeout) as resp:
                resp.raise_for_status()
                dest.parent.mkdir(parents=True, exist_ok=True)
                with open(dest, "wb") as fh:
                    for chunk in resp.iter_content(chunk_size=1 << 16):
                        if chunk:
                            fh.write(chunk)
        except Exception as e:
            logger.warning("Leonardo image download failed (%s: %s)", type(e).__name__, e)
            return None
        return dest if dest.exists() and dest.stat().st_size > 0 else None

    def generate(self, prompt: str, out_path, *, width: int = 1024, height: int = 576) -> Optional[Path]:
        if not self.api_key or not (prompt or "").strip():
            return None
        gid = self._submit(prompt.strip(), width, height)
        if not gid:
            return None
        url = self._poll(gid)
        if not url:
            return None
        return self._download(url, Path(out_path))


_CLIENTS = {
    "leonardo": LeonardoClient,
    "gpt-image": OpenAIImageClient,
    "nano-banana": GeminiImageClient,
    "flux": FluxClient,
    "ideogram": IdeogramClient,
    "fal": FalImageClient,
}
