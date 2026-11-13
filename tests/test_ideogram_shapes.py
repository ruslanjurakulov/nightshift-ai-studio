"""Ideogram 4.0 and 4.5 shapes, through a fake HTTP session: nothing here touches a network or spends.

What would break (docs/research/ideogram-shapes-2026-11-13.md):
* a 16:9 job accepted by the quote and then failed by the worker ("aspect ratio 16:9 is not offered", seen live 2026-11-13);
* a shape sent as a size the vendor does not list (a 400 after the hold), or as a neighbour of the one asked for (a 21:9 job
  that comes back 2:1);
* a shape quietly dropped, so the vendor picks one from the prompt;
* Ideogram 4.0 still calling v1's legacy path, or sending a rendering speed that is not the priced one;
* the registry offering a shape the adapter cannot send, or the adapter sending one the registry (and so the database's quote,
  migration 0155) does not offer.
"""
from __future__ import annotations

import json
import unittest
from fractions import Fraction

from modules import model_registry as reg
from modules.capabilities import build_adapter
from modules.capabilities.base import (
    E_AUTH,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_POLICY,
    E_QUOTA,
    E_RATE_LIMITED,
    T2I,
    AdapterError,
    CapabilityRequest,
)
from modules.capabilities.image import IDEOGRAM_V4_RESOLUTIONS, IDEOGRAM_V45_SIZES

SECRET = "ideo-live-TOPSECRET-0123456789abcdef"
ENV = {"IDEOGRAM_API_KEY": SECRET}
V4_URL = "https://api.ideogram.ai/v2/image/generate/ideogram-4"
V45_URL = "https://api.ideogram.ai/v2/image/generate/ideogram-4-5"

#: OpenAPI ``ResolutionV4`` (https://developer.ideogram.ai/openapi/ideogram-api-v2.json, fetched 2026-11-13), verbatim:
#: "The 1K and 2K resolutions supported for Ideogram 4.0 image generation". The only enumerated 1K/2K list Ideogram publishes.
RESOLUTION_V4 = (
    "2048x2048", "1440x2880", "2880x1440", "1664x2496", "2496x1664", "1792x2240", "2240x1792", "1440x2560", "2560x1440",
    "1600x2560", "2560x1600", "1728x2304", "2304x1728", "1296x3168", "3168x1296", "1152x2944", "2944x1152", "1248x3328",
    "3328x1248", "1280x3072", "3072x1280", "1024x3072", "3072x1024", "1024x1024", "896x1120", "1120x896", "864x1152",
    "1152x864", "832x1248", "1248x832", "800x1280", "1280x800", "720x1280", "1280x720", "720x1440", "1440x720", "512x1536",
    "1536x512")
#: The shapes the owner asked for at least.
REQUIRED = ("16:9", "9:16", "1:1", "4:3", "3:4")

OK = {"generation_id": "g1", "seed": 7,
      "data": [{"prompt": "p", "resolution": "1280x720", "is_image_safe": True, "seed": 7,
                "url": "https://ideogram.ai/api/images/ephemeral/x.png"}]}


class Resp:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self.text = body if isinstance(body, str) else json.dumps(body) if body is not None else ""

    def json(self):
        return json.loads(self.text)


class Session:
    def __init__(self, resp):
        self.resp = resp
        self.calls = []

    def request(self, method, url, **kw):
        self.calls.append((method, url, kw))
        return self.resp


def make(key, resp=None, env=ENV):
    s = Session(resp if resp is not None else Resp(200, OK))
    return build_adapter(key, env=env, session=s), s


def ask(aspect=None, **kw):
    return CapabilityRequest(capability=T2I, prompt=kw.pop("prompt", "a poster that says HELLO"), aspect_ratio=aspect, **kw)


def ratio(label):
    w, h = label.split(":")
    return Fraction(int(w), int(h))


def size_ratio(size):
    w, h = size.split("x")
    return Fraction(int(w), int(h))


class Ideogram4RequestBody(unittest.TestCase):
    def test_posts_json_to_the_v2_endpoint_with_the_key_in_the_header_only(self):
        a, s = make("image.ideogram_v4")
        task = a.submit(ask("16:9"), "turbo")
        self.assertEqual(len(s.calls), 1)
        method, url, kw = s.calls[0]
        self.assertEqual((method, url), ("POST", V4_URL))
        self.assertNotIn("/v1/", url)
        self.assertEqual(kw["headers"], {"Api-Key": SECRET})
        self.assertNotIn(SECRET, url)
        self.assertIsNone(kw.get("files"))
        # v2 calls the prompt ``prompt`` (v1's ``text_prompt``) and the speed is lower case.
        self.assertEqual(kw["json"], {"prompt": "a poster that says HELLO", "rendering_speed": "turbo", "num_images": 1,
                                      "resolution": "1280x720"})
        self.assertEqual(task.outputs[0].url, OK["data"][0]["url"])

    def test_every_offered_shape_is_sent_as_its_own_exact_resolution(self):
        for aspect, size in IDEOGRAM_V4_RESOLUTIONS.items():
            with self.subTest(aspect=aspect):
                a, s = make("image.ideogram_v4")
                a.submit(ask(aspect), "turbo")
                self.assertEqual(s.calls[0][2]["json"]["resolution"], size)

    def test_no_shape_named_is_square_never_left_to_the_vendor(self):
        # Left out, the vendor picks the size from the prompt, and a 2K size may bill more than the Turbo figure quoted.
        a, s = make("image.ideogram_v4")
        a.submit(ask(None), "turbo")
        self.assertEqual(s.calls[0][2]["json"]["resolution"], "1024x1024")


class Ideogram45RequestBody(unittest.TestCase):
    def test_every_offered_shape_is_sent_as_its_own_exact_size(self):
        for aspect, size in IDEOGRAM_V45_SIZES.items():
            with self.subTest(aspect=aspect):
                a, s = make("image.ideogram_v4_5")
                a.submit(ask(aspect, quality="low"), "ideogram-4-5")
                method, url, kw = s.calls[0]
                self.assertEqual((method, url), ("POST", V45_URL))
                self.assertEqual(kw["files"], {"prompt": (None, "a poster that says HELLO"), "quality": (None, "low"),
                                               "num_images": (None, "1"), "size": (None, size)})


class UnknownShapesAreRefusedBeforeAnythingIsSent(unittest.TestCase):
    def assertRefused(self, key, request, vendor_model, fragment):
        a, s = make(key)
        with self.assertRaises(AdapterError) as ctx:
            a.submit(request, vendor_model)
        self.assertEqual(ctx.exception.code, E_BAD_REQUEST)
        self.assertTrue(ctx.exception.not_accepted)
        self.assertIn(fragment, ctx.exception.message)
        self.assertEqual(s.calls, [])

    def test_a_shape_without_an_exact_size_is_refused_by_both(self):
        # 21:9 is a real shape elsewhere in the registry; Ideogram's list has no exact size for it (3168x1296 is 22:9).
        for shape in ("21:9", "9:21", "7:5", "16:11"):
            with self.subTest(shape=shape):
                self.assertRefused("image.ideogram_v4", ask(shape), "turbo", "not a shape Ideogram 4.0 is wired for")
                self.assertRefused("image.ideogram_v4_5", ask(shape, quality="medium"), "ideogram-4-5",
                                   "not a shape Ideogram 4.5 is wired for")

    def test_ideogram_4_refuses_a_speed_the_v2_api_does_not_document(self):
        # The old registry value: v1 took TURBO, v2's enum is lower case.
        for speed in ("TURBO", "fast", ""):
            with self.subTest(speed=speed):
                self.assertRefused("image.ideogram_v4", ask("1:1"), speed, "not an Ideogram 4.0 rendering speed")

    def test_ideogram_4_refuses_a_reference_picture_and_an_empty_prompt(self):
        self.assertRefused("image.ideogram_v4", ask("1:1", input_images=("/tmp/ref.png",)), "turbo", "text to image only")
        self.assertRefused("image.ideogram_v4", ask("1:1", prompt="  "), "turbo", "prompt is empty")

    def test_problems_refuses_an_unknown_shape_for_both_registry_entries(self):
        r = reg.load()
        for mid, key, extra in (("ideogram-4", "image.ideogram_v4", {}), ("ideogram-4.5", "image.ideogram_v4_5",
                                                                         {"quality": "medium"})):
            with self.subTest(model=mid):
                a, _ = make(key)
                self.assertTrue(a.problems(ask("21:9", **extra), r[mid]))
                for shape in REQUIRED:
                    self.assertEqual(a.problems(ask(shape, **extra), r[mid]), [], shape)


class VendorAnswersForIdeogram4(unittest.TestCase):
    def code_for(self, status, body):
        a, _ = make("image.ideogram_v4", Resp(status, body))
        with self.assertRaises(AdapterError) as ctx:
            a.submit(ask("16:9"), "turbo")
        return ctx.exception

    def test_the_v2_errors_map_to_their_remedy(self):
        cases = [(401, {"detail": "Unauthorized"}, E_AUTH),
                 (402, {"error": "no credits", "reject_reason": "insufficient_funds"}, E_QUOTA),
                 (429, {"error": "busy", "reject_reason": "inflight_limit", "max_inflight_requests": 10}, E_RATE_LIMITED),
                 (422, {"detail": "The prompt did not pass safety checks"}, E_POLICY),
                 (400, {"detail": "Invalid input provided"}, E_BAD_REQUEST)]
        for status, body, code in cases:
            with self.subTest(status=status, body=body):
                self.assertEqual(self.code_for(status, body).code, code)

    def test_an_unsafe_image_is_a_policy_refusal_and_a_2xx_without_one_may_have_billed(self):
        self.assertEqual(self.code_for(200, {"data": [{"is_image_safe": False, "url": ""}]}).code, E_POLICY)
        e = self.code_for(200, {"generation_id": "g", "seed": 1})
        self.assertEqual(e.code, E_BAD_RESPONSE)
        self.assertFalse(e.not_accepted)

    def test_an_echoed_key_never_reaches_the_message(self):
        e = self.code_for(401, {"detail": f"bad key {SECRET}"})
        self.assertNotIn(SECRET, str(e))


class TheSizesAreTheVendorsOwn(unittest.TestCase):
    def test_every_ideogram_4_resolution_is_a_listed_1k_value_of_exactly_the_shape(self):
        for aspect, size in IDEOGRAM_V4_RESOLUTIONS.items():
            with self.subTest(aspect=aspect):
                self.assertIn(size, RESOLUTION_V4)
                self.assertEqual(size_ratio(size), ratio(aspect), "never a neighbouring shape")
                w, h = (int(x) for x in size.split("x"))
                # 1K: the Turbo figure names no size, so nothing above the 1024x1024 tier is sent.
                self.assertLessEqual(w * h, 1024 * 1024)

    def test_every_ideogram_4_5_size_is_listed_and_meets_every_rule_4_5_states(self):
        for aspect, size in IDEOGRAM_V45_SIZES.items():
            with self.subTest(aspect=aspect):
                self.assertIn(size, RESOLUTION_V4)
                self.assertEqual(size_ratio(size), ratio(aspect), "never a neighbouring shape")
                w, h = (int(x) for x in size.split("x"))
                # "both sides a multiple of 32 and at least 256px, a total of at most 2048x2048 pixels, and an aspect ratio
                # of at most 6:1"
                self.assertEqual((w % 32, h % 32), (0, 0))
                self.assertGreaterEqual(min(w, h), 256)
                self.assertLessEqual(w * h, 2048 * 2048)
                self.assertLessEqual(max(w, h) / min(w, h), 6)
                # 2K, the tier the vendor's own auto bills at (the owner's reading gives 1K and 2K one figure)
                self.assertGreater(w * h, 1024 * 1024)

    def test_both_offer_at_least_the_shapes_asked_for(self):
        for table in (IDEOGRAM_V4_RESOLUTIONS, IDEOGRAM_V45_SIZES):
            for shape in REQUIRED:
                self.assertIn(shape, table)


class RegistryAgreesWithTheAdapters(unittest.TestCase):
    """The registry's aspect_ratios is what 0155's quote refuses by and what the worker checks; the adapter's table is what
    can actually be sent. They must be the same set, or a quoted job fails after the hold (or a sendable shape is refused)."""

    def setUp(self):
        self.r = reg.load()

    def test_each_entry_offers_exactly_the_shapes_its_adapter_sends(self):
        self.assertEqual(set(self.r["ideogram-4"].aspect_ratios), set(IDEOGRAM_V4_RESOLUTIONS))
        self.assertEqual(set(self.r["ideogram-4.5"].aspect_ratios), set(IDEOGRAM_V45_SIZES))
        for mid in ("ideogram-4", "ideogram-4.5"):
            self.assertEqual(self.r[mid].aspect_ratios_by_capability, {}, mid)

    def test_ideogram_4_runs_turbo_on_the_v2_reference(self):
        e = self.r["ideogram-4"]
        self.assertEqual(e.vendor_model, "turbo")
        self.assertEqual(e.raw["api_documented"]["url"], "https://developer.ideogram.ai/v2/api-reference/images/generate/ideogram-4")
        self.assertIn("Turbo", e.raw["pricing"]["note"])

    def test_both_probes_ask_for_16_9_the_shape_that_failed_live(self):
        for mid in ("ideogram-4", "ideogram-4.5"):
            e = self.r[mid]
            self.assertEqual(e.raw["probe"]["aspect_ratio"], "16:9", mid)
            self.assertEqual(e.problems(e.probe_request()), [], mid)

    def test_sync_copies_the_shapes_into_the_database_spec(self):
        # tools/probe_models.py --sync upserts these rows; 0155's quote reads spec.aspect_ratios from them.
        rows = {row["id"]: row for row in reg.sync_rows(list(self.r.values()))}
        for mid in ("ideogram-4", "ideogram-4.5"):
            self.assertEqual(rows[mid]["spec"]["aspect_ratios"], list(self.r[mid].aspect_ratios), mid)
        self.assertEqual(rows["ideogram-4"]["spec"]["vendor_model"], "turbo")


if __name__ == "__main__":
    unittest.main()
