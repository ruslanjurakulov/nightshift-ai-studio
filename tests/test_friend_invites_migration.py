"""supabase/migrations/0092_friend_invites.sql — one invite link per person,
the owner paid once after five confirmed joins.

The behaviour runs in tests/security/test_sec_friend_invites.py (a real
Postgres). This pins, without a database, what must not change by accident:
the switch defaults OFF, the money functions are definers with a pinned
search_path and explicit grants, nothing but the five functions the browser
needs is granted, no API role has a table privilege, the reward is paid into
the ledger as one idempotent typed grant, and nothing earlier is dropped.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0092_friend_invites.sql").read_text()
CODE = re.sub(r"--[^\n]*", "", SQL)


def function_bodies():
    return re.findall(r"create or replace function public\.(\w+)\((.*?)\$\$;", CODE, re.S)


class FriendInvitesMigration(unittest.TestCase):
    def test_the_switch_is_off_until_the_operator_turns_it_on(self):
        self.assertIn("enabled          boolean not null default false", CODE)
        self.assertIn("insert into public.friend_invite_settings (id) values (true) on conflict (id) do nothing", CODE)

    def test_defaults_are_the_owners_numbers(self):
        self.assertIn("required_joins   integer not null default 5", CODE)
        self.assertIn("reward_credits   numeric(14,2) not null default 100", CODE)
        self.assertIn("daily_reward_cap integer not null default 20", CODE)
        self.assertIn("link_hourly_cap  integer not null default 10", CODE)

    def test_every_table_has_rls_and_no_api_role_has_a_privilege(self):
        tables = re.findall(r"create table if not exists public\.(friend_invite_\w+)", CODE)
        self.assertEqual(sorted(tables), ["friend_invite_joins", "friend_invite_links", "friend_invite_rewards", "friend_invite_settings"])
        for t in tables:
            self.assertIn(f"alter table public.{t} enable row level security;", CODE)
            self.assertIn(f"revoke all on public.{t} from public, anon, authenticated;", CODE)
        self.assertNotRegex(CODE, r"create policy|grant (select|insert|update|delete|all) on")

    def test_every_function_is_a_definer_with_a_pinned_search_path(self):
        funcs = function_bodies()
        self.assertEqual(
            sorted(n for n, _ in funcs),
            ["claim_friend_invite_reward", "create_friend_invite", "friend_invite_admin", "friend_invite_mail_key",
             "friend_invite_pay_locked", "friend_invite_peek", "friend_invite_token", "join_friend_invite",
             "my_friend_invite", "set_friend_invite_settings"],
        )
        for name, body in funcs:
            if name == "friend_invite_token":  # touches no table
                continue
            self.assertIn("security definer set search_path = public, pg_temp", body, name)

    def test_only_the_browser_functions_are_granted_and_only_peek_to_anon(self):
        granted = re.findall(r"grant execute on function public\.(\w+)\(.*?\) to ([a-z, ]+);", CODE)
        self.assertEqual(
            sorted(granted),
            sorted([
                ("my_friend_invite", "authenticated"), ("create_friend_invite", "authenticated"),
                ("claim_friend_invite_reward", "authenticated"), ("join_friend_invite", "authenticated"),
                ("friend_invite_admin", "authenticated"), ("set_friend_invite_settings", "authenticated"),
                ("friend_invite_peek", "anon, authenticated"),
            ]),
        )
        for internal in ("friend_invite_token()", "friend_invite_mail_key(uuid)", "friend_invite_pay_locked(public.friend_invite_links)"):
            self.assertIn(f"revoke all on function public.{internal} from public, anon, authenticated, service_role;", CODE)

    def test_the_reward_is_one_idempotent_typed_grant(self):
        body = dict(function_bodies())["friend_invite_pay_locked"]
        self.assertIn("'invite-reward:' || p_link.user_id::text", body)
        self.assertIn("'grant', s.reward_credits", body)
        self.assertIn("perform public.credit_account_lock(p_link.org_id);", body)
        self.assertIn("exception when unique_violation then", body)
        self.assertIn("pg_advisory_xact_lock(hashtextextended('friend_invite_rewards', 0))", body)
        self.assertIn("user_id    uuid primary key", CODE)
        # one reward per mailbox too: the key outlives the account (Lens-383)
        self.assertIn("k := public.friend_invite_mail_key(p_link.user_id);", body)
        self.assertIn("exists (select 1 from public.friend_invite_rewards where email_key = k)", body)
        self.assertIn("create unique index if not exists friend_invite_rewards_mailbox_key", CODE)
        create = dict(function_bodies())["create_friend_invite"]
        self.assertIn("x.email_key = public.friend_invite_mail_key(uid)", create)

    def test_a_join_needs_a_confirmed_new_account_that_is_not_the_owner(self):
        body = dict(function_bodies())["join_friend_invite"]
        for needle in (
            "u.email_confirmed_at is null",
            "uid = l.user_id",
            "u.created_at < l.created_at or u.created_at < now() - interval '3 days'",
            "for update",
            "friend_invite_joins where email_key = v_key",
            "link_hourly_cap",
        ):
            self.assertIn(needle, body)

    def test_the_token_is_128_bits_and_only_its_owner_reads_it(self):
        self.assertIn("check (token ~ '^[0-9a-f]{32}$')", CODE)
        mine = dict(function_bodies())["my_friend_invite"]
        self.assertIn("where user_id = uid", mine)
        self.assertNotIn("invitee_id", mine)

    def test_is_additive_and_replay_safe(self):
        plain = re.sub(r"on delete (cascade|restrict)", "", CODE.lower())  # foreign-key actions, not deletes
        self.assertNotRegex(plain, r"\bdrop\b|\bdelete\b|\btruncate\b")
        self.assertNotIn("update public.credit_accounts set balance = 0", CODE)
        self.assertEqual(re.findall(r"create table (?!if not exists)", CODE), [], "every create table is guarded")


if __name__ == "__main__":
    unittest.main()
