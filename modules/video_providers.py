"""Video-generation provider router — pick the b-roll clip generator.

Nightshift keeps the pipeline free of vendor lock-in (see modules/providers.py):
b-roll clips can come from MiniMax H3 or any other text-to-video provider that
matches the same tiny shape — ``generate(spec, out_path) -> Optional[Path]``,
the shape MiniMaxClient already has. This module is the seam that chooses which
one a run uses, from ``config.VIDEO_PROVIDER``.

Guarantees, matching the rest of the pipeline
---------------------------------------------
* **Default is unchanged.** ``VIDEO_PROVIDER`` defaults to ``"minimax"``; for
  that value ``get_client()`` returns the existing :class:`MiniMaxClient` and
  ``is_enabled()`` is exactly ``config.MINIMAX_BROLL_ENABLED``. A run that sets
  nothing new behaves bit-for-bit as before.
* **Others are opt-in and off by default.** Another provider runs only when its
  key is set AND the operator turned generation on (``CHRONOS_ENABLE_VIDEO_GEN``).
  With neither, ``is_enabled()`` is False and b-roll comes from Pexels stock.
* **No silent cross-fallback.** If the selected provider is unconfigured the
  generator is simply off — the pipeline uses stock. It never quietly bills a
  *different* provider the operator did not choose.
* **A key is never logged**, and a failed generation never breaks a render —
  the generic client swallows every error and returns ``None`` for that clip,
  the same contract as MiniMaxClient.

The generic client follows the common async video pattern (submit a prompt →
poll a job → fetch the file URL → download). Endpoint paths, base URL, model
and the response field names all come from ``config`` so a provider's current
API can be pinned without editing code.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Sequence

import requests

import config
from modules.minimax_broll import GenerationSpec
from modules.provider_tasks import (
    OUTCOME_FAILED,
    OUTCOME_PENDING,
    OUTCOME_SUCCEEDED,
    TaskOutcome,
)

logger = logging.getLogger(__name__)


def _first(d: dict, keys: Sequence[str]) -> Optional[object]:
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ""):
            return d.get(k)
    return None


def _unwrap(payload: object) -> dict:
    """Flatten one common nesting level (`data`/`result`/`job`/`resp`) so an id
    or URL is found whether or not the response is wrapped."""
    if not isinstance(payload, dict):
        return {}
    merged = dict(payload)
    for key in ("data", "result", "job", "resp", "response"):
        inner = payload.get(key)
        if isinstance(inner, dict):
            merged = {**inner, **merged}
    return merged


_SUCCESS = {"success", "succeeded", "finished", "done", "complete", "completed", "ready"}
_FAILURE = {"fail", "failed", "error", "canceled", "cancelled", "rejected"}


@dataclass(frozen=True)
class VideoProviderConfig:
    """Everything the generic client needs to talk to one provider. All of it
    is non-secret except ``api_key``, which is never logged."""

    name: str
    api_key: str
    base_url: str
    model: str
    submit_path: str
    query_path: str            # may contain "{id}"; otherwise the id is sent as a param
    prompt_field: str = "prompt"
    model_field: str = "model"
    duration_field: str = "duration"
    negative_field: str = "negative_prompt"
    query_id_param: str = "id"
    task_id_keys: Sequence[str] = ("id", "task_id", "taskId", "job_id", "jobId")
    status_keys: Sequence[str] = ("status", "state", "task_status")
    url_keys: Sequence[str] = ("url", "video_url", "videoUrl", "download_url", "downloadUrl", "output_url")
    #: How the key is presented. Most providers take a Bearer token; some (e.g.
    #: Google Veo) put the key in a bespoke header with no prefix. Only the
    #: header NAME and PREFIX are configurable — the value is always the key, so
    #: it is set once here and never logged.
    auth_header: str = "Authorization"
    auth_prefix: str = "Bearer "


class GenericAsyncVideoClient:
    """Provider-agnostic text-to-video client: submit → poll → download.

    Matches the ``generate(spec, out_path) -> Optional[Path]`` shape so it drops
    in wherever MiniMaxClient is used. Never raises: any problem logs (without
    the key) and returns ``None`` so the section falls back to stock."""

    def __init__(self, cfg: VideoProviderConfig, *, timeout: int = 30):
        self.cfg = cfg
        self.model = cfg.model
        self.timeout = timeout
        self.session = requests.Session()
        if cfg.api_key:
            self.session.headers.update({
                cfg.auth_header: f"{cfg.auth_prefix}{cfg.api_key}",
                "Content-Type": "application/json",
            })

    def _submit(self, spec: GenerationSpec) -> Optional[str]:
        body = {
            self.cfg.model_field: self.cfg.model,
            self.cfg.prompt_field: spec.prompt,
            self.cfg.duration_field: spec.duration_seconds,
        }
        if spec.negative_prompt and self.cfg.negative_field:
            body[self.cfg.negative_field] = spec.negative_prompt
        try:
            resp = self.session.post(f"{self.cfg.base_url}{self.cfg.submit_path}",
                                     json=body, timeout=self.timeout)
            resp.raise_for_status()
            data = _unwrap(resp.json())
        except Exception as e:
            logger.warning("%s submit failed (%s: %s) — using stock b-roll instead",
                           self.cfg.name, type(e).__name__, e)
            return None
        task_id = _first(data, self.cfg.task_id_keys)
        return str(task_id) if task_id is not None else None

    def _query_url(self, task_id: str) -> tuple[str, dict]:
        if "{id}" in self.cfg.query_path:
            return f"{self.cfg.base_url}{self.cfg.query_path.format(id=task_id)}", {}
        return f"{self.cfg.base_url}{self.cfg.query_path}", {self.cfg.query_id_param: task_id}

    def _await(self, task_id: str, *, max_attempts: int = 60,
               interval: float = 5.0) -> tuple[str, Optional[str]]:
        """Poll until the job settles: ``(succeeded, url)``, ``(failed, None)``
        when the provider says so, or ``(pending, None)`` when it is still
        running or we could not tell (kept for a later poll, never re-paid)."""
        url, params = self._query_url(task_id)
        for _ in range(max(1, max_attempts)):
            try:
                resp = self.session.get(url, params=params, timeout=self.timeout)
                resp.raise_for_status()
                data = _unwrap(resp.json())
            except Exception as e:
                logger.warning("%s poll failed (%s: %s)", self.cfg.name, type(e).__name__, e)
                return OUTCOME_PENDING, None
            status = str(_first(data, self.cfg.status_keys) or "").strip().lower()
            file_url = _first(data, self.cfg.url_keys)
            if file_url is not None and (not status or status in _SUCCESS):
                return OUTCOME_SUCCEEDED, str(file_url)
            if status in _FAILURE:
                logger.warning("%s job %s reported status %r", self.cfg.name, task_id, status)
                return OUTCOME_FAILED, None
            time.sleep(max(0.0, interval))
        logger.warning("%s job %s did not finish in time", self.cfg.name, task_id)
        return OUTCOME_PENDING, None

    def _poll(self, task_id: str, *, max_attempts: int = 60, interval: float = 5.0) -> Optional[str]:
        state, file_url = self._await(task_id, max_attempts=max_attempts, interval=interval)
        return file_url if state == OUTCOME_SUCCEEDED else None

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
            logger.warning("%s clip download failed (%s: %s)", self.cfg.name, type(e).__name__, e)
            return None
        return dest if dest.exists() and dest.stat().st_size > 0 else None

    #: Opts into the provider task ledger (modules/provider_tasks.py): every
    #: provider built on this client shares the submit → poll shape, so all of
    #: them get crash-safe task persistence for free.
    supports_task_resume = True

    def submit(self, spec: GenerationSpec) -> Optional[str]:
        """Start one (billable) job; its id, or None. Never raises."""
        if not self.cfg.api_key:
            return None
        return self._submit(spec)

    def resume(self, task_id: str, out_path) -> TaskOutcome:
        """Poll an already-submitted job and download its clip. No new submit,
        so no new charge. Never raises."""
        if not self.cfg.api_key or not task_id:
            return TaskOutcome(OUTCOME_PENDING)
        state, url = self._await(str(task_id))
        if state != OUTCOME_SUCCEEDED or not url:
            return TaskOutcome(state)
        path = self._download(url, Path(out_path))
        if path is None:
            return TaskOutcome(OUTCOME_PENDING)
        return TaskOutcome(OUTCOME_SUCCEEDED, path)

    def generate(self, spec: GenerationSpec, out_path) -> Optional[Path]:
        """Generate one clip for ``spec`` into ``out_path``; ``None`` when the
        provider is unconfigured or anything goes wrong. Never raises."""
        if not self.cfg.api_key:
            return None
        task_id = self.submit(spec)
        if not task_id:
            return None
        path = self.resume(task_id, out_path).path
        if path is not None:
            logger.info("%s b-roll generated for section %d (%s)",
                        self.cfg.name, spec.section_index, spec.keyword)
        return path


# -- provider configs -------------------------------------------------------

def _higgsfield_config() -> VideoProviderConfig:
    return VideoProviderConfig(
        name="Higgsfield",
        api_key=getattr(config, "HIGGSFIELD_API_KEY", ""),
        base_url=getattr(config, "HIGGSFIELD_BASE_URL", "https://platform.higgsfield.ai").rstrip("/"),
        model=getattr(config, "HIGGSFIELD_MODEL", "higgsfield-dop"),
        submit_path=getattr(config, "HIGGSFIELD_SUBMIT_PATH", "/v1/text2video"),
        query_path=getattr(config, "HIGGSFIELD_QUERY_PATH", "/v1/jobs/{id}"),
    )


def _kling_config() -> VideoProviderConfig:
    # Kling (Kuaishou) — Bearer auth, async task then query by task id.
    return VideoProviderConfig(
        name="Kling",
        api_key=getattr(config, "KLING_API_KEY", ""),
        base_url=getattr(config, "KLING_BASE_URL", "https://api.klingai.com").rstrip("/"),
        model=getattr(config, "KLING_MODEL", "kling-v1"),
        submit_path=getattr(config, "KLING_SUBMIT_PATH", "/v1/videos/text2video"),
        query_path=getattr(config, "KLING_QUERY_PATH", "/v1/videos/text2video/{id}"),
    )


def _seedance_config() -> VideoProviderConfig:
    # Seedance (ByteDance / Volcengine Ark) — Bearer auth.
    return VideoProviderConfig(
        name="Seedance",
        api_key=getattr(config, "SEEDANCE_API_KEY", ""),
        base_url=getattr(config, "SEEDANCE_BASE_URL", "https://ark.cn-beijing.volces.com").rstrip("/"),
        model=getattr(config, "SEEDANCE_MODEL", "seedance-1-0-pro"),
        submit_path=getattr(config, "SEEDANCE_SUBMIT_PATH", "/api/v3/contents/generations/tasks"),
        query_path=getattr(config, "SEEDANCE_QUERY_PATH", "/api/v3/contents/generations/tasks/{id}"),
    )


def _wan_config() -> VideoProviderConfig:
    # Wan (Alibaba Tongyi Wanxiang / DashScope) — Bearer auth.
    return VideoProviderConfig(
        name="Wan",
        api_key=getattr(config, "WAN_API_KEY", ""),
        base_url=getattr(config, "WAN_BASE_URL", "https://dashscope-intl.aliyuncs.com").rstrip("/"),
        model=getattr(config, "WAN_MODEL", "wan2.1-t2v-turbo"),
        submit_path=getattr(config, "WAN_SUBMIT_PATH", "/api/v1/services/aigc/video-generation/video-synthesis"),
        query_path=getattr(config, "WAN_QUERY_PATH", "/api/v1/tasks/{id}"),
    )


def _veo_config() -> VideoProviderConfig:
    # Google Veo (Gemini API) — the key rides the x-goog-api-key header, no
    # Bearer prefix. Endpoints/model are env-overridable; pin them to the
    # current Gemini video docs before enabling.
    return VideoProviderConfig(
        name="Veo",
        api_key=getattr(config, "VEO_API_KEY", ""),
        base_url=getattr(config, "VEO_BASE_URL", "https://generativelanguage.googleapis.com").rstrip("/"),
        model=getattr(config, "VEO_MODEL", "veo-3.0-generate-preview"),
        submit_path=getattr(config, "VEO_SUBMIT_PATH", "/v1beta/models/veo-3.0-generate-preview:predictLongRunning"),
        query_path=getattr(config, "VEO_QUERY_PATH", "/v1beta/{id}"),
        auth_header="x-goog-api-key",
        auth_prefix="",
    )


#: Providers this router knows how to build a generic client for. MiniMax is
#: handled specially (its own client) and so is not listed here.
_GENERIC_BUILDERS = {
    "higgsfield": _higgsfield_config,
    "kling": _kling_config,
    "seedance": _seedance_config,
    "wan": _wan_config,
    "veo": _veo_config,
}


def active_provider() -> str:
    """The selected provider id (lower-case). Defaults to 'minimax'."""
    return (getattr(config, "VIDEO_PROVIDER", "minimax") or "minimax").strip().lower()


def is_enabled() -> bool:
    """True when the selected provider should generate b-roll this run.

    For 'minimax' this is exactly ``config.MINIMAX_BROLL_ENABLED`` (unchanged).
    For a generic provider it needs a key AND the opt-in flag. Anything else is
    off, so the pipeline falls back to Pexels stock."""
    provider = active_provider()
    if provider == "minimax":
        return bool(getattr(config, "MINIMAX_BROLL_ENABLED", False))
    builder = _GENERIC_BUILDERS.get(provider)
    if builder is None:
        return False
    return bool(builder().api_key) and bool(getattr(config, "VIDEO_GEN_OPT_IN", False))


def active_model() -> str:
    """The model string of the selected provider, for the advisory event."""
    provider = active_provider()
    if provider == "minimax":
        return getattr(config, "MINIMAX_H3_MODEL", "")
    builder = _GENERIC_BUILDERS.get(provider)
    return builder().model if builder else ""


def get_client(provider: Optional[str] = None):
    """Return a client for the selected (or named) provider, or ``None`` when it
    is unconfigured. The client always exposes ``generate(spec, out_path)``."""
    name = (provider or active_provider()).strip().lower()
    if name == "minimax":
        from modules.minimax_client import MiniMaxClient
        client = MiniMaxClient()
        return client if getattr(client, "api_key", "") else None
    builder = _GENERIC_BUILDERS.get(name)
    if builder is None:
        return None
    cfg = builder()
    return GenericAsyncVideoClient(cfg) if cfg.api_key else None
