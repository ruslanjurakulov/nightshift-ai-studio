"""The words of the customer notifications, in one place for every consumer.

Who reads what is written here (migration 0105):

* the Telegram bot's replies and buttons (Edge Function ``telegram-notify-webhook``),
* the Telegram messages the notify worker sends (``modules/notify_telegram.py``),
* the e-mails (``modules/email_notify.py``),

all from ONE set of data files, ``supabase/functions/_shared/notify-i18n/``:

    registry.json    the list of language codes (the only list), the default, and
                     each language's own name (shown on the bot's buttons)
    <code>.json      one flat ``{"key": "text"}`` file per language

The Edge Function (Deno) imports the very same files
(``supabase/functions/_shared/notify-i18n.ts``), so there is nothing to keep in
step between the bot and the worker. The key families are ``meta.*`` (``dir``,
``decimal``), ``bot.*``, ``push.*`` and ``mail.*``.

Adding a language is a data file plus a line in the registry (and, for the
Edge Function, one import line; the Settings pickers and the database check list
the codes too: tests/test_notify_i18n.py fails until every place agrees). No code
anywhere branches on a particular language: the language is always an ARGUMENT,
checked against the registry (:func:`resolve`) before it is used for anything, and
a code the registry does not list is English. A language code is never put into a
path, a URL or HTML without that check (the path of a language's file is built
only from codes read out of the registry itself).

Placeholders are ``{name}`` and are filled by :func:`fill` in a single pass, so
a value (a channel's name, say) can never be read as a placeholder or as format
syntax, and escaping is the caller's job in exactly the same way for every
language.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Dict, List, Tuple

DATA_DIR = Path(__file__).resolve().parent.parent / "supabase" / "functions" / "_shared" / "notify-i18n"

_CODE = re.compile(r"^[a-z]{2,3}$")
_PLACEHOLDER = re.compile(r"\{(\w+)\}")


def _read_json(path: Path) -> object:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _load(data_dir: Path) -> Tuple[str, Tuple[str, ...], Dict[str, str], Dict[str, Dict[str, str]]]:
    """(default, codes in display order, native names, bundles). Raises on a
    registry or a data file that is not well formed: a broken language file must
    fail loudly at import, never fall back silently."""
    registry = _read_json(data_dir / "registry.json")
    if not isinstance(registry, dict) or not isinstance(registry.get("languages"), list):
        raise ValueError("notify-i18n/registry.json: expected {default, languages: [...]}")
    codes: List[str] = []
    names: Dict[str, str] = {}
    for entry in registry["languages"]:
        code = entry.get("code") if isinstance(entry, dict) else None
        native = entry.get("native") if isinstance(entry, dict) else None
        if not isinstance(code, str) or not _CODE.match(code) or code in names:
            raise ValueError(f"notify-i18n/registry.json: bad or repeated language code {code!r}")
        if not isinstance(native, str) or not native.strip() or len(native) > 40:
            raise ValueError(f"notify-i18n/registry.json: {code} needs a native name")
        codes.append(code)
        names[code] = native
    default = registry.get("default")
    if default not in names:
        raise ValueError("notify-i18n/registry.json: the default must be one of the languages")
    bundles: Dict[str, Dict[str, str]] = {}
    for code in codes:  # codes come from the registry, matched against ^[a-z]{2,3}$ above
        data = _read_json(data_dir / f"{code}.json")
        if not isinstance(data, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in data.items()):
            raise ValueError(f"notify-i18n/{code}.json: expected a flat object of strings")
        bundles[code] = data
    return str(default), tuple(codes), names, bundles


DEFAULT_LANGUAGE, LANGUAGES, NATIVE_NAMES, BUNDLES = _load(DATA_DIR)


def is_supported(code: object) -> bool:
    """True only for a code the registry lists, exactly as written."""
    return isinstance(code, str) and code in BUNDLES


def resolve(code: object) -> str:
    """The language to use for ``code``: the registry's own spelling of it, else
    the default. Case and surrounding space are forgiven; nothing else is."""
    if isinstance(code, str):
        candidate = code.strip().lower()
        if candidate in BUNDLES:
            return candidate
    return DEFAULT_LANGUAGE


def text(lang: object, key: str) -> str:
    """The text for ``key`` in ``lang``; per key, English when that language has
    none. A key English does not have is a bug in the caller (KeyError)."""
    return BUNDLES.get(resolve(lang), {}).get(key) or BUNDLES[DEFAULT_LANGUAGE][key]


def section(lang: object, *prefixes: str) -> Dict[str, str]:
    """Every key of the given families (``"mail"``, ``"meta"``, …) with the
    family stripped, in ``lang`` with English filling any gap."""
    out: Dict[str, str] = {}
    for source in (BUNDLES[DEFAULT_LANGUAGE], BUNDLES.get(resolve(lang), {})):
        for key, value in source.items():
            for prefix in prefixes:
                if key.startswith(prefix + "."):
                    out[key[len(prefix) + 1:]] = value
    return out


def fill(template: str, **values: object) -> str:
    """Replace ``{name}`` with ``values[name]`` in one pass. An unknown name is
    left as written; a value is never searched for further placeholders."""
    return _PLACEHOLDER.sub(lambda m: str(values[m.group(1)]) if m.group(1) in values else m.group(0), template)


def placeholders(template: str) -> frozenset:
    return frozenset(_PLACEHOLDER.findall(template))
