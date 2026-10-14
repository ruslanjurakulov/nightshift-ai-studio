"""Preview <-> export parity for the editor's frame (aspect) and clip fit.

The editor PREVIEW draws a clip with CSS ``object-fit`` (contain = bars,
cover = crop the middle) inside a box at the document's aspect ratio
(command-center/lib/editorFrame.ts, tested in tests/editor-frame.test.ts). The
EXPORT draws the same two document fields with ffmpeg (render_backend
``_scale_pad`` / ``_scale_crop``). This file renders tiny synthetic clips with
the repo's own ffmpeg, for contain and cover in the 9:16 and 16:9 presets, and
checks the pixels against the geometry the CSS rule defines (a reference
implementation of ``object-fit`` below): bars where contain leaves them, the
middle of the picture where cover crops, the source's colour at each probe.

What it does NOT prove: that a browser draws the same pixels (it compares
geometry, not browser output), cross-fades and fades (the preview draws
neither), a still's slow zoom (the preview shows it still).
Skipped cleanly when no ffmpeg runs.
"""

import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from unittest import mock

from modules import render_backend
from modules import timeline as tl
from modules import timeline_render as tr

ROOT = Path(__file__).resolve().parent.parent
FRAME_TS = ROOT / "command-center" / "lib" / "editorFrame.ts"
ASSET = "11111111-1111-4111-8111-111111111111"

RED, GREEN, BLUE, BLACK = (230, 30, 30), (30, 200, 30), (30, 30, 230), (0, 0, 0)
TOLERANCE = 60   # per channel: yuv420 + scaling; the colours are 150+ apart


def _ffmpeg():
    exe = render_backend.resolve_ffmpeg()
    try:
        ok = subprocess.run([exe, "-version"], capture_output=True).returncode == 0
    except OSError:
        return None
    return exe if ok else None


def css_object_fit_rect(fit, sw, sh, bw, bh):
    """Where CSS ``object-fit`` puts a sw x sh picture in a bw x bh box:
    (x, y, w, h) in box pixels. contain = the larger side fits (bars), cover =
    the smaller side fits (overflow cropped); both centred (the CSS default
    ``object-position: 50% 50%``)."""
    scale = min(bw / sw, bh / sh) if fit == "contain" else max(bw / sw, bh / sh)
    w, h = sw * scale, sh * scale
    return ((bw - w) / 2, (bh - h) / 2, w, h)


def stripes(sw, sh, vertical):
    """A sw x sh picture in three bands (25% / 50% / 25%): red, green, blue,
    left to right (``vertical`` bands) or top to bottom."""
    def band(f):
        return RED if f < 0.25 else GREEN if f < 0.75 else BLUE
    rows = []
    for y in range(sh):
        row = b"".join(bytes(band((x if vertical else y) / (sw if vertical else sh)))
                       for x in range(sw))
        rows.append(row)
    return f"P6 {sw} {sh} 255\n".encode() + b"".join(rows)


def source_colour(fx, fy, vertical):
    f = fx if vertical else fy
    return RED if f < 0.25 else GREEN if f < 0.75 else BLUE


PROBES = (0.05, 0.1, 0.4, 0.5, 0.6, 0.9, 0.95)   # clear of the 25% / 75% band edges


class _Real(unittest.TestCase):
    def setUp(self):
        self.ffmpeg = _ffmpeg()
        if not self.ffmpeg:
            self.skipTest("ffmpeg not available")
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def still(self, name, sw, sh, vertical):
        ppm = self.dir / f"{name}.ppm"
        ppm.write_bytes(stripes(sw, sh, vertical))
        return tl.ResolvedAsset(ASSET, "image", str(ppm))

    def source(self, name, sw, sh, vertical):
        ppm = self.dir / f"{name}.ppm"
        ppm.write_bytes(stripes(sw, sh, vertical))
        mp4 = self.dir / f"{name}.mp4"
        render_backend._run([self.ffmpeg, "-y", "-loop", "1", "-framerate", "30", "-i", str(ppm),
                             "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(mp4)])
        return tl.ResolvedAsset(ASSET, "video", str(mp4), 1.0)

    def export_first_frame(self, asset, preset, fit, clips=None, frame=0):
        """Run the editor's export path (timeline -> RenderSpec -> ffmpeg) for a
        0.3 s clip (or the given ``clips``) in a preset frame and return
        (width, height, rgb bytes of frame number ``frame``)."""
        doc = tl.new_timeline(preset)
        if clips is None:
            clip = {"id": "c1", "asset_id": ASSET, "start_s": 0, "in_s": 0, "out_s": 0.3}
            if fit is not None:
                clip["fit"] = fit
            clips = [clip]
        doc["tracks"][0]["clips"].extend(clips)
        out = self.dir / f"{preset.replace(':', 'x')}-{fit}-{len(clips)}-{frame}.mp4"
        tr.render(doc, lambda aid: asset if aid == ASSET else None, str(out))
        w, h = doc["width"], doc["height"]
        raw = subprocess.run([self.ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(out),
                              "-vf", f"select=eq(n\\,{frame})", "-frames:v", "1",
                              "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                             capture_output=True).stdout
        self.assertEqual(len(raw), w * h * 3, "the first frame has the document's frame size")
        return w, h, raw

    def assertColour(self, got, want, where):
        for g, w_ in zip(got, want):
            if abs(g - w_) > TOLERANCE:
                self.fail(f"{where}: got {tuple(got)}, want about {want}")

    def check_against_css(self, asset, sw, sh, vertical, preset, fit, clips=None, frame=0,
                          css_fit=None):
        w, h, raw = self.export_first_frame(asset, preset, fit, clips, frame)
        x0, y0, rw, rh = css_object_fit_rect(css_fit or fit or "contain", sw, sh, w, h)
        bars = 0
        for fy in PROBES:
            for fx in PROBES:
                px, py = int(fx * w), int(fy * h)
                sx, sy = (px + 0.5 - x0) / rw, (py + 0.5 - y0) / rh
                inside = 0 <= sx < 1 and 0 <= sy < 1
                want = source_colour(sx, sy, vertical) if inside else BLACK
                bars += not inside
                i = (py * w + px) * 3
                self.assertColour(raw[i:i + 3], want,
                                  f"{preset} fit={fit} at ({fx}, {fy}) of the frame")
        return bars


class ExportMatchesPreviewGeometryTestCase(_Real):
    def test_landscape_clip_in_a_vertical_frame(self):
        asset = self.source("land", 640, 360, vertical=True)
        contain = self.check_against_css(asset, 640, 360, True, "9:16", "contain")
        cover = self.check_against_css(asset, 640, 360, True, "9:16", "cover")
        self.assertGreater(contain, 0, "contain leaves bars (top and bottom)")
        self.assertEqual(cover, 0, "cover leaves none")

    def test_portrait_clip_in_a_wide_frame(self):
        asset = self.source("port", 360, 640, vertical=False)
        contain = self.check_against_css(asset, 360, 640, False, "16:9", "contain")
        cover = self.check_against_css(asset, 360, 640, False, "16:9", "cover")
        self.assertGreater(contain, 0, "contain leaves bars (left and right)")
        self.assertEqual(cover, 0)

    def test_the_two_fits_really_differ_at_the_edges(self):
        # Not only "same as the CSS reference": the corner pixels say which fit ran.
        asset = self.source("land2", 640, 360, vertical=True)
        w, h, contain = self.export_first_frame(asset, "9:16", "contain")
        _, _, cover = self.export_first_frame(asset, "9:16", "cover")
        top = (int(0.05 * h) * w + w // 2) * 3
        centre = (int(0.5 * h) * w + w // 2) * 3
        self.assertColour(contain[top:top + 3], BLACK, "contain, top middle: a bar")
        self.assertColour(cover[top:top + 3], GREEN, "cover, top middle: the picture's middle")
        self.assertColour(contain[centre:centre + 3], GREEN, "contain, centre")
        self.assertColour(cover[centre:centre + 3], GREEN, "cover, centre")

    def test_same_shape_needs_no_bars_and_no_crop(self):
        asset = self.source("same", 640, 360, vertical=True)
        for fit in ("contain", "cover"):
            self.assertEqual(self.check_against_css(asset, 640, 360, True, "16:9", fit), 0)

    def test_no_fit_field_is_contain(self):
        # Existing projects (no `fit`) render as before: bars, the same pixels as contain.
        asset = self.source("land3", 640, 360, vertical=True)
        self.assertGreater(self.check_against_css(asset, 640, 360, True, "9:16", None), 0)


class SquareFrameTestCase(_Real):
    """The 1:1 preset (1080x1080): bars on the long side of a landscape or a
    portrait clip with contain, none with cover, same 7x7 probe grid."""

    def test_landscape_clip_in_a_square_frame(self):
        asset = self.source("sq-land", 640, 360, vertical=True)
        contain = self.check_against_css(asset, 640, 360, True, "1:1", "contain")
        cover = self.check_against_css(asset, 640, 360, True, "1:1", "cover")
        self.assertGreater(contain, 0, "contain leaves bars (top and bottom)")
        self.assertEqual(cover, 0)

    def test_portrait_clip_in_a_square_frame(self):
        asset = self.source("sq-port", 360, 640, vertical=False)
        contain = self.check_against_css(asset, 360, 640, False, "1:1", "contain")
        cover = self.check_against_css(asset, 360, 640, False, "1:1", "cover")
        self.assertGreater(contain, 0, "contain leaves bars (left and right)")
        self.assertEqual(cover, 0)

    def test_no_fit_field_is_contain_in_a_square_frame(self):
        asset = self.source("sq-none", 640, 360, vertical=True)
        self.assertGreater(self.check_against_css(asset, 640, 360, True, "1:1", None), 0)


def _move_fails(*_a, **_k):
    """A Ken Burns chain ffmpeg cannot run, so the export takes its fallback."""
    return "nosuchfilter_kenburns"


class StillFallbackFillsTestCase(_Real):
    """A timeline still normally gets a slow zoom that starts filled the frame;
    when that chain fails, the export holds the picture instead. The hold must
    fill too (centre crop, the geometry the preview draws for a still), not
    leave black bars. Both fallbacks are forced here: the single-still hold
    and the cross-fade's hold."""

    PRESETS = ("9:16", "16:9", "1:1")

    def test_a_held_still_fills_the_frame_in_every_preset(self):
        for name, (sw, sh, vertical) in {"land": (640, 360, True), "port": (360, 640, False)}.items():
            asset = self.still(f"st-{name}", sw, sh, vertical)
            for preset in self.PRESETS:
                with self.subTest(still=name, preset=preset):
                    clip = [{"id": "c1", "asset_id": ASSET, "start_s": 0, "in_s": 0, "out_s": 0.3}]
                    with mock.patch.object(render_backend, "ken_burns_filter", _move_fails), \
                            self.assertLogs("modules.render_backend", "WARNING") as logs:
                        bars = self.check_against_css(asset, sw, sh, vertical, preset, "cover",
                                                      clips=clip)
                    self.assertTrue(any("holding the still" in m for m in logs.output),
                                    "the fallback really ran")
                    self.assertEqual(bars, 0, "no bars: the picture fills the frame")

    def test_a_fit_field_does_not_change_a_still(self):
        asset = self.still("st-fit", 640, 360, True)
        clip = [{"id": "c1", "asset_id": ASSET, "start_s": 0, "in_s": 0, "out_s": 0.3,
                 "fit": "contain"}]
        with mock.patch.object(render_backend, "ken_burns_filter", _move_fails), \
                self.assertLogs("modules.render_backend", "WARNING"):
            self.assertEqual(self.check_against_css(asset, 640, 360, True, "9:16", "contain",
                                                    clips=clip, css_fit="cover"), 0)

    def test_the_crossfade_hold_fills_too(self):
        # Two stills, the second dissolving in over 0.2 s (0.4-0.6 s). Frame 13
        # is inside the dissolve: both sides are the same picture, so it must
        # look like one filled picture. Without the fix the held sides are boxed.
        asset = self.still("st-xf", 640, 360, True)
        clips = [{"id": "c1", "asset_id": ASSET, "start_s": 0, "in_s": 0, "out_s": 0.6},
                 {"id": "c2", "asset_id": ASSET, "start_s": 0.4, "in_s": 0, "out_s": 0.6,
                  "transition": {"type": "crossfade", "duration_s": 0.2}}]
        for preset in self.PRESETS:
            with self.subTest(preset=preset):
                with mock.patch.object(render_backend, "ken_burns_filter", _move_fails), \
                        self.assertLogs("modules.render_backend", "WARNING"):
                    bars = self.check_against_css(asset, 640, 360, True, preset, "cover",
                                                  clips=clips, frame=13)
                self.assertEqual(bars, 0)


class SharedDefinitionsTestCase(unittest.TestCase):
    """The TypeScript module the preview reads and the Python document model
    agree on the three frame presets and the two fits."""

    def test_frame_presets_match_the_document_presets(self):
        ts = FRAME_TS.read_text(encoding="utf-8")
        found = {m[0]: (int(m[1]), int(m[2])) for m in re.findall(
            r'\{\s*id:\s*"([\d:]+)",\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}', ts)}
        self.assertEqual(found, dict(tl.PRESETS))

    def test_fits_are_the_documents(self):
        ts = FRAME_TS.read_text(encoding="utf-8")
        self.assertIn('export type Fit = "contain" | "cover";', ts)
        self.assertEqual(tuple(tl.FITS), ("contain", "cover", "blur"))   # the picker still offers the first two

    def test_a_cover_clip_and_each_preset_validate(self):
        for preset in tl.PRESETS:
            doc = tl.new_timeline(preset)
            doc["tracks"][0]["clips"].append(
                {"id": "c1", "asset_id": ASSET, "start_s": 0, "in_s": 0, "out_s": 1, "fit": "cover"})
            self.assertEqual(tl.validate(doc), [])


if __name__ == "__main__":
    unittest.main()
