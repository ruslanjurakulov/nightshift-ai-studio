"""modules/social_publish.py — the worker's publish_requests handling, with
mocked HTTP. Pins: the gate/approval refusal stops everything before any
upload; no silent quality fallback; clear format refusals; the Instagram and
TikTok flows per the docs; nothing secret in what is recorded."""

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from modules import social_publish as sp
from modules import social_tokens as st

TOKEN = "IGQVJ-secret-access-token"


class Resp:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body if body is not None else {}

    def json(self):
        return self._body


class FakeHTTP:
    """Routes by (method, url prefix) to a queue of responses."""

    def __init__(self, routes):
        self.routes = {k: list(v) for k, v in routes.items()}
        self.calls = []

    def _go(self, method, url, **kw):
        self.calls.append((method, url, kw))
        for (m, prefix), queue in self.routes.items():
            if m == method and url.startswith(prefix) and queue:
                return queue.pop(0) if len(queue) > 1 else queue[0]
        raise AssertionError(f"unexpected {method} {url}")

    def get(self, url, **kw):
        return self._go("GET", url, **kw)

    def post(self, url, **kw):
        return self._go("POST", url, **kw)

    def put(self, url, **kw):
        return self._go("PUT", url, **kw)


class FakeStore:
    def __init__(self, *, refusal=None, video=None, short=None, http=None):
        self._refusal = refusal
        self._video = video
        self._short = short
        self._http = http
        self.updates = []
        self.staged = []
        self.unstaged = []

    def http(self):
        return self._http

    def refusal(self, video_id):
        return self._refusal

    def video(self, video_id):
        return self._video

    def channel(self, channel_id):
        return {"channel_id": channel_id, "niche": "history"}

    def short_of(self, video_id):
        return self._short

    def update(self, rid, worker_id, values):
        self.updates.append(values)

    def stage(self, path, name):
        self.staged.append(name)

    def sign(self, name, seconds=3600):
        return "https://x.supabase.co/storage/v1/object/sign/publish-staging/" + name + "?token=signed"

    def unstage(self, name):
        self.unstaged.append(name)

    @property
    def final(self):
        return self.updates[-1]


class FakeTokens(st.SocialTokenClient):
    def __init__(self, platform, *, missing=False):
        super().__init__("https://x.supabase.co", "svc")
        self.platform = platform
        self.missing = missing

    def read(self, account_id):
        if self.missing:
            return None
        return st.SocialToken(account_id=account_id, org_id="org", platform=self.platform,
                              external_id="17841400000", access_token=TOKEN,
                              refresh_token="rft.x" if self.platform == "tiktok" else "",
                              access_expires_at=datetime.now(timezone.utc) + timedelta(days=30),
                              connected_at=datetime.now(timezone.utc) - timedelta(days=1))

    def rotate(self, tok):
        pass

    def set_status(self, account_id, status):
        pass


def req(platform="instagram"):
    return {"id": 7, "org_id": "org", "video_id": "vid1", "account_id": "acc1", "platform": platform}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "output"
        (self.out / "fall-of-rome").mkdir(parents=True)
        self.master = self.out / "fall-of-rome" / "final.mp4"
        self.master.write_bytes(b"\0" * 2048)
        (self.out / "fall-of-rome" / "script.json").write_text(json.dumps({
            "title": "The Fall of Rome", "description": "Why it fell.", "tags": ["ancient rome", "history"]}))
        self.video = {"video_id": "vid1", "channel_id": "news", "title": "The Fall of Rome",
                      "slug": "fall-of-rome", "local_path": str(self.master), "video_format": "long"}

    def tearDown(self):
        self.tmp.cleanup()

    def run_req(self, store, tokens, platform="instagram", info=None, http=None):
        info = info or sp.VideoInfo(60.0, 1080, 1920, 2048)
        return sp.process_request(req(platform), store=store, tokens=tokens, worker_id="w1",
                                  output_dir=self.out, http=http or store.http(), env={},
                                  sleep=lambda s: None, probe_fn=lambda p: info)


class GateTests(Base):
    def test_gate_or_approval_refusal_stops_before_anything_is_uploaded(self):
        for why in ("not_uploaded", "gate_blocked", "not_approved", "awaiting_two_person"):
            http = FakeHTTP({})
            store = FakeStore(refusal=why, video=self.video, http=http)
            self.assertEqual(self.run_req(store, FakeTokens("instagram"), http=http), "refused")
            self.assertEqual(store.final["status"], "refused")
            self.assertEqual(store.final["reason"], why)
            self.assertEqual(http.calls, [])
            self.assertEqual(store.staged, [])

    def test_disconnected_account_refused(self):
        store = FakeStore(video=self.video, http=FakeHTTP({}))
        self.assertEqual(self.run_req(store, FakeTokens("instagram", missing=True)), "refused")
        self.assertEqual(store.final["reason"], "account_not_connected")


class FileTests(Base):
    def test_no_silent_quality_fallback_when_master_missing(self):
        self.master.unlink()
        store = FakeStore(video=self.video, http=FakeHTTP({}))
        self.assertEqual(self.run_req(store, FakeTokens("instagram")), "refused")
        self.assertEqual(store.final["reason"], "master_not_available")

    def test_path_outside_output_is_never_read(self):
        outside = Path(self.tmp.name) / "secret.mp4"
        outside.write_bytes(b"x")
        self.assertIsNone(sp.resolve_master({"local_path": str(outside)}, self.out))
        self.assertIsNone(sp.resolve_master({"local_path": "../secret.mp4"}, self.out))
        self.assertEqual(sp.resolve_master({"local_path": "/runner/work/output/fall-of-rome/final.mp4"}, self.out),
                         self.master.resolve())

    def test_too_long_names_the_short(self):
        store = FakeStore(video=self.video, short="short123", http=FakeHTTP({}))
        self.assertEqual(self.run_req(store, FakeTokens("instagram"), info=sp.VideoInfo(1200.0, 1920, 1080, 2048)),
                         "refused")
        self.assertEqual(store.final["reason"], "too_long")
        self.assertIn("short123", store.final["error"])
        self.assertIn("20:00", store.final["error"])

    def test_format_limits(self):
        with self.assertRaises(sp.PublishStop) as e:
            sp.check_format("instagram", sp.VideoInfo(2.0, 1080, 1920, 10))
        self.assertEqual(e.exception.reason, "too_short")
        with self.assertRaises(sp.PublishStop) as e:
            sp.check_format("instagram", sp.VideoInfo(60.0, 1080, 1920, sp.IG_MAX_BYTES + 1))
        self.assertEqual(e.exception.reason, "too_large")
        with self.assertRaises(sp.PublishStop) as e:
            sp.check_format("tiktok", sp.VideoInfo(700.0, 1920, 1080, 10), max_seconds=600)
        self.assertEqual(e.exception.reason, "too_long")
        sp.check_format("instagram", sp.VideoInfo(600.0, 1920, 1080, 10))  # 16:9 long is fine for Reels

    def test_tiktok_chunk_rules(self):
        self.assertEqual(sp.tiktok_chunks(5 * 1024 * 1024), (5 * 1024 * 1024, 1))
        size = 100 * 1024 * 1024 + 123
        chunk, total = sp.tiktok_chunks(size)
        self.assertTrue(5 * 1024 * 1024 <= chunk <= 64 * 1024 * 1024)
        self.assertEqual(total, size // chunk)
        self.assertLessEqual(size - chunk * (total - 1), 128 * 1024 * 1024)


class InstagramFlowTests(Base):
    def test_container_poll_publish_and_permalink(self):
        g = sp.IG_GRAPH
        http = FakeHTTP({
            ("POST", f"{g}/17841400000/media_publish"): [Resp(200, {"id": "MEDIA1"})],
            ("POST", f"{g}/17841400000/media"): [Resp(200, {"id": "CONT1"})],
            ("GET", f"{g}/CONT1"): [Resp(200, {"status_code": "IN_PROGRESS"}), Resp(200, {"status_code": "FINISHED"})],
            ("GET", f"{g}/MEDIA1"): [Resp(200, {"permalink": "https://www.instagram.com/reel/abc/"})],
        })
        store = FakeStore(video=self.video, http=http)
        self.assertEqual(self.run_req(store, FakeTokens("instagram"), http=http), "published")
        self.assertEqual(store.final["result_id"], "MEDIA1")
        self.assertEqual(store.final["result_url"], "https://www.instagram.com/reel/abc/")
        create = next(c for c in http.calls if c[1].endswith("/media"))
        self.assertEqual(create[2]["data"]["media_type"], "REELS")
        self.assertTrue(create[2]["data"]["video_url"].startswith("https://"))
        self.assertIn("#AncientRome", create[2]["data"]["caption"])
        self.assertEqual(store.staged, store.unstaged)  # staged copy always removed
        for u in store.updates:
            self.assertNotIn(TOKEN, json.dumps(u))

    def test_platform_error_recorded_without_body_or_token(self):
        g = sp.IG_GRAPH
        http = FakeHTTP({("POST", f"{g}/17841400000/media"): [
            Resp(400, {"error": {"message": f"bad token {TOKEN}", "code": 190}})]})
        store = FakeStore(video=self.video, http=http)
        self.assertEqual(self.run_req(store, FakeTokens("instagram"), http=http), "failed")
        self.assertEqual(store.final["reason"], "token_expired")
        self.assertIn("HTTP 400", store.final["error"])
        self.assertNotIn(TOKEN, store.final["error"])
        self.assertEqual(store.staged, store.unstaged)


class TiktokFlowTests(Base):
    def test_direct_post_self_only_file_upload(self):
        t = sp.TT_API
        http = FakeHTTP({
            ("POST", f"{t}/creator_info/query/"): [Resp(200, {
                "data": {"privacy_level_options": ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
                         "max_video_post_duration_sec": 600}, "error": {"code": "ok"}})],
            ("POST", f"{t}/video/init/"): [Resp(200, {"data": {"publish_id": "v_pub_1",
                                                              "upload_url": "https://open-upload.tiktokapis.com/x"},
                                                     "error": {"code": "ok"}})],
            ("PUT", "https://open-upload.tiktokapis.com/x"): [Resp(201)],
            ("POST", f"{t}/status/fetch/"): [Resp(200, {"data": {"status": "PROCESSING_UPLOAD"}, "error": {"code": "ok"}}),
                                             Resp(200, {"data": {"status": "PUBLISH_COMPLETE",
                                                                 "publicaly_available_post_id": [7300000000001]},
                                                        "error": {"code": "ok"}})],
        })
        store = FakeStore(video=self.video, http=http)
        self.assertEqual(self.run_req(store, FakeTokens("tiktok"), platform="tiktok", http=http), "published")
        self.assertEqual(store.final["privacy"], "SELF_ONLY")
        self.assertEqual(store.final["result_id"], "7300000000001")
        init = next(c for c in http.calls if c[1].endswith("/video/init/"))
        body = init[2]["json"]
        self.assertEqual(body["post_info"]["privacy_level"], "SELF_ONLY")
        self.assertEqual(body["source_info"], {"source": "FILE_UPLOAD", "video_size": 2048,
                                               "chunk_size": 2048, "total_chunk_count": 1})
        put = next(c for c in http.calls if c[0] == "PUT")
        self.assertEqual(put[2]["headers"]["Content-Range"], "bytes 0-2047/2048")

    def test_tiktok_duration_limit_from_creator_info(self):
        t = sp.TT_API
        http = FakeHTTP({("POST", f"{t}/creator_info/query/"): [Resp(200, {
            "data": {"privacy_level_options": ["SELF_ONLY"], "max_video_post_duration_sec": 180},
            "error": {"code": "ok"}})]})
        store = FakeStore(video=self.video, http=http)
        out = self.run_req(store, FakeTokens("tiktok"), platform="tiktok", http=http,
                           info=sp.VideoInfo(300.0, 1920, 1080, 2048))
        self.assertEqual(out, "refused")
        self.assertEqual(store.final["reason"], "too_long")
        self.assertFalse(any(c[1].endswith("/video/init/") for c in http.calls))


class YtStore(FakeStore):
    def __init__(self, *, status="ACTIVE", connected=True, **kw):
        super().__init__(**kw)
        self._status = status
        self._connected = connected

    def channel(self, channel_id):
        return {"channel_id": channel_id, "niche": "history", "status": self._status}

    def channel_connected(self, channel_id):
        return self._connected


class FakeUploader:
    def __init__(self, exc=None):
        self.exc = exc
        self.calls = []

    def upload(self, path, script, privacy=None):
        self.calls.append((path, script, privacy))
        if self.exc:
            raise self.exc
        return {"id": "dQw4w9WgXcQ", "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}


class HttpErr(Exception):
    """Shaped like googleapiclient's HttpError."""

    def __init__(self, status, reason):
        super().__init__("HttpError " + TOKEN)
        self.resp = type("R", (), {"status": status})()
        self.content = json.dumps({"error": {"message": "body with " + TOKEN,
                                             "errors": [{"reason": reason}]}}).encode()


class YoutubeFlowTests(Base):
    YT_TOKEN = json.dumps({"refresh_token": "1//yt-secret-refresh"})

    def yt(self, store, *, uploader=None, factory_exc=None, token=None, cred_exc=None, target="finance"):
        self.cred_calls = []
        self.factory_calls = []
        uploader = uploader or FakeUploader()

        def creds(cid):
            self.cred_calls.append(cid)
            if cred_exc:
                raise cred_exc
            return (self.YT_TOKEN if token is None else token), {"channel": cid}

        def factory(tok, ctx):
            self.factory_calls.append(ctx)
            if factory_exc:
                raise factory_exc
            return uploader

        r = {"id": 9, "org_id": "org", "video_id": "vid1", "account_id": None,
             "target_channel_id": target, "platform": "youtube"}
        out = sp.process_request(r, store=store, tokens=FakeTokens("instagram", missing=True), worker_id="w1",
                                 output_dir=self.out, http=FakeHTTP({}), env={}, sleep=lambda s: None,
                                 probe_fn=lambda p: sp.VideoInfo(60.0, 1920, 1080, 2048),
                                 youtube=sp.YoutubeAdapter(creds, uploader_factory=factory))
        return out, uploader

    def test_uploads_master_private_to_the_target_channel(self):
        store = YtStore(video=self.video)
        out, up = self.yt(store)
        self.assertEqual(out, "published")
        self.assertEqual(self.cred_calls, ["finance"])
        (path, script, privacy), = up.calls
        self.assertEqual(path, self.master.resolve())
        self.assertEqual(privacy, "private")
        self.assertEqual(script.title, "The Fall of Rome")
        self.assertEqual(script.tags, ["ancient rome", "history"])
        self.assertEqual(store.final["status"], "published")
        self.assertEqual(store.final["privacy"], "private")
        self.assertEqual(store.final["result_id"], "dQw4w9WgXcQ")
        self.assertEqual(store.final["result_url"], "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        processing = next(u for u in store.updates if u.get("status") == "processing")
        self.assertEqual(processing["privacy"], "private")
        self.assertTrue(processing["caption"].startswith("The Fall of Rome\n\nWhy it fell."))
        self.assertNotIn("yt-secret", json.dumps(store.updates))

    def test_own_channel_is_refused_without_touching_youtube(self):
        store = YtStore(video=self.video)
        out, up = self.yt(store, target="news")
        self.assertEqual((out, store.final["reason"]), ("refused", "already_on_channel"))
        self.assertEqual(self.cred_calls, [])
        self.assertEqual(up.calls, [])

    def test_gate_paused_and_disconnected_are_refused_before_any_token(self):
        cases = [(YtStore(video=self.video, refusal="not_approved"), "not_approved"),
                 (YtStore(video=self.video, status="PAUSED"), "account_not_connected"),
                 (YtStore(video=self.video, connected=False), "account_not_connected")]
        for store, reason in cases:
            out, up = self.yt(store)
            self.assertEqual((out, store.final["reason"]), ("refused", reason))
            self.assertEqual(self.cred_calls, [])
            self.assertEqual(up.calls, [])

    def test_no_token_unverified_or_unreachable_channel(self):
        for kw in ({"token": ""}, {"cred_exc": ValueError("unverified")}, {"factory_exc": ValueError("not reachable")}):
            store = YtStore(video=self.video)
            out, up = self.yt(store, **kw)
            self.assertEqual((out, store.final["reason"]), ("refused", "account_not_connected"), kw)
            self.assertEqual(up.calls, [])

    def test_master_missing_is_refused(self):
        self.master.unlink()
        store = YtStore(video=self.video)
        out, _ = self.yt(store)
        self.assertEqual(store.final["reason"], "master_not_available")
        self.assertEqual(self.cred_calls, [])

    def test_quota_and_other_errors_are_reason_words_without_bodies(self):
        cases = [(HttpErr(403, "quotaExceeded"), "quota_exceeded"),
                 (HttpErr(403, "uploadLimitExceeded"), "quota_exceeded"),
                 (HttpErr(429, "rateLimitExceeded"), "rate_limited"),
                 (HttpErr(401, "authError"), "token_expired"),
                 (HttpErr(503, "backendError"), "upload_failed"),
                 (HttpErr(400, "invalidTitle"), "platform_error")]
        for exc, reason in cases:
            store = YtStore(video=self.video)
            out, _ = self.yt(store, uploader=FakeUploader(exc))
            self.assertEqual((out, store.final["status"], store.final["reason"]), ("failed", "failed", reason))
            self.assertNotIn(TOKEN, store.final["error"])
            self.assertIn(f"HTTP {exc.resp.status}", store.final["error"])

    def test_worker_without_youtube_setup_fails_clearly(self):
        store = YtStore(video=self.video)
        r = {"id": 9, "org_id": "org", "video_id": "vid1", "target_channel_id": "finance", "platform": "youtube"}
        out = sp.process_request(r, store=store, tokens=FakeTokens("instagram"), worker_id="w1",
                                 output_dir=self.out, http=FakeHTTP({}), env={})
        self.assertEqual((out, store.final["reason"]), ("failed", "platform_error"))


class UploaderFromTokenTests(unittest.TestCase):
    def test_unusable_token_document_raises_in_our_words(self):
        try:
            from modules.youtube_uploader import YouTubeUploader
        except Exception:  # pragma: no cover - google libs missing
            self.skipTest("google client libraries not installed")
        for doc in ('{"token": "ya29.secret-access"}', "not json ya29.secret-access", ""):
            with self.assertRaises(ValueError) as cm:
                YouTubeUploader.from_token_json(doc)
            self.assertNotIn("ya29", str(cm.exception))


class PublisherLoopTests(unittest.TestCase):
    def test_run_once_is_false_when_queue_empty_or_unavailable(self):
        class Store:
            def __init__(self, result):
                self.result = result

            def claim(self, worker_id):
                if isinstance(self.result, Exception):
                    raise self.result
                return self.result

        p = sp.SocialPublisher("u", "k", output_dir=Path("."), worker_id="w", store=Store(None), tokens=object())
        self.assertFalse(p.run_once())
        p = sp.SocialPublisher("u", "k", output_dir=Path("."), worker_id="w",
                               store=Store(RuntimeError("claim_publish_request: HTTP 500")), tokens=object())
        self.assertFalse(p.run_once())


if __name__ == "__main__":
    unittest.main()


class WorkerIntegrationTests(unittest.TestCase):
    def test_worker_handles_a_publish_request_between_render_jobs(self):
        from tools import queue_worker

        class Client:
            def claim(self, worker_id, stale_minutes):
                return None

        class Publisher:
            calls = 0

            def run_once(self):
                Publisher.calls += 1
                return True

        w = queue_worker.Worker(Client(), worker_id="w", env={}, publisher=Publisher())
        self.assertEqual(w.run_forever(once=True), 0)
        self.assertEqual(Publisher.calls, 1)

    def test_a_crashing_publisher_never_stops_the_render_queue(self):
        from tools import queue_worker

        class Client:
            def claim(self, worker_id, stale_minutes):
                return None

        class Boom:
            def run_once(self):
                raise RuntimeError("x")

        w = queue_worker.Worker(Client(), worker_id="w", env={}, publisher=Boom())
        self.assertEqual(w.run_forever(once=True), 0)
