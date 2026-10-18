"""Owner e-mail alerts (modules/operator_bot/owner_mail.py, owner_digest.py; docs/OWNER_EMAIL.md).

Fakes only: a recording mail transport, the operator bot's fake Supabase and Telegram, a clock. Nothing
touches the network, a provider or a secret.

What is pinned is what would hurt:
  * anything sent while the switch is not exactly `on`;
  * a mail to anybody but a CONFIRMED owner/admin read from the roster (a customer, an editor, an invitation,
    an unconfirmed or banned account), or an address taken from anywhere else;
  * a customer's name or address in a subject or a body;
  * the same mail twice (dedupe), a mail inside quiet hours or past the hourly cap, a muted kind;
  * a failing mail provider stopping the alert loop, or turning it into a storm of retries;
  * a secret or an address in a log line.
"""

import logging
import re
import unittest
from datetime import timedelta
from pathlib import Path

from modules import email_notify as mail
from modules.operator_bot import alerts, owner_mail
from modules.operator_bot.config import OperatorConfig
from modules.operator_bot.i18n import LANGUAGES, t, table
from modules.operator_bot.store import replay
from tests.operator_bot_fakes import NOW, healthy_tables, ts
from tests.test_operator_bot_alerts import build as build_engine, failed_job, heartbeat

ROOT = Path(__file__).resolve().parent.parent
OWNER, ADMIN = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
OWNER_ADDR, ADMIN_ADDR = "owner@example.org", "admin@example.org"
CUSTOMER_ADDR, CUSTOMER_NAME = "buyer.person@customer-mail.test", "Zebulon Customerson"
API_KEY = "re_TESTKEY_never_in_a_mail_0123456789"


class RecordingTransport:
    name = "recording"

    def __init__(self, fail=None):
        self.sent: list = []
        self.attempts = 0
        self.fail = fail

    def send(self, message):
        self.attempts += 1
        if self.fail is not None:
            raise self.fail
        self.sent.append(message)

    def texts(self):
        return [m.subject + "\n" + m.text + "\n" + m.html for m in self.sent]


AUTH = {
    OWNER: {"id": OWNER, "email": OWNER_ADDR, "email_confirmed_at": "2026-01-01T00:00:00Z"},
    ADMIN: {"id": ADMIN, "email": ADMIN_ADDR, "email_confirmed_at": "2026-01-02T00:00:00Z"},
}
ROSTER = [{"user_id": OWNER, "role": "owner"}, {"user_id": ADMIN, "role": "admin"}]


class Rig:
    """The engine from the alert tests, with the owner e-mail sink beside Telegram."""

    def __init__(self, tables=None, cfg=None, transport=None, roster=None, auth=None, kinds=None, store=None,
                 http=None, lang=None):
        base = {"app_members": list(ROSTER if roster is None else roster), "organizations": [], "payment_events": []}
        base.update(tables or {})
        cfg = cfg or OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", max_alerts_per_hour=6)
        self.engine, self.store, self.tg, self.ops, self.clock = build_engine(base, http, cfg, store=store)
        self.transport = transport or RecordingTransport()
        self.auth = dict(AUTH if auth is None else auth)
        self.fetched: list = []
        self.directory = owner_mail.OwnerDirectory(self.ops.sync, self.clock, fetch_user=self._fetch)
        self.mailer = owner_mail.OwnerMail(self.ops, self.store, self.transport, self.directory, cfg,
                                           kinds or frozenset(owner_mail.DEFAULT_KINDS))
        self.engine.owner_mail = self.mailer
        if lang:
            self.store.record_language(lang)

    def _fetch(self, uid):
        self.fetched.append(uid)
        return self.auth.get(uid)

    def arm(self):
        """The first pass is a silent baseline plus one 'on' e-mail; most tests start after it."""
        rep = self.engine.tick()
        assert rep.baseline and rep.mail.baseline, rep
        if hasattr(self.transport, "sent"):
            self.transport.sent.clear()
            self.transport.attempts = 0
        self.keep_worker_alive()
        return rep

    pinned = False                  # a test that sets its own worker rows pins them

    def keep_worker_alive(self):
        if not self.pinned:
            heartbeat(self.ops, self.clock)

    def tick(self, **advance):
        if advance:
            self.clock.advance(**advance)
        self.keep_worker_alive()
        return self.engine.tick()


def subjects(rig):
    return [m.subject for m in rig.transport.sent]


def paid(i, amount=1250, cur="USD", minutes_ago=30, status="processed", etype="transaction.completed"):
    return {"event_id": f"txn_0000000{i}abcd{i}", "event_type": etype, "status": status, "amount_minor": amount,
            "currency": cur, "received_at": ts(minutes_ago)}


# -- the switch --------------------------------------------------------------

class SwitchTestCase(unittest.TestCase):
    def build(self, env):
        rig = Rig()
        return owner_mail.OwnerMail.from_env(rig.ops, rig.store, rig.ops.sync, rig.ops.cfg, env)

    ENV = {"RESEND_API_KEY": API_KEY, "NIGHTSHIFT_EMAIL_FROM": "Nightshift <hello@example.org>"}

    def test_it_is_on_only_for_exactly_on(self):
        self.assertIsNotNone(self.build({**self.ENV, "NIGHTSHIFT_OWNER_EMAIL": "on"}))
        for value in (None, "", "off", "ON", "On", "true", "1", "yes", " on", "on ", "enabled"):
            env = dict(self.ENV)
            if value is not None:
                env["NIGHTSHIFT_OWNER_EMAIL"] = value
            with self.subTest(value=value):
                self.assertIsNone(self.build(env))

    def test_on_without_a_sender_is_off_and_names_the_missing_names_only(self):
        with self.assertLogs("modules.operator_bot.owner_mail", "INFO") as cap:
            self.assertIsNone(self.build({"NIGHTSHIFT_OWNER_EMAIL": "on", "RESEND_API_KEY": API_KEY}))
        out = "\n".join(cap.output)
        self.assertIn("NIGHTSHIFT_EMAIL_FROM", out)
        self.assertNotIn(API_KEY, out)

    def test_a_switched_off_engine_sends_no_mail_and_makes_no_account_lookup(self):
        rig = Rig({"render_jobs": [failed_job(5)]})
        rig.engine.owner_mail = None
        rig.engine.tick()
        rig.engine.tick()
        self.assertEqual((rig.transport.attempts, rig.fetched), (0, []))
        self.assertEqual([r for r in rig.store.rows if r["kind"] == "operator.mail"], [])

    def test_fake_transport_writes_nothing_to_the_network_and_the_real_one_needs_both_names(self):
        self.assertEqual(owner_mail.transport_from_env({"NIGHTSHIFT_EMAIL_TRANSPORT": "fake"}).name, "fake")
        self.assertIsNone(owner_mail.transport_from_env({"RESEND_API_KEY": API_KEY}))
        self.assertIsNone(owner_mail.transport_from_env({"NIGHTSHIFT_EMAIL_FROM": "a <b@c.org>"}))
        self.assertEqual(owner_mail.transport_from_env(self.ENV).name, "resend")
        self.assertIsNone(owner_mail.transport_from_env({**self.ENV, "NIGHTSHIFT_EMAIL_TRANSPORT": "smtp"}))

    def test_the_kinds_setting_drops_unknown_names_and_falls_back_to_the_default(self):
        self.assertEqual(owner_mail.parse_kinds(None), frozenset(owner_mail.DEFAULT_KINDS))
        self.assertEqual(owner_mail.parse_kinds("nonsense, ,"), frozenset(owner_mail.DEFAULT_KINDS))
        self.assertEqual(owner_mail.parse_kinds(" Payment , signup,bogus"), frozenset({"payment", "signup"}))
        self.assertNotIn("balance", owner_mail.DEFAULT_KINDS)

    def test_no_telegram_no_pass_no_mail(self):
        rig = Rig({"render_jobs": [failed_job(5)]})
        rig.engine.control._token = ""
        self.assertEqual(rig.engine.tick().state, "not_configured")
        self.assertEqual(rig.transport.attempts, 0)


# -- who gets it -------------------------------------------------------------

class RecipientsTestCase(unittest.TestCase):
    def test_only_confirmed_owners_and_admins_of_the_roster_are_mailed(self):
        editor, viewer, invited, unconfirmed, banned, other = (f"3333333{i}-3333-4333-8333-333333333333" for i in range(6))
        roster = ROSTER + [
            {"user_id": editor, "role": "editor"}, {"user_id": viewer, "role": "viewer"},
            {"user_id": None, "role": "owner", "email": "invited@example.org"},
            {"user_id": unconfirmed, "role": "admin"}, {"user_id": banned, "role": "admin"},
            {"user_id": other, "role": "owner"}, {"user_id": "not-a-uuid", "role": "owner"}]
        auth = dict(AUTH) | {
            editor: {"id": editor, "email": "editor@example.org", "email_confirmed_at": "2026-01-01T00:00:00Z"},
            viewer: {"id": viewer, "email": CUSTOMER_ADDR, "email_confirmed_at": "2026-01-01T00:00:00Z"},
            unconfirmed: {"id": unconfirmed, "email": "unconfirmed@example.org", "email_confirmed_at": None},
            banned: {"id": banned, "email": "banned@example.org", "email_confirmed_at": "2026-01-01T00:00:00Z",
                     "banned_until": "2999-01-01T00:00:00Z"},
            other: {"id": OWNER, "email": "someone-else@example.org", "email_confirmed_at": "2026-01-01T00:00:00Z"},
        }
        rig = Rig({"render_jobs": [failed_job(5)]}, roster=roster, auth=auth)
        self.assertEqual(sorted(rig.directory.addresses()), [ADMIN_ADDR, OWNER_ADDR])
        # people who are not owner/admin are never even looked up
        self.assertNotIn(editor, rig.fetched)
        self.assertNotIn(viewer, rig.fetched)

    def test_the_roster_is_asked_for_ids_and_roles_never_for_the_typed_address(self):
        rig = Rig()
        rig.directory.addresses()
        reads = [p for table_name, p in rig.ops.sync.reads if table_name == "app_members"]
        self.assertTrue(reads)
        for params in reads:
            self.assertEqual(params["select"], "user_id,role,created_at")
            self.assertNotIn("email", params["select"])

    def test_each_mail_goes_to_one_address_only_and_to_nobody_else(self):
        rig = Rig({"render_jobs": []})
        rig.arm()
        rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
        rig.tick(minutes=1)
        self.assertEqual(sorted(m.to for m in rig.transport.sent), [ADMIN_ADDR, OWNER_ADDR])

    def test_a_malformed_address_is_refused(self):
        for bad in ("a@b", "x y@example.org", "<a>@example.org", "a@example.org\nBcc: x@example.org", "", None, 5):
            with self.subTest(bad=bad):
                auth = {OWNER: {"id": OWNER, "email": bad, "email_confirmed_at": "2026-01-01T00:00:00Z"}}
                rig = Rig(roster=[{"user_id": OWNER, "role": "owner"}], auth=auth)
                self.assertEqual(rig.directory.addresses(), [])

    def test_no_confirmed_owner_means_nothing_is_sent_and_nothing_is_used_up(self):
        rig = Rig({"render_jobs": [failed_job(5)]}, roster=[], auth={})
        rep = rig.engine.tick()
        self.assertEqual(rep.mail.state, "no_recipients")
        self.assertEqual(rig.transport.attempts, 0)
        # the first pass was not consumed: an owner appearing later gets the 'on' mail, not the history
        rig.ops.sync.tables["app_members"] = list(ROSTER)
        rig.auth.update(AUTH)
        rig.directory._cached = None
        rep = rig.engine.tick()
        self.assertTrue(rep.mail.baseline)
        self.assertEqual(len(rig.transport.sent), 2)

    def test_an_unreadable_roster_or_account_lookup_sends_nothing(self):
        rig = Rig({"render_jobs": []})
        rig.arm()
        rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
        rig.ops.sync.fail.add("app_members")
        rep = rig.tick(minutes=11)                  # the short-lived answer of the last read has expired
        self.assertEqual((rep.mail.state, rig.transport.attempts), ("no_recipients", 0))
        rig2 = Rig({"render_jobs": []})
        rig2.arm()
        rig2.ops.sync.tables["render_jobs"] = [failed_job(5)]
        rig2.auth.clear()
        rig2.tick(minutes=11)
        self.assertEqual(rig2.transport.attempts, 0)

    def test_the_recipient_is_never_taken_from_an_argument_or_an_environment_value(self):
        import inspect
        for fn in (owner_mail.OwnerMail.__init__, owner_mail.OwnerMail.from_env, owner_mail.OwnerMail.run,
                   owner_mail.render_alerts, owner_mail.render_digest):
            self.assertNotIn("recipient", " ".join(inspect.signature(fn).parameters).replace("recipients", ""))
        src = (ROOT / "modules" / "operator_bot" / "owner_mail.py").read_text()
        self.assertNotRegex(src, r"env\.get\(\"[A-Z_]*(TO|RECIPIENT|ADDRESS|EMAIL_TO)[A-Z_]*\"")
        self.assertNotIn("app_members.email", src.replace("``app_members.email``", ""))


# -- what is sent ------------------------------------------------------------

def scenarios():
    """(name, tables, expected subject in English, a fragment of the body)."""
    worker = healthy_tables()["worker_status"][0] | {"updated_at": ts(30)}
    return [
        ("run", {"render_jobs": [failed_job(5)]}, "Failed jobs", "Render job #5 failed"),
        ("stuck", {"render_jobs": [{"id": 2, "channel_id": "default", "status": "queued", "created_at": ts(45)}]},
         "Stuck jobs", "Render job #2 is stuck"),
        ("worker", {"worker_status": [worker]}, "CRITICAL · Worker problem", "lost its heartbeat"),
        ("payment_problem", {"payment_events": [paid(1, status="rejected")]}, "CRITICAL · Payment problem", "REJECTED"),
        ("payment_in", {"payment_events": [paid(2)]}, "Payment received", "12.50 USD"),
        ("signup", {"organizations": [{"id": "aaaaaaaa-0000-4000-8000-00000000000a", "created_at": ts(20)},
                                      {"id": "bbbbbbbb-0000-4000-8000-00000000000b", "created_at": ts(10)}]},
         "New accounts: 2", "New account"),
        ("marketing", {}, "CRITICAL · Poster problem", "do not resend"),
    ]


class KindsTestCase(unittest.TestCase):
    def run_scenario(self, tables, lang=None, rpcs=None):
        rig = Rig({k: v for k, v in tables.items()}, lang=lang)
        if rpcs:
            rig.ops.sync.rpcs.update(rpcs)
        # armed on a quiet system, then the event arrives
        stash = {k: rig.ops.sync.tables.get(k) for k in tables}
        for k in tables:
            rig.ops.sync.tables[k] = [] if k != "worker_status" else healthy_tables(rig.clock.now)["worker_status"]
        if rpcs:
            saved, rig.ops.sync.rpcs = dict(rig.ops.sync.rpcs), {}
        rig.arm()
        rig.pinned = "worker_status" in tables
        for k, v in stash.items():
            rig.ops.sync.tables[k] = v
        if rpcs:
            rig.ops.sync.rpcs = saved
        return rig

    def test_each_kind_sends_one_mail_with_a_short_subject_in_english(self):
        dead = {"ok": True, "counts": {k: 0 for k in ("draft", "approved", "sending", "sent", "failed", "dead",
                                                       "rejected", "expired")} | {"dead": 1},
                "used_7d": 0, "max_per_7d": 2, "enabled": True, "last_sent_at": None, "last_sent_kind": None,
                "last_failure": {"status": "dead", "last_error_code": "unconfirmed", "kind": "news", "at": ts(30)}}
        for name, tables, subject, fragment in scenarios():
            with self.subTest(kind=name):
                rpcs = {"operator_marketing_summary": dead} if name == "marketing" else None
                rig = self.run_scenario(tables, rpcs=rpcs)
                rep = rig.tick(minutes=1)
                one_each = [m for m in rig.transport.sent if m.to == OWNER_ADDR]
                self.assertEqual([m.subject for m in one_each], [subject], rep)
                body = one_each[0]
                self.assertIn(fragment, body.text)
                self.assertLessEqual(len(body.subject), 60)
                self.assertNotRegex(body.subject, r"[0-9]{4,}|…|#\d")
                self.assertGreaterEqual(rep.mail.sent, 1)
                # one mail for the kind, however many alerts it carries, and nothing else
                self.assertEqual(len(rig.transport.sent), 2)           # owner + admin

    def test_each_kind_in_russian_and_uzbek_uses_that_language_not_english(self):
        for lang in ("ru", "uz"):
            for name, tables, subject, fragment in scenarios():
                if name == "marketing":
                    continue
                with self.subTest(lang=lang, kind=name):
                    rig = self.run_scenario(tables, lang=lang)
                    rig.tick(minutes=1)
                    sent = [m for m in rig.transport.sent if m.to == OWNER_ADDR]
                    self.assertEqual(len(sent), 1)
                    self.assertNotEqual(sent[0].subject, subject)
                    self.assertNotIn(fragment, sent[0].text.replace("12.50 USD", ""))
                    group = {"payment_problem": "payment_problem", "payment_in": "payment_in"}.get(name, name)
                    expected = t(lang, f"ownermail.subject_{group}", n=2)
                    self.assertIn(expected, sent[0].subject)
                    self.assertIn(t(lang, "ownermail.reason"), sent[0].text)
                    self.assertIn(f'lang="{lang}"', sent[0].html)

    def test_every_group_has_a_subject_in_every_language(self):
        groups = set(owner_mail.MAIL_KINDS) | {"payment_in", "payment_problem"}
        groups.discard("payment")
        for lang in LANGUAGES:
            for g in groups:
                self.assertIn(f"ownermail.subject_{g}", table(lang), (lang, g))

    def test_text_and_html_carry_the_same_content_and_a_pause_footer_pointing_at_the_app(self):
        rig = self.run_scenario({"render_jobs": [failed_job(5)]})
        rig.tick(minutes=1)
        m = rig.transport.sent[0]
        self.assertIn("<html", m.html)
        self.assertIn("Render job #5 failed", m.html)
        self.assertIn("https://app.example.test/all-channels/alerts", m.text)
        self.assertIn("https://app.example.test/all-channels/alerts", m.html)
        self.assertIn("/alerts", m.text)
        self.assertIn("NIGHTSHIFT_OWNER_EMAIL", m.text)
        self.assertIn("https://app.example.test/all-channels/errors", m.text)       # the Open link of this kind

    def test_no_link_is_guessed_without_an_app_url(self):
        cfg = OperatorConfig(github_repo="owner/repo")
        rig = Rig({"render_jobs": []}, cfg=cfg)
        rig.arm()
        rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
        rig.tick(minutes=1)
        self.assertNotIn("http", rig.transport.sent[0].text)

    def test_the_first_pass_announces_no_history_and_sends_one_on_mail(self):
        rig = Rig({"render_jobs": [failed_job(5)], "payment_events": [paid(1, status="rejected")],
                   "organizations": [{"id": "aaaaaaaa-0000-4000-8000-00000000000a", "created_at": ts(20)}]})
        rep = rig.engine.tick()
        self.assertTrue(rep.mail.baseline)
        self.assertEqual({m.to for m in rig.transport.sent}, {OWNER_ADDR, ADMIN_ADDR})
        self.assertEqual({m.subject for m in rig.transport.sent}, {"Owner e-mail alerts are on"})
        rig.keep_worker_alive()
        rig.transport.sent.clear()
        rig.engine.tick()
        self.assertEqual(rig.transport.sent, [])            # history was marked seen

    def test_kinds_that_are_not_selected_are_not_mailed(self):
        rig = Rig({"render_jobs": []}, kinds=frozenset({"payment"}))
        rig.arm()
        rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
        rig.ops.sync.tables["payment_events"] = [paid(1, status="rejected")]
        rig.tick(minutes=1)
        self.assertEqual({m.subject for m in rig.transport.sent}, {"CRITICAL · Payment problem"})

    def test_information_only_alerts_are_not_mailed(self):
        rig = Rig({"publish_approvals": []})
        rig.arm()
        rig.ops.sync.tables["publish_approvals"] = [{"id": "p1", "channel_id": "default", "status": "pending",
                                                     "requested_at": ts(5)}]
        rig.tick(minutes=1)
        self.assertEqual(rig.transport.sent, [])


# -- restraint ---------------------------------------------------------------

class RestraintTestCase(unittest.TestCase):
    def test_the_same_event_is_mailed_once(self):
        rig = Rig({"render_jobs": []})
        rig.arm()
        rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
        rig.tick(minutes=1)
        self.assertEqual(len(rig.transport.sent), 2)
        for _ in range(4):
            rep = rig.tick(minutes=5)
            self.assertEqual(rep.mail.sent, 0)
        self.assertEqual(len(rig.transport.sent), 2)
        self.assertGreater(rep.mail.deduped, 0)

    def test_a_standing_condition_repeats_only_after_its_cooldown(self):
        worker = healthy_tables()["worker_status"][0] | {"updated_at": ts(30)}
        rig = Rig({"worker_status": healthy_tables()["worker_status"]})
        rig.arm()
        rig.ops.sync.tables["worker_status"] = [worker | {"updated_at": ts(30, rig.clock.now)}]
        n = lambda: len(rig.transport.sent)                                    # noqa: E731
        rig.clock.advance(minutes=1)
        rig.engine.tick()
        self.assertEqual(n(), 2)
        for _ in range(3):
            rig.clock.advance(minutes=30)
            rig.ops.sync.tables["worker_status"] = [worker | {"updated_at": ts(45, rig.clock.now)}]
            rig.engine.tick()
        self.assertEqual(n(), 2)                                               # inside the 3 h cooldown
        rig.clock.advance(hours=3)
        rig.ops.sync.tables["worker_status"] = [worker | {"updated_at": ts(45, rig.clock.now)}]
        rig.engine.tick()
        self.assertEqual(n(), 4)

    def test_quiet_hours_hold_the_ordinary_and_let_the_critical_through_then_release(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", quiet_hours=(10, 14))
        rig = Rig({"render_jobs": []}, cfg=cfg)
        rig.arm()
        rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
        rig.ops.sync.tables["payment_events"] = [paid(1, status="rejected")]
        rep = rig.tick(minutes=1)
        self.assertEqual((rep.mail.sent, rep.mail.quiet_held), (1, 1))
        self.assertEqual({m.subject for m in rig.transport.sent}, {"CRITICAL · Payment problem"})
        rig.transport.sent.clear()
        rig.clock.advance(hours=3)                                              # 15:00, the window is over
        rig.ops.sync.tables["render_jobs"] = [failed_job(5, minutes_ago=30)]
        rig.tick()
        self.assertEqual({m.subject for m in rig.transport.sent}, {"Failed jobs"})

    def test_a_muted_kind_is_not_mailed_and_is_not_announced_when_the_mute_ends(self):
        rig = Rig({"render_jobs": []})
        rig.arm()
        alerts.mute(rig.store, "run", rig.clock.now)
        rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
        rep = rig.tick(minutes=1)
        self.assertEqual((rep.mail.muted, rig.transport.attempts), (1, 0))
        rig.clock.advance(hours=25)
        rig.ops.sync.tables["render_jobs"] = [failed_job(5, minutes_ago=30)]
        rig.tick()
        self.assertEqual(rig.transport.attempts, 0)

    def test_the_hourly_cap_holds_the_rest_and_critical_has_its_own_budget(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", max_alerts_per_hour=2)
        rig = Rig({"render_jobs": []}, cfg=cfg)
        rig.arm()
        rig.ops.sync.tables["render_jobs"] = [failed_job(i) for i in range(1, 6)]
        rig.ops.sync.tables["payment_events"] = [paid(1, status="rejected")]
        rep = rig.tick(minutes=1)
        self.assertEqual(rep.mail.rate_held, 3)
        subjects_ = {m.subject for m in rig.transport.sent}
        self.assertEqual(subjects_, {"CRITICAL · Payment problem", "Failed jobs"})
        failed = [m for m in rig.transport.sent if m.subject == "Failed jobs" and m.to == OWNER_ADDR][0]
        self.assertEqual(failed.text.count("Render job #"), 2)
        rig.transport.sent.clear()
        rig.tick(minutes=5)
        self.assertEqual(rig.transport.sent, [])                                # still the same hour
        rig.tick(minutes=61)
        self.assertEqual(len({m.subject for m in rig.transport.sent}), 1)       # the held ones go out after it

    def test_a_long_list_is_cut_in_the_mail_not_dropped_silently(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", max_alerts_per_hour=60)
        rig = Rig({"render_jobs": []}, cfg=cfg)
        rig.arm()
        rig.ops.sync.tables["render_jobs"] = [failed_job(i) for i in range(1, 16)]
        rig.tick(minutes=1)
        m = [x for x in rig.transport.sent if x.to == OWNER_ADDR][0]
        self.assertEqual(m.text.count("Render job #"), owner_mail.MAX_LINES)
        self.assertIn("+5 more", m.text)

    def test_the_telegram_side_is_untouched_by_the_mail_side(self):
        rig = Rig({"render_jobs": []})
        rig.arm()
        rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
        before = len(rig.tg.sent())
        rep = rig.tick(minutes=1)
        self.assertEqual(rep.sent, 1)
        self.assertEqual(len(rig.tg.sent()), before + 1)
        telegram_rows = [r for r in rig.store.rows if r["kind"] == "operator.alert" and r["title"] == "run:5"]
        self.assertEqual(len(telegram_rows), 1)
        self.assertTrue(all(r["kind"] != "operator.alert" for r in rig.store.rows if r["kind"] == "operator.mail"))


# -- failure -----------------------------------------------------------------

class FailureTestCase(unittest.TestCase):
    def failing(self, error, armed=True):
        """A system that is armed (the 'on' mail went out), then the provider starts failing and a job fails."""
        rig = Rig({"render_jobs": []})
        rig.arm()
        rig.transport.fail = error
        rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
        return rig

    def owner_mails(self, rig):
        return [m for m in rig.transport.sent if m.to == OWNER_ADDR]

    def test_a_failing_provider_never_stops_the_telegram_alert_or_raises(self):
        for error in (mail.TransportError("http_500"), RuntimeError("boom with secret " + API_KEY),
                      mail.TransportError("http_422", permanent=True), mail.TransportError("http_403", permanent=True),
                      ConnectionError("down")):
            with self.subTest(error=type(error).__name__):
                rig = self.failing(error)
                rep = rig.tick(minutes=1)
                self.assertEqual(rep.sent, 1)                                    # Telegram still told the owner
                self.assertEqual(rep.mail.sent, 0)
                self.assertIsNotNone(rep.mail.failing)

    def test_503_three_passes_then_recovery_delivers_exactly_once(self):
        rig = self.failing(mail.TransportError("http_503"))
        attempts = []
        for _ in range(3):                                   # the provider stays down through three backed-off passes
            rig.tick(minutes=1)
            attempts.append(rig.transport.attempts)
            rig.clock.advance(minutes=60)                    # past the sink backoff and the per-alert spacing
        self.assertEqual(rig.transport.attempts, 6)          # one try per pass (to both owners): the first failed group ends the pass
        rig.transport.fail = None
        rig.tick(minutes=1)
        self.assertEqual(len(self.owner_mails(rig)), 1)
        self.assertEqual(self.owner_mails(rig)[0].subject, "Failed jobs")
        for _ in range(6):
            rig.tick(minutes=20)
        self.assertEqual(len(self.owner_mails(rig)), 1)      # never twice

    def test_retries_in_a_storm_are_bounded_by_backoff_per_alert_window_and_hour(self):
        rig = self.failing(mail.TransportError("http_503"))
        for _ in range(48):                                  # four hours of five-minute passes
            rig.tick(minutes=5)
        # the sink backs off 5, 10, 20, 40, 60 minutes: a handful of tries, never one per pass
        self.assertLessEqual(rig.transport.attempts, 2 * 8)
        self.assertGreaterEqual(rig.transport.attempts, 2)

    def test_the_sink_backs_off_after_a_failure_and_a_pass_inside_it_sends_nothing(self):
        rig = self.failing(mail.TransportError("http_503"))
        rig.tick(minutes=1)
        first = rig.transport.attempts
        rep = rig.tick(minutes=2)
        self.assertEqual((rep.mail.state, rig.transport.attempts), ("backoff", first))

    def test_a_refused_key_403_marks_no_alert_and_the_fixed_key_delivers_at_the_next_pass(self):
        rig = self.failing(mail.TransportError("http_403", permanent=True))
        rig.tick(minutes=1)
        rows = [r for r in rig.store.rows if r["kind"] == "operator.mail"]
        self.assertEqual({r["title"] for r in rows} - {"mail:baseline", "mail:armed", "run:5"}, {"mail:sink"})
        self.assertNotIn("run:5", {r["title"] for r in rows if r["body"].endswith(":retry")})   # no per-alert row for a config problem
        self.assertFalse([r for r in rows if r["body"].endswith(":dead")])
        rig.transport.fail = None                            # the owner fixed the key
        rig.tick(minutes=6)                                  # past the 5-minute backoff
        self.assertEqual(len(self.owner_mails(rig)), 1)
        self.assertEqual(self.owner_mails(rig)[0].subject, "Failed jobs")

    def test_a_permanent_refusal_that_is_not_about_the_key_is_bounded_per_window_then_rearmed(self):
        rig = self.failing(mail.TransportError("http_422", permanent=True))
        for _ in range(20):
            rig.tick(minutes=20)                             # ~6.7 hours
        # at most MAX_ATTEMPTS per 3-hour window for the one alert (2 owners each), then it is tried again
        self.assertLessEqual(rig.transport.attempts, 2 * owner_mail.MAX_ATTEMPTS * 3)
        self.assertGreater(rig.transport.attempts, 2 * owner_mail.MAX_ATTEMPTS)

    def test_the_on_mail_is_retried_until_it_has_gone_out_once(self):
        rig = Rig({"render_jobs": []}, transport=RecordingTransport(fail=mail.TransportError("http_503")))
        rep = rig.engine.tick()
        self.assertTrue(rep.mail.baseline)
        self.assertEqual(rig.transport.sent, [])
        for _ in range(4):
            rig.tick(minutes=61)
        self.assertEqual(rig.transport.sent, [])
        rig.transport.fail = None
        rig.tick(minutes=61)
        self.assertEqual({m.subject for m in rig.transport.sent}, {"Owner e-mail alerts are on"})
        sent = len(rig.transport.sent)
        for _ in range(4):
            rig.tick(minutes=61)
        self.assertEqual(len(rig.transport.sent), sent)      # once it went out it is not sent again
        # and the history was not announced
        self.assertEqual({m.subject for m in rig.transport.sent}, {"Owner e-mail alerts are on"})

    def test_a_ledger_that_cannot_be_written_does_not_cause_a_resend(self):
        rig = Rig({"render_jobs": []})
        rig.arm()
        rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
        rig.store.fail_write = True
        for _ in range(6):
            rig.tick(minutes=5)
        self.assertEqual(len(self.owner_mails(rig)), 1)

    def test_a_ledger_that_cannot_be_read_sends_nothing(self):
        rig = Rig({"render_jobs": []})
        rig.arm()
        rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
        rig.store.fail_load = True
        rep = rig.tick(minutes=1)
        self.assertEqual((rep.state, rig.transport.attempts), ("no_state", 0))

    def test_an_unreadable_mail_marker_does_not_stop_telegram_and_sends_no_mail(self):
        rig = Rig({"render_jobs": []})
        rig.arm()
        rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
        rig.store.fail_mail_marker = True
        rep = rig.tick(minutes=1)
        self.assertEqual((rep.sent, rep.mail.state, rig.transport.attempts), (1, "unknown", 0))

    def test_the_marker_read_happens_only_while_the_sink_is_on_and_a_failure_of_it_is_not_fatal_for_the_real_store(self):
        from modules.operator_bot.store import SupabaseAlertStore
        from modules.supabase_sync import SupabaseReadError
        rig = Rig({"render_jobs": []})
        store = SupabaseAlertStore(rig.ops.sync)
        state = store.load(rig.clock.now)
        self.assertIsNotNone(state)
        self.assertFalse([1 for t_, p in rig.ops.sync.reads if p.get("kind") == "eq.operator.mail"])   # off: not read
        state = store.load(rig.clock.now, mail=True)
        self.assertTrue([1 for t_, p in rig.ops.sync.reads if p.get("kind") == "eq.operator.mail"])
        self.assertTrue(state.mail_state_known)
        real = rig.ops.sync.select_strict

        def failing(table, params=None):
            if (params or {}).get("kind") == "eq.operator.mail":
                raise SupabaseReadError(table, 500, "")
            return real(table, params)

        rig.ops.sync.select_strict = failing
        state = store.load(rig.clock.now, mail=True)
        self.assertIsNotNone(state)                           # the rest of the state still loads
        self.assertFalse(state.mail_state_known)

    def test_a_bug_inside_the_sink_is_contained(self):
        rig = Rig({"render_jobs": []})
        rig.arm()
        rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
        rig.mailer._run = lambda *a, **k: 1 / 0
        rep = rig.tick(minutes=1)
        self.assertEqual(rep.sent, 1)
        self.assertEqual(rep.mail.state, "error")

    def test_the_resend_transport_error_paths_carry_a_code_and_never_the_key_or_an_address(self):
        class Session:
            def __init__(self, status=None):
                self.status, self.posted = status, []

            def post(self, url, json=None, headers=None, timeout=None):
                self.posted.append((url, json, headers))
                return type("R", (), {"status_code": self.status})()

        for status in (500, 429, 422, 403, 401):
            session = Session(200)
            sender = mail.ResendTransport(API_KEY, "Nightshift <hello@example.org>", session=session)
            rig = Rig({"render_jobs": []}, transport=sender)
            rig.arm()
            session.status = status
            session.posted.clear()
            rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
            with self.assertLogs(level="INFO") as cap:
                logging.getLogger("probe").info("x")
                rig.tick(minutes=1)
            out = "\n".join(cap.output)
            self.assertNotIn(API_KEY, out)
            self.assertNotIn(OWNER_ADDR, out)
            self.assertNotIn(ADMIN_ADDR, out)
            self.assertIn(f"http_{status}", out)
            for _url, body, _headers in session.posted:
                self.assertNotIn(API_KEY, str(body))
                self.assertEqual(len(body["to"]), 1)                              # never a list of owners in one mail
            self.assertEqual(len(session.posted), 2)                              # one pass: one try per owner, then it stops

    def test_the_key_is_only_ever_in_the_authorization_header(self):
        class Session:
            def __init__(self):
                self.posted = []

            def post(self, url, json=None, headers=None, timeout=None):
                self.posted.append((url, json, headers))
                return type("R", (), {"status_code": 200})()

        session = Session()
        rig = Rig({"render_jobs": []}, transport=mail.ResendTransport(API_KEY, "N <h@example.org>", session=session))
        rig.arm()
        rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
        rig.tick(minutes=1)
        for _url, body, headers in session.posted:
            self.assertNotIn(API_KEY, str(body))
            self.assertEqual(headers["Authorization"], f"Bearer {API_KEY}")


class OutageVisibilityTestCase(unittest.TestCase):
    def outage(self):
        rig = Rig({"render_jobs": []})
        rig.arm()
        rig.transport.fail = mail.TransportError("http_503")
        rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
        return rig

    def telegram_notes(self, rig):
        return [x for x in rig.tg.texts() if "Owner e-mail is failing" in x or "owner e-mail" in x.lower()]

    def test_one_telegram_note_per_outage_per_day_with_a_closed_code_and_nothing_secret(self):
        rig = self.outage()
        for _ in range(30):
            rig.tick(minutes=61)                  # backed-off tries accumulate failures
        notes = [x for x in rig.tg.texts() if "Owner e-mail is failing: http_503" in x]
        days = {rig.clock.now.date()}
        self.assertGreaterEqual(len(notes), 1)
        self.assertLessEqual(len(notes), 2)       # 30 hours of outage: at most one per local date
        for x in rig.tg.texts():
            self.assertNotIn(API_KEY, x)
            self.assertNotIn(OWNER_ADDR, x)
        self.assertTrue(days)

    def test_a_single_failure_is_not_yet_an_outage(self):
        rig = self.outage()
        rig.tick(minutes=1)
        self.assertEqual(self.telegram_notes(rig), [])

    def test_the_note_follows_the_alert_rules_mute_and_it_is_info_only(self):
        rig = self.outage()
        alerts.mute(rig.store, "email", rig.clock.now)
        for _ in range(6):
            rig.tick(minutes=61)
        self.assertEqual([x for x in rig.tg.texts() if "Owner e-mail is failing" in x], [])

    def test_alerts_shows_the_mail_state(self):
        from modules.operator_bot import views
        rig = Rig({"render_jobs": []})
        self.assertNotIn("Owner e-mail", views.view_alerts(rig.ops.cfg, rig.store.load(rig.clock.now), rig.clock.now, "en").text)
        rig.arm()
        self.assertIn("Owner e-mail: working", views.view_alerts(rig.ops.cfg, rig.store.load(rig.clock.now), rig.clock.now, "en").text)
        rig.transport.fail = mail.TransportError("http_503")
        rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
        rig.tick(minutes=1)
        text = views.view_alerts(rig.ops.cfg, rig.store.load(rig.clock.now), rig.clock.now, "en").text
        self.assertIn("Owner e-mail: FAILING (http_503)", text)
        for lang, word in (("ru", "СБОЙ"), ("uz", "NOSOZ")):
            self.assertIn(word, views.view_alerts(rig.ops.cfg, rig.store.load(rig.clock.now), rig.clock.now, lang).text)

    def test_the_recovery_clears_the_failing_state(self):
        rig = self.outage()
        for _ in range(3):
            rig.tick(minutes=61)
        rig.transport.fail = None
        rig.tick(minutes=61)
        state = rig.store.load(rig.clock.now)
        self.assertEqual(state.mail_health()[0], "ok")


# -- privacy -----------------------------------------------------------------

class PrivacyTestCase(unittest.TestCase):
    def tables(self):
        return {
            "render_jobs": [failed_job(5) | {"params": {"topic": CUSTOMER_NAME}, "error": f"{CUSTOMER_ADDR} failed",
                                             "email": CUSTOMER_ADDR, "owner_name": CUSTOMER_NAME}],
            "organizations": [{"id": "aaaaaaaa-0000-4000-8000-00000000000a", "created_at": ts(20),
                               "name": CUSTOMER_NAME, "slug": "zebulon", "owner_email": CUSTOMER_ADDR}],
            "payment_events": [paid(1) | {"customer_email": CUSTOMER_ADDR, "customer_name": CUSTOMER_NAME,
                                          "detail": f"{CUSTOMER_NAME} <{CUSTOMER_ADDR}>", "organization_id": "org-secret"},
                               paid(2, status="rejected") | {"customer_email": CUSTOMER_ADDR}],
        }

    def test_no_customer_name_or_address_reaches_any_alert_mail(self):
        rig = Rig({"render_jobs": [], "organizations": [], "payment_events": []})
        rig.arm()
        rig.ops.sync.tables.update(self.tables())
        rig.tick(minutes=1)
        self.assertGreaterEqual(len(rig.transport.sent), 6)
        for text in rig.transport.texts():
            for leak in (CUSTOMER_ADDR, CUSTOMER_NAME, "zebulon", "Zebulon", "org-secret", "customer-mail.test"):
                self.assertNotIn(leak, text)
        for m in rig.transport.sent:
            self.assertIn(m.to, (OWNER_ADDR, ADMIN_ADDR))

    def test_no_customer_name_or_address_reaches_the_digest(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", digest_hour=8)
        rig = Rig({"render_jobs": []}, cfg=cfg)
        rig.arm()
        rig.ops.sync.tables.update(self.tables())
        rig.tick(minutes=1)
        digest = [m for m in rig.transport.sent if m.subject.startswith("Daily digest")]
        self.assertEqual(len(digest), 2)
        for m in digest:
            for leak in (CUSTOMER_ADDR, CUSTOMER_NAME, "zebulon", "org-secret"):
                self.assertNotIn(leak, m.subject + m.text + m.html)

    def test_the_sources_never_select_a_customer_column(self):
        rig = Rig({"render_jobs": []}, cfg=OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo",
                                                           digest_hour=8))
        rig.arm()
        rig.ops.sync.tables.update(self.tables())
        rig.tick(minutes=1)
        for table_name, params in rig.ops.sync.reads:
            selected = params.get("select", "")
            for column in ("email", "name", "slug", "detail", "customer", "organization_id", "params", "error", "owner"):
                if table_name in ("organizations", "payment_events", "render_jobs", "creative_jobs", "app_members"):
                    self.assertNotRegex(selected, rf"\b{column}\b", (table_name, selected))

    def test_a_dynamic_line_is_escaped_scrubbed_and_cannot_inject_markup_or_headers(self):
        nasty = alerts.Alert("run", "run:1", "warn",
                             '<img src=x onerror=alert(1)> &amp; "q" <b>bold</b> &lt;script&gt;alert(2)&lt;/script&gt; ' + CUSTOMER_ADDR +
                             " Bearer abcdefghijklmnopqrstuvwxyz0123456789 sk-abcdefghijklmnopqrstuvwxyz")
        cfg = OperatorConfig(app_url="https://app.example.test")
        m = owner_mail.render_alerts("en", cfg, "run", [nasty], OWNER_ADDR)
        self.assertNotIn("<img", m.html)
        self.assertNotIn("<script>", m.html)
        self.assertIn("&lt;script&gt;alert(2)&lt;/script&gt;", m.html)
        self.assertNotIn("<b>bold", m.html)
        self.assertNotIn("onerror=alert(1)>", m.html)
        for text in (m.text, m.html, m.subject):
            self.assertNotIn(CUSTOMER_ADDR, text)
            self.assertNotIn("abcdefghijklmnopqrstuvwxyz0123456789", text)
            self.assertNotIn("sk-abcdefghijklmnopqrstuvwxyz", text)
        self.assertNotRegex(m.subject, r"[\r\n]")

    def test_a_subject_carries_no_id_amount_or_name_for_any_group(self):
        cfg = OperatorConfig(app_url="https://app.example.test")
        line = "Payment event …abcd1234 REJECTED (payment, 12.50 USD) Zebulon Customerson"
        for group in ("payment_in", "payment_problem", "run", "stuck", "worker", "deploy", "marketing", "balance",
                      "audit", "approval", "signup"):
            for lang in LANGUAGES:
                with self.subTest(group=group, lang=lang):
                    a = alerts.Alert(group.split("_")[0], "k:1", "critical", line)
                    m = owner_mail.render_alerts(lang, cfg, group, [a], OWNER_ADDR)
                    self.assertNotRegex(m.subject, r"12\.50|abcd1234|Zebulon|USD")
                    self.assertLessEqual(len(m.subject), 80)

    def test_nothing_in_a_mail_or_a_log_is_the_service_key_or_the_mail_key(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", digest_hour=8)
        rig = Rig({"render_jobs": []}, cfg=cfg)
        with self.assertLogs(level="DEBUG") as cap:
            logging.getLogger("probe").info("x")
            rig.arm()
            rig.ops.sync.tables.update(self.tables())
            rig.tick(minutes=1)
        out = "\n".join(cap.output) + "\n".join(rig.transport.texts())
        for secret in (API_KEY, "SERVICE-KEY", "123456:TESTTOKEN"):
            self.assertNotIn(secret, out)
        for address in (OWNER_ADDR, ADMIN_ADDR, CUSTOMER_ADDR):
            self.assertNotIn(address, "\n".join(cap.output))


# -- the daily digest --------------------------------------------------------

DIGEST_CFG = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", digest_hour=8)


def yesterday(hour=10, minute=0):
    return (NOW - timedelta(days=1)).replace(hour=hour, minute=minute).strftime("%Y-%m-%dT%H:%M:%SZ")


class DigestTestCase(unittest.TestCase):
    def rig(self, **kw):
        rig = Rig(kw.pop("tables", {"render_jobs": []}), cfg=kw.pop("cfg", DIGEST_CFG), **kw)
        rig.arm()
        return rig

    def digests(self, rig):
        return [m for m in rig.transport.sent if m.subject.startswith(("Daily digest", "Дайджест", "Kunlik xulosa"))]

    def test_one_digest_a_day_at_the_owners_hour_and_never_before_it(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", digest_hour=14)
        rig = self.rig(cfg=cfg)
        rig.tick(minutes=1)
        self.assertEqual(self.digests(rig), [])                                  # 12:01, not yet
        rig.tick(hours=2)                                                        # 14:01
        self.assertEqual(sorted(m.to for m in self.digests(rig)), [ADMIN_ADDR, OWNER_ADDR])
        for _ in range(5):
            rig.tick(minutes=10)
        self.assertEqual(len(self.digests(rig)), 2)                              # once per local date
        rig.tick(hours=24)                                                       # the next day
        self.assertEqual(len(self.digests(rig)), 4)

    def test_no_digest_without_a_configured_hour(self):
        rig = self.rig(cfg=OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo"))
        rig.tick(hours=30)
        self.assertEqual(self.digests(rig), [])

    def test_a_digest_inside_quiet_hours_waits_for_the_window_to_end(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", digest_hour=8,
                             quiet_hours=(10, 14))
        rig = self.rig(cfg=cfg)
        rig.tick(minutes=1)
        self.assertEqual(self.digests(rig), [])
        rig.tick(hours=2)
        self.assertEqual(len(self.digests(rig)), 2)

    def test_yesterdays_numbers_and_only_yesterdays(self):
        tables = {
            "render_jobs": [],
            "payment_events": [
                paid(1, 1250) | {"received_at": yesterday(9)}, paid(2, 2000) | {"received_at": yesterday(15)},
                paid(3, 99900) | {"received_at": ts(60)},                                       # today: not counted
                paid(4, status="rejected") | {"received_at": yesterday(11)},
                paid(5, 500, etype="adjustment.updated") | {"received_at": yesterday(12)}],
            "organizations": [{"id": "a0000000-0000-4000-8000-000000000001", "created_at": yesterday(8)},
                              {"id": "a0000000-0000-4000-8000-000000000002", "created_at": yesterday(20)},
                              {"id": "a0000000-0000-4000-8000-000000000003", "created_at": ts(30)}],
            "system_events": [
                {"event": "render.completed", "video_id": "v1", "ts": yesterday(9)},
                {"event": "render.completed", "video_id": "v2", "ts": yesterday(10)},
                {"event": "video.published", "video_id": "v1", "ts": yesterday(11)},
                {"event": "publish.held", "video_id": "v2", "ts": yesterday(11)},
                {"event": "render.failed", "video_id": "v3", "ts": yesterday(12)},
                {"event": "render.completed", "video_id": "v9", "ts": ts(5)}],
            "creative_job_costs": [{"provider": "x", "usd_estimate": 1.5, "recorded_at": yesterday(9)},
                                   {"provider": "x", "usd_estimate": 0.5, "recorded_at": yesterday(10)},
                                   {"provider": "x", "usd_estimate": 40, "recorded_at": ts(10)}],
        }
        rig = self.rig(tables=tables)
        rig.ops.sync.tables.update(tables)
        rig.tick(minutes=1)
        m = [x for x in self.digests(rig) if x.to == OWNER_ADDR][0]
        self.assertEqual(m.subject, "Daily digest 2026-10-13")
        self.assertIn("Payments received: 32.50 USD (2 payments)", m.text)
        self.assertIn("rejected 1", m.text)
        self.assertIn("refunds or chargebacks 1", m.text)
        self.assertIn("New accounts (organizations created): 2", m.text)
        self.assertIn("Videos: made 2 · published 1 · held 1 · failed 1", m.text)
        self.assertIn("Provider cost estimate: $2.00", m.text)
        self.assertIn("1 payment(s) rejected in the last 7 days", m.text)
        self.assertNotIn("999.00", m.text)
        self.assertNotIn("$40", m.text)

    def test_an_unpriced_cost_row_makes_the_spend_an_at_least_never_a_total(self):
        tables = {"render_jobs": [], "creative_job_costs": [
            {"provider": "x", "usd_estimate": 1.5, "recorded_at": yesterday(9)},
            {"provider": "x", "usd_estimate": None, "recorded_at": yesterday(10)}]}
        rig = self.rig(tables=tables)
        rig.ops.sync.tables.update(tables)
        rig.tick(minutes=1)
        m = self.digests(rig)[0]
        self.assertIn("at least $1.50", m.text)
        self.assertIn("unpriced", m.text)

    def test_a_payment_without_an_amount_makes_the_total_an_at_least_and_never_zero(self):
        tables = {"render_jobs": [], "payment_events": [
            paid(1, 1250) | {"received_at": yesterday(9)},
            paid(2) | {"received_at": yesterday(10), "amount_minor": None}]}
        rig = self.rig(tables=tables)
        rig.ops.sync.tables.update(tables)
        rig.tick(minutes=1)
        text = self.digests(rig)[0].text
        self.assertIn("at least 12.50 USD", text)
        self.assertIn("not a total", text)

    def test_all_payments_without_amount_say_the_amount_is_unknown(self):
        tables = {"render_jobs": [], "payment_events": [paid(1) | {"received_at": yesterday(9), "amount_minor": None}]}
        rig = self.rig(tables=tables)
        rig.ops.sync.tables.update(tables)
        rig.tick(minutes=1)
        text = self.digests(rig)[0].text
        self.assertIn("amount unknown", text)
        self.assertNotIn("0.00", text)

    def test_a_source_that_cannot_answer_is_unknown_and_nothing_needs_attention_is_not_claimed(self):
        rig = self.rig()
        rig.ops.sync.fail.update({"payment_events", "organizations"})
        rig.tick(minutes=1)
        text = self.digests(rig)[0].text
        self.assertIn("Payments: unknown", text)
        self.assertIn("New accounts: unknown", text)
        self.assertIn("Could not check: payments", text)
        self.assertNotIn("Nothing needs attention", text)

    def test_when_everything_is_fine_it_says_so(self):
        rig = self.rig()
        rig.ops.sync.tables["videos"] = []
        rig.tick(minutes=1)
        text = self.digests(rig)[0].text
        self.assertIn("Payments received: none", text)
        self.assertIn("New accounts (organizations created): 0", text)
        self.assertIn("Nothing needs attention.", text)

    def test_what_needs_a_person_is_listed(self):
        tables = {"render_jobs": [failed_job(5, minutes_ago=60 * 24 + 120) | {"finished_at": yesterday(9)}],
                  "payment_events": [paid(1, status="rejected") | {"received_at": ts(60 * 24 * 3)}]}
        rig = self.rig(tables=tables)
        rig.ops.sync.tables.update(tables)
        rig.ops.sync.tables["videos"] = [{"video_id": "v1", "channel_id": "c", "publish_state": "held",
                                          "held_at": ts(100)}]
        rig.tick(minutes=1)
        text = self.digests(rig)[0].text
        self.assertIn("1 video(s) held for your review", text)
        self.assertIn("1 payment(s) rejected", text)
        self.assertIn("1 job(s) failed yesterday", text)

    def test_the_digest_follows_the_owners_language_and_timezone(self):
        from zoneinfo import ZoneInfo
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", digest_hour=8,
                             tz=ZoneInfo("Asia/Tashkent"))
        for lang, head in (("ru", "Дайджест за день 2026-10-13"), ("uz", "Kunlik xulosa 2026-10-13")):
            rig = self.rig(cfg=cfg, lang=lang)
            rig.tick(minutes=1)
            m = self.digests(rig)[0]
            self.assertEqual(m.subject, head)
            self.assertNotIn("Needs attention", m.text)
            self.assertIn("Asia/Tashkent", m.text)

    def test_a_failed_digest_is_retried_a_bounded_number_of_times(self):
        rig = self.rig()
        rig.transport.fail = mail.TransportError("http_503")
        for _ in range(40):
            rig.tick(minutes=5)
        # the sink backs off 5, 10, 20, 40, 60 minutes: five or six tries in 200 minutes, each to two owners
        self.assertLessEqual(rig.transport.attempts, 2 * 6)
        self.assertGreaterEqual(rig.transport.attempts, 2)

    def test_every_digest_key_exists_in_every_language(self):
        src = (ROOT / "modules" / "operator_bot" / "owner_digest.py").read_text()
        keys = set(re.findall(r'"(ownermail\.[a-z_]+)"', src)) | set(
            re.findall(r'"(ownermail\.[a-z_]+)"', (ROOT / "modules" / "operator_bot" / "owner_mail.py").read_text()))
        self.assertGreater(len(keys), 25)
        for lang in LANGUAGES:
            self.assertEqual(sorted(k for k in keys if k not in table(lang)), [], lang)


# -- the ledger --------------------------------------------------------------

class LedgerTestCase(unittest.TestCase):
    def test_rows_that_carry_a_channel_are_not_the_bots_and_forge_nothing(self):
        forged = [{"at": ts(1), "kind": "operator.mail", "title": "mail:baseline", "body": "baseline:seen",
                   "channel_id": "some-channel", "severity": "info"},
                  {"at": ts(1), "kind": "operator.mail", "title": "run:5", "body": "run:sent", "channel_id": "c",
                   "severity": "warn"}]
        state = replay(forged, NOW)
        self.assertEqual((state.mails, state.mail_baseline_seen), ([], False))

    def test_a_row_with_an_unknown_outcome_is_ignored(self):
        state = replay([{"at": ts(1), "kind": "operator.mail", "title": "run:5", "body": "run:shipped",
                         "channel_id": None, "severity": "warn"}], NOW)
        self.assertEqual(state.mails, [])

    def test_the_baseline_marker_is_remembered_at_any_age(self):
        rig = Rig({"render_jobs": []})
        rig.arm()
        rig.tick(hours=100)
        self.assertEqual(rig.transport.sent, [])                                  # no second 'on' mail after four days
        old = [r | {"at": ts(60 * 24 * 10)} for r in rig.store.rows if r["title"] == "mail:baseline"]
        self.assertTrue(replay(old, NOW, mail_baseline_seen=True).mail_baseline_seen)

    def test_the_mail_ledger_is_the_only_new_kind_of_row_and_has_no_address_in_it(self):
        rig = Rig({"render_jobs": []})
        rig.arm()
        rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
        rig.tick(minutes=1)
        rows = [r for r in rig.store.rows if r["kind"] == "operator.mail"]
        self.assertTrue(rows)
        for r in rows:
            self.assertNotRegex(str(r), r"@")
            self.assertIsNone(r.get("channel_id"))


# -- language ----------------------------------------------------------------

class CopyTestCase(unittest.TestCase):
    def test_the_owner_mail_words_are_in_the_three_copy_tables_with_the_same_keys(self):
        en = {k for k in table("en") if k.startswith("ownermail.")}
        self.assertGreater(len(en), 40)
        for lang in LANGUAGES:
            self.assertEqual({k for k in table(lang) if k.startswith("ownermail.")}, en, lang)


class BudgetsTestCase(unittest.TestCase):
    def test_six_signups_cannot_hold_back_a_failed_job(self):
        orgs = [{"id": f"aaaaaaaa-0000-4000-8000-00000000000{i}", "created_at": ts(30 - i)} for i in range(6)]
        rig = Rig({"render_jobs": [], "organizations": []})
        rig.arm()
        rig.ops.sync.tables["organizations"] = orgs
        rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
        rep = rig.tick(minutes=1)
        subjects_ = {m.subject for m in rig.transport.sent}
        self.assertIn("Failed jobs", subjects_)                                   # the problem got through
        news = [m for m in rig.transport.sent if m.subject.startswith("New accounts") and m.to == OWNER_ADDR]
        self.assertEqual([m.subject for m in news], [f"New accounts: {owner_mail.MAX_INFO_PER_HOUR}"])
        self.assertEqual(rep.mail.rate_held, 6 - owner_mail.MAX_INFO_PER_HOUR)
        rig.transport.sent.clear()
        rig.tick(minutes=61)                                                      # the rest of the news the next hour
        self.assertEqual({m.subject for m in rig.transport.sent}, {f"New accounts: {owner_mail.MAX_INFO_PER_HOUR}"})

    def test_a_flood_of_problems_cannot_hold_back_the_news_either(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", max_alerts_per_hour=2)
        rig = Rig({"render_jobs": [], "organizations": []}, cfg=cfg)
        rig.arm()
        rig.ops.sync.tables["render_jobs"] = [failed_job(i) for i in range(1, 8)]
        rig.ops.sync.tables["organizations"] = [{"id": "aaaaaaaa-0000-4000-8000-00000000000a", "created_at": ts(5)}]
        rig.tick(minutes=1)
        self.assertEqual({m.subject for m in rig.transport.sent}, {"Failed jobs", "New accounts: 1"})


class RosterTestCase(unittest.TestCase):
    def roster(self, n_admins=5):
        ids = [f"4444444{i}-4444-4444-8444-444444444444" for i in range(n_admins)]
        roster = [{"user_id": u, "role": "admin", "created_at": f"2026-02-0{i + 1}T00:00:00Z"} for i, u in enumerate(ids)]
        roster.append({"user_id": OWNER, "role": "owner", "created_at": "2026-03-01T00:00:00Z"})
        auth = {u: {"id": u, "email": f"admin{i}@example.org", "email_confirmed_at": "2026-01-01T00:00:00Z"}
                for i, u in enumerate(ids)}
        auth[OWNER] = AUTH[OWNER]
        return roster, auth

    def test_owners_come_first_then_the_oldest_and_the_cap_is_deterministic(self):
        roster, auth = self.roster()
        for shuffle in (roster, list(reversed(roster))):
            rig = Rig(roster=shuffle, auth=auth)
            self.assertEqual(rig.directory.addresses(), [OWNER_ADDR, "admin0@example.org", "admin1@example.org"])
            self.assertEqual(len(rig.fetched), owner_mail.MAX_RECIPIENTS)         # nobody beyond the cap is looked up

    def test_the_roster_is_asked_in_that_order(self):
        rig = Rig()
        rig.directory.addresses()
        params = [p for t_, p in rig.ops.sync.reads if t_ == "app_members"][0]
        self.assertEqual(params["order"], "role.desc,created_at.asc")             # "owner" sorts after "admin": desc puts it first

    def test_an_address_with_a_trailing_newline_or_a_uuid_with_one_is_refused(self):
        for bad in ("owner@example.org\n", "owner@example.org\r\n"):
            auth = {OWNER: {"id": OWNER, "email": bad, "email_confirmed_at": "2026-01-01T00:00:00Z"}}
            # strip() would hide a trailing newline from a looser check: the shape check must still hold afterwards
            self.assertEqual(Rig(roster=[{"user_id": OWNER, "role": "owner"}], auth=auth).directory.addresses(),
                             [OWNER_ADDR])
        self.assertIsNone(owner_mail._UUID.fullmatch(OWNER + "\n"))
        self.assertIsNone(owner_mail._ADDRESS.fullmatch("a@example.org\n"))

    def test_the_lookup_has_an_overall_deadline_and_a_cut_short_answer_is_not_cached(self):
        roster, auth = self.roster()
        ticks = iter(range(0, 1000, 15))                      # every monotonic reading is 15 seconds later
        rig = Rig(roster=roster, auth=auth)
        rig.directory._monotonic = lambda: next(ticks)
        got = rig.directory.addresses()
        self.assertLess(len(got), owner_mail.MAX_RECIPIENTS)
        self.assertEqual(len(rig.fetched), 1)                 # the second reading is past 20 s: no more lookups
        self.assertIsNone(rig.directory._cached)

    def test_no_environment_value_or_argument_can_name_a_recipient(self):
        import os
        from unittest import mock
        env = {"OWNER_MAIL_DEST": "attacker@evil.test", "OWNER_EMAIL_TO": "attacker@evil.test",
               "OWNER_EMAIL": "attacker@evil.test", "NIGHTSHIFT_OWNER_EMAIL_TO": "attacker@evil.test",
               "OWNER_EMAIL_RECIPIENTS": "attacker@evil.test", "EMAIL_TO": "attacker@evil.test",
               "ADMIN_EMAIL": "attacker@evil.test", "ACME_EMAIL": "attacker@evil.test", "NIGHTSHIFT_OWNER_EMAIL": "on",
               "RESEND_API_KEY": API_KEY, "NIGHTSHIFT_EMAIL_FROM": "Nightshift <hello@example.org>"}
        with mock.patch.dict(os.environ, env):
            rig = Rig({"render_jobs": []})
            sink = owner_mail.OwnerMail.from_env(rig.ops, rig.store, rig.ops.sync, rig.ops.cfg, os.environ)
            self.assertIsNotNone(sink)
            sink.directory = rig.directory
            sink.transport = rig.transport
            rig.engine.owner_mail = sink
            rig.arm()
            rig.ops.sync.tables["render_jobs"] = [failed_job(5)]
            rig.tick(minutes=1)
        self.assertEqual(sorted({m.to for m in rig.transport.sent}), [ADMIN_ADDR, OWNER_ADDR])
        self.assertNotIn("evil.test", "\n".join(rig.transport.texts()))


class WordingTestCase(unittest.TestCase):
    def test_the_footer_names_the_real_pause_button_in_each_language_and_says_what_a_mute_does_not_stop(self):
        for lang, button, critical in (("en", "Mute all 24h", "critical"), ("ru", "Заглушить всё на 24 ч", "критичные"),
                                       ("uz", "Hammasini 24 soat jim", "jiddiy")):
            with self.subTest(lang=lang):
                self.assertIn(button, t(lang, "btn.mute_all"))                    # the button really is called that
                text = t(lang, "ownermail.pause")
                self.assertIn("/alerts", text)
                self.assertIn(button, text)
                self.assertIn(critical, text)
                self.assertIn("NIGHTSHIFT_OWNER_EMAIL", text)
                self.assertNotIn("Mute 24h", text.replace("Mute all 24h", ""))

    def test_a_sign_up_is_described_as_an_organization_created(self):
        for lang in LANGUAGES:
            self.assertIn("{id}", t(lang, "ownermail.signup_line", id="{id}", when="x"))
        self.assertIn("organization", t("en", "ownermail.signup_line", id="x", when="y"))
        self.assertIn("organizations created", t("en", "ownermail.dg_accounts", n=1))

    def test_the_on_info_line_carries_no_key_and_no_address(self):
        rig = Rig()
        env = {"NIGHTSHIFT_OWNER_EMAIL": "on", "RESEND_API_KEY": API_KEY, "NIGHTSHIFT_EMAIL_FROM": "Nightshift <hello@example.org>"}
        with self.assertLogs("modules.operator_bot.owner_mail", "INFO") as cap:
            self.assertIsNotNone(owner_mail.OwnerMail.from_env(rig.ops, rig.store, rig.ops.sync, rig.ops.cfg, env))
        out = "\n".join(cap.output)
        self.assertIn("owner e-mail: on", out)
        for secret in (API_KEY, "hello@example.org", OWNER_ADDR, ADMIN_ADDR, "example.org"):
            self.assertNotIn(secret, out)


if __name__ == "__main__":
    unittest.main()
