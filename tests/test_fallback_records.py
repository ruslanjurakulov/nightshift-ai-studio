"""D4: where the pipeline keeps a documented soft fallback, the run's record says so.

Refusals already stop a run (a refused still, an unusable clip provider, a missing
ElevenLabs key when ElevenLabs is expected: tests/test_image_refusals.py,
tests/test_voice_preflight.py, tests/test_minimax_broll.py). Two soft cases remain
by design, and CLAUDE.md rule 5 asks that they never read as the thing that was
asked for:

* a generated still the model returned nothing for falls back to stock for that
  one scene (``image_providers`` documents it). The event used to say how many
  stills were generated and nothing about how many were wanted;
* a deployment with no ElevenLabs key and nothing saying it expects one narrates
  in the free Edge voice. The voice event used to carry no metadata, so a video
  in the default voice was indistinguishable from one in a voice somebody chose.

main.py needs the render stack to import, so its wiring is read as source
(as tests/test_video_worker_safety.py does); the rest runs for real.
"""

from __future__ import annotations

import ast
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import audio_mixer, credits, image_providers as ip
from modules.audio_mixer import AudioMixer
from modules.media_fetcher import MediaFetcher

MAIN = Path(__file__).resolve().parent.parent / "main.py"


def _fetcher(d):
    f = MediaFetcher.__new__(MediaFetcher)
    f.image_dir = Path(d)
    f.provenance = {}
    return f


SECTIONS = [{"keywords": ["rome"]}, {"keywords": ["gaul"]}, {"keywords": ["carthage"]}]


class StillsThatDidNotComeBack(unittest.TestCase):
    def generate(self, answers, cap=3):
        client = mock.MagicMock()
        client.generate.side_effect = answers
        with tempfile.TemporaryDirectory() as d, mock.patch.object(ip, "is_enabled", return_value=True):
            f = _fetcher(d)
            made = [Path(d) / f"g{i}.jpg" for i in range(3)]
            paths = f.generate_images(SECTIONS, "Rome", client=client, max_images=cap)
            return f, paths, made

    def test_a_scene_whose_still_never_came_back_is_named(self):
        f, paths, _ = self.generate([Path("a.jpg"), None, Path("c.jpg")])
        self.assertEqual(len(paths), 2)
        self.assertEqual(f.images_missing, [1])
        self.assertEqual(f.images_attempted, 3)

    def test_an_unexpected_error_for_one_scene_counts_as_missing_too(self):
        f, paths, _ = self.generate([Path("a.jpg"), RuntimeError("boom"), Path("c.jpg")])
        self.assertEqual(f.images_missing, [1])

    def test_nothing_is_missing_when_every_still_came_back(self):
        f, _, _ = self.generate([Path("a.jpg"), Path("b.jpg"), Path("c.jpg")])
        self.assertEqual((f.images_missing, f.images_attempted), ([], 3))

    def test_a_run_that_asked_for_no_stills_reports_none_attempted(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(ip, "is_enabled", return_value=False), \
                mock.patch.object(ip, "preflight"):
            f = _fetcher(d)
            f.generate_images(SECTIONS, "Rome")
        self.assertEqual((f.images_missing, f.images_attempted), ([], 0))

    def test_only_the_scenes_that_were_asked_for_count(self):
        f, _, _ = self.generate([Path("a.jpg"), None], cap=2)
        self.assertEqual((f.images_missing, f.images_attempted), ([1], 2))


class VoiceRecord(unittest.TestCase):
    def mixer(self, provider, explicit=False):
        m = AudioMixer.__new__(AudioMixer)
        m.tts_provider = provider
        m.channel = mock.MagicMock()
        m.channel.agent.tts_provider_explicit = explicit
        return m

    def record(self, provider, *, key="", env_explicit=False, run_voice="", channel_explicit=False):
        with mock.patch.multiple(audio_mixer, ELEVENLABS_API_KEY=key, TTS_PROVIDER_EXPLICIT=env_explicit,
                                 ELEVENLABS_RUN_VOICE_ID=run_voice):
            return self.mixer(provider, channel_explicit).describe_voice()

    def test_the_free_voice_an_empty_key_gives_is_recorded_as_a_default_not_a_choice(self):
        self.assertEqual(self.record("edge"), {"provider": "edge", "source": "default"})

    def test_a_channel_that_chose_edge_says_so(self):
        self.assertEqual(self.record("edge", channel_explicit=True), {"provider": "edge", "source": "channel"})

    def test_a_deployment_that_chose_its_provider_says_so(self):
        self.assertEqual(self.record("edge", env_explicit=True), {"provider": "edge", "source": "deployment"})

    def test_elevenlabs_through_a_key_alone_is_a_default_too(self):
        self.assertEqual(self.record("elevenlabs", key="k"), {"provider": "elevenlabs", "source": "default"})

    def test_a_voice_picked_on_the_create_page_is_a_run_choice(self):
        got = self.record("elevenlabs", key="k", run_voice="A" * 20)
        self.assertEqual(got, {"provider": "elevenlabs", "source": "run"})

    def test_the_record_never_carries_a_key_or_a_voice_id(self):
        got = self.record("elevenlabs", key="sk-live-secret", run_voice="B" * 20)
        self.assertNotIn("sk-live-secret", repr(got))
        self.assertNotIn("B" * 20, repr(got))


class VoiceRecordCannotStopARun(unittest.TestCase):
    """A record of the voice is written after the script and the voice are paid
    for: whatever goes wrong while describing it, the run goes on."""

    @classmethod
    def setUpClass(cls):
        try:
            import main
        except Exception as e:   # the render stack (moviepy, whisper) is missing here
            raise unittest.SkipTest(f"main.py cannot be imported here: {type(e).__name__}")
        cls.main = main

    def test_a_good_description_is_recorded(self):
        class M:
            def describe_voice(self):
                return {"provider": "edge", "source": "default"}
        self.assertEqual(self.main._voice_record(M()), {"provider": "edge", "source": "default"})

    def test_a_mixer_without_the_method_records_nothing_and_does_not_raise(self):
        self.assertEqual(self.main._voice_record(object()), {})

    def test_a_describe_that_raises_records_nothing_and_does_not_raise(self):
        class M:
            def describe_voice(self):
                raise RuntimeError("boom")
        self.assertEqual(self.main._voice_record(M()), {})

    def test_a_describe_that_returns_something_odd_records_nothing(self):
        self.assertEqual(self.main._voice_record(mock.MagicMock()), {})


class StillOutcomeRecord(unittest.TestCase):
    """main._record_stills: what the run's record and its ledger say about stills."""

    @classmethod
    def setUpClass(cls):
        try:
            import main
        except Exception as e:
            raise unittest.SkipTest(f"main.py cannot be imported here: {type(e).__name__}")
        cls.main = main

    def record(self, made, missing, attempted):
        from modules import cost_ledger
        costs = cost_ledger.CostLedger()
        fetcher = mock.MagicMock()
        fetcher.images_missing, fetcher.images_attempted = list(missing), attempted
        with mock.patch.object(self.main.events, "emit") as emit, \
                mock.patch.object(self.main.image_providers, "active_provider", return_value="leonardo"):
            self.main._record_stills(costs, fetcher, [Path(f"g{i}.jpg") for i in range(made)], "chan")
        return costs, emit

    def test_a_soft_miss_is_a_completed_event_marked_degraded_not_a_failure(self):
        # The Command Center reads any failed event as a hard failure; a held run whose
        # only fault was a soft image miss must not show FAILED.
        _, emit = self.record(made=0, missing=[0, 1, 2], attempted=3)
        emit.assert_called_once()
        kw = emit.call_args.kwargs
        self.assertEqual(kw["status"], self.main.events.STATUS_COMPLETED)
        self.assertEqual(kw["metadata"], {"generated": 0, "attempted": 3, "missing_sections": [0, 1, 2],
                                          "degraded": True, "provider": "leonardo"})

    def test_a_clean_generation_is_not_degraded(self):
        _, emit = self.record(made=2, missing=[], attempted=2)
        self.assertIs(emit.call_args.kwargs["metadata"]["degraded"], False)

    def test_part_missing_is_degraded_and_the_made_ones_are_counted(self):
        costs, emit = self.record(made=2, missing=[2], attempted=3)
        self.assertIs(emit.call_args.kwargs["metadata"]["degraded"], True)
        self.assertEqual([(e.unit, e.quantity) for e in costs.entries], [("image_generations", 2.0)])

    def test_nothing_asked_for_records_nothing(self):
        costs, emit = self.record(made=0, missing=[], attempted=0)
        emit.assert_not_called()
        self.assertEqual(costs.entries, [])

    def test_no_zero_quantity_ledger_entry_when_no_still_came_back(self):
        costs, _ = self.record(made=0, missing=[0], attempted=1)
        self.assertEqual(costs.entries, [])

    def test_the_event_keys_survive_the_event_log_redaction(self):
        import json
        from modules import event_log
        _, emit = self.record(made=0, missing=[0], attempted=1)
        kept = json.loads(event_log._sanitize(emit.call_args.kwargs["metadata"]))
        self.assertEqual(set(kept), {"generated", "attempted", "missing_sections", "degraded", "provider"})
        self.assertNotIn(event_log._REDACTED, kept.values())


class ZeroQuantityLedgerEntryAndSettlement(unittest.TestCase):
    """Why the helper must not write a zero entry: an unpriced entry, even with
    quantity 0, makes the settlement capture the whole hold instead of the metered
    amount (credits.settle_amount)."""

    PRICES = {"tts_characters": credits.Price(0.001, 0.0)}

    def settle(self, *extra):
        entries = [{"unit": "tts_characters", "quantity": 2000}, *extra]
        return credits.settle_amount(40, entries, self.PRICES)

    def test_a_metered_run_is_charged_what_it_used(self):
        got = self.settle()
        self.assertEqual((got.reason, got.amount), (credits.SETTLE_METERED, 2.0))

    def test_an_unpriced_zero_entry_would_capture_the_whole_hold(self):
        got = self.settle({"unit": "image_generations", "quantity": 0})
        self.assertEqual((got.reason, got.amount), (credits.SETTLE_UNPRICED, 40))


class MainWiring(unittest.TestCase):
    def setUp(self):
        src = MAIN.read_text()
        fn = next(n for n in ast.walk(ast.parse(src)) if isinstance(n, ast.FunctionDef) and n.name == "run")
        self.run_src = ast.get_source_segment(src, fn)

    def test_the_voice_event_carries_what_voice_it_was(self):
        body = self.run_src
        emit = body[body.index("events.VOICE_COMPLETED"):]
        self.assertIn("metadata=_voice_record(mixer)", emit[:300])

    def test_the_qc_call_names_the_card_scenes_of_the_ir_project(self):
        body = self.run_src
        qc = body[body.index("video_qc.run("):]
        self.assertIn("static_scene_ids=video_qc.static_scene_ids(ir_project)", qc[:400])
        self.assertLess(body.index("ir_project = video_ir.write_for_run("), body.index("video_qc.run("))

    def test_run_hands_the_still_outcome_to_the_helper_after_the_generator_stage(self):
        body = self.run_src
        self.assertGreater(body.index("_record_stills(costs, fetcher, gen_images"),
                           body.index("fetcher.generate_images("))


if __name__ == "__main__":
    unittest.main()
