"""Supply-chain pins (BR-S-003): actions by commit, images by digest.

A tag (``actions/checkout@v7``, ``caddy:2``) is a pointer its owner can move;
whoever controls it decides what runs next to the repository's secrets or on
the production box. A commit SHA or an image digest names exactly one thing.

Every ``uses:`` in .github/workflows/ must be ``owner/repo[/path]@<40 hex>``
followed by ``# vX.Y.Z``: the release the SHA was taken from, so a reader and
an updater can see which version it is. Each SHA was checked against the
action's own repository (``git ls-remote --tags``: the SHA is the commit both
the major tag and the named release tag point to).

Every base image (Dockerfile ``FROM``/``ARG ..._IMAGE``, the compose file's
third-party ``image:``, a workflow ``services`` image) must carry
``@sha256:<64 hex>``. Images this repository builds itself
(``nightshift-*``) are exempt: they are not pulled from anywhere.

Runs under both ``python -m pytest`` and ``python -m unittest``.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"
DOCKERFILES = (ROOT / "Dockerfile.worker", ROOT / "command-center" / "Dockerfile")
COMPOSE = ROOT / "deploy" / "docker-compose.yml"

USES_RE = re.compile(r"^\s*-?\s*uses:\s*(\S+)(.*)$")
PINNED_USES_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$")
RELEASE_COMMENT_RE = re.compile(r"^\s*#\s*v\d+\.\d+\.\d+\s*$")
DIGEST_RE = re.compile(r"@sha256:[0-9a-f]{64}$")
OWN_IMAGES = ("nightshift-",)


def _uses_lines():
    for path in sorted(WORKFLOWS.glob("*.yml")):
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if line.lstrip().startswith("#"):
                continue
            m = USES_RE.match(line)
            if m:
                yield path.name, n, m.group(1), m.group(2)


def _image_refs():
    for path in DOCKERFILES:
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            s = line.strip()
            if s.startswith("# syntax="):
                yield path.name, n, s.split("=", 1)[1]
            elif s.upper().startswith("FROM "):
                ref = s.split()[1]
                if ref.startswith("${"):
                    continue  # resolved from an ARG, checked below
                yield path.name, n, ref
            elif re.match(r"^ARG\s+[A-Z_]*IMAGE=", s):
                yield path.name, n, s.split("=", 1)[1]
    compose = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
    for name, svc in (compose.get("services") or {}).items():
        image = (svc or {}).get("image")
        if image and not image.startswith(OWN_IMAGES):
            yield COMPOSE.name, name, image
    for path in sorted(WORKFLOWS.glob("*.yml")):
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        for job_id, job in (doc.get("jobs") or {}).items():
            for svc_name, svc in ((job or {}).get("services") or {}).items():
                image = svc.get("image") if isinstance(svc, dict) else svc
                yield path.name, f"{job_id}.{svc_name}", image
            container = (job or {}).get("container")
            if container:
                yield path.name, f"{job_id}.container", container.get("image") if isinstance(container, dict) else container


class PinnedActionsTest(unittest.TestCase):
    def test_every_action_is_pinned_to_a_commit_with_its_release_named(self):
        seen = 0
        for name, line, ref, rest in _uses_lines():
            seen += 1
            with self.subTest(workflow=name, line=line, uses=ref):
                if ref.startswith("./"):
                    continue  # a local action is this repository's own code
                self.assertRegex(ref, PINNED_USES_RE, f"{name}:{line} `{ref}` is not pinned to a 40-hex commit SHA")
                self.assertRegex(rest, RELEASE_COMMENT_RE, f"{name}:{line} needs `# vX.Y.Z` naming the release of that SHA")
        self.assertGreater(seen, 0)

    def test_one_action_one_sha(self):
        # Two SHAs for the same action means one of them was updated and the
        # other forgotten.
        shas: dict = {}
        for name, line, ref, rest in _uses_lines():
            if "@" not in ref:
                continue
            action, sha = ref.split("@", 1)
            repo = "/".join(action.split("/")[:2])
            shas.setdefault(repo, set()).add((sha, rest.strip()))
        for repo, pins in shas.items():
            with self.subTest(action=repo):
                self.assertEqual(len(pins), 1, f"{repo} is pinned to several SHAs: {sorted(pins)}")

    def test_the_rule_rejects_a_tag(self):
        self.assertNotRegex("actions/checkout@v7", PINNED_USES_RE)
        self.assertNotRegex("actions/checkout@main", PINNED_USES_RE)
        self.assertNotRegex("actions/checkout@3d3c42e", PINNED_USES_RE)
        self.assertRegex("actions/cache/restore@" + "a" * 40, PINNED_USES_RE)


class PinnedImagesTest(unittest.TestCase):
    def test_every_pulled_image_is_pinned_by_digest(self):
        refs = list(_image_refs())
        self.assertGreaterEqual(len(refs), 5)  # syntax, node, python, caddy, postgres
        for where, line, ref in refs:
            with self.subTest(file=where, at=line, image=ref):
                self.assertRegex(ref or "", DIGEST_RE, f"{where} {line}: `{ref}` is not pinned by @sha256 digest")

    def test_the_rule_rejects_a_tag(self):
        self.assertNotRegex("caddy:2", DIGEST_RE)
        self.assertNotRegex("python:3.11-slim-bookworm", DIGEST_RE)
        self.assertRegex("caddy:2@sha256:" + "0" * 64, DIGEST_RE)


if __name__ == "__main__":
    unittest.main()
