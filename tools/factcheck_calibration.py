#!/usr/bin/env python3
"""Calibrate the fact-checker against claims whose truth is known.

    python3 tools/factcheck_calibration.py            # offline: validates the data file, calls nothing
    python3 tools/factcheck_calibration.py --live     # asks the real model (needs GEMINI_API_KEY)

Why: once the checker's system prompt is sent (modules/fact_checker.py), the model can for the first
time answer ``likely_accurate``, and that verdict is not flagged for review. Whether it says so about
a plausible falsehood is a property of the live model that no unit test can show, so it is measured
here, on ``tools/factcheck_calibration_claims.json`` (15 true, 15 false, 10 obscure claims).

PASS criterion: **0 of the 15 false claims come back ``likely_accurate``.** That is the only
criterion. How many of the 15 true claims clear is reported, never required (a checker that clears
nothing is safe, just useless), and the 10 obscure claims are reported only.

The run is INCONCLUSIVE (exit 2), never a pass, when any verdict was clamped or unresolved: a model
that answers every claim with a boolean also has "0 false accepts", and that is not a measurement.

Exit codes: 0 pass, 1 a false claim was accepted, 2 inconclusive or not run (the message says why and
what to do). Only this script's ``--live`` path touches the network, and only through
``fact_check_claims``, i.e. the same request the pipeline sends. No key is printed, and no model text
other than the verdict word (made ASCII and cut) is printed.

This measures the CHECKER alone. The evidence lookup (modules/grounding.py) runs after it and has its
own documented residual (docs/GROUNDED_FACTCHECK.md).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Callable, Optional

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

DEFAULT_CLAIMS = Path(__file__).resolve().parent / "factcheck_calibration_claims.json"
LABELS = ("true", "false", "obscure")
#: What the data file must hold, so an edit cannot quietly shrink the test.
EXPECTED_COUNTS = {"true": 15, "false": 15, "obscure": 10}
VERDICTS = ("likely_accurate", "likely_inaccurate", "unverifiable")

PASS, FAIL, INCONCLUSIVE = 0, 1, 2


def load_claims(path: Path = DEFAULT_CLAIMS) -> list[dict]:
    """The labelled claims, validated: known labels, unique ids and texts, the expected counts."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    rows = data["claims"] if isinstance(data, dict) else data
    ids, texts = set(), set()
    for row in rows:
        if row.get("label") not in LABELS:
            raise ValueError(f"claim {row.get('id')!r}: label must be one of {LABELS}")
        if not isinstance(row.get("claim"), str) or not row["claim"].strip():
            raise ValueError(f"claim {row.get('id')!r}: empty text")
        if row["id"] in ids or row["claim"] in texts:
            raise ValueError(f"duplicate claim {row['id']!r}")
        ids.add(row["id"])
        texts.add(row["claim"])
    counts = Counter(r["label"] for r in rows)
    if dict(counts) != EXPECTED_COUNTS:
        raise ValueError(f"expected {EXPECTED_COUNTS} claims per label, found {dict(counts)}")
    return rows


def evaluate(rows: list[dict], results: list) -> dict:
    """Score ``results`` (FactCheckResult-like, same order as ``rows``)."""
    if len(rows) != len(results):
        raise ValueError(f"{len(rows)} claims but {len(results)} results")
    by_label = {label: Counter() for label in LABELS}
    false_accepted, details = [], []
    clamped = unresolved = 0
    for row, res in zip(rows, results):
        was_clamped = bool(getattr(res, "clamped", False))
        was_unresolved = bool(getattr(res, "unresolved", False))
        clamped += was_clamped
        unresolved += was_unresolved
        word = ("clamped:" + str(getattr(res, "raw_verdict", None))) if was_clamped else (
            "unresolved" if was_unresolved else res.verdict)
        by_label[row["label"]][word] += 1
        if row["label"] == "false" and res.verdict == "likely_accurate" and not (was_clamped or was_unresolved):
            false_accepted.append(row["id"])
        details.append({"id": row["id"], "label": row["label"], "verdict": word})
    totals = {label: sum(c.values()) for label, c in by_label.items()}
    if false_accepted:
        outcome = FAIL
    elif clamped or unresolved:
        outcome = INCONCLUSIVE
    else:
        outcome = PASS
    return {
        "outcome": outcome,
        "false_total": totals["false"],
        "false_accepted": false_accepted,
        "true_total": totals["true"],
        "true_cleared": by_label["true"]["likely_accurate"],
        "obscure_total": totals["obscure"],
        "obscure_cleared": by_label["obscure"]["likely_accurate"],
        "clamped": clamped,
        "unresolved": unresolved,
        "by_label": {label: dict(c) for label, c in by_label.items()},
        "details": details,
    }


def format_report(summary: dict, system_prompt_on: Optional[bool] = None) -> str:
    verdict = {PASS: "PASS", FAIL: "FAIL", INCONCLUSIVE: "INCONCLUSIVE"}[summary["outcome"]]
    lines = ["Fact-checker calibration"]
    if system_prompt_on is not None:
        lines.append("system prompt sent: " + ("yes" if system_prompt_on else "NO (switch is off: this measures the old request)"))
    for label in LABELS:
        counts = summary["by_label"][label]
        lines.append(f"  {label:8} " + ", ".join(f"{w}={n}" for w, n in sorted(counts.items())))
    lines += [
        f"false claims accepted as likely_accurate: {len(summary['false_accepted'])} of {summary['false_total']}"
        + (f"  ({', '.join(summary['false_accepted'])})" if summary["false_accepted"] else ""),
        f"true claims that clear: {summary['true_cleared']} of {summary['true_total']}",
        f"obscure claims that clear: {summary['obscure_cleared']} of {summary['obscure_total']} (reported only)",
        f"clamped verdicts: {summary['clamped']}, unresolved: {summary['unresolved']}",
        f"RESULT: {verdict}",
    ]
    if summary["outcome"] == INCONCLUSIVE:
        lines.append("Not a measurement: some verdicts were clamped or unresolved (the model did not answer in the "
                     "three words, or a call failed). Fix that first; 0 false accepts means nothing here.")
    if summary["outcome"] == FAIL:
        lines.append("A false claim was accepted: do not merge the system-prompt change (or switch it off) until "
                     "the prompt or the model is changed and this passes.")
    return "\n".join(lines)


def run(rows: list[dict], check: Callable[[list[str]], list]) -> dict:
    return evaluate(rows, check([r["claim"] for r in rows]))


def main(argv=None, check: Optional[Callable] = None, env=None, out=print) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--live", action="store_true", help="ask the real model (needs GEMINI_API_KEY)")
    parser.add_argument("--claims", type=Path, default=DEFAULT_CLAIMS, help="the labelled claims (JSON)")
    parser.add_argument("--json", action="store_true", help="print the summary as JSON")
    args = parser.parse_args(argv)
    env = os.environ if env is None else env

    try:
        rows = load_claims(args.claims)
    except (OSError, ValueError, KeyError) as exc:
        out(f"cannot read the claims: {exc}")
        return INCONCLUSIVE
    if not args.live:
        out(f"Offline: {len(rows)} labelled claims read ({EXPECTED_COUNTS}); nothing was asked of any model.\n"
            "To measure the live model: GEMINI_API_KEY=... python3 tools/factcheck_calibration.py --live")
        return INCONCLUSIVE
    if check is None:
        if not env.get("GEMINI_API_KEY"):
            out("--live needs GEMINI_API_KEY in the environment (an AI Studio key with quota; a daily-quota "
                "429 is fixed by enabling billing, not by retrying).")
            return INCONCLUSIVE
        from modules.fact_checker import fact_check_claims
        check = fact_check_claims

    from modules.fact_checker import system_prompt_enabled

    summary = run(rows, check)
    out(json.dumps(summary, indent=1) if args.json
        else format_report(summary, system_prompt_enabled()))
    return summary["outcome"]


if __name__ == "__main__":
    sys.exit(main())
