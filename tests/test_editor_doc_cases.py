"""The timeline validators agree: modules/timeline.py (what the worker runs
before it renders) and command-center/lib/editor.ts (what the save route runs
before the database is asked) are judged on the same documents,
samples/timeline_doc_cases.json. The TypeScript half of this check is
command-center/tests/editor-timeline.test.ts."""

import json
import unittest
from pathlib import Path

from modules import timeline as tl

CASES = Path(__file__).resolve().parent.parent / "samples" / "timeline_doc_cases.json"


class DocCasesTestCase(unittest.TestCase):
    def test_python_validator_agrees_with_every_case(self):
        cases = json.loads(CASES.read_text(encoding="utf-8"))["cases"]
        self.assertGreater(len(cases), 20)
        for case in cases:
            with self.subTest(case["name"]):
                problems = tl.validate(case["doc"])
                self.assertEqual(problems == [], case["valid"], problems)


if __name__ == "__main__":
    unittest.main()
