"""supabase/migrations/0034_plans_entitlements.sql — the contract, without a database.

tests/test_plans_pg.py drives the money paths against a real Postgres when one
is configured; these pins run everywhere and catch the edits that would quietly
open a hole: a browser able to grant subscription credits or write a lot, a
definer function without a pinned search_path, the API balance (0031) touched,
the commit-time consistency check dropped, or the carry-over running outside
the migration's transaction.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0034_plans_entitlements.sql").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())
FLAT = re.sub(r"\s+", " ", CODE)


def functions() -> list[tuple[str, str]]:
    return re.findall(r"create or replace function (public\.\w+)\((.*?)\bas \$\$", CODE, re.S)


class Migration0034(unittest.TestCase):
    def test_every_security_definer_function_pins_its_search_path(self):
        definers = [(n, h) for n, h in functions() if "security definer" in h]
        self.assertGreater(len(definers), 25)
        for name, head in definers:
            with self.subTest(fn=name):
                self.assertRegex(head, r"set search_path = public(, pg_temp)?\b")

    def test_money_functions_are_service_role_only(self):
        for fn in (
            "upsert_subscription(uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz)",
            "grant_subscription_credits(uuid, text, text, timestamptz, timestamptz, text, text, text, text, numeric)",
            "expire_credit_lots(uuid)",
        ):
            with self.subTest(fn=fn):
                self.assertIn(f"revoke all on function public.{fn} from public, anon, authenticated;", FLAT)
                self.assertIn(f"grant execute on function public.{fn} to service_role;", FLAT)
                self.assertNotRegex(FLAT, rf"grant execute on function public\.{re.escape(fn)} to [^;]*authenticated")
        for name in ("upsert_subscription", "grant_subscription_credits", "expire_credit_lots"):
            body = CODE.split(f"function public.{name}(", 1)[1].split("$$;", 1)[0]
            self.assertIn("public.credits_trusted_caller()", body, name)

    def test_the_lot_engine_is_callable_by_nobody(self):
        for name in (
            "credit_lots_add_locked", "credit_lots_spend_locked", "credit_lots_hold_locked",
            "credit_lots_capture_locked", "credit_lots_release_locked", "credit_lots_restore_locked",
            "credit_expire_lots_locked", "credit_transactions_apply_lots", "credit_lots_consistent",
            "credit_account_lock", "org_entitlements_internal", "has_entitlement_internal",
        ):
            with self.subTest(fn=name):
                self.assertRegex(FLAT, rf"revoke all on function public\.{name}\([^)]*\) from public, anon, authenticated, service_role;")
                self.assertNotRegex(FLAT, rf"grant execute on function public\.{name}\(")

    def test_nobody_writes_state_tables_directly(self):
        self.assertIn(
            "revoke all on public.subscriptions, public.credit_lots, public.credit_hold_lots, public.credit_lot_moves "
            "from anon, authenticated, service_role;",
            FLAT,
        )
        self.assertNotRegex(FLAT, r"grant (insert|update|delete)[^;]* on public\.(subscriptions|credit_lots|credit_hold_lots|credit_lot_moves)")
        self.assertIn("using (org_id in (select public.accessible_org_ids('viewer')))", FLAT)

    def test_config_is_public_to_read_and_admin_only_to_write(self):
        self.assertIn("create policy %1$s_select on public.%1$s for select to anon, authenticated using (true)", FLAT)
        self.assertIn("using ((select public.is_platform_admin())) with check ((select public.is_platform_admin()))", FLAT)

    def test_the_invariant_is_checked_at_commit(self):
        for table in ("credit_accounts", "credit_lots"):
            self.assertRegex(
                FLAT,
                rf"create constraint trigger \w+ after insert or update on public\.{table} deferrable initially deferred "
                r"for each row execute function public\.credit_lots_consistent\(\);",
            )

    def test_one_transaction_and_the_carry_over_before_the_triggers(self):
        self.assertTrue(CODE.lstrip().startswith("begin;"))
        self.assertIn("\ncommit;", CODE)
        self.assertLess(CODE.index("balance carried over when plans launched"),
                        CODE.index("create trigger credit_transactions_apply_lots"))

    def test_the_api_balance_is_left_alone(self):
        self.assertNotRegex(CODE, r"\bapi_(accounts|ledger|holds|prices)\b")
        body = CODE.split("function public.api_org_eligible(", 1)[1].split("$$;", 1)[0]
        self.assertIn("t.kind = 'purchase'", body)  # the old rule stays
        self.assertIn("has_entitlement_internal(p_org, 'api_access')", body)

    def test_welcome_credits_and_downloads_are_not_redefined(self):
        for name in ("grant_welcome_credits", "request_download", "download_refund_locked", "reserve_credits", "capture_credits"):
            self.assertNotIn(f"function public.{name}(", CODE, name)

    def test_seeded_plans_match_the_documented_proposal(self):
        seeds = dict(re.findall(r"\('(\w+)',\s*'\w+',\s*\d+,\s*(\d+),", CODE))
        self.assertEqual(seeds, {"free": "0", "creator": "2000", "pro": "6000", "studio": "18000"})
        docs = (ROOT / "docs" / "BILLING_PLANS.md").read_text(encoding="utf-8")
        for credits in ("2 000", "6 000", "18 000"):
            self.assertIn(credits, docs)

    def test_only_enforced_keys_are_marked_enforced(self):
        enforced = set(re.findall(r"\('(\w+)',\s*'(?:int|bool|tier)',[^)]*'enforced'", CODE))
        self.assertEqual(enforced, {"concurrency", "queue_priority", "api_access"})


    def test_a_later_migration_that_redefines_a_0034_function_keeps_its_0034_part(self):
        # 0034 replaced four older functions. A later migration that replaces
        # one again must start from 0034's version, or lots, refunds, queue
        # priority or API activation silently lose what 0034 added.
        must_keep = {
            "credit_account_lock": "credit_expire_lots_locked",
            "refund_purchased_credits": "nightshift.refund_of",
            "claim_render_job": "render_job_priority",
            "api_org_eligible": "api_access",
        }
        later = sorted(p for p in (ROOT / "supabase" / "migrations").glob("0*.sql") if p.name > "0034")
        for path in later:
            text = path.read_text(encoding="utf-8")
            for fn, marker in must_keep.items():
                m = re.search(rf"create or replace function public\.{fn}\(.*?\$\$;", text, re.S)
                if m:
                    with self.subTest(migration=path.name, fn=fn):
                        self.assertIn(marker, m.group(0))

if __name__ == "__main__":
    unittest.main()
