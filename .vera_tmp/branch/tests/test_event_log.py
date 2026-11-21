"""Tests for modules/event_log.py — the observability event stream.

Uses a real tempdir StateStore (injected) so emit() exercises the real write
path, plus a direct check that emit() never raises and never leaks secrets.
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from modules import event_log as events
from modules.state_store import StateStore


class EventLogTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmpdir.name) / "test_chronos.db"
        self.store = StateStore(self.db_path)

    def tearDown(self):
        self.store.close()
        self._tmpdir.cleanup()

    def test_emit_records_event_with_injected_store(self):
        ok = events.emit(
            events.TOPIC_SELECTED, agent="topic_manager", status=events.STATUS_COMPLETED,
            metadata={"topic": "The Fall of Rome"}, store=self.store,
        )
        self.assertTrue(ok)
        rows = self.store.list_events()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["event"], "topic.selected")
        self.assertEqual(rows[0]["agent"], "topic_manager")
        self.assertEqual(json.loads(rows[0]["metadata"])["topic"], "The Fall of Rome")

    def test_emit_redacts_sensitive_metadata_keys(self):
        events.emit(
            events.UPLOAD_STARTED, store=self.store,
            metadata={"api_key": "SECRET123", "access_token": "abc", "topic": "safe", "video_key": "keep-me"},
        )
        meta = json.loads(self.store.list_events()[0]["metadata"])
        self.assertEqual(meta["api_key"], "[redacted]")
        self.assertEqual(meta["access_token"], "[redacted]")
        # A non-credential key that merely contains "key" as a word part is kept.
        self.assertEqual(meta["video_key"], "keep-me")
        self.assertEqual(meta["topic"], "safe")

    def test_emit_never_raises_on_broken_store(self):
        class BrokenStore:
            def record_event(self, **kwargs):
                raise RuntimeError("db is on fire")

        # Must return False, not raise — observability can't break the caller.
        self.assertFalse(events.emit(events.RENDER_STARTED, store=BrokenStore()))

    def test_emit_opens_its_own_store_when_none_injected(self):
        # With no store injected, emit() constructs a StateStore; patch it to a
        # tempdir-backed one so this test never touches the real project DB.
        with patch("modules.state_store.StateStore", side_effect=lambda: StateStore(self.db_path)):
            ok = events.emit(events.SYSTEM_STARTED, agent="pipeline")
        self.assertTrue(ok)
        # Re-open to read (the emit() one was closed by its context manager).
        with StateStore(self.db_path) as store:
            self.assertEqual(store.list_events()[0]["event"], "system.started")

    def test_list_events_filters_and_orders(self):
        events.emit("a.one", store=self.store, video_id="v1")
        events.emit("a.two", store=self.store, video_id="v2")
        events.emit("a.three", store=self.store, video_id="v1")

        # Newest first.
        all_rows = self.store.list_events()
        self.assertEqual(all_rows[0]["event"], "a.three")
        # Filter by video.
        v1 = self.store.list_events(video_id="v1")
        self.assertEqual({r["event"] for r in v1}, {"a.one", "a.three"})

    def test_unserializable_metadata_does_not_break_emit(self):
        ok = events.emit("weird.event", store=self.store, metadata={"obj": object()})
        self.assertTrue(ok)
        # It stored *something* (a repr), not crashed.
        self.assertIsNotNone(self.store.list_events()[0]["metadata"])


if __name__ == "__main__":
    unittest.main()
