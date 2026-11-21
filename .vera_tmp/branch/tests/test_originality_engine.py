"""Unit tests for modules.originality_engine.

These tests never touch the network or load the real model2vec model: an
injected fake embedder stands in for `StaticModel.from_pretrained(...)`. The
fake embedder is a deterministic word-bigram hashing function (see
`_fake_embed` below) rather than a real semantic model, but it is enough to
prove the engine's *logic* is correct:

  * Two identical strings always produce identical vectors (cosine == 1.0).
  * Small, order-preserving edits (a paraphrase) keep most bigrams intact,
    so cosine similarity stays high but not perfect.
  * A full word-order reversal keeps the exact same *set* of words (so
    rapidfuzz's token_set_ratio scores it as a lexical near-duplicate) while
    destroying every bigram (so this fake embedder scores it as semantically
    unrelated) — this is the case that proves the two signals are
    independent, not just semantic doing all the work.
"""

import hashlib
import tempfile
import unittest
from pathlib import Path

import numpy as np

from modules.originality_engine import OriginalityEngine, OriginalityResult

_DIM = 64


def _fake_embed(text: str) -> np.ndarray:
    """Deterministic, order-sensitive fake embedder for tests.

    Hashes each consecutive word-bigram of `text` into a fixed-size vector
    (word order matters: reordering a sentence changes essentially every
    bigram). No network access, no randomness (PYTHONHASHSEED-independent —
    uses md5, not the builtin hash()).
    """
    words = text.lower().split()
    if len(words) < 2:
        grams = words
    else:
        grams = [f"{words[i]} {words[i + 1]}" for i in range(len(words) - 1)]

    vec = np.zeros(_DIM, dtype=np.float32)
    for gram in grams:
        digest = hashlib.md5(gram.encode("utf-8")).hexdigest()
        idx = int(digest, 16) % _DIM
        vec[idx] += 1.0

    norm = np.linalg.norm(vec)
    if norm > 0:
        vec = vec / norm
    return vec


class OriginalityEngineTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.vectors_path = Path(self._tmpdir.name) / "topic_vectors.npz"

    def _make_engine(self, **kwargs) -> OriginalityEngine:
        return OriginalityEngine(
            vectors_path=self.vectors_path,
            embedder=_fake_embed,
            **kwargs,
        )

    def test_empty_store_never_flags_first_topic(self):
        engine = self._make_engine()
        result = engine.check("Any topic at all")
        self.assertIsInstance(result, OriginalityResult)
        self.assertFalse(result.is_duplicate)
        self.assertFalse(result.needs_review)
        self.assertIsNone(result.closest_match)
        self.assertEqual(result.semantic_score, 0.0)
        self.assertEqual(result.lexical_score, 0.0)

    def test_exact_repeat_is_hard_blocked(self):
        engine = self._make_engine()
        topic = "The Untold Story of the Roman Colosseum"
        engine.register(topic)

        result = engine.check(topic)

        self.assertTrue(result.is_duplicate)
        self.assertFalse(result.needs_review)
        self.assertEqual(result.closest_match, topic)
        self.assertAlmostEqual(result.semantic_score, 1.0, places=5)
        self.assertAlmostEqual(result.lexical_score, 1.0, places=5)

    def test_near_paraphrase_trips_review_band(self):
        engine = self._make_engine()
        original = "lost city of atlantis"
        # Same opening words/word-order plus a trailing addition: most
        # bigrams survive, so this fake embedder still clusters it close,
        # but not identically, to the original.
        paraphrase = "lost city of atlantis discovered"
        engine.register(original)

        result = engine.check(paraphrase)

        self.assertEqual(result.closest_match, original)
        # Should land in (flag_threshold, hard_block_threshold) or above —
        # either way it must not be treated as clean/novel.
        self.assertTrue(result.is_duplicate or result.needs_review)
        self.assertGreaterEqual(
            max(result.semantic_score, result.lexical_score),
            engine.flag_threshold,
        )

    def test_unrelated_topic_passes_clean(self):
        engine = self._make_engine()
        engine.register("The Untold Story of the Roman Colosseum")

        result = engine.check("How Coral Reefs Form Over Centuries")

        self.assertFalse(result.is_duplicate)
        self.assertFalse(result.needs_review)
        self.assertLess(result.semantic_score, engine.flag_threshold)
        self.assertLess(result.lexical_score, engine.flag_threshold)

    def test_lexical_signal_catches_what_semantic_misses(self):
        """A full word-order reversal: same bag of words (rapidfuzz's
        token_set_ratio scores it ~100) but every bigram is destroyed, so
        this order-sensitive fake embedder scores it as unrelated. This
        proves lexical and semantic are genuinely independent signals — the
        duplicate is caught here by lexical alone.
        """
        engine = self._make_engine()
        original = "ancient greek philosophers debate stoicism"
        reversed_topic = " ".join(reversed(original.split()))
        self.assertNotEqual(original, reversed_topic)

        engine.register(original)
        result = engine.check(reversed_topic)

        # Semantic signal alone would NOT flag this.
        self.assertLess(result.semantic_score, engine.flag_threshold)
        # Lexical signal alone catches it, and pushes the overall verdict
        # to a hard block even though semantic saw nothing.
        self.assertGreaterEqual(result.lexical_score, engine.hard_block_threshold)
        self.assertTrue(result.is_duplicate)
        self.assertEqual(result.closest_match, original)

    def test_register_persists_across_engine_instances(self):
        engine = self._make_engine()
        engine.register("Why the Library of Alexandria Burned")
        self.assertTrue(self.vectors_path.exists())

        reloaded = self._make_engine()
        result = reloaded.check("Why the Library of Alexandria Burned")
        self.assertTrue(result.is_duplicate)

    def test_invalid_thresholds_raise(self):
        with self.assertRaises(ValueError):
            self._make_engine(hard_block_threshold=0.5, flag_threshold=0.8)


if __name__ == "__main__":
    unittest.main()
