"""MiniMax H3 (the maker's own API, video generation V2): H3, H3 Highspeed, H3 Lite, H3 Max.

The older ``video.minimax`` adapter (Hailuo, ``POST /v1/video_generation`` with a
flat ``prompt``) cannot serve these: H3 is ``POST /v2/video_generation`` with a
``content[]`` array, and its result link comes straight out of the task query
(no ``file_id`` round trip).

Sources, all on platform.minimax.io and read 2026-10-25 (each page as markdown,
append ``.md``): ``/docs/api-reference/video-generation-v2-create``,
``/docs/api-reference/video-generation-v2-query``, ``/docs/guides/video-generation``,
``/docs/guides/models-intro``, ``/docs/pricing/overview``, ``/docs/guides/rate-limits``,
and the Terms of Service (``/protocol/terms-of-service``, effective 2026-03-30).

* ``POST /v2/video_generation`` answers ``{"task_id"}``; ``GET
  /v2/query/video_generation/{task_id}`` answers ``{"task": {status, content.url,
  error{code,message}}}`` with ``status`` ``queued`` | ``running`` | ``succeeded`` |
  ``failed`` | ``cancelled``. Only tasks of the last 7 days can be queried, and the
  result link is time-limited ("download or store it promptly").
* Errors are OpenAI-shaped (``{"type": "error", "error": {"type", "message"}}``)
  with the real HTTP status; the message ends in MiniMax's own code, e.g. ``(1004)``.
* H3 makes its own stereo soundtrack and the price does not depend on it, so no
  audio flag is sent (and a job that names one is refused).

Billing claims the adapter is built around: the pricing page prices every task
type alike per second of OUTPUT, plus input video per second and input images
beyond a free quota (5; H3 Max 2). This adapter sends at most two pictures
(first and last frame), inside the free quota. MiniMax does not say whether a
FAILED or moderated task is billed, so none of those messages claims it was not.

Where the clip lives: the docs name no host. Their examples show
``video-product.cdn.minimax.io`` and ``cdn.hailuoai.com``, so the allow-list is
the two vendor domains ``minimax.io`` and ``hailuoai.com``; a clip anywhere else
fails closed after completion (probe: ``bad_response``) instead of being fetched.

TERMS (User Rights and Obligations 7(c) and its neighbours): the registry entries carry
``terms_gate: terms_review_required`` and stay unsellable until a person decides.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import List, Optional

from modules.capabilities.base import (
    E_AUTH,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
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
    dig,
    image_data_uri,
    is_url,
    json_body,
)
from modules.capabilities.safe_fetch import SafeResultMixin, after_completion, unconfirmed

#: Vendor domains a clip may be downloaded from (a host matches itself or a subdomain, never a look-alike).
RESULT_HOSTS = ("minimax.io", "hailuoai.com")

_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")
_TRAILING_CODE = re.compile(r"\((\d{4})\)\s*$")
#: Said after any task MiniMax reports as failed or cancelled: its pages are silent on whether that is billed.
BILLING_UNKNOWN = "MiniMax does not say whether a failed task is billed; check its usage page before assuming nothing was spent"
#: error.type of the OpenAI-style error body -> ours (docs: video-generation-v2-create, OaiErrorDetail).
_TYPES = {
    "authorized_error": E_AUTH,
    "insufficient_balance_error": E_QUOTA,
    "rate_limit_error": E_RATE_LIMITED,
    "bad_request_error": E_BAD_REQUEST,
    "unprocessable_entity_error": E_POLICY,       # "video description contains sensitive content (1026)"
    "overloaded_error": E_UNAVAILABLE,
    "server_error": E_UNAVAILABLE,
}
#: The trailing / ``error.code`` numbers the V2 docs show (create + query pages).
_CODES = {1000: E_UNAVAILABLE, 1002: E_RATE_LIMITED, 1004: E_AUTH, 1008: E_QUOTA, 1026: E_POLICY, 2013: E_BAD_REQUEST}
_POLICY_WORDS = ("sensitive", "policy", "moderat", "safety", "violat")

_DURATIONS = tuple(range(4, 16))


def _utf16_len(text: str) -> int:
    return len((text or "").encode("utf-16-le")) // 2


class MiniMaxH3Adapter(SafeResultMixin, HttpAdapter):
    """MiniMax H3 family: text-to-video and first-frame (+ last-frame) image-to-video.

    Resolution and duration are required and sent as given: the price is per
    second of output and differs by resolution, and the vendor has defaults of
    its own (Lite and Max: 768P). The 2K tier is written ``2k`` in the registry
    (MiniMax prints no pixel size for it, so no ``1440p`` is claimed) and sent as
    ``2K``. Text-to-video needs a concrete ratio (the vendor refuses ``adaptive``
    there; 16:9 when the job names none). In image-to-video the clip always takes
    the picture's shape, so a job that names a ratio is refused rather than
    ignored. H3 requires words even for image-to-video.

    Not wired: reference-to-video (images, videos, audio), regeneration to 2K,
    H3-Context-IR, ``callback_url``, ``extra.prompt_expansion_mode`` (Max keeps
    the vendor default ``balanced``)."""

    key = "video.minimax_h3"
    key_env = ("MINIMAX_API_KEY",)
    base_url_env = "MINIMAX_BASE_URL"
    default_base_url = "https://api.minimax.io"
    capabilities = (T2V, I2V)
    end_frame_capabilities = (I2V,)
    resolution_capabilities = (T2V, I2V)
    result_hosts = RESULT_HOSTS
    #: ``image_url`` takes a public URL or a base64 data URI of JPG/PNG/WEBP (HEIC too, not sent here); 30 MB each,
    #: and the whole request body 64 MB, so a picture sent inline stays well under both.
    MAX_IMAGE_BYTES = 20 * 1024 * 1024
    MAX_PROMPT_UNITS = 7000
    RATIOS = ("21:9", "16:9", "4:3", "1:1", "3:4", "9:16")
    SPECS = {
        "MiniMax-H3": {"resolutions": {"768p": "768P", "2k": "2K"}, "durations": _DURATIONS},
        "MiniMax-H3-Highspeed": {"resolutions": {"768p": "768P"}, "durations": _DURATIONS},
        "MiniMax-H3-Lite": {"resolutions": {"480p": "480P", "768p": "768P"}, "durations": _DURATIONS},
        "MiniMax-H3-Max": {"resolutions": {"480p": "480P", "768p": "768P"}, "durations": tuple(range(5, 16))},
    }
    _PICTURE = (".jpg", ".jpeg", ".png", ".webp")

    # -- the vendor's error vocabulary ------------------------------------------------
    def vendor_error_code(self, status: int, text: str) -> Optional[str]:
        err = dig(json_body(text), "error")
        if not isinstance(err, dict):
            return None
        by_type = _TYPES.get(str(err.get("type") or ""))
        if by_type:
            return by_type
        m = _TRAILING_CODE.search(str(err.get("message") or ""))
        return _CODES.get(int(m.group(1))) if m else None

    # -- validation ---------------------------------------------------------------------
    def _picture_problem(self, ref: str, what: str) -> Optional[str]:
        if is_url(ref):
            return None
        if "://" in ref:
            return f"the {what} must be an https link or a local JPG, PNG or WEBP picture"
        path = Path(ref)
        if path.suffix.lower() not in self._PICTURE:
            return f"the {what} must be a JPG, PNG or WEBP picture or an https link"
        if not path.is_file():
            return f"the {what} could not be read"
        if path.stat().st_size > self.MAX_IMAGE_BYTES:
            return f"the {what} is over 20 MB (MiniMax takes 30 MB; it is sent inline, so less)"
        return None

    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        spec = self.SPECS.get(vendor_model)
        if spec is None:
            return [f"{vendor_model!r} is not a MiniMax H3 model this adapter knows"]
        out: List[str] = []
        if request.resolution not in spec["resolutions"]:
            out.append(f"resolution {request.resolution or '(none)'} is not offered by {vendor_model}: the price "
                       f"depends on it, so it is never defaulted")
        dur = request.duration_s
        if dur not in spec["durations"]:
            out.append(f"duration {dur if dur is not None else '(none)'} s is not offered by {vendor_model}: the "
                       f"price is per second, so it is never defaulted")
        if not (request.prompt or "").strip():
            out.append("MiniMax H3 needs words for every mode, image-to-video included")
        elif _utf16_len(request.prompt.strip()) > self.MAX_PROMPT_UNITS:
            out.append(f"the prompt is longer than {self.MAX_PROMPT_UNITS} characters")
        if request.aspect_ratio is not None and request.aspect_ratio not in self.RATIOS:
            out.append(f"aspect ratio {request.aspect_ratio} is not offered by {vendor_model}")
        if request.capability == I2V:
            if len(request.input_images) != 1:
                out.append("image-to-video needs exactly one first-frame picture")
            else:
                bad = self._picture_problem(str(request.input_images[0]), "first-frame picture")
                if bad:
                    out.append(bad)
            if request.end_image:
                bad = self._picture_problem(str(request.end_image), "last-frame picture")
                if bad:
                    out.append(bad)
            if request.aspect_ratio:
                out.append("image-to-video keeps the picture's own shape: an aspect ratio does not apply to i2v")
        else:
            if request.input_images or request.end_image:
                out.append("a picture does not apply to text-to-video")
        return out

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        out.extend(p for p in self._spec_problems(request, entry.vendor_model_for(request.capability)) if p not in out)
        return out

    # -- submit / poll ------------------------------------------------------------------
    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        bad = self._spec_problems(request, vendor_model)
        if bad:
            # Nothing has been sent: this is a refusal, not a lost answer.
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad), not_accepted=True)
        spec = self.SPECS[vendor_model]
        content: List[dict] = [{"type": "text", "text": request.prompt.strip()}]
        body: dict = {"model": vendor_model, "content": content,
                      "resolution": spec["resolutions"][request.resolution], "duration": int(request.duration_s)}
        if request.capability == I2V:
            try:
                content.append({"type": "image_url", "role": "first_frame",
                                "image_url": {"url": self._ref(str(request.input_images[0]))}})
                if request.end_image:
                    content.append({"type": "image_url", "role": "last_frame",
                                    "image_url": {"url": self._ref(str(request.end_image))}})
            except OSError:
                raise AdapterError(E_BAD_REQUEST, "a picture could not be read", not_accepted=True) from None
            # The ratio is left out: with a picture it is always the picture's ("adaptive").
        else:
            body["ratio"] = request.aspect_ratio or "16:9"
        data = self.submit_json(f"{self.base_url}/v2/video_generation", body)
        tid = data.get("task_id") if isinstance(data, dict) else None
        if not isinstance(tid, str) or not _ID.fullmatch(tid):
            # The vendor answered 2xx: a task probably exists, and it bills.
            raise unconfirmed("the answer carries no usable task_id")
        return ProviderTask(self.key, vendor_model, tid)

    @staticmethod
    def _ref(path: str) -> str:
        return path if is_url(path) else image_data_uri(path)

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        tid = str(task.task_id or "")
        if not _ID.fullmatch(tid):
            raise AdapterError(E_NOT_FOUND, "task id has an unexpected shape")
        try:
            data = self.get(f"{self.base_url}/v2/query/video_generation/{tid}")
        except AdapterError as e:
            if e.http_status == 400 and "task_id" in e.message.lower():
                # "a task_id outside this window returns invalid task_id": MiniMax answers for 7 days only.
                raise AdapterError(E_NOT_FOUND, "MiniMax no longer answers for this task id (it keeps tasks 7 days) "
                                                "or never had it; if it finished it was billed, check the usage page",
                                   http_status=400) from None
            raise
        info = data.get("task") if isinstance(data, dict) else None
        if not isinstance(info, dict):
            raise AdapterError(E_BAD_RESPONSE, "the status answer carries no task object")
        status = str(info.get("status") or "").lower()
        if status in ("queued", "running"):
            return PollResult(PENDING)
        if status == "succeeded":
            url = dig(info, "content", "url")
            if not isinstance(url, str) or not url:
                # MiniMax said the task is done: the clip exists and is billed.
                raise after_completion(AdapterError(E_BAD_RESPONSE, "succeeded without content.url"))
            return self.checked_outputs(PollResult(SUCCEEDED, [Output("video/mp4", url=url)]))
        if status in ("failed", "cancelled"):
            return PollResult(FAILED, error=self._failure(info, status))
        raise AdapterError(E_BAD_RESPONSE, f"the task has a status this adapter does not know ({self.message(status)!r})")

    def _failure(self, info: dict, status: str) -> AdapterError:
        err = info.get("error") if isinstance(info.get("error"), dict) else {}
        if status == "cancelled":
            return AdapterError(E_UNAVAILABLE, f"the task was cancelled at MiniMax. {BILLING_UNKNOWN}")
        text = self.message(err.get("message") or err.get("code") or "the vendor reported the task failed")
        try:
            code = _CODES.get(int(err.get("code")))
        except (TypeError, ValueError):
            code = None
        if code is None:
            code = E_POLICY if any(w in text.lower() for w in _POLICY_WORDS) else E_UNAVAILABLE
        return AdapterError(code, f"{text}. {BILLING_UNKNOWN}")


ADAPTERS = (MiniMaxH3Adapter,)
