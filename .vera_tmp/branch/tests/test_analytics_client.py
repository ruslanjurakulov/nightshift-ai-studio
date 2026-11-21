"""Tests for modules/analytics_client.py.

These tests never make live API calls: the `googleapiclient.discovery.build`
chain (`build(...).reports().query(...).execute()`) is fully mocked, and
`AnalyticsClient.__init__` (which normally runs OAuth) is bypassed by
constructing the object with `__new__` and injecting a fake `.service`.
"""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from modules import channel_credentials as cc
from modules.analytics_client import CORE_METRICS, AnalyticsClient, _default_ids


def make_client_with_mock_service() -> tuple[AnalyticsClient, MagicMock]:
    """Builds an AnalyticsClient without running _auth(), wired to a mock
    `reports().query().execute()` chain. Returns (client, mock_query_method)
    so tests can assert on call args and set return values.
    """
    client = AnalyticsClient.__new__(AnalyticsClient)
    mock_service = MagicMock()
    client.service = mock_service
    mock_query = mock_service.reports.return_value.query
    return client, mock_query


def canned_response(headers: list[str], rows: list[list]) -> dict:
    return {
        "columnHeaders": [{"name": h} for h in headers],
        "rows": rows,
    }


class TestParsing(unittest.TestCase):
    def test_channel_summary_parses_single_row(self):
        client, mock_query = make_client_with_mock_service()
        headers = CORE_METRICS
        row = [1000, 5000, 300.5, 45.2, 20, 3, 150, 12, 8]
        mock_query.return_value.execute.return_value = canned_response(headers, [row])

        result = client.channel_summary("2026-08-01", "2026-08-31")

        self.assertEqual(result["views"], 1000)
        self.assertEqual(result["estimatedMinutesWatched"], 5000)
        self.assertEqual(result["averageViewDuration"], 300.5)
        self.assertEqual(result["averageViewPercentage"], 45.2)
        self.assertEqual(result["subscribersGained"], 20)
        self.assertEqual(result["subscribersLost"], 3)
        self.assertEqual(result["likes"], 150)
        self.assertEqual(result["comments"], 12)
        self.assertEqual(result["shares"], 8)

    def test_channel_summary_empty_rows_returns_empty_dict(self):
        client, mock_query = make_client_with_mock_service()
        mock_query.return_value.execute.return_value = canned_response(CORE_METRICS, [])

        result = client.channel_summary("2026-08-01", "2026-08-31")

        self.assertEqual(result, {})

    def test_video_performance_parses_single_row(self):
        client, mock_query = make_client_with_mock_service()
        row = [500, 2500, 250.0, 60.0, 5, 0, 40, 3, 2]
        mock_query.return_value.execute.return_value = canned_response(CORE_METRICS, [row])

        result = client.video_performance("vid123", "2026-08-01", "2026-08-31")

        self.assertEqual(result["views"], 500)
        self.assertEqual(result["likes"], 40)

    def test_daily_timeseries_parses_multiple_rows(self):
        client, mock_query = make_client_with_mock_service()
        headers = ["day", "views", "likes"]
        rows = [
            ["2026-08-01", 100, 10],
            ["2026-08-02", 150, 12],
            ["2026-08-03", 90, 5],
        ]
        mock_query.return_value.execute.return_value = canned_response(headers, rows)

        result = client.daily_timeseries("2026-08-01", "2026-08-03", ["views", "likes"])

        self.assertEqual(len(result), 3)
        self.assertEqual(result[0], {"day": "2026-08-01", "views": 100, "likes": 10})
        self.assertEqual(result[1], {"day": "2026-08-02", "views": 150, "likes": 12})
        self.assertEqual(result[2], {"day": "2026-08-03", "views": 90, "likes": 5})

    def test_daily_timeseries_empty_rows_returns_empty_list(self):
        client, mock_query = make_client_with_mock_service()
        mock_query.return_value.execute.return_value = canned_response(
            ["day", "views"], []
        )

        result = client.daily_timeseries("2026-08-01", "2026-08-31", ["views"])

        self.assertEqual(result, [])


class TestQueryConstruction(unittest.TestCase):
    def test_channel_summary_default_ids_and_metrics(self):
        client, mock_query = make_client_with_mock_service()
        mock_query.return_value.execute.return_value = canned_response(CORE_METRICS, [])

        with patch("modules.analytics_client.YOUTUBE_CHANNEL_ID", ""):
            client.channel_summary("2026-08-01", "2026-08-31")

        mock_query.assert_called_once_with(
            ids="channel==MINE",
            startDate="2026-08-01",
            endDate="2026-08-31",
            metrics=",".join(CORE_METRICS),
        )

    def test_channel_summary_explicit_channel_id(self):
        client, mock_query = make_client_with_mock_service()
        mock_query.return_value.execute.return_value = canned_response(CORE_METRICS, [])

        client.channel_summary("2026-08-01", "2026-08-31", channel_id="UC_explicit")

        mock_query.assert_called_once_with(
            ids="channel==UC_explicit",
            startDate="2026-08-01",
            endDate="2026-08-31",
            metrics=",".join(CORE_METRICS),
        )

    def test_channel_summary_uses_configured_channel_id_by_default(self):
        client, mock_query = make_client_with_mock_service()
        mock_query.return_value.execute.return_value = canned_response(CORE_METRICS, [])

        with patch("modules.analytics_client.YOUTUBE_CHANNEL_ID", "UC_configured"):
            client.channel_summary("2026-08-01", "2026-08-31")

        mock_query.assert_called_once_with(
            ids="channel==UC_configured",
            startDate="2026-08-01",
            endDate="2026-08-31",
            metrics=",".join(CORE_METRICS),
        )

    def test_video_performance_query_params(self):
        client, mock_query = make_client_with_mock_service()
        mock_query.return_value.execute.return_value = canned_response(CORE_METRICS, [])

        with patch("modules.analytics_client.YOUTUBE_CHANNEL_ID", ""):
            client.video_performance("vidABC", "2026-08-01", "2026-08-31")

        mock_query.assert_called_once_with(
            ids="channel==MINE",
            startDate="2026-08-01",
            endDate="2026-08-31",
            metrics=",".join(CORE_METRICS),
            filters="video==vidABC",
        )

    def test_daily_timeseries_query_params(self):
        client, mock_query = make_client_with_mock_service()
        mock_query.return_value.execute.return_value = canned_response(["day", "views"], [])

        with patch("modules.analytics_client.YOUTUBE_CHANNEL_ID", ""):
            client.daily_timeseries("2026-08-01", "2026-08-31", ["views"])

        mock_query.assert_called_once_with(
            ids="channel==MINE",
            startDate="2026-08-01",
            endDate="2026-08-31",
            metrics="views",
            dimensions="day",
        )

    def test_default_ids_helper_falls_back_to_mine(self):
        with patch("modules.analytics_client.YOUTUBE_CHANNEL_ID", ""):
            self.assertEqual(_default_ids(), "channel==MINE")

    def test_default_ids_helper_uses_configured_channel(self):
        with patch("modules.analytics_client.YOUTUBE_CHANNEL_ID", "UC_xyz"):
            self.assertEqual(_default_ids(), "channel==UC_xyz")


class TestServiceConstruction(unittest.TestCase):
    def test_auth_builds_youtube_analytics_v2_service(self):
        """Confirms _auth() targets the right API name/version, without ever
        touching real credentials or the network."""
        fake_creds = MagicMock()
        fake_creds.valid = True
        fake_creds.scopes = [
            "https://www.googleapis.com/auth/youtube.upload",
            "https://www.googleapis.com/auth/youtube.readonly",
            "https://www.googleapis.com/auth/yt-analytics.readonly",
        ]

        with patch("modules.analytics_client.Path") as mock_path_cls, patch(
            "modules.analytics_client.Credentials"
        ) as mock_credentials_cls, patch(
            "modules.analytics_client.build"
        ) as mock_build, patch(
            "modules.analytics_client.YOUTUBE_SCOPES",
            [
                "https://www.googleapis.com/auth/youtube.upload",
                "https://www.googleapis.com/auth/youtube.readonly",
                "https://www.googleapis.com/auth/yt-analytics.readonly",
            ],
        ):
            mock_token_file = MagicMock()
            mock_token_file.exists.return_value = True
            mock_path_cls.return_value = mock_token_file
            mock_credentials_cls.from_authorized_user_file.return_value = fake_creds
            mock_build.return_value = "FAKE_SERVICE"

            client = AnalyticsClient.__new__(AnalyticsClient)
            # __init__ is bypassed here, so set what _auth reads: the token file
            # this client is bound to (AnalyticsClient(channel=...) resolves it
            # per channel; the value is irrelevant to what this test asserts,
            # since Path is patched above).
            client.token_file = "youtube_token.json"
            service = client._auth()

            mock_build.assert_called_once_with(
                "youtubeAnalytics", "v2", credentials=fake_creds
            )
            self.assertEqual(service, "FAKE_SERVICE")


if __name__ == "__main__":
    unittest.main()


class AuthNamesResolveTestCase(unittest.TestCase):
    """The regression this class exists to prevent repeating.

    `client_secret_problem` and `require_interactive_consent_possible` were
    imported *inside* `_resolve_token_file`, so `_auth()` — a different method —
    could not see them. Every scheduled Intelligence Poll then died on
    `NameError: name 'client_secret_problem' is not defined`, which the poller
    caught and logged as a warning, so the workflow went green while the
    analytics, competitor and trend passes had silently not run at all.

    A green tick is not evidence. These walk the real `_auth()` failure path and
    assert it fails the way it was designed to.
    """

    def _client(self, token_file):
        # __init__ runs OAuth, and the inside of that is exactly what is tested.
        client = AnalyticsClient.__new__(AnalyticsClient)
        client.channel = None
        client.token_file = token_file
        return client

    def test_auth_names_the_missing_client_secret_rather_than_raising_nameerror(self):
        with tempfile.TemporaryDirectory() as tmp:
            client = self._client(Path(tmp) / "no_such_token.json")
            with patch.object(cc.cfg, "YOUTUBE_CLIENT_SECRET", Path(tmp) / "client_secret.json"):
                with self.assertRaises(FileNotFoundError) as caught:
                    client._auth()
        self.assertIn("client_secret.json", str(caught.exception))

    def test_auth_refuses_browser_consent_on_ci_rather_than_raising_nameerror(self):
        with tempfile.TemporaryDirectory() as tmp:
            secret = Path(tmp) / "client_secret.json"
            secret.write_text(json.dumps({"installed": {"client_id": "x"}}))
            client = self._client(Path(tmp) / "no_such_token.json")
            with patch.object(cc.cfg, "YOUTUBE_CLIENT_SECRET", secret), patch.dict(
                os.environ, {"CI": "true"}, clear=False
            ):
                with self.assertRaises(RuntimeError) as caught:
                    client._auth()
        self.assertIn("CI runner", str(caught.exception))

