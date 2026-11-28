"""Take and assembly progress (0246): the vendor's own percent and status word, and the assembly's measured percent.

What would break, and which test says so:

* a vendor percent outside 0..100 (or Runway's 0..1 fraction read as a percent) shown clamped instead of dropped (rule 5);
* an unknown percent arriving as 0, or a status "word" that is free text (an error, an id, a key) passed on;
* the adapters' status words or Runway's percent dropped again between the adapter and the take (creative_adapters.py);
* a write per poll (the throttle), a new status word held back by it, a failed poll wiping what the vendor said, or a
  failed write changing the take;
* ffmpeg's -progress report misread (out_time_ms is microseconds too; N/A and negatives come first), the assembly
  percent guessed from wall time, or a figure above 100 reported;
* a secret reaching a log line.
"""

from __future__ import annotations

import logging
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import film_assembly as fa
from modules import film_orchestrator as fo
from modules import render_backend
from modules.capabilities import base as cap_base
from modules.capabilities import video as cap_video
from tests import test_film_orchestrator as tfo

SECRET = "sk-live-THIS-IS-A-SECRET-0123456789"


class VendorFigures(unittest.TestCase):
    def test_a_percent_is_kept_only_inside_0_to_100_and_never_clamped(self):
        for v, want in ((0, 0.0), (37.256, 37.26), (100, 100.0), (100.01, None), (-0.5, None), (140, None),
                        (float("nan"), None), (float("inf"), None), (True, None), ("50", None), (None, None)):
            with self.subTest(v=v):
                self.assertEqual(cw.vendor_percent(v), want)

    def test_a_status_word_is_one_short_lowercase_word_or_nothing(self):
        for v, want in (("QUEUED", "queued"), (" In Progress ", "in_progress"), ("in-progress", "in_progress"),
                        ("Task not found", "task_not_found"), ("x" * 33, None), ("9lives", None), ("bad: text", None),
                        (f"failed {SECRET}", None), ("", None), (None, None), (7, None)):
            with self.subTest(v=v):
                self.assertEqual(cw.vendor_word(v), want)

    def test_runways_fraction_becomes_a_percent_and_anything_else_is_dropped(self):
        for v, want in ((0, 0.0), (0.48, 48.0), (1, 100.0), (1.2, None), (45, None), (-0.1, None), (True, None),
                        ("0.5", None), (None, None)):
            with self.subTest(v=v):
                self.assertEqual(cap_video._runway_percent(v), want)


class _Inner:
    key = "lab"
    capabilities = ("i2v",)

    def __init__(self, result):
        self.result = result

    def poll(self, task):
        return self.result


def _registry(result):
    entry = types.SimpleNamespace(raw={"pricing": {"unit": "second"}}, provider="lab", vendor_model_for=lambda cap: "lab-v1",
                                  id="lab", capabilities=("i2v",))
    return ca.RegistryAdapter(entry, _Inner(result), sync_store={})


class PassThrough(unittest.TestCase):
    def poll(self, result):
        req = cw.GenerationRequest(job_id="j", org_id="o", capability="i2v", model="lab", params={})
        return _registry(result).poll("task-1", req, Path(tempfile.gettempdir()))

    def test_a_pending_answer_carries_the_vendors_percent_and_word(self):
        p = self.poll(cap_base.PollResult(cap_base.PENDING, progress=48.0, vendor_state="RUNNING"))
        self.assertEqual((p.state, p.progress, p.vendor_state), (cw.PENDING, 48.0, "running"))

    def test_an_out_of_range_percent_and_a_sentence_are_dropped_on_the_way(self):
        p = self.poll(cap_base.PollResult(cap_base.PENDING, progress=140.0, vendor_state="Failed: quota for key " + SECRET))
        self.assertEqual((p.progress, p.vendor_state), (None, None))

    def test_a_vendor_that_says_nothing_is_not_known(self):
        p = self.poll(cap_base.PollResult(cap_base.PENDING))
        self.assertEqual((p.progress, p.vendor_state), (None, None))

    def test_runways_poll_passes_its_status_and_percent(self):
        adapter = cap_video.RunwayAdapter.__new__(cap_video.RunwayAdapter)
        adapter.base_url = "https://api.example"
        with mock.patch.object(cap_video.RunwayAdapter, "require_key", lambda self: None), \
                mock.patch.object(cap_video.RunwayAdapter, "get", lambda self, url: {"status": "RUNNING", "progress": 0.25}):
            r = adapter.poll(cap_base.ProviderTask("runway", "gen4", "task-1"))
        self.assertEqual((r.state, r.progress, r.vendor_state), (cap_base.PENDING, 25.0, "RUNNING"))
        with mock.patch.object(cap_video.RunwayAdapter, "require_key", lambda self: None), \
                mock.patch.object(cap_video.RunwayAdapter, "get", lambda self, url: {"status": "PENDING", "progress": 7}):
            r = adapter.poll(cap_base.ProviderTask("runway", "gen4", "task-1"))
        self.assertIsNone(r.progress)

    def test_every_in_flight_answer_of_the_adapters_names_its_word(self):
        # The pass-through exists in every adapter but two whose "pending" carries no status (a held sync answer).
        import glob
        import re
        missing = []
        for f in glob.glob(str(Path(cap_base.__file__).parent / "*.py")):
            for n, line in enumerate(Path(f).read_text().splitlines(), 1):
                if re.search(r"return PollResult\(PENDING\)", line):
                    missing.append(f"{Path(f).name}:{n}")
        self.assertLessEqual(len(missing), 2, missing)


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


class Throttle(unittest.TestCase):
    def setUp(self):
        self.clock, self.writes = Clock(), []
        self.p = fo.TakeProgress(lambda pct, w: self.writes.append((pct, w)), clock=self.clock)

    def test_nothing_is_written_until_the_vendor_says_something(self):
        self.assertFalse(self.p.report(None, None))
        self.assertEqual(self.writes, [])

    def test_one_write_per_interval_and_never_the_same_twice(self):
        self.assertTrue(self.p.report(10.0, "running"))
        self.clock.t = 5
        self.assertFalse(self.p.report(20.0, "running"))   # inside 15 s
        self.clock.t = 16
        self.assertTrue(self.p.report(30.0, "running"))
        self.clock.t = 40
        self.assertFalse(self.p.report(30.0, "running"))   # nothing new
        self.assertEqual(self.writes, [(10.0, "running"), (30.0, "running")])

    def test_a_new_status_word_is_written_at_once(self):
        self.p.report(None, "queued")
        self.clock.t = 1
        self.assertTrue(self.p.report(None, "running"))
        self.assertEqual(self.writes, [(None, "queued"), (None, "running")])

    def test_a_vendor_that_stops_saying_is_written_as_not_known_never_left_at_the_old_figure(self):
        self.p.report(60.0, "running")
        self.clock.t = 20
        self.assertTrue(self.p.report(None, "running"))
        self.assertEqual(self.writes[-1], (None, "running"))

    def test_a_missing_function_switches_the_reporter_off_and_a_failure_changes_nothing(self):
        calls = []

        def missing(pct, w):
            calls.append(1)
            raise fo.FilmFunctionMissing("film_take_progress: HTTP 404")

        p = fo.TakeProgress(missing, clock=self.clock)
        self.assertFalse(p.report(10.0, "running"))
        self.assertTrue(p.off)
        self.clock.t = 100
        self.assertFalse(p.report(20.0, "running"))
        self.assertEqual(len(calls), 1)

        def boom(pct, w):
            raise RuntimeError(f"POST https://db.example/rpc {SECRET}")

        p = fo.TakeProgress(boom, clock=self.clock)
        with self.assertLogs("film_worker", level="WARNING") as logs:
            self.assertFalse(p.report(10.0, "running"))
        text = "\n".join(logs.output)
        self.assertIn("RuntimeError", text)
        self.assertNotIn(SECRET, text)
        self.assertNotIn("https://", text)


class ProgressDb(tfo.FakeDb):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.progress = []

    def take_progress(self, take, worker, pct, word):
        self.progress.append((self._t(take)["kind"], pct, word))
        return True


class ScriptedAdapter(tfo.FakeAdapter):
    def __init__(self, model, steps):
        super().__init__(model)
        self.steps = list(steps)

    def poll(self, task_id, request, out_dir):
        step = self.steps.pop(0) if self.steps else "ok"
        if isinstance(step, BaseException):
            raise step
        if isinstance(step, tuple):
            return cw.ProviderPoll(cw.PENDING, progress=step[0], vendor_state=step[1])
        return super().poll(task_id, request, out_dir)


class FilmTakeProgress(unittest.TestCase):
    def test_a_running_clip_reports_its_vendors_progress_throttled_and_a_failed_poll_wipes_nothing(self):
        db = ProgressDb()
        clock = iter(range(0, 10_000, 4))   # every poll 4 s later
        steps = [(None, "queued"), (10.0, "running"), (20.0, "running"), (30.0, "running"), tfo.Err("unavailable"),
                 (50.0, "running"), (60.0, "running"), "ok"]
        adapters = {"img-key": ScriptedAdapter("img-key", []), "tts-a": ScriptedAdapter("tts-a", []),
                    "vid-clip": ScriptedAdapter("vid-clip", steps)}
        h = tfo.Harness(db, adapters, clock=lambda: float(next(clock)))
        self.assertEqual(h.run().result, "settled")
        clip = [(p, w) for k, p, w in db.progress if k == "clip"]
        # queued at once, running at once (a new word), then one figure per 15 s at most; the failed poll writes nothing.
        self.assertEqual(clip[0], (None, "queued"))
        self.assertEqual(clip[1], (10.0, "running"))
        self.assertLess(len(clip), len([s for s in steps if isinstance(s, tuple)]))
        self.assertNotIn((None, None), clip)

    def test_without_0246_on_the_fake_nothing_changes(self):
        h = tfo.Harness()
        self.assertEqual(h.run().result, "settled")

    def test_filmrest_sends_the_four_fields_to_film_take_progress(self):
        rest = fo.FilmRest.__new__(fo.FilmRest)
        seen = []
        rest.rpc = lambda name, body: seen.append((name, body)) or True
        self.assertTrue(rest.take_progress("t1", "w-1", 25.0, "running"))
        self.assertEqual(seen, [("film_take_progress", {"p_take": "t1", "p_worker": "w-1", "p_progress": 25.0,
                                                        "p_vendor_state": "running"})])


class FfmpegProgress(unittest.TestCase):
    def test_out_time_is_read_in_seconds_from_us_or_ms_and_na_or_negative_is_not_yet(self):
        text = "frame=0\nout_time_us=N/A\nout_time_ms=-9223372036854775807\nprogress=continue\n"
        self.assertIsNone(render_backend.parse_progress_out_time(text))
        text += "frame=30\nout_time_us=1500000\nout_time_ms=1500000\nprogress=continue\nframe=60\nout_time_ms=3000000\n"
        self.assertEqual(render_backend.parse_progress_out_time(text), 3.0)
        self.assertIsNone(render_backend.parse_progress_out_time(""))

    def test_the_percent_is_segments_then_the_final_pass_over_twice_the_timeline(self):
        got = []
        m = render_backend.RenderProgress(got.append, total_s=10.0)
        m.segment_done(0, 4.0)
        m.segment_done(1, 6.0)
        m.final_at(5.0)
        self.assertEqual(got, [20.0, 50.0, 75.0])
        m.final_at(10.0)        # the timeline's end, while ffmpeg may still be flushing: 100 is not said yet
        m.final_at(10.4)        # past the timeline (padding): not reported, not clamped
        self.assertEqual(got[-1], 75.0)
        m.finished()            # the final ffmpeg exited 0: now, and only now, 100
        self.assertEqual(got[-1], 100.0)
        fresh = render_backend.RenderProgress(got.append, total_s=10.0)
        fresh.segment_done(0, 4.0)
        fresh.segment_done(1, 6.0)
        fresh.final_at(0.4)
        fresh.reset_segments()  # the compact redo starts the segments again
        self.assertEqual(fresh.percent(), 2.0)

    def test_a_report_that_raises_never_fails_the_render(self):
        def boom(pct):
            raise RuntimeError(SECRET)

        m = render_backend.RenderProgress(boom, total_s=2.0)
        with self.assertLogs("modules.render_backend", level="WARNING") as logs:
            m.segment_done(0, 1.0)
        self.assertNotIn(SECRET, "\n".join(logs.output))

    @unittest.skipUnless(Path("/usr/bin/ffmpeg").exists(), "ffmpeg binary not available")
    def test_a_real_render_reports_rising_percents_up_to_100_and_the_file_is_the_same_command_otherwise(self):
        from modules.render_spec import KIND_COLOR
        got = []
        with tempfile.TemporaryDirectory() as d:
            spec = render_backend.simple_spec(str(Path(d) / "out.mp4"), [(None, 1.0, KIND_COLOR), (None, 1.0, KIND_COLOR)],
                                              width=160, height=120, fps=12)
            render_backend.render(spec, progress=got.append)
            self.assertTrue((Path(d) / "out.mp4").stat().st_size > 0)
        self.assertTrue(got, "no percent was reported")
        self.assertEqual(got, sorted(got))
        self.assertTrue(all(0 <= p <= 100 for p in got))
        self.assertEqual(got[:2], [25.0, 50.0])        # each 1 s segment of a 2 s timeline is a quarter of the work
        self.assertEqual(got[-1], 100.0)                    # said once ffmpeg exited 0
        self.assertEqual(got.count(100.0), 1)


class AssemblyThrottle(unittest.TestCase):
    def test_a_whole_point_and_ten_seconds_or_the_end(self):
        clock, writes = Clock(), []
        store = types.SimpleNamespace(assembly_progress=lambda seg, w, pct: writes.append(pct))
        p = fa.AssemblyProgress(store, "seg", "w-1", clock=clock)
        p(10.0)
        clock.t = 2
        p(30.0)          # inside 10 s
        clock.t = 11
        p(30.5)          # moved, and 10 s passed
        clock.t = 30
        p(30.9)          # not a whole point
        clock.t = 31
        p(100.0)         # the end is always written
        self.assertEqual(writes, [10.0, 30.5, 100.0])

    def test_a_failed_write_is_logged_by_type_and_the_render_goes_on(self):
        def boom(seg, w, pct):
            raise RuntimeError(SECRET)

        p = fa.AssemblyProgress(types.SimpleNamespace(assembly_progress=boom), "seg", "w-1", clock=Clock())
        with self.assertLogs("modules.film_assembly", level="WARNING") as logs:
            p(10.0)
        self.assertNotIn(SECRET, "\n".join(logs.output))

    def test_the_store_calls_the_0246_function_and_a_missing_one_is_false(self):
        store = fa.AssemblyStore.__new__(fa.AssemblyStore)
        seen = []
        store._call = lambda name, payload, missing_ok=False: seen.append((name, payload, missing_ok)) or None
        self.assertFalse(store.assembly_progress("seg", "w-1", 12.5))
        self.assertEqual(seen, [("film_segment_assembly_progress", {"p_segment": "seg", "p_worker": "w-1", "p_progress": 12.5},
                                 True)])


if __name__ == "__main__":
    logging.basicConfig()
    unittest.main()


class AssemblyMeterShare(unittest.TestCase):
    """The assembly's percent across the sound passes and the render, in media seconds (film_assembly.AssemblyMeter)."""

    def test_no_percent_before_the_mix_says_how_many_passes_it_runs(self):
        got = []
        m = fa.AssemblyMeter(got.append, 10.0)
        m.at(0, 5.0)
        self.assertEqual(got, [])

    def test_each_pass_is_one_film_length_and_the_render_two_and_100_waits_for_the_render(self):
        got = []
        m = fa.AssemblyMeter(got.append, 10.0)
        m.plan(3)                 # premaster, measure, loudnorm: work = (3 + 2) x 10 = 50 s
        m.at(0, 5.0)              # 5 of 50
        m.step_done(0)            # 10 of 50
        m.at(1, 12.0)             # past the film: not a measurement, nothing added
        m.step_done(1)
        m.mix_finished()          # the skipped or finished third pass: 30 of 50
        m.render(50.0)            # half the render: 40 of 50
        self.assertEqual(got, [0.0, 10.0, 20.0, 20.0, 40.0, 60.0, 80.0])
        self.assertNotIn(100.0, got)
        m.render(100.0)           # RenderProgress says 100 only after its last ffmpeg exited 0
        self.assertEqual(got[-1], 100.0)

    def test_a_pass_that_says_nothing_adds_nothing_until_it_finished(self):
        got = []
        m = fa.AssemblyMeter(got.append, 10.0)
        m.plan(2)
        m.step_done(0)
        self.assertEqual(got[-1], 25.0)       # 10 of 40; pass 1 has reported nothing: no share is guessed for it
        m.render(99.99)
        self.assertLess(got[-1], 100.0)


@unittest.skipUnless(Path("/usr/bin/ffmpeg").exists(), "ffmpeg binary not available")
class MixProgressReal(unittest.TestCase):
    def test_every_planned_sound_pass_reports_and_finishes_and_the_mix_is_the_same(self):
        from modules import film_mix as fm
        from modules import timeline as tl
        from tests.test_film_clip_sound import SoundFilm

        root = Path(tempfile.mkdtemp())
        film = SoundFilm(root, ["narrated", "wordless", "dialogue"])
        cut = film.cut()
        calls = []

        class Rec:
            def plan(self, n):
                calls.append(("plan", n))

            def at(self, k, s):
                calls.append(("at", k, s))

            def step_done(self, k):
                calls.append(("done", k))

        (root / "w1").mkdir()
        mixed = fm.master(tl.load(cut.doc), cut, film.resolver(), ffmpeg="/usr/bin/ffmpeg", workdir=str(root / "w1"),
                          timeout_s=300, progress=Rec())
        plan = [c[1] for c in calls if c[0] == "plan"]
        done = [c[1] for c in calls if c[0] == "done"]
        self.assertEqual(len(plan), 1)
        self.assertEqual(done, list(range(plan[0])))
        self.assertTrue(all(0 <= c[2] <= cut.length_s + 1 for c in calls if c[0] == "at"))
        self.assertFalse(list((root / "w1").glob("*.progress")), "a -progress file was left behind")
        self.assertTrue(mixed.tracks)
