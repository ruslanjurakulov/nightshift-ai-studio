"""Keeping the fact-check on shipped text workable, and honest in every language.

Each rule here is a review finding on the first version of the shipped-text check:

* the description's noise (links, thank-yous, credits) and a bare rhetorical title
  were checked as claims and came back "unverifiable", which would hold nearly every
  video; an `unverifiable` fragment is now a warning unless it carries a figure;
* a number in the title or description that the narration never says is caught by a
  free deterministic check (`shipped_text_unsupported`);
* Chinese/Japanese narration (no spaces), Hindi (danda) and Arabic (question mark) were
  invisible to the extractor and the 50-word floor, so they passed unchecked;
* the checker's "could not read my own answer" sentinel looked like a flagged claim;
* a title YouTube would refuse cost a full render before the gate said so.

Every rule is restrictive against main: fragments were not checked there at all.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import claim_extractor as ce  # noqa: E402
from modules import fact_checker, publish_gate  # noqa: E402
from modules.fact_checker import _make_result  # noqa: E402

# One sample per language: two statements (and, for Arabic, a question between them).
SAMPLES = {
    "zh": ("他于1900年在灯塔里神秘地消失了。没有人知道那天夜里到底发生了什么。", 2),
    "ja": ("彼は1900年に灯台から忽然と姿を消した。その夜に何が起きたのか誰も知らない。", 2),
    "hi": ("वह 1900 में रहस्यमय तरीके से लाइटहाउस से गायब हो गया। उस रात क्या हुआ यह कोई नहीं जानता।", 2),
    "ar": ("اختفى الحارس عام 1900 في ظروف غامضة. هل عرف أحد ما حدث تلك الليلة؟ لا أحد يعرف ما حدث هناك.", 2),
    "ko": ("그는 1900년에 등대에서 미스터리하게 사라졌다. 그날 밤 무슨 일이 있었는지 아무도 모른다.", 2),
    "ru": ("Смотритель исчез в 1900 году при загадочных обстоятельствах. Никто не знает, что случилось той ночью.", 2),
    "uz": ("Qorovul 1900-yilda sirli ravishda yoʻqoldi. Oʻsha kechasi nima boʻlganini hech kim bilmaydi.", 2),
}
QUESTIONS = {
    "zh": "那个守塔人到底去了哪里？",
    "ja": "あの灯台守はいったいどこへ消えたのですか？",
    "ar": "أين ذهب حارس المنارة في تلك الليلة المظلمة؟",
    "hi": "आख़िर वह लाइटहाउस का रखवाला उस रात कहाँ चला गया? ",
    "ko": "그 등대지기는 도대체 어디로 사라진 걸까요?",
}


def section(text):
    return SimpleNamespace(narration=text, clean_narration=lambda t=text: t)


def script(*texts, **over):
    base = dict(topic="t", title="A Fine Title", title_ab="", description="", hook_ab="", hook_sentence="",
                thumbnail_overlay_text="", sections=[section(t) for t in texts])
    base.update(over)
    return SimpleNamespace(**base)


def channel(cfg=None):
    return SimpleNamespace(agent=SimpleNamespace(publish_gate=cfg or {}))


def claim(source, text, section_index=-1, n=1):
    return ce.Claim(f"x-{source}-{n}", section_index, text, source)


# ── 1a. description noise ────────────────────────────────────────────────

class DescriptionCarriesOnlyStatements(unittest.TestCase):
    def sentences(self, description):
        return ce._description_sentences(description)

    def test_lines_without_a_full_stop_are_separate_statements_not_one_run_on_sentence(self):
        d = "The relief crew found the lamp clean\nThe beds were all made that morning"
        self.assertEqual(self.sentences(d), ["The relief crew found the lamp clean",
                                             "The beds were all made that morning"])

    def test_it_is_split_on_lines_before_whitespace_is_collapsed(self):
        d = ("The relief crew found the lamp clean and the beds made.\n"
             "Music: Kevin MacLeod and friends\nhttps://example.com/the-full-story")
        self.assertEqual(self.sentences(d), ["The relief crew found the lamp clean and the beds made."])

    def test_a_sentence_with_a_link_in_it_is_dropped(self):
        self.assertEqual(self.sentences("Read the full account at https://example.com/story for more detail."), [])
        self.assertEqual(self.sentences("The full account lives at www.example.com today, as it always did."), [])

    def test_thank_yous_calls_to_action_and_credits_are_dropped_in_en_ru_uz(self):
        for line in (
            "Thanks for watching this story about the island today.",
            "Don't forget to like this video and share it with friends.",
            "Follow us everywhere for stories like this one every week.",
            "Share this with someone who loves a good mystery.",
            "Music: licensed from a stock library for this video.",
            "Credits: archive footage courtesy of the national library.",
            "Спасибо за просмотр, увидимся в следующем видео совсем скоро.",
            "Подписывайся на канал, чтобы не пропустить новые истории.",
            "Не забудьте поставить лайк и рассказать друзьям об этом.",
            "Музыка: из бесплатной библиотеки звуков для видео.",
            "Ko‘rgani uchun rahmat, keyingi videoda yana uchrashamiz albatta.",
            "Obuna bo'ling va yangi hikoyalarni oʻtkazib yubormang aslo.",
            "Musiqa: bepul kutubxonadan olingan fon musiqasi shu videoga.",
        ):
            with self.subTest(line=line):
                self.assertEqual(self.sentences(line), [])

    def test_a_real_statement_survives_in_every_language(self):
        for line in ("In December 1900 three keepers vanished from a remote island.",
                     "В декабре 1900 года три смотрителя исчезли с далёкого острова.",
                     "1900-yil dekabrida uch qorovul uzoq orolda iz-tuzsiz yoʻqoldi."):
            with self.subTest(line=line):
                self.assertEqual(self.sentences(line), [line])

    def test_timestamp_and_hashtag_lines_are_still_not_read(self):
        d = "00:00 The Discovery\n#lighthouse #mystery\nThe lamp was clean and the beds were made."
        self.assertEqual(self.sentences(d), ["The lamp was clean and the beds were made."])

    def test_narration_keeps_the_stricter_filter(self):
        """The thank-you list is description-only: a narration line is checked as it always was."""
        s = script("Thanks for watching this story about the island today.")
        self.assertEqual([c.text for c in ce.extract_section_claims(s)],
                         ["Thanks for watching this story about the island today."])


# ── 1b. a fragment is a claim only when it asserts something ──────────────

class FragmentsAreClaimsOnlyWhenTheyAssert(unittest.TestCase):
    def test_bare_phrases_in_three_languages_are_not_claims(self):
        for text in ("The Lighthouse Log", "Something Strange Happened Here", "LOOK CLOSER",
                     "Что-то странное произошло здесь", "Ajoyib hikoya boshlandi", "Maroqli voqea"):
            with self.subTest(text=text):
                self.assertFalse(ce.carries_checkable_content(text))

    def test_a_number_a_year_an_accusation_or_an_absolute_makes_it_a_claim(self):
        for text in ("Rome Fell In 410", "The Keeper Murdered Them", "NEVER OPENED!", "The Deadliest Night",
                     "Они убили всех на острове", "Самый тёмный день маяка", "Никто не вернулся",
                     "Qotil orolda yashiringan edi", "Eng katta sir ochildi", "Hech kim qaytmadi",
                     "Aybdor kim ekani aniq", "Owl Island Of O‘g‘ri"):
            with self.subTest(text=text):
                self.assertTrue(ce.carries_checkable_content(text))

    def test_extraction_applies_it_to_title_ab_thumbnail_and_hook_sentence(self):
        s = script("The keeper vanished in 1900 without a trace left behind.",
                   title="The Lighthouse Log", title_ab="Rome Fell In 410", thumbnail_overlay_text="LOOK CLOSER",
                   hook_sentence="The lamp was found burning at dawn.")
        shipped = {c.source: c.text for c in ce.extract_shipped_claims(s) if c.source != "narration"}
        self.assertEqual(shipped, {"title_ab": "Rome Fell In 410"})

    def test_the_alternate_hook_and_the_description_are_not_filtered_this_way(self):
        s = script("The keeper vanished in 1900 without a trace left behind.",
                   hook_ab="The lamp was found burning at dawn on the island.",
                   description="The lamp was clean and the beds were made that morning.")
        shipped = {c.source for c in ce.extract_shipped_claims(s) if c.source != "narration"}
        self.assertEqual(shipped, {"hook_ab", "description"})


# ── 1c. a free check: shipped numbers must be in the narration ────────────

NARRATION = ("In December 1900 three keepers vanished. The relief crew counted 1,200 steps and "
             "forty thousand stones, and found nineteen hundred pages.")


class ANumberThatShipsMustBeInTheNarration(unittest.TestCase):
    def missing(self, **over):
        return ce.unsupported_numbers(script(NARRATION, **over))

    def test_a_year_or_figure_the_narration_never_says_is_reported_with_its_field(self):
        got = self.missing(title="The 1,000,000 Victims", description="It began in 1899, they say.")
        self.assertEqual(sorted(got), [("description", "1899"), ("title", "1,000,000")])

    def test_a_number_the_narration_says_is_supported_however_it_is_written(self):
        for text in ("Vanished In 1900", "1200 Steps", "1,200 Steps", "3 Keepers Vanished", "40,000 Stones",
                     "1900 Pages", "Vanished In ١٩٠٠"):
            with self.subTest(text=text):
                self.assertEqual(self.missing(title=text), [])

    def test_a_title_ab_and_the_thumbnail_text_are_read_too(self):
        got = self.missing(title_ab="Why 7 Fell", thumbnail_overlay_text="2000 DEAD")
        self.assertEqual(sorted(got), [("thumbnail_text", "2000"), ("title_ab", "7")])

    def test_links_timestamps_and_hashtags_in_the_description_are_not_read(self):
        d = "00:00 Intro\n00:15 Part 2\n#top10 #1900s\nSee https://example.com/v?id=8841 for sources."
        self.assertEqual(self.missing(description=d), [])

    def test_it_blocks_in_the_gate_and_in_the_early_stop_with_a_closed_word(self):
        s = script(NARRATION, title="The 1,000,000 Victims")
        for decision in (
            publish_gate.evaluate_fact_check(script=s, fact_results=[_make_result("x", "likely_accurate", "")],
                                             channel=channel(), narration_claims=1),
            publish_gate.evaluate(script=s, fact_results=[_make_result("x", "likely_accurate", "")],
                                  channel=channel(), narration_claims=1,
                                  originality=SimpleNamespace(check=lambda t: SimpleNamespace(
                                      is_duplicate=False, needs_review=False))),
        ):
            self.assertIn("shipped_text_unsupported", decision.blocks)
            self.assertEqual(decision.fact_check["unsupported_numbers"], 1)

    def test_it_is_only_a_warning_when_the_channel_turned_fact_check_blocking_off(self):
        d = publish_gate.evaluate_fact_check(script=script(NARRATION, title="The 1,000,000 Victims"),
                                             fact_results=[], channel=channel({"block_on_fact_check": False}),
                                             narration_claims=1)
        self.assertEqual((d.blocks, d.warnings), ([], ["shipped_text_unsupported"]))

    def test_a_script_whose_numbers_are_all_in_the_narration_passes(self):
        d = publish_gate.evaluate_fact_check(script=script(NARRATION, title="Vanished In 1900"),
                                             fact_results=[], channel=channel(), narration_claims=1)
        self.assertEqual(d.blocks, [])


# ── 1d. what an unverifiable fragment means ──────────────────────────────

def verdict(text, v, **kw):
    return _make_result(text, v, "r", **kw)


class UnverifiableFragmentsWarnButNarrationBlocks(unittest.TestCase):
    def gate(self, pairs, early=False, cfg=None):
        claims = [claim(src, text, n=i) for i, (src, text, _) in enumerate(pairs, 1)]
        results = [verdict(text, v) for _, text, v in pairs]
        fn = publish_gate.evaluate_fact_check
        return fn(script=script(NARRATION), fact_results=results, channel=channel(cfg),
                  narration_claims=1, claims=claims)

    def test_an_unverifiable_title_is_a_warning(self):
        d = self.gate([("narration", "It ended in 1900.", "likely_accurate"),
                       ("title", "The Keeper Never Returned", "unverifiable")])
        self.assertEqual(d.blocks, [])
        self.assertEqual(d.warnings, ["fact_check_fragments_unverified:1"])
        self.assertEqual(d.fact_check["fragments_unverified"], 1)

    def test_a_likely_inaccurate_fragment_blocks(self):
        d = self.gate([("title", "The Keeper Never Returned", "likely_inaccurate")])
        self.assertEqual(d.blocks, ["fact_check_flagged:1"])

    def test_an_unverifiable_fragment_with_a_figure_blocks(self):
        d = self.gate([("description", "Exactly 1900 men were lost there.", "unverifiable")])
        self.assertEqual(d.blocks, ["fact_check_flagged:1"])

    def test_every_fragment_source_follows_the_rule(self):
        for src in ("title", "title_ab", "description", "thumbnail_text", "hook_sentence"):
            with self.subTest(src=src):
                self.assertEqual(self.gate([(src, "The Keeper Never Returned", "unverifiable")]).blocks, [])

    def test_narration_and_the_alternate_hook_keep_todays_rule(self):
        for src in ("narration", "hook_ab"):
            with self.subTest(src=src):
                d = self.gate([(src, "The Keeper Never Returned", "unverifiable")])
                self.assertEqual(d.blocks, ["fact_check_flagged:1"])

    def test_claims_that_do_not_line_up_with_the_results_are_all_read_as_narration(self):
        claims = [claim("title", "The Keeper Never Returned")]
        results = [verdict("A different sentence entirely here", "unverifiable")]
        d = publish_gate.evaluate_fact_check(script=script(NARRATION), fact_results=results, channel=channel(),
                                             narration_claims=1, claims=claims)
        self.assertEqual(d.blocks, ["fact_check_flagged:1"])
        d = publish_gate.evaluate_fact_check(script=script(NARRATION), fact_results=results * 2, channel=channel(),
                                             narration_claims=1, claims=claims)
        self.assertEqual(d.blocks, ["fact_check_flagged:2"])

    def test_with_no_claims_passed_the_gate_is_exactly_as_strict_as_before(self):
        d = publish_gate.evaluate_fact_check(script=script(NARRATION),
                                             fact_results=[verdict("A sentence here for you", "unverifiable")],
                                             channel=channel(), narration_claims=1)
        self.assertEqual(d.blocks, ["fact_check_flagged:1"])

    def test_a_warning_when_blocking_is_off_and_nothing_changes_for_it(self):
        d = self.gate([("title", "The Keeper Never Returned", "likely_inaccurate")],
                      cfg={"block_on_fact_check": False})
        self.assertEqual((d.blocks, d.warnings), ([], ["fact_check_flagged:1"]))


# ── 2. every script is read, not only the ones written with spaces ────────

class EveryLanguageIsSplitAndCounted(unittest.TestCase):
    def test_each_language_is_split_into_its_statements(self):
        for lang, (text, expected) in SAMPLES.items():
            with self.subTest(lang=lang):
                claims = ce.extract_section_claims(script(text))
                self.assertEqual(len(claims), expected, [c.text for c in claims])

    def test_a_question_in_any_script_is_not_a_claim(self):
        for lang, text in QUESTIONS.items():
            with self.subTest(lang=lang):
                self.assertEqual(ce.extract_section_claims(script(text * 2)), [])

    def test_an_unspaced_narration_is_counted_by_characters_not_as_two_words(self):
        zh = SAMPLES["zh"][0]
        self.assertGreater(ce.count_words(zh), 10)
        self.assertEqual(ce.count_words("one two three"), 3)
        self.assertGreater(ce.narration_char_count(script(zh)), 20)

    def test_the_hindi_danda_the_arabic_question_mark_and_the_fullwidth_one_are_recognised(self):
        self.assertEqual(len(ce._split_sentences("पहला वाक्य यहाँ पूरा होता है। दूसरा वाक्य यहाँ पूरा होता है।")), 2)
        self.assertTrue(ce._looks_like_claim("هذه جملة طويلة بما يكفي لتكون ادعاء."))
        self.assertFalse(ce._looks_like_claim("هل هذه جملة طويلة بما يكفي لتكون سؤالا؟"))
        self.assertFalse(ce._looks_like_claim("这到底是不是一个足够长的问题的句子？"))

    def test_english_extraction_is_unchanged(self):
        text = "Dr. Smith arrived on 3.5 million pounds of salt. Who sent it? Subscribe now. He left at dawn alone."
        self.assertEqual([c.text for c in ce.extract_section_claims(script(text))],
                         ["Dr. Smith arrived on 3.5 million pounds of salt.", "He left at dawn alone."])


class ALongScriptWithNoClaimIsHeldInEveryScript(unittest.TestCase):
    def hold(self, text, results=()):
        s = script(text)
        claims = ce.extract_section_claims(s)
        d = publish_gate.evaluate_fact_check(script=s, fact_results=list(results), channel=channel(),
                                             narration_claims=len(claims))
        return d.blocks

    def test_unspaced_narration_of_only_questions_is_held(self):
        for lang in ("zh", "ja", "ar", "ko"):
            with self.subTest(lang=lang):
                text = QUESTIONS[lang] * 30
                self.assertGreaterEqual(ce.narration_char_count(script(text)), publish_gate.MIN_CHARS_FOR_CLAIM_CHECK)
                self.assertEqual(self.hold(text), ["fact_check_no_claims"])

    def test_the_same_text_below_the_character_floor_is_not_held(self):
        for lang in ("zh", "ja"):
            with self.subTest(lang=lang):
                self.assertEqual(self.hold(QUESTIONS[lang] * 2), [])

    def test_a_chinese_narration_with_statements_has_claims_and_is_not_held_for_having_none(self):
        text = SAMPLES["zh"][0] * 15
        self.assertGreater(len(ce.extract_section_claims(script(text))), 0)
        self.assertEqual(self.hold(text, [_make_result("c", "likely_accurate", "")]), [])

    def test_the_character_floor_applies_to_a_spaced_script_with_long_words_too(self):
        text = "Extraordinary circumstances surrounding disappearances nobody understood? " * 6
        self.assertLess(ce.narration_word_count(script(text)), publish_gate.MIN_WORDS_FOR_CLAIM_CHECK)
        self.assertGreaterEqual(ce.narration_char_count(script(text)), publish_gate.MIN_CHARS_FOR_CLAIM_CHECK)
        self.assertEqual(self.hold(text), ["fact_check_no_claims"])


# ── 7. the checker's sentinel is not a finding ───────────────────────────

class AnUnresolvedBatchIsNotAClaimProblem(unittest.TestCase):
    def results(self, n_unresolved, n_flagged=0):
        out = [fact_checker._safe_default(f"A sentence number {i} that could not be read.") for i in range(n_unresolved)]
        out += [verdict(f"A real flagged sentence number {i} here.", "unverifiable") for i in range(n_flagged)]
        return out

    def test_the_sentinel_is_marked_and_a_real_verdict_is_not(self):
        self.assertTrue(fact_checker._safe_default("A sentence that was never read.").unresolved)
        self.assertFalse(_make_result("x", "unverifiable", "no idea").unresolved)

    def test_the_early_stop_never_holds_for_it(self):
        d = publish_gate.evaluate_fact_check(script=script(NARRATION), fact_results=self.results(5), channel=channel(),
                                             narration_claims=5)
        self.assertEqual(d.blocks, [])
        self.assertEqual(d.fact_check["unresolved"], 5)
        self.assertEqual(d.fact_check["flagged"], 0)

    def test_it_is_not_counted_among_the_flagged_claims_when_real_ones_exist(self):
        d = publish_gate.evaluate_fact_check(script=script(NARRATION), fact_results=self.results(3, 2),
                                             channel=channel(), narration_claims=5)
        self.assertEqual(d.blocks, ["fact_check_flagged:2"])

    def test_the_final_gate_holds_it_under_its_own_word(self):
        d = publish_gate.evaluate(script=script(NARRATION), fact_results=self.results(3, 2), channel=channel(),
                                  narration_claims=5,
                                  originality=SimpleNamespace(check=lambda t: SimpleNamespace(
                                      is_duplicate=False, needs_review=False)))
        self.assertEqual(sorted(b for b in d.blocks if b.startswith("fact_check")),
                         ["fact_check_flagged:2", "fact_check_unresolved:3"])

    def test_with_blocking_off_it_is_a_warning(self):
        d = publish_gate.evaluate(script=script(NARRATION), fact_results=self.results(3), channel=channel(
            {"block_on_fact_check": False}), narration_claims=3,
            originality=SimpleNamespace(check=lambda t: SimpleNamespace(is_duplicate=False, needs_review=False)))
        self.assertIn("fact_check_unresolved:3", d.warnings)
        self.assertEqual([b for b in d.blocks if b.startswith("fact_check")], [])


# ── 8. a title YouTube would refuse is caught before the render ───────────

class ADoomedTitleIsCaughtEarly(unittest.TestCase):
    def early(self, **over):
        return publish_gate.evaluate_fact_check(script=script(NARRATION, **over), fact_results=[],
                                                channel=channel(over.pop("cfg", None)), narration_claims=1).blocks

    def test_a_title_over_100_characters_holds_early(self):
        self.assertEqual(self.early(title="x" * 101), ["title_over_100_chars"])

    def test_the_alternative_title_is_checked_as_well_under_its_own_name(self):
        self.assertEqual(self.early(title_ab="y" * 101), ["title_ab_over_100_chars"])

    def test_angle_brackets_hold_early_in_either_title(self):
        self.assertEqual(self.early(title="Rome <b>fell</b>"), ["title_has_angle_brackets"])
        self.assertEqual(self.early(title_ab="Rome >fell"), ["title_ab_has_angle_brackets"])

    def test_a_valid_title_and_no_alternative_pass(self):
        self.assertEqual(self.early(title="Fine", title_ab=""), [])
        self.assertEqual(self.early(title="ё" * 100), [])      # 100 characters, 200 bytes: the API counts characters

    def test_it_is_a_warning_when_the_channel_turned_sanity_off(self):
        d = publish_gate.evaluate_fact_check(script=script(NARRATION, title="x" * 101), fact_results=[],
                                             channel=channel({"block_on_sanity": False}), narration_claims=1)
        self.assertEqual((d.blocks, d.warnings), ([], ["title_over_100_chars"]))


if __name__ == "__main__":
    unittest.main()
