"""D10: the worker image installs pinned SDKs and has the Whisper model baked in."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PINNED = ("elevenlabs", "google-genai", "edge-tts", "openai-whisper")


def pins():
    out = {}
    for raw in (ROOT / "constraints.txt").read_text().splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            m = re.fullmatch(r"([A-Za-z0-9_.\-]+)==([A-Za-z0-9_.\-]+)", line)
            assert m, f"constraints.txt line is not an exact pin: {line!r}"
            out[m.group(1).lower()] = m.group(2)
    return out


class WorkerImagePins(unittest.TestCase):
    def test_the_four_sdks_are_pinned_exactly(self):
        self.assertEqual(sorted(pins()), sorted(PINNED))

    def test_every_pin_is_one_requirements_txt_also_names(self):
        names = {m.group(1).lower() for m in re.finditer(r"^([A-Za-z0-9_.\-]+)", (ROOT / "requirements.txt").read_text(), re.M)}
        for name in pins():
            self.assertIn(name, names)

    def test_pins_satisfy_the_floors_in_requirements_txt(self):
        def v(s):
            return tuple(int(x) for x in re.findall(r"\d+", s)[:3])
        for line in (ROOT / "requirements.txt").read_text().splitlines():
            m = re.match(r"^([A-Za-z0-9_.\-]+)>=([0-9][^,;\s]*)", line)
            if m and m.group(1).lower() in pins():
                self.assertGreaterEqual(v(pins()[m.group(1).lower()]), v(m.group(2)))

    def test_dockerfile_installs_with_the_constraints_file(self):
        text = (ROOT / "Dockerfile.worker").read_text()
        self.assertRegex(text, r"COPY requirements\.txt constraints\.txt")
        self.assertIn("pip install -c constraints.txt -r requirements.txt", text)

    def test_whisper_base_is_downloaded_at_build_time_before_the_code_copy(self):
        text = (ROOT / "Dockerfile.worker").read_text()
        preload = text.index("whisper.load_model('base')")
        self.assertLess(text.index("pip install -c constraints.txt"), preload)
        self.assertLess(preload, re.search(r"^COPY \. \.", text, re.M).start())
        self.assertIn("/home/nightshift/.cache/whisper", text)
        # the model name the pipeline loads is the one baked in
        from modules import subtitle_generator  # noqa: PLC0415
        self.assertEqual(subtitle_generator.WHISPER_MODEL, "base")

    def test_constraints_change_triggers_a_deploy(self):
        self.assertIn('- "constraints.txt"', (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text())


if __name__ == "__main__":
    unittest.main()
