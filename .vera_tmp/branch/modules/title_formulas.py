"""Title formula library — the patterns that earn clicks, ranked by what has
actually worked on THIS channel.

Every strong YouTube title is built on a small number of reusable shapes: a
curiosity gap ("The Untold Story of …"), a question ("Why Did … Really
Happen?"), a number ("7 Secrets of …"), a stakes/negativity frame ("The Dark
Truth About …"), an authority explainer ("… , Explained"). The title planner
already writes candidates; this module tells it which *shape* the channel's own
best-performing titles used, so new candidates lean on proven patterns instead
of guessing.

Two rules, matching the rest of the intelligence layer:

- **Ranked by measured CTR, relative to the channel — null ≠ 0.** A formula is
  ranked only from videos whose CTR is actually known over enough impressions;
  a title with unknown CTR contributes nothing (it is never treated as a zero),
  and a formula needs a minimum number of samples before it is trusted.
- **Advisory, never a mandate.** This seeds and biases; it never overrides the
  model's own titles or forces a shape onto a topic it doesn't fit. The planner
  still chooses.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from statistics import mean
from typing import Optional

# Formula kind -> ordered templates. `{topic}` is filled from the video's topic.
# The first template of a kind is the one `apply_formula` uses to seed a title.
FORMULAS: dict = {
    "curiosity": [
        "The Untold Story of {topic}",
        "What Really Happened to {topic}",
    ],
    "question": [
        "Why Did {topic} Really Happen?",
        "What If {topic} Never Existed?",
    ],
    "number": [
        "7 Things You Didn't Know About {topic}",
        "5 Secrets of {topic}",
    ],
    "negativity": [
        "The Dark Truth About {topic}",
        "Why {topic} Went Wrong",
    ],
    "authority": [
        "{topic}, Explained",
        "The Truth About {topic}",
    ],
    "superlative": [
        "The Most Incredible {topic} Story",
    ],
}

ALL_KINDS = tuple(FORMULAS.keys())

# Substring/pattern signals that classify an existing title into a formula kind.
# Checked in this order; the first match wins, so more specific shapes come
# first and the broad "authority" catch-all comes last.
_SIGNALS = (
    ("number", re.compile(r"\b\d+\b")),
    ("question", re.compile(r"\?|^\s*(why|what|how|who|when|where|is|are|did|do|can|will)\b", re.I)),
    ("negativity", re.compile(r"\b(dark|truth|wrong|worst|mistake|failed|failure|lie|scandal|shocking|disturbing)\b", re.I)),
    ("curiosity", re.compile(r"\b(untold|secret|mystery|hidden|nobody|no one|what really|never)\b", re.I)),
    ("superlative", re.compile(r"\b(most|best|greatest|biggest|craziest|insane|unbelievable)\b", re.I)),
    ("authority", re.compile(r"\bexplained\b|\bthe truth\b|:\s", re.I)),
)


@dataclass(frozen=True)
class FormulaStat:
    kind: str
    mean_ctr: float
    samples: int

    def to_dict(self) -> dict:
        return {"kind": self.kind, "mean_ctr": self.mean_ctr, "samples": self.samples}


def classify_title(title: str) -> str:
    """The formula kind a title uses, or "other" when none is recognised."""
    t = (title or "").strip()
    if not t:
        return "other"
    for kind, pattern in _SIGNALS:
        if pattern.search(t):
            return kind
    return "other"


def _num(value) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def rank_formulas_by_ctr(
    videos: list,
    metrics_by_id: dict,
    *,
    min_impressions: int = 500,
    min_samples: int = 2,
) -> list:
    """Rank the channel's title formulas by mean measured CTR, best first.

    Only long-form videos with a known CTR over `min_impressions` impressions
    count, and only formulas seen at least `min_samples` times are ranked — a
    single lucky video does not crown a formula. Returns [] when there isn't
    enough measured history to say anything, which the planner treats as "no
    preference" rather than a guess."""
    buckets: dict = {}
    for v in videos or []:
        if (v.get("video_format") or "long") == "short":
            continue
        m = metrics_by_id.get(v.get("video_id")) if metrics_by_id else None
        ctr = _num(m.get("impression_ctr")) if m else None
        impressions = _num(m.get("impressions")) if m else None
        if ctr is None or impressions is None or impressions < min_impressions:
            continue  # null ≠ 0: unmeasured titles never vote
        kind = classify_title(v.get("title", ""))
        if kind == "other":
            continue
        buckets.setdefault(kind, []).append(ctr)

    stats = [
        FormulaStat(kind=kind, mean_ctr=mean(ctrs), samples=len(ctrs))
        for kind, ctrs in buckets.items()
        if len(ctrs) >= min_samples
    ]
    stats.sort(key=lambda s: s.mean_ctr, reverse=True)
    return stats


def best_formulas(stats: list, k: int = 2) -> tuple:
    """The top `k` formula kinds from a ranking, as a tuple (possibly empty)."""
    return tuple(s.kind for s in stats[: max(0, k)])


def apply_formula(kind: str, topic: str) -> str:
    """Build a title of the given formula kind from the topic, or "" if the kind
    is unknown."""
    templates = FORMULAS.get(kind)
    topic = (topic or "").strip()
    if not templates or not topic:
        return ""
    return templates[0].format(topic=topic)


def seed_titles(topic: str, kinds) -> tuple:
    """Proven-formula titles for a topic, one per requested kind, in order.
    Deduped and cleaned; unknown kinds are skipped. These are handed to the
    planner so a candidate list is guaranteed to include the channel's
    best-working shapes."""
    out: list = []
    for kind in kinds or ():
        title = apply_formula(kind, topic)
        if title and title not in out:
            out.append(title)
    return tuple(out)
