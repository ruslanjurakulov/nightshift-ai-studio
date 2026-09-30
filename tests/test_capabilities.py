"""The capability layer: typed errors, no key anywhere it could leak, and the
vendor-specific rules that decide whether a paid call is safe to make.

Every adapter is driven through a fake HTTP session, so nothing here touches a
network or spends anything.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import logging
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import requests

from modules import model_registry as reg
from modules.capabilities import ADAPTERS, build_adapter
from modules.capabilities import base
from modules.capabilities.base import (
    E_AUTH,
    E_BAD_REQUEST,
    E_NOT_CONFIGURED,
    E_NOT_FOUND,
    E_POLICY,
    E_QUOTA,
    E_RATE_LIMITED,
    E_UNAVAILABLE,
    FAILED,
    SUCCEEDED,
    AdapterError,
    CapabilityRequest,
    PollResult,
    ProviderTask,
    classify_http,
)
from modules.capabilities.video import KLING_JWT_TTL_S, KlingAdapter, kling_jwt

SECRET = "sk-live-TOPSECRET-0123456789abcdef"
ACCESS, SK = "AKlingAccess0123456789", "SKlingSecretABCDEFGHIJ0123"

#: One env that configures every adapter with the same recognisable secret.
ENV = {name: SECRET for cls in ADAPTERS.values() for name in cls.key_env}
ENV.update({"KLING_API_KEY": "", "KLING_ACCESS_KEY": ACCESS, "KLING_SECRET_KEY": SK})


class FakeResp:
    def __init__(self, status=200, body=None, content=b"", headers=None):
        self.status_code = status
        self._body = body
        self.text = body if isinstance(body, str) else json.dumps(body) if body is not None else ""
        self.content = content
        self.headers = headers or {}

    def json(self):
        if isinstance(self._body, str):
            return json.loads(self._body)
        return self._body

    def iter_content(self, chunk_size=1):
        yield self.content

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeSession:
    """Answers requests from a list of (method, url-substring, response)."""

    def __init__(self, routes=(), downloads=None):
        self.routes = list(routes)
        self.downloads = downloads or {}
        self.calls = []

    def request(self, method, url, **kw):
        self.calls.append((method, url, kw))
        for m, frag, resp in self.routes:
            if m == method and frag in url:
                if isinstance(resp, Exception):
                    raise resp
                return resp
        raise AssertionError(f"unexpected {method} {url}")

    def get(self, url, **kw):
        self.calls.append(("DOWNLOAD", url, kw))
        return self.downloads[url]


def adapter(key, routes=(), env=ENV, downloads=None):
    return build_adapter(key, env=env, session=FakeSession(routes, downloads))


class ClassifyHttpTests(unittest.TestCase):
    def test_same_status_opposite_remedies(self):
        # CLAUDE.md #6: invalid key and empty balance need opposite responses.
        self.assertEqual(classify_http(401, "invalid api key"), E_AUTH)
        self.assertEqual(classify_http(403, "forbidden"), E_AUTH)
        self.assertEqual(classify_http(403, "billing hard limit"), E_QUOTA)
        self.assertEqual(classify_http(402, ""), E_QUOTA)
        self.assertEqual(classify_http(429, "insufficient_quota"), E_QUOTA)
        self.assertEqual(classify_http(429, "slow down"), E_RATE_LIMITED)
        self.assertEqual(classify_http(400, "moderation_blocked: safety system"), E_POLICY)
        self.assertEqual(classify_http(400, "size must be 1024x1024"), E_BAD_REQUEST)
        self.assertEqual(classify_http(404, ""), E_NOT_FOUND)
        self.assertEqual(classify_http(503, ""), E_UNAVAILABLE)

    def test_only_transient_codes_are_retryable(self):
        self.assertTrue(AdapterError(E_RATE_LIMITED).retryable)
        self.assertTrue(AdapterError(E_UNAVAILABLE).retryable)
        for code in (E_AUTH, E_QUOTA, E_POLICY, E_BAD_REQUEST):
            self.assertFalse(AdapterError(code).retryable, code)

    def test_unknown_code_is_never_success(self):
        self.assertEqual(AdapterError("made_up").code, E_UNAVAILABLE)


class VendorErrorMappingTests(unittest.TestCase):
    def submit_err(self, key, routes, request, model="m"):
        with self.assertRaises(AdapterError) as cm:
            adapter(key, routes).submit(request, model)
        return cm.exception.code

    def test_kling_business_codes(self):
        t2v = CapabilityRequest("t2v", "x", duration_s=5)
        for kcode, want in ((1002, E_AUTH), (1102, E_QUOTA), (1201, E_BAD_REQUEST), (1301, E_POLICY),
                            (1302, E_RATE_LIMITED), (5000, E_UNAVAILABLE)):
            got = self.submit_err("video.kling", [("POST", "/v1/videos/text2video",
                                                   FakeResp(200, {"code": kcode, "message": "no"}))], t2v)
            self.assertEqual(got, want, kcode)
        # The same code in a non-2xx body wins over the HTTP status.
        got = self.submit_err("video.kling", [("POST", "text2video", FakeResp(400, {"code": 1102}))], t2v)
        self.assertEqual(got, E_QUOTA)

    def test_minimax_base_resp_codes(self):
        t2v = CapabilityRequest("t2v", "x", duration_s=6)
        for mcode, want in ((1004, E_AUTH), (2049, E_AUTH), (1008, E_QUOTA), (1026, E_POLICY),
                            (1002, E_RATE_LIMITED), (2013, E_BAD_REQUEST)):
            body = {"base_resp": {"status_code": mcode, "status_msg": "x"}}
            got = self.submit_err("video.minimax", [("POST", "/v1/video_generation", FakeResp(200, body))], t2v)
            self.assertEqual(got, want, mcode)

    def test_seedance_and_wan_error_vocabularies(self):
        t2v = CapabilityRequest("t2v", "x", duration_s=5)
        body = {"error": {"code": "AccountOverdueError", "message": "pay"}}
        self.assertEqual(self.submit_err("video.seedance", [("POST", "tasks", FakeResp(403, body))], t2v), E_QUOTA)
        body = {"error": {"code": "InputTextSensitiveContentDetected"}}
        self.assertEqual(self.submit_err("video.seedance", [("POST", "tasks", FakeResp(400, body))], t2v), E_POLICY)
        self.assertEqual(self.submit_err("video.wan", [("POST", "video-synthesis", FakeResp(400, {"code": "Arrearage"}))], t2v), E_QUOTA)
        self.assertEqual(self.submit_err("video.wan", [("POST", "video-synthesis", FakeResp(401, {"code": "InvalidApiKey"}))], t2v), E_AUTH)
        self.assertEqual(self.submit_err("video.wan", [("POST", "video-synthesis", FakeResp(429, {"code": "Throttling.RateQuota"}))], t2v), E_RATE_LIMITED)

    def test_failed_tasks_carry_typed_codes(self):
        luma = adapter("video.luma", [("GET", "/generations/g1", FakeResp(200, {"state": "failed", "failure_code": "budget_exhausted"}))])
        res = luma.poll(ProviderTask("video.luma", "ray-3.2", "g1"))
        self.assertEqual((res.state, res.error.code), (FAILED, E_QUOTA))
        runway = adapter("video.runway", [("GET", "/v1/tasks/t1", FakeResp(200, {"status": "FAILED", "failureCode": "SAFETY.INPUT.TEXT"}))])
        self.assertEqual(runway.poll(ProviderTask("video.runway", "gen4.5", "t1")).error.code, E_POLICY)
        veo = adapter("video.veo", [("GET", "operations/op1", FakeResp(200, {"done": True, "response": {
            "generateVideoResponse": {"raiMediaFilteredCount": 1, "raiMediaFilteredReasons": ["celebrity"]}}}))])
        self.assertEqual(veo.poll(ProviderTask("video.veo", "v", "models/veo-3.1-generate-preview/operations/op1")).error.code, E_POLICY)

    def test_network_failure_is_unavailable_not_a_crash(self):
        got = self.submit_err("image.openai", [("POST", "images", requests.ConnectionError("boom"))],
                              CapabilityRequest("t2i", "x"))
        self.assertEqual(got, E_UNAVAILABLE)

    def test_missing_key_fails_before_any_call(self):
        a = build_adapter("video.veo", env={}, session=FakeSession())
        with self.assertRaises(AdapterError) as cm:
            a.submit(CapabilityRequest("t2v", "x"), "veo-3.1-generate-preview")
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertEqual(a.session.calls, [])


class NoKeyAnywhereTests(unittest.TestCase):
    """No key reaches a message, a log line, a stored task, or a repr — even
    when the vendor echoes it back."""

    def setUp(self):
        self.log = io.StringIO()
        self.handler = logging.StreamHandler(self.log)
        root = logging.getLogger()
        root.addHandler(self.handler)
        self.old_level = root.level
        root.setLevel(logging.DEBUG)

    def tearDown(self):
        logging.getLogger().removeHandler(self.handler)
        logging.getLogger().setLevel(self.old_level)

    def assertClean(self, *texts):
        blob = "\n".join(map(str, texts)) + self.log.getvalue()
        for s in (SECRET, ACCESS, SK):
            self.assertNotIn(s, blob)

    def test_every_adapter_scrubs_an_echoed_key(self):
        echo = FakeResp(401, f'{{"error": "bad key {SECRET} / {ACCESS} / {SK} Bearer {SECRET}"}}')
        for key, cls in ADAPTERS.items():
            entry = next(e for e in reg.load().values() if e.adapter == key)
            req = entry.probe_request(voice_id="A" * 20, generated_image=None)
            if req.input_images:
                req = CapabilityRequest(req.capability, req.prompt, aspect_ratio=req.aspect_ratio,
                                        duration_s=req.duration_s, input_images=("https://x.test/a.png",))
            a = build_adapter(key, env=ENV, session=FakeSession([("POST", "", echo), ("GET", "", echo)]))
            with self.assertRaises(AdapterError) as cm:
                a.submit(req, entry.vendor_model)
            logging.getLogger("test").error("adapter failed: %s", cm.exception)
            self.assertClean(cm.exception, cm.exception.message, repr(cm.exception), key)

    def test_tasks_and_outputs_do_not_serialise_secrets(self):
        veo = adapter("video.veo", [("GET", "operations/op1", FakeResp(200, {"done": True, "response": {
            "generateVideoResponse": {"generatedSamples": [{"video": {"uri": "https://generativelanguage.googleapis.com/v1beta/files/f:download"}}]}}}))])
        task = ProviderTask("video.veo", "veo-3.1-generate-preview", "models/veo-3.1-generate-preview/operations/op1")
        res = veo.poll(task)
        self.assertEqual(res.state, SUCCEEDED)
        self.assertClean(json.dumps(task.to_dict()), repr(task), repr(res), repr(res.outputs[0]))

    def test_probe_tool_output_is_scrubbed(self):
        from tools import probe_models

        out = io.StringIO()
        env = dict(ENV, OPENAI_API_KEY=SECRET)
        db = mock.Mock()
        session = FakeSession([("POST", "images/generations", FakeResp(401, f"invalid key {SECRET}"))])
        with mock.patch.object(probe_models, "build_adapter",
                               lambda k, env=None, session=None: build_adapter(k, env=env, session=session_)):
            session_ = session
            code = probe_models.main(["--model", "openai-gpt-image-2"], env=env, db=db, stream=out)
        self.assertEqual(code, 1)
        text = out.getvalue()
        self.assertIn("FAIL openai-gpt-image-2: auth", text)
        self.assertNotIn(SECRET, text)
        recorded = json.dumps(db.record.call_args.kwargs)
        self.assertNotIn(SECRET, recorded)
        self.assertEqual(db.record.call_args.kwargs["error_code"], "auth")

    def test_scrub_filter_rewrites_any_record(self):
        from tools import probe_models

        out = io.StringIO()
        probe_models.setup_logging({"SOME_API_KEY": SECRET}, out)
        try:
            logging.getLogger("x").info("leak %s here", SECRET)
            logging.getLogger("x").info("token eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJhYmMifQ.c2lnbmF0dXJlc2ln")
        finally:
            for h in list(logging.getLogger().handlers):
                logging.getLogger().removeHandler(h)
        self.assertNotIn(SECRET, out.getvalue())
        self.assertNotIn("eyJhbGciOiJIUzI1NiJ9.", out.getvalue())


class DownloadSafetyTests(unittest.TestCase):
    def test_google_key_header_is_not_forwarded_on_redirect(self):
        first = "https://generativelanguage.googleapis.com/v1beta/files/f:download"
        second = "https://storage.googleusercontent.test/blob"
        veo = adapter("video.veo", downloads={
            first: FakeResp(302, headers={"Location": second}),
            second: FakeResp(200, content=b"\x00\x00\x00\x18ftypmp42"),
        })
        with tempfile.TemporaryDirectory() as d:
            res = PollResult(SUCCEEDED, [base.Output("video/mp4", url=first, url_headers=veo.auth_headers())])
            paths = veo.fetch(res, d)
            self.assertTrue(paths[0].read_bytes().startswith(b"\x00"))
        dl = [c for c in veo.session.calls if c[0] == "DOWNLOAD"]
        self.assertEqual(dl[0][2]["headers"], {"x-goog-api-key": SECRET})
        self.assertIsNone(dl[1][2]["headers"])
        self.assertFalse(dl[1][2]["allow_redirects"])

    def test_veo_refuses_a_file_uri_on_another_host(self):
        veo = adapter("video.veo", [("GET", "operations/op1", FakeResp(200, {"done": True, "response": {
            "generateVideoResponse": {"generatedSamples": [{"video": {"uri": "https://generativelanguage.googleapis.com.evil.test/x"}}]}}}))])
        with self.assertRaises(AdapterError):
            veo.poll(ProviderTask("video.veo", "v", "models/veo-3.1-generate-preview/operations/op1"))

    def test_bfl_polling_url_must_be_a_bfl_host(self):
        flux = adapter("image.bfl")
        for evil in ("https://evil.test/x.bfl.ai/get_result", "http://api.bfl.ai/v1/get_result",
                     "https://bfl.ai.evil.test/x"):
            with self.assertRaises(AdapterError) as cm:
                flux.poll(ProviderTask("image.bfl", "flux-2-pro", evil))
            self.assertEqual(cm.exception.code, E_NOT_FOUND)
        self.assertEqual(flux.session.calls, [])

    def test_task_ids_cannot_steer_the_request(self):
        for key, tid in (("video.runway", "../../v1/organization"), ("video.luma", "a/b"),
                         ("video.kling", "text2video/../../x"), ("video.veo", "operations/../../x")):
            a = adapter(key)
            with self.assertRaises(AdapterError):
                a.poll(ProviderTask(key, "m", tid))
            self.assertEqual(a.session.calls, [], key)

    def test_a_non_https_base_url_override_is_ignored(self):
        a = build_adapter("video.runway", env=dict(ENV, RUNWAY_BASE_URL="http://evil.test"), session=FakeSession())
        self.assertEqual(a.base_url, "https://api.dev.runwayml.com")


class KlingJwtTests(unittest.TestCase):
    @staticmethod
    def decode(token):
        h, p, s = token.split(".")
        pad = lambda x: x + "=" * (-len(x) % 4)  # noqa: E731
        return json.loads(base64.urlsafe_b64decode(pad(h))), json.loads(base64.urlsafe_b64decode(pad(p))), s

    def test_token_is_hs256_signed_and_expires_in_thirty_minutes(self):
        tok = kling_jwt(ACCESS, SK, now=1_000_000)
        header, payload, sig = self.decode(tok)
        self.assertEqual(header, {"alg": "HS256", "typ": "JWT"})
        self.assertEqual(payload, {"iss": ACCESS, "exp": 1_000_000 + 1800, "nbf": 1_000_000 - 5})
        signing = tok.rsplit(".", 1)[0].encode()
        want = base64.urlsafe_b64encode(hmac.new(SK.encode(), signing, hashlib.sha256).digest()).rstrip(b"=").decode()
        self.assertEqual(sig, want)
        self.assertEqual(KLING_JWT_TTL_S, 1800)

    def test_a_long_poll_never_sends_an_expired_token(self):
        a = KlingAdapter(env=ENV, session=FakeSession())
        for t in (1_000_000, 1_000_000 + 1799, 1_000_000 + 7200):
            with mock.patch("modules.capabilities.video.time.time", return_value=t):
                token = a.auth_headers()["Authorization"].split(" ", 1)[1]
            _, payload, _ = self.decode(token)
            self.assertGreater(payload["exp"], t)
            self.assertLessEqual(payload["nbf"], t)

    def test_console_api_key_is_sent_as_is_and_pair_is_preferred(self):
        a = KlingAdapter(env={"KLING_API_KEY": "console-key-123"}, session=FakeSession())
        self.assertEqual(a.auth_headers(), {"Authorization": "Bearer console-key-123"})
        b = KlingAdapter(env={"KLING_API_KEY": f"{ACCESS}:{SK}"}, session=FakeSession())
        self.assertEqual(self.decode(b.auth_headers()["Authorization"][7:])[1]["iss"], ACCESS)
        self.assertIn(SK, b.secrets())

    def test_submit_uses_model_name_and_the_international_host(self):
        routes = [("POST", "/v1/videos/text2video", FakeResp(200, {"code": 0, "data": {"task_id": "abc123"}}))]
        a = adapter("video.kling", routes)
        task = a.submit(CapabilityRequest("t2v", "boat", aspect_ratio="16:9", duration_s=5), "kling-v2-6")
        method, url, kw = a.session.calls[0]
        self.assertTrue(url.startswith("https://api-singapore.klingai.com/"))
        self.assertEqual(kw["json"]["model_name"], "kling-v2-6")
        self.assertEqual(task.task_id, "text2video/abc123")


class RequestShapeTests(unittest.TestCase):
    """The bodies each adapter sends, as the vendors' own SDKs send them."""

    def body(self, key, route, request, model, resp):
        a = adapter(key, [("POST", route, resp)])
        a.submit(request, model)
        return a.session.calls[0][2]

    def test_seedance_sends_settings_as_body_fields(self):
        kw = self.body("video.seedance", "tasks", CapabilityRequest("t2v", "boat", aspect_ratio="16:9",
                       resolution="480p", duration_s=5, audio=True), "seedance-1-5-pro-251215", FakeResp(200, {"id": "t1"}))
        self.assertEqual(kw["json"]["ratio"], "16:9")
        self.assertEqual(kw["json"]["generate_audio"], True)
        self.assertNotIn("--", kw["json"]["content"][0]["text"])

    def test_luma_uses_the_agents_api_video_object(self):
        a = adapter("video.luma", [("POST", "/generations", FakeResp(200, {"id": "g1"}))])
        a.submit(CapabilityRequest("t2v", "boat", aspect_ratio="16:9", resolution="540p", duration_s=5), "ray-3.2")
        method, url, kw = a.session.calls[0]
        self.assertEqual(url, "https://agents.lumalabs.ai/v1/generations")
        self.assertEqual(kw["json"]["type"], "video")
        self.assertEqual(kw["json"]["video"], {"duration": "5s", "resolution": "540p"})

    def test_wan_uses_the_workspace_host_and_resolution_ratio(self):
        env = dict(ENV, WAN_WORKSPACE_ID="ws-123")
        a = build_adapter("video.wan", env=env, session=FakeSession([("POST", "video-synthesis", FakeResp(200, {"output": {"task_id": "t"}}))]))
        a.submit(CapabilityRequest("t2v", "boat", aspect_ratio="16:9", resolution="720p", duration_s=5), "wan2.7-t2v")
        method, url, kw = a.session.calls[0]
        self.assertTrue(url.startswith("https://ws-123.ap-southeast-1.maas.aliyuncs.com/"))
        self.assertEqual(kw["json"]["parameters"], {"resolution": "720P", "ratio": "16:9", "duration": 5})
        self.assertEqual(kw["headers"]["X-DashScope-Async"], "enable")
        bad = build_adapter("video.wan", env=dict(ENV, WAN_WORKSPACE_ID="evil.test/x"), session=FakeSession())
        self.assertEqual(bad.base_url, "https://dashscope-intl.aliyuncs.com")

    def test_openai_sends_the_safety_identifier_and_a_ratio_sized_image(self):
        png = base64.b64encode(b"\x89PNG....").decode()
        kw = self.body("image.openai", "images/generations",
                       CapabilityRequest("t2i", "apple", aspect_ratio="16:9", end_user="u_1a2b3c"),
                       "gpt-image-2", FakeResp(200, {"data": [{"b64_json": png}]}))
        self.assertEqual(kw["json"]["size"], "1536x864")
        self.assertEqual(kw["json"]["user"], "u_1a2b3c")
        w, h = map(int, kw["json"]["size"].split("x"))
        self.assertEqual((w % 16, h % 16), (0, 0))

    def test_openai_never_sends_an_email_as_the_safety_identifier(self):
        png = base64.b64encode(b"\x89PNG....").decode()
        kw = self.body("image.openai", "images/generations",
                       CapabilityRequest("t2i", "apple", end_user="alice@example.com"),
                       "gpt-image-2", FakeResp(200, {"data": [{"b64_json": png}]}))
        self.assertNotIn("user", kw["json"])

    def test_elevenlabs_sfx_sends_its_model_id(self):
        a = adapter("audio.elevenlabs_sfx", [("POST", "sound-generation", FakeResp(200, content=b"ID3audio"))])
        task = a.submit(CapabilityRequest("sfx", "knock", duration_s=1), "eleven_text_to_sound_v2")
        kw = a.session.calls[0][2]
        self.assertEqual(kw["json"]["model_id"], "eleven_text_to_sound_v2")
        self.assertEqual(task.outputs[0].data, b"ID3audio")

    def test_tts_without_a_voice_from_the_account_is_refused_before_any_call(self):
        a = adapter("audio.elevenlabs_tts")
        with self.assertRaises(AdapterError) as cm:
            a.submit(CapabilityRequest("tts", "hi"), "eleven_v3")
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertEqual(a.session.calls, [])


class ProbeToolTests(unittest.TestCase):
    def test_dry_run_calls_nothing_and_records_nothing(self):
        from tools import probe_models

        out = io.StringIO()
        db = mock.Mock()
        with mock.patch("requests.Session.request", side_effect=AssertionError("network")):
            code = probe_models.main(["--dry-run", "--all"], env={}, db=db, stream=out)
        self.assertEqual(code, 0)
        self.assertEqual(db.mock_calls, [])
        self.assertIn("key=NO", out.getvalue())

    def test_unconfigured_models_are_skipped_not_recorded(self):
        from tools import probe_models

        db = mock.Mock()
        code = probe_models.main(["--model", "veo-3.1"], env={}, db=db, stream=io.StringIO())
        self.assertEqual(code, 0)
        db.record.assert_not_called()

    def test_a_tts_probe_without_a_chosen_voice_is_skipped_not_guessed(self):
        from tools import probe_models

        db = mock.Mock()
        with mock.patch("requests.Session.request", side_effect=AssertionError("network")):
            code = probe_models.main(["--model", "elevenlabs-v3"], env=ENV, db=db, stream=io.StringIO())
        self.assertEqual(code, 0)
        db.record.assert_not_called()

    def test_an_async_probe_polls_until_done_and_records_success(self):
        from tools import probe_models

        entry = reg.load()["luma-ray-3.2"]
        video = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64
        session = FakeSession(
            [("POST", "/generations", FakeResp(200, {"id": "g1"})),
             ("GET", "/generations/g1", FakeResp(200, {"state": "completed", "output": [{"type": "video", "url": "https://cdn.luma.test/v.mp4"}]}))],
            downloads={"https://cdn.luma.test/v.mp4": FakeResp(200, content=video)})
        with tempfile.TemporaryDirectory() as d:
            res = probe_models.run_probe(entry, env=ENV, voice_id=None, workdir=Path(d), session=session,
                                         sleep=lambda s: None)
        self.assertTrue(res.ok, res.message)
        self.assertEqual(res.output_bytes, len(video))

    def test_a_probe_that_never_finishes_times_out_with_the_task_id(self):
        from tools import probe_models

        entry = reg.load()["runway-gen4.5"]
        session = FakeSession([("POST", "text_to_video", FakeResp(200, {"id": "t9"})),
                               ("GET", "/v1/tasks/t9", FakeResp(200, {"status": "RUNNING"}))])
        ticks = iter(range(0, 100000, 400))
        with tempfile.TemporaryDirectory() as d:
            res = probe_models.run_probe(entry, env=ENV, voice_id=None, workdir=Path(d), session=session,
                                         timeout_s=900, sleep=lambda s: None, clock=lambda: next(ticks))
        self.assertEqual((res.ok, res.code, res.task_id), (False, "timeout", "t9"))

    def test_an_html_error_page_is_not_a_successful_image(self):
        from tools import probe_models

        entry = reg.load()["ideogram-3"]
        session = FakeSession([("POST", "ideogram-v3/generate", FakeResp(200, {"data": [{"url": "https://img.test/a.png"}]}))],
                              downloads={"https://img.test/a.png": FakeResp(200, content=b"<html>denied</html>")})
        with tempfile.TemporaryDirectory() as d:
            res = probe_models.run_probe(entry, env=ENV, voice_id=None, workdir=Path(d), session=session)
        self.assertFalse(res.ok)

    def test_success_is_recorded_only_through_record_model_probe(self):
        from tools import probe_models

        db = mock.Mock()
        ok = probe_models.ProbeResult("elevenlabs-sfx", True, latency_ms=10, output_bytes=5)
        with mock.patch.object(probe_models, "run_probe", return_value=ok):
            code = probe_models.main(["--model", "elevenlabs-sfx"], env=ENV, db=db, stream=io.StringIO())
        self.assertEqual(code, 0)
        kwargs = db.record.call_args.kwargs
        self.assertEqual((kwargs["model"], kwargs["ok"], kwargs["vendor_model"]),
                         ("elevenlabs-sfx", True, "eleven_text_to_sound_v2"))
        # No other write path: nothing sets availability from here.
        self.assertEqual([c[0] for c in db.mock_calls], ["record"])

    def test_probing_without_a_database_refuses_to_spend(self):
        from tools import probe_models

        with mock.patch.object(probe_models, "run_probe", side_effect=AssertionError("spent")):
            code = probe_models.main(["--model", "veo-3.1"], env=ENV, stream=io.StringIO())
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
