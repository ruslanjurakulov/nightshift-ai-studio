"""vidIQ HTTP transport — the network layer behind the vidIQ researcher.

`modules/vidiq.py` keeps the ranking heuristics pure and injects the fetch
through the `VidIQClient` protocol. This is the concrete adapter that protocol
expects: a token-authenticated HTTP client for vidIQ's keyword and title-score
surfaces.

Two hard guarantees, matching the rest of the integrations:

- **Off unless configured.** `make_client()` returns `None` when
  `config.VIDIQ_ENABLED` is false (no token, or the opt-in flag off), so the
  researcher stays a no-op and the advisory card is honestly empty rather than
  full of fabricated numbers. The token is read from config, never hard-coded,
  and never logged.
- **It never breaks a pass.** Every failure (auth, quota, a network blip, an
  unexpected response shape) is caught, logged without the token, and returns
  `[]` / `None` — vidIQ is advisory, so a bad fetch recommends nothing rather
  than raising into the poller.

The base URL, endpoint paths and response field names come from `config` (env
vars), because vidIQ's API can be revised; adjust them by env, not by code.
"""

from __future__ import annotations

import logging
from typing import Optional

import requests

import config

logger = logging.getLogger(__name__)

# Response field names, localized so they track vidIQ's schema without touching
# the flow. Each metric stays None when vidIQ doesn't return it — never a
# fabricated 0 (modules/vidiq.py depends on that distinction).
_TERM_KEYS = ("term", "keyword", "query", "text")
_VOLUME_KEYS = ("search_volume", "volume", "searchVolume", "monthly_searches")
_COMPETITION_KEYS = ("competition", "competition_score", "competitionScore")
_RELATED_KEYS = ("related", "related_terms", "relatedQueries")
_SCORE_KEYS = ("score", "title_score", "titleScore", "overall")


def _first(data: dict, keys: tuple) -> object:
    for k in keys:
        if k in data and data[k] is not None:
            return data[k]
    return None


class VidIQHttpClient:
    """Token-authenticated vidIQ client. Returns [] / None on any failure so an
    advisory pass never raises. Implements the `VidIQClient` protocol."""

    def __init__(
        self,
        token: str,
        *,
        base_url: Optional[str] = None,
        keywords_path: Optional[str] = None,
        title_score_path: Optional[str] = None,
        timeout: Optional[float] = None,
        session: Optional[requests.Session] = None,
    ):
        self._token = token
        self._base = (base_url or config.VIDIQ_BASE_URL).rstrip("/")
        self._keywords_path = keywords_path or config.VIDIQ_KEYWORDS_PATH
        self._title_score_path = title_score_path or config.VIDIQ_TITLE_SCORE_PATH
        self._timeout = timeout if timeout is not None else config.VIDIQ_TIMEOUT
        self._session = session or requests.Session()

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/json",
        }

    def _get(self, path: str, params: dict) -> Optional[object]:
        """One GET, returning parsed JSON or None. Never raises; never logs the
        token (only the path and status)."""
        url = f"{self._base}{path}"
        try:
            resp = self._session.get(url, headers=self._headers(), params=params, timeout=self._timeout)
        except requests.RequestException as exc:
            logger.warning("vidIQ request to %s failed: %s", path, type(exc).__name__)
            return None
        if resp.status_code != 200:
            logger.warning("vidIQ %s returned HTTP %s", path, resp.status_code)
            return None
        try:
            return resp.json()
        except ValueError:
            logger.warning("vidIQ %s returned a non-JSON body", path)
            return None

    @staticmethod
    def _rows(payload: object) -> list:
        """Pull the list of result rows out of the common response shapes."""
        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict):
            for key in ("keywords", "results", "data", "items"):
                value = payload.get(key)
                if isinstance(value, list):
                    return value
        return []

    def keyword_research(self, seed: str) -> list:
        """Return raw keyword dicts for `seed` (vidiq.py coerces them into
        Keyword). [] on any failure or when the seed is empty."""
        seed = (seed or "").strip()
        if not seed:
            return []
        payload = self._get(self._keywords_path, {"query": seed})
        rows: list = []
        for row in self._rows(payload):
            if not isinstance(row, dict):
                continue
            related = _first(row, _RELATED_KEYS)
            rows.append({
                "term": _first(row, _TERM_KEYS) or seed,
                "search_volume": _first(row, _VOLUME_KEYS),
                "competition": _first(row, _COMPETITION_KEYS),
                "related": tuple(related) if isinstance(related, (list, tuple)) else (),
            })
        return rows

    def score_title(self, title: str) -> Optional[float]:
        """Return vidIQ's title score (0–100) for `title`, or None when
        unavailable — None keeps the title unranked rather than worst-ranked."""
        title = (title or "").strip()
        if not title:
            return None
        payload = self._get(self._title_score_path, {"title": title})
        if not isinstance(payload, dict):
            return None
        raw = _first(payload, _SCORE_KEYS)
        if raw is None:
            return None
        try:
            return float(raw)
        except (TypeError, ValueError):
            return None


def is_enabled() -> bool:
    """True only when a token is present AND the operator opted in."""
    return bool(getattr(config, "VIDIQ_ENABLED", False))


def make_client() -> Optional[VidIQHttpClient]:
    """A configured vidIQ client, or None when the integration is off — the
    researcher treats None as 'disabled' and stays a no-op."""
    if not is_enabled():
        return None
    token = getattr(config, "VIDIQ_ACCESS_TOKEN", "")
    if not token:
        return None
    return VidIQHttpClient(token)
