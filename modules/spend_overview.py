"""Spend overview — per-account and All-Accounts cost visibility (roadmap #53).

The cost ledger (modules/cost_ledger.py) records what each video consumed —
quantities always, a USD figure only when the operator has priced that unit
(CHRONOS_PRICE_<UNIT>). budget.py already forecasts one channel's month-end
spend. This module answers the two questions the Accounts screens ask:

  * **Per account** (one channel): how much has this channel spent this month,
    which provider/unit consumed it, what the month-end pace projects to, and —
    when a ceiling is set — roughly how many more videos that budget covers.
  * **All Accounts**: the same rolled up across every channel.

Everything obeys the ledger's rule: **USD only when priced, null ≠ 0.** A unit
with no configured rate contributes its *quantity* but no dollars, and the
channel's USD total, its projection, and its "videos remaining" are all ``None``
whenever the price is unknown — never a fabricated number someone would take as
the real cost. Pure: it reads the store and computes; it prices nothing itself
and it never blocks a run.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import List, Optional

from modules import budget


def _num(value) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


@dataclass(frozen=True)
class UnitCost:
    """One provider/unit's consumption for a channel this month. `usd` is None
    when that unit is unpriced — its quantity is still real."""

    unit: str
    quantity: float
    usd: Optional[float]
    entries: int

    def to_dict(self) -> dict:
        return {"unit": self.unit, "quantity": self.quantity, "usd": self.usd, "entries": self.entries}


def unit_breakdown(rows: list) -> List[UnitCost]:
    """Per-unit consumption from cost rows. A unit's `usd` is None as soon as any
    of its entries is unpriced — a partial dollar sum would read as the unit's
    cost while hiding the rest. Sorted by known cost desc, then quantity."""
    acc: dict = {}
    for row in rows or []:
        unit = str((row or {}).get("unit") or "").strip() or "unknown"
        qty = _num(row.get("quantity")) or 0.0
        usd = _num(row.get("estimated_usd"))
        a = acc.setdefault(unit, {"quantity": 0.0, "usd": 0.0, "entries": 0, "any_unpriced": False})
        a["quantity"] += qty
        a["entries"] += 1
        if usd is None:
            a["any_unpriced"] = True
        else:
            a["usd"] += usd
    out = [
        UnitCost(unit=u, quantity=round(a["quantity"], 6),
                 usd=(None if a["any_unpriced"] else round(a["usd"], 6)), entries=a["entries"])
        for u, a in acc.items()
    ]
    out.sort(key=lambda c: (c.usd if c.usd is not None else -1.0, c.quantity), reverse=True)
    return out


@dataclass(frozen=True)
class ChannelSpend:
    channel_id: str
    name: str = ""
    spent_usd: Optional[float] = None       # month-to-date, None if nothing priced
    projected_usd: Optional[float] = None    # straight-line month-end
    ceiling_usd: Optional[float] = None
    video_count: int = 0                     # distinct videos billed this month
    avg_cost_usd: Optional[float] = None     # spent / videos, None if unknown
    videos_remaining: Optional[int] = None   # (ceiling - spent) / avg, when known
    has_unpriced: bool = False
    units: tuple = ()                        # UnitCost, biggest first

    def to_dict(self) -> dict:
        return {
            "channel_id": self.channel_id,
            "name": self.name or self.channel_id,
            "spent_usd": self.spent_usd,
            "projected_usd": self.projected_usd,
            "ceiling_usd": self.ceiling_usd,
            "video_count": self.video_count,
            "avg_cost_usd": self.avg_cost_usd,
            "videos_remaining": self.videos_remaining,
            "has_unpriced": self.has_unpriced,
            "units": [u.to_dict() for u in self.units],
        }


def channel_overview(store, channel_id: str, *, ceiling_usd: Optional[float] = None,
                     name: str = "", now: Optional[datetime] = None) -> ChannelSpend:
    """One channel's month-to-date spend picture. Never raises."""
    now = now or datetime.now(timezone.utc)
    since = budget.month_start_iso(now)
    try:
        rows = [r for r in (store.list_video_costs(channel_id=channel_id, limit=100000) or [])
                if str(r.get("recorded_at") or "") >= since]
    except Exception:
        rows = []

    priced_rows = [r for r in rows if _num(r.get("estimated_usd")) is not None]
    has_unpriced = len(priced_rows) < len(rows)
    spent = round(sum(_num(r.get("estimated_usd")) or 0.0 for r in priced_rows), 6) if priced_rows else None

    videos = {str(r.get("video_id") or r.get("slug") or "") for r in rows}
    videos.discard("")
    video_count = len(videos)
    priced_videos = {str(r.get("video_id") or r.get("slug") or "") for r in priced_rows}
    priced_videos.discard("")
    avg_cost = round(spent / len(priced_videos), 6) if (spent is not None and priced_videos) else None

    dim = budget._days_in_month(now)
    projected = budget.project_spend(spent, now.day, dim) if spent is not None else None

    ceil = float(ceiling_usd) if ceiling_usd is not None else None
    videos_remaining = None
    if ceil is not None and spent is not None and avg_cost and avg_cost > 0:
        videos_remaining = max(0, int((ceil - spent) // avg_cost))

    return ChannelSpend(
        channel_id=channel_id, name=name, spent_usd=spent, projected_usd=projected,
        ceiling_usd=ceil, video_count=video_count, avg_cost_usd=avg_cost,
        videos_remaining=videos_remaining, has_unpriced=has_unpriced,
        units=tuple(unit_breakdown(rows)),
    )


@dataclass(frozen=True)
class AllAccountsSpend:
    channels: tuple = ()                     # ChannelSpend, biggest spend first
    total_spent_usd: Optional[float] = None  # sum over channels with a known spend
    total_projected_usd: Optional[float] = None
    channel_count: int = 0
    any_unpriced: bool = False

    def to_dict(self) -> dict:
        return {
            "channels": [c.to_dict() for c in self.channels],
            "total_spent_usd": self.total_spent_usd,
            "total_projected_usd": self.total_projected_usd,
            "channel_count": self.channel_count,
            "any_unpriced": self.any_unpriced,
        }


def all_accounts_overview(store, channels: list, *, now: Optional[datetime] = None) -> AllAccountsSpend:
    """Roll the per-channel overview up across every account.

    `channels` is a list of dicts/objects carrying `channel_id`, optional `name`
    and optional `spend_ceiling_usd`. Totals sum only the channels with a known
    (priced) spend — the total stays None when nothing is priced anywhere, and
    `any_unpriced` flags that some cost is quantities-only. Never raises."""
    overviews: List[ChannelSpend] = []
    for ch in channels or []:
        cid = ch.get("channel_id") if isinstance(ch, dict) else getattr(ch, "channel_id", None)
        if not cid:
            continue
        name = (ch.get("name") if isinstance(ch, dict) else getattr(ch, "name", "")) or ""
        ceiling = ch.get("spend_ceiling_usd") if isinstance(ch, dict) else getattr(ch, "spend_ceiling_usd", None)
        overviews.append(channel_overview(store, str(cid), ceiling_usd=ceiling, name=name, now=now))

    priced = [o for o in overviews if o.spent_usd is not None]
    total_spent = round(sum(o.spent_usd for o in priced), 6) if priced else None
    proj = [o.projected_usd for o in overviews if o.projected_usd is not None]
    total_proj = round(sum(proj), 6) if proj else None
    overviews.sort(key=lambda o: (o.spent_usd if o.spent_usd is not None else -1.0), reverse=True)

    return AllAccountsSpend(
        channels=tuple(overviews), total_spent_usd=total_spent, total_projected_usd=total_proj,
        channel_count=len(overviews), any_unpriced=any(o.has_unpriced for o in overviews),
    )


def summarize(overview: AllAccountsSpend) -> dict:
    """Metadata for a `spend.overview` event."""
    return overview.to_dict()
