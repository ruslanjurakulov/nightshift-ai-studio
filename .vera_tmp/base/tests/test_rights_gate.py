"""Roadmap PR 4.2 — the rights check in the pre-publish gate.

Reads the run's Video IR: a USED asset with rights "blocked" blocks; "unknown"
warns (and blocks only when the channel opts in); no IR is recorded as not run;
a crashing check warns and never blocks.
"""

import ast
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from modules import publish_gate
from modules.video_ir import AssetRef, Rights, Scene, VideoProject


def gate_script():
    return SimpleNamespace(
        topic="A Real Topic",
        title="A Perfectly Ordinary Title",
        description="A description.",
        sections=[SimpleNamespace(narration="Something happens."),
                  SimpleNamespace(narration="Then something else does.")],
    )


class NoDuplicates:
    def check(self, topic):
        return SimpleNamespace(is_duplicate=False, needs_review=False)


def asset(aid, status):
    return AssetRef(id=aid, kind="video", path=f"/runner/secret/{aid}.mp4",
                    rights=Rights(status=status))


def project(assets, scene_assets):
    """`scene_assets` maps scene index -> tuple of asset ids."""
    scenes = tuple(Scene(id=f"s{i:03d}", index=i, asset_ids=tuple(ids))
                   for i, ids in scene_assets.items())
    return VideoProject(slug="demo", scenes=scenes, assets=tuple(assets))


class RightsGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.video = Path(self.tmp.name) / "final_video.mp4"
        self.video.write_bytes(b"0" * 200_000)

    def evaluate(self, ir, gate=None):
        return publish_gate.evaluate(
            script=gate_script(),
            video_path=self.video,
            fact_results=[],
            channel=SimpleNamespace(agent=SimpleNamespace(publish_gate=gate or {})),
            originality=NoDuplicates(),
            qc_report=SimpleNamespace(blocks=[], warnings=[]),
            ir_project=ir,
        )

    def test_all_ok_passes_cleanly(self):
        ir = project([asset("a1", "ok"), asset("a2", "ok")], {0: ("a1",), 1: ("a2",)})
        d = self.evaluate(ir)
        self.assertTrue(d.allowed)
        self.assertIn("rights", d.checks_run)
        self.assertFalse([w for w in d.warnings if w.startswith("rights")])

    def test_a_blocked_used_asset_blocks(self):
        ir = project([asset("a1", "ok"), asset("a2", "blocked")],
                     {0: ("a1",), 1: ("a2",), 2: ("a2",)})
        d = self.evaluate(ir)
        self.assertFalse(d.allowed)
        self.assertIn("rights_blocked:1:s001,s002", d.blocks)

    def test_a_blocked_but_unused_asset_is_ignored(self):
        ir = project([asset("a1", "ok"), asset("a2", "blocked")], {0: ("a1",), 1: ("a1",)})
        d = self.evaluate(ir)
        self.assertTrue(d.allowed)
        self.assertFalse([r for r in d.blocks + d.warnings if r.startswith("rights_")])
        self.assertEqual(d.rights["blocked"], 0)
        self.assertEqual(d.rights["assets_used"], 1)

    def test_turning_off_block_on_rights_downgrades_to_a_warning(self):
        ir = project([asset("a2", "blocked")], {0: ("a2",)})
        d = self.evaluate(ir, gate={"block_on_rights": False})
        self.assertTrue(d.allowed)
        self.assertIn("rights_blocked:1:s000", d.warnings)

    def test_only_an_explicit_false_turns_block_on_rights_off(self):
        ir = project([asset("a2", "blocked")], {0: ("a2",)})
        for value in (None, "false", 0):
            d = self.evaluate(ir, gate={"block_on_rights": value})
            self.assertFalse(d.allowed, value)

    def test_unknown_warns_with_count_and_scene_ids(self):
        ir = project([asset("a1", "unknown"), asset("a2", "unknown"), asset("a3", "ok")],
                     {0: ("a1",), 1: ("a3",), 2: ("a2", "a1")})
        d = self.evaluate(ir)
        self.assertTrue(d.allowed)
        self.assertIn("rights_unknown:2:s000,s002", d.warnings)

    def test_unknown_blocks_only_with_the_opt_in_flag(self):
        ir = project([asset("a1", "unknown")], {0: ("a1",)})
        d = self.evaluate(ir, gate={"block_on_unknown_rights": True})
        self.assertFalse(d.allowed)
        self.assertIn("rights_unknown:1:s000", d.blocks)
        # Anything short of an explicit true leaves it a warning.
        for value in ("true", 1, None, False):
            d = self.evaluate(ir, gate={"block_on_unknown_rights": value})
            self.assertTrue(d.allowed, value)
            self.assertIn("rights_unknown:1:s000", d.warnings)

    def test_default_config_does_not_block_on_unknown(self):
        self.assertFalse(publish_gate.GateConfig().block_on_unknown_rights)
        self.assertFalse(publish_gate.GateConfig.from_channel(None).block_on_unknown_rights)
        self.assertTrue(publish_gate.GateConfig.from_channel(None).block_on_rights)

    def test_unrecorded_or_odd_status_counts_as_unknown_not_ok(self):
        ir = project([asset("a1", "maybe")], {0: ("a1", "a_missing")})
        d = self.evaluate(ir)
        self.assertEqual(d.rights["unknown"], 2)
        self.assertEqual(d.rights["ok"], 0)
        self.assertIn("rights_unknown:2:s000", d.warnings)

    def test_many_scene_ids_are_capped_in_the_reason(self):
        n = publish_gate.MAX_REASON_SCENE_IDS + 3
        ir = project([asset("a1", "unknown")], {i: ("a1",) for i in range(n)})
        d = self.evaluate(ir)
        reason = [w for w in d.warnings if w.startswith("rights_unknown")][0]
        self.assertTrue(reason.endswith(",+3"), reason)
        self.assertEqual(len(d.rights["unknown_scene_ids"]), n)

    def test_a_manifest_dict_is_read_the_same_way(self):
        ir = project([asset("a2", "blocked")], {0: ("a2",)}).to_dict()
        d = self.evaluate(ir)
        self.assertIn("rights_blocked:1:s000", d.blocks)

    def test_a_missing_project_warns_and_never_blocks(self):
        d = self.evaluate(None, gate={"block_on_unknown_rights": True})
        self.assertTrue(d.allowed)
        self.assertIn("rights_check_not_run", d.warnings)
        self.assertNotIn("rights", d.checks_run)
        self.assertNotIn("rights", d.to_metadata())

    def test_a_crashing_check_warns_and_never_blocks(self):
        class Broken:
            @property
            def assets(self):
                raise ValueError("bad")

        d = self.evaluate(Broken(), gate={"block_on_unknown_rights": True})
        self.assertTrue(d.allowed)
        self.assertIn("rights_check_errored:ValueError", d.warnings)
        self.assertIsNone(d.rights)

    def test_a_disabled_gate_skips_the_rights_check(self):
        ir = project([asset("a2", "blocked")], {0: ("a2",)})
        d = self.evaluate(ir, gate={"enabled": False})
        self.assertTrue(d.allowed)
        self.assertEqual(d.warnings, ["gate_disabled_for_channel"])

    def test_metadata_shape_and_no_local_paths(self):
        ir = project([asset("a1", "ok"), asset("a2", "blocked"), asset("a3", "unknown"),
                      asset("a4", "blocked")],
                     {0: ("a1",), 1: ("a2",), 2: ("a3",)})
        meta = self.evaluate(ir).to_metadata()
        self.assertEqual(meta["rights"], {
            "assets_used": 3,
            "ok": 1,
            "unknown": 1,
            "blocked": 1,
            "blocked_scene_ids": ["s001"],
            "unknown_scene_ids": ["s002"],
            "blocked_asset_ids": ["a2"],
            "block_on_unknown": False,
        })
        self.assertFalse(meta["allowed"])
        self.assertNotIn("/runner/secret", json.dumps(meta))

    def test_no_assets_is_measured_zero_not_missing(self):
        d = self.evaluate(project([], {0: ()}))
        self.assertTrue(d.allowed)
        self.assertEqual(d.rights["assets_used"], 0)
        self.assertNotIn("rights_check_not_run", d.warnings)


class MainWiringTests(unittest.TestCase):
    def test_main_passes_the_ir_project_into_the_gate(self):
        tree = ast.parse(Path(__file__).resolve().parents[1].joinpath("main.py").read_text())
        calls = [n for n in ast.walk(tree)
                 if isinstance(n, ast.Call) and ast.unparse(n.func) == "publish_gate.evaluate"]
        self.assertTrue(calls)
        for call in calls:
            kw = {k.arg: ast.unparse(k.value) for k in call.keywords}
            self.assertEqual(kw.get("ir_project"), "ir_project")


if __name__ == "__main__":
    unittest.main()
