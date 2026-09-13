"""Quota allocator — split a day's upload budget across channels by measured
performance, without starving a new channel.

A studio running several channels has a finite daily upload budget (YouTube's
API quota, render time, spend). Spreading it evenly wastes slots on channels
that aren't landing and starves the ones that are. This apportions the day's
slots in proportion to each channel's measured performance — while reserving a
baseline slot for every channel, so a brand-new channel still gets a chance to
gather the data that would earn it more.

Rules, matching the rest of the intelligence layer:

- **Proportional to measured performance, null ≠ 0.** A channel's weight is the
  mean views-per-day of its recent videos; a channel with no measured history
  has an *unknown* weight (not a zero), and rather than being starved it rides
  the reserved baseline until it has data. Views-per-day (not raw views) keeps
  an old catalogue from dominating a young one.
- **Advisory, and exact.** It recommends an allocation for a scheduler/human; it
  never publishes or schedules anything itself. The returned slots are whole
  numbers that sum to exactly the budget (largest-remainder apportionment), so a
  caller can act on them directly.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from statistics import mean
from typing import Optional

logger = logging.getLogger(__name__)


def _largest_remainder(weights: dict, total: int) -> dict:
    """Apportion `total` whole slots across keys in proportion to `weights`,
    using the largest-remainder (Hamilton) method so the result sums to exactly
    `total`. Non-positive total → all zero. Zero total weight → as even as
    possible."""
    ids = list(weights)
    if not ids or total <= 0:
        return {i: 0 for i in ids}
    wsum = sum(max(0.0, float(w)) for w in weights.values())
    if wsum <= 0:
        weights = {i: 1.0 for i in ids}
        wsum = float(len(ids))
    quotas = {i: max(0.0, float(weights[i])) / wsum * total for i in ids}
    floors = {i: int(q) for i, q in quotas.items()}
    used = sum(floors.values())
    remainder = total - used
    # Hand out the leftover slots to the largest fractional remainders.
    order = sorted(ids, key=lambda i: (quotas[i] - floors[i], quotas[i]), reverse=True)
    for i in order[:remainder]:
        floors[i] += 1
    return floors


def allocate(channel_scores: dict, total_slots: int, *, min_per_channel: int = 1) -> dict:
    """Allocate `total_slots` whole upload slots across channels.

    Each channel first gets `min_per_channel` (capped so the reserves fit the
    budget), then the remainder is apportioned in proportion to score. Scores of
    0 / unknown keep only their reserved baseline; if every score is 0 the whole
    budget is split as evenly as possible. Always returns whole numbers summing
    to `min(total_slots, ...)` — exactly `total_slots` when positive."""
    ids = list(channel_scores)
    if not ids or total_slots <= 0:
        return {i: 0 for i in ids}

    n = len(ids)
    base = min(max(0, min_per_channel), total_slots // n)
    result = {i: base for i in ids}
    remaining = total_slots - base * n
    if remaining <= 0:
        # Reserves already fill (or exceed a per-channel cap of) the budget:
        # apportion the whole budget evenly instead.
        return _largest_remainder({i: 1.0 for i in ids}, total_slots)

    weights = {i: max(0.0, float(channel_scores[i] or 0)) for i in ids}
    extra = _largest_remainder(weights, remaining)
    for i in ids:
        result[i] += extra[i]
    return result


def _parse_dt(value) -> Optional[datetime]:
    if not value:
        return None
    try:
        s = str(value).strip().replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def _num(value) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def performance_scores(videos_by_channel: dict, metrics_by_id: dict, *,
                       now: Optional[datetime] = None) -> dict:
    """A per-channel performance weight = mean views-per-day of its long-form
    videos with a known view count. A channel with no measured video scores 0.0
    (unknown, not a real zero) — `allocate` still reserves it a baseline slot."""
    now = now or datetime.now(timezone.utc)
    scores = {}
    for channel_id, videos in (videos_by_channel or {}).items():
        rates = []
        for v in videos or []:
            if (v.get("video_format") or "long") == "short":
                continue
            m = metrics_by_id.get(v.get("video_id")) if metrics_by_id else None
            views = _num(m.get("views")) if m else None
            dt = _parse_dt(v.get("published_at"))
            if views is None or dt is None:
                continue  # null ≠ 0: unmeasured videos don't set a weight
            age_days = max(1.0, (now - dt).total_seconds() / 86400.0)
            rates.append(views / age_days)
        scores[channel_id] = mean(rates) if rates else 0.0
    return scores


def _read_history(store, channel_ids: list) -> tuple[dict, dict]:
    """(videos_by_channel, metrics_by_id) read from `store`. A per-channel read
    failure yields no videos for that channel (it scores 0 and rides its
    reserved baseline), never an exception."""
    videos_by_channel: dict = {}
    metrics_by_id: dict = {}
    for cid in channel_ids or []:
        try:
            videos = store.list_videos(limit=100000, channel_id=cid)
        except Exception:
            logger.warning("Could not read videos for channel %s; scoring it 0", cid)
            videos = []
        videos_by_channel[cid] = videos
        for v in videos:
            vid = v.get("video_id")
            if not vid:
                continue
            try:
                m = store.latest_metrics(vid)
            except Exception:
                m = None
            if m is not None:
                metrics_by_id[vid] = m
    return videos_by_channel, metrics_by_id


def recommend_with_scores(store, channel_ids: list, total_slots: int, *,
                          min_per_channel: int = 1, now: Optional[datetime] = None) -> tuple[dict, dict]:
    """Like `recommend_allocation`, but returns (scores, allocation) so a caller
    can *explain* the split — what each channel's measured weight was, not just
    how many slots it got. Never raises."""
    videos_by_channel, metrics_by_id = _read_history(store, channel_ids)
    scores = performance_scores(videos_by_channel, metrics_by_id, now=now)
    allocation = allocate(scores, total_slots, min_per_channel=min_per_channel)
    return scores, allocation


def recommend_allocation(store, channel_ids: list, total_slots: int, *,
                         min_per_channel: int = 1, now: Optional[datetime] = None) -> dict:
    """Read each channel's history from `store` and return a slot allocation.

    Advisory: it hands a scheduler/human the recommended split; it never
    schedules or publishes. Never raises — a read failure scores that channel 0
    (it still gets its reserved baseline)."""
    _, allocation = recommend_with_scores(
        store, channel_ids, total_slots, min_per_channel=min_per_channel, now=now)
    return allocation


def summarize(scores: dict, allocation: dict, *, total_slots: int, names: Optional[dict] = None) -> dict:
    """Metadata for a single `quota.allocated` event: per-channel slots and the
    measured weight behind each, best-allocated first. `share` is a channel's
    fraction of the total measured performance, or None when nothing measured
    (null ≠ 0 — an unmeasured channel's share is unknown, not zero)."""
    names = names or {}
    total_score = sum(max(0.0, float(s or 0)) for s in (scores or {}).values())
    rows = []
    for cid in allocation or {}:
        score = _num(scores.get(cid)) or 0.0
        rows.append({
            "channel_id": cid,
            "name": names.get(cid) or cid,
            "slots": int(allocation.get(cid, 0)),
            "score": round(score, 3),
            "share": round(score / total_score, 4) if total_score > 0 else None,
        })
    rows.sort(key=lambda r: (r["slots"], r["score"]), reverse=True)
    return {
        "total_slots": total_slots,
        "channel_count": len(allocation or {}),
        "channels": rows,
    }
