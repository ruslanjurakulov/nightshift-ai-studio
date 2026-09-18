"""Event log — structured observability events for the Command Center.

`emit()` records a SystemEvent into StateStore's `system_events` table. That
table is the data source for the monitoring Command Center's Live Activity
Feed, agent status, and per-video pipeline timeline. Every important lifecycle
moment in the pipeline and the intelligence poll emits one.

Two hard guarantees:

1. **emit() never raises and never changes behavior.** Observability must not
   be able to break video generation, upload, or a scheduled poll. Any failure
   to record an event is swallowed with a warning and the caller proceeds.

2. **No secret ever enters the event stream.** `metadata` is sanitized before
   storage: any key whose name looks credential-bearing (token, key, secret,
   password, cookie, credential, authorization, ...) is dropped and replaced
   with a redaction marker, so an accidental `emit(..., metadata={"api_key": ...})`
   cannot leak.

Event names follow a `noun.verb` convention (`topic.selected`, `render.progress`,
`upload.completed`, `feedback.applied`, ...). The common ones are exported as
constants below; callers may also pass any string.

Storage note: `emit()` opens a short-lived StateStore per call when one isn't
injected. The event volume is low (a dozen or so per video run, a handful per
poll), so this is simpler and safer than sharing a long-lived connection across
the whole pipeline; a test or hot path can inject a store to avoid re-opening.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

# -- canonical event names --------------------------------------------------
# System / heartbeat
SYSTEM_STARTED = "system.started"
SYSTEM_HEARTBEAT = "system.heartbeat"
# Agents (a logical worker: topic manager, script engine, poller, ...)
AGENT_STARTED = "agent.started"
AGENT_COMPLETED = "agent.completed"
AGENT_FAILED = "agent.failed"
# Autopilot agent (modules/agent_planner.py). Advisory: the day's chosen topic,
# the ranked reason it is trending, and the generation prompts — the plan that
# drove this run's content. Off by default; it decides WHAT to make, the
# pre-publish gate still decides whether it ships.
AGENT_PLAN = "agent.plan"
# Jobs (a unit of scheduled work)
JOB_CREATED = "job.created"
JOB_STARTED = "job.started"
JOB_COMPLETED = "job.completed"
JOB_FAILED = "job.failed"
# Pipeline stages
TOPIC_SELECTED = "topic.selected"
RESEARCH_STARTED = "research.started"
RESEARCH_COMPLETED = "research.completed"
# Packaging is decided BEFORE the script (modules/title_planner.py): the title
# and a thumbnail concept come first, and the script is written to deliver them.
TITLE_PLANNED = "title.planned"
SCRIPT_STARTED = "script.started"
SCRIPT_COMPLETED = "script.completed"
VOICE_STARTED = "voice.started"
VOICE_COMPLETED = "voice.completed"
MEDIA_STARTED = "media.started"
MEDIA_COMPLETED = "media.completed"
# AI-generated b-roll (modules/minimax_broll.py + minimax_client.py). Optional and
# off by default: when enabled, MiniMax H3 generates an on-topic clip for a few
# sections instead of pulling stock. `broll.generated` records how many clips were
# actually produced; a generation failure is never a run failure — the section
# falls back to Pexels stock and the video still renders.
BROLL_GENERATED = "broll.generated"
# AI-generated stills (modules/image_providers.py + Leonardo). Optional and off
# by default: when enabled, a bespoke on-topic image is generated for a few
# sections instead of Pexels stock. `image.generated` records how many were
# produced; a failure is never a run failure — the section falls back to stock.
IMAGE_GENERATED = "image.generated"
# Director Mode (modules/director.py). Advisory: the per-scene cinematic shot
# plan (camera/lens/lighting/mood/motion) used for this run. Never gates.
DIRECTOR_PLAN = "director.plan"
# Character Bible / Elements Library (modules/elements.py). Advisory: which
# reusable characters/locations/props were applied to this run's scenes for
# visual consistency. Never gates.
ELEMENTS_APPLIED = "elements.applied"
RENDER_STARTED = "render.started"
RENDER_COMPLETED = "render.completed"
RENDER_FAILED = "render.failed"
# AITuber presenter (modules/avatar.py). Optional, off by default; a run stays
# faceless unless a channel/series enables it. `avatar.skipped` records the
# common case (no presenter asked for); `avatar.failed` records an enabled-but-
# -unconfigured or refused request — the run then continues faceless (a wrong or
# blank presenter is never shipped), it never means the video failed.
AVATAR_STARTED = "avatar.started"
AVATAR_COMPLETED = "avatar.completed"
AVATAR_SKIPPED = "avatar.skipped"
AVATAR_FAILED = "avatar.failed"
THUMBNAIL_STARTED = "thumbnail.started"
THUMBNAIL_COMPLETED = "thumbnail.completed"
UPLOAD_STARTED = "upload.started"
UPLOAD_COMPLETED = "upload.completed"
UPLOAD_FAILED = "upload.failed"
VIDEO_PUBLISHED = "video.published"
# The pre-publish gate (Phase 6). `publish.blocked` is the only event in this
# vocabulary that records something the pipeline REFUSED to do.
PUBLISH_BLOCKED = "publish.blocked"
PUBLISH_ALLOWED = "publish.allowed"
# The gate allowed the video, but the channel's auto-publish is OFF, so the
# upload is held for a human to publish. This is a policy hold, never a gate
# failure — `publish.allowed` still fired; the video is finished and on disk.
PUBLISH_HELD = "publish.held"
# Advisory pre-publish intelligence (modules/publish_score.py). Records a
# quality/prediction score for a human to read; it never gates, blocks, or
# permits anything — the gate above is the only thing that decides publishing.
PUBLISH_SCORE = "publish.score"
# Shorts. A short only ever exists downstream of a long video that published,
# so `short.failed` never means the run failed — the video is already out.
SHORT_STARTED = "short.started"
SHORT_COMPLETED = "short.completed"
SHORT_FAILED = "short.failed"
# Run checkpoint / resume (modules/run_checkpoint.py). `run.resumed` records a
# run that reused a crashed run's saved artifacts (today: the script, skipping
# the paid Gemini generation). Advisory bookkeeping — it never changes what is
# produced, only what gets re-paid-for.
RUN_RESUMED = "run.resumed"
# Channels (Phase 5). Lifecycle only — the per-stage events above already
# carry a channel_id, so there is no channel.job.* duplicate of job.*.
CHANNEL_CREATED = "channel.created"
CHANNEL_UPDATED = "channel.updated"
CHANNEL_PAUSED = "channel.paused"
CHANNEL_ACTIVATED = "channel.activated"
CHANNEL_OAUTH_CONNECTED = "channel.oauth.connected"
CHANNEL_OAUTH_FAILED = "channel.oauth.failed"
# Telegram control panel (modules/telegram_control.py + tools/run_telegram_control.py).
# `telegram.command` records an admin command the transport routed — a read query
# or an action INTENT. It records intents for observability and a driver to act
# on; the transport itself never uploads or flips a channel's autonomy, and an
# action still runs through the normal gated pipeline.
TELEGRAM_COMMAND = "telegram.command"
# Credential health preflight (modules/credential_health.py). Advisory: reports
# which credentials a run needs and whether they are present, before it spends.
CREDENTIAL_HEALTH = "credential.health"
# Per-channel spend ceiling (modules/budget.py). `budget.preflight` records the
# channel's spend vs its ceiling before a run; `budget.exceeded` records a run
# stopped BEFORE spending because the ceiling was already met. Off unless a
# channel sets a ceiling; a data gap (unpriced costs) never triggers a block.
BUDGET_PREFLIGHT = "budget.preflight"
BUDGET_EXCEEDED = "budget.exceeded"
# Spend forecast (modules/budget.py). Advisory: a straight-line projection of
# the channel's month-end spend, flagging when the pace is on track to blow a
# set ceiling. It forecasts for a human/Command Center — it never blocks a run.
BUDGET_FORECAST = "budget.forecast"
# All-Accounts spend overview (modules/spend_overview.py). Advisory: month-to-date
# spend rolled up across every channel, per provider/unit, with a month-end
# projection and — where a ceiling is set — how many more videos the budget
# covers. USD only when priced (null ≠ 0); it reports, it never blocks.
SPEND_OVERVIEW = "spend.overview"
# Analytics / feedback loop
ANALYTICS_UPDATED = "analytics.updated"
FEEDBACK_GENERATED = "feedback.generated"
FEEDBACK_APPLIED = "feedback.applied"
# Series playlist (modules/playlist.py). Best-effort, downstream of a live
# video: `playlist.failed` never means the run failed — the video is published.
PLAYLIST_ADDED = "playlist.added"
PLAYLIST_FAILED = "playlist.failed"
# Engagement comment (modules/pinned_comment.py). The channel's own first comment
# — an on-topic question — posted right after a video publishes; the creator pins
# it in one tap (the Data API can't pin). Best-effort and downstream of a live
# video: `comment.failed`/`comment.skipped` never mean the run failed.
COMMENT_POSTED = "comment.posted"
COMMENT_SKIPPED = "comment.skipped"
COMMENT_FAILED = "comment.failed"
# Re-package underperformers (modules/repackage.py). Advisory: flags published
# videos whose CTR is well below the channel's own median as candidates for a
# new title/thumbnail. It never edits a live video — like publish.score it
# informs a human/Command Center, it does not act.
REPACKAGE_SUGGESTED = "repackage.suggested"
# Watch-next link (modules/watch_next.py). A "▶ WATCH NEXT" link into another of
# the channel's videos, added to the description (the API can't set end screens).
# Best-effort description text: it never changes what publishes or when.
WATCH_NEXT_LINKED = "watchnext.linked"
# Publish-time optimizer (modules/publish_timing.py). Advisory: the hour (UTC)
# and weekday this channel's best-performing videos were published, for the
# scheduler/human to use. It never reschedules or holds a run on its own.
PUBLISH_TIMING = "publish.timing"
# Niche RPM intelligence (modules/niche_rpm.py). Advisory: a ranking of niches
# by measured performance for a human/scheduler to consult. It never changes
# niche selection on its own — like publish.score, it informs, it does not gate.
NICHE_RPM = "niche.rpm"
# Sponsorship pricing (modules/sponsorship.py). Advisory: a suggested price for
# one integrated sponsor slot, from the channel's measured average views × a
# configured sponsorship CPM (USD). It informs a human's negotiation — it never
# contacts a sponsor, sells a slot, or commits to a price.
SPONSORSHIP_ESTIMATE = "sponsorship.estimate"
# Revenue tracking (modules/revenue_tracker.py). Advisory: the channel's real
# estimatedRevenue (USD) and RPM, read back from YouTube Analytics for a
# human/Command Center. A video with no reported revenue is "unknown", never
# $0. It never gates a publish or changes niche selection — it reports.
REVENUE_TRACKED = "revenue.tracked"
# vidIQ research & scoring (modules/vidiq.py). Advisory: `vidiq.research` records
# a ranking of keyword opportunities; `vidiq.scored` a ranking of candidate
# titles by vidIQ's title score. Research and scoring ONLY — it never selects a
# topic, edits a title, gates a publish, or runs a second pipeline; it informs.
VIDIQ_RESEARCH = "vidiq.research"
VIDIQ_SCORED = "vidiq.scored"
# Viral Remix (modules/remix.py). `remix.planned` records an eligible, rights-clean
# remix plan (a NEW transformative work, still gated); `remix.blocked` records a
# source refused for lacking an asserted rights basis. Off unless a channel opts in;
# neither event ever weakens or skips the pre-publish gate the remix output faces.
REMIX_PLANNED = "remix.planned"
REMIX_BLOCKED = "remix.blocked"
# Quota allocation (modules/quota_allocator.py). Advisory: the recommended split
# of a day's upload budget across channels by measured performance, with a
# reserved baseline per channel. It recommends for a scheduler/human — it never
# schedules or publishes anything itself.
QUOTA_ALLOCATED = "quota.allocated"
# State durability (modules/durability.py). Advisory: whether the ephemeral
# local history is safely mirrored to Supabase, and when a JSON backup was
# written. It never deletes or overwrites history — it reports and backs up.
DURABILITY_CHECK = "durability.check"

# Status vocabulary (free-form, but these are the common ones).
STATUS_RUNNING = "running"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"

# Substrings that mark a metadata key as credential-bearing. Case-insensitive.
_SENSITIVE_KEY_MARKERS = (
    "token", "secret", "password", "passwd", "cookie", "credential",
    "authorization", "auth", "api_key", "apikey", "access_key", "private",
    "client_secret", "refresh",
)
_REDACTED = "[redacted]"


def _looks_sensitive(key: str) -> bool:
    lowered = str(key).lower()
    # A bare "key" is too broad (video_key, topic_key are innocent), so only
    # redact when the name carries one of the credential markers.
    return any(marker in lowered for marker in _SENSITIVE_KEY_MARKERS)


def _sanitize(metadata: dict | None) -> str | None:
    """Serialize metadata to JSON with credential-bearing keys redacted.

    Returns None for empty/None input. Never raises: anything that won't
    serialize is coerced to its repr so an odd value can't break emit().
    """
    if not metadata:
        return None
    safe: dict = {}
    for key, value in metadata.items():
        safe[key] = _REDACTED if _looks_sensitive(key) else value
    try:
        return json.dumps(safe, ensure_ascii=False, default=repr)
    except Exception:
        # Last-resort: never let metadata serialization break an emit.
        return json.dumps({"_unserializable": repr(safe)}, ensure_ascii=False)


def emit(
    event: str,
    *,
    video_id: str | None = None,
    job_id: str | None = None,
    agent: str | None = None,
    status: str | None = None,
    duration_ms: float | None = None,
    metadata: dict | None = None,
    channel_id: str | None = None,
    store=None,
) -> bool:
    """Record one observability event. Returns True on success, False if it was
    swallowed. Never raises.

    Pass `store` (an open StateStore) on a hot path to avoid re-opening the DB;
    otherwise a short-lived store is opened and closed for this one event.

    `channel_id` marks the event as one channel's work. Leave it None for
    genuinely global events — a system heartbeat or an infrastructure failure
    belongs to no channel, and tagging it with one would make the Command
    Center attribute shared infrastructure to whichever channel ran last.
    """
    try:
        ts = datetime.utcnow().isoformat()
        payload = _sanitize(metadata)
        if store is not None:
            store.record_event(
                event=event, ts=ts, video_id=video_id, job_id=job_id,
                agent=agent, status=status, duration_ms=duration_ms, metadata=payload,
                channel_id=channel_id,
            )
            return True
        from modules.state_store import StateStore

        with StateStore() as own_store:
            own_store.record_event(
                event=event, ts=ts, video_id=video_id, job_id=job_id,
                agent=agent, status=status, duration_ms=duration_ms, metadata=payload,
                channel_id=channel_id,
            )
        return True
    except Exception as e:
        logger.warning("Failed to record event %r (%s: %s) — continuing", event, type(e).__name__, e)
        return False
