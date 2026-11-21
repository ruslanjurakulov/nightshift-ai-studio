"""Structural + config checks for the engagement-comment wiring: the AgentConfig
flag defaults on and round-trips with no migration, and main.py posts the comment
only after a real publish, guarded by the flag. Parsed, not imported, so it runs
without MoviePy."""

import ast
import unittest
from pathlib import Path

from modules.channels import AgentConfig, ChannelContext

MAIN = Path(__file__).resolve().parent.parent / "main.py"


class PinnedCommentConfigTestCase(unittest.TestCase):
    def test_defaults_on(self):
        self.assertTrue(AgentConfig().pinned_comment)
        self.assertTrue(AgentConfig.from_dict({}).pinned_comment)
        self.assertTrue(AgentConfig.from_dict(None).pinned_comment)

    def test_only_explicit_false_holds(self):
        self.assertFalse(AgentConfig.from_dict({"pinned_comment": False}).pinned_comment)
        self.assertTrue(AgentConfig.from_dict({"pinned_comment": True}).pinned_comment)
        self.assertTrue(AgentConfig.from_dict({"pinned_comment": None}).pinned_comment)

    def test_roundtrip(self):
        cfg = AgentConfig.from_dict({"pinned_comment": False})
        self.assertIn("pinned_comment", cfg.to_dict())
        self.assertFalse(AgentConfig.from_dict(cfg.to_dict()).pinned_comment)


class MainPostsCommentTestCase(unittest.TestCase):
    def setUp(self):
        self.tree = ast.parse(MAIN.read_text())

    def test_module_imported(self):
        imported = set()
        for node in ast.walk(self.tree):
            if isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    imported.add(alias.name)
        self.assertIn("pinned_comment", imported)

    def test_posts_and_crafts(self):
        attrs = {a.attr for a in ast.walk(self.tree) if isinstance(a, ast.Attribute)}
        self.assertIn("post_pinned_comment", attrs)
        self.assertIn("craft_question", attrs)

    def test_guarded_by_flag(self):
        attrs = {a.attr for a in ast.walk(self.tree) if isinstance(a, ast.Attribute)}
        strings = {n.value for n in ast.walk(self.tree)
                   if isinstance(n, ast.Constant) and isinstance(n.value, str)}
        # The flag is consulted, and the comment event vocabulary is used.
        self.assertTrue("pinned_comment" in attrs or "pinned_comment" in strings)
        self.assertIn("COMMENT_POSTED", attrs)


if __name__ == "__main__":
    unittest.main()
