"""BR-L-211: the upscale's frame-rate ceiling and the ingest decode budget
count the frames the container holds, not the timing its header claims.

Runway bills a video upscale per output frame and the database prices it per
second of source at a 60 fps ceiling; the library's decode budget is
area x rate x length. Both read the rate and the length from header fields the
uploader writes. A sample table padded at the tail reads 0.287 fps, and a
shortened mvhd/mdhd/tkhd makes 10 s of 60 fps read as 0.25 s, so a vendor
would bill (and a decoder decode) frames nobody priced.

Python only, no database, provider, credential or network. Bridged into the
ordinary Tests job by tests/test_video_tools.py, as test_decoder_rss is by
tests/test_ffmpeg_supervisor.py.
"""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
from unittest import mock

from modules import media_library as ml
from modules.capabilities import build_adapter
from modules.capabilities import video
from modules.capabilities.base import E_BAD_REQUEST, AdapterError, CapabilityRequest

KEY = "key_TOPSECRET-runway-frame-count-0123456789"
ENV = {"RUNWAYML_API_SECRET": KEY}
MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 1024
UPLOAD = "https://runway-uploads.s3.amazonaws.com/"
TICKET = {"uploadUrl": UPLOAD, "fields": {"key": "ephemeral/abc/source.mp4"}, "runwayUri": "runway://ephemeral/abc"}
TASK = "1f2e3d4c-5b6a-4789-8abc-def012345678"


class _Resp:
    def __init__(self, status=200, body=None):
        self.status_code, self._body = status, body
        self.text = json.dumps(body) if body is not None else ""
        self.headers = {}
        self.content = b""

    def json(self):
        return self._body


class _Session:
    """Answers (method, url-substring) routes and records every call. Self-
    contained so the security lab job, which installs only its own
    requirements, can import this file without the unit suite's helpers."""

    def __init__(self, routes):
        self.routes, self.calls = list(routes), []

    def request(self, method, url, **kw):
        self.calls.append((method, url, kw))
        for m, frag, resp in self.routes:
            if m == method and frag in url:
                return resp
        raise AssertionError(f"unexpected {method} {url}")


def _routes():
    return [("POST", "/v1/uploads", _Resp(200, TICKET)),
            ("POST", UPLOAD, _Resp(204)),
            ("POST", "/v1/video_upscale", _Resp(200, {"id": TASK}))]


def _probe(avg="60/1", frames=None, packets=None, stream_s=None, format_s=None, r="60/1"):
    s = {"codec_type": "video", "avg_frame_rate": avg, "r_frame_rate": r}
    if frames is not None:
        s["nb_frames"] = str(frames)
    if packets is not None:
        s["nb_read_packets"] = str(packets)
    if stream_s is not None:
        s["duration"] = str(stream_s)
    out = {"streams": [s]}
    if format_s is not None:
        out["format"] = {"duration": str(format_s)}
    return out


class _Upscale(unittest.TestCase):
    """Submits through the REAL ``video_fps`` with ffprobe's answer faked, so
    the probe's arguments and its reading are both what production runs."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def submit(self, probe_json, name="source.mp4"):
        src = self.tmp / name
        src.write_bytes(MP4)
        seen = []

        def fake_run(argv, **kw):
            seen.append(argv)
            return subprocess.CompletedProcess(argv, 0, json.dumps(probe_json).encode(), b"")

        a = build_adapter("video.runway_upscale", env=ENV, session=_Session(_routes()))
        req = CapabilityRequest("video_upscale", input_media=(str(src),), upscale_target="4k")
        with mock.patch.object(video.shutil, "which", return_value="/usr/bin/ffprobe"), \
                mock.patch.object(video.subprocess, "run", side_effect=fake_run):
            try:
                a.submit(req, "magnific_video_upscaler_creative")
                err = None
            except AdapterError as e:
                err = e
        return err, a.session.calls, seen

    def assertRefusedBeforeUpload(self, probe_json, words):
        err, calls, _ = self.submit(probe_json)
        self.assertIsNotNone(err, "the upscale was submitted")
        self.assertEqual(err.code, E_BAD_REQUEST)
        self.assertIn(words, err.message)
        self.assertNotIn(KEY, err.message)
        self.assertEqual(calls, [], "nothing may be uploaded or POSTed before the refusal")

    def assertSubmitted(self, probe_json):
        err, calls, _ = self.submit(probe_json)
        self.assertIsNone(err, err and err.message)
        self.assertEqual([c[1].rsplit("/", 1)[-1] for c in calls if "/v1/" in c[1]], ["uploads", "video_upscale"])


class UpscaleFrameCountPins(_Upscale):
    """The two reproductions Sentinel confirmed, as ffprobe reported them."""

    def test_br_l_211_a_tail_padded_sample_table_is_refused_before_upload(self):
        # Real 120 fps x264, 240 frames, last stts entry (1, 12 800 000).
        tail_padded = {"streams": [{"codec_type": "video", "avg_frame_rate": "9600/33413", "r_frame_rate": "120/1",
                                    "nb_frames": "240", "nb_read_packets": "240", "duration": "2.000000"}],
                       "format": {"duration": "2.000000"}}
        self.assertRefusedBeforeUpload(tail_padded, "for the length it is priced at")

    def test_br_l_211_a_shortened_header_is_refused_before_upload(self):
        # 60 fps, 10 s, 600 frames; mvhd/mdhd/tkhd durations divided by 40.
        self.assertRefusedBeforeUpload(_probe("60/1", 600, 600, 0.25, 0.25), "for the length it is priced at")

    def test_br_l_211_frames_beyond_the_priced_length_after_an_edit_list_trim_are_refused(self):
        # 60 fps with 660 samples but an edit list that says 10 s: the vendor
        # receives every sample, so 66 a second is what it would bill.
        self.assertRefusedBeforeUpload(_probe("60/1", 660, 660, 10.0, 10.0), "export it again at 60")

    def test_br_l_211_no_frame_count_anywhere_is_unknown_not_the_header_rate(self):
        self.assertRefusedBeforeUpload(_probe("30/1", None, None, 2.0, 2.0), "could not be read")

    def test_br_l_211_no_length_anywhere_is_unknown(self):
        self.assertRefusedBeforeUpload(_probe("30/1", 60, 60, None, None), "could not be read")

    def test_br_l_211_the_probe_counts_packets_and_reads_both_lengths(self):
        _, _, seen = self.submit(_probe("30/1", 60, 60, 2.0, 2.0))
        argv = seen[-1]
        self.assertIn("-count_packets", argv)
        entries = argv[argv.index("-show_entries") + 1]
        for want in ("avg_frame_rate", "nb_frames", "nb_read_packets", "duration", "format=duration"):
            self.assertIn(want, entries)
        self.assertEqual(argv[argv.index("-protocol_whitelist") + 1], "file")
        self.assertEqual(argv[argv.index("-f") + 1], "mov")


class UpscaleLegitimateClipsStayAccepted(_Upscale):
    """What real cameras, phones and exporters write must still be priced."""

    def test_b_frames_at_30(self):
        self.assertSubmitted(_probe("30/1", 60, 60, 2.0, 2.0))

    def test_ntsc_60(self):
        self.assertSubmitted(_probe("60000/1001", 120, 120, 2.002, 2.002))

    def test_59_94_at_the_ceiling(self):
        self.assertSubmitted(_probe("60000/1001", 600, 600, 10.01, 10.01))

    def test_one_frame_of_slack_at_60(self):
        # A stream length measured first-to-last timestamp is one frame short.
        self.assertSubmitted(_probe("60/1", 121, 121, 2.0, 2.0))

    def test_sound_longer_than_the_picture(self):
        self.assertSubmitted(_probe("30/1", 60, 60, 2.0, 3.0))

    def test_fragmented_mp4_without_a_sample_count(self):
        self.assertSubmitted(_probe("25/1", None, 50, 2.0, 2.0))

    def test_webm_with_packets_only(self):
        p = _probe("30/1", None, 60, None, 2.0)
        err, calls, _ = self.submit(p, name="source.webm")
        self.assertIsNone(err, err and err.message)

    def test_phone_vfr_whose_base_rate_is_higher_than_its_average(self):
        # avg 19, r 30, 76 frames in 4 s: r_frame_rate is not a ceiling input.
        self.assertSubmitted(_probe("19/1", 76, 76, 4.0, 4.0, r="30/1"))

    def test_a_real_61_fps_header_is_still_refused(self):
        self.assertRefusedBeforeUpload(_probe("61/1", 61, 61, 1.0, 1.0), "takes up to 60")


class CountedRateTests(unittest.TestCase):
    def test_the_counted_rate_is_the_larger_of_the_average_and_frames_over_seconds(self):
        self.assertAlmostEqual(ml.counted_rate(*self._split(_probe("9600/33413", 240, 240, 2.0, 2.0))), 120.0)
        self.assertAlmostEqual(ml.counted_rate(*self._split(_probe("60/1", 600, 600, 0.25, 0.25))), 2400.0)
        self.assertAlmostEqual(ml.counted_rate(*self._split(_probe("30/1", 30, 30, 2.0, 2.0))), 30.0)

    def test_the_packet_count_is_preferred_to_the_header_sample_count(self):
        self.assertAlmostEqual(ml.counted_rate(*self._split(_probe("1/1", 2, 200, 2.0, 2.0))), 100.0)

    def test_unknown_frames_or_seconds_is_none(self):
        self.assertIsNone(ml.counted_rate(*self._split(_probe("30/1", None, None, 2.0, 2.0))))
        self.assertIsNone(ml.counted_rate(*self._split(_probe("30/1", 60, 60, None, None))))
        self.assertIsNone(ml.counted_rate(*self._split(_probe("30/1", 60, 60, 0, "N/A"))))

    @staticmethod
    def _split(p):
        return p["streams"][0], p.get("format") or {}


class IngestFrameCountTests(unittest.TestCase):
    def assertRefused(self, data, reason):
        with self.assertRaises(ml.IngestReject) as e:
            ml.interpret_probe("video/mp4", data)
        self.assertEqual(e.exception.reason, reason)

    def test_br_l_211_a_1_per_100000_average_with_36000_frames_is_over_the_budget(self):
        self.assertRefused({"streams": [{"codec_type": "video", "width": 7680, "height": 4320,
                                         "avg_frame_rate": "1/100000", "nb_frames": "36000"}],
                            "format": {"duration": "1200"}}, "too_long")

    def test_br_l_211_36000_frames_in_a_one_second_header_is_over_the_budget(self):
        self.assertRefused({"streams": [{"codec_type": "video", "width": 7680, "height": 4320,
                                         "avg_frame_rate": "30/1", "nb_frames": "36000"}],
                            "format": {"duration": "1.0"}}, "too_long")

    def test_br_l_211_a_video_with_no_video_packets_is_not_media(self):
        self.assertRefused({"streams": [{"codec_type": "video", "width": 64, "height": 64,
                                         "avg_frame_rate": "30/1", "nb_read_packets": "0"}],
                            "format": {"duration": "5"}}, "not_media")

    def test_the_probe_counts_packets(self):
        argv = ml.probe_command("ffprobe", Path("/s/x.upload"), "video/mp4")
        self.assertIn("-count_packets", argv)
        self.assertLess(argv.index("-count_packets"), argv.index("/s/x.upload"))

    def test_a_webm_without_any_count_keeps_the_header_budget(self):
        p = ml.interpret_probe("video/webm", {"streams": [{"codec_type": "video", "width": 1920, "height": 1080,
                                                           "avg_frame_rate": "30/1"}],
                                              "format": {"duration": "600"}})
        self.assertEqual((p.kind, p.width), ("video", 1920))
        self.assertAlmostEqual(p.work_px, 1920 * 1080 * 30 * 600)

    def test_a_real_count_that_agrees_with_the_header_does_not_change_the_work(self):
        p = ml.interpret_probe("video/mp4", {"streams": [{"codec_type": "video", "width": 1920, "height": 1080,
                                                          "avg_frame_rate": "30/1", "nb_read_packets": "18000",
                                                          "duration": "600"}],
                                             "format": {"duration": "600"}})
        self.assertAlmostEqual(p.work_px, 1920 * 1080 * 30 * 600)


def _shorten_headers(src: Path, dst: Path, factor: int) -> None:
    """Divide the mvhd, mdhd and tkhd durations by ``factor``, leaving every
    sample in place: the forged file Sentinel built for case (b)."""
    b = bytearray(src.read_bytes())
    for tag, off_v0, off_v1 in ((b"mvhd", 16, 28), (b"mdhd", 16, 28), (b"tkhd", 20, 32)):
        i = 0
        while (i := b.find(tag, i)) >= 0:
            p = i + 4
            o = p + (off_v1 if b[p] == 1 else off_v0)
            fmt, n = (">Q", 8) if b[p] == 1 else (">I", 4)
            b[o:o + n] = struct.pack(fmt, struct.unpack(fmt, b[o:o + n])[0] // factor)
            i += 4
    dst.write_bytes(bytes(b))


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs ffmpeg + ffprobe")
class RealBytesTests(unittest.TestCase):
    """Generated at test time; no binary is committed."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.clip = self.tmp / "sixty.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=60:duration=10",
                        "-c:v", "mpeg4", "-an", str(self.clip)], check=True, timeout=120)

    def test_br_l_211_a_real_shortened_header_reads_as_its_frames(self):
        short = self.tmp / "short.mp4"
        _shorten_headers(self.clip, short, 40)
        self.assertAlmostEqual(video.video_fps(str(self.clip)), 60.0, places=1)
        self.assertGreater(video.video_fps(str(short)), video.RunwayVideoUpscaleAdapter.MAX_FPS + 0.5)


if __name__ == "__main__":
    unittest.main()
