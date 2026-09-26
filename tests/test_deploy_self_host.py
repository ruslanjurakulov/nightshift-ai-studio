"""Self-hosted Command Center: deploy/ must stay in step with the app.

The failure these guard against is quiet: someone adds `process.env.FOO` to the
Command Center, Vercel has FOO set, the self-hosted box does not, and a feature
silently reads as "not configured" on the server only. Or a compose edit
publishes the app port, which Docker opens around ufw. Neither shows up until
someone clicks the broken button on production.
"""

import json
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "command-center"
DEPLOY = ROOT / "deploy"
ENV_EXAMPLE = DEPLOY / ".env.web.example"
COMPOSE = DEPLOY / "docker-compose.yml"
DOCKERFILE = APP / "Dockerfile"

SOURCE_SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".cjs"}
SKIP_DIRS = {"node_modules", ".next", "tests", "out", "build"}

# Set by the Dockerfile itself (build or runtime); not something an operator sets.
BUILD_ONLY = {"NEXT_OUTPUT", "NODE_ENV"}

DOT_ACCESS = re.compile(r"process\.env\.([A-Z][A-Z0-9_]*)")
BRACKET_ACCESS = re.compile(r"""process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]""")
ANY_ACCESS = re.compile(r"process\.env\b")


def app_sources():
    for path in APP.rglob("*"):
        rel = path.relative_to(APP)
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        if path.suffix not in SOURCE_SUFFIXES or path.name.endswith((".test.ts", ".test.tsx")):
            continue
        if path.name == "vitest.config.ts":
            continue
        yield path


def referenced_env_vars():
    names, unreadable = set(), []
    for path in app_sources():
        text = path.read_text(encoding="utf-8")
        found = DOT_ACCESS.findall(text) + BRACKET_ACCESS.findall(text)
        names.update(found)
        # A dynamic read (process.env[name], destructuring) would slip past
        # the name check entirely, so it is refused rather than ignored.
        if len(ANY_ACCESS.findall(text)) != len(found):
            unreadable.append(str(path.relative_to(ROOT)))
    return names, unreadable


def example_keys():
    keys = {}
    for line in ENV_EXAMPLE.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^([A-Z][A-Z0-9_]*)=(.*)$", line)
        if m:
            keys[m.group(1)] = m.group(2)
    return keys


def compose_environment_keys():
    """Names compose sets on a service itself (`KEY: value` under environment)."""
    return set(re.findall(r"^\s+([A-Z][A-Z0-9_]*):\s", COMPOSE.read_text(encoding="utf-8"), re.M))


class EnvTemplateTests(unittest.TestCase):
    def test_every_env_var_the_app_reads_is_provided_on_the_server(self):
        names, unreadable = referenced_env_vars()
        self.assertFalse(unreadable, f"process.env read by a non-literal name in: {unreadable}")
        self.assertIn("NEXT_PUBLIC_SUPABASE_URL", names)  # the scan itself works
        provided = set(example_keys()) | compose_environment_keys() | BUILD_ONLY
        missing = sorted(names - provided)
        self.assertEqual(missing, [], f"add to deploy/.env.web.example: {missing}")

    def test_build_only_vars_are_really_set_by_the_dockerfile(self):
        dockerfile = DOCKERFILE.read_text(encoding="utf-8")
        for name in BUILD_ONLY:
            self.assertRegex(dockerfile, rf"\b{name}=")

    def test_public_vars_are_build_args_because_next_inlines_them_at_build_time(self):
        dockerfile = DOCKERFILE.read_text(encoding="utf-8")
        compose = COMPOSE.read_text(encoding="utf-8")
        for name in (k for k in example_keys() if k.startswith("NEXT_PUBLIC_")):
            self.assertRegex(dockerfile, rf"ARG {name}\b")
            self.assertRegex(compose, rf"{name}: \$\{{{name}")

    def test_no_service_key_and_no_real_looking_secret_in_the_template(self):
        text = ENV_EXAMPLE.read_text(encoding="utf-8")
        for key in example_keys():
            self.assertNotRegex(key, r"SERVICE|SERVICE_ROLE")
        for key, value in example_keys().items():
            # A JWT (Supabase keys), a GitHub token, a Slack hook: none belongs here.
            self.assertNotRegex(value, r"eyJ|ghp_|github_pat_|hooks\.slack\.com|GOCSPX-", key)
        self.assertNotIn("SUPABASE_SERVICE_KEY=", text)

    def test_server_only_secrets_are_never_build_args(self):
        dockerfile = DOCKERFILE.read_text(encoding="utf-8")
        for name in example_keys():
            if not name.startswith("NEXT_PUBLIC_"):
                self.assertNotRegex(dockerfile, rf"ARG {name}\b")


def _docker_compose_available():
    if not shutil.which("docker"):
        return False
    try:
        return subprocess.run(
            ["docker", "compose", "version"], capture_output=True, timeout=30
        ).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


@unittest.skipUnless(_docker_compose_available(), "docker compose not installed")
class ComposeConfigTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        env = {k: v for k, v in os.environ.items() if not k.startswith("NEXT_PUBLIC_")}
        env.update(
            DOMAIN="app.example.com",
            ACME_EMAIL="admin@example.com",
            NEXT_PUBLIC_SUPABASE_URL="https://placeholder.supabase.co",
            NEXT_PUBLIC_SUPABASE_ANON_KEY="placeholder",
            WEB_ENV_FILE=str(ENV_EXAMPLE),
        )
        result = subprocess.run(
            ["docker", "compose", "-f", str(COMPOSE), "config", "--format", "json"],
            capture_output=True, text=True, env=env, timeout=60,
        )
        if result.returncode != 0:
            raise AssertionError(f"docker compose config failed:\n{result.stderr}")
        cls.config = json.loads(result.stdout)

    def test_only_web_and_caddy_are_active(self):
        # The worker is a commented placeholder until its own image lands.
        self.assertEqual(set(self.config["services"]), {"web", "caddy"})

    def test_the_app_port_is_never_published(self):
        # Docker-published ports bypass ufw; only Caddy faces the internet.
        self.assertFalse(self.config["services"]["web"].get("ports"))
        published = {p["published"] for p in self.config["services"]["caddy"]["ports"]}
        self.assertEqual(published, {"80", "443"})

    def test_oauth_origin_follows_the_domain(self):
        env = self.config["services"]["web"]["environment"]
        self.assertEqual(env["APP_ORIGIN"], "https://app.example.com")

    def test_restart_and_log_rotation_on_every_service(self):
        for name, svc in self.config["services"].items():
            self.assertEqual(svc.get("restart"), "unless-stopped", name)
            self.assertEqual(svc["logging"]["options"]["max-size"], "10m", name)

    def test_caddy_keeps_certificates_on_a_volume(self):
        targets = {v["target"] for v in self.config["services"]["caddy"]["volumes"]}
        self.assertIn("/data", targets)

    def test_missing_domain_fails_loudly_instead_of_serving_a_blank_site(self):
        env = {k: v for k, v in os.environ.items() if k not in {"DOMAIN", "ACME_EMAIL"}}
        env.update(
            NEXT_PUBLIC_SUPABASE_URL="https://placeholder.supabase.co",
            NEXT_PUBLIC_SUPABASE_ANON_KEY="placeholder",
            WEB_ENV_FILE=str(ENV_EXAMPLE),
        )
        result = subprocess.run(
            ["docker", "compose", "-f", str(COMPOSE), "config"],
            capture_output=True, text=True, env=env, timeout=60,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("DOMAIN", result.stderr)


if __name__ == "__main__":
    unittest.main()
