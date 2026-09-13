#!/usr/bin/env python3
"""Scheduled entry point for the intelligence layer — see
.github/workflows/intelligence_poll.yml.

Runs four independent passes, each defensive on its own: one bad video, one
bad API response, or one entire sub-system being down must never abort the
rest of the poll.

  1. IntelligencePoller.run_all() — own-channel analytics, competitor
     monitoring, and trending videos (see modules/intelligence_poller.py).
  2. Comment fetch + classify + demand aggregation for recently published
     videos (StateStore.list_videos() — never a hardcoded list).
  3. Feed TopicRecommender's resulting suggestions into ContentPlanner's
     queue — this is the producer side of the content-planning loop;
     modules/topic_manager.py is the consumer side (checks the queue
     before spending a Gemini call on a fresh topic).
  4. Run the feedback loop (modules/feedback_engine.py) over the freshly
     polled metrics — derive learning signals and per-topic scores that
     Topic Manager reads on the next video run. This is the step that closes
     the loop: published-video performance actually influences future topics.

This script does not decide *when* to run — that's the workflow's cron
schedule. It only does the work once invoked.
"""

import argparse
import logging
import os
import sys
from datetime import date
from pathlib import Path

# Running this as a script (`python tools/run_intelligence_poll.py`) puts the
# tools/ directory on sys.path, not the repo root, so `import modules` fails
# with ModuleNotFoundError. Add the repo root first — same as
# tools/run_feedback.py and tools/check_pending_approvals.py.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

Path("logs").mkdir(exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("logs/intelligence_poll.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger("intelligence_poll")

from modules.audience_demand import AudienceDemandEngine
from modules.comment_fetcher import CommentFetcher
from modules.comment_intelligence import classify_comments
from modules import event_log as events
from modules.content_planner import ContentPlanner
from modules.channels import DEFAULT_CHANNEL_ID, ChannelRegistry
from modules.feedback_engine import FeedbackEngine
from modules.intelligence_poller import IntelligencePoller
from modules.state_store import StateStore
from modules.supabase_sync import SupabaseSync
from modules.topic_recommender import TopicRecommender


def _competitor_channel_ids(channel=None) -> list[str]:
    """Which YouTube channels to watch on this run.

    Comes from the channel's own configuration; `COMPETITOR_CHANNEL_IDS` is the
    fallback the default channel keeps (see modules/channels._env_competitor_ids),
    so a pre-Phase-5 deployment is unaffected. A Finance channel must never
    inherit a history channel's rivals, so there is no cross-channel fallback.
    """
    if channel is not None:
        return list(channel.agent.competitor_channel_ids)
    raw = os.getenv("COMPETITOR_CHANNEL_IDS", "")
    return [c.strip() for c in raw.split(",") if c.strip()]


def poll_comments_for_recent_videos(store: StateStore, limit: int = 10, channel=None) -> None:
    """Fetch and classify comments for one channel's most recently published
    videos, and record what its audience asked for.

    A CommentFetcher auth failure (no token yet, expired credentials) skips
    this whole pass rather than crashing the poll — the analytics/competitor/
    trend pass above is independent and should still have run.

    With a `channel`, the fetcher authenticates as that channel, only that
    channel's videos are walked, and the resulting demand signals are recorded
    against it. That last part is the point: audience demand is the single most
    channel-specific signal there is, and one channel's viewers must never steer
    another channel's topics.
    """
    channel_id = str(channel.channel_id) if channel is not None else DEFAULT_CHANNEL_ID
    label = f"[channel: {channel_id}] "
    try:
        fetcher = CommentFetcher(channel=channel)
    except Exception as e:
        logger.warning("%sCommentFetcher auth failed (%s: %s) — skipping comment polling",
                       label, type(e).__name__, e)
        return

    all_records = []
    for video in store.list_videos(limit=limit, channel_id=channel.channel_id if channel else None):
        video_id = video.get("video_id")
        if not video_id:
            continue
        try:
            comments = fetcher.fetch_comments(video_id)
            if not comments:
                continue
            classified = classify_comments(comments)
            flagged = [c for c in classified if c.flagged_injection_attempt]
            if flagged:
                logger.warning(
                    "Video %s: %d comment(s) flagged as possible prompt-injection attempts",
                    video_id, len(flagged),
                )
            text_by_id = {c["id"]: c["text"] for c in comments}
            all_records.extend(
                {
                    "comment_id": c.comment_id,
                    "sentiment": c.sentiment,
                    "category": c.category,
                    "text": text_by_id.get(c.comment_id, ""),
                }
                for c in classified
            )
            logger.info("Video %s: %d comment(s) classified", video_id, len(classified))
        except Exception as e:
            logger.warning("Comment poll failed for video %s (%s: %s) — skipping", video_id, type(e).__name__, e)
            continue

    if not all_records:
        return
    signals = AudienceDemandEngine().analyze(all_records)
    if not signals:
        return

    top = [(s.topic_phrase, s.mention_count) for s in signals[:5]]
    logger.info("%sAudience demand — top requested topics: %s", label, top)

    polled_date = date.today().isoformat()
    written = 0
    for signal in signals:
        try:
            store.record_demand_signal(
                topic_phrase=signal.topic_phrase,
                mention_count=signal.mention_count,
                polled_date=polled_date,
                example_comment_ids=",".join(str(i) for i in signal.example_comment_ids),
                channel_id=channel_id,
            )
            written += 1
        except Exception as e:
            logger.warning("Failed to persist demand signal %r (%s: %s) — skipping", signal.topic_phrase, type(e).__name__, e)
    logger.info("%sPersisted %d/%d demand signal(s)", label, written, len(signals))


def enqueue_topic_suggestions(limit: int = 5, channel=None) -> int:
    """Feeds TopicRecommender's ranked suggestions into ContentPlanner's
    queue, so a future pick_topic() call can consume one directly instead
    of spending a Gemini call. Runs after the analytics/competitor/trend
    and comment/demand passes above so it sees the freshest persisted data.

    Never raises: TopicRecommender().suggest_topics() already degrades to
    [] on any internal failure, and ContentPlanner's own dedup means
    re-running this poll repeatedly against an unchanged database just
    reuses existing queued entries rather than growing the queue unbounded.
    """
    channel_id = str(channel.channel_id) if channel is not None else DEFAULT_CHANNEL_ID
    label = f"[channel: {channel_id}] "
    try:
        opportunities = TopicRecommender(channel_id=channel_id).suggest_topics(limit=limit)
    except Exception as e:
        logger.warning("%sTopicRecommender failed (%s: %s) — nothing enqueued this run",
                       label, type(e).__name__, e)
        return 0
    if not opportunities:
        return 0

    try:
        planner = ContentPlanner(channel_id=channel_id)
    except Exception as e:
        logger.warning("%sFailed to construct ContentPlanner (%s: %s) — nothing enqueued this run",
                       label, type(e).__name__, e)
        return 0

    enqueued = 0
    for opp in opportunities:
        try:
            planner.enqueue_opportunity(opp)
            enqueued += 1
        except Exception as e:
            logger.warning("%sFailed to enqueue suggestion %r (%s: %s) — skipping",
                           label, opp.topic, type(e).__name__, e)
    logger.info("%sContent planner: %d/%d suggestion(s) enqueued (existing queued duplicates are reused, not duplicated)",
                label, enqueued, len(opportunities))
    return enqueued


def _active_channels() -> list:
    """The channels this poll should walk, or `[None]` when the registry is
    unavailable.

    `None` means "the legacy single channel": the passes that take a channel
    fall back to their pre-Phase-5 behaviour rather than skipping, so a registry
    failure degrades the poll's attribution, never its coverage.
    """
    try:
        channels = ChannelRegistry().active()
    except Exception as e:
        logger.warning("Channel registry unavailable (%s: %s) — polling as the single default channel",
                       type(e).__name__, e)
        return [None]
    return channels or [None]


def poll_additional_channel_metrics() -> dict:
    """Poll own-channel analytics AND own competitors for every ACTIVE channel
    except the default.

    The default channel is already covered by `IntelligencePoller.run_all()`
    above. Trending is NOT repeated here: YouTube's trending list is region-wide
    public data, identical whichever channel reads it, so polling it per channel
    would spend quota to store the same rows again.

    Competitors are the opposite — each channel watches its own — so each extra
    channel polls its own list, and the snapshots carry its `chronos_channel_id`.

    Each channel is wrapped individually: a channel whose token is missing or
    expired must not stop the next channel from being polled, and must not fail
    the job.
    """
    try:
        channels = [c for c in ChannelRegistry().active() if not c.is_default]
    except Exception as e:
        logger.warning("Channel registry unavailable (%s: %s) — polled the default channel only",
                       type(e).__name__, e)
        return {}
    if not channels:
        return {}

    written: dict = {}
    for channel in channels:
        try:
            poller = IntelligencePoller(channel=channel)
            metrics = poller.poll_own_channel_metrics()
            rivals = _competitor_channel_ids(channel)
            if rivals:
                poller.poll_competitors(rivals)
            written[str(channel.channel_id)] = metrics
        except Exception as e:
            logger.warning("[channel: %s] analytics poll failed (%s: %s) — other channels unaffected",
                           channel.channel_id, type(e).__name__, e)
            events.emit(events.AGENT_FAILED, agent="intelligence_poller", status=events.STATUS_FAILED,
                        channel_id=str(channel.channel_id),
                        metadata={"operation": "analytics", "error": f"{type(e).__name__}: {e}"})
    if written:
        logger.info("Per-channel analytics snapshots written: %s", written)
    return written


def run_feedback_analysis() -> dict:
    """Run the feedback loop over the metrics this poll (and prior polls) have
    persisted: derive learning signals + per-topic scores that Topic Manager
    reads on the next video run. Runs last, after own-channel metrics have been
    freshly polled above. Never raises (FeedbackEngine is defensive).

    Runs once PER CHANNEL, each with its own engine scoped to its own videos —
    a Finance video's numbers must never move a History topic score. One
    channel's failure is logged and the next channel still runs. The returned
    summary is the total across channels, plus a per-channel breakdown.
    """
    try:
        channels = ChannelRegistry().list()
    except Exception as e:
        logger.warning("Channel registry unavailable (%s: %s) — running feedback for the default channel only",
                       type(e).__name__, e)
        channels = []

    channel_ids = [str(c.channel_id) for c in channels] or [None]
    totals = {"videos_analyzed": 0, "signals_recorded": 0, "topics_scored": 0}
    per_channel: dict = {}

    for channel_id in channel_ids:
        try:
            summary = FeedbackEngine(channel_id=channel_id).run()
        except Exception as e:
            logger.warning("Feedback loop failed for channel %s (%s: %s) — no scores updated for it",
                           channel_id, type(e).__name__, e)
            events.emit(events.AGENT_FAILED, agent="feedback_engine", status=events.STATUS_FAILED,
                        channel_id=channel_id,
                        metadata={"operation": "feedback", "error": f"{type(e).__name__}: {e}"})
            continue
        per_channel[channel_id or "default"] = summary
        for key in totals:
            totals[key] += summary.get(key, 0)
        events.emit(events.FEEDBACK_GENERATED, agent="feedback_engine", status=events.STATUS_COMPLETED,
                    channel_id=channel_id, metadata=summary)
        if summary.get("topics_scored"):
            events.emit(events.FEEDBACK_APPLIED, agent="feedback_engine", status=events.STATUS_COMPLETED,
                        channel_id=channel_id, metadata={"topics_scored": summary["topics_scored"]})

    logger.info("Feedback loop summary: %s (per channel: %s)", totals, per_channel)
    return totals


def rank_niches_across_channels() -> dict:
    """Rank the niches the studio publishes in by how they have ACTUALLY
    performed, across every channel, and emit one global `niche.rpm`.

    This is the roadmap's highest-value decision — *what to make a video about* —
    answered from measured results. A niche lives at the channel level (a video
    row has no niche of its own), so this is the one pass that is cross-channel
    by nature: it buckets every channel's videos by the niche its channel runs,
    then ranks. Views and CTR always inform the ranking; real per-video revenue
    (roadmap #71), once persisted, feeds `revenue_by_video` for a true RPM — a
    deliberate follow-up, not wired here.

    Advisory only: it emits a ranking for the planner/human to consult. It never
    changes niche selection on its own. Never raises."""
    from modules import niche_rpm

    try:
        channels = ChannelRegistry().list()
    except Exception as e:
        logger.warning("Channel registry unavailable (%s: %s) — skipping niche RPM ranking",
                       type(e).__name__, e)
        return {}

    channel_niche = {str(c.channel_id): c.niche for c in channels if c.niche}
    if not channel_niche:
        logger.info("No channel niches known — niche RPM ranking skipped")
        return {}

    try:
        with StateStore() as store:
            videos = store.list_videos(limit=100000)
            metrics_by_video: dict = {}
            for v in videos:
                vid = v.get("video_id")
                if not vid:
                    continue
                m = store.latest_metrics(vid)
                if m is not None:
                    metrics_by_video[vid] = m

        signals = niche_rpm.evaluate_by_channel_niche(videos, metrics_by_video, channel_niche)
        summary = niche_rpm.summarize(signals)
        events.emit(events.NICHE_RPM, agent="niche_rpm", status=events.STATUS_COMPLETED,
                    channel_id=None, metadata=summary)
        logger.info("Niche RPM ranking: %d niche(s), best: %s",
                    summary.get("niche_count", 0), summary.get("best_niche") or "—")
        return summary
    except Exception:
        logger.exception("Niche RPM ranking failed; ranking nothing")
        return {}


def allocate_upload_quota() -> dict:
    """Recommend how the day's upload budget should split across channels by
    measured performance, and emit one global `quota.allocated`.

    The budget (`CHRONOS_DAILY_UPLOAD_SLOTS`) is the operator's; unset, it
    defaults to one slot per channel so the pass still runs meaningfully. Every
    channel keeps a reserved baseline, so a brand-new channel is never starved
    of the chance to gather the data that would earn it more. Advisory only — it
    recommends a split for the scheduler/human, it never schedules or publishes.
    Never raises."""
    from modules import quota_allocator

    try:
        channels = ChannelRegistry().list()
    except Exception as e:
        logger.warning("Channel registry unavailable (%s: %s) — skipping quota allocation",
                       type(e).__name__, e)
        return {}

    channel_ids = [str(c.channel_id) for c in channels]
    if not channel_ids:
        logger.info("No channels known — upload quota allocation skipped")
        return {}
    names = {str(c.channel_id): (c.name or str(c.channel_id)) for c in channels}

    raw = os.getenv("CHRONOS_DAILY_UPLOAD_SLOTS", "").strip()
    try:
        total_slots = int(raw) if raw else len(channel_ids)
    except ValueError:
        logger.warning("Ignoring CHRONOS_DAILY_UPLOAD_SLOTS=%r — not an integer; using channel count", raw)
        total_slots = len(channel_ids)

    try:
        with StateStore() as store:
            scores, allocation = quota_allocator.recommend_with_scores(store, channel_ids, total_slots)
        summary = quota_allocator.summarize(scores, allocation, total_slots=total_slots, names=names)
        events.emit(events.QUOTA_ALLOCATED, agent="quota_allocator", status=events.STATUS_COMPLETED,
                    channel_id=None, metadata=summary)
        logger.info("Upload quota: %d slot(s) across %d channel(s)", total_slots, len(channel_ids))
        return summary
    except Exception:
        logger.exception("Quota allocation failed; allocating nothing")
        return {}


def check_durability() -> dict:
    """Write a JSON snapshot of the local state and check whether history is
    mirrored off-box, emitting one `durability.check`. The whole history lives in
    an ephemeral Actions cache, so this run's job is to hedge that: a JSON backup
    on disk (kept in the cached `history/`) plus an honest report of how many
    local videos are not yet in Supabase. Advisory — it reports and backs up, it
    never deletes or overwrites history. Never raises."""
    try:
        from config import HISTORY_DIR
        from modules import durability

        sync = SupabaseSync()
        snapshot_path = HISTORY_DIR / "durability_snapshot.json"
        with StateStore() as store:
            report = durability.run_durability_check(
                store, sync if sync.enabled else None, snapshot_path=snapshot_path)
        summary = report.to_dict()
        logger.info("Durability: local=%s remote=%s mirrored=%s",
                    summary.get("local_videos"), summary.get("remote_videos"), summary.get("mirrored"))
        return summary
    except Exception:
        logger.exception("Durability check failed; reporting nothing")
        return {}


def mirror_to_supabase() -> dict:
    """Mirror the current local state into Supabase for the Command Center.
    No-op (returns {}) when SUPABASE_URL / SUPABASE_SERVICE_KEY aren't set, so
    the bot stays fully local until you provision Supabase. Never raises.

    Mirrors two things: the StateStore tables, and the operational state the
    bot keeps under history/ (ContentPlanner's queue and PipelineStateMachine's
    runs, both restored between workflow runs by actions/cache). The second is
    observability only — nothing reads those rows back into the pipeline.
    """
    sync = SupabaseSync()
    if not sync.enabled:
        return {}
    counts: dict = {}
    try:
        with StateStore() as store:
            counts.update(sync.mirror_from_store(store))
    except Exception as e:
        logger.warning("Supabase mirror failed (%s: %s)", type(e).__name__, e)
    try:
        counts.update(sync.mirror_planner_and_runs())
    except Exception as e:
        logger.warning("Supabase operational mirror failed (%s: %s)", type(e).__name__, e)
    try:
        counts.update(sync.mirror_channels())
    except Exception as e:
        logger.warning("Supabase channel mirror failed (%s: %s)", type(e).__name__, e)
    return counts


def main():
    parser = argparse.ArgumentParser(description="Nightshift intelligence poll")
    parser.add_argument("--skip-comments", action="store_true", help="Skip the comment fetch/classify pass")
    parser.add_argument("--skip-planning", action="store_true", help="Skip feeding suggestions into the content planner queue")
    parser.add_argument("--skip-feedback", action="store_true", help="Skip the feedback-loop scoring pass")
    parser.add_argument("--skip-mirror", action="store_true", help="Skip mirroring state to Supabase")
    args = parser.parse_args()

    logger.info("=== Intelligence poll starting ===")
    events.emit(events.SYSTEM_HEARTBEAT, agent="intelligence_poll", status=events.STATUS_RUNNING)

    try:
        summary = IntelligencePoller().run_all(competitor_channel_ids=_competitor_channel_ids())
        logger.info("Analytics/competitor/trend summary: %s", summary)
        poll_additional_channel_metrics()
    except Exception as e:
        # IntelligencePoller() eagerly authenticates AnalyticsClient at
        # construction time — an auth failure there must not take down the
        # independent comment-polling pass below.
        logger.warning(
            "IntelligencePoller failed (%s: %s) — analytics/competitor/trend pass skipped for this run",
            type(e).__name__, e,
        )

    channels = _active_channels()

    if not args.skip_comments:
        with StateStore() as store:
            for channel in channels:
                # Wrapped per channel: one channel's revoked comment scope must
                # not cost the others their audience-demand pass.
                try:
                    poll_comments_for_recent_videos(store, channel=channel)
                except Exception as e:
                    logger.warning("[channel: %s] comment poll failed (%s: %s) — other channels unaffected",
                                   channel.channel_id if channel else DEFAULT_CHANNEL_ID,
                                   type(e).__name__, e)
    else:
        logger.info("Comment polling skipped (--skip-comments)")

    if not args.skip_planning:
        for channel in channels:
            try:
                enqueue_topic_suggestions(channel=channel)
            except Exception as e:
                logger.warning("[channel: %s] topic suggestion failed (%s: %s) — other channels unaffected",
                               channel.channel_id if channel else DEFAULT_CHANNEL_ID,
                               type(e).__name__, e)
    else:
        logger.info("Content planning skipped (--skip-planning)")

    if not args.skip_feedback:
        run_feedback_analysis()
    else:
        logger.info("Feedback scoring skipped (--skip-feedback)")

    # Cross-channel niche RPM ranking — a single global pass after every
    # channel's metrics are in. Defensive on its own; a failure here never
    # affects the mirror below.
    rank_niches_across_channels()

    # Cross-channel upload-quota allocation — another global pass, split the
    # day's budget across channels by measured performance. Also defensive.
    allocate_upload_quota()

    if not args.skip_mirror:
        mirror_to_supabase()
    else:
        logger.info("Supabase mirror skipped (--skip-mirror)")

    # State durability — after the mirror, snapshot local state and report how
    # much of it is safely off-box. The history lives in an ephemeral cache, so
    # this is the run that hedges against losing it. Defensive; never raises.
    check_durability()

    logger.info("=== Intelligence poll done ===")


if __name__ == "__main__":
    main()
