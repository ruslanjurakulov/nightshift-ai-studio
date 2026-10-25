"""modules/social_x.py (X video posts, DARK) against a real HTTPS server on 127.0.0.1 (tests/loopback_vendor.py) that plays
X, with an ATTACKER listener that must never see a request.

What would break without each group:

* the token goes to the one fixed host and no address from an answer is ever requested, and a redirect is never followed;
* ``POST /2/tweets`` is sent at most once: a lost answer ends as ``publish_unconfirmed``, never as a second post;
* the chunked upload sends exactly the file (segment sizes, indexes, bytes), retries only APPEND, and is capped;
* hostile answers (huge, odd shapes, redirects) end the request with a closed reason word and our own detail;
* nothing X says and no token reaches a reason, a detail or a log line;
* the file and the text are refused BEFORE any request when X cannot take them.

Nothing real is called and no real token exists.
"""

import json
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from modules import publishers
from modules import social_captions as cap
from modules import social_probe as pr
from modules import social_publish as sp
from modules import social_tokens as st
from modules import social_x as xx
from tests.loopback_vendor import FakeVendor, Resp, cleanup_certificate
from tests.test_social_disclosure import event
from tests.test_social_publish import Base, FakeHTTP, FakeStore, FakeTokens
from tests.test_social_publish import Resp as FakeResp

TOKEN = "x-user-token-NOT-REAL-0123456789abcdefXYZ"
MEDIA = "1880000000000000001"
POST = "1880000000000000002"
A = "/2"


def tearDownModule():
    cleanup_certificate()


def tok(**over):
    base = dict(account_id="acc1", org_id="org", platform="x", external_id="12345", access_token=TOKEN)
    base.update(over)
    return st.SocialToken(**base)


def multipart(req):
    """{field: bytes} of a multipart/form-data request the fake received."""
    ctype = req.headers.get("content-type", "")
    boundary = ctype.split("boundary=", 1)[1].strip('"').encode()
    out = {}
    for part in req.body.split(b"--" + boundary):
        if b"Content-Disposition" not in part:
            continue
        head, _, body = part.partition(b"\r\n\r\n")
        name = head.split(b'name="', 1)[1].split(b'"', 1)[0].decode()
        out[name] = body[:-2] if body.endswith(b"\r\n") else body
    return out


def ok_status(state="succeeded", **kw):
    return Resp(200, {"data": {"id": MEDIA, "processing_info": {"state": state, **kw}}})


class FakeX:
    def __init__(self, vendor, *, init=None, appends=None, finalize=None, statuses=None, post=None):
        self.v = vendor
        self.init_resp = init or Resp(200, {"data": {"id": MEDIA, "media_key": "13_" + MEDIA, "expires_after_secs": 86400}})
        self.append_resps = appends or [Resp(204)]
        self.finalize_resp = finalize or Resp(200, {"data": {"id": MEDIA, "size": 1}})
        self.status_resps = statuses or [ok_status()]
        self.post_resp = post or Resp(201, {"data": {"id": POST, "text": "t", "edit_history_post_ids": [POST]}})
        self.post_bodies = []
        vendor.on("POST", f"{A}/media/upload/initialize", lambda r: self.init_resp)
        vendor.on("POST", f"{A}/media/upload/{MEDIA}/append", self._append)
        vendor.on("POST", f"{A}/media/upload/{MEDIA}/finalize", lambda r: self.finalize_resp)
        vendor.on("GET", f"{A}/media/upload", self._status)
        vendor.on("POST", f"{A}/tweets", self._post)

    def _append(self, req):
        return self.append_resps.pop(0) if len(self.append_resps) > 1 else self.append_resps[0]

    def _status(self, req):
        return self.status_resps.pop(0) if len(self.status_resps) > 1 else self.status_resps[0]

    def _post(self, req):
        self.post_bodies.append(req.json())
        return self.post_resp

    def appends(self):
        return self.v.seen("POST", f"{A}/media/upload/{MEDIA}/append")

    def posts(self):
        return self.v.seen("POST", f"{A}/tweets")


class Loop(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "final.mp4"
        self.data = bytes(range(256)) * 40  # 10240 bytes
        self.path.write_bytes(self.data)
        self.vendor, self.evil = FakeVendor(), FakeVendor()
        self.addCleanup(self.vendor.close)
        self.addCleanup(self.evil.close)

    def adapter(self, **kw):
        base = dict(sleep=lambda s: None, poll_seconds=1.0, max_wait=3.0, api=f"{self.vendor.base_url}{A}",
                    segment_bytes=4096)
        base.update(kw)
        return xx.XVideoAdapter(self.vendor.session(), **base)

    def go(self, text="Hello", ai=False, **kw):
        return self.adapter(**kw).publish(tok(), self.path, text, ai_generated=ai)

    def stops(self, **kw):
        with self.assertRaises(sp.PublishStop) as e:
            self.go(**kw)
        self.assert_clean(e.exception)
        return e.exception

    def assert_clean(self, stop):
        text = " ".join([stop.reason, stop.detail, str(stop), repr(stop)])
        self.assertNotIn(TOKEN, text)
        self.assertRegex(stop.reason, r"^[a-z0-9_]{1,64}$")
        self.assertLessEqual(len(stop.detail), 500)

    def evil_untouched(self):
        self.assertEqual(self.evil.requests, [], "the attacker listener got a request")


class HappyPath(Loop):
    def test_init_append_finalize_status_post_in_order_with_the_token_in_the_header_only(self):
        fx = FakeX(self.vendor, finalize=Resp(200, {"data": {"id": MEDIA, "processing_info": {"state": "pending", "check_after_secs": 1}}}),
                   statuses=[ok_status("in_progress", check_after_secs=2), ok_status("succeeded")])
        out = self.go("The Fall of Rome #history")
        self.assertEqual(out, {"result_id": POST, "result_url": f"https://x.com/i/status/{POST}", "privacy": None})
        seq = [(r.method, r.path.split("?")[0]) for r in self.vendor.requests]
        self.assertEqual(seq[0], ("POST", f"{A}/media/upload/initialize"))
        self.assertEqual(seq[1:4], [("POST", f"{A}/media/upload/{MEDIA}/append")] * 3)
        self.assertEqual(seq[4], ("POST", f"{A}/media/upload/{MEDIA}/finalize"))
        self.assertEqual(seq[5:7], [("GET", f"{A}/media/upload")] * 2)
        self.assertEqual(seq[-1], ("POST", f"{A}/tweets"))
        for r in self.vendor.requests:
            self.assertEqual(r.headers.get("authorization"), f"Bearer {TOKEN}", r.path)
            self.assertNotIn(TOKEN, r.path)
            self.assertNotIn(TOKEN.encode(), r.body)
        self.evil_untouched()

    def test_init_body_and_status_query_follow_the_official_page(self):
        fx = FakeX(self.vendor, finalize=Resp(200, {"data": {"processing_info": {"state": "pending"}}}))
        self.go()
        self.assertEqual(self.vendor.seen("POST", f"{A}/media/upload/initialize")[0].json(),
                         {"media_type": "video/mp4", "total_bytes": len(self.data), "media_category": "tweet_video"})
        status = self.vendor.seen("GET", f"{A}/media/upload")[0].path
        self.assertIn("command=STATUS", status)
        self.assertIn(f"media_id={MEDIA}", status)

    def test_the_segments_are_the_file_exactly_indexed_from_zero(self):
        fx = FakeX(self.vendor)
        self.go()
        parts = [multipart(r) for r in fx.appends()]
        self.assertEqual([p["segment_index"] for p in parts], [b"0", b"1", b"2"])
        self.assertEqual(b"".join(p["media"] for p in parts), self.data)
        self.assertEqual([len(p["media"]) for p in parts], [4096, 4096, 10240 - 8192])

    def test_a_file_that_is_one_exact_segment_is_one_append(self):
        self.path.write_bytes(self.data[:4096])
        fx = FakeX(self.vendor)
        self.go()
        self.assertEqual(len(fx.appends()), 1)

    def test_no_processing_info_means_ready_and_no_status_call(self):
        fx = FakeX(self.vendor)
        self.go()
        self.assertEqual(self.vendor.seen("GET", f"{A}/media/upload"), [])

    def test_the_post_has_the_text_and_the_media_and_no_ai_field_unless_labelled(self):
        fx = FakeX(self.vendor)
        self.go("Words #tag", ai=False)
        self.assertEqual(fx.post_bodies[0], {"text": "Words #tag", "media": {"media_ids": [MEDIA]}})

    def test_made_with_ai_true_only_when_labelled(self):
        fx = FakeX(self.vendor)
        self.go(ai=True)
        self.assertIs(fx.post_bodies[0]["made_with_ai"], True)
        self.assertNotIn("nullcast", fx.post_bodies[0])
        self.assertNotIn("reply_settings", fx.post_bodies[0])

    def test_the_heartbeat_beats_for_each_segment_and_while_it_waits(self):
        beats = []
        FakeX(self.vendor, finalize=Resp(200, {"data": {"processing_info": {"state": "pending"}}}),
              statuses=[ok_status("in_progress"), ok_status("succeeded")])
        self.go(heartbeat=lambda: beats.append(1))
        self.assertGreaterEqual(len(beats), 4)

    def test_the_wait_follows_check_after_secs_within_bounds(self):
        slept = []
        FakeX(self.vendor, finalize=Resp(200, {"data": {"processing_info": {"state": "pending", "check_after_secs": 7}}}),
              statuses=[ok_status("in_progress", check_after_secs=0), ok_status("in_progress", check_after_secs=9999),
                        ok_status("succeeded")])
        self.go(sleep=slept.append, max_wait=1000.0)
        self.assertEqual(slept, [7.0, 1.0, 30.0])


class PostIsNeverRetried(Loop):
    def case(self, post):
        fx = FakeX(self.vendor, post=post)
        e = self.stops()
        self.assertEqual(len(fx.posts()), 1, "a post was sent more than once")
        return e

    def test_every_lost_answer_is_unconfirmed_and_sent_once(self):
        for resp in (Resp(drop=True), Resp(500, {"title": "Internal"}), Resp(503), Resp(502, raw=b"<html>"),
                     Resp(201, raw=b"not json"), Resp(201, {}), Resp(201, {"data": {}}), Resp(201, {"data": {"id": "abc"}}),
                     Resp(201, {"data": {"id": ["1"]}}), Resp(201, ["x"]), Resp(200, raw=b"")):
            self.setUp()
            e = self.case(resp)
            self.assertEqual((e.status, e.reason), ("failed", xx.REASON_UNCONFIRMED), resp.raw)
            self.assertIn("check the account's timeline", e.detail)
            self.vendor.close(), self.evil.close()

    def test_a_definite_refusal_is_its_own_word_and_sent_once(self):
        cases = [
            (Resp(401, {"title": "Unauthorized"}), "token_expired"),
            (Resp(402, {"title": "CreditsDepleted"}), xx.REASON_CREDITS),
            (Resp(403, {"detail": "You are not allowed to create a Tweet with duplicate content.", "status": 403}), xx.REASON_DUPLICATE),
            (Resp(403, {"detail": "This user is not allowed to post a video longer than 20 minutes."}), "too_long"),
            (Resp(403, {"detail": "Forbidden"}), xx.REASON_PERMISSION),
            (Resp(429, {"title": "Too Many Requests"}), "rate_limited"),
            (Resp(400, {"type": "https://api.x.com/2/problems/invalid-request"}), "platform_error"),
            (Resp(404, {}), "platform_error"),
        ]
        for resp, want in cases:
            self.setUp()
            e = self.case(resp)
            self.assertEqual((e.status, e.reason), ("failed", want), resp.raw)
            self.vendor.close(), self.evil.close()

    def test_a_redirect_on_the_post_is_not_followed_and_not_retried(self):
        e = self.case(Resp(307, headers={"Location": f"{self.evil.base_url}/steal"}))
        self.assertEqual(e.reason, "platform_error")
        self.assertIn("redirect", e.detail)
        self.evil_untouched()

    def test_a_lost_answer_on_init_posts_nothing_and_says_so(self):
        fx = FakeX(self.vendor, init=Resp(drop=True))
        e = self.stops()
        self.assertEqual(e.reason, "upload_failed")
        self.assertIn("nothing was posted", e.detail)
        self.assertEqual((fx.appends(), fx.posts()), ([], []))

    def test_a_failed_upload_never_reaches_the_post(self):
        for kw in (dict(appends=[Resp(drop=True)]), dict(finalize=Resp(400, {})), dict(statuses=[ok_status("failed")],
                   finalize=Resp(200, {"data": {"processing_info": {"state": "pending"}}}))):
            self.setUp()
            fx = FakeX(self.vendor, **kw)
            self.stops()
            self.assertEqual(fx.posts(), [], kw)
            self.vendor.close(), self.evil.close()


class ChunkedUpload(Loop):
    def test_a_lost_append_is_retried_for_the_same_segment_only(self):
        fx = FakeX(self.vendor, appends=[Resp(drop=True), Resp(503), Resp(204)])
        self.go()
        idx = [multipart(r)["segment_index"] for r in fx.appends()]
        self.assertEqual(idx[:3], [b"0", b"0", b"0"])        # the same segment, three tries
        self.assertEqual(idx[3:], [b"1", b"2"])
        self.assertEqual(len(fx.posts()), 1)

    def test_append_tries_are_bounded(self):
        fx = FakeX(self.vendor, appends=[Resp(drop=True)])
        e = self.stops()
        self.assertEqual(e.reason, "upload_failed")
        self.assertEqual(len(fx.appends()), 3)   # three tries for one segment, then it ends
        self.assertEqual(fx.posts(), [])

    def test_the_failure_names_the_segment_that_did_not_go_through(self):
        fx = FakeX(self.vendor, appends=[Resp(204), Resp(drop=True)])
        e = self.stops()
        self.assertIn("append 1", e.detail)
        self.assertIn("segment 1", e.detail)
        self.assertEqual([multipart(r)["segment_index"] for r in fx.appends()], [b"0", b"1", b"1", b"1"])

    def test_a_refused_append_is_not_retried(self):
        fx = FakeX(self.vendor, appends=[Resp(400, {"type": "https://api.x.com/2/problems/invalid-request"})])
        e = self.stops()
        self.assertEqual(e.reason, "platform_error")
        self.assertEqual(len(fx.appends()), 1)

    def test_a_rate_limited_append_says_when_to_retry(self):
        reset = int(time.time()) + 600
        FakeX(self.vendor, appends=[Resp(429, {}, headers={"x-rate-limit-reset": str(reset)})])
        e = self.stops()
        self.assertEqual(e.reason, "rate_limited")
        self.assertRegex(e.detail, r"about (9|10|11) min")

    def test_hostile_rate_limit_headers_add_nothing(self):
        for value in ("abc", "-5", "1", str(int(time.time()) + 10 ** 7), "9" * 40, ""):
            self.setUp()
            FakeX(self.vendor, appends=[Resp(429, {}, headers={"x-rate-limit-reset": value})])
            e = self.stops()
            self.assertEqual(e.reason, "rate_limited")
            self.assertNotIn("about", e.detail, value)
            self.vendor.close(), self.evil.close()

    def test_a_lost_finalize_is_read_back_with_status_and_never_finalized_twice(self):
        fx = FakeX(self.vendor, finalize=Resp(drop=True), statuses=[ok_status("succeeded")])
        out = self.go()
        self.assertEqual(out["result_id"], POST)
        self.assertEqual(len(self.vendor.seen("POST", f"{A}/media/upload/{MEDIA}/finalize")), 1)
        self.assertEqual(len(self.vendor.seen("GET", f"{A}/media/upload")), 1)

    def test_a_lost_finalize_whose_read_back_fails_ends_the_upload(self):
        fx = FakeX(self.vendor, finalize=Resp(drop=True), statuses=[Resp(500)])
        e = self.stops()
        self.assertEqual(e.reason, "upload_failed")
        self.assertEqual(fx.posts(), [])

    def test_a_file_that_changed_while_it_was_sent_is_not_finalized(self):
        fx = FakeX(self.vendor)
        a = self.adapter()
        orig = a._append_one

        def shrink(tok_, media_id, index, chunk):
            orig(tok_, media_id, index, chunk)
            self.path.write_bytes(self.data[:5000])
        a._append_one = shrink
        with self.assertRaises(sp.PublishStop) as e:
            a.publish(tok(), self.path, "t")
        self.assertEqual(e.exception.reason, "upload_failed")
        self.assertEqual(self.vendor.seen("POST", f"{A}/media/upload/{MEDIA}/finalize"), [])
        self.assertEqual(fx.posts(), [])

    def test_a_file_that_grew_is_cut_at_the_measured_size(self):
        fx = FakeX(self.vendor)
        a = self.adapter()
        orig = a._append_one

        def grow(tok_, media_id, index, chunk):
            orig(tok_, media_id, index, chunk)
            self.path.write_bytes(self.data + b"\xff" * 9999)
        a._append_one = grow
        a.publish(tok(), self.path, "t")
        sent = b"".join(multipart(r)["media"] for r in fx.appends())
        self.assertEqual(sent, self.data)


class ByteCap(Loop):
    def test_a_file_over_the_cap_is_refused_before_any_request(self):
        FakeX(self.vendor)
        e = self.stops(max_bytes=len(self.data) - 1)
        self.assertEqual((e.status, e.reason), ("refused", "too_large"))
        self.assertEqual(self.vendor.requests, [])

    def test_a_file_exactly_at_the_cap_goes(self):
        fx = FakeX(self.vendor)
        self.go(max_bytes=len(self.data))
        self.assertEqual(len(fx.posts()), 1)

    def test_empty_and_missing_files_are_refused_before_any_request(self):
        FakeX(self.vendor)
        self.path.write_bytes(b"")
        self.assertEqual(self.stops().reason, "too_large")
        self.path.unlink()
        self.assertEqual(self.stops().reason, "master_not_available")
        self.assertEqual(self.vendor.requests, [])

    def test_the_hard_cap_is_512_mb(self):
        self.assertEqual(sp.X_MAX_BYTES, 512 * 1024 * 1024)
        self.assertEqual(sp.X_MAX_SECONDS, 1200.0)

    def test_the_default_cap_is_the_publishers_and_a_token_is_required(self):
        self.assertEqual(xx.XVideoAdapter(None).max_bytes, sp.X_MAX_BYTES)
        with self.assertRaises(sp.PublishStop) as e:
            self.adapter().publish(tok(access_token=""), self.path, "t")
        self.assertEqual(e.exception.reason, "account_not_connected")
        self.assertEqual(self.vendor.requests, [])


class OnlyTheFixedHost(Loop):
    def test_no_address_in_an_answer_is_ever_requested(self):
        bait = f"{self.evil.base_url}/steal"
        fx = FakeX(self.vendor,
                   init=Resp(200, {"data": {"id": MEDIA, "upload_url": bait, "url": bait}, "upload_url": bait}),
                   finalize=Resp(200, {"data": {"id": MEDIA, "processing_info": {"state": "pending"}, "url": bait},
                                       "links": [bait]}),
                   statuses=[Resp(200, {"data": {"processing_info": {"state": "succeeded"}, "url": bait}})],
                   post=Resp(201, {"data": {"id": POST, "url": bait}, "links": {"next": bait}}))
        out = self.go()
        self.assertEqual(out["result_url"], f"https://x.com/i/status/{POST}")
        self.evil_untouched()

    def test_the_default_host_is_the_official_one_and_every_call_uses_it(self):
        self.assertEqual(xx.API, "https://api.x.com/2")
        http = FakeHTTP({
            ("POST", f"{xx.API}/media/upload/initialize"): [FakeResp(200, {"data": {"id": MEDIA}})],
            ("POST", f"{xx.API}/media/upload/{MEDIA}/append"): [FakeResp(204)],
            ("POST", f"{xx.API}/media/upload/{MEDIA}/finalize"): [FakeResp(200, {"data": {"id": MEDIA}})],
            ("POST", f"{xx.API}/tweets"): [FakeResp(201, {"data": {"id": POST}})],
        })
        xx.XVideoAdapter(http, sleep=lambda s: None).publish(tok(), self.path, "t")
        for method, url, kw in http.calls:
            self.assertTrue(url.startswith("https://api.x.com/2/"), url)
            self.assertIs(kw.get("allow_redirects"), False, url)
            self.assertEqual(kw["headers"]["Authorization"], f"Bearer {TOKEN}")

    def test_a_redirect_on_any_step_is_never_followed(self):
        def steps(loc):
            return {
                "init": dict(init=Resp(302, headers=loc)),
                "append": dict(appends=[Resp(301, headers=loc)]),
                "finalize": dict(finalize=Resp(308, headers=loc)),
                "status": dict(finalize=Resp(200, {"data": {"processing_info": {"state": "pending"}}}),
                               statuses=[Resp(307, headers=loc)]),
            }
        for name in ("init", "append", "finalize", "status"):
            self.setUp()                     # fresh servers: the Location is built from THIS pair's ports
            kw = steps({"Location": f"{self.evil.base_url}/x"})[name]
            fx = FakeX(self.vendor, **kw)
            e = self.stops()
            self.assertEqual(e.reason, "platform_error", name)
            self.assertIn("redirect", e.detail, name)
            self.evil_untouched()
            self.assertEqual(fx.posts(), [], name)
            self.vendor.close(), self.evil.close()

    def test_ids_must_be_numeric(self):
        for bad in ("../x", "12ab", "", None, ["1"], "1" * 20, "1/append"):
            self.setUp()
            fx = FakeX(self.vendor, init=Resp(200, {"data": {"id": bad}}))
            e = self.stops()
            self.assertEqual(e.reason, "platform_error", repr(bad))
            self.assertEqual(len(self.vendor.requests), 1, repr(bad))   # INIT only: no path was built from the bad id
            self.vendor.close(), self.evil.close()

    def test_the_token_is_not_in_any_path_or_body_for_the_whole_run(self):
        FakeX(self.vendor)
        self.go()
        for r in self.vendor.requests:
            self.assertNotIn(TOKEN, r.path)
            self.assertNotIn(TOKEN.encode(), r.body)


class HostileAnswers(Loop):
    def test_a_huge_answer_is_not_read_to_the_end(self):
        FakeX(self.vendor, init=Resp(200, raw=b'{"data": {"id": "' + b"1" * (3 * 1024 * 1024) + b'"}}'))
        self.assertEqual(self.stops().reason, "upload_failed")

    def test_a_huge_chunked_answer_without_a_length_is_cut_at_the_cap(self):
        FakeX(self.vendor, init=Resp(200, chunks=iter([b'{"a":"' + b"x" * 65536] + [b"y" * 65536] * 40)))
        self.assertEqual(self.stops().reason, "upload_failed")

    #: answers that carry no usable state at all
    ODD = ({"data": {"processing_info": {"state": ["succeeded"]}}}, {"data": {"processing_info": {"state": 7}}},
           {"data": {"processing_info": {}}}, {"data": {"processing_info": "succeeded"}}, {"data": {"processing_info": None}},
           {"data": {"processing_info": []}}, {"data": None}, {"data": {}}, {}, {"errors": [{"message": "x"}]},
           {"data": {"id": MEDIA}}, [], {"data": []})

    def test_a_poll_answer_without_a_usable_state_is_never_ready_and_nothing_is_posted(self):
        """In the poll path a missing processing_info is NOT X's "nothing to process" shape (that is only the first FINALIZE
        answer): it counts as unreadable, three of them end the publish, and no post is made."""
        for doc in self.ODD:
            self.setUp()
            fx = FakeX(self.vendor, finalize=Resp(200, {"data": {"processing_info": {"state": "pending"}}}),
                       statuses=[Resp(200, doc)])
            e = self.stops(max_wait=1000.0)
            self.assertIn(e.reason, ("platform_error", "upload_failed"), doc)
            self.assertEqual(fx.posts(), [], doc)
            self.vendor.close(), self.evil.close()

    def test_a_state_word_that_is_not_succeeded_is_not_ready_either(self):
        for state in ("SUCCEEDED", "done", "succeeded ", "ready", ""):
            self.setUp()
            fx = FakeX(self.vendor, finalize=Resp(200, {"data": {"processing_info": {"state": "pending"}}}),
                       statuses=[Resp(200, {"data": {"processing_info": {"state": state}}})])
            e = self.stops(max_wait=4.0)
            self.assertIn(e.reason, ("timeout", "platform_error"), state)
            self.assertEqual(fx.posts(), [], state)
            self.vendor.close(), self.evil.close()

    def test_after_a_lost_finalize_only_an_explicit_succeeded_is_ready(self):
        for doc in self.ODD:
            self.setUp()
            fx = FakeX(self.vendor, finalize=Resp(drop=True), statuses=[Resp(200, doc)])
            e = self.stops(max_wait=1000.0)
            self.assertIn(e.reason, ("platform_error", "upload_failed"), doc)
            self.assertEqual(fx.posts(), [], doc)
            self.assertEqual(len(self.vendor.seen("POST", f"{A}/media/upload/{MEDIA}/finalize")), 1, doc)
            self.vendor.close(), self.evil.close()

    def test_an_unreadable_first_finalize_answer_is_polled_not_assumed_ready(self):
        for fin in (Resp(200, {"data": None}), Resp(200, {"data": {"processing_info": None}}),
                    Resp(200, {"data": {"processing_info": []}}), Resp(200, {"data": []})):
            self.setUp()
            fx = FakeX(self.vendor, finalize=fin, statuses=[ok_status("succeeded")])
            self.assertEqual(self.go()["result_id"], POST)
            self.assertGreaterEqual(len(self.vendor.seen("GET", f"{A}/media/upload")), 1)   # it asked, then posted
            self.vendor.close(), self.evil.close()

    def test_a_state_that_is_not_a_word_ends_after_three_unreadable_answers_not_at_the_timeout(self):
        for state in (7, ["succeeded"], None, {"a": 1}):
            self.setUp()
            fx = FakeX(self.vendor, finalize=Resp(200, {"data": {"processing_info": {"state": "pending"}}}),
                       statuses=[Resp(200, {"data": {"processing_info": {"state": state}}})])
            e = self.stops(max_wait=1000.0)
            self.assertEqual(e.reason, "platform_error", state)
            self.assertEqual(len(self.vendor.seen("GET", f"{A}/media/upload")), 3, state)  # three unreadable answers, no more
            self.vendor.close(), self.evil.close()

    def test_processing_failed_has_its_word_and_a_timeout_ends_the_wait(self):
        fx = FakeX(self.vendor, finalize=Resp(200, {"data": {"processing_info": {"state": "pending"}}}),
                   statuses=[ok_status("failed", error={"message": f"secret {TOKEN}"})])
        e = self.stops()
        self.assertEqual(e.reason, "processing_failed")
        self.assertNotIn("secret", e.detail)
        self.setUp()
        fx = FakeX(self.vendor, finalize=Resp(200, {"data": {"processing_info": {"state": "pending"}}}),
                   statuses=[ok_status("in_progress")])
        slept = []
        e = self.stops(sleep=slept.append, poll_seconds=1.0, max_wait=3.0)
        self.assertEqual(e.reason, "timeout")
        self.assertEqual(fx.posts(), [])

    def test_what_x_says_is_never_copied_into_the_stop(self):
        words = f"Invalid token {TOKEN} for @victim_account"
        for resp in (Resp(401, {"title": words, "detail": words}), Resp(403, {"detail": words, "type": f"x {words}"}),
                     Resp(400, {"detail": words, "errors": [{"message": words}]}), Resp(402, {"detail": words})):
            self.setUp()
            FakeX(self.vendor, init=resp)
            e = self.stops()
            self.assertNotIn("victim", e.detail)
            self.assertNotIn("Invalid token", e.detail)
            self.vendor.close(), self.evil.close()

    def test_a_connection_that_cannot_be_opened_is_a_failure_with_the_type_only(self):
        from tests.loopback_vendor import closed_port_url
        a = xx.XVideoAdapter(self.vendor.session(), sleep=lambda s: None, api=f"{closed_port_url()}{A}")
        with self.assertRaises(sp.PublishStop) as e:
            a.publish(tok(), self.path, "t")
        self.assert_clean(e.exception)
        self.assertIn("ConnectionError", e.exception.detail)
        self.assertIn("nothing was posted", e.exception.detail)


class StepClock:
    def __init__(self, step):
        self.now, self.step = 0.0, step

    def __call__(self):
        self.now += self.step
        return self.now


class WholePublishDeadline(Loop):
    """One monotonic deadline for upload + processing + post: the queue hands a row whose heartbeat is 30 minutes old to
    another worker, which would upload and post the same video again."""

    def test_the_default_deadline_is_45_minutes_and_read_is_30_seconds(self):
        self.assertEqual(xx.PUBLISH_DEADLINE_SECONDS, 45 * 60.0)
        self.assertEqual(xx.READ_SECONDS, 30.0)

    def test_a_publish_that_runs_out_of_time_in_the_upload_posts_nothing(self):
        fx = FakeX(self.vendor)
        e = self.stops(clock=StepClock(1000.0), deadline_seconds=2500.0, read_seconds=10 ** 9)
        self.assertIn(e.reason, ("timeout", "upload_failed"))       # cut by the deadline while reading, or at the next check
        self.assertEqual(fx.posts(), [])
        self.assertLess(len(fx.appends()), 3)

    def test_the_deadline_between_two_segments_ends_with_timeout_and_nothing_posted(self):
        fx = FakeX(self.vendor)
        a = self.adapter()
        orig = a._append_one

        def then_late(tok_, media_id, index, chunk):
            orig(tok_, media_id, index, chunk)
            a._deadline = a.clock() - 1
        a._append_one = then_late
        with self.assertRaises(sp.PublishStop) as e:
            a.publish(tok(), self.path, "t")
        self.assertEqual(e.exception.reason, "timeout")
        self.assertIn("nothing was posted", e.exception.detail)
        self.assertEqual((len(fx.appends()), fx.posts()), (1, []))

    def test_running_out_of_time_just_before_the_post_posts_nothing(self):
        fx = FakeX(self.vendor)
        a = self.adapter(deadline_seconds=100.0)
        orig = a._post

        def late(tok_, media_id, text, ai):
            a._deadline = a.clock() - 1      # the clock ran out during processing
            return orig(tok_, media_id, text, ai)
        a._post = late
        with self.assertRaises(sp.PublishStop) as e:
            a.publish(tok(), self.path, "t")
        self.assertEqual(e.exception.reason, "timeout")
        self.assertEqual(fx.posts(), [])

    def test_a_calm_clock_lets_the_whole_publish_through(self):
        fx = FakeX(self.vendor)
        self.assertEqual(self.go(clock=StepClock(0.001))["result_id"], POST)

    def test_each_call_is_given_no_more_time_than_the_publish_has_left(self):
        seen = []

        class Http(FakeHTTP):
            def _go(self, method, url, **kw):
                seen.append(kw.get("timeout"))
                return super()._go(method, url, **kw)
        base = xx.API
        http = Http({
            ("POST", f"{base}/media/upload/initialize"): [FakeResp(200, {"data": {"id": MEDIA}})],
            ("POST", f"{base}/media/upload/{MEDIA}/append"): [FakeResp(204)],
            ("POST", f"{base}/media/upload/{MEDIA}/finalize"): [FakeResp(200, {"data": {"id": MEDIA}})],
            ("POST", f"{base}/tweets"): [FakeResp(201, {"data": {"id": POST}})],
        })
        xx.XVideoAdapter(http, sleep=lambda s: None, clock=StepClock(1.0), deadline_seconds=1000.0).publish(tok(), self.path, "t")
        self.assertTrue(seen and all(t is not None and t <= 300 for t in seen))
        seen.clear()
        a = xx.XVideoAdapter(http, sleep=lambda s: None, clock=lambda: 0.0, deadline_seconds=5.0)
        http.routes = {k: v for k, v in http.routes.items()}
        a._deadline = 5.0
        try:
            a.publish(tok(), self.path, "t")
        except Exception:
            pass
        self.assertTrue(all(t <= 5.0 for t in seen[:-1]), seen)   # capped at the 5 s that were left ...
        self.assertEqual(seen[-1], xx.POST_FLOOR_SECONDS)          # ... except the post, which has a floor

    def test_an_answer_that_drips_is_cut_by_the_wall_clock(self):
        slow = Resp(200, chunks=iter([b'{"data": {"id": "', b"1" * 10, b'"}}']))
        fx = FakeX(self.vendor, init=slow)
        e = self.stops(clock=StepClock(50.0), read_seconds=30.0, deadline_seconds=10 ** 9)
        self.assertEqual(e.reason, "upload_failed")
        self.assertEqual(fx.appends(), [])

    def test_the_wait_is_measured_by_the_clock_not_only_by_the_pauses(self):
        """Time inside the 30 s STATUS calls counted for nothing before: sleep is a no-op here, the clock moves 600 s a read."""
        fx = FakeX(self.vendor, finalize=Resp(200, {"data": {"processing_info": {"state": "pending"}}}),
                   statuses=[ok_status("in_progress")])
        e = self.stops(clock=StepClock(600.0), max_wait=1000.0, deadline_seconds=10 ** 9, read_seconds=10 ** 9)
        self.assertEqual(e.reason, "timeout")
        self.assertLessEqual(len(self.vendor.seen("GET", f"{A}/media/upload")), 3)   # the pause counter alone allows 1000
        self.assertEqual(fx.posts(), [])


class AnAnswerThatDrips(Loop):
    """A server that sends a short answer one byte at a time must be cut at the wall-clock limit, not after the whole
    buffer finally fills: ``iter_content(65536)`` waited for 64 KiB, so a 60-byte answer dripping 0.3 s a byte was read for
    18 s against a 2 s limit."""

    def drip(self, delay):
        raw = b'{"data": {"id": "' + MEDIA.encode() + b'"}}'
        return Resp(200, raw=raw, drip_s=delay)

    def test_it_is_cut_near_the_limit_not_after_the_whole_body(self):
        import time as _t
        FakeX(self.vendor, init=self.drip(0.15))
        a = self.adapter(read_seconds=1.0)
        t0 = _t.monotonic()
        with self.assertRaises(sp.PublishStop) as e:
            a.publish(tok(), self.path, "t")
        took = _t.monotonic() - t0
        self.assertEqual(e.exception.reason, "upload_failed")
        self.assertLess(took, 3.0)                  # the body alone would take 40 x 0.15 = 6 s
        self.assertEqual(self.vendor.seen("POST", f"{A}/media/upload/{MEDIA}/append"), [])

    def test_the_same_answer_arriving_fast_enough_is_read(self):
        fx = FakeX(self.vendor, init=self.drip(0.005))
        self.assertEqual(self.go(read_seconds=5.0)["result_id"], POST)


class TheHeartbeatDoesNotExtendTheDeadline(Loop):
    def test_a_beating_heartbeat_still_ends_at_the_whole_publish_deadline(self):
        beats = []
        fx = FakeX(self.vendor, finalize=Resp(200, {"data": {"processing_info": {"state": "pending"}}}),
                   statuses=[ok_status("in_progress")])
        e = self.stops(clock=StepClock(400.0), deadline_seconds=3000.0, max_wait=10 ** 9, read_seconds=10 ** 9,
                       heartbeat=lambda: beats.append(1))
        self.assertIn(e.reason, ("timeout", "upload_failed"))
        self.assertEqual(fx.posts(), [])
        self.assertTrue(beats)                       # it did beat, and it still ended


def gz(doc, coding="gzip"):
    import gzip
    return Resp(200, raw=gzip.compress(json.dumps(doc).encode()), headers={"Content-Encoding": coding})


class AnEncodedAnswerFailsClosed(Loop):
    def test_an_encoded_post_answer_is_unconfirmed_with_exactly_one_post(self):
        fx = FakeX(self.vendor, post=gz({"data": {"id": POST}}))
        e = self.stops()
        self.assertEqual((e.status, e.reason), ("failed", xx.REASON_UNCONFIRMED))
        self.assertIn("Content-Encoding gzip", e.detail)
        self.assertIn("not decoded", e.detail)
        self.assertEqual(len(fx.posts()), 1)

    def test_an_encoded_answer_to_init_or_status_ends_the_upload_with_a_clear_detail_and_posts_nothing(self):
        cases = {"init": dict(init=gz({"data": {"id": MEDIA}})),
                 "status": dict(finalize=Resp(200, {"data": {"processing_info": {"state": "pending"}}}),
                                statuses=[gz({"data": {"processing_info": {"state": "succeeded"}}})])}
        for name, kw in cases.items():
            self.setUp()
            fx = FakeX(self.vendor, **kw)
            e = self.stops()
            self.assertEqual(e.reason, "upload_failed", name)
            self.assertIn("Content-Encoding gzip", e.detail, name)
            self.assertEqual(fx.posts(), [], name)
            self.vendor.close(), self.evil.close()

    def test_an_encoded_append_answer_is_a_lost_answer_and_the_same_segment_is_tried_again(self):
        fx = FakeX(self.vendor, appends=[gz({"ok": 1}), Resp(204)])
        self.assertEqual(self.go()["result_id"], POST)
        self.assertEqual([multipart(r)["segment_index"] for r in fx.appends()][:2], [b"0", b"0"])

    def test_the_header_is_read_case_insensitively_and_odd_values_are_named_unknown(self):
        class R:
            def __init__(self, coding):
                self.headers, self.status_code = {"Content-Encoding": coding}, 200
                self.closed = False

            def close(self):
                self.closed = True
        for coding, word in (("GZIP", "gzip"), (" br ", "br"), ("gzip, br", "unknown"), ("x" * 50, "unknown")):
            r = R(coding)
            with self.assertRaises(xx._Encoded) as e:
                xx._read_doc(r)
            self.assertEqual(e.exception.word, word, coding)
            self.assertTrue(r.closed)

    def test_identity_empty_and_absent_are_read_as_before(self):
        for header in ({"Content-Encoding": "identity"}, {"Content-Encoding": ""}, {}):
            self.setUp()
            FakeX(self.vendor, post=Resp(201, {"data": {"id": POST}}, headers=header))
            self.assertEqual(self.go()["result_id"], POST, header)
            self.vendor.close(), self.evil.close()


class ThePostHasAFloor(Loop):
    def test_the_post_call_gets_at_least_thirty_seconds_when_little_time_is_left(self):
        seen = []

        class Http(FakeHTTP):
            def _go(self, method, url, **kw):
                seen.append((url.rsplit("/", 1)[-1], kw.get("timeout")))
                return super()._go(method, url, **kw)
        base = xx.API
        http = Http({
            ("POST", f"{base}/media/upload/initialize"): [FakeResp(200, {"data": {"id": MEDIA}})],
            ("POST", f"{base}/media/upload/{MEDIA}/append"): [FakeResp(204)],
            ("POST", f"{base}/media/upload/{MEDIA}/finalize"): [FakeResp(200, {"data": {"id": MEDIA}})],
            ("POST", f"{base}/tweets"): [FakeResp(201, {"data": {"id": POST}})],
        })
        a = xx.XVideoAdapter(http, sleep=lambda s: None, clock=lambda: 0.0)
        a._deadline = 1000.0
        orig = a._finalize

        def late(tok_, media_id):
            out = orig(tok_, media_id)
            a._deadline = 2.0                   # two seconds left when the post is made
            return out
        a._finalize = late
        a.publish(tok(), self.path, "t")
        self.assertEqual(seen[-1], ("tweets", 30.0))
        self.assertEqual(xx.POST_FLOOR_SECONDS, 30.0)

    def test_an_answer_that_arrives_after_the_clock_ran_low_is_still_read(self):
        """Without the floor the answer was cut by the nearly spent clock and a made post was reported as unconfirmed."""
        fx = FakeX(self.vendor)
        a = self.adapter(clock=StepClock(0.5), deadline_seconds=1000.0, read_seconds=30.0)
        orig = a._finalize

        def late(tok_, media_id):
            out = orig(tok_, media_id)
            a._deadline = a.clock() + 1.5       # about 1.5 s left at the post; each clock read costs 0.5 s
            return out
        a._finalize = late
        self.assertEqual(a.publish(tok(), self.path, "t")["result_id"], POST)
        self.assertEqual(len(fx.posts()), 1)

    def test_other_calls_are_still_capped_to_the_time_left(self):
        fx = FakeX(self.vendor)
        a = self.adapter(clock=StepClock(0.5), deadline_seconds=1000.0, read_seconds=30.0)
        a._deadline = a.clock() + 0.2
        with self.assertRaises(sp.PublishStop) as e:
            a.publish(tok(), self.path, "t")
        self.assertIn(e.exception.reason, ("timeout", "upload_failed"))
        self.assertEqual(fx.posts(), [])


class HeadersThatDripAreCutByAWallClockWatchdog(Loop):
    def test_a_call_that_never_returns_its_headers_is_a_lost_answer_after_the_watchdog_time(self):
        import time as _t

        class Slow:
            calls = 0

            def post(self, url, **kw):
                Slow.calls += 1
                _t.sleep(2.0)
                raise AssertionError("late")
        a = xx.XVideoAdapter(Slow(), sleep=lambda s: None, header_seconds=0.3)
        t0 = _t.monotonic()
        with self.assertRaises(sp.PublishStop) as e:
            a.publish(tok(), self.path, "t")
        self.assertLess(_t.monotonic() - t0, 1.5)
        self.assertEqual(e.exception.reason, "upload_failed")
        self.assertIn("no answer within", e.exception.detail)
        self.assertEqual(Slow.calls, 1)

    def test_a_post_that_gets_no_answer_in_time_is_unconfirmed_and_not_repeated(self):
        import time as _t
        posts = []
        base = xx.API

        class Http(FakeHTTP):
            def _go(self, method, url, **kw):
                if url.endswith("/tweets"):
                    posts.append(1)
                    _t.sleep(1.5)
                return super()._go(method, url, **kw)
        http = Http({
            ("POST", f"{base}/media/upload/initialize"): [FakeResp(200, {"data": {"id": MEDIA}})],
            ("POST", f"{base}/media/upload/{MEDIA}/append"): [FakeResp(204)],
            ("POST", f"{base}/media/upload/{MEDIA}/finalize"): [FakeResp(200, {"data": {"id": MEDIA}})],
            ("POST", f"{base}/tweets"): [FakeResp(201, {"data": {"id": POST}})],
        })
        a = xx.XVideoAdapter(http, sleep=lambda s: None, header_seconds=0.3)
        with self.assertRaises(sp.PublishStop) as e:
            a.publish(tok(), self.path, "t")
        self.assertEqual(e.exception.reason, xx.REASON_UNCONFIRMED)
        self.assertEqual(posts, [1])

    def test_guarded_call_returns_raises_times_out_and_closes_a_late_response(self):
        import time as _t
        self.assertEqual(st.guarded_call(lambda: 5, 1.0), 5)
        with self.assertRaises(KeyError):
            st.guarded_call(lambda: (_ for _ in ()).throw(KeyError("x")), 1.0)
        closed = []

        class Resp_:
            def close(self):
                closed.append(1)

        def slow():
            _t.sleep(0.4)
            return Resp_()
        with self.assertRaises(st.CallTimedOut):
            st.guarded_call(slow, 0.1)
        _t.sleep(0.8)
        self.assertEqual(closed, [1])             # the response that came late was closed, not used

    def test_the_refresh_has_the_same_watchdog(self):
        import time as _t
        old = st.TOKEN_HEADER_SECONDS
        st.TOKEN_HEADER_SECONDS = 0.2
        try:
            class Slow:
                def post(self, *a, **k):
                    _t.sleep(1.0)
            c = XTokens.Client()
            with self.assertRaises(st.SocialTokenError) as e:
                st.ensure_fresh(tok(access_expires_at=XTokens.NOW, refresh_token="old-refresh-0123456789"), c, http=Slow(),
                                env={"X_CLIENT_ID": "cid"}, now=XTokens.NOW)
            self.assertIn("no answer within", str(e.exception))
            self.assertNotIn("old-refresh", str(e.exception))
        finally:
            st.TOKEN_HEADER_SECONDS = old


class TheRefreshAnswerDripsOrIsHuge(unittest.TestCase):
    def setUp(self):
        self.vendor = FakeVendor()
        self.addCleanup(self.vendor.close)

    def test_a_dripping_refresh_answer_is_cut_near_the_limit(self):
        import time as _t
        body = json.dumps({"access_token": "a" * 20, "refresh_token": "r" * 20, "expires_in": 7200}).encode()
        self.vendor.on("GET", "/d", Resp(200, raw=body, drip_s=0.05))
        r = self.vendor.session().get(self.vendor.base_url + "/d", stream=True)
        t0 = _t.monotonic()
        self.assertEqual(st._bounded_json(r, seconds=0.5), {})
        self.assertLess(_t.monotonic() - t0, 2.0)

    def test_the_same_answer_arriving_fast_is_read(self):
        body = json.dumps({"access_token": "a" * 20, "expires_in": 7200}).encode()
        self.vendor.on("GET", "/f", Resp(200, raw=body))
        r = self.vendor.session().get(self.vendor.base_url + "/f", stream=True)
        self.assertEqual(st._bounded_json(r)["expires_in"], 7200)

    def test_an_answer_over_the_size_cap_is_not_read_to_the_end(self):
        self.vendor.on("GET", "/b", Resp(200, raw=b'{"access_token": "' + b"x" * (st.MAX_TOKEN_ANSWER * 3) + b'"}'))
        r = self.vendor.session().get(self.vendor.base_url + "/b", stream=True)
        self.assertEqual(st._bounded_json(r), {})


class TheRowWriteChain(Base):
    """The post exists. If the row refuses the result, the next best thing is written, and the last resort is the old generic
    worker_error word; nothing escapes."""

    def run_x(self, store, publish_result=None, use_adapter=True):
        http = x_http()
        if use_adapter:
            return self.run_req(store, FakeTokens("x"), platform="x", http=http)
        from unittest import mock
        with mock.patch.object(sp.XPublisher, "publish", return_value=publish_result):
            return self.run_req(store, FakeTokens("x"), platform="x", http=http)

    def store(self, refuse=lambda v: False, raises=lambda v: False):
        outer = self

        class S(FakeStore):
            def update(self, rid, worker_id, values):
                if raises(values):
                    raise ConnectionError("db down")
                if refuse(values):
                    self.rejected = getattr(self, "rejected", []) + [values]
                    return False
                super().update(rid, worker_id, values)
                return True
        return S(video=self.video, http=x_http())

    def test_a_row_that_takes_the_result_is_unchanged(self):
        st_ = self.store()
        self.assertEqual(self.run_x(st_), "published")
        self.assertEqual((st_.final["result_id"], st_.final["privacy"]), (POST, None))

    def test_a_database_that_refuses_the_result_fields_still_gets_published(self):
        st_ = self.store(refuse=lambda v: v.get("status") == "published" and "result_id" in v)
        self.assertEqual(self.run_x(st_), "published")
        self.assertEqual(st_.final["status"], "published")
        self.assertNotIn("result_id", st_.final)
        self.assertNotIn("result_url", st_.final)
        self.assertEqual(len(st_.rejected), 1)

    def test_a_result_that_is_not_a_mapping_still_ends_published_without_fields(self):
        for bad in (None, "post", 5, [POST]):
            st_ = self.store()
            self.assertEqual(self.run_x(st_, publish_result=bad, use_adapter=False), "published", repr(bad))
            self.assertEqual((st_.final["status"], st_.final.get("result_id")), ("published", None), repr(bad))

    def test_result_fields_the_table_would_refuse_are_dropped_before_the_write(self):
        bad = {"result_id": 12345, "result_url": "http://insecure.example/x", "privacy": "p" * 99}
        st_ = self.store()
        self.assertEqual(self.run_x(st_, publish_result=bad, use_adapter=False), "published")
        self.assertEqual((st_.final["result_id"], st_.final["result_url"], st_.final["privacy"]), (None, None, None))
        long_id = {"result_id": "9" * 201, "result_url": "https://x.com/" + "a" * 3000}
        st_ = self.store()
        self.run_x(st_, publish_result=long_id, use_adapter=False)
        self.assertEqual((st_.final["result_id"], st_.final["result_url"]), (None, None))

    def test_when_published_cannot_be_written_the_row_says_unconfirmed_with_the_id(self):
        st_ = self.store(raises=lambda v: v.get("status") == "published")
        self.assertEqual(self.run_x(st_), "failed")
        self.assertEqual((st_.final["status"], st_.final["reason"]), ("failed", "publish_unconfirmed"))
        self.assertEqual((st_.final["result_id"], st_.final["result_url"]), (POST, f"https://x.com/i/status/{POST}"))
        self.assertIn(POST, st_.final["error"])

    def test_when_the_unconfirmed_row_refuses_the_fields_it_is_written_without_them(self):
        st_ = self.store(refuse=lambda v: "result_id" in v, raises=lambda v: v.get("status") == "published" and "result_id" not in v)
        self.assertEqual(self.run_x(st_), "failed")
        self.assertEqual(st_.final["reason"], "publish_unconfirmed")
        self.assertNotIn("result_id", st_.final)
        self.assertIn(POST, st_.final["error"])           # the id survives in the text

    def test_the_last_resort_is_the_old_worker_error_and_nothing_escapes(self):
        st_ = self.store(raises=lambda v: v.get("reason") != "worker_error")
        self.assertEqual(self.run_x(st_), "failed")
        self.assertEqual((st_.final["status"], st_.final["reason"]), ("failed", "worker_error"))
        always = self.store(raises=lambda v: "finished_at" in v)       # every write of an outcome fails
        self.assertEqual(self.run_x(always), "failed")

    def test_exactly_one_post_call_whatever_the_row_does(self):
        http = x_http()
        st_ = self.store(raises=lambda v: v.get("status") == "published")
        self.run_req(st_, FakeTokens("x"), platform="x", http=http)
        self.assertEqual(len([c for c in http.calls if c[1].endswith("/tweets")]), 1)

    def test_the_store_says_whether_the_database_took_the_write(self):
        class S:
            def __init__(self, code):
                self.code = code

            def patch(self, *a, **k):
                code = self.code
                return type("R", (), {"status_code": code})()
        for code, want in ((204, True), (200, True), (400, False), (409, False), (500, False)):
            store = sp.PublishStore("https://x.supabase.co", "svc", session=S(code))
            self.assertIs(store.update(1, "w", {"status": "published"}), want, code)


class NoCompressedAnswers(Loop):
    def test_every_request_asks_for_an_uncompressed_answer(self):
        FakeX(self.vendor, finalize=Resp(200, {"data": {"processing_info": {"state": "pending"}}}),
              statuses=[ok_status("succeeded")])
        self.go()
        for r in self.vendor.requests:
            self.assertEqual(r.headers.get("accept-encoding"), "identity", r.path)


class TheClockIsCheckedBeforeEveryPoll(Loop):
    def test_a_deadline_that_passes_during_a_pause_ends_with_timeout_before_the_next_poll(self):
        fx = FakeX(self.vendor, finalize=Resp(200, {"data": {"processing_info": {"state": "pending"}}}),
                   statuses=[ok_status("in_progress"), ok_status("succeeded")])
        a = self.adapter(max_wait=1000.0)
        a.sleep = lambda s: setattr(a, "_deadline", a.clock() - 1)
        with self.assertRaises(sp.PublishStop) as e:
            a.publish(tok(), self.path, "t")
        self.assertEqual(e.exception.reason, "timeout")
        self.assertEqual(self.vendor.seen("GET", f"{A}/media/upload"), [])      # not even one poll was sent
        self.assertEqual(fx.posts(), [])


class Heartbeats(Loop):
    def test_the_heartbeat_beats_between_append_retries(self):
        beats = []
        FakeX(self.vendor, appends=[Resp(drop=True), Resp(drop=True), Resp(204)])
        self.go(heartbeat=lambda: beats.append(1))
        self.assertGreaterEqual(len(beats), 2 + 3)      # two retries of segment 0, then one per segment

    def test_a_failing_heartbeat_never_stops_the_upload_or_the_wait(self):
        def boom():
            raise RuntimeError("store down")
        FakeX(self.vendor, finalize=Resp(200, {"data": {"processing_info": {"state": "pending"}}}),
              statuses=[ok_status("in_progress"), ok_status("succeeded")])
        self.assertEqual(self.go(heartbeat=boom)["result_id"], POST)


class TypeWordsAreAllowListed(unittest.TestCase):
    class R:
        def __init__(self, status):
            self.status_code, self.headers = status, {}

    def test_only_known_problem_types_reach_the_detail(self):
        token_shaped = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%2FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        for typ in (token_shaped, "https://evil.test/x", "invalid-requestx", "Bearer abc", "https://api.x.com/2/problems/made-up"):
            stop = xx.x_error("post", self.R(400), {"type": typ})
            self.assertEqual(stop.detail, "x post: HTTP 400", typ)
        for typ in sorted(xx.PROBLEM_TYPES):
            stop = xx.x_error("post", self.R(400), {"type": f"https://api.x.com/2/problems/{typ}"})
            self.assertEqual(stop.detail, f"x post: HTTP 400, {typ}")


class BareDomainsAreRemoved(unittest.TestCase):
    def text(self, title="Rome", description="Words."):
        return cap.caption_for("x", cap.SourceMeta(title=title, description=description, tags=("history",)))

    def test_links_and_bare_domains_are_gone(self):
        for bad in ("example.com/a?b=1", "news.bbc.co.uk", "my-site.io", "sub.domain.org/path", "x.ai", "EXAMPLE.COM"):
            t = self.text(description=f"Read more at {bad} today.")
            self.assertNotIn(bad.lower(), t.lower(), bad)
            self.assertNotIn("/", t, bad)          # no path or query is left behind either
            self.assertNotIn("?", t, bad)
            self.assertIn("Read more at", t)

    def test_a_longer_word_that_merely_starts_like_a_domain_name_is_not_cut(self):
        t = self.text(description="Join my.community and see page.compare or site.commercial now.")
        for keep in ("my.community", "page.compare", "site.commercial"):
            self.assertIn(keep, t)

    def test_words_after_a_missing_space_are_not_taken_for_a_domain(self):
        for sentence in ("It was over.It ended well.", "Hello.So what now", "Rome.In 476 it fell.", "He left.To be fair",
                         "Wait.Me too", "The end.Us and them", "Done.By the way", "Fine.De facto", "Sure.Es muy", "Ok.Ca va",
                         "Hello.so what", "Rome.in 476", "story.It was", "Fell.NO way", "Hi.IT is", "A.Is it"):
            self.assertEqual(cap._URL.sub("", sentence), sentence, sentence)

    def test_the_ambiguous_endings_count_only_with_a_slash_a_space_or_the_end(self):
        for gone in ("visit example.it today", "go to a.to, then b.me!", "see foo.in", "x.us/page", "Example.it/x", "my-site.co now",
                     "a.by.", "mail.de)", "site.tr now"):
            out = cap._WS.sub(" ", cap._URL.sub("", gone)).strip()
            self.assertNotRegex(out, r"[a-z0-9-]+\.(it|to|me|in|us|co|by|de|tr)\b", gone)
        for kept in ("example.itself", "foo.into", "bar.users", "a.tomorrow", "x.mexico"):
            self.assertEqual(cap._URL.sub("", kept), kept, kept)

    def test_the_owners_own_domain_and_studio_names_are_stripped(self):
        for domain in ("nightshift-ai.studio", "nightshift-ai.studio/privacy", "my.studio", "https://nightshift-ai.studio/x",
                       "NIGHTSHIFT-AI.STUDIO"):
            t = self.text(description=f"More at {domain} soon.")
            self.assertNotIn("studio", t.lower(), domain)
            self.assertIn("More at", t)

    def test_unambiguous_endings_in_capitals_are_still_stripped_and_mixed_case_endings_are_not(self):
        self.assertEqual(cap._WS.sub(" ", cap._URL.sub("", "see EXAMPLE.COM now")).strip(), "see now")
        self.assertEqual(cap._URL.sub("", "Rome.Com is a word"), "Rome.Com is a word")

    def test_ordinary_text_is_left_alone(self):
        t = self.text(description="It fell.The empire ended in 476, e.g. U.S. scholars agree; mail me@site.com.")
        for keep in ("fell.The", "e.g.", "U.S."):
            self.assertIn(keep, t)

    def test_a_domain_in_the_ai_line_is_removed_too_and_hashtags_with_dots_are_not_touched(self):
        t = cap.caption_for("x", cap.SourceMeta(title="Rome", description="d", tags=("history",)), disclosure="See ai.example.com for more.")
        self.assertNotIn("example.com", t)


class ThePostExistsButTheRowWriteFailed(Base):
    """A post that was made whose final database write failed must not read as a generic worker_error."""

    def test_the_row_says_publish_unconfirmed_with_the_post_id_and_address(self):
        http = x_http()

        class Store(FakeStore):
            def update(self, rid, worker_id, values):
                if values.get("status") == "published":
                    raise ConnectionError("db down https://secret.example/?k=EAAB")
                super().update(rid, worker_id, values)
        store = Store(video=self.video, http=http)
        with self.assertLogs("modules.social_publish", level="WARNING") as logs:
            out = self.run_req(store, FakeTokens("x"), platform="x", http=http)
        self.assertEqual(out, "failed")
        final = store.final
        self.assertEqual((final["status"], final["reason"]), ("failed", "publish_unconfirmed"))
        self.assertEqual((final["result_id"], final["result_url"]), (POST, f"https://x.com/i/status/{POST}"))
        self.assertIn(POST, final["error"])
        self.assertNotIn("secret.example", final["error"] + "\n".join(logs.output))
        self.assertEqual(len([c for c in http.calls if c[1].endswith("/tweets")]), 1)

    def test_when_even_that_write_fails_nothing_escapes(self):
        http = x_http()

        class Store(FakeStore):
            def update(self, rid, worker_id, values):
                if values.get("status") in ("published", "failed"):
                    raise ConnectionError("db down")
                super().update(rid, worker_id, values)
        out = self.run_req(Store(video=self.video, http=http), FakeTokens("x"), platform="x", http=http)
        self.assertEqual(out, "failed")


class XErrorWords(unittest.TestCase):
    class R:
        def __init__(self, status, headers=None):
            self.status_code, self.headers = status, headers or {}

    def test_problem_type_word_only_and_never_a_message(self):
        stop = xx.x_error("post", self.R(400), {"type": "https://api.x.com/2/problems/invalid-request",
                                                "title": "secret words", "detail": "more secret"})
        self.assertEqual(stop.detail, "x post: HTTP 400, invalid-request")
        stop = xx.x_error("post", self.R(400), {"type": "about:blank", "title": "Bad"})
        self.assertEqual(stop.detail, "x post: HTTP 400")
        stop = xx.x_error("post", self.R(400), {"type": "x" * 200})
        self.assertEqual(stop.detail, "x post: HTTP 400")

    def test_the_new_reason_words_are_closed_words_and_listed_for_the_panel(self):
        ts = (Path(__file__).resolve().parent.parent / "command-center" / "lib" / "publish.ts").read_text(encoding="utf-8")
        for word in xx.REASONS:
            self.assertRegex(word, r"^[a-z0-9_]{1,64}$")
            self.assertIn(f'  "{word}",', ts, word)


class XPreChecks(unittest.TestCase):
    def fmt(self, **kw):
        base = dict(duration=30.0, width=1080, height=1920, size=10 * 1024 * 1024)
        base.update(kw)
        sp.check_format("x", sp.VideoInfo(base["duration"], base["width"], base["height"], base["size"]))

    def refuses(self, reason, **kw):
        with self.assertRaises(sp.PublishStop) as e:
            self.fmt(**kw)
        self.assertEqual((e.exception.status, e.exception.reason), ("refused", reason))
        return e.exception.detail

    def test_duration_1_second_to_20_minutes_inclusive(self):
        for d in (1.0, 59.0, 1200.0):
            self.fmt(duration=d)
        self.refuses("too_short", duration=0.9)
        self.assertIn("20:00", self.refuses("too_long", duration=1200.1))
        self.refuses("unknown_duration", duration=None)

    def test_landscape_long_videos_are_fine_for_x(self):
        self.fmt(duration=600.0, width=1920, height=1080)

    def test_size_cap(self):
        self.fmt(size=sp.X_MAX_BYTES)
        self.refuses("too_large", size=sp.X_MAX_BYTES + 1)

    def test_h264_only_and_the_other_platforms_checks_are_unchanged(self):
        good = dict(video_codec="h264", audio_codec="aac", has_audio=True, width=1080, height=1920, fps=30.0, faststart=False)
        pr.check_media("x", pr.MediaFacts(**good))
        for codec in ("hevc", "vp9", "av1", "mpeg4"):
            with self.assertRaises(pr.ProbeRefusal) as e:
                pr.check_media("x", pr.MediaFacts(**{**good, "video_codec": codec}))
            self.assertEqual(e.exception.reason, pr.REASON_CODEC)
        for fps in (61.0, 10.0):
            with self.assertRaises(pr.ProbeRefusal) as e:
                pr.check_media("x", pr.MediaFacts(**{**good, "fps": fps}))
            self.assertEqual(e.exception.reason, pr.REASON_FPS)
        pr.check_media("x", pr.MediaFacts(**{**good, "width": 3840, "height": 2160}))   # no size rule is invented
        pr.check_media("tiktok", pr.MediaFacts(**{**good, "video_codec": "vp9"}))
        pr.check_media("instagram", pr.MediaFacts(**{**good, "faststart": True}))
        with self.assertRaises(pr.ProbeRefusal):
            pr.check_media("instagram", pr.MediaFacts(**good))   # still needs faststart


class XCaption(unittest.TestCase):
    META = cap.SourceMeta(title="The Fall of Rome", description="Why it fell. " * 400 + "https://example.com/a?b=1 www.x.org",
                          tags=("ancient rome", "history", "empire"), niche="history")

    def test_weighted_length_follows_the_post_counting_rules(self):
        self.assertEqual(cap.x_weight("abc"), 3)
        self.assertEqual(cap.x_weight("привет"), 6)      # Cyrillic is in the single-weight range
        self.assertEqual(cap.x_weight("日本"), 4)          # CJK counts double
        self.assertEqual(cap.x_weight("a😀"), 3)          # an emoji counts double

    def test_at_most_280_weighted_two_hashtags_and_no_link(self):
        text = cap.caption_for("x", self.META)
        self.assertLessEqual(cap.x_weight(text), 280)
        self.assertLessEqual(text.count("#"), cap.X_HASHTAGS_DEFAULT)
        self.assertNotIn("http", text)
        self.assertNotIn("www.", text)
        self.assertEqual(text, cap.caption_for("x", self.META))
        self.assertTrue(text.startswith("The Fall of Rome"))

    def test_exactly_two_hashtags_when_the_text_leaves_room(self):
        meta = cap.SourceMeta(title="Rome", description="Short.", tags=("ancient rome", "history", "empire"), niche="x")
        text = cap.caption_for("x", meta)
        self.assertEqual(text.count("#"), 2)
        self.assertEqual(cap.X_HASHTAGS_DEFAULT, 2)

    def test_the_weight_table_edges(self):
        self.assertEqual(cap.x_weight("\u10ff"), 1)
        self.assertEqual(cap.x_weight("\u1100"), 2)       # Hangul Jamo: outside the single-weight ranges
        self.assertEqual(cap.x_weight("\u2000\u200d"), 2)
        self.assertEqual(cap.x_weight("\u200e"), 2)
        self.assertEqual(cap.x_weight("\u2010\u201f"), 2)
        self.assertEqual(cap.x_weight("\u2032\u2037"), 2)
        self.assertEqual(cap.x_weight("\u2038"), 2)

    def test_a_link_in_the_title_is_removed_too(self):
        meta = cap.SourceMeta(title="Watch https://evil.test/x now", description="d")
        self.assertNotIn("http", cap.caption_for("x", meta))

    def test_the_ai_line_is_never_trimmed_away(self):
        line = "This video contains realistic AI-generated or AI-altered content."
        text = cap.caption_for("x", self.META, disclosure=line)
        self.assertIn(line, text)
        self.assertLessEqual(cap.x_weight(text), 280)
        self.assertNotIn(line, cap.caption_for("x", self.META))

    def test_wide_scripts_still_fit(self):
        meta = cap.SourceMeta(title="日本の歴史" * 30, description="説明" * 200, tags=("歴史",))
        self.assertLessEqual(cap.x_weight(cap.caption_for("x", meta)), 280)

    def test_other_platforms_still_dispatch(self):
        self.assertTrue(cap.caption_for("instagram", self.META))
        with self.assertRaises(ValueError):
            cap.caption_for("myspace", self.META)


class XTokens(unittest.TestCase):
    class Client(st.SocialTokenClient):
        def __init__(self):
            super().__init__("https://x.supabase.co", "svc")
            self.statuses, self.rotated = [], []

        def set_status(self, account_id, status):
            self.statuses.append((account_id, status))

        def rotate(self, t):
            self.rotated.append(t)

    class Http:
        def __init__(self, resp):
            self.resp, self.calls = resp, []

        def post(self, url, **kw):
            self.calls.append((url, kw))
            return self.resp

    def r(self, status, body):
        class R:
            status_code = status

            def json(self_):
                return body
        return R()

    NOW = datetime(2026, 10, 25, 12, 0, tzinfo=timezone.utc)

    def test_a_fresh_token_is_used_as_is(self):
        c = self.Client()
        t = tok(access_expires_at=self.NOW + timedelta(hours=1), refresh_token="rt")
        self.assertIs(st.ensure_fresh(t, c, http=self.Http(None), env={}, now=self.NOW), t)
        self.assertEqual(c.rotated, [])

    def test_a_token_near_expiry_is_refreshed_at_the_fixed_host_and_stored(self):
        c = self.Client()
        http = self.Http(self.r(200, {"access_token": "new-access-0123456789", "refresh_token": "new-refresh-0123456789",
                                      "expires_in": 7200, "token_type": "bearer"}))
        t = tok(access_expires_at=self.NOW + timedelta(minutes=3), refresh_token="old-refresh-0123456789")
        out = st.ensure_fresh(t, c, http=http, env={"X_CLIENT_ID": "cid", "X_CLIENT_SECRET": "sec"}, now=self.NOW)
        self.assertEqual((out.access_token, out.refresh_token), ("new-access-0123456789", "new-refresh-0123456789"))
        self.assertEqual(out.access_expires_at, self.NOW + timedelta(seconds=7200))
        self.assertEqual(c.rotated, [out])
        url, kw = http.calls[0]
        self.assertEqual(url, "https://api.x.com/2/oauth2/token")
        self.assertIs(kw["allow_redirects"], False)
        self.assertEqual(kw["data"]["grant_type"], "refresh_token")
        self.assertEqual(kw["data"]["refresh_token"], "old-refresh-0123456789")
        self.assertTrue(kw["headers"]["Authorization"].startswith("Basic "))   # a confidential client
        self.assertNotIn("sec", json.dumps(kw["data"]))

    def test_a_public_client_sends_its_id_in_the_body_and_no_secret(self):
        c = self.Client()
        http = self.Http(self.r(200, {"access_token": "new-access-0123456789", "expires_in": 7200}))
        t = tok(access_expires_at=self.NOW, refresh_token="old-refresh-0123456789")
        out = st.ensure_fresh(t, c, http=http, env={"X_CLIENT_ID": "cid"}, now=self.NOW - timedelta(seconds=1))
        self.assertEqual(out.refresh_token, "old-refresh-0123456789")   # kept when X sends no new one
        url, kw = http.calls[0]
        self.assertEqual(kw["data"]["client_id"], "cid")
        self.assertNotIn("Authorization", kw["headers"])

    def test_refusal_marks_the_account_expired_and_the_error_has_no_secret(self):
        c = self.Client()
        t = tok(access_expires_at=self.NOW - timedelta(minutes=1), refresh_token="old-refresh-0123456789")
        for resp in (self.r(400, {"error": "invalid_request", "error_description": "bad old-refresh-0123456789"}),
                     self.r(200, {}), self.r(200, {"access_token": ""}), self.r(500, {})):
            with self.assertRaises(st.SocialTokenError) as e:
                st.ensure_fresh(t, c, http=self.Http(resp), env={"X_CLIENT_ID": "cid"}, now=self.NOW)
            self.assertNotIn("old-refresh", str(e.exception))
            self.assertNotIn(TOKEN, str(e.exception))
        self.assertIn(("acc1", "expired"), c.statuses)

    def test_no_refresh_token_or_no_client_id_is_said_plainly_and_calls_nothing(self):
        c = self.Client()
        http = self.Http(None)
        with self.assertRaises(st.SocialTokenError) as e:
            st.ensure_fresh(tok(access_expires_at=self.NOW), c, http=http, env={"X_CLIENT_ID": "cid"}, now=self.NOW)
        self.assertIn("reconnect", str(e.exception))
        with self.assertRaises(st.SocialTokenError) as e:
            st.ensure_fresh(tok(access_expires_at=self.NOW, refresh_token="r" * 20), c, http=http, env={}, now=self.NOW)
        self.assertIn("X_CLIENT_ID", str(e.exception))
        self.assertEqual(http.calls, [])

    def test_a_lifetime_that_is_not_a_number_never_loses_the_rotated_pair(self):
        for bad in (float("nan"), float("inf"), 1e30, -5, 0, True, "7200", None, 10 ** 12):
            c = self.Client()
            http = self.Http(self.r(200, {"access_token": "new-access-0123456789", "refresh_token": "new-refresh-0123456789",
                                          "expires_in": bad}))
            t = tok(access_expires_at=self.NOW, refresh_token="old-refresh-0123456789")
            out = st.ensure_fresh(t, c, http=http, env={"X_CLIENT_ID": "cid"}, now=self.NOW - timedelta(seconds=1))
            self.assertEqual(out.refresh_token, "new-refresh-0123456789", bad)
            self.assertEqual(c.rotated, [out], bad)
            self.assertIsNone(out.access_expires_at, bad)

    def test_a_good_lifetime_is_kept(self):
        self.assertEqual(st._lifetime_seconds(7200), 7200)
        self.assertEqual(st._lifetime_seconds(7200.9), 7200)
        self.assertIsNone(st._lifetime_seconds(10 * 365 * 86400 + 1))

    def test_a_huge_refresh_answer_is_not_read_to_the_end(self):
        class Big:
            status_code = 200

            def iter_content(self, chunk_size=0):
                for _ in range(10000):
                    yield b"x" * 8192
                    self.sent = getattr(self, "sent", 0) + 1

            def json(self):
                raise AssertionError("read in full")
        big = Big()
        c = self.Client()
        t = tok(access_expires_at=self.NOW, refresh_token="old-refresh-0123456789")
        with self.assertRaises(st.SocialTokenError):
            st.ensure_fresh(t, c, http=self.Http(big), env={"X_CLIENT_ID": "cid"}, now=self.NOW)
        self.assertLess(getattr(big, "sent", 0), 20)       # stopped near 64 KiB, not 80 MB
        self.assertIn(("acc1", "expired"), c.statuses)

    def test_a_dropped_connection_is_a_plain_error_without_the_message(self):
        class Boom:
            def post(self, *a, **k):
                raise ConnectionError("https://api.x.com/2/oauth2/token?refresh_token=old-refresh-0123456789")
        with self.assertRaises(st.SocialTokenError) as e:
            st.ensure_fresh(tok(access_expires_at=self.NOW, refresh_token="old-refresh-0123456789"), self.Client(),
                            http=Boom(), env={"X_CLIENT_ID": "cid"}, now=self.NOW)
        self.assertNotIn("old-refresh", str(e.exception))
        self.assertIn("ConnectionError", str(e.exception))


class LabelledStore(FakeStore):
    def disclosure_events(self, video_id):
        return [event(generated_clips=2)]


def x_http(*, post=None):
    base = xx.API
    return FakeHTTP({
        ("POST", f"{base}/media/upload/initialize"): [FakeResp(200, {"data": {"id": MEDIA}})],
        ("POST", f"{base}/media/upload/{MEDIA}/append"): [FakeResp(204)],
        ("POST", f"{base}/media/upload/{MEDIA}/finalize"): [FakeResp(200, {"data": {"id": MEDIA}})],
        ("POST", f"{base}/tweets"): [post or FakeResp(201, {"data": {"id": POST}})],
    })


class ThroughTheWorker(Base):
    def run_x(self, http, store=None, tokens=None, info=None, facts=None):
        store = store or FakeStore(video=self.video, http=http)
        out = self.run_req(store, tokens or FakeTokens("x"), platform="x", info=info, http=http, facts=facts)
        return out, store

    def test_the_publisher_is_registered_as_x_and_the_row_ends_published_with_the_post_url(self):
        self.assertIsNotNone(publishers.factory_for("x"))
        http = x_http()
        out, store = self.run_x(http)
        self.assertEqual(out, "published")
        self.assertEqual((store.final["result_id"], store.final["result_url"], store.final["privacy"]),
                         (POST, f"https://x.com/i/status/{POST}", None))
        self.assertTrue(store.updates[0]["caption"].startswith("The Fall of Rome"))
        post = [c for c in http.calls if c[1].endswith("/tweets")][0][2]["json"]
        self.assertNotIn("made_with_ai", post)
        self.assertLessEqual(cap.x_weight(post["text"]), 280)

    def test_made_with_ai_only_when_the_decision_labels_and_the_line_is_in_the_text(self):
        http = x_http()
        out, store = self.run_x(http, store=LabelledStore(video=self.video, http=http))
        post = [c for c in http.calls if c[1].endswith("/tweets")][0][2]["json"]
        self.assertIs(post["made_with_ai"], True)
        self.assertIn("AI-generated", post["text"])

    def test_every_pre_upload_refusal_happens_before_any_http_call(self):
        cases = {
            "too_long": dict(info=sp.VideoInfo(1300.0, 1920, 1080, 2048)),
            "too_short": dict(info=sp.VideoInfo(0.5, 1080, 1920, 2048)),
            "too_large": dict(info=sp.VideoInfo(60.0, 1080, 1920, sp.X_MAX_BYTES + 1)),
            "unknown_duration": dict(info=sp.VideoInfo(None, 1080, 1920, 2048)),
            "bad_codec": dict(facts=pr.MediaFacts("hevc", "aac", True, 1080, 1920, 30.0, True)),
            "bad_framerate": dict(facts=pr.MediaFacts("h264", "aac", True, 1080, 1920, 120.0, True)),
            "unreadable_video": dict(facts=pr.MediaFacts()),
        }
        for want, kw in cases.items():
            http = x_http()
            out, store = self.run_x(http, **kw)
            self.assertEqual((out, store.final["reason"]), ("refused", want), want)
            self.assertEqual(http.calls, [], want)

    def test_an_account_of_another_platform_or_none_is_not_used(self):
        for tokens in (FakeTokens("instagram"), FakeTokens("x", missing=True)):
            http = x_http()
            out, store = self.run_x(http, tokens=tokens)
            self.assertEqual((out, store.final["reason"]), ("refused", "account_not_connected"))
            self.assertEqual(http.calls, [])

    def test_a_lost_post_answer_ends_unconfirmed_with_exactly_one_post_call(self):
        http = x_http(post=FakeResp(503, {}))
        out, store = self.run_x(http)
        self.assertEqual((out, store.final["status"], store.final["reason"]), ("failed", "failed", "publish_unconfirmed"))
        self.assertEqual(len([c for c in http.calls if c[1].endswith("/tweets")]), 1)

    def test_nothing_secret_is_logged_or_recorded(self):
        http = x_http(post=FakeResp(401, {"title": "bad " + TOKEN}))
        with self.assertLogs("modules.social_publish", level="INFO") as logs:
            out, store = self.run_x(http)
        self.assertEqual((out, store.final["reason"]), ("failed", "token_expired"))
        from tests.test_social_publish import TOKEN as OTHER
        blob = json.dumps(store.updates) + "\n".join(logs.output)
        self.assertNotIn(OTHER, blob)

    def test_the_log_line_says_where_it_went(self):
        with self.assertLogs("modules.social_publish", level="INFO") as logs:
            self.run_x(x_http())
        self.assertIn("posted to x account acc1", logs.output[-1])


class DarkMeansUnreachable(unittest.TestCase):
    ROOT = Path(__file__).resolve().parent.parent

    def test_the_migrations_still_do_not_allow_x(self):
        for name in ("0028_social_accounts.sql", "0029_publish_targets.sql"):
            sql = (self.ROOT / "supabase" / "migrations" / name).read_text(encoding="utf-8")
            self.assertNotRegex(sql.lower(), r"""['"]x['"]""", name)

    def test_no_connect_route_or_oauth_config_names_x(self):
        for rel in ("command-center/lib/server/social-oauth.ts", "command-center/lib/server/social-connect.ts",
                    "command-center/lib/social-accounts.ts"):
            text = (self.ROOT / rel).read_text(encoding="utf-8")
            self.assertNotRegex(text, r"""['"`]x['"`]""", rel)
        self.assertFalse((self.ROOT / "command-center" / "app" / "api" / "oauth" / "x").exists())

    def test_the_adapter_reads_no_environment_and_does_not_log(self):
        src = (self.ROOT / "modules" / "social_x.py").read_text(encoding="utf-8")
        for needle in ("os.environ", "getenv", "env.get(", "import os", "logging", "print("):
            self.assertNotIn(needle, src)


if __name__ == "__main__":
    unittest.main()
