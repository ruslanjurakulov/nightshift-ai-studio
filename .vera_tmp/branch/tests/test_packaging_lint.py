"""Tests for modules/packaging_lint.py — the advisory title + thumbnail pairing lint.

The properties worth pinning, each one a way this could lie to the owner:

* an UNKNOWN is never an OK. A missing overlay, a title with nothing to measure and a
  language the word checks cannot read are all ``not_checked`` (CLAUDE.md rule 5);
* the cut points are where YouTube cuts (about 40 on a phone, 60 on desktop search, 100 hard),
  counted in what a viewer SEES (graphemes), except the hard limit, which counts what the
  publish gate counts;
* the lint is deterministic, never raises, and never echoes the input back into the event;
* main.py emits it as advice only: outside the gate branches, inside a try that swallows.
"""

import ast
import json
import time
import unittest
from pathlib import Path

from modules import event_log as events
from modules import packaging_lint as pl
from modules import publish_gate

FAMILY = "\U0001F468\u200d\U0001F469\u200d\U0001F467"  # man, woman, girl joined: 5 code points, 1 glyph
THUMBS_UP_TONE = "\U0001F44D\U0001F3FD"
FLAG_UZ = "\U0001F1FA\U0001F1FF"
FLAG_US = "\U0001F1FA\U0001F1F8"
KEYCAP_1 = "1\ufe0f\u20e3"


def _check(result, name):
    return result.get(name)


def _status(result, name):
    return result.get(name).status


def _reason(result, name):
    return result.get(name).reason


def _lint(title="A fine title", overlay="SECRET VAULT", language="English"):
    return pl.lint(title, overlay, language)


class GraphemeCountTestCase(unittest.TestCase):
    """Length is counted in what a viewer sees; a title is cut by glyph, not by code point."""

    def count(self, text):
        return pl.grapheme_count(text)

    def test_plain_latin_and_cyrillic(self):
        self.assertEqual(self.count("Rome"), 4)
        self.assertEqual(self.count("Привет"), 6)

    def test_uzbek_apostrophes_are_one_glyph_each_in_every_spelling(self):
        for text in ("O'zbekiston", "O\u02bbzbekiston", "O\u2018zbekiston", "O\u2019zbekiston", "O\u02bczbekiston"):
            self.assertEqual(self.count(text), 11, text)

    def test_combining_mark_joins_its_base(self):
        self.assertEqual(self.count("e\u0301"), 1)
        # Cyrillic short-i written as base + breve is the same glyph as the precomposed letter.
        self.assertEqual(self.count("и\u0306"), 1)
        self.assertEqual(self.count("и\u0306"), self.count("й"))

    def test_emoji_sequences_are_one_glyph(self):
        self.assertEqual(self.count(FAMILY), 1)
        self.assertEqual(self.count(THUMBS_UP_TONE), 1)
        self.assertEqual(self.count("\u2764\ufe0f"), 1)
        self.assertEqual(self.count(KEYCAP_1), 1)
        self.assertEqual(self.count(FLAG_UZ), 1)

    def test_two_flags_are_two_glyphs(self):
        self.assertEqual(self.count(FLAG_UZ + FLAG_US), 2)

    def test_zero_width_characters_are_not_visible(self):
        self.assertEqual(self.count("a\u200bb"), 2)
        self.assertEqual(self.count("\u200b\u200d\ufeff"), 0)

    def test_joiner_between_letters_does_not_hide_letters(self):
        # A hostile title cannot shrink its own count by threading ZWJ between letters.
        self.assertEqual(self.count("a\u200db\u200dc"), 3)

    def test_empty_and_non_string(self):
        self.assertEqual(self.count(""), 0)
        self.assertEqual(self.count(None), 0)
        self.assertEqual(self.count(12345), 0)


class TitleCutPointsTestCase(unittest.TestCase):
    def test_constants_match_what_the_report_and_the_gate_say(self):
        self.assertEqual(pl.MOBILE_VISIBLE_CHARS, 40)
        self.assertEqual(pl.DESKTOP_VISIBLE_CHARS, 60)
        self.assertEqual(pl.HARD_LIMIT_CHARS, 100)
        # The hard limit is the gate's own number: two lists of the same limit drift.
        self.assertEqual(pl.HARD_LIMIT_CHARS, publish_gate.MAX_TITLE_CHARS)

    def test_mobile_cut_is_at_40(self):
        self.assertEqual(_status(_lint("x" * 40), pl.TITLE_MOBILE), pl.OK)
        r = _lint("x" * 41)
        self.assertEqual(_status(r, pl.TITLE_MOBILE), pl.ISSUE)
        self.assertEqual(_reason(r, pl.TITLE_MOBILE), pl.R_CUT_MOBILE)

    def test_desktop_cut_is_at_60(self):
        self.assertEqual(_status(_lint("x" * 60), pl.TITLE_DESKTOP), pl.OK)
        r = _lint("x" * 61)
        self.assertEqual(_status(r, pl.TITLE_DESKTOP), pl.ISSUE)
        self.assertEqual(_reason(r, pl.TITLE_DESKTOP), pl.R_CUT_DESKTOP)

    def test_hard_limit_is_at_100(self):
        self.assertEqual(_status(_lint("x" * 100), pl.TITLE_HARD_LIMIT), pl.OK)
        r = _lint("x" * 101)
        self.assertEqual(_status(r, pl.TITLE_HARD_LIMIT), pl.ISSUE)
        self.assertEqual(_reason(r, pl.TITLE_HARD_LIMIT), pl.R_OVER_LIMIT)

    def test_a_61_char_title_is_cut_on_desktop_and_mobile_but_not_over_the_limit(self):
        r = _lint("x" * 61)
        self.assertEqual(
            (_status(r, pl.TITLE_MOBILE), _status(r, pl.TITLE_DESKTOP), _status(r, pl.TITLE_HARD_LIMIT)),
            (pl.ISSUE, pl.ISSUE, pl.OK),
        )

    def test_surrounding_whitespace_is_not_part_of_the_title(self):
        self.assertEqual(_status(_lint("  " + "x" * 40 + "\n"), pl.TITLE_MOBILE), pl.OK)

    def test_cyrillic_and_uzbek_titles_are_measured_too(self):
        # Length is language independent: it must run (not be gated) for ru and uz.
        for lang in ("ru", "Russian", "uz", "Uzbek"):
            r = pl.lint("я" * 41, "ЛОВУШКА", lang)
            self.assertEqual(_status(r, pl.TITLE_MOBILE), pl.ISSUE, lang)
            self.assertEqual(_status(r, pl.TITLE_DESKTOP), pl.OK, lang)

    def test_emoji_count_as_one_glyph_for_the_cut_points(self):
        # 39 letters + a family emoji is 40 glyphs on screen (but 44 code points).
        r = _lint("x" * 39 + FAMILY)
        self.assertEqual(_status(r, pl.TITLE_MOBILE), pl.OK)
        self.assertEqual(_status(_lint("x" * 40 + FAMILY), pl.TITLE_MOBILE), pl.ISSUE)

    def test_combining_marks_do_not_push_a_title_over_the_cut(self):
        self.assertEqual(_status(_lint("e\u0301" * 40), pl.TITLE_MOBILE), pl.OK)
        self.assertEqual(_status(_lint("e\u0301" * 41), pl.TITLE_MOBILE), pl.ISSUE)

    def test_hard_limit_counts_code_points_like_the_publish_gate(self):
        # 21 family emoji are 21 glyphs but 105 code points: the gate (len()) blocks it, so the
        # advice must not say it is fine.
        title = FAMILY * 21
        r = _lint(title)
        self.assertEqual(_status(r, pl.TITLE_MOBILE), pl.OK)
        self.assertEqual(_status(r, pl.TITLE_HARD_LIMIT), pl.ISSUE)
        self.assertGreater(len(title), publish_gate.MAX_TITLE_CHARS)

    def test_counts_are_reported_as_numbers(self):
        r = _lint("x" * 45)
        self.assertEqual(r.title_graphemes, 45)
        self.assertEqual(r.title_chars, 45)


class FigureSurvivesTestCase(unittest.TestCase):
    """The concrete figure of a title is what a cut must not take away."""

    def test_figure_in_the_head_is_visible(self):
        self.assertEqual(_status(_lint("1453: how a wall fell"), pl.FIGURE_POSITION), pl.OK)
        self.assertEqual(_reason(_lint("1453: how a wall fell"), pl.FIGURE_POSITION), pl.R_FIGURE_VISIBLE)

    def test_figure_after_the_mobile_cut(self):
        r = _lint("x" * 41 + " 1453")
        self.assertEqual(_status(r, pl.FIGURE_POSITION), pl.ISSUE)
        self.assertEqual(_reason(r, pl.FIGURE_POSITION), pl.R_FIGURE_CUT_MOBILE)

    def test_figure_after_the_desktop_cut(self):
        r = _lint("x" * 61 + " 1453")
        self.assertEqual(_reason(r, pl.FIGURE_POSITION), pl.R_FIGURE_CUT_DESKTOP)

    def test_figure_exactly_at_the_first_desktop_hidden_glyph(self):
        self.assertEqual(_reason(_lint("x" * 59 + "7"), pl.FIGURE_POSITION), pl.R_FIGURE_CUT_MOBILE)
        self.assertEqual(_reason(_lint("x" * 60 + "7"), pl.FIGURE_POSITION), pl.R_FIGURE_CUT_DESKTOP)

    def test_figure_exactly_at_the_last_visible_glyph(self):
        self.assertEqual(_status(_lint("x" * 39 + "7"), pl.FIGURE_POSITION), pl.OK)
        self.assertEqual(_status(_lint("x" * 40 + "7"), pl.FIGURE_POSITION), pl.ISSUE)

    def test_no_figure_is_not_checked_not_ok(self):
        r = _lint("How a wall fell")
        self.assertEqual(_status(r, pl.FIGURE_POSITION), pl.NOT_CHECKED)
        self.assertEqual(_reason(r, pl.FIGURE_POSITION), pl.R_NO_FIGURE)

    def test_non_ascii_digits_count_as_figures(self):
        self.assertEqual(_status(_lint("\u0661\u0662\u0663 x"), pl.FIGURE_POSITION), pl.OK)


class CapsTestCase(unittest.TestCase):
    def test_two_caps_words_are_fine_three_are_not(self):
        self.assertEqual(_status(_lint("Why ROME FELL quietly"), pl.TITLE_CAPS), pl.OK)
        r = _lint("THE SHOCKING TRUTH about Rome")
        self.assertEqual(_status(r, pl.TITLE_CAPS), pl.ISSUE)
        self.assertEqual(_reason(r, pl.TITLE_CAPS), pl.R_TOO_MANY_CAPS)

    def test_short_acronyms_and_digits_are_not_shouting(self):
        self.assertEqual(_status(_lint("The US and UK in 2024 and 1453"), pl.TITLE_CAPS), pl.OK)

    def test_two_letter_acronyms_never_count_however_many(self):
        self.assertEqual(_status(_lint("The US and UK and TV and EU"), pl.TITLE_CAPS), pl.OK)
        self.assertEqual(_status(_lint("The USA and UK and TV and EU"), pl.TITLE_CAPS), pl.OK)

    def test_cyrillic_caps_are_counted(self):
        self.assertEqual(_status(pl.lint("ПОЧЕМУ РИМ ПАЛ НА САМОМ ДЕЛЕ", None, "ru"), pl.TITLE_CAPS), pl.ISSUE)
        self.assertEqual(_status(pl.lint("Почему РИМ пал", None, "ru"), pl.TITLE_CAPS), pl.OK)

    def test_uzbek_caps_with_apostrophe_are_counted(self):
        self.assertEqual(_status(pl.lint("NIMA UCHUN O'ZBEKISTON", None, "uz"), pl.TITLE_CAPS), pl.ISSUE)

    def test_an_uncased_title_is_not_checked_not_ok(self):
        for title in ("1453", "!!! ???", "\u65e5\u672c\u8a9e\u306e\u30bf\u30a4\u30c8\u30eb"):
            r = _lint(title)
            self.assertEqual(_status(r, pl.TITLE_CAPS), pl.NOT_CHECKED, title)
            self.assertEqual(_reason(r, pl.TITLE_CAPS), pl.R_NO_CASED_LETTERS, title)


class OverlayLengthTestCase(unittest.TestCase):
    def test_budget_constants(self):
        self.assertEqual(pl.MAX_OVERLAY_WORDS, 4)
        self.assertEqual(pl.MAX_OVERLAY_CHARS, 28)

    def test_four_words_fit_five_do_not(self):
        self.assertEqual(_status(_lint(overlay="ONE TWO THREE FOUR"), pl.OVERLAY_LENGTH), pl.OK)
        r = _lint(overlay="ONE TWO THREE FOUR FIVE")
        self.assertEqual(_status(r, pl.OVERLAY_LENGTH), pl.ISSUE)
        self.assertEqual(_reason(r, pl.OVERLAY_LENGTH), pl.R_TOO_MANY_WORDS)

    def test_char_budget_is_at_28(self):
        self.assertEqual(_status(_lint(overlay="x" * 28), pl.OVERLAY_LENGTH), pl.OK)
        r = _lint(overlay="x" * 29)
        self.assertEqual(_status(r, pl.OVERLAY_LENGTH), pl.ISSUE)
        self.assertEqual(_reason(r, pl.OVERLAY_LENGTH), pl.R_TOO_LONG)

    def test_unspaced_scripts_are_caught_by_the_char_budget(self):
        self.assertEqual(_reason(_lint(overlay="\u3042" * 40), pl.OVERLAY_LENGTH), pl.R_TOO_LONG)

    def test_length_runs_for_ru_and_uz(self):
        for lang in ("ru", "uz"):
            r = pl.lint("Fall", "СЛИШКОМ МНОГО СЛОВ НА ЭТОЙ ОБЛОЖКЕ", lang)
            self.assertEqual(_status(r, pl.OVERLAY_LENGTH), pl.ISSUE, lang)
            ok = pl.lint("Fall", "ЛОВУШКА", lang)
            self.assertEqual(_status(ok, pl.OVERLAY_LENGTH), pl.OK, lang)

    def test_emoji_in_overlay_count_once(self):
        self.assertEqual(_status(_lint(overlay="x" * 27 + FAMILY), pl.OVERLAY_LENGTH), pl.OK)


class OverlayEchoTestCase(unittest.TestCase):
    """The overlay should add to the title, not repeat it."""

    def test_overlay_repeating_title_words_is_an_issue(self):
        r = pl.lint("The Lost City of Atlantis Found", "LOST CITY", "English")
        self.assertEqual(_status(r, pl.OVERLAY_ECHO), pl.ISSUE)
        self.assertEqual(_reason(r, pl.OVERLAY_ECHO), pl.R_REPEATS_TITLE)

    def test_overlay_adding_words_is_ok(self):
        r = pl.lint("Why Rome Fell", "SHOCKING DISCOVERY", "English")
        self.assertEqual(_status(r, pl.OVERLAY_ECHO), pl.OK)
        self.assertEqual(_reason(r, pl.OVERLAY_ECHO), pl.R_ADDS_WORDS)

    def test_case_punctuation_and_plurals_do_not_hide_a_repeat(self):
        self.assertEqual(_status(pl.lint("Why Rome fell", "ROME!", "en"), pl.OVERLAY_ECHO), pl.ISSUE)
        self.assertEqual(_status(pl.lint("The Roman army", "ROMANS", "en"), pl.OVERLAY_ECHO), pl.ISSUE)

    def test_function_words_alone_do_not_count_as_a_repeat(self):
        r = pl.lint("The fall of the empire", "THE SECRET", "en")
        self.assertEqual(_status(r, pl.OVERLAY_ECHO), pl.OK)

    def test_overlay_of_only_function_words_cannot_be_judged(self):
        r = pl.lint("The fall of Rome", "THE OF", "en")
        self.assertEqual(_status(r, pl.OVERLAY_ECHO), pl.NOT_CHECKED)
        self.assertEqual(_reason(r, pl.OVERLAY_ECHO), pl.R_NO_CONTENT_WORDS)

    def test_half_of_the_overlay_repeating_is_the_line(self):
        title = "Why Rome Fell"
        self.assertEqual(_status(pl.lint(title, "ROME FELL HARD", "en"), pl.OVERLAY_ECHO), pl.ISSUE)  # 2 of 3
        self.assertEqual(_status(pl.lint(title, "ROME SECRETS", "en"), pl.OVERLAY_ECHO), pl.ISSUE)    # 1 of 2
        self.assertEqual(_status(pl.lint(title, "ROME SECRET PLOT", "en"), pl.OVERLAY_ECHO), pl.OK)   # 1 of 3

    def test_possessive_does_not_hide_a_repeat(self):
        self.assertEqual(_status(pl.lint("Rome fell", "ROME'S", "en"), pl.OVERLAY_ECHO), pl.ISSUE)
        self.assertEqual(_status(pl.lint("Rome fell", "ROME\u2019S", "en"), pl.OVERLAY_ECHO), pl.ISSUE)

    def test_a_single_letter_is_not_a_content_word_but_a_single_digit_is(self):
        r = pl.lint("Project X", "X", "en")
        self.assertEqual(_reason(r, pl.OVERLAY_ECHO), pl.R_NO_CONTENT_WORDS)
        self.assertEqual(_status(pl.lint("Top 7 facts", "7", "en"), pl.OVERLAY_ECHO), pl.ISSUE)

    def test_a_repeated_number_is_a_repeat(self):
        self.assertEqual(_status(pl.lint("1453: the wall falls", "1453", "en"), pl.OVERLAY_ECHO), pl.ISSUE)

    def test_english_spellings_of_the_language_are_all_checked(self):
        for lang in ("English", "english", "en", "EN", "en-US", "en_GB", "eng", "English (US)"):
            r = pl.lint("Why Rome Fell", "ROME FELL", lang)
            self.assertEqual(_status(r, pl.OVERLAY_ECHO), pl.ISSUE, lang)


class LanguageGateTestCase(unittest.TestCase):
    """Word-list checks must say 'language', never 'ok', for a language they cannot read."""

    UNREADABLE = ("ru", "RU", "Russian", "ru-RU", "uz", "Uzbek", "uz-Latn", "Ozbek", "fr", "ja", "Русский", "", None, 42, object())

    def test_overlay_echo_is_not_checked_for_every_other_language(self):
        for lang in self.UNREADABLE:
            # The overlay is an exact copy of the title: an English reader would flag it.
            r = pl.lint("Rim Pal", "Rim Pal", lang)
            c = r.get(pl.OVERLAY_ECHO)
            self.assertEqual(c.status, pl.NOT_CHECKED, repr(lang))
            self.assertEqual(c.reason, pl.R_LANGUAGE, repr(lang))

    def test_no_word_check_can_report_ok_for_ru_or_uz(self):
        for lang, title, overlay in (
            ("ru", "Почему пал Рим", "Почему пал Рим"),
            ("uz", "Rim nega qulagan", "Rim nega qulagan"),
        ):
            r = pl.lint(title, overlay, lang)
            for name in pl.WORD_CHECKS:
                self.assertEqual(r.get(name).status, pl.NOT_CHECKED, (lang, name))
                self.assertEqual(r.get(name).reason, pl.R_LANGUAGE, (lang, name))

    def test_gate_is_reported_in_the_summary(self):
        self.assertEqual(pl.lint("a", "b", "ru").word_checks, pl.WORDS_LANGUAGE)
        self.assertEqual(pl.lint("a", "b", "English").word_checks, pl.WORDS_RUN)
        self.assertEqual(pl.lint("a", "b", "ru").to_metadata()["word_checks"], "language")

    def test_character_checks_still_run_in_other_languages(self):
        r = pl.lint(" ".join(["ПОЧЕМУ"] * 10), "СЛОВО", "ru")
        self.assertEqual(_status(r, pl.TITLE_DESKTOP), pl.ISSUE)
        self.assertEqual(_status(r, pl.TITLE_CAPS), pl.ISSUE)
        self.assertEqual(_status(r, pl.OVERLAY_LENGTH), pl.OK)

    def test_language_gate_wins_over_a_missing_overlay_and_a_missing_title(self):
        self.assertEqual(_reason(pl.lint("Rim", None, "ru"), pl.OVERLAY_ECHO), pl.R_LANGUAGE)
        self.assertEqual(_reason(pl.lint(None, "Rim", "ru"), pl.OVERLAY_ECHO), pl.R_LANGUAGE)


class MissingInputTestCase(unittest.TestCase):
    """Unknown is not zero and not ok (CLAUDE.md rule 5)."""

    MISSING = (None, "", "   ", "\n\t", "\x00\x07\x1b", "\u200b\u200d", 0, 12.5, b"abc", ["x"], {"a": 1}, object())

    def test_missing_overlay_is_not_checked_everywhere_it_matters(self):
        for overlay in self.MISSING:
            r = pl.lint("Why Rome Fell", overlay, "English")
            for name in (pl.OVERLAY_LENGTH, pl.OVERLAY_ECHO):
                self.assertEqual(r.get(name).status, pl.NOT_CHECKED, repr(overlay))
                self.assertEqual(r.get(name).reason, pl.R_NO_OVERLAY, repr(overlay))

    def test_missing_overlay_is_unknown_not_zero(self):
        r = pl.lint("Why Rome Fell", None, "English")
        self.assertIsNone(r.overlay_graphemes)
        self.assertIsNone(r.overlay_words)
        meta = r.to_metadata()
        self.assertIsNone(meta["overlay_graphemes"])
        self.assertIsNone(meta["overlay_words"])

    def test_missing_overlay_is_counted_as_not_checked_never_ok(self):
        meta = pl.lint("Why Rome Fell", None, "English").to_metadata()
        statuses = [c["status"] for name, c in meta["checks"].items() if name in (pl.OVERLAY_LENGTH, pl.OVERLAY_ECHO)]
        self.assertEqual(statuses, [pl.NOT_CHECKED, pl.NOT_CHECKED])
        total = sum(meta["counts"].values())
        self.assertEqual(total, len(pl.ALL_CHECKS))

    def test_missing_title_is_not_checked_everywhere(self):
        for title in self.MISSING:
            r = pl.lint(title, "SECRET", "English")
            for name in (pl.TITLE_HARD_LIMIT, pl.TITLE_DESKTOP, pl.TITLE_MOBILE, pl.FIGURE_POSITION, pl.TITLE_CAPS, pl.OVERLAY_ECHO):
                self.assertEqual(r.get(name).status, pl.NOT_CHECKED, (repr(title), name))
                self.assertEqual(r.get(name).reason, pl.R_NO_TITLE, (repr(title), name))
            self.assertIsNone(r.title_graphemes)

    def test_nothing_is_ok_when_everything_is_missing(self):
        r = pl.lint(None, None, None)
        self.assertEqual([c.status for c in r.checks], [pl.NOT_CHECKED] * len(pl.ALL_CHECKS))


class HostileInputTestCase(unittest.TestCase):
    def test_line_breaks_and_tabs_are_spaces_not_nothing(self):
        # "ONE\nTWO" is two words on a thumbnail, not "ONETWO".
        r = _lint("a\nb", "ONE\nTWO\tTHREE\r\nFOUR\nFIVE")
        self.assertEqual(r.title_graphemes, 3)
        self.assertEqual(_reason(r, pl.OVERLAY_LENGTH), pl.R_TOO_MANY_WORDS)

    def test_any_whitespace_run_collapses_to_one_space(self):
        self.assertEqual(_lint("a  \u00a0 \u2003b").title_graphemes, 3)

    def test_truncation_is_reported_for_the_overlay_alone(self):
        self.assertTrue(pl.lint("Fine title", "y " * 5000, "en").to_metadata()["input_truncated"])
        self.assertFalse(pl.lint("Fine title", "ROME", "en").to_metadata()["input_truncated"])

    def test_very_long_inputs_are_fast_and_flagged(self):
        start = time.monotonic()
        r = pl.lint("x" * 5_000_000, "y " * 2_000_000, "English")
        self.assertLess(time.monotonic() - start, 2.0)
        self.assertEqual(_status(r, pl.TITLE_HARD_LIMIT), pl.ISSUE)
        self.assertEqual(_status(r, pl.OVERLAY_LENGTH), pl.ISSUE)
        self.assertTrue(r.to_metadata()["input_truncated"])

    def test_long_whitespace_prefix_does_not_hide_the_title(self):
        r = pl.lint(" " * 100_000 + "Why Rome Fell", "ROME", "English")
        self.assertEqual(_status(r, pl.TITLE_MOBILE), pl.OK)
        self.assertEqual(r.title_graphemes, len("Why Rome Fell"))

    def test_control_characters_do_not_count_or_break(self):
        r = pl.lint("a\x00b\x1b[31mc\x7f" + "x" * 5, "ro\x00me", "English")
        self.assertEqual(_status(r, pl.TITLE_MOBILE), pl.OK)
        # NUL / ESC are not glyphs: they must not inflate the visible length.
        self.assertEqual(pl.lint("a\x00" * 40, None, "en").title_graphemes, 40)

    def test_odd_types_never_raise(self):
        class Boom:
            def __str__(self):
                raise RuntimeError("no")

            __repr__ = __str__

        for value in (None, 1, 1.5, True, b"bytes", bytearray(b"x"), [], ["a"], {}, {"a": 1}, (), object(), Boom(), float("nan")):
            r = pl.lint(value, value, value)
            self.assertEqual(len(r.checks), len(pl.ALL_CHECKS))
            json.dumps(r.to_metadata())

    def test_lone_surrogates_and_noncharacters_do_not_raise(self):
        r = pl.lint("ab\ud800cd\udfff\U0010ffff\ufffe", "x\ud800y", "English")
        self.assertEqual(len(r.checks), len(pl.ALL_CHECKS))
        json.dumps(r.to_metadata(), ensure_ascii=False)

    def test_bidi_and_zero_width_spam_cannot_hide_length(self):
        title = ("a\u202e\u200b" * 41)
        self.assertEqual(_status(_lint(title), pl.TITLE_MOBILE), pl.ISSUE)

    def test_internal_failure_is_swallowed_and_labelled(self):
        original = pl._lint
        pl._lint = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            r = pl.lint("Why Rome Fell", "ROME", "English")
        finally:
            pl._lint = original
        self.assertEqual({c.status for c in r.checks}, {pl.NOT_CHECKED})
        self.assertEqual({c.reason for c in r.checks}, {pl.R_ERROR})
        self.assertEqual(len(r.checks), len(pl.ALL_CHECKS))


class DeterminismAndShapeTestCase(unittest.TestCase):
    MARKER = "ZZQXMARKERWORD"

    def test_same_input_same_output(self):
        a = pl.lint("Why Rome Fell in 476", "ROME FELL", "English").to_metadata()
        b = pl.lint("Why Rome Fell in 476", "ROME FELL", "English").to_metadata()
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))

    def test_result_is_immutable(self):
        r = _lint()
        with self.assertRaises(Exception):
            r.word_checks = "x"

    def test_every_check_is_present_once_in_a_stable_order(self):
        r = _lint()
        self.assertEqual([c.name for c in r.checks], list(pl.ALL_CHECKS))
        self.assertEqual(len(set(pl.ALL_CHECKS)), len(pl.ALL_CHECKS))

    def test_statuses_and_reasons_are_from_closed_sets(self):
        samples = [
            pl.lint("x" * 120 + " 5", "ONE TWO THREE FOUR FIVE", "English"),
            pl.lint("ПОЧЕМУ РИМ ПАЛ НА САМОМ ДЕЛЕ", "РИМ", "ru"),
            pl.lint(None, None, None),
            pl.lint("The Lost City", "LOST CITY", "en"),
        ]
        for r in samples:
            for c in r.checks:
                self.assertIn(c.status, pl.STATUSES)
                self.assertIn(c.reason, pl.REASONS)

    def test_event_metadata_never_echoes_the_input(self):
        title = f"{self.MARKER} title that is long enough to be cut on a phone screen {self.MARKER}"
        overlay = f"{self.MARKER} {self.MARKER}"
        for lang in ("English", "ru"):
            blob = json.dumps(pl.lint(title, overlay, lang).to_metadata(), ensure_ascii=False)
            self.assertNotIn(self.MARKER, blob)
            self.assertNotIn(self.MARKER.lower(), blob)

    def test_metadata_is_labelled_advisory_heuristic_uncalibrated(self):
        meta = _lint().to_metadata()
        self.assertTrue(meta["advisory"])
        self.assertEqual(meta["basis"], "heuristic")
        self.assertIs(meta["calibrated"], False)
        self.assertEqual(meta["thresholds"]["title_mobile"], 40)
        self.assertEqual(meta["thresholds"]["title_desktop"], 60)
        self.assertEqual(meta["thresholds"]["title_hard_limit"], 100)

    def test_counts_add_up(self):
        meta = pl.lint("x" * 120, None, "ru").to_metadata()
        self.assertEqual(sum(meta["counts"].values()), len(pl.ALL_CHECKS))
        self.assertEqual(meta["counts"]["issue"], sum(1 for c in meta["checks"].values() if c["status"] == "issue"))

    def test_module_is_pure_stdlib_no_io_no_network(self):
        path = Path(pl.__file__)
        tree = ast.parse(path.read_text(encoding="utf-8"))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(a.name.split(".")[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom):
                imported.add((node.module or "").split(".")[0])
        self.assertLessEqual(imported, {"__future__", "dataclasses", "re", "unicodedata", "typing"})
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                self.assertNotIn(node.func.id, {"open", "print", "exec", "eval", "__import__"})


class EventNameTestCase(unittest.TestCase):
    def test_event_constant(self):
        self.assertEqual(events.PACKAGING_LINT, "packaging.lint")

    def test_event_name_is_unique_in_the_vocabulary(self):
        values = [v for k, v in vars(events).items() if k.isupper() and isinstance(v, str)]
        self.assertEqual(values.count("packaging.lint"), 1)


class MainWiringIsAdvisoryTestCase(unittest.TestCase):
    """The lint only reports. It must not be able to change the title, the thumbnail, the gate,
    the upload or the privacy, and a failure in it must not fail the run."""

    def setUp(self):
        main_path = Path(__file__).resolve().parent.parent / "main.py"
        self.tree = ast.parse(main_path.read_text(encoding="utf-8"))

    def _emit(self, attr):
        for node in ast.walk(self.tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "emit"
                and node.args
                and isinstance(node.args[0], ast.Attribute)
                and node.args[0].attr == attr
            ):
                return node
        return None

    def _ancestors(self, target, node=None, trail=()):
        node = node or self.tree
        if node is target:
            return trail
        for child in ast.iter_child_nodes(node):
            found = self._ancestors(target, child, trail + (node,))
            if found is not None:
                return found
        return None

    def _lint_try(self):
        emit = self._emit("PACKAGING_LINT")
        self.assertIsNotNone(emit, "main.py must emit events.PACKAGING_LINT")
        tries = [a for a in self._ancestors(emit) if isinstance(a, ast.Try)]
        self.assertTrue(tries, "the lint emit must sit inside a try")
        return tries[-1]

    def test_lint_is_emitted(self):
        self.assertIsNotNone(self._emit("PACKAGING_LINT"))

    def test_emit_is_not_inside_any_gate_branch(self):
        emit = self._emit("PACKAGING_LINT")
        gated = [a for a in self._ancestors(emit) if isinstance(a, ast.If) and "gate" in ast.unparse(a.test)]
        self.assertEqual(gated, [])

    def test_failure_is_swallowed_and_never_reraised(self):
        node = self._lint_try()
        handlers = [h for h in node.handlers if h.type is not None and ast.unparse(h.type) == "Exception"]
        self.assertTrue(handlers, "the lint try must catch Exception")
        for h in handlers:
            self.assertFalse([n for n in ast.walk(h) if isinstance(n, ast.Raise)], "must not re-raise")

    def test_try_body_assigns_nothing_that_ships(self):
        node = self._lint_try()
        protected = {"published_title", "chosen_title", "title_variant", "script", "gate", "thumbs",
                     "chosen_thumb", "variant", "privacy", "recorded_privacy", "video_path"}
        for stmt in node.body:
            for n in ast.walk(stmt):
                if isinstance(n, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
                    targets = n.targets if isinstance(n, ast.Assign) else [n.target]
                    for t in targets:
                        for name in ast.walk(t):
                            if isinstance(name, ast.Name):
                                self.assertNotIn(name.id, protected)
                if isinstance(n, ast.Attribute) and isinstance(n.ctx, ast.Store):
                    self.fail("the lint try must not assign to attributes (e.g. script.title)")

    def test_lint_runs_after_the_publish_score_and_before_the_gate_events(self):
        score = self._emit("PUBLISH_SCORE")
        lint = self._emit("PACKAGING_LINT")
        allowed = self._emit("PUBLISH_ALLOWED")
        self.assertTrue(score.lineno < lint.lineno < allowed.lineno)

    def test_lint_lints_the_title_that_ships(self):
        emit_try = self._lint_try()
        calls = [n for n in ast.walk(emit_try) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Attribute) and n.func.attr == "lint"]
        self.assertEqual(len(calls), 1)
        call = ast.unparse(calls[0])
        self.assertIn("published_title", call)
        # The overlay as the script wrote it and the channel's language, not a stand-in for either.
        self.assertIn("thumbnail_overlay_text", call)
        self.assertIn("ctx.agent", call)
        self.assertIn("language", call)
        self.assertNotIn("SHOCKING", call)


if __name__ == "__main__":
    unittest.main()
