"""Cross-fade styles and text looks (backend half), end to end.

Two additions to the timeline document (modules/timeline.py):

* ``transition.style`` on a ``crossfade``: one of ``XFADE_STYLES``, ffmpeg's own
  ``xfade`` transitions (the plain ``fade`` is what every older document gets);
* ``shadow``, ``box_color`` and ``box_opacity`` on a text clip: a soft drop
  shadow and a box behind the text, drawn by libass.

What is pinned here, by class:

* the document: every range at both ends and beyond, strict fields, a style
  only on a cross-fade, a closed list (no ``custom`` expression, no case or
  whitespace tricks: ``fullmatch`` semantics), huge numbers, normalisation, the
  JSON schema, and the constants the three languages share;
* the argv: a document that does not use either feature renders the SAME
  command lists, the same spec dict and the same ASS file as before — compared
  with digests captured from ``origin/main`` (7edce6bb) before this change over
  many configurations. With a style, only the ``transition=`` word of the one
  command that blends changes, and no document text reaches a filter graph;
* the PIXELS, with real ffmpeg 7.0.2 (libx264, ``xfade``, libass): every
  style renders exactly the timeline's frames, begins on the outgoing clip and
  ends on the incoming one, does what its name says in the middle (which side
  the new picture comes from, the circle, the black / white dip) and is the
  same bytes when rendered twice; every text look in samples/text_looks.json is
  drawn as the editor will say it is (colour, outline, box padding and opacity,
  shadow offset and darkness), and the box replaces the outline.

What this does NOT prove: that a browser draws the same pixels as ffmpeg (the
editor preview is an approximation of both features and says so), exact colours
(the subtitle filter converts RGB to YUV with its own matrix; colour checks have
a stated tolerance), or fonts other than the four the worker is built with.
Skipped cleanly when no ffmpeg (or no libass) runs.
"""

import copy
import dataclasses
import hashlib
import json
import math
import re
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from modules import ass_captions, render_backend
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr

ROOT = Path(__file__).resolve().parent.parent
EDITOR_TS = ROOT / "command-center" / "lib" / "editor.ts"
LOOK_TS = ROOT / "command-center" / "lib" / "editorTextLook.ts"
LOOKS = ROOT / "samples" / "text_looks.json"

BASE = "11111111-1111-4111-8111-111111111111"     # a video
PIC = "33333333-3333-4333-8333-333333333333"     # a picture
SND = "22222222-2222-4222-8222-222222222222"     # music
PIC2 = "55555555-5555-4555-8555-555555555555"
TALK = "66666666-6666-4666-8666-666666666666"    # a video with sound

STYLES = ("fade", "dissolve", "fadeblack", "fadewhite", "wipeleft", "wiperight", "slideleft",
          "slideright", "slideup", "slidedown", "circleopen", "circleclose", "radial", "zoomin")


def xf(d=0.5, style=None):
    t = {"type": "crossfade", "duration_s": d}
    if style is not None:
        t["style"] = style
    return t


def xdoc(style=None, d=0.5, width=1280, height=720, fps=30, a=BASE, b=BASE, **top):
    """Two clips of 2 s joined by a cross-fade of ``d`` seconds."""
    doc = {"version": 1, "width": width, "height": height, "fps": fps, "tracks": [
        {"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": a, "start_s": 0, "in_s": 0, "out_s": 2},
            {"id": "c2", "asset_id": b, "start_s": round(2 - d, 3), "in_s": 0, "out_s": 2,
             "transition": xf(d, style)}]}]}
    doc.update(top)
    return doc


def xdoc_style(value, **kw):
    """A cross-fade document whose style key is ALWAYS present, whatever its value (None included)."""
    doc = xdoc(**kw)
    doc["tracks"][0]["clips"][1]["transition"]["style"] = value
    return doc


def tdoc(width=1280, height=720, fps=30, **text):
    clip = {"id": "x1", "start_s": 0, "end_s": 2, "text": "Hamburg Wavy"}
    clip.update(text)
    return {"version": 1, "width": width, "height": height, "fps": fps, "tracks": [
        {"id": "v1", "kind": "V", "clips": [{"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0,
                                             "out_s": 2}]},
        {"id": "t1", "kind": "T", "clips": [clip]}]}


def problems_of(doc):
    return tl.validate(doc)


def edit_clip(doc, track, idx, **kw):
    d = copy.deepcopy(doc)
    d["tracks"][track]["clips"][idx].update(kw)
    return d


# ── the document ────────────────────────────────────────────────────────────

class StyleDocumentTestCase(unittest.TestCase):
    def test_every_style_of_the_list_is_valid_and_the_list_is_closed(self):
        self.assertEqual(tl.XFADE_STYLES, STYLES)
        for st in STYLES:
            with self.subTest(st):
                self.assertEqual(problems_of(xdoc(st)), [])
        for bad in ("custom", "spin", "", "Fade", "FADE", "fade ", " fade", "fade\n", "fade\x00",
                    "fade:duration=9", "fade;", "wipe left", "wipeleft,wiperight", "аdissolve",
                    "x" * 10_000, None, True, 0, 1, 1.5, ["fade"], {"fade": 1}, ("fade",)):
            with self.subTest(repr(bad)[:40]):
                got = problems_of(xdoc_style(bad))
                self.assertTrue(any("style must be one of" in p for p in got), got)
                self.assertTrue(all(len(p) < 400 for p in got), "the message stays short")

    def test_a_style_is_only_for_a_crossfade(self):
        self.assertEqual(problems_of(xdoc(None)), [])
        for t in ("cut", "dip_to_black"):
            doc = edit_clip(xdoc(), 0, 1, start_s=2, transition={"type": t, "duration_s": 0.5, "style": "wipeleft"})
            self.assertTrue(any("a style is only for a crossfade" in p for p in problems_of(doc)), t)
        # and the strict field list stays strict
        doc = edit_clip(xdoc(), 0, 1, transition={**xf(), "direction": "left"})
        self.assertTrue(any("direction is not a known field" in p for p in problems_of(doc)))

    def test_a_style_does_not_change_what_a_crossfade_must_satisfy(self):
        # the layout rules are the plain cross-fade's, whatever the style
        for st in ("dissolve", "circleopen"):
            doc = edit_clip(xdoc(st), 0, 1, start_s=2)     # no overlap
            self.assertTrue(any("cross-fade must start" in p for p in problems_of(doc)))
            doc = edit_clip(xdoc(st), 0, 0)
            doc["tracks"][0]["clips"][0]["transition"] = xf(0.5, st)   # nothing before the first
            self.assertTrue(any("needs a clip before it" in p for p in problems_of(doc)))
            for d in (0.19, 2.01):
                self.assertTrue(any("duration_s must be a number" in p
                                    for p in problems_of(xdoc(st, d=d))), d)

    def test_normalise_drops_the_plain_fade_and_keeps_the_rest(self):
        def style_of(doc):
            return tl.normalise(doc)["tracks"][0]["clips"][1]["transition"]
        self.assertEqual(style_of(xdoc("fade")), {"type": "crossfade", "duration_s": 0.5})
        self.assertEqual(style_of(xdoc(None)), {"type": "crossfade", "duration_s": 0.5})
        for st in STYLES[1:]:
            self.assertEqual(style_of(xdoc(st)), {"type": "crossfade", "duration_s": 0.5, "style": st})
        # a document that writes the default is the document without it
        self.assertEqual(tl.normalise(xdoc("fade")), tl.normalise(xdoc(None)))
        # the other transitions and clips are untouched
        cut = tl.normalise(xdoc())["tracks"][0]["clips"][0]["transition"]
        self.assertEqual(cut, {"type": "cut", "duration_s": 0.0})
        self.assertEqual(tl.crossfade_style(tl.normalise(xdoc("wipeleft"))["tracks"][0]["clips"][1]), "wipeleft")
        self.assertEqual(tl.crossfade_style({"transition": {"type": "dip_to_black", "duration_s": 1,
                                                            "style": "wipeleft"}}), "fade")
        self.assertEqual(tl.crossfade_style({}), "fade")

    def test_a_huge_or_odd_value_is_refused_not_raised(self):
        for bad in (10 ** 400, -(10 ** 400), 10 ** 5000, float("nan"), float("inf"), 1e308):
            for key in ("shadow", "box_opacity"):
                doc = tdoc(**{"box_color": "#112233", key: bad})
                got = problems_of(doc)
                self.assertTrue(any(f"{key} must be a number" in p for p in got), (key, bad))
                self.assertTrue(all(len(p) < 300 for p in got))
                with self.assertRaises(tl.TimelineError):
                    tl.load(doc)
            got = problems_of(xdoc_style(bad))
            self.assertTrue(any("style must be one of" in p for p in got), bad)
        with self.assertRaises(tl.TimelineError):
            tl.load(xdoc_style(10 ** 5000))

    def test_the_json_schema_names_the_same_fields_and_values(self):
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        defs = schema["$defs"]
        self.assertEqual(defs["transition"]["properties"]["style"]["enum"], list(tl.XFADE_STYLES))
        self.assertEqual(defs["transition"]["properties"]["style"]["default"], tl.XFADE_DEFAULT_STYLE)
        self.assertEqual(tuple(defs["transition"]["required"]), tl._TRANSITION_KEYS)
        self.assertEqual(set(defs["transition"]["properties"]), set(tl._TRANSITION_ALLOWED))
        props = defs["text_clip"]["properties"]
        self.assertEqual(set(props) & set(tl._TEXT_LOOK_KEYS), set(tl._TEXT_LOOK_KEYS))
        self.assertEqual((props["shadow"]["minimum"], props["shadow"]["maximum"]), (0, tl.SHADOW_MAX))
        self.assertEqual((props["box_opacity"]["minimum"], props["box_opacity"]["maximum"],
                          props["box_opacity"]["default"]), (0, 1, tl.BOX_OPACITY_DEFAULT))
        self.assertEqual(props["box_color"]["pattern"], tl._HEX_RE.pattern)
        # the captions' style does NOT take the looks
        cap = set(defs["captions"]["properties"]["style"]["properties"])
        self.assertFalse(cap & set(tl._TEXT_LOOK_KEYS))

    def test_document_and_render_spec_agree(self):
        self.assertEqual(rs.XFADE_STYLES, tl.XFADE_STYLES)
        self.assertEqual(rs.XFADE_DEFAULT_STYLE, tl.XFADE_DEFAULT_STYLE)
        self.assertEqual(rs.SHADOW_MAX, tl.SHADOW_MAX)
        self.assertEqual(rs.BOX_OPACITY_DEFAULT, tl.BOX_OPACITY_DEFAULT)
        self.assertEqual(rs.TextOverlay(0, 1, "x").box_opacity, tl.BOX_OPACITY_DEFAULT)
        # the render's own whitelist is what the backend checks against
        self.assertIs(render_backend.XFADE_STYLES, rs.XFADE_STYLES)

    def test_the_editor_module_has_the_same_constants(self):
        ts = EDITOR_TS.read_text(encoding="utf-8")
        listed = re.search(r"export const XFADE_STYLES = \[([^\]]*)\] as const", ts).group(1)
        self.assertEqual(tuple(re.findall(r'"(\w+)"', listed)), tl.XFADE_STYLES)
        self.assertIn(f'XFADE_DEFAULT_STYLE: XfadeStyle = "{tl.XFADE_DEFAULT_STYLE}"', ts)
        self.assertIn(f"export const SHADOW_MAX = {tl.SHADOW_MAX:g};", ts)
        self.assertIn(f"export const BOX_OPACITY_DEFAULT = {tl.BOX_OPACITY_DEFAULT:g};", ts)
        keys = re.search(r"const TEXT_LOOK_KEYS = \[([^\]]*)\]", ts).group(1)
        self.assertEqual(tuple(re.findall(r'"(\w+)"', keys)), tl._TEXT_LOOK_KEYS)

    def test_checking_a_hostile_document_is_cheap(self):
        # 2000 clips (the per-track cap), every cross-fade styled: validation, normalisation and
        # the layout into a spec stay linear
        clips, t = [], 0.0
        for i in range(2000):
            c = {"id": f"c{i}", "asset_id": BASE, "start_s": round(t, 3), "in_s": 0, "out_s": 1}
            if i:
                c["transition"] = xf(0.2, STYLES[i % len(STYLES)])
            clips.append(c)
            t += 0.8
        doc = {"version": 1, "width": 640, "height": 360, "fps": 30,
               "tracks": [{"id": "v1", "kind": "V", "clips": clips}]}
        t0 = time.monotonic()
        self.assertEqual(tl.validate(doc), [])
        spec = tr.to_render_spec(doc, lambda a: tl.ResolvedAsset(a, "video", "/media/v.mp4", 9.0),
                                 "/out/x.mp4")
        self.assertLess(time.monotonic() - t0, 10.0)
        styled = [s for s in spec.segments if s.xfade is not None]
        self.assertEqual(len(styled), 1999)
        self.assertEqual({s.xfade_style for s in styled}, set(STYLES))


class LookDocumentTestCase(unittest.TestCase):
    def problems(self, **text):
        return problems_of(tdoc(**text))

    def test_ranges_at_both_ends_and_beyond(self):
        for good in (0, 0.5, 6, 19.999, 20):
            self.assertEqual(self.problems(shadow=good), [], good)
        for bad in (-0.001, 20.001, -1, 21, 1000):
            self.assertTrue(any("shadow must be a number >= 0 and <= 20" in p
                                for p in self.problems(shadow=bad)), bad)
        for good in (0, 0.01, 0.7, 1):
            self.assertEqual(self.problems(box_color="#112233", box_opacity=good), [], good)
        for bad in (-0.001, 1.001, 2):
            self.assertTrue(any("box_opacity must be a number >= 0 and <= 1" in p
                                for p in self.problems(box_color="#112233", box_opacity=bad)), bad)

    def test_not_a_number_is_refused(self):
        for key in ("shadow", "box_opacity"):
            for bad in ("1", True, False, None, [1], {"v": 1}, float("nan"), float("inf")):
                self.assertTrue(self.problems(**{"box_color": "#112233", key: bad}), (key, bad))

    def test_the_colour_is_a_whole_hex_colour(self):
        for good in ("#000000", "#FFFFFF", "#abcdef", "#AbCdEf"):
            self.assertEqual(self.problems(box_color=good), [], good)
        for bad in ("000000", "#FFF", "#GGGGGG", "#1234567", "#12345", "#112233\n", " #112233",
                    "#112233 ", "red", "", None, 0, 16777215, True, ["#112233"], "#11223٣"):
            self.assertTrue(any("box_color must be a #RRGGBB colour" in p
                                for p in self.problems(box_color=bad)), repr(bad))

    def test_an_opacity_needs_a_colour(self):
        self.assertTrue(any("box_opacity needs a box_color" in p for p in self.problems(box_opacity=0.5)))

    def test_looks_are_only_on_text_clips(self):
        caps = tdoc()
        for key, val in (("shadow", 3), ("box_color", "#112233"), ("box_opacity", 0.5)):
            doc = copy.deepcopy(caps)
            doc["captions"] = {"style": {key: val}, "cues": [{"id": "q1", "start_s": 0, "end_s": 1, "text": "x"}]}
            self.assertTrue(any(f"{key} is not a known field" in p for p in problems_of(doc)), key)
        for key, val in (("shadow", 3), ("box_color", "#112233")):
            # not on the picture clips either
            doc = edit_clip(caps, 0, 0, **{key: val})
            self.assertTrue(any(f"{key} is not a known field" in p for p in problems_of(doc)), key)

    def test_normalise_keeps_a_look_and_drops_the_off_state(self):
        def clip(**kw):
            return tl.normalise(tdoc(**kw))["tracks"][1]["clips"][0]
        c = clip()
        self.assertNotIn("shadow", c)
        self.assertNotIn("box_color", c)
        self.assertNotIn("box_opacity", c)
        self.assertNotIn("shadow", clip(shadow=0))
        self.assertEqual(clip(shadow=6.0004)["shadow"], 6.0)
        c = clip(box_color="#112233")
        self.assertEqual((c["box_color"], c["box_opacity"]), ("#112233", tl.BOX_OPACITY_DEFAULT))
        c = clip(box_color="#112233", box_opacity=0.55, shadow=3)
        self.assertEqual((c["box_color"], c["box_opacity"], c["shadow"]), ("#112233", 0.55, 3))
        # the document without a look is the one it was (every default as before)
        self.assertEqual(clip(shadow=0), clip())


# ── the spec ────────────────────────────────────────────────────────────────

def assets_table(**extra):
    table = {
        BASE: tl.ResolvedAsset(BASE, "video", "/media/base.mp4", 20.0, False),
        PIC: tl.ResolvedAsset(PIC, "image", "/media/pic.png", None),
        PIC2: tl.ResolvedAsset(PIC2, "image", "/media/pic2.png", None),
        TALK: tl.ResolvedAsset(TALK, "video", "/media/talk.mp4", 20.0, True),
        SND: tl.ResolvedAsset(SND, "audio", "/media/song.mp3", 30.0),
    }
    table.update(extra)
    return table


def spec_of(doc, table=None):
    return tr.to_render_spec(doc, (table or assets_table()).get, "/out/x.mp4")


class SpecTestCase(unittest.TestCase):
    def test_the_style_reaches_the_one_segment_that_blends(self):
        spec = spec_of(xdoc("circleopen"))
        blend = [s for s in spec.segments if s.xfade is not None]
        self.assertEqual(len(blend), 1)
        self.assertEqual(blend[0].xfade_style, "circleopen")
        self.assertEqual([s.xfade_style for s in spec.segments if s.xfade is None],
                         ["fade"] * (len(spec.segments) - 1))
        # the incoming side carries no style of its own
        self.assertEqual(blend[0].xfade.xfade_style, "fade")

    def test_each_crossfade_of_a_chain_has_its_own_style(self):
        clips = [{"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0, "out_s": 2},
                 {"id": "c2", "asset_id": PIC, "start_s": 1.5, "in_s": 0, "out_s": 2,
                  "transition": xf(0.5, "slideleft")},
                 {"id": "c3", "asset_id": BASE, "start_s": 3.0, "in_s": 0, "out_s": 2,
                  "transition": xf(0.5)},
                 {"id": "c4", "asset_id": PIC2, "start_s": 4.5, "in_s": 0, "out_s": 2,
                  "transition": xf(0.5, "radial")}]
        doc = {"version": 1, "width": 1280, "height": 720, "fps": 30,
               "tracks": [{"id": "v1", "kind": "V", "clips": clips}]}
        spec = spec_of(doc)
        self.assertEqual([s.xfade_style for s in spec.segments if s.xfade is not None],
                         ["slideleft", "fade", "radial"])

    def test_the_plain_fade_is_the_segment_it_always_was(self):
        for doc in (xdoc(None), xdoc("fade")):
            blend = [s for s in spec_of(doc).segments if s.xfade is not None][0]
            self.assertNotIn("xfade_style", blend.to_dict())
        blend = [s for s in spec_of(xdoc("wiperight")).segments if s.xfade is not None][0]
        self.assertEqual(blend.to_dict()["xfade_style"], "wiperight")

    def test_the_spec_round_trips(self):
        spec = spec_of(xdoc("zoomin"))
        again = rs.RenderSpec.from_dict(json.loads(json.dumps(spec.to_dict())))
        self.assertEqual(again, spec)
        self.assertEqual(rs.RenderSpec.from_dict(spec_of(xdoc()).to_dict()), spec_of(xdoc()))

    def test_looks_become_overlay_fields_and_no_look_is_the_dict_it_was(self):
        plain = spec_of(tdoc()).overlays[0]
        for key in ("shadow", "box_color", "box_opacity"):
            self.assertNotIn(key, plain.to_dict())
        o = spec_of(tdoc(shadow=5, box_color="#abcdef", box_opacity=0.4)).overlays[0]
        self.assertEqual((o.shadow, o.box_color, o.box_opacity), (5.0, "#abcdef", 0.4))
        self.assertEqual(rs.TextOverlay.from_dict(o.to_dict()), o)
        self.assertEqual(rs.TextOverlay.from_dict(plain.to_dict()), plain)
        self.assertEqual(spec_of(tdoc(box_color="#abcdef")).overlays[0].box_opacity,
                         tl.BOX_OPACITY_DEFAULT)

    def test_a_spec_is_refused_for_what_would_not_render(self):
        spec = spec_of(xdoc("wipeleft"))
        self.assertEqual(rs.validate(spec), [])
        i = next(i for i, s in enumerate(spec.segments) if s.xfade is not None)

        def with_segment(**kw):
            segs = list(spec.segments)
            segs[i] = dataclasses.replace(segs[i], **kw)
            return dataclasses.replace(spec, segments=segs)
        for bad in ("custom", "Fade", "wipeleft;", "", None, 3):
            got = rs.validate(with_segment(xfade_style=bad))
            self.assertTrue(any("unknown cross-fade style" in p for p in got), (bad, got))
        got = rs.validate(with_segment(xfade=None))
        self.assertTrue(any("a cross-fade style but no cross-fade" in p for p in got), got)

        def with_text(**kw):
            o = dataclasses.replace(spec_of(tdoc()).overlays[0], **kw)
            return dataclasses.replace(spec_of(tdoc()), overlays=[o])
        for kw, needle in (({"shadow": -1.0}, "shadow must be"), ({"shadow": 21.0}, "shadow must be"),
                           ({"shadow": float("nan")}, "shadow must be"),
                           ({"box_color": "red"}, "box_color must be"),
                           ({"box_color": "#112233\n"}, "box_color must be"),
                           ({"box_color": "#112233", "box_opacity": 1.5}, "box_opacity must be"),
                           ({"box_opacity": float("inf")}, "box_opacity must be")):
            got = rs.validate(with_text(**kw))
            self.assertTrue(any(needle in p for p in got), (kw, got))


# ── the argv ────────────────────────────────────────────────────────────────

def all_commands(doc, table=None):
    """Every ffmpeg command a render of ``doc`` runs, in order: each segment's
    normalisation and the final pass (fixed list / ass paths)."""
    spec = spec_of(doc, table)
    cmds = []
    for i, seg in enumerate(spec.segments):
        cmds.append(render_backend.segment_commands(
            "ffmpeg", seg, Path(f"/w/seg_{i:04d}.mp4"), spec.width, spec.height, spec.fps,
            seed=seg.seed or f"{i}:{seg.path}", frame_exact=spec.frame_exact))
    cmds.append(rs.build_ffmpeg_command(spec, "/w/concat.txt", "/w/overlays.ass"))
    return cmds, spec.to_dict()


def digest(doc, table=None) -> str:
    return hashlib.sha256(json.dumps(all_commands(doc, table), sort_keys=True).encode()).hexdigest()[:16]


def ass_digest(doc, table=None) -> str:
    spec = spec_of(doc, table)
    text = ass_captions.build_overlay_ass(spec.overlays, width=spec.width, height=spec.height)
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def neutral_docs():
    """Documents that exercise the older features, with NEITHER a style NOR a
    look. The digests of their commands (and of the ASS file of their text) were
    captured from origin/main (7edce6bb) before this change (LEGACY below) —
    do not regenerate them from new code."""
    def clip(i, asset=BASE, start=0.0, out=2.0, **kw):
        return {"id": f"c{i}", "asset_id": asset, "start_s": start, "in_s": 0, "out_s": out, **kw}

    def timeline(clips, tracks=(), captions=None, **top):
        doc = {"version": 1, "width": 1280, "height": 720, "fps": 30, "tracks": [
            {"id": "v1", "kind": "V", "clips": clips}, *tracks]}
        if captions:
            doc["captions"] = captions
        doc.update(top)
        return doc

    music = {"id": "a1", "kind": "A", "clips": [
        {"id": "m1", "asset_id": SND, "start_s": 0, "in_s": 0, "out_s": 5, "gain_db": -6}]}
    ducked = {**music, "id": "a2", "duck": {"amount_db": 12}, "clips": [
        {"id": "m2", "asset_id": SND, "start_s": 1, "in_s": 0, "out_s": 5}]}
    text = {"id": "t1", "kind": "T", "clips": [
        {"id": "x1", "start_s": 0.5, "end_s": 2, "text": "Hello", "size": 64}]}
    styled = {"id": "t2", "kind": "T", "clips": [
        {"id": "x2", "start_s": 0, "end_s": 3, "text": "Line one\nLine two", "font": "Liberation Serif",
         "size": 90, "color": "#FFD400", "outline_color": "#112233", "outline_width": 6.5,
         "bold": True, "x": 0.1, "y": 0.9, "anchor": "bottom-left", "fade_in_s": 0.4, "fade_out_s": 0.4}]}
    styled2 = {"id": "t3", "kind": "T", "clips": [
        {"id": "x3", "start_s": 1, "end_s": 2, "text": "Top {tag} \\N", "size": 20, "x": 0.9,
         "y": 0.05, "anchor": "top-right", "outline_width": 0, "bold": False}]}
    cues = {"cues": [{"id": "q1", "start_s": 0, "end_s": 1.5, "text": "Caption"}]}
    cues_styled = {"style": {"size": 48, "color": "#00FF00", "y": 0.8, "outline_width": 5, "bold": False},
                   "cues": [{"id": "q1", "start_s": 0, "end_s": 1.5, "text": "Caption"},
                            {"id": "q2", "start_s": 1.5, "end_s": 2.5, "text": "More"}]}
    return {
        "one clip": timeline([clip(1)]),
        "clip and still": timeline([clip(1), clip(2, PIC, 2.0, 3.0)]),
        "cover and fades": timeline([clip(1, fit="cover", fade_in_s=0.5, fade_out_s=0.5)]),
        "speed and sound": timeline([clip(1, speed=2.0, audio=True, out=4.0)]),
        "crossfade": timeline([clip(1), clip(2, BASE, 1.5, 2.0, transition=xf())]),
        "crossfade video to still": timeline([clip(1), clip(2, PIC, 1.6, 2.0, transition=xf(0.4))]),
        "crossfade still to video graded": timeline([
            clip(1, PIC, 0, 2.0),
            clip(2, BASE, 1.5, 2.0, transition=xf(0.5),
                 grade={"brightness": 0.1, "contrast": 1.2, "saturation": 0.8})]),
        "chain of three crossfades": timeline([
            clip(1, out=2.0), clip(2, BASE, 1.5, 2.0, transition=xf(0.5)),
            clip(3, PIC, 2.8, 2.0, transition=xf(0.7)), clip(4, BASE, 4.6, 2.0, transition=xf(0.2))]),
        "crossfade with sound": timeline([clip(1, TALK, audio=True),
                                          clip(2, TALK, 1.5, 2.0, transition=xf(), audio=True)]),
        "crossfade portrait 24 fps": timeline([clip(1), clip(2, BASE, 1.0, 2.0, transition=xf(1.0))],
                                              width=1080, height=1920, fps=24),
        "dip to black": timeline([clip(1), clip(2, PIC, 2.0, 2.0,
                                               transition={"type": "dip_to_black", "duration_s": 0.6})]),
        "graded": timeline([clip(1, grade={"brightness": 0.1, "contrast": 1.2, "saturation": 0.8})]),
        "music and ducking": timeline([clip(1, audio=True)], [music, ducked]),
        "text and captions": timeline([clip(1)], [text], cues),
        "styled text": timeline([clip(1, out=3.0)], [text, styled, styled2]),
        "styled captions": timeline([clip(1, out=3.0)], [styled], cues_styled),
        "portrait 24 fps": timeline([clip(1)], [music, text], width=1080, height=1920, fps=24),
        "square 60 fps with a gap": timeline([clip(1), clip(2, PIC, 3.0, 1.0)], width=1080,
                                             height=1080, fps=60),
        "overlay and text": timeline([clip(1, out=3.0)], [text],
                                     overlays=[{"id": "o1", "asset_id": PIC2, "start_s": 0.5, "end_s": 2}]),
    }


#: sha256[:16] of json(all_commands(doc)) for neutral_docs(), captured from
#: origin/main (7edce6bb, after #456) WITHOUT this change. Do not regenerate from new code.
LEGACY = {
    "one clip": "9776f998e8de68c3",
    "clip and still": "5aa4046d3ac455ec",
    "cover and fades": "dfa5e9356666afd1",
    "speed and sound": "9da616afec6732b5",
    "crossfade": "d93e8cd3f9962064",
    "crossfade video to still": "35be661697bab518",
    "crossfade still to video graded": "2688b4c4ed0fa890",
    "chain of three crossfades": "19b45d17ae425566",
    "crossfade with sound": "a4e76238f7a6a95e",
    "crossfade portrait 24 fps": "477a7d14c884ddd5",
    "dip to black": "bd29994cfad44a32",
    "graded": "d604c9357d28a7df",
    "music and ducking": "524d2b1ab4038043",
    "text and captions": "46e99487e0cf3c4a",
    "styled text": "2081243ba6261840",
    "styled captions": "33f4ad2ac71d0aad",
    "portrait 24 fps": "f8567db7db4bd8ec",
    "square 60 fps with a gap": "fc57d4a57d07fdfe",
    "overlay and text": "b3961265f11d113c",
}
#: The same, for the ASS file the document's text is written to.
LEGACY_ASS = {
    "one clip": "e3c4bba6f3363cad",
    "clip and still": "e3c4bba6f3363cad",
    "cover and fades": "e3c4bba6f3363cad",
    "speed and sound": "e3c4bba6f3363cad",
    "crossfade": "e3c4bba6f3363cad",
    "crossfade video to still": "e3c4bba6f3363cad",
    "crossfade still to video graded": "e3c4bba6f3363cad",
    "chain of three crossfades": "e3c4bba6f3363cad",
    "crossfade with sound": "e3c4bba6f3363cad",
    "crossfade portrait 24 fps": "c7aed95030ec2b7c",
    "dip to black": "e3c4bba6f3363cad",
    "graded": "e3c4bba6f3363cad",
    "music and ducking": "e3c4bba6f3363cad",
    "text and captions": "28f9dfdffb93498f",
    "styled text": "be607726009724cd",
    "styled captions": "7ef76bbc168b3118",
    "portrait 24 fps": "b18a747372234575",
    "square 60 fps with a gap": "a3079f9a33dc9bb2",
    "overlay and text": "bdab8e37a5475b0e",
}


def _crossfade_names():
    return [n for n, d in neutral_docs().items()
            if any(c.get("transition", {}).get("type") == "crossfade"
                   for t in d["tracks"] if t["kind"] == "V" for c in t["clips"])]


class NeutralTestCase(unittest.TestCase):
    """No style, no look, no change: not by promise, by comparison."""

    def test_documents_without_either_render_the_commands_they_always_did(self):
        self.assertEqual(set(LEGACY), set(neutral_docs()))
        for name, doc in neutral_docs().items():
            with self.subTest(name):
                self.assertEqual(digest(doc), LEGACY[name])

    def test_and_write_the_ass_file_they_always_did(self):
        for name, doc in neutral_docs().items():
            with self.subTest(name):
                self.assertEqual(ass_digest(doc), LEGACY_ASS[name])

    def test_a_style_of_fade_written_out_is_main_byte_for_byte(self):
        names = _crossfade_names()
        self.assertGreaterEqual(len(names), 6)
        for name in names:
            doc = copy.deepcopy(neutral_docs()[name])
            for t in doc["tracks"]:
                for c in t["clips"]:
                    if c.get("transition", {}).get("type") == "crossfade":
                        c["transition"]["style"] = "fade"
            with self.subTest(name):
                self.assertEqual(digest(doc), LEGACY[name])

    def test_an_off_look_changes_nothing(self):
        for name, doc in neutral_docs().items():
            texts = [c for t in doc["tracks"] if t["kind"] == "T" for c in t["clips"]]
            if not texts:
                continue
            doc2 = copy.deepcopy(doc)
            for t in doc2["tracks"]:
                if t["kind"] == "T":
                    for c in t["clips"]:
                        c["shadow"] = 0
            with self.subTest(name):
                self.assertEqual(digest(doc2), LEGACY[name])
                self.assertEqual(ass_digest(doc2), LEGACY_ASS[name])

    def test_a_style_changes_only_the_word_of_the_one_command_that_blends(self):
        for name in _crossfade_names():
            plain = neutral_docs()[name]
            before, spec0 = all_commands(plain)
            for st in STYLES[1:]:
                doc = copy.deepcopy(plain)
                n = 0
                for t in doc["tracks"]:
                    for c in t["clips"]:
                        if c.get("transition", {}).get("type") == "crossfade":
                            c["transition"]["style"] = st
                            n += 1
                after, spec1 = all_commands(doc)
                with self.subTest(f"{name}: {st}"):
                    self.assertEqual(len(after), len(before))
                    changed = 0
                    for a, b in zip(after, before):
                        if a == b:
                            continue
                        changed += 1
                        # (a segment's commands, or the final pass: a list of lists / a list)
                        la = a if a and isinstance(a[0], list) else [a]
                        lb = b if b and isinstance(b[0], list) else [b]
                        self.assertEqual(len(la), len(lb))
                        for ca, cb in zip(la, lb):
                            self.assertEqual(ca, [t.replace("transition=fade:", f"transition={st}:")
                                                  for t in cb])
                    self.assertEqual(changed, n, "one segment per cross-fade, nothing else")
                    # the spec differs only by the styles
                    for s0, s1 in zip(spec0["segments"], spec1["segments"]):
                        s1 = {k: v for k, v in s1.items() if k != "xfade_style"}
                        self.assertEqual(s0, s1)
                    self.assertEqual({k: v for k, v in spec0.items() if k != "segments"},
                                     {k: v for k, v in spec1.items() if k != "segments"})

    def test_a_look_changes_only_the_style_line_of_that_text(self):
        doc = neutral_docs()["text and captions"]
        base = ass_captions.build_overlay_ass(spec_of(doc).overlays, width=1280, height=720)
        doc2 = copy.deepcopy(doc)
        doc2["tracks"][1]["clips"][0]["shadow"] = 5
        after = ass_captions.build_overlay_ass(spec_of(doc2).overlays, width=1280, height=720)
        a, b = after.splitlines(), base.splitlines()
        self.assertEqual(len(a), len(b))
        diff = [(x, y) for x, y in zip(a, b) if x != y]
        self.assertEqual(len(diff), 1)
        self.assertTrue(diff[0][0].startswith("Style: O0,"))
        # and the picture's commands are the ones they were
        self.assertEqual(all_commands(doc2)[0][:-1], all_commands(doc)[0][:-1])


class CommandTestCase(unittest.TestCase):
    def graph(self, doc):
        """The filter graph of each xfade command (the first command of the segment)."""
        out = []
        for cmds in all_commands(doc)[0][:-1]:
            for c in cmds:
                if "-filter_complex" in c and "xfade" in c[c.index("-filter_complex") + 1]:
                    out.append(c[c.index("-filter_complex") + 1])
        return out

    def test_the_name_is_in_the_graph_once_and_nothing_else_is(self):
        base = self.graph(xdoc("fade"))[0]
        for st in STYLES:
            g = self.graph(xdoc(st))[0]
            self.assertEqual(g.count("xfade=transition="), 1)
            self.assertIn(f"xfade=transition={st}:duration=", g)
            self.assertEqual(g.replace(f"transition={st}:", "transition=fade:"), base)

    def test_a_still_has_the_second_command_with_the_same_style(self):
        doc = xdoc("slideup", a=BASE, b=PIC)
        graphs = self.graph(doc)
        self.assertEqual(len(graphs), 2, "the Ken Burns move and the held fallback")
        self.assertTrue(all("transition=slideup:" in g for g in graphs))

    def test_a_segment_with_an_unknown_style_cannot_build_a_command(self):
        spec = spec_of(xdoc("wipeleft"))
        seg = next(s for s in spec.segments if s.xfade is not None)
        for bad in ("custom", "fade;color=c=red", "", "Fade", "fade\n", "wipeleft,", None):
            with self.assertRaises(ValueError):
                render_backend.segment_commands("ffmpeg", dataclasses.replace(seg, xfade_style=bad),
                                                Path("/w/s.mp4"), 1280, 720, 30, frame_exact=True)

    def test_no_document_text_reaches_the_graph(self):
        # a text, a caption and an asset path with graph punctuation everywhere
        evil = "x';drawtext=text=boom:[a]xfade=transition=custom:expr='1"
        doc = xdoc("wipeleft")
        doc["tracks"][0]["name"] = evil[:100]
        doc["tracks"].append({"id": "t1", "kind": "T", "clips": [
            {"id": "x1", "start_s": 0, "end_s": 1, "text": evil[:400], "box_color": "#112233"}]})
        doc["captions"] = {"cues": [{"id": "q1", "start_s": 0, "end_s": 1, "text": evil[:400]}]}
        table = assets_table(**{BASE: tl.ResolvedAsset(BASE, "video", "/media/a b';c,d.mp4", 20.0, False)})
        cmds, spec = all_commands(doc, table)
        blob = json.dumps(cmds)
        for g in self.graph_all(cmds):
            self.assertNotIn("drawtext", g)
            self.assertNotIn("boom", g)
            self.assertNotIn("a b", g)
            self.assertNotIn("custom", g)
        self.assertIn("transition=wipeleft:", blob)

    @staticmethod
    def graph_all(cmds):
        for group in cmds:
            for c in (group if group and isinstance(group[0], list) else [group]):
                if "-filter_complex" in c:
                    yield c[c.index("-filter_complex") + 1]
                if "-vf" in c:
                    yield c[c.index("-vf") + 1]


class AssTestCase(unittest.TestCase):
    def style_line(self, **kw):
        o = rs.TextOverlay(0, 1, "Hi", **kw)
        text = ass_captions.build_overlay_ass([o], width=1280, height=720)
        return next(l for l in text.splitlines() if l.startswith("Style: O0,")).split(",")

    # Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,
    #         Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle,
    #         Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
    BACK, BORDER, OUTLINE, SHADOW, OUTLINE_COLOUR = 6, 15, 16, 17, 5

    def test_the_default_style_line_is_the_one_it_was(self):
        f = self.style_line(size=64, outline_width=3.0)
        self.assertEqual((f[self.BACK], f[self.BORDER], f[self.OUTLINE], f[self.SHADOW]),
                         ("&H00000000", "1", "3", "0"))

    def test_a_shadow_is_the_shadow_field_and_a_sixty_percent_black(self):
        f = self.style_line(shadow=6.0)
        self.assertEqual((f[self.BACK], f[self.BORDER], f[self.SHADOW]), ("&H66000000", "1", "6"))
        self.assertEqual(self.style_line(shadow=2.5)[self.SHADOW], "2.5")
        self.assertEqual(self.style_line(shadow=0.0)[self.SHADOW], "0")
        # 0x66 of 0xFF is the 0.4 the preview's CSS says is see-through: 60 % black
        self.assertAlmostEqual(1 - 0x66 / 255, 0.6, places=2)

    def test_a_box_is_border_style_three_with_the_outline_colour_and_padding(self):
        f = self.style_line(size=60, box_color="#FF8000", box_opacity=1.0, outline_color="#00FF00",
                            outline_width=9.0)
        self.assertEqual(f[self.BORDER], "3")
        self.assertEqual(f[self.OUTLINE_COLOUR], "&H000080FF", "BGR, opaque: the box colour, not the outline's")
        self.assertEqual(f[self.OUTLINE], "15", "padding = a quarter of the size, not the outline width")
        for opacity, alpha in ((1.0, "00"), (0.7, "4D"), (0.5, "80"), (0.0, "FF"), (0.01, "FC")):
            f = self.style_line(size=60, box_color="#FF8000", box_opacity=opacity)
            self.assertEqual(f[self.OUTLINE_COLOUR], f"&H{alpha}0080FF", opacity)
        self.assertEqual(self.style_line(size=8, box_color="#000000")[self.OUTLINE], "2", "at least 2 px")
        f = self.style_line(size=60, box_color="#000000", shadow=4.0)
        self.assertEqual((f[self.BORDER], f[self.SHADOW], f[self.BACK]), ("3", "4", "&H66000000"))

    def test_numbers_are_formatted_never_pasted(self):
        text = ass_captions.build_overlay_ass(
            [rs.TextOverlay(0, 1, "Hi", size=60, shadow=1e-9, box_color="#000000", box_opacity=0.123456789)],
            width=1280, height=720)
        line = next(l for l in text.splitlines() if l.startswith("Style: O0,"))
        self.assertNotIn("e-", line.replace("e-09", "E"), line)  # 1e-09 is a legal ASS float
        self.assertRegex(line, r"&H[0-9A-F]{8}")

    def test_the_text_is_still_escaped_and_nothing_else_moved(self):
        o = rs.TextOverlay(0, 1, "a{\\b1}b", box_color="#112233", shadow=3)
        text = ass_captions.build_overlay_ass([o], width=1280, height=720)
        dialogue = next(l for l in text.splitlines() if l.startswith("Dialogue:"))
        self.assertIn("a(/b1)b", dialogue)
        self.assertEqual(dialogue.count("{"), 1, "only our own \\pos block")


# ── real ffmpeg ─────────────────────────────────────────────────────────────

def _ffmpeg():
    exe = render_backend.resolve_ffmpeg()
    try:
        ok = subprocess.run([exe, "-version"], capture_output=True).returncode == 0
    except OSError:
        return None
    return exe if ok else None


class _Real(unittest.TestCase):
    def setUp(self):
        self.ffmpeg = _ffmpeg()
        if not self.ffmpeg:
            self.skipTest("ffmpeg not available")
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.n = 0

    def tearDown(self):
        self.tmp.cleanup()

    def run_ffmpeg(self, *args):
        proc = subprocess.run([self.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *args],
                              capture_output=True)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode()[-500:])
        return proc.stdout

    def video(self, name, source, seconds=2, size="320x180", fps=30):
        """A video from a lavfi source (``color=c=...`` or ``testsrc2``)."""
        path = self.dir / f"{name}.mp4"
        sep = ":" if "=" in source else "="
        self.run_ffmpeg("-f", "lavfi", "-i", f"{source}{sep}s={size}:r={fps}:d={seconds}",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path))
        return path

    def export(self, doc, table, **kw):
        self.n += 1
        out = self.dir / f"out{self.n}.mp4"
        tr.render(doc, table.get, str(out), **kw)
        return out

    def frame_count(self, path):
        out = subprocess.run([self.ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-map", "0:v:0",
                              "-vf", "showinfo", "-f", "null", "-"], capture_output=True, text=True).stderr
        return len(re.findall(r"Parsed_showinfo_0 .*\bn:\s*\d+", out))

    def frames(self, path, size, indexes, matrix="bt601"):
        """The rgb24 bytes of the given frames, keyed by index."""
        w, h = size
        sel = "+".join(f"eq(n\\,{i})" for i in indexes)
        raw = self.run_ffmpeg("-i", str(path), "-vf",
                              f"select={sel},scale=in_color_matrix={matrix}:in_range=tv,format=rgb24",
                              "-vsync", "0", "-f", "rawvideo", "-")
        self.assertEqual(len(raw), w * h * 3 * len(indexes), "frames are missing")
        step = w * h * 3
        return {i: raw[k * step:(k + 1) * step] for k, i in enumerate(indexes)}

    @staticmethod
    def px(raw, w, x, y):
        i = (y * w + x) * 3
        return tuple(raw[i:i + 3])

    @staticmethod
    def mean_gap(a, b):
        """Mean absolute difference per byte between two frames."""
        return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


# The two flat colours of the cross-fade tests: A is red, B is blue.
A_RGB, B_RGB = "0xE02020", "0x2020E0"


def kind(px):
    """Which flat colour a pixel is: A (red), B (blue), K (black), W (white), or m (mixed)."""
    r, g, b = px
    if r < 40 and g < 40 and b < 40:
        return "K"
    if r > 215 and g > 215 and b > 215:
        return "W"
    if r > 190 and b < 70:
        return "A"
    if b > 190 and r < 70:
        return "B"
    return "m"


class StyleRenderTestCase(_Real):
    W, H = 320, 180
    FPS = 30

    def setUp(self):
        super().setUp()
        self.a = self.video("a", f"color=c={A_RGB}", 4)
        self.b = self.video("b", f"color=c={B_RGB}", 4)
        self.table = {BASE: tl.ResolvedAsset(BASE, "video", str(self.a), 4.0, False),
                      PIC: tl.ResolvedAsset(PIC, "video", str(self.b), 4.0, False)}

    def doc(self, style, d=1.0):
        return xdoc(style, d=d, width=self.W, height=self.H, a=BASE, b=PIC)

    def render(self, style, d=1.0):
        return self.export(self.doc(style, d), self.table)

    def probe(self, path, n):
        raw = self.frames(path, (self.W, self.H), [n])[n]
        W, H = self.W, self.H
        pts = {"L": (20, 90), "R": (300, 90), "T": (160, 10), "B": (160, 170), "C": (160, 90)}
        return {k: kind(self.px(raw, W, *v)) for k, v in pts.items()}, raw

    def test_every_style_renders_exactly_the_timelines_frames_from_the_old_to_the_new_picture(self):
        # 2 s + 2 s with a 1 s cross-fade: 90 frames; frames 30..59 are the blend
        for st in STYLES:
            with self.subTest(st):
                out = self.render(st)
                self.assertEqual(self.frame_count(out), 90)
                got = self.frames(out, (self.W, self.H), [0, 29, 60, 89])
                for n, want in ((0, "A"), (29, "A"), (60, "B"), (89, "B")):
                    self.assertEqual(set(kind(self.px(got[n], self.W, x, y))
                                         for x, y in ((5, 5), (160, 90), (310, 170), (310, 5))),
                                     {want}, (st, n))

    def test_the_blend_is_the_styles_own_picture(self):
        mid = {}
        for st in STYLES:
            mid[st] = self.probe(self.render(st), 45)
        by = {k: v[0] for k, v in mid.items()}
        # fade: every pixel is the same half-and-half mix
        self.assertEqual(set(by["fade"].values()), {"m"})
        raw = mid["fade"][1]
        for x, y in ((5, 5), (160, 90), (310, 170)):
            r, g, b = self.px(raw, self.W, x, y)
            self.assertTrue(abs(r - 127) < 14 and abs(b - 127) < 14, (r, g, b))
        # the dips: black, white
        for st, lo, hi in (("fadeblack", 0, 80), ("fadewhite", 170, 255)):
            for x, y in ((5, 5), (160, 90), (310, 170)):
                got = self.px(mid[st][1], self.W, x, y)
                self.assertTrue(all(lo <= c <= hi for c in got), (st, got))
        self.assertEqual(self.px(mid["fadeblack"][1], self.W, 5, 5)[:2], (0, 0))
        # wipes: the new picture arrives from the named side's opposite edge as ffmpeg draws it
        self.assertEqual((by["wipeleft"]["L"], by["wipeleft"]["R"]), ("A", "B"))
        self.assertEqual((by["wiperight"]["L"], by["wiperight"]["R"]), ("B", "A"))
        # slides carry the old picture off while the new one comes in behind it
        self.assertEqual((by["slideleft"]["L"], by["slideleft"]["R"]), ("A", "B"))
        self.assertEqual((by["slideright"]["L"], by["slideright"]["R"]), ("B", "A"))
        self.assertEqual((by["slideup"]["T"], by["slideup"]["B"]), ("A", "B"))
        self.assertEqual((by["slidedown"]["T"], by["slidedown"]["B"]), ("B", "A"))
        # circles
        self.assertEqual((by["circleopen"]["C"], by["circleopen"]["L"]), ("B", "A"))
        self.assertEqual((by["circleclose"]["C"], by["circleclose"]["L"]), ("A", "B"))
        # radial sweeps (both pictures are on screen in the middle); dissolve is a scatter
        self.assertEqual({by["radial"]["L"], by["radial"]["R"]}, {"A", "B"})
        raw = mid["dissolve"][1]
        seen = {kind(self.px(raw, self.W, x, y)) for x in range(0, 320, 7) for y in range(0, 180, 7)}
        self.assertGreaterEqual(len(seen), 2, seen)
        # zoomin leaves the old picture on screen through the first half
        self.assertEqual(set(by["zoomin"].values()), {"A"})

    def test_a_style_runs_through_the_frames_in_order(self):
        # a slide's boundary moves one way across the cross-fade, and a dip gets darker then lighter
        out = self.render("slideleft")
        edges = []
        for n in (32, 38, 45, 52, 58):
            raw = self.frames(out, (self.W, self.H), [n])[n]
            row = [kind(self.px(raw, self.W, x, 90)) for x in range(self.W)]
            edges.append(row.index("B") if "B" in row else self.W)
        self.assertEqual(edges, sorted(edges, reverse=True))
        self.assertLess(edges[-1], edges[0])
        out = self.render("fadeblack")
        lum = [sum(self.px(self.frames(out, (self.W, self.H), [n])[n], self.W, 160, 90))
               for n in (29, 31, 37, 45, 52, 59, 60)]
        self.assertGreater(lum[0], 250, "the old picture to begin with")
        self.assertGreater(lum[-1], 250, "the new picture at the end")
        self.assertLess(min(lum[2:5]), 60, "black in the middle")
        self.assertGreater(lum[1], min(lum[2:5]) + 100, "on its way down")

    def test_a_style_is_deterministic(self):
        for st in ("dissolve", "radial", "zoomin"):
            with self.subTest(st):
                first = self.frames(self.render(st), (self.W, self.H), [40, 45, 55])
                second = self.frames(self.render(st), (self.W, self.H), [40, 45, 55])
                self.assertEqual(first, second)

    def test_no_style_and_fade_are_the_same_video(self):
        a = self.frames(self.render(None), (self.W, self.H), [0, 35, 45, 55, 89])
        b = self.frames(self.render("fade"), (self.W, self.H), [0, 35, 45, 55, 89])
        self.assertEqual(a, b)

    def test_the_styles_differ_from_each_other_in_the_middle(self):
        seen = {}
        for st in STYLES:
            raw = self.frames(self.render(st), (self.W, self.H), [45])[45]
            seen[st] = hashlib.sha256(raw).hexdigest()
        self.assertEqual(len(set(seen.values())), len(STYLES), "every style is its own picture")

    def test_zoomin_moves_a_textured_picture(self):
        tex = self.video("tex", "testsrc2", 4)
        table = {BASE: tl.ResolvedAsset(BASE, "video", str(tex), 4.0, False),
                 PIC: self.table[PIC]}
        doc = xdoc("zoomin", d=1.0, width=self.W, height=self.H, a=BASE, b=PIC)
        out = self.export(doc, table)
        f = self.frames(out, (self.W, self.H), [29, 40])
        self.assertGreater(self.mean_gap(f[29], f[40]), 6, "the old picture is bigger at 40 than at 29")
        plain = self.export(xdoc("fade", d=1.0, width=self.W, height=self.H, a=BASE, b=PIC), table)
        g = self.frames(plain, (self.W, self.H), [29, 40])
        # the part before the cross-fade is the same picture (the final encode is not byte-stable)
        self.assertLess(self.mean_gap(f[29], g[29]), 2)
        self.assertGreater(self.mean_gap(f[40], g[40]), 6)

    def test_a_still_can_be_blended_in_every_style(self):
        import struct
        import zlib

        def chunk(tag, data):
            body = tag + data
            return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
        w, h = 64, 36
        raw = b"".join(b"\x00" + bytes((32, 32, 224)) * w for _ in range(h))
        png = self.dir / "b.png"
        png.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                        + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
        table = {BASE: self.table[BASE], PIC: tl.ResolvedAsset(PIC, "image", str(png))}
        for st in ("wipeleft", "circleopen", "dissolve"):
            with self.subTest(st):
                out = self.export(xdoc(st, d=1.0, width=self.W, height=self.H, a=BASE, b=PIC), table)
                self.assertEqual(self.frame_count(out), 90)
                got = self.frames(out, (self.W, self.H), [29, 60])
                self.assertEqual(kind(self.px(got[29], self.W, 160, 90)), "A")
                self.assertEqual(kind(self.px(got[60], self.W, 160, 90)), "B")

    def test_other_frame_rates_lengths_and_frames_keep_the_frame_count(self):
        for fps, d, size in ((24, 0.2, (320, 180)), (60, 2.0, (180, 320)), (25, 0.5, (240, 240))):
            w, h = size
            a = self.video(f"a{fps}", f"color=c={A_RGB}", 4, f"{w}x{h}", fps)
            b = self.video(f"b{fps}", f"color=c={B_RGB}", 4, f"{w}x{h}", fps)
            table = {BASE: tl.ResolvedAsset(BASE, "video", str(a), 4.0, False),
                     PIC: tl.ResolvedAsset(PIC, "video", str(b), 4.0, False)}
            for st in ("wiperight", "radial"):
                with self.subTest(f"{fps} fps {d} s {st}"):
                    out = self.export(xdoc(st, d=d, width=w, height=h, fps=fps, a=BASE, b=PIC), table)
                    # the timeline is 2 + 2 - d seconds; the render cuts on the frame grid
                    self.assertEqual(self.frame_count(out), round((4 - d) * fps))

    def test_the_sound_of_a_styled_crossfade_is_the_plain_crossfades(self):
        # two clips with sound: the picture's style changes nothing about the audio mix
        a = self.dir / "sa.mp4"
        self.run_ffmpeg("-f", "lavfi", "-i", f"color=c={A_RGB}:s=320x180:r=30:d=4", "-f", "lavfi",
                        "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                        "-c:a", "aac", str(a))
        table = {TALK: tl.ResolvedAsset(TALK, "video", str(a), 4.0, True)}
        outs = []
        for st in (None, "wipeleft"):
            doc = xdoc(st, d=1.0, width=320, height=180, a=TALK, b=TALK)
            for c in doc["tracks"][0]["clips"]:
                c["audio"] = True
            outs.append(self.export(doc, table))
        pcm = []
        for o in outs:
            pcm.append(self.run_ffmpeg("-i", str(o), "-vn", "-f", "s16le", "-ac", "1", "-ar", "8000", "-"))
        self.assertGreater(len(pcm[0]), 8000)
        self.assertEqual(pcm[0], pcm[1])

    def test_each_style_at_4k_60_fps_stays_cheap(self):
        # the worst frame the export allows, 2 s (the longest cross-fade): one xfade command
        # whose cost is bounded by that span. Measured on ffmpeg 7.0.2 in this suite's
        # environment: every style is within about 2.2x of the plain fade.
        import resource
        from modules import ffmpeg_limits
        spec = rs.Segment(duration=2.0, path=str(self.a), kind="video", clip_s=2.0, offset_s=0.0,
                          xfade=rs.Segment(duration=2.0, path=str(self.b), kind="video", clip_s=2.0),
                          xfade_style="radial")
        cmds = render_backend.segment_commands(self.ffmpeg, spec, self.dir / "x.mp4", 3840, 2160, 60,
                                               frame_exact=True)
        self.assertEqual(len(cmds), 1)
        self.assertIn("transition=radial:", " ".join(cmds[0]))
        t0 = time.monotonic()
        proc = subprocess.run(cmds[0], capture_output=True)
        took = time.monotonic() - t0
        self.assertEqual(proc.returncode, 0, proc.stderr.decode()[-400:])
        self.assertLess(took, 120, f"{took:.1f} s")
        self.assertEqual(self.frame_count(self.dir / "x.mp4"), 120)


# ── text looks, with libass ─────────────────────────────────────────────────

def _libass(ffmpeg):
    return ass_captions.has_libass(ffmpeg)


GREY = 128


class LookRenderTestCase(_Real):
    W, H = 1280, 720

    def setUp(self):
        super().setUp()
        if not _libass(self.ffmpeg):
            self.skipTest("this ffmpeg has no libass")
        path = self.video("grey", f"color=c=0x{GREY:02x}{GREY:02x}{GREY:02x}", 2, f"{self.W}x{self.H}")
        self.table = {BASE: tl.ResolvedAsset(BASE, "video", str(path), 2.0, False)}
        self.cache = {}

    def render(self, **fields):
        """Frame 10 of 'Hamburg Wavy' with these text fields, centred, at the middle."""
        key = json.dumps(fields, sort_keys=True)
        if key not in self.cache:
            f = {"anchor": "center", "x": 0.5, "y": 0.5, **fields}
            out = self.export(tdoc(**f), self.table)
            self.cache[key] = self.frames(out, (self.W, self.H), [10])[10]
        return self.cache[key]

    def box_of(self, raw, thr=10):
        """The bounding box (x0, y0, x1, y1 inclusive) of the pixels that are not the plain grey, and how many."""
        W, H = self.W, self.H
        x0 = y0 = 10 ** 9
        x1 = y1 = -1
        n = 0
        for y in range(H):
            row = raw[y * W * 3:(y + 1) * W * 3]
            if row.count(bytes([GREY])) == W * 3 and row == bytes([GREY]) * (W * 3):
                continue
            for x in range(W):
                r, g, b = row[x * 3], row[x * 3 + 1], row[x * 3 + 2]
                if abs(r - GREY) > thr or abs(g - GREY) > thr or abs(b - GREY) > thr:
                    n += 1
                    x0, x1 = min(x0, x), max(x1, x)
                    y0, y1 = min(y0, y), max(y1, y)
        return (x0, y0, x1, y1), n

    def close(self, got, want, tol, label=""):
        gap = max(abs(g - w) for g, w in zip(got, want))
        self.assertLessEqual(gap, tol, f"{label}: got {got}, want about {tuple(round(v) for v in want)}")

    PLAIN = dict(size=60, bold=True, color="#FFFFFF", outline_width=0)

    def test_the_text_colour_is_drawn(self):
        raw = self.render(**self.PLAIN)
        (x0, y0, x1, y1), n = self.box_of(raw)
        self.assertGreater(n, 500)
        whites = sum(1 for i in range(0, len(raw), 3) if min(raw[i:i + 3]) > 240)
        self.assertGreater(whites, 300)

    def test_an_outline_is_drawn_around_the_text_and_has_the_colour_and_width_asked(self):
        plain = self.render(**self.PLAIN)
        (a0, b0, a1, b1), _ = self.box_of(plain)
        grown = {}
        for width in (3, 6, 12):
            outlined = self.render(**{**self.PLAIN, "outline_width": width, "outline_color": "#FF0000"})
            (c0, d0, c1, d1), _ = self.box_of(outlined)
            grown[width] = min(a0 - c0, b0 - d0, c1 - a1, d1 - b1)
            self.assertGreaterEqual(grown[width], width - 1, (width, grown))
            self.assertLessEqual(max(a0 - c0, b0 - d0, c1 - a1, d1 - b1), 2 * width + 4, (width, grown))
            reds = sum(1 for i in range(0, len(outlined), 3)
                       if outlined[i] > 200 and outlined[i + 1] < 70 and outlined[i + 2] < 70)
            self.assertGreater(reds, 300 * width / 3, width)
        self.assertLess(grown[3], grown[6])
        self.assertLess(grown[6], grown[12])

    def test_a_shadow_goes_down_and_right_by_its_value_in_sixty_percent_black(self):
        for shadow in (4, 8, 16):
            with self.subTest(shadow):
                base = self.render(**self.PLAIN)
                shaded = self.render(**self.PLAIN, shadow=shadow)
                (a0, b0, a1, b1), _ = self.box_of(base)
                (c0, d0, c1, d1), _ = self.box_of(shaded)
                self.assertLessEqual(abs(a0 - c0), 1, "nothing to the left")
                self.assertLessEqual(abs(b0 - d0), 1, "nothing above")
                self.assertLessEqual(abs((c1 - a1) - shadow), 2, "right by the shadow's size")
                self.assertLessEqual(abs((d1 - b1) - shadow), 2, "down by the shadow's size")
                # the shadow's own pixels are 60 % black over the grey, and the text is on top
                dark = [raw_px for raw_px in (self.px(shaded, self.W, x, y)
                                              for y in range(d1 - 2, d1 + 1) for x in range(c0 + 10, c1 - 10))
                        if raw_px != (GREY,) * 3]
                self.assertTrue(dark)
                want = GREY * 0.4
                near = [p for p in dark if abs(p[0] - want) < 14]
                self.assertGreater(len(near), len(dark) // 3, (want, dark[:5]))
                # the text is on top of its shadow: its white is still white
                whites = [i for i in range(0, len(base), 3) if min(base[i:i + 3]) > 245]
                kept = sum(1 for i in whites if min(shaded[i:i + 3]) > 245)
                self.assertGreater(len(whites), 300)
                self.assertGreater(kept, 0.97 * len(whites), (kept, len(whites)))

    def test_a_box_replaces_the_outline_and_pads_by_a_quarter_of_the_size(self):
        for size in (40, 60, 100):
            with self.subTest(size):
                f = {**self.PLAIN, "size": size}
                text = self.render(**f)
                boxed = self.render(**{**f, "box_color": "#000000", "box_opacity": 1,
                                       "outline_width": 9, "outline_color": "#00FF00"})
                (a0, b0, a1, b1), _ = self.box_of(text)
                (c0, d0, c1, d1), _ = self.box_of(boxed)
                self.assertEqual(d1 - d0 + 1, round(size * (1 + 2 * ass_captions.BOX_PADDING)),
                                 "the box is the font size plus a quarter on each side")
                pad_x = ((a0 - c0) + (c1 - a1)) / 2 / size
                self.assertTrue(0.24 <= pad_x <= 0.34, pad_x)
                self.assertLessEqual(c0, a0)
                self.assertLessEqual(d0, b0)
                self.assertGreaterEqual(c1, a1)
                self.assertGreaterEqual(d1, b1)
                greens = sum(1 for i in range(0, len(boxed), 3)
                             if boxed[i + 1] > 200 and boxed[i] < 70 and boxed[i + 2] < 70)
                self.assertEqual(greens, 0, "the outline colour is not drawn: the box takes its place")
                # inside the padding the box is black, just outside it the picture is the grey
                self.close(self.px(boxed, self.W, c0 + 3, d0 + 3), (0, 0, 0), 4, "inside the box")
                self.close(self.px(boxed, self.W, c0 - 3, d0 - 3), (GREY,) * 3, 3, "outside it")

    def test_the_box_opacity_blends_the_colour_over_the_picture(self):
        for color, opacity in (("#000000", 0.5), ("#FFFFFF", 0.9), ("#000000", 0.7), ("#000000", 0.25)):
            with self.subTest(f"{color} at {opacity}"):
                boxed = self.render(**self.PLAIN, box_color=color, box_opacity=opacity)
                (c0, d0, c1, d1), _ = self.box_of(boxed)
                v = 0 if color == "#000000" else 255
                want = opacity * v + (1 - opacity) * GREY
                self.close(self.px(boxed, self.W, c0 + 3, d0 + 3), (want,) * 3, 6, "padding")
        # a box with no opacity given is the documented default
        boxed = self.render(**self.PLAIN, box_color="#000000")
        (c0, d0, _c1, _d1), _ = self.box_of(boxed)
        self.close(self.px(boxed, self.W, c0 + 3, d0 + 3),
                   ((1 - tl.BOX_OPACITY_DEFAULT) * GREY,) * 3, 6, "default opacity")
        # a box of opacity 0 is no box: the picture is untouched (and there is no outline either)
        clear = self.render(**self.PLAIN, box_color="#000000", box_opacity=0)
        text = self.render(**self.PLAIN)
        self.assertEqual(self.box_of(clear)[0], self.box_of(text)[0])

    def test_a_coloured_box_is_that_colour(self):
        boxed = self.render(**{**self.PLAIN, "box_color": "#FFE600", "box_opacity": 1, "color": "#111111"})
        (c0, d0, c1, d1), _ = self.box_of(boxed)
        # the subtitle filter converts RGB to YUV with its own matrix: a few levels off
        # (a few pixels in from the edge: 4:2:0 chroma is half resolution and bleeds into the grey there)
        self.close(self.px(boxed, self.W, c0 + 8, d0 + 8), (255, 230, 0), 14, "yellow")
        self.close(self.px(boxed, self.W, (c0 + c1) // 2, d0 + 8), (255, 230, 0), 14, "yellow")

    def test_a_box_holds_two_lines_and_a_shadow_follows_it(self):
        out = self.export(tdoc(**{**self.PLAIN, "anchor": "center", "x": 0.5, "y": 0.5, "text": "Line one\nLine two",
                                  "box_color": "#000000", "box_opacity": 1, "shadow": 6}), self.table)
        raw = self.frames(out, (self.W, self.H), [10])[10]
        (c0, d0, c1, d1), _ = self.box_of(raw)
        self.assertGreater(d1 - d0 + 1, 2 * 60, "two lines are in the box")
        self.assertLess(d1 - d0 + 1, 2 * 60 * 1.8 + 6 + 3)

    def test_a_look_fades_with_its_text(self):
        doc = tdoc(**self.PLAIN, anchor="center", x=0.5, y=0.5, box_color="#000000", box_opacity=1,
                   fade_in_s=1.0)
        out = self.export(doc, self.table)
        got = self.frames(out, (self.W, self.H), [0, 15, 45])
        self.assertEqual(self.box_of(got[0])[1], 0, "not there yet on the first frame")
        mid = self.box_of(got[15])[1]
        self.assertGreater(mid, 0)
        self.assertGreater(self.box_of(got[45])[1], 0)

    def test_the_text_a_look_draws_sits_where_the_clip_says(self):
        for anchor, x, y in (("bottom-left", 0.06, 0.88), ("bottom", 0.5, 0.9), ("top-right", 0.9, 0.1)):
            with self.subTest(anchor):
                raw = self.render(**self.PLAIN, anchor=anchor, x=x, y=y, box_color="#000000", box_opacity=1)
                (c0, d0, c1, d1), _ = self.box_of(raw)
                # the box hugs the anchor point (within its padding)
                px, py = x * self.W, y * self.H
                pad = 0.25 * 60 + 6
                if "left" in anchor:
                    self.assertLessEqual(abs(c0 - (px - 0)), pad + 4)
                if "right" in anchor:
                    self.assertLessEqual(abs(c1 - px), pad + 4)
                if anchor.startswith("bottom"):
                    self.assertLessEqual(abs(d1 - py), pad + 4)
                if anchor.startswith("top"):
                    self.assertLessEqual(abs(d0 - py), pad + 4)

    def test_every_look_of_the_fixture_is_valid_and_is_drawn_as_it_says(self):
        data = json.loads(LOOKS.read_text(encoding="utf-8"))
        self.assertEqual(data["draws"]["box_padding_em"], ass_captions.BOX_PADDING)
        self.assertAlmostEqual(data["draws"]["shadow_opacity"], 0.6, places=2)
        self.assertEqual(len(data["looks"]), 8)
        for look in data["looks"]:
            f = look["fields"]
            with self.subTest(look["id"]):
                self.assertEqual(problems_of(tdoc(**f)), [])
                raw = self.render(**f)
                (x0, y0, x1, y1), n = self.box_of(raw)
                self.assertGreater(n, 300, "drawn")
                # inside the frame, near where it says
                self.assertTrue(0 <= x0 and x1 < self.W and 0 <= y0 and y1 < self.H, (x0, y0, x1, y1))
                ax, ay = f["x"] * self.W, f["y"] * self.H
                self.assertTrue(x0 - 80 <= ax <= x1 + 80, (ax, x0, x1))
                self.assertTrue(y0 - 80 <= ay <= y1 + 80, (ay, y0, y1))
                # the text colour is on screen
                want = tuple(int(f["color"][i:i + 2], 16) for i in (1, 3, 5))
                hits = sum(1 for i in range(0, len(raw), 3)
                           if max(abs(raw[i + k] - want[k]) for k in range(3)) < 24)
                self.assertGreater(hits, 150, ("text colour", want))
                if "box_color" in f:
                    box = tuple(int(f["box_color"][i:i + 2], 16) for i in (1, 3, 5))
                    o = f.get("box_opacity", tl.BOX_OPACITY_DEFAULT)
                    mix = tuple(o * box[k] + (1 - o) * GREY for k in range(3))
                    self.close(self.px(raw, self.W, x0 + 7, y0 + 7), mix, 16, "box")
                    self.close(self.px(raw, self.W, x0 - 3, y0 - 3), (GREY,) * 3, 3, "outside the box")
                elif f["outline_width"] > 0:
                    black = sum(1 for i in range(0, len(raw), 3) if max(raw[i:i + 3]) < 20)
                    self.assertGreater(black, 100, "the outline")
                if f.get("shadow"):
                    no_shadow = {k: v for k, v in f.items() if k != "shadow"}
                    (a0, b0, a1, b1), _ = self.box_of(self.render(**no_shadow))
                    self.assertLessEqual(abs((x1 - a1) - f["shadow"]), 2)
                    self.assertLessEqual(abs((y1 - b1) - f["shadow"]), 2)

    def test_the_production_path_with_its_memory_limit(self):
        out = self.export(tdoc(**{**self.PLAIN, "box_color": "#112233", "shadow": 5}), self.table,
                          timeout_s=120)
        self.assertGreater(self.box_of(self.frames(out, (self.W, self.H), [10])[10])[1], 500)


class FixtureTestCase(unittest.TestCase):
    def test_the_fixture_is_valid_and_is_the_editor_table(self):
        data = json.loads(LOOKS.read_text(encoding="utf-8"))
        ids = [l["id"] for l in data["looks"]]
        self.assertEqual(len(ids), len(set(ids)))
        for look in data["looks"]:
            self.assertEqual(problems_of(tdoc(**look["fields"])), [], look["id"])
        self.assertEqual(data["frame_short_side"], 1080)
        # the editor's table is this file (the TypeScript test compares them field by field)
        self.assertEqual(sorted(re.findall(r'^    id: "(\w+)",$', LOOK_TS.read_text(encoding="utf-8"), re.M)),
                         sorted(ids))


if __name__ == "__main__":
    unittest.main()
