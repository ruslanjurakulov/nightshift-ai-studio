import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from modules.trend_detector import TrendDetector, VideoSnapshot


def _trending_response(video_ids, channel_id="UC_trend_channel"):
    return {
        "items": [
            {
                "id": vid,
                "snippet": {
                    "title": f"Trending {vid}",
                    "publishedAt": "2026-09-01T08:00:00Z",
                    "channelId": channel_id,
                },
                "statistics": {
                    "viewCount": "250000",
                    "likeCount": "12000",
                    "commentCount": "800",
                },
            }
            for vid in video_ids
        ]
    }


class TrendDetectorTests(unittest.TestCase):
    @patch("modules.trend_detector.build")
    def test_trending_returns_parsed_snapshots(self, mock_build):
        mock_youtube = MagicMock()
        mock_youtube.videos.return_value.list.return_value.execute.return_value = (
            _trending_response(["t1", "t2"])
        )
        mock_build.return_value = mock_youtube

        detector = TrendDetector(api_key="fake-key")
        snapshots = detector.trending(region_code="US")

        mock_build.assert_called_once_with("youtube", "v3", developerKey="fake-key")
        self.assertEqual(len(snapshots), 2)
        first = snapshots[0]
        self.assertIsInstance(first, VideoSnapshot)
        self.assertEqual(first.video_id, "t1")
        self.assertEqual(first.channel_id, "UC_trend_channel")
        self.assertEqual(first.view_count, 250000)
        self.assertEqual(first.like_count, 12000)
        self.assertEqual(first.comment_count, 800)
        self.assertEqual(
            first.published_at,
            datetime(2026, 9, 1, 8, 0, 0, tzinfo=timezone.utc),
        )

    @patch("modules.trend_detector.build")
    def test_trending_calls_videos_list_with_mostpopular_chart(self, mock_build):
        mock_youtube = MagicMock()
        mock_youtube.videos.return_value.list.return_value.execute.return_value = (
            _trending_response(["t1"])
        )
        mock_build.return_value = mock_youtube

        detector = TrendDetector(api_key="fake-key")
        detector.trending(region_code="GB", category_id="10", max_results=25)

        mock_youtube.videos.return_value.list.assert_called_once_with(
            chart="mostPopular",
            regionCode="GB",
            videoCategoryId="10",
            part="snippet,statistics",
            maxResults=25,
        )

    @patch("modules.trend_detector.build")
    def test_trending_omits_category_id_when_not_given(self, mock_build):
        mock_youtube = MagicMock()
        mock_youtube.videos.return_value.list.return_value.execute.return_value = (
            _trending_response(["t1"])
        )
        mock_build.return_value = mock_youtube

        detector = TrendDetector(api_key="fake-key")
        detector.trending(region_code="US")

        _, kwargs = mock_youtube.videos.return_value.list.call_args
        self.assertNotIn("videoCategoryId", kwargs)
        self.assertEqual(kwargs["chart"], "mostPopular")
        self.assertEqual(kwargs["regionCode"], "US")

    @patch("modules.trend_detector.build")
    def test_search_is_never_called(self, mock_build):
        mock_youtube = MagicMock()
        mock_youtube.videos.return_value.list.return_value.execute.return_value = (
            _trending_response(["t1"])
        )
        mock_build.return_value = mock_youtube

        detector = TrendDetector(api_key="fake-key")
        detector.trending()

        mock_youtube.search.assert_not_called()

    def test_default_api_key_from_env(self):
        with patch.dict("os.environ", {"YOUTUBE_DATA_API_KEY": "env-key"}, clear=False):
            with patch("modules.trend_detector.build") as mock_build:
                TrendDetector()
                mock_build.assert_called_once_with("youtube", "v3", developerKey="env-key")


if __name__ == "__main__":
    unittest.main()
