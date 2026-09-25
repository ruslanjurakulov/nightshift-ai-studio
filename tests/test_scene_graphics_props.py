"""graphic_recipes' scene_graphics.json → Remotion scene props.

Pinned: the sidecar is read next to project.json; a Remotion job carries its
scene's claims/map/lower_third and is keyed by them; ffmpeg jobs (and every
scene without props data) keep exactly the keys they had before; the adapter
hands the props to Remotion; a stale sidecar is removed when a run selects no
graphics; a missing/corrupt sidecar means no props, never an error."""

import json
import tempfile
import unittest
from pathlib import Path

from modules import graphic_recipes, scene_remotion, scene_render
from tests.test_scene_remotion import BOTH, Renderer, _project, fake_assemble

CLAIMS = [{"id": "c1", "text": "It opened in 1869.", "status": "likely_accurate"}]
ENTRY = {"scene_id": "s001", "recipe": "evidence_card", "rule": "evidence_card",
         "claims": CLAIMS, "map": None, "lower_third": {"name": "Lesseps", "label": None}}


def _write_sidecar(dirpath: Path, entries) -> Path:
    return graphic_recipes.write_sidecar(entries, dirpath / graphic_recipes.SIDECAR_FILENAME)


class _Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()


class SidecarTestCase(_Tmp):
    def test_round_trip_by_scene_id(self):
        path = _write_sidecar(self.root, [ENTRY, {"scene_id": "s000", "claims": None}])
        loaded = graphic_recipes.load_sidecar(path)
        self.assertEqual(sorted(loaded), ["s000", "s001"])
        self.assertEqual(graphic_recipes.render_context(loaded["s001"]),
                         {"claims": CLAIMS, "map": None, "lower_third": ENTRY["lower_third"]})

    def test_missing_corrupt_or_other_version_is_empty(self):
        self.assertEqual(graphic_recipes.load_sidecar(self.root / "nope.json"), {})
        bad = self.root / "bad.json"
        bad.write_text("{not json")
        self.assertEqual(graphic_recipes.load_sidecar(bad), {})
        bad.write_text(json.dumps({"version": 999, "scenes": [ENTRY]}))
        self.assertEqual(graphic_recipes.load_sidecar(bad), {})

    def test_has_props(self):
        self.assertFalse(graphic_recipes.has_props(None))
        self.assertFalse(graphic_recipes.has_props(graphic_recipes.render_context({})))
        self.assertTrue(graphic_recipes.has_props(graphic_recipes.render_context(ENTRY)))

    def test_remove_sidecar_is_best_effort(self):
        path = _write_sidecar(self.root, [ENTRY])
        graphic_recipes.remove_sidecar(path)
        self.assertFalse(path.exists())
        graphic_recipes.remove_sidecar(path)  # already gone: no error


class PlanJobsTestCase(_Tmp):
    def test_remotion_job_carries_and_is_keyed_by_props_ffmpeg_unchanged(self):
        p = _project(self.root)
        plain = scene_render.plan_jobs(p, self.root / "scenes", available=BOTH)
        with_g = scene_render.plan_jobs(p, self.root / "scenes", available=BOTH,
                                        graphics={"s001": ENTRY})
        # s001 is the Remotion quote_card scene.
        self.assertEqual(with_g[1].backend, "remotion")
        self.assertEqual(with_g[1].graphics["claims"], CLAIMS)
        self.assertNotEqual(with_g[1].key, plain[1].key)
        # Its ffmpeg fallback and the ffmpeg scenes keep their keys and carry nothing.
        self.assertEqual(with_g[1].fallback.key, plain[1].fallback.key)
        self.assertIsNone(with_g[1].fallback.graphics)
        self.assertEqual([j.key for j in (with_g[0], with_g[2])], [plain[0].key, plain[2].key])

    def test_entry_without_props_leaves_the_key_alone(self):
        p = _project(self.root)
        plain = scene_render.plan_jobs(p, self.root / "scenes", available=BOTH)
        empty = scene_render.plan_jobs(p, self.root / "scenes", available=BOTH,
                                       graphics={"s001": {"scene_id": "s001", "claims": None}})
        self.assertEqual([j.key for j in empty], [j.key for j in plain])
        self.assertIsNone(empty[1].graphics)


class RenderProjectTestCase(_Tmp):
    def test_sidecar_next_to_the_output_reaches_the_remotion_job(self):
        out = self.root / "out" / "final_video.mp4"
        out.parent.mkdir()
        _write_sidecar(out.parent, [ENTRY])
        seen = {}

        class Capture(Renderer):
            def __call__(self, job, project, out_path):
                seen[job.scene_id] = job.graphics
                return super().__call__(job, project, out_path)

        scene_render.render_project(_project(self.root), out, assemble_fn=fake_assemble,
                                    renderers={"ffmpeg": Renderer("ffmpeg"),
                                               "remotion": Capture("remotion")})
        self.assertEqual(seen, {"s001": {"claims": CLAIMS, "map": None,
                                         "lower_third": ENTRY["lower_third"]}})


class AdapterContextTestCase(_Tmp):
    def test_props_are_passed_to_remotion(self):
        p = _project(self.root)
        job = scene_render.plan_jobs(p, self.root / "scenes", available=BOTH,
                                     graphics={"s001": ENTRY})[1]
        captured = {}

        def fake_render(scene_dict, context, out):
            captured.update(context)
            return None  # stop here: "no video" is fine for this test

        with self.assertRaises(scene_remotion.SceneRemotionError):
            scene_remotion.render_scene(job, p, self.root / "x.mp4", ffmpeg="ffmpeg",
                                        remotion_render=fake_render)
        self.assertEqual(captured["claims"], CLAIMS)
        self.assertEqual(captured["lower_third"], ENTRY["lower_third"])
        self.assertIsNone(captured["map"])


if __name__ == "__main__":
    unittest.main()
