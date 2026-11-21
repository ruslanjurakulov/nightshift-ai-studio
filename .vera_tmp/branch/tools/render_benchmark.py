#!/usr/bin/env python3
"""Helpers for the render benchmark workflow (.github/workflows/render_benchmark.yml).

Two subcommands, both local and side-effect free apart from the files they write:

    python tools/render_benchmark.py script --repeat 3 --out bench/script.json
        Write a benchmark script: samples/demo_script.json with its sections
        repeated N times. The demo script narrates for roughly three to four
        minutes; repeating it is the only honest way to get a longer render out
        of the pipeline without a paid Gemini call. The narration is real and
        is synthesised, transcribed and rendered like any other run — it is just
        the same story told N times. The b-roll pool does NOT grow with it (the
        pipeline fetches a fixed 12 videos / 8 images), so a longer benchmark
        reuses clips more often. The report states the MEASURED duration, never
        the nominal one.

    python tools/render_benchmark.py report --time-file ... --mem-file ... \
        --log logs/run.log --exit-code 0 --backend ffmpeg --repeat 3 \
        --out-md bench/summary.md --out-json bench/result.json
        Turn `/usr/bin/time -v` output, a MemAvailable sample log and the run
        log into a markdown table + a JSON record. A number that could not be
        measured is reported as null / "n/a", never as 0. An ffmpeg-backend run
        also gets its per-stage split (segment normalisation, final pass) from
        the backend's `ffmpeg render timing:` log line.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
DEMO_SCRIPT = ROOT / "samples" / "demo_script.json"
MAX_REPEAT = 5


# ── script ──────────────────────────────────────────────────────────────────

def repeated_script(data: dict, repeat: int) -> dict:
    """`data` with its sections repeated `repeat` times (clamped to 1..MAX_REPEAT).
    Repeated sections get a `_rN` name suffix and are all "story" sections after
    the first pass, so only the real opening is treated as a hook."""
    repeat = max(1, min(MAX_REPEAT, int(repeat)))
    base = list(data.get("sections") or [])
    sections = []
    for r in range(repeat):
        for s in base:
            s = dict(s)
            if r > 0:
                s["name"] = f"{s.get('name', 'section')}_r{r + 1}"
                s["type"] = "story"
            sections.append(s)
    out = dict(data)
    out["sections"] = sections
    return out


# ── report ──────────────────────────────────────────────────────────────────

def parse_time_v(text: str) -> dict:
    """The fields we need from GNU `/usr/bin/time -v` output."""
    out: dict = {"max_rss_mb": None, "wall_s": None, "time_exit_status": None, "signal": None}
    m = re.search(r"Maximum resident set size \(kbytes\):\s*(\d+)", text)
    if m:
        out["max_rss_mb"] = round(int(m.group(1)) / 1024.0, 1)
    m = re.search(r"Elapsed \(wall clock\) time \(h:mm:ss or m:ss\):\s*([\d:.]+)", text)
    if m:
        parts = [float(p) for p in m.group(1).split(":")]
        secs = 0.0
        for p in parts:
            secs = secs * 60 + p
        out["wall_s"] = round(secs, 1)
    m = re.search(r"Exit status:\s*(\d+)", text)
    if m:
        out["time_exit_status"] = int(m.group(1))
    m = re.search(r"Command terminated by signal (\d+)", text)
    if m:
        out["signal"] = int(m.group(1))
    return out


def parse_mem_samples(text: str, mem_total_kb: Optional[int]) -> dict:
    """Peak system memory in use, from `MemAvailable` samples (one kB value per
    line). This is what an OOM kill (exit 143/137) is about: the whole runner,
    ffmpeg children included — not one process's RSS."""
    vals = []
    for line in (text or "").splitlines():
        tok = line.strip().split()
        if tok and tok[-1].isdigit():
            vals.append(int(tok[-1]))
    if not vals or not mem_total_kb:
        return {"peak_system_used_mb": None, "baseline_system_used_mb": None,
                "min_available_mb": None, "mem_samples": len(vals)}
    lo = min(vals)
    return {
        "peak_system_used_mb": round((mem_total_kb - lo) / 1024.0, 1),
        # In use before the pipeline started — the runner's own floor.
        "baseline_system_used_mb": round((mem_total_kb - vals[0]) / 1024.0, 1),
        "min_available_mb": round(lo / 1024.0, 1),
        "mem_samples": len(vals),
    }


_TS = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),(\d{3})")


def _ts(line: str) -> Optional[datetime]:
    m = _TS.match(line)
    if not m:
        return None
    return datetime.strptime(f"{m.group(1)}.{m.group(2)}", "%Y-%m-%d %H:%M:%S.%f")


#: modules/render_backend.RenderTimings.log_line — one line per ffmpeg render.
_TIMING = re.compile(r"ffmpeg render timing: (.*)$")
_TIMING_FLOATS = ("normalize_s", "normalize_avg_s", "concat_s", "final_s", "total_s")
_TIMING_KEYS = {"normalize_s": "normalize_s", "normalize_avg_s": "normalize_avg_s",
                "concat_s": "concat_s", "final_s": "final_s", "total_s": "ffmpeg_total_s",
                "segments": "segments", "jobs": "render_jobs", "mode": "render_mode"}


def parse_render_timing(text: str) -> dict:
    """The ffmpeg backend's per-stage timing from the run log (its last
    ``ffmpeg render timing:`` line). ``na``, a missing key, an unparseable
    value or no line at all is None — never 0."""
    out: dict = {v: None for v in _TIMING_KEYS.values()}
    line = None
    for raw in (text or "").splitlines():
        m = _TIMING.search(raw)
        if m:
            line = m.group(1)
    if line is None:
        return out
    for tok in line.split():
        key, _, val = tok.partition("=")
        if key not in _TIMING_KEYS or not val or val == "na":
            continue
        try:
            if key in _TIMING_FLOATS:
                parsed = round(float(val), 2)
            elif key in ("segments", "jobs"):
                parsed = int(val)
            else:
                parsed = val
        except ValueError:
            continue
        out[_TIMING_KEYS[key]] = parsed
    return out


def parse_run_log(text: str) -> dict:
    """Which backend rendered, why a fallback happened, and how long the render
    stage took (first render line → the pipeline's "Video:" line)."""
    out: dict = {"backend_used": None, "fallback_reason": None, "render_s": None}
    start = end = None
    for line in (text or "").splitlines():
        m = re.search(r"Render backend used: (\w+)", line)
        if m:
            out["backend_used"] = m.group(1)
        m = re.search(r"ffmpeg render backend not used \((.*)\) — falling back", line)
        if m:
            out["fallback_reason"] = m.group(1)[:300]
        if start is None and ("Rendering with the ffmpeg backend" in line
                              or "Starting render for" in line):
            start = _ts(line)
        if "chronos: Video: " in line:
            end = _ts(line)
    if start and end and end >= start:
        out["render_s"] = round((end - start).total_seconds(), 1)
    out.update(parse_render_timing(text))
    return out


def probe_video(path: Optional[Path]) -> dict:
    """Size and duration of the rendered file (ffprobe when present)."""
    out: dict = {"output": None, "output_mb": None, "output_duration_s": None}
    if path is None or not path.exists():
        return out
    out["output"] = str(path)
    out["output_mb"] = round(path.stat().st_size / 1048576.0, 1)
    probe = shutil.which("ffprobe")
    if probe:
        try:
            proc = subprocess.run(
                [probe, "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
                capture_output=True, text=True, timeout=60)
            if proc.returncode == 0 and proc.stdout.strip():
                out["output_duration_s"] = round(float(proc.stdout.strip()), 1)
        except Exception:
            pass
    return out


def _fmt(v, unit: str = "") -> str:
    return "n/a" if v is None else f"{v}{unit}"


def _workers(r: dict) -> str:
    vals = (r.get("segments"), r.get("render_jobs"), r.get("render_mode"))
    return "n/a" if all(v is None for v in vals) else " / ".join(_fmt(v) for v in vals)


def _concat(r: dict) -> str:
    if r.get("concat_s") is not None:
        return f"{r['concat_s']} s"
    # The backend concatenates inside the final pass (concat demuxer), so there
    # is no separate number to report — say where the time is instead.
    return "n/a (inside final pass)" if r.get("final_s") is not None else "n/a"


def render_markdown(r: dict) -> str:
    rows = [
        ("Backend requested", r.get("backend_requested")),
        ("Backend used", _fmt(r.get("backend_used"))),
        ("Fallback reason", _fmt(r.get("fallback_reason"))),
        ("Script repeat", r.get("repeat")),
        ("Exit code", r.get("exit_code")),
        ("Killed by signal", _fmt(r.get("signal"))),
        ("Wall time (whole run)", _fmt(r.get("wall_s"), " s")),
        ("Render stage time", _fmt(r.get("render_s"), " s")),
        ("ffmpeg: segments / workers / mode", _workers(r)),
        ("ffmpeg: normalize segments (total)", _fmt(r.get("normalize_s"), " s")),
        ("ffmpeg: normalize per segment (avg)", _fmt(r.get("normalize_avg_s"), " s")),
        ("ffmpeg: concat", _concat(r)),
        ("ffmpeg: final pass (concat + captions + audio + encode)", _fmt(r.get("final_s"), " s")),
        ("Peak RSS (largest single process)", _fmt(r.get("max_rss_mb"), " MB")),
        ("Peak system memory in use", _fmt(r.get("peak_system_used_mb"), " MB")),
        ("System memory in use at start", _fmt(r.get("baseline_system_used_mb"), " MB")),
        ("Min MemAvailable", _fmt(r.get("min_available_mb"), " MB")),
        ("Output size", _fmt(r.get("output_mb"), " MB")),
        ("Output duration", _fmt(r.get("output_duration_s"), " s")),
    ]
    lines = ["## Render benchmark", "", "| Metric | Value |", "|---|---|"]
    lines += [f"| {k} | {str(v).replace('|', '/')} |" for k, v in rows]
    lines += ["", "_n/a = not measured. Peak RSS is the largest single process "
              "(GNU time); peak system memory is MemTotal − min(MemAvailable) "
              "sampled every 2 s, which includes every ffmpeg child._"]
    return "\n".join(lines) + "\n"


def build_report(args) -> dict:
    def read(p):
        try:
            return Path(p).read_text(encoding="utf-8", errors="replace") if p else ""
        except OSError:
            return ""

    mem_total = None
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                mem_total = int(line.split()[1])
    except OSError:
        pass

    video = None
    if args.video:
        video = Path(args.video)
    else:
        found = sorted(Path("output").glob("*/final_video.mp4"))
        video = found[0] if found else None

    report = {
        "backend_requested": args.backend,
        "repeat": args.repeat,
        "exit_code": args.exit_code,
    }
    report.update(parse_time_v(read(args.time_file)))
    report.update(parse_mem_samples(read(args.mem_file), mem_total))
    report.update(parse_run_log(read(args.log)))
    report.update(probe_video(video))
    return report


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("script", help="write a repeated demo script")
    s.add_argument("--repeat", type=int, default=1)
    s.add_argument("--source", default=str(DEMO_SCRIPT))
    s.add_argument("--out", required=True)

    r = sub.add_parser("report", help="summarise one benchmark run")
    r.add_argument("--time-file")
    r.add_argument("--mem-file")
    r.add_argument("--log")
    r.add_argument("--video")
    r.add_argument("--exit-code", type=int, required=True)
    r.add_argument("--backend", required=True)
    r.add_argument("--repeat", type=int, default=1)
    r.add_argument("--out-md", required=True)
    r.add_argument("--out-json", required=True)

    args = ap.parse_args(argv)
    if args.cmd == "script":
        data = json.loads(Path(args.source).read_text(encoding="utf-8"))
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(repeated_script(data, args.repeat), indent=2, ensure_ascii=False),
                       encoding="utf-8")
        print(f"wrote {out} ({len(repeated_script(data, args.repeat)['sections'])} sections)")
        return 0

    report = build_report(args)
    Path(args.out_json).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out_json).write_text(json.dumps(report, indent=2), encoding="utf-8")
    Path(args.out_md).write_text(render_markdown(report), encoding="utf-8")
    print(render_markdown(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
