"""packages/cli: run its own tests, and pin what makes it publishable and safe.

The CLI's tests are Node's built-in runner against a fake API server
(packages/cli/test). CI's Python job runs this file, so those tests run on
every pull request without a separate toolchain.
"""

import json
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "packages" / "cli"
PKG = json.loads((CLI / "package.json").read_text(encoding="utf-8"))


def node_or_skip():
    node = shutil.which("node")
    if not node:
        if os.environ.get("CI"):
            raise AssertionError("node is required in CI to test the CLI")
        raise unittest.SkipTest("node is not installed")
    version = subprocess.run([node, "--version"], capture_output=True, text=True, check=True).stdout.strip()
    major = int(version.lstrip("v").split(".")[0])
    if major < 20:
        if os.environ.get("CI"):
            raise AssertionError(f"node 20+ is required, found {version}")
        raise unittest.SkipTest(f"node 20+ is required, found {version}")
    return node


class CliSuiteTests(unittest.TestCase):
    def test_node_test_suite_passes(self):
        node = node_or_skip()
        r = subprocess.run([node, "--test"], cwd=CLI, capture_output=True, text=True, timeout=300)
        self.assertEqual(r.returncode, 0, (r.stdout + r.stderr)[-4000:])
        self.assertRegex(r.stdout, r"# fail 0")
        tests = int(re.search(r"# tests (\d+)", r.stdout).group(1))
        self.assertGreaterEqual(tests, 35, "the suite should cover success, 401, 402, 429, idempotency, 409, polling, key storage")


class CliPackageTests(unittest.TestCase):
    def test_package_json_is_ready_to_publish_but_not_published(self):
        self.assertEqual(PKG["name"], "@nightshift/cli")
        self.assertEqual(PKG["bin"], {"nightshift": "bin/nightshift.js"})
        self.assertEqual(PKG["type"], "module")
        self.assertEqual(PKG["engines"], {"node": ">=20"})
        self.assertEqual(PKG["publishConfig"], {"access": "public"})
        self.assertEqual(PKG["files"], ["bin", "src", "README.md"])
        self.assertIn("ruslanjurakulov/nightshift-ai-studio", PKG["repository"]["url"])
        self.assertEqual(PKG["repository"]["directory"], "packages/cli")
        self.assertIn("npm test", PKG["scripts"]["prepublishOnly"])
        self.assertNotIn("private", PKG)
        self.assertTrue((CLI / PKG["bin"]["nightshift"]).read_text(encoding="utf-8").startswith("#!/usr/bin/env node"))

    def test_the_licence_is_the_owners_decision(self):
        has_licence_file = any((ROOT / n).exists() for n in ("LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"))
        if not has_licence_file:
            self.assertNotIn("license", PKG, "the repository has no licence; the package must not invent one")
        # Either way, prepublishOnly must refuse to publish while the field is missing.
        check = (CLI / "scripts" / "prepublish-check.js").read_text(encoding="utf-8")
        self.assertIn("license", check)
        self.assertIn("process.exit(1)", check)

    def test_zero_runtime_dependencies(self):
        for field in ("dependencies", "peerDependencies", "optionalDependencies", "devDependencies"):
            self.assertNotIn(field, PKG, field)

    def test_sources_import_only_node_builtins_and_relative_files(self):
        for path in sorted((CLI / "src").rglob("*.js")) + sorted((CLI / "bin").rglob("*.js")):
            text = path.read_text(encoding="utf-8")
            for spec in re.findall(r"""(?:from|import\()\s*["']([^"']+)["']""", text):
                with self.subTest(file=path.name, spec=spec):
                    self.assertTrue(spec.startswith(("node:", ".")), f"{spec} is a third-party import")

    def test_the_cli_calls_only_real_api_routes(self):
        routes = {
            p.relative_to(ROOT / "command-center" / "app" / "api" / "v1").parent.as_posix()
            for p in (ROOT / "command-center" / "app" / "api" / "v1").rglob("route.ts")
        }
        # Static segments of every /api/v1 path the CLI builds.
        used = set()
        for path in sorted((CLI / "src").rglob("*.js")):
            for m in re.finditer(r'(?:request|stream)\(\s*(?:"(?:GET|POST)",\s*)?[`"](/[^`"]*)[`"]', path.read_text(encoding="utf-8")):
                used.add(re.sub(r"\$\{[^}]+\}", "[id]", m.group(1)).strip("/"))
        self.assertGreater(len(used), 10)
        normalised = {re.sub(r"\[[^\]]+\]", "[id]", r) for r in routes}
        for u in used:
            with self.subTest(path=u):
                self.assertIn(u, normalised, f"/api/v1/{u} is not a route of the API")

    def test_no_secret_shaped_literal_in_sources_or_tests(self):
        for path in sorted(CLI.rglob("*.js")):
            if "node_modules" in path.parts:
                continue
            with self.subTest(file=str(path.relative_to(ROOT))):
                self.assertIsNone(re.search(r"nsk_live_[0-9A-Za-z]{8,}", path.read_text(encoding="utf-8")))

    def test_pack_ships_only_the_runtime_files(self):
        npm = shutil.which("npm")
        if not npm:
            self.skipTest("npm is not installed")
        r = subprocess.run([npm, "pack", "--dry-run", "--json", "--ignore-scripts"], cwd=CLI, capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        files = {f["path"] for f in json.loads(r.stdout)[0]["files"]}
        self.assertIn("bin/nightshift.js", files)
        self.assertIn("package.json", files)
        self.assertFalse([f for f in files if f.startswith(("test/", "scripts/"))], files)

    def test_docs_exist_and_name_the_security_and_money_rules(self):
        docs = (ROOT / "docs" / "CLI.md").read_text(encoding="utf-8")
        for needle in ("0600", "Developers > API keys", "Idempotency-Key", "--max-credits", "Retry-After", "npm i -g ./packages/cli"):
            self.assertIn(needle, docs)
        readme = (CLI / "README.md").read_text(encoding="utf-8")
        self.assertIn("npm i -g ./packages/cli", readme)


if __name__ == "__main__":
    unittest.main()
