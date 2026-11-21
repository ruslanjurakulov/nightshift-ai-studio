"""Music ducking in the editor's timeline document and its render
(modules/timeline.py, timeline_render.py, render_spec.py).

What would break, by test:

* a duck that is not an exact, bounded amount, or that sits on a track it
  makes no sense on (a picture track, a speech track that would lower itself);
* a document with no duck changing at all: same normalised form, same spec,
  same argv (older documents' golden argv is pinned in test_timeline_render);
* the envelope lowering music where there is no speech, or not lowering it
  where there is: it is evaluated here at known times, and again by a real
  ffmpeg when one is installed;
* speech that is not there ducking anyway: a source known to be silent, or
  one whose sound we could not check, is not speech;
* anything the document says reaching a filter graph as text.
"""

import copy
import json
import math
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from modules import render_backend
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr

V1 = "11111111-1111-4111-8111-111111111111"
V2 = "22222222-2222-4222-8222-222222222222"
MU = "44444444-4444-4444-8444-444444444444"
VO = "55555555-5555-4555-8555-555555555555"

ASSETS = {
    V1: tl.ResolvedAsset(V1, "video", "/media/talk.mp4", 30.0, True),
    V2: tl.ResolvedAsset(V2, "video", "/media/quiet.mp4", 30.0, False),
    MU: tl.ResolvedAsset(MU, "audio", "/media/song.mp3", 180.0),
    VO: tl.ResolvedAsset(VO, "audio", "/media/voice.wav", 30.0),
}


def doc(duck=None, **track):
    """A 20 s video: talking from 2 to 6 s and from 6.5 to 8 s, then a quiet
    clip; one music clip under all of it."""
    music = {"id": "a1", "kind": "A", "clips": [
        {"id": "m1", "asset_id": MU, "start_s": 0, "in_s": 10, "out_s": 30, "gain_db": -6}]}
    if duck is not None:
        music["duck"] = duck
    music.update(track)
    return {"version": 1, "width": 1280, "height": 720, "fps": 30, "tracks": [
        {"id": "v1", "kind": "V", "clips": [
            {"id": "c0", "asset_id": V2, "start_s": 0, "in_s": 0, "out_s": 2},
            {"id": "c1", "asset_id": V1, "start_s": 2, "in_s": 0, "out_s": 4, "audio": True},
            {"id": "c2", "asset_id": V1, "start_s": 6.5, "in_s": 5, "out_s": 6.5, "audio": True},
            {"id": "c3", "asset_id": V2, "start_s": 8, "in_s": 0, "out_s": 12, "audio": True}]},
        music]}


def problems_of(d):
    return tl.validate(d)


def has(problems, needle):
    return any(needle in p for p in problems)


class DuckValidationTestCase(unittest.TestCase):
    def test_a_duck_with_defaults_is_valid(self):
        self.assertEqual(problems_of(doc({"amount_db": 12})), [])
        self.assertEqual(problems_of(doc({"amount_db": 12, "attack_s": 0.1, "release_s": 1.5},
                                         role="music")), [])

    def test_the_bounds_are_exact(self):
        for key, lo, hi in (("amount_db", tl.DUCK_DB_MIN, tl.DUCK_DB_MAX),
                            ("attack_s", tl.DUCK_ATTACK_MIN_S, tl.DUCK_ATTACK_MAX_S),
                            ("release_s", tl.DUCK_RELEASE_MIN_S, tl.DUCK_RELEASE_MAX_S)):
            base = {"amount_db": 12}
            for ok in (lo, hi):
                with self.subTest(key=key, ok=ok):
                    self.assertEqual(problems_of(doc({**base, key: ok})), [])
            for bad in (lo - 0.001, hi + 0.001, "3", None, True, math.inf):
                with self.subTest(key=key, bad=bad):
                    self.assertTrue(has(problems_of(doc({**base, key: bad})), f"duck: {key} must be"))

    def test_the_amount_is_required_and_nothing_else_is_known(self):
        self.assertTrue(has(problems_of(doc({})), "amount_db is missing"))
        self.assertTrue(has(problems_of(doc({"amount_db": 12, "ratio": 4})),
                            "ratio is not a known field"))
        self.assertTrue(has(problems_of(doc(12)), "duck must be an object"))

    def test_role_is_music_or_speech(self):
        self.assertEqual(problems_of(doc(role="speech")), [])
        self.assertTrue(has(problems_of(doc(role="voice")), "role must be one of"))

    def test_a_speech_track_cannot_be_ducked(self):
        # Otherwise "who lowers whom" could go round in a circle.
        self.assertTrue(has(problems_of(doc({"amount_db": 12}, role="speech")),
                            "a speech track cannot be lowered under speech"))

    def test_only_an_audio_track_has_these_fields(self):
        for kind, clips in (("V", doc()["tracks"][0]["clips"]), ("T", [])):
            for field, value in (("duck", {"amount_db": 12}), ("role", "speech")):
                d = doc()
                other = {"id": "o1", "kind": kind, "clips": copy.deepcopy(clips), field: value}
                d["tracks"] = [other] if kind == "V" else d["tracks"] + [other]
                if kind == "V":
                    d["tracks"] += [t for t in doc()["tracks"][1:]]
                with self.subTest(kind=kind, field=field):
                    self.assertTrue(has(problems_of(d), f"{field} is not a known field"))


class DuckNormaliseTestCase(unittest.TestCase):
    def audio(self, d):
        return tl.normalise(d)["tracks"][1]

    def test_defaults_are_filled_in_and_the_role_is_kept(self):
        t = self.audio(doc({"amount_db": 9}, role="music"))
        self.assertEqual(t["duck"], {"amount_db": 9.0, **tl.DUCK_DEFAULTS})
        self.assertEqual(t["role"], "music")

    def test_a_document_without_them_normalises_as_before(self):
        t = self.audio(doc())
        self.assertNotIn("duck", t)
        self.assertNotIn("role", t)
        self.assertEqual(set(t), {"id", "kind", "clips"})

    def test_load_round_trips(self):
        d = doc({"amount_db": 14.2, "attack_s": 0.25, "release_s": 1.2})
        once = tl.load(d)
        self.assertEqual(tl.load(once), once)
        self.assertEqual(once["tracks"][1]["duck"],
                         {"amount_db": 14.2, "attack_s": 0.25, "release_s": 1.2})

    def test_defaults_match_the_ones_the_schema_documents(self):
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        props = schema["$defs"]["duck"]["properties"]
        self.assertEqual({k: props[k]["default"] for k in tl.DUCK_DEFAULTS}, tl.DUCK_DEFAULTS)

    def test_the_schema_accepts_it_when_jsonschema_is_installed(self):
        try:
            import jsonschema
        except ImportError:
            self.skipTest("jsonschema not installed (not a project dependency)")
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        d = doc({"amount_db": 12}, role="music")
        jsonschema.validate(d, schema)
        jsonschema.validate(tl.load(d), schema)
        for bad in (doc({"amount_db": 0}), doc({"amount_db": 12, "x": 1}), doc({}),
                    doc(role="voice")):
            with self.assertRaises(jsonschema.ValidationError):
                jsonschema.validate(bad, schema)


class SpeechSpansTestCase(unittest.TestCase):
    def test_spans_are_the_talking_clips_and_the_speech_tracks(self):
        d = tl.load(doc({"amount_db": 12}))
        d["tracks"].append({"id": "vo", "kind": "A", "role": "speech", "clips": [
            {"id": "vo1", "asset_id": VO, "start_s": 10, "in_s": 0, "out_s": 3,
             "gain_db": 0.0, "fade_in_s": 0.0, "fade_out_s": 0.0}]})
        self.assertEqual(tl.speech_spans(d), [(2.0, 6.0), (6.5, 8.0), (8.0, 20.0), (10.0, 13.0)])

    def test_a_clip_that_does_not_play_its_sound_is_not_speech(self):
        d = tl.load(doc())
        self.assertNotIn((0.0, 2.0), tl.speech_spans(d))        # c0 has audio off

    def test_merge_joins_a_pause_too_short_for_the_music_to_come_back(self):
        spans = [(2.0, 6.0), (6.5, 8.0), (12.0, 13.0)]
        self.assertEqual(tl.merge_spans(spans, 0.6), [(2.0, 8.0), (12.0, 13.0)])
        self.assertEqual(tl.merge_spans(spans, 0.5), spans)     # a gap of exactly 0.5 stays a gap
        self.assertEqual(tl.merge_spans([(0, 5), (1, 2)], 0.1), [(0, 5)])


def music_tracks(d, assets=ASSETS):
    spec = tr.to_render_spec(d, assets.get, "/out/x.mp4")
    return spec, [t for t in spec.audio_tracks if t.path == "/media/song.mp3"]


class DuckRenderSpecTestCase(unittest.TestCase):
    def test_music_is_ducked_under_the_clips_that_talk(self):
        _spec, (m,) = music_tracks(doc({"amount_db": 12, "attack_s": 0.3, "release_s": 0.5}))
        # c1 (2-6) and c2 (6.5-8) are 0.5 s apart, less than attack + release (0.8): one span.
        # c3 has sound on but its source is silent: not speech.
        self.assertEqual(m.duck_spans, ((2.0, 8.0),))
        self.assertEqual((m.duck_db, m.duck_attack_s, m.duck_release_s), (12.0, 0.3, 0.5))
        self.assertEqual(rs.validate(_spec), [])

    def test_separate_spans_when_the_pause_is_long_enough(self):
        _spec, (m,) = music_tracks(doc({"amount_db": 12, "attack_s": 0.1, "release_s": 0.2}))
        self.assertEqual(m.duck_spans, ((2.0, 6.0), (6.5, 8.0)))

    def test_a_source_whose_sound_is_unknown_is_not_speech(self):
        unknown = {**ASSETS, V1: tl.ResolvedAsset(V1, "video", "/media/talk.mp4", 30.0, None)}
        _spec, (m,) = music_tracks(doc({"amount_db": 12}), unknown)
        self.assertEqual(m.duck_spans, ())
        self.assertEqual(m.duck_db, 0.0)

    def test_a_speech_track_ducks_music_too(self):
        d = doc({"amount_db": 18})
        d["tracks"][0]["clips"] = [{"id": "c0", "asset_id": V2, "start_s": 0, "in_s": 0, "out_s": 20}]
        d["tracks"].append({"id": "vo", "kind": "A", "role": "speech", "clips": [
            {"id": "vo1", "asset_id": VO, "start_s": 4, "in_s": 0, "out_s": 3}]})
        spec, (m,) = music_tracks(d)
        self.assertEqual(m.duck_spans, ((4.0, 7.0),))
        voice = [t for t in spec.audio_tracks if t.path == "/media/voice.wav"][0]
        self.assertEqual(voice.duck_spans, ())             # speech itself is never lowered

    def test_a_clip_no_speech_can_touch_has_no_envelope(self):
        d = doc({"amount_db": 12, "attack_s": 0.3, "release_s": 0.5})
        d["tracks"][1]["clips"] = [
            {"id": "m1", "asset_id": MU, "start_s": 0, "in_s": 0, "out_s": 1},       # ends before the attack
            {"id": "m2", "asset_id": MU, "start_s": 12, "in_s": 0, "out_s": 5}]      # starts long after
        _spec, tracks = music_tracks(d)
        self.assertEqual([t.duck_spans for t in tracks], [(), ()])
        self.assertNotIn("duck_spans", tracks[0].to_dict())

    def test_a_clip_the_release_reaches_is_ducked(self):
        d = doc({"amount_db": 12, "attack_s": 0.3, "release_s": 2.0})
        d["tracks"][1]["clips"] = [
            {"id": "m1", "asset_id": MU, "start_s": 9, "in_s": 0, "out_s": 5}]       # 8 + release 2 > 9
        _spec, (m,) = music_tracks(d)
        self.assertEqual(m.duck_spans, ((2.0, 8.0),))

    def test_without_a_duck_nothing_changes(self):
        plain = doc()
        with_other = copy.deepcopy(plain)
        with_other["tracks"][1]["role"] = "music"          # a role alone is not a duck
        a, b = (tr.to_render_spec(x, ASSETS.get, "/out/x.mp4") for x in (plain, with_other))
        self.assertEqual(a, b)
        argv = rs.build_ffmpeg_command(a, "/w/concat.txt")
        self.assertNotIn("volume=volume=", " ".join(argv))
        for t in a.audio_tracks:
            self.assertEqual(set(t.to_dict()) & {"duck_db", "duck_spans"}, set())

    def test_the_spec_round_trips_through_a_dict(self):
        spec, _ = music_tracks(doc({"amount_db": 12, "attack_s": 0.1, "release_s": 0.2}))
        again = rs.RenderSpec.from_dict(json.loads(json.dumps(spec.to_dict())))
        self.assertEqual(again, spec)

    def test_an_invalid_duck_never_reaches_the_renderer(self):
        with self.assertRaises(tl.TimelineError):
            tr.to_render_spec(doc({"amount_db": 90}), ASSETS.get, "/out/x.mp4")


class DuckSpecValidationTestCase(unittest.TestCase):
    def spec(self, **kw):
        t = rs.AudioTrack("/m.mp3", 5.0, duck_db=12, duck_attack_s=0.3, duck_release_s=0.5,
                          duck_spans=((1.0, 2.0),))
        from dataclasses import replace
        return rs.RenderSpec("/o.mp4", segments=[rs.Segment(5.0, None, rs.KIND_COLOR)],
                             audio_tracks=[replace(t, **kw)])

    def test_a_good_one_is_valid(self):
        self.assertEqual(rs.validate(self.spec()), [])

    def test_bad_numbers_and_spans_are_refused(self):
        for kw, needle in (
                ({"duck_db": 0.0}, "duck amount"),
                ({"duck_db": 61.0}, "duck amount"),
                ({"duck_db": float("nan")}, "non-finite"),
                ({"duck_attack_s": 0.0}, "duck attack"),
                ({"duck_release_s": 11.0}, "duck release"),
                ({"duck_spans": ((2.0, 1.0),)}, "end after start"),
                ({"duck_spans": ((-1.0, 1.0),)}, "end after start"),
                ({"duck_spans": tuple((float(i), i + 0.5) for i in range(129))}, "more than 128"),
        ):
            with self.subTest(kw=kw):
                self.assertTrue(has(rs.validate(self.spec(**kw)), needle), rs.validate(self.spec(**kw)))

    def test_settings_without_spans_are_a_mistake_not_a_silent_no_op(self):
        self.assertTrue(has(rs.validate(self.spec(duck_spans=())), "no speech to duck under"))


def evaluate(expr, t):
    """ffmpeg's expression language, for the few functions the envelope uses,
    through Python (it has the same + - * / and min / max / clip)."""
    def clip(x, lo, hi):
        return max(lo, min(hi, x))
    self_check = re.fullmatch(r"[0-9a-z.+\-*/(),\s]*", expr)
    assert self_check, expr           # numbers, t and the three functions only
    return eval(expr, {"__builtins__": {}}, {"t": t, "min": min, "max": max, "clip": clip})


class DuckEnvelopeTestCase(unittest.TestCase):
    track = rs.AudioTrack("/m.mp3", 30.0, duck_db=12, duck_attack_s=0.5, duck_release_s=1.0,
                          duck_spans=((5.0, 8.0), (12.0, 13.0)))

    def gain_db(self, t):
        return 20 * math.log10(evaluate(rs.duck_expression(self.track), t))

    def test_full_level_outside_speech_and_exactly_the_amount_inside(self):
        for t in (0.0, 4.4, 9.1, 11.4, 20.0):
            self.assertAlmostEqual(evaluate(rs.duck_expression(self.track), t), 1.0, places=6, msg=t)
        for t in (5.0, 6.5, 8.0, 12.0, 13.0):
            self.assertAlmostEqual(self.gain_db(t), -12.0, places=2, msg=t)

    def test_the_music_is_already_down_when_speech_starts(self):
        # Attack ends AT the start of speech (lookahead), release begins at its end.
        self.assertGreater(self.gain_db(4.75), -12.0)
        self.assertLess(self.gain_db(4.75), 0.0)
        self.assertAlmostEqual(self.gain_db(5.0), -12.0, places=2)
        self.assertGreater(self.gain_db(8.5), -12.0)
        self.assertAlmostEqual(evaluate(rs.duck_expression(self.track), 9.0), 1.0, places=6)

    def test_a_span_near_the_start_does_not_need_negative_times(self):
        early = rs.AudioTrack("/m.mp3", 5.0, duck_db=6, duck_attack_s=0.5, duck_release_s=0.5,
                              duck_spans=((0.2, 1.0),))
        expr = rs.duck_expression(early)
        self.assertNotIn("--", expr)
        self.assertAlmostEqual(20 * math.log10(evaluate(expr, 0.2)), -6.0, places=2)
        lowered = 1 - 10 ** (-6 / 20)
        # At t=0 the attack is 0.3 s of 0.5 s along: 60 % of the way down.
        self.assertAlmostEqual(evaluate(expr, 0.0), 1 - lowered * 0.6, places=3)

    def test_the_command_places_it_after_the_delay_and_before_the_mix(self):
        spec = rs.RenderSpec("/o.mp4", segments=[rs.Segment(30.0, None, rs.KIND_COLOR)],
                             audio_tracks=[rs.AudioTrack("/v.wav", 3.0, start_s=5.0),
                                           rs.AudioTrack("/m.mp3", 30.0, start_s=2.0,
                                                         duck_db=12, duck_attack_s=0.5,
                                                         duck_release_s=1.0,
                                                         duck_spans=((5.0, 8.0),))])
        cmd = rs.build_ffmpeg_command(spec, "/w/concat.txt")
        graph = cmd[cmd.index("-filter_complex") + 1].split(";")
        self.assertEqual(len(graph), 4)
        self.assertTrue(graph[1].endswith("adelay=delays=2000:all=1[a1]"))
        self.assertEqual(graph[2],
                         "[a1]volume=volume='1-0.7488*clip(min((t-4.500)/0.500,(9.000-t)/1.000),0,1)'"
                         ":eval=frame[a1d]")
        self.assertTrue(graph[3].startswith("[a0][a1d]amix=inputs=2:duration=longest:normalize=0"))
        self.assertEqual(rs.audio_duck_filter(spec.audio_tracks[1], "a1", "a1d"), graph[2])

    def test_the_full_argv_is_pinned(self):
        spec, _ = music_tracks(doc({"amount_db": 12, "attack_s": 0.3, "release_s": 0.5}))
        cmd = rs.build_ffmpeg_command(spec, "/w/concat.txt")
        self.assertEqual(cmd[cmd.index("-filter_complex") + 1], GOLDEN_GRAPH)

    def test_nothing_from_the_document_reaches_the_graph(self):
        d = doc({"amount_db": 12})
        d["tracks"][1]["id"] = "zzmusic"
        d["tracks"][1]["name"] = "zzname"
        d["tracks"][1]["clips"][0]["id"] = "zzclip"
        spec, _ = music_tracks(d)
        graph = " ".join(rs.build_ffmpeg_command(spec, "/w/concat.txt"))
        for token in ("zzmusic", "zzname", "zzclip", MU, V1, "duck", "speech"):
            self.assertNotIn(token, graph)


GOLDEN_GRAPH = (
    "[1:a]atrim=start=0.000:duration=4.000,asetpts=PTS-STARTPTS,"
    "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=delays=2000:all=1[a0];"
    "[2:a]atrim=start=5.000:duration=1.500,asetpts=PTS-STARTPTS,"
    "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=delays=6500:all=1[a1];"
    "[3:a]atrim=start=10.000:duration=20.000,asetpts=PTS-STARTPTS,"
    "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=-6.000dB[a2];"
    "[a2]volume=volume='1-0.7488*clip(min((t-1.700)/0.300,(8.500-t)/0.500),0,1)':eval=frame[a2d];"
    "[a0][a1][a2d]amix=inputs=3:duration=longest:normalize=0,apad,atrim=end=20.000000[aout]"
)


def _ffmpeg():
    exe = render_backend.resolve_ffmpeg()
    try:
        ok = subprocess.run([exe, "-version"], capture_output=True).returncode == 0
        filters = subprocess.run([exe, "-hide_banner", "-filters"], capture_output=True,
                                 text=True).stdout
    except OSError:
        return None
    return exe if ok and " volume " in filters and " sine " in filters else None


@unittest.skipUnless(_ffmpeg(), "ffmpeg with the volume and sine filters not available")
class RealDuckRenderTestCase(unittest.TestCase):
    """A real ffmpeg runs the argv and the music really is lowered by the
    amount, and only where the speech is."""

    def test_the_music_drops_by_the_amount_under_speech_and_comes_back(self):
        exe = _ffmpeg()
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            subprocess.run([exe, "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=12",
                            "-c:a", "pcm_s16le", str(d / "m.wav")], capture_output=True, check=True)
            track = rs.AudioTrack(str(d / "m.wav"), 8.0, duck_db=12, duck_attack_s=0.3,
                                  duck_release_s=0.5, duck_spans=((2.0, 4.0), (6.0, 6.5)))
            spec = rs.RenderSpec(str(d / "o.mp4"), width=64, height=64, fps=25,
                                 segments=[rs.Segment(8.0, None, rs.KIND_COLOR)],
                                 frame_exact=True, audio_tracks=[track])
            self.assertEqual(rs.validate(spec), [])
            render_backend.render(spec, ffmpeg=exe)

            def mean_volume(start, length):
                err = subprocess.run([exe, "-ss", str(start), "-t", str(length), "-i", str(d / "o.mp4"),
                                      "-vn", "-af", "volumedetect", "-f", "null", "-"],
                                     capture_output=True, text=True).stderr
                return float(re.findall(r"mean_volume: (-?[\d.]+) dB", err)[-1])

            before, during, between, inside_two, after = (
                mean_volume(0.5, 1.0), mean_volume(2.4, 1.2), mean_volume(4.8, 0.8),
                mean_volume(6.1, 0.3), mean_volume(7.2, 0.7))
            self.assertAlmostEqual(before - during, 12.0, delta=0.6)
            self.assertAlmostEqual(before - inside_two, 12.0, delta=0.6)
            self.assertAlmostEqual(before, between, delta=0.3)
            self.assertAlmostEqual(before, after, delta=0.3)


if __name__ == "__main__":
    unittest.main()
