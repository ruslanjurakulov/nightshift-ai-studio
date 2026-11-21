"""Migration 0031: a render job created through the public API is paid from the
organization's API balance. The worker runs it only when the database says
the job's hold is open and bound to that very job, and never touches credits
for it (the database settles the hold when the job ends)."""

import io
import os
import tempfile
import unittest
from pathlib import Path

from tests.test_credits import FAKE_MAIN, FakeCredits, FakeQueue, job, qw  # noqa: F401
from modules import credits


class FakeApiCredits(FakeCredits):
    def __init__(self, api_amount=180, **kw):
        super().__init__(**kw)
        self.api_amount = api_amount

    def api_hold_start(self, ref, job_id):
        self._check()
        self.calls.append(("api_start", ref, job_id))
        return self.api_amount


HOLD = "ah-3f2b8c1e-8d4a-4b7e-9a51-0c2d6e7f8a90"


class ApiPaidJobs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        (self.repo / "main.py").write_text(FAKE_MAIN)
        self.env = {"PATH": os.environ.get("PATH", ""), "NIGHTSHIFT_CREDITS_ENFORCE": "1"}

    def tearDown(self):
        self.tmp.cleanup()

    def run_one(self, j, fake):
        q = FakeQueue([j])
        w = qw.Worker(q, worker_id="w1", env=self.env, repo_dir=self.repo, prelude=[],
                      resolve_channel=lambda cid: {"channel_id": cid, "is_default": False,
                                                   "token_secret": "CHRONOS_YT_TOKEN_NEWS"},
                      heartbeat_seconds=0.05, out=io.StringIO(), credits=fake,
                      ledger_reader=lambda channel_id, since: [])
        w.run_forever(once=True)
        return q.ends

    def test_open_api_hold_runs_without_a_credit_reservation(self):
        fake = FakeApiCredits()
        ends = self.run_one(job(credit_ref=None, api_hold_ref=HOLD, params={"duration": 300}), fake)
        self.assertEqual(ends, [("succeeded", None)])
        self.assertIn(("api_start", HOLD, 9), fake.calls)
        # Credits are never reserved, captured or released for an API job.
        self.assertEqual(fake.settled(), [])
        self.assertFalse(any(c[0] == "start" for c in fake.calls))

    def test_a_hold_that_is_not_open_for_this_job_refuses_without_running(self):
        fake = FakeApiCredits(api_amount=None)
        ends = self.run_one(job(credit_ref=None, api_hold_ref=HOLD, params={"duration": 300}), fake)
        self.assertEqual(ends[0][0], "failed")
        self.assertIn("API balance hold is not open", ends[0][1])
        self.assertFalse((self.repo / "report.out").exists())

    def test_unreachable_database_refuses_an_api_job(self):
        fake = FakeApiCredits(down=True)
        ends = self.run_one(job(credit_ref=None, api_hold_ref=HOLD, params={"duration": 300}), fake)
        self.assertEqual(ends[0][0], "failed")
        self.assertIn("nothing was run", ends[0][1])

    def test_an_api_job_without_its_frozen_length_is_refused_before_its_hold_starts(self):
        # The API priced a length; 0041 froze it into params. Without it the
        # run would take the channel's target at run time instead.
        fake = FakeApiCredits()
        ends = self.run_one(job(credit_ref=None, api_hold_ref=HOLD, params={}), fake)
        self.assertEqual(ends[0][0], "failed")
        self.assertIn("length was not fixed", ends[0][1])
        self.assertFalse(any(c[0] == "api_start" for c in fake.calls))
        self.assertFalse((self.repo / "report.out").exists())

    def test_without_a_credits_client_an_api_job_is_refused_even_unenforced(self):
        self.env.pop("NIGHTSHIFT_CREDITS_ENFORCE")
        ends = self.run_one(job(credit_ref=None, api_hold_ref=HOLD, params={"duration": 300}), None)
        self.assertEqual(ends[0][0], "failed")

    def test_rest_client_calls_the_0031_function(self):
        calls = []

        class Resp:
            status_code = 200

            def json(self):
                return 180

        class Http:
            def post(self, url, json=None, headers=None, timeout=None):
                calls.append((url, json))
                return Resp()

        client = credits.CreditsRest("https://x.supabase.co", "service-key", session=Http())
        self.assertEqual(client.api_hold_start(HOLD, "9"), 180)
        self.assertTrue(calls[0][0].endswith("/rest/v1/rpc/api_hold_start"))
        self.assertEqual(calls[0][1], {"p_ref": HOLD, "p_job_id": 9})


if __name__ == "__main__":
    unittest.main()
