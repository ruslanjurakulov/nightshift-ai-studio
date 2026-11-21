"""emit() also sends each event to Supabase's system_events at once (the Studio's live view reads it there).

What would break without these: a run that fails because Supabase is slow or down, a run that waits on Supabase for every event
after the first failure, an event key that differs from the nightly mirror's (the same event twice in system_events), a secret
that reaches Supabase unsanitized, or a sync that starts where nothing asked for it (no credentials, or switched off).
"""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from modules import event_log as events
from modules.state_store import StateStore
from modules.supabase_sync import SupabaseSync

CREDS = {"SUPABASE_URL": "https://lab.invalid", "SUPABASE_SERVICE_KEY": "lab-not-a-key"}


def ok_response():
    r = MagicMock()
    r.status_code = 201
    return r


class LiveSyncCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = StateStore(Path(self._tmp.name) / "chronos.db")
        events._reset_live_sync()
        env = {k: v for k, v in os.environ.items() if k not in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "NIGHTSHIFT_LIVE_EVENTS")}
        self._env = patch.dict(os.environ, env, clear=True)
        self._env.start()

    def tearDown(self):
        self._env.stop()
        self.store.close()
        self._tmp.cleanup()
        events._reset_live_sync()

    def test_without_credentials_emit_is_exactly_as_before_and_sends_nothing(self):
        with patch("modules.supabase_sync.requests.post") as post:
            self.assertTrue(events.emit(events.TOPIC_SELECTED, agent="topic_manager", channel_id="ch1", store=self.store))
        post.assert_not_called()
        self.assertEqual(len(self.store.list_events()), 1)

    def test_switched_off_sends_nothing_even_with_credentials(self):
        with patch.dict(os.environ, {**CREDS, "NIGHTSHIFT_LIVE_EVENTS": "off"}), patch("modules.supabase_sync.requests.post") as post:
            self.assertTrue(events.emit(events.TOPIC_SELECTED, store=self.store))
        post.assert_not_called()

    def test_sends_the_same_row_and_event_key_the_nightly_mirror_sends(self):
        with patch.dict(os.environ, CREDS), patch("modules.supabase_sync.requests.post", return_value=ok_response()) as post:
            self.assertTrue(events.emit(events.UPLOAD_COMPLETED, agent="youtube_uploader", status="completed",
                                        metadata={"privacy": "private"}, channel_id="ch1", store=self.store))
        post.assert_called_once()
        args, kwargs = post.call_args
        self.assertTrue(args[0].endswith("/rest/v1/system_events"))
        self.assertEqual(kwargs["params"], {"on_conflict": "event_key"})
        (sent,) = kwargs["json"]
        mirrored = SupabaseSync._event_row(self.store.list_events()[0])
        self.assertEqual(sent, mirrored)
        self.assertEqual(sent["event_key"], mirrored["event_key"])
        self.assertEqual(json.loads(sent["metadata"])["privacy"], "private")

    def test_a_short_timeout_so_a_slow_supabase_cannot_hold_the_run(self):
        with patch.dict(os.environ, CREDS), patch("modules.supabase_sync.requests.post", return_value=ok_response()) as post:
            events.emit(events.TOPIC_SELECTED, store=self.store)
        self.assertLessEqual(post.call_args.kwargs["timeout"], 3)

    def test_a_failing_sync_still_returns_true_keeps_the_local_row_and_stops_trying(self):
        with patch.dict(os.environ, CREDS), patch("modules.supabase_sync.requests.post", side_effect=TimeoutError("slow")) as post, \
                self.assertLogs("modules.event_log", level="WARNING") as logs:
            self.assertTrue(events.emit(events.TOPIC_SELECTED, store=self.store))
            self.assertTrue(events.emit(events.SCRIPT_COMPLETED, store=self.store))
        self.assertEqual(len(self.store.list_events()), 2)
        # One failure turns the live copy off for this process: the next events wait for the nightly mirror, not for Supabase.
        self.assertEqual(post.call_count, 1)
        self.assertTrue(any("live event copy" in m.lower() for m in logs.output))

    def test_a_refused_write_is_a_failure_too(self):
        bad = MagicMock()
        bad.status_code = 401
        bad.text = "invalid key"
        with patch.dict(os.environ, CREDS), patch("modules.supabase_sync.requests.post", return_value=bad) as post:
            self.assertTrue(events.emit(events.TOPIC_SELECTED, store=self.store))
            self.assertTrue(events.emit(events.TOPIC_SELECTED, store=self.store))
        self.assertEqual(post.call_count, 1)

    def test_secrets_are_redacted_before_they_leave_the_runner(self):
        with patch.dict(os.environ, CREDS), patch("modules.supabase_sync.requests.post", return_value=ok_response()) as post:
            events.emit(events.UPLOAD_STARTED, metadata={"access_token": "SECRET123", "topic": "safe"}, store=self.store)
        (sent,) = post.call_args.kwargs["json"]
        self.assertNotIn("SECRET123", json.dumps(sent))
        self.assertEqual(json.loads(sent["metadata"])["access_token"], "[redacted]")

    def test_a_local_write_that_failed_sends_nothing(self):
        broken = MagicMock()
        broken.record_event.side_effect = RuntimeError("disk full")
        with patch.dict(os.environ, CREDS), patch("modules.supabase_sync.requests.post") as post:
            self.assertFalse(events.emit(events.TOPIC_SELECTED, store=broken))
        post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
