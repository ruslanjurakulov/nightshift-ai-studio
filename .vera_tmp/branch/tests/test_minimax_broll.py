"""AI b-roll decision layer (MiniMax H3) — pure, offline.

The rules that keep it safe and cheap: clip length is fitted to the model
(H3 4-15s, Hailuo 6 or 10s), only keyworded sections are eligible, the hook and longest sections win
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


class PerModelDurationTestCase(unittest.TestCase):
    """A length the model does not accept is rejected by the provider after
    the run already paid for topic, research and script — so it is fitted to
    the configured model before the request is built."""

    def test_h3_is_a_4_to_15_second_window(self):
        self.assertEqual(mb.clamp_duration(2, "MiniMax-H3"), 4)
        self.assertEqual(mb.clamp_duration(9, "MiniMax-H3"), 9)
        self.assertEqual(mb.clamp_duration(40, "MiniMax-H3"), 15)

    def test_h3_max_starts_at_5_seconds(self):
        self.assertEqual(mb.clamp_duration(4, "MiniMax-H3-Max"), 5)

    def test_hailuo_accepts_only_6_or_10_seconds(self):
        for asked, sent in ((2, 6), (7, 6), (8, 6), (9, 10), (30, 10)):
            with self.subTest(asked=asked):
                self.assertEqual(mb.clamp_duration(asked, "MiniMax-Hailuo-2.3"), sent)
        self.assertEqual(mb.clamp_duration(None, "MiniMax-Hailuo-2.3"), 6)

    def test_kling_legacy_endpoint_takes_5_or_10(self):
        self.assertEqual(mb.clamp_duration(12, "kling-v2-6"), 10)
        self.assertEqual(mb.clamp_duration(3, "kling-v2-6"), 5)

    def test_unknown_model_keeps_the_old_window(self):
        self.assertEqual(mb.clamp_duration(40, "some-new-model"), 15)

    def test_select_specs_fits_lengths_to_the_model(self):
        secs = [{"keywords": ["hook"], "duration": 13}]
        self.assertEqual(mb.select_specs(secs, "T", max_clips=1, model="MiniMax-H3")[0].duration_seconds, 13)
        self.assertEqual(mb.select_specs(secs, "T", max_clips=1,
                                         model="MiniMax-Hailuo-2.3")[0].duration_seconds, 10)


class RejectionTestCase(unittest.TestCase):
    def test_auth_and_quota_get_opposite_remedies(self):
        auth = mb.rejection("Kling", "kling-v2-6", status=401, key_hint="KLING_API_KEY")
        quota = mb.rejection("Kling", "kling-v2-6", status=402)
        self.assertIn("KLING_API_KEY", auth.remedy)
        self.assertIn("top up", quota.remedy)
        self.assertNotIn("top up", auth.remedy)

    def test_vendor_code_overrides_the_status(self):
        e = mb.rejection("Wan", "wan2.7-t2v", status=400, category=mb.QUOTA, code="Arrearage")
        self.assertIn("top up", e.remedy)
        self.assertIn("Arrearage", str(e))

    def test_network_failure_says_re_run(self):
        e = mb.rejection("MiniMax", "MiniMax-H3", message="ConnectionError")
        self.assertIn("re-run", e.remedy)
        self.assertIn("did not answer", str(e))

    def test_vendor_message_is_one_bounded_line(self):
        e = mb.rejection("X", "m", status=400, message="line one\nline two " + "x" * 500)
        self.assertNotIn("\n", str(e))
        self.assertLess(len(e.reason), 300)


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

    def test_a_missing_clip_stops_the_run_instead_of_becoming_stock(self):
        # CLAUDE.md #4: with generated b-roll on, a section whose clip did not
        # come back used to quietly become stock footage. Now the run stops
        # and says why.
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as d:
            f = self._fetcher(Path(d))
            sections = [{"keywords": ["hook"], "duration": 5}, {"keywords": ["ruins"], "duration": 20}]
            client = MagicMock()
            client.generate.side_effect = [Path(d) / "gen_0.mp4", None]
            with patch("config.MINIMAX_BROLL_ENABLED", True), \
                    patch("config.MINIMAX_BROLL_MAX_CLIPS", 2), \
                    self.assertRaises(mb.VideoModelUnavailable) as ctx:
                f.generate_broll(sections, "History", client=client)
        self.assertIn("1 of 2", str(ctx.exception))
        self.assertIn("re-run", ctx.exception.remedy)

    def test_a_provider_refusal_stops_before_the_next_paid_submit(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as d:
            f = self._fetcher(Path(d))
            sections = [{"keywords": ["hook"], "duration": 5}, {"keywords": ["ruins"], "duration": 20}]
            client = MagicMock()
            client.generate.side_effect = mb.rejection("MiniMax", "MiniMax-H3", status=401)
            with patch("config.MINIMAX_BROLL_ENABLED", True), \
                    patch("config.MINIMAX_BROLL_MAX_CLIPS", 2), \
                    self.assertRaises(mb.VideoModelUnavailable):
                f.generate_broll(sections, "History", client=client)
        self.assertEqual(client.generate.call_count, 1)

    def test_an_unconfigured_preflight_stops_before_any_request(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from modules.minimax_client import MiniMaxClient
        with tempfile.TemporaryDirectory() as d:
            f = self._fetcher(Path(d))
            client = MiniMaxClient(api_key="k", model="MiniMax-H3")
            client.v2_query_path = ""
            client.session = MagicMock()
            client.session.post.side_effect = AssertionError("no request before preflight passes")
            with patch("config.MINIMAX_BROLL_ENABLED", True), \
                    self.assertRaises(mb.VideoModelUnavailable) as ctx:
                f.generate_broll([{"keywords": ["hook"], "duration": 5}], "History", client=client)
        self.assertIn("MINIMAX_V2_QUERY_PATH", ctx.exception.remedy)


if __name__ == "__main__":
    unittest.main()
