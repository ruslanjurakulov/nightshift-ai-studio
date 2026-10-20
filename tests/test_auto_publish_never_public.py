"""The Command Center's auto-publish switch OFF means "never public".

``channels.auto_publish`` (migration 0004, default false) is what the switch
writes; its copy says "Videos stay private until you approve them". The pipeline
never read it, so ``--privacy public`` / ``YOUTUBE_PRIVACY=public`` published a
video on a channel whose switch was off. Now the run clamps its privacy to
private unless the switch is exactly ON.

What it does NOT do: it does not stop the upload (uploads stay private, as
today), does not change ``ctx.auto_publish`` / ``agent_config.auto_publish``,
does not touch video_review, and ON does not make anything public by itself
(the publish gate and approvals still decide what a requested privacy may do).

An absent column (channels.json, the legacy default channel synthesized when the
registry is unreadable, a database from before 0004, a context built in code) is
unknown, and unknown is private (audit H7; it used to be unrestricted). A column
that is present and not exactly True (False, NULL, "true", 1) is off.

Synthetic data only: no network, no Supabase, no YouTube.
"""

import ast
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

from modules.channels import (
    ChannelContext,
    ChannelRegistry,
    effective_privacy,
    ui_auto_publish_from_row,
)

MAIN = Path(__file__).resolve().parent.parent / "main.py"
_UNSET = object()


def _row(channel_id="news", *, column=_UNSET) -> dict:
    row = {
        "channel_id": channel_id,
        "name": channel_id,
        "niche": "tech",
        "status": "ACTIVE",
        "agent_config": {"language": "English"},
        "schedule_config": {"enabled": True, "publish_hour_utc": 15},
        "credential_ref": {"youtube_channel_id": f"UC{channel_id}", "verified_at": "2026-09-01T00:00:00Z"},
    }
    if column is not _UNSET:
        row["auto_publish"] = column
    return row


def _ctx(**kw) -> ChannelContext:
    return ChannelContext.from_dict(_row(**kw))


class EffectivePrivacyTestCase(unittest.TestCase):
    def test_off_clamps_everything_to_private(self):
        for asked in ("public", "unlisted", "private", "PUBLIC", "", None, "bogus"):
            with self.subTest(asked=asked):
                self.assertEqual(effective_privacy(asked, False), "private")

    def test_on_passes_the_request_through(self):
        for asked in ("public", "unlisted", "private"):
            self.assertEqual(effective_privacy(asked, True), asked)

    def test_no_switch_could_be_read_fails_closed(self):
        # Was "unrestricted as today" (audit H7): an unknown is not a yes. The full table is
        # tests/test_effective_privacy_fail_closed.py.
        for asked in ("public", "unlisted", "private"):
            self.assertEqual(effective_privacy(asked, None), "private")


class ColumnReaderTestCase(unittest.TestCase):
    def test_absent_is_none(self):
        self.assertIsNone(ui_auto_publish_from_row({}))
        self.assertIsNone(ui_auto_publish_from_row(None))
        self.assertIsNone(ui_auto_publish_from_row({"agent_config": {"auto_publish": True}}))

    def test_exactly_true_is_on(self):
        self.assertIs(ui_auto_publish_from_row({"auto_publish": True}), True)

    def test_false_null_and_junk_are_off(self):
        for v in (False, None, "true", "True", 1, "", 0, "on", []):
            with self.subTest(value=v):
                self.assertIs(ui_auto_publish_from_row({"auto_publish": v}), False)


class ContextFromDictTestCase(unittest.TestCase):
    def test_ctx_carries_the_switch(self):
        self.assertIs(_ctx(column=True).ui_auto_publish, True)
        self.assertIs(_ctx(column=False).ui_auto_publish, False)
        self.assertIs(_ctx(column=None).ui_auto_publish, False)
        self.assertIsNone(_ctx().ui_auto_publish)
        self.assertIs(_ctx(column="true").ui_auto_publish, False)
        self.assertIs(_ctx(column=1).ui_auto_publish, False)

    def test_publishing_semantics_are_untouched(self):
        # ctx.auto_publish is still agent_config.auto_publish alone (default TRUE),
        # and the switch is not written into agent_config by the mirror's to_dict().
        off = _ctx(column=False)
        self.assertTrue(off.auto_publish)
        self.assertTrue(off.agent.auto_publish)
        self.assertNotIn("auto_publish", off.to_dict())
        self.assertTrue(off.to_dict()["agent_config"]["auto_publish"])

    def test_code_built_contexts_carry_no_switch(self):
        c = ChannelContext(channel_id="default", name="X", niche="h")
        self.assertIsNone(c.ui_auto_publish)
        self.assertEqual(effective_privacy("public", c.ui_auto_publish), "private")


class ChannelsJsonTestCase(unittest.TestCase):
    def registry(self, rows):
        d = tempfile.mkdtemp()
        self.addCleanup(lambda: [os.remove(os.path.join(d, f)) or None for f in os.listdir(d)] and os.rmdir(d))
        path = Path(d) / "channels.json"
        path.write_text(json.dumps({"channels": rows}), encoding="utf-8")
        sync = MagicMock()
        sync.enabled = False
        return ChannelRegistry(file_path=path, sync=sync)

    def test_stray_top_level_auto_publish_is_not_the_ui_switch(self):
        for stray in (False, True, None):
            with self.subTest(stray=stray), self.assertLogs("modules.channels", level="WARNING") as logs:
                c = self.registry([_row("news", column=stray)]).get("news")
                self.assertIsNone(c.ui_auto_publish)
                self.assertEqual(effective_privacy("public", c.ui_auto_publish), "private")
            self.assertTrue(any("auto_publish" in m for m in logs.output))

    def test_clean_file_row_has_no_switch(self):
        self.assertIsNone(self.registry([_row("news")]).get("news").ui_auto_publish)

    def test_database_rows_carry_the_switch(self):
        sync = MagicMock()
        sync.enabled = True
        sync.select.return_value = [_row("news", column=False), _row("ok", column=True), _row("old")]
        reg = ChannelRegistry(sync=sync, file_path=Path("/nonexistent/channels.json"))
        self.assertIs(reg.get("news").ui_auto_publish, False)
        self.assertIs(reg.get("ok").ui_auto_publish, True)
        self.assertIsNone(reg.get("old").ui_auto_publish)


class RunPrivacySeamTestCase(unittest.TestCase):
    """main._effective_privacy is the seam run() computes the upload privacy
    with. Drive run() up to it with the registry mocked, then check the value
    it hands back and what is logged."""

    # Runs in a child interpreter on purpose: `import main` pulls in torch,
    # cv2 and moviepy, and a test process that large makes the peak-RSS check
    # of the media-library ffmpeg runner (it reads wait4's ru_maxrss, which a
    # forked child inherits from its parent) refuse small clips in other test
    # modules of the same discover run.
    _CHILD = """
import json, logging, os, sys, tempfile
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
row, privacy = json.loads(sys.argv[2]), sys.argv[3]
import main
from modules.channels import ChannelContext

class Stop(Exception):
    pass

records = []
class H(logging.Handler):
    def emit(self, r):
        records.append([r.levelname, r.getMessage()])
logging.getLogger("chronos").addHandler(H())
ctx = ChannelContext.from_dict(row)
seen = {}
real = main._effective_privacy
def spy(c, p):
    seen["same_ctx"], seen["asked"], seen["out"] = c is ctx, p, real(c, p)
    raise Stop
os.chdir(tempfile.mkdtemp())
with patch.object(main, "_effective_privacy", spy), patch.object(main, "resolve_channel", return_value=ctx):
    try:
        main.run(privacy=privacy, channel=ctx.channel_id)
    except Stop:
        pass
seen["warnings"] = [m for lvl, m in records if lvl == "WARNING"]
print("RESULT " + json.dumps(seen))
"""

    def drive(self, row, privacy):
        root = str(Path(__file__).resolve().parent.parent)
        proc = subprocess.run(
            [sys.executable, "-I", "-c", self._CHILD, root, json.dumps(row), privacy],
            capture_output=True, text=True, timeout=300, cwd=tempfile.gettempdir())
        line = next((l for l in proc.stdout.splitlines() if l.startswith("RESULT ")), None)
        self.assertIsNotNone(line, proc.stderr[-2000:])
        seen = json.loads(line[len("RESULT "):])
        self.assertTrue(seen["same_ctx"])
        self.assertEqual(seen["asked"], privacy)
        self.last_warnings = seen["warnings"]
        return seen["out"]

    def test_switch_off_and_public_requested_uploads_private(self):
        self.assertEqual(self.drive(_row(column=False), "public"), "private")
        self.assertEqual(len(self.last_warnings), 1)
        self.assertIn("not ON", self.last_warnings[0])
        self.assertIn("private", self.last_warnings[0])

    def test_null_or_junk_switch_and_public_uploads_private(self):
        for v in (None, "true", 1):
            with self.subTest(column=v):
                self.assertEqual(self.drive(_row(column=v), "public"), "private")

    def test_switch_off_and_unlisted_uploads_private(self):
        self.assertEqual(self.drive(_row(column=False), "unlisted"), "private")

    def test_switch_off_and_private_is_quiet(self):
        self.assertEqual(self.drive(_row(column=False), "private"), "private")
        self.assertEqual(self.last_warnings, [])

    def test_switch_on_and_public_is_allowed_through_to_the_gate(self):
        self.assertEqual(self.drive(_row(column=True), "public"), "public")
        self.assertEqual(self.last_warnings, [])

    def test_absent_column_and_public_uploads_private_and_says_why(self):
        # Was "unchanged": a switch that could not be read is not a yes (audit H7).
        self.assertEqual(self.drive(_row(), "public"), "private")
        self.assertEqual(len(self.last_warnings), 1)
        self.assertIn("No auto-publish switch could be read", self.last_warnings[0])

    def test_absent_column_and_private_is_quiet(self):
        self.assertEqual(self.drive(_row(), "private"), "private")
        self.assertEqual(self.last_warnings, [])

    def test_run_uses_the_clamped_value_everywhere(self):
        """In run(): `privacy` is assigned exactly once, from the seam, before
        any other read; the upload and the Short are handed that same local."""
        tree = ast.parse(MAIN.read_text(encoding="utf-8"))
        run = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "run")
        stores = [n for n in ast.walk(run) if isinstance(n, ast.Name) and n.id == "privacy"
                  and isinstance(n.ctx, ast.Store)]
        self.assertEqual(len(stores), 1)
        assign = next(n for n in ast.walk(run) if isinstance(n, ast.Assign)
                      and any(isinstance(t, ast.Name) and t.id == "privacy" for t in n.targets))
        self.assertIsInstance(assign.value, ast.Call)
        self.assertEqual(getattr(assign.value.func, "id", None), "_effective_privacy")
        loads = [n for n in ast.walk(run) if isinstance(n, ast.Name) and n.id == "privacy"
                 and isinstance(n.ctx, ast.Load)]
        self.assertTrue(all(n.lineno >= assign.lineno for n in loads),
                        "something reads `privacy` before it is clamped")
        uploads = [c for c in ast.walk(run) if isinstance(c, ast.Call)
                   and isinstance(c.func, ast.Attribute) and c.func.attr == "upload"
                   and any(k.arg == "privacy" and isinstance(k.value, ast.Name) and k.value.id == "privacy"
                           for k in c.keywords)]
        self.assertTrue(uploads, "uploader.upload must be passed the clamped `privacy`")


if __name__ == "__main__":
    unittest.main()
