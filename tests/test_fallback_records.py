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

from modules import audio_mixer, image_providers as ip
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


class MainWiring(unittest.TestCase):
    def setUp(self):
        src = MAIN.read_text()
        fn = next(n for n in ast.walk(ast.parse(src)) if isinstance(n, ast.FunctionDef) and n.name == "run")
        self.run_src = ast.get_source_segment(src, fn)

    def test_the_voice_event_carries_what_voice_it_was(self):
        body = self.run_src
        emit = body[body.index("events.VOICE_COMPLETED"):]
        self.assertIn("metadata=mixer.describe_voice()", emit[:300])

    def test_the_still_event_says_how_many_were_wanted_and_which_scenes_fell_back(self):
        body = self.run_src
        call = body[body.index("events.IMAGE_GENERATED"):]
        self.assertIn('"attempted"', call[:500])
        self.assertIn('"missing_sections"', call[:500])

    def test_a_scene_that_fell_back_is_reported_even_when_no_still_came_back(self):
        body = self.run_src
        # The event used to sit inside `if gen_images:`, so zero stills of three
        # asked for left no trace at all.
        gate = body.index("images_missing")
        self.assertLess(gate, body.index("events.IMAGE_GENERATED"))
        self.assertIn("if gen_images or", body[gate - 80:gate + 80])


if __name__ == "__main__":
    unittest.main()
