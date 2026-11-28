"""The Runway video upscale probe's source clip must have a frame rate the adapter can read on the machine that probes.

Evidence: the live probe of runway-video-upscale on 2026-11-27 failed before any vendor call with our own refusal "the
video's frame rate could not be read, so its upscale cannot be priced; export it again as MP4" (model_probe_runs.error).
Diagnosis: the drawn clip is a plain 24 fps MP4 that ffprobe reads, but ``video_fps`` read ONLY through ffprobe, and the
Probe models workflow's runner installs no system ffmpeg (the pinned imageio-ffmpeg ships no ffprobe): with ffprobe
absent every MP4 read as "unknown". Change: without ffprobe, an MP4 / MOV is read from its own sample table.

What would break: the probe (or any worker without ffprobe) refusing every upscale again, or the container read
inventing a rate for a file it cannot read (CLAUDE.md #5). No vendor call anywhere here."""
from __future__ import annotations

import shutil
import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules.capabilities import video
from modules.capabilities.video import RunwayVideoUpscaleAdapter, mp4_fps, read_frames, video_fps


def box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", 8 + len(payload)) + kind + payload


def full(kind: bytes, payload: bytes, version: int = 0) -> bytes:
    return box(kind, bytes([version, 0, 0, 0]) + payload)


def track(handler: bytes, timescale: int, stts: list, mdhd_version: int = 0, extra_minf: bytes = b"",
          codec: bytes = b"avc1") -> bytes:
    """A trak as a muxer writes one. Since BR-L-211 reached this path the read
    also needs what the ffprobe path counts with: stsd's sample entry (frames
    are samples only for H.264 / HEVC / ProRes), stsz's count (unknown unless it
    is the stts total), and the mdhd / tkhd lengths (the stts total time)."""
    total, ticks = sum(n for n, _ in stts), sum(n * d for n, d in stts)
    if mdhd_version == 1:
        mdhd = full(b"mdhd", struct.pack(">QQIQ", 0, 0, timescale, ticks) + b"\x00" * 4, 1)
    else:
        mdhd = full(b"mdhd", struct.pack(">IIII", 0, 0, timescale, ticks) + b"\x00" * 4)
    tkhd = full(b"tkhd", struct.pack(">IIIII", 0, 0, 1, 0, ticks * 1000 // timescale if timescale else 0)
                + b"\x00" * 60)
    hdlr = full(b"hdlr", struct.pack(">I", 0) + handler + b"\x00" * 12 + b"\x00")
    stsd = full(b"stsd", struct.pack(">I", 1) + box(codec, b"\x00" * 78))
    table = full(b"stts", struct.pack(">I", len(stts)) + b"".join(struct.pack(">II", n, d) for n, d in stts))
    stsz = full(b"stsz", struct.pack(">II", 0, total))
    minf = box(b"minf", extra_minf + box(b"stbl", stsd + table + stsz))
    return box(b"trak", tkhd + box(b"mdia", mdhd + hdlr + minf))


def mp4(*tracks: bytes, moov_last: bool = True) -> bytes:
    ftyp = box(b"ftyp", b"isom\x00\x00\x02\x00isomiso2")
    mdat = box(b"mdat", b"\x00" * 600)
    # mvhd's 1000-tick timescale with no length of its own: the tracks' lengths decide.
    moov = box(b"moov", full(b"mvhd", struct.pack(">IIII", 0, 0, 1000, 0) + b"\x00" * 80) + b"".join(tracks))
    return ftyp + (mdat + moov if moov_last else moov + mdat)


def no_ffprobe():
    real = shutil.which
    return mock.patch.object(video.shutil, "which", lambda name, *a, **k: None if name == "ffprobe" else real(name, *a, **k))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def file(self, name: str, data: bytes) -> str:
        p = self.dir / name
        p.write_bytes(data)
        return str(p)


class TheContainerRead(Base):
    def test_reads_the_video_tracks_average_rate(self):
        # 48 frames of 512 ticks at 12288 a second: 24 fps (what ffmpeg writes for the probe clip).
        self.assertEqual(mp4_fps(self.file("a.mp4", mp4(track(b"vide", 12288, [(48, 512)])))), 24.0)
        # NTSC 29.97 and a 64-bit mdhd.
        self.assertAlmostEqual(mp4_fps(self.file("b.mp4", mp4(track(b"vide", 30000, [(30, 1001)], 1)))), 29.97, 2)

    def test_skips_an_audio_track_and_a_quicktime_data_handler(self):
        sound = track(b"soun", 44100, [(43, 1024)])
        # QuickTime puts a second hdlr (the data handler, "alis") inside minf: the media handler still decides.
        dhlr = full(b"hdlr", struct.pack(">I", 0) + b"alis" + b"\x00" * 13)
        pic = track(b"vide", 600, [(60, 10)], extra_minf=dhlr)
        self.assertEqual(mp4_fps(self.file("c.mov", mp4(sound, pic, moov_last=False))), 60.0)

    def test_an_unreadable_file_is_unknown_never_a_number(self):
        self.assertIsNone(mp4_fps(self.file("x.mp4", b"not a video at all")))
        self.assertIsNone(mp4_fps(self.file("s.mp4", mp4(track(b"soun", 44100, [(43, 1024)])))))
        self.assertIsNone(mp4_fps(self.file("z.mp4", mp4(track(b"vide", 0, [(48, 512)])))))
        self.assertIsNone(mp4_fps(self.file("e.mp4", mp4(track(b"vide", 12288, [])))))
        whole = mp4(track(b"vide", 12288, [(48, 512)]))
        self.assertIsNone(mp4_fps(self.file("t.mp4", whole[:-20])))  # truncated moov
        self.assertIsNone(mp4_fps(str(self.dir / "missing.mp4")))

    def test_an_unreadable_first_video_track_is_unknown_not_the_next_ones_rate(self):
        # ffprobe's v:0 is the first video stream: a readable second one is a different stream's rate (rule 5).
        decoy = mp4(track(b"vide", 12800, []), track(b"vide", 12288, [(48, 512)]))
        self.assertIsNone(mp4_fps(self.file("decoy.mp4", decoy)))
        # An audio track before the video one is still skipped, even when its own table is broken.
        broken_sound = track(b"soun", 44100, [(43, 1024)])[:-4]
        self.assertIsNone(mp4_fps(self.file("bs.mp4", mp4(broken_sound))))

    def test_a_second_stts_or_mdhd_in_one_track_is_unknown_never_an_average(self):
        twice = full(b"stts", struct.pack(">I", 1) + struct.pack(">II", 48, 256))
        self.assertIsNone(mp4_fps(self.file("d.mp4", mp4(track(b"vide", 12288, [(48, 512)], extra_minf=box(b"stbl", twice))))))
        two_headers = box(b"trak", box(b"mdia",
                                       full(b"mdhd", struct.pack(">IIII", 0, 0, 12288, 0) + b"\x00" * 4)
                                       + full(b"mdhd", struct.pack(">IIII", 0, 0, 24576, 0) + b"\x00" * 4)
                                       + full(b"hdlr", struct.pack(">I", 0) + b"vide" + b"\x00" * 13)
                                       + box(b"minf", box(b"stbl", full(b"stts", struct.pack(">III", 1, 48, 512))))))
        self.assertIsNone(mp4_fps(self.file("h.mp4", mp4(two_headers))))

    def test_timing_boxes_outside_their_parent_are_not_read(self):
        # An stts directly in minf (not stbl) is not the sample table: the track has no timing, so unknown.
        stray = full(b"stts", struct.pack(">III", 1, 48, 512))
        t = box(b"trak", box(b"mdia", full(b"mdhd", struct.pack(">IIII", 0, 0, 12288, 0) + b"\x00" * 4)
                             + full(b"hdlr", struct.pack(">I", 0) + b"vide" + b"\x00" * 13)
                             + box(b"minf", stray + box(b"stbl", b""))))
        self.assertIsNone(mp4_fps(self.file("p.mp4", mp4(t))))

    def test_too_many_top_level_boxes_is_unknown(self):
        good = mp4(track(b"vide", 12288, [(48, 512)]))
        self.assertEqual(mp4_fps(self.file("ok.mp4", box(b"free", b"") * 100 + good)), 24.0)
        flood = box(b"free", b"") * video._MP4_MAX_TOP_BOXES + good
        self.assertIsNone(mp4_fps(self.file("flood.mp4", flood)))

    def test_webm_without_ffprobe_stays_unknown(self):
        with no_ffprobe():
            self.assertIsNone(video_fps(self.file("a.webm", b"\x1a\x45\xdf\xa3" + b"\x00" * 64)))

    def test_ffprobe_still_reads_first_when_it_is_there(self):
        calls = []

        def fake_run(argv, **kw):
            calls.append(argv)
            import subprocess  # noqa: PLC0415
            # A whole -count_packets answer: an average alone is unknown since BR-L-211.
            return subprocess.CompletedProcess(argv, 0, b'{"streams":[{"index":0,"codec_type":"video",'
                                               b'"codec_name":"h264","avg_frame_rate":"25/1","nb_frames":"50",'
                                               b'"nb_read_packets":"50","duration":"2.0"}],'
                                               b'"format":{"duration":"2.0"}}', b"")

        with mock.patch.object(video.shutil, "which", return_value="/usr/bin/ffprobe"), \
                mock.patch.object(video, "_bounded_run", side_effect=fake_run):
            self.assertEqual(video_fps(self.file("a.mp4", mp4(track(b"vide", 12288, [(48, 512)])))), 25.0)
        self.assertEqual(len(calls), 1)


@unittest.skipUnless(shutil.which("ffmpeg") or shutil.which("ffprobe"), "needs ffmpeg to draw the probe clip")
class TheProbeClip(Base):
    def setUp(self):
        super().setUp()
        from tools.probe_models import probe_video  # noqa: PLC0415

        self.clip = str(probe_video(self.dir / "probe_video.mp4"))

    def test_the_adapter_reads_the_drawn_clip_without_ffprobe(self):
        # Before the change this was None: the probe's refusal of 2026-11-27. The adapter reads through
        # read_frames (BR-L-211), which is what must accept the live probe input with ffprobe absent.
        self.assertIs(RunwayVideoUpscaleAdapter.fps_of, read_frames)
        with no_ffprobe():
            reading = RunwayVideoUpscaleAdapter.fps_of(self.clip)
            self.assertIsNone(reading.refusal)
            self.assertEqual((reading.rate, reading.frames, reading.seconds), (24.0, 48, 2.0))
            self.assertEqual(video_fps(self.clip), 24.0)

    @unittest.skipUnless(shutil.which("ffprobe"), "needs ffprobe to compare with")
    def test_the_container_read_agrees_with_ffprobe(self):
        self.assertAlmostEqual(mp4_fps(self.clip), video_fps(self.clip), 3)


if __name__ == "__main__":
    unittest.main()
