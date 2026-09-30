"""Timeline document v1 (modules/timeline.py): validation, normalisation,
duration, overlaps/gaps, split, presets, asset resolution — and the JSON
Schema twin in schemas/timeline.schema.json. Pure; no ffmpeg."""

import copy
import json
import unittest

from modules import timeline as tl

A1 = "11111111-1111-4111-8111-111111111111"
A2 = "22222222-2222-4222-8222-222222222222"
MU = "44444444-4444-4444-8444-444444444444"


def base_doc():
    return {
        "version": 1, "width": 1920, "height": 1080, "fps": 30,
        "tracks": [
            {"id": "v1", "kind": "V", "clips": [
                {"id": "c1", "asset_id": A1, "start_s": 0, "in_s": 1.0, "out_s": 4.0},
                {"id": "c2", "asset_id": A2, "start_s": 3.0, "in_s": 0, "out_s": 2.0,
                 "transition": {"type": "dip_to_black", "duration_s": 0.5}},
            ]},
            {"id": "a1", "kind": "A", "name": "music", "clips": [
                {"id": "m1", "asset_id": MU, "start_s": 0, "in_s": 0, "out_s": 6.0, "gain_db": -12},
            ]},
            {"id": "t1", "kind": "T", "clips": [
                {"id": "title", "start_s": 0, "end_s": 2, "text": "Hello"},
            ]},
        ],
        "captions": {"cues": [{"id": "k1", "start_s": 0.5, "end_s": 2.0, "text": "hi"}]},
    }


def resolver(extra=None):
    table = {
        A1: tl.ResolvedAsset(A1, "video", "/m/a1.mp4", 10.0),
        A2: tl.ResolvedAsset(A2, "image", "/m/a2.png", None),
        MU: tl.ResolvedAsset(MU, "audio", "/m/mu.mp3", 60.0),
    }
    table.update(extra or {})
    return table.get


class ValidateTestCase(unittest.TestCase):
    def test_base_document_is_valid(self):
        self.assertEqual(tl.validate(base_doc()), [])

    def test_invalid_documents_are_rejected_with_a_clear_reason(self):
        def clip(d, t=0, c=0):
            return d["tracks"][t]["clips"][c]

        cases = [
            (lambda d: d.update(version=2), "version must be 1"),
            (lambda d: d.update(width=1081), "width must be an even integer"),
            (lambda d: d.update(fps=29.97), "fps must be one of"),
            (lambda d: d.update(fps=True), "fps must be one of"),
            (lambda d: d.update(extra=1), "extra is not a known field"),
            (lambda d: d.pop("tracks"), "tracks is missing"),
            (lambda d: d["tracks"][0].update(kind="X"), "kind must be one of"),
            (lambda d: clip(d).update(out_s=0.5), "out_s (0.5) must be greater than in_s (1.0)"),
            (lambda d: clip(d).update(asset_id="../../etc/passwd"), "asset_id must be a uuid"),
            (lambda d: clip(d).update(path="/etc/passwd"), "path is not a known field"),
            (lambda d: clip(d).update(start_s=-1), "start_s must be a number >= 0"),
            (lambda d: clip(d).update(start_s=float("nan")), "start_s must be a number"),
            (lambda d: clip(d).update(start_s="0"), "start_s must be a number"),
            (lambda d: clip(d).update(fit="stretch"), "fit must be one of"),
            (lambda d: clip(d, 0, 1).update(transition={"type": "crossfade", "duration_s": 1}),
             "a cross-dissolve needs overlapping video"),
            (lambda d: clip(d).update(fade_in_s=2, fade_out_s=2), "longer than the clip"),
            (lambda d: clip(d, 1).update(gain_db=40), "gain_db must be a number"),
            (lambda d: clip(d, 2).update(text="   "), "text must be non-empty"),
            (lambda d: clip(d, 2).update(text="x" * 501), "at most 500 characters"),
            (lambda d: clip(d, 2).update(font="Comic Sans MS"), "font must be one of"),
            (lambda d: clip(d, 2).update(color="red"), "#RRGGBB"),
            (lambda d: clip(d, 2).update(x=1.5), "x must be a number"),
            (lambda d: clip(d, 2).update(end_s=0), "end_s (0) must be greater than start_s"),
            (lambda d: clip(d, 2).update(anchor="middle"), "anchor must be one of"),
            (lambda d: clip(d, 2).update(size=10000), "size must be an integer"),
            (lambda d: clip(d, 1).update(id="c1"), "id 'c1' is already used"),
            (lambda d: clip(d).update(id="has space"), "id must be 1-64"),
            (lambda d: d["tracks"].append({"id": "v2", "kind": "V", "clips": []}),
             "only one video (V) track"),
            (lambda d: clip(d).update(out_s=5.0), "clips 'c1' and 'c2' overlap"),
            (lambda d: d["captions"]["cues"].append(
                {"id": "k2", "start_s": 1.0, "end_s": 3.0, "text": "x"}), "'k1' and 'k2' overlap"),
            (lambda d: clip(d, 0, 1).update(transition={"type": "dip_to_black", "duration_s": 5}),
             "fades and transitions"),
            (lambda d: clip(d).update(start_s=14400), "longer than 4 hours"),
            (lambda d: clip(d).update(out_s=1.01), "shorter than one frame"),
            (lambda d: d["captions"].update(style={"y": 2}), "captions style: y must be"),
        ]
        for mutate, needle in cases:
            with self.subTest(needle=needle):
                d = base_doc()
                mutate(d)
                problems = tl.validate(d)
                self.assertTrue(any(needle in p for p in problems), (needle, problems))
                with self.assertRaises(tl.TimelineError) as cm:
                    tl.load(d)
                self.assertTrue(any(needle in p for p in cm.exception.problems))

    def test_problems_name_the_track_and_clip(self):
        d = base_doc()
        d["tracks"][0]["clips"][1]["out_s"] = 0
        problems = tl.validate(d)
        self.assertIn("track 'v1' clip 'c2': out_s (0) must be greater than in_s (0)", problems)

    def test_not_an_object(self):
        self.assertEqual(tl.validate([]), ["timeline must be an object"])

    def test_empty_timeline_has_nothing_to_render(self):
        d = tl.new_timeline("16:9")
        self.assertTrue(any("nothing to render" in p for p in tl.validate(d)))

    def test_many_overlaps_do_not_flood_the_error(self):
        d = base_doc()
        d["tracks"][0]["clips"] = [
            {"id": f"c{i}", "asset_id": A1, "start_s": 0, "in_s": 0, "out_s": 5} for i in range(100)]
        problems = tl.validate(d)
        self.assertLess(len(problems), 30)
        self.assertTrue(any("more overlaps" in p for p in problems))


class LoadTestCase(unittest.TestCase):
    def test_loads_json_text(self):
        doc = tl.load(json.dumps(base_doc()))
        self.assertEqual(doc["width"], 1920)

    def test_rejects_nan_and_infinity_in_json_text(self):
        text = json.dumps(base_doc()).replace('"start_s": 0.5', '"start_s": NaN')
        with self.assertRaises(tl.TimelineError):
            tl.load(text)
        with self.assertRaises(tl.TimelineError):
            tl.load(json.dumps(base_doc()).replace('"out_s": 6.0', '"out_s": Infinity'))

    def test_rejects_malformed_and_oversized_json(self):
        with self.assertRaises(tl.TimelineError) as cm:
            tl.load("{not json")
        self.assertIn("not valid JSON", str(cm.exception))
        with self.assertRaises(tl.TimelineError):
            tl.load(" " * (tl.MAX_DOC_BYTES + 1))
        with self.assertRaises(tl.TimelineError):
            tl.load("[" * 200000)   # RecursionError inside json, not a crash

    def test_audio_clips_are_capped(self):
        d = base_doc()
        d["tracks"][1]["clips"] = [
            {"id": f"m{i}", "asset_id": MU, "start_s": i, "in_s": 0, "out_s": 1}
            for i in range(tl.MAX_AUDIO_CLIPS + 1)]
        self.assertTrue(any("audio clips" in p for p in tl.validate(d)))


class NormaliseTestCase(unittest.TestCase):
    def test_fills_defaults_rounds_times_and_sorts(self):
        d = base_doc()
        d["tracks"][0]["clips"].reverse()
        d["tracks"][0]["clips"][1]["in_s"] = 1.00049
        d["tracks"][0]["clips"][0]["asset_id"] = A2.upper()
        n = tl.load(d)
        v = n["tracks"][0]["clips"]
        self.assertEqual([c["id"] for c in v], ["c1", "c2"])
        self.assertEqual(v[0]["in_s"], 1.0)
        self.assertEqual(v[0]["fit"], "contain")
        self.assertEqual(v[0]["transition"], {"type": "cut", "duration_s": 0.0})
        self.assertEqual(v[1]["asset_id"], A2)
        self.assertEqual(n["tracks"][1]["clips"][0]["fade_in_s"], 0.0)
        self.assertEqual(n["tracks"][2]["clips"][0]["font"], "DejaVu Sans")
        self.assertEqual(n["captions"]["style"]["y"], 0.9)

    def test_is_idempotent_and_order_insensitive(self):
        a = tl.load(base_doc())
        b = copy.deepcopy(base_doc())
        b["tracks"][0]["clips"].reverse()
        b = json.loads(json.dumps(b, sort_keys=True))
        self.assertEqual(tl.load(b), a)
        self.assertEqual(tl.load(a), a)


class InspectTestCase(unittest.TestCase):
    def test_duration_is_the_last_end_on_any_track(self):
        self.assertEqual(tl.duration_s(base_doc()), 6.0)   # the music runs longest
        d = base_doc()
        d["captions"]["cues"][0]["end_s"] = 7.25
        self.assertEqual(tl.duration_s(d), 7.25)

    def test_overlaps_are_found_and_touching_is_not_one(self):
        d = base_doc()
        self.assertEqual(tl.overlaps(d), [])   # c1 ends at 3.0 where c2 starts
        d["tracks"][0]["clips"][0]["out_s"] = 4.5
        self.assertEqual(tl.overlaps(d), [("v1", "c1", "c2", 3.0, 3.5)])

    def test_gaps_in_the_picture_lane(self):
        d = base_doc()
        d["tracks"][0]["clips"][0]["start_s"] = 0.5
        d["tracks"][0]["clips"][0]["out_s"] = 3.0      # c1 0.5-2.5, c2 3.0-5.0, total 6.0
        self.assertEqual(tl.gaps(d), [("v1", 0.0, 0.5), ("v1", 2.5, 3.0), ("v1", 5.0, 6.0)])
        self.assertEqual(tl.gaps(d, "a1"), [])

    def test_dip_to_black_fades_both_sides_of_a_touching_cut(self):
        fades = tl.effective_fades(tl.load(base_doc())["tracks"][0])
        self.assertEqual(fades, {"c1": (0.0, 0.25), "c2": (0.25, 0.0)})


class SplitTestCase(unittest.TestCase):
    def test_split_keeps_length_and_continues_the_source(self):
        d = base_doc()
        d["tracks"][0]["clips"][0]["fade_in_s"] = 0.2
        d["tracks"][0]["clips"][0]["fade_out_s"] = 0.3
        out = tl.split_clip(d, "c1", 1.2, "c1b")
        self.assertEqual(tl.validate(out), [])
        first, second = out["tracks"][0]["clips"][:2]
        self.assertEqual((first["start_s"], first["in_s"], first["out_s"]), (0, 1.0, 2.2))
        self.assertEqual((second["id"], second["start_s"], second["in_s"], second["out_s"]),
                         ("c1b", 1.2, 2.2, 4.0))
        self.assertEqual((first["fade_in_s"], first["fade_out_s"]), (0.2, 0.0))
        self.assertEqual((second["fade_in_s"], second["fade_out_s"]), (0.0, 0.3))
        self.assertEqual(tl.duration_s(out), tl.duration_s(d))
        self.assertEqual(d["tracks"][0]["clips"][0]["out_s"], 4.0)   # input untouched

    def test_split_refuses_outside_the_clip_and_text(self):
        with self.assertRaises(tl.TimelineError):
            tl.split_clip(base_doc(), "c1", 3.0, "x")
        with self.assertRaises(tl.TimelineError):
            tl.split_clip(base_doc(), "title", 1.0, "x")
        with self.assertRaises(tl.TimelineError):
            tl.split_clip(base_doc(), "nope", 1.0, "x")


class PresetTestCase(unittest.TestCase):
    def test_presets(self):
        self.assertEqual({k: (tl.new_timeline(k)["width"], tl.new_timeline(k)["height"])
                          for k in ("9:16", "16:9", "1:1")},
                         {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080)})
        with self.assertRaises(tl.TimelineError):
            tl.new_timeline("4:3")
        with self.assertRaises(tl.TimelineError):
            tl.new_timeline("9:16", fps=29)


class ResolveAssetsTestCase(unittest.TestCase):
    def test_resolves_each_asset_once_in_sorted_order(self):
        seen = []

        def spy(aid):
            seen.append(aid)
            return resolver()(aid)

        d = tl.load(base_doc())
        d["tracks"][0]["clips"][1]["asset_id"] = A1   # A1 used twice
        tl.resolve_assets(d, spy)
        self.assertEqual(seen, sorted({A1, MU}))

    def test_unknown_or_other_org_asset_is_refused(self):
        # The resolver answers None for "does not exist" and "not yours" alike;
        # the message must not say which.
        d = tl.load(base_doc())
        only_music = {MU: resolver()(MU)}.get
        with self.assertRaises(tl.TimelineError) as cm:
            tl.resolve_assets(d, only_music)
        msg = str(cm.exception)
        self.assertIn(f"asset {A1} is not available", msg)
        self.assertIn(f"asset {A2} is not available", msg)

    def test_wrong_kind_on_a_track_is_refused(self):
        d = tl.load(base_doc())
        swapped = resolver({MU: tl.ResolvedAsset(MU, "video", "/m/x.mp4", 60.0)})
        with self.assertRaises(tl.TimelineError) as cm:
            tl.resolve_assets(d, swapped)
        self.assertIn("a A track takes audio", str(cm.exception))

    def test_clip_past_the_end_of_its_source_is_refused(self):
        d = tl.load(base_doc())
        short = resolver({A1: tl.ResolvedAsset(A1, "video", "/m/a1.mp4", 3.5)})
        with self.assertRaises(tl.TimelineError) as cm:
            tl.resolve_assets(d, short)
        self.assertIn("past the end of asset", str(cm.exception))

    def test_non_local_or_control_character_paths_are_refused(self):
        d = tl.load(base_doc())
        for bad in ("http://evil.example/a.mp4", "concat:/a|/b", "rel/a.mp4",
                    "/m/a.mp4'\nfile '/etc/passwd", ""):
            with self.subTest(path=bad):
                r = resolver({A1: tl.ResolvedAsset(A1, "video", bad, 10.0)})
                with self.assertRaises(tl.TimelineError) as cm:
                    tl.resolve_assets(d, r)
                self.assertIn("no local file", str(cm.exception))

    def test_resolver_failure_is_not_reported_as_a_bad_timeline(self):
        def down(_aid):
            raise ConnectionError("database unavailable")

        with self.assertRaises(ConnectionError):
            tl.resolve_assets(tl.load(base_doc()), down)


class SchemaTwinTestCase(unittest.TestCase):
    def setUp(self):
        self.schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))

    def test_schema_and_validator_agree_on_fields_and_enums(self):
        s, defs = self.schema, self.schema["$defs"]
        self.assertEqual(tuple(s["required"]), tl._DOC_REQUIRED)
        self.assertEqual(set(s["properties"]), set(tl._DOC_KEYS))
        self.assertEqual(s["properties"]["version"]["const"], tl.VERSION)
        self.assertEqual(s["properties"]["fps"]["enum"], list(tl.FPS_VALUES))
        for name, keys in (("video_clip", tl._V_CLIP_KEYS), ("audio_clip", tl._A_CLIP_KEYS),
                           ("text_clip", tl._T_CLIP_KEYS), ("cue", tl._CUE_KEYS),
                           ("transition", tl._TRANSITION_KEYS)):
            self.assertEqual(set(defs[name]["properties"]), set(keys), name)
        for name in ("video_track", "audio_track", "text_track"):
            self.assertEqual(set(defs[name]["properties"]), set(tl._TRACK_KEYS))
            self.assertEqual(tuple(defs[name]["required"]), tl._TRACK_REQUIRED)
        self.assertEqual(set(defs["captions"]["properties"]["style"]["properties"]),
                         set(tl._CAPTION_STYLE_KEYS))
        for name, req in (("video_clip", tl._MEDIA_REQUIRED), ("audio_clip", tl._MEDIA_REQUIRED),
                          ("text_clip", tl._T_REQUIRED), ("cue", tl._CUE_KEYS)):
            self.assertEqual(tuple(defs[name]["required"]), req, name)
        self.assertEqual(defs["video_clip"]["properties"]["fit"]["enum"], list(tl.FITS))
        self.assertEqual(defs["transition"]["properties"]["type"]["enum"], list(tl.TRANSITIONS))
        self.assertEqual(defs["text_clip"]["properties"]["anchor"]["enum"], list(tl.ANCHORS))
        self.assertEqual(defs["text_clip"]["properties"]["font"]["enum"], list(tl.FONTS))
        self.assertEqual(defs["asset_id"]["pattern"], tl._UUID_RE.pattern)

    def test_documents_agree_with_json_schema_when_available(self):
        try:
            import jsonschema
        except ImportError:
            self.skipTest("jsonschema not installed (not a project dependency)")
        jsonschema.validate(base_doc(), self.schema)
        jsonschema.validate(tl.load(base_doc()), self.schema)   # normalised form too
        bad = base_doc()
        bad["tracks"][0]["clips"][0]["path"] = "/etc/passwd"
        with self.assertRaises(jsonschema.ValidationError):
            jsonschema.validate(bad, self.schema)


if __name__ == "__main__":
    unittest.main()
