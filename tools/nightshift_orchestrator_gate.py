#!/usr/bin/env python3
"""Fail-closed deployment/Codex dispatcher authorization planner (no side effects)."""
import argparse
import json
from pathlib import Path

ALLOWED_TARGETS = {"staging", "production"}
BLOCKED = {"CI_FAILED", "CI_RUNNING", "CI_UNKNOWN", "NO_EVIDENCE", "REVIEW_PENDING", "CLOSED"}
def decision(report, action, target, approved=False):
    if action not in {"codex_task", "deploy"}:
        return {"allowed": False, "reason": "invalid_action"}
    if action == "deploy" and target not in ALLOWED_TARGETS:
        return {"allowed": False, "reason": "invalid_target"}
    if report.get("control_mode") != "READ_ONLY":
        return {"allowed": False, "reason": "untrusted_report"}
    if report.get("status") != "REVIEW_READY":
        return {"allowed": False, "reason": "not_review_ready"}
    if action == "deploy":
        # Production deployment requires explicit owner approval AND verified
        # branch protection / environment / rollback - not represented by this report.
        return {"allowed": False, "reason": "deployment_integration_not_verified"}
    if not approved:
        return {"allowed": False, "reason": "manual_codex_approval_required"}
    return {"allowed": False, "reason": "codex_auth_and_budget_not_configured"}

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--report", default="nightshift-orchestrator-report.json")
    p.add_argument("--action", choices=["codex_task", "deploy"], required=True)
    p.add_argument("--target", default="staging")
    p.add_argument("--approved", action="store_true")
    args = p.parse_args()
    report = json.loads(Path(args.report).read_text(encoding="utf-8"))
    output = decision(report, args.action, args.target, args.approved)
    print(json.dumps(output, sort_keys=True))
    return 0 if output["allowed"] else 2

if __name__ == "__main__":
    raise SystemExit(main())
