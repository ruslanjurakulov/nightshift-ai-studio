"""Migration 0107 (owner safety) ships DORMANT and ADDITIVE. These are the checks that need no database:
they read the file and fail if it ever touches an existing policy, grant, trigger or function, if a
function loses its pinned search_path, if the gate flag defaults to on, or if the audit list loses a
name. The behaviour itself (caps, idempotency, the gate's decision table, the last-owner guard, the
append-only trail, the rollback) is attacked in tests/security/test_sec_owner_safety.py.
"""

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SQL = (REPO / "supabase" / "migrations" / "0107_owner_safety.sql").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())

NEW_TABLES = {"owner_security_settings", "security_events", "credit_price_history"}
NEW_FUNCTIONS = {
    "owner_err", "owner_security_append_only", "owner_security_settings_no_delete", "owner_security_settings_stamp",
    "security_event_log", "owner_audit", "admin_mfa_state", "admin_aal_ok", "owner_guard", "owner_admin_factors",
    "owner_security_get", "enable_admin_mfa", "disable_admin_mfa", "owner_security_events", "owner_grant_credits",
    "owner_reverse_grant", "owner_price_write", "owner_set_credit_price", "owner_delete_credit_price",
    "owner_restore_credit_price", "owner_add_member", "owner_set_member_role", "owner_remove_member",
    "app_members_security_trail", "credit_prices_security_trail", "owner_security_settings_trail",
}
PERMITTED_REDEFINITION = {"audit_action_allowed"}
SEVEN = {"credits.grant", "credits.reverse", "credits.price", "member.add", "member.role", "member.remove", "security.gate"}


def audit_list(text):
    block = re.search(r"create or replace function public\.audit_action_allowed.*?any \(array\[(.*?)\]::text\[\]\)", text, re.S).group(1)
    return set(re.findall(r"'([a-z_.]+)'", block))


class OwnerSafetyMigration(unittest.TestCase):
    def test_the_only_existing_function_it_redefines_is_the_audit_list(self):
        defined = set(re.findall(r"create or replace function public\.(\w+)", CODE))
        self.assertEqual(defined, NEW_FUNCTIONS | PERMITTED_REDEFINITION)
        for name in ("platform_role", "is_platform_admin", "accessible_org_ids", "current_app_role", "grant_credits",
                     "credit_account_lock", "credit_log", "take_web_rate", "bind_current_member"):
            self.assertNotIn(name, defined)

    def test_it_creates_only_its_own_tables_and_touches_no_other(self):
        self.assertEqual(set(re.findall(r"create table if not exists public\.(\w+)", CODE)), NEW_TABLES)
        self.assertEqual(set(re.findall(r"alter table public\.(\w+)", CODE)), NEW_TABLES)
        # Top-level statements (column 0) never rewrite or remove existing data or objects.
        top = [m.group(0) for m in re.finditer(r"^(?:update|delete|truncate|drop|alter|insert|create|grant|revoke|comment|do)\b[^;]*", CODE, re.M)]
        for stmt in top:
            if re.match(r"drop (trigger|policy|constraint) if exists", stmt):
                self.assertRegex(stmt, r"on public\.(app_members|credit_prices|owner_security_settings|security_events|credit_price_history)\b", stmt)
            elif re.match(r"alter table public\.(\w+) drop constraint if exists", stmt):
                self.assertIn(re.match(r"alter table public\.(\w+)", stmt).group(1), NEW_TABLES, stmt)
            else:
                self.assertNotRegex(stmt, r"^(update|delete|truncate|drop)\b", stmt)
        self.assertIsNone(re.search(r"drop table|drop function|alter function|drop column|drop index|alter table [^;]* rename", CODE, re.I))

    def test_the_only_additions_to_existing_tables_are_triggers_and_one_partial_index(self):
        indexes = re.findall(r"create (?:unique )?index if not exists (\w+)\s+on public\.(\w+)", CODE)
        existing = [i for i in indexes if i[1] not in NEW_TABLES]
        self.assertEqual(existing, [("credit_transactions_grant_created_idx", "credit_transactions")])
        self.assertIn("where kind = 'grant'", CODE)
        # a lock that cannot be had fails the file instead of stalling writers; local to the file's transaction
        self.assertRegex(CODE, r"(?m)^set local lock_timeout = '5s';")
        self.assertNotRegex(CODE, r"(?m)^set (?!local)")

    def test_the_only_policy_it_creates_is_the_read_of_the_new_history_table(self):
        policies = re.findall(r"(create|drop|alter) policy (?:if exists )?(\w+) on public\.(\w+)", CODE)
        self.assertEqual({(p[1], p[2]) for p in policies}, {("credit_price_history_select", "credit_price_history")})

    def test_the_triggers_on_existing_tables_are_after_row_loggers_that_cannot_block(self):
        triggers = re.findall(r"create trigger (\w+)\s+(before|after) ([a-z ]+?)\s+on public\.(\w+)", CODE)
        by_table = {}
        for name, when, ops, table in triggers:
            by_table.setdefault(table, []).append((name, when, ops.strip()))
        self.assertEqual(by_table["app_members"], [("app_members_security_trail", "after", "insert or update or delete")])
        self.assertEqual(by_table["credit_prices"], [("credit_prices_security_trail", "after", "insert or update or delete")])
        # every logging trigger swallows a logging failure
        for fn in ("app_members_security_trail", "credit_prices_security_trail", "owner_security_settings_trail"):
            body = re.search(rf"create or replace function public\.{fn}\(\).*?\n\$\$;", CODE, re.S).group(0)
            self.assertIn("exception when others then", body, fn)
            self.assertIn("raise warning", body, fn)
        self.assertEqual(set(by_table), {"app_members", "credit_prices"} | NEW_TABLES)

    def test_grants_name_only_new_objects_and_never_anon(self):
        for m in re.finditer(r"^(grant|revoke)\s+(.*?)\s+on\s+(?:function|sequence|table)?\s*public\.(\w+)", CODE, re.M | re.S):
            obj = m.group(3)
            self.assertTrue(obj in NEW_TABLES | NEW_FUNCTIONS | PERMITTED_REDEFINITION or obj.endswith("_id_seq"), m.group(0)[:80])
        for m in re.finditer(r"^grant\s.*?;", CODE, re.M | re.S):
            self.assertNotRegex(m.group(0), r"\banon\b|\bpublic\b\s*[;,]|\bto\s+public\b", m.group(0))

    def test_every_function_pins_its_search_path_with_pg_temp_last(self):
        for m in re.finditer(r"create or replace function public\.(\w+)\((.*?)\n(?:\$\$|  language)", CODE, re.S):
            pass
        headers = re.findall(r"create or replace function public\.(\w+)\(.*?(?=\n\$\$)", CODE, re.S)
        self.assertEqual(set(headers), NEW_FUNCTIONS | PERMITTED_REDEFINITION)
        for block in re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$", CODE, re.S):
            self.assertIn("set search_path = public, pg_temp", block.group(0), block.group(1))
        definers = re.findall(r"create or replace function public\.(\w+)\([^$]*?security definer", CODE, re.S)
        self.assertGreaterEqual(len(definers), 18, definers)

    def test_nothing_is_switched_on_by_default(self):
        self.assertRegex(CODE, r"admin_aal2_required\s+boolean not null default false")
        self.assertRegex(CODE, r"insert into public\.owner_security_settings \(id\) values \(true\) on conflict \(id\) do nothing")
        # no top-level statement flips the flag (only enable_admin_mfa does, inside its function)
        self.assertNotRegex(CODE, r"(?m)^update public\.owner_security_settings")
        # the numbers the owner chose / the documented defaults
        self.assertRegex(CODE, r"recent_mfa_minutes\s+integer not null default 480")
        self.assertRegex(CODE, r"grant_max_per_call\s+bigint\s+not null default 100000\b")
        self.assertRegex(CODE, r"grant_max_per_24h\s+bigint\s+not null default 500000\b")
        self.assertRegex(CODE, r"price_max_change_ratio\s+numeric not null default 3\b")

    def test_every_function_that_acts_for_the_owner_checks_the_caller_first(self):
        for fn in ("owner_security_get", "owner_security_events", "enable_admin_mfa", "disable_admin_mfa"):
            body = re.search(rf"create or replace function public\.{fn}\(.*?\n\$\$;", CODE, re.S).group(0)
            self.assertIn("auth.uid() is null or not public.is_platform_admin()", body, fn)
            self.assertIn("errcode = '42501'", body, fn)
        for fn in ("owner_grant_credits", "owner_reverse_grant", "owner_set_credit_price", "owner_delete_credit_price",
                   "owner_restore_credit_price", "owner_add_member", "owner_set_member_role", "owner_remove_member"):
            body = re.search(rf"create or replace function public\.{fn}\(.*?\n\$\$;", CODE, re.S).group(0)
            self.assertRegex(body, r"g := public\.owner_guard\('\w+', \d+\);\s+if g is not null then return g; end if;", fn)
        guard = re.search(r"create or replace function public\.owner_guard\(.*?\n\$\$;", CODE, re.S).group(0)
        self.assertLess(guard.index("is_platform_admin()"), guard.index("admin_aal_ok()"))
        self.assertLess(guard.index("admin_aal_ok()"), guard.index("take_web_rate"))

    def test_the_audit_list_is_0093s_plus_exactly_seven_names(self):
        old = audit_list((REPO / "supabase" / "migrations" / "0093_mcp_oauth.sql").read_text(encoding="utf-8"))
        new = audit_list(SQL)
        self.assertEqual(new - old, SEVEN)
        self.assertTrue(old <= new)
        # the regex families are kept
        self.assertIn(r"'^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'", SQL)
        self.assertIn(r"'^learning\.(approve|reject)$'", SQL)

    def test_every_action_an_owner_function_audits_is_in_the_list(self):
        written = set(re.findall(r"owner_audit\('([a-z_.]+)'", CODE))
        self.assertTrue({"credits.grant", "credits.reverse", "credits.price", "member.add", "member.role", "member.remove",
                         "security.gate"} <= written, written)
        self.assertTrue(written <= audit_list(SQL), written - audit_list(SQL))

    def test_the_guards_name_only_what_the_first_forms_of_earlier_migrations_made(self):
        # tests/test_migration_prerequisites.py proves this against git history; here: the guard exists at all
        self.assertRegex(CODE, r"to_regprocedure\('public\.take_web_rate\(text, integer, integer\)'\) is null")
        self.assertRegex(CODE, r"to_regclass\('public\.credit_lots'\) is null")

    def test_the_rollback_file_exists_and_restores_the_old_audit_list(self):
        rollback = (REPO / "docs" / "sql" / "rollback_0107_owner_safety.sql").read_text(encoding="utf-8")
        old = audit_list((REPO / "supabase" / "migrations" / "0093_mcp_oauth.sql").read_text(encoding="utf-8"))
        self.assertEqual(audit_list(rollback), old)
        for table in NEW_TABLES:
            self.assertIn(f"drop table if exists public.{table};", rollback)
        self.assertIn("drop index if exists public.credit_transactions_grant_created_idx;", rollback)
        for fn in NEW_FUNCTIONS:
            self.assertRegex(rollback, rf"drop function if exists public\.{fn}\(")


if __name__ == "__main__":
    unittest.main()
