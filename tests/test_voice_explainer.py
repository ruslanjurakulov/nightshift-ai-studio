"""Voice to 2D video (modules/voice_explainer.py, tools/voice_to_video.py).

What would break without these:

* a scene cut in the middle of a word, or a scene that runs past the recording, so the
  narration and the picture drift apart;
* a half-minute sentence held under one headline, or a 0.4 s scene that flashes past;
* a model's plan with a visual the renderer cannot draw reaching Remotion (a blank frame
  or a crash after the transcription was paid for);
* a broken model plan quietly replaced by the plain rules plan (CLAUDE.md rule 4);
* asked-for sound effects missing and the video going out silent instead;
* the Python looks, visual kinds, poses and settings drifting from the TypeScript ones;
* a counter showing "10" for "10 000 so'm" (a figure the narration never said);
* a word track longer than the recording reaching Remotion, which then stops after everything was paid for;
* the cheap checks (effects, plan file) running after the transcription and the paid planner call;
* a render that keeps running after its timeout, or a public file name that escapes the render's folder;
* a pose drawn by the renderer (walk) that the validator refuses, or the reverse.
"""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import voice_explainer as ve  # noqa: E402
from tools import voice_to_video  # noqa: E402

TS_TYPES = (ROOT / "video-engine" / "src" / "explainer" / "types.ts").read_text(encoding="utf-8")
TS_LOOKS = (ROOT / "video-engine" / "src" / "explainer" / "looks.ts").read_text(encoding="utf-8")


def words(spec):
    """'Hello world. Again' at 0.5 s a word (about speaking pace) -> Word list."""
    out, t = [], 0.0
    for w in spec.split():
        out.append(ve.Word(w, t, t + 0.42))
        t += 0.5
    return out


class Words(unittest.TestCase):
    def test_every_track_shape_is_read_and_unplaceable_words_are_dropped(self):
        raw = [{"word": " Salom ", "start": 0.1, "end": 0.5}, {"t": "dunyo", "s": 0.6, "e": 0.9},
               {"text": "ok", "start_s": 1.0, "end_s": 1.2}, {"word": "nope"}, {"word": "", "start": 2, "end": 3}, "junk"]
        self.assertEqual([w.text for w in ve.normalize_words(raw)], ["Salom", "dunyo", "ok"])

    def test_times_never_go_backwards(self):
        got = ve.normalize_words([{"text": "a", "start_s": 2.0, "end_s": 2.5}, {"text": "b", "start_s": 1.0, "end_s": 1.1}])
        self.assertGreaterEqual(got[1].start_s, got[0].start_s)
        self.assertGreater(got[1].end_s, got[1].start_s)


class Sentences(unittest.TestCase):
    def test_sentences_follow_the_recordings_punctuation(self):
        got = ve.split_sentences(words("Bir ikki uch to'rt. Besh olti yetti sakkiz? To'qqiz o'n bir ikki!"))
        self.assertEqual([s.text for s in got], ["Bir ikki uch to'rt.", "Besh olti yetti sakkiz?", "To'qqiz o'n bir ikki!"])

    def test_a_long_run_breaks_at_its_last_comma_not_mid_thought(self):
        text = "one two three four five six, seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen."
        got = ve.split_sentences(words(text), max_s=4.0)
        self.assertTrue(got[0].text.endswith("six,"), got[0].text)
        self.assertTrue(all(s.end_s - s.start_s <= 4.0 + 0.4 for s in got[:-1]))

    def test_a_long_run_without_a_comma_still_breaks_at_the_limit(self):
        got = ve.split_sentences(words(" ".join(["word"] * 40) + "."), max_s=5.0)
        self.assertGreater(len(got), 2)

    def test_a_scrap_shorter_than_the_minimum_joins_its_neighbour(self):
        got = ve.split_sentences(words("Ha. Bu juda uzun gap bo'lib davom etadi va tugaydi."), min_s=1.6)
        self.assertEqual(len(got), 1)
        self.assertTrue(got[0].text.startswith("Ha."))

    def test_scene_windows_cut_where_the_next_sentence_starts_and_cover_the_recording(self):
        ss = ve.split_sentences(words("Bir ikki uch to'rt. Besh olti yetti sakkiz."))
        wins = ve.scene_windows(ss, duration_s=10.0)
        self.assertEqual(wins[0][0], 0.0)
        self.assertEqual(wins[0][1], ss[1].start_s)
        self.assertEqual(wins[-1][1], 10.0)


SAMPLE = {"kicker": "Animatorga", "headline": "$$ *$*", "accent": "yuzlab dollar.",
          "visual": {"kind": "card", "title": "Hisob", "rows": [{"label": "Ssenariy", "value": "$80"}], "total": {"label": "Jami", "value": "$80"}}}


class Catalogue(unittest.TestCase):
    def test_a_valid_scene_comes_back_in_the_renderers_shape(self):
        got = ve.validate_scene(SAMPLE, index=0)
        self.assertEqual(got["visual"]["rows"][0]["tone"], "normal")
        self.assertEqual(got["headline"], "$$ *$*")

    def test_each_visual_kind_is_accepted(self):
        for v in ({"kind": "none"}, {"kind": "stat", "value": "4.3K", "label": "views"},
                  {"kind": "progress", "label": "Render", "percent": 2.5, "note": "91 h"},
                  {"kind": "characters", "setting": "street", "prop": "coin", "cast": [{"pose": "wave", "color": 5}]},
                  {"kind": "emoji", "mood": "shocked"}, {"kind": "checklist", "items": ["a", "b"]},
                  {"kind": "chat", "messages": [{"side": "left", "text": "hi"}]}):
            with self.subTest(kind=v["kind"]):
                self.assertEqual(ve.validate_visual(v)["kind"], v["kind"])
        self.assertEqual(ve.validate_visual({"kind": "characters", "setting": "room", "cast": [{"pose": "sit", "color": 5}]})["cast"][0]["color"], 1)

    def test_anything_outside_the_catalogue_is_refused_by_name(self):
        for bad, word in (({"kind": "hologram"}, "visual kind"), ({"kind": "emoji", "mood": "smug"}, "mood"),
                          ({"kind": "characters", "setting": "moon", "cast": [{"pose": "stand"}]}, "setting"),
                          ({"kind": "characters", "setting": "room", "cast": []}, "1 to 3"),
                          ({"kind": "progress", "label": "x", "percent": 140}, "0 to 100"),
                          ({"kind": "card", "title": "x", "rows": [{"label": "a", "value": "b"}] * 7}, "1 to 6"),
                          ({"kind": "stat", "value": "1234567890123", "label": "x"}, "holds 12")):
            with self.subTest(bad=bad), self.assertRaises(ve.PlanRejected) as ctx:
                ve.validate_visual(bad)
            self.assertIn(word, str(ctx.exception))

    def test_a_headline_too_long_for_the_layout_or_with_odd_stars_is_refused(self):
        with self.assertRaises(ve.PlanRejected):
            ve.validate_scene({**SAMPLE, "headline": "x" * 40}, index=3)
        with self.assertRaisesRegex(ve.PlanRejected, "one pair of"):
            ve.validate_scene({**SAMPLE, "headline": "*a* *b*"}, index=3)


class Planners(unittest.TestCase):
    SENT = ve.split_sentences(words("Animatorga buyurtma bersangiz, video 750 dollar turadi. O'zingiz qilsangiz haftalab vaqt ketadi."))

    def test_the_rules_plan_is_deterministic_valid_and_shows_a_spoken_number(self):
        a, b = ve.plan_rules(self.SENT), ve.plan_rules(self.SENT)
        self.assertEqual(a, b)
        self.assertEqual(a[0]["visual"], {"kind": "stat", "value": "750", "label": "Animatorga buyurtma bersangiz video 750"})
        self.assertEqual(a[1]["headline"], "*qilsangiz*")

    def test_a_good_model_plan_is_used_scene_by_scene(self):
        reply = json.dumps({"scenes": [SAMPLE, {**SAMPLE, "visual": {"kind": "emoji", "mood": "worried"}}]})
        got = ve.plan_model(self.SENT, lambda prompt, system: f"```json\n{reply}\n```")
        self.assertEqual([p["visual"]["kind"] for p in got], ["card", "emoji"])

    def test_a_broken_model_plan_is_refused_never_replaced_by_the_rules_plan(self):
        for reply, word in (("not json", "not JSON"), (json.dumps([SAMPLE]), "1 scenes for 2"),
                            (json.dumps([SAMPLE, {**SAMPLE, "visual": {"kind": "fireworks"}}]), "visual kind")):
            with self.subTest(reply=reply[:20]), self.assertRaises(ve.PlanRejected) as ctx:
                ve.plan_model(self.SENT, lambda p, s, r=reply: r)
            self.assertIn(word, str(ctx.exception))

    def test_a_provider_error_is_named_not_swallowed(self):
        def boom(p, s):
            raise RuntimeError("429 quota_exceeded")
        with self.assertRaisesRegex(ve.PlanRejected, "RuntimeError: 429 quota_exceeded"):
            ve.plan_model(self.SENT, boom)

    def test_the_prompt_lists_every_sentence_and_the_whole_catalogue(self):
        p = ve.planner_prompt(self.SENT, "Uzbek")
        for s in self.SENT:
            self.assertIn(s.text, p)
        for k in ve.VISUAL_KINDS:
            self.assertIn(f'"kind":"{k}"', p)


class SoundAndProps(unittest.TestCase):
    def scenes(self):
        ss = ve.split_sentences(words("Bir ikki uch to'rt. Besh olti yetti sakkiz."))
        return ve.build_scenes(ss, ve.plan_rules(ss), 4.0)

    def test_effects_asked_for_and_missing_are_a_refusal_with_the_fix(self):
        with TemporaryDirectory() as d, self.assertRaisesRegex(ve.ExplainerError, "generate_assets.py"):
            ve.sound_cues(self.scenes(), Path(d))

    def test_effects_land_on_the_cuts_as_public_paths(self):
        with TemporaryDirectory() as d:
            for n in ("whoosh", "deep_boom"):
                (Path(d) / f"{n}.wav").write_bytes(b"RIFF")
            scenes = self.scenes()
            cues, files = ve.sound_cues(scenes, Path(d))
        self.assertEqual(cues[0]["src"], "sfx/deep_boom.wav")
        self.assertEqual([c["src"] for c in cues[1:]], ["sfx/whoosh.wav"] * (len(scenes) - 1))
        self.assertEqual(set(files), {"sfx/whoosh.wav", "sfx/deep_boom.wav"})
        self.assertEqual(ve.sound_cues(scenes, None), ([], {}))

    def test_props_are_the_compositions_contract(self):
        ss = ve.split_sentences(words("Bir ikki uch to'rt. Besh olti yetti sakkiz."))
        props = ve.build_props(look="neon", duration_s=4.0, words=[w for s in ss for w in s.words],
                               scenes=ve.build_scenes(ss, ve.plan_rules(ss), 4.0), narration="narration.mp3")
        ts_fields = set(re.findall(r"^\s+(\w+)[?]?:", TS_TYPES.split("export type ExplainerProps = {", 1)[1].split("};", 1)[0], re.M))
        self.assertEqual(set(props), ts_fields)
        self.assertEqual(set(props["scenes"][0]), set(re.findall(r"^\s+(\w+)[?]?:", TS_TYPES.split("export interface ExplainerScene {", 1)[1].split("}", 1)[0], re.M)))
        with self.assertRaisesRegex(ve.ExplainerError, "not one of"):
            ve.build_props(look="sepia", duration_s=4.0, words=[], scenes=[], narration="")


class TwinWithTypeScript(unittest.TestCase):
    def ts_union(self, name):
        m = re.search(rf"export type {name} = ([^;]+);", TS_TYPES)
        return tuple(re.findall(r'"([a-z]+)"', m.group(1)))

    def test_the_catalogues_are_the_same_on_both_sides(self):
        self.assertEqual(set(ve.LOOKS), set(self.ts_union("LookId")))
        self.assertEqual(set(ve.POSES), set(self.ts_union("Pose")))
        self.assertEqual(set(ve.SETTINGS), set(self.ts_union("Setting")))
        self.assertEqual(set(ve.PROPS), set(self.ts_union("Prop")))
        self.assertEqual(set(ve.MOODS), set(self.ts_union("Mood")))
        self.assertEqual(set(ve.TONES), set(self.ts_union("Tone")))
        self.assertEqual(set(ve.VISUAL_KINDS), set(re.findall(r'kind: "([a-z]+)"', TS_TYPES)))
        for look in ve.LOOKS:
            self.assertIn(f"  {look}: {{", TS_LOOKS)


class Cli(unittest.TestCase):
    def test_a_missing_recording_or_too_long_one_is_refused_before_anything_runs(self):
        with TemporaryDirectory() as d:
            rc = voice_to_video.main(["--audio", str(Path(d) / "none.mp3"), "--out", str(Path(d) / "o.mp4")])
        self.assertEqual(rc, 2)

    def test_the_model_planner_without_a_key_names_the_fix(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": ""}), self.assertRaisesRegex(ve.ExplainerError, "--planner rules"):
            voice_to_video._model_gen()


class ReviewFindings(unittest.TestCase):
    """Lens review of slice 1a: each test is a reproduced failure."""

    def test_space_grouped_thousands_are_read_whole_and_punctuation_never_sticks(self):
        for text, want in (("Bu 10 000 so'm turadi.", "10 000"), ("Это стоит 1 500 000 рублей.", "1 500 000"),
                           ("In 2026, it grew.", "2026"), ("$1,500 total", "$1,500"), ("no number here", None),
                           ("a 1234567890123 digit run", None)):
            with self.subTest(text=text):
                self.assertEqual(ve.spoken_number(text), want)

    def test_a_word_track_longer_than_the_recording_is_refused_and_a_small_overshoot_clamped(self):
        got = ve.fit_words([ve.Word("a", 0, 1), ve.Word("end.", 4.6, 5.3)], 5.0)
        self.assertEqual(got[-1].end_s, 5.0)
        with self.assertRaisesRegex(ve.ExplainerError, "runs past the recording"):
            ve.fit_words([ve.Word("a", 0, 1), ve.Word("z", 6.0, 6.4)], 5.0)

    def test_scene_windows_never_run_past_the_recording(self):
        ss = ve.split_sentences(words("Bir ikki uch to'rt. Besh olti yetti sakkiz."))
        self.assertEqual(ve.scene_windows(ss, 3.9)[-1][1], 3.9)
        with self.assertRaisesRegex(ve.ExplainerError, "fit the words"):
            ve.scene_windows(ss, 2.0)

    def test_the_prompt_states_every_limit_the_validator_enforces(self):
        p = ve.planner_prompt(ve.split_sentences(words("Bir ikki uch to'rt.")))
        for name, n in ve.LIMITS.items():
            with self.subTest(limit=name):
                self.assertIn(f"<= {n}", p)
        too_long = {"kind": "card", "title": "x", "rows": [{"label": "y" * (ve.LIMITS["row_label"] + 1), "value": "1"}]}
        with self.assertRaisesRegex(ve.PlanRejected, "row label"):
            ve.validate_visual(too_long)

    def test_malformed_chat_and_checklist_entries_are_refused_never_dropped(self):
        with self.assertRaisesRegex(ve.PlanRejected, "not an object"):
            ve.validate_visual({"kind": "chat", "messages": ["hi"]})
        with self.assertRaisesRegex(ve.PlanRejected, "not text"):
            ve.validate_visual({"kind": "checklist", "items": [{"a": 1}]})

    def test_a_censored_word_does_not_break_the_headline_marking(self):
        plans = ve.plan_rules(ve.split_sentences(words("That was f***ing unbelievable today, honestly.")))
        self.assertEqual(plans[0]["headline"].count("*"), 2)

    def test_headline_letters_must_fit_and_stars_must_wrap_a_word(self):
        with self.assertRaisesRegex(ve.PlanRejected, "layout holds"):
            ve.validate_scene({**SAMPLE, "headline": "x" * (ve.MAX_HEADLINE + 1)}, index=0)
        with self.assertRaisesRegex(ve.PlanRejected, "one pair"):
            ve.validate_scene({**SAMPLE, "headline": "**word"}, index=0)

    def test_a_public_file_name_cannot_leave_the_renders_folder(self):
        from unittest import mock
        with TemporaryDirectory() as d:
            engine = Path(d) / "engine"
            (engine / "node_modules").mkdir(parents=True)
            src = Path(d) / "a.wav"
            src.write_bytes(b"x")
            for bad in ("/etc/x", "../x", "sfx/../../x", ""):
                with self.subTest(name=bad), mock.patch("shutil.which", return_value="/usr/bin/npx"), \
                        self.assertRaisesRegex(ve.ExplainerError, "refusing the public file name"):
                    ve.render({}, Path(d) / "o.mp4", files={bad: src}, engine_dir=engine)

    def test_a_render_timeout_kills_the_whole_group_and_leaves_no_output(self):
        import subprocess
        from unittest import mock

        class Hung:
            pid = 4242
            returncode = None

            def communicate(self, timeout=None):
                raise subprocess.TimeoutExpired("npx", timeout)

        with TemporaryDirectory() as d:
            engine = Path(d) / "engine"
            (engine / "node_modules").mkdir(parents=True)
            out = Path(d) / "o.mp4"
            out.write_bytes(b"stale")
            with mock.patch("shutil.which", return_value="/usr/bin/npx"), \
                    mock.patch("subprocess.Popen", return_value=Hung()) as popen, \
                    mock.patch("os.killpg") as killpg, \
                    self.assertRaisesRegex(ve.ExplainerError, "longer than"):
                ve.render({}, out, files={}, engine_dir=engine, timeout_s=1)
            self.assertTrue(popen.call_args.kwargs["start_new_session"])
            self.assertNotIn("GEMINI_API_KEY", popen.call_args.kwargs["env"])
            killpg.assert_called_once()
            self.assertFalse(out.exists())


class CliOrder(unittest.TestCase):
    def setUp(self):
        from unittest import mock
        self.mock = mock
        self.tmp = TemporaryDirectory()
        self.d = Path(self.tmp.name)
        self.audio = self.d / "n.mp3"
        self.audio.write_bytes(b"x")

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *extra, duration=30.0):
        with self.mock.patch.object(ve, "audio_seconds", return_value=duration), \
                self.mock.patch.object(voice_to_video, "_words", side_effect=AssertionError("transcribed")) as w, \
                self.mock.patch.object(voice_to_video, "_model_gen", side_effect=AssertionError("planner")) as g, \
                self.mock.patch("shutil.which", return_value="/usr/bin/npx"):
            rc = voice_to_video.main(["--audio", str(self.audio), "--out", str(self.d / "o.mp4"), *extra])
        return rc, w.called, g.called

    def test_a_recording_over_the_limit_is_refused_before_anything_runs(self):
        self.assertEqual(self.run_cli(duration=ve.MAX_SECONDS + 1), (2, False, False))

    def test_missing_effects_are_refused_before_the_transcription_and_the_planner(self):
        self.assertEqual(self.run_cli("--sfx-dir", str(self.d / "nosfx"), "--planner", "model"), (2, False, False))

    def test_a_broken_plan_file_is_refused_before_the_transcription(self):
        (self.d / "plan.json").write_text("{nope")
        self.assertEqual(self.run_cli("--sfx-dir", "none", "--plan", str(self.d / "plan.json")), (2, False, False))

    def test_impossible_frame_settings_are_refused_not_replaced(self):
        self.assertEqual(self.run_cli("--sfx-dir", "none", "--fps", "0")[0], 2)
        self.assertEqual(self.run_cli("--sfx-dir", "none", "--width", "1081")[0], 2)


class WalkPose(unittest.TestCase):
    def test_walk_is_in_the_closed_catalogue_on_both_sides_and_offered_to_the_planner(self):
        self.assertIn("walk", ve.POSES)
        self.assertIn('"walk"', TS_TYPES.split("export type Pose =", 1)[1].split(";", 1)[0])
        self.assertEqual(ve.validate_visual({"kind": "characters", "setting": "street", "prop": "phone",
                                             "cast": [{"pose": "walk", "color": 1}, {"pose": "sit", "color": 0}]})["cast"][0]["pose"], "walk")
        self.assertIn("walk", ve.planner_prompt(ve.split_sentences(words("Bir ikki uch to'rt."))))

    def test_the_media_card_is_on_by_default_and_can_be_turned_off(self):
        ss = ve.split_sentences(words("Bir ikki uch to'rt."))
        scenes = ve.build_scenes(ss, ve.plan_rules(ss), 2.0)
        self.assertTrue(ve.build_props(look="dusk", duration_s=2.0, words=[], scenes=scenes, narration="")["media_card"])
        self.assertFalse(ve.build_props(look="dusk", duration_s=2.0, words=[], scenes=scenes, narration="", media_card=False)["media_card"])


if __name__ == "__main__":
    unittest.main()
