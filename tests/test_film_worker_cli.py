"""tools/film_worker.py: the switch, the refusals before anything is claimed, the sweep, and no secret in its output.

What would break, and which test says so:

* the worker running while NIGHTSHIFT_FILM_WORKER is anything but exactly ``on``;
* a worker that claims segments it cannot finish (no key, no adapters, no writable library, no ffmpeg) instead of refusing to start;
* the sweep (film_expire_segments, 0171's switch-on gate: at least every 15 minutes) not running, or configurable past 15 minutes;
* the service key reaching a log line;
* the worker invisible to the operator's "worker lost" alert (gate G4): what it reports to worker_status, and that no key
  or value ever reaches a reported detail.
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


class FakeReporter:
    """Records every worker_status call in order: ("report"|"heartbeat"|"close", state, detail)."""

    def __init__(self):
        self.calls = []
        self.closed = False

    def report(self, state, detail=None):
        self.calls.append(("report", state, detail))
        return True

    def start_heartbeat(self):
        self.calls.append(("heartbeat", "running", None))

    def close(self, state="stopped", detail=None):
        if self.closed:
            return False
        self.closed = True
        self.calls.append(("close", state, detail))
        return True

    def states(self):
        return [state for _what, state, _d in self.calls]


class FakeOrch:
    def __init__(self, db):
        self.db = db

    def run_once(self):
        self.db.calls.append("claim")
        return None


class Harness(unittest.TestCase):
    def env(self, **over):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = {"NIGHTSHIFT_FILM_WORKER": "on", "NIGHTSHIFT_FILM_ASSEMBLY": "on", "SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_KEY": KEY,
                "NIGHTSHIFT_CREATIVE_ADAPTERS": "tests.test_film_worker_cli:resolver", "NIGHTSHIFT_MEDIA_DIR": self.tmp.name}
        base.update(over)
        return {k: v for k, v in base.items() if v is not None}

    def run_main(self, env, assembly=True, argv=None, orch=None, **kw):
        made = []
        self.reporter = FakeReporter()
        self.reporter_args = []

        def make_reporter(url, key, worker_id, env_):
            self.reporter_args.append((url, worker_id))
            return self.reporter

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
            rc = fw.main(argv or ["--once", "--worker-id", "w-test"], env, make_db=make_db, make_reporter=make_reporter,
                         make_orchestrator=orch or (lambda db, *a, **k: FakeOrch(db)), stop=kw.pop("stop", None) or threading.Event(),
                         **kw)
        return rc, made, "\n".join(logs.output)


class Cli(Harness):
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
                         make_reporter=lambda *a: FakeReporter(),
                         make_orchestrator=lambda *a, **k: None, stop=threading.Event())
        self.assertEqual(rc, 2)
        self.assertIn("ffmpeg", "\n".join(logs.output))

    def test_once_sweeps_then_claims_and_prints_no_secret(self):
        rc, made, out = self.run_main(self.env())
        self.assertEqual(rc, 0)
        self.assertEqual(made[0].calls, ["expire", "claim"])
        self.assertNotIn(KEY, out)

    def test_with_the_assembly_switched_off_nothing_is_claimed_and_only_the_sweep_runs(self):
        for value in (None, "", "off", "ON"):
            rc, made, out = self.run_main(self.env(NIGHTSHIFT_FILM_ASSEMBLY=value))
            self.assertEqual(rc, 0, value)
            self.assertEqual(made[0].calls, ["expire"], value)  # never film_claim_segment
            self.assertIn("NIGHTSHIFT_FILM_ASSEMBLY is not 'on'", out)
            self.assertNotIn(KEY, out)

    def test_without_the_assembly_module_nothing_is_claimed(self):
        rc, made, out = self.run_main(self.env(), assembly=False)
        self.assertEqual((rc, made[0].calls), (0, ["expire"]))
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


class WorkerStatus(Harness):
    """What the film worker tells worker_status (0045), so the operator's worker alerts can see it (gate G4)."""

    def test_switched_off_it_reports_stopped_with_the_reason_never_lost(self):
        for value in (None, "off", "ON"):
            rc, made, _out = self.run_main(self.env(NIGHTSHIFT_FILM_WORKER=value))
            self.assertEqual((rc, made), (0, []), value)
            self.assertEqual(self.reporter.calls, [("close", "stopped", "NIGHTSHIFT_FILM_WORKER is not on")], value)

    def test_without_a_service_key_nothing_is_reported_and_no_reporter_is_built(self):
        rc, _made, _out = self.run_main(self.env(SUPABASE_SERVICE_KEY=None))
        self.assertEqual(rc, 2)
        self.assertEqual((self.reporter_args, self.reporter.calls), ([], []))
        rc, _made, _out = self.run_main(self.env(NIGHTSHIFT_FILM_WORKER="off", SUPABASE_URL=None))
        self.assertEqual((rc, self.reporter_args), (0, []))

    def test_a_refusal_to_start_is_reported_failed_with_the_remedy_and_no_value(self):
        for over, word in (({"NIGHTSHIFT_CREATIVE_ADAPTERS": None}, "NIGHTSHIFT_CREATIVE_ADAPTERS is not set"),
                           ({"NIGHTSHIFT_CREATIVE_ADAPTERS": "no_such_module_x9:" + KEY}, "NIGHTSHIFT_CREATIVE_ADAPTERS could not be loaded"),
                           ({"NIGHTSHIFT_MEDIA_DIR": "relative/dir"}, "NIGHTSHIFT_MEDIA_DIR must be"),
                           ({"NIGHTSHIFT_MEDIA_DIR": "/nonexistent-film-dir"}, "NIGHTSHIFT_MEDIA_DIR must be")):
            rc, _made, _out = self.run_main(self.env(**over))
            self.assertEqual(rc, 2, over)
            self.assertEqual(self.reporter.states(), ["starting", "failed"], over)
            detail = self.reporter.calls[-1][2]
            self.assertIn(word, detail)
            # Names, never values: not the key, not the adapter spec, not the directory that was typed.
            for value in (KEY, "no_such_module_x9", "relative/dir", "/nonexistent-film-dir"):
                self.assertNotIn(value, detail, over)

    def test_without_ffmpeg_it_reports_failed_naming_the_tools(self):
        rep = FakeReporter()
        with self.assertLogs("film_worker", level=logging.INFO), \
                mock.patch("modules.media_library.find_tools", return_value=None), \
                mock.patch.object(fw, "assembly_missing", return_value=None):
            rc = fw.main(["--once"], self.env(), make_db=lambda u, k: self.fail("no db without ffmpeg"),
                         make_reporter=lambda *a: rep, make_orchestrator=lambda *a, **k: None, stop=threading.Event())
        self.assertEqual((rc, rep.states()), (2, ["starting", "failed"]))
        self.assertIn("ffmpeg and ffprobe are needed", rep.calls[-1][2])

    def test_with_the_assembly_off_it_reports_failed_and_only_sweeps(self):
        rc, made, _out = self.run_main(self.env(NIGHTSHIFT_FILM_ASSEMBLY="off"))
        self.assertEqual((rc, made[0].calls), (0, ["expire"]))
        self.assertEqual(self.reporter.states(), ["starting", "failed"])
        self.assertIn("NIGHTSHIFT_FILM_ASSEMBLY is not 'on'", self.reporter.calls[-1][2])

    def test_a_once_pass_reports_starting_running_then_stopped(self):
        rc, made, _out = self.run_main(self.env())
        self.assertEqual((rc, made[0].calls), (0, ["expire", "claim"]))
        self.assertEqual(self.reporter.states(), ["starting", "running", "stopped"])
        self.assertEqual(self.reporter_args, [("https://x.supabase.co", "w-test")])

    def test_the_loop_beats_then_reports_stopped_when_told_to_stop(self):
        stop = threading.Event()

        class Orch:
            def __init__(self, db):
                self.db = db

            def run_once(self):
                self.db.calls.append("claim")
                stop.set()
                return None

        rc, _made, _out = self.run_main(self.env(), argv=["--worker-id", "w-loop"], orch=lambda db, *a, **k: Orch(db), stop=stop)
        self.assertEqual(rc, 0)
        self.assertEqual(self.reporter.calls[0][:2], ("report", "starting"))
        self.assertEqual([c[0] for c in self.reporter.calls[1:]], ["heartbeat", "close"])
        self.assertEqual(self.reporter.calls[-1][:2], ("close", "stopped"))

    def test_a_worker_that_dies_on_an_error_reads_failed_not_stopped(self):
        class Boom(Exception):
            pass

        def explode(db):
            raise Boom("token " + KEY)

        with mock.patch.object(fw, "sweep_once", side_effect=explode):
            with self.assertRaises(Boom):
                self.run_main(self.env())
        self.assertEqual(self.reporter.states(), ["starting", "running", "failed"])
        self.assertIn("(Boom)", self.reporter.calls[-1][2])
        self.assertNotIn(KEY, self.reporter.calls[-1][2])

    def test_the_status_id_is_film_prefixed_once_and_fits(self):
        self.assertEqual(fw.status_id("host-12"), "film-host-12")
        self.assertEqual(fw.status_id("film-host-12"), "film-host-12")
        self.assertEqual(len(fw.status_id("h" * 200)), 64)

    def test_the_real_reporter_is_kind_other_and_scrubs_the_key_out_of_a_detail(self):
        sent = []

        class Session:
            def post(self, url, json=None, headers=None, timeout=None):
                sent.append(json)
                return mock.Mock(status_code=204)

        env = self.env()
        rep = fw.default_reporter("https://x.supabase.co", KEY, "host-7", env)
        rep._http = Session()
        rep.report("starting")
        rep.close("failed", f"something echoed {KEY} back")
        self.assertEqual([(b["p_worker_id"], b["p_kind"], b["p_state"]) for b in sent],
                         [("film-host-7", "other", "starting"), ("film-host-7", "other", "failed")])
        self.assertNotIn(KEY, str(sent))
        self.assertNotIn(KEY[-12:], str(sent))


def resolver(model_id):
    return None


if __name__ == "__main__":
    unittest.main()
