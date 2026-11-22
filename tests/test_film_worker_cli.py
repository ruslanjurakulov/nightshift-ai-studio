"""tools/film_worker.py: the switch, the refusals before anything is claimed, the sweep, and no secret in its output.

What would break, and which test says so:

* the worker running while NIGHTSHIFT_FILM_WORKER is anything but exactly ``on``;
* a worker that claims segments it cannot finish (no key, no adapters, no writable library, no ffmpeg) instead of refusing to start;
* the sweep (film_expire_segments, 0171's switch-on gate: at least every 15 minutes) not running, or configurable past 15 minutes;
* the sweep not recorded (0212's film_sweep('worker')), or stopping where 0212 is not applied yet instead of calling the same
  0171 function directly, or saying so on every pass;
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

    def sweep(self, runner):
        self.calls.append(f"sweep:{runner}")
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
        base = {"NIGHTSHIFT_FILM_WORKER": "on", "NIGHTSHIFT_FILM_ASSEMBLY": "on", "SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_KEY": KEY,
                "NIGHTSHIFT_CREATIVE_ADAPTERS": "tests.test_film_worker_cli:resolver", "NIGHTSHIFT_MEDIA_DIR": self.tmp.name}
        base.update(over)
        return {k: v for k, v in base.items() if v is not None}

    def run_main(self, env, assembly=True, **kw):
        made = []

        def make_db(url, key):
            db = FakeDb()
            made.append(db)
            return db

        real_import = fw.importlib.import_module

        def imp(name, *a, **k):
            if name == "modules.film_assembly":
                if not assembly:
                    raise ModuleNotFoundError("No module named 'modules.film_assembly'", name="modules.film_assembly")
                return object()
            return real_import(name, *a, **k)

        with self.assertLogs("film_worker", level=logging.INFO) as logs, \
                mock.patch("modules.media_library.find_tools", return_value=object()), \
                mock.patch.object(fw.importlib, "import_module", side_effect=imp):
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
                mock.patch("modules.media_library.find_tools", return_value=None), \
                mock.patch.object(fw, "assembly_missing", return_value=None):
            rc = fw.main(["--once"], self.env(), make_db=lambda u, k: self.fail("no db without ffmpeg"),
                         make_orchestrator=lambda *a, **k: None, stop=threading.Event())
        self.assertEqual(rc, 2)
        self.assertIn("ffmpeg", "\n".join(logs.output))

    def test_once_sweeps_then_claims_and_prints_no_secret(self):
        rc, made, out = self.run_main(self.env())
        self.assertEqual(rc, 0)
        self.assertEqual(made[0].calls, ["sweep:worker", "claim"])
        self.assertNotIn(KEY, out)

    def test_with_the_assembly_switched_off_nothing_is_claimed_and_only_the_sweep_runs(self):
        for value in (None, "", "off", "ON"):
            rc, made, out = self.run_main(self.env(NIGHTSHIFT_FILM_ASSEMBLY=value))
            self.assertEqual(rc, 0, value)
            self.assertEqual(made[0].calls, ["sweep:worker"], value)  # never film_claim_segment
            self.assertIn("NIGHTSHIFT_FILM_ASSEMBLY is not 'on'", out)
            self.assertNotIn(KEY, out)

    def test_without_the_assembly_module_nothing_is_claimed(self):
        rc, made, out = self.run_main(self.env(), assembly=False)
        self.assertEqual((rc, made[0].calls), (0, ["sweep:worker"]))
        self.assertIn("modules.film_assembly is not installed", out)

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


class Sweep(unittest.TestCase):
    """sweep_once: 0212's recorded sweep first; 0171's function directly only while 0212 is missing; a failure is a warning."""

    def setUp(self):
        fw._SWEEP_UNRECORDED.clear()
        self.addCleanup(fw._SWEEP_UNRECORDED.clear)

    def test_the_worker_sweeps_through_film_sweep_under_its_own_runner(self):
        db = FakeDb()
        with self.assertLogs("film_worker", level=logging.INFO) as logs:
            db.sweep = lambda runner: (db.calls.append(f"sweep:{runner}"), 2)[1]
            fw.sweep_once(db)
        self.assertEqual(db.calls, ["sweep:worker"])  # never expire() as well: one sweep, recorded
        self.assertIn("settled or drained 2", "\n".join(logs.output))

    def test_without_0212_it_calls_the_same_0171_function_and_says_so_once(self):
        db = FakeDb()

        def missing(runner):
            db.calls.append(f"sweep:{runner}")
            raise fw.fo.FilmFunctionMissing("film_sweep: HTTP 404 (migration 0212_film_sweep.sql is not applied)")

        db.sweep = missing
        with self.assertLogs("film_worker", level=logging.INFO) as logs:
            fw.sweep_once(db)
            fw.sweep_once(db)
        self.assertEqual(db.calls, ["sweep:worker", "expire", "sweep:worker", "expire"])  # tried again each pass, swept each pass
        said = [ln for ln in logs.output if "0212_film_sweep.sql" in ln]
        self.assertEqual(len(said), 1, logs.output)
        self.assertIn("not recorded", said[0])

    def test_a_sweep_that_failed_in_the_database_is_a_warning_and_not_a_second_unrecorded_sweep(self):
        db = FakeDb()

        def failed(runner):
            db.calls.append(f"sweep:{runner}")
            raise fw.fo.FilmUnavailable("film_sweep: the sweep failed (55P03)")

        db.sweep = failed
        with self.assertLogs("film_worker", level=logging.WARNING) as logs:
            fw.sweep_once(db)
        self.assertEqual(db.calls, ["sweep:worker"])
        self.assertIn("55P03", "\n".join(logs.output))

    def test_a_crash_inside_the_sweep_never_reaches_the_claim_loop(self):
        db = FakeDb()
        db.sweep = lambda runner: (_ for _ in ()).throw(ValueError(KEY))
        with self.assertLogs("film_worker", level=logging.WARNING) as logs:
            fw.sweep_once(db)  # does not raise
        self.assertNotIn(KEY, "\n".join(logs.output))


def resolver(model_id):
    return None


if __name__ == "__main__":
    unittest.main()
