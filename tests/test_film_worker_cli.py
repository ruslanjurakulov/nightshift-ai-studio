"""tools/film_worker.py: the switch, the refusals before anything is claimed, the sweep, and no secret in its output.

What would break, and which test says so:

* the worker running while NIGHTSHIFT_FILM_WORKER is anything but exactly ``on``;
* a worker that claims segments it cannot finish (no key, no adapters, no writable library, no ffmpeg) instead of refusing to start;
* the sweep (film_expire_segments, 0171's switch-on gate: at least every 15 minutes) not running, or configurable past 15 minutes;
* the service key reaching a log line.
"""

from __future__ import annotations

import logging
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from tools import film_worker as fw

KEY = "service-key-SECRET-abcdef0123456789"


class FakeDb:
    def __init__(self):
        self.calls = []

    def expire(self):
        self.calls.append("expire")
        return 0


class FakeOrch:
    def __init__(self, db):
        self.db = db

    def run_once(self):
        self.db.calls.append("claim")
        return None


class Cli(unittest.TestCase):
    def env(self, **over):
        self.tmp = tempfile.TemporaryDirectory()
        base = {"NIGHTSHIFT_FILM_WORKER": "on", "SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_KEY": KEY,
                "NIGHTSHIFT_CREATIVE_ADAPTERS": "tests.test_film_worker_cli:resolver", "NIGHTSHIFT_MEDIA_DIR": self.tmp.name}
        base.update(over)
        return {k: v for k, v in base.items() if v is not None}

    def run_main(self, env, **kw):
        made = []

        def make_db(url, key):
            db = FakeDb()
            made.append(db)
            return db

        with self.assertLogs("film_worker", level=logging.INFO) as logs, \
                mock.patch("modules.media_library.find_tools", return_value=object()):
            rc = fw.main(["--once", "--worker-id", "w-test"], env, make_db=make_db,
                         make_orchestrator=lambda db, *a, **k: FakeOrch(db), stop=threading.Event(), **kw)
        return rc, made, "\n".join(logs.output)

    def test_off_unless_exactly_on(self):
        for value in (None, "", "off", "ON", "true", "1", "yes"):
            rc, made, out = self.run_main(self.env(NIGHTSHIFT_FILM_WORKER=value))
            self.assertEqual((rc, made), (0, []), value)
            self.assertIn("claims nothing", out)

    def test_it_refuses_to_start_without_what_a_take_needs(self):
        for over, word in (({"SUPABASE_SERVICE_KEY": None}, "SUPABASE_SERVICE_KEY"),
                           ({"NIGHTSHIFT_CREATIVE_ADAPTERS": None}, "no provider adapters"),
                           ({"NIGHTSHIFT_MEDIA_DIR": "relative/dir"}, "NIGHTSHIFT_MEDIA_DIR"),
                           ({"NIGHTSHIFT_MEDIA_DIR": "/nonexistent-film-dir"}, "NIGHTSHIFT_MEDIA_DIR")):
            rc, made, out = self.run_main(self.env(**over))
            self.assertEqual((rc, made), (2, []), over)
            self.assertIn(word, out)
            self.assertNotIn(KEY, out)

    def test_without_ffmpeg_nothing_is_claimed(self):
        with self.assertLogs("film_worker", level=logging.INFO) as logs, \
                mock.patch("modules.media_library.find_tools", return_value=None):
            rc = fw.main(["--once"], self.env(), make_db=lambda u, k: self.fail("no db without ffmpeg"),
                         make_orchestrator=lambda *a, **k: None, stop=threading.Event())
        self.assertEqual(rc, 2)
        self.assertIn("ffmpeg", "\n".join(logs.output))

    def test_once_sweeps_then_claims_and_prints_no_secret(self):
        rc, made, out = self.run_main(self.env())
        self.assertEqual(rc, 0)
        self.assertEqual(made[0].calls, ["expire", "claim"])
        self.assertNotIn(KEY, out)

    def test_the_sweep_runs_at_least_every_fifteen_minutes(self):
        self.assertEqual(fw.expire_every({}), 300)
        self.assertEqual(fw.expire_every({"FILM_EXPIRE_EVERY_SECONDS": "86400"}), 900)
        self.assertEqual(fw.expire_every({"FILM_EXPIRE_EVERY_SECONDS": "1"}), 30)

    def test_the_loop_backs_off_when_idle_and_stops_on_its_event(self):
        db, stop = FakeDb(), threading.Event()
        waits = []

        class Orch:
            def run_once(self):
                db.calls.append("claim")
                if len(db.calls) >= 3:
                    stop.set()
                return None

        real_wait = stop.wait
        stop.wait = lambda t=None: (waits.append(t), real_wait(0))[1]
        fw.loop(Orch(), db, stop, once=False)
        self.assertEqual(waits[:2], [fw.IDLE_MIN_SECONDS, fw.IDLE_MIN_SECONDS * 2])


def resolver(model_id):
    return None


if __name__ == "__main__":
    unittest.main()
