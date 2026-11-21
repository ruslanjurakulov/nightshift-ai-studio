"""Subtitle rendering cost.

Daily Video run #6 was killed mid-render — the runner shut down, ffmpeg
processes terminated, no Python traceback. The script had 554 words, and the
compositor renders TWO full-width text images per word (the white line, plus a
masked copy stacked over it to highlight the spoken word), so it was asking
ImageMagick for 1108 rasters and holding all of them at once.

The white base line is byte-for-byte identical for every word of the same line.
These tests pin down that it is now rendered once per line rather than once per
word, and — just as importantly — that the clips built from it are still
separate, independently timed clips.
"""

import unittest
from unittest.mock import patch

from modules.compositor import Compositor


def word_specs(lines: list[list[str]], seconds_per_word: float = 0.4) -> list[dict]:
    """The shape subtitle_generator.word_clips produces: one entry per word,
    each repeating its own line so the highlight can move along it."""
    specs, t = [], 0.0
    for words in lines:
        for i, word in enumerate(words):
            specs.append({
                "word": word,
                "chunk_words": list(words),
                "word_index_in_line": i,
                "start": t,
                "end": t + seconds_per_word,
            })
            t += seconds_per_word
    return specs


class FakeTextClip:
    """Stands in for a rendered TextClip. The outplace setters return copies,
    exactly as moviepy's do, so the test sees real clip independence."""

    def __init__(self, text, color):
        self.text, self.color = text, color
        self.start = self.duration = self.position = None

    def _copy(self):
        other = FakeTextClip(self.text, self.color)
        other.start, other.duration, other.position = self.start, self.duration, self.position
        return other

    def set_start(self, t):
        c = self._copy(); c.start = t; return c

    def set_duration(self, d):
        c = self._copy(); c.duration = d; return c

    def set_position(self, p):
        c = self._copy(); c.position = p; return c


class SubtitleRenderCostTestCase(unittest.TestCase):
    def _compositor(self):
        # __init__ makes directories; only the caches matter here.
        comp = Compositor.__new__(Compositor)
        comp._text_clips = {}
        return comp

    def test_a_line_is_rendered_once_however_many_words_it_has(self):
        comp = self._compositor()
        specs = word_specs([["one", "two", "three", "four"]])

        with patch.object(Compositor, "_render_text_clip",
                          side_effect=FakeTextClip, autospec=False) as render:
            clips = comp._build_subtitle_clips(specs)

        # Four words, two layers each: eight clips, as before.
        self.assertEqual(len(clips), 8)
        # But five renders: one white base line + four distinct highlights.
        self.assertEqual(render.call_count, 5)
        white = [c for c in render.call_args_list if c.args[1] == "white"]
        self.assertEqual(len(white), 1, "the white base line must render once")

    def test_the_saving_grows_with_the_script(self):
        # 140 lines of four words is the shape of the 554-word script that died.
        comp = self._compositor()
        specs = word_specs([[f"w{i}{j}" for j in range(4)] for i in range(140)])

        with patch.object(Compositor, "_render_text_clip", side_effect=FakeTextClip) as render:
            clips = comp._build_subtitle_clips(specs)

        self.assertEqual(len(clips), 560 * 2)
        # 140 white lines + 560 highlights, instead of 1120 renders.
        self.assertEqual(render.call_count, 140 + 560)
        self.assertLess(render.call_count, len(clips))

    def test_clips_sharing_a_render_are_still_independently_timed(self):
        """The cache must not make the four words of a line share one timing."""
        comp = self._compositor()
        specs = word_specs([["one", "two", "three", "four"]], seconds_per_word=0.5)

        with patch.object(Compositor, "_render_text_clip", side_effect=FakeTextClip):
            clips = comp._build_subtitle_clips(specs)

        whites = [c for c in clips if c.color == "white"]
        self.assertEqual([c.start for c in whites], [0.0, 0.5, 1.0, 1.5])
        for c in whites:
            self.assertAlmostEqual(c.duration, 0.5)
        # Same text, four distinct objects — a copy each, not one clip reused.
        self.assertEqual(len({id(c) for c in whites}), 4)

    def test_the_cached_entry_itself_is_never_mutated(self):
        comp = self._compositor()
        specs = word_specs([["one", "two"]])

        with patch.object(Compositor, "_render_text_clip", side_effect=FakeTextClip):
            comp._build_subtitle_clips(specs)

        for cached in comp._text_clips.values():
            self.assertIsNone(cached.start, "the cached render kept a timing")
            self.assertIsNone(cached.duration)
            self.assertIsNone(cached.position)


if __name__ == "__main__":
    unittest.main()
