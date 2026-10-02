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

Fixed: the image branch, the video branch and ``_check_every_picture`` all cap
the frame the decoder allocates, ``max(width, coded_width)`` x
``max(height, coded_height)``, against MAX_SIDE per side and MAX_PIXELS in area,
with the same "too_large_dimensions" reason. A coded size that is missing, not a
number or not positive counts as absent (the display size is used); it can only
ever raise the size, never lower it. The image branch now also runs
``_check_every_picture``, so a second, larger stream in an image-sniffed file is
held to the caps (the secondary note in BR-E-001). The recorded size stays the
display size.

The two tests that were strict expectedFailure while the hole was open are
plain tests now. CI runs ``unittest discover`` for tests/, so no pytest here.
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

    # --- the hole (strict expectedFailure while BR-E-001 was open) -----------

    def test_small_display_but_huge_coded_frame_is_refused(self):
        """A stream with a 64x64 DISPLAY frame but a 16384x16384 CODED frame is
        268 MP once ffmpeg allocates it for the thumbnail and the proxy. Every
        display-size cap passes it (64x64 is tiny), so interpret_probe SHOULD
        refuse it on the coded frame, exactly as it refuses a big display
        frame. Before the fix the cap never read coded_width/coded_height.
        """
        self.assertGreater(ml.MAX_SIDE * ml.MAX_SIDE, ml.MAX_PIXELS)  # 268 MP is a bomb
        with self.assertRaises(ml.IngestReject) as e:
            ml.interpret_probe(
                "video/mp4",
                _video(64, 64, coded_w=ml.MAX_SIDE, coded_h=ml.MAX_SIDE),
            )
        self.assertEqual(e.exception.reason, "too_large_dimensions")

    def test_coded_area_just_over_the_cap_is_refused(self):
        """The boundary: a small display frame but a coded frame one step over
        MAX_PIXELS must be refused, so the fix is an area cap on the coded
        frame and not a lowered per-side limit."""
        cw, ch = 10_000, 10_001  # 100_010_000 px > 100 MP
        self.assertGreater(cw * ch, ml.MAX_PIXELS)
        with self.assertRaises(ml.IngestReject) as e:
            ml.interpret_probe("video/mp4", _video(100, 100, coded_w=cw, coded_h=ch))
        self.assertEqual(e.exception.reason, "too_large_dimensions")


VIDEO_TYPES = ("video/mp4", "video/quicktime", "video/webm", "video/x-matroska")
IMAGE_TYPES = ("image/jpeg", "image/png", "image/webp", "image/gif")
#: Values ffprobe (or a hostile file) can put in coded_width / coded_height that
#: are not a usable size: they count as absent, so the display size is used.
NOT_A_SIZE = (None, "", "N/A", "abc", 0, "0", -5, "-16384", float("nan"), float("inf"), [], {})


def _s(width, height, coded_w=None, coded_h=None, *, cover=False) -> dict:
    """One video stream; coded_* are left out when None."""
    s = {"codec_type": "video", "width": width, "height": height}
    if coded_w is not None:
        s["coded_width"] = coded_w
    if coded_h is not None:
        s["coded_height"] = coded_h
    if cover:
        s["disposition"] = {"attached_pic": 1}
    return s


def _probe(*streams, duration="5") -> dict:
    return {"streams": list(streams), "format": {"duration": duration}}


def _image(*streams) -> dict:
    return {"streams": list(streams), "format": {}}


class _Refuses(unittest.TestCase):
    def assert_too_large(self, sniffed, data):
        with self.assertRaises(ml.IngestReject) as e:
            ml.interpret_probe(sniffed, data)
        self.assertEqual(e.exception.reason, "too_large_dimensions")


class CodedFrameBoundaryTests(_Refuses):
    """Regression for BR-E-001: the boundaries of the coded-frame cap, in both
    branches of interpret_probe."""

    def test_coded_area_at_the_cap_is_accepted_and_one_row_over_is_refused(self):
        side = 10_000  # 10_000 x 10_000 is exactly MAX_PIXELS
        self.assertEqual(side * side, ml.MAX_PIXELS)
        for sniffed in VIDEO_TYPES:
            with self.subTest(sniffed=sniffed):
                p = ml.interpret_probe(sniffed, _probe(_s(100, 100, side, side)))
                self.assertEqual((p.kind, p.width, p.height), ("video", 100, 100))
                self.assert_too_large(sniffed, _probe(_s(100, 100, side, side + 1)))
                self.assert_too_large(sniffed, _probe(_s(100, 100, side + 1, side)))
        for sniffed in IMAGE_TYPES:
            with self.subTest(sniffed=sniffed):
                p = ml.interpret_probe(sniffed, _image(_s(100, 100, side, side)))
                self.assertEqual((p.kind, p.width, p.height), ("image", 100, 100))
                self.assert_too_large(sniffed, _image(_s(100, 100, side, side + 1)))
                self.assert_too_large(sniffed, _image(_s(100, 100, side + 1, side)))

    def test_coded_side_at_max_side_is_accepted_and_one_over_is_refused(self):
        """The per-side cap reads the coded frame too: MAX_SIDE x 16 is small
        in area and accepted; MAX_SIDE+1 x 16 is refused on the side alone."""
        for coded in ((ml.MAX_SIDE, 16), (16, ml.MAX_SIDE)):
            with self.subTest(coded=coded):
                p = ml.interpret_probe("video/mp4", _probe(_s(16, 16, *coded)))
                self.assertEqual((p.width, p.height), (16, 16))
                p = ml.interpret_probe("image/png", _image(_s(16, 16, *coded)))
                self.assertEqual((p.width, p.height), (16, 16))
        for coded in ((ml.MAX_SIDE + 1, 16), (16, ml.MAX_SIDE + 1)):
            with self.subTest(coded=coded):
                self.assert_too_large("video/mp4", _probe(_s(16, 16, *coded)))
                self.assert_too_large("image/png", _image(_s(16, 16, *coded)))

    def test_each_side_takes_the_larger_of_display_and_coded(self):
        """The cap is max(width, coded_width) x max(height, coded_height), so
        a coded width alone plus a tall display frame is still a bomb."""
        self.assert_too_large("video/mp4", _probe(_s(64, 10_001, 10_000, None)))
        self.assert_too_large("video/mp4", _probe(_s(10_001, 64, 32, 10_000)))
        self.assert_too_large("image/jpeg", _image(_s(64, 10_001, 10_000, 8)))

    def test_coded_dims_given_as_strings_are_read(self):
        """ffprobe JSON gives numbers, but a numeric string must not slip past."""
        self.assert_too_large("video/mp4", _probe(_s(64, 64, str(ml.MAX_SIDE), str(ml.MAX_SIDE))))
        self.assert_too_large("image/png", _image(_s(64, 64, "16384.0", "16384")))

    def test_a_coded_size_that_is_not_a_size_falls_back_to_the_display_size(self):
        """Missing, non-numeric or non-positive coded dims are absent: an
        ordinary clip or image is still accepted, at its display size."""
        for bad in NOT_A_SIZE:
            with self.subTest(coded=bad):
                p = ml.interpret_probe("video/mp4", _probe(_s(1920, 1080, bad, bad)))
                self.assertEqual((p.kind, p.width, p.height), ("video", 1920, 1080))
                p = ml.interpret_probe("image/png", _image(_s(800, 600, bad, bad)))
                self.assertEqual((p.kind, p.width, p.height), ("image", 800, 600))

    def test_a_small_or_bogus_coded_size_never_lowers_the_display_size(self):
        """The display frame stays capped whatever the coded fields say: a
        hostile file cannot shrink the size the cap sees."""
        for coded in [(64, 64), (1, 1)] + [(b, b) for b in NOT_A_SIZE]:
            with self.subTest(coded=coded):
                self.assert_too_large("video/mp4", _probe(_s(10_000, 10_001, *coded)))
                self.assert_too_large("video/mp4", _probe(_s(ml.MAX_SIDE + 1, 16, *coded)))
                self.assert_too_large("image/png", _image(_s(10_000, 10_001, *coded)))

    def test_legit_clips_with_padded_coded_frames_stay_accepted(self):
        """Real encoders pad the coded frame to the macroblock / CTB grid
        (1080 -> 1088). 1080p, 4K, 8K, 8K DCI and portrait phone clips keep
        working, and the recorded size is the display size."""
        cases = (
            (1920, 1080, 1920, 1088),
            (1080, 1920, 1088, 1920),
            (1280, 720, 1280, 736),
            (3840, 2160, 3840, 2160),
            (2160, 3840, 2160, 3840),
            (7680, 4320, 7680, 4320),
            (4320, 7680, 4320, 7680),
            (8192, 4320, 8192, 4352),
        )
        for sniffed in VIDEO_TYPES:
            for w, h, cw, ch in cases:
                with self.subTest(sniffed=sniffed, size=(w, h)):
                    p = ml.interpret_probe(sniffed, _probe(_s(w, h, cw, ch), {"codec_type": "audio"}))
                    self.assertEqual((p.kind, p.width, p.height), ("video", w, h))

    def test_legit_images_stay_accepted(self):
        for sniffed in IMAGE_TYPES:
            for w, h, cw, ch in ((4032, 3024, 4032, 3024), (3024, 4032, 0, 0), (1, 1, None, None)):
                with self.subTest(sniffed=sniffed, size=(w, h)):
                    p = ml.interpret_probe(sniffed, _image(_s(w, h, cw, ch)))
                    self.assertEqual((p.kind, p.width, p.height), ("image", w, h))


class EveryStreamCodedFrameTests(_Refuses):
    """_check_every_picture reads the coded frame of every video stream, and
    the image branch now runs it too (the secondary note in BR-E-001)."""

    def test_check_every_picture_uses_coded_dims(self):
        with self.assertRaises(ml.IngestReject) as e:
            ml._check_every_picture([_s(64, 64, ml.MAX_SIDE, ml.MAX_SIDE)])
        self.assertEqual(e.exception.reason, "too_large_dimensions")
        with self.assertRaises(ml.IngestReject) as e:
            ml._check_every_picture([_s(64, 64), _s(100, 100, 10_000, 10_001)])
        self.assertEqual(e.exception.reason, "too_large_dimensions")
        ml._check_every_picture([_s(64, 64, 64, 64), {"codec_type": "audio"}])  # no raise

    def test_a_second_stream_with_a_huge_coded_frame_is_refused(self):
        for sniffed in VIDEO_TYPES:
            with self.subTest(sniffed=sniffed):
                self.assert_too_large(sniffed, _probe(_s(1920, 1080), _s(64, 64, ml.MAX_SIDE, ml.MAX_SIDE)))

    def test_cover_art_with_a_huge_coded_frame_is_refused(self):
        for streams in ((_s(64, 64, 10_000, 10_001, cover=True), _s(1920, 1080)),
                        (_s(1920, 1080), _s(64, 64, 10_000, 10_001, cover=True))):
            with self.subTest(first=streams[0]):
                self.assert_too_large("video/mp4", _probe(*streams))

    def test_image_with_a_second_larger_stream_is_refused(self):
        """The image thumbnail (no -map) decodes the largest stream, so an
        image-sniffed file's other streams are held to the caps too."""
        for sniffed in IMAGE_TYPES:
            for extra in (_s(ml.MAX_SIDE, ml.MAX_SIDE), _s(64, 64, ml.MAX_SIDE, ml.MAX_SIDE),
                          _s(ml.MAX_SIDE + 1, 16), _s(10_000, 10_001, cover=True)):
                with self.subTest(sniffed=sniffed, extra=extra):
                    self.assert_too_large(sniffed, _image(_s(64, 64), extra))

    def test_image_with_a_small_second_stream_stays_accepted(self):
        p = ml.interpret_probe("image/gif", _image(_s(640, 480), _s(320, 240, 320, 240)))
        self.assertEqual((p.kind, p.width, p.height), ("image", 640, 480))

    def test_a_coded_bomb_never_reaches_ffmpeg(self):
        """Through ingest: a coded-frame bomb ends as too_large_dimensions
        before the thumbnail or the proxy runs, and nothing is stored."""
        import shutil
        import tempfile
        import uuid
        from pathlib import Path

        mp4_head = b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41" + b"\x00" * 16
        for data in (_probe(_s(64, 64, ml.MAX_SIDE, ml.MAX_SIDE)),
                     _probe(_s(1920, 1080), _s(64, 64, 10_000, 10_001))):
            with self.subTest(data=data):
                tmp = Path(tempfile.mkdtemp())
                try:
                    staging, media = tmp / "staging", tmp / "media"
                    staging.mkdir()
                    media.mkdir()
                    tid = str(uuid.uuid4())
                    ml.staged_path(staging, tid).write_bytes(mp4_head)
                    ticket = {"id": tid, "declared_mime": "video/mp4", "original_name": "clip.mp4",
                              "declared_bytes": len(mp4_head)}
                    ran = []

                    def runner(argv, *a, **kw):
                        ran.append(argv)
                        return 0

                    with self.assertRaises(ml.IngestReject) as e:
                        ml.ingest(ticket, store=None, staging_root=staging, media_root=media, worker_id="w",
                                  tools=ml.Tools("ffprobe", "ffmpeg"), runner=runner,
                                  prober=lambda _exe, _path, sniffed, d=data: ml.interpret_probe(sniffed, d))
                    self.assertEqual(e.exception.reason, "too_large_dimensions")
                    self.assertEqual(ran, [], "ffmpeg must not run on a refused video")
                    self.assertEqual([f for f in media.rglob("*") if f.is_file()], [])
                finally:
                    shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
