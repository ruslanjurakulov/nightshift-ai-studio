"""modules/social_tokens.py — the worker's Vault read and token refresh for
Instagram / TikTok (migration 0028), with mocked HTTP. Tokens never appear in
an exception or a repr."""

import unittest
from datetime import datetime, timedelta, timezone

from modules import social_tokens as st

NOW = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)
SECRET_A = "IGQVJ-access-token-value"
SECRET_R = "rft.refresh-token-value"


class Resp:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


class FakeHTTP:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def _next(self, method, url, **kw):
        self.calls.append((method, url, kw))
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    def post(self, url, **kw):
        return self._next("POST", url, **kw)

    def get(self, url, **kw):
        return self._next("GET", url, **kw)


def token(platform, **kw):
    base = dict(account_id="acc-1", org_id="org-1", platform=platform, external_id="ext",
                access_token=SECRET_A, refresh_token=SECRET_R if platform == "tiktok" else "")
    base.update(kw)
    return st.SocialToken(**base)


class ClientTests(unittest.TestCase):
    def test_read_parses_the_row(self):
        http = FakeHTTP(Resp(200, [{"account_id": "acc-1", "org_id": "o", "platform": "tiktok",
                                    "external_id": "oid", "access_token": SECRET_A,
                                    "refresh_token": SECRET_R,
                                    "access_expires_at": "2026-09-02T12:00:00+00:00"}]))
        c = st.SocialTokenClient("https://x.supabase.co", "svc", session=http)
        tok = c.read("acc-1")
        self.assertEqual(tok.platform, "tiktok")
        self.assertEqual(tok.access_expires_at, datetime(2026, 9, 2, 12, tzinfo=timezone.utc))
        self.assertNotIn(SECRET_A, repr(tok))
        self.assertNotIn(SECRET_R, repr(tok))
        self.assertTrue(http.calls[0][1].endswith("/rest/v1/rpc/read_social_token"))

    def test_read_none_when_no_row_and_error_names_status_only(self):
        c = st.SocialTokenClient("https://x.supabase.co", "svc", session=FakeHTTP(Resp(200, [])))
        self.assertIsNone(c.read("acc-1"))
        c = st.SocialTokenClient("https://x.supabase.co", "svc", session=FakeHTTP(Resp(500, {"t": SECRET_A})))
        with self.assertRaises(st.SocialTokenError) as e:
            c.read("acc-1")
        self.assertIn("HTTP 500", str(e.exception))
        self.assertNotIn(SECRET_A, str(e.exception))


class RecordingClient(st.SocialTokenClient):
    def __init__(self):
        super().__init__("https://x.supabase.co", "svc", session=FakeHTTP())
        self.rotated = []
        self.statuses = []

    def rotate(self, tok):
        self.rotated.append(tok)

    def set_status(self, account_id, status):
        self.statuses.append((account_id, status))


ENV = {"TIKTOK_CLIENT_KEY": "k", "TIKTOK_CLIENT_SECRET": "s"}


class InstagramRefreshTests(unittest.TestCase):
    def test_fresh_token_is_used_as_is(self):
        c = RecordingClient()
        tok = token("instagram", access_expires_at=NOW + timedelta(days=40), connected_at=NOW - timedelta(days=20))
        self.assertIs(st.ensure_fresh(tok, c, http=FakeHTTP(), env=ENV, now=NOW), tok)
        self.assertEqual(c.rotated, [])

    def test_refreshes_near_expiry_and_stores_it(self):
        c = RecordingClient()
        http = FakeHTTP(Resp(200, {"access_token": "IGQ-new-token", "token_type": "bearer", "expires_in": 5184000}))
        tok = token("instagram", access_expires_at=NOW + timedelta(days=3), connected_at=NOW - timedelta(days=57))
        fresh = st.ensure_fresh(tok, c, http=http, env=ENV, now=NOW)
        self.assertEqual(fresh.access_token, "IGQ-new-token")
        self.assertEqual(fresh.access_expires_at, NOW + timedelta(seconds=5184000))
        self.assertEqual(c.rotated, [fresh])
        method, url, kw = http.calls[0]
        self.assertEqual((method, url), ("GET", st.IG_REFRESH_URL))
        self.assertEqual(kw["params"]["grant_type"], "ig_refresh_token")

    def test_not_refreshed_when_younger_than_24h(self):
        c = RecordingClient()
        tok = token("instagram", access_expires_at=NOW + timedelta(days=3), connected_at=NOW - timedelta(hours=2))
        self.assertIs(st.ensure_fresh(tok, c, http=FakeHTTP(), env=ENV, now=NOW), tok)

    def test_expired_marks_account_and_raises_without_token(self):
        c = RecordingClient()
        tok = token("instagram", access_expires_at=NOW - timedelta(minutes=1))
        with self.assertRaises(st.SocialTokenError) as e:
            st.ensure_fresh(tok, c, http=FakeHTTP(), env=ENV, now=NOW)
        self.assertEqual(c.statuses, [("acc-1", "expired")])
        self.assertNotIn(SECRET_A, str(e.exception))


class TiktokRefreshTests(unittest.TestCase):
    def test_refreshes_and_keeps_rotated_refresh_token(self):
        c = RecordingClient()
        http = FakeHTTP(Resp(200, {"access_token": "act.new", "refresh_token": "rft.new",
                                   "expires_in": 86400, "refresh_expires_in": 31536000, "open_id": "o"}))
        tok = token("tiktok", access_expires_at=NOW + timedelta(minutes=2))
        fresh = st.ensure_fresh(tok, c, http=http, env=ENV, now=NOW)
        self.assertEqual((fresh.access_token, fresh.refresh_token), ("act.new", "rft.new"))
        self.assertEqual(c.rotated, [fresh])
        _, url, kw = http.calls[0]
        self.assertEqual(url, st.TT_TOKEN_URL)
        self.assertEqual(kw["data"]["grant_type"], "refresh_token")
        self.assertEqual(kw["data"]["client_key"], "k")

    def test_refused_refresh_marks_expired_and_hides_tokens(self):
        c = RecordingClient()
        http = FakeHTTP(Resp(200, {"error": "invalid_grant", "error_description": SECRET_R}))
        tok = token("tiktok", access_expires_at=NOW - timedelta(minutes=1))
        with self.assertRaises(st.SocialTokenError) as e:
            st.ensure_fresh(tok, c, http=http, env=ENV, now=NOW)
        self.assertEqual(c.statuses, [("acc-1", "expired")])
        self.assertNotIn(SECRET_R, str(e.exception))
        self.assertNotIn(SECRET_A, str(e.exception))

    def test_missing_client_env_is_a_clear_error(self):
        c = RecordingClient()
        tok = token("tiktok", access_expires_at=NOW - timedelta(minutes=1))
        with self.assertRaises(st.SocialTokenError) as e:
            st.ensure_fresh(tok, c, http=FakeHTTP(), env={}, now=NOW)
        self.assertIn("TIKTOK_CLIENT_KEY", str(e.exception))

    def test_valid_access_token_is_not_refreshed(self):
        c = RecordingClient()
        tok = token("tiktok", access_expires_at=NOW + timedelta(hours=5))
        self.assertIs(st.ensure_fresh(tok, c, http=FakeHTTP(), env=ENV, now=NOW), tok)


if __name__ == "__main__":
    unittest.main()
