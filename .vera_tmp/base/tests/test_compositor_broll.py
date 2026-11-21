"""The compositor orders each section's clip pool by b-roll relevance.

Growth #63: footage should sit under the narration it matches, not land at
random. `Compositor._ordered_pool` is the decision point — these pin that when
the fetch keywords are known it leads with the relevant clip, that a clip with
no recorded term is sunk but never dropped, and that with no signal it falls
back to the original behaviour (every source still present)."""

import unittest
from pathlib import Path

from modules.compositor import Compositor


class OrderedPoolTestCase(unittest.TestCase):
    def test_relevant_video_leads_the_section(self):
        videos = [Path("/m/calm_beach.mp4"), Path("/m/lava_flow.mp4"), Path("/m/city.mp4")]
        clip_terms = {
            "/m/calm_beach.mp4": "calm beach",
            "/m/lava_flow.mp4": "volcano lava eruption",
            "/m/city.mp4": "city street",
        }
        pool = Compositor._ordered_pool(
            videos, [], section_keywords=["volcano eruption"], clip_terms=clip_terms
        )
        self.assertEqual(pool[0], Path("/m/lava_flow.mp4"))
        # every video is still present — relevance reorders, never drops
        self.assertEqual(set(pool), set(videos))

    def test_untagged_clip_sinks_but_survives(self):
        videos = [Path("/m/unknown.mp4"), Path("/m/volcano.mp4")]
        clip_terms = {"/m/volcano.mp4": "volcano eruption"}  # unknown.mp4 has no term
        pool = Compositor._ordered_pool(
            videos, [], section_keywords=["volcano"], clip_terms=clip_terms
        )
        self.assertEqual(pool[0], Path("/m/volcano.mp4"))
        self.assertIn(Path("/m/unknown.mp4"), pool)

    def test_images_follow_videos_when_ranking(self):
        videos = [Path("/m/v.mp4")]
        images = [Path("/m/a.jpg"), Path("/m/b.jpg")]
        pool = Compositor._ordered_pool(
            videos, images, section_keywords=["anything"], clip_terms={"/m/v.mp4": "anything"}
        )
        self.assertEqual(pool[0], Path("/m/v.mp4"))
        self.assertEqual(set(pool[1:]), set(images))

    def test_no_signal_keeps_all_sources(self):
        videos = [Path("/m/a.mp4"), Path("/m/b.mp4")]
        images = [Path("/m/c.jpg")]
        # neither section keywords nor clip terms → fallback shuffle, all present
        pool = Compositor._ordered_pool(videos, images, section_keywords=None, clip_terms=None)
        self.assertEqual(set(pool), set(videos) | set(images))
        pool2 = Compositor._ordered_pool(videos, images, section_keywords=[], clip_terms={})
        self.assertEqual(set(pool2), set(videos) | set(images))

    def test_empty_inputs(self):
        self.assertEqual(Compositor._ordered_pool([], [], ["k"], {}), [])


if __name__ == "__main__":
    unittest.main()
