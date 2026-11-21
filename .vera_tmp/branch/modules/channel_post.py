"""The brand channel's Telegram sender (docs/MARKETING_POSTS.md, migration 0108).

Pure parts only: the one message with three labelled language blocks, the media
variant, the refusal rules, and the mapping from Telegram's answer to what
``complete_marketing_post`` accepts. ``tools/marketing_worker.py`` wires it to the
queue. The transport and the response classification are the customer sender's
(modules/notify_telegram.py: ``TelegramClient``, ``classify_response``,
``_connect_failed``); only the question "may this be tried again" is asked
differently here, because a public post that is sent twice is worse than one that
is missed.

Rules this file keeps:

* **Exactly what was approved.** The three texts go out unchanged, in the fixed
  order uz, ru, en, then our site's link. The words are only HTML-escaped (the
  database holds plain text). Nothing is shortened to fit: a message over the
  limit is REFUSED with a code, because a cut can change what a sentence means.
* **Limits.** 4096 characters for a message, 1024 for a photo or video caption,
  counted after the HTML is parsed (so on the plain text) and in UTF-16 units,
  the stricter way to count.
* **A request that may have arrived is never repeated.** Only "the connection was
  never established" (``network``), a rate limit and a refused token are retried.
  A read timeout, a reset, a 5xx and a reply nobody can read are reported as dead:
  the post may be on the channel.
* **No secret in a result.** A result carries a code, never an exception text or
  a URL (the request URL holds the bot token).
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional

from modules import notify_telegram as nt
from modules import tg_text

#: One label per language, in the order the blocks appear (docs/news/README.md "How a post looks").
ORDER = ("uz", "ru", "en")
LABELS = {"uz": "Oʻzbekcha", "ru": "Русский", "en": "English"}

MESSAGE_LIMIT = 4096
CAPTION_LIMIT = 1024

_LINK = re.compile(r"^/[a-z0-9][a-z0-9/_-]{0,78}$")
_MEDIA = re.compile(r"^showcase/[A-Za-z0-9._/-]{1,200}$")
#: What the bot can fetch by URL and how it is sent. Anything else is refused, not guessed.
_PHOTO_EXT = (".jpg", ".jpeg", ".png")
_VIDEO_EXT = (".mp4",)


class Refused(Exception):
    """This post cannot be sent as it is. ``code`` is a short machine word; nothing was sent.

    The message is the code and nothing else, so it is safe to log."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def _blocks(texts: Mapping[str, Any], link_url: Optional[str], escape: bool) -> str:
    out = []
    for lang in ORDER:
        body = texts.get(lang)
        if not isinstance(body, str) or not body.strip():
            raise Refused("bad_texts")
        out.append(f"{LABELS[lang]}\n{html.escape(body, quote=False) if escape else body}")
    if link_url:
        out.append(html.escape(link_url, quote=False) if escape else link_url)
    return "\n\n".join(out)


def render(texts: Any, link: Optional[str], origin: Optional[str], has_media: bool) -> str:
    """The HTML text (a message) or caption (media) for one post. Raises :class:`Refused`.

    ``origin`` is our site's origin (``https://host``); ``link`` is the path the
    database stores. A post with a link and no usable origin is refused rather than
    sent with a half link."""
    if not isinstance(texts, Mapping) or set(texts) != set(ORDER):
        raise Refused("bad_texts")
    link_url = None
    if link:
        if not isinstance(link, str) or not _LINK.match(link) or "//" in link or ".." in link:
            raise Refused("bad_link")
        site = nt.valid_app_origin(origin)
        if site is None:
            raise Refused("no_origin")
        link_url = site + link
    plain = _blocks(texts, link_url, escape=False)
    if tg_text.sanitize_outgoing(plain) != plain:
        # The net under "the words are chosen by people": something that looks like a key, an address or
        # a token-in-a-URL would have been replaced by a placeholder. Never send altered words; refuse.
        raise Refused("unsafe_text")
    limit = CAPTION_LIMIT if has_media else MESSAGE_LIMIT
    if utf16_len(plain) > limit:
        raise Refused("too_long")
    return _blocks(texts, link_url, escape=True)


def preflight(texts: Any, link: Optional[str], origin: Optional[str], has_media: bool = False) -> Optional[str]:
    """The refusal code the sender WOULD give this post (``bad_texts``, ``bad_link``, ``no_origin``, ``unsafe_text``,
    ``too_long``), or None when it would go out. It runs the real :func:`render`, so a draft that fails here can never
    reach the owner's screen only to be refused after approval (and use up its idempotency key and a weekly slot)."""
    try:
        render(texts, link, origin, has_media)
    except Refused as refusal:
        return refusal.code
    return None


def media_kind(media_path: str) -> Optional[str]:
    """``photo`` or ``video`` by file extension, or None for a file this sender does not send."""
    low = media_path.lower()
    if low.endswith(_PHOTO_EXT):
        return "photo"
    if low.endswith(_VIDEO_EXT):
        return "video"
    return None


def media_url(media_base: Optional[str], media_path: str) -> str:
    """The public URL Telegram fetches the file from: ``<project url>/storage/v1/object/public/<path>``.

    The path is checked against the same rule as the database's (the public ``showcase`` bucket only)."""
    base = nt.valid_app_origin(media_base)
    if base is None:
        raise Refused("no_media_base")
    if not isinstance(media_path, str) or not _MEDIA.match(media_path) or ".." in media_path:
        raise Refused("bad_media")
    return f"{base}/storage/v1/object/public/{media_path}"


@dataclass(frozen=True)
class Outgoing:
    method: str
    payload: Dict[str, Any]


def build_outgoing(chat_id: str, post: Mapping[str, Any], origin: Optional[str], media_base: Optional[str]) -> Outgoing:
    """The Bot API call for one claimed post: sendMessage, sendPhoto or sendVideo. Raises :class:`Refused`."""
    media = post.get("media_path")
    text = render(post.get("texts"), post.get("link"), origin, bool(media))
    if not media:
        return Outgoing("sendMessage", {
            "chat_id": chat_id, "text": text, "parse_mode": "HTML",
            "link_preview_options": {"is_disabled": True},
        })
    kind = media_kind(str(media))
    if kind is None:
        raise Refused("bad_media")
    url = media_url(media_base, str(media))
    if kind == "photo":
        return Outgoing("sendPhoto", {"chat_id": chat_id, "photo": url, "caption": text, "parse_mode": "HTML"})
    return Outgoing("sendVideo", {"chat_id": chat_id, "video": url, "caption": text, "parse_mode": "HTML",
                                  "supports_streaming": True})


# ── Telegram's answer, for a post nobody may send twice ─────────────────────

def classify_channel_response(status: int, body: Dict[str, Any]) -> nt.SendResult:
    """:func:`nt.classify_response`, with every answer that leaves "was it posted?" open made final.

    * 200 and ``ok`` -> sent; 403 / 429 / 401 / 404 -> as the customer sender classifies them (Telegram said no).
    * 5xx -> ``dead/http_5xx`` (the customer sender would retry; a post must not be).
    * 200 without ``ok``, a redirect, anything unreadable -> ``dead/unconfirmed``.
    * any other 4xx -> ``dead/bad_request`` (Telegram rejected the request, the worker reports it failed).
    """
    base = nt.classify_response(status, body)
    if base.outcome == "sent":
        return base
    if status >= 500:
        return nt.SendResult("dead", "http_5xx")
    if base.error_code in ("blocked", "rate_limited", "not_configured"):
        return base
    if 400 <= status < 500:
        return nt.SendResult("dead", "bad_request")
    return nt.SendResult("dead", "unconfirmed")


@dataclass(frozen=True)
class Completion:
    """The arguments of ``complete_marketing_post`` (outcome: sent | failed | retry | dead)."""

    outcome: str
    error_code: Optional[str] = None
    retry_after: Optional[int] = None
    message_id: Optional[str] = None
    #: Why nothing was sent at all (a :class:`Refused` code); None once a request was made.
    refused: Optional[str] = None


def to_completion(result: nt.SendResult) -> Completion:
    """Map a channel :class:`nt.SendResult` to the four outcomes the database knows.

    Only a request that never left (``network``), a rate limit and a refused token are ``retry``.
    The database turns any other ``retry`` into dead/unconfirmed anyway; this keeps the intent explicit."""
    if result.outcome == "sent":
        return Completion("sent", message_id=result.message_id)
    code = result.error_code
    if code == "rate_limited":
        return Completion("retry", "rate_limited", retry_after=result.retry_after)
    if code in ("not_configured", "network"):
        return Completion("retry", code)
    if code == "blocked":
        return Completion("failed", "blocked")
    if code == "bad_request":
        return Completion("failed", "bad_request")
    if code == "http_5xx":
        return Completion("dead", "http_5xx")
    return Completion("dead", "unconfirmed")


class ChannelSender:
    """Sends one claimed post to the one configured channel. Never raises, never logs."""

    def __init__(self, client: nt.TelegramClient, chat_id: str, origin: Optional[str], media_base: Optional[str]):
        self._client = client
        self._chat = chat_id
        self._origin = origin
        self._media_base = media_base

    @property
    def origin(self) -> Optional[str]:
        """The site origin links are completed with (what the drafting pass checks a draft against)."""
        return self._origin

    def send(self, post: Mapping[str, Any]) -> Completion:
        try:
            out = build_outgoing(self._chat, post, self._origin, self._media_base)
        except Refused as refusal:
            # Nothing left the machine, and the post will not get better by waiting: failed, not retried.
            return Completion("failed", "bad_request", refused=refusal.code)
        try:
            return to_completion(self._client.call(out.method, out.payload, classify_channel_response))
        except Exception:  # noqa: BLE001 - the request may have gone out; say so, and never echo the error (its URL holds the token)
            return Completion("dead", "unconfirmed")
