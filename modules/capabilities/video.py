"""Video adapters: Veo, Kling, MiniMax Hailuo, Runway (+ its video upscaler), Luma, Seedance (1.x and 2.x), Wan.

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
import logging
import re
import shutil
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import requests

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
    VIDEO_UPSCALE,
    AdapterError,
    CapabilityRequest,
    HttpAdapter,
    Output,
    PollResult,
    ProviderTask,
    b64_output,
    classify_http,
    dig,
    host_is,
    image_b64,
    image_data_uri,
    image_mime,
    is_url,
    json_body,
)
from modules.capabilities.modelark import RESULT_HOSTS as MODELARK_RESULT_HOSTS
from modules.capabilities.modelark import map_code as modelark_code
from modules.capabilities.safe_fetch import SafeResultMixin, after_completion, checked_polling_url, unconfirmed
from modules import ffmpeg_limits, media_library
from modules.media_library import counted_rate, frame_count, parse_rate, shortest_length

logger = logging.getLogger(__name__)

_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")
_POLICY_HINTS = ("safety", "policy", "blocked", "moderation", "sensitive", "risk")
#: ModelArk's ``safety_identifier``: an English string of at most 64 characters.
_SAFETY_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


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
    #: submit sends negative_prompt in the vendor body (tests/test_negative_prompt_wiring.py proves it per registry model).
    TAKES_NEGATIVE_PROMPT = True
    key_env = ("VEO_API_KEY", "GEMINI_API_KEY")
    base_url_env = "VEO_BASE_URL"
    default_base_url = "https://generativelanguage.googleapis.com"
    capabilities = (T2V, I2V)
    #: ``lastFrame`` — "the final image for an interpolation video", Veo 3.1,
    #: 3.1 Fast and 3.1 Lite (ai.google.dev/gemini-api/docs/veo, 2026-10-01).
    end_frame_capabilities = (I2V,)
    _OP = re.compile(r"^models/[A-Za-z0-9.-]+/operations/[A-Za-z0-9_-]+$")
    #: The key rides every Veo call in a header requests would carry across a cross-host redirect: a 3xx is an error, never followed.
    follow_redirects = False
    #: Set by tools/probe_models.py on the adapter it builds (to the vendor model it is probing) so a probe BY NAME can learn
    #: whether a past-shutdown id still answers; every other caller is refused at submit. Deliberately an attribute and not an
    #: environment switch: a value that GitHub or a deploy could set would let every worker bypass the shutdown guard.
    probing_past_shutdown: str = ""

    def auth_headers(self) -> Dict[str, str]:
        return {"x-goog-api-key": self.api_key()}

    def _refuse_past_shutdown(self, vendor_model: str) -> None:
        """A job priced before the model's announced shutdown date (schemas/model_registry.json ``shutdown``) and advanced after it
        is refused HERE, before any request, with the reason; no other model is tried (CLAUDE.md #4). Google's date is the
        EARLIEST possible one, so this is a stop, not a claim that the id is dead."""
        from modules import model_registry   # late: the registry imports the adapters

        allowed = (self.probing_past_shutdown or "").strip().lower()
        for entry in model_registry.entries_named_in(vendor_model):
            if entry.adapter == self.key and entry.shut_down() and allowed != entry.vendor_model.lower():
                s = entry.raw["shutdown"]
                raise AdapterError(
                    E_NOT_FOUND,
                    f"{entry.vendor_model} is past Google's announced shutdown date {s['on']} (the EARLIEST possible date, "
                    f"{s['source_url']}, read {s['as_of']}): nothing was sent and no other model was tried. Re-open it only after "
                    f"tools/probe_models.py --model {entry.id} shows it still answers (then move shutdown.on in the registry)",
                    not_accepted=True)

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        self._refuse_past_shutdown(vendor_model)
        instance: dict = {"prompt": request.prompt.strip()}
        if request.capability == I2V and request.input_images:
            path = request.input_images[0]
            instance["image"] = {"bytesBase64Encoded": image_b64(path), "mimeType": image_mime(path)}
            if request.end_image:
                # google-genai sends GenerateVideosConfig.last_frame here, in
                # the same Image shape as the first frame.
                end = request.end_image
                instance["lastFrame"] = {"bytesBase64Encoded": image_b64(end), "mimeType": image_mime(end)}
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
    * ``KLING_API_KEY`` without a colon → a console API key, sent as is.

    Watermark: ``watermark_info`` is optional and off by default (it adds a second, marked copy,
    ``watermark_url``); nothing read requires it, so it is not sent and the vendor's default output
    (``url``) is stored as returned. https://kling.ai/document-api/api/video/3-0-omni/text-to-video/legacy"""

    key = "video.kling"
    #: submit sends negative_prompt in the vendor body (tests/test_negative_prompt_wiring.py proves it per registry model).
    TAKES_NEGATIVE_PROMPT = True
    key_env = ("KLING_API_KEY", "KLING_ACCESS_KEY", "KLING_SECRET_KEY")
    base_url_env = "KLING_BASE_URL"
    default_base_url = "https://api-singapore.klingai.com"
    capabilities = (T2V, I2V)
    #: ``image_tail`` on image2video. Kling's capability map: kling-v3 takes
    #: first + last frame; kling-v2-6 only in 1080p silent (pro) mode, which
    #: this adapter never sends — so only kling-v3's registry entry has it.
    end_frame_capabilities = (I2V,)
    #: ``sound`` on / off (kling-v2-6 and later). Sent only when the job names
    #: audio (the registry pins it off for a model that is priced by it), so a
    #: model that takes no such field is never sent one.
    audio_capabilities = (T2V, I2V)
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
        if request.audio is not None:
            # Priced apart (0070): the soundtrack is asked for, or refused, never left to the vendor.
            body["sound"] = "on" if request.audio else "off"
        if kind == "image2video":
            path = request.input_images[0]
            # Kling takes a URL or raw base64 (no data: prefix).
            body["image"] = path if is_url(path) else image_b64(path)
            if request.end_image:
                end = request.end_image
                body["image_tail"] = end if is_url(end) else image_b64(end)
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
#: GET /v1/tasks/{id} ``status`` words that mean "not finished yet" (docs.dev.runwayml.com/api.md, read 2026-11-13). THROTTLED is
#: Runway holding the task behind the account's concurrency limit: it still runs, and bills, once a slot frees up.
_RUNWAY_IN_FLIGHT = frozenset({"PENDING", "THROTTLED", "RUNNING"})
#: ``failureCode`` prefixes that are the input's fault (docs.dev.runwayml.com/errors/task-failures, read 2026-11-13): an input asset
#: Runway cannot use (its size, shape or length), which a retry of the same picture would only pay for again. Every code with SAFETY
#: in it (SAFETY.INPUT.*, SAFETY.OUTPUT.*, INPUT_PREPROCESSING.SAFETY.TEXT) is a moderation refusal; the rest (INTERNAL,
#: INTERNAL.BAD_OUTPUT.*, INPUT_PREPROCESSING.INTERNAL, THIRD_PARTY.UNAVAILABLE, or none) Runway documents as worth a later retry.
_RUNWAY_BAD_INPUT = ("ASSET.INVALID",)
#: A 4xx body that names a credit shortfall. Runway's error page does not document these words, so the match is narrow on purpose:
#: without it an empty Runway balance answered as a 400 reads as "change your input", the opposite remedy (CLAUDE.md #6).
_RUNWAY_NO_CREDITS = re.compile(r"(?i)\b(?:not have enough|insufficient)\s+credits?\b")
#: Tasks whose reported credits are kept for the probe's note (the worker never reads them).
_RUNWAY_KEEP = 32


class RunwayAdapter(HttpAdapter):
    """``POST /v1/text_to_video`` or ``/v1/image_to_video`` (header
    ``X-Runway-Version: 2024-11-06``) → ``id``; ``GET /v1/tasks/{id}`` →
    ``status`` and ``output[0]`` (docs.dev.runwayml.com/api.md, read 2026-11-13)."""

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
    #: ``duration`` is an integer from 2 to 10 seconds for gen4.5 (where it is required) and gen4_turbo. The registry may offer fewer
    #: lengths, never more: Runway would refuse one after the job was queued and priced.
    MIN_DURATION_S, MAX_DURATION_S = 2, 10

    def __init__(self, **kw):
        super().__init__(**kw)
        #: ``cost.credits`` per task as Runway reported it (credits at the developer portal's rate): printed beside a probe's OK so the registry's
        #: per-second figure can be compared with a real bill before anyone sets pricing.confirmed.
        self.credits_reported: Dict[str, float] = {}

    def auth_headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key()}", "X-Runway-Version": self.API_VERSION}

    def _duration_problem(self, request: CapabilityRequest) -> Optional[str]:
        d = 5 if request.duration_s is None else request.duration_s
        if isinstance(d, bool) or not isinstance(d, int) or not self.MIN_DURATION_S <= d <= self.MAX_DURATION_S:
            return f"Runway makes clips of {self.MIN_DURATION_S} to {self.MAX_DURATION_S} whole seconds"
        return None

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        if request.capability == T2V and (request.aspect_ratio or "16:9") not in self._T2V_RATIOS:
            out.append("Runway text-to-video takes 16:9 or 9:16 only")
        if request.capability in (T2V, I2V):
            problem = self._duration_problem(request)
            if problem:
                out.append(problem)
        return out

    def vendor_error_code(self, status: int, text: str) -> Optional[str]:
        # Never for a 5xx: a gateway in front of a Runway that already took the task must stay "unavailable", never a refusal.
        if 400 <= status < 500 and _RUNWAY_NO_CREDITS.search(text or ""):
            return E_QUOTA
        return None

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        ratio = self._RATIOS.get(request.aspect_ratio or "16:9")
        if not ratio or (request.capability == T2V and (request.aspect_ratio or "16:9") not in self._T2V_RATIOS):
            raise AdapterError(E_BAD_REQUEST, "aspect ratio not offered by Runway for this capability", not_accepted=True)
        problem = self._duration_problem(request)
        if problem:
            raise AdapterError(E_BAD_REQUEST, problem, not_accepted=True)
        body: dict = {"model": vendor_model, "promptText": request.prompt.strip(), "ratio": ratio,
                      "duration": int(request.duration_s or 5)}
        if request.capability == I2V:
            # promptImage as one string is the first frame (position "first"), the only frame gen4.5 and gen4_turbo take.
            body["promptImage"] = _image_ref(request.input_images[0])
            path = "image_to_video"
        else:
            path = "text_to_video"
        data = self.post(f"{self.base_url}/v1/{path}", body)
        if not data.get("id"):
            raise AdapterError(E_BAD_RESPONSE, "no task id in the response")
        return ProviderTask(self.key, vendor_model, _safe_id(data["id"]))

    def _remember_cost(self, task_id: str, data) -> None:
        credits = dig(data, "cost", "credits")
        if isinstance(credits, (int, float)) and not isinstance(credits, bool) and credits >= 0:
            self.credits_reported[task_id] = credits
            while len(self.credits_reported) > _RUNWAY_KEEP:
                self.credits_reported.pop(next(iter(self.credits_reported)))

    def probe_note(self, task: ProviderTask) -> str:
        """What the probe prints beside OK: the credits Runway says the task cost, to compare with the registry estimate."""
        seen = self.credits_reported.get(str(task.task_id or ""))
        if seen is None:
            return "Runway reported no cost.credits figure"
        return f"credits reported by Runway: {seen:g} (compare with the registry estimate before trusting a price)"

    def probe_credits(self, task: ProviderTask) -> Optional[float]:
        """The same figure as a bare number, for the probe's --brief log (the workflow's), which prints no free text."""
        return self.credits_reported.get(str(task.task_id or ""))

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        tid = _safe_id(task.task_id)
        data = self.get(f"{self.base_url}/v1/tasks/{tid}")
        status = str(data.get("status") or "").upper()
        if status == "SUCCEEDED":
            url = dig(data, "output", 0)
            if not url:
                raise AdapterError(E_BAD_RESPONSE, "succeeded without output")
            self._remember_cost(tid, data)
            return PollResult(SUCCEEDED, [Output("video/mp4", url=str(url))])
        if status in ("FAILED", "CANCELLED"):
            fcode = str(data.get("failureCode") or "")
            if "SAFETY" in fcode.upper():
                return PollResult(FAILED, error=AdapterError(E_POLICY, self.message(fcode)))
            if fcode.upper().startswith(_RUNWAY_BAD_INPUT):
                return PollResult(FAILED, error=AdapterError(E_BAD_REQUEST, self.message(fcode)))
            return _failed(self, f"{fcode} {data.get('failure') or ''}".strip() or status)
        if status not in _RUNWAY_IN_FLIGHT:
            # A word the docs do not list is a docs change to read, not a reason to drop a task Runway may still finish and bill.
            logger.warning("runway: task status %r is not one the docs list; treated as pending",
                           self.message(status)[:40] or "(none)")
        return PollResult(PENDING, progress=data.get("progress"))


#: What Runway's video inputs document (docs.dev.runwayml.com/assets/inputs):
#: the container's content type. The library copy's suffix says which it is.
_RUNWAY_VIDEO_TYPES = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
                       ".mkv": "video/x-matroska"}
_RUNWAY_URI = re.compile(r"^runway://[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]{1,4990}$")


#: The demuxer forced for a source's extension (the upscale's accepted types).
_FPS_DEMUXERS = {".mp4": "mov", ".mov": "mov", ".webm": "matroska", ".mkv": "matroska"}


#: Codecs whose packet in MP4 / MOV / WebM / MKV decodes to at most one shown
#: frame, so ``-count_packets`` can stand in for decoding (BR-L-211). FFmpeg's
#: h264, hevc and prores decoders return one frame per packet and no bitstream
#: filter splits their packets; field-coded H.264 stores a field per packet,
#: which only overcounts. ProRes is intra-only and each sample is one ``icpf``
#: frame. Not VP9 (a superframe holds up to 8 shown frames), not MPEG-4 Part 2
#: (packed B-frames put 2 in a packet), not AV1 or anything else unchecked:
#: those are decoded and counted, within the same time limit.
_ONE_FRAME_PER_PACKET = frozenset({"h264", "hevc", "prores"})

#: Still-image codecs: FFmpeg's decoder for each returns exactly one picture
#: per packet and keeps no state between packets, so a track of at most one
#: packet and one sample is one picture: a thumbnail kept as its own track
#: (an MP4 or MOV muxed ``-map 0 -map 1 -c copy`` with a JPEG; cameras write
#: the same), which main's ``v:0`` read accepted (BR-L-211 round 3, Lens).
#: Not gif or webp: one packet of either can be an animation. Never a motion
#: codec: a single VP9 packet can be a superframe of 8 shown frames.
_STILL_CODECS = frozenset({"mjpeg", "png", "bmp"})

#: What a member reads for a codec and a container in a refusal; anything
#: else gets the generic wording rather than a guessed name.
_CODEC_NAMES = {"h264": "H.264", "hevc": "HEVC", "prores": "ProRes", "vp8": "VP8", "vp9": "VP9", "av1": "AV1",
                "mpeg4": "MPEG-4", "mpeg2video": "MPEG-2", "mjpeg": "Motion JPEG"}
_CONTAINER_NAMES = {".mp4": "MP4", ".mov": "MOV", ".webm": "WebM", ".mkv": "MKV"}


@dataclass(frozen=True)
class FrameReading:
    """What the upscale's price ceiling is checked against. ``rate`` None is
    unknown, never a number; ``refusal`` is a reason already worded for the
    member (more than one picture stream, a probe out of time, a frame over
    the decoder's cap), and wins."""

    rate: Optional[float] = None
    avg: Optional[float] = None
    frames: Optional[int] = None
    #: The picture's length the rate was counted over (``shortest_length``).
    #: Not the priced length: the price is the file's ``format.duration``.
    seconds: Optional[float] = None
    refusal: Optional[str] = None
    #: More shown frames were decoded than there are packets (VP9 superframes,
    #: packed B-frames): a high rate in disguise, not a cut clip's extra frames.
    packed: bool = False
    #: The counted picture's stream index in the file (ffmpeg's numbering):
    #: what the upload copy maps, so it is that stream and no other that goes.
    index: Optional[int] = None
    #: The file's own length (``format.duration``, or mvhd's): what Runway's
    #: 30 s input limit is checked against; None is unknown, never 0.
    length: Optional[float] = None
    #: The counted picture's codec in ffmpeg's name ("h264", "hevc", ...).
    codec: Optional[str] = None


#: The most of ffprobe's answer kept: one file's stream list is a few KB. A
#: larger answer is not a reading of a file the upscale takes, and keeping it
#: whole would put a member's bytes in the worker's own memory (RLIMIT_AS
#: bounds only the child). Over it, the reading is unknown.
_PROBE_STDOUT_MAX = 1024 * 1024


def _evidence(watch) -> bytes:
    """What a run's stderr is reduced to: every refusal marker it ever showed,
    then its last ``ffmpeg_limits.TAIL_BYTES``. The markers come first because
    a decoder that refuses one frame early and keeps logging for minutes would
    push that line out of any tail, and the refusal names the remedy."""
    seen = b"\n".join(m for m in ffmpeg_limits.REFUSAL_MARKERS if m in watch.seen)
    return (seen + b"\n" if seen else b"") + watch.tail


def _bounded_run(argv: List[str], *, timeout: float, env: Optional[Dict[str, str]] = None,
                 kill_on_refusal: bool = False) -> subprocess.CompletedProcess:
    """``subprocess.run`` for a probe of a member's file, without its memory:
    ``capture_output`` kept the child's whole stderr in the worker, and a
    hostile file can make ffprobe log for as long as the time limit allows.
    stderr goes through ``ffmpeg_limits._StderrWatch`` (the supervisor's own
    watcher: a bounded tail, every marker remembered) and stdout is kept up to
    ``_PROBE_STDOUT_MAX`` (None past it). A timeout kills the child and raises
    ``TimeoutExpired`` carrying the same evidence as ``stderr``."""
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=env)

    def kill() -> None:
        try:
            proc.kill()
        except OSError:
            pass

    watch = ffmpeg_limits._StderrWatch(proc.stderr, kill if kill_on_refusal else (lambda: None))
    kept: List[bytes] = []
    over = threading.Event()

    def drain() -> None:
        total = 0
        try:
            while True:
                chunk = proc.stdout.read1(65536)
                if not chunk:
                    return
                total += len(chunk)
                if total > _PROBE_STDOUT_MAX:
                    over.set()
                    kill()
                    return
                kept.append(chunk)
        except (OSError, ValueError):
            return

    reader = threading.Thread(target=drain, daemon=True)
    watch.start()
    reader.start()
    try:
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            kill()
            proc.wait()
            reader.join(5)
            watch.join(5)
            raise subprocess.TimeoutExpired(argv, timeout, stderr=_evidence(watch)) from None
        except BaseException:
            kill()
            proc.wait()
            raise
        reader.join(5)
        watch.join(5)
    finally:
        for pipe in (proc.stdout, proc.stderr):
            try:
                pipe.close()
            except (OSError, ValueError):
                pass
    return subprocess.CompletedProcess(argv, proc.returncode, None if over.is_set() else b"".join(kept),
                                       _evidence(watch))


def _ffprobe_run(argv: List[str], timeout: float, **kw) -> Tuple[Optional[dict], bytes]:
    """ffprobe's JSON (None when it is not JSON, or larger than any reading)
    and its stderr evidence (``_evidence``). A timeout is raised: it needs its
    own remedy, not the unreadable file's."""
    try:
        out = _bounded_run(argv, timeout=timeout, **kw)
    except subprocess.TimeoutExpired:
        raise
    except (OSError, subprocess.SubprocessError):
        return None, b""
    err = out.stderr if isinstance(out.stderr, bytes) else b""
    if out.stdout is None:
        return None, err
    try:
        data = json.loads(out.stdout or b"{}")
    except ValueError:
        return None, err
    return (data if isinstance(data, dict) else None), err


def _positive(value) -> Optional[float]:
    """A finite positive number of seconds, or None (unknown, never 0)."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if 0 < f < float("inf") else None


def _is_still(stream: dict) -> bool:
    count = frame_count(stream)
    return str(stream.get("codec_name") or "").lower() in _STILL_CODECS and count is not None and count <= 1


def _what(codec: Optional[str], suffix: str) -> str:
    """"VP9 WebM", "WebM" or "video": only what the probe and the type said."""
    container = _CONTAINER_NAMES.get(suffix)
    name = _CODEC_NAMES.get(str(codec or "").lower())
    if name and container:
        return f"{name} {container}"
    return container or (f"{name} video" if name else "video")


def _decode_refusal(stderr: bytes, what: str) -> Optional[str]:
    """The decoder refused a frame (ffmpeg_limits.REFUSAL_MARKERS), so the
    count it returned is short: a refusal with its own remedy, not a reading
    and not "unknown"."""
    if not any(m in stderr for m in ffmpeg_limits.REFUSAL_MARKERS):
        return None
    if b"exceeds specified max pixel count" in stderr:
        # Floored, so the figure stated is one the cap accepts.
        cap_mp = int(media_library.VIDEO_MAX_PIXELS / 100_000) / 10
        return (f"a frame in this {what} is larger than the upscale accepts; export it again at no more than "
                f"{cap_mp:.1f} megapixels a frame (8K UHD, 7680x4320, fits)")
    return (f"decoding this {what} needed more memory than the upscale allows; export it again at a smaller "
            "frame size")


#: The largest ``moov`` box the container read loads (its sample tables; a 200 MB upload's are a few MB at most).
_MOOV_MAX_BYTES = 32 * 1024 * 1024
#: Boxes the container read descends into on the way to a video track's timing.
_MP4_CONTAINERS = {b"trak", b"mdia", b"minf", b"stbl"}


def _boxes(buf: bytes, start: int, end: int):
    """(type, payload start, payload end) of each box in ``buf[start:end]``; stops at the first malformed header."""
    pos = start
    while pos + 8 <= end:
        size = int.from_bytes(buf[pos:pos + 4], "big")
        kind = buf[pos + 4:pos + 8]
        head = 8
        if size == 1:
            if pos + 16 > end:
                return
            size, head = int.from_bytes(buf[pos + 8:pos + 16], "big"), 16
        elif size == 0:
            size = end - pos
        if size < head or pos + size > end:
            return
        yield kind, pos + head, pos + size
        pos += size


#: Top-level boxes the container read walks before it gives up: a real MP4 has a handful (ftyp, moov, mdat, free), and
#: a file of millions of 8-byte boxes would otherwise cost one seek and read each before ``moov`` is found.
_MP4_MAX_TOP_BOXES = 10_000


#: Sample entries whose one sample is one shown frame: ``_ONE_FRAME_PER_PACKET``
#: (H.264, HEVC, ProRes) as an MP4 / MOV names them. Without ffprobe nothing
#: decodes any other codec to count its frames (a VP9 superframe or a packed
#: MPEG-4 B-frame is several frames in one sample), so any other is unknown.
_MP4_ONE_FRAME_ENTRIES = frozenset({b"avc1", b"avc3", b"hvc1", b"hev1",
                                    b"apch", b"apcn", b"apcs", b"apco", b"ap4h", b"ap4x"})
#: Those entries in ffmpeg's codec names (what ``read_frames`` reports).
_MP4_CODECS = {b"avc1": "h264", b"avc3": "h264", b"hvc1": "hevc", b"hev1": "hevc",
               **{e: "prores" for e in (b"apch", b"apcn", b"apcs", b"apco", b"ap4h", b"ap4x")}}
#: ``_STILL_CODECS`` as QuickTime names them (JPEG, Motion JPEG A / B, PNG).
_MP4_STILL_ENTRIES = frozenset({b"jpeg", b"mjpa", b"mjpb", b"png "})
#: An MP4 (not MOV) stores a JPEG or PNG thumbnail as ``mp4v`` and names it in
#: esds' objectTypeIndication (ISO 14496-1: 0x6C JPEG, 0x6D PNG): what ffmpeg
#: writes for ``-map 0 -map 1 -c copy`` of a JPEG into .mp4, a file the
#: ffprobe path accepts as a still.
_MP4V_STILL_TYPES = frozenset({0x6C, 0x6D})
#: Where a VisualSampleEntry's own boxes (avcC, esds) start: 8 bytes of
#: SampleEntry and 70 of the visual fields (ISO 14496-12 12.1.3).
_VISUAL_ENTRY_FIELDS = 78


def _descriptor(buf: bytes, pos: int, end: int) -> Optional[Tuple[int, int, int]]:
    """(tag, body start, body end) of one MPEG-4 descriptor; its size is up to
    four 7-bit bytes. None when it does not fit."""
    if pos >= end:
        return None
    tag, pos, size = buf[pos], pos + 1, 0
    for _ in range(4):
        if pos >= end:
            return None
        b = buf[pos]
        pos += 1
        size = (size << 7) | (b & 0x7F)
        if not b & 0x80:
            break
    else:
        return None
    if pos + size > end:
        return None
    return tag, pos, pos + size


def _esds_object_type(buf: bytes, start: int, end: int) -> Optional[int]:
    """The objectTypeIndication of an ``esds`` box's payload, or None."""
    es = _descriptor(buf, start + 4, end)
    if not es or es[0] != 0x03:
        return None
    _, pos, stop = es
    if pos + 3 > stop:
        return None
    flags = buf[pos + 2]
    pos += 3
    if flags & 0x80:
        pos += 2
    if flags & 0x40:
        if pos >= stop:
            return None
        pos += 1 + buf[pos]
    if flags & 0x20:
        pos += 2
    dc = _descriptor(buf, pos, stop)
    if not dc or dc[0] != 0x04 or dc[1] >= dc[2]:
        return None
    return buf[dc[1]]


def _sample_entry(buf: bytes, start: int, end: int) -> Optional[bytes]:
    """The fourcc of an ``stsd`` that holds exactly one sample entry, with an
    ``mp4v`` JPEG / PNG named ``jpeg``; None for none, several, or unreadable:
    a second entry may be a second codec, and the reading would be neither's."""
    if end - start < 8 or int.from_bytes(buf[start + 4:start + 8], "big") != 1:
        return None
    entries = list(_boxes(buf, start + 8, end))
    if len(entries) != 1:
        return None
    kind, ps, pe = entries[0]
    if kind == b"mp4v":
        for k, s, e in _boxes(buf, ps + _VISUAL_ENTRY_FIELDS, pe):
            if k == b"esds" and _esds_object_type(buf, s, e) in _MP4V_STILL_TYPES:
                return b"jpeg"
    return kind


def _full_box_duration(buf: bytes, start: int, end: int, v0: Tuple[int, int], v1: Tuple[int, int]
                       ) -> Optional[Tuple[Optional[int], int]]:
    """(timescale or None, duration) at a full box's version-0 or version-1
    offsets (each a pair, the timescale's offset -1 when the box has none);
    None when the box is too short. An all-ones duration is ISO's "unknown",
    read as 0, so it is no length at all rather than the longest one."""
    wide = buf[start] == 1
    ts_at, dur_at = v1 if wide else v0
    n = 8 if wide else 4
    if dur_at + n > end - start or (ts_at >= 0 and ts_at + 4 > end - start):
        return None
    dur = int.from_bytes(buf[start + dur_at:start + dur_at + n], "big")
    if dur == (1 << (8 * n)) - 1:
        dur = 0
    ts = int.from_bytes(buf[start + ts_at:start + ts_at + 4], "big") if ts_at >= 0 else None
    return ts, dur


#: mvhd / mdhd: timescale then duration; tkhd: duration only (mvhd's timescale).
_HD_OFFSETS = {b"mvhd": ((12, 16), (20, 24)), b"mdhd": ((12, 16), (20, 24)), b"tkhd": ((-1, 20), (-1, 28))}
#: The shortest payload of each, version 0 / 1 (ISO 14496-12 8.2.2, 8.3.2, 8.4.2).
_HD_MIN = {b"mvhd": (100, 112), b"mdhd": (24, 36), b"tkhd": (84, 96)}


def _header(buf: bytes, kind: bytes, start: int, end: int) -> Optional[Tuple[Optional[int], int]]:
    if end - start < 1 or end - start < _HD_MIN[kind][1 if buf[start] == 1 else 0]:
        return None
    v0, v1 = _HD_OFFSETS[kind]
    return _full_box_duration(buf, start, end, v0, v1)


#: The boxes a track's reading takes, each in its own parent only (a stts
#: directly in minf is not the sample table); stsz and stz2 share one slot.
_TRACK_SLOTS = {(b"tkhd", b"trak"): "tkhd", (b"mdhd", b"mdia"): "mdhd", (b"stts", b"stbl"): "stts",
                (b"stsz", b"stbl"): "stsz", (b"stz2", b"stbl"): "stsz", (b"stsd", b"stbl"): "stsd"}


@dataclass
class _Mp4Track:
    """One video ``trak`` as its own boxes describe it. ``samples`` is the
    time-to-sample total only when the sample-size table counts the same
    (ffprobe's ``nb_frames`` is the stsz count, and the stts average is over
    the stts total: two counts are no count)."""

    entry: Optional[bytes] = None
    samples: Optional[int] = None
    ticks: int = 0
    timescale: Optional[int] = None
    media_ticks: int = 0
    track_ticks: int = 0
    malformed: bool = False

    def is_still(self) -> bool:
        # ``_is_still``'s rule: a still codec and at most one sample, both read.
        return (not self.malformed and self.entry in _MP4_STILL_ENTRIES
                and self.samples is not None and self.samples <= 1)


def _mp4_track(buf: bytes, start: int, end: int) -> Optional[_Mp4Track]:
    """A ``trak``'s codec, sample counts and lengths, or None when it is not
    video. Each box counts once in its own parent: a second mdhd, stts, stsz,
    stsd or tkhd leaves the reading ambiguous, and malformed is unknown, never
    one of the two."""
    handler = None
    t = _Mp4Track()
    stts_total = stsz_count = None
    seen = set()
    stack = [(b"trak", start, end)]
    while stack:
        parent, s, e = stack.pop()
        for kind, ps, pe in _boxes(buf, s, e):
            if kind in _MP4_CONTAINERS:
                stack.append((kind, ps, pe))
                continue
            if kind == b"hdlr" and parent == b"mdia" and pe - ps >= 12:
                # Only the media handler names the track's kind: a QuickTime file has a second hdlr in minf (the data
                # handler, "alis"), which would otherwise hide that the track is video.
                handler = buf[ps + 8:ps + 12]
                continue
            slot = _TRACK_SLOTS.get((kind, parent))
            if slot is None:
                continue
            if slot in seen:
                t.malformed = True
                continue
            seen.add(slot)
            if slot in ("tkhd", "mdhd"):
                got = _header(buf, kind, ps, pe)
                if got is None:
                    t.malformed = True
                elif slot == "tkhd":
                    t.track_ticks = got[1]
                else:
                    t.timescale, t.media_ticks = got
            elif slot == "stts":
                count = int.from_bytes(buf[ps + 4:ps + 8], "big") if pe - ps >= 8 else -1
                if count < 0 or 8 + count * 8 > pe - ps:
                    t.malformed = True
                    continue
                stts_total = 0
                for i in range(count):
                    at = ps + 8 + i * 8
                    n, delta = int.from_bytes(buf[at:at + 4], "big"), int.from_bytes(buf[at + 4:at + 8], "big")
                    stts_total += n
                    t.ticks += n * delta
            elif slot == "stsz":
                # stsz and stz2 both keep the sample count at offset 8.
                if pe - ps < 12:
                    t.malformed = True
                    continue
                stsz_count = int.from_bytes(buf[ps + 8:ps + 12], "big")
            else:
                t.entry = _sample_entry(buf, ps, pe)
    # The walk finishes even after a malformed box, so a broken audio track is still known to be "not video".
    if handler != b"vide":
        return None
    if stts_total is not None and stts_total == stsz_count:
        t.samples = stts_total
    return t


def _read_moov(path: str) -> Optional[bytes]:
    """The payload of an MP4 / MOV file's first ``moov`` box, or None: no
    moov, a malformed top-level box, one over ``_MOOV_MAX_BYTES``, or more
    than ``_MP4_MAX_TOP_BOXES`` boxes before it."""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2)
            total = fh.tell()
            pos = 0
            walked = 0
            while pos + 8 <= total:
                walked += 1
                if walked > _MP4_MAX_TOP_BOXES:
                    return None
                fh.seek(pos)
                head = fh.read(16)
                size, kind, skip = int.from_bytes(head[:4], "big"), head[4:8], 8
                if size == 1 and len(head) == 16:
                    size, skip = int.from_bytes(head[8:16], "big"), 16
                elif size == 0:
                    size = total - pos
                if size < skip or pos + size > total:
                    return None
                if kind == b"moov":
                    if size > _MOOV_MAX_BYTES:
                        return None
                    fh.seek(pos + skip)
                    return fh.read(size - skip)
                pos += size
    except OSError:
        return None
    return None


def mp4_frames(path: str) -> FrameReading:
    """``read_frames`` for an MP4 / MOV without ffprobe, from the file's own
    boxes (#949's container read, under BR-L-211's rules).

    The Probe models workflow's runner installs no system ffmpeg and the
    pinned imageio-ffmpeg ships no ffprobe; the live Runway upscale probe of
    2026-11-27 was refused with "frame rate could not be read" before any
    call, although the drawn clip is a plain 24 fps H.264 MP4
    (tests/test_runway_upscale_probe_fps.py). The stts average alone, which
    #949 read, is the header BR-L-211 caught lying both ways, so the rate is
    counted here as ``read_frames`` counts it: the larger of the stts average
    and the samples over the shortest positive of mdhd's, mvhd's and tkhd's
    length, one frame forgiven. Samples are the stts total, and unknown when
    stsz counts otherwise.

    The same stream rules: one-sample still tracks are dropped (cover art is
    in udta, not a trak), more than one video track is refused, and samples
    are frames only for ``_MP4_ONE_FRAME_ENTRIES``; nothing here can decode
    another codec to count it, so it is unknown. Never a guess: a malformed
    box, a missing table or length, or a file ``_read_moov`` refuses is
    unknown."""
    moov = _read_moov(path)
    if moov is None:
        return FrameReading()
    movie_scale, movie_ticks, mvhd_seen = None, 0, False
    tracks: List[Tuple[int, _Mp4Track]] = []
    ordinal = -1
    for kind, ps, pe in _boxes(moov, 0, len(moov)):
        if kind == b"mvhd":
            got = _header(moov, kind, ps, pe)
            if mvhd_seen or got is None:
                return FrameReading()
            mvhd_seen = True
            movie_scale, movie_ticks = got
        elif kind == b"trak":
            # ffmpeg's mov demuxer makes one stream per trak, in file order
            # (video or not), so this is the index the upload copy maps.
            ordinal += 1
            track = _mp4_track(moov, ps, pe)
            if track is not None:
                tracks.append((ordinal, track))
    pictures = [(i, t) for i, t in tracks if not t.is_still()]
    if len(pictures) > 1:
        return FrameReading(refusal=f"this file holds {len(pictures)} video streams; export it again with just "
                                    "the one to upscale")
    if not pictures:
        return FrameReading()
    index, t = pictures[0]
    if t.malformed or t.entry not in _MP4_ONE_FRAME_ENTRIES or not t.samples or not t.timescale or not t.ticks:
        return FrameReading()
    lengths = [t.media_ticks / t.timescale]
    if movie_scale:
        lengths += [movie_ticks / movie_scale, t.track_ticks / movie_scale]
    lengths = [x for x in lengths if x > 0]
    if not lengths:
        return FrameReading()
    seconds = min(lengths)
    avg = f"{t.samples * t.timescale}/{t.ticks}"
    rate = counted_rate({"nb_frames": t.samples, "avg_frame_rate": avg, "duration": seconds}, {}, slack_frames=1)
    # The file's length is the movie's (mvhd covers every track, sound too);
    # without one it is unknown, never the picture's own guess.
    length = movie_ticks / movie_scale if movie_scale and movie_ticks > 0 else None
    return FrameReading(rate=rate, avg=parse_rate(avg), frames=t.samples, seconds=seconds, index=index,
                        length=length, codec=_MP4_CODECS.get(t.entry))


def mp4_fps(path: str) -> Optional[float]:
    """``mp4_frames``' rate, or None when it is unknown or refused."""
    reading = mp4_frames(path)
    return None if reading.refusal else reading.rate


def read_frames(path: str, *, timeout: int = 30) -> FrameReading:
    """The one picture stream's counted frame rate for pricing a per-frame
    bill (BR-L-211). Never a guess.

    Counted, not declared: the larger of the stream's average rate and its
    frames over the shorter of the file's and the stream's length, one frame
    forgiven (a length measured first-to-last timestamp is a frame short). The
    header alone lied both ways: a sample table padded at the tail read 0.287
    fps for 120, and a shortened mvhd/mdhd/tkhd read 10 s of 60 fps as 0.25 s.
    Frames are the larger of packets and samples (``frame_count``): samples an
    edit list leaves out are never read as packets, and are still sent.

    Every stream is read, not ``v:0``: moving ``moov/udta`` ahead of the trak
    made the cover art stream 0 (one packet, so 0 fps), and a 1 fps first
    stream vouched for a 240 fps second one; the vendor is sent the whole file.
    Cover art and one-picture still tracks are dropped, and more than one
    picture left is refused. Frames are packets only for
    ``_ONE_FRAME_PER_PACKET``; any other codec is decoded and counted, in what
    is left of ``timeout``, under the limits every other decode of a member's
    file runs under (``ffmpeg_limits``, ``media_library.decoder_cap``)."""
    exe = shutil.which("ffprobe")
    if not exe:
        # Without ffprobe (the Probe models runner) an MP4 / MOV is read from
        # its own boxes under the same rules; WebM and MKV still need ffprobe,
        # which the worker image has.
        if Path(str(path)).suffix.lower() in (".mp4", ".mov"):
            return mp4_frames(str(path))
        return FrameReading()
    suffix = Path(str(path)).suffix.lower()
    # The file is a member's library copy: only the file protocol, and the
    # demuxer its type names (as the media library's own probe does), so a
    # playlist or concat script cannot make ffprobe open anything else.
    demuxer = _FPS_DEMUXERS.get(suffix)
    base = [exe, "-v", "error", "-protocol_whitelist", "file", *(["-f", demuxer] if demuxer else [])]
    deadline = time.monotonic() + timeout
    try:
        # Under the limits of every member decode (BR-L-211 residual (g)):
        # counting packets opens each stream's decoder to fill its parameters.
        data, _ = _ffprobe_run(ffmpeg_limits.limited_argv(
            [*base, "-count_packets", "-show_entries",
             "stream=index,codec_type,codec_name,avg_frame_rate,nb_frames,nb_read_packets,"
             "duration:stream_disposition=attached_pic:format=duration",
             "-of", "json", str(path)]), timeout, env=ffmpeg_limits.child_env())
    except subprocess.TimeoutExpired:
        # Counting packets is reading the file once, whatever its codec (which
        # this probe did not get to report): only a shorter file helps.
        return FrameReading(refusal=f"this {_what(None, suffix)} is too long to read within the time limit; "
                                    "shorten it and upscale the shorter copy")
    if data is None:
        return FrameReading()
    streams, fmt = data.get("streams"), data.get("format") or {}
    if not isinstance(streams, list) or not isinstance(fmt, dict):
        return FrameReading()
    pictures = [st for st in streams if isinstance(st, dict) and st.get("codec_type") == "video"
                and not (st.get("disposition") if isinstance(st.get("disposition"), dict) else {}).get("attached_pic")
                and not _is_still(st)]
    if len(pictures) > 1:
        return FrameReading(refusal=f"this file holds {len(pictures)} video streams; export it again with just "
                                    "the one to upscale")
    if not pictures:
        return FrameReading()
    stream = dict(pictures[0])
    codec = str(stream.get("codec_name") or "").lower()
    if codec not in _ONE_FRAME_PER_PACKET:
        what = _what(codec, suffix)
        # The file's own codec and container: telling a VP9 WebM to become
        # H.264 MP4 was a remedy for a file the member does not have.
        too_slow = (f"this {what} is too long to count its frames within the time limit; shorten it and upscale "
                    "the shorter copy")
        remaining = deadline - time.monotonic()
        index = stream.get("index")
        if remaining <= 0:
            return FrameReading(refusal=too_slow)
        if not isinstance(index, int) or isinstance(index, bool) or index < 0:
            return FrameReading()
        # A decode of the member's frames, so it gets what the proxy and the
        # thumbnail get: the frame cap before the input (VP9, AV1 and H.264 can
        # switch to a bigger frame at any keyframe, which only the decoder
        # meets), two decoder threads, the address-space limit and
        # MALLOC_ARENA_MAX. The upscale takes video types only, so the cap is
        # the video one whatever the suffix.
        mime = _RUNWAY_VIDEO_TYPES.get(suffix, "video/mp4")
        argv = ffmpeg_limits.limited_argv([*base, *media_library.decoder_cap(mime), "-count_frames",
                                           "-select_streams", str(index), "-show_entries", "stream=nb_read_frames",
                                           "-of", "json", str(path)])
        try:
            decoded, stderr = _ffprobe_run(argv, remaining, env=ffmpeg_limits.child_env(), kill_on_refusal=True)
        except subprocess.TimeoutExpired as e:
            # A frame refused on the way is the truer reason than the clock.
            stderr = e.stderr if isinstance(e.stderr, bytes) else b""
            return FrameReading(refusal=_decode_refusal(stderr, what) or too_slow)
        refused = _decode_refusal(stderr, what)
        if refused:
            return FrameReading(refusal=refused)
        got = (decoded or {}).get("streams")
        got = got[0] if isinstance(got, list) and got and isinstance(got[0], dict) else {}
        shown = frame_count({"nb_read_packets": got.get("nb_read_frames")})
        packets = frame_count(stream)
        if not shown or packets is None:
            return FrameReading()
        # The larger of the two: a decode that stops early must not lower the
        # count below the samples the vendor is sent.
        stream = {**stream, "nb_read_packets": str(max(shown, packets))}
        packed = shown > packets
    else:
        packed = False
    index = stream.get("index")
    return FrameReading(rate=counted_rate(stream, fmt, slack_frames=1), avg=parse_rate(stream.get("avg_frame_rate")),
                        frames=frame_count(stream), seconds=shortest_length(stream, fmt), packed=packed,
                        index=index if isinstance(index, int) and not isinstance(index, bool) and index >= 0 else None,
                        length=_positive(fmt.get("duration")), codec=codec or None)


def video_fps(path: str, *, timeout: int = 30) -> Optional[float]:
    """``read_frames``' rate, or None when it is unknown or refused."""
    reading = read_frames(path, timeout=timeout)
    return None if reading.refusal else reading.rate


#: The muxer the upload copy is written with: the source's own container, so
#: every stream that is kept fits where it already was.
_COPY_MUXERS = {".mp4": "mp4", ".mov": "mov", ".webm": "webm", ".mkv": "matroska"}
#: The bitstream filter that writes an H.264 / HEVC sample as Annex B start
#: codes, so MPEG-TS (whose demuxer runs the full parser) cuts it into one
#: packet per access unit.
_ANNEXB = {"h264": "h264_mp4toannexb", "hevc": "hevc_mp4toannexb"}


def ffmpeg_exe() -> Optional[str]:
    """The system ffmpeg (the worker image's, beside its ffprobe), else the
    pinned imageio-ffmpeg one (the Probe models runner has no system ffmpeg)."""
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg  # noqa: PLC0415

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


@dataclass(frozen=True)
class Normalized:
    """What the upscale prepared from a member's file. ``path`` is uploaded
    and nothing else is. ``parsed`` (H.264 / HEVC only) is the same picture
    with each access unit its own sample: it is counted, never uploaded."""

    path: Path
    parsed: Optional[Path] = None


_REWRITE_FAILED = ("this video could not be rewritten without re-encoding, so it was not sent; export it again as "
                   "H.264 MP4 and upscale the new copy")


def normalize_for_upload(src: Path, reading: FrameReading, work: Path, *, timeout: float = 60.0) -> Normalized:
    """The copy of ``src`` that is priced, checked and uploaded (BR-L-211 (a)).

    Remuxed, never re-encoded (``-c copy``): a re-encode would change the
    member's picture and is a quality decision nobody asked for (CLAUDE.md
    #4). The copy keeps the ONE picture stream ``read_frames`` counted (its
    ``index``) and the sound, stream-copied: Runway's docs do not say whether
    the result keeps the source's audio, and dropping it here would change
    the result without anyone knowing. Cover art, a second picture, data and
    subtitle tracks are not kept. The demuxer applies the file's edit lists,
    so samples an edit leaves out are not sent.

    A remux to MP4 does NOT split several access units packed into one sample
    (measured with ffmpeg 6.1.1: Breach's h264p8.mp4 stays 150 samples with
    or without ``h264_mp4toannexb``); MPEG-TS does, because its demuxer runs
    the full parser (1200). The TS round trip also drops the display matrix
    (a phone's portrait rotation: measured, rotation=90 gone) and the edit
    list (a cut's preroll), so its file is only COUNTED (``parsed``): the
    upload is the plain copy, and the adapter refuses it unless both hold the
    same frames, which makes the copy one sample per access unit.

    Every ffmpeg runs under ``ffmpeg_limits.run`` (address-space limit,
    MALLOC_ARENA_MAX, the refusal watch, a deadline) with the frame cap and
    two decoder threads before each input (``media_library.decoder_cap``):
    opening the streams decodes a few frames. Raises AdapterError with the
    remedy. ``work`` is the caller's to remove, whatever happens."""
    exe = ffmpeg_exe()
    if not exe:
        raise AdapterError(E_NOT_CONFIGURED, "this worker has no ffmpeg to prepare the video for the upscale; "
                                             "nothing was sent")
    suffix = src.suffix.lower()
    muxer, demuxer = _COPY_MUXERS.get(suffix), _FPS_DEMUXERS.get(suffix)
    if muxer is None or demuxer is None:
        raise AdapterError(E_BAD_REQUEST, "Runway takes MP4, MOV, WebM or MKV video")
    if reading.index is None:
        raise AdapterError(E_BAD_REQUEST, "the video stream to upscale could not be told apart in this file, so it "
                                          "was not sent; export it again as H.264 MP4 with one video stream")
    cap = media_library.decoder_cap(_RUNWAY_VIDEO_TYPES[suffix])
    what = _what(reading.codec, suffix)
    deadline = time.monotonic() + timeout
    head = [exe, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-protocol_whitelist", "file"]

    def run(argv: List[str]) -> None:
        left = deadline - time.monotonic()
        if left <= 0:
            raise AdapterError(E_BAD_REQUEST, f"this {what} is too long to prepare within the time limit; "
                                              "shorten it and upscale the shorter copy")
        try:
            out = ffmpeg_limits.run(argv, timeout_s=left)
        except (OSError, RuntimeError) as e:
            raise AdapterError(E_NOT_CONFIGURED, f"this worker cannot prepare videos ({type(e).__name__}); "
                                                 "nothing was sent") from None
        if out.refused:
            raise AdapterError(E_BAD_REQUEST, _decode_refusal(b"\n".join(out.markers), what) or _REWRITE_FAILED)
        if out.timed_out:
            raise AdapterError(E_BAD_REQUEST, f"this {what} is too long to prepare within the time limit; "
                                              "shorten it and upscale the shorter copy")
        if not out.ok:
            # The tail is ffmpeg's, about the member's file: logged for the
            # operator, never put in the member's message.
            logger.info("upscale: the remux failed (exit %s)", out.returncode)
            raise AdapterError(E_BAD_REQUEST, _REWRITE_FAILED)

    copy = work / src.name
    if copy.resolve() == src.resolve():
        # ffmpeg -y would write over the member's file while reading it.
        raise ValueError("the upscale's work folder must not be the source's own")
    run([*head, "-f", demuxer, *cap, "-i", str(src), "-map", f"0:{reading.index}", "-map", "0:a?",
         "-c", "copy", "-map_chapters", "-1",
         # A QuickTime timecode in the metadata makes the MP4 / MOV muxer add
         # a tmcd track of its own: one picture and its sound is the copy.
         *(["-write_tmcd", "0"] if muxer in ("mp4", "mov") else []), "-f", muxer, str(copy)])
    if not copy.is_file() or copy.stat().st_size == 0:
        raise AdapterError(E_BAD_REQUEST, _REWRITE_FAILED)
    bsf = _ANNEXB.get(str(reading.codec or ""))
    if bsf is None:
        # Any other codec is decoded and counted by read_frames (VP9
        # superframes, packed B-frames), or is intra-only (ProRes).
        return Normalized(copy)
    # A folder of their own: a member's file may itself be named parsed.mp4.
    count = work / "count"
    count.mkdir()
    ts, parsed = count / "parsed.ts", count / "parsed.mp4"
    run([*head, "-f", demuxer, *cap, "-i", str(copy), "-map", "0:v:0", "-c", "copy",
         "-bsf:v", bsf, "-f", "mpegts", str(ts)])
    run([*head, "-f", "mpegts", *cap, "-i", str(ts), "-map", "0:v:0", "-c", "copy", "-f", "mp4", str(parsed)])
    ts.unlink(missing_ok=True)
    if not parsed.is_file() or parsed.stat().st_size == 0:
        raise AdapterError(E_BAD_REQUEST, _REWRITE_FAILED)
    return Normalized(copy, parsed)


class RunwayVideoUpscaleAdapter(RunwayAdapter):
    """``POST /v1/video_upscale`` (model ``magnific_video_upscaler_creative``,
    ``videoUri``, ``resolution`` 720p | 1k | 2k | 4k) → ``id``; polled like
    every Runway task at ``GET /v1/tasks/{id}``.

    The library file reaches Runway as an ephemeral upload: ``POST
    /v1/uploads {filename, type: "ephemeral"}`` answers a presigned
    ``uploadUrl`` + form ``fields`` and a ``runwayUri``; the file is POSTed
    there as multipart (WITHOUT our key — it is a storage host, not the API)
    and the ``runway://`` URI is what the task names. Never a public URL of
    ours: nothing of the organization's is exposed to fetch.

    Runway bills this per OUTPUT FRAME (docs.dev.runwayml.com/guides/pricing):
    the database prices it per second of source (0052), at a rate the owner
    sets for a ceiling frame rate. A source above that ceiling would cost more
    than it was priced at, so it is refused here before anything is uploaded
    or spent; a frame rate that cannot be read is refused too (CLAUDE.md #5).
    ``fpsBoost`` is never sent: it changes the frame count, and so the bill."""

    key = "video.runway_upscale"
    capabilities = (VIDEO_UPSCALE,)
    end_frame_capabilities = ()
    TARGETS = ("720p", "1k", "2k", "4k")
    #: The per-second price assumes at most this many frames a second.
    MAX_FPS = 60.0
    #: Runway's ephemeral uploads: 512 bytes to 200 MB.
    MIN_BYTES = 512
    MAX_BYTES = 200 * 1024 * 1024
    #: Replaced in tests; the worker image ships ffprobe (Dockerfile.worker).
    fps_of = staticmethod(read_frames)
    #: Replaced in tests; the worker image ships ffmpeg.
    normalize_of = staticmethod(normalize_for_upload)
    #: Runway's longest input (OpenAPI ``videoUri``: "Maximum duration is 30 seconds").
    MAX_SECONDS = 30.0
    #: One Runway credit in USD, and USD per OUTPUT frame by target
    #: (docs.dev.runwayml.com/guides/pricing, read 2026-11-27: credits =
    #: ceil(USD / 0.01); 720p and 1k 0.007, 2k 0.009, 4k 0.012). The
    #: registry's per-second variants are these at MAX_FPS (a test holds them
    #: equal). Exact fractions: 0.007 * 60 * 2 / 0.01 is 84.00000000000001 in
    #: floats, and a ceiling one credit high would let an estimate through.
    CREDIT_USD = Fraction(1, 100)
    USD_PER_FRAME = {"720p": Fraction(7, 1000), "1k": Fraction(7, 1000), "2k": Fraction(9, 1000),
                     "4k": Fraction(12, 1000)}

    def __init__(self, **kw):
        super().__init__(**kw)
        #: ``estimatedCost.credits`` of each task this process created, as
        #: Runway answered it (None: absent or unreadable). Read by the
        #: creative seam right after submit (``estimated_credits``).
        self._estimates: Dict[str, Optional[float]] = {}
        self._counted: Dict[str, Optional[int]] = {}

    def covered_credits(self, request: CapabilityRequest, priced_seconds: Optional[float]) -> Optional[int]:
        """The Runway credits the job's price pays for: the seconds the
        database priced at MAX_FPS frames a second at the target's rate,
        rounded up as Runway rounds a bill. The quote is per source second at
        that ceiling (0052), so this is the most of Runway's bill the hold was
        set to cover. None when either is unknown (never a guess)."""
        rate = self.USD_PER_FRAME.get(str(request.upscale_target or ""))
        if rate is None or isinstance(priced_seconds, bool) or not isinstance(priced_seconds, (int, float)) \
                or not 0 < priced_seconds < float("inf"):
            return None
        usd = rate * Fraction(int(self.MAX_FPS)) * Fraction(str(priced_seconds))
        return -(-usd // self.CREDIT_USD)

    def estimated_credits(self, task_id: str) -> Optional[float]:
        return self._estimates.get(str(task_id or ""))

    def counted_frames(self, task_id: str) -> Optional[int]:
        """The frames counted in the copy that was uploaded for ``task_id``."""
        return self._counted.get(str(task_id or ""))

    def cancel(self, task_id: str) -> Optional[int]:
        """``DELETE /v1/tasks/{id}``: the HTTP status (204 cancelled or
        deleted; 404 already gone, which the docs call safe to ignore), or
        None when the call could not be made or was refused. Whether Runway
        still bills a cancelled task is not a given: its OpenAPI (read
        2026-11-28) says a refund depends on the status the server observes
        while cancelling, none if it is RUNNING, and that neither a refund nor
        a successful cancel guarantees the generation stops. So a cancel is
        never read as "nothing was spent" on the platform's side."""
        try:
            tid = _safe_id(task_id)
            resp = self._call("DELETE", f"{self.base_url}/v1/tasks/{tid}", what="cancel", raw=True,
                              ok_statuses=(404,), billable=False)
        except AdapterError as e:
            logger.warning("runway: cancelling a task failed (%s)", e.code)
            return None
        return int(getattr(resp, "status_code", 0) or 0) or None

    def _priceable(self, reading: FrameReading) -> float:
        """The reading's rate when it is within the price's ceiling; else the
        refusal, with its remedy (BR-L-211)."""
        if reading.refusal:
            raise AdapterError(E_BAD_REQUEST, reading.refusal)
        fps = reading.rate
        if fps is None:
            raise AdapterError(E_BAD_REQUEST, "the video's frame rate could not be read, so its upscale "
                                              "cannot be priced; export it again as H.264 MP4")
        if fps > self.MAX_FPS + 0.5:
            if not reading.packed and reading.avg is not None and reading.avg <= self.MAX_FPS + 0.5 \
                    and reading.frames is not None and reading.seconds is not None:
                # The rate is honest and the frames outnumber the length: what
                # a stream-copied cut is (it keeps the frames back to the last
                # keyframe), and what a forged header looks like. Refused
                # either way, since what Runway bills for the extra frames is
                # unverified; re-encoding is the fix for both.
                # "Of picture": the rate is counted over the picture's length,
                # the price over the file's (format.duration); they differ when
                # the sound outlasts the picture (Lens round 3, 4).
                raise AdapterError(E_BAD_REQUEST, f"the file holds {reading.frames} frames in "
                                                  f"{reading.seconds:.1f} seconds of picture, as a clip cut "
                                                  "without re-encoding does; re-encode the trimmed clip and "
                                                  "upscale the new copy")
            raise AdapterError(E_BAD_REQUEST, f"this video runs at {fps:.0f} frames a second of picture; the "
                                              f"upscale takes up to {self.MAX_FPS:.0f}, so export it again at "
                                              f"{self.MAX_FPS:.0f} frames a second or fewer")
        return fps

    @staticmethod
    def _same_picture(a: FrameReading, b: FrameReading) -> bool:
        """Two readings of one picture agree: frames within the one frame of
        slack the rate forgives, and lengths within one frame's time (plus a
        millisecond for a 90 kHz or 1/1000 timescale's rounding)."""
        if None in (a.frames, b.frames, a.seconds, b.seconds, a.rate, b.rate):
            return False
        frame_s = 1.0 / max(a.rate, b.rate, 1.0)
        return abs(a.frames - b.frames) <= 1 and abs(a.seconds - b.seconds) <= frame_s + 0.001


    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        if request.upscale_target not in self.TARGETS:
            out.append(f"Runway upscales a video to {', '.join(self.TARGETS)} only")
        if request.input_images:
            out.append("a video upscale takes a video, not a picture")
        if len(request.input_media) != 1:
            out.append("a video upscale takes exactly one video")
        elif Path(request.input_media[0]).suffix.lower() not in _RUNWAY_VIDEO_TYPES:
            out.append("Runway takes MP4, MOV, WebM or MKV video")
        return out

    def _upload(self, path: Path) -> str:
        mime = _RUNWAY_VIDEO_TYPES[path.suffix.lower()]
        ticket = self.post(f"{self.base_url}/v1/uploads", {"filename": path.name, "type": "ephemeral"},
                           what="upload")
        url, fields, uri = ticket.get("uploadUrl"), ticket.get("fields"), ticket.get("runwayUri")
        if not is_url(url or "") or not isinstance(fields, dict) \
                or not all(isinstance(k, str) and isinstance(v, str) for k, v in fields.items()) \
                or not _RUNWAY_URI.fullmatch(str(uri or "")):
            raise AdapterError(E_BAD_RESPONSE, "upload: Runway answered without a usable upload ticket")
        try:
            with open(path, "rb") as fh:
                # No auth header: the presigned URL is the credential, and our
                # key must never reach a storage host. No redirects either.
                resp = self.session.request("POST", url, data=dict(fields), files={"file": (path.name, fh, mime)},
                                            timeout=max(self.timeout, 300), allow_redirects=False)
        except requests.RequestException as e:
            raise AdapterError(E_UNAVAILABLE, f"upload: {type(e).__name__}") from None
        status = getattr(resp, "status_code", 200)
        if status >= 300:
            # Runway: "If the upload fails, do not retry" — a new ticket is
            # needed, so the job fails and its hold is released.
            raise AdapterError(classify_http(status), f"upload: HTTP {status}", http_status=status)
        return str(uri)

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        if request.upscale_target not in self.TARGETS or len(request.input_media) != 1:
            raise AdapterError(E_BAD_REQUEST, "a video upscale needs one video and a target resolution")
        path = Path(request.input_media[0])
        if path.suffix.lower() not in _RUNWAY_VIDEO_TYPES:
            raise AdapterError(E_BAD_REQUEST, "Runway takes MP4, MOV, WebM or MKV video")
        size = path.stat().st_size
        if not self.MIN_BYTES <= size <= self.MAX_BYTES:
            raise AdapterError(E_BAD_REQUEST, "Runway takes videos from 512 bytes to 200 MB")
        source = self.fps_of(str(path))
        self._priceable(source)
        work = Path(tempfile.mkdtemp(prefix="nightshift-upscale-"))
        try:
            # What is priced, checked and uploaded is the remuxed copy, never
            # the member's file as it came (BR-L-211 residual (a)).
            norm = self.normalize_of(path, source, work)
            copy = self.fps_of(str(norm.path))
            self._priceable(copy)
            if norm.parsed is not None:
                parsed = self.fps_of(str(norm.parsed))
                # The parser's count is the frames a decoder meets: over the
                # ceiling is the ordinary refusal, at 240 a second for
                # Breach's h264p8 (150 samples read as 30).
                self._priceable(parsed)
                # Frames only: MPEG-TS carries no edit list, so the parsed
                # file's length is the media's, not the edited one's (a cut
                # keeps its preroll: 105 frames, 2.0 s in the copy, 3.5 s
                # parsed). Equal frames is what makes the copy one sample per
                # access unit; its rate was checked over its own length above.
                if parsed.frames is None or copy.frames is None or abs(parsed.frames - copy.frames) > 1:
                    raise AdapterError(E_BAD_REQUEST, f"this video keeps several frames in one sample "
                                                      f"({parsed.frames} frames in {copy.frames} samples), so it "
                                                      "cannot be priced by what its container says; export it "
                                                      "again (re-encoded) and upscale the new copy")
            if not self._same_picture(source, copy):
                raise AdapterError(E_BAD_REQUEST, f"the copy prepared for the upscale holds {copy.frames} frames in "
                                                  f"{copy.seconds or 0:.1f} seconds where the file reads "
                                                  f"{source.frames} in {source.seconds or 0:.1f}, so it cannot be "
                                                  "priced as read; export it again (re-encoded) and upscale the "
                                                  "new copy")
            copy_size = norm.path.stat().st_size
            if not self.MIN_BYTES <= copy_size <= self.MAX_BYTES:
                raise AdapterError(E_BAD_REQUEST, "the copy prepared for the upscale is outside the 512 bytes to "
                                                  "200 MB Runway takes; shorten the video or export it at a lower "
                                                  "bitrate")
            if copy.length is None:
                raise AdapterError(E_BAD_REQUEST, "the video's length could not be read, so its upscale cannot be "
                                                  "priced; export it again as H.264 MP4")
            if copy.length > self.MAX_SECONDS:
                raise AdapterError(E_BAD_REQUEST, f"this video runs {copy.length:.1f} seconds; the upscale takes up "
                                                  f"to {self.MAX_SECONDS:.0f}, so trim it to {self.MAX_SECONDS:.0f} "
                                                  "seconds or less and upscale the shorter copy")
            uri = self._upload(norm.path)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        data = self.post(f"{self.base_url}/v1/video_upscale",
                         {"model": vendor_model, "videoUri": uri, "resolution": request.upscale_target})
        if not data.get("id"):
            raise AdapterError(E_BAD_RESPONSE, "no task id in the response")
        tid = _safe_id(data["id"])
        # "The maximum credits this task may charge" (OpenAPI estimatedCost):
        # kept as Runway said it, or None, for the seam's check against the
        # job's price. Never defaulted: an absent figure is refused there.
        est = dig(data, "estimatedCost", "credits")
        self._estimates[tid] = float(est) if isinstance(est, (int, float)) and not isinstance(est, bool) \
            and 0 <= est < float("inf") else None
        self._counted[tid] = copy.frames
        for kept in (self._estimates, self._counted):
            while len(kept) > _RUNWAY_KEEP:
                kept.pop(next(iter(kept)))
        return ProviderTask(self.key, vendor_model, tid)


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
    #: ``video.end_frame`` (docs.agents.lumalabs.ai guides/videos/generation).
    end_frame_capabilities = (I2V,)
    _FAILURES = {"content_moderated": E_POLICY, "budget_exhausted": E_QUOTA,
                 "rate_limited": E_RATE_LIMITED, "invalid_request": E_BAD_REQUEST,
                 "image_too_large": E_BAD_REQUEST, "unsupported_format": E_BAD_REQUEST,
                 "corrupt_input": E_BAD_REQUEST, "output_not_found": E_UNAVAILABLE,
                 "generation_failed": E_UNAVAILABLE}
    #: Luma's validation rules: start_frame / end_frame are "rejected with
    #: duration: 10s" — a first frame included, so this holds for every i2v.
    _FRAMED_DURATIONS = (5,)

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        if request.capability == I2V and request.duration_s is not None \
                and request.duration_s not in self._FRAMED_DURATIONS:
            out.append("Luma animates a picture into 5 s clips only")
        return out

    @staticmethod
    def _frame(path: str) -> dict:
        return {"url": path} if is_url(path) else {"data": image_b64(path), "media_type": image_mime(path)}

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        video: dict = {}
        if request.duration_s:
            video["duration"] = f"{int(request.duration_s)}s"
        if request.resolution:
            video["resolution"] = request.resolution
        if request.capability == I2V:
            video["start_frame"] = self._frame(request.input_images[0])
            if request.end_image:
                video["end_frame"] = self._frame(request.end_image)
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
    region (owner decision D5); ``SEEDANCE_BASE_URL`` overrides it.

    Watermark: ``watermark`` is optional, default ``false`` (an "AI Generated"
    mark when true); the Acceptable Use Policy forbids removing identifiers but
    does not require the mark, so it is not sent and the default applies.
    https://docs.byteplus.com/en/docs/ModelArk/1520757"""

    key = "video.seedance"
    key_env = ("SEEDANCE_API_KEY", "ARK_API_KEY")
    base_url_env = "SEEDANCE_BASE_URL"
    default_base_url = "https://ark.ap-southeast.bytepluses.com"
    capabilities = (T2V, I2V)
    #: Two ``image_url`` items with ``role`` first_frame / last_frame — Seedance
    #: 1.5 pro and 1.0 pro (ModelArk video generation API, docs 1520757).
    end_frame_capabilities = (I2V,)
    #: ``generate_audio`` (1.5 pro) and ``resolution`` are both sent: priced
    #: apart (0070), neither is left to the vendor's default.
    audio_capabilities = (T2V, I2V)
    resolution_capabilities = (T2V, I2V)
    #: The resolution sent when a job names none: the cheapest the models
    #: price by, never the vendor's own default.
    DEFAULT_RESOLUTION = "720p"
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
            first = {"type": "image_url", "image_url": {"url": _image_ref(request.input_images[0])}}
            if request.end_image:
                # With two pictures the role is required on both; with one it
                # is left out, as before (the vendor reads it as the first frame).
                content += [dict(first, role="first_frame"),
                            {"type": "image_url", "image_url": {"url": _image_ref(request.end_image)},
                             "role": "last_frame"}]
            else:
                content.append(first)
        body: dict = {"model": vendor_model, "content": content,
                      "ratio": request.aspect_ratio or "16:9",
                      "duration": int(request.duration_s or 5)}
        body["resolution"] = request.resolution or self.DEFAULT_RESOLUTION
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


# ── ByteDance Seedance 2.x (BytePlus ModelArk, international) ───────────────
class SeedanceV2Adapter(SafeResultMixin, SeedanceAdapter):
    """Dreamina Seedance 2.0 and 2.5 on the same ModelArk task API as the 1.x
    models (``POST /api/v3/contents/generations/tasks``, ``GET …/{id}``;
    docs.byteplus.com/en/docs/ModelArk/1520757 and …/seedance-2-5, read
    2026-10-24), with what the 2.x pages add or change:

    * the settings are always explicit: the resolution and the duration are
      required and sent as given (``-1`` — "the model picks the length" — is
      never sent, because the price is per second), and a model or a value
      this table does not list is refused before any call;
    * 2.5 first-frame / first-and-last-frame video "defaults to and only
      supports ``adaptive``": the clip keeps the picture's own shape, so a job
      that names an aspect ratio for it is refused rather than ignored;
    * ``role`` is always sent on the pictures (``first_frame`` /
      ``last_frame``): 2.5 reads the task type from it;
    * ``execution_expires_after`` is the API's minimum (3600 s): a task still
      queued when the worker stops polling (45 min) is ended by the vendor
      within the hour instead of running — and billing — up to its 48 h default;
    * ``safety_identifier`` carries the opaque per-organization id the vendors
      ask for, so abuse is traced to one user and not to our account;
    * reference images or videos with real faces are refused by the vendor
      (``InputImageSensitiveContentDetected.PrivacyInformation``): a ``policy``
      error, no fallback;
    * the clip is fetched with ``SafeResultMixin`` (https, vendor hosts,
      no redirect, byte cap, atomic write).

    Watermark: left to the vendor's default (off for Seedance).

    TERMS: BytePlus's Service Specific Terms (Model Services §4.2.3) forbid
    integrating the video APIs into UGC platforms or AI content creation
    tools, or reselling them, without written authorization. The registry
    entries carry ``terms_gate: written_consent_required`` (migration 0035),
    so none of this is sellable until BytePlus agrees in writing."""

    key = "video.seedance2"
    result_hosts = MODELARK_RESULT_HOSTS
    EXPIRES_AFTER_S = 3600
    #: The aspect ratios the API takes ("adaptive" is handled apart: it is what i2v sends).
    RATIOS = ("16:9", "4:3", "1:1", "3:4", "9:16", "21:9")
    #: A picture goes inline as base64: the API takes < 30 MB per picture and 64 MB per request.
    MAX_IMAGE_BYTES = 20 * 1024 * 1024
    #: vendor model -> what it takes. 4K exists for 2.0 but is not offered (its price and its
    #: rate limit differ, and nothing here is priced for it).
    SPECS = {
        "dreamina-seedance-2-0-260128": {"resolutions": ("480p", "720p", "1080p"),
                                         "durations": tuple(range(4, 16)), "adaptive_first_frame": False},
        "dreamina-seedance-2-5-260628": {"resolutions": ("480p", "720p", "1080p"),
                                         "durations": tuple(range(4, 31)), "adaptive_first_frame": True},
    }

    def _map(self, code) -> Optional[str]:
        return modelark_code(code)

    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        spec = self.SPECS.get(vendor_model)
        if spec is None:
            return [f"{vendor_model!r} is not a Seedance 2.x model this adapter knows"]
        out: List[str] = []
        if request.resolution not in spec["resolutions"]:
            out.append(f"resolution {request.resolution or '(none)'} is not offered by {vendor_model}: the price "
                       f"depends on it, so it is never defaulted")
        if request.duration_s not in spec["durations"]:
            out.append(f"duration {request.duration_s if request.duration_s is not None else '(none)'} s is not "
                       f"offered by {vendor_model}: the price is per second, so it is never defaulted")
        if request.aspect_ratio is not None and request.aspect_ratio not in self.RATIOS:
            out.append(f"aspect ratio {request.aspect_ratio} is not offered by {vendor_model}")
        if request.capability == I2V:
            if not request.input_images:
                out.append("i2v needs a first-frame picture")
            elif not is_url(str(request.input_images[0])):
                path = Path(str(request.input_images[0]))
                if path.is_file() and path.stat().st_size > self.MAX_IMAGE_BYTES:
                    out.append("Seedance takes pictures of at most 20 MB")
            if spec["adaptive_first_frame"] and request.aspect_ratio:
                out.append(f"{vendor_model} keeps the first frame's own shape: an aspect ratio does not apply to i2v")
        elif request.input_images or request.end_image:
            out.append("a picture does not apply to text-to-video")
        return out

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        out.extend(self._spec_problems(request, entry.vendor_model_for(request.capability)))
        return out

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        bad = self._spec_problems(request, vendor_model)
        if bad:
            # Nothing has been sent: this is a refusal, not a lost answer.
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad), not_accepted=True)
        spec = self.SPECS[vendor_model]
        content: list = []
        if request.prompt.strip():
            content.append({"type": "text", "text": request.prompt.strip()})
        try:
            if request.capability == I2V:
                content.append({"type": "image_url", "image_url": {"url": _image_ref(str(request.input_images[0]))},
                                "role": "first_frame"})
                if request.end_image:
                    content.append({"type": "image_url", "image_url": {"url": _image_ref(str(request.end_image))},
                                    "role": "last_frame"})
        except OSError:
            raise AdapterError(E_BAD_REQUEST, "the picture could not be read", not_accepted=True) from None
        if not content:
            raise AdapterError(E_BAD_REQUEST, "there is nothing to generate from: no prompt and no picture",
                               not_accepted=True)
        if request.capability == I2V and spec["adaptive_first_frame"]:
            ratio = "adaptive"
        else:
            ratio = request.aspect_ratio or ("adaptive" if request.capability == I2V else "16:9")
        body: dict = {"model": vendor_model, "content": content, "resolution": request.resolution,
                      "ratio": ratio, "duration": int(request.duration_s),
                      "execution_expires_after": self.EXPIRES_AFTER_S}
        if request.audio is not None:
            body["generate_audio"] = bool(request.audio)
        if request.end_user and _SAFETY_ID.fullmatch(request.end_user):
            body["safety_identifier"] = request.end_user
        data = self.submit_json(f"{self.base_url}/api/v3/contents/generations/tasks", body)
        tid = data.get("id") if isinstance(data, dict) else None
        if not isinstance(tid, str) or not _ID.fullmatch(tid):
            # The vendor answered 2xx: a task probably exists, and it bills.
            raise unconfirmed("the answer carries no usable task id")
        return ProviderTask(self.key, vendor_model, tid)

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        data = self.get(f"{self.base_url}/api/v3/contents/generations/tasks/{_safe_id(task.task_id)}")
        data = data if isinstance(data, dict) else {}
        status = str(data.get("status") or "").lower()
        if status == "succeeded":
            url = dig(data, "content", "video_url")
            if not isinstance(url, str) or not url:
                # The vendor says the clip exists (and bills it): we just were not given the link.
                raise after_completion(AdapterError(E_BAD_RESPONSE, "succeeded without content.video_url"))
            return self.checked_outputs(PollResult(SUCCEEDED, [Output("video/mp4", url=url)]))
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
    2026-09-30 (still served, no new models).

    Watermark: ``parameters.watermark`` is optional, default ``false`` ("AI
    Generated" when true); nothing read requires it, so it is not sent.
    https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference"""

    key = "video.wan"
    #: submit sends negative_prompt in the vendor body (tests/test_negative_prompt_wiring.py proves it per registry model).
    TAKES_NEGATIVE_PROMPT = True
    key_env = ("WAN_API_KEY", "DASHSCOPE_API_KEY")
    base_url_env = "WAN_BASE_URL"
    default_base_url = "https://dashscope-intl.aliyuncs.com"
    capabilities = (T2V, I2V)
    #: Always sent (720P when a job names none), so what is priced is what runs.
    resolution_capabilities = (T2V, I2V)
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
    #: See FluxAdapter: the polling link carries ``x-key``, so it gets the strict check; a 3xx is never followed.
    polling_domain = "bfl.ai"
    polling_ports = (None, 443)
    follow_redirects = False

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
        poll = data.get("polling_url") if isinstance(data, dict) else None
        try:
            checked_polling_url(poll, self.polling_domain, self.polling_ports)
        except (AdapterError, TypeError):
            # The vendor answered 2xx: a task probably exists, and it bills; the key was not sent to the link.
            raise unconfirmed("the answer carries no polling_url on bfl.ai") from None
        return ProviderTask(self.key, vendor_model, str(poll))

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        url = str(task.task_id or "")
        try:
            checked_polling_url(url, self.polling_domain, self.polling_ports)
        except AdapterError:
            # Accepted once, so it may have run and been billed; the key was not sent to the link.
            raise after_completion(AdapterError(E_NOT_FOUND, "task id is not a bfl.ai polling URL")) from None
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


ADAPTERS = (VeoAdapter, KlingAdapter, MiniMaxVideoAdapter, RunwayAdapter, RunwayVideoUpscaleAdapter,
            LumaAdapter, SeedanceAdapter, SeedanceV2Adapter, WanAdapter, FluxVideoAdapter)
