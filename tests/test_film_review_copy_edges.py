"""Edges of the film's capped review copy (docs/studio/S4_GAPS.md G2), beyond tests/test_film_assembly.ReviewCopyCapTest.

What would break if these failed: a film just past the top clamp jumping to an uncapped H.264 level, a cap that is a
float and so refused by proxy_command after a paid render, a cap computed from the probe's slightly-off duration rather
than the cut that 0171 charges by, a crash-recovered master from before the cap refused or described as capped, a
variant that is silently missing without a log line, or a capped encode of a portrait or square film that loses its
480 short side or is tagged at a level some phones refuse."""

import shutil
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

from modules import film_assembly as fa
from modules import film_timeline as ft
from modules import media_library as ml
from tests import test_film_assembly as tfa
from tests import test_media_library as tml

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


class CapClampBoundaries(unittest.TestCase):
    # floor(45e6 x 8 / T / 1000) - 96 = floor(360000 / T) - 96; the top clamp lets go at T = 360000 / 2596 = 138.67 s.

    def test_the_top_clamp_holds_up_to_138_67_s_and_lets_go_just_after(self):
        self.assertEqual(fa.review_maxrate_kbps(3), 2500)        # a one-scene 3 s film
        self.assertEqual(fa.review_maxrate_kbps(138.0), 2500)
        self.assertEqual(fa.review_maxrate_kbps(138.67), 2500)
        self.assertEqual(fa.review_maxrate_kbps(138.7), 2499)    # no jump: just under the clamp, never above it
        self.assertEqual(fa.review_maxrate_kbps(139), 2493)

    def test_the_lengths_the_measurement_used(self):
        self.assertEqual(fa.review_maxrate_kbps(180), 1904)
        self.assertEqual(fa.review_maxrate_kbps(600), 504)
        self.assertEqual(fa.review_maxrate_kbps(ft.MAX_FILM_S), fa.review_maxrate_kbps(600))

    def test_the_floor_is_reached_only_past_1457_s(self):
        self.assertEqual(fa.review_maxrate_kbps(1457), 151)
        self.assertEqual(fa.review_maxrate_kbps(1458), fa.REVIEW_MIN_VIDEO_KBPS)
        self.assertEqual(fa.review_maxrate_kbps(1e9), fa.REVIEW_MIN_VIDEO_KBPS)

    def test_every_film_length_gives_a_whole_cap_proxy_command_accepts_and_longer_never_gets_more(self):
        # proxy_command refuses a float cap: a float here would fail every film after its render was paid for.
        prev = None
        steps = [i / 10 for i in range(1, int(ft.MAX_FILM_S * 10) + 1)]
        for secs in steps:
            cap = fa.review_maxrate_kbps(secs)
            self.assertIs(type(cap), int, secs)
            self.assertTrue(fa.REVIEW_MIN_VIDEO_KBPS <= cap <= fa.REVIEW_MAX_VIDEO_KBPS, secs)
            if prev is not None:
                self.assertLessEqual(cap, prev, secs)
            prev = cap
            # What the cap allows (sound and video at the cap, plus one VBV buffer) stays within the target and one
            # top-cap buffer (0.625 MB), so under the 50 MB ceiling with room for the mp4 boxes.
            allowed = ((cap + fa.REVIEW_AUDIO_KBPS) * secs + 2 * cap) * 1000 / 8
            self.assertLessEqual(allowed, fa.REVIEW_TARGET_BYTES + 2 * fa.REVIEW_MAX_VIDEO_KBPS * 1000 / 8, secs)
        for secs in (3, 138.7, 600):
            argv = ml.proxy_command("ffmpeg", Path("/m/o"), Path("/m/p.mp4"), "video/mp4", fa.review_maxrate_kbps(secs))
            self.assertIn(f"{fa.review_maxrate_kbps(secs)}k", argv)

    def test_a_length_that_is_not_a_number_is_refused(self):
        for bad in (None, "ten", [600]):
            with self.assertRaises((TypeError, ValueError), msg=repr(bad)):
                fa.review_maxrate_kbps(bad)
        self.assertEqual(fa.review_maxrate_kbps("600"), 504)   # a numeric string, as a row may carry it


class CapFollowsTheCut(tfa.Base):
    def test_the_cap_is_the_cuts_length_not_the_probes_slightly_different_one(self):
        # 60 x 10 s: the cut is 600 s (cap 504). The render probes at 600.1 s, inside the tolerance; computed from the
        # probe the cap would be 503. The cut is what 0171 charges by and what the review copy is of.
        f = self.film(scenes=60, seconds=10)
        db = f.db()
        self.assertEqual(fa.review_maxrate_kbps(600.1), 503)
        inner = tfa.fake_store_file(db, self.root, duration=600.1)
        calls = []

        def store_file(path, **kw):
            calls.append(kw)
            return inner(path, **kw)
        out = tfa.run(db, self.root, deps=self.fake_deps(db, length=600.1, store_file=store_file))
        self.assertTrue(out.ok, (out.reason, out.detail))
        (call,) = calls
        self.assertEqual(call["proxy_maxrate_kbps"], 504)
        self.assertEqual(db.asset_rows[out.asset_id]["provenance"]["review_copy"]["video_maxrate_kbps"], 504)

    def test_a_three_second_one_scene_film_gets_the_top_cap(self):
        f = self.film(scenes=1, seconds=3)
        db = f.db()
        inner = tfa.fake_store_file(db, self.root, duration=3.0)
        calls = []

        def store_file(path, **kw):
            calls.append(kw)
            return inner(path, **kw)
        out = tfa.run(db, self.root, deps=self.fake_deps(db, length=3.0, store_file=store_file))
        self.assertTrue(out.ok, (out.reason, out.detail))
        self.assertEqual(calls[0]["proxy_maxrate_kbps"], fa.REVIEW_MAX_VIDEO_KBPS)


class ReusedMasterFromBeforeTheCap(tfa.Base):
    """Crash recovery: an earlier attempt (from before G2) registered the master, then died before the record. The
    retry hands that file in instead of rendering again; its row has no review_copy provenance."""

    def earlier_master(self, proxy_bytes):
        f = self.film()
        first = f.db()
        out = tfa.run(first, self.root, deps=self.fake_deps(first))
        self.assertTrue(out.ok, (out.reason, out.detail))
        row = dict(first.asset_rows[out.asset_id])
        row["provenance"] = {k: v for k, v in row["provenance"].items() if k != "review_copy"}
        (ml.asset_dir(self.root, out.asset_id) / "proxy.mp4").write_bytes(b"\0" * proxy_bytes)
        db = f.db()
        db.asset_rows[out.asset_id] = row
        return db, out.asset_id

    def test_an_uncapped_master_within_50_mb_is_reused_without_a_render_and_charged_once(self):
        db, aid = self.earlier_master(fa.REVIEW_COPY_MAX_BYTES)   # exactly the ceiling: allowed
        with self.assertLogs("modules.film_assembly", "INFO") as logs:
            out = tfa.run(db, self.root, deps=self.fake_deps(db, store_file=self.fail_store))
        self.assertTrue(out.ok, (out.reason, out.detail))
        self.assertEqual(out.asset_id, aid)
        self.assertEqual(self.render_calls, [])
        self.assertEqual(db.records(), [("record", True, aid)])
        self.assertTrue(any("an earlier attempt's file, reused" in m for m in logs.output), logs.output)
        # The log never claims a cap for a copy it did not encode.
        self.assertFalse(any("capped at" in m for m in logs.output), logs.output)

    def test_an_uncapped_master_over_50_mb_fails_without_claiming_a_cap(self):
        db, _aid = self.earlier_master(fa.REVIEW_COPY_MAX_BYTES + 1)
        out = tfa.run(db, self.root, deps=self.fake_deps(db, store_file=self.fail_store))
        self.assertEqual((out.ok, out.reason), (False, "review_copy_too_large"), out.detail)
        self.assertEqual(self.render_calls, [])
        self.assertNotIn("cap", out.detail)
        self.assertIn("50.00 MB", out.detail)
        self.assertIn("report it", out.detail)
        for wrong in ("shorten", "retry"):
            self.assertNotIn(wrong, out.detail)
        self.assertEqual(db.seg["assembly"]["charged_credits"], 0.0)

    def fail_store(self, path, **kw):
        raise AssertionError("a reused master must not be stored again")


class VariantFailureIsLogged(unittest.TestCase):
    """_variant_failed: a film's review copy that is missing must say why in the worker's log."""

    def store(self, proxy):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        src = tmp / "film.mp4"
        src.write_bytes(tml.MP4)
        store = tml.FakeStore()

        def runner(argv, beat, **_k):
            if argv[-1].endswith("proxy.mp4"):
                return proxy(Path(argv[-1]))
            Path(argv[-1]).write_bytes(b"\xff\xd8\xff" + b"\0" * 10)
            return 0
        ml.store_generated(src, asset_id=str(uuid.uuid4()), org_id="org", store=store, media_root=tmp / "media",
                           tools=ml.Tools("ffprobe", "ffmpeg"), provenance={}, proxy_maxrate_kbps=504, runner=runner,
                           prober=lambda *a: ml.Probe("video", "video/mp4", 1920, 1080, 600.0))
        return store.registered[0]

    def test_a_refused_encode_is_named_as_the_cap(self):
        with self.assertLogs("modules.media_library", "WARNING") as logs:
            row = self.store(lambda p: ml.REFUSED_EXIT)
        self.assertNotIn("proxy", row["variants"])
        self.assertTrue(any("no proxy for" in m and "refused (frame or memory cap)" in m for m in logs.output),
                        logs.output)

    def test_an_empty_file_with_exit_zero_is_named_as_empty(self):
        def empty(p):
            p.write_bytes(b"")
            return 0
        with self.assertLogs("modules.media_library", "WARNING") as logs:
            row = self.store(empty)
        self.assertNotIn("proxy", row["variants"])
        self.assertTrue(any("no proxy for" in m and "an empty or missing file" in m for m in logs.output),
                        logs.output)

    def test_a_proxy_that_was_made_logs_no_warning(self):
        def ok(p):
            p.write_bytes(b"\0" * 10)
            return 0
        with self.assertNoLogs("modules.media_library", "WARNING"):
            row = self.store(ok)
        self.assertIn("proxy", row["variants"])
        self.assertIn("thumb", row["variants"])


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg is not installed")
class RealCappedEncodePortraitAndSquare(unittest.TestCase):
    """The capped proxy of a 1080p 9:16 and 1:1 film: 480 on the short side, High profile, level at most 3.1."""

    def encode(self, w, h, cap, secs=4):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        src = tmp / "src.mp4"
        # Temporal noise over a moving pattern: detail enough that the cap, not crf, decides the rate.
        subprocess.run([shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                        f"testsrc2=s={w}x{h}:r=24:d={secs},noise=alls=60:allf=t+u", "-f", "lavfi", "-i",
                        f"sine=f=440:d={secs}", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
                        "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(src)], check=True, timeout=180)
        aid = str(uuid.uuid4())
        store = tml.FakeStore()
        ml.store_generated(src, asset_id=aid, org_id="org", store=store, media_root=tmp / "media",
                           tools=ml.find_tools(), provenance={}, proxy_maxrate_kbps=cap)
        self.assertIn("proxy", store.registered[0]["variants"])
        proxy = ml.asset_file(tmp / "media", aid, "proxy")
        got = subprocess.run([shutil.which("ffprobe"), "-v", "error", "-select_streams", "v:0", "-show_entries",
                              "stream=width,height,profile,level", "-of", "default=nw=0:nk=0", str(proxy)],
                             capture_output=True, text=True, check=True).stdout
        # Keyed, not positional: ffprobe prints the fields in its own order, not the one asked.
        v = dict(line.split("=", 1) for line in got.splitlines() if "=" in line)
        return int(v["width"]), int(v["height"]), v["profile"], int(v["level"]), proxy.stat().st_size, secs

    def assert_phone_safe(self, w, h, profile, level):
        self.assertEqual(min(w, h), 480, (w, h))
        self.assertEqual((w % 2, h % 2), (0, 0), (w, h))
        self.assertEqual(profile, "High")
        self.assertLessEqual(level, 31)

    def test_9x16_at_the_top_cap_and_at_the_ten_minute_cap(self):
        for cap in (fa.REVIEW_MAX_VIDEO_KBPS, fa.review_maxrate_kbps(600)):
            w, h, profile, level, size, secs = self.encode(1080, 1920, cap)
            self.assert_phone_safe(w, h, profile, level)
            self.assertEqual((w, h), (480, 854))
            self.assertLessEqual(size, ((cap + fa.REVIEW_AUDIO_KBPS) * secs + 2 * cap) * 1000 / 8, (cap, size))

    def test_1x1_at_the_top_cap_and_at_the_ten_minute_cap(self):
        for cap in (fa.REVIEW_MAX_VIDEO_KBPS, fa.review_maxrate_kbps(600)):
            w, h, profile, level, size, secs = self.encode(1080, 1080, cap)
            self.assert_phone_safe(w, h, profile, level)
            self.assertEqual((w, h), (480, 480))
            self.assertLessEqual(size, ((cap + fa.REVIEW_AUDIO_KBPS) * secs + 2 * cap) * 1000 / 8, (cap, size))


if __name__ == "__main__":
    unittest.main()
