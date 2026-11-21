"""Title-and-thumbnail planning — decide the promise BEFORE writing the script.

A YouTube video lives or dies on its title and thumbnail: they are what earns
the click, and everything after is retention. The pipeline used to write the
script first and derive a title from it — the tail wagging the dog. This plans
the title and a thumbnail concept up front, from the topic, so the script is
then written to *deliver on that exact promise* rather than to summarize itself.

Degrade-safe by design
-----------------------
``plan_titles`` takes an optional ``gen`` callable (``(prompt, system) -> str``)
so it can use the same Gemini client the script engine uses — but it never
depends on it. With no ``gen``, or if the model fails or returns unusable text,
it falls back to a small set of formula titles built from the topic. It never
raises into the pipeline: a title plan that can't reach the model still returns
a usable plan, and the run continues. This mirrors the rest of the codebase —
research, series, avatar all degrade rather than stop the line.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Callable, Optional

from modules.packaging_repair import PACKAGING_CLAIM_RULE

logger = logging.getLogger(__name__)

_PLAN_SYSTEM = (
    "You are a YouTube packaging strategist. Given a topic, you write click-earning "
    "titles and one thumbnail concept. Titles are specific, curiosity-driven, and "
    "honest to the topic — never clickbait that the video can't pay off. Reply with "
    "JSON only.\n\n" + PACKAGING_CLAIM_RULE
)


@dataclass(frozen=True)
class TitlePlan:
    """The packaging decided before the script is written."""

    topic: str
    candidates: tuple[str, ...] = field(default_factory=tuple)
    chosen: str = ""
    alt: str = ""                    # the A/B alternative, when there is one
    thumbnail_concept: str = ""
    source: str = "heuristic"        # "gemini" | "heuristic"

    def to_dict(self) -> dict:
        return {
            "topic": self.topic,
            "candidates": list(self.candidates),
            "chosen": self.chosen,
            "alt": self.alt,
            "thumbnail_concept": self.thumbnail_concept,
            "source": self.source,
        }


def _clean_title(text: str) -> str:
    t = re.sub(r"\s+", " ", str(text or "")).strip().strip('"').strip()
    return t[:100]


def _heuristic_candidates(topic: str, niche: str = "") -> list[str]:
    """Formula titles from the topic alone — no API. Deliberately plain and
    honest; the point is a usable fallback, not a viral guarantee."""
    t = _clean_title(topic) or "This Story"
    formulas = [
        f"The Untold Story of {t}",
        f"What Really Happened to {t}",
        f"{t}: The Mystery Nobody Explains",
        f"The Truth About {t}",
        f"Why {t} Still Matters",
    ]
    # De-dup while preserving order, drop any that collapsed to just the topic.
    seen: list[str] = []
    for f in formulas:
        f = _clean_title(f)
        if f and f.lower() != t.lower() and f not in seen:
            seen.append(f)
    return seen


def _parse_plan(text: str, topic: str) -> Optional[dict]:
    """Pull {titles: [...], thumbnail_concept: "..."} out of a model reply.
    Returns None when nothing usable is found — the caller then falls back."""
    if not text:
        return None
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE)
    try:
        data = json.loads(cleaned)
    except Exception:
        # Last resort: a bare list of lines, each a title.
        lines = [_clean_title(ln) for ln in text.splitlines() if _clean_title(ln)]
        return {"titles": lines[:5]} if lines else None
    if not isinstance(data, dict):
        return {"titles": [_clean_title(x) for x in data]} if isinstance(data, list) else None
    titles = data.get("titles") or data.get("candidates") or []
    if isinstance(titles, str):
        titles = [titles]
    titles = [_clean_title(x) for x in titles if _clean_title(x)]
    if not titles:
        return None
    return {"titles": titles, "thumbnail_concept": _clean_title(data.get("thumbnail_concept") or "")}


def plan_titles(
    topic: str,
    niche: str = "",
    *,
    gen: Optional[Callable[[str, Optional[str]], str]] = None,
    n: int = 5,
    seed_titles: tuple = (),
) -> TitlePlan:
    """Decide the title/thumbnail packaging for a topic before the script.

    `gen(prompt, system) -> text` is an optional model callable (the script
    engine's `_gen` fits). Without it — or on any failure — a heuristic plan is
    returned. Never raises. `chosen` is the A title, `alt` the A/B alternative.

    `seed_titles` are proven-formula titles (from modules/title_formulas, ranked
    by the channel's own CTR) to lead the candidate list with, so the chosen A
    title leans on a shape that has worked here. Advisory: they seed and bias,
    never replace the model's own titles — the deduped model/heuristic candidates
    still follow, and a channel with no measured history simply passes none."""
    topic = _clean_title(topic) or "Untitled"
    candidates: list[str] = []
    thumbnail_concept = ""
    source = "heuristic"

    if gen is not None:
        prompt = (
            f"Topic: {topic}\n"
            + (f"Niche: {niche}\n" if niche else "")
            + f"\nWrite {max(2, n)} distinct click-earning YouTube titles for this exact topic, "
            "and one thumbnail concept (a short visual description). "
            'Reply as JSON: {"titles": ["...", "..."], "thumbnail_concept": "..."}'
        )
        try:
            parsed = _parse_plan(gen(prompt, _PLAN_SYSTEM), topic)
            if parsed and parsed.get("titles"):
                candidates = parsed["titles"]
                thumbnail_concept = parsed.get("thumbnail_concept", "")
                source = "gemini"
        except Exception as e:
            logger.warning(
                "Title planning via model failed (%s: %s) — using heuristic titles",
                type(e).__name__, e,
            )

    if not candidates:
        candidates = _heuristic_candidates(topic, niche)

    # Lead with the channel's proven-formula seeds, then the model/heuristic
    # candidates, deduped. Seeds only reorder and enrich — nothing the model
    # produced is dropped, so this can't degrade a good title, only surface a
    # shape that has earned clicks here. With no seeds this is a no-op.
    if seed_titles:
        seeds = [_clean_title(s) for s in seed_titles if _clean_title(s)]
        merged: list[str] = []
        for t in seeds + candidates:
            if t and t not in merged:
                merged.append(t)
        candidates = merged

    candidates = candidates[: max(1, n)]
    chosen = candidates[0] if candidates else topic
    alt = candidates[1] if len(candidates) > 1 else ""
    return TitlePlan(
        topic=topic,
        candidates=tuple(candidates),
        chosen=chosen,
        alt=alt,
        thumbnail_concept=thumbnail_concept,
        source=source,
    )
