#!/usr/bin/env python3
"""CLI for reviewing and granting human approval on pipeline runs.

Every video run is tracked through Topic -> Research -> Script -> Fact
Check -> Human Approval by modules/pipeline_stages.py, but nothing calls
PipelineStateMachine.approve() automatically — it is deliberately reserved
for a human, run by hand.

IMPORTANT: this tool is REVIEW AND RECORD-KEEPING ONLY. The state machine it
edits (modules/pipeline_stages.py) is an audit trail, and nothing in the upload
path reads it: main.py advances every run to HUMAN_APPROVAL and stops there.
What actually stands between a finished video and a public upload is
modules/publish_gate.py (and, for a channel that requires two people,
modules/publish_approval.py), both of which main.py consults before uploading;
uploads are also private unless a channel has turned auto-publish on. Calling
--approve marks a run as reviewed and sets who/when for the audit trail; it
neither publishes nor releases a held video.

Usage:
  python tools/approve_run.py --list
  python tools/approve_run.py --list-pending
  python tools/approve_run.py --show <run_id>
  python tools/approve_run.py --approve <run_id> --approved-by "your name"
"""

import argparse
import json
import re
import sys

from config import OUTPUT_DIR
from modules.pipeline_stages import PipelineStage, PipelineStateMachine


def slugify(text: str) -> str:
    """Mirrors main.py's slugify() so fact-check sidecar files can be found."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:50]


def _status_marker(run) -> str:
    if run.human_approved:
        return "approved"
    if run.current_stage == PipelineStage.HUMAN_APPROVAL:
        return "pending"
    return ""


def _print_run(run, verbose: bool = False) -> None:
    print(f"{run.run_id}  [{run.current_stage.value:14}]  {_status_marker(run):9}  {run.topic}")
    if not verbose:
        return

    for t in run.history:
        note = f" — {t.note}" if t.note else ""
        print(f"    {t.timestamp}  {t.stage.value}{note}")
    if run.human_approved:
        print(f"    approved by {run.approved_by!r} at {run.approved_at}")

    fc_path = OUTPUT_DIR / slugify(run.topic) / "fact_check.json"
    if not fc_path.exists():
        print("    fact-check: no results found (may predate fact-checking, or the run failed before that stage)")
        return
    try:
        results = json.loads(fc_path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        print(f"    fact-check: could not read {fc_path} ({e})")
        return
    flagged = [r for r in results if r.get("requires_human_review")]
    if flagged:
        print(f"    fact-check: {len(flagged)}/{len(results)} claim(s) flagged for review:")
        for r in flagged:
            print(f"      [{r['verdict']}] {r['claim']}")
            print(f"        -> {r['reasoning']}")
    else:
        print(f"    fact-check: {len(results)} claim(s) checked, none flagged")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--list", action="store_true", help="List all runs, newest first")
    group.add_argument("--list-pending", action="store_true", help="List only unapproved runs at Human Approval")
    group.add_argument("--show", metavar="RUN_ID", help="Show full history and fact-check flags for one run")
    group.add_argument("--approve", metavar="RUN_ID", help="Grant human approval for a run")
    parser.add_argument("--approved-by", default=None, help="Required with --approve")
    args = parser.parse_args()

    pipeline = PipelineStateMachine()

    if args.approve:
        if not args.approved_by:
            parser.error("--approve requires --approved-by")
        try:
            run = pipeline.approve(args.approve, approved_by=args.approved_by)
        except ValueError as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)
        print(f"Approved {run.run_id} ({run.topic}) — human_approved={run.human_approved}")
        print("Note: this does NOT publish or unpublish anything by itself — main.py's")
        print("upload is not gated on this flag yet. See the module docstring for why.")
        return

    if args.show:
        run = pipeline.get_run(args.show)
        if run is None:
            print(f"No such run: {args.show}", file=sys.stderr)
            sys.exit(1)
        _print_run(run, verbose=True)
        return

    runs = pipeline.list_runs()
    runs.sort(key=lambda r: r.history[0].timestamp if r.history else "", reverse=True)

    if args.list_pending:
        runs = [r for r in runs if r.current_stage == PipelineStage.HUMAN_APPROVAL and not r.human_approved]
        if not runs:
            print("No runs pending approval.")
            return

    if not runs:
        print("No runs recorded yet.")
        return
    for run in runs:
        _print_run(run)


if __name__ == "__main__":
    main()
