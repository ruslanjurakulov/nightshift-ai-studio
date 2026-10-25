#!/usr/bin/env python3
"""Measure what an editor export costs: wall time, CPU time and peak memory per
output minute, per aspect ratio and per effect set.

    python tools/editor_export_cost.py --out-json cost.json --out-md cost.md
    python tools/editor_export_cost.py --plan          # list and validate the cases, render nothing
    python tools/editor_export_cost.py --length 60 --repeat 3 --aspects 16:9 9:16

Measurement only (CLAUDE.md rule 8: diagnose before you fix). It changes no
default, no limit and no production code path. The question it answers is the
one the export limits and the "free but bounded" decision (D3) cannot answer
without it: how much worker capacity does one output minute take, and does the
answer depend on the frame shape or on what the timeline uses?

What is measured is the REAL export path: ``editor_export.run_export`` (the
document is validated by ``modules/timeline.py``, laid out by
``timeline_render``, rendered by ``render_backend`` under the same
``ffmpeg_limits`` as a member's export: address-space limit, thread caps,
wall-clock budget). Only the database is replaced: a fake store hands out the
asset rows, and the last step (``store_generated``: the library's ingest of the
finished file) is replaced by a stub that records the file's size, so the
numbers are the render's, not the ingest's.

Media is synthetic (ffmpeg ``lavfi`` sources: no external file, no download).
That is a floor, not a typical case: a test pattern decodes faster than camera
footage, so the decode share of the cost is understated.

One case = one fresh Python process, so the peak memory of one case cannot
carry over into the next. Each case is a timeline of about ``--length`` seconds
(default 20) of 1080p-class output; "per output minute" is the measured number
scaled by 60 / the timeline's length, which assumes cost grows linearly with
length. Run two lengths (``--length 30`` and ``--length 90``) to see whether it
does. Peak memory is NOT scaled: it is the largest single process (the ffmpeg
doing the final pass), which does not grow with the length of the video.

Numbers that could not be measured are null / "n/a", never 0. A case whose
export failed contributes no timing at all (a failed render's time is not the
cost of a render). Without ffmpeg the tool says so and skips; it never reports
numbers it did not measure.

Not covered: fit ``blur`` (the "resize for all ratios" path), overlays and
shapes, chroma key, stabilise and interpolated slow motion, 4K frames.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import resource
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from modules import speed_ramp  # noqa: E402  (pure: no ffmpeg, no database)
from modules import timeline as tl  # noqa: E402

#: The frame shapes measured: the three the editor offers today.
ASPECTS = tuple(tl.PRESETS)
#: The effect sets, from the cheapest to the dearest guess. ``plain`` is hard
#: cuts with the clips' own sound and a music bed: every other set is this plus
#: ONE thing, so a difference is that thing's.
EFFECTS = ("plain", "captions", "transitions", "speed_curve")

DEFAULT_LENGTH_S = 20.0
MIN_LENGTH_S = 10.0
#: The tool's own ceiling (the export's is tl-side 1800 s): a measurement that
#: takes an hour is not a measurement anyone repeats.
MAX_LENGTH_S = 300.0
MAX_REPEAT = 5

#: Length of the one synthetic source video, and the length one clip aims for.
SOURCE_S = 10.0
CLIP_TARGET_S = 5.0
XFADE_S = 0.5
XFADE_STYLES = ("fade", "wipeleft", "circleopen")
CUE_EVERY_S = 2.0
CUE_TEXTS = ("Every clip is referenced by id", "and rendered by one engine",
             "so the same document", "gives the same video")
#: A ramp that speeds up to 2x in the middle and slows to half speed at the end.
SPEED_CURVE = [{"at": 0, "speed": 1}, {"at": 0.5, "speed": 2}, {"at": 1, "speed": 0.5}]

#: Fixed, canonical ids: the document names assets by id and never by path.
VIDEO_ID = "11111111-1111-4111-8111-111111111111"
MUSIC_ID = "22222222-2222-4222-8222-222222222222"
EXPORT_ID = "33333333-3333-4333-8333-333333333333"
ORG_ID = "44444444-4444-4444-8444-444444444444"
PROJECT_ID = "55555555-5555-4555-8555-555555555555"
STORED_ID = "66666666-6666-4666-8666-666666666666"


@dataclass(frozen=True)
class Case:
    aspect: str
    effect: str
    length_s: float


# ── the timelines ───────────────────────────────────────────────────────────

def _ms(x: float) -> float:
    return round(float(x), 3)


def build_doc(case: Case) -> dict:
    """The timeline document of one case: the same clips, sound and music in
    every set, plus the one thing the set is named for. Pure."""
    width, height = tl.PRESETS[case.aspect]
    n = max(2, round(case.length_s / CLIP_TARGET_S))
    overlap = XFADE_S if case.effect == "transitions" else 0.0
    # Clip length on the timeline, such that n clips (less their overlaps) fill the length.
    each = _ms((case.length_s + (n - 1) * overlap) / n)
    clips: List[dict] = []
    cursor = 0.0
    for i in range(n):
        clip = {"id": f"c{i + 1}", "asset_id": VIDEO_ID, "start_s": _ms(cursor), "in_s": 0,
                "out_s": each, "fit": "cover", "audio": True}
        if case.effect == "speed_curve":
            # The range is chosen so the ramped clip lasts about ``each`` (its length is the
            # integral of 1/speed over the range, in fractions of the range).
            k = speed_ramp.out_length(speed_ramp.absolute(
                [(p["at"], p["speed"]) for p in SPEED_CURVE], 1.0))
            clip["out_s"] = _ms(min(SOURCE_S, each / k))
            clip["speed_curve"] = [dict(p) for p in SPEED_CURVE]
        if case.effect == "transitions" and i > 0:
            clip["transition"] = {"type": "crossfade", "duration_s": overlap,
                                  "style": XFADE_STYLES[i % len(XFADE_STYLES)]}
        clips.append(clip)
        cursor = _ms(cursor + tl.clip_length_s(clip) - overlap)
    length = _ms(cursor + overlap)
    doc = {"version": 1, "width": width, "height": height, "fps": 30,
           "tracks": [
               {"id": "v1", "kind": "V", "clips": clips},
               {"id": "music", "kind": "A", "clips": [
                   {"id": "m1", "asset_id": MUSIC_ID, "start_s": 0, "in_s": 0,
                    "out_s": _ms(length), "gain_db": -14}]}]}
    if case.effect == "captions":
        cues, t, i = [], 0.0, 0
        while t + CUE_EVERY_S <= length + 1e-9:
            cues.append({"id": f"k{i + 1}", "start_s": _ms(t), "end_s": _ms(t + CUE_EVERY_S - 0.2),
                         "text": CUE_TEXTS[i % len(CUE_TEXTS)]})
            t, i = t + CUE_EVERY_S, i + 1
        doc["captions"] = {"cues": cues}
    return doc


def plan(aspects: Sequence[str], effects: Sequence[str], length_s: float) -> List[Case]:
    return [Case(a, e, length_s) for a in aspects for e in effects]


def check_args(aspects: Sequence[str], effects: Sequence[str], length_s: float, repeat: int) -> List[str]:
    problems = []
    for a in aspects:
        if a not in ASPECTS:
            problems.append(f"unknown aspect {a!r}; one of {', '.join(ASPECTS)}")
    for e in effects:
        if e not in EFFECTS:
            problems.append(f"unknown effect set {e!r}; one of {', '.join(EFFECTS)}")
    if not (MIN_LENGTH_S <= length_s <= MAX_LENGTH_S):
        problems.append(f"--length must be {MIN_LENGTH_S:g} to {MAX_LENGTH_S:g} seconds")
    if not (1 <= repeat <= MAX_REPEAT):
        problems.append(f"--repeat must be 1 to {MAX_REPEAT}")
    return problems


# ── the report ──────────────────────────────────────────────────────────────

def per_minute(value: Optional[float], output_s: Optional[float]) -> Optional[float]:
    """``value`` (seconds, MB…) scaled to one output minute. Unknown stays
    unknown: no value or no length is None, never 0."""
    if value is None or not output_s or output_s <= 0:
        return None
    return round(value * 60.0 / output_s, 2)


def _median(values: List[float]) -> Optional[float]:
    return round(statistics.median(values), 2) if values else None


def _usable(run: dict) -> bool:
    return run.get("status") == "done" and run.get("wall_s") is not None


def summarise(case: Case, output_s: Optional[float], runs: List[dict]) -> dict:
    """One row of the report from the runs of one case. Only a finished export
    counts; the median is taken over those, and the failures are listed."""
    good = [r for r in runs if _usable(r)]

    def med(key: str, scale: bool) -> Optional[float]:
        vals = [r[key] for r in good if r.get(key) is not None]
        m = _median(vals)
        return per_minute(m, output_s) if scale else m

    return {
        "aspect": case.aspect, "effect": case.effect, "output_s": output_s,
        "runs": len(runs), "ok_runs": len(good),
        "failed": sorted({str(r.get("reason") or r.get("status") or "unknown")
                          for r in runs if not _usable(r)}),
        "wall_s_per_min": med("wall_s", True),
        "cpu_s_per_min": med("cpu_s", True),
        "output_mb_per_min": med("output_mb", True),
        # Not scaled by length: the largest single process does not grow with the video.
        "peak_rss_mb": med("peak_rss_mb", False),
        "raw_runs": runs,
    }


def run_matrix(cases: Sequence[Case], runner: Callable[[Case], dict], repeat: int) -> List[dict]:
    """Every case ``repeat`` times through ``runner`` (which returns one raw
    measurement). The output length is the VALIDATED timeline's, frame-exact."""
    rows = []
    for case in cases:
        output_s = tl.duration_s(tl.load(build_doc(case)))
        runs = [runner(case) for _ in range(repeat)]
        rows.append(summarise(case, output_s, runs))
    return rows


def _fmt(v, unit: str = "") -> str:
    return "n/a" if v is None else f"{v}{unit}"


def render_markdown(report: dict) -> str:
    if report.get("skipped"):
        return f"## Editor export cost\n\nSKIPPED: {report['reason']}\n"
    env = report["environment"]
    lines = ["## Editor export cost", "", "| Environment | |", "|---|---|"]
    lines += [f"| {k} | {str(v).replace('|', '/')} |" for k, v in env.items()]
    lines += ["", f"Timeline length {report['length_s']:g} s, {report['repeat']} run(s) per case "
                  "(median). Per-minute columns are scaled from that length.", "",
              "| Aspect | Effect set | Output s | Wall s/min | CPU s/min | Peak RSS MB | Output MB/min | OK runs |",
              "|---|---|---|---|---|---|---|---|"]
    for r in report["rows"]:
        failed = f" ({', '.join(r['failed'])})" if r["failed"] else ""
        lines.append(f"| {r['aspect']} | {r['effect']} | {_fmt(r['output_s'])} | {_fmt(r['wall_s_per_min'])} | "
                     f"{_fmt(r['cpu_s_per_min'])} | {_fmt(r['peak_rss_mb'])} | {_fmt(r['output_mb_per_min'])} | "
                     f"{r['ok_runs']}/{r['runs']}{failed} |")
    lines += ["", "_n/a = not measured (the export failed or the value was unavailable). Wall time depends on "
              "what else the host is doing (see the load averages above); CPU time is the steadier number. Peak RSS is the "
              "largest single process (the ffmpeg final pass), not scaled by length. Synthetic test-pattern "
              "sources decode faster than camera footage, so these are floors. A sandbox is not the "
              "production worker: use the ratios, not the absolute numbers, to pick what to measure there._"]
    return "\n".join(lines) + "\n"


def load_average_1m() -> Optional[float]:
    """The host's 1-minute load average, or None where the OS has none."""
    try:
        return round(os.getloadavg()[0], 2)
    except (OSError, AttributeError):
        return None


def collect_environment(ffmpeg: str, load_start: Optional[float] = None) -> Dict[str, object]:
    """What a reader needs to judge the numbers, and nothing that identifies a
    machine or a person (no host name, no path, no user). The load average is
    there because wall time on a busy host is noise (CPU time is not): a run
    that started at load 11 on 4 cores is not a measurement of the render."""
    version = None
    try:
        out = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True, timeout=20).stdout
        version = out.splitlines()[0][:80] if out else None
    except (OSError, subprocess.SubprocessError):
        pass
    mem_mb = None
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                mem_mb = round(int(line.split()[1]) / 1024)
    except (OSError, ValueError):
        pass
    from modules import ffmpeg_limits as fl
    return {"ffmpeg": version, "cpu_count": os.cpu_count(), "memory_total_mb": mem_mb,
            "python": platform.python_version(), "os": platform.system(),
            "load_average_1m_at_start": load_start, "load_average_1m_at_end": load_average_1m(),
            "child_address_space_mb": fl.CHILD_MEM_BYTES // 2 ** 20,
            "decoder_threads": fl.DECODE_THREADS, "encoder_threads": fl.ENCODE_THREADS}


# ── one case, in its own process ────────────────────────────────────────────

def _cpu_s() -> float:
    """CPU seconds used by this process and every child it has waited for."""
    own, kids = resource.getrusage(resource.RUSAGE_SELF), resource.getrusage(resource.RUSAGE_CHILDREN)
    return own.ru_utime + own.ru_stime + kids.ru_utime + kids.ru_stime


def _peak_child_rss_mb() -> Optional[float]:
    kb = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    if kb <= 0:
        return None
    # Linux reports kilobytes, macOS bytes.
    return round(kb / (1048576.0 if sys.platform == "darwin" else 1024.0), 1)


def make_sources(ffmpeg: str, media_root: Path, length_s: float) -> None:
    """The two synthetic files, at the paths the library would keep them
    (``media_library.asset_file``): a 1080p30 clip with sound, and a sine
    music bed. ffmpeg's own ``lavfi`` generators; nothing is downloaded."""
    from modules import media_library as ml
    jobs = [
        (VIDEO_ID, "mp4", ["-f", "lavfi", "-i", f"testsrc2=size=1920x1080:rate=30:duration={SOURCE_S:g}",
                           "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={SOURCE_S:g}",
                           "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac",
                           "-shortest"]),
        (MUSIC_ID, "wav", ["-f", "lavfi", "-i", f"sine=frequency=220:sample_rate=48000:duration={length_s + 2:g}",
                           "-c:a", "pcm_s16le"]),
    ]
    for asset_id, fmt, args in jobs:
        dest = ml.asset_file(media_root, asset_id, "original")
        dest.parent.mkdir(parents=True, exist_ok=True)
        proc = subprocess.run([ffmpeg, "-v", "error", "-y", *args, "-f", fmt, str(dest)],
                              capture_output=True, timeout=300)
        if proc.returncode != 0 or not dest.is_file():
            raise RuntimeError(f"could not generate the synthetic {fmt} source (ffmpeg exit {proc.returncode})")


class _Store:
    """The database, as far as one export touches it."""

    def __init__(self, length_s: float):
        self.rows = [
            {"id": VIDEO_ID, "kind": "video", "mime": "video/mp4", "duration_s": SOURCE_S, "variants": []},
            {"id": MUSIC_ID, "kind": "audio", "mime": "audio/wav", "duration_s": length_s + 2, "variants": []}]
        self.finished: List[tuple] = []

    def export_assets(self, export_id):
        return self.rows

    def export_heartbeat(self, export_id, worker_id):
        return True

    def finish_export(self, export_id, worker_id, asset_id, reason):
        self.finished.append((asset_id, reason))
        return "done" if asset_id else "failed"


def measure_case(case: Case, media_root: Path, ffmpeg: str, ffprobe: Optional[str]) -> dict:
    """Run one case through ``editor_export.run_export`` and measure it. Meant
    to be the only export in this process (peak memory is the process's)."""
    from modules import editor_export
    from modules import media_library as ml

    doc = build_doc(case)
    store = _Store(case.length_s)
    seen: Dict[str, object] = {}

    def store_file(path, **_kw):
        # The ingest of the finished file is not part of the render's cost: record the file, stop.
        seen["output_mb"] = round(Path(path).stat().st_size / 1048576.0, 2)
        if ffprobe:
            try:
                proc = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration",
                                       "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
                                      capture_output=True, text=True, timeout=60)
                seen["output_probe_s"] = round(float(proc.stdout.strip()), 2)
            except (OSError, ValueError, subprocess.SubprocessError):
                pass
        return {"id": STORED_ID}

    export = {"id": EXPORT_ID, "org_id": ORG_ID, "project_id": PROJECT_ID, "rev": 1,
              "duration_s": tl.duration_s(tl.load(doc)), "doc": doc}
    cpu0, t0 = _cpu_s(), time.monotonic()
    status = editor_export.run_export(
        export, store=store, media_root=media_root, worker_id="export-cost", tools=ml.Tools(ffprobe or "", ffmpeg),
        store_file=store_file, has_audio=lambda path, mime: True)
    wall, cpu = time.monotonic() - t0, _cpu_s() - cpu0
    reason = store.finished[-1][1] if store.finished else None
    return {"status": status, "reason": reason, "wall_s": round(wall, 2), "cpu_s": round(cpu, 2),
            "peak_rss_mb": _peak_child_rss_mb(), "output_mb": seen.get("output_mb"),
            "output_probe_s": seen.get("output_probe_s")}


def subprocess_runner(media_root: Path, ffmpeg: str, ffprobe: Optional[str]) -> Callable[[Case], dict]:
    """A runner that measures each case in a fresh Python process."""
    def run(case: Case) -> dict:
        cmd = [sys.executable, str(Path(__file__).resolve()), "_case", "--media-root", str(media_root),
               "--aspect", case.aspect, "--effect", case.effect, "--length", repr(case.length_s),
               "--ffmpeg", ffmpeg, "--ffprobe", ffprobe or ""]
        budget = min(tl.RENDER_TIMEOUT_MAX_S, tl.RENDER_TIMEOUT_PER_S * case.length_s + tl.RENDER_TIMEOUT_BASE_S) + 120
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=budget, cwd=str(ROOT))
        except subprocess.TimeoutExpired:
            return {"status": "failed", "reason": "tool_timeout"}
        last = (proc.stdout.strip().splitlines() or [""])[-1]
        try:
            result = json.loads(last)
        except ValueError:
            result = None
        if proc.returncode != 0 or not isinstance(result, dict):
            return {"status": "failed", "reason": "case_crashed"}
        return result
    return run


# ── command line ────────────────────────────────────────────────────────────

def _find_tools(ffmpeg_arg: Optional[str]) -> tuple:
    ffmpeg = ffmpeg_arg or shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    return ffmpeg, ffprobe


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd")
    case = sub.add_parser("_case", help=argparse.SUPPRESS)
    case.add_argument("--media-root", required=True)
    case.add_argument("--aspect", required=True)
    case.add_argument("--effect", required=True)
    case.add_argument("--length", type=float, required=True)
    case.add_argument("--ffmpeg", required=True)
    case.add_argument("--ffprobe", default="")
    ap.add_argument("--aspects", nargs="+", default=list(ASPECTS), metavar="ASPECT")
    ap.add_argument("--effects", nargs="+", default=list(EFFECTS), metavar="SET")
    ap.add_argument("--length", type=float, default=DEFAULT_LENGTH_S, help="timeline length in seconds")
    ap.add_argument("--repeat", type=int, default=1, help="runs per case (the median is reported)")
    ap.add_argument("--ffmpeg", help="path to ffmpeg (default: the one on PATH)")
    ap.add_argument("--workdir", help="where the synthetic sources and renders live (default: a temp folder)")
    ap.add_argument("--plan", action="store_true", help="list and validate the cases, render nothing")
    ap.add_argument("--out-json")
    ap.add_argument("--out-md")
    args = ap.parse_args(argv)

    if args.cmd == "_case":
        result = measure_case(Case(args.aspect, args.effect, args.length), Path(args.media_root).resolve(),
                              args.ffmpeg, args.ffprobe or None)
        print(json.dumps(result))
        return 0

    problems = check_args(args.aspects, args.effects, args.length, args.repeat)
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 2
    cases = plan(args.aspects, args.effects, args.length)

    if args.plan:
        for c in cases:
            norm = tl.load(build_doc(c))  # raises TimelineError when a case is not a valid timeline
            print(f"{c.aspect:5} {c.effect:12} {tl.duration_s(norm):7.2f} s  "
                  f"{sum(len(t['clips']) for t in norm['tracks'] if t['kind'] == 'V')} video clips")
        return 0

    ffmpeg, ffprobe = _find_tools(args.ffmpeg)
    if not ffmpeg or not (Path(ffmpeg).is_file() or shutil.which(ffmpeg)):
        reason = ("ffmpeg was not found on PATH (or at --ffmpeg), so nothing was rendered and nothing was "
                  "measured. Install ffmpeg and run this again, or run it on the worker.")
        print(f"SKIPPED: {reason}")
        report = {"skipped": True, "reason": reason}
    else:
        # Absolute: the timeline refuses a relative file path (the resolver answers with absolute ones).
        work = (Path(args.workdir) if args.workdir else Path(tempfile.mkdtemp(prefix="export-cost-"))).resolve()
        work.mkdir(parents=True, exist_ok=True)
        load_start = load_average_1m()
        try:
            make_sources(ffmpeg, work, args.length)
            rows = run_matrix(cases, subprocess_runner(work, ffmpeg, ffprobe), args.repeat)
        finally:
            if not args.workdir:
                shutil.rmtree(work, ignore_errors=True)
        report = {"skipped": False, "length_s": args.length, "repeat": args.repeat,
                  "environment": collect_environment(ffmpeg, load_start), "rows": rows}
        print(render_markdown(report))
    if args.out_json:
        Path(args.out_json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out_json).write_text(json.dumps(report, indent=2), encoding="utf-8")
    if args.out_md:
        Path(args.out_md).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out_md).write_text(render_markdown(report), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
