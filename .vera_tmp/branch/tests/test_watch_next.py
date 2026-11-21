"""Watch-next: the "▶ WATCH NEXT" description link that chains a video to
another of the channel's videos. Rules under test: it picks a real previous
video (same series first, else most recent), never duplicates or overruns the
description, and degrades to a no-op with no history."""

import unittest

from modules import watch_next as wn


def _v(vid, fmt="long", series_id=None, title=""):
    row = {"video_id": vid, "video_format": fmt, "title": title or vid}
    if series_id is not None:
        row["series_id"] = series_id
    return row


class PickNextTestCase(unittest.TestCase):
    def test_most_recent_long_video(self):
        # list_videos is newest-first; the first eligible row wins.
        videos = [_v("newest"), _v("older"), _v("oldest")]
        self.assertEqual(wn.pick_next_video(videos)["video_id"], "newest")

    def test_excludes_current(self):
        videos = [_v("current"), _v("prev")]
        self.assertEqual(wn.pick_next_video(videos, exclude_video_id="current")["video_id"], "prev")

    def test_prefers_same_series(self):
        videos = [_v("other"), _v("seriesvid", series_id="s1"), _v("more")]
        picked = wn.pick_next_video(videos, series_id="s1")
        self.assertEqual(picked["video_id"], "seriesvid")

    def test_falls_back_when_series_has_no_other(self):
        videos = [_v("a"), _v("b")]
        self.assertEqual(wn.pick_next_video(videos, series_id="s-none")["video_id"], "a")

    def test_shorts_excluded(self):
        videos = [_v("s1", fmt="short"), _v("long1")]
        self.assertEqual(wn.pick_next_video(videos)["video_id"], "long1")

    def test_no_history_is_none(self):
        self.assertIsNone(wn.pick_next_video([]))
        self.assertIsNone(wn.pick_next_video(None))
        self.assertIsNone(wn.pick_next_video([_v("only", fmt="short")]))


class BlockTestCase(unittest.TestCase):
    def test_block_has_url_and_title(self):
        block = wn.watch_next_block("abc123", "The Fall of Rome")
        self.assertIn("https://youtu.be/abc123", block)
        self.assertIn("The Fall of Rome", block)

    def test_block_without_title(self):
        block = wn.watch_next_block("abc123")
        self.assertIn("https://youtu.be/abc123", block)
        self.assertTrue(block.startswith("▶ WATCH NEXT"))

    def test_no_id_no_block(self):
        self.assertEqual(wn.watch_next_block(""), "")


class AppendTestCase(unittest.TestCase):
    def test_appends_after_blank_line(self):
        out = wn.append_watch_next("Original description.", wn.watch_next_block("v1", "Next"))
        self.assertIn("Original description.", out)
        self.assertIn("https://youtu.be/v1", out)
        self.assertIn("\n\n", out)

    def test_no_duplicate(self):
        block = wn.watch_next_block("v1", "Next")
        once = wn.append_watch_next("Desc", block)
        twice = wn.append_watch_next(once, block)
        self.assertEqual(once, twice)  # url already present → unchanged

    def test_empty_block_is_noop(self):
        self.assertEqual(wn.append_watch_next("Desc", ""), "Desc")

    def test_over_limit_returns_original(self):
        big = "x" * 4890
        block = wn.watch_next_block("v1", "Next")  # ~40+ chars, pushes over 4900
        out = wn.append_watch_next(big, block, max_len=4900)
        self.assertEqual(out, big)  # unchanged rather than truncated

    def test_empty_description_just_block(self):
        block = wn.watch_next_block("v1")
        self.assertEqual(wn.append_watch_next("", block), block)


class ConfigAndWiringTestCase(unittest.TestCase):
    def test_flag_defaults_on_and_round_trips(self):
        from modules.channels import AgentConfig
        self.assertTrue(AgentConfig().watch_next)
        self.assertTrue(AgentConfig.from_dict({}).watch_next)
        self.assertFalse(AgentConfig.from_dict({"watch_next": False}).watch_next)
        cfg = AgentConfig.from_dict({"watch_next": False})
        self.assertFalse(AgentConfig.from_dict(cfg.to_dict()).watch_next)

    def test_main_wires_watch_next(self):
        import ast
        from pathlib import Path
        tree = ast.parse((Path(__file__).resolve().parent.parent / "main.py").read_text())
        imported = {a.name for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) for a in n.names}
        attrs = {a.attr for a in ast.walk(tree) if isinstance(a, ast.Attribute)}
        self.assertIn("watch_next", imported)
        self.assertIn("pick_next_video", attrs)
        self.assertIn("WATCH_NEXT_LINKED", attrs)

    def test_uploader_accepts_description_suffix(self):
        import inspect
        from modules.youtube_uploader import YouTubeUploader
        self.assertIn("description_suffix", inspect.signature(YouTubeUploader.upload).parameters)


if __name__ == "__main__":
    unittest.main()
