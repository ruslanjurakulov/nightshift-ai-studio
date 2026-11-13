"""supabase/migrations/0154_dodo_purchase_history.sql — the Credits page's Dodo purchase history (invoices).

SQL does not run in this suite (tests/security/test_sec_dodo_purchase_history.py does that, against a real Postgres); these pin
what must never change by accident: one stable SECURITY DEFINER function with a pinned search_path and nothing else; signed-in
owners and admins of the organization only (not anon, not the service role, not a plain member); the payment id's shape checked
before anything is read; only Dodo payments that credited THIS organization (never a rejected or failing one); no column that
carries an event id, detail text, user, customer or e-mail; the md5 in the drift guard, the end state and the rollback is the
body's own; the number is unique and the numbering tests list it.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
SQL = (MIG / "0154_dodo_purchase_history.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0154_dodo_purchase_history.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())
SIG = "public.dodo_purchase_history(uuid, text)"


def definition() -> str:
    m = re.search(r"^create or replace function public\.dodo_purchase_history\(.*?^\$\$;$", SQL, re.S | re.M)
    assert m
    return m.group(0)


def body() -> str:
    return definition().split("as $$", 1)[1].rsplit("$$;", 1)[0]


def pg_md5() -> str:
    """md5(regexp_replace(prosrc, '\\s+', ' ', 'g')), the hash every drift guard in this repository uses."""
    return hashlib.md5(re.sub(r"\s+", " ", body()).encode()).hexdigest()


class DodoPurchaseHistoryMigration(unittest.TestCase):
    def test_one_function_and_nothing_else(self):
        self.assertEqual(re.findall(r"create or replace function public\.(\w+)\(", CODE), ["dodo_purchase_history"])
        self.assertNotRegex(CODE, r"create table|alter table|create (unique )?index|drop |create (or replace )?view|create policy|create trigger")

    def test_a_stable_definer_with_a_pinned_search_path(self):
        head = definition().split("as $$", 1)[0]
        self.assertIn("language plpgsql stable security definer set search_path = public, pg_temp", head)

    def test_read_only(self):
        low = body().lower()
        for verb in ("insert into", "update public", "delete from", "truncate", "perform ", "set_config", "_purchased_credits", "dodo_consume_checkout_nonce", "dodo_issue_checkout_nonce"):
            self.assertNotIn(verb, low, verb)

    def test_owner_or_admin_and_the_payment_id_shape_are_checked_before_anything_is_read(self):
        inside = body().split("\nbegin\n", 1)[1]
        signed_in = inside.index("if auth.uid() is null then")
        admin = inside.index("not public.is_org_member(p_org, 'admin') then")
        shape = inside.index("p_payment !~ '^pay_[A-Za-z0-9]{3,64}$'")
        reads = inside.index("public.payment_events")
        self.assertLess(signed_in, admin)
        self.assertLess(admin, reads)
        self.assertLess(shape, reads)
        self.assertIn("p_org is null or not public.is_org_member", inside)
        self.assertEqual(inside.count("errcode = '42501'"), 2)
        self.assertIn("raise exception 'invalid payment id' using errcode = '22023';", inside)

    def test_the_payment_id_shape_is_the_webhooks_own(self):
        shared = (ROOT / "supabase" / "functions" / "_shared" / "dodo.ts").read_text(encoding="utf-8")
        self.assertIn("const PAYMENT_ID_RE = /^pay_[A-Za-z0-9]{3,64}$/;", shared)

    def test_only_this_organizations_credited_dodo_payments(self):
        b = body()
        self.assertIn("e.provider = 'dodo'", b)
        self.assertIn("e.event_type = 'payment.succeeded'", b)
        # processed (credited) and its re-delivery; never rejected, ignored or failed: paid but not booked is a person's case.
        self.assertIn("e.status in ('processed', 'duplicate')", b)
        self.assertIn("e.org_id = p_org", b)
        self.assertIn("select distinct on (e.transaction_id)", b)
        self.assertIn("order by e.transaction_id, (e.status = 'processed') desc", b)
        # The item and the plan label are read inside the same organization only.
        self.assertIn("where n.org_id = p_org and n.consumed_by = c.transaction_id", b)
        self.assertIn("where t.org_id = p_org and t.external_id = c.transaction_id and t.kind = 'subscription'", b)
        # Refunds: processed ones only (a duplicate delivery is not a second refund).
        self.assertIn("and r.status = 'processed'", b)
        self.assertIn("limit 100;", b)

    def test_no_column_carries_an_event_id_detail_user_customer_or_email(self):
        cols = definition().split("returns table (", 1)[1].split(")", 1)[0]
        names = [ln.strip().split()[0] for ln in cols.strip().splitlines()]
        self.assertEqual(names, ["payment_id", "item", "credits", "amount_minor", "currency", "paid_at", "refunded_minor", "refund_unsized", "chargeback"])
        select = body().split("select c.transaction_id,", 1)[1].split("from credited c", 1)[0]
        for word in ("event_id", "detail", "user_id", "customer", "email", "nonce,"):
            self.assertNotIn(word, select, word)

    def test_grants_signed_in_only(self):
        self.assertIn(f"revoke all on function {SIG} from public, anon, authenticated, service_role;", SQL)
        self.assertIn(f"grant execute on function {SIG} to authenticated;", SQL)
        self.assertEqual(len(re.findall(r"(?m)^grant ", CODE)), 1)

    def test_the_md5_in_the_guard_the_end_state_and_the_rollback_is_the_bodys_own(self):
        h = pg_md5()
        self.assertEqual(SQL.count(f"'{h}'"), 2, h)
        self.assertIn(f"h <> '{h}'", ROLLBACK)
        self.assertIn(h, MIGRATIONS_DOC)

    def test_prerequisites_are_checked_first_and_it_is_one_transaction(self):
        self.assertIn("set local lock_timeout", CODE)
        self.assertIn("APPLY AS ONE TRANSACTION", SQL)
        self.assertIn("WHAT TO VERIFY BEFORE YOU APPLY", SQL)
        first = CODE.index("create or replace function")
        for needle in ("0154 needs 0018", "0154 needs 0021", "0154 needs 0146", "0154 found public.dodo_purchase_history"):
            self.assertLess(SQL.index(needle), SQL.index("create or replace function"), needle)
        self.assertGreater(first, 0)

    def test_the_rollback_refuses_a_foreign_body_drops_only_this_and_is_one_transaction(self):
        self.assertEqual(len(re.findall(r"(?m)^begin;$", ROLLBACK)), 1)
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)
        self.assertEqual(re.findall(r"(?m)^drop .*$", ROLLBACK), [f"drop function if exists {SIG};"])

    def test_the_number_is_unique_and_documented(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0154"), 1)
        self.assertIn("## The Credits page's Dodo purchase history (0154)", MIGRATIONS_DOC)


if __name__ == "__main__":
    unittest.main()
