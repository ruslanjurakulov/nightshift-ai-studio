"""modules/disk_guard.py - free-disk precheck and pruning of old finished/held runs."""

import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from modules import disk_guard as dg

DAY = 86400.0


def make_run(root: Path, name: str, *, completed=False, stages=("render",), age_days=0.0, now=None, keep=False, checkpoint=True):
    run = root / name
    run.mkdir(parents=True)
    (run / "final_video.mp4").write_bytes(b"x" * 100)
    if checkpoint:
        (run / "checkpoint.json").write_text(json.dumps({"slug": name, "completed": completed, "stages": {s: {} for s in stages}}))
    if keep:
        (run / ".keep").write_text("")
    when = (now or time.time()) - age_days * DAY
    for p in [*run.rglob("*"), run]:
        os.utime(p, (when, when))
    return run


class FreeDisk(unittest.TestCase):
    def test_refuses_under_five_gb(self):
        with self.assertRaises(dg.InsufficientDisk) as cm:
            dg.require_free_disk(Path("/out"), free_fn=lambda p: 4 * dg.GB)
        self.assertIn("4.0 GB free", str(cm.exception))
        self.assertIn("--prune-days", str(cm.exception))

    def test_passes_at_the_limit_and_returns_free_bytes(self):
        self.assertEqual(dg.require_free_disk(Path("/out"), free_fn=lambda p: 5 * dg.GB), 5 * dg.GB)

    def test_default_minimum_is_five_gb(self):
        self.assertEqual(dg.MIN_FREE_BYTES, 5 * 1024 ** 3)

    def test_real_free_bytes_on_a_missing_path_uses_its_parent(self):
        with tempfile.TemporaryDirectory() as t:
            self.assertGreater(dg.free_bytes(Path(t) / "not" / "there"), 0)


class Prune(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.root = Path(self._t.name)
        self.now = time.time()

    def tearDown(self):
        self._t.cleanup()

    def names(self, days=30, **kw):
        return [r.path.name for r in dg.find_prunable(self.root, days, now=self.now, **kw)]

    def test_old_finished_and_old_held_are_selected_recent_are_not(self):
        make_run(self.root, "old-finished", completed=True, age_days=60, now=self.now)
        make_run(self.root, "old-held", completed=False, stages=("script", "render"), age_days=45, now=self.now)
        make_run(self.root, "recent-finished", completed=True, age_days=3, now=self.now)
        self.assertEqual(sorted(self.names()), ["old-finished", "old-held"])

    def test_an_unrendered_incomplete_run_is_resumable_and_is_never_pruned(self):
        make_run(self.root, "half-done", completed=False, stages=("script", "voice"), age_days=90, now=self.now)
        self.assertEqual(self.names(), [])

    def test_keep_marker_and_non_run_folders_and_symlinks_are_left_alone(self):
        make_run(self.root, "kept", completed=True, age_days=90, now=self.now, keep=True)
        make_run(self.root, "no-checkpoint", age_days=90, now=self.now, checkpoint=False)
        (self.root / "shared-cache").mkdir()
        target = make_run(self.root.parent / (self.root.name + "-elsewhere"), "outside", completed=True, age_days=90, now=self.now)
        (self.root / "link").symlink_to(target, target_is_directory=True)
        self.assertEqual(self.names(), [])
        self.assertTrue(target.exists())

    def test_one_fresh_file_inside_keeps_the_whole_run(self):
        run = make_run(self.root, "active", completed=True, age_days=90, now=self.now)
        (run / "new.txt").write_text("fresh")
        self.assertEqual(self.names(), [])

    def test_too_short_a_window_is_refused(self):
        with self.assertRaises(ValueError):
            dg.find_prunable(self.root, 1)

    def test_dry_run_deletes_nothing_apply_deletes(self):
        run = make_run(self.root, "old", completed=True, age_days=60, now=self.now)
        dry = dg.prune_old_runs(self.root, 30, now=self.now)
        self.assertEqual([r.path.name for r in dry], ["old"])
        self.assertTrue(run.exists())
        done = dg.prune_old_runs(self.root, 30, apply=True, now=self.now)
        self.assertEqual([r.path.name for r in done], ["old"])
        self.assertFalse(run.exists())

    def test_cli_dry_run_by_default_and_exit_codes(self):
        import contextlib
        import io
        run = make_run(self.root, "old", completed=True, age_days=60)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(dg.main(["--output-dir", str(self.root), "--prune-days", "30"]), 0)
        self.assertIn("would remove old", buf.getvalue())
        self.assertIn("dry run", buf.getvalue())
        self.assertTrue(run.exists())
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(dg.main(["--output-dir", str(self.root), "--prune-days", "2"]), 2)
            self.assertEqual(dg.main(["--output-dir", str(self.root), "--prune-days", "30", "--apply"]), 0)
        self.assertFalse(run.exists())


if __name__ == "__main__":
    unittest.main()
