"""The operator bot knows when the owner paused the scheduled pipeline (NIGHTSHIFT_PIPELINE_PAUSED).

Before this, pausing the schedule made the dead-man switch say "No video from channel default" for a slot that was
paused ON PURPOSE, and the digest and /today print MISSING, because the bot never saw the variable. What these pin:

* the bot reads the variable through the SAME function the scheduler uses (modules/pipeline_pause.py), so the word
  list cannot drift, and it fails closed the same way;
* while paused: no dead-man alert (and no "cannot judge" note about it), the digest and /today say "paused" and never
  MISSING, and ONE information alert a UTC day (health kind, Telegram only, never e-mail) says the pause is still on;
* a channel-level pause (status PAUSED, schedule off) was already honoured, and still is;
* the variable reaches the bot: both fallback workflows, the always-on service's env file, the examples and the docs.

Fakes only: no network, no provider, no Telegram, no secret."""

import re
import unittest
from datetime import timedelta
from pathlib import Path

import yaml

from modules import pipeline_pause
from modules.operator_bot import alerts, owner_digest, owner_mail, reliability, views
from modules.operator_bot.config import OperatorConfig
from modules.operator_bot.i18n import LANGUAGES, placeholders, table
from tests.test_operator_bot_alerts import arm, heartbeat
from tests.test_reliability_alerts import (
    DAILY, T, at, channel, daily, event, gh_run, jobs, keys, make, run_detect, storyboard, video,
)
from tools import list_channels

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"
PAUSED = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", pipeline_paused=True)
RUNNING = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo")
PAUSE_ENV = "NIGHTSHIFT_PIPELINE_PAUSED"


def pause_alerts(found):
    return [a for a in found if a.key.startswith("paused:")]


class SharedSemanticsTestCase(unittest.TestCase):
    """One function decides what "paused" means, for the scheduler and for the bot."""

    VALUES = ("", " ", "0", "false", "FALSE", "no", "off", " Off ", '"false"', "'0'", "1", "true", "TRUE", "yes", "on",
              '"true"', "ture", "paused", "2", "y", '""false""', '"', "\U0001F6D1", "nope")

    def test_the_bot_and_the_scheduler_agree_on_every_value(self):
        for value in self.VALUES:
            env = {PAUSE_ENV: value}
            self.assertEqual(OperatorConfig.from_env(env).pipeline_paused, list_channels.pipeline_paused(env), repr(value))

    def test_the_scheduler_uses_the_shared_function_not_a_copy(self):
        self.assertIs(list_channels.pipeline_paused, pipeline_pause.pipeline_paused)
        self.assertEqual(list_channels.PAUSE_ENV, pipeline_pause.PAUSE_ENV)
        config_source = Path(OperatorConfig.__module__.replace(".", "/") + ".py")
        text = (ROOT / config_source).read_text()
        self.assertIn("pipeline_paused", text)
        self.assertNotIn("_RUNNING_WORDS", text)        # no hand-copied word list in the bot
        self.assertNotRegex(text, r"""["']false["']""")

    def test_unset_means_running_and_the_default_config_is_not_paused(self):
        self.assertFalse(OperatorConfig.from_env({}).pipeline_paused)
        self.assertFalse(OperatorConfig().pipeline_paused)

    def test_a_typo_pauses_fail_closed(self):
        self.assertTrue(OperatorConfig.from_env({PAUSE_ENV: "ture"}).pipeline_paused)

    def test_the_state_words(self):
        self.assertEqual(pipeline_pause.pause_state({}), "running")
        self.assertEqual(pipeline_pause.pause_state({PAUSE_ENV: "ON"}), "paused")
        self.assertEqual(pipeline_pause.pause_state({PAUSE_ENV: "ture"}), "unrecognised")


class DeadManWhilePausedTestCase(unittest.TestCase):
    def test_a_paused_pipeline_raises_no_dead_man_alert_and_a_running_one_does(self):
        self.assertEqual(keys(run_detect(now=at(14, 19, 0), videos=[], cfg=RUNNING)[0]), ["deadman:default:2026-10-14"])
        self.assertEqual(keys(run_detect(now=at(14, 19, 0), videos=[], cfg=PAUSED)[0]), [])

    def test_yesterdays_slot_is_not_alerted_while_paused_either(self):
        found = run_detect(now=at(15, 9, 0), videos=[], cfg=PAUSED)[0]
        self.assertEqual(keys(found), [])

    def test_a_paused_pipeline_records_no_verdict_for_a_slot(self):
        engine, _, _, ops, _ = make(now=at(14, 19, 0), videos=[video("v", held=at(14, 15, 30))], cfg=PAUSED)
        v = reliability.Verdicts()
        alerts.detect(ops, 15000, verdicts=v)
        self.assertEqual(v.fine, {})

    def test_the_cannot_judge_note_is_not_raised_for_a_dead_man_switch_that_is_off_on_purpose(self):
        engine, _, _, ops, _ = make(now=at(14, 19, 0), videos=[], cfg=PAUSED)
        ops.sync.fail = {"videos"}
        v = reliability.Verdicts()
        alerts.detect(ops, 15000, verdicts=v)
        self.assertEqual(v.blind, [])
        engine, _, _, ops, _ = make(now=at(14, 19, 0), videos=[], cfg=RUNNING)
        ops.sync.fail = {"videos"}
        v = reliability.Verdicts()
        alerts.detect(ops, 15000, verdicts=v)
        self.assertEqual(v.blind, ["videos"])            # control: a running pipeline still names its blind source

    def test_a_failed_workflow_run_is_still_heard_while_paused(self):
        # a manual dispatch still runs while the schedule is paused, and its failure is news
        run = gh_run(77, event_="workflow_dispatch", conclusion="failure", created=at(14, 17, 0))
        http = daily(run)
        http.update(jobs(77, {"name": "make-video (default)", "conclusion": "failure", "steps": []}))
        found = run_detect(now=at(14, 18, 0), videos=[], http=http, cfg=PAUSED)[0]
        self.assertTrue([a for a in found if a.key.startswith("wf:daily:")], [a.key for a in found])

    def test_a_channel_level_pause_is_honoured_without_the_global_one(self):
        for ch in (channel(status="PAUSED"), channel(enabled=False), channel(status="whatever")):
            found = run_detect(now=at(14, 19, 0), videos=[], channels=[ch], cfg=RUNNING)[0]
            self.assertEqual(keys(found), [], ch)
            self.assertEqual(pause_alerts(found), [], ch)      # and it is not the global pause's alert either
            engine, _, _, ops, _ = make(now=at(14, 19, 0), videos=[], channels=[ch], cfg=RUNNING)
            self.assertEqual(reliability.digest_lines(ops, "en"), [], ch)      # no MISSING, no line at all


class DigestWhilePausedTestCase(unittest.TestCase):
    def lines(self, now=at(14, 19, 0), cfg=PAUSED, **kw):
        engine, _, _, ops, _ = make(now=now, cfg=cfg, **kw)
        return reliability.digest_lines(ops, "en")

    def test_a_slot_without_a_video_reads_paused_never_missing(self):
        lines = self.lines(videos=[])
        text = "\n".join(lines)
        self.assertNotIn("MISSING", text)
        self.assertIn("today paused", text)
        self.assertIn("paused", text.lower())
        self.assertIn("MISSING", "\n".join(self.lines(cfg=RUNNING, videos=[])))        # control

    def test_a_slot_before_its_deadline_reads_paused_not_due(self):
        text = "\n".join(self.lines(now=at(14, 12, 0), videos=[]))
        self.assertIn("today paused", text)
        self.assertNotIn("due", text)

    def test_a_video_that_was_made_is_still_counted_while_paused(self):
        # a manual run still works while the schedule is paused: a count is a measurement, "paused" is not a verdict on it
        text = "\n".join(self.lines(videos=[video("v", held=at(14, 15, 30))]))
        self.assertIn("today 1/1", text)
        self.assertNotIn("today paused", text)

    def test_a_run_that_started_while_paused_is_still_said_not_hidden_by_the_pause(self):
        # a manual dispatch that began but made no video is a fact the owner wants, paused or not
        text = "\n".join(self.lines(videos=[], events=[event("system.started", at(14, 15, 5))]))
        self.assertIn("a run started, no video", text)
        self.assertNotIn("today paused", text)

    def test_a_paused_pipeline_says_so_even_when_no_channel_is_scheduled(self):
        lines = self.lines(channels=[channel(status="PAUSED")])
        self.assertEqual(len(lines), 1)
        self.assertIn("NIGHTSHIFT_PIPELINE_PAUSED", lines[0])
        self.assertEqual(self.lines(cfg=RUNNING, channels=[channel(status="PAUSED")]), [])

    def test_an_unreadable_source_still_reads_unknown_while_paused(self):
        engine, _, _, ops, _ = make(now=at(14, 19, 0), videos=[], cfg=PAUSED)
        ops.sync.fail = {"videos"}
        text = "\n".join(reliability.digest_lines(ops, "en"))
        self.assertIn("unknown", text)
        self.assertNotIn("MISSING", text)

    def test_it_reaches_today_the_digest_and_the_owner_mail_digest(self):
        engine, _, _, ops, _ = make(now=at(14, 19, 0), videos=[], cfg=PAUSED)
        for text in (views.view_today(ops, "en").text, views.view_digest(ops, [], "en").text,
                     "\n".join(owner_digest.build(ops, "en", []).lines)):
            self.assertIn("today paused", text)
            self.assertNotIn("MISSING", text)

    def test_the_cell_is_translated(self):
        for lang in LANGUAGES:
            engine, _, _, ops, _ = make(now=at(14, 19, 0), videos=[], cfg=PAUSED)
            text = "\n".join(reliability.digest_lines(ops, lang))
            self.assertNotIn(table(lang)["rel.cell_missing"].replace("{made}", "0").replace("{want}", "1"), text)
            self.assertIn(table(lang)["rel.cell_paused"], text)


class PauseReminderTestCase(unittest.TestCase):
    def test_one_information_alert_of_the_health_kind_names_the_variable(self):
        found = run_detect(now=at(14, 12, 0), videos=[], cfg=PAUSED)[0]
        (a,) = pause_alerts(found)
        self.assertEqual((a.kind, a.severity, a.key, a.channel_id, a.cooldown_min),
                         ("health", "info", "paused:2026-10-14", None, 0))
        self.assertIn("scheduled runs are paused by NIGHTSHIFT_PIPELINE_PAUSED", a.line.lower().replace("nightshift_pipeline_paused", "NIGHTSHIFT_PIPELINE_PAUSED"))

    def test_a_running_pipeline_says_nothing_about_a_pause(self):
        self.assertEqual(pause_alerts(run_detect(now=at(14, 12, 0), videos=[], cfg=RUNNING)[0]), [])

    def test_it_is_said_even_when_no_channel_is_scheduled_or_the_channel_table_is_unreadable(self):
        found = run_detect(now=at(14, 12, 0), channels=[channel(status="PAUSED")], cfg=PAUSED)[0]
        self.assertEqual(len(pause_alerts(found)), 1)
        engine, _, _, ops, _ = make(now=at(14, 12, 0), cfg=PAUSED)
        ops.sync.fail = {"channels", "videos", "storyboards", "system_events"}
        self.assertEqual(len(pause_alerts(alerts.detect(ops, 15000))), 1)

    def test_it_is_never_e_mailed(self):
        sink = type("S", (), {"kinds": frozenset(owner_mail.MAIL_KINDS)})()          # even with every kind switched on
        a = pause_alerts(run_detect(now=at(14, 12, 0), videos=[], cfg=PAUSED)[0])[0]
        self.assertFalse(owner_mail.OwnerMail.wants(sink, a))

    def test_the_translations_exist_and_keep_the_same_placeholders(self):
        for key in ("alert.paused", "alert.paused_ok", "rel.cell_paused", "digest.paused"):
            for lang in LANGUAGES:
                self.assertIn(key, table(lang), (lang, key))
                self.assertEqual(placeholders(table(lang)[key]), placeholders(table("en")[key]), (lang, key))
        for lang in LANGUAGES:
            self.assertIn("NIGHTSHIFT_PIPELINE_PAUSED", table(lang)["alert.paused"])
            self.assertIn("NIGHTSHIFT_PIPELINE_PAUSED", table(lang)["digest.paused"])


class PauseReminderDeliveryTestCase(unittest.TestCase):
    """Through the engine: once a UTC day, across restarts, never in quiet hours, and a note when it is lifted.
    The bot is armed while the pipeline runs and the owner pauses it afterwards (the first pass only records what
    already exists, as for every alert)."""

    def armed(self, now=at(14, 10, 0), quiet=None):
        engine, store, tg, ops, clock = make(now=now, cfg=RUNNING, videos=[])
        arm(engine)
        self.paused_cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo",
                                         pipeline_paused=True, quiet_hours=quiet)
        return engine, store, tg, ops, clock

    def set_cfg(self, engine, ops, cfg):
        engine.cfg = ops.cfg = cfg

    def tick(self, engine, ops, clock, **advance):
        clock.advance(**advance)
        heartbeat(ops, clock)
        return engine.tick()

    def test_it_goes_out_once_a_day_and_again_the_next_day(self):
        engine, store, tg, ops, clock = self.armed()
        self.set_cfg(engine, ops, self.paused_cfg)
        rep = self.tick(engine, ops, clock, minutes=5)
        self.assertEqual(rep.sent, 1)
        text = tg.texts()[-1]
        self.assertIn("Scheduled runs are paused by NIGHTSHIFT_PIPELINE_PAUSED", text)
        self.assertIn("tokens and providers", text)
        for hours in (1, 3, 5):                         # past the dead-man deadline of a running pipeline: still silent
            self.assertEqual(self.tick(engine, ops, clock, hours=hours).sent, 0, hours)
        self.assertNotIn("No video from channel", " ".join(tg.texts()))
        clock.now = at(15, 9, 0)                        # the next UTC day
        self.assertEqual(self.tick(engine, ops, clock, minutes=1).sent, 1)
        self.assertEqual(sum("NIGHTSHIFT_PIPELINE_PAUSED" in x for x in tg.texts()), 2)

    def test_a_restart_repeats_nothing(self):
        engine, store, tg, ops, clock = self.armed()
        self.set_cfg(engine, ops, self.paused_cfg)
        self.assertEqual(self.tick(engine, ops, clock, minutes=5).sent, 1)
        again = alerts.AlertEngine(ops, store, engine.control, self.paused_cfg, low_credits=15000)
        self.assertEqual(self.tick(again, ops, clock, minutes=5).sent, 0)

    def test_the_first_pass_only_records_it(self):
        engine, store, tg, ops, clock = make(now=at(14, 10, 0), cfg=PAUSED, videos=[])
        rep = engine.tick()
        self.assertTrue(rep.baseline)
        self.assertNotIn("NIGHTSHIFT_PIPELINE_PAUSED", " ".join(tg.texts()))
        self.assertEqual(self.tick(engine, ops, clock, minutes=5).sent, 0)         # seen at the baseline: not repeated today

    def test_quiet_hours_hold_it_and_it_is_said_after_the_window(self):
        engine, store, tg, ops, clock = self.armed(now=at(14, 21, 0), quiet=(22, 7))
        self.set_cfg(engine, ops, self.paused_cfg)
        rep = self.tick(engine, ops, clock, hours=2)                              # 23:00
        self.assertEqual((rep.sent, rep.quiet_held), (0, 1))
        clock.now = at(15, 8, 0)
        self.assertEqual(self.tick(engine, ops, clock, minutes=1).sent, 1)

    def test_a_mute_of_its_kind_silences_it(self):
        engine, store, tg, ops, clock = self.armed()
        self.set_cfg(engine, ops, self.paused_cfg)
        alerts.mute(store, "health", clock.now)
        self.assertEqual(self.tick(engine, ops, clock, minutes=5).sent, 0)

    def test_lifting_the_pause_is_followed_once_by_a_note(self):
        engine, store, tg, ops, clock = self.armed()
        self.set_cfg(engine, ops, self.paused_cfg)
        self.assertEqual(self.tick(engine, ops, clock, minutes=5).sent, 1)
        self.set_cfg(engine, ops, RUNNING)                                        # the owner removed the variable
        rep = self.tick(engine, ops, clock, minutes=10)
        self.assertEqual(rep.sent, 1)
        self.assertIn("no longer paused", tg.texts()[-1])
        self.assertEqual(self.tick(engine, ops, clock, minutes=10).sent, 0)

    def test_a_pause_that_was_never_announced_gets_no_lifted_note(self):
        engine, store, tg, ops, clock = self.armed()
        self.set_cfg(engine, ops, self.paused_cfg)
        self.set_cfg(engine, ops, RUNNING)
        self.assertEqual(self.tick(engine, ops, clock, minutes=5).sent, 0)

    def test_with_the_pause_lifted_the_dead_man_switch_works_again(self):
        engine, store, tg, ops, clock = self.armed(now=at(14, 12, 0))
        self.set_cfg(engine, ops, self.paused_cfg)
        self.assertEqual(self.tick(engine, ops, clock, minutes=5).sent, 1)        # the reminder
        self.set_cfg(engine, ops, RUNNING)
        clock.now = at(14, 18, 0)
        heartbeat(ops, clock)
        self.assertGreaterEqual(engine.tick().sent, 1)
        self.assertIn("No video from channel default", " ".join(tg.texts()))


class PreflightWarningsTestCase(unittest.TestCase):
    """tools/list_channels.py _preflight: say so when it cannot read channel pauses, keep failing open."""

    def run_preflight(self, sync, github=True):
        import contextlib
        import io
        import os
        from unittest import mock

        env = {k: v for k, v in os.environ.items() if k not in ("GITHUB_ACTIONS", PAUSE_ENV)}
        if github:
            env["GITHUB_ACTIONS"] = "true"
        err, out = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, env, clear=True), contextlib.redirect_stderr(err), \
                contextlib.redirect_stdout(out):
            list_channels._preflight(sync)
        return err.getvalue(), out.getvalue()

    class Sync:
        def __init__(self, enabled=True, rows=()):
            self.enabled, self.rows, self.reads = enabled, list(rows), []

        def select_strict(self, table, params=None):
            self.reads.append(table)
            return self.rows

    def test_in_actions_an_unconfigured_supabase_is_an_annotation_on_stderr(self):
        err, out = self.run_preflight(self.Sync(enabled=False))
        self.assertIn("::warning::Supabase is not configured - channel pauses cannot be read", err)
        self.assertEqual(out, "")

    def test_outside_actions_it_stays_quiet_for_local_runs_and_tests(self):
        err, _ = self.run_preflight(self.Sync(enabled=False), github=False)
        self.assertNotIn("not configured", err)

    def test_a_configured_supabase_does_not_warn_about_configuration(self):
        err, _ = self.run_preflight(self.Sync(rows=[{"channel_id": "default"}]))
        self.assertNotIn("not configured", err)
        self.assertNotIn("empty", err)

    def test_an_empty_channels_table_is_warned_as_a_probably_wrong_project(self):
        sync = self.Sync(rows=[])
        err, out = self.run_preflight(sync)
        self.assertEqual(sync.reads, ["channels"])
        self.assertIn("channels table is EMPTY", err)
        self.assertIn("0001", err)
        self.assertIn("::warning::", err)
        self.assertEqual(out, "")

    def test_an_empty_table_still_fails_open_to_the_default_channel(self):
        import contextlib
        import io
        from unittest import mock

        from modules.channels import ChannelRegistry
        with mock.patch.dict("os.environ", {}, clear=False), contextlib.redirect_stderr(io.StringIO()), \
                mock.patch.object(list_channels, "ChannelRegistry", lambda: ChannelRegistry([])), \
                mock.patch.dict("os.environ", {PAUSE_ENV: ""}):
            rows = list_channels.due_channels(None, sync=self.Sync(rows=[]))
        self.assertEqual([r["channel_id"] for r in rows], ["default"])

    def test_the_warnings_never_break_the_matrix_json(self):
        import contextlib
        import io
        import json
        from unittest import mock

        out = io.StringIO()
        with mock.patch.object(list_channels, "due_channels", lambda *a, **k: []), \
                mock.patch("sys.argv", ["list_channels.py"]), contextlib.redirect_stdout(out):
            list_channels.main()
        self.assertEqual(json.loads(out.getvalue()), {"include": []})


class PlumbingTestCase(unittest.TestCase):
    """The variable reaches the bot by every route it runs by."""

    def env_of(self, workflow, job, step_name):
        doc = yaml.safe_load((WORKFLOWS / workflow).read_text())
        return next(s for s in doc["jobs"][job]["steps"] if s.get("name") == step_name)["env"]

    def test_the_two_fallback_workflows_pass_the_repository_variable(self):
        expected = "${{ vars.NIGHTSHIFT_PIPELINE_PAUSED }}"
        self.assertEqual(self.env_of("operator_alerts.yml", "alerts", "Operator alerts")[PAUSE_ENV], expected)
        doc = yaml.safe_load((WORKFLOWS / "telegram_control.yml").read_text())
        envs = [s["env"] for job in doc["jobs"].values() for s in job["steps"] if "env" in s and PAUSE_ENV in s["env"]]
        self.assertEqual([e[PAUSE_ENV] for e in envs], [expected])

    def test_the_always_on_service_gets_it_like_the_deadman_hours(self):
        doc = yaml.safe_load((WORKFLOWS / "deploy_web.yml").read_text())
        env = next(s["env"] for job in doc["jobs"].values() for s in job["steps"]
                   if s.get("name") == "Build the operator-bot env")
        self.assertEqual(env["OPERATORENV_" + PAUSE_ENV], "${{ vars.NIGHTSHIFT_PIPELINE_PAUSED }}")
        self.assertEqual(env["OPERATORENV_OPERATOR_DEADMAN_HOURS"], "${{ vars.OPERATOR_DEADMAN_HOURS }}")

    def test_the_env_file_builder_treats_it_as_optional_and_the_example_lists_it(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location("bse", ROOT / "deploy" / "build-service-env.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.assertIn(PAUSE_ENV, mod.OPTIONAL["operator"])
        self.assertIn(PAUSE_ENV, mod.example_keys((ROOT / "deploy" / ".env.operator.example").read_text()))
        self.assertIn(PAUSE_ENV, mod.example_keys((ROOT / ".env.example").read_text()))

    def test_the_docs_describe_the_alert_behaviour(self):
        bot = (ROOT / "docs" / "operator-bot.md").read_text()
        self.assertIn(PAUSE_ENV, bot)
        self.assertRegex(bot, r"(?i)paused")
        self.assertIn("MISSING", bot)
        golive = (ROOT / "docs" / "VIDEO_GO_LIVE.md").read_text()
        self.assertIn("The operator bot knows about the pause", golive)
        section = golive[golive.index("The operator bot knows about the pause"):]
        self.assertRegex(section, r"(?is)dead-man.*paused|paused.*dead-man")
        self.assertIn("Deploy web", section)


if __name__ == "__main__":
    unittest.main()
