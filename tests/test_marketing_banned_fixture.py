"""The banned-wording check the owner page runs on a typed post is the check the worker runs.

The database cannot read ``docs/news/banned-claims.json``, so ``command-center/lib/marketing-banned.ts`` checks a post the owner types
on the "New post" form with a copy of the list and a JavaScript translation of the Python patterns. This test runs the real checker
(``modules.marketing_content.banned_hits``) over ``tests/fixtures/marketing_banned_cases.json`` and the page's own vitest
(``command-center/tests/marketing-banned.test.ts``) runs the TypeScript version over the same file, so a pattern that behaves differently
in the two dialects (a Cyrillic word boundary, an apostrophe, a provider name inside a hyphenated word) fails one of them.
"""

import json
import unittest
from pathlib import Path

from modules.marketing_content import banned_hits

CASES = json.loads((Path(__file__).parent / "fixtures" / "marketing_banned_cases.json").read_text(encoding="utf-8"))["cases"]


class MarketingBannedFixtureTests(unittest.TestCase):
    def test_the_fixture_has_hits_and_clean_texts_of_every_rule(self):
        seen = {h for c in CASES for h in c["hits"]}
        data = json.loads((Path(__file__).parent.parent / "docs" / "news" / "banned-claims.json").read_text(encoding="utf-8"))
        for rule in data["rules"]:
            self.assertIn(rule["id"], seen, f"no case trips rule {rule['id']}")
        self.assertTrue(any(h.startswith("provider:") for h in seen))
        self.assertTrue(any(not c["hits"] for c in CASES))

    def test_the_real_checker_says_what_the_fixture_says(self):
        for c in CASES:
            with self.subTest(c["text"]):
                self.assertEqual(sorted(banned_hits(c["text"])), c["hits"])


if __name__ == "__main__":
    unittest.main()
