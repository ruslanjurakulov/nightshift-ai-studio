"""Per-channel spend ceiling — a hard stop that protects real money.

The cost ledger already records what a run spent (modules/cost_ledger.py). This
turns that history into a guard: a channel may set a spend ceiling, and a run
that would push the channel over it does not start. Off by default — a channel
with no ceiling behaves exactly as before.

Two honest rules:

* **Never block on missing data.** USD is known only for priced units; a run
  whose costs are all unpriced has an UNKNOWN spend, and unknown never blocks
  (that would stop production on a data gap). The status flags `has_unpriced`
  so the operator knows the number is a floor, not a ceiling.
* **A ceiling stops spending, not publishing autonomy.** It halts a run before
  it spends more; it never touches the publish gate or changes what an
  already-rendered video does.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

#: main.py's exit code for "the spend ceiling stopped the run before it spent
#: anything" (EX_CONFIG). Not a success: no video exists, so the queue worker
#: fails the job and RELEASES its credit hold instead of capturing it, and the
#: Actions step treats it like a pause (green, hold released).
BUDGET_STOP_EXIT = 78


class BudgetStop(Exception):
    """The run was stopped by the channel's spend ceiling, before spending."""


@dataclass(frozen=True)
class BudgetStatus:
    channel_id: str
    ceiling_usd: Optional[float]      # None = no ceiling set
    spent_usd: float                  # sum of PRICED costs in the window (a floor)
    has_unpriced: bool                # True if some costs had no USD rate
    priced_entries: int = 0
    unpriced_entries: int = 0

    @property
    def remaining_usd(self) -> Optional[float]:
        if self.ceiling_usd is None:
            return None
        return round(self.ceiling_usd - self.spent_usd, 6)

    @property
    def exceeded(self) -> bool:
        """True only when a ceiling is set AND the KNOWN spend already meets or
        passes it. Unknown spend never counts as exceeded."""
        return self.ceiling_usd is not None and self.spent_usd >= self.ceiling_usd

    def to_dict(self) -> dict:
        return {
            "channel_id": self.channel_id,
            "ceiling_usd": self.ceiling_usd,
            "spent_usd": self.spent_usd,
            "remaining_usd": self.remaining_usd,
            "exceeded": self.exceeded,
            "has_unpriced": self.has_unpriced,
            "priced_entries": self.priced_entries,
            "unpriced_entries": self.unpriced_entries,
        }


def channel_spend_usd(store, channel_id: str, *, since_iso: Optional[str] = None):
    """Sum a channel's recorded USD spend, optionally since an ISO timestamp.

    Returns (spent, priced_count, unpriced_count). `spent` counts only entries
    that carry a USD estimate; entries with no rate are counted separately, so a
    caller can tell a real 0 from "we don't have the price". Never raises."""
    spent = 0.0
    priced = 0
    unpriced = 0
    try:
        rows = store.list_video_costs(channel_id=channel_id, limit=100000)
    except Exception as e:
        logger.warning("Could not read channel costs (%s: %s)", type(e).__name__, e)
        return 0.0, 0, 0
    for row in rows or []:
        try:
            if since_iso and str(row.get("recorded_at") or "") < since_iso:
                continue
            usd = row.get("estimated_usd")
            if usd is None or usd == "":
                unpriced += 1
                continue
            spent += float(usd)
            priced += 1
        except Exception:
            continue
    return round(spent, 6), priced, unpriced


def check_budget(store, channel_id: str, ceiling_usd: Optional[float],
                 *, since_iso: Optional[str] = None) -> BudgetStatus:
    """The channel's budget state. `ceiling_usd` None → no ceiling (never
    exceeded). Never raises."""
    spent, priced, unpriced = channel_spend_usd(store, channel_id, since_iso=since_iso)
    return BudgetStatus(
        channel_id=channel_id,
        ceiling_usd=(float(ceiling_usd) if ceiling_usd is not None else None),
        spent_usd=spent,
        has_unpriced=unpriced > 0,
        priced_entries=priced,
        unpriced_entries=unpriced,
    )


def should_block_run(status: BudgetStatus) -> bool:
    """Whether a run must NOT start. True only when a ceiling is set and the
    known spend has reached it — a data gap (unknown spend) never blocks."""
    return status.exceeded


def month_start_iso(now: Optional[datetime] = None) -> str:
    """First instant of the current UTC month, ISO — the default window for a
    monthly ceiling."""
    now = now or datetime.now(timezone.utc)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()


def _days_in_month(now: datetime) -> int:
    """Calendar days in `now`'s month."""
    if now.month == 12:
        nxt = now.replace(year=now.year + 1, month=1, day=1)
    else:
        nxt = now.replace(month=now.month + 1, day=1)
    return (nxt.date() - now.replace(day=1).date()).days


def project_spend(spent_usd: float, elapsed_days: float, days_in_month: float) -> Optional[float]:
    """Straight-line projection of month-end spend from spend so far.

    `spent / elapsed * total` — the simplest honest forecast. Returns None when
    it can't be computed (no elapsed time yet) rather than a fabricated number;
    the caller is also given the elapsed days so it can weigh how thin the basis
    is (a projection off day one is a guess, and reads as one)."""
    try:
        if elapsed_days <= 0 or days_in_month <= 0:
            return None
        return round(float(spent_usd) / float(elapsed_days) * float(days_in_month), 6)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


@dataclass(frozen=True)
class SpendForecast:
    channel_id: str
    spent_usd: float                    # month-to-date PRICED spend (a floor)
    elapsed_days: int
    days_in_month: int
    projected_usd: Optional[float]      # straight-line month-end, or None
    ceiling_usd: Optional[float]
    has_unpriced: bool

    @property
    def projected_exceeds(self) -> bool:
        """True only when a ceiling is set AND the projection is known and meets
        or passes it. An unknown projection never counts as exceeding — a
        forecast is advisory and must not raise a false alarm on thin data."""
        return (
            self.ceiling_usd is not None
            and self.projected_usd is not None
            and self.projected_usd >= self.ceiling_usd
        )

    def to_dict(self) -> dict:
        return {
            "channel_id": self.channel_id,
            "spent_usd": self.spent_usd,
            "elapsed_days": self.elapsed_days,
            "days_in_month": self.days_in_month,
            "projected_usd": self.projected_usd,
            "ceiling_usd": self.ceiling_usd,
            "projected_exceeds": self.projected_exceeds,
            "has_unpriced": self.has_unpriced,
        }


def forecast_month_end(store, channel_id: str, ceiling_usd: Optional[float] = None,
                       *, now: Optional[datetime] = None) -> SpendForecast:
    """Project this channel's month-end USD spend from its month-to-date spend.

    Advisory: it forecasts for a human/Command Center and, when a ceiling is
    set, flags whether the current pace is on track to blow it — it never blocks
    a run (that is `check_budget`/`should_block_run`). Never raises."""
    now = now or datetime.now(timezone.utc)
    spent, priced, unpriced = channel_spend_usd(store, channel_id, since_iso=month_start_iso(now))
    dim = _days_in_month(now)
    elapsed = now.day  # day 1 → 1 elapsed day; a simple, honest denominator
    return SpendForecast(
        channel_id=channel_id,
        spent_usd=spent,
        elapsed_days=elapsed,
        days_in_month=dim,
        projected_usd=project_spend(spent, elapsed, dim),
        ceiling_usd=(float(ceiling_usd) if ceiling_usd is not None else None),
        has_unpriced=unpriced > 0,
    )
