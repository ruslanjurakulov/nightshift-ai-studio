"""The restore prefix and the save key of the pipeline's `history/` cache.

``daily_video.yml`` and ``intelligence_poll.yml`` both restore the newest entry
under ``chronos-history-`` and save one back. GitHub picks the newest CREATED
entry under a restore prefix, not the highest number: the two workflows count
runs separately (a poll at #63 was created after a video run at #298, and the
next video run correctly restored ``chronos-history-63``). So the number in a
key is never an order, and what keeps the lineage intact is that

* every job restores with the restore-only action and saves exactly once,
  with a key that still matches the prefix it restores by;
* the save is ``if: always()`` (a failed or held run's history is the one that
  must not be lost);
* two workflows never write the same key shape, so equal run numbers cannot
  collide ("Unable to reserve cache with key ...").

Read-only workflows (telegram_control, check_pending_approvals) are pinned in
test_operator_bot_config.py. Parsed from the YAML, so the two sides cannot drift.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

import yaml

WORKFLOWS = Path(__file__).resolve().parent.parent / ".github" / "workflows"
PREFIX = "chronos-history-"
RUN = "${{ github.run_number }}"
SAVERS = ("daily_video.yml", "intelligence_poll.yml")


def history_steps(name):
    """(job, restore steps, save steps) for each job that touches history/."""
    doc = yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))
    out = []
    for job_id, job in doc["jobs"].items():
        restores, saves = [], []
        for step in job.get("steps", []):
            uses = str(step.get("uses", ""))
            if not uses.startswith("actions/cache") or str((step.get("with") or {}).get("path")) != "history":
                continue
            if uses.startswith("actions/cache/restore@"):
                restores.append(step)
            else:   # actions/cache/save@ and the combined actions/cache@ (restore AND post-step save)
                saves.append(step)
        if restores or saves:
            out.append((job_id, restores, saves))
    return out


class HistoryCacheKeys(unittest.TestCase):
    def test_each_saving_workflow_has_a_history_job(self):
        for name in SAVERS:
            self.assertTrue(history_steps(name), name)

    def test_one_restore_only_step_and_exactly_one_save_per_job(self):
        for name in SAVERS:
            for job_id, restores, saves in history_steps(name):
                with self.subTest(workflow=name, job=job_id):
                    self.assertEqual(len(restores), 1)
                    self.assertEqual(len(saves), 1)
                    self.assertTrue(str(saves[0]["uses"]).startswith("actions/cache/save@"),
                                    "a combined actions/cache step saves a second time in its post step")

    def test_the_save_key_matches_the_restore_prefix(self):
        for name in SAVERS:
            for job_id, restores, saves in history_steps(name):
                restore, save = restores[0]["with"], saves[0]["with"]
                with self.subTest(workflow=name, job=job_id):
                    self.assertEqual(restore["restore-keys"].strip(), PREFIX)
                    self.assertTrue(restore["key"].startswith(PREFIX), restore["key"])
                    self.assertTrue(save["key"].startswith(restore["restore-keys"].strip()), save["key"])
                    self.assertTrue(save["key"].startswith(PREFIX + RUN + "-"), save["key"])

    def test_the_save_runs_even_when_the_run_failed_or_was_held(self):
        for name in SAVERS:
            for job_id, _restores, saves in history_steps(name):
                with self.subTest(workflow=name, job=job_id):
                    self.assertIn("always()", str(saves[0].get("if", "")))

    def test_workflows_never_share_a_key_shape(self):
        suffixes = {}
        for name in SAVERS:
            for _job, _restores, saves in history_steps(name):
                key = saves[0]["with"]["key"]
                suffix = key[len(PREFIX + RUN + "-"):]
                suffixes.setdefault(re.sub(r"\$\{\{.*?\}\}", "<expr>", suffix), []).append(name)
        for suffix, names in suffixes.items():
            self.assertEqual(len(names), 1, f"{names} would write the same key shape '{suffix}'")

    def test_the_video_save_key_names_its_channel_and_the_poll_its_own_suffix(self):
        (_j, _r, video), = history_steps("daily_video.yml")
        (_j, _r, poll), = history_steps("intelligence_poll.yml")
        self.assertEqual(video[0]["with"]["key"], PREFIX + RUN + "-${{ matrix.channel_id }}")
        self.assertEqual(poll[0]["with"]["key"], PREFIX + RUN + "-poll")


if __name__ == "__main__":
    unittest.main()
