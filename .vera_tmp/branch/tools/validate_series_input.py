#!/usr/bin/env python3
"""Check the ``series`` input of a manual daily_video.yml dispatch.

    INPUT_SERIES=ancient-mysteries python tools/validate_series_input.py [--require-channel]

Exit 0 when no series was typed or the id is valid; exit 1 with one ``::error``
line otherwise. The workflow calls it twice: in the cheap ``resolve`` job (so a
typo costs seconds and no channel job starts) and again in the run step right
before the id is appended to ``main.py``'s argument list, so the value that
reaches the command line is always one this function accepted.

The id is read from the environment, never from the shell text, and the error
never echoes it: a newline inside it could forge a workflow command in the log.
The rule is ``modules.run_request.validate_series_arg``, the same one the argv
builder uses.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules.run_request import InvalidRunRequest, validate_series_arg  # noqa: E402


def main(env=None, argv=None, out=print) -> int:
    env = os.environ if env is None else env
    argv = sys.argv[1:] if argv is None else argv
    series = env.get("INPUT_SERIES", "")
    if series == "":
        return 0
    try:
        validate_series_arg(series)
    except InvalidRunRequest as e:
        out(f"::error title=Invalid series::{e}")
        return 1
    # An empty channel means "every active channel": the series would be applied to
    # channels it does not belong to (main.run refuses that as well, per channel).
    if "--require-channel" in argv and not env.get("INPUT_CHANNEL", "").strip():
        out("::error title=Series needs a channel::A series belongs to one channel: "
            "fill in 'channel' as well, or leave 'series' empty.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
