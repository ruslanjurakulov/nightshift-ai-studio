"""Speed 0.25-4 with the pitch kept, reverse, and freeze-frame (backend half).

Fields (modules/timeline.py): ``speed`` (now 0.25-4), ``reverse``, ``freeze`` on
a V clip. By class:

* the document: the speed range at both ends and beyond, ``reverse`` /
  ``freeze`` are booleans, a frozen clip has no speed, no sound and no reverse,
  reverse is bounded by memory (frames x frame size), neither works on a
  picture, a frozen clip only needs its frame to exist, normalisation, the
  JSON schema and the constants the three languages share;
* the argv: documents that use none of it render the SAME commands as before
  (golden digests, tests/test_editor_transitions.py LEGACY); sound speeds are
  chains of ``atempo`` stages each within 0.5-2 (one stage inside that range,
  the string older documents had); the reverse and freeze chains are pinned;
* the PIXELS and SAMPLES, real ffmpeg: a clip whose luma encodes time plays
  forward, backward, faster, slower and held as it should; frame counts are the
  timeline's; the pitch of a tone survives 0.25x, 3x and 4x while its length
  changes; reversed sound ramps the other way; a reverse at the memory cap
  completes inside the export's address-space limit.
"""

import copy
import json
import re
import subprocess
import unittest
from pathlib import Path

from modules import ffmpeg_limits, render_backend
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr
from tests import test_editor_effects as fxt
from tests import test_editor_overlay as ovt
from tests import test_editor_transitions as trt

ROOT = Path(__file__).resolve().parent.parent
EDITOR_TS = ROOT / "command-center" / "lib" / "editor.ts"
BASE, PIC = ovt.BASE, ovt.PIC


def vdoc(width=640, height=360, fps=30, in_s=0, out_s=2, **clip):
    return fxt.vdoc(width=width, height=height, fps=fps, **{"in_s": in_s, "out_s": out_s}, **clip)


def problems_of(**kw):
    return tl.validate(vdoc(**kw))


class DocumentTestCase(unittest.TestCase):
    def test_speed_range_at_both_ends_and_beyond(self):
        for ok in (0.25, 0.3, 0.5, 1, 2, 3, 4, 4.0):
            self.assertEqual(problems_of(speed=ok), [], ok)
        for bad in (0.249, 0.2, 4.001, 5, 100, 0, -1, "2", None, True, float("nan"), float("inf"), [2]):
            self.assertTrue(any("speed must be a number" in p for p in problems_of(speed=bad)), bad)
        self.assertEqual((tl.SPEED_MIN, tl.SPEED_MAX), (0.25, 4.0))

    def test_a_faster_or_slower_clip_lasts_accordingly(self):
        n = tl.normalise(vdoc(out_s=4, speed=4))
        self.assertEqual(tl.duration_s(n), 1.0)
        self.assertEqual(tl.duration_s(tl.normalise(vdoc(out_s=2, speed=0.25))), 8.0)
        self.assertTrue(any("shorter than one frame" in p for p in problems_of(out_s=0.05, speed=4)))

    def test_reverse_and_freeze_are_booleans_for_video_clips(self):
        for k in ("reverse", "freeze"):
            self.assertEqual(problems_of(**{k: True}), [])
            self.assertEqual(problems_of(**{k: False}), [])
            for bad in (1, 0, "true", None, [True]):
                self.assertTrue(any(f"{k} must be true or false" in p for p in problems_of(**{k: bad})), (k, bad))
        doc = vdoc()
        doc["tracks"].append({"id": "a1", "kind": "A", "clips": [
            {"id": "m1", "asset_id": ovt.BASE, "start_s": 0, "in_s": 0, "out_s": 1, "reverse": True}]})
        self.assertTrue(any("reverse is not a known field" in p for p in tl.validate(doc)))

    def test_a_frozen_clip_holds_one_frame_and_has_no_speed_sound_or_reverse(self):
        self.assertEqual(problems_of(freeze=True), [])
        self.assertEqual(problems_of(freeze=True, speed=1), [])
        self.assertEqual(problems_of(freeze=True, audio=False), [])
        for kw, needle in (({"speed": 2}, "no speed"), ({"speed": 0.5}, "no speed"), ({"audio": True}, "no sound"),
                           ({"reverse": True}, "cannot also be reversed")):
            self.assertTrue(any(needle in p for p in problems_of(freeze=True, **kw)), kw)
        self.assertEqual(problems_of(freeze=False, speed=2, audio=True), [])

    def test_reverse_is_bounded_by_the_memory_it_holds(self):
        # 1080p / 30 fps: 3 110 400 bytes a frame -> 172 frames -> 5.73 s
        big = dict(width=1920, height=1080, fps=30)
        self.assertEqual(problems_of(reverse=True, out_s=5.7, **big), [])
        got = problems_of(reverse=True, out_s=5.8, **big)
        self.assertTrue(any("reverse holds every frame" in p and "5.7" in p for p in got), got)
        self.assertEqual(problems_of(out_s=600, **big), [], "the limit is for reverse only")
        # 4K / 60 fps: 0.7 s; a phone-sized frame at 24 fps: far longer
        self.assertTrue(problems_of(reverse=True, out_s=0.8, width=3840, height=2160, fps=60))
        self.assertEqual(problems_of(reverse=True, out_s=0.7, width=3840, height=2160, fps=60), [])
        self.assertEqual(problems_of(reverse=True, out_s=30, width=640, height=360, fps=24), [])
        # speed changes how long it plays, not how much it holds
        self.assertTrue(problems_of(reverse=True, speed=4, out_s=5.8, **big))
        self.assertEqual(tl.REVERSE_MAX_BYTES, 512 * 1024 ** 2)

    def test_normalise_drops_false(self):
        n = tl.normalise(vdoc(reverse=False, freeze=False))["tracks"][0]["clips"][0]
        self.assertNotIn("reverse", n)
        self.assertNotIn("freeze", n)
        n = tl.normalise(vdoc(reverse=True))["tracks"][0]["clips"][0]
        self.assertTrue(n["reverse"])

    def test_resolving_assets(self):
        def resolve(doc, **assets):
            table = {BASE: tl.ResolvedAsset(BASE, "video", "/m/a.mp4", 10.0, True),
                     PIC: tl.ResolvedAsset(PIC, "image", "/m/p.png", None)}
            table.update(assets)
            try:
                tl.resolve_assets(tl.load(doc), table.get)
            except tl.TimelineError as e:
                return e.problems
            return []
        self.assertEqual(resolve(vdoc(reverse=True)), [])
        # a frozen clip may be longer than the rest of the file: only its frame has to exist
        self.assertEqual(resolve(vdoc(in_s=9, out_s=14, freeze=True)), [])
        self.assertTrue(any("past the end" in p for p in resolve(vdoc(in_s=9, out_s=14))))
        self.assertTrue(any("in_s 11.0 is past the end" in p for p in resolve(vdoc(in_s=11, out_s=14, freeze=True))))
        for k in ("reverse", "freeze"):
            doc = vdoc(asset=PIC, **{k: True})
            self.assertTrue(any("for video, not a picture" in p for p in resolve(doc)), k)

    def test_schema_and_constants(self):
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        props = schema["$defs"]["video_clip"]["properties"]
        self.assertEqual(set(props), set(tl._V_CLIP_KEYS))
        self.assertEqual((props["speed"]["minimum"], props["speed"]["maximum"]), (0.25, 4.0))
        self.assertEqual(props["reverse"]["type"], "boolean")
        self.assertEqual(props["freeze"]["type"], "boolean")
        self.assertEqual((rs.SPEED_MIN, rs.SPEED_MAX), (tl.SPEED_MIN, tl.SPEED_MAX))
        ts = EDITOR_TS.read_text(encoding="utf-8")
        self.assertEqual(float(re.search(r"export const SPEED_MIN = ([\d.]+);", ts).group(1)), tl.SPEED_MIN)
        self.assertEqual(float(re.search(r"export const SPEED_MAX = ([\d.]+);", ts).group(1)), tl.SPEED_MAX)
        self.assertIn("export const REVERSE_MAX_BYTES = 512 * 1024 * 1024;", ts)
        self.assertIn("export const REVERSE_BYTES_PER_PIXEL = 1.5;", ts)
        self.assertEqual(tl.REVERSE_BYTES_PER_PIXEL, 1.5)

    def test_a_split_keeps_the_picture_continuous(self):
        # reversed: 4 s of source at 2x lasts 2 s; cut after 1 s of the timeline = 2 s of source
        out = tl.split_clip(vdoc(in_s=1, out_s=5, reverse=True, speed=2), "c1", 1.0, "c2")
        a, b = out["tracks"][0]["clips"]
        self.assertTrue(a["reverse"] and b["reverse"])
        self.assertEqual((a["in_s"], a["out_s"], b["in_s"], b["out_s"]), (3, 5, 1, 3))
        self.assertEqual((a["start_s"], b["start_s"]), (0, 1.0))
        # frozen: both halves hold the frame at in_s, for 1 s and 2 s of a 3 s clip
        out = tl.split_clip(vdoc(in_s=2, out_s=5, freeze=True), "c1", 1.0, "c2")
        a, b = out["tracks"][0]["clips"]
        self.assertTrue(a["freeze"] and b["freeze"])
        self.assertEqual((a["in_s"], a["out_s"], b["in_s"], b["out_s"]), (2, 3, 2, 4))
        self.assertEqual(tl.duration_s(out), 3.0)
        # forward is what it was
        out = tl.split_clip(vdoc(in_s=1, out_s=5, speed=2), "c1", 1.0, "c2")
        a, b = out["tracks"][0]["clips"]
        self.assertEqual((a["in_s"], a["out_s"], b["in_s"], b["out_s"]), (1, 3, 3, 5))

    def test_a_reversed_clip_is_cut_off_the_middle_too(self):
        # 0..10 reversed plays 10 -> 0. Cut 3 s into the timeline: the first part plays source 10 -> 7
        # (range 7..10), the second 7 -> 0 (range 0..7). The old in_s + 3 cut at 3 and played 3..10 twice.
        out = tl.split_clip(vdoc(in_s=0, out_s=10, reverse=True), "c1", 3.0, "c2")
        a, b = out["tracks"][0]["clips"]
        self.assertEqual((a["in_s"], a["out_s"], b["in_s"], b["out_s"]), (7, 10, 0, 7))
        self.assertEqual((a["start_s"], b["start_s"]), (0, 3.0))
        self.assertEqual(tl.validate(out), [])           # no overlap, nothing out of range
        self.assertEqual(tl.duration_s(out), tl.duration_s(vdoc(in_s=0, out_s=10, reverse=True)))
        # the same with a speed: 4 s of source at 2x, cut 0.5 s in = 1 s of source off the end
        out = tl.split_clip(vdoc(in_s=1, out_s=5, reverse=True, speed=2), "c1", 0.5, "c2")
        a, b = out["tracks"][0]["clips"]
        self.assertEqual((a["in_s"], a["out_s"], b["in_s"], b["out_s"]), (4, 5, 1, 4))
        self.assertEqual(tl.validate(out), [])
        # a cut at the end is refused
        with self.assertRaises(tl.TimelineError):
            tl.split_clip(vdoc(in_s=0, out_s=10, reverse=True), "c1", 10.0, "c2")

    def test_the_halves_of_a_reversed_split_play_the_same_frames(self):
        # frame k of the whole clip (timeline time t) is source out_s - t*speed; the halves agree
        whole = vdoc(in_s=0, out_s=10, reverse=True)
        out = tl.split_clip(whole, "c1", 3.0, "c2")
        a, b = out["tracks"][0]["clips"]
        for t in (0.0, 1.0, 2.5):
            self.assertAlmostEqual(a["out_s"] - (t - a["start_s"]), 10 - t)
        for t in (3.0, 5.0, 9.5):
            self.assertAlmostEqual(b["out_s"] - (t - b["start_s"]), 10 - t)


class TempoTestCase(unittest.TestCase):
    def test_one_stage_inside_half_to_double_and_the_old_string_is_kept(self):
        for s in (0.5, 0.75, 1.25, 1.5, 2.0):
            self.assertEqual(rs.tempo_chain(s), f"atempo={s:.3f}")
        track = rs.AudioTrack("/a.wav", 4.0, speed=2.0)
        self.assertEqual(rs.audio_track_filter(track, 1, "a0"),
                         "[1:a]atrim=start=0.000:duration=4.000,asetpts=PTS-STARTPTS,atempo=2.000,"
                         "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0]")

    def test_outside_it_the_speed_is_split_into_stages_that_each_fit(self):
        self.assertEqual(rs.tempo_chain(4.0), "atempo=2.000,atempo=2.000")
        self.assertEqual(rs.tempo_chain(3.0), "atempo=2.000,atempo=1.500")
        self.assertEqual(rs.tempo_chain(0.25), "atempo=0.500,atempo=0.500")
        self.assertEqual(rs.tempo_chain(0.3), "atempo=0.500,atempo=0.600")
        for s in (0.25, 0.26, 0.3, 0.49, 2.01, 2.5, 3.9, 4.0):
            stages = [float(x) for x in re.findall(r"atempo=([\d.]+)", rs.tempo_chain(s))]
            self.assertTrue(all(0.5 <= x <= 2.0 for x in stages), (s, stages))
            product = 1.0
            for x in stages:
                product *= x
            self.assertAlmostEqual(product, s, delta=0.003 * len(stages), msg=str(s))

    def test_reverse_goes_before_the_tempo(self):
        track = rs.AudioTrack("/a.wav", 4.0, in_s=1.0, speed=4.0, reverse=True)
        self.assertIn("atrim=start=1.000:duration=4.000,asetpts=PTS-STARTPTS,areverse,asetpts=PTS-STARTPTS,"
                      "atempo=2.000,atempo=2.000,aformat=", rs.audio_track_filter(track, 1, "a0"))


class SpecTestCase(unittest.TestCase):
    def test_flags_reach_the_segment_and_the_clips_sound(self):
        asset = {BASE: tl.ResolvedAsset(BASE, "video", "/m/a.mp4", 20.0, True)}
        spec = tr.to_render_spec(vdoc(out_s=4, reverse=True, speed=2, audio=True), {**asset}.get, "/o.mp4")
        seg = spec.segments[0]
        self.assertTrue(seg.reverse and seg.speed == 2.0 and not seg.freeze)
        self.assertTrue(spec.audio_tracks[0].reverse)
        self.assertEqual(rs.RenderSpec.from_dict(spec.to_dict()), spec)
        frozen = tr.to_render_spec(vdoc(out_s=3, freeze=True), {**asset}.get, "/o.mp4")
        self.assertTrue(frozen.segments[0].freeze)
        self.assertFalse(frozen.audio_tracks)
        plain = tr.to_render_spec(vdoc(), {**asset}.get, "/o.mp4")
        self.assertNotIn("reverse", plain.segments[0].to_dict())
        self.assertNotIn("freeze", plain.segments[0].to_dict())

    def test_a_spec_is_refused_for_what_would_not_render(self):
        def problems(**kw):
            seg = rs.Segment(2.0, "/m/a.mp4", **kw)
            return rs.validate(rs.RenderSpec("/o.mp4", 1280, 720, 30, segments=[seg], frame_exact=True))
        self.assertTrue(any("both reversed and frozen" in p for p in problems(reverse=True, freeze=True)))
        self.assertTrue(any("frozen, which has no speed" in p for p in problems(freeze=True, speed=2.0)))
        pic = rs.Segment(2.0, "/m/p.png", kind=rs.KIND_IMAGE, reverse=True)
        self.assertTrue(any("for video, not a image" in p for p in rs.validate(
            rs.RenderSpec("/o.mp4", 1280, 720, 30, segments=[pic], frame_exact=True))))
        loose = rs.Segment(2.0, "/m/a.mp4", reverse=True)
        self.assertTrue(any("needs frame_exact" in p for p in rs.validate(rs.RenderSpec("/o.mp4", segments=[loose]))))
        self.assertEqual(problems(reverse=True, speed=4.0), [])
        self.assertTrue(problems(speed=4.5))
        self.assertTrue(any("audio track 0 speed" in p for p in rs.validate(rs.RenderSpec(
            "/o.mp4", segments=[rs.Segment(1.0, "/m/a.mp4")], audio_tracks=[rs.AudioTrack("/a.wav", 1.0, speed=0.2)]))))


class CommandTestCase(unittest.TestCase):
    def cmd(self, seg, **kw):
        return render_backend.segment_commands("ffmpeg", seg, Path("/w/s.mp4"), 1280, 720, 30,
                                               frame_exact=True, **kw)[0]

    def test_forward_is_the_command_it_was(self):
        seg = rs.Segment(2.0, "/m/a.mp4", in_s=1.0, speed=2.0)
        c = self.cmd(seg)
        self.assertEqual(c[c.index("-stream_loop") + 1], "-1")
        self.assertEqual(c[c.index("-vf") + 1],
                         "setpts=(PTS-STARTPTS)/2.000,scale=1280:720:force_original_aspect_ratio=decrease,"
                         "pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30")

    def test_the_reverse_chain_is_pinned(self):
        seg = rs.Segment(2.0, "/m/a.mp4", in_s=1.0, speed=2.0, reverse=True)
        c = self.cmd(seg)
        self.assertNotIn("-stream_loop", c, "a reversed clip reads its range once")
        self.assertEqual((c[c.index("-ss") + 1], c[c.index("-t") + 1]), ("1.000", "4.000"))   # 2 s at 2x = 4 s of source
        self.assertEqual(c[c.index("-vf") + 1],
                         "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,"
                         "reverse,setpts=(PTS-STARTPTS)/2.000,fps=30")
        slow = self.cmd(rs.Segment(2.0, "/m/a.mp4", speed=0.5, reverse=True))
        self.assertEqual(slow[slow.index("-t") + 1], "1.000")

    def test_the_freeze_chain_is_pinned(self):
        seg = rs.Segment(2.0, "/m/a.mp4", in_s=3.0, freeze=True)
        c = self.cmd(seg)
        self.assertNotIn("-stream_loop", c)
        self.assertEqual(c[c.index("-ss") + 1], "3.000")
        self.assertNotIn("-t", c)
        self.assertEqual(c[c.index("-vf") + 1],
                         "trim=end_frame=1,setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,"
                         "pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,tpad=stop=59:stop_mode=clone")
        self.assertEqual(c[c.index("-frames:v") + 1], "60")

    def test_the_other_filters_wrap_the_chain_as_before(self):
        seg = rs.Segment(2.0, "/m/a.mp4", reverse=True, fade_in_s=0.5, move=rs.ClipMove(1, 0.5, 0.5, 2, 0.5, 0.5),
                         effects=rs.ClipEffects(rotate=90, filter="mono"))
        vf = self.cmd(seg)[self.cmd(seg).index("-vf") + 1]
        self.assertTrue(vf.startswith("transpose=1,scale="))
        self.assertRegex(vf, r"hue=s=0.000,pad=.*,fps=30,reverse,setpts=.*,fps=30,setsar=1,scale=w=.*crop=.*,fade=t=in")

    def test_a_reversed_or_frozen_piece_of_a_crossfade_is_cut_from_the_whole_clip(self):
        doc = {"version": 1, "width": 640, "height": 360, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0, "out_s": 2, "reverse": True},
            {"id": "c2", "asset_id": BASE, "start_s": 1.5, "in_s": 3, "out_s": 5, "freeze": True,
             "transition": {"type": "crossfade", "duration_s": 0.5}}]}]}
        cmds, _ = trt.all_commands(doc)
        c = next(c for group in cmds[:-1] for c in group if "-filter_complex" in c)
        g = c[c.index("-filter_complex") + 1].split(";")
        self.assertIn("reverse,setpts=", g[0])
        self.assertIn("trim=end_frame=1", g[1])
        self.assertIn("tpad=stop=59:stop_mode=clone", g[1])
        self.assertIn("trim=start_frame=45", g[0], "the last 15 frames of the 60-frame reversed clip")
        inputs = [c[i + 1] for i, t in enumerate(c) if t == "-i"]
        self.assertEqual(len(inputs), 2)
        self.assertEqual(c.count("-stream_loop"), 0)

    def test_the_sound_of_a_reversed_fast_clip(self):
        asset = {BASE: tl.ResolvedAsset(BASE, "video", "/m/a.mp4", 20.0, True)}
        spec = tr.to_render_spec(vdoc(out_s=4, reverse=True, speed=4, audio=True), asset.get, "/o.mp4")
        graph = rs.build_ffmpeg_command(spec, "/w/c.txt", "/w/o.ass")
        g = graph[graph.index("-filter_complex") + 1]
        self.assertIn("atrim=start=0.000:duration=4.000,asetpts=PTS-STARTPTS,areverse,asetpts=PTS-STARTPTS,"
                      "atempo=2.000,atempo=2.000,aformat=", g)


class NeutralTestCase(unittest.TestCase):
    def test_every_older_document_renders_the_commands_it_always_did(self):
        for name, doc in trt.neutral_docs().items():
            with self.subTest(name):
                self.assertEqual(trt.digest(doc), trt.LEGACY[name])

    def test_flags_switched_off_change_nothing(self):
        for name, doc in trt.neutral_docs().items():
            doc2 = copy.deepcopy(doc)
            for t in doc2["tracks"]:
                if t["kind"] == "V":
                    for c in t["clips"]:
                        c.update(reverse=False, freeze=False)
            with self.subTest(name):
                self.assertEqual(trt.digest(doc2), trt.LEGACY[name])


# ── real ffmpeg ─────────────────────────────────────────────────────────────

class _Real(fxt._Real):
    def ramp(self, name="ramp", seconds=4, size=None, fps=30, audio=False):
        """A video whose luma is the time: black at 0 s up to white at ``seconds``
        (and, with ``audio``, a 440 Hz tone that grows louder with the time)."""
        path = self.dir / f"{name}.mp4"
        size = size or f"{self.W}x{self.H}"
        args = ["-f", "lavfi", "-i",
                f"nullsrc=s={size}:r={fps}:d={seconds},format=yuv420p,"
                f"geq=lum='clip(16+219*T/{seconds}\\,16\\,235)':cb=128:cr=128"]
        if audio:
            args += ["-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={seconds},"
                                          f"volume='min(1\\,t/{seconds})':eval=frame"]
        args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12", *(["-c:a", "aac"] if audio else []),
                 str(path)]
        self.run_ffmpeg(*args)
        return tl.ResolvedAsset(BASE, "video", str(path), float(seconds), audio)

    def luma(self, path, n):
        raw = self.frames(path, (self.W, self.H), [n], "bt601")[n]
        return self.px(raw, self.W, self.W // 2, self.H // 2)[0]

    def count(self, path):
        info = subprocess.run([self.ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-map", "0:v:0", "-vf",
                               "showinfo", "-f", "null", "-"], capture_output=True, text=True).stderr
        return len(re.findall(r"Parsed_showinfo_0 .*\bn:\s*\d+", info))

    def pcm(self, path):
        raw = self.run_ffmpeg("-i", str(path), "-vn", "-f", "s16le", "-ac", "1", "-ar", "8000", "-")
        return [int.from_bytes(raw[i:i + 2], "little", signed=True) for i in range(0, len(raw) - 1, 2)]


class PictureRenderTestCase(_Real):
    def render(self, src, **kw):
        return self.export(vdoc(width=self.W, height=self.H, fit="cover", **kw), {BASE: src})

    def test_forward_reverse_and_speed_play_the_ramp_as_they_should(self):
        src = self.ramp(seconds=4)
        fwd = self.render(src, in_s=1, out_s=3)                       # luma 64 -> 191 over 2 s
        self.assertEqual(self.count(fwd), 60)
        self.assertAlmostEqual(self.luma(fwd, 1), 64 + 128 * 1 / 60 * 1, delta=8)
        self.assertAlmostEqual(self.luma(fwd, 58), 191, delta=10)
        rev = self.render(src, in_s=1, out_s=3, reverse=True)
        self.assertEqual(self.count(rev), 60)
        self.assertAlmostEqual(self.luma(rev, 1), 191, delta=10)
        self.assertAlmostEqual(self.luma(rev, 58), 64, delta=10)
        self.assertGreater(self.luma(rev, 1), self.luma(rev, 30) + 20)
        fast = self.render(src, in_s=0, out_s=4, speed=4)             # 1 s: 30 frames, ramp over all of it
        self.assertEqual(self.count(fast), 30)
        self.assertAlmostEqual(self.luma(fast, 15), 128, delta=12)
        self.assertAlmostEqual(self.luma(fast, 28), 255 * 28 / 30, delta=14)
        slow = self.render(src, in_s=0, out_s=1, speed=0.25)          # 4 s: 120 frames of the first quarter
        self.assertEqual(self.count(slow), 120)
        self.assertAlmostEqual(self.luma(slow, 60), 32, delta=8)
        rfast = self.render(src, in_s=0, out_s=4, speed=2, reverse=True)
        self.assertEqual(self.count(rfast), 60)
        self.assertAlmostEqual(self.luma(rfast, 1), 250, delta=14)
        self.assertAlmostEqual(self.luma(rfast, 30), 128, delta=14)

    def test_freeze_holds_the_frame_at_in_s_for_the_whole_clip(self):
        src = self.ramp(seconds=4)
        out = self.render(src, in_s=2, out_s=5, freeze=True)          # the file ends at 4 s: only the frame is needed
        self.assertEqual(self.count(out), 90)
        values = [self.luma(out, n) for n in (0, 30, 89)]
        self.assertTrue(all(abs(v - 128) < 10 for v in values), values)
        self.assertLess(max(values) - min(values), 6)

    def test_flags_work_on_both_sides_of_a_crossfade(self):
        src = self.ramp(seconds=4)
        doc = {"version": 1, "width": self.W, "height": self.H, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0, "out_s": 2, "fit": "cover", "reverse": True},
            {"id": "c2", "asset_id": BASE, "start_s": 1.5, "in_s": 3, "out_s": 5, "fit": "cover", "freeze": True,
             "transition": {"type": "crossfade", "duration_s": 0.5}}]}]}
        out = self.export(doc, {BASE: src})
        self.assertEqual(self.count(out), 105)
        self.assertAlmostEqual(self.luma(out, 1), 255 * 2 / 4, delta=12, msg="the reversed clip starts at the end of its range")
        self.assertAlmostEqual(self.luma(out, 40), 255 * (2 - 40 / 30) / 4, delta=12, msg="and plays back down")
        self.assertAlmostEqual(self.luma(out, 100), 255 * 3 / 4, delta=12, msg="the frozen clip is the frame at 3 s")

    def test_a_reverse_at_the_memory_cap_fits_the_exports_address_space(self):
        # 1080p / 30 fps, the longest range the document allows (5.7 s)
        w, h = 1920, 1080
        path = self.dir / "big.mp4"
        self.run_ffmpeg("-f", "lavfi", "-i", f"testsrc2=s={w}x{h}:r=30:d=6", "-c:v", "libx264", "-preset", "ultrafast",
                        "-pix_fmt", "yuv420p", str(path))
        asset = tl.ResolvedAsset(BASE, "video", str(path), 6.0, False)
        doc = vdoc(width=w, height=h, out_s=5.7, reverse=True)
        self.assertEqual(tl.validate(doc), [])
        spec = tr.to_render_spec(doc, {BASE: asset}.get, str(self.dir / "o.mp4"))
        cmds = render_backend.segment_commands(self.ffmpeg, spec.segments[0], self.dir / "seg.mp4", w, h, 30,
                                               x264=render_backend.INTERMEDIATE_X264, frame_exact=True)
        out = ffmpeg_limits.run(cmds[0], timeout_s=600)
        self.assertTrue(out.ok, out.tail)
        self.assertGreater(out.peak_rss_bytes, 0)
        self.assertLess(out.peak_rss_bytes, ffmpeg_limits.CHILD_MEM_BYTES, out.peak_rss_bytes)
        self.assertEqual(self.count(self.dir / "seg.mp4"), 171)


class SoundRenderTestCase(_Real):
    def tone_hz(self, samples, rate=8000):
        crossings = sum(1 for a, b in zip(samples, samples[1:]) if a <= 0 < b)
        return crossings / (len(samples) / rate)

    def sound(self, **kw):
        src = self.ramp(seconds=4, audio=True)
        doc = vdoc(width=self.W, height=self.H, out_s=4, audio=True, **kw)
        return self.export(doc, {BASE: src})

    def test_pitch_is_kept_while_length_changes(self):
        for speed, seconds in ((0.25, 16), (3.0, 4 / 3), (4.0, 1.0), (1.0, 4.0)):
            with self.subTest(speed):
                out = self.sound(speed=speed)
                samples = self.pcm(out)
                self.assertAlmostEqual(len(samples) / 8000, seconds, delta=0.12 * max(1, seconds / 4))
                mid = samples[len(samples) // 4: 3 * len(samples) // 4]
                self.assertAlmostEqual(self.tone_hz(mid), 440, delta=25)

    def test_reversed_sound_gets_quieter_instead_of_louder(self):
        def thirds(samples):
            n = len(samples) // 3
            return [max(abs(x) for x in samples[i * n:(i + 1) * n]) for i in range(3)]
        fwd = thirds(self.pcm(self.sound()))
        rev = thirds(self.pcm(self.sound(reverse=True)))
        self.assertTrue(fwd[0] < fwd[1] < fwd[2], fwd)
        self.assertTrue(rev[0] > rev[1] > rev[2], rev)
        self.assertAlmostEqual(self.tone_hz(self.pcm(self.sound(reverse=True, speed=2))[2000:-2000]), 440, delta=25)


if __name__ == "__main__":
    unittest.main()
