"""The marketing worker (tools/marketing_worker.py, modules/marketing_content.py): drafting, sending, settling.

No database and no Telegram: an in-memory store stands in for the 0108 functions (whose parameter names are
pinned against the migration file below), and the sender talks to tools/fake_telegram.py on 127.0.0.1.

The rules pinned here, each a way the poster could do harm in public:
  * switched off (anything but NIGHTSHIFT_MARKETING_POSTS=on) it touches nothing;
  * a price post is built from the plans the database holds, has no currency amount, and is not produced at all
    when a fact cannot be read;
  * one post per loop, settled with the right code for each way sending can fail, and a lost lease is never
    sent again;
  * the bot token appears in no log line, report, result or exception, on any failure path.
"""

import contextlib
import datetime as dt
import io
import json
import logging
import re
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import requests

from modules import channel_post as cp
from modules import log_redaction
from modules import marketing_content as mc
from modules import notify_telegram as nt
from tests.test_channel_post import ORIGIN, Server, closed_port_base, session
from tools import marketing_worker as mw

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "supabase" / "migrations" / "0108_marketing_posts.sql").read_text(encoding="utf-8")
NEWS = ROOT / "docs" / "news"

SUPABASE = "https://proj.supabase.example.test"
SERVICE_KEY = "service-key-should-never-be-printed-9f8e7d"
SECRET_PART = "AAF_zq-NotARealToken_9fX2kLmQ_abcdefghij"
TOKEN = "7390481:" + SECRET_PART
NOW = dt.datetime(2026, 10, 18, 9, 30, tzinfo=dt.timezone.utc)
POST_ID = "0f0e0d0c-0b0a-4000-8000-000000000001"

TEXTS = {"uz": "Video muharririda endi shakllar va stikerlar qoʻshish mumkin.",
         "ru": "В видеоредакторе теперь можно добавлять фигуры и стикеры.",
         "en": "The video editor now lets you add shapes and stickers."}
PLANS = [
    {"id": "creator", "name": "Plus", "monthly_credits": 2000, "concurrency": 2},
    {"id": "pro", "name": "Pro", "monthly_credits": 6000.0, "concurrency": 4},
    {"id": "studio", "name": "Business", "monthly_credits": 18000, "concurrency": 8},
]


def env(**over):
    base = {"SUPABASE_URL": SUPABASE, "SUPABASE_SERVICE_KEY": SERVICE_KEY, "TELEGRAM_CHANNEL_BOT_TOKEN": TOKEN,
            "MARKETING_TELEGRAM_CHAT": "@nightshift_test", "NOTIFY_APP_ORIGIN": ORIGIN, "NIGHTSHIFT_MARKETING_POSTS": "on"}
    base.update(over)
    return {k: v for k, v in base.items() if v is not None}


def post_row(chat_text=None, **over):
    row = {"post_id": POST_ID, "kind": "news", "target": "telegram", "texts": dict(TEXTS), "media_path": None,
           "link": "/pricing", "attempts": 1, "content_hash": "0" * 64, "claimed_until": "2026-10-18T09:32:00+00:00"}
    row.update(over)
    return row


class FakeStore:
    """The 0108 worker functions, as far as the worker can tell: idempotent drafts that keep a person's edit,
    one approved post per claim, a settle that fails when the lease is lost."""

    def __init__(self, plans=None, approved=()):
        self.plans = plans
        self.approved = list(approved)
        self.drafts = {}
        self.edited = set()
        self.claims = 0
        self.completions = []
        self.lease_lost = False
        self.complete_raises = None
        self.complete_fail_first = 0
        self.complete_tries = 0
        self.claim_many = False

    def price_plans(self):
        return self.plans

    def draft(self, d):
        cur = self.drafts.get(d.key)
        if cur is None:
            self.drafts[d.key] = d
            return {"ok": True, "created": True, "updated": False}
        if d.key in self.edited or cur.texts == d.texts:
            return {"ok": True, "created": False, "updated": False}
        self.drafts[d.key] = d
        return {"ok": True, "created": False, "updated": True}

    def claim(self, worker_id):
        self.claims += 1
        if not self.approved:
            return []
        if self.claim_many:
            return list(self.approved)
        return [self.approved.pop(0)]

    def complete(self, post_id, worker_id, c):
        self.complete_tries += 1
        if self.complete_raises:
            raise self.complete_raises
        if self.complete_tries <= self.complete_fail_first:
            raise mw.StoreUnavailable("complete_marketing_post: HTTP 503")
        self.completions.append((post_id, c))
        if self.lease_lost:
            return False
        if c.outcome == "retry" and c.error_code in ("rate_limited", "not_configured", "network"):
            self.approved.insert(0, post_row())          # back to approved, as the database does
        return True


class Reporter:
    def __init__(self, on_report=None):
        self.reports = []
        self._on = on_report

    def report(self, state, detail=None):
        self.reports.append((state, detail))
        if self._on:
            self._on()
        return True


def worker_for(store, base, chat="@nightshift_test", timeout=5.0, media_base=SUPABASE):
    client = nt.TelegramClient(TOKEN, base, session(), timeout=timeout)
    return mw.MarketingWorker(store, cp.ChannelSender(client, chat, ORIGIN, media_base), "marketing-test",
                              news_dir=NEWS, now=lambda: NOW, sleep=lambda s: None)


class Capture(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.lines = []

    def emit(self, record):
        self.lines.append(self.format(record))
        if record.exc_info:
            self.lines.append(logging.Formatter().formatException(record.exc_info))


@contextlib.contextmanager
def captured():
    """Everything logged or printed inside, with the redaction net OFF: a leak must not be hidden by it."""
    handler = Capture()
    root = logging.getLogger()
    root.addHandler(handler)
    old_level = root.level
    root.setLevel(logging.DEBUG)
    out, err = io.StringIO(), io.StringIO()
    box = {}
    try:
        with mock.patch.object(log_redaction, "install"), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            yield box
    finally:
        root.removeHandler(handler)
        root.setLevel(old_level)
        box["text"] = "\n".join(handler.lines) + out.getvalue() + err.getvalue()


# ── off by default ──────────────────────────────────────────────────────────

class SwitchedOff(unittest.TestCase):
    def run_main(self, e, *argv):
        reporter = Reporter()
        boom = mock.Mock(side_effect=AssertionError("a switched-off worker must not touch this"))
        with captured() as box:
            rc = mw.main(["--once", *argv], env=e, store_factory=boom, session_factory=boom,
                         reporter_factory=lambda w: reporter, install_signals=False)
        return rc, reporter, box["text"], boom

    def test_anything_but_on_does_nothing_at_all(self):
        for value in (None, "", "off", "true", "1", "ON", "yes", "onn", "on!"):
            with self.subTest(value=value):
                rc, reporter, text, boom = self.run_main(env(NIGHTSHIFT_MARKETING_POSTS=value))
                self.assertEqual(rc, 0)
                boom.assert_not_called()                                  # no store, no HTTP session, no claim
                self.assertEqual(len(reporter.reports), 1)
                state, detail = reporter.reports[0]
                self.assertEqual(state, "running")
                self.assertIn("off", detail)
                self.assertNotIn(TOKEN, text + detail)

    def test_off_reports_to_worker_status_as_kind_other(self):
        built = {}

        class Spy:
            def __init__(self, url, key, **kw):
                built.update(kw, url=url)

            def report(self, state, detail=None):
                built["state"] = state
                return True

        with captured(), mock.patch("modules.worker_status.WorkerStatusReporter", Spy):
            mw.main(["--once"], env=env(NIGHTSHIFT_MARKETING_POSTS=""), install_signals=False)
        self.assertEqual(built["kind"], "other")
        self.assertTrue(built["worker_id"].startswith("marketing"))
        self.assertEqual(built["state"], "running")

    def test_the_switch_is_exactly_on(self):
        self.assertTrue(mw.posts_switch_on({"NIGHTSHIFT_MARKETING_POSTS": "on"}))
        self.assertTrue(mw.posts_switch_on({"NIGHTSHIFT_MARKETING_POSTS": " on "}))
        for v in ("", "off", "On", "true", "1", "yes"):
            self.assertFalse(mw.posts_switch_on({"NIGHTSHIFT_MARKETING_POSTS": v}), v)
        self.assertFalse(mw.posts_switch_on({}))

    def test_the_idle_loop_ends_when_told_to_and_never_exits_by_itself(self):
        stop = threading.Event()
        reporter = Reporter(on_report=stop.set)
        result = {}
        with captured():
            t = threading.Thread(target=lambda: result.update(rc=mw.main([], env=env(NIGHTSHIFT_MARKETING_POSTS="off"),
                                                                          reporter_factory=lambda w: reporter, stop=stop,
                                                                          install_signals=False)))
            t.start()
            t.join(5)
        self.assertFalse(t.is_alive())
        self.assertEqual(result["rc"], 0)
        self.assertEqual(reporter.reports[0][0], "running")
        self.assertEqual(reporter.reports[-1], ("stopped", None))

    def test_without_the_database_settings_it_refuses_to_start(self):
        with captured() as box:
            rc = mw.main(["--once"], env=env(SUPABASE_SERVICE_KEY=""), reporter_factory=lambda w: Reporter(), install_signals=False)
        self.assertEqual(rc, 2)
        self.assertIn("SUPABASE_SERVICE_KEY", box["text"])


class StartupLog(unittest.TestCase):
    def test_switched_on_it_says_which_origin_host_and_chat_kind_but_no_secret(self):
        for chat, kind in (("@nightshift_test", "a channel name"), ("-1001234567890", "a numeric id")):
            with self.subTest(chat=chat):
                with captured() as box:
                    mw.main(["--once"], env=env(NOTIFY_APP_ORIGIN="https://typo.example.test", MARKETING_TELEGRAM_CHAT=chat),
                            store_factory=lambda: FakeStore(), session_factory=lambda: session(),
                            reporter_factory=lambda w: Reporter(), install_signals=False)
                text = box["text"]
                self.assertIn("origin host typo.example.test", text)
                self.assertIn(kind, text)
                for secret in (TOKEN, SECRET_PART, SERVICE_KEY, SUPABASE, "proj.supabase", chat, "https://typo"):
                    self.assertNotIn(secret, text)


class ChatNames(unittest.TestCase):
    def test_telegram_usernames_are_5_to_32_characters(self):
        for good in ("@abcde", "@Test_chan1", "@" + "a" * 32, "-1001234567890", "12345"):
            self.assertEqual(mw.missing_settings(env(MARKETING_TELEGRAM_CHAT=good)), [], good)
        for bad in ("@abcd", "@" + "a" * 33, "@1abcde", "@ab cde", "abcde", "-100abc", "1234"):
            self.assertEqual(len(mw.missing_settings(env(MARKETING_TELEGRAM_CHAT=bad))), 1, bad)


class SwitchedOnButNotConfigured(unittest.TestCase):
    def test_it_names_what_is_missing_claims_nothing_and_says_failed(self):
        cases = {"TELEGRAM_CHANNEL_BOT_TOKEN": {"TELEGRAM_CHANNEL_BOT_TOKEN": ""},
                 "MARKETING_TELEGRAM_CHAT": {"MARKETING_TELEGRAM_CHAT": "not a chat"},
                 "NOTIFY_APP_ORIGIN": {"NOTIFY_APP_ORIGIN": "http://not-https.example"}}
        for name, over in cases.items():
            with self.subTest(name):
                store = FakeStore(approved=[post_row()])
                reporter = Reporter()
                with captured() as box:
                    rc = mw.main(["--once"], env=env(**over), store_factory=lambda: store, session_factory=lambda: session(),
                                 reporter_factory=lambda w: reporter, install_signals=False)
                self.assertEqual(rc, 0)
                self.assertEqual((store.claims, store.completions, store.drafts), (0, [], {}))
                self.assertEqual(reporter.reports[0][0], "failed")
                self.assertIn(name, reporter.reports[0][1])
                self.assertIn(name, box["text"])
                self.assertNotIn(TOKEN, box["text"])


# ── drafting ────────────────────────────────────────────────────────────────

class NewsDrafting(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, True)
        shutil.copy(NEWS / "banned-claims.json", self.dir / "banned-claims.json")

    def item(self, **over):
        item = {"pr": 484, "shipped": "2026-10-15", "kind": "feature", "public": True, "text": dict(TEXTS), "link": "/editor"}
        item.update(over)
        return item

    def put(self, name, item):
        (self.dir / name).write_text(item if isinstance(item, str) else json.dumps(item, ensure_ascii=False), encoding="utf-8")

    def load(self):
        return mc.load_news(self.dir, dt.date(2026, 10, 18))

    def test_a_public_item_becomes_a_draft_with_its_key_source_link_and_words(self):
        self.put("2026-10-15-editor-shapes.json", self.item())
        drafts, skipped = self.load()
        self.assertEqual(skipped, {})
        (d,) = drafts
        self.assertEqual((d.key, d.kind, d.source_ref, d.link), ("news:editor-shapes", "news", "pr:#484", "/editor"))
        self.assertEqual(d.texts, TEXTS)
        self.assertIsNone(d.facts_as_of)

    def test_only_public_true_counts(self):
        self.put("2026-10-15-a.json", self.item(public=False))
        self.put("2026-10-15-b.json", self.item(public="true"))
        self.put("2026-10-15-c.json", self.item(public=1))
        no_key = self.item()
        del no_key["public"]
        self.put("2026-10-15-d.json", no_key)
        drafts, skipped = self.load()
        self.assertEqual((drafts, skipped), ([], {"not_public": 4}))

    def test_a_file_that_would_not_pass_review_is_skipped_by_reason_without_stopping_the_others(self):
        self.put("2026-10-15-good.json", self.item())
        self.put("2026-10-15-free.json", self.item(text=dict(TEXTS, en="Try the video editor, it is free for everyone today.")))
        self.put("2026-10-15-provider.json", self.item(text=dict(TEXTS, en="The video editor now works together with OpenAI models.")))
        self.put("2026-10-15-short.json", self.item(text=dict(TEXTS, uz="Qisqa.")))
        self.put("2026-10-15-lang.json", self.item(text={"ru": TEXTS["ru"], "en": TEXTS["en"]}))
        self.put("2026-10-16-date.json", self.item())                      # shipped differs from the name
        self.put("2999-01-01-future.json", self.item(shipped="2999-01-01"))
        self.put("2026-10-15-link.json", self.item(link="https://evil.example/x"))
        self.put("2026-10-15-pr.json", self.item(pr=True))
        self.put("2026-10-15-kind.json", self.item(kind="security"))
        self.put("2026-10-15-broken.json", "{not json")
        self.put("README.json", "{}")                                        # not a news file name: ignored
        drafts, skipped = self.load()
        self.assertEqual([d.key for d in drafts], ["news:good"])
        self.assertEqual(skipped, {"banned_claim": 2, "bad_text": 2, "bad_shipped": 2, "bad_link": 1, "bad_pr": 1,
                                   "bad_kind": 1, "unreadable": 1})

    def test_an_item_shipped_more_than_30_days_ago_is_not_drafted(self):
        self.assertEqual(mc.NEWS_MAX_AGE_DAYS, 30)
        self.put("2026-09-18-edge.json", self.item(shipped="2026-09-18"))       # exactly 30 days before 2026-10-18
        self.put("2026-09-17-old.json", self.item(shipped="2026-09-17"))        # 31 days
        self.put("2026-01-02-ancient.json", self.item(shipped="2026-01-02"))
        drafts, skipped = self.load()
        self.assertEqual([d.key for d in drafts], ["news:edge"])
        self.assertEqual(skipped, {"too_old": 2})

    def test_without_the_banned_list_nothing_is_drafted(self):
        self.put("2026-10-15-good.json", self.item())
        (self.dir / "banned-claims.json").unlink()
        drafts, skipped = self.load()
        self.assertEqual((drafts, skipped), ([], {"banned_list_unreadable": 1}))

    def test_the_repository_news_folder_loads_and_announces_nothing_yet(self):
        drafts, skipped = mc.load_news(NEWS)
        for d in drafts:                                    # whenever a public item is added it must pass the same gate
            self.assertEqual(set(d.texts), {"uz", "ru", "en"})
            self.assertEqual(mc.banned_hits("\n".join(d.texts.values())), [])
        self.assertGreaterEqual(sum(skipped.values()) + len(drafts), 1)


class Drafting(unittest.TestCase):
    def worker(self, store, news_dir):
        return mw.MarketingWorker(store, mock.Mock(), "marketing-test", news_dir=news_dir, now=lambda: NOW, origin=ORIGIN)

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, True)
        shutil.copy(NEWS / "banned-claims.json", self.dir / "banned-claims.json")
        (self.dir / "2026-10-15-editor-shapes.json").write_text(json.dumps(
            {"pr": 484, "shipped": "2026-10-15", "kind": "feature", "public": True, "text": TEXTS}, ensure_ascii=False))

    def test_drafting_is_idempotent(self):
        store = FakeStore(plans=PLANS)
        w = self.worker(store, self.dir)
        self.assertEqual(w.draft_pass(), {"created": 2})
        self.assertEqual(w.draft_pass(), {"unchanged": 2})
        self.assertEqual(sorted(store.drafts), ["news:editor-shapes", "price:creator,pro,studio:2026-10"])

    def test_a_persons_edit_is_not_overwritten_and_the_worker_never_asks_to(self):
        store = FakeStore(plans=PLANS)
        w = self.worker(store, self.dir)
        w.draft_pass()
        store.edited.add("news:editor-shapes")
        (self.dir / "2026-10-15-editor-shapes.json").write_text(json.dumps(
            {"pr": 484, "shipped": "2026-10-15", "kind": "feature", "public": True,
             "text": dict(TEXTS, en="The video editor now lets you add shapes, stickers and a progress bar.")}, ensure_ascii=False))
        counts = w.draft_pass()
        self.assertEqual(counts, {"unchanged": 2})
        self.assertEqual(store.drafts["news:editor-shapes"].texts["en"], TEXTS["en"])

    def test_the_month_changes_the_price_key_so_one_per_month(self):
        store = FakeStore(plans=PLANS)
        w = self.worker(store, self.dir)
        w.draft_pass()
        w._now = lambda: dt.datetime(2026, 11, 2, tzinfo=dt.timezone.utc)
        self.assertEqual(w.draft_pass()["created"], 1)
        self.assertIn("price:creator,pro,studio:2026-11", store.drafts)

    def test_if_the_plans_cannot_be_read_no_price_post_is_made(self):
        store = FakeStore(plans=None)
        counts = self.worker(store, self.dir).draft_pass()
        self.assertEqual(counts, {"created": 1})
        self.assertEqual([k for k in store.drafts if k.startswith("price:")], [])

    def test_the_drafting_pass_only_drafts_it_cannot_approve_or_send(self):
        store = FakeStore(plans=PLANS)
        sender = mock.Mock()
        mw.MarketingWorker(store, sender, "marketing-test", news_dir=self.dir, now=lambda: NOW, origin=ORIGIN).draft_pass()
        sender.send.assert_not_called()
        self.assertEqual((store.claims, store.completions), (0, []))


class DraftsTheSenderWouldRefuse(unittest.TestCase):
    """A draft the sender would refuse must never reach the owner's screen: approved there, it would fail at send time
    and use up its key and a slot. The drafting pass runs the sender's own render over each draft first."""

    GOOD = mc.Draft(key="news:good", kind="news", texts=dict(TEXTS), source_ref="pr:#1", link="/editor")

    def draft(self, key, texts=None, link="/editor"):
        return mc.Draft(key=f"news:{key}", kind="news", texts=texts if texts is not None else dict(TEXTS),
                        source_ref="pr:#2", link=link)

    def run_pass(self, drafts, origin=ORIGIN):
        store = FakeStore(plans=None)
        w = mw.MarketingWorker(store, mock.Mock(), "marketing-test", news_dir=NEWS, now=lambda: NOW, origin=origin)
        with mock.patch.object(mc, "load_news", return_value=(list(drafts), {})), self.assertLogs(mw.logger, "WARNING") as logs:
            mw.logger.warning("marker")  # assertLogs needs one record even when nothing is refused
            counts = w.draft_pass()
        return store, counts, "\n".join(logs.output)

    def test_every_refusal_code_of_the_sender_keeps_the_draft_out_and_is_counted(self):
        long = {l: "x" * 1400 for l in ("uz", "ru", "en")}
        email = dict(TEXTS, en="Write to someone@example.com for the shapes.")
        cases = {
            "too_long": self.draft("long", long),
            "unsafe_text": self.draft("email", email),
            "bad_link": self.draft("link", link="/Bad Link"),
            "bad_texts": self.draft("texts", {"uz": TEXTS["uz"], "ru": TEXTS["ru"]}),
        }
        for code, bad in cases.items():
            with self.subTest(code):
                store, counts, _ = self.run_pass([bad, self.GOOD])
                self.assertEqual(counts, {"not_drafted_" + code: 1, "created": 1})
                self.assertEqual(sorted(store.drafts), ["news:good"])

    def test_without_a_site_origin_a_post_with_a_link_is_not_drafted_either(self):
        store, counts, _ = self.run_pass([self.GOOD, self.draft("nolink", link=None)], origin=None)
        self.assertEqual(counts, {"not_drafted_no_origin": 1, "created": 1})
        self.assertEqual(sorted(store.drafts), ["news:nolink"])

    def test_the_log_carries_the_count_and_the_codes_never_the_words(self):
        email = dict(TEXTS, en="Write to someone@example.com for the shapes.")
        _, _, log = self.run_pass([self.draft("email", email), self.GOOD])
        self.assertIn("1 draft(s) the sender would refuse were not stored (unsafe_text=1)", log)
        self.assertNotIn("someone@example.com", log)
        self.assertNotIn(TEXTS["en"], log)

    def test_the_decision_is_the_senders_own_render(self):
        for texts, link, origin, media in ((TEXTS, "/editor", ORIGIN, False), ({l: "x" * 400 for l in TEXTS}, None, ORIGIN, True),
                                           ({l: "x" * 340 for l in TEXTS}, None, ORIGIN, True)):
            try:
                cp.render(texts, link, origin, media)
                expected = None
            except cp.Refused as e:
                expected = e.code
            self.assertEqual(cp.preflight(texts, link, origin, media), expected)


class PricePost(unittest.TestCase):
    CURRENCY = re.compile(r"[$€£₽¥₩]|\b(usd|eur|rub|uzs|dollars?|euros?)\b|доллар|евро|руб|сум\b|so['ʻ’]?m\b|\d\s?(k|тыс)\b", re.I)

    def draft(self, plans=PLANS):
        return mc.price_draft(plans, NOW, NEWS)

    def test_it_names_each_plan_its_credits_and_concurrency_in_three_languages(self):
        d = self.draft()
        self.assertEqual((d.kind, d.link, d.key, d.source_ref), ("price", "/pricing", "price:creator,pro,studio:2026-10", "plan:creator,pro,studio"))
        self.assertEqual(d.facts_as_of, "2026-10-18T09:30:00+00:00")
        for lang, text in d.texts.items():
            for p in PLANS:
                self.assertIn(p["name"], text, lang)
            for number in ("2000", "6000", "18000", "2", "4", "8"):
                self.assertRegex(text, rf"(?<!\d){number}(?!\d)", lang)
        self.assertEqual(d.facts["plans"][1], {"id": "pro", "name": "Pro", "monthly_credits": 6000, "concurrency": 4})

    def test_there_is_no_currency_amount_anywhere_in_it(self):
        d = self.draft()
        blob = "\n".join(d.texts.values()) + json.dumps(d.facts)
        self.assertIsNone(self.CURRENCY.search(blob), self.CURRENCY.search(blob))
        for lang, text in d.texts.items():
            self.assertNotRegex(text, r"\d+[.,]\d{2}\b", lang)          # nothing shaped like 9.99

    def test_the_same_numbers_appear_in_every_language(self):
        d = self.draft()
        numbers = {lang: re.findall(r"\d+(?:[.,]\d+)?", text) for lang, text in d.texts.items()}
        self.assertEqual(numbers["uz"], numbers["ru"])
        self.assertEqual(numbers["ru"], numbers["en"])

    def test_it_passes_the_banned_claims_list_and_the_databases_size_rules(self):
        d = self.draft()
        self.assertEqual(mc.banned_hits("\n".join(d.texts.values()), NEWS), [])
        sizes = [len(t) for t in d.texts.values()]
        self.assertLessEqual(max(sizes), 1000)
        self.assertLessEqual(sum(sizes) + 160, 1024, "small enough to be a media caption too")
        for t in d.texts.values():
            self.assertEqual(t, t.strip())
            self.assertNotRegex(t, r"[\x01-\x09\x0b-\x1f\x7f-\x9f​-‏ -‮⁠-⁤﻿]")

    def test_a_fact_that_is_missing_or_not_a_number_means_no_post(self):
        bad = [
            [],
            [dict(PLANS[0], monthly_credits=None)],
            [dict(PLANS[0], monthly_credits="2000")],
            [dict(PLANS[0], monthly_credits=0)],
            [dict(PLANS[0], monthly_credits=float("nan"))],
            [dict(PLANS[0], monthly_credits=True)],
            [dict(PLANS[0], concurrency=None)],
            [dict(PLANS[0], concurrency=2.5)],
            [dict(PLANS[0], concurrency=0)],
            [dict(PLANS[0], concurrency=True)],
            [dict(PLANS[0], name="")],
            [dict(PLANS[0], name="<b>Plus</b>")],
            [dict(PLANS[0], id="Bad Id")],
            [PLANS[0], dict(PLANS[1], concurrency=None)],
        ]
        for plans in bad:
            self.assertIsNone(self.draft(plans), plans)

    def test_a_plan_named_with_a_banned_word_yields_no_post(self):
        self.assertIsNone(self.draft([dict(PLANS[0], name="Free")]))
        self.assertIsNone(self.draft([dict(PLANS[0], name="Unlimited")]))

    def test_fractions_keep_their_digits_and_integers_lose_the_point(self):
        d = self.draft([dict(PLANS[0], monthly_credits=2500.5)])
        self.assertIn("credits per month: 2500.5;", d.texts["en"])
        d = self.draft([dict(PLANS[0], monthly_credits=2000.0)])
        self.assertIn("credits per month: 2000;", d.texts["en"])

    def test_a_long_plan_set_still_gets_a_valid_key(self):
        plans = [dict(PLANS[0], id=f"plan_number_{i:02d}_long_identifier", name=f"P{i}") for i in range(6)]
        d = self.draft(plans)
        self.assertRegex(d.key, r"^price:[A-Za-z0-9._:,-]{1,100}$")
        self.assertRegex(d.source_ref, r"^plan:[a-z0-9_.:,-]{1,100}$")


class PricePlansFromTheDatabase(unittest.TestCase):
    """MarketingStore.price_plans reads plans, entitlement_keys and plan_entitlements, and returns nothing on doubt."""

    PLAN_ROWS = [
        {"id": "free", "name": "Free", "sort_order": 0, "monthly_credits": 0, "is_default": True, "is_public": True},
        {"id": "creator", "name": "Plus", "sort_order": 10, "monthly_credits": 2000.0, "is_default": False, "is_public": True},
        {"id": "pro", "name": "Pro", "sort_order": 20, "monthly_credits": 6000, "is_default": False, "is_public": True},
        {"id": "hidden", "name": "Hidden", "sort_order": 25, "monthly_credits": 99, "is_default": False, "is_public": False},
    ]
    KEY = [{"key": "concurrency", "value_type": "int", "default_value": 1, "status": "enforced"}]
    ENTS = [{"plan_id": "creator", "key": "concurrency", "value": 2}, {"plan_id": "pro", "key": "concurrency", "value": 4}]

    class Http:
        def __init__(self, tables):
            self.tables, self.urls = tables, []

        def get(self, url, **kw):
            self.urls.append(url)
            for name, answer in self.tables.items():
                if f"/rest/v1/{name}?" in url:
                    if isinstance(answer, BaseException):
                        raise answer
                    status, body = answer if isinstance(answer, tuple) else (200, answer)
                    return mock.Mock(status_code=status, json=lambda body=body: body)
            raise AssertionError(url)

    def store(self, **tables):
        t = {"plans": self.PLAN_ROWS, "entitlement_keys": self.KEY, "plan_entitlements": self.ENTS}
        t.update(tables)
        http = self.Http(t)
        return mw.MarketingStore(SUPABASE, SERVICE_KEY, session=http), http

    def test_paid_public_plans_only_with_their_database_facts(self):
        store, http = self.store()
        self.assertEqual(store.price_plans(), [
            {"id": "creator", "name": "Plus", "monthly_credits": 2000.0, "concurrency": 2},
            {"id": "pro", "name": "Pro", "monthly_credits": 6000, "concurrency": 4}])
        self.assertTrue(all("select=" in u and u.startswith(SUPABASE + "/rest/v1/") for u in http.urls))

    def test_a_plan_without_an_entitlement_row_takes_the_keys_default_as_the_database_does(self):
        store, _ = self.store(plan_entitlements=self.ENTS[:1])
        self.assertEqual(store.price_plans()[1]["concurrency"], 1)

    def test_any_failed_or_unexpected_read_means_none(self):
        for name, answer in (("plans", (500, {})), ("plans", requests.ConnectionError(f"boom {SERVICE_KEY}")),
                             ("plans", {"not": "a list"}), ("entitlement_keys", (404, [])), ("entitlement_keys", []),
                             ("plan_entitlements", (500, [])), ("plan_entitlements", ["x"])):
            store, _ = self.store(**{name: answer})
            with captured() as box:
                self.assertIsNone(store.price_plans(), (name, answer))
            self.assertNotIn(SERVICE_KEY, box["text"])

    def test_a_concurrency_that_is_not_enforced_is_not_advertised(self):
        store, _ = self.store(entitlement_keys=[dict(self.KEY[0], status="planned")])
        self.assertIsNone(store.price_plans())

    def test_one_unreadable_credit_value_voids_the_post_instead_of_dropping_a_plan(self):
        rows = [dict(self.PLAN_ROWS[1], monthly_credits="2000"), self.PLAN_ROWS[2]]
        store, _ = self.store(plans=rows)
        self.assertIsNone(store.price_plans())

    def test_no_paid_plan_means_none(self):
        store, _ = self.store(plans=self.PLAN_ROWS[:1])
        self.assertIsNone(store.price_plans())


# ── sending ─────────────────────────────────────────────────────────────────

class Sending(unittest.TestCase):
    def setUp(self):
        self.srv = Server()
        self.addCleanup(self.srv.close)

    def one(self, chat, row=None, timeout=5.0, base=None):
        store = FakeStore(approved=[row or post_row()])
        w = worker_for(store, base or self.srv.base, chat=chat, timeout=timeout)
        with captured() as box:
            completion, pause = w.send_pass()
        return store, completion, pause, box["text"]

    def test_a_confirmed_post_is_settled_sent_with_the_message_id(self):
        store, c, pause, _ = self.one("@nightshift_test")
        self.assertEqual((c.outcome, c.message_id, pause), ("sent", "1", 0.0))
        self.assertEqual(store.completions, [(POST_ID, c)])
        self.assertEqual(len(self.srv.fake.calls), 1)

    def test_each_way_it_can_fail_is_settled_with_its_own_code(self):
        cases = [
            ("-1000000000429", ("retry", "rate_limited", 7), 7.0),
            ("-1000000000401", ("retry", "not_configured", None), mw.TOKEN_REFUSED_PAUSE_SECONDS),
            ("-1000000000403", ("failed", "blocked", None), 0.0),
            ("-1000000000400", ("failed", "blocked", None), 0.0),
            ("-1000000000500", ("dead", "http_5xx", None), 0.0),
            ("-1000000000777", ("dead", "unconfirmed", None), 0.0),
            ("-1000000000888", ("dead", "unconfirmed", None), 0.0),
            ("-1000000000000", ("dead", "unconfirmed", None), 0.0),
        ]
        for chat, want, want_pause in cases:
            with self.subTest(chat=chat):
                self.srv.fake.calls.clear()
                store, c, pause, _ = self.one(chat)
                self.assertEqual((c.outcome, c.error_code, c.retry_after), want)
                self.assertEqual(pause, want_pause)
                self.assertEqual(len(self.srv.fake.calls), 1, "one request per claimed post, never a second one in the same pass")

    def test_a_read_timeout_is_dead_and_not_resent(self):
        store, c, _, _ = self.one("-1000000000999", timeout=0.3)
        self.assertEqual((c.outcome, c.error_code), ("dead", "unconfirmed"))
        self.assertEqual(len(self.srv.fake.calls), 1)

    def test_a_refused_connection_is_retried_later_and_sent_once_when_the_network_is_back(self):
        store = FakeStore(approved=[post_row()])
        down = worker_for(store, closed_port_base())
        with captured():
            c, pause = down.send_pass()
        self.assertEqual((c.outcome, c.error_code), ("retry", "network"))
        self.assertEqual(len(store.approved), 1, "back in the queue, as the database puts a never-left post")
        up = worker_for(store, self.srv.base)
        with captured():
            c, _ = up.send_pass()
        self.assertEqual(c.outcome, "sent")
        self.assertEqual(len(self.srv.fake.calls), 1)

    def test_a_refused_token_pauses_the_worker_and_raises_an_alarm_without_the_token(self):
        _, c, pause, text = self.one("-1000000000401")
        self.assertEqual(pause, 300.0)
        self.assertIn("ALARM", text)
        self.assertIn("TELEGRAM_CHANNEL_BOT_TOKEN", text)
        self.assertNotIn(TOKEN, text)

    def test_a_post_that_cannot_be_built_is_failed_not_sent(self):
        row = post_row(texts=dict(TEXTS, en="x" * 5000))
        store, c, _, text = self.one("@nightshift_test", row=row)
        self.assertEqual((c.outcome, c.error_code, c.refused), ("failed", "bad_request", "too_long"))
        self.assertEqual(self.srv.fake.calls, [])
        self.assertIn("too_long", text)
        self.assertNotIn(TEXTS["en"], text)

    def test_one_post_per_loop_even_if_more_come_back(self):
        store = FakeStore(approved=[post_row(), post_row(post_id="0f0e0d0c-0b0a-4000-8000-000000000002")])
        store.claim_many = True
        w = worker_for(store, self.srv.base)
        with captured():
            w.send_pass()
        self.assertEqual(len(self.srv.fake.calls), 1)
        self.assertEqual([pid for pid, _ in store.completions], [POST_ID])

    def test_nothing_due_is_quiet(self):
        store = FakeStore()
        with captured() as box:
            self.assertEqual(worker_for(store, self.srv.base).send_pass(), (None, 0.0))
        self.assertEqual((self.srv.fake.calls, store.completions, box["text"]), ([], [], ""))

    def test_media_posts_use_the_media_methods(self):
        store = FakeStore(approved=[post_row(media_path="showcase/a.mp4", kind="showcase")])
        with captured():
            c, _ = worker_for(store, self.srv.base).send_pass()
        self.assertEqual(c.outcome, "sent")
        self.assertEqual(self.srv.fake.calls[0]["method"], "sendVideo")

    def test_a_lost_lease_is_never_sent_again(self):
        store = FakeStore(approved=[post_row()])
        store.lease_lost = True
        w = worker_for(store, self.srv.base)
        with captured() as box:
            c, _ = w.send_pass()
            self.assertEqual(w.send_pass(), (None, 0.0))      # the database settled it dead/unconfirmed: nothing to claim
            w.send_pass()
        self.assertEqual(c.outcome, "sent")
        self.assertEqual(len(self.srv.fake.calls), 1, "settle refused (False) and the post is not sent a second time")
        self.assertIn("lease was lost", box["text"])
        self.assertIn("not sent again", box["text"])

    def test_if_settling_fails_the_post_is_not_sent_again_either(self):
        store = FakeStore(approved=[post_row()])
        store.complete_raises = mw.StoreUnavailable("complete_marketing_post: HTTP 503")
        w = worker_for(store, self.srv.base)
        with captured() as box:
            w.send_pass()
            w.send_pass()
        self.assertEqual(len(self.srv.fake.calls), 1)
        self.assertIn("will not be sent again", box["text"])

    def test_a_settle_that_fails_at_first_is_retried_and_the_post_ends_sent_without_a_second_send(self):
        store = FakeStore(approved=[post_row()])
        store.complete_fail_first = 3
        naps = []
        w = worker_for(store, self.srv.base)
        w._sleep = naps.append
        with captured() as box:
            c, _ = w.send_pass()
        self.assertEqual(c.outcome, "sent")
        self.assertEqual(store.complete_tries, 4)
        self.assertEqual([x[0] for x in store.completions], [POST_ID])
        self.assertEqual(naps, [0.5, 1.0, 2.0], "short backoff, well inside the 120 s lease")
        self.assertEqual(len(self.srv.fake.calls), 1, "only the settle is repeated, never the send")
        self.assertIn("trying again", box["text"])

    def test_when_every_settle_fails_it_is_logged_and_the_post_is_not_sent_again(self):
        store = FakeStore(approved=[post_row()])
        store.complete_fail_first = 99
        w = worker_for(store, self.srv.base)
        with captured() as box:
            w.send_pass()
            w.send_pass()
        self.assertEqual(store.complete_tries, 4)
        self.assertEqual(len(self.srv.fake.calls), 1)
        self.assertIn("after 4 tries", box["text"])
        self.assertIn("will not be sent again", box["text"])

    def test_settling_gives_up_early_when_the_lease_is_nearly_over(self):
        store = FakeStore(approved=[post_row()])
        store.complete_fail_first = 99
        ticks = iter([0.0, 95.0, 96.0, 97.0, 98.0])
        w = worker_for(store, self.srv.base)
        w._clock = lambda: next(ticks)
        with captured():
            w.send_pass()
        self.assertEqual(store.complete_tries, 1)

    def test_a_lost_lease_answer_is_not_retried(self):
        store = FakeStore(approved=[post_row()])
        store.lease_lost = True
        with captured():
            worker_for(store, self.srv.base).send_pass()
        self.assertEqual(store.complete_tries, 1)

    def test_the_log_carries_codes_not_words(self):
        _, _, _, text = self.one("@nightshift_test")
        for secret in (TEXTS["en"], TEXTS["ru"], "nightshift_test", SERVICE_KEY, TOKEN):
            self.assertNotIn(secret, text)


# ── the token ───────────────────────────────────────────────────────────────

class TheTokenNeverLeaks(unittest.TestCase):
    """A fake token goes through every failure path; it must appear in no log line, report, result or exception."""

    FRAGMENTS = (TOKEN, SECRET_PART, SECRET_PART[:12], "7390481")

    class Hostile:
        """A session whose every failure quotes the whole URL (the token is a path segment), as requests does."""

        def __init__(self, exc_for):
            self.exc_for = exc_for

        def post(self, url, **kw):
            raise self.exc_for(url)

    def run_main(self, session_obj, chat="@nightshift_test", row=None, api_base="http://127.0.0.1:9"):
        store = FakeStore(plans=PLANS, approved=[row or post_row()])
        reporter = Reporter()
        with captured() as box:
            try:
                rc = mw.main(["--once"], env=env(MARKETING_TELEGRAM_CHAT=chat, NOTIFY_TELEGRAM_API_BASE=api_base),
                             store_factory=lambda: store,
                             session_factory=lambda: session_obj, reporter_factory=lambda w: reporter, install_signals=False)
            except BaseException as e:                       # noqa: BLE001 - an escaping exception is part of what is checked
                box["raised"] = repr(e) + str(e)
                rc = None
        blob = "\n".join([box["text"], box.get("raised", ""), json.dumps(reporter.reports),
                          repr(store.completions), repr(store.drafts)])
        return rc, blob, store

    def assert_clean(self, blob, path):
        for fragment in self.FRAGMENTS:
            self.assertNotIn(fragment, blob, f"{path}: a fragment of the token reached the output")

    def test_failures_that_quote_the_url(self):
        paths = {
            "connection refused": lambda url: requests.exceptions.ConnectionError(
                f"HTTPSConnectionPool(host='api.telegram.org', port=443): Max retries exceeded with url: {url} "
                f"(Caused by NewConnectionError('Failed to establish a new connection'))"),
            "connect timeout": lambda url: requests.exceptions.ConnectTimeout(f"timed out connecting to {url}"),
            "read timeout": lambda url: requests.exceptions.ReadTimeout(f"HTTPSConnectionPool: Read timed out. url: {url}"),
            "reset": lambda url: requests.exceptions.ConnectionError(f"Connection aborted. {url}", ConnectionResetError(104, "reset")),
            "ssl": lambda url: requests.exceptions.SSLError(f"bad handshake for {url}"),
            "other": lambda url: RuntimeError(f"unexpected failure calling {url}"),
            "http error": lambda url: requests.exceptions.HTTPError(f"500 Server Error: Internal Server Error for url: {url}"),
        }
        for name, make in paths.items():
            with self.subTest(name):
                rc, blob, store = self.run_main(self.Hostile(make))
                self.assertEqual(rc, 0, name)
                self.assertEqual(len(store.completions), 1, name)
                self.assert_clean(blob, name)

    def test_failures_over_a_real_connection(self):
        srv = Server()
        self.addCleanup(srv.close)
        for chat in ("-1000000000429", "-1000000000401", "-1000000000403", "-1000000000400", "-1000000000500",
                     "-1000000000777", "-1000000000888", "-1000000000000"):
            with self.subTest(chat=chat):
                rc, blob, store = self.run_main(session(), chat=chat, api_base=srv.base)
                self.assertEqual(rc, 0)
                self.assertEqual(len(store.completions), 1)
                self.assert_clean(blob, chat)
        rc, blob, store = self.run_main(session(), api_base=closed_port_base())
        self.assertEqual(store.completions[0][1].error_code, "network")
        self.assert_clean(blob, "refused")

    def test_a_refused_post_and_the_success_path_are_clean_too(self):
        srv = Server()
        self.addCleanup(srv.close)
        for row in (post_row(texts=dict(TEXTS, en="y" * 5000)), post_row()):
            rc, blob, store = self.run_main(session(), row=row, api_base=srv.base)
            self.assertEqual(rc, 0)
            self.assert_clean(blob, "refused-or-sent")

    def test_debug_logging_of_the_http_library_does_not_carry_the_url(self):
        # urllib3 logs `POST /bot<token>/sendMessage` at DEBUG. The worker keeps that logger quiet, so even a
        # root logger turned up to DEBUG (this harness does it) prints no token.
        srv = Server()
        self.addCleanup(srv.close)
        rc, blob, store = self.run_main(session(), api_base=srv.base)
        self.assertEqual(store.completions[0][1].outcome, "sent")
        self.assertGreaterEqual(logging.getLogger("urllib3").getEffectiveLevel(), logging.WARNING)
        self.assert_clean(blob, "debug")
        self.assertNotIn("/sendMessage", blob)

    def test_the_stores_own_failures_name_a_function_and_a_status_only(self):
        for exc in (requests.ConnectionError(f"{SUPABASE}/rest/v1/rpc/claim?apikey={SERVICE_KEY}"),
                    requests.Timeout(f"Bearer {SERVICE_KEY}")):
            http = mock.Mock()
            http.post.side_effect = exc
            store = mw.MarketingStore(SUPABASE, SERVICE_KEY, session=http)
            with self.assertRaises(mw.StoreUnavailable) as cm:
                store.claim("marketing-test")
            self.assertNotIn(SERVICE_KEY, str(cm.exception))
            self.assertNotIn(SUPABASE, str(cm.exception))

    def test_the_token_is_only_in_the_url_the_client_builds(self):
        calls = []

        class Spy:
            def post(self, url, json=None, timeout=None):
                calls.append((url, json))
                return mock.Mock(status_code=200, json=lambda: {"ok": True, "result": {"message_id": 5}})

        client = nt.TelegramClient(TOKEN, "https://api.telegram.test", Spy())
        out = cp.build_outgoing("@nightshift_test", post_row(), ORIGIN, SUPABASE)
        client.call(out.method, out.payload, cp.classify_channel_response)
        (url, payload), = calls
        self.assertEqual(url, f"https://api.telegram.test/bot{TOKEN}/sendMessage")
        self.assertNotIn(SECRET_PART, json.dumps(payload))

    def test_the_channel_bot_token_is_read_only_from_its_own_variable(self):
        src = (ROOT / "tools" / "marketing_worker.py").read_text(encoding="utf-8")
        code = "\n".join(line for line in src.splitlines() if not line.lstrip().startswith("#"))
        self.assertNotIn('"TELEGRAM_BOT_TOKEN"', code)
        self.assertNotIn('"TELEGRAM_CUSTOMER_BOT_TOKEN"', code)
        self.assertEqual(sorted(set(re.findall(r'get\("(\w*TOKEN\w*)"', code))), ["TELEGRAM_CHANNEL_BOT_TOKEN"])


# ── the worker's calls match the database it was written against ────────────

class DatabaseContract(unittest.TestCase):
    def params(self, fn):
        m = re.search(rf"function public\.{fn}\((.*?)\)\s*(?:returns)", MIGRATION, re.S)
        self.assertIsNotNone(m, fn)
        return re.findall(r"\bp_\w+", m.group(1))

    def rpc_body(self, call):
        http = mock.Mock()
        http.post.return_value = mock.Mock(status_code=200, json=lambda: [])
        store = mw.MarketingStore(SUPABASE, SERVICE_KEY, session=http)
        call(store)
        (args, kwargs), = http.post.call_args_list
        return args[0], kwargs["json"], kwargs["headers"]

    def test_draft_upsert_sends_exactly_the_functions_parameters(self):
        d = mc.price_draft(PLANS, NOW, NEWS)
        url, body, headers = self.rpc_body(lambda s: s.draft(d))
        self.assertTrue(url.endswith("/rest/v1/rpc/marketing_draft_upsert"))
        self.assertEqual(sorted(body), sorted(self.params("marketing_draft_upsert")))
        self.assertEqual((body["p_kind"], body["p_target"], body["p_media_path"], body["p_link"]), ("price", "telegram", None, "/pricing"))
        self.assertEqual(body["p_texts"], d.texts)
        self.assertEqual(headers["apikey"], SERVICE_KEY)

    def test_claim_and_complete_send_exactly_their_parameters(self):
        url, body, _ = self.rpc_body(lambda s: s.claim("marketing-test"))
        self.assertTrue(url.endswith("/rest/v1/rpc/claim_marketing_post"))
        self.assertEqual(sorted(body), sorted(self.params("claim_marketing_post")))
        self.assertEqual(body["p_target"], "telegram")
        for c in (cp.Completion("sent", message_id="9"), cp.Completion("retry", "rate_limited", retry_after=7),
                  cp.Completion("dead", "unconfirmed"), cp.Completion("failed", "blocked")):
            url, body, _ = self.rpc_body(lambda s: s.complete(POST_ID, "marketing-test", c))
            self.assertTrue(url.endswith("/rest/v1/rpc/complete_marketing_post"))
            self.assertEqual(sorted(body), sorted(self.params("complete_marketing_post")))
            self.assertIn(body["p_outcome"], ("sent", "failed", "retry", "dead"))

    def test_the_columns_the_worker_reads_are_returned_by_the_claim(self):
        m = re.search(r"claim_marketing_post\(.*?returns table \((.*?)\)\s*language", MIGRATION, re.S)
        cols = set(re.findall(r"\b(\w+) (?:uuid|text|jsonb|integer|timestamptz)", m.group(1)))
        self.assertTrue({"post_id", "texts", "media_path", "link"} <= cols, cols)

    def test_every_error_code_the_worker_can_report_is_in_the_closed_list(self):
        listed = set(re.findall(r"'(\w+)'", re.search(r"marketing_posts_error_check.*?in\s*\((.*?)\)\)", MIGRATION, re.S).group(1)))
        reported = {"rate_limited", "not_configured", "network", "blocked", "bad_request", "http_5xx", "unconfirmed"}
        self.assertTrue(reported <= listed, reported - listed)

    def test_only_these_outcomes_are_retried_by_the_database(self):
        m = re.search(r"v_code not in \(([^)]*)\)", MIGRATION)
        self.assertEqual(set(re.findall(r"'(\w+)'", m.group(1))), {"rate_limited", "not_configured", "network"})


if __name__ == "__main__":
    unittest.main()
