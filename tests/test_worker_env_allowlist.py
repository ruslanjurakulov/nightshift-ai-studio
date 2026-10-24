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
    "CHRONOS_ENABLE_REVENUE": "revenue tracking is an Actions-only opt-in: it reaches intelligence_poll.yml, which asks for "
                              "the monetary scope; the worker never polls analytics",
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
    names = set(re.findall(r"""(?:os\.getenv|_count_env)\(\s*["']([A-Z][A-Z0-9_]*)["']""", text))
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


_COUNT_CHILD = r"""
import json, sys, warnings
sys.path.insert(0, sys.argv[1])
import os
os.environ["CHRONOS_MINIMAX_BROLL_MAX_CLIPS"] = sys.argv[2]
os.environ["CHRONOS_LEONARDO_MAX_IMAGES"] = sys.argv[2]
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter("always")
    import config
print("RESULT " + json.dumps([config.MINIMAX_BROLL_MAX_CLIPS, config.LEONARDO_MAX_IMAGES, len(w)]))
"""


class CountsCannotBreakTheWorker(unittest.TestCase):
    """The clip / still counts are deployable now: a typo must not crash config at
    import (a crash-looping worker) nor make the cost brake negative."""

    def counts(self, raw):
        proc = subprocess.run([sys.executable, "-I", "-c", _COUNT_CHILD, str(ROOT), raw], capture_output=True,
                              text=True, timeout=120, cwd=tempfile.gettempdir(),
                              env={"PATH": "/usr/bin:/bin", "HOME": tempfile.gettempdir()})
        line = next((l for l in proc.stdout.splitlines() if l.startswith("RESULT ")), None)
        self.assertIsNotNone(line, proc.stderr[-2000:])
        return json.loads(line[len("RESULT "):])

    def test_good_values_are_taken_and_empty_is_the_default(self):
        self.assertEqual(self.counts("3"), [3, 3, 0])
        self.assertEqual(self.counts("0"), [0, 0, 0])
        self.assertEqual(self.counts(""), [2, 2, 0])

    def test_typos_and_negatives_fall_back_to_the_default_with_a_warning(self):
        for bad in ("two", "2.5", "-1", "$3"):
            with self.subTest(bad=bad):
                self.assertEqual(self.counts(bad), [2, 2, 2])

    def test_a_huge_number_is_capped(self):
        self.assertEqual(self.counts("9999"), [50, 50, 0])


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


class ClientsRefuseAKeyOverHttp(unittest.TestCase):
    def test_the_generic_and_minimax_clients_refuse_a_non_https_host_before_any_request(self):
        from unittest.mock import patch

        from modules import minimax_broll, minimax_client, video_providers

        with patch("config.KLING_API_KEY", "k"), patch("config.KLING_BASE_URL", "http://kling.example.test"):
            client = video_providers.get_client("kling")
            with self.assertRaises(minimax_broll.VideoModelUnavailable) as ctx:
                client.preflight()
            self.assertIn("https", str(ctx.exception))
        with patch("config.KLING_API_KEY", "k"), patch("config.KLING_BASE_URL", "https://kling.example.test"):
            video_providers.get_client("kling").preflight()
        with patch("config.MINIMAX_BASE_URL", "http://api.minimax.example"):
            with self.assertRaises(minimax_broll.VideoModelUnavailable):
                minimax_client.MiniMaxClient(api_key="k", model="MiniMax-Hailuo-2.3").preflight()


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

    def test_counts_must_be_whole_numbers(self):
        for bad in ("two", "2.5", "-1"):
            text = self.text(CHRONOS_MINIMAX_BROLL_MAX_CLIPS=bad, CHRONOS_LEONARDO_MAX_IMAGES=bad)
            self.assertIn("CHRONOS_MINIMAX_BROLL_MAX_CLIPS is not a whole number", text)
            self.assertIn("CHRONOS_LEONARDO_MAX_IMAGES is not a whole number", text)
        self.assertNotIn("whole number", self.text(CHRONOS_MINIMAX_BROLL_MAX_CLIPS="3", CHRONOS_LEONARDO_MAX_IMAGES="0"))

    def test_nan_and_inf_are_invalid_and_off_words_are_shared_with_the_guard(self):
        from modules import spend_guard

        for bad in ("nan", "inf", "-inf"):
            self.assertIn("CHRONOS_MAX_RUN_USD is not a valid number", self.text(CHRONOS_MAX_RUN_USD=bad), bad)
            self.assertIn("CHRONOS_PRICE_TTS_CHARACTERS is not a valid number",
                          self.text(CHRONOS_PRICE_TTS_CHARACTERS=bad), bad)
        self.assertIs(self.mod.OFF_WORDS, spend_guard.OFF_WORDS)
        for word in spend_guard.OFF_WORDS:
            self.assertNotIn("CHRONOS_MAX_DAILY_USD is not a valid number", self.text(CHRONOS_MAX_DAILY_USD=word), word)

    def test_none_and_the_other_off_words_are_not_invalid_numbers(self):
        for word in ("none", "off", "unlimited", "disabled", "OFF"):
            self.assertNotIn("not a valid number", self.text(CHRONOS_MAX_RUN_USD=word, CHRONOS_MAX_DAILY_USD=word), word)

    def test_counts_above_the_cap_are_called_out(self):
        text = self.text(CHRONOS_MINIMAX_BROLL_MAX_CLIPS="51", CHRONOS_LEONARDO_MAX_IMAGES="50")
        self.assertIn("CHRONOS_MINIMAX_BROLL_MAX_CLIPS is above 50", text)
        self.assertNotIn("CHRONOS_LEONARDO_MAX_IMAGES is above", text)

    def test_a_base_url_must_be_https(self):
        text = self.text(KLING_BASE_URL="http://api.example.test", MINIMAX_BASE_URL="https://api.minimax.io",
                         VEO_BASE_URL="ftp://x")
        self.assertIn("KLING_BASE_URL is not an https:// URL", text)
        self.assertIn("VEO_BASE_URL is not an https:// URL", text)
        self.assertNotIn("MINIMAX_BASE_URL is not", text)

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


#: Switches whose code was finished but could not be set on the managed path (docs/ and
#: tests/test_switch_reachability.py say why that matters). Every one reaches the worker.
DORMANT_FOR_THE_WORKER = (
    "CHRONOS_SCENE_RENDER", "CHRONOS_REMOTION", "CHRONOS_GRAPHIC_RECIPES",
    "CHRONOS_SCENE_CACHE_MAX_MB", "CHRONOS_SCENE_CACHE_MAX_AGE_DAYS",
    "NIGHTSHIFT_COMMENT_INBOX", "NIGHTSHIFT_INBOX_SYNC_SECONDS",
    "NIGHTSHIFT_VISIBILITY_PUBLISH", "NIGHTSHIFT_VISIBILITY_DAILY_UNITS", "NIGHTSHIFT_VISIBILITY_ORG_PERCENT",
    "NIGHTSHIFT_YT_QUOTA_PROJECT", "CHRONOS_THUMBNAIL_VARIANTS", "CHRONOS_GEMINI_STRUCTURED_OUTPUT",
    "NIGHTSHIFT_AVATAR_CHARACTER_PROMPT", "NIGHTSHIFT_AVATAR_CHARACTER_REF", "NIGHTSHIFT_VOICE_GATE_STRICT",
)
#: The subset the pipeline itself reads, so the daily run needs it too. The rest is read by the
#: queue worker only (the comment inbox, publish when approved).
DORMANT_FOR_THE_DAILY_RUN = (
    "CHRONOS_SCENE_RENDER", "CHRONOS_REMOTION", "CHRONOS_GRAPHIC_RECIPES",
    "CHRONOS_SCENE_CACHE_MAX_MB", "CHRONOS_SCENE_CACHE_MAX_AGE_DAYS",
    "CHRONOS_THUMBNAIL_VARIANTS", "CHRONOS_GEMINI_STRUCTURED_OUTPUT",
    "NIGHTSHIFT_AVATAR_CHARACTER_PROMPT", "NIGHTSHIFT_AVATAR_CHARACTER_REF", "NIGHTSHIFT_VOICE_GATE_STRICT",
)
#: (name, kind) the intelligence poll reads; the two vidIQ ones already reach the daily run.
DORMANT_FOR_THE_POLL = (
    ("VIDIQ_ACCESS_TOKEN", "secrets"), ("CHRONOS_ENABLE_VIDIQ", "vars"),
    ("CHRONOS_ENABLE_REVENUE", "vars"), ("CHRONOS_DAILY_UPLOAD_SLOTS", "vars"),
)
DAILY = ROOT / ".github" / "workflows" / "daily_video.yml"
POLL = ROOT / ".github" / "workflows" / "intelligence_poll.yml"


def _env_blocks(path: Path) -> list:
    """Every ``env:`` mapping of a workflow, at any level."""
    import yaml

    out: list = []

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "env" and isinstance(value, dict):
                    out.append(value)
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(yaml.safe_load(path.read_text()))
    return out


def _mapped(path: Path, name: str) -> list:
    return [block[name] for block in _env_blocks(path) if name in block]


class DormantSwitchesReachTheManagedPath(unittest.TestCase):
    """The switches that read as "off" only because nothing could set them."""

    def test_each_one_is_an_empty_worker_key_mapped_from_a_variable_of_the_same_name(self):
        lines = EXAMPLE.read_text().splitlines()
        flow = WORKFLOW.read_text()
        for name in DORMANT_FOR_THE_WORKER:
            with self.subTest(name=name):
                self.assertIn(f"{name}=", lines, "an empty key: the repository sets no value")
                self.assertIn(f"WORKERENV_{name}: ${{{{ vars.{name} }}}}", flow)

    def test_the_pipeline_ones_also_reach_the_daily_run_as_variables(self):
        for name in DORMANT_FOR_THE_DAILY_RUN:
            with self.subTest(name=name):
                self.assertEqual(_mapped(DAILY, name), [f"${{{{ vars.{name} }}}}"])

    def test_the_poll_gets_the_vidiq_and_the_revenue_and_slot_switches_the_way_the_daily_run_does(self):
        for name, kind in DORMANT_FOR_THE_POLL:
            with self.subTest(name=name):
                self.assertEqual(_mapped(POLL, name), [f"${{{{ {kind}.{name} }}}}"])
        for name in ("VIDIQ_ACCESS_TOKEN", "CHRONOS_ENABLE_VIDIQ"):
            self.assertEqual(_mapped(POLL, name), _mapped(DAILY, name), name)

    def test_the_token_stays_a_secret_and_the_new_keys_are_variables(self):
        secrets = set(re.findall(r"^([A-Z][A-Z0-9_]*)=", EXAMPLE.read_text().split("# ─── Behaviour")[0], re.M))
        self.assertIn("VIDIQ_ACCESS_TOKEN", secrets)
        self.assertEqual(sorted(secrets & set(DORMANT_FOR_THE_WORKER)), [])

    def test_the_repository_sets_no_value_for_any_of_them(self):
        for name in set(DORMANT_FOR_THE_WORKER) | {n for n, _ in DORMANT_FOR_THE_POLL}:
            for path in (DAILY, POLL):
                for expr in _mapped(path, name):
                    self.assertRegex(str(expr), rf"^\$\{{\{{ (vars|secrets)\.{name} \}}\}}$", f"{path.name}: {name}")
        for line in EXAMPLE.read_text().splitlines():
            key, _, value = line.partition("=")
            if key in DORMANT_FOR_THE_WORKER:
                self.assertEqual(value, "", f"{key} must ship empty")

    def test_the_two_switches_the_old_list_called_not_deployed_are_deployed(self):
        self.assertNotIn("CHRONOS_GEMINI_STRUCTURED_OUTPUT", NOT_DEPLOYED)
        self.assertNotIn("CHRONOS_THUMBNAIL_VARIANTS", NOT_DEPLOYED)
        # Revenue stays off the worker on purpose: it adds an OAuth scope and only the poll uses it.
        self.assertIn("CHRONOS_ENABLE_REVENUE", NOT_DEPLOYED)
        self.assertNotIn("CHRONOS_ENABLE_REVENUE", example_keys())


class AnEmptyDormantSwitchLeavesTheFeatureOff(unittest.TestCase):
    """The deploy writes KEY= for every key, so an empty value is what a repository that never set
    the variable delivers. Each reader must read it as off / the default, and none may crash on it."""

    ALL_EMPTY = {n: "" for n in set(DORMANT_FOR_THE_WORKER) | {n for n, _ in DORMANT_FOR_THE_POLL}}

    def setUp(self):
        import os
        from unittest import mock

        patcher = mock.patch.dict(os.environ, self.ALL_EMPTY)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_the_render_switches_are_off_and_the_remotion_knobs_take_their_defaults(self):
        from modules import graphic_recipes, remotion_renderer, scene_cache_gc, scene_render

        self.assertFalse(scene_render.is_enabled())
        self.assertFalse(graphic_recipes.is_enabled())
        self.assertFalse(remotion_renderer.enabled())
        self.assertEqual(remotion_renderer._timeout_s(), remotion_renderer.DEFAULT_TIMEOUT_S)
        self.assertIsNone(remotion_renderer._browser_executable())
        self.assertEqual(scene_cache_gc.caps_from_env(), {"max_bytes": None, "max_age_s": None})

    def test_the_queue_workers_switches_are_off_and_their_numbers_take_the_default(self):
        import tools.queue_worker as qw
        from modules import comment_replies, visibility_publish as vp

        self.assertFalse(vp.enabled())
        service = vp.VisibilityService("http://x", "k", worker_id="w", credentials=lambda cid: None, store=object())
        self.assertEqual((service.project, service.ceiling, service.org_percent),
                         ("default", vp.DEFAULT_DAILY_UNITS, vp.DEFAULT_ORG_PERCENT))
        self.assertEqual(qw._int_env("NIGHTSHIFT_INBOX_SYNC_SECONDS", int(comment_replies.DEFAULT_SYNC_SECONDS)),
                         int(comment_replies.DEFAULT_SYNC_SECONDS))
        # The comment inbox's own gate is pinned in tests/test_comment_replies.py (empty is among its "off" values).

    def test_the_presenter_stays_faceless_with_an_empty_character(self):
        from modules import avatar

        cfg = avatar.resolve_avatar_config()
        self.assertFalse(cfg.enabled)
        self.assertEqual((cfg.character_prompt, cfg.character_ref), ("", ""))

    def test_the_poll_switches_are_off_and_the_slot_budget_is_one_per_channel(self):
        from unittest.mock import MagicMock, patch

        import tools.run_intelligence_poll as poll

        channels = [MagicMock(channel_id=c) for c in ("ch1", "ch2", "ch3")]
        registry = MagicMock()
        registry.list.return_value = channels
        seen = {}

        def recommend(store, ids, total):
            seen["total"] = total
            return {}, {}

        store_cm = MagicMock()
        with patch.object(poll, "ChannelRegistry", return_value=registry), patch.object(poll, "StateStore", return_value=store_cm), \
                patch("modules.quota_allocator.recommend_with_scores", recommend), \
                patch("modules.quota_allocator.summarize", return_value={}), patch.object(poll.events, "emit"):
            poll.allocate_upload_quota()
        self.assertEqual(seen.get("total"), 3)

    def test_config_reads_the_empty_values_as_off_and_the_default_arm_count(self):
        proc = subprocess.run([sys.executable, "-I", "-c", _CONFIG_CHILD, str(ROOT), json.dumps(sorted(self.ALL_EMPTY))],
                              capture_output=True, text=True, timeout=120, cwd=tempfile.gettempdir(),
                              env={"PATH": "/usr/bin:/bin", "HOME": tempfile.gettempdir()})
        line = next((l for l in proc.stdout.splitlines() if l.startswith("RESULT ")), None)
        self.assertIsNotNone(line, proc.stderr[-2000:])
        values = json.loads(line[len("RESULT "):])
        self.assertEqual(values["THUMBNAIL_VARIANT_COUNT"], "2")
        for name in ("GEMINI_STRUCTURED_OUTPUT", "REVENUE_TRACKING_ENABLED", "VIDIQ_ENABLED"):
            self.assertEqual(values[name], "False", name)


if __name__ == "__main__":
    unittest.main()
