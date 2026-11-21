"""supabase/migrations/0096_user_handles.sql — a unique @username per person.

The behaviour runs in tests/security/test_sec_user_handles.py (a real
Postgres). This pins, without a database, what must not change by accident:
the table is closed to every write and open to its owner's SELECT only, every
function pins its search_path and has explicit grants (the signed-in ones to
authenticated alone, the signed-out check the only one anon may call), the
rules live in the table's CHECK too, the old handle is not hoarded, and
nothing earlier is dropped.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0096_user_handles.sql").read_text()
CODE = re.sub(r"--[^\n]*", "", SQL)


def function_bodies():
    return re.findall(r"create or replace function public\.(\w+)\((.*?)\$\$;", CODE, re.S)


class UserHandlesMigration(unittest.TestCase):
    def test_one_table_unique_case_insensitively_and_stored_lowercase(self):
        self.assertEqual(re.findall(r"create table if not exists public\.(\w+)", CODE), ["user_handles"])
        self.assertIn("user_id    uuid primary key references auth.users (id) on delete cascade", CODE)
        self.assertIn("create unique index if not exists user_handles_handle_lower_key on public.user_handles (lower(handle));", CODE)
        self.assertIn("check (handle = lower(handle))", CODE)
        self.assertIn("check (public.handle_valid(handle))", CODE)

    def test_rls_is_on_and_only_the_owner_may_select(self):
        self.assertIn("alter table public.user_handles enable row level security;", CODE)
        self.assertIn("revoke all on public.user_handles from public, anon, authenticated;", CODE)
        grants = re.findall(r"grant (\w+(?:, \w+)*) on public\.user_handles to ([a-z, ]+);", CODE)
        self.assertEqual(grants, [("select", "authenticated")])
        policies = re.findall(r"create policy (\w+) on public\.user_handles\s+for (\w+) to (\w+) using \((.*?)\);", CODE, re.S)
        self.assertEqual(policies, [("user_handles_select_own", "select", "authenticated", "user_id = (select auth.uid())")])

    def test_every_function_pins_its_search_path(self):
        funcs = function_bodies()
        self.assertEqual(
            sorted(n for n, _ in funcs),
            ["handle_available", "handle_available_public", "handle_format_ok", "handle_reserved", "handle_valid", "set_handle"],
        )
        for name, body in funcs:
            self.assertRegex(body, r"set search_path = (public, pg_temp|pg_catalog, pg_temp)", name)
        for name, body in funcs:
            if name in ("handle_available", "handle_available_public", "set_handle"):
                self.assertIn("security definer", body, name)

    def test_grants_are_explicit_and_narrow(self):
        granted = re.findall(r"grant execute on function public\.(\w+)\(.*?\) to ([a-z, ]+);", CODE)
        self.assertEqual(
            sorted(granted),
            sorted([("handle_available", "authenticated"), ("set_handle", "authenticated"), ("handle_available_public", "anon, authenticated")]),
        )
        for pure in ("handle_format_ok", "handle_reserved", "handle_valid"):
            self.assertIn(f"revoke all on function public.{pure}(text) from public, anon, authenticated, service_role;", CODE)
        for signed_in in ("handle_available", "set_handle"):
            self.assertIn(f"revoke all on function public.{signed_in}(text) from public, anon, service_role;", CODE)
        self.assertIn("revoke all on function public.handle_available_public(text) from public, service_role;", CODE)

    def test_availability_answers_a_boolean_and_never_an_owner(self):
        for name in ("handle_available", "handle_available_public"):
            self.assertIn(f"function public.{name}(p_handle text) returns boolean", CODE)
        bodies = dict(function_bodies())
        for name in ("handle_available", "handle_available_public"):
            self.assertNotIn("select user_id", bodies[name], name)
            self.assertIn("return not exists (select 1 from public.user_handles where lower(handle) = h);", bodies[name])

    def test_asking_is_rate_limited_for_both_callers(self):
        bodies = dict(function_bodies())
        self.assertIn("public.take_web_rate('handle.check', 60, 60)", bodies["handle_available"])
        self.assertIn("public.take_web_rate('handle.set', 10, 3600)", bodies["set_handle"])
        anon = bodies["handle_available_public"]
        self.assertIn("'handle.anon@60'", anon)
        self.assertIn("v_used > 300", anon)
        # a malformed or reserved handle is answered before anything is counted
        self.assertLess(anon.index("handle_valid(h)"), anon.index("insert into public.web_rate_counters"))

    def test_set_handle_is_race_safe_and_answers_codes_not_sql_errors(self):
        body = dict(function_bodies())["set_handle"]
        self.assertIn("pg_advisory_xact_lock(hashtextextended('user_handle:' || uid::text, 0))", body)
        self.assertIn("exception when unique_violation then", body)
        self.assertIn("jsonb_build_object('code', 'taken')", body)
        for code in ("ok", "same", "invalid", "cooldown", "rate_limited"):
            self.assertIn(f"'code', '{code}'", body)
        self.assertIn("interval '30 days'", body)
        # the first set does not start the clock
        self.assertIn("cur.changed_at > cur.created_at", body)
        # it acts for the caller alone: there is no user-id argument
        self.assertIn("function public.set_handle(p_handle text)", CODE)
        self.assertIn("uid  uuid := auth.uid();", body)

    def test_reserved_words_and_the_nightshift_prefix(self):
        body = dict(function_bodies())["handle_reserved"]
        for word in ("admin", "administrator", "root", "support", "help", "billing", "api", "mcp", "security",
                     "system", "staff", "moderator", "null", "undefined", "login", "signup"):
            self.assertIn(f"'{word}'", body, word)
        for word in ("ns", "nightshift", "ai", "bot", "verified", "claude", "official", "staff", "help"):
            self.assertIn(f"'{word}'", body, word)
        self.assertIn("like 'nightshift%'", body)
        # dots and underscores do not hide a reserved word
        self.assertIn("regexp_replace(p, '[._]', '', 'g')", body)

    def test_nothing_earlier_is_dropped_and_it_is_additive(self):
        self.assertNotRegex(CODE, r"(?i)\bdrop (table|column|function|index|constraint)\b")
        self.assertNotRegex(CODE, r"(?i)\balter table (?!public\.user_handles)")
        self.assertIn("to_regprocedure('public.take_web_rate(text, integer, integer)') is null", CODE)
        # a 0042-only database fails loudly at apply time, not at the first sign-up check
        self.assertIn("conname = 'web_rate_counters_bucket_check'", CODE)
        self.assertIn("pg_get_constraintdef(oid) like '%@%'", CODE)
        self.assertIn("0096 needs 0087", CODE)
        self.assertLess(CODE.index("0096 needs 0087"), CODE.index("create or replace function"))


if __name__ == "__main__":
    unittest.main()
