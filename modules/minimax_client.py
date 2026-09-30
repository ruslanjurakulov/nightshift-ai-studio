"""MiniMax video-generation client — the network layer for AI b-roll.

This is the only part of the MiniMax integration that touches the network.
MiniMax serves its video models through two different APIs, and the model id
decides which one a request must use:

* **v1 — the Hailuo models** (``MiniMax-Hailuo-2.3``, ``-2.3-Fast``, ``-02``).
  ``POST /v1/video_generation`` with ``{model, prompt, duration}`` → ``task_id``;
  poll ``GET /v1/query/video_generation?task_id=`` until ``Success`` (with a
  ``file_id``) or ``Fail``; then ``GET /v1/files/retrieve?file_id=`` →
  ``file.download_url``. This is the flow MiniMax's own published client
  (minimax-mcp) runs, so it is the confirmed one.
* **v2 — the H3 models** (``MiniMax-H3``, ``MiniMax-H3-Max``).
  ``POST /v2/video_generation`` with a multimodal ``content`` array; the
  finished task carries ``content.url`` directly, with no file-retrieve step;
  statuses are queued / running / succeeded / failed / cancelled / expired.
  This comes from search extracts of MiniMax's docs, not from a fetched page or
  a vendor SDK, and the **task-query path was not found at all** — so it is not
  guessed here: ``MINIMAX_V2_QUERY_PATH`` must be set from the current docs
  before an H3 run can start (``preflight`` stops it otherwise, before anything
  is spent).

Before this split, H3 was sent down the v1 flow. No run ever exercised that
path (the feature flag was never on in Actions), and a rejection would not
have been seen: MiniMax reports most errors as HTTP 200 with a non-zero
``base_resp.status_code``, which the old client ignored, so every clip would
have silently become stock footage.

Guarantees, matching the rest of the pipeline:

- **Off unless configured.** With no ``MINIMAX_API_KEY`` or with the feature
  flag off (``config.MINIMAX_BROLL_ENABLED``), nothing here makes a request.
  The key is read from config, never hard-coded, and never logged — and it is
  never sent to the CDN host a finished clip is downloaded from.
- **No silent substitute** (CLAUDE.md #4). A model this client cannot call, a
  refused key, an exhausted account or a rejected request raises
  :class:`~modules.minimax_broll.VideoModelUnavailable` with the remedy. The
  flow is never switched to a different model's API to "make it work".
- **A paid task is never paid twice.** A poll that cannot reach MiniMax is
  ``pending``, not ``failed``: the task id stays in the ledger
  (modules/provider_tasks.py) and the next attempt polls it again.
"""

from __future__ import annotations

import logging
import re
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

import requests

import config
from modules.minimax_broll import (
    AUTH,
    GenerationSpec,
    VideoModelUnavailable,
    _clean,
    rejection,
)
from modules.provider_tasks import (
    OUTCOME_FAILED,
    OUTCOME_PENDING,
    OUTCOME_SUCCEEDED,
    TaskOutcome,
)

logger = logging.getLogger(__name__)

PROVIDER = "MiniMax"
FLOW_V1 = "v1"
FLOW_V2 = "v2"

_KEY_HINT = ("MINIMAX_API_KEY, and that MINIMAX_BASE_URL is the key's region "
             "(https://api.minimax.io global, https://api.minimaxi.com mainland China)")

# v1 statuses as MiniMax's own client reads them; anything else is still running.
_V1_SUCCESS = "success"
_V1_FAILURE = "fail"
# v2 statuses from the doc extract.
_V2_SUCCESS = {"succeeded"}
_V2_FAILURE = {"failed", "cancelled", "canceled", "expired"}

# MiniMax business codes that MiniMax's own client singles out
# (minimax_mcp/client.py): 1004 = authentication failed, 2038 = the account has
# not completed real-name verification. Everything else is reported verbatim.
_CODE_AUTH = 1004
_CODE_REAL_NAME = 2038

# A task id is echoed back into a request path (v2 with "{id}"): only accept
# the characters a MiniMax task id is made of.
_SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")


def flow_for_model(model: str) -> Optional[str]:
    """Which MiniMax API serves ``model``: ``v2`` for the H3 family, ``v1``
    for the Hailuo family, ``None`` for an id this client does not know how to
    call. An unknown id is refused rather than guessed at."""
    m = (model or "").strip().lower()
    if m.startswith("minimax-h3"):
        return FLOW_V2
    if m.startswith("minimax-hailuo"):
        return FLOW_V1
    return None


def is_enabled() -> bool:
    """True only when a key is present AND the operator opted in."""
    return bool(getattr(config, "MINIMAX_BROLL_ENABLED", False))


def _base_resp_error(payload) -> Optional[tuple[int, str]]:
    """``(code, message)`` when MiniMax reported an error inside a 200."""
    if not isinstance(payload, dict):
        return None
    base = payload.get("base_resp")
    if not isinstance(base, dict):
        return None
    try:
        code = int(base.get("status_code") or 0)
    except (TypeError, ValueError):
        return None
    return (code, _clean(base.get("status_msg"))) if code else None


class MiniMaxClient:
    """Thin, defensive wrapper around MiniMax's video-generation endpoints."""

    #: Opts this client into the provider task ledger (modules/provider_tasks.py):
    #: media_fetcher persists the task id between ``submit`` and ``resume`` so a
    #: crashed run polls the paid job instead of paying for it again.
    supports_task_resume = True

    def __init__(self, *, api_key: Optional[str] = None, model: Optional[str] = None,
                 timeout: int = 30):
        self.api_key = api_key if api_key is not None else getattr(config, "MINIMAX_API_KEY", "")
        self.base_url = getattr(config, "MINIMAX_BASE_URL", "https://api.minimax.io").rstrip("/")
        self.model = model if model is not None else getattr(config, "MINIMAX_H3_MODEL", "MiniMax-H3")
        self.flow = flow_for_model(self.model)
        self.v2_query_path = (getattr(config, "MINIMAX_V2_QUERY_PATH", "") or "").strip()
        self.timeout = timeout
        self.session = requests.Session()
        if self.api_key:
            self.session.headers.update({
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            })

    # -- configuration check (no network) ------------------------------------

    def preflight(self) -> None:
        """Raise ``VideoModelUnavailable`` when this configuration cannot
        produce a clip, before the run spends anything. Makes no request."""
        if self.flow is None:
            raise VideoModelUnavailable(
                PROVIDER, self.model,
                "this client only knows the MiniMax-H3* (v2 API) and MiniMax-Hailuo* (v1 API) "
                "video models",
                "set MINIMAX_H3_MODEL to one of those ids (e.g. MiniMax-Hailuo-2.3), or turn "
                "CHRONOS_ENABLE_MINIMAX_BROLL off for this deployment")
        if self.flow == FLOW_V2 and not self.v2_query_path:
            raise VideoModelUnavailable(
                PROVIDER, self.model,
                "the H3 models are served by MiniMax's v2 API, whose task-query path is not "
                "confirmed in this repository",
                "set MINIMAX_V2_QUERY_PATH from platform.minimax.io's v2 video docs (use {id} "
                "where the task id goes), or set MINIMAX_H3_MODEL=MiniMax-Hailuo-2.3 to use the "
                "v1 API")

    # -- helpers ---------------------------------------------------------------

    def _reject_http(self, resp) -> VideoModelUnavailable:
        code, msg = "", ""
        try:
            err = _base_resp_error(resp.json())
            if err:
                code, msg = str(err[0]), err[1]
        except Exception:
            pass
        return rejection(PROVIDER, self.model, status=resp.status_code, code=code,
                         message=msg, key_hint=_KEY_HINT, secrets=(self.api_key,))

    def _reject_code(self, code: int, msg: str) -> VideoModelUnavailable:
        msg = _clean(msg, (self.api_key,))
        if code == _CODE_AUTH:
            return rejection(PROVIDER, self.model, category=AUTH, code=str(code),
                             key_hint=_KEY_HINT)
        if code == _CODE_REAL_NAME:
            return VideoModelUnavailable(
                PROVIDER, self.model, f"the account is not verified ({code}, {msg})",
                "complete real-name verification in the MiniMax platform's account center, "
                "then re-run")
        return VideoModelUnavailable(
            PROVIDER, self.model, f"MiniMax refused the request ({code}, {msg})",
            f"look up code {code} in MiniMax's error-code table; retrying the same request "
            "will not help")

    def _headers_for_download(self, url: str) -> dict:
        """The download URL is on MiniMax's file CDN, a different host: the API
        key must not travel there. ``None`` removes the session header for
        this one request."""
        api_host = urlsplit(self.base_url).netloc.lower()
        if urlsplit(url).netloc.lower() == api_host:
            return {}
        return {"Authorization": None}

    # -- submit ----------------------------------------------------------------

    def _body(self, spec: GenerationSpec) -> tuple[str, dict]:
        if self.flow == FLOW_V2:
            # The content array is how the v2 API takes every input; a text
            # prompt is one "text" item. Image / video / audio references
            # would be further items with a role (first_frame, …) — b-roll
            # sends text only.
            return "/v2/video_generation", {
                "model": self.model,
                "content": [{"type": "text", "text": spec.prompt}],
                "duration": spec.duration_seconds,
            }
        # The negative prompt is already folded into the prompt text
        # (minimax_broll.build_prompt); v1 documents no separate field for it.
        return "/v1/video_generation", {
            "model": self.model,
            "prompt": spec.prompt,
            "duration": spec.duration_seconds,
        }

    def _submit(self, spec: GenerationSpec) -> str:
        self.preflight()
        path, body = self._body(spec)
        try:
            resp = self.session.post(f"{self.base_url}{path}", json=body, timeout=self.timeout)
        except requests.RequestException as e:
            raise rejection(PROVIDER, self.model, message=type(e).__name__) from None
        if resp.status_code >= 400:
            raise self._reject_http(resp)
        try:
            data = resp.json()
        except ValueError:
            raise VideoModelUnavailable(PROVIDER, self.model, "answered with a non-JSON body",
                                        "check MINIMAX_BASE_URL points at the MiniMax API") from None
        err = _base_resp_error(data)
        if err:
            raise self._reject_code(*err)
        task_id = data.get("task_id") if isinstance(data, dict) else None
        if self.flow == FLOW_V2 and not task_id and isinstance(data, dict):
            task_id = data.get("id")
        if not task_id:
            raise VideoModelUnavailable(
                PROVIDER, self.model, "accepted the request but returned no task id",
                f"the {self.flow} response shape may have changed; check it against MiniMax's docs")
        return str(task_id)

    # -- poll ------------------------------------------------------------------

    def _query(self, task_id: str):
        """One poll request. Returns the parsed body, or None when MiniMax
        could not be reached (the task is then still pending, not failed)."""
        if self.flow == FLOW_V2:
            path = self.v2_query_path
            if "{id}" in path:
                url, params = f"{self.base_url}{path.format(id=task_id)}", {}
            else:
                url, params = f"{self.base_url}{path}", {"task_id": task_id}
        else:
            url, params = f"{self.base_url}/v1/query/video_generation", {"task_id": task_id}
        try:
            resp = self.session.get(url, params=params, timeout=self.timeout)
        except requests.RequestException as e:
            logger.warning("MiniMax poll failed (%s)", type(e).__name__)
            return None
        if resp.status_code in (401, 403):
            raise self._reject_http(resp)
        if resp.status_code >= 400:
            logger.warning("MiniMax poll answered HTTP %s", resp.status_code)
            return None
        try:
            data = resp.json()
        except ValueError:
            return None
        err = _base_resp_error(data)
        if err:
            if err[0] == _CODE_AUTH:
                raise self._reject_code(*err)
            logger.warning("MiniMax poll reported %s (%s)", err[0], _clean(err[1], (self.api_key,)))
            return None
        return data if isinstance(data, dict) else None

    def _read_state(self, data: dict) -> tuple[str, Optional[str], str]:
        """``(state, locator, reason)``: the locator is a file id (v1) or the
        clip URL (v2)."""
        status = str(data.get("status") or "").strip().lower()
        if self.flow == FLOW_V2:
            content = data.get("content") if isinstance(data.get("content"), dict) else {}
            if status in _V2_SUCCESS:
                url = content.get("url")
                if url:
                    return OUTCOME_SUCCEEDED, str(url), ""
                return OUTCOME_FAILED, None, "succeeded without content.url"
            if status in _V2_FAILURE:
                err = data.get("error") if isinstance(data.get("error"), dict) else {}
                return OUTCOME_FAILED, None, _clean(err.get("message") or status, (self.api_key,))
            return OUTCOME_PENDING, None, ""
        if status == _V1_SUCCESS:
            file_id = data.get("file_id")
            if file_id:
                return OUTCOME_SUCCEEDED, str(file_id), ""
            return OUTCOME_FAILED, None, "Success without a file_id"
        if status == _V1_FAILURE:
            return OUTCOME_FAILED, None, "MiniMax reported the task as Fail"
        return OUTCOME_PENDING, None, ""

    def _await(self, task_id: str, *, max_attempts: int = 60,
               interval: float = 5.0) -> tuple[str, Optional[str], str]:
        """Poll until the task settles: ``(succeeded, locator, "")``,
        ``(failed, None, reason)`` when MiniMax said so, or ``(pending, None,
        "")`` when it is still running or could not be reached — a network
        blip is not evidence the paid job failed, so it is kept for a later
        poll."""
        for _ in range(max(1, max_attempts)):
            data = self._query(task_id)
            if data is None:
                return OUTCOME_PENDING, None, ""
            state, locator, reason = self._read_state(data)
            if state == OUTCOME_FAILED:
                logger.warning("MiniMax task %s failed: %s", task_id, reason)
            if state != OUTCOME_PENDING:
                return state, locator, reason
            time.sleep(max(0.0, interval))
        logger.warning("MiniMax task %s did not finish in time", task_id)
        return OUTCOME_PENDING, None, ""

    def _download_url(self, file_id: str) -> Optional[str]:
        """v1 only: turn a finished task's file id into its download URL."""
        try:
            resp = self.session.get(f"{self.base_url}/v1/files/retrieve",
                                    params={"file_id": file_id}, timeout=self.timeout)
            if resp.status_code >= 400:
                logger.warning("MiniMax file retrieve answered HTTP %s", resp.status_code)
                return None
            data = resp.json()
        except Exception as e:
            logger.warning("MiniMax file retrieve failed (%s)", type(e).__name__)
            return None
        file_obj = data.get("file") if isinstance(data, dict) and isinstance(data.get("file"), dict) else {}
        url = file_obj.get("download_url")
        return str(url) if url else None

    def _download(self, url: str, dest: Path) -> Optional[Path]:
        try:
            with self.session.get(url, stream=True, timeout=self.timeout,
                                  headers=self._headers_for_download(url)) as resp:
                resp.raise_for_status()
                dest.parent.mkdir(parents=True, exist_ok=True)
                with open(dest, "wb") as fh:
                    for chunk in resp.iter_content(chunk_size=1 << 16):
                        if chunk:
                            fh.write(chunk)
        except Exception as e:
            logger.warning("MiniMax clip download failed (%s)", type(e).__name__)
            return None
        return dest if dest.exists() and dest.stat().st_size > 0 else None

    # -- public ----------------------------------------------------------------

    def submit(self, spec: GenerationSpec) -> Optional[str]:
        """Start one (billable) generation task and return its id. ``None``
        only when no key is configured (no request is made). Raises
        ``VideoModelUnavailable`` when MiniMax refuses or cannot be reached."""
        if not self.api_key:
            return None
        return self._submit(spec)

    def resume(self, task_id: str, out_path) -> TaskOutcome:
        """Poll an already-submitted task and download its clip to ``out_path``.
        Makes no new submit, so it costs nothing extra."""
        if not self.api_key or not task_id:
            return TaskOutcome(OUTCOME_PENDING)
        if not _SAFE_ID.fullmatch(str(task_id)):
            return TaskOutcome(OUTCOME_FAILED, reason="the task id has unexpected characters")
        state, locator, reason = self._await(str(task_id))
        if state != OUTCOME_SUCCEEDED or not locator:
            return TaskOutcome(state, reason=reason)
        url = locator if self.flow == FLOW_V2 else self._download_url(locator)
        if not url:
            return TaskOutcome(OUTCOME_PENDING)   # finished, but not fetched yet
        path = self._download(url, Path(out_path))
        if path is None:
            return TaskOutcome(OUTCOME_PENDING)
        return TaskOutcome(OUTCOME_SUCCEEDED, path)

    def generate(self, spec: GenerationSpec, out_path: Path) -> Optional[Path]:
        """Generate one clip for ``spec`` into ``out_path``. ``None`` when no
        key is configured or the clip did not come back; raises
        ``VideoModelUnavailable`` when MiniMax refuses the request."""
        if not self.api_key:
            return None
        task_id = self.submit(spec)
        if not task_id:
            return None
        path = self.resume(task_id, out_path).path
        if path is not None:
            logger.info("MiniMax b-roll generated for section %d (%s)", spec.section_index, spec.keyword)
        return path
