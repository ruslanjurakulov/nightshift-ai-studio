"""What each operator command says, from canned system state. No network: the
Supabase client, the site check and GitHub are fakes (tests/operator_bot_fakes.py).
The things pinned here are the ones that would mislead an owner: an unknown that
reads as zero, a partial cost that reads as a total, an e-mail or free text that
reaches the chat, an unescaped value that breaks the HTML."""

import re
import unittest

from modules.operator_bot import views
from modules.operator_bot.config import OperatorConfig
from tests.operator_bot_fakes import (
    FakeHttp, github_ok, healthy_tables, make_ops, site_ok, ts,
)


def ops_with(tables=None, http=None, **kw):
    t = healthy_tables()
    t.update(tables or {})
    h = FakeHttp({**site_ok(), **github_ok(), **(http or {})})
    return make_ops(t, h, **kw)[0]


def buttons(reply):
    return [b for row in reply.keyboard for b in row]


def callback_data(reply):
    return [b["callback_data"] for b in buttons(reply) if "callback_data" in b]


class WellFormedTestCase(unittest.TestCase):
    """Every view is valid for HTML parse mode and fits a message."""

    def all_replies(self, ops):
        held = [{"video_id": "v1"}]
        return {
            "health": views.view_health(ops), "queue": views.view_queue(ops), "errors": views.view_errors(ops),
            "balance": views.view_balance(ops, low=15000), "spend": views.view_spend(ops),
            "today": views.view_today(ops), "users": views.view_users(ops), "deploys": views.view_deploys(ops),
            "approvals": views.view_approvals(ops, held), "security": views.view_security(ops),
            "digest": views.view_digest(ops, held), "menu": views.view_menu(ops.cfg), "help": views.view_help(),
        }

    def test_balanced_tags_and_no_raw_angle_brackets(self):
        for name, r in self.all_replies(ops_with()).items():
            stripped = re.sub(r"</?(b|code)>", "", r.text)
            self.assertNotIn("<", stripped, name)
            self.assertEqual(r.text.count("<b>"), r.text.count("</b>"), name)
            self.assertEqual(r.text.count("<code>"), r.text.count("</code>"), name)

    def test_callback_data_fits_telegrams_limit_and_has_a_menu_way_back(self):
        for name, r in self.all_replies(ops_with()).items():
            for data in callback_data(r):
                self.assertLessEqual(len(data.encode()), 64, data)
            if name not in ("menu",):
                self.assertIn("c:menu", callback_data(r), name)

    def test_everything_is_unknown_not_zero_when_nothing_is_configured(self):
        ops, _ = make_ops({}, FakeHttp(), cfg=OperatorConfig())
        ops.sync.enabled = False
        for name, r in self.all_replies(ops).items():
            if name in ("menu", "help"):
                continue
            self.assertIn("unknown", r.text.lower(), name)
        self.assertNotIn("0 running", views.view_queue(ops).text)


class HealthTestCase(unittest.TestCase):
    def test_a_healthy_system_reads_ok(self):
        t = views.view_health(ops_with()).text
        self.assertIn("Site: OK", t)
        self.assertIn("nightshift-01", t)
        self.assertIn("running", t)
        self.assertIn("Deploy: success", t)
        self.assertIn("Disk: not reported", t)

    def test_a_down_page_is_named(self):
        r = views.view_health(ops_with(http={"https://app.example.test/pricing": (502, None)}))
        self.assertIn("DOWN", r.text)
        self.assertIn("/pricing 502", r.text)

    def test_no_answer_is_down_not_ok(self):
        r = views.view_health(ops_with(http={"https://app.example.test/login": (None, None)}))
        self.assertIn("no answer", r.text)

    def test_a_silent_worker_is_stale(self):
        w = healthy_tables()["worker_status"][0] | {"updated_at": ts(30)}
        t = views.view_health(ops_with({"worker_status": [w]})).text
        self.assertIn("STALE", t)

    def test_a_failed_worker_shows_its_remedy_clipped_and_scrubbed(self):
        w = healthy_tables()["worker_status"][0] | {"state": "failed", "detail": "set X " + "y" * 400}
        t = views.view_health(ops_with({"worker_status": [w]})).text
        self.assertIn("failed", t)
        self.assertLess(len(t), 1200)

    def test_no_site_url_says_not_configured(self):
        t = views.view_health(ops_with(cfg=OperatorConfig(github_repo="owner/repo"))).text
        self.assertIn("Site: unknown (not configured)", t)

    def test_a_failed_deploy_is_flagged(self):
        t = views.view_health(ops_with(http=github_ok(deploy="failure"))).text
        self.assertIn("FAILED", t)

    def test_open_link_only_when_the_app_url_is_set(self):
        self.assertTrue(any("url" in b for b in buttons(views.view_health(ops_with()))))
        r = views.view_health(ops_with(cfg=OperatorConfig()))
        self.assertFalse(any("url" in b for b in buttons(r)))


class QueueTestCase(unittest.TestCase):
    def jobs(self):
        return {
            "render_jobs": [
                {"id": 1, "channel_id": "default", "kind": "daily", "status": "running", "attempts": 1,
                 "max_attempts": 3, "heartbeat_at": ts(1), "started_at": ts(14), "created_at": ts(20)},
                {"id": 2, "channel_id": "finance", "kind": "daily", "status": "running", "attempts": 1,
                 "max_attempts": 3, "heartbeat_at": ts(25), "started_at": ts(40), "created_at": ts(45)},
                {"id": 3, "channel_id": "default", "kind": "daily", "status": "queued", "attempts": 0,
                 "max_attempts": 3, "heartbeat_at": None, "started_at": None, "created_at": ts(50)},
                {"id": 4, "channel_id": "default", "kind": "daily", "status": "queued", "attempts": 0,
                 "max_attempts": 3, "heartbeat_at": None, "started_at": None, "created_at": ts(2)},
            ],
            "creative_jobs": [
                {"id": "11111111-aaaa", "capability": "image", "status": "running", "heartbeat_at": ts(1),
                 "started_at": ts(3), "created_at": ts(4), "error_code": None},
            ],
        }

    def test_counts_ages_and_stuck_markers(self):
        t = views.view_queue(ops_with(self.jobs())).text
        self.assertIn("2 running, 2 queued, 2 stuck", t)
        self.assertRegex(t, r"run <code>2</code>.*STUCK")        # running with an old heartbeat
        self.assertRegex(t, r"run <code>3</code>.*STUCK")        # queued past the wait
        self.assertNotRegex(t, r"run <code>1</code>[^\n]*STUCK")
        self.assertNotRegex(t, r"run <code>4</code>[^\n]*STUCK")
        self.assertIn("Creative jobs: 1 running, 0 queued, 0 stuck", t)

    def test_free_text_columns_are_never_requested(self):
        ops = ops_with(self.jobs())
        views.view_queue(ops)
        for table, params in ops.sync.reads:
            if table in ("render_jobs", "creative_jobs"):
                cols = params["select"].split(",")
                for banned in ("error", "params", "result", "topic", "requested_by"):
                    self.assertNotIn(banned, cols, f"{table} selects {banned}")


class ErrorsTestCase(unittest.TestCase):
    def test_failures_are_grouped_and_carry_ids_and_codes_only(self):
        t = {
            "render_jobs": [
                {"id": 7, "channel_id": "default", "status": "failed", "finished_at": ts(60), "created_at": ts(90)},
                {"id": 8, "channel_id": "default", "status": "failed", "finished_at": ts(70), "created_at": ts(95)},
                {"id": 9, "channel_id": "finance", "status": "failed", "finished_at": ts(80), "created_at": ts(99),
                 "error": "boom for someone@example.com sk-abcdefghijklmnopqrstuvwxyz"},
                {"id": 10, "channel_id": "old", "status": "failed", "finished_at": ts(60 * 30), "created_at": ts(60 * 31)},
            ],
            "creative_jobs": [
                {"id": "a", "status": "failed", "finished_at": ts(5), "error_code": "provider_error"},
                {"id": "b", "status": "failed", "finished_at": ts(6), "error_code": "provider_error"},
                {"id": "c", "status": "failed", "finished_at": ts(7), "error_code": "timeout"},
            ],
            "system_events": [{"event": "upload.failed", "video_id": "v1", "ts": ts(10)},
                              {"event": "upload.failed", "video_id": "v1", "ts": ts(9)}],
        }
        out = views.view_errors(ops_with(t)).text
        self.assertIn("3 failed — default ×2, finance ×1", out)           # the 30h-old one is out
        self.assertIn("#7, #8, #9", out)
        self.assertIn("provider_error ×2, timeout ×1", out)
        self.assertIn("upload.failed ×1", out)                            # a retried emit is one
        self.assertNotIn("someone@example.com", out)
        self.assertNotIn("sk-", out)
        self.assertNotIn("boom", out)

    def test_no_failures_reads_none_failed_not_a_blank(self):
        out = views.view_errors(ops_with()).text
        self.assertIn("Render jobs: none failed", out)
        self.assertIn("Creative jobs: none failed", out)


class BalanceTestCase(unittest.TestCase):
    def test_latest_snapshot_per_provider_with_low_flag_for_elevenlabs_only(self):
        t = {"provider_balances": [
            {"provider": "elevenlabs", "metric": "credits", "remaining": 1200, "total": 100000, "unit": "credits",
             "tier": "creator", "checked_at": ts(5)},
            {"provider": "elevenlabs", "metric": "credits", "remaining": 99999, "total": 100000, "unit": "credits",
             "tier": "creator", "checked_at": ts(500)},                    # older snapshot, ignored
            {"provider": "leonardo", "metric": "api_tokens", "remaining": 3, "total": None, "unit": "tokens",
             "checked_at": ts(5)},
        ]}
        out = views.view_balance(ops_with(t), low=15000).text
        self.assertIn("1,200 of 100,000", out)
        self.assertIn("LOW", out)
        self.assertNotIn("99,999", out)
        leo = [l for l in out.split("\n") if "leonardo" in l][0]
        self.assertNotIn("LOW", leo)           # nothing says what low means for it

    def test_an_unknown_remaining_is_not_zero(self):
        t = {"provider_balances": [{"provider": "elevenlabs", "metric": "credits", "remaining": None,
                                    "total": 100, "unit": "credits", "checked_at": ts(5)}]}
        out = views.view_balance(ops_with(t), low=15000).text
        self.assertIn("unknown", out)
        self.assertNotIn("LOW", out)

    def test_no_snapshot_says_so(self):
        self.assertIn("No balance snapshot yet", views.view_balance(ops_with({"provider_balances": []})).text)


class SpendTestCase(unittest.TestCase):
    def test_priced_rows_sum_and_label_complete(self):
        t = {"creative_job_costs": [{"usd_estimate": 1.5, "recorded_at": ts(10)},
                                    {"usd_estimate": 2.25, "recorded_at": ts(60 * 24 * 2)}],
             "creative_jobs": [{"charged_credits": 10, "finished_at": ts(10)},
                               {"charged_credits": 5, "finished_at": ts(60 * 24 * 2)}]}
        out = views.view_spend(ops_with(t)).text
        self.assertIn("Today: $1.50", out)
        self.assertIn("7 days: $3.75", out)
        self.assertIn("today 10, 7 days 15", out)

    def test_an_unpriced_row_makes_the_figure_a_floor_not_a_total(self):
        t = {"creative_job_costs": [{"usd_estimate": 1.5, "recorded_at": ts(10)},
                                    {"usd_estimate": None, "recorded_at": ts(11)}]}
        out = views.view_spend(ops_with(t)).text
        self.assertIn("at least $1.50", out)
        self.assertIn("unpriced", out)
        self.assertNotIn("Today: $1.50 (", out)

    def test_all_unpriced_is_unknown(self):
        t = {"creative_job_costs": [{"usd_estimate": None, "recorded_at": ts(10)}]}
        out = views.view_spend(ops_with(t)).text
        self.assertIn("Today: unknown", out)

    def test_no_rows_is_no_cost_rows_and_revenue_is_not_invented(self):
        out = views.view_spend(ops_with()).text
        self.assertIn("Today: no cost rows", out)
        self.assertIn("Revenue in USD is not computed here", out)


class ActivityTestCase(unittest.TestCase):
    def test_today_counts(self):
        t = {"system_events": [
            {"event": "render.completed", "video_id": "v1", "ts": ts(5)},
            {"event": "render.completed", "video_id": "v2", "ts": ts(6)},
            {"event": "video.published", "video_id": "v1", "ts": ts(4)},
            {"event": "publish.held", "video_id": "v2", "ts": ts(3)},
            {"event": "render.failed", "video_id": "v3", "ts": ts(2)}],
            "render_jobs": [{"id": 1, "status": "succeeded", "finished_at": ts(5), "created_at": ts(9)},
                            {"id": 2, "status": "failed", "finished_at": ts(5), "created_at": ts(9)}],
            "organizations": [{"id": "x", "created_at": ts(30)}]}
        out = views.view_today(ops_with(t)).text
        self.assertIn("made 2 · published 1 · held 1", out)
        self.assertIn("failed 1", out)
        self.assertIn("1 succeeded, 1 failed", out)
        self.assertIn("New accounts: 1", out)

    def test_users_are_counts_only_and_the_default_org_is_not_a_signup(self):
        t = {"organizations": [
            {"id": "00000000-0000-0000-0000-000000000001", "created_at": ts(5), "name": "x", "slug": "owner-org"},
            {"id": "a", "created_at": ts(60 * 2), "name": "Jane Doe", "slug": "jane", "email": "jane@example.com"},
            {"id": "b", "created_at": ts(60 * 24 * 3)},
            {"id": "c", "created_at": ts(60 * 24 * 20)}]}
        out = views.view_users(ops_with(t)).text
        self.assertIn("Last 24 hours: 1", out)
        self.assertIn("Last 7 days: 2", out)
        self.assertIn("Last 30 days: 3", out)
        for leak in ("Jane", "jane", "@", "owner-org"):
            self.assertNotIn(leak, out)

    def test_users_never_requests_a_personal_column(self):
        ops = ops_with()
        views.view_users(ops)
        cols = [p["select"] for t, p in ops.sync.reads if t == "organizations"][0].split(",")
        self.assertEqual(sorted(cols), ["created_at", "id"])

    def test_deploys_lists_each_workflow(self):
        out = views.view_deploys(ops_with(http=github_ok(tests="failure"))).text
        for label in ("Deploy", "Tests", "Frontend"):
            self.assertIn(label, out)
        self.assertIn("failure", out)

    def test_deploys_without_github_is_unknown(self):
        out = views.view_deploys(ops_with(cfg=OperatorConfig(app_url="https://app.example.test"))).text
        self.assertIn("unknown (not configured)", out)

    def test_github_token_is_sent_only_to_github(self):
        ops = ops_with(token="ghs_TESTTOKEN")
        views.view_deploys(ops)
        views.view_health(ops)
        for url, headers in ops.http_get.calls:
            if url.startswith("https://api.github.com/"):
                self.assertEqual(headers["Authorization"], "Bearer ghs_TESTTOKEN")
            else:
                self.assertFalse(headers and "Authorization" in headers, url)

    def test_approvals_lists_channel_and_age_not_people(self):
        t = {"publish_approvals": [{"id": "p1", "channel_id": "default", "status": "pending",
                                    "requested_at": ts(90), "requested_by": "uuid-1", "note": "private note"}],
             "pipeline_runs": [{"run_id": "run-abc", "started_at": ts(100), "updated_at": ts(95),
                                "topic": "A secret topic"}]}
        out = views.view_approvals(ops_with(t), [{"video_id": "v"}]).text
        self.assertIn("1 pending", out)
        self.assertIn("default", out)
        self.assertIn("run-abc", out)
        self.assertIn("Held for review (auto-publish off): 1", out)
        self.assertNotIn("secret topic", out)
        self.assertNotIn("private note", out)
        self.assertTrue(any(b.get("url", "").endswith("/all-channels/approvals") for b in buttons(views.view_approvals(ops_with(t)))))

    def test_security_lists_only_operator_level_actions_without_actors(self):
        t = {"app_audit_log": [
            {"id": "1", "at": ts(10), "action": "secret.write", "target": "GEMINI_API_KEY", "channel_id": None,
             "actor_email": "boss@example.com"},
            {"id": "2", "at": ts(11), "action": "video.publish_request", "target": "v", "channel_id": "default"},
            {"id": "3", "at": ts(12), "action": "role.change", "target": "u-2", "channel_id": None},
            # ordinary tenant activity any customer can generate: not security alerts
            {"id": "4", "at": ts(13), "action": "api_key.create", "target": "org-9", "channel_id": None},
            {"id": "5", "at": ts(14), "action": "mcp.connect", "target": "org-9", "channel_id": None},
            {"id": "6", "at": ts(15), "action": "secret.write", "target": "x", "channel_id": "their-channel"}]}
        out = views.view_security(ops_with(t)).text
        self.assertIn("secret.write", out)
        self.assertIn("role.change", out)
        for absent in ("video.publish_request", "api_key.create", "mcp.connect", "boss@example.com", "their-channel"):
            self.assertNotIn(absent, out)

    def test_audit_is_filtered_by_the_database_not_after_a_row_limit(self):
        ops = ops_with()
        views.view_security(ops)
        params = [p for t, p in ops.sync.reads if t == "app_audit_log"][0]
        self.assertEqual(params["channel_id"], "is.null")
        self.assertIn("action.in.(secret.write", params["or"])
        self.assertIn("action.like.role.*", params["or"])

    def test_audit_read_never_selects_the_actor_email(self):
        ops = ops_with()
        views.view_security(ops)
        cols = [p["select"] for t, p in ops.sync.reads if t == "app_audit_log"][0].split(",")
        self.assertNotIn("actor_email", cols)
        self.assertNotIn("detail", cols)


class TruncationTestCase(unittest.TestCase):
    """A read that hit its limit is a floor and says so; stuck jobs are never the rows a cut drops."""

    def test_queue_reads_active_jobs_oldest_first_and_separately_from_finished_ones(self):
        ops = ops_with()
        views.view_queue(ops)
        reads = [p for t, p in ops.sync.reads if t == "render_jobs"]
        active = [p for p in reads if "status" in p][0]
        self.assertEqual(active["order"], "created_at.asc")
        self.assertEqual(active["status"], "in.(queued,running)")
        self.assertTrue(any("finished_at" in p for p in reads))

    def test_a_cut_list_says_so(self):
        many = [{"id": i, "channel_id": "c", "kind": "daily", "status": "queued", "created_at": ts(5)}
                for i in range(200)]
        out = views.view_queue(ops_with({"render_jobs": many})).text
        self.assertIn("list cut at 200 rows", out)

    def test_an_uncut_list_has_no_note(self):
        self.assertNotIn("list cut", views.view_queue(ops_with()).text)

    def test_cut_events_and_credits_and_security_say_so(self):
        evs = [{"event": "render.completed", "video_id": str(i), "ts": ts(1)} for i in range(2000)]
        self.assertIn("list cut at 2000", views.view_today(ops_with({"system_events": evs})).text)
        caps = [{"charged_credits": 1, "finished_at": ts(1)} for _ in range(5000)]
        self.assertIn("list cut at 5000", views.view_spend(ops_with({"creative_jobs": caps})).text)
        aud = [{"id": str(i), "at": ts(1), "action": "secret.write", "target": "x", "channel_id": None}
               for i in range(300)]
        self.assertIn("list cut at 300", views.view_security(ops_with({"app_audit_log": aud})).text)


class DigestTestCase(unittest.TestCase):
    def test_digest_has_one_line_per_area(self):
        out = views.view_digest(ops_with(), [{"video_id": "v"}]).text
        for area in ("Site:", "Workers:", "Render jobs (24h):", "Creative jobs (24h):", "Videos today:",
                     "New accounts (24h):", "Balances:", "Provider cost (24h):", "Waiting for a person:",
                     "Held for review: 1", "Deploy:"):
            self.assertIn(area, out)
        self.assertIn("Daily digest — 2026-10-14", out)

    def test_digest_flags_trouble(self):
        w = healthy_tables()["worker_status"][0] | {"updated_at": ts(60)}
        t = {"worker_status": [w], "provider_balances": [
            {"provider": "elevenlabs", "metric": "credits", "remaining": 10, "total": 100, "unit": "credits",
             "checked_at": ts(1)}]}
        out = views.view_digest(ops_with(t)).text
        self.assertIn("need attention", out)
        self.assertIn("LOW", out)


class MenuAndHelpTestCase(unittest.TestCase):
    def test_every_command_is_in_help_and_on_a_button(self):
        helptext = views.view_help().text
        for name in views.READ_COMMANDS:
            self.assertIn(f"/{name}", helptext)
        self.assertIn("/mute", helptext)
        for gone in ("/publish", "/pause", "/resume"):
            self.assertNotIn(gone, helptext)
        data = callback_data(views.view_menu(OperatorConfig()))
        for name in ("health", "queue", "errors", "balance", "spend", "today", "users", "deploys",
                     "approvals", "security", "digest", "alerts", "status", "channels", "pending", "payments"):
            self.assertIn(f"c:{name}", data)

    def test_help_says_it_is_view_only(self):
        self.assertIn("view-only", views.view_help().text)
        self.assertIn("Read-only", views.view_menu(OperatorConfig()).text)


class EscapingTestCase(unittest.TestCase):
    def test_a_hostile_channel_id_cannot_inject_markup(self):
        t = {"render_jobs": [{"id": 1, "channel_id": "<b>x</b>&<script>", "status": "failed",
                              "finished_at": ts(5), "attempts": 1, "max_attempts": 3, "created_at": ts(9)}]}
        out = views.view_errors(ops_with(t)).text
        self.assertNotIn("<script>", out)
        self.assertNotIn("<b>x</b>", out)

    def test_deep_links_use_a_safe_channel_segment(self):
        cfg = OperatorConfig(app_url="https://app.example.test")
        self.assertEqual(views.app_link(cfg, "errors", "default"), "https://app.example.test/default/errors")
        self.assertEqual(views.app_link(cfg, "errors", "../x?y"), "https://app.example.test/all-channels/errors")
        self.assertIsNone(views.app_link(OperatorConfig(), "errors"))


if __name__ == "__main__":
    unittest.main()
