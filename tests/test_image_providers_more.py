"""The image generators beyond Leonardo (modules/image_providers.py).

No network: each client's session is replaced by a stub that records the
request and answers with the provider's documented response shape. Also pins
that every place listing the provider ids agrees (workflow choice list, the
queue's params check in migration 0023, run_request).
"""

import base64
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

import config
from modules import image_providers as ip
from modules import run_request

ROOT = Path(__file__).resolve().parent.parent
JPEG = b"\xff\xd8\xff\xe0fake-jpeg"
B64 = base64.b64encode(JPEG).decode()


class _Resp:
    def __init__(self, payload=None, *, chunks=None, status=None):
        self._payload = payload or {}
        self._chunks = chunks or []
        self._status = status

    def raise_for_status(self):
        if self._status:
            raise RuntimeError(f"HTTP {self._status}")

    def json(self):
        return self._payload

    def iter_content(self, chunk_size=0):
        yield from self._chunks

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _Session:
    def __init__(self, posts=(), gets=()):
        self.posts, self.gets = list(posts), list(gets)
        self.calls = []

    def post(self, url, **kw):
        self.calls.append(("POST", url, kw))
        return self.posts.pop(0)

    def get(self, url, **kw):
        self.calls.append(("GET", url, kw))
        return self.gets.pop(0)


def _client(cls, session, key="k-secret", model=""):
    with mock.patch.object(config, "IMAGE_MODEL", model):
        c = cls(api_key=key)
    c.session = session
    return c


class RouterTests(unittest.TestCase):
    def test_every_generator_needs_its_key_and_the_opt_in(self):
        for provider, attr in ip.KEY_ATTRS.items():
            with self.subTest(provider=provider), \
                    mock.patch.object(config, "IMAGE_PROVIDER", provider), \
                    mock.patch.object(config, attr, "key"):
                with mock.patch.object(config, "IMAGE_GEN_OPT_IN", False):
                    self.assertFalse(ip.is_enabled())
                with mock.patch.object(config, "IMAGE_GEN_OPT_IN", True):
                    self.assertTrue(ip.is_enabled())
                    self.assertIsNotNone(ip.get_client())
                with mock.patch.object(config, attr, ""), mock.patch.object(config, "IMAGE_GEN_OPT_IN", True):
                    self.assertFalse(ip.is_enabled())
                    self.assertIsNone(ip.get_client())

    def test_unknown_provider_is_off(self):
        with mock.patch.object(config, "IMAGE_PROVIDER", "midjourney"), \
                mock.patch.object(config, "IMAGE_GEN_OPT_IN", True):
            self.assertFalse(ip.is_enabled())
            self.assertIsNone(ip.get_client())

    def test_model_override_and_defaults(self):
        with mock.patch.object(config, "IMAGE_PROVIDER", "gpt-image"):
            with mock.patch.object(config, "IMAGE_MODEL", ""):
                self.assertEqual(ip.active_model(), "gpt-image-2")
            with mock.patch.object(config, "IMAGE_MODEL", "gpt-image-2.5"):
                self.assertEqual(ip.active_model(), "gpt-image-2.5")
        with mock.patch.object(config, "IMAGE_PROVIDER", "pexels"):
            self.assertEqual(ip.active_model(), "")

    def test_aspect(self):
        self.assertEqual(ip._aspect(1024, 576), "16:9")
        self.assertEqual(ip._aspect(576, 1024), "9:16")
        self.assertEqual(ip._aspect(1000, 1000), "1:1")


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.dest = self.tmp / "img.jpg"

    def assertNoKeyInUrls(self, session, key="k-secret"):
        for _, url, _ in session.calls:
            self.assertNotIn(key, url)

    def test_openai_writes_base64_and_never_sends_response_format(self):
        s = _Session(posts=[_Resp({"data": [{"b64_json": B64}]})])
        path = _client(ip.OpenAIImageClient, s).generate("a city", self.dest, width=1024, height=576)
        self.assertEqual(path.read_bytes(), JPEG)
        method, url, kw = s.calls[0]
        self.assertTrue(url.endswith("/images/generations"))
        self.assertEqual(kw["json"]["model"], "gpt-image-2")
        self.assertEqual(kw["json"]["size"], "1536x864")
        self.assertNotIn("response_format", kw["json"])
        self.assertEqual(kw["headers"]["Authorization"], "Bearer k-secret")
        self.assertNoKeyInUrls(s)

    def test_gemini_reads_inline_data_with_either_casing(self):
        for key in ("inlineData", "inline_data"):
            with self.subTest(key=key):
                payload = {"candidates": [{"content": {"parts": [{"text": "x"}, {key: {"mimeType": "image/png", "data": B64}}]}}]}
                s = _Session(posts=[_Resp(payload)])
                path = _client(ip.GeminiImageClient, s).generate("a city", self.dest)
                self.assertEqual(path.read_bytes(), JPEG)
                _, url, kw = s.calls[0]
                self.assertIn("/models/gemini-3.1-flash-image-preview:generateContent", url)
                self.assertEqual(kw["headers"]["x-goog-api-key"], "k-secret")
                self.assertEqual(kw["json"]["generationConfig"]["responseModalities"], ["IMAGE"])
                self.assertEqual(kw["json"]["generationConfig"]["imageConfig"]["aspectRatio"], "16:9")
                self.assertNoKeyInUrls(s)

    def test_gemini_text_only_answer_falls_back(self):
        s = _Session(posts=[_Resp({"candidates": [{"content": {"parts": [{"text": "refused"}]}}]})])
        self.assertIsNone(_client(ip.GeminiImageClient, s).generate("a city", self.dest))

    def test_flux_submits_polls_and_downloads(self):
        s = _Session(
            posts=[_Resp({"id": "j1", "polling_url": "https://api.us.bfl.ai/v1/get_result?id=j1"})],
            gets=[_Resp({"status": "Pending"}), _Resp({"status": "Ready", "result": {"sample": "https://cdn/x.jpg"}}),
                  _Resp(chunks=[JPEG])],
        )
        c = _client(ip.FluxClient, s)
        with mock.patch.object(ip.time, "sleep"):
            path = c.generate("a city", self.dest)
        self.assertEqual(path.read_bytes(), JPEG)
        _, url, kw = s.calls[0]
        self.assertTrue(url.endswith("/v1/flux-2-pro"))
        self.assertEqual(kw["headers"]["x-key"], "k-secret")
        self.assertEqual((kw["json"]["width"], kw["json"]["height"]), (1024, 576))
        self.assertEqual(s.calls[1][1], "https://api.us.bfl.ai/v1/get_result?id=j1")
        self.assertNoKeyInUrls(s)

    def test_flux_moderated_falls_back(self):
        s = _Session(posts=[_Resp({"polling_url": "https://p"})], gets=[_Resp({"status": "Content Moderated"})])
        self.assertIsNone(_client(ip.FluxClient, s).generate("a city", self.dest))

    def test_ideogram_sends_a_form_and_downloads(self):
        s = _Session(posts=[_Resp({"data": [{"url": "https://ideogram/x.png"}]})], gets=[_Resp(chunks=[JPEG])])
        path = _client(ip.IdeogramClient, s).generate("a city", self.dest)
        self.assertEqual(path.read_bytes(), JPEG)
        _, url, kw = s.calls[0]
        self.assertTrue(url.endswith("/v1/ideogram-v3/generate"))
        self.assertEqual(kw["headers"]["Api-Key"], "k-secret")
        self.assertEqual(kw["files"]["aspect_ratio"], (None, "16x9"))
        self.assertNoKeyInUrls(s)

    def test_fal_uses_the_model_id_in_the_path(self):
        s = _Session(posts=[_Resp({"images": [{"url": "https://fal.media/x.jpg"}]})], gets=[_Resp(chunks=[JPEG])])
        path = _client(ip.FalImageClient, s, model="fal-ai/bytedance/seedream/v4/text-to-image").generate("a city", self.dest)
        self.assertEqual(path.read_bytes(), JPEG)
        _, url, kw = s.calls[0]
        self.assertEqual(url, "https://fal.run/fal-ai/bytedance/seedream/v4/text-to-image")
        self.assertEqual(kw["headers"]["Authorization"], "Key k-secret")
        self.assertEqual(kw["json"]["image_size"], "landscape_16_9")

    def test_http_errors_never_raise_and_never_log_the_key(self):
        for cls in (ip.OpenAIImageClient, ip.GeminiImageClient, ip.FluxClient, ip.IdeogramClient, ip.FalImageClient):
            with self.subTest(cls=cls.__name__):
                s = _Session(posts=[_Resp(status=401)])
                with self.assertLogs(ip.logger, level="WARNING") as logs:
                    self.assertIsNone(_client(cls, s).generate("a city", self.dest))
                self.assertNotIn("k-secret", "\n".join(logs.output))

    def test_no_key_or_prompt_makes_no_request(self):
        for cls in (ip.OpenAIImageClient, ip.GeminiImageClient, ip.FluxClient, ip.IdeogramClient, ip.FalImageClient):
            s = _Session()
            self.assertIsNone(_client(cls, s, key="").generate("a city", self.dest))
            self.assertIsNone(_client(cls, s).generate("  ", self.dest))
            self.assertEqual(s.calls, [])


class ListsAgree(unittest.TestCase):
    def test_workflow_run_request_migration_and_router_agree(self):
        wf = yaml.safe_load((ROOT / ".github/workflows/daily_video.yml").read_text())
        options = tuple(o for o in wf[True]["workflow_dispatch"]["inputs"]["image_provider"]["options"] if o)
        self.assertEqual(options, ip.PROVIDERS)
        self.assertEqual(run_request.IMAGE_PROVIDERS, ip.PROVIDERS)
        sql = (ROOT / "supabase/migrations/0023_image_providers.sql").read_text()
        m = re.search(r"image_provider' not in \(([^)]*)\)", sql)
        self.assertEqual(tuple(re.findall(r"'([^']+)'", m.group(1))), ip.PROVIDERS)

    def test_every_generator_key_reaches_the_run_and_the_worker(self):
        wf = (ROOT / ".github/workflows/daily_video.yml").read_text()
        worker = (ROOT / "deploy/.env.worker.example").read_text()
        for attr in set(ip.KEY_ATTRS.values()) | {"CHRONOS_IMAGE_MODEL"}:
            self.assertRegex(wf, rf"\n\s+{attr}: \$\{{\{{ (secrets|vars)\.{attr} \}}\}}", attr)
            self.assertRegex(worker, rf"(?m)^{attr}=", attr)


if __name__ == "__main__":
    unittest.main()
