"""supabase/migrations/0032_render_jobs_insert_params.sql — "Run now" params.

SQL does not run in CI, so these pin the contract: every param the Create
page's queue-mode insert (command-center/lib/runBackend.ts) may send is allowed
by the insert policy, the worker-owned and browser-refused keys stay refused,
and the admin-of-the-org rule from 0019 is unchanged."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0032_render_jobs_insert_params.sql").read_text()
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())
RUN_BACKEND = (ROOT / "command-center" / "lib" / "runBackend.ts").read_text()


def allowed_keys():
    block = CODE.split("(params - array[", 1)[1].split("])", 1)[0]
    return set(re.findall(r"'([a-z_]+)'", block))


def keys_added_since():
    """What the policy has gained since 0032, from the latest migration that recreates it: 0140 adds made_for_kids (YouTube's "made
    for kids" for a run, true only; tests/test_made_for_kids_migration.py pins that the rest is 0076's policy)."""
    latest = [m for m in sorted((ROOT / "supabase" / "migrations").glob("*.sql"))
              if "create policy render_jobs_insert on public.render_jobs" in m.read_text()][-1].read_text()
    code = "\n".join(line.split("--", 1)[0] for line in latest.splitlines())
    block = code.split("(params - array[", 1)[1].split("])", 1)[0]
    return set(re.findall(r"'([a-z_]+)'", block)) - allowed_keys()


def insert_builder_keys():
    body = RUN_BACKEND.split("export function buildRenderJobInsert(", 1)[1].split("\n}\n", 1)[0]
    return set(re.findall(r"params\.([a-z_]+)\s*=", body))


class RenderJobsInsertParams(unittest.TestCase):
    def test_every_param_the_site_sends_is_allowed(self):
        sent = insert_builder_keys()
        self.assertTrue({"tts_model", "voice_id", "publish_hint"} <= sent)
        self.assertEqual(keys_added_since(), {"made_for_kids"})
        self.assertEqual(sent - allowed_keys() - keys_added_since(), set())

    def test_browser_refused_keys_stay_refused(self):
        for key in ("privacy", "resume", "repair_scenes"):
            self.assertNotIn(key, allowed_keys())

    def test_same_admin_rule_and_worker_columns(self):
        self.assertIn("channel_id in (select public.accessible_channel_ids('admin'))", CODE)
        self.assertIn("requested_by = auth.uid()", CODE)
        for col in ("worker_id is null", "heartbeat_at is null", "started_at is null",
                    "finished_at is null", "error is null", "status = 'queued'", "attempts = 0"):
            self.assertIn(col, CODE)
        self.assertEqual(len(re.findall(r"create policy \w+ on public\.render_jobs", CODE)), 1)


if __name__ == "__main__":
    unittest.main()
