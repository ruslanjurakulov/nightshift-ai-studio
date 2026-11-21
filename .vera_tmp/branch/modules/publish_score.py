"""Publish Score — pre-publish intelligence, advisory only.

Composes a set of NRC-style dimension scores (hook, SEO, CTA, thumbnail,
retention, CTR, competition) into an overall 0–100 "publish score" and a
verdict, so a human can see *why* a video looks strong or weak before it goes
out. Inspired by the pre-publish intelligence pattern; the implementation is
original.

What this is NOT
----------------
* It is NOT the publish gate. `modules/publish_gate.py` decides whether a video
  may upload (originality, fact-check, sanity) and this module never overrides,
  weakens, or feeds into that decision. Publishing still passes the gate.
* It does NOT invent numbers. Two kinds of dimension exist:
    - **heuristic** dimensions score the *real* content in hand (the actual
      hook, title, description, tags, CTA, thumbnail text). These are honest
      quality heuristics, always labelled `heuristic`.
    - **prediction** dimensions (retention, CTR, competition) need historical
      or external signal. When that signal is absent the dimension's score is
      **None** — rendered as "not enough data", never 0 and never a guess.
  The overall score is the weighted mean of only the dimensions that actually
  have a score, and it reports how many of the total informed it, so a score
  built on two of seven dimensions cannot masquerade as a full one.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

# Confidence of a dimension's number.
MEASURED = "measured"      # derived from this channel's real past metrics
HEURISTIC = "heuristic"    # a rule over the real content in hand
NONE = "none"              # no signal available → score is None

# Verdicts.
READY = "ready"
IMPROVE = "improve"
DO_NOT_PUBLISH = "do_not_publish"
INSUFFICIENT = "insufficient_data"


@dataclass(frozen=True)
class Dimension:
    key: str
    score: Optional[float]  # 0..100, or None when there is no signal
    weight: float
    confidence: str
    basis: str              # short human explanation; never contains secrets
    recommendation: str = ""  # what would raise it, when the score is weak


@dataclass(frozen=True)
class PublishScore:
    dimensions: list
    overall: Optional[float]
    verdict: str
    dims_scored: int
    dims_total: int
    notes: list = field(default_factory=list)

    def to_metadata(self) -> dict:
        """Event/telemetry metadata. Only our own strings and numbers."""
        return {
            "overall": self.overall,
            "verdict": self.verdict,
            "dims_scored": self.dims_scored,
            "dims_total": self.dims_total,
            "dimensions": {
                d.key: {"score": d.score, "confidence": d.confidence} for d in self.dimensions
            },
        }


@dataclass
class ScoreInputs:
    """Everything the scorer reads. Kept as plain optional fields so it is fed
    from a Script (hook/title/…) plus whatever historical signal is available,
    and is trivially testable without the pipeline. Absent prediction signals
    stay None — that is the whole point."""

    hook: str = ""
    title: str = ""
    description: str = ""
    tags: tuple[str, ...] = ()
    cta: str = ""
    thumbnail_text: str = ""
    # Prediction signals — None means "we have no basis", not zero.
    past_retention_pct: Optional[float] = None   # this channel's avg retention %
    past_ctr_pct: Optional[float] = None          # this channel's avg CTR %
    competitor_saturation: Optional[float] = None # 0..1, how crowded the topic is


def _clamp(value: float) -> float:
    return max(0.0, min(100.0, value))


# --- heuristic dimensions (score the real content) --------------------------

_CURIOSITY = re.compile(r"\b(why|how|what|secret|never|nobody|actually|truth|mistake|stop|before)\b", re.I)


def _hook_score(text: str) -> Dimension:
    t = (text or "").strip()
    if not t:
        return Dimension("hook", None, 0.20, NONE, "no hook text", "Write an opening line.")
    words = len(t.split())
    score = 40.0
    if _CURIOSITY.search(t):
        score += 25  # a curiosity/open-loop marker
    if re.search(r"\d", t):
        score += 15  # a concrete number
    if "?" in t:
        score += 10
    if 4 <= words <= 20:
        score += 10  # tight enough to land in the first seconds
    rec = "" if score >= 70 else "Open with a number, a question, or a curiosity gap in ≤20 words."
    return Dimension("hook", _clamp(score), 0.20, HEURISTIC, f"{words} words", rec)


def _seo_score(title: str, description: str, tags: tuple[str, ...]) -> Dimension:
    title = (title or "").strip()
    if not title:
        return Dimension("seo", None, 0.15, NONE, "no title", "Add a title.")
    score = 30.0
    n = len(title)
    if 30 <= n <= 70:
        score += 25  # fits YouTube's display without truncation
    elif n < 30:
        score += 8
    if re.search(r"\d", title):
        score += 8
    if len((description or "").strip()) >= 120:
        score += 20  # a real description, not a stub
    tag_n = len([x for x in tags if x and x.strip()])
    if tag_n >= 5:
        score += 17
    elif tag_n >= 1:
        score += 8
    rec = "" if score >= 70 else "Aim for a 30–70 char title, a 120+ char description, and 5+ tags."
    return Dimension("seo", _clamp(score), 0.15, HEURISTIC, f"title {n} chars, {tag_n} tags", rec)


def _cta_score(cta: str) -> Dimension:
    t = (cta or "").strip()
    if not t:
        return Dimension("cta", None, 0.10, NONE, "no CTA", "Add a call to action.")
    score = 45.0
    if re.search(r"\b(subscribe|comment|like|share|watch|follow|next)\b", t, re.I):
        score += 35
    if 3 <= len(t.split()) <= 25:
        score += 20
    rec = "" if score >= 70 else "Make the CTA one clear ask (subscribe / watch next / comment)."
    return Dimension("cta", _clamp(score), 0.10, HEURISTIC, f"{len(t.split())} words", rec)


def _thumbnail_score(text: str) -> Dimension:
    t = (text or "").strip()
    if not t:
        return Dimension(
            "thumbnail", None, 0.15, NONE, "no thumbnail overlay text",
            "Add a short, punchy overlay (≤5 words).",
        )
    words = len(t.split())
    score = 50.0
    if 1 <= words <= 4:
        score += 35  # readable at a glance on mobile
    elif words <= 6:
        score += 15
    if t.upper() == t:
        score += 10  # all-caps reads at small sizes
    rec = "" if score >= 70 else "Keep the overlay to ≤4 punchy words."
    return Dimension("thumbnail", _clamp(score), 0.15, HEURISTIC, f"{words} words", rec)


# --- prediction dimensions (need real historical/external signal) -----------

def _retention_dim(pct: Optional[float]) -> Dimension:
    if pct is None:
        return Dimension(
            "retention", None, 0.20, NONE, "no past retention data",
            "Publish a few videos so retention can be measured.",
        )
    # This channel's own measured average retention, mapped to 0..100. Anchored
    # so ~50% average retention (strong on YouTube) reads near 90.
    score = _clamp(pct * 1.8)
    return Dimension("retention", score, 0.20, MEASURED, f"avg retention {pct:.0f}%")


def _ctr_dim(pct: Optional[float]) -> Dimension:
    if pct is None:
        return Dimension(
            "ctr", None, 0.15, NONE, "no past CTR data",
            "CTR prediction needs this channel's measured click-through history.",
        )
    # ~10% CTR is very strong → ~100; linear below that.
    score = _clamp(pct * 10.0)
    return Dimension("ctr", score, 0.15, MEASURED, f"avg CTR {pct:.1f}%")


def _competition_dim(saturation: Optional[float]) -> Dimension:
    if saturation is None:
        return Dimension(
            "competition", None, 0.05, NONE, "no competitor signal",
            "Competition score needs competitor-monitor data for this niche.",
        )
    # Higher saturation → lower opportunity score.
    score = _clamp((1.0 - max(0.0, min(1.0, saturation))) * 100.0)
    return Dimension("competition", score, 0.05, MEASURED, f"saturation {saturation:.2f}")


def inputs_from_script(
    script,
    *,
    past_retention_pct: Optional[float] = None,
    past_ctr_pct: Optional[float] = None,
    competitor_saturation: Optional[float] = None,
) -> ScoreInputs:
    """Build ScoreInputs from a Script (duck-typed) plus whatever historical /
    external signal the caller has. The content fields are read off the real
    script — `hook_sentence`, `title`, `description`, `tags`,
    `thumbnail_overlay_text`, and `cta` if the script carries one. Prediction
    signals default to None (→ "not enough data"), so a caller that has no
    history yet still gets an honest content-only score."""

    def field(name: str, default=""):
        return getattr(script, name, default) or default

    tags = field("tags", [])
    if not isinstance(tags, (list, tuple)):
        tags = []
    return ScoreInputs(
        hook=field("hook_sentence") or field("hook"),
        title=field("title"),
        description=field("description"),
        tags=tuple(str(t) for t in tags if str(t).strip()),
        cta=field("cta"),
        thumbnail_text=field("thumbnail_overlay_text"),
        past_retention_pct=past_retention_pct,
        past_ctr_pct=past_ctr_pct,
        competitor_saturation=competitor_saturation,
    )


def evaluate(inputs: ScoreInputs) -> PublishScore:
    """Compute the publish score from whatever real signal is present.

    Deterministic and side-effect free. Missing prediction signals produce
    None-scored dimensions that are excluded from the overall; the overall is
    the weight-normalised mean of the dimensions that do have a score.
    """
    dims = [
        _hook_score(inputs.hook),
        _seo_score(inputs.title, inputs.description, inputs.tags),
        _cta_score(inputs.cta),
        _thumbnail_score(inputs.thumbnail_text),
        _retention_dim(inputs.past_retention_pct),
        _ctr_dim(inputs.past_ctr_pct),
        _competition_dim(inputs.competitor_saturation),
    ]

    scored = [d for d in dims if d.score is not None]
    notes = [d.recommendation for d in dims if d.recommendation]

    if not scored:
        return PublishScore(dims, None, INSUFFICIENT, 0, len(dims), notes)

    total_weight = sum(d.weight for d in scored)
    overall = round(sum(d.score * d.weight for d in scored) / total_weight, 1) if total_weight else None

    if overall is None:
        verdict = INSUFFICIENT
    else:
        weakest = min(d.score for d in scored)
        if overall >= 70 and weakest >= 40:
            verdict = READY
        elif overall >= 45:
            verdict = IMPROVE
        else:
            verdict = DO_NOT_PUBLISH

    return PublishScore(dims, overall, verdict, len(scored), len(dims), notes)
