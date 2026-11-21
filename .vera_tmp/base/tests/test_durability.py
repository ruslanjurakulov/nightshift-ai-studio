"""State durability: a read-only JSON snapshot of the history, and a mirror
health check. Rules under test: snapshot never writes to the store, an
unreadable remote is reported as unknown (not mirrored), a gap is flagged, and
nothing here raises."""

import json
import tempfile
import unittest
from pathlib import Path

from modules import durability as dur


class _FakeStore:
    def __init__(self, videos, metrics=None):
        self._videos = videos
        self._metrics = metrics or {}

    def list_videos(self, limit=100, channel_id=None):
        if channel_id is None:
            return list(self._videos)
        return [v for v in self._videos if v.get("channel_id") == channel_id]

    def latest_metrics(self, video_id):
        return self._metrics.get(video_id)


class _BoomStore:
    def list_videos(self, limit=100, channel_id=None):
        raise RuntimeError("db down")

    def latest_metrics(self, video_id):
        raise RuntimeError("db down")


class _FakeSync:
    def __init__(self, remote_rows, configured=True, raise_exc=None):
        self.configured = configured
        self._rows = remote_rows
        self._raise = raise_exc

    def select(self, table, params=None):
        if self._raise:
            raise self._raise
        return self._rows


class SnapshotTestCase(unittest.TestCase):
    def test_snapshot_gathers_videos_and_metrics(self):
        store = _FakeStore(
            [{"video_id": "a"}, {"video_id": "b"}],
            {"a": {"views": 10}, "b": {"views": 20}},
        )
        snap = dur.snapshot(store)
        self.assertEqual(snap["video_count"], 2)
        self.assertEqual(snap["latest_metrics"]["a"]["views"], 10)

    def test_snapshot_read_failure_is_empty(self):
        snap = dur.snapshot(_BoomStore())
        self.assertEqual(snap["video_count"], 0)

    def test_write_snapshot_produces_file(self):
        store = _FakeStore([{"video_id": "a"}], {"a": {"views": 5}})
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "backup" / "snap.json"
            n = dur.write_snapshot(store, path)
            self.assertEqual(n, 1)
            self.assertTrue(path.exists())
            data = json.loads(path.read_text())
            self.assertEqual(data["video_count"], 1)

    def test_write_snapshot_bad_path_returns_none(self):
        store = _FakeStore([{"video_id": "a"}])
        # A path whose parent can't be created (a file used as a dir) → None.
        with tempfile.NamedTemporaryFile() as f:
            bad = Path(f.name) / "nope" / "snap.json"
            self.assertIsNone(dur.write_snapshot(store, bad))


class MirrorCheckTestCase(unittest.TestCase):
    def test_mirrored_when_remote_has_all(self):
        store = _FakeStore([{"video_id": "a"}, {"video_id": "b"}])
        sync = _FakeSync([{"video_id": "a"}, {"video_id": "b"}])
        report = dur.check_mirrored(store, sync)
        self.assertTrue(report.mirrored)
        self.assertEqual(report.gap, 0)

    def test_gap_flagged(self):
        store = _FakeStore([{"video_id": "a"}, {"video_id": "b"}, {"video_id": "c"}])
        sync = _FakeSync([{"video_id": "a"}])
        report = dur.check_mirrored(store, sync)
        self.assertFalse(report.mirrored)
        self.assertEqual(report.gap, 2)

    def test_no_sync_is_unknown_not_mirrored(self):
        store = _FakeStore([{"video_id": "a"}])
        report = dur.check_mirrored(store, None)
        self.assertFalse(report.mirror_configured)
        self.assertIsNone(report.remote_videos)
        self.assertFalse(report.mirrored)   # unknown never claims mirrored
        self.assertIsNone(report.gap)

    def test_unreadable_remote_is_unknown(self):
        store = _FakeStore([{"video_id": "a"}])
        sync = _FakeSync(None, configured=True, raise_exc=RuntimeError("network"))
        report = dur.check_mirrored(store, sync)
        self.assertIsNone(report.remote_videos)
        self.assertFalse(report.mirrored)

    def test_unconfigured_sync_skips_remote(self):
        store = _FakeStore([{"video_id": "a"}])
        sync = _FakeSync([{"video_id": "a"}], configured=False)
        report = dur.check_mirrored(store, sync)
        self.assertFalse(report.mirror_configured)
        self.assertIsNone(report.remote_videos)


class RunDurabilityCheckTestCase(unittest.TestCase):
    def test_returns_report_and_writes_snapshot(self):
        store = _FakeStore([{"video_id": "a"}], {"a": {"views": 1}})
        sync = _FakeSync([{"video_id": "a"}])
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "snap.json"
            report = dur.run_durability_check(store, sync, snapshot_path=path)
            self.assertTrue(report.mirrored)
            self.assertTrue(path.exists())

    def test_never_raises_on_boom(self):
        # Even with a broken store and no sync, it returns a report.
        report = dur.run_durability_check(_BoomStore(), None)
        self.assertEqual(report.local_videos, 0)


if __name__ == "__main__":
    unittest.main()
