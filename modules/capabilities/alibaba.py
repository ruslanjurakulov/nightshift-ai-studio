"""Alibaba Cloud Model Studio (international / DashScope): HappyHorse 1.1 video and the
Qwen-Image / Z-Image pictures.

Sources, all on alibabacloud.com/help/en/model-studio and read 2026-10-25 (the pages as the
site serves them; the fields below are the ones those pages list, nothing is guessed):
``happyhorse-text-to-video-api-reference`` and ``happyhorse-image-to-video-api-reference``
(Last Updated Oct 12, 2026), ``qwen-image-generation-and-editing-api-reference`` (Oct 11,
2026), ``z-image-api-reference`` (Oct 11, 2026), ``model-pricing``, ``use-video-generation``.

* Video is asynchronous: ``POST /api/v1/services/aigc/video-generation/video-synthesis`` with
  ``X-DashScope-Async: enable`` answers ``output.task_id``; ``GET /api/v1/tasks/{task_id}`` answers
  ``output.task_status`` (PENDING | RUNNING | SUCCEEDED | FAILED | CANCELED | UNKNOWN) and, when
  SUCCEEDED, ``output.video_url`` (valid 24 h, as is the task id).
* Pictures are synchronous: ``POST /api/v1/services/aigc/multimodal-generation/generation`` answers
  ``output.choices[0].message.content[].image`` (a PNG link, valid 24 h; there is no base64 option).

The key and the host are the Wan adapter's (``WAN_API_KEY`` / ``DASHSCOPE_API_KEY``,
``WAN_WORKSPACE_ID``): one Model Studio key serves every model in the region, and Alibaba says a key,
a model and an endpoint must belong to the same region.

Settings the price depends on are never left to the vendor: the resolution and the duration of a
clip are required and sent as given (the vendor's own resolution default is 1080P, the dearest tier),
and Z-Image's ``prompt_extend`` (it doubles the price) is always sent, ``false``.

WATERMARK: the vendor's default for HappyHorse is ON (a "HappyHorse" mark, lower right). The adapter
sends ``watermark: false`` (``WATERMARK`` below), which is a vendor option the docs list. It is an
owner decision that has not been taken: Model Studio's Product Terms §4.48.1(h)(ii) make the customer
label outputs "if required under applicable laws", and removing the vendor's mark moves that duty onto
Nightshift's own disclosure (modules/ai_disclosure). Flip ``WATERMARK`` to restore the vendor's mark.

RESULT LINKS: Alibaba's own FAQ says the storage domain "may change dynamically" and publishes no
whitelist, and the Singapore bucket host is not shown on any page read (the examples are
``dashscope-result[-xx].oss-<region>.aliyuncs.com``, Beijing / Shanghai / Shenzhen / Hangzhou). A link
is therefore accepted only on ``aliyuncs.com`` AND on a ``dashscope-result*`` bucket; any other host
is refused (fail closed) and the refusal names the host it saw, so a person can read it off the first
real probe and widen ``RESULT_HOST_RE`` on purpose, never by accident.

BILLING: Alibaba's pricing page says failed requests are not billed. That is a vendor claim, not
verified here; nothing in this module tells a person a failed job was free.

TERMS: the Product Terms (Last Updated Sep 23, 2026) §4.48.1(d)(v) forbid reselling Model Studio or
its AI models "unless expressly authorised by us". The registry entries carry
``terms_gate: written_consent_required`` (unsellable) until Alibaba Cloud agrees in writing.
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional
from urllib.parse import urlsplit

from modules.capabilities.base import (
    E_AUTH,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_FOUND,
    E_POLICY,
    E_QUOTA,
    E_RATE_LIMITED,
    E_UNAVAILABLE,
    EDIT,
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
    dig,
    json_body,
)
from modules.capabilities.pictures import inline_picture
from modules.capabilities.safe_fetch import SafeResultMixin, after_completion, unconfirmed

#: Where a result may live: the maker's storage domain...
RESULT_HOSTS = ("aliyuncs.com",)
#: ...and, because that domain is shared with every Alibaba Cloud customer's bucket, only the
#: ``dashscope-result*`` buckets the docs show (see RESULT LINKS above).
#: Said after any task Alibaba reports as failed or cancelled. Its pricing page says failed requests are not billed; that is
#: its claim, not something this adapter has seen, so the message tells a person to look rather than that it was free.
SPEND_UNKNOWN = ("SPEND UNKNOWN: Alibaba's pricing page claims failed requests are not billed (a vendor claim, unverified "
                 "here); check the Model Studio usage page before assuming nothing was spent")
RESULT_HOST_RE = re.compile(r"dashscope-result[a-z0-9-]*\.oss-[a-z0-9-]+\.aliyuncs\.com")

#: A task id is a UUID: letters, digits, "-" and "_" only, so no "." (a ".." would walk the URL path up) and no ":".
_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
_WORKSPACE = re.compile(r"^[A-Za-z0-9-]{1,64}$")


class _DashScope(SafeResultMixin, HttpAdapter):
    """Key, host, error vocabulary and result vetting shared by every Model Studio adapter here."""

    key_env = ("WAN_API_KEY", "DASHSCOPE_API_KEY")
    base_url_env = "WAN_BASE_URL"
    default_base_url = "https://dashscope-intl.aliyuncs.com"
    result_hosts = RESULT_HOSTS
    #: DashScope's own error vocabulary (``code`` in the body), sharper than the HTTP status.
    _CODES = {"InvalidApiKey": E_AUTH, "Arrearage": E_QUOTA, "DataInspectionFailed": E_POLICY,
              "IPInfringementSuspect": E_POLICY, "InvalidParameter": E_BAD_REQUEST, "ModelNotFound": E_NOT_FOUND}

    def __init__(self, **kw):
        super().__init__(**kw)
        # The workspace host replaces the shared one (which Alibaba put in maintenance mode on
        # 2026-09-30) unless an https override was given: the same rule as the Wan adapter.
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

    def checked_url(self, url) -> str:
        url = super().checked_url(url)
        host = (urlsplit(url).hostname or "").lower()
        if not RESULT_HOST_RE.fullmatch(host):
            raise AdapterError(E_BAD_RESPONSE,
                               f"the result link is not on a DashScope result bucket ({host!r}); it was not downloaded. "
                               f"If this is Alibaba's real result host, read it from a probe and add it to RESULT_HOST_RE")
        return url

    def _body_error(self, data: dict) -> Optional[AdapterError]:
        """A 2xx whose body is DashScope's error shape (``code`` + ``message``, no ``output``)."""
        code = data.get("code")
        if code and "output" not in data:
            return AdapterError(self._map(code) or E_UNAVAILABLE, self.message(data.get("message") or code))
        return None

    @staticmethod
    def _picture(ref: str, *, max_bytes: int) -> str:
        """An https link as is, a local file as a data URI (both are accepted by these APIs), only if the file's first
        bytes are a PNG, JPEG or WEBP picture (modules/capabilities/pictures.py)."""
        return inline_picture(ref, max_bytes=max_bytes, who="Model Studio")


class HappyHorseVideoAdapter(_DashScope):
    """HappyHorse 1.1 text-to-video and first-frame image-to-video.

    Sent every time: ``resolution`` (``480P`` | ``720P`` | ``1080P``), ``duration`` (3-15 whole
    seconds), ``watermark`` (see the module note) and, for text-to-video, ``ratio``. A clip that
    names no resolution or duration is refused, because the vendor's defaults (1080P, 5 s) are
    priced differently from what the person was quoted. In image-to-video the clip keeps the
    picture's own shape ("preserving the input image's aspect ratio"), so a job that names a ratio
    for it is refused, not ignored. Audio is part of the model ("Features: Audio"); the docs list no
    switch for it, so none is sent. Reference-to-video (``-r2v``), the 1.0 models and video editing
    are not wired: their pages were not read."""

    key = "video.happyhorse"
    capabilities = (T2V, I2V)
    resolution_capabilities = (T2V, I2V)        # always sent
    #: See the module note: an owner decision, recorded here so it is one line to change.
    WATERMARK = False
    #: A picture goes inline as base64 when it is a local file; the docs cap a picture at 20 MB.
    MAX_IMAGE_BYTES = 15 * 1024 * 1024
    _RESOLUTIONS = ("480p", "720p", "1080p")
    _DURATIONS = tuple(range(3, 16))
    RATIOS = ("16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "5:4", "9:21", "21:9")
    SPECS = {
        "happyhorse-1.1-t2v": {"capability": T2V, "ratios": RATIOS},
        "happyhorse-1.1-i2v": {"capability": I2V, "ratios": ()},
    }

    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        spec = self.SPECS.get(vendor_model)
        if spec is None:
            return [f"{vendor_model!r} is not a HappyHorse 1.1 model this adapter knows"]
        out: List[str] = []
        if request.capability != spec["capability"]:
            out.append(f"{vendor_model} is the {spec['capability']} model; this request is {request.capability}")
        if request.resolution not in self._RESOLUTIONS:
            out.append(f"resolution {request.resolution or '(none)'} is not offered by {vendor_model}: the price "
                       f"depends on it, so it is never defaulted")
        if request.duration_s not in self._DURATIONS:
            out.append(f"duration {request.duration_s if request.duration_s is not None else '(none)'} s is not "
                       f"offered by {vendor_model} (3 to 15): the price is per second, so it is never defaulted")
        if request.negative_prompt:
            out.append("HappyHorse takes no negative prompt")
        if request.capability == T2V:
            if not request.prompt.strip():
                out.append("prompt is empty")
            if request.aspect_ratio is not None and request.aspect_ratio not in spec["ratios"]:
                out.append(f"aspect ratio {request.aspect_ratio} is not offered by {vendor_model}")
            if request.input_images:
                out.append("a picture does not apply to text-to-video")
        elif request.capability == I2V:
            if not request.input_images:
                out.append("i2v needs a first-frame picture")
            if request.aspect_ratio:
                out.append("image-to-video keeps the picture's own shape: an aspect ratio does not apply to i2v")
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
        inp: dict = {}
        if request.prompt.strip():
            inp["prompt"] = request.prompt.strip()
        if request.capability == I2V:
            inp["media"] = [{"type": "first_frame",
                             "url": self._picture(str(request.input_images[0]), max_bytes=self.MAX_IMAGE_BYTES)}]
        params: dict = {"resolution": request.resolution.upper(), "duration": int(request.duration_s),
                        "watermark": bool(self.WATERMARK)}
        if request.capability == T2V:
            params["ratio"] = request.aspect_ratio or "16:9"
        data = self.submit_json(f"{self.base_url}/api/v1/services/aigc/video-generation/video-synthesis",
                                {"model": vendor_model, "input": inp, "parameters": params},
                                headers={"X-DashScope-Async": "enable"})
        tid = dig(data, "output", "task_id")
        if not isinstance(tid, str) or not _ID.fullmatch(tid):
            # The vendor answered 2xx: a task probably exists, and it bills.
            raise unconfirmed("the answer carries no usable output.task_id")
        return ProviderTask(self.key, vendor_model, tid)

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        tid = str(task.task_id or "")
        if not _ID.fullmatch(tid):
            raise AdapterError(E_NOT_FOUND, "task id has an unexpected shape")
        data = self.get(f"{self.base_url}/api/v1/tasks/{tid}")
        data = data if isinstance(data, dict) else {}
        out = data.get("output") if isinstance(data.get("output"), dict) else {}
        status = str(out.get("task_status") or "").upper()
        if status == "SUCCEEDED":
            url = out.get("video_url")
            if not isinstance(url, str) or not url:
                # The vendor says the clip exists (and bills it): we just were not given the link.
                raise after_completion(AdapterError(E_BAD_RESPONSE, "succeeded without output.video_url"))
            return self.checked_outputs(PollResult(SUCCEEDED, [Output("video/mp4", url=url)]))
        if status in ("FAILED", "CANCELED"):
            code = self._map(out.get("code")) or E_UNAVAILABLE
            text = self.message(out.get("message") or out.get("code") or status.lower())
            return PollResult(FAILED, error=AdapterError(code, f"{text}. {SPEND_UNKNOWN}"))
        if status == "UNKNOWN":
            # "The task does not exist or its status is unknown" (ids are kept 24 h).
            return PollResult(FAILED, error=AdapterError(
                E_NOT_FOUND, "Alibaba no longer knows this task (ids last 24 hours); if it was started, check the "
                             "Model Studio usage page before rerunning"))
        err = self._body_error(data) if not out else None
        if err:
            raise err
        return PollResult(PENDING)


class DashScopeImageAdapter(_DashScope):
    """Qwen-Image 2.1 (Pro, Turbo) and Z-Image Turbo: text-to-image, and for Qwen picture editing.

    One image per call. Qwen's ``watermark`` is sent ``false`` (its default; see the module note);
    its ``prompt_extend`` is left to the vendor (default on, not priced apart). Z-Image's price
    doubles with ``prompt_extend`` (docs: "Enabling prompt_extend increases cost"), so it is always
    sent, ``false``. ``size`` is sent only when the job names an aspect ratio, from the table below;
    otherwise the vendor picks ("automatically recommends a resolution", Z-Image: 1024*1536), which
    neither product prices differently. Qwen's ``enable_thinking`` is left alone. The 3.0 series, the
    asynchronous API and the OpenAI-compatible endpoint are not wired."""

    key = "image.dashscope"
    capabilities = (T2I, EDIT)
    timeout = 180
    #: Pixel areas the docs allow are 512*512 to 2048*2048; these are inside them (Qwen: ~4 MP, the
    #: tiers its legacy page recommends; Z-Image: ~1 MP, the first group its page recommends).
    QWEN_SIZES = {"1:1": "2048*2048", "16:9": "2688*1536", "9:16": "1536*2688", "4:3": "2368*1728",
                  "3:4": "1728*2368"}
    ZIMAGE_SIZES = {"1:1": "1024*1024", "2:3": "832*1248", "3:2": "1248*832", "3:4": "864*1152", "4:3": "1152*864",
                    "9:16": "720*1280", "16:9": "1280*720", "9:21": "576*1344", "21:9": "1344*576"}
    #: The docs cap a picture at 10 MB; a local one goes inline as base64, which is a third larger.
    MAX_IMAGE_BYTES = 7 * 1024 * 1024
    SPECS = {
        "qwen-image-2.1-pro": {"kind": "qwen", "sizes": QWEN_SIZES, "max_refs": 10},
        "qwen-image-2.1-turbo": {"kind": "qwen", "sizes": QWEN_SIZES, "max_refs": 10},
        "z-image-turbo": {"kind": "zimage", "sizes": ZIMAGE_SIZES, "max_refs": 0},
    }
    WATERMARK = False

    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        spec = self.SPECS.get(vendor_model)
        if spec is None:
            return [f"{vendor_model!r} is not a Qwen-Image / Z-Image model this adapter knows"]
        out: List[str] = []
        if not request.prompt.strip():
            out.append("prompt is empty")
        if request.aspect_ratio is not None and request.aspect_ratio not in spec["sizes"]:
            out.append(f"aspect ratio {request.aspect_ratio} is not offered by {vendor_model}")
        if request.image_size is not None:
            out.append(f"{vendor_model} is priced per image whatever its size: an image size does not apply")
        if request.quality is not None:
            out.append(f"{vendor_model} has no quality tiers")
        if request.negative_prompt:
            out.append(f"{vendor_model} takes no negative prompt")
        if request.capability == T2I:
            if request.input_images:
                out.append("a picture does not apply to text-to-image")
        elif request.capability == EDIT:
            if spec["max_refs"] == 0:
                out.append(f"{vendor_model} is text-to-image only")
            elif not request.input_images:
                out.append("edit needs a picture")
            elif len(request.input_images) > spec["max_refs"]:
                out.append(f"{vendor_model} takes at most {spec['max_refs']} pictures")
        else:
            out.append(f"{request.capability} is not served here")
        return out

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        out.extend(self._spec_problems(request, entry.vendor_model_for(request.capability)))
        return out

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        bad = self._spec_problems(request, vendor_model)
        if bad:
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad), not_accepted=True)
        spec = self.SPECS[vendor_model]
        content: List[Dict[str, str]] = []
        if request.capability == EDIT:
            content += [{"image": self._picture(str(p), max_bytes=self.MAX_IMAGE_BYTES)} for p in request.input_images]
        content.append({"text": request.prompt.strip()})
        if spec["kind"] == "zimage":
            params: dict = {"prompt_extend": False}
        else:
            params = {"n": 1, "watermark": bool(self.WATERMARK)}
        if request.aspect_ratio:
            params["size"] = spec["sizes"][request.aspect_ratio]
        body = {"model": vendor_model, "input": {"messages": [{"role": "user", "content": content}]},
                "parameters": params}
        data = self.submit_json(f"{self.base_url}/api/v1/services/aigc/multimodal-generation/generation", body,
                                what="generate")
        if not isinstance(data, dict):
            raise unconfirmed("the answer is not a JSON object")
        err = self._body_error(data)
        if err:
            raise err
        parts = dig(data, "output", "choices", 0, "message", "content")
        url = next((c["image"] for c in (parts if isinstance(parts, list) else [])
                    if isinstance(c, dict) and isinstance(c.get("image"), str) and c["image"]), None)
        if url is None:
            raise unconfirmed("the answer carries no image")
        # The image exists (and bills) from here: a link we will not fetch carries the spend note.
        self.checked_outputs(PollResult(SUCCEEDED, [Output("image/png", url=url)]))
        return ProviderTask(self.key, vendor_model, None, outputs=[Output("image/png", url=url)])


ADAPTERS = (HappyHorseVideoAdapter, DashScopeImageAdapter)
