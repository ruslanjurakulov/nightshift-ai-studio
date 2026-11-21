"""Region/category-wide trending video detector.

Uses the ``videos.list(chart="mostPopular", ...)`` endpoint, which costs
~1 quota unit per call and is the only ToS-safe trend-detection mechanism
per the audit. ``search.list`` (100 quota units/call) is never used, and
this module does not implement any scraping-based alternative.
"""

import logging
import os

from googleapiclient.discovery import build

from modules.competitor_monitor import _parse_video_item
from modules.video_snapshot import VideoSnapshot

logger = logging.getLogger(__name__)


class TrendDetector:
    """Fetches currently-trending videos for a region/category via videos.list."""

    def __init__(self, api_key=None):
        self.api_key = api_key if api_key is not None else os.getenv("YOUTUBE_DATA_API_KEY", "")
        self.youtube = build("youtube", "v3", developerKey=self.api_key)

    def trending(self, region_code: str = "US", category_id=None, max_results: int = 50) -> list:
        """Return currently-trending VideoSnapshots for a region/category.

        A single ``videos.list(chart="mostPopular", ...)`` call, ~1 quota
        unit regardless of max_results (up to the API's own cap of 50).
        """
        request_kwargs = {
            "chart": "mostPopular",
            "regionCode": region_code,
            "part": "snippet,statistics",
            "maxResults": max_results,
        }
        if category_id is not None:
            request_kwargs["videoCategoryId"] = category_id

        response = self.youtube.videos().list(**request_kwargs).execute()

        snapshots = []
        for item in response.get("items", []):
            channel_id = item.get("snippet", {}).get("channelId", "")
            snapshots.append(_parse_video_item(item, channel_id))
        return snapshots


__all__ = ["TrendDetector", "VideoSnapshot"]
