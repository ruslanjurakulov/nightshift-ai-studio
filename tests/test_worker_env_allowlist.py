"""The worker's environment: every setting config.py reads must be able to reach
the worker, or be on an explicit list of settings that deliberately do not.

What would break without these:

* a value the code reads (a model, a host, a USD cap, a unit price) that no
  workflow maps, so setting it in GitHub does nothing and nobody is told;
* an empty variable (the deploy writes ``KEY=`` for every key) replacing a code
  default with an empty string;
* an empty key, or a provider switch on with its key empty, passing without a
  word in the deploy log.
"""

from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

EXAMPLE = ROOT / "deploy" / ".env.worker.example"
WORKFLOW = ROOT / ".github" / "workflows" / "deploy_web.yml"
BUILD = ROOT / "deploy" / "build-worker-env.py"

#: What config.py reads and the worker deliberately does NOT get, and why. A name
#: here that config.py stopped reading, or that is also in the allow-list, fails.
NOT_DEPLOYED = {
    "BLAS_THREADS": "tuning for a laptop; the image sets sane thread pools",
    "CHRONOS_ENABLE_REVENUE": "revenue experiments are an Actions-only opt-in",
    "CHRONOS_GEMINI_STRUCTURED_OUTPUT": "a default-off spike (roadmap #50)",
    "CHRONOS_THUMBNAIL_VARIANTS": "A/B width, not a provider setting",
    "ELEVENLABS_RUN_VOICE_ID": "per-run: tools/queue_worker passes it from the job's parameters",
    "GEMINI_MAX_RETRIES": "retry tuning; the code default is the tested one",
    "GEMINI_RETRY_MAX_DELAY": "retry tuning; the code default is the tested one",
    "MUSIC_VOLUME": "mix levels are the channel's, not the deployment's",
    "NARRATOR_VOLUME": "mix levels are the channel's, not the deployment's",
    "SFX_VOLUME": "mix levels are the channel's, not the deployment's",
    "SCRIPT_LANGUAGE": "per-run: run_request passes the job's language",
    "SUBTITLE_HIGHLIGHT_COLOR": "a style, not a deployment setting",
    "VIDEO_DURATION_TARGET": "per-run: the job's duration",
    "VIDIQ_BASE_URL": "advisory research host; the code default is vidIQ's",
    "VIDIQ_KEYWORDS_PATH": "advisory research path; the code default is vidIQ's",
    "VIDIQ_TITLE_SCORE_PATH": "advisory research path; the code default is vidIQ's",
    "VIDIQ_TIMEOUT": "advisory research timeout",
    "YOUTUBE_CLIENT_SECRET_FILE": "the worker writes client_secret.json itself from YOUTUBE_CLIENT_SECRET_JSON",
    "YOUTUBE_PRIVACY": "CLAUDE.md #2: privacy is private by default and never set by a deployment variable; "
                       "each run passes --privacy",
    "LEONARDO_BASE_URL": "one global host",
}


def example_keys() -> list:
    return re.findall(r"^([A-Z][A-Z0-9_]*)=", EXAMPLE.read_text(), re.M)


def config_env_names() -> set:
    text = (ROOT / "config.py").read_text()
    names = set(re.findall(r"""os\.getenv\(\s*["']([A-Z][A-Z0-9_]*)["']""", text))
    names |= set(re.findall(r"""os\.environ(?:\.get)?[\[(]\s*["']([A-Z][A-Z0-9_]*)["']""", text))
    return names


def load_builder():
    spec = importlib.util.spec_from_file_location("build_worker_env", BUILD)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class EveryConfigSettingCanReachTheWorker(unittest.TestCase):
    def test_every_name_config_reads_is_deployed_or_explicitly_not(self):
        allowed = set(example_keys())
        missing = sorted(n for n in config_env_names() if n not in allowed and n not in NOT_DEPLOYED)
        self.assertEqual(missing, [], "config.py reads these but neither deploy/.env.worker.example nor "
                                     "NOT_DEPLOYED in this test names them: add them to the allow-list "
                                     "(and the Build the worker env step) or say why not")

    def test_the_not_deployed_list_is_honest(self):
        read, allowed = config_env_names(), set(example_keys())
        self.assertEqual(sorted(n for n in NOT_DEPLOYED if n not in read), [], "stale entry: config.py no longer reads it")
        self.assertEqual(sorted(n for n in NOT_DEPLOYED if n in allowed), [], "listed as not deployed but deployed")

    def test_the_names_the_audit_found_missing_are_deployed(self):
        allowed = set(example_keys())
        wanted = ("GEMINI_MODEL EDGE_TTS_VOICE MINIMAX_BASE_URL CHRONOS_MINIMAX_BROLL_MAX_CLIPS "
                  "CHRONOS_LEONARDO_MAX_IMAGES ASSEMBLYAI_API_KEY VIDEO_OPS_API_KEY VIDEO_OPS_BASE_URL "
                  "VIDEO_OPS_SUBMIT_PATH VIDEO_OPS_QUERY_PATH CHRONOS_MAX_RUN_USD CHRONOS_MAX_DAILY_USD").split()
        for prefix, parts in (("KLING_", "MODEL BASE_URL SUBMIT_PATH QUERY_PATH"),
                              ("VEO_", "MODEL BASE_URL RESOLUTION SUBMIT_PATH QUERY_PATH"),
                              ("SEEDANCE_", "MODEL BASE_URL RESOLUTION SUBMIT_PATH QUERY_PATH"),
                              ("WAN_", "MODEL BASE_URL RESOLUTION SUBMIT_PATH QUERY_PATH"),
                              ("HIGGSFIELD_", "MODEL BASE_URL SUBMIT_PATH QUERY_PATH")):
            wanted += [prefix + p for p in parts.split()]
        self.assertEqual(sorted(n for n in wanted if n not in allowed), [])

    def test_every_cost_unit_has_a_price_variable_that_reaches_the_worker(self):
        from modules import cost_ledger

        units = [v for k, v in vars(cost_ledger).items()
                 if k.isupper() and isinstance(v, str)
                 and re.fullmatch(r"[a-z_]+", v) and k == v.upper()]
        self.assertGreaterEqual(len(units), 9)
        allowed, flow = set(example_keys()), WORKFLOW.read_text()
        for unit in units:
            name = cost_ledger.price_env_var(unit)
            self.assertIn(name, allowed, name)
            self.assertIn(f"WORKERENV_{name}: ${{{{ vars.{name} }}}}", flow, f"{name} must be a VARIABLE in the deploy")

    def test_the_caps_and_prices_are_variables_the_credentials_are_secrets(self):
        secrets = set(re.findall(r"^([A-Z][A-Z0-9_]*)=", EXAMPLE.read_text().split("# ─── Behaviour")[0], re.M))
        self.assertTrue({"ASSEMBLYAI_API_KEY", "VIDEO_OPS_API_KEY"} <= secrets)
        for name in example_keys():
            if name.startswith("CHRONOS_PRICE_") or name.startswith("CHRONOS_MAX_") or name.endswith(
                    ("_MODEL", "_BASE_URL", "_SUBMIT_PATH", "_QUERY_PATH", "_RESOLUTION")):
                self.assertNotIn(name, secrets, name)

    def test_anthropic_is_not_deployed_because_nothing_reads_it(self):
        self.assertNotIn("ANTHROPIC_API_KEY", example_keys())
        self.assertNotIn("ANTHROPIC_API_KEY", WORKFLOW.read_text().split("Build the worker env")[1].split("Build the notify env")[0])
        readers = [str(p.relative_to(ROOT)) for d in ("modules", "tools") for p in (ROOT / d).rglob("*.py")
                   if "ANTHROPIC_API_KEY" in p.read_text()]
        self.assertEqual(readers + [n for n in ("main.py", "config.py") if "ANTHROPIC_API_KEY" in (ROOT / n).read_text()], [])


_CONFIG_CHILD = r"""
import json, os, sys
sys.path.insert(0, sys.argv[1])
for name in json.loads(sys.argv[2]):
    os.environ[name] = ""
import config
print("RESULT " + json.dumps({k: repr(v) for k, v in vars(config).items() if k.isupper()}, sort_keys=True))
"""


class AnEmptyVariableIsTheDefault(unittest.TestCase):
    """The deploy writes KEY= for every key; config must read that as unset."""

    def values(self, names):
        proc = subprocess.run([sys.executable, "-I", "-c", _CONFIG_CHILD, str(ROOT), json.dumps(names)],
                              capture_output=True, text=True, timeout=120, cwd=tempfile.gettempdir(),
                              env={"PATH": "/usr/bin:/bin", "HOME": tempfile.gettempdir()})
        line = next((l for l in proc.stdout.splitlines() if l.startswith("RESULT ")), None)
        self.assertIsNotNone(line, proc.stderr[-2000:])
        return json.loads(line[len("RESULT "):])

    def test_every_deployed_setting_set_to_empty_equals_unset(self):
        deployed = sorted(set(example_keys()) & config_env_names())
        self.assertGreater(len(deployed), 40)
        unset, empty = self.values([]), self.values(deployed)
        differ = {k: (unset[k], empty[k]) for k in unset if unset[k] != empty.get(k)}
        self.assertEqual(differ, {}, "an empty variable must keep the code default")


class TheQuotaRemedyIsActionable(unittest.TestCase):
    def test_it_names_the_variable_that_now_reaches_the_worker_and_how_to_apply_it(self):
        from modules import minimax_broll as mb

        text = mb.rejection("Kling", "kling-v2-6", status=402).remedy
        self.assertIn("CHRONOS_MINIMAX_BROLL_MAX_CLIPS", text)
        self.assertIn("repository variable", text)
        self.assertIn("Deploy web", text)
        self.assertIn("CHRONOS_MINIMAX_BROLL_MAX_CLIPS", example_keys())
        self.assertIn("WORKERENV_CHRONOS_MINIMAX_BROLL_MAX_CLIPS: ${{ vars.CHRONOS_MINIMAX_BROLL_MAX_CLIPS }}",
                      WORKFLOW.read_text())


class DeployWarnings(unittest.TestCase):
    SECRET = "value-that-must-never-be-printed-9f3a"

    def setUp(self):
        self.mod = load_builder()
        self.example = EXAMPLE.read_text()

    def warn(self, **values):
        raw = {k: "" for k in self.mod.example_keys(self.example)}
        raw.update(values)
        return self.mod.warnings(raw, self.example)

    def text(self, **values):
        return "\n".join(self.warn(**values))

    def test_empty_secrets_are_named_and_the_variable_mistake_is_explained(self):
        text = self.text(GEMINI_API_KEY="k", PEXELS_API_KEY="")
        self.assertIn("PEXELS_API_KEY", text)
        self.assertNotIn("GEMINI_API_KEY,", text.split("empty, so the worker does not have:")[1].split(".")[0])
        self.assertIn("Variable", text)

    def test_a_provider_flag_on_with_its_key_empty_is_a_warning_naming_both(self):
        text = self.text(CHRONOS_ENABLE_VIDEO_GEN="true", CHRONOS_VIDEO_PROVIDER="kling")
        self.assertIn("CHRONOS_ENABLE_VIDEO_GEN is on for kling clips", text)
        self.assertIn("KLING_API_KEY", text)
        self.assertIn("KLING_ACCESS_KEY+KLING_SECRET_KEY", text)
        self.assertIn("CHRONOS_ENABLE_MINIMAX_BROLL is on for MiniMax clips",
                      self.text(CHRONOS_ENABLE_MINIMAX_BROLL="on"))
        self.assertIn("CHRONOS_ENABLE_IMAGE_GEN is on for leonardo stills",
                      self.text(CHRONOS_ENABLE_IMAGE_GEN="1", CHRONOS_IMAGE_PROVIDER="leonardo"))
        self.assertIn("NIGHTSHIFT_AVATAR_ENABLED is on for the avatar", self.text(NIGHTSHIFT_AVATAR_ENABLED="yes"))
        self.assertIn("CHRONOS_ENABLE_VIDIQ is on", self.text(CHRONOS_ENABLE_VIDIQ="true"))

    def test_the_same_flag_with_its_key_present_is_quiet(self):
        text = self.text(CHRONOS_ENABLE_VIDEO_GEN="true", CHRONOS_VIDEO_PROVIDER="kling", KLING_ACCESS_KEY="a",
                         KLING_SECRET_KEY="b")
        self.assertNotIn("CHRONOS_ENABLE_VIDEO_GEN is on for", text)
        self.assertNotIn("is on for", self.text(CHRONOS_ENABLE_VIDEO_GEN="true", CHRONOS_VIDEO_PROVIDER="veo",
                                                VEO_API_KEY="k"))

    def test_the_cases_that_silently_became_stock_footage_are_named(self):
        self.assertIn("CHRONOS_VIDEO_PROVIDER is not one of",
                      self.text(CHRONOS_ENABLE_VIDEO_GEN="true", CHRONOS_VIDEO_PROVIDER="veoo", VEO_API_KEY="k"))
        self.assertIn("CHRONOS_ENABLE_MINIMAX_BROLL is not",
                      self.text(CHRONOS_ENABLE_VIDEO_GEN="true", MINIMAX_API_KEY="k"))
        self.assertIn("free Edge voice", self.text())
        self.assertIn("TTS_PROVIDER is elevenlabs but ELEVENLABS_API_KEY is empty",
                      self.text(TTS_PROVIDER="elevenlabs"))
        self.assertNotIn("Edge voice", self.text(ELEVENLABS_API_KEY="k"))

    def test_the_caps_say_so_when_nothing_is_priced_or_a_value_is_bad(self):
        self.assertIn("cannot see any spend", self.text())
        self.assertNotIn("cannot see any spend", self.text(CHRONOS_PRICE_TTS_CHARACTERS="0.0002"))
        text = self.text(CHRONOS_MAX_RUN_USD="ten", CHRONOS_PRICE_RENDER_SECONDS="-1")
        self.assertIn("CHRONOS_MAX_RUN_USD is not a valid number", text)
        self.assertIn("CHRONOS_PRICE_RENDER_SECONDS is not a valid number", text)
        self.assertNotIn("not a valid number", self.text(CHRONOS_MAX_RUN_USD="off", CHRONOS_PRICE_RENDER_SECONDS="0"))

    def test_warnings_carry_names_never_values_or_lengths(self):
        text = self.text(GEMINI_API_KEY=self.SECRET, CHRONOS_ENABLE_VIDEO_GEN="true", CHRONOS_VIDEO_PROVIDER="wan",
                         WAN_API_KEY="", MINIMAX_API_KEY=self.SECRET, CHRONOS_MAX_RUN_USD=self.SECRET)
        self.assertNotIn(self.SECRET, text)
        self.assertNotIn(str(len(self.SECRET)), text)

    def test_main_prints_them_as_github_warning_lines_and_still_writes_the_env(self):
        import contextlib
        import io
        import os
        from unittest.mock import patch

        tmp = Path(tempfile.mkdtemp())
        payload = tmp / "payload"
        env = {f"WORKERENV_{k}": "" for k in self.mod.example_keys(self.example)}
        env.update(WORKERENV_SUPABASE_URL="https://abc.supabase.co", WORKERENV_SUPABASE_SERVICE_KEY=self.SECRET,
                   WORKERENV_CHRONOS_ENABLE_IMAGE_GEN="true", WORKERENV_CHRONOS_IMAGE_PROVIDER="flux")
        out = io.StringIO()
        with patch.dict(os.environ, env), contextlib.redirect_stdout(out):
            rc = self.mod.main(["build-worker-env.py", str(payload)])
        self.assertEqual(rc, 0)
        lines = [l for l in out.getvalue().splitlines() if l.startswith("::warning::")]
        self.assertTrue(any("CHRONOS_ENABLE_IMAGE_GEN is on for flux stills" in l and "BFL_API_KEY" in l for l in lines))
        self.assertNotIn(self.SECRET, out.getvalue())
        self.assertIn("CHRONOS_MAX_RUN_USD=", payload.read_text())

    def test_the_provider_tables_match_the_code(self):
        from modules import image_providers, video_providers

        self.assertEqual(set(self.mod.VIDEO_KEYS), set(video_providers._GENERIC_BUILDERS) | {"minimax"})
        self.assertEqual(self.mod.IMAGE_KEYS, image_providers.KEY_ATTRS)


if __name__ == "__main__":
    unittest.main()
