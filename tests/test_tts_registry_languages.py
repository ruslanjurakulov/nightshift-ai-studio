"""Every voice model in the registry lists the languages it speaks, and the list is the one modules/tts_languages holds.

Why: the film quote refuses an Uzbek film read by a model that does not speak Uzbek before the hold (migration 0214 reads
model_registry.spec -> 'languages'), and the Brain proposes only a voice model whose list holds the film's language (S6 gaps G1,
G2). The run's own preflight and the TTS adapter read modules/tts_languages.MODEL_LANGUAGES. If the two lists drifted, the quote
would price a film the take then refuses (after the clips were paid), or refuse one the take would read. A vendor model the
table does not know is "unknown", never "speaks", so a registry entry pointing at one fails here instead of being guessed.

No network, no database, no key.
"""

from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from modules import model_registry as reg
from modules import tts_languages as tl
from modules.capabilities.base import TTS

DOC = json.loads(Path(reg.REGISTRY_PATH).read_text(encoding="utf-8"))
TTS_ENTRIES = [m for m in DOC["models"] if TTS in m["capabilities"]]


def _vendor_models(m: dict) -> list:
    by_cap = (m.get("vendor_model_by_capability") or {}).get(TTS)
    return [by_cap or m["vendor_model"]]


class EveryVoiceModelListsWhatItSpeaks(unittest.TestCase):
    def test_there_are_voice_models_to_check(self):
        ids = {m["id"] for m in TTS_ENTRIES}
        self.assertTrue({"elevenlabs-v4", "elevenlabs-v3", "elevenlabs-multilingual-v2", "elevenlabs-flash-v2.5"} <= ids)

    def test_each_vendor_model_is_in_the_verified_table(self):
        for m in TTS_ENTRIES:
            for vm in _vendor_models(m):
                self.assertIn(vm, tl.MODEL_LANGUAGES,
                              f"{m['id']} reads with {vm}, which tts_languages does not know: unknown is not 'speaks'")

    def test_each_list_equals_the_table_for_its_vendor_model(self):
        for m in TTS_ENTRIES:
            for vm in _vendor_models(m):
                self.assertEqual(tuple(m.get("languages") or ()), tl.MODEL_LANGUAGES.get(vm), m["id"])

    def test_the_loaded_entries_carry_the_list(self):
        """sync_rows copies spec from the loaded entry, so the list must survive loading."""
        for m in TTS_ENTRIES:
            self.assertEqual(reg.get(m["id"]).languages, tuple(m["languages"]), m["id"])

    def test_only_v4_and_v3_speak_uzbek(self):
        speaks_uz = sorted(m["id"] for m in TTS_ENTRIES if "uz" in m["languages"])
        self.assertEqual(speaks_uz, ["elevenlabs-v3", "elevenlabs-v4"])

    def test_the_list_reaches_the_synced_spec(self):
        """0214 reads spec -> 'languages': a sync that dropped it would make every voice model 'unknown'."""
        rows = {r["id"]: r for r in reg.sync_rows(list(reg.registry().values()))}
        for m in TTS_ENTRIES:
            self.assertEqual(rows[m["id"]]["spec"].get("languages"), m["languages"], m["id"])


class TheValidatorHoldsIt(unittest.TestCase):
    def test_the_shipped_registry_is_valid(self):
        self.assertEqual(reg.validate(DOC), [])

    def test_a_voice_model_without_its_languages_is_refused(self):
        doc = copy.deepcopy(DOC)
        for m in doc["models"]:
            if m["id"] == "elevenlabs-multilingual-v2":
                del m["languages"]
        self.assertTrue(any("elevenlabs-multilingual-v2" in p and "languages is required" in p for p in reg.validate(doc)))

    def test_languages_on_a_model_that_neither_speaks_dubs_nor_transcribes_is_refused(self):
        doc = copy.deepcopy(DOC)
        other = next(m for m in doc["models"]
                     if not {TTS, "dub", "captions"} & set(m["capabilities"]))
        other["languages"] = ["en"]
        self.assertTrue(any(other["id"] in p and "languages is required" in p for p in reg.validate(doc)))


if __name__ == "__main__":
    unittest.main()
