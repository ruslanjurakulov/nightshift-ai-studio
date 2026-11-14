"""Which ElevenLabs model speaks which language: one table, read before anything spends.

Why this exists
---------------
The default narration model is ``eleven_multilingual_v2``. ElevenLabs' own model
page does not list Uzbek for it, so an Uzbek channel would get Uzbek text read
by a model that does not claim to speak Uzbek. Nothing fails. The video just
sounds wrong, and with auto publish on the audience hears it first. That is a
silent quality downgrade (CLAUDE.md rule 4), so the run stops instead.

What was verified, and only that
--------------------------------
Source: https://elevenlabs.io/docs/overview/models, read 2026-11-14. Only
``uz``, ``ru`` and ``en`` were checked against that page for each model below.
A language outside these three is *not known* here. :func:`speaks` answers None
for it, never True. The Command Center keeps the same table in
``command-center/lib/ttsLanguages.ts``, and ``tests/test_tts_languages.py`` keeps
the two equal.

* Uzbek (uz) is listed for eleven_v4, eleven_v4_turbo, eleven_v3,
  eleven_v3_conversational and eleven_ttv_v3.
* Uzbek is NOT listed for eleven_multilingual_v2, eleven_flash_v2_5,
  eleven_turbo_v2_5 (deprecated: equivalent to Flash v2.5),
  eleven_multilingual_sts_v2 or eleven_multilingual_ttv_v2.
* Russian and English are listed for all of them.

Stdlib only, no side effects: main.py's preflight and the creative adapters
import it before anything heavy.
"""

from __future__ import annotations

import re
from typing import Optional

SOURCE_URL = "https://elevenlabs.io/docs/overview/models"
SOURCE_READ_ON = "2026-11-14"

#: The languages these lists were checked for. A code outside this set is unknown.
VERIFIED_LANGUAGES = ("uz", "ru", "en")

#: vendor model id -> the VERIFIED_LANGUAGES the docs page lists for it.
MODEL_LANGUAGES: dict[str, tuple[str, ...]] = {
    "eleven_v4": ("uz", "ru", "en"),
    "eleven_v4_turbo": ("uz", "ru", "en"),
    "eleven_v3": ("uz", "ru", "en"),
    "eleven_v3_conversational": ("uz", "ru", "en"),
    "eleven_ttv_v3": ("uz", "ru", "en"),
    "eleven_multilingual_v2": ("ru", "en"),
    "eleven_flash_v2_5": ("ru", "en"),
    "eleven_turbo_v2_5": ("ru", "en"),
    "eleven_multilingual_sts_v2": ("ru", "en"),
    "eleven_multilingual_ttv_v2": ("ru", "en"),
}

#: Models the docs mark as deprecated. Turbo v2.5 is equivalent to Flash v2.5.
DEPRECATED_MODELS = ("eleven_turbo_v2_5",)

#: What a person calls the language in a channel's settings or on the Create page.
#: The pipeline stores names ("Uzbek"), the films table codes ("uz").
_LANGUAGE_NAMES = {
    "english": "en", "russian": "ru", "uzbek": "uz",
    "o'zbek": "uz", "oʻzbek": "uz", "o‘zbek": "uz", "ozbek": "uz", "o'zbekcha": "uz", "oʻzbekcha": "uz",
    "русский": "ru", "узбекский": "uz",
}

#: The remedy rule 6 asks for, worded once so the run, the creative worker and
#: the tests cannot drift apart.
UZBEK_REMEDY = ("Eleven Multilingual v2 does not speak Uzbek; set the channel's TTS model to Eleven v4 or v3")

_MODEL_NAMES = {
    "eleven_multilingual_v2": "Eleven Multilingual v2",
    "eleven_flash_v2_5": "Eleven Flash v2.5",
    "eleven_turbo_v2_5": "Eleven Turbo v2.5",
    "eleven_multilingual_sts_v2": "Eleven Multilingual STS v2",
    "eleven_multilingual_ttv_v2": "Eleven Multilingual TTV v2",
}


def language_code(language) -> Optional[str]:
    """``uz`` from "Uzbek", "uz", "uz-Latn", "Oʻzbek"; None when it is not a language this module can name."""
    if not isinstance(language, str):
        return None
    value = " ".join(language.split()).lower()
    if not value:
        return None
    if re.fullmatch(r"[a-z]{2,3}(-[a-z0-9]{2,8})*", value):
        primary = value.split("-")[0]
        return {"uzb": "uz", "uzn": "uz", "rus": "ru", "eng": "en"}.get(primary, primary)
    # "Uzbek (Latin script)" and the like: the first word names the language.
    return _LANGUAGE_NAMES.get(value) or _LANGUAGE_NAMES.get(value.split(" (")[0].split(" ")[0])


def speaks(model: str, language) -> Optional[bool]:
    """True/False when both the model and the language were verified, else None (unknown, never a guess)."""
    code = language_code(language)
    langs = MODEL_LANGUAGES.get(model or "")
    if code is None or code not in VERIFIED_LANGUAGES or langs is None:
        return None
    return code in langs


def refusal(model: str, language) -> Optional[str]:
    """The reason this model must not read this language, or None.

    Only a verified "no" refuses. Today that means Uzbek on a model the docs do
    not list it for. An unknown model or an unverified language is not refused
    here; the guess would be worse than the gap, and the gap is named in the
    module docstring."""
    if speaks(model, language) is not False:
        return None
    code = language_code(language)
    name = _MODEL_NAMES.get(model, model)
    if code == "uz":
        lead = UZBEK_REMEDY if model == "eleven_multilingual_v2" else (
            f"{name} does not speak Uzbek; set the channel's TTS model to Eleven v4 or v3")
        return (f"{lead} (the ELEVENLABS_MODEL_ID repository variable, or the voice model chosen for "
                f"this run). Checked against {SOURCE_URL} on {SOURCE_READ_ON}. No other model is "
                "substituted.")
    return (f"{name} does not list language {code!r} ({SOURCE_URL}, read {SOURCE_READ_ON}). "
            "No other model is substituted.")
