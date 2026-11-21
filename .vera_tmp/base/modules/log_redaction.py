"""Keep credentials that live inside URLs out of log lines.

Two services put the credential in the URL itself: a Telegram bot token is a
path segment (``/bot<token>/sendMessage``) and a Slack incoming webhook URL is
the secret. ``requests`` exceptions quote the full URL — ``raise_for_status()``
says "... for url: https://api.telegram.org/bot<token>/getUpdates", a
connection error names the host *and* path — so logging ``str(e)`` wrote the
token into ``logs/*.log``, which the workflows upload as artifacts. Actions
masks registered secrets in the console, not inside artifact files.

Two layers:

* :func:`describe_http_error` is what call sites log: the exception type and,
  when there is one, the HTTP status. Never the message, never the URL.
* :func:`install` adds :class:`RedactingFilter` to the root logger's handlers
  so a log line that still carries one of these URLs (a library's own
  message, a traceback) is scrubbed before it reaches the console or a file.
  It is a net under the first layer, not a licence to log exceptions whole.
"""

from __future__ import annotations

import logging
import re
from typing import Optional

REDACTED = "<redacted>"

_PATTERNS = (
    # Telegram Bot API: /bot<id>:<secret>/method, and file downloads /file/bot<...>/.
    (re.compile(r"bot\d+:[A-Za-z0-9_-]+"), "bot" + REDACTED),
    # Slack incoming webhooks, workflow and trigger URLs: the path is the secret.
    (re.compile(r"(hooks\.slack(?:-gov)?\.com/)(?:services|workflows|triggers)/[^\s'\"<>)]+"),
     r"\1" + REDACTED),
    # A credential passed as a query parameter (Google APIs' ?key=, and the like).
    (re.compile(r"([?&](?:key|api_key|apikey|access_token|token)=)[^&\s'\"<>)]+", re.I),
     r"\1" + REDACTED),
)


def redact(text: str) -> str:
    """``text`` with every URL-borne credential this module knows replaced."""
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def describe_http_error(exc: BaseException) -> str:
    """``"ConnectionError"`` or ``"HTTPError (HTTP 404)"`` — what a caller logs
    instead of ``str(exc)``, which for ``requests`` includes the full URL."""
    name = type(exc).__name__
    status: Optional[int] = getattr(getattr(exc, "response", None), "status_code", None)
    if isinstance(status, int):
        return f"{name} (HTTP {status})"
    return name


class RedactingFilter(logging.Filter):
    """Scrubs a record's message and traceback text with :func:`redact`."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # a broken format string is the formatter's problem
            return True
        clean = redact(message)
        if clean != message:
            record.msg, record.args = clean, None
        if record.exc_info and not record.exc_text:
            record.exc_text = logging.Formatter().formatException(record.exc_info)
        if record.exc_text:
            record.exc_text = redact(record.exc_text)
        if record.stack_info:
            record.stack_info = redact(record.stack_info)
        return True


def install(logger: Optional[logging.Logger] = None) -> None:
    """Add the filter to every handler of ``logger`` (default: root). Call it
    right after ``logging.basicConfig``. Idempotent."""
    target = logger or logging.getLogger()
    for handler in target.handlers:
        if not any(isinstance(f, RedactingFilter) for f in handler.filters):
            handler.addFilter(RedactingFilter())
