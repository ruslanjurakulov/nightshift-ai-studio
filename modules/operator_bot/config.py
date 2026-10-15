"""Operator bot configuration — every knob is an environment variable that is
named in .env.example and docs/operator-bot.md, and every one is optional.

Nothing here is a price. The only threshold that is about money is
ELEVENLABS_LOW_CREDITS, which already exists (modules/provider_balance.py) and
is read through that module, so the bot and the Billing page agree on what
"low" means. The rest are operational: when a job counts as stuck, how many
alerts one hour may carry, which hours are quiet.

Parsing is forgiving and fails SAFE: a malformed quiet-hours string means no
quiet hours (alerts still obey the rate limit), a malformed digest hour means no
digest, a malformed app URL means no deep links. Nothing raises.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from datetime import timezone, tzinfo
from typing import Mapping, Optional

from modules.operator_bot.i18n import DEFAULT_LANGUAGE, normalize_language

try:  # zoneinfo is stdlib on 3.9+, but the tz database may be missing.
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore

#: A running render job whose heartbeat is older than this is stuck. It is the
#: same ten minutes claim_render_job (migration 0017) waits before it re-queues
#: a dead worker's job, so "stuck" here means "the database itself considers it
#: abandoned".
STUCK_HEARTBEAT_MINUTES = 10
#: A worker that reported 'running' but not for this long has lost its
#: heartbeat. The reporter beats every 30 s and migration 0045 calls 120 s
#: stale; five minutes keeps one slow request from paging anyone.
WORKER_STALE_SECONDS = 300

DEFAULT_STUCK_MINUTES = 30
DEFAULT_MAX_ALERTS_PER_HOUR = 6

_APP_URL = re.compile(r"^https://[A-Za-z0-9](?:[A-Za-z0-9.\-]*[A-Za-z0-9])?(?::\d{1,5})?$")
_QUIET = re.compile(r"^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$")
_SECRET_TOKEN = re.compile(r"^[A-Za-z0-9_\-]{16,256}$")


def _int(raw: Optional[str], default: int, lo: int, hi: int) -> int:
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return default
    return value if lo <= value <= hi else default


def valid_app_url(raw: Optional[str]) -> Optional[str]:
    """The public origin (``https://host[:port]``, no path, no credentials), or
    None. Inline URL buttons and the site check only ever use this."""
    value = (raw or "").strip().rstrip("/")
    return value if _APP_URL.match(value) else None


def valid_secret_token(raw: Optional[str]) -> Optional[str]:
    """A webhook secret in Telegram's accepted shape (1-256 of ``A-Za-z0-9_-``);
    at least 16 here, so a one-letter secret is refused as no secret."""
    value = (raw or "").strip()
    return value if _SECRET_TOKEN.match(value) else None


def _tz(name: Optional[str]) -> tzinfo:
    name = (name or "").strip()
    if name and ZoneInfo is not None:
        try:
            return ZoneInfo(name)
        except Exception:
            pass
    return timezone.utc


def parse_quiet_hours(raw: Optional[str]) -> Optional[tuple[int, int]]:
    """``"22-7"`` -> (22, 7): quiet from 22:00 until 07:00 local time.
    ``"0-0"`` and malformed values mean no quiet hours."""
    m = _QUIET.match(raw or "")
    if not m:
        return None
    start, end = int(m.group(1)), int(m.group(2))
    if not (0 <= start <= 23 and 0 <= end <= 23) or start == end:
        return None
    return start, end


@dataclass(frozen=True)
class OperatorConfig:
    app_url: Optional[str] = None
    tz: tzinfo = timezone.utc
    quiet_hours: Optional[tuple[int, int]] = None
    digest_hour: Optional[int] = None
    stuck_minutes: int = DEFAULT_STUCK_MINUTES
    max_alerts_per_hour: int = DEFAULT_MAX_ALERTS_PER_HOUR
    github_repo: str = ""
    #: The language the bot speaks until the owner picks one with /language
    #: (OPERATOR_LANGUAGE; an unknown code falls back to the default).
    language: str = DEFAULT_LANGUAGE

    @classmethod
    def from_env(cls, environ: Optional[Mapping[str, str]] = None) -> "OperatorConfig":
        env = os.environ if environ is None else environ
        digest = env.get("OPERATOR_DIGEST_HOUR", "")
        repo = (env.get("GITHUB_REPOSITORY", "") or "").strip()
        return cls(
            app_url=valid_app_url(env.get("OPERATOR_APP_URL")),
            tz=_tz(env.get("OPERATOR_TZ")),
            quiet_hours=parse_quiet_hours(env.get("OPERATOR_QUIET_HOURS")),
            digest_hour=_int(digest, -1, 0, 23) if str(digest).strip() else None,
            stuck_minutes=_int(env.get("OPERATOR_STUCK_MINUTES"), DEFAULT_STUCK_MINUTES, 5, 24 * 60),
            max_alerts_per_hour=_int(env.get("OPERATOR_ALERT_MAX_PER_HOUR"), DEFAULT_MAX_ALERTS_PER_HOUR, 1, 60),
            language=normalize_language(env.get("OPERATOR_LANGUAGE")),
            github_repo=repo if re.fullmatch(r"[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+", repo) else "",
        )

    def __post_init__(self):
        # digest_hour of -1 came from a malformed value: treat as off.
        if self.digest_hour is not None and not (0 <= self.digest_hour <= 23):
            object.__setattr__(self, "digest_hour", None)

    def in_quiet_hours(self, now) -> bool:
        """True when ``now`` (an aware datetime) falls in the quiet window."""
        if not self.quiet_hours:
            return False
        hour = now.astimezone(self.tz).hour
        start, end = self.quiet_hours
        return (start <= hour < end) if start < end else (hour >= start or hour < end)

    def local_date(self, now) -> str:
        return now.astimezone(self.tz).strftime("%Y-%m-%d")

    def local_hour(self, now) -> int:
        return now.astimezone(self.tz).hour
