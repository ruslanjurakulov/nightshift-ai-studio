"""Upload idempotency — never publish the same run twice.

The problem
-----------
``videos.insert`` is a resumable upload of a large file. The dangerous failure
is not a clean refusal but an *ambiguous* one: the last chunk went out, and then
the connection dropped, the socket timed out, or YouTube answered 5xx. The video
may very well exist on the channel already. Retrying blindly — or re-running the
job — would put a second copy on the channel.

The approach
------------
1. **A stable run marker.** Every upload of a run carries a tag
   ``nsrun-<12 hex>`` derived from the run's slug, channel and run epoch
   (``run_checkpoint.run_epoch``). Tags are not shown to viewers; the marker is
   only a key we can look up. It is placed first so tag trimming never drops it.
2. **An attempt ledger** (``output/<slug>/upload_attempt.json``) written
   *before* the insert and again the moment the insert returns a video id, plus
   after the thumbnail and caption steps. A run that dies at any point leaves an
   honest record of how far it got.
3. **Reconcile before retrying.** After an ambiguous failure — or on a later
   attempt of a run whose previous insert never reported back — the channel's
   recent uploads are searched for the marker (``channels.list`` →
   ``playlistItems.list`` → ``videos.list``: ~3 quota units, versus ~1600 for an
   insert). A found video id is reused instead of uploading again.
4. **Definitive failures are not retried.** A 4xx (bad request, quota, auth), a
   missing file, a config error: the video was not created, and retrying would
   only repeat the failure. They are raised exactly as before.
5. **When we cannot tell, we stop.** If the lookup itself fails, the upload is
   *not* retried — :class:`UploadAmbiguousError` is raised, the rendered video
   stays on disk, and the next attempt looks up again first. A missing video is
   recoverable; a duplicate public video is not.

Nothing here changes *whether* a video is uploaded — the publish gate and the
approval flow decide that upstream, untouched. No secrets are read or written:
only the slug, channel id, a hash, timestamps and a video id.
"""

from __future__ import annotations

import hashlib
import http.client
import json
import logging
import os
import ssl
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger(__name__)

MARKER_PREFIX = "nsrun-"
ATTEMPT_FILENAME = "upload_attempt.json"

STATE_NEW = "new"
STATE_STARTED = "started"        # insert sent; outcome unknown until it returns
STATE_UPLOADED = "uploaded"      # insert returned a video id
STATE_FAILED = "failed"          # definitive failure: the video was not created

STEP_THUMBNAIL = "thumbnail"
STEP_CAPTIONS = "captions"

#: How many recent uploads are scanned for the marker. An ambiguous upload is
#: seconds-to-hours old, never weeks; 50 is the API's page maximum.
LOOKUP_WINDOW = 50

#: Waits (seconds) before each marker lookup after an ambiguous failure: a
#: freshly inserted video can take a moment to show in the uploads playlist.
LOOKUP_DELAYS = (5.0, 20.0, 45.0)

#: At most this many extra inserts after an ambiguous failure whose marker was
#: confirmed absent. Never more — every insert costs ~1600 quota units.
MAX_AMBIGUOUS_RETRIES = 1

#: Indirection so tests do not sleep.
_sleep: Callable[[float], None] = time.sleep


class UploadAmbiguousError(RuntimeError):
    """The upload may have landed and we could not verify either way, so it was
    deliberately not retried. The video stays on disk; the next attempt of this
    run looks the marker up first."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def make_marker(slug: str, channel_id: str = "", run_epoch: str = "") -> str:
    """``nsrun-<12 hex>``: stable for one run of one topic on one channel, short
    (18 chars, no spaces) so it barely dents YouTube's 500-char tag budget."""
    raw = f"{slug}|{channel_id}|{run_epoch}".encode("utf-8")
    return MARKER_PREFIX + hashlib.sha256(raw).hexdigest()[:12]


# -- classification ----------------------------------------------------------

def http_status(exc: BaseException) -> Optional[int]:
    """The HTTP status of a googleapiclient ``HttpError`` (or anything with a
    ``resp.status``), else None."""
    resp = getattr(exc, "resp", None)
    status = getattr(resp, "status", None) if resp is not None else getattr(exc, "status_code", None)
    try:
        return int(status) if status is not None else None
    except (TypeError, ValueError):
        return None


def _transport_errors() -> tuple:
    errors: list = [TimeoutError, ConnectionError, http.client.HTTPException, ssl.SSLError]
    try:   # the transport googleapiclient uses; optional so tests need not have it
        import httplib2
        errors.append(httplib2.HttpLib2Error)
    except Exception:
        pass
    return tuple(errors)


def is_ambiguous(exc: BaseException) -> bool:
    """True when the request may have reached YouTube and been acted on.

    * transport failures (timeout, reset, broken pipe, TLS, truncated
      response) — the bytes may have arrived;
    * HTTP 5xx — the server failed *after* receiving the request.

    Everything else — HTTP 4xx (invalid metadata, quota, auth), a missing file,
    a config or programming error — is definitive: the video was not created.
    """
    status = http_status(exc)
    if status is not None:
        return status >= 500
    return isinstance(exc, _transport_errors())


# -- lookup --------------------------------------------------------------------

@dataclass(frozen=True)
class Lookup:
    """Outcome of a marker search. ``ok`` False means we could not tell."""

    ok: bool
    video_id: Optional[str] = None


def _uploads_playlist(service, channel_id: str = "") -> Optional[str]:
    kwargs = {"part": "contentDetails"}
    if channel_id:
        kwargs["id"] = channel_id
    else:
        kwargs["mine"] = True
    resp = service.channels().list(**kwargs).execute() or {}
    items = resp.get("items") or []
    if not items:
        return None
    related = (items[0].get("contentDetails") or {}).get("relatedPlaylists") or {}
    return related.get("uploads")


def find_video_by_marker(service, marker: str, *, channel_id: str = "",
                         window: int = LOOKUP_WINDOW) -> Lookup:
    """Search the channel's most recent uploads for a video tagged ``marker``.

    Private videos are included (the uploads playlist lists them to the owner)
    and tags are only returned to the owner, which is what we are. Never raises:
    any API problem is ``Lookup(ok=False)``."""
    try:
        playlist_id = _uploads_playlist(service, channel_id)
        if not playlist_id:
            # A channel with no uploads playlist has no uploads.
            return Lookup(ok=True)
        resp = service.playlistItems().list(
            part="contentDetails", playlistId=playlist_id,
            maxResults=max(1, min(50, int(window))),
        ).execute() or {}
        ids = [
            (item.get("contentDetails") or {}).get("videoId")
            for item in resp.get("items") or []
        ]
        ids = [i for i in ids if i]
        if not ids:
            return Lookup(ok=True)
        videos = service.videos().list(part="snippet", id=",".join(ids)).execute() or {}
        for item in videos.get("items") or []:
            tags = (item.get("snippet") or {}).get("tags") or []
            if marker in tags:
                return Lookup(ok=True, video_id=item.get("id"))
        return Lookup(ok=True)
    except Exception as e:
        logger.warning("Upload marker lookup failed (%s: %s)", type(e).__name__, e)
        return Lookup(ok=False)


def video_exists(service, video_id: str, marker: str = "") -> Optional[bool]:
    """True/False when ``video_id`` is (not) on YouTube — and, with ``marker``,
    carries it. None when we could not tell. Never raises."""
    try:
        resp = service.videos().list(part="snippet", id=video_id).execute() or {}
    except Exception as e:
        logger.warning("Could not verify video %s (%s: %s)", video_id, type(e).__name__, e)
        return None
    for item in resp.get("items") or []:
        if item.get("id") != video_id:
            continue
        if marker:
            return marker in ((item.get("snippet") or {}).get("tags") or [])
        return True
    return False


def reconcile(service, marker: str, *, channel_id: str = "",
              delays=LOOKUP_DELAYS) -> Lookup:
    """Look for ``marker`` a few times, waiting between tries (a new upload can
    lag the playlist). Stops at the first hit or the first lookup that fails —
    a failed lookup is "cannot tell", never "not there"."""
    last = Lookup(ok=True)
    for delay in (delays or (0.0,)):
        if delay:
            _sleep(delay)
        last = find_video_by_marker(service, marker, channel_id=channel_id)
        if not last.ok or last.video_id:
            return last
    return last


# -- the attempt ledger ----------------------------------------------------------

def attempt_path(slug: str, root: Optional[Path] = None) -> Path:
    if root is None:
        from config import OUTPUT_DIR
        root = OUTPUT_DIR
    return Path(root) / slug / ATTEMPT_FILENAME


@dataclass
class UploadAttempt:
    """What we know about this run's upload so far. Persisted on every change;
    persisting never raises (a failed write only costs us the reconciliation
    on a later attempt, never the upload itself)."""

    slug: str
    channel_id: str = ""
    run_epoch: str = ""
    marker: str = ""
    state: str = STATE_NEW
    video_id: Optional[str] = None
    steps: list = field(default_factory=list)
    started_at: str = ""
    updated_at: str = ""
    root: Optional[Path] = None

    @property
    def needs_lookup(self) -> bool:
        """An earlier insert was sent and never reported back."""
        return self.state == STATE_STARTED and not self.video_id

    def step_done(self, step: str) -> bool:
        return step in self.steps

    # -- transitions (each persists) ---------------------------------------

    def mark_started(self) -> None:
        self.state = STATE_STARTED
        self.started_at = self.started_at or _now_iso()
        self._save()

    def mark_uploaded(self, video_id: str) -> None:
        self.state = STATE_UPLOADED
        self.video_id = str(video_id)
        self._save()

    def mark_failed(self) -> None:
        self.state = STATE_FAILED
        self._save()

    def mark_step(self, step: str) -> None:
        if step not in self.steps:
            self.steps.append(step)
            self._save()

    def forget_video(self) -> None:
        """The recorded video is gone from YouTube (deleted by a human): the
        next insert starts over."""
        self.state = STATE_NEW
        self.video_id = None
        self.steps = []
        self._save()

    def to_dict(self) -> dict:
        return {
            "slug": self.slug, "channel_id": self.channel_id,
            "run_epoch": self.run_epoch, "marker": self.marker,
            "state": self.state, "video_id": self.video_id,
            "steps": list(self.steps),
            "started_at": self.started_at, "updated_at": self.updated_at,
        }

    def _save(self) -> None:
        self.updated_at = _now_iso()
        path = attempt_path(self.slug, self.root)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(path.suffix + ".tmp")
            tmp.write_text(json.dumps(self.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, path)
        except Exception as e:
            logger.warning("Could not write upload attempt %s (%s: %s) — continuing",
                           path, type(e).__name__, e)


def begin(slug: str, channel_id: str = "", *, root: Optional[Path] = None) -> UploadAttempt:
    """The upload attempt for this run: the recorded one when it belongs to the
    same run (same epoch and channel) and is not yet finished, else a fresh one.
    Never raises — on any problem a fresh attempt with a valid marker is
    returned, which is no worse than before this module existed."""
    epoch = ""
    try:
        from modules import run_checkpoint
        epoch = run_checkpoint.run_epoch(slug, root)
    except Exception as e:
        logger.warning("Could not read the run epoch for %r (%s: %s)", slug, type(e).__name__, e)
    if not epoch:
        # No checkpoint means no run identity to tie attempts together. Use a
        # one-off marker and do not reload anything: in-process reconciliation
        # still works, and we can never mistake an older run's video for ours.
        return UploadAttempt(slug=slug, channel_id=channel_id or "", run_epoch="",
                             marker=make_marker(slug, channel_id or "", uuid.uuid4().hex),
                             root=root)
    fresh = UploadAttempt(slug=slug, channel_id=channel_id or "", run_epoch=epoch,
                          marker=make_marker(slug, channel_id or "", epoch), root=root)
    path = attempt_path(slug, root)
    try:
        if not path.exists():
            return fresh
        raw = json.loads(path.read_text(encoding="utf-8") or "{}")
    except Exception as e:
        logger.warning("Could not read upload attempt %s (%s: %s) — starting fresh",
                       path, type(e).__name__, e)
        return fresh
    if (
        not isinstance(raw, dict)
        or str(raw.get("run_epoch") or "") != epoch
        or str(raw.get("channel_id") or "") != (channel_id or "")
        or not str(raw.get("marker") or "").startswith(MARKER_PREFIX)
    ):
        return fresh
    return UploadAttempt(
        slug=slug, channel_id=channel_id or "", run_epoch=epoch,
        marker=str(raw["marker"]),
        state=str(raw.get("state") or STATE_NEW),
        video_id=(str(raw["video_id"]) if raw.get("video_id") else None),
        steps=[str(s) for s in (raw.get("steps") or []) if isinstance(s, str)],
        started_at=str(raw.get("started_at") or ""),
        updated_at=str(raw.get("updated_at") or ""),
        root=root,
    )
