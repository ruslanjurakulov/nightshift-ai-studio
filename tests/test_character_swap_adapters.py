"""Character Studio's two adapters (modules/capabilities/character_swap.py) and their registry entries.

Every vendor call goes through a fake session: nothing here touches a network or spends anything. What is pinned:

* the request each maker documents (Kling 4.0 Omni: base_video + refer_image, settings.audio "original"; Seedance 2.5:
  omni_reference_task_type "edit", reference_video + reference_image, duration -1, ratio adaptive) and nothing a person did not choose;
* a refusal BEFORE any call for what the vendor would refuse (no https link, too many pictures, a picture the words do not name, no
  resolution, a duration or a ratio, no edit word for Seedance) and for a Kling key in the legacy access:secret form;
* typed errors, the lost-answer rule (UNCONFIRMED SPEND), task ids checked before they reach a URL, the result fetched only from the
  maker's own hosts, no redirect followed with the key, and no key in any message;
* both entries are registry-only, terms-gated, web_only and unconfirmed: nothing can be sold through the creative system.
"""

import json
import tempfile
import unittest

from modules import model_registry as reg
from modules.capabilities import ADAPTERS, build_adapter
from modules.capabilities.base import (
    REGISTRY_ONLY_CAPABILITIES,
    SUCCEEDED,
    FAILED,
    PENDING,
    VIDEO_CHARACTER_SWAP,
    AdapterError,
    CapabilityRequest,
    ProviderTask,
)
from modules.capabilities.character_swap import KlingOmniEditAdapter, reference_problems
from modules.capabilities.safe_fetch import UNCONFIRMED

KEY = "kling-console-key-0123456789abcdef"
ARK = "ark-key-0123456789abcdefghijklmnop"
ENV = {"KLING_API_KEY": KEY, "SEEDANCE_API_KEY": ARK}
VIDEO = "https://studio.example.com/api/media/file/11111111-1111-1111-1111-111111111111/original?t=video%2Fmp4&exp=1&sig=a"
PIC = "https://studio.example.com/api/media/file/22222222-2222-2222-2222-222222222222/original?t=image%2Fpng&exp=1&sig=b"
PIC2 = PIC.replace("2222", "3333")
PROMPT = "Replace the person on the left with @Image 1 and the person on the right with @image2"


class Resp:
    def __init__(self, status=200, body=None, content=b"", headers=None):
        self.status_code = status
        self._body = body
        self.text = json.dumps(body) if body is not None and not isinstance(body, str) else (body or "")
        self.content = content
        self.headers = headers or {}

    def json(self):
        return json.loads(self.text) if isinstance(self._body, str) else self._body

    def iter_content(self, chunk_size=1):
        yield self.content

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class Session:
    def __init__(self, routes=(), downloads=None):
        self.routes, self.downloads, self.calls = list(routes), downloads or {}, []

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


def req(prompt=PROMPT, images=(PIC, PIC2), media=(VIDEO,), resolution="1080p", **kw):
    return CapabilityRequest(capability=VIDEO_CHARACTER_SWAP, prompt=prompt, input_images=images, input_media=media, resolution=resolution, **kw)


def kling(routes=(), env=ENV, downloads=None):
    s = Session(routes, downloads)
    return build_adapter("video.kling_omni", env=env, session=s), s


def seedance(routes=(), env=ENV, downloads=None):
    s = Session(routes, downloads)
    return build_adapter("video.seedance2_edit", env=env, session=s), s


ENTRIES = {e.id: e for e in reg.registry().values() if e.id in ("kling-4.0-omni-edit", "seedance-2.5-edit")}


class RegistryEntries(unittest.TestCase):
    def test_both_models_are_registry_only_gated_web_only_and_unconfirmed(self):
        self.assertEqual(set(ENTRIES), {"kling-4.0-omni-edit", "seedance-2.5-edit"})
        self.assertIn(VIDEO_CHARACTER_SWAP, REGISTRY_ONLY_CAPABILITIES)
        gates = {e.id: e.terms_gate for e in ENTRIES.values()}
        self.assertEqual(gates, {"kling-4.0-omni-edit": "terms_review_required", "seedance-2.5-edit": "written_consent_required"})
        for e in ENTRIES.values():
            self.assertTrue(e.registry_only, e.id)
            self.assertEqual(e.api_exposure, "web_only", e.id)
            self.assertFalse(e.raw["pricing"]["confirmed"], e.id)
            self.assertEqual(e.capabilities, (VIDEO_CHARACTER_SWAP,), e.id)
        self.assertFalse({row["id"] for row in reg.sync_rows(list(reg.registry().values()))} & set(ENTRIES), "never synced, never sold")

    def test_the_limits_and_prices_are_the_researched_ones(self):
        k, s = ENTRIES["kling-4.0-omni-edit"].raw, ENTRIES["seedance-2.5-edit"].raw
        self.assertEqual((k["character_swap"]["input_seconds"], k["inputs"]["image_refs_max"]), ([3, 30], 10))
        self.assertEqual((s["character_swap"]["input_seconds"], s["inputs"]["image_refs_max"]), ([4, 30], 30))
        self.assertTrue(k["character_swap"]["keeps_original_audio"])
        self.assertFalse(s["character_swap"]["keeps_original_audio"])
        self.assertEqual(k["pricing"]["variants"]["prices"], {"720p": 0.188, "1080p": 0.282})
        self.assertEqual(s["pricing"]["variants"]["prices"], {"720p": 0.276, "1080p": 0.68})
        self.assertEqual(s["vendor_model"], "dreamina-seedance-2-5-260628")
        self.assertTrue(k["pricing"]["source_url"].startswith("https://kling.ai/"))
        self.assertTrue(s["pricing"]["source_url"].startswith("https://docs.byteplus.com/"))

    def test_the_registry_refuses_an_entry_whose_limits_or_prices_do_not_line_up(self):
        doc = json.loads(reg.REGISTRY_PATH.read_text(encoding="utf-8"))
        bad = json.loads(json.dumps(doc))
        m = next(x for x in bad["models"] if x["id"] == "kling-4.0-omni-edit")
        m["character_swap"]["reference_images_max"] = 9
        del m["pricing"]["variants"]["prices"]["1080p"]
        errors = reg.validate(bad)
        self.assertTrue(any("reference_images_max" in e for e in errors), errors)
        self.assertTrue(any("one price for each listed resolution" in e for e in errors), errors)
        self.assertEqual(reg.validate(doc), [], "the shipped file is valid")


class References(unittest.TestCase):
    def test_every_named_picture_must_exist_and_one_must_be_named(self):
        self.assertEqual(reference_problems(PROMPT, 2), [])
        self.assertTrue(reference_problems("replace the person", 1))
        self.assertTrue(reference_problems("replace with @Image 3", 2))
        self.assertTrue(reference_problems("replace with @Image 0", 2))


class KlingOmni(unittest.TestCase):
    def test_the_body_is_kling_4_0_omni_with_the_original_sound_and_nothing_else(self):
        a, s = kling([("POST", "/omni-video/kling-4.0", Resp(200, {"code": 0, "data": {"task_id": "T-123"}}))])
        task = a.submit(req(), "kling-4.0", external_id="0b8f2c51-6f7c-4f1e-9a43-111111111111")
        self.assertEqual(task.task_id, "T-123")
        method, url, kw = s.calls[0]
        self.assertEqual(url, "https://api-singapore.klingai.com/omni-video/kling-4.0")
        self.assertEqual(kw["headers"]["Authorization"], f"Bearer {KEY}")
        self.assertEqual(kw["allow_redirects"], False, "the key never follows a 3xx")
        body = kw["json"]
        self.assertEqual(body["settings"], {"resolution": "1080p", "audio": "original"})
        self.assertEqual(body["contents"][0], {"type": "prompt", "text": "Replace the person on the left with @image_1 and the person on the right with @image_2"})
        self.assertEqual(body["contents"][1], {"type": "base_video", "id": "video_1", "url": VIDEO})
        self.assertEqual(body["contents"][2:], [{"type": "refer_image", "id": "image_1", "url": PIC}, {"type": "refer_image", "id": "image_2", "url": PIC2}])
        self.assertEqual(body["options"], {"external_task_id": "0b8f2c51-6f7c-4f1e-9a43-111111111111"})
        self.assertEqual(set(body), {"contents", "settings", "options"}, "no duration, no aspect ratio: the clip decides")

    def test_refused_before_any_call(self):
        cases = [req(media=("/tmp/clip.mp4",)), req(images=("/tmp/a.png",)), req(images=tuple([PIC] * 11)), req(images=()),
                 req(resolution=None), req(resolution="4k"), req(prompt="replace the person"), req(prompt="replace with @Image 3"),
                 req(duration_s=5), req(aspect_ratio="16:9"), req(audio=True), req(media=(VIDEO, VIDEO))]
        for r in cases:
            a, s = kling()
            with self.assertRaises(AdapterError) as cm:
                a.submit(r, "kling-4.0")
            self.assertEqual(cm.exception.code, "bad_request")
            self.assertTrue(cm.exception.not_accepted)
            self.assertEqual(s.calls, [], r)

    def test_the_legacy_access_secret_pair_is_not_a_kling_4_key(self):
        for env in ({"KLING_API_KEY": "AK123:SK456"}, {"KLING_ACCESS_KEY": "AK", "KLING_SECRET_KEY": "SK"}, {}):
            a, s = kling(env=env)
            with self.assertRaises(AdapterError) as cm:
                a.submit(req(), "kling-4.0")
            self.assertEqual(cm.exception.code, "not_configured")
            self.assertNotIn("SK456", cm.exception.message)
            self.assertEqual(s.calls, [])

    def test_a_lost_answer_is_unconfirmed_spend_and_a_proven_refusal_is_not(self):
        import requests
        a, _ = kling([("POST", "/omni-video/", requests.exceptions.ReadTimeout("x"))])
        with self.assertRaises(AdapterError) as cm:
            a.submit(req(), "kling-4.0")
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED))
        self.assertFalse(cm.exception.not_accepted)
        a, _ = kling([("POST", "/omni-video/", Resp(200, {"code": 0, "data": {}}))])
        with self.assertRaises(AdapterError) as cm:
            a.submit(req(), "kling-4.0")
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), "a 2xx without a task id may still bill")
        a, _ = kling([("POST", "/omni-video/", Resp(402, {"code": 1102, "message": f"balance empty for {KEY}"}))])
        with self.assertRaises(AdapterError) as cm:
            a.submit(req(), "kling-4.0")
        self.assertEqual(cm.exception.code, "quota")
        self.assertTrue(cm.exception.not_accepted)
        self.assertNotIn(KEY, cm.exception.message)

    def test_kling_business_codes_in_a_200(self):
        a, _ = kling([("POST", "/omni-video/", Resp(200, {"code": 1301, "message": "content policy"}))])
        with self.assertRaises(AdapterError) as cm:
            a.submit(req(), "kling-4.0")
        self.assertEqual(cm.exception.code, "policy")

    def test_poll_reads_the_task_list_and_fetches_only_from_klings_hosts(self):
        ok = {"code": 0, "data": [{"task_id": "T-123", "status": "succeeded", "outputs": [{"url": "https://v15-kling.klingai.com/out.mp4"}]}]}
        a, s = kling([("GET", "/tasks", Resp(200, ok))])
        out = a.poll(ProviderTask("video.kling_omni", "kling-4.0", "T-123"))
        self.assertEqual(out.state, SUCCEEDED)
        self.assertEqual(s.calls[0][2]["params"], {"task_ids": "T-123"})
        evil = {"code": 0, "data": [{"task_id": "T-123", "status": "succeeded", "outputs": [{"url": "https://evil.example/out.mp4"}]}]}
        a, _ = kling([("GET", "/tasks", Resp(200, evil))])
        with self.assertRaises(AdapterError) as cm:
            a.poll(ProviderTask("video.kling_omni", "kling-4.0", "T-123"))
        self.assertIn("SPEND MAY HAVE OCCURRED", cm.exception.message)
        for status, want in (("submitted", PENDING), ("processing", PENDING), ("failed", FAILED)):
            a, _ = kling([("GET", "/tasks", Resp(200, {"code": 0, "data": [{"task_id": "T-123", "status": status}]}))])
            self.assertEqual(a.poll(ProviderTask("video.kling_omni", "kling-4.0", "T-123")).state, want)
        a, _ = kling([("GET", "/tasks", Resp(200, {"code": 0, "data": [{"task_id": "OTHER", "status": "succeeded"}]}))])
        self.assertEqual(a.poll(ProviderTask("video.kling_omni", "kling-4.0", "T-123")).state, PENDING, "another task's answer is not ours")

    def test_a_task_id_from_a_row_cannot_steer_the_request(self):
        for tid in ("../../v1/account", "T 1", "T?x=1", "", None):
            a, s = kling()
            with self.assertRaises(AdapterError):
                a.poll(ProviderTask("video.kling_omni", "kling-4.0", tid))
            self.assertEqual(s.calls, [])

    def test_the_download_follows_no_redirect_and_sends_no_key(self):
        a, s = kling(downloads={"https://v15-kling.klingai.com/out.mp4": Resp(302, headers={"Location": "https://evil.example/"})})
        from modules.capabilities.base import Output, PollResult
        with self.assertRaises(AdapterError):
            a.fetch(PollResult(SUCCEEDED, [Output("video/mp4", url="https://v15-kling.klingai.com/out.mp4")]), tempfile.mkdtemp())
        self.assertNotIn("headers", s.calls[0][2])


class SeedanceEdit(unittest.TestCase):
    def test_the_body_is_an_edit_with_the_clip_and_the_pictures_as_references(self):
        a, s = seedance([("POST", "/api/v3/contents/generations/tasks", Resp(200, {"id": "cgt-2026-abc"}))])
        task = a.submit(req(end_user="org-abc"), "dreamina-seedance-2-5-260628")
        self.assertEqual(task.task_id, "cgt-2026-abc")
        body = s.calls[0][2]["json"]
        self.assertEqual(s.calls[0][2]["headers"]["Authorization"], f"Bearer {ARK}")
        self.assertEqual(body["omni_reference_task_type"], "edit")
        self.assertEqual((body["ratio"], body["duration"], body["resolution"], body["generate_audio"]), ("adaptive", -1, "1080p", False))
        self.assertEqual(body["content"][0], {"type": "text", "text": PROMPT})
        self.assertEqual(body["content"][1], {"type": "video_url", "video_url": {"url": VIDEO}, "role": "reference_video"})
        self.assertEqual([c["role"] for c in body["content"][2:]], ["reference_image", "reference_image"])
        self.assertEqual(body["safety_identifier"], "org-abc")
        self.assertEqual(body["model"], "dreamina-seedance-2-5-260628")

    def test_refused_before_any_call(self):
        for r, model in ((req(prompt="put @Image 1 on the left"), "dreamina-seedance-2-5-260628"),   # no edit word
                         (req(images=tuple([PIC] * 31)), "dreamina-seedance-2-5-260628"),
                         (req(), "dreamina-seedance-2-0-260128"),                                    # no edit mode there
                         (req(resolution="480p"), "dreamina-seedance-2-5-260628")):
            a, s = seedance()
            with self.assertRaises(AdapterError) as cm:
                a.submit(r, model)
            self.assertEqual(cm.exception.code, "bad_request")
            self.assertEqual(s.calls, [])

    def test_a_real_face_refusal_is_policy_and_the_clip_comes_from_modelarks_hosts(self):
        a, _ = seedance([("POST", "/tasks", Resp(400, {"error": {"code": "InputVideoSensitiveContentDetected.PrivacyInformation", "message": "real face"}}))])
        with self.assertRaises(AdapterError) as cm:
            a.submit(req(), "dreamina-seedance-2-5-260628")
        self.assertEqual(cm.exception.code, "policy")
        a, _ = seedance([("GET", "/tasks/cgt-1", Resp(200, {"status": "succeeded", "content": {"video_url": "https://x.bytepluses.com/v.mp4"}}))])
        self.assertEqual(a.poll(ProviderTask("video.seedance2_edit", "m", "cgt-1")).state, SUCCEEDED)
        a, _ = seedance([("GET", "/tasks/cgt-1", Resp(200, {"status": "succeeded", "content": {"video_url": "https://evil.example/v.mp4"}}))])
        with self.assertRaises(AdapterError):
            a.poll(ProviderTask("video.seedance2_edit", "m", "cgt-1"))


class Watermarks(unittest.TestCase):
    """docs/AI_DISCLOSURE.md, "Vendor watermarks and provenance": both makers' optional marks are off by default and no clause requires
    one, so nothing that switches a mark, and nothing that replaces a maker's label, is ever sent."""

    def test_neither_body_switches_a_mark_or_replaces_a_label(self):
        from tests.test_vendor_watermarks import provenance_offences, watermark_fields
        a, s = kling([("POST", "/omni-video/", Resp(200, {"code": 0, "data": {"task_id": "T-1"}}))])
        a.submit(req(), "kling-4.0", external_id="0b8f2c51-6f7c-4f1e-9a43-111111111111")
        b, t = seedance([("POST", "/tasks", Resp(200, {"id": "cgt-1"}))])
        b.submit(req(), "dreamina-seedance-2-5-260628")
        for body in (s.calls[0][2]["json"], t.calls[0][2]["json"]):
            self.assertEqual(list(watermark_fields(body)), [])
            self.assertEqual(list(provenance_offences(body)), [])

    def test_the_policy_table_names_both_adapters(self):
        doc = (reg.SCHEMAS.parent / "docs" / "AI_DISCLOSURE.md").read_text(encoding="utf-8")
        self.assertIn("`video.kling_omni`", doc)
        self.assertIn("`video.seedance2_edit`", doc)


class EveryAdapter(unittest.TestCase):
    def test_both_are_registered_and_serve_only_the_character_swap(self):
        for key in ("video.kling_omni", "video.seedance2_edit"):
            self.assertEqual(ADAPTERS[key].capabilities, (VIDEO_CHARACTER_SWAP,))
        self.assertIs(ADAPTERS["video.kling_omni"], KlingOmniEditAdapter)


if __name__ == "__main__":
    unittest.main()
