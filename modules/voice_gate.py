"""The Actions-side half of the Custom Voice hard gate (docs/CUSTOM_VOICE.md, "Hard gate").

Migration 0117 enforces "a cloned voice is used only by its owner, on a channel the owner attached it to" where a voice id enters
the DATABASE (a render_jobs row, a creative_jobs row, a write of channels.agent_config). A run on GitHub Actions enters through none
of those: the Run-now ``voice_id`` is a workflow input (ELEVENLABS_RUN_VOICE_ID), and a scheduled run reads whatever ids the channel's
agent_config holds today, including a voice that was attached last month and has been detached, deleted or orphaned since.

So the run asks the database again, itself, before it spends anything. The question is the one 0117 already answers for a channel:
``channel_voice_config_problem(channel, org, old, new)`` returns the first voice key of ``new`` that is a custom voice not usable on
that channel, or NULL. "Usable" there is: the profile is ``approved``; an ACTIVE attachment to this channel exists, in the channel's
CURRENT organization (an org move voids it), in the slot asked for; and the attaching owner is still an administrator of that
organization (a detached, demoted or removed owner voids it). A voice id that is in no profile (the operator's own premade and
library voices) answers NULL, exactly as before, and the id is compared lowercased and stripped, as the database does.

Why this function and not a table read: the voice tables are closed to every API role, the service role included (0117 revokes
SELECT from it). ``channel_voice_config_problem`` is the one voice function the service role may execute, and it takes no user, so it
answers for the CHANNEL path only. That is the rule for every run, whoever started it: the run-now voice is held to the narrator
attachment as well. The Run-now route asks the same function before it dispatches (command-center/app/api/agent/run/route.ts), so
the two agree; this module is the part that still holds when the voice was detached between the click and the runner.

CLAUDE.md rule 4 shapes the failure modes. A voice that may not be used stops the run (``VOICE_GATE_EXIT``); it is never swapped for
a stock voice. When the database cannot be asked, a voice id that could be a profile's (20 letters and digits) stops the run with the
remedy; only "no database configured" (nothing can be a profile without one) and "0117 is not applied" (HTTP 404: the function does
not exist, so no profile does) let it through, and each says so in the log. Rule 6: this runs before the first paid call.

A repair or a scene regeneration never reaches this module: they reuse the run's saved audio and buy no voice (0117 allows them for
the same reason, ``kind = 'repair'``).

No secret is logged, and no response body is copied into a message: a closed phrase and an HTTP status are.
"""

from __future__ import annotations

import logging
import os
import re
import time
from typing import Mapping, Optional

logger = logging.getLogger(__name__)

#: A distinct exit code so the runners release the credit hold and say why (workflow, tools/queue_worker.py), and so the step is red
#: with its own annotation. 75, 78, 79, 80 and 81 are taken (storyboard, budget, held, Gemini quota, series).
VOICE_GATE_EXIT = 82

NARRATOR_KEY = "elevenlabs_voice_id"
SECONDARY_KEY = "elevenlabs_secondary_voice_id"

#: An ElevenLabs voice id is 20 letters and digits (CLAUDE.md, known ceilings). Anything else cannot be a profile's.
_VOICE_ID = re.compile(r"[A-Za-z0-9]{20}")

#: Waits before the 2nd and 3rd attempt; the retries use a shorter timeout, so the added delay stays bounded.
RETRY_BACKOFF = (1.0, 3.0)
TIMEOUT = 10.0
RETRY_TIMEOUT = 5.0


class VoiceGateRefused(RuntimeError):
    """This run may not use the voice it was given, or the question could not be answered. The message names the remedy."""

    def __init__(self, message: str, *, reason: str):
        super().__init__(message)
        #: "not_permitted" (the database said no) or "unavailable" (it could not be asked).
        self.reason = reason


def _as_id(value) -> str:
    """The voice setting as text, the way the reader would use it. A number such as 12345678901234567890 is a possible id and the
    pipeline turns it into text; a missing setting, a boolean or a container is no id."""
    if isinstance(value, bool) or value is None:
        return ""
    if isinstance(value, (str, int)):
        return str(value)
    return ""


def could_be_profile_voice(value) -> bool:
    """Could this setting be a provider voice id (so, possibly a profile's)? Case and padding do not matter: the database compares
    the id lowercased and stripped, so a variant is the same voice."""
    return bool(_VOICE_ID.fullmatch(_as_id(value).strip()))


def _config_from_env(env: Mapping[str, str]) -> tuple[str, str]:
    return (env.get("SUPABASE_URL") or "").strip().rstrip("/"), (env.get("SUPABASE_SERVICE_KEY") or "").strip()


def _ask(url: str, key: str, channel_id: str, new: dict, *, session, sleep) -> Optional[str]:
    """One question to the database, retried on a transient failure. Returns the refused key, or None when every voice is usable.
    A missing function (HTTP 404) raises ``_NotInstalled``; a question that cannot be answered raises :class:`VoiceGateRefused`."""
    last = "no answer"
    for attempt in range(len(RETRY_BACKOFF) + 1):
        if attempt:
            sleep(RETRY_BACKOFF[attempt - 1])
        try:
            r = session.post(
                f"{url}/rest/v1/rpc/channel_voice_config_problem",
                json={"p_channel": channel_id, "p_org": None, "p_old": {}, "p_new": new},
                headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                timeout=TIMEOUT if attempt == 0 else RETRY_TIMEOUT,
            )
        except Exception as e:  # network, TLS, timeout: the type only, never the message
            last = type(e).__name__
            continue
        status = getattr(r, "status_code", 0)
        if status == 404:
            raise _NotInstalled()
        if status in (408, 429) or status >= 500:
            last = f"HTTP {status}"
            continue
        if status >= 300:
            # 401/403 (a wrong key, or the function not granted to the service role) will not heal by retrying.
            raise VoiceGateRefused(
                f"The voice ownership check was refused by the database (HTTP {status}). Check that SUPABASE_SERVICE_KEY is the "
                "service-role key and that migration 0117 is applied; then run again. Nothing was spent, and no other voice is "
                "substituted.", reason="unavailable")
        try:
            answer = r.json()
        except Exception:
            last = "unreadable answer"
            continue
        if answer is None or isinstance(answer, str):
            return answer or None
        last = "unexpected answer"
    raise VoiceGateRefused(
        f"The voice ownership check could not be completed ({last}) and this run uses a voice id that may be a custom voice. "
        "Nothing was spent, and no other voice is substituted. Check that Supabase is reachable from the runner "
        "(SUPABASE_URL and SUPABASE_SERVICE_KEY), then run again.", reason="unavailable")


class _NotInstalled(Exception):
    pass


def require_voices_usable(channel_id: str, narrator, secondary, *, env: Optional[Mapping[str, str]] = None,
                          session=None, sleep=time.sleep) -> None:
    """Raise :class:`VoiceGateRefused` unless the voices this run will speak with may be used on this channel.

    ``narrator`` is the voice the narration will use (the run's own choice, else the channel's), ``secondary`` the voice for the
    script's quoted lines (``"narrator"``, empty, or an id). Anything that cannot be a provider voice id is not asked about: it is
    not a profile's, and the existing checks (audio_mixer.verify_voice) judge it as before.
    """
    new: dict = {}
    nid = _as_id(narrator)
    if could_be_profile_voice(nid):
        new[NARRATOR_KEY] = nid
    sid = _as_id(secondary)
    if could_be_profile_voice(sid):
        new[SECONDARY_KEY] = sid
    if not new:
        return
    url, key = _config_from_env(os.environ if env is None else env)
    if not url or not key:
        # Profiles live in this database; without one nothing can be a profile. Said in the log, because it is a choice made here.
        logger.info("[channel: %s] Voice ownership check skipped: no Supabase configured, so no custom voice can exist here",
                    channel_id)
        return
    if session is None:
        import requests  # noqa: PLC0415 — keep imports light for callers that never ask

        session = requests.Session()
    try:
        refused = _ask(url, key, str(channel_id), new, session=session, sleep=sleep)
    except _NotInstalled:
        logger.warning("[channel: %s] Voice ownership check skipped: channel_voice_config_problem is not available "
                       "(migration 0117 is not applied), so no custom voice can exist yet", channel_id)
        return
    if refused is None:
        return
    slot = "second (quote) voice" if refused == SECONDARY_KEY else "narrator voice"
    raise VoiceGateRefused(
        f"This channel's {slot} is a custom voice that this run may not use: it must be approved, attached to this channel by its "
        "owner, and the owner must still administer the channel's organization. Nothing was spent, and no other voice is "
        "substituted. Ask the voice's owner to attach it again, or choose another voice for the channel or this run.",
        reason="not_permitted")


def check_run(ctx, narrator, secondary, **kw) -> None:
    """The pre-flight for one ``main.run``: the voices ``ctx`` will narrate with, when it narrates with ElevenLabs.

    ``narrator`` and ``secondary`` are what audio_mixer's ``narrator_voice`` / ``secondary_voice`` resolve for this run (the run's
    own choice, ELEVENLABS_RUN_VOICE_ID, beats the channel's). An Edge channel speaks no ElevenLabs voice, so none is asked about.
    """
    agent = getattr(ctx, "agent", None)
    if agent is None or getattr(agent, "tts_provider", "") != "elevenlabs":
        return
    require_voices_usable(str(getattr(ctx, "channel_id", "")), narrator, secondary, **kw)
