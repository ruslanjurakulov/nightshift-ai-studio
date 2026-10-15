"""One copy table per language, one lookup, no per-language branches.

Every word the operator bot says to the owner comes from here:
``t(lang, "queue.title")``. The language list is the single constant
``LANGUAGES``; a language's words live in ``copy_data/<code>.py`` as a flat
``TABLE`` of key -> template. Adding a language (the product will get many) is a
data file and one entry in ``LANGUAGES``; the tests then insist that it has
exactly English's keys and exactly English's ``{placeholders}``.

Rules the lookup enforces, so no view has to remember them:

* **Fallback.** An unknown or missing language code means English. A key missing
  from a language falls back to English's text for that key. A key missing
  everywhere returns the key itself. It never raises.
* **Escaping.** Templates are trusted HTML (``<b>``, ``<code>``). Every value
  substituted into one is HTML-escaped, unless the caller wraps it in
  :class:`Raw` to say "this is already safe markup". So a channel id, an error
  code or a worker name cannot inject markup in any language.
* **Placeholders.** ``{name}`` only; no format specs, so a translation cannot
  reach into an object.

Dates and numbers stay in neutral formats (ISO dates, ``1,234`` numbers,
``3m`` / ``2h 5m`` ages) in every language.

Outgoing text then goes through ``TelegramControl.send`` like everything else:
``tg_text.sanitize_outgoing`` (log_redaction, e-mails, key shapes) and message
splitting. A translation is not exempt from any of it.
"""

from __future__ import annotations

import importlib
import string
from typing import Optional

from modules.tg_text import html_escape

#: The languages the bot speaks, in the order their buttons are shown. THE one
#: place to add a language (plus its copy_data/<code>.py).
LANGUAGES = ("en", "ru", "uz")
DEFAULT_LANGUAGE = "en"


class Raw(str):
    """Text that is already safe markup: substituted as is, not escaped."""


_TABLES: dict = {}


def table(lang: str) -> dict:
    """The key -> template table of ``lang`` (English for an unknown code)."""
    lang = normalize_language(lang)
    if lang not in _TABLES:
        _TABLES[lang] = importlib.import_module(f"modules.operator_bot.copy_data.{lang}").TABLE
    return _TABLES[lang]


def normalize_language(code: Optional[str]) -> str:
    """``"RU"`` / ``"ru-RU"`` -> ``"ru"``; anything not in LANGUAGES -> English."""
    primary = str(code or "").strip().lower().replace("_", "-").split("-")[0]
    return primary if primary in LANGUAGES else DEFAULT_LANGUAGE


def has(lang: str, key: str) -> bool:
    return key in table(lang) or key in table(DEFAULT_LANGUAGE)


def placeholders(template: str) -> set:
    return {name for _lit, name, _spec, _conv in string.Formatter().parse(template) if name}


class _Values(dict):
    """Escapes on the way out; a placeholder the caller did not supply shows as ``?``."""

    def __missing__(self, key):
        return "?"


def _escaped(values: dict) -> _Values:
    return _Values({k: (v if isinstance(v, Raw) else html_escape(v)) for k, v in values.items()})


def t(lang: str, key: str, /, **values) -> str:
    """The text for ``key`` in ``lang``, with ``values`` substituted (escaped)."""
    template = table(lang).get(key)
    if template is None:
        template = table(DEFAULT_LANGUAGE).get(key)
    if template is None:
        return key
    try:
        return template.format_map(_escaped(values))
    except (ValueError, IndexError, KeyError, AttributeError):
        # A malformed template in one language must not break a message.
        fallback = table(DEFAULT_LANGUAGE).get(key, key)
        try:
            return fallback.format_map(_escaped(values))
        except (ValueError, IndexError, KeyError, AttributeError):
            return key


def tp(lang: str, key: str, /, **values) -> str:
    """Like :func:`t` but for PLAIN-text messages (no parse mode): values are
    substituted as they are, with no HTML escaping. Used only for the original
    commands, which send plain text."""
    template = table(lang).get(key)
    if template is None:
        template = table(DEFAULT_LANGUAGE).get(key)
    if template is None:
        return key
    try:
        return template.format_map(_Values(values))
    except (ValueError, IndexError, KeyError, AttributeError):
        return key
