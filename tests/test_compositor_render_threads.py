"""The final-encode thread count is env-tunable so a memory-starved GitHub
Actions runner can drop x264 from 2 threads to 1 (fewer 1080p frame buffers,
same file) without a code change — the render has been OOM-killed at exit 143
with ffmpeg eating the box. These pin the default and the clamping."""

import os
import unittest
from unittest.mock import patch

from modules.compositor import _render_threads


class TestRenderThreads(unittest.TestCase):
    def _with(self, value):
        env = dict(os.environ)
        env.pop("NIGHTSHIFT_RENDER_THREADS", None)
        if value is not None:
            env["NIGHTSHIFT_RENDER_THREADS"] = value
        with patch.dict("os.environ", env, clear=True):
            return _render_threads()

    def test_default_is_two_when_unset(self):
        self.assertEqual(self._with(None), 2)

    def test_explicit_values_pass_through(self):
        self.assertEqual(self._with("1"), 1)
        self.assertEqual(self._with("2"), 2)
        self.assertEqual(self._with("4"), 4)

    def test_clamped_to_range(self):
        self.assertEqual(self._with("0"), 1)
        self.assertEqual(self._with("-3"), 1)
        self.assertEqual(self._with("99"), 8)

    def test_malformed_or_blank_keeps_default(self):
        self.assertEqual(self._with("abc"), 2)
        self.assertEqual(self._with(""), 2)
        self.assertEqual(self._with("2.5"), 2)


if __name__ == "__main__":
    unittest.main()
