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
import contextlib
import json
import logging
import os
import re
import sys
import time
import functools
import signal
import threading
from datetime import datetime
from pathlib import Path

# Ensure required directories exist before any imports that may reference them
Path("logs").mkdir(exist_ok=True)
Path("history").mkdir(exist_ok=True)
Path("output").mkdir(exist_ok=True)

import config
from config import OUTPUT_DIR, THUMBNAIL_VARIANT_COUNT, VIDEO_HEIGHT, VIDEO_WIDTH, YOUTUBE_CATEGORY_ID, YOUTUBE_PRIVACY
from modules import ai_disclosure
from modules import event_log as events
from modules import gemini_stages
from modules import run_slug
from modules import log_redaction
from modules import publish_gate
from modules import publish_score
from modules import video_critic
from modules import video_qc
from modules.ab_testing import choose_variant_n, variant_performance_n
from modules.hook_ab import choose_hook, hook_performance
from modules.avatar import (
    AvatarUnavailable, UnsafeAvatarRequest, describe_presenter, maybe_generate_presenter,
    planned_presenter_usd, preflight_avatar, presenter_narration, resolve_avatar_config,
)
from modules.audio_mixer import AudioMixer, VoiceUnavailable, verify_voice
from dataclasses import replace as _dc_replace
from modules.channels import ChannelContext, effective_privacy, resolve_channel
from modules.credential_health import (
    CredentialsMissing, check_run_credentials, placeholder_media_allowed, with_live_youtube_check)
from modules.cost_ledger import (
    CostLedger, IMAGE_GENERATIONS, PEXELS_REQUESTS, RENDER_SECONDS, TTS_CHARACTERS,
    UPLOAD_BYTES, VIDEO_GEN_CLIPS,
)
from modules import budget
from modules import disk_guard
from modules import spend_guard
from modules import shorts
from modules.claim_extractor import SOURCE_NARRATION, extract_shipped_claims
from modules import claim_scenes
from modules.compositor import Compositor
from modules import render_dispatch
from modules.resource_monitor import MemorySampler, log_usage
from modules.video_review import VideoReview
from modules import held_video
from modules.fact_checker import fact_check_claims
from modules import grounding
from modules import packaging_repair
from modules.media_fetcher import MediaFetcher, MediaUnavailable, require_media
from modules import video_providers
from modules import image_providers
from modules import dna_render
from modules.minimax_broll import VideoModelUnavailable
from modules import pinned_comment
from modules import playlist
from modules import watch_next
from modules.pipeline_stages import PipelineStage, PipelineStateMachine
from modules.research_engine import research_topic
from modules import run_checkpoint, upload_idempotency
from modules import video_ir
from modules.script_engine import ScriptEngine
from modules.series import (
    SERIES_NOT_RUNNABLE_EXIT, SeriesNotRunnable, effective_cadence, effective_niche, effective_visual_style,
    effective_voice_style, require_runnable_series, resolve_series, style_keywords,
)
from modules.state_store import StateStore
from modules import storyboard_review
from modules import strategy
from modules.subtitle_generator import SubtitleGenerator
from modules.thumbnail_generator import ThumbnailGenerator
from modules import title_formulas
from modules.title_planner import plan_titles
from modules.topic_manager import TopicManager, TopicSelectionError
from modules.youtube_uploader import YouTubeUploader, reconcile_privacy
from tools.generate_assets import ensure_assets

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("logs/run.log", encoding="utf-8"),
    ],
)
# logs/run.log is uploaded as a workflow artifact: scrub token-bearing URLs
# (Telegram bot path, Slack webhook, ?key=) from every line and traceback.
log_redaction.install()
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
    ai_decision=None,
    ai_signals=None,
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
            # The Short is cut from the long video's own frames: same media, same answer.
            ai_disclosure=ai_decision,
        )
        try:
            costs.add(UPLOAD_BYTES, float(short_path.stat().st_size), stage="short_upload")
        except OSError:
            logger.debug("Could not stat %s for the cost ledger", short_path, exc_info=True)

        # The privacy YouTube applied (see run()): never recorded as the one that was only requested.
        short_recorded = reconcile_privacy(privacy, uploaded.get("privacy")).recorded
        with StateStore() as store:
            store.record_video(
                video_id=uploaded["id"],
                topic=topic,
                title=shorts.short_title(script.title),
                slug=slug,
                published_at=datetime.utcnow().isoformat(),
                privacy=short_recorded,
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
            # The Short is its own video row, and an Instagram / TikTok post of it reads ITS record: without one it
            # would read as "provenance unknown" and be labelled whatever the long video contains.
            if ai_decision is not None and ai_signals is not None:
                events.emit(ai_disclosure.EVENT, video_id=uploaded["id"], agent="ai_disclosure",
                            status=events.STATUS_COMPLETED, channel_id=channel_id,
                            metadata=ai_decision.to_metadata(getattr(ctx.agent, "language", ""), ai_signals),
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


def _run_slug(topic: str, ctx) -> str:
    """The directory and checkpoint name of THIS channel's run of ``topic``
    (modules/run_slug.py, BR-G-007): the topic slug for the operator's own
    channels, a channel-keyed one for every other organization's, so two
    organizations that run one topic never share ``output/<slug>/``."""
    return run_slug.resolve(topic, str(ctx.channel_id), operators=ctx.is_operators)


def _flush_costs(costs, slug: str | None = None) -> None:
    """Record what a run that stops early consumed (the planning it paid for),
    keyed by its slug. Never raises: the ledger is bookkeeping."""
    try:
        if slug:
            costs.slug = slug
        with StateStore() as store:
            costs.flush(store, video_id=None)
    except Exception as e:
        logger.warning("Could not record costs (%s: %s) — the run itself is unaffected",
                       type(e).__name__, e)


#: The running pipeline's cost ledger, so ``_flush_costs_on_exit`` can record
#: what a run that died part-way had already bought (one run per process).
_RUN_COSTS: list = []


def _exit_on_sigterm(signum, _frame):
    """SIGTERM (docker stop, the worker's timeout) as an exit that unwinds, so the
    ``finally`` of ``_flush_costs_on_exit`` runs; the default action would kill
    the process (exit 143) without recording what the run had bought."""
    raise SystemExit(128 + signum)


def _flush_costs_on_exit(fn):
    """Wrap ``run``: whatever the run bought is recorded even when it raises
    (a failed render, a refused clip, a spend-guard stop) or is terminated with
    SIGTERM. Entries already flushed on the normal path are not written twice
    (CostLedger.flushed). Nothing in the finally can replace the run's own
    exception."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        _RUN_COSTS.clear()
        gemini_stages.reset()
        previous = None
        installed = False
        if threading.current_thread() is threading.main_thread():
            try:
                previous = signal.signal(signal.SIGTERM, _exit_on_sigterm)
                installed = True
            except (ValueError, OSError):
                pass
        try:
            return fn(*args, **kwargs)
        finally:
            if installed:
                # A second SIGTERM (the worker repeats it) must not abort the flush.
                try:
                    signal.signal(signal.SIGTERM, signal.SIG_IGN)
                except (ValueError, OSError):
                    pass
            ledgers = []
            try:
                ledgers = list(_RUN_COSTS)
                _RUN_COSTS.clear()
                for ledger in ledgers:
                    if ledger.pending():
                        _flush_costs(ledger)
            except Exception as e:
                logger.warning("Could not record costs on exit (%s) — the run's own outcome is unchanged",
                               type(e).__name__)
            finally:
                # What the run asked of Gemini, per stage (one log line and one event; never raises).
                gemini_stages.report_run(channel_id=getattr(next(iter(ledgers), None), "channel_id", None))
                if installed:
                    try:
                        signal.signal(signal.SIGTERM, previous if previous is not None else signal.SIG_DFL)
                    except (ValueError, OSError):
                        pass
    return wrapper


def _guard_spend(ctx, costs, stage: str, planned=None, extra_usd: float = 0.0) -> None:
    """Stop the run, loudly, before ``stage`` buys anything if the ledger so far
    is over CHRONOS_MAX_RUN_USD (or, for the operator's own organisation, the
    day is over CHRONOS_MAX_DAILY_USD). See modules/spend_guard.py."""
    spend_guard.check(costs, stage, operators=bool(getattr(ctx, "is_operators", False)), planned=planned,
                      extra_usd=extra_usd)


def _ground_fact_results(ctx, costs, topic, slug, claims, section_claims, fact_results, save=True) -> tuple:
    """``(results, summary dict)``: the evidence lookup (modules/grounding.py) applied to the
    checker's results, its extra Gemini tokens in the cost ledger under their own stage, and the
    passages it used saved as ``grounding.json`` beside ``fact_check.json`` so a quote can be
    audited after the page has changed. Never raises: whatever fails, the results come back as the
    checker gave them and the summary says why."""
    try:
        path = OUTPUT_DIR / slug / "grounding.json"
        # A re-run of the same topic reuses the passages the earlier run saved: no request, and no
        # rate limit to meet (the file is only read when it is for this exact topic).
        results, summary = grounding.ground_results(
            topic, claims, fact_results, sources=[c.source for c in section_claims],
            language=getattr(ctx.agent, "language", None), claim_ids=[c.claim_id for c in section_claims],
            cached=grounding.load_cached_evidence(path, topic),
            on_response=lambda r: costs.add_gemini_usage(r, stage=grounding.STAGE))
        record = summary.to_dict()
        if save and summary.evidence is not None and summary.evidence.snippets:
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                # Atomically (a temp file, then replace): a reader never sees half a file. The original fetch
                # time is carried through reuse, so the file cannot be kept alive by being reused.
                tmp = path.with_name(path.name + ".tmp")
                tmp.write_text(json.dumps(grounding.evidence_file(topic, summary.evidence, record),
                                          indent=2, ensure_ascii=False), encoding="utf-8")
                os.replace(tmp, path)
            except OSError as e:
                logger.warning("Could not save grounding.json (%s) - the run is unaffected", type(e).__name__)
        return results, record
    except Exception as e:
        logger.warning("Fact-check grounding failed (%s: %s) - verdicts are the checker's own",
                       type(e).__name__, e)
        return fact_results, {"enabled": True, "unavailable": f"error:{type(e).__name__}"}


def _repair_packaging(ctx, costs, topic, slug, script, research_brief, section_claims, fact_results, early,
                      grounding_summary):
    """One repair pass over the packaging texts when the early fact-check blocks on nothing else
    (modules/packaging_repair.py): ``None`` when it is off or the hold is not repairable, else a
    ``packaging_repair.Repair`` (``.passed`` only when the same early gate now allows the run). The calls it
    makes are the run's own generator, fact-checker and grounding step; their cost lands in the ledger.
    Never raises: whatever fails here, the run is held exactly as it would be without a repair."""
    try:
        return _repair_packaging_pass(ctx, costs, topic, slug, script, research_brief, section_claims,
                                      fact_results, early, grounding_summary)
    except Exception as e:
        logger.warning("Packaging repair could not start (%s) - the run is held as without it", type(e).__name__)
        return None


def _repair_packaging_pass(ctx, costs, topic, slug, script, research_brief, section_claims, fact_results, early,
                           grounding_summary):
    if not packaging_repair.enabled():
        return None
    from modules.gemini_client import generate_with_retry, make_client
    from modules.gemini_stages import model_for
    from modules.script_engine import _format_research_notes
    from modules.structured_output import json_config

    def generate(prompt):
        response = generate_with_retry(
            make_client(), model_for(packaging_repair.STAGE), prompt,
            json_config(None, system_instruction=packaging_repair.REPAIR_SYSTEM))
        costs.add_gemini_usage(response, stage=packaging_repair.STAGE)
        return response

    def ground(fresh, checked):
        if not grounding.enabled():
            return checked, None
        checked, summary = _ground_fact_results(ctx, costs, topic, slug, [c.text for c in fresh], fresh, checked,
                                                save=False)
        return checked, held_video.grounding_detail(summary)

    def evaluate(repaired, claims, results):
        return publish_gate.evaluate_fact_check(
            script=repaired, fact_results=results, channel=ctx,
            narration_claims=sum(1 for c in claims if c.source == SOURCE_NARRATION), claims=claims,
            language=getattr(ctx.agent, "language", None), grounding=grounding_summary)

    return packaging_repair.repair_packaging(
        script=script, claims=section_claims, results=fact_results, decision=early, topic=topic,
        language=getattr(ctx.agent, "language", None), research_notes=_format_research_notes(research_brief),
        generate=generate, check=fact_check_claims, ground=ground, extract=extract_shipped_claims, evaluate=evaluate)


def _save_packaging_repair(slug, repair) -> None:
    """``packaging_repair.json`` beside ``fact_check.json``: the first-round items, the rewrites and what the
    re-check said, for a person to read whatever came of it. Never raises."""
    try:
        path = OUTPUT_DIR / slug / "packaging_repair.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(repair.record, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        logger.warning("Could not save packaging_repair.json (%s) - the run is unaffected", type(e).__name__)


def _resave_after_packaging_repair(slug, script, script_file, section_claims, fact_results) -> None:
    """The repaired texts are what ships, so the saved copies of this run carry them too: ``script.json`` (what a
    resume or a storyboard reads) and ``fact_check.json`` (the claims the gate now stands on). A script loaded
    from a file elsewhere is not written to a path it was never saved at. Never raises."""
    try:
        canonical = OUTPUT_DIR / slug / "script.json"
        if not script_file or canonical.exists():
            script.save(canonical)
        (OUTPUT_DIR / slug / "fact_check.json").write_text(
            json.dumps(claim_scenes.fact_check_records(section_claims, fact_results), indent=2, ensure_ascii=False))
    except Exception as e:
        logger.warning("Could not re-save the script after the packaging repair (%s) - the run goes on with the "
                       "repaired texts in memory", type(e).__name__)


def _hold_before_render(ctx, *, slug, topic, script, claims, fact_results, decision, costs, grounding_summary=None,
                        packaging_repair_record=None) -> None:
    """A run whose fact-check would block the publish gate ends here, owner-visibly,
    before the voice, stills and render are bought.

    Mirrors the neighbouring early stops: the planning already paid for is recorded
    (``_flush_costs``), the run gets a blocked ``videos`` row of its own (the gate's
    reasons, scenes with their claim verdicts, and the flagged title/description/
    thumbnail/hook texts those scenes do not show; no cut, so nothing to approve; a row
    that already holds a cut a person may be reviewing is left alone), and a ``publish.blocked``
    event — the one the Command Center, the operator bot and the Telegram control
    already read for a blocked video — carries the fixed words and counts, the run's
    slug and held id, what happened to the row, and the flagged non-narration texts
    (capped; not the script's title). The caller raises HeldBeforeRender, which __main__ turns
    into HELD_BEFORE_RENDER_EXIT so the runners release the credit hold.
    Records only; never uploads, never raises."""
    channel_id = ctx.channel_id
    logger.error("[channel: %s] Fact-check would block the publish gate (%s) — run stopped before the voice, "
                 "stills and render were bought", channel_id, ", ".join(decision.blocks))
    print(f"\n⛔ Held before render ({', '.join(decision.blocks)}). Nothing was spent on the voice or the video.")
    counts = decision.fact_check or {}
    held_id, flagged, row = None, [], "not_recorded"
    try:
        held_id = held_video.held_video_id(channel_id, slug)
        try:
            scenes = claim_scenes.annotate_scenes(script, claims, fact_results)
        except Exception:
            scenes = None
        detail = held_video.gate_detail(held_video.STATE_BLOCKED, decision.to_metadata())
        detail["stage"] = "before_render"
        flagged = held_video.flagged_claims(claims, fact_results)
        if flagged:
            detail["flagged"] = flagged
        evidence = held_video.grounding_detail(grounding_summary)
        if evidence:
            detail["grounding"] = evidence
        # A repair that was tried and did not clear the hold: the first-round items and the rewritten ones, both.
        if packaging_repair_record:
            detail["packaging_repair"] = packaging_repair_record
        # The row's key is channel + topic slug, so an earlier run of this topic may have left a cut on it that a
        # person is still reviewing (held, awaiting approval, blocked after its render). This hold has no video and
        # would replace that cut's text, scenes and verdict, so a row that holds one is left exactly as it is. A
        # lookup that fails reads as "maybe": nothing is written either. The event below says which of the three
        # happened and carries the flagged texts, because the rows-based alerts stay silent when no row is written.
        has_cut = held_video.HeldVideos().has_cut(held_id)
        if has_cut is False:
            written = held_video.record_held(channel_id=channel_id, slug=slug, state=held_video.STATE_BLOCKED,
                                             topic=topic, title=script.title, script_text=script.full_narration(),
                                             scenes=scenes, detail=detail, no_cut=True)
            row = "written" if written else "not_recorded"
        elif has_cut:
            row = "kept_existing_cut"
            logger.warning("[channel: %s] The held row for %s already holds a cut: it is left as it is, and no row "
                           "is written for this early hold", channel_id, slug)
        else:
            row = "lookup_failed"
            logger.warning("[channel: %s] The held row for %s could not be read, so it was not overwritten and no "
                           "row is written for this early hold", channel_id, slug)
    except Exception as e:
        logger.warning("Could not record the early hold (%s: %s) — the run still stops",
                       type(e).__name__, e)
    try:
        events.emit(events.PUBLISH_BLOCKED, agent="publish_gate", status=events.STATUS_FAILED,
                    channel_id=channel_id,
                    metadata={**decision.to_metadata(), "stage": "before_render", "slug": slug, "video_id": held_id,
                              "row": row, "flagged": flagged,
                              **({"packaging_repair": packaging_repair_record.get("status")}
                                 if packaging_repair_record else {}),
                              "claims_checked": len(fact_results), "claims_flagged": counts.get("flagged", 0)})
    except Exception as e:
        logger.warning("Could not emit the early-hold event (%s: %s) — the run still stops",
                       type(e).__name__, e)
    _flush_costs(costs, slug)


def _effective_privacy(ctx: ChannelContext, privacy: str) -> str:
    """The privacy this run may upload with. Unless the channel's Command Center
    auto-publish switch is plainly ON, anything other than private is clamped to
    private with a one-line warning; see modules.channels.effective_privacy. A
    switch that could not be read (None) clamps too: unknown is not a yes."""
    allowed = effective_privacy(privacy, ctx.ui_auto_publish)
    if str(privacy or "").strip().lower() not in ("", "private") and allowed != privacy:
        if ctx.ui_auto_publish is None:
            logger.warning(
                "[channel: %s] No auto-publish switch could be read for this channel: %r requested, "
                "uploading private instead (unknown is treated as off)", ctx.channel_id, privacy)
        else:
            logger.warning(
                "[channel: %s] Auto publish is not ON for this channel: %r requested, uploading "
                "private instead (the switch means never public)", ctx.channel_id, privacy)
    return allowed


def _voice_record(mixer) -> dict:
    """What the voice event records about the narrator. A record must never be
    able to stop a run that has already paid for its script: any failure here
    logs and records nothing."""
    try:
        return dict(mixer.describe_voice())
    except Exception as e:
        logger.warning("Could not describe the voice for the run record (%s)", type(e).__name__)
        return {}


def _record_stills(costs, fetcher, gen_images, channel_id) -> None:
    """The run's record of generated stills: the ledger entry and the event.

    A still the model returned nothing for falls back to stock for that scene, by
    design (``image_providers``), and the record says which scenes and how many.
    The event stays ``completed`` and carries ``degraded``: the Command Center reads
    any failed event as a hard failure, and a soft image miss is not one. No ledger
    entry is written for zero stills: an unpriced entry, even of quantity 0, makes
    the settlement capture the whole hold instead of the metered amount
    (``credits.settle_amount``)."""
    made = len(gen_images)
    missing = list(getattr(fetcher, "images_missing", None) or [])
    attempted = getattr(fetcher, "images_attempted", made)
    if missing:
        logger.warning("[channel: %s] %d of %d generated still(s) did not come back; scene(s) %s use "
                       "stock images", channel_id, len(missing), attempted, missing)
    if not (made or missing):
        return
    provider = image_providers.active_provider()
    if made:
        costs.add(IMAGE_GENERATIONS, made, stage=f"image:{provider}")
    events.emit(events.IMAGE_GENERATED, agent="image_providers", status=events.STATUS_COMPLETED,
                channel_id=channel_id,
                metadata={"generated": made, "attempted": attempted, "missing_sections": missing,
                          "degraded": bool(missing), "provider": provider})


def _preflight_disk(channel_id, free_fn=None) -> None:
    """Refuse the run, before it spends anything, when the volume holding ``output/`` is nearly full.

    A render writes several GB there and dies mid-way ("No space left on device") after the script and the
    voice were paid for. The message names the sizes and the fix; ``NIGHTSHIFT_MIN_FREE_DISK_GB`` sets the
    threshold (default 5 GB, ``0`` is off). A volume that cannot be measured is not a refusal: the guard is a
    precheck, and an unreadable answer is logged, not turned into "full"."""
    try:
        disk_guard.require_free_disk(OUTPUT_DIR, disk_guard.configured_min_bytes(),
                                     free_fn or disk_guard.free_bytes)
    except disk_guard.InsufficientDisk as e:
        logger.error("[channel: %s] Not enough free disk to start a run: %s", channel_id, e)
        events.emit(events.AGENT_FAILED, agent="disk_guard", status=events.STATUS_FAILED,
                    channel_id=channel_id, metadata={"error": f"{type(e).__name__}: {e}", "stage": "preflight"})
        raise
    except OSError as e:
        logger.warning("[channel: %s] Free disk could not be measured (%s) - continuing without the check",
                       channel_id, type(e).__name__)


@contextlib.contextmanager
def _presenter_stop_recorded(channel_id):
    """Record, then re-raise, the compositor's refusal to ship a half-presenter video.

    The generation stage above already emits ``avatar.failed`` when the presenter cannot be made; the render
    can refuse too (a clip that will not open or place, e.g. one of the fal intro/outro pair), and that stop
    must reach the Command Center the same way instead of living only in the traceback (CLAUDE.md #4)."""
    try:
        yield
    except AvatarUnavailable as e:
        logger.error("[channel: %s] Presenter could not be placed in the render (%s) - stopping", channel_id, e)
        events.emit(events.AVATAR_FAILED, agent="avatar", status=events.STATUS_FAILED,
                    channel_id=channel_id, metadata={"error": f"{type(e).__name__}: {e}", "stage": "render"})
        raise


def _preflight_pictures(ctx, series_obj, channel_id) -> None:
    """Raise (after recording the failure) when generated stills or a presenter
    were asked for but cannot be made. Makes no request."""
    try:
        image_providers.preflight()
        preflight_avatar(resolve_avatar_config(ctx, series_obj))
    except (image_providers.ImageProviderUnavailable, AvatarUnavailable, UnsafeAvatarRequest) as e:
        logger.error("Generated pictures or presenter not usable for channel %s: %s", channel_id, e)
        events.emit(events.AGENT_FAILED, agent="media_preflight", status=events.STATUS_FAILED,
                    channel_id=channel_id, metadata={"error": f"{type(e).__name__}: {e}", "stage": "preflight"})
        raise


@_flush_costs_on_exit
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
    # The Command Center's auto-publish switch OFF means "never public": clamp
    # the requested privacy here, before any stage (the upload, the Short, the
    # two-person check) can read it. Uploads themselves are unchanged.
    privacy = _effective_privacy(ctx, privacy)
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
    # Channel DNA's format and aspect (modules/dna_render.py): the frame this
    # video renders in, and a Shorts channel's shorter default length. The
    # run's own --duration always wins; publishing reads none of it.
    render_fmt = dna_render.resolve_format(
        ctx.dna, channel_target_seconds=ctx.agent.target_duration_seconds,
        base_size=(VIDEO_WIDTH, VIDEO_HEIGHT), run_duration=duration)
    if render_fmt.target_seconds != ctx.agent.target_duration_seconds:
        ctx = _dc_replace(ctx, agent=_dc_replace(ctx.agent, target_duration_seconds=render_fmt.target_seconds))
    channel_id = str(ctx.channel_id)
    # A series is an optional recurring content line within the channel. When
    # given, its niche seeds this run (unless --niche was passed explicitly) and
    # its style/cadence shape the run below. See modules/series.py; resolution
    # never raises.
    series_obj = resolve_series(series)
    # resolve_series never raises, so an unknown, paused or foreign series would
    # silently run as the plain channel. A series asked for by name is refused
    # here, before the credential check or any paid call.
    # SeriesNotRunnable propagates to __main__, which prints the one line and exits
    # SERIES_NOT_RUNNABLE_EXIT.
    require_runnable_series(series, series_obj, ctx.channel_id)
    # effective_niche ends in "history mysteries"; remember whether the channel,
    # the series or the caller actually named a niche, so topic selection stops
    # for a channel that has none instead of quietly making history videos.
    niche_chosen = bool(niche or (series_obj and series_obj.niche) or ctx.niche)
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
    # and whether they are present, BEFORE it spends anything. It logs and
    # emits. A missing REQUIRED key (Gemini, Pexels, ElevenLabs when this
    # channel narrates with it) stops the run right after the report, before the
    # first paid call: without Pexels the media stage finds nothing and the run
    # used to render a black video, exit 0, and be charged (CLAUDE.md rule 6).
    health = None
    try:
        health = check_run_credentials(ctx)
        # A run that will upload asks Google, for free and before the first paid step, whether this
        # channel's YouTube token still refreshes: a revoked or expired one used to be found only at
        # the upload, after the script, the voice and the render were paid for. A dead token joins the
        # blocking list below (the same early stop as a missing key); an unknown goes on. A run that
        # will not upload (--no-upload, auto-publish off) needs no token and is not asked.
        if not skip_upload and ctx.auto_publish:
            health = with_live_youtube_check(health, ctx)
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
    if health is not None and health.blocking:
        raise CredentialsMissing(
            "Run stopped before spending anything: required credential(s) not configured — "
            + "; ".join(f"{c.name}: {c.detail or 'missing'}" for c in health.blocking))
    # Disk — a full volume kills the render after the script and the voice are paid for.
    # Checked here, right after the credentials and before the first spend (CLAUDE.md #6).
    _preflight_disk(channel_id)
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
                # Not a return: an exit-0 "success" with no video was captured in
                # full by the queue worker. __main__ turns this into BUDGET_STOP_EXIT.
                raise budget.BudgetStop(f"spend ceiling reached (${budget_status.spent_usd:.2f} "
                                        f"of ${ceiling:.2f} this month)")
        except budget.BudgetStop:
            raise
        except Exception as e:
            logger.warning("Budget preflight failed (%s: %s) — continuing without a ceiling check",
                           type(e).__name__, e)
    # What this run consumes. Recorded whether or not it ends in an upload —
    # a render that is later blocked still cost real money.
    costs = CostLedger(channel_id=channel_id)
    _RUN_COSTS[:] = [costs]
    # An exhausted daily cap stops the run before any paid planning (topic, research, script).
    _guard_spend(ctx, costs, "the topic")
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

    # ── Stage 0c: Can the configured b-roll model be called at all?
    # Same reasoning as the voice: with generated b-roll on, a model id this
    # pipeline cannot call (or a required endpoint not set) is known now, from
    # config alone — not after the script has been paid for. No request is made.
    try:
        video_providers.preflight()
    except VideoModelUnavailable as e:
        logger.error("Generated b-roll is not usable for channel %s: %s", channel_id, e)
        events.emit(events.AGENT_FAILED, agent="minimax_broll", status=events.STATUS_FAILED,
                    channel_id=channel_id, metadata={"error": str(e), "stage": "preflight"})
        raise

    # ── Stage 0c': image generator and presenter, same reasoning
    # Asked for but unusable (unknown provider, missing key/credentials) stops
    # the run here, before the script is paid for, instead of quietly becoming
    # stock stills / a faceless cut (CLAUDE.md #4). Config only: no request.
    _preflight_pictures(ctx, series_obj, channel_id)

    # ── Stage 0d: Channel DNA's style kit and characters
    # Read now, before anything is paid for: a kit or character the generated
    # pictures could not carry stops the run here with the remedy, never
    # after the script (CLAUDE.md #4, #6). Only when this run generates
    # pictures — stock footage has nothing for a look to steer.
    dna_look = None
    pictures = dna_render.generates_pictures()
    if pictures:
        try:
            dna_look = dna_render.load_look(ctx)
        except dna_render.DnaUnavailable as e:
            logger.error("Channel DNA cannot be used for channel %s: %s", channel_id, e)
            events.emit(events.AGENT_FAILED, agent="dna_render", status=events.STATUS_FAILED,
                        channel_id=channel_id, metadata={"error": str(e), "stage": "preflight"})
            raise
        if dna_look.character_names:
            ctx = _dc_replace(ctx, dna=_dc_replace(ctx.dna, character_names=dna_look.character_names))
    events.emit(events.DNA_APPLIED, agent="dna_render", status=events.STATUS_COMPLETED,
                channel_id=channel_id,
                metadata={**render_fmt.to_metadata(), "pictures_generated": pictures,
                          "look": dna_look.to_metadata() if dna_look is not None else None})

    # ── Resume a crashed run ────────────────────────────────────────────
    # With --resume, reuse a previous run's saved artifacts instead of paying to
    # regenerate them. Today that means loading the saved script.json — skipping
    # the topic/research/script Gemini calls — which is the same reuse
    # --script-file has always offered, now found automatically from the run
    # checkpoint (by topic when given, else the most recent unfinished run). A
    # stage is only reused when its files are still on disk. Off (the default) ⇒
    # the flow below is byte-for-byte unchanged, and this never raises.
    if resume and not script_file:
        cp = None
        if topic:
            # The channel's own run: its keyed directory, or (a run started
            # before the key existed) the topic's, when its checkpoint names
            # this channel.
            for cand in run_slug.candidates(topic, str(channel_id), operators=ctx.is_operators):
                found = run_checkpoint.load(cand)
                if found is not None and (found.channel_id or str(channel_id)) == str(channel_id):
                    cp = found
                    break
        else:
            cp = run_checkpoint.latest_incomplete(channel_id=str(channel_id))
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

    # ── Resume from an approved storyboard (modules/storyboard_review.py)
    # Approving a storyboard starts this same run again with --resume --topic.
    # Its approved script — the scenes the person read and paid for — replaces
    # whatever the checkpoint saved, and is written where --script-file reads
    # it, so the planning stages are skipped exactly as on any resume. Found in
    # Supabase, not on this machine's disk: the runner that resumes may not be
    # the one that planned.
    approved_storyboard = None
    if resume and topic:
        # The slugs this channel's run of the topic may be stored under: its
        # keyed one, and the topic's alone for a run begun before the key.
        approved_storyboard = storyboard_review.approved_for_resume(
            channel_id, topic,
            slugs=run_slug.candidates(topic, str(channel_id), operators=ctx.is_operators))
        if approved_storyboard is not None:
            script_file = str(approved_storyboard.script_path)
            events.emit(events.RUN_RESUMED, agent="pipeline", status=events.STATUS_RUNNING,
                        channel_id=channel_id,
                        metadata={"slug": approved_storyboard.script_path.parent.name, "reused": "storyboard",
                                  "storyboard_id": approved_storyboard.storyboard_id})

    # ── Stages 1-2: Topic and Script
    # A saved script skips both Gemini calls, so a crash in a later stage — or a
    # spent daily quota — does not mean paying for generation again.
    topic_mgr = TopicManager(channel=ctx, costs=costs)
    # history/ is only an Actions cache: after a long pause or a lost cache the channel has no memory of what it
    # made. Rebuild it (read only) from the channel's own videos in Supabase before any topic is chosen or checked.
    topic_mgr.seed_history_from_supabase()
    # A run held before the render never registers its topic, so the picker would offer it again. Only when the
    # system picks: an explicit --topic (a dispatch's `topic` input, a resume, a script file) is never held back.
    if topic is None and not script_file:
        topic_mgr.load_held_topics()

    if script_file:
        script = ScriptEngine.load(Path(script_file), topic)
        topic = script.topic
        logger.info("Script loaded from %s — no API calls", script_file)
    else:
        if topic is None and getattr(config, "AGENT_AUTOPILOT", False):
            topic = _agent_pick_topic(channel_id, video_provider=_active_video_provider())
            # The planner ranks trending titles with no memory of what this
            # channel already made: without this, one strong trend is the day's
            # video every day.
            repeat = topic_mgr.find_repeat(topic) if topic else None
            if repeat:
                logger.warning("Autopilot topic %r repeats this channel's own %r — using the topic manager",
                               topic, repeat)
                topic = None
            # ...nor with any memory of what the channel is ABOUT: a trending
            # celebrity teaser is a strong trend. Same niche gate and sensitive
            # screen as the queue (modules/topic_gate.py); a refused or
            # unconfirmed topic falls through to the topic manager below.
            if topic and niche_chosen and not topic_mgr.vet_topic(topic, niche, source="autopilot").accepted:
                topic = None
        if topic is None:
            try:
                topic = topic_mgr.pick_topic(niche if niche_chosen else None)
            except TopicSelectionError as e:
                # Without this the owner sees only a red CI run. Counts and fixed
                # words only: the message names candidate titles and history.
                logger.error("[channel: %s] Topic selection stopped the run before it spent anything: %s",
                             channel_id, e)
                events.emit(events.AGENT_FAILED, agent="topic_manager", status=events.STATUS_FAILED,
                            channel_id=channel_id,
                            metadata={"error": f"TopicSelectionError: {e.code}", "stage": "topic",
                                      "attempts": e.attempts, "kinds": list(e.kinds)})
                raise
        logger.info("Topic: %s", topic)
    events.emit(events.TOPIC_SELECTED, agent="topic_manager", status=events.STATUS_COMPLETED,
                channel_id=channel_id,
                metadata={"topic": topic, **({"series_id": series_obj.series_id} if series_obj else {})})

    # ── Pipeline stage tracking (audit trail only — does NOT gate publish)
    # This run is tracked through Topic -> Research -> Script -> Fact Check ->
    # Human Approval so the record is honest about what actually happened at
    # each stage. It deliberately stops at Human Approval: approve() is never
    # called here, so the run never reaches Publish through this mechanism.
    # Upload below proceeds independent of this state: what can hold or block it
    # is the publish gate and, per channel, the two-person approval further down
    # (modules/publish_gate.py, modules/publish_approval.py), not this record.
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

    slug = _run_slug(topic, ctx)
    costs.slug = slug
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
    narration_claim_count = None
    grounding_summary = None
    packaging_repair_record = None
    try:
        # Each claim carries its section (claim_id c000-1, scene s000), so the
        # Storyboard can show which scene says what (modules/claim_scenes.py).
        # The same call checks every other text that ships — the alternate hook
        # (swapped in AFTER this check), the title(s), the description, the
        # thumbnail text — so a flagged claim anywhere blocks, not only one in
        # the narration.
        section_claims = extract_shipped_claims(script)
        narration_claim_count = sum(1 for c in section_claims if c.source == SOURCE_NARRATION)
        claims = [c.text for c in section_claims]
        fact_results = fact_check_claims(claims) if claims else []
        # Evidence from the English Wikipedia (modules/grounding.py), applied AFTER the checker has
        # given its own verdicts without seeing it: it can upgrade a claim only with a quote that is
        # verified in code, add a flag on a contradiction, and when the lookup is unavailable every
        # verdict stays exactly as the checker gave it. Switch: NIGHTSHIFT_GROUNDED_FACTCHECK=off.
        if fact_results:
            if grounding.enabled():
                fact_results, grounding_summary = _ground_fact_results(
                    ctx, costs, topic, slug, claims, section_claims, fact_results)
            else:
                grounding_summary = grounding.disabled_summary()
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
    except gemini_stages.GeminiDailyQuotaError:
        # The checker's quota is spent for the day: going on would buy the voice, stills and render for a video the
        # final gate blocks as fact_check_not_run. Stop now (exit 80); the saved script is reused by --resume.
        raise
    except Exception as e:
        logger.warning("Fact-checker failed (%s: %s) — proceeding without fact-check results",
                        type(e).__name__, e)

    # ── Stop here, not after the render, when the gate would block on this check.
    # The same verdict publish_gate.evaluate reaches on the finished video, taken
    # before the voice, the stills and the render are bought (CLAUDE.md #6). Only
    # a check that ran can stop the run here; one that crashed (None) still goes
    # on to the gate. The gate below stays the final authority.
    if fact_results is not None:
        early = publish_gate.evaluate_fact_check(
            script=script, fact_results=fact_results, channel=ctx,
            narration_claims=narration_claim_count, claims=section_claims,
            language=getattr(ctx.agent, "language", None), grounding=grounding_summary)
        repair = None
        if not early.allowed and approved_storyboard is None:
            # A person-approved storyboard's texts are never rewritten.
            repair = _repair_packaging(ctx, costs, topic, slug, script, research_brief, section_claims,
                                       fact_results, early, grounding_summary)
        if repair is not None:
            packaging_repair_record = repair.record
            _save_packaging_repair(slug, repair)
            if repair.passed:
                # What the gate re-checked is what ships: the rewritten texts go into the script itself, and the
                # claims and results now describe it (the narration's own are carried over untouched).
                for name, value in repair.fields.items():
                    setattr(script, name, value)
                section_claims, fact_results, early = repair.claims, repair.results, repair.decision
                narration_claim_count = sum(1 for c in section_claims if c.source == SOURCE_NARRATION)
                _resave_after_packaging_repair(slug, script, script_file, section_claims, fact_results)
        if not early.allowed:
            _hold_before_render(ctx, slug=slug, topic=topic, script=script, claims=section_claims,
                                fact_results=fact_results, decision=early, costs=costs,
                                grounding_summary=grounding_summary, packaging_repair_record=packaging_repair_record)
            raise publish_gate.HeldBeforeRender(", ".join(early.blocks))

    pipeline.advance(run_record.run_id, PipelineStage.HUMAN_APPROVAL)

    # First-30-seconds hook A/B (roadmap #60). Which opening this video ships is
    # decided on retention (modules/hook_ab.py). The "B" arm swaps the first
    # section's narration for the script's alternate opening BEFORE audio is
    # synthesized, so the whole pipeline (voice, subtitles, render) carries the
    # chosen hook. "A", or a "B" with no alternate available, keeps the original
    # opening and records "A" — the readback is never credited to an experiment
    # that did not actually happen.
    # An approved storyboard's script already carries the opening it was
    # approved with: the hook is not picked (or swapped) a second time.
    if approved_storyboard is not None:
        hook_variant = approved_storyboard.hook_variant
        if approved_storyboard.opening_edited:
            # The person rewrote or replaced the opening before approving
            # (migration 0058): it is neither arm, so no arm is credited.
            hook_variant = ""
    else:
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

    # ── Storyboard review (modules/storyboard_review.py, off unless the channel
    # turned it on). The last point before the run pays for the scenes: the
    # voice below, then generated footage and stills, then the render. With
    # review on, the run stops here with its scene plan stored for a person,
    # and exits with storyboard_review.PAUSED_EXIT — the runner then releases
    # this run's credit hold. An approved storyboard was loaded above and goes
    # straight on. Off and not a resume: no request, nothing changes.
    try:
        storyboard_review.checkpoint(ctx, slug=slug, topic=topic, script=script,
                                     hook_variant=hook_variant, resume=resume,
                                     approved=approved_storyboard)
    except storyboard_review.StoryboardPaused as paused:
        logger.info("[channel: %s] Storyboard %s (%s) — stopping before the render; nothing "
                    "renders until it is approved", channel_id, paused.storyboard_id, paused.reason)
        events.emit(events.STORYBOARD_READY if paused.reason == "ready" else events.STORYBOARD_STOPPED,
                    agent="storyboard", status=events.STATUS_COMPLETED, channel_id=channel_id,
                    metadata={"storyboard_id": paused.storyboard_id, "reason": paused.reason,
                              "slug": slug, "scenes": len(script.sections)})
        _flush_costs(costs, slug)
        raise
    except storyboard_review.StoryboardUnavailable as e:
        logger.error("[channel: %s] Storyboard review is on, but the storyboard could not be "
                     "stored or read: %s — the run stops before the render", channel_id, e)
        events.emit(events.AGENT_FAILED, agent="storyboard", status=events.STATUS_FAILED,
                    channel_id=channel_id, metadata={"error": str(e), "stage": "storyboard"})
        _flush_costs(costs, slug)
        raise

    # Per-section Pexels keywords — already inside the script JSON, no API call.
    keyword_map = ScriptEngine.extract_visual_keywords(script)

    # ── Stage 3: Audio
    _guard_spend(ctx, costs, "the voice")
    events.emit(events.VOICE_STARTED, agent="audio_mixer", status=events.STATUS_RUNNING, channel_id=channel_id)
    mixer = AudioMixer(slug, channel=ctx)
    audio_path, timeline = mixer.build(script)
    # Only what was actually synthesized — cached segments cost nothing this run.
    costs.add(TTS_CHARACTERS, mixer.characters_synthesized, stage="voice")
    events.emit(events.VOICE_COMPLETED, agent="audio_mixer", status=events.STATUS_COMPLETED,
                channel_id=channel_id, metadata=_voice_record(mixer))
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

    # Stills go BEFORE b-roll: they are cheap and share no state with the clips, so a
    # refused image key stops the run before any clip is paid for.
    # Optional: generate on-topic stills with the selected image provider
    # (Leonardo), supplementing the Pexels images above. Off unless a key + flag
    # are set; a model that returns nothing falls back to stock, a refusal stops the run.
    _guard_spend(ctx, costs, "generating stills", planned=(
        [(IMAGE_GENERATIONS, config.LEONARDO_MAX_IMAGES)] if image_providers.is_enabled() else None))
    try:
        gen_images = fetcher.generate_images(
            script.sections, topic, prompt_hook=dna_render.scene_prompt_hook(dna_look, script.sections),
            size=render_fmt.image_size)
    except image_providers.ImageProviderUnavailable as e:
        # The generator that was chosen refused (credentials, quota, policy):
        # stop with the remedy instead of shipping stock stills (CLAUDE.md #4).
        logger.error("Generated images failed for channel %s: %s", channel_id, e)
        events.emit(events.AGENT_FAILED, agent="image_providers", status=events.STATUS_FAILED,
                    channel_id=channel_id, metadata={"error": str(e), "stage": "images"})
        raise
    _record_stills(costs, fetcher, gen_images, channel_id)
    if gen_images:
        images = list(gen_images) + list(images)
    # Optional: generate on-topic b-roll for a few sections with MiniMax H3,
    # supplementing the stock above. Off unless a key + flag are set, in which
    # case it makes no request and changes nothing. Generated clips join the
    # pool and are recorded in fetcher.video_terms, so broll_match places them.
    # Each generated clip carries its scene's Director shot direction and its
    # Character-Bible consistency directive (whichever are present).
    # When generated b-roll is on, a clip the configured model did not produce
    # stops the run with the remedy — it is never quietly replaced by stock.
    _guard_spend(ctx, costs, "generating b-roll clips", planned=(
        [(VIDEO_GEN_CLIPS, config.MINIMAX_BROLL_MAX_CLIPS)] if video_providers.is_enabled() else None))
    try:
        broll = fetcher.generate_broll(
            script.sections, topic, style_for=_scene_style,
            prompt_hook=dna_render.scene_prompt_hook(dna_look, script.sections),
            aspect_ratio="" if render_fmt.aspect_source == "default" else render_fmt.aspect)
    except VideoModelUnavailable as e:
        logger.error("Generated b-roll failed for channel %s: %s", channel_id, e)
        events.emit(events.AGENT_FAILED, agent="minimax_broll", status=events.STATUS_FAILED,
                    channel_id=channel_id, metadata={"error": str(e), "stage": "broll"})
        raise
    if broll.generated:
        videos.extend(Path(p) for p in broll.by_section.values())
        from modules import video_providers as _vp
        # Clips reused from an earlier attempt's ledger cost nothing new this run.
        costs.add(VIDEO_GEN_CLIPS, broll.newly_generated, stage=f"broll:{_vp.active_provider()}")
        events.emit(events.BROLL_GENERATED, agent="minimax_broll", status=events.STATUS_COMPLETED,
                    channel_id=channel_id, metadata=broll.to_dict())
    logger.info("Media: %d videos (%d AI-generated), %d images (%d AI-generated)",
                len(videos), broll.generated, len(images), len(gen_images))
    try:
        # Every Pexels search/download failed (dead key, quota, outage — the
        # fetcher swallows each one) and no generated media made up for it: the
        # compositor would draw a black background for the whole video, exit 0,
        # and the customer would be charged for it.
        require_media(videos, images, allow_placeholder=placeholder_media_allowed())
    except MediaUnavailable as e:
        logger.error("[channel: %s] %s", channel_id, e)
        events.emit(events.AGENT_FAILED, agent="media_fetcher", status=events.STATUS_FAILED,
                    channel_id=channel_id, metadata={"error": str(e), "stage": "media"})
        raise
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
    word_clips_specs = sub_gen.word_clips(word_timestamps, render_fmt.width, render_fmt.height)
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
        generated_images=gen_images, width=render_fmt.width, height=render_fmt.height, fps=config.VIDEO_FPS,
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
    # No silent fallback: an enabled-but-unconfigured or unsafe request stops the
    # run with the reason — a blank/wrong presenter is never shipped, a faceless
    # cut is not substituted for the presenter that was asked for, and the
    # publish gate below still decides every upload.
    presenter_path = None
    avatar_cfg = resolve_avatar_config(ctx, series_obj)
    if avatar_cfg.enabled:
        # The Higgsfield clip is not in the cost ledger (no unit), so for it this only stops on what was spent
        # before it. The fal presenter brings its worst-case USD, so the run and day caps see it too.
        _guard_spend(ctx, costs, "generating the presenter", extra_usd=planned_presenter_usd(avatar_cfg))
        events.emit(events.AVATAR_STARTED, agent="avatar", status=events.STATUS_RUNNING,
                    channel_id=channel_id, metadata={"provider": avatar_cfg.provider})
        try:
            presenter_prompt = avatar_cfg.character_prompt or (series_obj.visual_style if series_obj else "")
            # The fal presenter is driven by the clean narration (speech only, the same timeline as the
            # mix), and writes what it was billed to the ledger as it goes, so a failure half way keeps
            # the record of what was already paid for.
            presenter_path = maybe_generate_presenter(
                avatar_cfg, presenter_prompt, OUTPUT_DIR / slug / "presenter.mp4",
                narration_path=presenter_narration(OUTPUT_DIR / slug, audio_path),
                frame_size=(render_fmt.width, render_fmt.height),
                on_spend=lambda unit, qty, stage, usd: costs.add(unit, qty, stage=stage, estimated_usd=usd))
            events.emit(events.AVATAR_COMPLETED, agent="avatar", status=events.STATUS_COMPLETED,
                        channel_id=channel_id, metadata={"presenter_path": ", ".join(describe_presenter(presenter_path))})
            logger.info("Presenter generated: %s", ", ".join(describe_presenter(presenter_path)))
        except (AvatarUnavailable, UnsafeAvatarRequest) as e:
            # A presenter was asked for: the run stops (CLAUDE.md #4) instead of
            # quietly going out faceless. The generated pieces stay in the
            # checkpoint, so the re-run after the fix does not repeat them.
            logger.error("Presenter unavailable (%s: %s) — stopping; the run was set up with a presenter",
                         type(e).__name__, e)
            events.emit(events.AVATAR_FAILED, agent="avatar", status=events.STATUS_FAILED,
                        channel_id=channel_id, metadata={"error": f"{type(e).__name__}: {e}"})
            raise
    else:
        events.emit(events.AVATAR_SKIPPED, agent="avatar", status=events.STATUS_COMPLETED,
                    channel_id=channel_id, metadata={"reason": "avatar not enabled"})

    # ── Stage 7: Compositor
    events.emit(events.RENDER_STARTED, agent="compositor", status=events.STATUS_RUNNING, channel_id=channel_id)
    render_started = time.monotonic()
    comp = Compositor(slug, width=render_fmt.width, height=render_fmt.height)
    # Two runs have died in here without leaving a reason. If a third does,
    # the sampler's last line is the state just before the kill.
    # config.RENDER_BACKEND picks the renderer (modules/render_dispatch.py):
    # "moviepy" (default) is the call below, unchanged; "ffmpeg" renders a
    # RenderSpec from the same inputs and falls back to this call on any failure.
    with MemorySampler("render"), _presenter_stop_recorded(channel_id):
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
            # The compositor's own per-word caption specs: the ffmpeg paths burn
            # them as the same word-highlighted lines (an .ass beside the .srt;
            # the .srt itself is unchanged and still goes to YouTube).
            word_captions=word_clips_specs,
            width=render_fmt.width, height=render_fmt.height, fps=config.VIDEO_FPS,
            # CHRONOS_SCENE_RENDER=1: render per IR scene with a cache (modules/scene_render.py).
            ir_project=ir_project,
        )
    video_path = render_result.video_path
    costs.slug = slug
    costs.add(RENDER_SECONDS, time.monotonic() - render_started, stage="render")
    logger.info("Video: %s (render backend: %s)", video_path, render_result.backend)
    events.emit(events.RENDER_COMPLETED, agent="compositor", status=events.STATUS_COMPLETED,
                channel_id=channel_id,
                metadata={"video_path": str(video_path), **render_result.to_metadata()})
    run_checkpoint.record_stage(slug, run_checkpoint.STAGE_RENDER, artifacts={"video": str(video_path)})
    run_checkpoint.write_result(slug, video_path)
    # The video exists on disk now. If this topic came off the content-planner
    # queue, record that it reached "rendered" — true whether or not the upload
    # below succeeds, so a blocked or failed-upload run leaves an honest
    # "rendered", never a false "published".
    topic_mgr.mark_queue_entry_rendered()
    # The approved storyboard (if this run rendered one) is now rendered.
    storyboard_review.mark_rendered(approved_storyboard)
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
    # A scene Remotion really drew as a designed card is a still frame on purpose; a
    # card recipe alone proves nothing (the default render ignores recipes).
    qc_report = video_qc.run(video_path, audio_path=audio_path, timeline=timeline,
                             expected_width=render_fmt.width, expected_height=render_fmt.height,
                             static_scene_ids=video_qc.static_scene_ids(
                                 ir_project, getattr(render_result, "scene_render", None)))
    gate = publish_gate.evaluate(
        script=script,
        video_path=video_path,
        topic=topic,
        fact_results=fact_results,
        channel=ctx,
        qc_report=qc_report,
        ir_project=ir_project,
        # What the uploader will send, not script.title: the A/B arm may ship title_ab.
        title=published_title,
        narration_claims=narration_claim_count,
        claims=section_claims,
        language=getattr(ctx.agent, "language", None),
        grounding=grounding_summary,
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
        from modules import publish_approval, scene_repair
        # A targeted scene repair of this run voids any approval decided
        # before it (modules/scene_repair.py): the approved cut is gone.
        if not publish_approval.has_approved(channel_id, slug=slug, topic=topic,
                                             not_before=scene_repair.repaired_at(slug)):
            awaiting_two_person = True

    def _record_held_run(state: str, *, gate_meta=None) -> None:
        """A run that ends without uploading gets a `videos` row of its own
        (modules/held_video.py): its detail page, and the Storyboard's scene
        repair, need one. Keyed by channel + slug, so a later hold or upload of
        this same run updates this row instead of adding another. Published
        time, privacy and YouTube id stay NULL — it was not published. Records
        only; never uploads, never changes what the gate decided, never raises."""
        try:
            try:
                held_scenes = claim_scenes.annotate_scenes(script, section_claims, fact_results)
            except Exception:
                held_scenes = None
            detail = held_video.gate_detail(state, gate_meta)
            # The flagged title / description / thumbnail / hook texts belong to no scene: say them here.
            flagged = held_video.flagged_claims(section_claims, fact_results)
            if flagged:
                detail["flagged"] = flagged
            # The lookup's summary rides in the gate's own metadata (fact_check.grounding).
            evidence = held_video.grounding_detail(
                ((gate_meta or {}).get("fact_check") or {}).get("grounding") if isinstance(gate_meta, dict) else None)
            if evidence:
                detail["grounding"] = evidence
            if packaging_repair_record:
                detail["packaging_repair"] = packaging_repair_record
            held_video.record_held(
                channel_id=channel_id,
                slug=slug,
                state=state,
                topic=topic,
                title=published_title,
                script_text=script.full_narration(),
                scenes=held_scenes,
                manifest=ir_project.to_dict() if ir_project is not None else None,
                local_path=str(video_path),
                detail=detail,
            )
            # The finished cut must be watchable, not only listed: put the 480p
            # review copy and the script where the Command Center reads them,
            # exactly as an uploaded video's does. Same stand-in id as the row
            # above, so it merges into it; review_state stays "pending".
            VideoReview().record(
                video_id=held_video.held_video_id(channel_id, slug),
                channel_id=channel_id,
                video_path=video_path,
                script_text=script.full_narration(),
                auto_publish=False,
                slug=slug,
                gate_verdict=held_video.gate_verdict(gate_meta),
            )
        except Exception as e:
            logger.warning("Could not record the held run (%s: %s) — the run is unaffected",
                           type(e).__name__, e)

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
            # The label for THIS cut, from what the run actually generated (not from the best-effort IR).
            ai_decision, ai_signals = ai_disclosure.for_run(
                ctx.agent, generated_clips=getattr(broll, "generated", 0),
                generated_stills=len(gen_images or []), presenter=presenter_path is not None)
            uploaded = uploader.upload(
                video_path, script, thumbnail_path=chosen_thumb, privacy=privacy,
                ai_disclosure=ai_decision,
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
            # What YouTube APPLIED, not what was asked for: an API project that has not passed the
            # audit has every upload locked private whatever privacyStatus says, and a video
            # recorded as the REQUESTED privacy would read as published when it is not. The row and
            # the events say what the video has; the Short never goes wider than what was asked.
            # No `privacy` assignment here: the clamp above is its only one (a test pins that).
            outcome = reconcile_privacy(privacy, uploaded.get("privacy"))
            recorded_privacy, short_privacy = outcome.recorded, outcome.limit
            if outcome.mismatch:
                logger.error("[channel: %s] YouTube applied privacy %r, not the requested %r — "
                             "recording what the video has", channel_id, recorded_privacy, privacy)
                events.emit(events.PRIVACY_FORCED, agent="youtube_uploader", status=events.STATUS_COMPLETED,
                            channel_id=channel_id, video_id=video_id,
                            metadata={"requested": str(privacy), "applied": str(recorded_privacy)})
            # Recorded only on a successful upload — a failed attempt may have
            # sent bytes, but it did not deliver a video, and guessing how many
            # got through would be inventing a number.
            try:
                costs.add(UPLOAD_BYTES, float(video_path.stat().st_size), stage="upload")
            except OSError:
                logger.debug("Could not stat %s for the cost ledger", video_path, exc_info=True)
            logger.info("YouTube URL: %s", video_url)
            print(f"\n✓ Published: {video_url}")
            _published_at = datetime.utcnow().isoformat()
            with StateStore() as store:
                store.record_video(
                    video_id=video_id,
                    topic=topic,
                    title=published_title,
                    slug=slug,
                    published_at=_published_at,
                    privacy=recorded_privacy,
                    category_id=YOUTUBE_CATEGORY_ID,
                    local_path=str(video_path),
                    channel_id=channel_id,
                    thumbnail_variant=variant,
                    title_variant=title_variant,
                    hook_variant=hook_variant,
                )
                # If this run was held before (blocked, awaiting approval,
                # auto-publish off, repaired), its held row becomes THIS video's
                # row — re-keyed to the YouTube id, so there is never a second
                # row for one run. No held row: a no-op, exactly as before.
                held_video.promote(
                    channel_id=channel_id,
                    slug=slug,
                    youtube_id=video_id,
                    published_at=_published_at,
                    privacy=recorded_privacy,
                    title=published_title,
                    topic=topic,
                    category_id=YOUTUBE_CATEGORY_ID,
                    local_path=str(video_path),
                    thumbnail_variant=variant,
                    title_variant=title_variant,
                )
                events.emit(events.UPLOAD_COMPLETED, video_id=video_id, agent="youtube_uploader",
                            status=events.STATUS_COMPLETED, channel_id=channel_id,
                            metadata={"url": video_url}, store=store)
                events.emit(events.VIDEO_PUBLISHED, video_id=video_id, agent="youtube_uploader",
                            status=events.STATUS_COMPLETED, channel_id=channel_id,
                            metadata={"title": published_title, "url": video_url, "privacy": recorded_privacy}, store=store)
                # What the video was labelled with, and why: read back by the review panel and by the
                # Instagram / TikTok cross-post, which must give the same answer for the same cut.
                events.emit(ai_disclosure.EVENT, video_id=video_id, agent="ai_disclosure",
                            status=events.STATUS_COMPLETED, channel_id=channel_id,
                            metadata=ai_decision.to_metadata(getattr(ctx.agent, "language", ""), ai_signals),
                            store=store)

            # The upload actually succeeded — advance this run's queue entry (if
            # any) to "published". Only here, at real upload success, never at
            # pick time.
            topic_mgr.mark_queue_entry_published()

            # The run is fully done — drop its checkpoint so a later run for the
            # same topic starts clean and a bare --resume never re-opens it. A
            # blocked, held or failed run deliberately keeps its checkpoint, so
            # --resume can reuse the saved script instead of re-paying for it.
            run_checkpoint.clear(slug)

            # If this run's series (else the channel's default) names a playlist,
            # add the freshly published video to it — a playlist keeps the series bingeable.
            # Best-effort and downstream of a live video: a playlist error never
            # turns a successful publish into a failed run. See modules/playlist.py.
            playlist_id = playlist.resolve_playlist_id(series_obj, ctx)
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
                    # The upload's own facts, so the row the review write may
                    # CREATE (the mirror usually has not run yet) reads as an
                    # uploaded video, not a held one. Same values the mirror
                    # upserts later; never privacy.
                    published_at=_published_at,
                    title=published_title,
                    topic=topic,
                    slug=slug,
                    # What the gate decided about THIS cut, stored with its hash: an approval binds to both
                    # (migration 0112). Uploads happen only when it allowed.
                    gate_verdict=held_video.gate_verdict(gate.to_metadata()),
                )
            except Exception as e:
                logger.warning("Could not record the review preview (%s: %s)",
                               type(e).__name__, e)
        except Exception as e:
            # Channel-tagged so one channel's credential failure is visibly
            # that channel's, and does not read as a Nightshift-wide outage.
            logger.error("[channel: %s] YouTube upload failed (%s): %s", channel_id, type(e).__name__, e)
            print(f"\n✓ Video saved, upload failed: {video_path}")
            # A fixed word for the owner and the alerts (out of quota today is not a broken token).
            upload_cause = held_video.upload_failure_cause(e)
            events.emit(events.UPLOAD_FAILED, agent="youtube_uploader", status=events.STATUS_FAILED,
                        channel_id=channel_id,
                        metadata={"operation": "upload", "error": f"{type(e).__name__}: {e}",
                                  "cause": upload_cause})
            # The render exists, so the customer must be able to see it: give
            # the run a held row (with its preview) saying the upload failed.
            # Only when no YouTube id came back — a failure after a real upload
            # (playlist, comment) must not turn a live video into a held one.
            # The reason is our own fixed word; the exception text stays in the
            # log/event above and is never stored on the row.
            if video_id is None:
                _record_held_run(held_video.STATE_HELD,
                                 gate_meta={**gate.to_metadata(), "reason": upload_cause})
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
                privacy=short_privacy,
                timeline=timeline,
                costs=costs,
                ai_decision=ai_decision,
                ai_signals=ai_signals,
            )
    elif not gate.allowed:
        # Already reported above. The run is not uploaded, so it gets a held
        # row of its own — its detail page is where a human sees why it
        # stopped and can ask for a scene to be repaired.
        if not skip_upload:
            _record_held_run(held_video.STATE_BLOCKED, gate_meta=gate.to_metadata())
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
        _record_held_run(held_video.STATE_AWAITING_APPROVAL, gate_meta=gate.to_metadata())
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
        _record_held_run(held_video.STATE_HELD, gate_meta=gate.to_metadata())
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

    # Bookkeeping after a finished (maybe published) run: a failure here must
    # not turn that run into a failed one — the video exists either way.
    try:
        topic_mgr.register_topic(topic, video_path, video_id=video_id, video_url=video_url)
    except Exception as e:
        logger.error("[channel: %s] Topic history could not be written (%s) — the run itself is unaffected",
                     channel_id, type(e).__name__)
        # Not AGENT_FAILED: the Command Center reads every agent.failed as the AI
        # integration failing, and this is local file bookkeeping.
        events.emit(events.TOPIC_HISTORY_WRITE_ERROR, agent="topic_history", status=events.STATUS_WARNING,
                    channel_id=channel_id, metadata={"error": type(e).__name__})

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
    # Targeted repair (modules/scene_repair.py): re-fetch and re-render only
    # these scenes of the channel's unfinished run, then hold the new cut for
    # review. It never uploads. Validated strictly; the run must already exist.
    parser.add_argument("--repair-scenes", dest="repair_scenes", default=None,
                        help="Repair only these scenes of the channel's last unfinished run "
                             "(e.g. '3,17' or 's003,s017'), then hold the new cut for review. "
                             "With --topic, repairs that topic's run.")
    # Scene regeneration v2 (modules/scene_regenerate.py, migration 0076): one
    # scene of the run --topic names, made again with the source it was made
    # with, as priced and held by the person's press. The terms come from the
    # queue worker in SCENE_REGEN_* env vars; it never uploads.
    parser.add_argument("--regenerate-scene", dest="regenerate_scene", default=None,
                        help="Regenerate this one scene (e.g. 's003') of the run --topic names, "
                             "with the terms the queue worker passes in SCENE_REGEN_*; the new cut "
                             "is held for review.")
    args = parser.parse_args()

    if args.list_channels:
        list_channels()
    elif args.regenerate_scene is not None:
        if args.repair_scenes is not None or args.resume:
            print("--regenerate-scene excludes --repair-scenes and --resume")
            sys.exit(2)
        from modules import scene_regenerate
        sys.exit(scene_regenerate.cli(channel=args.channel, raw_scene=args.regenerate_scene,
                                      topic=args.topic))
    elif args.repair_scenes is not None:
        from modules import scene_repair
        sys.exit(scene_repair.cli(channel=args.channel, raw_scenes=args.repair_scenes,
                                  topic=args.topic))
    else:
        try:
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
        except storyboard_review.StoryboardPaused as paused:
            # Not a failure and not a finished video: the run waits for a
            # person. The runners read this exit code and release the run's
            # credit hold instead of charging it (tools/queue_worker.py,
            # tools/credits_settle.py).
            print(f"\n⏸ Storyboard {paused.reason}: nothing renders until it is approved "
                  f"in the Command Center (storyboard {paused.storyboard_id}).")
            sys.exit(storyboard_review.PAUSED_EXIT)
        except publish_gate.HeldBeforeRender:
            # The fact-check would block the gate: nothing past the script was
            # bought. A distinct code so the runners release the credit hold
            # (tools/queue_worker.py, daily_video.yml) instead of reading "0".
            sys.exit(publish_gate.HELD_BEFORE_RENDER_EXIT)
        except budget.BudgetStop:
            # The ceiling stopped the run before it spent anything; the log and
            # the console line above say so. A distinct code so the runners
            # release the hold (tools/queue_worker.py) instead of reading "0".
            sys.exit(budget.BUDGET_STOP_EXIT)
        except gemini_stages.GeminiDailyQuotaError:
            # Gemini's per-day quota is spent for a stage the run cannot skip (the topic, the script). The one
            # log line (model, retry-after, fix) was written where the 429 arrived. Not a traceback, and a
            # distinct code so the runners release the credit hold and say why (tools/queue_worker.py).
            sys.exit(gemini_stages.GEMINI_QUOTA_EXIT)
        except SeriesNotRunnable as refusal:
            # A series was named and cannot run (unknown, not ACTIVE, another channel's). Nothing was spent;
            # the message says which and the fix. One line, no traceback, and a distinct code so the Actions
            # step stays red with its own annotation (.github/workflows/daily_video.yml).
            logger.error("Series not runnable: %s", refusal)
            sys.exit(SERIES_NOT_RUNNABLE_EXIT)
