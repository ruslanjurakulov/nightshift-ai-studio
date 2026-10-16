"""Self-hosted Command Center: deploy/ must stay in step with the app.

The failure these guard against is quiet: someone adds `process.env.FOO` to the
Command Center, Vercel has FOO set, the self-hosted box does not, and a feature
silently reads as "not configured" on the server only. Or a compose edit
publishes the app port, which Docker opens around ufw. Neither shows up until
someone clicks the broken button on production.
"""

import hashlib
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

# Set by the hosting platform on its own deploys, never by an operator; the
# self-hosted box sets APP_ORIGIN instead, which the code reads first
# (command-center/lib/landing.ts siteOrigin), so an unset value here is the
# intended state, not a gap.
PLATFORM_PROVIDED = {"VERCEL_PROJECT_PRODUCTION_URL"}

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
        provided = set(example_keys()) | compose_environment_keys() | BUILD_ONLY | PLATFORM_PROVIDED
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

    def test_the_runtime_image_makes_public_readable_whatever_the_checkout_umask(self):
        # `public/` is copied from the build context as checked out, so a strict
        # umask on the deploy box leaves it 0700 and `node` dies at start with
        # EACCES (a restart loop behind a 502). The runner stage must fix the
        # modes after the COPY and before it drops to `node`.
        dockerfile = DOCKERFILE.read_text(encoding="utf-8")
        runner = dockerfile[dockerfile.index("AS runner"):]
        copy = runner.index("COPY --from=builder /app/public ./public")
        chmod = runner.index("RUN chmod -R a+rX,go-w public")
        user = runner.index("USER node")
        self.assertLess(copy, chmod)
        self.assertLess(chmod, user)


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

    def test_the_operator_bot_is_off_unless_its_profile_is_active(self):
        # Its profile is only ever activated by deploy/remote-deploy.sh.
        self.assertNotIn("operator-bot", self.config["services"])

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
        # Only DOMAIN is missing: compose reports the first unset required
        # variable it meets, in no fixed order, so every other one is set.
        env = {k: v for k, v in os.environ.items() if k != "DOMAIN"}
        env.update(
            ACME_EMAIL="admin@example.com",
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


class CaddyFramingTests(unittest.TestCase):
    """The proxy must not undo the app's frame rules (command-center/lib/view-mode.ts).

    The Mobile view shows the site inside a frame of its own page. The app answers
    SAMEORIGIN to exactly that request and DENY to everything else; a Caddy that
    also sends DENY unconditionally would win and blank the frame. So Caddy sends
    DENY only for requests the browser did not mark Sec-Fetch-Dest: iframe, and
    never loosens anything.
    """

    @classmethod
    def setUpClass(cls):
        cls.text = (DEPLOY / "Caddyfile").read_text(encoding="utf-8")
        cls.code = "\n".join(l for l in cls.text.splitlines() if not l.strip().startswith("#"))

    def test_deny_is_never_unconditional(self):
        for line in self.code.splitlines():
            if "X-Frame-Options" in line:
                self.assertIn("@notFrame", line, "X-Frame-Options must be set only for non-frame requests")

    def test_deny_still_covers_every_request_that_is_not_a_frame(self):
        self.assertIn("@notFrame not header Sec-Fetch-Dest iframe", self.code)
        # `>` defers the write, so the response carries ONE header and it is DENY (a plain
        # `header` would add a second line beside the app's own).
        self.assertIn('header @notFrame >X-Frame-Options "DENY"', self.code)

    def test_nothing_wider_is_sent_here(self):
        self.assertNotIn("SAMEORIGIN", self.code)
        self.assertNotIn("frame-ancestors", self.code)


class CaddyReloadStepTests(unittest.TestCase):
    """deploy/remote-deploy.sh makes a Caddyfile change take effect, and only a safe one.

    The Caddyfile is bind-mounted, so `compose up` does not reload Caddy when only
    that file changed (PR #426's framing rule sat unapplied on the server). The
    deploy now validates, guards, reloads, verifies and rolls back. Behaviour is
    exercised in tests/test_deploy_gha.py; these pin the structure and the contract.
    """

    @classmethod
    def setUpClass(cls):
        cls.script = (DEPLOY / "remote-deploy.sh").read_text(encoding="utf-8")
        cls.code = "\n".join(l for l in cls.script.splitlines() if not l.strip().startswith("#"))
        cls.caddyfile = "\n".join(
            l for l in (DEPLOY / "Caddyfile").read_text(encoding="utf-8").splitlines() if not l.strip().startswith("#")
        )

    def body(self, name):
        m = re.search(rf"^{name}\(\) \{{\n(.*?)^\}}\n", self.code, re.S | re.M)
        self.assertIsNotNone(m, name)
        return m.group(1)

    def array(self, name):
        m = re.search(rf"^{name}=\((.*?)\)\n", self.code, re.S | re.M)
        self.assertIsNotNone(m, name)
        return [a or b for a, b in re.findall(r"'([^']*)'|(\S+)", m.group(1))]

    def test_it_runs_after_compose_up_and_web_is_healthy_and_before_the_script_ends(self):
        main = self.body("main")
        order = [main.index(x) for x in ("compose up -d --build --remove-orphans web caddy", 'status" != healthy', "caddy_apply ", "log \"deployed")]
        self.assertEqual(order, sorted(order))

    def test_validate_then_guard_then_reload_then_verify_then_remember(self):
        body = self.body("caddy_apply")
        steps = ["caddy_exec validate", "caddy_exec adapt", "caddy_dropped", "caddy_reload", "caddy_verify", 'mv -f "$snap" "$loaded"', 'mv -f "${marker}.tmp"']
        idx = [body.index(x) for x in steps]
        self.assertEqual(idx, sorted(idx), steps)

    def test_the_config_comes_from_the_checkout_on_stdin_not_the_bind_mount(self):
        # A bind-mounted single file keeps pointing at the old inode when git replaces it.
        for name in ("caddy_apply", "caddy_reload"):
            for line in self.body(name).splitlines():
                if "caddy_exec " in line and "--config" in line:
                    self.assertIn("--config -", line)
                    self.assertRegex(line, r"<\"\$(snap|file)\"")
        self.assertNotIn("/etc/caddy/Caddyfile", self.code)
        self.assertIn("caddy_exec() { compose exec -T caddy caddy ", self.code)

    def test_reload_is_graceful_never_a_restart(self):
        self.assertIn("reload --config - ", self.body("caddy_reload"))
        self.assertIn("(--adapter caddyfile)", self.body("caddy_reload"))
        for bad in ("restart caddy", "up -d --force-recreate caddy", "stop caddy", "caddy stop", "rm --stop --force caddy"):
            self.assertNotIn(bad, self.code)

    def test_a_failure_rolls_back_and_the_deploy_step_fails(self):
        apply_ = self.body("caddy_apply")
        self.assertIn('caddy_reload "$snap" || caddy_rollback', apply_)
        self.assertIn("if ! caddy_verify", apply_)
        self.assertIn("caddy_rollback", apply_)
        rollback = self.body("caddy_rollback")
        self.assertLess(rollback.index('caddy_reload "$file" "$kind"'), rollback.index("caddy_verify"))
        # Best first: the verified copy, then what Caddy was running, then the commit before.
        order = [rollback.index(x) for x in (".caddyfile.loaded", ".caddy-running.json", ".caddyfile.fallback")]
        self.assertEqual(order, sorted(order))
        # Every way out of the rollback is die (exit 1): the owner sees a red step.
        self.assertGreaterEqual(rollback.count("die "), 3)
        self.assertNotIn("return 0", rollback)
        self.assertRegex(self.code, r"die\(\) \{[^}]*exit 1")

    def test_refusals_happen_before_anything_is_loaded(self):
        apply_ = self.body("caddy_apply")
        for refusal in ("validate refused", "no longer sets"):
            self.assertLess(apply_.index(refusal), apply_.index("caddy_reload"))
            self.assertIn("die ", apply_[apply_.index(refusal) - 120 : apply_.index(refusal)])

    def test_the_marker_is_written_only_after_a_verified_load(self):
        apply_ = self.body("caddy_apply")
        self.assertEqual(apply_.count('> "$marker"') + apply_.count('>"${marker}.tmp"'), 1)
        self.assertLess(apply_.index("caddy_verify"), apply_.index('>"${marker}.tmp"'))
        # The first-run stand-in is a copy only: no marker, so the first run still loads and verifies.
        self.assertNotIn("marker", self.body("caddy_seed_previous"))
        self.assertLess(self.body("main").index("caddy_seed_previous"), self.body("main").index("checkout --quiet -B main"))

    def test_only_the_pinned_caddyfile_is_ever_loaded(self):
        m = re.search(r'^CADDYFILE_APPROVED_SHA256="\$\{NIGHTSHIFT_CADDYFILE_APPROVED_SHA256:-([0-9a-f]{64})\}"$', self.code, re.M)
        self.assertIsNotNone(m, "the pinned hash constant is missing or reshaped")
        raw = (DEPLOY / "Caddyfile").read_bytes()
        # Exact bytes, no normalisation: keep the file free of what a checkout could rewrite.
        self.assertNotIn(b"\r", raw)
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
        self.assertEqual(
            m.group(1), hashlib.sha256(raw).hexdigest(),
            "deploy/Caddyfile changed: review it, then put `sha256sum deploy/Caddyfile` into "
            "CADDYFILE_APPROVED_SHA256 in deploy/remote-deploy.sh in the same PR",
        )
        apply_ = self.body("caddy_apply")
        gate = apply_.index('"$newsha" != "$CADDYFILE_APPROVED_SHA256"')
        for later in ("compose exec", "caddy_exec", "caddy_reload"):
            self.assertLess(gate, apply_.index(later), later)
        self.assertIn("die ", apply_[gate : gate + 400])
        # Names and short hashes only.
        self.assertIn("${newsha:0:12}", apply_)
        self.assertNotIn('${newsha}', apply_)
        # The service is checked before the file is judged by it.
        self.assertLess(apply_.index("caddy true"), apply_.index("caddy_exec validate"))

    def test_the_file_is_copied_once_and_that_copy_is_hashed_fed_and_kept(self):
        apply_ = self.body("caddy_apply")
        self.assertLess(apply_.index('-L "$new"'), apply_.index('cp "$new" "$snap"'))
        self.assertLess(apply_.index('cp "$new" "$snap"'), apply_.index('sha256sum "$snap"'))
        # After the copy the path is never opened again: no second read of it.
        after = apply_[apply_.index('cp "$new" "$snap"') + 20 :]
        self.assertNotRegex(after, r'<\s*"\$new"|sha256sum "\$new"|cp "\$new"|caddy_reload "\$new"')
        for fed in ('validate --config - --adapter caddyfile <"$snap"', 'adapt --config - --adapter caddyfile <"$snap"', 'caddy_reload "$snap"', 'mv -f "$snap" "$loaded"'):
            self.assertIn(fed, apply_)
        # The temporary copy is removed on every way out and the trap does not touch the exit code.
        self.assertIn("trap \"rm -f '$snap'\" EXIT", apply_)
        self.assertIn("trap - EXIT", apply_)
        self.assertNotIn("exit", apply_[apply_.index("trap") : apply_.index("trap") + 40])

    def test_the_running_config_is_dumped_from_inside_the_container_only(self):
        apply_ = self.body("caddy_apply")
        self.assertIn("exec -T caddy wget -qO- http://localhost:2019/config/", apply_)
        self.assertLess(apply_.index("wget"), apply_.index("caddy_reload"))
        self.assertIn('--adapter caddyfile', self.body("caddy_reload"))

    def test_the_contract_is_what_the_caddyfile_sends(self):
        header_block = re.search(r"^\theader \{\n(.*?)^\t\}", self.caddyfile, re.S | re.M).group(1)
        sent, removed = {}, set()
        for line in header_block.splitlines():
            line = line.strip()
            if not line:
                continue
            if line.startswith("-"):
                removed.add(line[1:])
                continue
            name, _, value = line.partition(" ")
            sent[name] = value.strip("`\"")
        exact = {e.split(": ", 1)[0]: e.split(": ", 1)[1] for e in self.array("CADDY_HEADERS")}
        present = set(self.array("CADDY_HEADERS_PRESENT"))
        self.assertEqual(set(sent), set(exact) | present)
        for name, value in exact.items():
            self.assertEqual(sent[name], value, name)
        self.assertEqual(removed, set(self.array("CADDY_HEADERS_ABSENT")))
        # And the framing rule the script verifies is the one the Caddyfile carries.
        self.assertIn('header @notFrame >X-Frame-Options "DENY"', self.caddyfile)
        self.assertIn("X-Frame-Options", self.body("caddy_dropped"))
        self.assertIn("sameorigin", self.body("caddy_check"))

    def test_the_guard_covers_every_contract_entry_and_nothing_widens(self):
        dropped = self.body("caddy_dropped")
        for arr in ("CADDY_HEADERS", "CADDY_HEADERS_PRESENT", "CADDY_HEADERS_ABSENT"):
            self.assertIn(f"${{{arr}[@]}}", dropped)
        self.assertIn("only DENY may be set", dropped)

    def test_it_reaches_caddy_only_on_this_machine_and_adds_no_privilege_or_secret(self):
        fetch = self.body("caddy_fetch")
        self.assertIn("127.0.0.1", fetch)
        self.assertIn("--resolve", fetch)
        self.assertNotIn("-k ", fetch)
        self.assertNotIn("--insecure", self.code)
        self.assertNotRegex(self.code, r"https?://(?!localhost:2019/)[a-z]")
        self.assertNotIn("sudo", self.code)
        self.assertNotIn("set -x", self.code)

    def test_nothing_caddy_or_the_app_says_is_printed(self):
        # The log is public: caddy's own output is discarded, the response is only compared.
        for name in ("caddy_apply", "caddy_reload"):
            for line in self.body(name).splitlines():
                if "caddy_exec " in line and "adapt" not in line:
                    self.assertIn(">/dev/null 2>&1", line)
        self.assertIn("2>/dev/null", self.body("caddy_fetch"))
        self.assertIn("-o /dev/null", self.body("caddy_fetch"))


@unittest.skipUnless(_docker_compose_available(), "docker compose not installed")
class ComposeOperatorProfileTests(unittest.TestCase):
    """`docker compose config` with the operator profile active, as remote-deploy.sh runs it."""

    @classmethod
    def setUpClass(cls):
        env = {k: v for k, v in os.environ.items() if not k.startswith("NEXT_PUBLIC_")}
        env.update(
            DOMAIN="app.example.com",
            ACME_EMAIL="admin@example.com",
            NEXT_PUBLIC_SUPABASE_URL="https://placeholder.supabase.co",
            NEXT_PUBLIC_SUPABASE_ANON_KEY="placeholder",
            WEB_ENV_FILE=str(ENV_EXAMPLE),
            OPERATOR_ENV_FILE="/nonexistent/.env.operator",
        )
        result = subprocess.run(
            ["docker", "compose", "--profile", "operator", "-f", str(COMPOSE), "config", "--format", "json"],
            capture_output=True, text=True, env=env, timeout=60,
        )
        if result.returncode != 0:
            raise AssertionError(f"docker compose config failed:\n{result.stderr}")
        cls.config = json.loads(result.stdout)

    def test_the_profile_adds_exactly_the_operator_bot(self):
        self.assertEqual(set(self.config["services"]), {"web", "caddy", "operator-bot"})

    def test_it_is_unreachable_and_unprivileged(self):
        bot = self.config["services"]["operator-bot"]
        self.assertFalse(bot.get("ports"))
        self.assertFalse(bot.get("expose"))
        self.assertFalse(bot.get("volumes"))
        self.assertEqual(bot["user"], "1000:1000")
        self.assertEqual(bot["cap_drop"], ["ALL"])
        self.assertEqual(bot["security_opt"], ["no-new-privileges:true"])
        self.assertEqual(bot["restart"], "unless-stopped")
        self.assertNotIn("privileged", bot)
        self.assertNotIn("docker.sock", json.dumps(bot))
        # Caddy's published ports are still only 80 and 443 and it proxies nothing but web.
        published = {p["published"] for p in self.config["services"]["caddy"]["ports"]}
        self.assertEqual(published, {"80", "443"})
        self.assertNotIn("operator", (DEPLOY / "Caddyfile").read_text().lower())

    def test_it_reads_only_its_own_env_file_and_no_variable_is_interpolated_into_it(self):
        bot = self.config["services"]["operator-bot"]
        self.assertEqual(bot.get("env_file") or [], [])       # the file is optional and absent in this check
        self.assertEqual(bot["environment"], {"HOME": "/tmp"})
        self.assertEqual(bot["command"], ["python", "tools/operator_bot_service.py"])
        self.assertEqual(bot["logging"]["options"]["max-size"], "10m")


if __name__ == "__main__":
    unittest.main()
