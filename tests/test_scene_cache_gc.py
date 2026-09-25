"""Scene render cache cleanup (modules/scene_cache_gc.py).

A changed scene gets a new cache key and file; the old key's file, and temp
files a killed render left, must be removed after a successful render — while
files in use and anything that is not a cache file stay untouched, and a
cleanup failure never breaks the render."""

import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from modules import scene_cache_gc as gc
from modules import scene_render
from tests.test_scene_render import CountingRenderer, _project, fake_assemble

K1, K2, K3 = "0123456789abcdef", "fedcba9876543210", "00000000ffffffff"


def _dead_pid() -> int:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


class CollectTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.now = time.time()

    def tearDown(self):
        self.tmp.cleanup()

    def put(self, name, size=10, age_s=0.0):
        p = self.dir / name
        p.write_bytes(b"x" * size)
        t = self.now - age_s
        os.utime(p, (t, t))
        return p

    def names(self):
        return sorted(p.name for p in self.dir.iterdir())

    def test_stale_keys_of_current_scenes_are_deleted_in_use_files_kept(self):
        keep = [self.put(f"s000-{K1}.mp4"), self.put(f"s001-{K1}.mp4")]
        self.put(f"s000-{K2}.mp4", size=7)
        self.put(f"s001-{K3}.mp4", size=5)
        report = gc.collect(self.dir, keep, now=self.now)
        self.assertEqual(self.names(), [f"s000-{K1}.mp4", f"s001-{K1}.mp4"])
        self.assertEqual(sorted(report.deleted), [f"s000-{K2}.mp4", f"s001-{K3}.mp4"])
        self.assertEqual(report.freed_bytes, 12)
        self.assertEqual(report.errors, 0)

    def test_scene_id_prefix_is_not_confused(self):
        # "s00" is not "s000": a hyphenated/prefix id must not match another scene.
        keep = [self.put(f"s000-{K1}.mp4")]
        self.put(f"s00-{K2}.mp4")
        self.put(f"a-b-{K2}.mp4")
        gc.collect(self.dir, keep, now=self.now)
        self.assertIn(f"s00-{K2}.mp4", self.names())
        self.assertIn(f"a-b-{K2}.mp4", self.names())

    def test_hyphenated_scene_ids_are_matched_whole(self):
        keep = [self.put(f"intro-a-{K1}.mp4")]
        self.put(f"intro-a-{K2}.mp4")
        gc.collect(self.dir, keep, now=self.now)
        self.assertEqual(self.names(), [f"intro-a-{K1}.mp4"])

    def test_foreign_files_and_orphan_scenes_are_left_alone_without_caps(self):
        keep = [self.put(f"s000-{K1}.mp4")]
        self.put("notes.txt")
        self.put("s000-nothex.mp4")
        self.put(f"s000-{K2}.mov")
        self.put(f"s009-{K2}.mp4", age_s=10 * 86400)   # scene no longer in the project
        (self.dir / f"s000-{K3}.mp4").mkdir()          # a directory, not a file
        report = gc.collect(self.dir, keep, now=self.now)
        self.assertEqual(report.deleted, [])
        self.assertEqual(len(self.names()), 6)

    def test_leftover_temp_files(self):
        keep = [self.put(f"s000-{K1}.mp4")]
        dead = self.put(f".tmp-{_dead_pid()}-s001-{K1}.mp4")
        live_fresh = self.put(f".tmp-{os.getpid()}-s002-{K1}.mp4")
        live_old = self.put(f".tmp-{os.getpid()}-s003-{K1}.mp4", age_s=gc.DEFAULT_TMP_GRACE_S + 60)
        gc.collect(self.dir, keep, now=self.now)
        self.assertFalse(dead.exists())
        self.assertTrue(live_fresh.exists())    # a live writer's temp is never touched
        self.assertFalse(live_old.exists())     # past the grace, even if the pid is alive

    def test_age_cap_deletes_old_unused_files_only(self):
        keep = [self.put(f"s000-{K1}.mp4", age_s=100 * 86400)]  # old but in use
        self.put(f"s007-{K1}.mp4", age_s=3 * 86400)
        self.put(f"s008-{K1}.mp4", age_s=3600)
        gc.collect(self.dir, keep, max_age_s=86400, now=self.now)
        self.assertEqual(self.names(), [f"s000-{K1}.mp4", f"s008-{K1}.mp4"])

    def test_size_cap_evicts_oldest_first_and_never_files_in_use(self):
        keep = [self.put(f"s000-{K1}.mp4", size=100, age_s=9000)]
        self.put(f"s007-{K1}.mp4", size=50, age_s=500)
        self.put(f"s008-{K1}.mp4", size=50, age_s=300)
        self.put(f"s009-{K1}.mp4", size=50, age_s=100)
        gc.collect(self.dir, keep, max_bytes=200, now=self.now)
        self.assertEqual(self.names(), [f"s000-{K1}.mp4", f"s008-{K1}.mp4", f"s009-{K1}.mp4"])
        # In-use files alone over the cap: everything else goes, they stay.
        gc.collect(self.dir, keep, max_bytes=10, now=self.now)
        self.assertEqual(self.names(), [f"s000-{K1}.mp4"])

    def test_zero_is_a_cap_none_is_not(self):
        keep = [self.put(f"s000-{K1}.mp4")]
        self.put(f"s009-{K1}.mp4")
        gc.collect(self.dir, keep, max_bytes=None, max_age_s=None, now=self.now)
        self.assertIn(f"s009-{K1}.mp4", self.names())
        gc.collect(self.dir, keep, max_bytes=0, now=self.now)
        self.assertEqual(self.names(), [f"s000-{K1}.mp4"])

    def test_missing_directory_is_a_no_op(self):
        report = gc.collect(self.dir / "absent", [], now=self.now)
        self.assertEqual((report.deleted, report.errors), ([], 0))


class EnvCapsTestCase(unittest.TestCase):
    def caps(self, **env):
        with mock.patch.dict(os.environ, env, clear=False):
            for k in (gc.MAX_MB_ENV, gc.MAX_AGE_DAYS_ENV):
                if k not in env:
                    os.environ.pop(k, None)
            return gc.caps_from_env()

    def test_unset_and_blank_mean_no_cap(self):
        self.assertEqual(self.caps(), {"max_bytes": None, "max_age_s": None})
        self.assertEqual(self.caps(**{gc.MAX_MB_ENV: " ", gc.MAX_AGE_DAYS_ENV: ""}),
                         {"max_bytes": None, "max_age_s": None})

    def test_zero_and_numbers(self):
        self.assertEqual(self.caps(**{gc.MAX_MB_ENV: "0", gc.MAX_AGE_DAYS_ENV: "0"}),
                         {"max_bytes": 0, "max_age_s": 0.0})
        self.assertEqual(self.caps(**{gc.MAX_MB_ENV: "1.5", gc.MAX_AGE_DAYS_ENV: "2"}),
                         {"max_bytes": int(1.5 * 1024 * 1024), "max_age_s": 2 * 86400.0})

    def test_invalid_or_negative_disable_the_cap(self):
        self.assertEqual(self.caps(**{gc.MAX_MB_ENV: "lots", gc.MAX_AGE_DAYS_ENV: "-1"}),
                         {"max_bytes": None, "max_age_s": None})


class CleanupNeverRaisesTestCase(unittest.TestCase):
    def test_failure_is_swallowed(self):
        with mock.patch.object(gc, "collect", side_effect=OSError("disk gone")):
            self.assertIsNone(gc.cleanup("/nowhere", []))

    def test_undeletable_file_counts_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            keep = Path(d) / f"s000-{K1}.mp4"
            keep.write_bytes(b"x")
            (Path(d) / f"s000-{K2}.mp4").write_bytes(b"x")
            with mock.patch.object(Path, "unlink", side_effect=PermissionError("ro")):
                report = gc.collect(d, [keep])
            self.assertEqual((report.deleted, report.errors), ([], 1))


class RenderProjectIntegrationTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.out = self.root / "out" / "final_video.mp4"
        self.scenes = self.out.parent / "scenes"
        self._env = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        os.environ.pop(gc.MAX_MB_ENV, None)
        os.environ.pop(gc.MAX_AGE_DAYS_ENV, None)

    def tearDown(self):
        self._env.stop()
        self.tmp.cleanup()

    def run_once(self, project, renderer=None):
        return scene_render.render_project(project, self.out,
                                           renderers={"ffmpeg": renderer or CountingRenderer()},
                                           assemble_fn=fake_assemble)

    def names(self):
        return sorted(p.name for p in self.scenes.iterdir())

    def test_a_changed_scene_replaces_its_old_file(self):
        self.run_once(_project(self.root))
        before = self.names()
        changed = _project(self.root, narrations=("one", "two, rewritten", "three"))
        self.run_once(changed)
        after = self.names()
        self.assertEqual(len(after), 3)
        self.assertNotIn([n for n in before if n.startswith("s001-")][0], after)
        self.assertEqual([n for n in before if not n.startswith("s001-")],
                         [n for n in after if not n.startswith("s001-")])
        # And the kept files are still cache hits.
        again = CountingRenderer()
        self.run_once(changed, again)
        self.assertEqual(again.calls, [])

    def test_leftover_temp_from_a_dead_render_is_removed(self):
        self.scenes.mkdir(parents=True)
        leftover = self.scenes / f".tmp-{_dead_pid()}-s001-{K1}.mp4"
        leftover.write_bytes(b"partial")
        self.run_once(_project(self.root))
        self.assertFalse(leftover.exists())

    def test_a_failed_render_cleans_nothing(self):
        self.run_once(_project(self.root))
        before = self.names()
        changed = _project(self.root, narrations=("one", "two, rewritten", "three"))
        with self.assertRaises(RuntimeError):
            self.run_once(changed, CountingRenderer(fail_on={"s001"}))
        self.assertEqual(self.names(), before)

    def test_cleanup_failure_does_not_break_the_render(self):
        with mock.patch.object(gc, "collect", side_effect=RuntimeError("boom")):
            result = self.run_once(_project(self.root))
        self.assertTrue(self.out.exists())
        self.assertEqual(result.scenes, 3)


if __name__ == "__main__":
    unittest.main()
