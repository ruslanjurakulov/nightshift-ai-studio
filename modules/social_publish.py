"""Cross-post a finished video to Instagram / TikTok / another YouTube channel —
the worker's side of 0029.

The Command Center's "Publish to platforms" inserts one ``publish_requests``
row per ticked account or YouTube channel and stops; nothing in a browser
uploads. The queue
worker (``tools/queue_worker.py``) claims those rows with the service key and
hands each to :func:`process_request`, which:

1. asks the database again whether the video may be cross-posted
   (``publish_request_refusal`` — the publish gate passed, the video was
   approved, the channel's two-person rule satisfied); a "no" is recorded as
   ``refused`` with the reason word, and nothing is uploaded;
2. reads the account's token from Vault (``modules/social_tokens.py``,
   refreshing it when it is close to expiry) — or, for a YouTube channel, the
   channel's own token resolved exactly as a render run resolves it (its Vault
   connection from 0022, else its ``CHRONOS_YT_TOKEN_<REF>`` secret; the
   default channel's ``YOUTUBE_TOKEN_JSON``), in memory only;
3. finds the MASTER render on this worker's disk (``videos.local_path`` under
   ``output/``). There is no silent quality fallback: when only the 480p
   review copy exists, the request is refused with ``master_not_available``;
4. checks the platform's limits (duration, size, aspect) and refuses clearly
   when the video cannot be posted there, naming the channel's Short when one
   was cut from it;
5. builds the platform's caption from the video's own metadata
   (``modules/social_captions.py`` — deterministic, no model call);
6. uploads through the platform adapter below, polls until the platform says
   it is done, and records the post id / URL — or the failure, as a reason
   word plus our own short detail (HTTP status, platform error code; never a
   token or a response body).

Uploading costs the platforms nothing, so no credits are held or charged.

YouTube targets: the target must not be the video's own channel (the pipeline
already uploaded it there — ``already_on_channel``), must be ACTIVE and
connected (``publish_channel_connected``, the same rule as the account panel).
The master is uploaded with ``modules/youtube_uploader.py`` — the pipeline's
own uploader, bound to that channel and verified against its YouTube id —
always PRIVATE; nothing here makes a video public or changes an existing
video's privacy. Title ≤ 100 characters, description ≤ 5000 bytes, tags ≤ 500
characters (``social_captions.youtube_metadata``). A quota error is recorded
as ``quota_exceeded``.

Platform references (official docs):

* Instagram API with Instagram Login — content publishing (Reels):
  https://developers.facebook.com/docs/instagram-platform/content-publishing/
  POST /<IG_ID>/media (media_type=REELS, video_url, caption) → container id;
  GET /<container>?fields=status_code until FINISHED;
  POST /<IG_ID>/media_publish (creation_id) → media id;
  GET /<media>?fields=permalink. Instagram fetches ``video_url`` itself, so
  the master is staged in a private Supabase Storage bucket and handed over
  as a short-lived signed URL, deleted afterwards.
  Reels: 3 s – 15 min, ≤ 300 MB, aspect ratio between 0.01:1 and 10:1.
* TikTok Content Posting API — Direct Post, FILE_UPLOAD:
  https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
  https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
  POST /v2/post/publish/creator_info/query/ → privacy options, max duration;
  POST /v2/post/publish/video/init/ → publish_id, upload_url;
  PUT the file in chunks (5–64 MB each, the last up to 128 MB; a file under
  64 MB goes whole); POST /v2/post/publish/status/fetch/ until
  PUBLISH_COMPLETE or FAILED. An app that has not passed TikTok's audit can
  only post SELF_ONLY (private), so this adapter always posts SELF_ONLY — the
  same "private by default" rule as YouTube uploads.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Callable, Mapping, Optional

from modules import social_captions
from modules import social_tokens

logger = logging.getLogger(__name__)

IG_GRAPH = "https://graph.instagram.com/v23.0"
TT_API = "https://open.tiktokapis.com/v2/post/publish"
STAGING_BUCKET = "publish-staging"
STAGING_URL_SECONDS = 3600

IG_MIN_SECONDS = 3.0
IG_MAX_SECONDS = 15 * 60.0
IG_MAX_BYTES = 300 * 1024 * 1024
IG_MIN_ASPECT = 0.01
IG_MAX_ASPECT = 10.0

TT_MIN_SECONDS = 3.0
TT_DEFAULT_MAX_SECONDS = 600.0
TT_MAX_BYTES = 4 * 1024 * 1024 * 1024
TT_SINGLE_CHUNK_MAX = 64 * 1024 * 1024
TT_CHUNK = 10 * 1024 * 1024
TT_PRIVACY = "SELF_ONLY"
YT_PRIVACY = "private"
YT_WATCH = "https://www.youtube.com/watch?v="
_YT_QUOTA = {"quotaExceeded", "dailyLimitExceeded", "uploadLimitExceeded"}
_YT_RATE = {"rateLimitExceeded", "userRateLimitExceeded"}
_YT_AUTH = {"authError", "unauthorized", "forbidden_token"}

POLL_SECONDS = 10.0
MAX_WAIT_SECONDS = 20 * 60.0


class PublishStop(Exception):
    """End a request: ``status`` refused|failed, a reason word, our own detail."""

    def __init__(self, status: str, reason: str, detail: str = ""):
        super().__init__(reason)
        self.status = status
        self.reason = reason
        self.detail = detail[:500]


def refused(reason: str, detail: str = "") -> PublishStop:
    return PublishStop("refused", reason, detail)


def failed(reason: str, detail: str = "") -> PublishStop:
    return PublishStop("failed", reason, detail)


# ── Supabase (service key) ───────────────────────────────────────────────────


class PublishStore:
    """publish_requests, videos and the staging bucket over Supabase REST."""

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
            return None  # 0029 not applied: nothing to do
        if r.status_code >= 300:
            raise RuntimeError(f"{name}: HTTP {r.status_code}")
        return r.json()

    def claim(self, worker_id: str) -> Optional[dict]:
        rows = self._rpc("claim_publish_request", {"p_worker": worker_id})
        if isinstance(rows, dict):
            rows = [rows]
        return rows[0] if rows else None

    def refusal(self, video_id: str) -> Optional[str]:
        out = self._rpc("publish_request_refusal", {"p_video_id": video_id})
        return out if isinstance(out, str) and out else None

    def _select_one(self, table: str, select: str, **eq) -> Optional[dict]:
        params = {"select": select, "limit": "1"}
        params.update({k: f"eq.{v}" for k, v in eq.items()})
        r = self.http().get(f"{self.url}/rest/v1/{table}", params=params, headers=self._h(), timeout=self._timeout)
        if r.status_code >= 300:
            raise RuntimeError(f"{table}: HTTP {r.status_code}")
        rows = r.json() or []
        return rows[0] if rows else None

    def video(self, video_id: str) -> Optional[dict]:
        return self._select_one("videos", "video_id,channel_id,title,topic,slug,local_path,video_format,"
                                          "parent_video_id,scenes,manifest", video_id=video_id)

    def channel(self, channel_id: str) -> Optional[dict]:
        return self._select_one("channels", "channel_id,niche,status", channel_id=channel_id)

    def channel_connected(self, channel_id: str) -> bool:
        """publish_channel_connected — the rule the insert trigger used."""
        return self._rpc("publish_channel_connected", {"p_channel_id": channel_id}) is True

    def short_of(self, video_id: str) -> Optional[str]:
        row = self._select_one("videos", "video_id", parent_video_id=video_id, video_format="short")
        return str(row["video_id"]) if row else None

    def update(self, request_id, worker_id: str, values: dict) -> None:
        body = dict(values)
        body["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        r = self.http().patch(f"{self.url}/rest/v1/publish_requests",
                              params={"id": f"eq.{request_id}", "worker_id": f"eq.{worker_id}"},
                              json=body, headers=self._h({"Content-Type": "application/json",
                                                          "Prefer": "return=minimal"}),
                              timeout=self._timeout)
        if r.status_code >= 300:
            logger.warning("publish request %s: status update failed (HTTP %s)", request_id, r.status_code)

    # staging for Instagram's video_url
    def stage(self, path: Path, name: str) -> None:
        with open(path, "rb") as fh:
            r = self.http().post(f"{self.url}/storage/v1/object/{STAGING_BUCKET}/{name}", data=fh,
                                 headers=self._h({"Content-Type": "video/mp4", "x-upsert": "true"}),
                                 timeout=900)
        if r.status_code >= 300:
            raise failed("staging_failed",
                         f"could not stage the video for Instagram (storage HTTP {r.status_code}; "
                         "the project's upload size limit may be lower than the file)")

    def sign(self, name: str, seconds: int = STAGING_URL_SECONDS) -> str:
        r = self.http().post(f"{self.url}/storage/v1/object/sign/{STAGING_BUCKET}/{name}",
                             json={"expiresIn": int(seconds)},
                             headers=self._h({"Content-Type": "application/json"}), timeout=self._timeout)
        if r.status_code >= 300:
            raise failed("staging_failed", f"could not sign the staged video (storage HTTP {r.status_code})")
        signed = (r.json() or {}).get("signedURL") or (r.json() or {}).get("signedUrl") or ""
        if not signed:
            raise failed("staging_failed", "storage returned no signed URL")
        return signed if signed.startswith("https://") else f"{self.url}/storage/v1{signed}"

    def unstage(self, name: str) -> None:
        try:
            self.http().delete(f"{self.url}/storage/v1/object/{STAGING_BUCKET}",
                               json={"prefixes": [name]},
                               headers=self._h({"Content-Type": "application/json"}), timeout=self._timeout)
        except Exception as e:  # best effort; the object is private either way
            logger.warning("staged object %s not deleted (%s)", name, type(e).__name__)


# ── the video file ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class VideoInfo:
    duration: Optional[float]
    width: Optional[int]
    height: Optional[int]
    size: int


def resolve_master(video: Mapping, output_dir: Path) -> Optional[Path]:
    """The master render, only when it is a file inside ``output_dir`` (a path
    from the database is never trusted to point anywhere else)."""
    raw = str(video.get("local_path") or "").strip()
    if not raw:
        return None
    root = Path(output_dir).resolve()
    p = Path(raw)
    candidates = [p] if p.is_absolute() else [root / p, root.parent / p]
    # A run elsewhere (Actions) stored its own absolute path: try the same
    # relative tail under this worker's output/.
    if p.is_absolute() and "output" in p.parts:
        tail = p.parts[p.parts.index("output") + 1:]
        if tail:
            candidates.append(root.joinpath(*tail))
    for c in candidates:
        try:
            r = c.resolve()
        except OSError:
            continue
        if (r == root or root in r.parents) and r.is_file():
            return r
    return None


def _ffmpeg() -> Optional[str]:
    try:
        import imageio_ffmpeg  # noqa: PLC0415

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


def probe(path: Path) -> VideoInfo:
    """Duration and frame size from ``ffmpeg -i`` (no ffprobe dependency)."""
    size = path.stat().st_size
    exe = _ffmpeg()
    if not exe:
        return VideoInfo(None, None, None, size)
    try:
        proc = subprocess.run([exe, "-hide_banner", "-i", str(path)], capture_output=True, text=True, timeout=60)
        text = proc.stderr or ""
    except Exception:
        return VideoInfo(None, None, None, size)
    dur = None
    m = re.search(r"Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)", text)
    if m:
        dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    w = h = None
    m = re.search(r"Video:.*?\b(\d{2,5})x(\d{2,5})\b", text)
    if m:
        w, h = int(m.group(1)), int(m.group(2))
    return VideoInfo(dur, w, h, size)


def _mmss(seconds: float) -> str:
    s = int(round(seconds))
    return f"{s // 60}:{s % 60:02d}"


def check_format(platform: str, info: VideoInfo, *, short_id: Optional[str] = None,
                 max_seconds: Optional[float] = None) -> None:
    """Refuse (raise) when the platform cannot take this file, with a reason
    the panel shows. ``max_seconds`` is TikTok's per-creator limit."""
    hint = f"; publish its Short ({short_id}) there instead" if short_id else \
        "; a vertical Short cut of it can be posted instead"
    name = "Instagram Reels" if platform == "instagram" else "TikTok"
    lo = IG_MIN_SECONDS if platform == "instagram" else TT_MIN_SECONDS
    hi = IG_MAX_SECONDS if platform == "instagram" else float(max_seconds or TT_DEFAULT_MAX_SECONDS)
    cap = IG_MAX_BYTES if platform == "instagram" else TT_MAX_BYTES
    if info.duration is None:
        raise refused("unknown_duration", "could not read the video's duration")
    if info.duration > hi:
        raise refused("too_long", f"the video is {_mmss(info.duration)}; {name} allows at most {_mmss(hi)}{hint}")
    if info.duration < lo:
        raise refused("too_short", f"the video is {info.duration:.1f}s; {name} needs at least {lo:.0f}s")
    if info.size > cap:
        raise refused("too_large", f"the video is {info.size / 1048576:.0f} MB; {name} allows at most "
                                   f"{cap / 1048576:.0f} MB{hint}")
    if platform == "instagram" and info.width and info.height:
        ratio = info.width / info.height
        if not IG_MIN_ASPECT <= ratio <= IG_MAX_ASPECT:
            raise refused("bad_aspect", f"aspect ratio {info.width}x{info.height} is outside what Reels accept")


def load_source_meta(video: Mapping, channel: Optional[Mapping], output_dir: Path) -> social_captions.SourceMeta:
    """The words the pipeline already has: the published title, the script's
    description and tags (``output/<slug>/script.json``), the channel niche."""
    description, tags, script_title = "", [], ""
    slug = str(video.get("slug") or "")
    if slug and re.fullmatch(r"[A-Za-z0-9._-]{1,200}", slug):
        path = Path(output_dir) / slug / "script.json"
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(doc, dict):
                description = str(doc.get("description") or "")
                tags = [str(t) for t in (doc.get("tags") or []) if isinstance(t, (str, int))]
                script_title = str(doc.get("title") or "")
        except (OSError, ValueError):
            pass
    return social_captions.SourceMeta(
        title=str(video.get("title") or script_title or video.get("topic") or ""),
        description=description,
        tags=tuple(tags),
        niche=str((channel or {}).get("niche") or ""),
        topic=str(video.get("topic") or ""),
    )


# ── platform adapters ────────────────────────────────────────────────────────


def _json(r) -> dict:
    try:
        body = r.json()
        return body if isinstance(body, dict) else {}
    except Exception:
        return {}


def _ig_error(what: str, r) -> PublishStop:
    err = _json(r).get("error") or {}
    code = err.get("code") if isinstance(err, dict) else None
    sub = err.get("error_subcode") if isinstance(err, dict) else None
    parts = [f"HTTP {getattr(r, 'status_code', 0)}"]
    if isinstance(code, int):
        parts.append(f"code {code}")
    if isinstance(sub, int):
        parts.append(f"subcode {sub}")
    reason = "token_expired" if code == 190 else "rate_limited" if code in (4, 9, 17, 32, 613) else "platform_error"
    return failed(reason, f"instagram {what}: {', '.join(parts)}")


class InstagramAdapter:
    def __init__(self, http, store: PublishStore, *, sleep: Callable[[float], None] = time.sleep,
                 heartbeat: Callable[[], None] = lambda: None, poll_seconds: float = POLL_SECONDS,
                 max_wait: float = MAX_WAIT_SECONDS):
        self.http, self.store, self.sleep, self.heartbeat = http, store, sleep, heartbeat
        self.poll_seconds, self.max_wait = poll_seconds, max_wait

    def publish(self, tok: social_tokens.SocialToken, path: Path, caption: str, staging_name: str) -> dict:
        self.store.stage(path, staging_name)
        try:
            video_url = self.store.sign(staging_name)
            r = self.http.post(f"{IG_GRAPH}/{tok.external_id}/media", data={
                "media_type": "REELS", "video_url": video_url, "caption": caption,
                "share_to_feed": "true", "access_token": tok.access_token,
            }, timeout=60)
            if r.status_code >= 300:
                raise _ig_error("create container", r)
            container = str(_json(r).get("id") or "")
            if not container:
                raise failed("platform_error", "instagram create container: no id returned")

            waited = 0.0
            while True:
                s = self.http.get(f"{IG_GRAPH}/{container}", params={
                    "fields": "status_code", "access_token": tok.access_token}, timeout=30)
                if s.status_code >= 300:
                    raise _ig_error("container status", s)
                code = str(_json(s).get("status_code") or "")
                if code == "FINISHED":
                    break
                if code in ("ERROR", "EXPIRED"):
                    raise failed("processing_failed", f"instagram processing ended with {code}")
                if waited >= self.max_wait:
                    raise failed("timeout", f"instagram still processing after {int(waited)}s")
                self.heartbeat()
                self.sleep(self.poll_seconds)
                waited += self.poll_seconds

            p = self.http.post(f"{IG_GRAPH}/{tok.external_id}/media_publish", data={
                "creation_id": container, "access_token": tok.access_token}, timeout=60)
            if p.status_code >= 300:
                raise _ig_error("publish", p)
            media_id = str(_json(p).get("id") or "")
            if not media_id:
                raise failed("platform_error", "instagram publish: no media id returned")
            url = None
            try:
                g = self.http.get(f"{IG_GRAPH}/{media_id}", params={
                    "fields": "permalink", "access_token": tok.access_token}, timeout=30)
                link = str(_json(g).get("permalink") or "")
                url = link if link.startswith("https://") else None
            except Exception:
                url = None
            return {"result_id": media_id, "result_url": url, "privacy": None}
        finally:
            self.store.unstage(staging_name)


def _tt_error(what: str, r) -> PublishStop:
    err = _json(r).get("error") or {}
    code = str(err.get("code") or "") if isinstance(err, dict) else ""
    code = code if re.fullmatch(r"[a-z0-9_]{1,64}", code or "") else ""
    reason = ("token_expired" if code in ("access_token_invalid", "scope_not_authorized")
              else "rate_limited" if code in ("rate_limit_exceeded", "spam_risk_too_many_posts",
                                              "spam_risk_user_banned_from_posting")
              else "platform_error")
    return failed(reason, f"tiktok {what}: HTTP {getattr(r, 'status_code', 0)}" + (f", {code}" if code else ""))


def _tt_ok(r) -> bool:
    if getattr(r, "status_code", 0) >= 300:
        return False
    err = _json(r).get("error") or {}
    return not isinstance(err, dict) or str(err.get("code") or "ok") == "ok"


def tiktok_chunks(size: int) -> tuple:
    """(chunk_size, total_chunk_count) per TikTok's media transfer rules."""
    if size <= TT_SINGLE_CHUNK_MAX:
        return size, 1
    return TT_CHUNK, size // TT_CHUNK


class TiktokAdapter:
    def __init__(self, http, *, sleep: Callable[[float], None] = time.sleep,
                 heartbeat: Callable[[], None] = lambda: None, poll_seconds: float = POLL_SECONDS,
                 max_wait: float = MAX_WAIT_SECONDS):
        self.http, self.sleep, self.heartbeat = http, sleep, heartbeat
        self.poll_seconds, self.max_wait = poll_seconds, max_wait

    def _h(self, tok) -> dict:
        return {"Authorization": f"Bearer {tok.access_token}", "Content-Type": "application/json; charset=UTF-8"}

    def creator_info(self, tok) -> dict:
        r = self.http.post(f"{TT_API}/creator_info/query/", headers=self._h(tok), json={}, timeout=30)
        if not _tt_ok(r):
            raise _tt_error("creator info", r)
        return _json(r).get("data") or {}

    def publish(self, tok, path: Path, caption: str, info: dict) -> dict:
        options = info.get("privacy_level_options") or []
        if options and TT_PRIVACY not in options:
            raise refused("privacy_unavailable", "this TikTok account does not offer private (SELF_ONLY) posts")
        size = path.stat().st_size
        chunk, total = tiktok_chunks(size)
        r = self.http.post(f"{TT_API}/video/init/", headers=self._h(tok), json={
            "post_info": {
                "title": caption,
                "privacy_level": TT_PRIVACY,
                "disable_comment": bool(info.get("comment_disabled")),
                "disable_duet": bool(info.get("duet_disabled")),
                "disable_stitch": bool(info.get("stitch_disabled")),
            },
            "source_info": {"source": "FILE_UPLOAD", "video_size": size,
                            "chunk_size": chunk, "total_chunk_count": total},
        }, timeout=60)
        if not _tt_ok(r):
            raise _tt_error("init", r)
        data = _json(r).get("data") or {}
        publish_id = str(data.get("publish_id") or "")
        upload_url = str(data.get("upload_url") or "")
        if not publish_id or not upload_url.startswith("https://"):
            raise failed("platform_error", "tiktok init: no publish id / upload URL returned")

        with open(path, "rb") as fh:
            for i in range(total):
                start = i * chunk
                end = size - 1 if i == total - 1 else start + chunk - 1
                fh.seek(start)
                body = fh.read(end - start + 1)
                u = self.http.put(upload_url, data=body, headers={
                    "Content-Type": "video/mp4",
                    "Content-Length": str(len(body)),
                    "Content-Range": f"bytes {start}-{end}/{size}",
                }, timeout=600)
                if getattr(u, "status_code", 0) >= 300:
                    raise failed("upload_failed", f"tiktok chunk {i + 1}/{total}: HTTP {u.status_code}")
                self.heartbeat()

        waited = 0.0
        while True:
            s = self.http.post(f"{TT_API}/status/fetch/", headers=self._h(tok),
                               json={"publish_id": publish_id}, timeout=30)
            if not _tt_ok(s):
                raise _tt_error("status", s)
            d = _json(s).get("data") or {}
            status = str(d.get("status") or "")
            if status == "PUBLISH_COMPLETE":
                ids = d.get("publicaly_available_post_id") or []
                post = str(ids[0]) if ids else ""
                return {"result_id": post or publish_id, "result_url": None, "privacy": TT_PRIVACY}
            if status == "FAILED":
                why = str(d.get("fail_reason") or "")
                why = why if re.fullmatch(r"[a-z0-9_]{1,64}", why) else "unknown"
                raise failed("processing_failed", f"tiktok processing failed: {why}")
            if waited >= self.max_wait:
                raise failed("timeout", f"tiktok still processing after {int(waited)}s")
            self.heartbeat()
            self.sleep(self.poll_seconds)
            waited += self.poll_seconds


def _yt_reasons(exc) -> list:
    """The error reason WORDS of a googleapiclient HttpError (e.g.
    quotaExceeded) — never its message or body."""
    reasons = []
    details = getattr(exc, "error_details", None)
    if isinstance(details, list):
        reasons += [d.get("reason") for d in details if isinstance(d, dict)]
    if not reasons:
        try:
            content = getattr(exc, "content", b"") or b""
            doc = json.loads(content.decode("utf-8") if isinstance(content, bytes) else str(content))
            errs = ((doc or {}).get("error") or {}).get("errors") or []
            reasons += [e.get("reason") for e in errs if isinstance(e, dict)]
        except Exception:
            pass
    return [r for r in reasons if isinstance(r, str) and re.fullmatch(r"[A-Za-z_]{1,64}", r)]


def _yt_error(what: str, exc) -> PublishStop:
    from modules import upload_idempotency  # noqa: PLC0415

    status = upload_idempotency.http_status(exc)
    reasons = _yt_reasons(exc)
    words = set(reasons)
    detail = f"youtube {what}: " + (f"HTTP {status}" if status else type(exc).__name__)
    if reasons:
        detail += f", {reasons[0]}"
    if words & _YT_QUOTA:
        return failed("quota_exceeded", detail + " — the YouTube upload quota is used up; send again tomorrow")
    if words & _YT_RATE or status == 429:
        return failed("rate_limited", detail)
    if status == 401 or words & _YT_AUTH or type(exc).__name__ == "RefreshError":
        return failed("token_expired", detail + " — reconnect the channel")
    if upload_idempotency.is_ambiguous(exc):
        return failed("upload_failed", detail + " — the outcome is unknown; check the channel before sending again")
    return failed("platform_error", detail)


class YoutubeAdapter:
    """Uploads the master to ANOTHER of the organization's YouTube channels,
    private, with the pipeline's own uploader.

    ``credentials(channel_id)`` returns ``(token_json, channel_context)`` —
    tools/queue_worker.py resolves them the way a render run does (never
    another channel's token). ``uploader_factory`` is
    ``YouTubeUploader.from_token_json`` (injectable for tests)."""

    def __init__(self, credentials: Callable[[str], tuple], *, uploader_factory: Optional[Callable] = None,
                 heartbeat: Callable[[], None] = lambda: None, heartbeat_seconds: float = 60.0):
        self.credentials = credentials
        self.uploader_factory = uploader_factory
        self.heartbeat = heartbeat
        self.heartbeat_seconds = heartbeat_seconds

    def _factory(self):
        if self.uploader_factory is not None:
            return self.uploader_factory
        from modules.youtube_uploader import YouTubeUploader  # noqa: PLC0415 — google libs only when needed

        return YouTubeUploader.from_token_json

    def publish(self, channel_id: str, path: Path, meta: social_captions.YouTubeMeta) -> dict:
        from modules import channel_tokens  # noqa: PLC0415

        try:
            token_json, channel = self.credentials(channel_id)
        except channel_tokens.ChannelTokenError as e:
            raise failed("token_expired", str(e)) from None
        except (KeyError, ValueError):
            raise refused("account_not_connected",
                          "the channel is unknown or has not been confirmed against YouTube") from None
        if not token_json:
            raise refused("account_not_connected", "this worker has no YouTube token for the channel")
        try:
            uploader = self._factory()(token_json, channel)
        except ValueError:
            raise refused("account_not_connected",
                          "the channel's token cannot reach its YouTube channel — reconnect it") from None
        except Exception as e:
            raise _yt_error("sign-in", e) from None

        script = SimpleNamespace(title=meta.title, description=meta.description, tags=list(meta.tags),
                                 sections=None)
        done = threading.Event()

        def beat():
            while not done.wait(self.heartbeat_seconds):
                try:
                    self.heartbeat()
                except Exception:
                    pass

        t = threading.Thread(target=beat, daemon=True)
        t.start()
        try:
            out = uploader.upload(path, script, privacy=YT_PRIVACY)
        except Exception as e:
            raise _yt_error("upload", e) from None
        finally:
            done.set()
            t.join(timeout=5)
        vid = str((out or {}).get("id") or "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{6,64}", vid):
            raise failed("platform_error", "youtube upload: no video id returned")
        return {"result_id": vid, "result_url": YT_WATCH + vid, "privacy": YT_PRIVACY}


# ── one request ──────────────────────────────────────────────────────────────


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _process_youtube(req: Mapping, video: Mapping, target: str, *, store: PublishStore, worker_id: str,
                     output_dir: Path, youtube: Optional[YoutubeAdapter], heartbeat: Callable[[], None]) -> str:
    """The YouTube half of process_request (raises PublishStop; the caller
    records it). Uploads a NEW private video to ``target``."""
    rid = req.get("id")
    if not target:
        raise refused("account_not_connected", "the request names no YouTube channel")
    # The pipeline already put it on its own channel; this never touches that.
    if target == str(video.get("channel_id") or ""):
        raise refused("already_on_channel")
    ch = store.channel(target)
    if not ch or str(ch.get("status") or "").strip().upper() != "ACTIVE":
        raise refused("account_not_connected", "the channel is paused")
    if not store.channel_connected(target):
        raise refused("account_not_connected")
    if youtube is None:
        raise failed("platform_error", "this worker is not set up to upload to YouTube")

    path = resolve_master(video, output_dir)
    if path is None:
        raise refused("master_not_available",
                      "the full-quality render is not on this worker (only the 480p review copy is "
                      "kept); re-run the video on the queue worker to post it")
    source = None
    try:
        source = store.channel(str(video.get("channel_id") or ""))
    except Exception:
        source = None
    meta = social_captions.youtube_metadata(load_source_meta(video, source, output_dir),
                                            fallback_title=str(video.get("video_id") or ""))
    store.update(rid, worker_id, {"status": "processing", "caption": social_captions.youtube_record(meta),
                                  "privacy": YT_PRIVACY})
    youtube.heartbeat = heartbeat
    result = youtube.publish(target, path, meta)
    store.update(rid, worker_id, {
        "status": "published", "reason": None, "error": None,
        "result_id": result.get("result_id"), "result_url": result.get("result_url"),
        "privacy": YT_PRIVACY, "finished_at": _now(),
    })
    logger.info("publish request %s: uploaded privately to YouTube channel %s", rid, target)
    return "published"


def process_request(req: Mapping, *, store: PublishStore, tokens: social_tokens.SocialTokenClient,
                    worker_id: str, output_dir: Path, http=None, env: Optional[Mapping[str, str]] = None,
                    sleep: Callable[[float], None] = time.sleep,
                    probe_fn: Callable[[Path], VideoInfo] = probe,
                    youtube: Optional[YoutubeAdapter] = None) -> str:
    """Carry one claimed request to published | failed | refused. Never raises."""
    rid = req.get("id")
    platform = str(req.get("platform") or "")
    video_id = str(req.get("video_id") or "")
    account_id = str(req.get("account_id") or "")
    target_channel = str(req.get("target_channel_id") or "")
    http = http or store.http()
    env = os.environ if env is None else env

    def heartbeat():
        store.update(rid, worker_id, {"heartbeat_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})

    try:
        if platform not in ("instagram", "tiktok", "youtube"):
            raise refused("unknown_platform")
        # The gate + approvals, again, right before anything leaves this machine.
        why = store.refusal(video_id)
        if why:
            raise refused(why)
        video = store.video(video_id)
        if not video:
            raise refused("video_not_found")
        if platform == "youtube":
            return _process_youtube(req, video, target_channel, store=store, worker_id=worker_id,
                                    output_dir=output_dir, youtube=youtube, heartbeat=heartbeat)

        tok = tokens.read(account_id)
        if tok is None:
            raise refused("account_not_connected")
        if tok.platform != platform:
            raise refused("account_not_connected", "the account's platform changed")
        try:
            tok = social_tokens.ensure_fresh(tok, tokens, http=http, env=env)
        except social_tokens.SocialTokenError as e:
            raise failed("token_expired", str(e)) from None

        path = resolve_master(video, output_dir)
        if path is None:
            raise refused("master_not_available",
                          "the full-quality render is not on this worker (only the 480p review copy is "
                          "kept); re-run the video on the queue worker to post it")
        info = probe_fn(path)
        short_id = None
        if str(video.get("video_format") or "long") != "short":
            try:
                short_id = store.short_of(video_id)
            except Exception:
                short_id = None

        tt_info: dict = {}
        tiktok = TiktokAdapter(http, sleep=sleep, heartbeat=heartbeat)
        if platform == "tiktok":
            tt_info = tiktok.creator_info(tok)
            check_format(platform, info, short_id=short_id,
                         max_seconds=tt_info.get("max_video_post_duration_sec") or None)
        else:
            check_format(platform, info, short_id=short_id)

        channel = None
        try:
            channel = store.channel(str(video.get("channel_id") or ""))
        except Exception:
            channel = None
        caption = social_captions.caption_for(platform, load_source_meta(video, channel, output_dir))
        store.update(rid, worker_id, {"status": "processing", "caption": caption})

        if platform == "instagram":
            staging = f"{req.get('org_id') or 'org'}/{rid}.mp4"
            result = InstagramAdapter(http, store, sleep=sleep, heartbeat=heartbeat).publish(tok, path, caption, staging)
        else:
            result = tiktok.publish(tok, path, caption, tt_info)

        store.update(rid, worker_id, {
            "status": "published", "reason": None, "error": None,
            "result_id": result.get("result_id"), "result_url": result.get("result_url"),
            "privacy": result.get("privacy"),
            "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        logger.info("publish request %s: published to %s account %s", rid, platform, account_id)
        return "published"
    except PublishStop as stop:
        store.update(rid, worker_id, {
            "status": stop.status, "reason": stop.reason, "error": stop.detail or None,
            "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        logger.info("publish request %s: %s (%s)", rid, stop.status, stop.reason)
        return stop.status
    except Exception as e:  # anything unforeseen: the type only
        store.update(rid, worker_id, {
            "status": "failed", "reason": "worker_error", "error": f"worker error ({type(e).__name__})",
            "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        logger.warning("publish request %s: failed (%s)", rid, type(e).__name__)
        return "failed"


class SocialPublisher:
    """What the queue worker calls between render jobs."""

    def __init__(self, url: str, service_key: str, *, output_dir: Path, worker_id: str,
                 env: Optional[Mapping[str, str]] = None, store: Optional[PublishStore] = None,
                 tokens: Optional[social_tokens.SocialTokenClient] = None,
                 youtube_credentials: Optional[Callable[[str], tuple]] = None):
        self.store = store or PublishStore(url, service_key)
        # (token_json, ChannelContext) for a YouTube target, resolved by the
        # queue worker exactly as for a render run. None = no YouTube uploads.
        self.youtube_credentials = youtube_credentials
        self.tokens = tokens or social_tokens.SocialTokenClient(url, service_key)
        self.output_dir = Path(output_dir)
        self.worker_id = worker_id
        self.env = env
        self._warned = False

    def run_once(self) -> bool:
        """Claim and process at most one request. True when one was handled."""
        try:
            req = self.store.claim(self.worker_id)
        except Exception as e:
            if not self._warned:
                logger.warning("publish queue unavailable (%s)", str(e) if isinstance(e, RuntimeError)
                               else type(e).__name__)
                self._warned = True
            return False
        if not req:
            return False
        youtube = YoutubeAdapter(self.youtube_credentials) if self.youtube_credentials else None
        process_request(req, store=self.store, tokens=self.tokens, worker_id=self.worker_id,
                        output_dir=self.output_dir, env=self.env, youtube=youtube)
        return True


__all__ = [
    "PublishStore", "SocialPublisher", "process_request", "check_format", "resolve_master",
    "load_source_meta", "tiktok_chunks", "InstagramAdapter", "TiktokAdapter", "YoutubeAdapter", "VideoInfo",
]
