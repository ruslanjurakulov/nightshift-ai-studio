"""Editor parity 4, the talking-head pack (backend half): ``voice: "clean"`` on a sound and on a clip's own sound, the
document's ``bleeps`` (mute or a 1 kHz tone over a range of the final mix), a text's ``tracking`` / ``italic`` /
``align``, and the eleventh caption style ``single_word`` (its tags are pinned in tests/test_caption_styles.py and the
whole file in samples/caption_single_word_golden.ass).

What would break without these:

* a value off a closed list, a wrong type or a field in the wrong place reaching the export, or the two validators
  (this one and command-center/lib/editor.ts, which judges samples/timeline_parity4_fuzz.json and the shared cases)
  disagreeing;
* a voice normalised twice (``voice`` beside ``denoise`` / ``loudnorm`` is refused, and the chain holds one loudnorm);
* clean voice getting past the render budget (its charge is in the work estimate);
* bleeps out of order, overlapping, too many, too short or too long reaching the graph;
* any older document rendering a different command (samples/parity4_argv_golden.json, made on origin/main);
* the new graphs changing unseen (samples/parity4_new_argv_golden.json);
* the SOUND and the PICTURE, through the export's own render call (``timeline_render.render`` with ``jobs=1`` and a
  timeout, as modules/editor_export.run_export calls it), with the pinned ffmpeg (render_backend.resolve_ffmpeg):
  clean voice lands at -16 LUFS and takes hum and sibilance down on a speech-like recording; a bleep is silent or a
  tone exactly over its range and the rest is the plain render; tracking widens a text, alignment moves its lines.
"""

import json
import math
import random
import re
import subprocess
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from modules import ass_captions
from modules import render_backend as rb
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr
from tests import parity4_argv_docs as golden_docs

ROOT = Path(__file__).resolve().parent.parent
CORPUS = ROOT / "samples" / "timeline_parity4_fuzz.json"
SINGLE_WORD_ASS = ROOT / "samples" / "caption_single_word_golden.ass"
B = "11111111-1111-4111-8111-111111111111"
S = "22222222-2222-4222-8222-222222222222"
SEED = 20261113


def doc(clips=None, tracks=(), **top):
    clips = clips if clips is not None else [{"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": 6}]
    d = {"version": 1, "width": 640, "height": 360, "fps": 30,
         "tracks": [{"id": "v1", "kind": "V", "clips": clips}, *tracks]}
    d.update(top)
    return d


def sound(**c):
    return {"id": "a1", "kind": "A", "clips": [{"id": "s1", "asset_id": S, "start_s": 0, "in_s": 0, "out_s": 6, **c}]}


def text(**c):
    return {"id": "t1", "kind": "T", "clips": [{"id": "x1", "start_s": 0, "end_s": 2, "text": "Hi", **c}]}


def has(problems, needle):
    return any(needle in p for p in problems)


# ── the document ─────────────────────────────────────────────────────────────

class VoiceDocumentTestCase(unittest.TestCase):
    def test_clean_is_the_only_voice_on_a_sound_and_on_a_clip(self):
        self.assertEqual(tl.validate(doc(tracks=[sound(voice="clean")])), [])
        self.assertEqual(tl.validate(doc([{"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": 6,
                                           "audio": True, "voice": "clean"}])), [])
        for bad in ("Clean", "loud", "", None, True, 1, ["clean"], {"clean": 1}):
            with self.subTest(bad=bad):
                self.assertTrue(has(tl.validate(doc(tracks=[sound(voice=bad)])), "voice must be one of"))

    def test_a_voice_is_never_normalised_twice(self):
        def with_flags(where, **flags):
            if where == "A":
                return doc(tracks=[sound(voice="clean", **flags)])
            return doc([{"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": 6, "audio": True,
                         "voice": "clean", **flags}])
        for k in ("denoise", "loudnorm"):
            for where in ("A", "V"):
                with self.subTest(k=k, where=where):
                    self.assertTrue(has(tl.validate(with_flags(where, **{k: True})), 'voice "clean" already reduces noise'))
                    self.assertEqual(tl.validate(with_flags(where, **{k: False})), [])   # off: the preset alone

    def test_a_clip_that_plays_no_sound_may_keep_it_like_denoise(self):
        self.assertEqual(tl.validate(doc([{"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": 6,
                                           "voice": "clean"}])), [])

    def test_normalise_keeps_it_and_the_spec_carries_it_only_when_set(self):
        n = tl.normalise(doc(tracks=[sound(voice="clean")]))
        self.assertEqual(n["tracks"][1]["clips"][0]["voice"], "clean")
        res = lambda a: tl.ResolvedAsset(a, "audio" if a == S else "video", "/m/x", 60.0, True)
        spec = tr.to_render_spec(doc(tracks=[sound(voice="clean")]), res, "/w/o.mp4")
        self.assertEqual([t.voice for t in spec.audio_tracks], ["clean"])
        self.assertEqual(rs.AudioTrack.from_dict(spec.audio_tracks[0].to_dict()), spec.audio_tracks[0])
        plain = tr.to_render_spec(doc(tracks=[sound()]), res, "/w/o.mp4")
        self.assertNotIn("voice", plain.audio_tracks[0].to_dict())

    def test_the_spec_refuses_what_the_document_would(self):
        t = rs.AudioTrack(path="/m/a.wav", duration_s=2.0, voice="clean", loudnorm=True)
        spec = rs.RenderSpec(output_path="/w/o.mp4", segments=[rs.Segment(duration=2.0, path="/m/a.mp4")], audio_tracks=[t])
        self.assertTrue(has(rs.validate(spec), "voice already cleans"))
        self.assertTrue(has(rs.validate(replace(spec, audio_tracks=[replace(t, loudnorm=False, voice="x")])),
                            "voice must be one of"))
        self.assertEqual(rs.validate(replace(spec, audio_tracks=[replace(t, loudnorm=False)])), [])

    def test_the_chain_has_one_loudness_pass_and_sits_where_denoise_did(self):
        t = rs.AudioTrack(path="/m/a.wav", duration_s=2.0, voice="clean", gain_db=-3, fade_in_s=0.5)
        chain = rs.audio_track_filter(t, 1, "a0")
        self.assertEqual(chain.count("loudnorm="), 1)
        self.assertEqual(chain.count("afftdn="), 1)
        order = [chain.index(x) for x in ("atrim", "highpass", "afftdn", "deesser", "acompressor", "loudnorm",
                                           "aformat", "volume=-3", "afade")]
        self.assertEqual(order, sorted(order))

    def test_the_budget_charges_it(self):
        def many(n, length=100):
            return doc(tracks=[{"id": f"a{i}", "kind": "A", "clips": [
                {"id": f"s{i}", "asset_id": S, "start_s": 0, "in_s": 0, "out_s": length, "voice": "clean"}]}
                for i in range(n)])
        # 120 s of timeline is allowed 3 x 120 + 120 = 480 s; each clean voice of 120 s is charged 12 s, so 30 of
        # them (31 A tracks is the most a document has room for) fill it to the second and 31 are 12 s over.
        self.assertEqual(tl.validate(many(30, 120)), [])
        self.assertTrue(has(tl.validate(many(31, 120)), "cleaning voices would take about 492 s"))
        self.assertTrue(has(tl.validate(many(31, 120)), "clean fewer voices"))
        self.assertEqual(tl.validate(many(31, 100)), [])
        self.assertEqual(tl.voice_seconds({"voice": "clean", "in_s": 0, "out_s": 10}, tl.KIND_A), 1.0)
        # A clip's own sound counts at its length on the timeline, and only when it plays.
        self.assertEqual(tl.voice_seconds({"voice": "clean", "audio": True, "in_s": 0, "out_s": 10, "speed": 2},
                                          tl.KIND_V), 0.5)
        self.assertEqual(tl.voice_seconds({"voice": "clean", "in_s": 0, "out_s": 10}, tl.KIND_V), 0.0)


class BleepDocumentTestCase(unittest.TestCase):
    def bleeps(self, *items):
        return tl.validate(doc([{"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": 20}],
                               bleeps=list(items)))

    def test_a_bleep_is_a_closed_range(self):
        self.assertEqual(self.bleeps({"start_s": 1, "end_s": 1.4, "mode": "mute"},
                                     {"start_s": 1.4, "end_s": 2, "mode": "tone"}), [])
        self.assertEqual(self.bleeps(), [])
        for bad, needle in (({"start_s": 1, "end_s": 2}, "mode is missing"),
                            ({"start_s": 1, "end_s": 2, "mode": "beep"}, "mode must be one of"),
                            ({"start_s": 1, "end_s": 2, "mode": None}, "mode must be one of"),
                            ({"start_s": 1, "end_s": 2, "mode": "mute", "gain": 0}, "gain is not a known field"),
                            ({"start_s": "1", "end_s": 2, "mode": "mute"}, "start_s must be a number"),
                            ({"start_s": -0.1, "end_s": 2, "mode": "mute"}, "start_s must be a number"),
                            ({"start_s": 1, "end_s": 1.049, "mode": "mute"}, "a bleep lasts 0.05 to 10 s"),
                            ({"start_s": 1, "end_s": 11.001, "mode": "mute"}, "a bleep lasts 0.05 to 10 s"),
                            ({"start_s": 2, "end_s": 1, "mode": "mute"}, "a bleep lasts"),
                            ("mute", "must be an object")):
            with self.subTest(bad=bad):
                self.assertTrue(has(self.bleeps(bad), needle), self.bleeps(bad))
        self.assertTrue(has(tl.validate(doc(bleeps={"start_s": 1})), "bleeps must be a list"))
        self.assertTrue(has(tl.validate(doc(bleeps=None)), "bleeps must be a list"))
        self.assertEqual(self.bleeps({"start_s": 1, "end_s": 1.05, "mode": "mute"},
                                     {"start_s": 2, "end_s": 12, "mode": "tone"}), [])

    def test_in_order_and_apart(self):
        a = {"start_s": 1, "end_s": 2, "mode": "mute"}
        self.assertTrue(has(self.bleeps(a, {"start_s": 1.999, "end_s": 3, "mode": "mute"}), "before the bleep before"))
        self.assertTrue(has(self.bleeps({"start_s": 3, "end_s": 4, "mode": "mute"}, a), "before the bleep before"))
        self.assertEqual(self.bleeps(a, {"start_s": 2, "end_s": 3, "mode": "mute"}), [])   # touching is apart

    def test_at_most_a_hundred(self):
        ok = [{"start_s": i * 0.1, "end_s": i * 0.1 + 0.05, "mode": "tone"} for i in range(tl.MAX_BLEEPS)]
        self.assertEqual(self.bleeps(*ok), [])
        self.assertTrue(has(self.bleeps(*ok, {"start_s": 15, "end_s": 15.1, "mode": "tone"}), "at most 100"))

    def test_normalise_rounds_to_milliseconds_and_drops_an_empty_list(self):
        n = tl.normalise(doc(bleeps=[{"start_s": 1.00049, "end_s": 1.5, "mode": "mute"}]))
        self.assertEqual(n["bleeps"], [{"start_s": 1.0, "end_s": 1.5, "mode": "mute"}])
        self.assertNotIn("bleeps", tl.normalise(doc(bleeps=[])))
        self.assertEqual(tl.normalise(doc(bleeps=[])), tl.normalise(doc()))

    def test_a_bleep_does_not_lengthen_the_timeline(self):
        self.assertEqual(tl.duration_s(doc(bleeps=[{"start_s": 9, "end_s": 10, "mode": "tone"}])), 6.0)

    def test_the_frame_grid_widens_outward_and_stops_at_the_picture(self):
        w = rs.bleep_windows(((1.004, 1.5, "mute"), (1.5, 2.0, "tone"), (5.9, 7.0, "mute"), (6.5, 7.0, "tone")), 6.0)
        self.assertEqual(w, [(100, 150, "mute"), (150, 200, "tone"), (590, 600, "mute")])
        self.assertEqual(rs.bleep_windows(((0.0, 0.05, "mute"),), 6.0), [(0, 5, "mute")])
        self.assertEqual(rs.bleep_windows(((0.123, 0.177, "mute"),), 6.0), [(12, 18, "mute")])

    def test_the_spec_refuses_what_the_document_would(self):
        spec = rs.RenderSpec(output_path="/w/o.mp4", segments=[rs.Segment(duration=2.0, path="/m/a.mp4")])
        for bleeps, needle in ((((1.0, 1.01, "mute"),), "must last"), (((1.0, 1.5, "loud"),), "mode must be one of"),
                               (((1.0, 1.5, "mute"), (1.4, 1.6, "mute")), "starts before"),
                               (tuple((i, i + 0.1, "mute") for i in range(101)), "at most 100")):
            with self.subTest(bleeps=bleeps[:2]):
                self.assertTrue(has(rs.validate(replace(spec, bleeps=bleeps)), needle))
        self.assertEqual(rs.validate(replace(spec, bleeps=((1.0, 1.5, "mute"),))), [])
        d = replace(spec, bleeps=((1.0, 1.5, "tone"),)).to_dict()
        self.assertEqual(rs.RenderSpec.from_dict(d).bleeps, ((1.0, 1.5, "tone"),))
        self.assertNotIn("bleeps", spec.to_dict())


class TextPropsDocumentTestCase(unittest.TestCase):
    def test_tracking_italic_and_align_are_closed(self):
        self.assertEqual(tl.validate(doc(tracks=[text(tracking=-100, italic=True, align="left")])), [])
        self.assertEqual(tl.validate(doc(tracks=[text(tracking=500, align="right")])), [])
        self.assertEqual(tl.validate(doc(tracks=[text(tracking=50.0)])), [])       # 50.0 is 50, as for rotate
        for bad, needle in (({"tracking": 501}, "tracking must be an integer"),
                            ({"tracking": -101}, "tracking must be an integer"),
                            ({"tracking": 12.5}, "tracking must be an integer"),
                            ({"tracking": "10"}, "tracking must be an integer"),
                            ({"tracking": True}, "tracking must be an integer"),
                            ({"italic": 1}, "italic must be true or false"),
                            ({"align": "justify"}, "align must be one of"),
                            ({"align": None}, "align must be one of")):
            with self.subTest(bad=bad):
                self.assertTrue(has(tl.validate(doc(tracks=[text(**bad)])), needle))

    def test_only_a_text_clip_takes_them(self):
        caps = {"style": {"tracking": 10}, "cues": [{"id": "k1", "start_s": 0, "end_s": 1, "text": "a"}]}
        self.assertTrue(has(tl.validate(doc(captions=caps)), "tracking is not a known field"))
        self.assertTrue(has(tl.validate(doc(tracks=[sound(italic=True)])), "italic is not a known field"))

    def test_off_is_no_field(self):
        n = tl.normalise(doc(tracks=[text(tracking=0, italic=False)]))
        self.assertEqual(n, tl.normalise(doc(tracks=[text()])))
        n = tl.normalise(doc(tracks=[text(tracking=50.0, italic=True, align="center")]))
        c = n["tracks"][1]["clips"][0]
        self.assertEqual((c["tracking"], type(c["tracking"]), c["italic"], c["align"]), (50, int, True, "center"))

    def test_the_ass_style_and_the_burn_filter(self):
        o = rs.TextOverlay(0.0, 2.0, "two\nlines", size=60, tracking=150, italic=True, align="right")
        ass = ass_captions.build_overlay_ass([rs.TextOverlay(0.0, 1.0, "x"), o], width=640, height=360)
        style = [ln for ln in ass.splitlines() if ln.startswith("Style: O1,")][0]
        fields = style.split(",")
        self.assertEqual((fields[8], fields[13]), ("-1", "9"))     # Italic, Spacing = 60 x 150 / 1000
        plain = [ln for ln in ass.splitlines() if ln.startswith("Style: O0,")][0].split(",")
        self.assertEqual((plain[8], plain[13]), ("0", "0"))
        spec = rs.RenderSpec(output_path="/w/o.mp4", segments=[rs.Segment(duration=2.0, path="/m/a.mp4")],
                             overlays=[rs.TextOverlay(0.0, 1.0, "x"), o])
        self.assertEqual(rs.overlay_subtitles_filter(spec, "/w/t.ass"), "subtitles='/w/t.ass':force_style='O1.Justify=3'")
        self.assertEqual(rs.overlay_subtitles_filter(replace(spec, overlays=[spec.overlays[0]]), "/w/t.ass"),
                         "subtitles='/w/t.ass'")
        for bad in (dict(tracking=600), dict(tracking=1.5), dict(italic="yes"), dict(align="justify")):
            with self.subTest(bad=bad):
                self.assertTrue(rs.validate(replace(spec, overlays=[replace(o, **bad)])))

    def test_the_spec_carries_them(self):
        spec = tr.to_render_spec(doc(tracks=[text(tracking=30, italic=True, align="left")]),
                                 lambda a: tl.ResolvedAsset(a, "video", "/m/a.mp4", 60.0, False), "/w/o.mp4")
        o = spec.overlays[0]
        self.assertEqual((o.tracking, o.italic, o.align), (30, True, "left"))
        self.assertEqual(rs.TextOverlay.from_dict(o.to_dict()), o)
        plain = tr.to_render_spec(doc(tracks=[text()]), lambda a: tl.ResolvedAsset(a, "video", "/m/a.mp4", 60.0, False),
                                  "/w/o.mp4").overlays[0].to_dict()
        for k in ("tracking", "italic", "align"):
            self.assertNotIn(k, plain)


class SharedNumbersTestCase(unittest.TestCase):
    def test_the_lists_and_limits_are_the_same_in_the_validator_the_spec_and_the_schema(self):
        self.assertEqual(tl.VOICES, rs.VOICES)
        self.assertEqual((tl.BLEEP_MODES, tl.MAX_BLEEPS, tl.BLEEP_MIN_S, tl.BLEEP_MAX_S),
                         (rs.BLEEP_MODES, rs.MAX_BLEEPS, rs.BLEEP_MIN_S, rs.BLEEP_MAX_S))
        self.assertEqual((tl.TRACKING_MIN, tl.TRACKING_MAX, tl.ALIGNS), (rs.TRACKING_MIN, rs.TRACKING_MAX, rs.ALIGNS))
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        d = schema["$defs"]
        for clip in ("video_clip", "audio_clip"):
            self.assertEqual(d[clip]["properties"]["voice"]["enum"], list(tl.VOICES))
        bleeps = schema["properties"]["bleeps"]
        self.assertEqual(bleeps["maxItems"], tl.MAX_BLEEPS)
        self.assertEqual(d["bleep"]["properties"]["mode"]["enum"], list(tl.BLEEP_MODES))
        self.assertEqual(d["bleep"]["required"], list(tl._BLEEP_KEYS))
        tp = d["text_clip"]["properties"]
        self.assertEqual((tp["tracking"]["minimum"], tp["tracking"]["maximum"]), (tl.TRACKING_MIN, tl.TRACKING_MAX))
        self.assertEqual(tp["align"]["enum"], list(tl.ALIGNS))
        self.assertEqual(set(tp), set(tl._T_CLIP_KEYS))
        self.assertEqual(set(d["audio_clip"]["properties"]), set(tl._A_CLIP_KEYS))
        self.assertEqual(set(schema["properties"]), set(tl._DOC_KEYS))

    def test_documents_validate_against_the_schema_when_available(self):
        try:
            import jsonschema
        except ImportError:
            self.skipTest("jsonschema not installed (not a project dependency)")
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        for d in golden_docs.new_docs().values():
            jsonschema.validate(d, schema)


# ── the commands ─────────────────────────────────────────────────────────────

class CommandsTestCase(unittest.TestCase):
    def test_documents_without_the_new_fields_build_the_commands_main_built(self):
        golden = json.loads((ROOT / "samples" / "parity4_argv_golden.json").read_text(encoding="utf-8"))
        docs = golden_docs.docs()
        self.assertEqual(set(golden), set(docs))
        for name, d in docs.items():
            with self.subTest(name):
                self.assertEqual(golden_docs.argv(d), golden[name])

    def test_the_new_graphs_are_pinned(self):
        golden = json.loads((ROOT / "samples" / "parity4_new_argv_golden.json").read_text(encoding="utf-8"))
        docs = golden_docs.new_docs()
        self.assertEqual(set(golden), set(docs))
        for name, d in docs.items():
            with self.subTest(name):
                self.assertEqual(golden_docs.argv(d), golden[name],
                                 "regenerate: python3 -m tests.parity4_argv_docs --new samples/parity4_new_argv_golden.json")

    def test_a_bleep_past_the_picture_changes_nothing(self):
        g = json.loads((ROOT / "samples" / "parity4_new_argv_golden.json").read_text(encoding="utf-8"))
        plain = golden_docs._doc([{"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": 6, "audio": True}])
        self.assertEqual(g["bleep_past_the_end"]["argv"], golden_docs.argv(plain)["argv"])

    def test_the_single_word_style_writes_the_pinned_file(self):
        d = golden_docs.new_docs()["text_properties"]
        ass = golden_docs.argv(d)["ass"]
        self.assertEqual(ass, SINGLE_WORD_ASS.read_text(encoding="utf-8"))


# ── the fuzz corpus both validators judge ───────────────────────────────────

def _pick(rng, good, bad):
    return rng.choice(good) if rng.random() < 0.8 else rng.choice(bad)


def random_doc(rng):
    clip = {"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": rng.choice([2.0, 30.0, 600.0])}
    if rng.random() < 0.6:
        clip["audio"] = rng.random() < 0.8
    for k in ("denoise", "loudnorm"):
        if rng.random() < 0.2:
            clip[k] = _pick(rng, [True, False], [1, "yes"])
    if rng.random() < 0.5:
        clip["voice"] = _pick(rng, ["clean"], ["Clean", "", None, 1])
    tracks = [{"id": "v1", "kind": "V", "clips": [clip]}]
    for i in range(rng.choice([25, 31]) if rng.random() < 0.06 else rng.choice([0, 1, 2])):
        c = {"id": f"s{i}", "asset_id": S, "start_s": 0, "in_s": 0, "out_s": clip["out_s"]}
        if rng.random() < 0.7:
            c["voice"] = _pick(rng, ["clean"], ["x", True])
        if rng.random() < 0.15:
            c[rng.choice(["denoise", "loudnorm"])] = True
        tracks.append({"id": f"a{i}", "kind": "A", "clips": [c]})
    if rng.random() < 0.6:
        t = {"id": "x1", "start_s": 0, "end_s": 2, "text": "two\nlines"}
        if rng.random() < 0.6:
            t["tracking"] = _pick(rng, [-100, 0, 40, 500, 50.0], [501, -101, 2.5, "9", True, None])
        if rng.random() < 0.5:
            t["italic"] = _pick(rng, [True, False], [0, "true"])
        if rng.random() < 0.5:
            t["align"] = _pick(rng, ["left", "center", "right"], ["justify", "", None, 2])
        tracks.append({"id": "t1", "kind": "T", "clips": [t]})
    d = {"version": 1, "width": 1280, "height": 720, "fps": 30, "tracks": tracks}
    if rng.random() < 0.7:
        bleeps, at = [], 0.0
        count = rng.choice([100, 101]) if rng.random() < 0.04 else rng.choice([0, 1, 2, 3])
        for _ in range(count):
            start = round(at + rng.choice([0, 0.2, -0.01]), 3)
            length = rng.choice([0.05, 0.3, 10.0, 0.049, 10.001])
            b = {"start_s": start, "end_s": round(start + length, 3), "mode": _pick(rng, ["mute", "tone"], ["beep", 1])}
            if rng.random() < 0.03:
                b["gain"] = 1
            if rng.random() < 0.03:
                del b["mode"]
            bleeps.append(b)
            at = b["end_s"]
        d["bleeps"] = bleeps if rng.random() < 0.95 else {"bad": 1}
    return d


def corpus():
    rng = random.Random(SEED)
    return [{"valid": tl.validate(d) == [], "doc": d} for d in (random_doc(rng) for _ in range(400))]


class FuzzCorpusTestCase(unittest.TestCase):
    def test_the_corpus_is_current_and_holds_both_verdicts(self):
        stored = json.loads(CORPUS.read_text(encoding="utf-8"))
        self.assertEqual(stored["seed"], SEED)
        self.assertEqual(stored["cases"], corpus(), "regenerate: python3 -m tests.test_editor_parity4 --write")
        valid = sum(c["valid"] for c in stored["cases"])
        self.assertGreater(valid, 60)
        self.assertGreater(400 - valid, 60)

    def test_every_valid_one_normalises_valid_and_builds_a_spec_and_its_final_command(self):
        res = lambda a: tl.ResolvedAsset(a, "audio" if a == S else "video", "/m/a.mp4", 1000.0, True)
        for c in corpus():
            if not c["valid"]:
                continue
            self.assertEqual(tl.validate(tl.normalise(c["doc"])), [])
            spec = tr.to_render_spec(c["doc"], res, "/w/o.mp4")
            self.assertEqual(rs.validate(spec), [])
            cmd = rs.build_ffmpeg_command(spec, "/w/c.txt", "/w/o.ass")
            graph = cmd[cmd.index("-filter_complex") + 1] if "-filter_complex" in cmd else ""
            for t in spec.audio_tracks:
                if t.voice:
                    self.assertNotIn("loudnorm=I=-16:TP=-1.5:LRA=11,loudnorm", graph)
            self.assertLessEqual(graph.count("loudnorm="), len(spec.audio_tracks))


# ── real renders ─────────────────────────────────────────────────────────────

def _ffmpeg():
    try:
        exe = rb.resolve_ffmpeg()
        subprocess.run([exe, "-version"], capture_output=True, check=True)
        return exe
    except Exception:
        return None


class _Real(unittest.TestCase):
    RATE = 48000

    @classmethod
    def setUpClass(cls):
        cls.ffmpeg = _ffmpeg()
        if not cls.ffmpeg:
            raise unittest.SkipTest("ffmpeg not available")
        try:
            import numpy  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("numpy not available")
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        cls.n = 0

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    @classmethod
    def run_ffmpeg(cls, *args):
        p = subprocess.run([cls.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *args], capture_output=True)
        if p.returncode:
            raise AssertionError(p.stderr.decode()[-600:])
        return p.stdout

    @classmethod
    def black(cls, seconds, size="320x180"):
        path = cls.dir / f"black{seconds}.mp4"
        if not path.exists():
            cls.run_ffmpeg("-f", "lavfi", "-i", f"color=c=black:s={size}:r=30:d={seconds}", "-c:v", "libx264",
                           "-pix_fmt", "yuv420p", str(path))
        return tl.ResolvedAsset(B, "video", str(path), float(seconds), False)

    def export(self, d, table):
        """The worker's render call: one job, a deadline (modules/editor_export.run_export)."""
        type(self).n += 1
        out = self.dir / f"out{self.n}.mp4"
        tr.render(d, table.get, str(out), jobs=1, timeout_s=tl.render_timeout_s(tl.duration_s(tl.load(d))))
        return out

    def samples(self, path):
        import numpy as np
        raw = self.run_ffmpeg("-i", str(path), "-vn", "-ac", "1", "-ar", str(self.RATE), "-f", "f32le", "-")
        return np.frombuffer(raw, "<f4").astype(float)

    def loudness(self, path):
        p = subprocess.run([self.ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-vn", "-af", "ebur128",
                            "-f", "null", "-"], capture_output=True, text=True)
        return float(re.findall(r"I:\s+(-?[\d.]+) LUFS", p.stderr)[-1])

    @staticmethod
    def db(xs):
        import numpy as np
        return 10 * math.log10(float(np.mean(np.asarray(xs) ** 2)) + 1e-20)

    def tone_db(self, xs, freq):
        """The level of one frequency in ``xs`` (a single-bin DFT), dB of a full-scale sine's RMS."""
        import numpy as np
        xs = np.asarray(xs)
        t = np.arange(len(xs)) / self.RATE
        c = np.dot(xs, np.cos(2 * np.pi * freq * t))
        s = np.dot(xs, np.sin(2 * np.pi * freq * t))
        amp = 2 * math.hypot(c, s) / len(xs)
        return 20 * math.log10(amp / math.sqrt(2) + 1e-12)

    def band_db(self, xs, lo, hi):
        import numpy as np
        xs = np.asarray(xs)
        spec = np.abs(np.fft.rfft(xs)) ** 2
        f = np.fft.rfftfreq(len(xs), 1 / self.RATE)
        return 10 * math.log10(float(spec[(f >= lo) & (f <= hi)].sum()) / len(xs) ** 2 + 1e-20)

    def span(self, xs, a, b):
        return xs[int(a * self.RATE):int(b * self.RATE)]


class CleanVoiceRenderTestCase(_Real):
    SECONDS = 8.0

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        sys.path.insert(0, str(ROOT))
        from tests import speech_sample
        cls.wav = cls.dir / "speech.wav"
        cls.voiced, cls.sibilant = speech_sample.write(cls.wav, cls.SECONDS)
        cls.table = {B: cls.black(cls.SECONDS), S: tl.ResolvedAsset(S, "audio", str(cls.wav), cls.SECONDS)}

    def render(self, **flags):
        out = self.export(doc([{"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": self.SECONDS}],
                              [sound(out_s=self.SECONDS, **flags)]), self.table)
        return out, self.samples(out)

    def test_it_lands_at_minus_16_lufs_with_less_hum_and_sibilance_under_the_voice(self):
        plain_out, plain = self.render()
        clean_out, clean = self.render(voice="clean")
        self.assertAlmostEqual(len(clean) / self.RATE, self.SECONDS, delta=0.05)
        self.assertLess(self.loudness(plain_out), -22)               # the recording is quiet (-25 LUFS)
        self.assertAlmostEqual(self.loudness(clean_out), -16.0, delta=1.0)
        n = min(len(plain), len(clean), len(self.voiced))
        v, sib = self.voiced[:n], self.sibilant[:n]

        def under_voice(xs, lo, hi, mask):
            return self.band_db(xs[:n][mask], lo, hi) - self.band_db(xs[:n][v], 300, 3500)

        hum = under_voice(plain, 45, 55, v) - under_voice(clean, 45, 55, v)
        ess = under_voice(plain, 5000, 9000, sib) - under_voice(clean, 5000, 9000, sib)
        self.assertGreater(hum, 12, f"mains hum only {hum:.1f} dB further under the voice")
        self.assertGreater(ess, 3, f"sibilance only {ess:.1f} dB further under the voice")

    def test_loudnorm_alone_reaches_the_same_level_without_the_rest(self):
        # The preset's loudness is the same target as the loudnorm switch: one pass, the same -16.
        out, xs = self.render(loudnorm=True)
        self.assertAlmostEqual(self.loudness(out), -16.0, delta=1.0)

    def test_a_clips_own_sound_takes_it_too(self):
        path = self.dir / "talk.mp4"
        self.run_ffmpeg("-f", "lavfi", "-i", f"color=c=0x404040:s=320x180:r=30:d={self.SECONDS}", "-i", str(self.wav),
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", str(path))
        table = {B: tl.ResolvedAsset(B, "video", str(path), self.SECONDS, True)}
        clip = {"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": self.SECONDS, "audio": True}
        out = self.export(doc([{**clip, "voice": "clean"}]), table)
        self.assertAlmostEqual(self.loudness(out), -16.0, delta=1.0)

    def test_music_still_ducks_under_a_clean_voice(self):
        music = self.dir / "music.wav"
        self.run_ffmpeg("-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={self.SECONDS},volume=-20dB",
                        str(music))
        table = {**self.table, "33333333-3333-4333-8333-333333333333":
                 tl.ResolvedAsset("33333333-3333-4333-8333-333333333333", "audio", str(music), self.SECONDS)}
        m = {"id": "m9", "kind": "A", "duck": {"amount_db": 18}, "clips": [
            {"id": "mu", "asset_id": "33333333-3333-4333-8333-333333333333", "start_s": 0, "in_s": 0,
             "out_s": self.SECONDS}]}
        speech = {"id": "a1", "kind": "A", "role": "speech", "clips": [
            {"id": "s1", "asset_id": S, "start_s": 4, "in_s": 0, "out_s": 4, "voice": "clean"}]}
        xs = self.samples(self.export(doc([{"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": self.SECONDS}],
                                          [m, speech]), table))
        before, during = self.tone_db(self.span(xs, 1, 3), 440), self.tone_db(self.span(xs, 5, 7.5), 440)
        self.assertAlmostEqual(before - during, 18, delta=2.0)


class BleepRenderTestCase(_Real):
    SECONDS = 6.0

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.wav = cls.dir / "tone440.wav"
        cls.run_ffmpeg("-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={cls.SECONDS},volume=-12dB",
                       str(cls.wav))
        cls.table = {B: cls.black(cls.SECONDS), S: tl.ResolvedAsset(S, "audio", str(cls.wav), cls.SECONDS)}

    def render(self, bleeps=None, with_sound=True):
        clips = [{"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": self.SECONDS}]
        d = doc(clips, [sound(out_s=self.SECONDS)] if with_sound else [])
        if bleeps is not None:
            d["bleeps"] = bleeps
        return self.samples(self.export(d, self.table))

    def test_the_ranges_are_silent_or_a_tone_and_the_rest_is_the_plain_mix(self):
        plain = self.render()
        out = self.render([{"start_s": 1.0, "end_s": 1.5, "mode": "mute"}, {"start_s": 2.0, "end_s": 2.6, "mode": "tone"}])
        self.assertEqual(len(out), len(plain))
        # Inside (30 ms from each edge: the AAC frame around a hard cut): silent; the tone alone.
        self.assertLess(self.db(self.span(out, 1.03, 1.47)), -70)
        inside = self.span(out, 2.03, 2.57)
        self.assertAlmostEqual(self.tone_db(inside, 1000), 20 * math.log10(0.125 / math.sqrt(2)), delta=1.0)
        self.assertLess(self.tone_db(inside, 440), -60)
        # Outside: the plain render, window by window.
        for a, b in ((0.1, 0.97), (1.53, 1.97), (2.63, 5.9)):
            with self.subTest(window=(a, b)):
                self.assertAlmostEqual(self.db(self.span(out, a, b)), self.db(self.span(plain, a, b)), delta=0.2)
                self.assertLess(self.tone_db(self.span(out, a, b), 1000), -60)

    def test_the_edges_are_on_the_10_ms_grid(self):
        out = self.render([{"start_s": 3.0, "end_s": 3.2, "mode": "mute"}])
        level = self.db(self.span(out, 2.5, 2.9))
        self.assertGreater(self.db(self.span(out, 2.94, 2.97)), level - 1)     # still sounding 30 ms before
        self.assertLess(self.db(self.span(out, 3.03, 3.17)), -70)
        self.assertGreater(self.db(self.span(out, 3.23, 3.26)), level - 1)     # back 30 ms after

    def test_a_tone_sounds_even_with_no_sound_on_the_timeline(self):
        out = self.render([{"start_s": 2.0, "end_s": 2.5, "mode": "tone"}], with_sound=False)
        self.assertAlmostEqual(len(out) / self.RATE, self.SECONDS, delta=0.05)
        self.assertGreater(self.tone_db(self.span(out, 2.03, 2.47), 1000), -25)
        self.assertLess(self.db(self.span(out, 0.2, 1.9)), -80)


class TextPropsRenderTestCase(_Real):
    W, H = 640, 360

    def frame(self, **props):
        clip = {"id": "x1", "start_s": 0, "end_s": 1, "text": "WIDE\nTWO", "size": 60, "anchor": "center",
                "x": 0.5, "y": 0.5, "outline_width": 0, **props}
        d = {"version": 1, "width": self.W, "height": self.H, "fps": 30,
             "tracks": [{"id": "v1", "kind": "V", "clips": [{"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0,
                                                             "out_s": 1}]},
                        {"id": "t1", "kind": "T", "clips": [clip]}]}
        out = self.export(d, {B: self.black(1, f"{self.W}x{self.H}")})
        raw = self.run_ffmpeg("-i", str(out), "-vf", "select=eq(n\\,5)", "-vsync", "0", "-pix_fmt", "gray",
                              "-f", "rawvideo", "-")
        self.assertEqual(len(raw), self.W * self.H)
        return raw

    def extent(self, raw, y0, y1):
        xs = [x for y in range(y0, y1) for x in range(self.W) if raw[y * self.W + x] > 128]
        return (min(xs), max(xs)) if xs else None

    def test_tracking_widens_and_italic_slants_and_align_lines_up_the_lines(self):
        plain = self.frame()
        top, bottom = (110, 178), (182, 250)        # the two lines of a 60 px text centred in a 360 px frame
        p_top, p_bot = self.extent(plain, *top), self.extent(plain, *bottom)
        wide = self.extent(self.frame(tracking=300), *top)
        self.assertGreater(wide[1] - wide[0], (p_top[1] - p_top[0]) + 3 * 60 * 0.3 - 6)   # 3 gaps of 18 px
        self.assertNotEqual(self.frame(italic=True), plain)
        left, right = self.frame(align="left"), self.frame(align="right")
        # The longer first line sets the box; the shorter second line moves to its left or right edge.
        self.assertAlmostEqual(self.extent(left, *bottom)[0], p_top[0], delta=3)
        self.assertAlmostEqual(self.extent(right, *bottom)[1], p_top[1], delta=3)
        self.assertGreater(self.extent(left, *bottom)[0] + 10, 0)
        self.assertNotEqual(self.extent(left, *bottom), p_bot)


if __name__ == "__main__":
    if "--write" in sys.argv:
        CORPUS.write_text(json.dumps({"_comment": "Seeded documents with voice / bleeps / text-property fields and "
                                      "modules/timeline.py's verdict; tests/test_editor_parity4.py keeps it current and "
                                      "command-center/tests/editor-parity4.test.ts judges each with lib/editor.ts.",
                                      "seed": SEED, "cases": corpus()}, indent=0) + "\n", encoding="utf-8")
    else:
        unittest.main()
