"""Region edit (modules/region_edit.py): the pixel lock and the refusals.

The model is a loopback fake that returns a COMPLETELY different picture (noise,
another size, another colour) and these tests still require every pixel outside
the masks to equal the original's. Nothing here touches a network or spends
anything. What must hold:

* the lock: outside the union of the masks the result is the original, byte for
  byte, for rectangles, brush masks, several and overlapping regions, regions on
  the picture's edge, every feather in range, a source with alpha, a palette
  source and an EXIF-rotated one; inside the mask, ``feather`` pixels in, it is
  the model's;
* the model answer is resized to the crop, never the other way, and an answer in
  another shape is refused rather than stretched;
* refusals before any call: no region has words, too many regions, a region
  outside the picture, a feather out of range, an unknown / non-editing / gated /
  unavailable model, no model at all (there is no fallback);
* a region whose call fails is ``failed`` and changes nothing; the others apply;
  no second model is ever tried.
"""

from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from modules import model_registry as reg
from modules import region_edit as re_
from modules.capabilities import build_adapter
from modules.capabilities.base import E_POLICY, AdapterError
from modules.region_edit import (
    DEFAULT_FEATHER,
    MAX_REGIONS,
    EditCall,
    Region,
    RegionEditError,
    active_regions,
    adapter_edit_fn,
    check_feather,
    composite_regions,
    load_rgba,
    outside_mask,
    parse_regions,
    plan_crop,
    region_alpha,
    resolve_edit_model,
    run_region_edit,
    verify_pixel_lock,
)
from tests.test_capabilities import FakeResp, FakeSession

W, H = 320, 240


def picture(mode="RGB", size=(W, H), seed=1) -> Image.Image:
    rng = np.random.default_rng(seed)
    chans = 4 if mode == "RGBA" else 3
    arr = rng.integers(0, 256, size=(size[1], size[0], chans), dtype=np.uint8)
    return Image.fromarray(arr, "RGBA" if mode == "RGBA" else "RGB")


def png(im: Image.Image, **kw) -> bytes:
    buf = io.BytesIO()
    im.save(buf, format="PNG", **kw)
    return buf.getvalue()


def loopback(size=None, seed=99, color=None):
    """A fake model that changes EVERYTHING: it ignores the crop and returns noise
    (or one flat colour) in the size asked for, or the crop's own size."""
    calls = []

    def fn(call: EditCall) -> bytes:
        calls.append(call)
        w, h = size or call.size
        if color is not None:
            return png(Image.new("RGB", (w, h), color))
        return png(picture(size=(w, h), seed=seed + call.index))

    fn.calls = calls
    return fn


def decode(data: bytes) -> np.ndarray:
    return np.array(Image.open(io.BytesIO(data)).convert("RGBA"))


def reg_(x, y, w, h, prompt="make it blue", name="r", mask=None):
    return Region(name=name, prompt=prompt, x=x, y=y, w=w, h=h, mask_png=mask)


class PixelLockTests(unittest.TestCase):
    def check_lock(self, source_bytes, regions, fake, feather=DEFAULT_FEATHER, **kw):
        res = run_region_edit(source_bytes, regions, fake, feather=feather, **kw)
        self.assertIsNotNone(res.png)
        before, after = load_rgba(source_bytes)[0], decode(res.png)
        self.assertEqual(before.shape, after.shape, "the original is never resized")
        keep = outside_mask(before.shape[:2], [regions[o.index] for o in res.outcomes if o.status == "applied"], feather)
        self.assertTrue(keep.any() and (~keep).any())
        self.assertTrue(np.array_equal(before[keep], after[keep]), "a pixel outside the masks changed")
        self.assertTrue(np.array_equal(before[..., 3], after[..., 3]), "alpha changed")
        return before, after, res

    def test_a_model_that_changes_everything_changes_nothing_outside_the_rectangle(self):
        src = png(picture())
        before, after, _ = self.check_lock(src, [reg_(60, 50, 120, 90)], loopback())
        # the lock is not vacuous: the picture did change inside the region
        self.assertFalse(np.array_equal(before[50:140, 60:180], after[50:140, 60:180]))

    def test_every_feather_in_range_keeps_the_outside_and_the_core_is_the_models(self):
        src = png(picture())
        for feather in range(re_.FEATHER_MIN, re_.FEATHER_MAX + 1):
            fake = loopback(color=(10, 200, 30))
            before, after, _ = self.check_lock(src, [reg_(60, 50, 120, 90)], fake, feather=feather)
            core = after[50 + feather:140 - feather, 60 + feather:180 - feather, :3]
            self.assertTrue((core == np.array([10, 200, 30])).all(), f"feather {feather}: core is not the edit")

    def test_the_feather_band_is_inside_the_mask_and_ramps(self):
        a = region_alpha(reg_(40, 40, 50, 50), (W, H), 4)
        self.assertEqual(a.shape, (50, 50))
        self.assertEqual(int(a[25, 25]), 255)
        self.assertEqual(int(a[25, 0]), int(a[0, 25]))            # outermost ring is the same all round
        ramp = [int(a[25, i]) for i in range(0, 6)]
        self.assertEqual(ramp, sorted(ramp))                       # grows inwards
        self.assertEqual(ramp[0], 51)                               # 1 of 5 levels
        self.assertEqual(ramp[4], 255)                              # full after `feather` pixels
        self.assertGreater(ramp[0], 0)                              # the edge pixel is part of the mask

    def test_a_region_on_the_picture_edge_does_not_feather_toward_the_edge(self):
        a = region_alpha(reg_(0, 0, 50, 50), (W, H), 6)
        self.assertEqual(int(a[0, 0]), 255)                         # corner on the picture's corner
        self.assertEqual(int(a[25, 0]), 255)                        # left side on the picture's edge
        self.assertLess(int(a[25, 49]), 255)                        # inner side ramps

    def test_five_regions_and_overlap(self):
        src = png(picture())
        regions = [reg_(10, 10, 60, 40), reg_(50, 30, 60, 40), reg_(200, 20, 80, 60),
                   reg_(20, 150, 100, 70), reg_(250, 180, 60, 50)]
        self.assertEqual(len(regions), MAX_REGIONS)
        self.check_lock(src, regions, loopback())

    def test_brush_mask_keeps_everything_outside_the_brush(self):
        rr = Image.new("L", (80, 60), 0)
        for x in range(10, 70):
            for y in range(10, 50):
                if (x - 40) ** 2 + (y - 30) ** 2 < 25 ** 2:
                    rr.putpixel((x, y), 255)
        src = png(picture())
        region = reg_(100, 80, 80, 60, mask=png(rr))
        before, after, _ = self.check_lock(src, [region], loopback(color=(255, 0, 0)))
        # a pixel in the rectangle but outside the brush is still the original
        self.assertTrue(np.array_equal(before[80, 100], after[80, 100]))
        self.assertEqual(tuple(after[110, 140, :3]), (255, 0, 0))   # brush centre is the edit

    def test_model_answer_in_another_size_is_resized_to_the_crop_not_the_original(self):
        src = png(picture())
        crop = plan_crop(reg_(60, 50, 120, 90), (W, H), [])
        # the same crop shape at three times the size: still lands, original grid intact
        big = (crop.size[0] * 3, crop.size[1] * 3)
        before, after, _ = self.check_lock(src, [reg_(60, 50, 120, 90)], loopback(size=big))
        self.assertEqual(before.shape, after.shape)

    def test_answer_in_another_shape_is_refused_not_stretched(self):
        src = png(picture())
        res = run_region_edit(src, [reg_(60, 50, 120, 90)], loopback(size=(400, 100)))
        self.assertIsNone(res.png)
        self.assertEqual(res.outcomes[0].status, "failed")
        self.assertEqual(res.outcomes[0].code, "bad_response")

    def test_source_with_alpha_keeps_its_alpha_everywhere(self):
        im = picture("RGBA")
        arr = np.array(im)
        arr[..., 3] = np.tile(np.linspace(0, 255, W, dtype=np.uint8), (H, 1))
        src = png(Image.fromarray(arr, "RGBA"))
        before, after, res = self.check_lock(src, [reg_(60, 50, 120, 90)], loopback())
        self.assertEqual(Image.open(io.BytesIO(res.png)).mode, "RGBA")

    def test_palette_and_grey_sources_are_decoded_then_locked(self):
        for mode in ("P", "L"):
            im = picture().convert(mode)
            self.check_lock(png(im), [reg_(60, 50, 120, 90)], loopback())

    def test_exif_rotated_source_is_locked_on_the_oriented_grid(self):
        im = picture(size=(200, 300))
        exif = Image.Exif()
        exif[0x0112] = 6                                   # rotate 90 CW when displayed
        buf = io.BytesIO()
        im.save(buf, format="JPEG", exif=exif.tobytes(), quality=95)
        arr, _, _ = load_rgba(buf.getvalue())
        self.assertEqual(arr.shape[:2], (200, 300))        # displayed size: oriented
        self.check_lock(buf.getvalue(), [reg_(40, 30, 100, 80)], loopback())

    def test_icc_profile_is_copied_not_converted(self):
        fake_profile = b"not-a-real-profile" * 4
        src = png(picture())
        im = Image.open(io.BytesIO(src))
        buf = io.BytesIO()
        im.save(buf, format="PNG", icc_profile=fake_profile)
        res = run_region_edit(buf.getvalue(), [reg_(60, 50, 120, 90)], loopback())
        self.assertEqual(Image.open(io.BytesIO(res.png)).info.get("icc_profile"), fake_profile)

    def test_verify_catches_a_pixel_changed_outside_the_masks(self):
        arr = load_rgba(png(picture()))[0]
        region = reg_(60, 50, 120, 90)
        good = arr.copy()
        verify_pixel_lock(arr, good, [region], 4)
        bad = arr.copy()
        bad[5, 5, 0] ^= 1
        with self.assertRaises(RegionEditError) as cm:
            verify_pixel_lock(arr, bad, [region], 4)
        self.assertEqual(cm.exception.code, "pixel_lock_failed")
        bad = arr.copy()
        bad[100, 100, 3] ^= 1                                      # alpha, even inside the region
        with self.assertRaises(RegionEditError):
            verify_pixel_lock(arr, bad, [region], 4)

    def test_composite_alone_ignores_the_edit_outside_the_mask(self):
        arr = load_rgba(png(picture()))[0]
        region = reg_(60, 50, 120, 90)
        box = (20, 10, 220, 160)
        edited = np.full((150, 200, 4), 7, dtype=np.uint8)
        out = composite_regions(arr, [(region, edited, box)], 4)
        keep = outside_mask(arr.shape[:2], [region], 4)
        self.assertTrue(np.array_equal(arr[keep], out[keep]))
        self.assertTrue((out[60:130, 70:170, :3] == 7).all())


class RefusalTests(unittest.TestCase):
    def raises(self, code, fn, *a, **kw):
        with self.assertRaises(RegionEditError) as cm:
            fn(*a, **kw)
        self.assertEqual(cm.exception.code, code)

    def test_no_region_has_words(self):
        regions = parse_regions([{"x": 0, "y": 0, "w": 50, "h": 50, "prompt": "  "},
                                 {"x": 60, "y": 0, "w": 50, "h": 50}], (W, H))
        self.raises("no_prompt", active_regions, regions)
        fake = loopback()
        self.raises("no_prompt", run_region_edit, png(picture()), regions, fake)
        self.assertEqual(fake.calls, [])                      # nothing was asked of a model

    def test_a_region_without_words_is_skipped_and_said_so(self):
        regions = [reg_(10, 10, 60, 60), reg_(100, 10, 60, 60, prompt="")]
        res = run_region_edit(png(picture()), regions, loopback())
        self.assertEqual([o.status for o in res.outcomes], ["applied", "skipped"])

    def test_limits_and_bounds(self):
        ok = {"x": 0, "y": 0, "w": 50, "h": 50, "prompt": "p"}
        self.raises("no_regions", parse_regions, [], (W, H))
        self.raises("too_many_regions", parse_regions, [ok] * (MAX_REGIONS + 1), (W, H))
        self.raises("region_out_of_bounds", parse_regions, [{**ok, "x": 300}], (W, H))
        self.raises("region_out_of_bounds", parse_regions, [{**ok, "x": -1}], (W, H))
        self.raises("region_too_small", parse_regions, [{**ok, "w": 8}], (W, H))
        self.raises("region_invalid", parse_regions, [{**ok, "x": 1.5}], (W, H))
        self.raises("region_invalid", parse_regions, [{**ok, "w": True}], (W, H))
        self.assertEqual(len(parse_regions([ok] * MAX_REGIONS, (W, H))), MAX_REGIONS)

    def test_names_and_prompts_are_cleaned(self):
        r = parse_regions([{"x": 0, "y": 0, "w": 50, "h": 50, "name": "  a\u0007\nb  ", "prompt": "x\r\ny"}], (W, H))[0]
        self.assertEqual((r.name, r.prompt), ("a b", "x y"))
        self.assertEqual(parse_regions([{"x": 0, "y": 0, "w": 50, "h": 50}], (W, H))[0].name, "Region 1")

    def test_feather_range(self):
        for bad in (1, 9, 0, -3, 2.5, "4", None, True):
            self.raises("feather_invalid", check_feather, bad)
        self.assertEqual([check_feather(f) for f in (2, 4, 8)], [2, 4, 8])

    def test_brush_mask_must_match_and_not_be_empty(self):
        res = run_region_edit(png(picture()), [reg_(10, 10, 60, 60, mask=png(Image.new("L", (10, 10), 255))),
                                               reg_(100, 10, 60, 60)], loopback())
        self.assertEqual([o.status for o in res.outcomes], ["failed", "applied"])
        self.assertEqual(res.outcomes[0].code, "mask_invalid")
        res = run_region_edit(png(picture()), [reg_(10, 10, 60, 60, mask=png(Image.new("L", (60, 60), 0)))], loopback())
        self.assertIsNone(res.png)
        self.assertEqual(res.outcomes[0].code, "mask_invalid")

    def test_unreadable_and_unsupported_sources(self):
        self.raises("source_unreadable", load_rgba, b"not a picture")
        self.raises("source_unsupported", load_rgba, png(Image.new("I;16", (40, 40))))
        buf = io.BytesIO()
        Image.new("CMYK", (40, 40)).save(buf, format="JPEG")
        self.raises("source_unsupported", load_rgba, buf.getvalue())

    def test_small_picture_that_fits_no_offered_shape_is_refused_not_stretched(self):
        self.raises("crop_unavailable", plan_crop, reg_(0, 0, 100, 100), (100, 100), ["16:9"])


class ModelChoiceTests(unittest.TestCase):
    """CLAUDE.md rule 4: the model asked for, or nothing."""

    def setUp(self):
        self.registry = reg.registry()

    def test_resolves_only_the_named_available_editing_model(self):
        entry = resolve_edit_model("gemini-3.1-flash-image", available={"gemini-3.1-flash-image"}, registry=self.registry)
        self.assertEqual(entry.id, "gemini-3.1-flash-image")

    def test_no_default_unknown_noneditor_gated_or_unavailable_all_stop(self):
        avail = set(self.registry)
        cases = [("", "model_required"), (None, "model_required"), ("no-such-model", "model_unknown"),
                 ("flux-2-pro", "model_cannot_edit"),                       # t2i only
                 ("gemini-2.5-flash-image-erase", "model_cannot_edit"),     # an op, not the edit capability
                 ("openai-gpt-image-2", "model_not_available")]
        for model, code in cases:
            with self.subTest(model=model):
                have = avail - {"openai-gpt-image-2"} if code == "model_not_available" else avail
                with self.assertRaises(RegionEditError) as cm:
                    resolve_edit_model(model, available=have, registry=self.registry)
                self.assertEqual(cm.exception.code, code)

    def test_a_terms_gated_editing_model_is_refused(self):
        class Gated:
            capabilities = ("edit",)
            terms_gate = "terms_review_required"
        with self.assertRaises(RegionEditError) as cm:
            resolve_edit_model("g", available={"g"}, registry={"g": Gated()})
        self.assertEqual(cm.exception.code, "model_gated")

    def test_every_editing_model_is_either_cleared_or_refused_as_gated_whatever_models_are_added(self):
        # Not a pinned list: other pull requests add editing models that are dark (a terms gate), and each of them must be refused
        # here with model_gated while the cleared ones resolve. A new editor is therefore never usable by accident.
        editors = list(reg.models("edit"))
        self.assertTrue(editors, "the registry has no editing model at all")
        available = {m.id for m in reg.models()}
        cleared = [m for m in editors if not m.terms_gate]
        self.assertTrue(cleared, "no cleared editing model: the region editor would have nothing to run")
        for m in editors:
            with self.subTest(model=m.id, gated=bool(m.terms_gate)):
                if m.terms_gate:
                    with self.assertRaises(RegionEditError) as cm:
                        resolve_edit_model(m.id, available=available, registry=self.registry)
                    self.assertEqual(cm.exception.code, "model_gated")
                else:
                    self.assertEqual(resolve_edit_model(m.id, available=available, registry=self.registry).id, m.id)
        for m in cleared:
            # a cleared editor takes the crop only: no wired adapter sends a mask, and the lock does not depend on one
            self.assertNotIn("mask", m.raw.get("inputs", {}), m.id)

    def test_a_failed_region_is_not_retried_on_another_model_and_the_others_still_apply(self):
        seen = []

        def edit(call: EditCall) -> bytes:
            seen.append(call.index)
            if call.index == 1:
                raise AdapterError(E_POLICY, "refused by the vendor")
            return png(picture(size=call.size, seed=5))

        regions = [reg_(10, 10, 60, 60), reg_(100, 10, 60, 60), reg_(200, 10, 60, 60)]
        res = run_region_edit(png(picture()), regions, edit)
        self.assertEqual(seen, [0, 1, 2])                                   # one call per region, once, in order
        self.assertEqual([o.status for o in res.outcomes], ["applied", "failed", "applied"])
        self.assertEqual(res.outcomes[1].code, E_POLICY)
        after, before = decode(res.png), load_rgba(png(picture()))[0]
        self.assertTrue(np.array_equal(before[10:70, 100:160], after[10:70, 100:160]))   # the refused region is untouched

    def test_all_regions_failed_keeps_nothing(self):
        def edit(call):
            raise AdapterError(E_POLICY, "no")
        res = run_region_edit(png(picture()), [reg_(10, 10, 60, 60)], edit)
        self.assertIsNone(res.png)
        self.assertEqual(res.failed, 1)

    def test_unexpected_errors_are_bugs_and_propagate(self):
        def edit(call):
            raise ZeroDivisionError("bug")
        with self.assertRaises(ZeroDivisionError):
            run_region_edit(png(picture()), [reg_(10, 10, 60, 60)], edit)


class CropTests(unittest.TestCase):
    def test_crop_contains_the_region_stays_in_the_picture_and_has_an_offered_shape(self):
        for aspects in ([], ["1:1"], ["16:9", "9:16", "1:1", "4:3", "3:4"]):
            for rect in [(0, 0, 40, 30), (280, 200, 40, 40), (100, 90, 120, 60), (0, 100, 50, 50)]:
                r = reg_(*rect)
                plan = plan_crop(r, (W, H), aspects)
                x0, y0, x1, y1 = plan.box
                self.assertTrue(0 <= x0 <= r.x and 0 <= y0 <= r.y and r.x + r.w <= x1 <= W and r.y + r.h <= y1 <= H)
                if aspects:
                    a = int(plan.aspect.split(":")[0]) / int(plan.aspect.split(":")[1])
                    self.assertLess(abs((x1 - x0) / (y1 - y0) - a) / a, 0.03)

    def test_a_non_square_aspect_is_the_one_sent_to_the_model(self):
        sent = []

        def edit(call):
            sent.append(call.aspect)
            return png(picture(size=call.size))
        run_region_edit(png(picture()), [reg_(100, 80, 120, 60)], edit, aspects=["1:1", "16:9"])
        self.assertIn(sent[0], ("1:1", "16:9"))


class AdapterSeamTests(unittest.TestCase):
    def test_the_crop_goes_as_the_input_picture_of_the_models_ordinary_edit_call(self):
        import base64
        key = "AIzaTOPSECRETgoogle0123456789abcdefgh"
        answer = png(picture(size=(256, 256), seed=3))
        body = {"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/png",
                                                                       "data": base64.b64encode(answer).decode()}}]}}]}
        session = FakeSession([("POST", ":generateContent", FakeResp(200, body))])
        adapter = build_adapter("image.gemini", env={"GEMINI_API_KEY": key}, session=session)
        entry = reg.get("gemini-3.1-flash-image")
        with tempfile.TemporaryDirectory() as d:
            fn = adapter_edit_fn(adapter, entry, work_dir=Path(d))
            res = run_region_edit(png(picture()), [reg_(100, 80, 100, 100)], fn, aspects=entry.aspects_for("edit"))
        self.assertEqual(res.applied, 1)
        method, url, kw = session.calls[0]
        self.assertIn("models/gemini-3.1-flash-image:generateContent", url)
        self.assertNotIn(key, url)                                           # the key rides in a header only
        parts = kw["json"]["contents"][0]["parts"]
        self.assertIn("make it blue", parts[0]["text"])
        self.assertEqual(len([p for p in parts if "inlineData" in p]), 1)    # exactly the one crop
        self.assertEqual(len(session.calls), 1)                              # one call, one model

    def test_a_vendor_refusal_surfaces_as_a_failed_region(self):
        session = FakeSession([("POST", ":generateContent", FakeResp(400, "blocked by safety policy"))])
        adapter = build_adapter("image.gemini", env={"GEMINI_API_KEY": "AIzaTOPSECRETgoogle0123456789abcdefgh"}, session=session)
        with tempfile.TemporaryDirectory() as d:
            fn = adapter_edit_fn(adapter, reg.get("gemini-3.1-flash-image"), work_dir=Path(d))
            res = run_region_edit(png(picture()), [reg_(100, 80, 100, 100)], fn)
        self.assertIsNone(res.png)
        self.assertEqual(res.outcomes[0].code, E_POLICY)

    def test_provenance_marks_the_result_ai_generated_and_keeps_no_prompt(self):
        regions = [reg_(10, 10, 60, 60, prompt="secret words")]
        res = run_region_edit(png(picture()), regions, loopback())
        prov = re_.provenance(res, regions, model_id="openai-gpt-image-2", source_asset_id="a" * 8)
        self.assertTrue(prov["ai_generated"])
        self.assertEqual(prov["region_edit"]["pixel_lock"], "outside_mask_identical")
        self.assertNotIn("secret words", repr(prov))


if __name__ == "__main__":
    unittest.main()
