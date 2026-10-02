"""Shorts — a vertical cut of the video that was already rendered.

Why derive rather than re-render
--------------------------------
A second full render would double the most expensive stage of the pipeline for
a 30-second clip, and would produce a *different* video: different cuts,
different Ken Burns timing, different subtitle placement. The short is supposed
to be a trailer for the long video, so it is cut from the long video — same
footage, same voice, same burnt-in subtitles, one transform.

The frame
---------
A 16:9 frame does not become a 9:16 frame by cropping: the centre crop throws
away two thirds of the width, and this project's subtitles are laid out nearly
full-width, so cropping would slice words in half. Instead the whole frame is
scaled to the short's width and centred on a tall canvas. Nothing in the frame
is lost, and the empty space above and below is the project's own background
colour rather than a stretched blur nobody asked for.

What it is cut from
-------------------
The hook — the opening section the script engine wrote specifically to stop a
scroll — clamped to `MIN_SECONDS`..`MAX_SECONDS`. That needs no guessing about
which moment is "best"; it is the part of the script that already has that job.

Cost
----
**A short is a second `videos.insert`: ~1600 more quota units, on a budget of
10,000 a day.** That is why Shorts are off unless a channel turns them on, and
why nothing here ever runs on its own — a short exists only after its long
video has actually published.
"""

from __future__ import annotations

import logging
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional

logger = logging.getLogger(__name__)

#: Shorts frame. Vertical 1080p — what YouTube wants and what the source
#: 1920x1080 can fill widthways without upscaling.
SHORT_WIDTH = 1080
SHORT_HEIGHT = 1920

#: A clip under this says nothing; a clip over this stops being a Short.
MIN_SECONDS = 15.0
MAX_SECONDS = 60.0

#: Same background as the compositor's own filler, so the letterboxing reads as
#: part of the design rather than as a rendering accident.
BACKGROUND_RGB = (15, 15, 30)


@dataclass(frozen=True)
class ShortsConfig:
    """Whether this channel makes Shorts, and how long they run.

    Off unless the channel explicitly turns it on. Every other per-channel flag
    in Nightshift defaults to the safe direction; here the safe direction is *not*
    spending another 1600 quota units per day without being asked.
    """

    enabled: bool = False
    max_seconds: float = MAX_SECONDS

    @staticmethod
    def from_channel(channel) -> "ShortsConfig":
        raw = {}
        try:
            agent = getattr(channel, "agent", None)
            raw = dict(getattr(agent, "shorts", None) or {})
        except Exception:
            raw = {}
        # Only an explicit boolean true turns it on: a stray string or a typo
        # must not start spending quota.
        enabled = raw.get("enabled") is True
        seconds = raw.get("max_seconds", MAX_SECONDS)
        try:
            seconds = float(seconds)
        except (TypeError, ValueError):
            seconds = MAX_SECONDS
        return ShortsConfig(
            enabled=enabled,
            max_seconds=min(MAX_SECONDS, max(MIN_SECONDS, seconds)),
        )


def hook_window(section_timeline: list, max_seconds: float = MAX_SECONDS) -> Optional[float]:
    """How many seconds from the start the short should cover, or None.

    The timeline is the audio mixer's own measurement of where each section
    landed, so this cuts on a real boundary rather than mid-sentence. A hook
    that ran long is trimmed to `max_seconds`; a hook that was very short is
    extended to `MIN_SECONDS` so the clip is not over before it starts. A
    timeline that says nothing usable produces None — no short, rather than a
    guessed one.
    """
    entries = section_timeline or []
    if not entries:
        return None
    try:
        end_ms = float(entries[0]["end_ms"])
    except (KeyError, TypeError, ValueError, IndexError):
        return None
    if end_ms <= 0:
        return None

    seconds = end_ms / 1000.0
    ceiling = min(MAX_SECONDS, max(MIN_SECONDS, float(max_seconds)))
    return min(ceiling, max(MIN_SECONDS, seconds))


def short_title(title: str) -> str:
    """The long video's title, tagged, within YouTube's 100-character limit.

    The tag is what makes the upload eligible to be treated as a Short, so it
    is never the part that gets trimmed — the title is.
    """
    tag = " #Shorts"
    base = (title or "").strip()
    room = 100 - len(tag)
    if len(base) > room:
        base = base[: room - 1].rstrip() + "…"
    return f"{base}{tag}"


#: Hashtags that tag the clip as a Short and give it a little discovery surface.
#: Kept short so the description stays about the funnel, not a hashtag wall.
_SHORT_HASHTAGS = "#Shorts #shorts"


def short_description(title: str, video_url: str | None, hook: str = "") -> str:
    """A funnel description whose whole job is to send the viewer to the full
    video.

    The link goes on the FIRST line: YouTube collapses a description after
    roughly three lines behind "...more", so a "full video" link buried at the
    bottom is a link almost nobody sees. Above the fold it is one tap away. An
    explicit call to action and a one-line tease (the script's hook, when given)
    tell the viewer there is a whole story waiting; hashtags tag it as a Short.

    With no URL there is nothing to funnel into, so it degrades to a clean
    title-only description — and, deliberately, contains no dangling "Full
    video" label pointing nowhere.
    """
    title = (title or "").strip()
    hook = " ".join((hook or "").split()).strip()
    if video_url:
        lines = [
            f"▶ Full video: {video_url}",
            "",
            "You just watched the hook — the full story is in the video above 👆",
        ]
        if hook:
            lines += ["", hook]
        lines += ["", title, "", _SHORT_HASHTAGS]
    else:
        lines = [title, "", _SHORT_HASHTAGS]
    return "\n".join(lines).strip()


def render_short(
    source_video: Path,
    out_path: Path,
    seconds: float,
) -> Optional[Path]:
    """Cut the first `seconds` of `source_video` into a vertical clip.

    Returns the written file, or None when it could not be made. Never raises:
    a short is a bonus on top of a video that has already published, and a
    failure here must not read as a failed run.
    """
    try:
        from moviepy.editor import ColorClip, CompositeVideoClip, VideoFileClip
    except Exception:
        logger.warning("moviepy unavailable — skipping the Short", exc_info=True)
        return None

    clip = None
    source = None
    try:
        source = VideoFileClip(str(source_video))
        duration = min(float(seconds), float(source.duration))
        if duration <= 0:
            logger.warning("Source video has no usable duration — skipping the Short")
            return None

        clip = source.subclip(0, duration)
        # Scale to the short's width, keeping the aspect ratio: the whole 16:9
        # frame survives, including the subtitles, which a centre crop would cut.
        scaled = clip.resize(width=SHORT_WIDTH)
        canvas = ColorClip((SHORT_WIDTH, SHORT_HEIGHT), color=BACKGROUND_RGB, duration=duration)
        final = CompositeVideoClip(
            [canvas, scaled.set_position(("center", "center"))],
            size=(SHORT_WIDTH, SHORT_HEIGHT),
        ).set_duration(duration)
        if clip.audio is not None:
            final = final.set_audio(clip.audio)

        out_path.parent.mkdir(parents=True, exist_ok=True)
        final.write_videofile(
            str(out_path),
            fps=30,
            codec="libx264",
            audio_codec="aac",
            preset="fast",
            threads=4,
            verbose=False,
            logger=None,
        )
        logger.info("Short rendered: %s (%.1fs)", out_path, duration)
        return out_path
    except Exception as e:
        logger.warning("Short render failed (%s: %s) — the long video is unaffected",
                       type(e).__name__, e)
        return None
    finally:
        for handle in (clip, source):
            try:
                if handle is not None:
                    handle.close()
            except Exception:
                pass


# ── any window of a finished master (migration 0080, modules/repurpose.py) ──
#
# ``render_short`` cuts the hook with moviepy. Repurposing cuts several windows
# of the MASTER file on the queue worker with ffmpeg, in one pass each: seek to
# the window, re-encode that stretch to the same vertical frame (the whole
# frame scaled into the short's width on the project's own background colour,
# nothing cropped, so burnt-in subtitles survive), and stop at the window's
# end. The window is whole scenes decided elsewhere; this function only cuts.


def window_command(exe: str, src: Path, dst: Path, start_s: float, end_s: float, info) -> List[str]:
    """The ffmpeg argv that cuts ``[start_s, end_s]`` of ``src`` into a 1080x1920
    clip. ``info`` is the source's probe (``social_publish.VideoInfo``): a
    portrait source is fitted by height, a landscape one by width. ``-2`` keeps
    the other side even, as libx264 requires. Seeking before ``-i`` with a
    re-encode is frame-accurate."""
    duration = float(end_s) - float(start_s)
    if duration <= 0:
        raise ValueError("a window must end after it starts")
    portrait = bool(getattr(info, "width", None) and getattr(info, "height", None)
                    and info.height > info.width)
    fit = f"scale=-2:{SHORT_HEIGHT}" if portrait else f"scale={SHORT_WIDTH}:-2"
    colour = "0x%02X%02X%02X" % BACKGROUND_RGB
    vf = f"{fit},pad={SHORT_WIDTH}:{SHORT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color={colour},setsar=1"
    return [
        exe, "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
        "-ss", f"{float(start_s):.3f}", "-i", str(src), "-t", f"{duration:.3f}",
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", vf, "-r", "30",
        "-c:v", "libx264", "-preset", "fast", "-crf", "21", "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
        str(dst),
    ]


def run_ffmpeg(argv: List[str], heartbeat: Callable[[], None], *, timeout_s: float = 30 * 60,
               beat_s: float = 30.0) -> int:
    """Run ffmpeg, beating ``heartbeat`` while it works. Raises TimeoutError
    (after killing it) when it runs past ``timeout_s``."""
    proc = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    started = time.monotonic()
    while True:
        try:
            return proc.wait(timeout=beat_s)
        except subprocess.TimeoutExpired:
            if time.monotonic() - started > timeout_s:
                proc.kill()
                proc.wait()
                raise TimeoutError("ffmpeg ran past its limit") from None
            try:
                heartbeat()
            except Exception:
                pass
