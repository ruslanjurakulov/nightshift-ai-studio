"""Video adapters: Veo, Kling, MiniMax Hailuo, Runway, Luma, Seedance, Wan.

All of these are asynchronous: ``submit`` starts a billable job and returns its
task id, ``poll`` asks about that id and never re-submits, ``fetch`` downloads
the clip. Each calls the vendor's documented endpoint (the model's
``api_documented`` entry in ``schemas/model_registry.json`` names the source);
base URLs are env-overridable (https only) so a vendor's host move is a config
change, not a release.

Task ids are validated before they are put into a URL: an id comes back from a
job row, and a row is data, so it must not be able to steer a request (and our
key) anywhere else.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
from typing import Dict, List, Optional, Tuple

from modules.capabilities.base import (
    E_AUTH,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_CONFIGURED,
    E_NOT_FOUND,
    E_POLICY,
    E_QUOTA,
    E_RATE_LIMITED,
    E_UNAVAILABLE,
    FAILED,
    I2V,
    PENDING,
    SUCCEEDED,
    T2V,
    AdapterError,
    CapabilityRequest,
    HttpAdapter,
    Output,
    PollResult,
    ProviderTask,
    b64_output,
    dig,
    host_is,
    image_b64,
    image_data_uri,
    image_mime,
    is_url,
    json_body,
)

_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")
_POLICY_HINTS = ("safety", "policy", "blocked", "moderation", "sensitive", "risk")


def _safe_id(task_id: Optional[str], pattern: re.Pattern = _ID) -> str:
    tid = str(task_id or "")
    if not pattern.fullmatch(tid):
        raise AdapterError(E_NOT_FOUND, "task id has an unexpected shape")
    return tid


def _image_ref(path: str) -> str:
    """An https URL as is, a local file as a data URI (vendors that accept both)."""
    return path if is_url(path) else image_data_uri(path)


def _failed(adapter: HttpAdapter, msg, default: str = E_UNAVAILABLE) -> PollResult:
    text = adapter.message(msg) or "the vendor reported the task failed"
    code = E_POLICY if any(w in text.lower() for w in _POLICY_HINTS) else default
    return PollResult(FAILED, error=AdapterError(code, text))


# ── Google Veo (Gemini API) ─────────────────────────────────────────────────
class VeoAdapter(HttpAdapter):
    """``POST /v1beta/models/{model}:predictLongRunning`` → an operation name;
    ``GET /v1beta/{name}`` until ``done``; the clip is a file URI (downloaded
    with the key header, Google hosts only) or inline ``encodedVideo``.
    Field names are those of google-genai's ``generate_videos``."""

    key = "video.veo"
    key_env = ("VEO_API_KEY", "GEMINI_API_KEY")
    base_url_env = "VEO_BASE_URL"
    default_base_url = "https://generativelanguage.googleapis.com"
    capabilities = (T2V, I2V)
    _OP = re.compile(r"^models/[A-Za-z0-9.-]+/operations/[A-Za-z0-9_-]+$")

    def auth_headers(self) -> Dict[str, str]:
        return {"x-goog-api-key": self.api_key()}

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        instance: dict = {"prompt": request.prompt.strip()}
        if request.capability == I2V and request.input_images:
            path = request.input_images[0]
            instance["image"] = {"bytesBase64Encoded": image_b64(path), "mimeType": image_mime(path)}
        params: dict = {"aspectRatio": request.aspect_ratio or "16:9"}
        if request.duration_s:
            params["durationSeconds"] = int(request.duration_s)
        if request.resolution:
            params["resolution"] = request.resolution
        if request.negative_prompt:
            params["negativePrompt"] = request.negative_prompt
        data = self.post(f"{self.base_url}/v1beta/models/{vendor_model}:predictLongRunning",
                         {"instances": [instance], "parameters": params})
        name = data.get("name")
        if not name:
            raise AdapterError(E_BAD_RESPONSE, "no operation name in the response")
        return ProviderTask(self.key, vendor_model, _safe_id(name, self._OP))

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        name = _safe_id(task.task_id, self._OP)
        data = self.get(f"{self.base_url}/v1beta/{name}")
        if not data.get("done"):
            return PollResult(PENDING)
        if data.get("error"):
            return _failed(self, dig(data, "error", "message") or "operation failed")
        resp = dig(data, "response", "generateVideoResponse") or {}
        video = dig(resp, "generatedSamples", 0, "video") or {}
        if video.get("encodedVideo"):
            return PollResult(SUCCEEDED, [b64_output(video["encodedVideo"], "video/mp4")])
        uri = video.get("uri")
        if uri:
            if not host_is(uri, "generativelanguage.googleapis.com"):
                # The key header goes only to Google's own file endpoint.
                raise AdapterError(E_BAD_RESPONSE, "video URI is not a Gemini API file URL")
            return PollResult(SUCCEEDED, [Output("video/mp4", url=str(uri),
                                                 url_headers=self.auth_headers())])
        if resp.get("raiMediaFilteredCount") or resp.get("raiMediaFilteredReasons"):
            reasons = "; ".join(map(str, resp.get("raiMediaFilteredReasons") or []))
            return PollResult(FAILED, error=AdapterError(E_POLICY, self.message(reasons) or "filtered"))
        return PollResult(FAILED, error=AdapterError(E_BAD_RESPONSE, "done without a video"))


# ── Kling (console API key, or JWT from access key + secret key) ───────────
def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


KLING_JWT_TTL_S = 1800


def kling_jwt(access_key: str, secret_key: str, *, now: Optional[float] = None,
              ttl_s: int = KLING_JWT_TTL_S) -> str:
    """The HS256 token Kling's access-key mode expects in ``Authorization:
    Bearer``: ``iss`` = access key, valid from 5 s ago for ``ttl_s`` (Kling
    documents 30 min). Built fresh for every request, so a poll loop that runs
    longer than the lifetime never sends an expired token."""
    t = int(now if now is not None else time.time())
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = _b64url(json.dumps({"iss": access_key, "exp": t + ttl_s, "nbf": t - 5},
                                 separators=(",", ":")).encode())
    signing = f"{header}.{payload}".encode("ascii")
    sig = _b64url(hmac.new(secret_key.encode(), signing, hashlib.sha256).digest())
    return f"{header}.{payload}.{sig}"


class KlingAdapter(HttpAdapter):
    """``POST /v1/videos/{text2video|image2video}`` → ``data.task_id``;
    ``GET /v1/videos/{kind}/{task_id}`` → ``data.task_status`` and
    ``data.task_result.videos[0].url``. Kling files this shape under its
    "legacy" pages; the per-model v3 path is not confirmed, so kling-v3 stays
    hidden until a probe on this path succeeds.

    Two documented auth modes:

    * ``KLING_ACCESS_KEY`` + ``KLING_SECRET_KEY`` (or ``KLING_API_KEY`` as
      ``<access key>:<secret key>``) → a fresh HS256 JWT per request;
    * ``KLING_API_KEY`` without a colon → a console API key, sent as is."""

    key = "video.kling"
    key_env = ("KLING_API_KEY", "KLING_ACCESS_KEY", "KLING_SECRET_KEY")
    base_url_env = "KLING_BASE_URL"
    default_base_url = "https://api-singapore.klingai.com"
    capabilities = (T2V, I2V)
    _TASK = re.compile(r"^(text2video|image2video)/[A-Za-z0-9_-]{1,128}$")

    def _pair(self) -> Tuple[str, str]:
        ak = (self._env.get("KLING_ACCESS_KEY") or "").strip()
        sk = (self._env.get("KLING_SECRET_KEY") or "").strip()
        if ak and sk:
            return ak, sk
        combined = (self._env.get("KLING_API_KEY") or "").strip()
        if ":" in combined:
            ak, sk = (p.strip() for p in combined.split(":", 1))
            if ak and sk:
                return ak, sk
        return "", ""

    def _console_key(self) -> str:
        combined = (self._env.get("KLING_API_KEY") or "").strip()
        return combined if combined and ":" not in combined else ""

    def api_key(self) -> str:
        ak, sk = self._pair()
        return f"{ak}:{sk}" if ak and sk else self._console_key()

    def secrets(self) -> List[str]:
        own = [s for s in (*self._pair(), self._console_key(),
                           (self._env.get("KLING_API_KEY") or "").strip()) if s]
        return own + super().secrets()

    def require_key(self) -> None:
        if not self.configured():
            raise AdapterError(E_NOT_CONFIGURED, "no Kling key on this worker (set KLING_API_KEY, or "
                                                 "KLING_ACCESS_KEY and KLING_SECRET_KEY)")

    def auth_headers(self) -> Dict[str, str]:
        ak, sk = self._pair()
        if ak and sk:
            return {"Authorization": f"Bearer {kling_jwt(ak, sk)}"}
        key = self._console_key()
        return {"Authorization": f"Bearer {key}"} if key else {}

    @staticmethod
    def code_for(code) -> Optional[str]:
        """Kling's business codes (1000s auth, 1100s account, 1200s request,
        1300s policy/limits, 5000s server) → ours. The table page could not
        be read in full (egress blocked); an unknown code falls back to the
        HTTP status, never to "success"."""
        try:
            c = int(code)
        except (TypeError, ValueError):
            return None
        if c == 0:
            return None
        if 1000 <= c <= 1004 or c == 1103:
            return E_AUTH                 # bad / expired token, no access to the resource
        if 1100 <= c <= 1199:
            return E_QUOTA                # account arrears / resource pack used up
        if c == 1203:
            return E_NOT_FOUND
        if 1200 <= c <= 1299:
            return E_BAD_REQUEST
        if c in (1300, 1301):
            return E_POLICY
        if 1302 <= c <= 1304:
            return E_RATE_LIMITED
        return E_UNAVAILABLE

    def vendor_error_code(self, status: int, text: str) -> Optional[str]:
        return self.code_for(json_body(text).get("code"))

    def _check(self, data: dict) -> dict:
        code = self.code_for(data.get("code"))
        if code:
            raise AdapterError(code, self.message(data.get("message") or "Kling error"))
        return data.get("data") or {}

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        kind = "image2video" if request.capability == I2V else "text2video"
        body: dict = {"model_name": vendor_model, "prompt": request.prompt.strip(),
                      "duration": str(int(request.duration_s or 5)), "mode": "std"}
        if request.negative_prompt:
            body["negative_prompt"] = request.negative_prompt
        if kind == "image2video":
            path = request.input_images[0]
            # Kling takes a URL or raw base64 (no data: prefix).
            body["image"] = path if is_url(path) else image_b64(path)
        else:
            body["aspect_ratio"] = request.aspect_ratio or "16:9"
        data = self._check(self.post(f"{self.base_url}/v1/videos/{kind}", body))
        task_id = data.get("task_id")
        if not task_id:
            raise AdapterError(E_BAD_RESPONSE, "no task_id in the response")
        return ProviderTask(self.key, vendor_model, _safe_id(f"{kind}/{task_id}", self._TASK))

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        tid = _safe_id(task.task_id, self._TASK)
        data = self._check(self.get(f"{self.base_url}/v1/videos/{tid}"))
        status = str(data.get("task_status") or "").lower()
        if status == "succeed":
            url = dig(data, "task_result", "videos", 0, "url")
            if not url:
                raise AdapterError(E_BAD_RESPONSE, "succeeded without a video URL")
            return PollResult(SUCCEEDED, [Output("video/mp4", url=str(url))])
        if status == "failed":
            return _failed(self, data.get("task_status_msg") or "task failed")
        return PollResult(PENDING)


# ── MiniMax Hailuo (v1 flow; the H3 models use /v2 and are not wired here) ──
class MiniMaxVideoAdapter(HttpAdapter):
    """``POST /v1/video_generation`` → ``task_id``; ``GET
    /v1/query/video_generation?task_id=`` → ``status`` + ``file_id``;
    ``GET /v1/files/retrieve?file_id=`` → ``file.download_url``
    (MiniMax's own MCP server makes exactly these calls)."""

    key = "video.minimax"
    key_env = ("MINIMAX_API_KEY",)
    base_url_env = "MINIMAX_BASE_URL"
    default_base_url = "https://api.minimax.io"
    capabilities = (T2V, I2V)
    _CODES = {1002: E_RATE_LIMITED, 1004: E_AUTH, 2049: E_AUTH, 1008: E_QUOTA,
              1026: E_POLICY, 1027: E_POLICY, 1042: E_POLICY, 2013: E_BAD_REQUEST}

    def _check(self, data: dict) -> dict:
        status = dig(data, "base_resp", "status_code")
        if status not in (None, 0, "0"):
            try:
                code = self._CODES.get(int(status), E_UNAVAILABLE)
            except (TypeError, ValueError):
                code = E_UNAVAILABLE
            raise AdapterError(code, self.message(dig(data, "base_resp", "status_msg") or "MiniMax error"))
        return data

    def vendor_error_code(self, status: int, text: str) -> Optional[str]:
        raw = dig(json_body(text), "base_resp", "status_code")
        try:
            return self._CODES.get(int(raw)) if raw is not None else None
        except (TypeError, ValueError):
            return None

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        body: dict = {"model": vendor_model, "prompt": request.prompt.strip(),
                      "duration": int(request.duration_s or 6),
                      "resolution": (request.resolution or "768p").upper()}
        if request.capability == I2V and request.input_images:
            body["first_frame_image"] = _image_ref(request.input_images[0])
        data = self._check(self.post(f"{self.base_url}/v1/video_generation", body))
        if not data.get("task_id"):
            raise AdapterError(E_BAD_RESPONSE, "no task_id in the response")
        return ProviderTask(self.key, vendor_model, _safe_id(data["task_id"]))

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        tid = _safe_id(task.task_id)
        data = self._check(self.get(f"{self.base_url}/v1/query/video_generation",
                                    params={"task_id": tid}))
        status = str(data.get("status") or "").lower()
        if status == "success":
            file_id = data.get("file_id")
            if not file_id:
                raise AdapterError(E_BAD_RESPONSE, "success without file_id")
            file = self._check(self.get(f"{self.base_url}/v1/files/retrieve",
                                        params={"file_id": _safe_id(file_id)}, what="retrieve"))
            url = dig(file, "file", "download_url")
            if not url:
                raise AdapterError(E_BAD_RESPONSE, "no download_url for the file")
            return PollResult(SUCCEEDED, [Output("video/mp4", url=str(url))])
        if status == "fail":
            return _failed(self, "the vendor reported the task failed")
        return PollResult(PENDING)


# ── Runway ──────────────────────────────────────────────────────────────────
class RunwayAdapter(HttpAdapter):
    """``POST /v1/text_to_video`` or ``/v1/image_to_video`` (header
    ``X-Runway-Version: 2024-11-06``) → ``id``; ``GET /v1/tasks/{id}`` →
    ``status`` and ``output[0]`` (runwayml SDK)."""

    key = "video.runway"
    key_env = ("RUNWAYML_API_SECRET", "RUNWAY_API_KEY")
    base_url_env = "RUNWAY_BASE_URL"
    default_base_url = "https://api.dev.runwayml.com"
    capabilities = (T2V, I2V)
    API_VERSION = "2024-11-06"
    _RATIOS = {"16:9": "1280:720", "9:16": "720:1280", "1:1": "960:960",
               "4:3": "1104:832", "3:4": "832:1104", "21:9": "1584:672"}
    #: text_to_video (gen4.5) documents only the two 720p ratios.
    _T2V_RATIOS = ("16:9", "9:16")

    def auth_headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key()}", "X-Runway-Version": self.API_VERSION}

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        if request.capability == T2V and (request.aspect_ratio or "16:9") not in self._T2V_RATIOS:
            out.append("Runway text-to-video takes 16:9 or 9:16 only")
        return out

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        ratio = self._RATIOS.get(request.aspect_ratio or "16:9")
        if not ratio or (request.capability == T2V and (request.aspect_ratio or "16:9") not in self._T2V_RATIOS):
            raise AdapterError(E_BAD_REQUEST, "aspect ratio not offered by Runway for this capability")
        body: dict = {"model": vendor_model, "promptText": request.prompt.strip(), "ratio": ratio,
                      "duration": int(request.duration_s or 5)}
        if request.capability == I2V:
            body["promptImage"] = _image_ref(request.input_images[0])
            path = "image_to_video"
        else:
            path = "text_to_video"
        data = self.post(f"{self.base_url}/v1/{path}", body)
        if not data.get("id"):
            raise AdapterError(E_BAD_RESPONSE, "no task id in the response")
        return ProviderTask(self.key, vendor_model, _safe_id(data["id"]))

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        data = self.get(f"{self.base_url}/v1/tasks/{_safe_id(task.task_id)}")
        status = str(data.get("status") or "").upper()
        if status == "SUCCEEDED":
            url = dig(data, "output", 0)
            if not url:
                raise AdapterError(E_BAD_RESPONSE, "succeeded without output")
            return PollResult(SUCCEEDED, [Output("video/mp4", url=str(url))])
        if status in ("FAILED", "CANCELLED"):
            fcode = str(data.get("failureCode") or "")
            if "SAFETY" in fcode.upper():
                return PollResult(FAILED, error=AdapterError(E_POLICY, self.message(fcode)))
            return _failed(self, f"{fcode} {data.get('failure') or ''}".strip() or status)
        return PollResult(PENDING, progress=data.get("progress"))


# ── Luma (Agents API) ───────────────────────────────────────────────────────
class LumaAdapter(HttpAdapter):
    """``POST /v1/generations`` with ``type: "video"`` and ``video: {duration,
    resolution, start_frame}`` → ``id``; ``GET /v1/generations/{id}`` →
    ``state`` (queued | processing | completed | failed), ``output[].url`` and
    ``failure_code`` (luma-agents SDK). The older Dream Machine API and its
    Ray 2 models are deprecated by Luma and are not wired.

    Luma's API terms forbid a service that "substantially replicates" Luma
    without written consent, so its registry entries carry a ``terms_gate``
    that keeps them unsellable (migration 0035) until the owner has it."""

    key = "video.luma"
    key_env = ("LUMA_AGENTS_API_KEY",)
    base_url_env = "LUMA_AGENTS_BASE_URL"
    default_base_url = "https://agents.lumalabs.ai/v1"
    capabilities = (T2V, I2V)
    _FAILURES = {"content_moderated": E_POLICY, "budget_exhausted": E_QUOTA,
                 "rate_limited": E_RATE_LIMITED, "invalid_request": E_BAD_REQUEST,
                 "image_too_large": E_BAD_REQUEST, "unsupported_format": E_BAD_REQUEST,
                 "corrupt_input": E_BAD_REQUEST, "output_not_found": E_UNAVAILABLE,
                 "generation_failed": E_UNAVAILABLE}

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        video: dict = {}
        if request.duration_s:
            video["duration"] = f"{int(request.duration_s)}s"
        if request.resolution:
            video["resolution"] = request.resolution
        if request.capability == I2V:
            path = request.input_images[0]
            video["start_frame"] = ({"url": path} if is_url(path)
                                    else {"data": image_b64(path), "media_type": image_mime(path)})
        body: dict = {"model": vendor_model, "type": "video", "prompt": request.prompt.strip(),
                      "aspect_ratio": request.aspect_ratio or "16:9"}
        if video:
            body["video"] = video
        data = self.post(f"{self.base_url}/generations", body)
        if not data.get("id"):
            raise AdapterError(E_BAD_RESPONSE, "no generation id in the response")
        return ProviderTask(self.key, vendor_model, _safe_id(data["id"]))

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        data = self.get(f"{self.base_url}/generations/{_safe_id(task.task_id)}")
        state = str(data.get("state") or "").lower()
        if state == "completed":
            urls = [o.get("url") for o in (data.get("output") or []) if isinstance(o, dict) and o.get("url")]
            if not urls:
                raise AdapterError(E_BAD_RESPONSE, "completed without output")
            return PollResult(SUCCEEDED, [Output("video/mp4", url=str(urls[0]))])
        if state == "failed":
            code = self._FAILURES.get(str(data.get("failure_code") or ""), E_UNAVAILABLE)
            return PollResult(FAILED, error=AdapterError(
                code, self.message(data.get("failure_reason") or data.get("failure_code") or "failed")))
        return PollResult(PENDING)


# ── ByteDance Seedance (BytePlus ModelArk, international) ───────────────────
class SeedanceAdapter(HttpAdapter):
    """``POST /api/v3/contents/generations/tasks`` → ``id``; ``GET …/tasks/{id}``
    → ``status`` and ``content.video_url``. Settings ride as top-level body
    fields (``ratio``, ``duration``, ``resolution``, ``generate_audio``), the
    form byteplus-python-sdk-v2 sends and the docs recommend. International
    region (owner decision D5); ``SEEDANCE_BASE_URL`` overrides it."""

    key = "video.seedance"
    key_env = ("SEEDANCE_API_KEY", "ARK_API_KEY")
    base_url_env = "SEEDANCE_BASE_URL"
    default_base_url = "https://ark.ap-southeast.bytepluses.com"
    capabilities = (T2V, I2V)
    _CODES = {"AuthenticationError": E_AUTH, "AccessDenied": E_AUTH,
              "AccountOverdueError": E_QUOTA, "QuotaExceeded": E_QUOTA,
              "RateLimitExceeded": E_RATE_LIMITED, "InvalidParameter": E_BAD_REQUEST,
              "SensitiveContentDetected": E_POLICY,
              "InputTextSensitiveContentDetected": E_POLICY,
              "InputImageSensitiveContentDetected": E_POLICY,
              "OutputVideoSensitiveContentDetected": E_POLICY,
              "ModelNotOpen": E_NOT_FOUND, "InvalidEndpointOrModel.NotFound": E_NOT_FOUND}

    def _map(self, code) -> Optional[str]:
        c = str(code or "")
        if not c:
            return None
        return self._CODES.get(c) or next((v for k, v in self._CODES.items() if c.startswith(k)), None)

    def vendor_error_code(self, status: int, text: str) -> Optional[str]:
        return self._map(dig(json_body(text), "error", "code"))

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        content: list = [{"type": "text", "text": request.prompt.strip()}]
        if request.capability == I2V and request.input_images:
            content.append({"type": "image_url", "image_url": {"url": _image_ref(request.input_images[0])}})
        body: dict = {"model": vendor_model, "content": content,
                      "ratio": request.aspect_ratio or "16:9",
                      "duration": int(request.duration_s or 5)}
        if request.resolution:
            body["resolution"] = request.resolution
        if request.audio is not None:
            body["generate_audio"] = bool(request.audio)
        data = self.post(f"{self.base_url}/api/v3/contents/generations/tasks", body)
        if not data.get("id"):
            raise AdapterError(E_BAD_RESPONSE, "no task id in the response")
        return ProviderTask(self.key, vendor_model, _safe_id(data["id"]))

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        data = self.get(f"{self.base_url}/api/v3/contents/generations/tasks/{_safe_id(task.task_id)}")
        status = str(data.get("status") or "").lower()
        if status == "succeeded":
            url = dig(data, "content", "video_url")
            if not url:
                raise AdapterError(E_BAD_RESPONSE, "succeeded without content.video_url")
            return PollResult(SUCCEEDED, [Output("video/mp4", url=str(url))])
        if status in ("failed", "cancelled", "expired"):
            code = self._map(dig(data, "error", "code")) or E_UNAVAILABLE
            return PollResult(FAILED, error=AdapterError(code, self.message(dig(data, "error", "message") or status)))
        return PollResult(PENDING)


# ── Alibaba Wan (Model Studio, international) ───────────────────────────────
_WORKSPACE = re.compile(r"^[A-Za-z0-9-]{1,64}$")


class WanAdapter(HttpAdapter):
    """``POST /api/v1/services/aigc/video-generation/video-synthesis`` with
    ``X-DashScope-Async: enable`` → ``output.task_id``; ``GET /api/v1/tasks/{id}``
    → ``output.task_status`` and ``output.video_url`` (dashscope SDK). Wan 2.7
    and 3.0 take ``parameters.resolution`` + ``ratio`` and the first frame as
    ``input.media[{type: first_frame, url}]``.

    Host: the workspace host ``https://{WAN_WORKSPACE_ID}.ap-southeast-1.maas.aliyuncs.com``
    when ``WAN_WORKSPACE_ID`` is set; otherwise the shared
    ``dashscope-intl.aliyuncs.com``, which Alibaba put in maintenance mode on
    2026-09-30 (still served, no new models)."""

    key = "video.wan"
    key_env = ("WAN_API_KEY", "DASHSCOPE_API_KEY")
    base_url_env = "WAN_BASE_URL"
    default_base_url = "https://dashscope-intl.aliyuncs.com"
    capabilities = (T2V, I2V)
    _CODES = {"InvalidApiKey": E_AUTH, "Arrearage": E_QUOTA, "DataInspectionFailed": E_POLICY,
              "InvalidParameter": E_BAD_REQUEST, "ModelNotFound": E_NOT_FOUND}

    def __init__(self, **kw):
        super().__init__(**kw)
        ws = (self._env.get("WAN_WORKSPACE_ID") or "").strip()
        explicit = (self._env.get(self.base_url_env) or "").strip().startswith("https://")
        if ws and _WORKSPACE.fullmatch(ws) and not explicit:
            self.base_url = f"https://{ws}.ap-southeast-1.maas.aliyuncs.com"

    def _map(self, code) -> Optional[str]:
        c = str(code or "")
        if not c:
            return None
        if c.startswith("Throttling"):
            return E_RATE_LIMITED
        return self._CODES.get(c)

    def vendor_error_code(self, status: int, text: str) -> Optional[str]:
        return self._map(json_body(text).get("code"))

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        if request.capability == I2V and request.input_images and not is_url(request.input_images[0]):
            out.append("Wan needs the first-frame image as an https URL")
        return out

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        inp: dict = {"prompt": request.prompt.strip()}
        if request.negative_prompt:
            inp["negative_prompt"] = request.negative_prompt
        if request.capability == I2V:
            if not is_url(request.input_images[0]):
                raise AdapterError(E_BAD_REQUEST, "Wan needs the first-frame image as an https URL")
            inp["media"] = [{"type": "first_frame", "url": request.input_images[0]}]
        params: dict = {"resolution": (request.resolution or "720p").upper(),
                        "ratio": request.aspect_ratio or "16:9",
                        "duration": int(request.duration_s or 5)}
        data = self.post(f"{self.base_url}/api/v1/services/aigc/video-generation/video-synthesis",
                         {"model": vendor_model, "input": inp, "parameters": params},
                         headers={"X-DashScope-Async": "enable"})
        tid = dig(data, "output", "task_id")
        if not tid:
            raise AdapterError(E_BAD_RESPONSE, "no output.task_id in the response")
        return ProviderTask(self.key, vendor_model, _safe_id(tid))

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        data = self.get(f"{self.base_url}/api/v1/tasks/{_safe_id(task.task_id)}")
        out = data.get("output") or {}
        status = str(out.get("task_status") or "").upper()
        if status == "SUCCEEDED":
            if not out.get("video_url"):
                raise AdapterError(E_BAD_RESPONSE, "succeeded without video_url")
            return PollResult(SUCCEEDED, [Output("video/mp4", url=str(out["video_url"]))])
        if status in ("FAILED", "CANCELED", "UNKNOWN"):
            code = self._map(out.get("code")) or E_UNAVAILABLE
            return PollResult(FAILED, error=AdapterError(code, self.message(out.get("message") or status)))
        return PollResult(PENDING)


# ── Black Forest Labs FLUX video ────────────────────────────────────────────
class FluxVideoAdapter(HttpAdapter):
    """``POST https://api.bfl.ai/v1/{model}`` (header ``x-key``) →
    ``polling_url``; poll until ``Ready``; ``result.sample`` is the clip — the
    same flow as FLUX images. Only ``prompt`` and ``resolution`` (hd / fhd)
    are confirmed (release-notes extract; docs.bfl.ai was unreachable), so no
    duration is sent and the registry offers none. Hidden until probed."""

    key = "video.bfl"
    key_env = ("BFL_API_KEY",)
    base_url_env = "BFL_BASE_URL"
    default_base_url = "https://api.bfl.ai/v1"
    capabilities = (T2V,)
    _RES = {"720p": "hd", "1080p": "fhd"}
    _FAILED = {"Error", "Failed", "Content Moderated", "Request Moderated", "Task not found"}

    def auth_headers(self) -> Dict[str, str]:
        return {"x-key": self.api_key(), "accept": "application/json"}

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        body: dict = {"prompt": request.prompt.strip()}
        if request.resolution:
            if request.resolution not in self._RES:
                raise AdapterError(E_BAD_REQUEST, "resolution not offered by FLUX video")
            body["resolution"] = self._RES[request.resolution]
        data = self.post(f"{self.base_url}/{vendor_model}", body)
        poll = data.get("polling_url")
        if not poll or not host_is(poll, "bfl.ai"):
            raise AdapterError(E_BAD_RESPONSE, "no bfl.ai polling_url in the response")
        return ProviderTask(self.key, vendor_model, str(poll))

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        url = str(task.task_id or "")
        if not host_is(url, "bfl.ai"):
            raise AdapterError(E_NOT_FOUND, "task id is not a bfl.ai polling URL")
        data = self.get(url)
        status = str(data.get("status") or "")
        if status == "Ready":
            sample = dig(data, "result", "sample")
            if not sample:
                raise AdapterError(E_BAD_RESPONSE, "Ready without result.sample")
            return PollResult(SUCCEEDED, [Output("video/mp4", url=str(sample))])
        if status in self._FAILED:
            code = E_POLICY if "Moderated" in status else (
                E_NOT_FOUND if status == "Task not found" else E_UNAVAILABLE)
            return PollResult(FAILED, error=AdapterError(code, f"job ended with status {status!r}"))
        return PollResult(PENDING)


ADAPTERS = (VeoAdapter, KlingAdapter, MiniMaxVideoAdapter, RunwayAdapter, LumaAdapter,
            SeedanceAdapter, WanAdapter, FluxVideoAdapter)
