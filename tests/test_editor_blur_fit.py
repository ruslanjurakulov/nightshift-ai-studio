"""The blurred-background fit (``fit: "blur"``), backend half.

A third fit beside ``contain`` and ``cover``: the whole picture, centred, over a
blurred and enlarged copy of itself, so no black bars. By class:

* the document: ``blur`` is on the closed list, anything else is not; the JSON
  schema and the TypeScript twin agree;
* the argv: documents that use ``contain`` / ``cover`` render the SAME commands
  as before (golden digests, tests/test_editor_transitions.py LEGACY); the blur
  chain is pinned, the colour grade and effects run on the composed frame, the
  two sides of a cross-fade get their own labels (a clash would fail ffmpeg),
  and a still ignores the fit as it always did;
* the PIXELS, real ffmpeg: where the picture's aspect differs from the frame's,
  the area a ``contain`` leaves black shows the picture's own colours instead,
  the middle is the sharp picture, a picture of the frame's aspect is the
  picture alone, a cross-fade between two blur clips renders.
"""

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
BASE = ovt.BASE


class DocumentTestCase(unittest.TestCase):
    def test_blur_is_a_fit_and_the_list_is_closed(self):
        self.assertEqual(tl.FITS, ("contain", "cover", "blur"))
        for fit in tl.FITS:
            self.assertEqual(tl.validate(fxt.vdoc(fit=fit)), [], fit)
        for bad in ("Blur", "blur ", "blurred", "fill", "stretch", "", None, True, 1, ["blur"]):
            got = tl.validate(fxt.vdoc(fit=bad))
            self.assertTrue(any("fit must be one of" in p for p in got), (bad, got))

    def test_normalise_keeps_it(self):
        n = tl.normalise(fxt.vdoc(fit="blur"))["tracks"][0]["clips"][0]
        self.assertEqual(n["fit"], "blur")
        self.assertEqual(tl.normalise(fxt.vdoc())["tracks"][0]["clips"][0]["fit"], "contain")

    def test_the_schema_and_the_editor_agree(self):
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        self.assertEqual(schema["$defs"]["video_clip"]["properties"]["fit"]["enum"], list(tl.FITS))
        self.assertEqual(rs.FITS, tl.FITS)
        ts = EDITOR_TS.read_text(encoding="utf-8")
        listed = re.search(r"const FITS = \[([^\]]*)\] as const", ts).group(1)
        self.assertEqual(tuple(re.findall(r'"(\w+)"', listed)), tl.FITS)

    def test_the_spec_refuses_an_unknown_fit(self):
        seg = rs.Segment(2.0, "/m/a.mp4", fit="blurr")
        self.assertTrue(any("unknown fit" in p for p in rs.validate(
            rs.RenderSpec("/o.mp4", 1280, 720, 30, segments=[seg], frame_exact=True))))
        self.assertEqual(fxt.spec_of(fxt.vdoc(fit="blur")).segments[0].fit, "blur")


class CommandTestCase(unittest.TestCase):
    def test_the_chain_is_pinned(self):
        seg = rs.Segment(2.0, "/m/a.mp4", fit=rs.FIT_BLUR)
        self.assertEqual(
            fxt.vf_of(seg),
            "split=2[bg][fg];[bg]scale=160:90:force_original_aspect_ratio=increase,crop=160:90,gblur=sigma=3,"
            "scale=1280:720:flags=bicubic[bb];[fg]scale=1280:720:force_original_aspect_ratio=decrease[fs];"
            "[bb][fs]overlay=x=(W-w)/2:y=(H-h)/2:format=yuv420,format=yuv420p,fps=30,setsar=1")

    def test_odd_frames_make_even_background_sizes(self):
        vf = render_backend._scale_blur(1080, 1920, 30)
        self.assertIn("scale=134:240:", vf)     # 1080/8 = 135 -> 134, 1920/8 = 240
        self.assertIn("scale=1080:1920:flags=bicubic", vf)

    def test_the_blur_chain_squares_its_pixels_once(self):
        # the quarter-turn setsar of the effects branch is not added a second time
        vf = fxt.vf_of(rs.Segment(2.0, "/m/a.mp4", fit=rs.FIT_BLUR, effects=rs.ClipEffects(rotate=90)))
        self.assertEqual(vf.count("setsar=1"), 1, vf)
        self.assertTrue(vf.endswith("fps=30,setsar=1"), vf)

    def test_grade_and_effects_run_on_the_composed_frame_and_a_turn_before_it(self):
        seg = rs.Segment(2.0, "/m/a.mp4", fit=rs.FIT_BLUR, speed=2.0, brightness=0.1, contrast=1.2,
                         saturation=0.8, effects=rs.ClipEffects(filter="mono", rotate=90))
        vf = fxt.vf_of(seg)
        self.assertTrue(vf.startswith("setpts=(PTS-STARTPTS)/2.000,transpose=1,split=2[bg][fg];"), vf)
        self.assertTrue(vf.endswith("fps=30,setsar=1,format=yuv420p,eq=brightness=0.100:contrast=1.200:saturation=0.800,"
                                    "hue=s=0.000"), vf)

    def test_contain_and_cover_are_the_chains_they_were(self):
        self.assertEqual(fxt.vf_of(rs.Segment(2.0, "/m/a.mp4")),
                         "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30")
        self.assertEqual(fxt.vf_of(rs.Segment(2.0, "/m/a.mp4", fit="cover")),
                         "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=30")

    def test_a_still_does_not_take_the_fit_and_never_did(self):
        plain = rs.Segment(2.0, "/m/p.png", kind=rs.KIND_IMAGE)
        blur = rs.Segment(2.0, "/m/p.png", kind=rs.KIND_IMAGE, fit=rs.FIT_BLUR)
        a = render_backend.segment_commands("ffmpeg", plain, Path("/w/s.mp4"), 1280, 720, 30, seed="x",
                                            frame_exact=True)
        b = render_backend.segment_commands("ffmpeg", blur, Path("/w/s.mp4"), 1280, 720, 30, seed="x",
                                            frame_exact=True)
        self.assertEqual(a, b)

    def test_each_side_of_a_crossfade_has_its_own_labels(self):
        doc = {"version": 1, "width": 640, "height": 360, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0, "out_s": 2, "fit": "blur"},
            {"id": "c2", "asset_id": BASE, "start_s": 1.5, "in_s": 0, "out_s": 2, "fit": "blur",
             "transition": {"type": "crossfade", "duration_s": 0.5}}]}]}
        cmds, _ = trt.all_commands(doc)
        g = next(c[c.index("-filter_complex") + 1] for group in cmds[:-1] for c in group if "-filter_complex" in c)
        labels = re.findall(r"\[(\w+)\]", g)
        self.assertTrue(all(f"[{n}]" in g for n in ("bga", "fga", "bgb", "fgb")), g)
        for name in ("bga", "fga", "bba", "fsa", "bgb", "fgb", "bbb", "fsb", "xa", "xb"):
            self.assertEqual(labels.count(name), 2, (name, labels))   # one output, one use


class NeutralTestCase(unittest.TestCase):
    def test_every_older_document_renders_the_commands_it_always_did(self):
        for name, doc in trt.neutral_docs().items():
            with self.subTest(name):
                self.assertEqual(trt.digest(doc), trt.LEGACY[name])


class BlurRenderTestCase(fxt._Real):
    def portrait_source(self):
        """A 90 x 180 portrait video: left half red, right half blue."""
        path = self.dir / "portrait.mp4"
        self.run_ffmpeg("-f", "lavfi", "-i", "color=c=0xE02020:s=90x180:r=30:d=2",
                        "-f", "lavfi", "-i", "color=c=0x2020E0:s=90x180:r=30:d=2",
                        "-filter_complex", "[0:v][1:v]hstack", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path))
        return tl.ResolvedAsset(BASE, "video", str(path), 2.0, False)

    def test_the_bars_of_contain_are_the_pictures_own_colours_under_blur(self):
        src = self.portrait_source()           # 180 x 180 picture: red | blue; the frame is 320 x 180
        out_c = self.export(fxt.vdoc(width=self.W, height=self.H, fit="contain"), {BASE: src})
        out_b = self.export(fxt.vdoc(width=self.W, height=self.H, fit="blur"), {BASE: src})
        c = self.frames(out_c, (self.W, self.H), [10], "bt601")[10]
        b = self.frames(out_b, (self.W, self.H), [10], "bt601")[10]
        # contain: side bars are black; blur: the left bar is reddish, the right bluish
        self.assertLess(max(self.px(c, self.W, 20, 90)), 40)
        self.assertLess(max(self.px(c, self.W, 300, 90)), 40)
        left, right = self.px(b, self.W, 20, 90), self.px(b, self.W, 300, 90)
        self.assertGreater(left[0], 120, left)
        self.assertGreater(left[0], left[2] + 40, left)
        self.assertGreater(right[2], 120, right)
        self.assertGreater(right[2], right[0] + 40, right)
        # the picture itself, in the middle 180 x 180, is identical to contain's (sharp, in place)
        for x in (80, 140, 175, 185, 240):
            self.assertLess(max(abs(p - q) for p, q in zip(self.px(c, self.W, x, 90), self.px(b, self.W, x, 90))), 10, x)
        # the seam inside the picture is still a hard edge
        self.assertGreater(self.px(b, self.W, 158, 90)[0], 180)
        self.assertGreater(self.px(b, self.W, 162, 90)[2], 180)

    def test_a_picture_of_the_frames_own_shape_is_just_the_picture(self):
        src = self.split_source()              # 320 x 180, the frame's shape
        out_b = self.export(fxt.vdoc(width=self.W, height=self.H, fit="blur"), {BASE: src})
        out_c = self.export(fxt.vdoc(width=self.W, height=self.H, fit="contain"), {BASE: src})
        b = self.frames(out_b, (self.W, self.H), [10], "bt601")[10]
        c = self.frames(out_c, (self.W, self.H), [10], "bt601")[10]
        self.assert_same(b, c, (self.W, self.H), "blur fit of a same-shape picture", thr=8)

    def test_a_landscape_picture_in_a_portrait_frame_gets_top_and_bottom_fill(self):
        src = self.split_source()
        out = self.export(fxt.vdoc(width=180, height=320, fit="blur"), {BASE: src})
        raw = self.run_ffmpeg("-i", str(out), "-vf", "select=eq(n\\,10),scale=in_color_matrix=bt601:in_range=tv,format=rgb24",
                              "-vsync", "0", "-f", "rawvideo", "-")
        top = self.px(raw, 180, 40, 10)
        self.assertGreater(top[0], 100, top)       # the red half's blur, not black

    def test_a_blur_clip_comes_out_with_square_pixels(self):
        # before setsar=1 the picture came out 23:22 (measured), and a player stretched it
        import subprocess
        for src in (self.portrait_source(), self.split_source()):
            for size in ((self.W, self.H), (180, 320), (270, 480)):      # landscape, portrait, a taller portrait
                for fx in ({}, {"rotate": 90}):
                    out = self.export(fxt.vdoc(width=size[0], height=size[1], fit="blur", **fx), {BASE: src})
                    err = subprocess.run([self.ffmpeg, "-hide_banner", "-i", str(out)], capture_output=True,
                                         text=True).stderr
                    self.assertEqual(re.search(r"SAR (\d+:\d+)", err).group(1), "1:1", (size, fx, err))

    def test_a_crossfade_between_two_blur_clips_renders_every_frame(self):
        src = self.portrait_source()
        doc = {"version": 1, "width": self.W, "height": self.H, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0, "out_s": 2, "fit": "blur"},
            {"id": "c2", "asset_id": BASE, "start_s": 1.5, "in_s": 0, "out_s": 2, "fit": "blur",
             "transition": {"type": "crossfade", "duration_s": 0.5}}]}]}
        out = self.export(doc, {BASE: src})
        import subprocess
        info = subprocess.run([self.ffmpeg, "-hide_banner", "-nostats", "-i", str(out), "-map", "0:v:0", "-vf",
                               "showinfo", "-f", "null", "-"], capture_output=True, text=True).stderr
        self.assertEqual(len(re.findall(r"Parsed_showinfo_0 .*\bn:\s*\d+", info)), 105)
        raw = self.frames(out, (self.W, self.H), [60], "bt601")[60]
        self.assertGreater(self.px(raw, self.W, 20, 90)[0], 100, "bar filled during the blend too")


if __name__ == "__main__":
    unittest.main()
