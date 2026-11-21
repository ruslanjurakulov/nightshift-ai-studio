"""Worker status reporting (migration 0045): modules/worker_status.py and the
media worker's use of it.

What is pinned: every ``return 2`` path of tools/media_worker.py reports
'failed' WITH the remedy before exiting; the remedy names variables and never
their values; a report that cannot be sent never crashes or blocks the worker;
the heartbeat keeps going and a clean stop reports 'stopped' last; detail is
scrubbed and then cut to 300 characters; nothing a failed request raised (it
quotes the Supabase URL) reaches a log line."""

from __future__ import annotations

import logging
import os
import signal
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from modules import worker_status as ws
from tools import media_worker

# Obviously fake values: the tests prove they are never repeated.
FAKE_URL = "https://fake-project.example.test"
FAKE_KEY = "fake-service-key-for-tests-0123456789"


class Resp:
    def __init__(self, status=204):
        self.status_code = status


class FakeSession:
    def __init__(self, status=204, raises=None):
        self.status = status
        self.raises = raises
        self.calls = []
        self.lock = threading.Lock()

    def post(self, url, json=None, headers=None, timeout=None):
        with self.lock:
            self.calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        if self.raises:
            raise self.raises
        return Resp(self.status)

    def states(self):
        with self.lock:
            return [c["json"]["p_state"] for c in self.calls]


def reporter(session, **kw):
    return ws.WorkerStatusReporter(FAKE_URL, FAKE_KEY, worker_id="w-1", kind="media", session=session, **kw)


class Reporter(unittest.TestCase):
    def test_report_calls_the_rpc_with_the_service_key(self):
        s = FakeSession()
        self.assertTrue(reporter(s, version="build-7").report("running"))
        c = s.calls[0]
        self.assertEqual(c["url"], f"{FAKE_URL}/rest/v1/rpc/report_worker_status")
        self.assertEqual(c["json"], {"p_worker_id": "w-1", "p_kind": "media", "p_state": "running",
                                     "p_detail": None, "p_version": "build-7"})
        self.assertEqual(c["headers"]["apikey"], FAKE_KEY)
        self.assertLessEqual(c["timeout"], 10)  # never blocks the worker for long

    def test_detail_is_scrubbed_before_it_is_cut_to_300(self):
        secret = "s3cr3t-value-" + "x" * 40
        s = FakeSession()
        # The secret straddles the 300 character cut: scrub-then-cut leaves none of it.
        text = "a" * 290 + secret
        r = reporter(s, scrub=lambda t: t.replace(secret, "[redacted]"))
        r.report("failed", text)
        sent = s.calls[0]["json"]["p_detail"]
        self.assertEqual(len(sent), 300)
        self.assertNotIn("s3cr3t", sent)
        self.assertTrue(sent.startswith("a" * 290))

    def test_detail_is_one_line_and_empty_is_none(self):
        self.assertEqual(ws.clean_detail("one\n two\t\tthree"), "one two three")
        self.assertIsNone(ws.clean_detail(""))
        self.assertIsNone(ws.clean_detail("   \n "))
        self.assertIsNone(ws.clean_detail(None))
        self.assertEqual(len(ws.clean_detail("é" * 1000)), 300)

    def test_a_failing_scrubber_withholds_the_detail(self):
        def boom(_):
            raise RuntimeError("no scrubber")

        self.assertEqual(ws.clean_detail("anything", boom), "detail withheld: the scrubber failed")

    def test_report_never_raises(self):
        for s in (FakeSession(raises=ConnectionError(f"boom {FAKE_URL}")), FakeSession(status=500),
                  FakeSession(status=404), FakeSession(status=401)):
            self.assertFalse(reporter(s).report("running"))
        # A scrubber or session factory that explodes is contained too.
        r = ws.WorkerStatusReporter(FAKE_URL, FAKE_KEY, worker_id="w", kind="media", session=None)
        with mock.patch.dict("sys.modules", {"requests": None}):
            self.assertFalse(r.report("running"))

    def test_a_failed_report_logs_the_type_never_the_message_or_url(self):
        s = FakeSession(raises=ConnectionError(f"HTTPSConnectionPool(host='{FAKE_URL}') {FAKE_KEY}"))
        with self.assertLogs("modules.worker_status", level="WARNING") as cm:
            reporter(s).report("running")
        out = "\n".join(cm.output)
        self.assertIn("ConnectionError", out)
        self.assertNotIn(FAKE_URL, out)
        self.assertNotIn(FAKE_KEY, out)

    def test_a_missing_migration_is_said_once_not_every_beat(self):
        s = FakeSession(status=404)
        r = reporter(s)
        with self.assertLogs("modules.worker_status", level="WARNING") as cm:
            for _ in range(5):
                r.report("running")
        self.assertEqual(len(cm.output), 1)
        self.assertIn("0045", cm.output[0])

    def test_heartbeat_repeats_while_idle_and_close_reports_last(self):
        s = FakeSession()
        r = reporter(s, interval=0.01)
        r.start_heartbeat()
        deadline = time.time() + 5
        while len([x for x in s.states() if x == "running"]) < 3 and time.time() < deadline:
            time.sleep(0.01)
        self.assertGreaterEqual(len([x for x in s.states() if x == "running"]), 3)
        self.assertTrue(r.close("stopped"))
        states = s.states()
        self.assertEqual(states[-1], "stopped")
        n = len(states)
        time.sleep(0.1)
        self.assertEqual(len(s.states()), n, "the heartbeat must stop after close()")
        self.assertFalse(r.close("stopped"), "close() is idempotent")

    def test_the_heartbeat_does_not_wait_for_a_slow_report(self):
        class Slow(FakeSession):
            def post(self, *a, **k):
                time.sleep(0.2)
                return super().post(*a, **k)

        r = reporter(Slow(), interval=60)
        t0 = time.time()
        r.start_heartbeat()
        self.assertLess(time.time() - t0, 0.15, "start_heartbeat returns at once")
        r.close("stopped")


class FakeReporter:
    """Stands in for WorkerStatusReporter; records what main() asks of it."""

    instances = []

    def __init__(self, url, key, *, worker_id, kind, version=None, scrub=None, **_):
        self.worker_id, self.kind, self.version, self.scrub = worker_id, kind, version, scrub
        self.events = []
        self.heartbeat = False
        FakeReporter.instances.append(self)

    def report(self, state, detail=None):
        self.events.append((state, detail))
        return True

    def start_heartbeat(self):
        self.heartbeat = True
        self.events.append(("heartbeat", None))

    def close(self, state="stopped", detail=None):
        self.events.append((state, detail))
        return True


class MediaWorkerExitPaths(unittest.TestCase):
    def setUp(self):
        FakeReporter.instances = []
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.media = Path(self.tmp.name) / "media"
        self.staging = Path(self.tmp.name) / "staging"
        self.media.mkdir()
        self.staging.mkdir()
        self.env = {"SUPABASE_URL": FAKE_URL, "SUPABASE_SERVICE_KEY": FAKE_KEY,
                    "NIGHTSHIFT_MEDIA_DIR": str(self.media), "NIGHTSHIFT_MEDIA_STAGING_DIR": str(self.staging)}
        p = mock.patch.object(media_worker, "WorkerStatusReporter", FakeReporter)
        p.start()
        self.addCleanup(p.stop)

    def run_main(self, env, argv=(), tools="ok"):
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(media_worker.media_library, "find_tools",
                                  return_value=None if tools is None else object()), \
                self.assertLogs("media_worker", level="INFO") as logs:
            code = media_worker.main(["--worker-id", "w-test", *argv])
        return code, logs.output

    def only(self):
        self.assertEqual(len(FakeReporter.instances), 1)
        return FakeReporter.instances[0]

    def assert_failed_with(self, rep, *needles):
        self.assertEqual(rep.events[0], ("starting", None), "'starting' is reported first")
        state, detail = rep.events[-1]
        self.assertEqual(state, "failed")
        for n in needles:
            self.assertIn(n, detail)
        self.assertNotIn("running", [e[0] for e in rep.events])
        return detail

    def test_missing_url_or_key_can_only_log(self):
        for drop in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
            env = {k: v for k, v in self.env.items() if k != drop}
            code, out = self.run_main(env)
            self.assertEqual(code, 2)
            self.assertIn("SUPABASE_URL and SUPABASE_SERVICE_KEY", "\n".join(out))
            self.assertEqual(FakeReporter.instances, [], "no URL/key, nowhere to report")

    def test_volume_variables_missing_or_relative_report_failed_with_the_remedy(self):
        for patch in ({"NIGHTSHIFT_MEDIA_DIR": ""}, {"NIGHTSHIFT_MEDIA_STAGING_DIR": "relative/dir"}):
            FakeReporter.instances = []
            code, out = self.run_main({**self.env, **patch})
            self.assertEqual(code, 2)
            detail = self.assert_failed_with(self.only(), "NIGHTSHIFT_MEDIA_DIR", "NIGHTSHIFT_MEDIA_STAGING_DIR",
                                             "absolute paths")
            self.assertIn(detail, "\n".join(out))  # the log says the same words

    def test_an_unwritable_volume_names_the_variable_and_never_the_path(self):
        missing = "/nonexistent-volume-path-for-tests/media"
        code, out = self.run_main({**self.env, "NIGHTSHIFT_MEDIA_DIR": missing})
        self.assertEqual(code, 2)
        detail = self.assert_failed_with(self.only(), "NIGHTSHIFT_MEDIA_DIR is not a writable directory", "chown")
        self.assertNotIn(missing, detail)
        self.assertNotIn(str(self.staging), detail)
        code, _ = self.run_main({**self.env, "NIGHTSHIFT_MEDIA_STAGING_DIR": missing})
        self.assertEqual(code, 2)
        self.assertIn("NIGHTSHIFT_MEDIA_STAGING_DIR is not a writable directory", FakeReporter.instances[-1].events[-1][1])

    def test_missing_ffmpeg_reports_failed_with_the_remedy(self):
        code, _ = self.run_main(self.env, tools=None)
        self.assertEqual(code, 2)
        self.assert_failed_with(self.only(), "ffmpeg and ffprobe are required", "Dockerfile.worker")

    def test_the_detail_carries_no_env_value(self):
        # Every failing path, with values that must never appear in what is sent.
        cases = [
            ({**self.env, "NIGHTSHIFT_MEDIA_DIR": ""}, "ok"),
            ({**self.env, "NIGHTSHIFT_MEDIA_DIR": "/nonexistent-volume-path-for-tests/media"}, "ok"),
            (self.env, None),
        ]
        for env, tools in cases:
            FakeReporter.instances = []
            self.run_main(env, tools=tools)
            sent = " ".join(str(d) for _, d in self.only().events)
            for value in (FAKE_URL, FAKE_KEY, str(self.media), str(self.staging),
                          "/nonexistent-volume-path-for-tests"):
                self.assertNotIn(value, sent)

    def test_the_reporter_gets_the_pipeline_scrubber(self):
        rep_env = {**self.env, "NIGHTSHIFT_MEDIA_DIR": ""}
        self.run_main(rep_env)
        scrub = self.only().scrub
        self.assertTrue(callable(scrub))
        # The pipeline worker's scrubber: secret-named env values are replaced.
        out = scrub(f"oops {FAKE_KEY} oops")
        self.assertNotIn(FAKE_KEY, out)

    def test_the_heic_warning_path_is_not_a_failure_and_changes_no_report(self):
        # pillow-heif missing: a startup warning only; present: silence. Either way the
        # worker boots, heartbeats and stops cleanly (0044 and 0045 together).
        for available in (False, True):
            FakeReporter.instances = []
            handlers = {}

            class Service:
                def __init__(self, *a, **k):
                    self.calls = 0

                def run_once(self):
                    self.calls += 1
                    if self.calls == 2:
                        handlers[signal.SIGTERM](signal.SIGTERM, None)
                    return False

            with mock.patch.object(media_worker.media_library, "heic_available", return_value=available), \
                    mock.patch.object(media_worker.media_library, "MediaService", Service), \
                    mock.patch.object(media_worker.signal, "signal", lambda n, h: handlers.__setitem__(n, h)):
                code, out = self.run_main(self.env, argv=["--poll-seconds", "0.01"])
            self.assertEqual(code, 0)
            self.assertEqual("pillow-heif is not installed" in "\n".join(out), not available)
            self.assertEqual([e[0] for e in FakeReporter.instances[0].events], ["starting", "heartbeat", "stopped"])

    def test_without_the_scrubber_the_detail_is_withheld_not_sent_raw(self):
        with mock.patch.object(media_worker, "make_scrubber", return_value=None):
            self.run_main({**self.env, "NIGHTSHIFT_MEDIA_DIR": ""})
        scrub = self.only().scrub
        self.assertEqual(ws.clean_detail("anything", scrub), "detail withheld: the scrubber failed")

    def test_a_report_error_does_not_crash_or_change_the_exit_code(self):
        broken = FakeSession(raises=ConnectionError(FAKE_URL))
        with mock.patch.object(media_worker, "WorkerStatusReporter",
                               lambda *a, **k: ws.WorkerStatusReporter(*a, session=broken, **k)):
            code, _ = self.run_main(self.env, tools=None)
        self.assertEqual(code, 2)
        self.assertEqual(broken.states(), ["starting", "failed"])

    def test_a_report_error_does_not_stop_the_loop(self):
        broken = FakeSession(raises=TimeoutError())
        handlers = {}

        class Service:
            def __init__(self, *a, **k):
                self.calls = 0

            def run_once(self):
                self.calls += 1
                if self.calls == 2:
                    handlers[signal.SIGTERM](signal.SIGTERM, None)
                return False

        with mock.patch.object(media_worker, "WorkerStatusReporter",
                               lambda *a, **k: ws.WorkerStatusReporter(*a, session=broken, interval=0.01, **k)), \
                mock.patch.object(media_worker.media_library, "MediaService", Service), \
                mock.patch.object(media_worker.signal, "signal", lambda n, h: handlers.__setitem__(n, h)):
            code, _ = self.run_main(self.env, argv=["--poll-seconds", "0.01"])
        self.assertEqual(code, 0)
        self.assertEqual(broken.states()[0], "starting")
        self.assertEqual(broken.states()[-1], "stopped")

    def test_boot_heartbeat_and_clean_sigterm(self):
        handlers = {}

        class Service:
            def __init__(self, *a, **k):
                self.calls = 0

            def run_once(self):
                self.calls += 1
                if self.calls == 2:
                    handlers[signal.SIGTERM](signal.SIGTERM, None)
                return False

        with mock.patch.object(media_worker.media_library, "MediaService", Service), \
                mock.patch.object(media_worker.signal, "signal", lambda n, h: handlers.__setitem__(n, h)):
            code, _ = self.run_main(self.env, argv=["--poll-seconds", "0.01"])
        self.assertEqual(code, 0)
        rep = self.only()
        self.assertEqual([e[0] for e in rep.events], ["starting", "heartbeat", "stopped"])
        self.assertTrue(rep.heartbeat)
        self.assertEqual(rep.kind, "media")
        self.assertEqual(rep.worker_id, "w-test")

    def test_a_crash_is_not_reported_as_a_clean_stop(self):
        class Service:
            def __init__(self, *a, **k):
                pass

            def run_once(self):
                raise RuntimeError(f"secret in the message {FAKE_KEY}")

        with mock.patch.object(media_worker.media_library, "MediaService", Service), \
                mock.patch.object(media_worker.signal, "signal", lambda n, h: None):
            with self.assertRaises(RuntimeError):
                self.run_main(self.env)
        state, detail = self.only().events[-1]
        self.assertEqual(state, "failed")
        self.assertIn("RuntimeError", detail)
        self.assertNotIn(FAKE_KEY, detail)

    def test_once_is_a_diagnostic_run_and_reports_nothing(self):
        class Service:
            def __init__(self, *a, **k):
                pass

            def run_once(self):
                return True

        with mock.patch.object(media_worker.media_library, "MediaService", Service), \
                mock.patch.object(media_worker.signal, "signal", lambda n, h: None):
            code, _ = self.run_main(self.env, argv=["--once"])
        self.assertEqual(code, 0)
        self.assertEqual(FakeReporter.instances, [])
        code, _ = self.run_main(self.env, argv=["--once"], tools=None)
        self.assertEqual(code, 2)
        self.assertEqual(FakeReporter.instances, [])

    def test_every_return_2_in_main_goes_through_fail_or_is_the_url_check(self):
        # A new exit-2 path added later without a report would be caught here.
        src = Path(media_worker.__file__).read_text()
        body = src.split("def main(", 1)[1]
        returns = [ln.strip() for ln in body.splitlines() if ln.strip().startswith("return 2")]
        self.assertEqual(returns, ["return 2", "return 2"], returns)  # the URL/key check, and fail() itself
        self.assertEqual(body.count("return fail("), 3)  # env paths, volumes, ffmpeg

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    unittest.main()


class ProbeTest(unittest.TestCase):
    """`media_worker.py --probe`: one line of words and numbers for the deploy
    log. The log is public, so no value, path or message may ever be in it."""

    def run_probe(self, env, status="204"):
        import contextlib
        import io

        class Reporter:
            def __init__(self, *a, **k):
                self.last_status = None

            def report(self, state, detail=None):
                self.last_status = status
                return True

        out = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(media_worker, "WorkerStatusReporter", Reporter), \
                mock.patch.object(media_worker, "make_scrubber", return_value=None), \
                mock.patch.object(media_worker.media_library, "find_tools", return_value=("ffmpeg", "ffprobe")), \
                mock.patch.object(media_worker.media_library, "heic_available", return_value=True), \
                contextlib.redirect_stdout(out):
            code = media_worker.main(["--probe"])
        return code, out.getvalue()

    def test_a_healthy_setup_prints_yes_answers_and_the_http_status(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            code, text = self.run_probe({"SUPABASE_URL": FAKE_URL, "SUPABASE_SERVICE_KEY": FAKE_KEY,
                                         "NIGHTSHIFT_MEDIA_DIR": a, "NIGHTSHIFT_MEDIA_STAGING_DIR": b})
        self.assertEqual(code, 0)
        self.assertTrue(text.startswith("probe: "), text)
        for part in ("url_set=true", "key_set=true", "media_dir=writable", "staging_dir=writable",
                     "ffmpeg=true", "heic=true", "report=204"):
            self.assertIn(part, text)
        self.assertEqual(len(text.strip().splitlines()), 1)

    def test_every_problem_is_a_word_and_no_value_or_path_is_printed(self):
        with tempfile.TemporaryDirectory() as a:
            code, text = self.run_probe({"SUPABASE_URL": FAKE_URL, "SUPABASE_SERVICE_KEY": FAKE_KEY,
                                         "NIGHTSHIFT_MEDIA_DIR": a + "/missing",
                                         "NIGHTSHIFT_MEDIA_STAGING_DIR": "relative/path"}, status="401")
            self.assertEqual(code, 0)
            self.assertIn("media_dir=missing", text)
            self.assertIn("staging_dir=relative", text)
            self.assertIn("report=401", text)
            for secret in (FAKE_URL, FAKE_KEY, a, "relative/path"):
                self.assertNotIn(secret, text)

    def test_without_url_or_key_nothing_is_sent(self):
        code, text = self.run_probe({})
        self.assertEqual(code, 0)
        self.assertIn("url_set=false", text)
        self.assertIn("key_set=false", text)
        self.assertIn("report=skipped", text)
        self.assertIn("media_dir=unset", text)
