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

Fixed: the video branch now refuses a frame above MAX_PIXELS with the same
"too_large_dimensions" reason the image branch and the HEIC path use, and it
holds EVERY video stream to the frame caps, not only the first. Root-cause
search found two variants, both measured with ffmpeg 7.0.2:

* a second video stream larger than the first: ``thumbnail_command`` (no
  ``-map``) decodes the stream with the largest area, so a 64x64 first stream
  vouched for a bigger second one;
* cover art (an ``attached_pic`` stream) moved in front of the video track:
  ``interpret_probe`` skipped it, while ``proxy_command``'s ``-map 0:v:0``
  decoded it.

Audio files are not capped: their cover art is never decoded (no thumbnail, no
proxy at ingest; an editor export reads them as ``[n:a]`` with explicit
``-map``). A test below pins that ingest runs no ffmpeg for audio, so starting
to decode cover art one day turns it red. (CI runs ``unittest discover``, so no
pytest here.)
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

    def test_video_just_over_the_megapixel_cap_is_refused(self):
        """The boundary: a frame one pixel over MAX_PIXELS should be refused, so
        the eventual fix is an inclusive area cap mirroring the image branch."""
        width, height = 10_000, 10_001  # 100_010_000 px > 100 MP
        self.assertGreater(width * height, ml.MAX_PIXELS)
        with self.assertRaises(ml.IngestReject) as e:
            ml.interpret_probe("video/mp4", _video_probe(width, height))
        self.assertEqual(e.exception.reason, "too_large_dimensions")

    def test_video_at_or_under_the_megapixel_cap_stays_accepted(self):
        """A control / forward-looking regression: a frame at or below the
        video cap must keep working, so the fix is an area cap and not a
        lowered per-side limit. The video cap is VIDEO_MAX_PIXELS (8192x4352,
        BR-L-010), lower than a still's MAX_PIXELS; these are all within it
        and within MAX_SIDE."""
        for width, height in ((8192, 4352), (ml.MAX_SIDE, ml.VIDEO_MAX_PIXELS // ml.MAX_SIDE)):
            with self.subTest(width=width, height=height):
                self.assertLessEqual(width * height, ml.VIDEO_MAX_PIXELS)
                p = ml.interpret_probe("video/mp4", _video_probe(width, height))
                self.assertEqual((p.kind, p.width, p.height), ("video", width, height))



VIDEO_TYPES = ("video/mp4", "video/quicktime", "video/webm", "video/x-matroska")
#: Frames that must keep working: 1080p, 4K UHD, 8K UHD (33 MP), 8K DCI and
#: portrait 8K, and the exact video area cap (VIDEO_MAX_PIXELS, 8192x4352,
#: BR-L-010) in both orientations.
AT_OR_UNDER_CAP = (
    (1920, 1080), (3840, 2160), (7680, 4320), (8192, 4320), (4320, 7680),
    (8192, 4352), (4352, 8192),
    (ml.MAX_SIDE, ml.VIDEO_MAX_PIXELS // ml.MAX_SIDE),
    (ml.VIDEO_MAX_PIXELS // ml.MAX_SIDE, ml.MAX_SIDE),
)
#: Each side within MAX_SIDE, so only the area cap catches these: one row or
#: column over the video cap, and the still cap's old boundary (a 100 MP
#: video frame was accepted before BR-L-010).
OVER_CAP = (
    (8192, 4353), (8193, 4352), (4353, 8192),
    (ml.MAX_SIDE, ml.VIDEO_MAX_PIXELS // ml.MAX_SIDE + 1),
    (ml.VIDEO_MAX_PIXELS // ml.MAX_SIDE + 1, ml.MAX_SIDE),
    (10_000, 10_000), (10_000, 10_001), (10_001, 10_000),
    (ml.MAX_SIDE, ml.MAX_SIDE),
)


def _streams_probe(*streams, duration: str = "5") -> dict:
    return {"streams": list(streams), "format": {"duration": duration}}


def _v(width, height, **extra) -> dict:
    return {"codec_type": "video", "width": width, "height": height, **extra}


def _cover(width, height) -> dict:
    return _v(width, height, disposition={"attached_pic": 1})


AUDIO = {"codec_type": "audio"}


class VideoAreaCapBoundaryTests(unittest.TestCase):
    """Regression for BR-D-001: the cap is inclusive, the same for every video
    type, and it does not care which side is the long one."""

    def assert_too_large(self, sniffed, data):
        with self.assertRaises(ml.IngestReject) as e:
            ml.interpret_probe(sniffed, data)
        self.assertEqual(e.exception.reason, "too_large_dimensions")

    def test_frames_at_or_under_the_cap_are_accepted_for_every_video_type(self):
        for sniffed in VIDEO_TYPES:
            for width, height in AT_OR_UNDER_CAP:
                with self.subTest(sniffed=sniffed, width=width, height=height):
                    self.assertLessEqual(width * height, ml.VIDEO_MAX_PIXELS)
                    p = ml.interpret_probe(sniffed, _video_probe(width, height))
                    self.assertEqual((p.kind, p.mime, p.width, p.height), ("video", sniffed, width, height))

    def test_frames_over_the_cap_are_refused_for_every_video_type(self):
        for sniffed in VIDEO_TYPES:
            for width, height in OVER_CAP:
                with self.subTest(sniffed=sniffed, width=width, height=height):
                    self.assertGreater(width * height, ml.VIDEO_MAX_PIXELS)
                    self.assertLessEqual(max(width, height), ml.MAX_SIDE)
                    self.assert_too_large(sniffed, _video_probe(width, height))

    def test_a_video_with_sound_is_capped_too(self):
        self.assert_too_large("video/mp4", _streams_probe(_v(10_000, 10_001), AUDIO))
        p = ml.interpret_probe("video/mp4", _streams_probe(_v(7680, 4320), AUDIO))
        self.assertEqual((p.kind, p.width, p.height), ("video", 7680, 4320))


class EveryPictureStreamTests(unittest.TestCase):
    """Regression for the variants of BR-D-001 that the root-cause search
    found: ffmpeg does not only decode the stream interpret_probe records.
    Measured with ffmpeg 7.0.2: ``thumbnail_command`` picked the larger second
    stream of a two-stream MKV and MP4, and ``proxy_command``'s ``-map 0:v:0``
    decoded cover art placed before the video track of an MP4."""

    def assert_too_large(self, sniffed, data):
        with self.assertRaises(ml.IngestReject) as e:
            ml.interpret_probe(sniffed, data)
        self.assertEqual(e.exception.reason, "too_large_dimensions")

    def test_a_small_first_stream_does_not_vouch_for_a_huge_second_one(self):
        for sniffed in VIDEO_TYPES:
            for width, height in OVER_CAP:
                with self.subTest(sniffed=sniffed, width=width, height=height):
                    self.assert_too_large(sniffed, _streams_probe(_v(64, 64), _v(width, height), AUDIO))

    def test_a_second_stream_wider_than_max_side_is_refused(self):
        self.assert_too_large("video/x-matroska", _streams_probe(_v(64, 64), _v(ml.MAX_SIDE + 1, 16)))

    def test_cover_art_bomb_in_a_video_is_refused_wherever_it_sits(self):
        for sniffed in VIDEO_TYPES:
            for width, height in OVER_CAP:
                for streams in ((_cover(width, height), _v(64, 64)),     # before the video: -map 0:v:0
                                (_v(64, 64), _cover(width, height))):    # after it
                    with self.subTest(sniffed=sniffed, width=width, height=height, first=streams[0]):
                        self.assert_too_large(sniffed, _streams_probe(*streams))

    def test_a_picture_stream_with_no_size_is_refused(self):
        """Fail closed: a stream whose size ffprobe could not read cannot be
        held to the cap, and ffmpeg might still decode it."""
        for extra in ({"codec_type": "video"}, _v(0, 0), _cover(None, 720)):
            with self.subTest(extra=extra):
                with self.assertRaises(ml.IngestReject) as e:
                    ml.interpret_probe("video/mp4", _streams_probe(_v(1920, 1080), extra))
                self.assertEqual(e.exception.reason, "not_media")

    def test_ordinary_multi_stream_videos_stay_accepted(self):
        """Real files: an 8K clip with cover art and sound, two angles, and the
        exact cap on a second stream. The recorded size is the main stream's."""
        cases = (
            (_cover(3000, 3000), _v(7680, 4320), AUDIO),
            (_v(1920, 1080), _v(3840, 2160), AUDIO, AUDIO),
            (_v(1280, 720), _v(ml.MAX_SIDE, ml.VIDEO_MAX_PIXELS // ml.MAX_SIDE)),
        )
        for streams in cases:
            with self.subTest(streams=streams):
                main = next(s for s in streams if s.get("codec_type") == "video" and not s.get("disposition"))
                p = ml.interpret_probe("video/mp4", _streams_probe(*streams))
                self.assertEqual((p.kind, p.width, p.height), ("video", main["width"], main["height"]))

    def test_a_refused_video_never_reaches_ffmpeg(self):
        """Through ingest: the bomb ends as too_large_dimensions before the
        thumbnail or the proxy runs, and nothing is stored."""
        import shutil
        import tempfile
        import uuid
        from pathlib import Path

        mp4_head = b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41" + b"\x00" * 16
        for data in (_video_probe(ml.MAX_SIDE, ml.MAX_SIDE),
                     _streams_probe(_v(64, 64), _v(ml.MAX_SIDE, ml.MAX_SIDE)),
                     _streams_probe(_cover(ml.MAX_SIDE, ml.MAX_SIDE), _v(64, 64))):
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
                                  prober=lambda _exe, _path, sniffed: ml.interpret_probe(sniffed, data))
                    self.assertEqual(e.exception.reason, "too_large_dimensions")
                    self.assertEqual(ran, [], "ffmpeg must not run on a refused video")
                    self.assertEqual([f for f in media.rglob("*") if f.is_file()], [])
                finally:
                    shutil.rmtree(tmp, ignore_errors=True)


class AudioCoverArtTests(unittest.TestCase):
    """Audio is the one kind whose cover art is NOT capped, because nothing
    decodes it. These pin both halves of that reasoning."""

    def test_audio_with_large_cover_art_is_still_audio(self):
        for sniffed in ("audio/mpeg", "audio/mp4", "audio/flac", "video/mp4"):
            with self.subTest(sniffed=sniffed):
                p = ml.interpret_probe(sniffed, _streams_probe(AUDIO, _cover(ml.MAX_SIDE, ml.MAX_SIDE)))
                self.assertEqual((p.kind, p.width, p.height), ("audio", None, None))

    def test_ingest_runs_no_ffmpeg_for_audio(self):
        """If audio ever gets a thumbnail (its cover art), this goes red: the
        cover art must then be held to the frame caps like a video's."""
        import shutil
        import tempfile
        import uuid
        from pathlib import Path

        class Store:
            def heartbeat(self, *_a):
                pass

            def register(self, **kw):
                self.kw = kw
                return {"id": kw["asset_id"], "reused": False}

        head = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" + b"\x00" * 64
        self.assertEqual(ml.sniff(head), "audio/mpeg")
        tmp = Path(tempfile.mkdtemp())
        try:
            staging, media = tmp / "staging", tmp / "media"
            staging.mkdir()
            media.mkdir()
            tid = str(uuid.uuid4())
            ml.staged_path(staging, tid).write_bytes(head)
            ticket = {"id": tid, "declared_mime": "audio/mpeg", "original_name": "song.mp3",
                      "declared_bytes": len(head)}
            ran = []

            def runner(argv, *a, **kw):
                ran.append(argv)
                return 0

            store = Store()
            data = _streams_probe(AUDIO, _cover(ml.MAX_SIDE, ml.MAX_SIDE))
            ml.ingest(ticket, store=store, staging_root=staging, media_root=media, worker_id="w",
                      tools=ml.Tools("ffprobe", "ffmpeg"), runner=runner,
                      prober=lambda _exe, _path, sniffed: ml.interpret_probe(sniffed, data))
            self.assertEqual(ran, [])
            self.assertEqual((store.kw["kind"], store.kw["variants"]), ("audio", []))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

if __name__ == "__main__":  # pragma: no cover
    unittest.main()
