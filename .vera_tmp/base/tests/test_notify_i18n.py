"""The languages of the customer notifications (migration 0105): one registry, one
data file per language, one lookup, and nothing that branches on a language.

What would break without these:

* a language file missing a key or a {placeholder} (a bot reply or a mail that is
  blank, or shows "{n}", in just that language);
* a Telegram message that Telegram refuses (over 4096 characters);
* somebody adding `if lang == "ru"` instead of a data file;
* the database's allow-list, the registry and the Settings pickers drifting apart;
* a language code reaching a path, a link or HTML without being checked;
* a language whose escaping differs from the others.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path
from unittest import mock

from modules import email_notify as mail
from modules import notify_i18n as i18n
from modules import notify_telegram as nt

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "supabase" / "functions" / "_shared" / "notify-i18n"
ORIGIN = "https://app.example.test"
TOKEN = "ab" * 32
TELEGRAM_LIMIT = 4096

# Every file whose job is to speak, send or pick a notification language: none may branch on a language.
SCANNED = [
    "modules/notify_i18n.py", "modules/notify_telegram.py", "modules/email_notify.py",
    "tools/notify_worker.py", "tools/email_worker.py",
    "supabase/functions/_shared/telegram-notify.ts", "supabase/functions/_shared/notify-i18n.ts",
    "supabase/functions/telegram-notify-webhook/index.ts",
    "command-center/components/notifications/NotificationChannels.tsx",
    "command-center/components/notifications/EmailNotifications.tsx",
    "command-center/lib/notify-channels.ts", "command-center/lib/email-prefs.ts",
    "command-center/lib/server/notify-channels.ts", "command-center/lib/server/notify-route.ts",
    "command-center/lib/server/email-prefs.ts",
    "command-center/app/api/notifications/telegram/route.ts",
    "command-center/app/api/notifications/telegram/channel/route.ts",
    "command-center/app/api/notifications/telegram/preference/route.ts",
    "command-center/app/api/email/unsubscribe/route.ts", "command-center/app/unsubscribe/page.tsx",
]
_NAME = r"(?:lang|language|locale|lng|chatLang|lang_code|langCode)"
_LIT = r"""["'][A-Za-z]{2,3}(?:[-_][A-Za-z]+)?["']"""
BRANCH = [
    re.compile(rf"\b{_NAME}\b\s*(?:===?|!==?)\s*{_LIT}"),
    re.compile(rf"{_LIT}\s*(?:===?|!==?)\s*\b{_NAME}\b"),
    re.compile(rf"\b{_NAME}\b\s+(?:not\s+)?in\s+[\(\[\{{]\s*{_LIT}"),
    re.compile(r"\bswitch\s*\(\s*\w*(?:lang|locale|language)\w*\s*\)", re.I),
    re.compile(rf"\bcase\s+{_LIT}\s*:"),
    re.compile(rf"\b{_NAME}\b\s*\.\s*(?:startswith|startsWith|endswith|endsWith)\(\s*{_LIT}"),
    re.compile(rf"\b{_NAME}\b\s*\)?\s*\?\s*{_LIT}\s*:"),
    # two or more registry codes written out together = a second copy of the list
    re.compile(r"""["']ru["'][^\n]{0,20}["']uz["']|["']uz["'][^\n]{0,20}["']ru["']"""),
]


def branches(source: str) -> list:
    hits = []
    for n, line in enumerate(source.splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith(("#", "//", "*", "/*")):
            continue
        if any(rx.search(line) for rx in BRANCH):
            hits.append((n, stripped))
    return hits


class Registry(unittest.TestCase):
    def test_the_registry_lists_codes_defaults_and_names(self):
        reg = json.loads((DATA / "registry.json").read_text(encoding="utf-8"))
        codes = [e["code"] for e in reg["languages"]]
        self.assertEqual(tuple(codes), i18n.LANGUAGES)
        self.assertEqual(len(set(codes)), len(codes))
        self.assertIn(reg["default"], codes)
        self.assertEqual(i18n.DEFAULT_LANGUAGE, "en")
        for e in reg["languages"]:
            self.assertRegex(e["code"], r"^[a-z]{2,3}$")
            self.assertTrue(e["native"].strip())
        self.assertTrue({"en", "ru", "uz"} <= set(codes))

    def test_there_is_exactly_one_data_file_per_registered_language(self):
        files = {p.stem for p in DATA.glob("*.json")} - {"registry"}
        self.assertEqual(files, set(i18n.LANGUAGES))

    def test_the_command_center_pickers_offer_exactly_the_registered_languages(self):
        core = (ROOT / "command-center" / "lib" / "i18n" / "core.ts").read_text(encoding="utf-8")
        listed = re.findall(r'\{ code: "([a-z]{2,3})", label:', core)
        self.assertEqual(set(listed), set(i18n.LANGUAGES))

    def test_the_database_allow_list_is_the_registry(self):
        """The newest migration that defines notify_language_ok lists exactly the registered codes."""
        found = None
        for path in sorted((ROOT / "supabase" / "migrations").glob("*.sql")):
            m = re.search(r"function public\.notify_language_ok\(p text\).*?array\[([^\]]*)\]", path.read_text(encoding="utf-8"), re.S)
            if m:
                found = set(re.findall(r"'([^']+)'", m.group(1)))
        self.assertEqual(found, set(i18n.LANGUAGES))


class Parity(unittest.TestCase):
    def test_every_language_has_exactly_englishs_keys_and_placeholders(self):
        en = i18n.BUNDLES["en"]
        for code, table in i18n.BUNDLES.items():
            self.assertEqual(set(table), set(en), f"{code}: keys differ from English")
            for key, line in table.items():
                self.assertTrue(line.strip(), f"{code}.{key} is empty")
                self.assertEqual(i18n.placeholders(line), i18n.placeholders(en[key]), f"{code}.{key}")

    def test_every_brace_is_a_plain_placeholder_never_format_syntax(self):
        for code, table in i18n.BUNDLES.items():
            for key, line in table.items():
                self.assertEqual(len(re.findall(r"[{}]", line)), 2 * len(re.findall(r"\{[A-Za-z_]\w*\}", line)),
                                 f"{code}.{key}: a brace that is not a {{name}} placeholder")

    def test_the_key_families_are_the_ones_the_code_reads(self):
        for key in i18n.BUNDLES["en"]:
            self.assertRegex(key, r"^(meta|bot|push|mail)\.[A-Za-z_]+$")

    def test_no_telegram_message_is_over_telegrams_limit_even_with_the_longest_values(self):
        long_handle = "@" + "h" * 64
        for code, table in i18n.BUNDLES.items():
            for key, line in table.items():
                if key.startswith(("bot.", "push.")):
                    filled = i18n.fill(line, handle=long_handle, language="L" * 40)
                    self.assertLessEqual(len(filled), TELEGRAM_LIMIT, f"{code}.{key}")
            for native in i18n.NATIVE_NAMES.values():
                self.assertLessEqual(len(native.encode()), 60)  # a button's callback/label stays short
        for code in i18n.LANGUAGES:
            for kind in (*nt.KINDS, "test"):
                msg = nt.build_message(ORIGIN, "1", kind, {}, code)
                self.assertLessEqual(len(msg["text"]), TELEGRAM_LIMIT, (code, kind))

    def test_the_wording_is_really_translated(self):
        en = i18n.BUNDLES["en"]
        for code in i18n.LANGUAGES:
            if code == "en":
                continue
            same = [k for k, v in i18n.BUNDLES[code].items()
                    if v == en[k] and not k.startswith("meta.") and len(re.sub(r"\{\w+\}|[^A-Za-z]", "", v)) > 6]
            self.assertEqual(same, [], f"{code}: still English")


class Lookup(unittest.TestCase):
    def test_only_a_registered_code_selects_a_language_and_everything_else_is_english(self):
        for odd in (None, 5, "", " ", "xx", "../../etc/passwd", "ru/../en", "en_US", "r", "rus", "ру", "\x00"):
            self.assertEqual(i18n.resolve(odd), "en", repr(odd))
            self.assertFalse(i18n.is_supported(odd), repr(odd))
        for code in i18n.LANGUAGES:
            self.assertEqual(i18n.resolve(code), code)
            self.assertEqual(i18n.resolve(f" {code.upper()} "), code)

    def test_a_language_not_in_the_registry_is_never_opened_as_a_file(self):
        with mock.patch.object(Path, "open", side_effect=AssertionError("a language code reached the file system")):
            for odd in ("xx", "../x", "ru/../../x"):
                i18n.text(odd, "push.open")
                i18n.section(odd, "mail")

    def test_a_missing_key_falls_back_to_english_per_key(self):
        bundles = dict(i18n.BUNDLES, xx={"push.open": "XX open"})
        with mock.patch.object(i18n, "BUNDLES", bundles):
            self.assertEqual(i18n.text("xx", "push.open"), "XX open")
            self.assertEqual(i18n.text("xx", "push.test"), i18n.BUNDLES["en"]["push.test"])
            self.assertEqual(i18n.section("xx", "push")["test"], i18n.BUNDLES["en"]["push.test"])

    def test_fill_is_one_pass_and_a_value_is_never_a_placeholder_or_format_syntax(self):
        self.assertEqual(i18n.fill("{channel}: {n}", channel="{n}", n=3), "{n}: 3")
        self.assertEqual(i18n.fill("{a} {b}", a="x"), "x {b}")
        self.assertEqual(i18n.fill("{a.__class__} {0}", a="x"), "{a.__class__} {0}")

    def test_a_broken_language_file_fails_loudly_at_load(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "registry.json").write_text(json.dumps({"default": "en", "languages": [
                {"code": "en", "native": "English"}, {"code": "../x", "native": "Bad"}]}), encoding="utf-8")
            (root / "en.json").write_text("{}", encoding="utf-8")
            with self.assertRaises(ValueError):
                i18n._load(root)
            (root / "registry.json").write_text(json.dumps({"default": "en", "languages": [
                {"code": "en", "native": "English"}]}), encoding="utf-8")
            (root / "en.json").write_text(json.dumps({"a": 1}), encoding="utf-8")
            with self.assertRaises(ValueError):
                i18n._load(root)


class NoBranchesOnALanguage(unittest.TestCase):
    def test_the_scanner_sees_the_patterns_it_exists_to_forbid(self):
        for bad in ('if lang == "ru":', "if (language === 'uz') {", 'x = "ru" if locale == "ru" else "en"',
                    'if code in ("ru", "uz"):', "switch (lang) {", 'case "ru":', 'if lang.startswith("ru"):',
                    'const l = lang ? "ru" : "en";', 'LANGS = ["ru", "uz"]', "if (locale !== 'en')"):
            self.assertTrue(branches(bad), bad)
        for fine in ('if lang in BUNDLES:', "const code = resolveLanguage(lang);", 'lang = notifyText(lang, "bot.help")',
                     "// lang == 'ru' is what NOT to write"):
            self.assertFalse(branches(fine), fine)

    def test_no_notification_code_branches_on_a_particular_language(self):
        for rel in SCANNED:
            path = ROOT / rel
            self.assertTrue(path.exists(), f"{rel} moved: update SCANNED")
            self.assertEqual(branches(path.read_text(encoding="utf-8")), [], rel)


class EveryLanguageRenders(unittest.TestCase):
    HOSTILE = '<script>alert(1)</script> "x" & {n}\r\nBcc: evil@example.test'

    def test_both_mails_render_in_every_language_with_its_own_lang_attribute_and_unsubscribe_link(self):
        ready = {"user_id": "u", "email": "ana@example.test", "token": TOKEN, "kind": "video_ready", "ref": "r",
                 "data": {"video_id": "v1", "channel_id": "c1"}, "channel": {"id": "c1", "name": "Night Owl"}}
        weekly = {"user_id": "u", "email": "ana@example.test", "token": TOKEN, "kind": "weekly", "ref": "d",
                  "digest": {"days": 7, "videos_made": 2, "waiting_videos": 1, "credits_available": 4.5,
                             "channels": [{"id": "c1", "name": "Night Owl", "made": 2, "waiting_videos": 1}]}}
        subjects = set()
        for code in i18n.LANGUAGES:
            for item, render in ((ready, mail.render_ready), (weekly, mail.render_weekly)):
                m = render(item, language=code, origin=ORIGIN)
                self.assertIn(f'<html lang="{code}"', m.html)
                self.assertIn(f"&amp;l={code}", m.html)
                self.assertIn(f"&l={code}", m.text)
                self.assertNotRegex(m.html + m.text + m.subject, r"\{\w+\}", code)
                subjects.add((code, m.subject))
        self.assertEqual(len({s for _, s in subjects}), len(subjects), "two languages share a subject")

    def test_escaping_and_header_safety_are_the_same_in_every_language(self):
        for code in i18n.LANGUAGES:
            item = {"user_id": "u", "email": "ana@example.test", "token": TOKEN, "kind": "video_ready", "ref": "r",
                    "data": {"video_id": "v1", "channel_id": "c1"}, "channel": {"id": "c1", "name": self.HOSTILE}}
            m = mail.render_ready(item, language=code, origin=ORIGIN)
            self.assertNotIn("<script>", m.html, code)
            self.assertIn("&lt;script&gt;", m.html, code)
            self.assertNotIn("\n", m.subject, code)
            self.assertNotIn("\r", m.subject, code)
            self.assertIn("{n}", m.subject + m.text, f"{code}: a value was read as a placeholder")
            for header in m.headers.values():
                self.assertNotRegex(header, r"[\r\n]")

    def test_an_unsupported_language_in_a_link_is_english_never_the_raw_value(self):
        links = mail.unsubscribe_links(ORIGIN, TOKEN, "ready", '"><script>')
        self.assertTrue(links["page"].endswith("&l=en"))
        self.assertNotIn("script", links["page"])

    def test_the_telegram_messages_are_in_the_chat_language_for_every_event_kind(self):
        for code in i18n.LANGUAGES:
            for kind in (*nt.KINDS, "test"):
                msg = nt.build_message(ORIGIN, "1", kind, {}, code)
                self.assertEqual(msg["text"], i18n.BUNDLES[code][f"push.{kind}"])
                if "reply_markup" in msg:
                    self.assertEqual(msg["reply_markup"]["inline_keyboard"][0][0]["text"], i18n.BUNDLES[code]["push.open"])


if __name__ == "__main__":
    unittest.main()
