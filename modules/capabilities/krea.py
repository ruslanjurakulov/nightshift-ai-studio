"""Krea 3 (the maker's own API): text-to-image and picture editing.

Sources, all on krea.ai/docs and read 2026-10-25 (each page as markdown, append ``.md``):
``/developers/krea-3/overview``, ``/developers/job-lifecycle``, ``/developers/api-keys-and-billing``,
``/developers/tutorials/text-to-image`` (the job envelope); the pricing is the table on the Krea 3 page.

* ``POST /generate/image/krea/krea-3`` answers ``{"job_id"}``; ``GET /jobs/{job_id}`` answers ``status``
  (scheduled | processing | queued | backlogged | sampling | intermediate-complete | completed | failed |
  cancelled) and, when completed, ``result.urls[0]``; a failed job carries ``result.error``.
* Auth is ``Authorization: Bearer <token>`` on ``https://api.krea.ai``. The token belongs to a workspace
  and draws on its API balance (HTTP 402 when empty: the docs say the API balance is separate from the
  app's compute units, so a plan upgrade does not fix it).

What is sent, and why: ``thinking_mode`` is ALWAYS sent (``fast``, the docs' default): ``high`` costs
+$0.02 and ``ultra`` +$0.20 per generation, so the mode that was priced is the mode that runs, and
neither dearer mode is offered. ``resolution`` (``1K`` | ``2K``) is always sent explicitly: the job's
image size when it names one, else ``1K`` (the registry offers only 1K: the creative bridge passes no
image size and the quote prices the base unit, so 2K, $0.06 against $0.03, is supported here but not
sold). Omitted, Krea would pick 1K itself; the adapter says so instead of relying on it. ``aspect_ratio`` is optional (the docs: omit it for
automatic framing). Not sent: ``width``/``height`` (they cannot be combined with a resolution),
``priority``, ``seed``, ``loras`` / ``style_urls`` (a 422 on Krea 3), ``X-Api-Zero-Data-Retention``.

REGIONAL EDIT: ``regional_edit: true`` ("a local edit that keeps the rest of the image exact", needs at
least one picture) is sent by the entry whose vendor model is ``krea-3:regional``; ``krea-3`` never sends
it. ``:regional`` is OUR suffix, stripped before the wire: the vendor model name on the wire is ``krea-3``
in the URL, there is no model field. The ``regions`` bounding boxes are documented (coordinates 0 to 1,
up to 24, ``image_idx`` / ``x`` / ``y`` / ``width`` / ``height`` / ``label`` / ``note``) but are UNVERIFIED
here: nothing in this repository can draw one, the coordinate frame was not tested, and no request path
exists, so they are never sent.

REFERENCES: each reference picture adds to the price (+$0.02 per 1K reference, +$0.07 per 2K reference);
the docs do not say how a picture is classed 1K or 2K, so an edit is registered with at most ONE picture
and its price in the registry is only the base, flagged as such.

BILLING: the docs say failed and cancelled jobs are not billed. That is a vendor claim; nothing here
tells a person a failed job was free.

TERMS: only Krea's consumer Terms of Use were found ("non-sublicensable and non-transferable license ...
content generated", "participate in the transfer or sale of ... the Services themselves" barred); no
API or developer terms exist at any URL tried. The registry entries carry ``terms_gate:
terms_review_required`` and stay unsellable until a person has read Krea's written terms.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import List
from urllib.parse import urlsplit

from modules.capabilities.base import (
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_FOUND,
    E_POLICY,
    E_UNAVAILABLE,
    EDIT,
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
    dig,
    image_data_uri,
    is_url,
)
from modules.capabilities.safe_fetch import SafeResultMixin, after_completion, unconfirmed

#: Where a result may live. The docs show ``krea.ai/generations/...`` and ``gen.krea.ai``; any
#: ``krea.ai`` subdomain is the maker's. The host of a REAL result was not seen: a link anywhere else
#: is refused (fail closed) and the refusal names the host, so a person can read it off a probe.
RESULT_HOSTS = ("krea.ai",)

_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")
_POLICY_WORDS = ("moderat", "nsfw", "policy", "safety", "blocked", "prohibited")
_MIME_BY_SUFFIX = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
#: The docs name no size limit for a picture; this is OUR cap on a locally inlined one (base64 adds a third).
MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024


class KreaImageAdapter(SafeResultMixin, HttpAdapter):
    """Krea 3 text-to-image and edit, one image per job."""

    key = "image.krea"
    key_env = ("KREA_API_KEY",)
    base_url_env = "KREA_BASE_URL"
    default_base_url = "https://api.krea.ai"
    capabilities = (T2I, EDIT)
    result_hosts = RESULT_HOSTS
    timeout = 60
    ENDPOINT = "/generate/image/krea/krea-3"
    ASPECTS = ("1:1", "4:5", "3:4", "2:3", "9:16", "5:4", "4:3", "3:2", "16:9", "21:9")
    #: our model name -> (sends regional_edit, edit only)
    SPECS = {
        "krea-3": {"regional": False, "edit_only": False},
        "krea-3:regional": {"regional": True, "edit_only": True},
    }
    SIZES = ("1K", "2K")
    #: The size that is priced by the registry's base figure (the registry offers only this one today).
    BASE_SIZE = "1K"
    MAX_REFS = 1
    MAX_NEGATIVE_CHARS = 1024

    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        spec = self.SPECS.get(vendor_model)
        if spec is None:
            return [f"{vendor_model!r} is not a Krea 3 model this adapter knows"]
        out: List[str] = []
        if request.image_size is not None and request.image_size not in self.SIZES:
            out.append(f"image size {request.image_size} is not offered by {vendor_model} (1K or 2K): the price "
                       f"depends on it")
        if request.aspect_ratio is not None and request.aspect_ratio not in self.ASPECTS:
            out.append(f"aspect ratio {request.aspect_ratio} is not offered by {vendor_model}")
        if request.quality is not None:
            out.append(f"{vendor_model} has no quality tiers: its thinking mode is fixed (the others cost more)")
        if len(request.negative_prompt or "") > self.MAX_NEGATIVE_CHARS:
            out.append(f"the negative prompt is over {self.MAX_NEGATIVE_CHARS} characters")
        if not request.prompt.strip():
            out.append("prompt is empty")
        if request.capability == T2I:
            if spec["edit_only"]:
                out.append(f"{vendor_model} edits a picture: it needs one")
            if request.input_images:
                out.append("a picture does not apply to text-to-image")
        elif request.capability == EDIT:
            if not request.input_images:
                out.append("edit needs a picture")
            elif len(request.input_images) > self.MAX_REFS:
                out.append(f"{vendor_model} takes one picture here: every extra reference is priced apart")
        else:
            out.append(f"{request.capability} is not served here")
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
        # Always explicit, never the vendor's omitted-means-1K: a job carries no image size today (the bridge
        # passes none, and the quote prices the base unit, which is the 1K figure), so 1K is what was priced.
        body: dict = {"prompt": request.prompt.strip(), "thinking_mode": "fast",
                      "resolution": request.image_size or self.BASE_SIZE}
        if request.aspect_ratio:
            body["aspect_ratio"] = request.aspect_ratio
        if request.negative_prompt:
            body["negative_prompt"] = request.negative_prompt
        if request.capability == EDIT:
            body["image_urls"] = [self._picture(str(request.input_images[0]))]
            if spec["regional"]:
                body["regional_edit"] = True
        data = self.submit_json(f"{self.base_url}{self.ENDPOINT}", body)
        jid = data.get("job_id") if isinstance(data, dict) else None
        if not isinstance(jid, str) or not _ID.fullmatch(jid):
            # The vendor answered 2xx: a job probably exists, and it bills when it completes.
            raise unconfirmed("the answer carries no usable job_id")
        return ProviderTask(self.key, vendor_model, jid)

    def _error_text(self, result) -> str:
        err = result.get("error") if isinstance(result, dict) else None
        if isinstance(err, dict):
            err = err.get("message") or err.get("code") or err.get("error")
        return self.message(err or "the job failed")

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        jid = str(task.task_id or "")
        if not _ID.fullmatch(jid):
            raise AdapterError(E_NOT_FOUND, "job id has an unexpected shape")
        data = self.get(f"{self.base_url}/jobs/{jid}")
        data = data if isinstance(data, dict) else {}
        status = str(data.get("status") or "").lower()
        if status == "completed":
            urls = dig(data, "result", "urls")
            url = urls[0] if isinstance(urls, list) and urls else None
            if not isinstance(url, str) or not url:
                # The vendor says the picture exists (and bills it): we just were not given the link.
                raise after_completion(AdapterError(E_BAD_RESPONSE, "completed without result.urls[0]"))
            suffix = Path(urlsplit(url).path).suffix.lower()
            return self.checked_outputs(PollResult(SUCCEEDED, [Output(_MIME_BY_SUFFIX.get(suffix, "image/png"), url=url)]))
        if status in ("failed", "cancelled"):
            text = self._error_text(data.get("result"))
            code = E_POLICY if any(w in text.lower() for w in _POLICY_WORDS) else E_UNAVAILABLE
            if status == "cancelled":
                text = f"the job was cancelled at Krea ({text})" if text != "the job failed" else "the job was cancelled at Krea"
            return PollResult(FAILED, error=AdapterError(code, text))
        return PollResult(PENDING)


ADAPTERS = (KreaImageAdapter,)
