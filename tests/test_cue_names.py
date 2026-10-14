"""A sound or music cue the model writes is a name, never a path.

``[SFX:../../output/<other-run>/audio/final_audio]`` in a script (a customer's topic can steer the
model) must not open another run's audio and mix it into this video. Cue names are looked up as
plain files under the sound and music folders only.
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from modules import audio_mixer
from modules.audio_mixer import AudioMixer


class CueNamesAreNotPaths(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.sfx, self.music, self.out = root / "assets" / "sfx", root / "assets" / "music", root / "output"
        for d in (self.sfx, self.music, self.out):
            d.mkdir(parents=True)
        (self.sfx / "whoosh.mp3").write_bytes(b"x")
        (self.music / "story_low.wav").write_bytes(b"x")
        # Another run's audio, reachable from the folders above by "../.."
        other = self.out / "other-run" / "audio"
        other.mkdir(parents=True)
        (other / "final_audio.mp3").write_bytes(b"secret narration")
        for name, value in (("SFX_DIR", self.sfx), ("MUSIC_DIR", self.music), ("OUTPUT_DIR", self.out)):
            p = patch.object(audio_mixer, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.opened = []
        p = patch.object(audio_mixer.AudioSegment, "from_file", side_effect=lambda path: self.opened.append(Path(path)) or "seg")
        p.start()
        self.addCleanup(p.stop)
        self.mixer = AudioMixer("this-run")

    def test_a_plain_cue_still_loads(self):
        self.assertEqual(self.mixer._load_sfx("whoosh"), "seg")
        self.assertEqual(self.mixer._load_music("story_low"), "seg")
        self.assertEqual([p.name for p in self.opened], ["whoosh.mp3", "story_low.wav"])

    def test_a_traversing_sound_cue_opens_nothing(self):
        for name in ("../../output/other-run/audio/final_audio", "../whoosh", "sub/whoosh", "/etc/passwd", "..", ""):
            self.assertIsNone(self.mixer._load_sfx(name), name)
        self.assertEqual(self.opened, [])

    def test_a_traversing_music_cue_never_reaches_outside_the_music_folder(self):
        self.assertEqual(self.mixer._load_music("../../output/other-run/audio/final_audio"), "seg")
        # Falls back to the folder's own track, like any unknown cue
        self.assertEqual([p.parent for p in self.opened], [self.music])


if __name__ == "__main__":
    unittest.main()
