"""supabase/migrations/0172_grant_reversal_hold_recovery.sql — an owner's grant reversal that meets a hold collects when the hold is
released (BR-0107-01).

SQL does not run in this suite (tests/security/test_sec_breach_owner_reverse_hold.py and test_sec_grant_reversal_hold_recovery.py do
that, against a real Postgres). These pin what must never change by accident: owner_reverse_grant is 0107's body line for line plus lines
marked `-- 0172`, so no refusal, idempotency rule or string 0107 had is lost; the lot trigger is 0167's body plus marked lines; the drift
guard, end state, verify query and rollback carry the bodies' own md5; the collector fires on release rows only, after 0167's, spends
only the grant's own lot, pays at most what this release gave back to it less what an earlier collector already took, and writes its
ledger row as the platform; the new table is closed to every API role but a service-role read; the rollback puts 0107's and 0167's
bodies back verbatim; the number is unique and documented.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
SQL = (MIG / "0172_grant_reversal_hold_recovery.sql").read_text(encoding="utf-8")
BASE_0107 = (MIG / "0107_owner_safety.sql").read_text(encoding="utf-8")
BASE_0167 = (MIG / "0167_refund_hold_recovery.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0172_grant_reversal_hold_recovery.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
LEDGER = (ROOT / "docs" / "security" / "LEDGER.md").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())

REVERSE_BEFORE = "4c701e7930d213f6f1ba84485c366a36"
LOTS_BEFORE = "6098f97a7630bed24807bb7c5ef6eefe"


def definition(sql: str, name: str) -> str:
    m = re.search(r"^create or replace function public\." + name + r"\(.*?^\$\$;$", sql, re.S | re.M)
    assert m, name
    return m.group(0)


def body(sql: str, name: str) -> str:
    return definition(sql, name).split("$$", 1)[1].rsplit("$$;", 1)[0]


def pg_md5(text: str) -> str:
    """md5(regexp_replace(prosrc, '\\s+', ' ', 'g')), the hash every drift guard in this repository uses."""
    return hashlib.md5(re.sub(r"\s+", " ", text, flags=re.ASCII).encode()).hexdigest()


REVERSE_0107 = body(BASE_0107, "owner_reverse_grant")
REVERSE_0172 = body(SQL, "owner_reverse_grant")
LOTS_0167 = body(BASE_0167, "credit_transactions_apply_lots")
LOTS_0172 = body(SQL, "credit_transactions_apply_lots")
RECOVER = body(SQL, "credit_grant_reversal_recover")


def marked(got: str) -> bool:
    # New code carries the marker; a blank line, or one that is only a comment, changes nothing.
    return "-- 0172" in got or got.lstrip().startswith("--") or not got.strip()


def assert_latest_plus_marked(case: unittest.TestCase, old_body: str, new_body: str, dropped: list[str]) -> None:
    it = iter(new_body.splitlines())
    for line in old_body.splitlines():
        if line in dropped:
            continue
        for got in it:
            if got == line:
                break
            case.assertTrue(marked(got), f"an unmarked line that is not the earlier body's: {got!r}")
        else:
            case.fail(f"the earlier body's line is missing or out of order: {line!r}")
    for rest in it:
        case.assertTrue(marked(rest), rest)


class ReverseBodyIsTheLatestPlusMarkedLines(unittest.TestCase):
    # The three 0107 lines whose lists gain `on_hold`; each is replaced whole by a marked line that keeps all of 0107's text.
    DROPPED = [
        "                              'shortfall', t.amount + v_prior.amount, 'balance', v_acc.balance);",
        "                       'shortfall', t.amount - v_take, 'transaction_id', v_txn, 'reason', v_why, 'balance_after', v_acc.balance),",
        "                            'reversed', v_take, 'shortfall', t.amount - v_take, 'balance', v_acc.balance,",
    ]

    def test_0107_is_the_latest_body_before_this_file(self):
        later = [p.name for p in sorted(MIG.glob("*.sql"))
                 if "0107" < p.name[:4] < "0172"
                 and "function public.owner_reverse_grant(" in p.read_text(encoding="utf-8")]
        self.assertEqual(later, [], "a later body exists: 0172 must be rebuilt on it")
        self.assertEqual(pg_md5(REVERSE_0107), REVERSE_BEFORE)

    def test_every_0107_line_survives_in_order_and_every_new_line_is_marked(self):
        for line in self.DROPPED:
            self.assertIn(line, REVERSE_0107.splitlines())
        assert_latest_plus_marked(self, REVERSE_0107, REVERSE_0172, self.DROPPED)

    def test_each_replaced_line_keeps_all_of_0107s_text(self):
        new = REVERSE_0172.splitlines()
        self.assertIn("                              'shortfall', t.amount + v_prior.amount, 'balance', v_acc.balance,  -- 0172", new)
        self.assertIn("                       'shortfall', t.amount - v_take, 'on_hold', v_held, 'transaction_id', v_txn, 'reason', v_why, "
                      "'balance_after', v_acc.balance),  -- 0172", new)
        self.assertIn("                            'reversed', v_take, 'shortfall', t.amount - v_take, 'on_hold', v_held, "
                      "'balance', v_acc.balance,  -- 0172", new)

    def test_every_string_literal_of_0107_is_still_there(self):
        code = "\n".join(line.split("--", 1)[0] for line in REVERSE_0107.splitlines())
        lits = set(re.findall(r"'(?:[^']|'')*'", code))
        self.assertGreaterEqual(len(lits), 20)
        for lit in lits:
            self.assertIn(lit, REVERSE_0172, lit)

    def test_the_refusals_and_the_idempotency_come_first_as_before(self):
        b = REVERSE_0172
        self.assertLess(b.index("g := public.owner_guard('reverse_grant', 20);"), b.index("credit_account_lock"))
        dup = b.split("select * into v_prior from public.credit_transactions where external_id = v_ext;", 1)[1].split(
            "select * into l from public.credit_lots", 1)[0]
        self.assertIn("'duplicate', true,", dup)
        self.assertNotIn("insert into", dup)
        self.assertNotIn("update public", dup)
        self.assertIn("'on_hold', coalesce((select r.owed from public.credit_grant_reversal_recoveries r where r.grant_txn_id = t.id), 0));", dup)

    def test_the_held_part_is_the_grants_own_lot_on_open_holds_bounded_by_the_shortfall(self):
        b = REVERSE_0172
        self.assertIn("from public.credit_hold_lots h join public.credit_reservations c on c.job_id = h.job_id", b)
        self.assertIn("where h.lot_id = l.id and c.status = 'open';", b)
        self.assertIn("v_held := least(t.amount - v_take, l.held, v_on);", b)
        # After the account lock (no hold opens or settles in between) and after 0107's nothing-to-reverse answer.
        self.assertLess(b.index("v_acc := public.credit_account_lock(t.org_id);"), b.index("v_held := least"))
        self.assertLess(b.index("if v_take <= 0 then"), b.index("v_held := least"))
        # Recorded only after the reversal's own ledger row exists, and only when something is held.
        self.assertLess(b.index("v_txn := public.credit_log("), b.index("insert into public.credit_grant_reversal_recoveries"))
        self.assertIn("if v_held > 0 then  -- 0172", b)

    def test_the_reversal_spends_the_grants_own_lot_and_resets_the_setting(self):
        b = REVERSE_0172
        on = b.index("perform set_config('nightshift.reverse_lot', coalesce(l.id::text, ''), true);")
        log = b.index("v_txn := public.credit_log(t.org_id, 'adjust', -v_take, null, v_ext,")
        off = b.index("perform set_config('nightshift.reverse_lot', '', true);")
        self.assertLess(on, log)
        self.assertLess(log, off)
        # Inside the begin ... exception block, so a refusal rolls the setting back with the row.
        block = b.split("  begin\n", 1)[1].split("  exception\n", 1)[0]
        self.assertIn("nightshift.reverse_lot', coalesce", block)
        self.assertIn("nightshift.reverse_lot', ''", block)

    def test_same_signature_definer_search_path_and_grants(self):
        head = definition(SQL, "owner_reverse_grant").split("$$", 1)[0]
        self.assertEqual(head, definition(BASE_0107, "owner_reverse_grant").split("$$", 1)[0])
        self.assertIn("language plpgsql volatile security definer set search_path = public, pg_temp", head)
        self.assertIn("revoke all on function public.owner_reverse_grant(bigint, text) from public, anon, authenticated, service_role;", CODE)
        self.assertIn("grant execute on function public.owner_reverse_grant(bigint, text) to authenticated;", CODE)
        self.assertEqual(len(re.findall(r"grant execute", CODE)), 1)


class LotTriggerIsTheLatestPlusMarkedLines(unittest.TestCase):
    def test_0167_is_the_latest_body_before_this_file(self):
        later = [p.name for p in sorted(MIG.glob("*.sql"))
                 if "0167" < p.name[:4] < "0172"
                 and "function public.credit_transactions_apply_lots(" in p.read_text(encoding="utf-8")]
        self.assertEqual(later, [], "a later body exists: 0172 must be rebuilt on it")
        self.assertEqual(pg_md5(LOTS_0167), LOTS_BEFORE)

    def test_every_0167_line_survives_in_order_and_every_new_line_is_marked(self):
        assert_latest_plus_marked(self, LOTS_0167, LOTS_0172, [])

    def test_the_setting_is_read_for_adjust_rows_only_and_names_a_lot_of_this_org(self):
        hunk = LOTS_0172.split("elsif new.kind = 'adjust' then", 1)[1].split("    end if;\n    perform public.credit_lots_spend_locked", 1)[0]
        self.assertIn("nightshift.reverse_lot", hunk)
        self.assertIn("where l.org_id = new.org_id", hunk)
        self.assertEqual(LOTS_0172.count("nightshift.reverse_lot"), 1)


class Collector(unittest.TestCase):
    def test_it_fires_for_releases_of_a_hold_only_and_after_the_refund_collector(self):
        self.assertIn("create trigger credit_transactions_recover_reversals after insert on public.credit_transactions\n"
                      "  for each row when (new.kind = 'release' and new.amount > 0 and new.job_id is not null)\n"
                      "  execute function public.credit_grant_reversal_recover();", SQL)
        self.assertLess("credit_transactions_recover_refunds", "credit_transactions_recover_reversals")
        self.assertIn("array['credit_transactions_apply_lots', 'credit_transactions_recover_refunds', 'credit_transactions_recover_reversals']",
                      SQL)

    def test_it_collects_only_for_holds_on_the_grants_lot_at_the_reversal(self):
        self.assertIn("new.job_id = any (r.holds)", RECOVER)
        self.assertIn("r.collected + r.lapsed < r.owed", RECOVER)
        self.assertIn("order by r.created_at, r.grant_txn_id", RECOVER)
        first = RECOVER.split("return null;", 1)[0]
        self.assertNotIn("credit_lot_moves", first, "a release that meets no recovery reads only the open index")

    def test_a_release_pays_at_most_what_it_gave_back_to_the_lot_less_what_an_earlier_collector_took(self):
        self.assertIn("where m.job_id = new.job_id and m.txn_id = new.id and m.kind = 'release' and m.lot_id = lot.id;", RECOVER)
        self.assertIn("where m.lot_id = lot.id and m.kind = 'spend' and m.txn_id > new.id;", RECOVER)
        self.assertIn("x := least(owing, back - gone, lot.remaining - lot.held, coalesce(avail, 0));", RECOVER)
        self.assertIn("greatest(a.balance - a.reserved, 0)", RECOVER)
        self.assertIn("continue when x <= 0;", RECOVER)

    def test_every_collection_is_an_adjust_row_from_the_grants_lot_written_as_the_platform(self):
        self.assertNotIn("credit_log(", RECOVER)
        self.assertNotIn("auth.uid()", RECOVER)
        ins = RECOVER.split("insert into public.credit_transactions", 1)[1].split(";", 1)[0]
        self.assertTrue(ins.rstrip().endswith("null)"), ins)
        self.assertIn("note, created_by)", ins)
        self.assertIn("'adjust', -x, acc.balance, acc.reserved, null, null,", ins)
        self.assertLess(RECOVER.index("perform set_config('nightshift.reverse_lot', lot.id::text, true);"),
                        RECOVER.index("insert into public.credit_transactions"))
        self.assertLess(RECOVER.index("insert into public.credit_transactions"),
                        RECOVER.index("perform set_config('nightshift.reverse_lot', '', true);"))
        self.assertLess(RECOVER.index("set balance = balance - x"), RECOVER.index("insert into public.credit_transactions"))

    def test_an_expired_grant_lot_counts_as_lapsed_without_a_ledger_row(self):
        lapsed = RECOVER.split("if lot.expired_at is not null", 1)[1].split("end if;", 1)[0]
        self.assertIn("set lapsed = lapsed + least(owing, back)", lapsed)
        self.assertNotIn("insert into", lapsed)

    def test_definer_with_a_pinned_search_path(self):
        head = definition(SQL, "credit_grant_reversal_recover").split("$$", 1)[0]
        self.assertIn("returns trigger\n  language plpgsql security definer set search_path = public, pg_temp", head)


class TableAndPrivileges(unittest.TestCase):
    def test_the_record_is_closed_but_for_a_service_role_read(self):
        self.assertIn("alter table public.credit_grant_reversal_recoveries enable row level security;", CODE)
        self.assertIn("revoke all on public.credit_grant_reversal_recoveries from public, anon, authenticated, service_role;", CODE)
        self.assertIn("grant select on public.credit_grant_reversal_recoveries to service_role;", CODE)
        self.assertNotRegex(CODE, r"create policy")
        self.assertNotRegex(CODE, r"grant [^;]*(insert|update|delete)[^;]* on public\.credit_grant_reversal_recoveries")

    def test_only_collected_and_lapsed_move_and_only_up(self):
        self.assertIn("check (owed > 0 and collected >= 0 and lapsed >= 0 and collected + lapsed <= owed)", CODE)
        self.assertIn("or new.collected < old.collected", CODE)
        self.assertIn("or new.lapsed < old.lapsed then", CODE)
        self.assertIn("or new.lot_id is distinct from old.lot_id", CODE)
        self.assertIn("before update or delete on public.credit_grant_reversal_recoveries", CODE)
        self.assertIn("before truncate on public.credit_grant_reversal_recoveries", CODE)

    def test_function_grants(self):
        for fn in ("credit_grant_reversal_recoveries_guard()", "credit_grant_reversal_recover()", "credit_transactions_apply_lots()"):
            self.assertIn(f"revoke all on function public.{fn} from public, anon, authenticated, service_role;", CODE)

    def test_nothing_existing_is_dropped_or_rewritten(self):
        self.assertNotRegex(CODE, r"(?i)drop (table|function|column|policy|index)")
        self.assertEqual(re.findall(r"create or replace function public\.(\w+)\(", CODE),
                         ["credit_grant_reversal_recoveries_guard", "owner_reverse_grant", "credit_transactions_apply_lots",
                          "credit_grant_reversal_recover"])


class HashesAndRollback(unittest.TestCase):
    def test_the_drift_guard_end_state_and_verify_name_the_bodies_own_hashes(self):
        rev, lots, rec = pg_md5(REVERSE_0172), pg_md5(LOTS_0172), pg_md5(RECOVER)
        self.assertIn(f"array['{REVERSE_BEFORE}', '{rev}']", SQL)
        self.assertIn(f"array['{LOTS_BEFORE}', '{lots}']", SQL)
        self.assertIn(f"c <> '{rec}'", SQL)
        end = SQL.split("6. End state", 1)[1]
        for h in (rev, lots, rec):
            self.assertIn(f"<> '{h}'", end)
        self.assertIn(f"= '{rev}' as reverse_body", SQL)
        self.assertIn(f"= '{lots}' as lots_body", SQL)
        self.assertIn(f"owner_reverse_grant             {REVERSE_BEFORE}", SQL)
        self.assertIn(f"credit_transactions_apply_lots  {LOTS_BEFORE}", SQL)
        self.assertIn(f"owner_reverse_grant             {rev}", SQL)
        self.assertIn(f"credit_transactions_apply_lots  {lots}", SQL)
        self.assertIn(f"credit_grant_reversal_recover   {rec}", SQL)

    def test_the_file_is_one_transaction_with_a_lock_timeout_and_a_verify_query(self):
        self.assertIn("set local lock_timeout = '5s';", SQL)
        self.assertNotRegex(SQL, r"(?m)^(begin|commit);$")
        self.assertIn("-- Verify", SQL)

    def test_the_open_recoveries_query_requires_a_hold_that_can_still_be_released(self):
        footer = SQL.split("-- Reversals whose held part is still open", 1)[1]
        self.assertIn("where r.collected + r.lapsed < r.owed", footer)
        self.assertIn("and exists (select 1 from public.credit_reservations c where c.job_id = any (r.holds) and c.status = 'open')", footer)

    def test_the_rollback_puts_0107s_and_0167s_bodies_back_verbatim_and_refuses_another(self):
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)
        self.assertEqual(definition(ROLLBACK, "owner_reverse_grant"), definition(BASE_0107, "owner_reverse_grant"))
        self.assertEqual(definition(ROLLBACK, "credit_transactions_apply_lots"), definition(BASE_0167, "credit_transactions_apply_lots"))
        self.assertIn(f"o is distinct from '{pg_md5(REVERSE_0172)}'", ROLLBACK)
        self.assertIn(f"a is distinct from '{pg_md5(LOTS_0172)}'", ROLLBACK)
        self.assertIn(f"c <> '{pg_md5(RECOVER)}'", ROLLBACK)
        self.assertIn(f"<> '{REVERSE_BEFORE}'", ROLLBACK)
        self.assertIn(f"<> '{LOTS_BEFORE}'", ROLLBACK)
        self.assertIn("drop trigger if exists credit_transactions_recover_reversals on public.credit_transactions;", ROLLBACK)
        self.assertIn("drop function if exists public.credit_grant_reversal_recover();", ROLLBACK)
        self.assertNotIn("drop table", ROLLBACK)
        self.assertIn("grant execute on function public.owner_reverse_grant(bigint, text) to authenticated;", ROLLBACK)


class Numbering(unittest.TestCase):
    def test_the_number_is_unique_and_documented(self):
        numbers = [p.name[:4] for p in MIG.glob("*.sql")]
        self.assertEqual(numbers.count("0172"), 1)
        self.assertIn("## An owner's grant reversal that met a hold collects when the hold is released (0172)", MIGRATIONS_DOC)

    def test_the_ledger_row_is_fixed(self):
        row = next(ln for ln in LEDGER.splitlines() if ln.startswith("| BR-0107-01 |"))
        self.assertIn("| fixed |", row)
        self.assertIn("0172", row)


if __name__ == "__main__":
    unittest.main()
