"""The media library's worker side — migration 0038.

Uploads: the Command Center never writes an asset. Its route streams a body
into the ``media_staging`` volume as ``<ticket>.upload`` (a name made of the
ticket's uuid and nothing else) and marks the ticket ``uploaded``. This module,
run by ``tools/media_worker.py``, then for each ticket:

1. measures the staged file itself (the size the browser or the route claimed
   is not trusted) and refuses empty or over-declared files;
2. sniffs the type from the first bytes of the CONTENT (:func:`sniff`) — not
   from the extension and not from the declared type — and refuses anything
   that is not on the allowlist, or whose kind disagrees with the declared
   type or the filename's extension (a PNG called ``clip.mp4`` is refused);
3. ffprobes it with the demuxer FORCED to the sniffed format and only the
   ``file`` protocol allowed, so a playlist or concat script dressed up as
   media cannot make ffmpeg open other files or URLs; confirms the streams
   match the kind (a video has a real video stream, audio has audio);
4. copies it to ``media/<aa>/<uuid>/original`` — the asset id is chosen here,
   and every path is derived from it alone — hashing while copying, and makes
   a JPEG thumbnail (images, video) and a 480p H.264 proxy (video) that any
   browser can play;
5. registers the row (``register_asset``, service role) or rejects the ticket
   with a reason word (``reject_media_upload``), then deletes the staged file.

Deleted assets: ``soft_delete_asset`` (a member) hides the row; the worker
removes ``media/<aa>/<uuid>/`` and ``mark_asset_purged`` gives the bytes back
to the organization's quota.

Nothing secret is logged: ticket / asset ids, reason words and exception types.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Mapping, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

# ── the allowlist (mirrors 0038's media_mime_kind / media_ext_mime) ──────────

#: Allowed MIME type -> kind. SVG, HTML, PDF, archives and executables are
#: absent on purpose. tests/test_media_library.py pins this equal to the SQL.
ALLOWED_MIME: Dict[str, str] = {
    "image/jpeg": "image",
    "image/png": "image",
    "image/webp": "image",
    "image/gif": "image",
    "video/mp4": "video",
    "video/quicktime": "video",
    "video/webm": "video",
    "video/x-matroska": "video",
    "audio/mpeg": "audio",
    "audio/mp4": "audio",
    "audio/wav": "audio",
    "audio/ogg": "audio",
    "audio/flac": "audio",
    "audio/aac": "audio",
    "audio/webm": "audio",
    "text/vtt": "caption",
    "application/x-subrip": "caption",
}

#: Filename extension -> MIME type.
EXT_MIME: Dict[str, str] = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp", "gif": "image/gif",
    "mp4": "video/mp4", "m4v": "video/mp4", "mov": "video/quicktime", "webm": "video/webm",
    "mkv": "video/x-matroska",
    "mp3": "audio/mpeg", "m4a": "audio/mp4", "wav": "audio/wav", "ogg": "audio/ogg", "oga": "audio/ogg",
    "flac": "audio/flac", "aac": "audio/aac",
    "vtt": "text/vtt", "srt": "application/x-subrip",
}

#: The demuxer ffprobe / ffmpeg are forced to for each sniffed type. Forcing it
#: is the point: auto-detection is what lets an .m3u8 or ffconcat script
#: pretend to be a video and pull in other files.
DEMUXER: Dict[str, str] = {
    "image/jpeg": "jpeg_pipe",
    "image/png": "png_pipe",
    "image/webp": "webp_pipe",
    "image/gif": "gif",
    "video/mp4": "mov",
    "video/quicktime": "mov",
    "audio/mp4": "mov",
    "video/webm": "matroska",
    "video/x-matroska": "matroska",
    "audio/webm": "matroska",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/aac": "aac",
}

#: Files an asset may have, and their names inside its directory.
VARIANT_FILES: Dict[str, str] = {"original": "original", "thumb": "thumb.jpg", "proxy": "proxy.mp4"}

CAPTION_MAX_BYTES = 2 * 1024 * 1024
MAX_SIDE = 16384
MAX_DURATION_S = 86400.0
THUMB_SIDE = 480
PROXY_SHORT_SIDE = 480
#: Staged files older than this are debris (a ticket lives at most 24 h in
#: 'uploaded' before the database expires it).
STAGING_MAX_AGE_S = 26 * 3600
PROBE_TIMEOUT_S = 60
THUMB_TIMEOUT_S = 120
PROXY_TIMEOUT_S = 2 * 3600
HEARTBEAT_S = 30.0
COPY_CHUNK = 1024 * 1024

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class StoreUnavailable(Exception):
    """The database could not be reached to record the result. The ticket is
    left as it is (its heartbeat goes stale and the claim sweep hands it out
    again, up to three attempts) and the staged file is kept for that retry."""


class IngestReject(Exception):
    """End a ticket as rejected with a reason word the page can translate."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(reason)
        self.reason = reason
        self.detail = detail[:500]


# ── paths: derived from ids, nothing else ────────────────────────────────────


def canonical_id(value) -> str:
    """A lower-case canonical uuid, or ValueError. Anything with a slash, a
    dot, a NUL or any other character is refused here, before it can reach a
    path."""
    s = str(value or "")
    if not _UUID_RE.match(s):
        raise ValueError("not a canonical uuid")
    return s


def storage_key(asset_id) -> str:
    """``<first two hex chars>/<uuid>`` — the SQL generated column, in Python."""
    aid = canonical_id(asset_id)
    return f"{aid[:2]}/{aid}"


def asset_dir(media_root: Path, asset_id) -> Path:
    return Path(media_root) / storage_key(asset_id)


def asset_file(media_root: Path, asset_id, variant: str) -> Path:
    name = VARIANT_FILES.get(variant)
    if name is None:
        raise ValueError("unknown variant")
    return asset_dir(media_root, asset_id) / name


def staged_path(staging_root: Path, ticket_id) -> Path:
    """``<staging>/<ticket uuid>.upload`` — the name the web route writes."""
    return Path(staging_root) / f"{canonical_id(ticket_id)}.upload"


# ── the type, from the content ───────────────────────────────────────────────

_MP4_AUDIO_BRANDS = {b"M4A ", b"M4B ", b"M4P "}
_SRT_TIME = re.compile(r"^\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[,.]\d{3}")


def sniff(head: bytes) -> Optional[str]:
    """The MIME type the first bytes of a file say it is, or None when it is
    none of the allowed kinds. Order matters: JPEG's FF D8 is checked before
    the MPEG-audio frame sync that also starts with FF."""
    if len(head) < 4:
        return None
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if head[:4] == b"RIFF" and len(head) >= 12:
        if head[8:12] == b"WEBP":
            return "image/webp"
        if head[8:12] == b"WAVE":
            return "audio/wav"
        return None
    if len(head) >= 12 and head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand == b"qt  ":
            return "video/quicktime"
        if brand in _MP4_AUDIO_BRANDS:
            return "audio/mp4"
        return "video/mp4"
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        window = head[:4096]
        if b"webm" in window:
            return "video/webm"
        if b"matroska" in window:
            return "video/x-matroska"
        return None
    if head.startswith(b"OggS"):
        return "audio/ogg"
    if head.startswith(b"fLaC"):
        return "audio/flac"
    if head.startswith(b"ID3"):
        return "audio/mpeg"
    if head[0] == 0xFF and (head[1] & 0xF6) == 0xF0:
        return "audio/aac"  # ADTS: sync + layer 00
    if head[0] == 0xFF and (head[1] & 0xE0) == 0xE0 and (head[1] & 0x06) != 0:
        return "audio/mpeg"  # MPEG audio frame sync, layer I-III
    text = _as_text(head)
    if text is not None:
        body = text.lstrip("﻿")
        if body.startswith("WEBVTT") and (len(body) == 6 or body[6] in " \t\r\n"):
            return "text/vtt"
        lines = [ln.strip() for ln in body.splitlines() if ln.strip()]
        if len(lines) >= 2 and lines[0].isdigit() and _SRT_TIME.match(lines[1]):
            return "application/x-subrip"
    return None


def _as_text(head: bytes) -> Optional[str]:
    if b"\x00" in head:
        return None
    try:
        return head.decode("utf-8")
    except UnicodeDecodeError:
        # The head may end mid-character; retry without the last 3 bytes.
        try:
            return head[:-3].decode("utf-8") if len(head) > 3 else None
        except UnicodeDecodeError:
            return None


def extension_mime(name: str) -> Tuple[bool, Optional[str]]:
    """(has an extension, the type it names or None)."""
    m = re.search(r"\.([A-Za-z0-9]{1,5})$", name or "")
    if not m:
        return False, None
    return True, EXT_MIME.get(m.group(1).lower())


#: Containers whose first bytes cannot say whether they hold a picture: an
#: .m4a is often written with a generic MP4 brand, a sound-only .webm looks
#: like any WebM. For these, ffprobe's streams settle the kind afterwards.
_EITHER_KIND = {"video/mp4": {"video", "audio"}, "video/webm": {"video", "audio"}}


def check_declared(sniffed: str, declared_mime: str, original_name: str) -> None:
    """The content decides the type; the declared type and the extension must
    at least name the same KIND, or it is a spoof and is refused."""
    kinds = _EITHER_KIND.get(sniffed, {ALLOWED_MIME[sniffed]})
    kind = ALLOWED_MIME[sniffed]
    if ALLOWED_MIME.get(declared_mime) not in kinds:
        raise IngestReject("type_mismatch", f"the file is {kind}, not what was declared")
    has_ext, ext_mime = extension_mime(original_name)
    if has_ext and ALLOWED_MIME.get(ext_mime or "") not in kinds:
        raise IngestReject("extension_mismatch", f"the file is {kind}; its name says otherwise")


# ── ffprobe ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Probe:
    kind: str
    mime: str
    width: Optional[int]
    height: Optional[int]
    duration: Optional[float]


def probe_command(exe: str, path: Path, mime: str) -> List[str]:
    return [exe, "-v", "error", "-protocol_whitelist", "file", "-f", DEMUXER[mime],
            "-print_format", "json", "-show_format", "-show_streams", str(path)]


def _num(v) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def interpret_probe(sniffed: str, data: Mapping) -> Probe:
    """Decide the final kind and type from what ffprobe found. Raises
    IngestReject when the streams do not make the file what it claims."""
    streams = [s for s in (data.get("streams") or []) if isinstance(s, Mapping)]
    fmt = data.get("format") if isinstance(data.get("format"), Mapping) else {}
    video = [s for s in streams if s.get("codec_type") == "video"
             and not (s.get("disposition") or {}).get("attached_pic")]
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    duration = _num(fmt.get("duration"))
    kind = ALLOWED_MIME[sniffed]
    mime = sniffed

    if kind == "image":
        if not video:
            raise IngestReject("not_media", "no picture in the image file")
        v = video[0]
        width, height = int(_num(v.get("width")) or 0), int(_num(v.get("height")) or 0)
        if width <= 0 or height <= 0:
            raise IngestReject("not_media", "the image has no size")
        if max(width, height) > MAX_SIDE:
            raise IngestReject("too_large_dimensions", f"{width}x{height} is larger than {MAX_SIDE}px")
        return Probe("image", mime, width, height, None)

    # Containers that hold either: an mp4 / webm with sound only is audio.
    if kind == "video" and not video and audio:
        if sniffed == "video/mp4":
            kind, mime = "audio", "audio/mp4"
        elif sniffed == "video/webm":
            kind, mime = "audio", "audio/webm"
        else:
            raise IngestReject("no_video_stream", "the file has sound but no picture")
    if kind == "audio" and video:
        # An Ogg / MP4-audio file that really carries video: not on the list
        # as a video type (Ogg), or mislabelled — refuse rather than guess.
        raise IngestReject("type_mismatch", "the audio file carries video")

    if duration is None or duration <= 0:
        raise IngestReject("not_media", "the file has no length")
    if duration > MAX_DURATION_S:
        raise IngestReject("too_long", "longer than 24 hours")

    if kind == "video":
        if not video:
            raise IngestReject("no_video_stream", "no picture in the video file")
        v = video[0]
        width, height = int(_num(v.get("width")) or 0), int(_num(v.get("height")) or 0)
        if width <= 0 or height <= 0:
            raise IngestReject("not_media", "the video has no frame size")
        if max(width, height) > MAX_SIDE:
            raise IngestReject("too_large_dimensions", f"{width}x{height} is larger than {MAX_SIDE}px")
        return Probe("video", mime, width, height, round(duration, 3))

    if not audio:
        raise IngestReject("no_audio_stream", "no sound in the audio file")
    return Probe("audio", mime, None, None, round(duration, 3))


def run_probe(exe: str, path: Path, sniffed: str, *, timeout_s: float = PROBE_TIMEOUT_S) -> Probe:
    try:
        proc = subprocess.run(probe_command(exe, path, sniffed), capture_output=True, timeout=timeout_s)
    except subprocess.TimeoutExpired:
        raise IngestReject("probe_failed", "ffprobe took too long") from None
    if proc.returncode != 0:
        raise IngestReject("not_media", "ffprobe could not read the file")
    try:
        data = json.loads(proc.stdout.decode("utf-8", "replace") or "{}")
    except ValueError:
        raise IngestReject("probe_failed", "ffprobe answered something unreadable") from None
    return interpret_probe(sniffed, data if isinstance(data, dict) else {})


def check_caption(path: Path) -> None:
    """A caption file is UTF-8 text, small, with at least one cue."""
    size = path.stat().st_size
    if size > CAPTION_MAX_BYTES:
        raise IngestReject("too_large", "caption files are at most 2 MB")
    raw = path.read_bytes()
    if b"\x00" in raw:
        raise IngestReject("not_media", "the caption file is not text")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise IngestReject("not_media", "the caption file is not UTF-8 text") from None
    if "-->" not in text:
        raise IngestReject("not_media", "the caption file has no cues")


# ── derived files ────────────────────────────────────────────────────────────


def _scale_long_side(limit: int) -> str:
    return (f"scale='if(gte(iw,ih),min({limit},iw),-2)':'if(gte(iw,ih),-2,min({limit},ih))'")


def _scale_short_side(limit: int) -> str:
    return (f"scale='if(gte(iw,ih),-2,min({limit},iw))':'if(gte(iw,ih),min({limit},ih),-2)'")


def thumbnail_command(exe: str, src: Path, dst: Path, mime: str, duration: Optional[float]) -> List[str]:
    argv = [exe, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-protocol_whitelist", "file"]
    if ALLOWED_MIME.get(mime) == "video" and duration:
        argv += ["-ss", f"{min(1.0, duration / 10):.3f}"]
    return argv + ["-f", DEMUXER[mime], "-i", str(src), "-frames:v", "1",
                   "-vf", _scale_long_side(THUMB_SIDE), "-q:v", "4", "-f", "image2", str(dst)]


def proxy_command(exe: str, src: Path, dst: Path, mime: str) -> List[str]:
    return [exe, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-protocol_whitelist", "file",
            "-f", DEMUXER[mime], "-i", str(src),
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", _scale_short_side(PROXY_SHORT_SIDE),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-f", "mp4", str(dst)]


def run_tool(argv: Sequence[str], heartbeat: Callable[[], None], *, timeout_s: float,
             beat_s: float = HEARTBEAT_S) -> int:
    """Run ffmpeg, beating the ticket's heartbeat while it works."""
    proc = subprocess.Popen(list(argv), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    started = time.monotonic()
    while True:
        try:
            return proc.wait(timeout=beat_s)
        except subprocess.TimeoutExpired:
            if time.monotonic() - started > timeout_s:
                proc.kill()
                proc.wait()
                raise IngestReject("timeout", "processing the file took too long") from None
            try:
                heartbeat()
            except Exception:
                pass


def copy_and_hash(src: Path, dst: Path, limit: int) -> Tuple[int, str]:
    """Copy src to dst (created exclusively) while hashing what is written.
    Refuses past ``limit`` bytes: the file on disk is measured, not trusted."""
    h = hashlib.sha256()
    n = 0
    with open(src, "rb") as fin, open(dst, "xb") as fout:
        while True:
            chunk = fin.read(COPY_CHUNK)
            if not chunk:
                break
            n += len(chunk)
            if n > limit:
                raise IngestReject("too_large", "the file is larger than the upload declared")
            h.update(chunk)
            fout.write(chunk)
    return n, h.hexdigest()


# ── Supabase (service key) ───────────────────────────────────────────────────


class MediaStore:
    """media_uploads / media_assets over Supabase REST, through 0038's functions."""

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
            return None  # 0038 not applied: nothing to do
        if r.status_code >= 300:
            raise RuntimeError(f"{name}: HTTP {r.status_code}")
        return r.json()

    def claim(self, worker_id: str) -> Optional[dict]:
        rows = self._rpc("claim_media_upload", {"p_worker": worker_id})
        if isinstance(rows, dict):
            rows = [rows]
        return rows[0] if rows else None

    def reject(self, ticket_id: str, worker_id: str, reason: str, detail: Optional[str]) -> None:
        self._rpc("reject_media_upload", {"p_ticket": ticket_id, "p_worker": worker_id,
                                          "p_reason": reason, "p_error": detail})

    def heartbeat(self, ticket_id: str, worker_id: str) -> None:
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.http().patch(f"{self.url}/rest/v1/media_uploads",
                          params={"id": f"eq.{canonical_id(ticket_id)}", "worker_id": f"eq.{worker_id}"},
                          json={"heartbeat_at": now, "updated_at": now},
                          headers=self._h({"Content-Type": "application/json", "Prefer": "return=minimal"}),
                          timeout=self._timeout)

    def register(self, **kw) -> Optional[dict]:
        return self._rpc("register_asset", {f"p_{k}": v for k, v in kw.items()})

    def purge_candidates(self, limit: int = 50) -> List[dict]:
        rows = self._rpc("claim_media_purge", {"p_limit": int(limit)})
        return list(rows or [])

    def mark_purged(self, asset_id: str) -> None:
        self._rpc("mark_asset_purged", {"p_asset": canonical_id(asset_id)})


# ── one ticket ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Tools:
    ffprobe: str
    ffmpeg: str


def find_tools() -> Optional[Tools]:
    probe_exe, ffmpeg_exe = shutil.which("ffprobe"), shutil.which("ffmpeg")
    if not probe_exe or not ffmpeg_exe:
        return None
    return Tools(probe_exe, ffmpeg_exe)


def ingest(ticket: Mapping, *, store: MediaStore, staging_root: Path, media_root: Path, worker_id: str,
           tools: Tools, new_id: Callable[[], str] = lambda: str(uuid.uuid4()),
           runner: Callable[..., int] = run_tool, prober: Callable[..., Probe] = run_probe) -> dict:
    """Turn one claimed ticket into files under media/ and a registered row.
    Returns register_asset's answer. Raises IngestReject with a reason word on
    anything the person should be told; any other exception is a worker error.
    The staged file is left in place — the caller deletes it once the ticket
    is settled either way."""
    tid = canonical_id(ticket.get("id"))
    declared_bytes = int(ticket.get("declared_bytes") or 0)
    declared_mime = str(ticket.get("declared_mime") or "")
    name = str(ticket.get("original_name") or "")

    staged = staged_path(staging_root, tid)
    if not staged.is_file() or staged.is_symlink():
        raise IngestReject("file_missing", "the uploaded file is not on the server")
    size = staged.stat().st_size
    if size <= 0:
        raise IngestReject("empty")
    if declared_bytes <= 0 or size > declared_bytes:
        raise IngestReject("too_large", "the file is larger than the upload declared")

    with open(staged, "rb") as f:
        head = f.read(4096)
    sniffed = sniff(head)
    if sniffed is None:
        raise IngestReject("unsupported_type", "the content is not an accepted image, video, audio or caption file")
    check_declared(sniffed, declared_mime, name)

    if ALLOWED_MIME[sniffed] == "caption":
        check_caption(staged)
        info = Probe("caption", sniffed, None, None, None)
    else:
        info = prober(tools.ffprobe, staged, sniffed)
        # Declared as sound, found to carry a picture: not what was asked for.
        if ALLOWED_MIME.get(declared_mime) == "audio" and info.kind != "audio":
            raise IngestReject("type_mismatch", "the audio file carries video")

    aid = canonical_id(new_id())
    final = asset_dir(media_root, aid)
    work = final.with_name(f".{aid}.part")
    work.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(work.parent, 0o755)
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(mode=0o755)
    beat = lambda: store.heartbeat(tid, worker_id)  # noqa: E731
    try:
        nbytes, digest = copy_and_hash(staged, work / VARIANT_FILES["original"], declared_bytes)
        variants: List[str] = []
        if info.kind in ("image", "video"):
            thumb = work / VARIANT_FILES["thumb"]
            code = runner(thumbnail_command(tools.ffmpeg, work / "original", thumb, info.mime, info.duration),
                          beat, timeout_s=THUMB_TIMEOUT_S)
            if code != 0 or not thumb.is_file() or thumb.stat().st_size <= 0:
                raise IngestReject("decode_failed", "the picture could not be decoded")
            variants.append("thumb")
        if info.kind == "video":
            proxy = work / VARIANT_FILES["proxy"]
            code = runner(proxy_command(tools.ffmpeg, work / "original", proxy, info.mime), beat,
                          timeout_s=PROXY_TIMEOUT_S)
            if code != 0 or not proxy.is_file() or proxy.stat().st_size <= 0:
                raise IngestReject("decode_failed", "the video could not be decoded")
            variants.append("proxy")
        derived = 0
        for f in work.iterdir():
            # The web container reads these as another user (read-only mount).
            os.chmod(f, 0o644)
            if f.name != VARIANT_FILES["original"]:
                derived += f.stat().st_size
        os.replace(work, final)
    except BaseException:
        shutil.rmtree(work, ignore_errors=True)
        raise

    try:
        out = store.register(
            asset_id=aid, org=None, kind=info.kind, mime=info.mime, bytes=nbytes, sha256=digest,
            source="upload", width=info.width, height=info.height, duration_s=info.duration,
            provenance={"rights": "uploaded_by_member", "upload_id": tid, "sniffed_mime": info.mime},
            derived_bytes=derived, variants=variants, upload_id=tid,
        )
    except Exception as e:
        shutil.rmtree(final, ignore_errors=True)
        raise StoreUnavailable(type(e).__name__) from e
    except BaseException:
        shutil.rmtree(final, ignore_errors=True)
        raise
    if not out:
        shutil.rmtree(final, ignore_errors=True)
        raise StoreUnavailable("register_asset is not available")
    if out.get("reused") and out.get("id") != aid:
        # A retry after an earlier attempt registered: keep that one.
        shutil.rmtree(final, ignore_errors=True)
    return out


def process_ticket(ticket: Mapping, *, store: MediaStore, staging_root: Path, media_root: Path,
                   worker_id: str, tools: Tools, **kw) -> str:
    """Carry one claimed ticket to ingested | rejected. Never raises."""
    try:
        tid = canonical_id(ticket.get("id"))
    except ValueError:
        logger.warning("media upload with a malformed id skipped")
        return "skipped"
    outcome = "failed"
    try:
        out = ingest(ticket, store=store, staging_root=staging_root, media_root=media_root,
                     worker_id=worker_id, tools=tools, **kw)
        logger.info("media upload %s: ingested as %s", tid, out.get("id"))
        outcome = "ingested"
    except StoreUnavailable as e:
        # Nothing is decided: keep the staged file for the retry.
        logger.warning("media upload %s: could not be recorded (%s); left for a retry", tid, e)
        return "retry"
    except IngestReject as stop:
        _reject(store, tid, worker_id, stop.reason, stop.detail or None)
        logger.info("media upload %s: rejected (%s)", tid, stop.reason)
        outcome = "rejected"
    except Exception as e:  # unforeseen: the type only
        _reject(store, tid, worker_id, "worker_error", f"worker error ({type(e).__name__})")
        logger.warning("media upload %s: rejected (%s)", tid, type(e).__name__)
        outcome = "rejected"
    try:
        staged_path(staging_root, tid).unlink(missing_ok=True)
    except OSError:
        pass
    return outcome


def _reject(store: MediaStore, tid: str, worker_id: str, reason: str, detail: Optional[str]) -> None:
    try:
        store.reject(tid, worker_id, reason, detail)
    except Exception as e:
        logger.warning("media upload %s: could not record the rejection (%s)", tid, type(e).__name__)


# ── housekeeping ─────────────────────────────────────────────────────────────


def gc_staging(staging_root: Path, *, max_age_s: float = STAGING_MAX_AGE_S, now: Optional[float] = None) -> int:
    """Delete staged files no ticket can still want. Returns how many."""
    d = Path(staging_root)
    if not d.is_dir():
        return 0
    now = time.time() if now is None else now
    n = 0
    for f in d.iterdir():
        try:
            if f.is_symlink() or not f.is_file():
                continue
            if now - f.stat().st_mtime > max_age_s:
                f.unlink()
                n += 1
        except OSError:
            pass
    return n


def purge_deleted(store: MediaStore, media_root: Path, *, limit: int = 50) -> int:
    """Remove the files of soft-deleted assets, then give their bytes back."""
    n = 0
    for row in store.purge_candidates(limit):
        try:
            aid = canonical_id(row.get("id"))
        except ValueError:
            continue
        # The database's storage_key must be the one the id gives; if it is
        # not, nothing is deleted — a path is never taken from a row.
        if row.get("storage_key") not in (None, storage_key(aid)):
            logger.warning("asset %s: storage_key does not match its id; not purged", aid)
            continue
        target = asset_dir(media_root, aid)
        try:
            if target.is_symlink():
                target.unlink()
            elif target.exists():
                shutil.rmtree(target)
            store.mark_purged(aid)
            n += 1
        except Exception as e:
            logger.warning("asset %s: purge failed (%s)", aid, type(e).__name__)
    return n


class MediaService:
    """What tools/media_worker.py runs in a loop."""

    def __init__(self, url: str, service_key: str, *, staging_root: Path, media_root: Path, worker_id: str,
                 tools: Tools, store: Optional[MediaStore] = None,
                 clock: Callable[[], float] = time.monotonic):
        self.store = store or MediaStore(url, service_key)
        self.staging_root = Path(staging_root)
        self.media_root = Path(media_root)
        self.worker_id = worker_id
        self.tools = tools
        self.clock = clock
        self._last_house: Optional[float] = None
        self._warned = False

    def housekeeping(self, every_s: float = 600.0) -> None:
        if self._last_house is not None and self.clock() - self._last_house < every_s:
            return
        self._last_house = self.clock()
        gc_staging(self.staging_root)
        purge_deleted(self.store, self.media_root)

    def run_once(self) -> bool:
        """Housekeeping, then at most one ticket. True when one was handled."""
        try:
            self.housekeeping()
            ticket = self.store.claim(self.worker_id)
        except Exception as e:
            if not self._warned:
                logger.warning("media queue unavailable (%s)", str(e) if isinstance(e, RuntimeError)
                               else type(e).__name__)
                self._warned = True
            return False
        self._warned = False
        if not ticket:
            return False
        process_ticket(ticket, store=self.store, staging_root=self.staging_root, media_root=self.media_root,
                       worker_id=self.worker_id, tools=self.tools)
        return True


__all__ = [
    "ALLOWED_MIME", "DEMUXER", "EXT_MIME", "IngestReject", "MediaService", "MediaStore", "Probe", "Tools",
    "VARIANT_FILES", "asset_dir", "asset_file", "canonical_id", "check_declared", "find_tools", "gc_staging",
    "ingest", "interpret_probe", "process_ticket", "purge_deleted", "sniff", "staged_path", "storage_key",
]
