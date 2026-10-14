"""Stabilise (``stabilize: true`` on a video clip), backend half.

vidstab (two passes: detect, then a smoothed path with an automatic zoom) when
the ffmpeg build has it, ffmpeg's single-pass ``deshake`` otherwise. By class:

* the document: a boolean, video only, not with ``freeze``, a clip's range and a
  document's total are bounded (it decodes the clip twice), normalisation, the
  JSON schema and the shared constants;
* the argv: documents without it render the SAME commands as before (golden
  digests); the transform sits on the source frames right after the turn / crop
  and before the retime, fit and effects; the detect pass is its own command
  (pinned), shared by every piece of a cross-faded clip, written to a private
  part file; a build without vidstab gets deshake and no detect pass;
* the PIXELS, real ffmpeg: a shaky clip (a window sliding about a larger picture)
  moves a fraction as much from frame to frame once stabilised, with vidstab (the
  bundled build has it) and, less, with deshake; frame counts and lengths are the
  timeline's; the whole thing runs under a cross-fade and a speed change.
"""

import copy
import json
import re
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from modules import render_backend
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr
from tests import test_editor_effects as fxt
from tests import test_editor_overlay as ovt
from tests import test_editor_transitions as trt

ROOT = Path(__file__).resolve().parent.parent
EDITOR_TS = ROOT / "command-center" / "lib" / "editor.ts"
BASE = ovt.BASE


def problems_of(**clip):
    return tl.validate(fxt.vdoc(**clip))


class DocumentTestCase(unittest.TestCase):
    def test_a_boolean_for_video(self):
        self.assertEqual(problems_of(stabilize=True), [])
        self.assertEqual(problems_of(stabilize=False), [])
        for bad in (1, 0, "true", None, [True]):
            self.assertTrue(any("stabilize must be true or false" in p for p in problems_of(stabilize=bad)), bad)
        self.assertTrue(any("nothing to stabilise" in p for p in problems_of(stabilize=True, freeze=True)))
        self.assertEqual(problems_of(stabilize=False, freeze=True), [])
        self.assertEqual(problems_of(stabilize=True, speed=2, reverse=False, crop={"w": 0.5}, angle=5), [])

    def test_a_clip_and_a_document_have_a_budget(self):
        self.assertEqual(problems_of(stabilize=True, out_s=120), [])
        self.assertTrue(any("more than 120 s" in p for p in problems_of(stabilize=True, out_s=121)))
        self.assertEqual(problems_of(out_s=500), [], "only a stabilised clip is bounded")
        doc = fxt.vdoc(stabilize=True, out_s=100)
        doc["tracks"][0]["clips"] += [
            {"id": f"d{i}", "asset_id": BASE, "start_s": 100.0 * i, "in_s": 0, "out_s": 100, "stabilize": True}
            for i in (1, 2)]
        self.assertEqual(tl.validate(doc), [])                                  # 300 s in all
        doc["tracks"][0]["clips"].append({"id": "d3", "asset_id": BASE, "start_s": 300, "in_s": 0, "out_s": 1,
                                          "stabilize": True})
        self.assertTrue(any("at most 300 s of video can be stabilised" in p for p in tl.validate(doc)))

    def test_the_cost_is_in_estimated_seconds_that_must_fit_the_workers_timeout(self):
        # 1080p30: 7 frames per second of 1080p-equivalent frame -> 30 / 7 = 4.29 s of work per second of clip
        self.assertEqual(tl.STABILIZE_FPS_1080P, 7.0)
        self.assertAlmostEqual(tl.stabilize_seconds({"in_s": 0, "out_s": 10}, 30, 1920, 1080), 300 / 7)
        self.assertAlmostEqual(tl.stabilize_seconds({"in_s": 0, "out_s": 60}, 30, 3840, 2160), 1028.57, places=1)
        self.assertEqual(tl.stabilize_seconds({"in_s": 0, "out_s": "x"}, 30, 1920, 1080), 0.0)
        hd = dict(width=1920, height=1080)
        # 20 s at 1080p30: 86 s of stabilising + 20 s of timeline < 3 * 20 + 120 = 180 s
        self.assertEqual(problems_of(stabilize=True, out_s=20, **hd), [])
        # 60 s: 257 s + 60 s of timeline against 300 s -> refused, although it is inside the 120 s range cap
        got = problems_of(stabilize=True, out_s=60, **hd)
        self.assertTrue(any("stabilising would take about 317 s" in p and "is allowed 300 s" in p
                            and "stabilise less of it" in p for p in got), got)
        # the same minute at 720p (0.44 of the pixels): 114 s + 60 s < 300 s
        self.assertEqual(problems_of(stabilize=True, out_s=60, width=1280, height=720), [])
        # a 60 s 4K30 clip needs ~1030 s against a 300 s timeout (measured 1.75 fps)
        got = problems_of(stabilize=True, out_s=60, width=3840, height=2160)
        self.assertTrue(any("stabilising would take about 1089 s" in p for p in got), got)
        # a long timeline has more time: 100 s of 1080p30 stabilised inside 600 s of picture
        doc = fxt.vdoc(width=1920, height=1080, out_s=100, stabilize=True)
        doc["tracks"][0]["clips"].append({"id": "d1", "asset_id": BASE, "start_s": 100, "in_s": 0, "out_s": 500})
        self.assertEqual(tl.validate(doc), [])           # 429 + 600 s of work against 1920 s
        # stabilising and interpolating are charged together
        doc = fxt.vdoc(width=1920, height=1080, out_s=4.9, speed=0.5, interpolate=True)
        doc["tracks"][0]["clips"].append({"id": "d1", "asset_id": BASE, "start_s": 9.8, "in_s": 0, "out_s": 20,
                                          "stabilize": True})
        got = tl.validate(doc)
        self.assertTrue(any("interpolated slow motion and stabilising would take" in p
                            and "slow less of it and stabilise less of it" in p for p in got), got)

    def test_normalise_and_resolve(self):
        n = tl.normalise(fxt.vdoc(stabilize=False))["tracks"][0]["clips"][0]
        self.assertNotIn("stabilize", n)
        self.assertTrue(tl.normalise(fxt.vdoc(stabilize=True))["tracks"][0]["clips"][0]["stabilize"])
        table = {BASE: tl.ResolvedAsset(BASE, "image", "/m/p.png", None)}
        with self.assertRaises(tl.TimelineError) as cm:
            tl.resolve_assets(tl.load(fxt.vdoc(stabilize=True)), table.get)
        self.assertIn("stabilize is for video, not a picture", str(cm.exception))

    def test_a_split_keeps_it_on_both_halves(self):
        out = tl.split_clip(fxt.vdoc(out_s=4, stabilize=True), "c1", 1.0, "c2")
        a, b = out["tracks"][0]["clips"]
        self.assertTrue(a["stabilize"] and b["stabilize"])

    def test_schema_and_constants(self):
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        props = schema["$defs"]["video_clip"]["properties"]
        self.assertEqual(set(props), set(tl._V_CLIP_KEYS))
        self.assertEqual(props["stabilize"]["type"], "boolean")
        self.assertEqual(rs.STABILIZE_MAX_S, tl.STABILIZE_MAX_S)
        ts = EDITOR_TS.read_text(encoding="utf-8")
        self.assertEqual(float(re.search(r"export const STABILIZE_FPS_1080P = ([\d.]+);", ts).group(1)),
                         tl.STABILIZE_FPS_1080P)
        for name in ("STABILIZE_MAX_S", "STABILIZE_MAX_DOC_S"):
            self.assertEqual(float(re.search(rf"export const {name} = ([\d.]+);", ts).group(1)), getattr(tl, name))


class SpecTestCase(unittest.TestCase):
    def test_the_flag_reaches_the_segment_only_for_video(self):
        seg = fxt.spec_of(fxt.vdoc(stabilize=True)).segments[0]
        self.assertTrue(seg.stabilize)
        spec = fxt.spec_of(fxt.vdoc(stabilize=True))
        self.assertEqual(rs.RenderSpec.from_dict(spec.to_dict()), spec)
        self.assertNotIn("stabilize", fxt.spec_of(fxt.vdoc()).segments[0].to_dict())

    def test_a_spec_is_refused_for_what_would_not_render(self):
        def problems(**kw):
            seg = rs.Segment(2.0, "/m/a.mp4", **kw)
            return rs.validate(rs.RenderSpec("/o.mp4", 1280, 720, 30, segments=[seg], frame_exact=True))
        self.assertEqual(problems(stabilize=True), [])
        self.assertTrue(any("moving video" in p for p in problems(stabilize=True, freeze=True)))
        pic = rs.Segment(2.0, "/m/p.png", kind=rs.KIND_IMAGE, stabilize=True)
        self.assertTrue(any("moving video" in p for p in rs.validate(
            rs.RenderSpec("/o.mp4", 1280, 720, 30, segments=[pic], frame_exact=True))))


def with_method(method):
    return mock.patch.object(render_backend, "stabilizer", lambda ffmpeg: method)


class CommandTestCase(unittest.TestCase):
    W = Path("/w")

    def cmds(self, seg, **kw):
        return render_backend.segment_commands("ffmpeg", seg, self.W / "seg_0000.mp4", 1280, 720, 30,
                                               frame_exact=True, **kw)

    def vf(self, seg):
        c = self.cmds(seg)[0]
        return c[c.index("-vf") + 1]

    def test_without_it_the_chain_is_the_one_it_was(self):
        with with_method("vidstab"):
            self.assertEqual(self.vf(rs.Segment(2.0, "/m/a.mp4")),
                             "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30")

    def test_vidstab_transforms_the_source_after_the_turn_and_before_the_fit(self):
        seg = rs.Segment(2.0, "/m/a.mp4", stabilize=True, speed=2.0, effects=rs.ClipEffects(rotate=90),
                         crop=rs.ClipCrop(w=0.5), angle=3.0)
        with with_method("vidstab"):
            vf = self.vf(seg)
        trf = render_backend.stab_trf_path(seg, self.W)
        self.assertRegex(trf.name, r"^stab-[0-9a-f]{16}\.trf$")
        self.assertTrue(vf.startswith(
            "setpts=(PTS-STARTPTS)/2.000,transpose=1,crop=w='max(2,trunc(iw*0.5000/2)*2)':h='max(2,trunc(ih*1.0000/2)*2)'"
            f":x='trunc(iw*0.0000/2)*2':y='trunc(ih*0.0000/2)*2',vidstabtransform=input='{trf}'"
            ":smoothing=15:optzoom=1:interpol=bicubic,scale="), vf)
        self.assertIn("rotate=a=0.052360", vf)

    def test_deshake_is_one_pass_in_the_same_place(self):
        seg = rs.Segment(2.0, "/m/a.mp4", stabilize=True)
        with with_method("deshake"):
            self.assertEqual(self.vf(seg), "deshake=rx=32:ry=32:edge=3,scale=1280:720:force_original_aspect_ratio="
                                           "decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30")
            self.assertEqual(render_backend.segment_prepasses("ffmpeg", seg, self.W / "s.mp4", 1280, 720), [])

    def test_the_detect_pass_is_its_own_command(self):
        seg = rs.Segment(2.0, "/m/a.mp4", in_s=1.5, speed=2.0, stabilize=True, effects=rs.ClipEffects(flip_h=True))
        with with_method("vidstab"):
            (trf, part, cmd), = render_backend.segment_prepasses("ffmpeg", seg, self.W / "s.mp4", 1280, 720)
        self.assertEqual(trf, render_backend.stab_trf_path(seg, self.W))
        self.assertRegex(part.name, rf"^{re.escape(trf.name)}\.\d+-\d+\.part$")
        self.assertEqual(cmd[cmd.index("-ss") + 1], "1.500")
        self.assertEqual(cmd[cmd.index("-t") + 1], "4.000")                   # 2 s at 2x = 4 s of source
        self.assertNotIn("-stream_loop", cmd)
        self.assertEqual(cmd[cmd.index("-vf") + 1],
                         f"hflip,vidstabdetect=shakiness=5:accuracy=15:result='{part}'")
        self.assertEqual((cmd[cmd.index("-f") + 1], cmd[-1]), ("null", "-"), "analysed, nothing encoded")
        self.assertIn("-protocol_whitelist", cmd)
        self.assertIn("-max_pixels", cmd)

    def test_every_piece_of_a_clip_shares_one_analysis(self):
        a = rs.Segment(1.0, "/m/a.mp4", stabilize=True, clip_s=3.0, offset_s=0.0)
        b = rs.Segment(1.0, "/m/a.mp4", stabilize=True, clip_s=3.0, offset_s=2.0)
        c = rs.Segment(1.0, "/m/a.mp4", stabilize=True, clip_s=3.0, offset_s=1.0, effects=rs.ClipEffects(flip_h=True))
        d = rs.Segment(1.0, "/m/b.mp4", stabilize=True, clip_s=3.0, offset_s=0.0)
        self.assertEqual(render_backend.stab_trf_path(a, self.W), render_backend.stab_trf_path(b, self.W))
        self.assertEqual(len({render_backend.stab_trf_path(s, self.W) for s in (a, c, d)}), 3,
                         "a different turn or file is a different analysis")

    def test_a_cross_fade_analyses_and_transforms_each_stabilised_side(self):
        out = rs.Segment(1.0, "/m/a.mp4", stabilize=True, clip_s=3.0, offset_s=2.0)
        inc = rs.Segment(1.0, "/m/b.mp4", stabilize=False, clip_s=3.0)
        blend = rs.Segment(**{**out.__dict__, "xfade": inc})
        with with_method("vidstab"):
            passes = render_backend.segment_prepasses("ffmpeg", blend, self.W / "s.mp4", 640, 360)
            self.assertEqual(len(passes), 1)
            both = rs.Segment(**{**out.__dict__, "xfade": rs.Segment(**{**inc.__dict__, "stabilize": True})})
            self.assertEqual(len(render_backend.segment_prepasses("ffmpeg", both, self.W / "s.mp4", 640, 360)), 2)
            c = render_backend.segment_commands("ffmpeg", both, self.W / "s.mp4", 640, 360, 30, frame_exact=True)[0]
        g = c[c.index("-filter_complex") + 1].split(";")
        self.assertIn("vidstabtransform=input='", g[0])
        self.assertIn("vidstabtransform=input='", g[1])
        self.assertNotEqual(re.search(r"input='([^']+)'", g[0]).group(1), re.search(r"input='([^']+)'", g[1]).group(1))

    def test_a_picture_or_a_colour_is_never_stabilised(self):
        with with_method("vidstab"):
            self.assertEqual(render_backend.stab_filter("ffmpeg", rs.Segment(2.0, None, kind=rs.KIND_COLOR, stabilize=True), self.W), "")
            self.assertEqual(render_backend.stab_filter("ffmpeg", rs.Segment(2.0, "/m/p.png", kind=rs.KIND_IMAGE, stabilize=True), self.W), "")

    def test_reverse_and_interpolation_keep_the_transform_on_the_source(self):
        with with_method("deshake"):
            vf = self.vf(rs.Segment(2.0, "/m/a.mp4", stabilize=True, reverse=True))
            self.assertTrue(vf.startswith("deshake=rx=32:ry=32:edge=3,scale="), vf)
            vf = self.vf(rs.Segment(2.0, "/m/a.mp4", stabilize=True, speed=0.5, interpolate=True))
            self.assertTrue(vf.startswith("deshake=rx=32:ry=32:edge=3,scale="), vf)

    def test_the_stabilizer_is_vidstab_only_when_both_filters_exist(self):
        render_backend.stabilizer.cache_clear()
        for out, want in (("... vidstabdetect ...\n ... vidstabtransform ...", "vidstab"), ("vidstabdetect only", "deshake"),
                          ("nothing", "deshake")):
            render_backend.stabilizer.cache_clear()
            with mock.patch.object(render_backend.subprocess, "run",
                                   return_value=mock.Mock(stdout=out, returncode=0)):
                self.assertEqual(render_backend.stabilizer("ffmpeg-fake"), want)
        render_backend.stabilizer.cache_clear()
        with mock.patch.object(render_backend.subprocess, "run", side_effect=OSError("no ffmpeg")):
            self.assertEqual(render_backend.stabilizer("ffmpeg-none"), "deshake")
        render_backend.stabilizer.cache_clear()


class NeutralTestCase(unittest.TestCase):
    def test_every_older_document_renders_the_commands_it_always_did(self):
        for name, doc in trt.neutral_docs().items():
            with self.subTest(name):
                self.assertEqual(trt.digest(doc), trt.LEGACY[name])

    def test_switched_off_changes_nothing(self):
        for name, doc in trt.neutral_docs().items():
            doc2 = copy.deepcopy(doc)
            for t in doc2["tracks"]:
                if t["kind"] == "V":
                    for c in t["clips"]:
                        c["stabilize"] = False
            with self.subTest(name):
                self.assertEqual(trt.digest(doc2), trt.LEGACY[name])


# ── real ffmpeg ─────────────────────────────────────────────────────────────

class _Real(fxt._Real):
    def shaky(self, seconds=3):
        """A window sliding about a larger test picture: 22 px / 14 px of shake."""
        path = self.dir / "shaky.mp4"
        self.run_ffmpeg("-f", "lavfi", "-i", f"testsrc2=s=640x360:r=30:d={seconds}", "-vf",
                        "crop=320:180:x='160+22*sin(n*0.9)':y='90+14*cos(n*1.3)'", "-c:v", "libx264",
                        "-pix_fmt", "yuv420p", "-crf", "10", str(path))
        return tl.ResolvedAsset(BASE, "video", str(path), float(seconds), False)

    def jitter(self, path):
        """Mean absolute difference between neighbouring frames in the middle of the picture."""
        raw = self.run_ffmpeg("-i", str(path), "-vf", "format=gray", "-f", "rawvideo", "-")
        n = 320 * 180
        frames = [raw[i * n:(i + 1) * n] for i in range(len(raw) // n)]
        mid = [b"".join(f[y * 320 + 60:y * 320 + 260] for y in range(40, 140)) for f in frames]
        return sum(sum(abs(a - b) for a, b in zip(f, g)) / len(f) for f, g in zip(mid, mid[1:])) / (len(mid) - 1)

    def count(self, path):
        info = subprocess.run([self.ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-map", "0:v:0", "-vf",
                               "showinfo", "-f", "null", "-"], capture_output=True, text=True).stderr
        return len(re.findall(r"Parsed_showinfo_0 .*\bn:\s*\d+", info))

    def render(self, asset, method=None, **clip):
        doc = fxt.vdoc(width=320, height=180, out_s=3, fit="cover", **clip)
        if method is None:
            return self.export(doc, {BASE: asset})
        with with_method(method):
            return self.export(doc, {BASE: asset})


class StabiliseRenderTestCase(_Real):
    def test_the_bundled_ffmpeg_has_vidstab(self):
        render_backend.stabilizer.cache_clear()
        self.assertEqual(render_backend.stabilizer(self.ffmpeg), "vidstab",
                         "the render build is expected to carry libvidstab (the tests below assume it)")

    def test_a_shaky_clip_moves_a_fraction_as_much_once_stabilised(self):
        src = self.shaky()
        plain = self.jitter(self.render(src, "vidstab"))
        steady = self.jitter(self.render(src, "vidstab", stabilize=True))
        self.assertLess(steady, plain * 0.5, (plain, steady))
        out = self.render(src, "vidstab", stabilize=True)
        self.assertEqual(self.count(out), 90)

    def test_deshake_helps_less_but_helps(self):
        src = self.shaky()
        plain = self.jitter(self.render(src, "deshake"))
        steady = self.jitter(self.render(src, "deshake", stabilize=True))
        self.assertLess(steady, plain * 0.85, (plain, steady))

    def test_the_trf_is_kept_for_the_render_and_a_missing_filter_stops_it(self):
        src = self.shaky()
        out = self.render(src, "vidstab", stabilize=True)
        self.assertTrue(out.exists())
        # a detect pass that cannot run is an error, not an unstabilised clip
        from modules import timeline_render as tr2
        doc = fxt.vdoc(width=320, height=180, out_s=3, stabilize=True)
        bad = tl.ResolvedAsset(BASE, "video", str(self.dir / "missing.mp4"), 3.0, False)
        with with_method("vidstab"), self.assertRaises(Exception):
            tr2.render(doc, {BASE: bad}.get, str(self.dir / "never.mp4"))

    def test_with_a_speed_change_a_crop_and_a_cross_fade(self):
        src = self.shaky()
        doc = {"version": 1, "width": 320, "height": 180, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0, "out_s": 3, "fit": "cover", "stabilize": True,
             "speed": 1.5, "crop": {"x": 0.1, "w": 0.8}},
            {"id": "c2", "asset_id": BASE, "start_s": 1.5, "in_s": 0, "out_s": 2, "fit": "cover", "stabilize": True,
             "transition": {"type": "crossfade", "duration_s": 0.5}}]}]}
        with with_method("vidstab"):
            out = self.export(doc, {BASE: src})
        self.assertEqual(self.count(out), round((1.5 + 2) * 30))


if __name__ == "__main__":
    unittest.main()
