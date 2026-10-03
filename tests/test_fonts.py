"""The product's typeface: files, coverage, payload.

docs/design/HUMAN_TYPE.md explains the choice (Onest, SIL OFL 1.1). What is
pinned here is what would otherwise break silently in one language:

* every font file the CSS names exists, and the CRITICAL ones for each language
  stay under 150 KB together (the first paint must not wait on a big font);
* the Latin file carries Uzbek's oʻ gʻ (U+02BB), the tutuq (U+02BC) and the
  curly apostrophes (U+2018/U+2019); the Cyrillic file carries all of Russian
  plus the Uzbek Cyrillic letters; tabular figures exist in the Latin file.
  (Needs fontTools: skipped where it is not installed, as in the bot's CI image.)
* the licence text for every shipped face is in the repo.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "command-center"
FONTS = APP / "public" / "fonts"
CSS = (APP / "app" / "fonts.css").read_text(encoding="utf-8")

try:  # pragma: no cover - optional dependency
    from fontTools.ttLib import TTFont
except ImportError:  # pragma: no cover
    TTFont = None


def cmap(name):
    return TTFont(str(FONTS / name)).getBestCmap()


class FontFiles(unittest.TestCase):
    def test_every_file_in_the_css_exists(self):
        urls = re.findall(r'url\("(/fonts/[^"]+)"\)', CSS)
        self.assertEqual(len(urls), 4, urls)
        for url in urls:
            self.assertTrue((APP / "public" / url.lstrip("/")).is_file(), url)

    def test_critical_payload_is_small(self):
        latin = (FONTS / "onest-latin-v1.woff2").stat().st_size
        cyr = (FONTS / "onest-cyrillic-v1.woff2").stat().st_size
        self.assertLess(latin, 150_000)
        self.assertLess(latin + cyr, 150_000)  # Russian preloads both

    def test_no_second_webfont_but_the_wordmark(self):
        families = set(re.findall(r'font-family: "([^"]+)"', CSS))
        self.assertEqual(families, {"Onest", "Onest Fallback", "Nightshift Wordmark"})

    def test_licences_are_shipped(self):
        for name in ("OFL-Onest.txt", "OFL-SofiaSans.txt"):
            text = (APP / "brand" / "og-fonts" / name).read_text(encoding="utf-8")
            self.assertIn("SIL OPEN FONT LICENSE Version 1.1", text)


@unittest.skipIf(TTFont is None, "fontTools is not installed")
class FontCoverage(unittest.TestCase):
    def test_uzbek_latin_letters_and_apostrophes(self):
        c = cmap("onest-latin-v1.woff2")
        for ch in "oʻgʻOʻGʻʼ‘’abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789":
            self.assertIn(ord(ch), c, f"U+{ord(ch):04X} {ch!r} missing from the Latin file")

    def test_russian_and_uzbek_cyrillic(self):
        c = cmap("onest-cyrillic-v1.woff2")
        c.update(cmap("onest-cyrillic-ext-v1.woff2"))
        for code in list(range(0x410, 0x450)) + [0x401, 0x451, 0x45E, 0x49B, 0x493, 0x4B3, 0x2116]:
            self.assertIn(code, c, f"U+{code:04X}")

    def test_tabular_figures(self):
        feats = {fr.FeatureTag for fr in TTFont(str(FONTS / "onest-latin-v1.woff2"))["GSUB"].table.FeatureList.FeatureRecord}
        self.assertIn("tnum", feats)

    def test_is_a_variable_font_over_the_three_weights_we_use(self):
        t = TTFont(str(FONTS / "onest-latin-v1.woff2"))
        axes = {a.axisTag: (a.minValue, a.maxValue) for a in t["fvar"].axes}
        self.assertLessEqual(axes["wght"][0], 400)
        self.assertGreaterEqual(axes["wght"][1], 600)


if __name__ == "__main__":
    unittest.main()
