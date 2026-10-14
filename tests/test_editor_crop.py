"""Crop and a free angle on a clip (backend half).

Fields (modules/timeline.py): a V clip's ``crop: {x, y, w, h}`` (a rectangle of
the source, fractions, taken after rotate/flip and before the fit) and ``angle``
(degrees clockwise, -180..180, the fitted picture turned in the frame). By class:

* the document: ranges at both ends and beyond, the rectangle inside the
  picture, strict fields, defaults, normalisation drops "the whole picture" and
  0 degrees, the JSON schema and the constants the three languages share;
* the argv: documents without either render the SAME commands as before (golden
  digests, tests/test_editor_transitions.py LEGACY); the crop and angle filters
  are pinned and sit where they should (crop before the fit and after the turn,
  angle after the fit and before the move), on video, stills and both sides of
  a cross-fade;
* the PIXELS, real ffmpeg: a four-colour picture is cropped to each quarter, a
  crop to a portrait window fills a portrait frame, a crop follows a quarter
  turn, +90 degrees turns the picture clockwise (red-left goes on top), 45
  degrees leaves black corners, and a still takes both.
"""

import copy
import json
import re
import unittest
from pathlib import Path

from modules import render_backend
from modules import render_spec as rs
from modules import timeline as tl
from tests import test_editor_effects as fxt
from tests import test_editor_overlay as ovt
from tests import test_editor_transitions as trt

ROOT = Path(__file__).resolve().parent.parent
EDITOR_TS = ROOT / "command-center" / "lib" / "editor.ts"
BASE, PIC = ovt.BASE, ovt.PIC


def problems_of(**clip):
    return tl.validate(fxt.vdoc(**clip))


class DocumentTestCase(unittest.TestCase):
    def test_a_crop_is_a_rectangle_inside_the_picture(self):
        self.assertEqual(problems_of(crop={"x": 0.25, "y": 0.1, "w": 0.5, "h": 0.8}), [])
        self.assertEqual(problems_of(crop={}), [])
        self.assertEqual(problems_of(crop={"x": 0.5, "w": 0.5}), [])          # x + w == 1
        self.assertEqual(problems_of(crop={"w": 0.05, "h": 0.05}), [])
        for crop, needle in (({"x": 0.6, "w": 0.5}, "x + w must not go past"), ({"y": 0.9, "h": 0.2}, "y + h must not go past"),
                             ({"x": -0.01}, "x must be a number"), ({"x": 1.01}, "x must be a number"),
                             ({"w": 0.049}, "w must be a number"), ({"h": 0}, "h must be a number"),
                             ({"w": 1.01}, "w must be a number"), ({"w": float("nan")}, "w must be a number"),
                             ({"x": "0.5"}, "x must be a number"), ({"y": None}, "y must be a number"),
                             ({"z": 1}, "z is not a known field"), ([], "must be an object"), (None, "must be an object"),
                             ("x", "must be an object")):
            got = problems_of(crop=crop)
            self.assertTrue(any(needle in p for p in got), (crop, got))
        self.assertTrue(problems_of(crop={"x": 10 ** 400}))

    def test_an_angle_is_a_number_from_minus_180_to_180(self):
        for ok in (0, 1, -1, 45.5, 90, -180, 180, 179.999):
            self.assertEqual(problems_of(angle=ok), [], ok)
        for bad in (180.001, -180.001, 360, 1e9, float("nan"), float("inf"), "45", None, True, [45]):
            self.assertTrue(any("angle must be a number" in p for p in problems_of(angle=bad)), bad)

    def test_normalise_fills_and_drops(self):
        n = tl.normalise(fxt.vdoc(crop={"x": 0.1234567, "w": 0.5}, angle=12.34567))["tracks"][0]["clips"][0]
        self.assertEqual(n["crop"], {"x": 0.123, "y": 0.0, "w": 0.5, "h": 1.0})
        self.assertEqual(n["angle"], 12.346)
        plain = tl.normalise(fxt.vdoc())["tracks"][0]["clips"][0]
        for doc in (fxt.vdoc(crop={}), fxt.vdoc(crop={"x": 0, "y": 0, "w": 1, "h": 1}), fxt.vdoc(angle=0),
                    fxt.vdoc(angle=0.0004)):
            self.assertEqual(tl.normalise(doc)["tracks"][0]["clips"][0], plain)

    def test_a_split_keeps_both_on_both_halves(self):
        out = tl.split_clip(fxt.vdoc(out_s=4, crop={"w": 0.5}, angle=10), "c1", 1.0, "c2")
        a, b = out["tracks"][0]["clips"]
        self.assertEqual((a["crop"], a["angle"]), (b["crop"], b["angle"]))

    def test_schema_and_constants(self):
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        props = schema["$defs"]["video_clip"]["properties"]
        self.assertEqual(set(props), set(tl._V_CLIP_KEYS))
        crop = props["crop"]["properties"]
        self.assertEqual((crop["w"]["minimum"], crop["h"]["minimum"], crop["x"]["maximum"]), (tl.CROP_MIN, tl.CROP_MIN, 1))
        self.assertEqual((props["angle"]["minimum"], props["angle"]["maximum"]), (-tl.ANGLE_MAX, tl.ANGLE_MAX))
        self.assertEqual((rs.CROP_MIN, rs.ANGLE_MAX), (tl.CROP_MIN, tl.ANGLE_MAX))
        ts = EDITOR_TS.read_text(encoding="utf-8")
        self.assertEqual(float(re.search(r"export const CROP_MIN = ([\d.]+);", ts).group(1)), tl.CROP_MIN)
        self.assertEqual(float(re.search(r"export const ANGLE_MAX = ([\d.]+);", ts).group(1)), tl.ANGLE_MAX)


class SpecTestCase(unittest.TestCase):
    def test_both_reach_the_segment_and_only_then(self):
        seg = fxt.spec_of(fxt.vdoc(crop={"x": 0.25, "w": 0.5}, angle=15)).segments[0]
        self.assertEqual(seg.crop, rs.ClipCrop(0.25, 0.0, 0.5, 1.0))
        self.assertEqual(seg.angle, 15.0)
        spec = fxt.spec_of(fxt.vdoc(crop={"h": 0.5}))
        self.assertEqual(rs.RenderSpec.from_dict(spec.to_dict()), spec)
        plain = fxt.spec_of(fxt.vdoc()).segments[0]
        self.assertIsNone(plain.crop)
        self.assertEqual(plain.angle, 0.0)
        self.assertFalse({"crop", "angle"} & set(plain.to_dict()))

    def test_a_spec_is_refused_for_what_would_not_render(self):
        def problems(**kw):
            seg = rs.Segment(2.0, "/m/a.mp4", **kw)
            return rs.validate(rs.RenderSpec("/o.mp4", 1280, 720, 30, segments=[seg], frame_exact=True))
        for kw, needle in (({"crop": rs.ClipCrop(w=0.01)}, "crop w"), ({"crop": rs.ClipCrop(x=0.7, w=0.5)}, "goes past"),
                           ({"crop": rs.ClipCrop(x=float("nan"))}, "crop x"), ({"angle": 181.0}, "angle must be"),
                           ({"angle": float("inf")}, "angle must be")):
            self.assertTrue(any(needle in p for p in problems(**kw)), kw)
        self.assertEqual(problems(crop=rs.ClipCrop(0.5, 0.5, 0.5, 0.5), angle=-180.0), [])


class CommandTestCase(unittest.TestCase):
    def seg(self, **kw):
        return rs.Segment(2.0, "/m/a.mp4", **kw)

    def test_the_crop_is_pinned_and_goes_after_the_turn_and_before_the_fit(self):
        vf = fxt.vf_of(self.seg(crop=rs.ClipCrop(0.25, 0.1, 0.5, 0.8), effects=rs.ClipEffects(rotate=90, flip_h=True)))
        self.assertEqual(
            vf,
            "transpose=1,hflip,crop=w='max(2,trunc(iw*0.5000/2)*2)':h='max(2,trunc(ih*0.8000/2)*2)':"
            "x='trunc(iw*0.2500/2)*2':y='trunc(ih*0.1000/2)*2',"
            "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1")

    def test_the_whole_picture_is_no_crop(self):
        self.assertEqual(fxt.vf_of(self.seg(crop=rs.ClipCrop())), fxt.vf_of(self.seg()))

    def test_the_angle_is_pinned_and_goes_after_the_fit_before_the_move(self):
        vf = fxt.vf_of(self.seg(angle=30.0, fade_in_s=0.5, move=rs.ClipMove(1, 0.5, 0.5, 2, 0.5, 0.5)))
        self.assertIn("pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,rotate=a=0.523599:ow=1280:oh=720:c=black:bilinear=1,"
                      "scale=w=", vf)
        self.assertTrue(vf.endswith("fade=t=in:st=0:d=0.500"), vf)
        self.assertIn("rotate=a=-1.570796:", fxt.vf_of(self.seg(angle=-90.0)))
        self.assertNotIn("rotate=", fxt.vf_of(self.seg()))

    def test_stills_take_both_in_every_path(self):
        seg = rs.Segment(2.0, "/m/p.png", kind=rs.KIND_IMAGE, crop=rs.ClipCrop(w=0.5), angle=20.0)
        for vf in (fxt.vf_of(seg, 0), fxt.vf_of(seg, 1)):
            self.assertTrue(vf.startswith("crop=w='max(2,trunc(iw*0.5000/2)*2)'"), vf)
            self.assertIn("rotate=a=0.349066:ow=1280:oh=720", vf)
        mv = rs.Segment(2.0, "/m/p.png", kind=rs.KIND_IMAGE, angle=20.0, move=rs.ClipMove(1, 0.5, 0.5, 2, 0.5, 0.5))
        for vf in (fxt.vf_of(mv, 0), fxt.vf_of(mv, 1)):
            self.assertIn("rotate=a=0.349066", vf)
        vf = fxt.vf_of(mv, 0)
        self.assertLess(vf.index("rotate="), vf.index("scale=w="), "turned, then zoomed into")

    def test_reverse_and_freeze_keep_the_turn_in_the_fitted_frame(self):
        vf = fxt.vf_of(self.seg(angle=10.0, reverse=True))
        self.assertRegex(vf, r"fps=30,rotate=a=0.174533:ow=1280:oh=720:c=black:bilinear=1,reverse,setpts=")
        vf = fxt.vf_of(self.seg(angle=10.0, freeze=True))
        self.assertRegex(vf, r"fps=30,rotate=.*,tpad=stop=59")

    def test_both_sides_of_a_crossfade_have_their_own(self):
        doc = {"version": 1, "width": 640, "height": 360, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0, "out_s": 2, "crop": {"w": 0.5}},
            {"id": "c2", "asset_id": BASE, "start_s": 1.5, "in_s": 0, "out_s": 2, "angle": 25,
             "transition": {"type": "crossfade", "duration_s": 0.5}}]}]}
        cmds, _ = trt.all_commands(doc)
        g = next(c[c.index("-filter_complex") + 1] for group in cmds[:-1] for c in group if "-filter_complex" in c)
        a, b = g.split(";")[:2]
        self.assertIn("crop=w=", a)
        self.assertNotIn("rotate=", a)
        self.assertIn("rotate=a=0.436332", b)
        self.assertNotIn("crop=w=", b)


class NeutralTestCase(unittest.TestCase):
    def test_every_older_document_renders_the_commands_it_always_did(self):
        for name, doc in trt.neutral_docs().items():
            with self.subTest(name):
                self.assertEqual(trt.digest(doc), trt.LEGACY[name])

    def test_the_neutral_values_change_nothing(self):
        for name, doc in trt.neutral_docs().items():
            doc2 = copy.deepcopy(doc)
            for t in doc2["tracks"]:
                if t["kind"] == "V":
                    for c in t["clips"]:
                        c.update(crop={"x": 0, "y": 0, "w": 1, "h": 1}, angle=0)
            with self.subTest(name):
                self.assertEqual(trt.digest(doc2), trt.LEGACY[name])


# ── real ffmpeg ─────────────────────────────────────────────────────────────

RED, GREEN, BLUE, YELLOW = (224, 32, 32), (32, 192, 32), (32, 32, 224), (224, 224, 32)


class _Real(fxt._Real):
    def quad(self, name="quad", size=(320, 180)):
        """A video of four quarters: red | green over blue | yellow."""
        w, h = size
        path = self.dir / f"{name}.mp4"
        hexes = ["0x%02X%02X%02X" % c for c in (RED, GREEN, BLUE, YELLOW)]
        cells = [f"color=c={hx}:s={w // 2}x{h // 2}:r=30:d=2[q{i}]" for i, hx in enumerate(hexes)]
        graph = ";".join(cells) + ";[q0][q1]hstack[t];[q2][q3]hstack[b];[t][b]vstack"
        self.run_ffmpeg("-filter_complex", graph, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "10", str(path))
        return tl.ResolvedAsset(BASE, "video", str(path), 2.0, False)

    def shot(self, asset, size=None, n=10, **clip):
        w, h = size or (self.W, self.H)
        doc = fxt.vdoc(width=w, height=h, **clip)
        out = self.export(doc, {BASE: asset})
        return self.frames(out, (w, h), [n], "bt601")[n]

    @staticmethod
    def near(p, c, tol=40):
        return all(abs(a - b) <= tol for a, b in zip(p, c))


class CropRenderTestCase(_Real):
    def test_each_quarter_fills_the_frame(self):
        src = self.quad()
        for (x, y), colour in (((0, 0), RED), ((0.5, 0), GREEN), ((0, 0.5), BLUE), ((0.5, 0.5), YELLOW)):
            raw = self.shot(src, crop={"x": x, "y": y, "w": 0.5, "h": 0.5})
            for px in ((10, 10), (160, 90), (310, 170), (10, 170)):
                self.assertTrue(self.near(self.px(raw, self.W, *px), colour), (x, y, px, self.px(raw, self.W, *px)))

    def test_a_portrait_window_is_fitted_as_what_it_is(self):
        src = self.quad()
        # the middle 25 % of the width: 80 x 180 of red/green over blue/yellow -> pillar-boxed by contain
        raw = self.shot(src, crop={"x": 0.375, "w": 0.25})
        self.assertLess(max(self.px(raw, self.W, 10, 90)), 40, "bars either side")
        self.assertTrue(self.near(self.px(raw, self.W, 140, 30), RED) or self.near(self.px(raw, self.W, 140, 30), GREEN))
        covered = self.shot(src, crop={"x": 0.375, "w": 0.25}, fit="cover")
        self.assertGreater(max(self.px(covered, self.W, 10, 90)), 100, "cover fills the frame")

    def test_the_crop_is_of_the_picture_as_turned(self):
        src = self.quad()
        # a quarter turn clockwise puts blue top-left and red top-right; the top half is then blue | red
        raw = self.shot(src, rotate=90, crop={"h": 0.5, "w": 1.0}, fit="cover")
        left, right = self.px(raw, self.W, 20, 90), self.px(raw, self.W, 300, 90)
        self.assertTrue(self.near(left, BLUE), left)
        self.assertTrue(self.near(right, RED), right)

    def sar_of(self, path):
        import subprocess
        err = subprocess.run([self.ffmpeg, "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
        return re.search(r"SAR (\d+:\d+)", err).group(1)

    def test_a_cropped_clip_comes_out_with_square_pixels(self):
        # an odd window fitted by contain left a pixel shape such as 393:392 (the scaler's rounding)
        src = self.quad()
        for clip in ({"crop": {"x": 0.1, "w": 0.37, "h": 0.61}}, {"crop": {"x": 0.1, "w": 0.37, "h": 0.61}, "fit": "cover"},
                     {"crop": {"w": 0.43, "h": 0.77}, "rotate": 90}, {"crop": {"w": 0.43, "h": 0.77}, "angle": 20},
                     {"crop": {"w": 0.43, "h": 0.77}, "fit": "blur"}, {}):
            out = self.export(fxt.vdoc(width=self.W, height=self.H, **clip), {BASE: src})
            self.assertEqual(self.sar_of(out), "1:1", clip)

    def test_a_still_is_cropped_too(self):
        row = bytes((*RED, 255)) * 32 + bytes((*GREEN, 255)) * 32
        png = self.png("rg", ovt.png_rgba(64, 36, lambda y: row))
        doc = {"version": 1, "width": self.W, "height": self.H, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": PIC, "start_s": 0, "in_s": 0, "out_s": 2, "crop": {"x": 0.5, "w": 0.5}}]}]}
        out = self.export(doc, {PIC: png})
        for n in (0, 30, 59):
            raw = self.frames(out, (self.W, self.H), [n], "bt601")[n]
            self.assertTrue(self.near(self.px(raw, self.W, 160, 90), GREEN), (n, self.px(raw, self.W, 160, 90)))


class AngleRenderTestCase(_Real):
    def halves(self, name="halves", size=(180, 180)):
        w, h = size
        path = self.dir / f"{name}.mp4"
        self.run_ffmpeg("-f", "lavfi", "-i", f"color=c=0xE02020:s={w // 2}x{h}:r=30:d=2",
                        "-f", "lavfi", "-i", f"color=c=0x2020E0:s={w // 2}x{h}:r=30:d=2",
                        "-filter_complex", "[0][1]hstack", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "10", str(path))
        return tl.ResolvedAsset(BASE, "video", str(path), 2.0, False)

    def test_plus_90_turns_the_picture_clockwise_and_minus_90_the_other_way(self):
        src = self.halves()
        size = (180, 180)
        cw = self.shot(src, size=size, angle=90)
        self.assertTrue(self.near(self.px(cw, 180, 90, 20), RED), self.px(cw, 180, 90, 20))
        self.assertTrue(self.near(self.px(cw, 180, 90, 160), BLUE))
        ccw = self.shot(src, size=size, angle=-90)
        self.assertTrue(self.near(self.px(ccw, 180, 90, 20), BLUE))
        self.assertTrue(self.near(self.px(ccw, 180, 90, 160), RED))
        half = self.shot(src, size=size, angle=180)
        self.assertTrue(self.near(self.px(half, 180, 20, 90), BLUE))
        self.assertTrue(self.near(self.px(half, 180, 160, 90), RED))

    def test_45_degrees_leaves_black_corners_and_keeps_the_middle(self):
        src = self.halves()
        raw = self.shot(src, size=(180, 180), angle=45)
        for px in ((2, 2), (177, 2), (2, 177), (177, 177)):
            self.assertLess(max(self.px(raw, 180, *px)), 40, px)
        self.assertGreater(max(self.px(raw, 180, 90, 90)), 100)
        self.assertGreater(max(self.px(raw, 180, 90, 4)), 100, "the middle of an edge is still picture")
        none = self.shot(src, size=(180, 180))
        self.assertGreater(max(self.px(none, 180, 2, 2)), 100)

    def test_the_frame_keeps_its_size_and_the_clip_its_length(self):
        src = self.halves(size=(320, 180))
        doc = fxt.vdoc(width=self.W, height=self.H, angle=20.5)
        out = self.export(doc, {BASE: src})
        import subprocess
        info = subprocess.run([self.ffmpeg, "-hide_banner", "-nostats", "-i", str(out), "-map", "0:v:0", "-vf",
                               "showinfo", "-f", "null", "-"], capture_output=True, text=True).stderr
        self.assertEqual(len(re.findall(r"Parsed_showinfo_0 .*\bn:\s*\d+", info)), 60)
        self.assertRegex(info, r"Stream #0:0.*320x180")

    def test_crop_and_angle_together_and_on_both_sides_of_a_blend(self):
        src = self.halves(size=(320, 180))
        doc = {"version": 1, "width": self.W, "height": self.H, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0, "out_s": 2, "crop": {"x": 0, "w": 0.5}, "angle": 10},
            {"id": "c2", "asset_id": BASE, "start_s": 1.5, "in_s": 0, "out_s": 2, "angle": -10, "fit": "cover",
             "transition": {"type": "crossfade", "duration_s": 0.5}}]}]}
        out = self.export(doc, {BASE: src})
        raw = self.frames(out, (self.W, self.H), [5, 95], "bt601")
        self.assertTrue(self.near(self.px(raw[5], self.W, 160, 90), RED), "the cropped left half fills the frame")
        self.assertGreater(max(self.px(raw[95], self.W, 160, 90)), 100)


if __name__ == "__main__":
    unittest.main()
