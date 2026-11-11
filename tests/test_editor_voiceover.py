"""Voice-over recorded in the editor (the microphone, on the editor page only): the backend half.

A take is recorded by the browser's MediaRecorder and uploaded through the media library's ordinary path
(request_upload, the PUT, the worker's sniff + forced-demuxer probe, register_asset) as an AUDIO asset of the
person's organization. Nothing about it is special after that: it is a sound on an A track like any other.

What would break, by test:

* a recording written as a stream (MediaRecorder's WebM/Opus has no length in its header; measured with ffmpeg
  writing to a pipe, the same way) is refused as "the file has no length" — the voice-over could never be added;
  so the worker measures a sound-only file's length from its packets, and only then;
* the measurement must not widen anything: a VIDEO without a length is still refused (its decode budget is
  computed from that length), a file whose header has a length is not measured again, a measurement that finds
  no packet is still "no length", and a measurement that hangs is killed and the ticket refused, not waited on;
* the take's name carries no extension when it is WebM (the database maps `.webm` to VIDEO and would refuse an
  audio upload so named): the worker accepts the nameless sound and stores it as audio/webm;
* a recorded sound (WebM/Opus streamed, and WAV) on an A track validates in the Python twin of the document
  and renders through the real export path, at the place it was put, with its own pitch.
"""

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import media_library as ml
from modules import timeline as tl
from tests import test_editor_overlay as ovt
from tests.test_media_library import IngestCase

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
NEEDS_FFMPEG = unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe not installed")

BASE = ovt.BASE
VO = "77777777-7777-4777-8777-777777777777"


def streamed_webm(path: Path, seconds: float = 3.0, hz: int = 660, ffmpeg: str = "ffmpeg") -> bytes:
    """WebM/Opus written to a pipe: no length in the header and no cues, as a browser's recorder leaves it."""
    proc = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                           f"sine=frequency={hz}:sample_rate=48000:duration={seconds}", "-c:a", "libopus",
                           "-b:a", "64k", "-f", "webm", "pipe:1"], capture_output=True, check=True, timeout=120)
    path.write_bytes(proc.stdout)
    return proc.stdout


def probe_json(path: Path, demuxer: str) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-f", demuxer, "-print_format", "json", "-show_format",
                          "-show_streams", str(path)], capture_output=True, check=True, timeout=60).stdout
    return json.loads(out)


# ── the worker accepts a streamed recording, and nothing wider ───────────────


class StreamedRecordingIngestTestCase(IngestCase):
    @NEEDS_FFMPEG
    def test_the_premise_a_streamed_webm_has_no_length_in_its_header(self):
        path = self.tmp / "take.webm"
        streamed_webm(path)
        self.assertIsNone(probe_json(path, "matroska")["format"].get("duration"),
                          "if ffprobe now reports a length here, the measurement below is no longer needed")

    @NEEDS_FFMPEG
    def test_a_streamed_webm_take_without_an_extension_is_stored_as_audio_with_its_measured_length(self):
        data = streamed_webm(self.tmp / "take.webm", seconds=3.0)
        t = self.ticket(data, mime="audio/webm", name="Voice-over 2026-11-11 12-30-05")
        self.assertEqual(self.run_ticket(t), "ingested")
        reg = self.store.registered[-1]
        self.assertEqual((reg["kind"], reg["mime"], reg["variants"]), ("audio", "audio/webm", []))
        self.assertAlmostEqual(reg["duration_s"], 3.0, delta=0.05)

    @NEEDS_FFMPEG
    def test_a_streamed_webm_with_a_picture_and_no_length_is_still_refused(self):
        path = self.tmp / "v.webm"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                        "testsrc=size=160x90:rate=10:duration=2", "-c:v", "libvpx", "-f", "webm", "pipe:1"],
                       stdout=path.open("wb"), check=True, timeout=120)
        t = self.ticket(path.read_bytes(), mime="video/webm", name="v")
        self.assert_rejected(t, "not_media")

    @NEEDS_FFMPEG
    def test_a_file_whose_header_has_a_length_is_not_measured_again(self):
        path = self.tmp / "seek.webm"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                        "sine=duration=2", "-c:a", "libopus", str(path)], check=True, timeout=120)
        measured = mock.Mock(side_effect=AssertionError("must not be measured"))
        info = ml.run_probe("ffprobe", path, "video/webm", measurer=measured)
        self.assertEqual(info.kind, "audio")
        self.assertAlmostEqual(info.duration, 2.0, delta=0.05)
        measured.assert_not_called()

    def test_the_measurement_is_used_only_for_sound_without_a_length_in_a_streamed_container(self):
        sound = {"streams": [{"codec_type": "audio"}], "format": {}}
        self.assertTrue(ml.needs_measured_length("video/webm", sound))
        self.assertTrue(ml.needs_measured_length("audio/ogg", sound))
        self.assertFalse(ml.needs_measured_length("audio/wav", sound), "a WAV states its length")
        self.assertFalse(ml.needs_measured_length("audio/mpeg", sound))
        self.assertFalse(ml.needs_measured_length("video/webm", {"streams": [{"codec_type": "audio"}],
                                                                  "format": {"duration": "4.0"}}))
        self.assertFalse(ml.needs_measured_length("video/webm", {"streams": [{"codec_type": "video"},
                                                                             {"codec_type": "audio"}],
                                                                 "format": {}}))
        self.assertFalse(ml.needs_measured_length("video/webm", {"streams": [], "format": {}}))
        # cover art is not a picture: a sound with an attached picture is still a sound
        self.assertTrue(ml.needs_measured_length("audio/mp4", {"streams": [
            {"codec_type": "video", "disposition": {"attached_pic": 1}}, {"codec_type": "audio"}], "format": {}}))

    def test_a_measurement_that_finds_no_packet_is_still_no_length(self):
        data = {"streams": [{"codec_type": "audio"}], "format": {}}
        with self.assertRaises(ml.IngestReject) as e:
            ml.interpret_probe("video/webm", ml.with_measured_length(data, None))
        self.assertEqual(e.exception.reason, "not_media")
        got = ml.interpret_probe("video/webm", ml.with_measured_length(data, 12.3456))
        self.assertEqual((got.kind, got.mime, got.duration), ("audio", "audio/webm", 12.346))

    def test_the_packet_probe_forces_the_demuxer_and_reads_files_only(self):
        argv = ml.packet_command("ffprobe", Path("/s/x.upload"), "video/webm")
        self.assertEqual(argv[argv.index("-f") + 1], "matroska")
        self.assertEqual(argv[argv.index("-protocol_whitelist") + 1], "file")
        self.assertEqual(argv[-1], "/s/x.upload")

    def test_a_hung_measurement_is_killed_and_the_ticket_refused(self):
        script = self.tmp / "hang.sh"
        script.write_text("#!/bin/sh\nexec sleep 30\n")
        script.chmod(0o755)
        with self.assertRaises(ml.IngestReject) as e:
            ml.measure_audio_length(str(script), self.tmp / "x", "video/webm", timeout_s=0.5)
        self.assertEqual(e.exception.reason, "probe_failed")

    def test_no_packet_or_only_a_zero_length_one_measures_as_no_length(self):
        for out in ("", "N/A,N/A\\n", "0.000000,N/A\\n", "garbage\\n"):
            script = self.tmp / "empty.sh"
            script.write_text(f"#!/bin/sh\nprintf '{out}'\n")
            script.chmod(0o755)
            self.assertIsNone(ml.measure_audio_length(str(script), self.tmp / "x", "video/webm"), out)
        failing = self.tmp / "fail.sh"
        failing.write_text("#!/bin/sh\nprintf '1.0,0.02\\n'\nexit 1\n")
        failing.chmod(0o755)
        with self.assertRaises(ml.IngestReject) as e:
            ml.measure_audio_length(str(failing), self.tmp / "x", "video/webm")
        self.assertEqual(e.exception.reason, "not_media")

    def test_the_furthest_packet_end_is_the_length_and_junk_lines_are_skipped(self):
        script = self.tmp / "fake.sh"
        script.write_text("#!/bin/sh\nprintf '0.000000,0.020000\\nN/A,0.02\\n2.980000,0.020000\\n"
                          "-1,5\\ngarbage\\n1.000000,N/A\\n'\n")
        script.chmod(0o755)
        self.assertAlmostEqual(ml.measure_audio_length(str(script), self.tmp / "x", "video/webm"), 3.0, places=6)


# ── a recorded sound on an A track validates and renders ─────────────────────


def voice_doc(start_s=1.0, in_s=0.5, out_s=2.5, seconds=4.0):
    return {"version": 1, "width": 320, "height": 180, "fps": 30, "tracks": [
        {"id": "v1", "kind": "V", "clips": [{"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0,
                                             "out_s": seconds}]},
        {"id": "a1", "kind": "A", "role": "speech", "clips": [
            {"id": "m1", "asset_id": VO, "start_s": start_s, "in_s": in_s, "out_s": out_s, "gain_db": 0,
             "fade_in_s": 0, "fade_out_s": 0}]}]}


class RecordedVoiceDocumentTestCase(unittest.TestCase):
    def test_a_recorded_sound_on_an_a_track_validates(self):
        self.assertEqual(tl.validate(voice_doc()), [])

    def test_an_a_track_takes_audio_and_the_recording_is_audio(self):
        self.assertIn(tl.ASSET_AUDIO, tl.TRACK_ASSET_KINDS["A"])


class RecordedVoiceRenderTestCase(ovt._Real):
    def setUp(self):
        super().setUp()
        if not shutil.which("ffprobe"):
            self.skipTest("ffprobe not available")

    def levels(self, path, start, dur):
        proc = subprocess.run([self.ffmpeg, "-hide_banner", "-nostats", "-ss", str(start), "-t", str(dur), "-i",
                               str(path), "-vn", "-af", "volumedetect", "-f", "null", "-"],
                              capture_output=True, text=True)
        mean = re.search(r"mean_volume: (-?[\d.]+|-inf) dB", proc.stderr)
        return float("-inf") if mean is None or mean.group(1) == "-inf" else float(mean.group(1))

    def tone_hz(self, path, start, dur, rate=8000):
        raw = self.run_ffmpeg("-ss", str(start), "-t", str(dur), "-i", str(path), "-vn", "-f", "s16le", "-ac", "1",
                              "-ar", str(rate), "-")
        s = [int.from_bytes(raw[i:i + 2], "little", signed=True) for i in range(0, len(raw) - 1, 2)]
        return sum(1 for a, b in zip(s, s[1:]) if a <= 0 < b) / (len(s) / rate)

    def recorded(self, kind):
        if kind == "webm":
            path = self.dir / "original-webm"     # stored as `original`, no extension, as the worker keeps it
            streamed_webm(path, seconds=3.0, hz=660, ffmpeg=self.ffmpeg)
        else:
            path = self.dir / "original-wav"
            self.run_ffmpeg("-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=3", "-f", "wav",
                            str(path))
        return tl.ResolvedAsset(VO, "audio", str(path), 3.0)

    def test_a_recorded_take_plays_where_it_was_put_with_its_own_pitch(self):
        for kind in ("webm", "wav"):
            with self.subTest(kind):
                table = {BASE: self.base_video(size="320x180", seconds=4), VO: self.recorded(kind)}
                doc = voice_doc(start_s=1.0, in_s=0.5, out_s=2.5)
                self.assertEqual(tl.validate(doc), [])
                out = self.export(doc, table)
                info = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of",
                                                  "json", str(out)], capture_output=True, check=True).stdout)
                self.assertEqual([s["codec_type"] for s in info["streams"]].count("audio"), 1)
                self.assertAlmostEqual(float(info["format"]["duration"]), 4.0, delta=0.1)
                self.assertLess(self.levels(out, 0.1, 0.8), -60, "silence before the take starts")
                self.assertGreater(self.levels(out, 1.2, 1.6), -30, "the take after it starts")
                self.assertLess(self.levels(out, 3.2, 0.7), -60, "silence after the take's 2 s")
                self.assertAlmostEqual(self.tone_hz(out, 1.2, 1.6), 660, delta=30)


if __name__ == "__main__":
    unittest.main()
