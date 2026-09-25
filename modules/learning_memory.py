"""Learning memory — measured signals become proposals; only approved ones count.

What already happens without this module
----------------------------------------
The feedback loop changes prompts on its own, every run, with no human in it:
`FeedbackEngine.topic_scores_as_prompt_text()` feeds learned topic scores to
Topic Manager, `RetentionAnalyzer.as_prompt_text()` feeds hook/cliff numbers to
the script writer, and the thumbnail/hook A/B experiments lean toward their
winners. None of that is changed or gated here — it stays exactly as it was.

What this adds
--------------
A slower, human-approved layer on top (migration 0014, `learnings`):

    existing signals (topic scores, retention curves, A/B verdicts)
        -> propose()            one sentence + the evidence behind it,
                                stored as a PENDING row, deduplicated
        -> Learning page        an admin approves or rejects it
        -> approved_learnings_as_prompt_text()
                                ONLY approved rows are appended to the
                                topic / script prompt as extra context

A pending or rejected learning has no effect on any run. A decided row is never
re-opened or rewritten: new proposals are inserted with "ignore duplicates" on
(channel_id, dedup_key), and the refresh of a still-pending row's evidence is a
PATCH filtered on `status = pending`, so the database — not this code's view of
it — is what protects a human's decision.

Honesty rules (CLAUDE.md #5)
----------------------------
Every proposal is derived from a real stored measurement and carries it as
evidence. Below each source's own evidence floor (the feedback engine's scores,
`retention_analyzer.MIN_CURVES` — also for scene-level retention, counted in
distinct videos — the A/B `MIN_PER_VARIANT`/`MIN_LIFT`) nothing is proposed. `confidence` is a sample-size weight (n / (n + 3)), stated as such
— not a statistical significance — and it is None, never 0, when there is no
sample to weigh.

Never raises
------------
Everything here is advisory. Any failure — no Supabase, a network error, a bad
row — logs and degrades to "nothing proposed" / "" so neither the poll nor a
video run can be stopped by it.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Iterable, Optional

logger = logging.getLogger(__name__)

TABLE = "learnings"
_CONFLICT = "channel_id,dedup_key"

KIND_TOPIC = "topic"
KIND_RETENTION = "retention"
KIND_HOOK = "hook"
KIND_EXPERIMENT = "experiment"
KINDS = (KIND_TOPIC, KIND_RETENTION, KIND_HOOK, KIND_EXPERIMENT)

#: Which approved learnings reach which prompt. A topic learning is about WHAT
#: to make, so it goes to topic selection; the rest are about HOW the video is
#: written and packaged, so they go to the script writer.
TOPIC_PROMPT_KINDS = (KIND_TOPIC,)
SCRIPT_PROMPT_KINDS = (KIND_RETENTION, KIND_HOOK, KIND_EXPERIMENT)

STATUS_PENDING = "pending"
STATUS_APPROVED = "approved"
STATUS_REJECTED = "rejected"

#: Feedback-engine topic score (50 = channel average) at or above which a topic
#: is proposed as a strong one: 1.4x the channel's own average.
TOPIC_STRONG_SCORE = 70.0
#: ...and at or below which it is proposed as a weak one: 0.6x.
TOPIC_WEAK_SCORE = 30.0
#: Mean hook retention below this is proposed as a weak hook. The same bar
#: retention_analyzer uses for its "hook is losing most of the audience" line.
HOOK_WEAK = 0.70
#: Width of the bucket a retention cliff is grouped into (share of the video).
CLIFF_BUCKET = 0.10
#: Prior in the sample-size confidence n / (n + CONFIDENCE_PRIOR): 1 video ->
#: 0.25, 3 -> 0.5, 9 -> 0.75. A weight for "how much evidence", nothing more.
CONFIDENCE_PRIOR = 3
#: How many approved learnings a prompt carries at most, newest decision first.
PROMPT_LIMIT = 12

_MAX_KEY = 200


@dataclass(frozen=True)
class Proposal:
    kind: str
    dedup_key: str
    observation: str
    evidence: dict = field(default_factory=dict)
    confidence: Optional[float] = None

    def to_row(self, channel_id: str) -> dict:
        return {
            "channel_id": channel_id,
            "kind": self.kind,
            "dedup_key": self.dedup_key,
            "observation": self.observation,
            "evidence": self.evidence,
            "confidence": self.confidence,
            "status": STATUS_PENDING,
        }


def sample_confidence(n) -> Optional[float]:
    """n / (n + CONFIDENCE_PRIOR), or None when there is no usable sample."""
    try:
        count = int(n)
    except (TypeError, ValueError):
        return None
    if count <= 0:
        return None
    return round(count / (count + CONFIDENCE_PRIOR), 2)


def _norm(text) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()[:_MAX_KEY]


def _num(value) -> Optional[float]:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f else None  # NaN is unknown, not a number


# -- proposal builders (pure) ------------------------------------------------


def topic_proposals(rows: Iterable[dict], observed_on: str = "") -> list:
    """Strong / weak topics from the feedback engine's persisted scores.

    Only a topic whose score is clearly away from the channel average is
    proposed; a topic inside the band is not a learning. The direction is part
    of the dedup key, so a topic that flips from weak to strong is a NEW
    proposal rather than a silent rewrite of the one a human already judged.
    """
    out = []
    for row in rows or []:
        try:
            topic = str(row.get("topic") or "").strip()
            score = _num(row.get("score"))
            if not topic or score is None:
                continue
            if score >= TOPIC_STRONG_SCORE:
                direction, verdict = "strong", "outperformed"
            elif score <= TOPIC_WEAK_SCORE:
                direction, verdict = "weak", "underperformed"
            else:
                continue
            videos = row.get("videos_analyzed")
            reason = str(row.get("reason") or "").strip()
            observation = (
                f'Topic "{topic}" {verdict} this channel\'s own average '
                f"(score {score:.0f}; 50 = channel average"
                + (f"; {reason}" if reason else "")
                + ")."
            )
            out.append(Proposal(
                kind=KIND_TOPIC,
                dedup_key=f"topic:{direction}:{_norm(topic)}",
                observation=observation,
                evidence={
                    "source": "channel_topic_performance",
                    "topic": topic,
                    "score": score,
                    "videos_analyzed": videos,
                    "avg_views_per_day": _num(row.get("avg_views_per_day")),
                    "reason": reason or None,
                    "scored_on": row.get("updated_at"),
                    "thresholds": {"strong": TOPIC_STRONG_SCORE, "weak": TOPIC_WEAK_SCORE},
                    "observed_on": observed_on or None,
                },
                confidence=sample_confidence(videos),
            ))
        except Exception:
            logger.warning("learning_memory: skipping a malformed topic row", exc_info=True)
    return out


def retention_proposals(insights: list, observed_on: str = "") -> list:
    """A weak hook and a recurring drop-off point, from stored retention curves.

    Uses `retention_analyzer`'s own evidence floor (MIN_CURVES videos with a
    usable curve); below it, nothing — one video's curve is that video's story.
    A cliff is proposed only when at least half of the curves that have one put
    it in the same 10% window, so it is a pattern and not an average of noise.
    """
    from modules.retention_analyzer import HOOK_RATIO, MIN_CURVES

    insights = [i for i in (insights or []) if i is not None]
    if len(insights) < MIN_CURVES:
        return []
    out = []

    hooks = [(i.video_id, i.hook_retention) for i in insights if i.hook_retention is not None]
    if len(hooks) >= MIN_CURVES:
        mean_hook = sum(h for _, h in hooks) / len(hooks)
        if mean_hook < HOOK_WEAK:
            out.append(Proposal(
                kind=KIND_HOOK,
                dedup_key="hook:weak",
                observation=(
                    f"Only {mean_hook:.0%} of viewers are still watching at the end of the "
                    f"hook (first {HOOK_RATIO:.0%} of the video), across {len(hooks)} measured "
                    "videos: open harder and get into the story sooner."
                ),
                evidence={
                    "source": "retention_points",
                    "mean_hook_retention": round(mean_hook, 4),
                    "hook_window": HOOK_RATIO,
                    "threshold": HOOK_WEAK,
                    "videos": [{"video_id": v, "hook_retention": h} for v, h in hooks],
                    "observed_on": observed_on or None,
                },
                confidence=sample_confidence(len(hooks)),
            ))

    cliffs = [
        (i.video_id, i.cliff_at, i.cliff_drop)
        for i in insights
        if i.cliff_at is not None and i.cliff_drop is not None
    ]
    if len(cliffs) >= 2:
        buckets: dict = {}
        for video_id, at, drop in cliffs:
            # Rounded before flooring: 0.3 / 0.1 is 2.9999999999999996 in
            # floating point, which would file a 30% cliff under 20-30%.
            b = min(int(round(at / CLIFF_BUCKET, 9)), int(round(1 / CLIFF_BUCKET)) - 1)
            buckets.setdefault(b, []).append((video_id, at, drop))
        bucket, members = max(buckets.items(), key=lambda kv: (len(kv[1]), -kv[0]))
        if len(members) >= 2 and len(members) * 2 >= len(cliffs):
            lo, hi = bucket * CLIFF_BUCKET, (bucket + 1) * CLIFF_BUCKET
            mean_drop = sum(d for _, _, d in members) / len(members)
            out.append(Proposal(
                kind=KIND_RETENTION,
                dedup_key=f"retention:cliff:{int(round(lo * 100))}",
                observation=(
                    f"Viewers most often leave between {lo:.0%} and {hi:.0%} through the video "
                    f"({len(members)} of {len(cliffs)} measured drop-offs, about {mean_drop:.0%} "
                    "of the audience each time): put a reveal or an open loop there, not a recap."
                ),
                evidence={
                    "source": "retention_points",
                    "window": [round(lo, 2), round(hi, 2)],
                    "mean_drop": round(mean_drop, 4),
                    "videos": [
                        {"video_id": v, "cliff_at": a, "cliff_drop": d} for v, a, d in members
                    ],
                    "curves_with_cliff": len(cliffs),
                    "observed_on": observed_on or None,
                },
                confidence=sample_confidence(len(members)),
            ))
    return out


#: A scene group (one scene type or one shot recipe) whose median loss per
#: minute is at least this multiple of the channel's median scene is proposed
#: as losing viewers faster; at most SCENE_BETTER_RATIO, as holding them
#: better. The same 1.4x / 0.6x band the topic proposals use.
SCENE_WORSE_RATIO = 1.4
SCENE_BETTER_RATIO = 0.6
#: How many per-scene rows a scene proposal's evidence lists at most.
_SCENE_EVIDENCE_ROWS = 30
#: How many of the channel's most recent videos the scene-retention source reads.
SCENE_VIDEO_LIMIT = 50


def scene_retention_proposals(videos, observed_on: str = "") -> list:
    """Scene types / shot recipes that lose viewers faster (or slower) than the
    channel's median scene, from scene-level retention (modules/scene_retention).

    ``videos`` is ``[(video_id, [SceneRetention, ...]), ...]``. Evidence floor,
    the same discipline as retention_proposals: at least
    ``retention_analyzer.MIN_CURVES`` videos with measured scenes on the
    channel, and a group is judged only when its measured scenes come from at
    least that many DIFFERENT videos — one video's weak scene is that video's
    story. Compared on loss per minute, so a group is not "worse" merely for
    being longer. A group that is every measured scene is not compared with
    itself, and nothing is proposed when the channel median is not a positive
    loss (a ratio against zero or a rising curve means nothing).
    """
    from modules.retention_analyzer import MIN_CURVES
    from modules.scene_retention import median

    measured = []  # (video_id, SceneRetention) with a known rate
    for entry in videos or []:
        try:
            video_id, rows = entry
            for r in rows or []:
                if getattr(r, "drop_per_min", None) is not None:
                    measured.append((str(video_id), r))
        except Exception:
            logger.warning("learning_memory: skipping a malformed scene-retention entry", exc_info=True)
    if len({v for v, _ in measured}) < MIN_CURVES:
        return []
    channel_median = median([r.drop_per_min for _, r in measured])
    if channel_median is None or channel_median <= 0:
        return []

    groups: dict = {}
    for video_id, r in measured:
        if r.type:
            groups.setdefault(("type", r.type), []).append((video_id, r))
        if r.recipe:
            groups.setdefault(("recipe", r.recipe), []).append((video_id, r))

    out = []
    for (dimension, value), members in sorted(groups.items()):
        try:
            video_ids = {v for v, _ in members}
            if len(video_ids) < MIN_CURVES or len(members) >= len(measured):
                continue
            group_median = median([r.drop_per_min for _, r in members])
            if group_median is None:
                continue
            ratio = group_median / channel_median
            if ratio >= SCENE_WORSE_RATIO:
                direction, verdict = "worse", f"lose viewers {ratio:.1f}x faster than"
            elif ratio <= SCENE_BETTER_RATIO:
                direction, verdict = "better", f"hold viewers better than ({ratio:.1f}x the loss rate of)"
            else:
                continue
            subject = (
                f'Scenes of type "{value}"' if dimension == "type"
                else f'Scenes shot with the "{value}" recipe'
            )
            out.append(Proposal(
                kind=KIND_RETENTION,
                dedup_key=f"retention:scene_{dimension}:{direction}:{_norm(value)}",
                observation=(
                    f"{subject} {verdict} this channel's median scene "
                    f"({group_median * 100:.1f} vs {channel_median * 100:.1f} audience points lost "
                    f"per minute; {len(members)} measured scenes across {len(video_ids)} videos)."
                ),
                evidence={
                    "source": "retention_points+videos.manifest",
                    "dimension": dimension,
                    "value": value,
                    "group_median_drop_per_min": round(group_median, 4),
                    "channel_median_drop_per_min": round(channel_median, 4),
                    "ratio": round(ratio, 3),
                    "scenes": len(members),
                    "channel_scenes": len(measured),
                    "videos": [
                        {"video_id": v, "scene_id": r.scene_id, "drop_per_min": r.drop_per_min}
                        for v, r in members[:_SCENE_EVIDENCE_ROWS]
                    ],
                    "thresholds": {"worse": SCENE_WORSE_RATIO, "better": SCENE_BETTER_RATIO,
                                   "min_videos": MIN_CURVES},
                    "observed_on": observed_on or None,
                },
                confidence=sample_confidence(len(video_ids)),
            ))
        except Exception:
            logger.warning("learning_memory: skipping a malformed scene group", exc_info=True)
    return out


def scene_retention_inputs(store, channel_id: str, sync) -> list:
    """``[(video_id, [SceneRetention])]`` for this channel's recent long videos
    that have a stored Video IR (Supabase ``videos.manifest``, migration 0013)
    and a local retention curve with at least one measured scene.

    The IR lives only in Supabase (the runner's project.json is gone after the
    run), which is why this source needs ``sync``; without it, or before 0013
    is applied (the select then fails and returns []), it is simply empty."""
    from modules import scene_retention

    if sync is None or not getattr(sync, "enabled", False):
        return []
    rows = sync.select("videos", {
        "channel_id": f"eq.{channel_id}",
        "manifest": "not.is.null",
        # A held run (modules/held_video.py) has a manifest but was never
        # watched; it must not take one of the limited slots.
        "published_at": "not.is.null",
        "select": "video_id,manifest,video_format",
        "order": "published_at.desc.nullslast",
        "limit": str(SCENE_VIDEO_LIMIT),
    })
    out = []
    for row in rows or []:
        try:
            if not isinstance(row, dict) or row.get("video_format") == "short":
                continue
            video_id, manifest = row.get("video_id"), row.get("manifest")
            if not video_id or not isinstance(manifest, dict):
                continue
            mapped = scene_retention.for_video(manifest, store.retention_curve(video_id))
            if scene_retention.has_data(mapped):
                out.append((str(video_id), mapped))
        except Exception:
            logger.warning("learning_memory: scene retention unavailable for one video", exc_info=True)
    return out


#: Experiment kind (modules/experiments.py) -> the short name in a dedup key.
#: The key shape predates the Experiment view and must not change, or every
#: already-decided A/B learning would be proposed again under a new key.
_EXPERIMENT_KEY = {"thumbnail_title": "thumbnail", "hook": "hook"}


def experiment_proposals(experiments, observed_on: str = "") -> list:
    """A decided experiment (modules/experiments.py) becomes a pending learning.

    Only `status == "decided"` counts: a running or inconclusive experiment —
    below MIN_PER_VARIANT, or under MIN_LIFT — proposes nothing, so "no winner
    yet" is never turned into a lesson. The verdict is the experiment's own,
    which is the one the pipeline already acts on.
    """
    out = []
    for exp in experiments or []:
        try:
            if not getattr(exp, "decided", False):
                continue
            short = _EXPERIMENT_KEY.get(exp.kind)
            if short is None:
                continue
            winner = str(exp.winner)
            if exp.kind == "hook":
                lead = (
                    "The alternate opening (hook B) holds viewers longer than the primary opening"
                    if winner == "B"
                    else "The primary opening (hook A) holds viewers longer than the alternate opening"
                )
            else:
                lead = f"Thumbnail/title arm {winner} wins on click-through"
            reason = str(exp.evidence.get("reason") or "").strip()
            data = exp.to_dict()
            out.append(Proposal(
                kind=KIND_EXPERIMENT,
                dedup_key=f"experiment:{short}:{winner.lower()}",
                observation=f"{lead}: {reason}." if reason else f"{lead}.",
                evidence={
                    "source": "experiments",
                    "experiment_id": data["id"],
                    "metric": data["metric"],
                    "winner": winner,
                    "effect": data["effect"],
                    "reason": reason or None,
                    "variants": data["variants"],
                    "rules": data["evidence"].get("rules"),
                    "observed_on": observed_on or None,
                },
                # Weighed on the arms the verdict was actually drawn from; an arm
                # still filling up (below min_sample) took no part in it.
                confidence=sample_confidence(min(
                    (v.samples for v in exp.variants if v.samples >= exp.min_sample), default=0,
                )),
            ))
        except Exception:
            logger.warning("learning_memory: skipping a malformed experiment", exc_info=True)
    return out


# -- gathering from the local state store ------------------------------------


def gather_proposals(store, channel_id: str, observed_on: str = "", sync=None) -> list:
    """Every proposal the stored signals support for one channel. Each source is
    guarded on its own, so one broken read costs only its own proposals.

    ``sync`` is needed only by the scene-retention source (the Video IR is read
    back from Supabase); without it that one source is skipped."""
    observed_on = observed_on or date.today().isoformat()
    proposals: list = []

    try:
        rows = store.list_channel_topic_performance(channel_id=channel_id, limit=200)
        proposals.extend(topic_proposals(rows, observed_on))
    except Exception:
        logger.warning("learning_memory: topic scores unavailable for %s", channel_id, exc_info=True)

    try:
        from modules.retention_analyzer import RetentionAnalyzer

        insights = RetentionAnalyzer(state_store=store, channel_id=channel_id).insights()
        proposals.extend(retention_proposals(insights, observed_on))
    except Exception:
        logger.warning("learning_memory: retention insights unavailable for %s", channel_id, exc_info=True)

    try:
        proposals.extend(scene_retention_proposals(
            scene_retention_inputs(store, channel_id, sync), observed_on,
        ))
    except Exception:
        logger.warning("learning_memory: scene retention unavailable for %s", channel_id, exc_info=True)

    try:
        from modules.experiments import experiments_for_channel

        proposals.extend(experiment_proposals(experiments_for_channel(channel_id, store=store), observed_on))
    except Exception:
        logger.warning("learning_memory: experiments unavailable for %s", channel_id, exc_info=True)

    return proposals


# -- persistence (Supabase) --------------------------------------------------


def _make_sync(sync):
    if sync is not None:
        return sync
    from modules.supabase_sync import SupabaseSync

    return SupabaseSync()


def save_proposals(channel_id: str, proposals: list, sync=None) -> dict:
    """Store proposals as pending rows. Returns {"proposed", "refreshed"}.

    New keys are inserted with ignore-duplicates, so an existing row — pending,
    approved or rejected — is never overwritten by the insert. A key that is
    still pending gets its observation/evidence/confidence refreshed through a
    PATCH filtered on status=pending: if an admin decided it a moment ago, the
    filter matches nothing and the decision stands. Never raises.
    """
    summary = {"proposed": 0, "refreshed": 0}
    try:
        client = _make_sync(sync)
        if not getattr(client, "enabled", False) or not proposals:
            return summary
        # Dedupe within this batch too (last one wins) — PostgREST rejects a
        # batch that hits the same conflict key twice.
        by_key = {p.dedup_key: p for p in proposals}
        existing = client.select(TABLE, {
            "channel_id": f"eq.{channel_id}",
            "select": "dedup_key,status",
        })
        status_of = {
            r.get("dedup_key"): r.get("status") for r in existing or [] if isinstance(r, dict)
        }
        new = [p.to_row(channel_id) for k, p in by_key.items() if k not in status_of]
        if new:
            summary["proposed"] = client.upsert(TABLE, new, on_conflict=_CONFLICT, ignore_duplicates=True)
        for key, p in by_key.items():
            if status_of.get(key) != STATUS_PENDING:
                continue
            ok = client.update(
                TABLE,
                {"channel_id": f"eq.{channel_id}", "dedup_key": f"eq.{key}", "status": f"eq.{STATUS_PENDING}"},
                {"observation": p.observation, "evidence": p.evidence, "confidence": p.confidence},
            )
            summary["refreshed"] += 1 if ok else 0
    except Exception:
        logger.warning("learning_memory: saving proposals failed for %s", channel_id, exc_info=True)
    return summary


def propose(channel_id: str, *, store=None, sync=None) -> dict:
    """Gather this channel's proposals from the local state and store them as
    pending learnings. Never raises; returns the save summary plus a count."""
    summary = {"candidates": 0, "proposed": 0, "refreshed": 0}
    try:
        sync = _make_sync(sync)
        if not getattr(sync, "enabled", False):
            return summary  # nowhere to put a proposal, so do not compute one
        if store is None:
            from modules.state_store import StateStore

            with StateStore() as own:
                proposals = gather_proposals(own, channel_id, sync=sync)
        else:
            proposals = gather_proposals(store, channel_id, sync=sync)
        summary["candidates"] = len(proposals)
        summary.update(save_proposals(channel_id, proposals, sync=sync))
    except Exception:
        logger.warning("learning_memory: propose failed for %s", channel_id, exc_info=True)
    return summary


# -- the read side: approved learnings into prompts --------------------------


def approved_learnings(channel_id, kinds: Iterable[str] = KINDS, sync=None,
                       limit: int = PROMPT_LIMIT) -> list:
    """This channel's APPROVED learnings of the given kinds, newest decision
    first. Anything else — pending, rejected, another channel — is excluded by
    the query AND re-checked here, because a prompt is the one place a filter
    bug would silently change what the bot makes. [] on any failure."""
    if not channel_id:
        return []
    kinds = tuple(k for k in kinds if k in KINDS)
    if not kinds:
        return []
    try:
        client = _make_sync(sync)
        if not getattr(client, "enabled", False):
            return []
        rows = client.select(TABLE, {
            "channel_id": f"eq.{channel_id}",
            "status": f"eq.{STATUS_APPROVED}",
            "kind": f"in.({','.join(kinds)})",
            "select": "kind,observation,status,channel_id,decided_at",
            "order": "decided_at.desc.nullslast",
            "limit": str(limit),
        })
    except Exception:
        logger.warning("learning_memory: reading approved learnings failed", exc_info=True)
        return []
    out = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        if row.get("status") != STATUS_APPROVED or str(row.get("channel_id")) != str(channel_id):
            continue
        if row.get("kind") not in kinds:
            continue
        text = str(row.get("observation") or "").strip()
        if text:
            out.append(row)
    return out[:limit]


def approved_learnings_as_prompt_text(channel_id, kinds: Iterable[str] = KINDS, sync=None) -> str:
    """The approved learnings as an appendable prompt block, or "" when there
    are none — so appending it to a prompt is always safe and, with nothing
    approved, changes nothing."""
    try:
        rows = approved_learnings(channel_id, kinds, sync=sync)
    except Exception:
        logger.warning("learning_memory: prompt text failed", exc_info=True)
        return ""
    if not rows:
        return ""
    lines = [
        "Approved learnings for this channel (each was proposed from this channel's own "
        "measured results and approved by a human operator; apply them as guidance, "
        "not as rules that override the brief):"
    ]
    for row in rows:
        lines.append(f"- {str(row.get('observation')).strip()}")
    return "\n".join(lines)
