"""D12: a failed render job carries a coded reason (modules/render_error.py)."""

import unittest

from modules import render_error as re_


def tb(last):
    return ["Traceback (most recent call last):", '  File "main.py", line 9, in run', "    x()", last]


class Classify(unittest.TestCase):
    def test_pipeline_exceptions_map_to_their_stage(self):
        for last, code in [
            ("modules.audio_mixer.VoiceUnavailable: voice 'x' is out of characters", "voice"),
            ("modules.minimax_broll.VideoModelUnavailable: refused: quota", "provider_quota"),
            ("modules.media_fetcher.MediaUnavailable: no footage", "media"),
            ("modules.render_backend.RenderBackendError: ffmpeg failed", "render"),
            ("modules.scene_render.SceneRenderError: bad scene", "render"),
            ("modules.render_backend.RenderTimeout: ffmpeg took too long", "timeout"),
            ("subprocess.TimeoutExpired: Command 'ffmpeg' timed out after 900 seconds", "timeout"),
        ]:
            with self.subTest(last=last):
                self.assertEqual(re_.classify("main.py exited with code 1", tb(last)), code)

    def test_a_vendor_quota_answer_is_provider_quota(self):
        last = "google.genai.errors.ClientError: 429 RESOURCE_EXHAUSTED. quota"
        self.assertEqual(re_.classify("main.py exited with code 1", tb(last)), "provider_quota")

    def test_the_last_exception_wins_over_an_earlier_one(self):
        tail = tb("modules.audio_mixer.VoiceUnavailable: x") + ["During handling ...", "RuntimeError: boom"]
        self.assertEqual(re_.classify("main.py exited with code 1", tail), "unknown")

    def test_worker_headers(self):
        self.assertEqual(re_.classify("credits: 12 needed, 3 available (nothing was run)"), "credits")
        self.assertEqual(re_.classify("run timed out after 55 min"), "timeout")

    def test_unrecognised_is_unknown_never_guessed(self):
        self.assertEqual(re_.classify("main.py exited with code 3", ["just some log line", "ERROR quota?"]), "unknown")
        self.assertEqual(re_.classify("", []), "unknown")

    def test_only_the_header_line_can_say_timed_out(self):
        self.assertEqual(re_.classify("main.py exited with code 1", ["the request timed out, retrying"]), "unknown")

    def test_every_result_is_in_the_closed_set(self):
        for last in ("ValueError: x", "modules.x.VoiceUnavailable: y", ""):
            self.assertIn(re_.classify("h", tb(last)), re_.CODES)


class Tag(unittest.TestCase):
    def test_prefix_round_trip(self):
        text = re_.tag("voice", "main.py exited with code 1\nlog tail")
        self.assertEqual(text, "[code:voice] main.py exited with code 1\nlog tail")
        self.assertEqual(re_.code_of(text), "voice")

    def test_retagging_replaces_never_stacks(self):
        self.assertEqual(re_.tag("render", re_.tag("voice", "x")), "[code:render] x")

    def test_unknown_code_is_stored_as_unknown_and_old_rows_have_none(self):
        self.assertEqual(re_.tag("bogus", "x"), "[code:unknown] x")
        self.assertIsNone(re_.code_of("main.py exited with code 1"))
        self.assertIsNone(re_.code_of("[code:bogus] x"))
        self.assertIsNone(re_.code_of(None))


if __name__ == "__main__":
    unittest.main()
