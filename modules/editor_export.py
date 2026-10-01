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

What is logged: export / asset ids, reason words and exception types — never
a path, a document or a message from ffmpeg.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Callable, Dict, List, Mapping, Optional

from modules import media_library as ml
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

#: Reason words a failed export can carry (the Command Center has a sentence
#: for each; lib/editor.ts EXPORT_REASONS).
REASONS = ("invalid_timeline", "asset_unavailable", "too_long", "render_failed", "store_failed")


class ExportFailed(Exception):
    """End an export as failed with a reason word."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason if reason in REASONS else "render_failed"


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
               heartbeat_s: float = HEARTBEAT_S) -> str:
    """Render one claimed export and finish it. Returns the status the
    database recorded ('done' / 'failed'). Never raises for a bad document,
    a missing file or an ffmpeg failure — those end the export with a reason
    word; a database outage propagates (the export is handed out again once
    its heartbeat goes stale)."""
    eid = ml.canonical_id(export.get("id"))
    org = ml.canonical_id(export.get("org_id"))
    project = ml.canonical_id(export.get("project_id"))
    doc = export.get("doc")
    work = Path(media_root) / WORK_DIRNAME / eid
    probe = has_audio or (lambda path, mime: probe_has_audio(tools.ffprobe, path, mime))
    asset_id: Optional[str] = None
    reason: Optional[str] = None
    try:
        try:
            dur = float(export.get("duration_s") or 0)
        except (TypeError, ValueError):
            dur = 0.0
        if dur > EXPORT_MAX_S:
            raise ExportFailed("too_long")
        try:
            norm = tl.load(doc if isinstance(doc, (dict, str, bytes)) else {})
        except tl.TimelineError:
            raise ExportFailed("invalid_timeline") from None
        if tl.duration_s(norm) > EXPORT_MAX_S:
            raise ExportFailed("too_long")
        rows = store.export_assets(eid)
        resolver = build_resolver(rows, Path(media_root), has_audio=probe)
        if any(resolver(aid) is None for aid in tl.asset_ids(norm)):
            # Deleted since the export was asked for, or never this org's.
            raise ExportFailed("asset_unavailable")
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True, mode=0o700)
        out = work / "export.mp4"
        with _Heartbeat(lambda: store.export_heartbeat(eid, worker_id), heartbeat_s):
            try:
                timeline_render.to_render_spec(norm, resolver, str(out))
            except tl.TimelineError:
                # A clip past the end of its file, a still on an audio track…
                raise ExportFailed("invalid_timeline") from None
            try:
                # One segment at a time: this runs beside upload checking in the
                # media worker's memory budget, not in the render worker's.
                render(norm, resolver, str(out), ffmpeg=tools.ffmpeg, workdir=str(work), jobs=1)
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
                                                "editor_export": eid, "rev": export.get("rev")})
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

    def __init__(self, store: ml.MediaStore, *, media_root: Path, worker_id: str, tools: ml.Tools):
        self.store = store
        self.media_root = Path(media_root)
        self.worker_id = worker_id
        self.tools = tools
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
                   tools=self.tools)
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


__all__ = ["EXPORT_MAX_S", "ExportFailed", "ExportService", "REASONS", "audio_probe_command",
           "build_resolver", "probe_has_audio", "run_export", "serve"]
