"""LTX-2.5 and LTX-2.3 (Lightricks' own API): text-to-video and image-to-video.

Sources, all on docs.ltx.io (each page as markdown, append ``.md``) and read 2026-10-25: ``/async-jobs``,
``/authentication``, ``/errors``, ``/rate-limits``, ``/pricing``, ``/input-formats``, ``/models/ltx-2-5``,
``/models/ltx-2-3`` and the API reference pages ``submit-text-to-video``, ``submit-image-to-video``,
``get-job-status``. The licence is static.lightricks.com/legal/ltx-2-api-license-agreement.pdf (Last
Updated May 12, 2026) and the Acceptable Use Policy (Last Updated March 30, 2026).

* ``POST /v2/text-to-video`` or ``/v2/image-to-video`` answers 202 ``{"id", "created_at"}``;
  ``GET /v2/{endpoint}/{id}`` answers ``status`` (pending | processing | completed | failed), a completed
  job carries ``result.video_url`` and a failed one ``error {type, message}`` (the same shape as an HTTP
  error). Job status lives 24 h after it ends; the output link expires on its own.
* The ``id`` alone does not say which endpoint to poll, so the task id is stored as
  ``<endpoint>:<id>`` (``text-to-video:<uuid>``) and split again in ``poll``.

What is sent, and why: the price is per second of output by model and resolution, so ``duration`` and
``resolution`` are required and sent as given (never ``null`` = automatic duration, which holds credits
for the longest clip and bills what comes out); ``fps`` is always sent, ``24`` (the vendor's default, and
the one rate every model/resolution/duration combination supports). The resolution is sent as the
``WIDTHxHEIGHT`` string the docs list for the chosen shape. ``generate_audio`` is sent only when the job
names it (audio is not priced apart). Not wired: audio-to-video, retake, extend, HDR, reframe, camera
motion, a last frame, multi-shot prompts.

RESULT LINKS: the docs show a ``storage.googleapis.com`` link and nothing else. That is a domain shared by
every Google Cloud customer; no narrower host is documented. Only it is accepted (fail closed: any other
host is refused with a message naming the host it saw), and it stays an UNVERIFIED guess until a probe.

BILLING: the docs say what a request costs, not what a failed or filtered job costs; nothing here tells a
person a failed job was free. On a prepaid account credits are held against the job and a request can
be declined for a balance the clip would not have used (automatic duration only).

TERMS: the licence (2.1(b)) lets the customer "utilize the LTX Model in Customer's Service to be used by
End Users" but (2.2(d)) bars making it available "to any third party through a service bureau, resale or
similar models"; 3.2 requires enforceable end-user terms at least as protective of LTX. The registry
entries carry ``terms_gate: terms_review_required`` and stay unsellable until a person (and, if needed,
Lightricks) has settled whether a credits product is "resale".
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import List, Optional, Tuple

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

#: See RESULT LINKS above: the one host the docs show.
RESULT_HOSTS = ("storage.googleapis.com",)

_JOB = re.compile(r"^[A-Za-z0-9_-]{1,120}$")
_ENDPOINTS = {T2V: "text-to-video", I2V: "image-to-video"}
#: The vendor's error ``type`` -> our code (docs.ltx.io/errors), HTTP and job failure alike.
_ERROR_TYPES = {
    "invalid_request_error": E_BAD_REQUEST, "authentication_error": E_AUTH, "insufficient_funds_error": E_QUOTA,
    "permission_error": E_AUTH, "not_found_error": E_NOT_FOUND, "request_too_large_error": E_BAD_REQUEST,
    "content_filtered_error": E_POLICY, "concurrency_limit_error": E_RATE_LIMITED, "rate_limit_error": E_RATE_LIMITED,
    "api_error": E_UNAVAILABLE, "service_unavailable_error": E_UNAVAILABLE, "overloaded_error": E_UNAVAILABLE,
}
#: WIDTHxHEIGHT by resolution tier and shape (docs.ltx.io/models/ltx-2-5, ltx-2-3).
_SIZES_25 = {
    "720p": {"16:9": "1280x720", "9:16": "720x1280", "1:1": "720x720", "3:2": "1080x720", "2:3": "720x1080"},
    "1080p": {"16:9": "1920x1080", "9:16": "1080x1920", "1:1": "1080x1080", "3:2": "1620x1080", "2:3": "1080x1620"},
    "1440p": {"16:9": "2560x1440", "9:16": "1440x2560", "1:1": "1440x1440", "3:2": "2160x1440", "2:3": "1440x2160"},
    "4k": {"16:9": "3840x2160", "9:16": "2160x3840", "1:1": "2160x2160", "3:2": "3240x2160", "2:3": "2160x3240"},
}
_SIZES_23 = {tier: {k: v for k, v in shapes.items() if k in ("16:9", "9:16")} for tier, shapes in _SIZES_25.items()}
_SHORT = (6, 8, 10)
_LONG = (6, 8, 10, 12, 14, 16, 18, 20)
#: Local pictures go inline as base64; the docs cap an inline image at 7 MB encoded (about 5 MB of file).
MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024


def _error_of(body) -> Tuple[Optional[str], str]:
    """(type, message) of the vendor's ``{"type": "error", "error": {...}}`` shape, or (None, "")."""
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        return (str(err.get("type") or "") or None), str(err.get("message") or "")
    return None, ""


class LtxVideoAdapter(SafeResultMixin, HttpAdapter):
    """LTX-2.5 and LTX-2.3, Fast and Pro: 6-20 s, 720p to 4K, with generated audio."""

    key = "video.ltx"
    key_env = ("LTX_API_KEY", "LTXV_API_KEY")
    base_url_env = "LTX_BASE_URL"
    default_base_url = "https://api.ltx.io"
    capabilities = (T2V, I2V)
    audio_capabilities = (T2V, I2V)          # ``generate_audio`` (default true on the vendor's side)
    resolution_capabilities = (T2V, I2V)     # always sent
    result_hosts = RESULT_HOSTS
    #: vendor model -> sizes and the durations each resolution allows at 24 fps.
    SPECS = {
        "ltx-2-5-fast": {"sizes": _SIZES_25, "durations": {"720p": _LONG, "1080p": _LONG, "1440p": _SHORT, "4k": _SHORT}},
        "ltx-2-5-pro": {"sizes": _SIZES_25, "durations": {t: _SHORT for t in _SIZES_25}},
        "ltx-2-3-fast": {"sizes": _SIZES_23, "durations": {"720p": _LONG, "1080p": _LONG, "1440p": _SHORT, "4k": _SHORT}},
        "ltx-2-3-pro": {"sizes": _SIZES_23, "durations": {t: _SHORT for t in _SIZES_23}},
    }
    FPS = 24

    def vendor_error_code(self, status: int, text: str) -> Optional[str]:
        etype, _ = _error_of(json_body(text))
        return _ERROR_TYPES.get(etype or "")

    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        spec = self.SPECS.get(vendor_model)
        if spec is None:
            return [f"{vendor_model!r} is not an LTX model this adapter knows"]
        out: List[str] = []
        res = request.resolution
        if res not in spec["sizes"]:
            out.append(f"resolution {res or '(none)'} is not offered by {vendor_model}: the price depends on it, "
                       f"so it is never defaulted")
        shape = request.aspect_ratio or "16:9"
        if res in spec["sizes"] and shape not in spec["sizes"][res]:
            out.append(f"aspect ratio {shape} is not offered by {vendor_model}")
        allowed = spec["durations"].get(res, ())
        if request.duration_s not in allowed:
            out.append(f"duration {request.duration_s if request.duration_s is not None else '(none)'} s is not offered "
                       f"by {vendor_model} at {res or 'that resolution'}: the price is per second, so it is never "
                       f"defaulted or left to the model to choose")
        if request.negative_prompt:
            out.append("LTX takes no negative prompt")
        if not request.prompt.strip():
            out.append("prompt is empty")
        if request.capability == T2V and request.input_images:
            out.append("a picture does not apply to text-to-video")
        if request.capability == I2V and not request.input_images:
            out.append("i2v needs a first-frame picture")
        return out

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        out.extend(self._spec_problems(request, entry.vendor_model_for(request.capability)))
        return out

    @staticmethod
    def _picture(ref: str) -> str:
        if is_url(ref):
            return ref
        path = Path(ref)
        if path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
            raise AdapterError(E_BAD_REQUEST, "LTX takes JPEG, PNG or WEBP pictures", not_accepted=True)
        try:
            if path.stat().st_size > MAX_INLINE_IMAGE_BYTES:
                raise AdapterError(E_BAD_REQUEST, f"the picture is over {MAX_INLINE_IMAGE_BYTES // (1 << 20)} MB",
                                   not_accepted=True)
            return image_data_uri(ref)
        except OSError:
            raise AdapterError(E_BAD_REQUEST, "the picture could not be read", not_accepted=True) from None

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        bad = self._spec_problems(request, vendor_model)
        if bad:
            # Nothing has been sent: this is a refusal, not a lost answer.
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad), not_accepted=True)
        spec = self.SPECS[vendor_model]
        endpoint = _ENDPOINTS[request.capability]
        body: dict = {"prompt": request.prompt.strip(), "model": vendor_model, "duration": int(request.duration_s),
                      "resolution": spec["sizes"][request.resolution][request.aspect_ratio or "16:9"],
                      "fps": self.FPS}
        if request.capability == I2V:
            body["image_uri"] = self._picture(str(request.input_images[0]))
        if request.audio is not None:
            body["generate_audio"] = bool(request.audio)
        data = self.submit_json(f"{self.base_url}/v2/{endpoint}", body)
        jid = data.get("id") if isinstance(data, dict) else None
        if not isinstance(jid, str) or not _JOB.fullmatch(jid):
            # The vendor answered 2xx: a job probably exists, and it bills.
            raise unconfirmed("the answer carries no usable job id")
        return ProviderTask(self.key, vendor_model, f"{endpoint}:{jid}")

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        endpoint, _, jid = str(task.task_id or "").partition(":")
        if endpoint not in _ENDPOINTS.values() or not _JOB.fullmatch(jid):
            raise AdapterError(E_NOT_FOUND, "task id has an unexpected shape")
        data = self.get(f"{self.base_url}/v2/{endpoint}/{jid}")
        data = data if isinstance(data, dict) else {}
        status = str(data.get("status") or "").lower()
        if status == "completed":
            url = dig(data, "result", "video_url")
            if not isinstance(url, str) or not url:
                # The vendor says the clip exists (and bills it): we just were not given the link.
                raise after_completion(AdapterError(E_BAD_RESPONSE, "completed without result.video_url"))
            return self.checked_outputs(PollResult(SUCCEEDED, [Output("video/mp4", url=url)]))
        if status == "failed":
            etype, message = _error_of(data)
            return PollResult(FAILED, error=AdapterError(
                _ERROR_TYPES.get(etype or "", E_UNAVAILABLE), self.message(message or etype or "the job failed")))
        return PollResult(PENDING)


ADAPTERS = (LtxVideoAdapter,)
