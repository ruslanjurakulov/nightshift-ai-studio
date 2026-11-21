"""Telegram delivery of the in-app notifications (migration 0102).

Pure parts only: the words, the link back into the app, the Telegram client with
its error classification, and the rate limiter. ``tools/notify_worker.py`` wires
them to the outbox.

Three rules shape this file.

* A message carries a short sentence and one link back to the app. Never a
  title, a prompt, a file name, an amount the notification did not carry, or
  provider text: the words are chosen from the notification KIND, and the link
  from ids that are checked to be uuids. What a person typed never travels
  through here.
* The language is an ARGUMENT. The words are the ``push.*`` keys of the shared
  data files (modules/notify_i18n.py, one file per language, the same files the
  bot's webhook reads), looked up by a code that is checked against the registry
  and English when it is not listed, so adding a language is adding a data file,
  never a branch. The code comes from the chat's stored language (chosen in
  Settings or with /language in the bot; set when the chat was linked from the
  language the person was using).
* No real Telegram call is made unless ``NOTIFY_TELEGRAM_API_BASE`` is unset in
  a deployed worker. Tests and local runs point it at ``tools/fake_telegram.py``;
  the client takes the base URL as an argument and the default lives only in
  :func:`api_base_from_env`.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional
from urllib.parse import urlsplit

from modules import notify_i18n

REAL_API_BASE = "https://api.telegram.org"

KINDS = ("creative_job_completed", "creative_job_failed", "storyboard_ready", "editor_export_done", "credits_low",
         "video_ready")

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_PLAIN_ID = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


def words(lang: Optional[str], key: str) -> str:
    """The sentence for ``key`` in ``lang``, in English when that language has
    no words for it (or is not a language the registry lists)."""
    return notify_i18n.text(lang, "push." + key)


def _uuid_field(data: Dict[str, Any], key: str) -> Optional[str]:
    v = data.get(key)
    return v if isinstance(v, str) and _UUID.match(v) else None


def _number(data: Dict[str, Any], key: str) -> Optional[float]:
    v = data.get(key)
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return None


def _creative_section(data: Dict[str, Any], failed: bool) -> str:
    # Mirrors lib/notifications.ts creativeSection: where the result is found.
    capability = data.get("capability") if isinstance(data.get("capability"), str) else ""
    if capability == "captions":
        return "/editor"
    if capability == "describe":
        return "/create"
    return "/studio" if failed else "/library"


def link_path(kind: str, data: Dict[str, Any]) -> Optional[str]:
    """The app section a notification leads to (the same places as the bell,
    lib/notifications.ts describeNotification), or None for a test message."""
    if kind == "creative_job_completed":
        return _creative_section(data, False)
    if kind == "creative_job_failed":
        return _creative_section(data, True)
    if kind == "storyboard_ready":
        sid = _uuid_field(data, "storyboard_id")
        return f"/videos/storyboard/{sid}" if sid else "/videos"
    if kind == "editor_export_done":
        pid = _uuid_field(data, "project_id")
        return f"/editor/{pid}" if pid else "/library"
    if kind == "credits_low":
        return "/credits"
    if kind == "video_ready":
        vid = data.get("video_id")
        return f"/videos/{vid}" if isinstance(vid, str) and _PLAIN_ID.match(vid) and ".." not in vid else "/videos"
    return None


def valid_app_origin(raw: Optional[str]) -> Optional[str]:
    """``https://host`` (or http for localhost) without a path, else None: the
    origin goes into a link a person will tap, so a typo must not become a
    target."""
    if not raw:
        return None
    try:
        u = urlsplit(raw.strip())
    except ValueError:
        return None
    if not u.hostname or u.username or u.password or u.path not in ("", "/") or u.query or u.fragment:
        return None
    local = u.hostname in ("localhost", "127.0.0.1")
    if u.scheme != "https" and not (u.scheme == "http" and local):
        return None
    return f"{u.scheme}://{u.netloc}"


def sentence(kind: str, data: Dict[str, Any], lang: Optional[str]) -> Optional[str]:
    if kind == "creative_job_failed":
        # "returned" only when the notification says so: 0064 carries
        # credits_returned only for a job that held credits. Absent is not zero.
        returned = _number(data, "credits_returned") is not None
        return words(lang, "creative_job_failed_refunded" if returned else "creative_job_failed")
    if kind in KINDS or kind == "test":
        return words(lang, kind)
    return None


def build_message(app_origin: str, chat_id: str, kind: str, data: Dict[str, Any], lang: Optional[str]) -> Optional[Dict[str, Any]]:
    """The sendMessage payload: one sentence and, when the notification leads
    somewhere, one button that opens the app. None for a kind this build has no
    words for (the worker then drops it as a bad request, never guesses)."""
    text = sentence(kind, data if isinstance(data, dict) else {}, lang)
    if text is None:
        return None
    payload: Dict[str, Any] = {
        "chat_id": chat_id,
        "text": text,
        "link_preview_options": {"is_disabled": True},
    }
    path = link_path(kind, data if isinstance(data, dict) else {})
    if path is not None:
        payload["reply_markup"] = {"inline_keyboard": [[{"text": words(lang, "open"), "url": app_origin + path}]]}
    return payload


# ── the client ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class SendResult:
    """What the outbox is told. outcome: sent | retry | blocked | dead."""

    outcome: str
    error_code: Optional[str] = None
    retry_after: Optional[int] = None
    message_id: Optional[str] = None


_BLOCKED_TEXT = ("bot was blocked", "user is deactivated", "chat not found", "bot was kicked", "have no rights",
                 "chat_write_forbidden", "peer_id_invalid")


def _connect_failed(exc: BaseException) -> bool:
    """True when the request never reached Telegram (refused, unresolvable,
    connect timeout): safe to send again. Anything else (a read timeout, a
    connection reset after the request went out) may have been delivered, and
    Telegram has no idempotency key: that is not retried."""
    seen = 0
    stack = [exc]
    while stack and seen < 12:
        e = stack.pop()
        seen += 1
        name = type(e).__name__
        if name in ("NewConnectionError", "ConnectTimeout", "ConnectTimeoutError", "NameResolutionError"):
            return True
        for nxt in (getattr(e, "__cause__", None), getattr(e, "__context__", None), getattr(e, "reason", None),
                    *[a for a in getattr(e, "args", ()) if isinstance(a, BaseException)]):
            if isinstance(nxt, BaseException):
                stack.append(nxt)
    return False


class TelegramClient:
    """sendMessage (and, for the brand channel, other methods) over the Bot API. ``session`` is anything with a
    ``post(url, json=..., timeout=...)`` returning an object with
    ``status_code`` and ``json()``: ``requests`` in the worker, a fake in tests.
    The token only ever appears inside the URL handed to the session."""

    def __init__(self, token: str, base_url: str, session: Any, timeout: float = 10.0):
        if not token:
            raise ValueError("a bot token is required")
        self._token = token
        self._base = base_url.rstrip("/")
        self._session = session
        self._timeout = timeout

    def send_message(self, payload: Dict[str, Any]) -> SendResult:
        return self.call("sendMessage", payload)

    def call(self, method: str, payload: Dict[str, Any],
             classify: Optional[Callable[[int, Dict[str, Any]], SendResult]] = None) -> SendResult:
        """POST ``payload`` to a Bot API ``method`` and classify the answer.

        ``classify`` defaults to :func:`classify_response`. The brand channel
        (modules/channel_post.py) passes its own, which keeps every answer but
        treats "Telegram may have posted it" as final instead of retryable."""
        url = f"{self._base}/bot{self._token}/{method}"
        try:
            resp = self._session.post(url, json=payload, timeout=self._timeout)
        except Exception as exc:  # noqa: BLE001 - classified below, never logged whole (the URL holds the token)
            if _connect_failed(exc):
                return SendResult("retry", "network")
            return SendResult("dead", "unconfirmed")
        return (classify or classify_response)(resp.status_code, _safe_json(resp))


def _safe_json(resp: Any) -> Dict[str, Any]:
    try:
        body = resp.json()
    except Exception:  # noqa: BLE001
        return {}
    return body if isinstance(body, dict) else {}


def classify_response(status: int, body: Dict[str, Any]) -> SendResult:
    if status == 200 and body.get("ok") is True:
        result = body.get("result")
        mid = result.get("message_id") if isinstance(result, dict) else None
        return SendResult("sent", message_id=str(mid) if isinstance(mid, int) else None)
    description = str(body.get("description") or "").lower()
    if status == 403 or (status == 400 and any(t in description for t in _BLOCKED_TEXT)):
        return SendResult("blocked", "blocked")
    if status == 429:
        params = body.get("parameters")
        ra = params.get("retry_after") if isinstance(params, dict) else None
        return SendResult("retry", "rate_limited", retry_after=ra if isinstance(ra, int) and 0 <= ra <= 3600 else 30)
    if status in (401, 404):
        # Token wrong or revoked: nothing here is the message's fault. The worker pauses and raises an alarm.
        return SendResult("retry", "not_configured")
    if status >= 500:
        return SendResult("retry", "http_5xx")
    return SendResult("dead", "bad_request")


def api_base_from_env(env: Dict[str, str]) -> str:
    return (env.get("NOTIFY_TELEGRAM_API_BASE") or "").strip() or REAL_API_BASE


# ── the limiter ─────────────────────────────────────────────────────────────

class SendLimiter:
    """Telegram's guidance: about 1 message a second to one chat, about 30 a
    second overall. This waits (never drops) so the worker stays under both:
    25 a second overall, 1 a second per chat."""

    def __init__(self, clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep,
                 per_chat: float = 1.0, overall_per_second: int = 25):
        self._clock, self._sleep = clock, sleep
        self._per_chat = per_chat
        self._gap = 1.0 / overall_per_second
        self._last_chat: Dict[str, float] = {}
        self._last_any = -1e9

    def wait(self, chat_id: str) -> float:
        now = self._clock()
        ready = max(self._last_any + self._gap, self._last_chat.get(chat_id, -1e9) + self._per_chat)
        delay = max(0.0, ready - now)
        if delay > 0:
            self._sleep(delay)
        stamp = max(now, ready)
        self._last_any = stamp
        self._last_chat[chat_id] = stamp
        if len(self._last_chat) > 5000:
            cutoff = stamp - 60
            self._last_chat = {k: v for k, v in self._last_chat.items() if v > cutoff}
        return delay
