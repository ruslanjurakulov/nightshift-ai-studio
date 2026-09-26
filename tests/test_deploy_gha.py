"""Automatic deploy of the Command Center from GitHub Actions.

Three pieces, each guarding a failure that would otherwise surface only on
production, or in a public log:

* .github/workflows/deploy_web.yml maps every key of deploy/.env.web.example
  from the GitHub Environment. A key added to the example and not to the
  workflow would reach the server empty, and the feature would silently read as
  "not configured" there only. A credential mapped from `vars.*` would be
  printed unmasked in a public log.
* deploy/remote-deploy.sh is the SSH forced command. Whoever holds the deploy
  key can feed it anything, so it must refuse a commit that is not on main, a
  key the app does not read, and a value compose would interpolate — and never
  echo a value while refusing.
* deploy/setup-gha-deploy.sh pins that key to the forced command, once.
"""

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "deploy_web.yml"
ENV_EXAMPLE = ROOT / "deploy" / ".env.web.example"
REMOTE = ROOT / "deploy" / "remote-deploy.sh"
WORKER_EXAMPLE = ROOT / "deploy" / ".env.worker.example"
BUILD_WORKER = ROOT / "deploy" / "build-worker-env.py"
SETUP = ROOT / "deploy" / "setup-gha-deploy.sh"

REQUIRED = ("DOMAIN", "ACME_EMAIL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY")
# Anything that grants access. GOOGLE_OAUTH_CLIENT_ID is not a credential on its
# own, but it names which OAuth app the dashboard is, so it stays with its secret.
# Judged on the end of the name: GITHUB_SECRETS_REPO is an owner/repo, not a secret.
CREDENTIAL = re.compile(r"(TOKEN|SECRET|PASSWORD|_KEY)$|WEBHOOK")
EXTRA_SECRETS = {"GOOGLE_OAUTH_CLIENT_ID"}
# `${{ vars.NAME }}` or `${{ secrets.NAME }}`, optionally `|| <fallback>`.
MAPPING = re.compile(
    r"^\$\{\{\s*(vars|secrets)\.([A-Z][A-Z0-9_]*)(?:\s*\|\|\s*(.+?))?\s*\}\}$"
)
# The only fallbacks allowed, per key. Each is a fact about this deployment or
# the same value already held elsewhere — never an invented one: the legal
# fields in particular have none (a made-up operator on /terms is worse than
# NOT CONFIGURED).
ALLOWED_FALLBACKS = {
    "DOMAIN": "'new.nightshift-ai.studio'",
    "GITHUB_SECRETS_REPO": "github.repository",
    # The project URL is public; the bot's repository secret holds the same one.
    "NEXT_PUBLIC_SUPABASE_URL": "secrets.SUPABASE_URL",
}


def example_keys():
    return [m.group(1) for m in re.finditer(r"^([A-Z][A-Z0-9_]*)=", ENV_EXAMPLE.read_text(), re.M)]


def workflow():
    return yaml.safe_load(WORKFLOW.read_text())


def steps():
    return workflow()["jobs"]["deploy"]["steps"]


def step(step_id=None, name=None):
    for s in steps():
        if (step_id and s.get("id") == step_id) or (name and s.get("name") == name):
            return s
    raise AssertionError(f"no step {step_id or name!r} in {WORKFLOW.name}")


def expected_kind(key):
    if key.startswith("NEXT_PUBLIC_"):
        return "vars"  # in the browser bundle by design
    if CREDENTIAL.search(key) or key in EXTRA_SECRETS:
        return "secrets"
    return "vars"


class WorkflowMappingTests(unittest.TestCase):
    def setUp(self):
        self.env = step("payload")["env"]
        self.mapped = {k[len("WEBENV_"):]: v for k, v in self.env.items() if k.startswith("WEBENV_")}

    def test_every_example_key_is_mapped_into_the_server_env(self):
        missing = sorted(set(example_keys()) - set(self.mapped))
        self.assertEqual(missing, [], f"map these in deploy_web.yml as WEBENV_<KEY>: {missing}")

    def test_nothing_is_mapped_that_the_example_does_not_declare(self):
        # The server refuses unknown keys; this catches it before a deploy does.
        extra = sorted(set(self.mapped) - set(example_keys()))
        self.assertEqual(extra, [])

    def test_public_values_are_variables_and_credentials_are_secrets(self):
        for key, expr in self.mapped.items():
            m = MAPPING.match(str(expr))
            self.assertIsNotNone(m, f"{key}: unexpected mapping {expr!r}")
            self.assertEqual(m.group(1), expected_kind(key), key)

    def test_fallbacks_are_only_the_agreed_ones(self):
        for key, expr in self.mapped.items():
            fallback = MAPPING.match(str(expr)).group(3)
            self.assertEqual(fallback, ALLOWED_FALLBACKS.get(key), key)
        for key in example_keys():
            if key.startswith("NEXT_PUBLIC_LEGAL_") or key == "NEXT_PUBLIC_CONTACT_EMAIL":
                self.assertIsNone(MAPPING.match(str(self.mapped[key])).group(3), key)

    def test_existing_repository_secrets_are_reused_by_their_own_names(self):
        # The bot already has these; the owner should not have to store them twice.
        for key in ("GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "SLACK_WEBHOOK_URL"):
            self.assertEqual(self.mapped[key], f"${{{{ secrets.{key} }}}}")

    def test_names_never_use_the_prefix_github_reserves(self):
        # GitHub refuses secret and variable names starting with GITHUB_.
        for key, expr in self.mapped.items():
            name = MAPPING.match(str(expr)).group(2)
            self.assertFalse(name.startswith("GITHUB_"), key)
            if not key.startswith("GITHUB_"):
                self.assertEqual(name, key, "only GITHUB_* keys are renamed")
            else:
                self.assertEqual(name, "GH_" + key[len("GITHUB_"):])

    def test_the_supabase_service_key_is_never_part_of_the_web_deploy(self):
        # It is a repository secret for the bot, so it is one typo away. Only
        # the worker step may name it, and that goes to the worker's own file.
        for s in steps():
            if s.get("name") == "Build the worker env":
                continue
            self.assertNotRegex(yaml.safe_dump(s), r"(secrets|vars)\.\w*SERVICE", s.get("name"))

    def test_never_runs_for_a_pull_request(self):
        on = workflow()[True]  # YAML 1.1 reads the bare key `on` as True
        self.assertNotIn("pull_request", on)
        self.assertNotIn("pull_request_target", on)
        self.assertEqual(on["push"]["branches"], ["main"])
        self.assertIn("workflow_dispatch", on)
        for path in ("command-center/**", "deploy/**", ".github/workflows/deploy_web.yml"):
            self.assertIn(path, on["push"]["paths"])

    def test_one_deploy_at_a_time_and_never_cancelled_halfway(self):
        wf = workflow()
        self.assertEqual(wf["concurrency"]["group"], "deploy-web")
        self.assertFalse(wf["concurrency"]["cancel-in-progress"])
        self.assertEqual(wf["jobs"]["deploy"]["environment"]["name"], "production")

    def test_no_expression_is_interpolated_into_a_script(self):
        # ${{ }} inside run: is pasted into the script text before bash sees it:
        # a secret there is on disk in the script, a value there is code.
        for s in steps():
            if "run" in s:
                self.assertNotIn("${{", s["run"], s.get("name"))

    def test_ssh_pins_the_host_key_and_sends_everything_on_stdin(self):
        s = step(name="Deploy over SSH")
        run = s["run"]
        self.assertIn("StrictHostKeyChecking=yes", run)
        self.assertIn('UserKnownHostsFile="$work/known_hosts"', run)
        self.assertRegex(run, r'<\s*"\$PAYLOAD"')
        self.assertEqual(s["env"]["DEPLOY_SSH_KEY"], "${{ secrets.DEPLOY_SSH_KEY }}")
        self.assertEqual(s["env"]["DEPLOY_KNOWN_HOSTS"], "${{ secrets.DEPLOY_KNOWN_HOSTS }}")
        self.assertEqual(s["env"]["DEPLOY_HOST"], "${{ vars.DEPLOY_HOST || '168.119.142.178' }}")
        self.assertEqual(s["env"]["DEPLOY_USER"], "${{ vars.DEPLOY_USER || 'nightshift' }}")


def _payload_env(**overrides):
    env = {"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/tmp")}
    for key in example_keys():
        env[f"WEBENV_{key}"] = ""
    env.update(
        EVENT_NAME="push",
        DEPLOY_HOST="203.0.113.10",
        DEPLOY_USER="nightshift",
        HAS_SSH_KEY="true",
        HAS_KNOWN_HOSTS="true",
        WEBENV_DOMAIN="new.example.com",
        WEBENV_ACME_EMAIL="admin@example.com",
        WEBENV_NEXT_PUBLIC_SUPABASE_URL="https://abc.supabase.co",
        WEBENV_NEXT_PUBLIC_SUPABASE_ANON_KEY="anon-placeholder",
        WEBENV_GOOGLE_OAUTH_CLIENT_SECRET="very-secret-value-1234",
        GITHUB_REF="refs/heads/main",
        GITHUB_SHA="a" * 40,
    )
    env.update(overrides)
    return {k: v for k, v in env.items() if v is not None}


@unittest.skipUnless(shutil.which("bash"), "bash not installed")
class PayloadStepTests(unittest.TestCase):
    """Runs the workflow's own `Build the server env` script."""

    def run_step(self, **overrides):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        out, summary = tmp / "output", tmp / "summary"
        env = _payload_env(RUNNER_TEMP=str(tmp), GITHUB_OUTPUT=str(out), GITHUB_STEP_SUMMARY=str(summary), **overrides)
        proc = subprocess.run(
            ["bash", "-c", step("payload")["run"]], cwd=ROOT, env=env, capture_output=True, text=True, timeout=30
        )
        outputs = dict(line.split("=", 1) for line in out.read_text().splitlines()) if out.exists() else {}
        payload = Path(outputs["file"]).read_text() if "file" in outputs else None
        return proc, outputs, payload

    def test_builds_one_line_per_example_key_after_the_commit(self):
        proc, outputs, payload = self.run_step()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        lines = payload.splitlines()
        self.assertEqual(lines[0], "NIGHTSHIFT_DEPLOY_SHA=" + "a" * 40)
        self.assertEqual([l.split("=", 1)[0] for l in lines[1:]], example_keys())
        self.assertIn("GOOGLE_OAUTH_CLIENT_SECRET=very-secret-value-1234", lines)
        self.assertEqual(outputs["url"], "https://new.example.com")
        self.assertEqual(stat.S_IMODE(Path(outputs["file"]).stat().st_mode), 0o600)

    def test_never_prints_a_value(self):
        proc, _, _ = self.run_step()
        self.assertNotIn("very-secret-value-1234", proc.stdout + proc.stderr)
        self.assertNotIn("anon-placeholder", proc.stdout + proc.stderr)

    def test_dollar_and_line_breaks_are_refused_by_name_not_value(self):
        proc, outputs, _ = self.run_step(
            WEBENV_GOOGLE_OAUTH_CLIENT_SECRET="abc$HOMEdef", WEBENV_SLACK_WEBHOOK_URL="https://hooks.example/x\n"
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("run", outputs)
        self.assertIn("GOOGLE_OAUTH_CLIENT_SECRET contains", proc.stdout)
        self.assertIn("SLACK_WEBHOOK_URL contains a line break", proc.stdout)
        self.assertNotIn("abc$HOMEdef", proc.stdout + proc.stderr)
        self.assertNotIn("hooks.example", proc.stdout + proc.stderr)

    def test_required_values_must_be_set(self):
        proc, _, _ = self.run_step(WEBENV_NEXT_PUBLIC_SUPABASE_ANON_KEY="", WEBENV_DOMAIN="")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("NEXT_PUBLIC_SUPABASE_ANON_KEY is required", proc.stdout)
        self.assertIn("DOMAIN is required", proc.stdout)

    def test_domain_is_a_bare_host_name(self):
        proc, _, _ = self.run_step(WEBENV_DOMAIN="https://new.example.com/")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("bare host name", proc.stdout)

    def test_a_key_the_workflow_forgot_fails_the_deploy(self):
        proc, _, _ = self.run_step(WEBENV_SLACK_WEBHOOK_URL=None)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("SLACK_WEBHOOK_URL is in deploy/.env.web.example but not mapped", proc.stdout)

    def test_only_main_is_deployed(self):
        proc, _, _ = self.run_step(GITHUB_REF="refs/heads/feature")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("run this from main", proc.stdout)

    def test_a_push_before_setup_is_skipped_with_a_warning_not_a_failure(self):
        unset = dict(HAS_SSH_KEY="false", HAS_KNOWN_HOSTS="false")
        proc, outputs, _ = self.run_step(**unset)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(outputs.get("run"), "false")
        self.assertIn("NOT deployed", proc.stdout)
        # A manual run means "deploy": there it is an error.
        proc, outputs, _ = self.run_step(EVENT_NAME="workflow_dispatch", **unset)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("DEPLOY_SSH_KEY is empty", proc.stdout)


FAKE_DOCKER = textwrap.dedent(
    """\
    #!/usr/bin/env bash
    # Records every call; answers the few questions remote-deploy.sh asks.
    printf '%s\\n' "$*" >>"$FAKE_DOCKER_LOG"
    case "$*" in
      *" up "*worker) exit "${FAKE_WORKER_UP_RC:-0}" ;;
      *" up "*) exit "${FAKE_UP_RC:-0}" ;;
      *" ps -q web") echo cid123 ;;
      inspect*) echo "${FAKE_HEALTH:-healthy}" ;;
    esac
    exit 0
    """
)


def _git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def _rev(cwd, ref="HEAD"):
    return subprocess.run(["git", "rev-parse", ref], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class _RemoteDeployFixture(unittest.TestCase):
    """remote-deploy.sh against a real git remote and a fake docker."""

    SECRET = "s3cr3t-never-printed"

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.gitenv = {
            "PATH": os.environ["PATH"],
            "HOME": str(self.tmp),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
            "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com",
        }
        up = self.tmp / "upstream"
        (up / "deploy").mkdir(parents=True)
        self.git = lambda cwd, *a: subprocess.run(
            ["git", *a], cwd=cwd, env=self.gitenv, check=True, capture_output=True, text=True
        ).stdout.strip()
        self.git(up, "init", "-q", "-b", "main")
        shutil.copy(ENV_EXAMPLE, up / "deploy" / ".env.web.example")
        shutil.copy(WORKER_EXAMPLE, up / "deploy" / ".env.worker.example")
        (up / "deploy" / "docker-compose.yml").write_text("services: {}\n")
        self.git(up, "add", "-A")
        self.git(up, "commit", "-q", "-m", "A")
        self.app = self.tmp / "app"
        self.git(self.tmp, "clone", "-q", str(up), str(self.app))
        # B lands on main after the server cloned: the deploy must fetch it.
        # It also adds a key, which the server must learn from B itself.
        with open(up / "deploy" / ".env.web.example", "a") as f:
            f.write("\n# [server-only] added in B\nADDED_IN_B=\n")
        self.git(up, "commit", "-q", "-am", "B")
        self.sha_b = self.git(up, "rev-parse", "HEAD")
        # C is on a side branch: never deployable.
        self.git(up, "checkout", "-q", "-b", "side")
        (up / "x").write_text("x")
        self.git(up, "add", "x")
        self.git(up, "commit", "-q", "-m", "C")
        self.sha_c = self.git(up, "rev-parse", "HEAD")
        self.git(up, "checkout", "-q", "main")
        self.git(self.app, "fetch", "-q", "origin", "side")  # C exists locally, still refused

        docker = self.tmp / "docker"
        docker.write_text(FAKE_DOCKER)
        docker.chmod(0o755)
        self.docker_log = self.tmp / "docker.log"
        self.env_file = self.tmp / ".env.web"
        self.worker_env_file = self.tmp / ".env.worker"

    def payload(self, sha=None, drop=(), **values):
        vals = {k: "" for k in example_keys()}
        vals.update(
            DOMAIN="new.example.com",
            ACME_EMAIL="admin@example.com",
            NEXT_PUBLIC_SUPABASE_URL="https://abc.supabase.co",
            NEXT_PUBLIC_SUPABASE_ANON_KEY="anon",
            GOOGLE_OAUTH_CLIENT_SECRET=self.SECRET,
            ADDED_IN_B="",
        )
        vals.update(values)
        lines = [f"NIGHTSHIFT_DEPLOY_SHA={sha or self.sha_b}"]
        lines += [f"{k}={v}" for k, v in vals.items() if k not in drop]
        return "\n".join(lines) + "\n"

    def deploy(self, stdin, **extra):
        env = dict(
            self.gitenv,
            NIGHTSHIFT_APP_DIR=str(self.app),
            NIGHTSHIFT_ENV_FILE=str(self.env_file),
            NIGHTSHIFT_WORKER_ENV_FILE=str(self.worker_env_file),
            NIGHTSHIFT_LOCK_FILE=str(self.tmp / ".deploy.lock"),
            NIGHTSHIFT_DOCKER=str(self.tmp / "docker"),
            NIGHTSHIFT_HEALTH_TIMEOUT="10",
            FAKE_DOCKER_LOG=str(self.docker_log),
            **extra,
        )
        proc = subprocess.run(["bash", str(REMOTE)], input=stdin, env=env, capture_output=True, text=True, timeout=60)
        self.assertNotIn(self.SECRET, proc.stdout + proc.stderr)
        return proc

    def docker_calls(self):
        return self.docker_log.read_text().splitlines() if self.docker_log.exists() else []

    def assertRefused(self, proc, message):
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn(message, proc.stderr)
        self.assertFalse(self.env_file.exists(), "env file written despite refusal")
        self.assertEqual(self.docker_calls(), [], "docker ran despite refusal")



@unittest.skipUnless(shutil.which("bash") and shutil.which("git") and shutil.which("flock"), "bash, git, flock needed")
class RemoteDeployTests(_RemoteDeployFixture):
    def test_deploys_exactly_the_requested_commit_and_writes_the_env_600(self):
        proc = self.deploy(self.payload())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(_rev(self.app), self.sha_b)
        self.assertEqual(self.git(self.app, "symbolic-ref", "--short", "HEAD"), "main")
        self.assertEqual(stat.S_IMODE(self.env_file.stat().st_mode), 0o600)
        text = self.env_file.read_text()
        self.assertIn(f"GOOGLE_OAUTH_CLIENT_SECRET={self.SECRET}\n", text)
        self.assertIn("DOMAIN=new.example.com\n", text)
        up = [c for c in self.docker_calls() if " up " in f" {c} "]
        self.assertEqual(len(up), 1)
        self.assertIn(f"--env-file {self.env_file}", up[0])
        self.assertTrue(up[0].endswith("up -d --build --remove-orphans web caddy"), up[0])
        self.assertIn("web is healthy", proc.stdout)
        # No worker section: the worker is removed and no keys file is left.
        self.assertTrue(any(c.endswith("rm --stop --force worker") for c in self.docker_calls()))
        self.assertFalse(self.worker_env_file.exists())
        self.assertIn("worker is off", proc.stdout)

    def test_running_again_converges_and_keeps_the_previous_env_600(self):
        self.assertEqual(self.deploy(self.payload()).returncode, 0)
        proc = self.deploy(self.payload(DOMAIN="other.example.com"))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("DOMAIN=other.example.com", self.env_file.read_text())
        prev = Path(str(self.env_file) + ".prev")
        self.assertIn("DOMAIN=new.example.com", prev.read_text())
        self.assertEqual(stat.S_IMODE(prev.stat().st_mode), 0o600)
        leftovers = [p.name for p in self.tmp.iterdir() if p.name.startswith(".env.web.")]
        self.assertEqual(sorted(leftovers), [".env.web.prev"])

    def test_a_commit_not_on_main_is_refused(self):
        proc = self.deploy(self.payload(sha=self.sha_c))
        self.assertRefused(proc, "is not on origin/main")
        self.assertNotEqual(_rev(self.app), self.sha_c)

    def test_an_unknown_commit_is_refused(self):
        self.assertRefused(self.deploy(self.payload(sha="0" * 40)), "does not exist")

    def test_the_first_line_must_be_a_full_sha(self):
        self.assertRefused(self.deploy(self.payload(sha="main")), "first line must be")
        self.assertRefused(self.deploy("DOMAIN=x\n"), "first line must be")
        self.assertRefused(self.deploy(""), "no input")

    def test_a_key_the_app_does_not_read_is_refused_without_echoing_it(self):
        proc = self.deploy(self.payload(SUPABASE_SERVICE_KEY=self.SECRET))
        self.assertRefused(proc, "SUPABASE_SERVICE_KEY is not a key")

    def test_a_dollar_is_refused_by_name(self):
        proc = self.deploy(self.payload(GOOGLE_OAUTH_CLIENT_SECRET="ab$cd" + self.SECRET))
        self.assertRefused(proc, "GOOGLE_OAUTH_CLIENT_SECRET contains")

    def test_a_carriage_return_is_refused(self):
        proc = self.deploy(self.payload(SLACK_WEBHOOK_URL="https://x\r"))
        self.assertRefused(proc, "SLACK_WEBHOOK_URL contains a control character")

    def test_a_line_that_is_not_key_value_is_refused(self):
        proc = self.deploy(self.payload() + "export FOO=bar\n")
        self.assertRefused(proc, "is not KEY=value")

    def test_a_missing_or_duplicated_key_is_refused(self):
        self.assertRefused(self.deploy(self.payload(drop=("SLACK_WEBHOOK_URL",))), "SLACK_WEBHOOK_URL is missing")
        self.assertRefused(self.deploy(self.payload() + "DOMAIN=evil.example.com\n"), "DOMAIN is given more than once")

    def test_required_values_must_be_non_empty(self):
        self.assertRefused(self.deploy(self.payload(NEXT_PUBLIC_SUPABASE_URL="")), "NEXT_PUBLIC_SUPABASE_URL is required")

    def test_a_key_only_the_target_commit_declares_is_known(self):
        # The working tree is still at A, which has no ADDED_IN_B.
        self.assertNotIn("ADDED_IN_B", (self.app / "deploy" / ".env.web.example").read_text())
        self.assertEqual(self.deploy(self.payload()).returncode, 0)

    def test_local_changes_on_the_server_are_not_overwritten(self):
        (self.app / "deploy" / "docker-compose.yml").write_text("hand edit\n")
        proc = self.deploy(self.payload())
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("has local changes", proc.stderr)
        self.assertEqual((self.app / "deploy" / "docker-compose.yml").read_text(), "hand edit\n")
        self.assertEqual(self.docker_calls(), [])

    def test_an_unhealthy_web_fails_the_deploy_with_the_next_step(self):
        proc = self.deploy(self.payload(), FAKE_HEALTH="unhealthy")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("web is unhealthy", proc.stderr)
        self.assertIn("dc logs", proc.stderr)

    def test_a_failed_compose_up_fails_the_deploy(self):
        proc = self.deploy(self.payload(), FAKE_UP_RC="1")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("docker compose up failed", proc.stderr)

    def test_a_second_deploy_waits_for_nobody(self):
        lock = self.tmp / ".deploy.lock"
        with open(lock, "w") as held:
            holder = subprocess.Popen(["flock", str(lock), "sleep", "5"], stdout=held)
            self.addCleanup(holder.kill)
            for _ in range(50):
                if subprocess.run(["flock", "-n", str(lock), "true"]).returncode != 0:
                    break
                subprocess.run(["sleep", "0.1"])
            self.assertRefused(self.deploy(self.payload()), "another deploy is running")


FAKE_KEYGEN = textwrap.dedent(
    """\
    #!/usr/bin/env bash
    # Stands in for ssh-keygen -t ed25519 -N "" -C <comment> -f <file>.
    while (( $# )); do case "$1" in -f) f="$2"; shift ;; -C) c="$2"; shift ;; esac; shift; done
    blob="AAAAC3NzaC1lZDI1NTE5AAAA$RANDOM$RANDOM$RANDOM"
    printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\\nPRIVATE-%s\\n-----END OPENSSH PRIVATE KEY-----\\n' "$blob" >"$f"
    printf 'ssh-ed25519 %s %s\\n' "$blob" "$c" >"$f.pub"
    """
)


@unittest.skipUnless(shutil.which("bash"), "bash not installed")
class SetupScriptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        bindir = self.tmp / "bin"
        bindir.mkdir()
        (bindir / "ssh-keygen").write_text(FAKE_KEYGEN)
        (bindir / "ssh-keygen").chmod(0o755)
        self.ssh = self.tmp / "ssh"
        self.host_pub = self.tmp / "ssh_host_ed25519_key.pub"
        self.host_pub.write_text("ssh-ed25519 AAAAHOSTKEYBLOB root@nightshift\n")
        self.command = self.tmp / "remote-deploy.sh"
        self.command.write_text("#!/bin/sh\n")
        self.command.chmod(0o755)
        self.env = {
            "PATH": f"{bindir}:{os.environ['PATH']}",
            "HOME": str(self.tmp),
            "NIGHTSHIFT_SSH_DIR": str(self.ssh),
            "NIGHTSHIFT_HOST_KEY_PUB": str(self.host_pub),
            "NIGHTSHIFT_DEPLOY_COMMAND": str(self.command),
            "NIGHTSHIFT_ALLOW_ROOT": "1",
        }

    def setup(self, *args, **extra):
        # stdout is a pipe here, never a terminal: exactly the case where the
        # private key must not be printed.
        return subprocess.run(
            ["bash", str(SETUP), *args], env={**self.env, **extra}, capture_output=True, text=True, timeout=30
        )

    def auth_lines(self):
        return (self.ssh / "authorized_keys").read_text().splitlines()

    def test_adds_one_restricted_line_and_prints_what_github_needs(self):
        self.ssh.mkdir(mode=0o700)
        (self.ssh / "authorized_keys").write_text("ssh-ed25519 AAAAOWNERKEY owner@laptop\n")
        proc = self.setup("168.119.142.178")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = self.auth_lines()
        self.assertEqual(lines[0], "ssh-ed25519 AAAAOWNERKEY owner@laptop")  # untouched
        self.assertEqual(len(lines), 2)
        self.assertTrue(
            lines[1].startswith(
                f'command="{self.command}",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty'
            ),
            lines[1],
        )
        self.assertEqual(stat.S_IMODE((self.ssh / "authorized_keys").stat().st_mode), 0o600)
        self.assertIn("\n168.119.142.178 ssh-ed25519 AAAAHOSTKEYBLOB\n", proc.stdout)
        self.assertIn("DEPLOY_HOST          168.119.142.178", proc.stdout)

    def test_the_private_key_is_never_printed_into_a_pipe(self):
        proc = self.setup("168.119.142.178")
        self.assertNotIn("PRIVATE-", proc.stdout + proc.stderr)
        self.assertNotIn("BEGIN OPENSSH", proc.stdout + proc.stderr)
        self.assertIn("not a terminal", proc.stdout)

    def test_running_again_does_not_duplicate_and_repairs_an_unrestricted_copy(self):
        self.assertEqual(self.setup("168.119.142.178").returncode, 0)
        first = self.auth_lines()
        self.assertEqual(self.setup("168.119.142.178").returncode, 0)
        self.assertEqual(self.auth_lines(), first)
        # Someone pasted the bare public key too: it would open a shell.
        pub = (self.ssh / "gha_deploy.pub").read_text()
        with open(self.ssh / "authorized_keys", "a") as f:
            f.write(pub)
        self.assertEqual(self.setup("168.119.142.178").returncode, 0)
        self.assertEqual(self.auth_lines(), first)

    def test_delete_private_key_keeps_the_access_line(self):
        self.assertEqual(self.setup("168.119.142.178").returncode, 0)
        before = self.auth_lines()
        proc = self.setup("--delete-private-key")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse((self.ssh / "gha_deploy").exists())
        self.assertTrue((self.ssh / "gha_deploy.pub").exists())
        self.assertEqual(self.auth_lines(), before)
        # A later run says where the key went instead of failing.
        proc = self.setup("168.119.142.178")
        self.assertEqual(proc.returncode, 0)
        self.assertIn("--rotate", proc.stdout)

    def test_rotate_replaces_the_key(self):
        self.assertEqual(self.setup("168.119.142.178").returncode, 0)
        old = self.auth_lines()
        self.assertEqual(self.setup("--rotate", "168.119.142.178").returncode, 0)
        new = self.auth_lines()
        self.assertEqual(len(new), 1)
        self.assertNotEqual(new, old)

    def test_needs_the_address_and_an_executable_forced_command(self):
        self.assertNotEqual(self.setup().returncode, 0)
        self.command.chmod(0o644)
        proc = self.setup("168.119.142.178")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("git -C /opt/nightshift/app pull", proc.stderr)

    @unittest.skipUnless(hasattr(os, "geteuid") and os.geteuid() == 0, "only meaningful as root")
    def test_refuses_root(self):
        proc = self.setup("168.119.142.178", NIGHTSHIFT_ALLOW_ROOT="")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("not root", proc.stderr)


class ShellScriptTests(unittest.TestCase):
    SCRIPTS = (REMOTE, SETUP)

    def test_scripts_are_executable(self):
        # The forced command is exec'd by sshd directly; without +x the deploy
        # fails with a bare "Permission denied".
        for path in self.SCRIPTS:
            self.assertTrue(os.access(path, os.X_OK), path.name)
        ls = subprocess.run(
            ["git", "ls-files", "-s", *[str(p.relative_to(ROOT)) for p in self.SCRIPTS]],
            cwd=ROOT, capture_output=True, text=True,
        )
        for line in ls.stdout.splitlines():
            self.assertTrue(line.startswith("100755"), line)

    @unittest.skipUnless(shutil.which("bash"), "bash not installed")
    def test_bash_parses_them(self):
        for path in self.SCRIPTS:
            proc = subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, proc.stderr)

    @unittest.skipUnless(shutil.which("shellcheck"), "shellcheck not installed")
    def test_shellcheck_is_clean(self):
        proc = subprocess.run(["shellcheck", *map(str, self.SCRIPTS)], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stdout)


# ── The pipeline worker ─────────────────────────────────────────────────────


def worker_example_keys():
    return [m.group(1) for m in re.finditer(r"^([A-Z][A-Z0-9_]*)=", WORKER_EXAMPLE.read_text(), re.M)]


def _worker_secret_keys():
    """Keys above the "Behaviour" heading are repository secrets; below, variables."""
    head = WORKER_EXAMPLE.read_text().split("# ─── Behaviour")[0]
    return set(re.findall(r"^([A-Z][A-Z0-9_]*)=", head, re.M))


def _load_builder():
    import importlib.util

    spec = importlib.util.spec_from_file_location("build_worker_env", BUILD_WORKER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class WorkerWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.step = step(name="Build the worker env")
        self.mapped = {k[len("WORKERENV_"):]: v for k, v in self.step["env"].items() if k.startswith("WORKERENV_")}

    def test_every_worker_key_is_mapped_by_its_own_name(self):
        self.assertEqual(sorted(self.mapped), sorted(worker_example_keys()))
        secret = _worker_secret_keys()
        for key, expr in self.mapped.items():
            kind = "secrets" if key in secret else "vars"
            self.assertEqual(expr, f"${{{{ {kind}.{key} }}}}", key)

    def test_credentials_are_secrets(self):
        for key in self.mapped:
            if CREDENTIAL.search(key) or key.endswith("_JSON"):
                self.assertIn(key, _worker_secret_keys(), key)

    def test_runs_only_while_the_worker_is_switched_on(self):
        self.assertIn("vars.NIGHTSHIFT_WORKER == 'on'", self.step["if"])
        self.assertIn("steps.payload.outputs.run == 'true'", self.step["if"])
        self.assertEqual(self.step["run"].strip(), 'python3 deploy/build-worker-env.py "$PAYLOAD"')
        self.assertEqual(self.step["env"]["ALL_SECRETS"], "${{ toJSON(secrets) }}")

    def test_runs_after_the_web_env_and_before_ssh(self):
        names = [s.get("name") for s in steps()]
        self.assertLess(names.index("Build the server env"), names.index("Build the worker env"))
        self.assertLess(names.index("Build the worker env"), names.index("Deploy over SSH"))

    def test_the_worker_image_inputs_trigger_a_deploy(self):
        paths = workflow()[True]["push"]["paths"]
        for path in ("Dockerfile.worker", "requirements.txt", "main.py", "modules/**", "tools/**"):
            self.assertIn(path, paths)


class BuildWorkerEnvTests(unittest.TestCase):
    SECRET = "worker-secret-never-printed"

    def setUp(self):
        self.mod = _load_builder()
        self.example = WORKER_EXAMPLE.read_text()

    def env(self, secrets=None, **values):
        env = {f"WORKERENV_{k}": "" for k in worker_example_keys()}
        env.update(WORKERENV_SUPABASE_URL="https://abc.supabase.co", WORKERENV_SUPABASE_SERVICE_KEY=self.SECRET)
        env.update({f"WORKERENV_{k}": v for k, v in values.items()})
        env["ALL_SECRETS"] = json.dumps(secrets if secrets is not None else {})
        return {k: v for k, v in env.items() if v is not None}

    def build(self, **kw):
        return self.mod.build(self.env(**kw), self.example)

    def test_one_line_per_key_and_the_channel_tokens_only(self):
        token = '{\n  "token": "t",\n  "refresh_token": "r"\n}'
        lines, errors = self.build(secrets={
            "CHRONOS_YT_TOKEN_FINANCE": token,
            "DEPLOY_SSH_KEY": "-----BEGIN-----",
            "GH_SECRETS_TOKEN": "ghp_x",
            "github_token": "ghs_x",
        })
        self.assertEqual(errors, [])
        keys = [l.split("=", 1)[0] for l in lines]
        self.assertEqual(keys[: len(worker_example_keys())], worker_example_keys())
        self.assertIn('CHRONOS_YT_TOKEN_FINANCE={"token":"t","refresh_token":"r"}', lines)
        for other in ("DEPLOY_SSH_KEY", "GH_SECRETS_TOKEN", "github_token"):
            self.assertNotIn(other, keys)

    def test_json_secrets_are_compacted_to_one_line(self):
        lines, errors = self.build(YOUTUBE_CLIENT_SECRET_JSON='{\r\n "installed": {"client_id": "c"}\r\n}\n')
        self.assertEqual(errors, [])
        self.assertIn('YOUTUBE_CLIENT_SECRET_JSON={"installed":{"client_id":"c"}}', lines)

    def test_problems_are_named_by_key_never_by_value(self):
        lines, errors = self.build(
            GEMINI_API_KEY="ab$" + self.SECRET,
            YOUTUBE_TOKEN_JSON="not json " + self.SECRET,
            PEXELS_API_KEY="two\nlines" + self.SECRET,
        )
        text = "\n".join(errors)
        self.assertIn("GEMINI_API_KEY contains", text)
        self.assertIn("YOUTUBE_TOKEN_JSON is not valid JSON", text)
        self.assertIn("PEXELS_API_KEY contains a line break", text)
        self.assertNotIn(self.SECRET, text)

    def test_the_queue_keys_are_required(self):
        _, errors = self.build(SUPABASE_SERVICE_KEY="")
        self.assertIn("SUPABASE_SERVICE_KEY is required", "\n".join(errors))

    def test_a_key_the_workflow_forgot_fails(self):
        _, errors = self.build(OPENAI_API_KEY=None)
        self.assertIn("OPENAI_API_KEY is in deploy/.env.worker.example but not mapped", "\n".join(errors))

    def test_main_appends_the_marker_and_prints_no_value(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        payload = tmp / "payload"
        payload.write_text("NIGHTSHIFT_DEPLOY_SHA=" + "a" * 40 + "\nDOMAIN=x\n")
        env = dict(self.env(), PATH=os.environ["PATH"])
        proc = subprocess.run(
            [sys.executable, str(BUILD_WORKER), str(payload)], env=env, capture_output=True, text=True, timeout=30
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        lines = payload.read_text().splitlines()
        self.assertEqual(lines[2], "NIGHTSHIFT_WORKER_ENV=on")
        self.assertIn(f"SUPABASE_SERVICE_KEY={self.SECRET}", lines)
        self.assertNotIn(self.SECRET, proc.stdout + proc.stderr)
        # A refused env leaves the payload as it was.
        before = payload.read_text()
        env["WORKERENV_SUPABASE_SERVICE_KEY"] = ""
        proc = subprocess.run(
            [sys.executable, str(BUILD_WORKER), str(payload)], env=env, capture_output=True, text=True, timeout=30
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(payload.read_text(), before)


@unittest.skipUnless(shutil.which("bash") and shutil.which("git") and shutil.which("flock"), "bash, git, flock needed")
class RemoteDeployWorkerTests(_RemoteDeployFixture):
    """The worker section of the payload, on the same fixture."""

    def worker_payload(self, drop=(), **values):
        vals = {k: "" for k in worker_example_keys()}
        vals.update(SUPABASE_URL="https://abc.supabase.co", SUPABASE_SERVICE_KEY=self.SECRET)
        vals.update(values)
        lines = ["NIGHTSHIFT_WORKER_ENV=on"] + [f"{k}={v}" for k, v in vals.items() if k not in drop]
        return self.payload() + "\n".join(lines) + "\n"

    def test_the_worker_env_is_written_600_and_the_worker_started_after_web(self):
        proc = self.deploy(self.worker_payload(CHRONOS_YT_TOKEN_FINANCE='{"token":"t"}'))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(stat.S_IMODE(self.worker_env_file.stat().st_mode), 0o600)
        text = self.worker_env_file.read_text()
        self.assertIn(f"SUPABASE_SERVICE_KEY={self.SECRET}\n", text)
        self.assertIn('CHRONOS_YT_TOKEN_FINANCE={"token":"t"}\n', text)
        # The dashboard's file never gets a worker key.
        web = self.env_file.read_text()
        self.assertNotIn("SUPABASE_SERVICE_KEY", web)
        self.assertNotIn("NIGHTSHIFT_WORKER_ENV", web)
        calls = self.docker_calls()
        web_up = [i for i, c in enumerate(calls) if c.endswith("up -d --build --remove-orphans web caddy")]
        worker_up = [i for i, c in enumerate(calls) if c.endswith("up -d --build --no-deps worker")]
        self.assertEqual(len(web_up), 1)
        self.assertEqual(len(worker_up), 1)
        self.assertLess(web_up[0], worker_up[0])
        self.assertTrue(all("--profile worker" in c for c in calls if " up " in f" {c} "))
        self.assertIn("worker on", proc.stdout)

    def test_switching_the_worker_off_removes_it_and_its_keys(self):
        self.assertEqual(self.deploy(self.worker_payload()).returncode, 0)
        self.assertTrue(self.worker_env_file.exists())
        proc = self.deploy(self.payload())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(self.worker_env_file.exists())
        self.assertFalse(Path(str(self.worker_env_file) + ".prev").exists())
        self.assertTrue(any(c.endswith("rm --stop --force worker") for c in self.docker_calls()))

    def test_a_key_the_worker_does_not_read_is_refused(self):
        proc = self.deploy(self.worker_payload(DEPLOY_SSH_KEY=self.SECRET))
        self.assertRefused(proc, "DEPLOY_SSH_KEY is not a key in deploy/.env.worker.example")
        self.assertFalse(self.worker_env_file.exists())

    def test_a_web_key_is_not_accepted_in_the_worker_section_nor_the_reverse(self):
        self.assertRefused(self.deploy(self.worker_payload(DOMAIN="x")), "DOMAIN is not a key in deploy/.env.worker.example")
        self.assertRefused(
            self.deploy(self.payload(CHRONOS_YT_TOKEN_FINANCE="{}")),
            "CHRONOS_YT_TOKEN_FINANCE is not a key in deploy/.env.web.example",
        )

    def test_worker_values_are_checked_like_web_ones(self):
        self.assertRefused(self.deploy(self.worker_payload(SUPABASE_SERVICE_KEY="")), "SUPABASE_SERVICE_KEY is required")
        self.assertRefused(self.deploy(self.worker_payload(GEMINI_API_KEY="a$b")), "GEMINI_API_KEY contains")
        self.assertRefused(self.deploy(self.worker_payload(drop=("OPENAI_API_KEY",))), "OPENAI_API_KEY is missing")

    def test_a_worker_that_fails_to_start_fails_the_deploy_after_web(self):
        proc = self.deploy(self.worker_payload(), FAKE_WORKER_UP_RC="1")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("the worker did not start", proc.stderr)


if __name__ == "__main__":
    unittest.main()
