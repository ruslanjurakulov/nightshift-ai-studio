"""Operator bot configuration: every environment variable it reads is named in
.env.example and docs/operator-bot.md, malformed values fail safe, and the
workflows only hand it names that exist."""

import re
import unittest
from pathlib import Path

import yaml

from modules.operator_bot.config import OperatorConfig, parse_quiet_hours, valid_app_url
from tests.operator_bot_fakes import NOW

ROOT = Path(__file__).resolve().parent.parent
SOURCES = (
    sorted((ROOT / "modules" / "operator_bot").glob("*.py"))
    + [ROOT / "modules" / "telegram_control.py", ROOT / "modules" / "tg_text.py",
       ROOT / "tools" / "run_telegram_control.py", ROOT / "tools" / "run_operator_alerts.py",
       ROOT / "tools" / "operator_bot_server.py"]
)
_ENV_READ = re.compile(r"""(?:getenv|environ\.get|env\.get|environ\[)\(?\s*["']([A-Z][A-Z0-9_]{2,})["']""")
#: Names that already existed before the operator bot, read elsewhere in the repo.
EXISTING = {"ELEVENLABS_LOW_CREDITS"}


def env_names_read() -> set:
    names = set()
    for path in SOURCES:
        names |= set(_ENV_READ.findall(path.read_text(encoding="utf-8")))
    return names


class EnvNamesTestCase(unittest.TestCase):
    def test_something_was_found(self):
        self.assertTrue({"TELEGRAM_BOT_TOKEN", "OPERATOR_APP_URL", "TELEGRAM_WEBHOOK_SECRET"} <= env_names_read())

    def test_every_variable_read_is_named_in_env_example_and_the_docs(self):
        example = (ROOT / ".env.example").read_text(encoding="utf-8")
        docs = (ROOT / "docs" / "operator-bot.md").read_text(encoding="utf-8")
        for name in sorted(env_names_read()):
            with self.subTest(name=name):
                self.assertRegex(example, rf"(?m)^#?\s*{name}=", f"{name} is not in .env.example")
                self.assertIn(name, docs, f"{name} is not in docs/operator-bot.md")

    def test_workflows_only_pass_names_the_docs_know(self):
        docs = (ROOT / "docs" / "operator-bot.md").read_text(encoding="utf-8")
        for wf in ("operator_alerts.yml", "telegram_control.yml"):
            doc = yaml.safe_load((ROOT / ".github" / "workflows" / wf).read_text(encoding="utf-8"))
            for job in doc["jobs"].values():
                for step in job["steps"]:
                    for name in (step.get("env") or {}):
                        if name in ("GITHUB_TOKEN", "DIGEST_NOW", "POLL_SECONDS", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
                            continue
                        with self.subTest(workflow=wf, name=name):
                            self.assertIn(name, docs)

    def test_the_secret_names_were_not_renamed(self):
        example = (ROOT / ".env.example").read_text(encoding="utf-8")
        for name in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_ADMIN_USER_IDS"):
            self.assertRegex(example, rf"(?m)^{name}=")

    def test_the_customer_bot_variables_are_not_used_here(self):
        for path in SOURCES:
            self.assertNotIn("TELEGRAM_CUSTOMER", path.read_text(encoding="utf-8"), path.name)


class ParsingTestCase(unittest.TestCase):
    def test_defaults_when_nothing_is_set(self):
        cfg = OperatorConfig.from_env({})
        self.assertEqual((cfg.app_url, cfg.quiet_hours, cfg.digest_hour, cfg.stuck_minutes, cfg.max_alerts_per_hour),
                         (None, None, None, 30, 6))
        self.assertEqual(cfg.github_repo, "")

    def test_all_settings(self):
        cfg = OperatorConfig.from_env({
            "OPERATOR_APP_URL": "https://nightshift-ai.studio/", "OPERATOR_TZ": "Asia/Tashkent",
            "OPERATOR_QUIET_HOURS": "23-7", "OPERATOR_DIGEST_HOUR": "9", "OPERATOR_STUCK_MINUTES": "45",
            "OPERATOR_ALERT_MAX_PER_HOUR": "3", "GITHUB_REPOSITORY": "owner/repo"})
        self.assertEqual(cfg.app_url, "https://nightshift-ai.studio")
        self.assertEqual((cfg.quiet_hours, cfg.digest_hour, cfg.stuck_minutes, cfg.max_alerts_per_hour),
                         ((23, 7), 9, 45, 3))
        self.assertEqual(cfg.github_repo, "owner/repo")
        self.assertEqual(cfg.local_hour(NOW), 17)
        self.assertEqual(cfg.local_date(NOW), "2026-10-14")

    def test_garbage_fails_safe(self):
        cfg = OperatorConfig.from_env({
            "OPERATOR_APP_URL": "javascript:alert(1)", "OPERATOR_TZ": "Mars/Base", "OPERATOR_QUIET_HOURS": "late",
            "OPERATOR_DIGEST_HOUR": "99", "OPERATOR_STUCK_MINUTES": "-4", "OPERATOR_ALERT_MAX_PER_HOUR": "lots",
            "GITHUB_REPOSITORY": "../../etc"})
        self.assertEqual((cfg.app_url, cfg.quiet_hours, cfg.digest_hour, cfg.stuck_minutes, cfg.max_alerts_per_hour,
                          cfg.github_repo), (None, None, None, 30, 6, ""))
        self.assertEqual(str(cfg.tz), "UTC")

    def test_app_url_must_be_a_bare_https_origin(self):
        for good in ("https://a.example", "https://a.example:8443", "https://a-b.example/"):
            self.assertTrue(valid_app_url(good), good)
        for bad in ("http://a.example", "https://user@a.example", "https://a.example/path", "https://a.example?x=1",
                    "https://", "a.example", "https://a b.example", ""):
            self.assertIsNone(valid_app_url(bad), bad)

    def test_quiet_hours_parsing(self):
        self.assertEqual(parse_quiet_hours("22-7"), (22, 7))
        self.assertEqual(parse_quiet_hours(" 1 - 5 "), (1, 5))
        for bad in ("0-0", "5-5", "24-3", "a-b", "", None, "1-2-3"):
            self.assertIsNone(parse_quiet_hours(bad), bad)

    def test_in_quiet_hours_without_a_window_is_never_quiet(self):
        self.assertFalse(OperatorConfig().in_quiet_hours(NOW))


class WorkflowsTestCase(unittest.TestCase):
    def load(self, name):
        return yaml.safe_load((ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8"))

    def test_the_alert_workflow_is_read_only_and_never_pushes(self):
        doc = self.load("operator_alerts.yml")
        self.assertEqual(doc["permissions"], {"contents": "read", "actions": "read"})
        text = (ROOT / ".github" / "workflows" / "operator_alerts.yml").read_text(encoding="utf-8")
        self.assertNotIn("write", doc["permissions"].values())
        self.assertNotRegex(text, r"\$\{\{[^}]*\}\}[^\n]*\n\s*python", "no expression inside a run script")

    def test_the_poll_workflow_keeps_its_concurrency_and_read_only_token(self):
        doc = self.load("telegram_control.yml")
        self.assertEqual(doc["permissions"], {"contents": "read", "actions": "read"})
        self.assertEqual(doc["concurrency"], {"group": "telegram-control", "cancel-in-progress": False})
        steps = doc["jobs"]["poll"]["steps"]
        run = [s for s in steps if "tools/run_telegram_control.py" in str(s.get("run", ""))][0]
        self.assertIn('--duration "$POLL_SECONDS"', run["run"])
        self.assertNotIn("${{", run["run"])
        # the polling window plus start-up must fit the job limit
        self.assertGreaterEqual(doc["jobs"]["poll"]["timeout-minutes"], 8)

    def test_no_operator_workflow_can_save_the_pipelines_history_cache(self):
        """The poller runs every five minutes. An actions/cache step (restore AND
        save) on the chronos-history prefix would save its older copy as the newest
        entry, and the next video run would restore it and lose the previous run's
        topic and run history. Only restore-only steps may touch that prefix here;
        the Telegram offset lives under its own key."""
        for name in ("telegram_control.yml", "operator_alerts.yml"):
            doc = self.load(name)
            for job in doc["jobs"].values():
                for step in job["steps"]:
                    uses = str(step.get("uses", ""))
                    if not uses.startswith("actions/cache"):
                        continue
                    key = str((step.get("with") or {}).get("key", ""))
                    restore_keys = str((step.get("with") or {}).get("restore-keys", ""))
                    touches = "chronos-history" in key or "chronos-history" in restore_keys
                    saves = not uses.startswith("actions/cache/restore@")
                    with self.subTest(workflow=name, step=step.get("name")):
                        self.assertFalse(touches and saves, "this step could SAVE a chronos-history key")
                        if saves:
                            self.assertTrue(key.startswith("telegram-offset-"), key)
                            self.assertEqual((step["with"]["path"]), "history/telegram_offset.json")

    def test_the_poller_still_restores_history_read_only_and_the_offset_has_its_own_cache(self):
        steps = self.load("telegram_control.yml")["jobs"]["poll"]["steps"]
        uses = [str(s.get("uses", "")) for s in steps]
        self.assertTrue(any(u.startswith("actions/cache/restore@") for u in uses))
        self.assertTrue(any(u.startswith("actions/cache@") for u in uses))
        self.assertEqual(sum(u.startswith("actions/cache@") for u in uses), 1)

    def test_deploy_web_was_not_touched_by_this_feature(self):
        text = (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text(encoding="utf-8")
        self.assertNotIn("TELEGRAM_WEBHOOK_SECRET", text)
        self.assertNotIn("operator_bot", text)


if __name__ == "__main__":
    unittest.main()
