"""tools/stt_compare.py: the measurement of Whisper base against ElevenLabs Scribe (CLAUDE.md rule 8).

What would break without these: an Uzbek word typed with another apostrophe (oʻ / o' / o‘) counted as an error, so Scribe
or Whisper is judged on keyboards rather than hearing; an empty reference read as a perfect 0 % (rule 5); a word with no
time counted as well-timed; and, worst, a run that spends on ElevenLabs without the person seeing the plan and saying yes,
or a "Scribe" column that quietly holds nothing because the key was missing.
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules.capabilities.base import E_QUOTA, AdapterError  # noqa: E402
from tools import stt_compare as sc  # noqa: E402

KEY = "sk_0123456789abcdef0123456789abcdef0123456789abcdef"


class Normalisation(unittest.TestCase):
    def test_every_uzbek_apostrophe_form_is_one(self):
        forms = ["oʻzbek", "o'zbek", "o`zbek", "o‘zbek", "o’zbek", "oʼzbek", "o´zbek"]
        self.assertEqual({sc.normalize_text(f) for f in forms}, {"o'zbek"})
        self.assertEqual(sc.normalize_text("Gʻalaba"), sc.normalize_text("g'alaba"))

    def test_case_punctuation_and_spacing_do_not_count(self):
        self.assertEqual(sc.normalize_text("  Salom,   DUNYO!  — «Bu» narx…\n"), "salom dunyo bu narx")

    def test_a_quote_around_a_word_is_not_part_of_it_but_an_inner_apostrophe_is(self):
        self.assertEqual(sc.normalize_text("'so'z' ‘ma’no’"), "so'z ma'no")

    def test_cyrillic_is_kept_and_folded(self):
        self.assertEqual(sc.normalize_text("Привет, Мир!"), "привет мир")


class WordErrorRate(unittest.TestCase):
    REF = "Oʻzbekiston gʻalaba qozondi. Bu narx 10 dollar."

    def test_the_same_words_typed_another_way_are_no_error(self):
        self.assertEqual(sc.wer(self.REF, "o'zbekiston g‘alaba qozondi bu narx 10 dollar"), 0.0)

    def test_substitution_deletion_and_insertion_each_count_once(self):
        ref = "o'zbekiston g'alaba qozondi bu narx 10 dollar"      # 7 words
        self.assertAlmostEqual(sc.wer(ref, "uzbekiston g'alaba qozondi bu narx 10 dollar"), 1 / 7)   # one substitution
        self.assertAlmostEqual(sc.wer(ref, "o'zbekiston qozondi bu narx 10 dollar"), 1 / 7)          # one deletion
        self.assertAlmostEqual(sc.wer(ref, "o'zbekiston g'alaba qozondi va bu narx 10 dollar"), 1 / 7)  # one insertion
        self.assertEqual(sc.wer(ref, ""), 1.0)
        self.assertGreater(sc.wer("a b", "x y z w"), 1.0, "WER is not capped: insertions can exceed the reference")

    def test_edit_distance(self):
        self.assertEqual(sc.edit_distance("a b c d".split(), "a x c".split()), 2)
        self.assertEqual(sc.edit_distance([], "a b".split()), 2)
        self.assertEqual(sc.edit_distance("a b".split(), []), 2)

    def test_an_empty_reference_has_no_wer_never_zero(self):
        self.assertIsNone(sc.wer("", "salom"))
        self.assertIsNone(sc.wer(" — ... ", "salom"))


class Timing(unittest.TestCase):
    def test_only_numbered_forward_and_inside_times_count(self):
        words = [{"t": "a", "s": 0.1, "e": 0.4},
                 {"t": "b", "s": 0.5, "e": 0.9},
                 {"t": "c", "s": None, "e": 1.0},        # no start
                 {"t": "d", "s": 0.3, "e": 0.6},         # runs backwards
                 {"t": "e", "s": 1.2, "e": 1.1},         # ends before it starts
                 {"t": "f", "s": 2.0, "e": 9.0},         # past the recording
                 {"word": "g", "start": 2.1, "end": 2.5},  # Whisper's shape counts the same
                 {"t": "h", "s": True, "e": 3.0}]         # a bool is not a time
        self.assertAlmostEqual(sc.timing_share(words, 3.0), 3 / 8)
        # A numeric string is a time, as the job reads it (modules/captions), so it counts here too.
        self.assertEqual(sc.timing_share([{"t": "a", "s": "0.1", "e": "0.4"}, {"t": "b", "s": "x", "e": 1.0}], 3.0), 0.5)

    def test_no_words_is_nothing_to_judge(self):
        self.assertIsNone(sc.timing_share([], 3.0))


class TheCommand(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.audio = self.root / "a.wav"
        self.audio.write_bytes(b"RIFF")
        self.ref = self.root / "a.txt"
        self.ref.write_text("Oʻzbekiston gʻalaba", encoding="utf-8")
        p = mock.patch.object(sc, "prepare", side_effect=lambda a, w, i: (w / f"{i}.wav", 3.0))
        self.prepare = p.start()
        self.addCleanup(p.stop)
        self.scribe_calls = []

        def runner(env, model, language):
            def run(speech, duration):
                self.scribe_calls.append((model, language, duration))
                return [{"t": "O'zbekiston", "s": 0.1, "e": 0.8}, {"t": "g'alaba", "s": 0.9, "e": 1.5}]
            return run

        p = mock.patch.object(sc, "scribe_runner", side_effect=runner)
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch.object(sc, "run_whisper", return_value=[{"word": "Uzbekiston", "start": 0.0, "end": 0.7},
                                                                {"word": "galaba", "start": 0.8, "end": 1.4}])
        self.whisper = p.start()
        self.addCleanup(p.stop)

    def run_cli(self, *args, env=None, answer="", interactive=False):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = sc.main(["--pair", str(self.audio), str(self.ref), *args],
                           env={"ELEVENLABS_API_KEY": KEY} if env is None else env,
                           ask=lambda _q: answer, interactive=interactive)
        return code, out.getvalue(), err.getvalue()

    def test_the_plan_is_printed_and_a_dry_run_calls_nothing(self):
        code, out, _ = self.run_cli("--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("Will call: ElevenLabs POST /v1/speech-to-text, model scribe_v2", out)
        self.assertIn("PAID", out)
        self.assertIn("Will run: local Whisper base", out)
        self.assertIn("ELEVENLABS_API_KEY: set", out)
        self.assertNotIn(KEY, out)
        self.assertEqual(self.scribe_calls, [])
        self.whisper.assert_not_called()

    def test_without_a_yes_nothing_is_sent(self):
        for kw in ({"interactive": False}, {"interactive": True, "answer": "no"}, {"interactive": True, "answer": ""}):
            code, out, _ = self.run_cli(**kw)
            self.assertEqual(code, 1, kw)
            self.assertIn("Nothing was sent.", out)
        self.assertEqual(self.scribe_calls, [])

    def test_a_typed_yes_or_the_flag_sends_once_per_recording_and_reports_both_engines(self):
        code, out, _ = self.run_cli(interactive=True, answer="yes")
        self.assertEqual(code, 0)
        code, out, _ = self.run_cli("--yes", "--json", str(self.root / "rows.json"))
        self.assertEqual(code, 0)
        self.assertEqual(self.scribe_calls, [("scribe_v2", None, 3.0)] * 2, "the job's model, no language, as the job sends")
        rows = json.loads((self.root / "rows.json").read_text(encoding="utf-8"))
        by = {r["engine"]: r for r in rows}
        self.assertEqual((by["scribe"]["wer"], by["scribe"]["words"], by["scribe"]["timed"]), (0.0, 2, 1.0))
        self.assertEqual(by["whisper"]["wer"], 1.0)
        self.assertEqual(by["whisper"]["model"], "base")
        self.assertNotIn(KEY, out)

    def test_another_scribe_model_and_a_language_can_be_measured(self):
        self.run_cli("--yes", "--engines", "scribe", "--scribe-model", "scribe_v3", "--language", "uz")
        self.assertEqual(self.scribe_calls, [("scribe_v3", "uz", 3.0)])
        self.whisper.assert_not_called()

    def test_scribe_asked_without_a_key_stops_before_anything_never_a_whisper_only_table(self):
        code, out, err = self.run_cli("--yes", env={})
        self.assertEqual(code, 2)
        self.assertIn("ELEVENLABS_API_KEY is not set", err)
        self.assertEqual(self.scribe_calls, [])
        self.whisper.assert_not_called()
        self.prepare.assert_not_called()

    def test_whisper_alone_needs_no_key_and_spends_nothing(self):
        code, out, _ = self.run_cli("--engines", "whisper", env={})
        self.assertEqual(code, 0)
        self.assertNotIn("Will call", out)
        self.assertEqual(self.scribe_calls, [])

    def test_a_failing_engine_is_reported_by_its_code_never_as_a_number(self):
        def broke(env, model, language):
            def run(speech, duration):
                raise AdapterError(E_QUOTA, "the transcription failed (HTTP 402, insufficient_credits); nothing was charged")
            return run

        with mock.patch.object(sc, "scribe_runner", side_effect=broke):
            code, out, _ = self.run_cli("--yes", "--json", str(self.root / "rows.json"))
        self.assertEqual(code, 0)
        self.assertIn("failed: quota", out)
        rows = {r["engine"]: r for r in json.loads((self.root / "rows.json").read_text(encoding="utf-8"))}
        self.assertNotIn("wer", rows["scribe"])
        self.assertEqual(rows["whisper"]["ok"], True, "the other engine still ran, and was not put in Scribe's place")

    def test_bad_arguments_are_refused_before_anything(self):
        self.assertEqual(self.run_cli("--engines", "whisper,gemini")[0], 2)
        self.assertEqual(self.run_cli("--language", "uzbek")[0], 2)
        self.ref.unlink()
        self.assertEqual(self.run_cli()[0], 2)
        self.prepare.assert_not_called()


class ScribesOwnAnswer(unittest.TestCase):
    """The Scribe column counts the vendor's answer, not the job's: the job leaves untimed words out, so a share of timed
    words computed after that is 100 % by construction (rule 5: a default is not a measurement)."""

    def test_two_of_four_untimed_words_read_half_timed_out_of_four_and_wer_counts_all_four(self):
        from modules.capabilities import voice_video as vv
        from tests.test_capabilities import FakeResp

        body = {"language_code": "uzb", "text": "x", "words": [
            {"text": "Oʻzbekiston", "start": 0.1, "end": 0.8, "type": "word"},
            {"text": " ", "start": 0.8, "end": 0.9, "type": "spacing"},
            {"text": "gʻalaba", "start": None, "end": None, "type": "word"},
            {"text": "qozondi", "start": 1.6, "end": 2.2, "type": "word"},
            {"text": "bugun", "start": 2.3, "end": None, "type": "word"},
            {"text": "(applause)", "start": 2.6, "end": 2.9, "type": "audio_event"}]}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            audio, ref = root / "a.wav", root / "a.txt"
            audio.write_bytes(b"RIFF")
            ref.write_text("Oʻzbekiston gʻalaba qozondi bugun", encoding="utf-8")

            def prepare(a, work, i):
                speech = work / f"{i}.wav"
                speech.write_bytes(b"RIFF")
                return speech, 3.0

            sent = []

            def call(self_, method, url, **kw):
                sent.append(kw)
                return FakeResp(200, body)

            with mock.patch.object(sc, "prepare", side_effect=prepare), \
                    mock.patch.object(vv.VoiceVideoAdapter, "_call", call), \
                    contextlib.redirect_stdout(io.StringIO()):
                code = sc.main(["--pair", str(audio), str(ref), "--engines", "scribe", "--yes", "--json", str(root / "r.json")],
                               env={"ELEVENLABS_API_KEY": KEY})
            self.assertEqual(code, 0)
            (row,) = json.loads((root / "r.json").read_text(encoding="utf-8"))
        self.assertEqual(len(sent), 1)
        self.assertEqual(row["words"], 4, "every word the vendor returned, never only the ones the job keeps")
        self.assertEqual(row["timed"], 0.5)
        self.assertEqual(row["wer"], 0.0, "WER is over every word heard, timed or not")

    def test_the_job_still_gets_only_the_timed_words(self):
        from modules.capabilities import voice_video as vv
        from tests.test_capabilities import FakeResp

        body = {"language_code": "uzb", "words": [{"text": "a", "start": 0.1, "end": 0.2, "type": "word"},
                                                  {"text": "b", "start": None, "end": None, "type": "word"}]}
        with tempfile.TemporaryDirectory() as tmp:
            speech = Path(tmp) / "s.wav"
            speech.write_bytes(b"RIFF")
            a = vv.VoiceVideoAdapter(env={"ELEVENLABS_API_KEY": KEY})
            with mock.patch.object(vv.VoiceVideoAdapter, "_call", lambda *x, **kw: FakeResp(200, body)):
                self.assertEqual([w["t"] for w in a.scribe(speech, 10)], ["a"])
                self.assertEqual([w["t"] for w in a.scribe(speech, 10, raw=True)], ["a", "b"])


if __name__ == "__main__":
    unittest.main()
