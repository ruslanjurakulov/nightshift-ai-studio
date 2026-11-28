"""Breach: render_backend's ffmpeg -progress handling (0246's assembly percent), attacked for disk, thread and log safety.

Ledger (Breach, 2026-11-28, 79cb10593):

* The report file is a fixed name inside the render's own TemporaryDirectory (no caller-controlled part, no ``..``), and it goes
  with the directory, on success and on a failed final pass: pinned below.
* The watcher thread ends on success and on a failed final pass: pinned below.
* B-RP-1 (INFO, fixed): ProgressFileWatch.stop() joins for 5 s only. A reporter that blocked longer (the assembly's
  PostgREST write, bounded by the media client's HTTP timeout) left the daemon thread running past the render, and stop()
  then called the reporter once more on the caller's thread. Now stop() skips that last read while the thread is alive: the
  render's thread waits 5 s at most, and the bounded daemon thread ends when its reporter returns.
  test_a_reporter_that_hangs_past_the_join_leaves_a_bounded_daemon_thread.
* B-RP-2 (INFO / hardening, fixed): parse_progress_out_time did int() on an unbounded digit run; past Python's 4300-digit
  limit that is a ValueError, which killed the watcher thread and, from stop()'s last read inside render()'s ``finally``,
  failed a render whose ffmpeg succeeded. Not reachable as an attack (ffmpeg's own file in a private mkdtemp directory).
  Fixed: the digit run is capped at 19 (an int64) and _read catches ValueError.
  test_a_progress_line_python_cannot_parse_does_not_fail_a_finished_render.
* A hostile -progress file (huge, a negative, N/A, a value far past the timeline, binary junk) never reports a figure outside
  0..100 and never raises: pinned below.
"""

from __future__ import annotations

import sys
import tempfile
import threading
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from modules import render_backend  # noqa: E402

HAS_FFMPEG = Path("/usr/bin/ffmpeg").exists()


def _threads():
    return [t for t in threading.enumerate() if t.name == "render-progress" and t.is_alive()]


def _spec(d):
    from modules.render_spec import KIND_COLOR
    return render_backend.simple_spec(str(Path(d) / "out.mp4"), [(None, 1.0, KIND_COLOR), (None, 1.0, KIND_COLOR)],
                                      width=160, height=120, fps=12)


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg binary not available")
def test_a_real_render_leaves_no_progress_file_and_no_watcher_thread():
    with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as work:
        got = []
        render_backend.render(_spec(out), workdir=work, progress=got.append)
        assert got
        assert list(Path(work).iterdir()) == [], "the render's temp directory (and final.progress) was left behind"
        assert not list(Path(out).glob("*.progress"))
    assert _threads() == []


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg binary not available")
def test_a_failed_final_pass_leaves_no_progress_file_and_no_watcher_thread(monkeypatch):
    real = render_backend._run
    seen = {}

    def run(cmd, deadline=None):
        if "-progress" in cmd:
            i = cmd.index("-progress")
            seen["path"] = Path(cmd[i + 1])
            seen["path"].write_text("out_time_us=500000\nprogress=continue\n", encoding="utf-8")
            raise render_backend.RenderBackendError("final pass failed (lab)")
        return real(cmd, deadline=deadline) if deadline is not None else real(cmd)

    monkeypatch.setattr(render_backend, "_run", run)
    with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as work:
        with pytest.raises(render_backend.RenderBackendError):
            render_backend.render(_spec(out), workdir=work, progress=lambda p: None)
        p = seen["path"]
        assert p.name == "final.progress" and ".." not in p.parts
        assert Path(work).resolve() in p.resolve().parents, "the report file is outside the render's own temp directory"
        assert not p.exists() and list(Path(work).iterdir()) == []
    assert _threads() == []


def test_a_hostile_progress_file_never_reports_outside_0_to_100_and_never_raises():
    got = []
    meter = render_backend.RenderProgress(got.append, total_s=10.0)
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "final.progress"
        for body in ("out_time_us=N/A\n", "out_time_us=-5\n", "out_time_ms=999999999999999999999\n",
                     "\x00\xff garbage\nout_time_us=1e9\n",
                     ("out_time_us=1000000\nprogress=continue\n" * 200000)):
            f.write_text(body, encoding="utf-8", errors="replace")
            w = render_backend.ProgressFileWatch(f, meter.final_at, every=0.01)
            w.start()
            time.sleep(0.03)
            w.stop()
    assert all(0 <= p <= 100 for p in got), got
    assert _threads() == []


def test_a_reporter_that_hangs_past_the_join_leaves_a_bounded_daemon_thread():
    release = threading.Event()
    calls = []

    def hang(seconds):
        calls.append(threading.current_thread().name)
        release.wait(8)

    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "final.progress"
        f.write_text("out_time_us=1000000\n", encoding="utf-8")
        w = render_backend.ProgressFileWatch(f, hang, every=0.01)
        w.start()
        time.sleep(0.1)
        t0 = time.monotonic()
        release_later = threading.Timer(6.0, release.set)
        release_later.start()
        w.stop()                                   # join(5) times out; the thread is alive, so no read on the caller's thread
        took = time.monotonic() - t0
    assert 5.0 <= took < 5.9, took
    assert calls and set(calls) == {"render-progress"}, "stop() called a blocked reporter again on the caller's thread"
    deadline = time.monotonic() + 5
    while _threads() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert _threads() == [], "the watcher thread outlived its reporter's release: an unbounded leak"


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg binary not available")
def test_a_progress_line_python_cannot_parse_does_not_fail_a_finished_render(monkeypatch):
    real = render_backend._run

    def run(cmd, deadline=None):
        if "-progress" in cmd:
            real(cmd)                                     # the real final pass, which succeeds
            Path(cmd[cmd.index("-progress") + 1]).write_text("out_time_us=" + "9" * 5000 + "\n", encoding="utf-8")
            return None
        return real(cmd, deadline=deadline) if deadline is not None else real(cmd)

    monkeypatch.setattr(render_backend, "_run", run)
    with tempfile.TemporaryDirectory() as out:
        assert render_backend.render(_spec(out), progress=lambda p: None) == str(Path(out) / "out.mp4")


def test_a_digit_run_longer_than_an_int64_is_not_read():
    assert render_backend.parse_progress_out_time("out_time_us=" + "9" * 5000 + "\n") is None
    assert render_backend.parse_progress_out_time("out_time_us=" + "1" * 20 + "\n") is None
    assert render_backend.parse_progress_out_time("out_time_us=9223372036854775807\n") == 9223372036854.775807
