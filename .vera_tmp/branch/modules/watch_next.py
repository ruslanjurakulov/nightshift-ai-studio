"""Watch-next — a "▶ WATCH NEXT" link in the description, chaining each video to
another of the channel's videos.

End screens and info cards are the native YouTube tools for sending a viewer
from one video to the next, but the YouTube Data API v3 exposes **no** endpoint
to set them — they are a manual editor action. The description is the one
surface the API fully controls, so this puts the "watch next" link there: an
honest, API-reachable version of the same funnel. A viewer who finishes the
video finds the next one one tap away, and the channel builds session time
instead of leaking the viewer back to the feed.

Rules, matching the rest of the pipeline:

- **Picks a real previous video, never invents one.** The next-watch target is
  chosen from the channel's own published history — same series first, then the
  most recent other long-form video. With no prior video there is no block, and
  the description is untouched.
- **Never overruns or duplicates.** The block is appended only if the link isn't
  already in the description and the result stays under YouTube's limit; over
  the limit, the description is returned unchanged (a working description beats a
  truncated one). Never raises.
"""

from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)

# YouTube rejects a description over 5000 characters; keep a small margin.
_MAX_DESCRIPTION = 4900


def video_url(video_id: str) -> str:
    """The canonical short URL for a video id."""
    vid = (video_id or "").strip()
    return f"https://youtu.be/{vid}" if vid else ""


def pick_next_video(
    videos: list,
    *,
    exclude_video_id: Optional[str] = None,
    series_id: Optional[str] = None,
) -> Optional[dict]:
    """Choose the video to point "watch next" at, from the channel's published
    long-form history. Prefers one from the same series (when the rows carry a
    matching `series_id`), else the most recent other long-form video. Returns
    the row, or None when there is nothing to point at.

    `videos` is assumed newest-first (as StateStore.list_videos returns them);
    it is not re-sorted, so the "most recent" is simply the first eligible row."""
    def eligible(v: dict) -> bool:
        if (v.get("video_format") or "long") == "short":
            return False
        vid = v.get("video_id")
        if not vid or vid == exclude_video_id:
            return False
        return True

    rows = [v for v in (videos or []) if eligible(v)]
    if not rows:
        return None
    if series_id:
        same_series = [v for v in rows if v.get("series_id") == series_id]
        if same_series:
            return same_series[0]
    return rows[0]


def watch_next_block(video_id: str, title: str = "") -> str:
    """The description block that links the next video, or "" with no id."""
    url = video_url(video_id)
    if not url:
        return ""
    title = " ".join((title or "").split()).strip()
    headline = f"▶ WATCH NEXT: {title}" if title else "▶ WATCH NEXT"
    return f"{headline}\n{url}"


def append_watch_next(description: str, block: str, *, max_len: int = _MAX_DESCRIPTION) -> str:
    """Append `block` to `description`, separated by a blank line.

    A no-op when the block is empty, when its link is already present (so a
    re-upload doesn't stack duplicates), or when appending would exceed
    `max_len` — in which case the original description is returned unchanged."""
    description = description or ""
    block = (block or "").strip()
    if not block:
        return description
    # The URL is the stable part; if it's already in the description, don't
    # add the block again.
    url_line = block.splitlines()[-1].strip()
    if url_line and url_line in description:
        return description
    candidate = f"{description.rstrip()}\n\n{block}" if description.strip() else block
    if len(candidate) > max_len:
        logger.info("Watch-next block dropped: description would exceed %d chars", max_len)
        return description
    return candidate
