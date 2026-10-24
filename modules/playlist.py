"""Series playlist — add each published video to its series' playlist.

A playlist keeps a series bingeable and lifts session time: one video pulls the
viewer into the next. After a video publishes, if its series names a playlist,
the video is appended to it.

Strictly best-effort and downstream of a successful publish: the video is
already live, so nothing here may turn a good run into a failed one. Every call
degrades — a missing playlist id is a no-op, an API error is logged and
swallowed. It never publishes, never gates, and never retries in a way that
could double-add.
"""

from __future__ import annotations

import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)

# A playlist a channel can add to is one it made: "PL" plus 16-64 URL-safe
# characters (18 characters on old lists, 34 today). Anything else a person might
# paste (a full URL, a channel id UC..., an auto-generated UU/LL list the API
# will not insert into) is not an id; sending it only spends quota on a 404.
_PLAYLIST_ID_RE = re.compile(r"PL[A-Za-z0-9_-]{16,64}")


def clean_playlist_id(value) -> str:
    """`value` as a playlist id, or "" when it is not one. Never raises."""
    if not isinstance(value, str):
        return ""
    value = value.strip()
    return value if _PLAYLIST_ID_RE.fullmatch(value) else ""


def resolve_playlist_id(series_obj=None, channel_ctx=None) -> str:
    """The playlist a run's video should join, or "" for none: the series' own
    playlist_id first, else the channel's default (agent_config.playlist_id).
    A channel default is a fallback and never overrides a series. Each add costs
    50 YouTube quota units (playlistItems.insert), so unset means no call at all."""
    pid = getattr(series_obj, "playlist_id", "") if series_obj is not None else ""
    pid = str(pid or "").strip()
    if pid:
        return pid
    agent = getattr(channel_ctx, "agent", None)
    return clean_playlist_id(getattr(agent, "playlist_id", ""))


def add_video_to_playlist(service, playlist_id: str, video_id: str) -> Optional[str]:
    """Append `video_id` to `playlist_id` via YouTube playlistItems.insert.

    Returns the new playlistItem id on success, or None when it was skipped
    (missing id/service) or failed. Never raises — a playlist error must not
    sink a run whose video already published. ~50 quota units."""
    playlist_id = str(playlist_id or "").strip()
    video_id = str(video_id or "").strip()
    if not service or not playlist_id or not video_id:
        return None
    try:
        request = service.playlistItems().insert(
            part="snippet",
            body={
                "snippet": {
                    "playlistId": playlist_id,
                    "resourceId": {"kind": "youtube#video", "videoId": video_id},
                }
            },
        )
        resp = request.execute()
        item_id = resp.get("id") if isinstance(resp, dict) else None
        logger.info("Added video %s to playlist %s (item %s)", video_id, playlist_id, item_id)
        return item_id
    except Exception as e:
        logger.warning(
            "Could not add video %s to playlist %s (%s: %s) — the video is already published",
            video_id, playlist_id, type(e).__name__, e,
        )
        return None
