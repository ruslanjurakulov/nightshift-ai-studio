"""Measure P4b end to end on real local files: ``film_assembly.assemble_segment`` with the real render and the real
library store, the database replaced by an in-memory twin of 0171's assembly calls (docs/studio/S4_GAPS.md).

Nothing here calls a provider or spends anything. The clips are the public site's showcase clips already in the repository
(``command-center/components/site/showcase/*/clip.mp4``, silent H.264, 1280 wide, picked per aspect within the timeline's
2 % tolerance); the narration and the music are made here by ffmpeg (tone bursts and a chord loop, no TTS). The narration is
laid out on the film's clock exactly as P3's contract says (each scene's words start ``NARRATION_LEAD_S`` into the scene)
and carries a short 3 kHz marker at the start of every scene's words, so the output's A/V sync can be read at every cut.

    python3 tools/film_assembly_e2e_measure.py run --aspect 16:9 --seconds 60 --work $W --out r.json
    python3 tools/film_assembly_e2e_measure.py table r*.json

What one run records: wall time, children's CPU, the largest single ffmpeg's peak RSS, this process's own peak RSS, the
media root's peak size while it ran (sampled), the output's size, length, frame and streams, the review copy's size, the
captions sidecar, and the sync offsets (marker onset in the output minus the cut's time in the output, per cut).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import resource
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from modules import film_assembly as fa  # noqa: E402
from modules import film_timeline as ft  # noqa: E402
from modules import media_library as ml  # noqa: E402

SHOWCASE = ROOT / "command-center" / "components" / "site" / "showcase"
ORG = "0a000000-0000-4000-8000-0000000000e1"
SEG = "5e000000-0000-4000-8000-0000000000e1"
FILM = "f1000000-0000-4000-8000-0000000000e1"
WORKER = "measure-1"
MARK_HZ = 3000
MARK_S = 0.06


def _u(n: int, kind: int) -> str:
    return f"{kind:08x}-0000-4000-8000-{n:012x}"


def ff(*args, timeout=600):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True, timeout=timeout)


def probe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                          "format=duration,size:stream=codec_type,codec_name,width,height,start_time,duration,r_frame_rate",
                          "-of", "json", str(path)], capture_output=True, check=True, timeout=60)
    return json.loads(out.stdout)


# ── the in-memory database (0171's assembly calls, as tests/test_film_assembly.FakeDb) ──────────────────────

class MemDb:
    def __init__(self, film, scenes, takes, assets):
        self.film_row, self.scene_rows, self.take_rows = film, scenes, takes
        self.rows = {ml.canonical_id(k): {"id": k, **v} for k, v in assets.items()}
        self.seg = {"id": SEG, "film_id": FILM, "org_id": ORG, "status": "running", "film_version": 1,
                    "assembly_status": "running", "assembly_asset_id": None}
        self.calls = []

    def org_enabled(self, org): return org == ORG
    def heartbeat(self, sid, worker): return worker == WORKER
    def discard_unrecorded(self, sid, asset): return 0
    def film(self, fid): return self.film_row
    def scenes(self, fid): return self.scene_rows
    def takes(self, sid): return self.take_rows
    def segment(self, sid): return dict(self.seg)

    def assets(self, org, ids):
        want = {ml.canonical_id(x) for x in ids}
        return [r for i, r in self.rows.items() if i in want and r.get("org_id") == org]

    def begin(self, sid, worker):
        if self.seg["assembly_status"] != "running":
            raise fa.DbRefused("film_begin_assembly", 409, "not_running")
        return dict(self.seg)

    def record(self, sid, worker, ok, asset):
        self.calls.append(("record", ok, asset))
        self.seg.update(assembly_status="completed" if ok else "failed", assembly_asset_id=asset if ok else None)
        return dict(self.seg)


class MemMedia:
    def __init__(self, db: MemDb):
        self.db = db

    def register(self, **kw):
        aid = kw["asset_id"]
        self.db.rows[aid] = {"id": aid, "org_id": kw["org"], "kind": kw["kind"], "mime": kw["mime"],
                             "duration_s": kw["duration_s"], "width": kw["width"], "height": kw["height"],
                             "variants": kw["variants"], "source": kw["source"], "provenance": kw["provenance"],
                             "bytes": kw["bytes"], "derived_bytes": kw.get("derived_bytes")}
        return {"id": aid}


# ── the film on disk ─────────────────────────────────────────────────────────

def pick_clips(aspect: str, min_s: float) -> list:
    aw, ah = (int(x) for x in aspect.split(":"))
    want = aw / ah
    out = []
    for p in sorted(SHOWCASE.glob("*/clip.mp4")):
        s = next(x for x in probe(p)["streams"] if x["codec_type"] == "video")
        dur = float(probe(p)["format"]["duration"])
        if abs(s["width"] / s["height"] - want) / want <= ft.ASPECT_TOLERANCE and dur >= min_s:
            out.append((p, s["width"], s["height"], dur))
    if not out:
        raise SystemExit(f"no showcase clip of {aspect} at least {min_s} s long")
    return out


def place(root: Path, aid: str) -> Path:
    d = ml.asset_dir(root, aid)
    d.mkdir(parents=True, exist_ok=True)
    return d / ml.VARIANT_FILES["original"]


def loudness(path: Path) -> tuple:
    out = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128=peak=true",
                          "-f", "null", "-"], capture_output=True, text=True, timeout=600).stderr
    i = re.findall(r"I:\s+(-?[\d.]+) LUFS", out)
    p = re.findall(r"Peak:\s+(-?[\d.]+) dBFS", out)
    return (float(i[-1]) if i else None, float(p[-1]) if p else None)


def build_film(root: Path, *, aspect: str, seconds: int, scene_s: float, resolution: str, transition: str,
               captions: str, music: bool) -> MemDb:
    n = max(1, round(seconds / scene_s))
    clips = pick_clips(aspect, scene_s + (ft.CROSSFADE_S if transition == "crossfade" else 0) + 0.05)
    film = {"id": FILM, "org_id": ORG, "aspect": aspect, "resolution": resolution, "transition_default": transition,
            "captions_mode": captions, "music_asset_id": None, "music_gain_db": None, "duck_db": None, "language": "en"}
    scenes, takes, assets, segments, words = [], [], {}, [], []
    placed = {}
    for i in range(n):
        sid, tid, res = _u(100 + i, 0x5), _u(1000 + i, 0x7), _u(2000 + i, 0xB)
        src, w, h, dur = clips[i % len(clips)]
        scenes.append({"id": sid, "position": i, "planned_seconds": scene_s, "shot_count": 1, "first_frame": "keyframe",
                       "transition_in": None, "current_version": 1, "narration": f"Scene {i + 1} speaks here."})
        takes.append({"id": tid, "segment_id": SEG, "scene_id": sid, "kind": "clip", "shot_index": 1, "version": 1,
                      "attempt": 1, "status": "completed", "result_asset_id": res,
                      "result_last_frame_asset_id": _u(3000 + i, 0xC), "first_frame_asset_id": _u(4000 + i, 0xD),
                      "params": {}})
        assets[res] = {"org_id": ORG, "kind": "video", "mime": "video/mp4", "duration_s": dur, "width": w, "height": h,
                       "variants": []}
        # A copy per asset id, as the library keeps one file per asset (hard links would hide the page cache's work).
        dst = place(root, res)
        if src not in placed:
            shutil.copyfile(src, dst)
            placed[src] = dst
        else:
            shutil.copyfile(placed[src], dst)
        a = round(i * scene_s + ft.NARRATION_LEAD_S, 3)
        b = round((i + 1) * scene_s - 0.5, 3)
        segments.append({"scene_id": sid, "start_s": a, "end_s": b})
        t = a + 0.1
        k = 0
        for word in ("Scene", str(i + 1), "speaks", "here."):
            if t + 0.4 > b:
                break
            words.append({"word": word, "start": round(t, 3), "end": round(t + 0.35, 3)})
            t += 0.45
            k += 1
    total = n * scene_s
    # Narration: speech-band bursts (200-600 Hz) inside each segment, and a 3 kHz marker at each segment's start.
    marks = "+".join(f"between(t,{s['start_s']},{s['start_s'] + MARK_S})" for s in segments)
    speech = "+".join(f"between(t,{s['start_s'] + 0.1},{s['end_s']})" for s in segments)
    expr = (f"0.5*sin(2*PI*{MARK_HZ}*t)*({marks})"
            f"+0.25*sin(2*PI*(300+120*sin(2*PI*3*t))*t)*(0.5+0.5*sin(2*PI*4*t))*({speech})")
    narr_id = _u(9001, 0xA)
    narr = place(root, narr_id)
    wav = root / "narr.wav"
    ff("-f", "lavfi", "-i", f"aevalsrc='{expr}':s=48000:d={total}", "-ac", "1", str(wav))
    ff("-i", str(wav), "-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3", str(narr))
    wav.unlink()
    lufs, peak = loudness(narr)
    takes.append({"id": _u(9000, 0x7), "segment_id": SEG, "scene_id": None, "kind": "narration", "shot_index": 0,
                  "version": 1, "attempt": 1, "status": "completed", "result_asset_id": narr_id,
                  "params": {"segments": segments, "loudness_lufs": lufs, "true_peak_db": peak, "words": words}})
    assets[narr_id] = {"org_id": ORG, "kind": "audio", "mime": "audio/mpeg", "duration_s": float(total), "variants": []}
    if music:
        mid = _u(9002, 0xA)
        mpath = place(root, mid)
        md = 30.0
        ff("-f", "lavfi", "-i", f"aevalsrc='0.2*sin(2*PI*220*t)+0.15*sin(2*PI*277*t)+0.15*sin(2*PI*330*t)"
           f"+0.3*sin(2*PI*60*t)*lt(mod(t,0.5),0.08)|0.2*sin(2*PI*220*t)+0.15*sin(2*PI*330*t)':s=48000:d={md}",
           "-c:a", "aac", "-b:a", "160k", "-f", "mp4", str(mpath))
        film.update(music_asset_id=mid)
        assets[mid] = {"org_id": ORG, "kind": "audio", "mime": "audio/mp4", "duration_s": md, "variants": []}
    return MemDb(film, scenes, takes, assets)


# ── sampling ─────────────────────────────────────────────────────────────────

def tree_bytes(path: Path) -> int:
    total = 0
    for dp, _dn, fn in os.walk(path):
        for f in fn:
            try:
                total += os.lstat(os.path.join(dp, f)).st_size
            except OSError:
                pass
    return total


class Sampler(threading.Thread):
    def __init__(self, root: Path):
        super().__init__(daemon=True)
        self.root, self.stop, self.peak, self.load = root, threading.Event(), 0, []
        self.base = tree_bytes(root)

    def run(self):
        while not self.stop.wait(0.5):
            self.peak = max(self.peak, tree_bytes(self.root) - self.base)
            self.load.append(os.getloadavg()[0])


# ── the sync check ───────────────────────────────────────────────────────────

def marker_onsets(path: Path) -> list:
    out = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-vn", "-af",
                          "adelay=1000:all=1,"
                          f"bandpass=f={MARK_HZ}:width_type=q:w=8,bandpass=f={MARK_HZ}:width_type=q:w=8,"
                          "silencedetect=n=-40dB:d=0.03", "-f", "null", "-"],
                         capture_output=True, text=True, timeout=600).stderr
    # The delay gives the first marker a silence to end (the narration's stream starts 0.228 s in, right before it).
    return [float(x) - 1.0 for x in re.findall(r"silence_end: (-?[\d.]+)", out)]


def cut_times(path: Path) -> list:
    out = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-an", "-vf",
                          "select='gt(scene,0.25)',showinfo", "-f", "null", "-"],
                         capture_output=True, text=True, timeout=1200).stderr
    return [float(x) for x in re.findall(r"pts_time:([\d.]+)", out)]


def sync(path: Path, scene_s: float, n: int) -> dict:
    marks = marker_onsets(path)
    cuts = cut_times(path)
    expected_cuts = [i * scene_s for i in range(1, n)]
    offsets, cut_err = [], []
    for i in range(n):
        want = i * scene_s + ft.NARRATION_LEAD_S
        m = min(marks, key=lambda x: abs(x - want), default=None)
        if m is not None and abs(m - want) < 0.5:
            offsets.append(round(m - want, 3))
    for c in expected_cuts:
        got = min(cuts, key=lambda x: abs(x - c), default=None)
        if got is not None and abs(got - c) < 0.5:
            cut_err.append(round(got - c, 3))
    return {"markers_found": len(offsets), "markers_expected": n, "marker_offset_s": offsets,
            "marker_offset_max_abs_s": max((abs(x) for x in offsets), default=None),
            "cuts_found": len(cut_err), "cuts_expected": len(expected_cuts),
            "cut_offset_max_abs_s": max((abs(x) for x in cut_err), default=None),
            "first_marker_offset_s": offsets[0] if offsets else None,
            "last_marker_offset_s": offsets[-1] if offsets else None}


# ── one run ──────────────────────────────────────────────────────────────────

def run(args) -> dict:
    work = Path(args.work).resolve()
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    db = build_film(work, aspect=args.aspect, seconds=args.seconds, scene_s=args.scene_s, resolution=args.resolution,
                    transition=args.transition, captions=args.captions, music=not args.no_music)
    tools = ml.Tools(ffprobe=shutil.which("ffprobe"), ffmpeg=shutil.which("ffmpeg"))
    deps = fa.Deps(env={fa.ENABLE_ENV: "on"}, transcribe=lambda p, lang: (_ for _ in ()).throw(
        RuntimeError("words are in the take's params; whisper is measured separately")))
    if args.assume_free_mb is not None:
        deps.free_mb = lambda p: float(args.assume_free_mb)
    sampler = Sampler(work)
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    load0 = os.getloadavg()[0]
    sampler.start()
    t0 = time.monotonic()
    error = None
    try:
        outcome = fa.assemble_segment(db.seg, worker_id=WORKER, store=db, media=MemMedia(db), media_root=work,
                                      tools=tools, deps=deps)
    except Exception as e:  # noqa: BLE001 — a measurement records what broke
        outcome, error = None, f"{type(e).__name__}: {e}"
    wall = time.monotonic() - t0
    sampler.stop.set()
    sampler.join()
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    rec = {"aspect": args.aspect, "target_s": args.seconds, "scene_s": args.scene_s, "scenes": len(db.scene_rows),
           "resolution": args.resolution, "frame": list(ft.frame_for(args.aspect, args.resolution)),
           "transition": args.transition, "captions": args.captions, "music": not args.no_music,
           "wall_s": round(wall, 1), "budget_s": round(fa.tl.render_timeout_s(len(db.scene_rows) * args.scene_s), 0),
           "children_cpu_s": round((after.ru_utime - before.ru_utime) + (after.ru_stime - before.ru_stime), 1),
           "max_child_rss_mb": round(after.ru_maxrss / 1024, 0),
           "self_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 0),
           "work_peak_mb": round(sampler.peak / 1e6, 1),
           "disk_asked_mb": round(fa.disk_needed_mb(*ft.frame_for(args.aspect, args.resolution),
                                                    len(db.scene_rows) * args.scene_s), 0),
           "load_before": round(load0, 2),
           "load_avg_during": round(sum(sampler.load) / len(sampler.load), 2) if sampler.load else None,
           "error": error}
    if outcome is not None:
        rec.update(ok=outcome.ok, reason=outcome.reason, detail=outcome.detail, rendered=outcome.rendered,
                   recorded=outcome.recorded, cut_sha256=outcome.cut_sha256)
    if outcome is not None and outcome.ok:
        master = ml.asset_file(work, outcome.asset_id, "original")
        proxy = ml.asset_file(work, outcome.asset_id, "proxy")
        row = db.rows[outcome.asset_id]
        p = probe(master)
        v = next(s for s in p["streams"] if s["codec_type"] == "video")
        a = next((s for s in p["streams"] if s["codec_type"] == "audio"), None)
        length = len(db.scene_rows) * args.scene_s
        pp = probe(proxy) if proxy.is_file() else None
        pv = next(s for s in pp["streams"] if s["codec_type"] == "video") if pp else {}
        rec.update(output_mb=round(master.stat().st_size / 1e6, 2),
                   output_mbps=round(master.stat().st_size * 8 / 1e6 / length, 2),
                   output_duration_s=float(p["format"]["duration"]), duration_error_s=round(
                       float(p["format"]["duration"]) - length, 3),
                   video_duration_s=float(v.get("duration") or 0), audio_duration_s=float(a.get("duration") or 0) if a else None,
                   audio_start_s=float(a.get("start_time") or 0) if a else None,
                   output_frame=[v["width"], v["height"]], fps=v.get("r_frame_rate"),
                   library_duration_s=row.get("duration_s"),
                   review_mb=round(proxy.stat().st_size / 1e6, 2) if proxy.is_file() else None,
                   review_frame=[pv.get("width"), pv.get("height")] if pv else None,
                   review_fraction_of_50mb=round(proxy.stat().st_size / fa.REVIEW_COPY_MAX_BYTES, 3) if proxy.is_file() else None,
                   captions_asset=bool(outcome.captions_asset_id),
                   loudness_lufs_tp=loudness(master))
        if args.transition == "cut" and not args.no_sync:
            rec["sync"] = sync(master, args.scene_s, len(db.scene_rows))
    if not args.keep:
        shutil.rmtree(work, ignore_errors=True)
    return rec


def table(paths):
    cols = ["aspect", "target_s", "scenes", "resolution", "transition", "ok", "reason", "wall_s", "budget_s",
            "children_cpu_s", "max_child_rss_mb", "self_rss_mb", "work_peak_mb", "disk_asked_mb", "output_mb",
            "duration_error_s", "audio_start_s", "review_mb", "load_avg_during"]
    print("| " + " | ".join(cols + ["sync max |offset| s", "cuts max |err| s"]) + " |")
    print("|" + "---|" * (len(cols) + 2))
    for p in paths:
        r = json.loads(Path(p).read_text())
        s = r.get("sync") or {}
        print("| " + " | ".join(str(r.get(c, "")) for c in cols)
              + f" | {s.get('marker_offset_max_abs_s', '')} ({s.get('markers_found', '')}/{s.get('markers_expected', '')})"
              + f" | {s.get('cut_offset_max_abs_s', '')} ({s.get('cuts_found', '')}/{s.get('cuts_expected', '')}) |")


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--aspect", default="16:9", choices=["16:9", "9:16", "1:1"])
    r.add_argument("--seconds", type=int, default=60)
    r.add_argument("--scene-s", type=int, default=5)
    r.add_argument("--resolution", default="1080p")
    r.add_argument("--transition", default="cut", choices=list(ft.TRANSITIONS))
    r.add_argument("--captions", default="both", choices=list(ft.CAPTION_MODES))
    r.add_argument("--no-music", action="store_true")
    r.add_argument("--no-sync", action="store_true")
    r.add_argument("--assume-free-mb", type=float)
    r.add_argument("--work", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--keep", action="store_true")
    t = sub.add_parser("table")
    t.add_argument("paths", nargs="+")
    args = ap.parse_args(argv)
    if args.cmd == "table":
        return table(args.paths)
    rec = run(args)
    Path(args.out).write_text(json.dumps(rec, indent=1))
    print(json.dumps(rec, indent=1))


if __name__ == "__main__":
    main()
