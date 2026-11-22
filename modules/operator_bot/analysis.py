"""Pure derivations over rows the sources returned: what is stuck, which worker
went quiet, what is low. Shared by the commands (so /queue and /health say it)
and by the alert detector (so an alert and the command it points to cannot
disagree). No I/O, no clock of its own: ``now`` is an argument.
"""

from __future__ import annotations

import re
from collections import Counter
from datetime import datetime, timedelta
from typing import Optional

from modules.operator_bot.config import (
    OperatorConfig, STUCK_HEARTBEAT_MINUTES, WORKER_STALE_SECONDS,
)
from modules.operator_bot.sources import CREATIVE_ACTIVE, parse_ts


def _num(value) -> Optional[float]:
    if value is None or isinstance(value, bool) or value == "":
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def classify_render_jobs(rows, now: datetime, cfg: OperatorConfig) -> dict:
    """running / queued / stuck / failed / succeeded for ``render_jobs`` rows.

    stuck = running with a heartbeat older than STUCK_HEARTBEAT_MINUTES (the
    database's own "abandoned" line), or queued for longer than the configured
    wait (with no worker taking it)."""
    out = {"running": [], "queued": [], "stuck": [], "failed": [], "succeeded": []}
    for r in rows or []:
        status = r.get("status")
        if status == "running":
            out["running"].append(r)
            beat = parse_ts(r.get("heartbeat_at")) or parse_ts(r.get("started_at"))
            if beat is None or now - beat > timedelta(minutes=STUCK_HEARTBEAT_MINUTES):
                out["stuck"].append(r)
        elif status == "queued":
            out["queued"].append(r)
            created = parse_ts(r.get("created_at"))
            if created is not None and now - created > timedelta(minutes=cfg.stuck_minutes):
                out["stuck"].append(r)
        elif status == "failed":
            out["failed"].append(r)
        elif status == "succeeded":
            out["succeeded"].append(r)
    return out


def classify_creative_jobs(rows, now: datetime, cfg: OperatorConfig) -> dict:
    out = {"running": [], "queued": [], "stuck": [], "failed": [], "completed": []}
    for r in rows or []:
        status = r.get("status")
        if status in CREATIVE_ACTIVE:
            (out["queued"] if status == "queued" else out["running"]).append(r)
            if status == "queued":
                created = parse_ts(r.get("created_at"))
                if created is not None and now - created > timedelta(minutes=cfg.stuck_minutes):
                    out["stuck"].append(r)
            else:
                beat = parse_ts(r.get("heartbeat_at"))
                # provider_pending jobs wait on the provider and may not beat.
                if beat is not None and status != "provider_pending" \
                        and now - beat > timedelta(minutes=STUCK_HEARTBEAT_MINUTES):
                    out["stuck"].append(r)
        elif status == "failed":
            out["failed"].append(r)
        elif status == "completed":
            out["completed"].append(r)
    return out


def classify_workers(rows, now: datetime) -> list[dict]:
    """Each worker with ``age_s`` (since its last report) and ``stale``: said
    'running'/'starting' but has not reported for WORKER_STALE_SECONDS."""
    out = []
    for r in rows or []:
        updated = parse_ts(r.get("updated_at"))
        age = None if updated is None else max(0, int((now - updated).total_seconds()))
        state = r.get("state")
        out.append({
            **r, "age_s": age,
            "stale": state in ("running", "starting") and (age is None or age > WORKER_STALE_SECONDS),
        })
    return out


#: A queued film segment nobody claimed for this long: the film worker is not claiming (off, refusing to start, or
#: gone). A customer's credits are on hold the whole time.
FILM_QUEUED_STUCK = timedelta(minutes=15)
#: A running / draining segment whose lease heartbeat is this old: its worker is gone. 0171 hands a stale lease to
#: the next claim, but only a running worker claims, so past this a person should look.
FILM_LEASE_STUCK = timedelta(minutes=20)
_SQLSTATE = re.compile(r"[0-9A-Z]{5}")
#: The calls 0171's film_record_skip names.
FILM_SKIP_CALLS = ("claim", "sweep")


def film_stuck_segments(rows, now: datetime) -> list[dict]:
    """Open film segments that are stuck: ``{**row, "why": "queued"|"lease", "since": datetime}``.

    queued = no claim (``claimed_at`` empty) for FILM_QUEUED_STUCK since it was created; lease = running or draining
    with a heartbeat older than FILM_LEASE_STUCK. A running segment with no heartbeat at all is judged by its claim:
    an unknown heartbeat is not a fresh one. A row with no usable time is never called stuck (we cannot tell)."""
    out = []
    for r in rows or []:
        status = r.get("status")
        if status == "queued" and not r.get("claimed_at"):
            since = parse_ts(r.get("created_at"))
            if since is not None and now - since > FILM_QUEUED_STUCK:
                out.append({**r, "why": "queued", "since": since})
        elif status in ("running", "draining"):
            since = parse_ts(r.get("heartbeat_at")) or parse_ts(r.get("claimed_at"))
            if since is not None and now - since > FILM_LEASE_STUCK:
                out.append({**r, "why": "lease", "since": since})
    return out


def film_not_captured(row) -> Optional[float]:
    """The credits a settle could not capture, when the event says a positive number; None otherwise (missing,
    zero, negative or not a number is not an alert)."""
    v = _num(row.get("not_captured") if isinstance(row, dict) else None)
    return v if v is not None and v > 0 else None


def film_sqlstate(value) -> str:
    """A SQLSTATE as printed in an alert: five characters of the closed alphabet, else ``?``."""
    text = str(value or "")
    return text if _SQLSTATE.fullmatch(text) else "?"


def film_skip_call(value) -> str:
    return value if value in FILM_SKIP_CALLS else "?"


def film_sweep_state(data) -> dict:
    """0212's ``film_sweep_status()`` answer, read defensively (the function is still being revised): ``overdue`` is
    True, False or None (never recorded, or a key this reader does not find: unknown, NEVER fine), plus the newest
    completed sweep, the open segment count and the overdue line, each None when absent."""
    d = data if isinstance(data, dict) else {}
    raw = d.get("overdue")
    overdue = raw if isinstance(raw, bool) else None
    newest = parse_ts(d.get("last_at"))
    if newest is None:
        runners = d.get("runners") if isinstance(d.get("runners"), dict) else {}
        stamps = [parse_ts(r.get("last_at")) for r in runners.values() if isinstance(r, dict)]
        stamps = [s for s in stamps if s is not None]
        newest = max(stamps) if stamps else None
    open_n = _num(d.get("open_segments"))
    after = _num(d.get("overdue_after_minutes"))
    # "answered": the function said null itself (never recorded), as opposed to a shape without the key.
    return {"overdue": overdue, "answered": "overdue" in d and (raw is None or overdue is not None),
            "last_at": newest, "open": None if open_n is None else int(open_n),
            "after_min": None if after is None else int(after)}


def worker_role(row) -> str:
    """Which worker a worker_status row speaks for, for "is another one of these alive?".

    Kind ``other`` is shared by unrelated workers (the e-mail worker ``email-…``, the film worker ``film-…``, the
    deploy probe), so for it the id's prefix says which: a fresh e-mail worker must not hide a silent film worker, nor
    the other way round. Every other kind is one role, whatever the container id."""
    kind = str(row.get("kind") or "")
    if kind != "other":
        return kind
    return "other:" + str(row.get("worker_id") or "").split("-", 1)[0]


def balance_flags(rows, low_credits: float) -> list[dict]:
    """Balance rows with ``low`` set. Only ElevenLabs has a threshold (the one
    modules/provider_balance already uses); every other provider is never
    called low, because nothing says what low means for it."""
    out = []
    for r in rows or []:
        remaining = _num(r.get("remaining"))
        low = r.get("provider") == "elevenlabs" and remaining is not None and remaining < low_credits
        out.append({**r, "remaining_n": remaining, "low": low})
    return out


def summarize_costs(rows) -> dict:
    """Provider cost in USD for ``creative_job_costs`` rows. ``usd`` is the sum
    of the PRICED rows; ``complete`` is False when any row is unpriced, so the
    caller labels the figure a floor, never the total (CLAUDE.md #5)."""
    priced = 0.0
    n_priced = n_unpriced = 0
    for r in rows or []:
        v = _num(r.get("usd_estimate"))
        if v is None:
            n_unpriced += 1
        else:
            priced += v
            n_priced += 1
    return {"usd": priced if n_priced else None, "priced": n_priced, "unpriced": n_unpriced,
            "complete": n_unpriced == 0 and n_priced > 0, "rows": n_priced + n_unpriced}


def sum_credits(rows) -> Optional[float]:
    vals = [_num(r.get("charged_credits")) for r in rows or []]
    known = [v for v in vals if v is not None]
    return sum(known) if known else (0.0 if not rows else None)


def payment_kind(event_type) -> str:
    """payment | refund | subscription | other, from the provider's event type
    (``transaction.completed``, ``adjustment.updated``, ...). A refund and a
    chargeback are both adjustments; the table does not say which."""
    head = str(event_type or "").split(".")[0]
    return {"transaction": "payment", "adjustment": "refund", "subscription": "subscription"}.get(head, "other")


def classify_payments(rows, since: datetime) -> dict:
    """The events received since ``since``, sorted into: paid (a purchase that
    was credited), rejected (paid but not credited, or a refund not applied:
    needs a person), failed (the provider retries), refunds (a refund or
    chargeback that was applied)."""
    out = {"paid": [], "rejected": [], "failed": [], "refunds": []}
    for r in rows or []:
        at = parse_ts(r.get("received_at"))
        if at is not None and at < since:
            continue
        status, kind = r.get("status"), payment_kind(r.get("event_type"))
        if status == "rejected":
            out["rejected"].append(r)
        elif status == "failed":
            out["failed"].append(r)
        elif status == "processed" and kind == "refund":
            out["refunds"].append(r)
        elif status == "processed" and r.get("event_type") == "transaction.completed":
            out["paid"].append(r)
    return out


def review_queue(rows) -> list:
    """Held runs waiting for a person's decision: everything but those the gate
    blocked (a blocked run is kept, not waiting)."""
    return [r for r in rows or [] if r.get("publish_state") != "blocked"]


def count_by(rows, key) -> Counter:
    return Counter(str(r.get(key) or "unknown") for r in rows or [])


def event_counts(rows) -> dict:
    """Distinct (event, video) pairs per event name — a retried emit is one."""
    seen: dict = {}
    for r in rows or []:
        name = r.get("event")
        vid = r.get("video_id") or r.get("ts")
        seen.setdefault(name, set()).add(vid)
    return {k: len(v) for k, v in seen.items()}


def latest_run(runs: list) -> Optional[dict]:
    """The newest COMPLETED run of a workflow (an in-progress one has no verdict yet)."""
    for r in runs or []:
        if r.get("status") == "completed":
            return r
    return None


# -- marketing (information only) -------------------------------------------

#: The closed vocabularies of the poster's table (migration 0108). Error codes: only those a post that ENDED as failed or
#: dead can carry (``expired`` belongs to an approval that lapsed, a status the bot never announces). The summary
#: function returns nothing else, and this module keeps only these: a value
#: outside them is dropped, so no free text can reach a message even from a
#: database function that was changed behind this code's back.
MARKETING_STATUSES = ("draft", "approved", "sending", "sent", "failed", "dead", "rejected", "expired")
MARKETING_KINDS = ("news", "showcase", "price", "promo", "custom")
#: What the bot calls a kind it does not know (see :func:`marketing_kind`); counts per status already include every kind.
MARKETING_OTHER_KIND = "other"
MARKETING_ERROR_CODES = ("blocked", "bad_request", "not_configured", "rate_limited", "network", "http_5xx",
                         "unconfirmed")


def _count(value) -> Optional[int]:
    """A whole, non-negative count, or None. A missing count is unknown, not zero."""
    n = _num(value)
    return int(n) if n is not None and n >= 0 and n == int(n) else None


_KIND_CODE = re.compile(r"[a-z_]{1,24}")


def marketing_kind(value) -> Optional[str]:
    """A post kind the bot may name: one of the five it knows (migration 0110 added promo and custom), ``other`` for a
    clean closed code it does not know yet (a newer database adds kinds before
    this code does), else None (unknown). The word itself is never kept, so a
    kind that is not a plain lower-case code (free text, markup) cannot reach a
    message even if the function were changed behind this code's back."""
    if value in MARKETING_KINDS:
        return value
    return "other" if isinstance(value, str) and _KIND_CODE.fullmatch(value) else None


def marketing_state(summary) -> dict:
    """``operator_marketing_summary()``'s answer, reduced to what the bot may
    say: counts per status (None for one that is not a number), the week's use
    against its cap, the switch (None when unknown), the last sent post (kind
    and time) and the last failure (status, closed code, kind, time)."""
    s = summary if isinstance(summary, dict) else {}
    raw = s.get("counts") if isinstance(s.get("counts"), dict) else {}
    last = s.get("last_failure") if isinstance(s.get("last_failure"), dict) else None
    failure = None
    if last and last.get("status") in ("failed", "dead"):
        code = last.get("last_error_code")
        kind = last.get("kind")
        failure = {"status": last["status"], "code": code if code in MARKETING_ERROR_CODES else None,
                   "kind": marketing_kind(kind), "at": parse_ts(last.get("at"))}
    kind = s.get("last_sent_kind")
    enabled = s.get("enabled")
    return {
        "counts": {st: _count(raw.get(st)) for st in MARKETING_STATUSES},
        "used": _count(s.get("used_7d")),
        "cap": _count(s.get("max_per_7d")),
        "enabled": enabled if isinstance(enabled, bool) else None,
        "sent_at": parse_ts(s.get("last_sent_at")),
        "sent_kind": marketing_kind(kind),
        "failure": failure,
    }


def marketing_last_result(state: dict) -> Optional[dict]:
    """The newest outcome of a send, from a :func:`marketing_state`: ``sent`` or
    the failure, whichever is later. None when nothing has been sent or has failed."""
    sent = {"status": "sent", "code": None, "kind": state["sent_kind"], "at": state["sent_at"]} \
        if state["sent_at"] is not None else None
    fail = state["failure"]
    if sent and fail and fail["at"] is not None:
        return fail if fail["at"] > sent["at"] else sent
    return sent or fail
