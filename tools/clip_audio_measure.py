#!/usr/bin/env python3
"""S2: does a Film Studio clip's own sound reach the master, and what would a mix that keeps it cost?

Measurement only (CLAUDE.md rule 8). No provider is called, nothing is spent, no production state is
written, and nothing in production imports this file. The numbers are in docs/studio/S2_CLIP_AUDIO.md.

    taskset -c 0,1 python3 tools/clip_audio_measure.py --dir D --scenes 30 --scene-s 3 --res 1080p \
            --out result.json [--variants as_is,clip_audio,stem] [--proposal 1]

Sources, all synthesised locally with ffmpeg lavfi / Python, each on its own tone so that the master
can be read apart per source with a narrow band-pass:
  * ambience 1000 Hz: every clip's sound (AAC 44.1 kHz stereo in an H.264 mp4, the shape of an i2v
    provider's file that carries audio), steady, about -21 LUFS;
  * in-clip dialogue 2000 Hz: on top of the ambience in the dialogue scenes' clip, in speech-length
    bursts (the clip model "speaking" its lines);
  * narration 300 Hz: one take on the film's clock (what P3 writes), mono 44.1 kHz WAV, only in the
    narrated scenes;
  * music 120 Hz: stereo 44.1 kHz WAV, longer than the film (one tile).

Scene roles, by 0-based index: ``UNNARRATED_SCENE`` (2) is wordless (ambience only); every scene with
``i % 4 == 3`` is an in-clip dialogue scene (no narration, the clip speaks); every ``(i + 1) % 5 == 0``
scene that is not a dialogue scene is narrated over a clip whose file has NO audio stream (a model that
returned a silent file); every other scene is narrated over an ambience clip.

The cut is the REAL one: ``film_timeline.build_cut`` (the narration's measured loudness handed in as
the orchestrator does), ``timeline.load``, a resolver whose ``has_audio`` is the production probe
``editor_export.probe_has_audio``, and ``timeline_render.to_render_spec`` + ``render_backend.render(jobs=1,
timeout_s=...)`` exactly as ``film_assembly.render_strict`` calls them (every ffmpeg under ffmpeg_limits).

Variants of the document (WHAT-IFs are edits of the document in this script, never of production code):
  ``as_is``       the cut film_timeline produces today;
  ``clip_audio``  what-if: ``"audio": true`` on every V clip (the editor's own opt-in, which is what the
                  unmerged branch vera/film-clip-audio sets): one final-pass input per sounding clip;
  ``stem``        what-if: the clips' sound premixed first into ONE file (``--proposal``'s stem) and laid
                  on one extra A track: one final-pass input for all of it.

``--proposal 1`` also measures, audio only: the stem premix itself (time, memory), the duck of the stem
under the narration by the editor's envelope and by ``sidechaincompress``, the proposed full mix (music
ducked under narration AND dialogue regions, ambience ducked under narration only), and a two-pass
``loudnorm`` (linear=true) on today's master and on the proposed mix, with the mode loudnorm reports.
"""

from __future__ import annotations

import argparse
import array
import copy
import json
import math
import re
import shutil
import subprocess
import sys
import time
import wave
from pathlib import Path
from typing import Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from modules import editor_export, ffmpeg_limits, render_backend, timeline_render  # noqa: E402
from modules import film_timeline as ft  # noqa: E402
from modules import render_spec as rs  # noqa: E402
from modules import timeline as tl  # noqa: E402

AMB_HZ, DIALOGUE_HZ, NARRATION_HZ, MUSIC_HZ = 1000, 2000, 300, 120
UNNARRATED_SCENE = 2
NARRATION_AMP, MUSIC_AMP, DIALOGUE_AMP = 0.25, 0.25, 0.2
SPEECH_TAIL_S = 0.75        # narration ends this long before its scene does (lead 0.25 + tail 0.25 must fit)
STEM_GAIN_DB = 0.0          # the ambience stem's level in the proposed mix (dialogue rides in it, so it is not lowered)
DUCK_DB = 12.0              # the film's default duck (film_timeline.DUCK_DB_DEFAULT)


def role(i: int) -> str:
    if i == UNNARRATED_SCENE:
        return "wordless"
    if i % 4 == 3:
        return "dialogue"
    if (i + 1) % 5 == 0:
        return "silent_file"
    return "narrated"


def _ff(args: List[str]) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *args], check=True)


def _uuid(n: int, kind: int) -> str:
    return f"{kind:08x}-0000-4000-8000-{n:012x}"


def _speech_window(i: int, s: int) -> Tuple[float, float]:
    return i * s + ft.NARRATION_LEAD_S, i * s + s - SPEECH_TAIL_S


def _write_wav(path: Path, seconds: float, sample, channels: int = 1, rate: int = 44100) -> None:
    buf = array.array("h")
    for n in range(int(seconds * rate)):
        v = int(max(-1.0, min(1.0, sample(n / rate))) * 32767)
        buf.extend([v] * channels)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(buf.tobytes())


def generate(d: Path, w: int, h: int, scenes: int, scene_s: int) -> Dict[str, Path]:
    d.mkdir(parents=True, exist_ok=True)
    clip_s = scene_s + 1            # a cross-fade takes its 0.5 s overlap from the incoming clip's own footage
    film_s = scenes * scene_s
    f = {"clip_ambience": d / "clip_ambience.mp4", "clip_dialogue": d / "clip_dialogue.mp4",
         "clip_silent": d / "clip_silent.mp4", "narration": d / "narration.wav", "music": d / "music.wav"}
    pic = ["-f", "lavfi", "-i", f"testsrc2=s={w}x{h}:r=30:d={clip_s}"]
    enc = ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"]
    if not f["clip_ambience"].exists():
        _ff([*pic, "-f", "lavfi", "-i", f"sine=f={AMB_HZ}:sample_rate=44100:d={clip_s}", "-ac", "2", *enc,
             "-c:a", "aac", "-b:a", "128k", "-shortest", str(f["clip_ambience"])])
    if not f["clip_dialogue"].exists():
        a, b = ft.NARRATION_LEAD_S, scene_s - SPEECH_TAIL_S
        expr = (f"0.125*sin(2*PI*{AMB_HZ}*t)+{DIALOGUE_AMP}*sin(2*PI*{DIALOGUE_HZ}*t)*between(t,{a},{b})")
        _ff([*pic, "-f", "lavfi", "-i", f"aevalsrc=exprs='{expr}|{expr}':s=44100:d={clip_s}", *enc,
             "-c:a", "aac", "-b:a", "128k", "-shortest", str(f["clip_dialogue"])])
    if not f["clip_silent"].exists():
        _ff([*pic, *enc, "-an", str(f["clip_silent"])])
    if not f["narration"].exists():
        spans = {i: _speech_window(i, scene_s) for i in range(scenes) if role(i) in ("narrated", "silent_file")}

        def nar(t: float) -> float:
            ab = spans.get(int(t // scene_s))
            if ab and ab[0] <= t < ab[1]:
                return NARRATION_AMP * math.sin(2 * math.pi * NARRATION_HZ * t)
            return 0.0
        _write_wav(f["narration"], film_s + 1, nar)
    if not f["music"].exists():
        _ff(["-f", "lavfi", "-i", f"aevalsrc=exprs='{MUSIC_AMP}*sin(2*PI*{MUSIC_HZ}*t)|{MUSIC_AMP}*sin(2*PI*{MUSIC_HZ}*t)'"
             f":s=44100:d={film_s + 30}", "-c:a", "pcm_s16le", str(f["music"])])
    return f


def ebur128(path: Path, af: str = "") -> Tuple[Optional[float], Optional[float]]:
    chain = (af + "," if af else "") + "ebur128=peak=true"
    out = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-i", str(path), "-vn", "-af", chain,
                          "-f", "null", "-"], capture_output=True, text=True)
    text = out.stderr
    summary = text[text.rfind("Summary:"):] if "Summary:" in text else ""
    i = re.search(r"\bI:\s+(-?\d+(?:\.\d+)?)\s+LUFS", summary)
    p = re.search(r"True peak:\s+Peak:\s+(-?(?:\d+(?:\.\d+)?|inf))\s+dBFS", summary)
    lufs = float(i.group(1)) if i else None
    peak = float(p.group(1)) if p and p.group(1) != "-inf" else None
    return (lufs if lufs is not None and lufs > -70 else None), peak


def rms_db(path: Path, af: str) -> Optional[float]:
    out = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-i", str(path), "-vn", "-af",
                          af + ",astats=measure_perchannel=none:measure_overall=RMS_level", "-f", "null", "-"],
                         capture_output=True, text=True)
    m = re.findall(r"RMS level dB:\s+(-?(?:\d+(?:\.\d+)?|inf))", out.stderr)
    if not m or m[-1] == "-inf":
        return None
    return round(float(m[-1]), 1)


def band(hz: int) -> str:
    # Two narrow band-passes: the four tones are an octave or more apart, so each band reads one source.
    return f"bandpass=f={hz}:width_type=q:width=8,bandpass=f={hz}:width_type=q:width=8"


def window(scene: int, scene_s: int) -> str:
    # The middle of the scene's speech window, clear of the cross-fades and of the duck's ramps.
    a = scene * scene_s + 0.25 * scene_s
    return f"atrim=start={a:.3f}:end={a + 0.4 * scene_s:.3f},asetpts=PTS-STARTPTS"


def probe_audio(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
                          "stream=codec_name,sample_rate,channels,channel_layout,bit_rate", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True)
    return {"audio_streams": json.loads(out.stdout).get("streams") or []}


def build(files: Dict[str, Path], w: int, h: int, res: str, scenes: int, scene_s: int):
    nar_lufs, nar_tp = ebur128(files["narration"])
    narr, music = _uuid(1, 0xA), _uuid(2, 0xA)
    film = {"id": _uuid(1, 0xF), "aspect": "16:9", "resolution": res, "transition_default": "crossfade",
            "captions_mode": "none", "music_asset_id": music, "music_gain_db": None, "duck_db": None}
    sc, takes, assets, paths, segs = [], [], {}, {}, []
    for i in range(scenes):
        sid = _uuid(100 + i, 0x5)
        r = role(i)
        said = r in ("narrated", "silent_file")
        sc.append({"id": sid, "position": i, "planned_seconds": scene_s, "shot_count": 1, "first_frame": "keyframe",
                   "transition_in": None, "current_version": 1, "narration": "words" if said else ""})
        res_id = _uuid(2000 + i, 0xB)
        takes.append({"id": _uuid(1000 + i, 0x7), "scene_id": sid, "kind": "clip", "shot_index": 1, "version": 1,
                      "attempt": 1, "status": "completed", "result_asset_id": res_id,
                      "result_last_frame_asset_id": _uuid(3000 + i, 0xC), "first_frame_asset_id": _uuid(4000 + i, 0xD),
                      "error_code": None})
        assets[res_id] = {"kind": "video", "duration_s": float(scene_s + 1), "width": w, "height": h}
        paths[res_id] = files[{"dialogue": "clip_dialogue", "silent_file": "clip_silent"}.get(r, "clip_ambience")]
        if said:
            a, b = _speech_window(i, scene_s)
            segs.append({"scene_id": sid, "start_s": round(a, 3), "end_s": round(b, 3)})
    assets[narr] = {"kind": "audio", "duration_s": float(scenes * scene_s + 1)}
    assets[music] = {"kind": "audio", "duration_s": float(scenes * scene_s + 30)}
    paths[narr], paths[music] = files["narration"], files["music"]
    narration = {"asset_id": narr, "segments": segs, "loudness_lufs": nar_lufs, "true_peak_db": nar_tp}
    cut = ft.build_cut(film, sc, takes, assets, narration, None)
    return cut, assets, paths, {"lufs": nar_lufs, "true_peak_db": nar_tp}


def resolver_for(assets: dict, paths: dict):
    found = {}
    for aid, a in assets.items():
        p = paths[aid]
        sound = editor_export.probe_has_audio("ffprobe", p, "video/mp4") if a["kind"] == "video" else None
        found[aid] = tl.ResolvedAsset(aid, a["kind"], str(p), a["duration_s"], sound)
    return lambda asset_id: found.get(str(asset_id).lower())


def with_clip_audio(doc: dict) -> dict:
    doc = copy.deepcopy(doc)
    for t in doc["tracks"]:
        if t["kind"] == "V":
            for c in t["clips"]:
                c["audio"] = True
    return doc


def render(doc: dict, resolver, out: Path, work: Path, timeout_s: float) -> dict:
    norm = tl.load(doc)
    spec = timeline_render.to_render_spec(norm, resolver, str(out))
    commands: List[dict] = []
    real_run = ffmpeg_limits.run

    def timed_run(argv, **kw):
        t0 = time.monotonic()
        o = real_run(argv, **kw)
        kind = "final" if "concat" in argv else ("xfade" if any("xfade=" in str(a) for a in argv) else "segment")
        entry = {"kind": kind, "wall_s": round(time.monotonic() - t0, 2), "peak_rss_mb": round(o.peak_rss_bytes / 1048576, 1),
                 "rc": o.returncode}
        if kind == "final":
            entry["inputs"] = sum(1 for a in argv if a == "-i")
            graph = argv[argv.index("-filter_complex") + 1] if "-filter_complex" in argv else ""
            entry["amix"] = re.findall(r"amix=[^\[;,]*", graph)
            if o.returncode != 0:
                entry["tail"] = o.tail[-300:]
        commands.append(entry)
        return o

    ffmpeg_limits.run = timed_run
    timings = render_backend.RenderTimings()
    t0 = time.monotonic()
    error = None
    try:
        render_backend.render(spec, ffmpeg=shutil.which("ffmpeg"), workdir=str(work), jobs=1, timeout_s=timeout_s,
                              timings=timings)
    except Exception as e:  # noqa: BLE001 - a measurement records the failure, it does not hide it
        error = f"{type(e).__name__}: {str(e)[:400]}"
    finally:
        ffmpeg_limits.run = real_run
    final = next((c for c in commands if c["kind"] == "final"), {})
    music = [t for t in spec.audio_tracks if t.duck_spans]
    return {"ok": error is None, "error": error, "wall_s": round(time.monotonic() - t0, 1),
            "budget_s": round(timeout_s, 1), "timings": timings.log_line(), "intermediate": timings.intermediate,
            "audio_tracks_in_spec": len(spec.audio_tracks),
            "audio_tracks_from_video_clips": sum(1 for t in spec.audio_tracks if t.path.endswith(".mp4")),
            "music_duck_spans": [list(s) for t in music for s in t.duck_spans][:8],
            "music_duck_span_count": sum(len(t.duck_spans) for t in music),
            "final_pass": final,
            "max_segment_peak_rss_mb": max((c["peak_rss_mb"] for c in commands if c["kind"] != "final"), default=None),
            "commands": len(commands)}


def scene_levels(path: Path, scene_s: int, scenes: int) -> dict:
    """Per scene role, the first scene of that role: each source's band RMS (dB) in its window."""
    out = {}
    for r in ("narrated", "wordless", "dialogue", "silent_file"):
        k = next((i for i in range(scenes) if role(i) == r), None)
        if k is None:
            continue
        out[f"{r}_scene{k + 1}"] = {n: rms_db(path, window(k, scene_s) + "," + band(hz)) for n, hz in
                                    (("ambience", AMB_HZ), ("dialogue", DIALOGUE_HZ), ("narration", NARRATION_HZ),
                                     ("music", MUSIC_HZ))}
    return out


def analyse(out: Path, scene_s: int, scenes: int) -> dict:
    res = probe_audio(out)
    res["master_lufs"], res["master_true_peak_db"] = ebur128(out)
    res["band_lufs"] = {n: ebur128(out, band(hz))[0] for n, hz in
                        (("ambience", AMB_HZ), ("dialogue", DIALOGUE_HZ), ("narration", NARRATION_HZ), ("music", MUSIC_HZ))}
    res["scenes"] = scene_levels(out, scene_s, scenes)
    return res


# ── the proposal's pieces, measured apart (audio only; nothing here is a production path) ──────────────────

def _run_limited(argv: List[str], timeout_s: float = 900) -> dict:
    t0 = time.monotonic()
    o = ffmpeg_limits.run(argv, timeout_s=timeout_s)
    return {"ok": o.returncode == 0 and not o.timed_out, "rc": o.returncode, "wall_s": round(time.monotonic() - t0, 2),
            "peak_rss_mb": round(o.peak_rss_bytes / 1048576, 1), "tail": "" if o.returncode == 0 else o.tail[-400:]}


def ambience_stem(clip_doc: dict, resolver, out: Path) -> dict:
    """Every clip's own sound in ONE file on the film's clock, with the editor's own chains
    (render_spec.audio_runs / audio_run_filters: trim, 48 kHz stereo, acrossfade at the cross-fades), one ffmpeg
    under ffmpeg_limits."""
    norm = tl.load(clip_doc)
    spec = timeline_render.to_render_spec(norm, resolver, str(out) + ".unused.mp4")
    tracks = [t for t in spec.audio_tracks if t.path.endswith(".mp4")]
    # Input 0 is a placeholder: the editor's chains number the tracks from 1 (its input 0 is the picture).
    argv = [shutil.which("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
            "-f", "lavfi", "-t", "0.1", "-i", "anullsrc=r=48000:cl=stereo"]
    for t in tracks:
        argv += [*ffmpeg_limits.decode_thread_options(), "-i", t.path]
    graph, labels = [], []
    for run in rs.audio_runs(tracks):
        label = f"a{run[0]}"
        graph.extend(rs.audio_run_filters(tracks, run, label))
        labels.append(f"[{label}]")
    length = spec.video_length_s
    graph.append("".join(labels) + f"amix=inputs={len(labels)}:duration=longest:normalize=0,apad,atrim=end={length:.6f}[out]")
    argv += [*ffmpeg_limits.thread_options(), "-filter_complex", ";".join(graph), "-map", "[out]", "-c:a", "pcm_s16le", str(out)]
    res = _run_limited(argv)
    res.update({"inputs": len(tracks), "amix_inputs": len(labels), "acrossfades": ";".join(graph).count("acrossfade"),
                "lufs_tp": ebur128(out) if res["ok"] else None})
    return res


def _duck(spans, film_s: float, db: float = DUCK_DB) -> str:
    env = rs.AudioTrack(path="x", duration_s=film_s, duck_db=db, duck_attack_s=tl.DUCK_DEFAULTS["attack_s"],
                        duck_release_s=tl.DUCK_DEFAULTS["release_s"], duck_spans=tuple(spans))
    return f"volume=volume='{rs.duck_expression(env)}':eval=frame"


def duck_tests(stem: Path, narration: Path, film_s: float, spans, scene_s: int, scenes: int, d: Path) -> dict:
    """The stem under the narration two ways: the editor's duck envelope (-12 dB) and sidechaincompress keyed by
    the narration, at the narration's level and 6 dB under it (does the depth follow the speech level?)."""
    k_n = next(i for i in range(scenes) if role(i) == "narrated")

    def level(path: Path, k: int) -> Optional[float]:
        return rms_db(path, window(k, scene_s) + "," + band(AMB_HZ))

    out = {"stem_as_is": {"narrated": level(stem, k_n), "wordless": level(stem, UNNARRATED_SCENE)}}
    p = d / "stem_envelope.wav"
    _ff(["-i", str(stem), "-af", _duck(spans, film_s), str(p)])
    out["envelope_12db"] = {"narrated": level(p, k_n), "wordless": level(p, UNNARRATED_SCENE)}
    for name, key_gain in (("sidechain_key_as_is", 0.0), ("sidechain_key_minus6db", -6.0)):
        p = d / f"stem_{name}.wav"
        t0 = time.monotonic()
        _ff(["-i", str(stem), "-i", str(narration), "-filter_complex",
             f"[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume={key_gain}dB[k];"
             "[0:a][k]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400:knee=2[o]", "-map", "[o]", str(p)])
        out[name] = {"narrated": level(p, k_n), "wordless": level(p, UNNARRATED_SCENE),
                     "wall_s": round(time.monotonic() - t0, 2)}
    return out


def _loudnorm_json(stderr: str) -> dict:
    m = re.findall(r"\{[^{}]*\"input_i\"[^{}]*\}", stderr, re.S)
    return json.loads(m[-1]) if m else {}


def two_pass_loudnorm(src: Path, out: Path, target_i: float = -14.0, target_tp: float = -1.0, lra: float = 11.0) -> dict:
    """Measure, then apply with the measured values and linear=true; report which mode loudnorm says it used."""
    t0 = time.monotonic()
    p1 = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-i", str(src), "-vn", "-af",
                         f"loudnorm=I={target_i}:TP={target_tp}:LRA={lra}:print_format=json", "-f", "null", "-"],
                        capture_output=True, text=True)
    m = _loudnorm_json(p1.stderr)
    t1 = time.monotonic()
    p2 = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-y", "-i", str(src), "-vn", "-af",
                         f"loudnorm=I={target_i}:TP={target_tp}:LRA={lra}:measured_I={m['input_i']}:measured_TP={m['input_tp']}"
                         f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}"
                         ":linear=true:print_format=json,aresample=48000", "-c:a", "pcm_s16le", str(out)],
                        capture_output=True, text=True)
    m2 = _loudnorm_json(p2.stderr)
    return {"target": {"I": target_i, "TP": target_tp, "LRA": lra},
            "pass1": {k: m.get(k) for k in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")},
            "pass1_s": round(t1 - t0, 2), "pass2_s": round(time.monotonic() - t1, 2),
            "normalization_type": m2.get("normalization_type"), "result_lufs_tp": ebur128(out)}


def proposal(cut, resolver, files: Dict[str, Path], d: Path, scene_s: int, scenes: int) -> dict:
    stem = d / "ambience_stem.wav"
    res = {"stem": ambience_stem(with_clip_audio(cut.doc), resolver, stem)}
    film_s = cut.length_s
    nar = [(c["start_s"], c["start_s"] + c["out_s"] - c["in_s"]) for t in cut.doc["tracks"]
           if t.get("role") == "speech" for c in t["clips"]]
    gap = tl.DUCK_DEFAULTS["attack_s"] + tl.DUCK_DEFAULTS["release_s"]
    nar_spans = tl.merge_spans(nar, gap)
    # "Speech" for the music is the narration AND the dialogue scenes' speech regions (the stem regions a scene marked
    # in-clip dialogue speaks in); for the ambience it is the narration only (the dialogue rides in the stem itself).
    dlg = [_speech_window(i, scene_s) for i in range(scenes) if role(i) == "dialogue"]
    speech_spans = tl.merge_spans(sorted(nar + dlg), gap)
    res["duck_spans"] = {"narration": len(nar_spans), "narration_and_dialogue": len(speech_spans)}
    res["duck"] = duck_tests(stem, files["narration"], film_s, nar_spans, scene_s, scenes, d)
    as_is = d / "master_as_is.mp4"
    if as_is.exists():
        res["loudnorm_on_as_is_master"] = two_pass_loudnorm(as_is, d / "as_is_loudnorm.wav")
    gain = cut.plan["audio"]["narration"]["loudness"]["gain_db"] if cut.plan["audio"]["narration"] else 0.0
    fmt = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
    mix = d / "proposed_premaster.wav"
    t0 = time.monotonic()
    _ff(["-i", str(files["narration"]), "-i", str(files["music"]), "-i", str(stem), "-filter_complex",
         f"[0:a]atrim=end={film_s},asetpts=PTS-STARTPTS,{fmt},volume={gain}dB[n];"
         f"[1:a]atrim=end={film_s},asetpts=PTS-STARTPTS,{fmt},volume={ft.MUSIC_GAIN_DB_DEFAULT}dB,"
         f"afade=t=in:st=0:d={ft.MUSIC_FADE_IN_S},afade=t=out:st={film_s - ft.MUSIC_END_FADE_S}:d={ft.MUSIC_END_FADE_S},"
         f"{_duck(speech_spans, film_s)}[m];"
         f"[2:a]{fmt},volume={STEM_GAIN_DB}dB,{_duck(nar_spans, film_s)}[s];"
         "[n][m][s]amix=inputs=3:duration=first:normalize=0[o]", "-map", "[o]", "-c:a", "pcm_s16le", str(mix)])
    premix_s = round(time.monotonic() - t0, 2)
    final = d / "proposed_final.wav"
    ln = two_pass_loudnorm(mix, final)
    res["proposed_mix"] = {"premaster_s": premix_s, "premaster_lufs_tp": ebur128(mix), "loudnorm": ln,
                           "band_lufs_after": {n: ebur128(final, band(hz))[0] for n, hz in
                                               (("ambience", AMB_HZ), ("dialogue", DIALOGUE_HZ),
                                                ("narration", NARRATION_HZ), ("music", MUSIC_HZ))},
                           "scenes_after": scene_levels(final, scene_s, scenes)}
    return res


def stem_doc(doc: dict, assets: dict, paths: dict, stem: Path, film_s: float) -> Tuple[dict, dict, dict]:
    """What-if: the stem on one A track of its own (no role, so the music's duck is unchanged)."""
    doc = copy.deepcopy(doc)
    sid = _uuid(3, 0xA)
    doc["tracks"].insert(1, {"id": "clip_sound", "kind": "A", "clips": [
        {"id": "amb1", "asset_id": sid, "start_s": 0.0, "in_s": 0.0, "out_s": film_s}]})
    assets, paths = dict(assets), dict(paths)
    assets[sid] = {"kind": "audio", "duration_s": film_s}
    paths[sid] = stem
    return doc, assets, paths


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--scenes", type=int, default=30)
    ap.add_argument("--scene-s", type=int, default=3)
    ap.add_argument("--res", default="1080p")
    ap.add_argument("--variants", default="as_is,clip_audio,stem")
    ap.add_argument("--timeout-s", type=float, default=None)
    ap.add_argument("--proposal", type=int, default=1)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    d = Path(args.dir)
    w, h = ft.frame_for("16:9", args.res)
    t0 = time.monotonic()
    files = generate(d / "src", w, h, args.scenes, args.scene_s)
    cut, assets, paths, nar = build(files, w, h, args.res, args.scenes, args.scene_s)
    resolver = resolver_for(assets, paths)
    roles = [role(i) for i in range(args.scenes)]
    result = {"frame": f"{w}x{h}", "scenes": args.scenes, "scene_s": args.scene_s, "film_s": cut.length_s,
              "roles": {r: roles.count(r) for r in sorted(set(roles))}, "generate_s": round(time.monotonic() - t0, 1),
              "narration_take": nar, "plan_audio": cut.plan["audio"],
              "sources": {k: {**probe_audio(p), "lufs_tp": ebur128(p)} for k, p in files.items()}, "variants": {}}
    print(json.dumps({k: v for k, v in result.items() if k != "variants"}, indent=1), flush=True)
    if args.proposal:
        result["proposal"] = None       # filled after as_is, which its loudnorm reads
    for v in args.variants.split(","):
        doc, res_for = cut.doc, resolver
        if v == "clip_audio":
            doc = with_clip_audio(cut.doc)
        elif v == "stem":
            stem = d / "ambience_stem.wav"
            if not stem.exists():
                ambience_stem(with_clip_audio(cut.doc), resolver, stem)
            doc, a2, p2 = stem_doc(cut.doc, assets, paths, stem, cut.length_s)
            res_for = resolver_for(a2, p2)
        problems = tl.validate(doc)
        out = d / f"master_{v}.mp4"
        work = d / f"work_{v}"
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)
        entry = {"doc_problems": problems,
                 "v_clips": sum(len(t["clips"]) for t in doc["tracks"] if t["kind"] == "V"),
                 "a_clips": sum(len(t["clips"]) for t in doc["tracks"] if t["kind"] == "A"),
                 "v_clips_with_audio_flag": sum(1 for t in doc["tracks"] if t["kind"] == "V" for c in t["clips"]
                                                if c.get("audio") is True)}
        if not problems:
            entry.update(render(doc, res_for, out, work, args.timeout_s or tl.render_timeout_s(cut.length_s)))
            if entry.get("ok"):
                entry["analysis"] = analyse(out, args.scene_s, args.scenes)
        shutil.rmtree(work, ignore_errors=True)
        result["variants"][v] = entry
        print(json.dumps({v: entry}, indent=1), flush=True)
        if v == "as_is" and args.proposal:
            result["proposal"] = proposal(cut, resolver, files, d, args.scene_s, args.scenes)
            print(json.dumps({"proposal": result["proposal"]}, indent=1), flush=True)
    Path(args.out).write_text(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
