"""Shorts: the window, the metadata, and the config that keeps it off.

The property that matters most here is that a Short can never make a run worse.
It happens strictly after a long video has published, it is off unless a channel
turns it on, and every failure path leaves the long video exactly where it was.
"""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from modules import shorts
from modules.channels import AgentConfig
from modules.state_store import StateStore


def channel(shorts_config=None):
    return SimpleNamespace(
        channel_id="default",
        agent=SimpleNamespace(shorts=shorts_config if shorts_config is not None else {}),
    )


class ShortsConfigTestCase(unittest.TestCase):
    def test_shorts_are_off_unless_asked_for(self):
        # A Short is another ~1600 quota units out of 10,000 a day. Nothing may
        # start spending that because a key was missing.
        self.assertFalse(shorts.ShortsConfig.from_channel(channel()).enabled)
        self.assertFalse(shorts.ShortsConfig.from_channel(channel({})).enabled)
        self.assertFalse(shorts.ShortsConfig.from_channel(None).enabled)

    def test_only_an_explicit_true_turns_them_on(self):
        for value in ("true", 1, "yes", None, {}):
            with self.subTest(value=value):
                config = shorts.ShortsConfig.from_channel(channel({"enabled": value}))
                self.assertFalse(config.enabled)
        self.assertTrue(shorts.ShortsConfig.from_channel(channel({"enabled": True})).enabled)

    def test_a_nonsense_duration_falls_back_rather_than_raising(self):
        config = shorts.ShortsConfig.from_channel(channel({"enabled": True, "max_seconds": "soon"}))
        self.assertEqual(config.max_seconds, shorts.MAX_SECONDS)

    def test_a_duration_is_clamped_to_what_youtube_accepts(self):
        long_one = shorts.ShortsConfig.from_channel(channel({"enabled": True, "max_seconds": 600}))
        short_one = shorts.ShortsConfig.from_channel(channel({"enabled": True, "max_seconds": 2}))
        self.assertEqual(long_one.max_seconds, shorts.MAX_SECONDS)
        self.assertEqual(short_one.max_seconds, shorts.MIN_SECONDS)

    def test_a_broken_channel_object_reads_as_off(self):
        class Exploding:
            @property
            def agent(self):
                raise RuntimeError("no")

        self.assertFalse(shorts.ShortsConfig.from_channel(Exploding()).enabled)

    def test_the_agent_config_round_trips_the_setting(self):
        config = AgentConfig.from_dict({"shorts": {"enabled": True, "max_seconds": 30}})
        self.assertEqual(config.shorts["enabled"], True)
        self.assertEqual(AgentConfig.from_dict(config.to_dict()).shorts, config.shorts)


class HookWindowTestCase(unittest.TestCase):
    def test_the_window_is_the_hook_section(self):
        self.assertAlmostEqual(shorts.hook_window([{"start_ms": 0, "end_ms": 28000}]), 28.0)

    def test_a_long_hook_is_trimmed_to_the_ceiling(self):
        self.assertEqual(shorts.hook_window([{"end_ms": 200000}]), shorts.MAX_SECONDS)

    def test_a_tiny_hook_is_extended_to_the_floor(self):
        self.assertEqual(shorts.hook_window([{"end_ms": 3000}]), shorts.MIN_SECONDS)

    def test_a_channel_ceiling_narrows_the_window(self):
        self.assertEqual(shorts.hook_window([{"end_ms": 200000}], max_seconds=30), 30.0)

    def test_an_unusable_timeline_produces_no_short_rather_than_a_guess(self):
        for timeline in ([], None, [{}], [{"end_ms": 0}], [{"end_ms": "soon"}]):
            with self.subTest(timeline=timeline):
                self.assertIsNone(shorts.hook_window(timeline))


class ShortMetadataTestCase(unittest.TestCase):
    def test_the_tag_survives_a_title_that_has_to_be_trimmed(self):
        title = shorts.short_title("T" * 200)
        self.assertLessEqual(len(title), 100)
        # The tag is what makes YouTube treat the upload as a Short, so it is
        # never the part that gets cut.
        self.assertTrue(title.endswith("#Shorts"))

    def test_a_short_title_is_left_alone(self):
        self.assertEqual(shorts.short_title("A Title"), "A Title #Shorts")

    def test_the_description_points_at_the_long_video(self):
        text = shorts.short_description("A Title", "https://youtu.be/abc")
        self.assertIn("https://youtu.be/abc", text)

    def test_the_link_is_above_the_fold(self):
        # YouTube collapses a description after ~3 lines, so the funnel link must
        # be on the very first line where it is one tap away, not buried.
        text = shorts.short_description("A Title", "https://youtu.be/abc")
        first_line = text.splitlines()[0]
        self.assertIn("https://youtu.be/abc", first_line)

    def test_the_description_has_a_call_to_action(self):
        text = shorts.short_description("A Title", "https://youtu.be/abc").lower()
        self.assertIn("full", text)  # "Full video" / "full story"

    def test_the_hook_is_woven_in_when_given(self):
        text = shorts.short_description("A Title", "https://youtu.be/abc",
                                        hook="A stunning fact you never knew")
        self.assertIn("A stunning fact you never knew", text)

    def test_hashtags_tag_it_as_a_short(self):
        self.assertIn("#Shorts", shorts.short_description("A Title", "https://youtu.be/abc"))
        self.assertIn("#Shorts", shorts.short_description("A Title", None))

    def test_no_url_means_no_broken_link(self):
        text = shorts.short_description("A Title", None)
        self.assertNotIn("Full video", text)
        self.assertNotIn("http", text)


class ShortsStateTestCase(unittest.TestCase):
    def test_a_short_is_its_own_row_that_names_its_parent(self):
        with StateStore(":memory:") as store:
            store.record_video(video_id="long1", topic="T", title="Long")
            store.record_video(
                video_id="short1", topic="T", title="Long #Shorts",
                video_format="short", parent_video_id="long1",
            )
            rows = {v["video_id"]: v for v in store.list_videos(limit=10)}

        # Existing rows are long-form by default — a fact about the history,
        # not an assumption written over it.
        self.assertEqual(rows["long1"]["video_format"], "long")
        self.assertEqual(rows["short1"]["video_format"], "short")
        self.assertEqual(rows["short1"]["parent_video_id"], "long1")
        self.assertIsNone(rows["long1"]["parent_video_id"] or None)


class ShortRenderFailureTestCase(unittest.TestCase):
    def test_an_unreadable_source_returns_none_rather_than_raising(self):
        # Whether moviepy is installed or not, this must not raise: the long
        # video has already published by the time a Short is attempted, and an
        # exception here would turn a successful run into a failed one.
        result = shorts.render_short(
            source_video=Path("/nonexistent/never-rendered.mp4"),
            out_path=Path(tempfile.gettempdir()) / "chronos-test-short.mp4",
            seconds=20.0,
        )
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
