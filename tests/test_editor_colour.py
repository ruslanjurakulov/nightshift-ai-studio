"""A clip's colour grade (brightness, contrast, saturation), end to end.

The document holds ``color: {brightness, contrast, saturation}`` on a V clip
(modules/timeline.py COLOR_RANGES: -1..1, 0..2, 0..3; no field = no change).
The EXPORT applies the three numbers with ffmpeg ``eq`` (render_backend
``colour_grade``); the editor PREVIEW draws them as an SVG feColorMatrix used
as a CSS filter (command-center/lib/editorColour.ts ``colourMatrix``).

What is pinned here, by class:

* the document: ranges, strict fields, normalisation, split, the JSON schema;
* the argv: a clip without ``color`` (or with a neutral one) renders the SAME
  command lists as before colour existed; with one, ``eq`` is where it must be
  (before the pad so bars stay black, before the fades, on stills, on both
  sides of a cross-fade);
* the PARITY with the preview: real ffmpeg renders flat patches, and the
  pixels of the export are compared with the preview matrix applied to the
  ungraded export's pixels. The matrix is the one in
  samples/clip_colour_preview.json, which the TypeScript test
  (command-center/tests/editor-colour.test.ts) pins the preview to.

What the parity does NOT prove: that a browser draws a CSS filter with
identical pixels (it compares the arithmetic the browser is given with
ffmpeg's output; a Playwright check of the real preview was done separately),
the 8-bit rounding of every player, or colours near the gamut edge where
ffmpeg clips in YUV and the filter in RGB (probes stay inside it). Preview
and export are two renderers: the tolerance below is the honest gap.
Skipped cleanly when no ffmpeg runs.
"""

import copy
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import render_backend
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr

ROOT = Path(__file__).resolve().parent.parent
COLOUR_TS = ROOT / "command-center" / "lib" / "editorColour.ts"
FIXTURE = ROOT / "samples" / "clip_colour_preview.json"
ASSET = "11111111-1111-4111-8111-111111111111"
ASSET2 = "22222222-2222-4222-8222-222222222222"
GRADE = {"brightness": 0.2, "contrast": 1.3, "saturation": 0.7}

# ── the reference implementation of the preview's arithmetic ────────────────
# (editorColour.ts colourMatrix; the fixture ties the two together)
LUMA_601 = (0.299, 0.587, 0.114)
LUMA_709 = (0.2126, 0.7152, 0.0722)
EQ_BRIGHTNESS_GAIN = 255 / 219
EQ_CONTRAST_PIVOT = (127.5 - 16) / 219


def preview_matrix(color, still):
    """The 20 numbers of the preview's feColorMatrix for a grade."""
    w = LUMA_601 if still else LUMA_709
    b, c, s = color["brightness"], color["contrast"], color["saturation"]
    k = (1 - c) * EQ_CONTRAST_PIVOT + EQ_BRIGHTNESS_GAIN * b
    rows = []
    for ch in range(3):
        rows += [(s if ch == j else 0) + (c - s) * w[j] for j in range(3)] + [0, k]
    return rows + [0, 0, 0, 1, 0]


def apply_matrix(m, rgb):
    """What the browser's feColorMatrix does to an RGB pixel (0..255 in and out)."""
    v = [x / 255 for x in rgb]
    out = [m[r * 5] * v[0] + m[r * 5 + 1] * v[1] + m[r * 5 + 2] * v[2] + m[r * 5 + 4]
           for r in range(3)]
    return [min(255.0, max(0.0, o * 255)) for o in out]


def _ffmpeg():
    exe = render_backend.resolve_ffmpeg()
    try:
        ok = subprocess.run([exe, "-version"], capture_output=True).returncode == 0
    except OSError:
        return None
    return exe if ok else None


# ── the document ────────────────────────────────────────────────────────────

def doc_with(extra=None, **top):
    clip = {"id": "c1", "asset_id": ASSET, "start_s": 0, "in_s": 0, "out_s": 2}
    clip.update(extra or {})
    doc = tl.new_timeline("16:9")
    doc["tracks"][0]["clips"].append(clip)
    doc.update(top)
    return doc


class DocumentTestCase(unittest.TestCase):
    def problems(self, color):
        return tl.validate(doc_with({"color": color}))

    def test_a_grade_inside_every_range_is_valid_including_the_ends(self):
        for color in (GRADE,
                      {"brightness": -1, "contrast": 0, "saturation": 0},
                      {"brightness": 1, "contrast": 2, "saturation": 3},
                      {"brightness": 0, "contrast": 1, "saturation": 1}):
            self.assertEqual(self.problems(color), [], color)

    def test_a_clip_without_color_is_valid_and_unchanged_by_normalise(self):
        doc = doc_with()
        self.assertEqual(tl.validate(doc), [])
        self.assertNotIn("color", tl.normalise(doc)["tracks"][0]["clips"][0])

    def test_every_number_outside_its_range_is_refused_naming_the_field(self):
        for key, (lo, hi) in tl.COLOR_RANGES.items():
            for bad in (lo - 0.001, hi + 0.001, lo - 5, hi + 5):
                color = {**tl.COLOR_NEUTRAL, key: bad}
                problems = self.problems(color)
                self.assertTrue(any(f"color: {key} must be a number" in p for p in problems),
                                (key, bad, problems))

    def test_not_a_number_is_refused(self):
        for bad in ("0.1", True, None, [0], {"v": 1}, float("nan"), float("inf")):
            self.assertTrue(self.problems({**tl.COLOR_NEUTRAL, "contrast": bad}), bad)

    def test_the_shape_is_strict(self):
        self.assertTrue(any("saturation is missing" in p
                            for p in self.problems({"brightness": 0, "contrast": 1})))
        self.assertTrue(any("hue is not a known field" in p
                            for p in self.problems({**tl.COLOR_NEUTRAL, "hue": 5})))
        for bad in ([0, 1, 1], "none", 5, None):
            self.assertTrue(any("must be an object" in p for p in self.problems(bad)), bad)

    def test_color_belongs_to_picture_clips_only(self):
        doc = doc_with()
        doc["tracks"].append({"id": "a1", "kind": "A", "clips": [
            {"id": "m1", "asset_id": ASSET2, "start_s": 0, "in_s": 0, "out_s": 1,
             "color": dict(GRADE)}]})
        self.assertTrue(any("color is not a known field" in p for p in tl.validate(doc)))

    def test_normalise_rounds_to_milliseconds_and_drops_a_neutral_grade(self):
        norm = tl.normalise(doc_with({"color": {"brightness": 0.123456, "contrast": 1.2,
                                                 "saturation": 0.8}}))
        self.assertEqual(norm["tracks"][0]["clips"][0]["color"],
                         {"brightness": 0.123, "contrast": 1.2, "saturation": 0.8})
        neutral = tl.normalise(doc_with({"color": {"brightness": 0.0001, "contrast": 1.0004,
                                                    "saturation": 1}}))
        self.assertNotIn("color", neutral["tracks"][0]["clips"][0])
        # the same meaning, the same document
        self.assertEqual(neutral, tl.normalise(doc_with()))

    def test_a_split_keeps_the_grade_on_both_halves(self):
        doc = doc_with({"color": dict(GRADE)})
        out = tl.split_clip(doc, "c1", 1.0, "c2")
        self.assertEqual([c["color"] for c in out["tracks"][0]["clips"]], [GRADE, GRADE])

    def test_the_json_schema_names_the_same_ranges(self):
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        props = schema["$defs"]["color"]["properties"]
        self.assertEqual({k: (p["minimum"], p["maximum"], p["default"]) for k, p in props.items()},
                         {k: (*tl.COLOR_RANGES[k], tl.COLOR_NEUTRAL[k]) for k in tl.COLOR_RANGES})
        self.assertIn("color", schema["$defs"]["video_clip"]["properties"])

    def test_document_and_render_spec_agree_on_the_ranges(self):
        self.assertEqual(rs.COLOR_RANGES, tl.COLOR_RANGES)
        self.assertEqual(rs.COLOR_NEUTRAL, tl.COLOR_NEUTRAL)

    def test_the_editor_module_has_the_same_ranges(self):
        ts = COLOUR_TS.read_text(encoding="utf-8")
        found = {m[0]: (float(m[1]), float(m[2]), float(m[3])) for m in re.findall(
            r"(\w+):\s*\{\s*min:\s*(-?[\d.]+),\s*max:\s*(-?[\d.]+),\s*neutral:\s*(-?[\d.]+)", ts)}
        self.assertEqual(found, {k: (*tl.COLOR_RANGES[k], tl.COLOR_NEUTRAL[k])
                                 for k in tl.COLOR_RANGES})


# ── the argv ────────────────────────────────────────────────────────────────

ASSETS = {
    ASSET: tl.ResolvedAsset(ASSET, "video", "/media/a.mp4", 20.0, False),
    ASSET2: tl.ResolvedAsset(ASSET2, "image", "/media/i.png", None),
}


def spec_of(doc):
    return tr.to_render_spec(doc, ASSETS.get, "/out/x.mp4")


def commands(spec):
    return [render_backend.segment_commands("ffmpeg", s, Path(f"/w/seg_{i:04d}.mp4"), spec.width,
                                            spec.height, spec.fps, seed=s.seed or f"{i}:{s.path}",
                                            frame_exact=spec.frame_exact)
            for i, s in enumerate(spec.segments)]


def vf(cmd):
    return cmd[cmd.index("-vf") + 1] if "-vf" in cmd else cmd[cmd.index("-filter_complex") + 1]


EQ = "format=yuv420p,eq=brightness=0.200:contrast=1.300:saturation=0.700"


def mixed(extra_a=None, extra_b=None):
    """A video clip then a still, each optionally graded."""
    return {"version": 1, "width": 1280, "height": 720, "fps": 30, "tracks": [
        {"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": ASSET, "start_s": 0, "in_s": 1, "out_s": 3, **(extra_a or {})},
            {"id": "c2", "asset_id": ASSET2, "start_s": 2, "in_s": 0, "out_s": 2, **(extra_b or {})}]}]}


class CommandTestCase(unittest.TestCase):
    def test_no_color_and_a_neutral_color_render_the_commands_they_always_did(self):
        base = commands(spec_of(mixed()))
        neutral = {"color": {"brightness": 0, "contrast": 1, "saturation": 1}}
        self.assertEqual(commands(spec_of(mixed(neutral, neutral))), base)
        # tiny values that round to "no change" in the document
        near = {"color": {"brightness": 0.0004, "contrast": 1.0003, "saturation": 0.9996}}
        self.assertEqual(commands(spec_of(mixed(near, near))), base)
        self.assertNotIn("eq=", json.dumps(base))
        # ... and the spec itself is the dict it was (it is compared and cached elsewhere)
        for seg in spec_of(mixed(neutral, neutral)).segments:
            self.assertFalse({"brightness", "contrast", "saturation"} & set(seg.to_dict()))

    def test_a_graded_clip_changes_only_its_own_commands(self):
        base = commands(spec_of(mixed()))
        graded = commands(spec_of(mixed({"color": dict(GRADE)})))
        self.assertNotEqual(graded[0], base[0])
        self.assertEqual(graded[1:], base[1:], "the still next to it is untouched")

    def test_video_contain_grades_before_the_pad_so_the_bars_stay_black(self):
        (cmd,), = commands(spec_of(mixed({"color": dict(GRADE)})))[:1]
        self.assertEqual(
            vf(cmd),
            "scale=1280:720:force_original_aspect_ratio=decrease," + EQ
            + ",pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30")

    def test_video_cover_grades_the_cropped_frame_and_before_the_fades(self):
        doc = mixed({"color": dict(GRADE), "fit": "cover", "fade_out_s": 0.5})
        (cmd,), = commands(spec_of(doc))[:1]
        self.assertEqual(
            vf(cmd),
            "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=30," + EQ
            + ",fade=t=out:st=1.500:d=0.500")

    def test_a_still_is_graded_in_the_move_and_in_the_held_fallback(self):
        doc = mixed(extra_b={"color": dict(GRADE), "fade_in_s": 0.5})
        move, hold = commands(spec_of(doc))[1]
        self.assertIn("," + EQ + ",fade=t=in:st=0:d=0.500", vf(move))
        self.assertTrue(vf(move).rstrip().endswith("d=0.500"))
        self.assertEqual(
            vf(hold),
            "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=30," + EQ
            + ",fade=t=in:st=0:d=0.500")

    def test_both_sides_of_a_crossfade_carry_their_own_grade(self):
        doc = mixed({"color": dict(GRADE)},
                    {"start_s": 1, "transition": {"type": "crossfade", "duration_s": 1},
                     "color": {"brightness": -0.3, "contrast": 1, "saturation": 1}})
        xseg = next(s for s in spec_of(doc).segments if s.xfade is not None)
        self.assertEqual(xseg.contrast, 1.3)
        self.assertEqual(xseg.xfade.brightness, -0.3)
        move, hold = render_backend.segment_commands("ffmpeg", xseg, Path("/w/s.mp4"), 1280, 720, 30,
                                                     seed="s", frame_exact=True)
        for cmd in (move, hold):
            graph = vf(cmd)
            a, b = graph.split(";")[:2]
            self.assertIn(EQ, a)
            self.assertIn("eq=brightness=-0.300:contrast=1.000:saturation=1.000", b)
            self.assertNotIn("eq=", graph.split(";")[2], "the dissolve itself is not graded")

    def test_nothing_from_the_document_reaches_the_filter_as_text(self):
        # the numbers are validated floats formatted by the backend: a string never gets there
        for bad in ("0.1;movie=/etc/passwd", "0.1,eq", True, None):
            doc = mixed({"color": {"brightness": bad, "contrast": 1, "saturation": 1}})
            with self.assertRaises(tl.TimelineError):
                spec_of(doc)

    def test_a_spec_with_a_grade_out_of_range_is_refused(self):
        seg = rs.Segment(duration=1, path="/m.mp4", brightness=1.5, contrast=-1, saturation=9)
        problems = rs._segment_problems("segment 0", seg, False)
        self.assertEqual(len(problems), 3, problems)
        rs_dict = rs.Segment.from_dict(rs.Segment(duration=1, path="/m.mp4", **GRADE).to_dict())
        self.assertEqual((rs_dict.brightness, rs_dict.contrast, rs_dict.saturation), (0.2, 1.3, 0.7))


# ── the parity with the preview ─────────────────────────────────────────────

def fixture():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


class FixtureTestCase(unittest.TestCase):
    def test_the_fixture_is_this_files_reference_matrix(self):
        fx = fixture()
        self.assertEqual(fx["luma_601"], list(LUMA_601))
        self.assertEqual(fx["luma_709"], list(LUMA_709))
        self.assertAlmostEqual(fx["eq_brightness_gain"], EQ_BRIGHTNESS_GAIN, places=9)
        self.assertAlmostEqual(fx["eq_contrast_pivot"], EQ_CONTRAST_PIVOT, places=9)
        self.assertGreaterEqual(len(fx["cases"]), 8)
        for case in fx["cases"]:
            got = preview_matrix(case["color"], case["still"])
            for g, want in zip(got, case["matrix"]):
                self.assertAlmostEqual(g, want, places=6, msg=str(case))

    def test_the_neutral_grade_is_the_identity(self):
        for still in (True, False):
            m = preview_matrix(tl.COLOR_NEUTRAL, still)
            ident = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]
            for g, want in zip(m, ident):
                self.assertAlmostEqual(g, want, places=9)


#: Per channel, of 255, between ffmpeg's export and the preview arithmetic.
#: Video: eq in the source's own YUV, a BT.709 decode (both sides use it). The
#: gap is ffmpeg's, not the formula's: the x86 eq brightness path is quantised
#: and biased low (measured on 7.0.2, luma codes: +0.1 gives +25, -0.1 gives
#: -29, -0.2 gives -55 where -25.5 / -51 are exact), and its contrast path
#: sits 1-2 codes low. So negative brightness is the worst case, about 5 of
#: 255; everything else is within 3. A still goes through swscale's RGB->YUV
#: first (rounding, 4:2:0 chroma): a little more. Preview and export are two
#: renderers; this is how far apart they are, not a promise of equal pixels.
TOL_VIDEO, TOL_STILL = 6, 8

#: Flat patches well inside the RGB gamut after every grade below, so ffmpeg's
#: YUV clipping and the filter's RGB clipping agree.
PATCHES = [(128, 128, 128), (70, 70, 70), (190, 190, 190), (150, 110, 80),
           (80, 130, 90), (90, 100, 150), (160, 90, 90), (200, 180, 120)]
GRADES = [
    {"brightness": 0.2, "contrast": 1, "saturation": 1},
    {"brightness": -0.2, "contrast": 1, "saturation": 1},
    {"brightness": 0, "contrast": 1.4, "saturation": 1},
    {"brightness": 0, "contrast": 0.6, "saturation": 1},
    {"brightness": 0, "contrast": 1, "saturation": 0},
    {"brightness": 0, "contrast": 1, "saturation": 1.5},
    {"brightness": 0, "contrast": 1, "saturation": 0.5},
    {"brightness": 0.1, "contrast": 1.2, "saturation": 0.8},
]
GRID = 4   # patches per row


def patch_ppm(w=128, h=64):
    """A w x h picture of 4 x 2 flat patches."""
    pw, ph = w // GRID, h // 2
    rows = [b"".join(bytes(PATCHES[(y // ph) * GRID + x // pw]) for x in range(w))
            for y in range(h)]
    return f"P6 {w} {h} 255\n".encode() + b"".join(rows)


def _move_fails(*_a, **_k):
    """A Ken Burns chain ffmpeg cannot run, so the export takes its held-still fallback."""
    return "nosuchfilter_kenburns"


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

    def still(self, name, ppm):
        path = self.dir / f"{name}.ppm"
        path.write_bytes(ppm)
        return tl.ResolvedAsset(ASSET, "image", str(path))

    def video(self, name, ppm):
        """The picture as an HD-style clip: BT.709, limited range, tagged so."""
        src = self.dir / f"{name}.ppm"
        src.write_bytes(ppm)
        mp4 = self.dir / f"{name}.mp4"
        render_backend._run([
            self.ffmpeg, "-y", "-loop", "1", "-framerate", "30", "-i", str(src), "-t", "1",
            "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
            "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
            "-c:v", "libx264", str(mp4)])
        return tl.ResolvedAsset(ASSET, "video", str(mp4), 1.0)

    def export(self, asset, clips, matrix, frame=0, assets=None, fps_preset="16:9"):
        """Export the editor's timeline and return (w, h, rgb24 of one frame),
        decoded with the named YUV matrix."""
        doc = tl.new_timeline(fps_preset)
        doc["tracks"][0]["clips"].extend(copy.deepcopy(clips))
        self.n += 1
        out = self.dir / f"out{self.n}.mp4"
        table = assets or {ASSET: asset}
        tr.render(doc, table.get, str(out))
        w, h = doc["width"], doc["height"]
        raw = subprocess.run(
            [self.ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(out), "-vf",
             f"select=eq(n\\,{frame}),scale=in_color_matrix={matrix}:in_range=tv,format=rgb24",
             "-frames:v", "1", "-f", "rawvideo", "-"], capture_output=True).stdout
        self.assertEqual(len(raw), w * h * 3)
        return w, h, raw

    @staticmethod
    def probes(w, h):
        """The middle of each patch of the picture, as it sits in the frame
        (contain: pillar-boxed, centred; the picture is 2:1)."""
        pic_w = min(w, h * 2)
        pic_h = pic_w // 2
        x0, y0 = (w - pic_w) // 2, (h - pic_h) // 2
        for r in range(2):
            for c in range(GRID):
                yield (r * GRID + c,
                       x0 + int((c + 0.5) * pic_w / GRID), y0 + int((r + 0.5) * pic_h / 2))

    def clip(self, color=None, **extra):
        clip = {"id": "c1", "asset_id": ASSET, "start_s": 0, "in_s": 0, "out_s": 0.5, **extra}
        if color is not None:
            clip["color"] = color
        return clip

    def px(self, raw, w, x, y):
        i = (y * w + x) * 3
        return list(raw[i:i + 3])


class ExportMatchesPreviewTestCase(_Real):
    def check(self, asset, still, matrix, tol, clips_for, label):
        worst = 0.0
        w, h, before = self.export(asset, clips_for(None), matrix)
        for grade in GRADES:
            _, _, after = self.export(asset, clips_for(grade), matrix)
            m = preview_matrix(grade, still)
            for _i, x, y in self.probes(w, h):
                want = apply_matrix(m, self.px(before, w, x, y))
                got = self.px(after, w, x, y)
                gap = max(abs(g - t) for g, t in zip(got, want))
                worst = max(worst, gap)
                self.assertLessEqual(
                    gap, tol, f"{label} {grade} at ({x}, {y}): export {got}, preview {want}, "
                              f"ungraded {self.px(before, w, x, y)}")
        return worst

    def test_video_export_matches_the_preview_matrix(self):
        asset = self.video("v", patch_ppm())
        worst = self.check(asset, False, "bt709", TOL_VIDEO,
                           lambda g: [self.clip(g)], "video")
        print(f"[colour parity] video worst gap {worst:.1f} / 255")

    def test_still_export_matches_the_preview_matrix(self):
        asset = self.still("s", patch_ppm())
        # the held still (its move is a slow zoom; the preview shows the still)
        with mock.patch.object(render_backend, "ken_burns_filter", _move_fails), \
                self.assertLogs("modules.render_backend", "WARNING"):
            worst = self.check(asset, True, "bt601", TOL_STILL,
                               lambda g: [self.clip(g)], "still")
        print(f"[colour parity] still worst gap {worst:.1f} / 255")

    def test_the_grade_moves_the_pixels_the_way_the_names_say(self):
        asset = self.video("d", patch_ppm())
        w, h, base = self.export(asset, [self.clip()], "bt709")
        _, _, bright = self.export(asset, [self.clip({**tl.COLOR_NEUTRAL, "brightness": 0.3})], "bt709")
        _, _, mono = self.export(asset, [self.clip({**tl.COLOR_NEUTRAL, "saturation": 0})], "bt709")
        _, _, flat = self.export(asset, [self.clip({**tl.COLOR_NEUTRAL, "contrast": 0})], "bt709")
        for i, x, y in self.probes(w, h):
            b, br, mo, fl = (self.px(r, w, x, y) for r in (base, bright, mono, flat))
            self.assertTrue(all(q > p + 40 for p, q in zip(b, br)), (b, br))
            self.assertLessEqual(max(mo) - min(mo), 4, f"saturation 0 is grey: {mo}")
        # contrast 0 flattens the LUMA to one tone everywhere (the patches keep their chroma)
        lumas = [sum(c * k for c, k in zip(self.px(flat, w, x, y), LUMA_709))
                 for _i, x, y in self.probes(w, h)]
        self.assertLessEqual(max(lumas) - min(lumas), 8, lumas)

    def test_letterbox_bars_stay_black(self):
        # a 2:1 picture in the 9:16 frame leaves bars top and bottom
        asset = self.video("bars", patch_ppm())
        for color in (None, {"brightness": 0.4, "contrast": 1.5, "saturation": 1}):
            w, h, raw = self.export(asset, [self.clip(color)], "bt709", fps_preset="9:16")
            for y in (5, h // 10, h - 6):
                self.assertLessEqual(max(self.px(raw, w, w // 2, y)), 20, (color, y))

    def test_a_clip_without_color_exports_the_same_pixels_as_before(self):
        asset = self.video("same", patch_ppm())
        _, _, a = self.export(asset, [self.clip()], "bt709")
        _, _, b = self.export(asset, [self.clip({"brightness": 0, "contrast": 1, "saturation": 1})],
                              "bt709")
        self.assertEqual(a, b)

    def test_ken_burns_still_and_both_sides_of_a_crossfade_are_graded(self):
        # flat pictures: whatever the move shows of them is one colour
        flat1 = self.still("f1", f"P6 8 8 255\n".encode() + bytes((150, 110, 80)) * 64)
        flat2 = tl.ResolvedAsset(ASSET2, "image", str(self.dir / "f2.ppm"))
        (self.dir / "f2.ppm").write_bytes(b"P6 8 8 255\n" + bytes((80, 130, 90)) * 64)
        assets = {ASSET: flat1, ASSET2: flat2}
        grade = {"brightness": 0.15, "contrast": 1.3, "saturation": 0.6}

        def clips(g1, g2):
            c1 = {"id": "c1", "asset_id": ASSET, "start_s": 0, "in_s": 0, "out_s": 0.6}
            c2 = {"id": "c2", "asset_id": ASSET2, "start_s": 0.4, "in_s": 0, "out_s": 0.6,
                  "transition": {"type": "crossfade", "duration_s": 0.2}}
            if g1:
                c1["color"] = g1
            if g2:
                c2["color"] = g2
            return [c1, c2]

        def centre(frame, g1, g2):
            w, h, raw = self.export(None, clips(g1, g2), "bt601", frame=frame, assets=assets)
            return self.px(raw, w, w // 2, h // 2)

        m = preview_matrix(grade, True)
        tol = TOL_STILL + 2

        def close(got, want, label):
            gap = max(abs(g - w) for g, w in zip(got, want))
            self.assertLessEqual(gap, tol, f"{label}: got {got}, want about {want}")

        c1 = centre(5, None, None)          # c1 on its own
        c2 = centre(25, None, None)         # c2 on its own, after the dissolve
        self.assertGreater(max(abs(a - b) for a, b in zip(c1, c2)), 30)
        # the 6 dissolve frames are 12-17; frame 12 is all c1 (the outgoing side
        # of the cross-fade segment), frame 17 is c2 almost fully in
        close(centre(12, grade, None), apply_matrix(m, centre(12, None, None)), "outgoing side")
        mixed17 = centre(17, None, None)
        k = max(range(3), key=lambda i: abs(c2[i] - c1[i]))
        p = (mixed17[k] - c1[k]) / (c2[k] - c1[k])
        self.assertTrue(0.6 < p < 1, p)
        g2 = apply_matrix(m, c2)
        close(centre(17, None, grade), [(1 - p) * a + p * b for a, b in zip(c1, g2)],
              "incoming side")
        close(centre(25, None, grade), g2, "the clip after the dissolve")
        close(centre(5, grade, None), apply_matrix(m, c1), "the clip before it")
        # an ungraded side is not touched by the other side's grade
        close(centre(12, None, grade), centre(12, None, None), "outgoing side, other graded")


if __name__ == "__main__":
    unittest.main()
