"""Retention diagnosis (modules/retention_diagnosis.py).

What these pin, in the words of what would break:

* the ROUTING verdict sends the owner to the right lever — a healthy hook plus a
  flat slide is a PACKAGING problem (viewers who click stay), a steep early loss
  is the HOOK, a steady slide or a mid-video cliff is PACING;
* a mid-video cliff names the scene it falls in and a short, text-only excerpt of
  that scene's narration, capped in length, in any language;
* every unknown stays unknown — a curve under MIN_POINTS, an unknown or
  non-positive duration, a curve that does not reach the window, the curve's own
  start at 1% (the first scene's start is NOT assumed to be 100%) — as None /
  ``insufficient_data``, never 0 and never a guess;
* garbage in (NaN, inf, negative values, wrong types, empty inputs, a 1 MB
  narration) never raises, and the same input always gives the same answer;
* the shared cases in samples/retention_diagnosis_cases.json are reproduced
  (a TS twin would run the same file).
"""

import copy
import json
import unittest
from pathlib import Path

from modules import retention_diagnosis as rd
from modules.retention_analyzer import MIN_POINTS

CASES = json.loads(
    (Path(__file__).resolve().parent.parent / "samples" / "retention_diagnosis_cases.json").read_text("utf-8")
)

DATE = "2026-09-01"


def curve_from(knots, n=100, date=DATE):
    """Piecewise-linear retention rows: ``knots`` are (elapsed_ratio, watch_ratio)
    and a point is emitted every 1/n of the video (YouTube's own spacing)."""
    rows = []
    for i in range(n + 1):
        r = i / n
        for (r0, w0), (r1, w1) in zip(knots, knots[1:]):
            if r0 <= r <= r1:
                w = w0 + (w1 - w0) * (r - r0) / (r1 - r0) if r1 > r0 else w1
                rows.append({"elapsed_ratio": r, "watch_ratio": w, "measured_date": date})
                break
    return rows


def scenes_of(n, duration, text="narration"):
    step = duration / n
    return [
        {"id": f"s{i:03d}", "index": i, "start_s": i * step, "end_s": (i + 1) * step,
         "narration": f"{text} {i}"}
        for i in range(n)
    ]


D = 600.0  # a 10-minute video: one 1% point every 6 s, the hook window ends at 5%

# Loses 12 points in the first 30 s, then barely moves: nothing wrong with the
# video for people who stay, so the lever is who clicks.
PACKAGING = [(0.0, 1.0), (0.05, 0.88), (0.80, 0.84), (1.0, 0.80)]
# Loses 60% in the first 30 s.
HOOK = [(0.0, 1.0), (0.05, 0.40), (0.80, 0.30), (1.0, 0.25)]
# Good hook, then a steady bleed: 0.9 -> 0.35 across the middle.
SLIDE = [(0.0, 1.0), (0.05, 0.90), (0.80, 0.35), (1.0, 0.30)]
# Good hook and gentle slide, but 12 points vanish between 50% and 51%.
CLIFF = [(0.0, 1.0), (0.05, 0.90), (0.50, 0.80), (0.51, 0.68), (0.80, 0.64), (1.0, 0.60)]
# Moderate loss everywhere: nothing crosses a threshold, nothing is flat either.
MIDDLE = [(0.0, 1.0), (0.05, 0.80), (0.80, 0.60), (1.0, 0.50)]


def diag(knots, duration=D, scenes=None, n=100):
    return rd.diagnose(curve_from(knots, n), duration, scenes)


class RoutingTests(unittest.TestCase):
    def test_healthy_hook_and_flat_slide_routes_to_packaging(self):
        d = diag(PACKAGING)
        self.assertEqual(d.verdict, rd.VERDICT_PACKAGING)
        self.assertAlmostEqual(d.hook_loss, 0.12, places=3)
        self.assertLess(d.slide_per_tenth, rd.SLIDE_FLAT_MAX)

    def test_steep_early_loss_routes_to_hook(self):
        d = diag(HOOK)
        self.assertEqual(d.verdict, rd.VERDICT_HOOK)
        self.assertAlmostEqual(d.hook_loss, 0.60, places=3)
        self.assertAlmostEqual(d.hook_loss_share, 0.60, places=3)

    def test_steep_hook_wins_over_a_later_cliff(self):
        # the hook is the earliest, biggest lever: nothing after it matters
        # if most viewers are gone before the story starts
        knots = [(0.0, 1.0), (0.05, 0.40), (0.50, 0.35), (0.51, 0.20), (1.0, 0.15)]
        self.assertEqual(diag(knots).verdict, rd.VERDICT_HOOK)

    def test_steady_slide_routes_to_pacing(self):
        d = diag(SLIDE)
        self.assertEqual(d.verdict, rd.VERDICT_PACING)
        self.assertGreaterEqual(d.slide_per_tenth, rd.SLIDE_STEADY_MIN)

    def test_mid_video_cliff_routes_to_pacing_even_with_a_flat_slide(self):
        d = diag(CLIFF)
        self.assertEqual(d.verdict, rd.VERDICT_PACING)
        self.assertEqual(d.cliffs[0].zone, "mid")

    def test_nothing_crossing_a_threshold_is_healthy_not_packaging(self):
        # packaging is a positive claim (hook fine AND slide flat); a middling
        # slide must not be dressed up as one
        d = diag(MIDDLE)
        self.assertEqual(d.verdict, rd.VERDICT_HEALTHY)

    def test_a_middling_hook_with_a_flat_slide_is_healthy_not_packaging(self):
        knots = [(0.0, 1.0), (0.05, 0.65), (0.80, 0.62), (1.0, 0.60)]  # 35% lost: between the bands
        self.assertEqual(diag(knots).verdict, rd.VERDICT_HEALTHY)

    def test_verdict_is_always_from_the_closed_set(self):
        for knots in (PACKAGING, HOOK, SLIDE, CLIFF, MIDDLE):
            self.assertIn(diag(knots).verdict, rd.VERDICTS)
        self.assertEqual(
            set(rd.VERDICTS),
            {"packaging", "hook", "pacing", "healthy", "insufficient_data"},
        )

    def test_a_cliff_in_the_last_fifth_is_not_pacing(self):
        # viewers leave when the video ends / at the outro; that is not a scene
        # the writer can fix mid-story
        knots = [(0.0, 1.0), (0.05, 0.90), (0.88, 0.88), (0.89, 0.70), (1.0, 0.68)]
        d = diag(knots)
        self.assertEqual(d.cliffs[0].zone, "end")
        self.assertNotEqual(d.verdict, rd.VERDICT_PACING)

    def test_an_early_cliff_is_zoned_hook(self):
        d = diag(HOOK)
        self.assertTrue(d.cliffs)
        self.assertTrue(all(c.zone == "hook" for c in d.cliffs[:1]))


class HookLeakTests(unittest.TestCase):
    def test_hook_window_is_30_absolute_seconds_not_a_share_of_the_video(self):
        # the same curve on a 10-minute and a 20-minute video: the ratio axis is
        # identical, the 30 s mark is not
        short = diag(HOOK, duration=600.0)
        long = diag(HOOK, duration=1200.0)
        self.assertEqual(short.hook_window_s, 30.0)
        self.assertEqual(long.hook_window_s, 30.0)
        self.assertAlmostEqual(short.hook_end_retention, 0.40, places=3)   # 30 s = 5%
        self.assertAlmostEqual(long.hook_end_retention, 0.70, places=2)    # 30 s = 2.5%

    def test_hook_loss_is_measured_from_the_first_measured_point_not_assumed_100(self):
        # YouTube reports the curve from 1%: on a 10-min video the first point is
        # at 6 s. Its retention is the starting value; "100% at 0 s" is never invented.
        knots = [(0.01, 0.97), (0.05, 0.80), (1.0, 0.40)]
        rows = [r for r in curve_from([(0.0, 1.0), (1.0, 0.4)]) if r["elapsed_ratio"] >= 0.01]
        rows = [{"elapsed_ratio": r["elapsed_ratio"], "watch_ratio": _at(knots, r["elapsed_ratio"]),
                 "measured_date": DATE} for r in rows]
        d = rd.diagnose(rows, D)
        self.assertAlmostEqual(d.hook_from_s, 6.0, places=3)
        self.assertAlmostEqual(d.hook_start_retention, 0.97, places=3)
        self.assertAlmostEqual(d.hook_loss, 0.17, places=3)
        self.assertAlmostEqual(d.hook_loss_share, 0.17 / 0.97, places=3)

    def test_hook_unknown_when_the_curve_starts_too_close_to_the_30s_mark(self):
        # a 60-minute video: YouTube's first point (1%) is 36 s in, already past the window
        rows = [r for r in curve_from(HOOK) if r["elapsed_ratio"] >= 0.01]
        d = rd.diagnose(rows, 3600.0)
        self.assertIsNone(d.hook_from_s)
        self.assertIsNone(d.hook_loss)
        self.assertIsNone(d.hook_loss_share)
        self.assertIsNone(d.hook_end_retention)

    def test_hook_unknown_when_less_than_the_minimum_span_is_measured(self):
        # first point at 25 s (1% of a 2500 s video): only 5 s of the window is measured
        rows = [r for r in curve_from(HOOK) if r["elapsed_ratio"] >= 0.01]
        d = rd.diagnose(rows, 2500.0)
        self.assertIsNone(d.hook_loss)
        self.assertIsNone(d.hook_from_s)

    def test_hook_unknown_when_the_video_is_shorter_than_the_window(self):
        d = diag(HOOK, duration=20.0)
        self.assertIsNone(d.hook_loss)

    def test_a_rising_hook_is_a_negative_loss_and_healthy(self):
        knots = [(0.0, 0.90), (0.05, 0.95), (0.80, 0.90), (1.0, 0.88)]
        d = diag(knots)
        self.assertLess(d.hook_loss, 0)
        self.assertNotEqual(d.verdict, rd.VERDICT_HOOK)


def _at(knots, r):
    for (r0, w0), (r1, w1) in zip(knots, knots[1:]):
        if r0 <= r <= r1:
            return w0 + (w1 - w0) * (r - r0) / (r1 - r0)
    return knots[-1][1]


class SlideTests(unittest.TestCase):
    def test_slide_is_the_average_loss_between_30s_and_the_last_fifth(self):
        d = diag(SLIDE)
        # 30 s = 5% (0.90), last-20% boundary = 80% (0.35): 0.55 over 75% of the video
        self.assertAlmostEqual(d.slide_from_s, 30.0, places=3)
        self.assertAlmostEqual(d.slide_to_s, 480.0, places=3)
        self.assertAlmostEqual(d.slide_loss, 0.55, places=3)
        self.assertAlmostEqual(d.slide_per_min, 0.55 / 7.5, places=3)
        self.assertAlmostEqual(d.slide_per_tenth, 0.55 / 7.5, places=3)  # 10 min: a tenth is a minute

    def test_slide_per_tenth_does_not_depend_on_video_length(self):
        # the same shape on a 10-minute and a 40-minute video is the same story;
        # per-minute would call the long one flat
        a = diag(SLIDE, duration=600.0).slide_per_tenth
        b = diag(SLIDE, duration=2400.0).slide_per_tenth
        self.assertAlmostEqual(a, b, delta=0.01)

    def test_slide_unknown_when_the_window_is_too_short(self):
        # 60 s video: 30 s .. 48 s is 18 s of evidence
        d = diag(PACKAGING, duration=60.0)
        self.assertIsNone(d.slide_per_tenth)
        self.assertIsNone(d.slide_per_min)
        self.assertIsNone(d.slide_loss)

    def test_slide_unknown_does_not_become_packaging(self):
        d = diag(PACKAGING, duration=60.0)
        self.assertEqual(d.verdict, rd.VERDICT_INSUFFICIENT)


class CliffTests(unittest.TestCase):
    def test_mid_video_cliff_names_its_scene_and_narration_excerpt(self):
        scenes = scenes_of(10, D)
        scenes[5]["narration"] = "The bridge collapsed at dawn, and nobody had warned the city."
        d = diag(CLIFF, scenes=scenes)
        top = d.cliffs[0]
        # 50% -> 51% is 300 s -> 306 s: scene 5 spans 300-360 s
        self.assertEqual(top.scene_id, "s005")
        self.assertEqual(top.scene_index, 5)
        self.assertEqual(top.excerpt, "The bridge collapsed at dawn, and nobody had warned the city.")
        self.assertAlmostEqual(top.at_s, 300.0, places=3)
        self.assertAlmostEqual(top.end_s, 306.0, places=3)
        self.assertGreaterEqual(top.size, rd.CLIFF_MIN_DROP)
        self.assertEqual(top.zone, "mid")

    def test_cliff_size_is_the_drop_across_the_step(self):
        d = diag(CLIFF, scenes=scenes_of(10, D))
        # one 1% step carries the whole 0.12 plunge (interpolation of the knots)
        self.assertAlmostEqual(d.cliffs[0].size, 0.12, places=3)
        self.assertAlmostEqual(d.cliffs[0].retention_before, 0.80, places=3)
        self.assertAlmostEqual(d.cliffs[0].retention_after, 0.68, places=3)

    def test_at_most_top_n_cliffs_steepest_first(self):
        # eight separate 1%-wide plunges of growing size on a gently falling line
        knots, r, w = [(0.0, 1.0), (0.05, 0.95)], 0.05, 0.95
        for k in range(8):
            r += 0.08
            knots.append((round(r, 4), w))
            w -= 0.04 + 0.01 * k
            r += 0.01
            knots.append((round(r, 4), w))
        knots.append((1.0, w - 0.01))
        d = diag(knots)
        self.assertEqual(len(d.cliffs), rd.TOP_CLIFFS)
        rates = [c.rate_per_min for c in d.cliffs]
        self.assertEqual(rates, sorted(rates, reverse=True))
        self.assertGreater(d.cliffs[0].size, d.cliffs[-1].size)

    def test_cliff_in_a_scene_without_times_has_no_scene_but_keeps_its_timestamp(self):
        scenes = [{"id": "a", "narration": "no times here"}, {"id": "b", "start_s": None, "end_s": None}]
        top = diag(CLIFF, scenes=scenes).cliffs[0]
        self.assertIsNone(top.scene_id)
        self.assertIsNone(top.excerpt)
        self.assertAlmostEqual(top.at_s, 300.0, places=3)

    def test_no_scenes_still_reports_cliffs_without_a_scene(self):
        top = diag(CLIFF).cliffs[0]
        self.assertIsNone(top.scene_id)
        self.assertIsNone(top.scene_index)
        self.assertIsNone(top.excerpt)

    def test_scene_with_empty_narration_has_scene_but_no_excerpt(self):
        scenes = scenes_of(10, D)
        scenes[5]["narration"] = "   "
        top = diag(CLIFF, scenes=scenes).cliffs[0]
        self.assertEqual(top.scene_id, "s005")
        self.assertIsNone(top.excerpt)

    def test_a_step_midpoint_on_a_scene_boundary_belongs_to_the_scene_that_starts_there(self):
        knots = [(0.0, 1.0), (0.05, 0.9), (0.49, 0.8), (0.51, 0.68), (0.8, 0.64), (1.0, 0.6)]
        rows = [r for r in curve_from(knots) if r["elapsed_ratio"] != 0.5]  # one 12 s step, 294-306 s
        top = rd.diagnose(rows, D, scenes_of(10, D)).cliffs[0]
        self.assertEqual(top.scene_id, "s005")  # 300 s is scene 5's first second, not scene 4's last

    def test_a_scene_with_an_impossible_window_is_not_matched(self):
        for bad in ({"start_s": -10, "end_s": 400}, {"start_s": 400, "end_s": 200}, {"start_s": 300, "end_s": 300}):
            scenes = [dict(bad, id="x", narration="should not appear")]
            self.assertIsNone(diag(CLIFF, scenes=scenes).cliffs[0].scene_id, bad)

    def test_unsorted_scenes_are_found_by_time_not_by_position(self):
        scenes = list(reversed(scenes_of(10, D)))
        self.assertEqual(diag(CLIFF, scenes=scenes).cliffs[0].scene_id, "s005")

    def test_a_flat_curve_has_no_cliffs_but_it_is_known(self):
        d = diag([(0.0, 0.9), (1.0, 0.9)])
        self.assertEqual(d.cliffs, ())  # measured: none -- not None

    def test_noise_is_not_a_cliff(self):
        rows = curve_from([(0.0, 1.0), (0.05, 0.9), (1.0, 0.6)])
        for i, row in enumerate(rows):
            row["watch_ratio"] += 0.006 * (1 if i % 2 else -1)
        d = rd.diagnose(rows, D)
        self.assertEqual(d.cliffs, ())

    def test_cliff_rate_is_per_minute_of_video(self):
        top = diag(CLIFF).cliffs[0]
        self.assertAlmostEqual(top.rate_per_min, 0.12 / (6 / 60.0), places=2)


class ExcerptTests(unittest.TestCase):
    def _excerpt(self, narration):
        scenes = scenes_of(10, D)
        scenes[5]["narration"] = narration
        return diag(CLIFF, scenes=scenes).cliffs[0].excerpt

    def test_excerpt_is_length_capped_with_an_ellipsis(self):
        out = self._excerpt("word " * 500)
        self.assertLessEqual(len(out), rd.EXCERPT_MAX_CHARS)
        self.assertTrue(out.endswith("…"))

    def test_very_long_narration_does_not_blow_up(self):
        out = self._excerpt("лента " * 400_000)  # ~2.4 MB of Cyrillic
        self.assertLessEqual(len(out), rd.EXCERPT_MAX_CHARS)

    def test_excerpt_is_text_only_no_markup(self):
        out = self._excerpt("<b>Bridge</b> [PAUSE:2] **fell** `at` _dawn_ #1 <script>x</script>")
        for ch in "<>*`_#[]":
            self.assertNotIn(ch, out)
        self.assertTrue(out.startswith("Bridge fell at dawn"))

    def test_excerpt_collapses_whitespace_and_control_characters(self):
        out = self._excerpt("a\n\n\tb\x00c\x07  d")
        self.assertEqual(out, "a b c d")

    def test_excerpt_keeps_any_language_intact(self):
        for text in ("Кўприк тонг отганда қулади", "Мост рухнул на рассвете", "桥在黎明时倒塌了", "جسر انهار"):
            self.assertEqual(self._excerpt(text), text)

    def test_cap_never_splits_a_character(self):
        out = self._excerpt("😀" * 1000)
        self.assertLessEqual(len(out), rd.EXCERPT_MAX_CHARS)
        out.encode("utf-8")  # raises on a lone surrogate

    def test_non_string_narration_is_no_excerpt(self):
        for bad in (None, 5, ["x"], {"a": 1}):
            self.assertIsNone(self._excerpt(bad))


class UnknownTests(unittest.TestCase):
    def assertAllUnknown(self, d):
        self.assertEqual(d.verdict, rd.VERDICT_INSUFFICIENT)
        for name in ("hook_from_s", "hook_start_retention", "hook_end_retention", "hook_loss",
                     "hook_loss_share", "slide_from_s", "slide_to_s", "slide_loss", "slide_per_min",
                     "slide_per_tenth", "cliffs"):
            self.assertIsNone(getattr(d, name), name)

    def test_curve_under_min_points_is_all_unknown(self):
        rows = curve_from(PACKAGING)[: MIN_POINTS - 1]
        self.assertAllUnknown(rd.diagnose(rows, D))

    def test_exactly_min_points_is_enough_to_be_measured(self):
        rows = curve_from(PACKAGING, n=MIN_POINTS - 1)
        d = rd.diagnose(rows, D)
        self.assertIsNotNone(d.cliffs)

    def test_unknown_duration_is_all_unknown(self):
        for bad in (None, 0, -5, float("nan"), float("inf"), "abc", True, [], {}):
            with self.subTest(duration=bad):
                self.assertAllUnknown(rd.diagnose(curve_from(HOOK), bad))

    def test_empty_and_missing_inputs(self):
        for points in (None, [], (), {}, "", 0):
            with self.subTest(points=points):
                self.assertAllUnknown(rd.diagnose(points, D))
        self.assertAllUnknown(rd.diagnose(None, None, None))
        self.assertAllUnknown(rd.diagnose([], 0, []))

    def test_unknown_is_none_never_zero(self):
        d = rd.diagnose(curve_from(PACKAGING)[:3], D)
        out = d.to_dict()
        self.assertIsNone(out["hook_loss"])
        self.assertIsNone(out["slide_per_tenth"])
        self.assertIsNone(out["cliffs"])

    def test_insufficient_data_says_why(self):
        self.assertEqual(rd.diagnose([], D).reason, "no_curve")
        self.assertEqual(rd.diagnose(curve_from(HOOK), None).reason, "no_duration")

    def test_curve_that_never_reaches_the_window_is_unknown(self):
        # measured only from 60% on: nothing about the hook or the start of the slide
        rows = [r for r in curve_from(PACKAGING) if r["elapsed_ratio"] >= 0.6]
        d = rd.diagnose(rows, D)
        self.assertIsNone(d.hook_loss)
        self.assertIsNone(d.slide_per_tenth)
        self.assertEqual(d.verdict, rd.VERDICT_INSUFFICIENT)

    def test_hook_known_but_slide_unknown_cannot_be_called_packaging_or_healthy(self):
        rows = [r for r in curve_from(PACKAGING) if r["elapsed_ratio"] <= 0.5]  # no point near 80%
        d = rd.diagnose(rows, D)
        self.assertIsNotNone(d.hook_loss)
        self.assertIsNone(d.slide_per_tenth)
        self.assertEqual(d.verdict, rd.VERDICT_INSUFFICIENT)

    def test_hook_alone_is_enough_to_call_a_steep_hook(self):
        rows = [r for r in curve_from(HOOK) if r["elapsed_ratio"] <= 0.5]
        self.assertEqual(rd.diagnose(rows, D).verdict, rd.VERDICT_HOOK)


class DirtyInputTests(unittest.TestCase):
    def test_points_past_the_end_of_the_video_are_dropped_not_extrapolated_into(self):
        rows = curve_from(PACKAGING)
        clean = rd.diagnose(copy.deepcopy(rows), D)
        rows.append({"elapsed_ratio": 1.5, "watch_ratio": 0.0, "measured_date": DATE})
        dirty = rd.diagnose(rows, D)
        self.assertEqual(dirty.to_dict(), clean.to_dict())

    def test_a_curve_that_falls_under_min_points_once_bad_rows_are_dropped_is_unknown(self):
        rows = curve_from(PACKAGING, n=MIN_POINTS - 1)
        rows[1]["watch_ratio"] = -1.0
        rows[2]["watch_ratio"] = -1.0
        d = rd.diagnose(rows, D)
        self.assertEqual(d.verdict, rd.VERDICT_INSUFFICIENT)
        self.assertIsNone(d.cliffs)

    def test_zero_starting_retention_gives_a_loss_but_no_share(self):
        rows = [{"elapsed_ratio": i / 100, "watch_ratio": 0.0, "measured_date": DATE} for i in range(101)]
        d = rd.diagnose(rows, D)
        self.assertEqual(d.hook_loss, 0.0)
        self.assertIsNone(d.hook_loss_share)
        self.assertEqual(d.verdict, rd.VERDICT_INSUFFICIENT)

    def test_nan_inf_and_negative_values_are_dropped_not_read_as_zero(self):
        rows = curve_from(PACKAGING)
        clean = rd.diagnose(copy.deepcopy(rows), D)
        rows[10]["watch_ratio"] = float("nan")
        rows[20]["watch_ratio"] = float("inf")
        rows[30]["watch_ratio"] = float("-inf")
        rows[40]["watch_ratio"] = -0.2
        rows[50]["elapsed_ratio"] = float("nan")
        rows[60]["elapsed_ratio"] = -0.1
        rows[70]["elapsed_ratio"] = 1.7
        dirty = rd.diagnose(rows, D)
        self.assertEqual(dirty.verdict, clean.verdict)
        self.assertAlmostEqual(dirty.hook_loss, clean.hook_loss, places=3)
        # a dropped point must not have been read as 0 and become a cliff
        self.assertEqual(dirty.cliffs, ())

    def test_none_and_string_watch_values_are_dropped(self):
        rows = curve_from(PACKAGING)
        rows[10]["watch_ratio"] = None
        rows[11]["watch_ratio"] = "n/a"
        rows[12]["watch_ratio"] = True
        d = rd.diagnose(rows, D)
        self.assertEqual(d.verdict, rd.VERDICT_PACKAGING)
        self.assertEqual(d.cliffs, ())

    def test_wrong_types_never_raise(self):
        junk = [None, 5, "x", object(), [1, 2], {"elapsed_ratio": "a"}, {}]
        for pts in (junk, [junk], object(), 3.5):
            for scenes in (None, junk, "scenes", 7, [None, 5, {"start_s": "a", "end_s": [] }]):
                for dur in (D, "x", None, object()):
                    with self.subTest(points=repr(pts)[:30], scenes=repr(scenes)[:30], dur=repr(dur)[:20]):
                        d = rd.diagnose(pts, dur, scenes)
                        self.assertIn(d.verdict, rd.VERDICTS)
                        d.to_dict()

    def test_for_video_without_a_manifest_is_unknown(self):
        for manifest in (None, "x", 5, [], {}):
            d = rd.for_video(manifest, curve_from(HOOK))
            self.assertEqual(d.verdict, rd.VERDICT_INSUFFICIENT)

    def test_non_monotonic_rewatch_spikes_are_not_cliffs(self):
        knots = [(0.0, 1.0), (0.05, 0.9), (0.4, 0.8), (0.41, 0.95), (0.42, 0.8), (1.0, 0.7)]
        d = diag(knots)
        # the spike UP is not a drop; the fall back is the real step
        self.assertTrue(all(c.size > 0 for c in d.cliffs))
        self.assertTrue(all(c.retention_before > c.retention_after for c in d.cliffs))

    def test_only_the_newest_snapshot_is_read(self):
        old = curve_from(HOOK, date="2026-08-01")
        new = curve_from(PACKAGING, date="2026-09-01")
        self.assertEqual(rd.diagnose(old + new, D).verdict, rd.VERDICT_PACKAGING)

    def test_unordered_rows_give_the_same_answer(self):
        rows = curve_from(CLIFF)
        shuffled = rows[::2] + rows[1::2]
        self.assertEqual(rd.diagnose(rows, D).to_dict(), rd.diagnose(shuffled, D).to_dict())


class DeterminismTests(unittest.TestCase):
    def test_same_input_same_output_and_input_not_mutated(self):
        rows = curve_from(CLIFF)
        scenes = scenes_of(10, D)
        before = copy.deepcopy((rows, scenes))
        a = rd.diagnose(rows, D, scenes).to_dict()
        b = rd.diagnose(rows, D, scenes).to_dict()
        self.assertEqual(a, b)
        self.assertEqual((rows, scenes), before)

    def test_to_dict_is_json_serialisable(self):
        d = rd.diagnose(curve_from(CLIFF), D, scenes_of(10, D)).to_dict()
        self.assertEqual(json.loads(json.dumps(d)), d)

    def test_tie_between_equal_cliffs_goes_to_the_earlier_one(self):
        knots = [(0.0, 1.0), (0.05, 0.95), (0.30, 0.90), (0.31, 0.80), (0.60, 0.78), (0.61, 0.68), (1.0, 0.66)]
        d = diag(knots)
        self.assertEqual([round(c.at_s) for c in d.cliffs[:2]], [180, 360])


class ForVideoTests(unittest.TestCase):
    def test_duration_and_scenes_come_from_the_stored_manifest(self):
        scenes = scenes_of(10, D)
        scenes[5]["narration"] = "Kritik lahza"
        manifest = {"audio": {"duration_s": D}, "scenes": scenes}
        d = rd.for_video(manifest, curve_from(CLIFF))
        self.assertEqual(d.verdict, rd.VERDICT_PACING)
        self.assertEqual(d.cliffs[0].scene_id, "s005")
        self.assertEqual(d.cliffs[0].excerpt, "Kritik lahza")
        self.assertEqual(d.duration_s, D)

    def test_duration_falls_back_to_the_last_scene_end(self):
        manifest = {"scenes": scenes_of(10, D)}
        self.assertEqual(rd.for_video(manifest, curve_from(CLIFF)).duration_s, D)

    def test_manifest_without_any_duration_is_unknown(self):
        manifest = {"scenes": [{"id": "a", "narration": "x"}]}
        self.assertEqual(rd.for_video(manifest, curve_from(CLIFF)).verdict, rd.VERDICT_INSUFFICIENT)


class ThresholdTests(unittest.TestCase):
    """Boundaries are documented constants; pin the ordering so a careless edit
    cannot make the bands overlap (a hook both healthy and steep)."""

    def test_bands_do_not_overlap(self):
        self.assertLess(rd.HOOK_HEALTHY_MAX_LOSS, rd.HOOK_STEEP_MIN_LOSS)
        self.assertLess(rd.SLIDE_FLAT_MAX, rd.SLIDE_STEADY_MIN)
        self.assertGreater(rd.HOOK_WINDOW_S, 0)
        self.assertGreater(rd.TOP_CLIFFS, 0)

    def test_hook_boundary_inclusive_sides(self):
        def hook_with(loss):
            return diag([(0.0, 1.0), (0.05, 1.0 - loss), (0.80, 1.0 - loss), (1.0, 1.0 - loss)]).verdict
        self.assertEqual(hook_with(rd.HOOK_STEEP_MIN_LOSS), rd.VERDICT_HOOK)
        self.assertNotEqual(hook_with(rd.HOOK_STEEP_MIN_LOSS - 0.02), rd.VERDICT_HOOK)
        self.assertEqual(hook_with(rd.HOOK_HEALTHY_MAX_LOSS), rd.VERDICT_PACKAGING)
        self.assertEqual(hook_with(rd.HOOK_HEALTHY_MAX_LOSS + 0.02), rd.VERDICT_HEALTHY)


class SharedCaseTests(unittest.TestCase):
    """The cases a TS twin would also run."""

    def test_every_case(self):
        for case in CASES["cases"]:
            with self.subTest(case["name"]):
                d = rd.diagnose(case["points"], case["duration_s"], case.get("scenes")).to_dict()
                exp = case["expected"]
                self.assertEqual(d["verdict"], exp["verdict"])
                for key in ("hook_loss", "hook_loss_share", "slide_per_tenth"):
                    if key in exp:
                        if exp[key] is None:
                            self.assertIsNone(d[key], key)
                        else:
                            self.assertAlmostEqual(d[key], exp[key], places=3, msg=key)
                if "cliffs" in exp:
                    if exp["cliffs"] is None:
                        self.assertIsNone(d["cliffs"])
                    else:
                        self.assertEqual(len(d["cliffs"]), len(exp["cliffs"]))
                        for got, want in zip(d["cliffs"], exp["cliffs"]):
                            for k, v in want.items():
                                if isinstance(v, (int, float)) and not isinstance(v, bool):
                                    self.assertAlmostEqual(got[k], v, places=3, msg=k)
                                else:
                                    self.assertEqual(got[k], v, k)


if __name__ == "__main__":
    unittest.main()
