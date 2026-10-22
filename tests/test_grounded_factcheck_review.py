"""Independent review of #564: the claim "grounding can only be strict" was not true as implemented.

Each class below is one finding of that review, written as a failing test first. The cases of the
reviewer's prototypes (negation, hedges outside the quote, number groups, same quote for every claim)
are kept here as regression cases.

 1 a checker verdict that was CLAMPED (the model said something outside the three words) is never
   upgraded: its real verdict is unknown ...................................... AClampedVerdictIsNeverUpgraded
 2 negation and hedges are read over the WHOLE sentence of the quote ........... TheWholeSentenceIsRead
 3 names, enough shared words, and a cap on clearances ......................... NamesWordsAndCaps
 4 one group per number, eras, regnal numbers ................................. EveryNumberIsBacked
 7 client: no redirects, byte cap, total timeout, few requests, second chance,
   reuse of grounding.json ................................................... TheClientIsHardened
 8 the two survivors ........................................................... TheTwoSurvivors
"""

from __future__ import annotations

import json
import logging
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import claim_scenes, fact_checker, grounding, held_video  # noqa: E402
from modules.claim_extractor import Claim  # noqa: E402
from modules.fact_checker import _make_result, _safe_default  # noqa: E402
from modules.grounding import Evidence, Snippet  # noqa: E402
from tests.test_grounded_factcheck import (  # noqa: E402
    CLAIM_ADRIFT, QUOTE_ADRIFT, Clock, FakeHttp, FakeModel, FakeResponse, api, client_for, ground, mary_celeste_router,
    page, says, unchecked)


def S(text, id="W1"):
    return Snippet(id, "T", "https://en.wikipedia.org/wiki/T", text)


# ── 1 ───────────────────────────────────────────────────────────────────────────

class AClampedVerdictIsNeverUpgraded(unittest.TestCase):
    def test_a_verdict_outside_the_three_words_is_marked_clamped_with_a_safe_copy_of_the_word(self):
        r = _make_result("A claim here.", "accurate", "x")
        self.assertEqual((r.verdict, r.clamped, r.raw_verdict), ("unverifiable", True, "accurate"))
        self.assertTrue(r.requires_human_review)
        self.assertEqual(_make_result("A claim.", "likely_accurate", "x").clamped, False)
        self.assertIsNone(_make_result("A claim.", "likely_accurate", "x").raw_verdict)
        self.assertEqual(_make_result("A claim.", None, "x").raw_verdict, "None")
        weird = _make_result("A claim.", "trüe\n<script>" + "x" * 80, "x")
        self.assertTrue(weird.raw_verdict.isascii() and weird.raw_verdict.isprintable())
        self.assertLessEqual(len(weird.raw_verdict), 24)
        self.assertNotIn("<", weird.raw_verdict)
        self.assertEqual(_make_result("A claim.", ["x"], "x").clamped, True)

    def test_the_sentinel_is_unresolved_not_clamped(self):
        self.assertEqual((_safe_default("A claim.").clamped, _safe_default("A claim.").unresolved), (False, True))

    def test_grounding_does_not_upgrade_a_clamped_result_however_good_the_quote(self):
        r = _make_result(CLAIM_ADRIFT, "accurate", "x")          # what the model really said is unknown
        out, summary, _c, _r = ground([CLAIM_ADRIFT], [r], model=says("supported", QUOTE_ADRIFT))
        self.assertTrue(out[0].requires_human_review)
        self.assertEqual(out[0].grounding["reason"], "checker_verdict_clamped")
        self.assertEqual(out[0].grounding["effect"], "none")
        self.assertEqual((summary.upgraded, summary.clamped_verdicts), (0, 1))
        self.assertEqual(summary.to_dict()["clamped_verdicts"], 1)

    def test_it_may_still_add_a_contradiction_flag_to_a_clamped_result(self):
        r = _make_result(CLAIM_ADRIFT, "true", "x")
        out, summary, _c, _r = ground([CLAIM_ADRIFT], [r], model=says("contradicted", QUOTE_ADRIFT))
        self.assertEqual(out[0].grounding["effect"], "flagged")
        self.assertEqual(out[0].verdict, "likely_inaccurate")

    def test_a_real_unverifiable_verdict_is_still_upgraded(self):
        out, summary, _c, _r = ground([CLAIM_ADRIFT], model=says("supported", QUOTE_ADRIFT))
        self.assertFalse(out[0].requires_human_review)
        self.assertEqual(summary.clamped_verdicts, 0)

    def test_the_checker_logs_a_histogram_of_raw_verdicts_and_the_item_key_sets_and_no_claim_text(self):
        from unittest.mock import patch
        resp = SimpleNamespace(text=json.dumps({"results": [
            {"index": 0, "verdict": "accurate", "reasoning": ""}, {"index": 1, "verdict": "accurate", "reasoning": ""},
            {"index": 2, "verdict": "likely_accurate", "reasoning": "r"},
            {"index": 3, "verdict": "True!!", "reasoning": "r", "extra": 1}]}))
        claims = ["The secret claim number one.", "The secret claim number two.", "Three.", "Four four four four."]
        with patch.object(fact_checker, "make_client"), patch.object(fact_checker, "generate_with_retry", return_value=resp), \
                self.assertLogs("modules.fact_checker", level="INFO") as logs:
            results = fact_checker.fact_check_claims(claims)
        self.assertEqual([r.clamped for r in results], [True, True, False, True])
        text = "\n".join(logs.output)
        self.assertIn("3 of 4", text)
        self.assertIn("accurate=2", text)
        self.assertIn("likely_accurate=1", text)
        self.assertIn("True!!=1", text)
        self.assertIn("index,reasoning,verdict=3", text)
        self.assertIn("extra,index,reasoning,verdict=1", text)
        self.assertNotIn("secret claim", text)

    def test_fact_check_json_rows_carry_the_clamp_only_when_there_was_one(self):
        claims = [Claim("c000-1", 0, "Claim number one is long."), Claim("c000-2", 0, "Claim number two is long.")]
        rows = claim_scenes.fact_check_records(claims, [_make_result(claims[0].text, "accurate", "x"),
                                                       _make_result(claims[1].text, "unverifiable", "x")])
        self.assertEqual((rows[0]["clamped"], rows[0]["raw_verdict"]), (True, "accurate"))
        self.assertNotIn("clamped", rows[1])
        self.assertNotIn("raw_verdict", rows[1])

    def test_the_system_prompt_is_still_not_sent_in_this_change(self):
        """Diagnose before fix (CLAUDE.md #8): sending it is a separate, measured change."""
        src = (ROOT / "modules" / "fact_checker.py").read_text()
        self.assertIn("generate_with_retry(client, GEMINI_MODEL, prompt)", src)


# ── 2 ───────────────────────────────────────────────────────────────────────────

CASES = [
    # (label, claim, snippet, quote, must_be_cleared)
    ("negation in the quote", "The Library of Alexandria was destroyed by Caesar's fire.",
     "The Library of Alexandria was not destroyed by Caesar's fire, as often claimed by writers.",
     "The Library of Alexandria was not destroyed by Caesar's fire", False),
    ("a not dropped by an ellipsis", "The Library of Alexandria was destroyed by Caesar's fire.",
     "The Library of Alexandria was not destroyed by Caesar's fire.",
     "The Library of Alexandria ... destroyed by Caesar's fire", False),
    ("hedge before the quote, same sentence", "Rome was founded by Romulus in 753 BC.",
     "According to legend, Rome was founded by Romulus in 753 BC after a quarrel.",
     "Rome was founded by Romulus in 753 BC", False),
    ("legend before the quote", "Rome was founded by Romulus in 753 BC.",
     "Legend holds that the city of Rome was founded by Romulus in 753 BC.",
     "the city of Rome was founded by Romulus in 753 BC", False),
    ("disputed before the quote", "The battle took place in 1066 at Hastings.",
     "Historians have disputed whether the battle took place in 1066 at Hastings itself.",
     "the battle took place in 1066 at Hastings", False),
    ("did not", "Columbus discovered America in 1492.",
     "Columbus did not discover America in 1492; the Norse arrived centuries before.",
     "Columbus did not discover America in 1492", False),
    ("unlikely", "Nero fiddled while Rome burned in 64 AD.",
     "It is unlikely that Nero fiddled while Rome burned in 64 AD",
     "unlikely that Nero fiddled while Rome burned in 64 AD", False),
    ("falsely credited", "Marie Antoinette said let them eat cake in 1789.",
     "Marie Antoinette is falsely credited with saying let them eat cake in 1789",
     "Marie Antoinette is falsely credited with saying let them eat cake in 1789", False),
    ("hoax", "The Piltdown man was an ancient human ancestor found in 1912.",
     "The Piltdown Man was a hoax: ancient human ancestor found in 1912 turned out forged",
     "The Piltdown Man was a hoax: ancient human ancestor found in 1912", False),
    ("misattributed", "Einstein said insanity is doing the same thing over and over.",
     "The quote 'insanity is doing the same thing over and over' is misattributed to Einstein",
     "insanity is doing the same thing over and over' is misattributed to Einstein", False),
    ("contrary to popular belief", "The earth is flat.", "Contrary to popular belief the earth is flat claim is false",
     "Contrary to popular belief the earth is flat claim is false", False),
    ("a negated claim backed by an affirmative sentence", "Napoleon never visited Egypt in 1798.",
     "Napoleon visited Egypt in 1798 with an army of thousands.", "Napoleon visited Egypt in 1798 with an army", False),
    ("a plain statement", "Caesar was killed on 15 March 44 BC.",
     "On the Ides of March (15 March), 44 BC, Caesar was killed by senators.",
     "On the Ides of March (15 March), 44 BC, Caesar was killed", True),
    ("a plain statement with grouped digits", "About 1,000,000 died.",
     "About 1000000 died in the famine of that period.", "About 1000000 died in the famine of that period", True),
    ("a negation that the claim itself makes", "Napoleon never visited Egypt in 1798.",
     "Napoleon never visited Egypt in 1798 according to this unusual account, which no historian accepts.",
     "Napoleon never visited Egypt in 1798", False),
]


class TheWholeSentenceIsRead(unittest.TestCase):
    def test_the_reviewers_cases(self):
        for label, claim, snippet, quote, cleared in CASES:
            with self.subTest(label):
                ok, why = grounding.check_support(claim, S(snippet), quote)
                self.assertEqual(ok, cleared, f"{label}: {why}")

    def test_a_hedge_in_the_sentence_but_outside_the_quote_blocks(self):
        ok, why = grounding.check_support("Rome was founded by Romulus in 753 BC.",
                                          S("According to legend, Rome was founded by Romulus in 753 BC after a quarrel."),
                                          "Rome was founded by Romulus in 753 BC")
        self.assertEqual((ok, why), (False, "hedged_in_sentence"))

    def test_a_negation_in_the_sentence_blocks_and_is_named(self):
        ok, why = grounding.check_support("The Library of Alexandria was destroyed by Caesar's fire.",
                                          S("The Library of Alexandria was not destroyed by Caesar's fire."),
                                          "The Library of Alexandria ... destroyed by Caesar's fire")
        self.assertFalse(ok)

    def test_pieces_joined_by_an_ellipsis_must_sit_in_one_sentence(self):
        snippet = S("The Library of Alexandria was not destroyed. Caesar's fire burned some of its scrolls in 48 BC.")
        ok, why = grounding.check_support("The Library of Alexandria was destroyed by Caesar's fire.", snippet,
                                          "The Library of Alexandria was ... Caesar's fire burned some of its")
        self.assertEqual((ok, why), (False, "ellipsis_across_sentences"))

    def test_a_quote_that_runs_over_two_sentences_reads_both(self):
        snippet = S("Rome was founded by Romulus in 753 BC. This is only a legend and is disputed by scholars.")
        ok, why = grounding.check_support("Rome was founded by Romulus in 753 BC.", snippet,
                                          "Rome was founded by Romulus in 753 BC. This is only a legend")
        self.assertFalse(ok)

    def test_an_abbreviation_does_not_end_a_sentence_early(self):
        snippet = S("Dr. Smith wrote that Rome was not founded by Romulus in 753 BC at all.")
        ok, _ = grounding.check_support("Rome was founded by Romulus in 753 BC.", snippet, "that Rome was not founded")
        self.assertFalse(ok)

    def test_the_hedge_and_negation_lists_are_found_as_whole_words(self):
        self.assertTrue(grounding.polarity_markers("He did not go; it is a myth, falsely credited."))
        self.assertEqual(grounding.polarity_markers("A notable knot in the nothing"), set())
        self.assertIn("n't", grounding.polarity_markers("He didn't go"))
        self.assertIn("n't", grounding.polarity_markers("He didn’t go"))


# ── 3 ───────────────────────────────────────────────────────────────────────────

FALL = ("The fall of Constantinople was the capture of the Byzantine Empire's capital by the Ottoman Empire. "
        "Constantinople fell on 29 May 1453, after a 53-day siege. "
        "Sultan Mehmed II was twenty-one years old when he commanded the siege of the city.")
FALL_QUOTE = "Constantinople fell on 29 May 1453, after a 53-day siege"


class NamesWordsAndCaps(unittest.TestCase):
    def test_the_ottomans_never_captured_the_city_is_not_cleared_by_a_sentence_about_the_city(self):
        ok, why = grounding.check_support("The Ottomans never captured the city after the siege in the end.", S(FALL),
                                          FALL_QUOTE)
        self.assertFalse(ok)

    def test_a_name_of_the_claim_must_be_in_the_sentence_of_the_quote(self):
        ok, why = grounding.check_support("Napoleon fell on 29 May 1453, after a 53-day siege.", S(FALL), FALL_QUOTE)
        self.assertEqual((ok, why), (False, "name_not_in_sentence"))

    def test_the_names_may_be_in_the_sentence_outside_the_quote(self):
        ok, _ = grounding.check_support("Constantinople fell on 29 May 1453 after a siege.",
                                        S("Constantinople fell on 29 May 1453, after a 53-day siege by the Ottomans."),
                                        "fell on 29 May 1453, after a 53-day siege")
        self.assertTrue(ok)

    def test_enough_of_the_claim_must_be_in_the_quote(self):
        claim = "The Ottoman army, with cannon, fleet and janissaries, took the city by storm on 29 May 1453."
        ok, why = grounding.check_support(claim, S("Ottoman forces took the city on 29 May 1453."),
                                          "took the city on 29 May 1453")
        self.assertFalse(ok)
        self.assertEqual(why, "quote_covers_too_little")

    def test_how_many_words_are_enough(self):
        self.assertEqual(grounding.required_shared_words(2), 2)
        self.assertEqual(grounding.required_shared_words(4), 3)
        self.assertEqual(grounding.required_shared_words(6), 3)
        self.assertEqual(grounding.required_shared_words(10), 5)

    def test_one_quote_clears_one_claim(self):
        claims = ["The city of Constantinople fell on 29 May 1453.", "Constantinople fell on 29 May 1453 after a siege.",
                  "On 29 May 1453 the city of Constantinople fell to the Ottomans.", "Constantinople fell in 1453 after 53 days.",
                  "The siege of Constantinople ended on 29 May 1453."]
        router = lambda c, n: FakeResponse(api([page("Fall of Constantinople", FALL, 1)]))  # noqa: E731
        model = says("supported", FALL_QUOTE)
        out, summary, _c, _r = ground(claims, model=model, router=router, topic="Fall of Constantinople")
        self.assertEqual(summary.upgraded, 1)
        self.assertEqual(sum(not r.requires_human_review for r in out), 1)
        reasons = [(r.grounding or {}).get("reason") for r in out]
        self.assertIn("quote_already_used", reasons)

    def test_a_script_can_have_only_a_fraction_of_its_claims_cleared_and_the_count_is_recorded(self):
        self.assertEqual(grounding.clearance_cap(1), 1)
        self.assertEqual(grounding.clearance_cap(10), 4)
        self.assertEqual(grounding.clearance_cap(28), 10)
        self.assertEqual(grounding.clearance_cap(200), 10)
        budget = grounding.ClearanceBudget(total=2)
        self.assertEqual(budget.take("a", "W1"), None)
        self.assertEqual(budget.take("b", "W1"), None)
        self.assertEqual(budget.take("c", "W2"), "clearance_cap")
        self.assertEqual(budget.take("a", "W3"), "quote_already_used")
        budget = grounding.ClearanceBudget(total=9)
        self.assertEqual([budget.take(q, "W1") for q in "abc"], [None, None, "snippet_already_used_twice"])

    def test_the_cap_and_its_use_are_in_the_summary(self):
        _out, summary, _c, _r = ground([CLAIM_ADRIFT], model=says("supported", QUOTE_ADRIFT))
        d = summary.to_dict()
        self.assertEqual((d["upgrade_cap"], d["upgraded"]), (1, 1))
        self.assertEqual(d["cleared"][0]["quote"], QUOTE_ADRIFT)
        self.assertEqual(d["cleared"][0]["url"], "https://en.wikipedia.org/wiki/Mary_Celeste")
        self.assertEqual(d["cleared"][0]["claim_id"], "0")

    def test_the_cleared_claims_carry_the_ids_the_caller_gave(self):
        client = client_for(mary_celeste_router, min_interval=0)
        _out, summary = grounding.ground_results("The Mary Celeste mystery", [CLAIM_ADRIFT], [unchecked(CLAIM_ADRIFT)],
                                                 client=client, generate=says("supported", QUOTE_ADRIFT),
                                                 claim_ids=["c001-2"])
        self.assertEqual(summary.to_dict()["cleared"][0]["claim_id"], "c001-2")


# ── 4 ───────────────────────────────────────────────────────────────────────────

class EveryNumberIsBacked(unittest.TestCase):
    def test_one_group_per_number(self):
        ok = grounding.numbers_backed
        self.assertFalse(ok("The fleet had three ships and five hundred men.", "The fleet had three ships"))
        self.assertFalse(ok("The fleet had three ships and five hundred men.", "three ships and a thousand men"))
        self.assertTrue(ok("The fleet had three ships and five hundred men.", "three ships and 500 men"))
        self.assertFalse(ok("The fleet had 3 ships and 500 men.", "three ships and a thousand men"))
        self.assertTrue(ok("Nineteen eighty-four, then eighteen twelve.", "1984, then 1812"))
        self.assertFalse(ok("Nineteen eighty-four, then eighteen twelve.", "in 1984"))

    def test_eras_must_match(self):
        ok = grounding.numbers_backed
        self.assertTrue(ok("Caesar was killed in 44 BC.", "killed in 44 BC"))
        self.assertTrue(ok("Caesar was killed in 44 B.C.", "killed in 44 BCE"))
        self.assertFalse(ok("Caesar was killed in 44 BC.", "killed in 44 AD"))
        self.assertFalse(ok("Caesar was killed in 44 BC.", "killed in 44"))
        self.assertFalse(ok("Caesar was killed in 44.", "killed in 44 BC"))
        self.assertTrue(ok("Rome fell in 476 AD.", "fell in AD 476"))

    def test_regnal_numbers_must_match_both_ways(self):
        ok = grounding.numbers_backed
        self.assertFalse(ok("Louis XIV ruled France for 72 years.", "Louis XV ruled France for 72 years"))
        self.assertTrue(ok("Louis XIV ruled France for 72 years.", "Louis XIV ruled France for 72 years"))
        self.assertFalse(ok("Napoleon was exiled to Saint Helena in 1815.", "Napoleon III was exiled to Saint Helena in 1815"))
        ok2, why = grounding.check_support("Napoleon was exiled to Saint Helena in 1815.",
                                           S("Napoleon III was exiled to Saint Helena in 1815 (sic)."),
                                           "Napoleon III was exiled to Saint Helena in 1815")
        self.assertFalse(ok2)

    def test_ordinary_words_that_look_like_numerals_are_not_numerals(self):
        self.assertTrue(grounding.numbers_backed("The mild mix of civil medicine.", "a mild mix of civil medicine"))
        self.assertEqual(grounding.roman_numerals("Mix it with CD and DC, Louis XIV, Henry VIII and I"), {"XIV", "VIII"})


# ── 7 ───────────────────────────────────────────────────────────────────────────

class StreamedResponse:
    """A response a client may read in chunks (what ``requests`` gives with stream=True)."""

    def __init__(self, chunks, status=200, headers=None, on_chunk=None):
        self.status_code, self.headers, self._chunks, self.closed, self._on = status, headers or {}, chunks, False, on_chunk

    def iter_content(self, chunk_size=65536):
        for c in self._chunks:
            if self._on:
                self._on()
            yield c

    def close(self):
        self.closed = True


class TheClientIsHardened(unittest.TestCase):
    def test_a_redirect_is_never_followed_and_the_body_is_streamed(self):
        client = client_for(lambda c, n: FakeResponse(api([page("A", "x" * 60)])), min_interval=0)
        client.get({"titles": "A"})
        call = client.fake_http.calls[0]
        self.assertIs(call["allow_redirects"], False)
        self.assertIs(call["stream"], True)

    def test_a_3xx_answer_is_a_failure_not_a_hop_to_another_host(self):
        client = client_for(lambda c, n: FakeResponse(None, 302, {"Location": "https://evil.example/"}), min_interval=0)
        self.assertIsNone(client.get({"titles": "A"}))
        self.assertEqual(len(client.fake_http.calls), 1)
        self.assertEqual(client.failures, ["http_302"])

    def test_a_body_over_the_byte_cap_is_refused_and_closed(self):
        big = StreamedResponse([b"x" * 400_000] * 4)
        client = client_for(lambda c, n: big, min_interval=0)
        self.assertIsNone(client.get({"titles": "A"}))
        self.assertEqual(client.failures, ["too_large"])
        self.assertTrue(big.closed)

    def test_an_oversize_page_does_not_stop_the_other_lookups(self):
        client = client_for(lambda c, n: StreamedResponse([b"x" * 2_000_000]) if n == 1 else FakeResponse(api([page("A", "y" * 60)])),
                            min_interval=0)
        self.assertIsNone(client.get({"titles": "A"}))
        self.assertIsNone(client.aborted)
        self.assertIsNotNone(client.get({"titles": "B"}))

    def test_a_streamed_body_is_parsed(self):
        body = json.dumps(api([page("A", "z" * 60)])).encode()
        client = client_for(lambda c, n: StreamedResponse([body[:50], body[50:]]), min_interval=0)
        self.assertEqual(client.get({"titles": "A"})["query"]["pages"][0]["title"], "A")

    def test_a_slow_trickle_is_cut_by_a_total_timeout_not_a_per_read_one(self):
        clock = Clock()
        trickle = StreamedResponse([b"{"] * 50, on_chunk=lambda: setattr(clock, "t", clock.t + 3))
        client = client_for(lambda c, n: trickle, clock=clock, sleep=clock.sleep, min_interval=0)
        self.assertIsNone(client.get({"titles": "A"}))
        self.assertEqual(client.failures, ["timeout"])
        self.assertLessEqual(clock.t, grounding.TIMEOUT_S + 4)

    def test_the_names_are_looked_up_in_one_request_and_a_normal_video_needs_at_most_four(self):
        claims = ["Captain David Morehouse of the Dei Gratia boarded her.", "The Dei Gratia reached Gibraltar first.",
                  CLAIM_ADRIFT, "Frederick Solly-Flood presided over the inquiry at Gibraltar."]
        _out, summary, client, _r = ground(claims, model=says("not_found"), min_interval=0)
        self.assertLessEqual(len(client.fake_http.calls), 4)
        titled = [c for c in client.fake_http.calls if "|" in c["params"].get("titles", "")]
        self.assertEqual(len(titled), 1)
        self.assertIn("Dei Gratia", titled[0]["params"]["titles"])
        self.assertEqual(titled[0]["params"]["redirects"], "1")
        self.assertEqual(titled[0]["params"]["exintro"], "1")

    def test_a_name_that_is_no_page_is_skipped_and_a_redirect_is_followed(self):
        def router(call, n):
            p = call["params"]
            if "|" in p.get("titles", ""):
                body = api([page("Dei Gratia", "Dei Gratia was a Canadian brigantine that found the Mary Celeste.", 1),
                            {"title": "Captain Morehouse", "missing": True}])
                body["query"]["redirects"] = [{"from": "Deigratia", "to": "Dei Gratia"}]
                return FakeResponse(body)
            return mary_celeste_router(call, n)
        ev = grounding.gather_evidence("The Mary Celeste mystery", ["Captain Morehouse of the Dei Gratia boarded her."],
                                       client=client_for(router, min_interval=0))
        self.assertIn("Dei Gratia", {s.title for s in ev.snippets.values()})
        self.assertNotIn("Captain Morehouse", {s.title for s in ev.snippets.values()})

    def test_a_rate_limited_lookup_gets_one_second_chance_after_the_wait(self):
        state = {"limited": True}

        def router(call, n):
            if state["limited"] and n <= 4:
                return FakeResponse(None, 429, {"Retry-After": "7"})
            state["limited"] = False
            return mary_celeste_router(call, n)
        out, summary, client, _r = ground([CLAIM_ADRIFT], router=router, model=says("supported", QUOTE_ADRIFT),
                                          min_interval=0)
        self.assertTrue(summary.second_chance)
        self.assertIsNone(summary.unavailable)
        self.assertFalse(out[0].requires_human_review)
        self.assertLessEqual(len(client.fake_http.calls), grounding.MAX_REQUESTS)

    def test_a_lookup_that_is_still_limited_after_the_second_chance_is_unavailable(self):
        out, summary, client, results = ground([CLAIM_ADRIFT], router=lambda c, n: FakeResponse(None, 429, {"Retry-After": "7"}),
                                               model=says("supported", QUOTE_ADRIFT), min_interval=0)
        self.assertEqual(summary.unavailable, "http_429")
        self.assertIs(out[0], results[0])
        self.assertLessEqual(len(client.fake_http.calls), grounding.MAX_REQUESTS)

    def test_no_second_chance_for_a_failure_that_is_not_a_rate_limit_or_one_asking_for_a_long_wait(self):
        for status, headers in ((503, {}), (429, {"Retry-After": "300"}), (403, {})):
            with self.subTest(status=status, headers=headers):
                out, summary, client, _r = ground([CLAIM_ADRIFT], router=lambda c, n, s=status, h=headers: FakeResponse(None, s, h),
                                                  model=says("supported", QUOTE_ADRIFT), min_interval=0)
                self.assertFalse(summary.second_chance)

    def test_a_mixture_of_rate_limits_and_other_failures_gets_no_second_chance(self):
        client = client_for(lambda c, n: FakeResponse(None, 429 if n <= 3 else 503, {"Retry-After": "7"}), min_interval=0)
        client.get({"titles": "A"})
        client.get({"titles": "B"})
        self.assertEqual(client.failures, ["http_429", "http_503"])
        self.assertFalse(client.second_chance())
        only_429 = client_for(lambda c, n: FakeResponse(None, 429, {"Retry-After": "7"}), min_interval=0)
        only_429.get({"titles": "A"})
        only_429.get({"titles": "B"})
        self.assertTrue(only_429.second_chance())

    def test_the_passages_of_an_earlier_run_of_the_same_topic_are_reused_without_a_request(self):
        client = client_for(mary_celeste_router, min_interval=0)
        _o, first = grounding.ground_results("The Mary Celeste mystery", [CLAIM_ADRIFT], [unchecked(CLAIM_ADRIFT)],
                                             client=client, generate=says("not_found"))
        saved = json.loads(json.dumps({"topic": "The Mary Celeste mystery", "passages": grounding.evidence_record(first.evidence)}))
        cached = grounding.evidence_from_record(saved, "The Mary Celeste mystery")
        self.assertTrue(cached.snippets)
        client2 = client_for(lambda c, n: FakeResponse(None, 429), min_interval=0)
        out, second = grounding.ground_results("The Mary Celeste mystery", [CLAIM_ADRIFT], [unchecked(CLAIM_ADRIFT)],
                                               client=client2, generate=says("supported", QUOTE_ADRIFT), cached=cached)
        self.assertEqual(client2.fake_http.calls, [])
        self.assertTrue(second.reused)
        self.assertEqual(second.requests, 0)
        self.assertFalse(out[0].requires_human_review)

    def test_a_cache_of_another_topic_or_a_damaged_one_is_not_used(self):
        good = {"topic": "A", "passages": [{"id": "W1", "title": "T", "url": "https://en.wikipedia.org/wiki/T", "revid": 1,
                                            "text": "A passage of enough length to be a passage at all, really."}]}
        self.assertIsNotNone(grounding.evidence_from_record(good, "A"))
        self.assertIsNone(grounding.evidence_from_record(good, "B"))
        for bad in (None, [], "x", {"topic": "A"}, {"topic": "A", "passages": "x"}, {"topic": "A", "passages": []},
                    {"topic": "A", "passages": [{"id": "W1", "title": "T", "url": "https://evil.example/x", "text": "x" * 60}]},
                    {"topic": "A", "passages": [{"id": "../x", "title": "T", "url": "https://en.wikipedia.org/wiki/T", "text": "x" * 60}]},
                    {"topic": "A", "passages": [{"id": "W1", "title": "T", "url": "https://en.wikipedia.org/wiki/T", "text": 5}]}):
            self.assertIsNone(grounding.evidence_from_record(bad, "A"), bad)

    def test_main_reuses_and_saves_grounding_json_with_the_topic(self):
        src = (ROOT / "main.py").read_text()
        self.assertIn("grounding.load_cached_evidence(", src)
        self.assertIn('"topic": topic', src)

    def test_the_model_call_has_a_timeout(self):
        from unittest.mock import patch
        seen = {}

        def fake(client, model, prompt, config=None):
            seen["config"] = config
            return SimpleNamespace(text="{}")
        with patch("modules.gemini_client.make_client"), patch("modules.gemini_client.generate_with_retry", side_effect=fake):
            grounding._default_generate("prompt")
        self.assertEqual(seen["config"].http_options.timeout, grounding.JUDGE_TIMEOUT_S * 1000)

    def test_the_whole_matching_phase_has_a_deadline(self):
        clock = Clock()
        model = says("not_found")
        calls = []

        def slow(prompt):
            calls.append(1)
            clock.t += grounding.JUDGE_DEADLINE_S + 1
            return model(prompt)
        claims = [f"The Mary Celeste carried {n + 2} barrels of alcohol, said the log." for n in range(40)]
        client = client_for(mary_celeste_router, clock=clock, sleep=clock.sleep, min_interval=0)
        results = [unchecked(c) for c in claims]
        grounding.ground_results("The Mary Celeste mystery", claims, results, client=client, generate=slow, clock=clock)
        self.assertEqual(len(calls), 1)


# ── 6 ───────────────────────────────────────────────────────────────────────────

class TheOwnerCanAuditAClearance(unittest.TestCase):
    def test_the_held_detail_keeps_the_cleared_claims_with_their_quotes_and_sources(self):
        summary = {"enabled": True, "unavailable": None, "sources": [],
                   "cleared": [{"claim_id": "c001-2", "title": "Mary Celeste", "url": "https://en.wikipedia.org/wiki/Mary_Celeste",
                                "quote": "q" * 400, "secret": "x"},
                               {"claim_id": "c001-3", "title": "Evil", "url": "https://evil.example/x", "quote": "q"}]}
        detail = held_video.grounding_detail(summary)
        self.assertEqual(len(detail["cleared"]), 1)
        self.assertEqual(set(detail["cleared"][0]), {"claim_id", "title", "url", "quote"})
        self.assertLessEqual(len(detail["cleared"][0]["quote"]), 300)

    def test_main_hands_the_claim_ids_to_the_lookup(self):
        self.assertIn("claim_ids=[c.claim_id for c in section_claims]", (ROOT / "main.py").read_text())


# ── 5 ───────────────────────────────────────────────────────────────────────────

class TheWordsAreHonest(unittest.TestCase):
    def test_the_docs_and_the_module_do_not_claim_more_than_the_checks_prove(self):
        for path in ("docs/GROUNDED_FACTCHECK.md", "modules/grounding.py"):
            text = (ROOT / path).read_text().lower()
            for overclaim in ("cannot talk a claim into passing", "a wrong year\ncannot pass", "wrong year cannot pass",
                              "can only make the fact-check stricter", "can only ever have added"):
                self.assertNotIn(overclaim, text, f"{path}: {overclaim}")
        doc = (ROOT / "docs/GROUNDED_FACTCHECK.md").read_text().lower()
        for needed in ("clamped", "guard", "does not prove", "separate", "measured"):
            self.assertIn(needed, doc)

    def test_the_panel_note_does_not_say_the_page_proves_the_claim(self):
        text = (ROOT / "command-center/lib/i18n/en.ts").read_text()
        note = text[text.index("sourcesNote:"):].split("\n")[0]
        self.assertNotIn("only when", note)
        self.assertIn("not proof", note)


# ── 8 ───────────────────────────────────────────────────────────────────────────

class TheTwoSurvivors(unittest.TestCase):
    SNIPPET = "Constantinople fell to the Ottoman Turks on 29 May 1453, ending the Byzantine Empire."

    def test_a_piece_under_twelve_characters_cannot_ride_along_with_a_long_one(self):
        for tiny in ("fell to", "the", "to the"):
            with self.subTest(first=tiny):
                self.assertTrue(grounding.verify_quote("Constantinople fell to the Ottoman Turks", self.SNIPPET))
                self.assertFalse(grounding.verify_quote(f"{tiny} ... the Ottoman Turks on 29 May 1453, ending", self.SNIPPET))
        self.assertEqual(grounding.MIN_QUOTE_PIECE, 12)
        self.assertFalse(grounding.verify_quote("Constantinople fell to the Ottoman Turks ... 29 May", self.SNIPPET))
        self.assertFalse(grounding.verify_quote("29 May ... ending the Byzantine Empire", self.SNIPPET))
        self.assertTrue(grounding.verify_quote("on 29 May 1453 ... ending the Byzantine Empire", self.SNIPPET))

    def test_a_retry_after_over_the_cap_is_not_waited_for_even_when_the_total_allowance_would_fit_it(self):
        self.assertLess(grounding.MAX_RETRY_AFTER_S, grounding.MAX_TOTAL_WAIT_S)
        client = client_for(lambda c, n: FakeResponse(None, 429, {"Retry-After": str(grounding.MAX_RETRY_AFTER_S + 5)}),
                            min_interval=0)
        self.assertIsNone(client.get({"titles": "A"}))
        self.assertEqual(len(client.fake_http.calls), 1)
        self.assertEqual(client.fake_clock.slept, [])

    def test_a_retry_after_at_the_cap_is_waited_for(self):
        client = client_for(lambda c, n: FakeResponse(None, 429, {"Retry-After": str(grounding.MAX_RETRY_AFTER_S)}),
                            min_interval=0)
        client.get({"titles": "A"})
        self.assertIn(float(grounding.MAX_RETRY_AFTER_S), [float(s) for s in client.fake_clock.slept])


if __name__ == "__main__":
    unittest.main()
