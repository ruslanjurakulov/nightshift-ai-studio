"""Look at the master BEFORE it is uploaded to Instagram or TikTok.

Why: both platforms accept a file, spend minutes processing it and only then say
no. The rules that can be read from the file are checked here, so a post that
cannot work is refused at once with a closed reason word and a plain sentence,
instead of after a staged upload and a ten-minute poll. Nothing here re-encodes
or changes the file (an approval binds to the exact cut's hash); a file that
fails is refused, and the fix (a re-encode or a remux with the index first) is
the operator's.

What is checked, and where the rule comes from (official pages):

* Instagram (https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media,
  the Reels ``video_url`` requirements): MP4 or MOV "with no edit lists and the
  moov atom at the front"; audio AAC; video HEVC or H.264; 23 to 60 FPS;
  1920 pixels maximum width. Duration (3 s to 15 min), size (300 MB) and aspect
  ratio are checked by ``social_publish.check_format``.
* TikTok (https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide):
  H.264 preferred, H.265, VP8 and VP9 also supported; 23 to 60 FPS; "minimum of
  360 pixels for both height and width" and "maximum of 4096 pixels for both".
  The page says nothing about audio codec or where the moov atom sits, and a
  FILE_UPLOAD is sent in chunks, so neither is refused for TikTok: a refusal TikTok
  would not make is a post lost for nothing.

* Facebook Reels (https://developers.facebook.com/docs/video-api/guides/reels-publishing): H.264 / H.265
  recommended, VP9 and AV1 also supported; 24 to 60 fps (checked here as 23 to 60 so 23.976 passes; Meta's error
  1363129 is mapped if it still refuses); at least 540x960. Duration (3 to 90 s) and the 9:16 shape are checked by
  ``social_publish.check_format``. The moov position is not refused: Facebook takes the bytes through its own
  resumable upload, not from a URL.
* X (https://docs.x.com/x-api/media/quickstart/media-upload-chunked; codec and rate from the older v1.1 best-practices page,
  because the current one could not be read): H.264; at most 60 fps. Resolution, aspect and audio are NOT refused: no
  figure for them could be read on a current page, and a refusal X would not make is a post lost for nothing.
  Duration (1 s to 20 min) and size are checked by ``social_publish.check_format``.

NOT checked (the pages list them; this reads none of them): edit lists, closed
GOP, 4:2:0 chroma, bitrate (25 Mbps) and audio sample rate (48 kHz); for Facebook also AAC-LC / 128 kbps.

``read_facts`` uses ``ffprobe`` when it is installed, else parses ``ffmpeg -i``
(the render image has ffmpeg, and the existing duration probe already depends
on it). A file whose facts cannot be read is refused as ``unreadable_video``,
never passed on a guess.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

IG_MAX_WIDTH = 1920
FPS_MIN = 23.0
FPS_MAX = 60.0
TT_MIN_SIDE = 360
TT_MAX_SIDE = 4096

FB_MIN_WIDTH = 540
FB_MIN_HEIGHT = 960

IG_VIDEO_CODECS = ("h264", "hevc")
#: Facebook Reels: "H.264 or H.265 recommended (VP9 and AV1 also supported)".
FB_VIDEO_CODECS = ("h264", "hevc", "vp9", "av1")
#: X: "H.264 High Profile" (the media best-practices page; only its older v1.1 copy was readable, see social_x).
X_VIDEO_CODECS = ("h264",)
TT_VIDEO_CODECS = ("h264", "hevc", "vp8", "vp9")

#: The closed words this module adds to ``publish_requests.reason`` (the panel has a sentence for each, in en / ru /
#: uz: command-center/lib/publish.ts).
REASON_UNREADABLE = "unreadable_video"
REASON_CODEC = "bad_codec"
REASON_AUDIO = "bad_audio"
REASON_FPS = "bad_framerate"
REASON_TOO_WIDE = "too_wide"
REASON_RESOLUTION = "bad_resolution"
REASON_FASTSTART = "not_faststart"
REASON_TOO_SMALL = "too_small_picture"
REASONS = (REASON_UNREADABLE, REASON_CODEC, REASON_AUDIO, REASON_FPS, REASON_TOO_WIDE, REASON_RESOLUTION,
           REASON_FASTSTART, REASON_TOO_SMALL)


class ProbeRefusal(Exception):
    """The file cannot go to this platform: a closed reason word and our own plain sentence."""

    def __init__(self, reason: str, detail: str):
        super().__init__(reason)
        self.reason = reason
        self.detail = detail


@dataclass(frozen=True)
class MediaFacts:
    video_codec: Optional[str] = None
    audio_codec: Optional[str] = None
    has_audio: Optional[bool] = None
    width: Optional[int] = None
    height: Optional[int] = None
    fps: Optional[float] = None
    #: True: the moov atom comes before the media data. False: after. None: could not be told.
    faststart: Optional[bool] = None


# ── the container: where is the index? ───────────────────────────────────────


def faststart(path: Path, *, max_boxes: int = 64) -> Optional[bool]:
    """Walk the top-level boxes of an MP4 / MOV: True when ``moov`` comes before
    ``mdat``, False when ``mdat`` comes first, None when either is missing or
    the file is not an ISO base media file. Reads headers only (seeks past the
    media data), bounded."""
    try:
        size = Path(path).stat().st_size
        with open(path, "rb") as fh:
            pos = 0
            first = True
            for _ in range(max_boxes):
                fh.seek(pos)
                head = fh.read(8)
                if len(head) < 8:
                    return None
                length = int.from_bytes(head[:4], "big")
                kind = head[4:8]
                if first and kind not in (b"ftyp", b"moov", b"mdat", b"free", b"skip", b"wide"):
                    return None
                first = False
                if kind == b"moov":
                    return True
                if kind == b"mdat":
                    return False
                if length == 1:
                    ext = fh.read(8)
                    if len(ext) < 8:
                        return None
                    length = int.from_bytes(ext, "big")
                elif length == 0:
                    return None  # a box that runs to the end of the file, and it was not moov / mdat
                if length < 8:
                    return None
                pos += length
                if pos >= size:
                    return None
    except OSError:
        return None
    return None


# ── the streams ──────────────────────────────────────────────────────────────


def _rate(text) -> Optional[float]:
    """``30000/1001`` or ``30`` to a float; None when it is not a positive rate."""
    if not isinstance(text, str):
        return None
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(?:/\s*(\d+(?:\.\d+)?))?\s*", text)
    if not m:
        return None
    num, den = float(m.group(1)), float(m.group(2) or 1)
    if den == 0 or num == 0:
        return None
    return num / den


def parse_ffprobe(doc) -> MediaFacts:
    """Facts from ``ffprobe -show_streams -of json``."""
    streams = doc.get("streams") if isinstance(doc, dict) else None
    if not isinstance(streams, list):
        return MediaFacts()
    video = next((s for s in streams if isinstance(s, dict) and s.get("codec_type") == "video"
                  and not (s.get("disposition") or {}).get("attached_pic")), None)
    audio = next((s for s in streams if isinstance(s, dict) and s.get("codec_type") == "audio"), None)
    if video is None:
        return MediaFacts()

    def whole(v):
        return v if isinstance(v, int) and not isinstance(v, bool) and v > 0 else None

    return MediaFacts(
        video_codec=str(video.get("codec_name") or "").lower() or None,
        audio_codec=(str(audio.get("codec_name") or "").lower() or None) if audio else None,
        has_audio=audio is not None,
        width=whole(video.get("width")), height=whole(video.get("height")),
        fps=_rate(video.get("avg_frame_rate")) or _rate(video.get("r_frame_rate")),
    )


_VIDEO_LINE = re.compile(r"Stream #\d+:\d+[^\n]*?: Video: ([A-Za-z0-9_]+)([^\n]*)")
_AUDIO_LINE = re.compile(r"Stream #\d+:\d+[^\n]*?: Audio: ([A-Za-z0-9_]+)")
_SIZE = re.compile(r"[\s,](\d{2,5})x(\d{2,5})(?=[\s,\[])")
_FPS = re.compile(r"(\d+(?:\.\d+)?)\s*fps")
_TBR = re.compile(r"(\d+(?:\.\d+)?)\s*tbr")


def parse_ffmpeg_info(text: str) -> MediaFacts:
    """Facts from the stderr of ``ffmpeg -i file`` (used when ffprobe is not installed)."""
    text = text or ""
    v = _VIDEO_LINE.search(text)
    if not v:
        return MediaFacts()
    a = _AUDIO_LINE.search(text)
    rest = v.group(2)
    # Drop the codec's parenthesised tags (" (High) (avc1 / 0x31637661)") so a "0x..." never reads as a size.
    size = _SIZE.search(re.sub(r"\([^)]*\)", "", rest))
    fps = _FPS.search(rest) or _TBR.search(rest)
    return MediaFacts(
        video_codec=v.group(1).lower(),
        audio_codec=a.group(1).lower() if a else None,
        has_audio=a is not None,
        width=int(size.group(1)) if size else None,
        height=int(size.group(2)) if size else None,
        fps=float(fps.group(1)) if fps else None,
    )


def _ffprobe() -> Optional[str]:
    found = shutil.which("ffprobe")
    if found:
        return found
    try:
        import imageio_ffmpeg  # noqa: PLC0415

        sibling = Path(imageio_ffmpeg.get_ffmpeg_exe()).with_name("ffprobe")
        return str(sibling) if sibling.is_file() else None
    except Exception:
        return None


def _ffmpeg() -> Optional[str]:
    try:
        import imageio_ffmpeg  # noqa: PLC0415

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


def read_facts(path: Path, *, run: Callable = subprocess.run, ffprobe: Optional[str] = None,
               ffmpeg: Optional[str] = None) -> MediaFacts:
    """The master's streams and container facts. Never raises; whatever could not
    be read is None (and the checks then refuse as ``unreadable_video``)."""
    path = Path(path)
    moov_first = faststart(path)
    probe_exe = ffprobe if ffprobe is not None else _ffprobe()
    facts = MediaFacts()
    try:
        if probe_exe:
            proc = run([probe_exe, "-v", "error", "-show_streams", "-of", "json", str(path)],
                       capture_output=True, text=True, timeout=60)
            facts = parse_ffprobe(json.loads(proc.stdout or "{}"))
        else:
            exe = ffmpeg if ffmpeg is not None else _ffmpeg()
            if exe:
                proc = run([exe, "-hide_banner", "-i", str(path)], capture_output=True, text=True, timeout=60)
                facts = parse_ffmpeg_info(proc.stderr or "")
    except Exception:
        facts = MediaFacts()
    return MediaFacts(facts.video_codec, facts.audio_codec, facts.has_audio, facts.width, facts.height, facts.fps,
                      moov_first)


# ── the rules ────────────────────────────────────────────────────────────────


def _unreadable(what: str) -> ProbeRefusal:
    return ProbeRefusal(REASON_UNREADABLE, f"could not read the video's {what}; it is not posted on a guess")


def check_media(platform: str, f: MediaFacts) -> None:
    """Raise ``ProbeRefusal`` when the platform would reject this file. Pure."""
    name = {"instagram": "Instagram Reels", "facebook": "Facebook Reels", "x": "X"}.get(platform, "TikTok")
    if not f.video_codec or f.width is None or f.height is None:
        raise _unreadable("picture format")
    allowed = {"instagram": IG_VIDEO_CODECS, "facebook": FB_VIDEO_CODECS, "x": X_VIDEO_CODECS}.get(platform, TT_VIDEO_CODECS)
    if f.video_codec not in allowed:
        raise ProbeRefusal(REASON_CODEC, f"the picture is {f.video_codec}; {name} needs "
                                          f"{' or '.join(c.upper() if c != 'hevc' else 'HEVC' for c in allowed)}")
    if platform == "instagram" and f.has_audio and f.audio_codec != "aac":
        raise ProbeRefusal(REASON_AUDIO, f"the sound is {f.audio_codec or 'unknown'}; Instagram Reels needs AAC")
    if f.fps is None:
        raise _unreadable("frame rate")
    if not FPS_MIN <= f.fps <= FPS_MAX:
        raise ProbeRefusal(REASON_FPS, f"the video runs at {f.fps:.1f} frames a second; {name} needs "
                                       f"{FPS_MIN:.0f} to {FPS_MAX:.0f}")
    if platform == "facebook":
        # Meta: "minimum 540x960". Audio is not refused here: the page asks for AAC-LC 48 kHz but names no error for
        # it, and the render's audio is AAC already (see "NOT checked").
        if f.width < FB_MIN_WIDTH or f.height < FB_MIN_HEIGHT:
            raise ProbeRefusal(REASON_TOO_SMALL, f"the video is {f.width}x{f.height}; Facebook Reels need at least "
                                                 f"{FB_MIN_WIDTH}x{FB_MIN_HEIGHT} (1080x1920 recommended)")
    elif platform == "instagram":
        if f.width > IG_MAX_WIDTH:
            raise ProbeRefusal(REASON_TOO_WIDE, f"the video is {f.width} pixels wide; Instagram Reels accepts "
                                                f"at most {IG_MAX_WIDTH}")
        if f.faststart is None:
            raise _unreadable("file layout")
        if not f.faststart:
            raise ProbeRefusal(REASON_FASTSTART, "the file's index (moov) is at the end; Instagram needs it at the "
                                                 "front. Re-save the video with the index first, then send again")
    elif platform == "tiktok":
        if min(f.width, f.height) < TT_MIN_SIDE or max(f.width, f.height) > TT_MAX_SIDE:
            raise ProbeRefusal(REASON_RESOLUTION, f"the video is {f.width}x{f.height}; TikTok needs both sides "
                                                  f"between {TT_MIN_SIDE} and {TT_MAX_SIDE} pixels")


__all__ = ["MediaFacts", "ProbeRefusal", "REASONS", "read_facts", "check_media", "faststart", "parse_ffprobe",
           "parse_ffmpeg_info"]
