"""Meta Model API, Muse Image (the maker's own API): one image adapter, DARK.

Sources, all on dev.meta.ai and read 2026-11-12 as markdown (append ``.md``): ``/docs/image-generation``,
``/docs/api-reference/responses/schemas``, ``/docs/api-reference/images/schemas``, ``/docs/error-handling``,
``/docs/pricing-rate-limits``, ``/docs/models``, ``/docs/authentication``; the legal pages ``/legal/terms-of-service``,
``/legal/acceptable-use-policy`` and ``/legal/geographic-use-policy`` (docs/research/meta-muse-image-first-party.md).
Nothing here was called: there is no key yet.

Why the Responses API (``POST /v1/responses``) and not the OpenAI-compatible ``/v1/images/*`` endpoints: the request
must carry ``store: false``, so Meta keeps no response, and ``store`` is a Responses field only. The images endpoints
list no ``store`` and answer an unknown top-level field with HTTP 400 ("Unknown JSON parameters"), so it cannot be sent
there.

The request is the smallest one the image-generation guide shows working, and nothing more:

* ``model``, ``store: false``, and ``input``: the prompt as a plain string, or, with pictures, one ``user`` message
  whose ``content`` is an ``input_text`` part followed by ``input_image`` parts (base64 data URLs);
* ``tools: [{"type": "image_generation", "size": "WxH"}]`` only when the job names an aspect ratio ("``size`` sets
  the aspect ratio, not the exact pixel size"; "aspect ratios beyond 16:1 return 400"). Left out, it is the vendor's
  default shape. ``output_format`` is not sent: the vendor's default (webp) is kept, and the bytes decide the type.
  The first real probe (2026-11-12) was answered HTTP 400 ``Unsupported tool type: 'image_generation'`` with
  ``param: "tools"``: that answer is ``vendor_tool_unsupported`` (``TOOL_REFUSED``), never retried without the tool,
  because the picture would come back in a shape the person did not ask for. Until a probe proves the tool, the registry
  entry lists no aspect ratios, so the Studio offers and sends none and the registry refuses one before any call;
  ``SPECS`` keeps the documented shapes for the day the tool is accepted;
* ``safety_identifier``: the job's opaque end-user id, when it is a plain token of at most 64 characters.

The answer is read from ``output[]``: every ``image_generation_call`` item carries its picture as base64 in
``result``. ``reasoning`` and ``message`` items are ignored. Each picture is stored exactly as decoded, so whatever
provenance Meta put in it is kept (the docs do not say whether there is a watermark or C2PA; nothing is stripped
either way: docs/AI_DISCLOSURE.md, tests/test_vendor_watermarks.py).

NOT wired: multi-turn refinement (replaying an ``image_generation_call`` with ``store: false``; the job model has no
conversation), ``previous_response_id`` (needs ``store: true``), the Files API, ``reasoning_strength``,
``tool_enablement`` / the per-tool switches, ``n``, streaming, background mode, and an explicit ``output_format``.

Obligations this adapter carries (Model API ToS, AUP, Geographic Use Policy):

* NO VENDOR NAME OR MARK leaves this module. ToS 7: "neither we nor you may use any name or mark owned by or associated
  with the other". Every message an error can carry has the maker's names replaced (``_debrand``), because a job's
  error reaches the person who started it. The registry entry has a neutral id and display name.
* Real people: the AUP bars generating "the... likeness of a real, identifiable person without their consent". A prompt
  that reads as a real or famous person, a deepfake or a child is refused before any call, with the same keyword
  screen Character Studio uses (``modules.character_swap.PROMPT_PATTERNS``, migration 0137). It is keyword-weak by
  design; the pictures themselves are not screened.
* Geography: the Geographic Use Policy (https://dev.meta.ai/legal/geographic-use-policy, "Last updated: November 9,
  2026", read 2026-11-12) bars every Restricted Territory (3) for all models. Its model-specific list (2.2) no longer
  names Muse Image (only Muse Wonder and Muse Wonder Full, in South Korea); the 2026-10-12 version barred it in India.
  The registry row's ``blocked_countries`` lists those territories, and the web routes refuse them by requester country
  (docs/GEO_BLOCK.md, #695). The database does not know the country yet, so 0142 keeps a row with that list off sale and the
  entry stays hidden until it does (docs/research/meta-muse-image-first-party.md). Nothing in this adapter checks the country.
"""

from __future__ import annotations

import base64
import logging
import math
import os
import re
import stat
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
    E_VENDOR_TOOL_UNSUPPORTED,
    EDIT,
    T2I,
    AdapterError,
    CapabilityRequest,
    HttpAdapter,
    Output,
    ProviderTask,
    is_url,
    json_body,
)
from modules.capabilities.safe_fetch import UNCONFIRMED, SafeResultMixin, after_completion, sniff_image_mime, unconfirmed
from modules.character_swap import PROMPT_PATTERNS, normalize

logger = logging.getLogger(__name__)

#: Mentions of the maker that must not reach a person (ToS 7). Case-insensitive, whole words, with the forms the vendor's
#: own text uses: "Meta", "Meta's" / "Meta’s", "Meta AI" / "Meta-AI" / "MetaAI", "Muse Image" / "muse-image-1.0" / "MuseImage".
_VENDOR_WORDS = re.compile(r"(?i)\b(?:meta(?:[ -]?ai)?|muse(?:[ -]?image)?(?:-1\.0)?|llama)(?:['’]s)?\b")
#: The real-person / deepfake / child screen of Character Studio (0137), the same list in the same order.
_REAL_PERSON = tuple(re.compile(p, re.IGNORECASE) for p in PROMPT_PATTERNS)
#: ``safety_identifier``: "a string that uniquely identifies each user, up to 64 characters".
_USER = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_RATIO = re.compile(r"^([1-9][0-9]?):([1-9][0-9]?)$")
#: "aspect ratios beyond 16:1 return 400 (param: size)".
MAX_RATIO = 16
#: The long side of the ``size`` we send. The value sets the shape only ("the image is produced at the generator's own
#: resolution"), so this number is never a promise about pixels; the docs' own examples are 1024-1792 px.
SIZE_LONG_SIDE = 1024
_PICTURE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")
#: An ``input_image`` data URL may be 20,971,520 characters (Responses schema, ``image_url`` maxLength): 15 MiB of
#: bytes is 20 MiB of base64 with room for the ``data:`` prefix.
MAX_IMAGE_BYTES = 15 * 1024 * 1024
#: "inlining a file larger than the size limit (up to... 50 MB inline)" returns 400: OUR bound on all pictures together,
#: so their base64 stays under it.
MAX_TOTAL_IMAGE_BYTES = 36 * 1024 * 1024
_FAILED = ("failed", "cancelled", "incomplete")
_POLICY_CODES = ("content_policy_violation", "image_content_policy_violation")
#: What a person reads when the vendor refuses the ``image_generation`` tool (a 400 naming ``param: "tools"``). A refused
#: request makes no picture, and the vendor's pricing page bills generated pictures only. It names no remedy: the registry
#: entry offers no aspect ratio while the tool is refused (so the Studio sends none), and nothing else can be changed here.
TOOL_REFUSED = ("the vendor refused the size / aspect ratio option for this model, so no picture was made and nothing "
                "was charged")


def _debrand(text: str) -> str:
    """``text`` with every mention of the maker replaced: an error message is shown to the person who ran the job."""
    return _VENDOR_WORDS.sub("the vendor", str(text or ""))


def _plain(e: AdapterError) -> AdapterError:
    return AdapterError(e.code, _debrand(e.message), http_status=e.http_status, not_accepted=e.not_accepted)


def ratio_size(aspect_ratio: str) -> Optional[str]:
    """``"16:9"`` -> ``"1024x576"``: the exact ratio, scaled so its long side is at least ``SIZE_LONG_SIDE``. None for a
    ratio the vendor refuses (beyond 16:1 either way) or a value that is not ``W:H``."""
    m = _RATIO.fullmatch(str(aspect_ratio or ""))
    if not m:
        return None
    w, h = int(m.group(1)), int(m.group(2))
    if max(w, h) > MAX_RATIO * min(w, h):
        return None
    k = math.ceil(SIZE_LONG_SIDE / max(w, h))
    return f"{w * k}x{h * k}"


def real_person_problem(prompt: str) -> bool:
    """True when the words read as a real, identifiable or famous person, a deepfake or a child (0137's screen)."""
    norm = normalize(prompt)
    return any(p.search(norm) for p in _REAL_PERSON)


def _sniff_file(path: Path) -> Optional[str]:
    try:
        with open(path, "rb") as fh:
            return sniff_image_mime(fh.read(16))
    except OSError:
        return None


def _not_regular(path: Path) -> bool:
    """True when ``path`` exists but is not a plain file: a symlink (to a device such as /dev/zero, or anywhere else), a FIFO,
    a socket, a device or a folder. ``lstat`` so a link is judged as the link, never as what it points at."""
    try:
        return not stat.S_ISREG(os.lstat(path).st_mode)
    except FileNotFoundError:
        return False
    except OSError:
        return True


def _read_picture(ref: str) -> bytes:
    """The bytes of a library picture, at most ``MAX_IMAGE_BYTES``. Refused (nothing sent) unless the path itself is a regular
    file: ``lstat`` first, then ONE descriptor opened with ``O_NOFOLLOW`` (a link swapped in after the check is not followed) and
    ``O_NONBLOCK`` (a FIFO cannot block the open), ``fstat`` on that descriptor, and a read capped at the limit + 1 so a file
    that grew after the check is still stopped."""
    too_big = AdapterError(E_BAD_REQUEST, "a picture is over 15 MB; it was not sent", not_accepted=True)
    not_file = AdapterError(E_BAD_REQUEST, "a picture is not a regular file; it was not sent", not_accepted=True)
    fd = None
    try:
        if not stat.S_ISREG(os.lstat(ref).st_mode):
            raise not_file
        fd = os.open(ref, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
                     | getattr(os, "O_CLOEXEC", 0))
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise not_file
        if info.st_size > MAX_IMAGE_BYTES:
            raise too_big
        with os.fdopen(fd, "rb") as fh:
            fd = None
            data = fh.read(MAX_IMAGE_BYTES + 1)
    except OSError:
        raise AdapterError(E_BAD_REQUEST, "the picture could not be read", not_accepted=True) from None
    finally:
        if fd is not None:
            os.close(fd)
    if len(data) > MAX_IMAGE_BYTES:
        raise too_big
    return data


def _picture_part(ref: str) -> dict:
    """A library picture as an ``input_image`` part, labelled with the type its BYTES say (the suffix is not trusted)."""
    data = _read_picture(ref)
    mime = sniff_image_mime(data[:16])
    if mime is None:
        raise AdapterError(E_BAD_REQUEST, "the file is not a PNG, JPEG or WebP picture (its bytes say otherwise); "
                                          "it was not sent", not_accepted=True)
    return {"type": "input_image", "image_url": f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"}


class MuseImageAdapter(SafeResultMixin, HttpAdapter):
    """Text-to-image and edit / compose with 1-10 pictures, on ``POST /v1/responses`` with ``store: false``.

    Billing claims (dev.meta.ai/docs/pricing-rate-limits; a vendor claim, unverified here): a flat price per generated
    image, built-in search included; "images that fail to generate, or that are removed by safety filtering before
    they're returned, aren't counted"; a request that returns several images is billed for each. Every picture the
    answer carries is therefore handed back, never only the first. 150 requests per minute per team."""

    key = "image.meta"
    key_env = ("META_API_KEY",)
    base_url_env = "META_BASE_URL"
    default_base_url = "https://api.meta.ai/v1"
    capabilities = (T2I, EDIT)
    #: "You can pass multiple reference images in a single turn": a style kit's pictures ride as more ``input_image``
    #: parts, up to the entry's ``image_refs_max``.
    reference_capabilities = (T2I, EDIT)
    #: The picture comes back inline: nothing is ever downloaded.
    result_hosts: Tuple[str, ...] = ()
    timeout = 300                     # "agentic": it may search and refine over several passes before it renders
    #: An edit takes "1-10 items" on the images endpoint; the Responses pages state no number, so the same bound is
    #: kept here (docs/research/meta-muse-image-first-party.md, open question).
    MAX_IMAGES = 10
    SPECS = {"muse-image-1.0": {"ratios": ("1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "9:21",
                                           "4:5", "5:4")}}

    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        spec = self.SPECS.get(vendor_model)
        if spec is None:
            return [f"{vendor_model!r} is not a model this adapter knows"]
        out: List[str] = []
        if request.capability not in self.capabilities:
            out.append(f"this adapter cannot do {request.capability}")
        if request.aspect_ratio is not None:
            if ratio_size(request.aspect_ratio) is None:
                out.append(f"aspect ratio {request.aspect_ratio} is refused: at most {MAX_RATIO}:1 either way")
            elif request.aspect_ratio not in spec["ratios"]:
                out.append(f"aspect ratio {request.aspect_ratio} is not offered by this model")
        if request.image_size is not None:
            # The vendor renders at "its own resolution" and does not say which: no size can be promised or priced.
            out.append("an image size does not apply: the vendor renders at its own resolution, which it does not state")
        if request.negative_prompt:
            out.append("this model does not take a negative prompt (say what to avoid in the prompt)")
        if request.capability == EDIT and not request.input_images:
            out.append("an edit needs at least one picture")
        if len(request.input_images) > self.MAX_IMAGES:
            out.append(f"this model takes at most {self.MAX_IMAGES} pictures")
        total = 0
        for ref in request.input_images:
            ref = str(ref)
            path = Path(ref)
            if is_url(ref):
                # The vendor would fetch the address itself: only files the worker copied from the library are sent.
                out.append("pictures must be files from the library, not https URLs")
                break
            if path.suffix.lower() not in _PICTURE_SUFFIXES:
                out.append("this model reads PNG, JPEG or WebP pictures")
                break
            if _not_regular(path):
                out.append("a picture is not a regular file (a link, a device or a pipe); nothing was sent")
                break
            if path.is_file():
                size = path.stat().st_size
                total += size
                if size > MAX_IMAGE_BYTES:
                    out.append("a picture is over 15 MB")
                    break
                if _sniff_file(path) is None:
                    out.append("a file is not a PNG, JPEG or WebP picture (its bytes say otherwise); nothing was sent")
                    break
        if total > MAX_TOTAL_IMAGE_BYTES:
            out.append("the pictures are over 36 MB together")
        return out

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        out.extend(self._spec_problems(request, entry.vendor_model_for(request.capability)))
        if request.prompt.strip() and real_person_problem(request.prompt):
            out.append("the prompt reads as a real or famous person, a deepfake or a child, which this model may not make")
        return out

    def vendor_error_code(self, status: int, text: str) -> Optional[str]:
        """The documented error envelope (``error.type`` / ``error.code``, docs/error-handling) where it is sharper
        than the status: a content-safety block is a 400 with ``content_policy_violation``; ``invalid_api_key``,
        ``billing_error``, ``rate_limit_exceeded`` and ``model_not_found`` say which remedy applies. Anything else
        falls through to the status."""
        err = json_body(text).get("error")
        err = err if isinstance(err, dict) else {}
        code = str(err.get("code") or "").lower()
        kind = str(err.get("type") or "").lower()
        if code in _POLICY_CODES:
            return E_POLICY
        if status == 400 and str(err.get("param") or "").lower() == "tools":
            # "Unsupported tool type: 'image_generation'" (param "tools"), the first probe's answer: the vendor refused the
            # tool that carries the aspect ratio, not the prompt. Its own code: the remedy is the option, not the words.
            return E_VENDOR_TOOL_UNSUPPORTED
        if code == "invalid_api_key" or kind == "authentication_error":
            return E_AUTH
        if kind == "billing_error" or code.startswith("billing_") or status == 402:
            return E_QUOTA
        if code == "rate_limit_exceeded" or kind == "rate_limit_error":
            return E_RATE_LIMITED
        if code in ("model_not_found", "file_not_found"):
            return E_NOT_FOUND
        if code in ("payload_too_large", "unsupported_media_type", "unsupported_parameter"):
            return E_BAD_REQUEST
        if code in ("server_shutting_down", "service_overloaded", "backend_unavailable", "gateway_timeout") \
                or kind == "server_error":
            return E_UNAVAILABLE
        return None

    def _user(self, request: CapabilityRequest) -> Optional[str]:
        return request.end_user if request.end_user and _USER.fullmatch(request.end_user) else None

    def body(self, request: CapabilityRequest, vendor_model: str) -> dict:
        """The request body, built only after every check has passed."""
        prompt = request.prompt.strip()
        if request.input_images:
            content: list = [{"type": "input_text", "text": prompt}]
            content += [_picture_part(str(ref)) for ref in request.input_images]
            given: object = [{"role": "user", "content": content}]
        else:
            given = prompt
        body: dict = {"model": vendor_model, "store": False, "input": given}
        if request.aspect_ratio:
            body["tools"] = [{"type": "image_generation", "size": ratio_size(request.aspect_ratio)}]
        user = self._user(request)
        if user:
            body["safety_identifier"] = user
        return body

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        bad = self._spec_problems(request, vendor_model)
        if not request.prompt.strip():
            bad.append("prompt is empty")
        if bad:
            # Nothing has been sent: this is a refusal, not a lost answer.
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad), not_accepted=True)
        if real_person_problem(request.prompt):
            raise AdapterError(E_POLICY, "the prompt reads as a real or famous person, a deepfake or a child, which "
                                         "this model may not make; nothing was sent", not_accepted=True)
        try:
            data = self.submit_json(f"{self.base_url}/responses", self.body(request, vendor_model), what="generate")
            return ProviderTask(self.key, vendor_model, None, outputs=self._images(data))
        except AdapterError as e:
            if e.code == E_VENDOR_TOOL_UNSUPPORTED:
                # A clear sentence first, then the vendor's own words (scrubbed, de-branded) for the operator's log.
                e = AdapterError(e.code, f"{TOOL_REFUSED} ({e.message})", http_status=e.http_status,
                                 not_accepted=e.not_accepted)
            raise _plain(e) from None

    def _images(self, data) -> List[Output]:
        """Every finished picture the answer carries, whatever its overall status: each one returned is billed, so a picture
        in an ``incomplete`` response, or beside a corrupt one, is kept. Only when no usable picture is left is the status
        read for a reason, and that failure says the spend may have happened (the vendor answered 2xx: it took the request)."""
        if not isinstance(data, dict):
            raise unconfirmed("the answer is not a JSON object")
        status = str(data.get("status") or "").lower()
        output = data.get("output")
        items = [o for o in output if isinstance(o, dict) and o.get("type") == "image_generation_call"] \
            if isinstance(output, list) else []
        outs: List[Output] = []
        bad: List[str] = []
        for n, item in enumerate(items):
            raw = item.get("result")
            if str(item.get("status") or "completed").lower() != "completed" or not isinstance(raw, str) or not raw:
                continue
            if len(raw) * 3 // 4 > self.max_inline_bytes:
                bad.append(f"image {n + 1} is over the {self.max_inline_bytes} byte limit (not decoded)")
                continue
            try:
                blob = base64.b64decode(raw, validate=False)
            except (ValueError, TypeError):
                blob = b""
            mime = sniff_image_mime(blob) if blob else None
            if mime is None:
                bad.append(f"image {n + 1} is not a PNG, JPEG or WebP file")
                continue
            outs.append(Output(mime, data=blob))          # the bytes as decoded: never re-encoded
        if outs:
            if bad or status not in ("", "completed"):
                # Reported, not hidden: the job keeps what is usable, and the log says what was paid for and lost.
                logger.warning("image.meta: kept %d image(s) from an answer with status %s; unusable: %s", len(outs),
                               self.message(status) or "(none)", "; ".join(bad) or "none")
            return outs
        if bad:
            # The vendor finished and (by its own pricing page) billed these; we could not store any of them.
            raise after_completion(AdapterError(E_BAD_RESPONSE, "; ".join(bad)))
        if status in _FAILED:
            err = data.get("error") if isinstance(data.get("error"), dict) else {}
            code = str(err.get("code") or "").lower()
            text = f"{UNCONFIRMED}. " + self.message(err.get("message") or code or f"the vendor reported the response {status}")
            if code in _POLICY_CODES or "policy" in code:
                raise AdapterError(E_POLICY, f"{text} (the vendor's safety filter refused it)")
            if code == "rate_limit_exceeded":
                raise AdapterError(E_RATE_LIMITED, text)
            if code.startswith(("invalid_image", "image_", "unsupported_image", "empty_image", "failed_to_download",
                                "invalid_base64")):
                raise AdapterError(E_BAD_REQUEST, text)
            raise AdapterError(E_UNAVAILABLE, text)
        if status and status != "completed":
            raise unconfirmed(f"the answer is not a finished response (status {self.message(status)})")
        raise unconfirmed("the answer carries no image")

ADAPTERS = (MuseImageAdapter,)
