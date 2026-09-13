"""Tests for modules.vidiq_client — no live vidIQ call; a fake session is
injected, so no token or network is required."""

import unittest
from unittest.mock import patch

from modules.vidiq_client import VidIQHttpClient, make_client


class _Resp:
    def __init__(self, status_code=200, payload=None, raise_json=False):
        self.status_code = status_code
        self._payload = payload
        self._raise_json = raise_json

    def json(self):
        if self._raise_json:
            raise ValueError("not json")
        return self._payload


class _Session:
    """Captures the last GET and returns a queued response."""

    def __init__(self, resp):
        self._resp = resp
        self.calls = []

    def get(self, url, headers=None, params=None, timeout=None):
        self.calls.append({"url": url, "headers": headers, "params": params, "timeout": timeout})
        return self._resp


def _client(resp):
    return VidIQHttpClient("tok", base_url="https://api.example.com", session=_Session(resp))


class TestKeywordResearch(unittest.TestCase):
    def test_maps_fields_and_keeps_unknown_as_none(self):
        resp = _Resp(payload={"keywords": [
            {"keyword": "roman roads", "volume": 70, "competition": 30, "related": ["appian way"]},
            {"term": "lost legion"},  # no metrics — must stay None, never 0
        ]})
        rows = _client(resp).keyword_research("rome")
        self.assertEqual(rows[0]["term"], "roman roads")
        self.assertEqual(rows[0]["search_volume"], 70)
        self.assertEqual(rows[0]["competition"], 30)
        self.assertEqual(rows[0]["related"], ("appian way",))
        self.assertEqual(rows[1]["term"], "lost legion")
        self.assertIsNone(rows[1]["search_volume"])
        self.assertIsNone(rows[1]["competition"])

    def test_accepts_a_bare_list_payload(self):
        resp = _Resp(payload=[{"keyword": "x", "volume": 1, "competition": 2}])
        rows = _client(resp).keyword_research("seed")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["term"], "x")

    def test_empty_seed_makes_no_request(self):
        session = _Session(_Resp(payload=[]))
        client = VidIQHttpClient("tok", session=session)
        self.assertEqual(client.keyword_research("  "), [])
        self.assertEqual(session.calls, [])

    def test_non_200_returns_empty(self):
        self.assertEqual(_client(_Resp(status_code=429)).keyword_research("s"), [])

    def test_non_json_returns_empty(self):
        self.assertEqual(_client(_Resp(raise_json=True)).keyword_research("s"), [])

    def test_token_is_sent_as_bearer_and_not_in_url(self):
        session = _Session(_Resp(payload=[]))
        client = VidIQHttpClient("secret-tok", base_url="https://api.example.com", session=session)
        client.keyword_research("s")
        call = session.calls[0]
        self.assertEqual(call["headers"]["Authorization"], "Bearer secret-tok")
        self.assertNotIn("secret-tok", call["url"])


class TestScoreTitle(unittest.TestCase):
    def test_returns_float_score(self):
        self.assertEqual(_client(_Resp(payload={"score": 82})).score_title("A title"), 82.0)

    def test_missing_score_is_none_not_zero(self):
        self.assertIsNone(_client(_Resp(payload={"other": 1})).score_title("A title"))

    def test_empty_title_makes_no_request(self):
        session = _Session(_Resp(payload={"score": 1}))
        client = VidIQHttpClient("tok", session=session)
        self.assertIsNone(client.score_title(""))
        self.assertEqual(session.calls, [])

    def test_non_dict_payload_is_none(self):
        self.assertIsNone(_client(_Resp(payload=[1, 2, 3])).score_title("t"))


class TestMakeClient(unittest.TestCase):
    def test_disabled_returns_none(self):
        with patch("modules.vidiq_client.is_enabled", return_value=False):
            self.assertIsNone(make_client())

    def test_enabled_without_token_returns_none(self):
        with patch("modules.vidiq_client.is_enabled", return_value=True), patch(
            "modules.vidiq_client.config"
        ) as cfg:
            cfg.VIDIQ_ACCESS_TOKEN = ""
            self.assertIsNone(make_client())


if __name__ == "__main__":
    unittest.main()
