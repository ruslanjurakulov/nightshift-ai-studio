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


def _probe(avg="60/1", frames=None, packets=None, stream_s=None, format_s=None, r="60/1", codec="h264"):
    s = {"index": 0, "codec_type": "video", "codec_name": codec, "avg_frame_rate": avg, "r_frame_rate": r}
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

    def submit(self, probe_json, name="source.mp4", decoded=None):
        """``decoded``: what ``-count_frames`` answers (a JSON dict, or an
        exception to raise); the packet probe answers ``probe_json``."""
        src = self.tmp / name
        src.write_bytes(MP4)
        seen = []

        def fake_run(argv, **kw):
            seen.append(argv)
            if "-count_frames" in argv:
                if isinstance(decoded, BaseException):
                    raise decoded
                return subprocess.CompletedProcess(argv, 0, json.dumps(decoded or {}).encode(), b"")
            if isinstance(probe_json, BaseException):
                raise probe_json
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

    def assertRefusedBeforeUpload(self, probe_json, words, **kw):
        err, calls, _ = self.submit(probe_json, **kw)
        self.assertIsNotNone(err, "the upscale was submitted")
        self.assertEqual(err.code, E_BAD_REQUEST)
        self.assertIn(words, err.message)
        self.assertNotIn(KEY, err.message)
        self.assertEqual(calls, [], "nothing may be uploaded or POSTed before the refusal")

    def assertSubmitted(self, probe_json, **kw):
        err, calls, _ = self.submit(probe_json, **kw)
        self.assertIsNone(err, err and err.message)
        self.assertEqual([c[1].rsplit("/", 1)[-1] for c in calls if "/v1/" in c[1]], ["uploads", "video_upscale"])


class UpscaleFrameCountPins(_Upscale):
    """The two reproductions Sentinel confirmed, as ffprobe reported them."""

    def test_br_l_211_a_tail_padded_sample_table_is_refused_before_upload(self):
        # Real 120 fps x264, 240 frames, last stts entry (1, 12 800 000).
        tail_padded = {"streams": [{"index": 0, "codec_type": "video", "codec_name": "h264",
                                    "avg_frame_rate": "9600/33413", "r_frame_rate": "120/1",
                                    "nb_frames": "240", "nb_read_packets": "240", "duration": "2.000000"}],
                       "format": {"duration": "2.000000"}}
        self.assertRefusedBeforeUpload(tail_padded, "holds 240 frames for the 2.0 seconds it is priced at")

    def test_br_l_211_a_shortened_header_is_refused_before_upload(self):
        # 60 fps, 10 s, 600 frames; mvhd/mdhd/tkhd durations divided by 40.
        self.assertRefusedBeforeUpload(_probe("60/1", 600, 600, 0.25, 0.25), "holds 600 frames for the 0.2 seconds")

    def test_br_l_211_frames_beyond_the_priced_length_after_an_edit_list_trim_are_refused(self):
        # 60 fps with 660 samples but an edit list that says 10 s: the vendor
        # receives every sample, so 66 a second is what it would bill.
        self.assertRefusedBeforeUpload(_probe("60/1", 660, 660, 10.0, 10.0), "re-encode the trimmed clip")

    def test_br_l_211_no_frame_count_anywhere_is_unknown_not_the_header_rate(self):
        self.assertRefusedBeforeUpload(_probe("30/1", None, None, 2.0, 2.0), "could not be read")

    def test_br_l_211_no_length_anywhere_is_unknown(self):
        self.assertRefusedBeforeUpload(_probe("30/1", 60, 60, None, None), "could not be read")

    def test_br_l_211_the_probe_counts_packets_and_reads_both_lengths(self):
        _, _, seen = self.submit(_probe("30/1", 60, 60, 2.0, 2.0))
        argv = seen[-1]
        self.assertIn("-count_packets", argv)
        entries = argv[argv.index("-show_entries") + 1]
        for want in ("avg_frame_rate", "nb_frames", "nb_read_packets", "duration", "format=duration",
                     "codec_type", "codec_name", "stream_disposition=attached_pic"):
            self.assertIn(want, entries)
        # Every stream, so cover art or a second picture cannot stand in for
        # the one Runway is sent (round 2, item 1).
        self.assertNotIn("-select_streams", argv)
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

    def test_cover_art_after_the_video_is_not_a_second_stream(self):
        # What every iTunes-tagged MP4 looks like: the picture, then the cover.
        p = _probe("30/1", 60, 60, 2.0, 2.0)
        p["streams"].append(_cover(1))
        self.assertSubmitted(p)

    def test_vp9_webm_whose_packets_are_its_frames(self):
        p = _probe("30/1", None, 60, None, 2.0, codec="vp9")
        err, calls, seen = self.submit(p, name="source.webm", decoded={"streams": [{"nb_read_frames": "60"}]})
        self.assertIsNone(err, err and err.message)
        decode = [a for a in seen if "-count_frames" in a]
        self.assertEqual(len(decode), 1, "a codec outside the allowlist must be decoded and counted")
        self.assertEqual(decode[0][decode[0].index("-select_streams") + 1], "0")
        self.assertEqual(decode[0][decode[0].index("-protocol_whitelist") + 1], "file")
        self.assertEqual(decode[0][decode[0].index("-f") + 1], "matroska")

    def test_h264_and_hevc_are_not_decoded(self):
        for codec in ("h264", "hevc"):
            with self.subTest(codec=codec):
                err, _, seen = self.submit(_probe("30/1", 60, 60, 2.0, 2.0, codec=codec))
                self.assertIsNone(err, err and err.message)
                self.assertFalse([a for a in seen if "-count_frames" in a])


def _cover(index, packets=1):
    """An iTunes ``covr`` as ffprobe 6.1.1 reports it (cf1000.mp4)."""
    return {"index": index, "codec_type": "video", "codec_name": "png", "avg_frame_rate": "0/0",
            "r_frame_rate": "90000/1", "nb_read_packets": str(packets), "duration": "10.000000",
            "disposition": {"attached_pic": 1}}


class UpscaleStreamPins(_Upscale):
    """Round 2, item 1 (HIGH, a regression on main): ``-select_streams v:0``
    read whichever video stream came first, and the vendor is sent all of them."""

    def test_br_l_211_cover_art_ahead_of_a_240_fps_video_is_refused_before_upload(self):
        # cf1000.mp4 / coverfirst.mp4: moov/udta moved ahead of the trak, so the
        # PNG is stream 0 (1 packet, avg 0/0) and the counted rate read 0.0.
        p = {"streams": [_cover(0), {"index": 1, "codec_type": "video", "codec_name": "h264",
                                     "avg_frame_rate": "240/1", "r_frame_rate": "240/1", "nb_frames": "2400",
                                     "nb_read_packets": "2400", "duration": "10.000000",
                                     "disposition": {"attached_pic": 0}}],
             "format": {"duration": "10.000000"}}
        self.assertRefusedBeforeUpload(p, "takes up to 60")

    def test_br_l_211_a_second_video_stream_is_refused_before_upload(self):
        # twostream_def1.mp4: a 64x64 1 fps v:0 and a 240 fps v:1.
        p = {"streams": [{"index": 0, "codec_type": "video", "codec_name": "h264", "avg_frame_rate": "1/1",
                          "nb_frames": "10", "nb_read_packets": "10", "duration": "10.000000"},
                         {"index": 1, "codec_type": "video", "codec_name": "h264", "avg_frame_rate": "240/1",
                          "nb_frames": "2400", "nb_read_packets": "2400", "duration": "10.000000"}],
             "format": {"duration": "10.000000"}}
        self.assertRefusedBeforeUpload(p, "this file holds 2 video streams; export it again with just the one "
                                          "to upscale")

    def test_only_cover_art_is_unknown_not_a_rate(self):
        self.assertRefusedBeforeUpload({"streams": [_cover(0)], "format": {"duration": "10"}}, "could not be read")


class UpscaleDecodedFramePins(_Upscale):
    """Round 2, item 2: a packet can hold more than one shown frame."""

    def test_br_l_211_vp9_superframes_of_8_frames_are_refused_before_upload(self):
        # sp8_30.mp4: 60 packets, 480 decoded frames, avg 30, 2 s.
        p = _probe("30/1", 60, 60, 2.0, 2.0, codec="vp9", r="30/1")
        self.assertRefusedBeforeUpload(p, "takes up to 60", decoded={"streams": [{"nb_read_frames": "480"}]})

    def test_br_l_211_mpeg4_packed_b_frames_are_counted_decoded(self):
        p = _probe("30/1", 60, 60, 2.0, 2.0, codec="mpeg4", r="30/1")
        self.assertRefusedBeforeUpload(p, "takes up to 60", decoded={"streams": [{"nb_read_frames": "130"}]})

    def test_a_decode_with_no_frame_count_is_unknown(self):
        p = _probe("30/1", 60, 60, 2.0, 2.0, codec="vp9")
        self.assertRefusedBeforeUpload(p, "could not be read", decoded={"streams": [{}]})

    def test_a_decode_that_runs_out_of_time_names_the_remedy(self):
        p = _probe("30/1", 60, 60, 2.0, 2.0, codec="vp9")
        self.assertRefusedBeforeUpload(
            p, "the video is too long to check within the time limit; shorten it or export it as H.264 MP4",
            decoded=subprocess.TimeoutExpired(["ffprobe"], 30))

    def test_a_packet_count_that_runs_out_of_time_does_not_say_export_as_mp4(self):
        err, calls, _ = self.submit(subprocess.TimeoutExpired(["ffprobe"], 30), decoded=None)
        self.assertIsNotNone(err)
        self.assertIn("too long to check within the time limit", err.message)
        self.assertNotIn("MP4", err.message)
        self.assertEqual(calls, [])


class UpscaleCutClipPins(_Upscale):
    """Round 2, item 3: ``ffmpeg -ss X -c copy`` and LosslessCut keep the
    frames back to the previous keyframe. Refused on purpose (the billing basis
    is unverified, so it fails closed), with the remedy that fits."""

    def test_a_stream_copied_cut_is_refused_with_the_re_encode_remedy(self):
        # A 30 fps 2 s cut: 197 frames in 2.1 s.
        err, calls, _ = self.submit(_probe("30/1", 197, 197, 2.1, 2.1, r="30/1"))
        self.assertIsNotNone(err, "a cut clip was submitted")
        self.assertEqual(err.message, "the file holds 197 frames for the 2.1 seconds it is priced at, as a clip "
                                      "cut without re-encoding does; re-encode the trimmed clip and upscale the "
                                      "new copy")
        self.assertEqual(calls, [])

    def test_a_60_fps_cut_gets_the_same_remedy(self):
        self.assertRefusedBeforeUpload(_probe("60/1", 632, 632, 10.034, 10.034),
                                       "the file holds 632 frames for the 10.0 seconds it is priced at")

    def test_a_truly_high_rate_file_keeps_the_ceiling_message(self):
        err, _, _ = self.submit(_probe("120/1", 240, 240, 2.0, 2.0, r="120/1"))
        self.assertIn("takes up to 60", err.message)
        self.assertNotIn("re-encode the trimmed clip", err.message)


class CountedRateTests(unittest.TestCase):
    def test_the_counted_rate_is_the_larger_of_the_average_and_frames_over_seconds(self):
        self.assertAlmostEqual(ml.counted_rate(*self._split(_probe("9600/33413", 240, 240, 2.0, 2.0))), 120.0)
        self.assertAlmostEqual(ml.counted_rate(*self._split(_probe("60/1", 600, 600, 0.25, 0.25))), 2400.0)
        self.assertAlmostEqual(ml.counted_rate(*self._split(_probe("30/1", 30, 30, 2.0, 2.0))), 30.0)

    def test_the_packet_count_is_preferred_to_the_header_sample_count(self):
        self.assertAlmostEqual(ml.counted_rate(*self._split(_probe("1/1", 2, 200, 2.0, 2.0))), 100.0)

    def test_one_packet_less_its_slack_is_unknown_not_zero(self):
        # Round 2, item 1: cover art read 0.0, and 0.0 passed every ceiling.
        stream = {"nb_read_packets": "1", "avg_frame_rate": "0/0", "duration": "10"}
        self.assertIsNone(ml.counted_rate(stream, {"duration": "10"}, slack_frames=1))
        self.assertIsNone(ml.measured_rate(stream, {"duration": "10"}, slack_frames=1))
        self.assertIsNone(ml.measured_rate({"nb_read_packets": "-3"}, {"duration": "10"}))

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

    def test_br_l_211_a_second_video_stream_is_budgeted_too(self):
        # The proxy maps v:0 and the thumbnail the largest picture: neither is
        # guaranteed to be the stream the budget read, so every picture counts.
        small = {"codec_type": "video", "width": 64, "height": 64, "avg_frame_rate": "1/1",
                 "nb_read_packets": "1200", "duration": "1200"}
        huge = {"codec_type": "video", "width": 7680, "height": 4320, "avg_frame_rate": "30/1",
                "nb_read_packets": "36000", "duration": "1200"}
        self.assertRefused({"streams": [small, huge], "format": {"duration": "1200"}}, "too_long")

    def test_cover_art_is_not_budgeted_as_a_video(self):
        v = {"codec_type": "video", "width": 1920, "height": 1080, "avg_frame_rate": "30/1",
             "nb_read_packets": "18000", "duration": "600"}
        cover = {"codec_type": "video", "width": 600, "height": 600, "avg_frame_rate": "0/0",
                 "r_frame_rate": "90000/1", "nb_read_packets": "1", "disposition": {"attached_pic": 1}}
        p = ml.interpret_probe("video/mp4", {"streams": [cover, v], "format": {"duration": "600"}})
        self.assertEqual(p.width, 1920)
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


def _atoms(b: bytes, start: int, end: int):
    out, i = [], start
    while i < end:
        n, t = struct.unpack(">I4s", b[i:i + 8])
        out.append((t, i, n))
        i += n
    return out


def _cover_first(src: Path, dst: Path) -> None:
    """Move ``moov/udta`` (the iTunes ``covr``) ahead of the traks, so ffprobe
    lists the cover as stream 0 (Breach's cover_first.py)."""
    b = bytearray(src.read_bytes())
    for t, i, n in _atoms(b, 0, len(b)):
        if t == b"moov":
            kids = _atoms(b, i + 8, i + n)
            order = [k for k in kids if k[0] == b"mvhd"] + [k for k in kids if k[0] == b"udta"] + \
                    [k for k in kids if k[0] not in (b"mvhd", b"udta")]
            b[i + 8:i + n] = b"".join(bytes(b[s:s + m]) for _, s, m in order)
    dst.write_bytes(bytes(b))


def _superpack(src: Path, dst: Path, k: int) -> None:
    """Pack ``k`` consecutive shown VP9 frames into one superframe per IVF
    packet, ``k`` ticks apart (Breach's superpack.py)."""
    b = src.read_bytes()
    hdr, i, frames = bytearray(b[:32]), 32, []
    while i < len(b):
        n, _ = struct.unpack("<IQ", b[i:i + 12])
        frames.append(b[i + 12:i + 12 + n])
        i += 12 + n
    packets = []
    for g in range(0, len(frames), k):
        grp = frames[g:g + k]
        marker = 0xc0 | (3 << 3) | (len(grp) - 1)
        index = bytes([marker]) + b"".join(struct.pack("<I", len(f)) for f in grp) + bytes([marker])
        packets.append(b"".join(grp) + index)
    struct.pack_into("<I", hdr, 24, len(packets))
    with open(dst, "wb") as fh:
        fh.write(hdr)
        for j, p in enumerate(packets):
            fh.write(struct.pack("<IQ", len(p), j * k))
            fh.write(p)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs ffmpeg + ffprobe")
class RealBytesTests(unittest.TestCase):
    """Generated at test time; no binary is committed."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.clip = self.tmp / "sixty.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=60:duration=10",
                        "-c:v", "mpeg4", "-an", str(self.clip)], check=True, timeout=120)

    def _submit(self, path):
        a = build_adapter("video.runway_upscale", env=ENV, session=_Session(_routes()))
        req = CapabilityRequest("video_upscale", input_media=(str(path),), upscale_target="4k")
        try:
            a.submit(req, "magnific_video_upscaler_creative")
        except AdapterError as e:
            return e, a.session.calls
        return None, a.session.calls

    def _ffmpeg(self, *args):
        subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True, timeout=120)

    def test_br_l_211_real_cover_art_ahead_of_a_240_fps_video_is_refused(self):
        # cover_first.py from Breach's round 2, at 1 s of 64x64.
        v, png = self.tmp / "v.mp4", self.tmp / "cover.png"
        tagged, forged = self.tmp / "tagged.mp4", self.tmp / "coverfirst.mp4"
        self._ffmpeg("-f", "lavfi", "-i", "testsrc=size=64x64:rate=240:duration=1", "-c:v", "libx264",
                     "-preset", "ultrafast", "-an", str(v))
        self._ffmpeg("-f", "lavfi", "-i", "color=c=red:s=16x16:d=1", "-frames:v", "1", str(png))
        self._ffmpeg("-i", str(v), "-i", str(png), "-map", "0", "-map", "1", "-c", "copy",
                     "-disposition:v:1", "attached_pic", str(tagged))
        _cover_first(tagged, forged)
        probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name",
                                           "-of", "json", str(forged)], capture_output=True, check=True).stdout)
        self.assertEqual(probe["streams"][0]["codec_name"], "png", "the forgery did not put the cover first")
        err, calls = self._submit(forged)
        self.assertIsNotNone(err, "a 240 fps video behind cover art was submitted")
        self.assertIn("takes up to 60", err.message)
        self.assertEqual(calls, [])
        # The ordinary order is the same refusal, and a 30 fps tagged file passes.
        self.assertIn("takes up to 60", self._submit(tagged)[0].message)
        ok_v, ok = self.tmp / "ok.mp4", self.tmp / "ok_tagged.mp4"
        self._ffmpeg("-f", "lavfi", "-i", "testsrc=size=64x64:rate=30:duration=1", "-c:v", "libx264",
                     "-preset", "ultrafast", "-an", str(ok_v))
        self._ffmpeg("-i", str(ok_v), "-i", str(png), "-map", "0", "-map", "1", "-c", "copy",
                     "-disposition:v:1", "attached_pic", str(ok))
        _cover_first(ok, self.tmp / "ok_first.mp4")
        for f in (ok, self.tmp / "ok_first.mp4"):
            with self.subTest(file=f.name):
                err, _ = self._submit(f)
                self.assertIsNone(err, err and err.message)

    def test_br_l_211_real_vp9_superframes_are_counted_by_their_frames(self):
        # superpack.py from Breach's round 2: 240 fps VP9 packed 8 shown frames
        # to a packet, so the container reads 30 packets a second.
        ivf, packed = self.tmp / "v240.ivf", self.tmp / "sp8.ivf"
        self._ffmpeg("-f", "lavfi", "-i", "testsrc=size=64x64:rate=240:duration=2", "-c:v", "libvpx-vp9",
                     "-auto-alt-ref", "0", "-lag-in-frames", "0", "-deadline", "realtime", "-cpu-used", "8",
                     "-an", str(ivf))
        _superpack(ivf, packed, 8)
        for name in ("sp8.mp4", "sp8.webm"):
            with self.subTest(container=name):
                out = self.tmp / name
                self._ffmpeg("-i", str(packed), "-c", "copy", str(out))
                err, calls = self._submit(out)
                self.assertIsNotNone(err, f"{name}: 240 fps in 30 packets a second was submitted")
                self.assertIn("takes up to 60", err.message)
                self.assertEqual(calls, [])
        honest = self.tmp / "honest.webm"
        self._ffmpeg("-f", "lavfi", "-i", "testsrc=size=64x64:rate=30:duration=2", "-c:v", "libvpx-vp9",
                     "-deadline", "realtime", "-cpu-used", "8", "-an", str(honest))
        err, _ = self._submit(honest)
        self.assertIsNone(err, err and err.message)

    def test_br_l_211_a_real_shortened_header_reads_as_its_frames(self):
        short = self.tmp / "short.mp4"
        _shorten_headers(self.clip, short, 40)
        self.assertAlmostEqual(video.video_fps(str(self.clip)), 60.0, places=1)
        self.assertGreater(video.video_fps(str(short)), video.RunwayVideoUpscaleAdapter.MAX_FPS + 0.5)


if __name__ == "__main__":
    unittest.main()
