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

Replays are harmless. The offset lives in ``history/`` (an Actions cache
that is evicted after a week unused, and restored by prefix — possibly an
older copy), so Telegram can hand the same updates over again. Every update is
therefore CLAIMED by its ``update_id`` in Supabase (``telegram_updates``,
migration 0042) before it is handled, and one that was already claimed is
skipped. When the claim cannot be made — Supabase not configured, unreachable,
or 0042 not applied — read-only queries are still answered (a repeated
``/status`` reply is harmless) but actions are refused, since a replay could
repeat them. An action older than ``ACTION_MAX_AGE_S`` is refused as well, and
edited messages are ignored: editing an old ``/publish`` must not send it again.

Off unless configured: with no ``TELEGRAM_BOT_TOKEN`` / ``TELEGRAM_CHAT_ID`` it
logs that it is disabled and exits 0, so a scheduled job is harmless until the
operator sets the secrets. Always exits 0 — a poll that finds nothing is normal.

Updates are handled by modules/operator_bot (the same router the webhook
server uses): the read-only views, inline-keyboard buttons, mute, and the
legacy action intents. This file is only the transport.

Usage:
  python tools/run_telegram_control.py                  # one polling batch
  python tools/run_telegram_control.py --duration 270   # keep long-polling for
                                                        # ~4.5 minutes: replies
                                                        # arrive within a second
Configuration (env): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (the admin chat),
TELEGRAM_ADMIN_USER_IDS (who may command; see modules/telegram_control.py),
SUPABASE_URL + SUPABASE_SERVICE_KEY (the durable update claims and the data the
views read); the optional OPERATOR_* settings are in docs/operator-bot.md.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("run_telegram_control")

from config import HISTORY_DIR
from modules import log_redaction
from modules.log_redaction import describe_http_error
from modules.operator_bot import router as operator_router
from modules.operator_bot.router import ACTION_MAX_AGE_S, OperatorBot  # noqa: F401 (re-exported)
from modules.telegram_control import TelegramControl

# Re-exported: the age limit and the two refusal texts now live in the router
# (they are enforced there, for poll and webhook alike).
_NOT_DURABLE_REPLY = operator_router.NOT_DURABLE_REPLY
_TOO_OLD_REPLY = operator_router.TOO_OLD_REPLY

#: Only these update types are ever asked for; everything else is never sent.
ALLOWED_UPDATES = ["message", "callback_query"]
#: One Telegram long poll lasts at most this long (seconds).
LONG_POLL_S = 25

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


def _claim(store, update_ids: list[int]):
    """The subset of `update_ids` this run is the first to see, or None when
    that cannot be known (no durable store)."""
    if store is None or not getattr(store, "enabled", False):
        return None
    rows = store.insert_new("telegram_updates", [{"update_id": i} for i in update_ids], on_conflict="update_id")
    if rows is None:
        return None
    claimed = set()
    for r in rows:
        try:
            claimed.add(int(r.get("update_id")))
        except (TypeError, ValueError, AttributeError):
            continue
    return claimed


def _default_store():
    try:
        from modules.supabase_sync import SupabaseSync
        return SupabaseSync()
    except Exception as e:
        logger.warning("Supabase unavailable for Telegram update claims (%s)", type(e).__name__)
        return None


def poll_once(control: TelegramControl, deps, *, session=None, offset: int = 0, timeout: int = 0,
              store=None, now=None, bot=None) -> int:
    """Fetch one batch of updates, claim them durably, hand each new one to the
    operator router (reply, buttons, and an event per action intent). Returns
    the offset to use next (max update_id + 1). Never raises — a bad batch
    returns the offset unchanged."""
    import requests
    session = session or requests
    now = time.time() if now is None else now
    token = getattr(control, "_token", "")
    if not token:
        return offset

    try:
        resp = session.get(f"{_API_BASE}/bot{token}/getUpdates",
                           params={"offset": offset, "timeout": timeout,
                                   "allowed_updates": json.dumps(ALLOWED_UPDATES)}, timeout=timeout + 15)
        resp.raise_for_status()
        updates = (resp.json() or {}).get("result", []) or []
    except Exception as e:
        # Type and HTTP status only: raise_for_status() and every connection
        # error quote the URL, and the bot token is part of it.
        logger.warning("Telegram getUpdates failed (%s)", describe_http_error(e))
        return offset

    # Only updates from an allow-listed sender are claimed (a database write):
    # a stranger's update must not cost one, and is answered at most with a
    # neutral line, which a replay cannot turn into data or an action.
    to_claim = set()
    for upd in updates:
        try:
            if operator_router.classify(upd, control).kind in operator_router.CLAIMED_KINDS:
                to_claim.add(int(upd.get("update_id")))
        except (TypeError, ValueError, AttributeError):
            continue
    claimed = _claim(store if store is not None else _default_store(), sorted(to_claim)) if to_claim else set()
    durable = claimed is not None

    bot = bot or OperatorBot(control, deps, clock=lambda: now)
    next_offset = offset
    for upd in updates:
        try:
            update_id = int(upd.get("update_id", 0))
            next_offset = max(next_offset, update_id + 1)
            if update_id in to_claim and durable and update_id not in claimed:
                logger.info("Telegram update %d was already handled — skipped", update_id)
                continue
            # Authorization, rate limits, edits/forwards/other chats, the legacy
            # intent age check and the event emit all live in the router.
            bot.handle_update(upd, durable=durable)
        except Exception as e:
            logger.warning("Failed to process a Telegram update (%s)", type(e).__name__)
            continue
    return next_offset


def build_bot(control: TelegramControl, deps=None):
    """The router with its real data sources (needs Supabase for most views)."""
    from modules.operator_bot.config import OperatorConfig
    from modules.operator_bot.sources import OperatorSources, default_http_get
    from modules.operator_bot.store import SupabaseAlertStore
    from modules.supabase_sync import SupabaseSync

    cfg = OperatorConfig.from_env()
    sync = SupabaseSync()
    ops = OperatorSources(sync, default_http_get, cfg, github_token=os.getenv("GITHUB_TOKEN", ""))
    return OperatorBot(control, deps or StoreDeps(), ops, SupabaseAlertStore(sync), cfg), sync


def run(control: TelegramControl, bot, store, *, duration: float = 0, session=None, sleep=time.sleep,
        monotonic=time.monotonic) -> int:
    """Poll for ``duration`` seconds (0 = one batch, as before). Each long poll
    returns the moment a message arrives, so a reply goes out within a second
    or two; between polls the offset is persisted. Returns the final offset."""
    offset = _load_offset()
    start_offset = offset
    deadline = monotonic() + duration
    while True:
        t0 = monotonic()
        remaining = deadline - t0
        timeout = 0 if duration <= 0 else int(max(0, min(LONG_POLL_S, remaining)))
        new_offset = poll_once(control, None, session=session, offset=offset, timeout=timeout,
                               store=store, bot=bot)
        if new_offset != offset:
            _save_offset(new_offset)
            offset = new_offset
        if duration <= 0 or monotonic() >= deadline:
            break
        if monotonic() - t0 < 1.0:      # an error returned at once: do not spin
            sleep(2)
    logger.info("Telegram poll done (offset %d → %d)", start_offset, offset)
    return offset


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--duration", type=float, default=0,
                        help="seconds to keep long-polling (0 = a single batch)")
    args = parser.parse_args(argv)
    # This job's log is uploaded as an artifact: scrub any token-bearing URL
    # a library message might still carry.
    log_redaction.install()
    control = TelegramControl()
    if not control.enabled:
        logger.info("Telegram control panel not configured (set TELEGRAM_BOT_TOKEN + "
                    "TELEGRAM_CHAT_ID) — nothing to poll")
        return 0
    bot, sync = build_bot(control)
    run(control, bot, sync, duration=max(0.0, min(args.duration, 3600.0)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
