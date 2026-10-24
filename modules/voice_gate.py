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

Two different failures, two different answers
---------------------------------------------
* The database ANSWERED "not allowed": the run stops, always (``VOICE_GATE_EXIT``). It is never swapped for a stock voice
  (CLAUDE.md rule 4).
* The database COULD NOT ANSWER (unreachable, timeout, 429, 5xx, 401/403, a redirect, an unreadable or odd body, no Supabase
  configured): by default the run CONTINUES, with a closed-word warning in the log and a ``::warning::`` annotation on Actions. The
  repository's own rule for a Supabase outage is to degrade (the channel registry falls back, the slot guard fails open), and today
  the gate protects nothing the outage could cost: the clone request is granted to nobody, so no custom voice can exist.
  With ``NIGHTSHIFT_VOICE_GATE_STRICT`` on, "could not answer" stops the run instead (``VOICE_GATE_UNAVAILABLE_EXIT``), after more
  tries. The owner turns the switch on TOGETHER WITH the grant that lets users clone a voice (docs/CUSTOM_VOICE.md): from then on a
  silent outage would be a way to use someone's voice unchecked.
* "The function does not exist" (PostgREST ``PGRST202`` or Postgres ``42883``, and only those) means 0117 is not applied, so no
  profile can exist: the run continues, with a warning. Any other 404 is "could not answer".

A voice id equal to the deployment's configured defaults (``config.ELEVENLABS_VOICE_ID`` / ``ELEVENLABS_SECONDARY_VOICE_ID``) is not
asked about at all: a clone's id comes from a clone request, so it can never be one of them, and the default narrator is on every run.

Rule 6: this runs before the first paid call.

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

#: Distinct exit codes so the runners release the credit hold and say why (workflow, tools/queue_worker.py, render_error), and so the
#: step is red with its own annotation. 82: the database said "not allowed". 83: it could not be asked (only with the strict switch
#: on). 75, 78, 79, 80 and 81 are taken (storyboard, budget, held, Gemini quota, series).
VOICE_GATE_EXIT = 82
VOICE_GATE_UNAVAILABLE_EXIT = 83

#: Off unless on (``on``/``1``/``true``/``yes``). The owner turns it on with the grant that lets users clone a voice (docs/CUSTOM_VOICE.md).
STRICT_ENV = "NIGHTSHIFT_VOICE_GATE_STRICT"

NARRATOR_KEY = "elevenlabs_voice_id"
SECONDARY_KEY = "elevenlabs_secondary_voice_id"

#: An ElevenLabs voice id is 20 letters and digits (CLAUDE.md, known ceilings). Anything else cannot be a profile's.
_VOICE_ID = re.compile(r"[A-Za-z0-9]{20}")

#: The answers that mean "this function does not exist here" (PostgREST's PGRST202, Postgres's 42883), the same two the Run-now route
#: accepts. Any other error, a 404 included, is "could not answer".
_FUNCTION_ABSENT = ("PGRST202", "42883")

#: (waits before the 2nd, 3rd attempt; timeout of the 1st attempt; timeout of the retries). Lenient (the default): two tries and about
#: five seconds at most, because an outage must not hold up a run that is not at risk. Strict: three tries, as the lookups of the
#: channel token do.
_LENIENT = ((0.5,), 2.5, 2.5)
_STRICT = ((1.0, 3.0), 10.0, 5.0)
RETRY_BACKOFF = _STRICT[0]    # kept for callers and tests that name the strict schedule


class VoiceGateRefused(RuntimeError):
    """This run may not use the voice it was given (``not_permitted``), or, with the strict switch on, the question could not be
    answered (``unavailable``). The message names the remedy."""

    def __init__(self, message: str, *, reason: str):
        super().__init__(message)
        self.reason = reason

    @property
    def exit_code(self) -> int:
        return VOICE_GATE_UNAVAILABLE_EXIT if self.reason == "unavailable" else VOICE_GATE_EXIT


class _CouldNotAnswer(Exception):
    """Internal: the database was not able to say. ``phrase`` is a closed word or an HTTP status, never a body."""

    def __init__(self, phrase: str):
        super().__init__(phrase)
        self.phrase = phrase


class _NotInstalled(Exception):
    pass


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


def strict_on(env: Optional[Mapping[str, str]] = None) -> bool:
    return str((os.environ if env is None else env).get(STRICT_ENV) or "").strip().lower() in ("1", "true", "yes", "on")


def _defaults() -> tuple:
    """The voices the deployment itself configures (repo variables, else the built-in narrator): never a clone's id."""
    import config  # noqa: PLC0415 — only when a run asks

    return (getattr(config, "ELEVENLABS_VOICE_ID", ""), getattr(config, "ELEVENLABS_SECONDARY_VOICE_ID", ""))


def _config_from_env(env: Mapping[str, str]) -> tuple[str, str]:
    return (env.get("SUPABASE_URL") or "").strip().rstrip("/"), (env.get("SUPABASE_SERVICE_KEY") or "").strip()


def _annotate(env: Mapping[str, str], level: str, title: str, message: str) -> None:
    """A GitHub Actions workflow command, so the skip shows on the run's summary and not only in its log. Fixed text, one line."""
    if str(env.get("GITHUB_ACTIONS") or "").strip().lower() == "true":
        print(f"::{level} title={title}::{message}", flush=True)


def _ask(url: str, key: str, channel_id: str, new: dict, *, session, sleep, strict: bool) -> Optional[str]:
    """One question to the database, retried on a transient failure. Returns the refused key, or None when every voice is usable.
    A missing function raises ``_NotInstalled``; a question that cannot be answered raises ``_CouldNotAnswer``."""
    backoff, first_timeout, retry_timeout = _STRICT if strict else _LENIENT
    last = "no answer"
    for attempt in range(len(backoff) + 1):
        if attempt:
            sleep(backoff[attempt - 1])
        try:
            r = session.post(
                f"{url}/rest/v1/rpc/channel_voice_config_problem",
                json={"p_channel": channel_id, "p_org": None, "p_old": {}, "p_new": new},
                headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                timeout=first_timeout if attempt == 0 else retry_timeout,
                # A redirect would carry the service key to wherever it points, and a "null" from there would read as ALLOW.
                allow_redirects=False,
            )
        except Exception as e:  # network, TLS, timeout: the type only, never the message
            last = type(e).__name__
            continue
        status = getattr(r, "status_code", 0)
        if 300 <= status < 400:
            raise _CouldNotAnswer(f"HTTP {status} redirect")
        if status >= 400:
            code = ""
            try:
                body = r.json()
                code = str(body.get("code") or "") if isinstance(body, dict) else ""
            except Exception:
                pass
            if code in _FUNCTION_ABSENT:
                raise _NotInstalled()
            if status in (408, 429) or status >= 500:
                last = f"HTTP {status}"
                continue
            # 401/403 (a wrong key, or the function not granted to the service role) and any other 4xx will not heal by retrying.
            raise _CouldNotAnswer(f"HTTP {status}")
        if status != 200:
            raise _CouldNotAnswer(f"HTTP {status}")
        try:
            answer = r.json()
        except Exception:
            last = "unreadable answer"
            continue
        if answer is None or isinstance(answer, str):
            return answer or None
        last = "unexpected answer"
    raise _CouldNotAnswer(last)


def _could_not_answer(channel_id, phrase: str, *, strict: bool, env: Mapping[str, str]) -> None:
    """Strict: stop. Otherwise say so loudly and let the run go on."""
    if strict:
        raise VoiceGateRefused(
            f"The voice ownership check could not be completed ({phrase}) and this run uses a voice id that may be a custom voice, "
            f"and {STRICT_ENV} is on. Nothing was spent, and no other voice is substituted. Check that Supabase is reachable from "
            "the runner (SUPABASE_URL and SUPABASE_SERVICE_KEY), then run again.", reason="unavailable")
    logger.warning("[channel: %s] Voice ownership check could NOT be completed (%s); continuing, because %s is off and no custom "
                   "voice can exist until users are allowed to clone a voice", channel_id, phrase, STRICT_ENV)
    _annotate(env, "warning", "Custom voice check skipped",
              f"The custom-voice ownership check could not be completed ({phrase}) and was skipped; the run continues. "
              f"Set {STRICT_ENV} to stop runs instead.")


def require_voices_usable(channel_id: str, narrator, secondary, *, env: Optional[Mapping[str, str]] = None,
                          session=None, sleep=time.sleep, defaults: Optional[tuple] = None) -> None:
    """Raise :class:`VoiceGateRefused` unless the voices this run will speak with may be used on this channel.

    ``narrator`` is the voice the narration will use (the run's own choice, else the channel's), ``secondary`` the voice for the
    script's quoted lines (``"narrator"``, empty, or an id). Anything that cannot be a provider voice id is not asked about: it is
    not a profile's, and the existing checks (audio_mixer.verify_voice) judge it as before. Nor is a voice equal to a configured
    default (``defaults``, else config's): see the module docstring.
    """
    env = os.environ if env is None else env
    configured = {_as_id(d).strip().lower() for d in (defaults if defaults is not None else _defaults()) if _as_id(d).strip()}
    new: dict = {}
    for key, value in ((NARRATOR_KEY, narrator), (SECONDARY_KEY, secondary)):
        vid = _as_id(value)
        if could_be_profile_voice(vid) and vid.strip().lower() not in configured:
            new[key] = vid
    if not new:
        return
    strict = strict_on(env)
    url, key = _config_from_env(env)
    if not url or not key:
        _could_not_answer(channel_id, "no Supabase configured", strict=strict, env=env)
        return
    if session is None:
        import requests  # noqa: PLC0415 — keep imports light for callers that never ask

        session = requests.Session()
    try:
        refused = _ask(url, key, str(channel_id), new, session=session, sleep=sleep, strict=strict)
    except _NotInstalled:
        logger.warning("[channel: %s] Voice ownership check skipped: channel_voice_config_problem is not available "
                       "(migration 0117 is not applied), so no custom voice can exist yet", channel_id)
        _annotate(env, "warning", "Custom voice check skipped",
                  "channel_voice_config_problem does not exist (migration 0117 is not applied), so no custom voice can exist yet.")
        return
    except _CouldNotAnswer as e:
        _could_not_answer(channel_id, e.phrase, strict=strict, env=env)
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
