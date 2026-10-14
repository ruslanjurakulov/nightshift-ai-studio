"""Clip effects (backend half): colour looks, vignette, blur, sharpen, grain,
mirror and quarter turns on a V clip.

Fields (modules/timeline.py): ``filter`` + ``filter_strength``, ``vignette``,
``blur``, ``sharpen``, ``grain``, ``flip_h``, ``flip_v``, ``rotate``. By class:

* the document: closed list, every range at both ends and beyond, a strength
  needs a filter, booleans are booleans and ``rotate`` is one of four integers,
  normalisation drops every "off" value, the JSON schema and the constants the
  three languages share;
* the argv: a document without effects (or with every effect off) renders the
  SAME command lists as before (digests captured from origin/main, in
  tests/test_editor_transitions.py LEGACY); with effects, the exact filter
  strings are pinned, turns come before the fit and looks after the grade, and
  no document text reaches a graph;
* the PIXELS, with real ffmpeg: each look does what its name says on measured
  pixels, strength 0.5 sits between "off" and full, blur / sharpen / grain /
  vignette change the picture in the direction they claim (and grain repeats),
  mirror and turns move a known picture, stills and both sides of a cross-fade
  take the effects too. Skipped cleanly when no ffmpeg runs.

Not proven: that any look matches another editor's look of the same name (the
names are ours), or how a browser would preview them (the UI says so).
"""

import copy
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from modules import render_backend
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr
from tests import test_editor_overlay as ovt
from tests import test_editor_transitions as trt

ROOT = Path(__file__).resolve().parent.parent
EDITOR_TS = ROOT / "command-center" / "lib" / "editor.ts"

BASE, PIC = ovt.BASE, ovt.PIC


def vdoc(width=640, height=360, fps=30, out_s=2, asset=BASE, **clip):
    c = {"id": "c1", "asset_id": asset, "start_s": 0, "in_s": 0, "out_s": out_s}
    c.update(clip)
    return {"version": 1, "width": width, "height": height, "fps": fps,
            "tracks": [{"id": "v1", "kind": "V", "clips": [c]}]}


def problems_of(**clip):
    return tl.validate(vdoc(**clip))


def spec_of(doc, table=None):
    return tr.to_render_spec(doc, (table or ovt.assets_table()).get, "/out/x.mp4")


# ── the document ────────────────────────────────────────────────────────────

class DocumentTestCase(unittest.TestCase):
    def test_the_lists_are_closed_and_every_name_is_valid(self):
        self.assertEqual(tl.FILTERS, ("mono", "sepia", "vintage", "cinematic", "cool", "warm", "high-contrast"))
        self.assertEqual(tl.ROTATIONS, (0, 90, 180, 270))
        for name in tl.FILTERS:
            self.assertEqual(problems_of(filter=name), [], name)
        for bad in ("noir", "", "Mono", "mono ", "mono;", "sepia\n", "high_contrast", "x" * 10_000,
                    None, True, 0, 1.5, ["mono"], {"mono": 1}):
            with self.subTest(repr(bad)[:30]):
                got = problems_of(filter=bad)
                self.assertTrue(any("filter must be one of" in p for p in got), got)
                self.assertTrue(all(len(p) < 300 for p in got))

    def test_numbers_at_both_ends_and_beyond(self):
        ranges = {"filter_strength": (0, 1), "vignette": (0, 1), "sharpen": (0, 1), "grain": (0, 1),
                  "blur": (0, tl.BLUR_MAX)}
        for key, (lo, hi) in ranges.items():
            extra = {"filter": "mono"} if key == "filter_strength" else {}
            for ok in (lo, hi, (lo + hi) / 2):
                self.assertEqual(problems_of(**{key: ok}, **extra), [], (key, ok))
            for bad in (lo - 0.001, hi + 0.001, -1, 1e9, float("nan"), float("inf"), "0.5", None, True, [0.5]):
                with self.subTest(f"{key}={bad!r}"):
                    got = problems_of(**{key: bad}, **extra)
                    self.assertTrue(any(f"{key} must be a number" in p for p in got), got)
        self.assertTrue(problems_of(blur=10 ** 400))

    def test_a_strength_needs_a_filter(self):
        got = problems_of(filter_strength=0.5)
        self.assertTrue(any("filter_strength needs a filter" in p for p in got), got)

    def test_mirror_and_turn(self):
        for k in ("flip_h", "flip_v"):
            self.assertEqual(problems_of(**{k: True}), [])
            self.assertEqual(problems_of(**{k: False}), [])
            for bad in (1, 0, "true", None, [True]):
                self.assertTrue(any(f"{k} must be true or false" in p for p in problems_of(**{k: bad})), bad)
        for ok in (0, 90, 180, 270):
            self.assertEqual(problems_of(rotate=ok), [])
        for bad in (45, 91, -90, 360, 90.5, True, "90", None, [90]):
            with self.subTest(repr(bad)):
                self.assertTrue(any("rotate must be one of" in p for p in problems_of(rotate=bad)), bad)

    def test_effects_are_for_picture_clips_and_the_shape_stays_strict(self):
        doc = vdoc()
        doc["tracks"].append({"id": "a1", "kind": "A", "clips": [
            {"id": "m1", "asset_id": ovt.SND if hasattr(ovt, "SND") else BASE, "start_s": 0, "in_s": 0,
             "out_s": 1, "blur": 3}]})
        self.assertTrue(any("blur is not a known field" in p for p in tl.validate(doc)))
        self.assertTrue(any("not a known field" in p for p in problems_of(sepia=1)))

    def test_a_whole_float_is_the_integer_in_both_validators(self):
        # JSON.parse gives the TypeScript validator 90 for both 90 and 90.0, so Python takes 90.0 as 90 too
        for ok in (90.0, 180.0, 270.0, 0.0):
            self.assertEqual(problems_of(rotate=ok), [], ok)
        n = tl.normalise(vdoc(rotate=90.0))["tracks"][0]["clips"][0]
        self.assertEqual(n["rotate"], 90)
        self.assertIsInstance(n["rotate"], int)
        self.assertNotIn("rotate", tl.normalise(vdoc(rotate=0.0))["tracks"][0]["clips"][0])

    def test_normalise_drops_every_off_value_and_keeps_the_rest(self):
        off = tl.normalise(vdoc(filter="mono", filter_strength=0, vignette=0, blur=0, sharpen=0, grain=0,
                                flip_h=False, flip_v=False, rotate=0))
        self.assertEqual(off["tracks"][0]["clips"][0], tl.normalise(vdoc())["tracks"][0]["clips"][0])
        on = tl.normalise(vdoc(filter="sepia", filter_strength=1, vignette=0.55555, blur=2.5, sharpen=0.5,
                               grain=0.25, flip_h=True, flip_v=False, rotate=270))["tracks"][0]["clips"][0]
        self.assertEqual({k: on[k] for k in tl._EFFECT_KEYS if k in on},
                         {"filter": "sepia", "vignette": 0.556, "blur": 2.5, "sharpen": 0.5, "grain": 0.25,
                          "flip_h": True, "rotate": 270})
        half = tl.normalise(vdoc(filter="warm", filter_strength=0.5))["tracks"][0]["clips"][0]
        self.assertEqual((half["filter"], half["filter_strength"]), ("warm", 0.5))

    def test_effects_survive_a_split_on_both_halves(self):
        doc = vdoc(out_s=4, filter="cool", rotate=90, vignette=0.4)
        out = tl.split_clip(doc, "c1", 2.0, "c2")
        a, b = out["tracks"][0]["clips"]
        for k in ("filter", "rotate", "vignette"):
            self.assertEqual(a[k], b[k])

    def test_the_json_schema_names_the_same_fields_and_values(self):
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        props = schema["$defs"]["video_clip"]["properties"]
        self.assertEqual(set(props), set(tl._V_CLIP_KEYS))
        self.assertEqual(props["filter"]["enum"], list(tl.FILTERS))
        self.assertEqual(props["rotate"]["enum"], list(tl.ROTATIONS))
        for k in ("filter_strength", "vignette", "sharpen", "grain"):
            self.assertEqual((props[k]["minimum"], props[k]["maximum"]), (0, 1), k)
        self.assertEqual((props["blur"]["minimum"], props["blur"]["maximum"]), (0, tl.BLUR_MAX))

    def test_the_three_languages_share_the_constants(self):
        self.assertEqual((rs.FILTERS, rs.BLUR_MAX, rs.ROTATIONS), (tl.FILTERS, tl.BLUR_MAX, tl.ROTATIONS))
        ts = EDITOR_TS.read_text(encoding="utf-8")
        names = re.search(r"export const FILTERS = \[([^\]]*)\] as const", ts).group(1)
        self.assertEqual(tuple(re.findall(r'"([\w-]+)"', names)), tl.FILTERS)
        self.assertEqual(float(re.search(r"export const BLUR_MAX = ([\d.]+);", ts).group(1)), tl.BLUR_MAX)
        rot = re.search(r"export const ROTATIONS = \[([^\]]*)\] as const", ts).group(1)
        self.assertEqual(tuple(int(x) for x in re.findall(r"\d+", rot)), tl.ROTATIONS)
        unit = re.search(r"export const UNIT_EFFECTS = \[([^\]]*)\] as const", ts).group(1)
        self.assertEqual(tuple(re.findall(r'"(\w+)"', unit)), tl.UNIT_EFFECTS)
        keys = re.search(r"const EFFECT_KEYS = \[([^\]]*)\]", ts).group(1)
        self.assertEqual(tuple(re.findall(r'"(\w+)"', keys)), tl._EFFECT_KEYS)


# ── the spec ────────────────────────────────────────────────────────────────

class SpecTestCase(unittest.TestCase):
    def test_effects_reach_the_segment_and_a_clip_without_them_has_none(self):
        seg = spec_of(vdoc(filter="warm", filter_strength=0.5, blur=2, rotate=90)).segments[0]
        self.assertEqual(seg.effects, rs.ClipEffects(filter="warm", filter_strength=0.5, blur=2.0, rotate=90))
        self.assertEqual(rs.RenderSpec.from_dict(spec_of(vdoc(grain=0.3)).to_dict()),
                         spec_of(vdoc(grain=0.3)))
        plain = spec_of(vdoc())
        self.assertIsNone(plain.segments[0].effects)
        self.assertNotIn("effects", plain.segments[0].to_dict())
        # "everything off" is the clip that never said anything
        self.assertEqual(spec_of(vdoc(filter="mono", filter_strength=0, flip_h=False, blur=0)).to_dict(),
                         plain.to_dict())

    def test_both_sides_of_a_crossfade_carry_their_own_effects(self):
        doc = {"version": 1, "width": 640, "height": 360, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0, "out_s": 2, "filter": "sepia"},
            {"id": "c2", "asset_id": BASE, "start_s": 1.5, "in_s": 0, "out_s": 2, "rotate": 180,
             "transition": {"type": "crossfade", "duration_s": 0.5}}]}]}
        blend = next(s for s in spec_of(doc).segments if s.xfade is not None)
        self.assertEqual(blend.effects.filter, "sepia")
        self.assertEqual(blend.xfade.effects.rotate, 180)

    def test_a_spec_is_refused_for_what_would_not_render(self):
        base = spec_of(vdoc())

        def problems(**fx):
            seg = rs.Segment(**{**base.segments[0].__dict__, "effects": rs.ClipEffects(**fx)})
            return rs.validate(rs.RenderSpec(**{**base.__dict__, "segments": [seg]}))
        for fx, needle in (({"filter": "noir"}, "unknown filter"), ({"filter_strength": 2.0}, "filter_strength"),
                           ({"vignette": -1.0}, "vignette"), ({"blur": 31.0}, "blur must be"),
                           ({"blur": float("nan")}, "blur must be"), ({"sharpen": float("inf")}, "sharpen"),
                           ({"grain": 1.5}, "grain"), ({"flip_h": 1}, "flip_h"), ({"rotate": 45}, "rotate"),
                           ({"rotate": True}, "rotate")):
            self.assertTrue(any(needle in p for p in problems(**fx)), (fx, problems(**fx)))
        self.assertEqual(problems(filter="vintage", rotate=270, blur=30.0), [])


# ── the argv ────────────────────────────────────────────────────────────────

def vf_of(seg, kind_index=0, **kw):
    cmds = render_backend.segment_commands("ffmpeg", seg, Path("/w/s.mp4"), kw.get("w", 1280),
                                           kw.get("h", 720), kw.get("fps", 30), frame_exact=True)
    c = cmds[kind_index]
    return c[c.index("-vf") + 1]


class CommandTestCase(unittest.TestCase):
    def seg(self, **fx):
        return rs.Segment(2.0, "/m/a.mp4", effects=rs.ClipEffects(**fx))

    def test_no_effects_is_the_chain_it_was(self):
        self.assertEqual(vf_of(rs.Segment(2.0, "/m/a.mp4")),
                         "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30")
        self.assertEqual(vf_of(self.seg()), vf_of(rs.Segment(2.0, "/m/a.mp4")))

    def test_each_look_is_pinned(self):
        pin = {
            "mono": "hue=s=0.000",
            "sepia": "colorchannelmixer=rr=0.393:rg=0.769:rb=0.189:gr=0.349:gg=0.686:gb=0.168:br=0.272:bg=0.534:bb=0.131,format=yuv420p",
            "vintage": "curves=r='0.000/0.080 0.500/0.530 1.000/0.960':g='0.000/0.050 0.500/0.480 1.000/0.900':b='0.000/0.120 0.500/0.440 1.000/0.760',format=yuv420p",
            "cinematic": "curves=r='0.000/0.000 0.300/0.220 0.700/0.780 1.000/1.000':g='0.000/0.020 0.500/0.500 1.000/0.970':b='0.000/0.060 0.300/0.360 0.700/0.620 1.000/0.900',format=yuv420p",
            "cool": "curves=r='0.000/0.000 1.000/0.880':b='0.000/0.060 1.000/1.000',format=yuv420p",
            "warm": "curves=r='0.000/0.040 1.000/1.000':b='0.000/0.000 1.000/0.860',format=yuv420p",
            "high-contrast": "curves=master='0.000/0.000 0.250/0.150 0.750/0.870 1.000/1.000',format=yuv420p",
        }
        self.assertEqual(set(pin), set(tl.FILTERS))
        for name, want in pin.items():
            self.assertEqual(render_backend.colour_filter(name, 1.0), want, name)
            self.assertIn("," + want + ",pad=", vf_of(self.seg(filter=name)), name)

    def test_strength_moves_each_control_point_part_of_the_way(self):
        self.assertEqual(render_backend.colour_filter("mono", 0.25), "hue=s=0.750")
        self.assertEqual(render_backend.colour_filter("warm", 0.5),
                         "curves=r='0.000/0.020 1.000/1.000':b='0.000/0.000 1.000/0.930',format=yuv420p")
        self.assertTrue(render_backend.colour_filter("sepia", 0.0).startswith(
            "colorchannelmixer=rr=1.000:rg=0.000:rb=0.000:gr=0.000:gg=1.000"))

    def test_texture_effects_are_pinned_and_run_in_order(self):
        vf = vf_of(self.seg(filter="mono", blur=3.0, sharpen=0.5, grain=0.4, vignette=1.0))
        self.assertEqual(vf, "scale=1280:720:force_original_aspect_ratio=decrease,hue=s=0.000,gblur=sigma=3.00,"
                             "unsharp=5:5:0.75:5:5:0,noise=alls=12:allf=t:all_seed=1234,vignette=angle=0.7000,"
                             "pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30")

    def test_the_grade_comes_before_the_look(self):
        seg = rs.Segment(2.0, "/m/a.mp4", brightness=0.1, contrast=1.2, saturation=0.8,
                         effects=rs.ClipEffects(filter="mono"))
        self.assertIn("format=yuv420p,eq=brightness=0.100:contrast=1.200:saturation=0.800,hue=s=0.000,pad=",
                      vf_of(seg))

    def test_turns_and_mirrors_run_on_the_source_before_the_fit(self):
        for fx, want in ((dict(rotate=90), "transpose=1"), (dict(rotate=270), "transpose=2"),
                         (dict(rotate=180), "hflip,vflip"), (dict(flip_h=True), "hflip"),
                         (dict(flip_v=True), "vflip"), (dict(rotate=90, flip_h=True, flip_v=True),
                                                        "transpose=1,hflip,vflip")):
            vf = vf_of(self.seg(**fx))
            self.assertTrue(vf.startswith(want + ",scale=1280:720:"), (fx, vf))
        sped = rs.Segment(2.0, "/m/a.mp4", speed=2.0, effects=rs.ClipEffects(rotate=90))
        self.assertTrue(vf_of(sped).startswith("setpts=(PTS-STARTPTS)/2.000,transpose=1,scale="))

    def test_a_still_is_turned_before_its_move_and_looked_at_after(self):
        seg = rs.Segment(2.0, "/m/p.png", kind=rs.KIND_IMAGE,
                         effects=rs.ClipEffects(filter="sepia", rotate=90, vignette=0.5))
        move = vf_of(seg, 0)
        hold = vf_of(seg, 1)
        self.assertTrue(move.startswith("transpose=1,scale="), move)
        self.assertTrue(hold.startswith("transpose=1,scale="), hold)
        for vf in (move, hold):
            self.assertIn("colorchannelmixer=", vf)
            self.assertIn("vignette=angle=", vf)

    def test_both_sides_of_a_crossfade_get_their_effects(self):
        doc = {"version": 1, "width": 640, "height": 360, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0, "out_s": 2, "filter": "sepia"},
            {"id": "c2", "asset_id": BASE, "start_s": 1.5, "in_s": 0, "out_s": 2, "rotate": 180, "blur": 4,
             "transition": {"type": "crossfade", "duration_s": 0.5}}]}]}
        cmds, _ = trt.all_commands(doc)
        graphs = [c[c.index("-filter_complex") + 1] for group in cmds[:-1] for c in group if "-filter_complex" in c]
        self.assertEqual(len(graphs), 1)
        g = graphs[0]
        self.assertIn("colorchannelmixer=", g.split(";")[0])
        self.assertNotIn("hflip", g.split(";")[0])
        self.assertIn("hflip,vflip,scale=", g.split(";")[1])
        self.assertIn("gblur=sigma=4.00", g.split(";")[1])

    def test_no_document_text_reaches_a_graph(self):
        evil = "x';drawtext=text=boom:[a]movie=/etc/passwd"
        doc = vdoc(filter="mono")
        doc["tracks"][0]["name"] = evil[:100]
        cmds, _ = trt.all_commands(doc)
        blob = json.dumps(cmds)
        self.assertNotIn("boom", blob)
        self.assertNotIn("passwd", blob)
        with self.assertRaises(ValueError):
            render_backend.colour_filter("mono;movie=/etc/passwd", 1.0)

    def test_the_effects_of_a_segment_are_inert_data_not_a_graph(self):
        bad = rs.Segment(2.0, "/m/a.mp4", effects=rs.ClipEffects(filter="mono,movie=/etc/passwd"))
        self.assertTrue(rs.validate(rs.RenderSpec("/o.mp4", 1280, 720, 30, segments=[bad], frame_exact=True)))
        with self.assertRaises(ValueError):
            vf_of(bad)


class DiskGuardTestCase(unittest.TestCase):
    """Grain makes a segment ~13x bigger than the guard's 8 MB/s assumes (measured: 42.7 MB/s at 1080p30,
    73 MB/s at 1080p60 with noise alls=15), so the guard has to charge for it."""

    def spec(self, grain=0.0, seconds=60, w=1920, h=1080):
        fx = rs.ClipEffects(grain=grain) if grain else None
        seg = rs.Segment(float(seconds), "/m/a.mp4", effects=fx)
        return rs.RenderSpec("/o.mp4", w, h, 30, segments=[seg], frame_exact=True)

    def test_a_grainy_minute_needs_twelve_times_the_room(self):
        free = lambda p: 2000.0      # a plain minute needs 480 MB; a grainy one 5760 MB
        self.assertEqual(render_backend.intermediate_x264(self.spec(), Path("/tmp"), free_mb=free),
                         render_backend.INTERMEDIATE_X264)
        with self.assertLogs("modules.render_backend", "WARNING") as logs:
            got = render_backend.intermediate_x264(self.spec(grain=0.5), Path("/tmp"), free_mb=free)
        self.assertEqual(got, render_backend.LEGACY_X264)
        self.assertIn("5760 MB", logs.output[0])

    def test_only_the_grainy_seconds_are_charged(self):
        spec = self.spec(grain=0.5, seconds=10)
        spec.segments.append(rs.Segment(50.0, "/m/b.mp4"))
        # 10 s x 12 + 50 s = 170 s x 8 MB = 1360 MB
        self.assertEqual(render_backend.intermediate_x264(spec, Path("/tmp"), free_mb=lambda p: 1400.0),
                         render_backend.INTERMEDIATE_X264)
        with self.assertLogs("modules.render_backend", "WARNING"):
            self.assertEqual(render_backend.intermediate_x264(spec, Path("/tmp"), free_mb=lambda p: 1300.0),
                             render_backend.LEGACY_X264)

    def test_a_render_without_grain_is_charged_as_before(self):
        self.assertEqual(render_backend.GRAIN_DISK_FACTOR, 12.0)
        self.assertEqual(render_backend.intermediate_x264(self.spec(seconds=195), Path("/tmp"),
                                                          free_mb=lambda p: 1600.0),
                         render_backend.INTERMEDIATE_X264)         # 195 s x 8 MB = 1560 MB


class NeutralTestCase(unittest.TestCase):
    def test_every_older_document_renders_the_commands_it_always_did(self):
        for name, doc in trt.neutral_docs().items():
            with self.subTest(name):
                self.assertEqual(trt.digest(doc), trt.LEGACY[name])

    def test_every_effect_switched_off_changes_nothing_at_all(self):
        off = {"filter": "mono", "filter_strength": 0, "vignette": 0, "blur": 0, "sharpen": 0, "grain": 0,
               "flip_h": False, "flip_v": False, "rotate": 0}
        for name, doc in trt.neutral_docs().items():
            doc2 = copy.deepcopy(doc)
            for t in doc2["tracks"]:
                if t["kind"] == "V":
                    for c in t["clips"]:
                        c.update(off)
            with self.subTest(name):
                self.assertEqual(trt.digest(doc2), trt.LEGACY[name])

    def test_an_effect_changes_only_the_video_filter_of_its_clip(self):
        doc = trt.neutral_docs()["clip and still"]
        before, _ = trt.all_commands(doc)
        doc2 = copy.deepcopy(doc)
        doc2["tracks"][0]["clips"][0]["vignette"] = 0.5
        after, _ = trt.all_commands(doc2)
        self.assertEqual(before[1:], after[1:], "the other clip and the final pass are untouched")
        (a,), (b,) = before[0], after[0]
        self.assertEqual(len(a), len(b))
        self.assertEqual(a[a.index("-vf") + 1].replace(",pad=", ",vignette=angle=0.3500,pad=", 1), b[b.index("-vf") + 1])


# ── real ffmpeg ─────────────────────────────────────────────────────────────

class _Real(ovt._Real):
    W, H = 320, 180

    def source(self, name, lavfi, seconds=2, size=None):
        path = self.dir / f"{name}.mp4"
        size = size or f"{self.W}x{self.H}"
        sep = ":" if "=" in lavfi else "="
        self.run_ffmpeg("-f", "lavfi", "-i", f"{lavfi}{sep}s={size}:r=30:d={seconds}", "-c:v", "libx264",
                        "-pix_fmt", "yuv420p", str(path))
        return tl.ResolvedAsset(BASE, "video", str(path), float(seconds), False)

    def split_source(self, name="split"):
        """Left half red, right half blue (the mirror and turn tests)."""
        path = self.dir / f"{name}.mp4"
        half = self.W // 2
        self.run_ffmpeg("-f", "lavfi", "-i", f"color=c=0xE02020:s={half}x{self.H}:r=30:d=2",
                        "-f", "lavfi", "-i", f"color=c=0x2020E0:s={half}x{self.H}:r=30:d=2",
                        "-filter_complex", "[0:v][1:v]hstack", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path))
        return tl.ResolvedAsset(BASE, "video", str(path), 2.0, False)

    def render(self, asset, **fx):
        doc = vdoc(width=self.W, height=self.H, fit="cover", **fx)
        return self.export(doc, {BASE: asset})

    def frame(self, path, n=10):
        return self.frames(path, (self.W, self.H), [n], "bt601")[n]

    def mean(self, raw, x0=0, y0=0, x1=None, y1=None):
        x1 = x1 or self.W
        y1 = y1 or self.H
        tot = [0, 0, 0]
        count = 0
        for y in range(y0, y1):
            for x in range(x0, x1):
                p = self.px(raw, self.W, x, y)
                for i in range(3):
                    tot[i] += p[i]
                count += 1
        return tuple(t / count for t in tot)

    def spread(self, raw):
        """The mean absolute step between horizontal neighbours (texture)."""
        total = 0
        for y in range(0, self.H, 3):
            row = raw[y * self.W * 3:(y + 1) * self.W * 3]
            total += sum(abs(row[i] - row[i + 3]) for i in range(0, len(row) - 3, 3))
        return total / (self.H // 3 * (self.W - 1))


class LookRenderTestCase(_Real):
    def test_each_look_does_what_its_name_says(self):
        grey = self.source("grey", "color=c=0x808080")
        plain = self.mean(self.frame(self.render(grey)))
        self.assertLess(max(abs(c - 128) for c in plain), 4)
        colour = self.source("colour", "color=c=0xC06030")
        c0 = self.mean(self.frame(self.render(colour)))
        mono = self.mean(self.frame(self.render(colour, filter="mono")))
        self.assertLess(max(mono) - min(mono), 6, f"all channels alike: {mono}")
        sepia = self.mean(self.frame(self.render(grey, filter="sepia")))
        self.assertTrue(sepia[0] > sepia[1] > sepia[2], sepia)
        warm = self.mean(self.frame(self.render(grey, filter="warm")))
        cool = self.mean(self.frame(self.render(grey, filter="cool")))
        self.assertGreater(warm[0] - warm[2], 12, warm)
        self.assertGreater(cool[2] - cool[0], 12, cool)
        vint = self.mean(self.frame(self.render(self.source("black", "color=c=0x000000"), filter="vintage")))
        self.assertGreater(min(vint), 8, f"blacks are lifted: {vint}")
        cine_dark = self.mean(self.frame(self.render(self.source("dark", "color=c=0x303030"), filter="cinematic")))
        cine_light = self.mean(self.frame(self.render(self.source("light", "color=c=0xD0D0D0"), filter="cinematic")))
        self.assertGreater(cine_dark[2], cine_dark[0] + 6, f"shadows lean teal: {cine_dark}")
        self.assertGreater(cine_light[0], cine_light[2] + 6, f"highlights lean orange: {cine_light}")
        hc_dark = self.mean(self.frame(self.render(self.source("dark2", "color=c=0x404040"), filter="high-contrast")))
        hc_light = self.mean(self.frame(self.render(self.source("light2", "color=c=0xC0C0C0"), filter="high-contrast")))
        self.assertLess(hc_dark[0], 0x40 - 8)
        self.assertGreater(hc_light[0], 0xC0 + 8)
        self.assertNotEqual(tuple(round(v) for v in c0), tuple(round(v) for v in mono))

    def test_strength_is_between_off_and_full(self):
        grey = self.source("grey", "color=c=0x808080")
        full = self.mean(self.frame(self.render(grey, filter="warm", filter_strength=1)))
        half = self.mean(self.frame(self.render(grey, filter="warm", filter_strength=0.5)))
        none = self.mean(self.frame(self.render(grey)))
        gap = lambda m: m[0] - m[2]
        self.assertLess(gap(none) + 6, gap(half))
        self.assertLess(gap(half) + 6, gap(full))
        self.assertAlmostEqual(gap(half), gap(full) / 2, delta=8)

    def test_every_look_renders_on_a_still_and_on_both_sides_of_a_blend(self):
        png = self.png("p", ovt.flat_png(64, 36, (128, 128, 128, 255)))
        grey = self.source("grey", "color=c=0x808080")
        doc = {"version": 1, "width": self.W, "height": self.H, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0, "out_s": 2, "filter": "warm"},
            {"id": "c2", "asset_id": PIC, "start_s": 1.5, "in_s": 0, "out_s": 2, "filter": "cool", "fit": "cover",
             "transition": {"type": "crossfade", "duration_s": 0.5}}]}]}
        out = self.export(doc, {BASE: grey, PIC: png})
        f = self.frames(out, (self.W, self.H), [10, 100], "bt601")
        a, b = self.mean(f[10]), self.mean(f[100])
        self.assertGreater(a[0] - a[2], 12, a)
        self.assertGreater(b[2] - b[0], 12, b)


class TextureRenderTestCase(_Real):
    def test_blur_softens_and_sharpen_crisps(self):
        tex = self.source("tex", "testsrc2")
        plain = self.spread(self.frame(self.render(tex)))
        blurred = self.spread(self.frame(self.render(tex, blur=8)))
        sharp = self.spread(self.frame(self.render(tex, sharpen=1)))
        self.assertLess(blurred, plain * 0.8)
        self.assertGreater(sharp, plain * 1.05)

    def test_a_vignette_darkens_the_corners_and_not_the_middle(self):
        grey = self.source("grey", "color=c=0x808080")
        plain = self.frame(self.render(grey))
        vig = self.frame(self.render(grey, vignette=1))
        corner = lambda raw: self.mean(raw, 0, 0, 30, 20)
        centre = lambda raw: self.mean(raw, 130, 70, 190, 110)
        self.assertLess(corner(vig)[0], corner(plain)[0] - 60)
        self.assertAlmostEqual(centre(vig)[0], centre(plain)[0], delta=6)
        half = self.frame(self.render(grey, vignette=0.5))
        self.assertTrue(corner(vig)[0] < corner(half)[0] < corner(plain)[0])

    def test_grain_adds_texture_and_repeats(self):
        grey = self.source("grey", "color=c=0x808080")
        plain = self.spread(self.frame(self.render(grey)))
        a = self.frame(self.render(grey, grain=0.8), 20)
        b = self.frame(self.render(grey, grain=0.8), 20)
        self.assertGreater(self.spread(a), plain + 4)
        self.assertEqual(a, b, "a fixed seed: the same document is the same video")
        self.assertNotEqual(self.frame(self.render(grey, grain=0.8), 20), self.frame(self.render(grey, grain=0.8), 21))


class GeometryRenderTestCase(_Real):
    def sides(self, raw):
        left = self.px(raw, self.W, 20, 90)
        right = self.px(raw, self.W, 300, 90)
        top = self.px(raw, self.W, 160, 10)
        return left, right, top

    def red(self, p):
        return p[0] > 150 and p[2] < 100

    def blue(self, p):
        return p[2] > 150 and p[0] < 100

    def test_a_mirror_swaps_left_and_right(self):
        src = self.split_source()
        plain = self.sides(self.frame(self.render(src)))
        self.assertTrue(self.red(plain[0]) and self.blue(plain[1]), plain)
        flipped = self.sides(self.frame(self.render(src, flip_h=True)))
        self.assertTrue(self.blue(flipped[0]) and self.red(flipped[1]), flipped)
        vflipped = self.sides(self.frame(self.render(src, flip_v=True)))
        self.assertTrue(self.red(vflipped[0]) and self.blue(vflipped[1]), "a top-bottom mirror leaves left-right alone")

    def test_a_quarter_turn_is_clockwise_and_refits_the_frame(self):
        # red left, blue right -> after 90 clockwise: red on top, blue at the bottom.
        src = self.split_source()
        out = self.frame(self.render(src, rotate=90))
        top, bottom = self.px(out, self.W, 160, 30), self.px(out, self.W, 160, 150)
        self.assertTrue(self.red(top) and self.blue(bottom), (top, bottom))
        out = self.frame(self.render(src, rotate=270))
        top, bottom = self.px(out, self.W, 160, 30), self.px(out, self.W, 160, 150)
        self.assertTrue(self.blue(top) and self.red(bottom), (top, bottom))
        out = self.frame(self.render(src, rotate=180))
        left, right, _ = self.sides(out)
        self.assertTrue(self.blue(left) and self.red(right), (left, right))

    def test_a_turned_clip_in_a_contain_fit_gets_bars_not_a_stretched_picture(self):
        src = self.split_source()
        doc = vdoc(width=self.W, height=self.H, rotate=90)       # fit defaults to contain
        out = self.export(doc, {BASE: src})
        raw = self.frame(out)
        # the turned picture is 180 wide x 320 tall -> shrunk to 101 x 180, centred: bars at the sides
        self.assertLess(max(self.px(raw, self.W, 10, 90)), 40, "black bar at the left")
        self.assertGreater(self.px(raw, self.W, 160, 30)[0], 150)

    def sar_of(self, path):
        import subprocess
        err = subprocess.run([self.ffmpeg, "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
        return re.search(r"SAR (\d+:\d+)", err).group(1)

    def test_a_turned_clip_comes_out_with_square_pixels(self):
        # the scaler's rounding left 405:406 (a player would stretch the picture) before setsar=1
        src = self.split_source()
        for fx in ({"rotate": 90}, {"rotate": 270}, {"rotate": 90, "fit": "cover"}, {"rotate": 180}, {}):
            out = self.export(vdoc(width=self.W, height=self.H, **fx), {BASE: src})
            self.assertEqual(self.sar_of(out), "1:1", fx)

    def test_the_sar_filter_is_only_for_a_quarter_turn(self):
        quarter = rs.Segment(2.0, "/m/a.mp4", effects=rs.ClipEffects(rotate=90))
        self.assertTrue(vf_of(quarter).endswith("pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1"))
        for fx in (rs.ClipEffects(), rs.ClipEffects(rotate=180), rs.ClipEffects(flip_h=True)):
            self.assertNotIn("setsar", vf_of(rs.Segment(2.0, "/m/a.mp4", effects=fx)))
        still = rs.Segment(2.0, "/m/p.png", kind=rs.KIND_IMAGE, effects=rs.ClipEffects(rotate=270))
        for i in (0, 1):
            self.assertIn("setsar=1", vf_of(still, i))

    def test_a_still_is_turned_too(self):
        # an image half red, half blue (left/right)
        import struct
        w, h = 64, 36
        row = bytes((224, 32, 32, 255)) * (w // 2) + bytes((32, 32, 224, 255)) * (w // 2)
        png = self.png("rb", ovt.png_rgba(w, h, lambda y: row))
        doc = {"version": 1, "width": self.W, "height": self.H, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": PIC, "start_s": 0, "in_s": 0, "out_s": 2, "fit": "cover", "flip_h": True}]}]}
        out = self.export(doc, {PIC: png})
        left, right, _ = self.sides(self.frame(out, 20))
        self.assertTrue(self.blue(left) and self.red(right), (left, right))


if __name__ == "__main__":
    unittest.main()
