"""Tests for modules.ass_captions — the ffmpeg paths' word-highlighted captions.

What would break:
  * a caption shown at the wrong moment (timing, rounding, overlaps stacking
    two lines on screen, an unknown time placed at 0 s);
  * a transcript word that opens an ASS override block or line break;
  * the lines not being the compositor's four-word lines, or the wrong word lit;
  * the look drifting from the MoviePy compositor's (size, colour, stroke,
    position, wrap width);
  * any failure raising into the pipeline instead of keeping the .srt, or the
    .srt (the YouTube caption track) being modified.
"""

import re
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import ass_captions, render_backend
from modules.ass_captions import CaptionStyle


def word_specs(words, start=0.0, step=0.5, per_line=4):
    """The shape SubtitleGenerator.word_clips produces (chunks of four),
    built without importing whisper."""
    timed = [{"word": w, "start": start + i * step, "end": start + i * step + step * 0.8}
             for i, w in enumerate(words)]
    specs = []
    for i in range(0, len(timed), per_line):
        chunk = timed[i:i + per_line]
        for j, w in enumerate(chunk):
            specs.append({"word": w["word"], "line": " ".join(c["word"] for c in chunk),
                          "word_index_in_line": j, "chunk_words": [c["word"] for c in chunk],
                          "start": w["start"], "end": w["end"]})
    return specs


def dialogues(doc):
    return [line for line in doc.splitlines() if line.startswith("Dialogue:")]


def dialogue_fields(line):
    # Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
    parts = line[len("Dialogue: "):].split(",", 9)
    return parts[1], parts[2], parts[9]


class TimeAndColourTestCase(unittest.TestCase):
    def test_ass_time_is_centiseconds_rounded(self):
        self.assertEqual(ass_captions.ass_time(0), "0:00:00.00")
        self.assertEqual(ass_captions.ass_time(1.234), "0:00:01.23")
        self.assertEqual(ass_captions.ass_time(1.235001), "0:00:01.24")
        self.assertEqual(ass_captions.ass_time(3661.5), "1:01:01.50")
        self.assertEqual(ass_captions.ass_time(-2), "0:00:00.00")

    def test_colours_are_bgr(self):
        self.assertEqual(ass_captions.ass_colour("#FFD700"), "&H0000D7FF")
        self.assertEqual(ass_captions.ass_colour("white"), "&H00FFFFFF")
        self.assertEqual(ass_captions.ass_colour("black"), "&H00000000")
        self.assertEqual(ass_captions.ass_colour("#f00"), "&H000000FF")

    def test_unknown_colour_uses_the_default_not_garbage(self):
        with self.assertLogs("modules.ass_captions", "WARNING"):
            self.assertEqual(ass_captions.ass_colour("not-a-colour", "&H0000D7FF"), "&H0000D7FF")


class EscapingTestCase(unittest.TestCase):
    def test_words_cannot_open_override_blocks_or_line_breaks(self):
        for raw in ("{\\b1}bold", "a\\Nb", "tab\there", "new\nline", "}{"):
            out = ass_captions.escape_text(raw)
            self.assertNotIn("{", out)
            self.assertNotIn("}", out)
            self.assertNotIn("\\", out)
            self.assertNotIn("\n", out)

    def test_ordinary_punctuation_and_case_are_kept(self):
        self.assertEqual(ass_captions.escape_text("Rome's,"), "Rome's,")
        self.assertEqual(ass_captions.escape_text("ÉTÉ"), "ÉTÉ")
        self.assertEqual(ass_captions.escape_text(None), "")

    def test_escaped_word_lands_in_the_document_inert(self):
        doc = ass_captions.build_ass(word_specs(["{\\an1}x", "y"]), width=1920, height=1080)
        text = dialogue_fields(dialogues(doc)[0])[2]
        # The only override blocks are the highlight's own.
        self.assertEqual(re.findall(r"\{[^}]*\}", text), ["{\\c&H00D7FF&}", "{\\r}"])


class EventsTestCase(unittest.TestCase):
    def test_one_event_per_word_with_its_own_timing(self):
        ev = ass_captions.caption_events(word_specs(["a", "b", "c"], start=1.0, step=0.5))
        self.assertEqual([(round(s, 2), round(e, 2)) for s, e, _, _ in ev],
                         [(1.0, 1.4), (1.5, 1.9), (2.0, 2.4)])
        self.assertEqual([i for _, _, _, i in ev], [0, 1, 2])

    def test_a_too_short_word_is_held_for_50_ms_like_moviepy(self):
        ev = ass_captions.caption_events([{"word": "x", "start": 2.0, "end": 2.0}])
        self.assertAlmostEqual(ev[0][1] - ev[0][0], 0.05)

    def test_unknown_times_are_skipped_never_placed_at_zero(self):
        specs = [{"word": "lost", "start": None, "end": 1.0},
                 {"word": "nan", "start": float("nan"), "end": 1.0},
                 {"word": "text", "start": "x", "end": 1.0},
                 {"word": "kept", "start": 3.0, "end": 3.4}]
        ev = ass_captions.caption_events(specs)
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0][2], ["kept"])
        self.assertAlmostEqual(ev[0][0], 3.0)

    def test_overlapping_words_never_show_two_lines(self):
        specs = [{"word": "a", "start": 1.0, "end": 1.8},
                 {"word": "b", "start": 1.5, "end": 2.0}]
        ev = ass_captions.caption_events(specs)
        self.assertAlmostEqual(ev[0][1], 1.5)   # cut where the next starts
        for (s1, e1, *_), (s2, *_rest) in zip(ev, ev[1:]):
            self.assertLessEqual(e1, s2)

    def test_same_start_keeps_the_later_word_which_moviepy_draws_on_top(self):
        specs = [{"word": "under", "start": 1.0, "end": 1.4},
                 {"word": "over", "start": 1.0, "end": 1.4}]
        ev = ass_captions.caption_events(specs)
        self.assertEqual([e[2] for e in ev], [["over"]])


class DocumentTestCase(unittest.TestCase):
    WORDS = "the ancient city of Rome was not built in a day".split()

    def test_lines_are_the_compositors_four_word_lines_with_the_spoken_word_lit(self):
        doc = ass_captions.build_ass(word_specs(self.WORDS), width=1920, height=1080)
        lines = dialogues(doc)
        self.assertEqual(len(lines), len(self.WORDS))
        texts = [dialogue_fields(line)[2] for line in lines]
        plain = [re.sub(r"\{[^}]*\}", "", t) for t in texts]
        # 11 words → lines of 4, 4, 3; case is kept (MoviePy does not uppercase).
        self.assertEqual(plain[0], "the ancient city of")
        self.assertEqual(plain[4], "Rome was not built")
        self.assertEqual(plain[8], "in a day")
        self.assertEqual(texts[1], "the {\\c&H00D7FF&}ancient{\\r} city of")
        self.assertEqual(texts[8], "{\\c&H00D7FF&}in{\\r} a day")
        # libass wraps; nothing inserts hard breaks.
        self.assertFalse(any("\\N" in t for t in texts))

    def test_timing_is_written_per_word(self):
        doc = ass_captions.build_ass(word_specs(["a", "b"], start=61.0, step=0.5),
                                     width=1920, height=1080)
        starts_ends = [dialogue_fields(line)[:2] for line in dialogues(doc)]
        self.assertEqual(starts_ends, [("0:01:01.00", "0:01:01.40"),
                                       ("0:01:01.50", "0:01:01.90")])

    def test_style_matches_the_moviepy_compositor(self):
        doc = ass_captions.build_ass(word_specs(["x"]), width=1920, height=1080,
                                     style=CaptionStyle(), font="DejaVu Sans")
        self.assertIn("PlayResX: 1920", doc)
        self.assertIn("PlayResY: 1080", doc)
        self.assertIn("WrapStyle: 1", doc)   # greedy wrap, like ImageMagick caption:
        style = next(line for line in doc.splitlines() if line.startswith("Style: "))
        f = style[len("Style: "):].split(",")
        self.assertEqual(f[1], "DejaVu Sans")
        self.assertEqual(f[2], "70")               # 60 pt em ≈ 70 libass (ascent+descent)
        self.assertEqual(f[3], "&H00FFFFFF")       # white line
        self.assertEqual(f[5], "&H00000000")       # black stroke
        self.assertEqual(f[7], "-1")               # bold
        self.assertEqual(f[15], "1")               # outline + shadow style
        self.assertEqual(f[16], "3")               # stroke width 3
        self.assertEqual(f[17], "0")               # no shadow
        self.assertEqual(f[18], "8")               # top-centre anchored …
        self.assertEqual((f[19], f[20]), ("50", "50"))   # … wrapping in W - 100 …
        self.assertEqual(f[21], "864")             # … with its top at 0.80 × H

    def test_position_scales_with_the_frame(self):
        doc = ass_captions.build_ass(word_specs(["x"]), width=320, height=240)
        style = next(line for line in doc.splitlines() if line.startswith("Style: "))
        self.assertEqual(style.split(",")[21], "192")

    def test_configured_style_reads_the_compositor_settings(self):
        import config

        st = ass_captions.configured_style()
        self.assertEqual(st.font, "Arial")
        self.assertTrue(st.bold)
        self.assertEqual(st.font_size, float(config.SUBTITLE_FONT_SIZE))
        self.assertEqual(st.highlight_color, config.SUBTITLE_HIGHLIGHT_COLOR)
        self.assertEqual(st.stroke_width, float(config.SUBTITLE_STROKE_WIDTH))


class _SrtDir(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.srt = self.dir / "subtitles" / "subtitles.srt"
        self.srt.parent.mkdir()
        self.srt_text = "1\n00:00:00,000 --> 00:00:01,000\nhello there\n\n"
        self.srt.write_text(self.srt_text, encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()


class PrepareTestCase(_SrtDir):
    def test_no_word_timestamps_keeps_the_srt(self):
        c = ass_captions.prepare(self.srt, [], width=320, height=240, ffmpeg="unused")
        self.assertEqual((c.path, c.mode), (self.srt, ass_captions.MODE_SRT))
        self.assertFalse((self.srt.parent / ass_captions.ASS_FILENAME).exists())

    def test_nothing_at_all_means_no_subtitles(self):
        c = ass_captions.prepare(None, None, width=320, height=240, ffmpeg="unused")
        self.assertEqual((c.path, c.mode), (None, None))

    def test_no_libass_keeps_the_srt(self):
        with mock.patch.object(ass_captions, "has_libass", return_value=False):
            c = ass_captions.prepare(self.srt, word_specs(["a"]), width=320, height=240,
                                     ffmpeg="ffmpeg")
        self.assertEqual((c.path, c.mode), (self.srt, ass_captions.MODE_SRT))
        self.assertIn("libass", c.reason)

    def test_words_without_times_keep_the_srt(self):
        specs = [{"word": "a", "start": None, "end": None}]
        with mock.patch.object(ass_captions, "has_libass", return_value=True):
            c = ass_captions.prepare(self.srt, specs, width=320, height=240, ffmpeg="ffmpeg")
        self.assertEqual(c.mode, ass_captions.MODE_SRT)

    def test_any_failure_keeps_the_srt_and_never_raises(self):
        with mock.patch.object(ass_captions, "has_libass", return_value=True), \
                mock.patch.object(ass_captions, "build_ass", side_effect=MemoryError("boom")):
            c = ass_captions.prepare(self.srt, word_specs(["a"]), width=320, height=240,
                                     ffmpeg="ffmpeg")
        self.assertEqual((c.path, c.mode), (self.srt, ass_captions.MODE_SRT))
        self.assertIn("MemoryError", c.reason)

    def test_a_file_ffmpeg_cannot_load_keeps_the_srt(self):
        with mock.patch.object(ass_captions, "has_libass", return_value=True), \
                mock.patch.object(ass_captions, "_loads_in_ffmpeg", return_value="exit 1"):
            c = ass_captions.prepare(self.srt, word_specs(["a"]), width=320, height=240,
                                     ffmpeg="ffmpeg")
        self.assertEqual(c.mode, ass_captions.MODE_SRT)

    def test_has_libass_reads_the_filter_list(self):
        listing = " ... ass    V->V  Render ASS.\n ... subtitles  V->V  Render text subtitles.\n"
        ass_captions.has_libass.cache_clear()
        with mock.patch("subprocess.run") as run:
            run.return_value = mock.Mock(stdout=listing)
            self.assertTrue(ass_captions.has_libass("/fake/ffmpeg-a"))
            run.return_value = mock.Mock(stdout=" ... scale V->V Scale.\n")
            self.assertFalse(ass_captions.has_libass("/fake/ffmpeg-b"))
            run.side_effect = OSError("missing")
            self.assertFalse(ass_captions.has_libass("/fake/ffmpeg-c"))
        ass_captions.has_libass.cache_clear()


def _real_libass() -> bool:
    exe = render_backend.resolve_ffmpeg()
    present = exe == "ffmpeg" and shutil.which("ffmpeg") or Path(exe).exists()
    return bool(present) and ass_captions.has_libass(exe)


@unittest.skipUnless(_real_libass(), "no ffmpeg with libass")
class RealPrepareTestCase(_SrtDir):
    def test_writes_a_loadable_ass_beside_the_srt_and_leaves_the_srt_alone(self):
        c = ass_captions.prepare(self.srt, word_specs(["hello", "there"]), width=320, height=240)
        self.assertEqual(c.mode, ass_captions.MODE_WORDS, c.reason)
        self.assertEqual(c.path, self.srt.parent / ass_captions.ASS_FILENAME)
        self.assertTrue(c.path.is_file())
        self.assertEqual(self.srt.read_text(encoding="utf-8"), self.srt_text)


if __name__ == "__main__":
    unittest.main()
