"""Recraft V4.1 and V4.1 Flash (the maker's own API): raster text-to-image.

Sources, all on recraft.ai and read 2026-10-25 (each docs page as markdown, append
``.md``): ``/docs/api-reference/{getting-started,models/overview,models/recraft-v4-1,
models/recraft-v4-1-flash,endpoints,image-inputs-and-results,error-handling,pricing,
appendix}`` and the Developer Terms (``/legal/developer-terms``, effective 2026-10-20).

* ``POST https://external.api.recraft.ai/v1/images/generations`` is synchronous and
  answers ``data[]`` with ``url`` (default, kept about 24 hours) or, with
  ``response_format: "b64_json"``, the bytes in ``b64_json``. Bytes are requested: the
  docs print the link as ``https://...`` and name no host, so no host can be put on
  an allow-list, and a link that expires cannot lose a paid image that was never
  a link. A ``url`` answer is therefore treated as unusable (and possibly billed),
  never fetched.
* Errors come back as plain text or JSON depending on the error ("request
  unauthorized" for a rejected token); the body is read as text and classified by
  status and words, never assumed to be JSON.
* ``credits`` in the answer is the number of API units charged ($1 = 1,000 units).

What is sent is exactly what is priced: the raster 1K model only (``recraftv4_1``,
``recraftv4_1_flash``). Vector (SVG) and the 2K "pro" variants are priced apart and
are not offered; ``n`` is 1. Style ids/references, controls, ``negative_prompt``
and the ``seed`` are not wired (V4.1 does not take ``negative_prompt`` at all).

TERMS: the Developer Terms bar serving an earlier output in place of a new call
(3.7), bar using the API to build a service that competes with Recraft (3.2(x)) and
license it non-sublicensably for applications that integrate it (3.1, 3.5). The
registry entries carry ``terms_gate: terms_review_required`` and stay unsellable
until a person has decided.
"""

from __future__ import annotations

from typing import List

from modules.capabilities.base import (
    E_BAD_REQUEST,
    T2I,
    AdapterError,
    CapabilityRequest,
    HttpAdapter,
    ProviderTask,
    b64_output,
    dig,
)
from modules.capabilities.safe_fetch import SafeResultMixin, sniff_image_mime, unconfirmed


def _utf16_len(text: str) -> int:
    return len((text or "").encode("utf-16-le")) // 2


class RecraftImageAdapter(SafeResultMixin, HttpAdapter):
    """Recraft V4.1 / V4.1 Flash: one 1K raster image per call, returned inline as PNG.

    The size is the aspect ratio (``size: "16:9"``) or, when the job names none, left
    out so Recraft picks it from the prompt: the price is per image whatever the
    ratio, so that is a composition choice, not a priced one. Every call is a fresh
    generation (Developer Terms 3.7): nothing here caches or replays an output."""

    key = "image.recraft"
    key_env = ("RECRAFT_API_TOKEN",)
    base_url_env = "RECRAFT_BASE_URL"
    default_base_url = "https://external.api.recraft.ai/v1"
    capabilities = (T2I,)
    timeout = 120
    #: Nothing is downloaded (``b64_json``): no host is allowed.
    result_hosts = ()
    MAX_PROMPT_UNITS = 10000
    SPECS = {"recraftv4_1": {"sizes": ("1K",)}, "recraftv4_1_flash": {"sizes": ("1K",)}}
    #: Ratios of the vendor's size table that are plain ``w:h`` (the 6:10 / 14:10 / 10:14 rows are left out).
    RATIOS = ("1:1", "2:1", "1:2", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16")

    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        spec = self.SPECS.get(vendor_model)
        if spec is None:
            return [f"{vendor_model!r} is not a Recraft model this adapter knows"]
        out: List[str] = []
        if request.image_size is not None and request.image_size not in spec["sizes"]:
            out.append(f"image size {request.image_size} is not offered by {vendor_model} (only "
                       f"{', '.join(spec['sizes'])}): the 2K variants are priced apart")
        if request.aspect_ratio is not None and request.aspect_ratio not in self.RATIOS:
            out.append(f"aspect ratio {request.aspect_ratio} is not offered by {vendor_model}")
        if not (request.prompt or "").strip():
            out.append("prompt is empty")
        elif _utf16_len(request.prompt.strip()) > self.MAX_PROMPT_UNITS:
            out.append(f"the prompt is longer than {self.MAX_PROMPT_UNITS} characters")
        if request.capability != T2I or request.input_images:
            out.append("Recraft here is text-to-image only")
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
        body: dict = {"model": vendor_model, "prompt": request.prompt.strip(), "n": 1,
                      "response_format": "b64_json", "image_format": "png"}
        if request.aspect_ratio:
            body["size"] = request.aspect_ratio          # left out = Recraft picks the shape from the prompt
        data = self.submit_json(f"{self.base_url}/images/generations", body, what="generate")
        raw = dig(data, "data", 0, "b64_json") if isinstance(data, dict) else None
        if not isinstance(raw, str):
            # 2xx but no picture (a link, an empty list, a body we cannot read): a generation probably ran and bills.
            raise unconfirmed("the answer carries no inline image")
        try:
            out = b64_output(raw, "image/png")
        except AdapterError:
            raise unconfirmed("the image is not valid base64") from None
        mime = sniff_image_mime(out.data)
        if mime is None:
            raise unconfirmed("the image is not a PNG, JPEG or WebP file")
        out.mime = mime
        return ProviderTask(self.key, vendor_model, None, outputs=[out])


ADAPTERS = (RecraftImageAdapter,)
