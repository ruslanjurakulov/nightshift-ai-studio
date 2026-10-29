#!/usr/bin/env python3
"""Read-only Nightshift PR/check monitor. No agent execution or repository writes."""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def get_json(path, *, token, opener=urllib.request.urlopen):
    req = urllib.request.Request(
        "https://api.github.com" + path,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": "Bearer " + token,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "nightshift-readonly-orchestrator/0.1",
        },
    )
    with opener(req, timeout=20) as response:
        return json.load(response)


def classify(pr, checks, jobs):
    """Fail closed: missing and pending checks are never a pass."""
    if pr.get("merged_at"):
        return "MERGED", "PR merged; do not start another task automatically."
    if pr.get("state") != "open":
        return "CLOSED", "PR closed; stop this queue item."
    if pr.get("draft"):
        return "REVIEW_PENDING", "Draft PR: review code and request completion of checks."
    check_items = checks.get("check_runs", [])
    workflow_items = jobs.get("workflow_runs", [])
    if not check_items and not workflow_items:
        return "NO_EVIDENCE", "No CI checks found; do not infer PASS."
    failures = {"failure", "timed_out", "cancelled", "action_required", "startup_failure"}
    if any(x.get("conclusion") in failures for x in check_items + workflow_items):
        return "CI_FAILED", "Check/workflow failed; inspect sanitized evidence and prepare a bounded fix."
    if any(x.get("status") != "completed" for x in check_items + workflow_items):
        return "CI_RUNNING", "Wait for checks to finish."
    if any(x.get("conclusion") not in {"success", "neutral", "skipped"} for x in check_items + workflow_items):
        return "CI_UNKNOWN", "Unknown result; inspect manually."
    return "REVIEW_READY", "CI success is not proof of SQL security; human review required."


def evaluate(repo, number, token, fetch=get_json):
    pr = fetch(f"/repos/{repo}/pulls/{number}", token=token)
    sha = pr.get("head", {}).get("sha")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Missing valid PR SHA")
    checks = fetch(f"/repos/{repo}/commits/{sha}/check-runs?per_page=100", token=token)
    runs = fetch(f"/repos/{repo}/actions/runs?head_sha={sha}&per_page=100", token=token)
    status, action = classify(pr, checks, runs)
    return {
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "repository": repo,
        "pr_number": number,
        "pr_url": f"https://github.com/{repo}/pull/{number}",
        "head_sha": sha,
        "status": status,
        "recommended_next_action": action,
        "check_count": len(checks.get("check_runs", [])),
        "workflow_count": len(runs.get("workflow_runs", [])),
        "control_mode": "READ_ONLY",
        "codex_session_control": "NOT_CONNECTED",
        "production_access": False,
        "sql_security_accepted": False,
        "auto_merge": False,
        "auto_deploy": False
    }


def main():
    repo = os.getenv("GITHUB_REPOSITORY", "")
    token = os.getenv("GITHUB_TOKEN", "")
    number = os.getenv("NIGHTSHIFT_MONITOR_PR", "647")
    if not REPO_RE.fullmatch(repo) or not token or not number.isdecimal() or int(number) < 1:
        print("BLOCKED: invalid monitor configuration", file=sys.stderr)
        return 2
    try:
        report = evaluate(repo, int(number), token)
    except (ValueError, urllib.error.HTTPError, urllib.error.URLError, TimeoutError):
        print("BLOCKED: GitHub API query failed; details withheld", file=sys.stderr)
        return 1
    Path("nightshift-orchestrator-report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    summary = os.getenv("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(
                f"### Nightshift Orchestrator · READ ONLY\n\n"
                f"PR #{report['pr_number']}: **{report['status']}**\n\n"
                f"{report['recommended_next_action']}\n\n"
                "No Codex tasks, merges, deployments or production calls were executed.\n"
            )
    print(f"Nightshift PR #{report['pr_number']}: {report['status']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
