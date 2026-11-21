"""Picture overlays (a picture or video laid over the picture), end to end.

The document holds a top-level ``overlays`` list (modules/timeline.py):
``{id, asset_id, start_s, end_s, x?, y?, w?, opacity?}`` — (x, y) is the CENTRE,
``w`` the width, all fractions of the frame. The EXPORT lays them over the
composited picture with ffmpeg ``overlay`` (render_spec ``picture_overlay_*``);
the editor PREVIEW draws the same fractions as an absolutely positioned
element (command-center/lib/editorOverlay.ts ``overlayRect`` /
``overlayPreviewStyle``).

What is pinned here, by class:

* the document: every range at both ends and beyond, strict fields, the cap,
  huge numbers, normalisation, asset ids and kinds, the JSON schema, the
  constants the three languages share;
* the argv: a document WITHOUT overlays (or with an empty list, an invisible
  overlay, or one that starts after the picture) renders the SAME command
  lists as before overlays existed — compared with digests captured from
  ``origin/main`` before this change, over many configurations; with
  overlays, the inputs follow the audio tracks, the graph is where it must be
  (over the picture, under the text) and no document text is in it;
* the PIXELS: real ffmpeg renders a flat base clip with a PNG (with a
  transparent half) and a video laid over it. The patch's rectangle, its
  opacity and its first and last frame are measured and compared with the
  preview's arithmetic (samples/overlay_preview.json, which the TypeScript
  test pins ``overlayRect`` to), within the tolerance stated below; the sound
  of an overlay video is never in the export.

What the parity does NOT prove: that a browser draws the same pixels (it
compares geometry and blending arithmetic, not browser output; a Playwright
check of the real preview was done separately), colours near the gamut edge,
or an overlay file that ffmpeg cannot decode (the export fails then, as for
any clip). Preview and export are two renderers: the tolerance below is the
honest gap. Skipped cleanly when no ffmpeg runs.
"""

import copy
import hashlib
import json
import re
import struct
import subprocess
import tempfile
import time
import unittest
import zlib
from pathlib import Path

from modules import render_backend
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr

ROOT = Path(__file__).resolve().parent.parent
EDITOR_TS = ROOT / "command-center" / "lib" / "editor.ts"
OVERLAY_TS = ROOT / "command-center" / "lib" / "editorOverlay.ts"
FIXTURE = ROOT / "samples" / "overlay_preview.json"

BASE = "11111111-1111-4111-8111-111111111111"     # the picture track's video
PIC = "33333333-3333-4333-8333-333333333333"     # a picture
VID = "44444444-4444-4444-8444-444444444444"     # a video used as an overlay
SND = "22222222-2222-4222-8222-222222222222"     # music
PIC2 = "55555555-5555-4555-8555-555555555555"


def doc_with(overlays=None, width=1280, height=720, fps=30, out_s=4, **top):
    doc = {"version": 1, "width": width, "height": height, "fps": fps, "tracks": [
        {"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0, "out_s": out_s}]}]}
    if overlays is not None:
        doc["overlays"] = overlays
    doc.update(top)
    return doc


def ov(**kw):
    o = {"id": "o1", "asset_id": PIC, "start_s": 1, "end_s": 3}
    o.update(kw)
    return o


# ── the document ────────────────────────────────────────────────────────────

class DocumentTestCase(unittest.TestCase):
    def problems(self, **kw):
        return tl.validate(doc_with([ov(**kw)]))

    def test_the_documented_example_is_valid_and_normalises_to_defaults(self):
        doc = doc_with([ov()])
        self.assertEqual(tl.validate(doc), [])
        self.assertEqual(tl.normalise(doc)["overlays"][0],
                         {"id": "o1", "asset_id": PIC, "start_s": 1.0, "end_s": 3.0,
                          "x": 0.5, "y": 0.5, "w": 0.3, "opacity": 1.0})

    def test_every_number_outside_its_range_is_refused_naming_the_field(self):
        ranges = {"x": (0, 1), "y": (0, 1), "opacity": (0, 1),
                  "w": (tl.OVERLAY_W_MIN, tl.OVERLAY_W_MAX)}
        for key, (lo, hi) in ranges.items():
            for good in (lo, hi, (lo + hi) / 2):
                self.assertEqual(self.problems(**{key: good}), [], (key, good))
            for bad in (lo - 0.001, hi + 0.001, lo - 5, hi + 5):
                self.assertTrue(any(f"{key} must be a number" in p for p in
                                    self.problems(**{key: bad})), (key, bad))

    def test_not_a_number_is_refused_in_every_numeric_field(self):
        for key in ("start_s", "end_s", "x", "y", "w", "opacity"):
            for bad in ("0.5", True, None, [0.5], {"v": 1}, float("nan"), float("inf")):
                self.assertTrue(self.problems(**{key: bad}), (key, bad))

    def test_an_int_too_large_for_a_float_is_refused_not_raised(self):
        # math.isfinite(10**400) raises OverflowError: reachable only by writing the
        # database directly, and it must end as invalid, never as a crash
        big = 10 ** 400
        for key in ("start_s", "end_s", "x", "y", "w", "opacity"):
            for sign in (1, -1):
                problems = self.problems(**{key: sign * big})
                self.assertTrue(any(f"{key} must be a number" in p for p in problems), key)
                self.assertTrue(all(len(p) < 300 for p in problems), "the message stays short")
        doc = doc_with([ov(end_s=big)])
        with self.assertRaises(tl.TimelineError):
            tl.load(doc)
        with self.assertRaises(tl.TimelineError):
            tr.to_render_spec(doc, lambda a: None, "/out/x.mp4")
        self.assertTrue(tl.validate(doc_with([ov(asset_id=big)])))

    def test_the_shape_is_strict(self):
        for extra in ({"path": "/etc/passwd"}, {"rotation": 10}, {"fit": "cover"},
                      {"text": "hi"}, {"url": "http://x"}):
            self.assertTrue(any("is not a known field" in p for p in self.problems(**extra)), extra)
        for missing in ("id", "asset_id", "start_s", "end_s"):
            o = ov()
            del o[missing]
            self.assertTrue(any(f"{missing} is missing" in p for p in tl.validate(doc_with([o]))),
                            missing)
        for bad in ("o1", 5, None, [], True):
            self.assertTrue(any("must be an object" in p for p in tl.validate(doc_with([bad]))), bad)
        for bad in ({"o1": ov()}, "o1", 5, None, True):
            doc = doc_with([])
            doc["overlays"] = bad
            self.assertTrue(any("overlays must be a list" in p for p in tl.validate(doc)), bad)

    def test_the_span_must_be_at_least_one_frame(self):
        self.assertTrue(any("must be greater than start_s" in p
                            for p in self.problems(start_s=2, end_s=2)))
        self.assertTrue(any("must be greater than start_s" in p
                            for p in self.problems(start_s=3, end_s=1)))
        self.assertTrue(any("shorter than one frame" in p
                            for p in self.problems(start_s=1, end_s=1.01)))
        self.assertEqual(self.problems(start_s=1, end_s=1.034), [])   # one frame at 30 fps
        # a 10 ms span is a frame at 60 fps ... only when it holds a frame boundary
        self.assertEqual(tl.validate(doc_with([ov(start_s=1, end_s=1.017)], fps=60)), [])
        self.assertTrue(self.problems(start_s=-0.001))

    def test_ids_share_the_documents_namespace(self):
        self.assertTrue(any("already used" in p for p in tl.validate(doc_with([ov(id="c1")]))))
        self.assertTrue(any("already used" in p for p in tl.validate(doc_with([ov(), ov()]))))
        self.assertTrue(any("id must be" in p for p in tl.validate(doc_with([ov(id="o 1")]))))
        self.assertTrue(any("asset_id must be a uuid" in p
                            for p in tl.validate(doc_with([ov(asset_id="logo.png")]))))

    def test_the_cap_and_how_cheap_checking_it_is(self):
        sixteen = [ov(id=f"o{i}", start_s=0, end_s=1) for i in range(tl.MAX_OVERLAYS)]
        self.assertEqual(tl.validate(doc_with(sixteen)), [])
        self.assertTrue(any("at most 16" in p for p in
                            tl.validate(doc_with(sixteen + [ov(id="o99")]))))
        # a hostile list is refused by its length alone, before any element is read
        huge = [ov(id=f"o{i}") for i in range(200_000)]
        t0 = time.monotonic()
        problems = tl.validate(doc_with(huge))
        self.assertLess(time.monotonic() - t0, 1.0)
        self.assertEqual(len([p for p in problems if "at most 16" in p]), 1)
        self.assertLess(len(problems), 5)

    def test_overlays_may_share_time_and_a_file_and_overlap_each_other(self):
        doc = doc_with([ov(id=f"o{i}", start_s=0, end_s=4, x=i / 10) for i in range(10)])
        self.assertEqual(tl.validate(doc), [])
        self.assertEqual(tl.overlaps(doc), [], "overlays are not clips on a track")

    def test_overlays_do_not_lengthen_the_timeline(self):
        doc = doc_with([ov(start_s=1, end_s=60)], out_s=4)
        self.assertEqual(tl.validate(doc), [])
        self.assertEqual(tl.duration_s(doc), 4.0)
        # a document of overlays alone has nothing to render
        bare = doc_with([ov()])
        bare["tracks"][0]["clips"] = []
        self.assertTrue(any("nothing to render" in p for p in tl.validate(bare)))

    def test_normalise_fills_defaults_rounds_keeps_order_and_drops_an_empty_list(self):
        doc = doc_with([ov(id="b", asset_id=PIC.upper(), start_s=2.00049, end_s=3.1234567, x=0.123456,
                           w=0.987654, opacity=0.5556),
                        ov(id="a", start_s=0, end_s=1)])
        norm = tl.normalise(doc)
        self.assertEqual([o["id"] for o in norm["overlays"]], ["b", "a"], "list order is the layering")
        self.assertEqual(norm["overlays"][0], {"id": "b", "asset_id": PIC, "start_s": 2.0,
                                                "end_s": 3.123, "x": 0.123, "y": 0.5, "w": 0.988,
                                                "opacity": 0.556})
        self.assertEqual(tl.normalise(norm), norm, "normalising twice changes nothing")
        self.assertEqual(tl.normalise(doc_with([])), tl.normalise(doc_with()))
        self.assertNotIn("overlays", tl.normalise(doc_with([])))
        # the input is not touched
        self.assertEqual(doc["overlays"][0]["asset_id"], PIC.upper())

    def test_asset_ids_include_the_overlays_once_lower_case(self):
        doc = doc_with([ov(asset_id=PIC.upper()), ov(id="o2", asset_id=BASE)])
        self.assertEqual(tl.asset_ids(doc), sorted({BASE, PIC}))

    def test_a_split_leaves_the_overlays_alone(self):
        doc = doc_with([ov()])
        out = tl.split_clip(doc, "c1", 2.0, "c2")
        self.assertEqual(out["overlays"], doc["overlays"])

    def test_the_json_schema_names_the_same_fields_and_ranges(self):
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        self.assertIn("overlays", schema["properties"])
        self.assertEqual(schema["properties"]["overlays"]["maxItems"], tl.MAX_OVERLAYS)
        item = schema["$defs"]["overlay"]
        self.assertEqual(set(item["properties"]), set(tl._OVERLAY_KEYS))
        self.assertEqual(tuple(item["required"]), tl._OVERLAY_REQUIRED)
        self.assertFalse(item["additionalProperties"])
        for key, (lo, hi) in {"x": (0, 1), "y": (0, 1), "opacity": (0, 1),
                              "w": (tl.OVERLAY_W_MIN, tl.OVERLAY_W_MAX)}.items():
            prop = item["properties"][key]
            self.assertEqual((prop["minimum"], prop["maximum"], prop["default"]),
                             (lo, hi, tl.OVERLAY_DEFAULTS[key]), key)
        self.assertEqual(item["properties"]["asset_id"]["$ref"], "#/$defs/asset_id")

    def test_document_and_render_spec_agree_on_the_limits(self):
        self.assertEqual(rs.MAX_PICTURE_OVERLAYS, tl.MAX_OVERLAYS)
        self.assertEqual(rs.MAX_PICTURE_VIDEOS, tl.MAX_OVERLAY_VIDEOS)
        self.assertEqual((rs.PICTURE_W_MIN, rs.PICTURE_W_MAX), (tl.OVERLAY_W_MIN, tl.OVERLAY_W_MAX))
        self.assertEqual(set(rs.PICTURE_KINDS), set(tl.OVERLAY_ASSET_KINDS))

    def test_the_editor_module_has_the_same_limits(self):
        ts = EDITOR_TS.read_text(encoding="utf-8")
        found = {m[0]: float(m[1]) for m in re.findall(r"export const (MAX_OVERLAYS|MAX_OVERLAY_VIDEOS"
                                                         r"|OVERLAY_W_MIN|OVERLAY_W_MAX) = ([\d.]+);", ts)}
        self.assertEqual(found, {"MAX_OVERLAYS": tl.MAX_OVERLAYS,
                                 "MAX_OVERLAY_VIDEOS": tl.MAX_OVERLAY_VIDEOS,
                                 "OVERLAY_W_MIN": tl.OVERLAY_W_MIN, "OVERLAY_W_MAX": tl.OVERLAY_W_MAX})
        defaults = re.search(r"OVERLAY_DEFAULTS = \{([^}]*)\}", ts).group(1)
        self.assertEqual({k: float(v) for k, v in re.findall(r"(\w+):\s*([\d.]+)", defaults)},
                         tl.OVERLAY_DEFAULTS)
        keys = re.search(r"const OVERLAY_KEYS = \[\s*\.\.\.OVERLAY_REQUIRED,\s*([^\]]*)\]", ts).group(1)
        self.assertEqual(tuple(re.findall(r'"(\w+)"', keys)), tl._OVERLAY_KEYS[len(tl._OVERLAY_REQUIRED):])

    def test_the_editor_ranges_file_has_the_same_ranges(self):
        ts = OVERLAY_TS.read_text(encoding="utf-8")
        for key, lo, hi in (("x", 0, 1), ("y", 0, 1), ("opacity", 0, 1)):
            m = re.search(rf"{key}: \{{ min: ([\d.]+), max: ([\d.]+), neutral", ts)
            self.assertEqual((float(m.group(1)), float(m.group(2))), (lo, hi), key)
        self.assertIn("min: OVERLAY_W_MIN", ts)
        self.assertIn("max: OVERLAY_W_MAX", ts)


# ── the files ───────────────────────────────────────────────────────────────

def assets_table(**extra):
    table = {
        BASE: tl.ResolvedAsset(BASE, "video", "/media/base.mp4", 20.0, False),
        PIC: tl.ResolvedAsset(PIC, "image", "/media/pic.png", None),
        PIC2: tl.ResolvedAsset(PIC2, "image", "/media/pic2.png", None),
        VID: tl.ResolvedAsset(VID, "video", "/media/ov.mp4", 6.0, True),
        SND: tl.ResolvedAsset(SND, "audio", "/media/song.mp3", 30.0),
    }
    table.update(extra)
    return table


class AssetsTestCase(unittest.TestCase):
    def resolve(self, doc, table=None):
        return tl.resolve_assets(tl.load(doc), (table or assets_table()).get)

    def problems(self, doc, table=None):
        with self.assertRaises(tl.TimelineError) as cm:
            self.resolve(doc, table)
        return cm.exception.problems

    def test_a_picture_and_a_video_may_be_overlays(self):
        found = self.resolve(doc_with([ov(), ov(id="o2", asset_id=VID, start_s=0, end_s=5)]))
        self.assertEqual(set(found), {BASE, PIC, VID})

    def test_an_unavailable_overlay_file_is_refused_not_skipped(self):
        table = {k: v for k, v in assets_table().items() if k != PIC}
        self.assertTrue(any(f"asset {PIC} is not available" in p
                            for p in self.problems(doc_with([ov()]), table)))

    def test_a_sound_is_not_an_overlay(self):
        self.assertTrue(any("an overlay takes video or image" in p
                            for p in self.problems(doc_with([ov(asset_id=SND)]))))

    def test_a_file_without_a_local_path_is_refused(self):
        for path in ("http://x/y.png", "concat:a|b", "relative.png", "/a\nb.png", ""):
            table = assets_table(**{PIC: tl.ResolvedAsset(PIC, "image", path)})
            self.assertTrue(any("no local file" in p for p in self.problems(doc_with([ov()]), table)),
                            path)

    def test_a_video_overlay_must_be_at_least_as_long_as_its_span(self):
        self.resolve(doc_with([ov(asset_id=VID, start_s=0, end_s=6)]))
        self.assertTrue(any("is only 6.0 s long" in p
                            for p in self.problems(doc_with([ov(asset_id=VID, start_s=0, end_s=7)]))))
        # a picture has no length
        self.resolve(doc_with([ov(start_s=0, end_s=100)], out_s=10))

    def test_at_most_four_video_overlays(self):
        four = [ov(id=f"o{i}", asset_id=VID, start_s=0, end_s=2) for i in range(4)]
        self.resolve(doc_with(four))
        five = four + [ov(id="o5", asset_id=VID, start_s=0, end_s=2)]
        self.assertTrue(any("at most 4 video overlays" in p for p in self.problems(doc_with(five))))
        # pictures do not count against it
        self.resolve(doc_with(four + [ov(id=f"p{i}") for i in range(10)]))


# ── the spec ────────────────────────────────────────────────────────────────

def spec_of(doc, table=None):
    return tr.to_render_spec(doc, (table or assets_table()).get, "/out/x.mp4")


class SpecTestCase(unittest.TestCase):
    def test_overlays_become_picture_overlays_on_the_frame_grid(self):
        spec = spec_of(doc_with([ov(start_s=1.01, end_s=3.02, x=0.25, y=0.75, w=0.4, opacity=0.5),
                                 ov(id="o2", asset_id=VID, start_s=0, end_s=2)]))
        a, b = spec.picture_overlays
        self.assertEqual((a.kind, a.path, a.x, a.y, a.w, a.opacity),
                         ("image", "/media/pic.png", 0.25, 0.75, 0.4, 0.5))
        self.assertEqual((a.start_s, a.end_s), (30 / 30, 91 / 30), "frames 30..90 at 30 fps")
        self.assertEqual((b.kind, b.path, b.start_s, b.end_s), ("video", "/media/ov.mp4", 0.0, 2.0))
        self.assertEqual(spec.overlays, [], "text overlays are a different list")

    def test_what_shows_nothing_is_left_out(self):
        spec = spec_of(doc_with([ov(opacity=0),                         # invisible
                                 ov(id="o2", start_s=4, end_s=6),       # after the picture
                                 ov(id="o3", start_s=5, end_s=6),
                                 ov(id="o4", start_s=3, end_s=9)], out_s=4))  # cut at the end
        self.assertEqual([(o.start_s, o.end_s) for o in spec.picture_overlays], [(3.0, 4.0)])

    def test_the_list_order_is_kept(self):
        spec = spec_of(doc_with([ov(id="b", asset_id=PIC2), ov(id="a")]))
        self.assertEqual([o.path for o in spec.picture_overlays], ["/media/pic2.png", "/media/pic.png"])

    def test_the_spec_round_trips_and_a_spec_without_them_is_the_dict_it_was(self):
        spec = spec_of(doc_with([ov(opacity=0.25)]))
        again = rs.RenderSpec.from_dict(json.loads(json.dumps(spec.to_dict())))
        self.assertEqual(again.picture_overlays, spec.picture_overlays)
        self.assertNotIn("picture_overlays", spec_of(doc_with()).to_dict())
        self.assertNotIn("picture_overlays", spec_of(doc_with([])).to_dict())

    def test_a_spec_is_refused_for_what_would_not_render(self):
        base = rs.PictureOverlay(path="/m/p.png", kind="image", start_s=1, end_s=2)
        spec = spec_of(doc_with())

        def problems(*overlays):
            return rs.validate(rs.RenderSpec(**{**spec.__dict__, "picture_overlays": list(overlays)}))

        self.assertEqual(problems(base), [])
        from dataclasses import replace
        for change, needle in (({"kind": "audio"}, "must be an image or a video"),
                               ({"path": ""}, "has no path"),
                               ({"end_s": 1}, "must end after it starts"),
                               ({"start_s": -1}, "must end after it starts"),
                               ({"end_s": 1.01}, "shorter than one frame"),
                               ({"x": 1.1}, "position must be fractions"),
                               ({"y": -0.1}, "position must be fractions"),
                               ({"w": 0.04}, "width must be from"),
                               ({"w": 1.5}, "width must be from"),
                               ({"opacity": 2}, "opacity must be from 0 to 1"),
                               ({"opacity": float("nan")}, "non-finite"),
                               ({"x": 10 ** 400}, "non-finite"),
                               ({"w": float("inf")}, "non-finite")):
            self.assertTrue(any(needle in p for p in problems(replace(base, **change))), change)
        self.assertTrue(any("at most 16" in p for p in problems(*[base] * 17)))
        vids = [replace(base, kind="video")] * 5
        self.assertTrue(any("at most 4 video overlays" in p for p in problems(*vids)))


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


def neutral_docs():
    """Documents that exercise the older features, with NO overlays. The
    digests of their commands were captured from origin/main before overlays
    existed (LEGACY below, re-captured from origin/main after #452) — do not regenerate them from new code."""
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
    cues = {"cues": [{"id": "q1", "start_s": 0, "end_s": 1.5, "text": "Caption"}]}
    return {
        "one clip": timeline([clip(1)]),
        "clip and still": timeline([clip(1), clip(2, PIC, 2.0, 3.0)]),
        "cover and fades": timeline([clip(1, fit="cover", fade_in_s=0.5, fade_out_s=0.5)]),
        "speed and sound": timeline([clip(1, speed=2.0, audio=True, out=4.0)]),
        "crossfade": timeline([clip(1), clip(2, BASE, 1.5, 2.0,
                                             transition={"type": "crossfade", "duration_s": 0.5})]),
        "dip to black": timeline([clip(1), clip(2, PIC, 2.0, 2.0,
                                               transition={"type": "dip_to_black", "duration_s": 0.6})]),
        "graded": timeline([clip(1, grade={"brightness": 0.1, "contrast": 1.2, "saturation": 0.8})]),
        "music and ducking": timeline([clip(1, audio=True)], [music, ducked]),
        "text and captions": timeline([clip(1)], [text], cues),
        "portrait 24 fps": timeline([clip(1)], [music, text], width=1080, height=1920, fps=24),
        "square 60 fps with a gap": timeline([clip(1), clip(2, PIC, 3.0, 1.0)], width=1080,
                                             height=1080, fps=60),
    }


#: sha256[:16] of json(all_commands(doc)) for neutral_docs(), captured from
#: origin/main (b79c0066, after #452: every capped command carries -protocol_whitelist
#: file) WITHOUT this change. Do not regenerate from new code.
LEGACY = {
    "one clip": "9776f998e8de68c3",
    "clip and still": "5aa4046d3ac455ec",
    "cover and fades": "dfa5e9356666afd1",
    "speed and sound": "9da616afec6732b5",
    "crossfade": "d93e8cd3f9962064",
    "dip to black": "bd29994cfad44a32",
    "graded": "d604c9357d28a7df",
    "music and ducking": "524d2b1ab4038043",
    "text and captions": "46e99487e0cf3c4a",
    "portrait 24 fps": "f8567db7db4bd8ec",
    "square 60 fps with a gap": "fc57d4a57d07fdfe",
}


class NeutralTestCase(unittest.TestCase):
    """No overlay, no change: not by promise, by comparison."""

    def test_documents_without_overlays_render_the_commands_they_always_did(self):
        for name, doc in neutral_docs().items():
            with self.subTest(name):
                self.assertEqual(digest(doc), LEGACY[name])

    def test_an_empty_list_an_invisible_overlay_and_one_after_the_end_change_nothing(self):
        for name, doc in neutral_docs().items():
            base = all_commands(doc)
            for label, overlays in (
                    ("empty", []),
                    ("opacity 0", [ov(opacity=0)]),
                    ("after the end", [ov(start_s=500, end_s=501)]),
                    ("both", [ov(opacity=0), ov(id="o2", start_s=500, end_s=501)])):
                with self.subTest(f"{name}: {label}"):
                    doc2 = copy.deepcopy(doc)
                    doc2["overlays"] = copy.deepcopy(overlays)
                    self.assertEqual(all_commands(doc2), base)
                    # ... and they are main's commands, byte for byte
                    self.assertEqual(digest(doc2), LEGACY[name])

    def test_overlays_change_only_the_final_pass(self):
        for name, doc in neutral_docs().items():
            doc2 = copy.deepcopy(doc)
            doc2["overlays"] = [ov(start_s=0.1, end_s=0.5)]
            before, after = all_commands(doc), all_commands(doc2)
            with self.subTest(name):
                self.assertEqual(after[0][:-1], before[0][:-1], "every segment is the one it was")
                self.assertNotEqual(after[0][-1], before[0][-1])


class CommandTestCase(unittest.TestCase):
    def final(self, overlays, table=None, **top):
        spec = spec_of(doc_with(overlays, **top), table)
        return rs.build_ffmpeg_command(spec, "/w/concat.txt", "/w/overlays.ass")

    @staticmethod
    def graph(cmd):
        return cmd[cmd.index("-filter_complex") + 1]

    @staticmethod
    def inputs(cmd):
        return [cmd[i + 1] for i, t in enumerate(cmd) if t == "-i"]

    def test_the_inputs_follow_the_audio_tracks_whose_indexes_stay(self):
        doc = doc_with([ov(), ov(id="o2", asset_id=VID, start_s=0, end_s=2)])
        doc["tracks"].append({"id": "a1", "kind": "A", "clips": [
            {"id": "m1", "asset_id": SND, "start_s": 0, "in_s": 0, "out_s": 3}]})
        cmd = rs.build_ffmpeg_command(spec_of(doc), "/w/concat.txt", None)
        self.assertEqual(self.inputs(cmd), ["/w/concat.txt", "/media/song.mp3", "/media/pic.png",
                                           "/media/ov.mp4"])
        graph = self.graph(cmd)
        self.assertIn("[1:a]atrim", graph, "the music is still input 1")
        self.assertTrue(graph.startswith("[2:v]"), graph)
        self.assertIn(";[3:v]setpts", graph)

    def test_a_video_overlay_is_silent_and_read_for_its_span_only(self):
        cmd = self.final([ov(asset_id=VID, start_s=1, end_s=3.5)])
        i = cmd.index("/media/ov.mp4")
        before = cmd[:i]
        self.assertEqual(before[before.index("-an"):before.index("-an") + 2], ["-an", "-t"])
        self.assertEqual(before[before.index("-an") + 2], "2.500")
        self.assertNotIn("-an", self.final([ov()]), "a still has no sound to switch off")
        self.assertNotIn("[1:a]", self.graph(cmd))
        self.assertNotIn("-c:a", cmd, "no audio stream at all")

    def test_decoder_caps_follow_the_kind(self):
        cmd = self.final([ov(), ov(id="o2", asset_id=VID, start_s=0, end_s=2)])
        def cap(path):
            # the value after the -max_pixels that sits before this input's -i
            head = cmd[:cmd.index(path)]
            return head[len(head) - 1 - head[::-1].index("-max_pixels") + 1]
        self.assertEqual(cap("/media/pic.png"), str(rs.decoder_max_pixels(rs.DECODE_MAX_PIXELS)))
        self.assertEqual(cap("/media/ov.mp4"), str(rs.decoder_max_pixels(rs.DECODE_VIDEO_MAX_PIXELS)))

    def test_the_overlay_goes_over_the_picture_and_under_the_text(self):
        doc = doc_with([ov()])
        doc["tracks"].append({"id": "t1", "kind": "T", "clips": [
            {"id": "x1", "start_s": 0, "end_s": 2, "text": "Hi"}]})
        graph = self.graph(rs.build_ffmpeg_command(spec_of(doc), "/w/concat.txt", "/w/overlays.ass"))
        self.assertLess(graph.index("overlay="), graph.index("subtitles="))
        self.assertIn("[0:v][p0]overlay=", graph)
        self.assertRegex(graph, r"\[pv0\]subtitles='/w/overlays\.ass'\[vout\]")

    def test_the_graph_for_a_still(self):
        graph = self.graph(self.final([ov(start_s=1, end_s=3, x=0.25, y=0.75, w=0.5, opacity=0.5)]))
        self.assertEqual(
            graph,
            "[1:v]trim=end_frame=1,setpts=PTS-STARTPTS,"
            "scale=640:1440:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,"
            "format=rgba,colorchannelmixer=aa=0.500,"
            "scale=out_color_matrix=bt709:out_range=tv:flags=bicubic,format=yuva420p,"
            "fps=30,tpad=stop=59:stop_mode=clone,setpts=PTS+30/(30*TB)[p0];"
            "[0:v][p0]overlay=x='round(320.000-w/2)':y='round(540.000-h/2)'"
            ":enable='between(t,0.983333,2.983333)':eof_action=pass[pv0]")

    def test_opaque_overlays_skip_the_alpha_multiply_and_an_opaque_video_skips_rgb(self):
        still = self.graph(self.final([ov(opacity=1)]))
        self.assertNotIn("colorchannelmixer", still)
        self.assertIn("format=rgba,scale=out_color_matrix", still, "a picture's own alpha is kept")
        video = self.graph(self.final([ov(asset_id=VID, opacity=1)]))
        self.assertNotIn("rgba", video, "an opaque video stays in its own YUV")
        self.assertIn("format=yuva420p", video)
        faded = self.graph(self.final([ov(asset_id=VID, opacity=0.4)]))
        self.assertIn("format=rgba,colorchannelmixer=aa=0.400,", faded)

    def test_small_frames_are_left_to_the_default_matrix(self):
        self.assertNotIn("out_color_matrix", self.graph(self.final([ov()], width=640, height=360)))
        self.assertIn("out_color_matrix=bt709", self.graph(self.final([ov()], width=360, height=720)))

    def test_numbers_are_formatted_with_fixed_precision_never_pasted(self):
        graph = self.graph(self.final([ov(x=0.123456789, y=1 / 3, w=0.1 + 0.2, opacity=0.1 + 0.2)]))
        for number in re.findall(r"\d+\.\d+", graph):
            self.assertLessEqual(len(number.split(".")[1]), 6, number)
        self.assertIn("aa=0.300", graph)
        self.assertNotIn("0.30000000000000004", graph)

    def test_no_document_text_reaches_the_graph_and_a_path_is_only_an_argument(self):
        nasty = "/media/it's;[x]=,\"q\".png"
        table = assets_table(**{PIC: tl.ResolvedAsset(PIC, "image", nasty)})
        cmd = self.final([ov()], table)
        self.assertIn(nasty, cmd)
        self.assertNotIn("it's", self.graph(cmd))
        # ids, asset ids and every string of the document stay out of it as well
        graph = self.graph(self.final([ov(id="o_marker-1")]))
        self.assertNotIn("marker", graph)
        self.assertNotIn(PIC, graph)
        for bad in ("0.1;movie=/etc/passwd", "0.1,eq", "a'b"):
            with self.assertRaises(tl.TimelineError):
                spec_of(doc_with([ov(x=bad)]))

    def test_a_picture_far_too_tall_cannot_ask_for_an_enormous_frame(self):
        graph = self.graph(self.final([ov(w=1)]))
        self.assertIn("scale=1280:1440:force_original_aspect_ratio=decrease", graph)

    def test_many_overlays_chain_in_list_order(self):
        overlays = [ov(id=f"o{i}", start_s=i / 10, end_s=2) for i in range(tl.MAX_OVERLAYS)]
        graph = self.graph(self.final(overlays))
        for i in range(tl.MAX_OVERLAYS):
            src = "[0:v]" if i == 0 else f"[pv{i - 1}]"
            self.assertIn(f"{src}[p{i}]overlay=", graph)
        self.assertTrue(graph.endswith(f"[pv{tl.MAX_OVERLAYS - 1}]"))
        self.assertEqual(len(graph.split(";")), 2 * tl.MAX_OVERLAYS)


# ── real ffmpeg ─────────────────────────────────────────────────────────────

def _ffmpeg():
    exe = render_backend.resolve_ffmpeg()
    try:
        ok = subprocess.run([exe, "-version"], capture_output=True).returncode == 0
    except OSError:
        return None
    return exe if ok else None


def png_rgba(w, h, row):
    """A w x h 8-bit RGBA PNG (stdlib only); ``row(y)`` -> the w * 4 bytes of row y."""
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + row(y) for y in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def flat_png(w, h, rgba):
    one = bytes(rgba) * w
    return png_rgba(w, h, lambda y: one)


#: The patch: 2:1, its left half opaque and its right half fully transparent.
#: Large enough that every export below SHRINKS it (a sharp edge stays sharp).
PATCH_RGB = (210, 60, 40)
PATCH_W, PATCH_H = 1600, 800


def patch_png():
    half = PATCH_W // 2
    one = bytes((*PATCH_RGB, 255)) * half + bytes((0, 0, 255, 0)) * (PATCH_W - half)
    return png_rgba(PATCH_W, PATCH_H, lambda y: one)


#: Per channel, of 255, between the export and the preview's arithmetic for
#: colour: a patch is converted RGB -> YUV 4:2:0 (rounding, chroma subsampling)
#: and the encoder quantises it. Measured on ffmpeg 7.0.2: about 3-4 for a
#: flat patch in an HD frame, a little more in the small frame (default matrix).
TOL_COLOUR = 6
#: In whole pixels, between each EDGE of the exported patch and the preview's
#: rectangle: the export's size is rounded to an even number and its position
#: to a whole pixel that ``overlay`` aligns to the chroma grid (2 px); the
#: scaler's own edge row/column adds one.
TOL_EDGE = 2
#: Level in a flat region of the base: the encoder's noise.
TOL_FLAT = 5


def preview_rect(frame_w, frame_h, asset_w, asset_h, x, y, w):
    """The preview's rectangle in frame pixels (editorOverlay.ts ``overlayRect``)."""
    width = w * frame_w
    height = width / (asset_w / asset_h)
    return (x * frame_w - width / 2, y * frame_h - height / 2, width, height)


class _Real(unittest.TestCase):
    def setUp(self):
        self.ffmpeg = _ffmpeg()
        if not self.ffmpeg:
            self.skipTest("ffmpeg not available")
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.n = 0
        self._assets = {}

    def tearDown(self):
        self.tmp.cleanup()

    def run_ffmpeg(self, *args):
        proc = subprocess.run([self.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *args],
                              capture_output=True)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode()[-500:])
        return proc.stdout

    def base_video(self, name="base", size="1280x720", seconds=4, fps=30, rgb="0x808080", audio=False):
        path = self.dir / f"{name}.mp4"
        args = ["-f", "lavfi", "-i", f"color=c={rgb}:s={size}:r={fps}:d={seconds}"]
        if audio:
            args += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]
        args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", *(["-c:a", "aac"] if audio else []),
                 str(path)]
        self.run_ffmpeg(*args)
        return tl.ResolvedAsset(BASE, "video", str(path), float(seconds), audio)

    def png(self, name, data):
        path = self.dir / f"{name}.png"
        path.write_bytes(data)
        return tl.ResolvedAsset(PIC, "image", str(path))

    def overlay_video(self, name="ov", size="320x160", rgb="0x00c800", seconds=3, fps=25, audio=True):
        path = self.dir / f"{name}.mp4"
        args = ["-f", "lavfi", "-i", f"color=c={rgb}:s={size}:r={fps}:d={seconds}"]
        if audio:
            args += ["-f", "lavfi", "-i", f"sine=frequency=1000:duration={seconds}"]
        args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", *(["-c:a", "aac"] if audio else []),
                 str(path)]
        self.run_ffmpeg(*args)
        return tl.ResolvedAsset(VID, "video", str(path), float(seconds), audio)

    def export(self, doc, table, **kw):
        self.n += 1
        out = self.dir / f"out{self.n}.mp4"
        tr.render(doc, table.get, str(out), **kw)
        return out

    def frames(self, path, size, indexes, matrix):
        """The rgb24 bytes of the given frames, decoded with the named YUV matrix."""
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
    def diff_box(raw, base, w, h, thr):
        """The bounding box (x0, y0, x1, y1 inclusive) of the pixels where the two
        frames differ by more than ``thr`` in some channel, and how many."""
        x0 = y0 = None
        x1 = y1 = -1
        count = 0
        for y in range(h):
            a, b = raw[y * w * 3:(y + 1) * w * 3], base[y * w * 3:(y + 1) * w * 3]
            if a == b:
                continue
            for x in range(w):
                i = x * 3
                if (abs(a[i] - b[i]) > thr or abs(a[i + 1] - b[i + 1]) > thr
                        or abs(a[i + 2] - b[i + 2]) > thr):
                    count += 1
                    x0 = x if x0 is None or x < x0 else x0
                    y0 = y if y0 is None else y0
                    x1 = max(x1, x)
                    y1 = y
        return (x0, y0, x1, y1), count

    def assert_same(self, a, b, size, label, thr=3):
        """Two frames of the same picture: the encoder's noise (a pixel or two by a
        level or two), nothing more. Byte equality is not asked of two encodes."""
        _box, n = self.diff_box(a, b, size[0], size[1], thr)
        self.assertEqual(n, 0, f"{label}: {n} pixels differ by more than {thr}")

    def assert_differs(self, a, b, size, label, thr=3):
        _box, n = self.diff_box(a, b, size[0], size[1], thr)
        self.assertGreater(n, 0, label)

    def matrix_for(self, w, h):
        return "bt709" if (h >= 720 or w >= 1280) else "bt601"

    def blend(self, src, base, alpha):
        return tuple(alpha * s + (1 - alpha) * b for s, b in zip(src, base))

    def assert_close(self, got, want, tol, label):
        gap = max(abs(g - t) for g, t in zip(got, want))
        self.assertLessEqual(gap, tol, f"{label}: got {got}, want about {tuple(round(v) for v in want)}")
        return gap


class StillOverlayTestCase(_Real):
    def measure(self, size, x, y, w, opacity, start=1.0, end=3.0, fps=30, label=""):
        fw, fh = size
        table = {BASE: self.base_video(size=f"{fw}x{fh}", fps=fps), PIC: self.png("patch", patch_png())}
        with_ov = self.export(doc_with([ov(start_s=start, end_s=end, x=x, y=y, w=w, opacity=opacity)],
                                       width=fw, height=fh, fps=fps), table)
        without = self.export(doc_with(None, width=fw, height=fh, fps=fps), table)
        first, last = round(start * fps), round(end * fps)
        idx = [first - 1, first, first + 1, (first + last) // 2, last - 1, last]
        m = self.matrix_for(fw, fh)
        a, b = self.frames(with_ov, size, idx, m), self.frames(without, size, idx, m)
        # the window: exactly frames first .. last-1
        for i in (first - 1, last):
            self.assert_same(a[i], b[i], size, f"{label}: frame {i} is outside the span and must be the base")
        thr = 12 if opacity >= 0.5 else 6
        for i in (first, first + 1, (first + last) // 2, last - 1):
            box, n = self.diff_box(a[i], b[i], fw, fh, thr)
            self.assertGreater(n, 0, f"{label}: frame {i} shows no overlay")
        return a, b, idx, first, last, m

    def check_geometry(self, size, x, y, w, opacity):
        fw, fh = size
        a, b, idx, first, last, _m = self.measure(size, x, y, w, opacity, label=f"{size} {x},{y},{w}")
        mid = (first + last) // 2
        left, top, width, height = preview_rect(fw, fh, PATCH_W, PATCH_H, x, y, w)
        # the visible (left, opaque) half of the patch is the left half of the rectangle
        want = (left, top, left + width / 2, top + height)
        # clip to the frame: an overlay may leave it
        want = (max(0, want[0]), max(0, want[1]), min(fw, want[2]), min(fh, want[3]))
        thr = 12 if opacity >= 0.5 else 6
        (x0, y0, x1, y1), n = self.diff_box(a[mid], b[mid], fw, fh, thr)
        got = (x0, y0, x1 + 1, y1 + 1)
        worst_edge = 0.0
        for g, t, edge in zip(got, want, ("left", "top", "right", "bottom")):
            worst_edge = max(worst_edge, abs(g - t))
            self.assertLessEqual(abs(g - t), TOL_EDGE, f"{size} {x},{y},{w}: {edge} edge {g} vs {t:.1f}")
        # opacity: the middle of the opaque half is the blend of the PNG's colour and the base
        cx, cy = int((want[0] + want[2]) / 2), int((want[1] + want[3]) / 2)
        gap = self.assert_close(self.px(a[mid], fw, cx, cy),
                                self.blend(PATCH_RGB, self.px(b[mid], fw, cx, cy), opacity),
                                TOL_COLOUR, f"{size} opacity {opacity} colour")
        print(f"[overlay parity] {size} x={x} y={y} w={w} opacity={opacity}: "
              f"edges off by {worst_edge:.1f} px, colour off by {gap:.1f} / 255")
        # the transparent half shows the base: a point inside the rectangle's right half
        rx = int(left + width * 0.75)
        if 0 <= rx < fw and 0 <= cy < fh:
            self.assert_close(self.px(a[mid], fw, rx, cy), self.px(b[mid], fw, rx, cy),
                              TOL_FLAT, f"{size} transparent half")
        # outside the rectangle (8 px away) nothing changed
        ox = min(fw - 1, int(want[2]) + 8)
        if ox < fw - 1:
            self.assert_close(self.px(a[mid], fw, ox, cy), self.px(b[mid], fw, ox, cy), TOL_FLAT, "outside")

    def test_hd_landscape_centre_opaque(self):
        self.check_geometry((1280, 720), 0.5, 0.5, 0.5, 1.0)

    def test_hd_landscape_corner_half_opaque(self):
        self.check_geometry((1280, 720), 0.8, 0.2, 0.3, 0.5)

    def test_hd_landscape_faint(self):
        self.check_geometry((1280, 720), 0.3, 0.6, 0.4, 0.25)

    def test_small_frame_uses_the_default_matrix_and_still_matches(self):
        self.check_geometry((640, 360), 0.5, 0.5, 0.5, 1.0)
        self.check_geometry((640, 360), 0.25, 0.75, 0.4, 0.6)

    def test_portrait_frame(self):
        self.check_geometry((720, 1280), 0.5, 0.4, 0.6, 0.8)

    def test_an_overlay_leaving_the_frame_is_clipped_not_refused(self):
        self.check_geometry((640, 360), 0.95, 0.5, 0.4, 1.0)
        self.check_geometry((640, 360), 0.5, 0.02, 0.4, 1.0)

    def test_the_full_width_overlay(self):
        self.check_geometry((640, 360), 0.5, 0.5, 1.0, 1.0)

    def test_the_span_is_frame_exact_at_other_frame_rates(self):
        for fps in (24, 25, 60):
            with self.subTest(fps):
                self.measure((640, 360), 0.5, 0.5, 0.5, 1.0, start=1.0, end=2.5, fps=fps,
                             label=f"{fps} fps")

    def test_a_span_that_is_not_on_the_frame_grid_rounds_like_the_clips_do(self):
        # 1.02 s -> frame 31 (30.6), 2.98 s -> frame 89 (89.4) at 30 fps
        fw, fh = 640, 360
        table = {BASE: self.base_video(size=f"{fw}x{fh}"), PIC: self.png("patch", patch_png())}
        out = self.export(doc_with([ov(start_s=1.02, end_s=2.98, w=0.5)], width=fw, height=fh), table)
        base = self.export(doc_with(None, width=fw, height=fh), table)
        a, b = self.frames(out, (fw, fh), [30, 31, 88, 89], "bt601"), self.frames(base, (fw, fh), [30, 31, 88, 89], "bt601")
        size = (fw, fh)
        self.assert_same(a[30], b[30], size, "frame 30")
        self.assert_differs(a[31], b[31], size, "frame 31")
        self.assert_differs(a[88], b[88], size, "frame 88")
        self.assert_same(a[89], b[89], size, "frame 89")

    def test_an_overlay_running_past_the_picture_is_cut_and_does_not_lengthen_it(self):
        fw, fh = 640, 360
        table = {BASE: self.base_video(size=f"{fw}x{fh}", seconds=4), PIC: self.png("patch", patch_png())}
        out = self.export(doc_with([ov(start_s=3, end_s=60, w=0.5)], width=fw, height=fh, out_s=4), table)
        count = subprocess.run([self.ffmpeg, "-hide_banner", "-i", str(out), "-map", "0:v:0",
                                "-f", "null", "-"], capture_output=True, text=True).stderr
        self.assertRegex(count, r"frame=\s*120\b", "the export is the picture's 4 s, 120 frames")
        frames = self.frames(out, (fw, fh), [89, 90, 119], "bt601")
        base = self.frames(self.export(doc_with(None, width=fw, height=fh), table), (fw, fh), [89, 90, 119], "bt601")
        size = (fw, fh)
        self.assert_same(frames[89], base[89], size, "frame 89")
        self.assert_differs(frames[90], base[90], size, "frame 90")
        self.assert_differs(frames[119], base[119], size, "frame 119")

    def test_a_later_overlay_is_drawn_on_top_of_an_earlier_one(self):
        fw, fh = 640, 360
        red = self.png("red", flat_png(400, 400, (220, 20, 20, 255)))
        green = tl.ResolvedAsset(PIC2, "image", str(self.dir / "green.png"))
        (self.dir / "green.png").write_bytes(flat_png(400, 400, (20, 200, 20, 255)))
        table = {BASE: self.base_video(size=f"{fw}x{fh}"), PIC: red, PIC2: green}

        def centre(first, second):
            doc = doc_with([ov(id="a", asset_id=first, x=0.5, y=0.5, w=0.3),
                            ov(id="b", asset_id=second, x=0.5, y=0.5, w=0.3)], width=fw, height=fh)
            out = self.export(doc, table)
            return self.px(self.frames(out, (fw, fh), [45], "bt601")[45], fw, fw // 2, fh // 2)
        on_top_green = centre(PIC, PIC2)
        on_top_red = centre(PIC2, PIC)
        self.assertGreater(on_top_green[1], on_top_green[0] + 80, on_top_green)
        self.assertGreater(on_top_red[0], on_top_red[1] + 80, on_top_red)

    def test_a_very_tall_picture_renders_and_stays_inside_its_box(self):
        fw, fh = 640, 360
        tall = self.png("tall", flat_png(8, 4000, (220, 20, 20, 255)))
        table = {BASE: self.base_video(size=f"{fw}x{fh}"), PIC: tall}
        t0 = time.monotonic()
        out = self.export(doc_with([ov(w=0.5)], width=fw, height=fh), table)
        self.assertLess(time.monotonic() - t0, 60)
        a = self.frames(out, (fw, fh), [45], "bt601")[45]
        base = self.frames(self.export(doc_with(None, width=fw, height=fh), table), (fw, fh), [45], "bt601")[45]
        (x0, y0, x1, y1), n = self.diff_box(a, base, fw, fh, 20)
        self.assertGreater(n, 0)
        self.assertLessEqual(y1 - y0 + 1, fh, "no taller than the frame")

    def test_sixteen_pictures_render_in_reasonable_time(self):
        fw, fh = 640, 360
        table = {BASE: self.base_video(size=f"{fw}x{fh}"), PIC: self.png("patch", patch_png())}
        overlays = [ov(id=f"o{i}", start_s=0, end_s=3, x=(i % 4) / 4 + 0.125, y=(i // 4) / 4 + 0.125,
                       w=0.2) for i in range(16)]
        t0 = time.monotonic()
        out = self.export(doc_with(overlays, width=fw, height=fh), table)
        took = time.monotonic() - t0
        self.assertLess(took, 60, f"{took:.1f} s")
        a = self.frames(out, (fw, fh), [10], "bt601")[10]
        base = self.frames(self.export(doc_with(None, width=fw, height=fh), table), (fw, fh), [10], "bt601")[10]
        (x0, y0, x1, y1), n = self.diff_box(a, base, fw, fh, 12)
        self.assertGreater(n, 16 * 20 * 20)

    def test_the_production_path_with_its_memory_limit(self):
        # an editor export runs under ffmpeg_limits (address-space limit, decoder caps)
        fw, fh = 1280, 720
        table = {BASE: self.base_video(size=f"{fw}x{fh}"), PIC: self.png("patch", patch_png()),
                 VID: self.overlay_video()}
        overlays = [ov(w=0.5), ov(id="o2", asset_id=VID, start_s=0, end_s=2, x=0.2, y=0.8, w=0.3)]
        out = self.export(doc_with(overlays), table, timeout_s=120)
        a = self.frames(out, (fw, fh), [45], "bt709")[45]
        base = self.frames(self.export(doc_with(None), table), (fw, fh), [45], "bt709")[45]
        self.assertNotEqual(a, base)


class VideoOverlayTestCase(_Real):
    def test_a_video_overlay_shows_exactly_its_span_with_its_own_colour(self):
        fw, fh = 1280, 720
        table = {BASE: self.base_video(size=f"{fw}x{fh}"), VID: self.overlay_video(fps=25)}
        out = self.export(doc_with([ov(asset_id=VID, start_s=1, end_s=3, x=0.5, y=0.5, w=0.5)]), table)
        base = self.export(doc_with(None), table)
        idx = [29, 30, 60, 89, 90]
        a, b = self.frames(out, (fw, fh), idx, "bt709"), self.frames(base, (fw, fh), idx, "bt709")
        self.assert_same(a[29], b[29], (fw, fh), "frame 29")
        self.assert_same(a[90], b[90], (fw, fh), "frame 90")
        (x0, y0, x1, y1), n = self.diff_box(a[60], b[60], fw, fh, 20)
        left, top, width, height = preview_rect(fw, fh, 320, 160, 0.5, 0.5, 0.5)
        for g, t in zip((x0, y0, x1 + 1, y1 + 1), (left, top, left + width, top + height)):
            self.assertLessEqual(abs(g - t), TOL_EDGE, (g, t))
        # an opaque video overlay keeps its own colour: the same decode of the source file
        src = self.frames(self.dir / "ov.mp4", (320, 160), [10], "bt709")[10]
        self.assert_close(self.px(a[60], fw, fw // 2, fh // 2), self.px(src, 320, 160, 80),
                          TOL_COLOUR, "video colour")
        for i in (30, 89):
            self.assert_differs(a[i], b[i], (fw, fh), f"frame {i}", thr=20)

    def test_a_translucent_video_overlay_blends_with_the_picture(self):
        fw, fh = 640, 360
        table = {BASE: self.base_video(size=f"{fw}x{fh}"), VID: self.overlay_video(size="160x80")}
        out = self.export(doc_with([ov(asset_id=VID, start_s=0, end_s=2, w=0.5, opacity=0.5)],
                                   width=fw, height=fh), table)
        base = self.export(doc_with(None, width=fw, height=fh), table)
        a, b = (self.frames(p, (fw, fh), [20], "bt601")[20] for p in (out, base))
        c = (fw // 2, fh // 2)
        self.assert_close(self.px(a, fw, *c), self.blend((0, 200, 0), self.px(b, fw, *c), 0.5),
                          TOL_COLOUR, "half-opaque video")

    def test_the_overlay_videos_sound_is_never_in_the_export(self):
        fw, fh = 640, 360
        silent = self.base_video(size=f"{fw}x{fh}", audio=False)
        table = {BASE: silent, VID: self.overlay_video(size="160x80", audio=True)}
        out = self.export(doc_with([ov(asset_id=VID, start_s=0, end_s=2)], width=fw, height=fh), table)
        streams = subprocess.run([self.ffmpeg, "-hide_banner", "-i", str(out)], capture_output=True,
                                 text=True).stderr
        self.assertNotIn("Audio:", streams, "a silent picture plus an overlay video is still silent")
        # with music, the sound is the music's alone: the same samples with and without the overlay
        song = self.dir / "song.mp3"
        self.run_ffmpeg("-f", "lavfi", "-i", "sine=frequency=220:duration=4", str(song))
        table[SND] = tl.ResolvedAsset(SND, "audio", str(song), 4.0)
        track = {"id": "a1", "kind": "A", "clips": [
            {"id": "m1", "asset_id": SND, "start_s": 0, "in_s": 0, "out_s": 4}]}
        withov = doc_with([ov(asset_id=VID, start_s=0, end_s=2)], width=fw, height=fh)
        without = doc_with(None, width=fw, height=fh)
        for d in (withov, without):
            d["tracks"].append(copy.deepcopy(track))
        pcm = lambda p: self.run_ffmpeg("-i", str(p), "-map", "0:a", "-f", "s16le", "-")
        a, b = pcm(self.export(withov, table)), pcm(self.export(without, table))
        self.assertGreater(len(a), 100000)
        self.assertEqual(a, b, "the overlay changed the sound")

    def test_a_clip_with_its_own_sound_keeps_it(self):
        fw, fh = 640, 360
        table = {BASE: self.base_video(size=f"{fw}x{fh}", audio=True),
                 VID: self.overlay_video(size="160x80", audio=True)}
        withov, without = (doc_with(o, width=fw, height=fh) for o in ([ov(asset_id=VID, start_s=0, end_s=2)], None))
        for d in (withov, without):
            d["tracks"][0]["clips"][0]["audio"] = True
        pcm = lambda p: self.run_ffmpeg("-i", str(p), "-map", "0:a", "-f", "s16le", "-")
        a, b = pcm(self.export(withov, table)), pcm(self.export(without, table))
        self.assertGreater(len(a), 100000)
        self.assertEqual(a, b)


class TextOverTheOverlayTestCase(_Real):
    def test_captions_are_drawn_over_an_overlay(self):
        from modules import ass_captions
        if not ass_captions.has_libass(self.ffmpeg):
            self.skipTest("this ffmpeg has no libass")
        fw, fh = 640, 360
        red = self.png("red", flat_png(400, 400, (200, 20, 20, 255)))
        table = {BASE: self.base_video(size=f"{fw}x{fh}"), PIC: red}
        doc = doc_with([ov(w=1.0, x=0.5, y=0.5, start_s=0, end_s=3)], width=fw, height=fh)
        doc["captions"] = {"style": {"y": 0.5, "size": 120, "color": "#FFFFFF", "outline_width": 0},
                           "cues": [{"id": "q1", "start_s": 0, "end_s": 3, "text": "MMMM"}]}
        a = self.frames(self.export(doc, table), (fw, fh), [30], "bt601")[30]
        whites = sum(1 for i in range(0, len(a), 3) if min(a[i:i + 3]) > 200)
        self.assertGreater(whites, 500, "the caption is on top of the overlay")


# ── the preview's fixture ───────────────────────────────────────────────────

class FixtureTestCase(unittest.TestCase):
    def test_the_fixture_is_this_files_reference_formula(self):
        fx = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(fx["cases"]), 8)
        for case in fx["cases"]:
            f, a, o = case["frame"], case["asset"], case["overlay"]
            got = preview_rect(f["width"], f["height"], a["width"], a["height"], o["x"], o["y"], o["w"])
            for g, key in zip(got, ("left", "top", "width", "height")):
                self.assertAlmostEqual(g, case["rect"][key], places=6, msg=str(case))


if __name__ == "__main__":
    unittest.main()
