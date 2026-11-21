"""supabase/migrations/0083_workflow_wait.sql — a workflow step that cannot start for
a reason that passes waits instead of failing the run (BR-L-011, LENS-4).

SQL does not run in this suite (tests/security/test_sec_workflows_wait.py runs the
attacks against a real Postgres 16). These pin that 0083 is built on the LATEST
body of what it replaces (0074's workflow_advance_locked: every line kept, in
order, only lines added), that it waits only on the parallel limit and a short
balance, that the 24 h rule still bounds the wait, and that its privileges are
explicit."""

import re
import unittest
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parent.parent / "supabase" / "migrations"
FILE = "0083_workflow_wait.sql"
SQL = (MIGRATIONS / FILE).read_text()
REPLACED = ["workflow_advance_locked"]


def bodies(text):
    return {m.group(1): m.group(0) for m in
            re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$;\n", text, re.S)}


def literals(body):
    code = re.sub(r"--[^\n]*", "", body)
    return set(re.findall(r"'(?:[^']|'')*'", code))


def code(body):
    return "\n".join(line.split("--", 1)[0] for line in body.splitlines())


def latest(name):
    """The newest migration BELOW this one that defines ``name``."""
    for f in sorted(MIGRATIONS.glob("*.sql"), reverse=True):
        if f.name >= FILE[:4] or not re.match(r"^\d{4}_", f.name):
            continue
        b = bodies(f.read_text())
        if name in b:
            return f.name, b[name]
    raise AssertionError(name)


class BuiltOnTheLatestBody(unittest.TestCase):
    def test_replaces_only_the_advance_function_and_changes_no_schema(self):
        self.assertEqual(sorted(bodies(SQL)), REPLACED)
        self.assertNotRegex(code(SQL), r"\b(drop|alter|create table|create policy|create index|truncate|insert|delete)\b")

    def test_the_body_is_taken_from_the_file_that_last_defined_it(self):
        self.assertEqual(latest("workflow_advance_locked")[0], "0074_workflow_lens2.sql")

    def test_every_line_of_the_old_body_is_still_there_in_order(self):
        # Only additions: the old body is a subsequence of the new one, line for line.
        _, old = latest("workflow_advance_locked")
        it = iter(bodies(SQL)["workflow_advance_locked"].splitlines())
        for line in old.splitlines():
            self.assertTrue(any(line == n for n in it), f"line changed or moved: {line!r}")

    def test_every_literal_and_check_survives(self):
        _, old = latest("workflow_advance_locked")
        new = bodies(SQL)["workflow_advance_locked"]
        for lit in literals(old):
            self.assertIn(lit, literals(new), f"lost {lit}")
        for stmt in ("raise exception", "raise;", "for update", "why_code :=", "create_creative_job(",
                     "workflow_confirmer_may_spend(", "if not found", "interval '24 hours'",
                     "over_confirmed_total", "idempotency_conflict", "sqlstate like '40%'"):
            self.assertGreaterEqual(code(new).count(stmt), code(old).count(stmt), f"fewer {stmt}")


class TheFix(unittest.TestCase):
    def setUp(self):
        self.adv = code(bodies(SQL)["workflow_advance_locked"])
        self.handler = self.adv.split("exception when others then", 1)[1]

    def test_only_the_parallel_limit_and_a_short_balance_wait(self):
        self.assertIn("wait_ := sqlstate in ('NS429', 'NS402');", self.handler)
        self.assertEqual(self.adv.count("wait_ :="), 2)  # reset per step, set in the handler only
        self.assertIn("wait_ := false;", self.adv.split("exception when others then", 1)[0])

    def test_a_transient_error_and_a_strict_first_step_are_still_raised_first(self):
        self.assertLess(self.handler.index("if sqlstate like '40%' then"), self.handler.index("wait_ :="))
        self.assertLess(self.handler.index("if p_strict and s.step_index = 0 then"), self.handler.index("wait_ :="))

    def test_a_waiting_step_stays_pending_and_the_run_running(self):
        block = self.adv.split("if wait_ then", 1)[1].split("end if;", 1)[0]
        self.assertIn("update public.workflow_run_steps set error_code = why_code, error = why", block)
        self.assertIn("status = 'pending'", block)
        self.assertIn("exit;", block)
        self.assertNotIn("workflow_runs", block)  # the run is not failed, finished or charged
        self.assertNotIn("'failed'", block)
        # The wait is decided before the failure path, which is unchanged after it.
        self.assertLess(self.adv.index("if wait_ then"), self.adv.index("set status = 'failed', charged_credits = 0, error_code = why_code"))

    def test_the_24_hour_confirmation_still_bounds_the_wait(self):
        self.assertLess(self.adv.index("why_code := 'confirmation_expired';"), self.adv.index("public.create_creative_job("))
        self.assertLess(self.adv.index("why_code := 'confirmation_revoked';"), self.adv.index("public.create_creative_job("))

    def test_no_stale_reason_on_a_step_that_starts_or_is_skipped(self):
        start = self.adv.split("set status = 'running', job_id =", 1)[1].split("continue;", 1)[0]
        self.assertIn("update public.workflow_run_steps set error_code = null, error = null", start)
        tail = self.adv.split("end loop;", 1)[1]
        self.assertIn("status = 'skipped' and error_code is not null", tail)


class Privileges(unittest.TestCase):
    def test_pins_its_search_path(self):
        self.assertIn("security definer set search_path = public, pg_temp as $$", bodies(SQL)["workflow_advance_locked"])

    def test_no_api_role_may_call_it(self):
        self.assertIn("revoke all on function public.workflow_advance_locked(uuid, boolean) "
                      "from public, anon, authenticated, service_role;", SQL)
        self.assertIsNone(re.search(r"^grant ", SQL, re.M))

    def test_ends_with_a_verify_query(self):
        self.assertIn("-- Verify (run after applying; every column should read true)", SQL)
        self.assertIn("as search_path_pinned;", SQL.rstrip().splitlines()[-1])


if __name__ == "__main__":
    unittest.main()
