"""Supervisor protocol/lifecycle and the security regressions in normal CI."""

from pathlib import Path
import signal
import struct
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

from modules import ffmpeg_limits as fl
from tests.security.test_decoder_rss import DecoderRssTests  # noqa: F401


@unittest.skipUnless(sys.platform == "linux", "Linux media-worker process accounting")
class SupervisorTests(unittest.TestCase):
    def run_python(self, code, **kwargs):
        return fl.run([sys.executable, "-I", "-S", "-c", code],
                      timeout_s=kwargs.pop("timeout_s", 10), **kwargs)

    def test_exit_and_signal_status_are_preserved(self):
        self.assertEqual(self.run_python("raise SystemExit(23)").returncode, 23)
        self.assertEqual(self.run_python("import os,signal;os.kill(os.getpid(),signal.SIGTERM)").returncode,
                         -signal.SIGTERM)

    def test_unsupported_platform_fails_before_starting_a_process(self):
        with mock.patch.object(fl.sys, "platform", "unsupported"), \
                mock.patch.object(fl.subprocess, "Popen") as start:
            with self.assertRaisesRegex(RuntimeError, "Linux"):
                self.run_python("pass")
            start.assert_not_called()

    def test_late_stop_cannot_signal_a_reaped_decoder_pid(self):
        from modules import ffmpeg_supervisor as supervisor
        handler = None
        events = []

        def register(signum, callback):
            nonlocal handler
            handler = callback

        def observe(*args):
            events.append("observed_unreaped_exit")

        def reap(*args):
            events.append("reaped")
            # Simulate delivery just after the kernel has released this PID.
            handler(signal.SIGTERM, None)
            return 123, 0, SimpleNamespace(ru_maxrss=1024)

        with mock.patch.object(supervisor.signal, "signal", register), \
                mock.patch.object(supervisor.subprocess, "Popen", return_value=SimpleNamespace(pid=123)), \
                mock.patch.object(supervisor.os, "waitid", observe), \
                mock.patch.object(supervisor.os, "wait4", reap), \
                mock.patch.object(supervisor.os, "kill") as kill, \
                mock.patch.object(supervisor.os, "write"):
            supervisor.main()
        self.assertEqual(events, ["observed_unreaped_exit", "reaped"])
        kill.assert_not_called()

    def test_decoder_stdout_cannot_forge_the_accounting_report(self):
        out = self.run_python("import os,struct;os.write(1,struct.pack('!qQ',0,1));"
                              "b=bytearray(128*1024**2)")
        self.assertTrue(out.ok, out)
        self.assertGreater(out.peak_rss_bytes, 120 * 1024 ** 2)

    def test_missing_malformed_or_failed_supervisor_reports_fail_closed(self):
        real_popen = fl.subprocess.Popen
        cases = [(b"", 0), (b"bad", 0), (struct.pack("!qQ", 0, 0), 0),
                 (struct.pack("!qQ", 256, 100), 0), (struct.pack("!qQ", 0, 100) + b"x", 0),
                 (struct.pack("!qQ", 0, 100), 2)]
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "broken_supervisor.py"
            def start(argv, **kwargs):
                return real_popen([*argv[:3], str(script), *argv[4:]], **kwargs)
            for data, status in cases:
                with self.subTest(data_length=len(data), status=status):
                    script.write_text(f"import os;os.write(1,{data!r});os._exit({status})\n")
                    with mock.patch.object(fl.subprocess, "Popen", start):
                        out = self.run_python("pass")
                    self.assertFalse(out.ok, out)
                    self.assertNotEqual(out.returncode, 0)
                    self.assertEqual(out.peak_rss_bytes, 0)

    def assert_not_running(self, pid, *, reaped=False):
        # A killed orphan may briefly be a zombie awaiting the host init. It
        # holds no decoder memory and cannot execute; a live sleeper is a leak.
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
            except FileNotFoundError:
                return
            if state == "Z" and not reaped:
                return
            time.sleep(.02)
        self.fail("decoder remained alive after supervisor termination")

    def test_timeout_refusal_and_supervisor_crash_leave_no_live_decoder(self):
        cases = {"timeout": "time.sleep(60)",
                 "refusal": "sys.stderr.write('get_buffer() failed');sys.stderr.flush();time.sleep(60)",
                 "crash": "os.kill(os.getppid(),9);time.sleep(60)"}
        with tempfile.TemporaryDirectory() as directory:
            for name, action in cases.items():
                with self.subTest(name=name):
                    pidfile = Path(directory) / name
                    code = ("import os,sys,time;from pathlib import Path;"
                            f"Path({str(pidfile)!r}).write_text(str(os.getpid()));" + action)
                    out = self.run_python(code, timeout_s=1 if name == "timeout" else 10)
                    self.assertFalse(out.ok, out)
                    self.assertTrue(pidfile.exists(), "decoder did not reach the fault injection")
                    self.assert_not_running(int(pidfile.read_text()), reaped=name != "crash")
                    if name == "timeout":
                        self.assertTrue(out.timed_out)
                    if name == "refusal":
                        self.assertTrue(out.refused)

    def test_unresponsive_supervisor_is_killed_within_the_cleanup_bound(self):
        real_popen = fl.subprocess.Popen
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "stuck_supervisor.py"
            script.write_text("import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)")
            def start(argv, **kwargs):
                return real_popen([*argv[:3], str(script), *argv[4:]], **kwargs)
            before = time.monotonic()
            with mock.patch.object(fl.subprocess, "Popen", start):
                out = self.run_python("pass", timeout_s=.5)
            self.assertTrue(out.timed_out)
            self.assertLess(time.monotonic() - before, 5)

    def test_heartbeat_continues_and_limits_are_unchanged(self):
        beats = []
        code = ("import resource,time;"
                f"assert resource.getrlimit(resource.RLIMIT_AS)==({fl.CHILD_MEM_BYTES},)*2;"
                f"assert resource.getrlimit(resource.RLIMIT_STACK)[0]=={fl.CHILD_STACK_BYTES};"
                "time.sleep(.3)")
        out = self.run_python(code, heartbeat=lambda: beats.append(1), beat_s=.02)
        self.assertTrue(out.ok, out)
        self.assertTrue(beats)


if __name__ == "__main__":
    unittest.main()
