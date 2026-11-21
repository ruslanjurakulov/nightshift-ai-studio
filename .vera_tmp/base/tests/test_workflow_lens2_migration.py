"""supabase/migrations/0074_workflow_lens2.sql — LENS-2 fixes to workflow runs (0073).

SQL does not run in this suite (tests/security/test_sec_workflows.py runs the
attacks against a real Postgres 16). These pin that 0074 is built on the LATEST
bodies of what it replaces (every string literal and every check of 0073's
workflow_advance_locked, advance_workflow_run and cancel_workflow_run survives),
that it adds exactly the three fixes, and that grants and search_path are
explicit."""

import re
import unittest
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parent.parent / "supabase" / "migrations"
SQL = (MIGRATIONS / "0074_workflow_lens2.sql").read_text()
REPLACED = ["advance_workflow_run", "cancel_workflow_run", "workflow_advance_locked"]


def bodies(text):
    return {m.group(1): m.group(0) for m in
            re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$;\n", text, re.S)}


def literals(body):
    code = re.sub(r"--[^\n]*", "", body)
    return set(re.findall(r"'(?:[^']|'')*'", code))


def code(body):
    return "\n".join(line.split("--", 1)[0] for line in body.splitlines())


def latest(name):
    """The newest migration BELOW 0074 that defines ``name``."""
    for f in sorted(MIGRATIONS.glob("*.sql"), reverse=True):
        if f.name >= "0074" or not re.match(r"^\d{4}_", f.name):
            continue
        b = bodies(f.read_text())
        if name in b:
            return f.name, b[name]
    raise AssertionError(name)


class BuiltOnTheLatestBodies(unittest.TestCase):
    def test_replaces_only_the_three_run_functions_and_adds_one_helper(self):
        self.assertEqual(sorted(bodies(SQL)), sorted(REPLACED + ["workflow_confirmer_may_spend"]))
        self.assertNotRegex(code(SQL), r"\b(drop|alter|create table|create policy|truncate)\b")

    def test_the_bodies_are_taken_from_the_file_that_last_defined_them(self):
        for name in REPLACED:
            self.assertEqual(latest(name)[0], "0073_workflow_apps.sql", name)

    def test_every_literal_of_the_latest_bodies_survives(self):
        new = bodies(SQL)
        for name in REPLACED:
            source, old = latest(name)
            for lit in literals(old):
                self.assertIn(lit, literals(new[name]), f"{name} lost {lit} from {source}")

    def test_no_check_of_the_replaced_functions_is_dropped(self):
        new = bodies(SQL)
        for name in REPLACED:
            _, old = latest(name)
            for stmt in ("raise exception", "is_org_member(", "credits_exempt(", "is_platform_admin(",
                         "for update", "why_code :=", "auth.uid() is null", "create_creative_job(",
                         "cancel_creative_job(", "if not found"):
                self.assertGreaterEqual(code(new[name]).count(stmt), code(old).count(stmt), f"{name}: fewer {stmt}")

    def test_every_line_of_the_old_bodies_is_still_there_in_order(self):
        # Only additions: the old body is a subsequence of the new one, line for line.
        new = bodies(SQL)
        for name in REPLACED:
            _, old = latest(name)
            it = iter(new[name].splitlines())
            for line in old.splitlines():
                self.assertTrue(any(line == n for n in it), f"{name}: line changed or moved: {line!r}")


class TheFixes(unittest.TestCase):
    def setUp(self):
        self.b = {k: code(v) for k, v in bodies(SQL).items()}

    def test_a_replayed_step_key_is_refused_never_adopted(self):
        adv = self.b["workflow_advance_locked"]
        self.assertIn("if coalesce((out_ ->> 'replay')::boolean, false) then", adv)
        self.assertIn("raise exception 'idempotency_conflict' using errcode = 'NS409'", adv)
        # The refusal comes before the step is marked running with the job.
        self.assertLess(adv.index("out_ ->> 'replay'"), adv.index("set status = 'running', job_id ="))

    def test_a_transient_error_is_raised_not_stored_as_a_failure(self):
        adv = self.b["workflow_advance_locked"]
        handler = adv.split("exception when others then", 1)[1]
        self.assertLess(handler.index("if sqlstate like '40%' then\n          raise;"), handler.index("why_code := case"))
        cancel = self.b["cancel_workflow_run"].split("exception when others then", 1)[1]
        self.assertLess(cancel.index("if sqlstate like '40%' then"), cancel.index("null;"))

    def test_advance_and_cancel_take_the_account_before_the_run(self):
        a = self.b["advance_workflow_run"]
        self.assertLess(a.index("perform public.credit_account_lock(r.org_id);"),
                        a.index("perform public.workflow_advance_locked(p_run);"))
        # ... and after every permission check: a stranger cannot take another org's lock.
        self.assertLess(a.rindex("raise exception 'forbidden'"), a.index("credit_account_lock"))
        c = self.b["cancel_workflow_run"]
        self.assertLess(c.index("perform public.credit_account_lock(r.org_id);"),
                        c.index("where id = p_run for update"))
        self.assertLess(c.rindex("raise exception 'forbidden'"), c.index("credit_account_lock"))

    def test_a_later_step_needs_a_confirmer_who_may_still_spend(self):
        adv = self.b["workflow_advance_locked"]
        self.assertIn("if why_code is null and s.step_index > 0\n"
                      "       and not public.workflow_confirmer_may_spend(r.started_by, r.org_id) then", adv)
        self.assertIn("why_code := 'confirmation_revoked';", adv)
        # Checked before anything is created for the step.
        self.assertLess(adv.index("confirmation_revoked"), adv.index("public.create_creative_job("))
        helper = self.b["workflow_confirmer_may_spend"]
        self.assertIn("p_user is not null and p_org is not null", helper)
        self.assertIn("m.org_id = p_org and m.user_id = p_user", helper)
        self.assertIn(">= public.app_role_rank('editor')", helper)
        self.assertIn("u.email_confirmed_at is not null", helper)
        self.assertIn("when public.credits_exempt(p_org) then", helper)
        self.assertNotIn("auth.uid()", helper)


class Privileges(unittest.TestCase):
    def test_every_definer_function_pins_its_search_path(self):
        for name, body in bodies(SQL).items():
            self.assertIn("security definer set search_path = public, pg_temp as $$", body, name)

    def test_grants_are_explicit(self):
        self.assertIn("revoke all on function public.workflow_confirmer_may_spend(uuid, uuid) "
                      "from public, anon, authenticated, service_role;", SQL)
        self.assertIn("revoke all on function public.workflow_advance_locked(uuid, boolean) "
                      "from public, anon, authenticated, service_role;", SQL)
        for fn in ("advance_workflow_run(uuid)", "cancel_workflow_run(uuid)"):
            self.assertIn(f"revoke all on function public.{fn} from public, anon, authenticated, service_role;", SQL)
            self.assertIn(f"grant execute on function public.{fn} to authenticated;", SQL)
        self.assertEqual(len(re.findall(r"^grant ", SQL, re.M)), 2)

    def test_ends_with_a_verify_query(self):
        self.assertIn("-- Verify (run after applying; every column should read true)", SQL)
        self.assertIn("as search_path_pinned;", SQL.rstrip().splitlines()[-1])


if __name__ == "__main__":
    unittest.main()
