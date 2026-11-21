"""The promo posts the Telegram channel poster may draft (docs/promo/, docs/MARKETING_POSTS.md, migration 0110).

The validator of record for those files: it runs over every ``docs/promo/*.json`` in CI, so a malformed or unsafe file
fails the pull request that adds it instead of being skipped silently by the worker after the merge. It reads files only
(no network, no database, no model). The runtime re-check is ``modules.marketing_content.promo_problem``; this file adds
what a runtime check cannot or should not do: the evidence paths exist, each language is in its own script, no URL or
markup or currency amount, the welcome-grant wording, and the repository plumbing (.gitignore, the deploy path filter,
the worker image).

Every rule is also attacked with a mutated copy of a good file, so a rule that stops firing is noticed.
"""

import copy
import datetime
import json
import re
import unittest
from pathlib import Path

from modules import channel_post as cp
from modules import marketing_content as mc
from tests.test_news_format import (CYRILLIC, LATIN, ONE_TIME_WORD, PLACEHOLDER, URLISH, WELCOME_WORD, banned_hits,
                                    real_welcome_credits)

REPO = Path(__file__).resolve().parent.parent
PROMO = REPO / "docs" / "promo"
LANGS = ("uz", "ru", "en")
#: Far in the past: expiry is the worker's business, and a file that was valid when it merged must not turn CI red
#: for unrelated pull requests the day it lapses.
LONG_AGO = datetime.date(2000, 1, 1)
SITE = "https://app.example.test"
MONEY = re.compile(r"[$€£¥]|\busd\b|\bdollars?\b|доллар\w*|\bdollar\w*|\bsoʻm\b|\bso'm\b|\bсум\w*\b|\bруб\w*", re.I)


def promo_files():
    return sorted(PROMO.glob("*.json"))


def problems(item, stem):
    """Everything wrong with one parsed promo file (empty means acceptable). Runtime reason code first, then the
    CI-only rules."""
    bad = []
    code = mc.promo_problem(item, stem, LONG_AGO)
    if code:
        return [code]
    texts = item["texts"]
    for lang in LANGS:
        t = texts[lang]
        if "  " in t:
            bad.append(f"{lang}: doubled spaces")
        if PLACEHOLDER.search(t):
            bad.append(f"{lang}: placeholder, markup or unfinished text")
        if URLISH.search(t):
            bad.append(f"{lang}: no URL, domain, handle or address in the text (use link)")
        if MONEY.search(t):
            bad.append(f"{lang}: no currency amount: prices are not a repository fact")
        for hit in banned_hits(t):
            bad.append(f"{lang}: banned wording ({hit})")
        if WELCOME_WORD.search(t):
            if str(real_welcome_credits()) not in re.findall(r"\d+", t):
                bad.append(f"{lang}: wording about the welcome grant must say {real_welcome_credits()} credits")
            if not ONE_TIME_WORD.search(t):
                bad.append(f"{lang}: the welcome grant is one-time; say so")
    if not CYRILLIC.search(texts["ru"]):
        bad.append("ru: no Cyrillic letters")
    if CYRILLIC.search(texts["uz"]) or CYRILLIC.search(texts["en"]):
        bad.append("uz and en are written in Latin letters only")
    if not LATIN.search(texts["uz"]) or not LATIN.search(texts["en"]):
        bad.append("uz and en need Latin letters")
    if len({mc._normal(texts[lang]) for lang in LANGS}) < 3:
        bad.append("two languages hold the same text")
    for e in item["evidence"]:
        src = e["source"]
        if not src.startswith("https://") and not (REPO / src).exists():
            bad.append(f"evidence source {src!r} does not exist in this repository")
    refusal = cp.preflight(texts, item["link"], SITE, False)
    if refusal:
        bad.append(f"the sender would refuse this post ({refusal})")
    return bad


def good_item(**over):
    item = {
        "slug": "example-post", "public": False, "link": "/pricing",
        "texts": {
            "uz": "Endi Sozlamalarda Telegramni ulab, video tayyor boʻlganda xabar olishingiz mumkin.",
            "ru": "Теперь можно привязать Telegram в настройках и получать сообщение, когда видео готово.",
            "en": "You can now link Telegram in Settings and get a message when your video is ready."},
        "evidence": [{"claim": "Settings has a Telegram connection for ready-video messages.",
                      "source": "docs/NOTIFY_TELEGRAM_SETUP.md"}],
        "valid_until": "2099-12-31", "ai_media": False}
    item.update(over)
    return item


STEM = "example-post"


class PromoFiles(unittest.TestCase):
    def test_there_is_something_to_check(self):
        self.assertGreaterEqual(len(promo_files()), 3)

    def test_every_file_in_docs_promo_is_valid(self):
        failures = {}
        for path in promo_files():
            try:
                item = json.loads(path.read_text(encoding="utf-8"))
            except ValueError as e:
                failures[path.name] = [f"not JSON: {e}"]
                continue
            found = problems(item, path.stem)
            if found:
                failures[path.name] = found
        self.assertEqual(failures, {})

    def test_only_promo_files_live_in_docs_promo(self):
        stray = [p.name for p in PROMO.iterdir() if p.is_file() and not mc.PROMO_FILE.match(p.name)]
        self.assertEqual(stray, [], "a stray file in docs/promo is either misnamed or does not belong")

    def test_a_file_is_named_by_its_slug_and_the_slug_is_the_key(self):
        for p in promo_files():
            item = json.loads(p.read_text(encoding="utf-8"))
            self.assertEqual(item["slug"], p.stem)
        self.assertEqual(len({p.stem for p in promo_files()}), len(promo_files()))

    def test_public_files_carry_a_decision_an_expiry_and_no_media(self):
        for p in promo_files():
            item = json.loads(p.read_text(encoding="utf-8"))
            self.assertIsInstance(item["public"], bool, p.name)
            self.assertIs(item["ai_media"], False, p.name)
            if item["public"]:
                datetime.date.fromisoformat(item["valid_until"])      # a public promo expires: no standing promise

    def test_the_repository_files_load_in_the_worker_and_pass_its_own_render(self):
        drafts, skipped, notes = mc.load_promo(PROMO, LONG_AGO)
        self.assertEqual((skipped, notes), ({}, []))
        self.assertEqual(sorted(d.key for d in drafts), sorted(f"promo:{p.stem}:telegram" for p in promo_files()
                                                                if json.loads(p.read_text(encoding="utf-8"))["public"]))
        for d in drafts:
            self.assertIsNone(cp.preflight(d.texts, d.link, SITE, False), d.key)
            self.assertRegex(d.source_ref, r"^promo:[a-z0-9-]{1,60}$")
            self.assertEqual(d.key, d.source_ref + ":telegram")


class RepositoryPlumbing(unittest.TestCase):
    """Without these a merged promo file silently never reaches the worker image."""

    def test_json_files_in_docs_promo_are_not_swallowed_by_gitignore(self):
        lines = (REPO / ".gitignore").read_text(encoding="utf-8").splitlines()
        self.assertIn("*.json", lines)                       # the blanket rule that makes the re-include necessary
        self.assertIn("!docs/promo/*.json", lines)
        self.assertGreater(lines.index("!docs/promo/*.json"), lines.index("*.json"))

    def test_a_merge_touching_docs_promo_deploys_the_marketing_worker(self):
        text = (REPO / ".github" / "workflows" / "deploy_web.yml").read_text(encoding="utf-8")
        paths = re.search(r"\n    paths:\n(.*?)\n  workflow_dispatch:", text, re.S).group(1)
        self.assertIn('- "docs/promo/**"', paths)
        self.assertIn('- "docs/news/**"', paths)             # the model it follows

    def test_the_worker_image_ships_docs_promo(self):
        ignore = (REPO / ".dockerignore").read_text(encoding="utf-8").splitlines()
        self.assertFalse([l for l in ignore if l.strip().rstrip("/") in ("docs", "docs/promo", "docs/**", "docs/promo/**", "*.json")])
        self.assertIn("COPY . .", (REPO / "Dockerfile.worker").read_text(encoding="utf-8"))

    def test_the_default_directory_is_the_one_the_image_holds(self):
        self.assertEqual(mc.PROMO_DIR, PROMO)


class TheValidatorCatchesWhatItIsFor(unittest.TestCase):
    def test_a_clean_item_passes(self):
        self.assertEqual(problems(good_item(), STEM), [])

    def test_a_missing_or_extra_key_fails(self):
        for key in mc.PROMO_KEYS:
            item = good_item()
            del item[key]
            self.assertEqual(problems(item, STEM), ["bad_keys"], key)
        self.assertEqual(problems(good_item(draft=True), STEM), ["bad_keys"])
        self.assertEqual(problems([good_item()], STEM), ["not_an_object"])

    def test_the_slug_is_the_file_name_and_has_the_database_shape(self):
        self.assertEqual(problems(good_item(slug="other"), STEM), ["bad_slug"])
        for bad in ("", "Upper", "under_score", "a" * 61, "has space", "dot.dot", 5, None):
            self.assertEqual(problems(good_item(slug=bad), bad if isinstance(bad, str) else STEM), ["bad_slug"], repr(bad))
        self.assertEqual(problems(good_item(slug="a" * 60), "a" * 60), [])

    def test_public_must_be_a_json_boolean(self):
        for bad in ("true", 1, None):
            self.assertEqual(problems(good_item(public=bad), STEM), ["bad_public"], repr(bad))

    def test_links_are_paths_on_our_own_site_with_the_databases_shape(self):
        for ok in ("/pricing", "/studio", "/blog/post-1", None):
            self.assertEqual(problems(good_item(link=ok), STEM), [], repr(ok))
        for bad in ("https://evil.example/x", "//evil.example", "pricing", "/a/../b", "/a?x=1", "/Pricing", "", "/", 5):
            self.assertEqual(problems(good_item(link=bad), STEM), ["bad_link"], repr(bad))

    def test_ai_media_must_be_the_json_false_because_no_media_is_ever_attached(self):
        for bad in (True, "false", 0, None):
            self.assertEqual(problems(good_item(ai_media=bad), STEM), ["bad_ai_media"], repr(bad))

    def test_valid_until_is_a_real_date_or_null_and_an_old_one_expires(self):
        self.assertEqual(problems(good_item(valid_until=None), STEM), [])
        for bad in ("2026-13-01", "2026-1-1", "tomorrow", 20261231, "2026-02-30"):
            self.assertEqual(problems(good_item(valid_until=bad), STEM), ["bad_valid_until"], repr(bad))
        item = good_item(valid_until="2026-10-17")
        self.assertEqual(mc.promo_problem(item, STEM, datetime.date(2026, 10, 18)), "expired")
        self.assertIsNone(mc.promo_problem(item, STEM, datetime.date(2026, 10, 17)))        # the last day still counts

    def test_all_three_languages_are_required_and_nothing_else(self):
        for lang in LANGS:
            item = good_item()
            del item["texts"][lang]
            self.assertEqual(problems(item, STEM), ["bad_texts"], lang)
        item = good_item()
        item["texts"]["de"] = "Ein Text, der nicht erlaubt ist."
        self.assertEqual(problems(item, STEM), ["bad_texts"])
        for bad in ("Short.", " leading space in this text", "trailing space in this text ", "x" * (mc.PROMO_TEXT_MAX + 1),
                    "A hidden​ character sits in this sentence.", "A tab\there inside the sentence text.",
                    "Bidi ‮ override sits inside this sentence.", 5, None):
            item = good_item()
            item["texts"]["en"] = bad
            self.assertEqual(problems(item, STEM), ["bad_texts"], repr(bad))

    def test_a_new_line_inside_a_text_is_allowed_but_markup_and_urls_are_not(self):
        item = good_item()
        item["texts"]["en"] = "You can now link Telegram in Settings.\nGet a message when your video is ready."
        self.assertEqual(problems(item, STEM), [])
        for bad, why in (("See <b>this</b> new feature in Settings.", "placeholder"),
                         ("Now {price} credits for every plan today.", "placeholder"),
                         ("Unfinished sentence that trails off...", "placeholder"),
                         ("Read more at https://example.com/news today.", "no URL"),
                         ("Write to us at team@example.com about it.", "no URL"),
                         ("Follow @nightshift for updates and more.", "no URL"),
                         ("Double  space inside this announcement text.", "doubled spaces"),
                         ("The Plus plan costs ten dollars a month for everyone.", "currency")):
            item = good_item()
            item["texts"]["en"] = bad
            self.assertTrue(any(why in p for p in problems(item, STEM)), (bad, problems(item, STEM)))

    def test_scripts_and_copies_are_checked(self):
        item = good_item()
        item["texts"]["ru"] = item["texts"]["en"]
        self.assertTrue(any("no Cyrillic" in p for p in problems(item, STEM)))
        item = good_item()
        item["texts"]["uz"] = item["texts"]["ru"]
        self.assertTrue(any("Latin letters only" in p for p in problems(item, STEM)))
        item = good_item()
        item["texts"]["uz"] = item["texts"]["en"]
        self.assertTrue(any("same text" in p for p in problems(item, STEM)))

    def test_a_number_must_be_the_same_in_every_language_and_be_named_in_the_evidence(self):
        item = good_item()
        item["texts"]["en"] = "You can now link Telegram and get 3 messages when your video is ready."
        item["texts"]["ru"] = "Теперь можно привязать Telegram и получать 4 сообщения, когда видео готово."
        item["texts"]["uz"] = "Endi Telegramni ulab, video tayyor boʻlganda 3 ta xabar olishingiz mumkin."
        self.assertEqual(problems(item, STEM), ["numbers_differ"])
        item["texts"]["ru"] = item["texts"]["ru"].replace("4", "3")
        self.assertEqual(problems(item, STEM), ["bad_evidence"])                       # 3 is claimed but never evidenced
        item["evidence"][0]["claim"] = "Settings has a Telegram connection and sends 3 messages per video."
        self.assertEqual(problems(item, STEM), [])

    def test_no_evidence_or_a_malformed_entry_fails(self):
        item = good_item()
        item["evidence"] = []
        self.assertEqual(problems(item, STEM), ["bad_evidence"])
        for bad in (None, "docs/x.md", {"claim": "x" * 20, "source": "docs/x.md"}, [None], [{}],
                    [{"claim": "Too short", "source": "docs/NOTIFY_TELEGRAM_SETUP.md"}],
                    [{"claim": "A claim long enough to count here.", "source": ""}],
                    [{"claim": "A claim long enough to count here.", "source": "/etc/passwd"}],
                    [{"claim": "A claim long enough to count here.", "source": "../secret.md"}],
                    [{"claim": "A claim long enough to count here.", "source": "http://example.com/plain"}],
                    [{"claim": "A claim long enough to count here.", "source": "docs/x.md", "extra": 1}],
                    [{"claim": "A claim long enough to count here.", "source": 5}],
                    [{"claim": "x" * (mc.CLAIM_MAX + 1), "source": "docs/x.md"}],
                    [{"claim": "A claim long enough to count here.", "source": "docs/x.md"}] * (mc.EVIDENCE_MAX + 1)):
            item = good_item()
            item["evidence"] = bad
            self.assertEqual(problems(item, STEM), ["bad_evidence"], repr(bad)[:80])

    def test_an_evidence_path_that_does_not_exist_fails_in_ci(self):
        item = good_item()
        item["evidence"][0]["source"] = "docs/no-such-file-anywhere.md"
        self.assertTrue(any("does not exist" in p for p in problems(item, STEM)))
        item["evidence"][0]["source"] = "https://example.com/a/page"
        self.assertEqual(problems(item, STEM), [])

    def test_banned_wording_in_any_language_fails(self):
        for lang, bad in (("en", "Start for free today and see the best results."), ("ru", "Попробуйте бесплатно уже сегодня."),
                          ("uz", "Bepul sinab koʻring bugun."), ("en", "The video editor works with OpenAI models now.")):
            item = good_item()
            item["texts"][lang] = bad
            self.assertTrue(any("banned wording" in p for p in problems(item, STEM)), (lang, bad))

    def test_welcome_grant_wording_states_the_real_number_and_once(self):
        item = good_item()
        item["texts"]["en"] = "A welcome grant of credits waits for every new account."
        self.assertTrue(any("welcome grant" in p for p in problems(item, STEM)))
        n = real_welcome_credits()
        item["texts"] = {"en": f"A welcome grant of {n} credits, once, when you sign up.",
                         "ru": f"Приветственные {n} кредитов единоразово при регистрации.",
                         "uz": f"Roʻyxatdan oʻtganda xush kelibsiz uchun {n} kredit bir marta beriladi."}
        item["evidence"][0]["claim"] = f"The welcome grant is {n} credits, given once."
        self.assertEqual([p for p in problems(item, STEM) if "welcome" in p], [])

    def test_a_message_the_sender_would_refuse_fails_in_ci(self):
        item = good_item()
        item["texts"]["en"] = "Write to someone@example.com for the shapes and more."
        self.assertTrue(any("sender would refuse" in p or "no URL" in p for p in problems(item, STEM)))
        item = good_item()
        item["texts"]["en"] = "Your key is sk-abcdefghijklmnopqrstuvwxyzabcdef for the shapes."
        self.assertTrue(any("sender would refuse this post (unsafe_text)" in p for p in problems(item, STEM)))

    def test_a_file_in_the_repository_with_a_mutation_fails(self):
        # The same rules over the real files: break each one and the validator must object.
        for path in promo_files():
            base = json.loads(path.read_text(encoding="utf-8"))
            for name, mutate in (("no evidence", lambda i: i.update(evidence=[])),
                                 ("missing language", lambda i: i["texts"].pop("uz")),
                                 ("banned word", lambda i: i["texts"].update(en=i["texts"]["en"] + " It is free.")),
                                 ("bad link", lambda i: i.update(link="https://evil.example")),
                                 ("media", lambda i: i.update(ai_media=True))):
                item = copy.deepcopy(base)
                mutate(item)
                self.assertTrue(problems(item, path.stem), (path.name, name))


if __name__ == "__main__":
    unittest.main()
