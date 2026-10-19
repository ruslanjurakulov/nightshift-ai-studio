"""The poster worker drafts ``promo`` posts from docs/promo/*.json (slice 4 of the marketing poster, migration 0110).

No database and no Telegram. The HTTP layer under ``MarketingStore`` is a fake PostgREST that follows
``marketing_draft_upsert_v2`` as the migration writes it (a new key makes a draft; the same key changes a draft nobody
edited and nothing else), so what the worker SENDS is checked argument by argument and what it DOES with the answers
is checked against the rules of the SQL.

The rules pinned here, each a way the poster could put a wrong promise in public or in front of the owner:
  * only a file with ``public: true`` that has not expired, with all three languages, evidence, a clean banned-claims
    check and a link the database accepts is drafted; every other file is skipped by a reason code and logged;
  * a promo is drafted through ``marketing_draft_upsert_v2`` with the exact arguments; news and price still use the
    0108 function, unchanged;
  * a rejected, expired or edited promo is never redrafted or overwritten ("already exists (status X)");
  * the drafting pass never claims, approves, completes or sends, and the idle-safe switch still stops all of it.
"""

import datetime as dt
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import requests

from modules import channel_post as cp
from modules import marketing_content as mc
from tests.test_marketing_worker import (NEWS, NOW, ORIGIN, PLANS, SERVICE_KEY, SUPABASE, FakeStore, Reporter, TEXTS,
                                         captured, env)
from tools import marketing_worker as mw

ROOT = Path(__file__).resolve().parent.parent
PROMO_MIGRATION = (ROOT / "supabase" / "migrations" / "0110_marketing_promo_custom.sql").read_text(encoding="utf-8")
V2 = "marketing_draft_upsert_v2"
V1 = "marketing_draft_upsert"

PROMO_TEXTS = {
    "uz": "Kameraga tushmasdan, bitta mavzudan video yarating. Ssenariy, ovoz, tasvir va subtitrlar bir joyda.",
    "ru": "Сделайте видео по одной теме, не показывая лицо. Сценарий, озвучка, видеоряд и субтитры в одном месте.",
    "en": "Make a faceless video from just a topic. The script, voiceover, visuals and captions in one place."}
EVIDENCE = [{"claim": "The public site says Nightshift writes, voices and edits a video from a topic.",
             "source": "command-center/lib/i18n/site/en.ts"},
            {"claim": "One pipeline run produces the script, the narration, the visuals and the captions.",
             "source": "main.py"}]


def promo(slug="faceless-video", **over):
    item = {"slug": slug, "public": True, "link": "/pricing", "texts": dict(PROMO_TEXTS), "evidence": [dict(e) for e in EVIDENCE],
            "valid_until": "2026-12-17", "ai_media": False}
    item.update(over)
    return item


class FakePostgrest:
    """The two drafting functions as the database answers them, and a record of every call."""

    def __init__(self, fail=None):
        self.calls = []
        self.rows = {}
        self.edited = set()
        self.fail = fail

    def post(self, url, json=None, timeout=None, headers=None):
        name = url.rsplit("/", 1)[-1]
        self.calls.append((name, url, json, headers))
        if self.fail:
            return mock.Mock(status_code=self.fail, json=lambda: {})
        if name not in (V1, V2):
            raise AssertionError(f"the drafting pass called {name}")
        key = json["p_idempotency_key"]
        row = self.rows.get(key)
        if row is None:
            self.rows[key] = {"texts": json["p_texts"], "link": json["p_link"], "facts": json["p_facts"], "status": "draft"}
            out = {"ok": True, "id": "0f0e0d0c-0b0a-4000-8000-000000000001", "status": "draft", "created": True, "updated": False}
        else:
            updated = (row["status"] == "draft" and key not in self.edited
                       and (row["texts"], row["link"], row["facts"]) != (json["p_texts"], json["p_link"], json["p_facts"]))
            if updated:
                row.update(texts=json["p_texts"], link=json["p_link"], facts=json["p_facts"])
            out = {"ok": True, "id": "0f0e0d0c-0b0a-4000-8000-000000000001", "status": row["status"], "created": False,
                   "updated": updated, "owner_edited": key in self.edited}
        return mock.Mock(status_code=200, json=lambda out=out: out)

    def get(self, url, **kw):
        raise AssertionError("the drafting pass read " + url)


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.promo_dir = self.dir / "promo"
        self.promo_dir.mkdir()
        self.news_dir = self.dir / "news"
        self.news_dir.mkdir()
        shutil.copy(NEWS / "banned-claims.json", self.news_dir / "banned-claims.json")

    def put(self, slug, item):
        (self.promo_dir / f"{slug}.json").write_text(item if isinstance(item, str) else json.dumps(item, ensure_ascii=False),
                                                     encoding="utf-8")

    def worker(self, store, origin=ORIGIN, now=NOW, sender=None):
        return mw.MarketingWorker(store, sender or mock.Mock(), "marketing-test", news_dir=self.news_dir,
                                  promo_dir=self.promo_dir, now=lambda: now, origin=origin)

    def http_worker(self, http=None, **kw):
        http = http or FakePostgrest()
        store = mw.MarketingStore(SUPABASE, SERVICE_KEY, session=http)
        store.price_plans = lambda: None                 # the price post has its own tests; here only promo is under test
        return self.worker(store, **kw), http

    def run_pass(self, w):
        with self.assertLogs(mw.logger, "DEBUG") as logs:
            mw.logger.debug("marker")                   # assertLogs needs one record even when nothing is logged
            counts = w.draft_pass()
        return counts, "\n".join(logs.output)


class WhichFilesAreDrafted(Base):
    def test_a_public_unexpired_evidenced_file_becomes_exactly_one_draft(self):
        self.put("faceless-video", promo())
        drafts, skipped, notes = mc.load_promo(self.promo_dir, dt.date(2026, 10, 18), self.news_dir)
        self.assertEqual((skipped, notes), ({}, []))
        (d,) = drafts
        self.assertEqual((d.key, d.kind, d.source_ref, d.link), ("promo:faceless-video:telegram", "promo", "promo:faceless-video", "/pricing"))
        self.assertEqual(d.texts, PROMO_TEXTS)
        self.assertIsNone(d.facts_as_of)
        self.assertEqual(d.facts, {"file": "faceless-video.json", "valid_until": "2026-12-17", "evidence": EVIDENCE})

    def test_a_file_that_is_not_public_is_ignored_without_a_trace(self):
        for i, value in enumerate([False, "true", 1, None, "yes"]):
            self.put(f"p{i}", promo(f"p{i}", public=value))
        missing = promo("nodecision")
        del missing["public"]
        self.put("nodecision", missing)
        w, http = self.http_worker()
        counts, log = self.run_pass(w)
        self.assertEqual(counts, {})
        self.assertEqual(http.calls, [])
        self.assertNotIn("not drafted", log)

    def test_an_expired_file_is_ignored_and_logged_but_the_last_day_still_counts(self):
        self.put("last-day", promo("last-day", valid_until="2026-10-18"))
        self.put("lapsed", promo("lapsed", valid_until="2026-10-17"))
        w, http = self.http_worker()
        counts, log = self.run_pass(w)
        self.assertEqual(counts, {"created": 1, "promo_skipped_expired": 1})
        self.assertEqual([c[2]["p_idempotency_key"] for c in http.calls], ["promo:last-day:telegram"])
        self.assertIn("promo lapsed not drafted: expired", log)

    def test_a_promo_without_an_expiry_never_lapses(self):
        self.put("standing", promo("standing", valid_until=None))
        w, _ = self.http_worker(now=dt.datetime(2040, 1, 1, tzinfo=dt.timezone.utc))
        self.assertEqual(self.run_pass(w)[0], {"created": 1})

    def test_a_missing_language_is_ignored_and_logged(self):
        for lang in ("uz", "ru", "en"):
            item = promo(f"no-{lang}")
            del item["texts"][lang]
            self.put(f"no-{lang}", item)
        self.put("extra-lang", promo("extra-lang", texts=dict(PROMO_TEXTS, de="Ein Text in einer vierten Sprache.")))
        self.put("empty-lang", promo("empty-lang", texts=dict(PROMO_TEXTS, ru="")))
        w, http = self.http_worker()
        counts, log = self.run_pass(w)
        self.assertEqual(counts, {"promo_skipped_bad_texts": 5})
        self.assertEqual(http.calls, [])
        self.assertIn("promo no-uz not drafted: bad_texts", log)

    def test_a_banned_claim_is_refused_logged_by_rule_and_the_words_are_not_logged(self):
        self.put("free", promo("free", texts=dict(PROMO_TEXTS, en="Make a faceless video from a topic. Start for free today.")))
        self.put("provider", promo("provider", texts=dict(PROMO_TEXTS, ru="Видео по теме с помощью OpenAI: сценарий и озвучка.")))
        self.put("income", promo("income", texts=dict(PROMO_TEXTS, uz="Mavzudan video yarating va daromad toping, hammasi bir joyda.")))
        self.put("clean", promo("clean"))
        w, http = self.http_worker()
        counts, log = self.run_pass(w)
        self.assertEqual(counts, {"created": 1, "promo_skipped_banned_claim": 3})
        self.assertEqual([c[2]["p_idempotency_key"] for c in http.calls], ["promo:clean:telegram"])
        self.assertIn("promo free not drafted: banned_claim (free)", log)
        self.assertIn("promo provider not drafted: banned_claim (provider:openai)", log)
        self.assertIn("promo income not drafted: banned_claim (income)", log)
        for words in ("Start for free", "OpenAI:", "daromad toping", "faceless video from a topic"):
            self.assertNotIn(words, log)

    def test_without_the_banned_list_nothing_is_drafted(self):
        self.put("clean", promo("clean"))
        (self.news_dir / "banned-claims.json").unlink()
        w, http = self.http_worker()
        self.assertEqual(self.run_pass(w)[0], {"promo_skipped_banned_list_unreadable": 1})
        self.assertEqual(http.calls, [])

    def test_a_file_without_evidence_is_refused(self):
        self.put("none", promo("none", evidence=[]))
        gone = promo("gone")
        del gone["evidence"]
        self.put("gone", gone)
        self.put("nosource", promo("nosource", evidence=[{"claim": "A claim that has no source at all.", "source": ""}]))
        self.put("absolute", promo("absolute", evidence=[{"claim": "A claim whose source is outside.", "source": "/etc/passwd"}]))
        self.put("number", promo("number", texts={l: t + " 12 steps." for l, t in PROMO_TEXTS.items()}))   # 12 is evidenced nowhere
        w, http = self.http_worker()
        counts, log = self.run_pass(w)
        self.assertEqual(counts, {"promo_skipped_bad_evidence": 4, "promo_skipped_bad_keys": 1})
        self.assertEqual(http.calls, [])

    def test_links_the_database_would_refuse_are_refused_before_it_is_asked(self):
        for i, link in enumerate(["https://evil.example/x", "//evil.example", "pricing", "/", "/a/../b", "/Pricing", "/a//b", "/a b", ""]):
            self.put(f"link-{i}", promo(f"link-{i}", link=link))
        self.put("no-link", promo("no-link", link=None))
        self.put("ok-link", promo("ok-link", link="/studio"))
        w, http = self.http_worker()
        counts, _ = self.run_pass(w)
        self.assertEqual(counts, {"promo_skipped_bad_link": 9, "created": 2})
        self.assertEqual(sorted((c[2]["p_idempotency_key"], c[2]["p_link"]) for c in http.calls),
                         [("promo:no-link:telegram", None), ("promo:ok-link:telegram", "/studio")])

    def test_ai_media_flag_set_is_refused_because_no_media_is_attached(self):
        self.put("ai", promo("ai", ai_media=True))
        w, http = self.http_worker()
        self.assertEqual(self.run_pass(w)[0], {"promo_skipped_bad_ai_media": 1})
        self.assertEqual(http.calls, [])

    def test_slug_and_file_name_must_agree_and_stray_names_are_not_files(self):
        self.put("one", promo("two"))
        self.put("Upper", promo("Upper"))
        self.put("README", promo("README"))
        (self.promo_dir / "notes.txt").write_text("{}")
        self.put("fine", promo("fine"))
        w, http = self.http_worker()
        counts, _ = self.run_pass(w)
        self.assertEqual(counts, {"created": 1, "promo_skipped_bad_slug": 1})

    def test_one_broken_file_never_stops_the_others(self):
        self.put("a-broken", "{not json")
        self.put("b-array", "[]")
        self.put("c-good", promo("c-good"))
        w, http = self.http_worker()
        counts, _ = self.run_pass(w)
        self.assertEqual(counts, {"created": 1, "promo_skipped_unreadable": 1})

    def test_a_missing_promo_directory_is_not_an_error(self):
        w = mw.MarketingWorker(FakeStore(), mock.Mock(), "marketing-test", news_dir=self.news_dir,
                               promo_dir=self.dir / "nowhere", now=lambda: NOW, origin=ORIGIN)
        self.assertEqual(w.draft_pass(), {})

    def test_the_sender_would_refuse_a_draft_it_never_reaches_the_owner(self):
        email = dict(PROMO_TEXTS, en="Make a faceless video from a topic. Write to someone@example.com for help.")
        self.put("email", promo("email", texts=email))
        self.put("key", promo("key", texts=dict(PROMO_TEXTS, en="Make a faceless video; the key is sk-abcdefghijklmnopqrstuvwxyzabcdef here.")))
        w, http = self.http_worker()
        counts, log = self.run_pass(w)
        self.assertEqual(counts, {"not_drafted_unsafe_text": 2})
        self.assertEqual(http.calls, [])
        self.assertIn("promo email not drafted: the sender would refuse it (unsafe_text)", log)
        self.assertNotIn("someone@example.com", log)
        self.assertNotIn("sk-abcdefgh", log)

    def test_a_link_without_a_usable_site_origin_is_not_drafted(self):
        self.put("linked", promo("linked"))
        self.put("plain", promo("plain", link=None))
        w, http = self.http_worker(origin=None)
        counts, _ = self.run_pass(w)
        self.assertEqual(counts, {"not_drafted_no_origin": 1, "created": 1})
        self.assertEqual([c[2]["p_idempotency_key"] for c in http.calls], ["promo:plain:telegram"])


class WhatIsSentToTheDatabase(Base):
    def test_v2_is_called_with_the_exact_arguments(self):
        self.put("faceless-video", promo())
        w, http = self.http_worker()
        self.assertEqual(w.draft_pass(), {"created": 1})
        ((name, url, body, headers),) = http.calls
        self.assertEqual((name, url), (V2, f"{SUPABASE}/rest/v1/rpc/{V2}"))
        self.assertEqual(body, {
            "p_idempotency_key": "promo:faceless-video:telegram", "p_kind": "promo", "p_texts": PROMO_TEXTS,
            "p_source_ref": "promo:faceless-video",
            "p_facts": {"file": "faceless-video.json", "valid_until": "2026-12-17", "evidence": EVIDENCE},
            "p_facts_as_of": None, "p_media_path": None, "p_target": "telegram", "p_link": "/pricing"})
        self.assertEqual(headers["apikey"], SERVICE_KEY)

    def test_the_arguments_are_exactly_the_functions_parameters_and_satisfy_its_checks(self):
        m = re.search(rf"function public\.{V2}\((.*?)\)\s*returns", PROMO_MIGRATION, re.S)
        params = re.findall(r"\bp_\w+", m.group(1))
        self.put("faceless-video", promo())
        w, http = self.http_worker()
        w.draft_pass()
        body = http.calls[0][2]
        self.assertEqual(sorted(body), sorted(params))
        self.assertEqual(body["p_idempotency_key"], body["p_source_ref"] + ":" + body["p_target"])    # the DB's key rule
        self.assertRegex(body["p_source_ref"], r"^promo:[a-z0-9-]{1,60}$")
        self.assertLessEqual(len(json.dumps(body["p_facts"], ensure_ascii=False).encode()), 8192)

    def test_news_and_price_still_use_the_0108_function_with_the_same_nine_arguments(self):
        news = mc.Draft(key="news:shapes", kind="news", texts=dict(TEXTS), source_ref="pr:#484", link="/editor")
        price = mc.price_draft(PLANS, NOW, NEWS)
        for d in (news, price):
            http = FakePostgrest()
            mw.MarketingStore(SUPABASE, SERVICE_KEY, session=http).draft(d)
            ((name, url, body, _),) = http.calls
            self.assertEqual((name, url), (V1, f"{SUPABASE}/rest/v1/rpc/{V1}"), d.kind)
            self.assertEqual(body, {
                "p_idempotency_key": d.key, "p_kind": d.kind, "p_texts": d.texts, "p_source_ref": d.source_ref,
                "p_facts": d.facts, "p_facts_as_of": d.facts_as_of, "p_media_path": None, "p_target": "telegram",
                "p_link": d.link})

    def test_a_pass_with_news_price_and_promo_sends_each_to_its_own_function(self):
        (self.news_dir / "2026-10-15-editor-shapes.json").write_text(json.dumps(
            {"pr": 484, "shipped": "2026-10-15", "kind": "feature", "public": True, "text": TEXTS}, ensure_ascii=False))
        self.put("faceless-video", promo())
        store = mw.MarketingStore(SUPABASE, SERVICE_KEY, session=FakePostgrest())
        store.price_plans = lambda: PLANS
        http = store._http
        counts = self.worker(store).draft_pass()
        self.assertEqual(counts, {"created": 3})
        self.assertEqual(sorted((c[0], c[2]["p_kind"]) for c in http.calls), [(V1, "news"), (V1, "price"), (V2, "promo")])

    def test_a_failing_v2_names_the_function_and_the_migration_but_no_secret(self):
        self.put("faceless-video", promo())
        w, http = self.http_worker(FakePostgrest(fail=404))
        with self.assertLogs(mw.logger, "WARNING") as logs:
            counts = w.draft_pass()
        self.assertEqual(counts, {"store_unavailable": 1})
        text = "\n".join(logs.output)
        self.assertIn(f"{V2}: HTTP 404 (is migration 0110 applied?)", text)
        self.assertNotIn(SERVICE_KEY, text)

    def test_a_failing_0108_function_still_points_at_0108(self):
        http = FakePostgrest(fail=404)
        with self.assertRaises(mw.StoreUnavailable) as cm:
            mw.MarketingStore(SUPABASE, SERVICE_KEY, session=http).draft(
                mc.Draft(key="news:x", kind="news", texts=dict(TEXTS), source_ref="pr:#1"))
        self.assertIn("migration 0108", str(cm.exception))


class ExistingPromosAreNeverTouched(Base):
    def test_the_second_pass_changes_nothing_and_says_the_post_already_exists(self):
        self.put("faceless-video", promo())
        w, http = self.http_worker()
        self.assertEqual(w.draft_pass(), {"created": 1})
        counts, log = self.run_pass(w)
        self.assertEqual(counts, {"promo_exists_draft": 1})
        self.assertIn("promo faceless-video already exists (status draft)", log)
        self.assertEqual(len(http.rows), 1)

    def test_a_rejected_expired_or_sent_promo_is_permanent_and_never_redrafted(self):
        self.put("faceless-video", promo())
        w, http = self.http_worker()
        w.draft_pass()
        for status in ("rejected", "expired", "approved", "sent", "dead"):
            http.rows["promo:faceless-video:telegram"]["status"] = status
            self.put("faceless-video", promo(texts=dict(PROMO_TEXTS, en=PROMO_TEXTS["en"] + " More words.")))   # even changed words
            counts, log = self.run_pass(w)
            self.assertEqual(counts, {f"promo_exists_{status}": 1}, status)
            self.assertIn(f"promo faceless-video already exists (status {status})", log)
            self.assertEqual(http.rows["promo:faceless-video:telegram"]["texts"], PROMO_TEXTS)       # untouched
            self.put("faceless-video", promo())

    def test_a_draft_the_owner_edited_is_never_overwritten(self):
        self.put("faceless-video", promo())
        w, http = self.http_worker()
        w.draft_pass()
        http.edited.add("promo:faceless-video:telegram")
        http.rows["promo:faceless-video:telegram"]["texts"] = dict(PROMO_TEXTS, en="The owner's own words, kept as they are.")
        self.put("faceless-video", promo(texts=dict(PROMO_TEXTS, en=PROMO_TEXTS["en"] + " Changed in the file.")))
        counts, log = self.run_pass(w)
        self.assertEqual(counts, {"promo_exists_draft": 1})
        self.assertEqual(http.rows["promo:faceless-video:telegram"]["texts"]["en"], "The owner's own words, kept as they are.")

    def test_an_unedited_draft_follows_the_reviewed_file(self):
        self.put("faceless-video", promo())
        w, http = self.http_worker()
        w.draft_pass()
        self.put("faceless-video", promo(texts=dict(PROMO_TEXTS, en=PROMO_TEXTS["en"] + " Reworded in review.")))
        self.assertEqual(w.draft_pass(), {"updated": 1})

    def test_an_answer_with_an_odd_status_is_logged_as_unknown(self):
        self.put("faceless-video", promo())
        store = FakeStore()
        store.draft = lambda d: {"ok": True, "created": False, "updated": False, "status": "x;DROP TABLE"}
        counts, log = self.run_pass(self.worker(store))
        self.assertEqual(counts, {"promo_exists_unknown": 1})
        self.assertNotIn("DROP", log)

    def test_a_refusal_from_the_database_is_counted_by_its_code(self):
        self.put("faceless-video", promo())
        store = FakeStore()
        store.draft = lambda d: {"ok": False, "error": "key_reused"}
        self.assertEqual(self.worker(store).draft_pass(), {"refused_key_reused": 1})


class DraftingNeverApprovesOrSends(Base):
    def test_a_pass_calls_nothing_but_the_drafting_functions_and_never_the_sender(self):
        for i in range(3):
            self.put(f"promo-{i}", promo(f"promo-{i}"))
        sender = mock.Mock()
        w, http = self.http_worker(sender=sender)
        self.assertEqual(w.draft_pass(), {"created": 3})           # drafting is not capped: three open drafts are fine
        self.assertEqual({c[0] for c in http.calls}, {V2})
        sender.send.assert_not_called()

    def test_with_a_fake_store_there_is_no_claim_complete_or_approval(self):
        self.put("faceless-video", promo())
        store = FakeStore()
        sender = mock.Mock()
        self.worker(store, sender=sender).draft_pass()
        self.assertEqual((store.claims, store.completions, list(store.approved)), (0, [], []))
        sender.send.assert_not_called()
        self.assertEqual(list(store.drafts), ["promo:faceless-video:telegram"])

    def test_the_worker_source_has_no_way_to_approve_or_to_call_the_owner_functions(self):
        src = (ROOT / "tools" / "marketing_worker.py").read_text(encoding="utf-8")
        code = "\n".join(l for l in src.splitlines() if not l.lstrip().startswith("#"))
        self.assertNotRegex(code, r"owner_marketing|approve_marketing|\bapproved_hash\b|marketing_settings|marketing_posts\b")
        self.assertTrue(set(re.findall(r'"(marketing_\w+|claim_marketing_post|complete_marketing_post)"', code))
                        <= {V1, V2, "claim_marketing_post", "complete_marketing_post", "marketing_worker"})

    def test_sending_is_still_one_post_per_loop_whatever_the_kind(self):
        # The 2 posts per 7 days cap is the database's, on every kind; the worker still takes one claimed post at a time.
        row = {"post_id": "0f0e0d0c-0b0a-4000-8000-000000000001", "kind": "promo", "target": "telegram", "texts": dict(PROMO_TEXTS),
               "media_path": None, "link": "/pricing", "attempts": 1, "content_hash": "0" * 64}
        store = FakeStore(approved=[row, dict(row, post_id="0f0e0d0c-0b0a-4000-8000-000000000002")])
        store.claim_many = True
        sender = mock.Mock()
        sender.send.return_value = cp.Completion("sent", message_id="5")
        w = self.worker(store, sender=sender)
        completion, _ = w.send_pass()
        self.assertEqual(completion.outcome, "sent")
        self.assertEqual(sender.send.call_count, 1)
        self.assertEqual(len(store.completions), 1)


class IdleSafe(Base):
    """The switch is exactly 'on'. Anything else and promo files, like everything else, are not looked at."""

    def run_main(self, **over):
        calls = []
        store = FakeStore()
        original = store.draft
        store.draft = lambda d: (calls.append(d.key), original(d))[1]
        with captured() as box, mock.patch.object(mc, "PROMO_DIR", self.promo_dir):
            rc = mw.main(["--once"], env=env(**over), store_factory=lambda: store, session_factory=lambda: requests.Session(),
                         reporter_factory=lambda w: Reporter(), install_signals=False)
        return rc, calls, store, box["text"]

    def test_anything_but_on_drafts_nothing_claims_nothing_and_builds_no_store(self):
        self.put("faceless-video", promo())
        for value in ("", "off", "On", "true", "1", "yes", " ", "ON"):
            built = []
            with captured(), mock.patch.object(mc, "PROMO_DIR", self.promo_dir):
                rc = mw.main(["--once"], env=env(NIGHTSHIFT_MARKETING_POSTS=value), store_factory=lambda: built.append(1),
                             session_factory=lambda: built.append(2), reporter_factory=lambda w: Reporter(), install_signals=False)
            self.assertEqual((rc, built), (0, []), repr(value))

    def test_a_switch_that_is_on_but_incomplete_drafts_nothing_either(self):
        self.put("faceless-video", promo())
        rc, calls, store, _ = self.run_main(TELEGRAM_CHANNEL_BOT_TOKEN="")
        self.assertEqual((rc, calls, store.claims), (0, [], 0))

    def test_switched_on_the_promo_file_is_drafted_through_main_and_one_claim_is_made(self):
        self.put("faceless-video", promo())
        # main() reads the news dir from the repository: the real banned list lives there, so this uses it.
        rc, calls, store, text = self.run_main()
        self.assertEqual(rc, 0)
        self.assertIn("promo:faceless-video:telegram", calls)
        self.assertEqual(store.claims, 1)
        self.assertNotIn(SERVICE_KEY, text)


class HostileFiles(Base):
    """A file in docs/news or docs/promo is reviewed, but the image is built from a commit, not from a green CI run:
    whatever it holds, the drafting pass must go on with the other files and the price post."""

    def news(self, name, item):
        (self.news_dir / name).write_text(item if isinstance(item, str) else json.dumps(item, ensure_ascii=False), encoding="utf-8")

    def test_deeply_nested_json_is_skipped_in_promo_and_in_news_and_the_pass_goes_on(self):
        deep_array = "[" * 5000 + "]" * 5000
        deep_object = '{"a":' * 5000 + "1" + "}" * 5000
        self.put("a-array", deep_array)
        self.put("b-object", deep_object)
        self.put("c-good", promo("c-good"))
        self.news("2026-10-15-deep-array.json", deep_array)
        self.news("2026-10-15-deep-object.json", deep_object)
        self.news("2026-10-15-good.json", {"pr": 484, "shipped": "2026-10-15", "kind": "feature", "public": True, "text": TEXTS})
        store = FakeStore(plans=PLANS)
        counts = self.worker(store).draft_pass()
        self.assertEqual(counts, {"created": 3, "promo_skipped_unreadable": 2, "news_skipped_unreadable": 2})
        self.assertEqual(sorted(store.drafts), ["news:good", "price:creator,pro,studio:2026-10", "promo:c-good:telegram"])

    def test_a_loader_that_still_raises_a_recursion_error_does_not_kill_the_pass(self):
        store = FakeStore(plans=PLANS)
        with mock.patch.object(mc, "load_promo", side_effect=RecursionError), \
                mock.patch.object(mc, "load_news", side_effect=RecursionError):
            counts = self.worker(store).draft_pass()
        self.assertEqual(counts, {"news_skipped_news_dir_unreadable": 1, "promo_skipped_promo_dir_unreadable": 1, "created": 1})
        self.assertEqual(list(store.drafts), ["price:creator,pro,studio:2026-10"])

    def test_a_file_over_64_kb_is_never_read(self):
        big = json.dumps(promo("big", texts=dict(PROMO_TEXTS, en="x" * (mc.MAX_FILE_BYTES + 10))))
        self.put("big", big)
        self.news("2026-10-15-big.json", big)
        self.put("ok", promo("ok"))
        real = Path.read_text

        def guard(path, *a, **k):
            assert "big" not in path.name, "a large file was read"
            return real(path, *a, **k)

        with mock.patch.object(Path, "read_text", guard):
            drafts, skipped, _ = mc.load_promo(self.promo_dir, dt.date(2026, 10, 18), self.news_dir)
            self.assertEqual((len(drafts), skipped), (1, {"too_large": 1}))
            drafts, skipped = mc.load_news(self.news_dir, dt.date(2026, 10, 18))
            self.assertEqual((drafts, skipped), ([], {"too_large": 1}))

    def test_a_repeated_key_is_refused_because_the_last_one_would_silently_win(self):
        good = json.dumps(promo("dup"), ensure_ascii=False)
        self.put("dup", good.replace('"public": true', '"public": false, "public": true'))
        self.put("dup2", good.replace('"slug": "dup"', '"slug": "dup2"').replace('"en": ', '"en": "x", "en": '))
        self.news("2026-10-15-dup.json", '{"pr": 1, "pr": 2, "shipped": "2026-10-15"}')
        drafts, skipped, _ = mc.load_promo(self.promo_dir, dt.date(2026, 10, 18), self.news_dir)
        self.assertEqual((drafts, skipped), ([], {"unreadable": 2}))
        self.assertEqual(mc.load_news(self.news_dir, dt.date(2026, 10, 18)), ([], {"unreadable": 1}))

    def test_a_symlinked_file_is_skipped(self):
        outside = self.dir / "outside.json"
        outside.write_text(json.dumps(promo("linked")), encoding="utf-8")
        (self.promo_dir / "linked.json").symlink_to(outside)
        (self.news_dir / "2026-10-15-linked.json").symlink_to(outside)
        self.put("real", promo("real"))
        drafts, skipped, notes = mc.load_promo(self.promo_dir, dt.date(2026, 10, 18), self.news_dir)
        self.assertEqual(([d.key for d in drafts], skipped), (["promo:real:telegram"], {"symlink": 1}))
        self.assertEqual(mc.load_news(self.news_dir, dt.date(2026, 10, 18)), ([], {"symlink": 1}))

    def test_a_database_failure_while_drafting_promo_does_not_skip_the_price_post_or_news(self):
        self.news("2026-10-15-good.json", {"pr": 484, "shipped": "2026-10-15", "kind": "feature", "public": True, "text": TEXTS})
        self.put("a-one", promo("a-one"))
        self.put("b-two", promo("b-two"))
        store = FakeStore(plans=PLANS)
        original = store.draft
        calls = []

        def draft(d):
            calls.append(d.key)
            if d.kind == "promo":
                raise mw.StoreUnavailable("marketing_draft_upsert_v2: HTTP 503")
            return original(d)

        store.draft = draft
        counts, log = self.run_pass(self.worker(store))
        self.assertEqual(counts, {"created": 2, "store_unavailable": 1})
        self.assertEqual(sorted(store.drafts), ["news:good", "price:creator,pro,studio:2026-10"])
        self.assertEqual([k for k in calls if k.startswith("promo:")], ["promo:a-one:telegram"])     # not retried per file
        self.assertIn("drafting promo stopped", log)

    def test_a_database_failure_on_news_does_not_skip_promo_or_price(self):
        self.news("2026-10-15-good.json", {"pr": 484, "shipped": "2026-10-15", "kind": "feature", "public": True, "text": TEXTS})
        self.put("a-one", promo("a-one"))
        store = FakeStore(plans=PLANS)
        original = store.draft

        def draft(d):
            if d.kind == "news":
                raise mw.StoreUnavailable("marketing_draft_upsert: HTTP 503")
            return original(d)

        store.draft = draft
        counts = self.worker(store).draft_pass()
        self.assertEqual(counts, {"created": 2, "store_unavailable": 1})


class TheFilesInTheRepository(unittest.TestCase):
    def test_the_real_promo_folder_drafts_through_the_real_banned_list(self):
        drafts, skipped, notes = mc.load_promo(mc.PROMO_DIR, dt.date(2026, 10, 18), NEWS)
        self.assertEqual((skipped, notes), ({}, []))
        self.assertGreaterEqual(len(drafts), 3)
        for d in drafts:
            self.assertEqual(mc.banned_hits("\n".join(d.texts.values()), NEWS), [])
            self.assertIsNone(cp.preflight(d.texts, d.link, ORIGIN, False), d.key)

    def test_the_real_files_all_expire(self):
        for p in mc.PROMO_DIR.glob("*.json"):
            item = json.loads(p.read_text(encoding="utf-8"))
            if item["public"]:
                self.assertIsNotNone(item["valid_until"], p.name)

    def test_after_the_expiry_none_of_them_is_drafted_any_more(self):
        drafts, skipped, _ = mc.load_promo(mc.PROMO_DIR, dt.date(2099, 1, 1), NEWS)
        self.assertEqual((drafts, skipped), ([], {"expired": len(list(mc.PROMO_DIR.glob("*.json")))}))


if __name__ == "__main__":
    unittest.main()
