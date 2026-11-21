"""Roadmap #60 wiring: the alternate opening survives script parse/round-trip,
and hook_variant persists on a video row. The selection maths live in
tests/test_hook_ab.py; this covers the plumbing that makes it end-to-end."""

import tempfile
import unittest
from pathlib import Path

from modules.script_engine import ScriptEngine, Script
from modules.state_store import StateStore


SCRIPT_JSON = {
    "title": "The Fall of Rome",
    "title_ab": "Why Rome REALLY Fell",
    "hook_ab": "[MUSIC:intro] Everyone blames the barbarians. [PAUSE:1.0] They are wrong.",
    "description": "d",
    "tags": ["rome"],
    "hook_sentence": "Rome did not fall in a day.",
    "thumbnail_overlay_text": "IT WAS A LIE",
    "open_loops": ["who really did it?"],
    "sections": [
        {"name": "hook", "type": "hook", "narration": "The original opening.", "keywords": ["rome"]},
        {"name": "story", "type": "story", "narration": "The body.", "keywords": ["ruins"]},
    ],
}


class HookAbScriptTestCase(unittest.TestCase):
    def test_parse_reads_hook_ab(self):
        script = ScriptEngine._parse("The Fall of Rome", SCRIPT_JSON)
        self.assertEqual(script.hook_ab, "[MUSIC:intro] Everyone blames the barbarians. [PAUSE:1.0] They are wrong.")

    def test_missing_hook_ab_defaults_empty(self):
        data = dict(SCRIPT_JSON)
        data.pop("hook_ab")
        script = ScriptEngine._parse("t", data)
        self.assertEqual(script.hook_ab, "")

    def test_roundtrip_through_dict_and_save(self):
        script = ScriptEngine._parse("The Fall of Rome", SCRIPT_JSON)
        self.assertIn("hook_ab", script.to_dict())
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "script.json"
            script.save(path)
            reloaded = ScriptEngine.load(path)
            self.assertEqual(reloaded.hook_ab, script.hook_ab)


class HookVariantPersistenceTestCase(unittest.TestCase):
    def test_hook_variant_persists_on_video_row(self):
        with tempfile.TemporaryDirectory() as d:
            store = StateStore(Path(d) / "s.db")
            store.record_video(video_id="v1", title="T", published_at="2026-01-01T00:00:00", hook_variant="B")
            row = store.get_video("v1")
            self.assertEqual(row["hook_variant"], "B")
            store.close()

    def test_hook_variant_defaults_empty_for_existing_callers(self):
        with tempfile.TemporaryDirectory() as d:
            store = StateStore(Path(d) / "s.db")
            store.record_video(video_id="v2", title="T", published_at="2026-01-01T00:00:00")
            row = store.get_video("v2")
            # Column present, empty — an existing caller that doesn't set it is
            # simply not part of the hook experiment (excluded, never "A").
            self.assertIn("hook_variant", row)
            self.assertIn(row["hook_variant"], ("", None))
            store.close()


if __name__ == "__main__":
    unittest.main()
