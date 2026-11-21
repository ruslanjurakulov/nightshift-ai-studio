"""emit() also sends each event to Supabase's system_events at once (the Studio's live view reads it there).

What would break without these: a run that fails because Supabase is slow or down, a run that waits on Supabase for every event
after a failure, an event lost for good after one blip on the long-lived queue worker, an event key that differs from the
nightly mirror's (the same event twice in system_events), a secret or the Supabase host in a log, a sync that starts where
nothing asked for it, and above all a slot-evidence event (system.started, render.completed, ...) arriving early enough to
make the dead-man switch and the catch-up think a crashed run worked its slot.
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
            self.assertTrue(events.emit(events.UPLOAD_STARTED, agent="youtube_uploader", status="started",
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
        self.assertEqual(post.call_args.kwargs["timeout"], (2.0, 2.0))

    def test_a_failing_sync_still_returns_true_keeps_the_local_row_and_pauses(self):
        with patch.dict(os.environ, CREDS), patch("modules.supabase_sync.requests.post", side_effect=TimeoutError("slow")) as post, \
                self.assertLogs("modules.event_log", level="WARNING") as logs:
            self.assertTrue(events.emit(events.TOPIC_SELECTED, store=self.store))
            self.assertTrue(events.emit(events.SCRIPT_COMPLETED, store=self.store))
        self.assertEqual(len(self.store.list_events()), 2)
        # One failure pauses the copy: the next event does not wait on Supabase.
        self.assertEqual(post.call_count, 1)
        self.assertTrue(any("live event copy" in m.lower() for m in logs.output))

    def test_after_the_pause_it_sends_what_it_missed_so_the_queue_worker_loses_nothing_to_a_blip(self):
        clock = [1000.0]
        with patch.dict(os.environ, CREDS), patch("modules.event_log.time.monotonic", lambda: clock[0]), \
                patch("modules.supabase_sync.requests.post", side_effect=[TimeoutError("blip"), ok_response()]) as post:
            events.emit(events.TOPIC_SELECTED, store=self.store)       # fails: pause
            events.emit(events.SCRIPT_STARTED, store=self.store)       # inside the pause: kept back
            clock[0] += events._LIVE_PAUSE_S + 1
            events.emit(events.SCRIPT_COMPLETED, store=self.store)     # sends itself and both missed events
        self.assertEqual(post.call_count, 2)
        sent = post.call_args.kwargs["json"]
        self.assertEqual(sorted(r["event"] for r in sent), ["script.completed", "script.started", "topic.selected"])
        mirrored = {SupabaseSync._event_row(r)["event_key"] for r in self.store.list_events()}
        self.assertEqual({r["event_key"] for r in sent}, mirrored)

    def test_slot_evidence_events_are_never_copied_live_even_in_a_catch_up(self):
        from modules.operator_bot.sources import RUN_EVENTS

        self.assertEqual(events._evidence_events(), frozenset(RUN_EVENTS))
        clock = [1000.0]
        with patch.dict(os.environ, CREDS), patch("modules.event_log.time.monotonic", lambda: clock[0]), \
                patch("modules.supabase_sync.requests.post", side_effect=[TimeoutError("blip"), ok_response()]) as post:
            for name in RUN_EVENTS:
                self.assertTrue(events.emit(name, channel_id="ch1", store=self.store))
            post.assert_not_called()
            events.emit(events.TOPIC_SELECTED, store=self.store)       # fails: pause
            events.emit(events.SYSTEM_STARTED, channel_id="ch1", store=self.store)
            clock[0] += events._LIVE_PAUSE_S + 1
            events.emit(events.SCRIPT_COMPLETED, store=self.store)
        sent = post.call_args.kwargs["json"]
        self.assertFalse({r["event"] for r in sent} & set(RUN_EVENTS))
        self.assertEqual(len(self.store.list_events()), len(RUN_EVENTS) + 3)

    def test_the_default_store_path_sends_too(self):
        db = Path(self._tmp.name) / "own.db"
        with patch.dict(os.environ, {**CREDS, "CHRONOS_STATE_DB": str(db)}), \
                patch("modules.supabase_sync.requests.post", return_value=ok_response()) as post:
            self.assertTrue(events.emit(events.TOPIC_SELECTED, channel_id="ch1"))
        (sent,) = post.call_args.kwargs["json"]
        self.assertEqual(sent["event"], "topic.selected")

    def test_a_test_double_store_or_a_missing_row_sends_nothing(self):
        double = MagicMock()
        with patch.dict(os.environ, CREDS), patch("modules.supabase_sync.requests.post") as post:
            self.assertTrue(events.emit(events.TOPIC_SELECTED, store=double))
            events._live_copy(self.store, 999999)
        post.assert_not_called()

    def test_without_credentials_the_client_is_built_once_and_nothing_is_sent(self):
        with patch("modules.supabase_sync.SupabaseSync.__init__", autospec=True, side_effect=lambda self, *a, **k: setattr(self, "enabled", False)) as init, \
                patch("modules.supabase_sync.requests.post") as post:
            events.emit(events.TOPIC_SELECTED, store=self.store)
            events.emit(events.SCRIPT_COMPLETED, store=self.store)
        self.assertEqual(init.call_count, 1)
        post.assert_not_called()

    def test_every_off_word_switches_it_off(self):
        for word in ("off", "0", "false", "no", "OFF"):
            events._reset_live_sync()
            with patch.dict(os.environ, {**CREDS, "NIGHTSHIFT_LIVE_EVENTS": word}), patch("modules.supabase_sync.requests.post") as post:
                events.emit(events.TOPIC_SELECTED, store=self.store)
            post.assert_not_called()

    def test_a_failure_logs_the_status_and_code_only_never_the_body_or_the_host(self):
        bad = MagicMock()
        bad.status_code = 500
        bad.text = "upstream https://secret-project.supabase.co said no"
        bad.json.return_value = {"code": "XX000", "message": "https://secret-project.supabase.co"}
        with patch.dict(os.environ, CREDS), patch("modules.supabase_sync.requests.post", return_value=bad), \
                self.assertLogs(level="WARNING") as logs:
            events.emit(events.TOPIC_SELECTED, store=self.store)
        text = "\n".join(logs.output)
        self.assertNotIn("secret-project", text)
        self.assertIn("500", text)

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
