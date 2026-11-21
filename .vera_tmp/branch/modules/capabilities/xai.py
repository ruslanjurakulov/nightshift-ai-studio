"""xAI Grok Imagine (the maker's own API): video and image adapters.

Sources, all on docs.x.ai and read 2026-10-24 (each page as markdown, append
``.md``): ``/developers/model-capabilities/video/generation``, ``…/video/overview``,
``…/video/image-to-video``, ``…/images/generation``,
``/developers/rest-api-reference/inference/videos``, ``…/inference/images``,
``/developers/models``, ``/developers/pricing``, ``/developers/rate-limits``.

* Video is asynchronous: ``POST /v1/videos/generations`` answers
  ``{"request_id"}``; ``GET /v1/videos/{request_id}`` answers ``status``
  ``pending`` | ``done`` | ``failed`` (the REST reference and the examples also
  show ``expired``); a ``done`` body carries ``video.url`` — a temporary link on
  an ``x.ai`` host (``vidgen.x.ai`` in the docs) — and ``video.respect_moderation``
  (when false the link is empty). A failed body carries ``error.code``
  (``invalid_argument`` / ``permission_denied`` / ``failed_precondition`` /
  ``service_unavailable`` / ``internal_error``); authentication, unknown-model and
  rate-limit errors come back synchronously as HTTP errors, before any job exists.
* Images are synchronous: ``POST /v1/images/generations`` answers ``data[]`` with
  ``b64_json`` when ``response_format`` is ``b64_json``. Base64 is requested so no
  temporary link is ever fetched.

Billing claims the adapters are built around (docs.x.ai/developers/pricing;
vendor claims, unverified here): a request deemed to violate the usage
guidelines is still charged, so EVERY moderation refusal (a filtered video, a
failed job, a synchronous HTTP 400) is reported as ``policy`` with that warning
and never as "nothing was bought"; image ``quality`` ``auto`` bills whatever tier the service
picks (it "currently uses low for generation"), so the tier is always sent
explicitly and a job without one is refused.

TERMS: the xAI terms (x.ai/legal/*) answered 403 to every automated read, so
nothing about resale, commercial use or end-user duties was verified. The
registry entries carry ``terms_gate: terms_review_required`` and stay unsellable
until a person has read them.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import List, Optional

from modules.capabilities.base import (
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_AUTH,
    E_NOT_FOUND,
    E_POLICY,
    E_UNAVAILABLE,
    FAILED,
    I2V,
    PENDING,
    SUCCEEDED,
    T2I,
    T2V,
    AdapterError,
    CapabilityRequest,
    HttpAdapter,
    Output,
    PollResult,
    ProviderTask,
    b64_output,
    dig,
    image_data_uri,
    is_url,
)
from modules.capabilities.safe_fetch import SafeResultMixin, sniff_image_mime, unconfirmed

#: Where a result may live. The docs show ``vidgen.x.ai``; any ``x.ai`` subdomain is the maker's.
RESULT_HOSTS = ("x.ai",)
#: In front of every policy / moderation refusal: xAI's pricing page says such a request is still
#: charged (a vendor claim; nothing here has verified it), so it is never presented as free.
CHARGED = ("xAI MAY STILL CHARGE for this refusal (its pricing page: a request deemed to violate the usage "
           "guidelines is still charged)")


def _refused(message: str, *, http_status=None, not_accepted: bool = False) -> AdapterError:
    return AdapterError(E_POLICY, f"{CHARGED}. {message}", http_status=http_status, not_accepted=not_accepted)


_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")
#: xAI's ``user``: "a unique identifier representing your end-user" (abuse monitoring).
_USER = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_POLICY_WORDS = ("moderation", "policy", "safety", "blocked", "guideline")
#: error.code of a failed video -> ours (docs.x.ai/developers/model-capabilities/video/generation).
_VIDEO_ERRORS = {
    "invalid_argument": E_BAD_REQUEST,        # incl. "content blocked by moderation": see _failed
    "failed_precondition": E_BAD_REQUEST,     # model / mode / resolution not available
    "permission_denied": E_AUTH,              # the key or team may not use this capability
    "service_unavailable": E_UNAVAILABLE,     # overloaded: retry, same task
    "internal_error": E_UNAVAILABLE,
}


class _GrokBase(SafeResultMixin, HttpAdapter):
    key_env = ("XAI_API_KEY",)
    base_url_env = "XAI_BASE_URL"
    default_base_url = "https://api.x.ai/v1"
    result_hosts = RESULT_HOSTS

    def _submit(self, url: str, body: dict, *, what: str = "submit") -> dict:
        """``submit_json`` plus the rule that a synchronous moderation refusal (HTTP 400 with policy
        words) carries the "may still be charged" warning like every other policy path."""
        try:
            return self.submit_json(url, body, what=what)
        except AdapterError as e:
            if e.code == E_POLICY and not e.message.startswith(CHARGED):
                raise _refused(e.message, http_status=e.http_status, not_accepted=e.not_accepted) from None
            raise

    def _user(self, request: CapabilityRequest) -> Optional[str]:
        return request.end_user if request.end_user and _USER.fullmatch(request.end_user) else None


class GrokVideoAdapter(_GrokBase):
    """Grok Imagine Video 1.5 and 1.5 Lite: text-to-video and image-to-video.

    The resolution and the duration are required and sent as given: the vendor's
    own defaults are 480p and 8 s, and the docs say "both duration and resolution
    affect the total cost", so a default would bill a size nobody quoted. In
    image-to-video the clip always matches the picture's shape ("``aspect_ratio``
    is ignored"), so a job that names a ratio for it is refused, not ignored.
    First/last-frame pins, keyframes, reference images/voices, editing and
    extension are not wired."""

    key = "video.xai"
    capabilities = (T2V, I2V)
    audio_capabilities = (T2V, I2V)          # ``generate_audio`` (default true on the vendor's side)
    resolution_capabilities = (T2V, I2V)     # always sent
    #: ``image`` accepts a URL or a base64 data URL of "JPEG, PNG, or WebP"; the models page caps image input at 20 MiB.
    MAX_IMAGE_BYTES = 15 * 1024 * 1024
    SPECS = {
        "grok-imagine-video-1.5": {"resolutions": ("480p", "720p", "1080p"), "durations": tuple(range(1, 16))},
        "grok-imagine-video-1.5-lite": {"resolutions": ("480p", "720p", "1080p"), "durations": tuple(range(1, 16))},
    }
    RATIOS = ("1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "5:2")

    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        spec = self.SPECS.get(vendor_model)
        if spec is None:
            return [f"{vendor_model!r} is not a Grok Imagine video model this adapter knows"]
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
                    out.append("Grok Imagine takes pictures of at most 15 MB")
            if request.aspect_ratio:
                out.append("image-to-video keeps the picture's own shape: an aspect ratio does not apply to i2v")
        elif request.input_images:
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
        body: dict = {"model": vendor_model, "duration": int(request.duration_s), "resolution": request.resolution}
        prompt = request.prompt.strip()
        if prompt:
            body["prompt"] = prompt
        if request.capability == I2V:
            ref = str(request.input_images[0])
            try:
                body["image"] = {"url": ref if is_url(ref) else image_data_uri(ref)}
            except OSError:
                raise AdapterError(E_BAD_REQUEST, "the picture could not be read", not_accepted=True) from None
        else:
            body["aspect_ratio"] = request.aspect_ratio or "16:9"
        if request.audio is not None:
            body["generate_audio"] = bool(request.audio)
        user = self._user(request)
        if user:
            body["user"] = user
        data = self._submit(f"{self.base_url}/videos/generations", body)
        rid = data.get("request_id") if isinstance(data, dict) else None
        if not isinstance(rid, str) or not _ID.fullmatch(rid):
            # The vendor answered 2xx: a job probably exists, and it bills.
            raise unconfirmed("the answer carries no usable request_id")
        return ProviderTask(self.key, vendor_model, rid)

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        rid = str(task.task_id or "")
        if not _ID.fullmatch(rid):
            raise AdapterError(E_NOT_FOUND, "task id has an unexpected shape")
        data = self.get(f"{self.base_url}/videos/{rid}")
        if not isinstance(data, dict):
            raise AdapterError(E_BAD_RESPONSE, "the status answer is not a JSON object")
        status = str(data.get("status") or "").lower()
        if status == "done":
            video = data.get("video") if isinstance(data.get("video"), dict) else {}
            if video.get("respect_moderation") is False:
                # "the field will be false and the video url field will be empty" - and the pricing page
                # says a generation deemed in violation of the usage guidelines is still charged.
                return PollResult(FAILED, error=_refused("xAI's moderation filtered the video (the link is empty)"))
            url = video.get("url")
            if not url:
                raise AdapterError(E_BAD_RESPONSE, "done without video.url")
            return self.checked_outputs(PollResult(SUCCEEDED, [Output("video/mp4", url=str(url))]))
        if status in ("failed", "expired"):
            if status == "expired":
                return PollResult(FAILED, error=AdapterError(E_UNAVAILABLE, "the request expired at xAI before it finished"))
            err = data.get("error") if isinstance(data.get("error"), dict) else {}
            text = self.message(err.get("message") or err.get("code") or "the vendor reported the job failed")
            code = _VIDEO_ERRORS.get(str(err.get("code") or ""), E_UNAVAILABLE)
            if code == E_BAD_REQUEST and any(w in text.lower() for w in _POLICY_WORDS):
                return PollResult(FAILED, error=_refused(text))   # invalid_argument also carries "blocked by moderation"
            return PollResult(FAILED, error=AdapterError(code, text))
        return PollResult(PENDING)


class GrokImageAdapter(_GrokBase):
    """Grok Imagine Image 2.0: text-to-image, one image per call.

    ``quality`` (``low`` | ``medium``) is always sent: ``auto`` "bills at the quality
    it is served at", and the docs only state the price of ``low``. The resolution
    is pinned to ``1k`` (the vendor default; ``2k`` is priced apart and not offered).
    Editing (``/v1/images/edits``) is not wired."""

    key = "image.xai"
    capabilities = (T2I,)
    quality_capabilities = (T2I,)
    timeout = 180
    SPECS = {"grok-imagine-image-2.0": {"sizes": {"1K": "1k"}, "qualities": ("low", "medium")}}
    RATIOS = ("1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "5:2")

    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        spec = self.SPECS.get(vendor_model)
        if spec is None:
            return [f"{vendor_model!r} is not a Grok Imagine image model this adapter knows"]
        out: List[str] = []
        if request.quality not in spec["qualities"]:
            out.append(f"quality {request.quality or '(none)'} is not offered by {vendor_model}: 'auto' bills whatever "
                       f"tier xAI picks, so a tier is always sent")
        if request.image_size is not None and request.image_size not in spec["sizes"]:
            out.append(f"image size {request.image_size} is not offered by {vendor_model} (only "
                       f"{', '.join(spec['sizes'])}): the price depends on it")
        if request.aspect_ratio is not None and request.aspect_ratio not in self.RATIOS:
            out.append(f"aspect ratio {request.aspect_ratio} is not offered by {vendor_model}")
        if request.capability != T2I or request.input_images:
            out.append("Grok Imagine here is text-to-image only")
        return out

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        out.extend(self._spec_problems(request, entry.vendor_model_for(request.capability)))
        return out

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        bad = self._spec_problems(request, vendor_model)
        if bad or not request.prompt.strip():
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad) or "prompt is empty", not_accepted=True)
        spec = self.SPECS[vendor_model]
        body: dict = {"model": vendor_model, "prompt": request.prompt.strip(), "n": 1, "quality": request.quality,
                      "resolution": spec["sizes"][request.image_size or next(iter(spec["sizes"]))],
                      "response_format": "b64_json"}
        if request.aspect_ratio:
            body["aspect_ratio"] = request.aspect_ratio      # left out = the vendor's "auto"
        user = self._user(request)
        if user:
            body["user"] = user
        data = self._submit(f"{self.base_url}/images/generations", body, what="generate")
        raw = dig(data, "data", 0, "b64_json") if isinstance(data, dict) else None
        if not isinstance(raw, str) or not raw:
            raise unconfirmed("the answer carries no image")
        try:
            out = b64_output(raw, "image/png")
        except AdapterError:
            raise unconfirmed("the image is not valid base64") from None
        mime = sniff_image_mime(out.data)
        if mime is None:
            raise unconfirmed("the image is not a PNG, JPEG or WebP file")
        out.mime = mime
        return ProviderTask(self.key, vendor_model, None, outputs=[out])


ADAPTERS = (GrokVideoAdapter, GrokImageAdapter)
