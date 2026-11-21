#!/usr/bin/env python3
"""Run the feedback loop: turn published-video metrics into stored learning
signals and per-topic scores that Topic Manager reads on the next run.

This closes the loop the implementation report flagged as open. It reads only
what the intelligence poll already persisted (metrics_snapshots), so it is
meant to run AFTER a metrics poll — either standalone on its own schedule, or
as the final pass of tools/run_intelligence_poll.py (which is how the daily
GitHub Actions job invokes it).

Usage:
  python tools/run_feedback.py

Configuration: none required. With too little data (fewer than two videos with
metrics) it records nothing and reports zero, rather than inventing a verdict.
Always exits 0 — a feedback run producing nothing is normal, not an error.
"""

import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("run_feedback")

from modules.feedback_engine import FeedbackEngine


def main() -> int:
    logger.info("=== Feedback loop starting ===")
    try:
        summary = FeedbackEngine().run()
    except Exception as e:
        # FeedbackEngine.run() is already defensive, but never let this entry
        # point crash a scheduled job.
        logger.warning("Feedback loop failed (%s: %s)", type(e).__name__, e)
        summary = {"videos_analyzed": 0, "signals_recorded": 0, "topics_scored": 0}
    logger.info("Feedback loop summary: %s", summary)
    logger.info("=== Feedback loop done ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
