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


def example_keys(text: str) -> List[str]:
    return re.findall(r"^([A-Z][A-Z0-9_]*)=", text, re.M)


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


def main(argv: List[str]) -> int:
    if len(argv) != 2:
        print("usage: build-worker-env.py <payload file>", file=sys.stderr)
        return 2
    lines, errors = build(os.environ, EXAMPLE.read_text(encoding="utf-8"))
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
