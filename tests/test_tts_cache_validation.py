"""D11: a cached TTS segment is checked before it is reused.

The write is already atomic (a ``.part`` file, then ``os.replace``), so a kill
mid-write no longer leaves a short segment. What remains is the file that is
already in the cache: one written by an older build, one cut by a full disk, a
volume that was restored half-way. A resume trusted ``exists() and size > 0``,
and the video then carried a narration that stops mid-sentence, with captions and
QC both built from that same audio, so nothing downstream could see it.

A segment is reused only when it decodes and is not shorter than the text could
possibly be spoken in. When the check itself cannot run (no ffmpeg to decode with)
the segment is reused and the render, which decodes the same file next, fails
loudly: an unknown is not a "bad".
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pydub.exceptions import CouldntDecodeError

from modules import audio_mixer
from modules.audio_mixer import AudioMixer
from tests.test_voice_fixes import _mixer

TEXT = "The ship sailed on into the dark water and nobody aboard spoke. " * 3   # ~190 characters


class _Decoded:
    """What AudioSegment.from_file returns, as far as the check reads it."""

    def __init__(self, seconds):
        self._ms = int(seconds * 1000)

    def __len__(self):
        return self._ms


def _fake_tts(rendered):
    def fake(self, text, voice, out):
        rendered.append(out)
        Path(out).write_bytes(b"whole")
    return fake


class SegmentSeconds(unittest.TestCase):
    def test_a_readable_segment_reports_its_length(self):
        with patch.object(audio_mixer.AudioSegment, "from_file", return_value=_Decoded(4.5)):
            self.assertEqual(AudioMixer._segment_seconds(Path("x.mp3")), 4.5)

    def test_a_file_ffmpeg_cannot_decode_is_zero_seconds(self):
        with patch.object(audio_mixer.AudioSegment, "from_file", side_effect=CouldntDecodeError("bad")):
            self.assertEqual(AudioMixer._segment_seconds(Path("x.mp3")), 0.0)

    def test_a_check_that_could_not_run_is_unknown_not_zero(self):
        with patch.object(audio_mixer.AudioSegment, "from_file", side_effect=FileNotFoundError("ffmpeg")):
            self.assertIsNone(AudioMixer._segment_seconds(Path("x.mp3")))


class CachedSegmentIsValidated(unittest.TestCase):
    def render_twice(self, seconds):
        """Render TEXT, then again with the cache reporting ``seconds`` for the file."""
        with tempfile.TemporaryDirectory() as d:
            m = _mixer(d)
            rendered = []
            with patch.object(AudioMixer, "_tts_elevenlabs", _fake_tts(rendered)):
                with patch.object(AudioMixer, "_segment_seconds", return_value=seconds):
                    m._render_segment(TEXT, "main")
                    m._render_segment(TEXT, "main")
                    return len(rendered), m.characters_synthesized

    def test_a_segment_far_shorter_than_its_text_is_rendered_again(self):
        renders, chars = self.render_twice(2.0)        # ~190 characters in 2 s: cut
        self.assertEqual(renders, 2)
        self.assertEqual(chars, 2 * len(TEXT))          # and paid for again, honestly counted

    def test_an_undecodable_segment_is_rendered_again(self):
        self.assertEqual(self.render_twice(0.0)[0], 2)

    def test_a_plausible_segment_is_reused(self):
        self.assertEqual(self.render_twice(12.0)[0], 1)   # ~190 characters at ~16 a second

    def test_a_segment_that_could_not_be_checked_is_reused(self):
        self.assertEqual(self.render_twice(None)[0], 1)

    def test_the_bad_file_is_gone_before_the_new_one_is_written(self):
        with tempfile.TemporaryDirectory() as d:
            m = _mixer(d)
            seen = {}

            def fake(self_, text, voice, out):
                seen["existed"] = Path(out).exists()
                Path(out).write_bytes(b"new")

            with patch.object(AudioMixer, "_tts_elevenlabs", _fake_tts([])):
                seg = Path(m._render_segment(TEXT, "main"))
            with patch.object(AudioMixer, "_tts_elevenlabs", fake), \
                    patch.object(AudioMixer, "_segment_seconds", return_value=1.0):
                m._render_segment(TEXT, "main")
            self.assertFalse(seen["existed"])
            self.assertEqual(seg.read_bytes(), b"new")


if __name__ == "__main__":
    unittest.main()
