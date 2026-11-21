"""Competitor upload monitor.

Polls a fixed list of known competitor YouTube channel IDs for their most
recent uploads, using a quota-efficient call chain (~3 quota units per
channel, no ``search.list`` involved):

    1. channels.list(id=channel_id, part="contentDetails")
       -> items[0]["contentDetails"]["relatedPlaylists"]["uploads"]
    2. playlistItems.list(playlistId=uploads_playlist_id,
                           part="contentDetails", maxResults=50)
       -> collect video IDs
    3. videos.list(id=",".join(video_ids), part="snippet,statistics")
       -> one batched call for up to 50 video IDs

``search.list`` costs 100 quota units per call and is deliberately never
used anywhere in this module.
"""

import logging
import os
from datetime import datetime, timezone

from googleapiclient.discovery import build

from modules.video_snapshot import VideoSnapshot

logger = logging.getLogger(__name__)

# Batch size cap enforced by the YouTube Data API for videos.list id lists.
MAX_BATCH_SIZE = 50


class CompetitorMonitor:
    """Polls known competitor channels for recent uploads and their stats."""

    def __init__(self, api_key=None):
        self.api_key = api_key if api_key is not None else os.getenv("YOUTUBE_DATA_API_KEY", "")
        self.youtube = build("youtube", "v3", developerKey=self.api_key)

    def _get_uploads_playlist_id(self, channel_id: str):
        """Step 1: resolve a channel's uploads playlist ID (~1 quota unit)."""
        response = (
            self.youtube.channels()
            .list(id=channel_id, part="contentDetails")
            .execute()
        )
        items = response.get("items", [])
        if not items:
            logger.warning("No channel found for channel_id=%s", channel_id)
            return None
        return items[0]["contentDetails"]["relatedPlaylists"]["uploads"]

    def _get_recent_video_ids(self, uploads_playlist_id: str, max_results: int = 50):
        """Step 2: list recent video IDs from the uploads playlist (~1 quota unit)."""
        response = (
            self.youtube.playlistItems()
            .list(
                playlistId=uploads_playlist_id,
                part="contentDetails",
                maxResults=max_results,
            )
            .execute()
        )
        return [
            item["contentDetails"]["videoId"]
            for item in response.get("items", [])
        ]

    def _get_video_snapshots(self, video_ids: list, channel_id: str):
        """Step 3: batched videos.list lookup for stats (~1 quota unit per <=50 IDs)."""
        snapshots = []
        for start in range(0, len(video_ids), MAX_BATCH_SIZE):
            batch = video_ids[start : start + MAX_BATCH_SIZE]
            response = (
                self.youtube.videos()
                .list(id=",".join(batch), part="snippet,statistics")
                .execute()
            )
            for item in response.get("items", []):
                snapshots.append(_parse_video_item(item, channel_id))
        return snapshots

    def poll(self, channel_ids: list) -> dict:
        """Poll each channel and return its recent uploads with stats.

        Returns a dict mapping channel_id -> list[VideoSnapshot]. Any
        channel that can't be resolved (bad ID, no uploads) maps to an
        empty list rather than raising, so one bad channel doesn't break
        the whole poll.
        """
        results = {}
        for channel_id in channel_ids:
            try:
                uploads_playlist_id = self._get_uploads_playlist_id(channel_id)
                if not uploads_playlist_id:
                    results[channel_id] = []
                    continue
                video_ids = self._get_recent_video_ids(uploads_playlist_id)
                if not video_ids:
                    results[channel_id] = []
                    continue
                results[channel_id] = self._get_video_snapshots(video_ids, channel_id)
            except Exception:
                logger.exception("Failed to poll channel_id=%s", channel_id)
                results[channel_id] = []
        return results


def _parse_video_item(item: dict, channel_id: str) -> VideoSnapshot:
    snippet = item.get("snippet", {})
    stats = item.get("statistics", {})
    published_raw = snippet.get("publishedAt")
    published_at = _parse_iso8601(published_raw) if published_raw else None
    return VideoSnapshot(
        video_id=item.get("id", ""),
        channel_id=channel_id,
        title=snippet.get("title", ""),
        published_at=published_at,
        view_count=int(stats.get("viewCount", 0)),
        like_count=int(stats.get("likeCount", 0)),
        comment_count=int(stats.get("commentCount", 0)),
    )


def _parse_iso8601(value: str) -> datetime:
    """Parse a YouTube API RFC3339 timestamp (e.g. '2026-08-01T12:00:00Z')."""
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def view_velocity(snapshot: VideoSnapshot, as_of: datetime = None) -> float:
    """Views per hour since publication.

    Used to classify a video as breaking out vs. normal (higher up the
    pipeline, not by this module). Returns 0.0 if the video was published
    less than a minute ago (avoids a division blow-up / infinite velocity
    for brand-new uploads) or if published_at is missing.
    """
    if snapshot.published_at is None:
        return 0.0

    if as_of is None:
        as_of = datetime.now(timezone.utc)

    published_at = snapshot.published_at
    if published_at.tzinfo is None:
        published_at = published_at.replace(tzinfo=timezone.utc)
    if as_of.tzinfo is None:
        as_of = as_of.replace(tzinfo=timezone.utc)

    elapsed_hours = (as_of - published_at).total_seconds() / 3600.0
    if elapsed_hours < (1.0 / 60.0):
        return 0.0
    return snapshot.view_count / elapsed_hours
