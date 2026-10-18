"""modules/disk_guard.py - free-disk precheck and pruning of old finished/held runs."""

import os
import tempfile
import time
import unittest
from pathlib import Path

from modules import disk_guard as dg
from modules import upload_idempotency
from modules.run_checkpoint import clear, record_stage

DAY = 86400.0


def age_it(run: Path, age_days: float, now: float) -> None:
    when = now - age_days * DAY
    for p in [*run.rglob("*"), run]:
        os.utime(p, (when, when))


def start_run(root: Path, name: str, stages=("script", "voice", "media", "render")) -> Path:
    """A run built through the REAL checkpoint lifecycle (main.py's record_stage calls)."""
    for st in stages:
        record_stage(name, st, topic="t", channel_id="chan", root=root)
    run = root / name
    if "render" in stages:
        (run / "final_video.mp4").write_bytes(b"x" * 100)
    return run


def published_run(root: Path, name: str, age_days: float, now: float) -> Path:
    """What main.py leaves after a successful upload: upload ledger says uploaded,
    then run_checkpoint.clear (main.py:1285)."""
    run = start_run(root, name)
    attempt = upload_idempotency.begin(name, "chan", root=root)
    attempt.mark_started()
    attempt.mark_uploaded("yt123")
    clear(name, root)
    age_it(run, age_days, now)
    return run


def held_run(root: Path, name: str, age_days: float, now: float, *, upload_failed=False) -> Path:
    """Rendered, not uploaded: held / blocked / awaiting approval (checkpoint kept),
    or an upload that failed (ledger says failed)."""
    run = start_run(root, name)
    if upload_failed:
        attempt = upload_idempotency.begin(name, "chan", root=root)
        attempt.mark_started()
        attempt.mark_failed()
    age_it(run, age_days, now)
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
        return sorted(r.path.name for r in dg.find_prunable(self.root, days, now=self.now, **kw))

    def test_the_real_lifecycle_leaves_what_the_classifier_reads(self):
        run = published_run(self.root, "pub", 0, self.now)
        self.assertFalse((run / "checkpoint.json").exists())      # cleared on upload success
        self.assertTrue((run / "upload_attempt.json").exists())
        self.assertEqual(dg.classify(run), "published")
        self.assertEqual(dg.classify(held_run(self.root, "h", 0, self.now)), "held")

    def test_old_published_is_selected_recent_published_is_not(self):
        published_run(self.root, "old-pub", 60, self.now)
        published_run(self.root, "new-pub", 3, self.now)
        self.assertEqual(self.names(), ["old-pub"])

    def test_held_blocked_awaiting_and_upload_failed_runs_are_never_selected_by_default(self):
        held_run(self.root, "held", 90, self.now)
        held_run(self.root, "upload-failed", 90, self.now, upload_failed=True)
        self.assertEqual(self.names(), [])
        self.assertEqual(self.names(include_held=True), ["held", "upload-failed"])

    def test_held_run_survives_a_default_apply(self):
        run = held_run(self.root, "held", 90, self.now)
        published_run(self.root, "pub", 90, self.now)
        done = dg.prune_old_runs(self.root, 30, apply=True, now=self.now)
        self.assertEqual([r.path.name for r in done], ["pub"])
        self.assertTrue(run.exists())

    def test_an_unrendered_resumable_run_is_never_pruned_even_with_include_held(self):
        run = start_run(self.root, "half", stages=("script", "voice"))
        age_it(run, 90, self.now)
        self.assertEqual(self.names(include_held=True), [])

    def test_uploaded_ledger_but_checkpoint_still_present_is_left_alone(self):
        run = start_run(self.root, "odd")
        attempt = upload_idempotency.begin("odd", "chan", root=self.root)
        attempt.mark_started()
        attempt.mark_uploaded("yt")          # clear() never ran
        age_it(run, 90, self.now)
        self.assertEqual(self.names(include_held=True), [])

    def test_no_ledger_no_checkpoint_is_not_a_run_we_understand(self):
        run = self.root / "mystery"
        run.mkdir()
        (run / "final_video.mp4").write_bytes(b"x")
        age_it(run, 90, self.now)
        self.assertEqual(self.names(include_held=True), [])

    def test_keep_marker_non_run_folders_and_symlinks_are_left_alone(self):
        kept = published_run(self.root, "kept", 90, self.now)
        (kept / ".keep").write_text("")
        (self.root / "shared-cache").mkdir()
        outside = published_run(self.root.parent / (self.root.name + "-elsewhere"), "outside", 90, self.now)
        (self.root / "link").symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.names(), [])
        self.assertTrue(outside.exists())

    def test_one_fresh_file_inside_keeps_the_whole_run(self):
        run = published_run(self.root, "active", 90, self.now)
        (run / "new.txt").write_text("fresh")
        self.assertEqual(self.names(), [])

    def test_too_short_a_window_is_refused(self):
        with self.assertRaises(ValueError):
            dg.find_prunable(self.root, 1)

    def test_dry_run_deletes_nothing_apply_deletes(self):
        run = published_run(self.root, "old", 60, self.now)
        dry = dg.prune_old_runs(self.root, 30, now=self.now)
        self.assertEqual([r.path.name for r in dry], ["old"])
        self.assertTrue(run.exists())
        done = dg.prune_old_runs(self.root, 30, apply=True, now=self.now)
        self.assertEqual([r.path.name for r in done], ["old"])
        self.assertFalse(run.exists())

    def test_cli_dry_run_by_default_held_flag_and_exit_codes(self):
        import contextlib
        import io
        pub = published_run(self.root, "old", 60, time.time())
        held = held_run(self.root, "held", 60, time.time())
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(dg.main(["--output-dir", str(self.root), "--prune-days", "30"]), 0)
        self.assertIn("would remove old", buf.getvalue())
        self.assertNotIn("held", buf.getvalue().replace("would remove old", ""))
        self.assertIn("dry run", buf.getvalue())
        self.assertTrue(pub.exists())
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(dg.main(["--output-dir", str(self.root), "--prune-days", "2"]), 2)
            self.assertEqual(dg.main(["--output-dir", str(self.root), "--prune-days", "30", "--apply"]), 0)
        self.assertFalse(pub.exists())
        self.assertTrue(held.exists())
        with contextlib.redirect_stdout(io.StringIO()):
            dg.main(["--output-dir", str(self.root), "--prune-days", "30", "--apply", "--include-held"])
        self.assertFalse(held.exists())


if __name__ == "__main__":
    unittest.main()
