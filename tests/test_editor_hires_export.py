"""1440p and 4K exports (migration 0132), the worker's half: modules/hires_export.py, modules/editor_export.py, the preset list.

What would break without these tests:

  * a paid frame rendered while NIGHTSHIFT_HIRES_EXPORT is off on the worker, or read as on by accident;
  * a paid frame rendered from a row that carries no quote (the database never writes one without it);
  * a paid export longer than its tier's cap rendered anyway (one 4K render holds the one export slot of EVERY organization);
  * a 4K export of a 60 fps project rendered (it ran out of memory, measured) or rendered at 30 in its place;
  * a paid export killed at the free exports' 3 x length + 120 s after the person paid, or a free export (or a project whose OWN
    frame is 4K, which another tool can save) given the paid budget for nothing;
  * a row the database already ended while handing it over (its credit hold was gone: credits_released) rendered for nothing;
  * the real ffmpeg not producing a file of exactly 2560x1440 / 3840x2160 (and the 9:16 twins) under the worker's limits;
  * the timeline validator crashing on malformed captions in its render-budget estimate (the small pre-existing fix of this change).

SQL does not run here: the database's half is tests/security/test_sec_editor_hires_export.py and tests/test_editor_hires_export_migration.py.
"""

from __future__ import annotations

import json
import math
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from modules import ass_captions, editor_export, export_presets, hires_export, render_backend
from modules import media_library as ml
from modules import timeline as tl

V1 = "11111111-1111-4111-8111-111111111111"
ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
EXPORT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
STORED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
PRESETS = export_presets.load()
PAID = ("youtube_1440p", "vertical_1440p", "youtube_2160p", "vertical_2160p")


def doc(length: float = 4.0, **top):
    d = {"version": 1, "width": 1920, "height": 1080, "fps": 30,
         "tracks": [{"id": "v1", "kind": "V", "clips": [{"id": "c1", "asset_id": V1, "start_s": 0, "in_s": 0.0, "out_s": length}]}]}
    d.update(top)
    return d


def framed(preset_id: str, d=None, *, quoted=12.5, **over):
    p = PRESETS[preset_id]
    r = {"id": EXPORT, "org_id": ORG, "project_id": PROJECT, "rev": 3, "duration_s": 4, "doc": d if d is not None else doc(),
         "status": "rendering", "frame_preset": p.id, "frame_width": p.width, "frame_height": p.height, "quoted_credits": quoted}
    r.update(over)
    return r


class FakeStore:
    def __init__(self):
        self.finished = []
        self.asked = 0

    def export_assets(self, export_id):
        self.asked += 1
        return [{"id": V1, "kind": "video", "mime": "video/mp4", "duration_s": 400, "variants": []}]

    def export_heartbeat(self, export_id, worker_id):
        return True

    def finish_export(self, export_id, worker_id, asset_id, reason):
        self.finished.append((asset_id, reason))
        return "done" if asset_id else "failed"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        f = ml.asset_file(self.root, V1, "original")
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(b"x")

    def tearDown(self):
        self.tmp.cleanup()

    def run_export(self, export, *, hires=True, frames=True):
        store = FakeStore()
        render = mock.Mock(side_effect=lambda d, res, out, **kw: Path(out).write_bytes(b"mp4") or out)
        store_file = mock.Mock(return_value={"id": STORED})
        status = editor_export.run_export(export, store=store, media_root=self.root, worker_id="w1",
                                          tools=ml.Tools("ffprobe", "ffmpeg"), render=render, store_file=store_file,
                                          has_audio=lambda path, mime: True, heartbeat_s=0.01, frames_enabled=frames,
                                          hires_enabled=hires)
        return status, store, render, store_file

    def assert_refused(self, export, reason, **kw):
        status, store, render, store_file = self.run_export(export, **kw)
        self.assertEqual((status, store.finished), ("failed", [(None, reason)]), export)
        render.assert_not_called()
        store_file.assert_not_called()
        self.assertEqual(store.asked, 0, "refused before the database is asked which files the export may read")


class TheTiers(unittest.TestCase):
    def test_a_frame_and_its_9_16_twin_are_one_tier_by_pixels(self):
        self.assertEqual([hires_export.tier(PRESETS[i].width, PRESETS[i].height) for i in PAID], ["1440p", "1440p", "2160p", "2160p"])
        for free in ("youtube_1080p", "youtube_720p", "vertical_1080p", "square_1080", "feed_4x5_1080"):
            self.assertIsNone(hires_export.tier(PRESETS[free].width, PRESETS[free].height), free)

    def test_the_boundaries_are_1080p_1440p_and_4k_pixels(self):
        self.assertIsNone(hires_export.tier(1920, 1080))
        self.assertEqual(hires_export.tier(1920, 1082), "1440p")       # one row past 1080p is paid
        self.assertEqual(hires_export.tier(2560, 1440), "1440p")
        self.assertEqual(hires_export.tier(2560, 1442), "2160p")
        self.assertEqual(hires_export.tier(3840, 2160), "2160p")
        self.assertIsNone(hires_export.tier(3840, 2162))                # above 4K: never sold, no tier
        for bad in ((None, 1080), (1920.0, 1080), ("3840", "2160"), (True, 4000), (-3840, -2160), (0, 0)):
            self.assertIsNone(hires_export.tier(*bad), bad)

    def test_the_length_caps_are_300_and_180_seconds(self):
        self.assertEqual(hires_export.MAX_S, {"1440p": 300.0, "2160p": 180.0})
        self.assertIsNone(hires_export.length_problem(2560, 1440, 300))
        self.assertIn("300", hires_export.length_problem(2560, 1440, 300.001))
        self.assertIsNone(hires_export.length_problem(2160, 3840, 180))
        self.assertIn("180", hires_export.length_problem(2160, 3840, 180.5))
        self.assertIsNotNone(hires_export.length_problem(3840, 2160, math.nan))
        self.assertIsNotNone(hires_export.length_problem(3840, 2160, math.inf))
        self.assertIsNone(hires_export.length_problem(1920, 1080, 1800))   # free: the export's own 30 minutes only

    def test_every_paid_preset_advises_no_more_than_its_cap(self):
        for i in PAID:
            p = PRESETS[i]
            self.assertTrue(export_presets.is_paid(p))
            self.assertEqual(p.max_duration_s, hires_export.MAX_S[hires_export.tier(p.width, p.height)])
        self.assertEqual(list(export_presets.free(PRESETS)), ["youtube_1080p", "youtube_720p", "vertical_1080p", "square_1080",
                                                               "feed_4x5_1080"])


class TheBudget(unittest.TestCase):
    def test_a_paid_frame_gets_its_tiers_factor_and_the_cap(self):
        for (w, h), per in (((2560, 1440), hires_export.RENDER_TIMEOUT_PER_S["1440p"]),
                            ((2160, 3840), hires_export.RENDER_TIMEOUT_PER_S["2160p"])):
            self.assertEqual(hires_export.render_timeout_s(w, h, 60), per * 60 + 120)
            self.assertEqual(hires_export.render_timeout_s(w, h, 0), 120)
            self.assertEqual(hires_export.render_timeout_s(w, h, 10 ** 6), tl.RENDER_TIMEOUT_MAX_S)
        for bad in (math.nan, math.inf, -math.inf):
            self.assertEqual(hires_export.render_timeout_s(3840, 2160, bad), tl.RENDER_TIMEOUT_MAX_S, bad)
        self.assertEqual(hires_export.render_timeout_s(3840, 2160, "garbage"), 120)

    def test_a_free_frame_keeps_the_free_exports_budget(self):
        for length in (0, 10, 300, 1800):
            self.assertEqual(hires_export.render_timeout_s(1920, 1080, length), editor_export.render_timeout_s(length))
            self.assertEqual(hires_export.render_timeout_s(1920, 1080, length), tl.render_timeout_s(length))

    def test_the_paid_budget_covers_the_dearest_measurement_of_its_tier_at_its_longest(self):
        # docs/HIRES_EXPORT.md "Measurements": the dearest render s per output s of each tier on the 4-core box (phone-like 60 fps
        # noisy source, the large-frame rules, the worker's limits). The budget at the tier's cap must cover it.
        dearest = {"1440p": 5.34, "2160p": 9.82}
        for t, measured in dearest.items():
            cap = hires_export.MAX_S[t]
            self.assertGreaterEqual(hires_export.RENDER_TIMEOUT_PER_S[t] * cap + hires_export.RENDER_TIMEOUT_BASE_S, measured * cap * 1.2, t)
            # ... and is more than the free exports would have given (else the change would be for nothing).
            self.assertGreater(hires_export.RENDER_TIMEOUT_PER_S[t], tl.RENDER_TIMEOUT_PER_S, t)


class TheSwitchAndTheRow(Base):
    def test_a_paid_frame_is_refused_while_the_switch_is_off_before_anything_is_read(self):
        for i in PAID:
            self.assert_refused(framed(i), "hires_off", hires=False)

    def test_the_multi_ratio_switch_is_still_the_first_gate(self):
        self.assert_refused(framed("youtube_2160p"), "frame_off", hires=True, frames=False)

    def test_a_paid_frame_without_its_quote_is_not_the_databases_row(self):
        self.assert_refused(framed("youtube_1440p", quoted=None), "invalid_frame")
        row = framed("youtube_1440p")
        del row["quoted_credits"]
        self.assert_refused(row, "invalid_frame")

    def test_a_free_frame_needs_no_quote_and_no_hires_switch(self):
        r = framed("vertical_1080p", quoted=None)
        status, store, render, _ = self.run_export(r, hires=False)
        self.assertEqual((status, store.finished), ("done", [(STORED, None)]))

    def test_the_switch_reads_the_same_words_as_the_other_switches(self):
        for on in ("on", "1", "true", "yes", " ON ", "True"):
            self.assertTrue(hires_export.enabled({"NIGHTSHIFT_HIRES_EXPORT": on}), on)
        for off in ("", "off", "0", "false", "no", "enabled", "onn", None):
            self.assertFalse(hires_export.enabled({"NIGHTSHIFT_HIRES_EXPORT": off}), off)
        self.assertFalse(hires_export.enabled({}))
        self.assertEqual(hires_export.FLAG, "NIGHTSHIFT_HIRES_EXPORT")

    def test_the_service_reads_its_switch_from_the_environment_and_hands_it_to_every_export(self):
        def service(**kw):
            return editor_export.ExportService(mock.Mock(), media_root=self.root, worker_id="w", tools=ml.Tools("a", "b"), **kw)
        with mock.patch.dict("os.environ", {"NIGHTSHIFT_HIRES_EXPORT": "on"}):
            self.assertTrue(service().hires_enabled)
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertFalse(service().hires_enabled)
        for enabled in (False, True):
            svc = service(hires_enabled=enabled)
            svc.store.claim_export.return_value = framed("youtube_2160p")
            with mock.patch.object(editor_export, "run_export") as run:
                self.assertTrue(svc.run_once())
            self.assertIs(run.call_args.kwargs["hires_enabled"], enabled)

    def test_run_export_is_off_by_default(self):
        store = FakeStore()
        render = mock.Mock()
        status = editor_export.run_export(framed("youtube_2160p"), store=store, media_root=self.root, worker_id="w1",
                                          tools=ml.Tools("ffprobe", "ffmpeg"), render=render, heartbeat_s=0.01, frames_enabled=True)
        self.assertEqual((status, store.finished), ("failed", [(None, "hires_off")]))
        render.assert_not_called()

    def test_a_row_the_database_already_ended_is_neither_rendered_nor_finished(self):
        # 0132's trigger fails a paid export whose hold is gone at the moment it is claimed; the claim still hands the row over.
        for status in ("failed", "done", "queued"):
            store = FakeStore()
            render = mock.Mock()
            out = editor_export.run_export(framed("youtube_2160p", status=status, reason="credits_released"), store=store,
                                           media_root=self.root, worker_id="w1", tools=ml.Tools("ffprobe", "ffmpeg"), render=render,
                                           heartbeat_s=0.01, frames_enabled=True, hires_enabled=True)
            self.assertEqual(out, status)
            self.assertEqual((store.finished, store.asked), ([], 0))
            render.assert_not_called()
            self.assertFalse((self.root / editor_export.WORK_DIRNAME).exists())

    def test_the_new_reason_words_are_known(self):
        for word in ("hires_off", "credits_released", "hires_fps"):
            self.assertIn(word, editor_export.REASONS)
            self.assertEqual(editor_export.ExportFailed(word).reason, word)


class TheCapAndTheBudgetOnTheWorker(Base):
    def test_a_paid_export_longer_than_its_tier_is_refused_before_the_render(self):
        for i, cap in (("youtube_1440p", 300), ("vertical_2160p", 180)):
            status, store, render, _ = self.run_export(framed(i, doc(cap + 0.5), duration_s=cap + 0.5))
            self.assertEqual((status, store.finished), ("failed", [(None, "too_long")]), i)
            render.assert_not_called()
            status, store, render, _ = self.run_export(framed(i, doc(float(cap)), duration_s=cap))
            self.assertEqual(status, "done", i)

    def test_the_render_gets_the_tiers_budget(self):
        for i in PAID:
            p = PRESETS[i]
            status, _, render, store_file = self.run_export(framed(i, doc(60.0), duration_s=60))
            self.assertEqual(status, "done", i)
            self.assertEqual(render.call_args.kwargs["timeout_s"], hires_export.render_timeout_s(p.width, p.height, 60.0), i)
            self.assertGreater(render.call_args.kwargs["timeout_s"], editor_export.render_timeout_s(60.0), i)
            norm = render.call_args.args[0]
            self.assertEqual((norm["width"], norm["height"]), (p.width, p.height))
            self.assertEqual(store_file.call_args.kwargs["provenance"]["frame"], i)

    def test_a_free_frame_and_a_projects_own_big_frame_keep_the_free_budget(self):
        _, _, render, _ = self.run_export(framed("youtube_1080p", doc(60.0), quoted=None, duration_s=60))
        self.assertEqual(render.call_args.kwargs["timeout_s"], editor_export.render_timeout_s(60.0))
        # A document whose OWN frame is 4K (no frame override, so nothing was paid): the free budget and no length cap.
        own = {k: v for k, v in framed("youtube_2160p", doc(200.0, width=3840, height=2160), duration_s=200).items()
               if k not in ("frame_preset", "frame_width", "frame_height", "quoted_credits")}
        status, _, render, _ = self.run_export(own)
        self.assertEqual(status, "done")
        self.assertEqual(render.call_args.kwargs["timeout_s"], editor_export.render_timeout_s(200.0))

    def test_4k_is_at_most_30_fps_and_is_never_rendered_at_a_lower_rate_in_its_place(self):
        self.assertEqual(hires_export.MAX_FPS, {"1440p": 60, "2160p": 30})
        for i in ("youtube_2160p", "vertical_2160p"):
            for fps in (50, 60):
                status, store, render, _ = self.run_export(framed(i, doc(4.0, fps=fps)))
                self.assertEqual((status, store.finished), ("failed", [(None, "hires_fps")]), (i, fps))
                render.assert_not_called()
            for fps in (24, 25, 30):
                status, _, render, _ = self.run_export(framed(i, doc(4.0, fps=fps)))
                self.assertEqual(status, "done", (i, fps))
                self.assertEqual(render.call_args.args[0]["fps"], fps)
        status, _, render, _ = self.run_export(framed("vertical_1440p", doc(4.0, fps=60)))
        self.assertEqual(status, "done")
        self.assertEqual(render.call_args.args[0]["fps"], 60)
        self.assertIsNone(hires_export.fps_problem(1920, 1080, 60))
        self.assertIsNotNone(hires_export.fps_problem(3840, 2160, math.nan))
        self.assertIsNotNone(hires_export.fps_problem(3840, 2160, True))
        self.assertIsNotNone(hires_export.fps_problem(3840, 2160, "30"))

    def test_a_paid_frame_is_judged_by_the_large_frame_rules(self):
        # A blur on a cross-faded clip is refused above 1440p (timeline.XFADE_LARGE_BLUR_MAX): the document is validated in the PAID frame.
        d = doc(4.0)
        d["tracks"][0]["clips"] = [
            {"id": "c1", "asset_id": V1, "start_s": 0, "in_s": 0.0, "out_s": 3.0},
            {"id": "c2", "asset_id": V1, "start_s": 2.5, "in_s": 3.0, "out_s": 6.0, "blur": 5,
             "transition": {"type": "crossfade", "duration_s": 0.5}}]
        self.assertEqual(tl.validate(d), [])
        status, store, render, _ = self.run_export(framed("youtube_2160p", d, duration_s=5.5))
        self.assertEqual((status, store.finished), ("failed", [(None, "invalid_timeline")]))
        render.assert_not_called()
        status, _, _, _ = self.run_export(framed("youtube_1440p", d, duration_s=5.5))
        self.assertEqual(status, "done")


class MalformedCaptionsDoNotCrashTheBudget(unittest.TestCase):
    """modules/timeline.py: the render-budget block reads the timeline's length (captions included) BEFORE the captions are
    validated. A malformed captions value used to raise TypeError / AttributeError out of validate() instead of a problem."""

    def base(self):
        # A fast clip, so the estimate (and with it duration_s) runs at all.
        return {"version": 1, "width": 1920, "height": 1080, "fps": 30,
                "tracks": [{"id": "v", "kind": "V", "clips": [{"id": "c1", "asset_id": V1, "start_s": 0, "in_s": 0, "out_s": 5,
                                                                "speed": 4}]}]}

    def test_each_malformed_shape_is_a_problem_not_an_exception(self):
        for captions in ("x", {"cues": "x"}, {"cues": [5]}, {"cues": [{}]}, {"cues": [{"id": "k", "start_s": None, "end_s": 1, "text": "a"}]},
                         {"cues": [{"id": "k", "start_s": "a", "end_s": 1, "text": "a"}]}, True, 7, ["x"], {"cues": [["a"]]}):
            d = self.base()
            d["captions"] = captions
            problems = tl.validate(d)
            self.assertTrue(problems and any("caption" in p for p in problems), (captions, problems))
            with self.assertRaises(tl.TimelineError):
                tl.load(d)

    def test_a_well_formed_document_is_still_estimated(self):
        d = self.base()
        d["captions"] = {"cues": [{"id": "k", "start_s": 0, "end_s": 1, "text": "a"}]}
        self.assertEqual(tl.validate(d), [])
        # Not vacuous: the estimate runs and refuses what is over the budget (a long 10x timeline, as section 12 says).
        long = self.base()
        long["tracks"][0]["clips"][0].update(out_s=1200, speed=10)
        long["captions"] = {"cues": [{"id": "k", "start_s": 0, "end_s": 1, "text": "a"}]}
        self.assertTrue(any("render" in p for p in tl.validate(long)))


def _bundled_ffmpeg():
    exe = render_backend.resolve_ffmpeg()
    path = exe if Path(exe).is_file() else shutil.which(exe)
    try:
        return path if path and shutil.which("ffprobe") and ass_captions.has_libass(path) else None
    except OSError:
        return None


FFMPEG = _bundled_ffmpeg()


@unittest.skipUnless(FFMPEG, "the bundled ffmpeg (render_backend.resolve_ffmpeg) or ffprobe is not available")
class ARealRenderAt1440pAnd4K(unittest.TestCase):
    """The whole worker path with the bundled ffmpeg, under the worker's limits (address space, threads, the budget): a small 16:9
    source, exported in each paid frame. The file is stored through the library's real ingest."""

    LENGTH = 0.5

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        src = ml.asset_file(cls.root, V1, "original")
        src.parent.mkdir(parents=True)
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=2",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mp4", str(src)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def probe(self, path: Path):
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                              "stream=width,height,nb_read_frames,r_frame_rate", "-of", "json", str(path)],
                             capture_output=True, text=True).stdout
        s = json.loads(out)["streams"][0]
        return s["width"], s["height"], int(s["nb_read_frames"]), s["r_frame_rate"]

    def export(self, preset_id: str, **kw):
        registered = []

        class Store(FakeStore):
            def register(self, **k):
                registered.append(k)
                return {"id": k["asset_id"], "storage_key": ml.storage_key(k["asset_id"])}

        d = {"version": 1, "width": 1920, "height": 1080, "fps": 30,
             "tracks": [{"id": "v1", "kind": "V", "clips": [{"id": "c1", "asset_id": V1, "start_s": 0, "in_s": 0.0, "out_s": self.LENGTH}]}]}
        store = Store()
        status = editor_export.run_export(framed(preset_id, d, duration_s=self.LENGTH), store=store, media_root=self.root, worker_id="w1",
                                          tools=ml.Tools("ffprobe", FFMPEG), frames_enabled=True, hires_enabled=True, **kw)
        return status, store, registered

    def test_each_paid_frame_is_a_file_of_exactly_its_size(self):
        for i in PAID:
            p = PRESETS[i]
            with self.subTest(i):
                status, store, registered = self.export(i)
                self.assertEqual(status, "done", store.finished)
                stored = ml.asset_file(self.root, registered[0]["asset_id"], "original")
                self.assertEqual(self.probe(stored), (p.width, p.height, 15, "30/1"))
                self.assertEqual((registered[0]["width"], registered[0]["height"]), (p.width, p.height))
                self.assertEqual(registered[0]["provenance"]["frame"], i)

    def test_the_tiers_budget_is_what_stops_the_real_ffmpeg(self):
        # A budget of a few milliseconds per second: the real render must be killed by IT (timed_out), and nothing stored.
        with mock.patch.dict(hires_export.RENDER_TIMEOUT_PER_S, {"2160p": 0.0}), \
                mock.patch.object(hires_export, "RENDER_TIMEOUT_BASE_S", 0.05):
            t0 = time.monotonic()
            status, store, registered = self.export("youtube_2160p")
        self.assertEqual((status, store.finished, registered), ("failed", [(None, "timed_out")], []))
        self.assertLess(time.monotonic() - t0, 30)
        self.assertFalse(any((self.root / editor_export.WORK_DIRNAME).glob("*")))


if __name__ == "__main__":
    unittest.main()
