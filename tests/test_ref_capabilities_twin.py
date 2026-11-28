"""The web's copy of which capabilities take reference pictures must be the adapters' own.

What would break without this: the character-sheet gate (command-center/lib/brain/ref-sheets.ts)
opening for a key-frame model whose adapter sends no references on t2i (the worker then refuses
the take after the film's credits were held), or staying shut for one that takes them.
"""
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class RefCapabilitiesTwin(unittest.TestCase):
    def test_the_web_copy_matches_the_adapters(self):
        # A fresh interpreter, so the check reads the adapters as shipped, never as a test earlier in the
        # same run may have patched modules.capabilities.ADAPTERS. A registry row added on main without
        # regenerating the copy fails here (it did once, on the merge that brought google-lyria-3.5).
        r = subprocess.run([sys.executable, str(ROOT / "tools" / "ref_capabilities_twin.py"), "--check"],
                           capture_output=True, text=True, cwd=str(ROOT))
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_the_file_is_not_hidden_by_the_json_ignore_rule(self):
        r = subprocess.run(["git", "check-ignore", "-q", "command-center/lib/brain/ref-capabilities.json"], cwd=str(ROOT))
        self.assertNotEqual(r.returncode, 0, "the blanket *.json rule hides the twin: the build would ship no gate facts")

    def test_the_facts_the_gate_rests_on_today(self):
        models = json.loads((ROOT / "command-center" / "lib" / "brain" / "ref-capabilities.json").read_text())["models"]
        # OpenAI's /images/generations takes no references: its key frames cannot be steered by a sheet.
        self.assertEqual(models["openai-gpt-image-2.6-sunburst"], ["edit"])
        self.assertEqual(models["openai-gpt-image-2.6-flare"], ["edit"])
        # Gemini sends references inline in the same generate call (S10's probe rows 79 and 80).
        self.assertEqual(models["gemini-3-pro-image"], ["edit", "t2i"])
        self.assertEqual(models["gemini-nano-banana-2.1"], ["edit", "t2i"])


if __name__ == "__main__":
    unittest.main()
