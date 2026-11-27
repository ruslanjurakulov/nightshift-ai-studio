#!/usr/bin/env python3
"""Which ElevenLabs voices this project uses are about to expire or were already replaced. Read-only.

    python tools/audit_voices.py                 # voices.json, config, every channel's saved voices
    python tools/audit_voices.py --channels-file channels.json

ElevenLabs is retiring two kinds of voice (help pages read 2026-11-14):

* **Default voices** expire on 2026-12-31 and stop working after that date
  (DEFAULT_VOICES_URL). A channel narrated by one stops on 2027-01-01, and
  verify_voice will refuse it: no video rather than another voice.
* **Legacy voices** are already gone. The API silently re-routes their ids to a
  replacement voice (LEGACY_VOICES_URL), so a channel saved with Rachel is today
  read by someone else, and nothing in a run says so.

This lists every voice id it can find (lib/voices.json, config's default, each
channel's narrator and quote voice) and flags each as Default, Legacy or other.
It prints names and ids only. It never reads, prints or sends a key, calls no
ElevenLabs endpoint and changes nothing. Replacing a voice is the owner's choice,
made after listening; the "suggested" column is ElevenLabs' own suggestion,
copied from its page, not a decision.

Channels come from the same registry a run uses: Supabase (read-only select)
when SUPABASE_URL and SUPABASE_SERVICE_KEY are set, else channels.json.

It also prints the language gate's effect (modules/tts_languages.py): which
ElevenLabs channels are in Uzbek while this deployment's ELEVENLABS_MODEL_ID is
a model that does not speak Uzbek. Those channels now stop at preflight.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Iterable, Optional

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# One table for the audit, the preflight and the TTS adapter (modules/voice_retirement).
from modules.voice_retirement import DEFAULT_EXPIRES, DEFAULT_VOICES, DEFAULT_VOICES_URL, READ_ON  # noqa: E402

LEGACY_VOICES_URL = "https://elevenlabs.io/docs/help-center/product/voices/my-voices/what-are-legacy-voices"

#: Legacy voice name -> the voice ElevenLabs re-routes it to. From LEGACY_VOICES_URL, READ_ON.
#: That page gives names only, no ids, so an id is flagged Legacy only when this project
#: names it (lib/voices.json). An id saved on a channel with no name is "other", said as such.
LEGACY_VOICES: dict[str, str] = {
    "Antoni": "Adam", "Aria": "Zoe", "Arnold": "Adam", "Charlotte": "Helen", "Clyde": "Kaelen",
    "Dave": "Geoffrey", "Domi": "Elara", "Dorothy": "Evelyn", "Drew": "Wyatt", "Elli": "Peter",
    "Emily": "Clara", "Ethan": "Tom", "Fin": "Peter", "Freya": "Maisie", "Gigi": "Maisie",
    "Giovanni": "Mathis", "Glinda": "Janet", "Grace": "Riley", "James": "Finley", "Jeremy": "Craig",
    "Jessie": "Julian", "Joseph": "Goliath", "Josh": "Craig", "Michael": "Robert", "Mimi": "Brenna",
    "Nicole": "Clara", "Patrick": "Lawrence", "Paul": "Wyatt", "Rachel": "Janet", "Sam": "Riley",
    "Serena": "Janet", "Thomas": "Tom",
}

VOICES_JSON = ROOT / "command-center" / "lib" / "voices.json"


def classify(voice_id: str, name: Optional[str]) -> tuple[str, str]:
    """``(flag, note)``: flag is "default", "legacy" or "other"."""
    if voice_id in DEFAULT_VOICES:
        old, new, new_id = DEFAULT_VOICES[voice_id]
        return "default", f"Default voice {old}: expires {DEFAULT_EXPIRES}; ElevenLabs suggests {new} ({new_id})"
    if name and name in LEGACY_VOICES:
        return "legacy", f"Legacy voice {name}: already re-routed by the API to {LEGACY_VOICES[name]}"
    return "other", ("not in either table" if name else
                     "not a Default voice; the Legacy page lists names only, so an unnamed id cannot be matched")


def catalogue_names(voices: Iterable[dict]) -> dict[str, str]:
    return {v["id"]: v["name"] for v in voices if isinstance(v, dict) and v.get("id")}


def collect(voices: list, config_default: str, channels: Iterable) -> list[dict]:
    """Every (source, id) pair, each with its name when this project knows it, and its flag."""
    names = catalogue_names(voices)
    rows: list[dict] = []

    def add(source: str, voice_id, name: Optional[str] = None):
        if not isinstance(voice_id, str) or not voice_id.strip() or voice_id.strip() == "narrator":
            return
        vid = voice_id.strip()
        name = name or names.get(vid) or (DEFAULT_VOICES[vid][0] if vid in DEFAULT_VOICES else None)
        flag, note = classify(vid, name)
        rows.append({"source": source, "name": name or "", "id": vid, "flag": flag, "note": note})

    for v in voices:
        if isinstance(v, dict):
            add("lib/voices.json", v.get("id"), v.get("name"))
    add("config.ELEVENLABS_VOICE_ID", config_default)
    for ch in channels:
        agent = getattr(ch, "agent", None)
        cid = str(getattr(ch, "channel_id", "?"))
        add(f"channel {cid} narrator", getattr(agent, "elevenlabs_voice_id", None))
        add(f"channel {cid} quote voice", getattr(agent, "elevenlabs_secondary_voice_id", None))
    return rows


def language_gate(channels: Iterable, model: str) -> list[dict]:
    """ElevenLabs channels the language gate now stops under ``model``, with the reason."""
    from modules import tts_languages
    out = []
    for ch in channels:
        agent = getattr(ch, "agent", None)
        if getattr(agent, "tts_provider", None) != "elevenlabs":
            continue
        language = getattr(agent, "language", None)
        if not (isinstance(language, str) and language.strip()):
            # The same fallback the run uses (audio_mixer.script_language), so a channel
            # with no language of its own is judged in the deployment's.
            import config
            language = config.SCRIPT_LANGUAGE
        reason = tts_languages.refusal(model, language)
        if reason:
            out.append({"channel": str(getattr(ch, "channel_id", "?")), "status": str(getattr(ch, "status", "")),
                        "language": language, "model": model, "reason": reason})
    return out


def _channels(channels_file: Optional[str]):
    from modules.channels import ChannelRegistry
    return ChannelRegistry(file_path=channels_file).list() if channels_file else ChannelRegistry().list()


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--channels-file", help="the channels.json to read when Supabase is not configured (Supabase wins when it is)")
    ap.add_argument("--json", action="store_true", help="print one JSON object instead of a table")
    args = ap.parse_args(argv)

    import config
    voices = json.loads(VOICES_JSON.read_text(encoding="utf-8"))
    channels = _channels(args.channels_file)
    rows = collect(voices, config.ELEVENLABS_VOICE_ID, channels)
    gate = language_gate(channels, config.ELEVENLABS_MODEL_ID)
    if args.json:
        print(json.dumps({"read_on": READ_ON, "voices": rows, "language_gate": gate}, ensure_ascii=False, indent=2))
        return 0
    print(f"Voices (tables from {DEFAULT_VOICES_URL} and {LEGACY_VOICES_URL}, read {READ_ON})")
    for r in rows:
        print(f"  {r['flag']:<8} {r['id']}  {r['name'] or '-':<10} {r['source']}: {r['note']}")
    counts = {f: sum(1 for r in rows if r["flag"] == f) for f in ("default", "legacy", "other")}
    print(f"  {counts['default']} default, {counts['legacy']} legacy, {counts['other']} other. Nothing was changed.")
    print(f"Language gate under ELEVENLABS_MODEL_ID={config.ELEVENLABS_MODEL_ID}:")
    if not gate:
        print("  no ElevenLabs channel stops")
    for g in gate:
        print(f"  STOPS  channel {g['channel']} ({g['status']}, {g['language']}): {g['reason']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
