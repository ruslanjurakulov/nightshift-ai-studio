"""modules/tg_text.py: escaping, splitting under Telegram's limit, and the last
scrub over outgoing text. Pure functions, no network."""

import unittest

from modules import tg_text


class EscapeTestCase(unittest.TestCase):
    def test_html_escape_covers_markup_and_quotes(self):
        self.assertEqual(tg_text.html_escape('<b>"a" & b</b>'), "&lt;b&gt;&quot;a&quot; &amp; b&lt;/b&gt;")
        self.assertEqual(tg_text.html_escape(None), "")

    def test_markdown_v2_escape_covers_every_special_character(self):
        out = tg_text.md2_escape("a_b*c[d](e)~f`g>h#i+j-k=l|m{n}o.p!q\\r")
        for ch in "_*[]()~`>#+-=|{}.!\\":
            self.assertEqual(out.count("\\" + ch), 1, ch)
        self.assertEqual(tg_text.md2_escape("plain"), "plain")

    def test_clip_collapses_whitespace_and_marks_the_cut(self):
        self.assertEqual(tg_text.clip("a \n  b", 10), "a b")
        out = tg_text.clip("x" * 50, 10)
        self.assertEqual(len(out), 10)
        self.assertTrue(out.endswith("…"))
        self.assertEqual(tg_text.clip("abc", 0), "")

    def test_safe_id_keeps_only_identifier_characters(self):
        self.assertEqual(tg_text.safe_id("a b<c>/d:e_1-2.3"), "abcd:e_1-2.3")
        self.assertEqual(len(tg_text.safe_id("x" * 200, 12)), 12)


class SplitTestCase(unittest.TestCase):
    def test_short_text_is_one_chunk(self):
        self.assertEqual(tg_text.split_message("hello"), ["hello"])

    def test_empty_text_has_no_chunks(self):
        self.assertEqual(tg_text.split_message(""), [])
        self.assertEqual(tg_text.split_message("  \n "), [])

    def test_long_text_splits_on_line_boundaries_under_the_limit(self):
        text = "\n".join(f"line {i:04d} " + "x" * 90 for i in range(200))
        chunks = tg_text.split_message(text, 1000)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(c) <= 1000 for c in chunks))
        self.assertEqual("\n".join(chunks), text)       # nothing lost, nothing reordered

    def test_default_limit_is_below_telegrams_hard_limit(self):
        chunks = tg_text.split_message("y" * 10000)
        self.assertTrue(all(len(c) <= tg_text.MESSAGE_LIMIT for c in chunks))
        self.assertTrue(tg_text.SPLIT_AT < tg_text.MESSAGE_LIMIT)

    def test_a_hard_cut_never_lands_inside_an_entity(self):
        text = "a" * 9 + "&amp;" + "b" * 20
        for chunk in tg_text.split_message(text, 11):
            self.assertNotRegex(chunk, r"&[a-z]*$")      # no dangling "&am"
        self.assertEqual("".join(tg_text.split_message(text, 11)), text)

    def test_limit_is_clamped_to_telegrams_maximum(self):
        chunks = tg_text.split_message("z" * 9000, 999999)
        self.assertTrue(all(len(c) <= 4096 for c in chunks))


class SanitizeTestCase(unittest.TestCase):
    def test_bot_token_urls_are_redacted(self):
        out = tg_text.sanitize_outgoing("see https://api.telegram.org/bot123456:ABCdefGHI_jklMNO/sendMessage")
        self.assertNotIn("ABCdef", out)

    def test_emails_are_removed(self):
        out = tg_text.sanitize_outgoing("owner is someone@example.com ok")
        self.assertNotIn("someone@example.com", out)
        self.assertIn("[email]", out)

    def test_bearer_jwt_prefixed_keys_and_long_tokens_are_removed(self):
        jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop"
        for secret in (
            "Bearer abcdefghijklmnop12345", jwt, "sk-abcdefghijklmnopqrstuvwxyz",
            "ghp_abcdefghijklmnopqrstuvwxyz0123", "AIzaSyABCDEFGHIJKLMNOPQRSTUV",
            "aB3" * 17,
        ):
            out = tg_text.sanitize_outgoing(f"value {secret} end")
            self.assertNotIn(secret, out, secret)
            self.assertIn("[hidden]", out)

    def test_placeholders_are_safe_in_html_mode(self):
        out = tg_text.sanitize_outgoing("a@b.co and sk-abcdefghijklmnopqrstuvwxyz")
        self.assertNotIn("<", out)

    def test_ordinary_operator_text_survives(self):
        text = "Render job #123 failed — default (attempt 1/3) · sha abcdef1 · 2h 5m"
        self.assertEqual(tg_text.sanitize_outgoing(text), text)

    def test_a_commit_hash_and_a_uuid_are_left_alone(self):
        text = "sha 0123456789abcdef0123456789abcdef01234567 job 123e4567-e89b-12d3-a456-426614174000"
        self.assertEqual(tg_text.sanitize_outgoing(text), text)

    def test_a_long_worker_id_is_not_mistaken_for_a_key(self):
        text = "worker nightshift-creative-worker-eu-central-01-pipeline-primary-instance lost"
        self.assertEqual(tg_text.sanitize_outgoing(text), text)

    def test_none_is_empty(self):
        self.assertEqual(tg_text.sanitize_outgoing(None), "")


if __name__ == "__main__":
    unittest.main()
