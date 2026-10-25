"""Every CHRONOS_* / NIGHTSHIFT_* name the code reads must have a way to be set.

What this guards, learned the expensive way: the VPS worker's env file is rewritten
on every deploy from the keys listed in deploy/.env.worker.example, and the
scheduled workflows pass only the variables their ``env:`` blocks list. A switch
that the code reads but none of those lists names can never be turned on from the
managed path. The code for scene rendering, the comment inbox, publish-when-
approved, thumbnail arms and more sat finished and unreachable for exactly this
reason, and nothing said so: the feature simply read as "off".

The rule: a name found in the code must be in at least one deploy path, or in
``INTENTIONALLY_UNREACHABLE`` below with the reason. The reason is the point; an
entry with no honest reason is a switch somebody forgot.

Deliberately static (``ast``, stdlib only). Names in comments and docstrings are
not code, so they do not count; a name BUILT at run time (``"CHRONOS_PRICE_" +
unit``) is invisible here and stays covered by the tests that know its pattern
(tests/test_worker_env_allowlist.py).
"""

from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

NAME = re.compile(r"^(?:CHRONOS|NIGHTSHIFT)_[A-Z0-9]+(?:_[A-Z0-9]+)*$")
#: What the scan reads. The Command Center (TypeScript) has its own flags and is
#: covered by deploy/.env.web.example and tests/test_deploy_gha.py.
SCAN_DIRS = ("modules", "tools")
SCAN_FILES = ("main.py", "config.py")
#: Workflows that only build or test the repository. A variable set there never
#: reaches a run of the product, so it does not make a switch reachable.
CI_ONLY_WORKFLOWS = ("tests.yml", "frontend.yml", "security.yml", "video-engine.yml")

#: Name -> why no deploy path sets it. Three honest kinds of reason:
#:   * a path or address the deployment fixes itself (compose sets it, or the code
#:     default is the only sensible value);
#:   * tuning that has a tested default and no known reason to move it;
#:   * a dormant feature the owner has not decided on: it has no deploy path ON
#:     PURPOSE until that decision, and the reason says which one.
#: Adding a name here is a statement that nobody should be able to set it from
#: GitHub. Prefer adding it to a deploy path (see the failure message below).
INTENTIONALLY_UNREACHABLE = {
    # -- fixed by the deployment, not a setting ----------------------------------
    "NIGHTSHIFT_RUN_RESULT_FILE": "per-run: the queue worker names the file in the child's env (run_request.RESULT_FILE_ENV)",
    "NIGHTSHIFT_WORKER_VERSION": "optional build label the media worker shows next to its status (tools/media_worker.py); nothing in the repository sets it",
    "NIGHTSHIFT_SERIES_FILE": "a local series.json path for a laptop run; the managed path keeps series in the database",
    "CHRONOS_SERIES_FILE": "the old name of NIGHTSHIFT_SERIES_FILE, same reason",
    "CHRONOS_CHANNELS_FILE": "a local channels.json path for a laptop run; the managed path reads the channels table",
    "CHRONOS_STATE_DB": "a local sqlite path; the container's default (inside the history volume) is the intended one",
    "NIGHTSHIFT_EMAIL_FAKE_DIR": "test transport: writes mail to a folder instead of sending it",
    # -- tuning with a tested default ---------------------------------------------
    "CHRONOS_DEFAULT_CHANNEL_NAME": "label of the single-channel fallback; the registry names real channels",
    "CHRONOS_DEFAULT_CHANNEL_NICHE": "niche of the single-channel fallback; the registry names real channels",
    "CHRONOS_REGEN_MIN_FREE_MB": "free-disk floor of a scene regeneration; NIGHTSHIFT_MIN_FREE_DISK_GB is the deployable one",
    "CHRONOS_SPONSORSHIP_CPM_USD": "advisory sponsorship estimate; the code default is the tested one",
    "CHRONOS_AI_CRITIC_FRAMES": "how many frames the advisory critic looks at; CHRONOS_AI_CRITIC (deployed) is the switch",
    "CHRONOS_OPENAI_IMAGE_QUALITY": "quality tier of one image provider; CHRONOS_IMAGE_MODEL is the deployable choice",
    "CHRONOS_IDEOGRAM_SPEED": "speed tier of one image provider; CHRONOS_IMAGE_MODEL is the deployable choice",
    "CHRONOS_TOPIC_VECTORS": "a local embeddings file for the originality engine's offline mode",
    "CHRONOS_REMOTION_BROWSER": "a Chromium path inside the worker image; the image has no Node or Chromium yet, add it with the "
                                "Dockerfile step that installs them",
    "CHRONOS_REMOTION_TIMEOUT": "seconds per Remotion scene (default 600); only meaningful once the image can run Remotion",
    # -- owner decisions still pending (never enable from a test) ------------------
    "NIGHTSHIFT_AVATAR": "a whole presenter config as JSON; the discrete NIGHTSHIFT_AVATAR_* variables, which are deployable, "
                         "override it and are the form to use",
}


def _ast_names(path: Path) -> dict:
    """``{name: [file:line, ...]}`` for every CHRONOS_/NIGHTSHIFT_ string literal in
    the code of one file: not in a docstring (a bare string statement), not part of
    an f-string, not the key of a subscript being written."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    skip = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant):
            skip.add(id(node.value))                       # docstrings and bare strings
        elif isinstance(node, ast.JoinedStr):
            skip.update(id(part) for part in node.values)  # "CHRONOS_X_" + dynamic: not a name
        elif isinstance(node, ast.Subscript) and isinstance(node.ctx, (ast.Store, ast.Del)):
            skip.update(id(n) for n in ast.walk(node.slice))   # env["NAME"] = ... sets it for a child
    found: dict = {}
    for node in ast.walk(tree):
        if (isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skip
                and NAME.match(node.value)):
            found.setdefault(node.value, []).append(f"{path.relative_to(ROOT)}:{node.lineno}")
    return found


def names_read_by_the_code() -> dict:
    files = [p for d in SCAN_DIRS for p in sorted((ROOT / d).rglob("*.py"))] + [ROOT / f for f in SCAN_FILES]
    out: dict = {}
    for path in files:
        for name, where in _ast_names(path).items():
            out.setdefault(name, []).extend(where)
    return out


def _example_keys(path: Path) -> set:
    return set(re.findall(r"^([A-Z][A-Z0-9_]*)=", path.read_text(encoding="utf-8"), re.M))


def _env_keys_in(node, out: set) -> None:
    """Every key under an ``env:`` / ``environment:`` mapping, anywhere in a parsed
    YAML document (workflow, job or step level; compose list form ``- NAME=value``)."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key in ("env", "environment"):
                if isinstance(value, dict):
                    out.update(str(k) for k in value)
                elif isinstance(value, list):
                    out.update(str(v).split("=", 1)[0] for v in value)
            _env_keys_in(value, out)
    elif isinstance(node, list):
        for item in node:
            _env_keys_in(item, out)


def _yaml_env_keys(path: Path) -> set:
    import yaml

    out: set = set()
    _env_keys_in(yaml.safe_load(path.read_text(encoding="utf-8")), out)
    return out


def deploy_paths() -> dict:
    """``{place: names}``: every way a name can be given a value by the deployment."""
    places = {
        "deploy/.env.worker.example (and WORKERENV_<NAME> in .github/workflows/deploy_web.yml)":
            _example_keys(ROOT / "deploy" / ".env.worker.example"),
    }
    others: set = set()
    for example in sorted((ROOT / "deploy").glob(".env.*.example")):
        if example.name != ".env.worker.example":
            others |= _example_keys(example)
    places["the other deploy/.env.*.example files (web, notify, email, operator, marketing)"] = others
    flows: set = set()
    for flow in sorted((ROOT / ".github" / "workflows").glob("*.yml")):
        if flow.name not in CI_ONLY_WORKFLOWS:
            flows |= _yaml_env_keys(flow)
    places["an env: block of a workflow (daily_video.yml, intelligence_poll.yml, ...)"] = flows
    compose: set = set()
    for path in sorted((ROOT / "deploy").glob("docker-compose*.yml")) + sorted(ROOT.glob("docker-compose*.yml")):
        compose |= _yaml_env_keys(path)
    places["the environment: of a service in deploy/docker-compose.yml"] = compose
    return places


def unreachable(names: dict, paths: dict) -> list:
    reached = set().union(*paths.values())
    return sorted(n for n in names if n not in reached and n not in INTENTIONALLY_UNREACHABLE)


HOW_TO_FIX = (
    "These CHRONOS_/NIGHTSHIFT_ names are read by the code, but no deploy path can set them, so a switch "
    "added this way can never be turned on from GitHub:\n  {names}\n"
    "Add each one in the places that apply, with no value (empty must mean the default):\n"
    "  1. deploy/.env.worker.example  -- the key, plus a one-line comment (what it does, default)\n"
    "  2. .github/workflows/deploy_web.yml  -- WORKERENV_<NAME>: ${{{{ vars.<NAME> }}}} in 'Build the worker env'\n"
    "  3. .github/workflows/daily_video.yml  (and intelligence_poll.yml when the poll reads it)  -- "
    "<NAME>: ${{{{ vars.<NAME> }}}} in the run step's env:\n"
    "  (a dashboard-only flag goes to deploy/.env.web.example and WEBENV_<NAME> instead)\n"
    "or, if nobody should ever set it from GitHub, add it to INTENTIONALLY_UNREACHABLE in "
    "tests/test_switch_reachability.py WITH the reason."
)


class EverySwitchTheCodeReadsCanBeSet(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.names = names_read_by_the_code()
        cls.paths = deploy_paths()

    def test_no_switch_is_read_that_no_deploy_path_can_set(self):
        missing = unreachable(self.names, self.paths)
        self.assertEqual(
            missing, [],
            HOW_TO_FIX.format(names="\n  ".join(f"{n}  (read at {self.names[n][0]})" for n in missing)))

    def test_the_voice_cloning_switch_is_read_by_its_worker_and_can_be_set_from_github(self):
        # Custom voice (0117): finished code behind a switch the OWNER sets. It must be settable (an unreachable switch reads as
        # "off" for ever) and must not be in the allowlist of switches nobody should set.
        self.assertTrue(any(w.startswith("modules/voice_worker.py:") for w in self.names["NIGHTSHIFT_VOICE_CLONING"]))
        self.assertEqual(unreachable({"NIGHTSHIFT_VOICE_CLONING": ["modules/voice_worker.py:1"]}, self.paths), [])
        self.assertNotIn("NIGHTSHIFT_VOICE_CLONING", INTENTIONALLY_UNREACHABLE)

    def test_the_allowlist_is_honest(self):
        reached = set().union(*self.paths.values())
        read = set(self.names)
        stale = sorted(n for n in INTENTIONALLY_UNREACHABLE if n not in read)
        deployed = sorted(n for n in INTENTIONALLY_UNREACHABLE if n in reached)
        self.assertEqual(stale, [], "INTENTIONALLY_UNREACHABLE names the code no longer reads; delete the entry")
        self.assertEqual(deployed, [], "INTENTIONALLY_UNREACHABLE names a deployed switch; delete the entry")
        for name, reason in INTENTIONALLY_UNREACHABLE.items():
            self.assertGreater(len(reason.split()), 3, f"{name}: say why nobody should set it")

    def test_the_scan_finds_the_known_switches(self):
        # A scan that silently found nothing would pass every other test.
        self.assertGreater(len(self.names), 60)
        for known in ("CHRONOS_SCENE_RENDER", "NIGHTSHIFT_COMMENT_INBOX", "NIGHTSHIFT_VISIBILITY_PUBLISH",
                      "CHRONOS_MAX_RUN_USD", "NIGHTSHIFT_GROUNDED_FACTCHECK", "NIGHTSHIFT_VOICE_CLONING"):
            self.assertIn(known, self.names)
        for place, names in self.paths.items():
            self.assertGreater(len(names), 5, place)


class TheScannerOnlyCountsCode(unittest.TestCase):
    """The false positives that would make the guard noisy enough to be switched off."""

    def scan(self, source: str) -> dict:
        import tempfile

        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            path = Path(tmp) / "sample.py"
            path.write_text(source, encoding="utf-8")
            return _ast_names(path)

    def test_a_name_read_through_the_environment_or_a_constant_is_found(self):
        found = self.scan('import os\nFLAG_ENV = "CHRONOS_A"\nx = os.environ.get("NIGHTSHIFT_B")\n'
                          'y = os.getenv("CHRONOS_C", "")\nz = os.environ["NIGHTSHIFT_D"]\nw = env.get("CHRONOS_E")\n')
        self.assertEqual(sorted(found), ["CHRONOS_A", "CHRONOS_C", "CHRONOS_E", "NIGHTSHIFT_B", "NIGHTSHIFT_D"])

    def test_docstrings_comments_fstrings_and_writes_are_not_reads(self):
        # Each skipped form is a bare name here, so the only thing that can hide it is the rule under test.
        found = self.scan('"CHRONOS_MODULE_DOC"\n'
                          'def f(env, ref):\n'
                          '    "NIGHTSHIFT_IN_DOCSTRING"\n'
                          '    # CHRONOS_IN_COMMENT\n'
                          '    env["CHRONOS_WRITTEN"] = "1"\n'
                          '    del env["CHRONOS_DELETED"]\n'
                          '    return env.get(f"CHRONOS_PART{ref}")\n')
        self.assertEqual(found, {})

    def test_other_prefixes_and_prefix_fragments_are_ignored(self):
        self.assertEqual(self.scan('a = "YOUTUBE_TOKEN_JSON"\nb = "CHRONOS_PRICE_"\nc = "chronos_lower"\nd = "CHRONOS_"\n'), {})


class TheGuardFailsWhenASwitchHasNoDeployPath(unittest.TestCase):
    """The mutant that proves the guard is not decoration."""

    def test_a_new_switch_nobody_can_set_is_reported_with_where_to_add_it(self):
        names = dict(names_read_by_the_code(), NIGHTSHIFT_BRAND_NEW_SWITCH=["modules/x.py:1"])
        missing = unreachable(names, deploy_paths())
        self.assertEqual(missing, ["NIGHTSHIFT_BRAND_NEW_SWITCH"])
        message = HOW_TO_FIX.format(names="NIGHTSHIFT_BRAND_NEW_SWITCH")
        for place in ("deploy/.env.worker.example", "deploy_web.yml", "daily_video.yml", "INTENTIONALLY_UNREACHABLE"):
            self.assertIn(place, message)

    def test_a_name_in_a_workflow_env_block_or_the_worker_example_counts(self):
        paths = deploy_paths()
        self.assertEqual(unreachable({"NIGHTSHIFT_X": ["m.py:1"]}, paths), ["NIGHTSHIFT_X"])
        self.assertEqual(unreachable({"CHRONOS_GRAPHIC_RECIPES": ["m.py:1"]}, {"x": {"CHRONOS_GRAPHIC_RECIPES"}}), [])

    def test_the_ci_only_workflows_are_real_files_and_their_variables_do_not_count(self):
        flows = ROOT / ".github" / "workflows"
        for name in CI_ONLY_WORKFLOWS:
            self.assertTrue((flows / name).is_file(), f"{name}: renamed or removed, update CI_ONLY_WORKFLOWS")
        counted = deploy_paths()["an env: block of a workflow (daily_video.yml, intelligence_poll.yml, ...)"]
        self.assertIn("NIGHTSHIFT_PIPELINE_PAUSED", counted)
        self.assertNotIn("NIGHTSHIFT_SECURITY_PG", counted)   # security.yml's job env: CI only


class TheWebOnlyFeatureSwitchesCanBeSetFromGitHub(unittest.TestCase):
    """The scan above reads Python only, so a Command Center switch that lives in ``lib/<feature>/flag.ts`` would pass it
    whether or not anybody can set it. Each such file names its switch once (``export const ..._FLAG = "NIGHTSHIFT_X"``); the
    name must be a key of deploy/.env.web.example AND be mapped as WEBENV_<name> in deploy_web.yml, or the page stays a 404 for ever."""

    FLAG_FILES = sorted((ROOT / "command-center" / "lib").glob("*/flag.ts"))

    def flags(self) -> dict:
        found = {}
        for path in self.FLAG_FILES:
            for name in re.findall(r"_FLAG\s*=\s*\"((?:CHRONOS|NIGHTSHIFT)_[A-Z0-9_]+)\"", path.read_text(encoding="utf-8")):
                found[name] = path.relative_to(ROOT).as_posix()
        return found

    def test_the_scan_finds_the_known_feature_switches(self):
        found = self.flags()
        self.assertIn("NIGHTSHIFT_REGION_EDITOR", found)
        self.assertIn("NIGHTSHIFT_IMAGE_EDITOR", found)

    def test_every_feature_switch_has_a_web_example_key_and_a_workflow_mapping(self):
        web_keys = _example_keys(ROOT / "deploy" / ".env.web.example")
        workflow = (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text(encoding="utf-8")
        for name, where in self.flags().items():
            self.assertIn(name, web_keys, f"{name} ({where}): add `{name}=` to deploy/.env.web.example")
            self.assertRegex(
                workflow, r"(?m)^\s+WEBENV_%s: \$\{\{ vars\.%s \}\}\s*$" % (name, name),
                f"{name} ({where}): map it in deploy_web.yml as WEBENV_{name}: ${{{{ vars.{name} }}}}")

    def test_the_image_editor_switch_is_web_only_and_stays_off_by_default(self):
        # Nothing in Python reads it (no worker runs an image edit), so it needs no worker variable; and the example ships it EMPTY.
        self.assertNotIn("NIGHTSHIFT_IMAGE_EDITOR", names_read_by_the_code())
        text = (ROOT / "deploy" / ".env.web.example").read_text(encoding="utf-8")
        self.assertRegex(text, r"(?m)^NIGHTSHIFT_IMAGE_EDITOR=$")
        self.assertNotIn("NIGHTSHIFT_IMAGE_EDITOR", (ROOT / "deploy" / ".env.worker.example").read_text(encoding="utf-8"))



if __name__ == "__main__":
    unittest.main()
