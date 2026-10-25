"""Intelligence poller — the scheduler-agnostic entry point that actually
runs the previously-standalone intelligence modules and persists what they
find.

Context
-------
`modules/analytics_client.py` (AnalyticsClient), `modules/competitor_monitor.py`
(CompetitorMonitor), `modules/trend_detector.py` (TrendDetector), and
`modules/state_store.py` (StateStore) each do one job, and nothing in a video
run calls any of them. This module is the piece that does, on a schedule:
`IntelligencePoller.run_all()` is the single function the scheduled job calls
(tools/run_intelligence_poll.py, run daily by
.github/workflows/intelligence_poll.yml).

Design: defensive per-sub-call, not defensive per-poll
-------------------------------------------------------
This poller exists to run unattended. A single bad response — a quota
error, a not-found video, a transient network blip, a video too new to have
analytics data yet — must never take down the rest of a run. So every
sub-call (each per-video analytics lookup, the competitor poll, the trend
poll) is wrapped in its own try/except that logs a warning and degrades to
an empty/zero result for just that piece, rather than letting the exception
propagate and abort everything else `run_all()` would otherwise have done.

Dependency injection
---------------------
Mirrors the pattern already used in `modules/originality_engine.py`
(`OriginalityEngine.__init__(embedder=None)` lazily constructs the real,
network-touching default only when no fake is injected): each of
`analytics_client`, `competitor_monitor`, and `trend_detector` defaults to
constructing its real counterpart, but accepts an injected fake/mock so
tests never make live API calls.
"""

from __future__ import annotations

import logging
import math
import os
import re
import time
from datetime import date, datetime, timedelta

logger = logging.getLogger(__name__)

#: The window of the default poll: it reads a video only if it was published since `today - DEFAULT_POLL_DAYS`, i.e. at calendar
#: ages 0..DEFAULT_POLL_DAYS. Everything that says "early life" below is derived from it, so they cannot drift apart.
DEFAULT_POLL_DAYS = 1
#: Repository variable (intelligence_poll.yml) that widens the daily own-channel poll. Empty = the poll reads only videos
#: published since yesterday (`poll_own_channel_metrics`' default `days=DEFAULT_POLL_DAYS`), exactly as before it existed.
METRICS_POLL_DAYS_ENV = "NIGHTSHIFT_METRICS_POLL_DAYS"
#: Bounds of the variable. 90 is the largest range the results dashboard offers.
MIN_METRICS_POLL_DAYS = 1
MAX_METRICS_POLL_DAYS = 90
#: YouTube Analytics `reports.query` calls one polled video costs at most: core metrics, click-through, retention.
ANALYTICS_CALLS_PER_VIDEO = 3
#: Hard cap on those calls for one channel in one run, applied only when the poll is widened. 600 = 200 videos, the
#: number of videos the results dashboard shows. Newest videos are polled first, so the cap drops the oldest.
MAX_ANALYTICS_CALLS_PER_POLL = 600
#: Wall-clock budget of the widened own-channel polls of ONE run (all channels together: the clock starts at the first
#: widened poll of the process). The job has a 30 minute timeout, this pass runs first and the mirror runs after it.
MAX_METRICS_POLL_SECONDS = 600
#: Calendar age (days after publishing) up to which a reading is "early life": exactly what the DEFAULT poll reads. Every
#: decision reader (views per day since publishing, retention of a new opening) is only right for such readings, and a
#: reading at a later age would be a two-day window divided by its age. In a widened poll a reading of an older video is filed
#: apart (`late`, see StateStore.record_metrics_snapshot) and its retention curve is not read: a late curve would replace the
#: early one retention_curve() hands to hook_ab, and is ~100 stored points a day for nothing.
EARLY_LIFE_DAYS = DEFAULT_POLL_DAYS
#: How many skipped video ids a "stopped early" warning names.
_SKIPPED_IDS_SHOWN = 5
#: int32, the range of the integer columns; YouTube never sends more.
_INT32_MAX = 2**31 - 1
#: What a YouTube video id looks like: exactly 11 characters of A-Z a-z 0-9 _ -. The ids come from the local store, which
#: any earlier writer filled, so an id that is anything else is never copied into a log line (it could carry a newline that
#: forges a log entry, or an arbitrary amount of text).
_YOUTUBE_VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")
#: Put in the log in place of an id that does not match.
_INVALID_ID_PLACEHOLDER = "<invalid id>"


def _loggable_video_id(value) -> str:
    """`value` if it is a well-formed YouTube video id, else a fixed placeholder. For log lines about a skipped video only:
    the video is still skipped or polled exactly as before, only its name in the log changes."""
    if isinstance(value, str) and _YOUTUBE_VIDEO_ID.fullmatch(value):
        return value
    return _INVALID_ID_PLACEHOLDER


_run_clock_started = None


def reset_run_clock() -> None:
    """Forget when the widened polls of this run began (tests, and a process that runs more than one job)."""
    global _run_clock_started
    _run_clock_started = None


def _remaining_budget_seconds() -> float:
    """What is left of MAX_METRICS_POLL_SECONDS for the next widened poll. One budget for the whole run, not one per channel:
    the default channel and every other channel draw on it, so three channels cannot add up to the job's timeout."""
    global _run_clock_started
    now = time.monotonic()
    if _run_clock_started is None:
        _run_clock_started = now
    return max(0.0, MAX_METRICS_POLL_SECONDS - (now - _run_clock_started))


def metrics_poll_options(environ=None) -> dict:
    """Keyword arguments for `poll_own_channel_metrics` from NIGHTSHIFT_METRICS_POLL_DAYS.

    `{}` when the variable is empty, unset, not a whole number or outside 1..90, so the call is then literally
    `poll_own_channel_metrics()` and the poll is what it was before this variable existed. A bad value is never
    guessed at or clamped (a typo must not widen a quota-bound job): it is logged with the fix and ignored.
    """
    raw = (environ if environ is not None else os.environ).get(METRICS_POLL_DAYS_ENV, "")
    raw = (raw or "").strip()
    if not raw:
        return {}
    # ASCII digits only: int() would also accept "+7", "7_0" and non-Latin digits, none of which is a typo worth honouring.
    days = int(raw) if len(raw) <= 3 and raw.isascii() and raw.isdigit() else None
    if days is None or not MIN_METRICS_POLL_DAYS <= days <= MAX_METRICS_POLL_DAYS:
        logger.warning(
            "Ignoring %s=%r: it must be a whole number of days from %d to %d. The poll keeps its default "
            "(videos published since yesterday).",
            METRICS_POLL_DAYS_ENV, raw[:40], MIN_METRICS_POLL_DAYS, MAX_METRICS_POLL_DAYS,
        )
        return {}
    return {"days": days, "max_calls": MAX_ANALYTICS_CALLS_PER_POLL, "max_seconds": _remaining_budget_seconds()}


def _isoformat(value) -> str:
    """Best-effort conversion of a VideoSnapshot's published_at to a string
    state_store's TEXT columns can hold. Falls back to str() rather than
    raising, since a malformed timestamp shouldn't be the reason a whole
    snapshot fails to persist."""
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _optional_int(value):
    """int(value), or None when it is absent or unparseable.

    None matters: a metric YouTube did not return is *unknown*, and coercing it
    to 0 would record "no impressions" for a video nobody measured.
    """
    # True is 1 in Python; YouTube never sends a boolean, so one is a malformed response, not a count.
    if value is None or isinstance(value, bool):
        return None
    try:
        number = int(float(value))
    except (TypeError, ValueError, OverflowError):
        return None
    # A count is never negative, and the columns are int32 (YouTube never sends more): anything else is a bad row, not a
    # measurement.
    return number if 0 <= number <= _INT32_MAX else None


def _optional_float(value):
    """float(value), or None. Same reasoning as _optional_int."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    # NaN and infinity are not measurements (JSON, the Supabase mirror, cannot carry them), and none of the figures read here
    # (minutes, seconds, ratios) is ever negative.
    return number if math.isfinite(number) and number >= 0 else None


class IntelligencePoller:
    """Runs the analytics/competitor/trend intelligence modules and persists
    their results via StateStore. The single entry point future scheduled
    jobs should call is `run_all()`.
    """

    def __init__(
        self,
        state_store=None,
        analytics_client=None,
        competitor_monitor=None,
        trend_detector=None,
        channel=None,
    ):
        # `channel` scopes the own-channel analytics pass: which videos are
        # polled, whose OAuth token reads them, and which channel the resulting
        # competitor snapshots are attributed to. None = the pre-multi-channel
        # behaviour (every video, the config token).
        self.channel = channel
        self.channel_id = str(channel.channel_id) if channel is not None else None
        if state_store is not None:
            self.state_store = state_store
        else:
            from modules.state_store import StateStore

            self.state_store = StateStore()

        if analytics_client is not None:
            self.analytics_client = analytics_client
        else:
            from modules.analytics_client import AnalyticsClient

            self.analytics_client = AnalyticsClient(channel=channel)

        if competitor_monitor is not None:
            self.competitor_monitor = competitor_monitor
        else:
            from modules.competitor_monitor import CompetitorMonitor

            self.competitor_monitor = CompetitorMonitor()

        if trend_detector is not None:
            self.trend_detector = trend_detector
        else:
            from modules.trend_detector import TrendDetector

            self.trend_detector = TrendDetector()

        self._last_competitor_snapshots_written = 0
        self._last_trending_snapshots_written = 0
        # Analytics reports.query calls made by the last poll_own_channel_metrics().
        self.last_analytics_calls = 0

    # -- own-channel analytics -------------------------------------------

    def poll_own_channel_metrics(
        self, days: int = DEFAULT_POLL_DAYS, max_calls: int | None = None, max_seconds: float | None = None
    ) -> int:
        """For each video this bot has uploaded (per `StateStore.list_videos`)
        published within the last `days` days, pull a small recent analytics
        window (yesterday through today) via `AnalyticsClient.video_performance`
        and persist it via `StateStore.record_metrics_snapshot`.

        `days` bounds which *videos* are considered (recently-published ones —
        older videos are far less likely to need frequent re-polling and this
        keeps a single run's API usage small), not the analytics window
        itself, which is always the fixed short "yesterday to today" range
        regardless of `days`.

        One video's analytics call failing (bad video ID, too new to have
        data yet, quota exceeded, ...) is logged as a warning and does not
        stop the remaining videos from being processed. Returns the number
        of snapshots successfully written.

        Each polled video costs up to ANALYTICS_CALLS_PER_VIDEO Analytics
        calls, counted in `last_analytics_calls`. `max_calls` (None = no cap,
        the default) stops the loop before a video that would exceed it, newest
        videos first, and says so; see docs/RESULTS_DASHBOARD.md for the math.
        `max_seconds` (None = no limit) stops the loop after that much wall-clock
        time, with a warning. A video YouTube returned nothing at all for (no
        metric, no click-through) gets no row: an all-NULL row dated today would
        be the newest snapshot and hide the earlier real one from every reader.
        """
        self.last_analytics_calls = 0
        started = time.monotonic()
        since = None
        if days is not None:
            since = (datetime.now().date() - timedelta(days=days)).isoformat()

        # list_videos returns 100 rows unless told otherwise. Only a capped (widened) poll asks for more, one video past
        # what the cap allows, so the loop below can see that it dropped some and say so; the default call is unchanged.
        extra = {"limit": max_calls // ANALYTICS_CALLS_PER_VIDEO + 1} if max_calls is not None else {}
        try:
            videos = (
                self.state_store.list_videos(since=since, channel_id=self.channel_id, **extra)
                if since
                else self.state_store.list_videos(channel_id=self.channel_id, **extra)
            )
        except Exception:
            logger.exception("Failed to list videos from state store; polling zero own-channel metrics")
            return 0

        today = date.today()
        start_date = (today - timedelta(days=1)).isoformat()
        end_date = today.isoformat()
        snapshot_date = end_date

        written = 0
        polled = 0
        stopped_early = False
        for index, video in enumerate(videos):
            video_id = video.get("video_id")
            if not video_id:
                continue
            if max_seconds is not None and time.monotonic() - started > max_seconds:
                logger.warning(
                    "[channel: %s] Own-channel poll stopped after %.0f s (budget %.0f s): polled the %d newest video(s) "
                    "of the last %s day(s) and skipped %d older one(s), first %s. Lower %s to poll fewer videos.",
                    self.channel_id or "default", time.monotonic() - started, max_seconds, polled,
                    days, len(videos) - index, self._skipped_ids(videos, index), METRICS_POLL_DAYS_ENV,
                )
                stopped_early = True
                break
            if max_calls is not None and self.last_analytics_calls + ANALYTICS_CALLS_PER_VIDEO > max_calls:
                logger.warning(
                    "[channel: %s] Analytics call cap reached (%d calls, cap %d): polled the %d newest video(s) of "
                    "the last %s day(s) and skipped at least %d older one(s), first %s. Lower %s to poll fewer videos.",
                    self.channel_id or "default", self.last_analytics_calls, max_calls, polled,
                    days, len(videos) - index, self._skipped_ids(videos, index), METRICS_POLL_DAYS_ENV,
                )
                stopped_early = True
                break
            polled += 1
            try:
                self.last_analytics_calls += 1
                metrics = self.analytics_client.video_performance(video_id, start_date, end_date)
                # Click-through, asked for separately so an unsupported metric
                # name degrades to "not measured" instead of losing the whole
                # snapshot. {} here means unknown CTR, never zero CTR.
                self.last_analytics_calls += 1
                ctr = self.analytics_client.video_ctr(video_id, start_date, end_date)
                # NULL, not 0, for what YouTube did not return: video_performance
                # gives {} for a video it has no row for yet, and a stored 0 would
                # read as a measured "no views". A 0 YouTube did send stays 0.
                figures = dict(
                    views=_optional_int(metrics.get("views")),
                    likes=_optional_int(metrics.get("likes")),
                    comment_count=_optional_int(metrics.get("comments")),
                    watch_time_minutes=_optional_float(metrics.get("estimatedMinutesWatched")),
                    average_view_duration_seconds=_optional_float(metrics.get("averageViewDuration")),
                    impressions=_optional_int(ctr.get("impressions")),
                    impression_ctr=_optional_float(ctr.get("impressionClickThroughRate")),
                )
                if all(value is None for value in figures.values()):
                    logger.info("No analytics yet for video_id=%s; nothing recorded", _loggable_video_id(video_id))
                    continue
                # Only a widened poll can reach an older video; the default call below is exactly the old one.
                late = max_calls is not None and not self._is_early_life(video.get("published_at"), today)
                extra_args = {"late": True} if late else {}
                self.state_store.record_metrics_snapshot(
                    video_id=video_id, snapshot_date=snapshot_date, **figures, **extra_args
                )
                if not late:
                    self._record_retention(video_id, start_date, end_date)
                written += 1
            except Exception:
                logger.warning(
                    "Failed to poll/record analytics for video_id=%s; skipping", _loggable_video_id(video_id), exc_info=True
                )
                continue

        # The store list is cut at `limit`. The call cap alone cannot reveal that when quota errors make every video cost
        # one call: the loop then never reaches the cap and the videos past the cut would be dropped without a word.
        if extra and not stopped_early and len(videos) >= extra["limit"]:
            logger.warning(
                "[channel: %s] The last %s day(s) hold at least %d video(s), the most this poll reads; any older ones "
                "were not polled. Lower %s to cover fewer days.",
                self.channel_id or "default", days, len(videos), METRICS_POLL_DAYS_ENV,
            )
        if max_calls is not None:
            logger.info(
                "[channel: %s] Own-channel poll over the last %s day(s): %d video(s) polled, %d snapshot(s) written, "
                "%d Analytics call(s) (cap %d).",
                self.channel_id or "default", days, polled, written, self.last_analytics_calls, max_calls,
            )
        return written

    @staticmethod
    def _skipped_ids(videos, index) -> str:
        """The first few video ids a stopped poll did not reach (ids only, each checked by _loggable_video_id), so
        the operator can see which ones."""
        ids = [v.get("video_id") for v in videos[index:] if v.get("video_id")]
        shown = ", ".join(_loggable_video_id(i) for i in ids[:_SKIPPED_IDS_SHOWN])
        return shown + (", ..." if len(ids) > _SKIPPED_IDS_SHOWN else "")

    @staticmethod
    def _is_early_life(published_at, today) -> bool:
        """True when the video is at most EARLY_LIFE_DAYS old, or its age cannot be told (then it is treated as the poll
        always treated every video: early)."""
        if not published_at:
            return True
        try:
            published = datetime.fromisoformat(str(published_at).strip().replace("Z", "+00:00")).date()
        except (ValueError, TypeError):
            return True
        return (today - published).days <= EARLY_LIFE_DAYS

    # -- competitors --------------------------------------------------------

    def _persist_competitor_snapshots(self, results: dict) -> int:
        """Writes each channel's VideoSnapshots (and their view_velocity) into
        state_store.competitor_snapshots. Previously this data was computed
        and immediately discarded — nothing downstream could ever see it.
        One bad snapshot (unexpected field shape, a state_store failure) is
        logged and skipped rather than aborting the rest.
        """
        from modules.competitor_monitor import view_velocity

        polled_date = date.today().isoformat()
        written = 0
        for channel_id, snapshots in results.items():
            for snapshot in snapshots:
                try:
                    velocity = view_velocity(snapshot)
                    self.state_store.record_competitor_snapshot(
                        video_id=snapshot.video_id,
                        channel_id=snapshot.channel_id or channel_id,
                        polled_date=polled_date,
                        title=snapshot.title,
                        view_count=snapshot.view_count,
                        like_count=snapshot.like_count,
                        comment_count=snapshot.comment_count,
                        published_at=_isoformat(snapshot.published_at),
                        view_velocity=velocity,
                        # Which of OUR channels is watching them (channel_id
                        # above is the competitor's own YouTube channel).
                        chronos_channel_id=self.channel_id or "default",
                    )
                    written += 1
                except Exception:
                    logger.warning(
                        "Failed to persist competitor snapshot (channel=%s); skipping", channel_id, exc_info=True
                    )
        return written

    def poll_competitors(self, channel_ids: list) -> dict:
        """Thin entry point around `CompetitorMonitor.poll`. Returns whatever
        it gets back; on any failure, logs a warning and returns `{}` rather
        than raising. As a side effect, persists every snapshot returned via
        `StateStore.record_competitor_snapshot` — see `_persist_competitor_snapshots`.
        """
        try:
            results = self.competitor_monitor.poll(channel_ids)
        except Exception:
            logger.warning("Competitor poll failed; returning empty result", exc_info=True)
            self._last_competitor_snapshots_written = 0
            return {}
        self._last_competitor_snapshots_written = self._persist_competitor_snapshots(results)
        return results

    # -- trends ---------------------------------------------------------

    def _persist_trending_snapshots(self, snapshots: list, region_code: str, category_id) -> int:
        """Writes each trending VideoSnapshot into state_store.trending_snapshots.
        Same discard-on-persist-failure defensiveness as competitor snapshots.
        """
        polled_date = date.today().isoformat()
        written = 0
        for snapshot in snapshots:
            try:
                self.state_store.record_trending_snapshot(
                    video_id=snapshot.video_id,
                    polled_date=polled_date,
                    title=snapshot.title,
                    view_count=snapshot.view_count,
                    like_count=snapshot.like_count,
                    comment_count=snapshot.comment_count,
                    published_at=_isoformat(snapshot.published_at),
                    region_code=region_code,
                    category_id=category_id or "",
                )
                written += 1
            except Exception:
                logger.warning("Failed to persist trending snapshot; skipping", exc_info=True)
        return written

    def poll_trends(self, region_code: str = "US", category_id=None) -> list:
        """Thin entry point around `TrendDetector.trending`. Returns whatever
        it gets back; on any failure, logs a warning and returns `[]` rather
        than raising. As a side effect, persists every snapshot returned via
        `StateStore.record_trending_snapshot` — see `_persist_trending_snapshots`.
        """
        try:
            results = self.trend_detector.trending(region_code=region_code, category_id=category_id)
        except Exception:
            logger.warning("Trend poll failed; returning empty result", exc_info=True)
            self._last_trending_snapshots_written = 0
            return []
        self._last_trending_snapshots_written = self._persist_trending_snapshots(results, region_code, category_id)
        return results

    def _record_retention(self, video_id: str, start_date: str, end_date: str) -> int:
        """Store this video's retention curve. Returns points written.

        Wrapped separately from the metrics snapshot above: retention is the
        newest and least-guaranteed report of the three, and a channel that
        cannot produce it must still get its views recorded.
        """
        self.last_analytics_calls += 1
        try:
            curve = self.analytics_client.video_retention(video_id, start_date, end_date)
        except Exception:
            logger.warning("Retention poll failed for %s; no curve recorded", video_id, exc_info=True)
            return 0
        written = 0
        for row in curve:
            elapsed = _optional_float(row.get("elapsedVideoTimeRatio"))
            if elapsed is None:
                continue
            try:
                self.state_store.record_retention_point(
                    video_id=video_id,
                    elapsed_ratio=elapsed,
                    watch_ratio=_optional_float(row.get("audienceWatchRatio")),
                    measured_date=end_date,
                )
                written += 1
            except Exception:
                logger.warning("Failed to persist retention point for %s", video_id, exc_info=True)
        if written:
            logger.info("Retention: %d point(s) recorded for %s", written, video_id)
        return written

    def forecast_spend(self) -> bool:
        """Project the channel's month-end spend from its month-to-date spend and
        emit one `budget.forecast`, flagging when the pace is on track to blow a
        set ceiling. Advisory only — it forecasts, it never blocks a run. Returns
        True when a projection was produced. Never raises."""
        try:
            from modules import budget
            from modules import event_log as events

            ceiling = getattr(getattr(self.channel, "agent", None), "spend_ceiling_usd", None)
            report = budget.forecast_month_end(
                self.state_store, self.channel_id or "default", ceiling)
            events.emit(events.BUDGET_FORECAST, agent="budget", status=events.STATUS_COMPLETED,
                        channel_id=self.channel_id, metadata=report.to_dict())
            if report.projected_exceeds:
                logger.warning("[channel: %s] Spend pace projects $%.2f vs ceiling $%.2f this month",
                               self.channel_id, report.projected_usd, report.ceiling_usd)
            return report.projected_usd is not None
        except Exception:
            logger.exception("Spend-forecast pass failed; forecasting nothing")
            return False

    def _videos_with_metrics(self):
        """The channel's videos plus a {video_id: latest_metrics} map. Shared by
        the advisory passes below so each doesn't re-read the store separately."""
        videos = self.state_store.list_videos(limit=100000, channel_id=self.channel_id)
        metrics_by_id = {}
        for v in videos:
            vid = v.get("video_id")
            if not vid:
                continue
            m = self.state_store.latest_metrics(vid)
            if m is not None:
                metrics_by_id[vid] = m
        return videos, metrics_by_id

    def suggest_repackages(self) -> int:
        """Flag published videos whose CTR is well below this channel's own
        median as candidates for a new title/thumbnail, emitting one
        `repackage.suggested` roll-up. Advisory only. Never raises."""
        try:
            from modules import event_log as events
            from modules import repackage

            videos, metrics_by_id = self._videos_with_metrics()
            candidates = repackage.find_candidates(videos, metrics_by_id)
            events.emit(events.REPACKAGE_SUGGESTED, agent="repackage",
                        status=events.STATUS_COMPLETED, channel_id=self.channel_id,
                        metadata=repackage.summarize(candidates))
            if candidates:
                logger.info("[channel: %s] %d repackage candidate(s); worst: %s",
                            self.channel_id, len(candidates), candidates[0].video_id)
            return len(candidates)
        except Exception:
            logger.exception("Repackage suggestion pass failed; suggesting zero")
            return 0

    def suggest_publish_time(self) -> bool:
        """Recommend the publish hour (UTC) and weekday from when this channel's
        best-performing videos went out, emitting one `publish.timing`. Advisory
        only. Never raises."""
        try:
            from modules import event_log as events
            from modules import publish_timing

            videos, metrics_by_id = self._videos_with_metrics()
            report = publish_timing.analyze(videos, metrics_by_id)
            events.emit(events.PUBLISH_TIMING, agent="publish_timing",
                        status=events.STATUS_COMPLETED, channel_id=self.channel_id,
                        metadata=publish_timing.summarize(report))
            if report.has_recommendation:
                logger.info("[channel: %s] Best publish slot: %sh UTC, %s",
                            self.channel_id, report.best_hour_utc, report.best_weekday_name or "?")
            return report.has_recommendation
        except Exception:
            logger.exception("Publish-time suggestion pass failed; recommending nothing")
            return False

    def estimate_sponsorship(self) -> bool:
        """Price one integrated sponsor slot from this channel's measured reach
        (average long-form views × the configured sponsorship CPM), emitting one
        `sponsorship.estimate`. Advisory only — it informs a human's negotiation,
        it never contacts a sponsor or commits a price. Never raises. Returns
        True when a real price could be offered (reach measured AND a CPM set)."""
        try:
            from modules import event_log as events
            from modules import sponsorship

            videos, metrics_by_id = self._videos_with_metrics()
            est = sponsorship.estimate(videos, metrics_by_id)
            events.emit(events.SPONSORSHIP_ESTIMATE, agent="sponsorship",
                        status=events.STATUS_COMPLETED, channel_id=self.channel_id,
                        metadata=sponsorship.summarize(est))
            if est.has_price:
                logger.info("[channel: %s] Sponsor slot ≈ $%.2f (%s avg views × $%s CPM)",
                            self.channel_id, est.price_usd, est.average_views, est.cpm_usd)
            return est.has_price
        except Exception:
            logger.exception("Sponsorship-estimate pass failed; pricing nothing")
            return False

    def track_revenue(self) -> bool:
        """Read back each video's real estimatedRevenue (USD) from YouTube
        Analytics, build a channel revenue picture, and emit one
        `revenue.tracked`. Advisory only — it reports earnings, it never gates a
        publish or changes niche selection. Never raises.

        Off unless revenue tracking is enabled (config.REVENUE_TRACKING_ENABLED
        / CHRONOS_ENABLE_REVENUE): the monetary scope must be granted first, so
        calling the API without it would only 403 once per video. When enabled
        but the channel is not monetized, every `video_revenue` returns {} and
        the report is honestly empty (no revenue), never a fabricated $0.
        Returns True when any real revenue was measured."""
        try:
            import config
            from modules import event_log as events
            from modules import revenue_tracker

            if not getattr(config, "REVENUE_TRACKING_ENABLED", False):
                logger.debug("Revenue tracking disabled; skipping the revenue pass")
                return False

            videos, metrics_by_id = self._videos_with_metrics()
            end_date = date.today().isoformat()
            revenue_rows: dict = {}
            for video in videos:
                video_id = video.get("video_id")
                if not video_id:
                    continue
                start_date = self._revenue_start_date(video.get("published_at"))
                try:
                    row = self.analytics_client.video_revenue(video_id, start_date, end_date)
                except Exception:
                    logger.warning(
                        "Failed to poll revenue for video_id=%s; skipping", video_id, exc_info=True
                    )
                    continue
                if row:
                    revenue_rows[video_id] = row

            report = revenue_tracker.build_report(revenue_rows, views_by_video=metrics_by_id)
            events.emit(events.REVENUE_TRACKED, agent="revenue_tracker",
                        status=events.STATUS_COMPLETED, channel_id=self.channel_id,
                        metadata=revenue_tracker.summarize(report))
            if report.has_revenue:
                logger.info("[channel: %s] Revenue tracked: $%.2f over %d video(s), RPM $%s",
                            self.channel_id, report.total_usd, report.measured_count,
                            report.channel_rpm_usd)
            return report.has_revenue
        except Exception:
            logger.exception("Revenue-tracking pass failed; recording no revenue")
            return False

    def research_vidiq(self) -> bool:
        """Fetch vidIQ keyword opportunities for this channel's niche and emit
        one `vidiq.research` event so the advisory card can show them. Research
        and scoring ONLY — advisory, it never selects a topic or edits a title.

        Off unless configured (config.VIDIQ_ENABLED / CHRONOS_ENABLE_VIDIQ +
        a token): with no client the researcher is a no-op and this returns
        False, leaving the card honestly empty. Never raises. Returns True when
        a ranking was actually produced."""
        try:
            from modules import vidiq
            from modules import vidiq_client

            client = vidiq_client.make_client()
            if client is None:
                logger.debug("vidIQ disabled; skipping the research pass")
                return False

            seed = (getattr(self.channel, "niche", None) or "").strip()
            if not seed:
                logger.debug("vidIQ: no channel niche to seed research; skipping")
                return False

            researcher = vidiq.VidIQResearcher(client=client, channel_id=self.channel_id)
            ranked = researcher.research(seed)
            if ranked:
                logger.info("[channel: %s] vidIQ research: %d keyword(s), best %r",
                            self.channel_id, len(ranked), ranked[0][0].term)
            return bool(ranked)
        except Exception:
            logger.exception("vidIQ research pass failed; recommending nothing")
            return False

    @staticmethod
    def _revenue_start_date(published_at) -> str:
        """The revenue query's start date for a video: its publish date (so the
        figure is lifetime-to-date), or one year back when the publish date is
        missing/unparseable — never a guessed 'today', which would report $0 for
        a video that has in fact earned."""
        default = (date.today() - timedelta(days=365)).isoformat()
        if not published_at:
            return default
        try:
            s = str(published_at).strip().replace("Z", "+00:00")
            return datetime.fromisoformat(s).date().isoformat()
        except (ValueError, TypeError):
            return default

    # -- orchestration --------------------------------------------------

    def run_all(self, competitor_channel_ids: list | None = None) -> dict:
        """Runs all three polls and returns a small summary dict. This is
        the single function the scheduled job calls (tools/run_intelligence_poll.py,
        run by .github/workflows/intelligence_poll.yml).
        """
        own_metrics_written = self.poll_own_channel_metrics(**metrics_poll_options())

        channel_ids = competitor_channel_ids or []
        competitor_results = self.poll_competitors(channel_ids) if channel_ids else {}

        trending_videos = self.poll_trends()

        # Advisory passes, after the metrics poll so they read the freshest data.
        repackage_candidates = self.suggest_repackages()
        spend_forecast_ready = self.forecast_spend()
        publish_timing_ready = self.suggest_publish_time()
        sponsorship_ready = self.estimate_sponsorship()
        revenue_tracked = self.track_revenue()
        vidiq_researched = self.research_vidiq()

        return {
            "own_metrics_written": own_metrics_written,
            "competitor_channels_polled": len(competitor_results),
            "competitor_snapshots_written": self._last_competitor_snapshots_written if channel_ids else 0,
            "trending_videos_found": len(trending_videos),
            "trending_snapshots_written": self._last_trending_snapshots_written,
            "repackage_candidates": repackage_candidates,
            "spend_forecast_ready": spend_forecast_ready,
            "publish_timing_ready": publish_timing_ready,
            "sponsorship_ready": sponsorship_ready,
            "revenue_tracked": revenue_tracked,
            "vidiq_researched": vidiq_researched,
        }
