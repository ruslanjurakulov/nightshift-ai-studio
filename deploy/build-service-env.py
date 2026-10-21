#!/usr/bin/env python3
"""Append one small worker's own env to the deploy payload (.github/workflows/deploy_web.yml).

    python3 deploy/build-service-env.py <notify|email|operator|marketing> <payload file>

Runs on the GitHub runner, only while that worker's switch is `on`
(NIGHTSHIFT_NOTIFY_WORKER, NIGHTSHIFT_EMAIL_WORKER, NIGHTSHIFT_OPERATOR_BOT,
NIGHTSHIFT_MARKETING_WORKER).
Reads, from its own environment, ``NOTIFYENV_<KEY>`` / ``EMAILENV_<KEY>`` /
``OPERATORENV_<KEY>`` / ``MARKETINGENV_<KEY>`` for every key in deploy/.env.notify.example /
deploy/.env.email.example / deploy/.env.operator.example / deploy/.env.marketing.example, which the workflow maps
from the repository secret or variable of the same name. Nothing else: no
``toJSON(secrets)`` (GitHub holds such a run for manual approval), and nothing
of the pipeline worker's or the dashboard's environment.

Appends a marker line (``NIGHTSHIFT_NOTIFY_ENV=on`` / ``NIGHTSHIFT_EMAIL_ENV=on`` /
``NIGHTSHIFT_OPERATOR_ENV=on`` / ``NIGHTSHIFT_MARKETING_ENV=on``) and then one ``KEY=value`` line per key;
deploy/remote-deploy.sh splits the payload at the marker and writes that section
to /opt/nightshift/.env.notify / .env.email / .env.operator / .env.marketing (600), checked
against the same example file at the deployed commit.

Every key of the notify and e-mail files is required: a worker that is switched
on with a name empty would only log that it is OFF. The operator bot has a few
OPTIONAL keys (OPTIONAL below): they must still be mapped, but may be empty,
exactly as the GitHub workflows it replaces pass them. The marketing poster has one
too (NIGHTSHIFT_MARKETING_POSTS: empty means the worker idles). Errors name the key and
the fix, never a value: this output is a public Actions log.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Dict, List, Mapping, Tuple

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from modules import pipeline_pause  # noqa: E402 - stdlib only; the scheduler's own reading of the pause

# service -> (marker line, example file, environment prefix, where the switch lives)
SERVICES: Dict[str, Tuple[str, str, str, str]] = {
    "notify": ("NIGHTSHIFT_NOTIFY_ENV=on", ".env.notify.example", "NOTIFYENV_", "NIGHTSHIFT_NOTIFY_WORKER"),
    "email": ("NIGHTSHIFT_EMAIL_ENV=on", ".env.email.example", "EMAILENV_", "NIGHTSHIFT_EMAIL_WORKER"),
    "operator": ("NIGHTSHIFT_OPERATOR_ENV=on", ".env.operator.example", "OPERATORENV_", "NIGHTSHIFT_OPERATOR_BOT"),
    "marketing": ("NIGHTSHIFT_MARKETING_ENV=on", ".env.marketing.example", "MARKETINGENV_", "NIGHTSHIFT_MARKETING_WORKER"),
}
# service -> keys that may be empty (all others are required)
OPTIONAL: Dict[str, frozenset] = {
    "operator": frozenset({
        "TELEGRAM_ADMIN_USER_IDS", "GITHUB_TOKEN", "GITHUB_REPOSITORY", "ELEVENLABS_LOW_CREDITS",
        "OPERATOR_APP_URL", "OPERATOR_LANGUAGE", "OPERATOR_TZ", "OPERATOR_QUIET_HOURS",
        "OPERATOR_DIGEST_HOUR", "OPERATOR_STUCK_MINUTES", "OPERATOR_ALERT_MAX_PER_HOUR", "OPERATOR_DEADMAN_HOURS",
        # The owner's pause of the scheduled pipeline (empty = running): docs/VIDEO_GO_LIVE.md.
        "NIGHTSHIFT_PIPELINE_PAUSED",
        # The owner's e-mail copy (docs/OWNER_EMAIL.md): off while NIGHTSHIFT_OWNER_EMAIL is empty.
        "NIGHTSHIFT_OWNER_EMAIL", "OWNER_EMAIL_KINDS", "RESEND_API_KEY", "NIGHTSHIFT_EMAIL_FROM",
    }),
    # Empty = the worker idles. The deploy never needs the poster's own switch to succeed.
    "marketing": frozenset({"NIGHTSHIFT_MARKETING_POSTS"}),
}
# service -> {key: switch key that must be exactly `on` for the key to be written; otherwise it is written empty}.
# A secret that belongs to an optional feature never reaches the container while the feature is off, even if the
# workflow mapped it by mistake (docs/OWNER_EMAIL.md).
GATED: Dict[str, Dict[str, str]] = {
    "operator": {"RESEND_API_KEY": "NIGHTSHIFT_OWNER_EMAIL"},
}
ORIGIN_KEYS = ("NOTIFY_APP_ORIGIN", "APP_ORIGIN")
CHAT_KEYS = ("MARKETING_TELEGRAM_CHAT",)
CHAT = re.compile(r"^(@[A-Za-z][A-Za-z0-9_]{4,31}|-?[0-9]{5,20})$")
ORIGIN = re.compile(r"^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?/?$")


def example_keys(text: str) -> List[str]:
    return re.findall(r"^([A-Z][A-Z0-9_]*)=", text, re.M)


def clean(key: str, raw: str, optional: bool = False) -> Tuple[str, List[str]]:
    """The value as it goes into the env file, and what is wrong with it."""
    value = raw.replace("\r", "").strip()
    errors: List[str] = []
    if not value:
        if optional:
            return value, errors
        errors.append(f"{key} is required and empty (repository secret or variable {key})")
        return value, errors
    if "\n" in value:
        errors.append(f"{key} contains a line break; re-paste it on one line")
    elif re.search(r"[\x00-\x1f\x7f]", value):
        errors.append(f"{key} contains a control character (a tab?); re-paste it as plain text")
    if "$" in value:
        errors.append(f'{key} contains "$", which compose would interpolate; change the value')
    if value[0] in "\"'`" or " #" in value:
        errors.append(f"{key} starts with a quote or contains ' #', which compose would read as syntax; change the value")
    if key in ORIGIN_KEYS and not ORIGIN.match(value):
        errors.append(f"{key} must be https://<host> with no path (a link a person will tap is built on it)")
    if key in CHAT_KEYS and not CHAT.match(value):
        errors.append(f"{key} must be @channelname or a numeric chat id (-100...)")
    return value, errors


def canonical_pause(raw: str) -> str:
    """The pause variable as it is WRITTEN to the env file: ``""`` (running) or ``true`` (paused), decided by the
    scheduler's own reading (modules/pipeline_pause.py), never the raw text.

    The scheduler accepts ``"true"``, ``'on'`` and ``true # pause`` (one pair of quotes, any case), so a value
    that ``clean()`` would refuse as compose syntax is a legitimate pause: refusing it failed EVERY deploy while
    the bot was on and the pause stayed quoted. Anything the scheduler cannot read counts as paused (fail closed),
    and nothing with a quote, ``$`` or ``#`` reaches compose. The raw value is never echoed."""
    return "" if pipeline_pause.pause_state({pipeline_pause.PAUSE_ENV: raw}) == "running" else "true"


def build(env: Mapping[str, str], example_text: str, prefix: str, example_name: str,
          optional: frozenset = frozenset(), gated: Mapping[str, str] = {}) -> Tuple[List[str], List[str]]:
    lines: List[str] = []
    errors: List[str] = []
    keys = example_keys(example_text)
    if not keys:
        return [], [f"no keys found in deploy/{example_name}"]
    for key in keys:
        if prefix + key not in env:
            errors.append(f"{key} is in deploy/{example_name} but not mapped in deploy_web.yml")
            continue
        if key == pipeline_pause.PAUSE_ENV:
            value, problems = canonical_pause(env[prefix + key]), []
        else:
            value, problems = clean(key, env[prefix + key], key in optional)
        if key in gated and env.get(prefix + gated[key], "").strip() != "on":
            value = ""
        errors.extend(problems)
        lines.append(f"{key}={value}")
    return lines, errors


def main(argv: List[str]) -> int:
    if len(argv) != 3 or argv[1] not in SERVICES:
        print(f"usage: build-service-env.py <{'|'.join(SERVICES)}> <payload file>", file=sys.stderr)
        return 2
    marker, example_name, prefix, switch = SERVICES[argv[1]]
    lines, errors = build(os.environ, (HERE / example_name).read_text(encoding="utf-8"), prefix, example_name,
                          OPTIONAL.get(argv[1], frozenset()), GATED.get(argv[1], {}))
    if errors:
        for e in errors:
            print(f"::error::{e}")
        print(f"Fix these in GitHub -> Settings -> Secrets and variables -> Actions, or set {switch} to anything but `on`, then re-run.")
        return 1
    with open(argv[2], "a", encoding="utf-8") as fh:
        fh.write(marker + "\n")
        for line in lines:
            fh.write(line + "\n")
    print(f"{argv[1]} worker env built: {len(lines)} keys.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
