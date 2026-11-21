"""Private stdlib-only launcher for ffmpeg_limits, executed with Python -I -S.

Linux wait4 includes the child's pre-exec RSS. Forking from this fresh, small
interpreter keeps a busy media worker's heap out of the decoder measurement.
Never subtract a baseline: that would hide real decoder allocations. The small
launcher footprint is deliberately included in the reported peak.
"""

import os
import signal
import struct
import subprocess
import sys


def main() -> None:
    # The outer runner owns this private process group and its deadline. The
    # decoder does not inherit the accounting pipe: only the supervisor keeps
    # it. (A decoder that could run code might reopen it through /proc; the
    # runner then reads more than 16 bytes and rejects the report.)
    child = None
    stopping = False

    def stop(signum, frame):
        nonlocal stopping
        stopping = True
        if child is not None:
            try:
                os.kill(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    # Stay alive long enough to reap a cancelled decoder. Killing both with
    # SIGKILL would orphan a zombie on every normal timeout/refusal.
    signal.signal(signal.SIGTERM, stop)
    child = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=None)
    if stopping:
        stop(None, None)
    # A late SIGTERM must never kill a PID after wait4 released it for reuse.
    # Observe exit without reaping, then disarm the handler before wait4.
    decoder = child
    os.waitid(os.P_PID, decoder.pid, os.WEXITED | os.WNOWAIT)
    child = None
    _, status, usage = os.wait4(decoder.pid, 0)
    decoder.returncode = os.waitstatus_to_exitcode(status)
    os.write(1, struct.pack("!qQ", decoder.returncode, int(usage.ru_maxrss) * 1024))


if __name__ == "__main__":
    main()
