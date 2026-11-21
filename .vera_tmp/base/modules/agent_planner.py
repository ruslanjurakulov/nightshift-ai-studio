"""Agent planner — turn the studio's own trend intelligence into a daily plan.

What this is
------------
The "agent" a channel runs on a cadence: each day it looks at what is actually
trending in the channel's niche (the platform-wide trending feed plus the
competitors it tracks plus audience demand signals), picks the single strongest
opportunity, and produces a concrete plan for one video — the topic, *why it is
trending* (the ranked rationale, not a guess), and the generation prompts for
voice, image and video. That plan then drives the existing pipeline, which
already renders (Director shot plans + the selected video provider), narrates
(ElevenLabs), gates, and uploads to YouTube.

This module is the decision layer, and only that. It composes work that already
exists rather than duplicating it:

* the ranking + the "why" come from :class:`TopicRecommender` /
  ``ContentOpportunityEngine`` (real persisted trend/competitor/demand data);
* execution stays in main.py's pipeline and the provider adapters
  (modules/video_providers.py, the TTS layer) — nothing here renders or uploads.

Guarantees
----------
* **Pure and testable.** ``build_plan`` takes a recommender, so a test injects a
  fake one; it makes no network call and reads no secret.
* **Never invents a topic.** With no intelligence data yet (the common early
  case) ``build_plan`` returns ``None`` and the caller falls back to the normal
  topic manager — the agent proposes, it never fabricates.
* **Advisory to the gate.** The plan chooses *what* to make; the pre-publish
  gate still decides whether it ships, exactly as before. The prompts it emits
  are inspiration for the generators, not a bypass of any check.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Optional, Sequence

logger = logging.getLogger(__name__)

_STOPWORDS = {
    "the", "a", "an", "of", "in", "on", "for", "to", "and", "or", "with",
    "is", "are", "was", "were", "how", "why", "what", "this", "that", "you",
}

_NEGATIVE = "no on-screen text, no captions, no watermark, no logo"


def keywords_from_topic(topic: str, *, limit: int = 6) -> tuple:
    """A small, order-preserving keyword set from a topic phrase — the words a
    b-roll / image prompt should lean on. Purely lexical, so it is deterministic
    and testable; stopwords and very short tokens are dropped."""
    seen: list[str] = []
    for raw in re.split(r"[^A-Za-z0-9']+", topic or ""):
        w = raw.strip().lower()
        if len(w) < 3 or w in _STOPWORDS:
            continue
        if w not in seen:
            seen.append(w)
        if len(seen) >= limit:
            break
    return tuple(seen)


def build_prompts(topic: str, keywords: Sequence[str]) -> dict:
    """Deterministic generation prompts for the three modalities. These seed the
    pipeline's own generators (Gemini script, Director shot plans, the video
    provider, ElevenLabs); they are concrete but never a substitute for the
    per-scene direction the pipeline already builds."""
    topic = (topic or "").strip()
    kw = ", ".join(keywords)
    kw_clause = f" Emphasize: {kw}." if kw else ""
    return {
        "video": f"Cinematic, realistic documentary footage about {topic}.{kw_clause} {_NEGATIVE}.",
        "image": f"High-detail, high-contrast thumbnail image about {topic}.{kw_clause} Bold focal subject, dramatic lighting.",
        "voice": f"Narrate about {topic} in an engaging, documentary tone — a strong hook in the first line, clear and vivid.",
    }


@dataclass(frozen=True)
class AgentPlan:
    """One day's plan for one video. All fields are non-secret."""

    channel_id: Optional[str]
    topic: str
    rationale: str                 # WHY this is trending — the ranked reason
    source: str                    # "trend" | "demand" | "both"
    score: Optional[float]         # None when the ranker gave no numeric score
    keywords: tuple
    prompts: dict
    video_provider: str
    voice_provider: str
    cadence: str = "daily"

    def to_dict(self) -> dict:
        return {
            "channel_id": self.channel_id,
            "topic": self.topic,
            "rationale": self.rationale,
            "source": self.source,
            "score": self.score,
            "keywords": list(self.keywords),
            "prompts": dict(self.prompts),
            "video_provider": self.video_provider,
            "voice_provider": self.voice_provider,
            "cadence": self.cadence,
        }


def _num(value) -> Optional[float]:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f else None   # drop NaN


def build_plan(
    recommender,
    *,
    channel_id: Optional[str] = None,
    cadence: str = "daily",
    video_provider: str = "",
    voice_provider: str = "",
    since: Optional[str] = None,
) -> Optional[AgentPlan]:
    """Pick the top opportunity from ``recommender`` and turn it into a plan, or
    ``None`` when there is nothing to act on. Never raises — any failure logs and
    degrades to ``None`` so the caller falls back to normal topic selection."""
    try:
        opportunities = recommender.suggest_topics(limit=1, since=since)
    except Exception:
        logger.warning("agent_planner: suggest_topics failed; no plan", exc_info=True)
        return None
    if not opportunities:
        return None

    top = opportunities[0]
    topic = (getattr(top, "topic", "") or "").strip()
    if not topic:
        return None
    keywords = keywords_from_topic(topic)
    return AgentPlan(
        channel_id=channel_id,
        topic=topic,
        rationale=(getattr(top, "rationale", "") or "").strip(),
        source=(getattr(top, "source", "") or "").strip(),
        score=_num(getattr(top, "score", None)),
        keywords=keywords,
        prompts=build_prompts(topic, keywords),
        video_provider=video_provider or "",
        voice_provider=voice_provider or "",
        cadence=cadence,
    )


def summarize(plan: AgentPlan) -> dict:
    """Metadata for one ``agent.plan`` advisory event. Rationale is trimmed for
    the feed; the full plan lives in the run. No secret is ever included."""
    d = plan.to_dict()
    rationale = d.get("rationale") or ""
    return {
        "topic": d["topic"],
        "rationale": rationale[:280],
        "source": d["source"],
        "score": d["score"],
        "keywords": d["keywords"],
        "video_provider": d["video_provider"],
        "voice_provider": d["voice_provider"],
        "cadence": d["cadence"],
    }
