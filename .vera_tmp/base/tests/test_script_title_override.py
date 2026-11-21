"""The script engine, given a pre-decided working_title, must ship the video
under that exact title (title-first packaging) and thread the title into the
prompt so the script is written to deliver it — while leaving the no-title path
byte-for-byte unchanged."""

import unittest
from unittest.mock import MagicMock, patch

from modules.script_engine import ScriptEngine

_PAYLOAD_NO_ALT = (
    '{"title": "Model Chose This", "title_ab": "", "description": "D", "tags": [], '
    '"hook_sentence": "H", "thumbnail_prompt_a": "A", "thumbnail_prompt_b": "B", '
    '"thumbnail_overlay_text": "O", "open_loops": [], "sections": []}'
)
_PAYLOAD_WITH_ALT = (
    '{"title": "Model Chose This", "title_ab": "Model Alt", "description": "D", "tags": [], '
    '"hook_sentence": "H", "thumbnail_prompt_a": "A", "thumbnail_prompt_b": "B", '
    '"thumbnail_overlay_text": "O", "open_loops": [], "sections": []}'
)


def _resp(text):
    r = MagicMock()
    r.text = text
    return r


class WorkingTitleOverrideTestCase(unittest.TestCase):
    def _generate(self, payload, working_title):
        fake_pa = MagicMock()
        fake_pa.analyze_videos_as_prompt_text.return_value = ""
        with patch("modules.script_engine.make_client", return_value=MagicMock()), \
             patch("modules.script_engine.PerformanceAnalyzer", return_value=fake_pa), \
             patch("modules.script_engine.generate_with_retry", return_value=_resp(payload)) as gen:
            engine = ScriptEngine()
            script = engine.generate("Some Topic", working_title=working_title)
        return script, gen

    def test_planned_title_ships_and_prompt_carries_it(self):
        script, gen = self._generate(_PAYLOAD_NO_ALT, "Planned Winner")
        # The video ships under the planned title, not the model's.
        self.assertEqual(script.title, "Planned Winner")
        # The model's own title is kept as the A/B alternative (it was empty).
        self.assertEqual(script.title_ab, "Model Chose This")
        # The prompt handed to Gemini instructs it to deliver the planned title.
        prompt = gen.call_args[0][2]
        self.assertIn("Planned Winner", prompt)
        self.assertIn("Pre-decided title", prompt)

    def test_existing_model_alt_is_not_overwritten(self):
        script, _ = self._generate(_PAYLOAD_WITH_ALT, "Planned Winner")
        self.assertEqual(script.title, "Planned Winner")
        self.assertEqual(script.title_ab, "Model Alt")  # the model's real B arm stays

    def test_no_working_title_leaves_behaviour_unchanged(self):
        fake_pa = MagicMock()
        fake_pa.analyze_videos_as_prompt_text.return_value = ""
        with patch("modules.script_engine.make_client", return_value=MagicMock()), \
             patch("modules.script_engine.PerformanceAnalyzer", return_value=fake_pa), \
             patch("modules.script_engine.generate_with_retry", return_value=_resp(_PAYLOAD_NO_ALT)) as gen:
            engine = ScriptEngine()
            script = engine.generate("Some Topic")
        self.assertEqual(script.title, "Model Chose This")  # model's title, as before
        self.assertNotIn("Pre-decided title", gen.call_args[0][2])


if __name__ == "__main__":
    unittest.main()
