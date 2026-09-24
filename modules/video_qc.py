"""Deterministic video QC — measure the rendered file before the gate reads it.

Why this exists
---------------
Until now the pre-publish gate's picture of the video was "a file exists and
is over 100 KB". A render that stopped halfway, a mux that dropped the audio
track, or a compositor that fell back to a black background all pass that
check, and every one of them is a video a viewer would reject in seconds. This
module measures the file with ffmpeg — the same binary the render already
depends on — and returns numbers, not opinions:

* **container** — duration, a video and an audio stream, resolution and fps
  against what the channel renders (``config.VIDEO_WIDTH/HEIGHT/FPS``);
* **duration** — the final video against the narration it was cut to. The
  compositor sets the video's duration from the audio, so any real drift means
  the render lost or invented footage;
* **decode** — the whole file decodes to the end (a truncated or corrupt mp4
  can still carry a plausible header);
* **black** — long black runs (``blackdetect``). The compositor's fallback when
  no visual was built is a black/near-black ``ColorClip``;
* **silence** — long silent runs (``silencedetect``).

Black and silent runs are mapped onto scene ids (``s000``, ``s001`` …, the
script section index — the shared Video IR convention) using the audio
timeline, so the report joins the IR and a human sees *where* it went wrong.

The decode, black and silence checks share ONE full decode pass: on a 2-core
runner decoding a ten-minute 1080p file is the expensive part, and paying for
it three times would be waste.

Severity
--------
``QcReport.blocks`` are findings severe enough that no one should publish the
file (no audio, truncated, a long black hole). ``QcReport.warnings`` are worth
a human's eye but not a hold. Whether ``blocks`` actually stop an upload is the
gate's call (``publish_gate`` follows ``block_on_sanity``), not this module's.

A check that could not *run* — ffmpeg missing, a timeout, an unparseable
output — is a warning, never a block: turning every tooling hiccup into a
held video would make the checker an outage of the channel. It is also never
reported as a pass (``status="error"`` / ``"skipped"``): an unmeasured value
is not a measured one.

``run()`` never raises.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

REPORT_NAME = "qc_report.json"

# Duration tolerance. The compositor sets the video's duration to the audio's,
# so an honest render differs only by container/codec rounding: one frame at
# 30 fps (33 ms), AAC priming (~21-46 ms) and the MP3 encoder delay/padding of
# the narration (~26-50 ms) — well under 0.2 s combined. Half a second is
# already several times that and is worth a look; a full second is a missing
# or extra spoken word, i.e. a render that stopped early or a mux that cut the
# ending, and blocks.
DURATION_WARN_S = 0.5
DURATION_BLOCK_S = 1.0

# Black runs. blackdetect with pix_th=0.10 counts a frame as black when 98% of
# its pixels are below ~10% luma; the compositor's "no clip" filler (15,15,30)
# is caught by that, fades are too short to reach BLACK_MIN_S. Two seconds of
# black is a visible dead spot worth a look. The block threshold is kept at
# ten seconds, not lower, because genuinely dark footage (a starfield, a night
# shot) also reads as black: a clip or two of it must not hold a video, while
# ten seconds is a hole where a section's footage is missing. A video that is
# a quarter black is a failed render whatever the runs.
BLACK_MIN_S = 1.0
BLACK_PIX_TH = 0.10
BLACK_WARN_S = 2.0
BLACK_BLOCK_S = 10.0
BLACK_BLOCK_FRACTION = 0.25

# Silent runs. Scripts mark dramatic pauses with [PAUSE:n] (typically 1-2 s),
# and a whoosh is overlaid every ~35 s, so a real narrated video is never
# silent for long. Four seconds is longer than any intended pause; ten is a
# dropped narration segment.
SILENCE_NOISE_DB = -50
SILENCE_MIN_S = 2.0
SILENCE_WARN_S = 4.0
SILENCE_BLOCK_S = 10.0

# fps within this of the target counts as the target (29.97 vs 30).
FPS_TOLERANCE = 0.5

PROBE_TIMEOUT_S = 60
# A full decode of a long 1080p file on a 2-core runner; generous, because a
# timeout here is a warning that the check did not run, not a verdict.
SCAN_TIMEOUT_S = 1200

# ffmpeg's own words for "this is not a readable media file" — measured, so it
# blocks, as opposed to ffmpeg itself failing to run, which only warns.
_UNREADABLE_MARKERS = (
    "invalid data found when processing input",
    "moov atom not found",
    "no such file or directory",
    "end of file",
)
# Word-bounded so a title like "Terror" in container metadata is not an error.
_DECODE_ERROR = re.compile(r"\b(error|invalid nal|corrupt\w*|concealing|missing picture)\b", re.I)

STATUS_PASS = "pass"
STATUS_WARN = "warn"
STATUS_FAIL = "fail"
STATUS_ERROR = "error"
STATUS_SKIPPED = "skipped"


@dataclass
class QcCheck:
    name: str
    status: str
    detail: str = ""


@dataclass
class QcReport:
    """What was measured, and what it means.

    `measured` holds raw numbers; a key is absent (or None) when the value was
    not measured — never 0. `blocks` and `warnings` are short reason codes of
    our own, safe for the event stream.
    """

    video_path: str = ""
    checks: list = field(default_factory=list)
    blocks: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    measured: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.blocks

    def add(self, name: str, status: str, detail: str = "") -> None:
        self.checks.append(QcCheck(name, status, detail))

    def to_dict(self) -> dict:
        return {
            "video_path": self.video_path,
            "ok": self.ok,
            "checks": [asdict(c) for c in self.checks],
            "blocks": list(self.blocks),
            "warnings": list(self.warnings),
            "measured": dict(self.measured),
        }

    def to_metadata(self) -> dict:
        """Compact form for event metadata: everything but the local path."""
        data = self.to_dict()
        data.pop("video_path", None)
        return data


# ── tooling ────────────────────────────────────────────────────────────────


def _ffmpeg_exe() -> Optional[str]:
    """The ffmpeg the render already uses (imageio-ffmpeg), or PATH's."""
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


def _ffprobe_exe() -> Optional[str]:
    """imageio-ffmpeg ships no ffprobe; the Actions runner has one via apt.
    Absent locally is normal — probing then parses `ffmpeg -i` instead."""
    return shutil.which("ffprobe")


class _Unreadable(Exception):
    """ffmpeg ran and said the file is not valid media."""


# ── probe ──────────────────────────────────────────────────────────────────


def _parse_rate(value) -> Optional[float]:
    try:
        text = str(value)
        if "/" in text:
            num, den = text.split("/", 1)
            den_f = float(den)
            return float(num) / den_f if den_f else None
        rate = float(text)
        return rate if rate > 0 else None
    except (TypeError, ValueError):
        return None


def _probe_ffprobe(exe: str, path: Path) -> dict:
    done = subprocess.run(
        [exe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, timeout=PROBE_TIMEOUT_S,
    )
    if done.returncode != 0:
        err = (done.stderr or "").lower()
        if any(m in err for m in _UNREADABLE_MARKERS):
            raise _Unreadable()
        raise RuntimeError(f"ffprobe exited {done.returncode}")
    data = json.loads(done.stdout or "{}")
    out = {"duration_s": None, "video": None, "audio": None}
    try:
        out["duration_s"] = float((data.get("format") or {}).get("duration"))
    except (TypeError, ValueError):
        pass
    for stream in data.get("streams") or []:
        kind = stream.get("codec_type")
        if kind == "video" and out["video"] is None:
            out["video"] = {
                "codec": stream.get("codec_name"),
                "width": stream.get("width"),
                "height": stream.get("height"),
                "fps": _parse_rate(stream.get("avg_frame_rate")) or _parse_rate(stream.get("r_frame_rate")),
            }
        elif kind == "audio" and out["audio"] is None:
            out["audio"] = {"codec": stream.get("codec_name")}
    return out


_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)")
_VIDEO_LINE = re.compile(r"Stream #\S+.*?: Video: (\w+).*", re.I)
_AUDIO_LINE = re.compile(r"Stream #\S+.*?: Audio: (\w+)", re.I)
_SIZE_RE = re.compile(r",\s*(\d{2,5})x(\d{2,5})")
_FPS_RE = re.compile(r",\s*(\d+(?:\.\d+)?)\s*fps")


def _parse_ffmpeg_info(stderr: str) -> dict:
    """Probe facts from `ffmpeg -i` banner text — the fallback when there is no
    ffprobe. The banner format has been stable for a decade."""
    out = {"duration_s": None, "video": None, "audio": None}
    m = _DURATION_RE.search(stderr)
    if m:
        h, mnt, s = m.groups()
        out["duration_s"] = int(h) * 3600 + int(mnt) * 60 + float(s)
    for line in stderr.splitlines():
        vm = _VIDEO_LINE.search(line)
        if vm and out["video"] is None:
            size = _SIZE_RE.search(line)
            fps = _FPS_RE.search(line)
            out["video"] = {
                "codec": vm.group(1),
                "width": int(size.group(1)) if size else None,
                "height": int(size.group(2)) if size else None,
                "fps": float(fps.group(1)) if fps else None,
            }
            continue
        am = _AUDIO_LINE.search(line)
        if am and out["audio"] is None:
            out["audio"] = {"codec": am.group(1)}
    return out


def _probe_ffmpeg(exe: str, path: Path) -> dict:
    # `ffmpeg -i` with no output exits 1 by design; the banner is what we read.
    done = subprocess.run(
        [exe, "-hide_banner", "-nostdin", "-i", str(path)],
        capture_output=True, text=True, timeout=PROBE_TIMEOUT_S,
    )
    err = done.stderr or ""
    if any(m in err.lower() for m in _UNREADABLE_MARKERS) and "Duration:" not in err:
        raise _Unreadable()
    info = _parse_ffmpeg_info(err)
    if info["duration_s"] is None and info["video"] is None and info["audio"] is None:
        raise RuntimeError("ffmpeg -i output had no stream information")
    return info


def probe(path: Path) -> dict:
    """{duration_s, video: {codec,width,height,fps}|None, audio: {codec}|None}.

    Raises `_Unreadable` when ffmpeg says the file is not media, and any other
    exception when the tooling itself failed. Callers turn those into a block
    and a warning respectively.
    """
    ffprobe = _ffprobe_exe()
    if ffprobe:
        return _probe_ffprobe(ffprobe, path)
    exe = _ffmpeg_exe()
    if not exe:
        raise FileNotFoundError("ffmpeg")
    return _probe_ffmpeg(exe, path)


# ── the decode pass ────────────────────────────────────────────────────────

_BLACK_RE = re.compile(r"black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)")
_SILENCE_START_RE = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SILENCE_END_RE = re.compile(r"silence_end:\s*([\d.]+)")
_OUT_TIME_RE = re.compile(r"out_time_us=(\d+)")


def _parse_scan(stdout: str, stderr: str, *, fallback_end_s: Optional[float]) -> dict:
    black = [(float(a), float(b)) for a, b in _BLACK_RE.findall(stderr)]
    silence = []
    open_start = None
    for line in stderr.splitlines():
        sm = _SILENCE_START_RE.search(line)
        if sm:
            open_start = max(0.0, float(sm.group(1)))
            continue
        em = _SILENCE_END_RE.search(line)
        if em and open_start is not None:
            silence.append((open_start, float(em.group(1))))
            open_start = None
    times = _OUT_TIME_RE.findall(stdout)
    decoded_s = int(times[-1]) / 1_000_000 if times else None
    if open_start is not None:
        # Older ffmpeg does not flush a trailing silence_end at EOF: the
        # silence ran to the end of what was decoded.
        end = decoded_s if decoded_s is not None else fallback_end_s
        if end is not None and end > open_start:
            silence.append((open_start, end))
    decode_errors = sum(
        1 for line in stderr.splitlines()
        if _DECODE_ERROR.search(line) and "detect" not in line
    )
    return {
        "black": black,
        "silence": silence,
        "decoded_s": decoded_s,
        "decode_errors": decode_errors,
    }


def scan(path: Path, *, has_video: bool, has_audio: bool,
         duration_s: Optional[float] = None) -> dict:
    """One full decode with blackdetect + silencedetect attached."""
    exe = _ffmpeg_exe()
    if not exe:
        raise FileNotFoundError("ffmpeg")
    cmd = [exe, "-hide_banner", "-nostdin", "-nostats", "-i", str(path)]
    if has_video:
        cmd += ["-vf", f"blackdetect=d={BLACK_MIN_S}:pix_th={BLACK_PIX_TH}"]
    else:
        cmd += ["-vn"]
    if has_audio:
        cmd += ["-af", f"silencedetect=noise={SILENCE_NOISE_DB}dB:d={SILENCE_MIN_S}"]
    else:
        cmd += ["-an"]
    cmd += ["-f", "null", "-progress", "pipe:1", "-"]
    done = subprocess.run(cmd, capture_output=True, text=True, timeout=SCAN_TIMEOUT_S)
    result = _parse_scan(done.stdout or "", done.stderr or "", fallback_end_s=duration_s)
    result["returncode"] = done.returncode
    return result


# ── scene mapping ──────────────────────────────────────────────────────────


def scene_id(section_index: int) -> str:
    """The shared Video IR scene id for a script section index."""
    return f"s{int(section_index):03d}"


def scenes_for_span(timeline, start_s: float, end_s: float) -> list:
    """Scene ids whose [start_ms, end_ms) window overlaps [start_s, end_s]."""
    ids = []
    for i, entry in enumerate(timeline or []):
        try:
            a = float(entry["start_ms"]) / 1000
            b = float(entry["end_ms"]) / 1000
        except (KeyError, TypeError, ValueError):
            continue
        if a < end_s and b > start_s:
            ids.append(scene_id(i))
    return ids


def _spans(runs, timeline) -> list:
    return [
        {
            "start_s": round(a, 3),
            "end_s": round(b, 3),
            "duration_s": round(b - a, 3),
            "scene_ids": scenes_for_span(timeline, a, b),
        }
        for a, b in runs
    ]


def _where(span: dict) -> str:
    ids = span.get("scene_ids") or []
    return f"@{ids[0]}" if ids else f"@{span['start_s']:.1f}s"


# ── expected format ────────────────────────────────────────────────────────


def _expected_format():
    try:
        import config

        return int(config.VIDEO_WIDTH), int(config.VIDEO_HEIGHT), float(config.VIDEO_FPS)
    except Exception:
        return 1920, 1080, 30.0


def _narration_seconds(audio_path, narration_duration_s, timeline):
    """Where the narration length comes from, in order of trust: an explicit
    value, the mixed audio file itself, then the section timeline's end."""
    if narration_duration_s is not None:
        return float(narration_duration_s), "explicit"
    if audio_path is not None and Path(audio_path).exists():
        try:
            seconds = probe(Path(audio_path)).get("duration_s")
            if seconds:
                return float(seconds), "audio_file"
        except Exception as e:
            logger.info("QC: could not probe narration audio (%s)", type(e).__name__)
    try:
        if timeline:
            return float(timeline[-1]["end_ms"]) / 1000, "timeline"
    except (KeyError, TypeError, ValueError, IndexError):
        pass
    return None, None


# ── the report ─────────────────────────────────────────────────────────────


def run(
    video_path,
    *,
    audio_path=None,
    narration_duration_s: Optional[float] = None,
    timeline: Optional[list] = None,
    expected_width: Optional[int] = None,
    expected_height: Optional[int] = None,
    expected_fps: Optional[float] = None,
    write_report: bool = True,
) -> QcReport:
    """Measure `video_path` and write `qc_report.json` next to it. Never raises."""
    report = QcReport(video_path=str(video_path or ""))
    try:
        _run_checks(
            report, video_path, audio_path=audio_path,
            narration_duration_s=narration_duration_s, timeline=timeline,
            expected=(expected_width, expected_height, expected_fps),
        )
    except Exception as e:  # belt and braces: each check already guards itself
        report.add("qc", STATUS_ERROR, type(e).__name__)
        report.warnings.append(f"video_qc_errored:{type(e).__name__}")
    if write_report and video_path:
        try:
            out = Path(video_path).parent / REPORT_NAME
            out.write_text(json.dumps(report.to_dict(), indent=2, ensure_ascii=False))
        except Exception as e:
            logger.warning("QC report could not be written (%s)", type(e).__name__)
    logger.info(
        "Video QC: %d block(s) %s, %d warning(s) %s",
        len(report.blocks), report.blocks, len(report.warnings), report.warnings,
    )
    return report


def _run_checks(report: QcReport, video_path, *, audio_path, narration_duration_s,
                timeline, expected) -> None:
    exp_w, exp_h, exp_fps = expected
    def_w, def_h, def_fps = _expected_format()
    exp_w, exp_h, exp_fps = exp_w or def_w, exp_h or def_h, exp_fps or def_fps

    if not video_path or not Path(video_path).exists():
        report.add("container", STATUS_FAIL, "file missing")
        report.blocks.append("video_qc_file_missing")
        return
    path = Path(video_path)
    report.measured["file_bytes"] = path.stat().st_size

    # ── container
    try:
        info = probe(path)
    except _Unreadable:
        report.add("container", STATUS_FAIL, "ffmpeg cannot read the file")
        report.blocks.append("video_qc_unreadable")
        return
    except FileNotFoundError:
        report.add("container", STATUS_SKIPPED, "no ffmpeg")
        report.warnings.append("video_qc_skipped:no_ffmpeg")
        return
    except Exception as e:
        report.add("container", STATUS_ERROR, type(e).__name__)
        report.warnings.append(f"video_qc_errored:probe:{type(e).__name__}")
        return

    duration = info.get("duration_s")
    video, audio = info.get("video"), info.get("audio")
    report.measured.update({
        "duration_s": duration,
        "has_video": video is not None,
        "has_audio": audio is not None,
    })
    stream_problems = []
    if video is None:
        stream_problems.append("video_qc_no_video_stream")
    if audio is None:
        stream_problems.append("video_qc_no_audio_stream")
    report.blocks.extend(stream_problems)
    report.add("streams", STATUS_FAIL if stream_problems else STATUS_PASS,
               ", ".join(stream_problems))

    if video is not None:
        w, h, fps = video.get("width"), video.get("height"), video.get("fps")
        report.measured.update({"width": w, "height": h, "fps": fps})
        if w is None or h is None:
            report.add("resolution", STATUS_ERROR, "not reported")
            report.warnings.append("video_qc_resolution_unmeasured")
        elif (w, h) != (exp_w, exp_h):
            report.add("resolution", STATUS_WARN, f"{w}x{h}, expected {exp_w}x{exp_h}")
            report.warnings.append(f"video_qc_resolution:{w}x{h}")
        else:
            report.add("resolution", STATUS_PASS, f"{w}x{h}")
        if fps is None:
            report.add("fps", STATUS_ERROR, "not reported")
            report.warnings.append("video_qc_fps_unmeasured")
        elif abs(fps - exp_fps) > FPS_TOLERANCE:
            report.add("fps", STATUS_WARN, f"{fps:g}, expected {exp_fps:g}")
            report.warnings.append(f"video_qc_fps:{fps:g}")
        else:
            report.add("fps", STATUS_PASS, f"{fps:g}")

    # ── duration vs narration
    narration_s, source = _narration_seconds(audio_path, narration_duration_s, timeline)
    report.measured["narration_s"] = narration_s
    report.measured["narration_source"] = source
    if duration is None or narration_s is None:
        report.add("duration", STATUS_SKIPPED,
                   "video duration unknown" if duration is None else "narration duration unknown")
        report.warnings.append("video_qc_duration_unchecked")
    else:
        delta = duration - narration_s
        report.measured["duration_delta_s"] = round(delta, 3)
        if abs(delta) > DURATION_BLOCK_S:
            report.add("duration", STATUS_FAIL, f"{delta:+.2f}s vs narration")
            report.blocks.append(f"video_qc_duration_mismatch:{delta:+.1f}s")
        elif abs(delta) > DURATION_WARN_S:
            report.add("duration", STATUS_WARN, f"{delta:+.2f}s vs narration")
            report.warnings.append(f"video_qc_duration_drift:{delta:+.1f}s")
        else:
            report.add("duration", STATUS_PASS, f"{delta:+.2f}s vs narration")

    if video is None and audio is None:
        return

    # ── one decode pass: truncation, black, silence
    try:
        result = scan(path, has_video=video is not None, has_audio=audio is not None,
                      duration_s=duration)
    except Exception as e:
        for name in ("decode", "black", "silence"):
            report.add(name, STATUS_ERROR, type(e).__name__)
        report.warnings.append(f"video_qc_errored:scan:{type(e).__name__}")
        return

    _judge_decode(report, result, duration)
    if video is not None:
        _judge_black(report, result, duration, timeline)
    if audio is not None:
        _judge_silence(report, result, timeline)


def _judge_decode(report: QcReport, result: dict, duration: Optional[float]) -> None:
    decoded = result.get("decoded_s")
    errors = int(result.get("decode_errors") or 0)
    report.measured["decoded_s"] = decoded
    report.measured["decode_errors"] = errors
    if decoded is None:
        report.add("decode", STATUS_ERROR, "no progress reported")
        report.warnings.append("video_qc_decode_unmeasured")
        return
    if duration is not None and decoded < duration - DURATION_BLOCK_S:
        report.add("decode", STATUS_FAIL, f"decodes to {decoded:.2f}s of {duration:.2f}s")
        report.blocks.append(f"video_qc_truncated:{decoded:.1f}s")
        return
    if errors or result.get("returncode"):
        report.add("decode", STATUS_WARN, f"{errors} decode error line(s), exit {result.get('returncode')}")
        report.warnings.append(f"video_qc_decode_errors:{errors}")
        return
    report.add("decode", STATUS_PASS, f"{decoded:.2f}s")


def _judge_black(report: QcReport, result: dict, duration: Optional[float], timeline) -> None:
    spans = _spans(result.get("black") or [], timeline)
    total = round(sum(s["duration_s"] for s in spans), 3)
    report.measured["black_segments"] = spans
    report.measured["black_total_s"] = total
    if not spans:
        report.add("black", STATUS_PASS, "no black runs")
        return
    longest = max(spans, key=lambda s: s["duration_s"])
    fraction = (total / duration) if duration else None
    if longest["duration_s"] >= BLACK_BLOCK_S or (fraction is not None and fraction >= BLACK_BLOCK_FRACTION):
        report.add("black", STATUS_FAIL, f"longest {longest['duration_s']:.1f}s, total {total:.1f}s")
        report.blocks.append(f"video_qc_black:{longest['duration_s']:.1f}s{_where(longest)}")
    elif longest["duration_s"] >= BLACK_WARN_S:
        report.add("black", STATUS_WARN, f"longest {longest['duration_s']:.1f}s")
        report.warnings.append(f"video_qc_black:{longest['duration_s']:.1f}s{_where(longest)}")
    else:
        report.add("black", STATUS_PASS, f"only short runs ({total:.1f}s total)")


def _judge_silence(report: QcReport, result: dict, timeline) -> None:
    spans = _spans(result.get("silence") or [], timeline)
    report.measured["silent_segments"] = spans
    report.measured["silent_total_s"] = round(sum(s["duration_s"] for s in spans), 3)
    if not spans:
        report.add("silence", STATUS_PASS, "no silent runs")
        return
    longest = max(spans, key=lambda s: s["duration_s"])
    if longest["duration_s"] >= SILENCE_BLOCK_S:
        report.add("silence", STATUS_FAIL, f"longest {longest['duration_s']:.1f}s")
        report.blocks.append(f"video_qc_silence:{longest['duration_s']:.1f}s{_where(longest)}")
    elif longest["duration_s"] >= SILENCE_WARN_S:
        report.add("silence", STATUS_WARN, f"longest {longest['duration_s']:.1f}s")
        report.warnings.append(f"video_qc_silence:{longest['duration_s']:.1f}s{_where(longest)}")
    else:
        report.add("silence", STATUS_PASS, "only short pauses")
