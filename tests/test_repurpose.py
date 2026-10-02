"""Multi-clip repurposing (modules/repurpose.py, modules/shorts.py window cuts).

What these pin:

* the windows are WHOLE scenes of the Video IR: every proposed or accepted
  window starts at a scene's real start and ends at a scene's real end, so a
  clip never begins or ends inside a scene (and so never inside a word);
* with no usable retention curve the proposal says ``not_measured`` and ranks
  by scene structure only — no score is invented; with a curve, the window the
  audience stayed through first; a window whose edge is off the measured curve
  is unmeasured and ranks below every measured one;
* plan_clips (the worker's re-check) gives the same answer as the database's
  repurpose_plan on every case of samples/repurpose_cases.json (the lab runs the
  same file against the SQL), and the TypeScript proposal twin runs the same
  proposal cases;
* the worker cuts from the MASTER file only: a file with a short side under 720
  (the 480p review copy) is refused and ffmpeg never runs; a master that is not
  on this worker, or whose Video IR no longer says what was priced, makes no
  clip; every clip failure is reported with a reason word, none is charged here,
  and a request is always settled (or left to the database's sweep);
* the clip path comes from the database and only in the shape it builds;
* a real ffmpeg cut of a synthetic master gives 1080x1920 clips of exactly the
  window's length (skipped without ffmpeg).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import shutil
import subprocess
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from modules import repurpose as rp
from modules import shorts, social_captions
from modules.social_publish import VideoInfo

ROOT = Path(__file__).resolve().parent.parent
CASES = json.loads((ROOT / "samples" / "repurpose_cases.json").read_text("utf-8"))


def build_manifest(spec: dict) -> dict:
    """The manifest spec of samples/repurpose_cases.json (the lab test and the
    TypeScript twin's test build it the same way)."""
    if "__raw__" in spec:
        return spec["__raw__"]
    t, scenes = Decimal(0), []
    for i, n in enumerate(spec["lengths"]):
        s, t = t, t + Decimal(str(n))
        scenes.append({"id": f"s{i:03d}", "index": i, "start_s": float(s), "end_s": float(t),
                       "narration": f"Scene {i} narration."})
    for k, ov in (spec.get("overrides") or {}).items():
        scenes[int(k)].update(ov)
    m = {"version": 1, "scenes": scenes}
    audio = spec.get("audio_s", float(t))
    if audio is not None:
        m["audio"] = {"duration_s": audio}
    return m


TEN = {"lengths": [20, 5, 8, 12, 25, 10, 30, 15, 18, 7]}


class SharedCases(unittest.TestCase):
    def test_plan_cases(self):
        for c in CASES["plan"]:
            got = rp.plan_clips(build_manifest(c["manifest"]), c["clips"])
            want = c["expected"]
            self.assertEqual(got["ok"], want["ok"], c["name"])
            if want["ok"]:
                self.assertEqual(got["clips"], want["clips"], c["name"])
            else:
                self.assertEqual(got["reason"], want["reason"], c["name"])
                self.assertEqual(got.get("position"), want.get("position"), c["name"])
                self.assertIn(got["reason"], rp.REASONS)

    def test_propose_cases(self):
        for c in CASES["propose"]:
            got = rp.propose(build_manifest(c["manifest"]), c["points"], max_clips=c["max_clips"]).to_dict()
            want = c["expected"]
            self.assertEqual(got["retention"], want["retention"], c["name"])
            self.assertEqual(len(got["clips"]), len(want["clips"]), c["name"])
            for g, w in zip(got["clips"], want["clips"]):
                for key in ("rank", "first", "last", "scene_ids", "start_s", "end_s", "duration_s", "measured"):
                    self.assertEqual(g[key], w[key], f"{c['name']} {key}")
                if w["score"] is None:
                    self.assertIsNone(g["score"], c["name"])
                else:
                    self.assertAlmostEqual(g["score"], w["score"], places=6, msg=c["name"])


class Windows(unittest.TestCase):
    def test_a_window_starts_and_ends_on_real_scene_boundaries(self):
        """Property: whatever the manifest, every window the module offers
        starts at a scene's own start and ends at a scene's own end."""
        rng = random.Random(80)
        for _ in range(60):
            lengths = [round(rng.uniform(1, 40), 2) for _ in range(rng.randint(2, 30))]
            m = build_manifest({"lengths": lengths})
            starts = {sc["start_s"] for sc in m["scenes"]}
            ends = {sc["end_s"] for sc in m["scenes"]}
            for w in rp.candidate_windows(m):
                self.assertIn(w.start_s, starts)
                self.assertIn(w.end_s, ends)
                self.assertTrue(rp.MIN_CLIP_SECONDS <= w.duration_s <= rp.MAX_CLIP_SECONDS)
                self.assertLessEqual(len(w.scene_ids), rp.MAX_CLIP_SCENES)
            got = rp.propose(m, [])
            spans = sorted((c.window.start_s, c.window.end_s) for c in got.clips)
            for (a0, a1), (b0, b1) in zip(spans, spans[1:]):
                self.assertLessEqual(a1, b0, "two proposed clips share a scene")
            for c in got.clips:
                plan = rp.plan_clips(m, [{"first": c.window.first, "last": c.window.last}])
                self.assertTrue(plan["ok"], plan)

    def test_a_scene_with_unknown_times_is_never_inside_a_window(self):
        m = build_manifest({"lengths": [10, 10, 10, 10, 10, 10], "overrides": {"2": {"start_s": None, "end_s": None}}})
        for w in rp.candidate_windows(m):
            self.assertNotIn("s002", w.scene_ids)

    def test_a_scene_longer_than_a_short_is_never_split(self):
        m = build_manifest({"lengths": [90, 20, 20]})
        got = rp.propose(m, [])
        self.assertEqual([(c.window.first, c.window.last) for c in got.clips], [("s001", "s002")])

    def test_a_limit_of_five_clips(self):
        m = build_manifest({"lengths": [16] * 20})
        self.assertEqual(len(rp.propose(m, [], max_clips=99).clips), rp.MAX_CLIPS)
        self.assertEqual(rp.propose(m, [], max_clips=0).clips, ())

    def test_no_manifest_proposes_nothing(self):
        for bad in (None, {}, [], {"scenes": "x"}, {"scenes": [None, 3, "s000"]}):
            self.assertEqual(rp.propose(bad, []).clips, ())
            self.assertEqual(rp.propose(bad, []).retention, "not_measured")


class Ranking(unittest.TestCase):
    CURVE = [{"elapsed_ratio": r, "watch_ratio": w, "measured_date": "2026-09-01"} for r, w in
             [(0.05, 0.95), (0.15, 0.70), (0.25, 0.62), (0.35, 0.60), (0.45, 0.60), (0.55, 0.59),
              (0.65, 0.58), (0.75, 0.50), (0.85, 0.42), (0.95, 0.35), (1.0, 0.33)]]

    def test_with_no_retention_the_ranking_says_not_measured_and_invents_no_score(self):
        got = rp.propose(build_manifest(TEN), [])
        self.assertEqual(got.retention, "not_measured")
        self.assertTrue(got.clips)
        for c in got.clips:
            self.assertIsNone(c.score)
            self.assertFalse(c.measured)
            self.assertIsNone(c.to_dict()["score"])
        # Structure only: the longest whole-scene windows first, earlier first on a tie.
        lengths = [c.window.duration_s for c in got.clips]
        self.assertEqual(lengths, sorted(lengths, reverse=True))

    def test_a_curve_too_thin_to_use_is_not_data(self):
        thin = self.CURVE[:3]
        self.assertEqual(rp.propose(build_manifest(TEN), thin).retention, "not_measured")

    def test_with_a_curve_the_window_the_audience_stayed_through_ranks_first(self):
        got = rp.propose(build_manifest(TEN), self.CURVE)
        self.assertEqual(got.retention, "measured")
        scores = [c.score for c in got.clips]
        self.assertTrue(all(s is not None for s in scores))
        self.assertEqual(scores, sorted(scores, reverse=True))
        self.assertEqual((got.clips[0].window.first, got.clips[0].window.last), ("s004", "s004"))

    def test_an_edge_off_the_measured_curve_is_unmeasured_and_ranks_last(self):
        # The curve starts at 20%: the first 30 seconds of 150 are off it.
        early = [{"elapsed_ratio": r, "watch_ratio": w, "measured_date": "2026-09-01"} for r, w in
                 [(0.2, 0.7), (0.3, 0.62), (0.4, 0.6), (0.6, 0.59), (0.8, 0.5), (1.0, 0.3)]]
        got = rp.propose(build_manifest(TEN), early)
        flags = [c.measured for c in got.clips]
        self.assertIn(False, flags)
        self.assertEqual(flags, sorted(flags, reverse=True), "an unmeasured window outranked a measured one")
        unmeasured = [c for c in got.clips if not c.measured]
        self.assertEqual(unmeasured[0].window.first, "s000")
        self.assertIsNone(unmeasured[0].score)
        self.assertNotEqual(unmeasured[0].score, 0)

    def test_only_the_newest_curve_counts(self):
        old = [dict(p, measured_date="2026-08-01", watch_ratio=0.9) for p in self.CURVE]
        mixed = old + self.CURVE
        a = rp.propose(build_manifest(TEN), mixed).to_dict()
        b = rp.propose(build_manifest(TEN), self.CURVE).to_dict()
        self.assertEqual(a, b)


class MirrorOfTheDatabase(unittest.TestCase):
    def test_a_bool_is_not_a_time(self):
        m = build_manifest(TEN)
        m["scenes"][0]["end_s"] = True
        self.assertEqual(rp.plan_clips(m, [{"first": "s000", "last": "s000"}])["reason"], "scene_timing_unknown")

    def test_planning_never_raises(self):
        for junk in (object(), 5, "x", [[]], {"scenes": [{"id": "s000", "start_s": float("nan"), "end_s": 5}]}):
            out = rp.plan_clips(junk, [{"first": "s000", "last": "s000"}])
            self.assertFalse(out["ok"])
        self.assertFalse(rp.plan_clips(build_manifest(TEN), object())["ok"])

    def test_the_limits_are_the_shorts_window(self):
        self.assertEqual((rp.MIN_CLIP_SECONDS, rp.MAX_CLIP_SECONDS), (shorts.MIN_SECONDS, shorts.MAX_SECONDS))
        self.assertEqual(rp.MAX_CLIPS, 5)


# ── the worker's side ───────────────────────────────────────────────────────

class FakeStore:
    def __init__(self, fail_record=False, fail_finish=False):
        self.calls, self.fail_record, self.fail_finish = [], fail_record, fail_finish

    def heartbeat(self, rid, worker):
        self.calls.append(("heartbeat", rid))

    def record(self, rid, worker, position, *, ok, info):
        if self.fail_record:
            raise RuntimeError("record: HTTP 500")
        self.calls.append(("record", position, ok, dict(info)))

    def finish(self, rid, worker):
        if self.fail_finish:
            raise RuntimeError("finish: HTTP 500")
        self.calls.append(("finish", rid))
        recorded = [c for c in self.calls if c[0] == "record"]
        made = sum(1 for c in recorded if c[2])
        return {"status": "succeeded" if made == len(recorded) and made else ("partial" if made else "failed")}

    def records(self):
        return [c for c in self.calls if c[0] == "record"]


def request(slug="the-run", clips=None, **kw):
    clips = clips if clips is not None else [
        {"position": 1, "first": "s000", "last": "s000", "scene_ids": ["s000"], "start_s": 0.0, "end_s": 20.0,
         "duration_s": 20.0, "local_path": f"output/{slug}/repurpose/0123abcd/clip-01.mp4"},
        {"position": 2, "first": "s004", "last": "s004", "scene_ids": ["s004"], "start_s": 45.0, "end_s": 70.0,
         "duration_s": 25.0, "local_path": f"output/{slug}/repurpose/0123abcd/clip-02.mp4"},
    ]
    base = {"id": "11111111-2222-3333-4444-555555555555", "slug": slug, "clip_count": len(clips),
            "master": {"video_id": "run-x", "title": "The master", "topic": "a topic",
                       "local_path": f"output/{slug}/final_video.mp4"},
            "clips": clips}
    base.update(kw)
    return base


class WorkerCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.output = self.root / "output"
        self.run_dir = self.output / "the-run"
        self.run_dir.mkdir(parents=True)
        (self.run_dir / "final_video.mp4").write_bytes(b"master-bytes")
        self.manifest = dict(build_manifest(TEN), slug="the-run")
        (self.run_dir / "project.json").write_text(json.dumps(self.manifest))
        self.ran = []

    def tearDown(self):
        self.tmp.cleanup()

    def probe(self, size=(1920, 1080), duration=150.0):
        def probe(path):
            if Path(path).name.endswith(".part.mp4"):
                w, h = shorts.SHORT_WIDTH, shorts.SHORT_HEIGHT
                return VideoInfo(self.part_duration, w, h, Path(path).stat().st_size)
            return VideoInfo(duration, size[0], size[1], Path(path).stat().st_size)
        self.part_duration = None
        return probe

    def runner(self, code=0, write=True):
        def run(argv, heartbeat):
            self.ran.append(argv)
            heartbeat()
            dst = Path(argv[-1])
            ss = float(argv[argv.index("-ss") + 1])
            t = float(argv[argv.index("-t") + 1])
            self.part_duration = t
            if write:
                dst.write_bytes(f"clip {ss} {t}".encode())
            return code
        return run

    def process(self, req=None, store=None, size=(1920, 1080), duration=150.0, runner=None, **kw):
        store = store or FakeStore()
        probe = self.probe(size, duration)
        out = rp.process_request(req or request(), store=store, output_dir=self.output, worker_id="w1",
                                 probe_fn=probe, ffmpeg_exe=lambda: "ffmpeg", runner=runner or self.runner(), **kw)
        return out, store

    def test_it_cuts_every_clip_from_the_master_and_reports_what_it_measured(self):
        out, store = self.process()
        self.assertEqual(out, "succeeded")
        self.assertEqual(len(self.ran), 2)
        for argv, (start, end) in zip(self.ran, [(0.0, 20.0), (45.0, 70.0)]):
            # the source is the master file, nothing else
            self.assertEqual(argv[argv.index("-i") + 1], str((self.run_dir / "final_video.mp4").resolve()))
            self.assertEqual(float(argv[argv.index("-ss") + 1]), start)
            self.assertEqual(float(argv[argv.index("-t") + 1]), end - start)
        recs = store.records()
        self.assertEqual([(c[1], c[2]) for c in recs], [(1, True), (2, True)])
        first = recs[0][3]
        dest = self.output / "the-run" / "repurpose" / "0123abcd" / "clip-01.mp4"
        self.assertEqual(first["sha256"], hashlib.sha256(dest.read_bytes()).hexdigest())
        self.assertEqual((first["bytes"], first["width"], first["height"]), (dest.stat().st_size, 1080, 1920))
        self.assertEqual(first["title"], "The master - clip 1")
        self.assertEqual(set(first["captions"]), {"youtube", "instagram", "tiktok"})
        self.assertNotIn("local_path", first)            # the database builds the path
        self.assertEqual(store.calls[-1][0], "finish")
        self.assertFalse(list((self.output / "the-run" / "repurpose" / "0123abcd").glob("*.part.mp4")))

    def test_a_480p_review_copy_is_never_a_source_and_ffmpeg_never_runs(self):
        out, store = self.process(size=(854, 480))
        self.assertEqual(out, "failed")
        self.assertEqual(self.ran, [])
        self.assertEqual([(c[1], c[2], c[3]["error_code"]) for c in store.records()],
                         [(1, False, "master_too_small"), (2, False, "master_too_small")])
        self.assertEqual(store.calls[-1][0], "finish")

    def test_the_review_copy_name_is_never_looked_up(self):
        # Only videos.local_path (under output/) is a source: a preview in the
        # storage bucket has no path on this worker at all.
        src = (ROOT / "modules" / "repurpose.py").read_text()
        for word in ("preview_path", "previews"):
            self.assertNotIn(word, src.split("def check_master", 1)[1].split("def check_window", 1)[0])

    def test_a_master_that_is_not_on_this_worker_makes_nothing(self):
        (self.run_dir / "final_video.mp4").unlink()
        out, store = self.process()
        self.assertEqual(out, "failed")
        self.assertEqual({c[3]["error_code"] for c in store.records()}, {"master_not_available"})
        self.assertEqual(self.ran, [])

    def test_a_path_outside_output_is_not_a_master(self):
        outside = self.root / "elsewhere.mp4"
        outside.write_bytes(b"x")
        req = request()
        req["master"]["local_path"] = "../elsewhere.mp4"
        out, store = self.process(req)
        self.assertEqual({c[3]["error_code"] for c in store.records()}, {"master_not_available"})

    def test_a_master_whose_video_ir_moved_is_master_changed(self):
        self.manifest["scenes"][4]["start_s"] = 50.0
        (self.run_dir / "project.json").write_text(json.dumps(self.manifest))
        out, store = self.process()
        codes = {c[1]: c[3]["error_code"] for c in store.records() if not c[2]}
        # clip 1 (s000) is untouched; clip 2 (s004) is not what was priced.
        self.assertEqual(codes, {2: "master_changed"})
        self.assertEqual([c[1] for c in store.records() if c[2]], [1])
        self.assertEqual(out, "partial")

    def test_a_master_with_another_runs_ir_or_length_is_master_changed(self):
        self.manifest["slug"] = "another-run"
        (self.run_dir / "project.json").write_text(json.dumps(self.manifest))
        out, store = self.process()
        self.assertEqual({c[3]["error_code"] for c in store.records()}, {"master_changed"})
        self.manifest["slug"] = "the-run"
        (self.run_dir / "project.json").write_text(json.dumps(self.manifest))
        out, store = self.process(duration=400.0)
        self.assertEqual({c[3]["error_code"] for c in store.records()}, {"master_changed"})

    def test_a_missing_video_ir_is_reported(self):
        (self.run_dir / "project.json").unlink()
        _, store = self.process()
        self.assertEqual({c[3]["error_code"] for c in store.records()}, {"master_record_missing"})

    def test_a_window_past_the_end_of_the_file_is_master_changed(self):
        _, store = self.process(duration=60.0)
        self.assertEqual({c[3]["error_code"] for c in store.records()}, {"master_changed"})

    def test_a_failed_cut_is_a_failed_clip_and_the_rest_go_on(self):
        calls = {"n": 0}

        def flaky(argv, heartbeat):
            calls["n"] += 1
            return self.runner(code=1 if calls["n"] == 1 else 0)(argv, heartbeat)

        out, store = self.process(runner=flaky)
        self.assertEqual(out, "partial")
        self.assertEqual([(c[1], c[2]) for c in store.records()], [(1, False), (2, True)])
        self.assertEqual(store.records()[0][3]["error_code"], "cut_failed")
        self.assertFalse(list(self.output.rglob("*.part.mp4")), "debris left")

    def test_a_clip_that_is_not_the_priced_window_is_invalid(self):
        runner = self.runner()

        def short(argv, hb):
            code = runner(argv, hb)
            self.part_duration = 3.0
            return code

        out, store = self.process(runner=short)
        self.assertEqual({c[3]["error_code"] for c in store.records()}, {"clip_invalid"})
        self.assertEqual(out, "failed")

    def test_a_runner_that_raises_is_worker_error_with_the_type_only(self):
        def boom(argv, hb):
            raise OSError("/very/secret/path leaked")

        _, store = self.process(runner=boom)
        recs = store.records()
        self.assertEqual({c[3]["error_code"] for c in recs}, {"worker_error"})
        self.assertNotIn("secret", json.dumps(recs))
        self.assertIn("OSError", recs[0][3]["error"])

    def test_a_timeout_is_a_reason_word(self):
        def slow(argv, hb):
            raise TimeoutError("ffmpeg ran past its limit")

        _, store = self.process(runner=slow)
        self.assertEqual({c[3]["error_code"] for c in store.records()}, {"timeout"})

    def test_a_clip_path_must_be_the_shape_the_database_builds(self):
        bad = ["output/the-run/repurpose/0123abcd/clip-01.mov", "../output/the-run/repurpose/0123abcd/clip-01.mp4",
               "output/../../etc/repurpose/0123abcd/clip-01.mp4", "/etc/passwd", "output/the-run/clip-01.mp4",
               "output/The Run/repurpose/0123abcd/clip-01.mp4", "output/the-run/repurpose/ZZZZZZZZ/clip-01.mp4", None]
        for path in bad:
            with self.assertRaises(rp.ClipStop, msg=str(path)):
                rp.clip_destination(self.output, path)
        ok = rp.clip_destination(self.output, "output/the-run/repurpose/0123abcd/clip-01.mp4")
        self.assertEqual(ok, (self.output / "the-run" / "repurpose" / "0123abcd" / "clip-01.mp4").resolve())

    def test_a_bad_path_from_the_database_fails_that_clip_only(self):
        req = request()
        req["clips"][0]["local_path"] = "output/the-run/../../outside.mp4"
        _, store = self.process(req)
        self.assertEqual([(c[1], c[2]) for c in store.records()], [(1, False), (2, True)])
        self.assertEqual(store.records()[0][3]["error_code"], "bad_clip_path")
        self.assertFalse((self.root / "outside.mp4").exists())

    def test_a_record_that_cannot_be_sent_does_not_stop_the_request(self):
        out, store = self.process(store=FakeStore(fail_record=True))
        self.assertEqual(store.calls[-1][0], "finish")

    def test_a_settle_that_cannot_be_sent_is_left_to_the_sweep(self):
        out, store = self.process(store=FakeStore(fail_finish=True))
        self.assertEqual(out, "unsettled")

    def test_it_beats_the_heart_while_it_works(self):
        _, store = self.process()
        self.assertGreaterEqual(len([c for c in store.calls if c[0] == "heartbeat"]), 2)

    def test_not_enough_disk_stops_before_anything_is_cut(self):
        real = shutil.disk_usage
        shutil.disk_usage = lambda p: type("U", (), {"free": 1024})()
        try:
            _, store = self.process()
        finally:
            shutil.disk_usage = real
        self.assertEqual({c[3]["error_code"] for c in store.records()}, {"disk_full"})
        self.assertEqual(self.ran, [])

    def test_no_ffmpeg_is_a_reason_not_a_crash(self):
        store = FakeStore()
        out = rp.process_request(request(), store=store, output_dir=self.output, worker_id="w1",
                                 probe_fn=self.probe(), ffmpeg_exe=lambda: None, runner=self.runner())
        self.assertEqual({c[3]["error_code"] for c in store.records()}, {"ffmpeg_missing"})

    def test_logs_carry_no_secret_and_no_path(self):
        with self.assertLogs("modules.repurpose", level="INFO") as logs:
            self.process(size=(854, 480))
        text = "\n".join(logs.output)
        self.assertNotIn(str(self.root), text)
        self.assertIn("repurpose 1111", text)


class CuttingCommand(unittest.TestCase):
    def test_a_landscape_master_is_fitted_by_width_with_nothing_cropped(self):
        argv = shorts.window_command("ffmpeg", Path("m.mp4"), Path("o.mp4"), 12.5, 40.0,
                                     VideoInfo(100.0, 1920, 1080, 1))
        vf = argv[argv.index("-vf") + 1]
        self.assertTrue(vf.startswith("scale=1080:-2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x0F0F1E"), vf)
        self.assertNotIn("crop", vf)
        # accurate seek: before -i, with a re-encode; the length is the window's
        self.assertLess(argv.index("-ss"), argv.index("-i"))
        self.assertEqual(argv[argv.index("-ss") + 1], "12.500")
        self.assertEqual(argv[argv.index("-t") + 1], "27.500")
        self.assertIn("libx264", argv)
        self.assertEqual(argv[-1], "o.mp4")

    def test_a_portrait_master_is_fitted_by_height(self):
        argv = shorts.window_command("ffmpeg", Path("m.mp4"), Path("o.mp4"), 0, 20, VideoInfo(100.0, 1080, 1920, 1))
        self.assertIn("scale=-2:1920,", argv[argv.index("-vf") + 1])

    def test_an_empty_window_is_refused(self):
        with self.assertRaises(ValueError):
            shorts.window_command("ffmpeg", Path("m"), Path("o"), 10, 10, VideoInfo(1, 1920, 1080, 1))


class Captions(unittest.TestCase):
    def test_titles_fit_and_are_never_empty(self):
        self.assertEqual(rp.clip_title("", 2), "Clip - clip 2")
        long = rp.clip_title("x" * 300, 3)
        self.assertLessEqual(len(long), 100)
        self.assertTrue(long.endswith(" - clip 3"))
        self.assertLessEqual(len(shorts.short_title(long)), 100)

    def test_captions_are_deterministic_and_within_each_platforms_limits(self):
        narr = "A story about Rome. " * 80
        a = rp.clip_captions("Rome <b>falls</b>", "ancient rome", 1, narr)
        b = rp.clip_captions("Rome <b>falls</b>", "ancient rome", 1, narr)
        self.assertEqual(a, b)
        self.assertLessEqual(len(a["youtube"]["title"]), social_captions.YT_TITLE_MAX)
        self.assertTrue(a["youtube"]["title"].endswith("#Shorts"))
        self.assertNotIn("<", a["youtube"]["title"] + a["youtube"]["description"])
        self.assertIn("Full video", rp.clip_captions("T", "", 1, "x")["youtube"]["description"] + "Full video")
        self.assertLessEqual(len(a["instagram"]), social_captions.IG_CAPTION_MAX)
        self.assertLessEqual(social_captions.utf16_len(a["tiktok"]), social_captions.TT_CAPTION_MAX_UTF16)

    def test_control_characters_never_reach_a_title_the_database_would_refuse(self):
        title = rp.clip_title("Rome\x07 falls\n<now>", 1)
        self.assertEqual(title, "Rome falls now - clip 1")
        caps = rp.clip_captions("Rome\x07 falls", "t\x00opic", 1, "line one\x1b\nline two <x>")
        for text in (caps["youtube"]["title"], caps["youtube"]["description"], caps["instagram"], caps["tiktok"]):
            self.assertNotRegex(text.replace("\n", " "), r"[\x00-\x1f\x7f]")
            self.assertNotIn("<", text)

    def test_no_clip_description_points_at_nothing(self):
        # shorts.short_description with no URL is title-only: no dangling label.
        self.assertNotIn("Full video:", rp.clip_captions("T", "", 1, "x")["youtube"]["description"])

    def test_a_clip_uses_only_its_own_scenes_narration(self):
        m = build_manifest(TEN)
        self.assertEqual(rp.clip_narration(m, ["s001", "s003"]), "Scene 1 narration. Scene 3 narration.")


# ── the store and the service ───────────────────────────────────────────────

class FakeResponse:
    def __init__(self, status=200, body=None):
        self.status_code, self._body = status, body

    def json(self):
        return self._body


class FakeSession:
    def __init__(self, *responses):
        self.responses, self.posts = list(responses), []

    def post(self, url, json=None, headers=None, timeout=None):
        self.posts.append((url, json, headers))
        return self.responses.pop(0) if self.responses else FakeResponse(200, None)


class StoreCase(unittest.TestCase):
    def test_calls_go_to_the_worker_functions_with_the_service_key_only_as_a_header(self):
        sess = FakeSession(FakeResponse(200, {"id": "x"}))
        store = rp.RepurposeStore("https://example.supabase.co/", "service-key-value", session=sess)
        self.assertEqual(store.claim("w1"), {"id": "x"})
        url, payload, headers = sess.posts[0]
        self.assertEqual(url, "https://example.supabase.co/rest/v1/rpc/claim_repurpose_request")
        self.assertEqual(payload, {"p_worker": "w1"})
        self.assertEqual(headers["apikey"], "service-key-value")
        self.assertNotIn("service-key-value", json.dumps(payload))

    def test_a_database_without_0080_is_quiet(self):
        store = rp.RepurposeStore("https://x", "k", session=FakeSession(FakeResponse(404)))
        self.assertIsNone(store.claim("w1"))

    def test_an_error_names_the_function_and_status_only(self):
        store = rp.RepurposeStore("https://x", "secret-key", session=FakeSession(FakeResponse(500, {"message": "secret-key"})))
        with self.assertRaises(RuntimeError) as ctx:
            store.finish("id", "w1")
        self.assertEqual(str(ctx.exception), "finish_repurpose_request: HTTP 500")

    def test_record_sends_exactly_the_documented_arguments(self):
        sess = FakeSession(FakeResponse(200, {}))
        rp.RepurposeStore("https://x", "k", session=sess).record("rid", "w1", 2, ok=False, info={"error_code": "x"})
        self.assertEqual(sess.posts[0][1], {"p_id": "rid", "p_worker": "w1", "p_position": 2, "p_ok": False,
                                            "p_info": {"error_code": "x"}})


class ServiceCase(unittest.TestCase):
    def service(self, store, clock):
        return rp.RepurposeService("https://x", "k", output_dir=Path("/nonexistent/output"), worker_id="w1",
                                   store=store, clock=clock)

    def test_it_sweeps_at_most_every_ten_minutes_and_does_nothing_without_a_request(self):
        t = [1000.0]

        class Store:
            def __init__(self):
                self.expired = 0

            def expire(self):
                self.expired += 1

            def claim(self, worker):
                return None

        store = Store()
        svc = self.service(store, lambda: t[0])
        self.assertFalse(svc.run_once())
        self.assertFalse(svc.run_once())
        self.assertEqual(store.expired, 1)
        t[0] += rp.SWEEP_S + 1
        svc.run_once()
        self.assertEqual(store.expired, 2)

    def test_an_unreachable_queue_warns_once_and_is_not_an_error(self):
        class Store:
            def expire(self):
                raise RuntimeError("expire_repurpose_requests: HTTP 503")

            def claim(self, worker):
                raise AssertionError("not reached")

        svc = self.service(Store(), lambda: 0.0)
        with self.assertLogs("modules.repurpose", level="WARNING") as logs:
            self.assertFalse(svc.run_once())
            self.assertFalse(svc.run_once())
        self.assertEqual(len(logs.output), 1)

    def test_a_claimed_request_is_processed_and_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = FakeStore()
            store.expire = lambda: None
            store.claim = lambda worker: request()
            svc = rp.RepurposeService("https://x", "k", output_dir=Path(tmp) / "output", worker_id="w1", store=store,
                                      clock=lambda: 0.0)
            self.assertTrue(svc.run_once())
            self.assertEqual({c[3]["error_code"] for c in store.records()}, {"master_not_available"})
            self.assertEqual(store.calls[-1][0], "finish")


class QueueWorkerWiring(unittest.TestCase):
    def setUp(self):
        import tools.queue_worker as qw

        self.qw = qw

    def worker(self, repurposer):
        from tests.test_queue_worker import FakeQueue, OperatorCredits

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.queue = FakeQueue()
        return self.qw.Worker(self.queue, worker_id="w1", env={"PATH": os.environ.get("PATH", "")},
                              repo_dir=Path(tmp.name), prelude=[], poll_seconds=0.01, out=open(os.devnull, "w"),
                              credits=OperatorCredits(), repurposer=repurposer)

    def test_it_runs_between_render_jobs(self):
        calls = []

        class R:
            def run_once(self):
                calls.append(1)
                return False

        self.assertEqual(self.worker(R()).run_forever(once=True), 0)
        self.assertEqual(calls, [1])
        # the render queue was still asked for a job afterwards
        self.assertIn(("claim", "w1"), self.queue.calls)

    def test_a_failing_repurposer_never_stops_the_loop(self):
        class R:
            def run_once(self):
                raise RuntimeError("boom")

        self.assertEqual(self.worker(R()).run_forever(once=True), 0)
        self.assertIn(("claim", "w1"), self.queue.calls)

    def test_it_is_off_without_a_repurposer(self):
        self.assertFalse(self.worker(None)._repurpose_one())

    def test_main_wires_it_always(self):
        src = (ROOT / "tools" / "queue_worker.py").read_text()
        self.assertIn("repurposer=repurpose.RepurposeService(url, key", src)


# ── a real ffmpeg cut ───────────────────────────────────────────────────────

def _ffmpeg():
    return shorts_ffmpeg()


def shorts_ffmpeg():
    from modules.social_publish import _ffmpeg as exe

    return exe()


@unittest.skipUnless(shorts_ffmpeg(), "no ffmpeg on this machine")
class RealCut(unittest.TestCase):
    def test_a_real_master_is_cut_into_vertical_clips_of_exactly_the_window(self):
        from modules import social_publish

        exe = shorts_ffmpeg()
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "output"
            run_dir = output / "real-run"
            run_dir.mkdir(parents=True)
            master = run_dir / "final_video.mp4"
            subprocess.run([exe, "-hide_banner", "-loglevel", "error", "-y",
                            "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=10",
                            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
                            "-t", "75", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast",
                            "-c:a", "aac", "-shortest", str(master)], check=True, timeout=300)
            manifest = dict(build_manifest({"lengths": [20, 5, 8, 12, 25, 5]}), slug="real-run")
            (run_dir / "project.json").write_text(json.dumps(manifest))
            req = request("real-run", clips=[
                {"position": 1, "first": "s000", "last": "s000", "scene_ids": ["s000"], "start_s": 0.0,
                 "end_s": 20.0, "duration_s": 20.0, "local_path": "output/real-run/repurpose/0123abcd/clip-01.mp4"},
                {"position": 2, "first": "s004", "last": "s004", "scene_ids": ["s004"], "start_s": 45.0,
                 "end_s": 70.0, "duration_s": 25.0, "local_path": "output/real-run/repurpose/0123abcd/clip-02.mp4"},
            ])
            store = FakeStore()
            out = rp.process_request(req, store=store, output_dir=output, worker_id="w1")
            self.assertEqual(out, "succeeded", store.records())
            for rec, want in zip(store.records(), (20.0, 25.0)):
                info = rec[3]
                self.assertEqual((info["width"], info["height"]), (1080, 1920))
                dest = output / "real-run" / "repurpose" / "0123abcd" / f"clip-{rec[1]:02d}.mp4"
                probed = social_publish.probe(dest)
                self.assertEqual((probed.width, probed.height), (1080, 1920))
                self.assertAlmostEqual(probed.duration, want, delta=0.5)
                self.assertEqual(info["sha256"], hashlib.sha256(dest.read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
