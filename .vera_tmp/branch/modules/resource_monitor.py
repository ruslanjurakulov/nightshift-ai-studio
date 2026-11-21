"""Memory instrumentation — so a killed run leaves a diagnosis behind.

Three production runs have died mid-render with `exit 143` and "The runner has
received a shutdown signal". No traceback, no Python exception, nothing in the
log after "Starting render": the machine went away, the code did not fail.

Run #20 is the reason this module now measures children rather than only the
process it runs in. Its samples, fifteen seconds apart:

    render start   RSS  844 MB    system free 6447 MB
    +15 s          RSS 1028 MB    system free 4983 MB
    +30 s          RSS 1301 MB    system free 1150 MB
    +45 s          RSS 1074 MB    system free 1072 MB
    ...            killed at +82 s, five orphaned ffmpeg processes behind

5.3 GB of system memory vanished in thirty seconds and Python's own resident
set never crossed 1.4 GB. Whatever ate the machine was *not this process*, and
five orphaned ffmpeg processes were still around to be counted afterwards. A
parent-only RSS number can never explain that gap, and neither can a sample
taken every fifteen seconds — the sharpest 3.8 GB of the burst happened
entirely inside one gap between two samples.

So: every three seconds, and every ffmpeg descendant named individually with
its own RSS, alongside the render phase in flight when the sample was taken.
That is the log that turns "memory, probably" into a diagnosis.

Everything here is best-effort and must never be the reason a render fails.
Every read is guarded, the sampler thread is a daemon, and on a platform
without /proc (Windows, macOS) it quietly does nothing rather than raising.
Nothing here needs psutil: /proc alone answers all of it, and a diagnostic is
not worth a new dependency in the environment it is meant to diagnose.
"""

import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

PROC_ROOT = Path("/proc")
PROC_SELF_STATUS = PROC_ROOT / "self" / "status"
PROC_MEMINFO = PROC_ROOT / "meminfo"

# Three seconds. Run #20 lost 3.8 GB inside a single fifteen-second gap, so at
# the old interval the burst is one step on a staircase and nothing about its
# shape is recoverable. At three seconds the same burst is five samples wide,
# which is enough to say whether it climbed or arrived all at once, and cheap
# enough that the sampler is still invisible next to an x264 encode.
DEFAULT_INTERVAL_SECONDS = 3.0

# Enough to name every source file's decoder individually — a run fetches
# twelve videos — without letting one log line grow without bound.
MAX_CHILDREN_NAMED = 12


def _read_kb(path: Path, key: str) -> float | None:
    """The `key: N kB` field from a /proc file, in kB, or None.

    Returns None for every failure — missing file, unreadable, absent key,
    unparseable value — because a diagnostic that can raise is worse than no
    diagnostic at all.
    """
    try:
        text = path.read_text()
    except OSError:
        return None
    for line in text.splitlines():
        name, _, rest = line.partition(":")
        if name.strip() != key:
            continue
        parts = rest.split()
        if not parts:
            return None
        try:
            return float(parts[0])
        except ValueError:
            return None
    return None


def process_rss_mb(status_path: Path = PROC_SELF_STATUS) -> float | None:
    """Resident memory of this process, in MB."""
    kb = _read_kb(status_path, "VmRSS")
    return None if kb is None else kb / 1024


def system_memory_mb(meminfo_path: Path = PROC_MEMINFO) -> tuple[float | None, float | None]:
    """(total, available) system memory in MB — either may be None.

    `MemAvailable` rather than `MemFree`: free memory on a busy runner is
    always near zero because the page cache holds the rest, and available is
    the number that says how close the machine really is to the wall.
    """
    total = _read_kb(meminfo_path, "MemTotal")
    available = _read_kb(meminfo_path, "MemAvailable")
    return (
        None if total is None else total / 1024,
        None if available is None else available / 1024,
    )


def describe_usage(
    status_path: Path = PROC_SELF_STATUS,
    meminfo_path: Path = PROC_MEMINFO,
) -> str | None:
    """One line of memory state, or None where /proc is not available.

    Unknown values are named as unknown and never printed as 0 — a 0 here
    would read as "no memory used", which is the opposite of what it means.
    """
    rss = process_rss_mb(status_path)
    total, available = system_memory_mb(meminfo_path)
    if rss is None and total is None and available is None:
        return None
    rss_txt = "unknown" if rss is None else f"{rss:.0f} MB"
    if total is None and available is None:
        return f"process RSS {rss_txt}"
    avail_txt = "unknown" if available is None else f"{available:.0f} MB"
    total_txt = "unknown" if total is None else f"{total:.0f} MB"
    return (
        f"process RSS {rss_txt}; system {avail_txt} available of {total_txt}"
    )


def log_usage(label: str) -> None:
    """Log memory state at a named point, if it can be read."""
    line = describe_usage()
    if line is not None:
        logger.info("Memory at %s: %s", label, line)


# ---------------------------------------------------------------- Child processes


@dataclass(frozen=True)
class ChildProcess:
    """One descendant process: what it is, and what it costs."""

    pid: int
    name: str
    rss_mb: float | None

    def describe(self) -> str:
        rss = "unknown" if self.rss_mb is None else f"{self.rss_mb:.0f} MB"
        return f"{self.name} pid {self.pid} RSS {rss}"


def _page_size_bytes() -> int | None:
    try:
        return os.sysconf("SC_PAGE_SIZE")
    except (AttributeError, ValueError, OSError):  # pragma: no cover - non-POSIX
        return None


def _parse_stat(text: str, page_size: int | None) -> tuple[int, str, float | None] | None:
    """(ppid, name, rss_mb) from a /proc/<pid>/stat line, or None.

    The command name is the one field that may contain spaces and parentheses,
    so it is cut out by its *last* closing paren before anything else is split.
    Splitting the whole line on whitespace happens to work for `ffmpeg` and
    misreads anything wrapped in a name with a space in it.

    `stat` rather than `status`: it is one line instead of fifty, and this is
    read for every process on the runner every three seconds.
    """
    try:
        open_paren = text.index("(")
        close_paren = text.rindex(")")
    except ValueError:
        return None
    name = text[open_paren + 1:close_paren]
    fields = text[close_paren + 1:].split()
    # Fields are numbered from 1 with pid; after the name, fields[0] is field 3
    # (state), so ppid (4) is fields[1] and rss-in-pages (24) is fields[21].
    if len(fields) < 22:
        return None
    try:
        ppid = int(fields[1])
        rss_pages = int(fields[21])
    except ValueError:
        return None
    rss_mb = None if page_size is None else rss_pages * page_size / (1024 * 1024)
    return ppid, name, rss_mb


def _process_table(proc_root: Path) -> dict[int, tuple[int, ChildProcess]]:
    """Every readable process as pid -> (ppid, ChildProcess); empty on failure."""
    table: dict[int, tuple[int, ChildProcess]] = {}
    page_size = _page_size_bytes()
    try:
        entries = list(proc_root.iterdir())
    except OSError:
        return table  # no /proc at all: not Linux, or not readable
    for entry in entries:
        if not entry.name.isdigit():
            continue
        try:
            text = (entry / "stat").read_text()
        except OSError:
            continue  # the process exited between the listing and the read
        parsed = _parse_stat(text, page_size)
        if parsed is None:
            continue
        ppid, name, rss_mb = parsed
        pid = int(entry.name)
        table[pid] = (ppid, ChildProcess(pid, name, rss_mb))
    return table


def child_processes(pid: int | None = None, proc_root: Path = PROC_ROOT) -> list[ChildProcess]:
    """Every descendant of `pid`, heaviest first. Never raises.

    Descendants, not direct children: moviepy's ffmpeg processes are children
    today, but an ffmpeg behind a shell wrapper would put a generation in
    between and a direct-children count would then report zero while the
    machine filled up.
    """
    root = os.getpid() if pid is None else pid
    table = _process_table(proc_root)
    children_of: dict[int, list[int]] = {}
    for child_pid, (parent_pid, _) in table.items():
        children_of.setdefault(parent_pid, []).append(child_pid)

    found: list[ChildProcess] = []
    seen = {root}
    queue = list(children_of.get(root, ()))
    while queue:
        current = queue.pop()
        if current in seen:
            continue  # a process reparented mid-scan can otherwise loop
        seen.add(current)
        entry = table.get(current)
        if entry is not None:
            found.append(entry[1])
        queue.extend(children_of.get(current, ()))

    # Heaviest first, so the truncated tail of a long list is the cheap end.
    found.sort(key=lambda child: (-(child.rss_mb or 0.0), child.pid))
    return found


def describe_children(children: list[ChildProcess]) -> str:
    """The child processes as one line: how many, how much, and which."""
    if not children:
        return "no child processes"
    total = sum(child.rss_mb for child in children if child.rss_mb is not None)
    ffmpeg = sum(1 for child in children if "ffmpeg" in child.name.lower())
    named = children[:MAX_CHILDREN_NAMED]
    listing = "; ".join(child.describe() for child in named)
    if len(children) > len(named):
        listing += f"; +{len(children) - len(named)} more"
    return (
        f"{len(children)} child process(es) ({ffmpeg} ffmpeg) "
        f"totalling {total:.0f} MB — {listing}"
    )


# ------------------------------------------------------------------ Render stages

_stage_lock = threading.Lock()
_current_stage: str | None = None


def mark_stage(stage: str | None) -> None:
    """Name the work now in flight, so a spike can be attributed to it.

    The render is one call from the pipeline's point of view and half a dozen
    distinct phases inside it. A burst that cannot be pinned to a phase is only
    half an observation: "memory spiked" is what we already knew, "memory
    spiked while concatenating sections" is a lead. Callers pay one lock and
    one log line; passing None clears the label.
    """
    global _current_stage
    try:
        with _stage_lock:
            _current_stage = stage
        if stage is not None:
            logger.info("Stage: %s — %s", stage, describe_usage() or "memory unreadable")
    except Exception:  # pragma: no cover - a diagnostic must not throw
        pass


def current_stage() -> str | None:
    with _stage_lock:
        return _current_stage


class MemorySampler:
    """Log memory every `interval` seconds for the duration of a `with` block.

    Used around the render, which is the stage that has three times been
    killed. The thread is a daemon and every sample is guarded, so a failure to
    read /proc costs a missing log line and nothing else.

    Peaks are recorded with the stage that held them, so the summary alone —
    the part of the log a human reads first — says where the worst moment was.
    """

    def __init__(self, label: str, interval: float = DEFAULT_INTERVAL_SECONDS):
        self.label = label
        self.interval = interval
        self.peak_rss_mb: float | None = None
        self.peak_rss_stage: str | None = None
        self.min_available_mb: float | None = None
        self.min_available_stage: str | None = None
        self.total_mb: float | None = None
        self.peak_children: int = 0
        self.peak_children_stage: str | None = None
        self.peak_child_rss_mb: float | None = None
        self.peak_child_rss_stage: str | None = None
        # Every distinct pid ever seen under us. Twelve source files that each
        # keep one decoder alive look like twelve; twelve files whose decoder
        # is respawned on every seek look like sixty. That difference is the
        # whole question, and only a running total can answer it.
        self.child_pids_seen: set[int] = set()
        self.ffmpeg_pids_seen: set[int] = set()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def sample(self) -> None:
        """Take and log one sample, updating the peaks. Never raises."""
        try:
            stage = current_stage()
            rss = process_rss_mb()
            total, available = system_memory_mb()
            children = child_processes()

            if rss is not None and (self.peak_rss_mb is None or rss > self.peak_rss_mb):
                self.peak_rss_mb, self.peak_rss_stage = rss, stage
            if total is not None:
                self.total_mb = total
            if available is not None and (
                self.min_available_mb is None or available < self.min_available_mb
            ):
                self.min_available_mb, self.min_available_stage = available, stage
            if len(children) > self.peak_children:
                self.peak_children, self.peak_children_stage = len(children), stage
            child_rss = sum(c.rss_mb for c in children if c.rss_mb is not None)
            if children and (self.peak_child_rss_mb is None or child_rss > self.peak_child_rss_mb):
                self.peak_child_rss_mb, self.peak_child_rss_stage = child_rss, stage
            for child in children:
                self.child_pids_seen.add(child.pid)
                if "ffmpeg" in child.name.lower():
                    self.ffmpeg_pids_seen.add(child.pid)

            line = describe_usage()
            if line is not None:
                logger.info(
                    "Memory during %s [%s]: %s; %s",
                    self.label, stage or "no stage", line, describe_children(children),
                )
        except Exception:  # pragma: no cover - a diagnostic must not throw
            pass

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            self.sample()

    def __enter__(self) -> "MemorySampler":
        self.sample()  # a baseline, before anything the block does
        if describe_usage() is None:
            return self  # no /proc: stay silent rather than spawn a useless thread
        self._thread = threading.Thread(
            target=self._run, name=f"memory-sampler-{self.label}", daemon=True
        )
        self._thread.start()
        return self

    def __exit__(self, *exc_info) -> None:
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=self.interval + 1)
        self.sample()
        self._log_summary()
        # A stage label outlives its block otherwise, and a stale one attributes
        # the next block's spike to the wrong phase.
        mark_stage(None)

    def _log_summary(self) -> None:
        def during(stage: str | None) -> str:
            return "" if stage is None else f' (during "{stage}")'

        if self.peak_rss_mb is None and self.min_available_mb is None and not self.child_pids_seen:
            return
        peak = "unknown" if self.peak_rss_mb is None else f"{self.peak_rss_mb:.0f} MB"
        floor = (
            "unknown" if self.min_available_mb is None
            else f"{self.min_available_mb:.0f} MB"
        )
        used = ""
        if self.min_available_mb is not None and self.total_mb is not None:
            used = f", i.e. peak system use {self.total_mb - self.min_available_mb:.0f} MB"
        child_peak = (
            "unknown" if self.peak_child_rss_mb is None
            else f"{self.peak_child_rss_mb:.0f} MB"
        )
        logger.info(
            "Memory summary for %s: peak process RSS %s%s; least system memory "
            "available %s%s%s; peak %d concurrent child process(es)%s holding at "
            "most %s%s; %d distinct child pid(s) seen in total, %d of them ffmpeg",
            self.label,
            peak, during(self.peak_rss_stage),
            floor, used, during(self.min_available_stage),
            self.peak_children, during(self.peak_children_stage),
            child_peak, during(self.peak_child_rss_stage),
            len(self.child_pids_seen), len(self.ffmpeg_pids_seen),
        )
