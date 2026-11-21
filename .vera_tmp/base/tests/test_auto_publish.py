"""Auto-publish is a per-channel policy ON TOP of the gate, never a weakening
of it. These tests pin three things: the flag defaults on (so existing channels
are unaffected), it round-trips through the agent config with no migration, and
main.py actually consults it — and still consults the gate — before uploading."""

import ast
import unittest
from pathlib import Path

from modules.channels import AgentConfig, ChannelContext

MAIN = Path(__file__).resolve().parent.parent / "main.py"


class AgentConfigAutoPublishTestCase(unittest.TestCase):
    def test_defaults_on(self):
        # A channel that never opted out keeps publishing, exactly as before.
        self.assertTrue(AgentConfig().auto_publish)
        self.assertTrue(AgentConfig.from_dict({}).auto_publish)
        self.assertTrue(AgentConfig.from_dict(None).auto_publish)

    def test_explicit_false_holds(self):
        self.assertFalse(AgentConfig.from_dict({"auto_publish": False}).auto_publish)

    def test_only_explicit_false_holds(self):
        # A truthy-ish or absent value is never treated as "off" — only a real
        # False holds uploads, so a config typo can't silently stop publishing.
        self.assertTrue(AgentConfig.from_dict({"auto_publish": True}).auto_publish)
        self.assertTrue(AgentConfig.from_dict({"auto_publish": None}).auto_publish)

    def test_roundtrip(self):
        cfg = AgentConfig.from_dict({"auto_publish": False})
        self.assertIn("auto_publish", cfg.to_dict())
        self.assertFalse(AgentConfig.from_dict(cfg.to_dict()).auto_publish)

    def test_context_property_reads_agent(self):
        ctx = ChannelContext(channel_id="default", name="X", niche="history",
                             agent=AgentConfig.from_dict({"auto_publish": False}))
        self.assertFalse(ctx.auto_publish)
        self.assertTrue(ChannelContext(channel_id="default", name="X", niche="history").auto_publish)


class MainConsultsAutoPublishTestCase(unittest.TestCase):
    """Structural: the upload guard must require BOTH the gate and auto_publish,
    and a held-for-review path must emit publish.held. Parsed, not imported, so
    this runs without MoviePy."""

    def setUp(self):
        self.tree = ast.parse(MAIN.read_text())
        self.names = {n.id for n in ast.walk(self.tree) if isinstance(n, ast.Name)}

    def test_auto_publish_is_referenced(self):
        self.assertIn("auto_publish", self.names)

    def test_upload_guard_requires_gate_and_auto_publish(self):
        # Find a BoolOp (an `and`) whose operands include both `auto_publish` and
        # a `gate.allowed` attribute access — the upload condition.
        found = False
        for node in ast.walk(self.tree):
            if not isinstance(node, ast.BoolOp) or not isinstance(node.op, ast.And):
                continue
            names = {v.id for v in ast.walk(node) if isinstance(v, ast.Name)}
            attrs = {a.attr for a in ast.walk(node) if isinstance(a, ast.Attribute)}
            if "auto_publish" in names and "allowed" in attrs:
                found = True
                break
        self.assertTrue(found, "upload must be guarded by BOTH gate.allowed AND auto_publish")

    def test_publish_held_event_is_emitted(self):
        attrs = {a.attr for a in ast.walk(self.tree) if isinstance(a, ast.Attribute)}
        self.assertIn("PUBLISH_HELD", attrs)


if __name__ == "__main__":
    unittest.main()
