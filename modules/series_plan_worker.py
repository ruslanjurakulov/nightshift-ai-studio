"""Series planning, the queue worker's side of slice S3 (docs/SERIES_FACTORY.md).

A customer's "Plan a series" press writes one ``series_plans`` row and one ``render_jobs`` row of kind ``series_plan`` (migration 0120,
``request_series_plan``). This module is what the queue worker (``tools/queue_worker.py``) does with that job: it loads the plan, makes
one planning request through the pure planner (``modules/series_planner.plan_series``), vets every episode topic the way the planner does,
and answers with ``finish_series_plan`` (service key). The whole thing is behind ``NIGHTSHIFT_SERIES_PLANNER`` (off by default).

Why it is shaped this way
-------------------------
* **No credit hold.** Planning is a platform cost for now (owner decision 3): there is no hold to place, settle or release, and the
  customer is never charged for a plan, whatever happens. Every ending below says so ("nothing was charged").
* **A plan never stays ``requested`` because of this code.** Every path that ends the job also ends the plan (``finish_series_plan``
  with ``p_ok`` false and a closed word), including the planner being switched off, an exception, a timeout and a spent Gemini quota.
  The two cases where it does not are deliberate: a job another worker took over (``lost``: the new holder owns the plan) and a job
  put back in the queue (``released``: the next attempt finishes it). A job on its LAST attempt is never released; it finishes the plan.
  Whatever still slips through (the database unreachable for good) is freed by ``request_series_plan``'s own 2 hour expiry.
* **Idempotent.** A re-queued job whose plan already ended makes no model call (a ``ready`` plan is a succeeded job; a ``failed`` one a
  failed job), and ``finish_series_plan`` answering "already finished" is an end, not an error.
* **A spent per-day Gemini quota is main.py's exit 80, as a job.** ``GeminiDailyQuotaError`` is the one error the planner re-raises
  unchanged; here it ends the plan as ``gemini_quota`` and the job as a ``provider_quota`` failure, and the worker then refuses further
  planning jobs for a while WITHOUT calling the API (each would only buy another 429).
* **Requests, said honestly.** One plan makes ONE ``generate`` (the budget), plus at most ``CHRONOS_TOPIC_GATE_MODEL_CALLS`` (default 2) small
  niche questions; each of those is ``generate_with_retry``, which makes up to ``GEMINI_MAX_RETRIES`` (default 5) HTTP attempts, so one attempt
  of a job is at most (1 + 2) x 5 = 15 HTTP requests, and a transient-error storm is what spends them. A job is attempted up to 3 times ONLY
  when its worker dies (the stale sweep re-queues it); this service itself never goes back to the model: once a ``generate`` was made, a delivery
  failure or a shutdown ends the plan as failed instead of releasing the job (see ``_retry_or_end`` and ``_deliver``). There is no per-user or
  global cap on plans yet; the only cap is the database's per-organization one (migration 0120).
* **Hard limits.** 3 or 4 episodes (refused before a call), the planner's call budget (``series_call_budget(n)['plan_calls']``, one call:
  a second ``generate`` is refused), and a wall-clock timeout after which no further call is made and the plan ends as ``timeout``.
* **The outline is model text and stays data.** Nothing here executes, formats into a command, or logs it; it is stored as JSON for the
  page to escape and label "not fact-checked". The error text stored on a failed plan is OURS (a fixed sentence per code), never the
  model's or an exception's.
* **The price is the database's.** The quote stored with a plan is only the Gemini-call budget and the episode length; credits are
  computed by ``quote_series_episode`` / ``start_series_episode`` when a person looks at or starts an episode.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass
from typing import Callable, Mapping, Optional

from modules import series_planner
from modules.gemini_stages import GeminiDailyQuotaError

logger = logging.getLogger(__name__)

KIND = "series_plan"
SWITCH = "NIGHTSHIFT_SERIES_PLANNER"

#: One model call and a few small gate questions: five minutes is far beyond a healthy plan, and short enough that a hung
#: provider call does not hold the channel's queue slot for the job limit (3300 s).
DEFAULT_TIMEOUT_SECONDS = 300.0
#: After a spent daily quota, planning jobs end as ``gemini_quota`` without a call for ``max(30 min, min(retry-after or 30 min, 1 hour))``:
#: a short retry hint from Google (seconds) must not give a seconds-long cooldown (the quota is per day, so a hint says little), and a
#: day-long hint is capped (an hour of silence is cheap, a day of it would outlast a fixed quota).
DEFAULT_QUOTA_COOLDOWN_SECONDS = 1800.0
MIN_QUOTA_COOLDOWN_SECONDS = 1800.0
MAX_QUOTA_COOLDOWN_SECONDS = 3600.0
#: Tries to deliver an ending to the database, and the pause before the n-th retry.
DELIVERY_TRIES = 3
DELIVERY_PAUSE_SECONDS = 2.0

#: Limits the database enforces on what ``finish_series_plan`` stores (migration 0120), with a little margin: the plan's report and
#: quote 16384 bytes, one episode's outline 8192, all episodes 65536. A result over them is a failed plan, not a rejected write.
MAX_REPORT_BYTES = 16000
MAX_QUOTE_BYTES = 16000
MAX_OUTLINE_BYTES = 8000
MAX_EPISODES_BYTES = 60000

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

#: The closed words this module adds to the planner's own (``SeriesPlanError.code``). Each fits the database's
#: ``^[a-z][a-z0-9_]{0,47}$`` and each has a sentence in ``command-center/lib/seriesPlan.ts`` (tests pin the two lists equal).
CODE_NOT_ENABLED = "planner_not_enabled"
CODE_QUOTA = "gemini_quota"
CODE_TIMEOUT = "timeout"
CODE_NO_KEY = "no_gemini_key"
CODE_CHANNEL = "channel_refused"
CODE_MISMATCH = "plan_mismatch"
CODE_TOO_LARGE = "result_too_large"
CODE_WORKER = "worker_error"
WORKER_CODES = (CODE_NOT_ENABLED, CODE_QUOTA, CODE_TIMEOUT, CODE_NO_KEY, CODE_CHANNEL, CODE_MISMATCH, CODE_TOO_LARGE, CODE_WORKER)

#: What a failed plan says, in English, stored in ``series_plans.error`` (the page shows its own translated sentence for the code and
#: only falls back to this). Fixed text: never a model's words, an exception's message, a topic or a key.
_ERROR_TEXT = {
    CODE_NOT_ENABLED: "Series planning is not switched on yet. Nothing was run and nothing was charged.",
    CODE_QUOTA: "The planning model's daily quota is used up. Nothing was charged. Try again tomorrow.",
    CODE_TIMEOUT: "Planning took too long and was stopped. Nothing was charged. Try again.",
    CODE_NO_KEY: "Planning is not set up on this server yet. Nothing was run and nothing was charged.",
    CODE_CHANNEL: "This channel is not ready for planning. Nothing was run and nothing was charged.",
    CODE_MISMATCH: "The plan and its job disagree, so nothing was run. Nothing was charged.",
    CODE_TOO_LARGE: "The planning model's answer was too large to store, so it was dropped. Nothing was charged. Try again.",
    CODE_WORKER: "Planning stopped unexpectedly. Nothing was charged. Try again.",
    "generate_failed": "The planning model did not answer. Nothing was charged. Try again.",
    "bad_input": "The request could not be used as written (the topic is too long or has hidden characters). Change it and plan again. Nothing was charged.",
    "bad_language": "The language could not be used. Choose another and plan again. Nothing was charged.",
    "bad_count": "A series has 3 or 4 episodes. Choose one of them and plan again. Nothing was charged.",
    "no_niche": "This channel has no niche, so a series cannot be planned. Set the niche first. Nothing was charged.",
}
_GENERIC_PLANNER_TEXT = "The planning model's answer could not be used. Nothing was charged. Try again."


def enabled(env: Optional[Mapping[str, str]] = None) -> bool:
    """The worker's own switch: OFF unless NIGHTSHIFT_SERIES_PLANNER is on. Planning spends the platform's shared Gemini key on behalf
    of customers, so it is never on by default and never on by accident."""
    import os  # noqa: PLC0415

    env = os.environ if env is None else env
    return str(env.get("NIGHTSHIFT_SERIES_PLANNER", "off")).strip().lower() in ("on", "1", "true", "yes")


def error_text(code: str) -> str:
    return _ERROR_TEXT.get(code) or _GENERIC_PLANNER_TEXT


# ── the database (service key, PostgREST) ────────────────────────────────────

#: ``finish`` answers.
DONE = "done"            # recorded, or already recorded: the plan has ended
REFUSED = "refused"      # the database said no (4xx): trying again cannot help
UNREACHABLE = "unreachable"   # no answer / 5xx: the ending is not recorded


class StoreError(RuntimeError):
    """A read that did not work. Carries the HTTP status only, never a body."""


class SeriesPlanStore:
    """``series_plans`` over PostgREST with the service key: one read (service_role has SELECT, migration 0120) and one function
    (``finish_series_plan``, service_role only). It writes nothing else; the service key has no table write on these tables."""

    COLUMNS = "id,status,channel_id,series_id,topic,niche,language,n_episodes,duration_s"

    def __init__(self, url: str, service_key: str, *, session=None, timeout: float = 20.0):
        self.url = (url or "").rstrip("/")
        self._key = service_key or ""
        self._http = session
        self._timeout = timeout

    def _session(self):
        if self._http is None:
            import requests  # noqa: PLC0415 - keep the tests and --help import-light

            self._http = requests.Session()
        return self._http

    def _headers(self) -> dict:
        return {"apikey": self._key, "Authorization": f"Bearer {self._key}", "Content-Type": "application/json"}

    def load(self, plan_id: str) -> Optional[dict]:
        r = self._session().get(f"{self.url}/rest/v1/series_plans", params={"id": f"eq.{plan_id}", "select": self.COLUMNS},
                                headers=self._headers(), timeout=self._timeout)
        if r.status_code >= 300:
            raise StoreError(f"series_plans: HTTP {r.status_code}")   # the status only, never the body
        rows = r.json()
        return rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], dict) else None

    def finish(self, plan_id: str, *, ok: bool, title=None, report=None, quote=None, episodes=None,
               error_code: Optional[str] = None, error: Optional[str] = None) -> str:
        payload = {"p_plan": plan_id, "p_ok": ok, "p_title": title, "p_report": report, "p_quote": quote,
                   "p_episodes": episodes, "p_error_code": error_code, "p_error": error}
        try:
            r = self._session().post(f"{self.url}/rest/v1/rpc/finish_series_plan", json=payload,
                                     headers=self._headers(), timeout=self._timeout)
        except Exception as exc:  # noqa: BLE001 - a transport failure is "not recorded", never a crash
            logger.warning("series plan %s: finish_series_plan was not reached (%s)", plan_id, type(exc).__name__)
            return UNREACHABLE
        if r.status_code < 300:
            return DONE
        message = ""
        try:
            body = r.json()
            message = str(body.get("message") or "") if isinstance(body, dict) else ""
        except ValueError:
            pass
        if message == "plan_already_finished":
            # A second, different answer to a plan that already ended: the first answer stands. Not an error.
            return DONE
        logger.warning("series plan %s: finish_series_plan answered HTTP %s", plan_id, r.status_code)   # status only
        return REFUSED if 400 <= r.status_code < 500 else UNREACHABLE


# ── the outcome the queue worker acts on ─────────────────────────────────────

@dataclass(frozen=True)
class Outcome:
    """What the queue worker does with the job. ``succeeded``/``failed`` finish it (``error`` is the operator's line and ``code`` the
    ``modules/render_error`` code for a failed job); ``released`` puts it back in the queue; ``lost`` leaves it to its new holder."""

    kind: str
    error: Optional[str] = None
    code: Optional[str] = None


class CallBudgetExceeded(RuntimeError):
    """The planner asked for more model calls than the budget allows (series_call_budget plan_calls)."""


class _GuardedVet:
    """The vet, with the same cancel check as the model call: a plan whose attempt was stopped (timeout, lost job, shutdown) makes no niche
    question either. The check is before each topic, so one already running is the only call that can still finish."""

    def __init__(self, vet, cancelled: threading.Event):
        self._vet = vet
        self._cancelled = cancelled

    def vet_topic(self, topic, niche, *, source):
        if self._cancelled.is_set():
            raise CallBudgetExceeded("planning was stopped")
        method = getattr(self._vet, "vet_topic", None)
        return method(topic, niche, source=source) if method is not None else self._vet(topic, niche, source=source)

    def find_repeat(self, topic):
        if self._cancelled.is_set():
            raise CallBudgetExceeded("planning was stopped")
        return self._vet.find_repeat(topic)


class _Result:
    def __init__(self):
        self.done = threading.Event()
        self.plan = None
        self.error: Optional[BaseException] = None
        self.calls = 0
        self.gate_calls: Optional[int] = None


def _json_bytes(value) -> int:
    return len(json.dumps(value, ensure_ascii=False).encode("utf-8"))


def build_result(plan: "series_planner.SeriesPlan", *, duration_s: int, calls_made: int, gate_calls: Optional[int]) -> dict:
    """The arguments of ``finish_series_plan`` for a plan that was made: the title, the plan's report (everything but the episodes),
    the quote (the call budget and the length, NOT credits) and one entry per episode (its topic, its whole report as the outline,
    ``usable``, and ``needs_confirmation`` = usable with its niche unconfirmed). Raises ``ValueError('too_large')`` if the result
    would not fit what the database stores."""
    whole = plan.to_dict()
    report = {k: v for k, v in whole.items() if k != "episodes"}
    report["gate_calls"] = gate_calls
    report["gemini_calls_made"] = calls_made + (gate_calls or 0)
    quote = {"priced_by": "database", "per_episode_duration_s": int(duration_s),
             "gemini_calls": series_planner.series_call_budget(len(plan.episodes))}
    episodes = []
    for ep in plan.episodes:
        outline = ep.to_dict()
        if _json_bytes(outline) > MAX_OUTLINE_BYTES:
            raise ValueError("too_large")
        episodes.append({"topic": ep.outline.topic, "outline": outline, "usable": ep.usable,
                         "needs_confirmation": ep.usable and not ep.niche_confirmed})
    if (_json_bytes(report) > MAX_REPORT_BYTES or _json_bytes(quote) > MAX_QUOTE_BYTES
            or _json_bytes(episodes) > MAX_EPISODES_BYTES):
        raise ValueError("too_large")
    return {"title": plan.series_title, "report": report, "quote": quote, "episodes": episodes}


# ── the live collaborators ───────────────────────────────────────────────────

def live_vet(channel_id: str):
    """``(vet, held_topics_checked, gate_calls)`` as main.py builds them: the channel's TopicManager, its history rebuilt from Supabase
    when the local cache is empty, and the topics held before render. ``held_topics_checked`` is True only when some were found: the
    manager cannot tell "none held" from "could not be read", and a plan must not look as if it had checked (rule 5), so the rest is
    None (not known)."""
    from modules.channels import ChannelRegistry  # noqa: PLC0415 - only a live plan needs the registry and the model SDK
    from modules.topic_manager import TopicManager  # noqa: PLC0415

    manager = TopicManager(channel=ChannelRegistry().get(channel_id))
    manager.seed_history_from_supabase()
    held = manager.load_held_topics()
    return manager, (True if held else None), (lambda: int(getattr(manager, "_gate_calls", 0)))


def live_generate() -> Callable:
    """The real ``generate``: one ``gemini_client.generate_with_retry`` call on ``model_for('series_plan')``."""
    return series_planner.gemini_generate()


# ── the service ──────────────────────────────────────────────────────────────

class SeriesPlanService:
    """Runs one ``series_plan`` job. Never raises; every path returns an ``Outcome`` (and ends the plan, see the module docstring)."""

    def __init__(self, store, *, enabled: bool = False, env: Optional[Mapping[str, str]] = None,
                 generate_factory: Callable[[], Callable] = live_generate,
                 vet_factory: Callable[[str], tuple] = live_vet,
                 timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep):
        self.store = store
        self.enabled = bool(enabled)
        self.env = dict(env or {})
        self.generate_factory = generate_factory
        self.vet_factory = vet_factory
        self.timeout_seconds = timeout_seconds if timeout_seconds and timeout_seconds > 0 else DEFAULT_TIMEOUT_SECONDS
        self.clock = clock
        self.sleep = sleep
        self._quota_until: Optional[float] = None
        # The attempt in progress (one at a time): whether it has already asked the model, for _called.
        self._result: Optional[_Result] = None

    # -- the one entry ------------------------------------------------------

    def run(self, job: Mapping, *, lost: threading.Event, interrupted: Callable[[], bool] = lambda: False,
            resolve_channel: Optional[Callable[[str], Mapping]] = None, last_attempt: bool = False) -> Outcome:
        plan_id = str(job.get("series_plan_id") or "")
        self._result = None
        if not _UUID.match(plan_id):
            # No plan to end: nothing was run, and the job says so.
            return Outcome("failed", "series planning: the job names no plan (nothing was run)")
        try:
            return self._run(job, plan_id, lost, interrupted, resolve_channel, last_attempt)
        except Exception as exc:  # noqa: BLE001 - an exception must never leave the plan 'requested'
            logger.error("series plan %s: stopped by an unexpected %s", plan_id, type(exc).__name__)
            return self._end_failed(plan_id, CODE_WORKER, last_attempt=last_attempt)

    # -- the steps ----------------------------------------------------------

    def _run(self, job, plan_id, lost, interrupted, resolve_channel, last_attempt) -> Outcome:
        if not self.enabled:
            # Today's behaviour for a series_plan job (the worker fails it, nothing runs), plus the plan ending now instead of
            # sitting 'requested' for two hours and blocking its channel.
            logger.info("series plan %s: the planner is not enabled (%s); ending the plan", plan_id, SWITCH)
            return self._end_failed(plan_id, CODE_NOT_ENABLED, last_attempt=last_attempt)

        try:
            plan = self.store.load(plan_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("series plan %s: could not be read (%s)", plan_id, type(exc).__name__)
            return self._retry_or_end(plan_id, "the plan could not be read", last_attempt)
        if plan is None:
            return Outcome("failed", "series planning: the plan does not exist (nothing was run)")
        if plan.get("status") != "requested":
            # A re-queued job whose plan already ended: the answer stands, no model call.
            if plan.get("status") == "ready":
                logger.info("series plan %s: already planned; nothing to do", plan_id)
                return Outcome("succeeded")
            return Outcome("failed", "series planning: the plan had already ended as failed (nothing was run)")
        channel_id = str(job.get("channel_id") or "")
        if str(plan.get("channel_id") or "") != channel_id:
            return self._end_failed(plan_id, CODE_MISMATCH, last_attempt=last_attempt)

        # Rule 7 and rule 6, before a call is spent: a draft channel never runs, and a server with no key cannot plan.
        row: Mapping = {}
        if resolve_channel is not None:
            try:
                row = resolve_channel(channel_id) or {}
            except (KeyError, ValueError):
                return self._end_failed(plan_id, CODE_CHANNEL, last_attempt=last_attempt)
        if not str(self.env.get("GEMINI_API_KEY") or "").strip():
            return self._end_failed(plan_id, CODE_NO_KEY, last_attempt=last_attempt)
        if self._quota_until is not None and self.clock() < self._quota_until:
            logger.info("series plan %s: the Gemini daily quota was spent a moment ago; not calling the API again yet", plan_id)
            return self._end_failed(plan_id, CODE_QUOTA, code="provider_quota", last_attempt=last_attempt,
                                    job_error="series planning: Gemini's daily request quota is used up; nothing was charged")

        n = plan.get("n_episodes")
        try:
            budget = series_planner.series_call_budget(n)      # 3 or 4 below, 1..4 here: the planner refuses the rest
        except series_planner.SeriesPlanError as exc:
            return self._end_failed(plan_id, exc.code, last_attempt=last_attempt)

        result = _Result()
        self._result = result
        cancelled = threading.Event()
        worker = threading.Thread(target=self._plan, args=(plan, row, budget, cancelled, result), daemon=True,
                                  name=f"series-plan-{plan_id[:8]}")
        worker.start()
        deadline = self.clock() + self.timeout_seconds
        while not result.done.wait(0.2):
            if lost.is_set():
                cancelled.set()
                return Outcome("lost")      # whoever holds the job now owns the plan
            if interrupted():
                cancelled.set()
                return self._retry_or_end(plan_id, "worker shut down mid-plan; re-queued", last_attempt)
            if self.clock() >= deadline:
                cancelled.set()       # no further model call is made by this attempt
                logger.error("series plan %s: stopped after %ds", plan_id, int(self.timeout_seconds))
                return self._end_failed(plan_id, CODE_TIMEOUT, last_attempt=last_attempt,
                                        job_error=f"timed out: series planning took longer than {int(self.timeout_seconds)} seconds "
                                                  "and was stopped; nothing was charged")
        return self._finish_from(plan_id, plan, result, last_attempt)

    def _plan(self, plan: Mapping, row: Mapping, budget: Mapping, cancelled: threading.Event, result: _Result) -> None:
        """The planner, on its own thread so that a hung provider call cannot outlive the timeout in the caller. Stores the plan or the
        exception; never raises."""
        try:
            generate = self.generate_factory()
            limit = int(budget["plan_calls"])
            lock = threading.Lock()

            def budgeted(prompt, *, stage=series_planner.STAGE):
                with lock:
                    if cancelled.is_set():
                        raise CallBudgetExceeded("planning was stopped")
                    if result.calls >= limit:
                        raise CallBudgetExceeded("the planning call budget is spent")
                    result.calls += 1
                return generate(prompt, stage=stage)

            vet, held_checked, gate_calls = self.vet_factory(str(plan.get("channel_id") or ""))
            vet = _GuardedVet(vet, cancelled)
            try:
                result.plan = series_planner.plan_series(
                    plan.get("topic"), plan.get("n_episodes"), generate=budgeted, vet=vet, niche=plan.get("niche") or "",
                    channel_name=str(row.get("name") or ""), language=plan.get("language") or "English",
                    held_topics_checked=held_checked)
            finally:
                try:
                    result.gate_calls = int(gate_calls())
                except Exception:  # noqa: BLE001 - a counter must not change the answer
                    result.gate_calls = None
        except BaseException as exc:  # noqa: BLE001 - handed to the caller, which classifies it
            result.error = exc
        finally:
            result.done.set()

    def _finish_from(self, plan_id: str, plan: Mapping, result: _Result, last_attempt: bool) -> Outcome:
        error = result.error
        if error is None and result.plan is not None:
            try:
                args = build_result(result.plan, duration_s=int(plan.get("duration_s") or 0), calls_made=result.calls,
                                    gate_calls=result.gate_calls)
            except ValueError:
                return self._end_failed(plan_id, CODE_TOO_LARGE, last_attempt=last_attempt)
            return self._deliver(plan_id, Outcome("succeeded"), last_attempt, ok=True, **args)
        if isinstance(error, GeminiDailyQuotaError):
            # main.py's exit 80, as a job: the plan ends, the customer is charged nothing (there is no hold), and the worker stops
            # asking Google until the quota can have moved. The one log line (model, retry-after, fix) was written where the 429 arrived.
            hint = error.retry_after_s if isinstance(error.retry_after_s, (int, float)) and error.retry_after_s > 0 \
                else DEFAULT_QUOTA_COOLDOWN_SECONDS
            self._quota_until = self.clock() + max(MIN_QUOTA_COOLDOWN_SECONDS, min(float(hint), MAX_QUOTA_COOLDOWN_SECONDS))
            return self._end_failed(plan_id, CODE_QUOTA, code="provider_quota", last_attempt=last_attempt,
                                    job_error="series planning: Gemini's daily request quota is used up; nothing was charged")
        if isinstance(error, series_planner.SeriesPlanError):
            return self._end_failed(plan_id, error.code, last_attempt=last_attempt)
        logger.error("series plan %s: stopped by an unexpected %s", plan_id, type(error).__name__ if error else "empty result")
        return self._end_failed(plan_id, CODE_WORKER, last_attempt=last_attempt)

    # -- endings ------------------------------------------------------------

    def _end_failed(self, plan_id: str, error_code: str, *, last_attempt: bool, code: Optional[str] = None,
                    job_error: Optional[str] = None) -> Outcome:
        """End the plan as failed with a closed word, then say how the job ends."""
        job_error = job_error or f"series planning failed ({error_code}); nothing was charged"
        return self._deliver(plan_id, Outcome("failed", job_error, code), last_attempt, ok=False, error_code=error_code,
                             error=error_text(error_code))

    def _deliver(self, plan_id: str, outcome: Outcome, last_attempt: bool, **finish) -> Outcome:
        """Record the ending in the database, retried. Recorded (or the database said the plan had already ended): ``outcome``. Refused: the
        job fails with the plan untouched (retrying cannot help). Not reachable: the job goes back to the queue only if no model call was made
        and it is not on its last attempt; otherwise it fails (a release would re-ask the model, or fail the row and leave the plan
        'requested') and the 2 hour expiry frees the channel."""
        for attempt in range(DELIVERY_TRIES):
            answer = self.store.finish(plan_id, **finish)
            if answer == DONE:
                return outcome
            if answer == REFUSED:
                return Outcome("failed", "series planning: the database refused the plan's ending (check the logs)")
            if attempt + 1 < DELIVERY_TRIES:
                self.sleep(DELIVERY_PAUSE_SECONDS * (attempt + 1))
        if last_attempt or self._called:
            # A release would fail the job here and leave the plan 'requested' (last attempt), or send the next attempt back to the
            # model for an answer this one already bought (a model call was made). Neither: the job fails, and the 2 hour expiry
            # frees the channel. The database could not be told, so say so loudly.
            logger.error("series plan %s: its ending could not be recorded (%s); the 2 hour expiry frees the channel", plan_id,
                         "on the last attempt" if last_attempt else "and the model was already asked, so it is not asked again")
            return Outcome("failed", "series planning: the plan's ending could not be recorded; it is not planned again "
                                     "(nothing was charged)")
        return Outcome("released", "the plan's ending could not be recorded")

    def _retry_or_end(self, plan_id: str, why: str, last_attempt: bool) -> Outcome:
        """Put the job back in the queue for another attempt, unless this is the last one (a job released on its last attempt would be
        failed by the queue and the plan left 'requested') or the model was already asked (see ``_called``): then the plan ends now."""
        if last_attempt or self._called:
            return self._end_failed(plan_id, CODE_WORKER, last_attempt=True)
        return Outcome("released", why)

    @property
    def _called(self) -> bool:
        """Has this attempt already asked the model (a call counts the moment it is started, finished or not)? Then no path puts the
        job back in the queue: the next attempt would ask again, and an unrecorded answer is not worth another request."""
        return bool(self._result is not None and self._result.calls > 0)


def build(url: str, service_key: str, env: Optional[Mapping[str, str]] = None) -> SeriesPlanService:
    """The service ``tools/queue_worker.py`` runs: always built (a plan job is ended cleanly even when planning is off), planning on
    only with ``NIGHTSHIFT_SERIES_PLANNER``."""
    import os  # noqa: PLC0415

    env = dict(os.environ if env is None else env)
    return SeriesPlanService(SeriesPlanStore(url, service_key), enabled=enabled(env), env=env)


__all__ = ["KIND", "SWITCH", "Outcome", "SeriesPlanService", "SeriesPlanStore", "build", "build_result", "enabled", "error_text",
           "WORKER_CODES"]
