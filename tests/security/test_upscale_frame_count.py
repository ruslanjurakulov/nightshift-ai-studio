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

from modules import ffmpeg_limits as fl
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


def same_file(src, reading, work):
    """The upscale's remux, replaced by a plain copy: these pins are about the
    READING, which runs again on the copy (BR-L-211 (a)) and must agree. The
    remux itself is pinned with real bytes in test_upscale_normalize.py."""
    copy = Path(work) / Path(src).name
    shutil.copyfile(src, copy)
    return video.Normalized(copy)


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
    """Submits through the REAL ``read_frames`` with ffprobe's answer faked,
    so the probe's arguments and its reading are both what production runs."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def submit(self, probe_json, name="source.mp4", decoded=None, decoded_stderr=b""):
        """``decoded``: what ``-count_frames`` answers (a JSON dict, or an
        exception to raise), with ``decoded_stderr`` on stderr; the packet
        probe answers ``probe_json``. ``self.run_kw`` keeps each call's
        keyword arguments (the decode's environment)."""
        src = self.tmp / name
        src.write_bytes(MP4)
        seen = []
        self.run_kw = []

        def fake_run(argv, **kw):
            seen.append(argv)
            self.run_kw.append(kw)
            if "-count_frames" in argv:
                if isinstance(decoded, BaseException):
                    raise decoded
                return subprocess.CompletedProcess(argv, 0, json.dumps(decoded or {}).encode(), decoded_stderr)
            if isinstance(probe_json, BaseException):
                raise probe_json
            return subprocess.CompletedProcess(argv, 0, json.dumps(probe_json).encode(), b"")

        a = build_adapter("video.runway_upscale", env=ENV, session=_Session(_routes()))
        a.normalize_of = same_file
        req = CapabilityRequest("video_upscale", input_media=(str(src),), upscale_target="4k")
        with mock.patch.object(video.shutil, "which", return_value="/usr/bin/ffprobe"), \
                mock.patch.object(video, "_bounded_run", side_effect=fake_run):
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
        self.assertRefusedBeforeUpload(tail_padded, "holds 240 frames in 2.0 seconds of picture")

    def test_br_l_211_a_shortened_header_is_refused_before_upload(self):
        # 60 fps, 10 s, 600 frames; mvhd/mdhd/tkhd durations divided by 40.
        self.assertRefusedBeforeUpload(_probe("60/1", 600, 600, 0.25, 0.25),
                                       "holds 600 frames in 0.2 seconds of picture")

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
        # Decoded twice: the member's file, then the copy that is uploaded
        # (BR-L-211 (a): what is priced is what is sent).
        self.assertEqual(len(decode), 2, "a codec outside the allowlist must be decoded and counted")
        self.assertEqual(decode[0][-1], str(self.tmp / "source.webm"))
        self.assertNotEqual(decode[1][-1], decode[0][-1])
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

    def test_a_decode_that_runs_out_of_time_names_the_files_own_codec_and_container(self):
        # Round 3, item 6 (Atlas): a VP9 WebM was told to become H.264 MP4.
        p = _probe("30/1", None, 60, None, 2.0, codec="vp9")
        err, calls, _ = self.submit(p, name="source.webm", decoded=subprocess.TimeoutExpired(["ffprobe"], 30))
        self.assertEqual(err.message, "this VP9 WebM is too long to count its frames within the time limit; "
                                      "shorten it and upscale the shorter copy")
        self.assertEqual(calls, [])
        err, _, _ = self.submit(_probe("30/1", None, 60, None, 2.0, codec="av1"), name="source.mkv",
                                decoded=subprocess.TimeoutExpired(["ffprobe"], 30))
        self.assertEqual(err.message, "this AV1 MKV is too long to count its frames within the time limit; "
                                      "shorten it and upscale the shorter copy")

    def test_a_decode_timeout_of_a_codec_without_a_name_says_only_the_container(self):
        err, _, _ = self.submit(_probe("30/1", None, 60, None, 2.0, codec="theora"), name="source.mkv",
                                decoded=subprocess.TimeoutExpired(["ffprobe"], 30))
        self.assertEqual(err.message, "this MKV is too long to count its frames within the time limit; "
                                      "shorten it and upscale the shorter copy")

    def test_a_packet_count_that_runs_out_of_time_does_not_name_another_format(self):
        err, calls, _ = self.submit(subprocess.TimeoutExpired(["ffprobe"], 30), name="source.webm", decoded=None)
        self.assertEqual(err.message, "this WebM is too long to read within the time limit; shorten it and "
                                      "upscale the shorter copy")
        self.assertNotIn("H.264", err.message)
        self.assertEqual(calls, [])


class UpscaleCutClipPins(_Upscale):
    """Round 2, item 3: ``ffmpeg -ss X -c copy`` and LosslessCut keep the
    frames back to the previous keyframe. Refused on purpose (the billing basis
    is unverified, so it fails closed), with the remedy that fits."""

    def test_a_stream_copied_cut_is_refused_with_the_re_encode_remedy(self):
        # A 30 fps 2 s cut: 197 frames in 2.1 s.
        err, calls, _ = self.submit(_probe("30/1", 197, 197, 2.1, 2.1, r="30/1"))
        self.assertIsNotNone(err, "a cut clip was submitted")
        # "Seconds of picture", not "priced at": the rate is counted over the
        # picture's length, and the price over the file's (Lens round 3, 4).
        self.assertEqual(err.message, "the file holds 197 frames in 2.1 seconds of picture, as a clip cut without "
                                      "re-encoding does; re-encode the trimmed clip and upscale the new copy")
        self.assertEqual(calls, [])

    def test_a_60_fps_cut_gets_the_same_remedy(self):
        self.assertRefusedBeforeUpload(_probe("60/1", 632, 632, 10.034, 10.034),
                                       "the file holds 632 frames in 10.0 seconds of picture")

    def test_a_truly_high_rate_file_keeps_the_ceiling_message(self):
        err, _, _ = self.submit(_probe("120/1", 240, 240, 2.0, 2.0, r="120/1"))
        self.assertEqual(err.message, "this video runs at 120 frames a second of picture; the upscale takes up to "
                                      "60, so export it again at 60 frames a second or fewer")

    def test_the_seconds_stated_are_the_pictures_not_the_priced_files(self):
        # Lens round 3, 4: sound to 3.0 s prices 3 s; the frames were counted
        # over the picture's 2.1 s, which is the figure the message may state.
        err, _, _ = self.submit(_probe("30/1", 197, 197, 2.1, 3.0, r="30/1"))
        self.assertIn("197 frames in 2.1 seconds of picture", err.message)
        self.assertNotIn("priced at", err.message)


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


_SWITCH_STDERR = (b"[vp9 @ 0x55f5b103f7c0] [IMGUTILS @ 0x7f35b77a0060] Picture size 8192x8192 exceeds specified max "
                  b"pixel count 36683776, see the documentation if you wish to increase it\n"
                  b"[vp9 @ 0x55f5b103f7c0] Failed to initialize decoder for 8192x8192 @ 0\n")


class UpscaleDecodeLimitPins(_Upscale):
    """Round 3, item 1 (Lens): the ``-count_frames`` decode of a member's file
    ran with no frame cap, thread pin or address-space limit, unlike every
    other decode of member media (``ffmpeg_limits``)."""

    def _decode(self, name="source.webm", **kw):
        p = _probe("30/1", None, 60, None, 2.0, codec="vp9")
        err, calls, seen = self.submit(p, name=name, decoded={"streams": [{"nb_read_frames": "60"}]}, **kw)
        i = next(n for n, a in enumerate(seen) if "-count_frames" in a)
        return err, calls, seen[i], self.run_kw[i]

    def test_br_l_211_the_frame_decode_runs_under_the_decoder_limits(self):
        err, _, argv, kw = self._decode()
        self.assertIsNone(err, err and err.message)
        prefix = fl.limited_argv([])
        self.assertEqual(argv[:len(prefix)], prefix, "the decode must run under the address-space limit")
        inner = argv[len(prefix):]
        self.assertTrue(inner[0].endswith("ffprobe"))
        src = inner.index(str(self.tmp / "source.webm"))
        self.assertEqual(inner[inner.index("-max_pixels") + 1], str(ml.decoder_max_pixels("video/webm")))
        self.assertLess(inner.index("-max_pixels"), src)
        self.assertEqual(inner[inner.index("-threads") + 1], str(fl.DECODE_THREADS))
        self.assertLess(inner.index("-threads"), src)
        for k, v in fl.CHILD_ENV.items():
            self.assertEqual((kw.get("env") or {}).get(k), v)

    def test_every_accepted_container_gets_the_video_frame_cap(self):
        for name, mime in (("source.mp4", "video/mp4"), ("source.mov", "video/quicktime"),
                           ("source.mkv", "video/x-matroska")):
            with self.subTest(name=name):
                _, _, argv, _ = self._decode(name)
                self.assertEqual(argv[argv.index("-max_pixels") + 1], str(ml.decoder_max_pixels(mime)))
                self.assertEqual(ml.decoder_max_pixels(mime), ml.decoder_max_pixels("video/webm"))

    def test_br_l_211_a_frame_over_the_cap_is_refused_with_the_size_remedy_not_unknown(self):
        err, calls, _, _ = self._decode(decoded_stderr=_SWITCH_STDERR)
        self.assertEqual(err.message, "a frame in this VP9 WebM is larger than the upscale accepts; export it "
                                      "again at no more than 35.6 megapixels a frame (8K UHD, 7680x4320, fits)")
        self.assertEqual(calls, [])

    def test_a_decode_out_of_memory_under_the_limit_is_refused(self):
        err, calls, _, _ = self._decode(decoded_stderr=b"[vp9 @ 0x1] get_buffer() failed\n")
        self.assertEqual(err.message, "decoding this VP9 WebM needed more memory than the upscale allows; export "
                                      "it again at a smaller frame size")
        self.assertEqual(calls, [])

    def test_a_damaged_frame_is_not_a_refusal(self):
        # What a flipped byte logs (ffmpeg_limits): not a marker, so the count stands.
        err, _, _, _ = self._decode(decoded_stderr=b"[vp9 @ 0x1] Error parsing frame header\n")
        self.assertIsNone(err, err and err.message)


def _still(index, codec="mjpeg", packets=1):
    """A thumbnail kept as its own track, not tagged attached_pic (Lens's
    two_trak.mp4: ``-map 0 -map 1 -c copy`` of a JPEG)."""
    return {"index": index, "codec_type": "video", "codec_name": codec, "avg_frame_rate": "25/1",
            "r_frame_rate": "25/1", "nb_frames": str(packets), "nb_read_packets": str(packets),
            "duration": "0.040000", "disposition": {"attached_pic": 0}}


class UpscaleStillTrackPins(_Upscale):
    """Round 3, item 2 (Lens): main read v:0 and accepted a one-frame JPEG
    track beside the video; round 2 refused it as a second video stream."""

    def _with(self, *extra):
        p = _probe("30/1", 120, 120, 4.0, 4.0)
        p["streams"].extend(extra)
        return p

    def test_a_one_packet_jpeg_track_beside_h264_is_accepted(self):
        self.assertSubmitted(self._with(_still(1)))

    def test_a_one_packet_jpeg_track_ahead_of_h264_is_accepted(self):
        p = self._with()
        p["streams"].insert(0, _still(1))
        self.assertSubmitted(p)

    def test_a_one_packet_png_track_is_accepted(self):
        self.assertSubmitted(self._with(_still(1, codec="png")))

    def test_a_two_packet_jpeg_track_is_refused(self):
        self.assertRefusedBeforeUpload(self._with(_still(1, packets=2)), "this file holds 2 video streams")

    def test_a_one_packet_vp9_track_is_still_a_second_video_stream(self):
        # A VP9 packet can be a superframe of 8 shown frames: never a still.
        self.assertRefusedBeforeUpload(self._with(_still(1, codec="vp9")), "this file holds 2 video streams")

    def test_a_jpeg_track_with_no_count_is_not_assumed_to_be_one_picture(self):
        still = _still(1)
        del still["nb_frames"], still["nb_read_packets"]
        self.assertRefusedBeforeUpload(self._with(still), "this file holds 2 video streams")

    def test_a_jpeg_track_with_one_packet_but_more_samples_is_refused(self):
        still = _still(1)
        still["nb_frames"] = "50"
        self.assertRefusedBeforeUpload(self._with(still), "this file holds 2 video streams")

    def test_only_a_one_packet_jpeg_is_unknown_not_a_rate(self):
        self.assertRefusedBeforeUpload({"streams": [_still(0)], "format": {"duration": "4"}}, "could not be read")


class HiddenSamplePins(_Upscale):
    """Round 3, item 3 (Breach finding 1): samples outside the MP4 edit list.
    hide_tail2.mp4 plays 2 s at 30 fps and carries 8 s at 240 fps beyond the
    edit: ffprobe reads 60 packets (the demuxer drops what the edit leaves
    out) and ``nb_frames`` 1980 (the sample table), avg 18. The vendor is sent
    every sample."""

    HIDDEN = {"streams": [{"index": 0, "codec_type": "video", "codec_name": "h264",
                           "avg_frame_rate": "475200/26399", "r_frame_rate": "240/1", "nb_frames": "1980",
                           "nb_read_packets": "60", "duration": "2.000000"}],
              "format": {"duration": "2.000000"}}

    def test_br_l_211_samples_outside_the_edit_list_are_counted_and_refused_before_upload(self):
        self.assertRefusedBeforeUpload(self.HIDDEN, "the file holds 1980 frames in 2.0 seconds of picture")

    def test_br_l_211_the_frame_count_is_the_larger_of_packets_and_samples(self):
        self.assertEqual(ml.frame_count({"nb_read_packets": "60", "nb_frames": "1980"}), 1980)
        self.assertEqual(ml.frame_count({"nb_read_packets": "200", "nb_frames": "2"}), 200)
        # A header 0 (a fragmented MP4) is still unknown, not a count.
        self.assertEqual(ml.frame_count({"nb_read_packets": "50", "nb_frames": "0"}), 50)
        self.assertEqual(ml.frame_count({"nb_frames": "1980"}), 1980)
        self.assertEqual(ml.frame_count({"nb_read_packets": "0"}), 0)

    def test_br_l_211_hidden_samples_count_in_the_decoded_path_too(self):
        p = json.loads(json.dumps(self.HIDDEN))
        p["streams"][0]["codec_name"] = "vp9"
        self.assertRefusedBeforeUpload(p, "1980 frames", decoded={"streams": [{"nb_read_frames": "60"}]})

    def test_br_l_211_ingest_budgets_the_hidden_samples(self):
        with self.assertRaises(ml.IngestReject) as e:
            ml.interpret_probe("video/mp4", {"streams": [{"codec_type": "video", "width": 7680, "height": 4320,
                                                          "avg_frame_rate": "30/1", "nb_read_packets": "60",
                                                          "nb_frames": "36000", "duration": "2"}],
                                             "format": {"duration": "2"}})
        self.assertEqual(e.exception.reason, "too_long")

    def test_samples_with_no_packet_read_are_still_not_media(self):
        # The larger count budgets; it must not vouch for a stream the
        # demuxer reads nothing of.
        with self.assertRaises(ml.IngestReject) as e:
            ml.interpret_probe("video/mp4", {"streams": [{"codec_type": "video", "width": 64, "height": 64,
                                                          "avg_frame_rate": "30/1", "nb_read_packets": "0",
                                                          "nb_frames": "1980", "duration": "2"}],
                                             "format": {"duration": "2"}})
        self.assertEqual(e.exception.reason, "not_media")

    def test_one_preroll_sample_above_the_packets_is_forgiven(self):
        # An x264 MP4 with B-frames and an edit list: one sample more than the
        # packets read, within the one frame of slack.
        self.assertSubmitted(_probe("30/1", 121, 120, 4.0, 4.0))


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


def _boxes(buf: bytes):
    out, i = [], 0
    while i < len(buf):
        n, t = struct.unpack(">I4s", buf[i:i + 8])
        out.append([t, buf[i + 8:i + n]])
        i += n
    return out


def _unbox(boxes) -> bytes:
    return b"".join(struct.pack(">I4s", len(body) + 8, t) + body for t, body in boxes)


def _stts_pad(src: Path, dst: Path, pad_s: float) -> None:
    """Give the last video sample ``pad_s`` seconds (stts) and grow mdhd to
    match (Breach's stts_pad.py)."""
    md = {}

    def fix(boxes):
        for x in boxes:
            t, body = x
            if t == b"mdhd":
                md["ts"], md["box"] = struct.unpack(">I", body[12:16])[0], x
            if t in (b"moov", b"trak", b"mdia", b"minf", b"stbl"):
                kids = _boxes(body)
                fix(kids)
                x[1] = _unbox(kids)
            if t == b"stts":
                n = struct.unpack(">I", body[4:8])[0]
                ents = [list(struct.unpack(">II", body[8 + 8 * i:16 + 8 * i])) for i in range(n)]
                ents[-1][0] -= 1
                ents = [e for e in ents + [[1, int(pad_s * md["ts"])]] if e[0]]
                x[1] = body[:4] + struct.pack(">I", len(ents)) + b"".join(struct.pack(">II", *e) for e in ents)
                q = bytearray(md["box"][1])
                q[16:20] = struct.pack(">I", sum(a * d for a, d in ents))
                md["box"][1] = bytes(q)

    top = _boxes(src.read_bytes())
    fix(top)
    dst.write_bytes(_unbox(top))


def _elst_cut(src: Path, dst: Path, start_s: float, seg_s: float) -> None:
    """Make the video trak's edit list one segment [start, start + seg) and
    shorten mvhd/tkhd to it; the samples outside stay in the file (Breach's
    elst_cut.py)."""
    top, ts = _boxes(src.read_bytes()), {}

    def scan(boxes):
        for t, body in boxes:
            if t in (b"mvhd", b"mdhd"):
                ts[t] = struct.unpack(">I", body[12:16])[0]
            if t in (b"moov", b"trak", b"mdia"):
                scan(_boxes(body))

    scan(top)
    seg, mt = int(seg_s * ts[b"mvhd"]), int(start_s * ts[b"mdhd"])

    def fix(boxes):
        out = []
        for t, body in boxes:
            if t == b"edts":
                continue
            if t in (b"mvhd", b"tkhd"):
                off = 16 if t == b"mvhd" else 20
                body = body[:off] + struct.pack(">I", seg) + body[off + 4:]
            if t in (b"moov", b"trak", b"mdia"):
                body = _unbox(fix(_boxes(body)))
            out.append([t, body])
            if t == b"tkhd":
                elst = struct.pack(">II", 0, 1) + struct.pack(">IIhh", seg, mt, 1, 0)
                out.append([b"edts", _unbox([[b"elst", elst]])])
        return out

    dst.write_bytes(_unbox(fix(top)))


def _box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", 8 + len(payload)) + kind + payload


def _full(kind: bytes, payload: bytes, version: int = 0) -> bytes:
    return _box(kind, bytes([version, 0, 0, 0]) + payload)


def _trak(timescale, stts, *, codec=b"avc1", samples=None, media_ticks=None, track_ticks=None, esds=b""):
    """A video trak as a muxer writes one: stsd's one sample entry, stts,
    stsz (``samples``, default the stts total), mdhd's length (default the
    stts total time) and tkhd's in a 1000-tick movie timescale."""
    total, ticks = sum(n for n, _ in stts), sum(n * d for n, d in stts)
    media = ticks if media_ticks is None else media_ticks
    track = round(media * 1000 / timescale) if track_ticks is None else track_ticks
    tkhd = _full(b"tkhd", struct.pack(">IIIII", 0, 0, 1, 0, track) + b"\x00" * 60)
    mdhd = _full(b"mdhd", struct.pack(">IIII", 0, 0, timescale, media) + b"\x00" * 4)
    hdlr = _full(b"hdlr", struct.pack(">I", 0) + b"vide" + b"\x00" * 13)
    stsd = _full(b"stsd", struct.pack(">I", 1) + _box(codec, b"\x00" * 78 + esds))
    table = _full(b"stts", struct.pack(">I", len(stts)) + b"".join(struct.pack(">II", n, d) for n, d in stts))
    stsz = _full(b"stsz", struct.pack(">II", 0, total if samples is None else samples))
    return _box(b"trak", tkhd + _box(b"mdia", mdhd + hdlr + _box(b"minf", _box(b"stbl", stsd + table + stsz))))


def _movie(*traks, movie_ticks=0) -> bytes:
    mvhd = _full(b"mvhd", struct.pack(">IIII", 0, 0, 1000, movie_ticks) + b"\x00" * 80)
    return (_box(b"ftyp", b"isom\x00\x00\x02\x00isomiso2") + _box(b"moov", mvhd + b"".join(traks))
            + _box(b"mdat", b"\x00" * 1024))


class ContainerReadPins(unittest.TestCase):
    """#949 read an MP4 / MOV's rate from its stts alone when ffprobe is not on
    the machine (the Probe models runner): every BR-L-211 header lie came back
    on that path. ffprobe is hidden here; each file is what the ffprobe path
    already refuses, written as the boxes themselves."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def _hidden(self):
        real = shutil.which
        return mock.patch.object(video.shutil, "which",
                                 lambda name, *a, **k: None if name == "ffprobe" else real(name, *a, **k))

    def _submit(self, data: bytes, name="source.mp4"):
        src = self.tmp / name
        src.write_bytes(data)
        a = build_adapter("video.runway_upscale", env=ENV, session=_Session(_routes()))
        a.normalize_of = same_file
        req = CapabilityRequest("video_upscale", input_media=(str(src),), upscale_target="4k")
        with self._hidden(), mock.patch.object(video, "_bounded_run",
                                               side_effect=AssertionError("ffprobe is not on this machine")):
            try:
                a.submit(req, "magnific_video_upscaler_creative")
            except AdapterError as e:
                return e, a.session.calls
        return None, a.session.calls

    def assertRefused(self, data, words, **kw):
        err, calls = self._submit(data, **kw)
        self.assertIsNotNone(err, "the upscale was submitted")
        self.assertEqual(err.code, E_BAD_REQUEST)
        self.assertIn(words, err.message)
        self.assertEqual(calls, [], "nothing may be uploaded or POSTed before the refusal")

    def assertAccepted(self, data, **kw):
        err, calls = self._submit(data, **kw)
        self.assertIsNone(err, err and err.message)
        self.assertEqual([c[1].rsplit("/", 1)[-1] for c in calls if "/v1/" in c[1]], ["uploads", "video_upscale"])

    def test_an_honest_30_fps_h264_is_accepted(self):
        self.assertAccepted(_movie(_trak(15360, [(120, 512)]), movie_ticks=4000))

    def test_br_l_211_a_tail_padded_stts_is_refused_without_ffprobe(self):
        # 240 frames of 120 fps; the last sample padded to 833 s, so the stts
        # average reads 0.287 fps. mdhd still says 2 s.
        self.assertRefused(_movie(_trak(15360, [(239, 128), (1, 12800000)], media_ticks=30720), movie_ticks=2000),
                           "holds 240 frames in 2.0 seconds of picture")

    def test_br_l_211_every_header_at_a_quarter_second_is_refused_without_ffprobe(self):
        # 600 samples at 60 fps (10 s), mdhd / mvhd / tkhd all 0.25 s.
        self.assertRefused(_movie(_trak(15360, [(600, 256)], media_ticks=3840, track_ticks=250), movie_ticks=250),
                           "holds 600 frames in 0.2 seconds of picture")

    def test_the_shortest_header_wins_whichever_it_is(self):
        honest = dict(media_ticks=153600, track_ticks=10000)
        for name, trak, movie in (("mdhd", dict(honest, media_ticks=3840), 10000),
                                  ("tkhd", dict(honest, track_ticks=250), 10000),
                                  ("mvhd", honest, 250)):
            with self.subTest(short=name):
                self.assertRefused(_movie(_trak(15360, [(600, 256)], **trak), movie_ticks=movie),
                                   "holds 600 frames in 0.2 seconds of picture")

    def test_br_l_211_a_sample_size_count_unlike_the_stts_total_is_unknown(self):
        data = _movie(_trak(15360, [(120, 512)], samples=1980), movie_ticks=4000)
        src = self.tmp / "s.mp4"
        src.write_bytes(data)
        with self._hidden():
            self.assertIsNone(video.read_frames(str(src)).rate)
            self.assertIsNone(video.video_fps(str(src)))
        self.assertRefused(data, "could not be read")

    def test_br_l_211_two_video_traks_are_refused_without_ffprobe(self):
        self.assertRefused(_movie(_trak(15360, [(120, 512)]), _trak(15360, [(480, 128)]), movie_ticks=4000),
                           "this file holds 2 video streams")

    def test_a_one_sample_jpeg_trak_ahead_of_h264_is_accepted_without_ffprobe(self):
        # One tick of a 90 kHz scale: read as the stream, it is 90 000 fps.
        thumb = _trak(90000, [(1, 1)], codec=b"jpeg")
        self.assertAccepted(_movie(thumb, _trak(15360, [(120, 512)]), movie_ticks=4000), name="source.mov")

    def test_an_mp4v_jpeg_thumbnail_is_a_still_and_mpeg4_video_is_not(self):
        # An .mp4 stores the JPEG as mp4v, objectTypeIndication 0x6C (ffmpeg's
        # -map 0 -map 1 -c copy); 0x20 is MPEG-4 Part 2 video.
        def esds(oti):
            dc = bytes([0x04, 13, oti, 0x11]) + b"\x00" * 11
            return _full(b"esds", bytes([0x03, 3 + len(dc), 0, 1, 0]) + dc)

        main = _trak(15360, [(120, 512)])
        self.assertAccepted(_movie(_trak(90000, [(1, 1)], codec=b"mp4v", esds=esds(0x6C)), main, movie_ticks=4000))
        self.assertRefused(_movie(_trak(90000, [(1, 1)], codec=b"mp4v", esds=esds(0x20)), main, movie_ticks=4000),
                           "this file holds 2 video streams")
        # PNG (0x6D) is the same still, one sample only.
        self.assertAccepted(_movie(_trak(90000, [(1, 1)], codec=b"mp4v", esds=esds(0x6D)), main, movie_ticks=4000))

    def test_an_mp4v_jpeg_track_of_more_than_one_sample_is_a_second_video(self):
        # A "JPEG" mp4v track of several samples is a video of stills, not a thumbnail: the one-sample rule of the
        # jpeg/png stills applies to it too, so it is a second picture stream and the file is refused (Atlas, 28 Nov).
        def esds(oti):
            dc = bytes([0x04, 13, oti, 0x11]) + b"\x00" * 11
            return _full(b"esds", bytes([0x03, 3 + len(dc), 0, 1, 0]) + dc)

        main = _trak(15360, [(120, 512)])
        for oti in (0x6C, 0x6D):
            with self.subTest(oti=hex(oti)):
                self.assertRefused(_movie(_trak(90000, [(2, 1)], codec=b"mp4v", esds=esds(oti)), main, movie_ticks=4000),
                                   "this file holds 2 video streams")

    def test_a_jpeg_trak_of_two_samples_is_a_second_video(self):
        thumb = _trak(90000, [(2, 1)], codec=b"jpeg")
        self.assertRefused(_movie(thumb, _trak(15360, [(120, 512)]), movie_ticks=4000),
                           "this file holds 2 video streams")

    def test_br_l_211_a_codec_it_cannot_count_without_ffprobe_is_unknown(self):
        # A VP9 sample can be a superframe of 8 shown frames and an MPEG-4 one
        # two packed B-frames: without a decoder, samples are not frames.
        for codec in (b"vp09", b"mp4v", b"av01"):
            with self.subTest(codec=codec):
                self.assertRefused(_movie(_trak(15360, [(120, 512)], codec=codec), movie_ticks=4000),
                                   "could not be read")

    def test_webm_without_ffprobe_is_unknown(self):
        self.assertRefused(b"\x1a\x45\xdf\xa3" + b"\x00" * 1024, "could not be read", name="source.webm")


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

    def test_br_l_211_real_samples_hidden_outside_the_edit_list_are_refused(self):
        # Breach round 3, finding 1, at 64x64: 2 s at 30 fps, then 8 s at 240 fps
        # past the edit, the last sample padded so the average reads 18.
        src, padded, hidden = self.tmp / "src.mp4", self.tmp / "padded.mp4", self.tmp / "hide_tail.mp4"
        self._ffmpeg("-f", "lavfi", "-i", "testsrc2=s=64x64:r=240:d=10", "-vf", r"select='gte(t\,2)+not(mod(n\,8))'",
                     "-fps_mode", "passthrough", "-c:v", "libx264", "-preset", "ultrafast", "-g", "1",
                     "-use_editlist", "0", "-an", str(src))
        _stts_pad(src, padded, 100)
        _elst_cut(padded, hidden, 0, 2)
        probe = json.loads(subprocess.run(ml.probe_command("ffprobe", hidden, "video/mp4"), capture_output=True,
                                          check=True, timeout=60).stdout)
        stream = probe["streams"][0]
        self.assertEqual((stream["nb_read_packets"], stream["nb_frames"]), ("60", "1980"),
                         "the forgery did not hide the samples from the packet count")
        self.assertEqual(ml.frame_count(stream), 1980)
        err, calls = self._submit(hidden)
        self.assertIsNotNone(err, "1980 frames priced as 2 s were submitted")
        self.assertIn("1980 frames in 2.0 seconds of picture", err.message)
        self.assertEqual(calls, [])

    def test_br_l_211_a_real_vp9_frame_size_switch_is_refused_before_upload(self):
        # Lens round 3, switch.webm: a small VP9 WebM joined by -c copy with a
        # short one whose frames are over the decoder cap. The header and the
        # packet count read the small frame; only the decoder meets the big one.
        small, big, joined = self.tmp / "a.webm", self.tmp / "b.webm", self.tmp / "switch.webm"
        side = 6400
        self.assertGreater(side * side, ml.decoder_max_pixels("video/webm"))
        vp9 = ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-an"]
        self._ffmpeg("-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=1", *vp9, str(small))
        self._ffmpeg("-f", "lavfi", "-i", f"color=c=blue:s={side}x{side}:r=30:d=0.1", *vp9, str(big))
        listing = self.tmp / "list.txt"
        listing.write_text(f"file '{small}'\nfile '{big}'\n", encoding="utf-8")
        self._ffmpeg("-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(joined))
        err, calls = self._submit(joined)
        self.assertIsNotNone(err, "a VP9 WebM switching to a frame over the cap was submitted")
        self.assertTrue(err.message.startswith("a frame in this VP9 WebM is larger than the upscale accepts"),
                        err.message)
        self.assertEqual(calls, [])

    def test_a_real_jpeg_thumbnail_track_is_accepted_and_two_real_videos_are_not(self):
        # Lens round 3, two_trak.mp4/.mov and aux2.mov.
        main, thumb, aux = self.tmp / "main.mp4", self.tmp / "thumb.jpg", self.tmp / "aux.mp4"
        x264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an"]
        self._ffmpeg("-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=4", *x264, str(main))
        self._ffmpeg("-f", "lavfi", "-i", "testsrc=size=160x120:rate=1", "-frames:v", "1", str(thumb))
        self._ffmpeg("-f", "lavfi", "-i", "testsrc=size=160x120:rate=30:duration=4", *x264, str(aux))
        for ext in (".mp4", ".mov"):
            with self.subTest(ext=ext):
                two = self.tmp / f"two_trak{ext}"
                self._ffmpeg("-i", str(main), "-i", str(thumb), "-map", "0", "-map", "1", "-c", "copy", str(two))
                err, calls = self._submit(two)
                self.assertIsNone(err, err and err.message)
                both = self.tmp / f"aux2{ext}"
                self._ffmpeg("-i", str(main), "-i", str(aux), "-map", "0", "-map", "1", "-c", "copy", str(both))
                err, calls = self._submit(both)
                self.assertIsNotNone(err, "two real video tracks were submitted")
                self.assertIn("this file holds 2 video streams", err.message)
                self.assertEqual(calls, [])

    def test_br_l_211_the_container_read_without_ffprobe_agrees_with_ffprobe_on_real_forgeries(self):
        # The same real H.264 files the ffprobe pins above use, read again with
        # ffprobe hidden (the Probe models runner): the verdict, the frames
        # and the seconds must be ffprobe's.
        x264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an"]
        src, padded, hidden = self.tmp / "src.mp4", self.tmp / "padded.mp4", self.tmp / "hide_tail.mp4"
        self._ffmpeg("-f", "lavfi", "-i", "testsrc2=s=64x64:r=240:d=10", "-vf", r"select='gte(t\,2)+not(mod(n\,8))'",
                     "-fps_mode", "passthrough", *x264, "-g", "1", "-use_editlist", "0", str(src))
        _stts_pad(src, padded, 100)
        _elst_cut(padded, hidden, 0, 2)
        v240, png, tagged, first = (self.tmp / n for n in ("v240.mp4", "cover.png", "tagged.mp4", "first.mp4"))
        self._ffmpeg("-f", "lavfi", "-i", "testsrc=size=64x64:rate=240:duration=1", *x264, str(v240))
        self._ffmpeg("-f", "lavfi", "-i", "color=c=red:s=16x16:d=1", "-frames:v", "1", str(png))
        self._ffmpeg("-i", str(v240), "-i", str(png), "-map", "0", "-map", "1", "-c", "copy",
                     "-disposition:v:1", "attached_pic", str(tagged))
        _cover_first(tagged, first)
        main, thumb, aux = self.tmp / "main.mp4", self.tmp / "thumb.jpg", self.tmp / "aux.mp4"
        self._ffmpeg("-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=4", *x264, str(main))
        self._ffmpeg("-f", "lavfi", "-i", "testsrc=size=160x120:rate=1", "-frames:v", "1", str(thumb))
        self._ffmpeg("-f", "lavfi", "-i", "testsrc=size=160x120:rate=30:duration=4", *x264, str(aux))
        files = {"hide_tail": (hidden, False), "cover_first_240": (first, False), "plain_30": (main, True)}
        for ext in (".mp4", ".mov"):
            two, both = self.tmp / f"two_trak{ext}", self.tmp / f"aux2{ext}"
            self._ffmpeg("-i", str(main), "-i", str(thumb), "-map", "0", "-map", "1", "-c", "copy", str(two))
            self._ffmpeg("-i", str(main), "-i", str(aux), "-map", "0", "-map", "1", "-c", "copy", str(both))
            files[two.name], files[both.name] = (two, True), (both, False)
        real = shutil.which
        for name, (path, accepted) in files.items():
            with self.subTest(file=name):
                probed = video.read_frames(str(path))
                with mock.patch.object(video.shutil, "which",
                                       lambda n, *a, **k: None if n == "ffprobe" else real(n, *a, **k)):
                    boxed = video.read_frames(str(path))
                    err, calls = self._submit(path)
                self.assertEqual(err is None, accepted, err and err.message)
                if not accepted:
                    self.assertEqual(calls, [])
                self.assertEqual(boxed.refusal, probed.refusal)
                self.assertEqual(boxed.frames, probed.frames)
                if probed.seconds is not None:
                    self.assertAlmostEqual(boxed.seconds, probed.seconds, places=2)

    def test_br_l_211_a_real_shortened_header_reads_as_its_frames(self):
        short = self.tmp / "short.mp4"
        _shorten_headers(self.clip, short, 40)
        self.assertAlmostEqual(video.video_fps(str(self.clip)), 60.0, places=1)
        self.assertGreater(video.video_fps(str(short)), video.RunwayVideoUpscaleAdapter.MAX_FPS + 0.5)


if __name__ == "__main__":
    unittest.main()
