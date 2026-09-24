"""Provider balances — what is left on each paid provider account.

The cost ledger records what the pipeline *consumed*; this module records what
the provider says is still *available*, so the Command Center's Billing page can
answer "how many more minutes of narration does ElevenLabs cover?" and "which
provider runs out first?".

Only providers that expose a balance endpoint are read:

  * ElevenLabs — ``GET /v1/user/subscription`` → character_count / character_limit
    (credits), next reset, tier.
  * Leonardo   — ``GET /api/rest/v1/me`` → API paid + subscription tokens.

Every other provider has no balance API (Gemini bills through Google Cloud,
video providers through their own dashboards), so nothing is written for them
and the page shows its own top-up ledger instead — never an invented number.

Guarantees
----------
* API keys are read from the environment, sent only in the request header, and
  never logged — not even partially.
* Nothing here raises into the pipeline: a network error, an unexpected shape
  or a missing key is logged (without the key) and skipped.
* Snapshots are append-only rows in ``provider_balances`` (migration 0012), so
  the page can read the latest one and a trend if it wants.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, List, Optional

import requests

logger = logging.getLogger(__name__)

_TIMEOUT = 15

#: Below this many ElevenLabs credits an operator alert is raised — roughly one
#: 15-minute narration on multilingual_v2. Override with ELEVENLABS_LOW_CREDITS.
_DEFAULT_LOW_CREDITS = 15000


@dataclass(frozen=True)
class BalanceSnapshot:
    provider: str
    metric: str
    remaining: Optional[float]
    total: Optional[float]
    unit: str
    tier: str = ""
    resets_at: Optional[str] = None

    def to_row(self) -> dict:
        return {
            "provider": self.provider,
            "metric": self.metric,
            "remaining": self.remaining,
            "total": self.total,
            "unit": self.unit,
            "tier": self.tier or None,
            "resets_at": self.resets_at,
            "source": "api",
        }


def _num(value) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def parse_elevenlabs(data) -> Optional[BalanceSnapshot]:
    """Build a snapshot from an ElevenLabs subscription payload, or None."""
    if not isinstance(data, dict):
        return None
    used = _num(data.get("character_count"))
    limit = _num(data.get("character_limit"))
    if limit is None:
        return None
    remaining = max(0.0, limit - used) if used is not None else None
    reset = _num(data.get("next_character_count_reset_unix"))
    resets_at = (
        datetime.fromtimestamp(reset, tz=timezone.utc).isoformat() if reset and reset > 0 else None
    )
    return BalanceSnapshot(
        provider="elevenlabs",
        metric="credits",
        remaining=remaining,
        total=limit,
        unit="credits",
        tier=str(data.get("tier") or ""),
        resets_at=resets_at,
    )


def parse_leonardo(data) -> Optional[BalanceSnapshot]:
    """Build a snapshot from a Leonardo ``/me`` payload, or None."""
    if not isinstance(data, dict):
        return None
    details = data.get("user_details")
    if isinstance(details, list) and details:
        details = details[0]
    if not isinstance(details, dict):
        return None
    paid = _num(details.get("apiPaidTokens"))
    sub = _num(details.get("apiSubscriptionTokens"))
    if paid is None and sub is None:
        return None
    return BalanceSnapshot(
        provider="leonardo",
        metric="api_tokens",
        remaining=(paid or 0.0) + (sub or 0.0),
        total=None,
        unit="tokens",
    )


def _get_json(url: str, headers: dict, provider: str):
    try:
        resp = requests.get(url, headers=headers, timeout=_TIMEOUT)
    except Exception as e:  # network — never includes the key
        logger.warning("Balance check for %s errored (%s)", provider, type(e).__name__)
        return None
    if resp.status_code >= 300:
        logger.warning("Balance check for %s failed: HTTP %s", provider, resp.status_code)
        return None
    try:
        return resp.json()
    except ValueError:
        logger.warning("Balance check for %s returned non-JSON", provider)
        return None


def fetch_elevenlabs() -> Optional[BalanceSnapshot]:
    key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not key:
        return None
    data = _get_json(
        "https://api.elevenlabs.io/v1/user/subscription", {"xi-api-key": key}, "elevenlabs"
    )
    return parse_elevenlabs(data)


def fetch_leonardo() -> Optional[BalanceSnapshot]:
    key = os.getenv("LEONARDO_API_KEY", "").strip()
    if not key:
        return None
    data = _get_json(
        "https://cloud.leonardo.ai/api/rest/v1/me",
        {"Authorization": f"Bearer {key}", "accept": "application/json"},
        "leonardo",
    )
    return parse_leonardo(data)


FETCHERS: List[Callable[[], Optional[BalanceSnapshot]]] = [fetch_elevenlabs, fetch_leonardo]


def low_credit_threshold() -> float:
    raw = os.getenv("ELEVENLABS_LOW_CREDITS", "").strip()
    value = _num(raw) if raw else None
    return value if value is not None and value >= 0 else float(_DEFAULT_LOW_CREDITS)


def collect(fetchers=None) -> List[BalanceSnapshot]:
    """Run every fetcher; a failing one is skipped, never fatal."""
    out: List[BalanceSnapshot] = []
    for fetch in fetchers if fetchers is not None else FETCHERS:
        try:
            snap = fetch()
        except Exception as e:
            logger.warning("Balance fetcher %s errored (%s)", getattr(fetch, "__name__", "?"), type(e).__name__)
            continue
        if snap is not None:
            out.append(snap)
    return out


def record(sync=None, fetchers=None) -> int:
    """Collect balances and write them to Supabase. Returns rows written.

    Raises an operator alert when ElevenLabs credits fall below the threshold.
    Never raises.
    """
    try:
        snaps = collect(fetchers)
        if not snaps:
            return 0
        if sync is None:
            from modules.supabase_sync import SupabaseSync

            sync = SupabaseSync()
        written = sync.upsert("provider_balances", [s.to_row() for s in snaps])
        threshold = low_credit_threshold()
        for s in snaps:
            if s.provider == "elevenlabs" and s.remaining is not None and s.remaining < threshold:
                sync.upsert(
                    "alert_events",
                    [{
                        "kind": "provider.balance_low",
                        "severity": "warn",
                        "title": "ElevenLabs credits low",
                        "body": f"{int(s.remaining)} credits left (threshold {int(threshold)}).",
                    }],
                )
        logger.info("Provider balances: %d snapshot(s) recorded", written)
        return written
    except Exception as e:
        logger.warning("Provider balance recording failed (%s) — nothing else affected", type(e).__name__)
        return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    n = record()
    print(f"provider balances recorded: {n}")
