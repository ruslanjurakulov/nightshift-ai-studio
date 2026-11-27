"""Ideogram upscale on the v2 endpoint, through a recording fake HTTP session: nothing here touches a network or spends.

What would break: the call going back to the legacy ``POST /upscale`` (it answered a live probe on 2026-11-27 with
HTTP 400 "The selected model version is no longer supported"), the model left to ``auto`` (the vendor says its pick
"may change over time": a silent model swap under a price, CLAUDE.md #4), the factor left to the vendor's default (it
bills per output megapixel), a person's words silently dropped (Topaz Standard V2 takes no prompt), a source whose 2x
output passes the documented 8192 px side limit sent anyway (a paid-path 400), a refusal read with the wrong remedy,
or an unsafe answer read as a picture."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from modules import model_registry as reg
from modules.capabilities import build_adapter
from modules.capabilities.base import (
    E_BAD_REQUEST,
    E_POLICY,
    E_QUOTA,
    E_RATE_LIMITED,
    UPSCALE,
    AdapterError,
    CapabilityRequest,
)

SECRET = "ideo-live-TOPSECRET-0123456789abcdef"
ENV = {"IDEOGRAM_API_KEY": SECRET}
URL = "https://api.ideogram.ai/v2/image/upscale/topaz-standard-2"
OK = {"generation_id": "g1", "seed": 7, "width": 128, "height": 96,
      "data": [{"resolution": "128x96", "is_image_safe": True, "seed": 7,
                "url": "https://ideogram.ai/api/images/ephemeral/up.png"}]}


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


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.entry = reg.get("ideogram-upscale")

    def tearDown(self):
        self.tmp.cleanup()

    def picture(self, size=(64, 48), name="src.png", fmt="PNG") -> Path:
        p = self.dir / name
        Image.new("RGB", size, (40, 80, 120)).save(p, fmt)
        return p

    def make(self, resp=None):
        s = Session(resp if resp is not None else Resp(200, OK))
        return build_adapter("image.ideogram_upscale", env=ENV, session=s), s

    def ask(self, path, prompt="", scale=2):
        return CapabilityRequest(capability=UPSCALE, prompt=prompt, scale=scale, input_images=(str(path),))


class TheRequest(Base):
    def test_posts_the_v2_form_to_the_pinned_model_with_the_key_in_the_header_only(self):
        src = self.picture()
        a, s = self.make()
        task = a.submit(self.ask(src), self.entry.vendor_model)
        self.assertEqual(len(s.calls), 1)
        method, url, kw = s.calls[0]
        self.assertEqual((method, url), ("POST", URL))
        self.assertEqual(kw["headers"], {"Api-Key": SECRET})
        self.assertNotIn(SECRET, url)
        # Exactly the documented fields: the file and the factor. No prompt, no legacy image_request.
        self.assertEqual(set(kw["files"]), {"image", "upscale_factor"})
        self.assertEqual(kw["files"]["upscale_factor"], (None, "x2"))
        self.assertEqual(kw["files"]["image"], ("src.png", src.read_bytes(), "image/png"))
        self.assertEqual(task.outputs[0].url, OK["data"][0]["url"])

    def test_the_registry_pins_topaz_standard_2_never_auto(self):
        self.assertEqual(self.entry.vendor_model, "topaz-standard-2")
        src = self.picture()
        a, s = self.make()
        for other in ("auto", "upscale", "topaz-standard"):
            with self.subTest(model=other), self.assertRaises(AdapterError) as cm:
                a.submit(self.ask(src), other)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertEqual(s.calls, [])

    def test_no_factor_named_still_sends_x2(self):
        src = self.picture()
        a, s = self.make()
        a.submit(self.ask(src, scale=None), "topaz-standard-2")
        self.assertEqual(s.calls[0][2]["files"]["upscale_factor"], (None, "x2"))


class Refusals(Base):
    def test_words_are_refused_not_silently_dropped(self):
        src = self.picture()
        a, s = self.make()
        problems = a.problems(self.ask(src, prompt="keep it sharp"), self.entry)
        self.assertTrue(any("takes no prompt" in p for p in problems), problems)
        with self.assertRaises(AdapterError) as cm:
            a.submit(self.ask(src, prompt="keep it sharp"), "topaz-standard-2")
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertEqual(s.calls, [])

    def test_a_2x_output_past_8192_px_a_side_is_refused_with_the_size_to_use(self):
        a, s = self.make()
        fits = self.picture((4096, 16), "fits.png")
        self.assertEqual(a.problems(self.ask(fits), self.entry), [])
        for size in ((4097, 16), (16, 4097)):
            with self.subTest(size=size):
                big = self.picture(size, "big.png")
                problems = a.problems(self.ask(big), self.entry)
                self.assertTrue(any("8192 px" in p and "4096 px" in p for p in problems), problems)
                with self.assertRaises(AdapterError):
                    a.submit(self.ask(big), "topaz-standard-2")
        self.assertEqual(s.calls, [])

    def test_a_file_whose_size_cannot_be_read_is_refused_not_sent(self):
        bad = self.dir / "fake.png"
        bad.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
        a, s = self.make()
        problems = a.problems(self.ask(bad), self.entry)
        self.assertTrue(any("could not be read" in p for p in problems), problems)
        self.assertEqual(s.calls, [])

    def test_other_factors_and_types_are_refused(self):
        src = self.picture()
        a, _ = self.make()
        self.assertTrue(a.problems(self.ask(src, scale=4), self.entry))
        gif = self.picture(name="src.gif", fmt="GIF")
        self.assertIn("Ideogram upscales JPEG, PNG or WebP images", a.problems(self.ask(gif), self.entry))

    def test_the_registry_probe_is_servable_and_sends_no_words(self):
        src = self.picture()
        req = self.entry.probe_request(generated_image=str(src))
        self.assertEqual(req.prompt, "")
        a, _ = self.make()
        self.assertEqual(a.problems(req, self.entry), [])


class Answers(Base):
    def test_reject_reasons_map_to_the_remedy(self):
        src = self.picture()
        for status, reason, code in ((429, "inflight_limit", E_RATE_LIMITED), (402, "insufficient_funds", E_QUOTA),
                                     (429, "daily_limit", E_QUOTA)):
            with self.subTest(reason=reason):
                a, _ = self.make(Resp(status, {"reject_reason": reason}))
                with self.assertRaises(AdapterError) as cm:
                    a.submit(self.ask(src), "topaz-standard-2")
                self.assertEqual(cm.exception.code, code)
                self.assertNotIn(SECRET, cm.exception.message)

    def test_an_unsafe_image_is_a_policy_refusal_not_a_picture(self):
        src = self.picture()
        unsafe = {"data": [{"resolution": "128x96", "is_image_safe": False, "seed": 7, "url": ""}]}
        a, _ = self.make(Resp(200, unsafe))
        with self.assertRaises(AdapterError) as cm:
            a.submit(self.ask(src), "topaz-standard-2")
        self.assertEqual(cm.exception.code, E_POLICY)


if __name__ == "__main__":
    unittest.main()
