"""Credential health check — run it BEFORE a scheduled run spends anything.

A run costs Gemini calls, a Pexels quota, TTS characters and (at the end) a
YouTube upload. If a key is missing, the honest place to find out is the top of
the run, not three paid stages in. This gathers a single, safe-to-log report of
which credentials a run needs and whether they are present, so a scheduler can
skip a doomed run and a human can see exactly what to fix.

What it does NOT do
-------------------
* It never prints a secret — only presence/absence and our own detail strings.
* It never makes a network call — presence here means "a key is configured",
  not "the key is valid" (verify_voice already does the one live TTS probe; a
  live check of every service would itself cost quota). An unknown is reported
  as unknown, never as a pass.
* It is advisory by default: it reports and emits an event; whether a run aborts
  on a missing credential is the caller's decision, exactly as the pipeline
  already tolerates a missing publish token by skipping the upload.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


class CredentialsMissing(RuntimeError):
    """A key the run cannot do without is not configured. Raised by main.py at
    the top of the run, before anything is spent (CLAUDE.md rule 6)."""


OK = "ok"
MISSING = "missing"
UNKNOWN = "unknown"


@dataclass(frozen=True)
class CredentialCheck:
    """One credential's state. `required` marks a key the run cannot proceed
    without at all (Gemini); `required_for_publish` marks one only the upload
    needs (the YouTube token) — a --no-upload run is fine without it."""

    name: str
    status: str                       # ok | missing | unknown
    required: bool = False
    required_for_publish: bool = False
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.status == OK

    def to_dict(self) -> dict:
        return {
            "name": self.name, "status": self.status, "required": self.required,
            "required_for_publish": self.required_for_publish, "detail": self.detail,
        }


@dataclass(frozen=True)
class HealthReport:
    channel_id: str
    checks: tuple = field(default_factory=tuple)

    @property
    def blocking(self) -> list:
        """Required credentials that are not OK — a run should not start."""
        return [c for c in self.checks if c.required and not c.ok]

    @property
    def publish_blocking(self) -> list:
        """Credentials the upload needs that are not OK — the run can still
        render (and be held for review), it just can't publish."""
        return [c for c in self.checks if c.required_for_publish and not c.ok]

    @property
    def ok(self) -> bool:
        """True when nothing REQUIRED is missing. A missing publish token does
        not make the report not-ok — the run can render and hold for review."""
        return not self.blocking

    def to_dict(self) -> dict:
        return {
            "channel_id": self.channel_id,
            "ok": self.ok,
            "blocking": [c.name for c in self.blocking],
            "publish_blocking": [c.name for c in self.publish_blocking],
            "checks": [c.to_dict() for c in self.checks],
        }


def _present(value: Optional[str]) -> bool:
    return bool((value or "").strip())


def check_run_credentials(channel=None, *, tts_provider: Optional[str] = None) -> HealthReport:
    """Build the credential report for a run on `channel`. Never raises — a
    check that can't be evaluated is reported as 'unknown', not a pass.

    `tts_provider` overrides the channel's configured provider (so a caller can
    check the provider a run will actually use); when None, the channel's own
    setting is read, falling back to the global config default.
    """
    import config as cfg

    checks: list[CredentialCheck] = []
    channel_id = "default"
    try:
        channel_id = str(getattr(channel, "channel_id", None) or "default")
    except Exception:
        pass

    # Gemini — every run needs it for the script; without it the run cannot work.
    checks.append(CredentialCheck(
        name="gemini", required=True,
        status=OK if _present(getattr(cfg, "GEMINI_API_KEY", "")) else MISSING,
        detail="" if _present(getattr(cfg, "GEMINI_API_KEY", "")) else "Set GEMINI_API_KEY.",
    ))

    # Pexels — needed for the b-roll. Required: a run with no footage is not a
    # video worth publishing.
    checks.append(CredentialCheck(
        name="pexels", required=True,
        status=OK if _present(getattr(cfg, "PEXELS_API_KEY", "")) else MISSING,
        detail="" if _present(getattr(cfg, "PEXELS_API_KEY", "")) else "Set PEXELS_API_KEY.",
    ))

    # ElevenLabs — required ONLY when this run narrates with it. An edge run
    # needs no key, so it isn't flagged then.
    provider = (tts_provider or _channel_tts(channel) or getattr(cfg, "TTS_PROVIDER", "edge") or "edge").lower()
    if provider == "elevenlabs":
        has_key = _present(getattr(cfg, "ELEVENLABS_API_KEY", ""))
        checks.append(CredentialCheck(
            name="elevenlabs", required=True,
            status=OK if has_key else MISSING,
            detail="" if has_key else "This channel narrates with ElevenLabs but ELEVENLABS_API_KEY is unset.",
        ))

    # YouTube publish token — needed only to upload. A --no-upload / auto-publish
    # -off run renders fine without it, so it blocks publishing, not the run.
    checks.append(_youtube_check(channel))

    return HealthReport(channel_id=channel_id, checks=tuple(checks))


def _channel_tts(channel) -> Optional[str]:
    try:
        agent = getattr(channel, "agent", None)
        return getattr(agent, "tts_provider", None) if agent is not None else None
    except Exception:
        return None


def _youtube_check(channel) -> CredentialCheck:
    """Presence of a usable YouTube publish token for this channel, via the
    existing credential_status(). Reported as required_for_publish only."""
    try:
        from modules.channel_credentials import credential_status

        if channel is None:
            return CredentialCheck(
                name="youtube_token", required_for_publish=True, status=UNKNOWN,
                detail="No channel context — token presence not evaluated.",
            )
        status = credential_status(channel)
        connected = getattr(status, "is_connected", False)
        return CredentialCheck(
            name="youtube_token", required_for_publish=True,
            status=OK if connected else MISSING,
            detail="" if connected else (getattr(status, "detail", "") or "No usable YouTube token."),
        )
    except Exception as e:
        logger.warning("YouTube credential check failed (%s: %s)", type(e).__name__, e)
        return CredentialCheck(
            name="youtube_token", required_for_publish=True, status=UNKNOWN,
            detail=f"Could not evaluate: {type(e).__name__}.",
        )
