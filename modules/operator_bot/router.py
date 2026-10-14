"""One Telegram update in -> authorization -> at most a reply out.

Poll mode (tools/run_telegram_control.py) and webhook mode
(tools/operator_bot_server.py) both end here, so the authorization rules exist
exactly once.

Who may do anything (unchanged in kind, extended in coverage — every command and
every button goes through it):

* Only ``message`` and ``callback_query`` updates are looked at. An edited
  message, a channel post, a membership change, an inline query: ignored, no
  reply. Editing an old ``/publish`` must not send it again.
* A message needs a human sender (``from``, not a bot, no ``sender_chat``), must
  not be forwarded or sent via a bot, and must be written in the configured
  admin chat by an allow-listed ``from.id`` (``TelegramControl.authorized``).
  Anyone else gets no data: a command from a stranger is answered with a neutral
  "Not authorized." at most once per ten minutes per chat; plain text from a
  stranger gets nothing.
* A button press (callback query) needs the same: the allow-listed ``from.id``
  AND the message the button sits on must be in the admin chat. A press from
  another chat, or with no message attached (inline mode), is refused with a
  neutral toast and does no work.
* A sender is limited to ``RATE_MAX`` commands a minute; the excess is dropped
  after one "Slow down." notice.

What an authorized sender can ask for: read-only views (modules/operator_bot/
views.py), mute / unmute of alerts, and the legacy ``/publish`` ``/pause``
``/resume``, which still come back from ``route_command`` as INTENTS and are
recorded as events for the normal gated path — they are neither executed nor
widened here. Nothing in this file publishes, spends, approves or deletes.

No exception text ever reaches the chat: a failure answers "Could not read that
right now." and the type goes to the log.
"""

from __future__ import annotations

import logging
import re
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Optional

from modules import event_log as events
from modules.operator_bot import alerts as alerts_mod
from modules.operator_bot import views
from modules.operator_bot.config import OperatorConfig
from modules.operator_bot.sources import OperatorSources
from modules.telegram_control import TelegramControl, route_command
from modules.tg_text import html_escape, safe_id

logger = logging.getLogger(__name__)

#: An action request older than this is not acted on (a schedule that slipped
#: by hours, or a replayed batch, must not publish what was asked yesterday).
ACTION_MAX_AGE_S = 6 * 3600
RATE_MAX = 12
RATE_WINDOW_S = 60
STRANGER_REPLY_EVERY_S = 600

NOT_AUTHORIZED = "Not authorized."
NOT_DURABLE_REPLY = ("Not requested: this command could not be recorded durably, so a repeat "
                     "delivery could run it twice. Try again later.")
TOO_OLD_REPLY = "Not requested: this command is more than 6 hours old. Send it again if you still want it."
FAILED_REPLY = "Could not read that right now."
SLOW_DOWN = "Slow down — too many commands a minute."

#: Inbound kinds that come from an allow-listed sender and are claimed by
#: update_id before they are handled (a strangers' update is never claimed).
CLAIMED_KINDS = ("message", "callback", "forwarded")

_FORWARD_KEYS = ("forward_origin", "forward_from", "forward_from_chat", "forward_date",
                 "forward_sender_name", "forward_signature", "forward_from_message_id")
_LEGACY_READ = {"status", "channels", "pending"}
_LEGACY_ACTION = {"publish", "pause", "resume"}
_CALLBACK = re.compile(
    r"^(?:c:[a-z]{2,12}|a:(?:mute|unmute):[a-z]{2,12}|d:[a-z]{2,12})$")


@dataclass(frozen=True)
class Inbound:
    """An update, reduced to what the router acts on."""

    kind: str                       # message | callback | unauthorized | unauthorized_callback | forwarded | ignore
    chat_id: object = None
    user_id: object = None
    text: str = ""
    data: str = ""
    callback_id: str = ""
    date: object = None


def classify(upd: dict, control: TelegramControl) -> Inbound:
    """Reduce an update to an :class:`Inbound`. This is the authorization
    matrix; the webhook calls it BEFORE any other work."""
    if not isinstance(upd, dict):
        return Inbound("ignore")

    cq = upd.get("callback_query")
    if isinstance(cq, dict):
        sender = cq.get("from") or {}
        msg = cq.get("message") or {}
        chat = msg.get("chat") or {}
        if sender.get("is_bot"):
            return Inbound("ignore")
        cid = str(cq.get("id") or "")
        if not msg or not chat or not control.authorized(chat.get("id"), sender.get("id")):
            return Inbound("unauthorized_callback", callback_id=cid)
        return Inbound("callback", chat.get("id"), sender.get("id"), data=str(cq.get("data") or ""),
                       callback_id=cid)

    msg = upd.get("message")
    if not isinstance(msg, dict):          # edited_message, channel_post, my_chat_member, ...
        return Inbound("ignore")
    chat = msg.get("chat") or {}
    sender = msg.get("from") or {}
    text = msg.get("text") or ""
    ctype = chat.get("type")
    if ((ctype is not None and ctype not in ("private", "group", "supergroup")) or chat.get("id") is None
            or not sender or sender.get("is_bot") or msg.get("sender_chat") or msg.get("via_bot")
            or not text):
        return Inbound("ignore")
    ok = control.authorized(chat.get("id"), sender.get("id"))
    if not ok:
        return Inbound("unauthorized" if text.lstrip().startswith("/") else "ignore", chat.get("id"),
                       sender.get("id"))
    if any(k in msg for k in _FORWARD_KEYS):
        return Inbound("forwarded", chat.get("id"), sender.get("id"))
    return Inbound("message", chat.get("id"), sender.get("id"), text=text, date=msg.get("date"))


class SlidingLimiter:
    """At most ``max_calls`` per ``window`` seconds per key. ``allow`` returns
    (allowed, first_denial_in_this_window)."""

    def __init__(self, max_calls: int, window: float, clock: Callable[[], float] = time.time):
        self.max_calls, self.window, self._clock = max_calls, window, clock
        self._hits: dict = {}
        self._denied: dict = {}

    def allow(self, key) -> tuple[bool, bool]:
        now = self._clock()
        q = self._hits.setdefault(key, deque())
        while q and now - q[0] >= self.window:
            q.popleft()
        if len(q) < self.max_calls:
            q.append(now)
            self._denied.pop(key, None)
            return True, False
        first = key not in self._denied
        self._denied[key] = now
        return False, first

    def prune(self) -> None:
        """Forget idle keys (a long-running server would otherwise keep every sender it ever saw)."""
        now = self._clock()
        for k in [k for k, q in self._hits.items() if not q or now - q[-1] >= self.window]:
            self._hits.pop(k, None)
            self._denied.pop(k, None)


class OperatorBot:
    """Handles updates for one bot. ``deps`` is the legacy ControlDeps
    (status/channels/pending), ``ops`` the new read sources, ``store`` the
    alert memory; any may be None and the commands that need it say so."""

    def __init__(self, control: TelegramControl, deps=None, ops: Optional[OperatorSources] = None,
                 store=None, cfg: Optional[OperatorConfig] = None,
                 clock: Callable[[], float] = time.time):
        self.control, self.deps, self.ops, self.store = control, deps, ops, store
        self.cfg = cfg or (ops.cfg if ops is not None else OperatorConfig())
        self._clock = clock
        self.limiter = SlidingLimiter(RATE_MAX, RATE_WINDOW_S, clock)
        self.strangers = SlidingLimiter(1, STRANGER_REPLY_EVERY_S, clock)
        self._seen = 0

    # -- entry point ------------------------------------------------------

    def handle_update(self, upd: dict, *, durable: bool = True) -> None:
        """Process one update. Never raises."""
        try:
            self._seen += 1
            if self._seen % 200 == 0:
                self.limiter.prune()
                self.strangers.prune()
            inbound = classify(upd, self.control)
            if inbound.kind == "ignore":
                return
            if inbound.kind == "unauthorized":
                if self.strangers.allow(("chat", str(inbound.chat_id)))[0]:
                    self.control.send(inbound.chat_id, NOT_AUTHORIZED)
                return
            if inbound.kind == "unauthorized_callback":
                self.control.answer_callback(inbound.callback_id, "Not authorized")
                return
            allowed, first = self.limiter.allow(("user", str(inbound.user_id)))
            if not allowed:
                if first:
                    if inbound.kind == "callback":
                        self.control.answer_callback(inbound.callback_id, SLOW_DOWN)
                    else:
                        self.control.send(inbound.chat_id, SLOW_DOWN)
                elif inbound.kind == "callback":
                    self.control.answer_callback(inbound.callback_id)
                return
            if inbound.kind == "forwarded":
                self.control.send(inbound.chat_id, "Forwarded messages are not accepted. Type the command yourself.")
                return
            if inbound.kind == "callback":
                self._on_callback(inbound)
            else:
                self._on_message(inbound, durable)
        except Exception as e:  # last line of defence: log the type, say nothing specific
            logger.warning("Failed to process a Telegram update (%s)", type(e).__name__)

    # -- messages ---------------------------------------------------------

    def _on_message(self, inbound: Inbound, durable: bool) -> None:
        chat_id, text = inbound.chat_id, inbound.text
        parts = text.strip().split()
        if not parts or not parts[0].startswith("/"):
            self._reply(chat_id, views.Reply("Not a command. Send /help for the list.", parse_mode=None))
            return
        cmd, _, addressee = parts[0][1:].lower().partition("@")
        args = parts[1:]
        if addressee and addressee != (self.control.bot_username() or ""):
            return          # addressed to another bot (or to us, but we cannot tell): not ours to answer

        if cmd in _LEGACY_ACTION:
            self._legacy_action(inbound, durable)
            return
        try:
            self._reply(chat_id, self._view_for(cmd, args, inbound))
        except Exception as e:
            logger.warning("operator command %s failed (%s)", cmd[:20], type(e).__name__)
            self._reply(chat_id, views.Reply(FAILED_REPLY, parse_mode=None))

    def _legacy_action(self, inbound: Inbound, durable: bool) -> None:
        """/publish /pause /resume: the existing intent path, byte for byte.
        The result is an INTENT; it is recorded as an event for the gated
        pipeline to pick up. Refused when it cannot be recorded durably or is
        too old."""
        chat_id = inbound.chat_id
        result = route_command(inbound.text, chat_id, self.control, self.deps, user_id=inbound.user_id)
        if result.intent:
            if not durable:
                self.control.send(chat_id, NOT_DURABLE_REPLY)
                return
            sent_at = inbound.date
            if not isinstance(sent_at, (int, float)) or self._clock() - sent_at > ACTION_MAX_AGE_S:
                self.control.send(chat_id, TOO_OLD_REPLY)
                return
        self.control.send(chat_id, result.reply)
        if result.intent:
            events.emit(events.TELEGRAM_COMMAND, agent="telegram_control",
                        status=events.STATUS_COMPLETED, metadata=result.intent)
            logger.info("Telegram intent recorded: %s", result.intent)

    # -- buttons ----------------------------------------------------------

    def _on_callback(self, inbound: Inbound) -> None:
        data = inbound.data
        if not _CALLBACK.match(data):
            self.control.answer_callback(inbound.callback_id, "Unknown button")
            return
        try:
            kind, _, rest = data.partition(":")
            if kind == "c":
                self.control.answer_callback(inbound.callback_id)
                self._reply(inbound.chat_id, self._view_for(rest, [], inbound))
            elif kind == "d":
                cmd = views.KIND_COMMAND.get(rest)
                self.control.answer_callback(inbound.callback_id)
                if cmd:
                    self._reply(inbound.chat_id, self._view_for(cmd, [], inbound))
            else:  # a:mute:<kind> / a:unmute:<kind>
                action, _, alert_kind = rest.partition(":")
                reply = self._mute_reply(action == "mute", alert_kind)
                self.control.answer_callback(inbound.callback_id, "Muted" if action == "mute" else "Unmuted")
                self._reply(inbound.chat_id, reply)
        except Exception as e:
            logger.warning("operator button failed (%s)", type(e).__name__)
            self.control.answer_callback(inbound.callback_id, "Could not do that right now")

    # -- views ------------------------------------------------------------

    def _now(self) -> datetime:
        return self.ops.now() if self.ops is not None else datetime.now(timezone.utc)

    def _view_for(self, cmd: str, args: list, inbound: Inbound) -> views.Reply:
        if cmd in ("start", "menu"):
            return views.view_menu(self.cfg)
        if cmd == "help":
            return views.view_help()
        if cmd == "refresh":
            return views.view_menu(self.cfg)
        if cmd in ("mute", "unmute"):
            if not args:
                return views.Reply(f"Usage: /{cmd} &lt;kind|all&gt; — kinds: {', '.join(views.ALERT_KINDS)}", [[views.cb("Alerts", "c:alerts")]])
            return self._mute_reply(cmd == "mute", args[0].lower())
        if cmd in _LEGACY_READ:
            return self._legacy_read(cmd, inbound)
        if cmd == "alerts":
            state = self.store.load(self._now()) if self.store is not None else None
            return views.view_alerts(self.cfg, state, self._now())
        if cmd in views.READ_COMMANDS:
            if self.ops is None:
                return views.Reply("No data source available.", parse_mode=None)
            self.ops.reset()
            held = self._held()
            return {
                "health": lambda: views.view_health(self.ops),
                "queue": lambda: views.view_queue(self.ops),
                "errors": lambda: views.view_errors(self.ops),
                "balance": lambda: views.view_balance(self.ops),
                "spend": lambda: views.view_spend(self.ops),
                "today": lambda: views.view_today(self.ops),
                "users": lambda: views.view_users(self.ops),
                "deploys": lambda: views.view_deploys(self.ops),
                "approvals": lambda: views.view_approvals(self.ops, held),
                "security": lambda: views.view_security(self.ops),
                "digest": lambda: alerts_mod.send_digest_reply(self.ops, self._held),
            }[cmd]()
        return views.Reply(f"Unknown command /{safe_id(cmd, 24)}. Send /help.", parse_mode=None)

    def _held(self) -> Optional[list]:
        if self.deps is None:
            return None
        try:
            return self.deps.pending_review() or []
        except Exception:
            return None

    def _legacy_read(self, cmd: str, inbound: Inbound) -> views.Reply:
        # route_command authorizes again (sender in the admin chat) — the same
        # check, on the same ids, as the legacy path.
        result = route_command(f"/{cmd}", inbound.chat_id, self.control, self.deps, user_id=inbound.user_id)
        return views.Reply(result.reply, [[views.cb("Menu", "c:menu")]], parse_mode=None)

    def _mute_reply(self, do_mute: bool, kind: str) -> views.Reply:
        if self.store is None:
            return views.Reply("Alerts are not set up (no alert memory).", parse_mode=None)
        now = self._now()
        if do_mute:
            until = alerts_mod.mute(self.store, kind, now)
            if until is None:
                return views.Reply(f"Could not mute that. Kinds: all, {', '.join(views.ALERT_KINDS)}.", parse_mode=None)
            local = until.astimezone(self.cfg.tz).strftime("%H:%M")
            note = " Critical alerts still come through; mute a single kind to silence it." if kind == "all" else ""
            return views.Reply(f"Muted <b>{html_escape(kind)}</b> alerts until {local} {html_escape(str(self.cfg.tz))}.{note}",
                               [[views.cb("Unmute", f"a:unmute:{kind}"), views.cb("Alerts", "c:alerts")]])
        ok = alerts_mod.unmute(self.store, kind)
        return views.Reply(f"Unmuted <b>{html_escape(kind)}</b>." if ok else "Could not unmute that.",
                           [[views.cb("Alerts", "c:alerts")]])

    # -- sending ----------------------------------------------------------

    def _reply(self, chat_id, reply: views.Reply) -> None:
        if reply.parse_mode is None and not reply.keyboard:
            self.control.send(chat_id, reply.text)
        else:
            self.control.send(chat_id, reply.text, parse_mode=reply.parse_mode, reply_markup=reply.markup())
