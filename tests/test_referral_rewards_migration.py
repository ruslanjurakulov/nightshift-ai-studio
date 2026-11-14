"""supabase/migrations/0165_referral_rewards.sql — the referral programme (credits for a friend's first payment, after a hold).

SQL does not run in this suite (tests/security/test_sec_referral_rewards.py and test_sec_breach_referral_0165.py do that, against
a real Postgres); these pin what must never change by accident: the four bodies it replaces differ from their earlier ones by
exactly one hunk each; the md5 in each drift guard, the rollback and docs/MIGRATIONS.md is the body's own; no payment, refund or
reservation function is touched; both switches are added OFF and never copied from 0092's `enabled`; the only ledger writes are
the reward grant and the clawback, keyed by the referral's opaque ref; a payment qualifies only with the provider's own event of
real money; the setter goes through owner_guard and is audited; every function is a definer with a pinned search_path and the
grants are the declared ones; the rollback locks, refuses while a referral exists and puts the earlier bodies back byte for byte;
the number is unique and documented.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
SQL = (MIG / "0165_referral_rewards.sql").read_text(encoding="utf-8")
M0092 = (MIG / "0092_friend_invites.sql").read_text(encoding="utf-8")
M0034 = (MIG / "0034_plans_entitlements.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0165_referral_rewards.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())

CREATED = ["referral_payment_reversed", "referral_payment_paid", "referral_was_open", "referral_settle_locked", "my_referrals", "claim_referral_rewards", "referral_terms",
           "referral_admin", "set_referral_settings", "referral_settle_all"]
ORIGIN = {"friend_invite_pay_locked": M0092, "my_friend_invite": M0092, "join_friend_invite": M0092,
          "credit_transactions_apply_lots": M0034}
REPLACED = list(ORIGIN)


def definition(text: str, name: str) -> str:
    m = re.search(rf"^create or replace function public\.{name}\(.*?^\$\$;$", text, re.S | re.M)
    assert m, name
    return m.group(0)


def body(text: str, name: str) -> str:
    return definition(text, name).split("as $$", 1)[1].rsplit("$$;", 1)[0]


def pg_md5(text: str, name: str) -> str:
    """md5(regexp_replace(prosrc, '\\s+', ' ', 'g')), the hash every drift guard in this repository uses."""
    return hashlib.md5(re.sub(r"\s+", " ", body(text, name)).encode()).hexdigest()


def comment_free(text: str) -> str:
    return "\n".join(line for line in text.splitlines() if not line.strip().startswith("--"))


class ReferralRewardsMigration(unittest.TestCase):
    def test_it_defines_exactly_these_functions(self):
        self.assertEqual(sorted(re.findall(r"create or replace function public\.(\w+)\(", CODE)), sorted(REPLACED + CREATED))

    def test_no_payment_refund_or_reservation_function_is_touched(self):
        for name in ("add_purchased_credits", "refund_purchased_credits", "record_payment_event", "grant_subscription_credits",
                     "upsert_subscription", "credit_log", "credit_account_lock", "reserve_credits", "capture_credits",
                     "create_friend_invite", "claim_friend_invite_reward", "set_friend_invite_settings", "owner_guard"):
            self.assertNotRegex(CODE, rf"create or replace function public\.{name}\(", name)
        self.assertNotRegex(CODE, r"create (or replace )?trigger|drop trigger|create policy|drop table|drop function")
        self.assertNotRegex(CODE, r"alter table public\.(credit_transactions|credit_refunds|payment_events|credit_accounts)")

    def test_each_replaced_body_is_the_earlier_one_plus_one_hunk(self):
        # The hunks are the added lines; removing them (comments aside) gives the earlier body back.
        for name, src in ORIGIN.items():
            new, old = comment_free(body(SQL, name)), comment_free(body(src, name))
            added = [ln for ln in new.splitlines() if ln not in old.splitlines()]
            self.assertTrue(added, name)
            self.assertLessEqual(len(added), 6, (name, added))
        self.assertIn("if not s.enabled or not s.milestone_enabled then", body(SQL, "friend_invite_pay_locked"))
        self.assertIn("n >= s.required_joins and s.milestone_enabled", body(SQL, "my_friend_invite"))
        join = body(SQL, "join_friend_invite")
        self.assertLess(join.index("perform set_config('lock_timeout', '2s', true);"),
                        join.index("from public.friend_invite_links where id = l.id for update"))
        self.assertEqual(body(SQL, "join_friend_invite").replace(
            "  -- 0165: waiting at most 2 seconds for a settle that holds the link; past that the call fails (55P03)\n"
            "  -- and the app retries it, keeping the person's cookie.\n"
            "  perform set_config('lock_timeout', '2s', true);\n", ""), body(M0092, "join_friend_invite"))
        lots = body(SQL, "credit_transactions_apply_lots")
        self.assertIn("elsif new.kind = 'adjust' then", lots)
        self.assertIn("nullif(current_setting('nightshift.adjust_lot_first', true), '')", lots)

    def test_the_md5_in_each_guard_the_rollback_and_the_doc_is_the_bodys_own(self):
        guard = SQL.split("do $$", 1)[1].split("end $$;", 1)[0]
        for name, src in ORIGIN.items():
            self.assertIn(f"'{pg_md5(src, name)}', '{pg_md5(SQL, name)}'", guard, name)
            self.assertIn(pg_md5(SQL, name), ROLLBACK, name)
            self.assertIn(pg_md5(src, name), ROLLBACK, name)
        for name in CREATED:
            self.assertIn(f"'{pg_md5(SQL, name)}', ''", guard, name)
            self.assertIn(pg_md5(SQL, name), ROLLBACK, name)
        for name in REPLACED + CREATED:
            self.assertIn(pg_md5(SQL, name), MIGRATIONS_DOC, name)
        self.assertEqual(pg_md5(M0092, "join_friend_invite"), "549632bae0dbb002dc66200d7f6c0998")
        self.assertEqual(pg_md5(M0034, "credit_transactions_apply_lots"), "8ab35cff8ac8a145403b0e6eca735697")

    def test_both_switches_are_added_off_and_never_copied_from_0092s(self):
        self.assertIn("add column if not exists referral_enabled boolean not null default false;", SQL)
        self.assertIn("add column if not exists milestone_enabled boolean not null default false;", SQL)
        # Nothing has ever been open: the periods table starts empty, and only the setter writes it.
        self.assertIn("create table if not exists public.referral_open_periods (", SQL)
        self.assertEqual(CODE.count("insert into public.referral_open_periods"), 1)
        self.assertIn("insert into public.referral_open_periods", body(SQL, "set_referral_settings"))
        self.assertNotIn("referral_started_at", CODE)
        self.assertNotRegex(CODE, r"set\s+milestone_enabled\s*=\s*enabled|set\s+referral_enabled\s*=\s*enabled")
        self.assertIn("WHAT CHANGES ON APPLY", SQL)
        settle = body(SQL, "referral_settle_locked")
        self.assertIn("if s.referral_enabled then", settle)
        self.assertIn("and public.referral_was_open(jj.created_at)", settle)
        self.assertIn("or not public.referral_was_open(t.created_at)", settle)
        setter = body(SQL, "set_referral_settings")
        self.assertIn("insert into public.referral_open_periods (opened_at, opened_by) values (now(), auth.uid());", setter)
        self.assertIn("update public.referral_open_periods set closed_at = now(), closed_by = auth.uid() where closed_at is null;", setter)
        self.assertLess(setter.index("referral_open_periods"), setter.index("perform public.security_event_log("))

    def test_every_function_is_a_definer_with_a_pinned_search_path(self):
        for name in REPLACED + CREATED:
            head = definition(SQL, name).split("as $$", 1)[0]
            self.assertRegex(head, r"security definer set search_path = public, pg_temp", name)

    def test_the_grants_are_the_declared_ones(self):
        for internal in ("referral_settle_locked(public.friend_invite_links)", "referral_payment_reversed(text)",
                         "referral_payment_paid(text)", "referral_was_open(timestamptz)"):
            self.assertIn(f"revoke all on function public.{internal} from public, anon, authenticated, service_role;", SQL)
            self.assertNotIn(f"grant execute on function public.{internal}", CODE)
        self.assertIn("revoke all on function public.referral_settle_all(integer) from public, anon, authenticated;", SQL)
        self.assertIn("grant execute on function public.referral_settle_all(integer) to service_role;", SQL)
        self.assertIn("grant execute on function public.referral_terms() to anon, authenticated;", SQL)
        for fn in ("claim_referral_rewards()", "my_referrals()", "referral_admin()"):
            self.assertIn(f"revoke all on function public.{fn} from public, anon, service_role;", SQL)
            self.assertIn(f"grant execute on function public.{fn} to authenticated;", SQL)
        self.assertEqual(len(re.findall(r"(?m)^grant ", CODE)), 8)

    def test_the_tables_are_closed_to_every_api_role(self):
        self.assertIn("execute format('revoke all on sequence %s from public, anon, authenticated, service_role', seq);", SQL)
        for table in ("referral_rewards", "referral_settle_runs", "referral_open_periods"):
            self.assertIn(f"alter table public.{table} enable row level security;", SQL)
            self.assertIn(f"revoke all on public.{table} from public, anon, authenticated, service_role;", SQL)
        self.assertNotIn("create policy", CODE)

    def test_the_only_ledger_writes_are_the_grant_and_the_clawback_keyed_by_the_opaque_ref(self):
        settle = body(SQL, "referral_settle_locked")
        self.assertEqual(settle.count("insert into public.credit_transactions"), 2)
        self.assertIn("marker := 'referral-reward:' || r.ref::text;", settle)
        self.assertIn("(r.org_id, 'grant', r.credits, acc.balance, acc.reserved, marker, 'referral reward', p_link.user_id)", settle)
        self.assertIn("'referral-clawback:' || r.ref::text || ':' || (r.claw_n + 1)::text,", settle)
        self.assertNotRegex(settle, r"'referral-[a-z]+:' \|\| [a-z_.]*invitee")
        # The clawback: from the reward's own lot first, never more than is available, what is left stays owed, the platform
        # is its author, and the advisory lock comes before the account as in the payout.
        self.assertIn("perform set_config('nightshift.adjust_lot_first', 'referral-reward:' || r.ref::text, true);", settle)
        self.assertIn("taken := least(owed, greatest(acc.balance - acc.reserved, 0));", settle)
        self.assertIn("status = case when owed - taken > 0 then 'clawing' else 'clawed' end", settle)
        self.assertIn("x.status = 'clawing'", settle)
        claw = settle.split("-- 4.", 1)[1]
        self.assertLess(claw.index("pg_advisory_xact_lock(hashtextextended('referral_rewards', 0))"),
                        claw.index("perform public.credit_account_lock(r.org_id);"))
        self.assertIn("         null);", claw)
        for name in CREATED:
            if name != "referral_settle_locked":
                self.assertNotIn("insert into public.credit_transactions", body(SQL, name), name)
                self.assertNotIn("update public.credit_accounts", body(SQL, name), name)

    def test_a_payment_qualifies_only_in_the_friends_own_new_workspace_and_only_for_real_money(self):
        settle = body(SQL, "referral_settle_locked")
        for needle in ("where o.created_by = j.invitee_id",
                       "select u.created_at into born from auth.users u where u.id = j.invitee_id;",
                       "and o.created_at >= born",
                       "and own.created_at <= tx.created_at",
                       "join public.org_members own on own.org_id = o.id and own.user_id = j.invitee_id and own.role = 'owner'",
                       "tx.kind in ('purchase', 'subscription')",
                       "and public.referral_payment_paid(tx.external_id)",
                       "and public.referral_payment_paid(p.external_id))",
                       "continue when t.amount < s.referral_min_credits",
                       "or t.created_at >= born + make_interval(days => s.referral_qualify_days)",
                       "and e.amount_minor < ceil(s.referral_min_credits / 2));",
                       "jj.created_at >= now() - make_interval(days => s.referral_qualify_days + 2)"):
            self.assertIn(needle, settle, needle)
        paid = body(SQL, "referral_payment_paid")
        for needle in ("e.transaction_id = p_ext",
                       "(e.provider = 'paddle' and e.event_type = 'transaction.completed')",
                       "(e.provider = 'dodo' and e.event_type = 'payment.succeeded')",
                       "e.status in ('processed', 'duplicate')",
                       "e.amount_minor > 0",
                       "position(' · discounted' in coalesce(e.detail, '')) = 0"):
            self.assertIn(needle, paid, needle)
        # The marker is the webhook's own.
        paddle = (ROOT / "supabase" / "functions" / "_shared" / "paddle.ts").read_text(encoding="utf-8")
        self.assertIn('export const DISCOUNT_MARK = " · discounted";', paddle)
        reversed_ = body(SQL, "referral_payment_reversed")
        for needle in ("public.credit_refunds", "'adjustment.created', 'adjustment.updated'", "'dispute.expired'",
                       "e.status in ('processed', 'duplicate', 'rejected')"):
            self.assertIn(needle, reversed_, needle)
        # Refunds void during the hold and again at the moment of paying; nothing is paid before release_at.
        self.assertGreaterEqual(settle.count("public.referral_payment_reversed("), 3)
        self.assertIn("x.status = 'held' and x.release_at <= now()", settle)
        self.assertIn("exit when m >= s.referral_monthly_cap;", settle)

    def test_the_setter_goes_through_owner_guard_and_is_audited_in_the_same_call(self):
        setter = body(SQL, "set_referral_settings")
        self.assertLess(setter.index("g := public.owner_guard('referral_settings', 10);"), setter.index("update public.friend_invite_settings"))
        self.assertIn("values (auth.uid(), 'billing.settings', 'referral programme', detail, null);", setter)
        self.assertIn("perform public.security_event_log('referral.settings', 'critical', 'referral programme', detail);", setter)
        self.assertIn("or mn is null or mn < 1 or mn > 1000000 or c > mn", setter)
        self.assertIn("or p_hold_days is null or p_hold_days not between 7 and 180", setter)
        self.assertIn("and referral_credits <= referral_min_credits", SQL)

    def test_claims_are_rate_limited_and_the_settle_job_is_batched_and_logged(self):
        self.assertIn("if public.take_web_rate('referral.claim', 60, 3600) then", body(SQL, "claim_referral_rewards"))
        every = body(SQL, "referral_settle_all")
        self.assertIn("for update skip locked", every)
        self.assertIn("limit greatest(1, least(coalesce(p_limit, 50), 500))", every)
        self.assertIn("insert into public.referral_settle_runs", every)
        admin = body(SQL, "referral_admin")
        self.assertIn("'schedule', sched", admin)
        self.assertIn("'last_run'", admin)
        self.assertIn("'reversed_by_event'", admin)
        self.assertIn("'orphaned'", admin)
        self.assertIn("'open_since'", admin)

    def test_the_referrer_never_reads_a_payment_time(self):
        mine = body(SQL, "my_referrals")
        self.assertIn("to_char(min(release_at) at time zone 'UTC', 'YYYY-MM-DD')", mine)
        self.assertNotIn("'next_release_at'", mine)

    def test_the_public_terms_state_the_joins_own_new_account_window(self):
        join = body(M0092, "join_friend_invite")
        window = re.findall(r"u\.created_at < now\(\) - interval '(\d+) days'", join)
        self.assertEqual(len(window), 1)
        terms = body(SQL, "referral_terms")
        self.assertIn(f"'new_account_days', {window[0]},", terms)
        for word in ("friend_invite_links", "friend_invite_joins", "referral_rewards", "auth.", "token"):
            self.assertNotIn(word, terms, word)

    def test_prerequisites_are_checked_first_and_it_is_one_transaction(self):
        self.assertIn("set local lock_timeout", CODE)
        self.assertIn("APPLY AS ONE TRANSACTION", SQL)
        self.assertIn("WHAT TO VERIFY BEFORE YOU APPLY", SQL)
        first = SQL.index("alter table public.friend_invite_settings add column")
        for needle in ("0165 needs Invite friends", "0165 needs credits", "0165 needs credit refunds", "0165 needs plans and lots",
                       "0165 needs organizations", "0165 needs the web rate limit", "0165 needs the owner guard", "0165 found %"):
            self.assertLess(SQL.index(needle), first, needle)

    def test_the_rollback_locks_refuses_while_a_referral_exists_and_restores_the_earlier_bodies(self):
        self.assertEqual(len(re.findall(r"(?m)^begin;$", ROLLBACK)), 1)
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)
        self.assertLess(ROLLBACK.index("lock table public.referral_rewards in access exclusive mode;"),
                        ROLLBACK.index("exists (select 1 from public.referral_rewards)"))
        for name, src in ORIGIN.items():
            self.assertIn(definition(src, name), ROLLBACK, name)
        for table in ("referral_rewards", "referral_settle_runs", "referral_open_periods"):
            self.assertIn(f"drop table if exists public.{table};", ROLLBACK)
        for name in CREATED:
            self.assertRegex(ROLLBACK, rf"drop function if exists public\.{name}\(", name)

    def test_the_number_is_unique_and_documented(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0165"), 1)
        self.assertIn("## The referral programme (0165)", MIGRATIONS_DOC)
        self.assertIn("rollback_0165_referral_rewards.sql", MIGRATIONS_DOC)


if __name__ == "__main__":
    unittest.main()
