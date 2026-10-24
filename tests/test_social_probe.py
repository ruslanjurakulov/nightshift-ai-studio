"""modules/social_probe.py — the pre-upload look at the master: what is read from the file, every rule's branch
(including the boundaries), the refusal reaching the request row with a closed word and a plain sentence before
anything is staged, and the same rules on real tiny files made with ffmpeg."""

import json
import shutil
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path

from modules import social_probe as pr
from modules import social_publish as sp
from tests.test_social_publish import Base, FakeHTTP, FakeStore, FakeTokens, Resp

TT = sp.TT_API

FFMPEG_STDERR = """Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':
  Metadata:
    major_brand     : isom
  Duration: 00:00:01.00, start: 0.000000, bitrate: 149 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 320x240 [SAR 1:1 DAR 4:3], 57 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
      Metadata:
        handler_name    : VideoHandler
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 70 kb/s (default)
At least one output file must be specified
"""


def box(kind: bytes, payload: bytes = b"") -> bytes:
    return struct.pack(">I", 8 + len(payload)) + kind + payload


def fake_mp4(order=(b"ftyp", b"moov", b"mdat")) -> bytes:
    return b"".join(box(k, b"\0" * 24) for k in order)


def good(**over):
    base = dict(video_codec="h264", audio_codec="aac", has_audio=True, width=1080, height=1920, fps=30.0,
                faststart=True)
    base.update(over)
    return pr.MediaFacts(**base)


class Container(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def write(self, name, data):
        p = Path(self.tmp.name) / name
        p.write_bytes(data)
        return p

    def test_a_file_with_the_index_first_is_faststart(self):
        self.assertIs(pr.faststart(self.write("a.mp4", fake_mp4((b"ftyp", b"moov", b"mdat")))), True)

    def test_a_file_with_the_media_first_is_not(self):
        self.assertIs(pr.faststart(self.write("a.mp4", fake_mp4((b"ftyp", b"free", b"mdat", b"moov")))), False)

    def test_a_large_media_box_is_skipped_by_seeking_not_read(self):
        big = struct.pack(">I", 1) + b"mdat" + struct.pack(">Q", 16 + 5000) + b"\0" * 5000
        self.assertIs(pr.faststart(self.write("a.mp4", box(b"ftyp", b"\0" * 8) + box(b"free") + big)), False)

    def test_not_an_mp4_or_unreadable_is_none(self):
        self.assertIsNone(pr.faststart(self.write("junk.mp4", b"\0" * 2048)))
        self.assertIsNone(pr.faststart(self.write("short.mp4", b"abc")))
        self.assertIsNone(pr.faststart(Path(self.tmp.name) / "missing.mp4"))

    def test_a_file_with_neither_index_nor_media_box_is_none(self):
        self.assertIsNone(pr.faststart(self.write("a.mp4", fake_mp4((b"ftyp", b"free", b"free")))))


class Streams(unittest.TestCase):
    def test_ffprobe_json(self):
        doc = {"streams": [
            {"codec_type": "video", "codec_name": "H264", "width": 1080, "height": 1920,
             "avg_frame_rate": "30000/1001", "r_frame_rate": "30/1"},
            {"codec_type": "audio", "codec_name": "aac"}]}
        f = pr.parse_ffprobe(doc)
        self.assertEqual((f.video_codec, f.audio_codec, f.has_audio, f.width, f.height),
                         ("h264", "aac", True, 1080, 1920))
        self.assertAlmostEqual(f.fps, 29.97, places=2)

    def test_ffprobe_without_audio_says_so_and_falls_back_to_the_other_frame_rate(self):
        f = pr.parse_ffprobe({"streams": [{"codec_type": "video", "codec_name": "hevc", "width": 640, "height": 360,
                                           "avg_frame_rate": "0/0", "r_frame_rate": "25/1"}]})
        self.assertEqual((f.has_audio, f.audio_codec, f.fps), (False, None, 25.0))

    def test_a_cover_image_is_not_the_video_stream(self):
        f = pr.parse_ffprobe({"streams": [
            {"codec_type": "video", "codec_name": "mjpeg", "width": 9, "height": 9, "disposition": {"attached_pic": 1}},
            {"codec_type": "video", "codec_name": "h264", "width": 640, "height": 360, "avg_frame_rate": "30/1"}]})
        self.assertEqual(f.video_codec, "h264")

    def test_ffprobe_junk_is_unread_not_guessed(self):
        for doc in (None, [], {}, {"streams": "x"}, {"streams": [{"codec_type": "audio"}]}):
            self.assertEqual(pr.parse_ffprobe(doc), pr.MediaFacts(), doc)

    def test_ffmpeg_stderr(self):
        f = pr.parse_ffmpeg_info(FFMPEG_STDERR)
        self.assertEqual((f.video_codec, f.audio_codec, f.has_audio, f.width, f.height, f.fps),
                         ("h264", "aac", True, 320, 240, 30.0))

    def test_ffmpeg_stderr_hex_tag_is_not_a_size(self):
        f = pr.parse_ffmpeg_info("  Stream #0:0: Video: hevc (Main) (hvc1 / 0x31637668), yuv420p, 1080x1920, 25 tbr, 90k tbn")
        self.assertEqual((f.width, f.height, f.fps, f.has_audio), (1080, 1920, 25.0, False))

    def test_ffmpeg_stderr_with_no_video_is_unread(self):
        self.assertEqual(pr.parse_ffmpeg_info("Invalid data found when processing input"), pr.MediaFacts())

    def test_read_facts_uses_ffprobe_when_given_and_adds_the_container_fact(self):
        out = json.dumps({"streams": [{"codec_type": "video", "codec_name": "h264", "width": 1080, "height": 1920,
                                       "avg_frame_rate": "30/1"}]})
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "a.mp4"
            f.write_bytes(fake_mp4())
            calls = []

            def run(cmd, **kw):
                calls.append(cmd)
                return subprocess.CompletedProcess(cmd, 0, out, "")

            facts = pr.read_facts(f, run=run, ffprobe="/x/ffprobe", ffmpeg="/x/ffmpeg")
        self.assertEqual(calls[0][0], "/x/ffprobe")
        self.assertEqual((facts.video_codec, facts.faststart), ("h264", True))

    def test_read_facts_falls_back_to_ffmpeg_and_survives_a_crash(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "a.mp4"
            f.write_bytes(fake_mp4())

            def run(cmd, **kw):
                return subprocess.CompletedProcess(cmd, 1, "", FFMPEG_STDERR)

            facts = pr.read_facts(f, run=run, ffprobe="", ffmpeg="/x/ffmpeg")
            self.assertEqual((facts.video_codec, facts.width), ("h264", 320))

            def boom(cmd, **kw):
                raise OSError("no such file")

            facts = pr.read_facts(f, run=boom, ffprobe="/x/ffprobe", ffmpeg="/x/ffmpeg")
            self.assertEqual((facts.video_codec, facts.faststart), (None, True))

    def test_read_facts_with_neither_tool_reads_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "a.mp4"
            f.write_bytes(fake_mp4())

            def never(cmd, **kw):
                raise AssertionError("no tool, no call")

            facts = pr.read_facts(f, run=never, ffprobe="", ffmpeg="")
        self.assertIsNone(facts.video_codec)


class Rules(unittest.TestCase):
    def refuses(self, platform, facts, word):
        with self.assertRaises(pr.ProbeRefusal) as e:
            pr.check_media(platform, facts)
        self.assertEqual(e.exception.reason, word)
        self.assertGreater(len(e.exception.detail), 15)  # a sentence, not a code
        return e.exception.detail

    def test_a_good_file_passes_both(self):
        pr.check_media("instagram", good())
        pr.check_media("tiktok", good())

    def test_the_reason_words_are_closed_lowercase_words(self):
        for w in pr.REASONS:
            self.assertRegex(w, r"^[a-z0-9_]{1,64}$")

    def test_instagram_takes_h264_and_hevc_only(self):
        pr.check_media("instagram", good(video_codec="hevc"))
        for codec in ("vp9", "av1", "mpeg4", "prores"):
            self.refuses("instagram", good(video_codec=codec), pr.REASON_CODEC)

    def test_tiktok_also_takes_vp8_and_vp9_as_its_page_says(self):
        for codec in ("h264", "hevc", "vp8", "vp9"):
            pr.check_media("tiktok", good(video_codec=codec))
        self.refuses("tiktok", good(video_codec="av1"), pr.REASON_CODEC)

    def test_instagram_audio_must_be_aac_when_there_is_audio(self):
        self.refuses("instagram", good(audio_codec="mp3"), pr.REASON_AUDIO)
        self.refuses("instagram", good(audio_codec=None), pr.REASON_AUDIO)
        pr.check_media("instagram", good(has_audio=False, audio_codec=None))  # a silent Reel is allowed

    def test_tiktok_audio_is_not_refused_because_its_page_names_no_codec(self):
        pr.check_media("tiktok", good(audio_codec="mp3"))

    def test_frame_rate_23_to_60_on_both(self):
        for platform in ("instagram", "tiktok"):
            for fps in (23.0, 23.976, 29.97, 60.0):
                pr.check_media(platform, good(fps=fps))
            for fps in (22.9, 15.0, 60.1, 120.0):
                self.refuses(platform, good(fps=fps), pr.REASON_FPS)

    def test_instagram_width_at_most_1920(self):
        pr.check_media("instagram", good(width=1920, height=1080))
        self.refuses("instagram", good(width=1921, height=1080), pr.REASON_TOO_WIDE)
        self.refuses("instagram", good(width=3840, height=2160), pr.REASON_TOO_WIDE)

    def test_tiktok_both_sides_360_to_4096(self):
        pr.check_media("tiktok", good(width=360, height=360))
        pr.check_media("tiktok", good(width=4096, height=2160))
        for w, h in ((359, 640), (640, 359), (320, 240), (4097, 2160), (2160, 4097)):
            self.refuses("tiktok", good(width=w, height=h), pr.REASON_RESOLUTION)

    def test_tiktok_may_be_wider_than_1920_but_instagram_may_not(self):
        pr.check_media("tiktok", good(width=3840, height=2160))

    def test_instagram_needs_the_index_first_tiktok_does_not(self):
        detail = self.refuses("instagram", good(faststart=False), pr.REASON_FASTSTART)
        self.assertIn("index", detail)
        pr.check_media("tiktok", good(faststart=False))

    def test_a_file_that_could_not_be_read_is_refused_not_guessed(self):
        for platform in ("instagram", "tiktok"):
            for facts in (pr.MediaFacts(), good(video_codec=None), good(width=None), good(height=None),
                          good(fps=None)):
                self.refuses(platform, facts, pr.REASON_UNREADABLE)
        self.refuses("instagram", good(faststart=None), pr.REASON_UNREADABLE)

    def test_the_first_failing_rule_names_itself(self):
        self.refuses("instagram", good(video_codec="av1", fps=10.0), pr.REASON_CODEC)


class ReasonWordsReachThePanel(unittest.TestCase):
    """Every reason word this PR adds is in the dashboard's closed list (command-center/lib/publish.ts), which has
    a sentence for it in en / ru / uz (command-center/tests/publish-panel-guards.test.tsx pins those)."""

    TS = (Path(__file__).resolve().parent.parent / "command-center" / "lib" / "publish.ts").read_text(encoding="utf-8")

    def test_new_words_are_listed(self):
        for word in (*pr.REASONS, sp.TT_UNAUDITED_REASON):
            self.assertIn(f'  "{word}",', self.TS, word)


class InTheWorker(Base):
    def run_one(self, platform, facts, **kw):
        http = FakeHTTP({
            ("POST", f"{TT}/creator_info/query/"): [Resp(200, {
                "data": {"privacy_level_options": ["SELF_ONLY"], "max_video_post_duration_sec": 600},
                "error": {"code": "ok"}})],
            ("POST", f"{TT}/video/init/"): [Resp(500, {"error": {"code": "stop_here"}})],
            ("POST", f"{sp.IG_GRAPH}/17841400000/media"): [Resp(500, {"error": {"code": 1}})],
        })
        store = FakeStore(video=self.video, http=http)
        out = self.run_req(store, FakeTokens(platform), platform=platform, http=http, facts=facts, **kw)
        return out, store, http

    def test_instagram_refuses_a_file_with_the_index_last_before_anything_is_staged(self):
        out, store, http = self.run_one("instagram", good(faststart=False))
        self.assertEqual((out, store.final["status"], store.final["reason"]), ("refused", "refused", "not_faststart"))
        self.assertEqual(store.staged, [])
        self.assertEqual(http.calls, [])
        self.assertIn("index", store.final["error"])

    def test_tiktok_refuses_a_too_small_picture_before_init(self):
        out, store, http = self.run_one("tiktok", good(width=320, height=240))
        self.assertEqual((out, store.final["reason"]), ("refused", "bad_resolution"))
        self.assertFalse(any(c[1].endswith("/video/init/") for c in http.calls))

    def test_each_word_reaches_the_row_as_a_refusal(self):
        cases = (("instagram", good(video_codec="av1"), "bad_codec"),
                 ("instagram", good(audio_codec="mp3"), "bad_audio"),
                 ("instagram", good(fps=12.0), "bad_framerate"),
                 ("instagram", good(width=2560, height=1440), "too_wide"),
                 ("instagram", pr.MediaFacts(), "unreadable_video"),
                 ("tiktok", good(fps=100.0), "bad_framerate"))
        for platform, facts, word in cases:
            out, store, _ = self.run_one(platform, facts)
            self.assertEqual((out, store.final["status"], store.final["reason"]), ("refused", "refused", word), word)

    def test_a_passing_file_goes_on_to_the_platform(self):
        _, store, http = self.run_one("tiktok", good(faststart=False))  # TikTok does not need the index first
        self.assertTrue(any(c[1].endswith("/video/init/") for c in http.calls))
        self.assertEqual(store.final["reason"], "platform_error")  # our scripted 500: it got past the probe

    def test_the_duration_and_size_checks_still_come_first(self):
        _, store, _ = self.run_one("instagram", good(faststart=False), info=sp.VideoInfo(1200.0, 1080, 1920, 2048))
        self.assertEqual(store.final["reason"], "too_long")

    def test_the_probe_is_not_part_of_the_youtube_target_path(self):
        # A YouTube cross-post goes through the pipeline's own uploader; the platform file rules do not apply.
        # (The YouTube publisher's check step is empty; tests/test_publisher_transcripts.py records that a YouTube
        # request makes neither a probe nor a media read.)
        names = sp.YoutubePublisher.check.__code__.co_names
        self.assertNotIn("media_fn", names)
        self.assertNotIn("probe_fn", names)


def _ffmpeg_exe():
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


FFMPEG = _ffmpeg_exe()


@unittest.skipUnless(FFMPEG, "no ffmpeg available")
class RealFiles(unittest.TestCase):
    """Tiny files made with ffmpeg, read back through read_facts (ffprobe when installed, else ffmpeg -i)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def make(self, name, *, size="640x360", fps=30, faststart=True, acodec="aac", vcodec="libx264"):
        path = Path(self.tmp.name) / name
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
               f"testsrc=size={size}:rate={fps}", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "1",
               "-c:v", vcodec, "-pix_fmt", "yuv420p"]
        cmd += ["-c:a", acodec] if acodec else ["-an"]
        if faststart:
            cmd += ["-movflags", "+faststart"]
        cmd.append(str(path))
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if proc.returncode != 0 or not path.is_file():
            self.skipTest(f"this ffmpeg cannot make {name}: {proc.stderr.strip()[:120]}")
        return path

    def test_a_faststart_h264_aac_file_passes_instagram_and_tiktok(self):
        f = pr.read_facts(self.make("good.mp4"))
        self.assertEqual((f.video_codec, f.audio_codec, f.width, f.height, f.faststart),
                         ("h264", "aac", 640, 360, True))
        self.assertAlmostEqual(f.fps, 30.0, places=1)
        pr.check_media("instagram", f)
        pr.check_media("tiktok", f)

    def test_a_file_with_the_index_last_fails_instagram_only(self):
        f = pr.read_facts(self.make("slow.mp4", faststart=False))
        self.assertIs(f.faststart, False)
        with self.assertRaises(pr.ProbeRefusal) as e:
            pr.check_media("instagram", f)
        self.assertEqual(e.exception.reason, "not_faststart")
        pr.check_media("tiktok", f)

    def test_a_low_frame_rate_fails_both(self):
        f = pr.read_facts(self.make("slideshow.mp4", fps=10))
        for platform in ("instagram", "tiktok"):
            with self.assertRaises(pr.ProbeRefusal) as e:
                pr.check_media(platform, f)
            self.assertEqual(e.exception.reason, "bad_framerate")

    def test_a_small_picture_fails_tiktok_only(self):
        f = pr.read_facts(self.make("small.mp4", size="320x240"))
        pr.check_media("instagram", f)
        with self.assertRaises(pr.ProbeRefusal) as e:
            pr.check_media("tiktok", f)
        self.assertEqual(e.exception.reason, "bad_resolution")

    def test_a_silent_video_passes_instagram(self):
        f = pr.read_facts(self.make("silent.mp4", acodec=None))
        self.assertIs(f.has_audio, False)
        pr.check_media("instagram", f)

    def test_non_aac_audio_fails_instagram(self):
        f = pr.read_facts(self.make("mp2.mp4", acodec="mp2"))
        with self.assertRaises(pr.ProbeRefusal) as e:
            pr.check_media("instagram", f)
        self.assertEqual(e.exception.reason, "bad_audio")

    def test_a_file_that_is_not_a_video_is_unreadable(self):
        junk = Path(self.tmp.name) / "junk.mp4"
        junk.write_bytes(b"\0" * 4096)
        with self.assertRaises(pr.ProbeRefusal) as e:
            pr.check_media("instagram", pr.read_facts(junk))
        self.assertEqual(e.exception.reason, "unreadable_video")


if __name__ == "__main__":
    unittest.main()
