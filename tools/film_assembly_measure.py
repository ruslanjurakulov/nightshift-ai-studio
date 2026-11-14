#!/usr/bin/env python3
"""Film Studio P0: measure a 10-15 minute film assembly through the editor's render path.

Measurement only (CLAUDE.md rule 8): this writes no production state, calls no provider and spends
nothing. The numbers it produces are in docs/FILM_ASSEMBLY_MEASUREMENT.md, with the commands.

    python3.11 tools/film_assembly_measure.py generate --dir D --res 1080
        Synthetic source media, made locally by ffmpeg: a pool of silent H.264 clips of 6-10 s at
        24 and 30 fps (the shape of an i2v provider's output), one film-long narration take (mono
        MP3, speech-like bursts and pauses) and a 240 s stereo music bed (AAC). Three kinds of
        picture are mixed, because what a clip shows decides how big the render's intermediates
        are: a Mandelbrot zoom (fine detail in constant motion, the worst of the three), a moving
        test pattern, and smooth drifting gradients.

    python3.11 tools/film_assembly_measure.py run --dir D --res 1080 --minutes 10 --work W \
            --out result.json [--cgroup /sys/fs/cgroup/memory/.../film-measure --mem-limit 4g] \
            [--assume-free-mb N] [--timeout-s S] [--scenes N] [--narration-clock scene|film]
            [--narration-loudnorm 1]
        Builds a timeline document in the editor's format (modules/timeline.py) - 60 scenes of 1-3
        shots, a cross-fade between scenes and a cut between the shots of a scene, the narration
        cut into one A clip per scene (or one clip, ``--narration-clock film``; the editor's
        per-clip loudnorm only with ``--narration-loudnorm 1``), a music bed under it
        ducked by the editor's duck envelope, and burned captions - and renders it with EXACTLY the
        call an editor export makes (editor_export.run_export): timeline_render.render(norm,
        resolver, out, ffmpeg=..., workdir=..., jobs=1, timeout_s=...). Every ffmpeg therefore runs
        under ffmpeg_limits (2 GiB address space each, two decode / four encode threads).

        Measured: wall time, CPU time of every child (getrusage RUSAGE_CHILDREN), each ffmpeg's
        peak RSS (wait4, as ffmpeg_limits reports it), the memory cgroup's peak (page cache
        included, as a container's limit counts it) and its anonymous RSS sampled every 0.5 s, the
        work directory's peak size sampled every second, and the output's size, length and
        integrated loudness (ebur128, run after the render: analysis, not part of the path).

        ``--cgroup`` moves this process (and so every ffmpeg) into a cgroup-v1 memory group with
        ``--mem-limit`` (the media-worker's ``mem_limit: 4g``). ``--assume-free-mb`` tells the
        backend's disk guard (render_backend.intermediate_x264) that much free space, as the
        production media volume would report: without it a short disk makes the guard choose the
        slower compact intermediates, which is a different render. The guard's choice is
        recorded either way. ``--timeout-s`` is the deadline handed to the render; the editor's
        own budget (timeline.render_timeout_s) is recorded next to the wall time, so a run that
        would have been killed in production says so instead of silently getting more time.

    python3.11 tools/film_assembly_measure.py table results/*.json
        The markdown table of the doc.

Nothing here is imported by production code.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import resource
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from modules import ffmpeg_limits, render_backend, timeline_render  # noqa: E402
from modules import timeline as tl  # noqa: E402

FRAMES = {"1080": (1920, 1080), "720": (1280, 720)}
#: Bitrates of the synthetic clips: what i2v providers commonly deliver at these sizes. Chosen,
#: not measured from a provider (no provider is called here).
CLIP_BITRATE = {"1080": "8M", "720": "5M"}
POOL = 12
MUSIC_S = 240.0
SCENES = 60
XFADE_S = 0.5
NARRATION_LEAD_S = 0.25
NARRATION_TAIL_S = 0.75
CUE_S = 3.0
MUSIC_GAIN_DB = -18.0
DUCK_DB = 12.0
FPS = 30


def _ff(args: List[str]) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def _probe_duration(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of",
                          "default=nw=1:nk=1", str(path)], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def _picture(kind: int, w: int, h: int, fps: int, seed: int) -> str:
    # Each source is generated small and scaled up where the generator is slow; the encode at the
    # provider's bitrate is what the render decodes.
    if kind == 0:
        return (f"mandelbrot=s={w // 2}x{h // 2}:r={fps}:start_scale={2.5 + seed * 0.1}:end_scale=0.05,"
                f"scale={w}:{h}:flags=bicubic,hue=h={seed * 25}")
    if kind == 1:
        return f"testsrc2=s={w}x{h}:r={fps},hue=h=18*t+{seed * 30}"
    return (f"gradients=s={w // 4}x{h // 4}:r={fps}:speed=0.02:n=5:seed={seed},"
            f"scale={w}:{h}:flags=bicubic")


def generate(d: Path, res: str, film_s: float) -> None:
    w, h = FRAMES[res]
    d.mkdir(parents=True, exist_ok=True)
    clips = []
    for i in range(POOL):
        fps = 24 if i % 2 else 30
        dur = 6 + (i * 7) % 5           # 6..10 s
        path = d / f"clip_{i:02d}.mp4"
        if not path.exists():
            _ff(["-f", "lavfi", "-i", _picture(i % 3, w, h, fps, i), "-t", str(dur),
                 "-c:v", "libx264", "-profile:v", "high", "-preset", "veryfast",
                 "-b:v", CLIP_BITRATE[res], "-maxrate", CLIP_BITRATE[res], "-bufsize", "16M",
                 "-g", str(fps * 2), "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", str(path)])
        clips.append({"path": path.name, "duration_s": round(_probe_duration(path), 3), "fps": fps})
    narration = d / "narration.mp3"
    if not narration.exists():
        # Speech-like: band-limited pink noise in ~4 Hz syllables, 2.6 s phrases, 0.4 s pauses.
        _ff(["-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.6:sample_rate=44100:seed=3",
             "-af", "highpass=f=180,lowpass=f=3600,"
                    "volume='0.5*(1.2+sin(2*PI*4.3*t))*lt(mod(t,3),2.6)':eval=frame",
             "-t", f"{film_s:.3f}", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", str(narration)])
    music = d / "music.m4a"
    if not music.exists():
        expr = ("0.12*sin(2*PI*220*t)+0.09*sin(2*PI*277.2*t)+0.08*sin(2*PI*329.6*t)"
                "+0.05*sin(2*PI*110*t)*(0.6+0.4*sin(2*PI*0.25*t))"
                "+0.25*exp(-18*mod(t,0.5))*sin(2*PI*55*t)")
        _ff(["-f", "lavfi", "-i", f"aevalsrc='{expr}|{expr}':s=44100:d={MUSIC_S}",
             "-c:a", "aac", "-b:a", "192k", str(music)])
    manifest = {"res": res, "clips": clips, "narration": {"path": narration.name,
                "duration_s": round(_probe_duration(narration), 3)},
                "music": {"path": music.name, "duration_s": round(_probe_duration(music), 3)}}
    (d / "manifest.json").write_text(json.dumps(manifest, indent=2))


# ── the document ─────────────────────────────────────────────────────────────

def _aid(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


def build_doc(manifest: dict, film_s: float, scenes: int = SCENES, loudnorm: bool = False,
              narration_clock: str = "scene") -> dict:
    """The timeline an assembled film is: 60 scenes, each slot exactly film_s / scenes long."""
    w, h = FRAMES[manifest["res"]]
    pool = manifest["clips"]
    slot = round(film_s / scenes, 3)
    v_clips, nar_clips, cues = [], [], []
    k = 0                                    # next pool clip
    nar_at = 0.0                             # where in the narration file the next scene's words start
    for s in range(scenes):
        t0 = round(s * slot, 3)
        head = XFADE_S if s > 0 else 0.0     # the incoming cross-fade comes out of this scene's footage
        need = slot + head
        start = t0 - head
        first = True
        while need > 1e-6:
            idx = k % len(pool)
            c = pool[idx]
            k += 1
            in_s = 0.0 if first else round(1.0 / c["fps"], 3)  # a chained shot repeats the last frame
            usable = c["duration_s"] - in_s
            take = min(usable, need)
            if need - take < 0.5 and need - take > 1e-6:      # never a sliver at the scene's end
                take = need - 0.5
            clip = {"id": f"s{s:02d}k{k:03d}", "asset_id": _aid(idx + 1),
                    "start_s": round(start, 3), "in_s": in_s, "out_s": round(in_s + take, 3), "fit": "cover"}
            if first and s > 0:
                clip["transition"] = {"type": "crossfade", "duration_s": XFADE_S}
            v_clips.append(clip)
            start += take
            need = round(need - take, 6)
            first = False
        n = round(slot - NARRATION_LEAD_S - NARRATION_TAIL_S, 3)
        nar_clips.append({"id": f"n{s:02d}", "asset_id": _aid(900), "start_s": round(t0 + NARRATION_LEAD_S, 3),
                          "in_s": round(nar_at, 3), "out_s": round(nar_at + n, 3),
                          **({"loudnorm": True} if loudnorm else {})})
        c_t = t0 + NARRATION_LEAD_S
        while c_t + 1.0 < t0 + NARRATION_LEAD_S + n:
            end = min(c_t + CUE_S, t0 + NARRATION_LEAD_S + n)
            cues.append({"id": f"c{len(cues):04d}", "start_s": round(c_t, 3), "end_s": round(end, 3),
                         "text": "The river keeps its own time,\nand the city learns to listen"})
            c_t = end
        nar_at += n
    if narration_clock == "film":
        # The narration take laid out on the film's clock (what film_timeline joins into one clip): one input.
        nar_clips = [{"id": "n00", "asset_id": _aid(900), "start_s": 0.0, "in_s": 0.0, "out_s": round(film_s, 3)}]
    music, m_clips, at = manifest["music"], [], 0.0
    while at < film_s - 1e-6:
        length = min(music["duration_s"], film_s - at)
        m_clips.append({"id": f"m{len(m_clips)}", "asset_id": _aid(901), "start_s": round(at, 3),
                        "in_s": 0.0, "out_s": round(length, 3), "gain_db": MUSIC_GAIN_DB,
                        "fade_in_s": 1.5, "fade_out_s": 1.5 if at + length < film_s - 1e-6 else 3.0})
        at += length
    return {"version": 1, "width": w, "height": h, "fps": FPS,
            "tracks": [{"id": "V1", "kind": "V", "clips": v_clips},
                       {"id": "A1", "kind": "A", "role": "speech", "clips": nar_clips},
                       {"id": "A2", "kind": "A", "role": "music", "duck": {"amount_db": DUCK_DB},
                        "clips": m_clips}],
            "captions": {"style": {"size": round(h * 0.05), "y": 0.9}, "cues": cues}}


def resolver_for(d: Path, manifest: dict):
    assets: Dict[str, tl.ResolvedAsset] = {}
    for i, c in enumerate(manifest["clips"]):
        aid = _aid(i + 1)
        assets[aid] = tl.ResolvedAsset(aid, tl.ASSET_VIDEO, str((d / c["path"]).resolve()), c["duration_s"], False)
    assets[_aid(900)] = tl.ResolvedAsset(_aid(900), tl.ASSET_AUDIO, str((d / manifest["narration"]["path"]).resolve()),
                                         manifest["narration"]["duration_s"], True)
    assets[_aid(901)] = tl.ResolvedAsset(_aid(901), tl.ASSET_AUDIO, str((d / manifest["music"]["path"]).resolve()),
                                         manifest["music"]["duration_s"], True)
    return assets.get


# ── instruments ──────────────────────────────────────────────────────────────

def _real_free_mb(path: Path) -> Optional[float]:
    # The disk itself, not what --assume-free-mb tells the backend's guard.
    try:
        st = os.statvfs(str(path))
        return st.f_bavail * st.f_frsize / 1048576.0
    except OSError:
        return None


class Sampler(threading.Thread):
    def __init__(self, work: Path, cgroup: Optional[Path]):
        super().__init__(daemon=True)
        self.work, self.cgroup = work, cgroup
        self.stop = threading.Event()
        self.peak_disk = 0
        self.peak_rss = 0
        self.free_min_mb: Optional[float] = None

    def _du(self) -> int:
        total = 0
        for root, _dirs, files in os.walk(self.work):
            for f in files:
                try:
                    total += os.lstat(os.path.join(root, f)).st_blocks * 512
                except OSError:
                    pass
        return total

    def _rss(self) -> int:
        if not self.cgroup:
            return 0
        try:
            stat = (self.cgroup / "memory.stat").read_text().split("\n")
            vals = dict(line.split() for line in stat if line)
            return int(vals.get("total_rss", vals.get("rss", 0))) + int(vals.get("total_mapped_file", 0))
        except OSError:
            return 0

    def run(self) -> None:
        tick = 0
        while not self.stop.wait(0.5):
            self.peak_rss = max(self.peak_rss, self._rss())
            tick += 1
            if tick % 2 == 0:
                self.peak_disk = max(self.peak_disk, self._du())
                free = _real_free_mb(self.work)
                if free is not None:
                    self.free_min_mb = free if self.free_min_mb is None else min(self.free_min_mb, free)


def _cg_read(cg: Path, name: str) -> Optional[int]:
    try:
        return int((cg / name).read_text().strip())
    except (OSError, ValueError):
        return None


def run(args) -> dict:
    d = Path(args.dir).resolve()
    manifest = json.loads((d / "manifest.json").read_text())
    film_s = args.minutes * 60.0
    doc = build_doc(manifest, film_s, args.scenes, bool(args.narration_loudnorm), args.narration_clock)
    problems = tl.validate(doc)
    if problems:
        raise SystemExit("the document does not validate: " + "; ".join(problems[:5]))
    norm = tl.load(doc)
    length = tl.duration_s(norm)
    resolver = resolver_for(d, manifest)
    spec = timeline_render.to_render_spec(norm, resolver, "/dev/null")

    cg = Path(args.cgroup) if args.cgroup else None
    if cg:
        cg.mkdir(exist_ok=True)
        limit = int(args.mem_limit[:-1]) * 1024 ** 3 if args.mem_limit.endswith("g") else int(args.mem_limit)
        (cg / "memory.limit_in_bytes").write_text(str(limit))
        (cg / "cgroup.procs").write_text(str(os.getpid()))
        (cg / "memory.max_usage_in_bytes").write_text("0")
        (cg / "memory.failcnt").write_text("0")

    work = Path(args.work).resolve()
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    out = work / "export.mp4"

    if args.assume_free_mb is not None:
        render_backend._free_mb = lambda _p: float(args.assume_free_mb)
    chosen = render_backend.intermediate_x264(spec, work)

    commands: List[dict] = []
    real_run = ffmpeg_limits.run

    def timed_run(argv, **kw):
        t0 = time.monotonic()
        c0 = resource.getrusage(resource.RUSAGE_CHILDREN)
        o = real_run(argv, **kw)
        c1 = resource.getrusage(resource.RUSAGE_CHILDREN)
        final = "concat" in argv
        commands.append({"kind": "final" if final else ("xfade" if any("xfade=" in a for a in argv) else "segment"),
                         "wall_s": round(time.monotonic() - t0, 2),
                         "cpu_s": round(c1.ru_utime + c1.ru_stime - c0.ru_utime - c0.ru_stime, 2), "peak_rss_mb": round(o.peak_rss_bytes / 1048576, 1),
                         "rc": o.returncode, "refused": o.refused, "timed_out": o.timed_out,
                         "tail": o.tail.strip().splitlines()[-3:] if not o.ok else []})
        return o

    ffmpeg_limits.run = timed_run
    timing_line: List[str] = []

    class Grab(logging.Handler):
        def emit(self, record):
            msg = record.getMessage()
            if msg.startswith(render_backend.TIMING_PREFIX) or "compact settings" in msg:
                timing_line.append(msg)

    logging.getLogger("modules.render_backend").addHandler(Grab())
    logging.getLogger("modules.render_backend").setLevel(logging.INFO)

    sampler = Sampler(work, cg)
    sampler.start()
    ru0 = resource.getrusage(resource.RUSAGE_CHILDREN)
    t0 = time.monotonic()
    error = None
    try:
        # The editor export's call (editor_export.run_export), with the deadline passed in.
        timeline_render.render(norm, resolver, str(out), ffmpeg=shutil.which("ffmpeg"), workdir=str(work),
                               jobs=1, timeout_s=args.timeout_s)
    except render_backend.RenderBackendError as e:
        error = f"{type(e).__name__}: {str(e)[:400]}"
    wall = time.monotonic() - t0
    ru1 = resource.getrusage(resource.RUSAGE_CHILDREN)
    sampler.stop.set()
    sampler.join()
    ffmpeg_limits.run = real_run

    result = {
        "res": args.res, "minutes": args.minutes, "length_s": round(length, 3),
        "frame": f"{norm['width']}x{norm['height']}@{norm['fps']}",
        "scenes": args.scenes, "narration_loudnorm": bool(args.narration_loudnorm),
        "narration_clock": args.narration_clock, "v_clips": len(norm["tracks"][0]["clips"]), "segments": len(spec.segments),
        "audio_clips": sum(len(t["clips"]) for t in norm["tracks"] if t["kind"] == "A"),
        "cues": len(norm["captions"]["cues"]),
        "intermediate": "fast (crf 12 ultrafast)" if chosen == render_backend.INTERMEDIATE_X264
                        else "compact (libx264 defaults)",
        "assume_free_mb": args.assume_free_mb,
        "timeout_given_s": args.timeout_s,
        "editor_budget_s": tl.render_timeout_s(length),
        "wall_s": round(wall, 1),
        "within_editor_budget": wall <= tl.render_timeout_s(length),
        "cpu_user_s": round(ru1.ru_utime - ru0.ru_utime, 1),
        "cpu_sys_s": round(ru1.ru_stime - ru0.ru_stime, 1),
        "max_child_peak_rss_mb": max((c["peak_rss_mb"] for c in commands), default=None),
        "final_pass_peak_rss_mb": next((c["peak_rss_mb"] for c in commands if c["kind"] == "final"), None),
        "max_segment_peak_rss_mb": max((c["peak_rss_mb"] for c in commands if c["kind"] == "segment"), default=None),
        "max_xfade_peak_rss_mb": max((c["peak_rss_mb"] for c in commands if c["kind"] == "xfade"), default=None),
        "segment_wall_s": round(sum(c["wall_s"] for c in commands if c["kind"] != "final"), 1),
        "final_wall_s": next((c["wall_s"] for c in commands if c["kind"] == "final"), None),
        "segment_cpu_s": round(sum(c["cpu_s"] for c in commands if c["kind"] != "final"), 1),
        "final_cpu_s": next((c["cpu_s"] for c in commands if c["kind"] == "final"), None),
        "load_avg_end": " ".join(Path("/proc/loadavg").read_text().split()[:3]),
        "commands": len(commands),
        "cgroup_limit_mb": (_cg_read(cg, "memory.limit_in_bytes") or 0) // 1048576 if cg else None,
        "cgroup_peak_incl_cache_mb": (_cg_read(cg, "memory.max_usage_in_bytes") or 0) // 1048576 if cg else None,
        "cgroup_peak_rss_sampled_mb": sampler.peak_rss // 1048576 if cg else None,
        "cgroup_failcnt": _cg_read(cg, "memory.failcnt") if cg else None,
        "temp_disk_peak_mb": round(sampler.peak_disk / 1048576, 1),
        "free_disk_min_mb": round(sampler.free_min_mb, 0) if sampler.free_min_mb is not None else None,
        "error": error,
        "failed_commands": [c for c in commands if c["rc"] != 0 or c["refused"] or c["timed_out"]][:3],
        "timing_log": timing_line,
    }
    if out.is_file() and error is None:
        result["output_mb"] = round(out.stat().st_size / 1048576, 1)
        result["output_s"] = round(_probe_duration(out), 3)
        result["output_mbit_s"] = round(out.stat().st_size * 8 / 1e6 / max(result["output_s"], 1e-3), 2)
        ebu = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(out), "-vn", "-af", "ebur128=peak=true",
                              "-f", "null", "-"], capture_output=True, text=True)
        m = re.findall(r"I:\s+(-?[\d.]+) LUFS", ebu.stderr)
        p = re.findall(r"Peak:\s+(-?[\d.]+) dBFS", ebu.stderr)
        result["output_lufs"] = float(m[-1]) if m else None
        result["output_true_peak_dbfs"] = float(p[-1]) if p else None
    shutil.rmtree(work, ignore_errors=True)
    Path(args.out).write_text(json.dumps(result, indent=2))
    print(json.dumps({k: v for k, v in result.items() if k not in ("timing_log",)}, indent=2))
    return result


def audio_probe(args) -> dict:
    """The final pass alone: does a timeline with N narration clips (and the music bed) mix at all
    under the export's limits? A 40 s picture of black (no segment cost), N speech clips of 0.5 s,
    each with or without the editor's loudnorm, and the music track ducked under them. With
    ``--as-limit-mb`` the per-ffmpeg address-space limit is set to that instead of
    ffmpeg_limits.CHILD_MEM_BYTES, to find how much the command needs (measurement only)."""
    d = Path(args.dir).resolve()
    manifest = json.loads((d / "manifest.json").read_text())
    w, h = FRAMES[manifest["res"]]
    film_s = 40.0
    step = film_s / max(1, args.clips)
    nar = [{"id": f"n{i:02d}", "asset_id": _aid(900), "start_s": round(i * step + 0.05, 3),
            "in_s": round(i * 0.5, 3), "out_s": round(i * 0.5 + min(0.5, step - 0.1), 3),
            **({"loudnorm": True} if args.loudnorm else {})} for i in range(args.clips)]
    music = [{"id": "m0", "asset_id": _aid(901), "start_s": 0.0, "in_s": 0.0, "out_s": film_s, "gain_db": MUSIC_GAIN_DB}]
    doc = {"version": 1, "width": w, "height": h, "fps": FPS,
           "tracks": [{"id": "V1", "kind": "V", "clips": []},
                      {"id": "A1", "kind": "A", "role": "speech", "clips": nar},
                      {"id": "A2", "kind": "A", "role": "music", "duck": {"amount_db": DUCK_DB}, "clips": music}]}
    if args.cues:
        doc["captions"] = {"style": {"size": round(h * 0.05), "y": 0.9},
                           "cues": [{"id": f"c{i}", "start_s": round(i * film_s / args.cues, 3),
                                     "end_s": round((i + 1) * film_s / args.cues, 3),
                                     "text": "The river keeps its own time,\nand the city learns to listen"}
                                    for i in range(args.cues)]}
    problems = tl.validate(doc)
    if problems:
        raise SystemExit("; ".join(problems[:3]))
    if args.as_limit_mb:
        ffmpeg_limits.CHILD_MEM_BYTES = int(args.as_limit_mb) * 1024 ** 2
    work = Path(args.work).resolve()
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    peaks: List[float] = []
    real_run = ffmpeg_limits.run

    def timed_run(argv, **kw):
        o = real_run(argv, **kw)
        if "concat" in argv:
            peaks.append(round(o.peak_rss_bytes / 1048576, 1))
        return o

    ffmpeg_limits.run = timed_run
    error = None
    t0 = time.monotonic()
    try:
        timeline_render.render(doc, resolver_for(d, manifest), str(work / "out.mp4"), ffmpeg=shutil.which("ffmpeg"),
                               workdir=str(work), jobs=1, timeout_s=600)
    except render_backend.RenderBackendError as e:
        error = str(e)[:90]
    ffmpeg_limits.run = real_run
    shutil.rmtree(work, ignore_errors=True)
    res = {"frame": f"{w}x{h}", "clips": args.clips, "cues": args.cues, "loudnorm": bool(args.loudnorm), "as_limit_mb": ffmpeg_limits.CHILD_MEM_BYTES // 1048576,
           "ok": error is None, "final_peak_rss_mb": peaks[-1] if peaks else None,
           "wall_s": round(time.monotonic() - t0, 1), "error": error}
    print(json.dumps(res))
    return res


def table(paths: List[str]) -> str:
    rows = [json.loads(Path(p).read_text()) for p in paths]
    cols = [("frame", "frame"), ("length_s", "film s"), ("intermediate", "intermediates"),
            ("wall_s", "wall s"), ("editor_budget_s", "editor budget s"), ("load_avg_end", "load at end"),
            ("cpu_user_s", "CPU user s"), ("cpu_sys_s", "CPU sys s"), ("segment_cpu_s", "segments CPU s"),
            ("final_cpu_s", "final pass CPU s"), ("max_segment_peak_rss_mb", "segment peak RSS MB"),
            ("max_xfade_peak_rss_mb", "cross-fade peak RSS MB"), ("final_pass_peak_rss_mb", "final pass peak RSS MB"),
            ("cgroup_peak_incl_cache_mb", "cgroup peak MB (with cache)"),
            ("cgroup_peak_rss_sampled_mb", "cgroup RSS MB (sampled)"), ("cgroup_failcnt", "limit hits"),
            ("temp_disk_peak_mb", "work dir peak MB"), ("output_mb", "output MB"), ("output_mbit_s", "Mb/s"),
            ("error", "error")]
    lines = ["| " + " | ".join(c[1] for c in cols) + " |", "|" + "---|" * len(cols)]
    for r in rows:
        lines.append("| " + " | ".join("n/a" if r.get(k) is None else str(r.get(k)) for k, _ in cols) + " |")
    return "\n".join(lines)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate")
    g.add_argument("--dir", required=True)
    g.add_argument("--res", choices=sorted(FRAMES), required=True)
    g.add_argument("--film-s", type=float, default=900.0)
    r = sub.add_parser("run")
    r.add_argument("--dir", required=True)
    r.add_argument("--res", choices=sorted(FRAMES), required=True)
    r.add_argument("--minutes", type=float, required=True)
    r.add_argument("--work", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--scenes", type=int, default=SCENES)
    r.add_argument("--narration-loudnorm", type=int, default=0)
    r.add_argument("--narration-clock", choices=("scene", "film"), default="scene")
    r.add_argument("--cgroup")
    r.add_argument("--mem-limit", default="4g")
    r.add_argument("--assume-free-mb", type=float)
    r.add_argument("--timeout-s", type=float, default=4 * 3600.0)
    ap = sub.add_parser("audio-probe")
    ap.add_argument("--dir", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--clips", type=int, required=True)
    ap.add_argument("--loudnorm", type=int, default=1)
    ap.add_argument("--as-limit-mb", type=int)
    ap.add_argument("--cues", type=int, default=0)
    t = sub.add_parser("table")
    t.add_argument("paths", nargs="+")
    a = p.parse_args(argv)
    if a.cmd == "generate":
        generate(Path(a.dir), a.res, a.film_s)
    elif a.cmd == "run":
        run(a)
    elif a.cmd == "audio-probe":
        audio_probe(a)
    else:
        print(table(a.paths))
    return 0


if __name__ == "__main__":
    sys.exit(main())
