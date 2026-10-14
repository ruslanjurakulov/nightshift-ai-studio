"""Moves: a Ken Burns window over a clip or a still, and a two-keyframe move of
an overlay (backend half).

Fields (modules/timeline.py): a V clip's ``move: {from: {zoom?, x?, y?},
to: {...}}`` and an overlay's ``move: {to: {x?, y?, w?, opacity?}}``. By class:

* the document: both points, strict fields, ranges at both ends and beyond,
  normalisation fills the defaults, the JSON schema and the shared constants;
* the argv: documents without a move render the SAME commands as before
  (digests captured from origin/main, tests/test_editor_transitions.py LEGACY);
  an unmoving move on a video adds nothing; a still with a move uses it INSTEAD
  of the automatic one; the filter strings are pinned and no document text
  reaches a graph;
* the PIXELS, with real ffmpeg: the window is where the keyframes put it on the
  first, middle and last frame, for a video, a still and both sides of a
  cross-fade; an overlay's centre, width and opacity are where they should be at
  the start, middle and end, and a move to or from nothing is a cheap fade.

Not proven: easing (it is linear), a browser preview (there is none).
Skipped cleanly when no ffmpeg runs.
"""

import copy
import json
import re
import unittest
from pathlib import Path

from modules import render_backend
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr
from tests import test_editor_effects as fxt
from tests import test_editor_overlay as ovt
from tests import test_editor_transitions as trt

ROOT = Path(__file__).resolve().parent.parent
EDITOR_TS = ROOT / "command-center" / "lib" / "editor.ts"
BASE, PIC = ovt.BASE, ovt.PIC


def mv(z0=1, x0=0.5, y0=0.5, z1=2, x1=0.5, y1=0.5):
    return {"from": {"zoom": z0, "x": x0, "y": y0}, "to": {"zoom": z1, "x": x1, "y": y1}}


def vdoc(**clip):
    return fxt.vdoc(**clip)


def odoc(size=(640, 360), **ov):
    o = {"id": "o1", "asset_id": PIC, "start_s": 0, "end_s": 2, "x": 0.2, "y": 0.5, "w": 0.2}
    o.update(ov)
    doc = vdoc(width=size[0], height=size[1])
    doc["overlays"] = [o]
    return doc


class DocumentTestCase(unittest.TestCase):
    def test_a_clip_move_is_two_points_with_defaults(self):
        self.assertEqual(tl.validate(vdoc(move=mv())), [])
        self.assertEqual(tl.validate(vdoc(move={"from": {}, "to": {"zoom": 4}})), [])
        n = tl.normalise(vdoc(move={"from": {}, "to": {"zoom": 2.00049, "x": 0.1}}))["tracks"][0]["clips"][0]
        self.assertEqual(n["move"], {"from": {"zoom": 1.0, "x": 0.5, "y": 0.5},
                                     "to": {"zoom": 2.0, "x": 0.1, "y": 0.5}})

    def test_the_shape_is_strict(self):
        for move, needle in (({"from": {}}, "to is missing"), ({"to": {}}, "from is missing"),
                             ({"from": {}, "to": {}, "via": {}}, "via is not a known field"),
                             ({"from": {"zoom": 1, "angle": 3}, "to": {}}, "angle is not a known field"),
                             ({"from": 1, "to": {}}, "must be an object"), ([], "must be an object"),
                             (None, "must be an object")):
            got = tl.validate(vdoc(move=move))
            self.assertTrue(any(needle in p for p in got), (move, got))

    def test_zoom_and_centre_at_both_ends_and_beyond(self):
        for z in (1, 1.5, 4):
            self.assertEqual(tl.validate(vdoc(move=mv(z, z1=z))), [])
        for bad in (0.99, 4.01, 0, -1, 1e9, float("nan"), float("inf"), "2", None, True, [2]):
            self.assertTrue(any("zoom must be a number" in p for p in tl.validate(vdoc(move=mv(z1=bad)))), bad)
        for k in ("x", "y"):
            for ok in (0, 1):
                self.assertEqual(tl.validate(vdoc(move={"from": {k: ok}, "to": {}})), [])
            for bad in (-0.01, 1.01, float("nan"), "0.5", True):
                self.assertTrue(any(f"{k} must be a number" in p
                                    for p in tl.validate(vdoc(move={"from": {k: bad}, "to": {}}))), (k, bad))
        self.assertTrue(tl.validate(vdoc(move=mv(z1=10 ** 400))))

    def test_an_overlay_move_names_what_changes(self):
        self.assertEqual(tl.validate(odoc(move={"to": {"x": 0.8}})), [])
        self.assertEqual(tl.validate(odoc(move={"to": {"x": 0.8, "y": 0.1, "w": 0.5, "opacity": 0}})), [])
        for move, needle in (({"to": {}}, "give at least one"), ({}, "to is missing"),
                             ({"to": {"zoom": 2}}, "zoom is not a known field"),
                             ({"from": {"x": 1}, "to": {"x": 0.5}}, "from is not a known field"),
                             ({"to": {"x": 1.5}}, "x must be a number"), ({"to": {"w": 0.01}}, "w must be a number"),
                             ({"to": {"w": 1.01}}, "w must be a number"),
                             ({"to": {"opacity": -0.1}}, "opacity must be a number"),
                             ({"to": {"opacity": "1"}}, "opacity must be a number"), ("x", "must be an object")):
            got = tl.validate(odoc(move=move))
            self.assertTrue(any(needle in p for p in got), (move, got))
        n = tl.normalise(odoc(move={"to": {"x": 0.80001, "opacity": 0}}))["overlays"][0]
        self.assertEqual(n["move"], {"to": {"x": 0.8, "opacity": 0.0}})

    def test_a_big_zoom_is_not_offered_on_a_crossfade_in_a_frame_above_1440p(self):
        # the picture is scaled up to zoom x the frame per frame: a cross-faded 4K60 clip failed at zoom 3
        def xfade(width, height, **fx):
            doc = vdoc(width=width, height=height, fps=60)
            doc["tracks"][0]["clips"].append({"id": "c2", "asset_id": BASE, "start_s": 1.5, "in_s": 0, "out_s": 2,
                                              "transition": {"type": "crossfade", "duration_s": 0.5}, **fx})
            return doc
        self.assertEqual(tl.XFADE_LARGE_ZOOM_MAX, 2.0)
        self.assertEqual(tl.validate(xfade(3840, 2160, move=mv(1, 0.5, 0.5, 2))), [])
        got = tl.validate(xfade(3840, 2160, move=mv(1, 0.5, 0.5, 2.5)))
        self.assertTrue(any("zoom above 2" in p and "cross-faded" in p for p in got), got)
        got = tl.validate(xfade(2160, 3840, move=mv(3, 0.5, 0.5, 1)))              # the FROM end counts too
        self.assertTrue(any("zoom above 2" in p for p in got), got)
        # the earlier clip of the blend counts, 1440p is not "above", and a single clip may zoom to 4
        doc = xfade(3840, 2160)
        doc["tracks"][0]["clips"][0]["move"] = mv(1, 0.5, 0.5, 4)
        self.assertTrue(any("zoom above 2" in p for p in tl.validate(doc)))
        self.assertEqual(tl.validate(xfade(2560, 1440, move=mv(1, 0.5, 0.5, 4))), [])
        self.assertEqual(tl.validate(vdoc(width=3840, height=2160, fps=60, move=mv(1, 0.5, 0.5, 4))), [])
        # a pan at zoom 1 and a blur-free blend of a zoom to 2 are what passed the real render
        self.assertEqual(tl.validate(xfade(3840, 2160, move=mv(1, 0.3, 0.5, 1, 0.7, 0.5))), [])
        # blur and a zoom together are the combination ffmpeg 5.1.1 failed too: blur alone is refused already
        self.assertTrue(any("blur is not offered" in p for p in tl.validate(xfade(3840, 2160, blur=5, move=mv(1, 0.5, 0.5, 2)))))

    def test_only_a_few_overlays_may_ramp_between_two_visible_opacities(self):
        # geq rewrites the alpha plane per pixel (3.6x slower for one video overlay, 13x for four)
        def doc_with(n, opacity=1.0, to=0.5):
            doc = odoc()
            doc["overlays"] = [dict(doc["overlays"][0], id=f"o{i}", opacity=opacity, move={"to": {"opacity": to}})
                               for i in range(n)]
            return doc
        self.assertEqual(tl.MAX_PARTIAL_OPACITY_MOVES, 2)
        self.assertEqual(tl.validate(doc_with(2)), [])
        got = tl.validate(doc_with(3))
        self.assertTrue(any("at most 2 may change opacity" in p for p in got), got)
        # to or from nothing is a cheap fade, an unchanged opacity is nothing: neither counts
        self.assertEqual(tl.validate(doc_with(5, 1.0, 0.0)), [])
        self.assertEqual(tl.validate(doc_with(5, 0.0, 1.0)), [])
        self.assertEqual(tl.validate(doc_with(5, 0.7, 0.7)), [])
        self.assertEqual(tl.validate(doc_with(5, 1.0, 1.0)), [])

    def test_a_split_carries_the_move_across_the_cut(self):
        out = tl.split_clip(vdoc(out_s=4, move=mv(1, 0.5, 0.5, 3, 0.1, 0.9)), "c1", 1.0, "c2")
        a, b = out["tracks"][0]["clips"]
        mid = {"zoom": 1.5, "x": 0.4, "y": 0.6}
        self.assertEqual(a["move"], {"from": {"zoom": 1, "x": 0.5, "y": 0.5}, "to": mid})
        self.assertEqual(b["move"], {"from": mid, "to": {"zoom": 3, "x": 0.1, "y": 0.9}})

    def test_the_json_schema_and_constants(self):
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        defs = schema["$defs"]
        self.assertIn("move", defs["video_clip"]["properties"])
        self.assertIn("move", defs["overlay"]["properties"])
        self.assertEqual(set(defs["video_clip"]["properties"]), set(tl._V_CLIP_KEYS))
        self.assertEqual(set(defs["overlay"]["properties"]), set(tl._OVERLAY_KEYS))
        zoom = defs["move_point"]["properties"]["zoom"]
        self.assertEqual((zoom["minimum"], zoom["maximum"], zoom["default"]),
                         (tl.MOVE_ZOOM_MIN, tl.MOVE_ZOOM_MAX, 1.0))
        self.assertEqual((rs.MOVE_ZOOM_MIN, rs.MOVE_ZOOM_MAX), (tl.MOVE_ZOOM_MIN, tl.MOVE_ZOOM_MAX))
        ts = EDITOR_TS.read_text(encoding="utf-8")
        self.assertEqual(float(re.search(r"export const MOVE_ZOOM_MIN = ([\d.]+);", ts).group(1)), tl.MOVE_ZOOM_MIN)
        self.assertEqual(float(re.search(r"export const MOVE_ZOOM_MAX = ([\d.]+);", ts).group(1)), tl.MOVE_ZOOM_MAX)
        for name in ("XFADE_LARGE_ZOOM_MAX", "MAX_PARTIAL_OPACITY_MOVES"):
            self.assertEqual(float(re.search(rf"export const {name} = ([\d.]+);", ts).group(1)), getattr(tl, name), name)


class SpecTestCase(unittest.TestCase):
    def test_a_move_reaches_the_segment_and_an_overlay_end_state_the_overlay(self):
        seg = fxt.spec_of(vdoc(move=mv(1, 0.5, 0.5, 2, 0.25, 0.75))).segments[0]
        self.assertEqual(seg.move, rs.ClipMove(1.0, 0.5, 0.5, 2.0, 0.25, 0.75))
        spec = fxt.spec_of(odoc(move={"to": {"x": 0.8, "opacity": 0.4}}))
        o = spec.picture_overlays[0]
        self.assertEqual((o.to_x, o.to_y, o.to_w, o.to_opacity), (0.8, None, None, 0.4))
        self.assertEqual(rs.RenderSpec.from_dict(spec.to_dict()), spec)
        plain = fxt.spec_of(vdoc())
        self.assertIsNone(plain.segments[0].move)
        self.assertNotIn("move", plain.segments[0].to_dict())
        self.assertNotIn("to_x", fxt.spec_of(odoc()).picture_overlays[0].to_dict())

    def test_an_overlay_that_fades_in_from_nothing_is_still_rendered(self):
        spec = fxt.spec_of(odoc(opacity=0, move={"to": {"opacity": 1}}))
        self.assertEqual(len(spec.picture_overlays), 1)
        self.assertEqual(len(fxt.spec_of(odoc(opacity=0)).picture_overlays), 0)
        self.assertEqual(len(fxt.spec_of(odoc(opacity=0, move={"to": {"x": 0.9}})).picture_overlays), 0)

    def test_a_spec_is_refused_for_what_would_not_render(self):
        base = fxt.spec_of(vdoc(move=mv()))

        def with_move(**kw):
            m = rs.ClipMove(**{**base.segments[0].move.__dict__, **kw})
            seg = rs.Segment(**{**base.segments[0].__dict__, "move": m})
            return rs.validate(rs.RenderSpec(**{**base.__dict__, "segments": [seg]}))
        for kw, needle in (({"to_zoom": 5.0}, "zoom must be"), ({"from_zoom": 0.5}, "zoom must be"),
                           ({"to_x": 1.5}, "centre must be"), ({"from_y": float("nan")}, "centre must be")):
            self.assertTrue(any(needle in p for p in with_move(**kw)), kw)
        self.assertEqual(with_move(to_zoom=4.0), [])
        loose = rs.RenderSpec(**{**base.__dict__, "frame_exact": False})
        self.assertTrue(any("needs frame_exact" in p for p in rs.validate(loose)))
        pic = fxt.spec_of(odoc(move={"to": {"x": 0.8}}))

        def with_pic(**kw):
            o = rs.PictureOverlay(**{**pic.picture_overlays[0].__dict__, **kw})
            return rs.validate(rs.RenderSpec(**{**pic.__dict__, "picture_overlays": [o]}))
        for kw in ({"to_x": 2.0}, {"to_w": 0.01}, {"to_opacity": -1.0}, {"to_y": float("nan")}):
            self.assertTrue(any("must be from" in p or "non-finite" in p for p in with_pic(**kw)), kw)


class CommandTestCase(unittest.TestCase):
    def test_the_filter_is_pinned(self):
        got = render_backend.move_filter(rs.ClipMove(1, 0.5, 0.5, 2, 0.25, 0.5), 1280, 720, 60)
        z = "(1.0000+(1.0000)*min(1,n/59))"
        self.assertEqual(got, f",scale=w='trunc(1280*{z}/2)*2':h='trunc(720*{z}/2)*2':eval=frame:flags=bicubic,"
                              f"crop=1280:720:x='clip((0.5000+(-0.2500)*min(1,n/59)),0.5/{z},1-0.5/{z})*iw-ow/2':"
                              f"y='clip(0.5000,0.5/{z},1-0.5/{z})*ih-oh/2'")
        pan = render_backend.move_filter(rs.ClipMove(1.5, 0.3, 0.5, 1.5, 0.7, 0.5), 640, 360, 31)
        self.assertIn("eval=init", pan, "a pan only is scaled once")
        self.assertIn("min(1,n/30)", pan)
        self.assertEqual(render_backend.move_filter(rs.ClipMove(), 1280, 720, 60), "")
        self.assertEqual(render_backend.move_filter(rs.ClipMove(1, 0.2, 0.5, 1, 0.8, 0.5), 640, 360, 10) != "", True)
        # a single frame cannot divide by zero
        self.assertIn("n/1)", render_backend.move_filter(rs.ClipMove(1, 0.5, 0.5, 2, 0.5, 0.5), 640, 360, 1))

    def test_a_video_move_goes_after_the_fit_and_before_the_fades(self):
        seg = rs.Segment(2.0, "/m/a.mp4", fade_in_s=0.5, move=rs.ClipMove(1, 0.5, 0.5, 2, 0.5, 0.5))
        vf = fxt.vf_of(seg)
        self.assertRegex(vf, r"pad=1280:720:\(ow-iw\)/2:\(oh-ih\)/2,fps=30,scale=w='trunc.*crop=1280:720.*,fade=t=in")
        plain = fxt.vf_of(rs.Segment(2.0, "/m/a.mp4", fade_in_s=0.5))
        self.assertEqual(fxt.vf_of(rs.Segment(2.0, "/m/a.mp4", fade_in_s=0.5, move=rs.ClipMove())), plain,
                         "a video move that does not move is the clip it was")

    def test_a_still_with_a_move_has_it_instead_of_the_automatic_one(self):
        auto = rs.Segment(2.0, "/m/p.png", kind=rs.KIND_IMAGE)
        mine = rs.Segment(2.0, "/m/p.png", kind=rs.KIND_IMAGE, move=rs.ClipMove(1, 0.5, 0.5, 2, 0.5, 0.5))
        auto_cmds = render_backend.segment_commands("ffmpeg", auto, Path("/w/s.mp4"), 1280, 720, 30,
                                                    seed="x", frame_exact=True)
        cmds = render_backend.segment_commands("ffmpeg", mine, Path("/w/s.mp4"), 1280, 720, 30,
                                               seed="x", frame_exact=True)
        self.assertEqual(len(cmds), 2, "the move and the plain hold to fall back on")
        self.assertNotIn("zoompan", " ".join(cmds[0]))
        self.assertIn("crop=1280:720", cmds[0][cmds[0].index("-vf") + 1])
        self.assertIn("zoompan", " ".join(auto_cmds[0]))
        self.assertEqual(cmds[1][cmds[1].index("-vf") + 1], auto_cmds[1][auto_cmds[1].index("-vf") + 1])
        still = rs.Segment(2.0, "/m/p.png", kind=rs.KIND_IMAGE, move=rs.ClipMove())
        held = render_backend.segment_commands("ffmpeg", still, Path("/w/s.mp4"), 1280, 720, 30,
                                               seed="x", frame_exact=True)
        self.assertNotIn("zoompan", " ".join(held[0]), "an unmoving move is a still that does not move")
        self.assertNotIn("scale=w=", " ".join(held[0]))

    def test_both_sides_of_a_crossfade_move_over_their_whole_clip(self):
        doc = {"version": 1, "width": 640, "height": 360, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0, "out_s": 2, "move": mv(1, z1=2)},
            {"id": "c2", "asset_id": BASE, "start_s": 1.5, "in_s": 0, "out_s": 2, "move": mv(2, z1=1),
             "transition": {"type": "crossfade", "duration_s": 0.5}}]}]}
        cmds, _ = trt.all_commands(doc)
        graphs = [c[c.index("-filter_complex") + 1] for group in cmds[:-1] for c in group if "-filter_complex" in c]
        self.assertEqual(len(graphs), 1)
        a, b = graphs[0].split(";")[:2]
        self.assertIn("min(1,n/59)", a)    # the first clip is 60 frames long, all of it, not its 15-frame tail
        self.assertIn("min(1,n/59)", b)
        self.assertNotIn("zoompan", graphs[0])

    def test_the_overlay_filters_are_pinned(self):
        def graph(**kw):
            o = rs.PictureOverlay("/m/p.png", "image", 1.0, 3.0, 0.2, 0.5, 0.2, 1.0, **kw)
            spec = rs.RenderSpec("/o.mp4", 1280, 720, 30, segments=[rs.Segment(4, "/m/b.mp4")],
                                 frame_exact=True, picture_overlays=[o])
            return rs.picture_overlay_filters(spec, 1, "[0:v]")[0]
        span = "clip((t-1.000)/2.000,0,1)"
        g = graph(to_x=0.8, to_y=0.3)
        self.assertIn(f"x='round(256.000+(768.000)*{span}-w/2)'", g[1])
        self.assertIn(f"y='round(360.000+(-144.000)*{span}-h/2)'", g[1])
        g = graph(to_w=0.4)
        self.assertIn("scale=512:1440", g[0], "the picture is made at the widest it will be")
        self.assertIn(f"scale=w='max(2,trunc(iw*((0.2000+(0.2000)*{span})/0.4000)/2)*2)'", g[0])
        g = graph(to_w=0.1)
        self.assertIn("scale=256:1440", g[0])
        self.assertIn("/0.2000)", g[0])
        g = graph(to_opacity=0.0)
        self.assertIn(",fade=t=out:st=1.000:d=2.000:alpha=1", g[0])
        g = graph(to_opacity=0.5)
        self.assertIn("geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*(1.0000+(-0.5000)*"
                      "clip((T-1.000)/2.000,0,1))'", g[0])
        zero = rs.PictureOverlay("/m/p.png", "image", 1.0, 3.0, 0.2, 0.5, 0.2, 0.0, to_opacity=0.5)
        spec = rs.RenderSpec("/o.mp4", 1280, 720, 30, segments=[rs.Segment(4, "/m/b.mp4")],
                             frame_exact=True, picture_overlays=[zero])
        gz = rs.picture_overlay_filters(spec, 1, "[0:v]")[0]
        self.assertIn("aa=0.500", gz[0])
        self.assertIn(",fade=t=in:st=1.000:d=2.000:alpha=1", gz[0])

    def test_a_move_adds_to_an_animation(self):
        o = rs.PictureOverlay("/m/p.png", "image", 1.0, 3.0, 0.2, 0.5, 0.2, 1.0, anim_in="slide-up",
                              anim_in_s=0.5, to_x=0.8)
        spec = rs.RenderSpec("/o.mp4", 1280, 720, 30, segments=[rs.Segment(4, "/m/b.mp4")],
                             frame_exact=True, picture_overlays=[o])
        g = rs.picture_overlay_filters(spec, 1, "[0:v]")[0][1]
        self.assertIn("x='round(256.000+(768.000)*clip((t-1.000)/2.000,0,1)-w/2)'", g)
        self.assertIn("y='round(360.000-(-108.000)*(1-clip((t-1.000)/0.500,0,1))-h/2)'", g)


class NeutralTestCase(unittest.TestCase):
    def test_every_older_document_renders_the_commands_it_always_did(self):
        for name, doc in trt.neutral_docs().items():
            with self.subTest(name):
                self.assertEqual(trt.digest(doc), trt.LEGACY[name])

    def test_a_move_changes_only_its_own_clips_command(self):
        doc = trt.neutral_docs()["clip and still"]
        before, _ = trt.all_commands(doc)
        doc2 = copy.deepcopy(doc)
        doc2["tracks"][0]["clips"][0]["move"] = mv()
        after, _ = trt.all_commands(doc2)
        self.assertNotEqual(before[0], after[0])
        self.assertEqual(before[1:], after[1:])


# ── real ffmpeg ─────────────────────────────────────────────────────────────

class MoveRenderTestCase(fxt._Real):
    def red(self, p):
        return p[0] > 150 and p[2] < 100

    def blue(self, p):
        return p[2] > 150 and p[0] < 100

    def row_kinds(self, raw, y=90, step=20):
        return "".join("R" if self.red(self.px(raw, self.W, x, y)) else "B" if self.blue(self.px(raw, self.W, x, y))
                       else "." for x in range(5, self.W, step))

    def test_a_zoom_into_the_left_third_ends_on_red_only(self):
        src = self.split_source()
        doc = vdoc(width=self.W, height=self.H, fit="cover", move=mv(1, 0.5, 0.5, 2, 0.25, 0.5))
        out = self.export(doc, {BASE: src})
        f = self.frames(out, (self.W, self.H), [0, 29, 59], "bt601")
        first, mid, last = (self.row_kinds(f[n]) for n in (0, 29, 59))
        self.assertTrue("R" in first and "B" in first, first)
        self.assertEqual(first.index("B"), len(first) // 2)
        self.assertTrue("R" in mid and "B" in mid, mid)
        self.assertGreater(mid.index("B"), first.index("B"), "the boundary moves right, out of the narrowing window")
        self.assertNotIn("B", last[:-1], "the last frame is the window on the left quarter: red")

    def test_the_centre_is_held_inside_the_picture(self):
        src = self.split_source()
        # a window of half the picture centred at 0.05 cannot go past the left edge
        doc = vdoc(width=self.W, height=self.H, fit="cover", move=mv(2, 0.05, 0.5, 2, 0.05, 0.5))
        out = self.export(doc, {BASE: src})
        raw = self.frames(out, (self.W, self.H), [10], "bt601")[10]
        self.assertNotIn("B", self.row_kinds(raw)[:-1])
        doc = vdoc(width=self.W, height=self.H, fit="cover", move=mv(2, 0.95, 0.5, 2, 0.95, 0.5))
        raw = self.frames(self.export(doc, {BASE: src}), (self.W, self.H), [10], "bt601")[10]
        self.assertNotIn("R", self.row_kinds(raw)[1:])

    def test_a_pan_at_a_fixed_zoom_moves_the_window_and_keeps_the_size(self):
        src = self.split_source()
        doc = vdoc(width=self.W, height=self.H, fit="cover", move=mv(2, 0.25, 0.5, 2, 0.75, 0.5))
        out = self.export(doc, {BASE: src})
        f = self.frames(out, (self.W, self.H), [0, 59], "bt601")
        self.assertNotIn("B", self.row_kinds(f[0])[:-1])
        self.assertNotIn("R", self.row_kinds(f[59])[1:])
        self.assertEqual(self.frame_count_of(out), 60)

    def frame_count_of(self, path):
        import subprocess
        out = subprocess.run([self.ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-map", "0:v:0",
                              "-vf", "showinfo", "-f", "null", "-"], capture_output=True, text=True).stderr
        return len(re.findall(r"Parsed_showinfo_0 .*\bn:\s*\d+", out))

    def test_a_still_takes_the_documents_move_and_an_unmoving_move_holds_it(self):
        row = bytes((224, 32, 32, 255)) * 32 + bytes((32, 32, 224, 255)) * 32
        png = self.png("rb", ovt.png_rgba(64, 36, lambda y: row))
        asset = {PIC: png}

        def doc(move):
            return {"version": 1, "width": self.W, "height": self.H, "fps": 30, "tracks": [
                {"id": "v1", "kind": "V", "clips": [{"id": "c1", "asset_id": PIC, "start_s": 0, "in_s": 0,
                                                     "out_s": 2, "fit": "cover", "move": move}]}]}
        out = self.export(doc(mv(1, 0.5, 0.5, 2, 0.25, 0.5)), asset)
        f = self.frames(out, (self.W, self.H), [0, 59], "bt601")
        self.assertIn("B", self.row_kinds(f[0]))
        self.assertNotIn("B", self.row_kinds(f[59])[:-1])
        held = self.export(doc(mv(1, 0.5, 0.5, 1, 0.5, 0.5)), asset)
        g = self.frames(held, (self.W, self.H), [0, 59], "bt601")
        self.assert_same(g[0], g[59], (self.W, self.H), "a still that does not move", thr=6)

    def test_both_sides_of_a_crossfade_keep_moving_through_it(self):
        src = self.split_source()
        doc = {"version": 1, "width": self.W, "height": self.H, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0, "out_s": 2, "fit": "cover",
             "move": mv(1, 0.5, 0.5, 2, 0.25, 0.5)},
            {"id": "c2", "asset_id": BASE, "start_s": 1.5, "in_s": 0, "out_s": 2, "fit": "cover",
             "transition": {"type": "crossfade", "duration_s": 0.5}}]}]}
        out = self.export(doc, {BASE: src})
        self.assertEqual(self.frame_count_of(out), 105)
        f = self.frames(out, (self.W, self.H), [0, 44, 46, 104], "bt601")
        self.assertIn("B", self.row_kinds(f[0]))
        self.assertLess(self.row_kinds(f[44]).count("B"), self.row_kinds(f[0]).count("B"),
                        "deep in the zoom just before the blend, the blue half has mostly left the window")
        # in the blend, the old clip (zoomed in, all red) fades into the new one (red | blue)
        self.assertIn("B", self.row_kinds(f[104]))


class OverlayRenderTestCase(fxt._Real):
    def setUp(self):
        super().setUp()
        self.pic = self.png("p", ovt.flat_png(100, 50, (255, 0, 0, 255)))
        self.grey = self.source("g", "color=c=0x808080")

    def render(self, **ov):
        return self.export(odoc((self.W, self.H), **ov), {BASE: self.grey, PIC: self.pic})

    def box(self, raw):
        xs = [x for x in range(self.W) if self.px(raw, self.W, x, 90)[0] > self.px(raw, self.W, x, 90)[1] + 25]
        ys = [y for y in range(self.H) if self.px(raw, self.W, 160, y)[0] > self.px(raw, self.W, 160, y)[1] + 25]
        return (min(xs), max(xs)) if xs else None

    def test_the_centre_and_width_go_from_the_overlays_values_to_the_end_keyframe(self):
        # 320 x 180 frame, overlay 0.2 wide (64 px) at x 0.2 -> 0.4 wide (128 px) at x 0.8
        out = self.render(move={"to": {"x": 0.8, "w": 0.4}})
        f = self.frames(out, (self.W, self.H), [0, 30, 59], "bt601")
        b0, b1, b2 = (self.box(f[n]) for n in (0, 30, 59))
        centre = lambda b: (b[0] + b[1]) / 2
        width = lambda b: b[1] - b[0] + 1
        self.assertAlmostEqual(centre(b0), 64, delta=3)
        self.assertAlmostEqual(width(b0), 64, delta=3)
        self.assertAlmostEqual(centre(b2), 256, delta=12)   # the overlay is 128 wide there, its centre at 0.8
        self.assertAlmostEqual(width(b2), 128 * 0.99, delta=6)
        self.assertAlmostEqual(centre(b1), 64 + (256 - 64) * 30 / 59, delta=6)
        self.assertAlmostEqual(width(b1), 64 + 64 * 30 / 59, delta=6)

    def test_opacity_goes_linearly_between_two_values_and_a_move_to_nothing_is_a_fade(self):
        mid = lambda raw: self.px(raw, self.W, 64, 90)
        out = self.render(opacity=1.0, move={"to": {"opacity": 0.4}})
        f = self.frames(out, (self.W, self.H), [0, 30, 59], "bt601")
        r = [mid(f[n])[0] for n in (0, 30, 59)]
        want = lambda a: 128 + a * (255 - 128)
        self.assertAlmostEqual(r[0], want(1.0), delta=8)
        self.assertAlmostEqual(r[1], want(0.7), delta=10)
        self.assertAlmostEqual(r[2], want(0.4), delta=10)
        out = self.render(opacity=0.8, move={"to": {"opacity": 0}})
        f = self.frames(out, (self.W, self.H), [0, 30, 58], "bt601")
        r = [mid(f[n])[0] for n in (0, 30, 58)]
        self.assertAlmostEqual(r[0], want(0.8), delta=8)
        self.assertTrue(r[0] > r[1] > r[2], r)
        self.assertLess(r[2], 140)
        out = self.render(opacity=0, move={"to": {"opacity": 1.0}})
        f = self.frames(out, (self.W, self.H), [1, 30, 59], "bt601")
        r = [mid(f[n])[0] for n in (1, 30, 59)]
        self.assertTrue(r[0] < r[1] < r[2], r)
        self.assertGreater(r[2], 230)

    def test_a_move_and_an_animation_work_together(self):
        out = self.render(move={"to": {"x": 0.8}}, anim_in="fade", anim_in_s=0.5)
        f = self.frames(out, (self.W, self.H), [3, 59], "bt601")
        self.assertIsNotNone(self.box(f[59]))
        self.assertLess(self.px(f[3], self.W, 70, 90)[0], 160, "still faint in the first frames")


if __name__ == "__main__":
    unittest.main()
