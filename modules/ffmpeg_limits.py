"""Resource limits for every ffmpeg that decodes member media.

Used by the media library (``media_library.run_tool``: the thumbnail and the
proxy of an upload, a creative output or an editor render) and by an editor
export (``render_backend._run`` with a deadline: every command of a timeline).
The pipeline's own renders do not come through here.

Why (Lens round 3, BR-L-007 / BR-L-008 / BR-L-010, measured with the bundled
ffmpeg 7.0.2 on 4 cores; peak RSS from ``getrusage``):

* ``-max_pixels`` checks the frame size the decoder reports, which for H.264
  is the crop window. A stream can carry a 14336x14336 coded frame with a
  64x64 crop window: every probe and the cap say 64x64, the decoder allocates
  205 MP per frame. A 650 KB file took the proxy to 3.8 GB (threads auto),
  over the media worker's 4 GB container. Nothing that reads the file before
  decoding it can see this, so the decoder itself gets a budget:

  - an address-space limit (``RLIMIT_AS``, ``CHILD_MEM_BYTES``), set by a
    tiny Python trampoline that then ``exec``s ffmpeg. Not ``preexec_fn``:
    the media worker runs uploads and exports on two threads, and Python
    code between fork and exec is not safe there;
  - two decoder threads per input and two filter-graph threads, so the
    footprint does not grow with the host's core count. With threads left
    automatic, a legitimate 8K proxy failed the limit when the thread counts
    of a 64-core host were forced (filter 64, encoder 96);
  - ``MALLOC_ARENA_MAX=2``: glibc reserves address space per malloc arena
    (up to 8 per core); measured on an 8K HEVC 10-bit proxy, 1983 MB of
    address space without it, 1611 MB with it, for the same 1349 MB RSS.

* Without ``-xerror`` (dropped: it refused damaged-but-playable uploads and
  failed exports, BR-L-008), ffmpeg skips a frame it cannot decode and exits
  0. A frame refused for its size, or for want of memory under the limit, must
  fail the job instead, so stderr is read while ffmpeg runs and a refusal
  (``REFUSAL_MARKERS``) stops it. A damaged file logs other errors
  ("error while decoding MB", "Invalid NAL unit size") and still succeeds.

  Not every out-of-memory surfaces as one of these messages: an H.264
  decoder that cannot allocate its per-resolution tables logs only
  "decode_slice_header error", which a damaged file logs too. Such a file
  decodes what it can and stays inside the same memory and time limits.

* The limit bounds the worker; it does not by itself refuse the file. Under
  it, Lens's crop-window file decodes completely (1787 MB peak RSS, two
  threads), and is stored as a 64x64 video. So ``run`` also reports the
  child's own peak RSS (``wait4``), and the media library refuses a decode
  that needed far more memory than the frame size its probe declared allows
  (``media_library.expected_rss_bytes``): the frame the decoder really met
  was bigger than any check before it could see. That is an early refusal
  for small declared frames only (below about 7-8 MP, BR-L-015); a file that
  declares a 4K first frame is held by the limit alone.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence

#: Address-space limit of one ffmpeg child. Measured: a legitimate 8K DCI
#: HEVC 10-bit proxy (6 reference frames, B-frames) needs 1611 MB of address
#: space with the settings here (1349 MB RSS) and fails at 1.5 GiB; an 8K
#: H.264 proxy 581 MB RSS; 4K HDR10 HEVC 297 MB. The crop-window file of
#: BR-L-007 stops at about 1.5 GB RSS in an export segment and 1.8 GB in the
#: ingest proxy. The media worker's container has 4 GB and runs at most one
#: upload and one export at once (measured by Lens: 3289 MB for both at
#: their worst; the HEIC child has its own 3 GiB limit, BR-L-015).
CHILD_MEM_BYTES = 2 * 1024 ** 3
#: Decoder threads per input (``-threads`` before each ``-i``).
DECODE_THREADS = 2
#: Filter-graph threads (``-filter_threads`` / ``-filter_complex_threads``).
FILTER_THREADS = 2
#: Encoder threads of an editor export's commands (output ``-threads``; the
#: ingest's 480p proxy and thumbnail use DECODE_THREADS). Left automatic,
#: libx264 starts 1.5 threads per core: forced to the counts of bigger hosts,
#: a 1080p segment from an 8K H.264 clip failed the limit at 48 threads and
#: one from a plain 720p clip at 96; at 4 threads an 8K DCI HEVC 10-bit
#: segment needs 1368 MB and passes.
ENCODE_THREADS = 4
#: An export whose frame is larger than this (2560x1440) encodes with
#: LARGE_ENCODE_THREADS, and its final pass with a 20-frame lookahead
#: (render_spec.final_x264), BR-L-014. Measured, final pass of a 4K60
#: timeline: libx264 medium at 4 threads failed the limit (exit 187, a
#: malloc in libx264; 1931 MB without the limit); at 2 threads and
#: rc-lookahead 20 it takes 1235-1314 MB (portrait too), and a segment from
#: an 8K DCI HEVC 10-bit clip 1499 MB. 2560x1440 at 60 fps needs 855 MB
#: with the defaults, so ordinary outputs keep them.
LARGE_OUTPUT_PX = 2560 * 1440
LARGE_ENCODE_THREADS = 2
#: Added to the child's environment (see the module docstring).
CHILD_ENV: Dict[str, str] = {"MALLOC_ARENA_MAX": "2"}
#: What libavcodec logs, at ``-loglevel error``, when it decodes no picture
#: for a frame because it could not have a buffer for it: the size cap's own
#: refusal (libavutil/imgutils.c), the buffer request that failed after it or
#: under the memory limit, and ENOMEM's text. Checked against the bundled
#: ffmpeg 7.0.2: present for a mid-stream switch over the cap and for the
#: crop-window file under the limit; absent for a truncated mp4 and for mp4 /
#: mkv files with bytes flipped inside the picture data.
REFUSAL_MARKERS = (b"exceeds specified max pixel count", b"get_buffer() failed",
                   b"Cannot allocate memory")
#: How much of the end of stderr is kept for a log line.
TAIL_BYTES = 4096

_SET_LIMIT_AND_EXEC = (
    "import os,resource,sys\n"
    "n=int(sys.argv[1])\n"
    "s,h=resource.getrlimit(resource.RLIMIT_AS)\n"
    "n=n if h==resource.RLIM_INFINITY else min(n,h)\n"
    "resource.setrlimit(resource.RLIMIT_AS,(n,n))\n"
    "os.execvp(sys.argv[2],sys.argv[2:])\n"
)


def limited_argv(argv: Sequence[str], mem_bytes: Optional[int] = None) -> List[str]:
    """``argv`` run under an address-space limit: a Python child sets
    RLIMIT_AS on itself and ``exec``s the command, which keeps the limit (and
    the pid, so killing the child kills ffmpeg). A limit that cannot be set
    fails the run; it never runs unlimited."""
    n = CHILD_MEM_BYTES if mem_bytes is None else mem_bytes
    if int(n) <= 0:  # -1 would be RLIM_INFINITY: never run unlimited
        raise ValueError("the address-space limit must be positive")
    return [sys.executable, "-I", "-S", "-c", _SET_LIMIT_AND_EXEC, str(int(n)), *argv]


def child_env() -> Dict[str, str]:
    env = dict(os.environ)
    env.update(CHILD_ENV)
    return env


def thread_options() -> List[str]:
    """Global options: the filter graphs' thread counts."""
    return ["-filter_threads", str(FILTER_THREADS), "-filter_complex_threads", str(FILTER_THREADS)]


def decode_thread_options() -> List[str]:
    """Input options: the decoder's thread count (before each ``-i``)."""
    return ["-threads", str(DECODE_THREADS)]


def encode_thread_options(threads: Optional[int] = None, *, out_pixels: Optional[int] = None) -> List[str]:
    """Output options: the encoder's thread count (before the output);
    fewer for a frame above LARGE_OUTPUT_PX."""
    if threads is None:
        threads = LARGE_ENCODE_THREADS if out_pixels and out_pixels > LARGE_OUTPUT_PX else ENCODE_THREADS
    return ["-threads", str(threads)]


@dataclass(frozen=True)
class Outcome:
    #: The exit status, or None when the run was stopped for time.
    returncode: Optional[int]
    #: A frame was refused (see REFUSAL_MARKERS); the run was stopped.
    refused: bool
    timed_out: bool
    #: The end of stderr, for a log line (never shown to a member).
    tail: str
    #: The child's peak resident memory (``wait4``), 0 when unknown.
    peak_rss_bytes: int = 0

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.refused and not self.timed_out


class _StderrWatch(threading.Thread):
    """Drains a child's stderr (so it never blocks on a full pipe), keeps its
    last TAIL_BYTES, and calls ``on_refusal`` once at the first marker."""

    def __init__(self, stream, on_refusal: Callable[[], None]):
        super().__init__(daemon=True)
        self.stream = stream
        self.on_refusal = on_refusal
        self.refused = False
        self.tail = b""

    def run(self) -> None:
        keep = max(len(m) for m in REFUSAL_MARKERS) - 1
        carry = b""
        try:
            while True:
                chunk = self.stream.read1(65536) if hasattr(self.stream, "read1") else self.stream.read(65536)
                if not chunk:
                    break
                window = carry + chunk
                if not self.refused and any(m in window for m in REFUSAL_MARKERS):
                    self.refused = True
                    try:
                        self.on_refusal()
                    except Exception:
                        pass
                carry = window[-keep:]
                self.tail = (self.tail + chunk)[-TAIL_BYTES:]
        except (OSError, ValueError):
            pass


class _Child:
    """A started command, reaped with ``wait4`` so its own peak RSS is known
    (``RUSAGE_CHILDREN`` would mix in every other child of the worker, which
    runs uploads and exports on two threads). The lock keeps a kill from
    reaching a pid that was reaped and could have been reused."""

    def __init__(self, proc: "subprocess.Popen"):
        self.proc = proc
        self.lock = threading.Lock()
        self.status: Optional[int] = None
        self.maxrss_kb = 0

    def kill(self) -> None:
        with self.lock:
            if self.status is None:
                try:
                    os.kill(self.proc.pid, 9)
                except OSError:
                    pass

    def reap(self, block: bool) -> bool:
        with self.lock:
            if self.status is not None:
                return True
            try:
                pid, status, usage = os.wait4(self.proc.pid, 0 if block else os.WNOHANG)
            except ChildProcessError:
                self.status = self.proc.returncode if self.proc.returncode is not None else -1
                return True
            if pid == 0:
                return False
            self.status = os.waitstatus_to_exitcode(status)
            self.maxrss_kb = int(usage.ru_maxrss)
            self.proc.returncode = self.status  # Popen must not wait for it again
            return True


def run(argv: Sequence[str], *, timeout_s: float, heartbeat: Optional[Callable[[], None]] = None,
        beat_s: float = 30.0, mem_bytes: Optional[int] = None) -> Outcome:
    """Run one ffmpeg command under the limits above and wait for it, calling
    ``heartbeat`` every ``beat_s`` while it works. Past ``timeout_s`` it is
    killed and reaped (``timed_out``); at the first refused frame it is
    killed (``refused``). Never leaves a process behind."""
    proc = subprocess.Popen(limited_argv(argv, mem_bytes), stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=child_env())
    child = _Child(proc)
    watch = _StderrWatch(proc.stderr, child.kill)
    watch.start()
    started = last_beat = time.monotonic()
    timed_out = False
    pause = 0.005
    try:
        while not child.reap(block=False):
            now = time.monotonic()
            if now - started >= timeout_s:
                timed_out = True
                child.kill()
                child.reap(block=True)
                break
            if heartbeat is not None and now - last_beat >= beat_s:
                last_beat = now
                try:
                    heartbeat()
                except Exception:
                    pass
            time.sleep(min(pause, max(0.0, timeout_s - (now - started))))
            pause = min(pause * 2, 0.25)
    except BaseException:
        child.kill()
        child.reap(block=True)
        raise
    finally:
        watch.join(timeout=10)
        if proc.stderr:
            proc.stderr.close()
    return Outcome(None if timed_out else child.status, watch.refused, timed_out,
                   watch.tail.decode("utf-8", "replace"), child.maxrss_kb * 1024)


__all__ = ["CHILD_ENV", "CHILD_MEM_BYTES", "DECODE_THREADS", "ENCODE_THREADS", "FILTER_THREADS", "Outcome",
           "REFUSAL_MARKERS", "child_env", "decode_thread_options", "encode_thread_options", "limited_argv", "run",
           "thread_options"]
