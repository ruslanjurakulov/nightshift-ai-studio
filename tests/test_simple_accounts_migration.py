"""Migration 0091 (a workspace has one person, BR-L-174 .. BR-L-177), read as text.

The behaviour is proven in a real database by tests/security/test_sec_invites.py (the doors are
closed, a second person cannot be added, pending invitations are deleted, existing members stay,
the file replays). This file pins what a database test cannot see (house rule: no earlier check is
dropped, every definer function pins its search_path, grants are explicit):

* it replaces no earlier function body: the only function it creates is its own trigger function,
  so no check of 0018 / 0043 / 0081 / 0090 is touched;
* the four invitation functions lose EXECUTE for every API role and nothing grants it back;
* org_members loses its three write policies and the table-level write privileges;
* the pending-invitation delete and the one-person trigger are there, and replay-safe;
* the header names the deploy order, what happens to existing extra members, and what re-applying an
  older file does.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SQL = (REPO / "supabase" / "migrations" / "0091_simple_accounts.sql").read_text(encoding="utf-8")
LEDGER = (REPO / "docs" / "security" / "LEDGER.md").read_text(encoding="utf-8")


def code(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


CODE = code(SQL)


class SimpleAccountsMigration(unittest.TestCase):
    def test_it_replaces_no_earlier_function(self):
        names = re.findall(r"create or replace function public\.(\w+)", CODE)
        self.assertEqual(names, ["org_members_one_person"])

    def test_the_trigger_function_is_a_pinned_definer_and_not_callable(self):
        self.assertRegex(CODE, r"create or replace function public\.org_members_one_person\(\) returns trigger\s+language plpgsql security definer set search_path = public, pg_temp as")
        self.assertIn("revoke all on function public.org_members_one_person() from public, anon, authenticated;", CODE)
        self.assertIn("auth.uid() is not null", CODE)  # the SQL editor and the service role can still repair
        self.assertIn("using errcode = '42501'", CODE)

    def test_the_four_invitation_functions_lose_execute_and_nothing_grants_it_back(self):
        for sig in ("invite_org_member(uuid, text, text)", "accept_org_invite(uuid)", "decline_org_invite(uuid)", "my_invites()"):
            self.assertIn(f"revoke all on function public.{sig} from public, anon, authenticated;", CODE)
        self.assertNotRegex(CODE, r"grant\s+(execute|all)\s+on\s+function")

    def test_org_members_has_no_write_policy_and_no_write_privilege_left(self):
        for p in ("org_members_insert", "org_members_update", "org_members_delete"):
            self.assertIn(f"drop policy if exists {p} on public.org_members;", CODE)
        self.assertIn("revoke insert, update, delete on public.org_members from anon, authenticated;", CODE)
        self.assertNotRegex(CODE, r"create policy")
        self.assertNotRegex(CODE, r"grant\s+(insert|update|delete)")

    def test_pending_invitations_are_deleted_and_members_are_not(self):
        self.assertIn("delete from public.org_members where user_id is null;", CODE)
        self.assertNotRegex(CODE, r"delete from public\.org_members\s+where(?!\s+user_id is null)")
        self.assertNotRegex(CODE, r"update public\.org_members")

    def test_the_one_person_trigger_is_before_insert_and_replay_safe(self):
        self.assertIn("drop trigger if exists org_members_one_person on public.org_members;", CODE)
        self.assertRegex(CODE, r"create trigger org_members_one_person\s+before insert on public\.org_members\s+for each row")

    def test_the_header_says_what_the_owner_needs_to_know(self):
        head = SQL.split("-- 1. The invite entry points")[0]
        for needle in ("DEPLOY ORDER", "EXISTING EXTRA MEMBERS", "RE-APPLYING 0018 OR 0043", "REQUIRES 0018, 0043",
                       "BR-L-174", "BR-L-175", "BR-L-176", "BR-L-177"):
            self.assertIn(needle, head)

    def test_it_ends_with_a_verify_block_and_names_no_provider_or_model(self):
        self.assertIn("-- Verify (run after applying; every column should read true)", SQL)
        self.assertNotRegex(SQL, r"(?i)openai|anthropic|claude|gpt|gemini|elevenlabs|veo|kling|runway|flux|sonnet|opus")

    def test_the_ledger_has_a_fixed_row_for_each_removed_door(self):
        for bid in ("BR-L-174", "BR-L-175", "BR-L-176", "BR-L-177"):
            rows = [ln for ln in LEDGER.splitlines() if ln.startswith(f"| {bid} |")]
            self.assertEqual(len(rows), 1, bid)
            self.assertIn("| fixed |", rows[0])
            self.assertIn("test_sec_invites.py", rows[0])

    def test_the_ledger_summary_matches_its_rows(self):
        # Columns: ID | severity | area | title | status | ... A partially fixed row is still open.
        counts: dict[str, dict[str, int]] = {}
        for ln in LEDGER.splitlines():
            if not re.match(r"\| BR-[A-Z]+-\d+ \| (critical|high|medium|low|info) \|", ln):
                continue
            cols = [c.strip() for c in ln.split("|")]
            state = cols[5].split()[0]
            state = "open" if state == "partially" else state
            counts.setdefault(cols[2], {"open": 0, "fixed": 0, "wontfix": 0})[state] += 1
        for name, c in counts.items():
            row = re.search(rf"\| {name} \| (\d+) \| (\d+) \| (\d+) \|", LEDGER)
            self.assertIsNotNone(row, name)
            self.assertEqual((int(row.group(1)), int(row.group(2)), int(row.group(3))), (c["open"], c["fixed"], c["wontfix"]), name)


if __name__ == "__main__":
    unittest.main()
