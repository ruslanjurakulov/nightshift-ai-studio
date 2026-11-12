"""Editor exports — migration 0054: render a saved editor project revision
with the existing ffmpeg engine and put the video in the organization's
library.

    claim_editor_export        the database hands the media worker one export
    editor_export_assets       which files it may read: live files of the
                               EXPORT's organization that its document names
    timeline_render            validate (modules/timeline.py), lay out the
                               RenderSpec, render with render_backend — the
                               one renderer; nothing here builds a filter graph
    store_generated            the video becomes a library file, source 'render'
    finish_editor_export       done with the file, or failed with a reason word

Free, and only ours
-------------------
An export costs no credits and calls no provider: it is ffmpeg on this worker.
The limits that stand in for a price (length, one at a time, a daily count)
are the database's (0054); this module re-checks the length before it spends
any CPU.

A wall-clock limit, too
-----------------------
A render that hangs (a source that decodes forever, a filter that never
finishes) used to hold the export slot with a live heartbeat, so the
database never handed the export out again and nobody was told. Every
render now gets ``render_timeout_s(length)``: three times the video's length
plus two minutes, never more than ``RENDER_TIMEOUT_MAX_S``. Past it the
ffmpeg running is killed (render_backend), the work folder is removed, and
the export ends as failed with ``timed_out``.

Nothing here publishes
----------------------
The result is a file in the library and nothing else. Publishing a video
stays behind the publish gate and publish_requests, which this never touches.

Files by id, never by path
--------------------------
The document names asset ids. The database answers which of them this
export's organization may use; the path of each is built from its id alone
(``media_library.asset_file``) — never from the document, a row value or a
name — and a symlink on the way is refused. A HEIC photo is read from its
JPEG display copy (ffmpeg here cannot decode HEIF). Whether a video carries
sound is asked of ffprobe with the demuxer forced to the recorded type and
only the ``file`` protocol allowed, the way an upload is checked.

Text on the picture is written to an ASS file by ``ass_captions`` with its
override characters escaped; it never becomes part of an ffmpeg argument.

Another frame, from a closed list (migration 0129)
--------------------------------------------------
An export row may carry a frame override (``frame_preset`` / ``frame_width`` /
``frame_height``): the same saved revision rendered in another size, so one
edit gives a 16:9, a 9:16, a 1:1 and a 4:5 file without a copy of the project.
The override is a PARAMETER, not a render path: ``width`` and ``height`` of the
document are replaced and the document then goes through exactly what any
document goes through (``timeline.load``: every frame, budget and memory rule
against the NEW frame; the same layout; the same ffmpeg commands under the same
``ffmpeg_limits``). Nothing else moves: the frame rate, the clips, the texts
and every clip's own ``fit``. A source whose shape is not the new frame's is
therefore fitted the way that clip already says, ``contain`` unless the person
chose ``cover`` or ``blur``: bars rather than a crop, because cutting the sides
off a picture is an editing decision and this is not an edit.

The database's function is the first check (the closed list of 0129); this
module is the second, and it does not take the row's word for it: the id must
be one of ``schemas/export_presets.json`` and the row's width and height must
be exactly that entry's, or the export ends as ``invalid_frame`` before any
file is read. A row with only some of the three values is refused the same
way, never rendered in the project's frame. And it is off unless
``NIGHTSHIFT_MULTI_RATIO_EXPORT`` is on in THIS process (the Command Center
reads the same name): a frame row that arrives while it is off ends as
``frame_off``. A row with no override takes none of this: it is rendered
exactly as before.

1440p and 4K, sold by the minute (migration 0132)
-------------------------------------------------
Four frames of the closed list are above 1080p (``modules/hires_export.py``
has the tiers). Their export rows carry a quote and a credit hold that the
DATABASE settles when the row ends (0132 ``editor_export_settle``: capture on
done, release on failed); nothing here moves a credit. What this module adds:
a hi-res frame is rendered only while ``NIGHTSHIFT_HIRES_EXPORT`` is on in
THIS process (else ``hires_off``, before any file is read), only from a row
that carries its quote (else ``invalid_frame``), only up to its tier's length
(else ``too_long``) and frame rate (4K: 30 fps, else ``hires_fps``; never
rendered at a lower rate in its place), and with its tier's wall-clock budget instead of the
free exports' ``render_timeout_s``. A claimed row that the database already
ended (its hold was gone when it was claimed: ``credits_released``) is not
rendered at all.

Above 1080p is never free: a row without a paid frame whose picture is above
1920x1080 pixels (a project whose OWN frame is bigger, exported through the
plain request) is refused (``hires_needs_paid_export``); the database refuses
it first (0132). A paid row is not rendered when the length rendered here
starts more minutes than the database priced from the row's ``duration_s``
(``hires_length_mismatch``, one frame of slack): the price is for the minutes
the person confirmed, never for more. The database prices a speed curve at its
rendered length (migration 0136 editor_doc_rendered_length, this module's
timeline.duration_s to the millisecond), so a curve is no reason to refuse;
this check is the backstop if the two ever disagree.

Up to 1080p, sold too (migration 0136): once the owner sets the 1080p price a
row up to 1080p carries its quote (with a frame of the list, or none for the
project's own frame). Such a row gets the same minutes check as a paid one
above; its budget and caps stay the free exports'. While the price is NULL the rows carry no quote and nothing
here changes.

What is logged: export / asset ids, reason words, a frame id of the closed list
and exception types — never a path, a document or a message from ffmpeg.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional

from modules import hires_export
from modules import media_library as ml
from modules import render_backend
from modules import timeline as tl
from modules import timeline_render

logger = logging.getLogger(__name__)

#: The database's limit (0054 request_editor_export), checked again here.
EXPORT_MAX_S = 1800.0
#: Where renders work: on the media volume (same filesystem as the library;
#: the worker's /tmp is a small tmpfs, and a render's intermediates are
#: hundreds of MB a minute). A dot-folder: the web container serves only
#: id-derived paths, never this.
WORK_DIRNAME = ".editor-exports"
HEARTBEAT_S = 60.0
AUDIO_PROBE_TIMEOUT_S = 60
#: The wall-clock budget of one render: RENDER_TIMEOUT_PER_S seconds per
#: second of video plus RENDER_TIMEOUT_BASE_S (ffmpeg start-up, probing, the
#: final mux of a very short video), capped. Three times the length is
#: generous for a render that is working and still ends a hung one in a
#: bounded time; the cap (90 minutes) is what a 30-minute export
#: (EXPORT_MAX_S) gets instead of the formula's 5520 s. Not measured on the
#: production worker yet: if a long, legitimate export is cut off, the
#: factor is the number to raise.
#: (The timeline validator checks a document's estimated render time against this same
#: budget, so the numbers live in modules/timeline.py.)
RENDER_TIMEOUT_PER_S = tl.RENDER_TIMEOUT_PER_S
RENDER_TIMEOUT_BASE_S = tl.RENDER_TIMEOUT_BASE_S
RENDER_TIMEOUT_MAX_S = tl.RENDER_TIMEOUT_MAX_S

#: Reason words a failed export can carry (the Command Center has a sentence
#: for each; lib/editor.ts EXPORT_REASONS).
REASONS = ("invalid_timeline", "asset_unavailable", "too_long", "render_failed", "store_failed",
           "timed_out", "invalid_frame", "frame_off", "hires_off", "credits_released", "hires_fps",
           "hires_needs_paid_export", "hires_speed_curve", "hires_length_mismatch")

#: The switch of "one edit, several frame sizes" (migration 0129), the same word
#: the Command Center reads (lib/multiRatioExport/flag.ts). Default OFF.
FRAME_FLAG = "NIGHTSHIFT_MULTI_RATIO_EXPORT"
#: The three columns of an export row that carry a frame override, in the
#: database's order. All None = the project's own frame.
FRAME_COLUMNS = ("frame_preset", "frame_width", "frame_height")


def multi_ratio_enabled(env: Mapping[str, str]) -> bool:
    """Is a frame override rendered by this process? ``on`` / ``1`` / ``true`` /
    ``yes``; anything else, or nothing, is off."""
    return str(env.get(FRAME_FLAG, "") or "").strip().lower() in ("on", "1", "true", "yes")


def render_timeout_s(length_s: float) -> float:
    """How long one export's render may take, in wall-clock seconds."""
    try:
        length = max(0.0, float(length_s))
    except (TypeError, ValueError):
        length = 0.0
    if length != length or length == float("inf"):  # NaN / inf: the cap, never no limit
        return RENDER_TIMEOUT_MAX_S
    return min(RENDER_TIMEOUT_MAX_S, RENDER_TIMEOUT_PER_S * length + RENDER_TIMEOUT_BASE_S)


class ExportFailed(Exception):
    """End an export as failed with a reason word."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason if reason in REASONS else "render_failed"


# ── the frame an export was asked in (migration 0129) ────────────────────────


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def frame_override(export: Mapping, *, enabled: bool, presets: Optional[Mapping[str, Any]] = None,
                   hires_enabled: bool = False):
    """The frame this export must be rendered in instead of the project's own:
    an entry of the closed list (``export_presets.Preset``), or None when the
    row carries no override at all.

    Raises ExportFailed: ``frame_off`` when the row carries one and this
    process's switch is off; ``invalid_frame`` when the three values are not
    EXACTLY one entry of ``schemas/export_presets.json`` (an id outside the
    list, a size that is not that id's, a number that is not an integer, or
    only some of the three). The row is the database's, and the database
    checked it (0129); this is asked again because a frame size that reaches
    ffmpeg must come from our own list whatever a row says.

    A frame above 1080p (0132) also needs ``hires_enabled`` (else
    ``hires_off``) and a row that carries its quote (else ``invalid_frame``:
    the database never writes one without it, so a row without one is not
    the database's)."""
    preset_id, width, height = (export.get(k) for k in FRAME_COLUMNS)
    if preset_id is None and width is None and height is None:
        return None
    if not enabled:
        raise ExportFailed("frame_off")
    # Here, not at the top: export_presets imports this module for EXPORT_MAX_S.
    from modules import export_presets

    try:
        preset = export_presets.get(preset_id, presets)
    except export_presets.UnknownPreset:
        raise ExportFailed("invalid_frame") from None
    except export_presets.PresetDataError as e:
        # Our own list cannot be read: nothing may be rendered from a guess.
        logger.warning("editor export: the frame list is unreadable (%s)", type(e).__name__)
        raise ExportFailed("invalid_frame") from None
    if not (_is_int(width) and _is_int(height)) or (width, height) != (preset.width, preset.height):
        raise ExportFailed("invalid_frame")
    if hires_export.tier(preset.width, preset.height) is not None:
        if not hires_enabled:
            raise ExportFailed("hires_off")
        if export.get("quoted_credits") is None:
            raise ExportFailed("invalid_frame")
    return preset


def framed_doc(doc: Any, frame) -> Any:
    """What ``timeline.load`` is given: the export's document, with the frame
    override's width and height when there is one. Without an override it is
    the document itself, untouched. With one, only the two top-level numbers
    change, on a copy (the claimed row is not edited); the validator then
    judges the whole document against the NEW frame."""
    source = doc if isinstance(doc, (dict, str, bytes)) else {}
    if frame is None:
        return source
    if not isinstance(source, dict):
        # The database hands a document over as an object. Text here is not a
        # row of ours, and re-parsing it would be a second parser to keep safe.
        raise ExportFailed("invalid_timeline")
    out = dict(source)
    out["width"], out["height"] = frame.width, frame.height
    return out


# ── which files, and what is in them ─────────────────────────────────────────


def audio_probe_command(exe: str, path: Path, mime: str) -> List[str]:
    """ffprobe for the sound streams only, forced to the recorded type."""
    return [exe, "-v", "error", "-protocol_whitelist", "file", "-f", ml.DEMUXER[mime],
            "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "json", str(path)]


def probe_has_audio(exe: str, path: Path, mime: str) -> bool:
    """Does this video carry a sound track? Raises ExportFailed when ffprobe
    cannot say — the render would not get further, and guessing "silent"
    would quietly drop the clip's sound."""
    if mime not in ml.DEMUXER:
        raise ExportFailed("asset_unavailable")
    try:
        proc = subprocess.run(audio_probe_command(exe, path, mime), capture_output=True,
                              timeout=AUDIO_PROBE_TIMEOUT_S)
        data = json.loads(proc.stdout.decode("utf-8", "replace") or "{}") if proc.returncode == 0 else None
    except (subprocess.TimeoutExpired, ValueError, OSError):
        data = None
    if not isinstance(data, dict):
        raise ExportFailed("asset_unavailable")
    return any(isinstance(s, dict) and s.get("codec_type") == "audio" for s in data.get("streams") or [])


def _plain_file(path: Path) -> bool:
    return all(not p.is_symlink() for p in (path.parent.parent, path.parent, path)) and path.is_file()


def build_resolver(rows: List[Mapping], media_root: Path, *,
                   has_audio: Callable[[Path, str], bool]) -> tl.AssetResolver:
    """The timeline's resolver over the database's answer for one export.
    An id the database did not return resolves to None (refused, never
    skipped). Paths come from the id alone."""
    found: Dict[str, tl.ResolvedAsset] = {}
    for row in rows:
        try:
            aid = ml.canonical_id(row.get("id"))
        except ValueError:
            continue
        kind, mime = row.get("kind"), str(row.get("mime") or "")
        variants = row.get("variants") or []
        if kind not in (tl.ASSET_VIDEO, tl.ASSET_IMAGE, tl.ASSET_AUDIO):
            continue
        variant = "display" if mime in ml.HEIF_MIMES else "original"
        if variant == "display" and "display" not in variants:
            continue
        path = ml.asset_file(media_root, aid, variant)
        if not _plain_file(path):
            continue
        dur = row.get("duration_s")
        try:
            duration = float(dur) if dur is not None else None
        except (TypeError, ValueError):
            duration = None
        sound = has_audio(path, mime) if kind == tl.ASSET_VIDEO else None
        found[aid] = tl.ResolvedAsset(aid, kind, str(path), duration, sound)
    return lambda asset_id: found.get(str(asset_id).lower())


# ── one export ───────────────────────────────────────────────────────────────


class _Heartbeat:
    """Tell the database the export is still being worked on while ffmpeg runs."""

    def __init__(self, beat: Callable[[], object], every_s: float = HEARTBEAT_S):
        self._beat, self._every = beat, every_s
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="editor-export-heartbeat", daemon=True)

    def _run(self) -> None:
        while not self._stop.wait(self._every):
            try:
                self._beat()
            except Exception as e:  # a missed beat is not a failed render
                logger.warning("export heartbeat failed (%s)", type(e).__name__)

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._thread.join(timeout=5)
        return False


def run_export(export: Mapping, *, store: ml.MediaStore, media_root: Path, worker_id: str,
               tools: ml.Tools, render: Callable[..., str] = timeline_render.render,
               store_file: Callable[..., dict] = ml.store_generated,
               has_audio: Optional[Callable[[Path, str], bool]] = None,
               new_id: Callable[[], str] = lambda: str(uuid.uuid4()),
               heartbeat_s: float = HEARTBEAT_S, frames_enabled: bool = False, hires_enabled: bool = False) -> str:
    """Render one claimed export and finish it. Returns the status the
    database recorded ('done' / 'failed'). Never raises for a bad document,
    a missing file or an ffmpeg failure — those end the export with a reason
    word; a database outage propagates (the export is handed out again once
    its heartbeat goes stale).

    ``frames_enabled``: whether a frame override on the row (0129) is
    rendered. Off by default, so a caller that never heard of it refuses a
    frame row instead of rendering it in the project's frame. ``hires_enabled``:
    the same for a frame above 1080p (0132), off by default.

    A row whose status is not 'rendering' is not rendered and not finished:
    the database ended it while handing it over (0132: its hold was no longer
    open), so there is nothing to render and nobody to bill."""
    eid = ml.canonical_id(export.get("id"))
    if export.get("status", "rendering") != "rendering":
        logger.info("editor export %s: handed over already ended (%s)", eid, export.get("reason") or export.get("status"))
        return str(export.get("status"))
    org = ml.canonical_id(export.get("org_id"))
    project = ml.canonical_id(export.get("project_id"))
    doc = export.get("doc")
    work = Path(media_root) / WORK_DIRNAME / eid
    probe = has_audio or (lambda path, mime: probe_has_audio(tools.ffprobe, path, mime))
    asset_id: Optional[str] = None
    reason: Optional[str] = None
    try:
        # The heartbeat starts with the work, not after the checks: a claimed export is
        # "rendering" from the first line, and anything slow or odd before the render
        # (a big document, a probe) must not let the lease run out under a live worker.
        with _Heartbeat(lambda: store.export_heartbeat(eid, worker_id), heartbeat_s):
            try:
                dur = float(export.get("duration_s") or 0)
            except (TypeError, ValueError):
                dur = 0.0
            if dur > EXPORT_MAX_S:
                raise ExportFailed("too_long")
            # Before anything is read or rendered: a frame this worker may not use
            # (switch off, or not exactly an entry of the closed list) ends the export here.
            frame = frame_override(export, enabled=frames_enabled, hires_enabled=hires_enabled)
            if frame is not None:
                logger.info("editor export %s: frame %s", eid, frame.id)
            # Only a paid frame row (0132) gets a tier's budget and cap; a project whose own frame is big keeps the free ones.
            paid = frame is not None and hires_export.tier(frame.width, frame.height) is not None
            # Sold at all (0136: exports up to 1080p too, once their price is set): the row carries the database's quote. What is
            # captured is that quote (the database's settling trigger); nothing here computes or sends an amount.
            priced = export.get("quoted_credits") is not None
            try:
                norm = tl.load(framed_doc(doc, frame))
                length = tl.duration_s(norm)
                if length > EXPORT_MAX_S:
                    raise ExportFailed("too_long")
                if paid and hires_export.length_problem(frame.width, frame.height, length):
                    raise ExportFailed("too_long")
                if paid and hires_export.fps_problem(frame.width, frame.height, norm["fps"]):
                    raise ExportFailed("hires_fps")
                # Above 1080p is paid (0132): a row without a paid frame is never rendered bigger than 1080p (defence in depth: the
                # database refuses such a request first). norm carries the frame the render will use.
                if not paid and hires_export.above_free(norm["width"], norm["height"]):
                    raise ExportFailed("hires_needs_paid_export")
                # The price is the database's minutes of the row's duration_s; a render that lasts longer is never given for that price.
                if priced and hires_export.minutes_exceed(length, export.get("duration_s"), norm["fps"]):
                    raise ExportFailed("hires_length_mismatch")
                # The library holds the export to the same decode budget as an upload
                # when it stores it (store_generated). Check it here, before the
                # render, not after it (BR-L-017). The timeline's frame cap keeps
                # every export inside it (4K60 for EXPORT_MAX_S is 9e11 px); this
                # stays as the guard should either limit move.
                if ml.decode_work(norm["width"], norm["height"], norm["fps"], length) > ml.DECODE_BUDGET_PX:
                    raise ExportFailed("too_long")
            except tl.TimelineError:
                raise ExportFailed("invalid_timeline") from None
            except ExportFailed:
                raise
            except Exception as e:
                # Not a reason the validator knew (an OverflowError from arithmetic on a
                # value in the database, a limit of the JSON parser): the export fails
                # now, with a word, instead of staying "rendering" until the lease runs out.
                logger.warning("editor export %s: document could not be read (%s)", eid, type(e).__name__)
                raise ExportFailed("invalid_timeline") from None
            rows = store.export_assets(eid)
            resolver = build_resolver(rows, Path(media_root), has_audio=probe)
            if any(resolver(aid) is None for aid in tl.asset_ids(norm)):
                # Deleted since the export was asked for, or never this org's.
                raise ExportFailed("asset_unavailable")
            shutil.rmtree(work, ignore_errors=True)
            work.mkdir(parents=True, mode=0o700)
            out = work / "export.mp4"
            try:
                timeline_render.to_render_spec(norm, resolver, str(out))
            except tl.TimelineError:
                # A clip past the end of its file, a still on an audio track…
                raise ExportFailed("invalid_timeline") from None
            except Exception as e:
                logger.warning("editor export %s: layout failed (%s)", eid, type(e).__name__)
                raise ExportFailed("invalid_timeline") from None
            try:
                # One segment at a time: this runs beside upload checking in the
                # media worker's memory budget, not in the render worker's.
                budget = (hires_export.render_timeout_s(frame.width, frame.height, length) if paid
                          else render_timeout_s(length))
                render(norm, resolver, str(out), ffmpeg=tools.ffmpeg, workdir=str(work), jobs=1,
                       timeout_s=budget)
            except render_backend.RenderTimeout:
                logger.warning("editor export %s: render ran past its time limit", eid)
                raise ExportFailed("timed_out") from None
            except Exception as e:
                logger.warning("editor export %s: render failed (%s)", eid, type(e).__name__)
                raise ExportFailed("render_failed") from None
            if not out.is_file() or out.stat().st_size <= 0:
                raise ExportFailed("render_failed")
            try:
                stored = store_file(out, asset_id=new_id(), org_id=org, store=store, media_root=Path(media_root),
                                    tools=tools, expect_kind="video", source="render", project_id=project,
                                    original_name="export.mp4",
                                    provenance={"tool": "editor", "editor_project": project,
                                                "editor_export": eid, "rev": export.get("rev"),
                                                **({"frame": frame.id} if frame is not None else {})})
            except (ml.IngestReject, ml.StoreUnavailable) as e:
                logger.warning("editor export %s: storing failed (%s)", eid, type(e).__name__)
                raise ExportFailed("store_failed") from None
            asset_id = str(stored.get("id"))
    except ExportFailed as e:
        reason = e.reason
    finally:
        shutil.rmtree(work, ignore_errors=True)
    status = store.finish_export(eid, worker_id, asset_id, reason)
    logger.info("editor export %s: %s%s", eid, status, f" ({reason})" if reason else "")
    return str(status or ("done" if asset_id else "failed"))


class ExportService:
    """What tools/media_worker.py runs on its export thread: at most one
    export at a time, beside (never instead of) upload checking."""

    def __init__(self, store: ml.MediaStore, *, media_root: Path, worker_id: str, tools: ml.Tools,
                 frames_enabled: Optional[bool] = None, hires_enabled: Optional[bool] = None):
        self.store = store
        self.media_root = Path(media_root)
        self.worker_id = worker_id
        self.tools = tools
        #: NIGHTSHIFT_MULTI_RATIO_EXPORT in this process (default off): an export
        #: that carries a frame override (0129) is refused while it is off.
        self.frames_enabled = multi_ratio_enabled(os.environ) if frames_enabled is None else bool(frames_enabled)
        #: NIGHTSHIFT_HIRES_EXPORT in this process (default off): a 1440p / 4K frame row (0132) is refused while it is off.
        self.hires_enabled = hires_export.enabled(os.environ) if hires_enabled is None else bool(hires_enabled)
        self._warned = False

    def run_once(self) -> bool:
        try:
            export = self.store.claim_export(self.worker_id)
        except Exception as e:
            if not self._warned:
                logger.warning("editor export queue unavailable (%s)", type(e).__name__)
                self._warned = True
            return False
        self._warned = False
        if not export:
            return False
        run_export(export, store=self.store, media_root=self.media_root, worker_id=self.worker_id,
                   tools=self.tools, frames_enabled=self.frames_enabled, hires_enabled=self.hires_enabled)
        return True


def serve(service: ExportService, stop: threading.Event, poll_s: float) -> None:
    """The export thread's loop. An unexpected error is logged by type and the
    loop goes on: the export is handed out again when its heartbeat goes stale."""
    while not stop.is_set():
        try:
            handled = service.run_once()
        except Exception as e:
            logger.warning("editor export failed unexpectedly (%s)", type(e).__name__)
            handled = False
        if not handled:
            stop.wait(poll_s)


__all__ = ["EXPORT_MAX_S", "ExportFailed", "ExportService", "FRAME_COLUMNS", "FRAME_FLAG", "REASONS",
           "audio_probe_command", "build_resolver", "frame_override", "framed_doc", "multi_ratio_enabled",
           "probe_has_audio", "render_timeout_s", "run_export", "serve"]
