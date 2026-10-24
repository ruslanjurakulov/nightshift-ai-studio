"""The stages that call Gemini: which model each uses, how many requests each made, and the quota stop.

Why this exists
---------------
Evidence: Actions run 40051405982 (the scheduled Chronos run of 24 Oct) died with a raw
``ClientError: 429 RESOURCE_EXHAUSTED ... generate_content_free_tier_requests, limit: 20 ...
Generate content requests per day limit exceeded on Free Tier``. Diagnosis: every text call already goes
through ``gemini_client.generate_with_retry``, which recognised the per-day quota and refused to retry, but
it then re-raised the SDK's error and nothing between it and ``__main__`` turned that into an ending the
runners understand. Nobody could say how many requests a run makes, or which stage spends them, so nobody
could say whether 20 a day is "a little short" or "an order of magnitude short".

Three small things live here, none of which needs the Google SDK (the queue worker and the error classifier
import this module too):

* ``model_for(stage)``: the model a stage asks for. ``GEMINI_MODEL`` for every stage unless the operator set
  that stage's own variable (``config.GEMINI_STAGE_MODELS``). Nothing set means every stage resolves to
  ``GEMINI_MODEL``, exactly as before.
* a per-run request counter, thread-safe, that never raises and holds only a stage label, a validated model
  id and numbers: no prompt text, no response, no key.
* ``GeminiDailyQuotaError`` and ``GEMINI_QUOTA_EXIT``: the per-day quota as its own ending.
"""

from __future__ import annotations

import logging
import re
import threading
from typing import Optional

logger = logging.getLogger(__name__)

#: main.py's exit code for "Gemini's per-day request quota is spent for a model this run needs, and the stage
#: that hit it cannot be skipped". 75 is the storyboard pause, 78 the spend ceiling, 79 the fact-check hold;
#: 80 is the next free one. Not a success: no video exists, so the queue worker fails the job and RELEASES its
#: credit hold, and the Actions step stays red (an outage the owner has to act on, unlike a deliberate hold).
GEMINI_QUOTA_EXIT = 80

#: Stage label -> the model group whose variable (``GEMINI_MODEL_<GROUP>``) picks its model. The labels are
#: what the request counter reports; the groups are what an operator can set. Title planning has no label of
#: its own: it calls the script engine's ``_gen`` and is counted, and modelled, as ``script``.
STAGE_GROUP = {
    "topic_pick": "topic",           # modules/topic_manager.py: the AI's own topic
    "topic_gate": "topic",           # modules/topic_manager.py: the one small niche question per topic
    "research": "research",          # modules/research_engine.py
    "script": "script",              # modules/script_engine.py (and the title plan that rides on its _gen)
    "fact_check": "factcheck",       # modules/fact_checker.py: one request per batch of claims
    "grounding": "grounding",        # modules/grounding.py: the evidence judge
    "packaging_repair": "packaging",  # main.py: the one rewrite of the flagged title/description
    "comment_intel": "other",        # modules/comment_intelligence.py (the poll and the queue worker)
    "comment_replies": "other",      # modules/comment_replies.py
    "video_critic": "other",         # modules/video_critic.py: one vision request per contact sheet
}
#: The groups, in the order the docs list them. ``config.GEMINI_STAGE_MODELS`` has exactly these keys.
MODEL_GROUPS = ("topic", "research", "script", "factcheck", "grounding", "packaging", "other")

#: A plain model id: what a per-stage variable may hold (config.py) and what a log line may print.
MODEL_ID_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
UNRECOGNISED_MODEL = "(unrecognised model id)"

#: The stage of a request whose caller named none (a model passed as a plain string).
UNLABELLED = "unlabelled"


class StageModel(str):
    """A model id that remembers which stage asked for it.

    ``generate_with_retry(client, model, ...)`` keeps its signature, and every caller (and every test fake of
    it) keeps working, while the counter still learns the stage: this IS the model id, compares and hashes as
    the plain string, and ``gemini_client`` hands the SDK ``str(model)``."""

    stage: str = UNLABELLED

    def __new__(cls, value: str, stage: str):
        obj = super().__new__(cls, value)
        obj.stage = stage
        return obj


def model_for(stage: str) -> str:
    """The model ``stage`` asks for: its group's variable, else ``GEMINI_MODEL``. Always a non-empty
    string; an unknown stage name is the ``other`` group's, never an error in the middle of a run."""
    import config  # noqa: PLC0415 - read at call time, so a test that patches the mapping is honoured

    group = STAGE_GROUP.get(stage, "other")
    chosen = (getattr(config, "GEMINI_STAGE_MODELS", None) or {}).get(group) or config.GEMINI_MODEL
    return StageModel(chosen, stage if stage in STAGE_GROUP else UNLABELLED)


def stage_variable(stage: str) -> str:
    """The variable that moves ``stage`` to another model, for the fix sentence in a message."""
    return "GEMINI_MODEL_" + STAGE_GROUP.get(stage, "other").upper()


def stage_of(model) -> str:
    stage = getattr(model, "stage", None)
    return stage if isinstance(stage, str) and stage else UNLABELLED


def label_model(model) -> str:
    """``model`` as it may appear in a log line or an event: a plain model id, or a fixed phrase. A key
    pasted into the wrong variable therefore never reaches a log."""
    text = str(model or "")
    return text if MODEL_ID_RE.fullmatch(text) else UNRECOGNISED_MODEL


# -- the quota stop ------------------------------------------------------------------------------------


def _duration_words(seconds: Optional[float]) -> str:
    if seconds is None or seconds < 0:
        return "no retry-after was given"
    whole = int(seconds)
    hours, rest = divmod(whole, 3600)
    minutes = rest // 60
    if hours:
        span = f"{hours}h {minutes:02d}m"
    elif minutes:
        span = f"{minutes}m"
    else:
        span = f"{whole}s"
    return f"retry-after about {span} ({whole}s)"


class GeminiDailyQuotaError(RuntimeError):
    """Gemini's per-day request quota is spent for ``model``. Waiting does not fix it today, so nothing was
    retried. Raised by ``generate_with_retry`` instead of the SDK's raw 429; a stage that already degrades on
    any model failure keeps degrading (it catches ``Exception``), and one that cannot (the topic, the script)
    lets it reach ``__main__``, which ends the run with ``GEMINI_QUOTA_EXIT``.

    The message is the one log line for the event: model, stage, retry-after and the fix."""

    def __init__(self, model: str, retry_after_s: Optional[float] = None, stage: str = UNLABELLED):
        self.model = label_model(model)
        self.retry_after_s = retry_after_s
        self.stage = stage if stage in STAGE_GROUP else UNLABELLED
        fix = (f"enable billing for the Gemini API key in Google AI Studio, or set {stage_variable(self.stage)} "
               "to a model that still has quota")
        super().__init__(
            f"Gemini daily request quota is used up for model {self.model} (stage {self.stage}; "
            f"{_duration_words(retry_after_s)}). Not retried. Fix: {fix}.")


# -- the request counter -------------------------------------------------------------------------------


class _Counter:
    """Requests per (stage, model). One run per process in production, but the queue worker and the tests
    run several, and stages may run in threads: every touch of the table holds the lock."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._rows: dict = {}

    def note(self, stage: str, model, *, quota: bool = False) -> None:
        try:
            key = (stage if stage in STAGE_GROUP else UNLABELLED, label_model(model))
            with self._lock:
                row = self._rows.setdefault(key, [0, 0])
                if quota:
                    row[1] += 1
                else:
                    row[0] += 1
        except Exception:  # noqa: BLE001 - a counter must never break a request
            pass

    def reset(self) -> None:
        with self._lock:
            self._rows.clear()

    def snapshot(self) -> list:
        with self._lock:
            rows = [(k, list(v)) for k, v in self._rows.items()]
        return [{"stage": stage, "model": model, "requests": req, "daily_quota_errors": quota}
                for (stage, model), (req, quota) in sorted(rows)]


_COUNTER = _Counter()


def note_request(stage: str, model) -> None:
    """One real attempt at the API, a retry included. Called BEFORE the request, so an attempt that raises
    (a timeout, a 503) still counts: it may well have reached Google's counter."""
    _COUNTER.note(stage, model)


def note_daily_quota(stage: str, model) -> None:
    _COUNTER.note(stage, model, quota=True)


def reset() -> None:
    _COUNTER.reset()


def snapshot() -> list:
    """``[{stage, model, requests, daily_quota_errors}]``, sorted. Never raises."""
    try:
        return _COUNTER.snapshot()
    except Exception:  # noqa: BLE001
        return []


def summary_line(rows: Optional[list] = None) -> Optional[str]:
    """The one end-of-run line, or None when the run made no request."""
    rows = snapshot() if rows is None else rows
    if not rows:
        return None
    total = sum(r["requests"] for r in rows)
    parts = ", ".join(f"{r['stage']} {r['model']} x{r['requests']}" for r in rows if r["requests"])
    line = f"Gemini requests this run: {total}" + (f" ({parts})" if parts else "")
    spent = [f"{r['stage']} {r['model']} x{r['daily_quota_errors']}" for r in rows if r["daily_quota_errors"]]
    if spent:
        line += "; daily-quota errors: " + ", ".join(spent)
    return line


def report_run(channel_id: Optional[str] = None) -> None:
    """Log the summary line and record it as one ``gemini.usage`` event. Nothing when the run made no
    request (a run from a saved script), so those runs are byte-for-byte as before. Never raises.

    Not a cost-ledger entry: the ledger's totals and the credit settlement treat an entry with no USD rate
    as "unpriced" and charge the whole hold, so a count with no price must not live there."""
    try:
        rows = snapshot()
        line = summary_line(rows)
        if line is None:
            return
        quota_errors = sum(r["daily_quota_errors"] for r in rows)
        (logger.warning if quota_errors else logger.info)("%s", line)
        from modules import event_log as events  # noqa: PLC0415

        events.emit(
            events.GEMINI_USAGE, agent="gemini",
            status=events.STATUS_WARNING if quota_errors else events.STATUS_COMPLETED,
            channel_id=channel_id,
            metadata={"requests": sum(r["requests"] for r in rows), "daily_quota_errors": quota_errors,
                      "stages": rows},
        )
    except Exception:  # noqa: BLE001 - observability must not change how a run ends
        pass
