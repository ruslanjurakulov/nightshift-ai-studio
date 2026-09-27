"""modules/social_captions.py — per-platform text from the video's own metadata,
trimmed deterministically to each platform's limits."""

import re
import unittest

from modules import social_captions as sc

LONG = "Rome did not fall in a day. " * 400


def meta(**kw):
    base = dict(title="The Fall of Rome", description="Why the empire collapsed.\n0:00 Intro\n1:23 Crisis",
                tags=("ancient rome", "History", "history", "roman empire"), niche="world history")
    base.update(kw)
    return sc.SourceMeta(**base)


class HashtagTests(unittest.TestCase):
    def test_hashtags_from_tags_and_niche_deduped(self):
        self.assertEqual(sc.hashtags(["ancient rome", "History", "history", "#roman-empire", "  ", "2024"], 10),
                         ["#AncientRome", "#History", "#RomanEmpire"])

    def test_unicode_letters_kept(self):
        self.assertEqual(sc.hashtag("tarix"), "#tarix")
        self.assertEqual(sc.hashtag("история мира"), "#ИсторияМира")


class TrimTests(unittest.TestCase):
    def test_trim_at_word_boundary_with_ellipsis(self):
        out = sc.trim("alpha beta gamma delta", 14)
        self.assertLessEqual(len(out), 14)
        self.assertTrue(out.endswith(sc.ELLIPSIS))
        self.assertNotIn("gam", out)

    def test_short_text_unchanged(self):
        self.assertEqual(sc.trim("hello", 10), "hello")

    def test_deterministic(self):
        m = meta(description=LONG)
        self.assertEqual(sc.instagram_caption(m), sc.instagram_caption(m))
        self.assertEqual(sc.tiktok_caption(m), sc.tiktok_caption(m))


class InstagramTests(unittest.TestCase):
    def test_title_description_hashtags_and_no_timestamps(self):
        c = sc.instagram_caption(meta())
        self.assertTrue(c.startswith("The Fall of Rome\n\nWhy the empire collapsed."))
        self.assertNotIn("0:00", c)
        self.assertTrue(c.endswith("#AncientRome #History #RomanEmpire #WorldHistory"))

    def test_limits_hold_for_huge_inputs(self):
        tags = tuple(f"tag number {i}" for i in range(100))
        c = sc.instagram_caption(meta(description=LONG + " #inline #tags", tags=tags), max_hashtags=99)
        self.assertLessEqual(len(c), sc.IG_CAPTION_MAX)
        self.assertLessEqual(len(re.findall(r"#\w+", c)), sc.IG_HASHTAGS_MAX)
        self.assertTrue(c.startswith("The Fall of Rome"))

    def test_mentions_capped(self):
        desc = " ".join(f"@user{i}" for i in range(40))
        c = sc.instagram_caption(meta(description=desc))
        self.assertLessEqual(len(re.findall(r"(?<![\w@])@\w+", c)), sc.IG_MENTIONS_MAX)


class TiktokTests(unittest.TestCase):
    def test_short_caption_first_paragraph_and_five_hashtags(self):
        tags = tuple(f"t{i} word" for i in range(20))
        c = sc.tiktok_caption(meta(description="First paragraph.\n\nSecond paragraph.", tags=tags))
        self.assertIn("First paragraph.", c)
        self.assertNotIn("Second paragraph", c)
        self.assertEqual(len(re.findall(r"#\w+", c)), sc.TT_HASHTAGS_DEFAULT)

    def test_utf16_limit_with_emoji(self):
        c = sc.tiktok_caption(meta(title="🔥" * 3000))
        self.assertLessEqual(sc.utf16_len(c), sc.TT_CAPTION_MAX_UTF16)


class YoutubeTests(unittest.TestCase):
    def test_title_description_tags_limits(self):
        tags = tuple(f"long tag number {i}" for i in range(100))
        y = sc.youtube_metadata(meta(title="<b>" + "T" * 300, description=LONG * 2, tags=tags))
        self.assertLessEqual(len(y.title), sc.YT_TITLE_MAX)
        self.assertNotIn("<", y.title)
        self.assertLessEqual(len(y.description.encode("utf-8")), sc.YT_DESCRIPTION_MAX_BYTES)
        cost = sum(len(t) + (2 if " " in t else 0) for t in y.tags) + len(y.tags) - 1
        self.assertLessEqual(cost, sc.YT_TAGS_MAX_CHARS)

    def test_tags_follow_the_uploaders_rule(self):
        tags = tuple(f"long tag number {i}" for i in range(100)) + ("a<b>", "x,y")
        y = sc.youtube_metadata(meta(tags=tags))
        cost = sum(len(t) + (2 if " " in t else 0) + 1 for t in y.tags)
        self.assertLessEqual(cost, sc.YT_TAGS_MAX_CHARS)
        self.assertGreater(len(y.tags), 10)
        self.assertEqual(sc.youtube_tags(["History", "history", " ", "a<b>", "x,y"]), ["History", "ab", "x y"])

    def test_multibyte_description_under_5000_bytes_and_deterministic(self):
        m = meta(title="Тарих " * 40, description="Рим пал не за один день. " * 600)
        y = sc.youtube_metadata(m)
        self.assertLessEqual(len(y.title), sc.YT_TITLE_MAX)
        self.assertLessEqual(len(y.description.encode("utf-8")), sc.YT_DESCRIPTION_MAX_BYTES)
        self.assertTrue(y.description.endswith(sc.ELLIPSIS))
        self.assertEqual(y, sc.youtube_metadata(m))
        self.assertNotIn("0:00", sc.youtube_metadata(meta()).description)

    def test_empty_title_falls_back_and_record_fits_the_column(self):
        y = sc.youtube_metadata(meta(title="", topic="", description=LONG * 2,
                                     tags=tuple(f"tag {i}" for i in range(200))), fallback_title="vid123")
        self.assertEqual(y.title, "vid123")
        rec = sc.youtube_record(y)
        self.assertTrue(rec.startswith("vid123\n\n"))
        self.assertIn("Tags: tag 0, tag 1", rec)
        self.assertLessEqual(len(rec), 6000)  # publish_requests.caption

    def test_unknown_platform(self):
        with self.assertRaises(ValueError):
            sc.caption_for("myspace", meta())


if __name__ == "__main__":
    unittest.main()
