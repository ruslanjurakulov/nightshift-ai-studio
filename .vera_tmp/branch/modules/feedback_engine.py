"""Feedback Engine — closes the intelligence loop.

Context
-------
The implementation report's headline finding was that the feedback loop was
*not closed*: `intelligence_poller.py` captured own-channel metrics into
`StateStore`, and `performance_analyzer.py` could read them back, but nothing
turned that history into a persistent, structured verdict that future topic
selection actually consumed. Prompt-time context (see
`performance_analyzer.analyze_videos_as_prompt_text`) helped, but it was
recomputed and thrown away each run — there was no stored learning signal and
no per-topic score that survived between runs.

This module is the missing link:

    published video metrics (StateStore.metrics_snapshots)
        -> compare each video to the channel's own average
        -> emit discrete learning signals   (feedback_signals table)
        -> roll them up into a per-topic score with an explainable reason
                                            (topic_performance table)
        -> Topic Manager reads those scores when choosing what to make next

`FeedbackEngine.run()` executes that whole chain and persists the result;
`topic_scores_as_prompt_text()` renders the learned scores for Topic Manager
to fold into its selection prompt. The loop therefore *executes*, it does not
merely draw a diagram.

Real data only
--------------
Every number here comes from a real persisted metrics snapshot. Signals and
scores are derived by comparing a video (or topic) to *this channel's own
average*, never to an invented benchmark. Dimensions the stored metrics don't
contain (CTR, impressions, subscribers gained — YouTube Analytics can supply
them but the current capture path does not) are simply not scored, rather than
faked. A retention signal uses `average_view_duration_seconds` as the honest
proxy the schema actually stores.

Below two videos with metrics there is no meaningful "channel average" to
compare against (a lone video would be compared to itself), so `run()` records
nothing and reports `topics_scored: 0` rather than inventing a verdict.

Defensive
---------
`FeedbackEngine(state_store=None)` constructs a real `StateStore`, wrapped in
try/except so a construction failure degrades to no-op (`run()` returns zeros,
`topic_scores_as_prompt_text()` returns "") rather than raising. Every
per-video read and per-write is individually guarded so one bad row can't abort
the analysis of the rest.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date

from modules.performance_analyzer import _views_per_day

logger = logging.getLogger(__name__)

# A metric this far above / below the channel average is a distinct HIGH_/LOW_
# signal; anything inside the band is "about average" and emits no signal.
# 0.20 == ±20%.
_BAND = 0.20

# The score a topic gets when its videos perform exactly at the channel
# average (ratio 1.0). Double the average -> 100; half -> 25.
_NEUTRAL_SCORE = 50.0

# Mirrors modules.channels.DEFAULT_CHANNEL_ID. Kept local so the learning loop
# has no import dependency on the channel model.
_DEFAULT_CHANNEL_ID = "default"

# Fewer analyzed videos than this and there is no channel average worth
# comparing against, so no signals or scores are produced.
_MIN_VIDEOS = 2


@dataclass
class _VideoRecord:
    video_id: str
    topic: str
    views_per_day: float
    engagement_rate: float | None
    retention_seconds: float | None


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _classify(value: float | None, baseline: float | None, high: str, low: str) -> str | None:
    """Return `high`/`low` when `value` is ±_BAND outside `baseline`, else None."""
    if value is None or baseline is None or baseline <= 0:
        return None
    if value >= baseline * (1 + _BAND):
        return high
    if value <= baseline * (1 - _BAND):
        return low
    return None


class FeedbackEngine:
    def __init__(self, state_store=None, channel_id: str | None = None):
        # Learning is per channel: a Finance video's numbers must never move a
        # Prehistoric History topic score. `channel_id` scopes both the videos
        # this engine reads and the scores it writes. None = every video, and
        # scores written to the shared table — exactly the previous behaviour.
        self.channel_id = channel_id
        if state_store is not None:
            self.state_store = state_store
        else:
            try:
                from modules.state_store import StateStore

                self.state_store = StateStore()
            except Exception:
                logger.warning(
                    "Failed to construct default StateStore; FeedbackEngine will no-op "
                    "until a working store is available",
                    exc_info=True,
                )
                self.state_store = None

    # -- gathering ---------------------------------------------------------

    def _gather(self, limit: int) -> list[_VideoRecord]:
        if self.state_store is None:
            return []
        try:
            videos = self.state_store.list_videos(limit=limit, channel_id=self.channel_id)
        except Exception:
            logger.warning("Failed to list videos; feedback analysis produced nothing", exc_info=True)
            return []

        records: list[_VideoRecord] = []
        for video in videos:
            try:
                video_id = video.get("video_id")
                if not video_id:
                    continue
                metrics = self.state_store.latest_metrics(video_id)
                if not metrics:
                    continue  # no snapshot yet — expected, not an error
                views = int(metrics.get("views") or 0)
                vpd = _views_per_day(
                    views=views,
                    published_at=video.get("published_at") or "",
                    snapshot_date=metrics.get("snapshot_date") or "",
                )
                if vpd is None:
                    continue
                likes = int(metrics.get("likes") or 0)
                comments = int(metrics.get("comment_count") or 0)
                engagement = (likes + comments) / views if views > 0 else None
                retention = float(metrics.get("average_view_duration_seconds") or 0.0) or None
                records.append(
                    _VideoRecord(
                        video_id=video_id,
                        topic=video.get("topic") or "",
                        views_per_day=vpd,
                        engagement_rate=engagement,
                        retention_seconds=retention,
                    )
                )
            except Exception:
                logger.warning("Skipping a video during feedback gather", exc_info=True)
                continue
        return records

    # -- the loop ----------------------------------------------------------

    def run(self, limit: int = 100) -> dict:
        """Execute the feedback loop over persisted metrics and persist the
        resulting signals + topic scores.

        Returns a summary dict: `videos_analyzed`, `signals_recorded`,
        `topics_scored`. Never raises.
        """
        summary = {"videos_analyzed": 0, "signals_recorded": 0, "topics_scored": 0}
        records = self._gather(limit)
        summary["videos_analyzed"] = len(records)
        if len(records) < _MIN_VIDEOS:
            logger.info(
                "Feedback loop: %d video(s) with metrics — need at least %d for a channel "
                "average; nothing scored this run",
                len(records), _MIN_VIDEOS,
            )
            return summary

        channel_vpd = _mean([r.views_per_day for r in records])
        channel_eng = _mean([r.engagement_rate for r in records if r.engagement_rate is not None])
        channel_ret = _mean([r.retention_seconds for r in records if r.retention_seconds is not None])

        analyzed_date = date.today().isoformat()
        summary["signals_recorded"] = self._record_signals(records, channel_vpd, channel_eng, channel_ret, analyzed_date)
        summary["topics_scored"] = self._score_topics(records, channel_vpd, channel_eng, channel_ret, analyzed_date)
        logger.info(
            "Feedback loop: analyzed %d video(s), recorded %d signal(s), scored %d topic(s)",
            summary["videos_analyzed"], summary["signals_recorded"], summary["topics_scored"],
        )
        return summary

    def _record_signals(self, records, channel_vpd, channel_eng, channel_ret, analyzed_date) -> int:
        recorded = 0
        for r in records:
            for value, baseline, high, low in (
                (r.views_per_day, channel_vpd, "HIGH_VIEW_VELOCITY", "LOW_VIEW_VELOCITY"),
                (r.engagement_rate, channel_eng, "HIGH_ENGAGEMENT", "LOW_ENGAGEMENT"),
                (r.retention_seconds, channel_ret, "HIGH_RETENTION", "LOW_RETENTION"),
            ):
                signal = _classify(value, baseline, high, low)
                if signal is None:
                    continue
                try:
                    self.state_store.record_feedback_signal(
                        video_id=r.video_id,
                        signal=signal,
                        analyzed_date=analyzed_date,
                        topic=r.topic,
                        metric_value=round(value, 4),
                        channel_baseline=round(baseline, 4),
                        detail=f"{value / baseline:.2f}x channel average",
                    )
                    recorded += 1
                except Exception:
                    logger.warning("Failed to record feedback signal %s for %s", signal, r.video_id, exc_info=True)
        return recorded

    def _score_topics(self, records, channel_vpd, channel_eng, channel_ret, analyzed_date) -> int:
        by_topic: dict[str, list[_VideoRecord]] = {}
        for r in records:
            if not r.topic:
                continue
            by_topic.setdefault(r.topic, []).append(r)

        scored = 0
        for topic, topic_records in by_topic.items():
            topic_vpd = _mean([r.views_per_day for r in topic_records])
            topic_eng = _mean([r.engagement_rate for r in topic_records if r.engagement_rate is not None])
            topic_ret = _mean([r.retention_seconds for r in topic_records if r.retention_seconds is not None])

            ratios: list[float] = []
            reason_parts: list[str] = []
            for label, topic_avg, channel_avg in (
                ("view velocity", topic_vpd, channel_vpd),
                ("engagement", topic_eng, channel_eng),
                ("retention", topic_ret, channel_ret),
            ):
                if topic_avg is None or channel_avg is None or channel_avg <= 0:
                    continue
                ratio = topic_avg / channel_avg
                ratios.append(ratio)
                reason_parts.append(f"{label} {ratio:.2f}x channel avg")

            mean_ratio = _mean(ratios) if ratios else 1.0
            score = round(max(0.0, min(100.0, _NEUTRAL_SCORE * mean_ratio)), 1)
            reason = (
                f"{len(topic_records)} video(s); " + ", ".join(reason_parts)
                if reason_parts
                else f"{len(topic_records)} video(s); insufficient comparable metrics"
            )
            avg_vpd = round(topic_vpd, 4) if topic_vpd is not None else None
            try:
                # Channel-scoped score: the isolated verdict, keyed on
                # (channel_id, topic).
                self.state_store.upsert_channel_topic_performance(
                    channel_id=self.channel_id or _DEFAULT_CHANNEL_ID,
                    topic=topic,
                    score=score,
                    videos_analyzed=len(topic_records),
                    updated_at=analyzed_date,
                    avg_views_per_day=avg_vpd,
                    reason=reason,
                )
                # Shared table, kept in step for the default channel only. Its
                # key is `topic` alone, so writing a second channel's verdict
                # here would overwrite the first — which is exactly the
                # cross-channel contamination this phase exists to prevent.
                if self.channel_id in (None, _DEFAULT_CHANNEL_ID):
                    self.state_store.upsert_topic_performance(
                        topic=topic,
                        score=score,
                        videos_analyzed=len(topic_records),
                        updated_at=analyzed_date,
                        avg_views_per_day=avg_vpd,
                        reason=reason,
                    )
                scored += 1
            except Exception:
                logger.warning("Failed to upsert topic performance for %r", topic, exc_info=True)
        return scored

    def _read_topic_scores(self, limit: int) -> list[dict]:
        """Learned topic rows for this engine's channel.

        Reads the channel-scoped table when a channel is set. Falls back to the
        shared table when that returns nothing, so a deployment whose scores
        predate the channel-scoped table still gets its learned guidance
        instead of silently losing it.
        """
        if self.channel_id is not None:
            rows = self.state_store.list_channel_topic_performance(
                channel_id=self.channel_id, limit=limit
            )
            if rows or self.channel_id != _DEFAULT_CHANNEL_ID:
                return rows
        return self.state_store.list_topic_performance(limit=limit)

    # -- prompt rendering --------------------------------------------------

    def topic_scores_as_prompt_text(self, limit: int = 8) -> str:
        """Render the learned per-topic scores as an appendable prompt block
        for Topic Manager.

        Framed as guidance grounded in this channel's own results — lean
        toward what has worked — but not a hard rule: a high past score is not
        a guarantee, and the operator/model still chooses. Returns "" when no
        topic has been scored yet, so appending it is always safe.
        """
        if self.state_store is None:
            return ""
        try:
            rows = self._read_topic_scores(limit)
        except Exception:
            logger.warning("Failed to list topic performance; no learned-score prompt text", exc_info=True)
            return ""
        if not rows:
            return ""

        lines = [
            "Learned performance of this channel's own past topics (score 50 = channel "
            "average, higher = did better; lean toward what worked, but it is guidance "
            "from real results, not a rule — a strong past score is not a guarantee):"
        ]
        for row in rows:
            score = row.get("score")
            topic = row.get("topic", "")
            reason = row.get("reason", "")
            lines.append(f"- {topic}: score {score:.0f} ({reason})")
        return "\n".join(lines)
