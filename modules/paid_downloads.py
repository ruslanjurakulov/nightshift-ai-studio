"""Paid 720p / 1080p downloads — the worker's side of migration 0030.

The Command Center's "Download" inserts nothing itself: its route calls
``request_download()`` under the signed-in user's session, which charges the
organization's credits through the ledger and queues one ``download_requests``
row. The queue worker (``tools/queue_worker.py``) then, between render jobs:

1. keeps ``download_masters`` in step with its disk (:meth:`DownloadService.sync_masters`):
   every video whose MASTER render is under ``output/`` (``videos.local_path``,
   resolved by :func:`modules.social_publish.resolve_master`, never outside
   ``output/``) is probed once for frame size, length and bytes. The page
   offers only the qualities that master can give;
2. claims one queued request (``claim_download_request``), finds the master,
   and writes ``<downloads dir>/<id>.mp4`` — an ffmpeg transcode to the
   target's short side, or a plain copy when the master already IS that
   quality (no re-encode, no quality loss);
3. records ``ready`` with a 24-hour expiry (``finish_download_request``), or
   ``failed`` with a reason word — and the database refunds the charge in the
   same transaction;
4. deletes files past their expiry (:func:`gc_downloads`).

The file is named by the request's numeric id only; the Command Center's
``/api/downloads/<id>`` reads the row through RLS and streams that file from
the same volume (mounted read-only there). Nothing here uploads anywhere:
the HD file never goes to Supabase Storage.

Nothing secret is logged: request ids, reason words and exception types only.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Callable, Dict, List, Mapping, Optional, Tuple

from modules import social_publish

logger = logging.getLogger(__name__)

#: The frame's short side each quality needs (landscape height, portrait width).
QUALITY_SIDE: Dict[str, int] = {"720p": 720, "1080p": 1080}
#: How long a prepared file stays downloadable (the row's expires_at).
TTL_HOURS = 24
#: A half-written file older than this is debris from a crash.
PART_MAX_AGE_S = 6 * 3600
TRANSCODE_TIMEOUT_S = 3 * 3600
HEARTBEAT_S = 30.0
MASTER_SYNC_S = 15 * 60.0
MASTER_SYNC_LIMIT = 1000


class DownloadStop(Exception):
    """End a request as failed with a reason word and our own short detail."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(reason)
        self.reason = reason
        self.detail = detail[:500]


# ── paths ────────────────────────────────────────────────────────────────────


def download_path(downloads_dir: Path, request_id) -> Path:
    """``<dir>/<id>.mp4`` for a positive integer id — nothing else is accepted,
    so no value from the database can point outside the directory."""
    rid = str(request_id)
    if not rid.isdigit() or rid.startswith("0") or len(rid) > 18:
        raise ValueError("download request id must be a positive integer")
    return Path(downloads_dir) / f"{rid}.mp4"


def part_path(downloads_dir: Path, request_id) -> Path:
    final = download_path(downloads_dir, request_id)
    return final.with_name(final.stem + ".part.mp4")


# ── ffmpeg ───────────────────────────────────────────────────────────────────


def short_side(info: social_publish.VideoInfo) -> Optional[int]:
    if not info.width or not info.height:
        return None
    return min(info.width, info.height)


def plan(quality: str, info: social_publish.VideoInfo) -> str:
    """'copy' when the master already is that quality, 'transcode' when it is
    larger; raises DownloadStop when it is smaller or unknown."""
    side = QUALITY_SIDE.get(quality)
    if side is None:
        raise DownloadStop("unknown_quality")
    have = short_side(info)
    if have is None:
        raise DownloadStop("probe_failed", "could not read the master's frame size")
    if have < side:
        raise DownloadStop("master_too_small", f"the master is {have}p; {quality} was asked")
    return "copy" if have == side else "transcode"


def transcode_command(exe: str, src: Path, dst: Path, quality: str,
                      info: social_publish.VideoInfo) -> List[str]:
    """The ffmpeg argv that scales the master's SHORT side to the quality
    (``-2`` keeps the other side even, as libx264 requires)."""
    side = QUALITY_SIDE[quality]
    portrait = bool(info.width and info.height and info.height > info.width)
    scale = f"scale={side}:-2" if portrait else f"scale=-2:{side}"
    return [
        exe, "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
        "-i", str(src),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", scale,
        "-c:v", "libx264", "-preset", "medium", "-crf", "21",
        "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart",
        str(dst),
    ]


def run_ffmpeg(argv: List[str], heartbeat: Callable[[], None], *,
               timeout_s: float = TRANSCODE_TIMEOUT_S, beat_s: float = HEARTBEAT_S) -> int:
    """Run ffmpeg, beating the row's heartbeat while it works."""
    proc = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    started = time.monotonic()
    while True:
        try:
            return proc.wait(timeout=beat_s)
        except subprocess.TimeoutExpired:
            if time.monotonic() - started > timeout_s:
                proc.kill()
                proc.wait()
                raise DownloadStop("timeout", "the transcode took too long")
            try:
                heartbeat()
            except Exception:
                pass


# ── Supabase (service key) ───────────────────────────────────────────────────


class DownloadStore:
    """download_requests / download_masters over Supabase REST."""

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

    def _h(self, extra: Optional[dict] = None) -> dict:
        h = {"apikey": self._key, "Authorization": f"Bearer {self._key}"}
        if extra:
            h.update(extra)
        return h

    def _rpc(self, name: str, payload: dict):
        r = self.http().post(f"{self.url}/rest/v1/rpc/{name}", json=payload,
                             headers=self._h({"Content-Type": "application/json"}), timeout=self._timeout)
        if r.status_code == 404:
            return None  # 0030 not applied: nothing to do
        if r.status_code >= 300:
            raise RuntimeError(f"{name}: HTTP {r.status_code}")
        return r.json()

    def claim(self, worker_id: str) -> Optional[dict]:
        rows = self._rpc("claim_download_request", {"p_worker": worker_id})
        if isinstance(rows, dict):
            rows = [rows]
        return rows[0] if rows else None

    def finish(self, request_id, worker_id: str, *, ok: bool, bytes_: Optional[int] = None,
               reason: Optional[str] = None, error: Optional[str] = None, ttl_hours: int = TTL_HOURS):
        return self._rpc("finish_download_request", {
            "p_id": int(request_id), "p_worker": worker_id, "p_ok": bool(ok), "p_bytes": bytes_,
            "p_reason": reason, "p_error": error, "p_ttl_hours": int(ttl_hours),
        })

    def heartbeat(self, request_id, worker_id: str) -> None:
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.http().patch(f"{self.url}/rest/v1/download_requests",
                          params={"id": f"eq.{int(request_id)}", "worker_id": f"eq.{worker_id}"},
                          json={"heartbeat_at": now, "updated_at": now},
                          headers=self._h({"Content-Type": "application/json", "Prefer": "return=minimal"}),
                          timeout=self._timeout)

    def video(self, video_id: str) -> Optional[dict]:
        r = self.http().get(f"{self.url}/rest/v1/videos",
                            params={"select": "video_id,local_path", "video_id": f"eq.{video_id}", "limit": "1"},
                            headers=self._h(), timeout=self._timeout)
        if r.status_code >= 300:
            raise RuntimeError(f"videos: HTTP {r.status_code}")
        rows = r.json() or []
        return rows[0] if rows else None

    def videos_with_path(self, limit: int = MASTER_SYNC_LIMIT) -> List[dict]:
        r = self.http().get(f"{self.url}/rest/v1/videos",
                            params={"select": "video_id,local_path", "local_path": "not.is.null",
                                    "order": "published_at.desc.nullsfirst", "limit": str(limit)},
                            headers=self._h(), timeout=self._timeout)
        if r.status_code >= 300:
            raise RuntimeError(f"videos: HTTP {r.status_code}")
        return list(r.json() or [])

    def recorded_masters(self) -> Dict[str, int]:
        r = self.http().get(f"{self.url}/rest/v1/download_masters",
                            params={"select": "video_id,bytes", "limit": str(MASTER_SYNC_LIMIT * 2)},
                            headers=self._h(), timeout=self._timeout)
        if r.status_code == 404:
            return {}
        if r.status_code >= 300:
            raise RuntimeError(f"download_masters: HTTP {r.status_code}")
        return {str(x.get("video_id")): int(x.get("bytes") or 0) for x in (r.json() or [])}

    def record_master(self, video_id: str, info: social_publish.VideoInfo) -> None:
        self._rpc("record_download_master", {
            "p_video_id": video_id, "p_width": int(info.width), "p_height": int(info.height),
            "p_duration": round(float(info.duration), 2), "p_bytes": int(info.size),
        })

    def forget_master(self, video_id: str) -> None:
        self._rpc("forget_download_master", {"p_video_id": video_id})


# ── one request ──────────────────────────────────────────────────────────────


def prepare(req: Mapping, *, store: DownloadStore, output_dir: Path, downloads_dir: Path,
            worker_id: str, probe_fn: Callable[[Path], social_publish.VideoInfo] = social_publish.probe,
            ffmpeg_exe: Optional[Callable[[], Optional[str]]] = None,
            runner: Callable[..., int] = run_ffmpeg) -> int:
    """Write the file for one claimed request; returns its size in bytes.
    Raises DownloadStop with a reason word on anything the person should know."""
    rid = req.get("id")
    quality = str(req.get("quality") or "")
    video = store.video(str(req.get("video_id") or ""))
    if not video:
        raise DownloadStop("video_not_found")
    master = social_publish.resolve_master(video, output_dir)
    if master is None:
        raise DownloadStop("master_not_available",
                           "the full-quality render is not on this worker; the credits were refunded")
    info = probe_fn(master)
    how = plan(quality, info)

    downloads_dir = Path(downloads_dir)
    downloads_dir.mkdir(parents=True, exist_ok=True)
    final = download_path(downloads_dir, rid)
    part = part_path(downloads_dir, rid)
    part.unlink(missing_ok=True)
    try:
        if how == "copy":
            shutil.copyfile(master, part)
        else:
            exe = (ffmpeg_exe or social_publish._ffmpeg)()
            if not exe:
                raise DownloadStop("ffmpeg_missing", "this worker has no ffmpeg")
            code = runner(transcode_command(exe, master, part, quality, info),
                          lambda: store.heartbeat(rid, worker_id))
            if code != 0:
                raise DownloadStop("transcode_failed", f"ffmpeg exited with {code}")
        if not part.is_file() or part.stat().st_size <= 0:
            raise DownloadStop("transcode_failed", "ffmpeg wrote no output")
        # The web container reads it as another user (read-only mount).
        os.chmod(part, 0o644)
        os.replace(part, final)
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    return final.stat().st_size


def process_request(req: Mapping, *, store: DownloadStore, output_dir: Path, downloads_dir: Path,
                    worker_id: str, **kw) -> str:
    """Carry one claimed request to ready | failed. Never raises. A failure is
    refunded by the database (finish_download_request)."""
    rid = req.get("id")
    try:
        size = prepare(req, store=store, output_dir=output_dir, downloads_dir=downloads_dir,
                       worker_id=worker_id, **kw)
    except DownloadStop as stop:
        _finish_failed(store, rid, worker_id, stop.reason, stop.detail or None)
        logger.info("download request %s: failed (%s), refunded", rid, stop.reason)
        return "failed"
    except Exception as e:  # anything unforeseen: the type only
        _finish_failed(store, rid, worker_id, "worker_error", f"worker error ({type(e).__name__})")
        logger.warning("download request %s: failed (%s), refunded", rid, type(e).__name__)
        return "failed"
    try:
        store.finish(rid, worker_id, ok=True, bytes_=size)
    except Exception as e:
        # The row stays processing; the claim sweep retries it, the file is
        # rewritten, and the charge is refunded if it never settles.
        logger.warning("download request %s: could not record ready (%s)", rid, type(e).__name__)
        return "failed"
    logger.info("download request %s: ready (%s, %d bytes)", rid, req.get("quality"), size)
    return "ready"


def _finish_failed(store: DownloadStore, rid, worker_id: str, reason: str, detail: Optional[str]) -> None:
    try:
        store.finish(rid, worker_id, ok=False, reason=reason, error=detail)
    except Exception as e:
        logger.warning("download request %s: could not record the failure (%s)", rid, type(e).__name__)


# ── housekeeping ─────────────────────────────────────────────────────────────


def gc_downloads(downloads_dir: Path, *, ttl_hours: int = TTL_HOURS, now: Optional[float] = None) -> int:
    """Delete prepared files past their expiry (plus an hour's grace for a
    download still in flight) and half-written ones. Returns how many."""
    d = Path(downloads_dir)
    if not d.is_dir():
        return 0
    now = time.time() if now is None else now
    n = 0
    for f in d.iterdir():
        if not f.is_file() or f.suffix != ".mp4":
            continue
        age = now - f.stat().st_mtime
        limit = PART_MAX_AGE_S if f.name.endswith(".part.mp4") else (ttl_hours + 1) * 3600
        if age > limit:
            try:
                f.unlink()
                n += 1
            except OSError:
                pass
    return n


class DownloadService:
    """What the queue worker calls between render jobs."""

    def __init__(self, url: str, service_key: str, *, output_dir: Path, downloads_dir: Path,
                 worker_id: str, store: Optional[DownloadStore] = None,
                 probe_fn: Callable[[Path], social_publish.VideoInfo] = social_publish.probe,
                 clock: Callable[[], float] = time.monotonic):
        self.store = store or DownloadStore(url, service_key)
        self.output_dir = Path(output_dir)
        self.downloads_dir = Path(downloads_dir)
        self.worker_id = worker_id
        self.probe_fn = probe_fn
        self.clock = clock
        self._last_sync: Optional[float] = None
        self._seen: Dict[str, Tuple[int, int]] = {}
        self._warned = False

    def sync_masters(self, force: bool = False) -> int:
        """Record newly found masters, forget vanished ones. Returns changes."""
        if not force and self._last_sync is not None and self.clock() - self._last_sync < MASTER_SYNC_S:
            return 0
        self._last_sync = self.clock()
        changes = 0
        recorded = self.store.recorded_masters()
        present = set()
        for video in self.store.videos_with_path():
            vid = str(video.get("video_id") or "")
            path = social_publish.resolve_master(video, self.output_dir)
            if not vid or path is None:
                continue
            st = path.stat()
            key = (st.st_size, st.st_mtime_ns)
            present.add(vid)
            if self._seen.get(vid) == key and vid in recorded:
                continue
            if recorded.get(vid) == st.st_size and vid not in self._seen:
                self._seen[vid] = key
                continue
            info = self.probe_fn(path)
            if not info.width or not info.height or not info.duration or info.duration <= 0:
                continue
            self.store.record_master(vid, info)
            self._seen[vid] = key
            changes += 1
        for vid in recorded:
            if vid not in present:
                self.store.forget_master(vid)
                self._seen.pop(vid, None)
                changes += 1
        return changes

    def run_once(self) -> bool:
        """Housekeeping, then at most one request. True when one was handled."""
        try:
            gc_downloads(self.downloads_dir)
            self.sync_masters()
            req = self.store.claim(self.worker_id)
        except Exception as e:
            if not self._warned:
                logger.warning("download queue unavailable (%s)", str(e) if isinstance(e, RuntimeError)
                               else type(e).__name__)
                self._warned = True
            return False
        if not req:
            return False
        process_request(req, store=self.store, output_dir=self.output_dir,
                        downloads_dir=self.downloads_dir, worker_id=self.worker_id, probe_fn=self.probe_fn)
        return True


__all__ = [
    "DownloadService", "DownloadStore", "DownloadStop", "QUALITY_SIDE", "download_path", "gc_downloads",
    "plan", "prepare", "process_request", "transcode_command",
]
