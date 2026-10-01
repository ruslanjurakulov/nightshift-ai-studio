"""The "Probe models" workflow (.github/workflows/probe_models.yml) and the
probe tool's --brief mode it runs with.

The workflow spends real money and runs with the provider keys and the
Supabase service key in a PUBLIC Actions log. So: manual only, keys only in
step env (never in the script text, never echoed), and the log and the job
summary carry model ids and fixed words only — never a vendor reply.
"""

from __future__ import annotations

import io
import logging
import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

import yaml

from modules.capabilities import ADAPTERS

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "probe_models.yml"
SECRET = "sk-live-PROBE-SECRET-0123456789abcdef"


def workflow():
    return yaml.safe_load(WORKFLOW.read_text())


def probe_step():
    for s in workflow()["jobs"]["probe"]["steps"]:
        if s.get("name") == "Probe":
            return s
    raise AssertionError("no step 'Probe' in probe_models.yml")


class ProbeWorkflowShapeTests(unittest.TestCase):
    def test_manual_only_with_an_optional_model_input(self):
        on = workflow()[True]  # YAML 1.1 reads the bare key `on` as True
        self.assertEqual(set(on), {"workflow_dispatch"})
        model = on["workflow_dispatch"]["inputs"]["model"]
        self.assertFalse(model["required"])
        self.assertEqual(model["default"], "")

    def test_one_run_at_a_time_and_read_only_token(self):
        wf = workflow()
        self.assertEqual(wf["permissions"], {"contents": "read"})
        self.assertFalse(wf["concurrency"]["cancel-in-progress"])

    def test_secrets_only_in_env_by_their_own_names_and_never_dumped(self):
        text = WORKFLOW.read_text()
        self.assertNotRegex(text, r"toJSON\(")
        env = probe_step()["env"]
        for name, expr in env.items():
            if "secrets." in str(expr):
                self.assertEqual(expr, f"${{{{ secrets.{name} }}}}", name)
        for s in workflow()["jobs"]["probe"]["steps"]:
            self.assertNotIn("${{", s.get("run", ""), s.get("name"))

    def test_the_script_never_names_a_key_variable(self):
        # Only the model id is read by the script; every key is the tool's.
        run = probe_step()["run"]
        for name in probe_step()["env"]:
            if name == "MODEL_ID":
                continue
            self.assertNotIn(f"${name}", run, name)
            self.assertNotIn(f"${{{name}", run, name)

    def test_every_adapter_can_find_a_key(self):
        env = probe_step()["env"]
        for key, cls in ADAPTERS.items():
            self.assertTrue(any(n in env for n in cls.key_env), f"{key}: map one of {cls.key_env}")
        self.assertIn("SUPABASE_SERVICE_KEY", env)
        self.assertIn("SUPABASE_URL", env)

    def test_runs_the_tool_in_brief_mode_and_records_through_it(self):
        run = probe_step()["run"]
        self.assertIn("python tools/probe_models.py", run)
        for flag in ("--brief", "--sync", "--all", "--timeout"):
            self.assertIn(flag, run)

    def test_the_summary_says_it_costs_money(self):
        self.assertIn("Costs money", probe_step()["run"])
        self.assertIn("COSTS MONEY", WORKFLOW.read_text())


FAKE_PYTHON = textwrap.dedent(
    """\
    #!/usr/bin/env bash
    # Stands in for `python tools/probe_models.py ...`: records its argv,
    # prints what --brief prints.
    printf '%s\\n' "$*" >>"$FAKE_ARGS"
    echo "synced 32 models"
    echo "ok veo-3.1-lite"
    echo "failed kling-v3 auth"
    echo "skipped elevenlabs-v3"
    exit "${FAKE_RC:-1}"
    """
)


@unittest.skipUnless(shutil.which("bash"), "bash not installed")
class ProbeStepScriptTests(unittest.TestCase):
    """Runs the workflow's own `Probe` script with every key set to a secret."""

    def run_step(self, model=""):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        bindir = tmp / "bin"
        bindir.mkdir()
        (bindir / "python").write_text(FAKE_PYTHON)
        (bindir / "python").chmod(0o755)
        summary = tmp / "summary"
        env = {k: SECRET for k in probe_step()["env"]}
        env.update(
            MODEL_ID=model,
            PATH=f"{bindir}:{os.environ['PATH']}",
            HOME=str(tmp),
            RUNNER_TEMP=str(tmp),
            GITHUB_STEP_SUMMARY=str(summary),
            FAKE_ARGS=str(tmp / "args"),
        )
        proc = subprocess.run(
            ["bash", "-e", "-c", probe_step()["run"]], cwd=ROOT, env=env, capture_output=True, text=True, timeout=30
        )
        args = (tmp / "args").read_text() if (tmp / "args").exists() else ""
        return proc, (summary.read_text() if summary.exists() else ""), args

    def test_all_models_by_default_and_no_secret_in_log_or_summary(self):
        proc, summary, args = self.run_step()
        self.assertIn("--all", args)
        self.assertIn("--brief", args)
        self.assertNotIn("--model", args)
        for text in (proc.stdout, proc.stderr, summary, args):
            self.assertNotIn(SECRET, text)
        self.assertIn("ok: 1 · failed: 1 · skipped: 1", summary)
        self.assertIn("failed kling-v3 auth", summary)
        self.assertIn("Costs money", summary)
        # The tool's exit code is the job's: a failed probe paints it red.
        self.assertEqual(proc.returncode, 1)

    def test_one_model_by_id(self):
        proc, _, args = self.run_step("veo-3.1-lite")
        self.assertIn("--model veo-3.1-lite", args)
        self.assertNotIn("--all", args)

    def test_a_hostile_model_input_is_refused_before_anything_runs(self):
        proc, summary, args = self.run_step('x"; echo $SUPABASE_SERVICE_KEY; "')
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(args, "")
        self.assertIn("must be one id", proc.stdout)
        self.assertNotIn(SECRET, proc.stdout + proc.stderr + summary)


class BriefModeTests(unittest.TestCase):
    """tools/probe_models.py --brief: ids and fixed words, nothing else."""

    def run_tool(self, argv, env, result=None, side_effect=None):
        from tools import probe_models

        out, db = io.StringIO(), mock.Mock()
        db.sync.return_value = 32
        with mock.patch.object(probe_models, "run_probe", return_value=result, side_effect=side_effect):
            code = probe_models.main(argv, env=env, db=db, stream=out)
        for h in list(logging.getLogger().handlers):
            logging.getLogger().removeHandler(h)
        return code, out.getvalue(), db

    def test_a_failure_prints_id_and_typed_code_only(self):
        from tools import probe_models

        bad = probe_models.ProbeResult("ideogram-3", False, "auth", f"vendor said: key {SECRET} rejected", 12)
        code, text, db = self.run_tool(["--brief", "--sync", "--model", "ideogram-3"],
                                       {"IDEOGRAM_API_KEY": SECRET}, bad)
        self.assertEqual(code, 1)
        self.assertEqual(text.splitlines(), ["synced 32 models into model_registry", "failed ideogram-3 auth"])
        # Recorded the same way as without --brief: details go to the database.
        self.assertEqual(db.record.call_args.kwargs["ok"], False)

    def test_an_unknown_code_is_not_printed(self):
        from tools import probe_models

        odd = probe_models.ProbeResult("ideogram-3", False, "vendor-text-here", "x", 1)
        _, text, _ = self.run_tool(["--brief", "--model", "ideogram-3"], {}, odd)
        self.assertEqual(text.strip(), "failed ideogram-3 other")

    def test_ok_and_skipped(self):
        from tools import probe_models

        ok = probe_models.ProbeResult("elevenlabs-sfx", True, latency_ms=10, output_bytes=5)
        _, text, _ = self.run_tool(["--brief", "--model", "elevenlabs-sfx"], {}, ok)
        self.assertEqual(text.strip(), "ok elevenlabs-sfx")
        skip = probe_models.ProbeResult("veo-3.1", False, "not_configured", "no key for video.veo")
        code, text, db = self.run_tool(["--brief", "--model", "veo-3.1"], {}, skip)
        self.assertEqual((code, text.strip()), (0, "skipped veo-3.1"))
        db.record.assert_not_called()

    def test_an_unexpected_error_prints_its_class_name_only(self):
        code, text, _ = self.run_tool(["--brief", "--model", "veo-3.1"], {"VEO_API_KEY": SECRET},
                                      side_effect=ValueError(f"https://x.test/?key={SECRET}"))
        self.assertEqual(code, 1)
        self.assertEqual(text.strip(), "stopped: ValueError")


if __name__ == "__main__":
    unittest.main()
