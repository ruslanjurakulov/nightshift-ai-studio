"""inputs.prompt_required: the registry says which tools a model needs words for, and agrees with its adapter.

The failure this pins (live E2E, 2026-11-20): on the Studio canvas an Image -> Video node with MiniMax H3 offered "The shot
· optional"; pressed empty, the job was created and failed two seconds later with "These settings were not accepted"
(the adapter refuses image-to-video without words). The Studio reads inputs.prompt_required from the model's spec to make
the words required before the price is even asked, so the requirement must be in the registry for every model whose
adapter has it, and may name only capabilities the model sells.
"""
import copy
import json
import unittest

from modules import model_registry
from modules.capabilities.minimax import MiniMaxH3Adapter


class PromptRequiredRegistryTest(unittest.TestCase):
    def test_every_minimax_h3_entry_requires_words_for_both_modes(self):
        entries = [e for e in model_registry.registry().values() if e.raw.get("adapter") == "video.minimax_h3"]
        self.assertTrue(entries)
        for e in entries:
            self.assertEqual(sorted(e.raw["inputs"]["prompt_required"]), ["i2v", "t2v"], e.id)

    def test_the_adapter_and_the_registry_agree(self):
        self.assertEqual(set(MiniMaxH3Adapter.prompt_required_capabilities), {"t2v", "i2v"})

    def _errors_for(self, mutate):
        raw = json.loads(model_registry.REGISTRY_PATH.read_text(encoding="utf-8"))
        models = raw["models"] if isinstance(raw, dict) else raw
        entry = copy.deepcopy(next(m for m in models if m["id"] == "minimax-h3"))
        mutate(entry)
        return model_registry._cross_errors([entry])

    def test_validation_refuses_a_missing_or_foreign_requirement(self):
        missing = self._errors_for(lambda m: m["inputs"].pop("prompt_required"))
        self.assertTrue(any("prompt_required" in e for e in missing), missing)
        foreign = self._errors_for(lambda m: m["inputs"].update(prompt_required=["t2v", "i2v", "tts"]))
        self.assertTrue(any("prompt_required" in e for e in foreign), foreign)


if __name__ == "__main__":
    unittest.main()
