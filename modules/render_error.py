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
* the worker's own headers (``credits: ...``, ``timed out after ...``, and the
  held-before-render exit code's).

No match is ``unknown``, shown as such. Nothing here reads a key, and the tail it
looks at has already been scrubbed by the worker.
"""

from __future__ import annotations

import re
from typing import Iterable, Optional

from modules.gemini_stages import GEMINI_QUOTA_EXIT
from modules.publish_gate import HELD_BEFORE_RENDER_EXIT
from modules.voice_gate import VOICE_GATE_EXIT, VOICE_GATE_UNAVAILABLE_EXIT

CREDITS = "credits"
VOICE = "voice"
PROVIDER_QUOTA = "provider_quota"
MEDIA = "media"
RENDER = "render"
TIMEOUT = "timeout"
#: The accuracy check held the script before any video was made (main.py exit
#: ``publish_gate.HELD_BEFORE_RENDER_EXIT``): no traceback, so it is named by the
#: worker's own header, never guessed from the log.
HELD = "held"
#: The owner switched the provider the run would use OFF (migration 0124, modules/model_switch.py): stopped before anything was spent.
SWITCHED_OFF = "switched_off"
UNKNOWN = "unknown"

CODES = (CREDITS, VOICE, PROVIDER_QUOTA, MEDIA, RENDER, TIMEOUT, HELD, SWITCHED_OFF, UNKNOWN)

#: The marker ``lib/runBackend.ts`` parses. Keep the two in step.
PREFIX_RE = re.compile(r"^\[code:([a-z_]+)\][ \t]?")

#: Exception class (last dotted part) -> code. A run that dies with one of these
#: failed at the stage the class belongs to.
_BY_CLASS = {
    "VoiceUnavailable": VOICE,
    # Raised for config, key, auth and non-JSON answers as well as quota: it is `media`
    # (the clip source could not be used) unless its own message says quota (see classify).
    "VideoModelUnavailable": MEDIA,
    "MediaUnavailable": MEDIA,
    "RenderBackendError": RENDER,
    "RenderRefused": RENDER,
    "SceneRenderError": RENDER,
    "SceneRemotionError": RENDER,
    "RenderTimeout": TIMEOUT,
    "TimeoutExpired": TIMEOUT,
    "CreditRefused": CREDITS,
    # The run refused to start on a full output volume (main._preflight_disk): nothing was made.
    "InsufficientDisk": RENDER,
}

#: A traceback's last line: `pkg.mod.ClassName: message`, or a bare `ClassName` (no message). A log line that merely
#: mentions a class (`INFO falling back after VoiceUnavailable: nope`) does not start like this.
_EXC_LINE = re.compile(r"^(?:[A-Za-z_]\w*\.)*([A-Z][A-Za-z0-9_]*(?:Error|Exception|Unavailable|Refused|Expired|Timeout|Disk))\b(?::[ \t]?(.*))?$")
# A vendor's own "out of quota" answer. The 429 is anchored to an HTTP-looking phrase, never a bare number.
_QUOTA_TEXT = re.compile(
    r"RESOURCE_EXHAUSTED|insufficient[_ ]quota|quota[_ ]exceeded|\bquota\b|too many requests"
    r"|(?:HttpError|HTTP|status(?:_code)?)[ =:]*429\b",
    re.I,
)
_TIMED_OUT = re.compile(r"\btimed out\b", re.I)

#: The stored text is capped by a CHECK (render_jobs.error, 0017: length <= 2000).
MAX_CHARS = 2000


def classify(header: str = "", tail: Iterable[str] = ()) -> str:
    """The code for a failed job, from the worker's ``header`` line and the
    scrubbed ``tail`` of the run log. Always one of :data:`CODES`."""
    first = (header or "").strip().splitlines()[0] if (header or "").strip() else ""
    if first.startswith("credits:"):
        return CREDITS
    if first.startswith(f"main.py exited with code {HELD_BEFORE_RENDER_EXIT}:"):
        return HELD
    if first.startswith(f"main.py exited with code {GEMINI_QUOTA_EXIT}:"):
        # Clean exit, no traceback to read the class from: the worker's header is the evidence.
        return PROVIDER_QUOTA
    for exit_code in (VOICE_GATE_EXIT, VOICE_GATE_UNAVAILABLE_EXIT):
        if first.startswith(f"main.py exited with code {exit_code}:"):
            # The custom-voice gate (not permitted, or could not be verified in strict mode): a clean exit with no traceback, so the
            # worker's header is the evidence. A voice problem, in the customer's words as well; the page never says which.
            return VOICE
    if _TIMED_OUT.search(first):
        return TIMEOUT
    last = None
    for line in reversed([str(x).strip() for x in tail if str(x).strip()]):
        m = _EXC_LINE.match(line)
        if m:
            last = m
            break
    if last is not None:
        cls, message = last.group(1), last.group(2) or ""
        # ElevenLabs' ApiError carries the account's own answer: out of characters is the voice.
        if cls == "ApiError" and re.search(r"quota_exceeded", message, re.I):
            return VOICE
        code = _BY_CLASS.get(cls)
        if code == MEDIA and cls == "VideoModelUnavailable" and _QUOTA_TEXT.search(message):
            return PROVIDER_QUOTA
        if code:
            return code
        if _QUOTA_TEXT.search(message):
            return PROVIDER_QUOTA
    return UNKNOWN


def tag(code: Optional[str], text: str, limit: int = MAX_CHARS) -> str:
    """``text`` behind its ``[code:...]`` prefix (replacing one it already has), never longer than ``limit``.

    The column has a CHECK on its length, so a write that is one character over is refused and the job would stay
    "running". When the prefix does not fit, the MIDDLE of the body goes: the header line and the end of the log
    (where the reason is) survive."""
    code = code if code in CODES else UNKNOWN
    prefix = f"[code:{code}] "
    body = PREFIX_RE.sub("", text or "", count=1)
    room = limit - len(prefix)
    if len(body) > room:
        head = body.split("\n", 1)[0][: max(0, room // 4)]
        tail_room = room - len(head) - 2
        body = head + "\n…" + (body[-tail_room:] if tail_room > 0 else "")
    return prefix + body


def code_of(text: Optional[str]) -> Optional[str]:
    """The code a stored error carries, or None for text written before codes."""
    m = PREFIX_RE.match(text or "")
    return m.group(1) if m and m.group(1) in CODES else None
