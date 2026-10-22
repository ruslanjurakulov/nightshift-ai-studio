"""The fact-checker's system prompt must actually reach the model, and nothing about how the
answer is read may get looser because it does.

Evidence (Actions run 39749438994, topic "Lost Colony of Roanoke"): the checker logged
"verdict outside the three known values for 30 of 30 claim(s) ... verdicts {True=29, False=1}; item
keys {claim,explanation,index,verdict=30}" and then the same for 22 of 22. The model answered with
JSON booleans and an ``explanation`` key, i.e. it had never been told the schema, because
``FACT_CHECK_SYSTEM_PROMPT`` was defined and never sent (``generate_with_retry(client, model, prompt)``
with no config). Every claim was clamped to ``unverifiable``, all 52 were flagged and the publish gate
held the video. See docs/GROUNDED_FACTCHECK.md.

No network and no model here: a fake Gemini client stands in for ``genai.Client`` and the REAL
``generate_with_retry`` runs against it, so what is pinned is the request that would have been sent.

Pinned, and what would break:

  * the instruction reaches every call (a batch, a split retry, a second batch) .. SystemPromptReachesTheCall
  * the switch is ON by default, ``off`` restores the old request exactly ........ TheSwitch
  * the three words are read; the vocabulary in the prompt is the one in code .... AnswersInTheThreeWordsAreRead
  * booleans and unknown words STILL clamp; nothing maps True to likely_accurate . StrictnessIsUnchanged
  * a missing or odd key STILL clamps; the parser does not learn new key names ... OddKeysStillClamp
"""

from __future__ import annotations

import json
import logging
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import fact_checker  # noqa: E402
from modules.fact_checker import (  # noqa: E402
    ENV_SYSTEM_PROMPT,
    FACT_CHECK_SYSTEM_PROMPT,
    MAX_BATCH_SIZE,
    VALID_VERDICTS,
    fact_check_claims,
    system_prompt_enabled,
)


class FakeModels:
    def __init__(self, owner):
        self.owner = owner

    def generate_content(self, model, contents, config=None):
        self.owner.calls.append(SimpleNamespace(model=model, contents=contents, config=config))
        return SimpleNamespace(text=self.owner.answer(contents, len(self.owner.calls) - 1))


class FakeGeminiClient:
    """What ``genai.Client`` is to the checker: ``client.models.generate_content``. ``answer(contents,
    call_number)`` returns the response text; every request is recorded in ``calls``."""

    def __init__(self, answer):
        self.answer, self.calls = answer, []
        self.models = FakeModels(self)


def claims_in(contents) -> list:
    """The claims of one request, read back out of the JSON block of the user prompt."""
    return json.loads(contents.split("\n\n", 1)[1])["claims"]


def reply(verdicts, key="reasoning", extra=None):
    """A well-formed response body for ``verdicts`` (one entry per claim, 0-based)."""
    items = [{"index": i, "verdict": v, key: "r%d" % i, **(extra or {})} for i, v in enumerate(verdicts)]
    return json.dumps({"results": items})


def check(claims, answer, env=None):
    """Run the real fact_check_claims against a fake client. Returns (results, client)."""
    client = FakeGeminiClient(answer)
    with patch("modules.fact_checker.make_client", return_value=client), \
         patch.dict("os.environ", {}, clear=False) as environ:
        environ.pop(ENV_SYSTEM_PROMPT, None)
        environ.update(env or {})
        return fact_check_claims(claims), client


class SystemPromptReachesTheCall(unittest.TestCase):
    def test_the_instruction_is_in_the_request_config(self):
        _, client = check(["a", "b"], lambda c, n: reply(["unverifiable"] * 2))
        self.assertEqual(len(client.calls), 1)
        config = client.calls[0].config
        self.assertIsNotNone(config, "no config was sent: the system prompt never reached Gemini")
        self.assertEqual(config.system_instruction, FACT_CHECK_SYSTEM_PROMPT)

    def test_the_response_is_asked_for_as_json(self):
        _, client = check(["a"], lambda c, n: reply(["unverifiable"]))
        self.assertEqual(client.calls[0].config.response_mime_type, "application/json")

    def test_the_user_prompt_still_carries_the_claims_and_the_model_is_unchanged(self):
        _, client = check(["a", "b"], lambda c, n: reply(["unverifiable"] * 2))
        from config import GEMINI_MODEL

        self.assertEqual(client.calls[0].model, GEMINI_MODEL)
        self.assertEqual([c["claim"] for c in claims_in(client.calls[0].contents)], ["a", "b"])

    def test_every_batch_carries_it(self):
        n = MAX_BATCH_SIZE + 1
        _, client = check([f"claim {i}" for i in range(n)],
                          lambda c, k: reply(["unverifiable"] * len(claims_in(c))))
        self.assertEqual(len(client.calls), 2)
        for call in client.calls:
            self.assertEqual(call.config.system_instruction, FACT_CHECK_SYSTEM_PROMPT)

    def test_the_split_and_retry_calls_carry_it_too(self):
        def answer(contents, number):
            return "not json at all" if number == 0 else reply(["unverifiable"] * len(claims_in(contents)))

        results, client = check(["a", "b", "c", "d"], answer)
        self.assertEqual(len(client.calls), 3)
        for call in client.calls:
            self.assertEqual(call.config.system_instruction, FACT_CHECK_SYSTEM_PROMPT)
        self.assertEqual(len(results), 4)

    def test_the_prompt_names_exactly_the_verdict_words_the_code_accepts(self):
        for word in VALID_VERDICTS:
            self.assertIn(f'"{word}"', FACT_CHECK_SYSTEM_PROMPT)
        # The key the parser reads is the key the prompt asks for: the model used "explanation"
        # in the real run because it was never told "reasoning".
        self.assertIn('"reasoning"', FACT_CHECK_SYSTEM_PROMPT)
        self.assertIn('"verdict"', FACT_CHECK_SYSTEM_PROMPT)
        self.assertIn('"results"', FACT_CHECK_SYSTEM_PROMPT)

    def test_a_missing_config_object_is_said_not_silent(self):
        # json_config returns None when the genai types cannot be imported. Sending no instruction
        # then must be loud (CLAUDE.md #4: no silent quality fallback).
        with patch("modules.fact_checker.json_config", return_value=None), \
             self.assertLogs("modules.fact_checker", logging.WARNING) as logs:
            check(["a"], lambda c, n: reply(["unverifiable"]))
        self.assertTrue(any("system prompt" in line.lower() for line in logs.output), logs.output)


class TheSwitch(unittest.TestCase):
    def test_on_by_default_and_when_the_deploy_writes_an_empty_value(self):
        self.assertTrue(system_prompt_enabled({}))
        self.assertTrue(system_prompt_enabled({ENV_SYSTEM_PROMPT: ""}))
        _, client = check(["a"], lambda c, n: reply(["unverifiable"]), env={ENV_SYSTEM_PROMPT: ""})
        self.assertIsNotNone(client.calls[0].config)

    def test_off_words_restore_the_request_exactly_as_it_was(self):
        for word in ("off", "0", "false", "no", "disabled", "none", " OFF ", "'off'", '"Off"'):
            with self.subTest(word=word):
                self.assertFalse(system_prompt_enabled({ENV_SYSTEM_PROMPT: word}))
        _, client = check(["a"], lambda c, n: reply(["unverifiable"]), env={ENV_SYSTEM_PROMPT: "off"})
        self.assertIsNone(client.calls[0].config)

    def test_on_words_keep_it_on(self):
        for word in ("on", "1", "true", "yes", "enabled"):
            with self.subTest(word=word):
                self.assertTrue(system_prompt_enabled({ENV_SYSTEM_PROMPT: word}))

    def test_an_unrecognised_value_stays_on_and_never_echoes_the_value(self):
        with self.assertLogs("modules.fact_checker", logging.WARNING) as logs:
            self.assertTrue(system_prompt_enabled({ENV_SYSTEM_PROMPT: "sekrit-value-7"}))
        text = "\n".join(logs.output)
        self.assertIn(ENV_SYSTEM_PROMPT, text)
        self.assertNotIn("sekrit-value-7", text)


    def test_it_is_read_when_the_check_runs_so_one_run_can_be_switched_off(self):
        with patch.dict("os.environ", {ENV_SYSTEM_PROMPT: "off"}):
            self.assertFalse(system_prompt_enabled())
        with patch.dict("os.environ", {}):
            import os
            os.environ.pop(ENV_SYSTEM_PROMPT, None)
            self.assertTrue(system_prompt_enabled())

    def test_the_name_reaches_the_runners(self):
        """Mirrors NIGHTSHIFT_GROUNDED_FACTCHECK: the example (the worker env allow-list), the deploy and the
        Actions run all carry it, or setting the variable in GitHub would do nothing and say nothing."""
        name = ENV_SYSTEM_PROMPT
        self.assertEqual(name, "NIGHTSHIFT_FACTCHECK_SYSTEM_PROMPT")
        self.assertIn(f"\n{name}=\n", (ROOT / "deploy" / ".env.worker.example").read_text())
        self.assertIn(f"WORKERENV_{name}: ${{{{ vars.{name} }}}}",
                      (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text())
        self.assertIn(f"          {name}: ${{{{ vars.{name} }}}}",
                      (ROOT / ".github" / "workflows" / "daily_video.yml").read_text())

    def test_it_is_a_variable_not_a_secret(self):
        example = (ROOT / "deploy" / ".env.worker.example").read_text()
        self.assertNotIn(ENV_SYSTEM_PROMPT, example.split("# ─── Behaviour")[0])


class AnswersInTheThreeWordsAreRead(unittest.TestCase):
    def test_each_of_the_three_words_is_read_and_review_follows_from_the_verdict(self):
        results, _ = check(["a", "b", "c"], lambda c, n: reply(
            ["likely_accurate", "likely_inaccurate", "unverifiable"]))
        self.assertEqual([r.verdict for r in results], ["likely_accurate", "likely_inaccurate", "unverifiable"])
        self.assertEqual([r.requires_human_review for r in results], [False, True, True])
        self.assertEqual([r.clamped for r in results], [False, False, False])
        self.assertEqual([r.reasoning for r in results], ["r0", "r1", "r2"])

    def test_a_model_cannot_set_the_review_flag_itself(self):
        results, _ = check(["a"], lambda c, n: reply(["unverifiable"], extra={"requires_human_review": False}))
        self.assertTrue(results[0].requires_human_review)


class StrictnessIsUnchanged(unittest.TestCase):
    def one(self, verdict):
        results, _ = check(["a claim"], lambda c, n: json.dumps(
            {"results": [{"index": 0, "verdict": verdict, "reasoning": "r"}]}))
        return results[0]

    def test_booleans_still_clamp_and_true_is_not_likely_accurate(self):
        # The exact shape of the real run: {True=29, False=1}.
        for value in (True, False):
            with self.subTest(value=value):
                r = self.one(value)
                self.assertEqual(r.verdict, "unverifiable")
                self.assertTrue(r.clamped)
                self.assertTrue(r.requires_human_review)
                self.assertEqual(r.raw_verdict, "bool")

    def test_unknown_words_still_clamp(self):
        for word in ("true", "True", "TRUE", "accurate", "inaccurate", "likely accurate", "Likely_Accurate",
                     "likely_accurate ", "yes", "correct", "verified", "", "mostly_true", 1, 0, None, [], {},
                     ["likely_accurate"], {"verdict": "likely_accurate"}):
            with self.subTest(word=word):
                r = self.one(word)
                self.assertEqual(r.verdict, "unverifiable")
                self.assertTrue(r.clamped)
                self.assertTrue(r.requires_human_review)

    def test_a_mixed_batch_clamps_only_the_bad_items(self):
        results, _ = check(["a", "b", "c"], lambda c, n: reply([True, "likely_accurate", "nonsense"]))
        self.assertEqual([r.verdict for r in results], ["unverifiable", "likely_accurate", "unverifiable"])
        self.assertEqual([r.clamped for r in results], [True, False, True])

    def test_the_valid_words_are_still_exactly_three(self):
        self.assertEqual(VALID_VERDICTS, {"likely_accurate", "likely_inaccurate", "unverifiable"})


class OddKeysStillClamp(unittest.TestCase):
    def test_an_item_with_no_verdict_key_clamps(self):
        for body in ({"index": 0, "reasoning": "r"},
                     {"index": 0, "result": "likely_accurate", "reasoning": "r"},
                     {"index": 0, "is_accurate": True, "explanation": "r"},
                     {"index": 0, "answer": "likely_accurate"},
                     {"index": 0, "Verdict": "likely_accurate"}):
            with self.subTest(body=body):
                results, _ = check(["a"], lambda c, n: json.dumps({"results": [body]}))
                self.assertEqual(results[0].verdict, "unverifiable")
                self.assertTrue(results[0].clamped)
                self.assertTrue(results[0].requires_human_review)

    def test_a_valid_word_under_the_old_explanation_key_is_kept_but_the_parser_does_not_learn_the_key(self):
        # The word is valid so it is read; the reasoning is "" because the parser reads "reasoning"
        # only. Mapping "explanation" in would be a separate, deliberate change.
        results, _ = check(["a"], lambda c, n: reply(["likely_inaccurate"], key="explanation"))
        self.assertEqual(results[0].verdict, "likely_inaccurate")
        self.assertEqual(results[0].reasoning, "")

    def test_the_real_run_shape_clamps_every_claim(self):
        # 30 claims, True=29 False=1, keys claim/explanation/index/verdict.
        n = 30
        body = {"results": [{"index": i, "claim": f"c{i}", "verdict": i != 7, "explanation": "e"}
                            for i in range(n)]}
        results, _ = check([f"c{i}" for i in range(n)], lambda c, k: json.dumps(body))
        self.assertEqual(len(results), n)
        self.assertTrue(all(r.verdict == "unverifiable" and r.clamped and r.requires_human_review
                            for r in results))


class EveryExistingGuardStillHolds(unittest.TestCase):
    def test_the_result_factory_is_the_only_path_to_a_verdict(self):
        # Nothing in the module builds a FactCheckResult with a model-supplied review flag.
        source = (ROOT / "modules" / "fact_checker.py").read_text()
        self.assertEqual(source.count("FactCheckResult("), 1)
        self.assertIn("requires_human_review=(verdict != \"likely_accurate\")", source)

    def test_safe_default_is_unresolved_and_flagged(self):
        r = fact_checker._safe_default("x")
        self.assertTrue(r.unresolved and r.requires_human_review)
        self.assertEqual(r.verdict, "unverifiable")


if __name__ == "__main__":
    unittest.main()
