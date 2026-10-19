"""A video run refuses to start on a nearly full disk, before it spends anything.

What would break without these: a worker volume that fills up (a render writes several GB under output/ and
nothing removes a finished run) kills the render with "No space left on device" AFTER topic, research, script
and voice were paid for. main._preflight_disk is the early stop; NIGHTSHIFT_MIN_FREE_DISK_GB sets how much a
run needs. No network, no provider, and no dependence on the disk of the machine that runs the tests.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import disk_guard as dg  # noqa: E402
from modules import render_error  # noqa: E402

GB = dg.GB


class ConfiguredThreshold(unittest.TestCase):
    ENV = dg.MIN_FREE_ENV

    def test_the_default_is_5_gb_when_unset_or_blank(self):
        self.assertEqual(dg.configured_min_bytes({}), 5 * GB)
        self.assertEqual(dg.configured_min_bytes({self.ENV: "  "}), 5 * GB)
        self.assertEqual(dg.configured_min_bytes({self.ENV: ""}), dg.MIN_FREE_BYTES)   # what the deploy writes for an unset variable

    def test_it_reads_the_real_environment_by_default(self):
        with mock.patch.dict(os.environ, {self.ENV: "8"}):
            self.assertEqual(dg.configured_min_bytes(), 8 * GB)

    def test_a_number_of_gb_sets_it_fractions_included(self):
        self.assertEqual(dg.configured_min_bytes({self.ENV: "12"}), 12 * GB)
        self.assertEqual(dg.configured_min_bytes({self.ENV: " 2.5 "}), int(2.5 * GB))

    def test_zero_turns_it_off_on_purpose(self):
        self.assertEqual(dg.configured_min_bytes({self.ENV: "0"}), 0)
        self.assertEqual(dg.require_free_disk(Path("/out"), 0, free_fn=lambda p: 0), 0)

    def test_a_typo_never_disables_the_guard_and_is_not_echoed(self):
        for bad in ("five", "-1", "nan", "inf", "5GB", "1e999"):
            with self.subTest(bad=bad), self.assertLogs("modules.disk_guard", level="WARNING") as logs:
                self.assertEqual(dg.configured_min_bytes({self.ENV: bad}), dg.MIN_FREE_BYTES)
            self.assertNotIn(bad, " ".join(logs.output).replace(self.ENV, ""))

    def test_the_refusal_names_the_configured_size_not_a_rounded_one(self):
        with self.assertRaises(dg.InsufficientDisk) as caught:
            dg.require_free_disk(Path("/out"), int(2.5 * GB), free_fn=lambda p: 1 * GB)
        self.assertIn("at least 2.5 GB", str(caught.exception))
        self.assertIn("1.0 GB free", str(caught.exception))
        self.assertIn("--prune-days", str(caught.exception))                 # and what to do about it

    def test_the_variable_can_reach_the_worker(self):
        example = (ROOT / "deploy" / ".env.worker.example").read_text()
        flow = (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text()
        self.assertIn(f"\n{self.ENV}=", example)
        self.assertIn(f"WORKERENV_{self.ENV}: ${{{{ vars.{self.ENV} }}}}", flow)


class MainPreflightDisk(unittest.TestCase):
    def setUp(self):
        import main  # noqa: PLC0415
        self.main = main

    def test_a_nearly_full_volume_stops_the_run_and_records_why(self):
        with mock.patch.dict(os.environ, {dg.MIN_FREE_ENV: ""}), mock.patch.object(self.main.events, "emit") as emit:
            with self.assertRaises(dg.InsufficientDisk) as caught:
                self.main._preflight_disk("chan", free_fn=lambda p: 3 * GB)
        self.assertIn("3.0 GB free", str(caught.exception))
        meta = emit.call_args.kwargs["metadata"]
        self.assertEqual(meta["stage"], "preflight")
        self.assertIn("InsufficientDisk", meta["error"])
        self.assertEqual(emit.call_args.kwargs["agent"], "disk_guard")

    def test_enough_room_passes_quietly(self):
        with mock.patch.dict(os.environ, {dg.MIN_FREE_ENV: ""}), mock.patch.object(self.main.events, "emit") as emit:
            self.main._preflight_disk("chan", free_fn=lambda p: 5 * GB)
        emit.assert_not_called()

    def test_the_env_threshold_decides(self):
        with mock.patch.object(self.main.events, "emit"):
            with mock.patch.dict(os.environ, {dg.MIN_FREE_ENV: "1"}):
                self.main._preflight_disk("chan", free_fn=lambda p: 2 * GB)          # 2 GB is plenty for a 1 GB bar
            with mock.patch.dict(os.environ, {dg.MIN_FREE_ENV: "20"}):
                with self.assertRaises(dg.InsufficientDisk):
                    self.main._preflight_disk("chan", free_fn=lambda p: 10 * GB)     # and not for a 20 GB one
            with mock.patch.dict(os.environ, {dg.MIN_FREE_ENV: "0"}):
                self.main._preflight_disk("chan", free_fn=lambda p: 0)               # off on purpose

    def test_it_measures_the_volume_that_holds_output(self):
        seen = []
        with mock.patch.dict(os.environ, {dg.MIN_FREE_ENV: ""}):
            self.main._preflight_disk("chan", free_fn=lambda p: seen.append(Path(p)) or 50 * GB)
        self.assertEqual(seen, [Path(self.main.OUTPUT_DIR)])

    def test_a_volume_that_cannot_be_measured_is_a_warning_not_a_refusal(self):
        def broken(path):
            raise OSError("stat failed")
        with mock.patch.object(self.main.events, "emit") as emit, self.assertLogs(level="WARNING") as logs:
            self.main._preflight_disk("chan", free_fn=broken)
        self.assertTrue(any("could not be measured" in m for m in logs.output))
        emit.assert_not_called()

    def test_the_refusal_is_coded_render_for_the_customer_not_unknown(self):
        with self.assertRaises(dg.InsufficientDisk) as caught:
            dg.require_free_disk(Path("/out"), 5 * GB, free_fn=lambda p: 1 * GB)
        last = f"modules.disk_guard.{type(caught.exception).__name__}: {caught.exception}"
        tail = ["Traceback (most recent call last):", '  File "main.py", line 1, in run', last]
        self.assertEqual(render_error.classify("main.py exited with code 1", tail), render_error.RENDER)


class RunStopsEarly(unittest.TestCase):
    """run() itself, with the credential report stubbed: a full disk stops it before the budget read, the
    voice check, the media fetcher or any Gemini call."""

    def setUp(self):
        import main  # noqa: PLC0415
        from modules.channels import ChannelContext  # noqa: PLC0415
        self.main = main
        self.cwd = os.getcwd()
        self.tmp = tempfile.TemporaryDirectory()
        os.chdir(self.tmp.name)          # run() makes ./logs
        self.ctx = ChannelContext(channel_id="default", name="X", niche="h")

    def tearDown(self):
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def ok_health(self):
        from modules.credential_health import CredentialCheck, HealthReport  # noqa: PLC0415
        return HealthReport("default", (CredentialCheck("gemini", "ok", required=True),))

    def test_a_full_disk_refuses_the_run_before_anything_is_spent(self):
        ctx = replace(self.ctx, agent=replace(self.ctx.agent, spend_ceiling_usd=1.0))
        with mock.patch.dict(os.environ, {dg.MIN_FREE_ENV: ""}), \
                mock.patch.object(dg, "free_bytes", lambda p: 1 * GB), \
                mock.patch.object(self.main, "check_run_credentials", return_value=self.ok_health()), \
                mock.patch.object(self.main.events, "emit"), \
                mock.patch.object(self.main, "StateStore", side_effect=AssertionError("budget read")), \
                mock.patch.object(self.main, "verify_voice", side_effect=AssertionError("voice checked")), \
                mock.patch.object(self.main, "MediaFetcher", side_effect=AssertionError("fetched")), \
                mock.patch.object(self.main, "ScriptEngine", side_effect=AssertionError("script paid for")):
            with self.assertRaises(dg.InsufficientDisk):
                self.main.run(channel=ctx, skip_upload=True)

    def test_the_stop_comes_after_the_credential_report_and_before_every_other_stage(self):
        src = (ROOT / "main.py").read_text()
        body = src[src.index("\ndef run("):]
        call = body.index("\n    _preflight_disk(channel_id)\n")
        self.assertGreater(call, body.index("raise CredentialsMissing("))
        for later in ("budget.check_budget(", "costs = CostLedger(", "ensure_assets(", "verify_voice(ctx)",
                      "video_providers.preflight()", "_preflight_pictures(ctx, series_obj, channel_id)",
                      "ScriptEngine(channel=ctx)"):
            self.assertLess(call, body.index(later), f"{later} runs before the disk check")


if __name__ == "__main__":
    unittest.main()
