#!/usr/bin/env python3
"""
Nightshift YouTube Bot — Full Pipeline
  1. Topic Manager       → picks fresh viral topic
  2. Script Engine       → Gemini Hook + Story + Open Loops + SFX/Music cues
  3. Audio Mixer         → TTS multi-voice + SFX + dynamic music
  4. Media Fetcher       → Pexels HD videos + images
  5. Subtitle Generator  → Whisper word-by-word animated captions
  6. Thumbnail Generator → A/B Pillow thumbnails
  7. Compositor          → MoviePy final .mp4
  8. YouTube Uploader    → auto-upload via YouTube Data API v3
"""

import argparse
import json
import logging
import re
import sys
import time
from datetime import datetime
from pathlib import Path

# Ensure required directories exist before any imports that may reference them
Path("logs").mkdir(exist_ok=True)
Path("history").mkdir(exist_ok=True)
Path("output").mkdir(exist_ok=True)

import config
from config import OUTPUT_DIR, THUMBNAIL_VARIANT_COUNT, VIDEO_HEIGHT, VIDEO_WIDTH, YOUTUBE_CATEGORY_ID, YOUTUBE_PRIVACY
from modules import event_log as events
from modules import publish_gate
from modules import publish_score
from modules import video_critic
from modules import video_qc
from modules.ab_testing import choose_variant_n, variant_performance_n
from modules.hook_ab import choose_hook, hook_performance
from modules.avatar import (
    AvatarUnavailable, UnsafeAvatarRequest, maybe_generate_presenter, resolve_avatar_config,
)
from modules.audio_mixer import AudioMixer, VoiceUnavailable, verify_voice
from dataclasses import replace as _dc_replace
from modules.channels import ChannelContext, resolve_channel
from modules.credential_health import check_run_credentials
from modules.cost_ledger import (
    CostLedger, IMAGE_GENERATIONS, PEXELS_REQUESTS, RENDER_SECONDS, TTS_CHARACTERS,
    UPLOAD_BYTES, VIDEO_GEN_CLIPS,
)
from modules import budget
from modules import shorts
from modules.claim_extractor import extract_section_claims
from modules import claim_scenes
from modules.compositor import Compositor
from modules import render_dispatch
from modules.resource_monitor import MemorySampler, log_usage
from modules.video_review import VideoReview
from modules.fact_checker import fact_check_claims
from modules.media_fetcher import MediaFetcher
from modules import pinned_comment
from modules import playlist
from modules import watch_next
from modules.pipeline_stages import PipelineStage, PipelineStateMachine
from modules.research_engine import research_topic
from modules import run_checkpoint, upload_idempotency
from modules import video_ir
from modules.script_engine import ScriptEngine
from modules.series import (
    effective_cadence, effective_niche, effective_visual_style, effective_voice_style,
    resolve_series, style_keywords,
)
from modules.state_store import StateStore
from modules import strategy
from modules.subtitle_generator import SubtitleGenerator
from modules.thumbnail_generator import ThumbnailGenerator
from modules import title_formulas
from modules.title_planner import plan_titles
from modules.topic_manager import TopicManager
from modules.youtube_uploader import YouTubeUploader
from tools.generate_assets import ensure_assets

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("logs/run.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger("chronos")


#: The thumbnail A/B arms, widened past two by config.THUMBNAIL_VARIANT_COUNT
#: (roadmap #58). "A"/"B" keep their old look; C/D are distinct styles
#: (modules/thumbnail_generator.py). Count 2 = today's A/B exactly.
_VARIANT_LABELS = ("A", "B", "C", "D")


def _variant_arms() -> tuple:
    """The variant labels this run experiments across (2..4, config-driven)."""
    n = max(2, min(len(_VARIANT_LABELS), int(THUMBNAIL_VARIANT_COUNT)))
    return _VARIANT_LABELS[:n]


def _pick_variant(channel_id: str) -> str:
    """Which thumbnail arm this video ships on.

    Reads the channel's own published count and current verdict across all
    configured arms. Any failure falls back to "A", which is exactly what the
    pipeline did before this existed — a broken experiment must not stop a video.
    """
    arms = _variant_arms()
    try:
        with StateStore() as store:
            videos = store.list_videos(limit=100000, channel_id=channel_id)
            snapshots = [
                m
                for v in videos
                if (m := store.latest_metrics(v.get("video_id", ""))) is not None
            ]
        return choose_variant_n(len(videos), arms, variant_performance_n(videos, snapshots, arms))
    except Exception as e:
        logger.warning("A/B variant selection failed (%s: %s) — shipping A", type(e).__name__, e)
        return "A"


def _pick_hook(channel_id: str) -> str:
    """Which first-30-seconds opening this video ships on (roadmap #60).

    Judged on retention, not click-through (modules/hook_ab.py). Any failure
    falls back to "A" — the original opening — so a broken hook experiment never
    stops a video, exactly like the thumbnail A/B fallback.
    """
    try:
        with StateStore() as store:
            videos = store.list_videos(limit=100000, channel_id=channel_id)
            snapshots = [
                m
                for v in videos
                if (m := store.latest_metrics(v.get("video_id", ""))) is not None
            ]
        return choose_hook(len(videos), hook_performance(videos, snapshots))
    except Exception as e:
        logger.warning("Hook A/B selection failed (%s: %s) — shipping A", type(e).__name__, e)
        return "A"


def _title_seeds(channel_id: str, topic: str) -> tuple:
    """Proven-formula title seeds for this topic, from the channel's own
    best-CTR title shapes. Advisory input to the title planner; any failure
    returns no seeds, so title planning is exactly as it was before this
    existed. See modules/title_formulas.py."""
    try:
        with StateStore() as store:
            videos = store.list_videos(limit=100000, channel_id=channel_id)
            metrics = {
                v["video_id"]: m
                for v in videos
                if v.get("video_id") and (m := store.latest_metrics(v["video_id"])) is not None
            }
        stats = title_formulas.rank_formulas_by_ctr(videos, metrics)
        return title_formulas.seed_titles(topic, title_formulas.best_formulas(stats, k=2))
    except Exception as e:
        logger.warning("Title-formula seeding failed (%s: %s) — planning without seeds",
                       type(e).__name__, e)
        return ()


def _active_video_provider() -> str:
    """The selected video-gen provider for the agent's plan record. Defaults to
    'minimax' and reads config defensively so it works whether or not the
    provider-router change is present."""
    return (getattr(config, "VIDEO_PROVIDER", "minimax") or "minimax").strip().lower()


def _agent_pick_topic(channel_id, *, video_provider: str = "minimax"):
    """Autopilot: pick the day's topic from this channel's own trend / competitor
    / demand intelligence and emit an ``agent.plan`` event with the ranked reason
    it is trending. Returns the topic string, or ``None`` to fall back to the
    normal topic manager (the common case until intelligence data exists). Never
    raises — a planning failure must never stop a run."""
    try:
        from modules import agent_planner
        from modules.topic_recommender import TopicRecommender
        with StateStore() as store:
            recommender = TopicRecommender(state_store=store, channel_id=channel_id)
            plan = agent_planner.build_plan(
                recommender,
                channel_id=channel_id,
                video_provider=video_provider,
                voice_provider=getattr(config, "TTS_PROVIDER", ""),
            )
        if plan is None:
            return None
        events.emit(events.AGENT_PLAN, agent="agent", status=events.STATUS_COMPLETED,
                    channel_id=channel_id, metadata=agent_planner.summarize(plan))
        logger.info("Autopilot topic: %s (%s)", plan.topic, plan.source or "ranked")
        return plan.topic
    except Exception as e:
        logger.warning("Autopilot planning failed (%s: %s) — using topic manager",
                       type(e).__name__, e)
        return None


def _channel_strategy_note(channel_id: str) -> str:
    """A channel-lifecycle strategy note for the script prompt, from how many
    videos this channel has published and how old it is (see modules/strategy.py).
    Advisory prompt text; any failure returns "" so the prompt is unchanged."""
    try:
        with StateStore() as store:
            videos = store.list_videos(limit=100000, channel_id=channel_id)
        count = len(videos)
        age_days = None
        stamps = [str(v.get("published_at") or "") for v in videos if v.get("published_at")]
        if stamps:
            oldest = min(stamps)
            try:
                dt = datetime.fromisoformat(oldest.replace("Z", "+00:00"))
                now = datetime.now(dt.tzinfo) if dt.tzinfo else datetime.utcnow()
                age_days = max(0.0, (now - dt).total_seconds() / 86400.0)
            except (ValueError, TypeError):
                age_days = None
        return strategy.adaptive_strategy(count, age_days)
    except Exception as e:
        logger.warning("Strategy note failed (%s: %s) — writing without it", type(e).__name__, e)
        return ""


def _publish_short(
    *,
    ctx,
    script,
    slug: str,
    source_video: Path,
    parent_video_id: str,
    parent_url: str | None,
    topic: str,
    privacy: str,
    timeline: list,
    costs,
):
    """Cut and publish a vertical Short from the video that just went out.

    Off unless the channel asked for it — a Short is a second videos.insert,
    roughly another 1600 quota units out of the 10,000 a day. Everything here
    is best-effort: the long video has already published, so nothing below may
    turn a successful run into a failed one.
    """
    channel_id = ctx.channel_id
    config = shorts.ShortsConfig.from_channel(ctx)
    if not config.enabled:
        return

    seconds = shorts.hook_window(timeline, max_seconds=config.max_seconds)
    if seconds is None:
        logger.info("[channel: %s] No usable hook window — no Short this run", channel_id)
        return

    events.emit(events.SHORT_STARTED, agent="shorts", status=events.STATUS_RUNNING,
                channel_id=channel_id, video_id=parent_video_id,
                metadata={"seconds": round(seconds, 1)})

    started = time.monotonic()
    short_path = shorts.render_short(
        source_video=source_video,
        out_path=OUTPUT_DIR / slug / "short.mp4",
        seconds=seconds,
    )
    costs.add(RENDER_SECONDS, time.monotonic() - started, stage="short_render")
    if short_path is None:
        events.emit(events.SHORT_FAILED, agent="shorts", status=events.STATUS_FAILED,
                    channel_id=channel_id, video_id=parent_video_id,
                    metadata={"operation": "render"})
        return

    try:
        uploader = YouTubeUploader(channel=ctx)
        uploaded = uploader.upload(
            short_path,
            script,
            thumbnail_path=None,
            privacy=privacy,
            title_override=shorts.short_title(script.title),
            description_override=shorts.short_description(
                script.title, parent_url, hook=getattr(script, "hook_sentence", "")),
        )
        try:
            costs.add(UPLOAD_BYTES, float(short_path.stat().st_size), stage="short_upload")
        except OSError:
            logger.debug("Could not stat %s for the cost ledger", short_path, exc_info=True)

        with StateStore() as store:
            store.record_video(
                video_id=uploaded["id"],
                topic=topic,
                title=shorts.short_title(script.title),
                slug=slug,
                published_at=datetime.utcnow().isoformat(),
                privacy=privacy,
                category_id=YOUTUBE_CATEGORY_ID,
                local_path=str(short_path),
                channel_id=channel_id,
                # No A/B on the Short: it ships the long video's own frames, so
                # attributing a variant to it would double-count the experiment.
                video_format="short",
                parent_video_id=parent_video_id,
            )
            events.emit(events.SHORT_COMPLETED, agent="shorts", status=events.STATUS_COMPLETED,
                        channel_id=channel_id, video_id=uploaded["id"],
                        metadata={"url": uploaded["url"], "parent_video_id": parent_video_id},
                        store=store)
        logger.info("[channel: %s] Short published: %s", channel_id, uploaded["url"])
        print(f"\n✓ Short published: {uploaded['url']}")
    except Exception as e:
        logger.warning("[channel: %s] Short upload failed (%s: %s) — the long video is already out",
                       channel_id, type(e).__name__, e)
        events.emit(events.SHORT_FAILED, agent="shorts", status=events.STATUS_FAILED,
                    channel_id=channel_id, video_id=parent_video_id,
                    metadata={"operation": "upload", "error": f"{type(e).__name__}: {e}"})


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:50]


def run(
    niche: str | None = None,
    topic: str | None = None,
    privacy: str = YOUTUBE_PRIVACY,
    skip_upload: bool = False,
    script_file: str | None = None,
    channel: ChannelContext | str | None = None,
    series: str | None = None,
    resume: bool = False,
    duration: int | None = None,
    language: str | None = None,
    visual_style: str | None = None,
):
    """Run the pipeline once, for one channel.

    `channel` is a ChannelContext, a channel id, or None for the default
    channel — which, with nothing configured, is the single channel this bot has
    always run as. Every stage below receives that context rather than reading a
    global, so two channels can run side by side (or in the same test) without
    either seeing the other's voice, style, credentials or history.

    `niche` overrides the channel's own niche for this run; None uses the
    channel's.

    `duration`, `language` and `visual_style` are optional per-run controls (the
    site's "Run now" and the workflow_dispatch inputs). Each overrides just this
    one run — the channel's stored configuration is untouched — and each is None
    when the operator left it blank, which keeps the channel's own value exactly
    as before. `duration` is a target length in seconds; `language` is the script
    language; `visual_style` is a look directive (or a style-preset name) that
    wins over the series' and the channel's own style for this run only.
    """
    Path("logs").mkdir(exist_ok=True)
    ctx = channel if isinstance(channel, ChannelContext) else resolve_channel(channel)
    # Per-run overrides for the generator settings. AgentConfig and
    # ChannelContext are frozen, so this builds an overridden COPY for this run
    # rather than mutating shared state — two channels (or two tests) in one
    # process never see each other's overrides, and the stored channel is
    # unchanged. A blank/None value leaves the channel's own setting in place.
    agent_overrides: dict = {}
    if language and language.strip():
        agent_overrides["language"] = language.strip()
    if duration and duration > 0:
        agent_overrides["target_duration_seconds"] = int(duration)
    if agent_overrides:
        ctx = _dc_replace(ctx, agent=_dc_replace(ctx.agent, **agent_overrides))
    channel_id = str(ctx.channel_id)
    # A series is an optional recurring content line within the channel. When
    # given, its niche seeds this run (unless --niche was passed explicitly) and
    # its style/cadence shape the run below. See modules/series.py; resolution
    # never raises.
    series_obj = resolve_series(series)
    niche = effective_niche(niche, series_obj, ctx.niche)
    # A series carries more than a niche: its look (biases b-roll and, with the
    # avatar on, the presenter), its narration style (a recorded hint), and its
    # cadence. All empty when there is no series — the run then behaves exactly
    # as before.
    #
    # The channel's own visual style is the base look, below any series override:
    # what the Studio Canvas writes when an operator applies a preset (or the
    # free-form style typed when the channel was created). Passing it as the
    # channel default means that choice actually reaches the pipeline; an empty
    # channel style keeps the previous behaviour exactly.
    # A per-run visual-style override (from "Run now") is the most specific
    # opinion there is, so it leads the precedence — above the series' style and
    # the channel's own. None/blank keeps the previous behaviour exactly.
    _style_override = visual_style.strip() if visual_style and visual_style.strip() else None
    visual_style = effective_visual_style(_style_override, series_obj, ctx.agent.visual_style_prompt)
    # A channel/series may name a style preset (e.g. "cinematic-noir") instead of
    # writing a full visual-style directive; expand it to the preset's directive
    # so Director Mode and b-roll search get the rich look. A free-form style — or
    # none — is returned unchanged, so this never alters an existing channel.
    from modules import style_presets
    visual_style = style_presets.expand(visual_style)
    voice_style = effective_voice_style(None, series_obj)
    cadence = effective_cadence(series_obj)
    logger.info("=== Nightshift YouTube Bot starting [channel: %s] ===", channel_id)
    if series_obj and (visual_style or voice_style or cadence):
        logger.info("Series style — visual: %r | voice: %r | cadence: %s",
                    visual_style, voice_style, cadence)
    # Credential preflight — a safe-to-log report of which keys this run needs
    # and whether they are present, BEFORE it spends anything. Advisory: it logs
    # and emits, and never aborts on its own (verify_voice below is the one hard
    # stop, for the voice). A missing required key is surfaced loudly here so the
    # failure is legible at the top of the run rather than three paid stages in.
    try:
        health = check_run_credentials(ctx)
        if health.blocking:
            logger.error("[channel: %s] Credential preflight — MISSING required: %s",
                         channel_id, ", ".join(c.name for c in health.blocking))
        elif health.publish_blocking:
            logger.warning("[channel: %s] Credential preflight — publish token not ready: %s",
                           channel_id, ", ".join(c.name for c in health.publish_blocking))
        events.emit(events.CREDENTIAL_HEALTH, agent="credential_health",
                    status=events.STATUS_COMPLETED if health.ok else events.STATUS_FAILED,
                    channel_id=channel_id, metadata=health.to_dict())
    except Exception as e:
        logger.warning("Credential preflight failed (%s: %s) — continuing", type(e).__name__, e)
    # Spend ceiling — a hard stop BEFORE the run spends anything. Off unless this
    # channel set a ceiling; then a run that would push its known monthly spend
    # at or past the ceiling does not start. It halts spending, never the publish
    # gate, and a data gap (unpriced costs) never blocks. See modules/budget.py.
    ceiling = getattr(ctx.agent, "spend_ceiling_usd", None)
    if ceiling is not None:
        try:
            with StateStore() as _store:
                budget_status = budget.check_budget(
                    _store, channel_id, ceiling, since_iso=budget.month_start_iso())
            events.emit(events.BUDGET_PREFLIGHT, agent="budget", status=events.STATUS_COMPLETED,
                        channel_id=channel_id, metadata=budget_status.to_dict())
            if budget.should_block_run(budget_status):
                logger.error(
                    "[channel: %s] Spend ceiling reached ($%.2f of $%.2f this month) — "
                    "run stopped before spending.",
                    channel_id, budget_status.spent_usd, ceiling)
                print(f"\n⛔ Spend ceiling reached (${budget_status.spent_usd:.2f} of "
                      f"${ceiling:.2f}). Run stopped before spending.")
                events.emit(events.BUDGET_EXCEEDED, agent="budget", status=events.STATUS_FAILED,
                            channel_id=channel_id, metadata=budget_status.to_dict())
                return None
        except Exception as e:
            logger.warning("Budget preflight failed (%s: %s) — continuing without a ceiling check",
                           type(e).__name__, e)
    # What this run consumes. Recorded whether or not it ends in an upload —
    # a render that is later blocked still cost real money.
    costs = CostLedger(channel_id=channel_id)
    # Observability events (event_log.emit never raises and never alters the
    # pipeline — see modules/event_log.py). They feed the Command Center's live
    # activity feed and per-video pipeline timeline.
    _start_meta = {"channel": ctx.name, "niche": niche}
    if series_obj:
        _start_meta["series_id"] = series_obj.series_id
        if visual_style:
            _start_meta["visual_style"] = visual_style
        if voice_style:
            _start_meta["voice_style"] = voice_style
        if cadence:
            _start_meta["cadence"] = cadence
    events.emit(events.SYSTEM_STARTED, agent="pipeline", status=events.STATUS_RUNNING,
                channel_id=channel_id, metadata=_start_meta)

    # ── Stage 0: Assets
    # SFX/music are synthesized rather than committed (17MB of WAV from 12KB of
    # code). Existing files are never overwritten, so real recordings dropped
    # into assets/ as .mp3 take precedence — see tools/generate_assets.py.
    written = ensure_assets(verbose=False)
    if written:
        logger.info("Generated %d missing audio assets", written)

    # ── Stage 0b: Can this channel's narrator actually speak?
    # Checked here, before a single Gemini call, because the alternative is
    # finding out at the audio stage — after topic, research, script and
    # fact-check have been paid for. There is no fallback voice: see
    # audio_mixer.verify_voice for why a wrong-voice video is worse than none.
    try:
        verify_voice(ctx)
    except VoiceUnavailable as e:
        logger.error("Narration is not configured for channel %s: %s", channel_id, e)
        events.emit(events.AGENT_FAILED, agent="audio_mixer", status=events.STATUS_FAILED,
                    channel_id=channel_id, metadata={"error": str(e), "stage": "preflight"})
        raise

    # ── Resume a crashed run ────────────────────────────────────────────
    # With --resume, reuse a previous run's saved artifacts instead of paying to
    # regenerate them. Today that means loading the saved script.json — skipping
    # the topic/research/script Gemini calls — which is the same reuse
    # --script-file has always offered, now found automatically from the run
    # checkpoint (by topic when given, else the most recent unfinished run). A
    # stage is only reused when its files are still on disk. Off (the default) ⇒
    # the flow below is byte-for-byte unchanged, and this never raises.
    if resume and not script_file:
        resume_slug = slugify(topic) if topic else None
        cp = run_checkpoint.load(resume_slug) if resume_slug else run_checkpoint.latest_incomplete()
        saved_script = cp.artifact(run_checkpoint.STAGE_SCRIPT, "script_json") if cp else None
        if cp is not None and cp.can_resume_stage(run_checkpoint.STAGE_SCRIPT) and saved_script:
            script_file = saved_script
            topic = topic or (cp.topic or None)
            logger.info("Resuming run %r from saved script %s — skipping topic/research/script generation",
                        cp.slug, saved_script)
            events.emit(events.RUN_RESUMED, agent="pipeline", status=events.STATUS_RUNNING,
                        channel_id=channel_id,
                        metadata={"slug": cp.slug, "reused": "script",
                                  "stages_recorded": list(cp.stages.keys())})
        else:
            logger.info("Resume requested but no reusable script checkpoint found — running fresh")

    # ── Stages 1-2: Topic and Script
    # A saved script skips both Gemini calls, so a crash in a later stage — or a
    # spent daily quota — does not mean paying for generation again.
    topic_mgr = TopicManager(channel=ctx)

    if script_file:
        script = ScriptEngine.load(Path(script_file), topic)
        topic = script.topic
        logger.info("Script loaded from %s — no API calls", script_file)
    else:
        if topic is None and getattr(config, "AGENT_AUTOPILOT", False):
            topic = _agent_pick_topic(channel_id, video_provider=_active_video_provider())
        if topic is None:
            topic = topic_mgr.pick_topic(niche)
        logger.info("Topic: %s", topic)
    events.emit(events.TOPIC_SELECTED, agent="topic_manager", status=events.STATUS_COMPLETED,
                channel_id=channel_id,
                metadata={"topic": topic, **({"series_id": series_obj.series_id} if series_obj else {})})

    # ── Pipeline stage tracking (audit trail only — does NOT gate publish)
    # This run is tracked through Topic -> Research -> Script -> Fact Check ->
    # Human Approval so the record is honest about what actually happened at
    # each stage. It deliberately stops at Human Approval: approve() is never
    # called here, so the run never reaches Publish through this mechanism.
    # Upload below proceeds exactly as before, independent of this state —
    # wiring an actual approval requirement is a deliberate follow-up decision,
    # not something this pipeline enforces yet.
    pipeline = PipelineStateMachine(channel_id=channel_id)
    run_record = pipeline.start_run(topic)

    research_brief = None
    if script_file:
        pipeline.advance(run_record.run_id, PipelineStage.RESEARCH, note="skipped — script loaded from file")
    else:
        pipeline.advance(run_record.run_id, PipelineStage.RESEARCH)
        events.emit(events.RESEARCH_STARTED, agent="research_engine", status=events.STATUS_RUNNING,
                    channel_id=channel_id, metadata={"topic": topic})
        try:
            research_brief = research_topic(topic, niche)
            logger.info("Research: %d fact(s), %d open question(s)",
                        len(research_brief.key_facts), len(research_brief.open_questions))
            events.emit(events.RESEARCH_COMPLETED, agent="research_engine", status=events.STATUS_COMPLETED,
                        channel_id=channel_id,
                        metadata={"facts": len(research_brief.key_facts), "open_questions": len(research_brief.open_questions)})
        except Exception as e:
            logger.warning("Research engine failed (%s: %s) — generating script without research notes",
                            type(e).__name__, e)
            events.emit(events.AGENT_FAILED, agent="research_engine", status=events.STATUS_FAILED,
                        channel_id=channel_id, metadata={"error": f"{type(e).__name__}: {e}"})

    if not script_file:
        engine = ScriptEngine(channel=ctx)
        # Growth: decide the packaging BEFORE the script. The title and a
        # thumbnail concept are planned from the topic, then the script is
        # written to deliver on that exact promise (see modules/title_planner.py).
        # Degrades to a heuristic title if the model call fails — never blocks.
        # Seed the planner with the title shapes that have earned the best CTR
        # on THIS channel (modules/title_formulas.py). Advisory: it leads the
        # candidate list, never overrides the model. Empty for a new channel.
        seeds = _title_seeds(channel_id, topic)
        title_plan = plan_titles(topic, niche, gen=engine._gen, seed_titles=seeds)
        logger.info("Planned title: %r (%s)", title_plan.chosen, title_plan.source)
        events.emit(events.TITLE_PLANNED, agent="title_planner", status=events.STATUS_COMPLETED,
                    channel_id=channel_id,
                    metadata={"chosen": title_plan.chosen, "alt": title_plan.alt,
                              "source": title_plan.source,
                              "candidates": list(title_plan.candidates),
                              "seeded_formulas": list(seeds),
                              "thumbnail_concept": title_plan.thumbnail_concept})
        events.emit(events.SCRIPT_STARTED, agent="script_engine", status=events.STATUS_RUNNING,
                    channel_id=channel_id, metadata={"topic": topic, "working_title": title_plan.chosen})
        # Adapt the writing to the channel's lifecycle stage — a launch channel
        # is written for broad appeal, an established one for depth. Advisory
        # prompt text; empty for a channel we can't measure (see modules/strategy.py).
        strategy_note = _channel_strategy_note(channel_id)
        script = engine.generate(topic, research_brief=research_brief,
                                 working_title=title_plan.chosen,
                                 strategy_note=strategy_note)
        costs.add_gemini_usage(engine.last_response, stage="script")

    slug = slugify(topic)
    logger.info("Script: '%s'", script.title)
    events.emit(events.SCRIPT_COMPLETED, agent="script_engine", status=events.STATUS_COMPLETED,
                channel_id=channel_id, metadata={"title": script.title})
    pipeline.advance(run_record.run_id, PipelineStage.SCRIPT)

    if not script_file:
        saved = script.save(OUTPUT_DIR / slug / "script.json")
        logger.info("Script saved: %s — reuse with --script-file", saved)
    # Checkpoint the script stage so a later --resume can reuse it without
    # paying for the Gemini generation again. Records the canonical script path
    # only when it is actually on disk (an external --script-file may live
    # elsewhere), so the checkpoint never points at a file resume can't find.
    _script_json = OUTPUT_DIR / slug / "script.json"
    run_checkpoint.record_stage(
        slug, run_checkpoint.STAGE_SCRIPT, topic=topic, channel_id=channel_id,
        artifacts={"script_json": str(_script_json)} if _script_json.exists() else None)

    # ── Fact-check pass
    # Claims are flagged here; the pre-publish gate below decides what that
    # means. `None` (rather than []) survives a checker crash and tells the gate
    # the check did not run — which is a warning, not a silent pass.
    pipeline.advance(run_record.run_id, PipelineStage.FACT_CHECK)
    fact_results = None
    section_claims = None
    try:
        # Each claim carries its section (claim_id c000-1, scene s000), so the
        # Storyboard can show which scene says what (modules/claim_scenes.py).
        section_claims = extract_section_claims(script)
        claims = [c.text for c in section_claims]
        fact_results = fact_check_claims(claims) if claims else []
        flagged = [r for r in fact_results if r.requires_human_review]
        if flagged:
            logger.warning("Fact-check: %d/%d claim(s) flagged for human review", len(flagged), len(fact_results))
        else:
            logger.info("Fact-check: %d claim(s) checked, none flagged", len(fact_results))
        if fact_results:
            fc_path = OUTPUT_DIR / slug / "fact_check.json"
            fc_path.parent.mkdir(parents=True, exist_ok=True)
            fc_path.write_text(json.dumps(claim_scenes.fact_check_records(section_claims, fact_results),
                                          indent=2, ensure_ascii=False))
            logger.info("Fact-check results saved: %s", fc_path)
    except Exception as e:
        logger.warning("Fact-checker failed (%s: %s) — proceeding without fact-check results",
                        type(e).__name__, e)

    pipeline.advance(run_record.run_id, PipelineStage.HUMAN_APPROVAL)

    # First-30-seconds hook A/B (roadmap #60). Which opening this video ships is
    # decided on retention (modules/hook_ab.py). The "B" arm swaps the first
    # section's narration for the script's alternate opening BEFORE audio is
    # synthesized, so the whole pipeline (voice, subtitles, render) carries the
    # chosen hook. "A", or a "B" with no alternate available, keeps the original
    # opening and records "A" — the readback is never credited to an experiment
    # that did not actually happen.
    hook_variant = _pick_hook(channel_id)
    alt_opening = getattr(script, "hook_ab", "").strip()
    if hook_variant == "B" and alt_opening and script.sections:
        script.sections[0].narration = alt_opening
        script.sections[0].sfx_cues = script.sections[0].extract_sfx()
        script.sections[0].music_cues = script.sections[0].extract_music()
        script.sections[0].pauses = script.sections[0].extract_pauses()
        logger.info("[channel: %s] Hook A/B: shipping the alternate opening (B)", channel_id)
    else:
        hook_variant = "A"

    # Per-section Pexels keywords — already inside the script JSON, no API call.
    keyword_map = ScriptEngine.extract_visual_keywords(script)

    # ── Stage 3: Audio
    events.emit(events.VOICE_STARTED, agent="audio_mixer", status=events.STATUS_RUNNING, channel_id=channel_id)
    mixer = AudioMixer(slug, channel=ctx)
    audio_path, timeline = mixer.build(script)
    # Only what was actually synthesized — cached segments cost nothing this run.
    costs.add(TTS_CHARACTERS, mixer.characters_synthesized, stage="voice")
    events.emit(events.VOICE_COMPLETED, agent="audio_mixer", status=events.STATUS_COMPLETED, channel_id=channel_id)
    run_checkpoint.record_stage(slug, run_checkpoint.STAGE_VOICE, artifacts={"audio": str(audio_path)})

    # ── Stage 4: Media
    events.emit(events.MEDIA_STARTED, agent="media_fetcher", status=events.STATUS_RUNNING, channel_id=channel_id)
    fetcher = MediaFetcher(slug)

    # Gather all unique keywords from Gemini keyword map
    all_keywords = list({kw for entry in keyword_map for kw in entry.get("keywords", [])})
    if not all_keywords:
        all_keywords = fetcher.extract_keywords(topic)

    # A series' visual style biases the b-roll toward its look — a few style
    # tokens ("dark", "cinematic") ADDED to the topic's own keywords, never
    # replacing them, and nothing at all when there is no series/style.
    series_style_kw = style_keywords(visual_style)
    if series_style_kw:
        all_keywords = list(dict.fromkeys(all_keywords + series_style_kw))
        logger.info("Series visual style biases b-roll with +%s", series_style_kw)

    videos = fetcher.fetch_videos(all_keywords, count=12)
    images = fetcher.fetch_images(all_keywords, count=8)
    # API searches, not bytes: the Pexels quota is spent per search.
    costs.add(PEXELS_REQUESTS, fetcher.searches_made, stage="media")

    # Director Mode (modules/director.py): a per-scene cinematic shot plan
    # (camera/lens/lighting/mood/motion), from the script structure and this
    # channel's visual style. Advisory — it never gates; it enriches the b-roll
    # generation prompt so a generated clip carries its shot direction, and is
    # emitted for the Command Center.
    from modules import director
    shot_plans = director.plan_video(script.sections, visual_style)
    if shot_plans:
        events.emit(events.DIRECTOR_PLAN, agent="director", status=events.STATUS_COMPLETED,
                    channel_id=channel_id, metadata=director.summarize(shot_plans))
    director_style = director.style_map(shot_plans)

    # Character Bible / Elements Library (modules/elements.py): the channel's
    # reusable characters/locations/props. For each scene, detect which appear
    # and fold their description into the b-roll prompt so a recurring element
    # stays on-model across videos. Advisory — empty library changes nothing.
    from modules import elements as elements_mod
    channel_elements = elements_mod.load_elements(getattr(getattr(ctx, "agent", None), "elements", ()))
    element_style: dict = {}
    applied_by_scene: dict = {}
    if channel_elements:
        for i, section in enumerate(script.sections):
            matched = elements_mod.detect(getattr(section, "narration", "") or "", channel_elements)
            if matched:
                element_style[i] = elements_mod.consistency_prompt(matched)
                applied_by_scene[i] = [e.name for e in matched]
        events.emit(events.ELEMENTS_APPLIED, agent="elements", status=events.STATUS_COMPLETED,
                    channel_id=channel_id,
                    metadata=elements_mod.summarize(channel_elements, applied_by_scene))

    # A scene's b-roll prompt carries BOTH its Director shot direction and its
    # Character-Bible consistency directive when each is present.
    def _scene_style(i):
        parts = [s for s in (director_style.get(i), element_style.get(i)) if s]
        return "; ".join(parts) if parts else None

    # Optional: generate on-topic b-roll for a few sections with MiniMax H3,
    # supplementing the stock above. Off unless a key + flag are set, in which
    # case it makes no request and changes nothing. Generated clips join the
    # pool and are recorded in fetcher.video_terms, so broll_match places them.
    # Each generated clip carries its scene's Director shot direction and its
    # Character-Bible consistency directive (whichever are present).
    broll = fetcher.generate_broll(script.sections, topic, style_for=_scene_style)
    if broll.generated:
        videos.extend(Path(p) for p in broll.by_section.values())
        from modules import video_providers as _vp
        # Clips reused from an earlier attempt's ledger cost nothing new this run.
        costs.add(VIDEO_GEN_CLIPS, broll.newly_generated, stage=f"broll:{_vp.active_provider()}")
        events.emit(events.BROLL_GENERATED, agent="minimax_broll", status=events.STATUS_COMPLETED,
                    channel_id=channel_id, metadata=broll.to_dict())
    # Optional: generate on-topic stills with the selected image provider
    # (Leonardo), supplementing the Pexels images above. Off unless a key + flag
    # are set; a failure falls back to stock and never breaks the render.
    gen_images = fetcher.generate_images(script.sections, topic)
    if gen_images:
        from modules import image_providers as _img
        images = list(gen_images) + list(images)
        costs.add(IMAGE_GENERATIONS, len(gen_images), stage=f"image:{_img.active_provider()}")
        events.emit(events.IMAGE_GENERATED, agent="image_providers", status=events.STATUS_COMPLETED,
                    channel_id=channel_id,
                    metadata={"generated": len(gen_images), "provider": _img.active_provider()})
    logger.info("Media: %d videos (%d AI-generated), %d images (%d AI-generated)",
                len(videos), broll.generated, len(images), len(gen_images))
    # The baseline Whisper is about to be loaded on top of, and the number
    # release_model should return the process to.
    log_usage("before transcription")
    events.emit(events.MEDIA_COMPLETED, agent="media_fetcher", status=events.STATUS_COMPLETED,
                channel_id=channel_id, metadata={"videos": len(videos), "images": len(images)})
    run_checkpoint.record_stage(slug, run_checkpoint.STAGE_MEDIA)

    # ── Stage 5: Subtitles
    sub_gen = SubtitleGenerator(slug)
    word_timestamps = sub_gen.transcribe(audio_path)
    # The .srt has always been written and then only burnt into the picture.
    # Keeping the path lets the upload also offer it to YouTube as a caption
    # track — see YouTubeUploader.upload_captions.
    srt_path = sub_gen.to_srt(word_timestamps)
    word_clips_specs = sub_gen.word_clips(word_timestamps, VIDEO_WIDTH, VIDEO_HEIGHT)
    # Nothing after this point transcribes anything, and the render two stages
    # down is the one that keeps getting killed.
    sub_gen.release_model()
    run_checkpoint.record_stage(slug, run_checkpoint.STAGE_SUBTITLES, artifacts={"srt": str(srt_path)})

    # Video IR (modules/video_ir.py): one project.json from the pieces above —
    # scene times from the REAL audio timeline, shots, elements, asset
    # placement. Best-effort: returns None on any failure, never raises.
    ir_project = video_ir.write_for_run(
        slug=slug, script=script, timeline=timeline, channel_id=channel_id,
        audio_path=audio_path, subtitles_path=srt_path, shot_plans=shot_plans,
        elements=channel_elements, video_paths=videos, image_paths=images,
        clip_terms=getattr(fetcher, "video_terms", None), broll=broll,
        provenance=getattr(fetcher, "provenance", None),
        generated_images=gen_images, width=VIDEO_WIDTH, height=VIDEO_HEIGHT, fps=config.VIDEO_FPS,
        scene_plan=claim_scenes.annotate_scenes(script, section_claims, fact_results),
    )

    # ── Stage 6: Thumbnails
    # Which arm this video ships on. Both thumbnails have always been rendered;
    # until now A was uploaded every time and B was thrown away, so the
    # experiment never ran. See modules/ab_testing.py.
    arms = _variant_arms()
    variant = _pick_variant(channel_id)
    logger.info("[channel: %s] Thumbnail variant for this video: %s (of %s)",
                channel_id, variant, "/".join(arms))
    events.emit(events.THUMBNAIL_STARTED, agent="thumbnail_generator", status=events.STATUS_RUNNING, channel_id=channel_id)
    # One background per arm where footage allows; arms past the available
    # backgrounds fall back to the variant's own solid style (generate_variants).
    backgrounds = [images[i] if i < len(images) else None for i in range(len(arms))]
    thumb_gen = ThumbnailGenerator(slug)
    thumbs = thumb_gen.generate_variants(
        topic=script.topic,
        overlay_text=script.thumbnail_overlay_text or "SHOCKING",
        variants=arms,
        backgrounds=backgrounds,
    )
    # The chosen arm's thumbnail; fall back to A if the label somehow isn't in
    # the rendered set (never crash the render over a variant mismatch).
    chosen_thumb = thumbs.get(variant) or thumbs.get("A") or next(iter(thumbs.values()))
    thumb_a = thumbs.get("A", chosen_thumb)
    thumb_b = thumbs.get("B", thumb_a)
    # The B title only exists when Gemini produced one; any challenger arm (not
    # "A") ships it. Falling back to A is honest, and the recorded title_variant
    # then says "A" so the readback is not attributed to an experiment that did
    # not happen.
    chosen_title = (script.title_ab or "").strip() if variant != "A" else ""
    title_variant = "B" if chosen_title else "A"
    # The single source of truth for the title this video actually ships with:
    # the uploader publishes it (title_override falls back to script.title when
    # empty) and the DB must record the same string, or the A/B readback ends up
    # crediting the A title with a video that went out under the B title.
    published_title = chosen_title or script.title
    logger.info("Thumbnails: %s | %s — shipping %s", thumb_a.name, thumb_b.name, chosen_thumb.name)
    events.emit(events.THUMBNAIL_COMPLETED, agent="thumbnail_generator", status=events.STATUS_COMPLETED, channel_id=channel_id)
    run_checkpoint.record_stage(slug, run_checkpoint.STAGE_THUMBNAILS,
                                artifacts={"thumbnail_a": str(thumb_a), "thumbnail_b": str(thumb_b)})

    # ── Stage 6b: AITuber presenter (optional, off by default)
    # A synthetic on-camera character composited into a corner of the video.
    # Nightshift is faceless unless a channel/series enables this; when off,
    # presenter_path stays None and the render below is byte-for-byte the same.
    # No silent fallback: an enabled-but-unconfigured or unsafe request is logged
    # loudly and the run continues faceless — a blank/wrong presenter is never
    # shipped, and the publish gate below still decides every upload.
    presenter_path = None
    avatar_cfg = resolve_avatar_config(ctx, series_obj)
    if avatar_cfg.enabled:
        events.emit(events.AVATAR_STARTED, agent="avatar", status=events.STATUS_RUNNING,
                    channel_id=channel_id, metadata={"provider": avatar_cfg.provider})
        try:
            presenter_prompt = avatar_cfg.character_prompt or (series_obj.visual_style if series_obj else "")
            presenter_path = maybe_generate_presenter(
                avatar_cfg, presenter_prompt, OUTPUT_DIR / slug / "presenter.mp4")
            events.emit(events.AVATAR_COMPLETED, agent="avatar", status=events.STATUS_COMPLETED,
                        channel_id=channel_id, metadata={"presenter_path": str(presenter_path)})
            logger.info("Presenter generated: %s", presenter_path)
        except (AvatarUnavailable, UnsafeAvatarRequest) as e:
            presenter_path = None
            logger.error("Presenter unavailable (%s: %s) — rendering faceless this run",
                         type(e).__name__, e)
            events.emit(events.AVATAR_FAILED, agent="avatar", status=events.STATUS_FAILED,
                        channel_id=channel_id, metadata={"error": f"{type(e).__name__}: {e}"})
    else:
        events.emit(events.AVATAR_SKIPPED, agent="avatar", status=events.STATUS_COMPLETED,
                    channel_id=channel_id, metadata={"reason": "avatar not enabled"})

    # ── Stage 7: Compositor
    events.emit(events.RENDER_STARTED, agent="compositor", status=events.STATUS_RUNNING, channel_id=channel_id)
    render_started = time.monotonic()
    comp = Compositor(slug)
    # Two runs have died in here without leaving a reason. If a third does,
    # the sampler's last line is the state just before the kill.
    # config.RENDER_BACKEND picks the renderer (modules/render_dispatch.py):
    # "moviepy" (default) is the call below, unchanged; "ffmpeg" renders a
    # RenderSpec from the same inputs and falls back to this call on any failure.
    with MemorySampler("render"):
        render_result = render_dispatch.render_video(
            moviepy_render=lambda: comp.render(
                script=script,
                audio_path=audio_path,
                video_paths=videos,
                image_paths=images,
                word_timestamps=word_clips_specs,
                section_timeline=timeline,
                presenter_path=presenter_path,
                # Which keyword fetched each clip, so the compositor places footage
                # under the section it matches (modules/broll_match.py) rather than
                # at random. Empty when the fetcher was mocked/skipped — the
                # compositor then falls back to its original shuffle.
                clip_terms=getattr(fetcher, "video_terms", None),
            ),
            output_path=OUTPUT_DIR / slug / "final_video.mp4",
            script=script, audio_path=audio_path, video_paths=videos, image_paths=images,
            section_timeline=timeline, subtitle_path=srt_path, presenter_path=presenter_path,
            clip_terms=getattr(fetcher, "video_terms", None),
            width=VIDEO_WIDTH, height=VIDEO_HEIGHT, fps=config.VIDEO_FPS,
        )
    video_path = render_result.video_path
    costs.slug = slug
    costs.add(RENDER_SECONDS, time.monotonic() - render_started, stage="render")
    logger.info("Video: %s (render backend: %s)", video_path, render_result.backend)
    events.emit(events.RENDER_COMPLETED, agent="compositor", status=events.STATUS_COMPLETED,
                channel_id=channel_id,
                metadata={"video_path": str(video_path), **render_result.to_metadata()})
    run_checkpoint.record_stage(slug, run_checkpoint.STAGE_RENDER, artifacts={"video": str(video_path)})
    # The video exists on disk now. If this topic came off the content-planner
    # queue, record that it reached "rendered" — true whether or not the upload
    # below succeeds, so a blocked or failed-upload run leaves an honest
    # "rendered", never a false "published".
    topic_mgr.mark_queue_entry_rendered()
    # Advisory AI critic on rendered frames (modules/video_critic.py). Off unless
    # CHRONOS_AI_CRITIC is set; never blocks, never raises, skips at a met ceiling.
    video_critic.run(video_path, script=script, timeline=timeline, channel=ctx, costs=costs)

    # ── Stage 8: Upload
    # The video is already on disk by this point, so no upload failure may cost
    # us the topic registration — otherwise a bad channel ID or an expired token
    # means the same topic gets picked again next run despite the finished file.
    # ── Pre-publish gate — the one place that can stop an upload.
    # It only ever blocks; it never causes an upload that would not otherwise
    # happen, and it never publishes anything itself. A blocked video stays on
    # disk for a human. See modules/publish_gate.py.
    # Measure the file first (modules/video_qc.py): streams, duration vs the
    # narration, truncation, black and silent runs. Never raises; the report
    # lands in qc_report.json and in the gate event's metadata.
    qc_report = video_qc.run(video_path, audio_path=audio_path, timeline=timeline)
    gate = publish_gate.evaluate(
        script=script,
        video_path=video_path,
        topic=topic,
        fact_results=fact_results,
        channel=ctx,
        qc_report=qc_report,
        ir_project=ir_project,
    )

    # Advisory pre-publish intelligence — a quality/prediction score for a human
    # to read. It is emitted alongside the gate but is NOT part of it: it never
    # blocks, permits, or changes what publishes. Wrapped so a scoring failure
    # can never turn a run that produced a video into a failed one. Prediction
    # dimensions read "not enough data" until the history signals are wired in a
    # follow-up; the content dimensions score the real script now.
    try:
        p_score = publish_score.evaluate(publish_score.inputs_from_script(script))
        events.emit(events.PUBLISH_SCORE, agent="publish_score", status=events.STATUS_COMPLETED,
                    channel_id=channel_id, metadata=p_score.to_metadata())
        logger.info(
            "[channel: %s] Publish score: %s (%s) from %d/%d dimensions",
            channel_id, p_score.overall, p_score.verdict, p_score.dims_scored, p_score.dims_total,
        )
    except Exception as e:
        logger.warning(
            "Publish score failed (%s: %s) — advisory only, the run is unaffected",
            type(e).__name__, e,
        )

    if not gate.allowed:
        logger.error(
            "[channel: %s] PUBLISH BLOCKED: %s — video kept at %s for review",
            channel_id, ", ".join(gate.blocks), video_path,
        )
        print(f"\n⛔ Publish blocked ({', '.join(gate.blocks)}). Video saved: {video_path}")
        events.emit(events.PUBLISH_BLOCKED, agent="publish_gate", status=events.STATUS_FAILED,
                    channel_id=channel_id, metadata=gate.to_metadata())
    else:
        # Every allowed pass emits PUBLISH_ALLOWED, not only the ones that
        # carried warnings — otherwise a clean gate result leaves no record that
        # the gate ran at all, and the event stream can't tell "passed cleanly"
        # from "was never evaluated". The metadata carries the warnings (empty
        # when there were none) and the checks that ran.
        events.emit(events.PUBLISH_ALLOWED, agent="publish_gate", status=events.STATUS_COMPLETED,
                    channel_id=channel_id, metadata=gate.to_metadata())

    # Auto-publish is a per-channel policy on top of the gate, never a weakening
    # of it: the gate has already decided (above), and this only governs whether
    # an ALLOWED video uploads now or waits on disk for a human. Defaults on, so
    # existing channels are unaffected.
    auto_publish = ctx.auto_publish
    # Two-person publish approval (migration 0009). When the channel requires it,
    # the pipeline must not put a video PUBLIC on its own — a SECOND admin has to
    # sign off first. Uploads are private by default (config.YOUTUBE_PRIVACY, the
    # schedule and the dispatch all pin private), so this only ever bites a run
    # that would actually go public; then an approved publish_approvals row (the
    # DB guarantees decided_by != requested_by) whose video_ref names this run
    # must authorise it, or the video is held for review exactly like
    # auto-publish off. Fail-safe: any doubt (disabled/unreachable Supabase, no
    # row) holds rather than publishes. See modules/publish_approval.py.
    awaiting_two_person = False
    if (
        not skip_upload
        and gate.allowed
        and auto_publish
        and str(privacy).lower() == "public"
        and bool(getattr(ctx.agent, "require_two_person_publish", False))
    ):
        from modules import publish_approval
        if not publish_approval.has_approved(channel_id, slug=slug, topic=topic):
            awaiting_two_person = True

    video_id, video_url = None, None
    if not skip_upload and gate.allowed and auto_publish and not awaiting_two_person:
        events.emit(events.UPLOAD_STARTED, agent="youtube_uploader", status=events.STATUS_RUNNING,
                    channel_id=channel_id, metadata={"topic": topic})
        try:
            # Bound to this channel: its token, its YouTube target. The publish
            # gate is unchanged — this is the same unconditional upload it has
            # always been, now simply aimed at the right channel.
            uploader = YouTubeUploader(channel=ctx)
            # Watch-next: point the description at another of the channel's
            # videos (the closest the Data API allows to an end screen, which it
            # cannot set — see modules/watch_next.py). Best-effort description
            # text; a lookup failure just omits the link, and off when the channel
            # set watch_next=false.
            watch_next_suffix = None
            if getattr(ctx.agent, "watch_next", True):
                try:
                    with StateStore() as _wn_store:
                        _next = watch_next.pick_next_video(
                            _wn_store.list_videos(limit=1000, channel_id=channel_id),
                            series_id=(series_obj.series_id if series_obj else None))
                    if _next:
                        watch_next_suffix = watch_next.watch_next_block(
                            _next.get("video_id", ""), _next.get("title", ""))
                        events.emit(events.WATCH_NEXT_LINKED, agent="watch_next",
                                    status=events.STATUS_COMPLETED, channel_id=channel_id,
                                    metadata={"next_video_id": _next.get("video_id")})
                except Exception as e:
                    logger.warning("Watch-next lookup failed (%s: %s) — no link this run",
                                   type(e).__name__, e)
            uploaded = uploader.upload(
                video_path, script, thumbnail_path=chosen_thumb, privacy=privacy,
                title_override=chosen_title or None,
                # Both are metadata this run already produced: the Whisper .srt
                # and the mixer's own section timings, which become the
                # description's chapters. Neither changes what is published or
                # when — see modules/youtube_uploader.py.
                captions_path=srt_path,
                section_timeline=timeline,
                description_suffix=watch_next_suffix,
                # Run marker + attempt ledger: an ambiguous failure is looked up
                # on the channel before any retry, never re-uploaded blindly.
                attempt=upload_idempotency.begin(slug, channel_id),
            )
            video_id, video_url = uploaded["id"], uploaded["url"]
            # Recorded only on a successful upload — a failed attempt may have
            # sent bytes, but it did not deliver a video, and guessing how many
            # got through would be inventing a number.
            try:
                costs.add(UPLOAD_BYTES, float(video_path.stat().st_size), stage="upload")
            except OSError:
                logger.debug("Could not stat %s for the cost ledger", video_path, exc_info=True)
            logger.info("YouTube URL: %s", video_url)
            print(f"\n✓ Published: {video_url}")
            with StateStore() as store:
                store.record_video(
                    video_id=video_id,
                    topic=topic,
                    title=published_title,
                    slug=slug,
                    published_at=datetime.utcnow().isoformat(),
                    privacy=privacy,
                    category_id=YOUTUBE_CATEGORY_ID,
                    local_path=str(video_path),
                    channel_id=channel_id,
                    thumbnail_variant=variant,
                    title_variant=title_variant,
                    hook_variant=hook_variant,
                )
                events.emit(events.UPLOAD_COMPLETED, video_id=video_id, agent="youtube_uploader",
                            status=events.STATUS_COMPLETED, channel_id=channel_id,
                            metadata={"url": video_url}, store=store)
                events.emit(events.VIDEO_PUBLISHED, video_id=video_id, agent="youtube_uploader",
                            status=events.STATUS_COMPLETED, channel_id=channel_id,
                            metadata={"title": published_title, "url": video_url, "privacy": privacy}, store=store)

            # The upload actually succeeded — advance this run's queue entry (if
            # any) to "published". Only here, at real upload success, never at
            # pick time.
            topic_mgr.mark_queue_entry_published()

            # The run is fully done — drop its checkpoint so a later run for the
            # same topic starts clean and a bare --resume never re-opens it. A
            # blocked, held or failed run deliberately keeps its checkpoint, so
            # --resume can reuse the saved script instead of re-paying for it.
            run_checkpoint.clear(slug)

            # If this run is scoped to a series with a playlist, add the freshly
            # published video to it — a playlist keeps the series bingeable.
            # Best-effort and downstream of a live video: a playlist error never
            # turns a successful publish into a failed run. See modules/playlist.py.
            playlist_id = playlist.resolve_playlist_id(series_obj)
            if playlist_id:
                item_id = playlist.add_video_to_playlist(uploader.service, playlist_id, video_id)
                events.emit(
                    events.PLAYLIST_ADDED if item_id else events.PLAYLIST_FAILED,
                    agent="playlist",
                    status=events.STATUS_COMPLETED if item_id else events.STATUS_FAILED,
                    channel_id=channel_id, video_id=video_id,
                    metadata={"playlist_id": playlist_id,
                              **({"item_id": item_id} if item_id else {})},
                    store=store)

            # ── Engagement comment ──────────────────────────────────────
            # Post the channel's own first comment — an on-topic question — so
            # the video opens with a reply prompt (the creator pins it in one
            # tap; the Data API can't pin). Best-effort and downstream of a live
            # video: a comment failure never turns a successful publish into a
            # failed run. Off when the channel set pinned_comment=false, and a
            # no-op without the force-ssl scope. See modules/pinned_comment.py.
            if getattr(ctx.agent, "pinned_comment", True):
                question = pinned_comment.craft_question(
                    topic, title=published_title, hook=getattr(script, "hook_sentence", ""))
                thread_id = pinned_comment.post_pinned_comment(
                    uploader.service, video_id, question,
                    granted_scopes=uploader._granted_scopes())
                events.emit(
                    events.COMMENT_POSTED if thread_id else events.COMMENT_SKIPPED,
                    agent="pinned_comment",
                    status=events.STATUS_COMPLETED if thread_id else events.STATUS_FAILED,
                    channel_id=channel_id, video_id=video_id,
                    metadata={"question": question,
                              **({"thread_id": thread_id} if thread_id else {})},
                    store=store)

            # ── Review: put the finished video where a human can watch it ──
            # Every upload is private (config.YOUTUBE_PRIVACY defaults to it,
            # and so do the schedule and the dispatch), so nothing has gone
            # public here. This only mirrors the mp4 and the script it was
            # built from into Supabase, so the Command Center can show what is
            # waiting. It publishes nothing and changes no video's privacy.
            #
            # Wrapped because a preview is a convenience: a storage outage must
            # never turn a run that produced a video into a failed run.
            try:
                review = VideoReview()
                review.record(
                    video_id=video_id,
                    channel_id=channel_id,
                    video_path=video_path,
                    script_text=script.full_narration(),
                    auto_publish=review.fetch_auto_publish(channel_id),
                    # The structured scene plan behind this video (migration 0011)
                    # — the Storyboard renders it directly instead of guessing
                    # scenes from paragraph breaks. Best-effort: a build failure
                    # here is swallowed with the preview, never failing the run.
                    # Each scene also carries its claim ids and their advisory
                    # fact-check status (modules/claim_scenes.py).
                    scenes=claim_scenes.annotate_scenes(script, section_claims, fact_results),
                    # The Video IR (migration 0013); also adds real start/end
                    # times to the scenes above. None leaves both as before.
                    manifest=ir_project.to_dict() if ir_project is not None else None,
                )
            except Exception as e:
                logger.warning("Could not record the review preview (%s: %s)",
                               type(e).__name__, e)
        except Exception as e:
            # Channel-tagged so one channel's credential failure is visibly
            # that channel's, and does not read as a Nightshift-wide outage.
            logger.error("[channel: %s] YouTube upload failed (%s): %s", channel_id, type(e).__name__, e)
            print(f"\n✓ Video saved, upload failed: {video_path}")
            events.emit(events.UPLOAD_FAILED, agent="youtube_uploader", status=events.STATUS_FAILED,
                        channel_id=channel_id,
                        metadata={"operation": "upload", "error": f"{type(e).__name__}: {e}"})
        else:
            # ── Stage 9: Short
            # Strictly downstream of a video that actually published: the gate
            # has passed, the long video is out, and a failure from here on
            # cannot turn a successful run into a failed one.
            #
            # An `else` clause, not the end of the `try` above, and emphatically
            # not the `except`: this call sat in the failure handler, so a Short
            # was cut ONLY when the long upload had failed — with a parent id and
            # parent url of None, pointing at nothing — and never once when the
            # video actually published. The comment claimed the opposite the
            # whole time, which is why it survived review. `else` cannot drift
            # back: it runs when, and only when, the block above raised nothing.
            _publish_short(
                ctx=ctx,
                script=script,
                slug=slug,
                source_video=video_path,
                parent_video_id=video_id,
                parent_url=video_url,
                topic=topic,
                privacy=privacy,
                timeline=timeline,
                costs=costs,
            )
    elif not gate.allowed:
        pass  # already reported above
    elif awaiting_two_person:
        # The gate PASSED and auto-publish is on, but this channel requires a
        # second admin's sign-off and no approval names this run yet. A policy
        # hold, not a gate failure: the video waits (private/on disk) until an
        # approved publish_approvals row exists — publish.allowed already fired
        # for this same video.
        logger.warning(
            "[channel: %s] Two-person approval required and none found — holding %s "
            "(a second admin must approve on the Approvals page before it goes public)",
            channel_id, video_path,
        )
        print(f"\n⏸ Awaiting two-person approval: video held for review: {video_path}")
        events.emit(events.PUBLISH_HELD, agent="publish_gate", status=events.STATUS_COMPLETED,
                    channel_id=channel_id,
                    metadata={"reason": "awaiting_two_person_approval", "video_path": str(video_path)})
    elif not skip_upload and not auto_publish:
        # The gate PASSED but this channel's auto-publish is off: the video is
        # finished and waits on disk for a human to publish. A policy hold, not a
        # gate failure — publish.allowed already fired for this same video.
        logger.info("[channel: %s] Auto-publish OFF — gate passed, holding %s for review",
                    channel_id, video_path)
        print(f"\n⏸ Auto-publish OFF: gate passed, video held for review: {video_path}")
        events.emit(events.PUBLISH_HELD, agent="publish_gate", status=events.STATUS_COMPLETED,
                    channel_id=channel_id,
                    metadata={"reason": "auto_publish_off", "video_path": str(video_path)})
    else:
        print(f"\n✓ Video saved (upload skipped): {video_path}")

    # Cost is recorded last, once the video_id (if any) is known. A blocked or
    # failed run still writes its entries, keyed by slug.
    try:
        with StateStore() as store:
            costs.flush(store, video_id=video_id)
    except Exception as e:
        logger.warning("Could not record costs (%s: %s) — the run itself is unaffected",
                       type(e).__name__, e)

    topic_mgr.register_topic(topic, video_path, video_id=video_id, video_url=video_url)

    # Snapshot what is left on the paid provider accounts (ElevenLabs credits,
    # Leonardo tokens) for the Billing page. Best-effort; never affects the run.
    try:
        from modules import provider_balance
        provider_balance.record()
    except Exception as e:
        logger.warning("Provider balance snapshot skipped (%s)", type(e).__name__)

    logger.info("=== Done [channel: %s] ===", channel_id)
    return video_path


def list_channels():
    """Prints all YouTube channels for the authenticated account."""
    uploader = YouTubeUploader()
    channels = uploader.list_channels()
    if not channels:
        print("Hech qanday kanal topilmadi.")
        return
    print("\nSizning YouTube kanallaringiz:")
    print("-" * 60)
    for ch in channels:
        print(f"  ID   : {ch['id']}")
        print(f"  Nom  : {ch['name']}")
        print(f"  URL  : {ch['url']}")
        print("-" * 60)
    print("\nKerakli kanal ID sini .env fayliga qo'ying:")
    print("  YOUTUBE_CHANNEL_ID=UC...")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Nightshift YouTube Bot")
    parser.add_argument("--channel", default=None,
                        help="Channel id to run (default: the 'default' channel — "
                             "see modules/channels.py and docs/MULTI_CHANNEL.md)")
    parser.add_argument("--niche", default=None,
                        help="Video niche/topic area (default: the channel's own niche)")
    parser.add_argument("--topic", default=None, help="Override topic manually")
    parser.add_argument("--privacy", default=YOUTUBE_PRIVACY, choices=["private", "unlisted", "public"])
    parser.add_argument("--no-upload", action="store_true", help="Skip YouTube upload")
    parser.add_argument("--list-channels", action="store_true", help="Show all YouTube channels and exit")
    parser.add_argument("--script-file", default=None,
                        help="Reuse a saved script JSON instead of calling Gemini "
                             "(e.g. output/<slug>/script.json, or samples/demo_script.json)")
    parser.add_argument("--series", default=None,
                        help="Series id to run this video under (default: none — "
                             "the channel's own niche is used; see modules/series.py)")
    parser.add_argument("--resume", action="store_true",
                        help="Resume a crashed run: reuse its saved script (skipping the "
                             "paid Gemini generation) from the run checkpoint. With --topic, "
                             "resumes that run; alone, resumes the most recent unfinished run.")
    # Per-run controls (the site's "Run now" forwards these; blank = the
    # channel's own setting, exactly as before).
    parser.add_argument("--duration", type=int, default=None,
                        help="Target video length in seconds for THIS run only "
                             "(default: the channel's target_duration_seconds)")
    parser.add_argument("--language", default=None,
                        help="Script language for THIS run only, e.g. 'English', "
                             "'Arabic' (default: the channel's language)")
    parser.add_argument("--visual-style", dest="visual_style", default=None,
                        help="Visual-style directive or style-preset name for THIS "
                             "run only (default: the channel's / series' style)")
    args = parser.parse_args()

    if args.list_channels:
        list_channels()
    else:
        run(
            niche=args.niche,
            topic=args.topic,
            privacy=args.privacy,
            skip_upload=args.no_upload,
            script_file=args.script_file,
            channel=args.channel,
            series=args.series,
            resume=args.resume,
            duration=args.duration,
            language=args.language,
            visual_style=args.visual_style,
        )
