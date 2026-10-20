"""Keeping the fact-check on shipped text workable, and honest in every language.

Each rule here is a review finding on the first version of the shipped-text check:

* the description's noise (thank-yous, credits, series markers) and a bare title came back
  "unverifiable", which would hold nearly every video; an `unverifiable` fragment is now a
  warning, unless it is an accusation or the model says `likely_inaccurate`;
* a figure in the title or description that the narration never says is caught by a free
  deterministic check (`shipped_text_unsupported`, English channels; a leading count such as
  "5 Strange Facts" only warns when the script does not enumerate it);
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

    def test_it_is_split_on_lines_before_whitespace_is_collapsed(self):
        d = ("The relief crew found the lamp clean and the beds made.\n"
             "Music: Kevin MacLeod and friends\nhttps://example.com/the-full-story")
        self.assertEqual(self.sentences(d), ["The relief crew found the lamp clean and the beds made."])

    def test_lines_without_a_full_stop_are_separate_statements_not_one_run_on_sentence(self):
        d = "The relief crew found the lamp clean\nThe beds were all made that morning"
        self.assertEqual(self.sentences(d), ["The relief crew found the lamp clean",
                                             "The beds were all made that morning"])

    def test_a_link_is_stripped_and_the_rest_of_the_sentence_is_still_judged(self):
        """A statement that cites a link in passing is still a statement (it must not be a way to skip the check)."""
        self.assertEqual(
            self.sentences("Napoleon was poisoned by his closest friend (see https://example.com/a)."),
            ["Napoleon was poisoned by his closest friend."])
        self.assertEqual(self.sentences("Caesar murdered his own brother, see www.example.com/x for more."),
                         ["Caesar murdered his own brother, see for more."])

    def test_a_sentence_that_only_mentions_a_source_or_a_call_to_action_in_passing_is_kept(self):
        for line in ("Caesar murdered his own brother, source: Plutarch.",
                     "Historians don't forget that Caesar murdered his brother in cold blood.",
                     "The king forced his subjects to subscribe to a new tax on salt every year.",
                     "Nobody can follow us into the vault where the poisoned wine was kept."):
            with self.subTest(line=line):
                self.assertEqual(self.sentences(line), [line])

    def test_thank_yous_calls_to_action_and_credits_that_start_the_sentence_are_dropped_in_en_ru_uz(self):
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
            "👉 Subscribe now and never miss another story from the island.",
        ):
            with self.subTest(line=line):
                self.assertEqual(self.sentences(line), [])

    def test_a_short_sentence_with_a_call_to_action_anywhere_is_noise(self):
        for line in ("Please subscribe for more history!", "Support us: follow us today."):
            with self.subTest(line=line):
                self.assertEqual(self.sentences(line), [])

    def test_a_series_marker_is_not_a_statement(self):
        for line in ("Part 2 of our series on the island", "Chapter 3 begins with the storm", "Эпизод 4 про маяк",
                     "Qism 2 maydon haqida hikoya"):
            with self.subTest(line=line):
                self.assertEqual(self.sentences(line), [])
        self.assertEqual(self.sentences("Part of the blame lay with the relief crew that autumn."),
                         ["Part of the blame lay with the relief crew that autumn."])

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
        s = script("The king forced his subjects to subscribe to a new tax on salt every year.")
        self.assertEqual(ce.extract_section_claims(s), [])


# ── 1b. every fragment is a claim; an accusation word is recognised ───────

#: The accusation list by class of entry. A test fails when this and ``claim_extractor._ACCUSATION_WORDS`` differ,
#: so a word cannot be dropped (or added) without a line here that shows it matching.
ACCUSATION_WORDS = {
    "en past tense": ("murdered", "killed", "poisoned", "assassinated", "stole", "betrayed", "conspired",
                      "massacred", "tortured", "slaughtered", "beheaded", "executed", "bribed", "blackmailed",
                      "abused", "raped", "lied", "cheated", "stabbed"),
    "en present tense and person": ("murders", "murderer", "murderers", "kills", "poisons", "assassinates", "steals",
                                    "betrays", "tortures", "executes", "traitor", "liar"),
    "en nouns and phrases": ("framed for", "fraud", "genocide", "guilty", "murder", "poisoning", "assassination",
                             "massacre", "stabbing", "betrayal"),
    "ru verbs": ("убил", "убила", "убили", "отравил", "отравила", "отравили", "украл", "украла", "украли", "предал",
                 "предала", "предали", "казнил", "казнила", "казнили", "обманул", "обманула", "обманули", "пытал",
                 "пытали", "зарезал", "зарезали"),
    "ru participles and adjectives": ("убит", "убита", "убиты", "отравлен", "отравлена", "отравлены", "казнён",
                                      "казнен", "казнены", "виновен", "виновна", "виновны"),
    "ru persons": ("убийца", "убийцы", "предатель", "лжец", "мошенник", "мошенники"),
    "ru nouns and passives": ("убийство", "убийства", "отравление", "резня", "предательство", "зарезан", "зарезана",
                              "зарезаны"),
    "uz verbs and participles": ("o'ldirdi", "o'ldirgan", "o'ldirilgan", "o'ldirildi", "zaharladi", "zaharlangan",
                                 "zaharlandi", "o'g'irladi", "qiynadi"),
    "uz persons and nouns": ("qotil", "qotillar", "qotillik", "o'g'ri", "xiyonat", "aybdor", "jinoyatchi", "firibgar",
                             "qatl", "poraxo'r", "yolg'onchi", "josus"),
}

NOT_ACCUSATIONS = ("The Crimean War Explained", "Poison Dart Frogs", "Killer Whales", "The Executive Branch",
                   "Казна Рима", "казначейство", "Резной камень", "Skilled Sailors", "Crime Scene Photography",
                   "Abuse Of Power In Rome Explained", "Rapeseed Fields Of Kent", "The Lighthouse Log", "Murderous Plots",
                   "Poisonous Plants Of The Alps", "Massacres And Wars Of Rome", "Резной камень Рима",
                   "Резная шкатулка", "Убийственный взгляд", "Qotillarning orolidagi hayot",
                   "Что-то странное произошло здесь", "Ajoyib hikoya", "Poisonous Plants Of The Alps")


class EveryFragmentIsExtractedAndAccusationsAreRecognised(unittest.TestCase):
    def test_the_list_is_exactly_the_words_in_the_module(self):
        listed = {w for words in ACCUSATION_WORDS.values() for w in words}
        self.assertEqual(listed, set(ce._ACCUSATION_WORDS))

    def test_every_word_matches_in_a_sentence_and_only_as_a_whole_word(self):
        for cls, words in ACCUSATION_WORDS.items():
            for word in words:
                with self.subTest(cls=cls, word=word):
                    self.assertTrue(ce.has_accusation(f"They say he {word} them"), word)
                    self.assertTrue(ce.has_accusation(word.upper()), word)
                    self.assertFalse(ce.has_accusation(f"They say he {word}xyz them"), word)

    def test_the_probes_still_block_and_the_lookalikes_do_not(self):
        for text in ("Napoleon Was Poisoned", "Caesar murdered his own brother", "Наполеона отравили",
                     "Qotil orolda yashiringan edi", "Rome's Emperor Killed His Mother", "The Murder Of The Keeper",
                     "Caesar Was Stabbed", "Lead Poisoning In Rome", "The Massacre At The Lighthouse",
                     "Убийство смотрителя", "Резня на острове", "Xiyonat va qotillik"):
            with self.subTest(text=text):
                self.assertTrue(ce.has_accusation(text))
        for text in NOT_ACCUSATIONS:
            with self.subTest(text=text):
                self.assertFalse(ce.has_accusation(text))

    def test_every_title_hook_and_thumbnail_is_extracted_whatever_it_says_or_in_what_language(self):
        titles = ("The Lighthouse Log", "Einstein Failed Math", "Cleopatra Was Greek", "LOOK CLOSER",
                  "Что-то странное произошло здесь", "Ajoyib hikoya boshlandi", "爱因斯坦数学不及格",
                  "आइंस्टीन गणित में फेल हुए थे")
        for text in titles:
            with self.subTest(text=text):
                s = script("The keeper vanished in 1900 without a trace left behind.", title=text,
                           title_ab=text + " too", thumbnail_overlay_text=text + " now",
                           hook_sentence=text + " said the old keeper once.")
                got = {c.source for c in ce.extract_shipped_claims(s) if c.source != "narration"}
                self.assertEqual(got, {"title", "title_ab", "thumbnail_text", "hook_sentence"})

    def test_a_pure_question_title_is_still_skipped_as_in_narration(self):
        s = script("The keeper vanished in 1900 without a trace left behind.", title="Who killed the keeper?",
                   thumbnail_overlay_text="WHO KILLED THEM？")
        self.assertEqual([c for c in ce.extract_shipped_claims(s) if c.source != "narration"], [])

    def test_the_alternate_hook_and_the_description_ride_in_the_same_extraction(self):
        s = script("The keeper vanished in 1900 without a trace left behind.", title="",
                   hook_ab="The lamp was found burning at dawn on the island.",
                   description="The lamp was clean and the beds were made that morning.")
        shipped = {c.source for c in ce.extract_shipped_claims(s) if c.source != "narration"}
        self.assertEqual(shipped, {"hook_ab", "description"})

    def test_the_extra_texts_are_a_handful_in_the_one_batch(self):
        s = script("The keeper vanished in 1900 without a trace left behind.", title="A Title", title_ab="Another One",
                   thumbnail_overlay_text="LOOK", hook_sentence="The lamp burned at dawn.",
                   hook_ab="The alternate opening says something odd today.")
        extra = [c for c in ce.extract_shipped_claims(s) if c.source != "narration"]
        self.assertLessEqual(len(extra), 6)

    def test_a_source_line_loses_its_label_and_the_statement_after_it_is_extracted(self):
        s = script("The keeper vanished in 1900 without a trace left behind.", title="",
                   description="Source: Napoleon died of poison in exile.\nSources: Napoleon was poisoned by his friend.")
        got = [c.text for c in ce.extract_shipped_claims(s) if c.source == "description"]
        self.assertEqual(got, ["Napoleon died of poison in exile.", "Napoleon was poisoned by his friend."])


# ── 1c. a free check: shipped figures must be backed by the narration ─────

NARRATION = ("In December 1900 three keepers vanished. The relief crew counted 1,200 steps and "
             "forty thousand stones, and found nineteen hundred pages.")


def findings(narration, **over):
    return ce.shipped_number_findings(script(*([narration] if isinstance(narration, str) else narration), **over))


def none(f):
    return (f.large, f.small, f.counts) == ((), (), ())


class AFigureThatShipsMustBeInTheNarration(unittest.TestCase):
    def test_a_year_or_figure_the_narration_never_says_is_reported_with_its_field(self):
        got = findings(NARRATION, title="The 1,000,000 Victims", description="It began in 1899, they say.")
        self.assertEqual(got.large, (("title", "1,000,000"),))
        self.assertEqual(got.description, (("description", "1899"),))      # the description only warns (see below)

    def test_a_number_the_narration_says_is_supported_however_it_is_written(self):
        for text in ("Vanished In 1900", "1200 Steps", "1,200 Steps", "40,000 Stones", "1900 Pages",
                     "Vanished In ١٩٠٠", "Рим: 1 200 шагов"):
            with self.subTest(text=text):
                self.assertTrue(none(findings(NARRATION, title=text)), findings(NARRATION, title=text))

    def test_a_spaced_or_comma_grouped_figure_is_one_number(self):
        for narration, title in (("Rome lost 900 000 people.", "Рим потерял 900,000 человек"),
                                 ("Rome lost 900,000 people.", "Рим потерял 900 000 человек"),
                                 ("Rome lost 900 000 people.", "Рим потерял 900 000 человек")):
            with self.subTest(narration=narration, title=title):
                self.assertTrue(none(findings(narration, title=title)))
        got = findings("Rome lost many people in 1900.", title="Рим потерял 900 000 человек")
        self.assertEqual(got.large, (("title", "900 000"),))

    def test_spelled_out_years_read_as_two_pairs(self):
        narration = ("In nineteen eighty-four the ship sailed. Eighteen twelve was worse. In four seventy-six it fell. "
                     "Nineteen oh five was calm, and twenty twenty-four is now.")
        for text in ("1984", "Vanished In 1812", "476 AD", "1905 Was Calm", "Back In 2024"):
            with self.subTest(text=text):
                self.assertEqual(findings(narration, title=text).large, ())
        self.assertEqual(findings(narration, title="Vanished In 1900").large, (("title", "1900"),))
        self.assertEqual(ce._spoken_numbers("nineteen eighty-four, eighteen twelve, four seventy-six, "
                                            "nineteen oh five, twenty twenty-four, nineteen hundred.")
                         & {"1984", "1812", "476", "1905", "2024", "1900"},
                         {"1984", "1812", "476", "1905", "2024", "1900"})

    def test_ordinals_are_not_quantities_in_the_headline_or_in_the_narration(self):
        for text in ("The 20th Century Mystery", "1st Edition Of The Log", "The 2nd Keeper", "3rd Time Lucky",
                     "Конец 20-й смены"):
            with self.subTest(text=text):
                self.assertTrue(none(findings(NARRATION, title=text)))
        # "the 5th year" in the narration does not back "5 Men": it is an ordinal, not a quantity
        got = findings("In the 5th year the lamp failed. Three keepers left.", title="5 Men Who Changed Rome")
        self.assertEqual(got.small, (("title", "5"),))

    def test_a_figure_with_a_multiplier_matches_however_the_narration_says_it(self):
        for narration in ("It cost one and a half million dollars.", "It cost 1.5 million dollars.",
                          "It cost 1,500,000 dollars."):
            with self.subTest(narration=narration):
                self.assertTrue(none(findings(narration, title="1.5 Million Dollars Lost")))
        self.assertTrue(findings("It cost two million dollars.", title="1.5 Million Dollars Lost").hard)

    def test_description_credits_thank_yous_sources_and_series_lines_are_not_read(self):
        d = ("00:00 Intro\n#top10 #1900s\nSee https://example.com/v?id=8841 for sources.\nPart 2 of our series\n"
             "Sources: Smith (2019)\nMusic: Kevin 2.0\nThanks for watching, see you in 2 weeks.")
        self.assertTrue(none(findings(NARRATION, description=d)))

    def test_a_percentage_or_a_big_number_is_a_large_figure(self):
        self.assertEqual(findings(NARRATION, title="2000 Men Were Lost").large, (("title", "2000"),))
        self.assertEqual(findings(NARRATION, title="40% Of The Crew Died").large, (("title", "40"),))
        self.assertEqual(findings(NARRATION, title="5% Of The Crew Died").large, (("title", "5"),))
        self.assertEqual(findings(NARRATION, thumbnail_overlay_text="2000 DEAD").large, (("thumbnail_text", "2000"),))
        self.assertEqual(findings(NARRATION, title="476 AD").large, (("title", "476"),))

    def test_a_small_figure_that_is_a_person_or_an_event_is_hard_even_in_a_list_headline(self):
        for text in ("12 Dead", "25 Years Later", "17 Killed", "The 12 Dead Of The Lighthouse", "Top 9 Men",
                     "Why These 3 Men Ruined Rome", "5 Men Who Changed Rome", "Best 8 Soldiers",
                     "12 погибших", "25 лет спустя", "17 человек", "5 odam", "25 yil keyin"):
            with self.subTest(text=text):
                got = findings("Nobody wrote it down.", title=text)
                self.assertEqual((len(got.small), got.counts), (1, ()), text)

    def test_a_number_that_is_neither_a_count_nor_a_person_is_a_small_figure(self):
        for text in ("Chapter 7 Of The Log", "7:30 At The Lighthouse", "5.5 Of Them"):
            with self.subTest(text=text):
                self.assertTrue(findings("Nobody wrote it down.", title=text).hard)


class ListicleHeadlinesAreCountsNotFigures(unittest.TestCase):
    HEADLINES = (
        "Top 10 Mysteries of Rome", "The 7 Wonders of Rome", "Best 5 Roman Emperors", "Here Are 5 Strange Facts",
        "Rome: 7 Facts", "Rome's 5 Worst Emperors", "5 Strange Facts About The Ocean", "The 7 Facts About Keepers",
        "Топ 5 загадок Рима", "Рим: 7 фактов", "10 причин падения Рима", "Лучших 5 императоров",
        "Rim haqida 5 ta fakt", "Rim: 7 sir", "Eng 5 jumboq",
    )

    def test_an_unbacked_headline_count_is_a_warning_finding_never_a_hard_one(self):
        for text in self.HEADLINES:
            with self.subTest(text=text):
                got = findings("Nobody wrote it down.", title=text)
                self.assertEqual((got.large, got.small), ((), ()))
                self.assertEqual(len(got.counts), 1)

    def test_it_applies_to_title_ab_and_thumbnail_text_and_not_to_the_description(self):
        got = findings("Nobody wrote it down.", title_ab="9 Secrets", thumbnail_overlay_text="TOP 5",
                       description="9 secrets are told here in full.")
        self.assertEqual(sorted(got.counts), [("thumbnail_text", "5"), ("title_ab", "9")])
        self.assertEqual(got.description, (("description", "9"),))

    def test_enumerators_or_sections_back_it(self):
        five = "First a. Second b. Third c. Fourth d. Fifth e."
        self.assertEqual(findings(five, title="5 Strange Facts").counts, ())
        self.assertEqual(findings(five, title="Top 6 Facts").counts, (("title", "6"),))
        six_sections = [f"Section {i} says something here today." for i in range(6)]
        self.assertEqual(findings(six_sections, title="5 Strange Facts").counts, ())
        self.assertEqual(findings(six_sections[:3], title="7 Strange Facts").counts, (("title", "7"),))

    def test_the_narration_saying_n_of_the_same_noun_backs_it(self):
        for narration in ("There are five secrets in this log.", "Here are 5 secrets of the island.",
                          "Five strange secrets were found."):
            with self.subTest(narration=narration):
                self.assertEqual(findings(narration, title="5 Secrets Of The Island").counts, ())
        self.assertEqual(findings("There are five lamps in this log.", title="5 Secrets Of The Island").counts,
                         (("title", "5"),))

    def test_a_bare_digit_in_the_narration_no_longer_backs_a_count(self):
        for narration in ("In the 5th year the lamp failed.", "The 5 lamps burned.", "Chapter 5 begins here."):
            with self.subTest(narration=narration):
                self.assertEqual(findings(narration, title="5 Strange Facts").counts, (("title", "5"),))

    def test_a_count_of_one_or_over_thirty_is_a_figure(self):
        self.assertEqual(findings("Nobody wrote it down.", title="1 Keeper Vanished").small, (("title", "1"),))
        self.assertEqual(findings("Nobody wrote it down.", title="31 Facts").small, (("title", "31"),))

    def test_a_percentage_or_a_decimal_is_never_a_count(self):
        for text in ("5% Of The Facts", "5.5 Facts", "7:30 Facts"):
            with self.subTest(text=text):
                self.assertEqual(findings("Nobody wrote it down.", title=text).counts, ())


class TheGateReadsFindingsPerLanguage(unittest.TestCase):
    #: The narration writes numbers as digits ("1900", "1,200") and says nothing of 900 000.
    def gate(self, language, narration=NARRATION, **over):
        return publish_gate.evaluate_fact_check(script=script(narration, **over), fact_results=[], channel=channel(),
                                                narration_claims=1, language=language)

    def test_single_digits_alone_do_not_make_a_narration_one_that_writes_numbers_as_digits(self):
        narration = "В тот год пять смотрителей зажгли 3 лампы и ушли, а тысячи людей ждали."
        d = self.gate("Russian", narration, title="Рим потерял 900 000 человек")
        self.assertEqual((d.blocks, d.warnings), ([], ["shipped_text_unsupported"]))     # it spells "тысячи"
        self.assertEqual(ce.shipped_number_findings(script(narration, title="Рим потерял 900 000 человек")).large, ())

    def test_a_large_figure_the_narration_lacks_blocks_in_every_language(self):
        for language in ("English", "english", "en", "eng", "en-US", None, "", "Russian", "Uzbek", "Arabic", "Chinese"):
            with self.subTest(language=language):
                d = self.gate(language, title="Рим потерял 900 000 человек")
                self.assertEqual(d.blocks, ["shipped_text_unsupported"])
                self.assertEqual(d.fact_check["unsupported_numbers"], 1)
        d = self.gate("Russian", title="Рим пал в 1899 году")
        self.assertEqual(d.blocks, ["shipped_text_unsupported"])

    def test_with_a_narration_that_writes_no_number_as_digits_a_non_english_channel_only_warns_when_it_spells_the_magnitude(self):
        narration = "Рим пал много лет назад, и девятьсот тысяч человек погибли там."
        d = self.gate("Russian", narration, title="Рим потерял 900 000 человек")
        self.assertEqual((d.blocks, d.warnings), ([], ["shipped_text_unsupported"]))
        for language in ("English", "eng", None):
            self.assertEqual(self.gate(language, narration, title="Рим потерял 900 000 человек").blocks,
                             ["shipped_text_unsupported"])

    def test_a_small_figure_blocks_an_english_channel_and_only_warns_another(self):
        d = self.gate("English", title="17 Killed")
        self.assertEqual(d.blocks, ["shipped_text_unsupported"])
        d = self.gate("Russian", title="17 Killed")
        self.assertEqual((d.blocks, d.warnings), ([], ["shipped_text_unsupported"]))

    def test_a_count_is_always_a_warning(self):
        for language in ("English", "Russian"):
            d = self.gate(language, title="Top 10 Mysteries Of Rome")
            self.assertEqual((d.blocks, d.warnings), ([], ["shipped_count_unsupported"]))
            self.assertEqual(d.fact_check["unsupported_counts"], 1)

    def test_with_blocking_off_a_large_figure_is_a_warning(self):
        d = publish_gate.evaluate_fact_check(script=script(NARRATION, title="The 1,000,000 Victims"),
                                             fact_results=[], channel=channel({"block_on_fact_check": False}),
                                             narration_claims=1, language="English")
        self.assertEqual((d.blocks, d.warnings), ([], ["shipped_text_unsupported"]))

    def test_the_full_gate_reaches_the_same_verdict_for_the_language(self):
        orig = SimpleNamespace(check=lambda t: SimpleNamespace(is_duplicate=False, needs_review=False))
        for language in ("English", "Russian"):
            d = publish_gate.evaluate(script=script(NARRATION, title="The 1,000,000 Victims"), fact_results=[],
                                      channel=channel(), narration_claims=1, originality=orig, language=language)
            self.assertIn("shipped_text_unsupported", d.blocks, language)

    def test_a_script_whose_figures_are_all_backed_passes_in_any_language(self):
        for language in ("English", "Russian"):
            self.assertEqual(self.gate(language, title="Vanished In 1900").blocks, [])


# ── 1d. what an unverifiable fragment means ──────────────────────────────

def verdict(text, v, **kw):
    return _make_result(text, v, "r", **kw)


class UnverifiableFragmentsWarnButNarrationAndAccusationsBlock(unittest.TestCase):
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

    def test_a_figure_in_an_unverifiable_fragment_does_not_block_the_free_check_backs_figures(self):
        for text in ("5 Strange Facts About The Ocean", "Exactly 1900 men were lost there."):
            with self.subTest(text=text):
                d = self.gate([("description", text, "unverifiable")])
                self.assertEqual((d.blocks, d.warnings), ([], ["fact_check_fragments_unverified:1"]))

    def test_an_unverifiable_accusation_blocks_in_every_fragment_source(self):
        for src in ("title", "title_ab", "description", "thumbnail_text", "hook_sentence"):
            for text in ("Napoleon Was Poisoned", "Caesar murdered his own brother in cold blood.",
                         "Наполеона отравили", "Qotil orolda yashiringan edi"):
                with self.subTest(src=src, text=text):
                    self.assertEqual(self.gate([(src, text, "unverifiable")]).blocks, ["fact_check_flagged:1"])

    def test_every_other_unverifiable_fragment_only_warns(self):
        for src in ("title", "title_ab", "description", "thumbnail_text", "hook_sentence"):
            for text in ("Einstein Failed Math", "Cleopatra Was Greek", "The Keeper Never Returned"):
                with self.subTest(src=src, text=text):
                    d = self.gate([(src, text, "unverifiable")])
                    self.assertEqual(d.blocks, [])

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


# ── round 3 of the second delta review ───────────────────────────────────

ENUMERATED = ("First, a. Second, b. Third, c. Fourth, d. Fifth, e. Sixth, f. Seventh, g. Eighth, h. Ninth, i. "
              "Tenth, j.")


class AnyHeadlineNumberIsBackedByTheScriptWalkingThroughIt(unittest.TestCase):
    PROBES = ("5 Battles That Changed Rome", "7 Roman Emperors Who Went Mad", "10 Pharaohs Who Ruled Egypt",
              "3 Brothers Who Built Rome", "5 Roman Legends You Should Know", "7 Weird Roman Laws",
              "8 Hidden Cities of Rome", "6 Ancient Weapons", "10 Lost Civilizations", "Rome's 5 Battles",
              "Top 10 Mysteries of Rome", "The 7 Wonders of Rome")

    def test_a_script_that_enumerates_that_many_items_leaves_every_headline_alone(self):
        for text in self.PROBES:
            with self.subTest(text=text):
                self.assertTrue(none(findings(ENUMERATED, title=text)), findings(ENUMERATED, title=text))

    def test_so_do_enough_sections_and_the_narration_saying_n_of_the_same_noun(self):
        sections = [f"Section {i} says something here today." for i in range(11)]
        for text in self.PROBES:
            with self.subTest(text=text):
                self.assertTrue(none(findings(sections, title=text)))
        self.assertTrue(none(findings("Five battles shaped the city.", title="5 Battles That Changed Rome")))
        self.assertTrue(none(findings("Seven emperors went mad in turn.", title="7 Roman Emperors Who Went Mad")))

    def test_an_unbacked_headline_number_without_a_list_word_is_a_figure_with_a_list_word_a_count(self):
        for text in ("5 Battles That Changed Rome", "Rome's 5 Battles", "7 Roman Emperors Who Went Mad"):
            with self.subTest(text=text):
                got = findings("Nobody wrote it down.", title=text)
                self.assertEqual((len(got.small), got.counts), (1, ()))
        for text in ("Rome: 7 Facts", "Top 10 Mysteries of Rome"):
            got = findings("Nobody wrote it down.", title=text)
            self.assertEqual((got.small, len(got.counts)), ((), 1))

    def test_a_lead_in_alone_makes_a_list_headline_a_count_when_unbacked(self):
        for text in ("Best 5 Roman Emperors", "Top 8 Roman Emperors", "Worst 6 Roman Emperors",
                     "Лучших 5 императоров Рима", "Eng 5 imperator"):
            with self.subTest(text=text):
                got = findings("Nobody wrote it down.", title=text)
                self.assertEqual((got.small, len(got.counts)), ((), 1), text)

    def test_a_short_word_of_the_headline_does_not_back_a_number(self):
        got = findings("Five times who knows what happened.", title="5 Battles Who Changed Rome")
        self.assertEqual(len(got.small), 1)
        got = findings("Five times the battles raged.", title="5 Battles Who Changed Rome")
        self.assertEqual(got.small, ())

    def test_a_person_or_an_event_noun_keeps_a_number_hard_whatever_the_script_enumerates(self):
        for text in ("12 Dead", "25 Years Later", "17 Killed", "Rome in 7 Days", "Top 9 Men"):
            with self.subTest(text=text):
                got = findings(ENUMERATED + " " + ENUMERATED + " " + ENUMERATED, title=text)
                self.assertEqual(len(got.small), 1, text)

    def test_the_weak_lead_ins_do_not_say_list_by_themselves(self):
        for text in ("The 12 Senators Who Stabbed Caesar", "Rome Lost The 9 Legions", "These 20 Murdered Princes",
                     "Those 8 Keepers", "There Are 6 Lamps"):
            with self.subTest(text=text):
                got = findings("Nobody wrote it down.", title=text)
                self.assertEqual((len(got.small), got.counts), (1, ()), text)
        for text in ("The 7 Wonders of Rome", "These 5 Strange Facts", "Here Are 5 Secrets"):
            got = findings("Nobody wrote it down.", title=text)
            self.assertEqual((got.small, len(got.counts)), ((), 1), text)

    def test_a_percentage_a_decimal_and_a_time_are_still_not_headline_numbers(self):
        for text in ("5% Of Battles", "5.5 Battles", "7:30 Battles"):
            with self.subTest(text=text):
                self.assertEqual(findings(ENUMERATED, title=text).counts, ())
                self.assertTrue(findings(ENUMERATED, title=text).hard)


class ABoilerplateFigureInTheDescriptionOnlyWarns(unittest.TestCase):
    LINES = ("Filmed in 2019.", "(c) 2024 Nightshift Studio", "Copyright 2024 Nightshift Studio, all rights reserved.",
             "Updated 2024 with new footage.", "Recorded in 4K at 60 fps.", "Video length: 10 minutes.")

    def test_every_boilerplate_line_is_a_description_finding_not_a_hard_one(self):
        for line in self.LINES:
            with self.subTest(line=line):
                got = findings("Nobody wrote it down.", description=line)
                self.assertEqual(got.hard, ())
                self.assertTrue(got.description, line)

    def test_the_gate_warns_in_every_language_and_never_blocks(self):
        for language in ("English", "Russian", None):
            for line in self.LINES:
                with self.subTest(language=language, line=line):
                    d = publish_gate.evaluate_fact_check(script=script("Nobody wrote it down.", description=line),
                                                         fact_results=[], channel=channel(), narration_claims=1,
                                                         language=language)
                    self.assertEqual((d.blocks, d.warnings), ([], ["shipped_description_unsupported"]))
                    self.assertGreaterEqual(d.fact_check["unsupported_description"], 1)

    def test_title_and_thumbnail_figures_are_unchanged_and_still_block_english(self):
        for field in ("title", "title_ab", "thumbnail_overlay_text"):
            d = publish_gate.evaluate_fact_check(script=script(NARRATION, **{field: "The 1,000,000 Victims"}),
                                                 fact_results=[], channel=channel(), narration_claims=1,
                                                 language="English")
            self.assertEqual(d.blocks, ["shipped_text_unsupported"], field)

    def test_a_description_accusation_the_checker_could_not_confirm_still_blocks(self):
        claims = [claim("description", "Caesar murdered his own brother in cold blood.")]
        d = publish_gate.evaluate_fact_check(
            script=script(NARRATION), fact_results=[verdict(claims[0].text, "unverifiable")], channel=channel(),
            narration_claims=1, claims=claims)
        self.assertEqual(d.blocks, ["fact_check_flagged:1"])


class ANarrationWithNoNumeralsAndNoMagnitudeWordIsTheFabricationShape(unittest.TestCase):
    RU_PLAIN = "Рим пал много лет назад, и люди там погибли."
    UZ_PLAIN = "Rim koʻp yillar oldin quladi va odamlar halok boʻldi."

    def large(self, narration, **over):
        return ce.shipped_number_findings(script(narration, **over))

    def test_a_figure_of_a_thousand_or_more_blocks_when_the_narration_names_no_magnitude(self):
        for narration, title in ((self.RU_PLAIN, "Рим потерял 900 000 человек"), (self.RU_PLAIN, "Рим пал в 1900 году"),
                                 (self.UZ_PLAIN, "Rim 900 000 kishini yoʻqotdi")):
            with self.subTest(title=title):
                got = self.large(narration, title=title)
                self.assertEqual((len(got.large), got.large_soft), (1, ()))
                d = publish_gate.evaluate_fact_check(script=script(narration, title=title), fact_results=[],
                                                     channel=channel(), narration_claims=1, language="Russian")
                self.assertEqual(d.blocks, ["shipped_text_unsupported"])

    def test_each_magnitude_word_downgrades_to_a_warning(self):
        for word in ("тысяч", "тысяча", "тысячи", "тысячу", "миллион", "миллионов", "миллиард", "миллиарда"):
            with self.subTest(word=word):
                got = self.large(f"Рим пал, {word} людей погибли.", title="Рим потерял 900 000 человек")
                self.assertEqual((got.large, len(got.large_soft)), ((), 1))
        for word in ("ming", "million", "millionlab", "milliard"):
            with self.subTest(word=word):
                got = self.large(f"Rim quladi, {word} odam halok boʻldi.", title="Rim 900 000 kishini yoʻqotdi")
                self.assertEqual((got.large, len(got.large_soft)), ((), 1))

    def test_a_million_needs_a_million_word_a_thousand_word_is_not_enough(self):
        got = self.large("Рим пал, тысячи людей погибли.", title="Рим потерял 5 000 000 человек")
        self.assertEqual((len(got.large), got.large_soft), (1, ()))
        got = self.large("Рим пал, миллионы людей погибли.", title="Рим потерял 5 000 000 человек")
        self.assertEqual((got.large, len(got.large_soft)), ((), 1))
        got = self.large("Рим пал, миллионы людей погибли.", title="Рим потерял 5 000 человек")
        self.assertEqual((got.large, len(got.large_soft)), ((), 1))

    def test_a_three_digit_figure_or_a_percentage_still_only_warns(self):
        for title in ("Рим потерял 500 человек", "Потери Рима: 40% армии"):
            with self.subTest(title=title):
                got = self.large(self.RU_PLAIN, title=title)
                self.assertEqual((got.large, len(got.large_soft)), ((), 1))

    def test_a_narration_that_writes_digits_never_downgrades(self):
        got = self.large("Рим пал в 1900 году, и тысячи людей погибли.", title="Рим потерял 900 000 человек")
        self.assertEqual((len(got.large), got.large_soft), (1, ()))

    def test_english_blocks_whatever_the_narration_spells(self):
        for language in ("English", "eng", None):
            d = publish_gate.evaluate_fact_check(
                script=script("Rome fell long ago and thousands died.", title="Rome lost 900 000 people"),
                fact_results=[], channel=channel(), narration_claims=1, language=language)
            self.assertEqual(d.blocks, ["shipped_text_unsupported"], language)


class SpaceGroupedNumbersEndAtTheirThirdDigitGroup(unittest.TestCase):
    def tokens(self, text):
        return [t[0] for t in ce._digit_tokens(text)]

    def test_a_year_after_a_small_number_is_its_own_number(self):
        self.assertEqual(self.tokens("Died March 5 1953"), ["5", "1953"])
        self.assertEqual(self.tokens("Apollo 11 1969"), ["11", "1969"])
        self.assertEqual(self.tokens("On 2 May 1945 and 12 June 1944"), ["2", "1945", "12", "1944"])

    def test_real_groups_are_still_one_number(self):
        self.assertEqual(self.tokens("Рим потерял 900 000 человек"), ["900 000"])
        self.assertEqual(self.tokens("1 200 000 and 25 000"), ["1 200 000", "25 000"])
        self.assertEqual(self.tokens("lost 900 000 men"), ["900 000"])
        self.assertEqual(self.tokens("In 2020 500 men"), ["2020", "500"])

    def test_the_two_probes_reach_the_findings_as_two_numbers(self):
        got = findings("Nobody wrote it down in 1953.", title="Died March 5 1953")
        self.assertEqual(got.large, ())                                  # 1953 is in the narration; 5 is a date
        got = findings("Nobody wrote it down.", title="Apollo 11 1969")
        self.assertEqual(got.large, (("title", "1969"),))
