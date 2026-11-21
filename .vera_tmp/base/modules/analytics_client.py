"""Stage 8 (new): YouTube Analytics client — read-only wrapper around the
YouTube Analytics API v2 (`youtubeAnalytics`, version `v2`), built on the same
`google-api-python-client` dependency already used by `youtube_uploader.py`.

Purpose
-------
The rest of the pipeline (topic -> Gemini script -> TTS -> media -> subtitles
-> thumbnails -> compositor -> YouTube upload) never reads back performance
data once a video is uploaded. This module is a thin client for pulling
own-channel watch-time, retention, and engagement metrics so a future stage
can use them (e.g. to inform topic selection or thumbnail A/B decisions).

OAuth scope dependency
-----------------------
This client reuses the OAuth token at `YOUTUBE_TOKEN_FILE` (config.py), the
same file `YouTubeUploader` writes/refreshes. Reading Analytics data requires
the `https://www.googleapis.com/auth/yt-analytics.readonly` scope, which is
NOT yet present in `config.YOUTUBE_SCOPES` on `main` as of this writing —
PR #1 ("Stage 0") adds it. This module does not add the scope itself (that
would conflict with PR #1); it assumes the scope will exist in
`config.YOUTUBE_SCOPES` by the time this code runs. Until PR #1 merges and a
fresh OAuth consent is granted (a token file authorized under the old, narrower
scope list will NOT gain the new scope automatically — it must be re-consented,
which `_auth()` below handles by falling back to `InstalledAppFlow` when the
stored credentials don't satisfy the requested scopes), calls in this module
will fail with an insufficient-scope error from the API.

Metric verification status (per audit's evidence-discipline requirement)
-------------------------------------------------------------------------
CONFIRMED available for an owner querying their own channel/video via the
YouTube Analytics API v2 `reports.query` endpoint, per the public YouTube
Analytics/Reporting API documentation as of this writing:
    - views
    - estimatedMinutesWatched
    - averageViewDuration
    - averageViewPercentage
    - subscribersGained
    - subscribersLost
    - likes
    - comments
    - shares
    - dimensions: day (for `daily_timeseries`)

UNKNOWN / UNVERIFIED — CONFIRM AGAINST CURRENT API DOCS BEFORE RELYING ON IT:
    - "dislikes": YouTube publicly hid dislike *counts* in 2021; whether the
      Analytics API still exposes a `dislikes` metric to channel owners (and
      whether it reflects real data or a frozen/zeroed value) could not be
      verified by the prior audit. Do NOT assume it works — check the current
      "Metrics" reference page (developers.google.com/youtube/analytics) and
      test against a real channel before shipping any feature that depends on
      it. It is intentionally NOT included in the default metric sets below.
    - "estimatedRevenue" / "cpm" / other monetization metrics: These require
      the additional `yt-analytics-monetary.readonly` scope and are subject to
      YPP (YouTube Partner Program) eligibility and revenue-sharing agreement
      acceptance. `channel_revenue` / `video_revenue` below query them, but the
      monetary scope is opt-in (config.REVENUE_TRACKING_ENABLED / the
      CHRONOS_ENABLE_REVENUE env flag) precisely because it is not free to add:
      a token consented under the narrower scopes cannot use it, so both
      methods treat a rejected request as "revenue not measurable here" and
      return `{}` rather than assuming the metric "just works".
    - Any metric/dimension combination not explicitly listed above (e.g.
      `insightTrafficSourceType`, `deviceType`, `country` breakdowns) is
      simply not covered by this thin client. Adding it should mean adding a
      typed method here, not passing raw strings from a caller.

None of the above should be treated as verified just because it appears in
this file — this comment records what a prior audit could and could not
confirm; re-check against docs before depending on anything marked UNKNOWN.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

from config import YOUTUBE_CHANNEL_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_SCOPES
from modules.channel_credentials import (
    client_secret_problem,
    legacy_token_path,
    materialize_token,
    require_interactive_consent_possible,
    token_path,
)

logger = logging.getLogger(__name__)

# Core metric set used by channel_summary() and video_performance(). Keep in
# sync with the "CONFIRMED" list in the module docstring above.
#: Click-through metrics, asked for separately (see video_ctr).
CTR_METRICS: list[str] = [
    "impressions",
    "impressionClickThroughRate",
]

#: Audience-retention metrics, paired with the elapsedVideoTimeRatio dimension.
RETENTION_METRICS: list[str] = [
    "audienceWatchRatio",
]

#: Monetization metrics (roadmap #71). `estimatedRevenue` is USD. Paired with
#: `views` so a real RPM (revenue / views × 1000) can be computed downstream.
#: These need the monetary scope (config.REVENUE_TRACKING_ENABLED) and YPP;
#: without them the request is refused and the callers below record no revenue.
#: Kept to the two most broadly-documented monetary fields on purpose — one
#: unsupported metric name would take the whole revenue query down with it.
MONETARY_METRICS: list[str] = [
    "views",
    "estimatedRevenue",
]

CORE_METRICS: list[str] = [
    "views",
    "estimatedMinutesWatched",
    "averageViewDuration",
    "averageViewPercentage",
    "subscribersGained",
    "subscribersLost",
    "likes",
    "comments",
    "shares",
]


class AnalyticsClient:
    """Read-only wrapper around the YouTube Analytics API v2.

    Mirrors the OAuth pattern in `modules/youtube_uploader.py.YouTubeUploader._auth`
    (same token file, same refresh/InstalledAppFlow fallback) rather than
    importing from it, to keep this module mergeable independently of any
    change to that shared file. Some duplication is intentional here; a
    follow-up PR can factor out a shared `_auth()` helper once all the
    parallel module PRs have landed.
    """

    def __init__(self, channel=None):
        """`channel` binds this client to one channel's OAuth token, so a
        channel only ever reads its own analytics. None keeps the legacy
        single-channel token from config."""
        self.channel = channel
        self.token_file = self._resolve_token_file(channel)
        self.service = self._auth()

    @staticmethod
    def _resolve_token_file(channel) -> Path:
        if channel is None:
            return legacy_token_path()
        materialize_token(channel)
        return token_path(channel)

    def _auth(self):
        creds = None
        token_file = Path(self.token_file)

        if token_file.exists():
            creds = Credentials.from_authorized_user_file(str(token_file), YOUTUBE_SCOPES)

        if not creds or not creds.valid or not set(YOUTUBE_SCOPES).issubset(set(creds.scopes or [])):
            if creds and creds.expired and creds.refresh_token and set(YOUTUBE_SCOPES).issubset(
                set(creds.scopes or [])
            ):
                creds.refresh(Request())
            else:
                # Existence is not enough: the workflows write this file with
                # `echo '<secret>' > client_secret.json`, so an unset secret
                # leaves an EMPTY file behind. Handing that to InstalledAppFlow
                # produced the bare JSONDecodeError every scheduled poll has
                # actually been failing with.
                problem = client_secret_problem()
                if problem:
                    raise FileNotFoundError(problem)
                # And on CI there is no browser to consent in, so say that
                # instead of blocking on run_local_server until the timeout.
                require_interactive_consent_possible(
                    token_file=token_file, required_scopes=YOUTUBE_SCOPES
                )
                flow = InstalledAppFlow.from_client_secrets_file(
                    YOUTUBE_CLIENT_SECRET, YOUTUBE_SCOPES
                )
                creds = flow.run_local_server(port=0)
            token_file.write_text(creds.to_json())
            logger.info("Token saqlandi: %s", token_file)

        return build("youtubeAnalytics", "v2", credentials=creds)

    @staticmethod
    def _parse_report(response: dict[str, Any]) -> list[dict[str, Any]]:
        """Turns a raw `reports.query` response into a list of row dicts keyed
        by column name, using `columnHeaders` to map each row's positional
        values.
        """
        headers = [h["name"] for h in response.get("columnHeaders", [])]
        rows = response.get("rows", []) or []
        return [dict(zip(headers, row)) for row in rows]

    def channel_summary(
        self,
        start_date: str,
        end_date: str,
        channel_id: str | None = None,
    ) -> dict[str, Any]:
        """Aggregate core metrics for a channel over [start_date, end_date]
        (YYYY-MM-DD, inclusive). Defaults to `ids="channel==MINE"`; pass
        `channel_id` (or rely on `config.YOUTUBE_CHANNEL_ID`) to query a
        specific channel the authenticated user manages instead.

        Returns a single flat dict of metric name -> value (one row expected,
        since no `dimensions` is requested). Returns an empty dict if the API
        returns no rows for the range.
        """
        ids = f"channel=={channel_id}" if channel_id else _default_ids()
        response = (
            self.service.reports()
            .query(
                ids=ids,
                startDate=start_date,
                endDate=end_date,
                metrics=",".join(CORE_METRICS),
            )
            .execute()
        )
        rows = self._parse_report(response)
        return rows[0] if rows else {}

    def video_performance(
        self,
        video_id: str,
        start_date: str,
        end_date: str,
    ) -> dict[str, Any]:
        """Aggregate core metrics for a single video over [start_date, end_date]
        (YYYY-MM-DD, inclusive). Always queries the authenticated user's own
        channel (`ids="channel==MINE"`), filtered to `video_id`.

        Returns a single flat dict of metric name -> value, or an empty dict
        if the API returns no rows (e.g. the video had zero views in range,
        or is not owned by the authenticated channel).
        """
        response = (
            self.service.reports()
            .query(
                ids=_default_ids(),
                startDate=start_date,
                endDate=end_date,
                metrics=",".join(CORE_METRICS),
                filters=f"video=={video_id}",
            )
            .execute()
        )
        rows = self._parse_report(response)
        return rows[0] if rows else {}

    # -- click-through and retention (Phase 6) -----------------------------
    #
    # Both use metric and dimension names that YouTube can rename or gate
    # behind report types. Rather than assume, each method treats a rejected
    # request as "not measurable here" and returns empty: a missing CTR is a
    # gap in the data, while a guessed one would silently become a decision.

    def video_ctr(self, video_id: str, start_date: str, end_date: str) -> dict[str, Any]:
        """Impressions and click-through rate for one video, or {} when the API
        will not report them.

        This is the number the thumbnail/title A/B test is *for*: without it the
        variant that shipped cannot be judged, so it is worth asking for
        explicitly rather than folding into the core metrics (where one
        unsupported name would take the whole poll down with it).
        """
        try:
            response = (
                self.service.reports()
                .query(
                    ids=_default_ids(),
                    startDate=start_date,
                    endDate=end_date,
                    metrics=",".join(CTR_METRICS),
                    filters=f"video=={video_id}",
                )
                .execute()
            )
        except Exception as e:
            logger.warning(
                "CTR report unavailable for %s (%s: %s) — recording no click-through "
                "rather than a guessed one. Confirm the metric names for your "
                "account in the YouTube Analytics API reference.",
                video_id, type(e).__name__, e,
            )
            return {}
        rows = self._parse_report(response)
        return rows[0] if rows else {}

    def video_retention(self, video_id: str, start_date: str, end_date: str) -> list[dict[str, Any]]:
        """The audience-retention curve for one video: one row per point of
        elapsed video time, with the share of viewers still watching.

        Returns [] when the API will not report it. This is the strongest signal
        for improving a hook — it says *where* viewers leave, which no aggregate
        can.
        """
        try:
            response = (
                self.service.reports()
                .query(
                    ids=_default_ids(),
                    startDate=start_date,
                    endDate=end_date,
                    metrics=",".join(RETENTION_METRICS),
                    dimensions="elapsedVideoTimeRatio",
                    filters=f"video=={video_id};audienceType==ORGANIC",
                )
                .execute()
            )
        except Exception as e:
            logger.warning(
                "Retention report unavailable for %s (%s: %s) — no curve recorded",
                video_id, type(e).__name__, e,
            )
            return []
        return self._parse_report(response)

    # -- revenue (roadmap #71) ---------------------------------------------
    #
    # estimatedRevenue is the real money figure, in USD. It needs the monetary
    # Analytics scope (opt-in) and YPP. Like video_ctr/video_retention above,
    # a rejected request is treated as "revenue not measurable here" and yields
    # {} — an unmonetized channel, a missing scope, or a video outside YPP is a
    # *gap*, never $0. The caller (modules/revenue_tracker.py) keeps that
    # distinction: no revenue row means unknown earnings, not zero earnings.

    def channel_revenue(
        self,
        start_date: str,
        end_date: str,
        channel_id: str | None = None,
    ) -> dict[str, Any]:
        """Estimated revenue (USD) and views for a channel over
        [start_date, end_date] (YYYY-MM-DD, inclusive), or {} when the API will
        not report monetary data (scope not granted, channel not in YPP, …)."""
        ids = f"channel=={channel_id}" if channel_id else _default_ids()
        try:
            response = (
                self.service.reports()
                .query(
                    ids=ids,
                    startDate=start_date,
                    endDate=end_date,
                    metrics=",".join(MONETARY_METRICS),
                )
                .execute()
            )
        except Exception as e:
            logger.warning(
                "Revenue report unavailable for channel (%s: %s) — recording no "
                "revenue rather than a guessed $0. Confirm the monetary scope is "
                "granted and the channel is in the YouTube Partner Program.",
                type(e).__name__, e,
            )
            return {}
        rows = self._parse_report(response)
        return rows[0] if rows else {}

    def video_revenue(self, video_id: str, start_date: str, end_date: str) -> dict[str, Any]:
        """Estimated revenue (USD) and views for one video over
        [start_date, end_date] (YYYY-MM-DD, inclusive), or {} when the API will
        not report monetary data for it."""
        try:
            response = (
                self.service.reports()
                .query(
                    ids=_default_ids(),
                    startDate=start_date,
                    endDate=end_date,
                    metrics=",".join(MONETARY_METRICS),
                    filters=f"video=={video_id}",
                )
                .execute()
            )
        except Exception as e:
            logger.warning(
                "Revenue report unavailable for %s (%s: %s) — no revenue recorded",
                video_id, type(e).__name__, e,
            )
            return {}
        rows = self._parse_report(response)
        return rows[0] if rows else {}

    def daily_timeseries(
        self,
        start_date: str,
        end_date: str,
        metrics: list[str],
    ) -> list[dict[str, Any]]:
        """Per-day trend for the given metrics over [start_date, end_date]
        (YYYY-MM-DD, inclusive), using `dimensions="day"`. Always queries the
        authenticated user's own channel (`ids="channel==MINE"`).

        `metrics` is caller-supplied rather than defaulted to CORE_METRICS —
        the caller should only pass metrics they have verified are valid for
        `dimensions=day` (not every metric supports every dimension; see the
        module docstring's UNKNOWN/UNVERIFIED section before adding new ones).

        Returns a list of dicts (one per day present in the response), each
        containing `"day"` plus one key per requested metric. Rows are
        returned in whatever order the API provides (YouTube Analytics
        typically returns them sorted by day ascending, but this is not
        re-sorted or otherwise guaranteed here).
        """
        response = (
            self.service.reports()
            .query(
                ids=_default_ids(),
                startDate=start_date,
                endDate=end_date,
                metrics=",".join(metrics),
                dimensions="day",
            )
            .execute()
        )
        return self._parse_report(response)


def _default_ids() -> str:
    """`channel==MINE` unless config.YOUTUBE_CHANNEL_ID pins a specific
    (e.g. Brand Account) channel, matching `YouTubeUploader`'s convention of
    treating `YOUTUBE_CHANNEL_ID` as the target channel when set.
    """
    return f"channel=={YOUTUBE_CHANNEL_ID}" if YOUTUBE_CHANNEL_ID else "channel==MINE"
