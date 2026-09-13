"""AI b-roll decision layer (MiniMax H3) — pure, offline.

The rules that keep it safe and cheap: clip length is clamped into H3's 4-15s
window, only keyworded sections are eligible, the hook and longest sections win
a bounded budget, the prompt is the section's own subject with captions
suppressed, and the client is dormant unless a key + flag are set (no network in
any of these tests)."""

import unittest
from unittest.mock import MagicMock

from modules import minimax_broll as mb


class ClampTestCase(unittest.TestCase):
    def test_clamps_into_window(self):
        self.assertEqual(mb.clamp_duration(2), 4)
        self.assertEqual(mb.clamp_duration(9), 9)
        self.assertEqual(mb.clamp_duration(40), 15)

    def test_bad_input_falls_back_to_min(self):
        self.assertEqual(mb.clamp_duration("x"), 4)
        self.assertEqual(mb.clamp_duration(None), 4)
        self.assertEqual(mb.clamp_duration(-3), 4)


class BuildPromptTestCase(unittest.TestCase):
    def test_subject_first_then_topic_and_suppression(self):
        p = mb.build_prompt("Fall of Rome", ["roman legion", "battle"])
        self.assertIn("roman legion", p)
        self.assertIn("Fall of Rome", p)
        self.assertIn("no captions", p)

    def test_falls_back_to_topic_when_no_keywords(self):
        p = mb.build_prompt("Deep sea mysteries", [])
        self.assertIn("Deep sea mysteries", p)
        self.assertTrue(p.strip())

    def test_never_empty(self):
        self.assertTrue(mb.build_prompt("", []).strip())


class SelectSpecsTestCase(unittest.TestCase):
    def _sections(self):
        return [
            {"keywords": ["hook shot"], "duration": 5},      # 0: hook
            {"keywords": [], "duration": 20},                # 1: no keywords → ineligible
            {"keywords": ["ancient ruins"], "duration": 30}, # 2: longest eligible
            {"keywords": ["quiet street"], "duration": 6},   # 3
        ]

    def test_picks_hook_then_longest_within_budget(self):
        specs = mb.select_specs(self._sections(), "History", max_clips=2)
        idxs = [s.section_index for s in specs]
        self.assertEqual(idxs, [0, 2])          # hook + longest, in section order
        self.assertTrue(all(4 <= s.duration_seconds <= 15 for s in specs))
        self.assertEqual(specs[0].keyword, "hook shot")

    def test_zero_budget_returns_nothing(self):
        self.assertEqual(mb.select_specs(self._sections(), "History", max_clips=0), [])

    def test_no_eligible_sections_returns_nothing(self):
        secs = [{"keywords": [], "duration": 5}, {"keywords": "", "duration": 6}]
        self.assertEqual(mb.select_specs(secs, "History", max_clips=3), [])

    def test_accepts_objects_not_just_dicts(self):
        class S:
            def __init__(self, kw, d):
                self.keywords = kw
                self.duration = d
        specs = mb.select_specs([S(["temple"], 8)], "History", max_clips=1)
        self.assertEqual(len(specs), 1)
        self.assertEqual(specs[0].keyword, "temple")
        self.assertEqual(specs[0].duration_seconds, 8)


class SummaryTestCase(unittest.TestCase):
    def test_honest_counts(self):
        r = mb.GenerationResult(attempted=2, generated=1, model="MiniMax-H3", by_section={2: "/x/gen_2.mp4"})
        s = mb.summarize(r)
        self.assertEqual(s["attempted"], 2)
        self.assertEqual(s["generated"], 1)
        self.assertEqual(s["sections"], [2])
        self.assertEqual(s["model"], "MiniMax-H3")


class ClientGatingTestCase(unittest.TestCase):
    def test_generate_returns_none_without_key_no_network(self):
        from modules.minimax_client import MiniMaxClient
        client = MiniMaxClient(api_key="")   # no key → dormant
        # session must never be called; prove it by making any HTTP call explode
        client.session = MagicMock()
        client.session.post.side_effect = AssertionError("no network without a key")
        client.session.get.side_effect = AssertionError("no network without a key")
        spec = mb.GenerationSpec(prompt="x", duration_seconds=6, section_index=0, keyword="x")
        self.assertIsNone(client.generate(spec, "/tmp/should_not_exist.mp4"))


class FetcherGenerateBrollTestCase(unittest.TestCase):
    def _fetcher(self, tmp):
        from modules.media_fetcher import MediaFetcher
        # Bypass __init__ so no real OUTPUT_DIR / Pexels session is created.
        f = MediaFetcher.__new__(MediaFetcher)
        f.video_dir = tmp
        f.video_terms = {}
        return f

    def test_disabled_is_a_noop(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as d:
            f = self._fetcher(Path(d))
            sections = [{"keywords": ["temple"], "duration": 6}]
            with patch("config.MINIMAX_BROLL_ENABLED", False):
                result = f.generate_broll(sections, "History", client=MagicMock())
        self.assertEqual(result.generated, 0)
        self.assertEqual(f.video_terms, {})

    def test_enabled_records_generated_clips(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as d:
            f = self._fetcher(Path(d))
            sections = [
                {"keywords": ["hook"], "duration": 5},
                {"keywords": ["ruins"], "duration": 20},
            ]
            client = MagicMock()
            client.generate.side_effect = lambda spec, dest: dest   # "generated" the file
            with patch("config.MINIMAX_BROLL_ENABLED", True), \
                    patch("config.MINIMAX_BROLL_MAX_CLIPS", 2):
                result = f.generate_broll(sections, "History", client=client)
        self.assertEqual(result.attempted, 2)
        self.assertEqual(result.generated, 2)
        self.assertEqual(len(f.video_terms), 2)
        # each generated clip is tagged with its section keyword for broll_match
        self.assertIn("hook", f.video_terms.values())
        self.assertIn("ruins", f.video_terms.values())

    def test_per_clip_failure_falls_back(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as d:
            f = self._fetcher(Path(d))
            sections = [{"keywords": ["hook"], "duration": 5}, {"keywords": ["ruins"], "duration": 20}]
            client = MagicMock()
            # one clip generates, the other returns None (falls back to stock)
            client.generate.side_effect = [Path(d) / "gen_0.mp4", None]
            with patch("config.MINIMAX_BROLL_ENABLED", True), \
                    patch("config.MINIMAX_BROLL_MAX_CLIPS", 2):
                result = f.generate_broll(sections, "History", client=client)
        self.assertEqual(result.attempted, 2)
        self.assertEqual(result.generated, 1)
        self.assertEqual(len(f.video_terms), 1)


if __name__ == "__main__":
    unittest.main()
