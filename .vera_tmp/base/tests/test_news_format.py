"""The news items the Telegram channel may announce (docs/news/, docs/MARKETING_POSTS.md).

A public post is a claim about the product, so the words are reviewed like code: each change that
could be announced is one file in docs/news/, added in the pull request that ships it. This test is
the validator of record for those files and for the banned-claims list. It reads files only: no
network, no database, no model. An LLM is not involved in phase 1 (design, section 2.1).

What a file must pass:
  * the shape in docs/news/schema.json (checked by hand here: the suite carries no jsonschema);
  * the three languages exist, each a short plain paragraph in its own script;
  * the combined three-language message fits Telegram's 4096 characters, and a media caption's 1024;
  * no placeholder, markup, URL, hidden or control character;
  * every number appears in all three languages, so a figure cannot differ between them;
  * no banned claim (docs/news/banned-claims.json) and no provider or model name;
  * wording about the welcome grant states the real number and says it is one-time.
"""

import datetime
import json
import re
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
NEWS = REPO / "docs" / "news"
SCHEMA_PATH = NEWS / "schema.json"
BANNED_PATH = NEWS / "banned-claims.json"
BILLING = REPO / "docs" / "BILLING_PLANS.md"
WELCOME = REPO / "supabase" / "migrations" / "0027_welcome_credits.sql"

LANGS = ("uz", "ru", "en")
KINDS = ("feature", "fix")
TOP_KEYS = {"pr", "shipped", "kind", "public", "text", "link", "media"}
REQUIRED = ("pr", "shipped", "kind", "public", "text")
TEXT_MIN, TEXT_MAX = 20, 260
#: Telegram: 4096 characters in a message, 1024 in a photo or video caption (the caption figure is the
#: Bot API's as the design recalls it, so the stricter number is the one enforced).
MESSAGE_MAX, CAPTION_MAX = 4096, 1024
#: What the sender adds around the three blocks: the origin of our site in front of `link`.
LINK_ALLOWANCE = 120
FILE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.json$")
LINK_RE = re.compile(r"^/[a-z0-9][a-z0-9/_-]{0,78}$")
LABELS = {"uz": "Oʻzbekcha", "ru": "Русский", "en": "English"}
APOSTROPHES = str.maketrans({"ʻ": "'", "ʼ": "'", "‘": "'", "’": "'", "`": "'", "´": "'", "ё": "е"})
HIDDEN = re.compile("[\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u00ad]")
CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
PLACEHOLDER = re.compile(r"[{}<>\[\]]|%\w|\$\w|\b(todo|tbd|xxx|fixme|lorem|placeholder)\b|\.\.\.|…", re.I)
URLISH = re.compile(r"https?:|www\.|\b\w+\.(com|org|net|io|ai|uz|ru|me)\b|@\w|t\.me", re.I)
NUMBER = re.compile(r"\d+(?:[.,]\d+)?")
CYRILLIC = re.compile(r"[а-яА-ЯёЁ]")
LATIN = re.compile(r"[A-Za-z]")
WELCOME_WORD = re.compile(r"\bwelcome\b|приветств\w*|xush\s+kelibsiz", re.I)
ONE_TIME_WORD = re.compile(r"\bone-time\b|\bonce\b|единоразов\w*|разов\w*|однократн\w*|\bbir\s+marta\b", re.I)


# ── the rules, as functions the tests below also attack ─────────────────────

def normal(text: str) -> str:
    return text.casefold().translate(APOSTROPHES)


def banned_rules() -> list:
    data = json.loads(BANNED_PATH.read_text(encoding="utf-8"))
    return [(r["id"], [re.compile(p, re.I) for p in r["patterns"]]) for r in data["rules"]]


def provider_names() -> list:
    names = json.loads(BANNED_PATH.read_text(encoding="utf-8"))["provider_names"]["names"]
    return [(n, re.compile(r"(?<![\w-])" + re.escape(n) + r"(?![\w-])", re.I)) for n in names]


def real_welcome_credits() -> int:
    """The number the product really gives: the migration, cross-checked against the billing doc."""
    m = re.search(r"\b(\d+)\s+free credits", WELCOME.read_text(encoding="utf-8"))
    return int(m.group(1))


def banned_hits(text: str) -> list:
    """Every banned-claim rule id and provider name that `text` trips (empty when it is clean)."""
    t = normal(text)
    hits = [rid for rid, pats in banned_rules() if any(p.search(t) for p in pats)]
    hits += ["provider:" + n for n, p in provider_names() if p.search(t)]
    return hits


def message(item: dict) -> str:
    """One Telegram message: three labelled blocks, then the link path when there is one. The sender
    (a later slice) builds the same shape and puts our origin in front of the path."""
    blocks = [f"{LABELS[lang]}\n{item['text'][lang]}" for lang in LANGS]
    if item.get("link"):
        blocks.append(item["link"])
    return "\n\n".join(blocks)


def utf16_units(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def problems(item, stem: str) -> list:
    """Everything wrong with one parsed news file; [] means it is acceptable."""
    bad = []
    m = FILE_RE.match(stem + ".json")
    if not m:
        return [f"file name must be <yyyy-mm-dd>-<slug>.json, got {stem}.json"]
    if len(stem) > 80:
        bad.append("file name stem is longer than 80 characters")
    if not isinstance(item, dict):
        return ["the file must hold one JSON object"]
    for key in REQUIRED:
        if key not in item:
            bad.append(f"missing key {key!r}")
    for key in item:
        if key not in TOP_KEYS:
            bad.append(f"unknown key {key!r}")
    if bad:
        return bad

    pr = item["pr"]
    if isinstance(pr, bool) or not isinstance(pr, int) or pr < 1:
        bad.append("pr must be a positive integer")
    shipped = item["shipped"]
    try:
        if not isinstance(shipped, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", shipped):
            raise ValueError
        datetime.date.fromisoformat(shipped)
    except ValueError:
        bad.append("shipped must be a real date, yyyy-mm-dd")
    else:
        if shipped != m.group(1):
            bad.append(f"shipped {shipped} must equal the date in the file name {m.group(1)}")
        if shipped > datetime.date.today().isoformat():
            bad.append("shipped is in the future: announce what is live, not what is planned")
    if item["kind"] not in KINDS:
        bad.append(f"kind must be one of {KINDS}")
    if not isinstance(item["public"], bool):
        bad.append("public must be true or false (a missing decision is not a yes)")

    text = item["text"]
    if not isinstance(text, dict) or set(text) != set(LANGS):
        return bad + [f"text must have exactly the keys {LANGS}"]
    if not all(isinstance(text[lang], str) for lang in LANGS):
        return bad + ["every text must be a string"]

    if "link" in item and not (isinstance(item["link"], str) and LINK_RE.match(item["link"])
                               and "//" not in item["link"] and ".." not in item["link"]):
        bad.append("link must be a path on our own site such as /pricing")
    if "media" in item:
        media = item["media"]
        if (not isinstance(media, dict) or set(media) != {"hint"} or not isinstance(media["hint"], str)
                or not 3 <= len(media["hint"]) <= 200):
            bad.append("media must be {\"hint\": <3 to 200 characters>} and nothing else")

    for lang in LANGS:
        t = text[lang]
        if t != t.strip() or "  " in t:
            bad.append(f"{lang}: no leading, trailing or doubled spaces")
        if not TEXT_MIN <= len(t) <= TEXT_MAX:
            bad.append(f"{lang}: {len(t)} characters, allowed {TEXT_MIN} to {TEXT_MAX}")
        if CONTROL.search(t) or HIDDEN.search(t):
            bad.append(f"{lang}: control, newline or hidden characters")
        if PLACEHOLDER.search(t):
            bad.append(f"{lang}: placeholder, markup or unfinished text")
        if URLISH.search(t):
            bad.append(f"{lang}: no URL, domain, handle or address in the text (use link)")
        for hit in banned_hits(t):
            bad.append(f"{lang}: banned wording ({hit})")

    # Each language in its own script, and not three copies of one sentence.
    if not CYRILLIC.search(text["ru"]):
        bad.append("ru: no Cyrillic letters")
    if CYRILLIC.search(text["uz"]) or CYRILLIC.search(text["en"]):
        bad.append("uz and en are written in Latin letters only")
    if not LATIN.search(text["uz"]) or not LATIN.search(text["en"]):
        bad.append("uz and en need Latin letters")
    if len({normal(text[lang]) for lang in LANGS}) < 3:
        bad.append("two languages hold the same text")

    # A figure must be the same figure in every language.
    figures = {lang: sorted(NUMBER.findall(text[lang])) for lang in LANGS}
    if len({tuple(v) for v in figures.values()}) != 1:
        bad.append(f"numbers differ between languages: {figures}")

    # The welcome grant: the real number, and once.
    for lang in LANGS:
        t = text[lang]
        if WELCOME_WORD.search(t):
            if str(real_welcome_credits()) not in NUMBER.findall(t):
                bad.append(f"{lang}: wording about the welcome grant must say {real_welcome_credits()} credits")
            if not ONE_TIME_WORD.search(t):
                bad.append(f"{lang}: the welcome grant is one-time; say so")

    msg = message(item)
    if utf16_units(msg) + (LINK_ALLOWANCE if item.get("link") else 0) > CAPTION_MAX:
        bad.append(f"the combined message is {utf16_units(msg)} UTF-16 units; keep it within a "
                   f"{CAPTION_MAX}-character media caption (limit {MESSAGE_MAX} for a text message)")
    if max(len(msg), utf16_units(msg)) + LINK_ALLOWANCE > MESSAGE_MAX:
        bad.append("the combined message does not fit one Telegram message")
    return bad


def news_files() -> list:
    return sorted(p for p in NEWS.glob("*.json") if p.name not in (SCHEMA_PATH.name, BANNED_PATH.name))


def good_item(**over) -> dict:
    item = {
        "pr": 490, "shipped": "2026-10-15", "kind": "feature", "public": False,
        "text": {
            "uz": "Endi Sozlamalarda Telegram'ni ulab, video tayyor bo'lganda xabar olishingiz mumkin.",
            "ru": "Теперь можно привязать Telegram в настройках и получать сообщение, когда видео готово.",
            "en": "You can now link Telegram in Settings and get a message when your video is ready.",
        },
    }
    item.update(over)
    return item


STEM = "2026-10-15-example"


class NewsFiles(unittest.TestCase):
    def test_there_is_something_to_check(self):
        self.assertGreaterEqual(len(news_files()), 1)

    def test_every_file_in_docs_news_is_valid(self):
        failures = {}
        for path in news_files():
            try:
                item = json.loads(path.read_text(encoding="utf-8"))
            except ValueError as e:
                failures[path.name] = [f"not JSON: {e}"]
                continue
            found = problems(item, path.stem)
            if found:
                failures[path.name] = found
        self.assertEqual(failures, {})

    def test_only_the_schema_the_banned_list_and_dated_items_live_here(self):
        stray = [p.name for p in NEWS.iterdir()
                 if p.is_file() and p.name not in ("README.md", SCHEMA_PATH.name, BANNED_PATH.name) and not FILE_RE.match(p.name)]
        self.assertEqual(stray, [], "a stray file in docs/news is either misnamed or does not belong")

    def test_slugs_are_unique_because_the_slug_becomes_the_idempotency_key(self):
        slugs = [FILE_RE.match(p.name).group(2) for p in news_files()]
        self.assertEqual(len(slugs), len(set(slugs)))

    def test_pull_requests_are_not_announced_twice(self):
        prs = [json.loads(p.read_text(encoding="utf-8"))["pr"] for p in news_files()]
        self.assertEqual(len(prs), len(set(prs)))

    def test_the_example_is_not_public(self):
        # The one shipped example must never be announceable: it exists so the format has something to chew on.
        examples = [p for p in news_files() if "example" in p.name]
        self.assertTrue(examples)
        for p in examples:
            self.assertIs(json.loads(p.read_text(encoding="utf-8"))["public"], False, p.name)

    def test_json_files_in_docs_news_are_not_swallowed_by_gitignore(self):
        # The repository ignores *.json; the supabase notify-i18n files were once lost to it (0105).
        self.assertIn("!docs/news/*.json", (REPO / ".gitignore").read_text(encoding="utf-8").splitlines())


class SchemaFileAgreesWithTheValidator(unittest.TestCase):
    def setUp(self):
        self.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    def test_keys_kinds_and_limits_match(self):
        self.assertEqual(set(self.schema["properties"]), TOP_KEYS)
        self.assertEqual(tuple(self.schema["required"]), REQUIRED)
        self.assertIs(self.schema["additionalProperties"], False)
        self.assertEqual(tuple(self.schema["properties"]["kind"]["enum"]), KINDS)
        text = self.schema["properties"]["text"]
        self.assertEqual(set(text["required"]), set(LANGS))
        self.assertEqual(set(text["properties"]), set(LANGS))
        for lang in LANGS:
            self.assertEqual((text["properties"][lang]["minLength"], text["properties"][lang]["maxLength"]), (TEXT_MIN, TEXT_MAX))
        self.assertEqual(self.schema["properties"]["link"]["pattern"], LINK_RE.pattern)


class TheValidatorCatchesWhatItIsFor(unittest.TestCase):
    def test_a_clean_item_passes(self):
        self.assertEqual(problems(good_item(), STEM), [])

    def test_a_missing_decision_or_language_fails(self):
        item = good_item()
        del item["public"]
        self.assertIn("missing key 'public'", problems(item, STEM))
        item = good_item()
        del item["text"]["uz"]
        self.assertTrue(any("exactly the keys" in p for p in problems(item, STEM)))
        self.assertTrue(any("public must be" in p for p in problems(good_item(public="yes"), STEM)))

    def test_unknown_keys_and_bad_names_fail(self):
        self.assertIn("unknown key 'draft'", problems(good_item(draft=True), STEM))
        self.assertTrue(problems(good_item(), "2026-10-15_Example"))
        self.assertTrue(problems(good_item(shipped="2026-10-16"), STEM))
        self.assertTrue(problems(good_item(shipped="2999-01-01"), "2999-01-01-example"))
        self.assertTrue(problems(good_item(kind="security"), STEM))
        self.assertTrue(problems(good_item(pr=0), STEM))
        self.assertTrue(problems(good_item(pr=True), STEM))

    def test_links_are_paths_on_our_own_site(self):
        for ok in ("/pricing", "/blog/post-1"):
            self.assertEqual(problems(good_item(link=ok), STEM), [], ok)
        for bad in ("https://evil.example/x", "//evil.example", "pricing", "/a/../b", "/a?x=1", "/Pricing", ""):
            self.assertTrue(problems(good_item(link=bad), STEM), bad)

    def test_length_limits_each_language(self):
        item = good_item()
        item["text"]["en"] = ("You can now link Telegram in Settings. " * 8).strip()
        self.assertTrue(any("en:" in p and "characters, allowed" in p for p in problems(item, STEM)))
        item = good_item()
        item["text"]["en"] = "Short."
        self.assertTrue(any("en:" in p and "characters, allowed" in p for p in problems(item, STEM)))

    def test_the_longest_valid_message_still_fits_a_media_caption(self):
        # The per-language maximum is chosen so that three full blocks, their labels and a link stay inside
        # 1024 characters: a post may later carry a photo or video without a second set of limits.
        item = good_item(link="/pricing")
        item["text"]["uz"] = ("Salom dunyo " * 30)[:TEXT_MAX].strip()
        item["text"]["ru"] = ("Привет мир " * 30)[:TEXT_MAX].strip()
        item["text"]["en"] = ("Hello world " * 30)[:TEXT_MAX].strip()
        self.assertEqual(problems(item, STEM), [])
        self.assertLessEqual(utf16_units(message(item)) + LINK_ALLOWANCE, CAPTION_MAX)
        self.assertLess(utf16_units(message(item)) + LINK_ALLOWANCE, MESSAGE_MAX)

    def test_the_combined_message_limit_fires_when_it_is_the_only_thing_wrong(self):
        for name, limit in (("CAPTION_MAX", 100), ("MESSAGE_MAX", 100)):
            with mock.patch.dict(globals(), {name: limit}):
                found = problems(good_item(), STEM)
            self.assertTrue(any("combined message" in p for p in found), (name, found))

    def test_placeholders_markup_urls_and_hidden_text_fail(self):
        for bad, why in (("Now {price} credits for every plan today.", "placeholder"),
                         ("See <b>this</b> new feature in Settings.", "placeholder"),
                         ("TODO write the real announcement here.", "placeholder"),
                         ("Unfinished sentence that trails off...", "placeholder"),
                         ("Price is $price for this fresh plan.", "placeholder"),
                         ("Read more at https://example.com/news today.", "no URL"),
                         ("Write to us at team@example.com about it.", "no URL"),
                         ("Follow @nightshift for updates and more.", "no URL"),
                         ("Line one\nline two of the announcement.", "control"),
                         ("A hidden\u200b character sits in this sentence.", "hidden"),
                         ("Double  space inside this announcement text.", "doubled spaces")):
            item = good_item()
            item["text"]["en"] = bad
            self.assertTrue(any(f"en:" in p and why in p for p in problems(item, STEM)), (bad, problems(item, STEM)))

    def test_scripts_and_copies_are_checked(self):
        item = good_item()
        item["text"]["ru"] = item["text"]["en"]
        self.assertTrue(any("no Cyrillic" in p for p in problems(item, STEM)))
        item = good_item()
        item["text"]["uz"] = item["text"]["ru"]
        self.assertTrue(any("Latin letters only" in p for p in problems(item, STEM)))
        item = good_item()
        item["text"]["uz"] = item["text"]["en"]
        self.assertTrue(any("same text" in p for p in problems(item, STEM)))

    def test_a_number_must_be_the_same_in_every_language(self):
        item = good_item()
        item["text"]["en"] = "You can now link Telegram and get 3 messages when your video is ready."
        item["text"]["ru"] = "Теперь можно привязать Telegram и получать 4 сообщения, когда видео готово."
        item["text"]["uz"] = "Endi Telegram'ni ulab, video tayyor bo'lganda 3 ta xabar olishingiz mumkin."
        self.assertTrue(any("numbers differ" in p for p in problems(item, STEM)))
        item["text"]["ru"] = item["text"]["ru"].replace("4", "3")
        self.assertEqual(problems(item, STEM), [])


class BannedClaims(unittest.TestCase):
    #: one sentence per rule and language that MUST be refused, and a sentence nearby that must pass
    MUST_FAIL = {
        "free": ["Start for free today.", "Try the free plan now.", "Попробуйте бесплатно уже сегодня.", "Bepul sinab ko'ring bugun."],
        "unlimited": ["Unlimited videos every month.", "Безлимитные видео каждый месяц.", "Cheksiz video har oy."],
        "guarantee": ["We guarantee a great result.", "Мы гарантируем результат.", "Natijaga kafolat beramiz."],
        "superlative": ["The best video tool.", "Лучший редактор видео.", "Eng yaxshi video vositasi.", "The fastest renders."],
        "income": ["Earn money with your channel.", "Ваш канал принесет доход.", "Kanal bilan daromad toping.", "Make money fast."],
        "views": ["Get more views on every video.", "Go viral this week.", "Больше просмотров каждому видео.", "Ko'proq ko'rishlar oling."],
        "certainty": ["Yours forever, 100% sure.", "Это навсегда.", "Bu abadiy."],
        "endorsement": ["Official YouTube partner.", "Официальный партнер YouTube.", "Google certified tool."],
    }
    MUST_PASS = [
        "The Plus plan includes 6000 credits every month.", "Plus тарифи: oyiga 6000 kredit.", "Подробности на странице цен.",
        "Telegram messages are available in Settings.", "A one-time welcome grant of 100 credits.",
    ]

    def test_every_rule_fires_in_each_language_it_covers(self):
        for rule, samples in self.MUST_FAIL.items():
            for s in samples:
                self.assertIn(rule, banned_hits(s), f"{rule}: {s!r} was not caught")

    def test_ordinary_wording_passes(self):
        for s in self.MUST_PASS:
            self.assertEqual(banned_hits(s), [], s)

    def test_apostrophe_variants_do_not_hide_a_claim(self):
        for s in ("Eng zo'r vosita", "Eng zo\u2019r vosita", "Eng zo\u02bbr vosita", "Eng zo\u02bcr vosita", "ENG YAXSHI vosita"):
            self.assertIn("superlative", banned_hits(s), s)

    def test_provider_and_model_names_are_refused_as_whole_words(self):
        def providers(s):
            return [h for h in banned_hits(s) if h.startswith("provider:")]
        for s in ("Now with Kling for clips.", "Powered by ELEVENLABS voices.", "Sora and Veo are in.", "Uses OpenAI models."):
            self.assertTrue(providers(s), s)
        # a name inside another word is not a mention
        self.assertEqual(providers("Fluxional showcase of lunar videos, with wanderlust and a vegan menu."), [])

    def test_the_list_itself_is_well_formed(self):
        data = json.loads(BANNED_PATH.read_text(encoding="utf-8"))
        ids = [r["id"] for r in data["rules"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(set(ids), set(self.MUST_FAIL), "a rule without a sample that proves it fires")
        for rule in data["rules"]:
            self.assertTrue(rule["why"].strip())
            for pattern in rule["patterns"]:
                re.compile(pattern)
                self.assertFalse(re.search(pattern, "", re.I) and pattern, f"{pattern!r} matches the empty string")
        names = data["provider_names"]["names"]
        self.assertEqual(len(names), len(set(names)))
        self.assertTrue(all(n == n.lower() for n in names))


class WelcomeGrantWording(unittest.TestCase):
    def test_the_real_number_comes_from_the_migration_and_the_billing_doc_agrees(self):
        n = real_welcome_credits()
        self.assertEqual(n, 100)
        billing = BILLING.read_text(encoding="utf-8")
        self.assertRegex(billing, rf"xush kelibsiz {n} kredit")

    def test_wording_about_the_grant_names_the_number_and_says_once(self):
        def item(en, ru, uz):
            return good_item(text={"uz": uz, "ru": ru, "en": en})
        ok = item("Every new account gets a one-time welcome grant of 100 credits.",
                  "Каждый новый аккаунт получает единоразовый приветственный бонус: 100 кредитов.",
                  "Har bir yangi hisob bir marta xush kelibsiz sovg'asi sifatida 100 kredit oladi.")
        self.assertEqual(problems(ok, STEM), [])
        wrong_number = item("Every new account gets a one-time welcome grant of 500 credits.",
                            "Каждый новый аккаунт получает единоразовый приветственный бонус: 500 кредитов.",
                            "Har bir yangi hisob bir marta xush kelibsiz sovg'asi sifatida 500 kredit oladi.")
        self.assertTrue(any("must say 100" in p for p in problems(wrong_number, STEM)))
        not_once = item("Every new account gets a welcome grant of 100 credits every month.",
                        "Каждый новый аккаунт получает приветственный бонус: 100 кредитов каждый месяц.",
                        "Har bir yangi hisob har oy xush kelibsiz sovg'asi sifatida 100 kredit oladi.")
        self.assertTrue(any("one-time" in p for p in problems(not_once, STEM)))


if __name__ == "__main__":
    unittest.main()
