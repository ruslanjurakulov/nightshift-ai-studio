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
Only EXACT mode exists today (the model the person picked, CLAUDE.md #4): the
job's adapter is resolved for ``requested_model`` and nothing else, and any
failure fails the job with the provider's code. There is no second model.

The adapter seam
----------------
The provider adapters live in the capability layer (``modules/capabilities``,
built separately). This module needs only :class:`CreativeAdapter` — ``submit``
and ``poll`` — and a ``resolve_adapter(model_id)`` function handed to
:class:`CreativeWorker`. ``tools/creative_worker.py`` loads that function from
``NIGHTSHIFT_CREATIVE_ADAPTERS`` (``module:function``); the tests pass fakes.

Nothing here logs a key, a token, a prompt or a provider response body: stored
error text goes through the scrubber the CLI provides.
"""

from __future__ import annotations

import hashlib
import logging
import mimetypes
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, List, Mapping, Optional, Protocol, Sequence

from modules import credits as credit_rules

logger = logging.getLogger("creative_worker")

PENDING = "pending"
SUCCEEDED = "succeeded"
FAILED = "failed"

#: Error codes worth polling again for (the task is still the provider's).
RETRYABLE_POLL_CODES = frozenset({"network", "provider_error", "rate_limited"})
#: Consecutive poll errors before a job is given up on.
MAX_POLL_ERRORS = 10
DEFAULT_POLL_SECONDS = 5.0
#: How long a provider task may take before the job is failed and released.
DEFAULT_MAX_POLL_SECONDS = 45 * 60
DEFAULT_HEARTBEAT_SECONDS = 30.0
MAX_ERROR_CHARS = 2000
#: ``module:function`` of the adapter resolver the CLI loads.
ADAPTERS_ENV = "NIGHTSHIFT_CREATIVE_ADAPTERS"

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


# ── the worker ──────────────────────────────────────────────────────────────

class CreativeWorker:
    def __init__(self, queue, resolve_adapter: AdapterResolver, *, worker_id: str,
                 out_dir: Path, credits=None, enforce: bool = False,
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
        if (job.get("mode") or "exact") != "exact":
            raise _Refused("mode_not_supported", "only exact mode runs on this worker")
        if (job.get("payer") or "credits") != "credits":
            raise _Refused("payer_not_supported", "this worker settles credit-paid jobs only")
        self._check_hold(job)

        model = str(job.get("requested_model") or "")
        request = GenerationRequest(job_id=job_id, org_id=str(job.get("org_id") or ""),
                                    capability=str(job.get("capability") or ""), model=model,
                                    params=dict(job.get("params") or {}))
        # EXACT: the requested model's adapter, or nothing — never another model.
        adapter = self.resolve_adapter(model)
        if adapter is None:
            raise _Refused("adapter_missing", f"this worker has no adapter for {model}")

        task_id = job.get("provider_task_id")
        if not task_id:
            if not self.queue.advance(job_id, self.worker_id, "submitting"):
                logger.warning("job %s: not ours to submit any more; leaving it", job_id)
                return "left"
            try:
                task_id = adapter.submit(request)
            except Exception as e:
                raise _Refused(error_code_of(e), error_text_of(e)) from None
            if not task_id or not isinstance(task_id, str):
                raise _Refused("bad_response", "the provider accepted the job without a task id")
            if not self.queue.advance(job_id, self.worker_id, "submitted", task_id,
                                      {"model": model}):
                logger.error("job %s: the task id could not be stored; leaving it", job_id)
                return "left"
        return self._poll(job, request, adapter, str(task_id), beat)

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
        if not self.queue.advance(job_id, self.worker_id, "processing"):
            logger.warning("job %s: no longer this worker's; its outputs are not recorded here", job_id)
            return "left"
        described = describe_files(files)
        done = self.queue.finish(job_id, self.worker_id, True,
                                 result={"files": described, "storage": "worker"})
        if result.usage is not None:
            try:
                self.queue.record_cost(job_id, result.usage)
            except Exception as e:  # reporting only; the job is settled
                logger.warning("job %s: provider cost not recorded (%s)", job_id, type(e).__name__)
        status = (done or {}).get("status") if isinstance(done, dict) else None
        return f"completed:{len(described)}" if status in (None, "completed") else str(status)

    def _fail(self, job_id: str, code: str, message: str) -> None:
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


