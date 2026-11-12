"""supabase/migrations/0138_operator_customers.sql — the operator's Customers page.

SQL does not run in this suite (tests/security/test_sec_operator_customers.py does that, against a real Postgres); these pin
what must never change by accident: each function is a stable SECURITY DEFINER with a pinned search_path, refuses everyone
but a platform admin BEFORE it reads anything or looks at an argument, only signed-in sessions may execute it (not anon, not
the service role), the money rules (a hold is never a spend, another currency is never dollars, the operator's own
workspace is in nothing), and that the drift guard, the end state and the rollback name the same bodies.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0138_operator_customers.sql").read_text()
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0138_operator_customers.sql").read_text()
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())
SIGS = {
    "operator_customer_totals": "public.operator_customer_totals()",
    "operator_customer_daily": "public.operator_customer_daily(integer)",
    "operator_customer_accounts": "public.operator_customer_accounts(text, text, integer, integer)",
}


def body(name: str) -> str:
    return CODE.split(f"create or replace function public.{name}(", 1)[1].split("\n$$;", 1)[0]


def pins(text: str) -> dict:
    return {sig: h for sig, h in re.findall(r"\['(public\.operator_customer_\w+\([^)]*\))', '([0-9a-f]{32})'\]", text)}


class OperatorCustomersMigration(unittest.TestCase):
    def test_three_functions_and_nothing_else(self):
        self.assertEqual(sorted(re.findall(r"create or replace function public\.(\w+)\(", CODE)), sorted(SIGS))
        self.assertNotRegex(CODE, r"create table|alter table|create (unique )?index|drop |create (or replace )?view|create policy|create trigger")

    def test_each_is_a_stable_definer_with_a_pinned_search_path(self):
        for name in SIGS:
            head = body(name).split("as $$", 1)[0]
            self.assertIn("language plpgsql stable security definer set search_path = public, pg_temp", head, name)

    def test_read_only(self):
        for name in SIGS:
            low = body(name).lower()
            for verb in ("insert into", "update public", "delete from", "truncate", "perform ", "grant_credits", "set_config"):
                self.assertNotIn(verb, low, (name, verb))

    def test_refuses_non_operators_before_reading_or_checking_anything(self):
        check = "if auth.uid() is null or not public.is_platform_admin() then\n    raise exception 'not available' using errcode = '42501';"
        for name in SIGS:
            # The body after "begin": the signature names every argument, so the order is read inside the body only.
            inside = body(name).split("\nbegin\n", 1)[1]
            self.assertIn(check, inside, name)
            reads = [i for i in (inside.find("public.credit_transactions"), inside.find("auth.users"), inside.find("public.organizations"),
                                 inside.find("p_days"), inside.find("p_sort"), inside.find("p_limit"), inside.find("p_search")) if i >= 0]
            self.assertTrue(reads, name)
            self.assertLess(inside.index(check), min(reads), name)

    def test_the_refusal_names_nothing(self):
        for msg in re.findall(r"raise exception '([^']*)' using errcode = '42501'", CODE):
            self.assertEqual(msg, "not available")

    def test_execute_is_closed_then_opened_to_signed_in_sessions_only(self):
        for sig in SIGS.values():
            self.assertIn(f"revoke all on function {sig} from public, anon, authenticated, service_role;", CODE)
            grants = re.findall(rf"grant execute on function {re.escape(sig)} to ([a-z_, ]+);", CODE)
            self.assertEqual(grants, ["authenticated"], sig)

    def test_a_hold_is_never_a_spend(self):
        for name in SIGS:
            b = body(name)
            self.assertNotIn("'reserve'", b, name)
            self.assertNotIn("'release'", b, name)
            self.assertNotIn("credit_reservations", b, name)
        self.assertIn("case when t.kind = 'capture' then -t.amount\n                when t.kind = 'refund' and t.amount > 0 then -t.amount", body("operator_customer_totals"))
        self.assertIn("(t.kind = 'capture' or (t.kind = 'refund' and t.amount > 0))", body("operator_customer_daily"))

    def test_money_in_another_currency_is_never_dollars(self):
        for name in ("operator_customer_totals", "operator_customer_accounts"):
            b = body(name)
            self.assertIn("e.event_type = 'transaction.completed'", b)
            self.assertIn("distinct on (e.transaction_id)", b)
            self.assertRegex(b, r"currency = 'USD'")
            self.assertRegex(b, r"currency is distinct from 'USD'")

    def test_the_operators_own_workspace_is_left_out(self):
        for name in SIGS:
            b = body(name)
            self.assertIn("v_internal := public.default_org_id();", b)
            self.assertIn("is distinct from v_internal", b)

    def test_bounds(self):
        self.assertIn("p_days < 1 or p_days > 90", body("operator_customer_daily"))
        acc = body("operator_customer_accounts")
        self.assertIn("p_limit < 1 or p_limit > 100", acc)
        self.assertIn("char_length(p_search) > 200", acc)
        # plain text, never a pattern the caller could widen
        self.assertNotRegex(acc.lower(), r"\bi?like\b|~\*|similar to")
        self.assertIn("strpos(", acc)

    def test_the_plan_is_org_plan_internals_rule(self):
        acc = body("operator_customer_accounts")
        self.assertIn("s.status in ('active', 'trialing', 'past_due')", acc)
        self.assertIn("order by pl.sort_order desc, s.id desc", acc)
        self.assertIn("where pl.is_default", acc)

    def test_guard_end_state_and_rollback_pin_the_same_bodies(self):
        self.assertEqual(SQL.count("['public.operator_customer_totals()'"), 2)
        guard = pins(SQL.split("-- 1. The headline numbers", 1)[0])
        end = pins(SQL.split("-- 5. End state", 1)[1])
        self.assertEqual(set(guard), set(SIGS.values()))
        self.assertEqual(guard, end)
        self.assertEqual(pins(ROLLBACK), end)
        self.assertIn("set local lock_timeout = '5s';", SQL)

    def test_the_rollback_drops_exactly_these_functions(self):
        drops = re.findall(r"drop function if exists (public\.\w+\([^)]*\));", ROLLBACK)
        self.assertEqual(sorted(drops), sorted(SIGS.values()))
        self.assertNotRegex(ROLLBACK, r"drop table|delete from|truncate")


if __name__ == "__main__":
    unittest.main()
