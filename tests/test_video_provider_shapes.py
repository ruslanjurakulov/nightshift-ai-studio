"""The request/response shapes each b-roll provider actually speaks, and what
happens when a provider says no.

Every test here swaps the client's HTTP session for a recorder, so no request
leaves the process. What they pin:

* MiniMax: the model id picks the API — Hailuo on v1 (task → query → file
  retrieve), H3 on v2 (content array, content.url). H3 used to be sent down the
  v1 flow, and MiniMax's errors (HTTP 200 + base_resp) were ignored, so a
  refusal would have been a silent stock fallback.
* Kling (api-singapore, model_name, console key or signed JWT), Seedance
  (BytePlus ModelArk, content array, top-level settings) and Wan (input /
  parameters wrapper, X-DashScope-Async, workspace host) — the documented
  shapes the old flat body did not match.
* A refusal raises VideoModelUnavailable with the remedy for its cause; a key
  never appears in it, in a log line, or on the CDN request for the clip.
"""

import base64
import hashlib
import hmac
import json
import logging
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import requests

import config
from modules import minimax_client as mc
from modules import video_providers as vp
from modules.minimax_broll import GenerationSpec, VideoModelUnavailable
from modules.provider_tasks import OUTCOME_FAILED, OUTCOME_PENDING, OUTCOME_SUCCEEDED

KEY = "test-key-do-not-leak-7f3a"
SECRET = "test-secret-do-not-leak-91c2"


def _spec(duration=6):
    return GenerationSpec(prompt="a cinematic shot of Rome", duration_seconds=duration,
                          section_index=2, keyword="rome")


class FakeResp:
    def __init__(self, payload=None, status=200, chunks=None):
        self._payload = payload
        self.status_code = status
        self._chunks = chunks or []

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}")

    def iter_content(self, chunk_size=0):
        return iter(self._chunks)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeSession:
    """Records every request; answers from scripted queues."""

    def __init__(self, posts=(), gets=()):
        self.posts = list(posts)
        self.gets = list(gets)
        self.calls = []
        self.headers = {}

    def _next(self, queue):
        r = queue.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append({"method": "POST", "url": url, "json": json, "headers": headers or {}})
        return self._next(self.posts)

    def get(self, url, params=None, headers=None, stream=False, timeout=None):
        self.calls.append({"method": "GET", "url": url, "params": params or {},
                           "headers": headers or {}, "stream": stream})
        return self._next(self.gets)


def _no_sleep():
    return mock.patch("time.sleep", lambda *_: None)


def _assert_no_secret(test, *texts):
    for t in texts:
        test.assertNotIn(KEY, str(t))
        test.assertNotIn(SECRET, str(t))


# ── MiniMax ──────────────────────────────────────────────────────────────────

class MiniMaxFlowSelectionTestCase(unittest.TestCase):
    def test_model_id_picks_the_api(self):
        self.assertEqual(mc.flow_for_model("MiniMax-H3"), mc.FLOW_V2)
        self.assertEqual(mc.flow_for_model("MiniMax-H3-Max"), mc.FLOW_V2)
        self.assertEqual(mc.flow_for_model("MiniMax-Hailuo-2.3"), mc.FLOW_V1)
        self.assertEqual(mc.flow_for_model("MiniMax-Hailuo-2.3-Fast"), mc.FLOW_V1)
        self.assertIsNone(mc.flow_for_model("video-01-live"))
        self.assertIsNone(mc.flow_for_model(""))

    def test_unknown_model_is_refused_before_any_request(self):
        client = mc.MiniMaxClient(api_key=KEY, model="something-else")
        client.session = FakeSession()
        with self.assertRaises(VideoModelUnavailable) as ctx:
            client.submit(_spec())
        self.assertEqual(client.session.calls, [])
        self.assertIn("MINIMAX_H3_MODEL", ctx.exception.remedy)

    def test_h3_without_the_v2_query_path_is_refused_before_any_request(self):
        with mock.patch.object(config, "MINIMAX_V2_QUERY_PATH", "", create=True):
            client = mc.MiniMaxClient(api_key=KEY, model="MiniMax-H3")
        client.session = FakeSession()
        with self.assertRaises(VideoModelUnavailable) as ctx:
            client.submit(_spec())
        self.assertEqual(client.session.calls, [])
        self.assertIn("MINIMAX_V2_QUERY_PATH", ctx.exception.remedy)
        self.assertIn("MiniMax-Hailuo-2.3", ctx.exception.remedy)

    def test_hailuo_needs_no_extra_setting(self):
        mc.MiniMaxClient(api_key=KEY, model="MiniMax-Hailuo-2.3").preflight()


class MiniMaxV1ShapeTestCase(unittest.TestCase):
    def _client(self, session):
        client = mc.MiniMaxClient(api_key=KEY, model="MiniMax-Hailuo-2.3")
        client.base_url = "https://api.minimax.io"
        client.session = session
        return client

    def test_submit_poll_retrieve_download(self):
        session = FakeSession(
            posts=[FakeResp({"task_id": "106916112212032", "base_resp": {"status_code": 0}})],
            gets=[FakeResp({"status": "Processing", "base_resp": {"status_code": 0}}),
                  FakeResp({"status": "Success", "file_id": "205258526306433",
                            "base_resp": {"status_code": 0}}),
                  FakeResp({"file": {"download_url": "https://cdn.minimax.test/clip.mp4"},
                            "base_resp": {"status_code": 0}}),
                  FakeResp(chunks=[b"\x00\x01\x02"])])
        client = self._client(session)
        with tempfile.TemporaryDirectory() as d, _no_sleep():
            out = client.generate(_spec(10), Path(d) / "c.mp4")
            self.assertTrue(out.exists())
        submit, q1, q2, retrieve, download = session.calls
        self.assertEqual(submit["url"], "https://api.minimax.io/v1/video_generation")
        self.assertEqual(submit["json"], {"model": "MiniMax-Hailuo-2.3",
                                          "prompt": "a cinematic shot of Rome", "duration": 10})
        self.assertEqual(q1["url"], "https://api.minimax.io/v1/query/video_generation")
        self.assertEqual(q1["params"], {"task_id": "106916112212032"})
        self.assertEqual(retrieve["url"], "https://api.minimax.io/v1/files/retrieve")
        self.assertEqual(retrieve["params"], {"file_id": "205258526306433"})
        # The clip lives on a CDN host: the key is stripped from that request.
        self.assertEqual(download["url"], "https://cdn.minimax.test/clip.mp4")
        self.assertIn("Authorization", download["headers"])
        self.assertIsNone(download["headers"]["Authorization"])

    def test_fail_status_is_failed_not_pending(self):
        session = FakeSession(gets=[FakeResp({"status": "Fail", "base_resp": {"status_code": 0}})])
        outcome = self._client(session).resume("123", "/tmp/none.mp4")
        self.assertEqual(outcome.state, OUTCOME_FAILED)
        self.assertTrue(outcome.reason)


class MiniMaxV2ShapeTestCase(unittest.TestCase):
    def _client(self, session, query_path="/v2/tasks/{id}"):
        with mock.patch.object(config, "MINIMAX_V2_QUERY_PATH", query_path, create=True):
            client = mc.MiniMaxClient(api_key=KEY, model="MiniMax-H3")
        client.base_url = "https://api.minimax.io"
        client.session = session
        return client

    def test_content_array_and_content_url(self):
        session = FakeSession(
            posts=[FakeResp({"task_id": "t-1", "base_resp": {"status_code": 0}})],
            gets=[FakeResp({"status": "queued"}),
                  FakeResp({"status": "running"}),
                  FakeResp({"status": "succeeded", "content": {"url": "https://cdn.minimax.test/h3.mp4"}}),
                  FakeResp(chunks=[b"\x00\x01"])])
        client = self._client(session)
        with tempfile.TemporaryDirectory() as d, _no_sleep():
            out = client.generate(_spec(12), Path(d) / "c.mp4")
            self.assertTrue(out.exists())
        submit = session.calls[0]
        self.assertEqual(submit["url"], "https://api.minimax.io/v2/video_generation")
        self.assertEqual(submit["json"], {
            "model": "MiniMax-H3",
            "content": [{"type": "text", "text": "a cinematic shot of Rome"}],
            "duration": 12,
        })
        self.assertNotIn("prompt", submit["json"])
        self.assertEqual(session.calls[1]["url"], "https://api.minimax.io/v2/tasks/t-1")
        # No v1 file-retrieve step: the finished task carries the URL.
        self.assertFalse(any("files/retrieve" in c["url"] for c in session.calls))
        self.assertIsNone(session.calls[-1]["headers"]["Authorization"])

    def test_query_path_without_placeholder_sends_task_id_param(self):
        session = FakeSession(gets=[FakeResp({"status": "running"})])
        client = self._client(session, query_path="/v2/query/video_generation")
        with _no_sleep():
            self.assertEqual(client._await("t-9", max_attempts=1)[0], OUTCOME_PENDING)
        self.assertEqual(session.calls[0]["params"], {"task_id": "t-9"})

    def test_terminal_failures(self):
        for status in ("failed", "cancelled", "expired"):
            with self.subTest(status=status):
                session = FakeSession(gets=[FakeResp({"status": status,
                                                      "error": {"message": "moderated"}})])
                outcome = self._client(session).resume("t-1", "/tmp/none.mp4")
                self.assertEqual(outcome.state, OUTCOME_FAILED)

    def test_an_unsafe_task_id_is_never_put_in_a_path(self):
        session = FakeSession()
        outcome = self._client(session).resume("../../v1/files", "/tmp/none.mp4")
        self.assertEqual(outcome.state, OUTCOME_FAILED)
        self.assertEqual(session.calls, [])


class MiniMaxErrorMappingTestCase(unittest.TestCase):
    def _client(self, posts=(), gets=()):
        client = mc.MiniMaxClient(api_key=KEY, model="MiniMax-Hailuo-2.3")
        client.session = FakeSession(posts, gets)
        return client

    def test_base_resp_error_inside_a_200_is_not_ignored(self):
        # MiniMax reports most errors this way; the old client read it as
        # "no task id" and the section silently became stock footage.
        client = self._client(posts=[FakeResp({"task_id": "", "base_resp": {
            "status_code": 2013, "status_msg": "invalid params, model not supported"}})])
        with self.assertRaises(VideoModelUnavailable) as ctx:
            client.submit(_spec())
        self.assertIn("2013", str(ctx.exception))
        self.assertIn("model not supported", str(ctx.exception))

    def test_1004_is_a_credentials_problem(self):
        client = self._client(posts=[FakeResp({"base_resp": {
            "status_code": 1004, "status_msg": "authentication failed"}})])
        with self.assertRaises(VideoModelUnavailable) as ctx:
            client.submit(_spec())
        self.assertIn("MINIMAX_API_KEY", ctx.exception.remedy)
        self.assertIn("region", ctx.exception.remedy)

    def test_2038_is_real_name_verification(self):
        client = self._client(posts=[FakeResp({"base_resp": {"status_code": 2038, "status_msg": "x"}})])
        with self.assertRaises(VideoModelUnavailable) as ctx:
            client.submit(_spec())
        self.assertIn("verification", ctx.exception.remedy)

    def test_http_statuses_get_their_own_remedy(self):
        cases = {401: "MINIMAX_API_KEY", 402: "top up", 429: "wait", 400: "will not help", 503: "re-run"}
        for status, needle in cases.items():
            with self.subTest(status=status):
                client = self._client(posts=[FakeResp({}, status=status)])
                with self.assertRaises(VideoModelUnavailable) as ctx:
                    client.submit(_spec())
                self.assertIn(needle, ctx.exception.remedy)

    def test_a_network_error_on_submit_stops_with_re_run(self):
        client = self._client(posts=[requests.ConnectionError(f"reset {KEY}")])
        with self.assertRaises(VideoModelUnavailable) as ctx:
            client.submit(_spec())
        self.assertIn("re-run", ctx.exception.remedy)
        _assert_no_secret(self, ctx.exception)

    def test_poll_network_error_is_pending_not_failed(self):
        client = self._client(gets=[requests.ConnectionError("reset")])
        self.assertEqual(client.resume("123", "/tmp/none.mp4").state, OUTCOME_PENDING)

    def test_poll_auth_failure_raises(self):
        client = self._client(gets=[FakeResp({"base_resp": {"status_code": 1004, "status_msg": "x"}})])
        with self.assertRaises(VideoModelUnavailable):
            client.resume("123", "/tmp/none.mp4")

    def test_the_key_never_reaches_a_log_line(self):
        client = self._client(posts=[FakeResp({"task_id": "1", "base_resp": {"status_code": 0}})],
                              gets=[requests.ConnectionError(f"boom {KEY}")])
        with self.assertLogs("modules.minimax_client", level="WARNING") as logs:
            client.generate(_spec(), "/tmp/none.mp4")
        _assert_no_secret(self, *logs.output)


# ── Kling ────────────────────────────────────────────────────────────────────

def _decode(part: str) -> dict:
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))


class KlingTestCase(unittest.TestCase):
    def _cfg(self, **env):
        base = {"KLING_API_KEY": "", "KLING_ACCESS_KEY": "", "KLING_SECRET_KEY": ""}
        base.update(env)
        with mock.patch.multiple(config, **base, create=True):
            return vp._kling_config()

    def test_defaults_are_the_international_host_and_a_documented_model(self):
        self.assertEqual(config.KLING_BASE_URL, "https://api-singapore.klingai.com")
        self.assertEqual(config.KLING_MODEL, "kling-v2-6")
        cfg = self._cfg(KLING_API_KEY=KEY)
        self.assertEqual(cfg.base_url, config.KLING_BASE_URL)

    def test_body_uses_model_name_and_string_duration(self):
        cfg = self._cfg(KLING_API_KEY=KEY)
        client = vp.GenericAsyncVideoClient(cfg)
        client.session = FakeSession(posts=[FakeResp({"code": 0, "data": {"task_id": "k-1"}})])
        self.assertEqual(client.submit(_spec(10)), "k-1")
        call = client.session.calls[0]
        self.assertTrue(call["url"].endswith("/v1/videos/text2video"))
        body = call["json"]
        self.assertEqual(body["model_name"], cfg.model)
        self.assertNotIn("model", body)
        self.assertEqual(body["duration"], "10")
        self.assertEqual(body["mode"], "std")
        self.assertEqual(body["aspect_ratio"], "16:9")

    def test_console_key_is_sent_as_bearer(self):
        cfg = self._cfg(KLING_API_KEY=KEY)
        client = vp.GenericAsyncVideoClient(cfg)
        self.assertEqual(client.session.headers["Authorization"], f"Bearer {KEY}")
        self.assertEqual(client._auth_headers(), {})

    def test_access_and_secret_key_sign_a_fresh_jwt(self):
        cfg = self._cfg(KLING_ACCESS_KEY="ak-123", KLING_SECRET_KEY=SECRET)
        client = vp.GenericAsyncVideoClient(cfg)
        self.assertNotIn("Authorization", client.session.headers)
        client.session = FakeSession(posts=[FakeResp({"code": 0, "data": {"task_id": "k-1"}})])
        client.submit(_spec())
        auth = client.session.calls[0]["headers"]["Authorization"]
        token = auth.split(" ", 1)[1]
        header, payload, sig = token.split(".")
        self.assertEqual(_decode(header), {"alg": "HS256", "typ": "JWT"})
        claims = _decode(payload)
        self.assertEqual(claims["iss"], "ak-123")
        self.assertEqual(claims["exp"] - claims["nbf"], 1800 + 5)
        expected = base64.urlsafe_b64encode(hmac.new(
            SECRET.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
        self.assertEqual(sig, expected)
        _assert_no_secret(self, auth, repr(cfg))

    def test_combined_access_secret_in_the_api_key_field(self):
        cfg = self._cfg(KLING_API_KEY=f"ak-9:{SECRET}")
        self.assertEqual(cfg.api_key, "ak-9")
        self.assertEqual(cfg.secret_key, SECRET)

    def test_business_codes_pick_the_remedy(self):
        for code, needle in ((1000, "KLING_ACCESS_KEY"), (1102, "top up"), (1303, "wait")):
            with self.subTest(code=code):
                client = vp.GenericAsyncVideoClient(self._cfg(KLING_API_KEY=KEY))
                client.session = FakeSession(posts=[FakeResp({"code": code, "message": "no"})])
                with self.assertRaises(VideoModelUnavailable) as ctx:
                    client.submit(_spec())
                self.assertIn(needle, ctx.exception.remedy)

    def test_poll_reads_task_result_videos(self):
        client = vp.GenericAsyncVideoClient(self._cfg(KLING_API_KEY=KEY))
        client.session = FakeSession(gets=[
            FakeResp({"code": 0, "data": {"task_status": "processing"}}),
            FakeResp({"code": 0, "data": {"task_status": "succeed",
                                          "task_result": {"videos": [{"url": "https://cdn.kling.test/v.mp4"}]}}}),
        ])
        with _no_sleep():
            state, url, _ = client._await("k-1")
        self.assertEqual((state, url), (OUTCOME_SUCCEEDED, "https://cdn.kling.test/v.mp4"))
        self.assertTrue(client.session.calls[0]["url"].endswith("/v1/videos/text2video/k-1"))

    def test_poll_failure_carries_kling_reason(self):
        client = vp.GenericAsyncVideoClient(self._cfg(KLING_API_KEY=KEY))
        client.session = FakeSession(gets=[FakeResp({"code": 0, "data": {
            "task_status": "failed", "task_status_msg": "risk control"}})])
        outcome = client.resume("k-1", "/tmp/none.mp4")
        self.assertEqual(outcome.state, OUTCOME_FAILED)
        self.assertIn("risk control", outcome.reason)


# ── Seedance ─────────────────────────────────────────────────────────────────

class SeedanceTestCase(unittest.TestCase):
    def _client(self, posts=(), gets=()):
        with mock.patch.object(config, "SEEDANCE_API_KEY", KEY):
            client = vp.GenericAsyncVideoClient(vp._seedance_config())
        client.session = FakeSession(posts, gets)
        return client

    def test_defaults_are_byteplus_international_and_a_dated_model(self):
        self.assertEqual(config.SEEDANCE_BASE_URL, "https://ark.ap-southeast.bytepluses.com")
        self.assertRegex(config.SEEDANCE_MODEL, r"-\d{6}$")

    def test_body_is_a_content_array_with_top_level_settings(self):
        client = self._client(posts=[FakeResp({"id": "cgt-1"})])
        self.assertEqual(client.submit(_spec(5)), "cgt-1")
        call = client.session.calls[0]
        self.assertTrue(call["url"].endswith("/api/v3/contents/generations/tasks"))
        body = call["json"]
        self.assertEqual(body["content"], [{"type": "text", "text": "a cinematic shot of Rome"}])
        self.assertEqual(body["ratio"], "16:9")
        self.assertEqual(body["duration"], 5)
        self.assertEqual(body["resolution"], config.SEEDANCE_RESOLUTION)
        self.assertNotIn("prompt", body)
        self.assertNotIn("--", json.dumps(body))   # no text-flag settings

    def test_poll_reads_content_video_url_and_error(self):
        client = self._client(gets=[FakeResp({"status": "succeeded",
                                              "content": {"video_url": "https://cdn.bp.test/v.mp4"}})])
        self.assertEqual(client._await("cgt-1")[:2], (OUTCOME_SUCCEEDED, "https://cdn.bp.test/v.mp4"))
        client = self._client(gets=[FakeResp({"status": "failed",
                                              "error": {"code": "OutputVideoSensitiveContentDetected",
                                                        "message": "sensitive"}})])
        outcome = client.resume("cgt-1", "/tmp/none.mp4")
        self.assertEqual(outcome.state, OUTCOME_FAILED)
        self.assertIn("sensitive", outcome.reason)

    def test_error_codes_pick_the_remedy(self):
        cases = (
            (401, "AuthenticationError", "SEEDANCE_API_KEY"),
            (404, "ModelNotOpen", "model id"),
            (403, "AccountOverdueError", "top up"),
        )
        for status, code, needle in cases:
            with self.subTest(code=code):
                client = self._client(posts=[FakeResp({"error": {"code": code, "message": "m"}}, status=status)])
                with self.assertRaises(VideoModelUnavailable) as ctx:
                    client.submit(_spec())
                self.assertIn(needle, ctx.exception.remedy)


# ── Wan ──────────────────────────────────────────────────────────────────────

class WanTestCase(unittest.TestCase):
    def _cfg(self, workspace="", base=""):
        with mock.patch.object(config, "WAN_API_KEY", KEY), \
             mock.patch.object(config, "WAN_WORKSPACE_ID", workspace, create=True), \
             mock.patch.object(config, "WAN_BASE_URL", base):
            return vp._wan_config()

    def test_default_model_is_current(self):
        self.assertEqual(self._cfg().model, config.WAN_MODEL)
        self.assertTrue(config.WAN_MODEL.startswith("wan2.7"))

    def test_hosts(self):
        self.assertEqual(self._cfg().base_url, "https://dashscope-intl.aliyuncs.com")
        self.assertEqual(self._cfg(workspace="ws-12ab").base_url,
                         "https://ws-12ab.ap-southeast-1.maas.aliyuncs.com")
        self.assertEqual(self._cfg(workspace="ws-12ab", base="https://proxy.test").base_url,
                         "https://proxy.test")

    def test_a_workspace_id_that_is_not_a_hostname_label_is_refused(self):
        cfg = self._cfg(workspace="evil.com/x")
        self.assertEqual(cfg.base_url, "https://dashscope-intl.aliyuncs.com")
        client = vp.GenericAsyncVideoClient(cfg)
        client.session = FakeSession()
        with self.assertRaises(VideoModelUnavailable) as ctx:
            client.submit(_spec())
        self.assertEqual(client.session.calls, [])
        self.assertIn("WAN_WORKSPACE_ID", ctx.exception.remedy)

    def test_body_wraps_input_and_parameters_and_asks_for_async(self):
        client = vp.GenericAsyncVideoClient(self._cfg())
        client.session = FakeSession(posts=[FakeResp({"output": {"task_id": "w-1", "task_status": "PENDING"}})])
        self.assertEqual(client.submit(_spec(8)), "w-1")
        call = client.session.calls[0]
        self.assertTrue(call["url"].endswith("/api/v1/services/aigc/video-generation/video-synthesis"))
        self.assertEqual(call["headers"].get("X-DashScope-Async"), "enable")
        body = call["json"]
        self.assertEqual(body["model"], "wan2.7-t2v")
        self.assertEqual(body["input"]["prompt"], "a cinematic shot of Rome")
        self.assertIn("negative_prompt", body["input"])
        self.assertEqual(body["parameters"], {"ratio": "16:9", "duration": 8, "resolution": "720P"})
        self.assertNotIn("prompt", body)

    def test_poll_reads_output_task_status(self):
        client = vp.GenericAsyncVideoClient(self._cfg())
        client.session = FakeSession(gets=[
            FakeResp({"output": {"task_status": "RUNNING"}}),
            FakeResp({"output": {"task_status": "SUCCEEDED", "video_url": "https://oss.test/w.mp4"}}),
        ])
        with _no_sleep():
            self.assertEqual(client._await("w-1")[:2], (OUTCOME_SUCCEEDED, "https://oss.test/w.mp4"))
        self.assertTrue(client.session.calls[0]["url"].endswith("/api/v1/tasks/w-1"))
        # The async header belongs to the create call only.
        self.assertNotIn("X-DashScope-Async", client.session.calls[0]["headers"])

    def test_poll_failure_carries_the_message(self):
        client = vp.GenericAsyncVideoClient(self._cfg())
        client.session = FakeSession(gets=[FakeResp({"output": {
            "task_status": "FAILED", "code": "DataInspectionFailed", "message": "inappropriate"}})])
        outcome = client.resume("w-1", "/tmp/none.mp4")
        self.assertEqual(outcome.state, OUTCOME_FAILED)
        self.assertIn("inappropriate", outcome.reason)

    def test_arrearage_is_a_billing_problem(self):
        client = vp.GenericAsyncVideoClient(self._cfg())
        client.session = FakeSession(posts=[FakeResp({"code": "Arrearage", "message": "overdue"}, status=400)])
        with self.assertRaises(VideoModelUnavailable) as ctx:
            client.submit(_spec())
        self.assertIn("top up", ctx.exception.remedy)
        _assert_no_secret(self, ctx.exception)


# ── shared client behaviour ──────────────────────────────────────────────────

class DownloadHeaderTestCase(unittest.TestCase):
    def test_the_key_is_stripped_for_a_cdn_host_and_kept_for_the_api_host(self):
        cfg = vp.VideoProviderConfig(name="T", api_key=KEY, base_url="https://api.test",
                                     model="m", submit_path="/s", query_path="/j/{id}")
        client = vp.GenericAsyncVideoClient(cfg)
        self.assertEqual(client._headers_for_download("https://cdn.other.test/x.mp4"),
                         {"Authorization": None})
        self.assertEqual(client._headers_for_download("https://api.test/files/x"), {})

    def test_config_repr_hides_keys(self):
        cfg = vp.VideoProviderConfig(name="T", api_key=KEY, base_url="https://api.test", model="m",
                                     submit_path="/s", query_path="/j/{id}", secret_key=SECRET)
        _assert_no_secret(self, repr(cfg))

    def test_a_response_without_a_task_id_is_a_stop_not_a_silent_none(self):
        cfg = vp.VideoProviderConfig(name="T", api_key=KEY, base_url="https://api.test",
                                     model="m", submit_path="/s", query_path="/j/{id}")
        client = vp.GenericAsyncVideoClient(cfg)
        client.session = FakeSession(posts=[FakeResp({"unexpected": True})])
        with self.assertRaises(VideoModelUnavailable) as ctx:
            client.submit(_spec())
        self.assertIn("no task id", str(ctx.exception))


class VendorEchoTestCase(unittest.TestCase):
    """Some APIs quote the key they were sent back in their error text."""

    def test_an_echoed_key_is_cut_out_of_the_reason(self):
        cfg = vp.VideoProviderConfig(name="T", api_key=KEY, base_url="https://api.test", model="m",
                                     submit_path="/s", query_path="/j/{id}", dialect=vp.WAN)
        client = vp.GenericAsyncVideoClient(cfg)
        client.session = FakeSession(posts=[FakeResp(
            {"code": "InvalidParameter", "message": f"bad request for key {KEY}"}, status=400)])
        with self.assertRaises(VideoModelUnavailable) as ctx:
            client.submit(_spec())
        _assert_no_secret(self, ctx.exception)
        self.assertIn("[redacted]", str(ctx.exception))

    def test_a_credentials_refusal_drops_the_vendor_text_entirely(self):
        # A masked echo ("sk-ab***") is still part of a key.
        client = mc.MiniMaxClient(api_key=KEY, model="MiniMax-Hailuo-2.3")
        client.session = FakeSession(posts=[FakeResp({"base_resp": {
            "status_code": 1004, "status_msg": f"invalid key {KEY[:6]}***"}})])
        with self.assertRaises(VideoModelUnavailable) as ctx:
            client.submit(_spec())
        self.assertNotIn(KEY[:6], str(ctx.exception))
        self.assertIn("1004", str(ctx.exception))


class RouterPreflightTestCase(unittest.TestCase):
    def test_off_is_a_no_op(self):
        with mock.patch.object(config, "VIDEO_PROVIDER", "minimax"), \
             mock.patch.object(config, "MINIMAX_BROLL_ENABLED", False):
            vp.preflight()

    def test_h3_without_query_path_stops_the_run_before_it_spends(self):
        with mock.patch.object(config, "VIDEO_PROVIDER", "minimax"), \
             mock.patch.object(config, "MINIMAX_BROLL_ENABLED", True), \
             mock.patch.object(config, "MINIMAX_API_KEY", KEY), \
             mock.patch.object(config, "MINIMAX_H3_MODEL", "MiniMax-H3"), \
             mock.patch.object(config, "MINIMAX_V2_QUERY_PATH", "", create=True):
            with self.assertRaises(VideoModelUnavailable):
                vp.preflight()

    def test_hailuo_passes(self):
        with mock.patch.object(config, "VIDEO_PROVIDER", "minimax"), \
             mock.patch.object(config, "MINIMAX_BROLL_ENABLED", True), \
             mock.patch.object(config, "MINIMAX_API_KEY", KEY), \
             mock.patch.object(config, "MINIMAX_H3_MODEL", "MiniMax-Hailuo-2.3"):
            vp.preflight()


class NoLeakInLogsTestCase(unittest.TestCase):
    def test_generic_poll_failure_logs_no_key(self):
        cfg = vp.VideoProviderConfig(name="T", api_key=KEY, base_url="https://api.test",
                                     model="m", submit_path="/s", query_path="/j/{id}")
        client = vp.GenericAsyncVideoClient(cfg)
        client.session = FakeSession(gets=[requests.ConnectionError(f"reset {KEY}")])
        with self.assertLogs("modules.video_providers", level=logging.WARNING) as logs:
            client.resume("j-1", "/tmp/none.mp4")
        _assert_no_secret(self, *logs.output)


if __name__ == "__main__":
    unittest.main()
