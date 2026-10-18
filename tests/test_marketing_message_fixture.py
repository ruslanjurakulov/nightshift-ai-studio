"""The Telegram message the owner page previews is the message the sender builds.

``command-center/lib/marketing-posts.ts`` (``buildPreview``) mirrors ``modules/channel_post.render`` because the page cannot
import Python. This test runs the real renderer over ``tests/fixtures/marketing_message_cases.json`` and the page's own vitest
(``command-center/tests/marketing-posts.test.ts``) runs the TypeScript mirror over the same file, so the two cannot drift
apart without one of them failing: the plain text, its UTF-16 length, the limit, and which posts are refused for length.
"""

import html
import json
import unittest
from pathlib import Path

from modules import channel_post as cp

CASES = json.loads((Path(__file__).parent / "fixtures" / "marketing_message_cases.json").read_text(encoding="utf-8"))["cases"]


class MarketingMessageFixtureTests(unittest.TestCase):
    def test_the_fixture_is_not_empty_and_has_each_kind_of_case(self):
        self.assertGreaterEqual(len(CASES), 8)
        outcomes = {c["expect"].get("refused") for c in CASES}
        self.assertIn(None, outcomes)
        self.assertIn("too_long", outcomes)
        self.assertIn("no_origin", outcomes)

    def test_the_sender_builds_exactly_what_the_fixture_says(self):
        for c in CASES:
            with self.subTest(c["name"]):
                expect = c["expect"]
                if "refused" in expect:
                    with self.assertRaises(cp.Refused) as ctx:
                        cp.render(c["texts"], c["link"], c["origin"], c["has_media"])
                    self.assertEqual(ctx.exception.code, expect["refused"])
                    if expect["refused"] == "too_long":
                        # What the page prints beside "too long": the plain text the sender counted.
                        link_url = (c["origin"].rstrip("/") + c["link"]) if c["link"] and c["origin"] else None
                        plain = cp._blocks(c["texts"], link_url, escape=False)
                        self.assertEqual(plain, expect["plain"])
                        self.assertEqual(cp.utf16_len(plain), expect["utf16"])
                        self.assertGreater(expect["utf16"], expect["limit"])
                    continue
                out = cp.render(c["texts"], c["link"], c["origin"], c["has_media"])
                plain = html.unescape(out)
                self.assertEqual(plain, expect["plain"])
                self.assertEqual(cp.utf16_len(plain), expect["utf16"])
                self.assertEqual(expect["limit"], cp.CAPTION_LIMIT if c["has_media"] else cp.MESSAGE_LIMIT)
                self.assertLessEqual(expect["utf16"], expect["limit"])


if __name__ == "__main__":
    unittest.main()
