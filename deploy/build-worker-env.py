#!/usr/bin/env python3
"""Append the worker's env to the deploy payload (.github/workflows/deploy_web.yml).

    python3 deploy/build-worker-env.py <payload file>

Runs on the GitHub runner, only while the variable NIGHTSHIFT_WORKER is `on`.
Reads, from its own environment:

* ``WORKERENV_<KEY>`` for every key in deploy/.env.worker.example — the
  workflow maps each one from the repository secret or variable of the same
  name, the ones daily_video.yml already uses. Nothing else: the workflow
  never hands this script ``toJSON(secrets)`` (GitHub holds such a run for
  manual approval). Channels other than the default publish from the worker
  through their Supabase Vault connection, not a CHRONOS_YT_TOKEN_<REF> secret.

Prints ``::warning::`` lines for what will not work with the values it was
given: the NAMES of empty secrets, and provider switches that are on while the
key they need is empty (``warnings``). Names only, never a value or a length.

Appends a ``NIGHTSHIFT_WORKER_ENV=on`` marker line and then one ``KEY=value``
line per key; deploy/remote-deploy.sh splits the payload there and writes the
second half to /opt/nightshift/.env.worker (600).

A JSON value (the OAuth client, the YouTube tokens) is compacted to one line:
compose reads one line per key, and a secret pasted pretty-printed would
otherwise arrive cut. Errors name the key and the fix, never a value — this
output is a public Actions log.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Dict, List, Mapping, Tuple

EXAMPLE = Path(__file__).resolve().parent / ".env.worker.example"
MARKER = "NIGHTSHIFT_WORKER_ENV=on"
TOKEN_NAME = re.compile(r"^CHRONOS_YT_TOKEN_[A-Z0-9_]+$")
REQUIRED = ("SUPABASE_URL", "SUPABASE_SERVICE_KEY")
PREFIX = "WORKERENV_"


#: Same words config.py reads a switch with.
TRUE_WORDS = ("1", "true", "yes", "on")
#: The example file's secrets sit above this heading, its variables below.
BEHAVIOUR_HEADING = "# ─── Behaviour"
#: Generated-video provider id -> the keys it needs (any one group). Kept in step
#: with modules/video_providers.py by tests/test_deploy_gha.py.
VIDEO_KEYS = {
    "minimax": (("MINIMAX_API_KEY",),),
    "higgsfield": (("HIGGSFIELD_API_KEY",),),
    "kling": (("KLING_API_KEY",), ("KLING_ACCESS_KEY", "KLING_SECRET_KEY")),
    "veo": (("VEO_API_KEY",),),
    "seedance": (("SEEDANCE_API_KEY",),),
    "wan": (("WAN_API_KEY",),),
}
#: Generated-still provider id -> its key (modules/image_providers.KEY_ATTRS).
IMAGE_KEYS = {
    "leonardo": "LEONARDO_API_KEY",
    "gpt-image": "OPENAI_API_KEY",
    "nano-banana": "GEMINI_API_KEY",
    "flux": "BFL_API_KEY",
    "ideogram": "IDEOGRAM_API_KEY",
    "fal": "FAL_KEY",
}
PRICE_PREFIX = "CHRONOS_PRICE_"


def example_keys(text: str) -> List[str]:
    return re.findall(r"^([A-Z][A-Z0-9_]*)=", text, re.M)


def secret_keys(text: str) -> List[str]:
    return example_keys(text.split(BEHAVIOUR_HEADING)[0])


def _is_json_key(key: str) -> bool:
    return key.endswith("_JSON") or bool(TOKEN_NAME.match(key))


def clean(key: str, raw: str) -> Tuple[str, List[str]]:
    """The value as it goes into the env file, and what is wrong with it."""
    value = raw.replace("\r", "").strip()
    errors: List[str] = []
    if value and _is_json_key(key):
        try:
            value = json.dumps(json.loads(value), separators=(",", ":"))
        except ValueError:
            errors.append(f"{key} is not valid JSON; paste the whole file content into the secret")
    if "\n" in value:
        errors.append(f"{key} contains a line break; re-paste it on one line")
    if "$" in value:
        errors.append(f'{key} contains "$", which compose would interpolate; change the value')
    return value, errors


def build(env: Mapping[str, str], example_text: str) -> Tuple[List[str], List[str]]:
    lines: List[str] = []
    errors: List[str] = []
    keys = example_keys(example_text)
    if not keys:
        return [], ["no keys found in deploy/.env.worker.example"]
    values: Dict[str, str] = {}
    for key in keys:
        if PREFIX + key not in env:
            errors.append(f"{key} is in deploy/.env.worker.example but not mapped in deploy_web.yml")
            continue
        values[key] = env[PREFIX + key]

    for key, raw in values.items():
        value, problems = clean(key, raw)
        errors.extend(problems)
        lines.append(f"{key}={value}")
    for key in REQUIRED:
        if key in values and not clean(key, values[key])[0]:
            errors.append(f"{key} is required for the worker and empty (repository secret {key})")
    return lines, errors


def warnings(values: Mapping[str, str], example_text: str) -> List[str]:
    """What will not work with these values, as plain sentences naming keys.

    ``values`` maps key -> raw value (as ``build`` read it). Pure and offline.
    Only names appear in the sentences: a public Actions log must never see a
    value, a prefix or a length."""
    def get(key: str) -> str:
        return clean(key, values.get(key, ""))[0]

    def on(key: str) -> bool:
        return get(key).lower() in TRUE_WORDS

    out: List[str] = []
    empty = [k for k in secret_keys(example_text) if k in values and not get(k)]
    if empty:
        out.append(
            "empty, so the worker does not have: " + ", ".join(empty) + ". These must be repository SECRETS "
            "(Settings > Secrets and variables > Actions > Secrets): a key saved as a Variable arrives empty. "
            "Leave a provider's key empty only if you do not use that provider.")

    def need(label: str, key_groups, switch: str) -> None:
        if not any(all(get(k) for k in group) for group in key_groups):
            names = " or ".join("+".join(group) for group in key_groups)
            out.append(f"{switch} is on for {label} but {names} is empty: the run would use stock footage/voice "
                       "instead (or stop, depending on the provider).")

    video = get("CHRONOS_VIDEO_PROVIDER").lower() or "minimax"
    video_wanted = on("CHRONOS_ENABLE_VIDEO_GEN") or on("CHRONOS_ENABLE_MINIMAX_BROLL")
    if video_wanted and video not in VIDEO_KEYS:
        out.append("CHRONOS_VIDEO_PROVIDER is not one of " + ", ".join(VIDEO_KEYS) + ": generated clips are off.")
    elif video == "minimax":
        if on("CHRONOS_ENABLE_MINIMAX_BROLL"):
            need("MiniMax clips", VIDEO_KEYS["minimax"], "CHRONOS_ENABLE_MINIMAX_BROLL")
        elif on("CHRONOS_ENABLE_VIDEO_GEN"):
            out.append("CHRONOS_ENABLE_VIDEO_GEN is on with CHRONOS_VIDEO_PROVIDER minimax (or unset) but "
                       "CHRONOS_ENABLE_MINIMAX_BROLL is not: MiniMax clips are off.")
    elif on("CHRONOS_ENABLE_VIDEO_GEN") and video in VIDEO_KEYS:
        need(f"{video} clips", VIDEO_KEYS[video], "CHRONOS_ENABLE_VIDEO_GEN")

    if on("CHRONOS_ENABLE_IMAGE_GEN"):
        image = get("CHRONOS_IMAGE_PROVIDER").lower() or "pexels"
        if image in IMAGE_KEYS:
            need(f"{image} stills", ((IMAGE_KEYS[image],),), "CHRONOS_ENABLE_IMAGE_GEN")
        else:
            out.append("CHRONOS_ENABLE_IMAGE_GEN is on but CHRONOS_IMAGE_PROVIDER is not one of "
                       + ", ".join(IMAGE_KEYS) + ": generated stills are off.")
    if on("CHRONOS_ENABLE_VIDIQ"):
        need("vidIQ research", (("VIDIQ_ACCESS_TOKEN",),), "CHRONOS_ENABLE_VIDIQ")
    if on("NIGHTSHIFT_AVATAR_ENABLED"):
        need("the avatar", (("HIGGSFIELD_API_KEY_ID", "HIGGSFIELD_API_KEY_SECRET"),), "NIGHTSHIFT_AVATAR_ENABLED")
    if not get("ELEVENLABS_API_KEY"):
        if get("TTS_PROVIDER").lower() == "elevenlabs":
            out.append("TTS_PROVIDER is elevenlabs but ELEVENLABS_API_KEY is empty: every run will stop at the voice check.")
        elif not get("TTS_PROVIDER"):
            out.append("ELEVENLABS_API_KEY is empty and TTS_PROVIDER is unset: narration will use the free Edge voice.")

    prices = [k for k in values if k.startswith(PRICE_PREFIX) and get(k)]
    if not prices:
        out.append("no " + PRICE_PREFIX + "* variable is set: costs are recorded without USD, so "
                   "CHRONOS_MAX_RUN_USD / CHRONOS_MAX_DAILY_USD cannot see any spend.")
    for key in ("CHRONOS_MAX_RUN_USD", "CHRONOS_MAX_DAILY_USD") + tuple(k for k in values if k.startswith(PRICE_PREFIX)):
        raw = get(key)
        if raw and raw.lower() != "off":
            try:
                ok = float(raw) > 0 if key.startswith("CHRONOS_MAX") else float(raw) >= 0
            except ValueError:
                ok = False
            if not ok:
                out.append(f"{key} is not a valid number: it is ignored (the default applies / the unit stays unpriced).")
    return out


def main(argv: List[str]) -> int:
    if len(argv) != 2:
        print("usage: build-worker-env.py <payload file>", file=sys.stderr)
        return 2
    example_text = EXAMPLE.read_text(encoding="utf-8")
    lines, errors = build(os.environ, example_text)
    if not errors:
        raw = {k: os.environ[PREFIX + k] for k in example_keys(example_text) if PREFIX + k in os.environ}
        for w in warnings(raw, example_text):
            print(f"::warning::{w}")
    if errors:
        for e in errors:
            print(f"::error::{e}")
        print("Fix these in GitHub -> Settings -> Secrets and variables -> Actions, then re-run.")
        return 1
    with open(argv[1], "a", encoding="utf-8") as fh:
        fh.write(MARKER + "\n")
        for line in lines:
            fh.write(line + "\n")
    print(f"Worker env built: {len(lines)} keys.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
