"""Repurpose — up to five vertical clips from one finished master.

``modules/shorts.py`` made ONE Short per run, cut from the hook, and only when a
channel switched Shorts on. ``modules/remix_segments.py`` ranks moments but
nothing imported it. This module is the decision layer between them and the
worker (migration 0080): which windows of a master are worth cutting, whether a
window is allowed at all, and the worker's side of one request — cut each
clip with ffmpeg, build its per-platform captions, report each outcome to the
database, and let the database settle the money.

Windows are whole scenes
------------------------
A window is a run of consecutive Video IR scenes (``videos.manifest``,
``output/<slug>/project.json``). Scene times are the audio mixer's measured
section timeline, so a boundary between two scenes sits between two narration
sections: a clip never starts or ends inside a scene, and so never inside a
word. Nothing here pads, snaps or guesses a time, and a scene without real
times is never part of a window.

The limits are the database's (``repurpose_plan`` in 0080 says the same, and
``samples/repurpose_cases.json`` is run against BOTH): a clip is 15..60
seconds (the Shorts window of ``shorts.py``), at most 12 scenes, ends inside
the narration audio, and two clips of one request share no scene.

Proposing clips (advisory)
--------------------------
:func:`propose` ranks every allowed window and keeps the best non-overlapping
few, using ``remix_segments.select_segments`` (an unmeasured moment ranks
below every measured one: null is never a measured zero).

* **With a retention curve** (``scene_retention``): a window's score is how
  slowly the audience left across it — minus the drop in the share still
  watching, per minute. A window where viewers stayed or came back beats one
  where they poured out. A window whose edges lie outside the measured curve
  has no score (it is never extrapolated).
* **With no usable curve** the answer says ``retention="not_measured"`` and
  the windows are ranked by scene structure only: the longest whole-scene
  windows first, earlier before later. Nothing pretends a retention number.

The ranking only PROPOSES. What is pressed is re-derived and re-checked by the
database, and again by the worker against the files on disk.

The worker's side
-----------------
:class:`RepurposeService` is what ``tools/queue_worker.py`` calls between render
jobs, like paid downloads. It cuts from the MASTER (``videos.local_path`` under
``output/``, never the 480p review copy: a source with a short side under 720
is refused), checks the master is still the one that was priced (the Video IR
beside it names the same scenes and times), and writes each clip next to it
under ``output/<slug>/repurpose/<id>/``. Credits are not touched here: the
database captures only for the clips it was told were made and releases the
rest (``finish_repurpose_request``). Nothing is uploaded or published.

Nothing secret is logged: request ids, reason words and exception types only.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import time
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from modules import remix_segments, scene_retention, shorts, social_captions, social_publish

logger = logging.getLogger(__name__)

# ── limits (migration 0080 repeats these; tests/test_repurpose_migration.py
#    pins that the two agree) ────────────────────────────────────────────────

MIN_CLIP_SECONDS = 15.0
MAX_CLIP_SECONDS = 60.0
MAX_CLIPS = 5
MAX_CLIP_SCENES = 12
#: Clips made from one master in all (every clip is a file on the worker's
#: disk that nothing prunes). The database enforces it (reason clip_limit).
MAX_CLIPS_PER_MASTER = 20
#: A window may end this far past the narration audio's measured length.
AUDIO_SLACK_S = 0.5
#: Two scenes may overlap by this much at their shared edge.
EDGE_SLACK_S = 0.001
#: The smallest frame short side a master may have: below this it is a review
#: copy (480p) and never a source.
MIN_SOURCE_SIDE = 720
#: How far the worker lets a window drift from what was priced.
TERMS_TOLERANCE_S = 0.05
#: How far a made clip's length may be from its window.
CLIP_LENGTH_TOLERANCE_S = 0.6
#: The master's measured length vs the narration audio's.
MASTER_LENGTH_TOLERANCE_S = 2.0
MIN_FREE_BYTES = 512 * 1024 * 1024
HEARTBEAT_S = 30.0
CLIP_TIMEOUT_S = 30 * 60
SWEEP_S = 10 * 60.0

_SCENE_ID = re.compile(r"^s[0-9]{3,4}$")
_CLIP_PATH = re.compile(r"^output/[a-z0-9][a-z0-9-]{0,63}/repurpose/[0-9a-f]{8}/clip-[0-9]{2}\.mp4$")

# The reason words the database and this module share (the quote's `reason`).
REASONS = (
    "invalid_clips", "no_manifest", "scene_ids_not_unique", "scene_not_found", "invalid_range",
    "too_many_scenes", "scene_timing_unknown", "clip_too_short", "clip_too_long", "beyond_audio",
    "clips_overlap",
)


# ── numbers ─────────────────────────────────────────────────────────────────


def _num(value) -> Optional[Decimal]:
    """A JSON number as an exact decimal; None for anything else (a bool is not
    a number here, exactly as ``jsonb_typeof(x) = 'number'`` in the database)."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            d = Decimal(str(value))
        except Exception:
            return None
        return d if d.is_finite() else None
    return None


def _r3(d: Decimal) -> Decimal:
    """``round(x, 3)`` as numeric does it: half away from zero."""
    return d.quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)


# ── the windows (a mirror of repurpose_plan in 0080) ────────────────────────


def plan_clips(manifest, clips) -> dict:
    """The clips a request names, as windows of whole scenes of a Video IR.

    ``{"ok": True, "clips": [{position, first, last, scene_ids, start_s, end_s,
    duration_s}]}`` or ``{"ok": False, "reason": <one of REASONS>, ...}``.
    The same checks, in the same order and with the same reason words, as the
    database's ``repurpose_plan``; ``samples/repurpose_cases.json`` runs against
    both. Pure; never raises.
    """
    try:
        return _plan_clips(manifest, clips)
    except Exception:  # unknown input is refused, never a guess
        logger.warning("repurpose: planning failed; refusing", exc_info=True)
        return {"ok": False, "reason": "invalid_clips"}


def _plan_clips(manifest, clips) -> dict:
    if not isinstance(clips, list) or not 1 <= len(clips) <= MAX_CLIPS:
        return {"ok": False, "reason": "invalid_clips"}
    if not isinstance(manifest, Mapping) or not isinstance(manifest.get("scenes"), list):
        return {"ok": False, "reason": "no_manifest"}
    ids: List[Optional[str]] = []
    starts: List[Optional[Decimal]] = []
    ends: List[Optional[Decimal]] = []
    for sc in manifest["scenes"]:
        sid = sc.get("id") if isinstance(sc, Mapping) else None
        if isinstance(sid, str) and _SCENE_ID.match(sid):
            ids.append(sid)
            starts.append(_num(sc.get("start_s")))
            ends.append(_num(sc.get("end_s")))
        else:
            ids.append(None)
            starts.append(None)
            ends.append(None)
    named = [i for i in ids if i is not None]
    if len(named) != len(set(named)):
        return {"ok": False, "reason": "scene_ids_not_unique"}
    audio = manifest.get("audio")
    a_dur = _num(audio.get("duration_s")) if isinstance(audio, Mapping) else None

    out: List[dict] = []
    ranges: List[Tuple[int, int]] = []
    for pos, c in enumerate(clips, start=1):
        if (not isinstance(c, Mapping) or not isinstance(c.get("first"), str)
                or not isinstance(c.get("last"), str)
                or not _SCENE_ID.match(c["first"]) or not _SCENE_ID.match(c["last"])):
            return {"ok": False, "reason": "invalid_clips"}
        f, l = c["first"], c["last"]
        if f not in ids or l not in ids:
            return {"ok": False, "reason": "scene_not_found", "position": pos}
        fo, lo = ids.index(f), ids.index(l)
        if fo > lo:
            return {"ok": False, "reason": "invalid_range", "position": pos}
        if lo - fo + 1 > MAX_CLIP_SCENES:
            return {"ok": False, "reason": "too_many_scenes", "position": pos}
        sids: List[str] = []
        for k in range(fo, lo + 1):
            s, e = starts[k], ends[k]
            if (ids[k] is None or s is None or e is None or s < 0 or e <= s
                    or (k > fo and ends[k - 1] is not None and s < ends[k - 1] - Decimal(str(EDGE_SLACK_S)))):
                return {"ok": False, "reason": "scene_timing_unknown", "position": pos}
            sids.append(ids[k])  # type: ignore[arg-type]
        w_start, w_end = _r3(starts[fo]), _r3(ends[lo])  # type: ignore[arg-type]
        w_dur = _r3(w_end - w_start)
        if w_dur < Decimal(str(MIN_CLIP_SECONDS)):
            return {"ok": False, "reason": "clip_too_short", "position": pos}
        if w_dur > Decimal(str(MAX_CLIP_SECONDS)):
            return {"ok": False, "reason": "clip_too_long", "position": pos}
        if a_dur is not None and w_end > a_dur + Decimal(str(AUDIO_SLACK_S)):
            return {"ok": False, "reason": "beyond_audio", "position": pos}
        if any(not (lo < r_first or fo > r_last) for r_first, r_last in ranges):
            return {"ok": False, "reason": "clips_overlap", "position": pos}
        ranges.append((fo, lo))
        out.append({"position": pos, "first": f, "last": l, "scene_ids": sids,
                    "start_s": float(w_start), "end_s": float(w_end), "duration_s": float(w_dur)})
    return {"ok": True, "clips": out}


# ── proposing clips (advisory) ──────────────────────────────────────────────


@dataclass(frozen=True)
class Window:
    """A run of whole scenes: its first and last scene and the real times."""

    first: str
    last: str
    scene_ids: Tuple[str, ...]
    start_s: float
    end_s: float

    @property
    def duration_s(self) -> float:
        return round(self.end_s - self.start_s, 3)


@dataclass(frozen=True)
class Proposal:
    """One proposed clip. ``score`` is None when retention was not measured for
    its edges: the ranking then rests on scene structure alone."""

    rank: int
    window: Window
    score: Optional[float]

    @property
    def measured(self) -> bool:
        return self.score is not None

    def to_dict(self) -> dict:
        w = self.window
        return {"rank": self.rank, "first": w.first, "last": w.last, "scene_ids": list(w.scene_ids),
                "start_s": w.start_s, "end_s": w.end_s, "duration_s": w.duration_s,
                "score": self.score, "measured": self.measured}


@dataclass(frozen=True)
class Proposals:
    #: "measured": a usable retention curve scored at least one window.
    #: "not_measured": no usable curve or no scored window — structure only.
    retention: str
    clips: Tuple[Proposal, ...]

    def to_dict(self) -> dict:
        return {"retention": self.retention, "clips": [c.to_dict() for c in self.clips]}


def candidate_windows(manifest) -> List[Window]:
    """Every allowed window of the manifest: runs of consecutive scenes with
    real times, 15..60 seconds, at most 12 scenes, inside the audio. Exactly
    the windows ``plan_clips`` accepts as a single clip."""
    scenes = manifest.get("scenes") if isinstance(manifest, Mapping) else None
    if not isinstance(scenes, list):
        return []
    found: List[Window] = []
    for i, sc in enumerate(scenes):
        first = sc.get("id") if isinstance(sc, Mapping) else None
        if not isinstance(first, str):
            continue
        for j in range(i, min(len(scenes), i + MAX_CLIP_SCENES)):
            last = scenes[j].get("id") if isinstance(scenes[j], Mapping) else None
            if not isinstance(last, str):
                break
            plan = plan_clips(manifest, [{"first": first, "last": last}])
            if plan.get("ok"):
                c = plan["clips"][0]
                found.append(Window(first, last, tuple(c["scene_ids"]), c["start_s"], c["end_s"]))
                continue
            if plan.get("reason") != "clip_too_short":
                break  # a longer run only gets longer, later, or is broken
    return found


def _window_scores(manifest, points, windows: Sequence[Window]) -> Dict[Tuple[str, str], Optional[float]]:
    """Per window: minus the audience's drop per minute across it, or None.
    The edges must lie on the measured curve (scene_retention never
    extrapolates), otherwise the window is unmeasured — not 0."""
    # Only scenes that carry their own id: a scene without one has no place in
    # a window, and must not lend its positional fallback id to another.
    if not isinstance(manifest, Mapping) or not isinstance(manifest.get("scenes"), list):
        return {(w.first, w.last): None for w in windows}
    scenes = [sc for sc in manifest["scenes"]
              if isinstance(sc, Mapping) and isinstance(sc.get("id"), str) and _SCENE_ID.match(sc["id"])]
    rows = scene_retention.map_scenes(scenes, points, scene_retention.video_duration(manifest, scenes))
    by_id = {r.scene_id: r for r in rows}
    out: Dict[Tuple[str, str], Optional[float]] = {}
    for w in windows:
        a, b = by_id.get(w.first), by_id.get(w.last)
        start = a.retention_start if a is not None else None
        end = b.retention_end if b is not None else None
        if start is None or end is None or w.duration_s <= 0:
            out[(w.first, w.last)] = None
            continue
        out[(w.first, w.last)] = round(-((start - end) / (w.duration_s / 60.0)), 4)
    return out


def propose(manifest, points=None, *, max_clips: int = MAX_CLIPS) -> Proposals:
    """The best non-overlapping windows of a master, best first. Advisory."""
    max_clips = max(0, min(int(max_clips), MAX_CLIPS))
    windows = candidate_windows(manifest)
    scores = _window_scores(manifest, points, windows)
    measured = any(v is not None for v in scores.values())
    segments = [
        remix_segments.SourceSegment(start=w.start_s, end=w.end_s, text=f"{w.first}:{w.last}",
                                     score=scores[(w.first, w.last)])
        for w in windows
    ]
    chosen = remix_segments.select_segments(segments, max_clips=max_clips)
    by_key = {f"{w.first}:{w.last}": w for w in windows}
    clips = tuple(
        Proposal(rank=i + 1, window=by_key[s.text], score=s.score) for i, s in enumerate(chosen)
    )
    return Proposals(retention="measured" if measured else "not_measured", clips=clips)


# ── titles and captions ─────────────────────────────────────────────────────


_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def _plain(text) -> str:
    """Text for a title or caption: no control characters (the database refuses
    them in a title) and no angle brackets (YouTube rejects them), one space
    between words."""
    text = _CONTROL.sub(" ", str(text or "")).replace("<", "").replace(">", "")
    return " ".join(text.split())


def clip_title(master_title: str, position: int) -> str:
    """The clip's own title, within YouTube's 100 characters and never empty."""
    base = _plain(master_title) or "Clip"
    tag = f" - clip {int(position)}"
    room = 100 - len(tag)
    if len(base) > room:
        base = base[: room - 1].rstrip() + "…"
    return f"{base}{tag}"


def clip_narration(manifest, scene_ids: Iterable[str]) -> str:
    wanted = set(scene_ids)
    parts = []
    for sc in (manifest or {}).get("scenes") or []:
        if isinstance(sc, Mapping) and sc.get("id") in wanted:
            text = " ".join(str(sc.get("narration") or "").split())
            if text:
                parts.append(text)
    return " ".join(parts)


def clip_captions(master_title: str, topic: str, position: int, narration: str) -> dict:
    """Per-platform captions for one clip: deterministic, from the master's own
    title and the clip's own narration (``social_captions``); nothing is
    generated and nothing is posted. The YouTube title carries the Shorts tag
    (``shorts.short_title``); the description is the funnel ``shorts`` writes."""
    title = clip_title(master_title, position)
    narration = _plain(narration)
    hook = social_captions.trim(narration, 200) if narration else ""
    meta = social_captions.SourceMeta(title=title, description=narration, topic=_plain(topic))
    return {
        "youtube": {"title": shorts.short_title(title), "description": shorts.short_description(title, None, hook),
                    "tags": ["Shorts"]},
        "instagram": social_captions.instagram_caption(meta),
        "tiktok": social_captions.tiktok_caption(meta),
    }


# ── Supabase (service key) ──────────────────────────────────────────────────


class RepurposeStore:
    """The worker's functions over Supabase REST (service key only)."""

    def __init__(self, url: str, service_key: str, *, session=None, timeout: float = 30.0):
        self.url = (url or "").rstrip("/")
        self._key = service_key or ""
        self._http = session
        self._timeout = timeout

    def http(self):
        if self._http is None:
            import requests  # noqa: PLC0415

            self._http = requests.Session()
        return self._http

    def _rpc(self, name: str, payload: dict):
        r = self.http().post(f"{self.url}/rest/v1/rpc/{name}", json=payload,
                             headers={"apikey": self._key, "Authorization": f"Bearer {self._key}",
                                      "Content-Type": "application/json"}, timeout=self._timeout)
        if r.status_code == 404:
            return None  # 0080 not applied: nothing to do
        if r.status_code >= 300:
            raise RuntimeError(f"{name}: HTTP {r.status_code}")
        return r.json()

    def claim(self, worker_id: str) -> Optional[dict]:
        out = self._rpc("claim_repurpose_request", {"p_worker": worker_id})
        return out if isinstance(out, dict) else None

    def heartbeat(self, request_id: str, worker_id: str) -> None:
        self._rpc("heartbeat_repurpose", {"p_id": request_id, "p_worker": worker_id})

    def record(self, request_id: str, worker_id: str, position: int, *, ok: bool, info: Mapping) -> None:
        self._rpc("record_repurpose_clip", {"p_id": request_id, "p_worker": worker_id, "p_position": int(position),
                                            "p_ok": bool(ok), "p_info": dict(info)})

    def finish(self, request_id: str, worker_id: str):
        return self._rpc("finish_repurpose_request", {"p_id": request_id, "p_worker": worker_id})

    def expire(self):
        return self._rpc("expire_repurpose_requests", {})


# ── one request ─────────────────────────────────────────────────────────────


class ClipStop(Exception):
    """End a clip (or the whole request) as failed with a reason word and a
    short detail of our own — never text from a provider or a path."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(reason)
        self.reason = reason
        self.detail = detail[:500]


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def clip_destination(output_dir: Path, local_path: str) -> Path:
    """Where the database says this clip lives, only when it is a clip path of
    the exact shape the database builds and it stays inside ``output_dir``."""
    if not isinstance(local_path, str) or not _CLIP_PATH.match(local_path):
        raise ClipStop("bad_clip_path")
    root = Path(output_dir).resolve()
    dest = (root.parent / local_path).resolve()
    if root not in dest.parents:
        raise ClipStop("bad_clip_path")
    return dest


def check_master(req: Mapping, *, output_dir: Path, probe_fn, load_ir=None) -> Tuple[Path, "social_publish.VideoInfo", dict]:
    """The master this request was priced on, found and still the same.

    Returns (file, probe, Video IR). Raises ClipStop: master_not_available,
    probe_failed, master_too_small (a review copy is never a source),
    master_record_missing, master_changed."""
    master = req.get("master") or {}
    path = social_publish.resolve_master({"local_path": master.get("local_path")}, output_dir)
    if path is None:
        raise ClipStop("master_not_available",
                       "the full-quality render is not on this worker; nothing was charged")
    info = probe_fn(path)
    if not info.width or not info.height or not info.duration or info.duration <= 0:
        raise ClipStop("probe_failed", "could not read the master's frame size and length")
    if min(info.width, info.height) < MIN_SOURCE_SIDE:
        raise ClipStop("master_too_small", "the file on this worker is a review copy, not the master")
    ir_path = path.parent / "project.json"
    try:
        ir = (load_ir or (lambda p: json.loads(Path(p).read_text("utf-8"))))(ir_path)
    except Exception:
        raise ClipStop("master_record_missing", "the run's Video IR is not beside the master") from None
    if not isinstance(ir, Mapping) or (ir.get("slug") not in (None, req.get("slug"))):
        raise ClipStop("master_changed", "the master on this worker is not the one that was priced")
    audio = ir.get("audio")
    a_dur = _num(audio.get("duration_s")) if isinstance(audio, Mapping) else None
    if a_dur is not None and abs(float(a_dur) - float(info.duration)) > MASTER_LENGTH_TOLERANCE_S:
        raise ClipStop("master_changed", "the master's length is not the one that was priced")
    return path, info, dict(ir)


def check_window(clip: Mapping, ir: Mapping, info) -> None:
    """The clip's frozen window must still be exactly what the file's own
    Video IR says, and inside the file. ``master_changed`` otherwise."""
    plan = plan_clips(ir, [{"first": clip.get("first"), "last": clip.get("last")}])
    if not plan.get("ok"):
        raise ClipStop("master_changed", "the scenes that were priced are not in the master any more")
    w = plan["clips"][0]
    if (list(w["scene_ids"]) != list(clip.get("scene_ids") or [])
            or abs(w["start_s"] - float(clip.get("start_s"))) > TERMS_TOLERANCE_S
            or abs(w["end_s"] - float(clip.get("end_s"))) > TERMS_TOLERANCE_S):
        raise ClipStop("master_changed", "the scenes that were priced have moved in the master")
    if w["end_s"] > float(info.duration) + 0.25:
        raise ClipStop("master_changed", "the window runs past the end of the master")


def make_clip(clip: Mapping, *, req: Mapping, master: Path, info, ir: Mapping, output_dir: Path,
              heartbeat: Callable[[], None], probe_fn, ffmpeg_exe: Callable[[], Optional[str]],
              runner=None) -> dict:
    """Cut one clip and describe it. Raises ClipStop with a reason word."""
    check_window(clip, ir, info)
    dest = clip_destination(output_dir, str(clip.get("local_path") or ""))
    exe = ffmpeg_exe()
    if not exe:
        raise ClipStop("ffmpeg_missing", "this worker has no ffmpeg")
    dest.parent.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(dest.parent).free < MIN_FREE_BYTES:
        raise ClipStop("disk_full", "the worker is out of disk space")
    part = dest.with_name(dest.stem + ".part.mp4")
    part.unlink(missing_ok=True)
    run = runner or shorts.run_ffmpeg
    try:
        argv = shorts.window_command(exe, master, part, float(clip["start_s"]), float(clip["end_s"]), info)
        try:
            code = run(argv, heartbeat)
        except TimeoutError:
            raise ClipStop("timeout", "the cut took too long") from None
        if code != 0:
            raise ClipStop("cut_failed", f"ffmpeg exited with {code}")
        if not part.is_file() or part.stat().st_size <= 0:
            raise ClipStop("cut_failed", "ffmpeg wrote no output")
        out = probe_fn(part)
        want = float(clip["end_s"]) - float(clip["start_s"])
        if (out.width, out.height) != (shorts.SHORT_WIDTH, shorts.SHORT_HEIGHT) or not out.duration \
                or abs(out.duration - want) > CLIP_LENGTH_TOLERANCE_S:
            raise ClipStop("clip_invalid", "the clip that was written is not the window that was priced")
        os.chmod(part, 0o644)
        os.replace(part, dest)
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    narration = clip_narration(ir, clip.get("scene_ids") or [])
    master_row = req.get("master") or {}
    title = clip_title(str(master_row.get("title") or ""), int(clip["position"]))
    return {
        "sha256": _sha256(dest), "bytes": dest.stat().st_size, "width": int(out.width), "height": int(out.height),
        "title": title,
        "captions": clip_captions(str(master_row.get("title") or ""), str(master_row.get("topic") or ""),
                                  int(clip["position"]), narration),
    }


def process_request(req: Mapping, *, store, output_dir: Path, worker_id: str, probe_fn=social_publish.probe,
                    ffmpeg_exe: Callable[[], Optional[str]] = social_publish._ffmpeg, runner=None,
                    load_ir=None) -> str:
    """Carry one claimed request to its end. Never raises. Returns what the
    database settled it as ("succeeded" | "partial" | "failed") or "unsettled"
    when the settle itself could not be reported (the sweep settles it)."""
    rid = str(req.get("id") or "")
    clips = [c for c in (req.get("clips") or []) if isinstance(c, Mapping)]

    def fail(clip, stop: ClipStop):
        try:
            store.record(rid, worker_id, int(clip["position"]), ok=False,
                         info={"error_code": stop.reason, "error": stop.detail})
        except Exception as e:
            logger.warning("repurpose %s: could not record clip %s failed (%s)", rid, clip.get("position"),
                           type(e).__name__)

    def beat():
        try:
            store.heartbeat(rid, worker_id)
        except Exception:
            pass

    try:
        master, info, ir = check_master(req, output_dir=output_dir, probe_fn=probe_fn, load_ir=load_ir)
        stop_all: Optional[ClipStop] = None
    except ClipStop as stop:
        master = info = ir = None  # type: ignore[assignment]
        stop_all = stop
    except Exception as e:
        master = info = ir = None  # type: ignore[assignment]
        stop_all = ClipStop("worker_error", f"worker error ({type(e).__name__})")

    for clip in clips:
        if stop_all is not None:
            fail(clip, stop_all)
            continue
        beat()
        try:
            made = make_clip(clip, req=req, master=master, info=info, ir=ir, output_dir=output_dir,
                             heartbeat=beat, probe_fn=probe_fn, ffmpeg_exe=ffmpeg_exe, runner=runner)
        except ClipStop as stop:
            fail(clip, stop)
            logger.info("repurpose %s: clip %s failed (%s)", rid, clip.get("position"), stop.reason)
            continue
        except Exception as e:
            fail(clip, ClipStop("worker_error", f"worker error ({type(e).__name__})"))
            logger.warning("repurpose %s: clip %s failed (%s)", rid, clip.get("position"), type(e).__name__)
            continue
        try:
            store.record(rid, worker_id, int(clip["position"]), ok=True, info=made)
        except Exception as e:
            # The clip file exists but the database never heard: it is not
            # charged. The settle fails it as not_rendered.
            logger.warning("repurpose %s: could not record clip %s (%s)", rid, clip.get("position"),
                           type(e).__name__)
    try:
        settled = store.finish(rid, worker_id)
    except Exception as e:
        logger.warning("repurpose %s: could not settle (%s); the sweep will", rid, type(e).__name__)
        return "unsettled"
    status = (settled or {}).get("status") if isinstance(settled, Mapping) else None
    logger.info("repurpose %s: %s", rid, status or "settled")
    return str(status or "unsettled")


class RepurposeService:
    """What the queue worker calls between render jobs."""

    def __init__(self, url: str, service_key: str, *, output_dir: Path, worker_id: str,
                 store: Optional[RepurposeStore] = None, probe_fn=social_publish.probe,
                 clock: Callable[[], float] = time.monotonic, **kw):
        self.store = store or RepurposeStore(url, service_key)
        self.output_dir = Path(output_dir)
        self.worker_id = worker_id
        self.probe_fn = probe_fn
        self.clock = clock
        self.kw = kw
        self._last_sweep: Optional[float] = None
        self._warned = False

    def sweep(self) -> None:
        now = self.clock()
        if self._last_sweep is not None and now - self._last_sweep < SWEEP_S:
            return
        self._last_sweep = now
        self.store.expire()

    def run_once(self) -> bool:
        """The sweep, then at most one request. True when one was handled."""
        try:
            self.sweep()
            req = self.store.claim(self.worker_id)
        except Exception as e:
            if not self._warned:
                logger.warning("repurpose queue unavailable (%s)", str(e) if isinstance(e, RuntimeError)
                               else type(e).__name__)
                self._warned = True
            return False
        if not req:
            return False
        process_request(req, store=self.store, output_dir=self.output_dir, worker_id=self.worker_id,
                        probe_fn=self.probe_fn, **self.kw)
        return True


__all__ = [
    "AUDIO_SLACK_S", "ClipStop", "MAX_CLIPS", "MAX_CLIPS_PER_MASTER", "MAX_CLIP_SCENES", "MAX_CLIP_SECONDS", "MIN_CLIP_SECONDS",
    "MIN_SOURCE_SIDE", "Proposal", "Proposals", "RepurposeService", "RepurposeStore", "Window",
    "candidate_windows", "check_master", "check_window", "clip_captions", "clip_title", "plan_clips",
    "process_request", "propose",
]
