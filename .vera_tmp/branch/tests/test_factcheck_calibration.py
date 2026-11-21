"""The calibration harness (tools/factcheck_calibration.py) runs offline here, against a fake Gemini client
that answers from the labels. What would break without these tests: a harness that passes when it measured
nothing, one that reads a plausible falsehood being accepted as fine, one that reaches the network without
``--live``, or a data file that quietly shrank.

  * the data file holds 15 true, 15 false, 10 obscure claims, no duplicates ......... TheDataFile
  * a credulous model fails; an honest one passes; a cautious one passes with 0 clear  ThePassCriterion
  * all-boolean / all-clamped answers are INCONCLUSIVE, never a pass ................. ThePassCriterion
  * no ``--live`` or no key means no model call; the key is never printed ............ TheCommandLine
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules.fact_checker import fact_check_claims  # noqa: E402
from tests.test_factcheck_system_prompt import FakeGeminiClient, claims_in  # noqa: E402
from tools import factcheck_calibration as cal  # noqa: E402

ROWS = cal.load_claims()
LABEL_OF = {r["claim"]: r["label"] for r in ROWS}


def model(policy):
    """A fake Gemini answering every claim in the request by ``policy(label) -> verdict value``."""
    def answer(contents, number):
        items = [{"index": c["index"], "verdict": policy(LABEL_OF[c["claim"]]), "reasoning": "r"}
                 for c in claims_in(contents)]
        return json.dumps({"results": items})
    return FakeGeminiClient(answer)


HONEST = {"true": "likely_accurate", "false": "likely_inaccurate", "obscure": "unverifiable"}


def run_with(client, argv=("--live",), env=None):
    lines = []
    with patch("modules.fact_checker.make_client", return_value=client):
        code = cal.main(list(argv), env={"GEMINI_API_KEY": "test-key-not-real", **(env or {})}, out=lines.append)
    return code, "\n".join(lines)


class TheDataFile(unittest.TestCase):
    def test_counts_per_label(self):
        from collections import Counter
        self.assertEqual(dict(Counter(r["label"] for r in ROWS)), {"true": 15, "false": 15, "obscure": 10})

    def test_ids_and_texts_are_unique_and_a_false_claim_is_never_a_true_one(self):
        self.assertEqual(len({r["id"] for r in ROWS}), 40)
        self.assertEqual(len({r["claim"] for r in ROWS}), 40)

    def test_a_shrunken_or_mislabelled_file_is_refused(self):
        import tempfile
        for mutate in (lambda rows: rows[:-1],
                       lambda rows: [dict(rows[0], label="maybe")] + rows[1:],
                       lambda rows: rows + [dict(rows[0], id="dup")]):
            path = Path(tempfile.mkdtemp()) / "c.json"
            path.write_text(json.dumps({"claims": mutate(ROWS)}))
            with self.assertRaises(ValueError):
                cal.load_claims(path)


class TheDataFileShips(unittest.TestCase):
    def test_the_blanket_json_ignore_does_not_hide_the_claims_file(self):
        """.gitignore ignores *.json; an ignored file would be dropped from the commit and the tool and
        its tests would fail in CI only."""
        import subprocess
        proc = subprocess.run(["git", "check-ignore", "-q", "tools/factcheck_calibration_claims.json"],
                              cwd=ROOT, capture_output=True)
        if proc.returncode == 128:
            self.skipTest("not a git checkout")
        self.assertEqual(proc.returncode, 1, "the claims file is git-ignored: add the negation to .gitignore")


class ThePassCriterion(unittest.TestCase):
    def test_an_honest_model_passes_and_all_true_claims_clear(self):
        client = model(HONEST.get)
        code, text = run_with(client)
        self.assertEqual(code, cal.PASS, text)
        self.assertIn("false claims accepted as likely_accurate: 0 of 15", text)
        self.assertIn("true claims that clear: 15 of 15", text)
        self.assertIn("RESULT: PASS", text)
        self.assertEqual(len(client.calls), 2)          # 40 claims = two batches of at most 30

    def test_a_credulous_model_fails_and_names_the_false_claims_it_accepted(self):
        code, text = run_with(model(lambda label: "likely_accurate"))
        self.assertEqual(code, cal.FAIL, text)
        self.assertIn("15 of 15", text)
        self.assertIn("f01", text)
        self.assertIn("RESULT: FAIL", text)

    def test_one_accepted_falsehood_is_enough_to_fail(self):
        first_false = next(r["claim"] for r in ROWS if r["label"] == "false")

        def answer(contents, number):
            items = [{"index": c["index"], "reasoning": "r",
                      "verdict": "likely_accurate" if c["claim"] == first_false else "unverifiable"}
                     for c in claims_in(contents)]
            return json.dumps({"results": items})

        code, text = run_with(FakeGeminiClient(answer))
        self.assertEqual(code, cal.FAIL, text)
        self.assertIn("1 of 15", text)

    def test_a_cautious_model_passes_with_nothing_cleared_and_says_so(self):
        code, text = run_with(model(lambda label: "unverifiable"))
        self.assertEqual(code, cal.PASS)
        self.assertIn("true claims that clear: 0 of 15", text)

    def test_a_model_that_answers_in_booleans_is_inconclusive_not_a_pass(self):
        # The real run's shape. Zero false accepts here proves nothing.
        code, text = run_with(model(lambda label: label == "true"))
        self.assertEqual(code, cal.INCONCLUSIVE, text)
        self.assertIn("RESULT: INCONCLUSIVE", text)
        self.assertIn("clamped verdicts: 40", text)

    def test_a_single_clamped_verdict_makes_a_clean_run_inconclusive(self):
        first = ROWS[0]["claim"]

        def answer(contents, number):
            items = [{"index": c["index"], "reasoning": "r",
                      "verdict": "true" if c["claim"] == first else "unverifiable"} for c in claims_in(contents)]
            return json.dumps({"results": items})

        code, _ = run_with(FakeGeminiClient(answer))
        self.assertEqual(code, cal.INCONCLUSIVE)

    def test_an_unreadable_answer_is_unresolved_and_inconclusive(self):
        code, text = run_with(FakeGeminiClient(lambda contents, number: "not json"))
        self.assertEqual(code, cal.INCONCLUSIVE, text)
        self.assertIn("unresolved: 40", text)

    def test_a_false_accept_outranks_an_inconclusive_run(self):
        first_false = next(r["claim"] for r in ROWS if r["label"] == "false")

        def answer(contents, number):
            items = [{"index": c["index"], "reasoning": "r",
                      "verdict": "likely_accurate" if c["claim"] == first_false else True}
                     for c in claims_in(contents)]
            return json.dumps({"results": items})

        code, _ = run_with(FakeGeminiClient(answer))
        self.assertEqual(code, cal.FAIL)

    def test_the_report_says_whether_the_system_prompt_was_sent(self):
        # Read from the process environment, which is what the request itself reads.
        with patch.dict("os.environ", {"NIGHTSHIFT_FACTCHECK_SYSTEM_PROMPT": "off"}):
            _, text = run_with(model(HONEST.get))
        self.assertIn("system prompt sent: NO", text)
        with patch.dict("os.environ", {"NIGHTSHIFT_FACTCHECK_SYSTEM_PROMPT": ""}):
            _, text = run_with(model(HONEST.get))
        self.assertIn("system prompt sent: yes", text)


class TheCommandLine(unittest.TestCase):
    def test_without_live_nothing_is_asked_of_any_model(self):
        with patch("modules.fact_checker.make_client") as make, patch("modules.fact_checker.generate_with_retry") as gen:
            lines = []
            code = cal.main([], env={"GEMINI_API_KEY": "test-key-not-real"}, out=lines.append)
        self.assertEqual(code, cal.INCONCLUSIVE)
        make.assert_not_called()
        gen.assert_not_called()
        self.assertIn("--live", "\n".join(lines))

    def test_live_without_a_key_stops_before_any_call_and_names_the_variable(self):
        with patch("modules.fact_checker.make_client") as make:
            lines = []
            code = cal.main(["--live"], env={}, out=lines.append)
        self.assertEqual(code, cal.INCONCLUSIVE)
        make.assert_not_called()
        self.assertIn("GEMINI_API_KEY", "\n".join(lines))

    def test_the_key_is_never_printed(self):
        _, text = run_with(model(HONEST.get), argv=("--live", "--json"))
        self.assertNotIn("test-key-not-real", text)
        _, text = run_with(model(HONEST.get))
        self.assertNotIn("test-key-not-real", text)

    def test_json_output_is_the_summary(self):
        _, text = run_with(model(HONEST.get), argv=("--live", "--json"))
        data = json.loads(text)
        self.assertEqual((data["false_accepted"], data["true_cleared"], data["outcome"]), ([], 15, cal.PASS))

    def test_the_real_checker_is_what_live_mode_calls(self):
        # main() must go through fact_check_claims, i.e. the request the pipeline sends, system prompt included.
        client = model(HONEST.get)
        run_with(client)
        for call in client.calls:
            self.assertIsNotNone(call.config)
            self.assertTrue(call.config.system_instruction)
        self.assertEqual(fact_check_claims.__module__, "modules.fact_checker")


if __name__ == "__main__":
    unittest.main()
