"""FLUX 3 Image and FLUX 3 Image Klein (Black Forest Labs' own API): text-to-image.

The older ``image.bfl`` (FLUX.2: ``POST /v1/{model}`` with ``width`` / ``height``) is
reused for the key, the ``x-key`` header, the base URL and the "the polling URL IS
the task id, and it must stay on bfl.ai" rule. It cannot serve FLUX 3 as it is: the
FLUX 3 endpoints "reject unknown fields with HTTP 422" (``width``, ``height``, ``seed``
do not exist there), take ``aspect_ratio`` + ``resolution`` instead, are priced by
that ``resolution``, and answer a failed task as HTTP 503 with a normal JSON body.

Sources, all on docs.bfl.ml and read 2026-10-25 (as markdown, append ``.md``):
``/api-reference/utility/generate-an-image-with-flux-3`` (OpenAPI), ``…-flux-3-klein``,
``/flux_3/flux3_image_generate``, ``/api_integration/{integration_guidelines,errors}``,
``/quick_start/pricing``; prices from the structured price list on bfl.ai/pricing;
terms from bfl.ai/legal/{developer-terms-of-service,flux-api-service-terms}.

* ``POST https://api.bfl.ai/v1/flux-3-image`` (or ``…/flux-3-image-klein``) answers
  ``{id, polling_url, cost, input_mp, output_mp}``; ``GET <polling_url>`` answers
  ``status`` ``Pending`` | ``Reasoning`` | ``Generating`` | ``Ready`` | ``Request Moderated``
  | ``Content Moderated`` | ``Error`` | ``Task not found``; ``Ready`` carries
  ``result.sample``, a signed link on ``delivery.<region>.bfl.ai`` that "expires after
  1 hour" (the integration guide says 10 minutes) and must not be sent the key.
* "A failed task can come back as HTTP 503 with a normal JSON body": the body's status
  is read before a 503 is treated as an outage.
* FLUX 3 Image has no output-format field and the docs do not say which format the
  link serves (their example saves it as ``.png``), so the file's own bytes decide
  (``image/*`` in ``safe_fetch``). Klein has ``output_format``; it is not sent.
* ``grounding`` (web and image search for the prompt) is ON by default on FLUX 3 Image.
  It is sent as ``false``: a customer's prompt is not sent to a search engine, and
  the pages say nothing about a price for it. Klein has no such field.

TERMS (Developer Terms of Service and FLUX API Service Terms, last revised 2026-08-04):
integration for end users inside our own application is the licence (API Terms 2(a)); a
hosted endpoint for third parties is barred (hence ``web_only``); BFL takes a perpetual,
sublicensable licence to every Input and Output "to train and improve" its models (2(b)).
The registry entries carry ``terms_gate: terms_review_required`` and stay unsellable
until a person has decided.
"""

from __future__ import annotations

import re
from typing import List

from modules.capabilities.base import (
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_FOUND,
    E_POLICY,
    E_UNAVAILABLE,
    FAILED,
    PENDING,
    SUCCEEDED,
    T2I,
    AdapterError,
    CapabilityRequest,
    Output,
    PollResult,
    ProviderTask,
    dig,
)
from modules.capabilities.image import FluxAdapter
from modules.capabilities.safe_fetch import ANY_IMAGE, SafeResultMixin, after_completion, checked_polling_url, unconfirmed

_USER = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
#: Said after any task BFL reports as failed or moderated: its pages are silent on whether that is billed.
BILLING_UNKNOWN = ("BFL does not say whether a failed or moderated task is billed; check its dashboard credits "
                   "before assuming nothing was spent")
_PENDING = ("Pending", "Reasoning", "Generating")
#: What a 503 body may say and still be read as the task's own verdict. "Task not found" is deliberately not here:
#: it counts as a verdict only with HTTP 200 or 404 (BFL's errors page); a 503 saying so is a gateway's word.
_FAILED_503 = ("Request Moderated", "Content Moderated", "Error")
_KNOWN = (*_PENDING, "Ready", "Request Moderated", "Content Moderated", "Error", "Task not found")


class Flux3ImageAdapter(SafeResultMixin, FluxAdapter):
    """FLUX 3 Image and FLUX 3 Image Klein: text-to-image, one image per call.

    ``resolution`` (the equal-area tier the price depends on) is always sent, from the
    job's image size; a job with none is refused, because the vendor's own default
    (``1k``) is a quote nobody made. Only ``1K`` and ``2K`` are offered: ``768sq`` and
    ``1.5k`` have no name in the registry's size list, and ``4k`` costs about 12 times
    ``1k``. The ratio is the job's, else ``auto`` (the prompt decides, else 1:1).
    Editing and reference images (up to ten) are not wired."""

    key = "image.bfl3"
    capabilities = (T2I,)
    timeout = 120
    result_hosts = ("bfl.ai",)
    #: Where the polling link (the task id) must live: the key is sent to it. Tests point it at a loopback server.
    polling_domain = "bfl.ai"
    polling_ports = (None, 443)
    RATIOS = ("21:9", "2:1", "16:9", "3:2", "7:5", "4:3", "5:4", "1:1", "4:5", "3:4", "5:7", "2:3", "9:16", "1:2", "9:21")
    MAX_PROMPT_UNITS = 4000
    SPECS = {
        "flux-3-image": {"sizes": {"1K": "1k", "2K": "2k"}, "grounding": True},
        "flux-3-image-klein": {"sizes": {"1K": "1k", "2K": "2k"}, "grounding": False},
    }

    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        spec = self.SPECS.get(vendor_model)
        if spec is None:
            return [f"{vendor_model!r} is not a FLUX 3 image model this adapter knows"]
        out: List[str] = []
        if request.image_size not in spec["sizes"]:
            out.append(f"image size {request.image_size or '(none)'} is not offered by {vendor_model} (only "
                       f"{', '.join(spec['sizes'])}): the price depends on it, so it is never defaulted")
        if request.aspect_ratio is not None and request.aspect_ratio not in self.RATIOS:
            out.append(f"aspect ratio {request.aspect_ratio} is not offered by {vendor_model}")
        if not (request.prompt or "").strip():
            out.append("prompt is empty")
        elif len((request.prompt.strip()).encode("utf-16-le")) // 2 > self.MAX_PROMPT_UNITS:
            out.append(f"the prompt is longer than {self.MAX_PROMPT_UNITS} characters")
        if request.capability != T2I or request.input_images:
            out.append("FLUX 3 here is text-to-image only")
        return out

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        out.extend(p for p in self._spec_problems(request, entry.vendor_model_for(request.capability)) if p not in out)
        return out

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        bad = self._spec_problems(request, vendor_model)
        if bad:
            # Nothing has been sent: this is a refusal, not a lost answer.
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad), not_accepted=True)
        spec = self.SPECS[vendor_model]
        body: dict = {"prompt": request.prompt.strip(), "resolution": spec["sizes"][request.image_size],
                      "aspect_ratio": request.aspect_ratio or "auto"}
        if spec["grounding"]:
            body["grounding"] = False
        if request.end_user and _USER.fullmatch(request.end_user):
            body["user"] = request.end_user
        data = self.submit_json(f"{self.base_url}/{vendor_model}", body, what="generate")
        poll = data.get("polling_url") if isinstance(data, dict) else None
        try:
            checked_polling_url(poll, self.polling_domain, self.polling_ports)
        except (AdapterError, TypeError):
            # The vendor answered 2xx: a task probably exists, and it bills; the key was not sent to the link.
            raise unconfirmed("the answer carries no polling_url on bfl.ai") from None
        # The polling URL is the task id: it names the regional cluster that holds the job.
        return ProviderTask(self.key, vendor_model, poll)

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        url = str(task.task_id or "")
        try:
            checked_polling_url(url, self.polling_domain, self.polling_ports)
        except AdapterError:
            # The task id comes back from a job row; the key must never follow it to a host that is not BFL's.
            # The task was accepted once, so it may have run and been billed.
            raise after_completion(AdapterError(E_NOT_FOUND, "task id is not a bfl.ai polling URL")) from None
        resp = self.get(url, raw=True, ok_statuses=(404, 503))
        try:
            data = resp.json()
        except ValueError:
            data = None
        status = str(data.get("status") or "") if isinstance(data, dict) else ""
        code = getattr(resp, "status_code", 200)
        if code == 503 and status not in _FAILED_503:
            # Only a FAILED task may come back as 503 with a body; a 503 that says "Ready", "Pending" or "Task not
            # found" is an outage (a gateway can say anything), so the same task is polled again.
            raise AdapterError(E_UNAVAILABLE, "poll: HTTP 503", http_status=503)
        if code == 404 and status != "Task not found":
            raise AdapterError(E_NOT_FOUND, "poll: HTTP 404", http_status=404)
        if status == "Task not found" and code not in (200, 404):
            raise AdapterError(E_BAD_RESPONSE, f"poll: HTTP {code} with Task not found")
        if not isinstance(data, dict) or status not in _KNOWN:
            raise AdapterError(E_BAD_RESPONSE, f"the status answer has a status this adapter does not know "
                                               f"({self.message(status)!r})")
        if status in _PENDING:
            return PollResult(PENDING)
        if status == "Ready":
            sample = dig(data, "result", "sample")
            if not isinstance(sample, str) or not sample:
                # BFL said Ready: the image exists and may be billed.
                raise after_completion(AdapterError(E_BAD_RESPONSE, "Ready without result.sample"))
            return self.checked_outputs(PollResult(SUCCEEDED, [Output(ANY_IMAGE, url=sample)]))
        if status == "Request Moderated":
            return PollResult(FAILED, error=AdapterError(
                E_POLICY, f"BFL refused the prompt before generating (Request Moderated); retrying it unchanged "
                          f"fails again. {BILLING_UNKNOWN}"))
        if status == "Content Moderated":
            return PollResult(FAILED, error=AdapterError(
                E_POLICY, f"BFL generated the image and then withheld it (Content Moderated); adjust the prompt and "
                          f"resubmit. {BILLING_UNKNOWN}"))
        if status == "Task not found":
            return PollResult(FAILED, error=AdapterError(
                E_NOT_FOUND, f"BFL does not know this task (Task not found: an unknown or expired id). "
                             f"{BILLING_UNKNOWN}"))
        return PollResult(FAILED, error=AdapterError(E_UNAVAILABLE, f"BFL reported the task failed (Error). {BILLING_UNKNOWN}"))


ADAPTERS = (Flux3ImageAdapter,)
