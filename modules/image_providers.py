"""Image-generation provider router — on-topic stills, Leonardo first.

Backgrounds have always come from Pexels stock photos (media_fetcher.fetch_images),
which the compositor gives a Ken Burns move. This adds an OPTIONAL generated-image
source: when enabled, Leonardo.Ai renders a bespoke on-topic still for a few
sections instead of the nearest stock match. It mirrors the b-roll video router
(modules/video_providers.py) exactly:

* **Off by default.** ``IMAGE_PROVIDER`` defaults to ``"pexels"`` — generation
  is off and images come from stock exactly as before. Leonardo runs only when
  it is selected AND its key is set AND ``CHRONOS_ENABLE_IMAGE_GEN`` is on.
* **Never breaks a render.** Every failure (auth, quota, a job that never
  finishes, an odd response) is caught, logged without the key, and returns
  ``None`` for that one image — the section falls back to stock.
* **A key is never logged**, and endpoints/model are env-overridable so they can
  be pinned to Leonardo's current API without a code change.
"""

from __future__ import annotations

import logging
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


def is_enabled() -> bool:
    """True only when a generation provider is selected, keyed, and opted in."""
    if active_provider() != "leonardo":
        return False
    return bool(getattr(config, "LEONARDO_API_KEY", "")) and bool(getattr(config, "IMAGE_GEN_OPT_IN", False))


def active_model() -> str:
    if active_provider() == "leonardo":
        return getattr(config, "LEONARDO_MODEL_ID", "")
    return ""


def get_client():
    """A client for the selected image provider, or ``None`` when unconfigured."""
    if active_provider() == "leonardo":
        client = LeonardoClient()
        return client if client.api_key else None
    return None


class LeonardoClient:
    """Leonardo.Ai text-to-image: submit a generation, poll it, download the
    first image. Matches ``generate(prompt, out_path) -> Optional[Path]``. Never
    raises."""

    def __init__(self, *, api_key: Optional[str] = None, timeout: int = 30):
        self.api_key = api_key if api_key is not None else getattr(config, "LEONARDO_API_KEY", "")
        self.base_url = getattr(config, "LEONARDO_BASE_URL", "https://cloud.leonardo.ai/api/rest/v1").rstrip("/")
        self.model_id = getattr(config, "LEONARDO_MODEL_ID", "")
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
