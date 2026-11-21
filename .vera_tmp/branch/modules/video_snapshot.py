"""Shared VideoSnapshot dataclass used by competitor_monitor and trend_detector.

Kept in its own module so neither of those two modules has to import the
other just to get the data shape (and so nothing is duplicated).
"""

from dataclasses import dataclass
from datetime import datetime


@dataclass
class VideoSnapshot:
    """A point-in-time snapshot of a single YouTube video's public stats.

    Populated from the ``snippet`` and ``statistics`` parts of a
    ``videos.list`` response.
    """

    video_id: str
    channel_id: str
    title: str
    published_at: datetime
    view_count: int
    like_count: int
    comment_count: int
