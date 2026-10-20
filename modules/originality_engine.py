"""Originality / anti-repetition engine.

Today the only originality mechanism in this pipeline is TopicManager pasting
the last 80 used topics into the Gemini prompt as an exact-string exclusion
list (see modules/topic_manager.py). That catches nothing but literal repeats
of the same title — a topic that is reworded, reordered, or paraphrased sails
right through.

This module adds a real similarity check with two independent signals:

  * Semantic similarity via `model2vec` (a light, distilled static-embedding
    library — no torch/sentence-transformers needed at inference time). We
    use the `minishlab/potion-base-32M` pretrained model.
  * Lexical similarity via `rapidfuzz.fuzz.token_set_ratio`, which catches
    near-duplicate phrasing (reordered/overlapping words) that an embedding
    model can over-generalize past, or under-cluster.

Topic vectors are stored in a flat numpy .npz file rather than a vector
database — at the hundreds-to-low-thousands-of-topics scale this project
operates at, a flat file is simpler and fast enough to brute-force compare
against on every check.

Two-band thresholding: there is no universal cosine-similarity cutoff that
transfers across domains, so the engine exposes both a `hard_block_threshold`
(treat as an outright duplicate) and a lower `flag_threshold` (surface for
human review but don't auto-block). The defaults below are starting points
only — they have NOT been validated against this channel's real
back-catalogue and will need calibration once real topic history exists.

Testability: `StaticModel.from_pretrained(...)` downloads weights from
HuggingFace Hub on first use, which requires network egress this pipeline's
CI/sandbox environments may not have. The real embedding call is therefore
wrapped behind an injectable `embedder` callable (str -> np.ndarray) so unit
tests can supply a small deterministic fake instead of hitting the network.
Production code takes no action to enable this beyond passing `embedder=None`
(the default), which lazily loads the real model2vec model on first use.
"""

from __future__ import annotations

import logging
import os
import pickle
import tempfile
import zipfile
import zlib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

import numpy as np
from rapidfuzz import fuzz

from config import HISTORY_DIR

logger = logging.getLogger(__name__)

# Pretrained static embedding model used by the default (non-injected) embedder.
MODEL2VEC_MODEL_NAME = "minishlab/potion-base-32M"

# Two-band defaults. NOT validated against a real back-catalogue — calibrate
# these against this channel's actual topic history before relying on them.
DEFAULT_HARD_BLOCK_THRESHOLD = 0.90
DEFAULT_FLAG_THRESHOLD = 0.80

_DEFAULT_VECTORS_PATH = HISTORY_DIR / "topic_vectors.npz"

#: What a truncated or garbage .npz raises. Deliberately NOT OSError: a
#: permission or I/O error is transient, not corruption, and must propagate.
CORRUPT_STORE_ERRORS = (zipfile.BadZipFile, ValueError, KeyError, EOFError,
                        pickle.UnpicklingError, zlib.error)
#: Written next to a store whose reset could not be rebuilt (see
#: ``OriginalityEngine.mark_unrebuilt``). One fixed name per store, so there is
#: never more than one.
RESET_MARKER_SUFFIX = ".reset-unrebuilt"


class OriginalityStoreReset(RuntimeError):
    """The store was reset after corruption and has not been rebuilt, so "no
    duplicates found" would mean "nothing to compare with", not "original"."""


#: How many ``<file>.corrupt-<time>`` copies are kept per file; older ones go.
KEEP_CORRUPT_BACKUPS = 3


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def move_aside_corrupt(path: Path, keep: int = KEEP_CORRUPT_BACKUPS) -> Optional[Path]:
    """Move an unreadable state file to ``<name>.corrupt-<time>`` (never delete
    it), then prune the older such copies beyond ``keep`` so a cached
    ``history/`` directory does not fill with them. Returns the backup path, or
    None when the file could not be moved."""
    path = Path(path)
    backup = path.with_name(f"{path.name}.corrupt-{datetime.now(timezone.utc):%Y%m%dT%H%M%S%f}")
    try:
        os.replace(path, backup)
    except OSError:
        return None
    for old in sorted(path.parent.glob(f"{path.name}.corrupt-*"))[:-keep]:
        try:
            old.unlink()
        except OSError:
            pass
    return backup


def _resolve_vectors_path(vectors_path: Optional[Path | str]) -> Path:
    if vectors_path is not None:
        return Path(vectors_path)
    env_path = os.getenv("CHRONOS_TOPIC_VECTORS")
    if env_path:
        return Path(env_path)
    return _DEFAULT_VECTORS_PATH


@dataclass
class OriginalityResult:
    is_duplicate: bool
    needs_review: bool
    closest_match: Optional[str]
    semantic_score: float
    lexical_score: float


class _LazyModel2VecEmbedder:
    """Loads the real model2vec StaticModel on first call, then reuses it.

    Kept as a separate object (rather than loading in OriginalityEngine
    directly) so tests never trigger a network call: OriginalityEngine only
    ever instantiates this when no `embedder` override was supplied.
    """

    def __init__(self, model_name: str = MODEL2VEC_MODEL_NAME):
        self._model_name = model_name
        self._model = None

    def _ensure_loaded(self):
        if self._model is None:
            from model2vec import StaticModel  # imported lazily; heavy-ish

            logger.info("Loading model2vec model '%s'...", self._model_name)
            self._model = StaticModel.from_pretrained(self._model_name)
        return self._model

    def __call__(self, text: str) -> np.ndarray:
        model = self._ensure_loaded()
        vector = model.encode([text])[0]
        return np.asarray(vector, dtype=np.float32)


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    a = np.asarray(a, dtype=np.float32)
    b = np.asarray(b, dtype=np.float32)
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


class OriginalityEngine:
    """Semantic + lexical duplicate/near-duplicate detector for topics.

    Not wired into the pipeline by this module — TopicManager still does its
    own exact-string exclusion. This is a standalone engine meant to
    eventually replace/augment that (see module docstring and the PR that
    introduced this file for the intended integration).
    """

    def __init__(
        self,
        vectors_path: Optional[Path | str] = None,
        embedder: Optional[Callable[[str], np.ndarray]] = None,
        hard_block_threshold: float = DEFAULT_HARD_BLOCK_THRESHOLD,
        flag_threshold: float = DEFAULT_FLAG_THRESHOLD,
        tolerate_corrupt: bool = False,
    ):
        if not (0.0 <= flag_threshold <= hard_block_threshold <= 1.0):
            raise ValueError(
                "Expected 0 <= flag_threshold <= hard_block_threshold <= 1, "
                f"got flag_threshold={flag_threshold}, "
                f"hard_block_threshold={hard_block_threshold}"
            )

        self.vectors_path = _resolve_vectors_path(vectors_path)
        self.embedder = embedder if embedder is not None else _LazyModel2VecEmbedder()
        self.hard_block_threshold = hard_block_threshold
        self.flag_threshold = flag_threshold
        # STRICT by default, on purpose: the pre-publish gate builds a bare
        # engine and reads an exception as "the duplicate check could not run",
        # which blocks. An engine that quietly started empty would turn a
        # corrupt store into "no duplicates" and let a video through. Only a
        # caller that has its own fallback (TopicManager, which also has the
        # lexical check over topics.json) passes True.
        self.tolerate_corrupt = tolerate_corrupt
        #: Error type name when this engine reset a corrupt store, else None.
        self.reset_reason: Optional[str] = None
        #: The backup copy of that store, when one was kept.
        self.reset_backup: Optional[Path] = None

        self._topics: list[str] = []
        self._vectors: Optional[np.ndarray] = None  # shape (n, dim)
        self._load()

    # -- persistence ---------------------------------------------------

    @property
    def reset_marker(self) -> Path:
        return self.vectors_path.with_name(self.vectors_path.name + RESET_MARKER_SUFFIX)

    def mark_unrebuilt(self) -> None:
        """Record that a reset store was NOT refilled. The corrupt file has been
        moved aside, so without this a strict reader (the pre-publish gate) would
        see an empty store and pass every topic; with it, it raises until a
        non-empty store exists again. Holds a timestamp, nothing else."""
        self.reset_marker.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write_bytes(self.reset_marker, datetime.now(timezone.utc).isoformat().encode())

    def _clear_reset_marker(self) -> None:
        try:
            self.reset_marker.unlink()
        except FileNotFoundError:
            pass

    def _load(self) -> None:
        if not self.tolerate_corrupt and self.reset_marker.exists():
            raise OriginalityStoreReset(
                "the topic vector store was reset after corruption and has not been rebuilt; "
                f"remove {self.reset_marker.name} once the store is restored, or run a topic pick "
                "that registers a topic")
        if not self.vectors_path.exists():
            self._topics = []
            self._vectors = None
            return

        try:
            with np.load(self.vectors_path, allow_pickle=True) as data:
                topics = data["topics"]
                vectors = data["vectors"]
        except CORRUPT_STORE_ERRORS as e:
            if not self.tolerate_corrupt:
                raise
            self.reset_reason = type(e).__name__
            self.reset_backup = move_aside_corrupt(self.vectors_path)
            logger.warning("Topic vector store was unreadable (%s) — %s; it starts empty",
                           self.reset_reason,
                           f"kept a copy as {self.reset_backup.name}" if self.reset_backup
                           else "could not move it aside")
            self._topics = []
            self._vectors = None
            return

        self._topics = [str(t) for t in topics.tolist()]
        self._vectors = vectors.astype(np.float32) if len(self._topics) else None

    def _save(self) -> None:
        """Write to a temp file in the same directory, fsync, then replace: a
        kill mid-write leaves the old store, never half of a new one."""
        self.vectors_path.parent.mkdir(parents=True, exist_ok=True)
        vectors = self._vectors if self._vectors is not None else np.zeros((0, 0), dtype=np.float32)
        fd, tmp = tempfile.mkstemp(dir=self.vectors_path.parent, prefix=self.vectors_path.name + ".",
                                   suffix=".npz")
        try:
            with os.fdopen(fd, "wb") as fh:
                np.savez(fh, topics=np.array(self._topics, dtype=object), vectors=vectors)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self.vectors_path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        if self._topics:
            self._clear_reset_marker()

    # -- public API ------------------------------------------------------

    def check(self, candidate_topic: str) -> OriginalityResult:
        """Compare candidate_topic against every stored topic.

        Returns the scores of whichever stored topic is the closest overall
        match (highest semantic score wins; lexical score reported for that
        same closest match, independently computed).
        """
        if not self._topics or self._vectors is None or len(self._topics) == 0:
            return OriginalityResult(
                is_duplicate=False,
                needs_review=False,
                closest_match=None,
                semantic_score=0.0,
                lexical_score=0.0,
            )

        candidate_vector = np.asarray(self.embedder(candidate_topic), dtype=np.float32)

        best_idx = -1
        best_semantic = -1.0
        for idx, stored_vector in enumerate(self._vectors):
            score = _cosine_similarity(candidate_vector, stored_vector)
            if score > best_semantic:
                best_semantic = score
                best_idx = idx

        best_semantic_topic = self._topics[best_idx]
        best_semantic_score = max(best_semantic, 0.0)

        # Lexical similarity is computed independently against every stored
        # topic too, since the topic with the highest semantic score is not
        # necessarily the one with the highest lexical overlap.
        best_lexical_idx = -1
        best_lexical_score = -1.0
        for idx, stored_topic in enumerate(self._topics):
            score = fuzz.token_set_ratio(candidate_topic, stored_topic) / 100.0
            if score > best_lexical_score:
                best_lexical_score = score
                best_lexical_idx = idx

        # Report against whichever signal is more alarming, so a topic that
        # is a near-duplicate lexically but not semantically (or vice versa)
        # still surfaces its closest match rather than being masked by the
        # other signal's winner.
        if best_lexical_score > best_semantic_score:
            closest_match = self._topics[best_lexical_idx]
            semantic_score = _cosine_similarity(candidate_vector, self._vectors[best_lexical_idx])
            semantic_score = max(semantic_score, 0.0)
            lexical_score = best_lexical_score
        else:
            closest_match = best_semantic_topic
            semantic_score = best_semantic_score
            lexical_score = fuzz.token_set_ratio(candidate_topic, best_semantic_topic) / 100.0

        max_score = max(semantic_score, lexical_score)
        is_duplicate = max_score >= self.hard_block_threshold
        needs_review = (not is_duplicate) and max_score >= self.flag_threshold

        return OriginalityResult(
            is_duplicate=is_duplicate,
            needs_review=needs_review,
            closest_match=closest_match,
            semantic_score=semantic_score,
            lexical_score=lexical_score,
        )

    def rebuild(self, topics) -> int:
        """Replace the store with these topics, embedded now, saved once.
        Returns how many. Used after a reset, from the caller's own history."""
        topics = [t for t in topics if isinstance(t, str) and t.strip()]
        if not topics:
            return 0
        vectors = np.vstack([np.asarray(self.embedder(t), dtype=np.float32).reshape(1, -1) for t in topics])
        self._topics, self._vectors = list(topics), vectors
        self._save()
        return len(topics)

    def register(self, topic: str) -> None:
        """Embed `topic` and persist it to the vector store immediately."""
        vector = np.asarray(self.embedder(topic), dtype=np.float32)

        if self._vectors is None or len(self._topics) == 0:
            self._vectors = vector.reshape(1, -1)
            self._topics = [topic]
        else:
            if vector.shape[0] != self._vectors.shape[1]:
                raise ValueError(
                    f"Embedder dimension mismatch: stored vectors are "
                    f"{self._vectors.shape[1]}-d, new embedding is "
                    f"{vector.shape[0]}-d."
                )
            self._vectors = np.vstack([self._vectors, vector.reshape(1, -1)])
            self._topics.append(topic)

        self._save()
        logger.info("Registered topic in originality store: %s", topic)
