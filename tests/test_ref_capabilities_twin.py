"""The web's copy of which capabilities take reference pictures must be the adapters' own.

What would break without this: the character-sheet gate (command-center/lib/brain/ref-sheets.ts)
opening for a key-frame model whose adapter sends no references on t2i (the worker then refuses
the take after the film's credits were held), or staying shut for one that takes them.
"""
import json
import unittest
from pathlib import Path

from tools import ref_capabilities_twin as twin

ROOT = Path(__file__).resolve().parent.parent


class RefCapabilitiesTwin(unittest.TestCase):
    def test_the_web_copy_matches_the_adapters(self):
        current = (ROOT / "command-center" / "lib" / "brain" / "ref-capabilities.json").read_text(encoding="utf-8")
        self.assertEqual(current, twin.render(twin.build()), "run python tools/ref_capabilities_twin.py")

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
