"""Export presets (modules/export_presets.py, schemas/export_presets.json).

A preset is a label's worth of parameters (frame size, rate, recommended
length) from a CLOSED list. These tests pin what makes that safe:

* the list in the data file is the list the Command Center shows, and every
  entry sits inside the limits it must never exceed (even sides, 1440p, the
  fps list, the export's 1800 s cap, the decode budget);
* a bad data file fails on load, naming the rule, and an unknown preset id is
  refused whatever it looks like;
* applying a preset only writes width / height / fps, and the document then
  goes through the ordinary timeline validator and the ordinary render
  commands with the same hardening flags on every input.
"""

import copy
import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import editor_export, export_presets as ep, ffmpeg_limits
from modules import media_library as ml
from modules import timeline as tl
from modules import timeline_render as tr
from tests.test_timeline_render import ASSETS, full_argv, golden_doc

EXPECTED_IDS = ["youtube_1080p", "youtube_720p", "vertical_1080p", "square_1080", "feed_4x5_1080"]


def entry(**over):
    e = {"id": "demo", "width": 1080, "height": 1350, "fps": 30, "max_duration_s": 600}
    e.update(over)
    return e


def write_presets(tmp, presets, **top):
    path = Path(tmp) / "presets.json"
    data = {"version": 1, "presets": presets}
    data.update(top)
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


class TheListTestCase(unittest.TestCase):
    def test_the_closed_list_is_exactly_these_ids_in_this_order(self):
        # The picker order. Adding or removing one is a product decision, so it fails here first.
        self.assertEqual(list(ep.load()), EXPECTED_IDS)

    def test_the_three_existing_frame_sizes_are_still_offered_and_4_by_5_is_new(self):
        frames = {(p.width, p.height) for p in ep.load().values()}
        for size in tl.PRESETS.values():
            self.assertIn(size, frames)
        self.assertIn((1080, 1350), frames)

    def test_every_preset_stays_inside_the_limits_it_must_never_exceed(self):
        for p in ep.load().values():
            with self.subTest(p.id):
                self.assertEqual((p.width % 2, p.height % 2), (0, 0))      # H.264 4:2:0
                self.assertGreaterEqual(min(p.width, p.height), tl.MIN_SIDE)
                self.assertLessEqual(max(p.width, p.height), tl.MAX_SIDE)
                self.assertLessEqual(p.width * p.height, 2560 * 1440)      # never the large-frame regime
                self.assertLessEqual(p.width * p.height, ffmpeg_limits.LARGE_OUTPUT_PX)
                self.assertLessEqual(p.width * p.height, tl.MAX_FRAME_PIXELS)
                self.assertIn(p.fps, tl.FPS_VALUES)
                self.assertGreater(p.max_duration_s, 0)
                self.assertLessEqual(p.max_duration_s, 1800.0)             # the export's own cap
                self.assertLessEqual(p.max_duration_s, editor_export.EXPORT_MAX_S)
                self.assertLessEqual(ml.decode_work(p.width, p.height, p.fps, p.max_duration_s),
                                     ml.DECODE_BUDGET_PX)

    def test_no_two_presets_are_the_same_frame_at_the_same_rate(self):
        # The picker tells them apart by the document's frame, so they must differ.
        keys = [(p.width, p.height, p.fps) for p in ep.load().values()]
        self.assertEqual(len(keys), len(set(keys)))

    def test_the_export_limit_the_caps_are_held_to_is_the_databases(self):
        self.assertEqual(editor_export.EXPORT_MAX_S, 1800.0)


class BadDataTestCase(unittest.TestCase):
    def refused(self, **over):
        with self.assertRaises(ep.PresetDataError) as cm:
            ep.parse_preset(entry(**over))
        return str(cm.exception)

    def test_a_frame_the_encoder_or_the_memory_guards_cannot_take_is_refused(self):
        self.assertIn("even", self.refused(width=1081))
        self.assertIn("even", self.refused(height=1351))
        self.assertIn("even", self.refused(width=8))                  # under MIN_SIDE
        self.assertIn("even", self.refused(height=tl.MAX_SIDE + 2))
        self.assertIn("1440p", self.refused(width=3840, height=2160))  # 4K needs the large-frame guards
        self.assertIn("1440p", self.refused(width=2560, height=1442))  # one row over the line
        # Exactly 1440p is the largest frame a preset may be.
        self.assertEqual(ep.parse_preset(entry(width=2560, height=1440)).width, 2560)

    def test_a_rate_that_is_not_on_the_documents_list_is_refused(self):
        self.assertIn("fps", self.refused(fps=45))
        self.assertIn("fps", self.refused(fps=0))
        self.assertIn("fps", self.refused(fps=30.0))
        self.assertIn("fps", self.refused(fps=True))
        self.assertEqual(ep.parse_preset(entry(fps=60)).fps, 60)

    def test_a_length_past_the_exports_cap_or_not_a_number_is_refused(self):
        self.assertIn("1800", self.refused(max_duration_s=1801))
        for bad in (0, -5, math.nan, math.inf, "600", None, True):
            self.assertIn("max_duration_s", self.refused(max_duration_s=bad), bad)
        self.assertEqual(ep.parse_preset(entry(max_duration_s=1800)).max_duration_s, 1800.0)

    def test_sizes_must_be_whole_numbers(self):
        for bad in (1080.0, "1080", None, True):
            self.assertIn("even", self.refused(width=bad), bad)

    def test_ids_are_a_short_lowercase_word(self):
        for bad in ("", "Square", "has space", "dash-ed", "x" * 33, "../etc", None, 5):
            self.assertIn("id must", self.refused(id=bad), bad)

    def test_unknown_or_missing_keys_are_refused(self):
        self.assertIn("keys", self.refused(extra=1))
        e = entry()
        del e["fps"]
        with self.assertRaises(ep.PresetDataError):
            ep.parse_preset(e)
        with self.assertRaises(ep.PresetDataError):
            ep.parse_preset("youtube")

    def test_a_length_that_passes_the_library_decode_budget_is_refused(self):
        with mock.patch.object(ml, "DECODE_BUDGET_PX", 1e9):
            self.assertIn("decode budget", self.refused())


class LoadTestCase(unittest.TestCase):
    def load(self, presets, **top):
        with tempfile.TemporaryDirectory() as tmp:
            return ep.load(write_presets(tmp, presets, **top))

    def refused(self, presets, **top):
        with self.assertRaises(ep.PresetDataError) as cm:
            self.load(presets, **top)
        return str(cm.exception)

    def test_a_valid_file_loads_in_file_order(self):
        got = self.load([entry(id="b"), entry(id="a", width=1080, height=1080)])
        self.assertEqual(list(got), ["b", "a"])

    def test_duplicates_empty_lists_and_the_wrong_version_are_refused(self):
        self.assertIn("duplicate", self.refused([entry(), entry(width=1080, height=1080)]))
        self.assertIn("repeats", self.refused([entry(id="a"), entry(id="b")]))
        self.assertIn("non-empty", self.refused([]))
        self.assertIn("version", self.refused([entry()], version=2))
        self.assertIn("version", self.refused([entry()], extra=True))

    def test_a_file_that_is_missing_or_not_json_is_a_data_error_not_a_crash(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ep.PresetDataError):
                ep.load(Path(tmp) / "nope.json")
            bad = Path(tmp) / "bad.json"
            bad.write_text("{not json", encoding="utf-8")
            with self.assertRaises(ep.PresetDataError):
                ep.load(bad)
            bad.write_text("[]", encoding="utf-8")
            with self.assertRaises(ep.PresetDataError):
                ep.load(bad)


class ClosedSetTestCase(unittest.TestCase):
    def test_every_listed_id_resolves(self):
        for pid in EXPECTED_IDS:
            self.assertEqual(ep.get(pid).id, pid)

    def test_anything_else_is_refused_however_close_it_looks(self):
        for bad in ("", "unknown", "YOUTUBE_1080P", "youtube_1080p ", " youtube_1080p", "youtube_1080p\n",
                    "youtube_4k", "9:16", "vertical", None, 5, 1.5, True, [], ["youtube_1080p"], {}, b"square_1080"):
            with self.subTest(bad=bad):
                with self.assertRaises(ep.UnknownPreset):
                    ep.get(bad)
                with self.assertRaises(ep.UnknownPreset):
                    ep.apply(golden_doc(), bad)
                with self.assertRaises(ep.UnknownPreset):
                    ep.problems(golden_doc(), bad)

    def test_a_table_passed_in_is_the_whole_set(self):
        table = {"only": ep.parse_preset(entry(id="only"))}
        self.assertEqual(ep.get("only", table).id, "only")
        with self.assertRaises(ep.UnknownPreset):
            ep.get("youtube_1080p", table)


class ApplyTestCase(unittest.TestCase):
    def test_a_preset_writes_the_frame_and_the_rate_and_nothing_else(self):
        doc = golden_doc()
        before = copy.deepcopy(doc)
        for p in ep.load().values():
            out = ep.apply(doc, p.id)
            self.assertEqual((out["width"], out["height"], out["fps"]), (p.width, p.height, p.fps))
            rest = {k: v for k, v in out.items() if k not in ("width", "height", "fps")}
            self.assertEqual(rest, {k: v for k, v in doc.items() if k not in ("width", "height", "fps")})
        self.assertEqual(doc, before)        # the caller's document is never edited

    def test_the_applied_copy_shares_no_structure_with_the_original(self):
        doc = golden_doc()
        out = ep.apply(doc, "square_1080")
        out["tracks"][0]["clips"][0]["id"] = "changed"
        self.assertEqual(doc["tracks"][0]["clips"][0]["id"], "c1")

    def test_a_valid_document_stays_valid_at_every_preset(self):
        for p in ep.load().values():
            with self.subTest(p.id):
                self.assertEqual(ep.problems(golden_doc(), p.id), [])
                tl.load(ep.apply(golden_doc(), p.id))     # and loads (normalises) like any document

    def test_a_preset_does_not_excuse_an_invalid_document(self):
        bad = golden_doc()
        bad["tracks"][0]["clips"][0]["out_s"] = 1.0       # before its in_s
        for p in ep.load().values():
            self.assertTrue(ep.problems(bad, p.id), p.id)
        worse = golden_doc()
        worse["tracks"][0]["clips"][0]["speed"] = 99
        self.assertTrue(any("speed" in s for s in ep.problems(worse, "vertical_1080p")))

    def test_the_validator_judges_the_frame_and_rate_the_preset_sets(self):
        # Interpolated slow motion is budgeted in frames at the OUTPUT's rate and size: the same
        # clip passes at 30 fps and is refused at 60, and the preset's rate is the one judged.
        doc = golden_doc(width=1920, height=1080)
        clip = doc["tracks"][0]["clips"][0]
        clip.update({"in_s": 0.0, "out_s": 4.0, "speed": 0.5, "interpolate": True})
        doc["tracks"][0]["clips"] = [clip]
        table = {"p30": ep.parse_preset(entry(id="p30", width=1920, height=1080, fps=30)),
                 "p60": ep.parse_preset(entry(id="p60", width=1920, height=1080, fps=60))}
        self.assertEqual(ep.problems(doc, "p30", table), [])
        self.assertTrue(any("interpolating" in s for s in ep.problems(doc, "p60", table)))
        # The same document, judged as its own frame at 60 fps, gives the same answer.
        doc60 = copy.deepcopy(doc)
        doc60["fps"] = 60
        self.assertEqual(ep.problems(doc, "p60", table), tl.validate(doc60))


class PresetOfTestCase(unittest.TestCase):
    def test_a_documents_preset_is_the_one_its_frame_and_rate_are_exactly(self):
        for p in ep.load().values():
            doc = ep.apply(golden_doc(), p.id)
            self.assertEqual(ep.preset_of(doc).id, p.id)

    def test_a_custom_size_or_rate_matches_none(self):
        doc = golden_doc(width=1280, height=1000)
        self.assertIsNone(ep.preset_of(doc))
        doc = ep.apply(golden_doc(), "square_1080")
        doc["fps"] = 60
        self.assertIsNone(ep.preset_of(doc))
        self.assertIsNone(ep.preset_of({}))

    def test_the_length_advice_is_a_boundary_not_a_refusal(self):
        v = ep.get("vertical_1080p")
        self.assertFalse(ep.long_for(v.max_duration_s, v))
        self.assertTrue(ep.long_for(v.max_duration_s + 0.001, v))
        # A vertical project over its advice still passes every timeline rule: advice never blocks an export.
        long_doc = golden_doc(width=1080, height=1920)
        long_doc["tracks"][0]["clips"][0]["out_s"] = 12.0
        self.assertEqual(ep.problems(long_doc, "vertical_1080p"), tl.validate(long_doc))


class SameRenderPathTestCase(unittest.TestCase):
    """The preset adds no render path: its document lays out and renders as any
    document does, with the hardening flags the export path always has."""

    def commands(self, doc):
        spec = tr.to_render_spec(doc, ASSETS.get, "/o.mp4")
        argv = full_argv(spec)
        return [c for group in argv["segments"] for c in group] + [argv["final"]], spec

    def test_every_input_of_every_command_is_capped_and_file_only(self):
        for p in ep.load().values():
            cmds, _ = self.commands(ep.apply(golden_doc(), p.id))
            for cmd in cmds:
                self.assertIn("-filter_threads", cmd)
                for i, tok in enumerate(cmd):
                    if tok == "-i":
                        before = cmd[max(0, i - 8):i]
                        for flag in ("-max_pixels", "-protocol_whitelist", "-threads"):
                            self.assertIn(flag, before, (p.id, cmd[i + 1]))
                        self.assertEqual(before[before.index("-protocol_whitelist") + 1], "file")

    def test_the_frame_in_the_commands_is_the_presets(self):
        for p in ep.load().values():
            cmds, spec = self.commands(ep.apply(golden_doc(), p.id))
            self.assertEqual((spec.width, spec.height, spec.fps), (p.width, p.height, p.fps))
            text = " ".join(" ".join(c) for c in cmds)
            self.assertIn(f"{p.width}:{p.height}", text)

    def test_a_preset_document_renders_the_commands_an_equal_hand_made_document_does(self):
        for p in ep.load().values():
            by_preset, _ = self.commands(ep.apply(golden_doc(), p.id))
            by_hand, _ = self.commands(golden_doc(width=p.width, height=p.height))
            self.assertEqual(by_preset, by_hand, p.id)

    def test_the_module_builds_no_command_and_runs_nothing(self):
        for name in ("subprocess", "render_backend", "timeline_render", "os", "shutil"):
            self.assertFalse(hasattr(ep, name), name)


if __name__ == "__main__":
    unittest.main()
