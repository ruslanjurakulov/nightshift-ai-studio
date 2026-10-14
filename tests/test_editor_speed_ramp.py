"""Speed ramps (a speed curve) and interpolated slow motion (backend half).

Fields (modules/timeline.py): a V clip's ``speed_curve`` -- 2 to 6 points
``{at, speed}`` -- and ``interpolate``. The arithmetic is modules/speed_ramp.py.
By class:

* the arithmetic: the closed form equals a numeric integral, the output time is
  increasing and ends at the length, the audio slices land the sound on the
  picture at every slice boundary, and the ``setpts`` expression, run by real
  ffmpeg, puts each frame at that output time;
* the document: 2 to 6 points, first at 0 and last at 1, in order and apart,
  speeds in range, not with a speed, reverse or freeze, the clip lasts the
  integral, a split is refused, ``interpolate`` only below speed 1 and inside its
  cost budget, normalisation, the JSON schema and the shared constants;
* the argv: documents without a curve render the SAME commands as before
  (golden digests); the expression, the audio slices and the interpolation
  chain are pinned;
* the PIXELS and SAMPLES, real ffmpeg: a clip whose luma encodes time follows the
  curve, frame counts are the timeline's, a tone keeps its pitch and its length
  through a ramp, and interpolated slow motion renders and is smoother than
  repeated frames.
"""

import copy
import json
import math
import re
import subprocess
import unittest
from pathlib import Path

from modules import render_backend
from modules import render_spec as rs
from modules import speed_ramp as sr
from modules import timeline as tl
from modules import timeline_render as tr
from tests import test_editor_effects as fxt
from tests import test_editor_overlay as ovt
from tests import test_editor_speed as spd
from tests import test_editor_transitions as trt

ROOT = Path(__file__).resolve().parent.parent
EDITOR_TS = ROOT / "command-center" / "lib" / "editor.ts"
BASE = ovt.BASE


def curve(*pairs):
    return [{"at": a, "speed": s} for a, s in pairs]


def vdoc(width=640, height=360, fps=30, out_s=4, **clip):
    return fxt.vdoc(width=width, height=height, fps=fps, out_s=out_s, **clip)


def problems_of(**kw):
    return tl.validate(vdoc(**kw))


RAMP = curve((0, 1), (0.5, 4), (1, 0.5))


class ArithmeticTestCase(unittest.TestCase):
    def numeric_length(self, pts, steps=200000):
        total, end = 0.0, pts[-1][0]
        for i in range(steps):
            t = (i + 0.5) * end / steps
            total += (end / steps) / sr.speed_at(pts, t)
        return total

    def test_the_closed_form_is_the_integral_of_one_over_speed(self):
        for pairs, rng in ((((0, 1), (1, 1)), 4), (((0, 1), (0.5, 4), (1, 0.5)), 4), (((0, 0.25), (1, 4)), 2),
                           (((0, 4), (0.3, 0.25), (0.31, 1), (1, 1)), 10), (((0, 2), (1, 2)), 3)):
            pts = sr.absolute(pairs, rng)
            self.assertAlmostEqual(sr.out_length(pts), self.numeric_length(pts), delta=1e-4, msg=str(pairs))
        self.assertAlmostEqual(sr.out_length(sr.absolute(((0, 2), (1, 2)), 3)), 1.5)
        self.assertAlmostEqual(sr.out_length(sr.absolute(((0, 1), (1, 1)), 3)), 3.0)

    def test_the_output_time_increases_and_ends_at_the_length(self):
        pts = sr.absolute(((0, 1), (0.5, 4), (1, 0.5)), 4)
        times = [sr.out_time(pts, i * 4 / 100) for i in range(101)]
        self.assertTrue(all(b > a for a, b in zip(times, times[1:])))
        self.assertEqual(times[0], 0.0)
        self.assertAlmostEqual(times[-1], sr.out_length(pts))
        self.assertAlmostEqual(sr.out_time(pts, 2.0), 0.924196, places=5)

    def test_a_ramp_that_never_changes_is_a_constant_speed(self):
        pts = sr.absolute(((0, 2), (0.5, 2), (1, 2)), 4)
        self.assertAlmostEqual(sr.out_length(pts), 2.0)
        self.assertIn("/2.000000", sr.setpts_expression(pts))
        self.assertNotIn("log(", sr.setpts_expression(pts))

    def test_audio_slices_put_the_sound_on_the_picture_at_every_boundary(self):
        pts = sr.absolute(((0, 1), (0.5, 4), (1, 0.5)), 4.0)
        n = sr.slice_count(4.0)
        self.assertEqual(n, 8)
        tempos = sr.slice_tempos(pts, 4.0, n)
        step = 4.0 / n
        for j in range(1, n + 1):
            sound_end = sum(step / t for t in tempos[:j])
            self.assertAlmostEqual(sound_end, sr.out_time(pts, j * step), places=9)
        self.assertTrue(all(0.25 <= t <= 4.0 for t in tempos))
        self.assertEqual((sr.slice_count(0.4), sr.slice_count(1.0), sr.slice_count(3.1), sr.slice_count(60)),
                         (2, 2, 6, 16))

    def test_the_expression_is_pinned(self):
        pts = sr.absolute(((0, 1), (0.5, 4), (1, 0.5)), 4.0)
        t = "((PTS-STARTPTS)*TB)"
        self.assertEqual(
            sr.setpts_expression(pts),
            f"(if(lt({t},2.000000),0.000000+log((1.000000+(1.500000)*({t}-0.000000))/1.000000)/(1.500000),"
            f"if(lt({t},4.000000),0.924196+log((4.000000+(-1.750000)*({t}-2.000000))/4.000000)/(-1.750000),"
            f"2.112449+({t}-4.000000)/0.500000)))/TB")


class DocumentTestCase(unittest.TestCase):
    def test_a_valid_curve(self):
        self.assertEqual(problems_of(speed_curve=RAMP), [])
        self.assertEqual(problems_of(speed_curve=curve((0, 1), (1, 1))), [])
        six = curve((0, 1), (0.1, 2), (0.3, 0.5), (0.6, 4), (0.8, 0.25), (1, 1))
        self.assertEqual(problems_of(speed_curve=six), [])

    def test_the_points_are_counted_ordered_and_apart(self):
        for bad, needle in (([], "list of 2 to 6"), (curve((0, 1)), "list of 2 to 6"),
                            (curve((0, 1), (0.1, 1), (0.2, 1), (0.3, 1), (0.4, 1), (0.5, 1), (1, 1)), "list of 2 to 6"),
                            (curve((0.1, 1), (1, 1)), "first point must be at 0"),
                            (curve((0, 1), (0.9, 1)), "last at 1"),
                            (curve((0, 1), (0.5, 2), (0.4, 1), (1, 1)), "at least 0.01 apart"),
                            (curve((0, 1), (0.5, 2), (0.5, 3), (1, 1)), "at least 0.01 apart"),
                            (curve((0, 1), (0.505, 2), (0.51, 3), (1, 1)), "at least 0.01 apart"),
                            ("fast", "list of 2 to 6"), (None, "list of 2 to 6"), ({"at": 0}, "list of 2 to 6")):
            got = problems_of(speed_curve=bad)
            self.assertTrue(any(needle in p for p in got), (bad, got))

    def test_a_point_is_two_numbers_in_range(self):
        for p, needle in (({"at": 0, "speed": 0.2}, "speed must be a number"), ({"at": 0, "speed": 4.5}, "speed must be"),
                          ({"at": 0, "speed": "2"}, "speed must be"), ({"at": 0}, "speed is missing"),
                          ({"speed": 1}, "at is missing"), ({"at": 0, "speed": 1, "ease": 1}, "ease is not a known field"),
                          ({"at": -0.1, "speed": 1}, "at must be"), ({"at": float("nan"), "speed": 1}, "at must be"),
                          ([0, 1], "must be an object")):
            got = problems_of(speed_curve=[p, {"at": 1, "speed": 1}])
            self.assertTrue(any(needle in p for p in got), (p, got))

    def test_a_curve_replaces_speed_and_excludes_reverse_and_freeze(self):
        self.assertEqual(problems_of(speed_curve=RAMP, speed=1), [])
        self.assertTrue(any("replaces speed" in p for p in problems_of(speed_curve=RAMP, speed=2)))
        for k in ("reverse", "freeze"):
            self.assertTrue(any(f"cannot be combined with {k}" in p for p in problems_of(speed_curve=RAMP, **{k: True})))
        self.assertEqual(problems_of(speed_curve=RAMP, audio=True), [])

    def test_the_clip_lasts_the_integral(self):
        n = tl.normalise(vdoc(speed_curve=RAMP))
        self.assertEqual(tl.duration_s(n), 2.112)
        self.assertEqual(tl.clip_end_s(n["tracks"][0]["clips"][0]), 2.112)
        c2 = vdoc(speed_curve=RAMP)
        c2["tracks"][0]["clips"].append({"id": "c2", "asset_id": BASE, "start_s": 2.112, "in_s": 0, "out_s": 1})
        self.assertEqual(tl.validate(c2), [])
        c2["tracks"][0]["clips"][1]["start_s"] = 2.0
        self.assertTrue(any("overlap" in p for p in tl.validate(c2)))
        self.assertTrue(any("fade_in_s + fade_out_s is longer" in p for p in problems_of(
            speed_curve=curve((0, 4), (1, 4)), out_s=2, fade_in_s=0.3, fade_out_s=0.3)))

    def test_a_split_is_refused(self):
        with self.assertRaises(tl.TimelineError) as cm:
            tl.split_clip(vdoc(speed_curve=RAMP), "c1", 1.0, "c2")
        self.assertIn("remove it before splitting", str(cm.exception))

    def test_normalise_rounds_and_drops_false(self):
        n = tl.normalise(vdoc(speed_curve=curve((0, 1.00049), (0.50049, 4), (1, 0.5)), interpolate=False))
        clip = n["tracks"][0]["clips"][0]
        self.assertEqual(clip["speed_curve"], curve((0, 1.0), (0.5, 4.0), (1, 0.5)))
        self.assertNotIn("interpolate", clip)

    def test_interpolate_is_for_slow_motion_inside_its_budget(self):
        self.assertEqual(problems_of(speed=0.5, interpolate=True, out_s=3), [])
        self.assertEqual(problems_of(speed_curve=RAMP, interpolate=True, out_s=3), [])
        self.assertTrue(any("slow motion" in p for p in problems_of(speed=1, interpolate=True)))
        self.assertTrue(any("slow motion" in p for p in problems_of(speed=2, interpolate=True)))
        self.assertTrue(any("slow motion" in p for p in problems_of(speed_curve=curve((0, 2), (1, 4)), interpolate=True)))
        self.assertTrue(any("forward slow motion" in p for p in problems_of(speed=0.5, reverse=True, interpolate=True)))
        self.assertTrue(any("must be true or false" in p for p in problems_of(speed=0.5, interpolate=1)))
        # 1280x720 is 0.444 of 1080p; 0.5x at 30 fps interpolates to 60 fps: 300 / (60 * 0.444) = 11.25 s
        hd = dict(width=1280, height=720)
        self.assertEqual(problems_of(speed=0.5, interpolate=True, out_s=11, **hd), [])
        got = problems_of(speed=0.5, interpolate=True, out_s=12, **hd)
        self.assertTrue(any("at most 300 per clip" in p for p in got), got)
        # 1080p: 0.5x -> 60 fps -> 5 s
        self.assertEqual(problems_of(speed=0.5, interpolate=True, out_s=4.9, width=1920, height=1080), [])
        self.assertTrue(problems_of(speed=0.5, interpolate=True, out_s=5.1, width=1920, height=1080))
        # the rate is capped at 120: 0.25x at 60 fps
        self.assertEqual(sr.slice_count(1.0), 2)
        self.assertEqual(tl.interpolated_frames({"in_s": 0, "out_s": 1, "speed": 0.25}, 60, 1920, 1080), 120)

    def test_the_whole_document_has_a_budget_too(self):
        doc = vdoc(width=1920, height=1080, out_s=4, speed=0.5, interpolate=True)       # 240 frames each
        doc["tracks"][0]["clips"] += [
            {"id": f"d{i}", "asset_id": BASE, "start_s": 8.0 * i, "in_s": 0, "out_s": 4, "speed": 0.5,
             "interpolate": True} for i in (1, 2)]
        got = tl.validate(doc)
        self.assertTrue(any("720 frames" in p and "at most 600" in p for p in got), got)
        doc["tracks"][0]["clips"].pop()
        self.assertEqual(tl.validate(doc), [])

    def test_schema_and_constants(self):
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        props = schema["$defs"]["video_clip"]["properties"]
        self.assertEqual(set(props), set(tl._V_CLIP_KEYS))
        sc = props["speed_curve"]
        self.assertEqual((sc["minItems"], sc["maxItems"]), (tl.RAMP_MIN_POINTS, tl.RAMP_MAX_POINTS))
        self.assertEqual(set(sc["items"]["properties"]), {"at", "speed"})
        self.assertEqual((rs.RAMP_MIN_POINTS, rs.RAMP_MAX_POINTS, rs.INTERP_MAX_FPS),
                         (tl.RAMP_MIN_POINTS, tl.RAMP_MAX_POINTS, tl.INTERP_MAX_FPS))
        self.assertEqual((sr.SLICES_MAX, sr.SLICE_MIN_S), (16, 0.5))
        ts = EDITOR_TS.read_text(encoding="utf-8")
        for name in ("RAMP_MIN_POINTS", "RAMP_MAX_POINTS", "RAMP_MIN_GAP", "INTERP_MAX_FPS", "INTERP_MAX_FRAMES",
                     "INTERP_MAX_FRAMES_DOC"):
            self.assertEqual(float(re.search(rf"export const {name} = ([\d.]+);", ts).group(1)), getattr(tl, name), name)
        self.assertEqual(rs.interp_fps(0.5, 30), 60)
        self.assertEqual(rs.interp_fps(0.25, 60), 120)
        self.assertEqual(rs.interp_fps(0.3, 30), 100)


class SpecTestCase(unittest.TestCase):
    def test_a_curve_reaches_the_segment_and_the_sound(self):
        table = {BASE: tl.ResolvedAsset(BASE, "video", "/m/a.mp4", 20.0, True)}
        spec = tr.to_render_spec(vdoc(speed_curve=RAMP, audio=True, interpolate=False), table.get, "/o.mp4")
        seg = spec.segments[0]
        self.assertEqual(seg.curve, rs.SpeedCurve(((0.0, 1.0), (0.5, 4.0), (1.0, 0.5)), 4.0))
        self.assertEqual((seg.speed, seg.interpolate), (1.0, False))
        t = spec.audio_tracks[0]
        self.assertEqual((t.speed, len(t.tempos)), (1.0, 8))
        self.assertAlmostEqual(t.output_s, 2.112, delta=0.001)
        self.assertEqual(rs.RenderSpec.from_dict(spec.to_dict()), spec)
        plain = tr.to_render_spec(vdoc(), table.get, "/o.mp4")
        self.assertNotIn("curve", plain.segments[0].to_dict())
        self.assertNotIn("interpolate", plain.segments[0].to_dict())

    def test_the_sound_is_as_long_as_the_picture(self):
        table = {BASE: tl.ResolvedAsset(BASE, "video", "/m/a.mp4", 20.0, True)}
        for pairs in (((0, 1), (1, 1)), ((0, 4), (1, 0.25)), ((0, 0.25), (0.2, 4), (0.4, 0.25), (1, 2))):
            spec = tr.to_render_spec(vdoc(out_s=6, speed_curve=curve(*pairs), audio=True), table.get, "/o.mp4")
            picture = sum(s.duration for s in spec.segments)
            self.assertAlmostEqual(spec.audio_tracks[0].output_s, picture, delta=0.05, msg=str(pairs))

    def test_a_spec_is_refused_for_what_would_not_render(self):
        def problems(**kw):
            seg = rs.Segment(2.0, "/m/a.mp4", **kw)
            return rs.validate(rs.RenderSpec("/o.mp4", 1280, 720, 30, segments=[seg], frame_exact=True))
        ok = rs.SpeedCurve(((0.0, 1.0), (1.0, 2.0)), 4.0)
        self.assertEqual(problems(curve=ok), [])
        for kw, needle in (({"curve": rs.SpeedCurve(((0.0, 1.0),), 4.0)}, "needs 2 to 6 points"),
                           ({"curve": rs.SpeedCurve(((0.1, 1.0), (1.0, 2.0)), 4.0)}, "from 0 to 1"),
                           ({"curve": rs.SpeedCurve(((0.0, 9.0), (1.0, 2.0)), 4.0)}, "speeds must be"),
                           ({"curve": rs.SpeedCurve(((0.0, 1.0), (1.0, float("nan"))), 4.0)}, "non-finite"),
                           ({"curve": ok, "speed": 2.0}, "a speed curve and a speed"),
                           ({"curve": ok, "reverse": True}, "reverse or freeze"),
                           ({"interpolate": True}, "forward slow motion"),
                           ({"interpolate": True, "speed": 2.0}, "forward slow motion"),
                           ({"interpolate": True, "speed": 0.5, "reverse": True}, "forward slow motion")):
            self.assertTrue(any(needle in p for p in problems(**kw)), (kw, problems(**kw)))
        self.assertEqual(problems(interpolate=True, speed=0.5), [])
        bad = rs.AudioTrack("/a.wav", 4.0, tempos=(1.0, 9.0))
        self.assertTrue(any("bad speed-ramp tempos" in p for p in rs.validate(rs.RenderSpec(
            "/o.mp4", segments=[rs.Segment(1.0, "/m/a.mp4")], audio_tracks=[bad]))))


class CommandTestCase(unittest.TestCase):
    def cmd(self, seg):
        return render_backend.segment_commands("ffmpeg", seg, Path("/w/s.mp4"), 1280, 720, 30, frame_exact=True)[0]

    def seg(self, **kw):
        return rs.Segment(2.112, "/m/a.mp4", curve=rs.SpeedCurve(((0.0, 1.0), (0.5, 4.0), (1.0, 0.5)), 4.0), **kw)

    def test_the_picture_is_retimed_by_one_expression_before_the_fit(self):
        c = self.cmd(self.seg())
        vf = c[c.index("-vf") + 1]
        self.assertTrue(vf.startswith("setpts='(if(lt(((PTS-STARTPTS)*TB),2.000000),"), vf)
        self.assertRegex(vf, r"\)/TB',scale=1280:720:force_original_aspect_ratio=decrease,pad=")
        self.assertEqual(c[c.index("-stream_loop") + 1], "-1")
        self.assertEqual(c[c.index("-frames:v") + 1], "63")

    def test_a_constant_speed_is_the_chain_it_was(self):
        c = self.cmd(rs.Segment(2.0, "/m/a.mp4", speed=2.0))
        self.assertTrue(c[c.index("-vf") + 1].startswith("setpts=(PTS-STARTPTS)/2.000,scale="))

    def test_interpolation_is_a_dense_pass_after_the_fit(self):
        c = self.cmd(rs.Segment(4.0, "/m/a.mp4", speed=0.5, interpolate=True))
        self.assertEqual(
            c[c.index("-vf") + 1],
            "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,"
            "format=yuv420p,minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:vsbmc=1,"
            "setpts=(PTS-STARTPTS)/0.500,fps=30")
        c = self.cmd(self.seg(interpolate=True))
        vf = c[c.index("-vf") + 1]
        self.assertIn("minterpolate=fps=60:", vf)       # slowest part is 0.5x at 30 fps
        self.assertRegex(vf, r"mci:mc_mode=aobmc:vsbmc=1,setpts='\(if\(lt\(.*\)/TB',fps=30$")
        c = self.cmd(rs.Segment(4.0, "/m/a.mp4", speed=0.25, interpolate=True))
        self.assertIn("minterpolate=fps=120:", c[c.index("-vf") + 1])

    def test_the_sound_is_cut_into_slices_each_at_its_tempo(self):
        t = rs.AudioTrack("/a.wav", 4.0, tempos=(1.0, 2.0, 4.0, 0.5), gain_db=-3.0, loudnorm=True)
        self.assertEqual(
            rs.audio_track_filter(t, 1, "a0"),
            "[1:a]atrim=start=0.000:duration=4.000,asetpts=PTS-STARTPTS,asplit=4[a0i0][a0i1][a0i2][a0i3];"
            "[a0i0]atrim=start=0.000:duration=1.000,asetpts=PTS-STARTPTS,atempo=1.000[a0o0];"
            "[a0i1]atrim=start=1.000:duration=1.000,asetpts=PTS-STARTPTS,atempo=2.000[a0o1];"
            "[a0i2]atrim=start=2.000:duration=1.000,asetpts=PTS-STARTPTS,atempo=2.000,atempo=2.000[a0o2];"
            "[a0i3]atrim=start=3.000:duration=1.000,asetpts=PTS-STARTPTS,atempo=0.500[a0o3];"
            "[a0o0][a0o1][a0o2][a0o3]concat=n=4:v=0:a=1,loudnorm=I=-16:TP=-1.5:LRA=11,"
            "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=-3.000dB[a0]")

    def test_slice_labels_are_unique_per_track_in_the_final_graph(self):
        table = {BASE: tl.ResolvedAsset(BASE, "video", "/m/a.mp4", 20.0, True)}
        doc = vdoc(speed_curve=RAMP, audio=True)
        doc["tracks"][0]["clips"].append({"id": "c2", "asset_id": BASE, "start_s": 2.112, "in_s": 0, "out_s": 4,
                                          "speed_curve": curve((0, 2), (1, 0.5)), "audio": True})
        spec = tr.to_render_spec(doc, table.get, "/o.mp4")
        cmd = rs.build_ffmpeg_command(spec, "/w/c.txt", "/w/o.ass")
        g = cmd[cmd.index("-filter_complex") + 1]
        labels = re.findall(r"\[(a\d+[io]\d+)\]", g)
        self.assertEqual(len(labels), len(set(labels)) * 2, "each slice label is defined once and used once")

    def test_the_expression_has_only_numbers_and_listed_functions(self):
        expr = sr.setpts_expression(sr.absolute(((0, 1), (0.3, 4), (1, 0.25)), 4.0))
        self.assertEqual(set(re.findall(r"[A-Za-z_]+", expr)), {"if", "lt", "log", "PTS", "STARTPTS", "TB"})


class NeutralTestCase(unittest.TestCase):
    def test_every_older_document_renders_the_commands_it_always_did(self):
        for name, doc in trt.neutral_docs().items():
            with self.subTest(name):
                self.assertEqual(trt.digest(doc), trt.LEGACY[name])

    def test_interpolate_switched_off_changes_nothing(self):
        for name, doc in trt.neutral_docs().items():
            doc2 = copy.deepcopy(doc)
            for t in doc2["tracks"]:
                if t["kind"] == "V":
                    for c in t["clips"]:
                        c["interpolate"] = False
            with self.subTest(name):
                self.assertEqual(trt.digest(doc2), trt.LEGACY[name])


# ── real ffmpeg ─────────────────────────────────────────────────────────────

class _Real(spd._Real):
    pass


class RampRenderTestCase(_Real):
    def test_the_expression_puts_every_frame_at_its_output_time(self):
        pts = sr.absolute(((0, 1), (0.5, 4), (1, 0.5)), 4.0)
        src = self.ramp(seconds=4)
        expr = sr.setpts_expression(pts)
        info = subprocess.run([self.ffmpeg, "-hide_banner", "-nostats", "-i", str(src.path), "-an", "-vf",
                               f"setpts='{expr}',showinfo", "-f", "null", "-"], capture_output=True, text=True).stderr
        shown = [(int(m.group(1)), float(m.group(2))) for m in
                 re.finditer(r"n:\s*(\d+) pts:\s*\d+ pts_time:([\d.]+)", info)]
        self.assertGreater(len(shown), 100)
        for n, got in shown:
            want = sr.out_time(pts, n / 30)
            self.assertAlmostEqual(got, want, delta=0.002, msg=f"frame {n}")

    def render(self, src, **kw):
        return self.export(vdoc(width=self.W, height=self.H, fit="cover", **kw), {BASE: src})

    def test_a_clip_follows_its_curve(self):
        src = self.ramp(seconds=4)
        out = self.render(src, speed_curve=RAMP)
        pts = sr.absolute(((0, 1), (0.5, 4), (1, 0.5)), 4.0)
        length = tl.duration_s(tl.normalise(vdoc(speed_curve=RAMP)))
        self.assertEqual(self.count(out), round(length * 30))
        for n in (1, 15, 30, 45, 60):
            t = sr.out_time  # luma = 255 * source_time / 4 at the source time shown in output frame n
            lo, hi = 0.0, 4.0
            for _ in range(60):
                mid = (lo + hi) / 2
                if sr.out_time(pts, mid) < n / 30:
                    lo = mid
                else:
                    hi = mid
            self.assertAlmostEqual(self.luma(out, n), 255 * lo / 4, delta=14, msg=f"frame {n}")
        self.assertGreater(self.luma(out, 59), self.luma(out, 40))

    def test_a_curve_inside_a_cross_fade_keeps_its_length(self):
        src = self.ramp(seconds=4)
        doc = {"version": 1, "width": self.W, "height": self.H, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0, "out_s": 4, "fit": "cover", "speed_curve": RAMP},
            {"id": "c2", "asset_id": BASE, "start_s": 1.612, "in_s": 0, "out_s": 2, "fit": "cover",
             "transition": {"type": "crossfade", "duration_s": 0.5}}]}]}
        out = self.export(doc, {BASE: src})
        self.assertEqual(self.count(out), round((1.612 + 2) * 30))


class RampSoundTestCase(_Real):
    def test_a_tone_keeps_its_pitch_and_the_sound_its_length_through_a_ramp(self):
        src = self.ramp(seconds=6, audio=True)
        cases = (((0, 1), (0.5, 4), (1, 0.5)), ((0, 0.25), (1, 4)), ((0, 2), (1, 2)))
        for pairs in cases:
            with self.subTest(pairs):
                doc = vdoc(width=self.W, height=self.H, out_s=6, audio=True, speed_curve=curve(*pairs))
                out = self.export(doc, {BASE: src})
                length = tl.duration_s(tl.normalise(doc))
                samples = self.pcm(out)
                self.assertAlmostEqual(len(samples) / 8000, length, delta=0.1 + 0.02 * length)
                mid = samples[len(samples) // 4: 3 * len(samples) // 4]
                crossings = sum(1 for a, b in zip(mid, mid[1:]) if a <= 0 < b)
                self.assertAlmostEqual(crossings / (len(mid) / 8000), 440, delta=40)


class InterpolateRenderTestCase(_Real):
    def test_interpolated_slow_motion_renders_and_is_smoother_than_repeated_frames(self):
        w, h = 160, 90
        # a moving ball-like pattern: a white box on black that moves 4 px per source frame
        path = self.dir / "move.mp4"
        self.run_ffmpeg("-f", "lavfi", "-i", f"color=c=black:s={w}x{h}:r=30:d=1", "-f", "lavfi", "-i",
                        "color=c=white:s=20x20:r=30:d=1", "-filter_complex", "[0][1]overlay=x='4*n':y=35:eval=frame",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "10", str(path))
        asset = tl.ResolvedAsset(BASE, "video", str(path), 1.0, False)
        plain = self.export(vdoc(width=w, height=h, out_s=1, speed=0.25, fit="cover"), {BASE: asset})
        smooth = self.export(vdoc(width=w, height=h, out_s=1, speed=0.25, fit="cover", interpolate=True), {BASE: asset})
        self.assertEqual(self.count(plain), 120)
        self.assertEqual(self.count(smooth), 120)

        def centre(path, n):
            raw = self.frames(path, (w, h), [n], "bt601")[n]
            xs = [x for x in range(w) if self.px(raw, w, x, 45)[0] > 128]
            return (min(xs) + max(xs)) / 2 if xs else None
        for path_, name in ((plain, "plain"), (smooth, "smooth")):
            self.__dict__[name] = [centre(path_, n) for n in range(8, 100)]
        # repeated frames move in steps (equal neighbours then a jump); interpolation moves a little every frame
        stalls = lambda xs: sum(1 for a, b in zip(xs, xs[1:]) if a == b)
        self.assertGreater(stalls(self.plain), 60)
        self.assertLess(stalls(self.smooth), stalls(self.plain) // 2)
        self.assertGreater(self.smooth[-1] - self.smooth[0], 30)


if __name__ == "__main__":
    unittest.main()
