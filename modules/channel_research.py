"""Channel research — the worker's side of migration 0202.

A person pressed Refresh (or added a competitor) on ``/{channel}/research``, or the Studio chat called the writer for them; the
database wrote one ``research_requests`` row and stopped (rule 3). The queue worker (``tools/queue_worker.py``) claims those rows
with the service key and hands each to :func:`process_request`, the only place this feature calls YouTube:

* ``own_channel``: the channel's OWN token (``credentials``, which the worker builds on ``youtube_publish_credentials``: resolved
  as a render run resolves it, in memory) refreshes an access token; ``channels.list mine=true`` (1 unit), the uploads playlist
  (``playlistItems.list``, 1 unit) and their statistics (``videos.list``, 1 unit), and one YouTube Analytics ``reports.query`` for
  the last 28 days (views, estimatedMinutesWatched, subscribersGained, subscribersLost; the Analytics API's own quota, not the
  Data API's). No token is ``not_connected``: nothing is asked of YouTube to find out.
* ``competitors``: every pending reference is resolved with ``channels.list`` (``forHandle`` for an @handle, 1 unit each;
  ``id`` for UC… ids, batched with the statistics refresh, 1 unit per 50) and becomes ``resolved`` or ``not_found``; the
  statistics and the newest 20 uploads of every resolved competitor are fetched again when they are older than an hour.
* ``topic``: ``search.list type=channel maxResults=10`` (YouTube's own search bucket: counted as ``research_search``), then the
  channels' statistics in one ``channels.list`` (1 unit).

Public calls use the platform's API key (``YOUTUBE_DATA_API_KEY``), sent as the ``X-Goog-Api-Key`` header so it is never part of
a URL that an exception could quote. A missing key ends the request ``failed`` / ``not_configured`` and the page names the secret.

Every call is counted BEFORE it is made (``youtube_quota_take`` with the research sources, migration 0202): 1,500 shared units and
30 search calls a Pacific day project-wide, three searches per organization. A refused take ends the request
``budget_exhausted``; what was already stored stays (it is real, and dated).

Errors are closed words (``ERROR_WORDS``, the same list as ``research_error_words()``): ``quota`` (YouTube's own daily quota is
spent: wait for midnight Pacific) and ``auth`` (the server's key was refused: the operator fixes the secret) have opposite remedies
even when YouTube answers both with HTTP 403, so they are told apart by the error's reason, never by the status (rule 6). Nothing
here logs or stores a key, a token, a response body or a provider's message.

The numbers are stored exactly as the API gave them. A hidden subscriber count is ``None`` with ``subscribers_hidden``; a count
the API left out is ``None``, never 0 (rule 5). Nothing is derived from them.
"""

from __future__ import annotations

import logging
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, Iterable, List, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

API_KEY_ENV = "YOUTUBE_DATA_API_KEY"
DATA_API = "https://www.googleapis.com/youtube/v3"
ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2/reports"
#: Only Google's token endpoint ever receives a refresh token from here, whatever a token file says its token_uri is.
TOKEN_URI = "https://oauth2.googleapis.com/token"

#: The closed error words; tests/test_channel_research.py pins this equal to 0202's research_error_words().
ERROR_WORDS = (
    "not_configured", "quota", "auth", "not_found", "scope_missing", "token_expired", "channel_mismatch",
    "rate_limited", "platform_error", "budget", "not_connected", "interrupted", "worker_error",
)

#: Per-method costs, https://developers.google.com/youtube/v3/determine_quota_cost (read 2026-11-21): the list methods are 1 unit
#: each from the shared bucket; search.list is counted in its own bucket (calls, not units). Confirm in Cloud Console → Quotas.
UNITS_LIST = 1
#: The approved caps (CLAUDE.md "Known ceilings"): research takes at most this much of the shared 10,000 a day.
DAILY_UNITS = 1500
DAILY_SEARCHES = 30
ORG_DAILY_SEARCHES = 3
#: One organization's share of the 1,500 a day, so a single tenant cannot spend every other tenant's research day.
ORG_DAILY_UNITS = 300
#: What one search.list call also takes from the SHARED units (``RESEARCH_SEARCH_SHARED_UNITS``, 0..100, default 0). The current
#: determine_quota_cost page puts search.list in its own bucket; confirm in Cloud Console → Quotas, and if search.list draws from
#: the shared 10,000, set this to 100.
SEARCH_SHARED_UNITS_ENV = "RESEARCH_SEARCH_SHARED_UNITS"
#: Statistics newer than this are not fetched again (a new competitor's request must not re-buy the other nineteen).
STALE_SECONDS = 3600
UPLOADS_PER_CHANNEL = 20
TOPIC_RESULTS = 10
ANALYTICS_DAYS = 28
#: The purge is cheap but needs no more than this often; the readers ignore old rows anyway.
PURGE_EVERY_SECONDS = 600

SOURCE_UNITS = "research"
SOURCE_SEARCH = "research_search"

_QUOTA = {"quotaExceeded", "dailyLimitExceeded", "dailyLimitExceededUnreg", "RATE_LIMIT_EXCEEDED_QUOTA"}
_RATE = {"rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED"}
_KEY = {"keyInvalid", "keyExpired", "API_KEY_INVALID", "API_KEY_SERVICE_BLOCKED", "accessNotConfigured", "SERVICE_DISABLED",
        "ipRefererBlocked", "API_KEY_HTTP_REFERRER_BLOCKED", "API_KEY_IP_ADDRESS_BLOCKED", "badRequest_keyInvalid"}
_SCOPE = {"insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "forbidden"}
_GONE = {"channelNotFound", "playlistNotFound", "videoNotFound", "notFound"}

_UC = re.compile(r"^UC[A-Za-z0-9_-]{22}$")
_VIDEO = re.compile(r"^[A-Za-z0-9_-]{11}$")
_PLAYLIST = re.compile(r"^[A-Za-z0-9_-]{2,64}$")


class Stop(Exception):
    """End a request: ``status`` (failed | budget_exhausted | not_connected) and a closed word, never a provider's text."""

    def __init__(self, status: str, code: str, http: int = 0):
        super().__init__(code)
        self.status = status if status in ("failed", "budget_exhausted", "not_connected") else "failed"
        self.code = code if code in ERROR_WORDS else "worker_error"
        #: The HTTP status YouTube answered (0: none), so a caller can tell one bad lookup from a broken day.
        self.http = int(http or 0)


def failed(code: str) -> Stop:
    return Stop("failed", code)


def budget() -> Stop:
    return Stop("budget_exhausted", "budget")


# ── errors ───────────────────────────────────────────────────────────────────


def _reasons(body) -> List[str]:
    """Every reason word a Google error body carries (v3 ``errors[].reason`` and the newer ``details[].reason``/``status``)."""
    out: List[str] = []
    err = body.get("error") if isinstance(body, Mapping) else None
    if not isinstance(err, Mapping):
        return out
    for e in err.get("errors") or []:
        if isinstance(e, Mapping) and isinstance(e.get("reason"), str):
            out.append(e["reason"])
    for d in err.get("details") or []:
        if isinstance(d, Mapping) and isinstance(d.get("reason"), str):
            out.append(d["reason"])
    if isinstance(err.get("status"), str):
        out.append(err["status"])
    return out


def error_word(status_code: int, body, *, oauth: bool = False) -> str:
    """The closed word for a failed call. The REASON decides, never the status alone: a spent quota and a refused key are both
    HTTP 403 and need opposite fixes."""
    reasons = set(_reasons(body))
    if reasons & _QUOTA:
        return "quota"
    if reasons & _RATE or status_code == 429:
        return "rate_limited"
    if reasons & _KEY:
        return "auth"
    if oauth and (status_code == 401 or "invalid_grant" in reasons or "UNAUTHENTICATED" in reasons):
        return "token_expired"
    if oauth and (reasons & _SCOPE or status_code == 403):
        return "scope_missing"
    if status_code == 401:
        return "auth"
    if reasons & _GONE or status_code == 404:
        return "not_found"
    if status_code >= 500:
        return "platform_error"
    # Any other 400 is about the request (a malformed handle, say), not the key: a key problem names itself in _KEY above.
    return "platform_error"


def _json(r):
    try:
        return r.json()
    except Exception:
        return None


# ── YouTube ──────────────────────────────────────────────────────────────────


class YouTubeClient:
    """The few GET calls research makes, over an injected HTTP session (tests pass a fake one; nothing here opens a socket of its
    own). ``api_key`` for the public calls, an access token for the channel's own."""

    def __init__(self, session, api_key: str = "", *, timeout: float = 20.0):
        self.session = session
        self._key = api_key or ""
        self.timeout = timeout

    def _get(self, url: str, params: Mapping, *, token: str = "") -> dict:
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        else:
            if not self._key:
                raise failed("not_configured")
            headers["X-Goog-Api-Key"] = self._key
        try:
            r = self.session.get(url, params=dict(params), headers=headers, timeout=self.timeout)
        except Exception as e:
            # The type only: a transport error's message can quote the request.
            logger.info("research: YouTube call did not complete (%s)", type(e).__name__)
            raise failed("platform_error") from None
        if r.status_code >= 300:
            word = error_word(r.status_code, _json(r), oauth=bool(token))
            # YouTube's own day is spent: the request ends like our budget does (nothing more can run today), named apart.
            raise Stop("budget_exhausted" if word == "quota" else "failed", word, r.status_code)
        body = _json(r)
        if not isinstance(body, Mapping):
            raise failed("platform_error")
        return dict(body)

    def channels(self, *, ids: Sequence[str] = (), handle: str = "", mine_token: str = "") -> List[dict]:
        params: Dict[str, object] = {"part": "snippet,statistics,contentDetails"}
        if mine_token:
            params["mine"] = "true"
        elif handle:
            params["forHandle"] = handle
        else:
            params["id"] = ",".join(ids)
            params["maxResults"] = 50
        body = self._get(f"{DATA_API}/channels", params, token=mine_token)
        return [i for i in body.get("items") or [] if isinstance(i, Mapping)]

    def upload_ids(self, playlist_id: str, *, token: str = "") -> List[str]:
        body = self._get(f"{DATA_API}/playlistItems",
                         {"part": "contentDetails", "playlistId": playlist_id, "maxResults": UPLOADS_PER_CHANNEL}, token=token)
        out = []
        for item in body.get("items") or []:
            vid = ((item or {}).get("contentDetails") or {}).get("videoId") if isinstance(item, Mapping) else None
            if isinstance(vid, str) and _VIDEO.match(vid):
                out.append(vid)
        return out[:UPLOADS_PER_CHANNEL]

    def videos(self, ids: Sequence[str], *, token: str = "") -> List[dict]:
        # part=status: on the owner's token the list includes private and unlisted uploads, and only one YouTube reports public may
        # reach the shared cache (the API key sees public ones only; status costs nothing more).
        body = self._get(f"{DATA_API}/videos", {"part": "snippet,statistics,status", "id": ",".join(ids), "maxResults": 50},
                         token=token)
        return [i for i in body.get("items") or [] if isinstance(i, Mapping)]

    def search_channels(self, query: str) -> List[str]:
        body = self._get(f"{DATA_API}/search", {"part": "snippet", "type": "channel", "q": query, "maxResults": TOPIC_RESULTS})
        out: List[str] = []
        for item in body.get("items") or []:
            if not isinstance(item, Mapping):
                continue
            cid = (item.get("id") or {}).get("channelId") if isinstance(item.get("id"), Mapping) else None
            cid = cid or (item.get("snippet") or {}).get("channelId")
            if isinstance(cid, str) and _UC.match(cid) and cid not in out:
                out.append(cid)
        return out[:TOPIC_RESULTS]

    def analytics(self, token: str, start: str, end: str) -> Dict[str, Optional[int]]:
        metrics = ("views", "estimatedMinutesWatched", "subscribersGained", "subscribersLost")
        body = self._get(ANALYTICS_API, {"ids": "channel==MINE", "startDate": start, "endDate": end,
                                         "metrics": ",".join(metrics)}, token=token)
        heads = [h.get("name") for h in body.get("columnHeaders") or [] if isinstance(h, Mapping)]
        rows = body.get("rows") or []
        row = rows[0] if rows and isinstance(rows[0], list) else []
        got = {name: row[i] for i, name in enumerate(heads) if i < len(row)}
        # A metric the report did not include is unknown (None), never 0.
        return {m: _count(got.get(m)) for m in metrics}


def _count(value) -> Optional[int]:
    """A count as the API gave it (YouTube sends them as strings), or None. Never a default."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        n = int(value) if not isinstance(value, float) else int(round(value))
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def channel_row(item: Mapping) -> Optional[dict]:
    """A channels.list item -> the cache row: the API's fields only. hiddenSubscriberCount -> subscribers_hidden, count None."""
    cid = item.get("id")
    if not isinstance(cid, str) or not _UC.match(cid):
        return None
    sn = item.get("snippet") if isinstance(item.get("snippet"), Mapping) else {}
    st = item.get("statistics") if isinstance(item.get("statistics"), Mapping) else {}
    cd = item.get("contentDetails") if isinstance(item.get("contentDetails"), Mapping) else {}
    uploads = ((cd.get("relatedPlaylists") or {}) if isinstance(cd.get("relatedPlaylists"), Mapping) else {}).get("uploads")
    hidden = st.get("hiddenSubscriberCount") is True
    handle = sn.get("customUrl") if isinstance(sn.get("customUrl"), str) else None
    return {
        "youtube_channel_id": cid,
        "title": sn.get("title") if isinstance(sn.get("title"), str) else None,
        "handle": handle[:64] if handle else None,
        "subscriber_count": None if hidden else _count(st.get("subscriberCount")),
        "subscribers_hidden": hidden,
        "view_count": _count(st.get("viewCount")),
        "video_count": _count(st.get("videoCount")),
        "uploads_playlist_id": uploads if isinstance(uploads, str) and _PLAYLIST.match(uploads) else None,
    }


def video_row(item: Mapping) -> Optional[dict]:
    vid = item.get("id")
    if not isinstance(vid, str) or not _VIDEO.match(vid):
        return None
    sn = item.get("snippet") if isinstance(item.get("snippet"), Mapping) else {}
    st = item.get("statistics") if isinstance(item.get("statistics"), Mapping) else {}
    cid = sn.get("channelId")
    if not isinstance(cid, str) or not _UC.match(cid):
        return None
    published = sn.get("publishedAt") if isinstance(sn.get("publishedAt"), str) else None
    return {
        "video_id": vid, "youtube_channel_id": cid,
        "title": sn.get("title") if isinstance(sn.get("title"), str) else None,
        "published_at": published,
        # Absent = hidden or switched off by the channel: None, never 0.
        "view_count": _count(st.get("viewCount")),
        "like_count": _count(st.get("likeCount")),
        "comment_count": _count(st.get("commentCount")),
    }


def privacy_of(item: Mapping) -> Optional[str]:
    """The privacy YouTube reported for a video (videos.list part=status), or None when it did not say."""
    status = item.get("status") if isinstance(item.get("status"), Mapping) else {}
    value = status.get("privacyStatus")
    return value if value in ("public", "unlisted", "private") else None


# ── Supabase (the service key; only 0202's functions) ────────────────────────


class ResearchStore:
    """The queue and the caches, over PostgREST function calls. The service key has no table privilege on them (0202)."""

    def __init__(self, url: str, service_key: str, *, session=None, timeout: float = 30.0):
        self.url = (url or "").rstrip("/")
        self._key = service_key or ""
        self._http = session
        self._timeout = timeout
        self._warned_404: set = set()

    def http(self):
        if self._http is None:
            import requests  # noqa: PLC0415

            self._http = requests.Session()
        return self._http

    def _rpc(self, name: str, payload: dict):
        r = self.http().post(f"{self.url}/rest/v1/rpc/{name}", json=payload,
                             headers={"apikey": self._key, "Authorization": f"Bearer {self._key}",
                                      "Content-Type": "application/json"},
                             timeout=self._timeout)
        if r.status_code == 404:
            if name not in self._warned_404:
                self._warned_404.add(name)
                logger.warning("research: the database function %s answered 404 (migration 0202 not applied, or the API schema "
                               "cache is stale): research requests wait until it exists", name)
            return None
        if r.status_code >= 300:
            raise RuntimeError(f"{name}: HTTP {r.status_code}")   # the status only, never the body
        return r.json()

    def claim(self, worker_id: str) -> Optional[dict]:
        out = self._rpc("research_claim_request", {"p_worker": worker_id})
        return out if isinstance(out, dict) and out.get("id") else None

    def finish(self, request_id, worker_id: str, status: str, code: Optional[str], units: int) -> bool:
        return self._rpc("research_finish_request", {"p_request_id": request_id, "p_worker": worker_id, "p_status": status,
                                                     "p_error_code": code, "p_units": int(units)}) is True

    def quota_take(self, project: str, units: int, ceiling: int, org: str, org_ceiling: int, source: str) -> bool:
        return self._rpc("youtube_quota_take", {"p_project": project, "p_units": units, "p_ceiling": ceiling, "p_org": org,
                                                "p_org_ceiling": org_ceiling, "p_source": source}) is True

    def store_channels(self, rows: List[dict]) -> None:
        if rows:
            self._rpc("research_store_channels", {"p_rows": rows})

    def store_videos(self, rows: List[dict]) -> None:
        if rows:
            self._rpc("research_store_videos", {"p_rows": rows})

    def lookup_failed(self, competitor_id: str) -> str:
        out = self._rpc("research_competitor_lookup_failed", {"p_id": competitor_id})
        return out if isinstance(out, str) else ""

    def resolve(self, competitor_id: str, youtube_channel_id: Optional[str]) -> str:
        out = self._rpc("research_resolve_competitor", {"p_id": competitor_id, "p_youtube_channel_id": youtube_channel_id})
        return out if isinstance(out, str) else ""

    def store_topic(self, request_id, ids: List[str]) -> bool:
        return self._rpc("research_store_topic", {"p_request_id": request_id, "p_youtube_channel_ids": ids}) is True

    def store_own(self, request_id, youtube_channel_id: str, period_days: int, metrics: Mapping[str, Optional[int]]) -> str:
        out = self._rpc("research_store_own", {
            "p_request_id": request_id, "p_youtube_channel_id": youtube_channel_id, "p_period_days": period_days,
            "p_views": metrics.get("views"), "p_minutes": metrics.get("estimatedMinutesWatched"),
            "p_gained": metrics.get("subscribersGained"), "p_lost": metrics.get("subscribersLost")})
        return out if isinstance(out, str) else ""

    def purge(self) -> Optional[dict]:
        out = self._rpc("research_purge_stale", {})
        return out if isinstance(out, dict) else None


# ── one request ──────────────────────────────────────────────────────────────


@dataclass
class Budget:
    """Counts each call against the day before it is made. No budget, no call."""

    store: object
    project: str
    org: str
    spent: int = 0

    def take(self, source: str = SOURCE_UNITS, units: int = UNITS_LIST) -> None:
        if units <= 0:
            return
        if source == SOURCE_SEARCH:
            ceiling, org_ceiling = DAILY_SEARCHES, ORG_DAILY_SEARCHES
        else:
            ceiling, org_ceiling = DAILY_UNITS, ORG_DAILY_UNITS
        if not self.store.quota_take(self.project, units, ceiling, self.org, org_ceiling, source):
            raise budget()
        if source == SOURCE_UNITS:
            self.spent += units


def _fresh(stamp, now: datetime) -> bool:
    if not isinstance(stamp, str) or not stamp:
        return False
    try:
        at = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return False
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return (now - at).total_seconds() < STALE_SECONDS


def _chunks(items: Sequence[str], n: int = 50) -> Iterable[List[str]]:
    for i in range(0, len(items), n):
        yield list(items[i:i + n])


def _uploads(yt: YouTubeClient, spend: Budget, store, playlist_id: str, youtube_channel_id: str,
             since: Optional[str] = None) -> None:
    """A channel's newest PUBLIC uploads and their statistics, with the platform's key: 2 units. The batch is marked complete, so a
    cached video the public lookup no longer returns (it went private, or was deleted) is removed from the shared cache: only rows
    written before this fetch began (``since``, the request's start by the DATABASE's clock, from the claim), so another worker's
    newer rows for the channel stay."""
    spend.take()
    ids = yt.upload_ids(playlist_id)
    rows = []
    if ids:
        spend.take()
        rows = [r for r in (video_row(i) for i in yt.videos(ids)) if r and r["youtube_channel_id"] == youtube_channel_id]
    marker = {"youtube_channel_id": youtube_channel_id, "complete": True}
    if since:
        marker["fetched_since"] = since
    store.store_videos(rows + [marker])


def _own_uploads(yt: YouTubeClient, spend: Budget, store, playlist_id: str, token: str, request_id) -> None:
    """The channel's own newest uploads with its own token (private and unlisted included): 2 units. Stored for that channel only;
    the database copies a video into the shared cache only when YouTube reports it public."""
    spend.take()
    ids = yt.upload_ids(playlist_id, token=token)
    if not ids:
        # Nothing uploaded (any more): the stored list is replaced by nothing, not left as it was.
        store.store_videos([{"own_request_id": request_id, "complete": True}])
        return
    spend.take()
    rows = []
    for item in yt.videos(ids, token=token):
        row = video_row(item)
        if row:
            row.update({"own_request_id": request_id, "privacy_status": privacy_of(item)})
            rows.append(row)
    store.store_videos(rows)


def access_token(session, token_json: str, *, timeout: float = 20.0) -> str:
    """A fresh access token from the channel's stored refresh token. Sent only to Google's token endpoint; nothing of the answer
    but the access token is kept, and nothing of it is logged."""
    import json  # noqa: PLC0415

    try:
        data = json.loads(token_json) if token_json else {}
    except ValueError:
        raise failed("token_expired") from None
    refresh, cid, secret = (str(data.get(k) or "") for k in ("refresh_token", "client_id", "client_secret"))
    if not (refresh and cid and secret):
        raise failed("token_expired")
    try:
        r = session.post(TOKEN_URI, data={"grant_type": "refresh_token", "refresh_token": refresh, "client_id": cid,
                                          "client_secret": secret}, timeout=timeout)
    except Exception as e:
        logger.info("research: token refresh did not complete (%s)", type(e).__name__)
        raise failed("platform_error") from None
    body = _json(r)
    if r.status_code >= 500:
        raise failed("platform_error")
    if r.status_code >= 300:
        # invalid_grant: revoked or expired, the person reconnects. invalid_client / unauthorized_client: the server's OAuth client is
        # wrong, which no reconnect fixes (the operator's remedy). Only the error WORD is read, never the description.
        word = body.get("error") if isinstance(body, Mapping) else None
        if word in ("invalid_client", "unauthorized_client"):
            raise failed("not_configured")
        raise failed("token_expired")
    tok = body.get("access_token") if isinstance(body, Mapping) else None
    if not isinstance(tok, str) or not tok:
        raise failed("token_expired")
    return tok


def _own(req: Mapping, *, yt: YouTubeClient, session, store, spend: Budget, credentials, now: datetime) -> None:
    try:
        token_json, ctx = credentials(str(req.get("channel_id") or ""))
    except (KeyError, ValueError):
        # Not a confirmed channel on this worker (rule 7): it has no account to read.
        raise Stop("not_connected", "not_connected") from None
    except Exception as e:
        logger.info("research: the channel's token could not be resolved (%s)", type(e).__name__)
        raise failed("worker_error") from None
    if not token_json:
        raise Stop("not_connected", "not_connected")
    token = access_token(session, token_json)
    spend.take()
    items = yt.channels(mine_token=token)
    row = channel_row(items[0]) if items else None
    if row is None:
        raise failed("not_found")
    expected = ""
    cred = getattr(ctx, "credential", None)
    if cred is not None:
        expected = str(getattr(cred, "youtube_channel_id", "") or "")
    if expected and expected != row["youtube_channel_id"]:
        raise failed("channel_mismatch")
    store.store_channels([row])
    end = (now - timedelta(days=1)).date()
    start = end - timedelta(days=ANALYTICS_DAYS - 1)
    metrics = yt.analytics(token, start.isoformat(), end.isoformat())
    answer = store.store_own(req.get("id"), row["youtube_channel_id"], ANALYTICS_DAYS, metrics)
    if answer == "channel_mismatch":
        raise failed("channel_mismatch")
    if answer != "ok":
        raise failed("worker_error")
    if row.get("uploads_playlist_id"):
        _own_uploads(yt, spend, store, row["uploads_playlist_id"], token, req.get("id"))


def _competitors(req: Mapping, *, yt: YouTubeClient, store, spend: Budget, now: datetime) -> None:
    comps = [c for c in req.get("competitors") or [] if isinstance(c, Mapping)]
    playlists: Dict[str, Optional[str]] = {}
    stale_ids: List[str] = []
    pending_ids: Dict[str, str] = {}       # UC id -> competitor id
    for c in comps:
        cached = c.get("cached_id") if isinstance(c.get("cached_id"), str) else None
        if c.get("status") == "pending" and cached and _fresh(c.get("channel_fetched_at"), now):
            # The channel is in the cache and younger than an hour (a competitor removed and added again, or another
            # organization's): resolved at no cost, and its uploads fetched only if they are stale too.
            if store.resolve(str(c["id"]), cached) == "resolved" and not _fresh(c.get("videos_fetched_at"), now):
                playlists[cached] = c.get("uploads_playlist_id")
        elif c.get("status") == "pending" and c.get("ref_kind") == "handle":
            spend.take()
            try:
                items = yt.channels(handle=str(c.get("input_ref") or ""))
            except Stop as e:
                # Only YouTube saying "no such channel" (404 / a gone reason) is that competitor's not_found. A 400 says nothing about
                # the channel: it is recorded on that row (pending; the third in a row makes it invalid_ref) and the rest of the
                # request goes on, so one odd handle cannot stop every other competitor's refresh. Anything else ends the request.
                if e.code == "not_found":
                    store.resolve(str(c["id"]), None)
                    continue
                # Only a 400 whose reason names no key, quota or rate problem: Google answers a bad key with 400 too, and that is
                # the operator's key, not this handle (it ends the request with its own remedy below).
                if e.code == "platform_error" and e.http == 400:
                    store.lookup_failed(str(c["id"]))
                    continue
                raise
            row = channel_row(items[0]) if items else None
            if row is None:
                store.resolve(str(c["id"]), None)
                continue
            store.store_channels([row])
            if store.resolve(str(c["id"]), row["youtube_channel_id"]) == "resolved":
                playlists[row["youtube_channel_id"]] = row.get("uploads_playlist_id")
        elif c.get("status") == "pending" and c.get("ref_kind") == "id":
            pending_ids[str(c.get("input_ref"))] = str(c["id"])
        elif c.get("status") == "resolved" and isinstance(c.get("youtube_channel_id"), str):
            cid = c["youtube_channel_id"]
            if not _fresh(c.get("channel_fetched_at"), now) or not c.get("uploads_playlist_id"):
                stale_ids.append(cid)
            elif not _fresh(c.get("videos_fetched_at"), now):
                playlists[cid] = c.get("uploads_playlist_id")
    wanted = list(dict.fromkeys(list(pending_ids) + stale_ids))
    for batch in _chunks(wanted):
        spend.take()
        rows = {r["youtube_channel_id"]: r for r in (channel_row(i) for i in yt.channels(ids=batch)) if r}
        store.store_channels(list(rows.values()))
        for cid in batch:
            if cid in pending_ids:
                answer = store.resolve(pending_ids[cid], cid if cid in rows else None)
                if answer == "resolved":
                    playlists[cid] = rows[cid].get("uploads_playlist_id")
            elif cid in rows:
                playlists[cid] = rows[cid].get("uploads_playlist_id")
    since = req.get("started_at") if isinstance(req.get("started_at"), str) else None
    for cid, playlist in playlists.items():
        if playlist:
            _uploads(yt, spend, store, playlist, cid, since)


def _topic(req: Mapping, *, yt: YouTubeClient, store, spend: Budget, search_shared_units: int = 0) -> None:
    topic = str(req.get("topic") or "")
    if not topic:
        raise failed("worker_error")
    if not yt._key:
        raise failed("not_configured")
    # When the project's search.list draws from the shared bucket too, those units are counted first (RESEARCH_SEARCH_SHARED_UNITS).
    spend.take(SOURCE_UNITS, search_shared_units)
    spend.take(SOURCE_SEARCH)
    ids = yt.search_channels(topic)
    if ids:
        spend.take()
        store.store_channels([r for r in (channel_row(i) for i in yt.channels(ids=ids)) if r])
    if not store.store_topic(req.get("id"), ids):
        raise failed("worker_error")


def search_shared_units(env: Mapping[str, str]) -> int:
    """RESEARCH_SEARCH_SHARED_UNITS as a whole number 0..100; anything else is the default, 0."""
    try:
        n = int(str(env.get(SEARCH_SHARED_UNITS_ENV, "") or "0").strip())
    except ValueError:
        return 0
    return n if 0 <= n <= 100 else 0


def process_request(req: Mapping, *, store, session, api_key: str, credentials: Callable[[str], tuple], worker_id: str,
                    project: str = "default", now: Optional[datetime] = None, search_units: int = 0) -> str:
    """Carry out one claimed request and record how it ended. Returns the status written."""
    rid = req.get("id")
    kind = req.get("kind")
    org = str(req.get("org_id") or "")
    now = now or datetime.now(timezone.utc)
    yt = YouTubeClient(session, api_key)
    spend = Budget(store, project, org)
    status, code = "done", None
    try:
        if kind in ("competitors", "topic") and not api_key:
            # Before any call (rule 6): the fix is the operator's, and it is named.
            raise failed("not_configured")
        if kind == "own_channel":
            _own(req, yt=yt, session=session, store=store, spend=spend, credentials=credentials, now=now)
        elif kind == "competitors":
            _competitors(req, yt=yt, store=store, spend=spend, now=now)
        elif kind == "topic":
            _topic(req, yt=yt, store=store, spend=spend, search_shared_units=search_units)
        else:
            raise failed("worker_error")
    except Stop as e:
        status, code = e.status, e.code
    except Exception as e:  # anything unforeseen: the type only
        logger.warning("research request %s: worker error (%s)", rid, type(e).__name__)
        status, code = "failed", "worker_error"
    if code == "quota":
        logger.warning("research request %s: YouTube's daily quota for this project is spent", rid)
    elif code:
        logger.info("research request %s (%s): %s / %s", rid, kind, status, code)
    if not store.finish(rid, worker_id, status, code, spend.spent):
        logger.warning("research request %s: the database did not record the result (no longer held)", rid)
    return status


class ResearchService:
    """What the queue worker calls between render jobs: the 30-day purge (at most every PURGE_EVERY_SECONDS), then at most one
    request."""

    def __init__(self, url: str, service_key: str, *, worker_id: str, credentials: Callable[[str], tuple],
                 env: Optional[Mapping[str, str]] = None, store=None, session=None,
                 clock: Callable[[], float] = time.monotonic):
        env = os.environ if env is None else env
        self.store = store or ResearchStore(url, service_key)
        self.worker_id = worker_id
        self.credentials = credentials
        self._session = session
        self._api_key = str(env.get(API_KEY_ENV, "") or "").strip()
        raw = str(env.get("NIGHTSHIFT_YT_QUOTA_PROJECT", "") or "").strip().lower()
        self.project = raw if re.fullmatch(r"[a-z0-9._-]{1,64}", raw) else "default"
        self.search_units = search_shared_units(env)
        self._clock = clock
        self._last_purge: Optional[float] = None
        self._warned = False

    @property
    def configured(self) -> bool:
        return bool(self._api_key)

    def http(self):
        if self._session is None:
            import requests  # noqa: PLC0415

            self._session = requests.Session()
        return self._session

    def purge_if_due(self) -> None:
        t = self._clock()
        if self._last_purge is not None and t - self._last_purge < PURGE_EVERY_SECONDS:
            return
        self._last_purge = t
        try:
            out = self.store.purge()
        except Exception as e:
            logger.warning("research: the 30-day purge failed (%s)", str(e) if isinstance(e, RuntimeError) else type(e).__name__)
            return
        if out and any(isinstance(v, int) and v > 0 for v in out.values()):
            logger.info("research: purged rows older than 30 days (%s)",
                        ", ".join(f"{k} {v}" for k, v in sorted(out.items()) if isinstance(v, int)))

    def run_once(self) -> bool:
        self.purge_if_due()
        try:
            req = self.store.claim(self.worker_id)
        except Exception as e:
            if not self._warned:
                logger.warning("research queue unavailable (%s)", str(e) if isinstance(e, RuntimeError) else type(e).__name__)
                self._warned = True
            return False
        if not req:
            return False
        process_request(req, store=self.store, session=self.http(), api_key=self._api_key, credentials=self.credentials,
                        worker_id=self.worker_id, project=self.project, search_units=self.search_units)
        return True


__all__ = ["ResearchService", "ResearchStore", "YouTubeClient", "process_request", "error_word", "channel_row", "video_row",
           "ERROR_WORDS", "Stop"]
