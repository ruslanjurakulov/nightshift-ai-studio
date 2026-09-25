"""Tests for modules.graphic_recipes — when the IR compiler may pick a graphic
recipe (timeline / evidence_card / map_zoom), and the props sources it fills.

What is pinned here:
  * the year reader is the exact twin of video-engine/src/text.ts
    ``extractTimeline`` on samples/timeline_year_cases.json (and, when Node 22
    is available, the TS side is run against the same file);
  * each rule needs its real data, its duration bounds and its beat;
  * the per-video cap (<= 25 %) and no two graphic scenes in a row;
  * scenes that do not qualify keep exactly the recipe they had, and with the
    flag off (the default) project.json is unchanged and no sidecar is written;
  * map focus is never guessed, lower third / place only from real names;
  * nothing raises.
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import director, graphic_recipes as gr, video_ir
from modules.elements import Element
from modules.script_engine import Script, ScriptEngine, ScriptSection

ROOT = Path(__file__).resolve().parent.parent
CASES = json.loads((ROOT / "samples" / "timeline_year_cases.json").read_text("utf-8"))

TWO_YEARS = "The tower was lit in 1899 and automated in 1971."
PLAIN = "The keepers kept the lamp burning through the night."


def _scene(i, narration=PLAIN, recipe="slow_push", dur=10.0, start=None, stype="story",
           claim_ids=(), asset_ids=(), element_ids=(), name=None):
    start = i * 10.0 if start is None else start
    return {
        "id": video_ir.scene_id(i), "index": i, "name": name or f"scene_{i}", "type": stype,
        "narration": narration, "start_s": start,
        "end_s": None if dur is None else start + dur,
        "shot": {"recipe": recipe, "camera": None, "lighting": None, "mood": None},
        "element_ids": list(element_ids), "asset_ids": list(asset_ids),
        "claim_ids": list(claim_ids),
    }


def _video(n=8, overrides=None):
    """n plain 10 s scenes; overrides maps a position to _scene kwargs."""
    return [_scene(i, **(overrides or {}).get(i, {})) for i in range(n)]


def _asset(aid, kind="image", url=None, prompt=None, path=None):
    return {"id": aid, "kind": kind, "url": url, "prompt": prompt,
            "path": path or f"/m/images/{aid}.jpg"}


def _recipes(entries):
    return [e["recipe"] for e in entries]


class TimelineTwinTestCase(unittest.TestCase):
    def test_python_reader_matches_the_shared_cases(self):
        self.assertGreater(len(CASES["cases"]), 10)
        for c in CASES["cases"]:
            with self.subTest(c["name"]):
                self.assertEqual([e["date"] for e in gr.timeline_dates(c["text"])], c["dates"])
                self.assertEqual(gr.timeline_years(c["text"]), c["years"])
                self.assertEqual(len(gr.timeline_years(c["text"])) >= CASES["min_years"],
                                 c["timeline"])

    def test_threshold_is_shared(self):
        self.assertEqual(CASES["min_years"], gr.MIN_TIMELINE_YEARS)

    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_typescript_reader_matches_the_shared_cases(self):
        engine = ROOT / "video-engine"
        try:
            proc = subprocess.run(
                ["node", "--experimental-strip-types", "--no-warnings", "--test",
                 "tests/text-cases.test.mts"],
                cwd=str(engine), capture_output=True, text=True, timeout=120,
            )
        except (OSError, subprocess.TimeoutExpired) as e:  # pragma: no cover
            self.skipTest(f"node could not run ({type(e).__name__})")
        if "experimental-strip-types" in (proc.stderr or "") and "bad option" in (proc.stderr or ""):
            self.skipTest("node without --experimental-strip-types")  # pragma: no cover
        self.assertEqual(proc.returncode, 0, (proc.stdout or "")[-2000:] + (proc.stderr or "")[-1000:])

    def test_reader_never_raises(self):
        for bad in (None, 42, object(), ["1900"]):
            self.assertEqual(gr.timeline_dates(bad), [])


class FlagTestCase(unittest.TestCase):
    def test_default_off(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(gr.FLAG_ENV, None)
            self.assertFalse(gr.is_enabled())

    def test_truthy_values(self):
        for v in ("1", "true", "YES", " on "):
            self.assertTrue(gr.is_enabled(v))
        for v in ("", "0", "false", "off", "no", None):
            self.assertFalse(gr.is_enabled(v))


class TimelineRuleTestCase(unittest.TestCase):
    def test_two_years_upgrade_a_body_scene(self):
        entries = gr.select(_video(8, {2: {"narration": TWO_YEARS}}))
        self.assertEqual(entries[2]["recipe"], "timeline")
        self.assertEqual(entries[2]["recipe_before"], "slow_push")
        self.assertEqual(entries[2]["rule"], "timeline")

    def test_one_year_is_not_enough(self):
        entries = gr.select(_video(8, {2: {"narration": "In 1900 the keepers vanished."}}))
        self.assertEqual(entries[2]["recipe"], "slow_push")
        self.assertIsNone(entries[2]["rule"])

    def test_too_long_for_a_card(self):
        entries = gr.select(_video(8, {2: {"narration": TWO_YEARS, "dur": 45.0}}))
        self.assertEqual(entries[2]["recipe"], "slow_push")

    def test_unknown_duration_is_not_selected(self):
        entries = gr.select(_video(8, {2: {"narration": TWO_YEARS, "dur": None}}))
        self.assertEqual(entries[2]["recipe"], "slow_push")

    def test_hook_and_close_beats_are_left_alone(self):
        entries = gr.select(_video(8, {0: {"narration": TWO_YEARS},
                                         7: {"narration": TWO_YEARS}}))
        self.assertEqual(entries[0]["recipe"], "slow_push")
        self.assertEqual(entries[7]["recipe"], "slow_push")

    def test_an_existing_card_is_never_replaced(self):
        entries = gr.select(_video(8, {3: {"narration": TWO_YEARS, "recipe": "stat_counter"}}))
        self.assertEqual(entries[3]["recipe"], "stat_counter")
        self.assertIsNone(entries[3]["rule"])


class EvidenceRuleTestCase(unittest.TestCase):
    def _run(self, status, claim_ids=("c002-1",), row_id="c002-1"):
        scenes = _video(8, {2: {"claim_ids": claim_ids}})
        rows = {2: [{"id": row_id, "text": "The lamp was found cold.", "status": status}]}
        return gr.select(scenes, claims_by_index=rows)

    def test_definite_verdicts_upgrade(self):
        for status in ("likely_accurate", "likely_inaccurate"):
            with self.subTest(status):
                e = self._run(status)[2]
                self.assertEqual(e["recipe"], "evidence_card")
                self.assertEqual(e["claims"], [{"id": "c002-1", "text": "The lamp was found cold.",
                                                "status": status}])

    def test_unverifiable_not_checked_or_missing_do_not(self):
        for status in ("unverifiable", "not_checked", None, ""):
            with self.subTest(status):
                e = self._run(status)[2]
                self.assertEqual(e["recipe"], "slow_push")

    def test_claim_outside_the_scene_ids_does_not_count(self):
        e = self._run("likely_accurate", row_id="c009-1")[2]
        self.assertEqual(e["recipe"], "slow_push")
        self.assertIsNone(e["claims"])

    def test_no_claim_ids_no_card(self):
        e = self._run("likely_accurate", claim_ids=())[2]
        self.assertEqual(e["recipe"], "slow_push")
        self.assertIsNone(e["claims"])

    def test_missing_status_stays_missing(self):
        e = self._run(None)[2]
        self.assertIsNone(e["claims"][0]["status"])


class MapRuleTestCase(unittest.TestCase):
    MAP = _asset("a_map", url="https://www.pexels.com/photo/old-map-of-scotland-123456/")
    PHOTO = _asset("a_photo", url="https://www.pexels.com/photo/stormy-sea-99/")
    NARR = "Twenty miles off the coast of Lewis, the tower stands alone."

    def _run(self, asset_ids, narration=NARR, elements=(), element_ids=(), assets=None):
        scenes = _video(8, {3: {"narration": narration, "asset_ids": asset_ids,
                                  "element_ids": element_ids}})
        return gr.select(scenes, assets=assets or [self.MAP, self.PHOTO], elements=elements)[3]

    def test_map_image_and_place_upgrade_with_label_and_no_focus(self):
        e = self._run(["a_map"])
        self.assertEqual(e["recipe"], "map_zoom")
        self.assertEqual(e["map"], {"focus": None, "label": "Lewis"})

    def test_no_place_no_map(self):
        e = self._run(["a_map"], narration="The tower stands alone in the dark.")
        self.assertEqual(e["recipe"], "slow_push")
        self.assertIsNone(e["map"])

    def test_the_first_image_must_be_the_map(self):
        # MapScene draws the scene's first image; a map further down the list
        # would never be the picture on screen.
        self.assertEqual(self._run(["a_photo", "a_map"])["recipe"], "slow_push")
        self.assertEqual(self._run(["a_map", "a_photo"])["recipe"], "map_zoom")

    def test_a_video_before_the_map_does_not_matter(self):
        clip = _asset("a_clip", kind="video", path="/m/videos/map.mp4")
        e = self._run(["a_clip", "a_map"], assets=[clip, self.MAP])
        self.assertEqual(e["recipe"], "map_zoom")

    def test_location_element_is_a_place(self):
        el = Element(kind="location", name="Flannan Isles")
        eid = video_ir.element_id(el.kind, el.name)
        e = self._run(["a_map"], narration="The Flannan Isles sit alone.", elements=[el],
                      element_ids=[eid])
        self.assertEqual(e["map"], {"focus": None, "label": "Flannan Isles"})

    def test_two_places_are_ambiguous(self):
        e = self._run(["a_map"], narration="Off the coast of Lewis and west of the Outer Hebrides.")
        self.assertEqual(e["recipe"], "slow_push")

    def test_map_metadata_sources(self):
        self.assertTrue(gr.is_map_image(_asset("a", prompt="antique map, harbour — The Lighthouse")))
        self.assertFalse(gr.is_map_image(_asset("a", prompt="harbour — The map that lied")))
        self.assertTrue(gr.is_map_image(_asset("a", path="fixtures/public/map.svg")))
        self.assertFalse(gr.is_map_image(_asset("a", url="https://www.pexels.com/photo/mapping-a-road-1/")))
        self.assertFalse(gr.is_map_image(_asset("a", kind="video", path="/m/map.mp4")))
        self.assertFalse(gr.is_map_image(None))

    def test_places_from_text(self):
        self.assertEqual(gr.text_places("It lies west of the Outer Hebrides. North of it, nothing."),
                         ["Outer Hebrides"])
        self.assertEqual(gr.text_places("north of Scotland's capital"), [])
        self.assertEqual(gr.text_places("south of January"), [])
        self.assertEqual(gr.text_places("They sailed in the dark."), [])


class CapTestCase(unittest.TestCase):
    def test_at_most_a_quarter_and_never_adjacent(self):
        n = 12
        scenes = _video(n, {i: {"narration": TWO_YEARS} for i in range(n)})
        entries = gr.select(scenes)
        picked = [i for i, e in enumerate(entries) if e["rule"]]
        self.assertEqual(len(picked), 3)            # floor(12 * 0.25)
        for a, b in zip(picked, picked[1:]):
            self.assertGreater(b - a, 1)
        self.assertEqual(picked, [1, 3, 5])         # deterministic: scene order

    def test_short_videos_get_none(self):
        scenes = _video(3, {1: {"narration": TWO_YEARS}})
        self.assertEqual(_recipes(gr.select(scenes)), ["slow_push"] * 3)

    def test_existing_cards_count_toward_the_cap_and_adjacency(self):
        scenes = _video(8, {2: {"narration": TWO_YEARS}, 3: {"recipe": "quote_card"},
                              5: {"narration": TWO_YEARS}})
        entries = gr.select(scenes)
        self.assertEqual(entries[2]["recipe"], "slow_push")   # next to the quote card
        self.assertEqual(entries[5]["recipe"], "timeline")    # budget 2 - 1 existing = 1
        scenes[6]["shot"]["recipe"] = "stat_counter"
        self.assertEqual(_recipes(gr.select(scenes))[5], "slow_push")

    def test_priority_is_map_then_timeline_then_evidence(self):
        m = MapRuleTestCase
        scenes = _video(8, {
            1: {"narration": TWO_YEARS, "claim_ids": ["c001-1"]},
            3: {"narration": m.NARR + " " + TWO_YEARS, "asset_ids": ["a_map"]},
        })
        rows = {1: [{"id": "c001-1", "text": "x y z", "status": "likely_accurate"}]}
        entries = gr.select(scenes, assets=[m.MAP], claims_by_index=rows)
        self.assertEqual(entries[3]["rule"], "map_zoom")
        self.assertEqual(entries[1]["rule"], "timeline")

    def test_deterministic(self):
        scenes = _video(12, {i: {"narration": TWO_YEARS} for i in range(12)})
        self.assertEqual(gr.select(scenes), gr.select([dict(s) for s in scenes]))


class LowerThirdTestCase(unittest.TestCase):
    def test_exactly_one_character(self):
        moore = Element(kind="character", name="Joseph Moore")
        ducat = Element(kind="character", name="James Ducat")
        ids = lambda *els: [video_ir.element_id(e.kind, e.name) for e in els]  # noqa: E731
        one = _scene(1, element_ids=ids(moore))
        two = _scene(1, element_ids=ids(moore, ducat))
        self.assertEqual(gr.lower_third(one, [moore, ducat]), {"name": "Joseph Moore", "label": None})
        self.assertIsNone(gr.lower_third(two, [moore, ducat]))
        self.assertIsNone(gr.lower_third(_scene(1), [moore]))
        self.assertIsNone(gr.lower_third(one, []))

    def test_render_context_keys(self):
        ctx = gr.render_context({"claims": None, "map": {"focus": None, "label": "Lewis"},
                                 "lower_third": None, "recipe": "map_zoom"})
        self.assertEqual(set(ctx), {"claims", "map", "lower_third"})
        self.assertEqual(gr.render_context(None), {"claims": None, "map": None, "lower_third": None})


def _script(*sections):
    return Script(topic="The Lighthouse", title="t", title_ab="", description="", tags=[],
                  hook_sentence="", sections=list(sections), thumbnail_prompt_a="",
                  thumbnail_prompt_b="", thumbnail_overlay_text="", open_loops=[])


def _timeline(*durations_ms):
    out, t = [], 0
    for i, d in enumerate(durations_ms):
        out.append({"section": f"s{i}", "start_ms": t, "end_ms": t + d})
        t += d
    return out


class ApplyAndPipelineTestCase(unittest.TestCase):
    def _short_script(self):
        secs = [ScriptSection(name="hook", narration="Three men vanished.", duration_hint=10,
                              section_type="hook")]
        for i in range(1, 8):
            narr = TWO_YEARS if i == 2 else f"Plain part {i} of the story."
            secs.append(ScriptSection(name=f"part_{i}", narration=narr, duration_hint=10,
                                      section_type="story"))
        return _script(*secs)

    def _write(self, root, script, timeline, flag):
        env = {gr.FLAG_ENV: "1"} if flag else {}
        with mock.patch.dict(os.environ, env, clear=False):
            if not flag:
                os.environ.pop(gr.FLAG_ENV, None)
            return video_ir.write_for_run(
                slug="slug", script=script, timeline=timeline,
                shot_plans=director.plan_video(script.sections), elements=[],
                video_paths=[], image_paths=[], root=root)

    def test_flag_on_upgrades_and_writes_sidecar(self):
        script = self._short_script()
        with tempfile.TemporaryDirectory() as d:
            project = self._write(Path(d), script, _timeline(*([9_000] * 8)), flag=True)
            self.assertEqual(project.validate(), [])
            before = [p.recipe for p in director.plan_video(script.sections)]
            after = [s.shot.recipe for s in project.scenes]
            self.assertEqual(after[2], "timeline")
            for i, (b, a) in enumerate(zip(before, after)):
                if i != 2:
                    self.assertEqual(a, b, f"scene {i} changed")
            side = json.loads((Path(d) / "slug" / gr.SIDECAR_FILENAME).read_text("utf-8"))
            self.assertEqual(side["version"], 1)
            self.assertEqual(side["scenes"][2]["rule"], "timeline")
            self.assertEqual(side["scenes"][2]["recipe_before"], before[2])
            self.assertEqual(json.loads((Path(d) / "slug" / "project.json").read_text("utf-8"))
                             ["scenes"][2]["shot"]["recipe"], "timeline")

    def test_flag_off_is_exactly_as_before(self):
        script = self._short_script()
        timeline = _timeline(*([9_000] * 8))
        with tempfile.TemporaryDirectory() as d:
            project = self._write(Path(d), script, timeline, flag=False)
            expected = video_ir.build_project(slug="slug", script=script, timeline=timeline,
                                              shot_plans=director.plan_video(script.sections),
                                              elements=[], video_paths=[], image_paths=[])
            self.assertEqual(project, expected)
            self.assertFalse((Path(d) / "slug" / gr.SIDECAR_FILENAME).exists())

    def test_run_without_graphics_removes_a_stale_sidecar(self):
        """A sidecar left by an earlier flag-on run must not feed stale props
        to this run's Remotion scenes."""
        script = self._short_script()
        timeline = _timeline(*([9_000] * 8))
        with tempfile.TemporaryDirectory() as d:
            self._write(Path(d), script, timeline, flag=True)
            side = Path(d) / "slug" / gr.SIDECAR_FILENAME
            self.assertTrue(side.exists())
            self._write(Path(d), script, timeline, flag=False)
            self.assertFalse(side.exists())

    def test_demo_script_recipes_are_pinned_with_the_flag_on(self):
        """The committed demo script (25–50 s sections, as real runs have) has
        no scene that meets a rule: the flag changes nothing in project.json."""
        script = ScriptEngine.load(ROOT / "samples" / "demo_script.json")
        durations = [13_900, 26_100, 38_800, 34_250, 41_700, 35_050, 29_600][: len(script.sections)]
        timeline = _timeline(*durations)
        with tempfile.TemporaryDirectory() as d1, tempfile.TemporaryDirectory() as d2:
            on = self._write(Path(d1), script, timeline, flag=True)
            off = self._write(Path(d2), script, timeline, flag=False)
            self.assertEqual([s.shot.recipe for s in on.scenes],
                             [p.recipe for p in director.plan_video(script.sections)])
            self.assertEqual(on, off)
            self.assertEqual((Path(d1) / "slug" / "project.json").read_text("utf-8"),
                             (Path(d2) / "slug" / "project.json").read_text("utf-8"))

    def test_apply_never_raises(self):
        sentinel = object()
        with self.assertLogs("modules.graphic_recipes", level="WARNING"):
            out, entries = gr.apply(sentinel)
        self.assertIs(out, sentinel)
        self.assertEqual(entries, [])

    def test_select_tolerates_junk(self):
        self.assertEqual(gr.select([]), [])
        entries = gr.select([None, 3, {"shot": None}, {"shot": {"recipe": "nope"}}],
                            assets=[None], claims_by_index={0: "x"}, elements=[None])
        self.assertEqual(len(entries), 2)
        self.assertEqual([e["rule"] for e in entries], [None, None])


if __name__ == "__main__":
    unittest.main()
