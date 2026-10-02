"""Timeline → RenderSpec → ffmpeg (modules/timeline_render.py and the timeline
extension of render_spec / render_backend / ass_captions).

The golden test pins the whole render of a 3-clip + music + voice-over +
title + captions timeline as argv: every segment command, the concat list,
the overlay ASS file and the final command. A change to any of them is a
change to what users' videos look or sound like, so it must be deliberate.
The real-render tests (skipped without ffmpeg) prove the argv actually runs
and the output is exactly the timeline's length in frames."""

import copy
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import ass_captions, render_backend
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr

A1 = "11111111-1111-4111-8111-111111111111"
A2 = "22222222-2222-4222-8222-222222222222"
A3 = "33333333-3333-4333-8333-333333333333"
MU = "44444444-4444-4444-8444-444444444444"
VO = "55555555-5555-4555-8555-555555555555"

ASSETS = {
    A1: tl.ResolvedAsset(A1, "video", "/media/a1.mp4", 12.0),
    A2: tl.ResolvedAsset(A2, "image", "/media/a2.png", None),
    A3: tl.ResolvedAsset(A3, "video", "/media/a3.mov", 8.0),
    MU: tl.ResolvedAsset(MU, "audio", "/media/music.mp3", 180.0),
    VO: tl.ResolvedAsset(VO, "audio", "/media/voice.wav", 9.0),
}


def golden_doc(width=1080, height=1920):
    return {
        "version": 1, "width": width, "height": height, "fps": 30,
        "tracks": [
            {"id": "v1", "kind": "V", "clips": [
                {"id": "c1", "asset_id": A1, "start_s": 0, "in_s": 2.5, "out_s": 6.0,
                 "fit": "cover", "fade_in_s": 0.5},
                {"id": "c2", "asset_id": A2, "start_s": 3.5, "in_s": 0, "out_s": 3.0},
                {"id": "c3", "asset_id": A3, "start_s": 6.5, "in_s": 1.0, "out_s": 4.0,
                 "transition": {"type": "dip_to_black", "duration_s": 0.6}, "fade_out_s": 1.0},
            ]},
            {"id": "music", "kind": "A", "clips": [
                {"id": "m1", "asset_id": MU, "start_s": 0, "in_s": 30, "out_s": 40,
                 "gain_db": -14, "fade_in_s": 1, "fade_out_s": 2}]},
            {"id": "vo", "kind": "A", "clips": [
                {"id": "vo1", "asset_id": VO, "start_s": 0.5, "in_s": 0, "out_s": 8.75}]},
            {"id": "t1", "kind": "T", "clips": [
                {"id": "title", "start_s": 0, "end_s": 3, "text": "Nightshift\nStudio", "size": 96,
                 "bold": True, "y": 0.2, "anchor": "top", "fade_out_s": 0.5}]},
        ],
        "captions": {"cues": [
            {"id": "k1", "start_s": 0.5, "end_s": 4.2, "text": "Every clip is referenced by id,"},
            {"id": "k2", "start_s": 4.2, "end_s": 9.25, "text": "and rendered by the same engine."},
        ]},
    }


def full_argv(spec):
    """Everything the backend would run for ``spec``, as data."""
    segs = [render_backend.segment_commands(
                "ffmpeg", s, Path(f"/w/seg_{i:04d}.mp4"), spec.width, spec.height, spec.fps,
                seed=f"{i}:{s.path}", frame_exact=spec.frame_exact)
            for i, s in enumerate(spec.segments)]
    # The concat list the backend writes: every segment normalised to a file.
    normalised = [rs.Segment(duration=s.duration, path=f"/w/seg_{i:04d}.mp4", kind=rs.KIND_VIDEO)
                  for i, s in enumerate(spec.segments)]
    return {"segments": segs,
            "concat": rs.concat_list_lines(rs.RenderSpec(output_path=spec.output_path,
                                                         segments=normalised)),
            "overlays": ass_captions.build_overlay_ass(spec.overlays, width=spec.width,
                                                       height=spec.height),
            "final": rs.build_ffmpeg_command(spec, "/w/concat.txt", "/w/overlays.ass")}


FIT_1080x1920 = "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30"
ENC = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30"]
#: Every timeline input is capped at the decoder (BR-L-004): media_library.MAX_PIXELS.
CAP = ["-max_pixels", "100000000"]
KEN_BURNS_C2 = (
    "scale=1242:2208:force_original_aspect_ratio=increase:flags=lanczos,loop=loop=-1:size=1,"
    "settb=1/30,setpts=N,crop=w=1018:h=1811:x='clip(trunc(iw*(0.5+0.15-0.3*min(1,n/90.000000)))"
    "-509,0,iw-ow)':y='(ih-oh)/2',scale=1080:1920:flags=lanczos")

GOLDEN_SEGMENTS = [
    # c1: trimmed from 2.5 s, 3.5 s = 105 frames, cover-cropped, 0.5 s fade in.
    [["ffmpeg", "-xerror", "-y", "-stream_loop", "-1", "-ss", "2.500", *CAP, "-i", "/media/a1.mp4",
      "-frames:v", "105", "-an", "-vf",
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,"
      "fade=t=in:st=0:d=0.500", *ENC, "/w/seg_0000.mp4"]],
    # c2: still, 90 frames of Ken Burns (static hold as fallback); fades out
    # 0.3 s — half of c3's 0.6 s dip to black.
    [["ffmpeg", "-xerror", "-y", *CAP, "-i", "/media/a2.png", "-frames:v", "90", "-vf",
      KEN_BURNS_C2 + ",fade=t=out:st=2.700:d=0.300", *ENC, "/w/seg_0001.mp4"],
     ["ffmpeg", "-xerror", "-y", "-loop", "1", *CAP, "-i", "/media/a2.png", "-frames:v", "90", "-vf",
      FIT_1080x1920 + ",fade=t=out:st=2.700:d=0.300", *ENC, "/w/seg_0001.mp4"]],
    # c3: trimmed from 1.0 s, letterboxed, the other half of the dip, own fade out.
    [["ffmpeg", "-xerror", "-y", "-stream_loop", "-1", "-ss", "1.000", *CAP, "-i", "/media/a3.mov",
      "-frames:v", "90", "-an", "-vf",
      FIT_1080x1920 + ",fade=t=in:st=0:d=0.300,fade=t=out:st=2.000:d=1.000",
      *ENC, "/w/seg_0002.mp4"]],
    # Tail: the music runs to 10.0 s, the picture to 9.5 s → 15 black frames.
    [["ffmpeg", "-xerror", "-y", "-f", "lavfi", *CAP, "-i", "color=c=black:s=1080x1920:r=30", "-frames:v", "15",
      *ENC, "/w/seg_0003.mp4"]],
]

GOLDEN_CONCAT = [
    "file '/w/seg_0000.mp4'", "duration 3.500",
    "file '/w/seg_0001.mp4'", "duration 3.000",
    "file '/w/seg_0002.mp4'", "duration 3.000",
    "file '/w/seg_0003.mp4'", "duration 0.500",
]

GOLDEN_FINAL = [
    "ffmpeg", "-y", "-f", "concat", "-safe", "0", *CAP, "-i", "/w/concat.txt",
    *CAP, "-i", "/media/music.mp3", *CAP, "-i", "/media/voice.wav",
    "-filter_complex",
    "[0:v]subtitles='/w/overlays.ass'[vout];"
    "[1:a]atrim=start=30.000:duration=10.000,asetpts=PTS-STARTPTS,"
    "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=-14.000dB,"
    "afade=t=in:st=0:d=1.000,afade=t=out:st=8.000:d=2.000[a0];"
    "[2:a]atrim=start=0.000:duration=8.750,asetpts=PTS-STARTPTS,"
    "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,"
    "adelay=delays=500:all=1[a1];"
    "[a0][a1]amix=inputs=2:duration=longest:normalize=0,apad,atrim=end=10.000000[aout]",
    "-map", "[vout]", "-map", "[aout]",
    "-r", "30", "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "/out/timeline.mp4",
]

GOLDEN_ASS_EVENTS = [
    r"Dialogue: 0,0:00:00.00,0:00:03.00,O0,,0,0,0,,{\pos(540,384)\fad(0,500)}Nightshift\NStudio",
    r"Dialogue: 1,0:00:00.50,0:00:04.20,O1,,0,0,0,,{\pos(540,1728)}Every clip is referenced by id,",
    r"Dialogue: 2,0:00:04.20,0:00:09.25,O2,,0,0,0,,{\pos(540,1728)}and rendered by the same engine.",
]
GOLDEN_ASS_STYLES = [
    "Style: O0,DejaVu Sans,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,8,43,43,0,1",
    "Style: O1,DejaVu Sans,56,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,2,43,43,0,1",
    "Style: O2,DejaVu Sans,56,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,2,43,43,0,1",
]


class GoldenTimelineTestCase(unittest.TestCase):
    def setUp(self):
        self.spec = tr.to_render_spec(golden_doc(), ASSETS.get, "/out/timeline.mp4")
        self.argv = full_argv(self.spec)

    def test_spec_shape(self):
        s = self.spec
        self.assertTrue(s.frame_exact)
        self.assertEqual((s.width, s.height, s.fps), (1080, 1920, 30))
        self.assertEqual([seg.kind for seg in s.segments], ["video", "image", "video", "color"])
        self.assertAlmostEqual(s.video_length_s, 10.0)
        self.assertEqual(len(s.audio_tracks), 2)
        self.assertEqual(len(s.overlays), 3)
        self.assertIsNone(s.audio_path)
        self.assertEqual(rs.validate(s), [])

    def test_golden_segment_commands(self):
        self.assertEqual(self.argv["segments"], GOLDEN_SEGMENTS)

    def test_golden_concat_list(self):
        self.assertEqual(self.argv["concat"], GOLDEN_CONCAT)

    def test_golden_final_command(self):
        self.assertEqual(self.argv["final"], GOLDEN_FINAL)
        self.assertNotIn("-shortest", self.argv["final"])   # the picture decides the length

    def test_golden_overlay_file(self):
        ass = self.argv["overlays"]
        self.assertEqual([ln for ln in ass.splitlines() if ln.startswith("Dialogue:")],
                         GOLDEN_ASS_EVENTS)
        self.assertEqual([ln for ln in ass.splitlines() if ln.startswith("Style:")],
                         GOLDEN_ASS_STYLES)
        self.assertIn("PlayResX: 1080\nPlayResY: 1920\n", ass)


class DeterminismTestCase(unittest.TestCase):
    def test_same_document_gives_the_same_argv(self):
        a = full_argv(tr.to_render_spec(golden_doc(), ASSETS.get, "/out/timeline.mp4"))
        b = full_argv(tr.to_render_spec(golden_doc(), ASSETS.get, "/out/timeline.mp4"))
        self.assertEqual(a, b)

    def test_equivalent_documents_give_the_same_argv(self):
        # Clip order in the JSON, key order, JSON text vs dict, an upper-case
        # uuid and float noise below a millisecond are not edits.
        want = full_argv(tr.to_render_spec(golden_doc(), ASSETS.get, "/out/timeline.mp4"))
        d = golden_doc()
        d["tracks"][0]["clips"].reverse()
        d["captions"]["cues"].reverse()
        d["tracks"][0]["clips"][0]["asset_id"] = A3.upper()
        d["tracks"][1]["clips"][0]["in_s"] = 30.0000001
        text = json.dumps(d, sort_keys=True)
        self.assertEqual(full_argv(tr.to_render_spec(text, ASSETS.get, "/out/timeline.mp4")), want)

    def test_the_input_document_is_not_modified(self):
        d = golden_doc()
        before = copy.deepcopy(d)
        tr.to_render_spec(d, ASSETS.get, "/out/timeline.mp4")
        self.assertEqual(d, before)

    def test_spec_round_trips_through_a_dict(self):
        spec = tr.to_render_spec(golden_doc(), ASSETS.get, "/out/timeline.mp4")
        back = rs.RenderSpec.from_dict(json.loads(json.dumps(spec.to_dict())))
        self.assertEqual(back, spec)


class RefusalTestCase(unittest.TestCase):
    def test_unknown_asset_is_refused_before_anything_renders(self):
        missing = {k: v for k, v in ASSETS.items() if k != A2}.get
        with mock.patch.object(render_backend, "_run") as run:
            with self.assertRaises(tl.TimelineError) as cm:
                tr.render(golden_doc(), missing, "/out/x.mp4")
        run.assert_not_called()
        self.assertIn(f"asset {A2} is not available", str(cm.exception))

    def test_invalid_document_is_refused_with_its_reasons(self):
        d = golden_doc()
        d["tracks"][0]["clips"][0]["out_s"] = 7.0   # c1 now runs into c2
        with self.assertRaises(tl.TimelineError) as cm:
            tr.to_render_spec(d, ASSETS.get, "/out/x.mp4")
        self.assertIn("clips 'c1' and 'c2' overlap", str(cm.exception))

    def test_image_on_an_audio_track_is_refused(self):
        d = golden_doc()
        d["tracks"][2]["clips"][0]["asset_id"] = A2
        with self.assertRaises(tl.TimelineError) as cm:
            tr.to_render_spec(d, ASSETS.get, "/out/x.mp4")
        self.assertIn("is 'image'; a A track takes audio", str(cm.exception))

    def test_overlays_without_libass_fail_before_encoding(self):
        spec = tr.to_render_spec(golden_doc(), ASSETS.get, "/out/x.mp4")
        with mock.patch.object(ass_captions, "has_libass", return_value=False), \
                mock.patch.object(render_backend, "_run") as run:
            with self.assertRaises(render_backend.RenderBackendError) as cm:
                render_backend.render(spec, ffmpeg="ffmpeg")
        run.assert_not_called()
        self.assertIn("libass", str(cm.exception))


class PresetTestCase(unittest.TestCase):
    def test_9_16_16_9_and_1_1(self):
        for preset, (w, h) in tl.PRESETS.items():
            with self.subTest(preset=preset):
                doc = tl.new_timeline(preset)
                doc["tracks"][0]["clips"].append(
                    {"id": "c1", "asset_id": A1, "start_s": 0, "in_s": 0, "out_s": 2, "fit": "cover"})
                doc["tracks"].append({"id": "t", "kind": "T", "clips": [
                    {"id": "x", "start_s": 0, "end_s": 1, "text": "hi", "x": 0.25, "y": 0.75}]})
                spec = tr.to_render_spec(doc, ASSETS.get, "/o.mp4")
                self.assertEqual((spec.width, spec.height), (w, h))
                argv = full_argv(spec)
                vf = argv["segments"][0][0][argv["segments"][0][0].index("-vf") + 1]
                self.assertTrue(vf.startswith(f"scale={w}:{h}:force_original_aspect_ratio=increase,"
                                              f"crop={w}:{h},fps=30"), vf)
                self.assertIn(f"PlayResX: {w}\nPlayResY: {h}", argv["overlays"])
                self.assertIn(f"\\pos({round(0.25 * w)},{round(0.75 * h)})", argv["overlays"])


class SpecExtensionTestCase(unittest.TestCase):
    """The new render_spec fields on their own."""

    def test_validate_names_bad_timeline_fields(self):
        spec = rs.RenderSpec(
            output_path="/o.mp4", audio_path="/a.wav",
            segments=[rs.Segment(1.0, "/a.mp4", fit="stretch", in_s=-1, fade_in_s=0.8, fade_out_s=0.8)],
            audio_tracks=[rs.AudioTrack(path="", duration_s=0)],
            overlays=[rs.TextOverlay(2.0, 1.0, " ", anchor="middle", x=2)])
        problems = " | ".join(rs.validate(spec))
        for needle in ("unknown fit", "negative or non-finite in_s", "fades (0.8 + 0.8 s)",
                       "mutually exclusive", "audio track 0 has no path",
                       "non-positive duration", "overlay 0 has no text", "must end after it starts",
                       "unknown anchor", "fractions of the frame"):
            self.assertIn(needle, problems)

    def test_overlays_need_the_overlay_file(self):
        spec = rs.RenderSpec(output_path="/o.mp4", segments=[rs.Segment(1.0, None, rs.KIND_COLOR)],
                             overlays=[rs.TextOverlay(0.0, 1.0, "x")])
        with self.assertRaises(ValueError):
            rs.build_ffmpeg_command(spec, "/l.txt")

    def test_mix_is_not_normalised_by_track_count(self):
        # amix's default divides every input by the number of inputs: adding
        # music would silently halve the voice-over.
        spec = rs.RenderSpec(output_path="/o.mp4", segments=[rs.Segment(1.0, None, rs.KIND_COLOR)],
                             audio_tracks=[rs.AudioTrack("/v.wav", 1.0), rs.AudioTrack("/m.wav", 1.0)])
        graph = rs.build_ffmpeg_command(spec, "/l.txt")
        graph = graph[graph.index("-filter_complex") + 1]
        self.assertIn("normalize=0", graph)
        self.assertNotIn("subtitles", graph)

    def test_overlay_text_cannot_inject_ass_tags(self):
        o = rs.TextOverlay(0.0, 1.0, r"{\fs900\pos(0,0)}boom\N")
        ass = ass_captions.build_overlay_ass([o], width=320, height=240)
        event = [ln for ln in ass.splitlines() if ln.startswith("Dialogue:")][0]
        self.assertEqual(event.count("{"), 1)             # only our own tag block
        self.assertNotIn(r"\fs900", event)


# ── real renders ────────────────────────────────────────────────────────────

def _ffmpeg_ok() -> bool:
    exe = render_backend.resolve_ffmpeg()
    try:
        return subprocess.run([exe, "-version"], capture_output=True).returncode == 0 \
            and ass_captions.has_libass(exe)
    except OSError:
        return False


def _count(ffmpeg, path, stream):
    err = subprocess.run([ffmpeg, "-hide_banner", "-i", str(path), "-map", f"0:{stream}:0",
                          "-f", "null", "-"], capture_output=True, text=True).stderr
    return err


@unittest.skipUnless(_ffmpeg_ok(), "ffmpeg with libass not available")
class RealTimelineRenderTestCase(unittest.TestCase):
    def setUp(self):
        try:
            from PIL import Image
        except Exception:
            self.skipTest("PIL not available")
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.ffmpeg = f = render_backend.resolve_ffmpeg()
        render_backend._run([f, "-y", "-f", "lavfi", "-i", "testsrc=s=320x180:r=25:d=6",
                             "-c:v", "libx264", "-pix_fmt", "yuv420p", str(d / "a.mp4")])
        Image.new("RGB", (200, 300), (200, 40, 40)).save(d / "b.png")
        for name, hz, secs in (("m.wav", 220, 20), ("v.wav", 880, 3)):
            render_backend._run([f, "-y", "-f", "lavfi", "-i", f"sine=frequency={hz}:duration={secs}",
                                 "-c:a", "pcm_s16le", str(d / name)])
        self.assets = {
            A1: tl.ResolvedAsset(A1, "video", str(d / "a.mp4"), 6.0),
            A2: tl.ResolvedAsset(A2, "image", str(d / "b.png")),
            MU: tl.ResolvedAsset(MU, "audio", str(d / "m.wav"), 20.0),
            VO: tl.ResolvedAsset(VO, "audio", str(d / "v.wav"), 3.0),
        }
        self.dir = d

    def tearDown(self):
        self.tmp.cleanup()

    def test_timeline_renders_to_exactly_its_frames_with_sound_and_text(self):
        # 24 fps and cut points off the 3-decimal grid on purpose: 1.045 s,
        # a gap, a still, a trimmed clip — the lengths -t got wrong by a frame.
        doc = {"version": 1, "width": 144, "height": 256, "fps": 24, "tracks": [
            {"id": "v1", "kind": "V", "clips": [
                {"id": "c1", "asset_id": A1, "start_s": 0, "in_s": 1.3, "out_s": 2.345,
                 "fit": "cover", "fade_in_s": 0.3},
                {"id": "c2", "asset_id": A2, "start_s": 1.5, "in_s": 0, "out_s": 0.9,
                 "transition": {"type": "dip_to_black", "duration_s": 0.4}},
                {"id": "c3", "asset_id": A1, "start_s": 2.4, "in_s": 3.0, "out_s": 3.7}]},
            {"id": "mu", "kind": "A", "clips": [
                {"id": "m1", "asset_id": MU, "start_s": 0, "in_s": 5, "out_s": 8.5,
                 "gain_db": -12, "fade_in_s": 0.5, "fade_out_s": 1}]},
            {"id": "vo", "kind": "A", "clips": [
                {"id": "vo1", "asset_id": VO, "start_s": 0.25, "in_s": 0, "out_s": 2.5}]},
            {"id": "t", "kind": "T", "clips": [
                {"id": "ti", "start_s": 0, "end_s": 1, "text": "Hi", "size": 40, "y": 0.2}]}],
            "captions": {"cues": [{"id": "k", "start_s": 0.5, "end_s": 3.3, "text": "caption"}]}}
        out = self.dir / "out.mp4"
        tr.render(doc, self.assets.get, str(out))
        video = _count(self.ffmpeg, out, "v")
        self.assertEqual(int(re.findall(r"frame=\s*(\d+)", video)[-1]), 84)   # 3.5 s × 24
        audio = _count(self.ffmpeg, out, "a")
        h, m, s = re.findall(r"time=(\d+):(\d+):([\d.]+)", audio)[-1]
        self.assertAlmostEqual(int(h) * 3600 + int(m) * 60 + float(s), 3.5, delta=0.05)

        raw = subprocess.run([self.ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(out),
                              "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
        size = 144 * 256
        frames = [raw[i:i + size] for i in range(0, len(raw), size)]
        mean = [sum(fr) / size for fr in frames]
        self.assertLess(mean[1], mean[10])        # c1 fades in from black
        self.assertLess(mean[81], 1.0)            # tail after the caption: black
        self.assertGreater(mean[76], mean[81])    # ...and the caption is burnt in above it

    def test_split_renders_the_same_length(self):
        doc = {"version": 1, "width": 64, "height": 64, "fps": 25, "tracks": [
            {"id": "v1", "kind": "V", "clips": [
                {"id": "c1", "asset_id": A1, "start_s": 0, "in_s": 0.4, "out_s": 2.4}]}]}
        split = tl.split_clip(doc, "c1", 0.8, "c1b")
        spec = tr.to_render_spec(split, self.assets.get, str(self.dir / "s.mp4"))
        self.assertEqual([s.in_s for s in spec.segments], [0.4, 1.2])
        render_backend.render(spec)
        video = _count(self.ffmpeg, self.dir / "s.mp4", "v")
        self.assertEqual(int(re.findall(r"frame=\s*(\d+)", video)[-1]), 50)


if __name__ == "__main__":
    unittest.main()
