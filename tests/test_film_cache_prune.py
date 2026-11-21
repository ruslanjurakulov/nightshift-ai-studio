import os
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

from modules import film_assembly as fa
from modules import media_library as ml

DAY = 86400


class PruneWordCacheTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name) / "media"
        self.cache = self.root / fa.CACHE_DIRNAME
        self.cache.mkdir(parents=True)

    def entry(self, with_narration=True, age_days=0):
        nid = str(uuid.uuid4())
        if with_narration:
            f = ml.asset_file(self.root, nid, "original")
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(b"x")
        p = self.cache / f"{nid}.json"
        p.write_text("[]")
        t = time.time() - age_days * DAY
        os.utime(p, (t, t))
        return p

    def test_removes_orphan_and_old_keeps_fresh(self):
        fresh = self.entry()
        orphan = self.entry(with_narration=False)
        old = self.entry(age_days=fa.CACHE_MAX_AGE_DAYS + 1)
        self.assertEqual(fa.prune_word_cache(self.root), 2)
        self.assertTrue(fresh.exists())
        self.assertFalse(orphan.exists())
        self.assertFalse(old.exists())

    def test_runs_at_most_once_per_day(self):
        fa.prune_word_cache(self.root)
        orphan = self.entry(with_narration=False)
        self.assertEqual(fa.prune_word_cache(self.root), 0)
        self.assertTrue(orphan.exists())
        self.assertEqual(fa.prune_word_cache(self.root, now=time.time() + 2 * DAY), 1)

    def test_symlink_entry_pointing_outside_is_left_alone(self):
        outside = Path(self._tmp.name) / "outside.json"
        outside.write_text("keep")
        link = self.cache / f"{uuid.uuid4()}.json"
        try:
            os.symlink(outside, link)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks not permitted here")
        fa.prune_word_cache(self.root)
        self.assertTrue(outside.exists())
        self.assertTrue(link.is_symlink())

    def test_symlinked_cache_dir_is_refused(self):
        real = Path(self._tmp.name) / "elsewhere"
        real.mkdir()
        victim = real / f"{uuid.uuid4()}.json"
        victim.write_text("[]")
        self.cache.rmdir()
        try:
            os.symlink(real, self.cache, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks not permitted here")
        self.assertEqual(fa.prune_word_cache(self.root), 0)
        self.assertTrue(victim.exists())

    def test_failure_does_not_raise(self):
        self.entry(with_narration=False)
        with mock.patch("os.scandir", side_effect=PermissionError("denied")):
            with self.assertLogs(fa.logger, "WARNING") as cm:
                self.assertEqual(fa.prune_word_cache(self.root), 0)
        self.assertIn("failed", cm.output[0])

    def test_unlink_failure_does_not_stop_the_rest(self):
        a = self.entry(with_narration=False)
        b = self.entry(with_narration=False)
        real = os.unlink
        calls = []

        def flaky(p, *a_, **k):
            calls.append(p)
            if len(calls) == 1:
                raise PermissionError("busy")
            return real(p, *a_, **k)

        with mock.patch("os.unlink", flaky):
            self.assertEqual(fa.prune_word_cache(self.root), 1)
        self.assertEqual(sum(p.exists() for p in (a, b)), 1)

    def test_missing_cache_dir_is_fine(self):
        self.cache.rmdir()
        self.assertEqual(fa.prune_word_cache(self.root), 0)


if __name__ == "__main__":
    unittest.main()
