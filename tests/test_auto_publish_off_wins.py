"""The Command Center's auto-publish switch wins when it is OFF.

Two fields carry "auto publish":

* ``agent_config.auto_publish`` -- a key in the channel's JSON blob, default
  TRUE, which main.py reads through ``ctx.auto_publish`` to decide whether an
  allowed video uploads at all;
* ``channels.auto_publish`` -- the boolean COLUMN (migration 0004, default
  false) the Command Center's switch writes.

main.py used to read only the first, so switching the UI off changed nothing.
The effective value is now the AND of both: either one off holds the video.

What an absent value means: a source that carries no ``auto_publish`` column at
all (channels.json, the legacy default channel, a database from before 0004, a
context built in code) has no UI switch to obey, so it is unrestricted and the
agent_config key decides alone -- exactly as before. A column that is present
and not plainly True (False, or a NULL the NOT NULL column cannot hold) is off.

Synthetic rows only: no network, no Supabase, no YouTube.
"""

import ast
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import MagicMock, patch

from modules import run_request
from modules.channels import (
    AgentConfig,
    ChannelContext,
    ChannelRegistry,
    reset_registry,
    resolve_auto_publish,
    resolve_channel,
    ui_auto_publish_from_row,
)
from tools import list_channels

MAIN = Path(__file__).resolve().parent.parent / "main.py"
_UNSET = object()


def _row(channel_id="news", *, column=_UNSET, agent=_UNSET, hour=15) -> dict:
    """A `channels` row as PostgREST returns it (select=*). `column` is the
    UI switch; `agent` is agent_config.auto_publish. _UNSET leaves the key out."""
    row = {
        "channel_id": channel_id,
        "name": channel_id,
        "niche": "tech",
        "status": "ACTIVE",
        "agent_config": {"language": "English"},
        "schedule_config": {"enabled": True, "publish_hour_utc": hour},
        "credential_ref": {"youtube_channel_id": f"UC{channel_id}", "verified_at": "2026-09-01T00:00:00Z"},
    }
    if column is not _UNSET:
        row["auto_publish"] = column
    if agent is not _UNSET:
        row["agent_config"]["auto_publish"] = agent
    return row


def _fake_sync(*rows):
    sync = MagicMock()
    sync.enabled = True
    sync.select.return_value = list(rows)
    return sync


class ResolutionFunctionTestCase(unittest.TestCase):
    def test_off_wins_truth_table(self):
        self.assertFalse(resolve_auto_publish(True, False))   # UI off, agent on  -> no upload
        self.assertFalse(resolve_auto_publish(False, True))   # UI on, agent off  -> no upload
        self.assertFalse(resolve_auto_publish(False, False))
        self.assertTrue(resolve_auto_publish(True, True))     # both on -> allowed
        self.assertTrue(resolve_auto_publish(True, None))     # no switch carried -> agent decides
        self.assertFalse(resolve_auto_publish(False, None))

    def test_column_reader_absent_is_none(self):
        self.assertIsNone(ui_auto_publish_from_row({}))
        self.assertIsNone(ui_auto_publish_from_row(None))
        self.assertIsNone(ui_auto_publish_from_row({"channel_id": "x", "agent_config": {"auto_publish": True}}))

    def test_column_reader_present_values(self):
        self.assertIs(ui_auto_publish_from_row({"auto_publish": True}), True)
        self.assertIs(ui_auto_publish_from_row({"auto_publish": False}), False)

    def test_column_reader_null_or_junk_fails_closed(self):
        for junk in (None, "true", 1, "", 0, "on"):
            with self.subTest(value=junk):
                self.assertIs(ui_auto_publish_from_row({"auto_publish": junk}), False)


class ContextConstructionTestCase(unittest.TestCase):
    """ChannelContext.from_dict is where every path's ctx is built."""

    def ctx(self, **kw):
        return ChannelContext.from_dict(_row(**kw))

    def test_ui_off_agent_true_blocks_upload(self):
        self.assertFalse(self.ctx(column=False, agent=True).auto_publish)

    def test_ui_off_agent_absent_blocks_upload(self):
        # agent_config.auto_publish absent defaults TRUE; the switch still wins.
        c = self.ctx(column=False)
        self.assertTrue(c.agent.auto_publish)
        self.assertFalse(c.auto_publish)

    def test_ui_on_agent_false_blocks_upload(self):
        self.assertFalse(self.ctx(column=True, agent=False).auto_publish)

    def test_both_on_allows_upload(self):
        self.assertTrue(self.ctx(column=True, agent=True).auto_publish)
        self.assertTrue(self.ctx(column=True).auto_publish)

    def test_column_absent_is_unrestricted(self):
        c = self.ctx()
        self.assertIsNone(c.ui_auto_publish)
        self.assertTrue(c.auto_publish)
        self.assertFalse(self.ctx(agent=False).auto_publish)

    def test_column_null_is_off(self):
        self.assertFalse(self.ctx(column=None, agent=True).auto_publish)

    def test_agent_config_is_not_rewritten(self):
        # to_dict() is what the registry mirror writes back to Supabase: the
        # switch must not leak into agent_config.
        c = self.ctx(column=False, agent=True)
        self.assertTrue(c.agent.auto_publish)
        self.assertTrue(c.to_dict()["agent_config"]["auto_publish"])
        self.assertNotIn("auto_publish", c.to_dict())

    def test_contexts_built_in_code_are_unrestricted(self):
        self.assertTrue(ChannelContext(channel_id="default", name="X", niche="h").auto_publish)
        off = ChannelContext(channel_id="default", name="X", niche="h",
                             agent=AgentConfig.from_dict({"auto_publish": False}))
        self.assertFalse(off.auto_publish)

    def test_per_run_overrides_keep_the_switch(self):
        # main.run copies the ctx with dataclasses.replace for --language etc.
        c = replace(self.ctx(column=False), agent=replace(self.ctx(column=False).agent, language="Arabic"))
        self.assertFalse(c.auto_publish)


class EntryPathsTestCase(unittest.TestCase):
    """Every entry path ends in main.run -> resolve_channel -> the registry's
    `channels` read. The same rows, read the way each path reads them."""

    def setUp(self):
        reset_registry()
        self.addCleanup(reset_registry)

    def registry(self, *rows):
        return ChannelRegistry(sync=_fake_sync(*rows), file_path=Path("/nonexistent/channels.json"))

    def test_cron_matrix_then_run_context(self):
        # daily_video.yml `resolve` job: tools/list_channels.py --due-hour.
        reg = self.registry(_row("news", column=False, agent=True, hour=7))
        self.assertEqual([r["channel_id"] for r in list_channels.due_channels(7, registry=reg)], ["news"])
        # The make-video job then runs `main.py --channel news`, which resolves ctx:
        with patch("modules.supabase_sync.SupabaseSync", return_value=_fake_sync(_row("news", column=False, agent=True, hour=7))):
            self.assertFalse(resolve_channel("news").auto_publish)

    def test_run_now_actions_dispatch(self):
        # Run now (backend actions) dispatches the same workflow: --channel + --privacy private.
        with patch("modules.supabase_sync.SupabaseSync", return_value=_fake_sync(_row("acme", column=False))):
            ctx = resolve_channel("acme")
        self.assertFalse(ctx.auto_publish)

    def test_run_now_queue_worker(self):
        # render_jobs -> queue_worker -> run_request argv -> main.py subprocess.
        argv, env, _ = run_request.plan_run("acme", "daily", {}, {})
        self.assertEqual(argv[:4], ["--channel", "acme", "--privacy", "private"])
        self.assertEqual(env["YOUTUBE_PRIVACY"], "private")
        self.assertNotIn("--no-upload", argv)
        with patch("modules.supabase_sync.SupabaseSync", return_value=_fake_sync(_row("acme", column=False, agent=True))):
            self.assertFalse(resolve_channel(argv[1]).auto_publish)

    def test_cli_default_channel(self):
        # `python main.py` with no --channel resolves "default".
        with patch("modules.supabase_sync.SupabaseSync", return_value=_fake_sync(_row("default", column=False))):
            self.assertFalse(resolve_channel(None).auto_publish)

    def test_both_on_still_uploads_on_every_path(self):
        rows = (_row("news", column=True, agent=True), _row("default", column=True))
        with patch("modules.supabase_sync.SupabaseSync", return_value=_fake_sync(*rows)):
            self.assertTrue(resolve_channel("news").auto_publish)
            self.assertTrue(resolve_channel(None).auto_publish)

    def test_database_without_the_column_is_unchanged(self):
        # A deployment without migration 0004: rows have no `auto_publish` key.
        with patch("modules.supabase_sync.SupabaseSync", return_value=_fake_sync(_row("news"))):
            self.assertTrue(resolve_channel("news").auto_publish)

    def test_channels_json_and_legacy_default_are_unchanged(self):
        reg = ChannelRegistry([], file_path=Path("/nonexistent/channels.json"), sync=None)
        self.assertTrue(reg.get().auto_publish)  # synthesized legacy default


class MainConsultsTheResolvedValueTestCase(unittest.TestCase):
    """main.py must read the resolved ctx.auto_publish, never ctx.agent.auto_publish
    (which ignores the switch), and must still gate the upload on it."""

    @classmethod
    def setUpClass(cls):
        cls.tree = ast.parse(MAIN.read_text(encoding="utf-8"))

    def test_main_reads_ctx_auto_publish_not_the_agent_key(self):
        reads = [n for n in ast.walk(self.tree)
                 if isinstance(n, ast.Attribute) and n.attr == "auto_publish"]
        self.assertTrue(reads)
        for n in reads:
            inner = n.value
            self.assertFalse(isinstance(inner, ast.Attribute) and inner.attr == "agent",
                             "main.py must not read ctx.agent.auto_publish directly")
        assigned = [n for n in ast.walk(self.tree)
                    if isinstance(n, ast.Assign)
                    and any(isinstance(t, ast.Name) and t.id == "auto_publish" for t in n.targets)
                    and isinstance(n.value, ast.Attribute) and n.value.attr == "auto_publish"
                    and isinstance(n.value.value, ast.Name) and n.value.value.id == "ctx"]
        self.assertTrue(assigned, "main.py must set auto_publish = ctx.auto_publish")


if __name__ == "__main__":
    unittest.main()
