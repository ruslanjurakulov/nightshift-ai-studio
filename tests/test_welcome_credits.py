"""supabase/migrations/0027_welcome_credits.sql: the free credits a new account
gets with its first organization.

SQL does not run in CI, so these pin the properties that would matter if a
later edit broke them: the grant is once per USER (the ledger's unique
external_id, never a per-org check), it only happens for a confirmed account's
first organization, and there is no new function a browser could call to mint
credits."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0027_welcome_credits.sql").read_text()
# Comments explain the rules in prose; the assertions read the code only.
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())


class WelcomeCreditsMigration(unittest.TestCase):
    def test_amount_is_one_constant_of_100(self):
        self.assertRegex(CODE, r"welcome_credits\s+constant\s+numeric\s*:=\s*100\s*;")
        self.assertEqual(len(re.findall(r":=\s*100\b", CODE)), 1)

    def test_marker_is_per_user_and_lands_in_the_unique_external_id(self):
        # external_id has a unique index (0020) on an append-only table — the
        # marker is permanent and a second grant for the same user cannot land.
        self.assertIn("marker := 'welcome:' || uid::text;", CODE)
        self.assertIn(
            "perform public.credit_log(new.id, 'grant', welcome_credits, null, marker, 'welcome credits');", CODE
        )
        self.assertIn("where external_id = marker", CODE)
        self.assertNotIn("new.id::text", CODE.split("marker :=", 1)[1].split(";", 1)[0])

    def test_only_the_first_organization_of_a_confirmed_signed_in_creator(self):
        self.assertIn("if uid is null or new.created_by is distinct from uid then", CODE)
        self.assertIn("where created_by = uid) <> 1 then", CODE)
        self.assertIn("u.email_confirmed_at is not null", CODE)
        self.assertIn("if public.credits_exempt(new.id) then", CODE)

    def test_a_race_loses_the_credits_not_the_organization(self):
        self.assertIn("exception when unique_violation then", CODE)

    def test_no_callable_function_is_exposed(self):
        # The only function is a trigger function, and EXECUTE is revoked from
        # every API role; nothing is granted back.
        functions = re.findall(r"create or replace function (public\.\w+)\(\)\s+returns (\w+)", CODE)
        self.assertEqual(functions, [("public.grant_welcome_credits", "trigger")])
        self.assertIn(
            "revoke all on function public.grant_welcome_credits() from public, anon, authenticated, service_role;",
            CODE,
        )
        self.assertNotRegex(CODE, r"grant\s+execute")
        self.assertNotRegex(CODE, r"grant\s+(insert|update|delete|all)")

    def test_fires_inside_organization_creation(self):
        self.assertIn("after insert on public.organizations", CODE)
        self.assertIn("for each row execute function public.grant_welcome_credits();", CODE)

    def test_security_definer_pins_search_path(self):
        self.assertIn("language plpgsql security definer set search_path = public, pg_temp as $$", CODE)

    def test_no_policy_or_rls_change(self):
        for forbidden in ("create policy", "drop policy", "disable row level security", "alter policy"):
            self.assertNotIn(forbidden, CODE.lower())


if __name__ == "__main__":
    unittest.main()
