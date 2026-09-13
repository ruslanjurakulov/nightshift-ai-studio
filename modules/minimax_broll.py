"""AI-generated b-roll with MiniMax H3 — the decision layer.

Why this exists
---------------
B-roll has always come from Pexels stock: real footage, but generic, and often
only loosely on-topic. MiniMax H3 is an omni-modal video model that generates a
short clip (4-15s, 768P/2K) from a text prompt, so a section about "the fall of
Constantinople" can get footage *of that*, not the nearest stock match. This
module is the part that decides **what to generate and how** — it is pure and
fully testable; the network call that actually renders a clip lives in
``modules/minimax_client.py`` and is off unless a key is configured.

The rules match the rest of the pipeline:

- **Additive and off by default.** Generated b-roll supplements Pexels; with the
  feature disabled nothing here runs and stock is used exactly as before.
- **Cost-aware, never greedy.** A generated clip is billable, so only a bounded
  number of a video's sections get one (``max_clips``) — the highest-value
  sections first (the hook, then the longest sections), the rest stay on stock.
- **Honest duration.** H3 renders 4-15s; a section's ask is clamped into that
  window rather than sending a request the model will reject.
- **The prompt is the section's own subject**, built from its keywords and the
  video topic, and it explicitly asks for clean footage with no captions or
  watermarks (the pipeline burns its own subtitles later).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

#: MiniMax H3's supported clip-length window, in seconds.
MIN_CLIP_SECONDS = 4
MAX_CLIP_SECONDS = 15

_NEGATIVE = "no on-screen text, no captions, no subtitles, no watermark, no logo"


def clamp_duration(seconds) -> int:
    """Clamp a requested clip length into H3's 4-15s window. Non-numeric or
    non-positive requests fall back to the minimum rather than raising."""
    try:
        s = int(round(float(seconds)))
    except (TypeError, ValueError):
        return MIN_CLIP_SECONDS
    return max(MIN_CLIP_SECONDS, min(MAX_CLIP_SECONDS, s))


@dataclass(frozen=True)
class GenerationSpec:
    """One clip to generate: a fully-built prompt, its length, and the section
    it belongs to (so the compositor can place it and record its keyword)."""

    prompt: str
    duration_seconds: int
    section_index: int
    keyword: str = ""
    negative_prompt: str = _NEGATIVE

    def to_dict(self) -> dict:
        return {
            "prompt": self.prompt,
            "duration_seconds": self.duration_seconds,
            "section_index": self.section_index,
            "keyword": self.keyword,
            "negative_prompt": self.negative_prompt,
        }


def build_prompt(topic: str, keywords: List[str], *, style: str = "cinematic, documentary, realistic") -> str:
    """A text-to-video prompt for one section: its concrete subject first, the
    video's topic for context, then a consistent visual style. Empty/blank
    keywords fall back to the topic so a prompt is always non-empty."""
    terms = [k.strip() for k in (keywords or []) if k and k.strip()]
    subject = ", ".join(dict.fromkeys(terms)) if terms else (topic or "").strip()
    topic_clause = f" — {topic.strip()}" if topic and topic.strip() and subject != topic.strip() else ""
    subject = subject or "an evocative establishing shot"
    return f"{subject}{topic_clause}. {style}. {_NEGATIVE}."


def _field(section, key):
    """Read `key` from a section that may be a dict or an object (e.g. the
    script's Section dataclass), so this module works with either."""
    if isinstance(section, dict):
        return section.get(key)
    return getattr(section, key, None)


def _section_len(section) -> float:
    for key in ("duration", "duration_seconds", "length", "seconds"):
        v = _field(section, key)
        try:
            if v is not None and float(v) > 0:
                return float(v)
        except (TypeError, ValueError):
            continue
    return float(MIN_CLIP_SECONDS)


def _section_keywords(section) -> List[str]:
    kws = _field(section, "keywords")
    if isinstance(kws, (list, tuple)):
        return [str(k) for k in kws]
    if isinstance(kws, str) and kws.strip():
        return [kws.strip()]
    return []


def select_specs(sections: list, topic: str, *, max_clips: int) -> List[GenerationSpec]:
    """Choose which sections get a generated clip and build a spec for each.

    Only sections that carry at least one keyword are eligible (a section we
    can't describe, we don't try to generate). Among those, the hook (index 0,
    if eligible) is always kept, then the longest sections, up to ``max_clips``.
    Returns [] when the feature would generate nothing (no eligible sections, or
    a non-positive budget) — the caller then falls back to stock entirely."""
    if max_clips <= 0:
        return []

    eligible = []
    for i, section in enumerate(sections or []):
        if section is None:
            continue
        kws = _section_keywords(section)
        if not kws:
            continue
        eligible.append((i, section, kws))
    if not eligible:
        return []

    # Rank: the hook first (a strong opening clip earns its cost), then by
    # length descending (a longer section benefits more from bespoke footage).
    def rank_key(item):
        i, section, _ = item
        return (0 if i == 0 else 1, -_section_len(section), i)

    chosen = sorted(eligible, key=rank_key)[:max_clips]
    # Emit in section order so the timeline stays natural.
    chosen.sort(key=lambda item: item[0])

    specs: List[GenerationSpec] = []
    for i, section, kws in chosen:
        specs.append(GenerationSpec(
            prompt=build_prompt(topic, kws),
            duration_seconds=clamp_duration(_section_len(section)),
            section_index=i,
            keyword=kws[0],
        ))
    return specs


@dataclass(frozen=True)
class GenerationResult:
    """What actually got generated, for the advisory event. `paths` are the
    clips produced (by section index); `attempted`/`generated` are honest counts
    so a run that asked for 2 and got 1 reads as such, never as success."""

    attempted: int = 0
    generated: int = 0
    model: str = ""
    by_section: dict = field(default_factory=dict)   # section_index -> path

    def to_dict(self) -> dict:
        return {
            "attempted": self.attempted,
            "generated": self.generated,
            "model": self.model,
            "sections": sorted(self.by_section.keys()),
        }


def summarize(result: GenerationResult) -> dict:
    """Metadata for a single ``broll.generated`` event."""
    return result.to_dict()
