"""The thumbnail-quality helpers, tested without rendering: text is wrapped and
capped so it can never spill off the canvas, and the scrim gradient ramps from
transparent at its top to near-opaque at the bottom so a caption reads on any
photo. A full render smoke test runs when PIL is available."""

import unittest

from modules.thumbnail_generator import scrim_alpha, wrap_capped


class WrapCappedTestCase(unittest.TestCase):
    def test_wraps_within_line_count(self):
        lines = wrap_capped("hello world this is fine", width=10, max_lines=5)
        self.assertTrue(all(len(ln) <= 12 for ln in lines))

    def test_caps_and_ellipsizes(self):
        text = "one two three four five six seven eight nine ten eleven twelve"
        lines = wrap_capped(text, width=8, max_lines=2)
        self.assertEqual(len(lines), 2)
        self.assertTrue(lines[-1].endswith("…"))

    def test_empty_is_empty(self):
        self.assertEqual(wrap_capped("", 10, 3), [])
        self.assertEqual(wrap_capped("   ", 10, 3), [])

    def test_short_text_unchanged(self):
        self.assertEqual(wrap_capped("short", 20, 3), ["short"])


class ScrimAlphaTestCase(unittest.TestCase):
    def test_zero_above_top(self):
        self.assertEqual(scrim_alpha(y=100, top_y=500, height=1080), 0)
        self.assertEqual(scrim_alpha(y=500, top_y=500, height=1080), 0)

    def test_ramps_to_max_at_bottom(self):
        top, h, mx = 500, 1080, 210
        bottom = scrim_alpha(y=h, top_y=top, height=h, max_alpha=mx)
        mid = scrim_alpha(y=(top + h) // 2, top_y=top, height=h, max_alpha=mx)
        self.assertGreater(bottom, mid)     # darker lower down
        self.assertGreater(mid, 0)
        self.assertLessEqual(bottom, 255)

    def test_clamped(self):
        self.assertGreaterEqual(scrim_alpha(2000, 500, 1080), 0)
        self.assertLessEqual(scrim_alpha(2000, 500, 1080), 255)


class RenderSmokeTestCase(unittest.TestCase):
    def test_thumbnail_renders_with_scrim_and_accent(self):
        try:
            from PIL import Image
            from modules.thumbnail_generator import _make_thumbnail
        except Exception:
            self.skipTest("PIL not available")
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "thumb.jpg"
            _make_thumbnail(None, "SHOCKING TRUTH ABOUT ROME", "The Fall of Rome", out, variant="A")
            self.assertTrue(out.exists())
            with Image.open(out) as im:
                self.assertEqual(im.size[0] > 0 and im.size[1] > 0, True)


class GenerateVariantsTestCase(unittest.TestCase):
    """Roadmap #58: widen the A/B test past two arms. generate_variants renders
    one thumbnail per variant, keyed by variant label, each a distinct file."""

    def _gen(self, tmp):
        from pathlib import Path
        from modules.thumbnail_generator import ThumbnailGenerator

        gen = ThumbnailGenerator("test-slug-ab")
        gen.out_dir = Path(tmp)  # keep the render out of the repo's output/ dir
        return gen

    def test_renders_one_file_per_variant(self):
        try:
            from PIL import Image  # noqa: F401
        except Exception:
            self.skipTest("PIL not available")
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            gen = self._gen(d)
            out = gen.generate_variants("The Fall of Rome", "SHOCKING", variants=("A", "B", "C"))
            self.assertEqual(set(out.keys()), {"A", "B", "C"})
            for path in out.values():
                self.assertTrue(path.exists())
            self.assertEqual(len({str(p) for p in out.values()}), 3)

    def test_default_two_arms(self):
        try:
            from PIL import Image  # noqa: F401
        except Exception:
            self.skipTest("PIL not available")
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            gen = self._gen(d)
            out = gen.generate_variants("Topic", "TEXT")
            self.assertEqual(set(out.keys()), {"A", "B"})


class ThumbnailVariantCountConfigTestCase(unittest.TestCase):
    def test_clamps_into_supported_range(self):
        from config import _clamp_int

        self.assertEqual(_clamp_int("3", 2, 2, 4), 3)
        self.assertEqual(_clamp_int("1", 2, 2, 4), 2)   # below floor
        self.assertEqual(_clamp_int("9", 2, 2, 4), 4)   # above ceiling
        self.assertEqual(_clamp_int("nonsense", 2, 2, 4), 2)  # unparseable -> default
        self.assertEqual(_clamp_int(None, 2, 2, 4), 2)


if __name__ == "__main__":
    unittest.main()
