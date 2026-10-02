"""supabase/migrations/0073_workflow_apps.sql — workflow apps, the database half.

SQL does not run in this suite, so these pin what matters (the security lab,
tests/security/test_sec_workflows.py, runs the attacks against a real
Postgres 16): nothing earlier is replaced, no API role writes a table
directly, every definer function pins its search_path and has explicit
grants, a run is created through the ordinary creative job with the step's own
confirmed price as its cap, and nothing in the file publishes."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0073_workflow_apps.sql").read_text()
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())

USER_FUNCTIONS = ["save_workflow", "delete_workflow", "quote_workflow", "start_workflow_run",
                  "advance_workflow_run", "cancel_workflow_run"]
INTERNAL = ["workflow_makes_picture", "workflow_takes_picture", "workflow_definition_problem",
            "workflow_bind_inputs", "workflow_fill_params", "workflow_quote_steps", "workflow_run_json",
            "workflow_advance_locked"]


def fn_body(name):
    return CODE.split(f"function public.{name}(", 1)[1].split("\n$$;", 1)[0]


class WorkflowMigration(unittest.TestCase):
    def test_replaces_no_earlier_function(self):
        # Every creative function is called as it stands: nothing to pin from 0036-0055.
        names = re.findall(r"create or replace function public\.(\w+)\(", CODE)
        self.assertEqual(sorted(names), sorted(USER_FUNCTIONS + INTERNAL))
        self.assertNotRegex(CODE, r"\bdrop (table|column|function)\b")
        self.assertNotRegex(CODE, r"\balter table public\.(?!workflows\b|workflow_runs\b|workflow_run_steps\b)")

    def test_three_tables_rls_on_and_no_direct_writes(self):
        for t in ("workflows", "workflow_runs", "workflow_run_steps"):
            self.assertIn(f"create table if not exists public.{t}", CODE)
            self.assertIn(f"alter table public.{t} enable row level security;", CODE)
        self.assertIn("revoke all on public.workflows, public.workflow_runs, public.workflow_run_steps\n"
                      "  from public, anon, authenticated, service_role;", CODE)
        self.assertIn("grant select on public.workflows, public.workflow_runs, public.workflow_run_steps\n"
                      "  to authenticated, service_role;", CODE)
        self.assertNotRegex(CODE, r"grant [^;]*\b(insert|update|delete|all)\b[^;]* to ")
        self.assertEqual(re.findall(r"create policy \w+ on public\.\w+\s+for (\w+)", CODE), ["select"] * 3)
        self.assertEqual(len(re.findall(r"using \(org_id in \(select public\.accessible_org_ids\('viewer'\)\)\);", CODE)), 3)

    def test_a_step_belongs_to_the_runs_organization_and_one_job_pays_for_one_step(self):
        self.assertIn("foreign key (run_id, org_id) references public.workflow_runs (id, org_id)", CODE)
        self.assertIn("foreign key (workflow_id, org_id) references public.workflows (id, org_id)", CODE)
        self.assertIn("create unique index if not exists workflow_run_steps_job_key", CODE)
        # A step that has not started has no job; one that has, has exactly one.
        self.assertIn("(status in ('pending', 'skipped') and job_id is null)", CODE)
        self.assertIn("(status in ('running', 'completed') and job_id is not null)", CODE)

    def test_a_workflow_has_two_to_six_steps(self):
        self.assertIn("jsonb_array_length(steps) between 2 and 6", CODE)
        self.assertIn("jsonb_array_length(p_steps) not between 2 and 6", CODE)

    def test_every_definer_function_pins_its_search_path(self):
        for name in USER_FUNCTIONS + INTERNAL:
            head = CODE.split(f"function public.{name}(", 1)[1].split("$$", 1)[0]
            if "security definer" in head:
                self.assertIn("set search_path = public, pg_temp", head, name)
        self.assertEqual(len(re.findall(r"security definer", CODE)), len(
            [n for n in USER_FUNCTIONS + INTERNAL if "security definer" in CODE.split(f"function public.{n}(", 1)[1].split("$$", 1)[0]]))

    def test_grants_are_explicit_members_only_and_helpers_for_nobody(self):
        for name in USER_FUNCTIONS + INTERNAL:
            self.assertRegex(CODE, rf"revoke all on function public\.{name}\([^)]*\) from public, anon, authenticated, service_role;")
        granted = re.findall(r"grant execute on function public\.(\w+)\([^)]*\) to ([a-z_, ]+);", CODE)
        self.assertEqual(sorted(g[0] for g in granted), sorted(USER_FUNCTIONS))
        self.assertTrue(all(g[1] == "authenticated" for g in granted))
        self.assertNotRegex(CODE, r"\bto anon\b")

    def test_who_may_act(self):
        # Reading a price is any member's; saving, running, advancing and cancelling is the member who may edit.
        for name in ("save_workflow", "delete_workflow", "start_workflow_run", "advance_workflow_run", "cancel_workflow_run"):
            self.assertIn("is_org_member(", fn_body(name))
            self.assertIn("'editor'", fn_body(name), name)
        self.assertNotIn("'editor'", fn_body("quote_workflow"))
        for name in USER_FUNCTIONS:
            self.assertIn("auth.uid()", fn_body(name), name)
            # Another organization's id reads as missing, never as forbidden.
            self.assertIn("'not_found' using errcode = 'P0002'", fn_body(name), name)

    def test_the_total_is_priced_by_creative_price_and_unpriced_is_never_zero(self):
        q = fn_body("workflow_quote_steps")
        self.assertIn("public.creative_price(p_wf.org_id, st.v ->> 'capability', st.v ->> 'model', params)", q)
        self.assertIn("'total', case when cardinality(bad) = 0 then total end", q)
        self.assertIn("'priced', false, 'credits', null", q)
        s = fn_body("start_workflow_run")
        self.assertIn("if not (q ->> 'priced')::boolean then", s)
        self.assertIn("perform public.creative_refuse('unpriced',", s)
        self.assertIn("if round(p_max_credits, 2) <> round(total, 2) then", s)
        self.assertIn("perform public.creative_refuse('price_changed',", s)
        self.assertIn("if p_max_credits is null or p_max_credits < 0 then", s)
        self.assertIn("perform public.creative_refuse('workflow_changed',", s)

    def test_each_step_is_an_ordinary_creative_job_capped_at_its_confirmed_price(self):
        a = fn_body("workflow_advance_locked")
        self.assertIn("public.create_creative_job(\n          r.org_id, s.capability, s.model, params, 'exact',\n"
                      "          'wf:' || r.id::text || ':' || s.step_index::text, s.quoted_credits)", a)
        self.assertIn("if committed + s.quoted_credits > r.max_credits then", a)
        self.assertIn("r.created_at < now() - interval '24 hours'", a)
        # No hold is taken here: only create_creative_job holds, and only for the step that starts.
        self.assertNotRegex(CODE, r"reserve_credits|capture_credits|release_credits|credit_reservations")
        # Later steps are skipped, never created.
        self.assertIn("update public.workflow_run_steps set status = 'skipped'", a)

    def test_run_is_replay_safe(self):
        s = fn_body("start_workflow_run")
        self.assertIn("perform public.credit_account_lock(w.org_id);", s)
        self.assertIn("select * into prior from public.workflow_runs where id = p_run;", s)
        self.assertIn("if prior.org_id <> w.org_id or prior.request_hash is distinct from hash_ then", s)
        self.assertIn("perform public.creative_refuse('idempotency_conflict',", s)
        # The replay is answered before the workflow's version is compared.
        self.assertLess(s.index("select * into prior"), s.index("workflow_changed"))

    def test_the_whole_total_must_be_available_before_the_first_hold(self):
        s = fn_body("start_workflow_run")
        self.assertIn("perform public.creative_refuse('insufficient_credits',", s)
        self.assertLess(s.index("insufficient_credits"), s.index("insert into public.workflow_runs"))
        self.assertIn("'NS402'", s)

    def test_nothing_in_it_publishes(self):
        self.assertNotRegex(CODE.lower(), r"publish|youtube|social_accounts")

    def test_has_a_verify_query_as_the_last_comment(self):
        tail = SQL.rstrip().splitlines()[-12:]
        self.assertTrue(all(line.startswith("--") for line in tail))
        self.assertIn("-- Verify", SQL)
        self.assertIn("search_path_pinned", SQL)


if __name__ == "__main__":
    unittest.main()
