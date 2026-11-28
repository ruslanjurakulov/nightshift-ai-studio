#!/usr/bin/env python3
"""The music-check service (S6): one song in, the two numbers of the approved vocal rule out (modules/vocal_check.py).

    python tools/music_check_server.py                 # serve (the later compose service ``music-check``)
    python tools/music_check_server.py --child FILE    # one measurement, one JSON line (what the server runs per song)

Why a service of its own: the detectors need torch and about 360 MB of weights, and one 3-minute song peaked at 3.2 GB measured
whole (docs/MEASUREMENT.md section 10). The creative worker runs four jobs in 2 GB; none of that may land there.

HOW A CHECK RUNS. ``POST /check`` with the song as the body (MP3 or WAV by its own bytes, at most ``MAX_BYTES``):
  * one check at a time (a lock). A second request does not queue here: it gets ``503 {"code": "busy"}`` at once, and the client
    asks again within its own timeout. The lock is never waited on while holding a connection open for minutes;
  * before each check, the free memory of this process's own cgroup (memory.max minus memory.current, less reclaimable page cache;
    cgroup v2, with a v1 fallback; capped by the host's MemAvailable). Under ``MIN_FREE_BYTES`` the answer is
    ``503 {"code": "insufficient_memory", "remedy": "the music check needs 1.5 GB free on the worker"}``. A cgroup that cannot be
    read is refused the same way (rule 5: an unknown is not "enough");
  * the measurement runs in a SHORT-LIVED CHILD PROCESS per song (``--child``), so every byte torch took is returned when it exits.
    The models are loaded again per song (a few seconds): the price of never keeping 1 GB resident between songs;
  * the child runs tools/vocal_activity.py's own detectors and ``measure()``, with UMX made chunked by
    ``modules.vocal_check.chunked_separator`` (30 s windows, 5 s linear crossfade). PANNs is unchanged; Silero is not run (it is
    not part of the rule).
The answer is numbers only: ``{"umx_share_above_minus10_db", "panns_voice_max", "duration_s", "peak_rss_mb", "timing_s"}``. No
verdict (the adapter applies the rule), no audio, no path, no text. A measurement that failed is ``500 {"code": "check_failed"}``.

``GET /ready`` answers ``{"ready": true}`` when a check could start memory-wise (busy or not), else 503 with the remedy. The
creative worker asks it before a Lyria job is submitted.

ENV (no compose service yet; a later PR adds it):
    NIGHTSHIFT_MUSIC_CHECK_BIND        address to listen on (default 127.0.0.1). Loopback or a private address only, or a host
                                       name that resolves only to those (in compose: the service's own name). 0.0.0.0 is refused.
    NIGHTSHIFT_MUSIC_CHECK_PORT        default 8765
    NIGHTSHIFT_MUSIC_CHECK_CHILD_TIMEOUT_S   one song's measurement, model load included (default 600)
    VOCAL_MEASURE_CACHE                where the pinned weights are (tools/vocal_activity.py --fetch-only fills it); a weight
                                       whose sha256 differs is refused, never used
The worker side: NIGHTSHIFT_MUSIC_CHECK_URL (and NIGHTSHIFT_MUSIC_CHECK_TIMEOUT_S), modules/vocal_check.py.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, List, Mapping, Optional

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from modules import vocal_check  # noqa: E402

#: "the music check needs 1.5 GB free on the worker" (Atlas). The chunked child's measured peak is below it (the PR's numbers).
MIN_FREE_BYTES = 1536 * 1024 * 1024
LOW_MEMORY_REMEDY = "the music check needs 1.5 GB free on the worker"
#: A 3-minute MP3 is about 4.3 MB and a 3-minute 16-bit stereo WAV about 32 MB; the measurement refuses anything over 10 minutes.
MAX_BYTES = 48 * 1024 * 1024
DEFAULT_PORT = 8765
DEFAULT_CHILD_TIMEOUT_S = 600.0
#: cgroup v1 reports "no limit" as a number near 2**63 rounded to a page.
_V1_UNLIMITED = 1 << 60


class Refused(Exception):
    def __init__(self, status: int, code: str, remedy: str):
        super().__init__(remedy)
        self.status, self.code, self.remedy = status, code, remedy


# ── memory ────────────────────────────────────────────────────────────────────────

def _read_int(path: Path) -> Optional[int]:
    try:
        text = path.read_text().strip()
    except OSError:
        return None
    if text == "max":
        return -1
    try:
        return int(text)
    except ValueError:
        return None


def _stat_value(path: Path, key: str) -> int:
    try:
        for line in path.read_text().splitlines():
            name, _, value = line.partition(" ")
            if name == key:
                return int(value)
    except (OSError, ValueError):
        pass
    return 0


def _mem_available(meminfo: Path) -> Optional[int]:
    try:
        for line in meminfo.read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        return None
    return None


def free_memory_bytes(cgroup: Path = Path("/sys/fs/cgroup"), meminfo: Path = Path("/proc/meminfo")) -> Optional[int]:
    """Bytes this process's cgroup can still take, or None when it cannot be read. Inactive page cache (the weights just read,
    the temp file) is subtracted from the usage, as ``docker stats`` does: the kernel reclaims it before it kills anything."""
    host = _mem_available(meminfo)
    limit = usage = None
    if (cgroup / "memory.max").exists() or (cgroup / "memory.current").exists():          # v2
        limit, usage = _read_int(cgroup / "memory.max"), _read_int(cgroup / "memory.current")
        cache = _stat_value(cgroup / "memory.stat", "inactive_file")
    elif (cgroup / "memory" / "memory.limit_in_bytes").exists():                           # v1
        v1 = cgroup / "memory"
        limit, usage = _read_int(v1 / "memory.limit_in_bytes"), _read_int(v1 / "memory.usage_in_bytes")
        if limit is not None and limit >= _V1_UNLIMITED:
            limit = -1
        cache = _stat_value(v1 / "memory.stat", "total_inactive_file")
    else:
        return host
    if limit is None or usage is None or usage < 0:
        return None
    if limit == -1:                         # no cgroup limit: the host's own answer is the only one
        return host
    free = limit - max(0, usage - cache)
    return min(free, host) if host is not None else free


def memory_refusal(read: Callable[[], Optional[int]] = free_memory_bytes) -> Optional[Refused]:
    free = read()
    if free is None:
        return Refused(503, "insufficient_memory", LOW_MEMORY_REMEDY + " (its free memory could not be read)")
    if free < MIN_FREE_BYTES:
        return Refused(503, "insufficient_memory", LOW_MEMORY_REMEDY)
    return None


# ── input ─────────────────────────────────────────────────────────────────────────

def sniff(head: bytes) -> Optional[str]:
    """The suffix to store the song under, by its own bytes: MP3 (an ID3 tag or an MPEG audio frame) or WAV (RIFF/WAVE)."""
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return ".wav"
    if head.startswith(b"ID3") or (len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0 and (head[1] & 0x06) != 0):
        return ".mp3"
    return None


# ── the child ─────────────────────────────────────────────────────────────────────

def measure_file(path: Path, *, detectors=None, decoder=None) -> dict:
    """The numbers of one song, chunked. Imports the measurement tool here, so the server process never loads torch."""
    from tools import vocal_activity as va

    det = detectors if detectors is not None else va.load_detectors(silero=False)
    kw = {"decoder": decoder} if decoder is not None else {}
    measured = va.measure(path, detectors=det, silero=False,
                          separate=vocal_check.chunked_separator(det.separate_vocals, va.UMX_RATE), **kw)
    signals = vocal_check.signals_from_measurement(measured)
    return {vocal_check.UMX_FIELD: signals.umx_share_above, vocal_check.PANNS_FIELD: signals.panns_voice_max,
            "duration_s": measured["duration_s"], "peak_rss_mb": measured["peak_rss_mb"],
            "timing_s": {k: measured["timing_s"][k] for k in ("decode", "umx", "panns")}}


def child_main(path: str) -> int:
    try:
        out = measure_file(Path(path))
    except Exception as e:
        # The measurement's own messages name no file and carry no audio; only the first 300 characters go on.
        print(json.dumps({"error": type(e).__name__, "detail": str(e)[:300]}), file=sys.stderr)
        return 1
    print(json.dumps(out))
    return 0


def child_command(path: Path) -> List[str]:
    return [sys.executable, str(Path(__file__).resolve()), "--child", str(path)]


def run_child(path: Path, *, timeout_s: float, command: Callable[[Path], List[str]] = child_command,
              env: Optional[Mapping[str, str]] = None) -> dict:
    """One child per song. Its numbers, or ``Refused`` (``check_failed``) with what went wrong: a non-zero exit, a timeout (the
    child is killed), or an answer that is not the two numbers."""
    try:
        proc = subprocess.run(command(path), capture_output=True, timeout=timeout_s, env=dict(env) if env is not None else None,
                              stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise Refused(500, "check_failed", f"the measurement did not finish within {timeout_s:g} s") from None
    if proc.returncode != 0:
        detail = ""
        try:
            detail = str(json.loads(proc.stderr.decode("utf-8", "replace").strip().splitlines()[-1]).get("detail", ""))[:300]
        except (ValueError, IndexError, AttributeError):
            pass
        raise Refused(500, "check_failed", f"the measurement failed (exit {proc.returncode})" + (f": {detail}" if detail else ""))
    try:
        out = json.loads(proc.stdout.decode("utf-8").strip().splitlines()[-1])
        vocal_check.parse_signals(out)
    except (ValueError, IndexError, UnicodeDecodeError, vocal_check.CheckDidNotRun):
        raise Refused(500, "check_failed", "the measurement answered something that is not the two numbers") from None
    return out


# ── the service ───────────────────────────────────────────────────────────────────

class Checker:
    """The lock, the memory pre-check and the child, without HTTP, so a test can drive it directly."""

    def __init__(self, *, run: Callable[[Path], dict], memory: Callable[[], Optional[Refused]] = memory_refusal):
        self._lock = threading.Lock()
        self._run = run
        self._memory = memory

    @property
    def busy(self) -> bool:
        return self._lock.locked()

    def ready(self) -> Optional[Refused]:
        # While a song is being checked its child holds the memory, so the free memory now says nothing about the next song's
        # turn: a busy service is ready (the song waits for the lock), and memory is read again under the lock.
        if self.busy:
            return None
        return self._memory()

    def check(self, body: bytes) -> dict:
        if not body:
            raise Refused(400, "empty", "send the song as the request body")
        if len(body) > MAX_BYTES:
            raise Refused(413, "too_large", f"the song is over {MAX_BYTES} bytes")
        suffix = sniff(body[:16])
        if suffix is None:
            raise Refused(415, "not_audio", "only MP3 or WAV is checked, by its own bytes")
        if not self._lock.acquire(blocking=False):
            raise Refused(503, "busy", "another song is being checked; ask again")
        try:
            low = self._memory()
            if low is not None:
                raise low
            tmp = Path(tempfile.mkdtemp(prefix="music-check-"))
            try:
                song = tmp / ("song" + suffix)
                song.write_bytes(body)
                return self._run(song)
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
        finally:
            self._lock.release()


def make_handler(checker: Checker):
    class Handler(BaseHTTPRequestHandler):
        server_version = "music-check"
        sys_version = ""

        def log_message(self, fmt, *args):  # the default writes the client address and path for every request; nothing is needed
            pass

        def _send(self, status: int, obj: dict, headers: Optional[Mapping[str, str]] = None) -> None:
            data = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def _refused(self, r: Refused) -> None:
            self._send(r.status, {"code": r.code, "remedy": r.remedy}, {"Retry-After": "3"} if r.code == "busy" else None)

        def do_GET(self):
            if self.path != "/ready":
                return self._send(404, {"code": "not_found"})
            low = checker.ready()
            if low is not None:
                return self._send(503, {"ready": False, "code": low.code, "remedy": low.remedy})
            self._send(200, {"ready": True, "busy": checker.busy})

        def do_POST(self):
            if self.path != "/check":
                return self._send(404, {"code": "not_found"})
            try:
                length = int(self.headers.get("Content-Length") or "")
            except ValueError:
                self.close_connection = True
                return self._send(411, {"code": "length_required", "remedy": "send a Content-Length"})
            if length <= 0 or length > MAX_BYTES:
                # The body is not read: the connection is closed instead.
                self.close_connection = True
                return self._refused(Refused(413 if length > 0 else 400, "too_large" if length > 0 else "empty",
                                             f"the song must be 1 to {MAX_BYTES} bytes"))
            body = self.rfile.read(length)
            if len(body) != length:
                self.close_connection = True
                return self._send(400, {"code": "short_body"})
            try:
                out = checker.check(body)
            except Refused as r:
                return self._refused(r)
            except Exception as e:
                return self._send(500, {"code": "check_failed", "remedy": f"the check hit {type(e).__name__}"})
            self._send(200, out)

    return Handler


def internal_bind(host: str) -> str:
    """``host`` when every address it names is loopback or private (never unspecified, link-local or public), else ValueError.
    The service answers anyone who reaches it, so it must not be reachable from outside the worker's network."""
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise ValueError(f"the bind address {host!r} does not resolve") from None
    addrs = {ipaddress.ip_address(info[4][0].split("%", 1)[0]) for info in infos}
    for a in addrs:
        if a.is_unspecified or a.is_link_local or a.is_multicast or not (a.is_loopback or a.is_private):
            raise ValueError(f"the bind address {host!r} is not internal ({a}); use 127.0.0.1 or the service's own name")
    return host


def serve(env: Mapping[str, str] = os.environ) -> int:
    host = (env.get("NIGHTSHIFT_MUSIC_CHECK_BIND") or "127.0.0.1").strip()
    try:
        internal_bind(host)
        port = int((env.get("NIGHTSHIFT_MUSIC_CHECK_PORT") or str(DEFAULT_PORT)).strip())
        timeout_s = float((env.get("NIGHTSHIFT_MUSIC_CHECK_CHILD_TIMEOUT_S") or str(DEFAULT_CHILD_TIMEOUT_S)).strip())
    except ValueError as e:
        print(json.dumps({"error": "bad_config", "detail": str(e)[:300]}), file=sys.stderr)
        return 2
    checker = Checker(run=lambda p: run_child(p, timeout_s=timeout_s))
    httpd = ThreadingHTTPServer((host, port), make_handler(checker))
    httpd.daemon_threads = True
    print(json.dumps({"music_check": "listening", "port": port, "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}),
          flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--child", metavar="FILE", help="measure one file and print one JSON line (what the server runs per song)")
    args = ap.parse_args(argv)
    if args.child:
        return child_main(args.child)
    return serve()


if __name__ == "__main__":
    sys.exit(main())
