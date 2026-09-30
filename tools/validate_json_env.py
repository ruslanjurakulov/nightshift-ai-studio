#!/usr/bin/env python3
"""Check that JSON secrets in the environment parse, before a workflow uses them.

    python tools/validate_json_env.py [--warning] YOUTUBE_TOKEN_JSON [NAME ...]

Every workflow step that writes a ``*_JSON`` secret to a file or to
``$GITHUB_ENV`` calls this first. A value that is not a JSON object is refused
here, in seconds and with the fix named, instead of surfacing as a bare
JSONDecodeError deep inside the OAuth library after the run has paid for a
script and narration.

An unset or empty variable passes: each step already reports "not set" in its
own words, and that is not this check's business. Exit status 1 means at least
one value is unusable; the step then writes nothing from it. ``--warning``
annotates the log as a warning instead of an error, for the steps whose
downstream code already treats an unusable token as "not connected".

The value is read from this process's environment, never from argv, and is
never printed — not in full, not in part, not its length. The error names the
variable and the fix. This output is a public Actions log.
"""

from __future__ import annotations

import json
import os
import re
import sys
from typing import List, Mapping

_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")


def problems(names: List[str], env: Mapping[str, str]) -> List[str]:
    out: List[str] = []
    for name in names:
        if not _NAME.match(name):
            out.append(f"{name!r} is not an environment variable name")
            continue
        raw = env.get(name, "")
        if not raw.strip():
            continue
        try:
            doc = json.loads(raw)
        except ValueError:
            out.append(f"{name} is not valid JSON; paste the whole file content into the secret")
            continue
        if not isinstance(doc, dict):
            out.append(f"{name} is JSON but not an object; paste the whole file content into the secret")
    return out


def main(argv: List[str]) -> int:
    args = argv[1:]
    level = "error"
    if args[:1] == ["--warning"]:
        level, args = "warning", args[1:]
    if not args:
        print("usage: validate_json_env.py [--warning] NAME [NAME ...]", file=sys.stderr)
        return 2
    found = problems(args, os.environ)
    for p in found:
        print(f"::{level}::{p} (Settings -> Secrets and variables -> Actions). Nothing was written from it.")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
