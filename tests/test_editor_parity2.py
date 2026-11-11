"""Editor parity, second pass (backend half): advanced colour (``color``: temperature, tint, hue, a named
tone curve) and a shape mask (``mask``: rect / ellipse / rounded, feather, invert) on a V clip.

* the document: closed lists and ranges in modules/timeline.py, the same in render_spec, the schema and
  lib/editor.ts; ``normalise`` drops a colour of zeros and fills a mask's defaults; a split keeps both;
* the render budget: both are charged per second of the clip, scaled by the frame's pixels x rate, like
  fast clips (only for a timeline an export renders), and the sentence names them;
* old documents: a document without the fields builds exactly the argv origin/main built
  (samples/parity2_argv_golden.json);
* real ffmpeg (render_backend.resolve_ffmpeg; size and frame count read with it too, no ffprobe) and pixel sampling: the mask shows the
  picture inside and black outside (inverted: the other way), a feather is a ramp, a mask works on a
  still, on both sides of a cross-fade and under a move; temperature, tint, hue and curves move the
  colour the way their names say.
"""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from modules import render_backend as rb
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr
from tests import parity2_argv_docs as golden_docs

ROOT = Path(__file__).resolve().parent.parent
B = "11111111-1111-4111-8111-111111111111"
P = "22222222-2222-4222-8222-222222222222"


def vdoc(width=320, height=180, fps=30, out_s=2.0, **clip):
    c = {"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": out_s}
    c.update(clip)
    return {"version": 1, "width": width, "height": height, "fps": fps,
            "tracks": [{"id": "v1", "kind": "V", "clips": [c]}]}


def problems(**clip):
    return tl.validate(vdoc(**clip))


class ColorDocumentTestCase(unittest.TestCase):
    def test_every_value_in_range_passes_and_past_it_is_refused(self):
        for k, hi in (("temperature", 100), ("tint", 100), ("hue", 180)):
            for ok in (-hi, -hi / 2, 0.5, hi):
                self.assertEqual(problems(color={k: ok}), [], (k, ok))
            for bad in (-hi - 0.001, hi + 0.001, "5", None, True, float("nan"), float("inf")):
                self.assertTrue(any(f"color: {k} must be a number" in p for p in problems(color={k: bad})), (k, bad))
        for c in tl.COLOR_CURVES:
            self.assertEqual(problems(color={"curve": c}), [])
        for bad in ("sepia", "", "Matte", 1, None):
            self.assertTrue(any("curve must be one of" in p for p in problems(color={"curve": bad})), bad)

    def test_an_empty_colour_or_an_unknown_field_is_refused(self):
        self.assertTrue(any("give at least one" in p for p in problems(color={})))
        self.assertTrue(problems(color={"saturation": 2}))
        self.assertTrue(problems(color=[1]))

    def test_normalise_drops_zeros_and_a_colour_of_zeros(self):
        c = tl.normalise(vdoc(color={"temperature": 0, "hue": 12.00049, "curve": "matte"}))["tracks"][0]["clips"][0]
        self.assertEqual(c["color"], {"hue": 12.0, "curve": "matte"})
        c = tl.normalise(vdoc(color={"temperature": 0.0, "tint": 0}))["tracks"][0]["clips"][0]
        self.assertNotIn("color", c)
        self.assertEqual(tl.normalise(vdoc(color={"tint": 0})), tl.normalise(vdoc()))


class MaskDocumentTestCase(unittest.TestCase):
    def test_shapes_ranges_and_the_rounded_only_radius(self):
        for s in tl.MASK_SHAPES:
            self.assertEqual(problems(mask={"shape": s}), [])
        self.assertEqual(problems(mask={"shape": "rounded", "radius": 0.5, "x": 0, "y": 1, "w": 0.05, "h": 1,
                                        "feather": 0.5, "invert": True}), [])
        self.assertTrue(any("shape must be one of" in p for p in problems(mask={"shape": "star"})))
        self.assertTrue(problems(mask={"w": 0.5}))       # a shape is required
        for k, lo, hi in (("x", 0, 1), ("y", 0, 1), ("w", 0.05, 1), ("h", 0.05, 1), ("feather", 0, 0.5)):
            self.assertTrue(problems(mask={"shape": "rect", k: lo - 0.001}), k)
            self.assertTrue(problems(mask={"shape": "rect", k: hi + 0.001}), k)
        for s in ("rect", "ellipse"):
            self.assertTrue(any("only for a rounded" in p for p in problems(mask={"shape": s, "radius": 0.1})))
        self.assertTrue(any("invert must be" in p for p in problems(mask={"shape": "rect", "invert": 1})))

    def test_normalise_fills_the_defaults_so_two_spellings_are_one_document(self):
        a = tl.normalise(vdoc(mask={"shape": "rounded"}))
        b = tl.normalise(vdoc(mask={"shape": "rounded", "x": 0.5, "y": 0.5, "w": 0.6, "h": 0.6, "feather": 0,
                                    "radius": 0.25, "invert": False}))
        self.assertEqual(a, b)
        self.assertEqual(a["tracks"][0]["clips"][0]["mask"]["radius"], tl.MASK_RADIUS_DEFAULT)
        self.assertNotIn("radius", tl.normalise(vdoc(mask={"shape": "ellipse"}))["tracks"][0]["clips"][0]["mask"])

    def test_a_split_keeps_the_colour_and_the_mask_on_both_halves(self):
        d = tl.split_clip(tl.normalise(vdoc(out_s=4, color={"hue": 9}, mask={"shape": "ellipse"})), "c1", 2.0, "c2")
        for c in d["tracks"][0]["clips"]:
            self.assertEqual(c["color"], {"hue": 9.0})
            self.assertEqual(c["mask"]["shape"], "ellipse")


class SplitFadesTestCase(unittest.TestCase):
    """split_clip keeps each piece's fades inside it (lib/editor.ts splitClip does the same): a short head
    or tail piece of a faded clip used to keep the whole fade, and the document no longer validated."""

    def test_the_reviews_case_a_short_tail_keeps_only_as_much_fade_out_as_it_is_long(self):
        d = tl.normalise(vdoc(out_s=12, fade_in_s=0.5, fade_out_s=0.7, audio=True))
        d = tl.split_clip(d, "c1", 11.5, "c2")
        a, b = d["tracks"][0]["clips"]
        self.assertEqual((a["fade_in_s"], a["fade_out_s"], b["fade_in_s"], b["fade_out_s"]), (0.5, 0.0, 0.0, 0.5))
        self.assertEqual(tl.validate(d), [])
        d = tl.split_clip(tl.normalise(vdoc(out_s=12, fade_in_s=0.5)), "c1", 0.2, "c2")
        self.assertEqual(d["tracks"][0]["clips"][0]["fade_in_s"], 0.2)
        self.assertEqual(tl.validate(d), [])

    def test_random_splits_of_faded_clips_at_1x_and_2x_always_validate(self):
        import random
        rng = random.Random(675)
        done = 0
        for _ in range(1500):
            rng_ = rng.choice([1.0, 2.5, 6.0, 12.0])
            # Speeds whose source cut lands on the millisecond: at 0.25, 0.5 or 3 split_clip's own rounding can
            # leave the halves overlapping by 1 ms with no fade at all (on origin/main too; a separate issue).
            speed = rng.choice([1.0, 2.0])
            length = rng_ / speed
            clip = {"fade_in_s": round(rng.uniform(0, length / 2), 3), "fade_out_s": round(rng.uniform(0, length / 2), 3),
                    "speed": speed, "audio": rng.random() < 0.5}
            if rng.random() < 0.3:
                clip["move"] = {"from": {"zoom": 1.5}, "to": {"zoom": 1, "x": 0.2}}
            if rng.random() < 0.3:
                clip["mask"] = {"shape": "ellipse", "feather": 0.2}
            d = tl.normalise(vdoc(out_s=rng_, **clip))
            if tl.validate(d):
                continue
            at = round(rng.uniform(0.1, length - 0.1), 3)   # pieces of at least a clip (the editor's MIN_CLIP_S)
            try:
                d2 = tl.split_clip(d, "c1", at, "c2")
            except tl.TimelineError:
                continue
            self.assertEqual(tl.validate(d2), [], (clip, at))
            done += 1
        self.assertGreater(done, 1000)


class TwinsTestCase(unittest.TestCase):
    def test_render_spec_the_schema_and_the_editor_have_the_same_lists_and_numbers(self):
        for name in ("COLOR_TEMP_MAX", "COLOR_TINT_MAX", "COLOR_HUE_MAX", "COLOR_CURVES", "MASK_SHAPES", "MASK_MIN",
                     "MASK_FEATHER_MAX", "MASK_RADIUS_MAX"):
            self.assertEqual(getattr(rs, name), getattr(tl, name), name)
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))["$defs"]["video_clip"]["properties"]
        self.assertEqual(set(schema["color"]["properties"]), set(tl._COLOR_KEYS))
        self.assertEqual(schema["color"]["properties"]["curve"]["enum"], list(tl.COLOR_CURVES))
        self.assertEqual(set(schema["mask"]["properties"]), set(tl._MASK_KEYS))
        self.assertEqual(schema["mask"]["properties"]["shape"]["enum"], list(tl.MASK_SHAPES))
        self.assertEqual(schema["mask"]["properties"]["feather"]["maximum"], tl.MASK_FEATHER_MAX)
        ts = (ROOT / "command-center" / "lib" / "editor.ts").read_text(encoding="utf-8")
        for name in ("COLOR_CHROMA_SECONDS_PER_S", "COLOR_HUE_SECONDS_PER_S", "COLOR_CURVE_SECONDS_PER_S",
                     "MASK_SECONDS_PER_S", "MASK_MIN", "MASK_FEATHER_MAX", "MASK_RADIUS_MAX", "COLOR_TEMP_MAX",
                     "COLOR_TINT_MAX", "COLOR_HUE_MAX", "MASK_RADIUS_DEFAULT"):
            self.assertIn(f"export const {name} = {getattr(tl, name):g};", ts, name)
        for k in tl.COLOR_CURVES:
            self.assertIn(k, rb._COLOR_CURVE_ARGS)

    def test_the_spec_refuses_every_colour_and_mask_value_out_of_range(self):
        """render_spec.validate is the last check before a graph is written: each range holds there too."""
        def seg(**kw):
            return rs.Segment(duration=1.0, path="/m/a.mp4", **kw)

        def spec_problems(s_):
            return rs._segment_problems("segment 0", s_, True)

        for k, hi in (("temperature", rs.COLOR_TEMP_MAX), ("tint", rs.COLOR_TINT_MAX), ("hue", rs.COLOR_HUE_MAX)):
            self.assertEqual(spec_problems(seg(effects=rs.ClipEffects(**{k: hi}))), [], k)
            self.assertEqual(spec_problems(seg(effects=rs.ClipEffects(**{k: -hi}))), [], k)
            for bad in (hi + 0.001, -hi - 0.001, float("nan")):
                self.assertTrue(any(f"{k} must be from" in p for p in spec_problems(seg(effects=rs.ClipEffects(**{k: bad})))),
                                (k, bad))
        for k, lo, hi in (("x", 0.0, 1.0), ("y", 0.0, 1.0), ("w", rs.MASK_MIN, 1.0), ("h", rs.MASK_MIN, 1.0),
                          ("feather", 0.0, rs.MASK_FEATHER_MAX), ("radius", 0.0, rs.MASK_RADIUS_MAX)):
            for ok in (lo, hi):
                self.assertEqual(spec_problems(seg(mask=rs.ClipMask(**{k: ok}))), [], (k, ok))
            for bad in (lo - 0.001, hi + 0.001, float("inf")):
                self.assertTrue(any(f"mask {k} must be from" in p for p in spec_problems(seg(mask=rs.ClipMask(**{k: bad})))),
                                (k, bad))
        self.assertTrue(spec_problems(seg(mask=rs.ClipMask(invert=1))))
        self.assertTrue(rs._segment_problems("segment 0", seg(mask=rs.ClipMask()), False))   # needs frame_exact

    def test_only_listed_names_reach_the_filter_graph(self):
        with self.assertRaises(ValueError):
            rb.colour_adjust_filters(rs.ClipEffects(curve="'; evil"))
        self.assertTrue(rs._effects_problems("c", rs.ClipEffects(curve="evil")))
        self.assertTrue(rs._mask_problems("c", rs.ClipMask(shape="star")))
        with self.assertRaises(ValueError):
            rb.draw_mask(rs.ClipMask(shape="star"), 16, 16, Path(tempfile.mkdtemp()) / "m.png")


class BudgetTestCase(unittest.TestCase):
    def test_the_cost_is_per_second_scaled_by_pixels_and_rate(self):
        c = {"in_s": 0, "out_s": 10, "color": {"temperature": 5, "hue": 1, "curve": "matte"}, "mask": {"shape": "rect"}}
        per = tl.COLOR_CHROMA_SECONDS_PER_S + tl.COLOR_HUE_SECONDS_PER_S + tl.COLOR_CURVE_SECONDS_PER_S + tl.MASK_SECONDS_PER_S
        self.assertAlmostEqual(tl.look_seconds(c, 30, 1920, 1080), 10 * per)
        self.assertAlmostEqual(tl.look_seconds(c, 60, 3840, 2160), 80 * per)
        self.assertAlmostEqual(tl.look_seconds({**c, "speed": 2}, 30, 1920, 1080), 5 * per)
        self.assertEqual(tl.look_seconds({"in_s": 0, "out_s": 10}, 30, 1920, 1080), 0)

    def test_a_long_4k60_masked_timeline_is_refused_and_a_short_one_or_1080p_passes(self):
        long_ = vdoc(width=3840, height=2160, fps=60, out_s=600, mask={"shape": "rect"})
        got = tl.validate(long_)
        self.assertTrue(any("colour, masks and effects would take about" in p and "use fewer colour changes, masks and effects" in p
                            for p in got), got)
        self.assertEqual(tl.validate(vdoc(width=3840, height=2160, fps=60, out_s=20, mask={"shape": "rect"})), [])
        self.assertEqual(tl.validate(vdoc(width=1920, height=1080, fps=30, out_s=600, mask={"shape": "rect"},
                                          color={"temperature": 1, "hue": 1, "curve": "matte"})), [])

    def test_charged_together_with_fast_clips_and_shapes(self):
        d = vdoc(width=1920, height=1080, fps=60, out_s=1600, speed=4, color={"curve": "matte", "hue": 5},
                 mask={"shape": "rect"})
        got = tl.validate(d)
        # either alone fits; together they are over, and the sentence names both
        self.assertEqual(tl.validate(vdoc(width=1920, height=1080, fps=60, out_s=1600, speed=4)), [])
        self.assertEqual(tl.validate(vdoc(width=1920, height=1080, fps=60, out_s=400, color={"curve": "matte", "hue": 5},
                                          mask={"shape": "rect"})), [])
        self.assertTrue(any("playing clips faster than 1x and colour, masks and effects" in p for p in got), got)
        d = vdoc(width=3840, height=2160, fps=60, out_s=120, mask={"shape": "rect"})
        d["shapes"] = [{"id": "s1", "kind": "circle", "start_s": 0, "end_s": 120}]
        self.assertTrue(tl.validate(d))

    def test_a_draft_longer_than_an_export_is_not_charged(self):
        d = vdoc(width=3840, height=2160, fps=60, out_s=1900, mask={"shape": "rect"})
        self.assertEqual(tl.validate(d), [])


class LargeFrameMaskTestCase(unittest.TestCase):
    def doc(self, w, h, **second):
        d = vdoc(width=w, height=h, out_s=3, mask={"shape": "rect"})
        d["tracks"][0]["clips"].append(dict({"id": "c2", "asset_id": B, "start_s": 2.5, "in_s": 0, "out_s": 3,
                                             "transition": {"type": "crossfade", "duration_s": 0.5}}, **second))
        return d

    def test_a_cross_faded_masked_clip_above_1440p_is_refused_and_at_1440p_passes(self):
        got = tl.validate(self.doc(3840, 2160))
        self.assertTrue(any("a mask is not offered on a cross-faded clip" in p for p in got), got)
        self.assertEqual(tl.validate(self.doc(2560, 1440, mask={"shape": "ellipse"})), [])

    def test_a_masked_clip_above_1440p_zooms_at_most_2(self):
        for z, ok in ((2, True), (2.01, False)):
            d = vdoc(width=3840, height=2160, mask={"shape": "rect"}, move={"from": {"zoom": 1}, "to": {"zoom": z}})
            self.assertEqual(tl.validate(d) == [], ok, z)
        self.assertEqual(tl.validate(vdoc(width=2560, height=1440, mask={"shape": "rect"},
                                          move={"from": {"zoom": 4}, "to": {"zoom": 1}})), [])


class OldDocumentsTestCase(unittest.TestCase):
    def test_documents_without_the_new_fields_build_the_argv_main_built(self):
        golden = json.loads((ROOT / "samples" / "parity2_argv_golden.json").read_text(encoding="utf-8"))
        docs = golden_docs.docs()
        self.assertEqual(set(golden), set(docs))
        for name, d in docs.items():
            with self.subTest(name):
                self.assertEqual(golden_docs.argv(d), golden[name])

    def test_no_colour_adds_no_filter(self):
        self.assertEqual(rb.colour_adjust_filters(rs.ClipEffects()), [])
        self.assertEqual(rb.effect_filters(rs.ClipEffects(vignette=0.5)), ["vignette=angle=0.3500"])


def _ffmpeg():
    try:
        exe = rb.resolve_ffmpeg()
        subprocess.run([exe, "-version"], capture_output=True, check=True)
        return exe
    except Exception:
        return None


class RealRenderTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ffmpeg = _ffmpeg()
        if not cls.ffmpeg:
            raise unittest.SkipTest("ffmpeg not available")
        try:
            from PIL import Image
        except ImportError:
            raise unittest.SkipTest("Pillow not installed")
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        cls.grey = d / "grey.mp4"
        cls.colour = d / "colour.mp4"
        for path, c in ((cls.grey, "0x808080"), (cls.colour, "0xC04020")):
            subprocess.run([cls.ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"color=c={c}:s=320x180:r=30:d=4",
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)], check=True)
        cls.pic = d / "pic.png"
        Image.new("RGB", (640, 360), (200, 200, 200)).save(cls.pic)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def render(self, doc, src=None):
        src = src or self.grey
        res = lambda a: (tl.ResolvedAsset(a, "video", str(src), 4.0, False) if a == B
                         else tl.ResolvedAsset(a, "image", str(self.pic), None, False))
        out = Path(self.tmp.name) / f"o{abs(hash(json.dumps(doc, sort_keys=True)))}.mp4"
        tr.render(doc, res, str(out))
        return out

    def rgb(self, path, pts, t=0.5, size=(320, 180)):
        raw = subprocess.run([self.ffmpeg, "-loglevel", "error", "-ss", str(t), "-i", str(path), "-frames:v", "1", "-f",
                              "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
        w = size[0]
        return [tuple(raw[(y * w + x) * 3:(y * w + x) * 3 + 3]) for x, y in pts]

    def probe(self, path):
        """Size and decoded frame count with the bundled ffmpeg alone (CI has no ffprobe on PATH): the
        repo's own ffmpeg-only readers, video_qc's ``ffmpeg -i`` parse and scene_remotion's frame count."""
        from modules import scene_remotion, video_qc
        v = video_qc._probe_ffmpeg(self.ffmpeg, Path(path))["video"]
        frames = scene_remotion.count_frames(self.ffmpeg, path)
        self.assertIsNotNone(v, path)
        self.assertIsNotNone(frames, path)
        return {"width": v["width"], "height": v["height"], "nb_read_frames": frames}

    def test_an_ellipse_shows_the_picture_inside_and_black_outside_and_invert_swaps_them(self):
        out = self.render(vdoc(mask={"shape": "ellipse", "w": 0.5, "h": 0.5}))
        inside, corner, near, outside = self.rgb(out, [(160, 90), (5, 5), (100, 90), (70, 90)])
        self.assertTrue(all(abs(v - 128) <= 3 for v in inside + near), (inside, near))
        self.assertTrue(all(v <= 3 for v in corner + outside), (corner, outside))
        p = self.probe(out)
        self.assertEqual((p["width"], p["height"], int(p["nb_read_frames"])), (320, 180, 60))
        inv = self.render(vdoc(mask={"shape": "rect", "w": 0.5, "h": 0.5, "invert": True}))
        inside, corner = self.rgb(inv, [(160, 90), (5, 5)])
        self.assertTrue(all(v <= 3 for v in inside) and all(abs(v - 128) <= 3 for v in corner), (inside, corner))

    def test_a_feather_is_a_ramp_from_the_picture_to_black(self):
        out = self.render(vdoc(mask={"shape": "rect", "w": 0.5, "h": 1, "feather": 0.5}))
        row = [self.rgb(out, [(x, 90)])[0][0] for x in (160, 100, 80, 60, 20)]
        self.assertGreater(row[0], 120)
        self.assertTrue(all(a >= b for a, b in zip(row, row[1:])), row)
        self.assertTrue(20 < row[2] < 110, row)        # the shape's own edge is half seen
        self.assertLess(row[-1], 20)

    def test_a_still_a_cross_fade_and_a_move_all_take_a_mask(self):
        d = vdoc(out_s=1, mask={"shape": "ellipse", "w": 0.5, "h": 0.5})
        d["tracks"][0]["clips"] += [
            {"id": "c2", "asset_id": P, "start_s": 0.5, "in_s": 0, "out_s": 1.5, "transition": {"type": "crossfade",
             "duration_s": 0.5}, "mask": {"shape": "rounded", "w": 0.9, "h": 0.9, "feather": 0.3}},
            {"id": "c3", "asset_id": P, "start_s": 2.0, "in_s": 0, "out_s": 1, "mask": {"shape": "rect", "x": 0.25,
             "w": 0.5, "h": 1}, "move": {"from": {"zoom": 1}, "to": {"zoom": 2}}}]
        self.assertEqual(tl.validate(d), [])
        out = self.render(d)
        self.assertEqual(int(self.probe(out)["nb_read_frames"]), 90)
        mid_blend, corner = self.rgb(out, [(160, 90), (5, 5)], t=0.75)
        self.assertTrue(140 < mid_blend[0] < 190, mid_blend)      # grey dissolving into the light still
        self.assertLess(corner[0], 10)
        still_in, still_corner = self.rgb(out, [(160, 90), (2, 2)], t=1.5)
        self.assertGreater(still_in[0], 190)
        self.assertLess(still_corner[0], 10)
        left, right = self.rgb(out, [(20, 90), (300, 90)], t=2.5)
        self.assertGreater(left[0], 190)
        self.assertLess(right[0], 10)

    def test_temperature_tint_hue_and_curves_move_the_colour_the_way_their_names_say(self):
        warm, cool, magenta, green = (self.rgb(self.render(vdoc(color=c)), [(160, 90)])[0] for c in (
            {"temperature": 100}, {"temperature": -100}, {"tint": 100}, {"tint": -100}))
        self.assertGreater(warm[0] - warm[2], 30)
        self.assertGreater(cool[2] - cool[0], 30)
        self.assertGreater(min(magenta[0], magenta[2]) - magenta[1], 20)
        self.assertGreater(green[1] - max(green[0], green[2]), 20)
        base = self.rgb(self.render(vdoc(), src=self.colour), [(160, 90)])[0]
        turned = self.rgb(self.render(vdoc(color={"hue": 120}), src=self.colour), [(160, 90)])[0]
        self.assertGreater(base[0], base[1])                 # orange-red ...
        self.assertGreater(turned[1], turned[0])             # ... turned a third of the wheel is green
        lighter = self.rgb(self.render(vdoc(color={"curve": "lighter"})), [(160, 90)])[0]
        darker = self.rgb(self.render(vdoc(color={"curve": "darker"})), [(160, 90)])[0]
        self.assertGreater(lighter[1], 140)
        self.assertLess(darker[1], 115)


if __name__ == "__main__":
    unittest.main()
