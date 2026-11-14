"""supabase/migrations/0167_refund_hold_recovery.sql — a refund that meets a hold collects when the hold is released (BR-0034-01).

SQL does not run in this suite (tests/security/test_sec_breach_refund_hold.py and test_sec_refund_hold_recovery.py do that, against a
real Postgres). These pin what must never change by accident: refund_purchased_credits is 0034's body line for line plus lines marked
`-- 0167`, so no refusal, idempotency rule or string 0034 had is lost; the drift guard, end state, verify query and rollback carry the
bodies' own md5; the collector is a trigger that fires after the lot trigger and only for releases; the new table is closed to every
API role but a service-role read; the rollback puts 0034's body back verbatim; the number is unique and documented.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
SQL = (MIG / "0167_refund_hold_recovery.sql").read_text(encoding="utf-8")
BASE = (MIG / "0034_plans_entitlements.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0167_refund_hold_recovery.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())

BEFORE = "766daf507d4e70711b8622aebbea7705"


def definition(sql: str, name: str) -> str:
    m = re.search(r"^create or replace function public\." + name + r"\(.*?^\$\$;$", sql, re.S | re.M)
    assert m, name
    return m.group(0)


def body(sql: str, name: str) -> str:
    return definition(sql, name).split("$$", 1)[1].rsplit("$$;", 1)[0]


def pg_md5(text: str) -> str:
    """md5(regexp_replace(prosrc, '\\s+', ' ', 'g')), the hash every drift guard in this repository uses."""
    return hashlib.md5(re.sub(r"\s+", " ", text, flags=re.ASCII).encode()).hexdigest()


REFUND_0034 = body(BASE, "refund_purchased_credits")
REFUND_0167 = body(SQL, "refund_purchased_credits")
RECOVER = body(SQL, "credit_refund_recover")


class RefundBodyIsTheLatestPlusMarkedLines(unittest.TestCase):
    def test_0034_is_the_latest_body_before_this_file(self):
        later = [p.name for p in sorted(MIG.glob("*.sql"))
                 if p.name[:4] > "0034" and p.name[:4] < "0167"
                 and "function public.refund_purchased_credits(" in p.read_text(encoding="utf-8")]
        self.assertEqual(later, [], "a later body exists: 0167 must be rebuilt on it")
        self.assertEqual(pg_md5(REFUND_0034), BEFORE)

    def test_every_0034_line_survives_in_order_and_every_new_line_is_marked(self):
        old = REFUND_0034.splitlines()
        dropped = ["  if short > 0 then"]
        it = iter(REFUND_0167.splitlines())

        def marked(got):
            # New code carries the marker; a blank line, or one that is only a comment (the marked block's explanation), changes nothing.
            return "-- 0167" in got or got.lstrip().startswith("--") or not got.strip()

        for line in old:
            if line in dropped:
                continue
            for got in it:
                if got == line:
                    break
                self.assertTrue(marked(got), f"an unmarked line that is not 0034's: {got!r}")
            else:
                self.fail(f"0034's line is missing or out of order: {line!r}")
        for rest in it:
            self.assertTrue(marked(rest), rest)
        # The one 0034 line that changed is named where it went.
        self.assertIn("elsif short > 0 then  -- 0167 (0034: if short > 0 then)", REFUND_0167)

    def test_every_string_literal_of_0034_is_still_there(self):
        code = "\n".join(line.split("--", 1)[0] for line in REFUND_0034.splitlines())  # an apostrophe in a comment is not a quote
        for lit in set(re.findall(r"'(?:[^']|'')*'", code)):
            self.assertIn(lit, REFUND_0167, lit)

    def test_the_refusals_and_the_idempotency_come_first_as_before(self):
        b = REFUND_0167
        self.assertLess(b.index("if not public.credits_trusted_caller() then"), b.index("credit_account_lock"))
        self.assertLess(b.index("select * into prior from public.credit_refunds where refund_id = rid;"),
                        b.index("insert into public.credit_refund_recoveries"))
        # A duplicate returns before anything is written.
        dup = b.split("if found then\n    if prior.purchase_external_id", 1)[1].split("end if;\n\n", 1)[0]
        self.assertNotIn("insert into", dup)
        self.assertNotIn("update public", dup)

    def test_the_held_part_is_bounded_by_the_shortfall_and_by_what_is_on_hold(self):
        self.assertIn("held := least(short, acc.reserved);", REFUND_0167)
        self.assertIn("c.org_id = purchase.org_id and c.status = 'open'", REFUND_0167)
        # Recorded inside the same call, after the account lock, so no hold opens or settles in between.
        self.assertLess(REFUND_0167.index("acc := public.credit_account_lock(purchase.org_id);"), REFUND_0167.index("held := least"))

    def test_same_signature_definer_and_search_path(self):
        head = definition(SQL, "refund_purchased_credits").split("$$", 1)[0]
        self.assertIn("p_external_id text, p_refund_id text, p_amount numeric default null,", head)
        self.assertIn("p_note text default null, p_reason text default 'refund'", head)
        self.assertIn("language plpgsql volatile security definer set search_path = public, pg_temp", head)


class Collector(unittest.TestCase):
    def test_it_fires_for_releases_only_and_after_the_lot_trigger(self):
        self.assertIn("create trigger credit_transactions_recover_refunds after insert on public.credit_transactions\n"
                      "  for each row when (new.kind = 'release' and new.amount > 0 and new.job_id is not null)\n"
                      "  execute function public.credit_refund_recover();", SQL)
        # Same-event triggers fire in name order (C collation): the hold's lots are given back before they are spent.
        self.assertLess("credit_transactions_apply_lots", "credit_transactions_recover_refunds")

    def test_it_collects_only_from_holds_open_at_the_refund_and_never_more_than_is_there(self):
        self.assertIn("new.job_id = any (r.holds)", RECOVER)
        self.assertIn("r.collected < r.owed", RECOVER)
        self.assertIn("x := least(rec.owed - rec.collected, left_, coalesce(avail, 0));", RECOVER)
        self.assertIn("greatest(a.balance - a.reserved, 0)", RECOVER)
        self.assertIn("exit when x <= 0;", RECOVER)

    def test_every_collection_is_a_ledger_row_on_the_refunded_lot_first(self):
        self.assertIn("perform public.credit_log(new.org_id, 'refund', -x, null, null,", RECOVER)
        self.assertIn("perform set_config('nightshift.refund_of', rec.purchase_external_id, true);", RECOVER)
        self.assertIn("perform set_config('nightshift.refund_of', '', true);", RECOVER)
        self.assertLess(RECOVER.index("set balance = balance - x"), RECOVER.index("public.credit_log("))

    def test_definer_with_a_pinned_search_path(self):
        head = definition(SQL, "credit_refund_recover").split("$$", 1)[0]
        self.assertIn("returns trigger\n  language plpgsql security definer set search_path = public, pg_temp", head)


class TableAndPrivileges(unittest.TestCase):
    def test_the_record_is_closed_but_for_a_service_role_read(self):
        self.assertIn("alter table public.credit_refund_recoveries enable row level security;", CODE)
        self.assertIn("revoke all on public.credit_refund_recoveries from public, anon, authenticated, service_role;", CODE)
        self.assertIn("grant select on public.credit_refund_recoveries to service_role;", CODE)
        self.assertNotRegex(CODE, r"create policy")
        self.assertNotRegex(CODE, r"grant [^;]*(insert|update|delete)[^;]* on public\.credit_refund_recoveries")

    def test_only_collected_moves_and_only_up(self):
        self.assertIn("check (owed > 0 and collected >= 0 and collected <= owed)", CODE)
        self.assertIn("or new.collected < old.collected then", CODE)
        self.assertIn("before update or delete on public.credit_refund_recoveries", CODE)
        self.assertIn("before truncate on public.credit_refund_recoveries", CODE)

    def test_function_grants(self):
        for fn in ("credit_refund_recoveries_guard()", "credit_refund_recover()"):
            self.assertIn(f"revoke all on function public.{fn} from public, anon, authenticated, service_role;", CODE)
        self.assertIn("revoke all on function public.refund_purchased_credits(text, text, numeric, text, text) from public, anon, authenticated;", CODE)
        self.assertIn("grant execute on function public.refund_purchased_credits(text, text, numeric, text, text) to service_role;", CODE)
        self.assertEqual(len(re.findall(r"grant execute", CODE)), 1)

    def test_nothing_existing_is_dropped_or_rewritten(self):
        self.assertNotRegex(CODE, r"(?i)drop (table|function|column|policy|index)")
        self.assertEqual(re.findall(r"create or replace function public\.(\w+)\(", CODE),
                         ["credit_refund_recoveries_guard", "refund_purchased_credits", "credit_refund_recover"])


class HashesAndRollback(unittest.TestCase):
    def test_the_drift_guard_end_state_and_verify_name_the_bodies_own_hashes(self):
        after, recover = pg_md5(REFUND_0167), pg_md5(RECOVER)
        self.assertIn(f"array['{BEFORE}', '{after}']", SQL)
        self.assertIn(f"c <> '{recover}'", SQL)
        self.assertIn(f"<> '{after}'", SQL.split("5. End state", 1)[1])
        self.assertIn(f"<> '{recover}'", SQL.split("5. End state", 1)[1])
        self.assertIn(f"= '{after}' as refund_body", SQL)
        self.assertIn(f"expected BEFORE (0034 applied, 0167 not): {BEFORE}", SQL)
        self.assertIn(f"refund_purchased_credits   {after}", SQL)
        self.assertIn(f"credit_refund_recover      {recover}", SQL)

    def test_the_file_is_one_transaction_with_a_lock_timeout_and_a_verify_query(self):
        self.assertIn("set local lock_timeout = '5s';", SQL)
        self.assertNotRegex(SQL, r"(?m)^(begin|commit);$")
        self.assertIn("-- Verify", SQL)

    def test_the_rollback_puts_0034s_body_back_verbatim_and_refuses_another(self):
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)
        self.assertEqual(definition(ROLLBACK, "refund_purchased_credits"), definition(BASE, "refund_purchased_credits"))
        self.assertIn(f"r is distinct from '{pg_md5(REFUND_0167)}'", ROLLBACK)
        self.assertIn(f"c <> '{pg_md5(RECOVER)}'", ROLLBACK)
        self.assertIn(f"<> '{BEFORE}' then", ROLLBACK)
        self.assertIn("drop trigger if exists credit_transactions_recover_refunds on public.credit_transactions;", ROLLBACK)
        self.assertIn("drop function if exists public.credit_refund_recover();", ROLLBACK)
        self.assertNotIn("drop table", ROLLBACK)
        self.assertIn("grant execute on function public.refund_purchased_credits(text, text, numeric, text, text) to service_role;", ROLLBACK)


class Numbering(unittest.TestCase):
    def test_the_number_is_unique_and_documented(self):
        numbers = [p.name[:4] for p in MIG.glob("*.sql")]
        self.assertEqual(numbers.count("0167"), 1)
        for n in ("0163", "0164", "0165", "0166"):
            self.assertNotIn(f"{n}_", SQL.split("\n", 1)[0])
        self.assertIn("## A refund that met a hold collects when the hold is released (0167)", MIGRATIONS_DOC)


if __name__ == "__main__":
    unittest.main()
