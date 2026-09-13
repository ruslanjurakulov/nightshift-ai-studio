"""Telegram control panel — notifications, read-only queries, and gated actions.

Three capabilities, in ascending order of trust:

1. **Notifications** — the pipeline pushes what happened (published / blocked /
   held / failed) to a Telegram chat. Outbound only, and degrade-safe: a missing
   token or a network blip is logged and swallowed, never raised into a run.
2. **Queries** — a chat can ask read-only questions (`/status`, `/pending`,
   `/channels`, `/help`) and get an answer built from the system's own state.
3. **Actions** — a chat can ask to pause/resume a channel or publish a held
   video. These are parsed and AUTHORIZED here, then returned as an *intent*;
   this module never performs them itself. That keeps two invariants intact:
     * only the configured admin chat can issue a command, and
     * an action never bypasses the publish gate or a channel's autonomy — a
       `/publish` intent still runs through the normal gated upload path when a
       driver executes it. Nothing here uploads, and nothing here can turn the
       gate off.

Transport (an always-on webhook or long-poll that feeds updates in and runs the
intents out) is a deploy concern layered on top; this module is the pure,
testable core it would call. Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (the
admin chat — the only one whose commands are honoured).
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Optional, Protocol

logger = logging.getLogger(__name__)

_API_BASE = "https://api.telegram.org"


# -- outbound: notifications ------------------------------------------------

class TelegramControl:
    """Sends messages to the configured Telegram chat. Off (a no-op) unless both
    TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set. `notify` never raises."""

    def __init__(self, token: Optional[str] = None, chat_id: Optional[str] = None):
        self._token = (token if token is not None else os.getenv("TELEGRAM_BOT_TOKEN", "")).strip()
        self._chat_id = (chat_id if chat_id is not None else os.getenv("TELEGRAM_CHAT_ID", "")).strip()

    @property
    def enabled(self) -> bool:
        return bool(self._token and self._chat_id)

    def authorized(self, chat_id) -> bool:
        """True only for the configured admin chat. An unset admin chat
        authorizes NOBODY — commands are refused rather than opened to all."""
        return bool(self._chat_id) and str(chat_id).strip() == self._chat_id

    def notify(self, text: str) -> bool:
        """Send `text` to the admin chat. Returns True on success, False if it
        was skipped or failed. Never raises — observability must not break a run."""
        if not self.enabled:
            logger.debug("Telegram not configured — skipping notification")
            return False
        return self.send(self._chat_id, text)

    def send(self, chat_id, text: str) -> bool:
        """Send `text` to a specific chat (a command reply goes back to whoever
        asked, not only the admin chat). Returns True on success. No token or no
        chat_id → skipped; any error is swallowed. Never raises."""
        if not self._token or not str(chat_id).strip():
            return False
        try:
            import requests

            resp = requests.post(
                f"{_API_BASE}/bot{self._token}/sendMessage",
                json={"chat_id": str(chat_id), "text": text, "disable_web_page_preview": True},
                timeout=10,
            )
            if resp.status_code != 200:
                logger.warning("Telegram sendMessage returned %d", resp.status_code)
                return False
            return True
        except Exception as e:  # network, import, anything — swallow
            logger.warning("Telegram send failed (%s: %s)", type(e).__name__, e)
            return False


# -- notification formatting ------------------------------------------------

# Human, emoji-led one-liners per pipeline event. Kept small and honest: a held
# video is not a failure, a blocked one is a refusal, a published one is a win.
_EVENT_TEMPLATES = {
    "video.published": "✅ Published: {title}\n{url}",
    "publish.blocked": "⛔ Blocked by the gate ({blocks}) — kept for review: {title}",
    "publish.held": "⏸ Auto-publish OFF — gate passed, held for review: {title}",
    "upload.failed": "⚠️ Upload failed: {title} ({error})",
    "short.completed": "🎬 Short published: {url}",
    "system.started": "▶️ Run started — {channel} ({niche})",
}


def format_notification(event: str, metadata: Optional[dict] = None) -> Optional[str]:
    """Build a Telegram message for a pipeline event, or None for an event with
    no template (most events are not worth a push). Missing fields render as
    '?' rather than raising."""
    template = _EVENT_TEMPLATES.get(event)
    if not template:
        return None
    data = _SafeDict(metadata or {})
    try:
        return template.format_map(data)
    except Exception:
        return template  # never let formatting break a notification


class _SafeDict(dict):
    def __missing__(self, key):  # unknown placeholder → '?', not a crash
        return "?"


# -- inbound: command routing -----------------------------------------------

class ControlDeps(Protocol):
    """What the router reads/asks. A real driver wires these to the state store
    and channel registry; a test passes a fake."""

    def status_summary(self) -> str: ...
    def list_channels(self) -> list[dict]: ...
    def pending_review(self) -> list[dict]: ...


@dataclass(frozen=True)
class CommandResult:
    """The outcome of one command. `reply` is what to send back. `intent`, when
    present, is an action for a driver to execute through the normal gated
    pipeline — this module never executes it. `authorized` is False when a
    non-admin chat tried a command (the reply then says so)."""

    reply: str
    intent: Optional[dict] = None
    authorized: bool = True


_HELP = (
    "Nightshift control panel\n"
    "/status — system status\n"
    "/channels — list channels\n"
    "/pending — videos held for review\n"
    "/publish <video_id> — publish a held video (still runs the gate)\n"
    "/pause <channel_id> — pause a channel\n"
    "/resume <channel_id> — resume a channel\n"
    "/help — this message"
)

# Commands that ask for an action rather than a read. They are parsed and
# authorized, then returned as an intent for the pipeline to run under the gate.
_ACTION_COMMANDS = {"publish", "pause", "resume"}


def route_command(text: str, chat_id, control: TelegramControl, deps: Optional[ControlDeps] = None) -> CommandResult:
    """Parse one Telegram message into a reply and, for actions, an intent.

    Read-only queries are answered from `deps`. Actions are refused for any chat
    that is not the configured admin, and even for the admin they are returned as
    an INTENT, never executed here — so a command can never bypass the publish
    gate or flip a channel's autonomy from inside this module."""
    parts = (text or "").strip().split()
    if not parts or not parts[0].startswith("/"):
        return CommandResult(reply="Not a command. Send /help for the list.")
    cmd = parts[0][1:].lower().split("@")[0]  # strip a /cmd@botname suffix
    args = parts[1:]

    if cmd == "help":
        return CommandResult(reply=_HELP)

    # Read-only queries — safe for the admin chat; still gated to the admin so
    # the panel doesn't leak channel state to arbitrary chats.
    if cmd in ("status", "channels", "pending"):
        if not control.authorized(chat_id):
            return CommandResult(reply="Not authorized.", authorized=False)
        if deps is None:
            return CommandResult(reply="No data source available.")
        try:
            if cmd == "status":
                return CommandResult(reply=deps.status_summary() or "No status available.")
            if cmd == "channels":
                rows = deps.list_channels() or []
                return CommandResult(reply=_format_channels(rows))
            if cmd == "pending":
                rows = deps.pending_review() or []
                return CommandResult(reply=_format_pending(rows))
        except Exception as e:
            logger.warning("Telegram query %s failed (%s: %s)", cmd, type(e).__name__, e)
            return CommandResult(reply="Could not read that right now.")

    if cmd in _ACTION_COMMANDS:
        if not control.authorized(chat_id):
            return CommandResult(reply="Not authorized.", authorized=False)
        if not args:
            return CommandResult(reply=f"Usage: /{cmd} <id>")
        target = args[0]
        intent = {"action": cmd, "target": target}
        note = (
            " The publish gate still decides — this only requests the normal "
            "upload." if cmd == "publish" else ""
        )
        return CommandResult(
            reply=f"Requested: {cmd} {target}.{note}",
            intent=intent,
        )

    return CommandResult(reply=f"Unknown command /{cmd}. Send /help.")


def _format_channels(rows: list[dict]) -> str:
    if not rows:
        return "No channels."
    lines = ["Channels:"]
    for r in rows:
        cid = r.get("channel_id", "?")
        status = r.get("status", "?")
        auto = "auto" if r.get("auto_publish", True) else "manual"
        lines.append(f"• {cid} — {status} · {auto}")
    return "\n".join(lines)


def _format_pending(rows: list[dict]) -> str:
    if not rows:
        return "Nothing held for review."
    lines = ["Held for review:"]
    for r in rows:
        vid = r.get("video_id") or r.get("slug") or "?"
        title = r.get("title") or r.get("topic") or ""
        lines.append(f"• {vid} — {title}".rstrip(" —"))
    return "\n".join(lines)
