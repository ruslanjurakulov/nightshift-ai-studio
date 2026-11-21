"""modules/channel_research.py — the worker's side of 0200, with fake HTTP sessions (no network, ever).

What would break without these:

* a YouTube call made before its units were taken, or after the day's budget was refused;
* YouTube's spent quota and a refused API key reported as the same failure (rule 6: opposite remedies);
* a hidden subscriber count stored as a number, or a count YouTube left out stored as 0 (rule 5);
* a competitor reference left pending forever, or "not found" shown as found;
* the 30-day purge never running, or running on every poll;
* the API key or a token in a URL, a log line or a stored error;
* a refresh token sent anywhere but Google's token endpoint;
* the error words here drifting from the database's closed list.
"""

from __future__ import annotations

import logging
import re
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import channel_research as cr  # noqa: E402

KEY = "AIzaFAKEKEYfortestsonly0000000000000000"
REFRESH = "1//fake-refresh-token-value"
ACCESS = "ya29.fake-access-token"
UC1 = "UCaaaaaaaaaaaaaaaaaaaaaa"
UC2 = "UCbbbbbbbbbbbbbbbbbbbbbb"
UC3 = "UCcccccccccccccccccccccc"
NOW = datetime(2026, 11, 21, 12, 0, tzinfo=timezone.utc)


class Resp:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body if body is not None else {}

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class FakeSession:
    """Routes by URL path; records every request (url, params, headers, data)."""

    def __init__(self, routes=None, post=None):
        self.routes = routes or {}
        self.post_answer = post or Resp(200, {"access_token": ACCESS, "expires_in": 3599})
        self.gets = []
        self.posts = []

    def get(self, url, params=None, headers=None, timeout=None):
        self.gets.append(SimpleNamespace(url=url, params=dict(params or {}), headers=dict(headers or {})))
        for suffix, answer in self.routes.items():
            if url.endswith(suffix):
                return answer(params or {}) if callable(answer) else answer
        raise AssertionError(f"unexpected call {url}")

    def post(self, url, data=None, json=None, timeout=None):
        self.posts.append(SimpleNamespace(url=url, data=dict(data or {})))
        return self.post_answer


class FakeStore:
    def __init__(self, allow=True):
        self.allow = allow
        self.takes = []
        self.channels = []
        self.videos = []
        self.resolved = []
        self.topics = []
        self.own = []
        self.finished = []
        self.purges = 0
        self.own_answer = "ok"

    def quota_take(self, project, units, ceiling, org, org_ceiling, source):
        self.takes.append((project, units, ceiling, org, org_ceiling, source))
        return self.allow(source) if callable(self.allow) else self.allow

    def store_channels(self, rows):
        self.channels.extend(rows)

    def store_videos(self, rows):
        self.videos.extend(rows)

    def resolve(self, cid, yid):
        self.resolved.append((cid, yid))
        return "resolved" if yid else "not_found"

    def store_topic(self, rid, ids):
        self.topics.append((rid, list(ids)))
        return True

    def store_own(self, rid, yid, days, metrics):
        self.own.append((rid, yid, days, dict(metrics)))
        return self.own_answer

    def finish(self, rid, worker, status, code, units):
        self.finished.append((rid, status, code, units))
        return True

    def purge(self):
        self.purges += 1
        return {"channels": 2, "videos": 0}

    def claim(self, worker):
        return None


def channel_item(cid, *, hidden=False, subs="1200", views="99000", videos="40", uploads=None):
    stats = {"viewCount": views, "videoCount": videos, "hiddenSubscriberCount": hidden}
    if not hidden:
        stats["subscriberCount"] = subs
    return {"id": cid, "snippet": {"title": f"Channel {cid[-1]}", "customUrl": f"@chan{cid[-1]}"}, "statistics": stats,
            "contentDetails": {"relatedPlaylists": {"uploads": uploads or "UU" + cid[2:]}}}


def video_item(vid, cid, *, likes=True):
    stats = {"viewCount": "500", "commentCount": "4"}
    if likes:
        stats["likeCount"] = "30"
    return {"id": vid, "snippet": {"channelId": cid, "title": "t", "publishedAt": "2026-11-01T00:00:00Z"}, "statistics": stats}


def run(req, session, store, *, key=KEY, credentials=None):
    return cr.process_request(req, store=store, session=session, api_key=key, worker_id="w1",
                              credentials=credentials or (lambda cid: ("", None)), now=NOW)


def topic_req():
    return {"id": 7, "kind": "topic", "topic": "deep sea", "org_id": "org-1", "channel_id": "chan-a"}


class BudgetComesFirst(unittest.TestCase):
    def test_a_refused_budget_means_no_call_at_all(self):
        session, store = FakeSession(), FakeStore(allow=False)
        self.assertEqual(run(topic_req(), session, store), "budget_exhausted")
        self.assertEqual(session.gets, [], "YouTube was called after the budget said no")
        self.assertEqual(store.finished, [(7, "budget_exhausted", "budget", 0)])

    def test_a_search_is_counted_in_its_own_bucket_with_the_approved_caps(self):
        session = FakeSession({"/search": Resp(200, {"items": [{"id": {"channelId": UC1}}]}),
                               "/channels": Resp(200, {"items": [channel_item(UC1)]})})
        store = FakeStore()
        self.assertEqual(run(topic_req(), session, store), "done")
        self.assertEqual(store.takes[0], ("default", 1, 30, "org-1", 3, "research_search"))
        self.assertEqual(store.takes[1], ("default", 1, 1500, "org-1", 300, "research"))
        self.assertEqual(store.topics, [(7, [UC1])])
        # The search bucket counts calls, not shared units: only the channels.list unit is recorded on the request.
        self.assertEqual(store.finished[-1], (7, "done", None, 1))

    def test_the_shared_units_run_out_midway_and_what_was_stored_stays(self):
        session = FakeSession({"/search": Resp(200, {"items": [{"id": {"channelId": UC1}}]})})
        store = FakeStore(allow=lambda source: source == "research_search")
        self.assertEqual(run(topic_req(), session, store), "budget_exhausted")
        self.assertEqual(len(session.gets), 1)


class ErrorsNameTheirRemedy(unittest.TestCase):
    def test_quota_and_a_bad_key_are_different_answers_with_the_same_status(self):
        quota = {"error": {"code": 403, "errors": [{"reason": "quotaExceeded"}]}}
        key = {"error": {"code": 400, "errors": [{"reason": "keyInvalid"}], "status": "INVALID_ARGUMENT"}}
        disabled = {"error": {"code": 403, "errors": [{"reason": "accessNotConfigured"}]}}
        self.assertEqual(cr.error_word(403, quota), "quota")
        self.assertEqual(cr.error_word(400, key), "auth")
        self.assertEqual(cr.error_word(403, disabled), "auth")
        self.assertEqual(cr.error_word(403, {"error": {"errors": [{"reason": "insufficientPermissions"}]}}, oauth=True),
                         "scope_missing")
        self.assertEqual(cr.error_word(401, {}, oauth=True), "token_expired")
        self.assertEqual(cr.error_word(404, {}), "not_found")
        self.assertEqual(cr.error_word(503, {}), "platform_error")
        self.assertEqual(cr.error_word(429, {}), "rate_limited")

    def test_youtubes_quota_ends_the_request_as_budget_exhausted_named_quota(self):
        session = FakeSession({"/search": Resp(403, {"error": {"errors": [{"reason": "quotaExceeded"}]}})})
        store = FakeStore()
        self.assertEqual(run(topic_req(), session, store), "budget_exhausted")
        self.assertEqual(store.finished[-1][1:3], ("budget_exhausted", "quota"))

    def test_a_refused_key_ends_failed_auth(self):
        session = FakeSession({"/search": Resp(400, {"error": {"errors": [{"reason": "keyInvalid"}]}})})
        store = FakeStore()
        run(topic_req(), session, store)
        self.assertEqual(store.finished[-1][1:3], ("failed", "auth"))

    def test_no_key_is_not_configured_before_any_call(self):
        session, store = FakeSession(), FakeStore()
        for req in (topic_req(), {"id": 8, "kind": "competitors", "org_id": "o", "competitors": [
                {"id": "c1", "input_ref": "@x", "ref_kind": "handle", "status": "pending"}]}):
            run(req, session, store, key="")
            self.assertEqual(store.finished[-1][1:3], ("failed", "not_configured"))
        self.assertEqual(session.gets, [])
        self.assertEqual(store.takes, [])

    def test_the_error_words_match_the_database(self):
        sql = (ROOT / "supabase" / "migrations" / "0200_channel_research.sql").read_text(encoding="utf-8")
        body = re.search(r"function public\.research_error_words\(\).*?array\[(.*?)\]", sql, re.S).group(1)
        self.assertEqual(tuple(re.findall(r"'([a-z_]+)'", body)), cr.ERROR_WORDS)


class NumbersAsTheApiGaveThem(unittest.TestCase):
    def test_hidden_subscribers_are_none_with_the_flag(self):
        row = cr.channel_row(channel_item(UC1, hidden=True))
        self.assertIsNone(row["subscriber_count"])
        self.assertTrue(row["subscribers_hidden"])
        self.assertEqual(row["view_count"], 99000)

    def test_a_count_the_api_left_out_is_none_never_zero(self):
        row = cr.video_row(video_item("abcdefghijk", UC1, likes=False))
        self.assertIsNone(row["like_count"])
        self.assertEqual(row["comment_count"], 4)
        item = channel_item(UC1)
        del item["statistics"]["videoCount"]
        self.assertIsNone(cr.channel_row(item)["video_count"])

    def test_analytics_metrics_missing_from_the_report_are_unknown(self):
        session = FakeSession({"/reports": Resp(200, {"columnHeaders": [{"name": "views"}], "rows": [[321]]})})
        got = cr.YouTubeClient(session).analytics(ACCESS, "2026-10-24", "2026-11-20")
        self.assertEqual(got, {"views": 321, "estimatedMinutesWatched": None, "subscribersGained": None, "subscribersLost": None})


class Competitors(unittest.TestCase):
    def req(self, comps):
        return {"id": 3, "kind": "competitors", "org_id": "org-1", "channel_id": "chan-a", "competitors": comps}

    def test_pending_references_resolve_or_end_not_found(self):
        def channels(params):
            if params.get("forHandle") == "@known":
                return Resp(200, {"items": [channel_item(UC1)]})
            if params.get("forHandle") == "@ghost":
                return Resp(200, {"items": []})
            ids = str(params.get("id", "")).split(",")
            return Resp(200, {"items": [channel_item(i) for i in ids if i == UC2]})

        session = FakeSession({"/channels": channels,
                               "/playlistItems": Resp(200, {"items": [{"contentDetails": {"videoId": "abcdefghijk"}}]}),
                               "/videos": Resp(200, {"items": [video_item("abcdefghijk", UC1)]})})
        store = FakeStore()
        status = run(self.req([
            {"id": "c1", "input_ref": "@known", "ref_kind": "handle", "status": "pending"},
            {"id": "c2", "input_ref": "@ghost", "ref_kind": "handle", "status": "pending"},
            {"id": "c3", "input_ref": UC2, "ref_kind": "id", "status": "pending"},
            {"id": "c4", "input_ref": UC3, "ref_kind": "id", "status": "pending"},
        ]), session, store)
        self.assertEqual(status, "done")
        self.assertEqual(sorted(store.resolved), [("c1", UC1), ("c2", None), ("c3", UC2), ("c4", None)])
        # Two handles (1 unit each), one batched id lookup, and 2 units of uploads for each of the two found channels.
        self.assertEqual(len(store.takes), 2 + 1 + 4)
        self.assertEqual(sum(1 for g in session.gets if "id" in g.params and g.url.endswith("/channels")), 1)

    def test_fresh_competitors_are_not_bought_again(self):
        fresh = "2026-11-21T11:30:00+00:00"
        session, store = FakeSession(), FakeStore()
        run(self.req([{"id": "c1", "input_ref": "@x", "ref_kind": "handle", "status": "resolved", "youtube_channel_id": UC1,
                       "channel_fetched_at": fresh, "videos_fetched_at": fresh, "uploads_playlist_id": "UUx"}]), session, store)
        self.assertEqual(session.gets, [])
        self.assertEqual(store.takes, [])
        self.assertEqual(store.finished[-1][1], "done")


class OwnChannel(unittest.TestCase):
    def token_json(self):
        return ('{"refresh_token": "%s", "client_id": "cid.apps.googleusercontent.com", "client_secret": "s3cr3t", '
                '"token_uri": "https://evil.example/token"}' % REFRESH)

    def ctx(self, yid=UC1):
        return SimpleNamespace(credential=SimpleNamespace(youtube_channel_id=yid))

    def routes(self, mine=UC1):
        return {"/channels": Resp(200, {"items": [channel_item(mine)]}),
                "/reports": Resp(200, {"columnHeaders": [{"name": n} for n in ("views", "estimatedMinutesWatched",
                                                                                "subscribersGained", "subscribersLost")],
                                       "rows": [[1000, 2500, 12, 3]]}),
                "/playlistItems": Resp(200, {"items": []})}

    def test_no_token_is_not_connected_and_nothing_is_called(self):
        session, store = FakeSession(), FakeStore()
        run({"id": 1, "kind": "own_channel", "org_id": "o", "channel_id": "chan-a"}, session, store,
            credentials=lambda cid: ("", self.ctx()))
        self.assertEqual(store.finished[-1][1:3], ("not_connected", "not_connected"))
        self.assertEqual((session.gets, session.posts, store.takes), ([], [], []))

    def test_an_unconfirmed_channel_is_not_connected(self):
        def creds(cid):
            raise KeyError(cid)

        store = FakeStore()
        run({"id": 1, "kind": "own_channel", "org_id": "o", "channel_id": "draft"}, FakeSession(), store, credentials=creds)
        self.assertEqual(store.finished[-1][1:3], ("not_connected", "not_connected"))

    def test_the_refresh_token_goes_only_to_google_and_the_numbers_are_stored_as_reported(self):
        session, store = FakeSession(self.routes()), FakeStore()
        status = run({"id": 1, "kind": "own_channel", "org_id": "o", "channel_id": "chan-a"}, session, store, key="",
                     credentials=lambda cid: (self.token_json(), self.ctx()))
        self.assertEqual(status, "done")
        self.assertEqual([p.url for p in session.posts], [cr.TOKEN_URI])
        self.assertEqual(store.own[0][1:3], (UC1, 28))
        self.assertEqual(store.own[0][3], {"views": 1000, "estimatedMinutesWatched": 2500, "subscribersGained": 12,
                                           "subscribersLost": 3})
        report = next(g for g in session.gets if g.url.endswith("/reports"))
        self.assertEqual((report.params["startDate"], report.params["endDate"]), ("2026-10-24", "2026-11-20"))
        self.assertTrue(all(g.headers.get("Authorization") == f"Bearer {ACCESS}" for g in session.gets))

    def test_a_token_for_another_youtube_channel_stores_nothing(self):
        session, store = FakeSession(self.routes(mine=UC2)), FakeStore()
        run({"id": 1, "kind": "own_channel", "org_id": "o", "channel_id": "chan-a"}, session, store,
            credentials=lambda cid: (self.token_json(), self.ctx(UC1)))
        self.assertEqual(store.finished[-1][1:3], ("failed", "channel_mismatch"))
        self.assertEqual((store.channels, store.own), ([], []))

    def test_a_revoked_token_asks_for_a_reconnect(self):
        session = FakeSession(self.routes(), post=Resp(400, {"error": "invalid_grant"}))
        store = FakeStore()
        run({"id": 1, "kind": "own_channel", "org_id": "o", "channel_id": "chan-a"}, session, store,
            credentials=lambda cid: (self.token_json(), self.ctx()))
        self.assertEqual(store.finished[-1][1:3], ("failed", "token_expired"))


class SecretsStayOut(unittest.TestCase):
    def test_the_key_is_a_header_never_a_url_parameter(self):
        session = FakeSession({"/search": Resp(200, {"items": []})})
        run(topic_req(), session, FakeStore())
        call = session.gets[0]
        self.assertEqual(call.headers.get("X-Goog-Api-Key"), KEY)
        self.assertNotIn(KEY, repr(call.params) + call.url)

    def test_a_transport_error_quoting_the_key_reaches_no_log_and_no_stored_word(self):
        class Boom(FakeSession):
            def get(self, url, params=None, headers=None, timeout=None):
                raise ConnectionError(f"failed for {url}?key={KEY} token={ACCESS} refresh={REFRESH}")

        store = FakeStore()
        with self.assertLogs("modules.channel_research", level=logging.INFO) as logs:
            run(topic_req(), Boom(), store)
        self.assertEqual(store.finished[-1][1:3], ("failed", "platform_error"))
        text = "\n".join(logs.output) + repr(store.finished)
        for secret in (KEY, ACCESS, REFRESH):
            self.assertNotIn(secret, text)

    def test_the_token_endpoint_answer_is_never_logged(self):
        session = FakeSession(post=Resp(200, {"access_token": ACCESS}))
        with self.assertNoLogs("modules.channel_research", level=logging.DEBUG):
            tok = cr.access_token(session, '{"refresh_token": "r", "client_id": "c", "client_secret": "s"}')
        self.assertEqual(tok, ACCESS)


class TheThirtyDayPurge(unittest.TestCase):
    def test_purged_each_cycle_at_most_every_ten_minutes(self):
        t = [1000.0]
        store = FakeStore()
        svc = cr.ResearchService("http://x", "k", worker_id="w", credentials=lambda c: ("", None), env={}, store=store,
                                 session=FakeSession(), clock=lambda: t[0])
        svc.run_once()
        svc.run_once()
        self.assertEqual(store.purges, 1)
        t[0] += cr.PURGE_EVERY_SECONDS
        svc.run_once()
        self.assertEqual(store.purges, 2)

    def test_the_service_reads_the_key_from_the_environment(self):
        on = cr.ResearchService("http://x", "k", worker_id="w", credentials=lambda c: ("", None),
                                env={cr.API_KEY_ENV: f"  {KEY} "}, store=FakeStore(), session=FakeSession())
        off = cr.ResearchService("http://x", "k", worker_id="w", credentials=lambda c: ("", None), env={}, store=FakeStore(),
                                 session=FakeSession())
        self.assertEqual((on.configured, off.configured), (True, False))
        self.assertNotIn(KEY, repr(on))


class WiredIntoTheQueueWorker(unittest.TestCase):
    def test_the_worker_runs_it_between_render_jobs_and_survives_it_failing(self):
        from tools import queue_worker as qw

        class Boom:
            def run_once(self):
                raise RuntimeError(f"boom {KEY}")

        class Ran:
            n = 0

            def run_once(self):
                Ran.n += 1
                return True

        stub = SimpleNamespace(claim=lambda *a: None)
        self.assertFalse(qw.Worker(stub, worker_id="w1", env={})._research_one())
        with self.assertLogs("queue_worker", level=logging.WARNING) as logs:
            self.assertFalse(qw.Worker(stub, worker_id="w1", env={}, research=Boom())._research_one())
        self.assertNotIn(KEY, "\n".join(logs.output))
        self.assertTrue(qw.Worker(stub, worker_id="w1", env={}, research=Ran())._research_one())
        self.assertEqual(Ran.n, 1)
        src = (ROOT / "tools" / "queue_worker.py").read_text(encoding="utf-8")
        loop = src[src.index("def run_forever"):src.index("def _publish_one")]
        self.assertLess(loop.index("self._research_one()"), loop.index("self.client.claim("))
        self.assertIn("research=research,", src)
        # The channel's own token is resolved the way a render run resolves it, and nowhere else in this feature.
        self.assertIn("credentials=lambda cid: youtube_publish_credentials(cid, os.environ, token_client))", src)

    def test_nothing_in_research_writes_to_youtube_or_reads_vidiq(self):
        text = (ROOT / "modules" / "channel_research.py").read_text(encoding="utf-8")
        self.assertNotRegex(text, r"\.(post|put|patch|delete)\((?!TOKEN_URI|f\"\{self\.url\}/rest/v1/rpc)")
        self.assertNotIn("VIDIQ", text.upper().replace("VIDIQ IS NOT USED", "").replace("NEVER ON VIDIQ", ""))


class FixRound(unittest.TestCase):
    """Lens / Breach on PR #851: what would break without these."""

    def own_req(self):
        return {"id": 11, "kind": "own_channel", "org_id": "o", "channel_id": "chan-a"}

    def test_own_uploads_carry_their_privacy_and_stay_with_the_channel(self):
        # BR-R-001: the owner's token sees private uploads; each row is marked as the channel's own, with what YouTube reported.
        def videos(params):
            items = [video_item("privateVid1", UC1), video_item("publicVid01", UC1)]
            items[0]["status"] = {"privacyStatus": "private"}
            items[1]["status"] = {"privacyStatus": "public"}
            return Resp(200, {"items": items})

        routes = OwnChannel().routes()
        routes["/playlistItems"] = Resp(200, {"items": [{"contentDetails": {"videoId": "privateVid1"}},
                                                        {"contentDetails": {"videoId": "publicVid01"}}]})
        routes["/videos"] = videos
        session, store = FakeSession(routes), FakeStore()
        run(self.own_req(), session, store, credentials=lambda cid: (OwnChannel().token_json(), OwnChannel().ctx()))
        self.assertEqual({(v["video_id"], v["privacy_status"], v["own_request_id"]) for v in store.videos},
                         {("privateVid1", "private", 11), ("publicVid01", "public", 11)})
        call = next(g for g in session.gets if g.url.endswith("/videos"))
        self.assertIn("status", call.params["part"].split(","))

    def test_a_public_lookup_is_marked_complete_so_vanished_videos_leave_the_cache(self):
        session = FakeSession({"/playlistItems": Resp(200, {"items": []})})
        store = FakeStore()
        run({"id": 3, "kind": "competitors", "org_id": "o", "competitors": [
            {"id": "c1", "input_ref": "@x", "ref_kind": "handle", "status": "resolved", "youtube_channel_id": UC1,
             "channel_fetched_at": "2026-11-21T11:30:00+00:00", "videos_fetched_at": None, "uploads_playlist_id": "UUa"}]},
            session, store)
        self.assertEqual(store.videos, [{"youtube_channel_id": UC1, "complete": True}])

    def test_one_bad_handle_does_not_fail_the_request(self):
        def channels(params):
            if params.get("forHandle") == "@bad":
                return Resp(400, {"error": {"errors": [{"reason": "invalidParameter"}]}})
            return Resp(200, {"items": [channel_item(UC1)]})

        session = FakeSession({"/channels": channels, "/playlistItems": Resp(200, {"items": []})})
        store = FakeStore()
        status = run({"id": 3, "kind": "competitors", "org_id": "o", "competitors": [
            {"id": "c1", "input_ref": "@bad", "ref_kind": "handle", "status": "pending"},
            {"id": "c2", "input_ref": "@good", "ref_kind": "handle", "status": "pending"}]}, session, store)
        self.assertEqual(status, "done")
        self.assertEqual(store.resolved, [("c1", None), ("c2", UC1)])

    def test_a_400_is_auth_only_when_the_reason_says_key(self):
        self.assertEqual(cr.error_word(400, {"error": {"errors": [{"reason": "invalidParameter"}]}}), "platform_error")
        self.assertEqual(cr.error_word(400, {"error": {"errors": [{"reason": "keyInvalid"}]}}), "auth")

    def test_a_wrong_oauth_client_is_the_operators_fix_not_a_reconnect(self):
        session = FakeSession(post=Resp(401, {"error": "invalid_client", "error_description": "secret s3cr3t"}))
        with self.assertRaises(cr.Stop) as e:
            cr.access_token(session, '{"refresh_token": "r", "client_id": "c", "client_secret": "s"}')
        self.assertEqual(e.exception.code, "not_configured")
        session = FakeSession(post=Resp(400, {"error": "invalid_grant"}))
        with self.assertRaises(cr.Stop) as e:
            cr.access_token(session, '{"refresh_token": "r", "client_id": "c", "client_secret": "s"}')
        self.assertEqual(e.exception.code, "token_expired")

    def test_a_search_can_be_made_to_take_shared_units_first(self):
        self.assertEqual([cr.search_shared_units(e) for e in ({}, {"RESEARCH_SEARCH_SHARED_UNITS": "100"},
                                                               {"RESEARCH_SEARCH_SHARED_UNITS": "101"},
                                                               {"RESEARCH_SEARCH_SHARED_UNITS": "x"})], [0, 100, 0, 0])
        store = FakeStore(allow=lambda source: source != "research")
        session = FakeSession()
        status = cr.process_request(topic_req(), store=store, session=session, api_key=KEY, worker_id="w",
                                    credentials=lambda c: ("", None), now=NOW, search_units=100)
        self.assertEqual(status, "budget_exhausted")
        self.assertEqual(store.takes[0][1:], (100, 1500, "org-1", 300, "research"))
        self.assertEqual(session.gets, [], "the search was made after the shared units said no")

    def test_a_readded_competitor_reuses_a_fresh_cache_at_no_cost(self):
        fresh = "2026-11-21T11:30:00+00:00"
        session, store = FakeSession(), FakeStore()
        run({"id": 3, "kind": "competitors", "org_id": "o", "competitors": [
            {"id": "c1", "input_ref": "@rival", "ref_kind": "handle", "status": "pending", "cached_id": UC1,
             "channel_fetched_at": fresh, "videos_fetched_at": fresh, "uploads_playlist_id": "UUa"}]}, session, store)
        self.assertEqual((session.gets, store.takes, store.resolved), ([], [], [("c1", UC1)]))


if __name__ == "__main__":
    unittest.main()
