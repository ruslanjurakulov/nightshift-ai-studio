"""ElevenLabs voices that stop working on a known date, and the refusal a run gives for one.

ElevenLabs: "Default voices will expire on December 31, 2026, and they will no
longer be accessible after this date" (DEFAULT_VOICES_URL, re-read 2026-11-22).
Without this table a channel narrated by one would die on 1 January at the
voice check with a bare vendor 404, which names the symptom; this names the
voice, the date and the remedy (rule 6).

ElevenLabs suggests a replacement for each voice. It is copied here as a name
for the person to listen to, never used: a different voice is a different
channel to the audience, so nothing is substituted (rule 4). The person picks
from the account's own list.

Stdlib only and no side effects: the preflight (modules/audio_mixer), the TTS
adapter (modules/capabilities/audio) and tools/audit_voices.py all read it, and
command-center/lib/voiceRetirement.ts is a copy kept equal by
tests/test_voice_retirement.py.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Optional

DEFAULT_VOICES_URL = "https://elevenlabs.io/docs/help-center/product/voices/my-voices/what-are-default-voices"
READ_ON = "2026-11-14"
#: The last day a Default voice is accessible ("no longer accessible after this date").
DEFAULT_EXPIRES = "2026-12-31"
_LAST_DAY = date.fromisoformat(DEFAULT_EXPIRES)

#: Default voice id -> (old name, ElevenLabs' suggested replacement name, its id). From DEFAULT_VOICES_URL, READ_ON.
DEFAULT_VOICES: dict[str, tuple[str, str, str]] = {
    "CwhRBWXzGAHq8TQ4Fs17": ("Roger", "Darian - Warm Grounded Storyteller", "gOupLcAkjEnguROwi4oS"),
    "EXAVITQu4vr4xnSDxMaL": ("Sarah", "Talia - Warm Soft Guide", "OZ0L6eISlOejga3XjDFt"),
    "FGY2WhTYpPnrIDTdsKH5": ("Laura", "Elara - Crisp Pro Narrator", "WQP7cQUF5aAS6Axh5yaa"),
    "IKne3meq5aSn9XLyUdCD": ("Charlie", "Baxter - Dry Calm Aussie", "jSuBIjxMKhqIfb0wCK1F"),
    "JBFqnCBsd6RMkjVDRZzb": ("George", "Eldrin - Crisp British Baritone", "6WwXjDDEMyNmFG95zycZ"),
    "N2lVS1w4EtoT3dr4eOWO": ("Callum", "Callum - Husky Trickster", "fs2OqxduwXgp9foh2xjK"),
    "SAz9YHcvj6GT2YYXdXww": ("River", "Elowen - Upbeat Modern Narrator", "dvbL7qkNGZY1IqPGZAjM"),
    "SOYHLrjzK2X1ezoPC6cr": ("Harry", "Kaelen - Amateur Warrior", "10NkTYmU7tSz3Kkl3Lex"),
    "TX3LPaxmHKxFdv7VOQHJ": ("Liam", "Lawrence - Bright and Informative", "ktkP7Nsj67dw2zcplQYt"),
    "Xb7hH8MSUJpSbSDYk0k2": ("Alice", "Alicia - Polished Global Anchor", "BFd5oBc2DDna33pSi4Gf"),
    "XrExE9yKIg1WjnnlVkGX": ("Matilda", "Maisie - Friendly Casual Neighbor", "QtY3JBOUKEB5xzrRfOKc"),
    "bIHbv24MWmeRgasZH58o": ("Will", "Warren - Effortless and Cool", "7QN34D2r3hCNwbOYIeK0"),
    "cgSgspJ2msm6clMCkdW9": ("Jessica", "Jade - Upbeat and Natural", "g7LVvkPWALzPxOQbF6OE"),
    "cjVigY5qzO86Huf0OWal": ("Eric", "Eddie - Natural and Helpful", "l7kNoIfnJKPg7779LI2t"),
    "iP95p4xoKVk53GoZ742B": ("Chris", "Caleb - Trusted Guide", "AaOhDHYJ1XLZk74lXhdE"),
    "nPczCjzI2devNBz1zQrb": ("Brian", "Sawyer - Midnight Storyteller", "8dEUmyPMdDdK91vboYih"),
    "onwK4e9ZLuTAKqWW03F9": ("Daniel", "Finley - Articulate Anchor", "fnYMz3F5gMEDGMWcH1ex"),
    "pFZP5JQG7iQjIQuC4Bku": ("Lily", "Florence - Atmospheric Storyteller", "22N9cF8z0o7y23njdyaY"),
    "pqHfZKP75CvOlQylNhV4": ("Bill", "Wyatt - Seasoned Mentor", "FrS6cKLB1wg4WYgPa9GW"),
}


def utc_today() -> date:
    # UTC, not the runner's local zone: the scheduled runner and the queue worker
    # must agree on which day it is, and a vendor cut-off is not in our zone either.
    return datetime.now(timezone.utc).date()


def _key(voice_id) -> str:
    return voice_id.strip() if isinstance(voice_id, str) else ""


def retired_on(voice_id) -> Optional[date]:
    """The first day the voice no longer works, or None when no retirement is known for it."""
    return _LAST_DAY + timedelta(days=1) if _key(voice_id) in DEFAULT_VOICES else None


def days_left(voice_id, today: Optional[date] = None) -> Optional[int]:
    """Days the voice still works, counting today (1 on 31 Dec), 0 once retired, None when not retiring."""
    gone = retired_on(voice_id)
    if gone is None:
        return None
    return max(0, (gone - (today or utc_today())).days)


def refusal(voice_id, today: Optional[date] = None) -> Optional[str]:
    """Why a run must not use this voice today, or None when it may.

    The suggested replacement is named so the person knows what to listen to; it
    is not picked for them, and it may not be in their account's list."""
    gone = retired_on(voice_id)
    if gone is None or (today or utc_today()) < gone:
        return None
    old, suggested, _ = DEFAULT_VOICES[_key(voice_id)]
    return (
        f"The voice {old} ({_key(voice_id)}) was an ElevenLabs Default voice, retired on 31 Dec 2026, "
        "and no longer works. Pick a voice from the account's own list in the Command Center "
        f"(Agents → Voice). ElevenLabs suggests {suggested} as a replacement; listen to it before "
        "choosing it. No voice is substituted."
    )
