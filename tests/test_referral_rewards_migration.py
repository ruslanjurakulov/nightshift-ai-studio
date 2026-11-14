"""supabase/migrations/0165_referral_rewards.sql — the referral programme (credits for a friend's first payment, after a hold).

SQL does not run in this suite (tests/security/test_sec_referral_rewards.py does that, against a real Postgres); these pin what
must never change by accident: the two 0092 bodies it replaces differ from 0092's by exactly one hunk each; the md5 in each drift
guard, the rollback and docs/MIGRATIONS.md is the body's own; no payment, ledger or refund function and no trigger is touched; the
only ledger writes are the reward grant and the clawback, keyed by the referral's opaque ref (never the friend's id); the reward
can never exceed the payment that earns it and the hold is at least a week; the milestone keeps its state only where the
programme was running; every function is a definer with a pinned search_path and the grants are the declared ones; the rollback
refuses while a referral exists and puts 0092's bodies back byte for byte; the number is unique and documented.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
SQL = (MIG / "0165_referral_rewards.sql").read_text(encoding="utf-8")
M0092 = (MIG / "0092_friend_invites.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0165_referral_rewards.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())

CREATED = ["referral_settle_locked", "my_referrals", "claim_referral_rewards", "referral_terms", "referral_admin",
           "set_referral_settings", "referral_settle_all"]
REPLACED = ["friend_invite_pay_locked", "my_friend_invite"]


def definition(text: str, name: str) -> str:
    m = re.search(rf"^create or replace function public\.{name}\(.*?^\$\$;$", text, re.S | re.M)
    assert m, name
    return m.group(0)


def body(text: str, name: str) -> str:
    return definition(text, name).split("as $$", 1)[1].rsplit("$$;", 1)[0]


def pg_md5(text: str, name: str) -> str:
    """md5(regexp_replace(prosrc, '\\s+', ' ', 'g')), the hash every drift guard in this repository uses."""
    return hashlib.md5(re.sub(r"\s+", " ", body(text, name)).encode()).hexdigest()


class ReferralRewardsMigration(unittest.TestCase):
    def test_it_defines_exactly_these_functions(self):
        self.assertEqual(sorted(re.findall(r"create or replace function public\.(\w+)\(", CODE)), sorted(REPLACED + CREATED))

    def test_no_payment_ledger_or_refund_function_and_no_trigger_is_touched(self):
        for name in ("add_purchased_credits", "refund_purchased_credits", "record_payment_event", "grant_subscription_credits",
                     "upsert_subscription", "credit_log", "credit_account_lock", "credit_transactions_apply_lots",
                     "join_friend_invite", "create_friend_invite", "claim_friend_invite_reward", "set_friend_invite_settings"):
            self.assertNotRegex(CODE, rf"create or replace function public\.{name}\(", name)
        self.assertNotRegex(CODE, r"create (or replace )?trigger|drop trigger|create policy|drop table|drop function")
        self.assertNotRegex(CODE, r"alter table public\.(credit_transactions|credit_refunds|payment_events|credit_accounts)")

    def test_the_two_replaced_bodies_are_0092s_plus_one_hunk_each(self):
        pay_old, pay_new = body(M0092, "friend_invite_pay_locked"), body(SQL, "friend_invite_pay_locked")
        hunk_old = "  if not s.enabled then\n"
        hunk_new = ("  -- 0165: the sign-up milestone has its own switch, off unless the operator turned it on.\n"
                    "  if not s.enabled or not s.milestone_enabled then\n")
        self.assertEqual(pay_old.count(hunk_old), 1)
        self.assertEqual(pay_new.replace(hunk_new, hunk_old), pay_old)
        mine_old, mine_new = body(M0092, "my_friend_invite"), body(SQL, "my_friend_invite")
        old = "    'pending', r.user_id is null and l.id is not null and n >= s.required_joins\n"
        new = ("    -- 0165: a milestone that is switched off is not waiting to be paid.\n"
               "    'pending', r.user_id is null and l.id is not null and n >= s.required_joins and s.milestone_enabled\n")
        self.assertEqual(mine_old.count(old), 1)
        self.assertEqual(mine_new.replace(new, old), mine_old)

    def test_the_md5_in_each_guard_the_rollback_and_the_doc_is_the_bodys_own(self):
        guard = SQL.split("do $$", 1)[1].split("end $$;", 1)[0]
        for name in REPLACED:
            self.assertIn(f"'{pg_md5(M0092, name)}', '{pg_md5(SQL, name)}'", guard, name)
            self.assertIn(pg_md5(SQL, name), ROLLBACK, name)
            self.assertIn(pg_md5(M0092, name), ROLLBACK, name)
        for name in CREATED:
            self.assertIn(f"'{pg_md5(SQL, name)}', ''", guard, name)
            self.assertIn(pg_md5(SQL, name), ROLLBACK, name)
        for name in REPLACED + CREATED:
            self.assertIn(pg_md5(SQL, name), MIGRATIONS_DOC, name)
        # What it was written against, pinned as the repository has them.
        self.assertIn("'549632bae0dbb002dc66200d7f6c0998'", guard)  # join_friend_invite (0092)
        self.assertEqual(pg_md5(M0092, "join_friend_invite"), "549632bae0dbb002dc66200d7f6c0998")

    def test_every_function_is_a_definer_with_a_pinned_search_path(self):
        for name in REPLACED + CREATED:
            head = definition(SQL, name).split("as $$", 1)[0]
            self.assertRegex(head, r"security definer set search_path = public, pg_temp", name)

    def test_the_grants_are_the_declared_ones(self):
        self.assertIn("revoke all on function public.referral_settle_locked(public.friend_invite_links) "
                      "from public, anon, authenticated, service_role;", SQL)
        self.assertNotRegex(CODE, r"grant execute on function public\.referral_settle_locked")
        self.assertIn("revoke all on function public.referral_settle_all() from public, anon, authenticated;", SQL)
        self.assertIn("grant execute on function public.referral_settle_all() to service_role;", SQL)
        self.assertIn("grant execute on function public.referral_terms() to anon, authenticated;", SQL)
        for fn in ("claim_referral_rewards()", "my_referrals()", "referral_admin()"):
            self.assertIn(f"revoke all on function public.{fn} from public, anon, service_role;", SQL)
            self.assertIn(f"grant execute on function public.{fn} to authenticated;", SQL)
        self.assertEqual(len(re.findall(r"(?m)^grant ", CODE)), 7)

    def test_the_referrals_table_is_closed_to_every_api_role(self):
        self.assertIn("alter table public.referral_rewards enable row level security;", SQL)
        self.assertIn("revoke all on public.referral_rewards from public, anon, authenticated, service_role;", SQL)
        self.assertNotIn("create policy", CODE)

    def test_the_only_ledger_writes_are_the_grant_and_the_clawback_keyed_by_the_opaque_ref(self):
        settle = body(SQL, "referral_settle_locked")
        self.assertEqual(settle.count("insert into public.credit_transactions"), 2)
        self.assertIn("marker := 'referral-reward:' || r.ref::text;", settle)
        self.assertIn("(r.org_id, 'grant', r.credits, acc.balance, acc.reserved, marker, 'referral reward', p_link.user_id)", settle)
        self.assertIn("(r.org_id, 'adjust', -taken, acc.balance, acc.reserved, 'referral-clawback:' || r.ref::text,", settle)
        self.assertNotRegex(settle, r"'referral-[a-z]+:' \|\| [a-z_.]*invitee")
        # A clawback never takes more than is available, after expiring what is past its date.
        self.assertIn("perform public.credit_expire_lots_locked(r.org_id);", settle)
        self.assertIn("taken := least(r.credits, greatest(acc.balance - acc.reserved, 0));", settle)
        for name in CREATED:
            if name != "referral_settle_locked":
                self.assertNotIn("insert into public.credit_transactions", body(SQL, name), name)
                self.assertNotIn("update public.credit_accounts", body(SQL, name), name)

    def test_a_payment_qualifies_only_from_the_webhooks_kinds_in_the_friends_own_workspace(self):
        settle = body(SQL, "referral_settle_locked")
        for needle in ("tx.kind in ('purchase', 'subscription')",
                       "tx.amount >= s.referral_min_credits",
                       "tx.created_at >= j.created_at",
                       "tx.created_at < j.created_at + make_interval(days => s.referral_qualify_days)",
                       "tx.org_id <> p_link.org_id",
                       "not public.credits_exempt(tx.org_id)",
                       "join public.credit_transactions tx on tx.org_id = own.org_id",
                       "where own.user_id = j.invitee_id and own.role = 'owner'",
                       "om.org_id = tx.org_id and om.user_id = p_link.user_id",
                       "order by tx.created_at, tx.id",
                       "if s.enabled then"):
            self.assertIn(needle, settle, needle)
        # Refunds void during the hold; nothing is paid before release_at; the caps are checked before each payment.
        self.assertIn("set status = 'void', void_reason = 'refunded'", settle)
        self.assertIn("x.status = 'held' and x.release_at <= now()", settle)
        self.assertIn("exit when m >= s.referral_monthly_cap;", settle)
        self.assertIn("exit when (select count(*) from public.referral_rewards where paid_at >= day0) >= s.referral_daily_cap;", settle)
        self.assertLess(settle.index("pg_advisory_xact_lock(hashtextextended('referral_rewards', 0))"),
                        settle.index("acc := public.credit_account_lock(r.org_id);"))

    def test_the_public_terms_state_the_joins_own_new_account_window(self):
        join = body(M0092, "join_friend_invite")
        window = re.findall(r"u\.created_at < now\(\) - interval '(\d+) days'", join)
        self.assertEqual(len(window), 1)
        self.assertIn(f"'new_account_days', {window[0]},", body(SQL, "referral_terms"))
        # It reads settings and nothing about any person.
        terms = body(SQL, "referral_terms")
        for word in ("friend_invite_links", "friend_invite_joins", "referral_rewards", "auth.", "token"):
            self.assertNotIn(word, terms, word)

    def test_a_reward_never_exceeds_the_payment_that_earns_it_and_the_hold_is_at_least_a_week(self):
        self.assertIn("and referral_credits <= referral_min_credits", SQL)
        self.assertIn("and referral_hold_days between 7 and 180", SQL)
        setter = body(SQL, "set_referral_settings")
        self.assertIn("or n is null or n < 1 or n > 1000000 or c > n", setter)
        self.assertIn("or p_hold_days is null or p_hold_days not between 7 and 180", setter)
        self.assertIn("if not public.is_platform_admin() then", setter)

    def test_the_milestone_keeps_its_state_only_where_the_programme_was_running(self):
        add = SQL.index("add column if not exists milestone_enabled boolean;")
        fill = SQL.index("update public.friend_invite_settings set milestone_enabled = enabled where milestone_enabled is null;")
        default = SQL.index("alter column milestone_enabled set default false;")
        self.assertLess(add, fill)
        self.assertLess(fill, default)

    def test_prerequisites_are_checked_first_and_it_is_one_transaction(self):
        self.assertIn("set local lock_timeout", CODE)
        self.assertIn("APPLY AS ONE TRANSACTION", SQL)
        self.assertIn("WHAT TO VERIFY BEFORE YOU APPLY", SQL)
        first = SQL.index("create table if not exists")
        for needle in ("0165 needs Invite friends", "0165 needs credits", "0165 needs credit refunds", "0165 needs plans and lots",
                       "0165 needs organizations", "0165 found %"):
            self.assertLess(SQL.index(needle), first, needle)

    def test_the_rollback_refuses_while_a_referral_exists_and_restores_0092_byte_for_byte(self):
        self.assertEqual(len(re.findall(r"(?m)^begin;$", ROLLBACK)), 1)
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)
        self.assertIn("exists (select 1 from public.referral_rewards)", ROLLBACK)
        for name in REPLACED:
            self.assertIn(definition(M0092, name), ROLLBACK, name)
        self.assertIn("drop table if exists public.referral_rewards;", ROLLBACK)
        for name in CREATED:
            self.assertRegex(ROLLBACK, rf"drop function if exists public\.{name}\(", name)

    def test_the_number_is_unique_and_documented(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0165"), 1)
        self.assertIn("## The referral programme (0165)", MIGRATIONS_DOC)
        self.assertIn("rollback_0165_referral_rewards.sql", MIGRATIONS_DOC)


if __name__ == "__main__":
    unittest.main()
