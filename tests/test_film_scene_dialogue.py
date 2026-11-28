"""In-clip dialogue (migration 0241, modules/film_orchestrator.py, modules/film_timeline.py): a dialogue scene's lines reach its CLIP
prompt and nothing else, the clip is asked for its sound, and the cut treats the scene as speech because the saved row says so.

What would break if these failed: an image model told 'says: "..."' draws the words into the key frame (S1's reason for
CLIP_PROMPT_SAVED = false); a dialogue scene's clip made without its lines, or silent on a single-price model whose sound the worker
switched off (rule 4); the quote counting a prompt the worker never sends (0241's film_clip_prompt and the worker's clip_prompt
disagreeing), so a prompt over the model's limit is held for and then refused; the music not ducking under in-clip speech, or ducking
under a default role nobody chose (rule 5); a column that lands while the worker's scene read does not select it (Lens I3). The
database side (validation, grants, the quote's refusals, replay, rollback) is pinned in tests/security/test_sec_film_dialogue_0241.py.
No provider is called."""

import re
import unittest
from pathlib import Path

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import film_orchestrator as fo
from modules import film_timeline as ft
from tests.test_film_clip_sound import bought, role
from tests.test_film_orchestrator import SA, SB, FakeAdapter, FakeDb, Harness
from tests.test_film_timeline import Film, a_track, refused

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "supabase" / "migrations" / "0241_film_scene_dialogue.sql").read_text(encoding="utf-8")

UZ = {"speaker": "Aziz", "line": "Dada, qachon kelasizʼ Oʻgʻlim kutyapti.", "lang": "uz"}
RU = {"speaker": "Отец", "line": "Скоро, сынок. «Скоро».", "lang": "ru"}
LINES = [UZ, RU]
VISUAL = "A small kitchen at dawn, a boy at the window. No text, no letters, no signage."


def said(line):
    return f'{line["speaker"]} says in {fo.DIALOGUE_LANGS[line["lang"]]}: "{line["line"]}"'


class ClipPrompt(unittest.TestCase):
    def test_the_lines_follow_the_visual_prompt_quoted_with_their_speaker_and_language(self):
        self.assertEqual(fo.clip_prompt(VISUAL, LINES), f"{VISUAL}\n{said(UZ)} {said(RU)}")
        self.assertIn('Aziz says in Uzbek: "Dada, qachon kelasizʼ Oʻgʻlim kutyapti."', fo.clip_prompt(VISUAL, LINES))
        self.assertIn('Отец says in Russian: "Скоро, сынок. «Скоро»."', fo.clip_prompt(VISUAL, LINES))

    def test_no_lines_is_the_visual_prompt_and_an_empty_visual_prompt_is_the_lines(self):
        self.assertEqual(fo.clip_prompt(VISUAL, []), VISUAL)
        self.assertEqual(fo.clip_prompt("", [UZ]), said(UZ))
        self.assertEqual(fo.clip_prompt("   ", [UZ]), said(UZ))

    def test_the_worker_writes_exactly_what_the_quote_counts(self):
        # 0241's end state asserts film_clip_prompt on this very sample; the lab pins the two on the whole matrix.
        sample = [{"speaker": "Aziz", "line": "Salom, dada!", "lang": "uz"}, {"speaker": "Dad", "line": "Hi.", "lang": "en"}]
        sql = 'A kitchen at dawn.\' || chr(10) || \'Aziz says in Uzbek: "Salom, dada!" Dad says in English: "Hi."'
        self.assertIn(sql, MIGRATION)
        self.assertEqual(fo.clip_prompt("A kitchen at dawn.", sample),
                         'A kitchen at dawn.\nAziz says in Uzbek: "Salom, dada!" Dad says in English: "Hi."')
        self.assertEqual(set(fo.DIALOGUE_LANGS), {"uz", "ru", "en"})
        for code, name in fo.DIALOGUE_LANGS.items():
            self.assertIn(f"when '{code}' then '{name}'", MIGRATION)


class PerModelFamily(unittest.TestCase):
    """The prompt each i2v family's adapter is handed (capability_request: what every adapter reads), and the sound it is asked for."""

    def request(self, model, params=None):
        return cw.GenerationRequest(job_id="j", org_id="o", capability="i2v", model=model,
                                    params={"prompt": VISUAL, "duration_s": 5, **(params or {})})

    def made(self, model, params=None):
        adapter = ca.resolve(model, env={})
        scene = {"sound_role": "dialogue", "dialogue": LINES}
        req = fo.with_dialogue(fo.without_unused_sound(self.request(model, params), adapter, scene), "clip", scene)
        return ca.capability_request(req)

    def test_every_family_that_speaks_gets_the_quoted_lines_in_its_clip_prompt(self):
        families = {
            # model: the sound flag the adapter is handed (None: the adapter has no switch; the vendor's one price includes it)
            "veo-3.1": None, "minimax-h3": None, "gemini-omni-1.1-flash": None, "happyhorse-1.1": None,
            "ltx-2.5-pro": True, "seedance-2.0": True, "vidu-q3-pro": True, "grok-imagine-video-1.5": True,
        }
        for model, audio in families.items():
            with self.subTest(model=model):
                cap = self.made(model)
                self.assertEqual(cap.prompt, f"{VISUAL}\n{said(UZ)} {said(RU)}")
                self.assertIs(cap.audio, audio)

    def test_a_model_priced_by_its_sound_keeps_the_option_the_quote_sold(self):
        for model in ("kling-v3", "seedance-1.5-pro"):
            with self.subTest(model=model):
                cap = self.made(model, {"audio": True})
                self.assertIs(cap.audio, True)
                self.assertIn(said(UZ), cap.prompt)

    def test_the_lines_cap_is_half_the_smallest_prompt_limit_of_a_model_that_makes_sound(self):
        # 0241's 1000 is derived from the registry, not chosen: if a speaking i2v model with a smaller prompt limit is added, the cap
        # must come down with it (the quote still counts the composed prompt against the chosen model: 0218's prompt_too_long).
        import json
        reg = json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))
        models = reg["models"] if isinstance(reg, dict) else reg
        limits = [m["limits"]["max_prompt_chars"] for m in models if "i2v" in m.get("capabilities", []) and m.get("audio_out")]
        self.assertTrue(limits)
        self.assertEqual(min(limits) // 2, 1000)
        self.assertIn("if n > 1000 then", MIGRATION)


class NeverInAKeyFrame(unittest.TestCase):
    """The lines exist only in film_scenes.dialogue; only a clip take of a dialogue scene is handed them."""

    class Recording(FakeAdapter):
        def __init__(self, model):
            super().__init__(model)
            self.requests = []

        def submit(self, request):
            self.requests.append(request)
            return super().submit(request)

    def harness(self, **scene):
        db = FakeDb()
        db.scenes_[0].update({"sound_role": "dialogue", "dialogue": LINES, **scene})
        adapters = {m: self.Recording(m) for m in ("img-key", "vid-clip", "tts-a")}
        return Harness(db, adapters), adapters

    def test_the_key_frame_request_of_a_dialogue_scene_carries_no_line_and_no_speaker(self):
        h, ad = self.harness()
        h.run()
        keyframes = ad["img-key"].requests
        self.assertEqual(len(keyframes), 1)
        text = repr(keyframes[0])
        for line in LINES:
            self.assertNotIn(line["line"], text)
            self.assertNotIn(line["speaker"], text)
        self.assertNotIn("says in", text)
        self.assertEqual(keyframes[0].params["prompt"], "a lighthouse")

    def test_the_dialogue_scenes_clip_has_the_lines_and_the_other_scenes_clip_does_not(self):
        h, ad = self.harness()
        h.run()
        by_scene = {}
        for take in h.db.takes_:
            if take["kind"] == "clip":
                by_scene[take["scene_id"]] = h.db.jobs[take["job"]]["id"]
        clips = ad["vid-clip"].requests
        self.assertEqual(len(clips), 2)
        a = next(r for r in clips if r.job_id == by_scene[SA])
        b = next(r for r in clips if r.job_id == by_scene[SB])
        self.assertEqual(a.params["prompt"], f"a lighthouse\n{said(UZ)} {said(RU)}")
        self.assertEqual(b.params["prompt"], "a lighthouse")
        self.assertNotIn("says in", repr(ad["tts-a"].requests))

    def test_with_dialogue_leaves_a_key_frame_and_a_narration_alone(self):
        scene = {"sound_role": "dialogue", "dialogue": LINES}
        for cap, kind in (("t2i", "keyframe"), ("edit", "keyframe"), ("tts", "narration")):
            req = cw.GenerationRequest(job_id="j", org_id="o", capability=cap, model="m", params={"prompt": VISUAL})
            self.assertIs(fo.with_dialogue(req, kind, scene), req)

    def test_an_extend_in_a_dialogue_scene_or_lines_that_did_not_arrive_fail_the_take_before_the_paid_call(self):
        req = cw.GenerationRequest(job_id="j", org_id="o", capability="i2v", model="m", params={"prompt": VISUAL})
        with self.assertRaises(fo._TakeFailed) as e:
            fo.with_dialogue(req, "extend", {"sound_role": "dialogue", "dialogue": LINES})
        self.assertEqual(e.exception.code, "bad_request")
        for broken in (None, [], "not json", [{"speaker": "A", "line": "x"}], [{"speaker": "A", "line": "x", "lang": "de"}]):
            with self.subTest(broken=broken), self.assertRaises(fo._TakeFailed) as e:
                fo.with_dialogue(req, "clip", {"sound_role": "dialogue", "dialogue": broken})
            self.assertIn("lines could not be read", e.exception.message)

    def test_the_run_fails_that_take_and_submits_nothing_for_it(self):
        h, ad = self.harness(dialogue=None)
        h.run()
        self.assertEqual(len([r for r in ad["vid-clip"].requests if r.job_id == h.db.jobs[next(
            t["job"] for t in h.db.takes_ if t["kind"] == "clip" and t["scene_id"] == SA)]["id"]]), 0)
        self.assertIn(("clip", fo.failure_kind("bad_request"), "bad_request"), {(k, f, c) for k, f, c, _e in h.db.failed})

    def test_a_dialogue_scene_read_as_a_json_string_is_read_as_its_list(self):
        import json
        req = cw.GenerationRequest(job_id="j", org_id="o", capability="i2v", model="m", params={"prompt": VISUAL})
        out = fo.with_dialogue(req, "clip", {"sound_role": "dialogue", "dialogue": json.dumps(LINES)})
        self.assertEqual(out.params["prompt"], fo.clip_prompt(VISUAL, LINES))


class LineRuleInTheWorker(unittest.TestCase):
    """BR-0241-01 / -02: the worker refuses a line the database would refuse (the lab pins the two sides equal on a matrix)."""

    def test_a_fullwidth_quote_a_prompt_shaped_speaker_or_a_hidden_character_fails_the_take_before_the_call(self):
        req = cw.GenerationRequest(job_id="j", org_id="o", capability="i2v", model="m", params={"prompt": VISUAL})
        for one in ({**UZ, "line": "Salom\uff02 x"}, {**UZ, "speaker": "Aziz\uff02"}, {**UZ, "speaker": "Aziz says in German"},
                    {**UZ, "speaker": "Aziz: hi"}, {**UZ, "speaker": "O'Brien"}, {**UZ, "line": "Sal\u200bom"}):
            with self.subTest(one=one), self.assertRaises(fo._TakeFailed):
                fo.with_dialogue(req, "clip", {"sound_role": "dialogue", "dialogue": [one]})
            self.assertIsNotNone(fo.line_problem(one), one)

    def test_names_with_uzbek_apostrophes_marks_and_periods_pass(self):
        for name in ("Gʻayrat", "Maʼruf", "Narrator\u2019s friend", "Dr. Ali-Bek", "Jose\u0301", "Отец", "R2D2"):
            self.assertIsNone(fo.line_problem({"speaker": name, "line": "Salom", "lang": "uz"}), name)


class DuckFromTheSavedRow(unittest.TestCase):
    """The music ducks under a dialogue scene's speech because its saved row says dialogue, never because of a default."""

    def film(self):
        f = Film(scenes=3, shots=1, shot_s=11.0, transition="cut", captions="none", narration=False)
        return f

    def test_a_saved_dialogue_scene_is_a_duck_span_inside_its_lead_and_tail(self):
        f = role(self.film(), 1, "dialogue")
        cut = f.build()
        lead, tail = ft.NARRATION_LEAD_S, ft.NARRATION_TAIL_S
        self.assertEqual((lead, tail), (0.25, 0.25))
        self.assertEqual(cut.sound["music_duck_spans"], [[10 + lead, 20 - tail]])
        self.assertEqual(cut.plan["scenes"][1]["sound_role_source"], "chosen")
        self.assertEqual(cut.plan["scenes"][1]["dialogue_lines"], 1)
        self.assertEqual([p["dialogue_lines"] for p in cut.plan["scenes"]], [0, 1, 0])

    def test_a_default_role_is_never_speech(self):
        cut = bought(self.film()).build()
        self.assertEqual({p["sound_role"] for p in cut.plan["scenes"]}, {"ambience"})
        self.assertEqual(cut.sound["music_duck_spans"], [])
        self.assertNotIn("duck", a_track(cut, "music"))

    def test_a_row_that_disagrees_with_itself_is_refused_by_name(self):
        f = self.film()
        f.scenes[0]["sound_role"] = "dialogue"
        e = refused(self, f, "invalid_scene", scene=1)
        self.assertIn("save its lines", e.detail)
        g = self.film()
        g.scenes[2]["dialogue"] = [dict(UZ)]
        e = refused(self, g, "invalid_scene", scene=3)
        self.assertIn("set its sound to dialogue", e.detail)

    def test_two_dialogue_scenes_are_two_spans_and_the_lines_text_does_not_change_the_cut(self):
        f = role(role(self.film(), 0, "dialogue"), 2, "dialogue")
        a = f.build()
        self.assertEqual(len(a.sound["music_duck_spans"]), 2)
        f.scenes[0]["dialogue"] = [dict(RU), dict(UZ)]
        b = f.build()
        self.assertEqual((a.sha256, a.sound), (b.sha256, b.sound))


class TheI3PinNowBites(unittest.TestCase):
    """#973's RolesAreDefaultsToday compares the migrations' added film_scenes columns with FilmRest.scenes' select; with 0241 the set
    is no longer empty, so the pin is live, and the read names both."""

    def test_0241_adds_both_columns_and_the_worker_selects_both(self):
        added = set(re.findall(r"(?is)alter table\s+(?:only\s+)?public\.film_scenes\s+add column (?:if not exists )?"
                               r"(sound_role|dialogue)\b", MIGRATION))
        self.assertEqual(added, {"sound_role", "dialogue"})
        seen = {}

        class Probe(fo.FilmRest):
            def __init__(self):
                pass

            def _select(self, table, params):
                seen.update(params, table=table)
                return []
        Probe().scenes("f")
        self.assertEqual(seen["table"], "film_scenes")
        self.assertLessEqual(added, set(seen["select"].split(",")))


if __name__ == "__main__":
    unittest.main()
