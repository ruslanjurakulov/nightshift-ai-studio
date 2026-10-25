"""modules/social_facebook.py (Facebook Reels on a Page, DARK) against a real HTTPS server on 127.0.0.1
(tests/loopback_vendor.py) that plays Meta, and an ATTACKER listener that must never see a request.

What would break without each group:

* the token goes only to the fixed hosts: a vendor-supplied ``upload_url`` (the same class of bug as the BFL polling
  link, tests/test_bfl_polling_link.py) or a redirect would otherwise carry ``Authorization`` to the attacker;
* a lost answer after ``finish`` is read back ONCE and never retried: the Reel cannot be posted twice;
* the upload is resumable from the offset Meta reports, bounded, and never longer than the file measured;
* hostile answers (huge, odd shapes, redirects) end the request with a closed reason word and our own detail;
* nothing the platform says, and no token, reaches a reason, a detail or a log line;
* the file is refused BEFORE any request when Facebook Reels cannot take it.

Nothing real is called and no real token exists.
"""

import json
import logging
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from modules import publishers
from modules import social_captions as cap
from modules import social_facebook as fbk
from modules import social_probe as pr
from modules import social_publish as sp
from modules import social_tokens as st
from tests.loopback_vendor import FakeVendor, Resp, cleanup_certificate
from tests.test_social_disclosure import event
from tests.test_social_publish import Base, FakeHTTP, FakeStore, FakeTokens
from tests.test_social_publish import Resp as FakeResp

TOKEN = "EAAB-fake-page-token-NOT-REAL-0123456789"
PAGE = "109876543210"
VID = "1234567890123"
V = "/" + fbk.GRAPH_VERSION


def tearDownModule():
    cleanup_certificate()


def tok(**over):
    base = dict(account_id="acc1", org_id="org", platform="facebook", external_id=PAGE, access_token=TOKEN)
    base.update(over)
    return st.SocialToken(**base)


def status(video="ready", *, got=None, size=None, publish=None, processing=None, phase=None):
    doc = {"video_status": video}
    if got is not None:
        doc["uploading_phase"] = {"bytes_transfered": got, "status": "in_progress", "source_file_size": size}
    if processing is not None:
        doc["processing_phase"] = {"status": processing}
    if publish is not None or phase is not None:
        doc["publishing_phase"] = {"status": phase or "completed", "publish_status": publish}
    return Resp(200, {"status": doc, "id": VID})


class FakeMeta:
    """Meta on a loopback server. ``finish_calls`` / ``uploads`` / ``starts`` are what the adapter did."""

    def __init__(self, vendor, *, upload_url=None, start=None, uploads=None, statuses=None, finish=None,
                 readback=None):
        self.v = vendor
        self.upload_url = upload_url
        self.start_resp = start
        self.upload_resps = uploads or [Resp(200, {"success": True})]
        self.status_resps = statuses or [status("ready")]
        self.finish_resp = finish or Resp(200, {"success": True})
        self.readback_resps = readback or [status("ready", publish="draft")]
        self.finished = False
        self.finish_bodies = []
        vendor.on("POST", f"{V}/{PAGE}/video_reels", self._reels)
        vendor.on("POST", "/video-upload/", self._upload)
        vendor.on("GET", f"{V}/{VID}", self._status)

    def _reels(self, req):
        body = req.json()
        if body.get("upload_phase") == "start":
            if self.start_resp is not None:
                return self.start_resp
            return Resp(200, {"video_id": VID, "upload_url": self.upload_url or f"{self.v.base_url}/video-upload/{VID}"})
        self.finish_bodies.append(body)
        self.finished = True
        return self.finish_resp

    def _upload(self, req):
        return self.upload_resps.pop(0) if len(self.upload_resps) > 1 else self.upload_resps[0]

    def _status(self, req):
        q = self.readback_resps if self.finished else self.status_resps
        return q.pop(0) if len(q) > 1 else q[0]

    def starts(self):
        return [r for r in self.v.seen("POST", f"{V}/{PAGE}/video_reels") if r.json().get("upload_phase") == "start"]

    def finishes(self):
        return [r for r in self.v.seen("POST", f"{V}/{PAGE}/video_reels") if r.json().get("upload_phase") == "finish"]

    def uploads(self):
        return self.v.seen("POST", "/video-upload/")


class Loop(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "final.mp4"
        self.data = bytes(range(256)) * 12  # 3072 bytes
        self.path.write_bytes(self.data)
        self.vendor, self.evil = FakeVendor(), FakeVendor()
        self.addCleanup(self.vendor.close)
        self.addCleanup(self.evil.close)

    def adapter(self, **kw):
        base = dict(sleep=lambda s: None, poll_seconds=0.0, max_wait=3.0, graph=f"{self.vendor.base_url}{V}",
                    rupload_host="localhost", ports=(self.vendor.port,))
        base.update(kw)
        return fbk.FacebookReelsAdapter(self.vendor.session(), **base)

    def go(self, meta, caption="Hello", ai=False, **kw):
        return self.adapter(**kw).publish(tok(), self.path, caption, ai_generated=ai)

    def stops(self, meta, **kw):
        with self.assertRaises(sp.PublishStop) as e:
            self.go(meta, **kw)
        self.assert_clean(e.exception)
        return e.exception

    def assert_clean(self, stop):
        text = " ".join([stop.reason, stop.detail, str(stop), repr(stop)])
        self.assertNotIn(TOKEN, text)
        self.assertNotIn("EAAB", text)
        self.assertRegex(stop.reason, r"^[a-z0-9_]{1,64}$")
        self.assertLessEqual(len(stop.detail), 500)

    def evil_untouched(self):
        self.assertEqual(self.evil.requests, [], "the attacker listener got a request")

    def tokens_seen(self):
        """Every (path, header value) where the token travelled, on the vendor."""
        out = []
        for r in self.vendor.requests:
            blob = " ".join([r.path, json.dumps(r.headers), r.body[:4096].decode("latin-1")])
            if TOKEN in blob:
                out.append(r)
        return out


class HappyPath(Loop):
    def test_start_upload_ready_finish_in_order_with_the_token_in_the_header_only(self):
        meta = FakeMeta(self.vendor)
        out = self.go(meta, caption="The Fall of Rome\n\n#history")
        self.assertEqual(out, {"result_id": VID, "result_url": None, "privacy": "DRAFT"})
        order = [(r.method, r.path.split("?")[0]) for r in self.vendor.requests]
        self.assertEqual(order[0], ("POST", f"{V}/{PAGE}/video_reels"))
        self.assertEqual(order[1], ("POST", f"/video-upload/{VID}"))
        self.assertEqual(order[2], ("GET", f"{V}/{VID}"))
        self.assertEqual(order[-2][0], "POST")   # the finish, then ONE read-back
        self.assertEqual(order[-1], ("GET", f"{V}/{VID}"))
        self.assertEqual(len(meta.finishes()), 1)
        # the token: Authorization header on every request, never in a URL or a body
        for r in self.vendor.requests:
            self.assertEqual(r.headers.get("authorization"), f"OAuth {TOKEN}", r.path)
            self.assertNotIn(TOKEN, r.path)
            self.assertNotIn(TOKEN.encode(), r.body)
            self.assertNotIn("access_token", r.path)
        self.evil_untouched()

    def test_the_bytes_go_whole_with_offset_zero_and_the_file_size(self):
        meta = FakeMeta(self.vendor)
        self.go(meta)
        up = meta.uploads()[0]
        self.assertEqual(up.body, self.data)
        self.assertEqual((up.headers["offset"], up.headers["file_size"]), ("0", str(len(self.data))))
        self.assertEqual(up.headers["content-type"], "application/octet-stream")

    def test_finish_is_a_draft_with_the_caption_and_no_ai_field_unless_labelled(self):
        meta = FakeMeta(self.vendor)
        self.go(meta, caption="Words #tag", ai=False)
        body = meta.finish_bodies[0]
        self.assertEqual(body, {"upload_phase": "finish", "video_id": VID, "video_state": "DRAFT",
                                "description": "Words #tag"})
        self.assertNotIn("is_ai_generated", body)

    def test_finish_sends_is_ai_generated_true_only_when_labelled(self):
        meta = FakeMeta(self.vendor)
        self.go(meta, ai=True)
        self.assertIs(meta.finish_bodies[0]["is_ai_generated"], True)
        self.assertEqual(meta.finish_bodies[0]["video_state"], "DRAFT")  # a label never widens privacy

    def test_the_state_is_the_constant_draft_and_never_published(self):
        self.assertEqual(fbk.FB_VIDEO_STATE, "DRAFT")

    def test_a_clean_2xx_whose_read_back_cannot_confirm_the_draft_is_unconfirmed_not_published(self):
        for readback in ([Resp(200, {"status": "odd"})], [status("ready")], [Resp(500, {})], [Resp(200, raw=b"x")],
                         [status("ready", publish="odd")], [status("ready", phase="not_started", publish="published ")]):
            self.setUp()
            meta = FakeMeta(self.vendor, readback=readback)
            e = self.stops(meta)
            self.assertEqual((e.status, e.reason), ("failed", fbk.REASON_UNCONFIRMED), readback[0].raw)
            self.assertIn("Meta said success", e.detail)
            self.assertEqual(len(meta.finishes()), 1)
            self.vendor.close(), self.evil.close()

    def test_a_read_back_that_says_live_when_a_draft_was_asked_for_is_loud_and_distinct(self):
        for state in ("published", "scheduled"):
            for finish in (Resp(200, {"success": True}), Resp(drop=True)):
                self.setUp()
                meta = FakeMeta(self.vendor, finish=finish, readback=[status("ready", publish=state)])
                e = self.stops(meta)
                self.assertEqual((e.status, e.reason), ("failed", fbk.REASON_LIVE), state)
                self.assertIn(state.upper(), e.detail)
                self.assertIn(VID, e.detail)
                self.assertIn("check it now", e.detail)
                self.assertEqual(len(meta.finishes()), 1)
                self.vendor.close(), self.evil.close()

    def test_draft_read_back_is_the_only_success(self):
        out = self.go(FakeMeta(self.vendor, readback=[status("ready", publish="draft")]))
        self.assertEqual(out["privacy"], "DRAFT")

    def test_the_wait_for_ready_polls_through_uploading_and_processing(self):
        meta = FakeMeta(self.vendor, statuses=[status("uploading"), status("upload_complete"), status("processing"),
                                               status("ready")])
        self.assertEqual(self.go(meta)["result_id"], VID)
        self.assertEqual(len(meta.finishes()), 1)

    def test_the_heartbeat_beats_while_it_waits(self):
        beats = []
        meta = FakeMeta(self.vendor, statuses=[status("processing"), status("processing"), status("ready")])
        self.go(meta, heartbeat=lambda: beats.append(1))
        self.assertGreaterEqual(len(beats), 2)


class LostAnswerAfterFinish(Loop):
    """The Reel may exist although the answer never came. One read-back, never a second finish."""

    def case(self, finish, readback):
        meta = FakeMeta(self.vendor, finish=finish, readback=readback)
        try:
            out = self.go(meta)
            error = None
        except sp.PublishStop as e:
            self.assert_clean(e)
            out, error = None, e
        self.assertEqual(len(meta.finishes()), 1, "a publish was sent more than once")
        return out, error, meta

    def test_dropped_connection_and_the_read_back_says_draft_is_recorded_as_done(self):
        out, err, _ = self.case(Resp(drop=True), [status("ready", publish="draft")])
        self.assertIsNone(err)
        self.assertEqual((out["result_id"], out["privacy"]), (VID, "DRAFT"))

    def test_a_5xx_answer_with_a_json_body_is_a_lost_answer_not_a_refusal(self):
        out, err, _ = self.case(Resp(500, {"error": {"code": 2, "message": "boom"}}), [status("ready", publish="draft")])
        self.assertIsNone(err)
        self.assertEqual(out["privacy"], "DRAFT")

    def test_a_2xx_that_is_not_success_true_is_read_back(self):
        for resp in (Resp(200, {"success": False}), Resp(200, ["success"]), Resp(200, raw=b"<html>"),
                     Resp(200, {})):
            self.setUp()
            out, err, _ = self.case(resp, [status("ready", publish="draft")])
            self.assertIsNone(err, resp.raw)
            self.assertEqual(out["privacy"], "DRAFT")
            self.vendor.close(), self.evil.close()

    def test_read_back_that_shows_nothing_published_is_unconfirmed_and_never_retried(self):
        for readback in ([status("ready", phase="not_started", publish=None)], [status("ready")],
                         [Resp(500, {})], [Resp(200, raw=b"not json")], [Resp(drop=True)]):
            self.setUp()
            out, err, meta = self.case(Resp(drop=True), readback)
            self.assertIsNone(out)
            self.assertEqual(err.status, "failed")
            self.assertEqual(err.reason, fbk.REASON_UNCONFIRMED)
            self.assertIn("check the Page", err.detail)
            self.assertEqual(len(meta.finishes()), 1)
            self.vendor.close(), self.evil.close()

    def test_read_back_error_phase_is_a_failure(self):
        out, err, _ = self.case(Resp(drop=True), [status("ready", phase="error", publish="error")])
        self.assertEqual((err.status, err.reason), ("failed", "platform_error"))

    def test_hung_answer_is_a_lost_answer(self):
        meta = FakeMeta(self.vendor, finish=Resp(200, {"success": True}, hang_s=2.0),
                        readback=[status("ready", publish="draft")])
        a = self.adapter()
        # the finish call times out after 60 s in production; here the loopback answers late but fine
        self.assertEqual(a.publish(tok(), self.path, "c")["privacy"], "DRAFT")

    def test_a_definite_refusal_of_finish_is_a_failure_with_its_word_and_is_not_read_back(self):
        meta = FakeMeta(self.vendor, finish=Resp(400, {"error": {"code": 100, "message": f"bad {TOKEN}"}}))
        e = self.stops(meta)
        self.assertEqual((e.status, e.reason), ("failed", "platform_error"))
        self.assertEqual(len(meta.finishes()), 1)
        self.assertEqual(len(self.vendor.seen("GET", f"{V}/{VID}")), 1)  # only the wait-for-ready poll, no read-back

    def test_a_redirect_on_finish_is_not_followed_and_not_retried(self):
        meta = FakeMeta(self.vendor, finish=Resp(307, headers={"Location": f"{self.evil.base_url}/steal"}))
        e = self.stops(meta)
        self.assertEqual(e.reason, "platform_error")
        self.assertIn("redirect", e.detail)
        self.assertEqual(len(meta.finishes()), 1)
        self.evil_untouched()

    def test_a_lost_answer_on_start_or_upload_posts_nothing_and_says_so(self):
        meta = FakeMeta(self.vendor, start=Resp(drop=True))
        e = self.stops(meta)
        self.assertEqual(e.reason, "upload_failed")
        self.assertIn("nothing was posted", e.detail)
        self.assertEqual(meta.finishes(), [])
        self.assertEqual(meta.uploads(), [])


class ResumableUpload(Loop):
    def test_a_dropped_upload_resumes_at_the_offset_meta_reports(self):
        meta = FakeMeta(self.vendor, uploads=[Resp(drop=True), Resp(200, {"success": True})],
                        statuses=[status("uploading", got=1000, size=len(self.data)), status("ready")])
        self.go(meta)
        ups = meta.uploads()
        self.assertEqual(len(ups), 2)
        self.assertEqual((ups[1].headers["offset"], ups[1].headers["file_size"]), ("1000", str(len(self.data))))
        self.assertEqual(ups[1].body, self.data[1000:])
        self.assertEqual(len(meta.finishes()), 1)

    def test_offset_invalid_error_resumes_from_the_status_not_from_the_error(self):
        meta = FakeMeta(self.vendor, uploads=[Resp(400, {"debug_info": {"type": "OffsetInvalidError", "retriable": True}}),
                                              Resp(200, {"success": True})],
                        statuses=[status("uploading", got=2048, size=len(self.data)), status("ready")])
        self.go(meta)
        self.assertEqual(meta.uploads()[1].headers["offset"], "2048")

    def test_when_the_status_says_everything_arrived_no_second_upload_is_sent(self):
        meta = FakeMeta(self.vendor, uploads=[Resp(drop=True)],
                        statuses=[status("upload_complete", got=len(self.data), size=len(self.data)), status("ready")])
        self.go(meta)
        self.assertEqual(len(meta.uploads()), 1)

    def test_the_resumes_are_bounded(self):
        meta = FakeMeta(self.vendor, uploads=[Resp(drop=True)], statuses=[status("uploading", got=0, size=len(self.data))])
        e = self.stops(meta)
        self.assertEqual(e.reason, "upload_failed")
        self.assertEqual(len(meta.uploads()), 4)   # the first try and three resumes, the number in the module docstring
        self.assertEqual(meta.finishes(), [])

    def test_an_offset_outside_the_file_or_a_status_without_one_ends_the_upload(self):
        for statuses in ([status("uploading", got=len(self.data) + 1)], [status("uploading", got=-1)],
                         [status("uploading")], [Resp(200, {"status": ["x"]})], [Resp(500, {})]):
            self.setUp()
            meta = FakeMeta(self.vendor, uploads=[Resp(drop=True)], statuses=statuses)
            e = self.stops(meta)
            self.assertEqual(e.reason, "upload_failed", statuses)
            self.assertEqual(len(meta.uploads()), 1)
            self.assertEqual(meta.finishes(), [])
            self.vendor.close(), self.evil.close()

    def test_a_non_resumable_upload_error_is_not_resumed(self):
        meta = FakeMeta(self.vendor, uploads=[Resp(400, {"debug_info": {"type": "ProcessingFailedError"}})])
        e = self.stops(meta)
        self.assertEqual(e.reason, "processing_failed")
        self.assertEqual(len(meta.uploads()), 1)


class ByteCap(Loop):
    def test_a_file_over_the_cap_is_refused_before_any_request(self):
        meta = FakeMeta(self.vendor)
        e = self.stops(meta, max_bytes=len(self.data) - 1)
        self.assertEqual((e.status, e.reason), ("refused", "too_large"))
        self.assertEqual(self.vendor.requests, [])

    def test_a_file_exactly_at_the_cap_goes(self):
        meta = FakeMeta(self.vendor)
        self.go(meta, max_bytes=len(self.data))
        self.assertEqual(len(meta.uploads()), 1)

    def test_an_empty_file_and_a_missing_file_are_refused_before_any_request(self):
        self.path.write_bytes(b"")
        e = self.stops(FakeMeta(self.vendor))
        self.assertEqual(e.reason, "too_large")
        self.path.unlink()
        e = self.stops(FakeMeta(self.vendor))
        self.assertEqual(e.reason, "master_not_available")
        self.assertEqual(self.vendor.requests, [])

    def test_the_body_never_runs_past_the_size_that_was_measured(self):
        """A file that grows between the measurement and the read: the stream stops at the measured end."""
        sl = fbk._Slice(self.path, 100, 600)
        self.path.write_bytes(self.data + b"\xff" * 5000)
        got = b"".join(sl)
        self.assertEqual(got, self.data[100:600])
        self.assertEqual(len(sl), 500)

    def test_a_file_that_shrinks_yields_a_short_body_not_garbage(self):
        sl = fbk._Slice(self.path, 0, len(self.data))
        self.path.write_bytes(self.data[:10])
        self.assertEqual(b"".join(sl), self.data[:10])

    def test_the_default_cap_is_the_publishers_cap_and_it_is_512_mb(self):
        self.assertEqual(fbk.FacebookReelsAdapter(None).max_bytes, sp.FB_MAX_BYTES)
        self.assertEqual(sp.FB_MAX_BYTES, 512 * 1024 * 1024)


class TokenOnlyToTheFixedHosts(Loop):
    def bad_urls(self):
        port = self.evil.port
        vid = VID
        return [
            f"{self.evil.base_url}/video-upload/{vid}",                            # another host entirely
            f"https://localhost:{port}/video-upload/{vid}",                       # right name, the attacker's port
            f"https://127.0.0.1:{port}\\@localhost:{self.vendor.port}/video-upload/{vid}",   # backslash: two parsers
            f"https://127.0.0.1:{port}#@localhost:{self.vendor.port}/video-upload/{vid}",
            f"https://127.0.0.1:{port}?@localhost:{self.vendor.port}/video-upload/{vid}",
            f"https://localhost:{self.vendor.port}@127.0.0.1:{port}/video-upload/{vid}",     # credentials in front
            f"https://localhost.127.0.0.1:{port}/video-upload/{vid}",
            f"http://localhost:{self.vendor.port}/video-upload/{vid}",            # not https
            f"https://user:pw@localhost:{self.vendor.port}/video-upload/{vid}",
            f"{self.vendor.base_url}/other/{vid}",                                # the right host, not an upload path
            f"{self.vendor.base_url}/video-upload/99999",                         # an upload for another video
            f"{self.vendor.base_url}/video-upload/{vid}x",
            f"https://@localhost:{self.vendor.port}/video-upload/{vid}",          # an empty userinfo
            f"{self.vendor.base_url}/video-upload/{vid}?x=1",                    # a query
            f"{self.vendor.base_url}/video-upload/{vid}#frag",
            f"https://up.localhost:{self.vendor.port}/video-upload/{vid}",        # a subdomain of the host
            f"{self.vendor.base_url}/video-upload/v26.0/{vid}/x",
            f"{self.vendor.base_url}/video-upload//{vid}",
            "", None, 5, ["https://x"], {"u": 1},
        ]

    def test_an_upload_address_that_is_not_the_fixed_host_gets_no_token_and_no_bytes(self):
        for i in range(len(self.bad_urls())):
            self.setUp()                     # fresh servers: the address is built from THIS pair's ports
            url = self.bad_urls()[i]
            meta = FakeMeta(self.vendor, start=Resp(200, {"video_id": VID, "upload_url": url}))
            e = self.stops(meta)
            self.assertEqual((e.status, e.reason), ("failed", "platform_error"), repr(url))
            self.assertIn("token was not sent", e.detail, repr(url))
            self.assertEqual(meta.uploads(), [], repr(url))
            self.assertEqual(meta.finishes(), [], repr(url))
            self.evil_untouched()
            # the start call itself went to the fixed API host with the header; nothing else did
            self.assertEqual(len(self.vendor.requests), 1, repr(url))
            self.vendor.close(), self.evil.close()

    def test_the_vendors_own_good_addresses_do_pass_the_same_check(self):
        """The negative cases above are only worth something if the positive ones work on the same servers."""
        for tail in (f"/video-upload/{VID}", f"/video-upload/{VID}/", f"/video-upload/v26.0/{VID}"):
            self.setUp()
            meta = FakeMeta(self.vendor, start=Resp(200, {"video_id": VID,
                                                         "upload_url": f"https://localhost:{self.vendor.port}{tail}"}))
            self.assertEqual(self.go(meta)["result_id"], VID, tail)
            self.assertEqual(len(meta.uploads()), 1, tail)
            self.vendor.close(), self.evil.close()

    def test_the_production_hosts_are_the_official_ones_and_a_lookalike_is_refused(self):
        http = FakeHTTP({("POST", fbk.GRAPH): [FakeResp(200, {"video_id": VID,
                         "upload_url": f"https://rupload.facebook.com.evil.test/video-upload/{VID}"})]})
        with self.assertRaises(sp.PublishStop) as e:
            fbk.FacebookReelsAdapter(http, sleep=lambda s: None).publish(tok(), self.path, "c")
        self.assertIn("token was not sent", e.exception.detail)
        self.assertEqual([c[1] for c in http.calls], [f"{fbk.GRAPH}/{PAGE}/video_reels"])
        self.assertEqual(fbk.GRAPH, "https://graph.facebook.com/" + fbk.GRAPH_VERSION)
        self.assertEqual(fbk.RUPLOAD_HOST, "rupload.facebook.com")

    def test_the_official_upload_address_passes(self):
        http = FakeHTTP({
            ("POST", fbk.GRAPH): [FakeResp(200, {"video_id": VID, "upload_url": f"https://rupload.facebook.com/video-upload/{VID}"}),
                                  FakeResp(200, {"success": True})],
            ("POST", "https://rupload.facebook.com/video-upload/"): [FakeResp(200, {"success": True})],
            ("GET", f"{fbk.GRAPH}/{VID}"): [FakeResp(200, {"status": {"video_status": "ready",
                                                           "publishing_phase": {"publish_status": "draft"}}})],
        })
        out = fbk.FacebookReelsAdapter(http, sleep=lambda s: None).publish(tok(), self.path, "c")
        self.assertEqual(out["privacy"], "DRAFT")
        for method, url, kw in http.calls:
            self.assertTrue(url.startswith("https://graph.facebook.com/") or url.startswith("https://rupload.facebook.com/"), url)
            self.assertIs(kw.get("allow_redirects"), False, url)
            self.assertEqual(kw["headers"]["Authorization"], f"OAuth {TOKEN}")

    def test_a_redirect_on_any_step_is_never_followed(self):
        def steps(loc):
            return {
                "start": dict(start=Resp(302, headers=loc)),
                "upload": dict(uploads=[Resp(301, headers=loc)]),
                "status": dict(statuses=[Resp(308, headers=loc)]),
            }
        for name in ("start", "upload", "status"):
            self.setUp()
            kw = steps({"Location": f"{self.evil.base_url}/x"})[name]
            meta = FakeMeta(self.vendor, **kw)
            e = self.stops(meta)
            self.assertEqual(e.reason, "platform_error", name)
            self.assertIn("redirect", e.detail, name)
            self.evil_untouched()
            self.assertEqual(meta.finishes(), [], name)
            self.vendor.close(), self.evil.close()

    def test_the_token_is_in_no_url_and_no_body_for_the_whole_run(self):
        meta = FakeMeta(self.vendor)
        self.go(meta)
        for r in self.tokens_seen():
            blob = " ".join([r.path, r.body[:4096].decode("latin-1")])
            self.assertNotIn(TOKEN, blob)

    def test_the_page_id_must_be_digits(self):
        for bad in ("", "me", "../1", "12 34", "1" * 31, "1;x"):
            with self.assertRaises(sp.PublishStop) as e:
                self.adapter().publish(tok(external_id=bad), self.path, "c")
            self.assertEqual((e.exception.status, e.exception.reason), ("refused", "account_not_connected"))
        self.assertEqual(self.vendor.requests, [])


class HostileAnswers(Loop):
    def test_a_huge_answer_is_not_read_to_the_end(self):
        huge = Resp(200, raw=b'{"video_id": "' + b"1" * (3 * 1024 * 1024) + b'"}')
        meta = FakeMeta(self.vendor, start=huge)
        e = self.stops(meta)
        self.assertEqual(e.reason, "upload_failed")
        self.assertEqual(meta.uploads(), [])

    def test_a_huge_answer_without_a_content_length_is_cut_at_the_cap(self):
        meta = FakeMeta(self.vendor, start=Resp(200, chunks=iter([b'{"a":"' + b"x" * 65536] + [b"y" * 65536] * 40)))
        e = self.stops(meta)
        self.assertEqual(e.reason, "upload_failed")

    def test_odd_start_answers_end_the_request_without_an_upload(self):
        for doc in ({"video_id": None}, {"video_id": ["1"]}, {"video_id": "../etc"}, {"video_id": "12ab"}, {},
                    {"video_id": VID}, {"video_id": 5, "upload_url": 5}, [1, 2], "x", 3, None):
            self.setUp()
            meta = FakeMeta(self.vendor, start=Resp(200, doc))
            e = self.stops(meta)
            self.assertIn(e.reason, ("platform_error", "upload_failed"), doc)
            self.assertEqual(meta.uploads(), [], doc)
            self.vendor.close(), self.evil.close()

    def test_odd_status_shapes_never_pass_as_ready_and_end_in_a_bounded_wait(self):
        for doc in ({"status": "ready"}, {"status": {"video_status": ["ready"]}}, {"status": {"video_status": 7}},
                    {"status": None}, {}, [], {"status": {"video_status": "READY"}}, {"status": {"video_status": "ready "}}):
            self.setUp()
            meta = FakeMeta(self.vendor, statuses=[Resp(200, doc)])
            e = self.stops(meta)
            self.assertIn(e.reason, ("platform_error", "timeout", "upload_failed"), doc)
            self.assertEqual(meta.finishes(), [], doc)
            self.vendor.close(), self.evil.close()

    def test_a_status_that_never_gets_ready_times_out(self):
        meta = FakeMeta(self.vendor, statuses=[status("processing")])
        slept = []
        e = self.stops(meta, sleep=slept.append, poll_seconds=1.0, max_wait=3.0)
        self.assertEqual(e.reason, "timeout")
        self.assertEqual(len(slept), 3)
        self.assertEqual(meta.finishes(), [])

    def test_processing_and_upload_failures_have_their_words(self):
        cases = {"error": "processing_failed", "upload_failed": "upload_failed", "expired": "upload_failed"}
        for vs, reason in cases.items():
            self.setUp()
            meta = FakeMeta(self.vendor, statuses=[status(vs)])
            e = self.stops(meta)
            self.assertEqual(e.reason, reason, vs)
            self.assertEqual(meta.finishes(), [], vs)
            self.vendor.close(), self.evil.close()
        self.setUp()
        meta = FakeMeta(self.vendor, statuses=[status("processing", processing="error")])
        self.assertEqual(self.stops(meta).reason, "processing_failed")

    def test_what_the_platform_says_is_never_copied_into_the_stop(self):
        secret_words = f"Invalid OAuth access token {TOKEN} for user 'victim@example.com'"
        for resp in (Resp(401, {"error": {"message": secret_words, "type": "OAuthException", "code": 190}}),
                     Resp(400, {"error": {"message": secret_words, "code": 100, "error_subcode": 1363127}}),
                     Resp(403, {"error": {"message": secret_words, "code": 200}}),
                     Resp(400, {"debug_info": {"type": f"X {secret_words}", "message": secret_words}})):
            self.setUp()
            meta = FakeMeta(self.vendor, start=resp)
            e = self.stops(meta)
            self.assertNotIn("victim", e.detail)
            self.assertNotIn("OAuth access token", e.detail)
            self.vendor.close(), self.evil.close()

    def test_a_connection_that_cannot_be_opened_is_a_failure_with_the_type_only(self):
        from tests.loopback_vendor import closed_port_url
        a = fbk.FacebookReelsAdapter(self.vendor.session(), sleep=lambda s: None, graph=f"{closed_port_url()}{V}")
        with self.assertRaises(sp.PublishStop) as e:
            a.publish(tok(), self.path, "c")
        self.assert_clean(e.exception)
        self.assertIn("nothing was posted", e.exception.detail)
        self.assertIn("ConnectionError", e.exception.detail)


class StepClock:
    """A clock that moves ``step`` seconds every time it is read."""

    def __init__(self, step):
        self.now, self.step = 0.0, step

    def __call__(self):
        self.now += self.step
        return self.now


class LongUploadsKeepTheRowAlive(Loop):
    """The queue gives a row whose heartbeat is older than 30 minutes (0029) to another worker, which would upload and
    post the same video again while this one went on. A slow upload must beat while the bytes are sent."""

    def test_the_slice_beats_at_most_once_per_interval_while_it_is_read(self):
        beats, clock = [], StepClock(30.0)
        sl = fbk._Slice(self.path, 0, len(self.data), beat=lambda: beats.append(1), clock=clock, every=60.0)
        got = b"".join(iter(lambda: sl.read(256), b""))
        self.assertEqual(got, self.data)
        reads = len(self.data) // 256 + 1
        self.assertGreaterEqual(len(beats), reads // 2 - 1)
        self.assertLessEqual(len(beats), reads // 2 + 1)        # every second read at 30 s a read, never every read

    def test_a_fast_upload_does_not_beat_at_all(self):
        beats = []
        sl = fbk._Slice(self.path, 0, len(self.data), beat=lambda: beats.append(1), clock=StepClock(0.001), every=60.0)
        b"".join(iter(lambda: sl.read(256), b""))
        self.assertEqual(beats, [])

    def test_a_failing_heartbeat_never_stops_the_upload(self):
        def boom():
            raise RuntimeError("store down")
        sl = fbk._Slice(self.path, 0, len(self.data), beat=boom, clock=StepClock(100.0), every=60.0)
        self.assertEqual(b"".join(iter(lambda: sl.read(256), b"")), self.data)

    def test_the_real_upload_beats_while_the_bytes_go_not_only_after_a_failure(self):
        beats = []
        meta = FakeMeta(self.vendor)
        a = self.adapter(clock=StepClock(61.0), heartbeat=lambda: beats.append(len(self.vendor.requests)),
                         max_wait=10 ** 9, read_seconds=10 ** 9)
        a.publish(tok(), self.path, "c")
        # the upload request is logged by the fake only after its whole body arrived: a beat made while only the START
        # request is logged was made during the upload
        self.assertIn(1, beats)
        self.assertEqual(len(meta.finishes()), 1)

    def test_the_default_interval_is_a_minute_far_inside_the_30_minute_limit(self):
        self.assertEqual(fbk.BEAT_EVERY_SECONDS, 60.0)
        self.assertEqual(fbk.FacebookReelsAdapter(None).beat_every, 60.0)


class WallClockLimits(Loop):
    def test_an_answer_that_drips_forever_is_cut_by_the_wall_clock_not_only_by_size(self):
        slow = Resp(200, chunks=iter([b'{"video_id": "', b"1" * 10, b'"}']))
        meta = FakeMeta(self.vendor, start=slow)
        e = self.stops(meta, clock=StepClock(50.0), read_seconds=30.0)
        self.assertEqual(e.reason, "upload_failed")
        self.assertEqual(meta.uploads(), [])

    def test_the_same_answer_is_read_when_the_clock_is_calm(self):
        meta = FakeMeta(self.vendor, start=Resp(200, chunks=iter([b'{"video_id": "', VID.encode(), b'", "upload_url": "',
                                                                  f"{self.vendor.base_url}/video-upload/{VID}".encode(), b'"}'])))
        self.assertEqual(self.go(meta)["result_id"], VID)

    def test_the_wait_for_ready_has_a_total_wall_clock_deadline_too(self):
        meta = FakeMeta(self.vendor, statuses=[status("processing")])
        e = self.stops(meta, clock=StepClock(600.0), max_wait=1000.0, poll_seconds=0.0, read_seconds=10 ** 9)
        self.assertEqual(e.reason, "timeout")
        self.assertLessEqual(len(self.vendor.seen("GET", f"{V}/{VID}")), 3)   # the pause counter alone would allow 1000
        self.assertEqual(meta.finishes(), [])


class NoCompressedAnswers(Loop):
    def test_every_request_asks_for_an_uncompressed_answer(self):
        meta = FakeMeta(self.vendor)
        self.go(meta)
        for r in self.vendor.requests:
            self.assertEqual(r.headers.get("accept-encoding"), "identity", r.path)


class ErrorWords(unittest.TestCase):
    class R:
        def __init__(self, status, headers=None):
            self.status_code, self.headers = status, headers or {}

    def word(self, status, doc, headers=None):
        stop = fbk.graph_error("x", self.R(status, headers), doc)
        self.assertEqual(stop.status, "failed")
        self.assertNotIn(TOKEN, stop.detail)
        return stop.reason

    def test_the_closed_words(self):
        table = [
            (401, {"error": {"code": 190}}, "token_expired"),
            (400, {"error": {"code": 102}}, "token_expired"),
            (401, None, "token_expired"),
            (403, {"error": {"code": 10}}, fbk.REASON_PERMISSION),
            (403, {"error": {"code": 200}}, fbk.REASON_PERMISSION),
            (403, {"error": {"code": 299}}, fbk.REASON_PERMISSION),
            (400, {"error": {"code": 4}}, "rate_limited"),
            (400, {"error": {"code": 17}}, "rate_limited"),
            (400, {"error": {"code": 32}}, "rate_limited"),
            (400, {"error": {"code": 613}}, "rate_limited"),
            (400, {"error": {"code": 80001}}, "rate_limited"),
            (400, {"error": {"code": 80000}}, "rate_limited"),
            (400, {"error": {"code": 80014}}, "rate_limited"),
            (429, None, "rate_limited"),
            (400, {"error": {"code": 100, "error_subcode": 1363040}}, "bad_aspect"),
            (400, {"error": {"code": 1363127}}, pr.REASON_TOO_SMALL),
            (400, {"error": {"code": 100, "error_subcode": 1363129}}, "bad_framerate"),
            (400, {"debug_info": {"type": "ProcessingFailedError"}}, "processing_failed"),
            (400, {"error": {"code": 100}}, "platform_error"),
            (400, {"error": "x"}, "platform_error"),
            (404, None, "platform_error"),
            (400, {"error": {"code": True}}, "platform_error"),
            (400, {"error": {"code": "190"}}, "platform_error"),
        ]
        for status, doc, want in table:
            self.assertEqual(self.word(status, doc), want, (status, doc))

    def test_rate_limit_detail_carries_metas_own_wait_in_minutes(self):
        usage = json.dumps({"109876543210": [{"type": "pages", "call_count": 100, "estimated_time_to_regain_access": 25},
                                             {"type": "x", "estimated_time_to_regain_access": 40}]})
        stop = fbk.graph_error("publish", self.R(400, {"X-Business-Use-Case-Usage": usage}), {"error": {"code": 80001}})
        self.assertEqual(stop.reason, "rate_limited")
        self.assertIn("about 40 min", stop.detail)
        for hostile in ("not json", json.dumps({"a": [{"estimated_time_to_regain_access": -5}]}),
                        json.dumps({"a": [{"estimated_time_to_regain_access": 10 ** 9}]}),
                        json.dumps({"a": "x"}), "x" * 20000, json.dumps([1])):
            stop = fbk.graph_error("publish", self.R(400, {"X-Business-Use-Case-Usage": hostile}),
                                   {"error": {"code": 4}})
            self.assertNotIn("about", stop.detail)

    def test_detail_names_status_code_and_subcode_only(self):
        stop = fbk.graph_error("upload", self.R(400), {"error": {"code": 100, "error_subcode": 1363128,
                                                                "message": "secret words", "fbtrace_id": "abc"}})
        self.assertEqual(stop.detail, "facebook upload: HTTP 400, code 100, subcode 1363128")

    def test_the_new_reason_words_are_closed_words_and_listed_for_the_panel(self):
        from pathlib import Path as P
        ts = (P(__file__).resolve().parent.parent / "command-center" / "lib" / "publish.ts").read_text(encoding="utf-8")
        for word in fbk.REASONS:
            self.assertRegex(word, r"^[a-z0-9_]{1,64}$")
            self.assertIn(f'  "{word}",', ts, word)


class FacebookPreChecks(unittest.TestCase):
    """The file is refused before any request."""

    def fmt(self, **kw):
        base = dict(duration=30.0, width=1080, height=1920, size=10 * 1024 * 1024)
        base.update(kw)
        sp.check_format("facebook", sp.VideoInfo(base["duration"], base["width"], base["height"], base["size"]))

    def refuses(self, reason, **kw):
        with self.assertRaises(sp.PublishStop) as e:
            self.fmt(**kw)
        self.assertEqual((e.exception.status, e.exception.reason), ("refused", reason))
        return e.exception.detail

    def test_duration_is_3_to_90_seconds_inclusive(self):
        for d in (3.0, 3.1, 60.0, 90.0):
            self.fmt(duration=d)
        self.refuses("too_short", duration=2.9)
        self.refuses("too_long", duration=90.1)
        self.assertIn("1:30", self.refuses("too_long", duration=120.0))
        self.refuses("unknown_duration", duration=None)

    def test_a_long_video_names_its_short(self):
        with self.assertRaises(sp.PublishStop) as e:
            sp.check_format("facebook", sp.VideoInfo(600.0, 1080, 1920, 10), short_id="short9")
        self.assertIn("short9", e.exception.detail)

    def test_size_cap(self):
        self.fmt(size=sp.FB_MAX_BYTES)
        self.refuses("too_large", size=sp.FB_MAX_BYTES + 1)

    def test_only_a_vertical_nine_by_sixteen_picture(self):
        for w, h in ((1080, 1920), (720, 1280), (540, 960), (1088, 1920)):
            self.fmt(width=w, height=h)
        for w, h in ((1920, 1080), (1080, 1080), (1080, 1350), (1000, 2000), (3, 4)):
            self.refuses("bad_aspect", width=w, height=h)
        self.refuses("unreadable_video", width=None, height=None)

    def test_instagram_and_tiktok_checks_are_unchanged(self):
        sp.check_format("instagram", sp.VideoInfo(600.0, 1920, 1080, 10))  # 16:9, 10 minutes: fine for Instagram
        sp.check_format("tiktok", sp.VideoInfo(600.0, 1920, 1080, 10), max_seconds=600)
        with self.assertRaises(sp.PublishStop):
            sp.check_format("tiktok", sp.VideoInfo(700.0, 1920, 1080, 10), max_seconds=600)

    def test_media_rules(self):
        def good(**o):
            b = dict(video_codec="h264", audio_codec="aac", has_audio=True, width=1080, height=1920, fps=30.0, faststart=False)
            b.update(o)
            return pr.MediaFacts(**b)

        pr.check_media("facebook", good())                      # no faststart needed: bytes go by resumable upload
        for codec in ("h264", "hevc", "vp9", "av1"):
            pr.check_media("facebook", good(video_codec=codec))
        for codec in ("mpeg4", "prores", "vp8"):
            with self.assertRaises(pr.ProbeRefusal) as e:
                pr.check_media("facebook", good(video_codec=codec))
            self.assertEqual(e.exception.reason, pr.REASON_CODEC)
        pr.check_media("facebook", good(width=540, height=960))
        for w, h in ((539, 960), (540, 959), (360, 640), (1080, 539)):
            with self.assertRaises(pr.ProbeRefusal) as e:
                pr.check_media("facebook", good(width=w, height=h))
            self.assertEqual(e.exception.reason, pr.REASON_TOO_SMALL, (w, h))
            self.assertIn("540x960", e.exception.detail)
        for fps in (23.0, 23.976, 60.0):
            pr.check_media("facebook", good(fps=fps))
        for fps in (22.9, 61.0):
            with self.assertRaises(pr.ProbeRefusal) as e:
                pr.check_media("facebook", good(fps=fps))
            self.assertEqual(e.exception.reason, pr.REASON_FPS)
        with self.assertRaises(pr.ProbeRefusal) as e:
            pr.check_media("facebook", pr.MediaFacts())
        self.assertEqual(e.exception.reason, pr.REASON_UNREADABLE)

    def test_the_new_probe_word_is_in_the_closed_list(self):
        self.assertIn(pr.REASON_TOO_SMALL, pr.REASONS)


class FacebookCaption(unittest.TestCase):
    META = cap.SourceMeta(title="The Fall of Rome", description="Why it fell. " * 400,
                          tags=("ancient rome", "history", "empire", "war", "legion", "senate", "rome", "x1"),
                          niche="history")

    def test_limit_hashtags_and_determinism(self):
        text = cap.caption_for("facebook", self.META)
        self.assertLessEqual(len(text), cap.FB_DESCRIPTION_MAX)
        self.assertLessEqual(text.count("#"), cap.FB_HASHTAGS_DEFAULT)
        self.assertEqual(text, cap.caption_for("facebook", self.META))
        self.assertTrue(text.startswith("The Fall of Rome"))

    def test_the_limit_is_2200_and_the_default_is_five_hashtags(self):
        text = cap.caption_for("facebook", self.META)
        self.assertGreater(len(text), 2100)     # the long description is trimmed to the limit, not to less
        self.assertEqual(cap.FB_DESCRIPTION_MAX, 2200)
        short = cap.SourceMeta(title="Rome", description="Short.", tags=self.META.tags, niche="history")
        self.assertEqual(cap.caption_for("facebook", short).count("#"), 5)
        self.assertEqual(cap.FB_HASHTAGS_DEFAULT, 5)

    def test_the_ai_line_is_never_trimmed_away(self):
        line = "This video contains realistic AI-generated or AI-altered content."
        text = cap.caption_for("facebook", self.META, disclosure=line)
        self.assertIn(line, text)
        self.assertLessEqual(len(text), cap.FB_DESCRIPTION_MAX)
        self.assertNotIn(line, cap.caption_for("facebook", self.META))

    def test_other_platforms_still_dispatch_and_an_unknown_one_still_raises(self):
        self.assertTrue(cap.caption_for("instagram", self.META))
        with self.assertRaises(ValueError):
            cap.caption_for("x", self.META)


class ControlCharactersAreRemoved(unittest.TestCase):
    """A NUL / ESC / BEL, a bidirectional override or a zero-width space in a title or description (or in the AI line)
    must not reach any platform: they can reverse the text around them or break a request. Newlines, tabs-as-spaces and the
    joiners real scripts need stay."""

    BAD = "\x00\x07\x1b\x7f\x85\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200b"

    def meta(self):
        return cap.SourceMeta(title=f"Rome{self.BAD} falls", description=f"First{self.BAD}.\n\nSecond\u200c line{self.BAD}",
                              tags=("history",))

    def test_every_platforms_caption_is_free_of_them(self):
        for platform in ("facebook", "instagram", "tiktok"):
            text = cap.caption_for(platform, self.meta(), disclosure=f"AI{self.BAD} line.")
            for ch in self.BAD:
                self.assertNotIn(ch, text, (platform, hex(ord(ch))))
            self.assertIn("Rome falls", text)
            self.assertIn("AI line.", text)
        yt = cap.youtube_metadata(self.meta(), disclosure=f"AI{self.BAD} line.")
        for ch in self.BAD:
            self.assertNotIn(ch, yt.title + yt.description)

    def test_what_real_text_needs_is_kept(self):
        text = cap.caption_for("facebook", self.meta())
        self.assertIn("Second\u200c line", text)      # a zero-width non-joiner is part of some scripts
        self.assertIn("\n\n", text)                   # paragraphs
        self.assertEqual(cap._clean("a\tb\r\nc"), "a b\nc")

    def test_clean_text_is_unchanged(self):
        meta = cap.SourceMeta(title="Plain title", description="Plain words.", tags=("history",))
        self.assertEqual(cap.caption_for("facebook", meta), "Plain title\n\nPlain words.\n\n#history")


class FacebookTokens(unittest.TestCase):
    class Client(st.SocialTokenClient):
        def __init__(self):
            super().__init__("https://x.supabase.co", "svc")
            self.statuses, self.rotated = [], []

        def set_status(self, account_id, status):
            self.statuses.append((account_id, status))

        def rotate(self, t):
            self.rotated.append(t)

    def test_a_page_token_without_expiry_is_used_as_is_and_never_refreshed(self):
        c = self.Client()
        out = st.ensure_fresh(tok(), c, http=object(), env={})
        self.assertEqual(out.access_token, TOKEN)
        self.assertEqual((c.statuses, c.rotated), ([], []))

    def test_a_future_expiry_is_used_and_a_past_one_marks_the_account_expired(self):
        c = self.Client()
        now = datetime.now(timezone.utc)
        st.ensure_fresh(tok(access_expires_at=now + timedelta(days=30)), c, http=object(), env={})
        with self.assertRaises(st.SocialTokenError) as e:
            st.ensure_fresh(tok(access_expires_at=now - timedelta(seconds=1)), c, http=object(), env={})
        self.assertNotIn(TOKEN, str(e.exception))
        self.assertEqual(c.statuses, [("acc1", "expired")])

    def test_no_network_call_is_made(self):
        class Boom:
            def __getattr__(self, name):
                raise AssertionError("network used")
        st.ensure_fresh(tok(), self.Client(), http=Boom(), env={})


class LabelledStore(FakeStore):
    def disclosure_events(self, video_id):
        return [event(generated_clips=2)]


def reels_http(*, finish=None, state="draft"):
    up = f"https://rupload.facebook.com/video-upload/{VID}"
    return FakeHTTP({
        ("POST", f"{fbk.GRAPH}/17841400000/video_reels"): [FakeResp(200, {"video_id": VID, "upload_url": up}),
                                                           finish or FakeResp(200, {"success": True})],
        ("POST", "https://rupload.facebook.com/video-upload/"): [FakeResp(200, {"success": True})],
        ("GET", f"{fbk.GRAPH}/{VID}"): [FakeResp(200, {"status": {"video_status": "ready",
                                                      "publishing_phase": {"publish_status": state}}})],
    })


class ThroughTheWorker(Base):
    """process_request for a facebook row: the registry, the checks, the caption, the AI flag, the row written."""

    def run_fb(self, http, store=None, tokens=None, info=None, facts=None, **kw):
        store = store or FakeStore(video=self.video, http=http)
        out = self.run_req(store, tokens or FakeTokens("facebook"), platform="facebook", info=info, http=http,
                           facts=facts, **kw)
        return out, store

    def test_the_publisher_is_registered_as_facebook_and_the_row_ends_published_as_a_draft(self):
        self.assertIsNotNone(publishers.factory_for("facebook"))
        http = reels_http()
        out, store = self.run_fb(http)
        self.assertEqual(out, "published")
        self.assertEqual((store.final["status"], store.final["result_id"], store.final["privacy"]),
                         ("published", VID, "DRAFT"))
        self.assertTrue(store.updates[0]["caption"].startswith("The Fall of Rome"))
        finish = [c for c in http.calls if c[1].endswith("/video_reels")][1][2]["json"]
        self.assertEqual(finish["video_state"], "DRAFT")
        self.assertNotIn("is_ai_generated", finish)

    def test_the_ai_flag_is_sent_only_when_the_decision_labels(self):
        http = reels_http()
        out, store = self.run_fb(http, store=LabelledStore(video=self.video, http=http))
        self.assertEqual(out, "published")
        finish = [c for c in http.calls if c[1].endswith("/video_reels")][1][2]["json"]
        self.assertIs(finish["is_ai_generated"], True)
        self.assertIn("AI-generated", finish["description"])   # the line is in the caption too

    def test_every_pre_upload_refusal_happens_before_any_http_call(self):
        cases = {
            "too_long": dict(info=sp.VideoInfo(120.0, 1080, 1920, 2048)),
            "too_short": dict(info=sp.VideoInfo(2.0, 1080, 1920, 2048)),
            "too_large": dict(info=sp.VideoInfo(60.0, 1080, 1920, sp.FB_MAX_BYTES + 1)),
            "bad_aspect": dict(info=sp.VideoInfo(60.0, 1920, 1080, 2048)),
            "unknown_duration": dict(info=sp.VideoInfo(None, 1080, 1920, 2048)),
            "too_small_picture": dict(facts=pr.MediaFacts("h264", "aac", True, 480, 854, 30.0, True),
                                      info=sp.VideoInfo(60.0, 480, 854, 2048)),
            "bad_codec": dict(facts=pr.MediaFacts("mpeg4", "aac", True, 1080, 1920, 30.0, True)),
            "bad_framerate": dict(facts=pr.MediaFacts("h264", "aac", True, 1080, 1920, 12.0, True)),
            "unreadable_video": dict(facts=pr.MediaFacts()),
        }
        for want, kw in cases.items():
            http = reels_http()
            out, store = self.run_fb(http, **kw)
            self.assertEqual((out, store.final["reason"]), ("refused", want), want)
            self.assertEqual(http.calls, [], want)

    def test_a_long_video_is_pointed_at_its_short(self):
        http = reels_http()
        store = FakeStore(video=self.video, short="short42", http=http)
        out, store = self.run_fb(http, store=store, info=sp.VideoInfo(600.0, 1920, 1080, 2048))
        self.assertEqual((out, store.final["reason"]), ("refused", "too_long"))
        self.assertIn("short42", store.final["error"])

    def test_an_account_of_another_platform_is_not_used(self):
        http = reels_http()
        out, store = self.run_fb(http, tokens=FakeTokens("instagram"))
        self.assertEqual((out, store.final["reason"]), ("refused", "account_not_connected"))
        self.assertEqual(http.calls, [])

    def test_an_unconnected_account_is_refused_and_a_lost_finish_ends_unconfirmed(self):
        out, store = self.run_fb(reels_http(), tokens=FakeTokens("facebook", missing=True))
        self.assertEqual((out, store.final["reason"]), ("refused", "account_not_connected"))
        http = reels_http(finish=FakeResp(503, {}), state="not_started")
        out, store = self.run_fb(http)
        self.assertEqual((out, store.final["status"], store.final["reason"]), ("failed", "failed", "publish_unconfirmed"))
        self.assertEqual(len([c for c in http.calls if c[1].endswith("/video_reels") and c[2]["json"].get("upload_phase") == "finish"]), 1)

    def test_nothing_secret_is_logged_or_recorded(self):
        http = reels_http(finish=FakeResp(401, {"error": {"code": 190, "message": TOKEN}}))
        with self.assertLogs("modules.social_publish", level="INFO") as logs:
            out, store = self.run_fb(http)
        self.assertEqual((out, store.final["reason"]), ("failed", "token_expired"))
        blob = json.dumps(store.updates) + "\n".join(logs.output)
        self.assertNotIn("EAAB", blob)
        from tests.test_social_publish import TOKEN as IG_TOKEN
        self.assertNotIn(IG_TOKEN, blob)

    def test_the_log_line_says_where_it_went(self):
        with self.assertLogs("modules.social_publish", level="INFO") as logs:
            self.run_fb(reels_http())
        self.assertIn("saved as a draft Reel on facebook account acc1", logs.output[-1])


class DarkMeansUnreachable(unittest.TestCase):
    """Why nothing can reach this publisher today: the database refuses the platform word, and there is no connect flow."""

    ROOT = Path(__file__).resolve().parent.parent

    def test_the_migrations_still_do_not_allow_facebook(self):
        for name in ("0028_social_accounts.sql", "0029_publish_targets.sql"):
            sql = (self.ROOT / "supabase" / "migrations" / name).read_text(encoding="utf-8")
            self.assertNotRegex(sql.lower(), r"""['"]facebook['"]""", name)   # the platform word in a check / function

    def test_no_connect_route_or_oauth_config_names_facebook(self):
        for rel in ("command-center/lib/server/social-oauth.ts", "command-center/lib/server/social-connect.ts",
                    "command-center/lib/social-accounts.ts"):
            text = (self.ROOT / rel).read_text(encoding="utf-8").lower()
            self.assertNotRegex(text, r"""['"`]facebook['"`]""", rel)   # the platform word (docs URLs are not it)
        self.assertFalse((self.ROOT / "command-center" / "app" / "api" / "oauth" / "facebook").exists())

    def test_the_adapter_reads_no_environment_variable(self):
        src = (self.ROOT / "modules" / "social_facebook.py").read_text(encoding="utf-8")
        for needle in ("os.environ", "getenv", "env.get(", "import os"):
            self.assertNotIn(needle, src)

    def test_the_module_does_not_log_at_all(self):
        src = (self.ROOT / "modules" / "social_facebook.py").read_text(encoding="utf-8")
        self.assertNotIn("logging", src)
        self.assertNotIn("print(", src)


if __name__ == "__main__":
    logging.disable(logging.NOTSET)
    unittest.main()
