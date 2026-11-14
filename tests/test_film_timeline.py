"""Film Studio P4a (modules/film_timeline.py): a film's takes → the editor's timeline document.

What would break if these failed: a film assembled out of order, longer than what was priced, with
a scene quietly missing or a still in its place, a different cut hashed the same as an approved one,
captions under a phone player's buttons, narration that runs into the next scene, or a 60-scene film
the editor cannot lay out."""

import copy
import hashlib
import json
import random
import unittest

from modules import film_timeline as ft
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr


def _uuid(n: int, kind: int = 1) -> str:
    return f"{kind:08x}-0000-4000-8000-{n:012x}"


NARRATION = _uuid(1, 0xA)
MUSIC = _uuid(2, 0xA)


class Film:
    """A film fixture: scenes of shots, every take completed, every asset probed."""

    def __init__(self, scenes=3, seconds=10, shots=2, shot_s=8.0, aspect="16:9", resolution="1080p",
                 transition="crossfade", narration=True, music_s=240.0, captions="burn", clock="scene"):
        self.film = {"id": _uuid(1, 0xF), "aspect": aspect, "resolution": resolution,
                     "transition_default": transition, "captions_mode": captions,
                     "music_asset_id": MUSIC if music_s else None, "music_gain_db": None, "duck_db": None}
        w, h = ft.frame_for(aspect, resolution)
        self.scenes, self.takes, self.assets = [], [], {}
        self.segments, self.cues, self.loudness = [], [], {}
        at = 0.0
        for i in range(scenes):
            sid = _uuid(100 + i, 0x5)
            self.scenes.append({"id": sid, "position": i, "planned_seconds": seconds, "shot_count": shots,
                                "first_frame": "keyframe", "transition_in": None, "current_version": 1,
                                "narration": f"Scene {i + 1} says something." if narration else ""})
            prev_last = None
            for k in range(1, shots + 1):
                tid, res, last = _uuid(1000 + i * 10 + k, 0x7), _uuid(2000 + i * 10 + k, 0xB), _uuid(3000 + i * 10 + k, 0xC)
                self.takes.append({"id": tid, "scene_id": sid, "kind": "clip" if k == 1 else "extend",
                                   "shot_index": k, "version": 1, "attempt": 1, "status": "completed",
                                   "result_asset_id": res, "result_last_frame_asset_id": last,
                                   "first_frame_asset_id": prev_last if k > 1 else _uuid(4000 + i, 0xD),
                                   "error_code": None})
                self.assets[res] = {"kind": "video", "duration_s": shot_s, "width": w, "height": h}
                prev_last = last
            if narration:
                n = seconds - 1.0
                if clock == "film":     # the take laid out on the film's clock: words start where the scene's do
                    at = i * seconds + ft.NARRATION_LEAD_S
                self.segments.append({"scene_id": sid, "start_s": round(at, 3), "end_s": round(at + n, 3)})
                c = at
                while c + 0.5 < at + n:
                    e = min(c + 2.5, at + n)
                    self.cues.append({"start_s": round(c, 3), "end_s": round(e, 3), "text": "The river keeps its time"})
                    c = e
                at += n
        if narration:
            self.assets[NARRATION] = {"kind": "audio", "duration_s": round(max(at + 1.0, scenes * seconds), 3)}
        if music_s:
            self.assets[MUSIC] = {"kind": "audio", "duration_s": music_s}

    def take(self, scene: int, shot: int) -> dict:
        sid = self.scenes[scene]["id"]
        return next(t for t in self.takes if t["scene_id"] == sid and t["shot_index"] == shot)

    def build(self, **kw):
        narration = {"asset_id": NARRATION, "segments": self.segments, **self.loudness} if self.segments else None
        return ft.build_cut(self.film, self.scenes, self.takes, self.assets, narration, self.cues or None, **kw)


def v_clips(cut):
    return next(t for t in cut.doc["tracks"] if t["kind"] == "V")["clips"]


def a_track(cut, tid):
    return next((t for t in cut.doc["tracks"] if t["id"] == tid), None)


def refused(test, f: Film, reason: str, scene=None):
    with test.assertRaises(ft.FilmTimelineRefused) as cm:
        f.build()
    test.assertEqual(cm.exception.reason, reason, cm.exception.detail)
    if scene is not None:
        test.assertEqual(cm.exception.scene, scene)
    return cm.exception


class Ordering(unittest.TestCase):
    def test_scenes_follow_position_not_list_order(self):
        f = Film(scenes=4, transition="cut")
        for i, sc in enumerate(f.scenes):
            sc["position"] = [30, 10, 20, 0][i]
        random.Random(3).shuffle(f.scenes)
        cut = f.build()
        by_pos = sorted(f.scenes, key=lambda s: s["position"])
        self.assertEqual([p["scene_id"] for p in cut.plan["scenes"]], [s["id"] for s in by_pos])
        starts = [c["start_s"] for c in v_clips(cut)]
        self.assertEqual(starts, sorted(starts))

    def test_shots_follow_shot_index_whatever_order_the_takes_arrive_in(self):
        f = Film(scenes=1, shots=3, seconds=20)
        f.takes.reverse()
        cut = f.build()
        self.assertEqual([s["shot_index"] for s in cut.plan["scenes"][0]["shots"]], [1, 2, 3])

    def test_the_highest_completed_attempt_is_the_take_used(self):
        f = Film(scenes=1, shots=1, shot_s=12.0)
        retry = dict(f.take(0, 1), id=_uuid(9, 0x7), attempt=2, result_asset_id=_uuid(9, 0xB))
        f.assets[retry["result_asset_id"]] = dict(f.assets[f.take(0, 1)["result_asset_id"]])
        f.takes.append(retry)
        self.assertEqual(f.build().plan["scenes"][0]["shots"][0]["take_id"], retry["id"])

    def test_duplicate_positions_are_refused(self):
        f = Film(scenes=2)
        f.scenes[1]["position"] = 0
        refused(self, f, "invalid_scene")


class Trimming(unittest.TestCase):
    def test_the_film_lasts_exactly_the_planned_seconds(self):
        cut = Film(scenes=5, seconds=10, transition="crossfade").build()
        self.assertEqual(cut.length_s, 50.0)
        self.assertEqual(tl.duration_s(tl.load(cut.doc)), 50.0)

    def test_the_last_shot_used_is_trimmed_and_chained_shots_skip_the_shared_frame(self):
        cut = Film(scenes=1, seconds=10, shots=2, shot_s=8.0).build()
        a, b = v_clips(cut)
        self.assertEqual((a["start_s"], a["in_s"], a["out_s"]), (0.0, 0.0, 8.0))
        self.assertEqual(b["in_s"], ft.CHAIN_SKIP_S)
        self.assertAlmostEqual(b["start_s"] + b["out_s"] - b["in_s"], 10.0, places=3)

    def test_a_shot_the_scene_does_not_reach_is_listed_unused(self):
        f = Film(scenes=1, seconds=7, shots=3, shot_s=8.0)
        plan = f.build().plan["scenes"][0]
        self.assertEqual(len(plan["shots"]), 1)
        self.assertEqual(plan["unused_take_ids"], [f.take(0, 2)["id"], f.take(0, 3)["id"]])

    def test_a_cross_fade_out_never_rides_on_a_sliver(self):
        # 8.5 s + 8 s for 9 s: the second shot would show 0.5 s, less than the way out needs. The window
        # moves 0.5 s later into the first shot instead, so the last piece is MIN_PIECE_S.
        f = Film(scenes=2, seconds=9, shots=2, shot_s=8.0, narration=False, captions="none")
        f.assets[f.take(0, 1)["result_asset_id"]]["duration_s"] = 8.5
        cut = f.build()
        a, b = [c for c in v_clips(cut) if c["id"].startswith("v01")]
        self.assertEqual((a["in_s"], a["out_s"]), (0.5, 8.5))
        self.assertAlmostEqual(b["out_s"] - b["in_s"], ft.MIN_PIECE_S, places=3)
        self.assertEqual(cut.plan["scenes"][0]["trimmed_head_s"], 0.5)

    def test_a_sliver_after_a_seamless_cut_is_kept(self):
        # The last scene leads nowhere, and shots chain by last frame: a short last piece continues the motion.
        f = Film(scenes=1, seconds=9, shots=2, shot_s=8.0, narration=False, captions="none")
        f.assets[f.take(0, 1)["result_asset_id"]]["duration_s"] = 8.5
        a, b = v_clips(f.build())
        self.assertEqual(a["in_s"], 0.0)
        self.assertAlmostEqual(b["out_s"] - b["in_s"], 0.5, places=3)

    def test_a_crossfade_comes_out_of_the_incoming_scenes_footage(self):
        cut = Film(scenes=2, seconds=10, transition="crossfade").build()
        second = [c for c in v_clips(cut) if c["id"].startswith("v02")][0]
        self.assertEqual(second["start_s"], 10.0 - ft.CROSSFADE_S)
        self.assertEqual(second["transition"], {"type": "crossfade", "duration_s": ft.CROSSFADE_S})
        self.assertEqual(cut.length_s, 20.0)

    def test_too_little_footage_is_refused_not_stretched(self):
        f = Film(scenes=2, seconds=10, shots=1, shot_s=10.0, transition="crossfade")
        e = refused(self, f, "scene_too_short", scene=2)   # scene 1 has no incoming cross-fade: 10 s is enough
        self.assertIn("extend", e.detail)


class Continuity(unittest.TestCase):
    def test_a_scene_that_continues_the_previous_one_is_a_cut(self):
        f = Film(scenes=2, transition="crossfade")
        f.scenes[1]["first_frame"] = "previous"
        f.take(1, 1)["first_frame_asset_id"] = f.take(0, 2)["result_last_frame_asset_id"]
        cut = f.build()
        self.assertEqual(cut.plan["scenes"][1]["transition_in"], "cut")
        first = [c for c in v_clips(cut) if c["id"] == "v02_1"][0]
        self.assertNotIn("transition", first)
        self.assertEqual(first["in_s"], ft.CHAIN_SKIP_S)

    def test_a_scene_continued_by_the_next_keeps_its_last_frame(self):
        f = Film(scenes=2, seconds=10, shots=2, shot_s=8.0)
        f.scenes[1]["first_frame"] = "previous"
        f.take(1, 1)["first_frame_asset_id"] = f.take(0, 2)["result_last_frame_asset_id"]
        cut = f.build()
        last = [c for c in v_clips(cut) if c["id"].startswith("v01")][-1]
        self.assertEqual(last["out_s"], 8.0)                          # shot 2 to its very end
        self.assertGreater(cut.plan["scenes"][0]["trimmed_head_s"], 0)
        self.assertEqual(cut.plan["scenes"][0]["trimmed_tail_s"], 0.0)

    def test_a_scene_held_at_both_seams_cannot_be_trimmed_and_is_refused(self):
        f = Film(scenes=3, seconds=10, shots=2, shot_s=8.0)
        for k in (1, 2):
            f.scenes[k]["first_frame"] = "previous"
            f.take(k, 1)["first_frame_asset_id"] = f.take(k - 1, 2)["result_last_frame_asset_id"]
        refused(self, f, "continuity_trim", scene=2)

    def test_a_re_shot_predecessor_breaks_continuity_and_is_refused(self):
        f = Film(scenes=1, shots=2)
        f.take(0, 2)["first_frame_asset_id"] = _uuid(777, 0xC)
        refused(self, f, "continuity_broken", scene=1)

    def test_a_continued_scene_whose_previous_scene_changed_is_refused(self):
        f = Film(scenes=2)
        f.scenes[1]["first_frame"] = "previous"
        refused(self, f, "continuity_broken", scene=2)


class Refusals(unittest.TestCase):
    def test_a_missing_take_refuses_and_names_the_scene_and_shot(self):
        f = Film(scenes=3, shots=2)
        f.takes.remove(f.take(1, 2))
        e = refused(self, f, "missing_take", scene=2)
        self.assertIn("shot 2", e.detail)

    def test_a_failed_take_refuses_with_its_error(self):
        f = Film(scenes=2)
        t = f.take(1, 1)
        t["status"], t["error_code"] = "failed", "vendor_refused_prompt"
        e = refused(self, f, "take_failed", scene=2)
        self.assertIn("vendor_refused_prompt", e.detail)

    def test_a_take_still_running_is_missing_not_skipped(self):
        f = Film(scenes=2)
        f.take(0, 1)["status"] = "running"
        refused(self, f, "missing_take", scene=1)

    def test_a_scene_never_shot_is_refused(self):
        f = Film(scenes=2)
        f.scenes[0]["current_version"] = None
        refused(self, f, "scene_not_shot", scene=1)

    def test_a_deleted_clip_is_refused_not_replaced(self):
        f = Film(scenes=2)
        del f.assets[f.take(1, 2)["result_asset_id"]]
        refused(self, f, "asset_unavailable", scene=2)

    def test_a_still_is_never_accepted_as_a_shot(self):
        f = Film(scenes=1)
        f.assets[f.take(0, 1)["result_asset_id"]]["kind"] = "image"
        refused(self, f, "asset_not_video", scene=1)

    def test_a_clip_of_another_aspect_is_refused_instead_of_cropped(self):
        f = Film(scenes=1, aspect="9:16")
        f.assets[f.take(0, 1)["result_asset_id"]].update(width=1920, height=1080)
        refused(self, f, "aspect_mismatch", scene=1)

    def test_an_unprobed_clip_is_refused(self):
        f = Film(scenes=1)
        f.assets[f.take(0, 1)["result_asset_id"]]["duration_s"] = None
        refused(self, f, "asset_unprobed", scene=1)

    def test_no_scene_is_ever_dropped(self):
        # Every way a take can be unusable refuses the whole film: nothing renders with a scene left out.
        for status in ("planned", "queued", "running", "failed", "skipped", "superseded"):
            f = Film(scenes=3)
            f.take(2, 1)["status"] = status
            with self.assertRaises(ft.FilmTimelineRefused):
                f.build()

    def test_ten_minutes_the_longest_assembly_measured_at_1080p_is_accepted(self):
        self.assertEqual(ft.MAX_FILM_S, 600.0)
        cut = Film(scenes=20, seconds=30, shots=3, shot_s=11.0, narration=False, captions="none").build()
        self.assertEqual(cut.length_s, 600.0)

    def test_a_film_longer_than_the_limit_is_refused(self):
        f = Film(scenes=21, seconds=30, shots=3, shot_s=11.0, narration=False, captions="none")
        refused(self, f, "film_too_long")


class Deterministic(unittest.TestCase):
    def test_the_same_film_gives_the_same_document_and_hash(self):
        a, b = Film(scenes=6).build(), Film(scenes=6).build()
        self.assertEqual(ft.canonical_json(a.doc), ft.canonical_json(b.doc))
        self.assertEqual(a.sha256, b.sha256)

    def test_input_order_does_not_change_the_hash(self):
        base = Film(scenes=6).build().sha256
        f = Film(scenes=6)
        rnd = random.Random(11)
        rnd.shuffle(f.scenes)
        rnd.shuffle(f.takes)
        rnd.shuffle(f.segments)
        rnd.shuffle(f.cues)
        f.assets = dict(reversed(list(f.assets.items())))
        self.assertEqual(f.build().sha256, base)

    def test_the_hash_is_sha256_of_the_canonical_document(self):
        cut = Film(scenes=2).build()
        want = hashlib.sha256(json.dumps({"format": ft.FORMAT_VERSION, "doc": cut.doc}, sort_keys=True,
                                         separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        self.assertEqual(cut.sha256, want)

    def test_any_change_to_the_cut_changes_the_hash(self):
        base = Film(scenes=3).build().sha256
        f = Film(scenes=3)
        f.scenes[1]["planned_seconds"] = 11
        self.assertNotEqual(f.build().sha256, base)
        f = Film(scenes=3)
        new = _uuid(5555, 0xB)
        f.assets[new] = dict(f.assets[f.take(2, 1)["result_asset_id"]])
        f.take(2, 1)["result_asset_id"] = new     # a re-shot take, same length
        self.assertNotEqual(f.build().sha256, base)

    def test_the_input_is_not_modified(self):
        f = Film(scenes=3)
        before = copy.deepcopy((f.film, f.scenes, f.takes, f.assets, f.segments, f.cues))
        f.build()
        self.assertEqual(before, (f.film, f.scenes, f.takes, f.assets, f.segments, f.cues))


class Captions(unittest.TestCase):
    def test_vertical_captions_sit_above_the_bottom_fifth(self):
        cut = Film(scenes=2, aspect="9:16").build()
        style = cut.doc["captions"]["style"]
        self.assertLessEqual(style["y"], 0.80)
        self.assertEqual(style["y"], ft.SAFE_AREAS["9:16"]["bottom"])
        wide = Film(scenes=2, aspect="16:9").build().doc["captions"]["style"]
        self.assertEqual(wide["y"], ft.SAFE_AREAS["16:9"]["bottom"])
        self.assertGreater(wide["y"], style["y"])

    def test_wrapped_lines_fit_the_safe_width(self):
        for aspect in ("9:16", "16:9", "1:1"):
            w, h = ft.frame_for(aspect, "1080p")
            lay = ft.caption_layout(aspect, w, h)
            f = Film(scenes=1, aspect=aspect)
            f.cues = [{"start_s": 0.0, "end_s": 3.0, "text": "each word has to fit inside the frame"}]
            cue = f.build().doc["captions"]["cues"][0]
            lines = cue["text"].split("\n")
            self.assertLessEqual(len(lines), ft.MAX_CAPTION_LINES)
            for line in lines:
                self.assertLessEqual(len(line) * lay["size"] * ft.GLYPH_W, w * (1 - 2 * lay["side"]) + 1e-6, aspect)

    def test_vertical_wraps_narrower_than_horizontal(self):
        v = ft.caption_layout("9:16", 1080, 1920)["max_chars"]
        h = ft.caption_layout("16:9", 1920, 1080)["max_chars"]
        self.assertLess(v, h)

    def test_a_caption_too_long_for_two_lines_is_refused_not_shrunk(self):
        f = Film(scenes=1, aspect="9:16")
        f.cues = [{"start_s": 0.0, "end_s": 3.0, "text": " ".join(["word"] * 40)}]
        refused(self, f, "caption_too_long")

    def test_cues_move_onto_the_film_clock_with_their_scene(self):
        f = Film(scenes=3, seconds=10)
        cut = f.build()
        # The second scene's narration starts 9 s into the file and is placed at 10 s + the lead.
        cue = next(c for c in cut.doc["captions"]["cues"] if c["start_s"] >= 10.0)
        self.assertEqual(cue["start_s"], 10.0 + ft.NARRATION_LEAD_S)

    def test_a_cue_outside_every_segment_is_refused(self):
        f = Film(scenes=1, seconds=10)
        f.cues.append({"start_s": 50.0, "end_s": 51.0, "text": "nowhere"})
        refused(self, f, "caption_outside_narration")

    def test_sidecar_gives_srt_and_burns_nothing(self):
        cut = Film(scenes=2, captions="sidecar").build()
        self.assertNotIn("captions", cut.doc)
        self.assertTrue(cut.srt.startswith("1\n00:00:00,250 --> "))
        both = Film(scenes=2, captions="both").build()
        self.assertIn("captions", both.doc)
        self.assertEqual(both.srt, cut.srt)
        none = Film(scenes=2, captions="none").build()
        self.assertIsNone(none.srt)
        self.assertNotIn("captions", none.doc)

    def test_captions_asked_for_but_absent_are_refused(self):
        f = Film(scenes=2, captions="burn")
        f.cues = []
        refused(self, f, "captions_missing")


class AudioPlan(unittest.TestCase):
    def test_narration_is_one_speech_clip_per_scene_without_a_per_clip_loudnorm(self):
        # Measured: 32 clips with the editor's loudnorm exhaust the final pass's 2 GiB address space.
        cut = Film(scenes=4, seconds=10).build()
        nar = a_track(cut, "narration")
        self.assertEqual(nar["role"], "speech")
        self.assertEqual(len(nar["clips"]), 4)
        self.assertFalse(any("loudnorm" in c for c in nar["clips"]))
        self.assertEqual([c["start_s"] for c in nar["clips"]], [i * 10 + ft.NARRATION_LEAD_S for i in range(4)])
        self.assertIn("not normalised", cut.plan["audio"]["master_loudness"])

    def test_the_target_is_the_editors_own_loudness(self):
        self.assertIn(f"I={ft.NARRATION_LUFS:g}", rs.LOUDNORM_FILTER)
        self.assertIn(f"TP={ft.NARRATION_TRUE_PEAK_DB:g}", rs.LOUDNORM_FILTER)

    def test_an_unmeasured_narration_says_so_and_gets_no_gain(self):
        cut = Film(scenes=2).build()
        loud = cut.plan["audio"]["narration"]["loudness"]
        self.assertEqual((loud["status"], loud["measured_lufs"], loud["gain_db"]), ("not measured", None, 0.0))
        self.assertFalse(any("gain_db" in c for c in a_track(cut, "narration")["clips"]))

    def test_a_measured_narration_is_brought_to_the_target_by_one_gain(self):
        f = Film(scenes=3)
        f.loudness = {"loudness_lufs": -20.0, "true_peak_db": -7.0}
        cut = f.build()
        self.assertEqual({c["gain_db"] for c in a_track(cut, "narration")["clips"]}, {4.0})
        loud = cut.plan["audio"]["narration"]["loudness"]
        self.assertEqual((loud["status"], loud["measured_lufs"], loud["gain_db"]), ("measured", -20.0, 4.0))

    def test_a_narration_near_the_target_is_left_alone(self):
        f = Film(scenes=2)
        f.loudness = {"loudness_lufs": -16.6, "true_peak_db": -3.0}
        self.assertFalse(any("gain_db" in c for c in a_track(f.build(), "narration")["clips"]))

    def test_a_gain_that_would_clip_is_refused(self):
        f = Film(scenes=2)
        f.loudness = {"loudness_lufs": -22.0, "true_peak_db": -3.0}
        e = refused(self, f, "narration_loudness")
        self.assertIn("normalise", e.detail)
        f.loudness = {"loudness_lufs": -22.0}            # no peak measured: a boost is never guessed
        refused(self, f, "narration_loudness")

    def test_music_is_ducked_under_the_narration_and_tiled_with_fades(self):
        f = Film(scenes=6, seconds=10, music_s=25.0)
        f.film["duck_db"], f.film["music_gain_db"] = -9.0, -20.0
        cut = f.build()
        music = a_track(cut, "music")
        self.assertEqual(music["duck"], {"amount_db": 9.0})
        self.assertEqual([c["start_s"] for c in music["clips"]], [0.0, 25.0, 50.0])
        self.assertEqual(music["clips"][-1]["out_s"], 10.0)
        self.assertTrue(all(c["gain_db"] == -20.0 for c in music["clips"]))
        self.assertEqual(music["clips"][1]["fade_in_s"], ft.MUSIC_JOIN_FADE_S)
        self.assertEqual(cut.plan["audio"]["music"]["duck_db"], -9.0)

    def test_no_ducking_when_asked_for_none(self):
        f = Film(scenes=2)
        f.film["duck_db"] = 0
        self.assertNotIn("duck", a_track(f.build(), "music"))

    def test_narration_longer_than_its_scene_is_refused_with_the_length_that_fits(self):
        f = Film(scenes=2, seconds=10)
        f.segments[1]["end_s"] = f.segments[1]["start_s"] + 11.2
        f.assets[NARRATION]["duration_s"] = 40.0
        e = refused(self, f, "narration_too_long", scene=2)
        self.assertIn("12", e.detail)

    def test_narration_text_without_a_narration_take_is_refused(self):
        f = Film(scenes=2)
        f.segments = []
        refused(self, f, "narration_missing", scene=1)

    def test_a_narrated_scene_without_its_segment_is_refused(self):
        f = Film(scenes=3)
        f.segments.pop(1)
        refused(self, f, "narration_segment_missing", scene=2)

    def test_overlapping_narration_segments_are_refused(self):
        f = Film(scenes=2)
        f.segments[1]["start_s"] = f.segments[0]["end_s"] - 1.0
        f.segments[1]["end_s"] -= 1.0
        refused(self, f, "narration_outside_take")

    def test_malformed_captions_are_refused_by_name(self):
        f = Film(scenes=1)
        f.cues = [{"start_s": "soon", "end_s": 2.0, "text": "x"}]
        refused(self, f, "invalid_captions")

    def test_a_removed_music_track_is_refused_not_played_silent(self):
        f = Film(scenes=2)
        del f.assets[MUSIC]
        refused(self, f, "music_unavailable")

    def test_more_sound_clips_than_the_final_pass_mixes_at_1080p_is_refused(self):
        # Measured: 61-63 sound inputs stall or crash the 1080p final pass under the 2 GiB limit; 32 mix.
        self.assertEqual(ft.MAX_SOUND_CLIPS, 32)
        f = Film(scenes=60, seconds=10)                     # narration timed per scene: 60 clips + 3 music tiles
        e = refused(self, f, "too_many_audio_clips")
        self.assertIn("film's clock", e.detail)
        ok = Film(scenes=29, seconds=10, music_s=100.0)     # 29 + 3 tiles = 32
        self.assertEqual(ok.build().plan["audio"]["clips"], 32)

    def test_narration_on_the_film_clock_joins_into_one_clip(self):
        cut = Film(scenes=5, seconds=10, clock="film").build()
        (clip,) = a_track(cut, "narration")["clips"]
        self.assertEqual((clip["start_s"], clip["in_s"]), (ft.NARRATION_LEAD_S, ft.NARRATION_LEAD_S))
        self.assertAlmostEqual(clip["out_s"], 4 * 10 + ft.NARRATION_LEAD_S + 9.0, places=3)

    def test_a_silent_scene_or_a_long_pause_keeps_the_clips_apart(self):
        f = Film(scenes=3, seconds=10, clock="film")
        f.scenes[1]["narration"] = ""
        gone = f.segments.pop(1)
        f.cues = [c for c in f.cues if not gone["start_s"] <= c["start_s"] < gone["end_s"]]
        self.assertEqual(len(a_track(f.build(), "narration")["clips"]), 2)
        f = Film(scenes=2, seconds=10, clock="film")
        f.segments[0]["end_s"] -= 5.0                       # 6 s of quiet before scene 2 speaks
        f.cues = [c for c in f.cues if c["end_s"] <= f.segments[0]["end_s"] or c["start_s"] >= 10]
        self.assertEqual(len(a_track(f.build(), "narration")["clips"]), 2)


class SixtyScenes(unittest.TestCase):
    def setUp(self):
        self.f = Film(scenes=60, seconds=10, shots=2, shot_s=8.0, transition="crossfade", music_s=240.0, clock="film")
        self.cut = self.f.build()

    def test_it_validates_and_lasts_ten_minutes(self):
        self.assertEqual(tl.validate(self.cut.doc), [])
        self.assertEqual(self.cut.length_s, 600.0)
        self.assertLessEqual(self.cut.length_s, tl.EXPORT_LENGTH_MAX_S)

    def test_it_stays_inside_the_editors_limits(self):
        doc = self.cut.doc
        self.assertLess(len(json.dumps(doc).encode()), tl.MAX_DOC_BYTES)
        self.assertLessEqual(sum(len(t["clips"]) for t in doc["tracks"] if t["kind"] == "A"), ft.MAX_SOUND_CLIPS)
        self.assertEqual(len(a_track(self.cut, "narration")["clips"]), 1)
        self.assertLessEqual(len(doc["captions"]["cues"]), tl.MAX_CUES)
        self.assertLessEqual(len(v_clips(self.cut)), tl.MAX_CLIPS_PER_TRACK)
        self.assertLessEqual(len(doc["tracks"]), tl.MAX_TRACKS)

    def test_the_editor_lays_it_out(self):
        def resolve(aid):
            a = self.f.assets.get(aid)
            if a is None:
                return None
            return tl.ResolvedAsset(aid, a["kind"], f"/media/{aid}", a["duration_s"], False if a["kind"] == "video" else None)

        spec = tr.to_render_spec(self.cut.doc, resolve, "/tmp/out.mp4")
        self.assertEqual(rs.validate(spec), [])
        self.assertEqual(sum(rs.segment_frames(s.duration, spec.fps) for s in spec.segments), 600 * 30)
        self.assertEqual(len(spec.audio_tracks), 4)      # one narration clip, three music tiles
