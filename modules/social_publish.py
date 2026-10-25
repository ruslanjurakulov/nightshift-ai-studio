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

The steps above are the same for every platform; what differs (connect, check,
compose, publish) is a ``Publisher`` registered in ``modules/publishers.py``
(``InstagramPublisher``, ``TiktokPublisher``, ``YoutubePublisher``, and the dark ``XPublisher`` below). A
platform that is not registered is refused as ``unknown_platform``.

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

import dataclasses
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

from modules import ai_disclosure
from modules import publishers
from modules import social_captions
from modules import social_probe
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

#: X video posts (media_category ``tweet_video``): the default account may post up to 20 minutes (Premium: 125). X's page
#: gives 8 GB; X_MAX_BYTES is OUR hard cap (512 MB was X's long-standing documented figure), checked before the upload and
#: again as the file is read. X_MIN_SECONDS is ours too (the older v1.1 page said 0.5 s).
X_MIN_SECONDS = 1.0
X_MAX_SECONDS = 20 * 60.0
X_MAX_BYTES = 512 * 1024 * 1024

TT_MIN_SECONDS = 3.0
TT_DEFAULT_MAX_SECONDS = 600.0
TT_MAX_BYTES = 4 * 1024 * 1024 * 1024
TT_SINGLE_CHUNK_MAX = 64 * 1024 * 1024
TT_CHUNK = 10 * 1024 * 1024
TT_PRIVACY = "SELF_ONLY"
#: TikTok's error code (HTTP 403, /video/init/) for an unaudited app posting to a non-private account, and the
#: closed reason word the panel has a sentence for.
TT_UNAUDITED_CODE = "unaudited_client_can_only_post_to_private_accounts"
TT_UNAUDITED_REASON = "tiktok_unaudited"
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
        return self._select_one("channels", "channel_id,niche,status,agent_config", channel_id=channel_id)

    def disclosure_events(self, video_id: str) -> list:
        """The video's recorded ``video.ai_disclosure`` events (newest first), or
        [] when they cannot be read: a missing record falls back to the manifest
        and must never stop a publish."""
        try:
            r = self.http().get(f"{self.url}/rest/v1/system_events", params={
                "select": "event,ts,metadata", "video_id": f"eq.{video_id}",
                "event": f"eq.{ai_disclosure.EVENT}", "order": "ts.desc", "limit": "5"},
                headers=self._h(), timeout=self._timeout)
            rows = r.json() if r.status_code < 300 else []
            return rows if isinstance(rows, list) else []
        except Exception:
            return []

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
    if platform == "x":
        name, lo, hi, cap = "X", X_MIN_SECONDS, X_MAX_SECONDS, X_MAX_BYTES
    elif platform == "instagram":
        name, lo, hi, cap = "Instagram Reels", IG_MIN_SECONDS, IG_MAX_SECONDS, IG_MAX_BYTES
    else:
        name, lo, hi, cap = "TikTok", TT_MIN_SECONDS, float(max_seconds or TT_DEFAULT_MAX_SECONDS), TT_MAX_BYTES
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


def disclosure_for(video: Mapping, channel: Optional[Mapping], events=(), parent: Optional[Mapping] = None,
                   parent_events=()) -> tuple:
    """``(Decision, basis)`` for a cross-post: the same rule the upload used
    (modules/ai_disclosure.py), applied with the video's own channel's settings.

    Where the facts come from, first that exists:

    1. the ``video.ai_disclosure`` event the run recorded for THIS video at upload
       (it knows about an AI presenter, which no manifest does);
    2. for a Short, the same event of its PARENT video: a Short is cut from the
       long video's own frames, so the answer is the parent's (older Shorts have no
       record of their own);
    3. the stored manifest's generated assets (the video's, else the Short's
       parent's). A manifest cannot show an AI presenter, so a manifest-only
       answer is never "known": it labels, with ``provenance_unknown``, next to
       any generated media it does show (a presenter would be missed otherwise);
    4. nothing: ``known=False``, which labels.

    ``basis`` names the source for the log."""
    from modules.channels import AgentConfig  # noqa: PLC0415

    cfg = channel.get("agent_config") if isinstance(channel, Mapping) else None
    agent = AgentConfig.from_dict(cfg if isinstance(cfg, Mapping) else None)
    signals = ai_disclosure.signals_from_events(events)
    basis = "event"
    if signals is None and parent is not None:
        signals = ai_disclosure.signals_from_events(parent_events)
        basis = "parent_event"
    if signals is None:
        manifest, basis = video.get("manifest"), "manifest"
        if not isinstance(manifest, Mapping) and isinstance(parent, Mapping):
            manifest, basis = parent.get("manifest"), "parent_manifest"
        signals = ai_disclosure.signals_from_manifest(manifest, voice=agent.ai_disclosure_voice)
        if signals.known:
            signals = dataclasses.replace(signals, known=False)  # the presenter cannot be seen in a manifest
            basis += "_presenter_unseen"
        else:
            basis = "unknown"
    return ai_disclosure.decide_for(agent, signals), basis


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

    def publish(self, tok: social_tokens.SocialToken, path: Path, caption: str, staging_name: str,
                ai_generated: bool = False) -> dict:
        self.store.stage(path, staging_name)
        try:
            video_url = self.store.sign(staging_name)
            data = {
                "media_type": "REELS", "video_url": video_url, "caption": caption,
                "share_to_feed": "true", "access_token": tok.access_token,
            }
            if ai_generated:
                # Instagram's self-disclosure of AI use (an optional container parameter). Sent only when the
                # label is true: an absent field is the unlabelled post every Reel has always been.
                data["is_ai_generated"] = "true"
            r = self.http.post(f"{IG_GRAPH}/{tok.external_id}/media", data=data, timeout=60)
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
              else TT_UNAUDITED_REASON if code == TT_UNAUDITED_CODE
              else "platform_error")
    detail = f"tiktok {what}: HTTP {getattr(r, 'status_code', 0)}" + (f", {code}" if code else "")
    if reason == TT_UNAUDITED_REASON:
        # Not retried and not a bug: TikTok (HTTP 403 on /video/init/) takes posts from an unaudited app only for a
        # PRIVATE account. We already ask for SELF_ONLY; the account itself has to be private as well.
        detail += " - make the TikTok account private until the app is audited"
    return failed(reason, detail)


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

    def publish(self, tok, path: Path, caption: str, info: dict, ai_generated: bool = False) -> dict:
        options = info.get("privacy_level_options") or []
        if options and TT_PRIVACY not in options:
            raise refused("privacy_unavailable", "this TikTok account does not offer private (SELF_ONLY) posts")
        size = path.stat().st_size
        chunk, total = tiktok_chunks(size)
        post_info = {
            "title": caption,
            "privacy_level": TT_PRIVACY,
            "disable_comment": bool(info.get("comment_disabled")),
            "disable_duet": bool(info.get("duet_disabled")),
            "disable_stitch": bool(info.get("stitch_disabled")),
        }
        if ai_generated:
            # Direct Post's "is_aigc": TikTok adds its "Creator labeled as AI-generated" tag. Only sent when true.
            post_info["is_aigc"] = True
        r = self.http.post(f"{TT_API}/video/init/", headers=self._h(tok), json={
            "post_info": post_info,
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

    def publish(self, channel_id: str, path: Path, meta: social_captions.YouTubeMeta,
                decision: Optional[ai_disclosure.Decision] = None) -> dict:
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
            # The decision rides along only when it labels the video: an unlabelled upload calls the
            # uploader exactly as before. The line is already in meta.description (youtube_metadata).
            extra = {"ai_disclosure": decision} if decision is not None and decision.label else {}
            out = uploader.upload(path, script, privacy=YT_PRIVACY, **extra)
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


def _decide_disclosure(store, video: Mapping, channel: Optional[Mapping], rid) -> ai_disclosure.Decision:
    """The AI-disclosure decision for this request. Reading the recorded events
    (and, for a Short with no record of its own, its parent video and that
    video's events) is best-effort: nothing here raises, and a missing record
    falls back as ``disclosure_for`` says. The decision is logged as words only."""
    read = getattr(store, "disclosure_events", None)
    events = read(str(video.get("video_id") or "")) if read else []
    parent, parent_events = None, []
    parent_id = str(video.get("parent_video_id") or "")
    if (str(video.get("video_format") or "") == "short" and parent_id
            and ai_disclosure.signals_from_events(events) is None):
        try:
            parent = store.video(parent_id) or {"video_id": parent_id}
        except Exception:
            parent = {"video_id": parent_id}
        parent_events = read(parent_id) if read else []
    decision, basis = disclosure_for(video, channel, events, parent, parent_events)
    logger.info("publish request %s: AI label %s (%s, from %s)", rid, "on" if decision.label else "off",
                ",".join(decision.reasons), basis)
    return decision


# ── the platforms, behind modules/publishers.py ──────────────────────────────
#
# Each class below moved, unchanged, the part of process_request that used to be an ``if platform ...`` branch.
# tests/test_publisher_transcripts.py holds what the old code did; the order of every read and write is part of it.


class _SocialAccountPublisher:
    """What Instagram and TikTok share: a connected account whose token is read and refreshed, the same file probe
    and the same duration / size / layout checks. A subclass names its platform and its adapter."""

    platform = ""

    def __init__(self, ctx: publishers.PublishContext):
        self.ctx = ctx
        self.tok: Optional[social_tokens.SocialToken] = None

    def connect(self) -> None:
        ctx = self.ctx
        tok = ctx.tokens.read(str(ctx.request.get("account_id") or ""))
        if tok is None:
            raise refused("account_not_connected")
        if tok.platform != self.platform:
            raise refused("account_not_connected", "the account's platform changed")
        try:
            self.tok = social_tokens.ensure_fresh(tok, ctx.tokens, http=ctx.http, env=ctx.env)
        except social_tokens.SocialTokenError as e:
            raise failed("token_expired", str(e)) from None

    def check(self, path: Path) -> None:
        ctx = self.ctx
        info = ctx.probe_fn(path)
        short_id = None
        if str(ctx.video.get("video_format") or "long") != "short":
            try:
                short_id = ctx.store.short_of(str(ctx.request.get("video_id") or ""))
            except Exception:
                short_id = None
        self._check_format(info, short_id)
        # Codec, frame rate, size and file layout, from the file itself: refused here, not after a staged upload.
        try:
            social_probe.check_media(self.platform, ctx.media_fn(path))
        except social_probe.ProbeRefusal as e:
            raise refused(e.reason, e.detail) from None

    def _check_format(self, info: VideoInfo, short_id: Optional[str]) -> None:
        check_format(self.platform, info, short_id=short_id)

    def compose(self, meta: social_captions.SourceMeta, decision: ai_disclosure.Decision) -> publishers.PostSpec:
        caption = social_captions.caption_for(self.platform, meta, disclosure=decision.line)
        return publishers.PostSpec(caption=caption, ai_generated=decision.label)

    def describe(self) -> str:
        return f"published to {self.platform} account {self.ctx.request.get('account_id') or ''}"


class InstagramPublisher(_SocialAccountPublisher):
    platform = "instagram"

    def publish(self, path: Path, post: publishers.PostSpec) -> Mapping:
        ctx = self.ctx
        staging = f"{ctx.request.get('org_id') or 'org'}/{ctx.request.get('id')}.mp4"
        # PostSpec.ai_generated -> the container's ``is_ai_generated`` (InstagramAdapter sends it only when true).
        return InstagramAdapter(ctx.http, ctx.store, sleep=ctx.sleep, heartbeat=ctx.heartbeat).publish(
            self.tok, path, post.caption, staging, ai_generated=post.ai_generated)


class TiktokPublisher(_SocialAccountPublisher):
    platform = "tiktok"

    def __init__(self, ctx: publishers.PublishContext):
        super().__init__(ctx)
        self.adapter = TiktokAdapter(ctx.http, sleep=ctx.sleep, heartbeat=ctx.heartbeat)
        self.creator: dict = {}

    def _check_format(self, info: VideoInfo, short_id: Optional[str]) -> None:
        # TikTok's own limit for THIS creator comes from the platform, so it is asked for before the check.
        self.creator = self.adapter.creator_info(self.tok)
        check_format(self.platform, info, short_id=short_id,
                     max_seconds=self.creator.get("max_video_post_duration_sec") or None)

    def publish(self, path: Path, post: publishers.PostSpec) -> Mapping:
        # PostSpec.ai_generated -> Direct Post's ``post_info.is_aigc`` (TiktokAdapter sends it only when true).
        return self.adapter.publish(self.tok, path, post.caption, self.creator, ai_generated=post.ai_generated)


class XPublisher(_SocialAccountPublisher):
    """A video post on X (API v2 chunked media upload, then ``POST /2/tweets``). DARK: registered here, but nothing can
    reach it yet, because ``social_accounts`` / ``publish_requests`` (migrations 0028 / 0029) do not allow the word ``x``
    and there is no connect flow or X developer app. The adapter is ``modules/social_x.py`` (imported when used, so that
    module can import this one). X has no private or draft state: the post is public at once, like Instagram."""

    platform = "x"
    #: Test seam only (a loopback host). Production leaves it empty: the host is fixed in social_x.
    adapter_kwargs: Mapping = {}

    def publish(self, path: Path, post: publishers.PostSpec) -> Mapping:
        from modules import social_x  # noqa: PLC0415 - social_x imports this module

        ctx = self.ctx
        # PostSpec.ai_generated -> the post's ``made_with_ai`` (sent only when true).
        return social_x.XVideoAdapter(
            ctx.http, sleep=ctx.sleep, heartbeat=ctx.heartbeat, **dict(self.adapter_kwargs)).publish(
            self.tok, path, post.caption, ai_generated=post.ai_generated)

    def describe(self) -> str:
        return f"posted to x account {self.ctx.request.get('account_id') or ''}"


class YoutubePublisher:
    """Another channel of the organization, uploaded PRIVATE with the pipeline's own uploader."""

    platform = "youtube"

    def __init__(self, ctx: publishers.PublishContext):
        self.ctx = ctx
        self.target = str(ctx.request.get("target_channel_id") or "")

    def connect(self) -> None:
        ctx, target = self.ctx, self.target
        if not target:
            raise refused("account_not_connected", "the request names no YouTube channel")
        # The pipeline already put it on its own channel; this never touches that.
        if target == str(ctx.video.get("channel_id") or ""):
            raise refused("already_on_channel")
        ch = ctx.store.channel(target)
        if not ch or str(ch.get("status") or "").strip().upper() != "ACTIVE":
            raise refused("account_not_connected", "the channel is paused")
        if not ctx.store.channel_connected(target):
            raise refused("account_not_connected")
        if ctx.youtube is None:
            raise failed("platform_error", "this worker is not set up to upload to YouTube")

    def check(self, path: Path) -> None:
        """Nothing here: the uploader and ``video_qc`` own what YouTube accepts, as for the pipeline's own upload."""

    def compose(self, meta: social_captions.SourceMeta, decision: ai_disclosure.Decision) -> publishers.PostSpec:
        yt = social_captions.youtube_metadata(meta, fallback_title=str(self.ctx.video.get("video_id") or ""),
                                              disclosure=decision.line)
        return publishers.PostSpec(caption=social_captions.youtube_record(yt), ai_generated=decision.label,
                                   privacy=YT_PRIVACY, payload=(yt, decision))

    def publish(self, path: Path, post: publishers.PostSpec) -> Mapping:
        yt, decision = post.payload
        self.ctx.youtube.heartbeat = self.ctx.heartbeat
        # PostSpec.ai_generated -> ``status.containsSyntheticMedia``: the uploader reads it from the decision, which is
        # handed over only when it labels the video (an unlabelled upload calls the uploader exactly as before).
        result = self.ctx.youtube.publish(self.target, path, yt, decision if post.ai_generated else None)
        return {**result, "privacy": YT_PRIVACY}

    def describe(self) -> str:
        return f"uploaded privately to YouTube channel {self.target}"


publishers.register(InstagramPublisher.platform, InstagramPublisher)
publishers.register(TiktokPublisher.platform, TiktokPublisher)
publishers.register(YoutubePublisher.platform, YoutubePublisher)
publishers.register(XPublisher.platform, XPublisher)


def process_request(req: Mapping, *, store: PublishStore, tokens: social_tokens.SocialTokenClient,
                    worker_id: str, output_dir: Path, http=None, env: Optional[Mapping[str, str]] = None,
                    sleep: Callable[[float], None] = time.sleep,
                    probe_fn: Callable[[Path], VideoInfo] = probe,
                    youtube: Optional[YoutubeAdapter] = None,
                    media_fn: Callable[[Path], social_probe.MediaFacts] = social_probe.read_facts) -> str:
    """Carry one claimed request to published | failed | refused. Never raises.

    The sequence is the same for every platform (modules/publishers.py lists it); the platform supplies connect,
    check, compose and publish."""
    rid = req.get("id")
    platform = str(req.get("platform") or "")
    video_id = str(req.get("video_id") or "")
    http = http or store.http()
    env = os.environ if env is None else env

    def heartbeat():
        store.update(rid, worker_id, {"heartbeat_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})

    try:
        factory = publishers.factory_for(platform)
        if factory is None:
            raise refused("unknown_platform")  # no default platform: nothing is read for a word we do not know
        # The gate + approvals, again, right before anything leaves this machine.
        why = store.refusal(video_id)
        if why:
            raise refused(why)
        video = store.video(video_id)
        if not video:
            raise refused("video_not_found")
        publisher = factory(publishers.PublishContext(
            request=req, video=video, store=store, tokens=tokens, worker_id=worker_id, output_dir=output_dir,
            http=http, env=env, sleep=sleep, heartbeat=heartbeat, probe_fn=probe_fn, media_fn=media_fn,
            youtube=youtube))
        publisher.connect()

        path = resolve_master(video, output_dir)
        if path is None:
            raise refused("master_not_available",
                          "the full-quality render is not on this worker (only the 480p review copy is "
                          "kept); re-run the video on the queue worker to post it")
        publisher.check(path)

        channel = None
        try:
            channel = store.channel(str(video.get("channel_id") or ""))
        except Exception:
            channel = None
        decision = _decide_disclosure(store, video, channel, rid)
        post = publisher.compose(load_source_meta(video, channel, output_dir), decision)
        processing = {"status": "processing", "caption": post.caption}
        if post.privacy is not None:
            processing["privacy"] = post.privacy
        store.update(rid, worker_id, processing)

        result = publisher.publish(path, post)

        store.update(rid, worker_id, {
            "status": "published", "reason": None, "error": None,
            "result_id": result.get("result_id"), "result_url": result.get("result_url"),
            "privacy": result.get("privacy"),
            "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        logger.info("publish request %s: %s", rid, publisher.describe())
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
    "InstagramPublisher", "TiktokPublisher", "YoutubePublisher", "XPublisher",
]
