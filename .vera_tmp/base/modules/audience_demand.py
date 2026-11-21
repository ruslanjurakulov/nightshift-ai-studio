"""Audience demand engine.

Looks at classified audience comments and surfaces what viewers are actually
asking for: recurring topic requests, grouped by underlying subject and
ranked by how many distinct commenters made the same request.

Input contract
--------------
This module intentionally does NOT import any comment-classification
dataclass from another module. Sibling work on this pipeline (a
"comment_intelligence" style module, built on a separate branch) may define
a ``CommentClassification`` dataclass — but that branch does not exist in
this worktree, and importing it here would break this module's build in
isolation and make the two PRs harder to merge in parallel.

Instead, ``AudienceDemandEngine.analyze`` accepts a plain ``list[dict]``.
Each record is expected to look like::

    {
        "comment_id": 123,
        "sentiment": "neutral",
        "category": "topic_request",
        "text": "please cover Genghis Khan next",
    }

This shape is duck-type compatible with a ``CommentClassification``
dataclass instance via ``dataclasses.asdict(record)`` (or any other object
that can be coerced into a dict with at least these keys) — so wiring this
engine up to a real classification pipeline later is just a case of calling
``asdict()`` (or similar) on each record before passing the list in. No
direct import or hard dependency between the two modules is required.

Clustering approach
--------------------
Topic-request comments are grouped with a simple greedy clustering pass
using only the Python standard library's ``difflib.SequenceMatcher`` for
near-duplicate text similarity (no new third-party dependency, e.g.
rapidfuzz, is introduced here). For each not-yet-grouped record, a new
group is started using that record's text as the group's initial
representative, and every remaining ungrouped record whose similarity to
that representative exceeds ``similarity_threshold`` is pulled into the
group. This is O(n^2) in the number of topic-request comments, which is
fine at the scale of a single comment batch.

The ``similarity_threshold`` default of 0.6 is a reasonable starting point
chosen by inspection, not validated against real audience data -- same
caveat as other threshold-based heuristics elsewhere in this project.
Callers with real data should tune it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from difflib import SequenceMatcher


TOPIC_REQUEST_CATEGORY = "topic_request"

# How many example comment IDs to keep per DemandSignal.
_MAX_EXAMPLE_IDS = 5


@dataclass
class DemandSignal:
    """One recurring topic request, aggregated across similar comments."""

    topic_phrase: str
    mention_count: int
    example_comment_ids: list = field(default_factory=list)


def _normalize(text: str) -> str:
    """Lowercase and collapse whitespace for more forgiving comparison."""
    return " ".join((text or "").lower().split())


def _similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


class AudienceDemandEngine:
    """Groups topic-request comments into ranked demand signals.

    Args:
        similarity_threshold: The difflib.SequenceMatcher ratio (0.0-1.0)
            above which two topic-request texts are treated as the same
            underlying request. Default 0.6 is an unvalidated starting
            point -- see module docstring.
    """

    def __init__(self, similarity_threshold: float = 0.6):
        self.similarity_threshold = similarity_threshold

    def analyze(self, records: list) -> list:
        """Analyze a batch of comment-classification dicts.

        Args:
            records: list of dicts, each with at least ``comment_id``,
                ``sentiment``, ``category``, and ``text`` keys. Records
                whose ``category`` is not ``"topic_request"`` are ignored.

        Returns:
            A list of DemandSignal, sorted descending by mention_count.
            Empty input, or input with no topic_request records, yields [].
        """
        topic_requests = [
            r for r in (records or []) if r.get("category") == TOPIC_REQUEST_CATEGORY
        ]
        if not topic_requests:
            return []

        groups = self._cluster(topic_requests)

        signals = []
        for group in groups:
            signals.append(self._build_signal(group))

        signals.sort(key=lambda s: s.mention_count, reverse=True)
        return signals

    def _cluster(self, topic_requests: list) -> list:
        """Greedy near-duplicate clustering.

        Each group is a list of the original record dicts that were judged
        similar enough to belong together.
        """
        ungrouped = list(topic_requests)
        groups = []

        while ungrouped:
            seed = ungrouped.pop(0)
            seed_norm = _normalize(seed.get("text", ""))
            group = [seed]

            remaining = []
            for candidate in ungrouped:
                candidate_norm = _normalize(candidate.get("text", ""))
                if _similarity(seed_norm, candidate_norm) >= self.similarity_threshold:
                    group.append(candidate)
                else:
                    remaining.append(candidate)
            ungrouped = remaining

            groups.append(group)

        return groups

    def _build_signal(self, group: list) -> DemandSignal:
        # Representative phrase: the longest text in the group tends to be
        # the most descriptive/specific phrasing of the request.
        representative = max(group, key=lambda r: len(r.get("text", "") or ""))
        topic_phrase = representative.get("text", "")

        example_ids = []
        for r in group:
            cid = r.get("comment_id")
            if cid is not None and cid not in example_ids:
                example_ids.append(cid)
            if len(example_ids) >= _MAX_EXAMPLE_IDS:
                break

        return DemandSignal(
            topic_phrase=topic_phrase,
            mention_count=len(group),
            example_comment_ids=example_ids,
        )
