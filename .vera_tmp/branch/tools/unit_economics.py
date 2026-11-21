#!/usr/bin/env python3
"""Unit economics from the cost ledger: what one finished video costs.

    python tools/unit_economics.py                         # local ledger, all channels
    python tools/unit_economics.py --channel my_channel --days 60 --max-videos 50
    python tools/unit_economics.py --source supabase       # read Supabase (service key from env)
    python tools/unit_economics.py --json                  # machine-readable

The same numbers the Command Center's Billing page shows in its "Unit
economics" card (command-center/lib/unitEconomics.ts), for pricing work from a
terminal: median and p90 cost per video and per finished minute, the cost
drivers, and which units still have no price.

The ledger's rule holds without exception. A video with ANY unpriced entry is
"partially priced": its priced part is a floor, so it is left out of every USD
median and driver share, and counted as excluded. The unpriced units are listed
with the exact env var that prices them (cost_ledger.price_env_var). Unknown is
None / "—", never 0.

Read-only. The local SQLite ledger is opened read-only and never created; the
Supabase read is a GET through modules.supabase_sync. Nothing here prints an
env value, a key, or a URL — only ledger quantities and dollar figures.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules.cost_ledger import price_env_var  # noqa: E402

DASH = "—"
_MEDIA_STAGE_PREFIXES = ("broll:", "image:")


# ── pure ────────────────────────────────────────────────────────────────────

def _text(value) -> Optional[str]:
    s = str(value).strip() if value is not None else ""
    return s or None


def _num(value) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def percentile(values: Iterable[float], p: float) -> Optional[float]:
    """Linear-interpolated percentile (0..1), or None for no values — the same
    definition as lib/billing.ts `percentile`, so both surfaces agree."""
    xs = sorted(v for v in values if _num(v) is not None)
    if not xs:
        return None
    idx = min(1.0, max(0.0, p)) * (len(xs) - 1)
    lo, hi = int(idx // 1), int(-(-idx // 1))
    return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo)


def provider_of(stage) -> Optional[str]:
    """The billing provider a media stage names ("broll:minimax"), else None."""
    s = _text(stage) or ""
    for prefix in _MEDIA_STAGE_PREFIXES:
        if s.startswith(prefix):
            return _text(s[len(prefix):])
    return None


def video_key(row: dict) -> Optional[str]:
    """Which video a ledger row belongs to — the slug first, because a held or
    blocked run records video_id="" and a scene repair records the slug alone."""
    ident = _text(row.get("slug")) or _text(row.get("video_id"))
    if not ident:
        return None
    return f"{_text(row.get('channel_id')) or ''}|{ident}"


def _parse_ts(value) -> Optional[datetime]:
    s = _text(value)
    if not s:
        return None
    try:
        ts = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


def _driver_key(unit: str, provider: Optional[str]) -> str:
    return f"{unit}:{provider}" if provider else unit


def summarize(
    rows: list,
    durations: Optional[list] = None,
    *,
    window_days: int = 30,
    max_videos: int = 30,
    now: Optional[datetime] = None,
) -> dict:
    """Per-video costs and the channel-level figures, from ledger rows.

    `durations` is a list of {channel_id, slug, video_id, duration_s}; a video
    without one is simply absent from the per-minute figures.
    """
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=window_days)

    lengths: dict = {}
    for d in durations or []:
        secs = _num(d.get("duration_s"))
        if secs is None or secs <= 0:
            continue
        ch = _text(d.get("channel_id")) or ""
        for ident in (_text(d.get("slug")), _text(d.get("video_id"))):
            if ident:
                lengths.setdefault(f"{ch}|{ident}", secs)

    groups: dict = {}
    unattributed = 0
    for row in rows or []:
        if _num(row.get("quantity")) is None:
            continue
        key = video_key(row)
        if key is None:
            unattributed += 1
            continue
        groups.setdefault(key, []).append(row)

    videos = []
    for key, entries in groups.items():
        stamps = [t for t in (_parse_ts(e.get("recorded_at")) for e in entries) if t]
        if not stamps:
            continue
        newest = max(stamps)
        if newest < since or newest > now:
            continue
        drivers: dict = {}
        unpriced: set = set()
        priced_usd = 0.0
        for e in entries:
            unit = _text(e.get("unit")) or "unknown"
            usd = _num(e.get("estimated_usd"))
            if usd is None:
                unpriced.add(unit)
            else:
                priced_usd += usd
            prov = provider_of(e.get("stage"))
            dk = _driver_key(unit, prov)
            d = drivers.setdefault(dk, {"key": dk, "unit": unit, "provider": prov, "quantity": 0.0, "usd": 0.0})
            d["quantity"] += float(e.get("quantity"))
            d["usd"] = None if d["usd"] is None or usd is None else d["usd"] + usd
        video_usd = None if unpriced else priced_usd
        # Look the length up under the slug and, for a published video, its id.
        ch = key.split("|", 1)[0]
        ids = [_text(entries[0].get("slug"))] + [_text(e.get("video_id")) for e in entries]
        secs = next((lengths[f"{ch}|{i}"] for i in ids if i and f"{ch}|{i}" in lengths), None)
        videos.append({
            "key": key,
            "slug": _text(entries[0].get("slug")),
            "video_id": next((i for i in ids[1:] if i), None),
            "channel_id": _text(entries[0].get("channel_id")),
            "recorded_at": newest.isoformat(),
            "priced_usd": priced_usd,
            "usd": video_usd,
            "unpriced_units": sorted(unpriced),
            "duration_s": secs,
            "usd_per_minute": video_usd / (secs / 60.0) if video_usd is not None and secs else None,
            "drivers": list(drivers.values()),
        })

    videos.sort(key=lambda v: v["recorded_at"], reverse=True)
    videos = videos[: max(0, max_videos)]
    priced = [v for v in videos if v["usd"] is not None]
    per_video = [v["usd"] for v in priced]
    per_minute = [v["usd_per_minute"] for v in priced if v["usd_per_minute"] is not None]
    priced_total = sum(per_video)

    driver_acc: dict = {}
    for v in priced:
        for d in v["drivers"]:
            cur = driver_acc.setdefault(d["key"], {**d, "quantity": 0.0, "usd": 0.0, "videos": 0})
            cur["quantity"] += d["quantity"]
            cur["usd"] += d["usd"] or 0.0
            cur["videos"] += 1
    drivers = sorted(driver_acc.values(), key=lambda d: (-d["usd"], -d["quantity"], d["key"]))
    for d in drivers:
        d["usd_per_video"] = d["usd"] / len(priced)
        d["share"] = d["usd"] / priced_total if priced_total > 0 else None

    unpriced_acc: dict = {}
    for v in videos:
        for unit in v["unpriced_units"]:
            u = unpriced_acc.setdefault(unit, {"unit": unit, "env_var": price_env_var(unit), "videos": 0, "quantity": 0.0})
            u["videos"] += 1
            u["quantity"] += sum(d["quantity"] for d in v["drivers"] if d["unit"] == unit and d["usd"] is None)
    unpriced_list = sorted(unpriced_acc.values(), key=lambda u: (-u["videos"], u["unit"]))

    return {
        "window_days": window_days,
        "max_videos": max_videos,
        "sample_size": len(videos),
        "priced_videos": len(priced),
        "partial_videos": len(videos) - len(priced),
        "median_per_video": percentile(per_video, 0.5),
        "p90_per_video": percentile(per_video, 0.9),
        "minute_sample": len(per_minute),
        "median_per_minute": percentile(per_minute, 0.5),
        "p90_per_minute": percentile(per_minute, 0.9),
        "drivers": drivers,
        "unpriced": unpriced_list,
        "unattributed_rows": unattributed,
        "videos": videos,
    }


def usd(value: Optional[float]) -> str:
    if value is None:
        return DASH
    return f"${value:.{3 if value != 0 and abs(value) < 1 else 2}f}"


def format_report(summary: dict, scope: str = "all channels") -> str:
    """A plain-text report. Every missing figure is a dash, never $0."""
    s = summary
    out = [
        f"Unit economics — {scope}: last {s['sample_size']} video(s), {s['window_days']} days",
        "",
    ]
    if s["sample_size"] == 0:
        out.append(f"No video recorded a cost in the last {s['window_days']} days.")
        return "\n".join(out)
    width = 28
    out += [
        f"{'Median per video':<{width}}{usd(s['median_per_video']):>12}",
        f"{'p90 per video':<{width}}{usd(s['p90_per_video']):>12}",
        f"{'Median per finished minute':<{width}}{usd(s['median_per_minute']):>12}",
        f"{'p90 per finished minute':<{width}}{usd(s['p90_per_minute']):>12}",
        "",
        f"Fully priced videos: {s['priced_videos']} of {s['sample_size']}"
        f" ({s['minute_sample']} with a known length)",
    ]
    if s["partial_videos"]:
        out.append(
            f"Excluded from $ figures: {s['partial_videos']} partially priced video(s)"
            " — their cost is unknown, not lower."
        )
    if s["unattributed_rows"]:
        out.append(f"Ledger rows with no video or slug (not counted): {s['unattributed_rows']}")

    out += ["", "Cost drivers (fully priced videos)"]
    if not s["drivers"]:
        out.append("  none — no fully priced video yet")
    else:
        out.append(f"  {'unit':<34}{'$/video':>10}{'share':>8}{'quantity':>16}")
        for d in s["drivers"]:
            share = DASH if d["share"] is None else f"{d['share'] * 100:.0f}%"
            out.append(f"  {d['key']:<34}{usd(d['usd_per_video']):>10}{share:>8}{d['quantity']:>16,.0f}")

    if s["unpriced"]:
        out += ["", "Unpriced units — set USD per single unit on the bot:"]
        for u in s["unpriced"]:
            out.append(f"  {u['env_var']:<44} {u['unit']} (in {u['videos']} video(s))")
    return "\n".join(out)


# ── sources (read-only) ─────────────────────────────────────────────────────

_COST_COLS = "video_id,slug,channel_id,unit,quantity,stage,estimated_usd,recorded_at"


def read_local(channel: Optional[str], since: datetime) -> tuple:
    """Ledger rows and Video IR lengths from this machine. The DB is opened
    read-only, and a missing one is an empty ledger rather than a new file."""
    from config import OUTPUT_DIR
    from modules import video_ir
    from modules.state_store import _resolve_db_path

    path = _resolve_db_path()
    if not path.exists():
        return [], []
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        sql = f"SELECT {_COST_COLS} FROM video_costs WHERE recorded_at >= ?"
        params: list = [since.isoformat()]
        if channel:
            sql += " AND channel_id = ?"
            params.append(channel)
        rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    except sqlite3.OperationalError:
        rows = []
    finally:
        conn.close()

    durations = []
    for slug in {r["slug"] for r in rows if _text(r.get("slug"))}:
        manifest = Path(OUTPUT_DIR) / slug / video_ir.PROJECT_FILENAME
        if not manifest.exists():
            continue
        project = video_ir.load(manifest)
        secs = getattr(getattr(project, "audio", None), "duration_s", None) if project else None
        channel_id = next((r["channel_id"] for r in rows if r["slug"] == slug), None)
        durations.append({"slug": slug, "channel_id": channel_id, "duration_s": secs})
    return rows, durations


def read_supabase(channel: Optional[str], since: datetime) -> tuple:
    """Ledger rows and Video IR lengths through the bot's Supabase helper."""
    from modules.supabase_sync import SupabaseSync

    sb = SupabaseSync()
    if not sb.enabled:
        raise SystemExit("Supabase is not configured: set SUPABASE_URL and SUPABASE_SERVICE_KEY.")
    params = {"select": _COST_COLS, "recorded_at": f"gte.{since.isoformat()}", "limit": "10000"}
    if channel:
        params["channel_id"] = f"eq.{channel}"
    rows = sb.select("video_costs", params)

    slugs = sorted({r["slug"] for r in rows if _text(r.get("slug"))})
    durations: list = []
    # Chunked so a long window does not exceed the URL length a proxy accepts.
    for i in range(0, len(slugs), 50):
        chunk = ",".join(f'"{s}"' for s in slugs[i:i + 50])
        durations += sb.select("videos", {
            "select": "video_id,slug,channel_id,duration_s:manifest->audio->duration_s",
            "slug": f"in.({chunk})",
        })
    return rows, durations


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description="What one finished video costs, from the cost ledger (read-only).")
    ap.add_argument("--source", choices=("local", "supabase"), default="local")
    ap.add_argument("--channel", help="channel_id to scope to (default: all channels)")
    ap.add_argument("--days", type=int, default=30, help="window in days (default 30)")
    ap.add_argument("--max-videos", type=int, default=30, help="most recent N videos (default 30)")
    ap.add_argument("--json", action="store_true", help="print JSON instead of a table")
    args = ap.parse_args(argv)

    now = datetime.now(timezone.utc)
    # Rows a little older than the window still belong to a video whose newest
    # entry is inside it (a repair days later), so read a wider slice.
    since = now - timedelta(days=args.days * 2)
    reader = read_supabase if args.source == "supabase" else read_local
    rows, durations = reader(args.channel, since)
    summary = summarize(rows, durations, window_days=args.days, max_videos=args.max_videos, now=now)
    if args.json:
        print(json.dumps(summary, indent=2, default=str))
    else:
        print(format_report(summary, scope=args.channel or "all channels"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
