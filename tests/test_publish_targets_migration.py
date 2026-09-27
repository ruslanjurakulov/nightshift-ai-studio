"""supabase/migrations/0029_publish_targets.sql — publish hint + publish_requests.

SQL does not run in CI, so these pin what matters: the browser can only name
(video_id, account_id | target_channel_id); exactly one target, and YouTube ⇔
a target channel; the trigger refuses a video that has not passed the
publish gate and approvals; RLS is org-scoped with editor+ inserts and no
browser updates/deletes; the worker's functions are service-only; and the
hint key is whitelisted in render_job_params_valid (and in run_request)."""

import re
import unittest
from pathlib import Path

from modules import run_request

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0029_publish_targets.sql").read_text()
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())


def fn_body(name):
    return CODE.split(f"function public.{name}(", 1)[1].split("$$;", 1)[0]


class PublishTargetsMigration(unittest.TestCase):
    def test_hint_key_whitelisted_and_checked(self):
        body = fn_body("render_job_params_valid")
        self.assertIn("'publish_hint'", body)
        self.assertIn("'^(youtube|instagram|tiktok):[A-Za-z0-9._-]{1,128}$'", body)

    def test_rls_org_scoped_editor_insert_no_browser_update(self):
        self.assertIn("alter table public.publish_requests enable row level security;", CODE)
        self.assertRegex(CODE, r"create policy publish_requests_select on public\.publish_requests\s+for select to authenticated\s+"
                               r"using \(org_id in \(select public\.accessible_org_ids\('viewer'\)\)\);")
        self.assertRegex(CODE, r"create policy publish_requests_insert on public\.publish_requests\s+for insert to authenticated\s+"
                               r"with check \(\s+org_id in \(select public\.accessible_org_ids\('editor'\)\)")
        policies = re.findall(r"create policy \w+ on public\.publish_requests\s+for (\w+)", CODE)
        self.assertEqual(sorted(policies), ["insert", "select"])
        self.assertIn("revoke all on public.publish_requests from public, anon, authenticated;", CODE)
        self.assertIn("grant insert (video_id, account_id, target_channel_id) on public.publish_requests to authenticated;",
                      CODE)
        self.assertEqual(len(re.findall(r"grant insert\b[^;]* on public\.publish_requests to authenticated", CODE)), 1)
        self.assertNotRegex(CODE, r"grant [^;]*\b(update|delete)\b[^;]* on public\.publish_requests to [^;]*authenticated")

    def test_trigger_fills_everything_and_refuses_ungated_videos(self):
        body = fn_body("publish_requests_before_insert")
        self.assertIn("not public.is_org_member(acc.org_id, 'editor')", body)
        self.assertIn("target_org := acc.org_id;", body)
        self.assertIn("ch_org is distinct from target_org", body)
        for col in ("org_id", "platform", "channel_id", "requested_by", "status", "worker_id", "result_url"):
            self.assertRegex(body, rf"new\.{col}\s+:=", col)
        self.assertIn("refusal := public.publish_request_refusal(new.video_id);", body)
        self.assertRegex(body, r"if acc\.status <> 'connected' then\s+refusal := 'account_not_connected';")
        self.assertIn("new.status := 'refused';", body)
        self.assertIn("before insert on public.publish_requests", CODE)

    def test_refusal_covers_gate_approval_and_two_person(self):
        body = fn_body("publish_request_refusal")
        for word in ("not_uploaded", "gate_blocked", "rejected", "not_approved", "awaiting_two_person"):
            self.assertIn(f"'{word}'", body)
        self.assertIn("e.event in ('publish.blocked', 'publish.allowed')", body)
        self.assertIn("a.decided_by is distinct from a.requested_by", body)
        self.assertIn("coalesce(v.review_state, '') <> 'approved'", body)

    def test_worker_functions_are_service_only(self):
        for fn in ("publish_request_refusal", "publish_requests_before_insert", "claim_publish_request",
                   "publish_channel_connected"):
            self.assertRegex(CODE, rf"revoke all on function public\.{fn}\([^)]*\) from public, anon, authenticated, service_role;")
        grants = re.findall(r"grant execute on function public\.(\w+)\([^)]*\) to ([^;]+);", CODE)
        self.assertEqual(sorted(grants), [("claim_publish_request", "service_role"),
                                          ("publish_channel_connected", "service_role"),
                                          ("publish_request_refusal", "service_role")])
        self.assertIn("coalesce(auth.role(), '') <> 'service_role'", fn_body("claim_publish_request"))

    def test_one_live_request_per_video_and_target(self):
        self.assertRegex(CODE, r"create unique index if not exists publish_requests_one_live\s+on public\.publish_requests "
                               r"\(video_id, account_id\)\s+where status in \('queued', 'uploading', 'processing'\) "
                               r"and account_id is not null;")
        self.assertRegex(CODE, r"create unique index if not exists publish_requests_one_live_channel\s+on public\.publish_requests "
                               r"\(video_id, target_channel_id\)\s+where status in \('queued', 'uploading', 'processing'\) "
                               r"and target_channel_id is not null;")

    def test_interrupted_uploads_are_not_retried(self):
        body = fn_body("claim_publish_request")
        self.assertIn("reason = 'interrupted'", body)
        self.assertNotRegex(body, r"set status = 'queued'")

    def test_definer_functions_pin_search_path_and_nothing_dropped(self):
        for m in re.finditer(r"create or replace function (public\.\w+)\((.*?)\$\$", CODE, re.S):
            if "security definer" in m.group(2):
                self.assertIn("set search_path = ''", m.group(2), m.group(1))
        self.assertNotRegex(CODE, r"\bdrop (table|function|column)\b")


class YoutubeTargetMigration(unittest.TestCase):
    def test_exactly_one_target_and_youtube_means_a_channel(self):
        self.assertIn("check (platform in ('instagram', 'tiktok', 'youtube'))", CODE)
        self.assertIn("account_id    uuid references public.social_accounts (id) on delete cascade,", CODE)
        self.assertIn("target_channel_id text references public.channels (channel_id) on delete cascade,", CODE)
        self.assertRegex(CODE, r"constraint publish_requests_one_target check \(\s+\(account_id is null\) <> "
                               r"\(target_channel_id is null\)\s+and \(platform = 'youtube'\) = "
                               r"\(target_channel_id is not null\)\s+\)")
        self.assertIn("0022_channel_tokens.sql: apply it first", CODE)

    def test_trigger_checks_the_target_channels_org_and_refuses_own_channel(self):
        body = fn_body("publish_requests_before_insert")
        self.assertIn("(new.account_id is null) = (new.target_channel_id is null)", body)
        self.assertIn("not public.is_org_member(target_org, 'editor')", body)
        self.assertIn("ch_org is distinct from target_org", body)
        self.assertIn("new.org_id       := target_org;", body)
        self.assertIn("else 'youtube' end", body)
        self.assertRegex(body, r"elsif new\.target_channel_id = ch_id then\s+refusal := 'already_on_channel';")
        self.assertRegex(body, r"upper\(btrim\(coalesce\(tgt_status, ''\)\)\) <> 'ACTIVE'\s+"
                               r"or not public\.publish_channel_connected\(new\.target_channel_id\) then\s+"
                               r"refusal := 'account_not_connected';")
        # The gate + approvals apply to YouTube targets too.
        self.assertRegex(body, r"if refusal is null then\s+refusal := public\.publish_request_refusal\(new\.video_id\);")

    def test_connected_mirrors_the_account_panel(self):
        body = fn_body("publish_channel_connected")
        self.assertIn("r.vault_secret_id is not null and r.revoked_at is null", body)
        self.assertIn("from public.channel_token_refs r", body)
        self.assertIn("cc.status = 'connected'", body)
        self.assertIn("cc.provider = 'youtube'", body)
        self.assertLess(body.index("channel_token_refs"), body.index("channel_credentials"))


class RunRequestHintTests(unittest.TestCase):
    def test_hint_is_accepted_validated_and_never_reaches_main(self):
        clean = run_request.validate("news", "daily", {"topic": "x", "publish_hint": "tiktok:3f2b8c1e-8d4a"})
        self.assertEqual(clean["publish_hint"], "tiktok:3f2b8c1e-8d4a")
        argv = run_request.build_main_args("news", clean)
        self.assertNotIn("tiktok:3f2b8c1e-8d4a", " ".join(argv))
        env = run_request.build_run_env(clean, {})
        self.assertNotIn("tiktok:3f2b8c1e-8d4a", " ".join(env.values()))
        with self.assertRaises(run_request.InvalidRunRequest):
            run_request.validate("news", "daily", {"publish_hint": "myspace:1"})


if __name__ == "__main__":
    unittest.main()
