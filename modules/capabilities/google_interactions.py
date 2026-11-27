"""Google's Interactions API (the maker's own API): Gemini Omni Flash 1.1 (video), Nano Banana 2.1 (image) and Lyria 3.5
(music; see ``GoogleLyriaAdapter`` and docs/research/lyria-3-5.md, read 2026-11-27).

Sources, all on ai.google.dev and read 2026-10-25 (each page as ``.md.txt``):
``/gemini-api/docs/omni``, ``/models/gemini-omni-flash``, ``/image-generation``, ``/models/gemini-nano-banana-2.1``,
``/background-execution``, ``/pricing``, ``/deprecations``, ``/gemini-api/terms``, and developers.google.com/terms.

* Both models are served by ``POST {base}/interactions`` (``{base}`` ends in ``/v1beta``). The body is
  ``{"model", "input", "response_format": {"type": "video" | "image", ...}}``. The answer is an interaction:
  ``{"id", "status", "model", "steps": [... {"type": "model_output", "content": [{"type": "video" | "image",
  "mime_type", "data" (base64) | "uri"}]}]}``. The ``output_video`` / ``output_image`` shortcuts are SDK-only.
* Omni is treated as ASYNCHRONOUS: the call carries ``background: true`` and ``store: true`` and the result is read
  with ``GET {base}/interactions/{id}`` until ``status`` is ``completed`` (``in_progress`` | ``requires_action`` |
  ``completed`` | ``failed`` | ``cancelled``, per the background-execution page). UNVERIFIED: that page names standard
  Gemini models and managed agents, not Omni; Omni's own page shows a synchronous call and says ``background=false``,
  ``store=false``, ``stream=false`` is "faster, synchronous unary generation". Both shapes work: a create answer that is
  already ``completed`` still yields its id, and the first poll reads the clip. ``GET`` returns the video INLINE (base64) even when ``delivery: "uri"`` was
  asked for, so inline is what is read; a ``uri`` is accepted only on Google's own file host and is downloaded with the
  key in a header, no redirect (safe_fetch).
* Nano Banana 2.1 is synchronous (``background: false``, ``store: false``: the interaction is not kept for later turns;
  what Google retains otherwise, for example for abuse review, was not read).
* Billing claims are NOT assumed either way. The pages read do not say whether a refused or failed request is
  billed, so every refusal and failure carries ``BILLING_UNKNOWN`` and none is ever reported as "not billed".

Settings the price depends on are required and sent as given, never defaulted: Omni's resolution (the vendor's default
is 720p and ``1080p``/``4k`` are "upscaled", their price is not stated), Nano Banana's ``image_size`` (``1K`` is the
vendor default; 2K and 4K cost more) and its thinking level (thinking tokens are billed; the vendor default is
``medium`` and is pinned here in ``THINKING_LEVEL`` so a change of Google's default cannot change what is billed).
Omni has NO duration setting (3 to 10 s, steered in the prompt and billed as produced), so a job that names one is
refused, not ignored.

TERMS: the Gemini API Additional Terms (effective 2026-03-23) allow the API only for 18+ and bar use in a service
"directed towards or ... likely to be accessed by individuals under the age of 18", call the API a service for
"professional or business purposes, not for consumer use", and the Google APIs Terms 4(a) bar sublicensing an API to a
third party. Those are for the owner's lawyer. The registry entries carry ``terms_gate: terms_review_required`` and
stay unsellable until then.
"""

from __future__ import annotations

import base64
import json
import re
import unicodedata
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import urlsplit

from modules.capabilities.base import (
    E_AUTH,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_FOUND,
    E_POLICY,
    E_QUOTA,
    E_UNAVAILABLE,
    FAILED,
    I2V,
    MUSIC,
    PENDING,
    SUCCEEDED,
    T2I,
    T2V,
    EDIT,
    AdapterError,
    CapabilityRequest,
    HttpAdapter,
    Output,
    PollResult,
    ProviderTask,
    is_url,
    json_body,
)
from modules.capabilities.safe_fetch import SafeResultMixin, _looks_like, after_completion, sniff_image_mime, unconfirmed

#: Where a result link may live: the Gemini API's own file host (``…/v1beta/files/…:download?alt=media``). A link
#: anywhere else is refused (fail closed), not guessed at.
RESULT_HOSTS = ("generativelanguage.googleapis.com",)
#: In front of every refusal and failure. Google's pages (pricing, Omni, image generation) say nothing about whether a
#: blocked or failed request is billed, so it is neither "free" nor "charged" here.
BILLING_UNKNOWN = ("BILLING UNKNOWN: the Google pages read do not say whether a refused or failed request is billed; "
                   "check the Gemini API usage page, do not assume it was not")

#: An interaction id goes into a URL path: no dot segment (``..``), no ``:`` (``a:cancel`` would be another endpoint), no ``/``.
_ID = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$")
#: BR-L-207: a content refusal is read from Google's structured fields first (``_structured_block``), and only then from these
#: whole-word phrases in GOOGLE'S OWN error text. A substring test read "harmonies" as harm and a field named "artist_id" as an
#: artist's voice, which sent the person to the wrong remedy (rule 6). Text the MODEL wrote (lyrics, a description) is never read for
#: them: it is the model's words, not Google's verdict.
_POLICY_PHRASES = re.compile(r"\b(safety|policy|prohibited|blocked|violat(e|es|ed|ion|ions|ing)|harm(ful)?|copyright(ed)?|"
                             r"recitation)\b|\bartists?'?s? voices?\b", re.IGNORECASE)
#: The block reasons Google's generative APIs name in a structured field (promptFeedback.blockReason and finishReason in
#: generateContent; the Interactions shape of a block is UNVERIFIED, so the same names are looked for in its error and metadata).
_BLOCK_REASONS = frozenset({"SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY"})
_BLOCK_KEYS = frozenset({"block_reason", "blockreason", "finish_reason", "finishreason", "reason"})
#: Parts of an answer that hold what the model or the person wrote: never searched for a block.
_CONTENT_KEYS = frozenset({"steps", "input", "output_audio", "outputs", "content"})


def _structured_block(obj, depth: int = 0) -> Optional[str]:
    """The first block reason in a structured field of ``obj`` (an error or an answer's metadata), or None. Model content is skipped."""
    if depth > 4:
        return None
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = str(k).lower()
            if key in _CONTENT_KEYS:
                continue
            if key in _BLOCK_KEYS and isinstance(v, str) and v.strip().upper() in _BLOCK_REASONS:
                return v.strip().upper()
            found = _structured_block(v, depth + 1)
            if found:
                return found
    elif isinstance(obj, list):
        for v in obj[:20]:
            found = _structured_block(v, depth + 1)
            if found:
                return found
    return None
_QUOTA_WORDS = ("billing", "paid tier", "free tier", "quota", "credit", "payment", "spending")
_REGION_WORDS = ("location", "region", "country", "territory")
#: Google answers a wrong key with HTTP 400 ``INVALID_ARGUMENT`` ("API key not valid"), not 401: the opposite
#: remedy of a bad request (CLAUDE.md #6).
_KEY_WORDS = ("api key not valid", "api_key_invalid", "api key expired", "api key not found")
#: Statuses of an interaction (background-execution page).
_TERMINAL_FAILED = ("failed", "cancelled", "canceled")
_RUNNING = ("in_progress", "queued", "pending", "running")
_MAX_IMAGE_BYTES = 15 * 1024 * 1024


_PICTURE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")


def _sniff_file(path: Path) -> Optional[str]:
    """The picture type the first bytes of ``path`` say it is (PNG, JPEG, WebP), or None: the suffix is not trusted."""
    try:
        with open(path, "rb") as fh:
            return sniff_image_mime(fh.read(16))
    except OSError:
        return None


def _picture_part(ref: str) -> dict:
    """An input picture as an inline part, labelled with the type its BYTES say. A ``.png`` that is a document, an archive or a secrets
    file is refused here, before any request (``problems`` says the same earlier)."""
    try:
        data = Path(ref).read_bytes()
    except OSError:
        raise AdapterError(E_BAD_REQUEST, "the picture could not be read", not_accepted=True) from None
    mime = sniff_image_mime(data[:16])
    if mime is None:
        raise AdapterError(E_BAD_REQUEST, "the file is not a PNG, JPEG or WebP picture (its bytes say otherwise); it was not sent",
                           not_accepted=True)
    return {"type": "image", "data": base64.b64encode(data).decode("ascii"), "mime_type": mime}


def _refused(message: str, *, http_status=None, not_accepted: bool = False) -> AdapterError:
    return AdapterError(E_POLICY, f"{BILLING_UNKNOWN}. {message}", http_status=http_status, not_accepted=not_accepted)


class _InteractionsBase(SafeResultMixin, HttpAdapter):
    """The shared plumbing of both models: key header, error vocabulary, result reading."""

    key_env = ("GEMINI_API_KEY",)
    base_url_env = "GEMINI_BASE_URL"
    default_base_url = "https://generativelanguage.googleapis.com/v1beta"
    result_hosts = RESULT_HOSTS
    #: The key rides every call in a header, and requests strips only ``Authorization`` on a cross-host redirect: a 3xx (307/308 also
    #: re-sends the body) is an error here, never followed.
    follow_redirects = False

    def auth_headers(self) -> Dict[str, str]:
        # Google takes the key in its own header; never in the query string.
        return {"x-goog-api-key": self.api_key()}

    def download_headers(self, url: str) -> Optional[Dict[str, str]]:
        """The key rides a result download only to the exact host the API itself is on (Google's file URI needs it);
        any other host, and every hop after a redirect (there are none: redirects are refused), gets none."""
        try:
            parts = urlsplit(url)
            api = urlsplit(self.base_url)
        except ValueError:
            return None
        try:
            same = parts.port in self.result_ports      # (None, 443) unless a test names its loopback port
        except ValueError:
            return None
        if parts.scheme == "https" and parts.hostname and parts.hostname == api.hostname and same and parts.netloc.lower() == api.netloc.lower():
            return self.auth_headers()
        return None

    def vendor_error_code(self, status: int, text: str) -> Optional[str]:
        """Google's ``error.status`` where it is sharper than the HTTP status: a 400 saying the key is not valid is
        ``auth`` (not a bad request), a 400 ``FAILED_PRECONDITION`` is a billing / region problem of the ACCOUNT
        (never the request), a 403 ``PERMISSION_DENIED`` is the key or the account's billing. Anything else falls
        through to the status."""
        err = json_body(text).get("error")
        err = err if isinstance(err, dict) else {}
        name = str(err.get("status") or "").upper()
        low = str(err.get("message") or text or "").lower()
        if any(w in low for w in _KEY_WORDS):
            return E_AUTH
        if name == "FAILED_PRECONDITION":
            if any(w in low for w in _QUOTA_WORDS):
                return E_QUOTA
            if any(w in low for w in _REGION_WORDS):
                return E_AUTH
        if name == "PERMISSION_DENIED" and any(w in low for w in _QUOTA_WORDS):
            return E_QUOTA
        if _structured_block(err):
            return E_POLICY
        # An answer with no Google status (an HTML page, a proxy's text) is read for a content refusal only when it is a 4xx that is
        # not a key, quota, lookup or rate answer: a 503 page about a "privacy policy", a 500 "retry policy" or a 403 "Request
        # blocked." is an outage or an access problem, and calling it the person's prompt names the wrong fix (rule 6).
        plain = name == "" and 400 <= status < 500 and status not in (401, 402, 403, 404, 429)
        if (name in ("INVALID_ARGUMENT", "FAILED_PRECONDITION") or plain) and _POLICY_PHRASES.search(low):
            return E_POLICY
        return None

    def _create(self, body: dict, *, what: str, headers: Optional[Dict[str, str]] = None) -> dict:
        """POST /interactions. A refusal for content carries ``BILLING_UNKNOWN``; a lost answer carries
        ``UNCONFIRMED SPEND`` (safe_fetch.submit_json). ``headers``: a model whose page pins an API revision (Lyria)."""
        try:
            extra = {"headers": headers} if headers else {}
            data = self.submit_json(f"{self.base_url}/interactions", body, what=what, **extra)
        except AdapterError as e:
            if e.code == E_POLICY and not e.message.startswith(BILLING_UNKNOWN):
                raise _refused(e.message, http_status=e.http_status, not_accepted=e.not_accepted) from None
            raise
        if not isinstance(data, dict):
            raise unconfirmed("the answer is not a JSON object")
        return data

    # -- reading an interaction ------------------------------------------------------
    @staticmethod
    def _contents(data: dict, kind: str) -> List[dict]:
        out: List[dict] = []
        steps = data.get("steps")
        for step in steps if isinstance(steps, list) else []:
            content = step.get("content") if isinstance(step, dict) else None
            if isinstance(step, dict) and step.get("type") == "model_output" and isinstance(content, list):
                out += [c for c in content if isinstance(c, dict) and c.get("type") == kind]
        return out

    @staticmethod
    def _text(data: dict) -> str:
        parts = []
        steps = data.get("steps")
        for step in steps if isinstance(steps, list) else []:
            content = step.get("content") if isinstance(step, dict) else None
            if isinstance(step, dict) and step.get("type") == "model_output" and isinstance(content, list):
                parts += [str(c.get("text")) for c in content
                          if isinstance(c, dict) and c.get("type") == "text" and c.get("text")]
        return " ".join(parts)

    def _failure(self, data: dict) -> PollResult:
        err = data.get("error") if isinstance(data.get("error"), dict) else {}
        text = self.message(err.get("message") or err.get("status") or f"the vendor reported the job {data.get('status')}")
        low = text.lower()
        if _structured_block(err) or _structured_block({k: v for k, v in data.items() if k != "error"}) or _POLICY_PHRASES.search(text):
            return PollResult(FAILED, error=_refused(text))
        code = E_QUOTA if any(w in low for w in _QUOTA_WORDS) else E_UNAVAILABLE
        return PollResult(FAILED, error=AdapterError(code, f"{BILLING_UNKNOWN}. {text}"))

    @staticmethod
    def _task_id(data: dict) -> str:
        tid = data.get("id")
        if not isinstance(tid, str) or not _ID.fullmatch(tid):
            raise unconfirmed("the answer carries no usable interaction id")
        return tid


# ── Gemini Omni Flash 1.1 (video) ─────────────────────────────────────────────────

class GeminiOmniAdapter(_InteractionsBase):
    """``gemini-omni-1.1-flash``: text-to-video and image-to-video (one first-frame picture).

    Not wired: first/last-frame interpolation, subject/style references, video references, editing and extension
    (all documented, none needed for a dark entry). The resolution is required (see the module docstring); there is no
    duration setting; the soundtrack is always on (no flag, so ``audio`` is refused)."""

    key = "video.gemini_omni"
    capabilities = (T2V, I2V)
    resolution_capabilities = (T2V, I2V)       # always sent
    timeout = 300                              # the create call may hold the connection if Google answers synchronously
    #: Omni answers inline (base64) on GET: a 10 s 4K clip can be large, so the inline cap is above safe_fetch's 64 MB.
    max_inline_bytes = 256 * 1024 * 1024
    SPECS = {"gemini-omni-1.1-flash": {"resolutions": ("360p", "720p", "1080p", "4k"), "ratios": ("16:9", "9:16")}}

    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        spec = self.SPECS.get(vendor_model)
        if spec is None:
            return [f"{vendor_model!r} is not a Gemini Omni model this adapter knows"]
        out: List[str] = []
        if request.resolution not in spec["resolutions"]:
            out.append(f"resolution {request.resolution or '(none)'} is not offered by {vendor_model}: the price "
                       f"depends on it, so it is never defaulted")
        if request.duration_s is not None:
            out.append("Gemini Omni has no duration setting (3 to 10 s, steered in the prompt and billed as produced): "
                       "a duration is refused, not ignored")
        if request.audio is not None:
            out.append("Gemini Omni's soundtrack is always on: there is no audio flag to send")
        if request.negative_prompt:
            out.append("Gemini Omni does not support negative prompts (say what to avoid in the prompt)")
        if request.aspect_ratio is not None and request.aspect_ratio not in spec["ratios"]:
            out.append(f"aspect ratio {request.aspect_ratio} is not offered by {vendor_model}")
        if request.capability == T2V:
            if request.input_images:
                out.append("a picture does not apply to text-to-video")
        elif len(request.input_images) != 1:
            out.append("image-to-video takes exactly one first-frame picture")
        else:
            ref = str(request.input_images[0])
            path = Path(ref)
            if is_url(ref):
                out.append("the picture must be a file from the library, not an https URL")
            elif path.suffix.lower() not in _PICTURE_SUFFIXES:
                out.append("Gemini Omni reads PNG, JPEG or WebP pictures")
            elif path.is_file() and path.stat().st_size > _MAX_IMAGE_BYTES:
                out.append("the picture is over 15 MB")
            elif path.is_file() and _sniff_file(path) is None:
                out.append("the file is not a PNG, JPEG or WebP picture (its bytes say otherwise); it was not sent")
        return out

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        out.extend(self._spec_problems(request, entry.vendor_model_for(request.capability)))
        return out

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        bad = self._spec_problems(request, vendor_model)
        if request.capability == T2V and not request.prompt.strip():
            bad.append("prompt is empty")
        if bad:
            # Nothing has been sent: a refusal, not a lost answer.
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad), not_accepted=True)
        fmt: dict = {"type": "video", "resolution": request.resolution}
        if request.aspect_ratio:
            fmt["aspect_ratio"] = request.aspect_ratio
        prompt = request.prompt.strip()
        if request.capability == I2V:
            ref = str(request.input_images[0])
            parts: list = [_picture_part(ref)]
            if prompt:
                parts.append({"type": "text", "text": prompt})
            payload: object = parts
        else:
            payload = prompt
        # background + store: the clip is read later by GET /interactions/{id}; a held-open call that times out would be
        # a lost answer for a clip that may be billed.
        data = self._create({"model": vendor_model, "input": payload, "response_format": fmt,
                             "background": True, "store": True}, what="generate")
        # Whatever the status of this answer (``in_progress``, or already ``completed`` if Google answered synchronously),
        # the id is what is kept and polled: the creative worker polls a task id, and the clip is read once, by poll.
        return ProviderTask(self.key, vendor_model, self._task_id(data))

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        tid = str(task.task_id or "")
        if not _ID.fullmatch(tid):
            raise AdapterError(E_NOT_FOUND, "task id has an unexpected shape")
        data = self.get(f"{self.base_url}/interactions/{tid}")
        if not isinstance(data, dict):
            raise AdapterError(E_BAD_RESPONSE, "the status answer is not a JSON object")
        status = str(data.get("status") or "").lower()
        if status == "completed":
            return self._video(data)
        if status in _TERMINAL_FAILED:
            return self._failure(data)
        if status in _RUNNING:
            return PollResult(PENDING)
        if status == "requires_action":
            # Nothing here can answer a request for input; the job would be left running and billing.
            return PollResult(FAILED, error=AdapterError(
                E_BAD_RESPONSE, f"{BILLING_UNKNOWN}. Google paused the interaction waiting for client input, which "
                                f"this adapter cannot give; it was not cancelled"))
        raise AdapterError(E_BAD_RESPONSE, f"unknown interaction status {self.message(status)!r}")

    def _video(self, data: dict) -> PollResult:
        try:
            return self._video_of(data)
        except AdapterError:
            raise
        except Exception:     # an odd shape nobody planned for: the vendor said completed, so it may have billed
            raise after_completion(AdapterError(E_BAD_RESPONSE, "the completed interaction has a shape this adapter cannot read")) from None

    def _video_of(self, data: dict) -> PollResult:
        clips = self._contents(data, "video")
        if not clips:
            # The vendor says it finished and sent no clip: it may have billed.
            raise after_completion(AdapterError(E_BAD_RESPONSE, "completed without a video in model_output"))
        clip = clips[0]
        # A media type may carry parameters ("video/mp4; codecs=avc1") and stray white space.
        mime = str(clip.get("mime_type") or "video/mp4").split(";", 1)[0].strip().lower()
        if mime != "video/mp4":
            raise after_completion(AdapterError(E_BAD_RESPONSE, f"the clip is {self.message(mime)!r}, not video/mp4"))
        if isinstance(clip.get("data"), str) and clip["data"]:
            if len(clip["data"]) * 3 // 4 > self.max_inline_bytes:
                # Refused before decoding: the cap is on what base64 would allocate.
                raise after_completion(AdapterError(E_BAD_RESPONSE, f"the inline clip is over the {self.max_inline_bytes} byte limit; not decoded"))
            try:
                raw = base64.b64decode(clip["data"], validate=False)
            except (ValueError, TypeError):
                raw = b""
            if not raw:
                raise after_completion(AdapterError(E_BAD_RESPONSE, "the inline clip is not valid base64"))
            return PollResult(SUCCEEDED, [Output(mime, data=raw)])
        uri = clip.get("uri")
        if isinstance(uri, str) and uri:
            return self.checked_outputs(PollResult(SUCCEEDED, [Output(mime, url=uri)]))
        raise after_completion(AdapterError(E_BAD_RESPONSE, "the clip has neither data nor uri"))


# ── Nano Banana 2.1 (image) ───────────────────────────────────────────────────────

class GeminiNanoBananaAdapter(_InteractionsBase):
    """``gemini-nano-banana-2.1``: text-to-image and image editing with up to 14 reference pictures, one image per call.

    ``image_size`` is required (1K | 2K | 4K, priced apart). ``thinking_level`` is always sent (``THINKING_LEVEL``).
    Search grounding, multi-turn editing, video/PDF inputs and the 512 px size (not offered by this model) are not wired.
    Reference pictures ride as inline base64 parts after the text, as in Google's own examples; the whole request is held
    to 14 MiB of pictures (Google's inline limit is 20 MB per request for the older image calls; the Interactions limit
    was not found, so this is OUR bound)."""

    key = "image.gemini_interactions"
    capabilities = (T2I, EDIT)
    reference_capabilities = (T2I, EDIT)
    timeout = 180
    THINKING_LEVEL = "medium"
    MAX_TOTAL_IMAGE_BYTES = 14 * 1024 * 1024
    SPECS = {"gemini-nano-banana-2.1": {
        "sizes": ("1K", "2K", "4K"), "refs": 14,
        "ratios": ("1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9")}}

    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        spec = self.SPECS.get(vendor_model)
        if spec is None:
            return [f"{vendor_model!r} is not a Nano Banana model this adapter knows"]
        out: List[str] = []
        if request.image_size not in spec["sizes"]:
            out.append(f"image size {request.image_size or '(none)'} is not offered by {vendor_model}: the price depends "
                       f"on it, so it is never defaulted")
        if request.aspect_ratio is not None and request.aspect_ratio not in spec["ratios"]:
            out.append(f"aspect ratio {request.aspect_ratio} is not offered by {vendor_model}")
        if request.negative_prompt:
            out.append("Nano Banana does not take a negative prompt here (say what to avoid in the prompt)")
        if len(request.input_images) > spec["refs"]:
            out.append(f"{vendor_model} takes at most {spec['refs']} reference pictures")
        if request.capability == EDIT and not request.input_images:
            out.append("an edit needs at least one picture")
        total = 0
        for ref in request.input_images:
            ref = str(ref)
            path = Path(ref)
            if is_url(ref):
                out.append("pictures must be files from the library, not https URLs")
                break
            if path.suffix.lower() not in _PICTURE_SUFFIXES:
                out.append("Nano Banana reads PNG, JPEG or WebP pictures")
                break
            if path.is_file():
                total += path.stat().st_size
                if _sniff_file(path) is None:
                    out.append("a file is not a PNG, JPEG or WebP picture (its bytes say otherwise); nothing was sent")
                    break
        if total > self.MAX_TOTAL_IMAGE_BYTES:
            out.append("the pictures are over 14 MB together")
        return out

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        out.extend(self._spec_problems(request, entry.vendor_model_for(request.capability)))
        return out

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        bad = self._spec_problems(request, vendor_model)
        if not request.prompt.strip():
            bad.append("prompt is empty")
        if bad:
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad), not_accepted=True)
        parts: list = [{"type": "text", "text": request.prompt.strip()}]
        for ref in request.input_images:
            parts.append(_picture_part(str(ref)))
        fmt: dict = {"type": "image", "image_size": request.image_size}
        if request.aspect_ratio:
            fmt["aspect_ratio"] = request.aspect_ratio       # left out = the vendor's own (the input's shape, else 1:1)
        data = self._create({"model": vendor_model, "input": parts, "response_format": fmt,
                             "generation_config": {"thinking_level": self.THINKING_LEVEL},
                             "background": False, "store": False}, what="generate")
        return ProviderTask(self.key, vendor_model, None, outputs=self._image(data).outputs)

    def _image(self, data: dict) -> PollResult:
        try:
            return self._image_of(data)
        except AdapterError:
            raise
        except Exception:     # an odd shape nobody planned for: the call went through, so it may have billed
            raise unconfirmed("the answer has a shape this adapter cannot read") from None

    def _image_of(self, data: dict) -> PollResult:
        status = str(data.get("status") or "").lower()
        if status in _TERMINAL_FAILED:
            raise self._failure(data).error
        images = self._contents(data, "image")
        raw = images[0].get("data") if images else None
        if not isinstance(raw, str) or not raw:
            if status != "completed":
                # Asked synchronously and answered with something unfinished: the call may be running and billing.
                raise unconfirmed(f"the answer is not a finished interaction (status {self.message(status) or 'missing'})")
            said = self.message(self._text(data))[:160]
            raise unconfirmed("the answer carries no image" + (f" (the model said: {said})" if said else ""))
        if len(raw) * 3 // 4 > self.max_inline_bytes:
            raise unconfirmed(f"the image is over the {self.max_inline_bytes} byte limit; not decoded")
        try:
            blob = base64.b64decode(raw, validate=False)
        except (ValueError, TypeError):
            blob = b""
        mime = sniff_image_mime(blob) if blob else None
        if mime is None:
            raise unconfirmed("the image is not a PNG, JPEG or WebP file")
        return PollResult(SUCCEEDED, [Output(mime, data=blob)])


# ── Lyria 3.5 (music) ─────────────────────────────────────────────────────────────

#: Lyria's page pins the Interactions API revision its examples were written for. Sent on every call, so a later default
#: revision (another body shape, another answer shape) cannot change what this adapter sends or reads without a code change.
LYRIA_API_REVISION = "2026-05-20"
#: The remedy a person reads when Google's filter blocks a prompt. The music page: prompts that "request specific artist voices or
#: the generation of copyrighted lyrics" are blocked. Rule 4: the block is the answer, never another model or a reworded prompt.
LYRIA_POLICY_REMEDY = ("Google's safety filter blocked this prompt: remove any artist's name or voice and any real song's lyrics, "
                       "then try again")
#: The instruction Google's page gives for a song without singing: there is no field for it, it is written in the prompt.
LYRIA_INSTRUMENTAL = "Instrumental only, no vocals."
#: BR-S6-01: a lyric section is recognised by its SHAPE, never by a list of words (the vocabulary is open, in every language, and the
#: reader is a language model). After ``_fold``: a line that starts with a bracketed label of any bracket kind, or with "Word N:".
_OPEN, _CLOSE = "[({<\u3010\u3014\u3016\u3018\u301a\u27e6\u27e8\u300a\u300c\u300e", "])}>\u3011\u3015\u3017\u3019\u301b\u27e7\u27e9\u300b\u300d\u300f"
_BRACKET_LABEL = re.compile(rf"^\s*[{re.escape(_OPEN)}][^{re.escape(_CLOSE)}\n]{{0,80}}[{re.escape(_CLOSE)}]")
_WORD_N_LABEL = re.compile(r"^\s*[^\W\d_]+(?:[ -][^\W\d_]+)?\s*\d+\s*[:.)-]")
#: Characters that render as nothing and split a word for a reader that does not ignore them (a zero-width space in [Ver​se]).
_INVISIBLE = re.compile("[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e"
                        "\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]")
#: The common Cyrillic and Greek look-alikes of Latin letters ([Vеrse] with a Cyrillic е), folded to Latin before any check.
_CONFUSABLES = str.maketrans("аеорсухіјѕԁԛԝАВЕКМНОРСТУХІЈЅαβεικνορτυχΑΒΕΖΗΙΚΜΝΟΡΤΥΧ",
                             "aeopcyxijsdqwABEKMHOPCTYXIJSabeiknoptuxABEZHIKMNOPTYX")
#: What an instrumental answer's text may say and still be instrumental.
_NOT_SUNG = re.compile(r"^(instrumental( only)?|instrumental music|no vocals|instrumental only,? no vocals|\(?instrumental\)?)$",
                       re.IGNORECASE)


def _fold(text: str) -> str:
    """NFKC (fullwidth ［Verse］ becomes [Verse]), invisible characters removed, look-alike letters folded to Latin."""
    return _INVISIBLE.sub("", unicodedata.normalize("NFKC", text or "")).translate(_CONFUSABLES)


def _section_label_line(prompt: str) -> Optional[int]:
    """The 1-based number of the first line that starts with a section label, or None."""
    for n, line in enumerate(_fold(prompt).splitlines(), 1):
        if _BRACKET_LABEL.match(line) or _WORD_N_LABEL.match(line):
            return n
    return None


def _strip_labels(line: str) -> str:
    out = _BRACKET_LABEL.sub("", line)
    while out != line:
        line, out = out, _BRACKET_LABEL.sub("", out)
    out = _WORD_N_LABEL.sub("", out)
    return out.strip(" \t-\u2013\u2014:.,;!?\"'*_")


def returned_singing(text: str) -> bool:
    """BR-S6-01/02, the OUTPUT check, and only a FIRST SIGNAL until the paid probe and the vocal-activity measurement on the MP3 exist:
    True when the lyrics or structure text Google returned beside the audio carries a sung line. What it reads:
      * JSON: only the strings under a key whose name contains lyric, vocal, sung, words or lines. Strings under any other key (a
        section's name, a description) are NOT read, so it is not fail-closed for a key it does not know;
      * plain text: each line with its bracketed labels ([Intro], [0:00 - 0:10]) and a leading "Word N:" removed must be empty,
        carry no letter, or say "instrumental". An unbracketed timing or a prose description counts as sung (refused).
    What an instrumental answer's text really looks like is UNVERIFIED; the guarantee Lyria needs before sale is the measurement."""
    folded = _fold(text).strip()
    if not folded:
        return False
    try:
        doc = json.loads(folded)
    except ValueError:
        doc = None
    if isinstance(doc, (dict, list)):
        def sung(obj, under_lyrics=False, depth=0) -> bool:
            if depth > 8:
                return True
            if isinstance(obj, dict):
                return any(sung(v, under_lyrics or bool(re.search(r"lyric|vocal|sung|words|lines", str(k), re.IGNORECASE)), depth + 1)
                           for k, v in obj.items())
            if isinstance(obj, list):
                return any(sung(v, under_lyrics, depth + 1) for v in obj)
            if isinstance(obj, str) and under_lyrics:
                return any(_strip_labels(ln) and not _NOT_SUNG.match(_strip_labels(ln)) for ln in obj.splitlines())
            return False
        return sung(doc)
    for line in folded.splitlines():
        rest = _strip_labels(line)
        if rest and not _NOT_SUNG.match(rest) and any(ch.isalpha() for ch in rest):
            return True
    return False
#: The media types an MP3 is answered under (``audio/mp3`` is not registered, but is what several Google samples print).
_MP3_TYPES = ("audio/mpeg", "audio/mp3")
#: The standard base64 alphabet, padding only at the end. A lenient decode drops characters it does not know, so a string with
#: white space, the URL-safe alphabet or stray text would decode to SOME bytes; it is refused instead (``validate=True`` as well).
_B64 = re.compile(r"^[A-Za-z0-9+/]*={0,2}$")


class GoogleLyriaAdapter(_InteractionsBase):
    """``lyria-3.5``: music from words, one MP3 per call, through the Interactions API (aistudio.google.com/docs/music-generation,
    read 2026-11-27; docs/research/lyria-3-5.md).

    WHAT IS SENT. ``{"model", "input": <text>, "response_format": {"type": "audio"}, "background": false, "store": false}`` with
    ``Api-Revision: 2026-05-20`` and the key in ``x-goog-api-key`` (``_InteractionsBase``: never the query string, no redirect
    followed). The page's REST example sends exactly ``{"type": "audio"}``; MP3 is the documented default and nothing else is asked
    for, and what comes back must be MP3 by its own bytes. ``store: false``: the music page shows only synchronous calls and says
    nothing of retention; a stored interaction is kept 55 days on the paid tier (interactions page) and would hold the prompt at
    Google for no use of ours. Sending ``store``/``background`` with Lyria is UNVERIFIED (the music page does not name them; the
    Interactions API documents both).

    NO SETTINGS. "There is no field for lyrics, duration, seed, negative prompt or language": a request that sets a duration, a
    negative prompt, a shape, pictures or anything else is refused before the call (never dropped while the person pays for it).
    The price is per song, so nothing the person sets changes what Google bills.

    LANGUAGE. "Lyria 3.5 generates lyrics in the language of your prompt", and no list of sung languages exists for 3.5 (the only
    official list, for Vertex Lyria 3, has neither Russian nor Uzbek). Only a language a real call has proven is sung:
    ``SPECS[...]["vocal_languages"]``, EMPTY until a probe. So today every song is instrumental, held in three layers:
      1. before the call, a COURTESY refusal by shape (rule 6, BR-S6-01): the request may not name a language, and a prompt with
         a line that starts with a bracketed label of any bracket kind or with "Word N:" is refused, after NFKC, invisible
         characters removed and look-alike letters folded (``_section_label_line``). A deny-list of words cannot be sound (the
         vocabulary is open and the reader is a language model), so this is never the guarantee;
      2. Google's own instruction for a song without singing is put at the end of the prompt (whether Lyria honours it is
         UNVERIFIED);
      3. the OUTPUT check (BR-S6-02): the lyrics or structure text Google returns beside the audio is read (``returned_singing``),
         and a song with sung lines fails as an after-completion bad response, never accepted and never retried elsewhere.
    NOT YET BUILT, and a condition of sale: a vocal-activity measurement on the MP3 itself (the text can be absent or wrong). It
    needs a measurement PR first (rule 8). Lyria cannot go on sale until it exists. ``vocals_requested`` in the provenance records
    what was asked, never what was heard.

    THE ANSWER. Base64 audio in a ``model_output`` step's ``audio`` content (the last one, which is what ``output_audio`` names), or
    a top-level ``output_audio`` block. Decoded strictly (the base64 alphabet only) and capped BEFORE decoding; missing, empty,
    not base64 or not MP3 fails closed. The lyrics or structure text Google sends beside it is not kept.

    SAFETY BLOCK (BR-L-207). A refusal for content is read from Google's structured fields (a block or finish reason such as
    SAFETY or RECITATION, ``_structured_block``), else from whole-word phrases in GOOGLE'S error text (``_POLICY_PHRASES``: never a
    substring, so "harmonies" is not harm and a field named artist_id is not an artist's voice). Text the model wrote is never read
    for it. A block is ``policy`` with ``LYRIA_POLICY_REMEDY``: never retried, never moved to another model. Anything wrong with a
    COMPLETED answer carries the after-completion spend note.

    PROVENANCE. ``output_provenance``: every Lyria file carries Google's SynthID audio watermark ("All generated audio includes a
    SynthID audio watermark", no opt-out), so the library row says ``synthid: true`` and the vendor model.

    TERMS (docs/research/lyria-3-5.md): paid tier only, 18+ (registry ``requires_adult``), Google's available regions only
    (registry ``blocked_countries``; Russia is not listed), never a bare prompt-to-song service or a public API (Google APIs Terms
    4a: registry ``api_exposure: web_only``, no MCP flag). ``terms_gate`` keeps it unsold until the owner signs the legal text.
    """

    key = "audio.google_lyria"
    capabilities = (MUSIC,)
    #: One synchronous call holds the connection while the song is made; the page states no latency (UNVERIFIED).
    timeout = 300
    #: A few minutes of MP3 is well under 16 MB; an answer far beyond that is not a song, and is not decoded.
    max_inline_bytes = 32 * 1024 * 1024
    SPECS = {"lyria-3.5": {"vocal_languages": ()}}

    @staticmethod
    def _blocked(text: str, *, http_status=None, not_accepted: bool = False) -> AdapterError:
        return AdapterError(E_POLICY, f"{BILLING_UNKNOWN}. {LYRIA_POLICY_REMEDY}. Google said: {text}"[:500],
                            http_status=http_status, not_accepted=not_accepted)

    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        spec = self.SPECS.get(vendor_model)
        if spec is None:
            return [f"{vendor_model!r} is not a Lyria model this adapter knows"]
        out: List[str] = []
        sung = spec["vocal_languages"]
        if request.text_language is not None and request.text_language not in sung:
            out.append(f"{vendor_model} is not offered for vocals in {request.text_language}: no real call has proven that language "
                       f"yet ({'only instrumental music is offered' if not sung else 'proven: ' + ', '.join(sung)})")
        line = _section_label_line(request.prompt or "") if request.text_language is None else None
        if line is not None:
            # A courtesy refusal before anything is spent (rule 6). It is not the guarantee: the output check is (returned_singing).
            out.append(f"line {line} of the prompt starts with a section label ([Verse], (Chorus), 'Verse 1:' or the like): only "
                       f"instrumental music is offered, so lyric sections are not sent; describe the music in plain words")
        if request.duration_s is not None:
            out.append(f"{vendor_model} has no duration setting (the length is steered in the prompt): a duration is refused, not ignored")
        if request.negative_prompt:
            out.append(f"{vendor_model} has no negative prompt (say what to avoid in the prompt)")
        if request.input_images or request.input_media:
            out.append(f"{vendor_model} is asked by words only here")
        for name, value in (("an aspect ratio", request.aspect_ratio), ("a resolution", request.resolution),
                            ("an image size", request.image_size), ("a quality", request.quality), ("an audio flag", request.audio)):
            if value is not None:
                out.append(f"{name} does not apply to {vendor_model}")
        return out

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        out.extend(self._spec_problems(request, entry.vendor_model_for(request.capability)))
        return out

    def _input(self, request: CapabilityRequest) -> str:
        prompt = request.prompt.strip()
        if request.text_language is None:
            return f"{prompt}\n\n{LYRIA_INSTRUMENTAL}"
        return prompt

    def output_provenance(self, request: CapabilityRequest, vendor_model: str) -> Dict[str, object]:
        """What the library row records about a Lyria file beside the job and the registry model: Google watermarks every file."""
        return {"synthid": True, "vendor_model": vendor_model, "vocals_requested": request.text_language is not None}

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        bad = self._spec_problems(request, vendor_model)
        if request.capability != MUSIC:
            bad.append(f"adapter {self.key} cannot do {request.capability}")
        if not request.prompt.strip():
            bad.append("prompt is empty")
        if bad:
            # Nothing has been sent: a refusal, not a lost answer.
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad), not_accepted=True)
        body = {"model": vendor_model, "input": self._input(request), "response_format": {"type": "audio"},
                "background": False, "store": False}
        try:
            data = self._create(body, what="generate", headers={"Api-Revision": LYRIA_API_REVISION})
        except AdapterError as e:
            if e.code == E_POLICY:
                # The remedy goes in front of Google's words, inside the 500 characters a message keeps.
                said = e.message[len(BILLING_UNKNOWN) + 2:] if e.message.startswith(BILLING_UNKNOWN) else e.message
                raise self._blocked(said, http_status=e.http_status, not_accepted=e.not_accepted) from None
            raise
        return ProviderTask(self.key, vendor_model, None,
                            outputs=self._song(data, instrumental=request.text_language is None).outputs)

    def _song(self, data: dict, *, instrumental: bool = True) -> PollResult:
        try:
            return self._song_of(data, instrumental=instrumental)
        except AdapterError:
            raise
        except Exception:     # an odd shape nobody planned for: the call went through, so it may have billed
            raise unconfirmed("the answer has a shape this adapter cannot read") from None

    def _audio_block(self, data: dict) -> Optional[dict]:
        blocks = self._contents(data, "audio")
        if blocks:
            return blocks[-1]
        top = data.get("output_audio")
        return top if isinstance(top, dict) else None

    def _song_of(self, data: dict, *, instrumental: bool = True) -> PollResult:
        status = str(data.get("status") or "").lower()
        if status in _TERMINAL_FAILED:
            err = self._failure(data).error
            if err.code == E_POLICY:
                said = err.message[len(BILLING_UNKNOWN) + 2:] if err.message.startswith(BILLING_UNKNOWN) else err.message
                raise self._blocked(said)
            raise err
        if status != "completed":
            # Asked synchronously and answered with something unfinished: the call may be running and billing.
            raise unconfirmed(f"the answer is not a finished interaction (status {self.message(status) or 'missing'})")
        # From here the interaction is COMPLETED, so it may have been billed: every refusal carries the after-completion note.
        block = self._audio_block(data)
        raw = block.get("data") if block else None
        if not isinstance(raw, str) or not raw:
            reason = _structured_block({k: v for k, v in data.items()})
            if reason:
                raise after_completion(self._blocked(f"block reason {reason}"))
            raise after_completion(AdapterError(E_BAD_RESPONSE, "completed without audio"))
        if instrumental and returned_singing(self._text(data)):
            # BR-S6-02: whatever the prompt said, a song that came back with sung lines is not what was offered (rule 4). Never
            # accepted, never retried on another model.
            raise after_completion(AdapterError(E_BAD_RESPONSE, "Google returned singing; only instrumental music is offered"))
        mime = str(block.get("mime_type") or "audio/mpeg").split(";", 1)[0].strip().lower()
        if mime not in _MP3_TYPES:
            raise after_completion(AdapterError(E_BAD_RESPONSE, f"the audio is {self.message(mime)!r}; MP3 was asked for"))
        if len(raw) * 3 // 4 > self.max_inline_bytes:
            # Refused before decoding: the cap is on what base64 would allocate.
            raise after_completion(AdapterError(E_BAD_RESPONSE, f"the audio is over the {self.max_inline_bytes} byte limit; not decoded"))
        if len(raw) % 4 or not _B64.fullmatch(raw):
            raise after_completion(AdapterError(E_BAD_RESPONSE, "the audio is not valid base64"))
        try:
            song = base64.b64decode(raw, validate=True)
        except (ValueError, TypeError):
            raise after_completion(AdapterError(E_BAD_RESPONSE, "the audio is not valid base64")) from None
        if not song:
            raise after_completion(AdapterError(E_BAD_RESPONSE, "the audio is empty"))
        if not _looks_like("audio/mpeg", song[:16]):
            raise after_completion(AdapterError(E_BAD_RESPONSE, "the audio is not an MP3 file by its bytes"))
        return PollResult(SUCCEEDED, [Output("audio/mpeg", data=song)])


ADAPTERS = (GeminiOmniAdapter, GeminiNanoBananaAdapter, GoogleLyriaAdapter)
