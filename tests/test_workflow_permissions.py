"""Workflow token scope (BR-S-001): least privilege as a rule, not per file.

Six workflows once had no ``permissions:`` block, so their ``GITHUB_TOKEN`` got
whatever the repository default was (possibly read and write), and
``actions/checkout`` left that token in ``.git/config`` for every later step:
``pip install`` of unpinned packages and model-driven pipeline code, in the
same job as the service key.

Every workflow under .github/workflows/ must now:

* declare a top-level ``permissions:`` mapping (never ``write-all``/``read-all``),
  with ``contents: read``;
* grant no ``write`` scope, at workflow or job level, unless the workflow and
  scope are listed in ``WRITE_ALLOWED`` below with the reason (none are today:
  no workflow calls the GitHub API or pushes);
* check out with ``persist-credentials: false``, since no workflow pushes.

Runs under both ``python -m pytest`` and ``python -m unittest``.
"""

from __future__ import annotations

import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"

# (workflow file name, job id or "*" for top level, scope) -> why it needs write.
# Empty: nothing pushes, comments, releases or calls the GitHub API.
WRITE_ALLOWED: dict = {}

# The six files BR-S-001 named. Pinned by name so a rename cannot quietly
# drop one out of the glob below.
BR_S_001 = (
    "check_pending_approvals.yml",
    "daily_video.yml",
    "frontend.yml",
    "intelligence_poll.yml",
    "telegram_control.yml",
    "tests.yml",
)


def _workflows():
    files = sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml"))
    return [(p, yaml.safe_load(p.read_text(encoding="utf-8"))) for p in files]


def _write_scopes(perms):
    if isinstance(perms, str):
        return ["<all>"] if perms != "read-all" else []
    if isinstance(perms, dict):
        return [k for k, v in perms.items() if v == "write"]
    return []


class WorkflowPermissionsTest(unittest.TestCase):
    def test_the_six_named_workflows_exist(self):
        for name in BR_S_001:
            self.assertTrue((WORKFLOWS / name).is_file(), name)

    def test_every_workflow_declares_least_privilege(self):
        found = _workflows()
        self.assertGreaterEqual(len(found), len(BR_S_001))
        for path, doc in found:
            with self.subTest(workflow=path.name):
                self.assertIsInstance(doc, dict)
                perms = doc.get("permissions")
                self.assertIsInstance(
                    perms, dict,
                    f"{path.name}: needs a top-level `permissions:` mapping "
                    "(a missing block or write-all/read-all inherits too much)",
                )
                self.assertEqual(perms.get("contents"), "read", f"{path.name}: contents must be read")

    def test_no_write_scope_without_a_listed_reason(self):
        for path, doc in _workflows():
            grants = [("*", s) for s in _write_scopes(doc.get("permissions"))]
            for job_id, job in (doc.get("jobs") or {}).items():
                grants += [(job_id, s) for s in _write_scopes((job or {}).get("permissions"))]
            for job_id, scope in grants:
                with self.subTest(workflow=path.name, job=job_id, scope=scope):
                    self.assertIn(
                        (path.name, job_id, scope), WRITE_ALLOWED,
                        f"{path.name} job {job_id}: `{scope}: write` needs a reason in WRITE_ALLOWED",
                    )

    def test_checkout_never_persists_the_token(self):
        checkouts = 0
        for path, doc in _workflows():
            for job_id, job in (doc.get("jobs") or {}).items():
                for i, step in enumerate((job or {}).get("steps") or []):
                    uses = str(step.get("uses", ""))
                    if not uses.startswith("actions/checkout@"):
                        continue
                    checkouts += 1
                    with self.subTest(workflow=path.name, job=job_id, step=i):
                        persist = (step.get("with") or {}).get("persist-credentials")
                        self.assertIs(
                            persist, False,
                            f"{path.name} job {job_id}: actions/checkout needs "
                            "`persist-credentials: false` (no workflow pushes)",
                        )
        self.assertGreater(checkouts, 0)

    def test_the_rule_rejects_a_bad_workflow(self):
        # Positive control: the helper really sees write scopes.
        self.assertEqual(_write_scopes("write-all"), ["<all>"])
        self.assertEqual(_write_scopes({"contents": "write", "issues": "read"}), ["contents"])
        self.assertEqual(_write_scopes({"contents": "read"}), [])
        self.assertEqual(_write_scopes(None), [])


if __name__ == "__main__":
    unittest.main()
