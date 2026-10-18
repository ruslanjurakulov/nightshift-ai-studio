"""A coded reason for a failed render job (``render_jobs.error``).

Why this exists
---------------
``render_jobs.error`` holds an operator's text: the exit header plus the end of
the run log. That is right for the operator and wrong for a customer, whose page
used to show the first line and the whole tail as a tooltip, vendor names and
remedies included ("top up the Kling account"). A customer needs a plain
sentence, and the page needs something stable to choose it by.

The column is plain ``text`` and migrations are applied to production on merge,
so the code travels in that text as a prefix the Command Center parses
(``lib/runBackend.ts`` ``parseJobError``)::

    [code:voice] main.py exited with code 1
    <scrubbed log tail ...>

The prefix is the contract. Codes are a closed set; the page maps each to a
sentence in every language and treats anything else as ``unknown``.

How a code is chosen
--------------------
From what the failed run itself says, never from a guess about money:

* the last exception line of the traceback in the log tail
  (``modules.audio_mixer.VoiceUnavailable: ...``) names the failing stage;
* the worker's own headers (``credits: ...``, ``timed out after ...``).

No match is ``unknown``, shown as such. Nothing here reads a key, and the tail it
looks at has already been scrubbed by the worker.
"""

from __future__ import annotations

import re
from typing import Iterable, Optional

CREDITS = "credits"
VOICE = "voice"
PROVIDER_QUOTA = "provider_quota"
MEDIA = "media"
RENDER = "render"
TIMEOUT = "timeout"
UNKNOWN = "unknown"

CODES = (CREDITS, VOICE, PROVIDER_QUOTA, MEDIA, RENDER, TIMEOUT, UNKNOWN)

#: The marker ``lib/runBackend.ts`` parses. Keep the two in step.
PREFIX_RE = re.compile(r"^\[code:([a-z_]+)\][ \t]?")

#: Exception class (last dotted part) -> code. A run that dies with one of these
#: failed at the stage the class belongs to.
_BY_CLASS = {
    "VoiceUnavailable": VOICE,
    "VideoModelUnavailable": PROVIDER_QUOTA,
    "MediaUnavailable": MEDIA,
    "RenderBackendError": RENDER,
    "RenderRefused": RENDER,
    "SceneRenderError": RENDER,
    "SceneRemotionError": RENDER,
    "RenderTimeout": TIMEOUT,
    "TimeoutExpired": TIMEOUT,
    "CreditRefused": CREDITS,
}

_EXC_LINE = re.compile(r"^(?:[A-Za-z_][\w]*\.)*([A-Z][A-Za-z0-9_]*(?:Error|Exception|Unavailable|Refused|Expired|Timeout))\b:?(.*)$")
# A vendor's own "out of quota" answer that no pipeline class wraps.
_QUOTA_TEXT = re.compile(r"RESOURCE_EXHAUSTED|\b429\b|insufficient[_ ]quota|quota[_ ]exceeded", re.I)
_TIMED_OUT = re.compile(r"\btimed out\b", re.I)


def classify(header: str = "", tail: Iterable[str] = ()) -> str:
    """The code for a failed job, from the worker's ``header`` line and the
    scrubbed ``tail`` of the run log. Always one of :data:`CODES`."""
    first = (header or "").strip().splitlines()[0] if (header or "").strip() else ""
    if first.startswith("credits:"):
        return CREDITS
    if _TIMED_OUT.search(first):
        return TIMEOUT
    last = None
    for line in reversed([str(x).strip() for x in tail if str(x).strip()]):
        m = _EXC_LINE.match(line)
        if m:
            last = m
            break
    if last is not None:
        code = _BY_CLASS.get(last.group(1))
        if code:
            return code
        if _QUOTA_TEXT.search(last.group(2)):
            return PROVIDER_QUOTA
    return UNKNOWN


def tag(code: Optional[str], text: str) -> str:
    """``text`` behind its ``[code:...]`` prefix (replacing one it already has)."""
    code = code if code in CODES else UNKNOWN
    return f"[code:{code}] " + PREFIX_RE.sub("", text or "", count=1)


def code_of(text: Optional[str]) -> Optional[str]:
    """The code a stored error carries, or None for text written before codes."""
    m = PREFIX_RE.match(text or "")
    return m.group(1) if m and m.group(1) in CODES else None
