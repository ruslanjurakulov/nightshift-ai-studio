"""Put the rendered video, its title and its script where a human can see them.

Why this exists
---------------
Until now the only durable handle on a finished video was its YouTube id, and
every upload is private (``config.YOUTUBE_PRIVACY`` defaults to ``private``,
and so do both the schedule and the manual dispatch). A private video cannot be
embedded, and ``videos.local_path`` points at a runner that no longer exists —
so there was nothing for the Command Center to show. This module puts a small
480p cut of the render in a private Supabase Storage bucket and records the
script beside it, which is what a reviewer actually needs in order to say yes.

What it deliberately does NOT do
--------------------------------
It does not publish, un-publish, or change any video's privacy, and it is not
part of the publish gate. It runs *after* the pipeline has finished with a
video and only ever writes: an object into a bucket, and the review columns
of that video's row (creating the row if it is not there yet — see
``record``).

Like ``event_log`` and ``supabase_sync``, nothing here raises into the
pipeline. A missing bucket, a slow network or an oversized file is logged and
swallowed — a preview is a convenience, and losing one must never turn a
successful run into a failed one.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import requests

logger = logging.getLogger(__name__)

BUCKET = "previews"
_TIMEOUT = 180  # seconds — a whole video goes over the wire, not a JSON row.

# What goes into the bucket is a *review copy*, not the master. Supabase's free
# tier caps a single object at 50 MB across the whole project, and a five-minute
# 1080p render is 50-150 MB, so uploading the master would fail for most videos
# and eat the quota for the rest. A 480p cut is plenty to check that the pacing,
# the b-roll and the subtitles are right, which is what the reviewer is judging.
REVIEW_HEIGHT = 480
REVIEW_CRF = "30"
REVIEW_MAXRATE = "700k"
REVIEW_AUDIO_BITRATE = "64k"
_TRANSCODE_TIMEOUT = 900  # seconds — a downscale is cheap, but the runner is not fast.

# Below the 50 MB object ceiling, with room to spare. A review copy that still
# lands over this means the transcode did not happen or produced something
# unexpected, and pushing it would fail at the bucket anyway.
MAX_BYTES = 45 * 1024 * 1024

# Free-tier storage is 1 GB. At ~15 MB a review copy, keeping the last few per
# channel is the difference between a working review queue and a quota that
# fills up silently.
KEEP_PER_CHANNEL = 5
# Held runs (not uploaded: no YouTube copy to fall back on) are ranked apart from uploaded ones, and keep as many:
# a held video still awaiting review must not lose its only copy to newer holds. Ceiling: 5 uploaded + 5 held.
KEEP_HELD_PER_CHANNEL = 5

# Migration 0112: a person's approval (videos.approved_cut_sha256 and who/when/until) is for one cut. Recording a cut
# clears it, whatever the review state is set to; the database function approve_video_publish is the only writer of it.
NO_APPROVAL = {
    "approved_cut_sha256": None,
    "decided_by": None,
    "decided_by_email": None,
    "decided_at": None,
    "approval_expires_at": None,
}


def _ffmpeg_exe() -> str | None:
    """The ffmpeg the render already depends on, or whatever is on PATH."""
    try:
        import imageio_ffmpeg  # moviepy's own dependency — already installed.

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


class VideoReview:
    """Uploads previews and prunes old ones. Disabled, and harmless, without keys."""

    def __init__(self, url: str | None = None, service_key: str | None = None):
        self.url = (url if url is not None else os.getenv("SUPABASE_URL", "")).rstrip("/")
        self.service_key = service_key if service_key is not None else os.getenv("SUPABASE_SERVICE_KEY", "")
        self.enabled = bool(self.url and self.service_key)
        if not self.enabled:
            logger.info(
                "VideoReview disabled (SUPABASE_URL / SUPABASE_SERVICE_KEY not set) — "
                "the run is unaffected; there will simply be no preview to review."
            )

    def _headers(self, extra: dict | None = None) -> dict:
        headers = {
            "apikey": self.service_key,
            "Authorization": f"Bearer {self.service_key}",
        }
        if extra:
            headers.update(extra)
        return headers

    # ── storage ────────────────────────────────────────────────────────────
    def review_copy(self, source: Path) -> tuple[Path, bool]:
        """A small 480p cut of the render, and whether it is ours to delete.

        Falls back to the master when ffmpeg is missing or the transcode fails.
        That fallback almost always ends up refused by the size check below,
        which is the right outcome: no preview beats a failed upload or a
        silently exhausted quota, and the run is unaffected either way.
        """
        exe = _ffmpeg_exe()
        if exe is None:
            logger.warning("No ffmpeg found — falling back to the full render for the preview")
            return source, False

        handle, name = tempfile.mkstemp(prefix="review-", suffix=".mp4")
        os.close(handle)
        target = Path(name)
        command = [
            exe, "-y", "-loglevel", "error", "-i", str(source),
            # -2 keeps the width even, which libx264 requires.
            "-vf", f"scale=-2:{REVIEW_HEIGHT}",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", REVIEW_CRF,
            "-maxrate", REVIEW_MAXRATE, "-bufsize", "1400k",
            "-c:a", "aac", "-b:a", REVIEW_AUDIO_BITRATE,
            # The dashboard plays this over a signed URL; faststart lets it
            # start before the whole file has arrived.
            "-movflags", "+faststart",
            str(target),
        ]
        try:
            done = subprocess.run(command, capture_output=True, timeout=_TRANSCODE_TIMEOUT)
            if done.returncode == 0 and target.exists() and target.stat().st_size > 0:
                return target, True
            logger.warning(
                "Review transcode failed (exit %s) — falling back to the full render",
                done.returncode,
            )
        except Exception as e:
            logger.warning(
                "Review transcode failed (%s: %s) — falling back to the full render",
                type(e).__name__, e,
            )
        target.unlink(missing_ok=True)
        return source, False

    def upload_preview(self, video_path: Path, channel_id: str, video_id: str) -> str | None:
        """Put a review copy of the mp4 in the bucket. Returns its object path, or None."""
        if not self.enabled:
            return None

        upload_path, temporary = self.review_copy(video_path)
        try:
            try:
                size = upload_path.stat().st_size
            except OSError:
                logger.warning("No preview uploaded: cannot stat %s", upload_path)
                return None
            if size > MAX_BYTES:
                logger.warning(
                    "No preview uploaded: %s is %.0f MB, over the %.0f MB ceiling",
                    upload_path.name, size / 1048576, MAX_BYTES / 1048576,
                )
                return None

            # Keyed on the YouTube id so the object and the row can never drift
            # apart, and re-running the same video overwrites rather than piles up.
            object_path = f"{channel_id}/{video_id}.mp4"
            try:
                with upload_path.open("rb") as fh:
                    resp = requests.post(
                        f"{self.url}/storage/v1/object/{BUCKET}/{object_path}",
                        data=fh,
                        headers=self._headers({
                            "Content-Type": "video/mp4",
                            # Overwrite an existing object instead of failing on it.
                            "x-upsert": "true",
                        }),
                        timeout=_TIMEOUT,
                    )
                if resp.status_code >= 300:
                    logger.warning("Preview upload failed (%s) — the run is unaffected", resp.status_code)
                    return None
            except Exception as e:
                logger.warning("Preview upload failed (%s: %s) — the run is unaffected", type(e).__name__, e)
                return None

            logger.info("Preview stored: %s (%.0f MB)", object_path, size / 1048576)
            return object_path
        finally:
            if temporary:
                upload_path.unlink(missing_ok=True)

    def prune(self, channel_id: str) -> int:
        """Delete all but the newest KEEP_PER_CHANNEL previews for one channel."""
        if not self.enabled:
            return 0
        # Uploaded and held videos are ranked separately: a held run has no
        # published_at (NULL sorts first when descending), so one shared list
        # would rank every held preview above the real uploads and prune those.
        stale: list = []
        for published, order, keep in (("not.is.null", "published_at.desc", KEEP_PER_CHANNEL),
                                       ("is.null", "held_at.desc", KEEP_HELD_PER_CHANNEL)):
            try:
                rows = requests.get(
                    f"{self.url}/rest/v1/videos",
                    params={
                        "select": "video_id,preview_path,published_at",
                        "channel_id": f"eq.{channel_id}",
                        "preview_path": "not.is.null",
                        "published_at": published,
                        "order": order,
                        "offset": str(keep),
                    },
                    headers=self._headers(),
                    timeout=30,
                )
                rows.raise_for_status()
                stale += [r for r in rows.json() if r.get("preview_path")]
            except Exception as e:
                logger.warning("Could not list old previews (%s: %s)", type(e).__name__, e)
                if published == "not.is.null":
                    return 0
        if not stale:
            return 0

        try:
            resp = requests.delete(
                f"{self.url}/storage/v1/object/{BUCKET}",
                json={"prefixes": [r["preview_path"] for r in stale]},
                headers=self._headers({"Content-Type": "application/json"}),
                timeout=60,
            )
            if resp.status_code >= 300:
                logger.warning("Could not delete old previews (%s)", resp.status_code)
                return 0
        except Exception as e:
            logger.warning("Could not delete old previews (%s: %s)", type(e).__name__, e)
            return 0

        # Clear the pointers too, so the dashboard never offers a play button
        # for bytes that are gone.
        for r in stale:
            self._patch_video(r["video_id"], {"preview_path": None})
        logger.info("Pruned %d old preview(s) for channel %s", len(stale), channel_id)
        return len(stale)

    def delete_objects(self, paths: list) -> bool:
        """Best-effort removal of preview objects from the bucket. Never raises."""
        paths = [p for p in paths if p]
        if not self.enabled or not paths:
            return False
        try:
            resp = requests.delete(
                f"{self.url}/storage/v1/object/{BUCKET}",
                json={"prefixes": paths},
                headers=self._headers({"Content-Type": "application/json"}),
                timeout=60,
            )
            return resp.status_code < 300
        except Exception as e:
            logger.warning("Could not delete preview object(s) (%s)", type(e).__name__)
            return False

    def preview_of(self, video_id: str) -> str | None:
        """The preview object a row currently points at, or None (also when the lookup fails)."""
        if not self.enabled:
            return None
        try:
            resp = requests.get(
                f"{self.url}/rest/v1/videos",
                params={"select": "preview_path", "video_id": f"eq.{video_id}", "limit": "1"},
                headers=self._headers(),
                timeout=15,
            )
            rows = resp.json() if resp.status_code < 300 else []
            path = rows[0].get("preview_path") if isinstance(rows, list) and rows else None
            return path if isinstance(path, str) and path else None
        except Exception:
            return None

    def refresh_preview(self, *, video_id: str, channel_id: str, video_path: Path) -> None:
        """Replace a row's preview with one of ``video_path`` and nothing else (a repaired cut replaces the held
        one). When no new copy can be made the pointer is cleared: a pre-repair cut must never stay playable
        beside a row that says it was repaired. Never raises."""
        if not self.enabled:
            return
        try:
            path = self.upload_preview(video_path, channel_id, video_id)
            self._upsert_video({"video_id": video_id, "channel_id": channel_id, "preview_path": path})
        except Exception as e:
            logger.warning("Could not refresh the preview for %s (%s: %s)", video_id, type(e).__name__, e)

    def fetch_auto_publish(self, channel_id: str) -> bool:
        """Does this channel publish without being asked?

        Read from Supabase rather than the local registry, because the toggle
        lives in the Command Center and that is where an operator turns it on.
        Anything that goes wrong — no keys, no network, no column yet — answers
        False, which leaves the video waiting for a human. The safe direction is
        the default in every failure mode.
        """
        if not self.enabled:
            return False
        try:
            resp = requests.get(
                f"{self.url}/rest/v1/channels",
                params={"select": "auto_publish", "channel_id": f"eq.{channel_id}", "limit": "1"},
                headers=self._headers(),
                timeout=15,
            )
            resp.raise_for_status()
            rows = resp.json()
            return bool(rows and rows[0].get("auto_publish"))
        except Exception as e:
            logger.info(
                "Could not read auto_publish for %s (%s) — treating it as off",
                channel_id, type(e).__name__,
            )
            return False

    # ── the row ────────────────────────────────────────────────────────────
    def _patch_video(self, video_id: str, patch: dict) -> bool:
        try:
            resp = requests.patch(
                f"{self.url}/rest/v1/videos",
                params={"video_id": f"eq.{video_id}"},
                json=patch,
                headers=self._headers({"Content-Type": "application/json", "Prefer": "return=minimal"}),
                timeout=30,
            )
            return resp.status_code < 300
        except Exception as e:
            logger.warning("Could not update video %s (%s: %s)", video_id, type(e).__name__, e)
            return False

    def _upsert_video(self, row: dict) -> bool:
        """Insert-or-merge one ``videos`` row on its primary key.

        PostgREST's ``merge-duplicates`` updates only the columns present in
        ``row``; every other column of an existing row is left exactly as it
        was, and on insert the absent columns take their defaults. The key is
        sent only as a header and never logged."""
        try:
            resp = requests.post(
                f"{self.url}/rest/v1/videos",
                params={"on_conflict": "video_id"},
                json=row,
                headers=self._headers({
                    "Content-Type": "application/json",
                    "Prefer": "resolution=merge-duplicates,return=minimal",
                }),
                timeout=30,
            )
            if resp.status_code >= 300:
                logger.warning("Could not record review columns for %s (HTTP %s)",
                               row.get("video_id"), resp.status_code)
                return False
            return True
        except Exception as e:
            logger.warning("Could not record review columns for %s (%s)",
                           row.get("video_id"), type(e).__name__)
            return False

    def record(
        self,
        *,
        video_id: str,
        channel_id: str,
        video_path: Path,
        script_text: str,
        auto_publish: bool,
        scenes: list | None = None,
        manifest: dict | None = None,
        published_at: str | None = None,
        title: str | None = None,
        topic: str | None = None,
        slug: str | None = None,
        gate_verdict: dict | None = None,
    ) -> None:
        """Upload the preview and attach the script to the row.

        `review_state` is left alone when the channel publishes automatically —
        there is nobody waiting on it — and set to "pending" when it does not,
        which is the honest statement that a human has not looked yet.

        `scenes` is the structured scene plan the video was built from (see
        migration 0011); it rides the same PATCH as the narration. None/empty
        leaves the column untouched, so an older schema (no `scenes` column) or a
        run that could not build the list behaves exactly as before.

        `manifest` is the run's Video IR (modules/video_ir.py, migration 0013),
        written to `videos.manifest`. When present, each `scenes` entry also
        gains its IR `id` and its REAL `start_s`/`end_s` from the audio timeline,
        so the Storyboard shows measured times instead of `duration_hint`.
        None leaves both exactly as before.

        The write is an UPSERT on ``video_id``, not a PATCH. On a first-pass
        upload the ``videos`` row usually does not exist yet — the Supabase
        mirror (``supabase_sync.mirror_from_store``) creates it later, in the
        intelligence-poll job — and a PATCH on a missing row matches nothing,
        so the preview, script, scenes and manifest were silently lost. The
        upsert creates the row when it is missing and, when it exists (the
        mirror got there first, or ``held_video.promote`` re-keyed this run's
        held row), merges only the columns sent here into it.

        Besides the review columns it sends ``channel_id`` (NOT NULL, and its
        default would put the row on the wrong channel) and, when given, the
        upload's own ``published_at`` / ``title`` / ``topic`` / ``slug`` — the
        same values ``StateStore.record_video`` stored and the mirror will
        later upsert, so the two writers agree. ``published_at`` matters: a
        row without it (and without ``privacy``) reads as a *held* run in the
        Command Center. Nothing is ever sent as NULL except ``script_text``
        when there is no narration (as before) and the migration 0112 columns
        (see below, where NULL means "unknown" or "no approval"); ``privacy``
        is never sent.

        ``gate_verdict`` is the publish gate's verdict for THIS cut (``held_video.gate_verdict``), and the row also gets
        ``cut_sha256``, the hash of ``video_path`` (migration 0112). A person's approval binds to that hash; the
        verdict is stored with it because the gate's events are emitted before the video exists and do not carry its
        id. Both are written whatever the review state, and the previous approval's columns are cleared: this call
        is a new cut being recorded, and it sets ``review_state`` back to pending for a channel that does not publish
        on its own. A verdict that is not known is sent as NULL, which reads "unknown", never "passed".

        Idempotent (same key, same values), and never raises.
        """
        if not self.enabled:
            return
        try:
            # An uploaded run's row may still point at its HELD preview (held_video.promote re-keys the row but keeps
            # the pointer): read it before it is replaced, delete that object after the new one is recorded.
            previous = self.preview_of(video_id)
            preview_path = self.upload_preview(video_path, channel_id, video_id)
            row: dict = {
                "video_id": video_id,
                "channel_id": channel_id,
                "script_text": script_text or None,
            }
            for key, value in (("published_at", published_at), ("title", title),
                               ("topic", topic), ("slug", slug)):
                if value:
                    row[key] = value
            if preview_path:
                row["preview_path"] = preview_path
            row["review_state"] = "approved" if auto_publish else "pending"
            # 0112: the cut and what was decided about it; any earlier person's approval is for a cut that may be gone.
            from modules import held_video

            row["cut_sha256"] = held_video.cut_sha256(video_path)
            row["gate_verdict"] = gate_verdict if isinstance(gate_verdict, dict) else None
            row.update(NO_APPROVAL)
            if manifest:
                from modules import video_ir

                scenes = video_ir.annotate_scenes(scenes, manifest)
                row["manifest"] = manifest
            if scenes:
                row["scenes"] = scenes
            ok = self._upsert_video(row)
            if not ok:
                # An un-migrated database (no `manifest` column, or no 0112 columns) rejects the whole
                # write; retry without the missing columns so the preview/script still land.
                from modules.held_video import COLUMNS_0112

                no_manifest = {k: v for k, v in row.items() if k != "manifest"}
                no_new = {k: v for k, v in row.items() if k not in COLUMNS_0112 + tuple(NO_APPROVAL)}
                for attempt in (no_manifest, no_new, {k: v for k, v in no_new.items() if k != "manifest"}):
                    if attempt == row or not attempt:
                        continue
                    ok = self._upsert_video(attempt)
                    if ok:
                        row = attempt
                        break
            if preview_path:
                from modules.held_video import HELD_ID_PREFIX

                if ok and previous and previous != preview_path and previous.startswith(f"{channel_id}/{HELD_ID_PREFIX}"):
                    self.delete_objects([previous])
                self.prune(channel_id)
        except Exception as e:
            logger.warning("Could not record the review row for %s (%s: %s) — the run is unaffected",
                           video_id, type(e).__name__, e)
