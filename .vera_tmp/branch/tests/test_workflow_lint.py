"""Workflow lint: no secret, variable or event value is ever shell text.

GitHub expands ``${{ ... }}`` as raw text *before* the shell parses a ``run:``
script. A secret, a repository variable (both settable from the Command
Center by a platform admin), a dispatch input or any event field spliced in
that way is code: a value containing ``'`` ends the string and runs the rest,
with every secret the step holds — SUPABASE_SERVICE_KEY included — in reach.
The safe form is ``env:`` plus a quoted ``"$VAR"``; the shell never re-parses
a variable's value.

Every workflow under .github/workflows/ is parsed and each ``run:`` block
checked for:

* any ``${{`` at all (secrets., vars., github.event., inputs., matrix., ...),
* a print of a secret's length or prefix (``wc -c``, ``${#VAR}``, ``${VAR:0:4}``),
* a fixed heredoc delimiter when writing to ``$GITHUB_ENV``/``$GITHUB_OUTPUT``,
* an environment dump (``printenv``, bare ``env``, ``set -x``);

and every file for ``toJSON(secrets|env|vars)``, and every upload-artifact
step for a path that could hold a credential or an env file.

The second half runs the hardened token steps under bash with hostile values
and checks what reaches the files, ``$GITHUB_ENV`` and the log.

Runs under both ``python -m pytest`` and ``python -m unittest``.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Dict, Iterator, List, Tuple

import yaml

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"

EXPRESSION = re.compile(r"\$\{\{")
NAMED_CONTEXT = re.compile(r"\$\{\{\s*(secrets|vars|github\.event|inputs)\b")
LENGTH_OR_PREFIX = (
    (re.compile(r"\bwc\s+(-[a-zA-Z]*[cm]|--bytes|--chars)\b"), "wc -c/-m (prints a length)"),
    (re.compile(r"\$\{#[A-Za-z_][A-Za-z0-9_]*\}"), "${#VAR} (prints a length)"),
    # ${VAR:0:4}, ${VAR: -4}, ${VAR:(-4)} — but not the default ${VAR:-1}.
    (re.compile(r"\$\{[A-Za-z_][A-Za-z0-9_]*:(\d|\s+-\d|\(\s*-?\d)"), "${VAR:N} (prints part of a value)"),
    (re.compile(r"\b(head|tail)\s+-c\b|\bcut\s+-c\b"), "head/tail/cut -c (prints part of a value)"),
)
FIXED_HEREDOC = re.compile(r"\b(echo|printf)\s+[\"'][^\"'\n]*<<\s*[\"']?[A-Za-z_]")
ENV_DUMP = (
    (re.compile(r"\bprintenv\b"), "printenv"),
    (re.compile(r"(^|[;&|]\s*)env\s*($|[|>;&])", re.M), "bare `env`"),
    (re.compile(r"\bset\s+-[a-zA-Z]*x|\bset\s+-o\s+xtrace"), "set -x (traces expanded values)"),
    (re.compile(r"\bexport\s+-p\b|\bdeclare\s+-p\s*($|[|>;&])", re.M), "export -p / declare -p"),
)
TO_JSON_DUMP = re.compile(r"toJSON\(\s*(secrets|env|vars)\s*\)")
ARTIFACT_PATH_DENY = re.compile(
    r"(^|/)\.env|token|secret|credential|runner\.temp|RUNNER_TEMP|^\s*\.?/?\s*$|^\*\*?$", re.I
)


def _strip_comments(script: str) -> str:
    """Drop whole-line shell comments: a comment describing the rule (\"never
    `wc -c` a secret\") is not a violation of it."""
    return "\n".join(l for l in script.splitlines() if not l.lstrip().startswith("#"))


def lint_run(script: str) -> List[str]:
    """Every rule a single ``run:`` script breaks, as readable strings."""
    problems: List[str] = []
    code = _strip_comments(script)
    for m in EXPRESSION.finditer(code):
        line = code[: m.start()].count("\n") + 1
        named = NAMED_CONTEXT.match(code, m.start())
        what = f"${{{{ {named.group(1)}." if named else "${{ ... }}"
        problems.append(f"line {line}: {what} interpolated into the shell; pass it through env:")
    for rx, what in LENGTH_OR_PREFIX:
        if rx.search(code):
            problems.append(what)
    if ("GITHUB_ENV" in code or "GITHUB_OUTPUT" in code) and FIXED_HEREDOC.search(code):
        problems.append("fixed heredoc delimiter written to GITHUB_ENV/GITHUB_OUTPUT; use a random one")
    for rx, what in ENV_DUMP:
        if rx.search(code):
            problems.append(f"environment dump: {what}")
    return problems


def _strings(node) -> Iterator[str]:
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from _strings(k)
            yield from _strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from _strings(v)


def lint_workflow(doc: dict) -> List[str]:
    problems: List[str] = []
    for s in _strings(doc):
        if TO_JSON_DUMP.search(s):
            problems.append("toJSON(secrets/env/vars) dumps every value")
    for job_id, job in (doc.get("jobs") or {}).items():
        for i, step in enumerate(job.get("steps") or []):
            label = f"{job_id} / {step.get('name') or step.get('uses') or f'step {i}'}"
            if isinstance(step.get("run"), str):
                problems.extend(f"{label}: {p}" for p in lint_run(step["run"]))
            if str(step.get("uses", "")).startswith("actions/upload-artifact"):
                paths = str((step.get("with") or {}).get("path", ""))
                for p in paths.splitlines() or [paths]:
                    if ARTIFACT_PATH_DENY.search(p.strip()):
                        problems.append(f"{label}: artifact path {p.strip()!r} could hold a credential or env file")
    return problems


def workflow_files() -> List[Path]:
    return sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml"))


def load(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


class WorkflowLintTestCase(unittest.TestCase):
    def test_there_are_workflows_to_lint(self):
        self.assertGreaterEqual(len(workflow_files()), 5)

    def test_every_workflow_passes(self):
        failures: Dict[str, List[str]] = {}
        for path in workflow_files():
            problems = lint_workflow(load(path))
            if problems:
                failures[path.name] = problems
        self.assertEqual(failures, {}, json.dumps(failures, indent=2))


class LinterCatchesTestCase(unittest.TestCase):
    """The rules are only worth something if they fire. Each known-bad shape,
    most of them taken from what the workflows used to contain."""

    BAD = {
        "secret": 'echo \'${{ secrets.YOUTUBE_TOKEN_JSON }}\' > youtube_token.json',
        "secret test": 'if [ -n "${{ secrets.YOUTUBE_TOKEN_JSON }}" ]; then :; fi',
        "var": 'echo "${{ vars.DEPLOY_HOST }}"',
        "event": 'if [ "${{ github.event.inputs.skip_comments }}" = "true" ]; then :; fi',
        "inputs": 'python x.py --repeat ${{ inputs.repeat }}',
        "matrix": 'python x.py --channel ${{ matrix.channel_id }}',
        "wc": 'echo "wrote ($(wc -c < youtube_token.json) bytes)"',
        "length": 'echo "$NAME is set (${#CHANNEL_TOKEN_JSON} bytes)"',
        "prefix": 'echo "key starts ${API_KEY:0:4}"',
        "suffix": 'echo "key ends ${API_KEY: -4}"',
        "head -c": 'printf %s "$API_KEY" | head -c 6',
        "fixed heredoc": 'echo "${NAME}<<CHRONOS_TOKEN_EOF" >> "$GITHUB_ENV"',
        "printenv": 'printenv | sort > logs/env.txt',
        "env": 'env > logs/env.txt',
        "set -x": 'set -euxo pipefail\npython main.py',
    }

    def test_each_bad_shape_is_caught(self):
        for name, script in self.BAD.items():
            with self.subTest(name):
                self.assertTrue(lint_run(script), f"{name!r} was not caught")

    def test_safe_shapes_pass(self):
        ok = [
            'if [ -n "${YOUTUBE_TOKEN_JSON:-}" ]; then printf \'%s\' "$YOUTUBE_TOKEN_JSON" > f; fi',
            'if (( ${#errors[@]} > 0 )); then exit 1; fi',
            'echo "${EXIT_CODE:--1}" "${EXIT_CODE:-1}"',
            'printf \'%s<<%s\\n\' "$NAME" "$delim" >> "$GITHUB_ENV"',
            'python3 - <<\'PY\'\nprint(1)\nPY',
            '# never `wc -c` a secret or print ${{ secrets.X }}\ntrue',
            'env_file=x; echo "$env_file"',
        ]
        for script in ok:
            with self.subTest(script):
                self.assertEqual(lint_run(script), [])

    def test_workflow_level_rules(self):
        doc = {"jobs": {"j": {"steps": [
            {"name": "dump", "env": {"ALL": "${{ toJSON(secrets) }}"}, "run": "true"},
            {"uses": "actions/upload-artifact@v7", "with": {"path": "logs/\n.env.web\n"}},
            {"uses": "actions/upload-artifact@v7", "with": {"path": "youtube_token.json"}},
            {"uses": "actions/upload-artifact@v7", "with": {"path": "${{ runner.temp }}/deploy"}},
        ]}}}
        problems = lint_workflow(doc)
        self.assertTrue(any("toJSON" in p for p in problems))
        self.assertTrue(any(".env.web" in p for p in problems))
        self.assertTrue(any("youtube_token" in p for p in problems))
        self.assertTrue(any("runner.temp" in p for p in problems))

    def test_secret_in_env_block_is_fine(self):
        doc = {"jobs": {"j": {"steps": [
            {"env": {"TOKEN": "${{ secrets.TOKEN }}"}, "run": 'printf \'%s\' "$TOKEN" > f'},
            {"uses": "actions/upload-artifact@v7", "with": {"path": "logs/*.log"}},
        ]}}}
        self.assertEqual(lint_workflow(doc), [])


# --- the hardened steps, executed ------------------------------------------

def _step(workflow: str, name: str) -> dict:
    for job in load(WORKFLOWS / workflow)["jobs"].values():
        for step in job.get("steps") or []:
            if step.get("name") == name:
                return step
    raise AssertionError(f"{workflow}: no step named {name!r}")


def parse_github_env(text: str) -> Dict[str, str]:
    """The $GITHUB_ENV file format as the runner reads it."""
    out: Dict[str, str] = {}
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if not line:
            continue
        if "<<" in line and ("=" not in line or line.index("<<") < line.index("=")):
            name, delim = line.split("<<", 1)
            body: List[str] = []
            while i < len(lines) and lines[i] != delim:
                body.append(lines[i])
                i += 1
            if i >= len(lines):
                raise ValueError("unterminated heredoc")
            i += 1
            out[name] = "\n".join(body)
        else:
            name, _, value = line.partition("=")
            out[name] = value
    return out


BASH = shutil.which("bash")
PYTHON_DIR = str(Path(sys.executable).parent)


@unittest.skipUnless(BASH, "bash is required to run the workflow steps")
class HardenedStepsTestCase(unittest.TestCase):
    """Hostile values through the real step scripts. Nothing may execute,
    nothing but the named variable may reach $GITHUB_ENV, and the log may
    carry neither the value nor its length."""

    CANARY = "pwned"
    HOSTILE_JSON = json.dumps({
        "token": "a'; touch pwned; echo '",
        "refresh_token": "$(touch pwned)`touch pwned`",
        "note": "CHRONOS_TOKEN_EOF\nBASH_ENV=/tmp/evil",
    }, indent=2)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        (self.tmp / "tools").symlink_to(ROOT / "tools")
        self.github_env = self.tmp / "github_env"
        self.github_env.write_text("")

    def run_step(self, workflow: str, name: str, env: Dict[str, str]) -> Tuple[int, str]:
        script = _step(workflow, name)["run"]
        full_env = {
            "PATH": PYTHON_DIR + os.pathsep + os.environ.get("PATH", ""),
            "HOME": str(self.tmp),
            "GITHUB_ENV": str(self.github_env),
            **env,
        }
        # `python` as the runner has it after actions/setup-python.
        shim = self.tmp / "bin"
        shim.mkdir(exist_ok=True)
        if not (shim / "python").exists():
            (shim / "python").symlink_to(sys.executable)
        full_env["PATH"] = str(shim) + os.pathsep + full_env["PATH"]
        proc = subprocess.run([BASH, "-e", "-c", script], cwd=self.tmp, env=full_env,
                              capture_output=True, text=True, timeout=60)
        return proc.returncode, proc.stdout + proc.stderr

    def assert_nothing_leaked(self, out: str, value: str):
        self.assertFalse((self.tmp / self.CANARY).exists(), "a value was executed as shell")
        for line in value.splitlines():
            if len(line.strip()) > 3:
                self.assertNotIn(line.strip(), out)
        self.assertNotIn("bytes", out)
        self.assertNotRegex(out, rf"\b{len(value)}\b")

    # daily_video.yml, non-default channel ---------------------------------

    def test_channel_token_is_exported_exactly_and_nothing_else(self):
        rc, out = self.run_step("daily_video.yml", "Restore YouTube token (this channel)", {
            "CHANNEL_TOKEN_JSON": self.HOSTILE_JSON, "TOKEN_SECRET_NAME": "CHRONOS_YT_TOKEN_SHOP"})
        self.assertEqual(rc, 0, out)
        exported = parse_github_env(self.github_env.read_text())
        self.assertEqual(exported, {"CHRONOS_YT_TOKEN_SHOP": self.HOSTILE_JSON})
        self.assertIn("CHRONOS_YT_TOKEN_SHOP is set", out)
        self.assert_nothing_leaked(out, self.HOSTILE_JSON)

    def test_channel_token_delimiter_is_random(self):
        seen = set()
        for _ in range(2):
            self.github_env.write_text("")
            self.run_step("daily_video.yml", "Restore YouTube token (this channel)", {
                "CHANNEL_TOKEN_JSON": '{"a":1}', "TOKEN_SECRET_NAME": "CHRONOS_YT_TOKEN_SHOP"})
            first = self.github_env.read_text().split("\n", 1)[0]
            self.assertNotIn("CHRONOS_TOKEN_EOF\n", self.github_env.read_text())
            seen.add(first)
        self.assertEqual(len(seen), 2)

    def test_channel_token_that_is_not_json_is_not_exported(self):
        value = "x\nCHRONOS_TOKEN_EOF\nBASH_ENV=/tmp/evil\n$(touch pwned)"
        rc, out = self.run_step("daily_video.yml", "Restore YouTube token (this channel)", {
            "CHANNEL_TOKEN_JSON": value, "TOKEN_SECRET_NAME": "CHRONOS_YT_TOKEN_SHOP"})
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.github_env.read_text(), "")
        self.assertIn("::warning::CHANNEL_TOKEN_JSON is not valid JSON", out)
        self.assert_nothing_leaked(out, value)

    def test_a_name_that_is_not_a_channel_token_is_refused(self):
        for name in ("BASH_ENV", "PATH", "CHRONOS_YT_TOKEN_", "CHRONOS_YT_TOKEN_X\nBASH_ENV", ""):
            with self.subTest(name=name):
                self.github_env.write_text("")
                rc, out = self.run_step("daily_video.yml", "Restore YouTube token (this channel)", {
                    "CHANNEL_TOKEN_JSON": '{"a":1}', "TOKEN_SECRET_NAME": name})
                self.assertNotEqual(rc, 0)
                self.assertEqual(self.github_env.read_text(), "")

    def test_unset_channel_token_keeps_its_message(self):
        rc, out = self.run_step("daily_video.yml", "Restore YouTube token (this channel)", {
            "CHANNEL_TOKEN_JSON": "", "TOKEN_SECRET_NAME": "CHRONOS_YT_TOKEN_SHOP"})
        self.assertEqual(rc, 0, out)
        self.assertIn("CHRONOS_YT_TOKEN_SHOP is EMPTY OR UNSET", out)
        self.assertEqual(self.github_env.read_text(), "")

    # default channel token and client secret, both workflows ---------------

    FILE_STEPS = (
        ("daily_video.yml", "Restore YouTube token (default channel)", "YOUTUBE_TOKEN_JSON", "youtube_token.json"),
        ("daily_video.yml", "Restore YouTube client secret", "YOUTUBE_CLIENT_SECRET_JSON", "client_secret.json"),
        ("intelligence_poll.yml", "Restore YouTube token", "YOUTUBE_TOKEN_JSON", "youtube_token.json"),
        ("intelligence_poll.yml", "Restore YouTube client secret", "YOUTUBE_CLIENT_SECRET_JSON", "client_secret.json"),
    )

    def test_json_secret_is_written_verbatim_without_executing(self):
        for workflow, step, var, filename in self.FILE_STEPS:
            with self.subTest(workflow=workflow, step=step):
                target = self.tmp / filename
                target.unlink(missing_ok=True)
                rc, out = self.run_step(workflow, step, {var: self.HOSTILE_JSON})
                self.assertEqual(rc, 0, out)
                self.assertEqual(json.loads(target.read_text()), json.loads(self.HOSTILE_JSON))
                self.assertEqual(target.stat().st_mode & 0o077, 0, "token file readable by others")
                self.assert_nothing_leaked(out, self.HOSTILE_JSON)

    def test_json_secret_that_does_not_parse_is_not_written(self):
        for workflow, step, var, filename in self.FILE_STEPS:
            for value in ("{not json", '"a string"', "[1, 2]"):
                with self.subTest(workflow=workflow, step=step, value=value):
                    target = self.tmp / filename
                    target.unlink(missing_ok=True)
                    rc, out = self.run_step(workflow, step, {var: value})
                    self.assertEqual(rc, 0, out)
                    self.assertFalse(target.exists())
                    self.assertIn(f"::warning::{var} ", out)
                    self.assertNotIn(value, out)

    def test_unset_json_secret_keeps_its_message(self):
        for workflow, step, var, filename in self.FILE_STEPS:
            with self.subTest(workflow=workflow, step=step):
                rc, out = self.run_step(workflow, step, {var: ""})
                self.assertEqual(rc, 0, out)
                self.assertFalse((self.tmp / filename).exists())
                self.assertIn(var, out)
                self.assertNotIn("::warning::", out)


class ValidateJsonEnvTestCase(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(ROOT / "tools"))
        self.addCleanup(sys.path.remove, str(ROOT / "tools"))
        import validate_json_env

        self.mod = validate_json_env

    def test_problems(self):
        env = {"A_JSON": '{"x": 1}', "B_JSON": "{nope", "C_JSON": "", "D_JSON": "[1]"}
        found = self.mod.problems(["A_JSON", "B_JSON", "C_JSON", "D_JSON", "E_JSON"], env)
        self.assertEqual(len(found), 2)
        self.assertIn("B_JSON is not valid JSON", found[0])
        self.assertIn("D_JSON is JSON but not an object", found[1])
        self.assertNotIn("{nope", " ".join(found))

    def test_a_bad_name_is_refused(self):
        self.assertTrue(self.mod.problems(["lower", "A B"], {}))


if __name__ == "__main__":
    unittest.main()
