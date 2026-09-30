"""Video-generation provider router — pick the b-roll clip generator.

Nightshift keeps the pipeline free of vendor lock-in (see modules/providers.py):
b-roll clips can come from MiniMax or any other text-to-video provider that
matches the same tiny shape — ``generate(spec, out_path) -> Optional[Path]``,
plus the split ``submit`` / ``resume`` the task ledger uses. This module is the
seam that chooses which one a run uses, from ``config.VIDEO_PROVIDER``.

Guarantees, matching the rest of the pipeline
---------------------------------------------
* **Default is unchanged.** ``VIDEO_PROVIDER`` defaults to ``"minimax"``; for
  that value ``get_client()`` returns :class:`MiniMaxClient` and
  ``is_enabled()`` is exactly ``config.MINIMAX_BROLL_ENABLED``.
* **Others are opt-in and off by default.** Another provider runs only when its
  key is set AND the operator turned generation on (``CHRONOS_ENABLE_VIDEO_GEN``).
  With neither, ``is_enabled()`` is False and b-roll comes from Pexels stock.
* **No silent substitute** (CLAUDE.md #4). The router never falls through to a
  provider the operator did not choose, and a client whose request is refused
  raises :class:`~modules.minimax_broll.VideoModelUnavailable` with the remedy
  rather than returning "no clip" for the section to quietly become stock.
* **A key is never logged**, never put in an exception, and never sent to the
  CDN host a finished clip is downloaded from.

Each provider speaks its own documented request/response shape (a "dialect"
below): Kling, Seedance and Wan as their current docs and SDKs describe them
(Scout report, 2026-09-30); Higgsfield and Veo keep the original generic shape.
Endpoint paths, base URLs and model ids come from ``config`` so they can be
pinned without editing code.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Sequence
from urllib.parse import urlsplit

import requests

import config
from modules.minimax_broll import (
    AUTH,
    INVALID,
    NOT_FOUND,
    POLICY,
    QUOTA,
    RATE,
    UNAVAILABLE,
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


def _dig(d, *path):
    for key in path:
        if isinstance(d, dict):
            d = d.get(key)
        elif isinstance(d, list) and isinstance(key, int) and -len(d) <= key < len(d):
            d = d[key]
        else:
            return None
    return d


_SUCCESS = {"success", "succeeded", "succeed", "finished", "done", "complete", "completed", "ready"}
_FAILURE = {"fail", "failed", "error", "canceled", "cancelled", "rejected", "expired"}

#: A task id is echoed back into the poll URL's path: only the characters
#: provider task ids are made of (Veo's operation name has slashes and dots).
_SAFE_ID = re.compile(r"(?!.*\.\.)[A-Za-z0-9_./:-]{1,256}")

# Dialects: how a provider's request and response are shaped.
GENERIC = "generic"
KLING = "kling"
SEEDANCE = "seedance"
WAN = "wan"


@dataclass(frozen=True)
class VideoProviderConfig:
    """Everything the client needs to talk to one provider. All of it is
    non-secret except ``api_key`` / ``secret_key``, which are never logged
    (and kept out of ``repr``, so a stray log of the config cannot leak them)."""

    name: str
    api_key: str = field(repr=False)
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
    #: header NAME and PREFIX are configurable — the value is always the key.
    auth_header: str = "Authorization"
    auth_prefix: str = "Bearer "
    #: Request/response shape — one of the dialect constants above.
    dialect: str = GENERIC
    #: Kling's access-key mode: with a secret key, ``api_key`` is the access
    #: key and every request carries a freshly signed JWT instead of the key.
    secret_key: str = field(default="", repr=False)
    #: Settings the dialect sends as request fields (ratio, resolution).
    aspect_ratio: str = "16:9"
    resolution: str = ""
    #: Where the operator sets this provider's credentials — named in the
    #: remedy when the provider refuses them.
    key_hint: str = "the provider's API key"
    #: Set when the configuration itself is unusable; ``preflight`` raises it.
    config_problem: str = ""


# ── Kling JWT (access key + secret key) ─────────────────────────────────────

KLING_JWT_TTL_S = 1800


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def kling_jwt(access_key: str, secret_key: str, *, now: Optional[float] = None,
              ttl_s: int = KLING_JWT_TTL_S) -> str:
    """The HS256 token Kling's access-key mode expects as ``Bearer``: ``iss`` =
    access key, valid from 5 s ago for 30 min (Kling's documented lifetime).
    Built fresh for every request, so a poll loop that outlives one token
    never sends an expired one."""
    t = int(now if now is not None else time.time())
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = _b64url(json.dumps({"iss": access_key, "exp": t + ttl_s, "nbf": t - 5},
                                 separators=(",", ":")).encode())
    signing = f"{header}.{payload}".encode("ascii")
    sig = _b64url(hmac.new(secret_key.encode(), signing, hashlib.sha256).digest())
    return f"{header}.{payload}.{sig}"


def _kling_code_category(code) -> Optional[str]:
    """Kling's business codes, by documented range (1000s auth, 1100s account,
    1200s request, 1300s policy / limits). ``None`` for 0 or no code."""
    try:
        c = int(code)
    except (TypeError, ValueError):
        return None
    if c == 0:
        return None
    if 1000 <= c <= 1004 or c == 1103:
        return AUTH
    if 1100 <= c <= 1199:
        return QUOTA
    if c == 1203:
        return NOT_FOUND
    if 1200 <= c <= 1299:
        return INVALID
    if c in (1300, 1301):
        return POLICY
    if 1302 <= c <= 1304:
        return RATE
    if c >= 5000:
        return UNAVAILABLE       # Kling's server-side codes: a retry can succeed
    return None


_SEEDANCE_CODES = {
    "AuthenticationError": AUTH, "AccessDenied": AUTH,
    "AccountOverdueError": QUOTA, "QuotaExceeded": QUOTA,
    "RateLimitExceeded": RATE, "InvalidParameter": INVALID,
    "SensitiveContentDetected": POLICY, "InputTextSensitiveContentDetected": POLICY,
    "OutputVideoSensitiveContentDetected": POLICY,
    "ModelNotOpen": NOT_FOUND, "InvalidEndpointOrModel": NOT_FOUND,
}

_WAN_CODES = {
    "InvalidApiKey": AUTH, "Arrearage": QUOTA, "DataInspectionFailed": POLICY,
    "InvalidParameter": INVALID, "ModelNotFound": NOT_FOUND,
}


def _prefix_category(code, table: dict) -> Optional[str]:
    c = str(code or "")
    if not c:
        return None
    if c.startswith("Throttling"):
        return RATE
    return table.get(c) or next((v for k, v in table.items() if c.startswith(k)), None)


class GenericAsyncVideoClient:
    """Text-to-video client: submit → poll → download, in the provider's own
    dialect.

    ``submit`` raises ``VideoModelUnavailable`` when the provider refuses (or
    cannot be reached for) a request — the configured model is unavailable and
    the run must stop. A poll that cannot reach the provider is ``pending``,
    never ``failed``: the paid task stays in the ledger and is polled again."""

    #: Opts into the provider task ledger (modules/provider_tasks.py): every
    #: provider built on this client shares the submit → poll shape, so all of
    #: them get crash-safe task persistence for free.
    supports_task_resume = True

    def __init__(self, cfg: VideoProviderConfig, *, timeout: int = 30):
        self.cfg = cfg
        self.model = cfg.model
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        # Kling's JWT is minted per request (_auth_headers); every other
        # provider presents the key the same way on every request.
        if cfg.api_key and not cfg.secret_key:
            self.session.headers.update({cfg.auth_header: f"{cfg.auth_prefix}{cfg.api_key}"})

    # -- helpers ---------------------------------------------------------------

    def _auth_headers(self) -> dict:
        if self.cfg.secret_key:
            return {"Authorization": f"Bearer {kling_jwt(self.cfg.api_key, self.cfg.secret_key)}"}
        return {}

    def _headers_for_download(self, url: str) -> dict:
        """A finished clip usually sits on a CDN host: the key must not travel
        there. ``None`` removes the session's auth header for that request; the
        provider's own API host (Veo serves files from it) keeps it."""
        if urlsplit(url).netloc.lower() == urlsplit(self.cfg.base_url).netloc.lower():
            return self._auth_headers()
        return {self.cfg.auth_header: None}

    def _secrets(self) -> tuple:
        return (self.cfg.api_key, self.cfg.secret_key)

    def _reject(self, *, status=None, category=None, code="", message="") -> VideoModelUnavailable:
        return rejection(self.cfg.name, self.cfg.model, status=status, category=category,
                         code=code, message=message, key_hint=self.cfg.key_hint,
                         secrets=self._secrets())

    def preflight(self) -> None:
        """Raise ``VideoModelUnavailable`` when this configuration cannot
        produce a clip, before the run spends anything. Makes no request."""
        if self.cfg.config_problem:
            raise VideoModelUnavailable(self.cfg.name, self.cfg.model, "the configuration is unusable",
                                        self.cfg.config_problem)

    # -- request shapes ----------------------------------------------------------

    def _body(self, spec: GenerationSpec) -> tuple[dict, dict]:
        """``(json body, extra headers)`` for one submit."""
        cfg = self.cfg
        if cfg.dialect == KLING:
            body = {
                "model_name": cfg.model,
                "prompt": spec.prompt,
                "duration": str(spec.duration_seconds),   # Kling takes "5" / "10"
                "mode": "std",
                "aspect_ratio": cfg.aspect_ratio,
            }
            if spec.negative_prompt:
                body["negative_prompt"] = spec.negative_prompt
            return body, {}
        if cfg.dialect == SEEDANCE:
            body = {
                "model": cfg.model,
                "content": [{"type": "text", "text": spec.prompt}],
                "ratio": cfg.aspect_ratio,
                "duration": spec.duration_seconds,
            }
            if cfg.resolution:
                body["resolution"] = cfg.resolution
            return body, {}
        if cfg.dialect == WAN:
            inp = {"prompt": spec.prompt}
            if spec.negative_prompt:
                inp["negative_prompt"] = spec.negative_prompt
            params = {"ratio": cfg.aspect_ratio, "duration": spec.duration_seconds}
            if cfg.resolution:
                params["resolution"] = cfg.resolution
            # Without this header DashScope refuses a video task outright:
            # video synthesis only runs asynchronously.
            return ({"model": cfg.model, "input": inp, "parameters": params},
                    {"X-DashScope-Async": "enable"})
        body = {
            cfg.model_field: cfg.model,
            cfg.prompt_field: spec.prompt,
            cfg.duration_field: spec.duration_seconds,
        }
        if spec.negative_prompt and cfg.negative_field:
            body[cfg.negative_field] = spec.negative_prompt
        return body, {}

    def _error_of(self, data) -> tuple[Optional[str], str, str]:
        """``(category, code, message)`` a response body reports, if any."""
        d = self.cfg.dialect
        if d == KLING:
            code = _dig(data, "code")
            return _kling_code_category(code), str(code or ""), _clean(_dig(data, "message"))
        if d == SEEDANCE:
            code = _dig(data, "error", "code")
            return _prefix_category(code, _SEEDANCE_CODES), str(code or ""), _clean(_dig(data, "error", "message"))
        if d == WAN:
            code = _dig(data, "code") or _dig(data, "output", "code")
            msg = _dig(data, "message") or _dig(data, "output", "message")
            return _prefix_category(code, _WAN_CODES), str(code or ""), _clean(msg)
        return None, "", ""

    def _task_id_of(self, data) -> Optional[str]:
        d = self.cfg.dialect
        if d == KLING:
            tid = _dig(data, "data", "task_id")
        elif d == SEEDANCE:
            tid = _dig(data, "id")
        elif d == WAN:
            tid = _dig(data, "output", "task_id")
        else:
            tid = _first(_unwrap(data), self.cfg.task_id_keys)
        return str(tid) if tid not in (None, "") else None

    def _state_of(self, data) -> tuple[str, Optional[str], str]:
        """``(state, clip_url, reason)`` from one poll response."""
        d = self.cfg.dialect
        if d == KLING:
            status = str(_dig(data, "data", "task_status") or "").lower()
            if status == "succeed":
                url = _dig(data, "data", "task_result", "videos", 0, "url")
                return ((OUTCOME_SUCCEEDED, str(url), "") if url
                        else (OUTCOME_FAILED, None, "succeeded without a video URL"))
            if status == "failed":
                return OUTCOME_FAILED, None, _clean(_dig(data, "data", "task_status_msg") or "failed")
            return OUTCOME_PENDING, None, ""
        if d == SEEDANCE:
            status = str(_dig(data, "status") or "").lower()
            if status == "succeeded":
                url = _dig(data, "content", "video_url")
                return ((OUTCOME_SUCCEEDED, str(url), "") if url
                        else (OUTCOME_FAILED, None, "succeeded without content.video_url"))
            if status in ("failed", "cancelled", "expired"):
                return OUTCOME_FAILED, None, _clean(_dig(data, "error", "message") or status)
            return OUTCOME_PENDING, None, ""
        if d == WAN:
            status = str(_dig(data, "output", "task_status") or "").upper()
            if status == "SUCCEEDED":
                url = _dig(data, "output", "video_url")
                return ((OUTCOME_SUCCEEDED, str(url), "") if url
                        else (OUTCOME_FAILED, None, "succeeded without output.video_url"))
            if status in ("FAILED", "CANCELED", "UNKNOWN"):
                return OUTCOME_FAILED, None, _clean(_dig(data, "output", "message") or status)
            return OUTCOME_PENDING, None, ""
        flat = _unwrap(data)
        status = str(_first(flat, self.cfg.status_keys) or "").strip().lower()
        file_url = _first(flat, self.cfg.url_keys)
        if file_url is not None and (not status or status in _SUCCESS):
            return OUTCOME_SUCCEEDED, str(file_url), ""
        if status in _FAILURE:
            return OUTCOME_FAILED, None, status
        return OUTCOME_PENDING, None, ""

    # -- network steps -------------------------------------------------------------

    def _submit(self, spec: GenerationSpec) -> str:
        self.preflight()
        body, extra = self._body(spec)
        try:
            resp = self.session.post(f"{self.cfg.base_url}{self.cfg.submit_path}", json=body,
                                     headers={**self._auth_headers(), **extra}, timeout=self.timeout)
        except requests.RequestException as e:
            raise self._reject(message=type(e).__name__) from None
        try:
            data = resp.json()
        except ValueError:
            data = None
        category, code, message = self._error_of(data)
        if resp.status_code >= 400:
            raise self._reject(status=resp.status_code, category=category, code=code, message=message)
        if category or (self.cfg.dialect == KLING and code not in ("", "0")):
            raise self._reject(category=category or INVALID, code=code, message=message)
        task_id = self._task_id_of(data)
        if not task_id:
            raise VideoModelUnavailable(
                self.cfg.name, self.cfg.model, "accepted the request but returned no task id",
                f"the {self.cfg.name} response shape may have changed; check it against the provider's docs")
        return task_id

    def _query_url(self, task_id: str) -> tuple[str, dict]:
        if "{id}" in self.cfg.query_path:
            return f"{self.cfg.base_url}{self.cfg.query_path.format(id=task_id)}", {}
        return f"{self.cfg.base_url}{self.cfg.query_path}", {self.cfg.query_id_param: task_id}

    def _await(self, task_id: str, *, max_attempts: int = 60,
               interval: float = 5.0) -> tuple[str, Optional[str], str]:
        """Poll until the job settles: ``(succeeded, url, "")``, ``(failed,
        None, reason)`` when the provider says so, or ``(pending, None, "")``
        when it is still running or we could not tell (kept for a later poll,
        never re-paid)."""
        url, params = self._query_url(task_id)
        for _ in range(max(1, max_attempts)):
            try:
                resp = self.session.get(url, params=params, headers=self._auth_headers(),
                                        timeout=self.timeout)
                resp.raise_for_status()
                data = resp.json()
            except Exception as e:
                logger.warning("%s poll failed (%s)", self.cfg.name, type(e).__name__)
                return OUTCOME_PENDING, None, ""
            state, file_url, reason = self._state_of(data)
            reason = _clean(reason, self._secrets())
            if state == OUTCOME_FAILED:
                logger.warning("%s job %s failed: %s", self.cfg.name, task_id, reason)
            if state != OUTCOME_PENDING:
                return state, file_url, reason
            time.sleep(max(0.0, interval))
        logger.warning("%s job %s did not finish in time", self.cfg.name, task_id)
        return OUTCOME_PENDING, None, ""

    def _poll(self, task_id: str, *, max_attempts: int = 60, interval: float = 5.0) -> Optional[str]:
        state, file_url, _ = self._await(task_id, max_attempts=max_attempts, interval=interval)
        return file_url if state == OUTCOME_SUCCEEDED else None

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
            logger.warning("%s clip download failed (%s)", self.cfg.name, type(e).__name__)
            return None
        return dest if dest.exists() and dest.stat().st_size > 0 else None

    # -- public ----------------------------------------------------------------------

    def submit(self, spec: GenerationSpec) -> Optional[str]:
        """Start one (billable) job and return its id. ``None`` only when no key
        is configured (no request is made); raises ``VideoModelUnavailable``
        when the provider refuses or cannot be reached."""
        if not self.cfg.api_key:
            return None
        return self._submit(spec)

    def resume(self, task_id: str, out_path) -> TaskOutcome:
        """Poll an already-submitted job and download its clip. No new submit,
        so no new charge."""
        if not self.cfg.api_key or not task_id:
            return TaskOutcome(OUTCOME_PENDING)
        if not _SAFE_ID.fullmatch(str(task_id)):
            return TaskOutcome(OUTCOME_FAILED, reason="the task id has unexpected characters")
        state, url, reason = self._await(str(task_id))
        if state != OUTCOME_SUCCEEDED or not url:
            return TaskOutcome(state, reason=reason)
        path = self._download(url, Path(out_path))
        if path is None:
            return TaskOutcome(OUTCOME_PENDING)
        return TaskOutcome(OUTCOME_SUCCEEDED, path)

    def generate(self, spec: GenerationSpec, out_path) -> Optional[Path]:
        """Generate one clip for ``spec`` into ``out_path``; ``None`` when the
        provider is unconfigured or the clip did not come back. Raises
        ``VideoModelUnavailable`` when the provider refuses the request."""
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
        key_hint="HIGGSFIELD_API_KEY",
    )


def _kling_credentials() -> tuple[str, str]:
    """``(key, secret)``: an access key + secret key pair (JWT mode) when both
    are set — as KLING_ACCESS_KEY/KLING_SECRET_KEY, or as KLING_API_KEY in the
    form ``access:secret`` — else a console API key sent as Bearer, with an
    empty secret."""
    ak = (getattr(config, "KLING_ACCESS_KEY", "") or "").strip()
    sk = (getattr(config, "KLING_SECRET_KEY", "") or "").strip()
    if ak and sk:
        return ak, sk
    combined = (getattr(config, "KLING_API_KEY", "") or "").strip()
    if ":" in combined:
        a, s = (p.strip() for p in combined.split(":", 1))
        if a and s:
            return a, s
        return "", ""
    return combined, ""


def _kling_config() -> VideoProviderConfig:
    # Kling international: the api-singapore host, model_name, and either a
    # console API key (Bearer) or a JWT signed from the access + secret key.
    # The /v1/videos/text2video path is the one Kling now files as "legacy";
    # it is documented for kling-v2-6, which is why that is the default model
    # (the v3 per-model path is not confirmed).
    key, secret = _kling_credentials()
    return VideoProviderConfig(
        name="Kling",
        api_key=key,
        secret_key=secret,
        base_url=getattr(config, "KLING_BASE_URL", "https://api-singapore.klingai.com").rstrip("/"),
        model=getattr(config, "KLING_MODEL", "kling-v2-6"),
        submit_path=getattr(config, "KLING_SUBMIT_PATH", "/v1/videos/text2video"),
        query_path=getattr(config, "KLING_QUERY_PATH", "/v1/videos/text2video/{id}"),
        dialect=KLING,
        key_hint="KLING_API_KEY (a console API key), or KLING_ACCESS_KEY and KLING_SECRET_KEY",
    )


def _seedance_config() -> VideoProviderConfig:
    # Seedance on BytePlus ModelArk (international), not Volcengine China.
    return VideoProviderConfig(
        name="Seedance",
        api_key=getattr(config, "SEEDANCE_API_KEY", ""),
        base_url=getattr(config, "SEEDANCE_BASE_URL", "https://ark.ap-southeast.bytepluses.com").rstrip("/"),
        model=getattr(config, "SEEDANCE_MODEL", "seedance-1-0-pro-250528"),
        submit_path=getattr(config, "SEEDANCE_SUBMIT_PATH", "/api/v3/contents/generations/tasks"),
        query_path=getattr(config, "SEEDANCE_QUERY_PATH", "/api/v3/contents/generations/tasks/{id}"),
        dialect=SEEDANCE,
        resolution=getattr(config, "SEEDANCE_RESOLUTION", "720p"),
        key_hint="SEEDANCE_API_KEY (a BytePlus ModelArk API key), and that the model is activated "
                 "in the ModelArk console",
    )


_WORKSPACE_ID = re.compile(r"[A-Za-z0-9-]{1,64}")
WAN_SHARED_BASE_URL = "https://dashscope-intl.aliyuncs.com"


def _wan_config() -> VideoProviderConfig:
    # Wan on Alibaba Model Studio (international). The shared DashScope host
    # went into maintenance mode on 2026-09-30 (served, no new models); the
    # per-workspace host replaces it when WAN_WORKSPACE_ID is set. The id
    # becomes a hostname label, so anything but [A-Za-z0-9-] is refused.
    explicit = (getattr(config, "WAN_BASE_URL", "") or "").strip().rstrip("/")
    workspace = (getattr(config, "WAN_WORKSPACE_ID", "") or "").strip()
    problem = ""
    if explicit:
        base = explicit
    elif workspace and _WORKSPACE_ID.fullmatch(workspace):
        base = f"https://{workspace}.ap-southeast-1.maas.aliyuncs.com"
    else:
        base = WAN_SHARED_BASE_URL
        if workspace:
            problem = ("WAN_WORKSPACE_ID must be the Model Studio workspace id (letters, digits and "
                       "hyphens only); copy it from the Model Studio console")
    return VideoProviderConfig(
        name="Wan",
        api_key=getattr(config, "WAN_API_KEY", ""),
        base_url=base,
        model=getattr(config, "WAN_MODEL", "wan2.7-t2v"),
        submit_path=getattr(config, "WAN_SUBMIT_PATH", "/api/v1/services/aigc/video-generation/video-synthesis"),
        query_path=getattr(config, "WAN_QUERY_PATH", "/api/v1/tasks/{id}"),
        dialect=WAN,
        resolution=getattr(config, "WAN_RESOLUTION", "720P"),
        key_hint="WAN_API_KEY (keys are region-specific: use an international Model Studio key)",
        config_problem=problem,
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
        key_hint="VEO_API_KEY",
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


def preflight() -> None:
    """Before the run spends anything: when generated b-roll is on, raise
    ``VideoModelUnavailable`` if the selected provider's configuration cannot
    produce a clip (unknown model family, a required path not set, a malformed
    workspace id). Makes no network request; a no-op when b-roll is off."""
    if not is_enabled():
        return
    client = get_client()
    if client is None:
        raise VideoModelUnavailable(active_provider(), active_model(), "no API key is configured",
                                    "set the provider's API key, or turn generated b-roll off")
    check = getattr(client, "preflight", None)
    if callable(check):
        check()
