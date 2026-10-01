"""The capability layer's contract: one request shape, one task shape, typed errors.

Why this is separate from the pipeline's clients
------------------------------------------------
``modules/image_providers.py`` and ``modules/video_providers.py`` serve the
autonomous pipeline, where a failed generation must never break a render: they
swallow every error and return ``None`` so the section falls back to stock.
That is the right contract there and the wrong one here. In the Creative OS a
person asked for *this* model and is paying credits for it (docs/CREATIVE_OS_PLAN.md
§3.3), so an adapter must say what went wrong — an invalid key and an empty
balance are both an HTTP error, and they need opposite remedies (CLAUDE.md #6).

Every adapter therefore:

* validates a :class:`CapabilityRequest` against its registry entry before any
  paid call (:meth:`HttpAdapter.problems`);
* ``submit`` starts the (billable) job and returns a :class:`ProviderTask` whose
  ``task_id`` is persisted by the caller BEFORE polling, so a crash polls the
  paid job instead of paying again (the ``provider_tasks.py`` rule);
* ``poll`` never re-submits; ``fetch`` downloads the outputs;
* raises :class:`AdapterError` with a machine-readable ``code`` and never puts a
  key in a message, a log line, or an exception.

Synchronous vendors (the image APIs, TTS) do the work in ``submit`` and hand
back a task that is already finished, so callers treat every vendor alike.
"""

from __future__ import annotations

import base64
import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional, Sequence
from urllib.parse import urljoin, urlparse

import requests

# ── capabilities (the registry schema's enum mirrors this tuple) ────────────
T2I = "t2i"          # text → image
EDIT = "edit"        # image(s) + text → image
T2V = "t2v"          # text → video
I2V = "i2v"          # first-frame image (+ text) → video
TTS = "tts"          # text → speech
SFX = "sfx"          # text → sound effect
UPSCALE = "upscale"  # image → the same image, 2x / 4x the pixels (CapabilityRequest.scale)
REMOVE_BG = "remove_bg"  # image → the subject on a transparent background
VOICE_CHANGE = "voice_change"  # speech (audio / video) → the same performance in another voice
DUB = "dub"          # speech (audio / video) → the dubbed speech in a target language
CAPABILITIES = (T2I, EDIT, T2V, I2V, TTS, SFX, UPSCALE, REMOVE_BG, VOICE_CHANGE, DUB)
OUTPUT_OF = {T2I: "image", EDIT: "image", T2V: "video", I2V: "video", TTS: "audio", SFX: "audio",
             UPSCALE: "image", REMOVE_BG: "image", VOICE_CHANGE: "audio", DUB: "audio"}
#: Capabilities whose input is an image (CapabilityRequest.input_images).
IMAGE_INPUT = frozenset({EDIT, I2V, UPSCALE, REMOVE_BG})
#: Capabilities whose input is a recording — audio or video with speech
#: (CapabilityRequest.input_media, migration 0050). Never mixed with images.
MEDIA_INPUT = frozenset({VOICE_CHANGE, DUB})
#: Capabilities where the prompt is optional (i2v, upscale) or absent
#: (remove_bg, and the voice tools: the recording is the whole input).
PROMPT_OPTIONAL = frozenset({I2V, UPSCALE, REMOVE_BG, VOICE_CHANGE, DUB})

# ── task states ──────────────────────────────────────────────────────────────
PENDING = "pending"
SUCCEEDED = "succeeded"
FAILED = "failed"

# ── error codes (stable: they reach job rows, probe rows and the UI's remedy) ─
# The five a person acts on differently are auth / quota / policy /
# unavailable / bad_request; the rest sharpen the remedy for an operator.
E_NOT_CONFIGURED = "not_configured"   # no key on this worker        → operator adds the key
E_AUTH = "auth"                       # key rejected                  → operator replaces the key
E_QUOTA = "quota"                     # vendor balance / plan empty   → operator tops up the vendor
E_RATE_LIMITED = "rate_limited"       # slow down                     → retry later, same task
E_BAD_REQUEST = "bad_request"         # the request itself is wrong   → user changes the input
E_POLICY = "policy"                   # vendor safety refusal         → user changes the prompt
E_NOT_FOUND = "not_found"             # model / task id unknown       → registry entry is stale
E_UNAVAILABLE = "unavailable"         # vendor 5xx, outage, network   → retry later, same task
E_BAD_RESPONSE = "bad_response"       # 2xx we do not understand      → adapter needs a fix
ERROR_CODES = (E_NOT_CONFIGURED, E_AUTH, E_QUOTA, E_RATE_LIMITED, E_BAD_REQUEST, E_POLICY,
               E_NOT_FOUND, E_UNAVAILABLE, E_BAD_RESPONSE)
#: Codes worth retrying later with the SAME task / request. Never auth, quota,
#: policy or a bad request — retrying those only spends or fails again.
RETRYABLE = frozenset({E_RATE_LIMITED, E_UNAVAILABLE})

_POLICY_WORDS = ("policy", "safety", "moderat", "sensitive", "nsfw", "prohibited", "inappropriate")
_QUOTA_WORDS = ("insufficient", "balance", "quota", "credit", "billing", "exceeded your", "payment",
                "arrear")


class AdapterError(Exception):
    """A typed failure. ``message`` is safe to store and show: adapters build it
    from status codes and scrubbed vendor text only."""

    def __init__(self, code: str, message: str = "", *, http_status: Optional[int] = None):
        self.code = code if code in ERROR_CODES else E_UNAVAILABLE
        self.message = (message or self.code)[:500]
        self.http_status = http_status
        super().__init__(f"{self.code}: {self.message}")

    @property
    def retryable(self) -> bool:
        return self.code in RETRYABLE


def classify_http(status: int, text: str = "") -> str:
    """The error code for a non-2xx vendor answer. The body decides between
    look-alikes: 429 is an empty balance on some vendors and rate limiting on
    others, 403 is sometimes billing, and 400 is sometimes a safety refusal."""
    low = (text or "").lower()
    if status in (401, 403):
        return E_QUOTA if status == 403 and any(w in low for w in _QUOTA_WORDS) else E_AUTH
    if status == 402:
        return E_QUOTA
    if status == 429:
        return E_QUOTA if any(w in low for w in _QUOTA_WORDS) else E_RATE_LIMITED
    if status == 404:
        return E_NOT_FOUND
    if 400 <= status < 500:
        return E_POLICY if any(w in low for w in _POLICY_WORDS) else E_BAD_REQUEST
    return E_UNAVAILABLE


# Token shapes that must never survive into stored text even when we do not
# know the value (the same shapes tools/queue_worker.py scrubs; duplicated
# because a module must not import the worker's CLI).
_TOKEN_PATTERNS = (
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),  # JWT
    re.compile(r"\bsk-[A-Za-z0-9_-]{12,}"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{20,}"),                                      # Google API key
)
REDACTED = "[redacted]"
_SECRET_NAME = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE|DSN)", re.IGNORECASE)


def env_secrets(env: Mapping[str, str]) -> List[str]:
    """Every value of a secret-named env var (8+ characters). An adapter
    scrubs all of them, not only its own key: the worker env holds every
    vendor's key, and a message must not carry any of them."""
    return [v.strip() for k, v in env.items()
            if v and _SECRET_NAME.search(k) and len(str(v).strip()) >= 8]


def scrub(text: str, secrets: Iterable[str]) -> str:
    """``text`` with every known secret value and every token-shaped string
    removed. A vendor can echo a key back in an error body."""
    out = text or ""
    for s in sorted((s for s in secrets if s and len(s) >= 4), key=len, reverse=True):
        out = out.replace(s, REDACTED)
    for pat in _TOKEN_PATTERNS:
        out = pat.sub(REDACTED, out)
    return out


@dataclass(frozen=True)
class CapabilityRequest:
    """What a caller wants, in registry terms (never vendor field names)."""
    capability: str
    prompt: str = ""
    negative_prompt: str = ""
    aspect_ratio: Optional[str] = None      # "16:9"
    resolution: Optional[str] = None        # "720p" / "4k" (video)
    image_size: Optional[str] = None        # "512" / "1K" / "2K" / "4K" (Gemini image)
    duration_s: Optional[int] = None
    #: An opaque, stable per-end-user id (a hash, never an email) that vendors
    #: ask aggregators to send so abuse is traced to one user, not our account.
    end_user: Optional[str] = None
    voice_id: Optional[str] = None          # TTS
    #: Ask a video model for a soundtrack; None = do not send the vendor flag
    #: at all (a model without audio may reject the field).
    audio: Optional[bool] = None
    #: First-frame / reference images: local paths (sent inline where the
    #: vendor accepts data) or https URLs (for vendors that only fetch URLs).
    input_images: Sequence[str] = ()
    #: Upscale factor (2 or 4); only for ``upscale``.
    scale: Optional[int] = None
    #: The recording a voice tool starts from (0050): local paths the worker
    #: copied from the media library, never a URL from a job row.
    input_media: Sequence[str] = ()
    #: The language a dub is made in (``dub`` only): a base BCP-47 tag the
    #: registry entry lists in ``languages``.
    target_language: Optional[str] = None


@dataclass
class Output:
    """One produced file: bytes already in hand, or a URL to fetch now (vendor
    URLs expire in minutes, so ``fetch`` runs straight after success)."""
    mime: str
    data: Optional[bytes] = field(default=None, repr=False)
    url: Optional[str] = None
    #: Extra headers the download needs (Google's file URIs need the key).
    #: Held in memory only; never serialised, never repr'd, and dropped on any
    #: redirect (see :meth:`HttpAdapter._download`).
    url_headers: Dict[str, str] = field(default_factory=dict, repr=False)


@dataclass
class ProviderTask:
    """A submitted job. ``to_dict`` is what a job row stores: no key, no prompt."""
    adapter: str
    vendor_model: str
    task_id: Optional[str]
    submitted_at: float = field(default_factory=time.time)
    #: Set by synchronous adapters: the job finished inside submit().
    outputs: List[Output] = field(default_factory=list, repr=False)

    def to_dict(self) -> dict:
        return {"adapter": self.adapter, "vendor_model": self.vendor_model,
                "task_id": self.task_id, "submitted_at": self.submitted_at}


@dataclass
class PollResult:
    state: str                                # PENDING | SUCCEEDED | FAILED
    outputs: List[Output] = field(default_factory=list)
    error: Optional[AdapterError] = None
    progress: Optional[float] = None          # only when the vendor reports one


_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
        "video/mp4": ".mp4", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/flac": ".flac"}


def image_mime(path: str) -> str:
    suffix = Path(str(path)).suffix.lower()
    return {".png": "image/png", ".webp": "image/webp"}.get(suffix, "image/jpeg")


def image_b64(path: str) -> str:
    return base64.b64encode(Path(path).read_bytes()).decode("ascii")


def image_data_uri(path: str) -> str:
    """A local image as a data URI (vendors that accept inline images)."""
    return f"data:{image_mime(path)};base64,{image_b64(path)}"


def is_url(value: str) -> bool:
    return str(value).startswith("https://")


def host_of(url: str) -> str:
    try:
        return (urlparse(str(url)).hostname or "").lower()
    except ValueError:
        return ""


def host_is(url: str, domain: str) -> bool:
    """``url`` is https and its host is ``domain`` or a subdomain of it. A
    substring test would accept ``https://evil.example/x.bfl.ai/``."""
    if not str(url).startswith("https://"):
        return False
    host = host_of(url)
    return host == domain or host.endswith("." + domain)


class HttpAdapter:
    """Shared plumbing: keys from env, JSON calls that raise typed errors, and
    downloads. Subclasses set ``key``, ``key_env`` and ``default_base_url``."""

    key = ""                               # registry "adapter" value
    key_env: Sequence[str] = ()            # first non-empty env var wins
    base_url_env = ""
    default_base_url = ""
    #: Registry capabilities this adapter can serve at all.
    capabilities: Sequence[str] = ()
    #: Capabilities for which pictures beyond the job's own source are sent
    #: to the vendor as style / subject references (0048: a style kit's and
    #: @characters' pictures). Off unless the vendor call is documented to
    #: take several images for that capability: an adapter that would drop
    #: them, or read them as a first frame, must never receive them.
    reference_capabilities: Sequence[str] = ()
    timeout = 60

    def __init__(self, *, env: Optional[Mapping[str, str]] = None, session=None):
        self._env = env if env is not None else os.environ
        self.session = session if session is not None else requests.Session()
        override = (self._env.get(self.base_url_env, "") if self.base_url_env else "").strip()
        # An override that is not https would send the key in clear text.
        self.base_url = (override if override.startswith("https://") else self.default_base_url).rstrip("/")

    # -- configuration --------------------------------------------------------
    def api_key(self) -> str:
        for name in self.key_env:
            v = (self._env.get(name) or "").strip()
            if v:
                return v
        return ""

    def configured(self) -> bool:
        return bool(self.api_key())

    def secrets(self) -> List[str]:
        """Every value this adapter must never let into a message: its own
        key(s), however short, and every secret-named value in the env."""
        own = [v for v in ((self._env.get(n) or "").strip() for n in self.key_env) if v]
        return own + env_secrets(self._env)

    def auth_headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key()}"}

    def require_key(self) -> None:
        if not self.configured():
            raise AdapterError(E_NOT_CONFIGURED,
                               f"no API key on this worker (set {' or '.join(self.key_env)})")

    # -- request validation ---------------------------------------------------
    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        """Why this request cannot be served by ``entry`` — empty when it can.
        Pure: reads the registry entry, calls nothing."""
        out: List[str] = []
        if request.capability not in self.capabilities:
            out.append(f"adapter {self.key} cannot do {request.capability}")
        out.extend(entry.problems(request))
        return out

    # -- HTTP -------------------------------------------------------------------
    def _call(self, method: str, url: str, *, what: str, json_body=None, params=None,
              headers=None, files=None, data=None, timeout: Optional[int] = None,
              raw: bool = False):
        h = dict(self.auth_headers())
        if headers:
            h.update(headers)
        try:
            resp = self.session.request(method, url, json=json_body, params=params, headers=h,
                                        files=files, data=data, timeout=timeout or self.timeout)
        except requests.RequestException as e:
            # Only the exception's class: its text can carry the request.
            raise AdapterError(E_UNAVAILABLE, f"{what}: {type(e).__name__}") from None
        status = getattr(resp, "status_code", 200)
        if status >= 300:
            text = scrub(getattr(resp, "text", "") or "", self.secrets())
            code = self.vendor_error_code(status, text) or classify_http(status, text)
            raise AdapterError(code, f"{what}: HTTP {status} {text[:300]}", http_status=status)
        if raw:
            return resp
        try:
            return resp.json()
        except (ValueError, json.JSONDecodeError):
            raise AdapterError(E_BAD_RESPONSE, f"{what}: response is not JSON") from None

    def vendor_error_code(self, status: int, text: str) -> Optional[str]:
        """A vendor's own error vocabulary, when it has one that is sharper
        than the HTTP status (override per adapter). None = use the status."""
        return None

    def message(self, text) -> str:
        """Vendor text made safe to store."""
        return scrub(str(text or ""), self.secrets())[:300]

    def post(self, url: str, body: dict, *, what: str = "submit", **kw):
        return self._call("POST", url, json_body=body, what=what, **kw)

    def get(self, url: str, *, what: str = "poll", **kw):
        return self._call("GET", url, what=what, **kw)

    # -- the adapter protocol -----------------------------------------------------
    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:  # pragma: no cover
        raise NotImplementedError

    def poll(self, task: ProviderTask) -> PollResult:
        """Default for synchronous adapters: submit already produced the outputs."""
        if task.outputs:
            return PollResult(SUCCEEDED, list(task.outputs))
        raise AdapterError(E_NOT_FOUND, "a synchronous task has nothing to poll")

    def fetch(self, result: PollResult, out_dir, stem: str = "output") -> List[Path]:
        """Write every output under ``out_dir``; returns the files. Raises on a
        failed download (the job stays resumable: the vendor already has it)."""
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        paths: List[Path] = []
        for i, item in enumerate(result.outputs):
            dest = out_dir / f"{stem}_{i}{_EXT.get(item.mime, '.bin')}"
            if item.data is not None:
                dest.write_bytes(item.data)
            elif item.url:
                if not is_url(item.url):
                    raise AdapterError(E_BAD_RESPONSE, "output URL is not https")
                self._download(item.url, dest, item.url_headers)
            else:
                raise AdapterError(E_BAD_RESPONSE, "output has neither data nor url")
            if not dest.exists() or dest.stat().st_size == 0:
                raise AdapterError(E_BAD_RESPONSE, "downloaded file is empty")
            paths.append(dest)
        return paths

    def _download(self, url: str, dest: Path, headers: Optional[Dict[str, str]] = None,
                  _hops: int = 0) -> None:
        # Redirects are followed by hand: requests drops only ``Authorization``
        # on a cross-host redirect, so a key in any other header (Google's
        # x-goog-api-key) would ride along to wherever the vendor points us.
        # The key goes to the first URL only; every hop after it gets none.
        try:
            with self.session.get(url, stream=True, timeout=max(self.timeout, 120),
                                  headers=headers or None, allow_redirects=False) as resp:
                status = getattr(resp, "status_code", 200)
                if status in (301, 302, 303, 307, 308):
                    location = (getattr(resp, "headers", {}) or {}).get("Location") or ""
                    nxt = urljoin(url, location)
                    if not is_url(nxt) or _hops >= 5:
                        raise AdapterError(E_BAD_RESPONSE, "download: unsafe or looping redirect")
                    self._download(nxt, dest, None, _hops + 1)
                    return
                if status >= 300:
                    raise AdapterError(classify_http(status), f"download: HTTP {status}",
                                       http_status=status)
                with open(dest, "wb") as fh:
                    for chunk in resp.iter_content(chunk_size=1 << 16):
                        if chunk:
                            fh.write(chunk)
        except requests.RequestException as e:
            raise AdapterError(E_UNAVAILABLE, f"download: {type(e).__name__}") from None


def b64_output(data: str, mime: str) -> Output:
    try:
        raw = base64.b64decode(data, validate=False)
    except (ValueError, TypeError):
        raise AdapterError(E_BAD_RESPONSE, "output is not valid base64") from None
    if not raw:
        raise AdapterError(E_BAD_RESPONSE, "output is empty")
    return Output(mime=mime, data=raw)


def dig(obj, *path):
    """``obj[path[0]][path[1]]…`` or None — vendor JSON is nested and optional."""
    cur = obj
    for key in path:
        if isinstance(key, int):
            if not isinstance(cur, list) or len(cur) <= key:
                return None
            cur = cur[key]
        else:
            if not isinstance(cur, dict):
                return None
            cur = cur.get(key)
    return cur


def json_body(text: str) -> dict:
    """An error body as a dict, or {} when it is not JSON."""
    try:
        data = json.loads(text or "{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}
