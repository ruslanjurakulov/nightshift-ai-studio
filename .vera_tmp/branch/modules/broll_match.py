"""B-roll matching — pick the clip that matches what is being said.

The pipeline fetches a pool of stock clips by keyword and lays them under the
narration. When the placement ignores which clip is relevant to which section,
a video about "the eruption" can show a calm beach while the narrator describes
lava — the single most common "AI slop" tell. This scores each candidate clip
against a section's own keywords so the most relevant clip goes under the words
it illustrates.

Pure and dependency-free by design: it works on the descriptive terms a clip was
fetched with (its search keyword and any tags), not on the video bytes, so it
has no moviepy/network dependency and is fully unit-testable. The compositor
consumes the assignment; this module only decides it.

Two honest rules:

- **A weak match never beats coverage.** Every section still gets a clip — when
  nothing scores above zero the assignment falls back to spreading the pool
  evenly, so a poor keyword match never leaves a section black. Relevance
  improves placement; it never removes footage.
- **Deterministic.** The same pool and sections always produce the same
  assignment, so a re-run is reproducible.
"""

from __future__ import annotations

import re
from typing import Optional

# Very common words carry no matching signal; dropping them keeps the overlap
# score about the subject, not the grammar.
_STOPWORDS = frozenset(
    "the a an of to and or in on at for with from by is are was were be been "
    "this that these those it its as into over under about your you we they".split()
)

_WORD = re.compile(r"[a-z0-9]+")


def terms(text) -> set:
    """The meaningful lowercased word tokens in a string or list of strings."""
    if isinstance(text, (list, tuple, set)):
        text = " ".join(str(t) for t in text)
    tokens = _WORD.findall(str(text or "").lower())
    return {t for t in tokens if t not in _STOPWORDS and len(t) > 1}


def clip_terms(clip: dict) -> set:
    """The descriptive terms of a candidate clip — its search keyword plus any
    tags. A clip is a dict like {"keyword": "volcano eruption", "tags": [...]}."""
    if not isinstance(clip, dict):
        return set()
    return terms(clip.get("keyword", "")) | terms(clip.get("tags", []))


def relevance(clip: dict, section_keywords) -> float:
    """How well a clip matches a section, as an overlap coefficient in [0, 1]:
    shared terms over the smaller term set. Overlap (not Jaccard) so a clip with
    many tags isn't penalised for covering more than the section asked."""
    ct = clip_terms(clip)
    st = terms(section_keywords)
    if not ct or not st:
        return 0.0
    shared = len(ct & st)
    return shared / float(min(len(ct), len(st)))


def rank_clips(clips: list, section_keywords) -> list:
    """Candidate clips ordered by relevance to a section, best first. Stable:
    equal scores keep their original order."""
    scored = list(enumerate(clips or []))
    scored.sort(key=lambda pair: (-relevance(pair[1], section_keywords), pair[0]))
    return [clips[i] for i, _ in scored]


def assign_clips_to_sections(section_keywords_list: list, clips: list) -> list:
    """Assign one clip to each section, best relevance first, without reusing a
    clip while unused ones remain.

    Returns a list parallel to `section_keywords_list`: the chosen clip per
    section (or None only when there are fewer clips than sections and the pool
    is exhausted). Sections are filled in order of their best available match, so
    the strongest pairing is made first; a section with no positive match takes
    the next unused clip (coverage over a black frame). Deterministic."""
    sections = list(section_keywords_list or [])
    pool = list(clips or [])
    result = [None] * len(sections)
    if not sections or not pool:
        return result

    used = [False] * len(pool)
    remaining = set(range(len(sections)))

    # Greedy: repeatedly take the (section, clip) pair with the highest relevance
    # among still-unassigned sections and unused clips.
    while remaining and any(not u for u in used):
        best = None  # (score, section_idx, clip_idx)
        for s in remaining:
            for ci, clip in enumerate(pool):
                if used[ci]:
                    continue
                score = relevance(clip, sections[s])
                if best is None or score > best[0] or (score == best[0] and (s, ci) < (best[1], best[2])):
                    best = (score, s, ci)
        if best is None:
            break
        _, s, ci = best
        result[s] = pool[ci]
        used[ci] = True
        remaining.discard(s)

    # Any sections still unfilled (more sections than clips) stay None.
    return result
