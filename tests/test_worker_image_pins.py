"""D10: the worker image installs pinned SDKs and a pinned ffmpeg binary, and has the Whisper model baked in."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# imageio-ffmpeg is the ffmpeg binary itself (see constraints.txt): a new release changes what every render and decode runs.
PINNED = ("elevenlabs", "google-genai", "edge-tts", "openai-whisper", "imageio-ffmpeg")


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
    def test_the_pinned_packages_are_exactly_these(self):
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
        # the pipeline worker's default cache links to the one baked copy instead of a second 139 MB file
        self.assertIn("ln -s /opt/whisper-cache/whisper/base.pt /home/nightshift/.cache/whisper/base.pt", text)
        # the model name the pipeline loads is the one baked in
        from modules import subtitle_generator  # noqa: PLC0415
        self.assertEqual(subtitle_generator.WHISPER_MODEL, "base")

    def test_the_image_names_a_read_only_whisper_folder_the_film_assembly_reads(self):
        # S4_GAPS G1: the film-worker (uid 1000, HOME=/tmp) found no model in Whisper's default cache and downloaded
        # 139 MB into its tmpfs per start. The baked folder must stay where it was downloaded, readable by every uid,
        # and be named by the image itself so every service started from it inherits the name.
        from modules import film_assembly  # noqa: PLC0415
        text = (ROOT / "Dockerfile.worker").read_text()
        env = re.search(r"^ENV " + re.escape(film_assembly.WHISPER_DIR_ENV) + r"=(\S+)$", text, re.M)
        self.assertIsNotNone(env, "Dockerfile.worker does not set the Whisper model folder")
        self.assertEqual(env.group(1), "/opt/whisper-cache/whisper")
        self.assertIn("XDG_CACHE_HOME=/opt/whisper-cache python -c \"import whisper; whisper.load_model('base')", text)
        self.assertIn("chmod -R a+rX,go-w /opt/whisper-cache", text)
        self.assertNotRegex(text, r"mv /opt/whisper-cache", "the baked folder was moved away from the path the ENV names")
        self.assertLess(text.index("whisper.load_model('base')"), env.start())
        self.assertLess(env.start(), text.index("USER nightshift"))

    def test_every_workflow_that_installs_requirements_uses_the_constraints(self):
        seen = 0
        for wf in sorted((ROOT / ".github" / "workflows").glob("*.yml")):
            for line in wf.read_text().splitlines():
                if re.search(r"pip install .*-r requirements\.txt", line):
                    seen += 1
                    self.assertIn("-c constraints.txt", line, wf.name)
        self.assertGreaterEqual(seen, 6)

    def test_constraints_change_triggers_a_deploy(self):
        self.assertIn('- "constraints.txt"', (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text())


if __name__ == "__main__":
    unittest.main()
