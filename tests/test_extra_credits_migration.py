"""supabase/migrations/0094_extra_credits_toggle.sql — the extra-credits switch.

The behaviour runs against a real Postgres in
tests/security/test_sec_extra_credits.py (including a differential run against
a database built without 0094). This pins, without a database, what must not
change by accident:

* the two functions it replaces are built on their LATEST bodies — 0020's
  reserve_credits and 0034's credit_lots_hold_locked, neither redefined since —
  and keep every line and every string literal of them (an earlier check is
  never dropped); only the lines this change adds are new;
* the switch defaults ON and is a NOT NULL column, so nobody is switched off by
  the migration;
* every function is a definer with a pinned search_path and explicit grants:
  the person's two functions reach only `authenticated`, the internal helper
  and the hold reach nobody;
* the refusal keeps the code NS402 and the order of its figures, so every caller
  that parses "available=… needed=…" (the app, the public API, MCP OAuth) still can.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "supabase" / "migrations"
SQL = (MIGRATIONS / "0094_extra_credits_toggle.sql").read_text()


def bodies(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$;\n", text, re.S)}


def literals(sql):
    code = re.sub(r"--[^\n]*", "", sql)
    return set(re.findall(r"'(?:[^']|'')*'", code))


def code_lines(body):
    out = []
    for line in body.splitlines():
        code = line.split("--", 1)[0].rstrip()
        if code.strip():
            out.append(code)
    return out


def latest_other(name):
    found = None
    for path in sorted(MIGRATIONS.glob("*.sql")):
        if int(path.name[:4]) >= 94:
            continue
        b = bodies(path.read_text())
        if name in b:
            found = (path.name, b[name])
    if found is None:
        raise AssertionError(name)
    return found


NEW = bodies(SQL)
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())


class BuiltOnTheLatestBodies(unittest.TestCase):
    def test_it_defines_exactly_these_functions(self):
        self.assertEqual(
            set(NEW),
            {"credit_spendable_internal", "reserve_credits", "credit_lots_hold_locked", "set_use_extra_credits", "usage_summary"},
        )

    def test_the_latest_other_bodies_are_0020s_and_0034s(self):
        self.assertEqual(latest_other("reserve_credits")[0], "0020_credits.sql")
        self.assertEqual(latest_other("credit_lots_hold_locked")[0], "0034_plans_entitlements.sql")

    def test_every_string_literal_of_the_latest_bodies_is_kept(self):
        for name in ("reserve_credits", "credit_lots_hold_locked"):
            src, old = latest_other(name)
            for lit in literals(old):
                self.assertIn(lit, NEW[name], f"{name} lost {lit} from {src}")

    def test_every_code_line_of_the_latest_bodies_is_kept_in_order(self):
        for name in ("reserve_credits", "credit_lots_hold_locked"):
            _, old = latest_other(name)
            new_lines = code_lines(NEW[name])
            cursor = 0
            for line in code_lines(old):
                # The declarations gain one variable, and the lot filter gains one condition: those two
                # lines are compared after the addition is taken out.
                try:
                    cursor = new_lines.index(line, cursor) + 1
                except ValueError:
                    self.fail(f"{name} changed or lost a line of the latest body: {line!r}")

    def test_what_is_added_to_reserve_credits_is_one_block_after_the_total_check(self):
        _, old = latest_other("reserve_credits")
        old_lines, new_lines = set(code_lines(old)), code_lines(NEW["reserve_credits"])
        added = [l.strip() for l in new_lines if l not in old_lines]
        self.assertEqual(
            added,
            [
                "spend_  numeric;",
                "if not acc.use_extra_credits then",
                "spend_ := public.credit_spendable_internal(p_org);",
                "if spend_ < amt then",
                "raise exception 'insufficient credits'",
                "using errcode = 'NS402',",
                "detail = format('available=%s needed=%s extra_off=1 extra=%s', spend_, amt, greatest(avail - spend_, 0)),",
                "hint = 'Extra credits are off for this organization. Turn them on, add credits, or upgrade the plan.';",
                "end if;",  # the inner one: the outer `end if;` is a line the latest body already has
            ],
        )
        # ...and it sits after the ordinary shortfall check and before the hold is written.
        body = NEW["reserve_credits"]
        self.assertLess(body.index("avail < amt"), body.index("not acc.use_extra_credits"))
        self.assertLess(body.index("not acc.use_extra_credits"), body.index("insert into public.credit_reservations"))

    def test_what_is_added_to_the_hold_is_one_variable_one_read_and_one_condition(self):
        _, old = latest_other("credit_lots_hold_locked")
        old_lines, new_lines = set(code_lines(old)), code_lines(NEW["credit_lots_hold_locked"])
        added = [l.strip() for l in new_lines if l not in old_lines]
        self.assertEqual(
            added,
            [
                "extra_ boolean;",
                "select a.use_extra_credits into extra_ from public.credit_accounts a where a.org_id = p_org;",
                "extra_ := coalesce(extra_, true);",
                "and (extra_ or source <> 'pack')",
            ],
        )

    def test_the_spend_order_is_the_documented_one(self):
        self.assertIn("order by (source <> 'subscription'), expires_at asc nulls last, id", NEW["credit_lots_hold_locked"])


class TheSwitch(unittest.TestCase):
    def test_it_defaults_on_and_cannot_be_null(self):
        self.assertIn("add column if not exists use_extra_credits boolean not null default true", CODE)

    def test_the_refusal_keeps_the_ns402_code_and_the_figure_order(self):
        self.assertIn("available=%s needed=%s extra_off=1 extra=%s", CODE)
        self.assertEqual(CODE.count("errcode = 'NS402'"), 3)

    def test_pack_is_the_only_extra_source(self):
        self.assertIn("l.source <> 'pack'", NEW["credit_spendable_internal"])
        for name in ("credit_spendable_internal", "credit_lots_hold_locked"):
            self.assertNotRegex(NEW[name], r"source (not )?in \(", name)
        self.assertNotIn("'subscription'", NEW["credit_spendable_internal"])

    def test_the_person_is_checked_by_account_not_by_invitation_or_role_of_the_platform(self):
        body = NEW["set_use_extra_credits"]
        self.assertIn("auth.uid()", body)
        self.assertIn("m.user_id = me", body)
        self.assertIn("m.role in ('owner', 'admin')", body)
        self.assertNotIn("is_platform_admin", body)
        self.assertNotIn("credits_trusted_caller", body)
        # Account lock before the write, like every money function.
        self.assertLess(body.index("credit_account_lock"), body.index("update public.credit_accounts"))

    def test_the_summary_reads_live_lots_only_and_exposes_no_money_internals(self):
        body = NEW["usage_summary"]
        self.assertIn("billing_may_read(p_org)", body)
        self.assertIn("(expires_at is null or expires_at > now())", body)
        for banned in ("margin", "credit_prices", "external_id", "provider_", "note", "created_txn"):
            self.assertNotIn(banned, body, banned)


class Privileges(unittest.TestCase):
    def test_every_function_is_a_definer_with_a_pinned_search_path(self):
        for name, body in NEW.items():
            self.assertIn("security definer set search_path = public, pg_temp", body, name)

    def test_grants(self):
        def grants():
            return sorted(re.findall(r"grant execute on function public\.(\w+)\(.*?\) to ([a-z_, ]+);", CODE))

        self.assertEqual(
            grants(),
            [
                ("reserve_credits", "authenticated, service_role"),
                ("set_use_extra_credits", "authenticated"),
                ("usage_summary", "authenticated, service_role"),
            ],
        )
        self.assertIn("revoke all on function public.credit_spendable_internal(uuid) from public, anon, authenticated, service_role;", CODE)
        self.assertIn("revoke all on function public.credit_lots_hold_locked(uuid, text, numeric, bigint) from public, anon, authenticated, service_role;", CODE)
        self.assertIn("revoke all on function public.set_use_extra_credits(uuid, boolean) from public, anon, service_role;", CODE)
        self.assertIn("revoke all on function public.usage_summary(uuid) from public, anon;", CODE)

    def test_no_table_policy_or_grant_is_added_and_nothing_is_dropped(self):
        self.assertNotRegex(CODE, r"create policy|grant (select|insert|update|delete|all) on|drop (table|function|column)")
        self.assertNotRegex(CODE, r"\balter table .* (drop|disable)\b")


if __name__ == "__main__":
    unittest.main()
