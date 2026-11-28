"""Film Studio S2: a film's sound, mixed and mastered before the picture's final pass (server-side only).

Evidence and design: docs/studio/S2_CLIP_AUDIO.md (measured on a 90 s, 30-shot film at 1080p on 2 cores).
``film_timeline.build_cut`` decides what the film sounds like; this module makes that sound, in three
audio-only ffmpeg commands under ``ffmpeg_limits`` and the assembly's own deadline, and hands the final pass
ONE file to mux:

1. **The clip stem.** Every shown shot whose sound the cut plays (``Cut.sound["stem"]``) is read from its
   video with the editor's own chains (``render_spec.audio_track_filter``: trim, 48 kHz stereo, the gain;
   ``acrossfade`` at a cross-fade between two sounding shots, a fade under a silent neighbour, exactly as
   ``timeline_render`` places a V clip's sound) and mixed into one file on the film's clock. Each shot is
   lowered by the editor's duck envelope under its own spans before the join: an ambience shot under the
   narration and the dialogue regions, a dialogue shot under the narration only (its lines are in it). One
   input instead of one per shot: 25 shots' sound took 1.07 s and 121 MB.
2. **The premaster.** The editor's own audio graph of the final pass (``render_spec.audio_runs`` /
   ``audio_run_filters`` / ``audio_duck_filter``, the same strings the final pass would build) over the
   narration, the music and the stem, written as float WAV so nothing clips before the loudness pass. With
   clip sound, the music's duck spans are the cut's explicit ones (the narration AND the dialogue regions),
   never "every clip that sounds", which ducked a wordless reel under one span of the whole film.
3. **One master loudness pass.** Two-pass ``loudnorm`` to ``film_timeline.MASTER_*``: measure, then apply
   the measured values with ``linear=true``. loudnorm itself falls back to its dynamic mode when a linear
   gain cannot meet the targets (measured: today's narration-only master, LRA 14 against 11). Atlas decided
   on 28 Nov that such a film ships in the dynamic mode rather than failing, labelled: the report says
   ``dynamic (linear not possible)`` with the measured I, TP and LRA, and the assembly records it on the
   film's file. A mix with no measurable sound is left as it is and says so; nothing is ever reported as
   normalised that was not.

Nothing here calls a provider or spends: it reads files already on the media volume.
"""

from __future__ import annotations

import json
import math
import re
import time
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from modules import ffmpeg_limits
from modules import film_timeline as ft
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render
from modules.render_spec import AudioTrack

#: Every intermediate is 32-bit float WAV at 48 kHz stereo: the sum of the beds can pass 0 dBFS before the
#: loudness pass brings it down, and an integer format would clip it there.
WAV_CODEC = ("-c:a", "pcm_f32le", "-ar", "48000", "-ac", "2")
#: Below this the mix holds no sound loudnorm can measure (its own gate is -70 LUFS).
SILENT_LUFS = -70.0

#: The most shots one stem command reads. Measured by Lens under ffmpeg_limits (2 GiB, two decoder threads per input): 100 video
#: inputs mixed at 156 MB, while 120 to 180 failed (pthread_create: every input starts its own decoder threads under the
#: address-space limit). A 60-scene film of 3 shots each is 180, so the stem is mixed in chunks of at most this many shots, then
#: the chunks into one stem.
STEM_CHUNK_SHOTS = 64
#: One 32-bit float WAV at 48 kHz stereo, in MB per second of film (0.384, rounded up): what each intermediate costs on disk.
WAV_MB_PER_S = 0.4

REASONS = ("clip_without_sound", "sound_mix_failed", "render_timed_out", "mix_silent")


class MixFailed(Exception):
    """The film's sound could not be made: ``reason`` is one of REASONS, ``detail`` names the fix."""

    def __init__(self, reason: str, detail: str):
        assert reason in REASONS, reason
        self.reason, self.detail = reason, detail
        super().__init__(f"{reason}: {detail}")


@dataclass(frozen=True)
class Mixed:
    #: What the final pass mixes: the one mastered file, or nothing for a film without sound.
    tracks: Tuple[AudioTrack, ...]
    #: The loudness pass's report (None: the film has no sound at all).
    loudness: Optional[dict]
    #: Shots in the clip stem.
    stem_shots: int = 0
    #: Inputs of the premaster (narration clips + music tiles + the stem).
    premaster_inputs: int = 0
    timings: Dict[str, float] = field(default_factory=dict)


Runner = Callable[[Sequence[str], float], ffmpeg_limits.Outcome]


def _run_limited(argv: Sequence[str], timeout_s: float) -> ffmpeg_limits.Outcome:
    return ffmpeg_limits.run(argv, timeout_s=timeout_s)


# ── what to mix ──────────────────────────────────────────────────────────────

def _near(spans: Sequence[Sequence[float]], first: float, last: float, attack: float, release: float
          ) -> Tuple[Tuple[float, float], ...]:
    """The spans whose envelope reaches into [first, last] (as timeline_render keeps a music tile's)."""
    return tuple((float(a), float(b)) for a, b in spans if a - attack < last and b + release > first)


def _ducked(track: AudioTrack, spans, db: float, attack: float, release: float) -> AudioTrack:
    near = _near(spans, track.start_s, track.start_s + track.output_s, attack, release) if db > 0 else ()
    if not near:
        return replace(track, duck_db=0.0, duck_attack_s=0.0, duck_release_s=0.0, duck_spans=())
    return replace(track, duck_db=float(db), duck_attack_s=float(attack), duck_release_s=float(release),
                   duck_spans=near)


def stem_tracks(doc: Mapping, sound: Mapping, resolver: tl.AssetResolver) -> List[AudioTrack]:
    """The stem's shots as the editor places a V clip's own sound, each with its own duck (output time).

    The cut's document never marks a V clip ``audio: true`` (that would duck the music under the whole film);
    here a copy of its picture track does, for exactly the stem's shots, so the trims, the cross-fade joins and
    the fades under a silent neighbour are timeline_render's own."""
    roles = {x["clip"]: x["role"] for x in sound["stem"]}
    pic = [dict(t, clips=[dict(c, audio=c["id"] in roles) for c in t["clips"]])
           for t in doc["tracks"] if t["kind"] == tl.KIND_V]
    stem_doc = {k: v for k, v in doc.items() if k not in ("tracks", "captions")}
    stem_doc["tracks"] = pic
    # The cut's own document is validated (tl.load); this copy differs only in the audio flags, and is not put through the
    # editor's validator, whose ceiling of 64 sounding clips is the final pass's, not the chunked stem's (Lens I1).
    tl.load(doc)
    norm = tl.normalise(stem_doc)
    tracks = list(timeline_render._sound(norm, tl.resolve_assets(norm, resolver)))
    if len(tracks) != len(roles):
        # timeline_render leaves out, without a word, a clip whose file it does not know to carry sound. The cut
        # checked every one: a file that changed since must not go out silent (rule 4).
        raise MixFailed("clip_without_sound", f"{len(roles) - len(tracks)} shot(s) whose sound the film plays have "
                        "no sound track on the media volume: re-shoot those shots, or quote the film again without their "
                        "sound option")
    sounding = [c for t in pic for c in t["clips"] if c["audio"]]
    attack, release = float(sound["attack_s"]), float(sound["release_s"])
    out = []
    for clip, track in zip(sounding, tracks):
        if roles[clip["id"]] == "dialogue":
            out.append(_ducked(track, sound["dialogue_duck_spans"], sound["dialogue_duck_db"], attack, release))
        else:
            out.append(_ducked(track, sound["ambience_duck_spans"], sound["ambience_duck_db"], attack, release))
    gain = float(sound.get("gain_db") or 0.0)
    return [replace(t, gain_db=round(t.gain_db + gain, 3)) for t in out] if gain else out


def _input_args(path: str, *, video: bool) -> List[str]:
    # As cap_inputs caps an editor export's inputs; a video is read for its sound only (-vn: nothing decodes
    # its picture), and still capped in case that ever changes.
    cap = rs.DECODE_VIDEO_MAX_PIXELS if video else rs.DECODE_MAX_PIXELS
    return [*(["-vn"] if video else []), "-max_pixels", str(rs.decoder_max_pixels(cap)),
            *ffmpeg_limits.decode_thread_options(), *rs.INPUT_PROTOCOLS, "-i", path]


def _head(ffmpeg: str) -> List[str]:
    return [ffmpeg, "-hide_banner", "-nostdin", "-nostats", "-y", *ffmpeg_limits.thread_options()]


def _mix(labels: List[str], length_s: float) -> List[str]:
    """The runs mixed without normalisation onto a bed of silence the film's length. The bed is not decoration:
    ffmpeg's adelay only moves the timestamps of a stream that starts late, a WAV keeps no timestamps, and
    without a source that starts at 0 the whole mix began at its first sound (measured: a narration placed at
    0.25 s came out at 0 s, a quarter second ahead of its picture)."""
    bed = f"anullsrc=r=48000:cl=stereo:d={length_s:.6f},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[bed]"
    return [bed, "[bed]" + "".join(labels) + f"amix=inputs={len(labels) + 1}:duration=longest:normalize=0,"
            f"apad,atrim=end={length_s:.6f}[out]"]


def stem_command(ffmpeg: str, tracks: Sequence[AudioTrack], length_s: float, out: str) -> List[str]:
    """One ffmpeg: every stem shot's chain undelayed, its duck envelope in its own time, the cross-faded runs
    joined by ``acrossfade``, each run delayed once, all mixed without normalisation and cut to the film."""
    argv = _head(ffmpeg)
    for t in tracks:
        argv += _input_args(t.path, video=True)
    graph: List[str] = []
    labels: List[str] = []
    for run in rs.audio_runs(list(tracks)):
        parts = []
        for i in run:
            t = tracks[i]
            graph.append(rs.audio_track_filter(t, i, f"s{i}", delay=False))
            src = f"s{i}"
            if t.duck_spans:
                # Before the join the chain's clock starts at the shot's own start: its spans are moved onto it.
                local = replace(t, duck_spans=tuple((round(a - t.start_s, 3), round(b - t.start_s, 3))
                                                    for a, b in t.duck_spans))
                graph.append(rs.audio_duck_filter(local, src, f"d{i}"))
                src = f"d{i}"
            parts.append((i, src))
        prev = parts[0][1]
        for i, src in parts[1:]:
            graph.append(f"[{prev}][{src}]acrossfade=d={tracks[i].crossfade_s:.3f}:c1=tri:c2=tri[x{i}]")
            prev = f"x{i}"
        delay_ms = int(round(tracks[run[0]].start_s * 1000))
        graph.append(f"[{prev}]" + (f"adelay=delays={delay_ms}:all=1" if delay_ms > 0 else "anull") + f"[r{run[0]}]")
        labels.append(f"[r{run[0]}]")
    graph.extend(_mix(labels, length_s))
    return argv + ["-filter_complex", ";".join(graph), "-map", "[out]", *WAV_CODEC, out]


def stem_chunks(tracks: Sequence[AudioTrack], size: int = STEM_CHUNK_SHOTS) -> List[List[AudioTrack]]:
    """The stem's shots in consecutive chunks of at most ``size``. Where a chunk starts on a shot cross-faded from the chunk
    before, the join is made without ``acrossfade`` but to the same sound: ``acrossfade`` with ``c1=tri:c2=tri`` is the outgoing
    sound faded out linearly over the overlap plus the incoming one faded in linearly over it, the two overlapping by exactly
    that much (the incoming shot starts where the overlap does). So the outgoing shot gets that fade out, the incoming one that
    fade in and its own delay, and the chunks' sum is the one-command stem."""
    out: List[List[AudioTrack]] = []
    for i in range(0, len(tracks), size):
        chunk = list(tracks[i:i + size])
        if out and chunk[0].crossfade_s > 0:
            d = chunk[0].crossfade_s
            out[-1][-1] = replace(out[-1][-1], fade_out_s=max(out[-1][-1].fade_out_s, d))
            chunk[0] = replace(chunk[0], fade_in_s=max(chunk[0].fade_in_s, d), crossfade_s=0.0)
        out.append(chunk)
    return out


def sound_files_on_disk(stem_shots: int) -> int:
    """How many of film_mix's WAVs exist at once at most: the chunks and the stem while they are joined, else two (the stem and
    the premaster, then the premaster and the master). The assembly's disk check asks for this many."""
    chunks = -(-stem_shots // STEM_CHUNK_SHOTS) if stem_shots else 0
    return max(2, chunks + 1 if chunks > 1 else 2)


def join_command(ffmpeg: str, parts: Sequence[str], length_s: float, out: str) -> List[str]:
    """The chunks' stems summed (each already on the film's clock) into one."""
    argv = _head(ffmpeg)
    for p in parts:
        argv += _input_args(p, video=False)
    graph = [f"[{i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[c{i}]" for i in range(len(parts))]
    graph.extend(_mix([f"[c{i}]" for i in range(len(parts))], length_s))
    return argv + ["-filter_complex", ";".join(graph), "-map", "[out]", *WAV_CODEC, out]


def premaster_command(ffmpeg: str, tracks: Sequence[AudioTrack], length_s: float, out: str) -> List[str]:
    """The final pass's own audio graph (render_spec._timeline_command), without the picture. Its chains number
    the tracks from 1 (input 0 is the picture there), so input 0 here is a moment of generated silence."""
    argv = _head(ffmpeg) + ["-f", "lavfi", "-t", "0.1", "-i", "anullsrc=r=48000:cl=stereo"]
    for t in tracks:
        argv += _input_args(t.path, video=t.video_source)
    graph: List[str] = []
    labels: List[str] = []
    for run in rs.audio_runs(list(tracks)):
        label = f"a{run[0]}"
        graph.extend(rs.audio_run_filters(list(tracks), run, label))
        if tracks[run[0]].duck_spans:
            graph.append(rs.audio_duck_filter(tracks[run[0]], label, f"{label}d"))
            label = f"{label}d"
        labels.append(f"[{label}]")
    graph.extend(_mix(labels, length_s))
    return argv + ["-filter_complex", ";".join(graph), "-map", "[out]", *WAV_CODEC, out]


# ── loudness ─────────────────────────────────────────────────────────────────

_JSON = re.compile(r"\{[^{}]*\"input_i\"[^{}]*\}", re.S)


def loudnorm_report(stderr_tail: str) -> dict:
    """loudnorm's ``print_format=json`` block, the last one in the tail ({} when there is none)."""
    found = _JSON.findall(stderr_tail or "")
    if not found:
        return {}
    try:
        data = json.loads(found[-1])
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _num(v) -> Optional[float]:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _target() -> str:
    return f"loudnorm=I={ft.MASTER_LUFS:g}:TP={ft.MASTER_TRUE_PEAK_DB:g}:LRA={ft.MASTER_LRA:g}"


def measure_command(ffmpeg: str, src: str) -> List[str]:
    return _head(ffmpeg) + [*_input_args(src, video=False), "-af", _target() + ":print_format=json", "-f", "null", "-"]


def apply_command(ffmpeg: str, src: str, measured: Mapping[str, float], out: str) -> List[str]:
    # loudnorm resamples to 192 kHz internally and hands that on: aresample brings it back to 48 kHz.
    af = (_target() + f":measured_I={measured['I']:.2f}:measured_TP={measured['TP']:.2f}"
          f":measured_LRA={measured['LRA']:.2f}:measured_thresh={measured['thresh']:.2f}"
          f":offset={measured['offset']:.2f}:linear=true:print_format=json,aresample=48000")
    return _head(ffmpeg) + [*_input_args(src, video=False), "-af", af, *WAV_CODEC, out]


def _targets() -> dict:
    return {"I": ft.MASTER_LUFS, "TP": ft.MASTER_TRUE_PEAK_DB, "LRA": ft.MASTER_LRA}


# ── one film ─────────────────────────────────────────────────────────────────

def master(norm: Mapping, cut: ft.Cut, resolver: tl.AssetResolver, *, ffmpeg: str, workdir: str,
           timeout_s: float, run: Runner = _run_limited, progress=None) -> Mixed:
    """The film's mastered sound as one track for the final pass, and the loudness report. Raises
    :class:`MixFailed` (by name, with the fix) instead of ever handing back a mix that is not what the cut says.

    ``progress`` (optional, film_assembly.AssemblyMeter): told how many passes run (``plan``), how far each is from ffmpeg's
    own ``-progress`` report against the film's length (``at``), and when each finished (``step_done``). Every pass writes
    the film's whole length, so each is the same share. Without it every command is the one it always was."""
    deadline = time.monotonic() + float(timeout_s)
    work = Path(workdir)
    length = float(cut.length_s)
    timings: Dict[str, float] = {}

    step = [0]

    def go(name: str, argv: Sequence[str]) -> ffmpeg_limits.Outcome:
        left = deadline - time.monotonic()
        if left <= 0:
            raise MixFailed("render_timed_out", "the film's sound ran past the assembly's time limit: retry when "
                            "the server is less busy")
        t0 = time.monotonic()
        k = step[0]
        step[0] += 1
        watch = None
        argv = list(argv)
        if progress is not None:
            from modules import render_backend  # noqa: PLC0415 — the same -progress reader as the render's

            report = work / f"mix_{k}.progress"
            argv[1:1] = ["-progress", str(report)]
            watch = render_backend.ProgressFileWatch(report, lambda secs, k=k: progress.at(k, secs))
            watch.start()
        try:
            o = run(argv, left)
        finally:
            if watch is not None:
                watch.stop()
                (work / f"mix_{k}.progress").unlink(missing_ok=True)
        timings[f"{name}_s"] = round(time.monotonic() - t0, 3)
        timings[f"{name}_peak_mb"] = round(o.peak_rss_bytes / 1048576, 1)
        if o.timed_out:
            raise MixFailed("render_timed_out", "the film's sound ran past the assembly's time limit: retry when the "
                            "server is less busy")
        if not o.ok:
            raise MixFailed("sound_mix_failed", f"the film's sound could not be mixed ({name} stopped): retry the "
                            "assembly")
        if progress is not None:
            progress.step_done(k)
        return o

    # The editor's own placement of the narration and the music (gains, fades, the duck it would compute).
    beds = list(timeline_render.to_render_spec(norm, resolver, "unused.mp4").audio_tracks)
    sound = cut.sound
    stem_n = 0
    if sound is not None:
        music_paths = {resolver(c["asset_id"]).path for t in norm["tracks"] if t.get("id") == "music"
                       for c in t["clips"] if resolver(c["asset_id"]) is not None}
        attack, release = float(sound["attack_s"]), float(sound["release_s"])
        # Speech is explicit here: the narration and the dialogue regions, never every clip that sounds.
        beds = [_ducked(t, sound["music_duck_spans"], sound["music_duck_db"], attack, release)
                if t.path in music_paths else t for t in beds]
        shots = stem_tracks(cut.doc, sound, resolver)
        stem_n = len(shots)
        stem = work / "clip_stem.wav"
        chunks = stem_chunks(shots)
        if progress is not None:
            # The chunks (and their join, when there are several), the premaster, the loudness measure and the pass.
            progress.plan(len(chunks) + (1 if len(chunks) > 1 else 0) + 3)
        if len(chunks) == 1:
            go("stem", stem_command(ffmpeg, chunks[0], length, str(stem)))
        else:
            parts = [work / f"clip_stem_{k}.wav" for k in range(len(chunks))]
            for k, (chunk, part) in enumerate(zip(chunks, parts)):
                go(f"stem_{k}", stem_command(ffmpeg, chunk, length, str(part)))
            go("stem_join", join_command(ffmpeg, [str(p) for p in parts], length, str(stem)))
            for part in parts:
                part.unlink(missing_ok=True)
        beds.append(AudioTrack(path=str(stem), duration_s=length))
    if not beds:
        return Mixed(tracks=(), loudness=None, timings=timings)
    if progress is not None and sound is None:
        progress.plan(3)   # the premaster, the loudness measure and the pass

    pre = work / "premaster.wav"
    go("premaster", premaster_command(ffmpeg, beds, length, str(pre)))
    (work / "clip_stem.wav").unlink(missing_ok=True)   # in the premaster now; the disk check counts two files from here
    m = loudnorm_report(go("measure", measure_command(ffmpeg, str(pre))).tail)
    measured = {"I": _num(m.get("input_i")), "TP": _num(m.get("input_tp")), "LRA": _num(m.get("input_lra")),
                "thresh": _num(m.get("input_thresh")), "offset": _num(m.get("target_offset"))}
    if str(m.get("input_i")).strip() == "-inf" or (measured["I"] is not None and measured["I"] < SILENT_LUFS):
        narrated = any(t.get("id") == "narration" and t.get("clips") for t in norm["tracks"])
        if narrated or stem_n:
            # A narration or a shot's sound the cut says plays, and nothing measurable came out: never shipped as "silent"
            # (rule 4). The files themselves hold no sound; a retry of the same takes would mix the same silence.
            raise MixFailed("mix_silent", "the film's narration or its shots' own sound came out silent: generate the "
                            "narration again, or re-shoot the shots whose sound the film plays")
        report = {"target": _targets(), "measured": {k: measured[k] for k in ("I", "TP", "LRA")},
                  "mode": None, "status": "not applied: the mix is silent"}
        return Mixed(tracks=(AudioTrack(path=str(pre), duration_s=length),), loudness=report, stem_shots=stem_n,
                     premaster_inputs=len(beds), timings=timings)
    if any(v is None for v in measured.values()):
        raise MixFailed("sound_mix_failed", "the film's loudness could not be measured: retry the assembly")
    final = work / "master.wav"
    r = loudnorm_report(go("loudnorm", apply_command(ffmpeg, str(pre), measured, str(final))).tail)
    mode = r.get("normalization_type")
    if mode not in ("linear", "dynamic"):
        raise MixFailed("sound_mix_failed", "the loudness pass did not say how it normalised the film: retry the "
                        "assembly")
    pre.unlink(missing_ok=True)
    report = {"target": _targets(), "measured": {k: measured[k] for k in ("I", "TP", "LRA", "thresh")},
              "mode": mode,
              # Labelled, never silent (Atlas, 28 Nov): the person sees that this film's loudness range was
              # compressed to meet the target, and by how much it measured before.
              "status": "linear" if mode == "linear" else "dynamic (linear not possible)",
              "result": {"I": _num(r.get("output_i")), "TP": _num(r.get("output_tp")), "LRA": _num(r.get("output_lra"))}}
    return Mixed(tracks=(AudioTrack(path=str(final), duration_s=length),), loudness=report, stem_shots=stem_n,
                 premaster_inputs=len(beds), timings=timings)


__all__ = ["MixFailed", "Mixed", "REASONS", "SILENT_LUFS", "STEM_CHUNK_SHOTS", "WAV_MB_PER_S", "apply_command", "join_command",
           "loudnorm_report", "master", "measure_command", "premaster_command", "sound_files_on_disk", "stem_chunks",
           "stem_command", "stem_tracks"]
