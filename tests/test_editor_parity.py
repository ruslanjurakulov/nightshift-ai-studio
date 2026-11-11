"""Editor parity, first pass (backend half): the export frame rate, a video clip's own volume,
"detach audio", and the wider constant speed (0.1x-10x).

* the document: ``gain_db`` on a V clip is a number from -60 to +6 dB (about 200 %), dropped by
  ``normalise`` at 0, and the same in the schema and in lib/editor.ts; a speed is 0.1-10 while a
  speed CURVE stays 0.25-4; an A clip may name a VIDEO (its sound, detached) but never a picture;
* the spec: the clip's level reaches its sound track and only there, a detached sound becomes an
  ordinary sound track of the video file, and a video without a sound track is silent (never an
  input with no audio stream, which would fail the whole mix) and ducks nothing;
* real ffmpeg (render_backend.resolve_ffmpeg, the pinned imageio-ffmpeg build) with ffprobe on
  the result: 24 / 25 / 60 fps exports have that rate, frame count and size; 0 %, 100 % and 200 %
  measure as silence, the tone, and the tone 6 dB up; a muted clip leaves no sound; a detached
  sound plays where it was put; 10x and 0.1x last a tenth and ten times as long, with the pitch kept.
"""

import copy
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr
from tests import test_editor_overlay as ovt

ROOT = Path(__file__).resolve().parent.parent
EDITOR_TS = ROOT / "command-center" / "lib" / "editor.ts"
BASE = ovt.BASE
PIC = ovt.PIC
MU = "66666666-6666-4666-8666-666666666666"     # a song


def vdoc(width=320, height=180, fps=30, out_s=2.0, **clip):
    c = {"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0, "out_s": out_s}
    c.update(clip)
    return {"version": 1, "width": width, "height": height, "fps": fps,
            "tracks": [{"id": "v1", "kind": "V", "clips": [c]}]}


def with_sound(doc, asset=BASE, role="speech", **clip):
    c = {"id": "m1", "asset_id": asset, "start_s": 0, "in_s": 0, "out_s": 2, "gain_db": 0,
         "fade_in_s": 0, "fade_out_s": 0}
    c.update(clip)
    track = {"id": "a1", "kind": "A", "clips": [c]}
    if role:
        track["role"] = role
    doc["tracks"].append(track)
    return doc


def video(has_audio=True, path="/m/a.mp4", seconds=20.0):
    return tl.ResolvedAsset(BASE, "video", path, seconds, has_audio)


class ClipVolumeDocumentTestCase(unittest.TestCase):
    def test_a_clips_own_level_is_minus_60_to_plus_6_db(self):
        for ok in (-60, -60.0, -12.5, 0, 3, 6, 6.0):
            self.assertEqual(tl.validate(vdoc(audio=True, gain_db=ok)), [], ok)
        for bad in (-60.001, -61, 6.001, 7, 12, "6", None, True, float("nan"), float("inf"), [0]):
            got = tl.validate(vdoc(audio=True, gain_db=bad))
            self.assertTrue(any("gain_db must be a number >= -60 and <= 6" in p for p in got), (bad, got))
        self.assertEqual((tl.GAIN_DB_MIN, tl.CLIP_GAIN_DB_MAX), (-60.0, 6.0))
        # +6 dB is the control's 200 %: 10 ** (6 / 20) = 1.995
        self.assertAlmostEqual(10 ** (tl.CLIP_GAIN_DB_MAX / 20), 2.0, delta=0.01)

    def test_an_a_clip_keeps_its_own_wider_range(self):
        doc = with_sound(vdoc(), asset=MU, gain_db=12)
        self.assertEqual(tl.validate(doc), [])

    def test_normalise_drops_as_recorded_and_rounds_to_the_millisecond(self):
        c = tl.normalise(vdoc(audio=True, gain_db=0))["tracks"][0]["clips"][0]
        self.assertNotIn("gain_db", c)
        c = tl.normalise(vdoc(audio=True, gain_db=-3.00049))["tracks"][0]["clips"][0]
        self.assertEqual(c["gain_db"], -3.0)
        # a clip without it normalises to exactly what it did before the field existed
        self.assertEqual(tl.normalise(vdoc(audio=True)), tl.normalise(vdoc(audio=True, gain_db=0)))

    def test_the_schema_and_the_editor_say_the_same_numbers(self):
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        props = schema["$defs"]["video_clip"]["properties"]
        self.assertEqual(set(props), set(tl._V_CLIP_KEYS))
        self.assertEqual((props["gain_db"]["minimum"], props["gain_db"]["maximum"]),
                         (tl.GAIN_DB_MIN, tl.CLIP_GAIN_DB_MAX))
        ts = EDITOR_TS.read_text(encoding="utf-8")
        self.assertEqual(float(re.search(r"export const CLIP_GAIN_DB_MAX = ([\d.]+);", ts).group(1)),
                         tl.CLIP_GAIN_DB_MAX)
        self.assertIn('"gain_db",\n  ...EFFECT_KEYS,', ts)

    def test_an_unknown_volume_field_is_still_refused(self):
        # The strictness that makes an older validator refuse gain_db is the one that refuses these.
        for k in ("volume", "gain", "mute", "audio_gain_db"):
            got = tl.validate(vdoc(audio=True, **{k: 1}))
            self.assertTrue(any(f"{k} is not a known field" in p for p in got), (k, got))


class DetachedSoundDocumentTestCase(unittest.TestCase):
    def resolve(self, doc, table):
        try:
            tl.resolve_assets(tl.load(doc), table.get)
        except tl.TimelineError as e:
            return e.problems
        return []

    def test_a_sound_track_takes_a_videos_sound_but_never_a_picture(self):
        table = {BASE: video(), PIC: tl.ResolvedAsset(PIC, "image", "/m/p.png", None)}
        doc = with_sound(vdoc(), asset=BASE)
        self.assertEqual(tl.validate(doc), [])
        self.assertEqual(self.resolve(doc, table), [])
        pic = with_sound(vdoc(), asset=PIC)
        self.assertTrue(any("a A track takes audio or video" in p for p in self.resolve(pic, table)))
        self.assertEqual(tl.TRACK_ASSET_KINDS[tl.KIND_A], (tl.ASSET_AUDIO, tl.ASSET_VIDEO))

    def test_a_detached_sound_is_trimmed_inside_its_video_like_any_clip(self):
        table = {BASE: video(seconds=5.0)}
        doc = with_sound(vdoc(), asset=BASE, in_s=3, out_s=6)
        self.assertTrue(any("past the end" in p for p in self.resolve(doc, table)))


class SpeedDocumentTestCase(unittest.TestCase):
    def test_a_constant_speed_is_a_tenth_to_ten_and_a_curve_a_quarter_to_four(self):
        for ok in (0.1, 10):
            self.assertEqual(tl.validate(vdoc(out_s=4, speed=ok)), [], ok)
        self.assertEqual(tl.duration_s(tl.normalise(vdoc(out_s=4, speed=10))), 0.4)
        self.assertEqual(tl.duration_s(tl.normalise(vdoc(out_s=1, speed=0.1))), 10.0)
        for bad in (0.25 - 0.01, 4.5, 10):
            curve = [{"at": 0, "speed": 1}, {"at": 1, "speed": bad}]
            got = tl.validate(vdoc(speed_curve=curve))
            self.assertTrue(any("speed must be a number >= 0.25 and <= 4" in p for p in got), (bad, got))
        self.assertEqual((rs.SPEED_MIN, rs.SPEED_MAX), (tl.SPEED_MIN, tl.SPEED_MAX))
        self.assertEqual((rs.RAMP_SPEED_MIN, rs.RAMP_SPEED_MAX), (tl.RAMP_SPEED_MIN, tl.RAMP_SPEED_MAX))

    def test_a_ten_times_clip_still_needs_one_frame(self):
        # 0.1 s of source at 10x is 0.01 s: not one frame at 30 fps; 0.2 s is 0.6 of a frame, which rounds to one
        self.assertTrue(any("shorter than one frame" in p for p in tl.validate(vdoc(out_s=0.1, speed=10))))
        self.assertEqual(tl.validate(vdoc(out_s=0.2, speed=10)), [])

    def test_the_sound_of_the_far_ends_is_a_chain_of_stages_each_inside_half_to_double(self):
        self.assertEqual(rs.tempo_chain(10.0), "atempo=2.000,atempo=2.000,atempo=2.000,atempo=1.250")
        self.assertEqual(rs.tempo_chain(0.1), "atempo=0.500,atempo=0.500,atempo=0.500,atempo=0.800")
        for s in (0.1, 0.13, 0.2, 5, 7.7, 10):
            stages = [float(x) for x in re.findall(r"atempo=([\d.]+)", rs.tempo_chain(s))]
            self.assertTrue(all(0.5 <= x <= 2.0 for x in stages), (s, stages))
            prod = 1.0
            for x in stages:
                prod *= x
            self.assertAlmostEqual(prod, s, delta=0.003 * len(stages) * max(1, s), msg=str(s))


class FastClipRenderTimeTestCase(unittest.TestCase):
    """A clip faster than 1x decodes `speed` seconds of source per second: the render-time estimate
    charges it, so a long fast timeline is refused up front instead of holding the one export worker
    until its wall-clock limit kills it."""

    def doc(self, length, speed, fps=60, **clip):
        return vdoc(width=1920, height=1080, fps=fps, out_s=length * speed, speed=speed, **clip)

    def test_each_second_of_source_beyond_the_clips_length_is_charged(self):
        k = tl.FAST_SECONDS_PER_SOURCE_S
        self.assertAlmostEqual(tl.fast_seconds(self.doc(10, 10)["tracks"][0]["clips"][0]), k * 90)
        self.assertAlmostEqual(tl.fast_seconds(self.doc(10, 2)["tracks"][0]["clips"][0]), k * 10)
        for clip in (self.doc(10, 1)["tracks"][0]["clips"][0], self.doc(10, 0.5)["tracks"][0]["clips"][0],
                     {"in_s": 0, "out_s": 4, "freeze": True}, {"in_s": "x", "out_s": 4}):
            self.assertEqual(tl.fast_seconds(clip), 0.0, clip)
        # a curve is charged by its own length: 0.25 s of 4 s range at 1 then 4 lasts less than 4 s
        curved = vdoc(out_s=4, speed_curve=[{"at": 0, "speed": 1}, {"at": 1, "speed": 4}])["tracks"][0]["clips"][0]
        self.assertAlmostEqual(tl.fast_seconds(curved), k * (4 - tl.clip_length_s(curved)), places=6)
        self.assertGreater(tl.fast_seconds(curved), 0)

    def test_a_long_ten_times_timeline_is_refused_and_a_short_one_passes(self):
        got = tl.validate(self.doc(200, 10))
        self.assertTrue(any("playing clips faster than 1x would take about" in p and "speed them up less" in p
                            for p in got), got)
        self.assertEqual(tl.validate(self.doc(30, 10)), [])
        # the boundary is the worker's own allowance: 1 + 9k seconds per second against 3 per second + 120
        k = tl.FAST_SECONDS_PER_SOURCE_S
        edge = tl.RENDER_TIMEOUT_BASE_S / (1 + 9 * k - tl.RENDER_TIMEOUT_PER_S)
        self.assertEqual(tl.validate(self.doc(round(edge - 1), 10)), [])
        self.assertTrue(tl.validate(self.doc(round(edge + 1), 10)))

    def test_four_times_over_the_longest_export_still_fits(self):
        # every document valid before the wider range (speeds up to 4) and nothing else dear stays valid
        self.assertEqual(tl.validate(self.doc(1800, 4)), [])
        self.assertLessEqual(1 + 3 * tl.FAST_SECONDS_PER_SOURCE_S, tl.RENDER_TIMEOUT_PER_S)

    def test_the_charge_adds_to_stabilising_and_names_both(self):
        def doc(speed):
            d = vdoc(width=1920, height=1080, fps=60, out_s=60 * speed, speed=speed)
            d["tracks"][0]["clips"].append({"id": "c2", "asset_id": BASE, "start_s": 60, "in_s": 0, "out_s": 30,
                                            "stabilize": True})
            return d
        self.assertEqual(tl.validate(doc(1)), [], "the steadied clip alone fits")
        got = tl.validate(doc(10))
        self.assertTrue(any("stabilising and playing clips faster than 1x" in p for p in got), got)

    def test_shapes_and_fast_clips_are_charged_together(self):
        # 90 s at 10x fits on its own (373.5 s of 390), a full-width rectangle (about 26 s) on its own too;
        # together they do not, and the shapes' sentence says so
        def doc(speed):
            d = self.doc(90, speed)
            d["shapes"] = [{"id": "h1", "kind": "rect", "start_s": 0, "end_s": 90, "w": 1.0}]
            return d
        self.assertEqual(tl.validate(self.doc(90, 10)), [])
        self.assertEqual(tl.validate(doc(1)), [])
        got = tl.validate(doc(10))
        self.assertTrue(any("the shapes would take about" in p for p in got), got)

    def test_the_constant_is_the_editors(self):
        ts = EDITOR_TS.read_text(encoding="utf-8")
        self.assertEqual(float(re.search(r"export const FAST_SECONDS_PER_SOURCE_S = ([\d.]+);", ts).group(1)),
                         tl.FAST_SECONDS_PER_SOURCE_S)


class SpecTestCase(unittest.TestCase):
    def test_the_clips_level_reaches_its_own_sound_and_nothing_else(self):
        spec = tr.to_render_spec(vdoc(audio=True, gain_db=-6), {BASE: video()}.get, "/o.mp4")
        self.assertEqual([t.gain_db for t in spec.audio_tracks], [-6.0])
        graph = rs.build_ffmpeg_command(spec, "/w/c.txt")
        g = graph[graph.index("-filter_complex") + 1]
        self.assertIn("volume=-6.000dB", g)
        plain = tr.to_render_spec(vdoc(audio=True), {BASE: video()}.get, "/o.mp4")
        self.assertEqual([t.gain_db for t in plain.audio_tracks], [0.0])
        self.assertNotIn("volume=", rs.build_ffmpeg_command(plain, "/w/c.txt")[
            rs.build_ffmpeg_command(plain, "/w/c.txt").index("-filter_complex") + 1])

    def test_a_level_without_the_clips_sound_is_nothing(self):
        spec = tr.to_render_spec(vdoc(audio=False, gain_db=6), {BASE: video()}.get, "/o.mp4")
        self.assertEqual(spec.audio_tracks, [])

    def test_a_detached_sound_is_a_sound_track_of_the_video_file(self):
        doc = with_sound(vdoc(out_s=4), asset=BASE, start_s=1, in_s=0.5, out_s=2.5, gain_db=-3)
        spec = tr.to_render_spec(doc, {BASE: video()}.get, "/o.mp4")
        self.assertEqual(spec.audio_tracks, [rs.AudioTrack("/m/a.mp4", duration_s=2.0, start_s=1.0, in_s=0.5,
                                                           gain_db=-3.0, video_source=True)])
        self.assertEqual(rs.AudioTrack.from_dict(spec.audio_tracks[0].to_dict()), spec.audio_tracks[0])

    def test_a_detached_sound_gets_the_video_decoder_cap_and_a_song_keeps_the_still_one(self):
        doc = with_sound(vdoc(out_s=4), asset=BASE)
        doc["tracks"].append({"id": "a2", "kind": "A", "clips": [
            {"id": "m2", "asset_id": MU, "start_s": 0, "in_s": 0, "out_s": 4}]})
        table = {BASE: video(path="/m/v.mp4"), MU: tl.ResolvedAsset(MU, "audio", "/m/song.mp3", 30.0)}
        spec = tr.to_render_spec(doc, table.get, "/o.mp4")
        cmd = rs.build_ffmpeg_command(spec, "/w/c.txt")
        def cap_of(path):
            i = cmd.index(path)
            before = cmd[max(0, i - 12):i]
            return int(before[before.index("-max_pixels") + 1])
        self.assertEqual(cap_of("/m/v.mp4"), rs.decoder_max_pixels(rs.DECODE_VIDEO_MAX_PIXELS))
        self.assertEqual(cap_of("/m/song.mp3"), rs.decoder_max_pixels(rs.DECODE_MAX_PIXELS))
        self.assertNotIn("video_source", rs.AudioTrack("/m/song.mp3", 1.0).to_dict())

    def test_a_video_with_no_sound_track_is_silent_and_ducks_nothing(self):
        doc = with_sound(vdoc(out_s=4), asset=BASE)
        doc["tracks"].append({"id": "a2", "kind": "A", "role": "music", "duck": {"amount_db": 12},
                              "clips": [{"id": "m2", "asset_id": MU,
                                         "start_s": 0, "in_s": 0, "out_s": 4}]})
        music = tl.ResolvedAsset(doc["tracks"][2]["clips"][0]["asset_id"], "audio", "/m/song.mp3", 30.0)
        table = {BASE: video(has_audio=False), music.asset_id: music}
        spec = tr.to_render_spec(doc, table.get, "/o.mp4")
        self.assertEqual([t.path for t in spec.audio_tracks], ["/m/song.mp3"])
        self.assertEqual(spec.audio_tracks[0].duck_spans, (), "a silent video is not speech")
        # the same speech sound from a video that HAS sound lowers the music under it
        table[BASE] = video(has_audio=True)
        spec = tr.to_render_spec(doc, table.get, "/o.mp4")
        ducked = [t for t in spec.audio_tracks if t.path == "/m/song.mp3"][0]
        self.assertEqual(ducked.duck_spans, ((0.0, 2.0),))

    def test_a_ten_times_clip_retimes_the_picture_in_one_setpts(self):
        from modules import render_backend
        seg = rs.Segment(1.0, "/m/a.mp4", speed=10.0)
        c = render_backend.segment_commands("ffmpeg", seg, Path("/w/s.mp4"), 320, 180, 30, frame_exact=True)[0]
        self.assertTrue(c[c.index("-vf") + 1].startswith("setpts=(PTS-STARTPTS)/10.000,"))
        slow = rs.Segment(1.0, "/m/a.mp4", speed=0.1)
        c = render_backend.segment_commands("ffmpeg", slow, Path("/w/s.mp4"), 320, 180, 30, frame_exact=True)[0]
        self.assertTrue(c[c.index("-vf") + 1].startswith("setpts=(PTS-STARTPTS)/0.100,"))


# ── real ffmpeg, checked with ffprobe ────────────────────────────────────────

class _Real(ovt._Real):
    W, H = 320, 180

    def setUp(self):
        super().setUp()
        self.ffprobe = shutil.which("ffprobe")
        if not self.ffprobe:
            self.skipTest("ffprobe not available")

    def tone_video(self, name="tone", seconds=4, fps=30, hz=440, size=None):
        path = self.dir / f"{name}.mp4"
        self.run_ffmpeg("-f", "lavfi", "-i", f"testsrc2=s={size or f'{self.W}x{self.H}'}:r={fps}:d={seconds}",
                        "-f", "lavfi", "-i", f"sine=frequency={hz}:sample_rate=48000:duration={seconds}",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", str(path))
        return tl.ResolvedAsset(BASE, "video", str(path), float(seconds), True)

    def probe(self, path):
        out = subprocess.run([self.ffprobe, "-v", "error", "-count_frames", "-show_streams", "-show_format",
                              "-of", "json", str(path)], capture_output=True, text=True, check=True).stdout
        return json.loads(out)

    def video_stream(self, path):
        return next(s for s in self.probe(path)["streams"] if s["codec_type"] == "video")

    def audio_streams(self, path):
        return [s for s in self.probe(path)["streams"] if s["codec_type"] == "audio"]

    def levels(self, path, start=None, dur=None):
        """(mean, max) volume in dBFS of the output's sound (ffmpeg volumedetect)."""
        cut = (["-ss", str(start)] if start is not None else []) + (["-t", str(dur)] if dur is not None else [])
        proc = subprocess.run([self.ffmpeg, "-hide_banner", "-nostats", *cut, "-i", str(path), "-vn", "-af",
                               "volumedetect", "-f", "null", "-"], capture_output=True, text=True)
        mean = re.search(r"mean_volume: (-?[\d.]+|-inf) dB", proc.stderr)
        peak = re.search(r"max_volume: (-?[\d.]+|-inf) dB", proc.stderr)
        f = lambda m: float("-inf") if m.group(1) == "-inf" else float(m.group(1))  # noqa: E731
        return f(mean), f(peak)

    def pcm(self, path, rate=8000):
        raw = self.run_ffmpeg("-i", str(path), "-vn", "-f", "s16le", "-ac", "1", "-ar", str(rate), "-")
        return [int.from_bytes(raw[i:i + 2], "little", signed=True) for i in range(0, len(raw) - 1, 2)]

    def tone_hz(self, samples, rate=8000):
        crossings = sum(1 for a, b in zip(samples, samples[1:]) if a <= 0 < b)
        return crossings / (len(samples) / rate)


class FrameRateRenderTestCase(_Real):
    def test_the_chosen_rate_is_the_files_rate_frame_count_and_size(self):
        src = self.tone_video(seconds=3, fps=60)
        for fps in (24, 25, 60):
            with self.subTest(fps):
                out = self.export(vdoc(width=self.W, height=self.H, fps=fps, out_s=2, audio=True), {BASE: src})
                v = self.video_stream(out)
                self.assertEqual(v["r_frame_rate"], f"{fps}/1")
                self.assertEqual(int(v["nb_read_frames"]), 2 * fps)
                self.assertEqual((v["width"], v["height"]), (self.W, self.H))
                self.assertEqual(v["codec_name"], "h264")
                self.assertAlmostEqual(float(self.probe(out)["format"]["duration"]), 2.0, delta=0.1)


class ClipVolumeRenderTestCase(_Real):
    def render(self, src, **clip):
        return self.export(vdoc(width=self.W, height=self.H, out_s=3, **clip), {BASE: src})

    def test_zero_hundred_and_two_hundred_percent_measure_as_silence_the_tone_and_6_db_up(self):
        src = self.tone_video()
        full_mean, full_peak = self.levels(self.render(src, audio=True))
        up_mean, up_peak = self.levels(self.render(src, audio=True, gain_db=6))
        down_mean, _ = self.levels(self.render(src, audio=True, gain_db=-60))
        self.assertGreater(full_mean, -30, "the tone is there at 100 %")
        self.assertAlmostEqual(up_mean - full_mean, 6.0, delta=0.6)
        self.assertAlmostEqual(up_peak - full_peak, 6.0, delta=0.6)
        self.assertLess(up_peak, 0.0, "200 % of this tone does not clip")
        self.assertLess(down_mean, full_mean - 55, "0 % is the floor, silent to the ear")

    def test_a_muted_clip_leaves_no_sound_whatever_its_level(self):
        out = self.render(self.tone_video(), audio=False, gain_db=6)
        streams = self.audio_streams(out)
        if streams:   # the mix may still write a silent track; it must be silence
            self.assertEqual(self.levels(out)[1], float("-inf"))


class DetachedSoundRenderTestCase(_Real):
    def test_a_detached_sound_plays_where_it_was_put_and_the_clip_is_silent(self):
        src = self.tone_video(seconds=6)
        # the picture runs 0-4 s, silent; its sound (source 0-2 s) was detached and moved to 2 s
        doc = with_sound(vdoc(width=self.W, height=self.H, out_s=4, audio=False), asset=BASE,
                         start_s=2, in_s=0, out_s=2, gain_db=0)
        out = self.export(doc, {BASE: src})
        self.assertEqual(len(self.audio_streams(out)), 1)
        self.assertAlmostEqual(float(self.probe(out)["format"]["duration"]), 4.0, delta=0.1)
        quiet = self.levels(out, start=0.2, dur=1.6)[1]
        loud = self.levels(out, start=2.2, dur=1.6)[0]
        self.assertLess(quiet, -60, "nothing before the sound starts")
        self.assertGreater(loud, -30, "the tone after it starts")
        samples = self.pcm(out)
        self.assertAlmostEqual(self.tone_hz(samples[int(2.2 * 8000):int(3.8 * 8000)]), 440, delta=25)

    def test_a_detached_sound_from_a_video_without_sound_renders_silent_not_failed(self):
        path = self.dir / "mute.mp4"
        self.run_ffmpeg("-f", "lavfi", "-i", f"testsrc2=s={self.W}x{self.H}:r=30:d=4", "-c:v", "libx264",
                        "-pix_fmt", "yuv420p", str(path))
        src = tl.ResolvedAsset(BASE, "video", str(path), 4.0, False)
        doc = with_sound(vdoc(width=self.W, height=self.H, out_s=4), asset=BASE, out_s=3)
        out = self.export(doc, {BASE: src})
        self.assertEqual(int(self.video_stream(out)["nb_read_frames"]), 120)
        if self.audio_streams(out):
            self.assertEqual(self.levels(out)[1], float("-inf"))


class WideSpeedRenderTestCase(_Real):
    def test_ten_times_lasts_a_tenth_and_a_tenth_lasts_ten_times_with_the_pitch_kept(self):
        src = self.tone_video(seconds=11)
        for speed, out_s, length in ((10.0, 10.0, 1.0), (0.1, 0.5, 5.0)):
            with self.subTest(speed):
                out = self.export(vdoc(width=self.W, height=self.H, out_s=out_s, speed=speed, audio=True), {BASE: src})
                v = self.video_stream(out)
                self.assertEqual(int(v["nb_read_frames"]), round(length * 30))
                a = self.audio_streams(out)
                self.assertEqual(len(a), 1)
                self.assertAlmostEqual(float(a[0]["duration"]), length, delta=0.1)
                samples = self.pcm(out)
                mid = samples[len(samples) // 4: 3 * len(samples) // 4]
                self.assertAlmostEqual(self.tone_hz(mid), 440, delta=25)


if __name__ == "__main__":
    unittest.main()
