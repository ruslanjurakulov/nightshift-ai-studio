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

import hashlib
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
NOTIFY_EXAMPLE = ROOT / "deploy" / ".env.notify.example"
EMAIL_EXAMPLE = ROOT / "deploy" / ".env.email.example"
BUILD_SERVICE = ROOT / "deploy" / "build-service-env.py"
OPERATOR_EXAMPLE = ROOT / "deploy" / ".env.operator.example"
MARKETING_EXAMPLE = ROOT / "deploy" / ".env.marketing.example"
TELEGRAM_WORKFLOW = ROOT / ".github" / "workflows" / "telegram_control.yml"
ALERTS_WORKFLOW = ROOT / ".github" / "workflows" / "operator_alerts.yml"

REQUIRED = ("DOMAIN", "ACME_EMAIL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY")
# Anything that grants access. GOOGLE_OAUTH_CLIENT_ID is not a credential on its
# own, but it names which OAuth app the dashboard is, so it stays with its secret.
# Judged on the end of the name: GITHUB_SECRETS_REPO is an owner/repo, not a secret.
CREDENTIAL = re.compile(r"(TOKEN|SECRET|PASSWORD|_KEY)$|WEBHOOK")
# INSTAGRAM_APP_ID likewise names the Meta app the tokens belong to.
EXTRA_SECRETS = {"GOOGLE_OAUTH_CLIENT_ID", "INSTAGRAM_APP_ID"}
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
            if s.get("name") in ("Build the worker env", "Build the notify env", "Build the e-mail env",
                                 "Build the operator-bot env", "Build the marketing env"):
                continue
            self.assertNotRegex(yaml.safe_dump(s), r"(secrets|vars)\.\w*SERVICE", s.get("name"))

    def test_never_runs_for_a_pull_request(self):
        on = workflow()[True]  # YAML 1.1 reads the bare key `on` as True
        self.assertNotIn("pull_request", on)
        self.assertNotIn("pull_request_target", on)
        self.assertEqual(on["push"]["branches"], ["main"])
        self.assertIn("workflow_dispatch", on)
        for path in ("command-center/**", "deploy/**", ".github/workflows/deploy_web.yml", "docs/news/**",
                     "docs/promo/**"):
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
      # The caddy service: the config on stdin decides what happens, through
      # markers in its text. A reload makes it the "live" config the fake curl reads.
      *" exec -T caddy true"*) exit "${FAKE_CADDY_EXEC_RC:-0}" ;;
      *" exec -T caddy wget "*) [[ -s "$FAKE_CADDY_LIVE" ]] && cat "$FAKE_CADDY_LIVE"; exit 0 ;;
      *" exec -T caddy caddy "*)
        all="$*"; sub="${all##* exec -T caddy caddy }"; sub="${sub%% *}"
        cat >"$FAKE_DOCKER_LOG.stdin"; body="$(cat "$FAKE_DOCKER_LOG.stdin")"
        echo "STDIN $sub $(sha256sum <"$FAKE_DOCKER_LOG.stdin" | cut -d' ' -f1)" >>"$FAKE_DOCKER_LOG"
        case "$sub" in
          validate) [[ "$body" == *SYNTAX* ]] && exit 1; exit 0 ;;
          adapt)
            j='{"X-Frame-Options":["DENY"],"Permissions-Policy":["x"],"X-Content-Type-Options":["nosniff"],"Referrer-Policy":["strict-origin-when-cross-origin"],"delete":["Server","X-Powered-By"]'
            [[ "$body" == *NO_HSTS_STATIC* ]] || j="$j,\\"Strict-Transport-Security\\":[\\"max-age=31536000\\"]"
            [[ "$body" == *WIDEN* ]] && j="$j,\\"X-Frame-Options\\":[\\"SAMEORIGIN\\"]"
            echo "$j}"; exit 0 ;;
          reload) [[ "$body" == *RELOAD_FAILS* ]] && exit 1; printf '%s' "$body" >"$FAKE_CADDY_LIVE"; exit 0 ;;
        esac
        exit 0 ;;
      *" up "*creative-worker) exit "${FAKE_CREATIVE_UP_RC:-0}" ;;
      *" up "*marketing-worker) exit "${FAKE_MARKETING_UP_RC:-0}" ;;
      *" up "*notify-worker) exit "${FAKE_NOTIFY_UP_RC:-0}" ;;
      *" up "*email-worker) exit "${FAKE_EMAIL_UP_RC:-0}" ;;
      *" up "*operator-bot) exit "${FAKE_OPERATOR_UP_RC:-0}" ;;
      *" up "*worker) exit "${FAKE_WORKER_UP_RC:-0}" ;;
      *" up "*) exit "${FAKE_UP_RC:-0}" ;;
      *" ps -q web"|*" ps -aq web") echo cid123 ;;
      *" ps -q worker"|*" ps -q media-worker"|*" ps -q creative-worker"|*" ps -q notify-worker"|*" ps -q email-worker"|*" ps -q operator-bot"|*" ps -q marketing-worker") echo cidw ;;
      inspect*) echo "${FAKE_HEALTH:-healthy}" ;;
      logs*) echo "${FAKE_LOG_TEXT:-}" ;;
      *" logs "*) echo "${FAKE_LOG_TEXT:-}" ;;
    esac
    exit 0
    """
)


FAKE_CURL = textwrap.dedent(
    """\
    #!/usr/bin/env bash
    # Answers like Caddy would for the config last "reloaded" (FAKE_CADDY_LIVE).
    live="$(cat "$FAKE_CADDY_LIVE" 2>/dev/null)"
    [[ -n "$live" ]] || exit 7
    framed=0
    for a in "$@"; do url="$a"; [[ "$a" == "Sec-Fetch-Dest: iframe" ]] && framed=1; done
    rest="${url#*://}"; path="/${rest#*/}"
    if [[ "$live" == *APP_DOWN* ]]; then echo "HTTP/1.1 502 Bad Gateway"; else echo "HTTP/1.1 200 OK"; fi
    [[ "$live" == *NO_HSTS_LIVE* ]] || echo "Strict-Transport-Security: max-age=31536000"
    echo "X-Content-Type-Options: nosniff"
    echo "Referrer-Policy: strict-origin-when-cross-origin"
    echo "Permissions-Policy: camera=()"
    [[ "$live" == *SERVER_LEAK* ]] && echo "Server: Caddy"
    if [[ "$live" == *ODD_XFO* ]]; then
      echo "X-Frame-Options: ALLOW-FROM https://attacker.example"
    elif [[ "$framed" == 1 && ( "$path" == /login || "$live" == *FRAME_ALL* ) && "$live" != *NO_SAMEORIGIN* ]]; then
      echo "X-Frame-Options: SAMEORIGIN"
    else
      echo "X-Frame-Options: DENY"
      [[ "$live" == *DOUBLE_XFO* ]] && echo "X-Frame-Options: DENY"
    fi
    echo
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
        shutil.copy(NOTIFY_EXAMPLE, up / "deploy" / ".env.notify.example")
        shutil.copy(EMAIL_EXAMPLE, up / "deploy" / ".env.email.example")
        shutil.copy(OPERATOR_EXAMPLE, up / "deploy" / ".env.operator.example")
        shutil.copy(MARKETING_EXAMPLE, up / "deploy" / ".env.marketing.example")
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
        self.notify_env_file = self.tmp / ".env.notify"
        self.email_env_file = self.tmp / ".env.email"
        self.operator_env_file = self.tmp / ".env.operator"
        self.marketing_env_file = self.tmp / ".env.marketing"

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
            NIGHTSHIFT_NOTIFY_ENV_FILE=str(self.notify_env_file),
            NIGHTSHIFT_EMAIL_ENV_FILE=str(self.email_env_file),
            NIGHTSHIFT_OPERATOR_ENV_FILE=str(self.operator_env_file),
            NIGHTSHIFT_MARKETING_ENV_FILE=str(self.marketing_env_file),
            NIGHTSHIFT_LOCK_FILE=str(self.tmp / ".deploy.lock"),
            NIGHTSHIFT_DOCKER=str(self.tmp / "docker"),
            NIGHTSHIFT_HEALTH_TIMEOUT="10",
            NIGHTSHIFT_WORKER_SETTLE_SECONDS="0",
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

    def test_an_unhealthy_web_names_why_without_printing_the_log(self):
        secret = "ana@example.com /reset?token=s3cr3t"
        proc = self.deploy(
            self.payload(),
            FAKE_HEALTH="unhealthy",
            FAKE_LOG_TEXT=f"Error: EROFS: read-only file system, mkdir '/app/x'\nTypeError: {secret}",
        )
        self.assertNotEqual(proc.returncode, 0)
        out = proc.stdout + proc.stderr
        self.assertIn("web diagnostics: ", out)
        self.assertIn("log names=EROFS,TypeError", out)
        self.assertIn("read-only_file_system", out)
        for leaked in ("ana@example.com", "s3cr3t", "/app/x"):
            self.assertNotIn(leaked, out)

    def test_diagnostic_names_come_only_from_the_fixed_list(self):
        # A crafted path, an e-mail local part or a code-shaped token that is
        # not on the list must not appear: an open pattern would carry it.
        proc = self.deploy(
            self.payload(),
            FAKE_HEALTH="unhealthy",
            FAKE_LOG_TEXT="GET /api/SecretValueError 500\nkey (email)=(AnaError@example.com)\nERR_LEAKED_VALUE_HERE\nMyTypeError ERR_INVALID_URL_SCHEME",
        )
        out = proc.stdout + proc.stderr
        self.assertIn("log names=none", out)
        for leaked in ("SecretValueError", "AnaError", "ERR_LEAKED", "MyTypeError", "ERR_INVALID_URL_SCHEME"):
            self.assertNotIn(leaked, out)

    def test_a_failed_compose_up_also_reports_web_diagnostics(self):
        proc = self.deploy(self.payload(), FAKE_UP_RC="1", FAKE_LOG_TEXT="SyntaxError: nope")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("log names=SyntaxError", proc.stdout + proc.stderr)

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


@unittest.skipUnless(shutil.which("bash") and shutil.which("git") and shutil.which("flock"), "bash, git, flock needed")
class RemoteDeployCaddyTests(_RemoteDeployFixture):
    """The Caddy step: validate, guard, reload, verify, roll back (fake docker + fake curl)."""

    def setUp(self):
        super().setUp()
        self.caddyfile = (ROOT / "deploy" / "Caddyfile").read_text()
        curl = self.tmp / "curl"
        curl.write_text(FAKE_CURL)
        curl.chmod(0o755)
        self.live = self.tmp / "caddy.live"
        self.state = self.tmp  # the env file's directory, where the step keeps its marker
        self.approved = {}

    def push(self, marker="", data=None):
        """A new commit on upstream main whose Caddyfile carries `marker` (a comment), or exactly `data`.

        The hash gate is satisfied by default (the pushed file is the approved one); pass
        approved= to deploy_caddy to test the gate itself.
        """
        up = self.tmp / "upstream"
        data = data if data is not None else f"{self.caddyfile}\n# {marker}\n".encode()
        (up / "deploy" / "Caddyfile").write_bytes(data)
        self.git(up, "add", "-A")
        self.git(up, "commit", "-q", "-m", f"caddyfile {marker}")
        sha = self.git(up, "rev-parse", "HEAD")
        self.approved[sha] = hashlib.sha256(data).hexdigest()
        return sha

    def deploy_caddy(self, sha, approved=None, **extra):
        return self.deploy(
            self.payload(sha=sha),
            NIGHTSHIFT_CADDYFILE_APPROVED_SHA256=approved or self.approved[sha],
            NIGHTSHIFT_CURL=str(self.tmp / "curl"),
            FAKE_CADDY_LIVE=str(self.live),
            NIGHTSHIFT_CADDY_VERIFY_TIMEOUT="0",
            NIGHTSHIFT_CADDY_RETRY_SLEEP="0",
            **extra,
        )

    def caddy_calls(self):
        return [c.split(" exec -T caddy caddy ")[1].split()[0] for c in self.docker_calls() if " exec -T caddy caddy " in c]

    def loaded(self):
        return (self.state / ".caddyfile.loaded").read_text()

    def assertNoTemp(self):
        """No temporary copy of the Caddyfile is left in the state directory."""
        known = {".caddyfile.loaded", ".caddyfile.loaded.sha256", ".caddyfile.fallback", ".caddy-running.json"}
        left = [f.name for f in self.state.iterdir() if f.name.startswith((".caddyfile.", ".caddy-")) and f.name not in known]
        self.assertEqual(left, [])

    def test_validate_then_guard_then_reload_after_compose_up_and_web_healthy(self):
        sha = self.push("v1")
        proc = self.deploy_caddy(sha)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.caddy_calls(), ["validate", "adapt", "reload"])
        calls = self.docker_calls()
        up = next(i for i, c in enumerate(calls) if c.endswith("up -d --build --remove-orphans web caddy"))
        first = next(i for i, c in enumerate(calls) if " exec -T caddy caddy validate" in c)
        self.assertLess(up, first)
        self.assertIn("loaded and verified", proc.stdout)
        # The config is read from the checkout on stdin, not from the bind mount.
        self.assertTrue(all("--config -" in c for c in calls if " exec -T caddy caddy " in c))
        self.assertIn("# v1", self.live.read_text())
        self.assertIn("# v1", self.loaded())
        marker = self.state / ".caddyfile.loaded.sha256"
        self.assertEqual(len(marker.read_text().strip()), 64)
        for f in (marker, self.state / ".caddyfile.loaded"):
            self.assertEqual(stat.S_IMODE(f.stat().st_mode), 0o600)

    def test_an_unchanged_file_is_reported_unchanged_and_still_verified(self):
        sha = self.push("v1")
        self.assertEqual(self.deploy_caddy(sha).returncode, 0)
        self.docker_log.unlink()
        proc = self.deploy_caddy(sha)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("Caddyfile unchanged since the last good load", proc.stdout)
        self.assertEqual(self.caddy_calls(), ["validate", "adapt", "reload"])

    def test_a_file_that_does_not_validate_is_never_loaded(self):
        good = self.deploy_caddy(self.push("v1"))
        self.assertEqual(good.returncode, 0, good.stderr)
        self.docker_log.unlink()
        proc = self.deploy_caddy(self.push("SYNTAX"))
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("validate refused", proc.stderr)
        self.assertNoTemp()
        self.assertEqual(self.caddy_calls(), ["validate"])
        self.assertIn("# v1", self.live.read_text())
        self.assertIn("# v1", self.loaded())

    def test_a_file_that_drops_a_baseline_header_is_refused_before_loading(self):
        self.assertEqual(self.deploy_caddy(self.push("v1")).returncode, 0)
        self.docker_log.unlink()
        proc = self.deploy_caddy(self.push("NO_HSTS_STATIC"))
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("no longer sets: Strict-Transport-Security", proc.stderr)
        self.assertNoTemp()
        self.assertNotIn("reload", self.caddy_calls())
        self.assertIn("# v1", self.live.read_text())

    def test_a_file_that_widens_frame_options_is_refused_before_loading(self):
        self.assertEqual(self.deploy_caddy(self.push("v1")).returncode, 0)
        self.docker_log.unlink()
        proc = self.deploy_caddy(self.push("WIDEN"))
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("only DENY may be set", proc.stderr)
        self.assertNotIn("reload", self.caddy_calls())

    def test_wrong_headers_after_the_reload_restore_the_previous_file_and_fail(self):
        self.assertEqual(self.deploy_caddy(self.push("v1")).returncode, 0)
        for bad, expect in (
            ("NO_SAMEORIGIN", "expected exactly one SAMEORIGIN"),
            ("DOUBLE_XFO", "expected exactly one DENY"),
            ("NO_HSTS_LIVE", "Strict-Transport-Security is missing"),
            ("SERVER_LEAK", "Server is sent"),
            ("FRAME_ALL", "/auth/callback (iframe)"),
        ):
            with self.subTest(bad=bad):
                self.docker_log.unlink(missing_ok=True)
                proc = self.deploy_caddy(self.push(bad))
                self.assertNotEqual(proc.returncode, 0, proc.stdout)
                self.assertIn(expect, proc.stderr)
                self.assertIn("previous config is back", proc.stderr)
                self.assertEqual(self.caddy_calls(), ["validate", "adapt", "reload", "reload"])
                self.assertIn("# v1", self.live.read_text())
                self.assertNotIn(bad, self.live.read_text())
                self.assertIn("# v1", self.loaded())  # the bad file never becomes the rollback copy
                self.assertNoTemp()

    def test_a_reload_that_fails_restores_and_fails(self):
        self.assertEqual(self.deploy_caddy(self.push("v1")).returncode, 0)
        proc = self.deploy_caddy(self.push("RELOAD_FAILS"))
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("reload failed", proc.stderr)
        self.assertIn("# v1", self.live.read_text())

    def test_first_ever_failure_with_no_copy_still_fails_loudly(self):
        proc = self.deploy_caddy(self.push("NO_SAMEORIGIN"))
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("no earlier config", proc.stderr)
        self.assertFalse((self.state / ".caddyfile.loaded").exists())
        self.assertFalse((self.state / ".caddyfile.loaded.sha256").exists())

    def test_the_commit_before_is_the_fallback_copy_on_the_first_run(self):
        # The server already runs commit X (with a Caddyfile) when this script first handles a Caddyfile.
        x = self.push("old")
        self.git(self.app, "fetch", "-q", "origin")
        self.git(self.app, "checkout", "-q", "-B", "main", x)
        proc = self.deploy_caddy(self.push("NO_SAMEORIGIN"))
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("previous config is back", proc.stderr)
        self.assertIn("# old", self.live.read_text())
        self.assertFalse((self.state / ".caddyfile.loaded.sha256").exists(), "a seed must not count as loaded")

    def test_the_bytes_that_were_hashed_are_the_bytes_validated_adapted_reloaded_and_kept(self):
        sha = self.push("v1")
        proc = self.deploy_caddy(sha)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        fed = [l.split() for l in self.docker_calls() if l.startswith("STDIN ")]
        self.assertEqual([f[1] for f in fed], ["validate", "adapt", "reload"])
        self.assertEqual({f[2] for f in fed}, {self.approved[sha]})
        self.assertEqual(hashlib.sha256((self.state / ".caddyfile.loaded").read_bytes()).hexdigest(), self.approved[sha])
        self.assertNoTemp()

    def test_a_symlinked_caddyfile_is_refused_and_nothing_is_left_behind(self):
        up = self.tmp / "upstream"
        real = up / "deploy" / "Caddyfile.real"
        real.write_text(self.caddyfile)
        (up / "deploy" / "Caddyfile").symlink_to("Caddyfile.real")
        self.git(up, "add", "-A")
        self.git(up, "commit", "-q", "-m", "symlink")
        sha = self.git(up, "rev-parse", "HEAD")
        proc = self.deploy_caddy(sha, approved=hashlib.sha256(real.read_bytes()).hexdigest())
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("is a symlink", proc.stderr)
        self.assertFalse([c for c in self.docker_calls() if " exec " in c])
        self.assertFalse(self.live.exists())
        self.assertNoTemp()

    def test_a_caddyfile_that_is_not_the_approved_one_is_not_even_validated(self):
        sha = self.push("v1")
        proc = self.deploy_caddy(sha, approved="0" * 64)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("deploy/Caddyfile changed", proc.stderr)
        self.assertNoTemp()
        self.assertIn("000000000000", proc.stderr)
        self.assertIn(self.approved[sha][:12], proc.stderr)
        self.assertIn("update CADDYFILE_APPROVED_SHA256", proc.stderr)
        self.assertNotIn(self.approved[sha], proc.stderr, "only 12-char hashes are printed")
        self.assertFalse([c for c in self.docker_calls() if " exec " in c], "caddy was touched")
        self.assertFalse(self.live.exists())
        self.assertFalse((self.state / ".caddyfile.loaded").exists())

    def test_any_byte_change_is_refused_before_any_reload(self):
        base = f"{self.caddyfile}\n# v1\n".encode()
        approved = hashlib.sha256(base).hexdigest()
        # Normalisation is deliberately NOT done: Caddy would read most of these the same,
        # but a different file is a file nobody approved.
        variants = {
            "crlf": base.replace(b"\n", b"\r\n"),
            "bom": b"\xef\xbb\xbf" + base,
            "no trailing newline": base.rstrip(b"\n"),
            "extra blank line": base + b"\n",
            "one letter": base.replace(b"nosniff", b"nosnifF"),
        }
        ok = self.deploy_caddy(self.push(data=base), approved=approved)
        self.assertEqual(ok.returncode, 0, ok.stderr)
        for name, data in variants.items():
            with self.subTest(name):
                self.docker_log.unlink(missing_ok=True)
                proc = self.deploy_caddy(self.push(name, data=data), approved=approved)
                self.assertNotEqual(proc.returncode, 0)
                self.assertIn("deploy/Caddyfile changed", proc.stderr)
                self.assertFalse([c for c in self.docker_calls() if " exec " in c])
                self.assertEqual(self.live.read_bytes(), base.rstrip(b"\n"))

    def test_a_stopped_caddy_service_is_not_blamed_on_the_file(self):
        proc = self.deploy_caddy(self.push("v1"), FAKE_CADDY_EXEC_RC="1")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("cannot run commands in the caddy service", proc.stderr)
        self.assertNotIn("validate refused", proc.stderr)
        self.assertEqual(self.caddy_calls(), [])

    def test_a_server_error_is_named_as_such_and_rolls_back(self):
        self.assertEqual(self.deploy_caddy(self.push("v1")).returncode, 0)
        proc = self.deploy_caddy(self.push("APP_DOWN"))
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("server error", proc.stderr)
        self.assertIn("# v1", self.live.read_text())

    def test_what_the_app_sent_is_reduced_to_a_word(self):
        proc = self.deploy_caddy(self.push("ODD_XFO"))
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("X-Frame-Options is 'other'", proc.stderr)
        self.assertNotIn("attacker", proc.stdout + proc.stderr)

    def test_the_running_config_is_the_first_run_rollback_not_the_commit_before(self):
        # The same commit deployed again: the checked-out file IS the file being applied.
        sha = self.push("NO_SAMEORIGIN")
        self.git(self.app, "fetch", "-q", "origin")
        self.git(self.app, "checkout", "-q", "-B", "main", sha)
        self.live.write_text("# running-before\n")
        proc = self.deploy_caddy(sha)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("previous config is back", proc.stderr)
        self.assertEqual(self.live.read_text().strip(), "# running-before")
        self.assertIn(".caddy-running.json", proc.stdout)
        self.assertFalse((self.state / ".caddyfile.loaded.sha256").exists())

    def test_a_marker_that_cannot_be_saved_is_not_reported_as_loaded(self):
        sha = self.push("v1")
        (self.state / ".caddyfile.loaded.sha256.tmp").mkdir()  # writing the marker fails
        proc = self.deploy_caddy(sha)
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("loaded and verified", proc.stdout)
        self.assertIn("could not be saved", proc.stderr)

    def test_nothing_is_printed_from_caddy_or_the_response(self):
        proc = self.deploy_caddy(self.push("DOUBLE_XFO"))
        out = proc.stdout + proc.stderr
        self.assertNotIn("camera=()", out)
        self.assertNotIn("HTTP/1.1", out)


def _free_port():
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


FAKE_DOCKER_REAL_CADDY = textwrap.dedent(
    """\
    #!/usr/bin/env bash
    # `compose exec -T caddy caddy ...` runs the real caddy binary against the real running one.
    printf '%s\\n' "$*" >>"$FAKE_DOCKER_LOG"
    all="$*"
    case "$all" in
      *" exec -T caddy true"*) exit 0 ;;
      *" exec -T caddy wget "*) exec curl -sf "http://127.0.0.1:$SIM_ADMIN/config/" ;;
      *" exec -T caddy caddy "*)
        # shellcheck disable=SC2086
        DOMAIN="http://example.test:$SIM_PORT" ACME_EMAIL=ops@example.com exec "$SIM_CADDY" ${all##* exec -T caddy caddy } ;;
      *" ps -q web"|*" ps -aq web") echo cid123 ;;
      inspect*) echo healthy ;;
    esac
    exit 0
    """
)


@unittest.skipUnless(
    shutil.which("bash") and shutil.which("git") and shutil.which("flock") and shutil.which("curl")
    and (os.environ.get("NIGHTSHIFT_TEST_CADDY") or shutil.which("caddy")),
    "needs a caddy binary (on PATH or NIGHTSHIFT_TEST_CADDY), curl, bash, git, flock",
)
class RemoteDeployRealCaddyTests(_RemoteDeployFixture):
    """The same step against a real Caddy process and a stub app.

    deploy/Caddyfile is used as it is, except for three lines that make it
    runnable on a laptop: the admin port, the upstream address and (through the
    container's DOMAIN) plain HTTP on a free port. Not verified here: real
    Docker, the compose bind mount, TLS, Cloudflare.
    """

    def setUp(self):
        import http.server
        import threading

        super().setUp()
        self.caddy_bin = os.environ.get("NIGHTSHIFT_TEST_CADDY") or shutil.which("caddy")
        self.port, self.admin, self.app_port = _free_port(), _free_port(), _free_port()

        class App(http.server.BaseHTTPRequestHandler):
            """What the app answers: one X-Frame-Options, SAMEORIGIN only for our own frame on a page."""

            def do_GET(h):
                framed = (
                    h.headers.get("Sec-Fetch-Dest") == "iframe"
                    and h.headers.get("Sec-Fetch-Site") == "same-origin"
                    and not h.path.startswith(("/auth", "/api"))
                )
                h.send_response(200)
                h.send_header("Server", "app")
                h.send_header("X-Powered-By", "Next.js")
                h.send_header("X-Frame-Options", "SAMEORIGIN" if framed else "DENY")
                h.send_header("Content-Length", "2")
                h.end_headers()
                h.wfile.write(b"ok")

            def log_message(h, *a):
                pass

        self.app_server = http.server.ThreadingHTTPServer(("127.0.0.1", self.app_port), App)
        threading.Thread(target=self.app_server.serve_forever, daemon=True).start()
        self.addCleanup(self.app_server.server_close)
        self.addCleanup(self.app_server.shutdown)

        docker = self.tmp / "docker"
        docker.write_text(FAKE_DOCKER_REAL_CADDY)
        self.base = (ROOT / "deploy" / "Caddyfile").read_text()
        self.good = self.runnable(self.base)
        self.caddy = None
        self.approved = {}

    def runnable(self, text):
        self.assertIn("\temail {$ACME_EMAIL}\n", text)
        self.assertIn("reverse_proxy web:3000", text)
        text = text.replace("\temail {$ACME_EMAIL}\n", f"\temail {{$ACME_EMAIL}}\n\tadmin 127.0.0.1:{self.admin}\n", 1)
        return text.replace("reverse_proxy web:3000", f"reverse_proxy 127.0.0.1:{self.app_port}", 1)

    def push(self, text):
        up = self.tmp / "upstream"
        (up / "deploy" / "Caddyfile").write_text(text)
        self.git(up, "add", "-A")
        self.git(up, "commit", "-q", "-m", "caddyfile")
        sha = self.git(up, "rev-parse", "HEAD")
        self.approved[sha] = hashlib.sha256(text.encode()).hexdigest()
        return sha

    def start_caddy(self, text):
        cfg = self.tmp / "running.Caddyfile"
        cfg.write_text(text)
        env = dict(os.environ, DOMAIN=f"http://example.test:{self.port}", ACME_EMAIL="ops@example.com")
        with open(self.tmp / "caddy.log", "w") as log:
            self.caddy = subprocess.Popen(
                [self.caddy_bin, "run", "--config", str(cfg), "--adapter", "caddyfile"],
                env=env, stdout=log, stderr=log, stdin=subprocess.DEVNULL,
            )
        self.addCleanup(self.caddy.wait)
        self.addCleanup(self.caddy.terminate)
        for _ in range(100):
            if self.get("/login").returncode == 0:
                return
            subprocess.run(["sleep", "0.1"])
        self.fail("caddy did not start: " + (self.tmp / "caddy.log").read_text()[-500:])

    def get(self, path, framed=False):
        args = ["curl", "-sS", "-i", "--http1.1", "--max-time", "5", "--resolve", f"example.test:{self.port}:127.0.0.1"]
        if framed:
            args += ["-H", "Sec-Fetch-Dest: iframe", "-H", "Sec-Fetch-Site: same-origin"]
        return subprocess.run(args + [f"http://example.test:{self.port}{path}"], capture_output=True, text=True)

    def xfo(self, path, framed=False):
        return re.findall(r"(?im)^x-frame-options: *(.*?)\r?$", self.get(path, framed).stdout)

    def deploy_real(self, sha):
        return self.deploy(
            self.payload(sha=sha),
            SIM_CADDY=self.caddy_bin, SIM_PORT=str(self.port), SIM_ADMIN=str(self.admin),
            NIGHTSHIFT_CADDYFILE_APPROVED_SHA256=self.approved[sha],
            NIGHTSHIFT_CADDY_VERIFY_HOST="example.test", NIGHTSHIFT_CADDY_VERIFY_SCHEME="http",
            NIGHTSHIFT_CADDY_VERIFY_PORT=str(self.port),
            NIGHTSHIFT_CADDY_VERIFY_TIMEOUT="0", NIGHTSHIFT_CADDY_RETRY_SLEEP="0",
        )

    def start_old_then(self, old):
        """Caddy runs `old` (as after a deploy that did not reload it); a good deploy is recorded first."""
        self.start_caddy(old)
        first = self.deploy_real(self.push(self.good))
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)

    def test_a_changed_caddyfile_takes_effect_without_a_restart(self):
        # Caddy still runs the pre-#426 behaviour: an unconditional DENY (the bug seen live).
        old = self.good.replace(
            "\t@notFrame not header Sec-Fetch-Dest iframe\n\theader @notFrame >X-Frame-Options", "\theader >X-Frame-Options"
        )
        self.assertNotEqual(old, self.good)
        self.start_caddy(old)
        pid = self.caddy.pid
        self.assertEqual(self.xfo("/login", framed=True), ["DENY"])
        proc = self.deploy_real(self.push(self.good))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(self.caddy.poll(), None)
        self.assertEqual(self.caddy.pid, pid)
        self.assertEqual(self.xfo("/login"), ["DENY"])
        self.assertEqual(self.xfo("/login", framed=True), ["SAMEORIGIN"])
        self.assertEqual(self.xfo("/auth/callback", framed=True), ["DENY"])
        self.assertEqual(self.xfo("/api/account", framed=True), ["DENY"])
        self.assertIn("loaded and verified", proc.stdout)

    def test_first_run_rollback_restores_the_running_config_even_if_the_commit_before_is_the_bad_file(self):
        # Caddy runs the good config; the bad file is already checked out (the same commit deployed
        # again), so the commit-before fallback would "restore" the bad file itself.
        bad = self.good.replace("\theader @notFrame >X-Frame-Options", "\theader >X-Frame-Options")
        self.assertNotEqual(bad, self.good)
        self.start_caddy(self.good)
        sha = self.push(bad)
        self.git(self.app, "fetch", "-q", "origin")
        self.git(self.app, "checkout", "-q", "-B", "main", sha)
        proc = self.deploy_real(sha)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("previous config is back", proc.stderr)
        self.assertIn(".caddy-running.json", proc.stdout)
        self.assertEqual(self.xfo("/login", framed=True), ["SAMEORIGIN"])
        self.assertEqual(self.xfo("/login"), ["DENY"])

    def test_the_repo_caddyfile_passes_its_own_contract(self):
        self.start_caddy(self.good)
        proc = self.deploy_real(self.push(self.good))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_bad_files_are_refused_or_rolled_back_and_the_old_config_keeps_serving(self):
        self.start_old_then(self.good)
        cases = {
            "syntax error": (self.good + "\nnot a directive {{{\n", "validate refused"),
            "HSTS dropped": (self.good.replace('\t\tStrict-Transport-Security "max-age=31536000"\n', ""), "no longer sets: Strict-Transport-Security"),
            "nosniff dropped": (self.good.replace('\t\tX-Content-Type-Options "nosniff"\n', ""), "no longer sets: X-Content-Type-Options"),
            "Server header no longer removed": (self.good.replace("\t\t-Server\n", ""), "no longer sets: -Server"),
            "DENY dropped": (self.good.replace('\theader @notFrame >X-Frame-Options "DENY"\n', ""), "no longer sets: X-Frame-Options"),
            "SAMEORIGIN set by Caddy": (self.good.replace('>X-Frame-Options "DENY"', '>X-Frame-Options "SAMEORIGIN"'), "no longer sets: X-Frame-Options"),
            # Passes the static guard, fails the live check: the frame rule is applied to every request again.
            "unconditional DENY": (
                self.good.replace("\theader @notFrame >X-Frame-Options", "\theader >X-Frame-Options"),
                "expected exactly one SAMEORIGIN",
            ),
            # Not deferred: Caddy adds its DENY beside the app's, two lines.
            "two DENY lines": (
                self.good.replace("header @notFrame >X-Frame-Options", "header @notFrame +X-Frame-Options"),
                "expected exactly one DENY",
            ),
        }
        self.assertTrue(all(text != self.good for text, _ in cases.values()))
        pid = self.caddy.pid
        for name, (text, expect) in cases.items():
            with self.subTest(name):
                proc = self.deploy_real(self.push(text))
                self.assertNotEqual(proc.returncode, 0, proc.stdout)
                self.assertIn(expect, proc.stderr)
                self.assertEqual(self.caddy.poll(), None)
                self.assertEqual(self.caddy.pid, pid)
                # Still serving exactly the old config.
                self.assertEqual(self.xfo("/login"), ["DENY"])
                self.assertEqual(self.xfo("/login", framed=True), ["SAMEORIGIN"])
                self.assertEqual(self.xfo("/api/account", framed=True), ["DENY"])
                self.assertEqual((self.tmp / ".caddyfile.loaded").read_text(), self.good)
                self.assertEqual(sorted(f.name for f in self.tmp.glob(".caddyfile.*")), [".caddyfile.loaded", ".caddyfile.loaded.sha256"])


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
        self.assertNotIn("ALL_SECRETS", self.step["env"])

    def test_never_dumps_every_secret(self):
        # GitHub flags toJSON(secrets) as possibly malicious and holds every
        # push-triggered run for manual approval: the deploy stops being automatic.
        self.assertNotRegex(WORKFLOW.read_text(), r"toJSON\(\s*secrets\s*\)")

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

    def test_one_line_per_key_and_nothing_from_other_secrets(self):
        # Even if a secrets dump were in the environment, only mapped keys go out.
        lines, errors = self.build(secrets={
            "CHRONOS_YT_TOKEN_FINANCE": '{"token": "t"}',
            "DEPLOY_SSH_KEY": "-----BEGIN-----",
            "GH_SECRETS_TOKEN": "ghp_x",
        })
        self.assertEqual(errors, [])
        keys = [l.split("=", 1)[0] for l in lines]
        self.assertEqual(keys, worker_example_keys())

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

    def test_each_worker_state_is_printed_after_start_as_numbers_not_log_text(self):
        proc = self.deploy(self.worker_payload())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        calls = self.docker_calls()
        inspects = [c for c in calls if c.startswith("inspect -f") and "ExitCode" in c]
        self.assertEqual(len(inspects), 2)
        self.assertTrue(any(c.startswith("inspect -f worker after") for c in inspects))
        self.assertTrue(any(c.startswith("inspect -f media-worker after") for c in inspects))
        # Log text is only ever matched against a fixed phrase list, never printed.
        self.assertTrue(all("--tail 200 media-worker" in c for c in calls if " logs" in f" {c}"))

    def test_the_media_worker_probe_runs_after_start_and_never_fails_the_deploy(self):
        proc = self.deploy(self.worker_payload())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        runs = [c for c in self.docker_calls() if " run " in f" {c} " and "--probe" in c]
        self.assertEqual(len(runs), 1)
        self.assertTrue(runs[0].endswith("run --rm --no-deps -T media-worker python tools/media_worker.py --probe"))

    def test_a_probe_that_prints_nothing_is_reported_with_its_exit_code_only(self):
        proc = self.deploy(self.worker_payload())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("probe: no result exit=0 error=none", proc.stdout)

    def test_log_hints_name_known_phrases_and_never_print_the_log_text(self):
        text = f"2026 media_worker ERROR NIGHTSHIFT_MEDIA_DIR is not a writable directory: /app/{self.SECRET}"
        proc = self.deploy(self.worker_payload(), FAKE_LOG_TEXT=text)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("media-worker log hints: not_a_writable_directory", proc.stdout)
        self.assertNotIn(self.SECRET, proc.stdout + proc.stderr)
        self.assertNotIn("/app/", proc.stdout)

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


@unittest.skipUnless(shutil.which("bash") and shutil.which("git") and shutil.which("flock"), "bash, git, flock needed")
class RemoteDeployCreativeWorkerTests(_RemoteDeployFixture):
    """The creative worker's switch: the worker-section line NIGHTSHIFT_CREATIVE_WORKER."""

    worker_payload = RemoteDeployWorkerTests.worker_payload

    def creative_calls(self):
        return [c for c in self.docker_calls() if c.endswith("creative-worker")]

    def test_on_starts_it_after_the_worker_and_prints_its_state_as_numbers(self):
        proc = self.deploy(self.worker_payload(NIGHTSHIFT_CREATIVE_WORKER="on"))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        calls = self.docker_calls()
        worker_up = [i for i, c in enumerate(calls) if c.endswith("up -d --build --no-deps worker")]
        creative_up = [i for i, c in enumerate(calls) if c.endswith("up -d --no-deps creative-worker")]
        self.assertEqual(len(creative_up), 1)
        self.assertLess(worker_up[0], creative_up[0])
        self.assertFalse(any("rm --stop --force creative-worker" in c for c in calls))
        state = [c for c in calls if c.startswith("inspect -f creative-worker after 0s:")]
        self.assertEqual(len(state), 1, calls)
        self.assertIn("state={{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}}", state[0])
        self.assertIn("creative-worker log hints:", proc.stdout)
        self.assertIn("creative-worker on", proc.stdout)
        # The switch is a key of the worker file, never of the dashboard's.
        self.assertIn("NIGHTSHIFT_CREATIVE_WORKER=on\n", self.worker_env_file.read_text())
        self.assertNotIn("NIGHTSHIFT_CREATIVE_WORKER", self.env_file.read_text())

    def test_anything_but_on_stops_and_removes_it(self):
        for value in ("", "off", "On", "yes", "on "):
            with self.subTest(value=value):
                self.docker_log.unlink(missing_ok=True)
                proc = self.deploy(self.worker_payload(NIGHTSHIFT_CREATIVE_WORKER=value))
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual(
                    [c for c in self.creative_calls() if " up " in f" {c} "], [], "started although not 'on'"
                )
                self.assertTrue(any(c.endswith("rm --stop --force creative-worker") for c in self.docker_calls()))
                self.assertIn("creative-worker is off", proc.stdout)
                self.assertFalse(any(c.startswith("inspect -f creative-worker") for c in self.docker_calls()))
                self.assertNotIn("creative-worker log hints", proc.stdout)

    def test_never_without_the_worker(self):
        # No worker section, so no switch line either: the creative worker goes too.
        proc = self.deploy(self.payload())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual([c for c in self.creative_calls() if " up " in f" {c} "], [])
        self.assertTrue(any(c.endswith("rm --stop --force creative-worker") for c in self.docker_calls()))
        self.assertIn("creative-worker off", proc.stdout)

    def test_the_switch_in_the_web_section_is_refused(self):
        self.assertRefused(
            self.deploy(self.payload(NIGHTSHIFT_CREATIVE_WORKER="on")),
            "NIGHTSHIFT_CREATIVE_WORKER is not a key in deploy/.env.web.example",
        )

    def test_its_log_hints_name_known_phrases_and_never_the_log_text(self):
        text = f"Traceback (most recent call last): KeyError {self.SECRET} /app/media/x"
        proc = self.deploy(self.worker_payload(NIGHTSHIFT_CREATIVE_WORKER="on"), FAKE_LOG_TEXT=text)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("creative-worker log hints: Traceback", proc.stdout)
        self.assertNotIn("/app/media", proc.stdout)
        self.assertTrue(any("--tail 200 creative-worker" in c for c in self.docker_calls()))

    def test_a_creative_worker_that_fails_to_start_fails_the_deploy(self):
        proc = self.deploy(self.worker_payload(NIGHTSHIFT_CREATIVE_WORKER="on"), FAKE_CREATIVE_UP_RC="1")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("the creative worker did not start", proc.stderr)


# ── The customer notification senders (Telegram, e-mail) ────────────────────


def _example_keys_of(path):
    return [m.group(1) for m in re.finditer(r"^([A-Z][A-Z0-9_]*)=", path.read_text(), re.M)]


def _load_service_builder():
    import importlib.util

    spec = importlib.util.spec_from_file_location("build_service_env", BUILD_SERVICE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# step name -> (switch variable, prefix, example, script argument, the pipeline keys it must never carry)
SENDERS = {
    "Build the notify env": ("NIGHTSHIFT_NOTIFY_WORKER", "NOTIFYENV_", NOTIFY_EXAMPLE, "notify"),
    "Build the e-mail env": ("NIGHTSHIFT_EMAIL_WORKER", "EMAILENV_", EMAIL_EXAMPLE, "email"),
    "Build the marketing env": ("NIGHTSHIFT_MARKETING_WORKER", "MARKETINGENV_", MARKETING_EXAMPLE, "marketing"),
}


class SenderWorkflowTests(unittest.TestCase):
    def test_the_go_live_name_is_a_variable_in_the_web_example_and_mapped(self):
        self.assertIn("TELEGRAM_CUSTOMER_BOT_USERNAME", example_keys())
        self.assertEqual(
            step("payload")["env"]["WEBENV_TELEGRAM_CUSTOMER_BOT_USERNAME"],
            "${{ vars.TELEGRAM_CUSTOMER_BOT_USERNAME }}",
        )
        # Empty in the template: absent = the Notifications panel stays hidden.
        self.assertRegex(ENV_EXAMPLE.read_text(), r"(?m)^TELEGRAM_CUSTOMER_BOT_USERNAME=$")

    def test_the_bot_token_never_reaches_the_dashboards_or_the_pipeline_workers_env(self):
        self.assertNotIn("TELEGRAM_CUSTOMER_BOT_TOKEN", ENV_EXAMPLE.read_text())
        self.assertNotIn("TELEGRAM_CUSTOMER_BOT_TOKEN", WORKER_EXAMPLE.read_text())
        self.assertNotIn("TELEGRAM_CUSTOMER_BOT_TOKEN", yaml.safe_dump(step(name="Build the worker env")))
        self.assertNotIn("RESEND_API_KEY", yaml.safe_dump(step(name="Build the worker env")))

    def test_each_step_maps_exactly_its_example_and_only_named_secrets(self):
        for name, (switch, prefix, example, _arg) in SENDERS.items():
            with self.subTest(name):
                s = step(name=name)
                mapped = {k[len(prefix):]: v for k, v in s["env"].items() if k.startswith(prefix)}
                self.assertEqual(sorted(mapped), sorted(_example_keys_of(example)))
                for key, expr in mapped.items():
                    refs = re.findall(r"(secrets|vars)\.([A-Z][A-Z0-9_]*)", str(expr))
                    self.assertTrue(refs, key)
                    for kind, ref in refs:
                        if kind == "secrets":
                            self.assertNotRegex(ref, r"^(?!SUPABASE_URL$|SUPABASE_SERVICE_KEY$|TELEGRAM_CUSTOMER_BOT_TOKEN$|RESEND_API_KEY$|TELEGRAM_CHANNEL_BOT_TOKEN$)")
                    if CREDENTIAL.search(key):
                        self.assertTrue(str(expr).startswith("${{ secrets."), key)
                self.assertEqual(set(s["env"]) - {f"{prefix}{k}" for k in mapped}, {"PAYLOAD"})
                self.assertNotIn("toJSON", yaml.safe_dump(s))

    def test_runs_only_while_its_switch_is_on_and_default_is_off(self):
        for name, (switch, _prefix, _example, arg) in SENDERS.items():
            with self.subTest(name):
                s = step(name=name)
                self.assertEqual(
                    s["if"], f"steps.payload.outputs.run == 'true' && vars.{switch} == 'on'"
                )
                self.assertEqual(s["run"].strip(), f'python3 deploy/build-service-env.py {arg} "$PAYLOAD"')

    def test_steps_sit_between_the_web_env_and_ssh(self):
        names = [s.get("name") for s in steps()]
        for name in SENDERS:
            self.assertLess(names.index("Build the server env"), names.index(name))
            self.assertLess(names.index(name), names.index("Deploy over SSH"))

    def test_the_origin_defaults_to_the_deployment_domain_and_nothing_else_has_a_fallback(self):
        expr = "${{ vars.NOTIFY_APP_ORIGIN || format('https://{0}', vars.DOMAIN || 'new.nightshift-ai.studio') }}"
        self.assertEqual(step(name="Build the notify env")["env"]["NOTIFYENV_NOTIFY_APP_ORIGIN"], expr)
        self.assertEqual(step(name="Build the e-mail env")["env"]["EMAILENV_APP_ORIGIN"], expr)
        self.assertEqual(step(name="Build the marketing env")["env"]["MARKETINGENV_NOTIFY_APP_ORIGIN"], expr)
        for key in ("NOTIFYENV_TELEGRAM_CUSTOMER_BOT_TOKEN", "NOTIFYENV_SUPABASE_SERVICE_KEY"):
            self.assertNotIn("||", step(name="Build the notify env")["env"][key])

    def test_permissions_and_triggers_are_unchanged(self):
        wf = workflow()
        self.assertEqual(wf["permissions"], {"contents": "read"})
        self.assertNotIn("permissions", wf["jobs"]["deploy"])

    def test_the_examples_name_the_agreed_keys(self):
        self.assertEqual(
            _example_keys_of(NOTIFY_EXAMPLE),
            ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "TELEGRAM_CUSTOMER_BOT_TOKEN", "NOTIFY_APP_ORIGIN"],
        )
        self.assertEqual(
            _example_keys_of(EMAIL_EXAMPLE),
            ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "RESEND_API_KEY", "NIGHTSHIFT_EMAIL_FROM", "APP_ORIGIN"],
        )
        self.assertEqual(
            _example_keys_of(MARKETING_EXAMPLE),
            ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "TELEGRAM_CHANNEL_BOT_TOKEN", "MARKETING_TELEGRAM_CHAT",
             "NOTIFY_APP_ORIGIN", "NIGHTSHIFT_MARKETING_POSTS"],
        )

    def test_the_marketing_credentials_are_secrets_the_rest_are_variables_and_no_other_bot_token_is_mapped(self):
        env = step(name="Build the marketing env")["env"]
        self.assertEqual(env["MARKETINGENV_TELEGRAM_CHANNEL_BOT_TOKEN"], "${{ secrets.TELEGRAM_CHANNEL_BOT_TOKEN }}")
        self.assertEqual(env["MARKETINGENV_SUPABASE_SERVICE_KEY"], "${{ secrets.SUPABASE_SERVICE_KEY }}")
        self.assertEqual(env["MARKETINGENV_MARKETING_TELEGRAM_CHAT"], "${{ vars.MARKETING_TELEGRAM_CHAT }}")
        self.assertEqual(env["MARKETINGENV_NIGHTSHIFT_MARKETING_POSTS"], "${{ vars.NIGHTSHIFT_MARKETING_POSTS }}")
        text = yaml.safe_dump(step(name="Build the marketing env"))
        for other in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CUSTOMER_BOT_TOKEN"):
            self.assertNotIn(other, text)
        # and the channel bot's token is in no other step or example
        for s in steps():
            if s.get("name") != "Build the marketing env":
                self.assertNotIn("TELEGRAM_CHANNEL_BOT_TOKEN", yaml.safe_dump(s), s.get("name"))
        for example in (ENV_EXAMPLE, WORKER_EXAMPLE, NOTIFY_EXAMPLE, EMAIL_EXAMPLE, OPERATOR_EXAMPLE):
            self.assertNotIn("TELEGRAM_CHANNEL_BOT_TOKEN", example.read_text())

    def test_the_marketing_step_needs_no_secret_while_the_switch_is_off(self):
        # Off is the default: the step is skipped, so a deploy never reads a secret that does not exist yet.
        s = step(name="Build the marketing env")
        self.assertEqual(s["if"], "steps.payload.outputs.run == 'true' && vars.NIGHTSHIFT_MARKETING_WORKER == 'on'")
        for other in steps():
            if other.get("name") != "Build the marketing env":
                self.assertNotIn("TELEGRAM_CHANNEL_BOT_TOKEN", yaml.safe_dump(other))
        # The web container carries the page's switch (the SAME repository variable the worker reads, so one switch controls
        # both) and the channel's public @name for the confirm sheet; it never carries the worker's deploy switch or the token.
        dumped = yaml.safe_dump(step("payload"))
        self.assertNotIn("NIGHTSHIFT_MARKETING_WORKER", dumped)
        self.assertNotIn("TELEGRAM_CHANNEL_BOT_TOKEN", dumped)
        pay = step("payload")["env"]
        self.assertEqual(pay["WEBENV_NIGHTSHIFT_MARKETING_POSTS"], "${{ vars.NIGHTSHIFT_MARKETING_POSTS }}")
        self.assertEqual(pay["WEBENV_MARKETING_TELEGRAM_CHAT"], "${{ vars.MARKETING_TELEGRAM_CHAT }}")
        self.assertEqual(pay["WEBENV_NOTIFY_APP_ORIGIN"], "${{ vars.NOTIFY_APP_ORIGIN }}")   # no fallback: empty = APP_ORIGIN

    def test_the_compose_services_use_their_own_env_files_and_profiles(self):
        c = yaml.safe_load((ROOT / "deploy" / "docker-compose.yml").read_text())["services"]
        for svc, profile, var, default in (
            ("notify-worker", "notify", "NOTIFY_ENV_FILE", "/opt/nightshift/.env.notify"),
            ("email-worker", "email", "EMAIL_ENV_FILE", "/opt/nightshift/.env.email"),
            ("marketing-worker", "marketing", "MARKETING_ENV_FILE", "/opt/nightshift/.env.marketing"),
        ):
            self.assertEqual(c[svc]["profiles"], [profile])
            self.assertEqual(c[svc]["env_file"], [{"path": f"${{{var}:-{default}}}", "required": False}])
        self.assertEqual(c["email-worker"]["environment"]["NIGHTSHIFT_EMAIL_TRANSPORT"], "resend")
        for svc in ("web", "worker", "media-worker", "creative-worker"):
            self.assertNotIn(".env.notify", yaml.safe_dump(c[svc]))
            self.assertNotIn(".env.email", yaml.safe_dump(c[svc]))
            self.assertNotIn(".env.marketing", yaml.safe_dump(c[svc]))
        self.assertEqual(c["marketing-worker"]["command"], ["python", "tools/marketing_worker.py"])
        self.assertEqual(c["marketing-worker"]["environment"]["NIGHTSHIFT_WORKER_ID"], "marketing-01")


class BuildServiceEnvTests(unittest.TestCase):
    SECRET = "sender-secret-never-printed"

    def setUp(self):
        self.mod = _load_service_builder()

    def values(self, service, **over):
        _switch, prefix, example, _arg = next(v for v in SENDERS.values() if v[3] == service)
        vals = {
            "SUPABASE_URL": "https://abc.supabase.co",
            "SUPABASE_SERVICE_KEY": self.SECRET,
            "TELEGRAM_CUSTOMER_BOT_TOKEN": "123:abc",
            "NOTIFY_APP_ORIGIN": "https://app.example.com",
            "RESEND_API_KEY": "re_x",
            "NIGHTSHIFT_EMAIL_FROM": "Nightshift <hello@example.com>",
            "APP_ORIGIN": "https://app.example.com",
            "TELEGRAM_CHANNEL_BOT_TOKEN": "456:def",
            "MARKETING_TELEGRAM_CHAT": "@nightshift_test",
            "NIGHTSHIFT_MARKETING_POSTS": "on",
        }
        vals = {k: vals[k] for k in _example_keys_of(example)}
        vals.update(over)
        return {f"{prefix}{k}": v for k, v in vals.items() if v is not None}, example

    def build(self, service, **over):
        env, example = self.values(service, **over)
        prefix = next(v for v in SENDERS.values() if v[3] == service)[1]
        return self.mod.build(env, example.read_text(), prefix, example.name, self.mod.OPTIONAL.get(service, frozenset()))

    def test_one_line_per_key_in_the_examples_order(self):
        for service, example in (("notify", NOTIFY_EXAMPLE), ("email", EMAIL_EXAMPLE), ("marketing", MARKETING_EXAMPLE)):
            lines, errors = self.build(service)
            self.assertEqual(errors, [])
            self.assertEqual([l.split("=", 1)[0] for l in lines], _example_keys_of(example))

    def test_every_key_is_required(self):
        for service, example in (("notify", NOTIFY_EXAMPLE), ("email", EMAIL_EXAMPLE)):
            for key in _example_keys_of(example):
                with self.subTest(service=service, key=key):
                    _, errors = self.build(service, **{key: " "})
                    self.assertIn(f"{key} is required and empty", "\n".join(errors))

    def test_every_marketing_key_but_its_own_switch_is_required(self):
        for key in _example_keys_of(MARKETING_EXAMPLE):
            with self.subTest(key=key):
                _, errors = self.build("marketing", **{key: " "})
                if key == "NIGHTSHIFT_MARKETING_POSTS":
                    self.assertEqual(errors, [], "empty = the worker idles; the deploy must not fail on it")
                else:
                    self.assertIn(f"{key} is required and empty", "\n".join(errors))
        _, errors = self.build("marketing", NIGHTSHIFT_MARKETING_POSTS=None)
        self.assertIn("NIGHTSHIFT_MARKETING_POSTS is in deploy/.env.marketing.example but not mapped", "\n".join(errors))

    def test_the_marketing_chat_is_a_channel_name_or_a_numeric_id(self):
        for good in ("@nightshiftaistudio", "@Test_chan1", "@abcde", "@" + "a" * 32, "-1001234567890", "123456"):
            _, errors = self.build("marketing", MARKETING_TELEGRAM_CHAT=good)
            self.assertEqual(errors, [], good)
        for bad in ("nightshift", "@a", "@abcd", "@" + "a" * 33, "https://t.me/nightshift", "@night shift", "-100abc", "@1abcd"):
            _, errors = self.build("marketing", MARKETING_TELEGRAM_CHAT=bad)
            self.assertIn("MARKETING_TELEGRAM_CHAT must be @channelname", "\n".join(errors), bad)
        _, errors = self.build("marketing", NOTIFY_APP_ORIGIN="http://app.example.com")
        self.assertIn("NOTIFY_APP_ORIGIN must be https://<host>", "\n".join(errors))

    def test_a_marketing_token_problem_is_named_by_key_not_value(self):
        _, errors = self.build("marketing", TELEGRAM_CHANNEL_BOT_TOKEN="1:a$" + self.SECRET)
        text = "\n".join(errors)
        self.assertIn("TELEGRAM_CHANNEL_BOT_TOKEN contains", text)
        self.assertNotIn(self.SECRET, text)

    def test_a_key_the_workflow_forgot_fails(self):
        _, errors = self.build("notify", TELEGRAM_CUSTOMER_BOT_TOKEN=None)
        self.assertIn("TELEGRAM_CUSTOMER_BOT_TOKEN is in deploy/.env.notify.example but not mapped", "\n".join(errors))

    def test_problems_are_named_by_key_never_by_value(self):
        _, errors = self.build("notify", SUPABASE_SERVICE_KEY="a$" + self.SECRET, TELEGRAM_CUSTOMER_BOT_TOKEN="x\n" + self.SECRET)
        text = "\n".join(errors)
        self.assertIn("SUPABASE_SERVICE_KEY contains", text)
        self.assertIn("TELEGRAM_CUSTOMER_BOT_TOKEN contains a line break", text)
        self.assertNotIn(self.SECRET, text)

    def test_the_origin_must_be_a_bare_https_origin(self):
        for bad in ("http://app.example.com", "https://app.example.com/path", "app.example.com", "https://a.example.com?x=1", "https://u@a.example.com"):
            with self.subTest(bad):
                _, errors = self.build("notify", NOTIFY_APP_ORIGIN=bad)
                self.assertIn("NOTIFY_APP_ORIGIN must be https://<host>", "\n".join(errors))
        for good in ("https://app.example.com", "https://app.example.com/", "https://app.example.com:8443"):
            _, errors = self.build("email", APP_ORIGIN=good)
            self.assertEqual(errors, [], good)

    def test_the_sender_may_have_spaces_and_angle_brackets(self):
        lines, errors = self.build("email")
        self.assertEqual(errors, [])
        self.assertIn("NIGHTSHIFT_EMAIL_FROM=Nightshift <hello@example.com>", lines)
        _, errors = self.build("email", NIGHTSHIFT_EMAIL_FROM="Nightshift # <x@y.z>")
        self.assertIn("NIGHTSHIFT_EMAIL_FROM starts with a quote", "\n".join(errors))

    def test_main_appends_the_marker_and_prints_no_value_and_a_refusal_leaves_the_payload_alone(self):
        for service, marker in (("notify", "NIGHTSHIFT_NOTIFY_ENV=on"), ("email", "NIGHTSHIFT_EMAIL_ENV=on"),
                                ("marketing", "NIGHTSHIFT_MARKETING_ENV=on")):
            with self.subTest(service):
                tmp = Path(tempfile.mkdtemp())
                self.addCleanup(shutil.rmtree, tmp, True)
                payload = tmp / "payload"
                payload.write_text("NIGHTSHIFT_DEPLOY_SHA=" + "a" * 40 + "\nDOMAIN=x\n")
                env, _ = self.values(service)
                env["PATH"] = os.environ["PATH"]
                run = lambda: subprocess.run(
                    [sys.executable, str(BUILD_SERVICE), service, str(payload)], env=env, capture_output=True, text=True, timeout=30
                )
                proc = run()
                self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
                lines = payload.read_text().splitlines()
                self.assertEqual(lines[2], marker)
                self.assertIn(f"SUPABASE_SERVICE_KEY={self.SECRET}", lines)
                self.assertNotIn(self.SECRET, proc.stdout + proc.stderr)
                before = payload.read_text()
                env[next(k for k in env if k.endswith("SUPABASE_SERVICE_KEY"))] = ""
                proc = run()
                self.assertNotEqual(proc.returncode, 0)
                self.assertEqual(payload.read_text(), before)

    def test_the_script_takes_a_known_service_only(self):
        proc = subprocess.run([sys.executable, str(BUILD_SERVICE), "worker", "/nonexistent"], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 2)


@unittest.skipUnless(shutil.which("bash") and shutil.which("git") and shutil.which("flock"), "bash, git, flock needed")
class RemoteDeploySendersTests(_RemoteDeployFixture):
    """The notify and e-mail sections of the payload, on the same fixture."""

    def section(self, marker, example, **values):
        vals = {k: "" for k in _example_keys_of(example)}
        vals.update(
            SUPABASE_URL="https://abc.supabase.co",
            SUPABASE_SERVICE_KEY=self.SECRET,
            TELEGRAM_CUSTOMER_BOT_TOKEN="123:tok",
            NOTIFY_APP_ORIGIN="https://app.example.com",
            RESEND_API_KEY="re_key",
            NIGHTSHIFT_EMAIL_FROM="Nightshift <hello@example.com>",
            APP_ORIGIN="https://app.example.com",
            TELEGRAM_CHANNEL_BOT_TOKEN="456:chan",
            MARKETING_TELEGRAM_CHAT="@nightshift_test",
            NIGHTSHIFT_MARKETING_POSTS="on",
        )
        vals = {k: vals[k] for k in _example_keys_of(example)}
        vals.update(values)
        return "\n".join([marker] + [f"{k}={v}" for k, v in vals.items() if v is not None]) + "\n"

    def notify_section(self, **values):
        return self.section("NIGHTSHIFT_NOTIFY_ENV=on", NOTIFY_EXAMPLE, **values)

    def email_section(self, **values):
        return self.section("NIGHTSHIFT_EMAIL_ENV=on", EMAIL_EXAMPLE, **values)

    def marketing_section(self, **values):
        return self.section("NIGHTSHIFT_MARKETING_ENV=on", MARKETING_EXAMPLE, **values)

    def up_calls(self, svc):
        return [c for c in self.docker_calls() if c.endswith(f"up -d --build --no-deps {svc}")]

    def test_the_switch_off_changes_nothing_but_removing_what_is_not_there(self):
        proc = self.deploy(self.payload())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.up_calls("notify-worker") + self.up_calls("email-worker"), [])
        self.assertFalse(self.notify_env_file.exists())
        self.assertFalse(self.email_env_file.exists())
        calls = self.docker_calls()
        self.assertTrue(any(c.endswith("rm --stop --force notify-worker") for c in calls))
        self.assertTrue(any(c.endswith("rm --stop --force email-worker") for c in calls))
        self.assertIn("notify-worker is off", proc.stdout)
        self.assertIn("notify-worker off; email-worker off", proc.stdout)
        # Nothing about the web or worker deploy moved.
        self.assertTrue(any(c.endswith("up -d --build --remove-orphans web caddy") for c in calls))

    def test_notify_on_writes_its_own_600_file_with_exactly_four_names_and_starts_after_web(self):
        proc = self.deploy(self.payload() + self.notify_section())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(stat.S_IMODE(self.notify_env_file.stat().st_mode), 0o600)
        text = self.notify_env_file.read_text()
        names = [l.split("=", 1)[0] for l in text.splitlines() if l and not l.startswith("#")]
        self.assertEqual(names, ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "TELEGRAM_CUSTOMER_BOT_TOKEN", "NOTIFY_APP_ORIGIN"])
        self.assertIn("TELEGRAM_CUSTOMER_BOT_TOKEN=123:tok\n", text)
        # Nobody else's file got it, and the marker is not a value anywhere.
        for other in (self.env_file, self.worker_env_file, self.email_env_file):
            self.assertFalse(other.exists() and "TELEGRAM_CUSTOMER_BOT_TOKEN" in other.read_text())
        self.assertNotIn("NIGHTSHIFT_NOTIFY_ENV", self.env_file.read_text())
        self.assertNotIn("SUPABASE_SERVICE_KEY", self.env_file.read_text())
        calls = self.docker_calls()
        web_up = [i for i, c in enumerate(calls) if c.endswith("up -d --build --remove-orphans web caddy")]
        notify_up = [i for i, c in enumerate(calls) if c.endswith("up -d --build --no-deps notify-worker")]
        self.assertEqual(len(web_up), 1)
        self.assertEqual(len(notify_up), 1)
        self.assertLess(web_up[0], notify_up[0])
        self.assertTrue(all("--profile notify" in c and "--profile email" in c for c in calls if " up " in f" {c} "))
        self.assertTrue(any(c.startswith("inspect -f notify-worker after 0s:") for c in calls))
        self.assertIn("notify-worker log hints:", proc.stdout)
        self.assertIn("notify-worker on; email-worker off", proc.stdout)
        self.assertEqual(self.up_calls("email-worker"), [])
        self.assertEqual(self.up_calls("worker"), [], "the pipeline worker must stay off")

    def test_email_on_writes_its_own_600_file_with_exactly_five_names(self):
        proc = self.deploy(self.payload() + self.email_section())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(stat.S_IMODE(self.email_env_file.stat().st_mode), 0o600)
        names = [l.split("=", 1)[0] for l in self.email_env_file.read_text().splitlines() if l and not l.startswith("#")]
        self.assertEqual(names, ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "RESEND_API_KEY", "NIGHTSHIFT_EMAIL_FROM", "APP_ORIGIN"])
        self.assertFalse(self.notify_env_file.exists())
        self.assertEqual(len(self.up_calls("email-worker")), 1)
        self.assertEqual(self.up_calls("notify-worker"), [])
        self.assertIn("notify-worker off; email-worker on", proc.stdout)

    def test_sections_are_independent_of_the_pipeline_worker_and_of_their_order(self):
        worker = "NIGHTSHIFT_WORKER_ENV=on\n" + "\n".join(
            f"{k}={self.SECRET if k == 'SUPABASE_SERVICE_KEY' else ('https://abc.supabase.co' if k == 'SUPABASE_URL' else '')}"
            for k in worker_example_keys()
        ) + "\n"
        for payload in (
            self.payload() + worker + self.notify_section() + self.email_section(),
            self.payload() + self.email_section() + self.notify_section() + worker,
        ):
            proc = self.deploy(payload)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("notify-worker on; email-worker on", proc.stdout)
            self.assertNotIn("TELEGRAM_CUSTOMER_BOT_TOKEN", self.worker_env_file.read_text())
            self.assertNotIn("GEMINI_API_KEY", self.notify_env_file.read_text())
            self.assertNotIn("GEMINI_API_KEY", self.email_env_file.read_text())
            self.assertNotIn("RESEND_API_KEY", self.worker_env_file.read_text())

    def test_switching_off_removes_the_container_and_the_file_with_the_token(self):
        self.assertEqual(self.deploy(self.payload() + self.notify_section()).returncode, 0)
        self.assertTrue(self.notify_env_file.exists())
        self.assertTrue(Path(str(self.notify_env_file)).exists())
        self.assertEqual(self.deploy(self.payload() + self.notify_section()).returncode, 0)
        self.assertTrue(Path(str(self.notify_env_file) + ".prev").exists())
        proc = self.deploy(self.payload())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(self.notify_env_file.exists())
        self.assertFalse(Path(str(self.notify_env_file) + ".prev").exists())
        self.assertTrue(any(c.endswith("rm --stop --force notify-worker") for c in self.docker_calls()))

    def test_a_key_the_sender_does_not_read_is_refused_without_changing_anything(self):
        proc = self.deploy(self.payload() + self.notify_section(GEMINI_API_KEY=self.SECRET))
        self.assertRefused(proc, "GEMINI_API_KEY is not a key in deploy/.env.notify.example")
        self.assertFalse(self.notify_env_file.exists())
        proc = self.deploy(self.payload() + self.email_section(TELEGRAM_CUSTOMER_BOT_TOKEN=self.SECRET))
        self.assertRefused(proc, "TELEGRAM_CUSTOMER_BOT_TOKEN is not a key in deploy/.env.email.example")

    def test_missing_empty_or_repeated_values_are_refused(self):
        self.assertRefused(
            self.deploy(self.payload() + self.notify_section(TELEGRAM_CUSTOMER_BOT_TOKEN="")),
            "TELEGRAM_CUSTOMER_BOT_TOKEN is required and empty",
        )
        self.assertRefused(
            self.deploy(self.payload() + self.notify_section(NOTIFY_APP_ORIGIN=None)),
            "NOTIFY_APP_ORIGIN is missing",
        )
        self.assertRefused(self.deploy(self.payload() + self.email_section(RESEND_API_KEY="a$b")), "RESEND_API_KEY contains")
        self.assertRefused(
            self.deploy(self.payload() + self.notify_section() + "NIGHTSHIFT_NOTIFY_ENV=on\n"),
            "NIGHTSHIFT_NOTIFY_ENV is not a key in deploy/.env.notify.example",
        )

    def test_only_the_exact_markers_open_a_section(self):
        # `=off`, or a marker typed into the web lines with another value, is just an unknown web key.
        self.assertRefused(
            self.deploy(self.payload(NIGHTSHIFT_NOTIFY_ENV="off")), "NIGHTSHIFT_NOTIFY_ENV is not a key in deploy/.env.web.example"
        )
        self.assertRefused(
            self.deploy(self.payload(NIGHTSHIFT_EMAIL_ENV="1")), "NIGHTSHIFT_EMAIL_ENV is not a key in deploy/.env.web.example"
        )

    def test_a_sender_that_fails_to_start_fails_the_deploy_after_web(self):
        proc = self.deploy(self.payload() + self.notify_section(), FAKE_NOTIFY_UP_RC="1")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("the notify worker did not start", proc.stderr)
        proc = self.deploy(self.payload() + self.email_section(), FAKE_EMAIL_UP_RC="1")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("the e-mail worker did not start", proc.stderr)

    def test_log_hints_name_known_phrases_and_never_the_log_text(self):
        text = f"2026 notify ERROR Traceback token={self.SECRET}"
        proc = self.deploy(self.payload() + self.notify_section(), FAKE_LOG_TEXT=text)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("notify-worker log hints: Traceback", proc.stdout)
        self.assertNotIn(self.SECRET, proc.stdout + proc.stderr)


# ── The operator bot as a service (NIGHTSHIFT_OPERATOR_BOT) ────────────────────

OPERATOR_STEP = "Build the operator-bot env"
OPERATOR_REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]
OPERATOR_OPTIONAL = [
    "TELEGRAM_ADMIN_USER_IDS", "GITHUB_TOKEN", "GITHUB_REPOSITORY", "ELEVENLABS_LOW_CREDITS",
    "OPERATOR_APP_URL", "OPERATOR_LANGUAGE", "OPERATOR_TZ", "OPERATOR_QUIET_HOURS",
    "OPERATOR_DIGEST_HOUR", "OPERATOR_STUCK_MINUTES", "OPERATOR_ALERT_MAX_PER_HOUR", "OPERATOR_DEADMAN_HOURS",
    # The owner's e-mail copy (docs/OWNER_EMAIL.md): off unless NIGHTSHIFT_OWNER_EMAIL is exactly `on`.
    "NIGHTSHIFT_OWNER_EMAIL", "OWNER_EMAIL_KINDS", "RESEND_API_KEY", "NIGHTSHIFT_EMAIL_FROM",
]
# Everything the pipeline worker holds that the operator bot must never see.
PIPELINE_KEYS = (
    "GEMINI_API_KEY", "PEXELS_API_KEY", "ELEVENLABS_API_KEY", "YOUTUBE_TOKEN_JSON", "YOUTUBE_CLIENT_SECRET_JSON",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TIKTOK_CLIENT_SECRET", "GOOGLE_OAUTH_CLIENT_SECRET", "DEPLOY_SSH_KEY",
    "DEPLOY_KNOWN_HOSTS", "GH_SECRETS_TOKEN", "RESEND_API_KEY", "TELEGRAM_CUSTOMER_BOT_TOKEN", "PADDLE_API_KEY",
)


class OperatorWorkflowTests(unittest.TestCase):
    def test_the_example_names_the_agreed_keys_in_order(self):
        self.assertEqual(_example_keys_of(OPERATOR_EXAMPLE), OPERATOR_REQUIRED + OPERATOR_OPTIONAL)

    def test_the_step_maps_exactly_the_example_from_the_names_the_workflows_already_use(self):
        s = step(name=OPERATOR_STEP)
        prefix = "OPERATORENV_"
        mapped = {k[len(prefix):]: v for k, v in s["env"].items() if k.startswith(prefix)}
        self.assertEqual(sorted(mapped), sorted(_example_keys_of(OPERATOR_EXAMPLE)))
        self.assertEqual(set(s["env"]) - {prefix + k for k in mapped}, {"PAYLOAD"})
        expected = {
            "SUPABASE_URL": "secrets.SUPABASE_URL",
            "SUPABASE_SERVICE_KEY": "secrets.SUPABASE_SERVICE_KEY",
            "TELEGRAM_BOT_TOKEN": "secrets.TELEGRAM_BOT_TOKEN",
            "TELEGRAM_CHAT_ID": "secrets.TELEGRAM_CHAT_ID",
            "TELEGRAM_ADMIN_USER_IDS": "secrets.TELEGRAM_ADMIN_USER_IDS",
            # GitHub reserves the GITHUB_ prefix for secret names: renamed, like GH_SECRETS_TOKEN.
            "GITHUB_TOKEN": "secrets.OPERATOR_GITHUB_TOKEN",
            "GITHUB_REPOSITORY": "github.repository",
            "ELEVENLABS_LOW_CREDITS": "vars.ELEVENLABS_LOW_CREDITS",
            # The owner e-mail's OWN restricted Resend key, mapped only while its switch is exactly `on`.
            "RESEND_API_KEY": "vars.NIGHTSHIFT_OWNER_EMAIL == 'on' && secrets.OPERATOR_RESEND_API_KEY || ''",
        }
        for key in OPERATOR_OPTIONAL:
            expected.setdefault(key, f"vars.{key}")
        for key, expr in mapped.items():
            self.assertEqual(str(expr), "${{ " + expected[key] + " }}", key)
        # The variables are the very ones telegram_control.yml / operator_alerts.yml read.
        for path in (TELEGRAM_WORKFLOW, ALERTS_WORKFLOW):
            text = path.read_text()
            for key in OPERATOR_OPTIONAL + OPERATOR_REQUIRED:
                if expected[key].startswith(("vars.OPERATOR_", "vars.ELEVENLABS", "secrets.SUPABASE", "secrets.TELEGRAM_BOT", "secrets.TELEGRAM_CHAT")):
                    self.assertIn("${{ " + expected[key] + " }}", text, f"{path.name} does not use {expected[key]}")

    def test_credentials_are_secrets_and_nothing_of_the_pipeline_is_mapped(self):
        s = step(name=OPERATOR_STEP)
        dump = yaml.safe_dump(s)
        for key in _example_keys_of(OPERATOR_EXAMPLE):
            if CREDENTIAL.search(key):
                value = str(s["env"]["OPERATORENV_" + key])
                gated = key == "RESEND_API_KEY"      # a secret behind its feature switch, see the owner e-mail test
                self.assertTrue(value.startswith("${{ secrets.") or (gated and "secrets.OPERATOR_RESEND_API_KEY" in value), key)
        # RESEND_API_KEY is the ONE name of that list the operator bot now holds, and only for the owner's e-mail
        # copy (docs/OWNER_EMAIL.md); the line is the allow-list, so nothing else may follow it in here.
        for name in PIPELINE_KEYS:
            if name == "RESEND_API_KEY":
                self.assertNotIn("secrets.RESEND_API_KEY", dump)       # the customer worker's secret is not reused
                continue
            self.assertNotIn(name, dump)
            self.assertNotRegex(OPERATOR_EXAMPLE.read_text(), rf"(?m)^{name}=")
        self.assertNotIn("toJSON", dump)
        self.assertNotIn("github.token", dump)
        # the dashboard and the pipeline worker never get the bot token
        self.assertNotIn("TELEGRAM_BOT_TOKEN", ENV_EXAMPLE.read_text())
        self.assertNotIn("TELEGRAM_BOT_TOKEN", WORKER_EXAMPLE.read_text())
        self.assertNotIn("TELEGRAM_BOT_TOKEN", yaml.safe_dump(step(name="Build the worker env")))
        self.assertNotIn("TELEGRAM_BOT_TOKEN", yaml.safe_dump(step("payload")))
        self.assertNotIn("TELEGRAM_BOT_TOKEN", yaml.safe_dump(step(name="Build the notify env")))

    GATED_KEY = "${{ vars.NIGHTSHIFT_OWNER_EMAIL == 'on' && secrets.OPERATOR_RESEND_API_KEY || '' }}"

    def test_the_owner_email_switch_is_a_variable_its_key_its_own_secret_behind_the_switch(self):
        env = step(name=OPERATOR_STEP)["env"]
        self.assertEqual(env["OPERATORENV_NIGHTSHIFT_OWNER_EMAIL"], "${{ vars.NIGHTSHIFT_OWNER_EMAIL }}")
        self.assertEqual(env["OPERATORENV_OWNER_EMAIL_KINDS"], "${{ vars.OWNER_EMAIL_KINDS }}")
        self.assertEqual(env["OPERATORENV_NIGHTSHIFT_EMAIL_FROM"], "${{ vars.NIGHTSHIFT_EMAIL_FROM }}")
        # the key: a dedicated secret, evaluated against the switch, exactly `on`; never the customer worker's secret
        self.assertEqual(env["OPERATORENV_RESEND_API_KEY"], self.GATED_KEY)
        self.assertIn("vars.NIGHTSHIFT_OWNER_EMAIL == 'on'", env["OPERATORENV_RESEND_API_KEY"])
        self.assertNotIn("secrets.RESEND_API_KEY", yaml.safe_dump(step(name=OPERATOR_STEP)))
        # the fallback workflow (the bot's service is off) maps the very same names, the key behind the same switch
        alerts = yaml.safe_load(ALERTS_WORKFLOW.read_text())["jobs"]["alerts"]["steps"]
        wf_env = next(st["env"] for st in alerts if st.get("name") == "Operator alerts")
        for name, expr in (("NIGHTSHIFT_OWNER_EMAIL", "${{ vars.NIGHTSHIFT_OWNER_EMAIL }}"), ("OWNER_EMAIL_KINDS", "${{ vars.OWNER_EMAIL_KINDS }}"),
                           ("NIGHTSHIFT_EMAIL_FROM", "${{ vars.NIGHTSHIFT_EMAIL_FROM }}"), ("RESEND_API_KEY", self.GATED_KEY)):
            self.assertEqual(wf_env[name], expr, name)
        self.assertNotIn("secrets.RESEND_API_KEY", ALERTS_WORKFLOW.read_text())
        # the switch and the dedicated secret exist nowhere in the web, worker, notify, e-mail or marketing environments
        for other in ("payload", "Build the worker env", "Build the notify env", "Build the e-mail env", "Build the marketing env"):
            dumped = yaml.safe_dump(step(other) if other == "payload" else step(name=other))
            for name in ("NIGHTSHIFT_OWNER_EMAIL", "OWNER_EMAIL_KINDS", "OPERATOR_RESEND_API_KEY"):
                self.assertNotIn(name, dumped, (other, name))
        # all four may be empty: the default deploy (nothing set) builds the same env as before, with the switch off
        for key in ("NIGHTSHIFT_OWNER_EMAIL", "OWNER_EMAIL_KINDS", "RESEND_API_KEY", "NIGHTSHIFT_EMAIL_FROM"):
            self.assertIn(key, OPERATOR_OPTIONAL)
            self.assertRegex(OPERATOR_EXAMPLE.read_text(), rf"(?m)^{key}=$")

    def test_runs_only_while_the_switch_is_on_and_sits_between_the_web_env_and_ssh(self):
        s = step(name=OPERATOR_STEP)
        self.assertEqual(s["if"], "steps.payload.outputs.run == 'true' && vars.NIGHTSHIFT_OPERATOR_BOT == 'on'")
        self.assertEqual(s["run"].strip(), 'python3 deploy/build-service-env.py operator "$PAYLOAD"')
        names = [x.get("name") for x in steps()]
        self.assertLess(names.index("Build the server env"), names.index(OPERATOR_STEP))
        self.assertLess(names.index(OPERATOR_STEP), names.index("Deploy over SSH"))
        # the only place the switch is read in this workflow
        self.assertEqual(yaml.safe_dump(workflow()).count("NIGHTSHIFT_OPERATOR_BOT"), 1)

    def test_secrets_are_only_ever_expressions_and_never_in_a_script_or_a_command_line(self):
        for x in steps():
            if "run" in x:
                self.assertNotIn("${{", x["run"], x.get("name"))
                self.assertNotRegex(x["run"], r"(?m)^\s*set\s+-\w*x", x.get("name"))
        self.assertNotRegex(REMOTE.read_text(), r"(?m)^\s*set\s+-\w*x")
        self.assertNotRegex(BUILD_SERVICE.read_text(), r"\bargv\[[^\]]*\]\s*\+\s*key|subprocess|os\.system")

    def test_permissions_triggers_and_actions_are_unchanged(self):
        wf = workflow()
        self.assertEqual(wf["permissions"], {"contents": "read"})
        self.assertEqual(wf[True]["push"]["branches"], ["main"])
        self.assertNotIn("pull_request", wf[True])
        uses = [x["uses"] for x in steps() if "uses" in x]
        self.assertEqual(uses, ["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"])

    def test_both_operator_workflows_skip_while_the_switch_is_on_and_are_otherwise_as_before(self):
        for path, job in ((TELEGRAM_WORKFLOW, "poll"), (ALERTS_WORKFLOW, "alerts")):
            with self.subTest(path.name):
                doc = yaml.safe_load(path.read_text())
                # job level, so no step (and no Telegram call) runs at all
                self.assertEqual(doc["jobs"][job]["if"], "vars.NIGHTSHIFT_OPERATOR_BOT != 'on'")
                self.assertEqual(list(doc["jobs"]), [job])
                # the default (variable unset or off) leaves the schedule and permissions exactly as they were
                self.assertEqual(doc["permissions"], {"contents": "read", "actions": "read"})
                self.assertFalse(doc["concurrency"]["cancel-in-progress"])
                self.assertEqual(list(doc[True]), ["schedule", "workflow_dispatch"])
                self.assertEqual(doc[True]["schedule"], [{"cron": "*/5 * * * *"} if job == "poll" else {"cron": "*/10 * * * *"}])
                # the condition is on the job only: no step carries its own, and nothing else changed
                for st in doc["jobs"][job]["steps"]:
                    self.assertNotIn("NIGHTSHIFT_OPERATOR_BOT", str(st.get("if", "")))

    def test_the_condition_is_the_exact_inverse_of_the_deploy_switch(self):
        # Anything but exactly `on` (unset, off, On, a typo) keeps the workflows running, and the
        # deploy treats the same values as off: there is no value for which neither or both run.
        deploy_if = step(name=OPERATOR_STEP)["if"]
        self.assertIn("vars.NIGHTSHIFT_OPERATOR_BOT == 'on'", deploy_if)
        for path in (TELEGRAM_WORKFLOW, ALERTS_WORKFLOW):
            self.assertIn("vars.NIGHTSHIFT_OPERATOR_BOT != 'on'", path.read_text())

    def test_the_compose_service_is_hardened_like_the_notify_worker_and_unreachable(self):
        c = yaml.safe_load((ROOT / "deploy" / "docker-compose.yml").read_text())["services"]
        bot, notify = c["operator-bot"], c["notify-worker"]
        self.assertEqual(bot["profiles"], ["operator"])
        self.assertEqual(bot["env_file"], [{"path": "${OPERATOR_ENV_FILE:-/opt/nightshift/.env.operator}", "required": False}])
        self.assertEqual(bot["command"], ["python", "tools/operator_bot_service.py"])
        for key in ("user", "cap_drop", "security_opt", "restart", "init", "tmpfs", "logging", "image"):
            self.assertEqual(bot[key], notify[key], key)
        self.assertEqual(bot["user"], "1000:1000")
        for forbidden in ("ports", "expose", "volumes", "network_mode", "privileged", "cap_add", "devices", "pid", "ipc", "depends_on"):
            self.assertNotIn(forbidden, bot, forbidden)
        self.assertNotIn("docker.sock", yaml.safe_dump(bot))
        self.assertNotIn("/opt/nightshift/.env.web", yaml.safe_dump(bot))
        self.assertNotIn("operator", (ROOT / "deploy" / "Caddyfile").read_text().lower())
        # nobody else reads its file
        for svc in ("web", "caddy", "worker", "media-worker", "creative-worker", "notify-worker", "email-worker"):
            self.assertNotIn(".env.operator", yaml.safe_dump(c[svc]))

    def test_the_webhook_server_is_not_started_by_the_deploy(self):
        for text in ((ROOT / "deploy" / "docker-compose.yml").read_text(), REMOTE.read_text(),
                     WORKFLOW.read_text()):
            self.assertNotIn("operator_bot_server", text)


class BuildOperatorEnvTests(unittest.TestCase):
    SECRET = "operator-secret-never-printed"

    def setUp(self):
        self.mod = _load_service_builder()

    def env(self, **over):
        vals = {k: "" for k in _example_keys_of(OPERATOR_EXAMPLE)}
        vals.update(SUPABASE_URL="https://abc.supabase.co", SUPABASE_SERVICE_KEY=self.SECRET,
                    TELEGRAM_BOT_TOKEN="123456:ABC-def_ghi", TELEGRAM_CHAT_ID="-1001234567890")
        vals.update(over)
        return {f"OPERATORENV_{k}": v for k, v in vals.items() if v is not None}

    def build(self, **over):
        return self.mod.build(self.env(**over), OPERATOR_EXAMPLE.read_text(), "OPERATORENV_", OPERATOR_EXAMPLE.name,
                              self.mod.OPTIONAL["operator"], self.mod.GATED["operator"])

    def test_the_optional_set_is_exactly_the_documented_one(self):
        self.assertEqual(sorted(self.mod.OPTIONAL["operator"]), sorted(OPERATOR_OPTIONAL))
        self.assertEqual(sorted(set(_example_keys_of(OPERATOR_EXAMPLE)) - self.mod.OPTIONAL["operator"]), sorted(OPERATOR_REQUIRED))
        self.assertNotIn("notify", self.mod.OPTIONAL)
        self.assertNotIn("email", self.mod.OPTIONAL)

    def test_only_the_required_four_are_needed_and_optional_ones_are_written_empty(self):
        lines, errors = self.build()
        self.assertEqual(errors, [])
        self.assertEqual([l.split("=", 1)[0] for l in lines], _example_keys_of(OPERATOR_EXAMPLE))
        self.assertIn("GITHUB_TOKEN=", lines)
        self.assertIn("TELEGRAM_CHAT_ID=-1001234567890", lines)

    def test_the_mail_key_is_written_empty_unless_the_switch_is_exactly_on_whatever_the_workflow_mapped(self):
        fake = "re_fake_key_must_not_appear_0123456789"
        for switch in ("", "off", "ON", "true", " on x"):
            with self.subTest(switch=switch):
                lines, errors = self.build(RESEND_API_KEY=fake, NIGHTSHIFT_OWNER_EMAIL=switch)
                self.assertEqual(errors, [])
                self.assertIn("RESEND_API_KEY=", lines)
                self.assertNotIn(fake, "\n".join(lines))
        lines, errors = self.build(RESEND_API_KEY=fake, NIGHTSHIFT_OWNER_EMAIL="on")
        self.assertEqual(errors, [])
        self.assertIn(f"RESEND_API_KEY={fake}", lines)

    def test_the_command_line_tool_never_writes_the_mail_key_with_the_switch_empty(self):
        import subprocess, tempfile
        fake = "re_fake_key_must_not_appear_0123456789"
        for switch, expect in (("", False), ("on", True)):
            with self.subTest(switch=switch), tempfile.TemporaryDirectory() as tmp:
                payload = Path(tmp) / "payload"
                env = {k: v for k, v in os.environ.items() if not k.startswith("OPERATORENV_")}
                env.update(self.env(RESEND_API_KEY=fake, NIGHTSHIFT_OWNER_EMAIL=switch))
                proc = subprocess.run([sys.executable, str(ROOT / "deploy" / "build-service-env.py"), "operator", str(payload)],
                                      env=env, capture_output=True, text=True)
                self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
                self.assertEqual(fake in payload.read_text(), expect)
                self.assertNotIn(fake, proc.stdout + proc.stderr)

    def test_each_required_key_empty_fails_by_name(self):
        for key in OPERATOR_REQUIRED:
            with self.subTest(key):
                _, errors = self.build(**{key: "  "})
                self.assertIn(f"{key} is required and empty", "\n".join(errors))

    def test_a_missing_mapping_fails_even_for_an_optional_key(self):
        for key in ("GITHUB_TOKEN", "OPERATOR_TZ", "SUPABASE_URL"):
            _, errors = self.build(**{key: None})
            self.assertIn(f"{key} is in deploy/.env.operator.example but not mapped", "\n".join(errors))

    def test_adversarial_values_are_refused_by_name_never_echoed_for_every_key(self):
        bad = {
            "dollar": "ab$(touch /tmp/x)" , "expansion": "${SUPABASE_SERVICE_KEY}", "newline": "a\nINJECTED=1",
            "quote": "'quoted'", "dquote": '"quoted"', "backtick": "`id`", "comment": "value # tail",
        }
        for key in _example_keys_of(OPERATOR_EXAMPLE):
            for label, raw in bad.items():
                with self.subTest(key=key, case=label):
                    value = raw + self.SECRET
                    lines, errors = self.build(**{key: value})
                    text = "\n".join(errors)
                    self.assertIn(key, text)
                    self.assertNotIn(self.SECRET, text)
                    self.assertNotIn("INJECTED", text)

    def test_an_embedded_tab_or_control_character_is_refused_before_ssh(self):
        for key in _example_keys_of(OPERATOR_EXAMPLE):
            for ch in ("\t", "\x1b", "\x00", "\x7f"):
                with self.subTest(key=key, ch=repr(ch)):
                    _, errors = self.build(**{key: "ab" + ch + "cd" + self.SECRET})
                    text = "\n".join(errors)
                    self.assertIn(f"{key} contains a control character", text)
                    self.assertNotIn(self.SECRET, text)
        # a tab at the edge is trimmed like other whitespace, as before
        lines, errors = self.build(OPERATOR_TZ="\tUTC\t")
        self.assertEqual(errors, [])
        self.assertIn("OPERATOR_TZ=UTC", lines)

    def test_a_trailing_carriage_return_or_space_is_trimmed_not_written(self):
        lines, errors = self.build(TELEGRAM_BOT_TOKEN="123:abc \r", OPERATOR_TZ="Asia/Tashkent\r")
        self.assertEqual(errors, [])
        self.assertIn("TELEGRAM_BOT_TOKEN=123:abc", lines)
        self.assertIn("OPERATOR_TZ=Asia/Tashkent", lines)
        self.assertFalse(any("\r" in l or "\n" in l for l in lines))

    def test_ordinary_settings_pass(self):
        lines, errors = self.build(OPERATOR_QUIET_HOURS="23-7", OPERATOR_APP_URL="https://nightshift-ai.studio",
                                   OPERATOR_LANGUAGE="uz", OPERATOR_DIGEST_HOUR="9", TELEGRAM_ADMIN_USER_IDS="1,2",
                                   GITHUB_TOKEN="github_pat_11AAAA_bbbb", GITHUB_REPOSITORY="owner/repo",
                                   ELEVENLABS_LOW_CREDITS="15000")
        self.assertEqual(errors, [])

    def test_main_appends_the_marker_prints_no_value_and_a_refusal_leaves_the_payload_alone(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        payload = tmp / "payload"
        payload.write_text("NIGHTSHIFT_DEPLOY_SHA=" + "a" * 40 + "\nDOMAIN=x\n")
        env = self.env(GITHUB_TOKEN="gh-" + self.SECRET)
        env["PATH"] = os.environ["PATH"]
        run = lambda: subprocess.run(
            [sys.executable, str(BUILD_SERVICE), "operator", str(payload)], env=env, capture_output=True, text=True, timeout=30
        )
        proc = run()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        lines = payload.read_text().splitlines()
        self.assertEqual(lines[2], "NIGHTSHIFT_OPERATOR_ENV=on")
        self.assertIn(f"SUPABASE_SERVICE_KEY={self.SECRET}", lines)
        self.assertNotIn(self.SECRET, proc.stdout + proc.stderr)
        before = payload.read_text()
        env["OPERATORENV_TELEGRAM_BOT_TOKEN"] = ""      # a switch `on` with a missing secret: fails before SSH
        proc = run()
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("TELEGRAM_BOT_TOKEN is required and empty", proc.stdout)
        self.assertNotIn(self.SECRET, proc.stdout + proc.stderr)
        self.assertIn("NIGHTSHIFT_OPERATOR_BOT", proc.stdout)
        self.assertEqual(payload.read_text(), before)

    def test_the_other_services_still_require_every_key(self):
        env = {"NOTIFYENV_" + k: "x" for k in _example_keys_of(NOTIFY_EXAMPLE)}
        env["NOTIFYENV_NOTIFY_APP_ORIGIN"] = "https://app.example.com"
        env["NOTIFYENV_TELEGRAM_CUSTOMER_BOT_TOKEN"] = ""
        _, errors = self.mod.build(env, NOTIFY_EXAMPLE.read_text(), "NOTIFYENV_", NOTIFY_EXAMPLE.name)
        self.assertIn("TELEGRAM_CUSTOMER_BOT_TOKEN is required and empty", "\n".join(errors))


@unittest.skipUnless(shutil.which("bash") and shutil.which("git") and shutil.which("flock"), "bash, git, flock needed")
class RemoteDeployOperatorTests(_RemoteDeployFixture):
    """The operator-bot section of the payload, on the same fixture."""

    def section(self, drop=(), **values):
        vals = {k: "" for k in _example_keys_of(OPERATOR_EXAMPLE)}
        vals.update(SUPABASE_URL="https://abc.supabase.co", SUPABASE_SERVICE_KEY=self.SECRET,
                    TELEGRAM_BOT_TOKEN="123:tok", TELEGRAM_CHAT_ID="-100123")
        vals.update(values)
        return "\n".join(["NIGHTSHIFT_OPERATOR_ENV=on"] + [f"{k}={v}" for k, v in vals.items() if k not in drop]) + "\n"

    def up_calls(self, svc="operator-bot"):
        return [c for c in self.docker_calls() if c.endswith(f"up -d --build --no-deps {svc}")]

    def test_the_switch_off_changes_nothing_but_removing_what_is_not_there(self):
        proc = self.deploy(self.payload())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.up_calls(), [])
        self.assertFalse(self.operator_env_file.exists())
        calls = self.docker_calls()
        self.assertTrue(any(c.endswith("rm --stop --force operator-bot") for c in calls))
        self.assertIn("operator-bot is off", proc.stdout)
        self.assertIn("operator-bot off", proc.stdout)
        # the rest of the deploy is what it was: web and caddy up, no other service started
        self.assertTrue(any(c.endswith("up -d --build --remove-orphans web caddy") for c in calls))
        ups = [c for c in calls if " up " in f" {c} "]
        self.assertEqual(len(ups), 1, ups)

    def test_a_stray_service_and_env_file_are_removed_when_the_switch_is_off(self):
        self.operator_env_file.write_text("TELEGRAM_BOT_TOKEN=left-behind\n")
        Path(str(self.operator_env_file) + ".prev").write_text("TELEGRAM_BOT_TOKEN=older\n")
        other = self.tmp / "other-file"
        other.write_text("keep")
        proc = self.deploy(self.payload())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(self.operator_env_file.exists())
        self.assertFalse(Path(str(self.operator_env_file) + ".prev").exists())
        self.assertTrue(other.exists())
        rm = [c for c in self.docker_calls() if " rm " in c and "operator" in c.split(" rm ", 1)[1]]
        self.assertEqual(len(rm), 1)
        self.assertTrue(rm[0].endswith("rm --stop --force operator-bot"))   # a fixed name, no globbing

    def test_on_writes_its_own_600_file_with_exactly_its_names_and_starts_after_web(self):
        proc = self.deploy(self.payload() + self.section(TELEGRAM_ADMIN_USER_IDS="1,2"))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(stat.S_IMODE(self.operator_env_file.stat().st_mode), 0o600)
        text = self.operator_env_file.read_text()
        names = [l.split("=", 1)[0] for l in text.splitlines() if l and not l.startswith("#")]
        self.assertEqual(names, _example_keys_of(OPERATOR_EXAMPLE))
        self.assertIn("TELEGRAM_BOT_TOKEN=123:tok\n", text)
        self.assertIn("TELEGRAM_ADMIN_USER_IDS=1,2\n", text)
        self.assertNotIn("NIGHTSHIFT_OPERATOR_ENV", text)
        for other in (self.env_file, self.worker_env_file, self.notify_env_file, self.email_env_file):
            self.assertFalse(other.exists() and ("TELEGRAM_BOT_TOKEN" in other.read_text()
                                                  or "NIGHTSHIFT_OPERATOR_ENV" in other.read_text()))
        calls = self.docker_calls()
        web_up = [i for i, c in enumerate(calls) if c.endswith("up -d --build --remove-orphans web caddy")]
        bot_up = [i for i, c in enumerate(calls) if c.endswith("up -d --build --no-deps operator-bot")]
        self.assertEqual((len(web_up), len(bot_up)), (1, 1))
        self.assertLess(web_up[0], bot_up[0])
        self.assertTrue(all("--profile operator" in c for c in calls if " up " in f" {c} "))
        self.assertTrue(any(c.startswith("inspect -f operator-bot after 0s: state=") for c in calls))
        self.assertIn("operator-bot log hints:", proc.stdout)
        self.assertIn("operator-bot on", proc.stdout)
        self.assertEqual(self.up_calls("notify-worker") + self.up_calls("email-worker") + self.up_calls("worker"), [])

    def test_optional_keys_may_be_empty_and_required_ones_may_not(self):
        self.assertRefused(self.deploy(self.payload() + self.section(TELEGRAM_CHAT_ID="")), "TELEGRAM_CHAT_ID is required and empty")
        self.assertRefused(self.deploy(self.payload() + self.section(SUPABASE_SERVICE_KEY="")), "SUPABASE_SERVICE_KEY is required and empty")
        self.assertEqual(self.deploy(self.payload() + self.section()).returncode, 0)   # every optional key empty

    def test_refused_values_are_named_by_key_and_change_nothing(self):
        for key in ("TELEGRAM_BOT_TOKEN", "GITHUB_TOKEN", "OPERATOR_TZ"):
            for label, value in (("dollar", "a$b" + self.SECRET), ("cr", "a\rb" + self.SECRET)):
                with self.subTest(key=key, case=label):
                    proc = self.deploy(self.payload() + self.section(**{key: value}))
                    self.assertNotEqual(proc.returncode, 0)
                    self.assertIn(key, proc.stderr)
                    self.assertFalse(self.operator_env_file.exists())
                    self.assertFalse(self.env_file.exists())
                    self.assertEqual(self.docker_calls(), [])

    def test_a_key_the_bot_does_not_read_is_refused_without_echoing_it(self):
        for name in ("GEMINI_API_KEY", "ELEVENLABS_API_KEY", "TELEGRAM_CUSTOMER_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"):
            with self.subTest(name):
                proc = self.deploy(self.payload() + self.section(**{name: self.SECRET}))
                self.assertRefused(proc, f"{name} is not a key in deploy/.env.operator.example")
                self.assertFalse(self.operator_env_file.exists())

    def test_a_missing_or_repeated_key_and_a_repeated_marker_are_refused(self):
        self.assertRefused(self.deploy(self.payload() + self.section(drop=("GITHUB_TOKEN",))), "GITHUB_TOKEN is missing")
        self.assertRefused(self.deploy(self.payload() + self.section() + "OPERATOR_TZ=UTC\n"), "OPERATOR_TZ is given more than once")
        self.assertRefused(self.deploy(self.payload() + self.section() + "NIGHTSHIFT_OPERATOR_ENV=on\n"),
                           "NIGHTSHIFT_OPERATOR_ENV is not a key in deploy/.env.operator.example")

    def test_only_the_exact_marker_opens_the_section(self):
        self.assertRefused(self.deploy(self.payload(NIGHTSHIFT_OPERATOR_ENV="off")),
                           "NIGHTSHIFT_OPERATOR_ENV is not a key in deploy/.env.web.example")

    def test_the_section_is_independent_of_the_other_sections_and_of_their_order(self):
        notify = ("NIGHTSHIFT_NOTIFY_ENV=on\nSUPABASE_URL=https://abc.supabase.co\nSUPABASE_SERVICE_KEY=" + self.SECRET
                  + "\nTELEGRAM_CUSTOMER_BOT_TOKEN=123:cust\nNOTIFY_APP_ORIGIN=https://app.example.com\n")
        email = ("NIGHTSHIFT_EMAIL_ENV=on\nSUPABASE_URL=https://abc.supabase.co\nSUPABASE_SERVICE_KEY=" + self.SECRET
                 + "\nRESEND_API_KEY=re_key\nNIGHTSHIFT_EMAIL_FROM=Nightshift <hello@example.com>\nAPP_ORIGIN=https://app.example.com\n")
        worker = "NIGHTSHIFT_WORKER_ENV=on\n" + "\n".join(
            f"{k}={self.SECRET if k == 'SUPABASE_SERVICE_KEY' else ('https://abc.supabase.co' if k == 'SUPABASE_URL' else '')}"
            for k in worker_example_keys()
        ) + "\n"
        for payload in (
            self.payload() + worker + notify + email + self.section(),
            self.payload() + self.section() + email + notify + worker,
        ):
            proc = self.deploy(payload)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("operator-bot on", proc.stdout)
            self.assertNotIn("TELEGRAM_BOT_TOKEN", self.worker_env_file.read_text())
            self.assertNotIn("TELEGRAM_BOT_TOKEN", self.notify_env_file.read_text())
            self.assertNotIn("GEMINI_API_KEY", self.operator_env_file.read_text())
            self.assertNotIn("TELEGRAM_CUSTOMER_BOT_TOKEN", self.operator_env_file.read_text())

    def test_switching_off_removes_the_container_and_the_file_with_the_token(self):
        self.assertEqual(self.deploy(self.payload() + self.section()).returncode, 0)
        self.assertEqual(self.deploy(self.payload() + self.section()).returncode, 0)
        self.assertTrue(Path(str(self.operator_env_file) + ".prev").exists())
        self.assertEqual(stat.S_IMODE(Path(str(self.operator_env_file) + ".prev").stat().st_mode), 0o600)
        proc = self.deploy(self.payload())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(self.operator_env_file.exists())
        self.assertFalse(Path(str(self.operator_env_file) + ".prev").exists())
        self.assertTrue(any(c.endswith("rm --stop --force operator-bot") for c in self.docker_calls()))

    def test_a_bot_that_fails_to_start_fails_the_deploy_after_web(self):
        proc = self.deploy(self.payload() + self.section(), FAKE_OPERATOR_UP_RC="1")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("the operator bot did not start", proc.stderr)
        self.assertTrue(any(c.endswith("up -d --build --remove-orphans web caddy") for c in self.docker_calls()))

    def test_log_hints_name_known_phrases_and_never_the_log_text(self):
        text = f"ERROR operator bot stopped: a webhook is set for this bot token={self.SECRET}; Traceback"
        proc = self.deploy(self.payload() + self.section(), FAKE_LOG_TEXT=text)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertRegex(proc.stdout, r"operator-bot log hints: (Traceback,a_webhook_is_set|a_webhook_is_set,Traceback)")
        self.assertNotIn(self.SECRET, proc.stdout + proc.stderr)

    def test_the_env_file_is_written_atomically_from_the_first_byte_with_mode_600(self):
        text = REMOTE.read_text()
        self.assertIn("umask 077", text)
        self.assertRegex(text, r"tmp=\"\$\(mktemp \"\$\{target\}\.XXXXXX\"\)\"")
        self.assertRegex(text, r"mv -f \"\$tmp\" \"\$target\"")
        self.assertIn('write_env "$OPERATOR_ENV_FILE"', text)
        self.assertIn('rm -f "$file" "${file}.prev"', text)


class RemoteDeployMarketingTests(_RemoteDeployFixture):
    """The marketing-poster section of the payload, on the same fixture. Off is the default and removes everything."""

    def section(self, drop=(), **values):
        vals = {k: "" for k in _example_keys_of(MARKETING_EXAMPLE)}
        vals.update(SUPABASE_URL="https://abc.supabase.co", SUPABASE_SERVICE_KEY=self.SECRET,
                    TELEGRAM_CHANNEL_BOT_TOKEN="456:chan", MARKETING_TELEGRAM_CHAT="@nightshift_test",
                    NOTIFY_APP_ORIGIN="https://app.example.com", NIGHTSHIFT_MARKETING_POSTS="on")
        vals.update(values)
        return "\n".join(["NIGHTSHIFT_MARKETING_ENV=on"] + [f"{k}={v}" for k, v in vals.items() if k not in drop]) + "\n"

    def up_calls(self, svc="marketing-worker"):
        return [c for c in self.docker_calls() if c.endswith(f"up -d --build --no-deps {svc}")]

    def test_absent_removes_the_service_and_its_env_file_and_starts_nothing(self):
        proc = self.deploy(self.payload())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.up_calls(), [])
        self.assertFalse(self.marketing_env_file.exists())
        calls = self.docker_calls()
        self.assertTrue(any(c.endswith("rm --stop --force marketing-worker") for c in calls))
        self.assertIn("marketing-worker is off (GitHub variable NIGHTSHIFT_MARKETING_WORKER is not 'on')", proc.stdout)
        self.assertIn("marketing-worker off", proc.stdout)
        ups = [c for c in calls if " up " in f" {c} "]
        self.assertEqual(len(ups), 1, ups)                          # web and caddy only

    def test_a_stray_service_and_env_file_with_the_token_are_removed_when_the_switch_is_off(self):
        self.marketing_env_file.write_text("TELEGRAM_CHANNEL_BOT_TOKEN=left-behind\n")
        Path(str(self.marketing_env_file) + ".prev").write_text("TELEGRAM_CHANNEL_BOT_TOKEN=older\n")
        other = self.tmp / "other-file"
        other.write_text("keep")
        proc = self.deploy(self.payload())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(self.marketing_env_file.exists())
        self.assertFalse(Path(str(self.marketing_env_file) + ".prev").exists())
        self.assertTrue(other.exists())
        rm = [c for c in self.docker_calls() if " rm " in c and "marketing" in c.split(" rm ", 1)[1]]
        self.assertEqual(len(rm), 1)
        self.assertTrue(rm[0].endswith("rm --stop --force marketing-worker"))

    def test_switching_off_after_on_removes_the_container_and_both_copies_of_the_file(self):
        self.assertEqual(self.deploy(self.payload() + self.section()).returncode, 0)
        self.assertEqual(self.deploy(self.payload() + self.section()).returncode, 0)
        self.assertTrue(Path(str(self.marketing_env_file) + ".prev").exists())
        proc = self.deploy(self.payload())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(self.marketing_env_file.exists())
        self.assertFalse(Path(str(self.marketing_env_file) + ".prev").exists())
        self.assertTrue(any(c.endswith("rm --stop --force marketing-worker") for c in self.docker_calls()))

    def test_on_writes_its_own_600_file_with_exactly_its_six_names_and_starts_after_web(self):
        proc = self.deploy(self.payload() + self.section())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(stat.S_IMODE(self.marketing_env_file.stat().st_mode), 0o600)
        text = self.marketing_env_file.read_text()
        names = [l.split("=", 1)[0] for l in text.splitlines() if l and not l.startswith("#")]
        self.assertEqual(names, ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "TELEGRAM_CHANNEL_BOT_TOKEN",
                                 "MARKETING_TELEGRAM_CHAT", "NOTIFY_APP_ORIGIN", "NIGHTSHIFT_MARKETING_POSTS"])
        self.assertIn("TELEGRAM_CHANNEL_BOT_TOKEN=456:chan\n", text)
        self.assertNotIn("NIGHTSHIFT_MARKETING_ENV", text)
        for other in (self.env_file, self.worker_env_file, self.notify_env_file, self.email_env_file, self.operator_env_file):
            self.assertFalse(other.exists() and "TELEGRAM_CHANNEL_BOT_TOKEN" in other.read_text())
            # The web file carries the owner page's switch (the same variable the worker reads) but never the worker's
            # deploy switch; the other services' files carry neither.
            self.assertFalse(other.exists() and "NIGHTSHIFT_MARKETING_WORKER" in other.read_text())
            if other is not self.env_file:
                self.assertFalse(other.exists() and "NIGHTSHIFT_MARKETING" in other.read_text())
        calls = self.docker_calls()
        web_up = [i for i, c in enumerate(calls) if c.endswith("up -d --build --remove-orphans web caddy")]
        up = [i for i, c in enumerate(calls) if c.endswith("up -d --build --no-deps marketing-worker")]
        self.assertEqual((len(web_up), len(up)), (1, 1))
        self.assertLess(web_up[0], up[0])
        self.assertTrue(all("--profile marketing" in c for c in calls if " up " in f" {c} "))
        self.assertTrue(any(c.startswith("inspect -f marketing-worker after 0s: state=") for c in calls))
        self.assertIn("marketing-worker log hints:", proc.stdout)
        self.assertIn("marketing-worker on", proc.stdout)
        self.assertEqual(self.up_calls("notify-worker") + self.up_calls("email-worker") + self.up_calls("worker")
                         + self.up_calls("operator-bot"), [])

    def test_the_poster_switch_may_be_empty_so_a_deploy_never_needs_it_but_nothing_else_may(self):
        self.assertEqual(self.deploy(self.payload() + self.section(NIGHTSHIFT_MARKETING_POSTS="")).returncode, 0)
        self.assertIn("NIGHTSHIFT_MARKETING_POSTS=\n", self.marketing_env_file.read_text())
        for key in ("TELEGRAM_CHANNEL_BOT_TOKEN", "MARKETING_TELEGRAM_CHAT", "NOTIFY_APP_ORIGIN", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
            for f in (self.env_file, self.marketing_env_file, self.docker_log):
                f.unlink(missing_ok=True)
            self.assertRefused(self.deploy(self.payload() + self.section(**{key: ""})), f"{key} is required and empty")

    def test_refused_values_are_named_by_key_and_change_nothing(self):
        for key in ("TELEGRAM_CHANNEL_BOT_TOKEN", "MARKETING_TELEGRAM_CHAT", "NIGHTSHIFT_MARKETING_POSTS"):
            for label, value in (("dollar", "a$b" + self.SECRET), ("cr", "a\rb" + self.SECRET)):
                with self.subTest(key=key, case=label):
                    proc = self.deploy(self.payload() + self.section(**{key: value}))
                    self.assertNotEqual(proc.returncode, 0)
                    self.assertIn(key, proc.stderr)
                    self.assertNotIn(self.SECRET, proc.stdout + proc.stderr)
                    self.assertFalse(self.marketing_env_file.exists())
                    self.assertFalse(self.env_file.exists())
                    self.assertEqual(self.docker_calls(), [])

    def test_a_key_the_poster_does_not_read_is_refused_in_particular_the_other_bots_tokens(self):
        for name in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CUSTOMER_BOT_TOKEN", "GEMINI_API_KEY", "MARKETING_TELEGRAM_TEST_CHAT"):
            with self.subTest(name):
                proc = self.deploy(self.payload() + self.section(**{name: self.SECRET}))
                self.assertRefused(proc, f"{name} is not a key in deploy/.env.marketing.example")
                self.assertFalse(self.marketing_env_file.exists())

    def test_the_other_services_files_do_not_accept_the_channel_token(self):
        notify = ("NIGHTSHIFT_NOTIFY_ENV=on\nSUPABASE_URL=https://abc.supabase.co\nSUPABASE_SERVICE_KEY=x"
                  "\nTELEGRAM_CUSTOMER_BOT_TOKEN=1:c\nNOTIFY_APP_ORIGIN=https://app.example.com\nTELEGRAM_CHANNEL_BOT_TOKEN=" + self.SECRET + "\n")
        self.assertRefused(self.deploy(self.payload() + notify), "TELEGRAM_CHANNEL_BOT_TOKEN is not a key in deploy/.env.notify.example")

    def test_a_missing_or_repeated_key_and_a_repeated_marker_are_refused(self):
        self.assertRefused(self.deploy(self.payload() + self.section(drop=("MARKETING_TELEGRAM_CHAT",))), "MARKETING_TELEGRAM_CHAT is missing")
        self.assertRefused(self.deploy(self.payload() + self.section(drop=("NIGHTSHIFT_MARKETING_POSTS",))), "NIGHTSHIFT_MARKETING_POSTS is missing")
        self.assertRefused(self.deploy(self.payload() + self.section() + "NIGHTSHIFT_MARKETING_POSTS=on\n"),
                           "NIGHTSHIFT_MARKETING_POSTS is given more than once")
        self.assertRefused(self.deploy(self.payload() + self.section() + "NIGHTSHIFT_MARKETING_ENV=on\n"),
                           "NIGHTSHIFT_MARKETING_ENV is not a key in deploy/.env.marketing.example")

    def test_only_the_exact_marker_opens_the_section(self):
        # a marker with any other value is just an unknown web key: it never starts the service
        for value in ("off", "1", "true", "ON"):
            with self.subTest(value):
                self.assertRefused(self.deploy(self.payload(NIGHTSHIFT_MARKETING_ENV=value)),
                                   "NIGHTSHIFT_MARKETING_ENV is not a key in deploy/.env.web.example")
        self.assertEqual(self.up_calls(), [])

    def test_the_section_is_independent_of_the_other_sections_and_of_their_order(self):
        operator = ("NIGHTSHIFT_OPERATOR_ENV=on\n" + "\n".join(
            f"{k}={self.SECRET if k == 'SUPABASE_SERVICE_KEY' else ('https://abc.supabase.co' if k == 'SUPABASE_URL' else ('1:o' if k == 'TELEGRAM_BOT_TOKEN' else ('-100' if k == 'TELEGRAM_CHAT_ID' else '')))}"
            for k in _example_keys_of(OPERATOR_EXAMPLE)) + "\n")
        notify = ("NIGHTSHIFT_NOTIFY_ENV=on\nSUPABASE_URL=https://abc.supabase.co\nSUPABASE_SERVICE_KEY=" + self.SECRET
                  + "\nTELEGRAM_CUSTOMER_BOT_TOKEN=123:cust\nNOTIFY_APP_ORIGIN=https://app.example.com\n")
        for payload in (self.payload() + operator + notify + self.section(), self.payload() + self.section() + notify + operator):
            proc = self.deploy(payload)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("marketing-worker on", proc.stdout)
            self.assertNotIn("TELEGRAM_CHANNEL_BOT_TOKEN", self.notify_env_file.read_text())
            self.assertNotIn("TELEGRAM_CHANNEL_BOT_TOKEN", self.operator_env_file.read_text())
            self.assertNotIn("TELEGRAM_CUSTOMER_BOT_TOKEN", self.marketing_env_file.read_text())
            self.assertNotIn("TELEGRAM_BOT_TOKEN", self.marketing_env_file.read_text())

    def test_a_poster_that_fails_to_start_fails_the_deploy_after_web(self):
        proc = self.deploy(self.payload() + self.section(), FAKE_MARKETING_UP_RC="1")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("the marketing worker did not start", proc.stderr)

    def test_the_output_never_carries_a_value(self):
        proc = self.deploy(self.payload() + self.section(SUPABASE_SERVICE_KEY=self.SECRET, TELEGRAM_CHANNEL_BOT_TOKEN="456:" + self.SECRET))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn(self.SECRET, proc.stdout + proc.stderr)


if __name__ == "__main__":
    unittest.main()


class WorkerImageTest(unittest.TestCase):
    """Dockerfile.worker: media-worker (uid 1000) must be able to read the code."""

    def test_code_is_readable_by_other_uids_and_state_stays_private(self):
        text = (ROOT / "Dockerfile.worker").read_text()
        chown = text.index("chown -R nightshift:nightshift /app")
        readable = text.index("chmod -R go+rX,go-w /app")
        private = text.index("chmod 700 output history logs")
        self.assertLess(chown, readable)
        self.assertLess(readable, private)

