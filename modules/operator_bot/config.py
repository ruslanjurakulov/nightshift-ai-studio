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

The one exception is the film spend watch (NIGHTSHIFT_FILM_SPEND_WARN_USD and
NIGHTSHIFT_FILM_SPEND_STOP_USD): they are the lines in front of a paid film's hard
cap, so a typo must not quietly become the default, which may be far above what
the owner meant. ``from_env`` still never raises (other callers, such as the
schedule catch-up, only need the rest), but it records the refusal in
``film_spend_error``; the alert pass refuses to start on it
(tools/run_operator_alerts.py) and /health says why.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from decimal import Decimal
from datetime import timezone, tzinfo
from typing import Mapping, Optional

from modules.operator_bot.i18n import DEFAULT_LANGUAGE, normalize_language
from modules import pipeline_pause

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
#: Hours after a channel's publish hour (UTC) by which its video must exist, or
#: the dead-man alert fires (modules/operator_bot/reliability.py). One run is at
#: most an hour of render plus queueing behind another channel, and GitHub's
#: hourly schedule is observed to fire late, so three hours separates "late"
#: from "not coming" without waiting until the next day.
DEFAULT_DEADMAN_HOURS = 3
MAX_DEADMAN_HOURS = 12

#: The film spend watch (modules/operator_bot/alerts.py, ``film:spend:*``): a warning at this much measured vendor USD
#: on one film, and "stop it by hand now" at the second. Both well inside the owner's USD 10 hard cap for the paid test
#: film, because the sum only grows when a take ends and records its cost: the take in flight is not in it yet.
FILM_SPEND_WARN_ENV = "NIGHTSHIFT_FILM_SPEND_WARN_USD"
FILM_SPEND_STOP_ENV = "NIGHTSHIFT_FILM_SPEND_STOP_USD"
DEFAULT_FILM_SPEND_WARN_USD = Decimal("6")
DEFAULT_FILM_SPEND_STOP_USD = Decimal("8")
#: Dollars and cents, nothing else: no sign, no exponent, no "inf"/"nan", no currency symbol.
_USD = re.compile(r"^\d{1,5}(?:\.\d{1,2})?$")

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


def parse_deadman_hours(raw: Optional[str]) -> Optional[int]:
    """``"3"`` -> 3; ``"off"`` -> None (switched off); empty or malformed -> the default."""
    text = str(raw or "").strip().lower()
    if text == "off":
        return None
    return _int(text, DEFAULT_DEADMAN_HOURS, 1, MAX_DEADMAN_HOURS) if text else DEFAULT_DEADMAN_HOURS


#: Why a film spend line is refused, as closed words (the copy tables word them in en/ru/uz).
FILM_SPEND_REASONS = {
    "not_usd": "is not an amount of US dollars (write it like 6 or 6.50)",
    "not_positive": "must be above 0",
    "not_below_stop": f"must be below {FILM_SPEND_STOP_ENV}",
}


class FilmSpendConfigError(ValueError):
    """A film spend threshold the watch refuses to run with: ``variable`` names it and ``reason`` is one of
    FILM_SPEND_REASONS. The message never repeats the value (the owner's typo is not a secret, but nothing gains from
    echoing it)."""

    def __init__(self, variable: str, reason: str):
        self.variable, self.reason = variable, reason
        super().__init__(f"{variable} {FILM_SPEND_REASONS[reason]}")


def _usd_line(env: Mapping[str, str], name: str, default: Decimal) -> Decimal:
    raw = str(env.get(name, "") or "").strip()
    if not raw:
        return default
    if not _USD.match(raw):
        raise FilmSpendConfigError(name, "not_usd")
    value = Decimal(raw)  # the pattern admits only plain decimals, which Decimal always reads
    if value <= 0:
        raise FilmSpendConfigError(name, "not_positive")
    return value


def parse_film_spend_thresholds(environ: Optional[Mapping[str, str]] = None) -> tuple[Decimal, Decimal]:
    """(warn, stop) in USD from NIGHTSHIFT_FILM_SPEND_WARN_USD / NIGHTSHIFT_FILM_SPEND_STOP_USD; empty or unset is the
    default (6 and 8). Raises FilmSpendConfigError naming the variable for anything else: a malformed line is a
    refusal, never a silent default (CLAUDE.md #4, #6)."""
    env = os.environ if environ is None else environ
    warn = _usd_line(env, FILM_SPEND_WARN_ENV, DEFAULT_FILM_SPEND_WARN_USD)
    stop = _usd_line(env, FILM_SPEND_STOP_ENV, DEFAULT_FILM_SPEND_STOP_USD)
    if warn >= stop:
        raise FilmSpendConfigError(FILM_SPEND_WARN_ENV, "not_below_stop")
    return warn, stop


@dataclass(frozen=True)
class OperatorConfig:
    app_url: Optional[str] = None
    tz: tzinfo = timezone.utc
    quiet_hours: Optional[tuple[int, int]] = None
    digest_hour: Optional[int] = None
    stuck_minutes: int = DEFAULT_STUCK_MINUTES
    max_alerts_per_hour: int = DEFAULT_MAX_ALERTS_PER_HOUR
    github_repo: str = ""
    #: The dead-man grace in hours (OPERATOR_DEADMAN_HOURS), or None when the owner switched
    #: it off with the value ``off``. A malformed value keeps the default: a typo must not
    #: silence the one alert that fires on silence.
    deadman_hours: Optional[int] = DEFAULT_DEADMAN_HOURS
    #: The owner paused the scheduled pipeline (NIGHTSHIFT_PIPELINE_PAUSED). Read through the scheduler's own
    #: function (modules/pipeline_pause.py), so the two agree on every value, a typo included: while it is on, a
    #: slot with no video is not silence (no dead-man alert, "paused" instead of MISSING), and one information
    #: alert a day says the pause is still on. The bot sees its own environment: the fallback workflows read the
    #: repository variable on every pass, the always-on service reads it at deploy time.
    pipeline_paused: bool = False
    #: The language the bot speaks until the owner picks one with /language
    #: (OPERATOR_LANGUAGE; an unknown code falls back to the default).
    language: str = DEFAULT_LANGUAGE
    #: The film spend watch's two lines, USD (parse_film_spend_thresholds).
    film_spend_warn_usd: Decimal = DEFAULT_FILM_SPEND_WARN_USD
    film_spend_stop_usd: Decimal = DEFAULT_FILM_SPEND_STOP_USD
    #: Why the watch refused its configuration ("" = it did not): the variable's name and what it must be. While it is
    #: set no spend alert is raised from the defaults, the alert pass refuses to start, and /health says so.
    film_spend_error: str = ""
    #: The same refusal as (variable, reason of FILM_SPEND_REASONS), for /health in the owner's language.
    film_spend_refusal: tuple = ()

    @classmethod
    def from_env(cls, environ: Optional[Mapping[str, str]] = None) -> "OperatorConfig":
        env = os.environ if environ is None else environ
        digest = env.get("OPERATOR_DIGEST_HOUR", "")
        repo = (env.get("GITHUB_REPOSITORY", "") or "").strip()
        try:
            warn, stop, spend_error, refusal = (*parse_film_spend_thresholds(env), "", ())
        except FilmSpendConfigError as e:
            warn, stop, spend_error, refusal = (DEFAULT_FILM_SPEND_WARN_USD, DEFAULT_FILM_SPEND_STOP_USD, str(e),
                                                (e.variable, e.reason))
        return cls(
            app_url=valid_app_url(env.get("OPERATOR_APP_URL")),
            tz=_tz(env.get("OPERATOR_TZ")),
            quiet_hours=parse_quiet_hours(env.get("OPERATOR_QUIET_HOURS")),
            digest_hour=_int(digest, -1, 0, 23) if str(digest).strip() else None,
            stuck_minutes=_int(env.get("OPERATOR_STUCK_MINUTES"), DEFAULT_STUCK_MINUTES, 5, 24 * 60),
            max_alerts_per_hour=_int(env.get("OPERATOR_ALERT_MAX_PER_HOUR"), DEFAULT_MAX_ALERTS_PER_HOUR, 1, 60),
            language=normalize_language(env.get("OPERATOR_LANGUAGE")),
            deadman_hours=parse_deadman_hours(env.get("OPERATOR_DEADMAN_HOURS")),
            pipeline_paused=pipeline_pause.pipeline_paused(env),
            github_repo=repo if re.fullmatch(r"[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+", repo) else "",
            film_spend_warn_usd=warn, film_spend_stop_usd=stop, film_spend_error=spend_error,
            film_spend_refusal=refusal,
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
