"""Luma Uni-1 and Uni-1 Max (the Luma Agents API): text-to-image.

Sources, all on docs.agents.lumalabs.ai and read 2026-10-25: ``guides/images/generation`` (the parameter
reference and validation rules), ``guides/models`` (output specification), ``guides/pricing`` and
``guides/error-handling`` (the failure codes). It is the same envelope the Ray video adapter uses
(modules/capabilities/video.py ``LumaAdapter``): ``POST /v1/generations`` answers 201 with an ``id``;
``GET /v1/generations/{id}`` answers ``state`` (queued | processing | completed | failed), a completed
generation carries ``output[].url`` (a presigned link that expires after 1 hour) and a failed one
``failure_code`` / ``failure_reason``.

What is sent: ``model`` (``uni-1`` | ``uni-1-max``), ``type: "image"``, ``prompt`` (1 to 6,000
characters) and ``output_format: "png"`` (omitted, the model picks png or jpeg by the prompt, and the
stored file's type must be known). ``aspect_ratio`` only when the job names one (omitted, the model picks
a ratio from the prompt: the docs say so, and the price does not depend on it). Every output is 2K, and
the price is one figure per image, so nothing else is priced: ``style`` (``auto``) and ``web_search``
(false) are left to their defaults and the docs list no surcharge for either. Not wired: ``image_edit``,
``image_ref`` (each extra reference adds $0.003), the Files API.

RESULT LINKS: the docs show a presigned link on ``storage.example.com`` (a placeholder) and name no real
host. ``RESULT_HOSTS`` is therefore EMPTY: a link is refused (fail closed), the refusal names the host
it saw and carries the ``SPEND MAY HAVE OCCURRED`` note, and the first real probe fails with that host in
its message. A person reads it, checks it is Luma's, and puts it in ``RESULT_HOSTS`` on purpose.

BILLING: Luma's pricing page says synchronous errors are never charged and lists, per ``failure_code``,
which asynchronous failures are refunded (``content_moderated``, ``generation_failed``,
``output_not_found``) and that ``budget_exhausted`` may be charged in part. Those are Luma's statements,
unverified here; a failure's message says nothing about whether it was billed.

TERMS: the registry entries carry ``terms_gate: written_consent_required`` like Ray 3.2. Luma's general
Terms of Service (Last updated May 14, 2026, lumalabs.ai/legal/tos) 3.4(b) bar a service bureau but
expressly allow an API Customer "to provide API Users with access to the Services"; that text says API
customers are governed by "API Terms of Use", which were not found at any URL tried. The gate stays until
a person has read them.
"""

from __future__ import annotations

import re
from typing import List

from modules.capabilities.base import (
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_FOUND,
    E_POLICY,
    E_QUOTA,
    E_RATE_LIMITED,
    E_UNAVAILABLE,
    FAILED,
    PENDING,
    SUCCEEDED,
    T2I,
    AdapterError,
    CapabilityRequest,
    HttpAdapter,
    Output,
    PollResult,
    ProviderTask,
)
from modules.capabilities.safe_fetch import SafeResultMixin, after_completion, unconfirmed

#: See RESULT LINKS above: nothing is known, so nothing is allowed.
RESULT_HOSTS: tuple = ()

_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
#: Said after any generation Luma reports as failed. Luma's pricing page lists which failures it refunds; that is its
#: statement, not something this adapter has seen, so the message tells a person to look.
SPEND_UNKNOWN = ("SPEND UNKNOWN: Luma lists which failed generations it refunds (its statement, unverified here); "
                 "check its usage page before assuming nothing was spent")
_FAILURES = {"content_moderated": E_POLICY, "budget_exhausted": E_QUOTA, "rate_limited": E_RATE_LIMITED,
             "invalid_request": E_BAD_REQUEST, "image_too_large": E_BAD_REQUEST, "unsupported_format": E_BAD_REQUEST,
             "corrupt_input": E_BAD_REQUEST, "output_not_found": E_UNAVAILABLE, "generation_failed": E_UNAVAILABLE}


class LumaImageAdapter(SafeResultMixin, HttpAdapter):
    """Uni-1 and Uni-1 Max text-to-image, one image per generation, always 2K."""

    key = "image.luma"
    key_env = ("LUMA_AGENTS_API_KEY",)
    base_url_env = "LUMA_AGENTS_BASE_URL"
    default_base_url = "https://agents.lumalabs.ai/v1"
    capabilities = (T2I,)
    result_hosts = RESULT_HOSTS
    timeout = 60
    MODELS = ("uni-1", "uni-1-max")
    #: The nine shapes the image API takes (docs: "uni-1 / uni-1-max accept nine ratios").
    ASPECTS = ("3:1", "2:1", "16:9", "3:2", "1:1", "2:3", "9:16", "1:2", "1:3")
    MAX_PROMPT = 6000

    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        out: List[str] = []
        if vendor_model not in self.MODELS:
            out.append(f"{vendor_model!r} is not a Luma image model this adapter knows")
        if request.capability != T2I or request.input_images:
            out.append("Luma Uni-1 here is text-to-image only")
        if request.aspect_ratio is not None and request.aspect_ratio not in self.ASPECTS:
            out.append(f"aspect ratio {request.aspect_ratio} is not offered by {vendor_model}")
        if request.image_size not in (None, "2K"):
            out.append(f"image size {request.image_size} is not offered by {vendor_model}: every output is 2K")
        if request.quality is not None:
            out.append(f"{vendor_model} has no quality tiers")
        if request.negative_prompt:
            out.append("Luma Uni-1 takes no negative prompt")
        prompt = request.prompt.strip()
        if not prompt:
            out.append("prompt is empty")
        elif len(prompt) > self.MAX_PROMPT:
            out.append(f"the prompt is over {self.MAX_PROMPT} characters")
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
        body: dict = {"model": vendor_model, "type": "image", "prompt": request.prompt.strip(), "output_format": "png"}
        if request.aspect_ratio:
            body["aspect_ratio"] = request.aspect_ratio
        data = self.submit_json(f"{self.base_url}/generations", body)
        gid = data.get("id") if isinstance(data, dict) else None
        if not isinstance(gid, str) or not _ID.fullmatch(gid):
            # The vendor answered 2xx: a generation probably exists, and it bills.
            raise unconfirmed("the answer carries no usable generation id")
        return ProviderTask(self.key, vendor_model, gid)

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        gid = str(task.task_id or "")
        if not _ID.fullmatch(gid):
            raise AdapterError(E_NOT_FOUND, "generation id has an unexpected shape")
        data = self.get(f"{self.base_url}/generations/{gid}")
        data = data if isinstance(data, dict) else {}
        state = str(data.get("state") or "").lower()
        if state == "completed":
            out = data.get("output")
            url = next((o["url"] for o in (out if isinstance(out, list) else [])
                        if isinstance(o, dict) and isinstance(o.get("url"), str) and o["url"]), None)
            if url is None:
                # The vendor says the picture exists (and bills it): we just were not given the link.
                raise after_completion(AdapterError(E_BAD_RESPONSE, "completed without output[].url"))
            return self.checked_outputs(PollResult(SUCCEEDED, [Output("image/png", url=url)]))
        if state == "failed":
            code = _FAILURES.get(str(data.get("failure_code") or ""), E_UNAVAILABLE)
            text = self.message(data.get("failure_reason") or data.get("failure_code") or "the generation failed")
            return PollResult(FAILED, error=AdapterError(code, f"{text}. {SPEND_UNKNOWN}"))
        return PollResult(PENDING)


ADAPTERS = (LumaImageAdapter,)
