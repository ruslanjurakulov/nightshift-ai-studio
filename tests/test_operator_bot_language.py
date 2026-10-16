"""The operator bot speaks the owner's language: English (default), Russian,
Uzbek (Latin). One copy table per language, one lookup, no per-language
branches. These tests pin what a new language (the product will get more) must
satisfy to be added as data only, and that the language changes the words and
nothing else: authorization, the intent path and the escaping are the same in
every language."""

import re
import string
import unittest
from unittest.mock import patch

from modules.operator_bot import alerts, i18n, router, views
from modules.operator_bot.config import OperatorConfig
from modules.operator_bot.i18n import DEFAULT_LANGUAGE, LANGUAGES, Raw, t, table, tp
from modules.operator_bot.store import MemoryAlertStore, SupabaseAlertStore, pick_language
from modules.telegram_control import TelegramControl, route_command
from tests.operator_bot_fakes import (
    FakeHttp, FakeSync, FakeTelegram, NOW, github_ok, healthy_tables, make_control, make_ops, site_ok,
    ts, update_callback, update_message,
)
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EN = table("en")


def placeholders(template):
    return {name for _l, name, _s, _c in string.Formatter().parse(template) if name}


class Deps:
    def status_summary(self):
        return "plain status"

    def list_channels(self):
        return [{"channel_id": "default", "status": "ACTIVE", "auto_publish": True},
                {"channel_id": "finance", "status": "PAUSED", "auto_publish": False}]

    def pending_review(self):
        return [{"video_id": "v1", "title": "T"}]


def build(lang_env="en", tables=None, store=None):
    tg = FakeTelegram()
    control = make_control(tg)
    t_ = healthy_tables()
    t_.update(tables or {})
    cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", language=lang_env)
    ops, sync = make_ops(t_, FakeHttp({**site_ok(), **github_ok()}), cfg)
    store = store or MemoryAlertStore(lambda: NOW)
    bot = router.OperatorBot(control, Deps(), ops, store, cfg, clock=lambda: NOW.timestamp())
    return bot, tg, sync, store


class TablesTestCase(unittest.TestCase):
    def test_the_language_list_is_one_constant_and_each_language_has_a_data_file(self):
        self.assertEqual(DEFAULT_LANGUAGE, "en")
        self.assertEqual(LANGUAGES[0], "en")
        self.assertEqual(len(set(LANGUAGES)), len(LANGUAGES))
        for code in LANGUAGES:
            self.assertRegex(code, r"^[a-z]{2}$")
            self.assertTrue((ROOT / "modules" / "operator_bot" / "copy_data" / f"{code}.py").is_file(), code)
        files = {p.stem for p in (ROOT / "modules" / "operator_bot" / "copy_data").glob("*.py") if p.stem != "__init__"}
        self.assertEqual(files, set(LANGUAGES), "a copy_data file that is not in LANGUAGES (or the reverse)")

    def test_every_language_has_exactly_englishs_keys(self):
        for code in LANGUAGES:
            tb = table(code)
            with self.subTest(language=code):
                self.assertEqual(sorted(set(EN) - set(tb)), [], "missing keys")
                self.assertEqual(sorted(set(tb) - set(EN)), [], "keys English does not have")

    def test_every_language_has_exactly_englishs_placeholders_per_key(self):
        for code in LANGUAGES:
            tb = table(code)
            for key, template in EN.items():
                with self.subTest(language=code, key=key):
                    self.assertEqual(placeholders(tb[key]), placeholders(template))

    def test_placeholders_are_plain_names_with_no_format_specs(self):
        for code in LANGUAGES:
            for key, template in table(code).items():
                for _lit, name, spec, conv in string.Formatter().parse(template):
                    if name is not None:
                        with self.subTest(language=code, key=key):
                            self.assertRegex(name, r"^[a-z_]+$")
                            self.assertFalse(spec or conv, "no format spec / conversion in a template")

    def test_templates_use_only_the_allowed_markup(self):
        for code in LANGUAGES:
            for key, template in table(code).items():
                if key.startswith(("legacy.", "status.", "channels.", "pending.")):
                    continue            # sent as plain text, no parse mode
                with self.subTest(language=code, key=key):
                    stripped = re.sub(r"</?(?:b|code)>|&lt;|&gt;", "", template)
                    self.assertNotRegex(stripped, r"[<>&]")
                    self.assertEqual(template.count("<b>"), template.count("</b>"))
                    self.assertNotIn('"', template)
                    self.assertNotIn("'", template)      # a value-style template is escaped again

    def test_english_has_no_untranslated_copy_in_other_languages(self):
        for code in LANGUAGES:
            if code == "en":
                continue
            same = [k for k, v in table(code).items() if v == EN[k] and re.search(r"[A-Za-z]{4,}", re.sub(r"\{[a-z_]+\}", "", v))
                    and k not in ("wf.deploy", "wf.frontend", "digest.title")]
            # technical names and commands may match; prose may not
            prose = [k for k in same if not k.startswith(("st.", "kind.", "cmddesc.")) and len(EN[k]) > 25
                     and k != "help.request_cmds"]       # the command list itself is not translated
            with self.subTest(language=code):
                self.assertEqual(prose, [])

    def test_no_per_language_branch_in_the_code(self):
        files = list((ROOT / "modules" / "operator_bot").glob("*.py")) + [
            ROOT / "modules" / "telegram_control.py", ROOT / "tools" / "run_telegram_control.py",
            ROOT / "tools" / "run_operator_alerts.py", ROOT / "tools" / "operator_bot_service.py"]
        for path in files:
            text = path.read_text(encoding="utf-8")
            with self.subTest(file=path.name):
                self.assertNotRegex(text, r"""\blang\w*\s*(?:==|!=)\s*["'](?:en|ru|uz)["']""")
                self.assertNotRegex(text, r"""\blang\w*\s+in\s+\(?\s*["'](?:en|ru|uz)["']""")

    def test_every_key_the_code_asks_for_exists(self):
        used = set()
        pattern = re.compile(r"""\bt[p]?\(\s*[^,()]+(?:\([^)]*\))?[^,()]*,\s*f?["']([a-z_]+\.[a-z_.]+)["']""")
        for path in list((ROOT / "modules" / "operator_bot").glob("*.py")) + [
                ROOT / "modules" / "telegram_control.py", ROOT / "tools" / "run_telegram_control.py",
                ROOT / "tools" / "operator_bot_service.py"]:
            used |= set(pattern.findall(path.read_text(encoding="utf-8")))
        self.assertGreater(len(used), 100)
        self.assertEqual(sorted(k for k in used if k not in EN), [])
        # the families built from a name
        families = (
            [f"cmd.{n}" for n, _ in views.COMMANDS] + [f"cmddesc.{n}" for n, _ in views.COMMANDS]
            + [f"cmd.{n}" for _g, names in views.MENU_GROUPS for n in names]
            + [f"grp.{g}" for g, _ in views.MENU_GROUPS]
            + [f"kind.{k}" for k in (*views.ALERT_KINDS, "all")]
            + [f"sev.{s}" for s in ("critical", "warn", "info")]
            + [f"wf.{w}" for w in ("deploy", "tests", "frontend")]
            + [f"btn.open_{p}" for p in re.findall(r'open_button\(lang, "([a-z]+)"',
                                                    (ROOT / "modules/operator_bot/views.py").read_text())]
            + ["queue.run", "queue.job"])
        self.assertEqual(sorted(k for k in families if k not in EN), [])


class UzbekSpellingTestCase(unittest.TestCase):
    """The site's rule (command-center/tests/uz-apostrophes.test.ts): oʻ and gʻ
    with U+02BB, the tutuq with U+02BC, a suffix after a Latin name with U+2019;
    never an ASCII apostrophe inside a word."""

    def text(self):
        return (ROOT / "modules" / "operator_bot" / "copy_data" / "uz.py").read_text(encoding="utf-8")

    def test_no_ascii_apostrophe_after_a_letter(self):
        hits = re.findall(r"\S*[A-Za-zʻʼ]'\S*", self.text())
        self.assertEqual(hits, [])

    def test_no_u2018_where_the_letter_belongs(self):
        self.assertEqual(re.findall(r"\S*‘\S*", self.text()), [])

    def test_o_and_g_take_u02bb_not_the_tutuq_or_a_quote(self):
        hits = [m for m in re.findall(r"\b\S*[oOgG][ʼ’‘](?=[a-z])\S*", self.text())
                if not re.match(r"^(?:YouTube|Google|Studio|ID)", m)]
        self.assertEqual(hits, [])

    def test_the_letters_are_really_used(self):
        text = "".join(table("uz").values())
        self.assertIn("oʻ", text)
        self.assertIn("gʻ", text)
        self.assertIn("ʼ", text)             # maʼlumot / nomaʼlum
        self.assertIn("’", text)             # a suffix after a Latin name (main’dagi)


class LookupTestCase(unittest.TestCase):
    def test_unknown_or_missing_language_is_english(self):
        for code in (None, "", "xx", "EN-us".replace("EN-us", "zz"), 5):
            self.assertEqual(t(code, "btn.menu"), "Menu")
        self.assertEqual(i18n.normalize_language("RU"), "ru")
        self.assertEqual(i18n.normalize_language("uz_UZ"), "uz")
        self.assertEqual(i18n.normalize_language("ru-RU"), "ru")
        self.assertEqual(i18n.normalize_language("klingon"), "en")
        self.assertEqual(i18n.normalize_language(None), "en")

    def test_a_missing_key_falls_back_to_english_then_to_the_key(self):
        with patch.dict(i18n._TABLES, {"ru": {k: v for k, v in table("ru").items() if k != "btn.menu"}}):
            self.assertEqual(t("ru", "btn.menu"), "Menu")
            self.assertEqual(t("ru", "btn.refresh"), "Обновить")
        self.assertEqual(t("en", "no.such.key"), "no.such.key")

    def test_a_broken_translation_never_raises(self):
        with patch.dict(i18n._TABLES, {"ru": {**table("ru"), "ago": "{age.__class__} {0} {"}}):
            self.assertEqual(t("ru", "ago", age="3m"), "3m ago")      # falls back to English

    def test_values_are_escaped_unless_raw(self):
        for code in LANGUAGES:
            out = t(code, "errors.ids", ids="<b>x</b> & <script>")
            self.assertNotIn("<script>", out)
            self.assertIn("&lt;script&gt;", out)
            self.assertIn("<b>x</b>", t(code, "errors.ids", ids=Raw("<b>x</b>")))

    def test_a_placeholder_may_be_called_key_or_lang(self):
        self.assertEqual(t("en", "alerts.last_line", key="k", when="3m ago"), "• k · 3m ago")
        self.assertEqual(t("en", "alerts.last_line", lang="x", key="k", when="w"), "• k · w")

    def test_the_docs_cover_the_language_setting(self):
        docs = (ROOT / "docs" / "operator-bot.md").read_text(encoding="utf-8")
        for needle in ("OPERATOR_LANGUAGE", "/language", "operator.language", "LANGUAGES", "Русский", "Oʻzbekcha"):
            self.assertIn(needle, docs)
        example = (ROOT / ".env.example").read_text(encoding="utf-8")
        self.assertRegex(example, r"(?m)^OPERATOR_LANGUAGE=")

    def test_a_missing_value_shows_a_question_mark_not_a_crash(self):
        self.assertIn("?", t("en", "ago"))

    def test_plain_lookup_does_not_escape(self):
        self.assertEqual(tp("en", "legacy.requested", cmd="pause", target="a&b", note=""), "Requested: pause a&b.")

    def test_numbers_and_ages_stay_neutral_in_every_language(self):
        self.assertEqual(views.num("uz", 1234567), "1,234,567")
        self.assertEqual(views.num("ru", 1234567), "1,234,567")
        self.assertEqual(views.usd(1.5), "$1.50")


class EveryLanguageEveryViewTestCase(unittest.TestCase):
    def rich(self):
        many = [{"id": i, "channel_id": "channel-with-a-long-name-" + str(i), "kind": "daily", "status": "failed",
                 "attempts": 3, "max_attempts": 3, "finished_at": ts(30), "created_at": ts(60),
                 "heartbeat_at": ts(30), "started_at": ts(50)} for i in range(120)]
        running = [{"id": 1000 + i, "channel_id": "default", "kind": "daily", "status": "running", "attempts": 1,
                    "max_attempts": 3, "heartbeat_at": ts(40), "started_at": ts(60), "created_at": ts(70)}
                   for i in range(30)]
        return {
            "render_jobs": many + running,
            "creative_jobs": [{"id": f"id-{i}", "capability": "image", "status": "failed", "finished_at": ts(5),
                               "error_code": "provider_error"} for i in range(10)],
            "worker_status": [{"worker_id": "nightshift-01", "kind": "pipeline", "state": "failed",
                               "detail": "x " * 80, "updated_at": ts(2)}],
            "publish_approvals": [{"id": f"p{i}", "channel_id": "default", "status": "pending",
                                   "requested_at": ts(90)} for i in range(20)],
            "pipeline_runs": [{"run_id": f"run-{i}", "updated_at": ts(95)} for i in range(20)],
            "app_audit_log": [{"id": str(i), "at": ts(1), "action": "secret.write", "target": "t" * 60,
                               "channel_id": None} for i in range(30)],
            "provider_balances": [{"provider": "elevenlabs", "metric": "credits", "remaining": 10, "total": 100,
                                   "unit": "credits", "tier": "creator", "checked_at": ts(5)}],
            "creative_job_costs": [{"usd_estimate": None, "recorded_at": ts(10)}],
        }

    def test_every_view_in_every_language_fits_a_message_and_is_well_formed(self):
        for lang in LANGUAGES:
            ops, _ = make_ops({**healthy_tables(), **self.rich()}, FakeHttp({**site_ok(), **github_ok(deploy="failure")}))
            replies = {
                "health": views.view_health(ops, lang), "queue": views.view_queue(ops, lang),
                "errors": views.view_errors(ops, lang), "balance": views.view_balance(ops, lang),
                "spend": views.view_spend(ops, lang), "today": views.view_today(ops, lang),
                "users": views.view_users(ops, lang), "deploys": views.view_deploys(ops, lang),
                "approvals": views.view_approvals(ops, [{"video_id": "v"}], lang),
                "security": views.view_security(ops, lang), "digest": views.view_digest(ops, [{"video_id": "v"}], lang),
                "menu": views.view_menu(ops.cfg, lang), "help": views.view_help(lang),
                "language": views.view_language(ops.cfg, lang),
                "alerts": views.view_alerts(ops.cfg, None, NOW, lang),
            }
            for name, r in replies.items():
                with self.subTest(language=lang, view=name):
                    self.assertLessEqual(len(r.text), 4096)
                    stripped = re.sub(r"</?(b|code)>", "", r.text)
                    self.assertNotIn("<", stripped)
                    self.assertEqual(r.text.count("<b>"), r.text.count("</b>"))
                    self.assertEqual(r.text.count("<code>"), r.text.count("</code>"))
                    for row in r.keyboard:
                        for button in row:
                            self.assertTrue(button["text"].strip())
                            self.assertLessEqual(len(button.get("callback_data", "").encode()), 64)

    def test_the_words_really_change(self):
        ops, _ = make_ops(healthy_tables(), FakeHttp({**site_ok(), **github_ok()}))
        en = views.view_health(ops, "en").text
        for lang in ("ru", "uz"):
            other = views.view_health(ops, lang).text
            self.assertNotEqual(other, en)
            self.assertNotIn("Health", other)
        self.assertIn("Здоровье", views.view_health(ops, "ru").text)
        self.assertIn("Salomatlik", views.view_health(ops, "uz").text)

    def test_a_template_with_realistic_longest_values_fits_after_substitution(self):
        # ids and codes are cut to 64 characters by the views before they reach a template
        long = "v" * 64
        for lang in LANGUAGES:
            for key, template in table(lang).items():
                values = {name: long for name in placeholders(template)}
                with self.subTest(language=lang, key=key):
                    self.assertLessEqual(len(t(lang, key, **values)), 4096)

    def test_the_menu_and_help_offer_the_language_buttons_in_each_languages_own_name(self):
        for lang in LANGUAGES:
            for r in (views.view_menu(OperatorConfig(), lang), views.view_help(lang), views.view_language(OperatorConfig(), lang)):
                row = [b for row in r.keyboard for b in row if b.get("callback_data", "").startswith("l:")]
                self.assertEqual([b["callback_data"] for b in row], [f"l:{c}" for c in LANGUAGES])
                self.assertEqual([b["text"] for b in row], ["English", "Русский", "Oʻzbekcha"])


class AlertsInTheOwnersLanguageTestCase(unittest.TestCase):
    def failed(self, i):
        return {"id": i, "channel_id": "default", "status": "failed", "attempts": 3, "max_attempts": 3,
                "finished_at": ts(30), "created_at": ts(50)}

    def engine(self, lang):
        tg = FakeTelegram()
        ops, sync = make_ops(healthy_tables(), FakeHttp({**site_ok(), **github_ok()}),
                             OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo"))
        store = MemoryAlertStore(lambda: NOW)
        if lang:
            store.record_language(lang)
        eng = alerts.AlertEngine(ops, store, make_control(tg), ops.cfg, low_credits=15000)
        return eng, store, tg, ops

    def test_baseline_alert_buttons_and_digest_are_in_the_stored_language(self):
        eng, store, tg, ops = self.engine("ru")
        eng.tick()
        self.assertIn("Оповещения оператора включены", tg.texts()[-1])
        ops.sync.tables["render_jobs"] = [self.failed(9)]
        eng.tick()
        payload = tg.sent()[-1]
        self.assertIn("ВНИМАНИЕ — сбои запусков", payload["text"])
        self.assertIn("Задача рендера #9 завершилась сбоем", payload["text"])
        row = payload["reply_markup"]["inline_keyboard"][0]
        self.assertEqual([b["text"] for b in row], ["Открыть", "Тишина на 24 ч", "Подробнее"])
        self.assertEqual([b.get("callback_data") for b in row[1:]], ["a:mute:run", "d:run"])   # ids never change
        self.assertIn("Дневная сводка", alerts.send_digest_reply(ops, None, "ru").text)

    def test_uzbek_alert(self):
        eng, store, tg, ops = self.engine("uz")
        eng.tick()
        ops.sync.tables["render_jobs"] = [self.failed(9)]
        eng.tick()
        self.assertIn("DIQQAT — nosoz ishga tushirishlar", tg.texts()[-1])
        self.assertEqual([b["text"] for b in tg.sent()[-1]["reply_markup"]["inline_keyboard"][0]],
                         ["Ochish", "24 soat jim", "Batafsil"])

    def test_dedupe_keys_do_not_depend_on_the_language(self):
        keys = {}
        for lang in LANGUAGES:
            ops, _ = make_ops({**healthy_tables(), "render_jobs": [self.failed(9)],
                               "app_audit_log": [{"id": "7", "at": ts(5), "action": "secret.write", "target": "x",
                                                  "channel_id": None}]},
                              FakeHttp({**site_ok(), **github_ok(deploy="failure")}))
            keys[lang] = sorted((a.kind, a.key, a.severity, a.cooldown_min) for a in alerts.detect(ops, 15000, lang))
        self.assertEqual(keys["en"], keys["ru"])
        self.assertEqual(keys["en"], keys["uz"])
        self.assertGreater(len(keys["en"]), 2)

    def test_a_language_change_does_not_resend_an_alert(self):
        eng, store, tg, ops = self.engine("en")
        eng.tick()
        ops.sync.tables["render_jobs"] = [self.failed(9)]
        self.assertEqual(eng.tick().sent, 1)
        store.record_language("uz")
        self.assertEqual(eng.tick().sent, 0)

    def test_every_alert_line_in_every_language_is_escaped(self):
        hostile = "<b>x</b>&<script>"
        for lang in LANGUAGES:
            ops, _ = make_ops({**healthy_tables(), "render_jobs": [
                {"id": 1, "channel_id": hostile, "status": "failed", "attempts": 1, "max_attempts": 3,
                 "finished_at": ts(5), "created_at": ts(9)}]}, FakeHttp({**site_ok(), **github_ok()}))
            for a in alerts.detect(ops, 15000, lang):
                self.assertNotIn("<script>", a.line)


class RouterLanguageTestCase(unittest.TestCase):
    def test_default_is_english_and_env_default_applies_until_a_choice_is_stored(self):
        bot, tg, *_ = build()
        bot.handle_update(update_message("/health"))
        self.assertIn("Health", tg.texts()[-1])
        bot, tg, *_ = build(lang_env="ru")
        bot.handle_update(update_message("/health"))
        self.assertIn("Здоровье", tg.texts()[-1])

    def test_language_command_shows_the_current_language_and_the_buttons(self):
        bot, tg, *_ = build()
        bot.handle_update(update_message("/language"))
        payload = tg.sent()[-1]
        self.assertIn("Language: <b>English</b>", payload["text"])
        data = [b["callback_data"] for row in payload["reply_markup"]["inline_keyboard"] for b in row]
        self.assertTrue({"l:en", "l:ru", "l:uz", "c:menu"} <= set(data))

    def test_choosing_a_language_stores_one_channelless_row_and_switches_everything(self):
        bot, tg, sync, store = build()
        bot.limiter.max_calls = 1000            # this test runs many commands in one minute
        bot.handle_update(update_message("/language ru"))
        self.assertEqual([(r["kind"], r["title"]) for r in store.rows], [("operator.language", "ru")])
        self.assertNotIn("channel_id", store.rows[0])
        self.assertIn("Язык выбран: <b>Русский</b>", tg.texts()[-1])
        for command, marker in (("/health", "Здоровье"), ("/queue", "Очередь"), ("/errors", "Ошибки"),
                                ("/balance", "Балансы"), ("/spend", "Расходы"), ("/today", "Сегодня"),
                                ("/users", "Новые аккаунты"), ("/deploys", "Деплои"),
                                ("/approvals", "Ждёт решения"), ("/security", "безопасности"),
                                ("/digest", "Дневная сводка"), ("/alerts", "Оповещения"),
                                ("/menu", "Оператор Nightshift"), ("/help", "команды")):
            bot.handle_update(update_message(command))
            self.assertIn(marker, tg.texts()[-1], command)
        self.assertEqual(len(store.rows), 1)                   # reading never writes

    def test_the_button_switches_to_uzbek_and_answers_in_it(self):
        bot, tg, sync, store = build()
        bot.handle_update(update_callback("l:uz"))
        self.assertEqual(tg.answers()[-1]["text"], "Til saqlandi")
        self.assertIn("Til tanlandi: <b>Oʻzbekcha</b>", tg.texts()[-1])
        bot.handle_update(update_callback("c:health"))
        self.assertIn("Salomatlik", tg.texts()[-1])

    def test_every_reply_after_a_switch_is_in_that_language(self):
        for lang, marker in (("ru", "Заглушено"), ("uz", "jim qilindi")):
            bot, tg, sync, store = build()
            bot.limiter.max_calls = 1000
            bot.handle_update(update_message(f"/language {lang}"))
            bot.handle_update(update_message("/mute run"))
            self.assertIn(marker if lang == "uz" else "заглушены", tg.texts()[-1])
            bot.handle_update(update_message("/mute"))
            self.assertIn("/mute", tg.texts()[-1])
            self.assertNotIn("Usage", tg.texts()[-1])
            bot.handle_update(update_message("/frobnicate"))
            self.assertNotIn("Unknown command", tg.texts()[-1])
            bot.handle_update(update_message("hello"))
            self.assertNotIn("Not a command", tg.texts()[-1])
            bot.handle_update(update_callback("zzz"))
            self.assertNotEqual(tg.answers()[-1]["text"], "Unknown button")
            bot.handle_update(update_message("/status"))
            bot.handle_update(update_message("/channels"))
            self.assertIn("default", tg.texts()[-1])
            self.assertNotIn("Channels:", tg.texts()[-1])
            bot.handle_update(update_message("/pending"))
            self.assertNotIn("Held for review:", tg.texts()[-1])

    def test_legacy_status_uses_the_language_when_the_source_can(self):
        class Localized(Deps):
            localized = True

            def status_summary(self, lang="en"):
                return tp(lang, "status.summary", n=3)
        bot, tg, *_ = build()
        bot.deps = Localized()
        bot.handle_update(update_message("/language uz"))
        bot.handle_update(update_message("/status"))
        self.assertEqual(tg.texts()[-1], "Nightshift: kutubxonada 3 ta video.")

    def test_the_unknown_language_is_refused_not_silently_english(self):
        bot, tg, sync, store = build()
        for arg in ("xx", "klingon", "en;drop", "123"):
            bot.handle_update(update_message(f"/language {arg}"))
            self.assertIn("Unknown language", tg.texts()[-1])
        self.assertEqual(store.rows, [])
        bot.handle_update(update_callback("l:xx"))
        self.assertEqual(tg.answers()[-1]["text"], "Unknown button")
        self.assertEqual(store.rows, [])

    def test_the_choice_persists_to_a_new_process_and_beats_the_env_default(self):
        bot, tg, sync, store = build(lang_env="en")
        bot.handle_update(update_message("/language uz"))
        again = router.OperatorBot(make_control(tg), Deps(), bot.ops, store, OperatorConfig(language="ru"),
                                   clock=lambda: NOW.timestamp())
        again.handle_update(update_message("/health"))
        self.assertIn("Salomatlik", tg.texts()[-1])

    def test_a_failed_save_says_so_and_changes_nothing(self):
        bot, tg, sync, store = build()
        store.fail_write = True
        bot.handle_update(update_message("/language ru"))
        self.assertIn("Could not save the language", tg.texts()[-1])
        bot.handle_update(update_message("/health"))
        self.assertIn("Health", tg.texts()[-1])
        bot, tg, *_ = build()
        bot.store = None
        bot.handle_update(update_callback("l:ru"))
        self.assertIn("Could not save the language", tg.texts()[-1])


class AuthorizationUnchangedTestCase(unittest.TestCase):
    """Authorization happens before any work; the language changes none of it."""

    def test_a_stranger_cannot_change_the_language_and_causes_no_read_or_write(self):
        for update in (update_message("/language ru", chat=999), update_message("/language ru", chat=100, user=999),
                       update_callback("l:ru", chat=555, user=100), update_callback("l:ru", user=999),
                       {"update_id": 1, "edited_message": update_message("/language ru")["message"]},
                       {"update_id": 2, "channel_post": {"text": "/language ru", "chat": {"id": 100, "type": "channel"}}},
                       update_message("/language@OtherBot ru")):
            bot, tg, sync, store = build()
            calls = []
            with patch.object(store, "load_language", side_effect=lambda: calls.append("read") or None):
                bot.handle_update(update)
            self.assertEqual(store.rows, [], update)
            self.assertEqual(sync.reads, [], update)
            self.assertEqual(calls, [], "the language row was read for a refused sender")
            for text in tg.texts():
                self.assertEqual(text, router.NOT_AUTHORIZED)

    def test_a_forwarded_command_from_the_admin_is_refused_in_the_owners_language(self):
        bot, tg, sync, store = build()
        store.record_language("ru")
        bot.handle_update(update_message("/language uz", forward_origin={"type": "user"}))
        self.assertEqual(tg.texts(), [t("ru", "err.forwarded")])
        self.assertEqual(len(store.rows), 1)                 # only the earlier choice; nothing written

    def test_a_stranger_is_answered_in_the_configured_default_never_a_stored_choice(self):
        bot, tg, sync, store = build(lang_env="uz")
        store.record_language("ru")
        bot.handle_update(update_message("/health", chat=999))
        self.assertEqual(tg.texts(), [t("uz", "err.not_authorized")])
        bot.handle_update(update_callback("c:health", chat=555, user=100))
        self.assertEqual(tg.answers()[-1]["text"], t("uz", "err.not_authorized_toast"))

    def test_the_intent_path_is_identical_in_every_language(self):
        for lang in LANGUAGES:
            bot, tg, sync, store = build()
            store.record_language(lang)
            with patch("modules.event_log.emit") as emit:
                bot.handle_update(update_message("/pause finance"))
                bot.handle_update(update_message("/publish v1"))
            self.assertEqual([c.kwargs["metadata"] for c in emit.call_args_list],
                             [{"action": "pause", "target": "finance"}, {"action": "publish", "target": "v1"}])
            self.assertEqual(emit.call_count, 2)

    def test_action_refusals_are_localized_and_still_refuse(self):
        for lang in LANGUAGES:
            control = TelegramControl(token="t", chat_id="42", admin_user_ids="")
            result = route_command("/publish v1", "999", control, Deps(), user_id=999, lang=lang)
            self.assertFalse(result.authorized)
            self.assertIsNone(result.intent)
            self.assertEqual(result.reply, tp(lang, "err.not_authorized"))
            ok = route_command("/publish v1", "42", control, Deps(), user_id=42, lang=lang)
            self.assertEqual(ok.intent, {"action": "publish", "target": "v1"})
            self.assertIn(tp(lang, "legacy.gate_note").strip()[:8], ok.reply)

    def test_no_new_write_beyond_the_language_row(self):
        bot, tg, sync, store = build()
        for command in ("/language", "/language ru", "/language uz", "/health", "/menu"):
            bot.handle_update(update_message(command))
        bot.handle_update(update_callback("l:en"))
        self.assertEqual({r["kind"] for r in store.rows}, {"operator.language"})
        self.assertEqual(sync.upserts, [])


class ForgedLanguageRowsTestCase(unittest.TestCase):
    """alert_events_insert lets anyone who can view a channel insert rows with
    that channel_id and any kind, title and body. A forged language row is inert."""

    def forged(self, **extra):
        return {"at": ts(1), "kind": "operator.language", "title": "uz", "body": "", "delivered": False, **extra}

    def test_a_tenants_row_with_any_channel_id_is_ignored(self):
        sync = FakeSync({"alert_events": [self.forged(channel_id="their-channel")]})
        self.assertIsNone(SupabaseAlertStore(sync).load_language())
        self.assertEqual(sync.reads[0][1]["channel_id"], "is.null")        # the database is asked for NULL only
        self.assertIsNone(pick_language([self.forged(channel_id="their-channel")]))     # and the reader checks again

    def test_a_forged_newer_row_does_not_override_the_owners_choice(self):
        rows = [
            {"at": ts(500), "kind": "operator.language", "title": "ru", "channel_id": None},
            self.forged(channel_id="their-channel", at=ts(1)),
        ]
        sync = FakeSync({"alert_events": rows})
        self.assertEqual(SupabaseAlertStore(sync).load_language(), "ru")
        self.assertEqual(pick_language(rows), "ru")

    def test_an_unknown_or_malformed_code_is_ignored_even_without_a_channel(self):
        for title in ("xx", "", "ru;drop", "<b>", "RU", "e" * 500):
            self.assertIsNone(pick_language([self.forged(title=title, channel_id=None)]), title)
        self.assertIsNone(pick_language([{"at": "not a time", "kind": "operator.language", "title": "ru"}]))

    def test_end_to_end_a_forged_row_leaves_the_bot_in_the_default_language(self):
        sync = FakeSync({**healthy_tables(), "alert_events": [self.forged(channel_id="their-channel", title="ru"),
                                                                self.forged(channel_id="other", title="uz")]})
        tg = FakeTelegram()
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo")
        from modules.operator_bot.sources import OperatorSources
        ops = OperatorSources(sync, FakeHttp({**site_ok(), **github_ok()}), cfg, now=lambda: NOW)
        bot = router.OperatorBot(make_control(tg), Deps(), ops, SupabaseAlertStore(sync), cfg,
                                 clock=lambda: NOW.timestamp())
        bot.handle_update(update_message("/health"))
        self.assertIn("Health", tg.texts()[-1])
        self.assertNotIn("Здоровье", tg.texts()[-1])
        # and the alert engine, which asks the same store
        eng = alerts.AlertEngine(ops, SupabaseAlertStore(sync), make_control(tg), cfg, low_credits=15000)
        self.assertEqual(eng._language(), "en")

    def test_junk_null_channel_rows_cannot_crowd_out_the_real_choice(self):
        junk = [{"at": ts(i), "kind": "operator.language", "title": f"junk-{i}", "channel_id": None}
                for i in range(1, 200)]
        real = {"at": ts(60 * 24 * 30), "kind": "operator.language", "title": "uz", "channel_id": None}
        sync = FakeSync({"alert_events": junk + [real]})
        self.assertEqual(SupabaseAlertStore(sync, lambda: NOW).load_language(), "uz")
        params = sync.reads[0][1]
        self.assertEqual(params["title"], "in.(" + ",".join(LANGUAGES) + ")")      # filtered at the database
        self.assertGreater(int(params["limit"]), 5)

    def test_a_future_dated_row_cannot_pin_the_language(self):
        rows = [{"at": ts(500), "kind": "operator.language", "title": "ru", "channel_id": None},
                {"at": ts(-60 * 24 * 365), "kind": "operator.language", "title": "uz", "channel_id": None},
                {"at": "9999-12-31T23:59:59Z", "kind": "operator.language", "title": "uz", "channel_id": None}]
        self.assertEqual(pick_language(rows, NOW), "ru")
        sync = FakeSync({"alert_events": rows})
        self.assertEqual(SupabaseAlertStore(sync, lambda: NOW).load_language(), "ru")
        # the owner's next choice (stamped now) is newer than anything the clamp let through
        rows.append({"at": ts(0), "kind": "operator.language", "title": "en", "channel_id": None})
        self.assertEqual(pick_language(rows, NOW), "en")
        # a little clock skew is tolerated
        self.assertEqual(pick_language([{"at": ts(-2), "kind": "operator.language", "title": "uz"}], NOW), "uz")
        self.assertIsNone(pick_language([{"at": ts(-10), "kind": "operator.language", "title": "uz"}], NOW))

    def test_the_docs_say_what_the_guarantee_covers(self):
        docs = (ROOT / "docs" / "operator-bot.md").read_text(encoding="utf-8")
        self.assertIn("channel-bound", docs)
        self.assertIn("cosmetic", docs)

    def test_the_owners_row_is_read_at_any_age(self):
        old = {"at": ts(60 * 24 * 90), "kind": "operator.language", "title": "uz", "channel_id": None}
        self.assertEqual(SupabaseAlertStore(FakeSync({"alert_events": [old]})).load_language(), "uz")

    def test_the_row_is_written_without_a_channel_and_only_for_known_codes(self):
        sync = FakeSync({"alert_events": []})
        store = SupabaseAlertStore(sync)
        self.assertTrue(store.record_language("ru"))
        self.assertFalse(store.record_language("xx"))
        self.assertFalse(store.record_language("ru; drop table"))
        self.assertEqual(len(sync.upserts), 1)
        row = sync.upserts[0][1][0]
        self.assertEqual((row["kind"], row["title"]), ("operator.language", "ru"))
        self.assertNotIn("channel_id", row)

    def test_an_unreadable_store_means_the_default_language_not_a_crash(self):
        self.assertIsNone(SupabaseAlertStore(FakeSync({}, fail={"alert_events"})).load_language())
        off = FakeSync({})
        off.enabled = False
        self.assertIsNone(SupabaseAlertStore(off).load_language())

    def test_the_state_replay_ignores_language_rows(self):
        from modules.operator_bot.store import replay
        state = replay([self.forged(channel_id=None)], NOW)
        self.assertEqual((state.alerts, state.mutes), ([], {}))


class SanitisingTestCase(unittest.TestCase):
    """A translation is not exempt from any scrub: everything goes out through
    TelegramControl.send (log_redaction, e-mail and key shapes, splitting)."""

    def test_secret_shapes_and_emails_in_dynamic_text_are_scrubbed_in_every_language(self):
        secret = "sk-abcdefghijklmnopqrstuvwxyz"
        for lang in LANGUAGES:
            tg = FakeTelegram()
            control = make_control(tg)
            # A failed worker's own detail line is the one free-text value a view prints.
            worker = {"worker_id": "nightshift-01", "kind": "pipeline", "state": "failed", "updated_at": ts(2),
                      "detail": f"set X {secret} mail a@b.co via https://api.telegram.org/bot123456:ABCdef_ghi/x"}
            ops, _ = make_ops({**healthy_tables(), "worker_status": [worker]}, FakeHttp({**site_ok(), **github_ok()}))
            for reply in (views.view_health(ops, lang), views.view_digest(ops, None, lang)):
                control.send(100, reply.text, parse_mode=reply.parse_mode, reply_markup=reply.markup())
            sent = " ".join(tg.texts())
            self.assertIn("nightshift-01", sent)
            for leak in (secret, "a@b.co", "ABCdef_ghi"):
                self.assertNotIn(leak, sent, (lang, leak))

    def test_cyrillic_and_uzbek_text_survive_the_scrub_and_the_splitter(self):
        from modules import tg_text
        for lang in ("ru", "uz"):
            text = "\n".join(t(lang, "health.workers_none") for _ in range(300))
            parts = tg_text.split_message(tg_text.sanitize_outgoing(text))
            self.assertGreater(len(parts), 1)
            self.assertTrue(all(len(p) <= 4096 for p in parts))
            self.assertEqual("\n".join(parts), text)

    def test_long_ids_are_not_hidden_by_the_key_scrub(self):
        from modules import tg_text
        text = t("ru", "alert.worker_lost", id="nightshift-creative-worker-eu-central-01-pipeline-primary", kind="x", age="3m")
        self.assertEqual(tg_text.sanitize_outgoing(text), text)


if __name__ == "__main__":
    unittest.main()
