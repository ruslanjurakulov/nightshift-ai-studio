#!/usr/bin/env python3
"""Telegram control-panel transport — the piece modules/telegram_control.py
deliberately left to a driver.

The module is the pure, testable core: it formats notifications, routes a
command to a reply, and turns an action into an *intent* it refuses to execute
itself. This script is the transport around it: it long-polls Telegram for new
messages (``getUpdates``), routes each through ``route_command``, and sends the
reply back to whoever asked. Action commands (``/publish``, ``/pause``,
``/resume``) are emitted as ``telegram.command`` events carrying the intent, for
the pipeline/driver to execute under the normal gate — this transport never
uploads a video or flips a channel's autonomy.

Off unless configured: with no ``TELEGRAM_BOT_TOKEN`` / ``TELEGRAM_CHAT_ID`` it
logs that it is disabled and exits 0, so a scheduled job is harmless until the
operator sets the secrets. Always exits 0 — a poll that finds nothing is normal.

Usage:
  python tools/run_telegram_control.py            # one polling batch
Configuration (env): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (the admin chat).
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("run_telegram_control")

from config import HISTORY_DIR
from modules import event_log as events
from modules.telegram_control import TelegramControl, route_command

_API_BASE = "https://api.telegram.org"
_OFFSET_FILE = HISTORY_DIR / "telegram_offset.json"


# -- a real ControlDeps, reading the system's own state ---------------------

class StoreDeps:
    """Answers the read-only queries from the state store and channel registry.
    Every method is defensive: a read failure yields an empty/short answer, so a
    query never throws (route_command also guards, this is belt-and-braces)."""

    def status_summary(self) -> str:
        try:
            from modules.state_store import StateStore
            with StateStore() as store:
                videos = store.list_videos(limit=100000)
            total = len(videos)
            return f"Nightshift: {total} video(s) in the library."
        except Exception as e:
            logger.warning("status_summary failed (%s: %s)", type(e).__name__, e)
            return "Status unavailable right now."

    def list_channels(self) -> list[dict]:
        try:
            from modules.channels import ChannelRegistry
            rows = []
            for c in ChannelRegistry().list():
                d = c.to_dict() if hasattr(c, "to_dict") else {}
                rows.append({
                    "channel_id": d.get("channel_id", getattr(c, "channel_id", "?")),
                    "status": d.get("status", getattr(c, "status", "?")),
                    "auto_publish": d.get("auto_publish", getattr(c, "auto_publish", True)),
                })
            return rows
        except Exception as e:
            logger.warning("list_channels failed (%s: %s)", type(e).__name__, e)
            return []

    def pending_review(self) -> list[dict]:
        """Videos the gate passed but auto-publish held, from recent
        `publish.held` events (the honest source for 'held for review')."""
        try:
            from modules.state_store import StateStore
            with StateStore() as store:
                rows = store.list_events(limit=200) or []
            held = []
            for e in rows:
                if e.get("event") != "publish.held":
                    continue
                meta = e.get("metadata")
                if isinstance(meta, str):
                    try:
                        meta = json.loads(meta)
                    except Exception:
                        meta = {}
                meta = meta or {}
                held.append({"video_id": e.get("video_id") or meta.get("slug"),
                             "title": meta.get("title") or meta.get("topic")})
                if len(held) >= 20:
                    break
            return held
        except Exception as e:
            logger.warning("pending_review failed (%s: %s)", type(e).__name__, e)
            return []


# -- transport --------------------------------------------------------------

def _load_offset() -> int:
    try:
        return int(json.loads(_OFFSET_FILE.read_text()).get("offset", 0))
    except Exception:
        return 0


def _save_offset(offset: int) -> None:
    try:
        _OFFSET_FILE.parent.mkdir(parents=True, exist_ok=True)
        _OFFSET_FILE.write_text(json.dumps({"offset": offset}))
    except Exception as e:
        logger.warning("Could not persist Telegram offset (%s: %s)", type(e).__name__, e)


def poll_once(control: TelegramControl, deps, *, session=None, offset: int = 0, timeout: int = 0) -> int:
    """Fetch one batch of updates, route each message, send its reply, and emit
    an event per action intent. Returns the offset to use next (max update_id +
    1). Never raises — a bad batch returns the offset unchanged."""
    import requests
    session = session or requests
    token = getattr(control, "_token", "")
    if not token:
        return offset

    try:
        resp = session.get(f"{_API_BASE}/bot{token}/getUpdates",
                           params={"offset": offset, "timeout": timeout}, timeout=timeout + 15)
        resp.raise_for_status()
        updates = (resp.json() or {}).get("result", []) or []
    except Exception as e:
        logger.warning("Telegram getUpdates failed (%s: %s)", type(e).__name__, e)
        return offset

    next_offset = offset
    for upd in updates:
        try:
            update_id = int(upd.get("update_id", 0))
            next_offset = max(next_offset, update_id + 1)
            message = upd.get("message") or upd.get("edited_message") or {}
            text = message.get("text") or ""
            chat_id = (message.get("chat") or {}).get("id")
            if not text or chat_id is None:
                continue
            result = route_command(text, chat_id, control, deps)
            control.send(chat_id, result.reply)
            if result.intent:
                events.emit(events.TELEGRAM_COMMAND, agent="telegram_control",
                            status=events.STATUS_COMPLETED, metadata=result.intent)
                logger.info("Telegram intent recorded: %s", result.intent)
        except Exception as e:
            logger.warning("Failed to process a Telegram update (%s: %s)", type(e).__name__, e)
            continue
    return next_offset


def main() -> int:
    control = TelegramControl()
    if not control.enabled:
        logger.info("Telegram control panel not configured (set TELEGRAM_BOT_TOKEN + "
                    "TELEGRAM_CHAT_ID) — nothing to poll")
        return 0
    offset = _load_offset()
    new_offset = poll_once(control, StoreDeps(), offset=offset)
    if new_offset != offset:
        _save_offset(new_offset)
    logger.info("Telegram poll done (offset %d → %d)", offset, new_offset)
    return 0


if __name__ == "__main__":
    sys.exit(main())
