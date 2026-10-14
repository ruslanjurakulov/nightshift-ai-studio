"""Entrance and exit animations of texts and overlays (backend half).

Fields (modules/timeline.py): ``anim_in`` / ``anim_out`` and ``anim_in_s`` /
``anim_out_s`` on a text clip and on an overlay. What is pinned, by class:

* the document: closed lists (typewriter only for a text's entrance), ranges at
  both ends and beyond, a duration needs its animation, in + out fit in the
  time the item is shown, an animation and the plain fade of the same side are
  refused rather than guessed, the typewriter cap, normalisation, the JSON
  schema and the constants the three languages share;
* the argv / ASS: a document without the fields renders the SAME commands and
  the SAME ASS file as before (digests captured from origin/main before the
  feature, tests/test_editor_transitions.py LEGACY / LEGACY_ASS, are checked
  here too); with them, the exact ASS events and overlay filter strings are
  pinned, and no document text reaches a filter graph;
* the PIXELS, with real ffmpeg + libass: overlay fades, slides and pops are
  measured frame by frame, a text's fade, slide, pop and typewriter likewise.
  Skipped cleanly when no ffmpeg runs.

Not proven: that a browser preview moves the same way (there is none yet; the
editor UI will say so), exact easing (all linear), fonts other than the four.
"""

import copy
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from modules import ass_captions, render_backend
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr
from tests import test_editor_overlay as ovt
from tests import test_editor_transitions as trt

ROOT = Path(__file__).resolve().parent.parent
EDITOR_TS = ROOT / "command-center" / "lib" / "editor.ts"

BASE, PIC = ovt.BASE, ovt.PIC


def text_doc(**clip):
    c = {"id": "x1", "start_s": 1, "end_s": 3, "text": "HELLO WORLD", "size": 60, "outline_width": 0}
    c.update(clip)
    return {"version": 1, "width": 640, "height": 360, "fps": 30, "tracks": [
        {"id": "v1", "kind": "V", "clips": [{"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0, "out_s": 4}]},
        {"id": "t1", "kind": "T", "clips": [c]}]}


def ov_doc(**ov):
    o = {"id": "o1", "asset_id": PIC, "start_s": 1, "end_s": 3, "x": 0.5, "y": 0.5, "w": 0.3}
    o.update(ov)
    doc = text_doc()
    doc["tracks"].pop()
    doc["overlays"] = [o]
    return doc


def spec_of(doc, table=None):
    return tr.to_render_spec(doc, (table or ovt.assets_table()).get, "/out/x.mp4")


# ── the document ────────────────────────────────────────────────────────────

class DocumentTestCase(unittest.TestCase):
    def test_every_name_of_the_lists_is_valid_and_the_lists_are_closed(self):
        self.assertEqual(tl.ANIM_OUT, ("fade", "slide-up", "slide-down", "slide-left", "slide-right", "pop"))
        self.assertEqual(tl.ANIM_IN, tl.ANIM_OUT + ("typewriter",))
        for name in tl.ANIM_IN:
            with self.subTest(f"text in {name}"):
                self.assertEqual(tl.validate(text_doc(anim_in=name)), [])
        for name in tl.ANIM_OUT:
            with self.subTest(f"text out {name}"):
                self.assertEqual(tl.validate(text_doc(anim_out=name)), [])
            with self.subTest(f"overlay in/out {name}"):
                self.assertEqual(tl.validate(ov_doc(anim_in=name, anim_out=name)), [])
        for bad in ("custom", "", "Fade", "FADE", "fade ", "slide_up", "slideup", "slide-diagonal", "wipe",
                    "fade\n", "fade;", "typewriter ", "x" * 10_000, None, True, 0, 1.5, ["fade"], {"a": 1}):
            with self.subTest(repr(bad)[:30]):
                for doc in (text_doc(anim_in=bad), text_doc(anim_out=bad), ov_doc(anim_in=bad),
                            ov_doc(anim_out=bad)):
                    got = tl.validate(doc)
                    self.assertTrue(any("must be one of" in p for p in got), got)
                    self.assertTrue(all(len(p) < 300 for p in got))

    def test_a_typewriter_is_for_a_texts_entrance_only(self):
        self.assertTrue(any("anim_out must be one of" in p for p in tl.validate(text_doc(anim_out="typewriter"))))
        self.assertTrue(any("anim_in must be one of" in p for p in tl.validate(ov_doc(anim_in="typewriter"))))

    def test_durations_at_both_ends_and_beyond(self):
        for ok in (0.1, 0.4, 1, 2.0):
            self.assertEqual(tl.validate(text_doc(anim_in="fade", anim_in_s=ok)), [], ok)
            self.assertEqual(tl.validate(ov_doc(anim_out="pop", anim_out_s=ok)), [], ok)
        for bad in (0, 0.099, 2.001, -1, 1e9, float("nan"), float("inf"), "1", None, True, [1]):
            with self.subTest(repr(bad)):
                for doc in (text_doc(anim_in="fade", anim_in_s=bad), text_doc(anim_out="fade", anim_out_s=bad),
                            ov_doc(anim_in="fade", anim_in_s=bad), ov_doc(anim_out="fade", anim_out_s=bad)):
                    self.assertTrue(any("_s must be a number" in p for p in tl.validate(doc)), bad)
        big = 10 ** 400
        self.assertTrue(tl.validate(text_doc(anim_in="fade", anim_in_s=big)))

    def test_a_duration_needs_its_animation(self):
        for doc in (text_doc(anim_in_s=0.5), text_doc(anim_out_s=0.5), ov_doc(anim_in_s=0.5)):
            self.assertTrue(any(" needs anim_" in p for p in tl.validate(doc)))
        self.assertTrue(any("anim_out_s needs anim_out" in p
                            for p in tl.validate(text_doc(anim_in="fade", anim_out_s=0.5))))

    def test_an_animation_and_the_other_sides_plain_fade_fit_too(self):
        # shown 2 s: a 1.5 s pop and a 1 s fade-out would cut the pop at 66 % (the fade is an exit animation
        # starting at end - 1 s); both validators, the spec, and the shared doc cases say so
        for doc in (text_doc(anim_in="pop", anim_in_s=1.5, fade_out_s=1.0),
                    text_doc(anim_out="fade", anim_out_s=1.5, fade_in_s=1.0)):
            got = tl.validate(doc)
            self.assertTrue(any("longer than the text is shown" in p for p in got), got)
        self.assertEqual(tl.validate(text_doc(anim_in="pop", anim_in_s=1.0, fade_out_s=1.0)), [])
        self.assertEqual(tl.validate(text_doc(anim_in="pop", anim_in_s=1.5, fade_out_s=0.5)), [])
        # a missing duration is the default
        self.assertEqual(tl.validate(text_doc(anim_in="pop", fade_out_s=1.0)), [])
        self.assertTrue(tl.validate(text_doc(end_s=2.3, anim_in="pop", fade_out_s=1.0)))
        base = spec_of(text_doc())
        ov = base.overlays[0]
        for kw in ({"anim_in": "pop", "anim_in_s": 1.5, "fade_out_s": 1.0},
                   {"anim_out": "fade", "anim_out_s": 1.5, "fade_in_s": 1.0}):
            got = rs.validate(rs.RenderSpec(**{**base.__dict__, "overlays": [rs.TextOverlay(**{**ov.__dict__, **kw})]}))
            self.assertTrue(any("longer than it is shown" in p for p in got), (kw, got))
        ok = rs.validate(rs.RenderSpec(**{**base.__dict__, "overlays": [rs.TextOverlay(
            **{**ov.__dict__, "anim_in": "pop", "anim_in_s": 1.0, "fade_out_s": 1.0})]}))
        self.assertEqual(ok, [])

    def test_in_and_out_fit_in_the_time_the_item_is_shown(self):
        # the text is shown for 2 s
        self.assertEqual(tl.validate(text_doc(anim_in="fade", anim_in_s=1, anim_out="fade", anim_out_s=1)), [])
        got = tl.validate(text_doc(anim_in="fade", anim_in_s=1.5, anim_out="fade", anim_out_s=1))
        self.assertTrue(any("longer than the item is shown" in p for p in got), got)
        # a missing duration counts as the default (0.4 + 0.4)
        self.assertEqual(tl.validate(text_doc(end_s=1.8, anim_in="fade", anim_out="fade")), [])
        self.assertTrue(tl.validate(text_doc(end_s=1.7, anim_in="fade", anim_out="fade")))
        self.assertTrue(tl.validate(ov_doc(end_s=1.5, anim_in="pop", anim_in_s=0.4, anim_out="pop", anim_out_s=0.4)))

    def test_an_animation_and_the_plain_fade_of_the_same_side_are_refused(self):
        got = tl.validate(text_doc(anim_in="pop", fade_in_s=0.3))
        self.assertTrue(any("anim_in and fade_in_s both set" in p for p in got), got)
        got = tl.validate(text_doc(anim_out="pop", fade_out_s=0.3))
        self.assertTrue(any("anim_out and fade_out_s both set" in p for p in got), got)
        # the other side, and a zero fade, are fine
        self.assertEqual(tl.validate(text_doc(anim_in="pop", fade_out_s=0.3)), [])
        self.assertEqual(tl.validate(text_doc(anim_in="pop", fade_in_s=0)), [])

    def test_captions_have_no_animation_and_the_shape_stays_strict(self):
        doc = text_doc()
        doc["captions"] = {"style": {"anim_in": "fade"}, "cues": [{"id": "q", "start_s": 0, "end_s": 1, "text": "x"}]}
        self.assertTrue(any("anim_in is not a known field" in p for p in tl.validate(doc)))
        self.assertTrue(any("not a known field" in p for p in tl.validate(text_doc(anim_inn="fade"))))

    def test_at_most_twenty_typewriter_texts(self):
        def many(n):
            doc = text_doc()
            doc["tracks"][1]["clips"] = [
                {"id": f"x{i}", "start_s": 0, "end_s": 2, "text": "t", "anim_in": "typewriter"} for i in range(n)]
            return doc
        # texts may share time on one track? no: they may not overlap, so use a track each
        def spread(n):
            doc = text_doc()
            doc["tracks"] = doc["tracks"][:1] + [
                {"id": f"t{i}", "kind": "T", "clips": [
                    {"id": f"x{i}", "start_s": 0, "end_s": 2, "text": "t", "anim_in": "typewriter"}]}
                for i in range(n)]
            return doc
        self.assertEqual(tl.validate(spread(tl.MAX_TYPEWRITER_TEXTS)), [])
        got = tl.validate(spread(tl.MAX_TYPEWRITER_TEXTS + 1))
        self.assertTrue(any("typewriter texts" in p for p in got), got)

    def test_normalise_fills_each_named_duration_and_leaves_the_rest(self):
        n = tl.normalise(text_doc(anim_in="fade", anim_out="slide-left", anim_out_s=0.25))
        c = n["tracks"][1]["clips"][0]
        self.assertEqual((c["anim_in"], c["anim_in_s"], c["anim_out"], c["anim_out_s"]),
                         ("fade", 0.4, "slide-left", 0.25))
        plain = tl.normalise(text_doc())["tracks"][1]["clips"][0]
        self.assertFalse(any(k.startswith("anim") for k in plain))
        o = tl.normalise(ov_doc(anim_in="pop"))["overlays"][0]
        self.assertEqual((o["anim_in"], o["anim_in_s"]), ("pop", 0.4))
        self.assertNotIn("anim_out", o)
        self.assertEqual(tl.normalise(tl.normalise(text_doc(anim_in="fade"))),
                         tl.normalise(text_doc(anim_in="fade")))

    def test_the_json_schema_names_the_same_fields_and_values(self):
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        for name, text in (("text_clip", True), ("overlay", False)):
            props = schema["$defs"][name]["properties"]
            self.assertIn(name == "overlay" and "opacity" or "fade_in_s", props)
            self.assertEqual(props["anim_in"]["enum"], list(tl.ANIM_IN if text else tl.ANIM_OUT))
            self.assertEqual(props["anim_out"]["enum"], list(tl.ANIM_OUT))
            for k in ("anim_in_s", "anim_out_s"):
                self.assertEqual((props[k]["minimum"], props[k]["maximum"], props[k]["default"]),
                                 (tl.ANIM_MIN_S, tl.ANIM_MAX_S, tl.ANIM_DEFAULT_S))
        self.assertEqual(set(schema["$defs"]["overlay"]["properties"]), set(tl._OVERLAY_KEYS))
        self.assertEqual(set(schema["$defs"]["text_clip"]["properties"]), set(tl._T_CLIP_KEYS))

    def test_document_and_render_spec_agree(self):
        self.assertEqual((rs.ANIM_IN, rs.ANIM_OUT), (tl.ANIM_IN, tl.ANIM_OUT))
        self.assertEqual((rs.ANIM_MIN_S, rs.ANIM_MAX_S, rs.ANIM_DEFAULT_S),
                         (tl.ANIM_MIN_S, tl.ANIM_MAX_S, tl.ANIM_DEFAULT_S))
        self.assertEqual((rs.ANIM_SLIDE, rs.ANIM_POP_FROM), (tl.ANIM_SLIDE, tl.ANIM_POP_FROM))

    def test_the_editor_module_has_the_same_constants(self):
        ts = EDITOR_TS.read_text(encoding="utf-8")

        def names(var):
            return tuple(re.findall(r'"([\w-]+)"', re.search(rf"export const {var} = \[([^\]]*)\]", ts).group(1)))
        self.assertEqual(names("ANIM_OUT"), tl.ANIM_OUT)
        self.assertIn('export const ANIM_IN = [...ANIM_OUT, "typewriter"] as const;', ts)
        for var, want in (("ANIM_MIN_S", tl.ANIM_MIN_S), ("ANIM_MAX_S", tl.ANIM_MAX_S),
                          ("ANIM_DEFAULT_S", tl.ANIM_DEFAULT_S), ("MAX_TYPEWRITER_TEXTS", tl.MAX_TYPEWRITER_TEXTS)):
            self.assertEqual(float(re.search(rf"export const {var} = ([\d.]+);", ts).group(1)), want, var)


# ── the spec ────────────────────────────────────────────────────────────────

class SpecTestCase(unittest.TestCase):
    def test_animations_reach_the_text_and_picture_overlays_and_only_then(self):
        spec = spec_of(ov_doc(anim_in="pop", anim_out="slide-up", anim_out_s=0.5))
        p = spec.picture_overlays[0]
        self.assertEqual((p.anim_in, p.anim_in_s, p.anim_out, p.anim_out_s), ("pop", 0.4, "slide-up", 0.5))
        self.assertEqual(rs.RenderSpec.from_dict(spec.to_dict()), spec)
        plain = spec_of(ov_doc()).picture_overlays[0].to_dict()
        self.assertFalse(any(k.startswith("anim") for k in plain))
        t = spec_of(text_doc(anim_in="typewriter", anim_in_s=0.8)).overlays[0]
        self.assertEqual((t.anim_in, t.anim_in_s, t.anim_out), ("typewriter", 0.8, None))
        self.assertFalse(any(k.startswith("anim") for k in spec_of(text_doc()).overlays[0].to_dict()))

    def test_a_spec_is_refused_for_what_would_not_render(self):
        base_t = spec_of(text_doc())
        base_p = spec_of(ov_doc())

        def with_text(**kw):
            return rs.validate(rs.RenderSpec(**{**base_t.__dict__, "overlays": [
                rs.TextOverlay(**{**base_t.overlays[0].__dict__, **kw})]}))

        def with_pic(**kw):
            return rs.validate(rs.RenderSpec(**{**base_p.__dict__, "picture_overlays": [
                rs.PictureOverlay(**{**base_p.picture_overlays[0].__dict__, **kw})]}))
        for kw, needle in (({"anim_in": "spin"}, "unknown anim_in"), ({"anim_out": "typewriter",
                            "anim_out_s": 0.4}, "unknown anim_out"),
                           ({"anim_in": "fade", "anim_in_s": 5.0}, "anim_in_s must be"),
                           ({"anim_in": "fade", "anim_in_s": float("nan")}, "anim_in_s must be"),
                           ({"anim_in": "fade", "anim_in_s": 1.5, "anim_out": "fade", "anim_out_s": 1.0},
                            "longer than it is shown"),
                           ({"anim_in": "fade", "fade_in_s": 0.3}, "use one of them")):
            self.assertTrue(any(needle in p for p in with_text(**kw)), (kw, with_text(**kw)))
        self.assertTrue(any("unknown anim_in" in p for p in with_pic(anim_in="typewriter")))
        self.assertTrue(any("unknown anim_out" in p for p in with_pic(anim_out="spin", anim_out_s=0.4)))
        self.assertEqual(with_text(anim_in="typewriter", anim_in_s=0.5), [])
        self.assertEqual(with_pic(anim_in="slide-left", anim_in_s=0.5), [])


# ── ASS events (text) ───────────────────────────────────────────────────────

def events_of(**kw):
    o = rs.TextOverlay(1.0, 4.0, "Hello", **kw)
    text = ass_captions.build_overlay_ass([o], width=1280, height=720)
    return [l for l in text.splitlines() if l.startswith("Dialogue:")]


class AssTestCase(unittest.TestCase):
    def test_no_animation_is_the_single_event_it_was(self):
        self.assertEqual(events_of(), ["Dialogue: 0,0:00:01.00,0:00:04.00,O0,,0,0,0,,{\\pos(640,360)}Hello"])
        self.assertEqual(events_of(fade_in_s=0.5, fade_out_s=0.25),
                         ["Dialogue: 0,0:00:01.00,0:00:04.00,O0,,0,0,0,,{\\pos(640,360)\\fad(500,250)}Hello"])

    def test_each_entrance_is_pinned(self):
        pin = {
            "fade": "{\\pos(640,360)\\alpha&HFF&\\t(0,500,\\alpha&H00&)}",
            "slide-up": "{\\move(640,468,640,360,0,500)\\alpha&HFF&\\t(0,500,\\alpha&H00&)}",
            "slide-down": "{\\move(640,252,640,360,0,500)\\alpha&HFF&\\t(0,500,\\alpha&H00&)}",
            "slide-left": "{\\move(832,360,640,360,0,500)\\alpha&HFF&\\t(0,500,\\alpha&H00&)}",
            "slide-right": "{\\move(448,360,640,360,0,500)\\alpha&HFF&\\t(0,500,\\alpha&H00&)}",
            "pop": "{\\pos(640,360)\\fscx60\\fscy60\\alpha&HFF&\\t(0,500,\\fscx100\\fscy100\\alpha&H00&)}",
        }
        for name, tags in pin.items():
            with self.subTest(name):
                self.assertEqual(events_of(anim_in=name, anim_in_s=0.5),
                                 [f"Dialogue: 0,0:00:01.00,0:00:04.00,O0,,0,0,0,,{tags}Hello"])

    def test_each_exit_is_its_own_event_after_the_hold(self):
        pin = {
            "fade": "{\\pos(640,360)\\t(0,500,\\alpha&HFF&)}",
            "slide-up": "{\\move(640,360,640,252,0,500)\\t(0,500,\\alpha&HFF&)}",
            "slide-down": "{\\move(640,360,640,468,0,500)\\t(0,500,\\alpha&HFF&)}",
            "slide-left": "{\\move(640,360,448,360,0,500)\\t(0,500,\\alpha&HFF&)}",
            "slide-right": "{\\move(640,360,832,360,0,500)\\t(0,500,\\alpha&HFF&)}",
            "pop": "{\\pos(640,360)\\t(0,500,\\fscx60\\fscy60\\alpha&HFF&)}",
        }
        for name, tags in pin.items():
            with self.subTest(name):
                self.assertEqual(events_of(anim_out=name, anim_out_s=0.5), [
                    "Dialogue: 0,0:00:01.00,0:00:03.50,O0,,0,0,0,,{\\pos(640,360)}Hello",
                    f"Dialogue: 0,0:00:03.50,0:00:04.00,O0,,0,0,0,,{tags}Hello"])

    def test_the_plain_fade_beside_an_animation_is_a_fade_of_its_own(self):
        ev = events_of(anim_in="pop", anim_in_s=0.5, fade_out_s=0.5)
        self.assertEqual(len(ev), 2)
        self.assertIn("\\t(0,500,\\alpha&HFF&)", ev[1])
        self.assertNotIn("\\fad", "".join(ev))

    def test_a_typewriter_grows_a_prefix_and_keeps_the_rest_transparent(self):
        ev = events_of(anim_in="typewriter", anim_in_s=0.5)
        bodies = [re.sub(r"^.*?\}", "", l.split(",,", 1)[1], count=1) for l in ev]
        self.assertEqual(bodies[:5], ["H{\\alpha&HFF&}ello", "He{\\alpha&HFF&}llo", "Hel{\\alpha&HFF&}lo",
                                      "Hell{\\alpha&HFF&}o", "Hello"])
        self.assertEqual(bodies[-1], "Hello")
        starts = [re.match(r"Dialogue: 0,([\d:.]+),([\d:.]+)", l).groups() for l in ev]
        for (s1, e1), (s2, _e2) in zip(starts, starts[1:]):
            self.assertEqual(e1, s2, "events are back to back")
        self.assertEqual(starts[0][0], "0:00:01.00")
        self.assertEqual(starts[-1][1], "0:00:04.00")
        for l in ev:
            self.assertIn("{\\pos(640,360)}", l, "the text never moves while it is written")

    def test_a_typewriter_keeps_line_breaks_and_escapes_the_text(self):
        o = rs.TextOverlay(0.0, 3.0, "A{\\i1}\nB", anim_in="typewriter", anim_in_s=0.4)
        text = ass_captions.build_overlay_ass([o], width=640, height=360)
        evs = [l for l in text.splitlines() if l.startswith("Dialogue:")]
        self.assertTrue(all("{\\i1}" not in l and "\\i1" not in l.replace("{\\alpha&HFF&}", "") for l in evs))
        self.assertIn("A(/i1)\\NB", evs[-1].split("}", 1)[1])
        for l in evs[:-1]:
            self.assertEqual(l.count("\\N") <= 1, True)
        self.assertLessEqual(len(evs), ass_captions._TYPEWRITER_MAX_STEPS + 1)

    def test_a_long_text_is_written_in_a_bounded_number_of_events(self):
        o = rs.TextOverlay(0.0, 5.0, "x" * 500, anim_in="typewriter", anim_in_s=2.0)
        text = ass_captions.build_overlay_ass([o], width=640, height=360)
        n = len([l for l in text.splitlines() if l.startswith("Dialogue:")])
        self.assertLessEqual(n, ass_captions._TYPEWRITER_MAX_STEPS + 1)

    def test_other_overlays_of_the_file_are_untouched(self):
        a = rs.TextOverlay(0, 2, "Plain", fade_in_s=0.2)
        b = rs.TextOverlay(0, 2, "Moving", anim_in="slide-up", anim_in_s=0.3)
        both = ass_captions.build_overlay_ass([a, b], width=640, height=360).splitlines()
        alone = ass_captions.build_overlay_ass([a], width=640, height=360).splitlines()
        self.assertTrue(set(l for l in alone if l.startswith("Dialogue:")) <= set(both))

    def test_an_unknown_name_cannot_be_written(self):
        o = rs.TextOverlay(0, 2, "x", anim_in="spin", anim_in_s=0.4)
        with self.assertRaises(ValueError):
            ass_captions.build_overlay_ass([o], width=640, height=360)


# ── overlay filter graph (pictures) ─────────────────────────────────────────

def graph_of(**kw):
    o = rs.PictureOverlay("/m/p.png", "image", 1.0, 3.0, 0.5, 0.5, 0.3, 1.0, **kw)
    spec = rs.RenderSpec("/o.mp4", 1280, 720, 30, segments=[rs.Segment(4, "/m/b.mp4")],
                         frame_exact=True, picture_overlays=[o])
    return rs.picture_overlay_filters(spec, 1, "[0:v]")[0]


class FilterTestCase(unittest.TestCase):
    def test_no_animation_is_the_graph_it_was(self):
        g = graph_of()
        self.assertEqual(g[0], "[1:v]trim=end_frame=1,setpts=PTS-STARTPTS,scale=384:1440:force_original_aspect_ratio="
                               "decrease:force_divisible_by=2:flags=bicubic,format=rgba,scale=out_color_matrix=bt709:"
                               "out_range=tv:flags=bicubic,format=yuva420p,fps=30,tpad=stop=59:stop_mode=clone,"
                               "setpts=PTS+30/(30*TB)[p0]")
        self.assertEqual(g[1], "[0:v][p0]overlay=x='round(640.000-w/2)':y='round(360.000-h/2)'"
                               ":enable='between(t,0.983333,2.983333)':eof_action=pass[pv0]")

    def test_a_fade_is_an_alpha_fade_at_the_right_times(self):
        g = graph_of(anim_in="fade", anim_in_s=0.5, anim_out="fade", anim_out_s=0.4)
        self.assertIn(",fade=t=in:st=1.000:d=0.500:alpha=1,fade=t=out:st=2.600:d=0.400:alpha=1[p0]", g[0])
        self.assertIn("x='round(640.000-w/2)':y='round(360.000-h/2)'", g[1])

    def test_a_slide_moves_the_centre_by_a_fraction_of_the_frame(self):
        g = graph_of(anim_in="slide-up", anim_in_s=0.5, anim_out="slide-left", anim_out_s=0.5)
        self.assertIn("y='round(360.000-(-108.000)*(1-clip((t-1.000)/0.500,0,1))-h/2)'", g[1])
        self.assertIn("x='round(640.000+(-192.000)*clip((t-2.500)/0.500,0,1)-w/2)'", g[1])
        g = graph_of(anim_in="slide-right", anim_in_s=0.5, anim_out="slide-down", anim_out_s=0.5)
        self.assertIn("x='round(640.000-(192.000)*(1-clip((t-1.000)/0.500,0,1))-w/2)'", g[1])
        self.assertIn("y='round(360.000+(108.000)*clip((t-2.500)/0.500,0,1)-h/2)'", g[1])

    def test_a_pop_scales_about_the_centre(self):
        g = graph_of(anim_in="pop", anim_in_s=0.5)
        self.assertIn(",scale=w='max(2,trunc(iw*(1-0.400*(1-clip((t-1.000)/0.500,0,1)))/2)*2)':"
                      "h='max(2,trunc(ih*(1-0.400*(1-clip((t-1.000)/0.500,0,1)))/2)*2)':eval=frame[p0]", g[0])
        g = graph_of(anim_in="pop", anim_in_s=0.5, anim_out="pop", anim_out_s=0.5)
        self.assertEqual(g[0].count("scale=w="), 1, "one scaler for in and out")
        self.assertIn("*(1-0.400*clip((t-2.500)/0.500,0,1))", g[0])

    def test_only_formatted_numbers_and_listed_names_reach_the_graph(self):
        for bad in ("typewriter", "spin", "fade;movie=/etc/passwd", None):
            if bad is None:
                continue
            with self.assertRaises(ValueError):
                graph_of(anim_in=bad, anim_in_s=0.5)
        g = " ".join(graph_of(anim_in="pop", anim_out="slide-up"))
        self.assertNotIn("/m/p.png", g)

    def test_the_final_command_for_an_animated_overlay_has_the_same_inputs(self):
        plain = spec_of(ov_doc())
        anim = spec_of(ov_doc(anim_in="fade", anim_out="slide-up"))
        a = rs.build_ffmpeg_command(plain, "/w/c.txt", "/w/o.ass")
        b = rs.build_ffmpeg_command(anim, "/w/c.txt", "/w/o.ass")

        def inputs(cmd):
            return [cmd[i + 1] for i, t in enumerate(cmd) if t == "-i"]
        self.assertEqual(inputs(a), inputs(b))
        self.assertNotEqual(a, b)


# ── documents without the fields render exactly as before ────────────────────

class NeutralTestCase(unittest.TestCase):
    def test_every_older_document_renders_the_commands_and_ass_it_always_did(self):
        for name, doc in trt.neutral_docs().items():
            with self.subTest(name):
                self.assertEqual(trt.digest(doc), trt.LEGACY[name])
                self.assertEqual(trt.ass_digest(doc), trt.LEGACY_ASS[name])

    def test_an_animation_changes_only_the_text_file_or_the_final_pass(self):
        doc = trt.neutral_docs()["styled text"]
        before, _ = trt.all_commands(doc)
        doc2 = copy.deepcopy(doc)
        doc2["tracks"][1]["clips"][0].update(anim_in="pop")
        after, _ = trt.all_commands(doc2)
        self.assertEqual(before, after, "text animations live in the ASS file, not in any command")
        self.assertNotEqual(trt.ass_digest(doc), trt.ass_digest(doc2))
        ovl = trt.neutral_docs()["overlay and text"]
        b0, _ = trt.all_commands(ovl)
        ovl2 = copy.deepcopy(ovl)
        ovl2["overlays"][0].update(anim_in="fade")
        b1, _ = trt.all_commands(ovl2)
        self.assertEqual(b0[:-1], b1[:-1], "only the final pass differs")
        self.assertNotEqual(b0[-1], b1[-1])


# ── real ffmpeg ─────────────────────────────────────────────────────────────

class _Real(ovt._Real):
    W, H = 640, 360

    def table(self, rgb="0x808080", seconds=4):
        base = self.base_video(size=f"{self.W}x{self.H}", rgb=rgb, seconds=seconds)
        pic = self.png("patch", ovt.flat_png(200, 100, (255, 0, 0, 255)))
        return {BASE: base, PIC: pic}

    def gray_frames(self, path, indexes):
        out = {}
        for n in indexes:
            out[n] = self.run_ffmpeg("-i", str(path), "-vf", f"select=eq(n\\,{n}),format=gray",
                                     "-vsync", "0", "-f", "rawvideo", "-")
        return out

    def bbox(self, raw, thr=100):
        w, h = self.W, self.H
        xs, ys = [], []
        for y in range(h):
            row = raw[y * w:(y + 1) * w]
            for x in range(w):
                if row[x] > thr:
                    xs.append(x)
                    ys.append(y)
        return (min(xs), min(ys), max(xs), max(ys)) if xs else None


class PictureRenderTestCase(_Real):
    def red_box(self, path, n):
        """Bounding box of the red patch (r well above g) in frame n."""
        raw = self.frames(path, (self.W, self.H), [n], "bt601")[n]
        w = self.W
        xs, ys = [], []
        for y in range(self.H):
            for x in range(w):
                r, g, _b = self.px(raw, w, x, y)
                if r > g + 40:
                    xs.append(x)
                    ys.append(y)
        return (min(xs), min(ys), max(xs), max(ys)) if xs else None, self.px(raw, w, 320, 180)

    def render(self, **anim):
        return self.export(ov_doc(**anim), self.table())

    def test_a_fade_goes_from_nothing_to_the_patch_and_back(self):
        out = self.render(anim_in="fade", anim_in_s=0.5, anim_out="fade", anim_out_s=0.5)
        box, _ = self.red_box(out, 29)
        self.assertIsNone(box, "before the span")
        mid_in = self.px(self.frames(out, (self.W, self.H), [36], "bt601")[36], self.W, 320, 180)
        full = self.px(self.frames(out, (self.W, self.H), [60], "bt601")[60], self.W, 320, 180)
        mid_out = self.px(self.frames(out, (self.W, self.H), [84], "bt601")[84], self.W, 320, 180)
        self.assertGreater(full[0], 230)
        for mid in (mid_in, mid_out):
            self.assertTrue(128 + 20 < mid[0] < full[0] - 20, mid)
            self.assertGreater(mid[1], 40, "a blend with the grey, not a dimmer red")
        end = self.px(self.frames(out, (self.W, self.H), [89], "bt601")[89], self.W, 320, 180)
        self.assertLess(abs(end[0] - 128), 25, "gone at the end")

    def test_a_slide_up_enters_from_below_and_a_slide_left_leaves_to_the_left(self):
        out = self.render(anim_in="slide-up", anim_in_s=0.5, anim_out="slide-left", anim_out_s=0.5)
        full, _ = self.red_box(out, 60)
        entering, _ = self.red_box(out, 36)
        leaving, _ = self.red_box(out, 84)
        dy = ovt.tl.ANIM_SLIDE * self.H
        self.assertAlmostEqual(entering[1] - full[1], dy * (1 - 0.4), delta=4)   # 0.2 s of 0.5 s in
        self.assertEqual(entering[0], full[0], "no sideways move when entering")
        dx = tl.ANIM_SLIDE * self.W
        self.assertAlmostEqual(full[0] - leaving[0], dx * 0.6, delta=4)
        self.assertAlmostEqual(leaving[1], full[1], delta=2)

    def test_a_pop_grows_from_sixty_percent_about_the_centre(self):
        out = self.render(anim_in="pop", anim_in_s=0.5, anim_out="pop", anim_out_s=0.5)
        full, _ = self.red_box(out, 60)
        small, _ = self.red_box(out, 36)      # 0.2 s in: 0.6 + 0.4 * 0.4
        width = lambda b: b[2] - b[0] + 1
        self.assertAlmostEqual(width(small) / width(full), 0.6 + 0.4 * 0.4, delta=0.04)
        cx = lambda b: (b[0] + b[2]) / 2
        self.assertAlmostEqual(cx(small), cx(full), delta=2)
        out_small, _ = self.red_box(out, 84)  # 0.3 s into the 0.5 s exit
        self.assertAlmostEqual(width(out_small) / width(full), 1 - 0.4 * 0.6, delta=0.04)

    def test_a_video_overlay_animates_too(self):
        vid = self.overlay_video(size="320x160", seconds=3, audio=False)
        table = self.table()
        table[ovt.VID] = vid
        doc = ov_doc(asset_id=ovt.VID, anim_in="slide-down", anim_in_s=0.5)
        out = self.export(doc, table)
        self.assertEqual(self.frame_count_of(out), 120)

    def frame_count_of(self, path):
        out = subprocess.run([self.ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-map", "0:v:0",
                              "-vf", "showinfo", "-f", "null", "-"], capture_output=True, text=True).stderr
        return len(re.findall(r"Parsed_showinfo_0 .*\bn:\s*\d+", out))

    def test_no_animation_is_the_same_picture_as_before_within_encoder_noise(self):
        table = self.table()
        a = self.export(ov_doc(), table)
        b = self.export(ov_doc(anim_in="fade", anim_in_s=0.1), table)
        fa = self.frames(a, (self.W, self.H), [60], "bt601")[60]
        fb = self.frames(b, (self.W, self.H), [60], "bt601")[60]
        self.assert_same(fa, fb, (self.W, self.H), "after the entrance the picture is the plain one",
                         thr=12)   # edges of the patch: the encoder's chroma noise


class TextRenderTestCase(_Real):
    def render(self, **anim):
        return self.export(text_doc(**anim), self.table(rgb="0x000000"))

    def box(self, out, n):
        return self.bbox(self.gray_frames(out, [n])[n])

    def peak(self, out, n):
        return max(self.gray_frames(out, [n])[n])

    def test_a_fade_ramps_the_brightness_in_and_out(self):
        out = self.render(anim_in="fade", anim_in_s=0.5, anim_out="fade", anim_out_s=0.5)
        self.assertEqual(self.peak(out, 28), 0)
        self.assertEqual(self.peak(out, 60), 255)
        for n in (36, 84):
            self.assertTrue(60 < self.peak(out, n) < 200, (n, self.peak(out, n)))

    def test_a_slide_up_enters_from_below_and_a_slide_left_leaves_leftwards(self):
        out = self.render(anim_in="slide-up", anim_in_s=0.5, anim_out="slide-left", anim_out_s=0.5)
        full, entering, leaving = self.box(out, 60), self.box(out, 36), self.box(out, 84)
        self.assertGreater(entering[1] - full[1], 20)
        self.assertAlmostEqual(entering[0], full[0], delta=2)   # the faint edge crosses the threshold late
        self.assertGreater(full[0] - leaving[0], 40)
        self.assertAlmostEqual(leaving[1], full[1], delta=2)

    def test_a_pop_scales_the_text_about_its_anchor(self):
        out = self.render(anim_in="pop", anim_in_s=0.5)
        full, small = self.box(out, 60), self.box(out, 36)
        ratio = (small[2] - small[0]) / (full[2] - full[0])
        self.assertAlmostEqual(ratio, 0.6 + 0.4 * 0.4, delta=0.06)
        self.assertAlmostEqual((small[0] + small[2]) / 2, (full[0] + full[2]) / 2, delta=3)

    def test_a_typewriter_writes_left_to_right_without_the_text_moving(self):
        out = self.render(anim_in="typewriter", anim_in_s=0.8, anim_out="fade", anim_out_s=0.3)
        self.assertIsNone(self.box(out, 28))
        widths = []
        left = None
        for n in (32, 36, 45, 60):
            b = self.box(out, n)
            left = b[0] if left is None else left
            self.assertEqual(b[0], left, "the left edge stays where the finished text begins")
            widths.append(b[2])
        self.assertEqual(widths, sorted(widths))
        self.assertLess(widths[0], widths[-1] - 100)
        self.assertEqual(self.peak(out, 60), 255)
        self.assertLess(self.peak(out, 84), 230, "and fades out")

    def test_the_exit_ends_with_the_text_gone(self):
        for name in ("fade", "slide-left", "slide-down", "pop"):
            out = self.render(anim_out=name, anim_out_s=0.5)
            self.assertLess(self.peak(out, 89), 80, name)


if __name__ == "__main__":
    unittest.main()
