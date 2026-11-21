import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from modules.competitor_monitor import CompetitorMonitor, VideoSnapshot, view_velocity

CHANNEL_ID = "UC_test_channel_1"
UPLOADS_PLAYLIST_ID = "UU_test_uploads_1"


def _channels_response():
    return {
        "items": [
            {
                "contentDetails": {
                    "relatedPlaylists": {"uploads": UPLOADS_PLAYLIST_ID}
                }
            }
        ]
    }


def _playlist_items_response(video_ids):
    return {
        "items": [
            {"contentDetails": {"videoId": vid}} for vid in video_ids
        ]
    }


def _videos_response(video_ids):
    return {
        "items": [
            {
                "id": vid,
                "snippet": {
                    "title": f"Video {vid}",
                    "publishedAt": "2026-08-30T12:00:00Z",
                },
                "statistics": {
                    "viewCount": "1000",
                    "likeCount": "50",
                    "commentCount": "5",
                },
            }
            for vid in video_ids
        ]
    }


class CompetitorMonitorTests(unittest.TestCase):
    def _make_mock_youtube(self, video_ids):
        """Build a MagicMock replicating youtube.channels/playlistItems/videos chains."""
        mock_youtube = MagicMock()

        mock_youtube.channels.return_value.list.return_value.execute.return_value = (
            _channels_response()
        )
        mock_youtube.playlistItems.return_value.list.return_value.execute.return_value = (
            _playlist_items_response(video_ids)
        )
        mock_youtube.videos.return_value.list.return_value.execute.return_value = (
            _videos_response(video_ids)
        )
        return mock_youtube

    @patch("modules.competitor_monitor.build")
    def test_poll_returns_parsed_snapshots(self, mock_build):
        video_ids = ["vid1", "vid2", "vid3"]
        mock_youtube = self._make_mock_youtube(video_ids)
        mock_build.return_value = mock_youtube

        monitor = CompetitorMonitor(api_key="fake-key")
        results = monitor.poll([CHANNEL_ID])

        mock_build.assert_called_once_with("youtube", "v3", developerKey="fake-key")
        self.assertIn(CHANNEL_ID, results)
        snapshots = results[CHANNEL_ID]
        self.assertEqual(len(snapshots), 3)

        first = snapshots[0]
        self.assertIsInstance(first, VideoSnapshot)
        self.assertEqual(first.video_id, "vid1")
        self.assertEqual(first.channel_id, CHANNEL_ID)
        self.assertEqual(first.title, "Video vid1")
        self.assertEqual(first.view_count, 1000)
        self.assertEqual(first.like_count, 50)
        self.assertEqual(first.comment_count, 5)
        self.assertEqual(
            first.published_at,
            datetime(2026, 8, 30, 12, 0, 0, tzinfo=timezone.utc),
        )

    @patch("modules.competitor_monitor.build")
    def test_call_chain_uses_expected_parts_and_ids(self, mock_build):
        video_ids = ["vid1", "vid2"]
        mock_youtube = self._make_mock_youtube(video_ids)
        mock_build.return_value = mock_youtube

        monitor = CompetitorMonitor(api_key="fake-key")
        monitor.poll([CHANNEL_ID])

        mock_youtube.channels.return_value.list.assert_called_once_with(
            id=CHANNEL_ID, part="contentDetails"
        )
        mock_youtube.playlistItems.return_value.list.assert_called_once_with(
            playlistId=UPLOADS_PLAYLIST_ID, part="contentDetails", maxResults=50
        )
        # videos.list must be called ONCE with a comma-joined batch of IDs,
        # never once per ID.
        mock_youtube.videos.return_value.list.assert_called_once_with(
            id="vid1,vid2", part="snippet,statistics"
        )

    @patch("modules.competitor_monitor.build")
    def test_videos_list_batches_more_than_50_ids(self, mock_build):
        video_ids = [f"vid{i}" for i in range(75)]
        mock_youtube = self._make_mock_youtube(video_ids)
        # videos().list().execute() needs to return different batches per call.
        mock_youtube.videos.return_value.list.return_value.execute.side_effect = [
            _videos_response(video_ids[0:50]),
            _videos_response(video_ids[50:75]),
        ]
        mock_build.return_value = mock_youtube

        monitor = CompetitorMonitor(api_key="fake-key")
        results = monitor.poll([CHANNEL_ID])

        self.assertEqual(mock_youtube.videos.return_value.list.call_count, 2)
        call_args_list = mock_youtube.videos.return_value.list.call_args_list
        self.assertEqual(call_args_list[0].kwargs["id"], ",".join(video_ids[0:50]))
        self.assertEqual(call_args_list[1].kwargs["id"], ",".join(video_ids[50:75]))
        self.assertEqual(len(results[CHANNEL_ID]), 75)

    @patch("modules.competitor_monitor.build")
    def test_search_is_never_called(self, mock_build):
        video_ids = ["vid1"]
        mock_youtube = self._make_mock_youtube(video_ids)
        mock_build.return_value = mock_youtube

        monitor = CompetitorMonitor(api_key="fake-key")
        monitor.poll([CHANNEL_ID])

        mock_youtube.search.assert_not_called()

    @patch("modules.competitor_monitor.build")
    def test_poll_handles_channel_with_no_items_gracefully(self, mock_build):
        mock_youtube = MagicMock()
        mock_youtube.channels.return_value.list.return_value.execute.return_value = {
            "items": []
        }
        mock_build.return_value = mock_youtube

        monitor = CompetitorMonitor(api_key="fake-key")
        results = monitor.poll(["nonexistent-channel"])

        self.assertEqual(results["nonexistent-channel"], [])
        mock_youtube.playlistItems.assert_not_called()
        mock_youtube.videos.assert_not_called()

    def test_default_api_key_from_env(self):
        with patch.dict("os.environ", {"YOUTUBE_DATA_API_KEY": "env-key"}, clear=False):
            with patch("modules.competitor_monitor.build") as mock_build:
                CompetitorMonitor()
                mock_build.assert_called_once_with("youtube", "v3", developerKey="env-key")


class ViewVelocityTests(unittest.TestCase):
    def test_view_velocity_basic(self):
        published_at = datetime(2026, 8, 30, 0, 0, 0, tzinfo=timezone.utc)
        as_of = datetime(2026, 8, 30, 10, 0, 0, tzinfo=timezone.utc)  # 10 hours later
        snapshot = VideoSnapshot(
            video_id="v1",
            channel_id="c1",
            title="t",
            published_at=published_at,
            view_count=5000,
            like_count=0,
            comment_count=0,
        )
        self.assertAlmostEqual(view_velocity(snapshot, as_of=as_of), 500.0)

    def test_view_velocity_one_hour(self):
        published_at = datetime(2026, 8, 30, 0, 0, 0, tzinfo=timezone.utc)
        as_of = datetime(2026, 8, 30, 1, 0, 0, tzinfo=timezone.utc)
        snapshot = VideoSnapshot(
            video_id="v2",
            channel_id="c1",
            title="t",
            published_at=published_at,
            view_count=120,
            like_count=0,
            comment_count=0,
        )
        self.assertAlmostEqual(view_velocity(snapshot, as_of=as_of), 120.0)

    def test_view_velocity_missing_published_at_is_zero(self):
        snapshot = VideoSnapshot(
            video_id="v3",
            channel_id="c1",
            title="t",
            published_at=None,
            view_count=999,
            like_count=0,
            comment_count=0,
        )
        self.assertEqual(view_velocity(snapshot, as_of=datetime.now(timezone.utc)), 0.0)

    def test_view_velocity_just_published_is_zero(self):
        published_at = datetime(2026, 8, 30, 0, 0, 0, tzinfo=timezone.utc)
        as_of = datetime(2026, 8, 30, 0, 0, 10, tzinfo=timezone.utc)  # 10 seconds later
        snapshot = VideoSnapshot(
            video_id="v4",
            channel_id="c1",
            title="t",
            published_at=published_at,
            view_count=42,
            like_count=0,
            comment_count=0,
        )
        self.assertEqual(view_velocity(snapshot, as_of=as_of), 0.0)


if __name__ == "__main__":
    unittest.main()
