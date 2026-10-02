"""BR-D-001 — a video can carry the same decompression bomb BR-C-001 fixed for
images, because the VIDEO branch of interpret_probe never caps total pixels.

modules/media_library.interpret_probe caps each SIDE of a video frame at
MAX_SIDE (16384 px) but, unlike the image branch and the HEIC path, it never
caps the TOTAL pixel count (``width * height <= MAX_PIXELS``, 100 MP). A video
that declares a 16384x16384 frame is 268 MP — it passes validation.

The media worker then decodes that frame twice: ``thumbnail_command`` (ffmpeg,
one frame) and ``proxy_command`` (ffmpeg, a re-encode that decodes frames) both
allocate the full bitmap (~1 GB for RGBA at 268 MP). A solid-colour clip at that
resolution compresses to well under the declared upload size, so
``copy_and_hash``'s size cap does not help. That is a resource-exhaustion DoS
against the single-threaded media worker, reachable by any member who can upload
a file — the same class and blast radius as BR-C-001, only through a container
ffprobe reads as a video.

The image branch already enforces ``width * height > MAX_PIXELS`` (BR-C-001's
fix) and the HEIC path enforces ``w * h <= MAX_PIXELS``; the video branch is the
remaining gap. These tests assert the SECURE behaviour, so the bomb test is
@unittest.expectedFailure while BR-D-001 is open (CI runs ``unittest discover``,
so no pytest here; an unexpected pass turns the run red, which forces the ledger
update when Patch adds the cap).
"""

from __future__ import annotations

import unittest

from modules import media_library as ml


def _video_probe(width: int, height: int, duration: str = "5") -> dict:
    """A probe ffprobe would return for a video: one real video stream (no
    attached_pic disposition, so it counts as a picture stream) and a length."""
    return {
        "streams": [{"codec_type": "video", "width": width, "height": height}],
        "format": {"duration": duration},
    }


class VideoBombTests(unittest.TestCase):
    def test_normal_video_is_accepted(self):
        """A control: an ordinary clip goes through, so the bomb test below is
        measuring the pixel cap, not a blanket rejection of video."""
        p = ml.interpret_probe("video/mp4", _video_probe(1920, 1080))
        self.assertEqual((p.kind, p.width, p.height), ("video", 1920, 1080))

    def test_video_wider_than_max_side_is_already_refused(self):
        """A control: the existing per-side cap works on the video branch too —
        the gap is total pixels, exactly as it was for raster images."""
        with self.assertRaises(ml.IngestReject) as e:
            ml.interpret_probe("video/mp4", _video_probe(ml.MAX_SIDE + 1, 10))
        self.assertEqual(e.exception.reason, "too_large_dimensions")

    @unittest.expectedFailure  # BR-D-001 open: no total-pixel cap on the video branch
    def test_video_megapixel_bomb_is_refused(self):
        """A 16384x16384 video frame (268 MP) is within MAX_SIDE on each axis but
        is a decompression bomb once ffmpeg decodes it for the thumbnail and the
        proxy. interpret_probe SHOULD refuse any video above MAX_PIXELS, exactly
        as the image and HEIC paths do."""
        big = ml.MAX_SIDE  # 16384 per side, each within the per-side cap
        self.assertGreater(big * big, ml.MAX_PIXELS)  # 268 MP > 100 MP — a bomb
        with self.assertRaises(ml.IngestReject) as e:
            ml.interpret_probe("video/mp4", _video_probe(big, big))
        self.assertEqual(e.exception.reason, "too_large_dimensions")

    @unittest.expectedFailure  # BR-D-001 open: a frame just over 100 MP is still accepted
    def test_video_just_over_the_megapixel_cap_is_refused(self):
        """The boundary: a frame one pixel over MAX_PIXELS should be refused, so
        the eventual fix is an inclusive area cap mirroring the image branch."""
        width, height = 10_000, 10_001  # 100_010_000 px > 100 MP
        self.assertGreater(width * height, ml.MAX_PIXELS)
        with self.assertRaises(ml.IngestReject) as e:
            ml.interpret_probe("video/mp4", _video_probe(width, height))
        self.assertEqual(e.exception.reason, "too_large_dimensions")

    def test_video_at_or_under_the_megapixel_cap_stays_accepted(self):
        """A control / forward-looking regression: a frame at or below MAX_PIXELS
        must keep working after the cap is added, so the fix is an area cap and
        not a lowered per-side limit. These are all <= 100 MP and within MAX_SIDE."""
        for width, height in ((10_000, 10_000), (ml.MAX_SIDE, ml.MAX_PIXELS // ml.MAX_SIDE)):
            with self.subTest(width=width, height=height):
                self.assertLessEqual(width * height, ml.MAX_PIXELS)
                p = ml.interpret_probe("video/mp4", _video_probe(width, height))
                self.assertEqual((p.kind, p.width, p.height), ("video", width, height))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
