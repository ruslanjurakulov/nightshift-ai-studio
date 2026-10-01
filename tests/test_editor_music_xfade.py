"""Editor follow-ups to migration 0054: a music / sound-effect track, a
cross-fade between two neighbouring clips, and a wall-clock limit on export
renders.

What would break, by test:

* the cross-fade must render as overlapping picture INSIDE the existing path
  (timeline -> RenderSpec -> render_backend): one xfade segment between the
  two clips' own pieces, and the concatenation still exactly the timeline's
  frames — older documents' argv is pinned in test_timeline_render.py;
* a piece of a clip is filtered as the whole clip and then cut, so fades and
  a still's slow zoom do not restart at a cut;
* two clips that both play their own sound are joined with acrossfade; music
  keeps its gain and fades and is mixed without normalisation;
* nothing a document says reaches a filter graph as text — only numbers this
  code formats;
* a hung ffmpeg is killed at the deadline (never retried, never fallen back
  from), and the export ends as failed with 'timed_out' and no work folder.
"""

import json
import re
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from modules import editor_export, render_backend
from modules import media_library as ml
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr

A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"
IMG = "33333333-3333-4333-8333-333333333333"
MU = "44444444-4444-4444-8444-444444444444"

ASSETS = {
    A: tl.ResolvedAsset(A, "video", "/media/a.mp4", 20.0, True),
    B: tl.ResolvedAsset(B, "video", "/media/b.mp4", 20.0, True),
    IMG: tl.ResolvedAsset(IMG, "image", "/media/i.png", None),
    MU: tl.ResolvedAsset(MU, "audio", "/media/m.mp3", 180.0),
}


def xf(d):
    return {"type": "crossfade", "duration_s": d}


def xdoc():
    """c1 (video, sound) dissolves into c2 (video at 2x, sound) over 0.5 s,
    which dissolves into a still over 1 s; music under it all."""
    return {"version": 1, "width": 1280, "height": 720, "fps": 30, "tracks": [
        {"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": A, "start_s": 0, "in_s": 1, "out_s": 4, "audio": True},
            {"id": "c2", "asset_id": B, "start_s": 2.5, "in_s": 0, "out_s": 4, "audio": True,
             "speed": 2, "transition": xf(0.5)},
            {"id": "c3", "asset_id": IMG, "start_s": 3.5, "in_s": 0, "out_s": 2,
             "transition": xf(1)}]},
        {"id": "a1", "kind": "A", "clips": [
            {"id": "m1", "asset_id": MU, "start_s": 0.5, "in_s": 30, "out_s": 35, "gain_db": -9.5,
             "fade_in_s": 1, "fade_out_s": 1.5}]}]}


def commands(spec):
    return [render_backend.segment_commands("ffmpeg", s, Path(f"/w/seg_{i:04d}.mp4"), spec.width,
                                            spec.height, spec.fps, seed=s.seed or f"{i}:{s.path}",
                                            frame_exact=spec.frame_exact)
            for i, s in enumerate(spec.segments)]


FIT = "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30"
PIN = ",settb=1/30,fps=30,format=yuv420p"
ENC = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30"]
PAN = ("scale=1472:828:force_original_aspect_ratio=increase:flags=lanczos,loop=loop=-1:size=1,"
       "settb=1/30,setpts=N,crop=w=1207:h=679:x='clip(trunc(iw*(0.5-0.15+0.3*min(1,n/60.000000)))"
       "-603,0,iw-ow)':y='(ih-oh)/2',scale=1280:720:flags=lanczos")

GOLDEN_XFADE_SEGMENTS = [
    # c1 alone: frames 0-74.
    [["ffmpeg", "-y", "-stream_loop", "-1", "-ss", "1.000", "-i", "/media/a.mp4", "-frames:v", "75",
      "-an", "-vf", FIT, *ENC, "/w/seg_0000.mp4"]],
    # c1's last 15 frames dissolve into c2's first 15 (c2 at 2x).
    [["ffmpeg", "-y", "-stream_loop", "-1", "-ss", "1.000", "-i", "/media/a.mp4",
      "-stream_loop", "-1", "-i", "/media/b.mp4", "-filter_complex",
      f"[0:v]{FIT},trim=start_frame=75,setpts=PTS-STARTPTS{PIN}[xa];"
      f"[1:v]setpts=(PTS-STARTPTS)/2.000,{FIT}{PIN}[xb];"
      "[xa][xb]xfade=transition=fade:duration=0.500000:offset=0[xv]",
      "-map", "[xv]", "-frames:v", "15", "-an", *ENC, "/w/seg_0001.mp4"]],
    # c2 alone: its frames 15-29.
    [["ffmpeg", "-y", "-stream_loop", "-1", "-i", "/media/b.mp4", "-frames:v", "15", "-an", "-vf",
      f"setpts=(PTS-STARTPTS)/2.000,{FIT},trim=start_frame=15,setpts=PTS-STARTPTS", *ENC,
      "/w/seg_0002.mp4"]],
    # c2's last 30 frames dissolve into the still's first 30, the still
    # already making its move (held, as for any still, if the move fails).
    [["ffmpeg", "-y", "-stream_loop", "-1", "-i", "/media/b.mp4", "-i", "/media/i.png",
      "-filter_complex",
      f"[0:v]setpts=(PTS-STARTPTS)/2.000,{FIT},trim=start_frame=30,setpts=PTS-STARTPTS{PIN}[xa];"
      f"[1:v]{PAN}{PIN}[xb];"
      "[xa][xb]xfade=transition=fade:duration=1.000000:offset=0[xv]",
      "-map", "[xv]", "-frames:v", "30", "-an", *ENC, "/w/seg_0003.mp4"],
     ["ffmpeg", "-y", "-stream_loop", "-1", "-i", "/media/b.mp4", "-loop", "1", "-i", "/media/i.png",
      "-filter_complex",
      f"[0:v]setpts=(PTS-STARTPTS)/2.000,{FIT},trim=start_frame=30,setpts=PTS-STARTPTS{PIN}[xa];"
      f"[1:v]{FIT}{PIN}[xb];"
      "[xa][xb]xfade=transition=fade:duration=1.000000:offset=0[xv]",
      "-map", "[xv]", "-frames:v", "30", "-an", *ENC, "/w/seg_0003.mp4"]],
    # The still alone: the SAME move (same seed, same 60-frame span), cut at frame 30.
    [["ffmpeg", "-y", "-i", "/media/i.png", "-frames:v", "30", "-vf",
      f"{PAN},trim=start_frame=30,setpts=PTS-STARTPTS", *ENC, "/w/seg_0004.mp4"],
     ["ffmpeg", "-y", "-loop", "1", "-i", "/media/i.png", "-frames:v", "30", "-vf",
      f"{FIT},trim=start_frame=30,setpts=PTS-STARTPTS", *ENC, "/w/seg_0004.mp4"]],
]

AF = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
GOLDEN_XFADE_FINAL = [
    "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", "/w/concat.txt",
    "-i", "/media/a.mp4", "-i", "/media/b.mp4", "-i", "/media/m.mp3",
    "-filter_complex",
    # c1's sound and c2's (2x, and fading out under the silent still) are
    # joined by acrossfade over the 0.5 s overlap, then placed at 0.
    f"[1:a]atrim=start=1.000:duration=3.000,asetpts=PTS-STARTPTS,{AF}[s0];"
    f"[2:a]atrim=start=0.000:duration=4.000,asetpts=PTS-STARTPTS,atempo=2.000,{AF},"
    "afade=t=out:st=1.000:d=1.000[s1];"
    "[s0][s1]acrossfade=d=0.500:c1=tri:c2=tri[x1];[x1]anull[a0];"
    # The music: trimmed, -9.5 dB, faded, from 0.5 s.
    f"[3:a]atrim=start=30.000:duration=5.000,asetpts=PTS-STARTPTS,{AF},volume=-9.500dB,"
    "afade=t=in:st=0:d=1.000,afade=t=out:st=3.500:d=1.500,adelay=delays=500:all=1[a2];"
    "[a0][a2]amix=inputs=2:duration=longest:normalize=0,apad,atrim=end=5.500000[aout]",
    "-map", "0:v", "-map", "[aout]", "-r", "30", "-c:v", "libx264", "-preset", "medium",
    "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "/out/x.mp4"]


class CrossfadeDocumentTestCase(unittest.TestCase):
    def test_a_crossfade_is_the_overlap_of_two_neighbouring_clips(self):
        self.assertEqual(tl.validate(xdoc()), [])
        norm = tl.load(xdoc())
        pairs = [(p["id"], c["id"], d) for p, c, d in tl.crossfades(norm["tracks"][0])]
        self.assertEqual(pairs, [("c1", "c2", 0.5), ("c2", "c3", 1.0)])
        # The overlap is the dissolve, not an overlap problem; the timeline
        # ends where the last clip ends.
        self.assertEqual(tl.overlaps(norm), [])
        self.assertEqual(tl.duration_s(norm), 5.5)

    def test_bounds_and_layout_are_checked(self):
        cases = [
            (lambda d: d["tracks"][0]["clips"][1]["transition"].update(duration_s=0.15),
             "duration_s must be a number >= 0.2"),
            (lambda d: d["tracks"][0]["clips"][1]["transition"].update(duration_s=2.01),
             "duration_s must be a number >= 0.2 and <= 2"),
            # Moved without changing the duration: no longer laid out as one.
            (lambda d: d["tracks"][0]["clips"][1].update(start_s=2.6),
             "cross-fade must start 0.500 s before clip 'c1' ends"),
            (lambda d: d["tracks"][0]["clips"][0].update(transition=xf(0.5)),
             "a cross-fade needs a clip before it"),
        ]
        for mutate, needle in cases:
            with self.subTest(needle):
                d = xdoc()
                mutate(d)
                self.assertTrue(any(needle in p for p in tl.validate(d)), tl.validate(d))

    def test_a_crossfade_needs_material_on_both_sides(self):
        # The still is 2 s; a dissolve of 2 s into it plus c2's 0.5 s in from
        # c1 meet inside c2 (2 s long): there is no hidden handle to use.
        d = xdoc()
        d["tracks"][0]["clips"][2].update(start_s=2.5, transition=xf(2))
        problems = tl.validate(d)
        self.assertTrue(any("its cross-fades (0.500 + 2.000 s) are longer than the clip" in p
                            for p in problems), problems)

    def test_older_transitions_still_validate_and_wipe_is_refused(self):
        d = xdoc()
        d["tracks"][0]["clips"][1]["transition"] = {"type": "wipe", "duration_s": 0.5}
        self.assertTrue(any("transition type must be one of" in p for p in tl.validate(d)))


class CrossfadeRenderSpecTestCase(unittest.TestCase):
    def setUp(self):
        self.spec = tr.to_render_spec(xdoc(), ASSETS.get, "/out/x.mp4")

    def test_pieces_and_the_dissolve_add_up_to_exactly_the_timeline(self):
        frames = [rs.segment_frames(s.duration, 30) for s in self.spec.segments]
        self.assertEqual(frames, [75, 15, 15, 30, 30])
        self.assertEqual(sum(frames), 165)               # 5.5 s × 30
        self.assertEqual(self.spec.video_length_s, 5.5)
        self.assertEqual(rs.validate(self.spec), [])
        x = self.spec.segments[1]
        self.assertEqual((x.path, x.offset_s, x.clip_s), ("/media/a.mp4", 2.5, 3.0))
        self.assertEqual((x.xfade.path, x.xfade.offset_s, x.xfade.clip_s, x.xfade.speed),
                         ("/media/b.mp4", 0.0, 2.0, 2.0))

    def test_golden_xfade_segment_commands(self):
        self.assertEqual(commands(self.spec), GOLDEN_XFADE_SEGMENTS)

    def test_golden_acrossfade_and_music_mix(self):
        self.assertEqual(rs.build_ffmpeg_command(self.spec, "/w/concat.txt"), GOLDEN_XFADE_FINAL)

    def test_spec_round_trips_through_a_dict(self):
        again = rs.RenderSpec.from_dict(json.loads(json.dumps(self.spec.to_dict())))
        self.assertEqual(again, self.spec)

    def test_a_one_sided_crossfade_fades_the_sound_that_exists(self):
        d = xdoc()
        d["tracks"][0]["clips"][0]["audio"] = False      # c1 silent, c2 sounds
        tracks = tr.to_render_spec(d, ASSETS.get, "/out/x.mp4").audio_tracks
        self.assertEqual([(t.path, t.fade_in_s, t.fade_out_s, t.crossfade_s) for t in tracks][:1],
                         [("/media/b.mp4", 0.5, 1.0, 0.0)])

    def test_pieces_need_the_frame_grid_and_must_lie_inside_their_clip(self):
        seg = self.spec.segments[2]
        bad = rs.RenderSpec("/o.mp4", segments=[seg])        # frame_exact off
        self.assertTrue(any("needs frame_exact" in p for p in rs.validate(bad)))
        from dataclasses import replace
        past = replace(self.spec, segments=[replace(seg, offset_s=1.9)])
        self.assertTrue(any("runs past the end of its clip" in p for p in rs.validate(past)))
        colour = replace(self.spec, segments=[replace(self.spec.segments[1],
                                                      xfade=rs.Segment(0.5, None, rs.KIND_COLOR))])
        self.assertTrue(any("needs a picture on both sides" in p for p in rs.validate(colour)))

    def test_an_acrossfade_needs_a_track_before_it_and_room_on_both(self):
        first = rs.AudioTrack("/a.wav", 2.0, crossfade_s=0.5)
        self.assertTrue(any("needs a track before it" in p for p in rs.validate(
            rs.RenderSpec("/o.mp4", segments=[rs.Segment(1.0)], audio_tracks=[first]))))
        long = [rs.AudioTrack("/a.wav", 1.0), rs.AudioTrack("/b.wav", 3.0, crossfade_s=1.5)]
        self.assertTrue(any("longer than a track it joins" in p for p in rs.validate(
            rs.RenderSpec("/o.mp4", segments=[rs.Segment(1.0)], audio_tracks=long))))

    def test_nothing_from_the_document_reaches_a_filter_graph(self):
        # Clip ids, names and asset ids never appear in any argument; the
        # only document-derived things in a graph are numbers formatted here.
        d = xdoc()
        for c, new in zip(d["tracks"][0]["clips"], ("zzalpha", "zzbeta", "zzgamma")):
            c["id"] = new
        spec = tr.to_render_spec(d, ASSETS.get, "/out/x.mp4")
        argv = [a for cmds in commands(spec) for c in cmds for a in c]
        argv += rs.build_ffmpeg_command(spec, "/w/concat.txt")
        for token in (A, B, IMG, MU, "zzalpha", "zzbeta", "zzgamma", "clip:"):
            self.assertFalse(any(token in a for a in argv), token)
        graphs = [a for a in argv if "[0:v]" in a or "[1:a]" in a]
        self.assertTrue(graphs)
        for g in graphs:
            self.assertNotIn("/media/", g)               # paths are -i arguments only

    def test_music_gain_and_fades_are_bounded_before_any_graph(self):
        d = xdoc()
        d["tracks"][1]["clips"][0]["gain_db"] = 30
        with self.assertRaises(tl.TimelineError):
            tr.to_render_spec(d, ASSETS.get, "/out/x.mp4")
        d = xdoc()
        d["tracks"][1]["clips"][0].update(fade_in_s=3, fade_out_s=3)
        with self.assertRaises(tl.TimelineError):
            tr.to_render_spec(d, ASSETS.get, "/out/x.mp4")


class _FakeProc:
    """A process that never finishes on its own, like a hung ffmpeg."""

    def __init__(self, *a, **k):
        self.killed = False
        self.reaped = False
        self.returncode = None
        _FakeProc.last = self

    def communicate(self, timeout=None):
        if self.killed:
            self.reaped = True
            self.returncode = -9
            return "", ""
        raise subprocess.TimeoutExpired("ffmpeg", timeout)

    def kill(self):
        self.killed = True


class DeadlineTestCase(unittest.TestCase):
    def test_a_hung_ffmpeg_is_killed_and_reaped_at_the_deadline(self):
        with mock.patch.object(render_backend.subprocess, "Popen", _FakeProc):
            with self.assertRaises(render_backend.RenderTimeout):
                render_backend._run(["ffmpeg", "-i", "x"], deadline=time.monotonic() + 0.01)
        self.assertTrue(_FakeProc.last.killed)
        self.assertTrue(_FakeProc.last.reaped)

    def test_past_the_deadline_nothing_is_started(self):
        with mock.patch.object(render_backend.subprocess, "Popen") as popen:
            with self.assertRaises(render_backend.RenderTimeout):
                render_backend._run(["ffmpeg"], deadline=time.monotonic() - 1)
        popen.assert_not_called()

    def test_without_a_deadline_the_call_is_the_one_it_always_was(self):
        with mock.patch.object(render_backend.subprocess, "run") as run, \
                mock.patch.object(render_backend.subprocess, "Popen") as popen:
            run.return_value = subprocess.CompletedProcess([], 0, "", "")
            render_backend._run(["ffmpeg"])
        run.assert_called_once_with(["ffmpeg"], capture_output=True, text=True)
        popen.assert_not_called()

    def test_a_timeout_is_not_retried_or_fallen_back_from(self):
        spec = tr.to_render_spec(xdoc(), ASSETS.get, "/out/x.mp4")
        calls = []

        def hang(cmd, deadline=None):
            calls.append(deadline)
            raise render_backend.RenderTimeout("late")

        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(render_backend, "_run", side_effect=hang), \
                mock.patch.object(render_backend.ass_captions, "has_libass", return_value=True):
            with self.assertRaises(render_backend.RenderTimeout):
                render_backend.render(spec, ffmpeg="ffmpeg", workdir=tmp, jobs=1, timeout_s=30)
            # The work dir is left empty: the render's temp folder is gone.
            self.assertEqual(list(Path(tmp).iterdir()), [])
        # One attempt (the first segment), every one under the same deadline:
        # no sequential redo, no Ken Burns hold.
        self.assertEqual(len(calls), 1)
        self.assertIsNotNone(calls[0])


class ExportTimeLimitTestCase(unittest.TestCase):
    def test_the_limit_is_three_times_the_length_plus_two_minutes_capped(self):
        self.assertEqual(editor_export.render_timeout_s(10), 150)
        self.assertEqual(editor_export.render_timeout_s(600), 1920)
        self.assertEqual(editor_export.render_timeout_s(1800), editor_export.RENDER_TIMEOUT_MAX_S)
        for bad in (float("nan"), float("inf"), "x", None):
            self.assertLessEqual(editor_export.render_timeout_s(bad), editor_export.RENDER_TIMEOUT_MAX_S)

    def test_a_render_past_its_limit_fails_the_export_with_timed_out(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        f = ml.asset_file(root, A, "original")
        f.parent.mkdir(parents=True)
        f.write_bytes(b"x")
        seen = {}

        def late(doc, resolver, out, **kw):
            seen.update(kw)
            Path(out).write_bytes(b"partial")
            raise render_backend.RenderTimeout("late")

        class Store:
            finished = []

            def export_assets(self, eid):
                return [{"id": A, "kind": "video", "mime": "video/mp4", "duration_s": 20, "variants": []}]

            def export_heartbeat(self, *a):
                return True

            def finish_export(self, *a):
                self.finished.append(a)
                return "failed"

        doc = {"version": 1, "width": 64, "height": 36, "fps": 30, "tracks": [
            {"id": "v1", "kind": "V", "clips": [
                {"id": "c1", "asset_id": A, "start_s": 0, "in_s": 0, "out_s": 10}]}]}
        store = Store()
        eid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
        status = editor_export.run_export(
            {"id": eid, "org_id": "00000000-0000-4000-8000-000000000001",
             "project_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "rev": 1, "duration_s": 10, "doc": doc},
            store=store, media_root=root, worker_id="w1", tools=ml.Tools("ffprobe", "ffmpeg"),
            render=late, has_audio=lambda p, m: False, heartbeat_s=0.01)
        self.assertEqual(status, "failed")
        self.assertEqual(store.finished[-1][2:], (None, "timed_out"))
        self.assertEqual(seen["timeout_s"], 150.0)          # 3 × 10 s + 120 s
        self.assertFalse((root / editor_export.WORK_DIRNAME / eid).exists())
        self.assertIn("timed_out", editor_export.REASONS)


def _ffmpeg():
    import shutil

    exe = render_backend.resolve_ffmpeg()
    if not exe or (exe == "ffmpeg" and not shutil.which("ffmpeg")):
        return None
    try:
        out = subprocess.run([exe, "-hide_banner", "-filters"], capture_output=True, text=True).stdout
    except OSError:
        return None
    return exe if (" xfade " in out and " acrossfade " in out) else None


@unittest.skipUnless(_ffmpeg(), "ffmpeg with xfade / acrossfade not available")
class RealCrossfadeRenderTestCase(unittest.TestCase):
    """A tiny real render: red with a 440 Hz tone dissolves into blue with
    880 Hz, then into a green still; music under it all."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        f = self.ffmpeg = _ffmpeg()
        for name, colour, hz in (("a.mp4", "red", 440), ("b.mp4", "blue", 880)):
            render_backend._run([f, "-y", "-f", "lavfi", "-i", f"color=c={colour}:s=96x64:r=30:d=6",
                                 "-f", "lavfi", "-i", f"sine=frequency={hz}:duration=6", "-shortest",
                                 "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(d / name)])
        render_backend._run([f, "-y", "-f", "lavfi", "-i", "color=c=0x00FF00:s=64x48", "-frames:v", "1",
                             str(d / "g.png")])
        render_backend._run([f, "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=10",
                             "-c:a", "pcm_s16le", str(d / "m.wav")])
        self.assets = {
            A: tl.ResolvedAsset(A, "video", str(d / "a.mp4"), 6.0, True),
            B: tl.ResolvedAsset(B, "video", str(d / "b.mp4"), 6.0, True),
            IMG: tl.ResolvedAsset(IMG, "image", str(d / "g.png"), None),
            MU: tl.ResolvedAsset(MU, "audio", str(d / "m.wav"), 10.0),
        }
        self.dir = d

    def tearDown(self):
        self.tmp.cleanup()

    def test_dissolves_render_to_exactly_their_frames_with_the_blend_in_between(self):
        doc = {"version": 1, "width": 96, "height": 64, "fps": 30, "tracks": [
            {"id": "v1", "kind": "V", "clips": [
                {"id": "c1", "asset_id": A, "start_s": 0, "in_s": 0, "out_s": 2, "audio": True},
                {"id": "c2", "asset_id": B, "start_s": 1, "in_s": 0, "out_s": 2, "audio": True,
                 "fit": "cover", "transition": xf(1)},
                {"id": "c3", "asset_id": IMG, "start_s": 2.5, "in_s": 0, "out_s": 1,
                 "fit": "cover", "transition": xf(0.5)}]},
            {"id": "a1", "kind": "A", "clips": [
                {"id": "m1", "asset_id": MU, "start_s": 0, "in_s": 1, "out_s": 4, "gain_db": -12,
                 "fade_in_s": 0.5, "fade_out_s": 0.5}]}]}
        out = self.dir / "out.mp4"
        tr.render(doc, self.assets.get, str(out), ffmpeg=self.ffmpeg, jobs=2, timeout_s=120)
        raw = subprocess.run([self.ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(out),
                              "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
        size = 96 * 64 * 3
        frames = [raw[i:i + size] for i in range(0, len(raw), size)]
        self.assertEqual(len(frames), 105)                  # 3.5 s × 30

        def rgb(n):
            px = frames[n]
            return tuple(sum(px[c::3]) / (96 * 64) for c in range(3))

        r0, _g0, b0 = rgb(10)
        self.assertGreater(r0, 180)
        self.assertLess(b0, 60)                             # red before the dissolve
        r, _g, b = rgb(45)                                  # the middle of the 1 s dissolve
        self.assertTrue(70 < r < 190 and 70 < b < 190, (r, b))
        r2, _g2, b2 = rgb(70)
        self.assertLess(r2, 60)
        self.assertGreater(b2, 180)                         # blue after it
        _r3, g3, _b3 = rgb(104)
        self.assertGreater(g3, 180)                         # and the still at the end

        probe = subprocess.run([self.ffmpeg, "-hide_banner", "-i", str(out), "-map", "0:a",
                                "-f", "null", "-"], capture_output=True, text=True).stderr
        h, m, s = re.findall(r"time=(\d+):(\d+):([\d.]+)", probe)[-1]
        self.assertAlmostEqual(int(h) * 3600 + int(m) * 60 + float(s), 3.5, delta=0.05)

    def test_a_real_endless_ffmpeg_is_killed_at_its_deadline(self):
        t0 = time.monotonic()
        with self.assertRaises(render_backend.RenderTimeout):
            render_backend._run([self.ffmpeg, "-hide_banner", "-f", "lavfi", "-i", "testsrc=s=64x64:r=30",
                                 "-f", "null", "-"], deadline=time.monotonic() + 0.5)
        self.assertLess(time.monotonic() - t0, 10)

    def test_a_render_that_runs_out_of_time_is_stopped_and_leaves_nothing(self):
        doc = {"version": 1, "width": 96, "height": 64, "fps": 30, "tracks": [
            {"id": "v1", "kind": "V", "clips": [
                {"id": "c1", "asset_id": A, "start_s": 0, "in_s": 0, "out_s": 2}]}]}
        work = self.dir / "work"
        work.mkdir()
        out = work / "o.mp4"
        with self.assertRaises(render_backend.RenderTimeout):
            tr.render(doc, self.assets.get, str(out), ffmpeg=self.ffmpeg, workdir=str(work),
                      jobs=1, timeout_s=0.0001)
        self.assertFalse(out.exists())
        self.assertEqual(list(work.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
