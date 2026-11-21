"""Text helpers any Telegram bot in this repo can share: escaping, splitting,
and a last scrub over outgoing text.

Neutral on purpose. The operator bot (modules/operator_bot/) uses it today; the
customer bot (modules/notify_telegram.py, a separate branch) is free to adopt it
instead of carrying its own copy. Nothing here knows a token, a chat or a
command, and nothing here does I/O.

Why a scrub exists at all: an operator message is assembled from rows that
other people wrote (a channel name, a failure code, a job's error). The
messages are built from ids, counts and fixed words, never from free text, but
"built from" is a promise about today's code. :func:`sanitize_outgoing` is the
net underneath it: whatever reaches Telegram has had URL-borne credentials
(modules/log_redaction), e-mail addresses, bearer tokens and long key-shaped
strings taken out, so a future change that interpolates the wrong field leaks a
placeholder instead of a secret.
"""

from __future__ import annotations

import html
import re

from modules import log_redaction

#: Telegram's hard limit for one message's text, in characters.
MESSAGE_LIMIT = 4096
#: What this module splits to. Under the hard limit on purpose: with HTML
#: parse mode the limit counts the text AFTER entity parsing, but a bot that
#: sits right at the edge is one multi-byte surprise from a 400.
SPLIT_AT = 3800

_MD2_SPECIAL = r"_*[]()~`>#+-=|{}.!\\"
_MD2_RE = re.compile("([" + re.escape(_MD2_SPECIAL) + "])")

_EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+")
_BEARER = re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=\-]{12,}")
# JWT-shaped (header.payload.signature), Stripe/OpenAI/Slack/GitHub style
# prefixes, and any unbroken run of 48+ key-alphabet characters that MIXES upper
# case, lower case and digits (as a generated key does; a long lower-case worker
# id, a hex hash or a uuid does not).
_JWT = re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}")
_PREFIXED = re.compile(r"\b(?:sk|pk|rk|xox[abprs]|gh[pousr]|AIza)[-_A-Za-z0-9]{16,}")
_LONG_TOKEN = re.compile(r"\b[A-Za-z0-9_\-]{48,}\b")
# Square brackets, not angle brackets: the text may go out with parse_mode=HTML,
# where an unknown tag such as <hidden> is a 400 "can't parse entities".
_PLACEHOLDER = "[hidden]"


def html_escape(value) -> str:
    """Escape a dynamic value for ``parse_mode=HTML`` (``& < >`` and quotes)."""
    return html.escape("" if value is None else str(value), quote=True)


def md2_escape(value) -> str:
    """Escape a dynamic value for ``parse_mode=MarkdownV2``."""
    return _MD2_RE.sub(r"\\\1", "" if value is None else str(value))


def clip(value, limit: int) -> str:
    """One line, whitespace collapsed, at most ``limit`` characters (an ellipsis
    counts). Free text should pass through here BEFORE it is escaped, so a cut
    can never land inside an entity such as ``&amp;``."""
    text = re.sub(r"\s+", " ", "" if value is None else str(value)).strip()
    if limit <= 0:
        return ""
    return text if len(text) <= limit else text[: max(0, limit - 1)].rstrip() + "…"


_SAFE_ID = re.compile(r"[^A-Za-z0-9_.:\-]")


def safe_id(value, limit: int = 64) -> str:
    """An identifier made safe to print: only ``[A-Za-z0-9_.:-]`` survives."""
    return _SAFE_ID.sub("", "" if value is None else str(value))[:limit]


def short_id(value, keep: int = 8) -> str:
    """The tail of an identifier, safe to print (``…ab12cd34``); never the whole
    of a long one. For ids that belong to another system (a payment provider's
    event id): enough to tell two apart, not enough to look the record up.
    Empty when there is no id."""
    text = safe_id(value, 200)
    return text if len(text) <= keep else "…" + text[-keep:]


def sanitize_outgoing(text: str) -> str:
    """The last scrub over text about to leave for Telegram."""
    text = log_redaction.redact("" if text is None else str(text))
    text = _EMAIL.sub("[email]", text)
    text = _BEARER.sub(lambda m: f"{m.group(1)} {_PLACEHOLDER}", text)
    text = _JWT.sub(_PLACEHOLDER, text)
    text = _PREFIXED.sub(_PLACEHOLDER, text)
    text = _LONG_TOKEN.sub(
        lambda m: _PLACEHOLDER if (re.search("[A-Z]", m.group(0)) and re.search("[a-z]", m.group(0))
                                   and re.search("[0-9]", m.group(0))) else m.group(0), text)
    return text


def _trim_entity(chunk: str) -> str:
    """Drop a trailing half-entity (``&am``) a hard cut may have produced."""
    amp = chunk.rfind("&")
    if amp != -1 and ";" not in chunk[amp:]:
        return chunk[:amp]
    return chunk


def split_message(text: str, limit: int = SPLIT_AT) -> list[str]:
    """Split ``text`` into chunks of at most ``limit`` characters, on line
    boundaries. A line longer than the limit is cut hard (never mid-entity).
    Never returns an empty list for non-empty text, never an empty chunk."""
    limit = max(1, min(int(limit), MESSAGE_LIMIT))
    text = "" if text is None else str(text)
    if not text.strip():
        return []
    chunks: list[str] = []
    current = ""
    for line in text.split("\n"):
        while len(line) > limit:
            head = _trim_entity(line[:limit]) or line[:limit]
            if current:
                chunks.append(current)
                current = ""
            chunks.append(head)
            line = line[len(head):]
        candidate = line if not current else current + "\n" + line
        if len(candidate) <= limit:
            current = candidate
        else:
            chunks.append(current)
            current = line
    if current.strip():
        chunks.append(current)
    return [c for c in chunks if c.strip()]
