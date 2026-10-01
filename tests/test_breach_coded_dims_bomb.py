"""BR-E-001 — the pixel cap can be bypassed with coded_width/coded_height.

Patch's fix for BR-C-001 (image) and BR-D-001 (video) added an area cap to
modules.media_library.interpret_probe:

    if width * height > MAX_PIXELS: raise IngestReject("too_large_dimensions", ...)

It reads the DISPLAY size ffprobe reports as ``width`` / ``height``. ffprobe
``-show_streams`` (the exact flag probe_command uses) also reports
``coded_width`` / ``coded_height`` — the full coded frame, which for H.264/HEVC
is the macroblock/CTB-aligned size the decoder allocates BEFORE cropping to the
display size. libavcodec allocates the decoded frame at the CODED dimensions, so
a stream that declares a tiny display size (64x64, well under every cap) but a
huge coded size (16384x16384 = 268 MP) still makes the thumbnail and proxy steps
allocate ~1 GB — the same decompression-bomb DoS against the single-threaded
media worker that BR-C-001/BR-D-001 described, reachable by any member.

``coded_width`` / ``coded_height`` appear nowhere in the code
(``grep -rn coded_width modules tools`` is empty), so the cap trusts a number
the attacker controls that is NOT the number ffmpeg decodes. A solid-colour clip
with a large coded frame and a crop window compresses to a few hundred KB, under
any declared-size cap.

The two expectedFailure tests below assert the behaviour the fix SHOULD have:
interpret_probe must refuse a stream whose CODED frame is a bomb, even when its
display size is small. They are strict — when the fix caps on
``max(width, coded_width)`` / ``max(height, coded_height)`` they turn into
unexpected successes, which makes ``python -m unittest discover tests`` exit
non-zero (TestResult.wasSuccessful() is False with any unexpected success — the
same mechanism tests/test_breach_video_bomb.py relies on). Passing controls pin
that the display-dimension caps still work and legit clips are still accepted,
so the file is not vacuous.

CI runs ``unittest discover`` for tests/, so no pytest here.
"""

from __future__ import annotations

import unittest

from modules import media_library as ml


def _video(width: int, height: int, *, coded_w=None, coded_h=None, duration="5") -> dict:
    """A probe ffprobe would return for a one-stream video. coded_* default to
    the display size (an ordinary clip); set them apart to model a cropped
    coded frame."""
    s = {"codec_type": "video", "width": width, "height": height}
    if coded_w is not None:
        s["coded_width"] = coded_w
    if coded_h is not None:
        s["coded_height"] = coded_h
    return {"streams": [s], "format": {"duration": duration}}


class CodedDimsBombTests(unittest.TestCase):
    # --- controls (must pass on the fixed code and today) ---------------------

    def test_normal_clip_is_accepted(self):
        """A control: an ordinary 1920x1080 clip (coded == display) goes
        through, so the bomb tests measure the coded-dims gap, not a blanket
        rejection."""
        p = ml.interpret_probe("video/mp4", _video(1920, 1080, coded_w=1920, coded_h=1088))
        self.assertEqual((p.kind, p.width, p.height), ("video", 1920, 1080))

    def test_legit_8k_portrait_is_accepted(self):
        """Fail-closed regression: 8K portrait (4320x7680, 33 MP) is a real
        phone/vertical upload and must keep working — it is within both caps."""
        p = ml.interpret_probe("video/mp4", _video(4320, 7680, coded_w=4320, coded_h=7680))
        self.assertEqual((p.width, p.height), (4320, 7680))

    def test_display_side_cap_still_rejects(self):
        """A control: the existing per-SIDE cap on the display size still
        fires, so the gap is specifically the coded frame, not the side cap."""
        with self.assertRaises(ml.IngestReject) as e:
            ml.interpret_probe("video/mp4", _video(ml.MAX_SIDE + 1, 10))
        self.assertEqual(e.exception.reason, "too_large_dimensions")

    # --- the open hole (strict expectedFailure) -------------------------------

    @unittest.expectedFailure
    def test_small_display_but_huge_coded_frame_is_refused(self):
        """A stream with a 64x64 DISPLAY frame but a 16384x16384 CODED frame is
        268 MP once ffmpeg allocates it for the thumbnail and the proxy. Every
        display-size cap passes it (64x64 is tiny), so interpret_probe SHOULD
        refuse it on the coded frame, exactly as it refuses a big display
        frame. It does not today: the cap never reads coded_width/coded_height.
        """
        self.assertGreater(ml.MAX_SIDE * ml.MAX_SIDE, ml.MAX_PIXELS)  # 268 MP is a bomb
        with self.assertRaises(ml.IngestReject) as e:
            ml.interpret_probe(
                "video/mp4",
                _video(64, 64, coded_w=ml.MAX_SIDE, coded_h=ml.MAX_SIDE),
            )
        self.assertEqual(e.exception.reason, "too_large_dimensions")

    @unittest.expectedFailure
    def test_coded_area_just_over_the_cap_is_refused(self):
        """The boundary: a small display frame but a coded frame one step over
        MAX_PIXELS must be refused, so the fix is an area cap on the coded
        frame and not a lowered per-side limit."""
        cw, ch = 10_000, 10_001  # 100_010_000 px > 100 MP
        self.assertGreater(cw * ch, ml.MAX_PIXELS)
        with self.assertRaises(ml.IngestReject) as e:
            ml.interpret_probe("video/mp4", _video(100, 100, coded_w=cw, coded_h=ch))
        self.assertEqual(e.exception.reason, "too_large_dimensions")


if __name__ == "__main__":
    unittest.main()
