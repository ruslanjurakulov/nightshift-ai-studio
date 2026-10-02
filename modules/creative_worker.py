"""The creative worker: run ``creative_jobs`` (migration 0036) one at a time
per thread — claim, pay, submit, poll, store, settle.

    claim_creative_job            the database hands this worker one job
    start_credit_reservation      the hold that pays for it (0020), checked
                                  under NIGHTSHIFT_CREDITS_ENFORCE
    advance 'submitting'          recorded BEFORE the billable provider call
    adapter.submit()              the one paid call; returns the task id
    advance 'submitted'           the task id stored BEFORE any polling
    adapter.poll()                until the provider is done
    advance 'processing'          files are being stored
    finish_creative_job           capture <= the hold on success, release on
                                  failure — in the database, one transaction

Never paying twice
------------------
A worker that dies after ``submitted`` leaves the task id on the row; the next
claim hands the job back as ``provider_pending`` and this worker POLLS that
task — it never calls ``submit`` for a job that already has a task id. A worker
that dies between ``submitting`` and ``submitted`` leaves the provider's state
unknown; the database fails that job (``submit_interrupted``) and releases the
customer's hold rather than risk a second paid submit.

No silent substitution
----------------------
EXACT mode (the model the person picked, CLAUDE.md #4): the job's adapter is
resolved for ``requested_model`` and nothing else, and any failure fails the
job with the provider's code. There is no second model, ever.

Routed modes (migration 0075: auto / cheap / fast / quality) run the job's
``routed_model`` — the model the person's quote named and confirmed. Only
when that model's side refuses the submit before any task exists (``FAILOVER_CODES``:
unavailable, rate limited, the platform's vendor quota or key, no adapter on
this worker) does the worker ask the DATABASE for the next compatible model
(``reroute_creative_job``: same settings, of the same tier for quality, no
dearer than the hold, at most ``MAX_FAILOVERS`` times). The database records
``fallback_from`` / ``fallback_reason``; the worker submits a NEW task for the
new model (a task id never crosses models). A refusal of the request itself
(policy, bad request), a failure after the task exists, and no compatible
model all fail the job and release its hold, as in exact mode.

The adapter seam
----------------
The provider adapters live in the capability layer (``modules/capabilities``,
built separately). This module needs only :class:`CreativeAdapter` — ``submit``
and ``poll`` — and a ``resolve_adapter(model_id)`` function handed to
:class:`CreativeWorker`. ``tools/creative_worker.py`` loads that function from
``NIGHTSHIFT_CREATIVE_ADAPTERS`` (``module:function``); the tests pass fakes.

Inputs from the media library (migration 0046)
-----------------------------------------------
``edit``, ``i2v``, ``upscale`` and ``remove_bg`` start from a picture the
organization owns (``params.source_asset_id``). The database checked it when
the job was created; the worker asks again right before the paid call
(``creative_job_source`` — for the job it holds, in the JOB's organization, so
a picture deleted since is refused) and copies the file from the media volume
by its id alone (``media_library.copy_source``). A source that cannot be read
fails the job with ``source_unavailable`` and releases the hold. Nothing about
the file's location is stored or logged.

Recordings for the voice tools (migration 0050)
-----------------------------------------------
``voice_change`` and ``dub`` start from an audio or video file of the
organization (``params.source_asset_id`` again). The same
``creative_job_source`` answer names it, and it is copied by id like a
picture — but only as a recording (``media_library.copy_source(media=True)``),
so a picture tool can never be handed one, nor a voice tool a picture. The
price was the recording's length as the DATABASE measured it (0050); the
worker reports that same quantity as the provider's usage.

Video tools (migration 0052)
----------------------------
``video_upscale`` starts from a VIDEO of the organization: copied by id like a
recording, and refused unless the database's answer says it is a video — a
recording tool's audio never reaches it. Its price was the video's length as
the database measured it, reported back as the provider's usage. An ``i2v``
may also name an END frame (``params.end_asset_id``): the same
``creative_job_source`` answer re-checks it for the job's organization and it
is copied by id like the first picture; an answer without it (a database
without 0052) fails the job before any call — the clip is never made without
the ending the person paid for.

Describing a picture (migration 0055)
-------------------------------------
``describe`` starts from a picture of the organization like the picture tools
(``params.source_asset_id``, the same ``creative_job_source`` answer, copied by
id) and produces TEXT: a generation prompt for that picture. The adapter's one
``text/plain`` output is read here, cleaned again (``modules/describe_text``:
no instruction-like sentences, no addresses, at most 600 characters) and stored
on the job row as ``result.text`` — never as a library asset (0055's CHECK
refuses one). Nothing usable left fails the job (``bad_response``) and
releases the hold: an empty answer is never charged.

Captions (migration 0072)
------------------------
``captions`` starts from a recording of the organization like the voice tools
(``params.source_asset_id``, copied by id as a recording) and produces DATA:
the words the provider heard, each with its start and end second. The
adapter's one ``application/json`` output is read here, cleaned again
(``modules/captions``: words only, control and bidi characters removed, times
forward and inside the recording, nothing kept past 20 000 words) and stored
by ``store_caption_track`` — in the JOB's organization, for the job this
worker holds. The job row keeps only the track's id. A recording with no
speech, or nothing usable left, fails the job (``no_speech`` /
``bad_response``) and releases the hold: an empty transcript is never charged.
The price was the recording's length as the DATABASE measured it, reported
back as the provider's usage.

Style kits and @characters (migration 0048)
-------------------------------------------
``t2i``, ``t2v``, ``edit`` and ``i2v`` may name a style kit
(``params.style_kit_id``) and mention characters by ``@name``. Right before the
paid call the worker reads them for the job it holds (``creative_job_style``,
in the JOB's organization), checks the answer again in code, appends their
descriptions to the prompt it sends (the stored prompt is never changed) and
hands their reference pictures — copied by id like a source — only to an
adapter that declares it takes references (``modules/creative_style.py``). A
kit deleted since, an answer that is not the job's organization's, or a style
the model could not use at all fails the job with ``style_unavailable`` and
releases the hold.

Outputs into the library
------------------------
With a media volume configured, each output becomes a library asset of the
job's organization (``source='generated'``, provenance: the job, model and
source; an edit / upscale / cut-out is a new version of its source), and
``attach_creative_job_assets`` records them on the job before it is settled.
If the library cannot take them the job still completes: the files stay in
the worker's job folder (``storage: worker``), as before 0046.

Nothing here logs a key, a token, a prompt or a provider response body: stored
error text goes through the scrubber the CLI provides.
"""

from __future__ import annotations

import hashlib
import logging
import mimetypes
import re
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, List, Mapping, Optional, Protocol, Sequence, Tuple

from modules import creative_style as cs
from modules import credits as credit_rules
from modules import media_library as ml
from modules.captions import CaptionsError, base_language, clean_words
from modules.describe_text import clean_description

logger = logging.getLogger("creative_worker")

PENDING = "pending"
SUCCEEDED = "succeeded"
FAILED = "failed"

#: Error codes worth polling again for (the task is still the provider's).
RETRYABLE_POLL_CODES = frozenset({"network", "provider_error", "rate_limited", "unavailable"})
#: The routed modes (migration 0075); exact is never routed.
ROUTED_MODES = frozenset({"auto", "cheap", "fast", "quality"})
#: Submit refusals that are the MODEL's side, before any task exists: a routed
#: job may move to the next compatible model (the database decides which).
#: Never policy or bad_request (the request itself), never a timeout or a
#: failure after the task id is stored. The database checks the same list.
FAILOVER_CODES = frozenset({"unavailable", "rate_limited", "quota", "auth", "not_configured", "not_found",
                            "adapter_missing"})
#: At most this many failovers per job (the database allows no more either).
MAX_FAILOVERS = 2
#: Consecutive poll errors before a job is given up on.
MAX_POLL_ERRORS = 10
DEFAULT_POLL_SECONDS = 5.0
#: How long a provider task may take before the job is failed and released.
DEFAULT_MAX_POLL_SECONDS = 45 * 60
DEFAULT_HEARTBEAT_SECONDS = 30.0
MAX_ERROR_CHARS = 2000
#: ``module:function`` of the adapter resolver the CLI loads.
ADAPTERS_ENV = "NIGHTSHIFT_CREATIVE_ADAPTERS"
#: Capabilities whose input is a library asset (params.source_asset_id): an
#: image (0046) or, for the voice tools, a recording (0050).
SOURCE_CAPABILITIES = frozenset({"edit", "i2v", "upscale", "remove_bg", "voice_change", "dub", "video_upscale",
                                 "describe", "captions"})
#: Of those, the ones whose input is a file copied whole: a recording (audio
#: or video, 0050) or a video (0052).
MEDIA_SOURCE_CAPABILITIES = frozenset({"voice_change", "dub", "video_upscale", "captions"})
#: Of those, the ones that take a VIDEO and nothing else (0052).
VIDEO_SOURCE_CAPABILITIES = frozenset({"video_upscale"})
#: Of those, the ones whose output is a new version of the input.
VERSION_CAPABILITIES = frozenset({"edit", "upscale", "remove_bg", "video_upscale"})
#: What each capability produces (the library checks the provider's output).
OUTPUT_KIND = {"t2i": "image", "edit": "image", "upscale": "image", "remove_bg": "image",
               "t2v": "video", "i2v": "video", "tts": "audio", "sfx": "audio", "music": "audio",
               "voice_change": "audio", "dub": "audio", "video_upscale": "video", "describe": "text", "captions": "text"}
#: Capabilities whose result is text on the job row, never a library asset (0055).
TEXT_CAPABILITIES = frozenset({"describe"})
#: Capabilities whose result is a caption track in its own table (0072), never a library asset.
CAPTION_CAPABILITIES = frozenset({"captions"})
#: The largest provider answer read for a caption track (20 000 words fit well inside).
CAPTIONS_MAX_BYTES = 8 * 1024 * 1024
#: The languages a description is written in (0055); absent = English.
DESCRIBE_LANGUAGES = ("en", "ru", "uz")
#: Library asset ids of a job's outputs are derived from the job id, so a
#: retried store reuses the same rows instead of adding copies.
ASSET_NS = uuid.UUID("5b0c1d1e-0046-4c2e-9a7e-c4ea71e0a55e")

_CODE_RE = re.compile(r"^[a-z0-9_]{1,64}$")


# ── the seam to the capability layer ────────────────────────────────────────

@dataclass(frozen=True)
class GenerationRequest:
    """What the job asks for, as the database validated it (0036)."""
    job_id: str
    org_id: str
    capability: str
    model: str
    params: Mapping[str, Any]
    #: Local copies of the job's input pictures (0046), made by the worker
    #: from the media library just before submit. Empty when resuming a task.
    input_files: Tuple[Path, ...] = ()
    #: The prompt to send when the worker built one (0048: the style guide
    #: appended); None = ``params.prompt`` as stored.
    prompt: Optional[str] = None
    #: Style / character reference pictures (0048), local copies, sent after
    #: ``input_files`` — only ever to an adapter that takes references.
    reference_files: Tuple[Path, ...] = ()
    #: What the style added, for the job's result (counts only).
    style: Optional[Mapping[str, Any]] = None
    #: The quantity the DATABASE priced the job at (creative_jobs.quantity):
    #: for the voice tools, the recording's seconds — never a client's number.
    quantity: Optional[float] = None
    #: The picture an i2v clip ends on (0052), a local copy; None = no end frame.
    end_file: Optional[Path] = None
    #: The source picture's pixel size as the library recorded it (width,
    #: height) — a description keeps it so "Make similar" can pick the shape.
    source_size: Optional[Tuple[int, int]] = None
    #: The recording's length as the library measured it (captions, 0072): words
    #: are kept inside it.
    source_duration_s: Optional[float] = None


@dataclass(frozen=True)
class ProviderUsage:
    """What the provider charged the platform, for creative_job_costs (0037).
    ``usd`` stays None unless a price was configured; then ``price_source``
    says where it came from."""
    provider: str
    vendor_model: Optional[str] = None
    unit: Optional[str] = None
    quantity: Optional[float] = None
    usd: Optional[float] = None
    price_source: Optional[str] = None
    route: Optional[str] = None


@dataclass
class ProviderPoll:
    """One look at a submitted task. On SUCCEEDED the adapter has written the
    outputs under the ``out_dir`` it was given and lists them in ``files``."""
    state: str
    files: List[Path] = field(default_factory=list)
    error_code: Optional[str] = None
    error: Optional[str] = None
    usage: Optional[ProviderUsage] = None


class CreativeAdapter(Protocol):
    def submit(self, request: GenerationRequest) -> str:
        """Start the (billable) task; return the provider's task id. Raise on
        failure — an exception with a ``code`` attribute names the reason."""

    def poll(self, task_id: str, request: GenerationRequest, out_dir: Path) -> ProviderPoll:
        """Look at the task. Never submits. On success, write the outputs
        into ``out_dir`` and return them."""


AdapterResolver = Callable[[str], Optional[CreativeAdapter]]


# ── the database (PostgREST, service key) ───────────────────────────────────

class CreativeUnavailable(RuntimeError):
    """The 0036 functions could not be reached. Never carries a key or body."""


class CreativeFunctionMissing(CreativeUnavailable):
    """PostgREST answered 404: the function is not there (its migration is not
    applied). Retrying will not help, unlike a database out of reach."""


class CreativeRest:
    """The worker's 0036/0037 functions over Supabase REST with the service
    key. Every write is a security-definer function that checks the worker id,
    so a job re-queued away from this worker ignores its late calls."""

    def __init__(self, url: str, service_key: str, *, timeout: float = 20.0, session=None):
        import requests  # noqa: PLC0415 — keep the tests import-light

        self.url = url.rstrip("/")
        self._key = service_key
        self._timeout = timeout
        self._http = session or requests.Session()
        # The job's thread and its heartbeat thread share this client; a
        # Session is not promised to be thread-safe.
        self._lock = threading.Lock()

    def _rpc(self, name: str, body: dict):
        try:
            with self._lock:
                r = self._http.post(
                    f"{self.url}/rest/v1/rpc/{name}", json=body, timeout=self._timeout,
                    headers={"apikey": self._key, "Authorization": f"Bearer {self._key}",
                             "Content-Type": "application/json"},
                )
        except Exception as e:
            raise CreativeUnavailable(f"{name}: {type(e).__name__}") from None
        if r.status_code == 404:
            raise CreativeFunctionMissing(f"{name}: HTTP 404 (is its migration applied?)")
        if r.status_code >= 300:
            raise CreativeUnavailable(f"{name}: HTTP {r.status_code} (is migration 0036 applied?)")
        try:
            return r.json()
        except ValueError:
            return None

    def claim(self, worker_id: str, stale_minutes: int = 10) -> Optional[dict]:
        rows = self._rpc("claim_creative_job",
                         {"p_worker": worker_id, "p_stale_after": f"{int(stale_minutes)} minutes"})
        if isinstance(rows, dict):
            rows = [rows]
        return rows[0] if rows else None

    def heartbeat(self, job_id: str, worker_id: str) -> Optional[bool]:
        return bool(self._rpc("heartbeat_creative_job", {"p_job": job_id, "p_worker": worker_id}))

    def advance(self, job_id: str, worker_id: str, step: str, task_id: Optional[str] = None,
                route: Optional[dict] = None) -> bool:
        return bool(self._rpc("advance_creative_job", {
            "p_job": job_id, "p_worker": worker_id, "p_step": step,
            "p_provider_task_id": task_id, "p_route": route}))

    def finish(self, job_id: str, worker_id: str, ok: bool, *, charge: Optional[float] = None,
               result: Optional[dict] = None, error_code: Optional[str] = None,
               error: Optional[str] = None) -> Optional[dict]:
        return self._rpc("finish_creative_job", {
            "p_job": job_id, "p_worker": worker_id, "p_ok": ok, "p_charge": charge,
            "p_result": result, "p_error_code": error_code, "p_error": error})

    def expire(self) -> Optional[int]:
        return self._rpc("expire_creative_jobs", {})

    def reroute(self, job_id: str, worker_id: str, code: str) -> Optional[dict]:
        """The database's next compatible model for a routed job (0075), or
        None: no failover (a database without 0075 has none either)."""
        try:
            out = self._rpc("reroute_creative_job", {"p_job": job_id, "p_worker": worker_id, "p_code": code})
        except CreativeFunctionMissing:
            return None
        return out if isinstance(out, dict) else None

    def job_source(self, job_id: str, worker_id: str) -> Optional[dict]:
        out = self._rpc("creative_job_source", {"p_job": job_id, "p_worker": worker_id})
        return out if isinstance(out, dict) else None

    def job_style(self, job_id: str, worker_id: str) -> Optional[dict]:
        out = self._rpc("creative_job_style", {"p_job": job_id, "p_worker": worker_id})
        return out if isinstance(out, dict) else None

    def store_caption_track(self, job_id: str, worker_id: str, language: str, duration_s: float,
                            words: Sequence[Mapping[str, Any]]) -> Optional[str]:
        """0072: the words of the captions job this worker holds; the track's id."""
        out = self._rpc("store_caption_track", {
            "p_job": job_id, "p_worker": worker_id, "p_language": language,
            "p_duration_s": duration_s, "p_words": list(words)})
        return out if isinstance(out, str) and out else None

    def attach_assets(self, job_id: str, worker_id: str, asset_ids: Sequence[str]) -> bool:
        return bool(self._rpc("attach_creative_job_assets", {
            "p_job": job_id, "p_worker": worker_id, "p_assets": list(asset_ids)}))

    def record_cost(self, job_id: str, usage: ProviderUsage) -> None:
        self._rpc("record_creative_job_cost", {
            "p_job": job_id, "p_provider": usage.provider, "p_route": usage.route,
            "p_vendor_model": usage.vendor_model, "p_unit": usage.unit,
            "p_quantity": usage.quantity, "p_usd": usage.usd, "p_price_source": usage.price_source})


# ── helpers ─────────────────────────────────────────────────────────────────

def error_code_of(exc: BaseException, default: str = "provider_error") -> str:
    code = getattr(exc, "code", None)
    return code if isinstance(code, str) and _CODE_RE.match(code) else default


def error_text_of(exc: BaseException) -> str:
    msg = getattr(exc, "message", None)
    return str(msg if isinstance(msg, str) and msg else exc) or type(exc).__name__


def describe_files(files: Sequence[Path]) -> List[dict]:
    """What the job row keeps about each output: name, type, size, digest —
    never an absolute path (the file is found from the job id)."""
    out = []
    for f in files:
        p = Path(f)
        digest = hashlib.sha256()
        with p.open("rb") as fh:  # a video can be large: never whole in memory
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                digest.update(chunk)
        out.append({
            "name": p.name,
            "mime": mimetypes.guess_type(p.name)[0] or "application/octet-stream",
            "bytes": p.stat().st_size,
            "sha256": digest.hexdigest(),
        })
    return out


def _pixel_size(info: Mapping[str, Any]) -> Optional[Tuple[int, int]]:
    """The source's (width, height) as the library recorded it, when both are
    whole positive numbers; else None (a description then leaves the shape out)."""
    w, h = info.get("width"), info.get("height")
    ok = all(isinstance(v, int) and not isinstance(v, bool) and v > 0 for v in (w, h))
    return (int(w), int(h)) if ok else None


def _duration_s(info: Mapping[str, Any]) -> Optional[float]:
    """The source's length in seconds as the library recorded it, when it is a
    positive number; else None."""
    d = info.get("duration_s")
    try:
        f = float(d)
    except (TypeError, ValueError):
        return None
    return f if f > 0 and f == f and f != float("inf") else None


class _Refused(Exception):
    """The job must end now, without a provider call; ``code`` is stored."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class _Heartbeat:
    """Refreshes heartbeat_at while a job runs; notes when the job stops being
    this worker's (re-queued after a stall, or cancelled)."""

    def __init__(self, queue, job_id: str, worker_id: str, every: float):
        self.lost = threading.Event()
        self._stop = threading.Event()
        self._args = (queue, job_id, worker_id)
        self._every = every
        self._thread: Optional[threading.Thread] = None

    def __enter__(self):
        if self._every > 0:
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()
        return self

    def _run(self):
        queue, job_id, worker_id = self._args
        while not self._stop.wait(self._every):
            try:
                if queue.heartbeat(job_id, worker_id) is False:
                    self.lost.set()
                    return
            except Exception as e:  # a missed beat is not a lost job
                logger.warning("job %s: heartbeat failed (%s)", job_id, type(e).__name__)

    def __exit__(self, *exc):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        return False


# ── the media library (0046) ────────────────────────────────────────────────

@dataclass
class Library:
    """Where generated outputs become library assets: the 0038 functions
    (``register_asset``, service key) and the media volume, writable here.
    ``tools`` (ffprobe / ffmpeg) add dimensions and thumbnails when present."""
    store: Any
    media_root: Path
    tools: Optional[Any] = None


# ── the worker ──────────────────────────────────────────────────────────────

class CreativeWorker:
    def __init__(self, queue, resolve_adapter: AdapterResolver, *, worker_id: str,
                 out_dir: Path, credits=None, enforce: bool = False,
                 media_root: Optional[Path] = None, library: Optional[Library] = None,
                 scrub: Callable[[str], str] = lambda s: s,
                 poll_seconds: float = DEFAULT_POLL_SECONDS,
                 max_poll_seconds: float = DEFAULT_MAX_POLL_SECONDS,
                 heartbeat_seconds: float = DEFAULT_HEARTBEAT_SECONDS,
                 stale_minutes: int = 10,
                 stop: Optional[threading.Event] = None,
                 sleep: Callable[[float], None] = time.sleep,
                 clock: Callable[[], float] = time.monotonic):
        self.queue = queue
        self.resolve_adapter = resolve_adapter
        #: The media volume source pictures are read from (read-only is enough).
        self.media_root = Path(media_root) if media_root is not None else None
        self.library = library
        self.worker_id = worker_id
        self.out_dir = Path(out_dir)
        self.credits = credits
        self.enforce = enforce
        self.scrub = scrub
        self.poll_seconds = poll_seconds
        self.max_poll_seconds = max_poll_seconds
        self.heartbeat_seconds = heartbeat_seconds
        self.stale_minutes = stale_minutes
        self.stop = stop or threading.Event()
        self.sleep = sleep
        self.clock = clock

    # -- one job ---------------------------------------------------------------

    def run_once(self) -> bool:
        """Claim and run at most one job. False when the queue was empty."""
        job = self.queue.claim(self.worker_id, self.stale_minutes)
        if not job:
            return False
        self.process(job)
        return True

    def process(self, job: Mapping[str, Any]) -> str:
        """Run one claimed job to its end. Returns what happened, for logs."""
        job_id = str(job["id"])
        with _Heartbeat(self.queue, job_id, self.worker_id, self.heartbeat_seconds) as beat:
            try:
                return self._process(job, beat)
            except _Refused as r:
                self._fail(job_id, r.code, r.message)
                return f"failed:{r.code}"
            except CreativeUnavailable as e:
                # The database is out of reach: nothing can be recorded now.
                # The heartbeat stops, and the claim's stale sweep re-queues
                # the job (its stored task id is polled, never re-submitted)
                # or, if the task id never got stored, fails and releases it.
                logger.warning("job %s: %s; left for the stale sweep", job_id, e)
                return "left"
            except Exception as e:  # the worker must outlive any one job
                logger.error("job %s: unexpected %s", job_id, type(e).__name__)
                self._fail(job_id, "worker_error", f"the worker hit an unexpected {type(e).__name__}")
                return "failed:worker_error"

    def _process(self, job: Mapping[str, Any], beat: _Heartbeat) -> str:
        job_id = str(job["id"])
        mode = str(job.get("mode") or "exact")
        if mode != "exact" and mode not in ROUTED_MODES:
            raise _Refused("mode_not_supported", "this worker runs exact and routed jobs only")
        if (job.get("payer") or "credits") != "credits":
            raise _Refused("payer_not_supported", "this worker settles credit-paid jobs only")
        self._check_hold(job)

        # EXACT: the model the person picked. Routed: the model the database
        # routed the job to (the quoted pick, or a failover it recorded).
        model = str(job.get("requested_model") or "") if mode == "exact" else str(job.get("routed_model") or "")
        if not model:
            raise _Refused("mode_not_supported", "a routed job without its routed model is not run")
        try:
            quantity = float(job["quantity"]) if job.get("quantity") is not None else None
        except (TypeError, ValueError):
            quantity = None
        request = GenerationRequest(job_id=job_id, org_id=str(job.get("org_id") or ""),
                                    capability=str(job.get("capability") or ""), model=model,
                                    params=dict(job.get("params") or {}), quantity=quantity)
        task_id = job.get("provider_task_id")
        if task_id:
            # Resuming: the task is this model's; it is polled, never moved.
            adapter = self.resolve_adapter(model)
            if adapter is None:
                raise _Refused("adapter_missing", f"this worker has no adapter for {model}")
            return self._poll(job, request, adapter, str(task_id), beat)

        if request.capability in SOURCE_CAPABILITIES:
            # Before 'submitting': a refusal here costs nobody anything.
            info = self._source_answer(request)
            request = replace(request, input_files=(self._source(request, info),),
                              source_size=_pixel_size(info), source_duration_s=_duration_s(info))
            if request.params.get("end_asset_id"):
                request = replace(request, end_file=self._end_frame(request, info))
        base = request
        failovers = 0
        while True:
            try:
                # The model's adapter, or nothing — never another model unless
                # the DATABASE moved a routed job (below).
                adapter = self.resolve_adapter(model)
                if adapter is None:
                    raise _Refused("adapter_missing", f"this worker has no adapter for {model}")
                request = replace(base, model=model)
                if cs.wants_style(request.capability, request.params):
                    request = self._style(request, adapter)
                if not self.queue.advance(job_id, self.worker_id, "submitting"):
                    logger.warning("job %s: not ours to submit any more; leaving it", job_id)
                    return "left"
                try:
                    task_id = adapter.submit(request)
                except Exception as e:
                    raise _Refused(error_code_of(e), error_text_of(e)) from None
                break
            except _Refused as r:
                moved = self._failover(job_id, mode, r.code, failovers)
                if moved is None:
                    raise
                logger.info("job %s: %s answered %s; the database moved the job to %s", job_id, model, r.code,
                            moved["model"])
                model, base, failovers = moved["model"], replace(base, params=moved["params"]), failovers + 1
        if not task_id or not isinstance(task_id, str):
            raise _Refused("bad_response", "the provider accepted the job without a task id")
        if not self.queue.advance(job_id, self.worker_id, "submitted", task_id,
                                  {"model": model}):
            logger.error("job %s: the task id could not be stored; leaving it", job_id)
            return "left"
        return self._poll(job, request, adapter, str(task_id), beat)

    def _failover(self, job_id: str, mode: str, code: str, failovers: int) -> Optional[dict]:
        """A routed job whose model refused the submit (FAILOVER_CODES): the
        database's next compatible model and the params it priced, or None.
        Exact never asks; nothing here picks a model."""
        if mode not in ROUTED_MODES or code not in FAILOVER_CODES or failovers >= MAX_FAILOVERS:
            return None
        reroute = getattr(self.queue, "reroute", None)
        if not callable(reroute):
            return None
        moved = reroute(job_id, self.worker_id, code)
        if not isinstance(moved, dict) or not isinstance(moved.get("model"), str) or not moved["model"]:
            return None
        params = moved.get("params")
        if not isinstance(params, dict):
            # Without the settings the database priced, nothing is sent.
            return None
        return {"model": moved["model"], "params": dict(params)}

    def _source_answer(self, request: GenerationRequest) -> dict:
        """The database's answer about the job's inputs (for this worker's
        job, in the job's organization), re-checked right before the call."""
        if self.media_root is None:
            raise _Refused("source_unavailable", "this worker cannot read the media library")
        info = self.queue.job_source(request.job_id, self.worker_id)
        if not isinstance(info, dict) or info.get("ok") is not True:
            problem = (info or {}).get("problem") if isinstance(info, dict) else None
            raise _Refused("source_unavailable", str(problem or "the source cannot be used"))
        return info

    def _source(self, request: GenerationRequest, info: Mapping[str, Any]) -> Path:
        """The job's input picture (or, for a voice tool, its recording; for a
        video tool, its video), copied into its folder. The path comes from
        the asset id alone."""
        try:
            aid = ml.canonical_id(str(info.get("asset_id") or "").lower())
        except ValueError:
            raise _Refused("source_unavailable", "the source cannot be used") from None
        if aid != str(request.params.get("source_asset_id") or "").lower():
            raise _Refused("source_unavailable", "the source cannot be used")
        if request.capability in VIDEO_SOURCE_CAPABILITIES and (
                info.get("kind") != "video" or not str(info.get("mime") or "").startswith("video/")):
            raise _Refused("source_unavailable", "the source must be a video")
        try:
            return ml.copy_source(self.media_root, aid, str(info.get("mime") or ""),
                                  list(info.get("variants") or ()), self.out_dir / request.job_id / "input",
                                  media=request.capability in MEDIA_SOURCE_CAPABILITIES)
        except ml.SourceUnavailable as e:
            raise _Refused("source_unavailable", str(e)) from None
        except OSError as e:
            raise _Refused("source_unavailable", f"the source could not be read ({type(e).__name__})") from None

    def _end_frame(self, request: GenerationRequest, info: Mapping[str, Any]) -> Path:
        """The picture an i2v ends on (0052), named by the same database
        answer as the first frame and copied by its id like it."""
        end = info.get("end_frame")
        if request.capability != "i2v" or not isinstance(end, dict):
            raise _Refused("source_unavailable", "the end frame cannot be used on this deployment yet")
        try:
            aid = ml.canonical_id(str(end.get("asset_id") or "").lower())
        except ValueError:
            raise _Refused("source_unavailable", "the end frame cannot be used") from None
        if aid != str(request.params.get("end_asset_id") or "").lower():
            raise _Refused("source_unavailable", "the end frame cannot be used")
        try:
            return ml.copy_source(self.media_root, aid, str(end.get("mime") or ""), list(end.get("variants") or ()),
                                  self.out_dir / request.job_id / "input", name="end")
        except ml.SourceUnavailable as e:
            raise _Refused("source_unavailable", f"the end frame cannot be used: {e}") from None
        except OSError as e:
            raise _Refused("source_unavailable", f"the end frame could not be read ({type(e).__name__})") from None

    def _style(self, request: GenerationRequest, adapter: CreativeAdapter) -> GenerationRequest:
        """The job's style kit and mentioned characters, applied to the request
        (module doc). Before 'submitting': a refusal here costs nobody anything."""
        try:
            info = self.queue.job_style(request.job_id, self.worker_id)
        except CreativeFunctionMissing:
            # 0048 not applied: say so and release the hold now, rather than
            # leave the job to be re-claimed until its attempts run out.
            raise _Refused("style_unavailable", "style kits and characters cannot be used for generations "
                                                "on this deployment yet") from None
        if not isinstance(info, dict) or info.get("ok") is not True:
            problem = info.get("problem") if isinstance(info, dict) else None
            raise _Refused("style_unavailable", str(problem or "the style kit cannot be used"))
        prompt = str(request.params.get("prompt") or "")
        try:
            inputs = cs.parse_answer(info, org_id=request.org_id,
                                     kit_id=request.params.get("style_kit_id"), prompt=prompt)
        except cs.StyleProblem as e:
            logger.warning("job %s: the style answer was refused (%s)", request.job_id, e)
            raise _Refused("style_unavailable", str(e)) from None
        if inputs.empty:
            return request  # only unknown @names: the prompt goes as typed
        support_of = getattr(adapter, "style_support", None)
        support = support_of(request) if callable(support_of) else cs.StyleSupport()
        picked = cs.pick_references(inputs, support.reference_slots)
        lost = cs.unusable(inputs, picked)
        if lost:
            one = len(lost) == 1
            raise _Refused("style_unavailable",
                           f"{' and '.join(lost)} {'has' if one else 'have'} no description and this model "
                           f"cannot use {'its' if one else 'their'} pictures; add a description or pick a "
                           "model that takes reference pictures")
        text = cs.compose_prompt(prompt, inputs, picked)
        if support.max_prompt_chars and cs.prompt_units(text) > support.max_prompt_chars:
            raise _Refused("style_unavailable",
                           f"the prompt with the style and character descriptions is longer than this model "
                           f"takes ({support.max_prompt_chars} characters); shorten the prompt or the descriptions")
        files: List[Path] = []
        if picked:
            if self.media_root is None:
                raise _Refused("style_unavailable", "this worker cannot read the reference pictures")
            dest = self.out_dir / request.job_id / "input"
            for i, (_owner, ref) in enumerate(picked):
                try:
                    files.append(ml.copy_source(self.media_root, ref.asset_id, ref.mime, list(ref.variants),
                                                dest, name=f"ref_{i}"))
                except ml.SourceUnavailable as e:
                    raise _Refused("style_unavailable", f"a reference picture cannot be used: {e}") from None
                except (OSError, ValueError) as e:
                    raise _Refused("style_unavailable",
                                   f"a reference picture could not be read ({type(e).__name__})") from None
        return replace(request, prompt=text, reference_files=tuple(files), style=cs.summary(inputs, picked))

    def _check_hold(self, job: Mapping[str, Any]) -> None:
        """The hold must be open before anything is spent (enforced), as for
        render_jobs: a browser cannot create a job without one, but a hold can
        expire between create and claim."""
        org = str(job.get("org_id") or "")
        quoted = float(job.get("quoted_credits") or 0)
        ref = job.get("credit_ref")
        if credit_rules.is_exempt(org) or quoted <= 0:
            return
        if not ref:
            if self.enforce:
                raise _Refused("no_credit_hold", "the job has no credit hold")
            return
        if self.credits is None:
            if self.enforce:
                raise _Refused("credits_unavailable", "this worker cannot check credit holds")
            return
        try:
            amount = self.credits.start(str(ref), org)
        except credit_rules.CreditsUnavailable as e:
            if self.enforce:
                raise _Refused("credits_unavailable", f"credits are unavailable ({e})") from None
            logger.warning("job %s: credits unavailable (%s); enforcement is off", job.get("id"), e)
            return
        if amount is None:
            if self.enforce:
                raise _Refused("hold_not_open", "the credit hold is not open (expired or settled)")
            return
        if self.enforce and float(amount) + 1e-9 < quoted:
            raise _Refused("hold_below_quote", "the credit hold is smaller than the quote")

    def _poll(self, job: Mapping[str, Any], request: GenerationRequest,
              adapter: CreativeAdapter, task_id: str, beat: _Heartbeat) -> str:
        job_id = request.job_id
        job_dir = self.out_dir / job_id
        deadline = self.clock() + self.max_poll_seconds
        errors = 0
        while True:
            if beat.lost.is_set():
                logger.warning("job %s: no longer this worker's; stopped polling", job_id)
                return "left"
            if self.stop.is_set():
                # The task id is stored: the next claim polls it.
                self.queue.advance(job_id, self.worker_id, "requeue")
                return "requeued"
            try:
                result = adapter.poll(task_id, request, job_dir)
                errors = 0
            except Exception as e:
                code = error_code_of(e)
                errors += 1
                if code not in RETRYABLE_POLL_CODES or errors >= MAX_POLL_ERRORS:
                    raise _Refused(code, error_text_of(e)) from None
                result = ProviderPoll(PENDING)
            if result.state == SUCCEEDED:
                return self._store(job, request, result)
            if result.state == FAILED:
                raise _Refused(result.error_code if result.error_code and _CODE_RE.match(result.error_code)
                               else "provider_error", result.error or "the provider failed the task")
            if self.clock() >= deadline:
                raise _Refused("provider_timeout",
                               f"the provider did not finish within {int(self.max_poll_seconds)} s")
            self.sleep(self.poll_seconds)

    def _store(self, job: Mapping[str, Any], request: GenerationRequest, result: ProviderPoll) -> str:
        job_id = request.job_id
        files = [Path(f) for f in result.files]
        if not files or not all(f.is_file() and f.stat().st_size > 0 for f in files):
            # Nothing usable came back: charging for it would be charging for nothing.
            raise _Refused("bad_response", "the provider reported success without an output file")
        if request.capability in TEXT_CAPABILITIES:
            return self._store_text(request, files, result)
        if request.capability in CAPTION_CAPABILITIES:
            return self._store_captions(request, files, result)
        if not self.queue.advance(job_id, self.worker_id, "processing"):
            logger.warning("job %s: no longer this worker's; its outputs are not recorded here", job_id)
            return "left"
        described = describe_files(files)
        asset_ids = self._to_library(request, files, result.usage)
        out = {"files": described, "storage": "library" if asset_ids else "worker"}
        if asset_ids:
            out["asset_ids"] = asset_ids
        if request.style:
            out["style"] = dict(request.style)
        done = self.queue.finish(job_id, self.worker_id, True, result=out)
        if asset_ids:
            # The library holds the outputs now; the job folder is scratch.
            shutil.rmtree(self.out_dir / job_id, ignore_errors=True)
        if result.usage is not None:
            try:
                self.queue.record_cost(job_id, result.usage)
            except Exception as e:  # reporting only; the job is settled
                logger.warning("job %s: provider cost not recorded (%s)", job_id, type(e).__name__)
        status = (done or {}).get("status") if isinstance(done, dict) else None
        return f"completed:{len(described)}" if status in (None, "completed") else str(status)

    def _store_text(self, request: GenerationRequest, files: Sequence[Path], result: ProviderPoll) -> str:
        """A description: the text kept on the job row (module doc). The
        provider's file is scratch; nothing goes to the library."""
        job_id = request.job_id
        try:
            raw = Path(files[0]).read_bytes()[:64 * 1024].decode("utf-8", errors="replace")
        except OSError as e:
            raise _Refused("bad_response", f"the description could not be read ({type(e).__name__})") from None
        text = clean_description(raw)
        if not text:
            raise _Refused("bad_response", "the provider returned no usable description")
        if not self.queue.advance(job_id, self.worker_id, "processing"):
            logger.warning("job %s: no longer this worker's; its description is not recorded here", job_id)
            return "left"
        lang = request.params.get("language")
        out: dict = {"text": text, "language": lang if lang in DESCRIBE_LANGUAGES else "en", "storage": "job"}
        if request.source_size:
            out["width"], out["height"] = request.source_size
        done = self.queue.finish(job_id, self.worker_id, True, result=out)
        shutil.rmtree(self.out_dir / job_id, ignore_errors=True)
        if result.usage is not None:
            try:
                self.queue.record_cost(job_id, result.usage)
            except Exception as e:  # reporting only; the job is settled
                logger.warning("job %s: provider cost not recorded (%s)", job_id, type(e).__name__)
        status = (done or {}).get("status") if isinstance(done, dict) else None
        return "completed:text" if status in (None, "completed") else str(status)

    def _store_captions(self, request: GenerationRequest, files: Sequence[Path], result: ProviderPoll) -> str:
        """Captions: the cleaned words kept as a caption track (module doc).
        The provider's file is scratch; nothing goes to the library."""
        import json  # noqa: PLC0415 — one call site

        job_id = request.job_id
        try:
            size = Path(files[0]).stat().st_size
            if size > CAPTIONS_MAX_BYTES:
                raise _Refused("bad_response", "the transcript is larger than a caption track may be")
            doc = json.loads(Path(files[0]).read_bytes().decode("utf-8", errors="replace"))
        except OSError as e:
            raise _Refused("bad_response", f"the transcript could not be read ({type(e).__name__})") from None
        except ValueError:
            raise _Refused("bad_response", "the transcript is not readable") from None
        if not isinstance(doc, Mapping) or not isinstance(doc.get("words"), list):
            raise _Refused("bad_response", "the transcript has no words")
        try:
            words = clean_words(doc["words"], duration_s=request.source_duration_s)
        except CaptionsError as e:
            raise _Refused(e.code if _CODE_RE.match(e.code) else "bad_response", e.message) from None
        asked = request.params.get("language")
        # The language the person named, else the one the provider detected;
        # "und" (undetermined) when neither is a language tag — never a guess.
        language = (asked if isinstance(asked, str) and asked in DESCRIBE_LANGUAGES
                    else base_language(doc.get("language"))) or "und"
        duration = max(words[-1]["e"], request.source_duration_s or 0.0)
        if not self.queue.advance(job_id, self.worker_id, "processing"):
            logger.warning("job %s: no longer this worker's; its captions are not recorded here", job_id)
            return "left"
        track = self.queue.store_caption_track(job_id, self.worker_id, language, duration, words)
        if not track:
            raise _Refused("bad_response", "the caption track could not be stored")
        out = {"track_id": track, "language": language, "words": len(words), "duration_s": round(duration, 3),
               "storage": "table"}
        done = self.queue.finish(job_id, self.worker_id, True, result=out)
        shutil.rmtree(self.out_dir / job_id, ignore_errors=True)
        if result.usage is not None:
            try:
                self.queue.record_cost(job_id, result.usage)
            except Exception as e:  # reporting only; the job is settled
                logger.warning("job %s: provider cost not recorded (%s)", job_id, type(e).__name__)
        status = (done or {}).get("status") if isinstance(done, dict) else None
        return "completed:captions" if status in (None, "completed") else str(status)

    def _to_library(self, request: GenerationRequest, files: Sequence[Path],
                    usage: Optional[ProviderUsage]) -> List[str]:
        """Each output as a library asset of the job's organization, attached
        to the job. [] when there is no library or it could not take them —
        the job still completes (its files stay in the worker's folder)."""
        if self.library is None:
            return []
        source = str(request.params.get("source_asset_id") or "").lower() or None
        provenance = {"job_id": request.job_id, "capability": request.capability, "model": request.model,
                      "rights": "generated_for_org"}
        if usage is not None and usage.provider:
            provenance["provider"] = usage.provider
        if source:
            provenance["source_asset_id"] = source
        end = str(request.params.get("end_asset_id") or "").lower()
        if end and request.end_file is not None:
            provenance["end_asset_id"] = end
        ids: List[str] = []
        try:
            for i, f in enumerate(files):
                aid = str(uuid.uuid5(ASSET_NS, f"{request.job_id}:{i}"))
                ml.store_generated(
                    f, asset_id=aid, org_id=request.org_id, store=self.library.store,
                    media_root=self.library.media_root, tools=self.library.tools, provenance=provenance,
                    expect_kind=OUTPUT_KIND.get(request.capability),
                    parent_asset_id=source if request.capability in VERSION_CAPABILITIES else None)
                ids.append(aid)
            if not self.queue.attach_assets(request.job_id, self.worker_id, ids):
                logger.warning("job %s: outputs stored but not attached (job no longer this worker's)",
                               request.job_id)
                return []
        except Exception as e:  # the paid result must not be lost over its library copy
            logger.warning("job %s: outputs not added to the library (%s); kept in the job folder",
                           request.job_id, type(e).__name__)
            return []
        return ids

    def _fail(self, job_id: str, code: str, message: str) -> None:
        # The input copy is scratch; a failed job has no use for it.
        shutil.rmtree(self.out_dir / job_id / "input", ignore_errors=True)
        text = self.scrub(message or code)[:MAX_ERROR_CHARS]
        try:
            self.queue.finish(job_id, self.worker_id, False, error_code=code, error=text)
        except Exception as e:
            # The heartbeat stops with this job, so the claim's stale sweep
            # ends it (and releases the hold) later.
            logger.error("job %s: could not record the failure (%s)", job_id, type(e).__name__)

    # -- the loop --------------------------------------------------------------

    def run_forever(self, *, idle_seconds: float = 5.0, once: bool = False) -> None:
        while not self.stop.is_set():
            try:
                worked = self.run_once()
            except Exception as e:
                logger.warning("claim failed (%s)", type(e).__name__)
                worked = False
            if once:
                return
            if not worked:
                self.stop.wait(idle_seconds)


def load_resolver(spec: str) -> AdapterResolver:
    """``module:function`` -> the adapter resolver. Raises ImportError /
    AttributeError / ValueError with the spec in the message (no secrets)."""
    import importlib  # noqa: PLC0415

    mod_name, sep, fn_name = (spec or "").partition(":")
    if not sep or not mod_name or not fn_name:
        raise ValueError(f"expected module:function, got {spec!r}")
    fn = getattr(importlib.import_module(mod_name), fn_name)
    if not callable(fn):
        raise ValueError(f"{spec} is not callable")
    return fn


def parse_int(env: Mapping[str, str], name: str, default: int, lo: int, hi: int) -> int:
    try:
        v = int(str(env.get(name, "") or default))
    except ValueError:
        return default
    return max(lo, min(hi, v))


