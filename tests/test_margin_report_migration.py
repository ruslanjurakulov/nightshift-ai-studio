"""supabase/migrations/0063_margin_report.sql — the operator's margin report.

SQL does not run in this suite (tests/security does that, against a real
Postgres); these pin what must never change by accident: the function is
SECURITY DEFINER with a pinned search_path, it refuses everyone but a platform
admin BEFORE it reads anything, only signed-in sessions may execute it (not
anon, not the service role), and the money rules — unknown is NULL, failed jobs
add no revenue, sell prices are never read as a cost.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0063_margin_report.sql").read_text()
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())
SIG = "public.operator_margin_report(date, date)"
BODY = CODE.split("create or replace function public.operator_margin_report(", 1)[1].split("\n$$;", 1)[0]


class MarginReportMigration(unittest.TestCase):
    def test_security_definer_with_a_pinned_search_path(self):
        head = BODY.split("as $$", 1)[0]
        self.assertIn("security definer", head)
        self.assertIn("set search_path = public, pg_temp", head)

    def test_read_only(self):
        self.assertIn("stable", BODY.split("as $$", 1)[0])
        for verb in ("insert into", "update public", "delete from", "truncate"):
            self.assertNotIn(verb, BODY.lower(), verb)

    def test_refuses_non_operators_before_reading_anything(self):
        check = "if not public.is_platform_admin() then"
        self.assertIn(check, BODY)
        first_read = min(BODY.index(t) for t in ("public.creative_jobs", "public.creative_job_costs",
                                                   "public.payment_events", "public.credit_lot"))
        self.assertLess(BODY.index(check), first_read)
        self.assertRegex(BODY, r"raise exception 'platform admin only' using errcode = '42501'")

    def test_range_is_bounded(self):
        self.assertIn("d_to - d_from > 365", BODY)
        self.assertIn("errcode = '22023'", BODY)

    def test_execute_is_closed_then_opened_to_signed_in_sessions_only(self):
        self.assertIn(f"revoke all on function {SIG} from public, anon, authenticated, service_role;", CODE)
        grants = re.findall(r"grant execute on function public\.operator_margin_report\(date, date\) to ([a-z_, ]+);", CODE)
        self.assertEqual(grants, ["authenticated"])

    def test_adds_no_table_and_changes_nothing_that_exists(self):
        self.assertNotRegex(CODE, r"create table|alter table|drop |create (or replace )?view")
        self.assertEqual(len(re.findall(r"create or replace function", CODE)), 1)

    def test_sell_prices_are_never_read_as_a_provider_cost(self):
        self.assertNotIn("api_prices", BODY)
        self.assertNotIn("credit_prices", BODY)
        self.assertIn("creative_job_costs", BODY)

    def test_unknown_is_null_never_zero(self):
        self.assertIn("count(*) filter (where c.usd_estimate is null)", BODY)
        self.assertRegex(BODY, r"case when a\.uncosted > 0 then null else a\.cost_sold end")
        self.assertRegex(BODY, r"case when a\.released_uncosted > 0 then null else a\.cost_released end")
        self.assertRegex(BODY, r"case when a\.jobs_api > 0 or a\.credits_unvalued > 0\.005 then null else a\.paid_usd end")
        # a job that began a billable call and recorded no cost is unknown
        self.assertIn("coalesce(cost.n, 0) > 0 or jobs.submit_started_at is null", BODY)
        # no percentage of nothing
        self.assertIn("c.rev <= 0 then null", BODY)

    def test_only_completed_jobs_earn_and_only_usd_payments_value_a_credit(self):
        self.assertIn("(jobs.status = 'completed' and not jobs.internal) as is_sold", BODY)
        self.assertIn("e.currency = 'USD'", BODY)
        self.assertIn("e.event_type = 'transaction.completed'", BODY)
        self.assertIn("abs(l.amount - p.credits) < 0.005", BODY)
        self.assertIn("from public.credit_refunds r", BODY)
        # only a grant lot is known-free; an adjustment lot may have been bought
        self.assertIn("v.source = 'grant'", BODY)
        self.assertNotIn("'adjustment'", BODY)

    def test_the_operators_own_organization_is_left_out_of_revenue_and_cost(self):
        self.assertIn("public.default_org_id()", BODY)
        self.assertIn("count(*) filter (where pj.internal) as jobs_internal", BODY)

    def test_still_running_jobs_are_not_counted(self):
        self.assertIn("j.status in ('completed', 'failed', 'cancelled', 'expired')", BODY)

    def test_the_migration_documents_its_requirements_and_ends_with_a_verify_query(self):
        requires = SQL.split("REQUIRES", 1)[1].split("do $$", 1)[0]
        for n in ("0018", "0021", "0034", "0036", "0037"):
            self.assertIn(n, requires)
        tail = SQL.rsplit("-- Verify", 1)[1]
        self.assertIn("operator_margin_report(date,date)", tail)
        self.assertIn("security_definer", tail)
        self.assertIn("search_path_pinned", tail)


if __name__ == "__main__":
    unittest.main()
