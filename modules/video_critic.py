"""AI critic on rendered frames — advisory, off by default.

What it does
------------
The deterministic QC (black runs, silence, duration) catches a render that is
broken. It cannot see a render that is *wrong*: a subtitle running off the
frame, the same stock clip three sections in a row, a shot of a beach under a
line about a coal mine, a face cropped at the eyebrows. A human reviewer spots
those in seconds; nobody reviews every video on a multi-channel schedule.

So after the render this module:

1. takes 1-3 frames from each scene — evenly spaced inside the scene's real
   audio window (one frame = the midpoint), scene id ``s{section_index:03d}``
   as in the shared Video IR;
2. tiles them into a labelled contact sheet (PIL) — one image per ~12 scenes,
   so a whole video costs one or two vision calls, not one per frame;
3. asks Gemini vision, with a response schema, for per-scene issues given each
   scene's narration: ``text_overflow``, ``empty_frame``, ``repeated_visual``,
   ``narration_mismatch``, ``bad_crop``;
4. writes ``critic_report.json`` next to the video and emits ``video.critic``.

What it deliberately does not do
--------------------------------
* **It never blocks.** Its findings are opinions from a model looking at
  thumbnails; they inform a human, the publish gate does not read them.
* **It never runs unasked.** ``CHRONOS_AI_CRITIC=1`` turns it on; unset, it
  makes no call and spends nothing.
* **It never spends past a ceiling.** When the channel set a spend ceiling and
  the known spend (this month's ledger + this run so far) has reached it, the
  critic is skipped — it is optional spend, the first thing to drop.
* **It never claims a clean bill it did not measure.** A skipped or failed
  critic says ``status: skipped/failed`` with the reason; ``issues: []`` only
  ever means the model looked and found nothing.

Every vision call is recorded in the cost ledger as ``vision_calls`` (plus the
tokens Gemini reports), stage ``critic``. ``run()`` never raises.
"""

from __future__ import annotations

import io
import json
import logging
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

ENV_FLAG = "CHRONOS_AI_CRITIC"
ENV_FRAMES = "CHRONOS_AI_CRITIC_FRAMES"
REPORT_NAME = "critic_report.json"
STAGE = "critic"

DEFAULT_FRAMES_PER_SCENE = 2
MAX_FRAMES_PER_SCENE = 3
#: Scenes per contact sheet. At 3 frames that is a 9x4 grid of 320px tiles —
#: still legible to the model, and a 12-section video is a single call.
SCENES_PER_SHEET = 12
TILE_W, TILE_H = 320, 180
LABEL_H = 22
#: Per-scene narration handed to the model. Enough to judge a mismatch;
#: capped so a long section cannot crowd the image out of the context.
NARRATION_CHARS = 400
NOTE_CHARS = 240
#: Issues carried in the event (the full list is in critic_report.json).
EVENT_ISSUE_CAP = 30
FRAME_TIMEOUT_S = 60

SEVERITIES = ("info", "warn", "severe")
KINDS = ("text_overflow", "empty_frame", "repeated_visual", "narration_mismatch", "bad_crop", "other")

STATUS_OK = "ok"
STATUS_PARTIAL = "partial"
STATUS_SKIPPED = "skipped"
STATUS_FAILED = "failed"
STATUS_DISABLED = "disabled"

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "scene_id": {"type": "string"},
                    "severity": {"type": "string", "enum": list(SEVERITIES)},
                    "kind": {"type": "string", "enum": list(KINDS)},
                    "note": {"type": "string"},
                },
                "required": ["scene_id", "severity", "kind", "note"],
            },
        },
    },
    "required": ["issues"],
}

SYSTEM_INSTRUCTION = (
    "You are a strict video editor reviewing frames from a finished narrated "
    "YouTube documentary. Each tile is labelled with its scene id and frame "
    "number. Report only problems a viewer would notice. Kinds: text_overflow "
    "(caption or on-screen text cut off or running past the frame edge), "
    "empty_frame (black, blank or placeholder frame), repeated_visual (the "
    "same shot reused across scenes), narration_mismatch (the picture "
    "contradicts or has nothing to do with the scene's narration), bad_crop "
    "(subject cut off, heads cropped, letterboxing artefacts), other. "
    "Severity: severe = a viewer would click away, warn = clearly sloppy, "
    "info = minor. Use only scene ids shown on the sheet. If a scene looks "
    "fine, report nothing for it. Return JSON only."
)


def enabled() -> bool:
    return os.getenv(ENV_FLAG, "").strip().lower() in ("1", "true", "yes", "on")


def frames_per_scene() -> int:
    try:
        n = int(os.getenv(ENV_FRAMES, "") or DEFAULT_FRAMES_PER_SCENE)
    except ValueError:
        n = DEFAULT_FRAMES_PER_SCENE
    return max(1, min(MAX_FRAMES_PER_SCENE, n))


def scene_id(section_index: int) -> str:
    """The shared Video IR scene id for a script section index."""
    return f"s{int(section_index):03d}"


@dataclass
class CriticReport:
    status: str = STATUS_DISABLED
    reason: str = ""
    model: str = ""
    scenes_reviewed: int = 0
    frames: int = 0
    vision_calls: int = 0
    sheets_failed: int = 0
    dropped_issues: int = 0
    issues: list = field(default_factory=list)

    def counts(self) -> dict:
        out = {s: 0 for s in SEVERITIES}
        for issue in self.issues:
            out[issue["severity"]] = out.get(issue["severity"], 0) + 1
        return out

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "reason": self.reason,
            "advisory": True,
            "model": self.model,
            "scenes_reviewed": self.scenes_reviewed,
            "frames": self.frames,
            "vision_calls": self.vision_calls,
            "sheets_failed": self.sheets_failed,
            "dropped_issues": self.dropped_issues,
            "counts": self.counts(),
            "issues": list(self.issues),
        }

    def to_metadata(self) -> dict:
        data = self.to_dict()
        data["issues_total"] = len(self.issues)
        data["issues"] = [
            {**i, "note": i.get("note", "")[:160]} for i in self.issues[:EVENT_ISSUE_CAP]
        ]
        return data


# ── frames ─────────────────────────────────────────────────────────────────


def frame_times(timeline, per_scene: int) -> list:
    """[(scene_id, frame_no, seconds)] — `per_scene` points evenly inside each
    scene's [start, end) window; one point is the midpoint."""
    out = []
    for i, entry in enumerate(timeline or []):
        try:
            a = float(entry["start_ms"]) / 1000
            b = float(entry["end_ms"]) / 1000
        except (KeyError, TypeError, ValueError):
            continue
        if b <= a:
            continue
        for k in range(per_scene):
            out.append((scene_id(i), k + 1, round(a + (b - a) * (k + 1) / (per_scene + 1), 3)))
    return out


def _ffmpeg_exe() -> Optional[str]:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


def _extract_frame(exe: str, video: Path, seconds: float, out: Path) -> bool:
    """One scaled JPEG at `seconds`. Input-side -ss seeks, so it is cheap."""
    done = subprocess.run(
        [exe, "-hide_banner", "-nostdin", "-v", "error", "-y", "-ss", f"{seconds:.3f}",
         "-i", str(video), "-frames:v", "1", "-vf", f"scale={TILE_W}:{TILE_H}", str(out)],
        capture_output=True, timeout=FRAME_TIMEOUT_S,
    )
    return done.returncode == 0 and out.exists() and out.stat().st_size > 0


def contact_sheet(tiles: list, columns: int):
    """tiles: [(label, PIL.Image)] → one labelled grid image."""
    from PIL import Image, ImageDraw, ImageFont

    columns = max(1, min(columns, len(tiles)))
    rows = (len(tiles) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * TILE_W, rows * (TILE_H + LABEL_H)), (32, 32, 32))
    draw = ImageDraw.Draw(sheet)
    try:
        # The label is how the model names a scene; the bitmap default font is
        # small enough to be misread. Sized fonts need Pillow >= 10.1.
        font = ImageFont.load_default(size=16)
    except TypeError:
        font = ImageFont.load_default()
    for n, (label, img) in enumerate(tiles):
        x = (n % columns) * TILE_W
        y = (n // columns) * (TILE_H + LABEL_H)
        draw.text((x + 6, y + 2), label, fill=(255, 255, 0), font=font)
        sheet.paste(img.convert("RGB").resize((TILE_W, TILE_H)), (x, y + LABEL_H))
    return sheet


# ── the model ──────────────────────────────────────────────────────────────


def _prompt(scene_ids: list, narration: dict) -> str:
    lines = ["Scenes on this sheet, with the narration spoken over each:"]
    for sid in scene_ids:
        text = " ".join((narration.get(sid) or "").split())[:NARRATION_CHARS]
        lines.append(f"{sid}: {text or '(no narration)'}")
    lines.append("Return {\"issues\": [...]} — an empty list if every scene looks right.")
    return "\n".join(lines)


def _clean_issues(raw, allowed_ids: set) -> tuple:
    """Keep only well-formed issues about scenes that were on the sheet. The
    model cannot invent a scene, and an unknown severity is not guessed at."""
    kept, dropped = [], 0
    items = raw.get("issues") if isinstance(raw, dict) else None
    for item in items or []:
        if not isinstance(item, dict):
            dropped += 1
            continue
        sid = str(item.get("scene_id", "")).strip()
        severity = str(item.get("severity", "")).strip().lower()
        if sid not in allowed_ids or severity not in SEVERITIES:
            dropped += 1
            continue
        kind = str(item.get("kind", "")).strip().lower()
        kept.append({
            "scene_id": sid,
            "severity": severity,
            "kind": kind if kind in KINDS else "other",
            "note": " ".join(str(item.get("note", "")).split())[:NOTE_CHARS],
        })
    return kept, dropped


def _ask(client, model: str, sheet_jpeg: bytes, prompt: str):
    from google.genai import types as genai_types

    from modules.gemini_client import generate_with_retry
    from modules.structured_output import json_config

    contents = [genai_types.Part.from_bytes(data=sheet_jpeg, mime_type="image/jpeg"), prompt]
    return generate_with_retry(
        client, model, contents,
        config=json_config(RESPONSE_SCHEMA, system_instruction=SYSTEM_INSTRUCTION),
    )


# ── budget ─────────────────────────────────────────────────────────────────


def _over_budget(channel, costs) -> bool:
    """True only when a ceiling is set and the KNOWN spend has reached it.

    Same rule as modules/budget.py: unknown spend never counts as exceeded, so
    a ledger that cannot be read does not stop the critic — but a ceiling that
    is known to be met does, since this is optional spend."""
    ceiling = getattr(getattr(channel, "agent", None), "spend_ceiling_usd", None)
    if ceiling is None:
        return False
    try:
        from modules import budget
        from modules.state_store import StateStore

        channel_id = getattr(channel, "channel_id", None) or getattr(costs, "channel_id", "default")
        with StateStore() as store:
            status = budget.check_budget(store, channel_id, ceiling, since_iso=budget.month_start_iso())
        this_run = sum(
            e.estimated_usd for e in (getattr(costs, "entries", None) or [])
            if getattr(e, "estimated_usd", None) is not None
        )
        return status.spent_usd + this_run >= float(ceiling)
    except Exception as e:
        logger.warning("AI critic: budget check failed (%s) — treated as unknown", type(e).__name__)
        return False


# ── entry point ────────────────────────────────────────────────────────────


def run(
    video_path,
    *,
    script=None,
    timeline=None,
    channel=None,
    costs=None,
    client=None,
    model: Optional[str] = None,
    write_report: bool = True,
    emit: bool = True,
) -> CriticReport:
    """Review the rendered video. Advisory; never raises; spends nothing unless
    `CHRONOS_AI_CRITIC` is on."""
    report = CriticReport()
    if not enabled():
        return report  # off: no call, no file, no event
    try:
        _review(report, video_path, script=script, timeline=timeline, channel=channel,
                costs=costs, client=client, model=model)
    except Exception as e:
        report.status, report.reason = STATUS_FAILED, f"errored:{type(e).__name__}"
    if write_report and video_path:
        try:
            (Path(video_path).parent / REPORT_NAME).write_text(
                json.dumps(report.to_dict(), indent=2, ensure_ascii=False))
        except Exception as e:
            logger.warning("Critic report could not be written (%s)", type(e).__name__)
    if emit:
        _emit(report, channel)
    logger.info("AI critic: %s%s — %s", report.status,
                f" ({report.reason})" if report.reason else "", report.counts())
    return report


def _emit(report: CriticReport, channel) -> None:
    try:
        from modules import event_log as events

        failed = report.status == STATUS_FAILED
        events.emit(
            events.VIDEO_CRITIC, agent="video_critic",
            status=events.STATUS_FAILED if failed else events.STATUS_COMPLETED,
            channel_id=getattr(channel, "channel_id", None),
            metadata=report.to_metadata(),
        )
    except Exception as e:
        logger.warning("AI critic event not recorded (%s)", type(e).__name__)


def _review(report: CriticReport, video_path, *, script, timeline, channel, costs,
            client, model) -> None:
    if not video_path or not Path(video_path).exists():
        report.status, report.reason = STATUS_SKIPPED, "no_video"
        return
    times = frame_times(timeline, frames_per_scene())
    if not times:
        report.status, report.reason = STATUS_SKIPPED, "no_timeline"
        return
    if client is None:
        import config

        if not getattr(config, "GEMINI_API_KEY", ""):
            report.status, report.reason = STATUS_SKIPPED, "no_gemini_key"
            return
    if _over_budget(channel, costs):
        report.status, report.reason = STATUS_SKIPPED, "budget_ceiling"
        return
    exe = _ffmpeg_exe()
    if not exe:
        report.status, report.reason = STATUS_SKIPPED, "no_ffmpeg"
        return

    sections = list(getattr(script, "sections", None) or [])
    narration = {
        scene_id(i): (getattr(s, "narration", "") or "") for i, s in enumerate(sections)
    }

    from PIL import Image

    frames: dict = {}
    with tempfile.TemporaryDirectory(prefix="critic-") as tmp:
        for sid, n, seconds in times:
            out = Path(tmp) / f"{sid}_{n}.jpg"
            try:
                if _extract_frame(exe, Path(video_path), seconds, out):
                    with Image.open(out) as img:
                        frames.setdefault(sid, []).append((f"{sid} #{n}", img.copy()))
            except Exception as e:
                logger.info("AI critic: frame %s #%d not extracted (%s)", sid, n, type(e).__name__)

    report.frames = sum(len(v) for v in frames.values())
    if not frames:
        report.status, report.reason = STATUS_FAILED, "no_frames"
        return

    if client is None:
        from modules.gemini_client import make_client

        client = make_client()
    if model is None:
        import config

        model = config.GEMINI_MODEL
    report.model = model

    per_scene = max(len(v) for v in frames.values())
    scene_ids = sorted(frames)
    sheets = [scene_ids[i:i + SCENES_PER_SHEET] for i in range(0, len(scene_ids), SCENES_PER_SHEET)]
    for ids in sheets:
        tiles = [tile for sid in ids for tile in frames[sid]]
        buf = io.BytesIO()
        contact_sheet(tiles, columns=per_scene * 3).save(buf, format="JPEG", quality=85)
        try:
            response = _ask(client, model, buf.getvalue(), _prompt(ids, narration))
        except Exception as e:
            report.sheets_failed += 1
            logger.warning("AI critic: vision call failed (%s)", type(e).__name__)
            continue
        # A call that answered was billed, whether or not its JSON parses — so
        # it is counted before the parse, not after.
        report.vision_calls += 1
        if costs is not None:
            try:
                from modules.cost_ledger import VISION_CALLS

                costs.add(VISION_CALLS, 1, stage=STAGE)
                costs.add_gemini_usage(response, stage=STAGE)
            except Exception:
                pass
        try:
            from modules.structured_output import parse_structured

            parsed = parse_structured(response)
        except Exception as e:
            report.sheets_failed += 1
            logger.warning("AI critic: unreadable answer (%s)", type(e).__name__)
            continue
        issues, dropped = _clean_issues(parsed, set(ids))
        report.issues.extend(issues)
        report.dropped_issues += dropped
        report.scenes_reviewed += len(ids)

    if report.scenes_reviewed == 0:
        report.status, report.reason = STATUS_FAILED, "vision_call_failed"
    elif report.sheets_failed:
        report.status, report.reason = STATUS_PARTIAL, f"sheets_failed:{report.sheets_failed}"
    else:
        report.status = STATUS_OK
