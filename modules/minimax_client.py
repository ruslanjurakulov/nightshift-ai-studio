"""MiniMax H3 video-generation client — the network layer for AI b-roll.

This is the only part of the MiniMax integration that touches the network. It
follows MiniMax's documented asynchronous video pattern:

    1. POST a generation task (prompt + model)      -> a task id
    2. Poll the task until it succeeds or fails     -> a file id
    3. Retrieve the file's download URL and fetch it -> a local .mp4

Two hard guarantees, matching the rest of the pipeline:

- **Off unless configured.** With no ``MINIMAX_API_KEY`` or with the feature
  flag off (``config.MINIMAX_BROLL_ENABLED``), ``generate`` makes no request and
  returns ``None`` — the caller falls back to Pexels stock. The key is read from
  config, never hard-coded, and is never logged.
- **It never breaks a render.** Every failure (auth, quota, a task that never
  finishes, a network blip, an unexpected response shape) is caught, logged
  without the key, and returns ``None`` for that one clip. b-roll generation is
  an enhancement; a video must still render without it.

Endpoint paths, the base URL and the model string are read from ``config`` (env
vars) rather than hard-coded, because MiniMax's API reference could not be
reached from this build's network to pin them and the platform revises them.
The defaults follow MiniMax's published video API shape; confirm them against
the current docs before enabling in production.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Optional

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

# Response field names, localized here so they are trivial to adjust to the
# current MiniMax schema without touching the flow below.
_TASK_ID_KEYS = ("task_id", "taskId", "id")
_FILE_ID_KEYS = ("file_id", "fileId")
_STATUS_KEYS = ("status", "task_status", "state")
_DOWNLOAD_URL_KEYS = ("download_url", "downloadUrl", "url")
_SUCCESS = {"success", "succeeded", "finished", "done", "complete", "completed"}
_FAILURE = {"fail", "failed", "error", "canceled", "cancelled"}


def is_enabled() -> bool:
    """True only when a key is present AND the operator opted in."""
    return bool(getattr(config, "MINIMAX_BROLL_ENABLED", False))


def _first(d: dict, keys) -> Optional[object]:
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ""):
            return d.get(k)
    return None


def _unwrap(payload: dict) -> dict:
    """MiniMax often nests the useful fields under `data`/`resp`; look there too
    so a task id or file id is found whether or not the response is wrapped."""
    if not isinstance(payload, dict):
        return {}
    merged = dict(payload)
    for key in ("data", "resp", "result"):
        inner = payload.get(key)
        if isinstance(inner, dict):
            merged = {**inner, **merged}
    return merged


class MiniMaxClient:
    """Thin, defensive wrapper around MiniMax's video-generation endpoints."""

    def __init__(self, *, api_key: Optional[str] = None, timeout: int = 30):
        self.api_key = api_key if api_key is not None else getattr(config, "MINIMAX_API_KEY", "")
        self.base_url = getattr(config, "MINIMAX_BASE_URL", "https://api.minimax.io").rstrip("/")
        self.model = getattr(config, "MINIMAX_H3_MODEL", "MiniMax-H3")
        self.group_id = getattr(config, "MINIMAX_GROUP_ID", "")
        self.timeout = timeout
        self.session = requests.Session()
        if self.api_key:
            self.session.headers.update({
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            })

    # -- low-level steps (each returns None on any problem) ----------------

    def _submit(self, spec: GenerationSpec) -> Optional[str]:
        body = {
            "model": self.model,
            "prompt": spec.prompt,
            "duration": spec.duration_seconds,
        }
        if spec.negative_prompt:
            body["negative_prompt"] = spec.negative_prompt
        try:
            resp = self.session.post(f"{self.base_url}/v1/video_generation",
                                     json=body, timeout=self.timeout)
            resp.raise_for_status()
            data = _unwrap(resp.json())
        except Exception as e:
            logger.warning("MiniMax submit failed (%s: %s) — using stock b-roll instead",
                           type(e).__name__, e)
            return None
        task_id = _first(data, _TASK_ID_KEYS)
        return str(task_id) if task_id is not None else None

    def _await(self, task_id: str, *, max_attempts: int = 60,
               interval: float = 5.0) -> tuple[str, Optional[str]]:
        """Poll until the task settles. Returns ``(state, file_id)`` where state
        is ``succeeded`` (with a file id), ``failed`` (the provider said so) or
        ``pending`` (still running, or we could not tell — a network blip is not
        evidence the paid job failed, so the task is kept for a later poll)."""
        params = {"task_id": task_id}
        if self.group_id:
            params["GroupId"] = self.group_id
        for _ in range(max(1, max_attempts)):
            try:
                resp = self.session.get(f"{self.base_url}/v1/query/video_generation",
                                        params=params, timeout=self.timeout)
                resp.raise_for_status()
                data = _unwrap(resp.json())
            except Exception as e:
                logger.warning("MiniMax poll failed (%s: %s)", type(e).__name__, e)
                return OUTCOME_PENDING, None
            status = str(_first(data, _STATUS_KEYS) or "").strip().lower()
            file_id = _first(data, _FILE_ID_KEYS)
            if file_id is not None and (not status or status in _SUCCESS):
                return OUTCOME_SUCCEEDED, str(file_id)
            if status in _FAILURE:
                logger.warning("MiniMax task %s reported status %r", task_id, status)
                return OUTCOME_FAILED, None
            time.sleep(max(0.0, interval))
        logger.warning("MiniMax task %s did not finish in time", task_id)
        return OUTCOME_PENDING, None

    def _poll(self, task_id: str, *, max_attempts: int = 60, interval: float = 5.0) -> Optional[str]:
        state, file_id = self._await(task_id, max_attempts=max_attempts, interval=interval)
        return file_id if state == OUTCOME_SUCCEEDED else None

    def _download_url(self, file_id: str) -> Optional[str]:
        params = {"file_id": file_id}
        if self.group_id:
            params["GroupId"] = self.group_id
        try:
            resp = self.session.get(f"{self.base_url}/v1/files/retrieve",
                                    params=params, timeout=self.timeout)
            resp.raise_for_status()
            data = _unwrap(resp.json())
        except Exception as e:
            logger.warning("MiniMax file retrieve failed (%s: %s)", type(e).__name__, e)
            return None
        # The URL may sit under a `file` sub-object.
        file_obj = data.get("file") if isinstance(data.get("file"), dict) else data
        url = _first(file_obj, _DOWNLOAD_URL_KEYS)
        return str(url) if url else None

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
            logger.warning("MiniMax clip download failed (%s: %s)", type(e).__name__, e)
            return None
        return dest if dest.exists() and dest.stat().st_size > 0 else None

    # -- public --------------------------------------------------------------

    #: Opts this client into the provider task ledger (modules/provider_tasks.py):
    #: media_fetcher persists the task id between ``submit`` and ``resume`` so a
    #: crashed run polls the paid job instead of paying for it again.
    supports_task_resume = True

    def submit(self, spec: GenerationSpec) -> Optional[str]:
        """Start one (billable) generation task; its id, or None. Never raises."""
        if not self.api_key:
            return None
        return self._submit(spec)

    def resume(self, task_id: str, out_path) -> TaskOutcome:
        """Poll an already-submitted task and download its clip to ``out_path``.
        Makes no new submit, so it costs nothing extra. Never raises."""
        if not self.api_key or not task_id:
            return TaskOutcome(OUTCOME_PENDING)
        state, file_id = self._await(str(task_id))
        if state != OUTCOME_SUCCEEDED or not file_id:
            return TaskOutcome(state)
        url = self._download_url(file_id)
        if not url:
            return TaskOutcome(OUTCOME_PENDING)   # finished, but not fetched yet
        path = self._download(url, Path(out_path))
        if path is None:
            return TaskOutcome(OUTCOME_PENDING)
        return TaskOutcome(OUTCOME_SUCCEEDED, path)

    def generate(self, spec: GenerationSpec, out_path: Path) -> Optional[Path]:
        """Generate one clip for `spec` and save it to `out_path`, or return
        ``None`` when generation is disabled or anything goes wrong. Never
        raises."""
        if not self.api_key:
            return None
        task_id = self.submit(spec)
        if not task_id:
            return None
        path = self.resume(task_id, out_path).path
        if path is not None:
            logger.info("MiniMax b-roll generated for section %d (%s)", spec.section_index, spec.keyword)
        return path
