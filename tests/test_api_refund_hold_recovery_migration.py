"""supabase/migrations/0168_api_refund_hold_recovery.sql — a refund of an API top-up that meets a hold collects when the hold is released
(BR-0031-01).

SQL does not run in this suite (tests/security/test_sec_breach_api_refund_hold.py and test_sec_api_refund_hold_recovery.py do that,
against a real Postgres). These pin what must never change by accident: api_refund_topup is 0031's body line for line plus lines marked
`-- 0168`, so no refusal, idempotency rule or string 0031 had is lost; the drift guard, end state, verify query and rollback carry the
bodies' own md5; the collector is a trigger on release rows only, pays at most what the release gave back and writes its ledger row as
the platform (never the customer); the new table is closed to every API role but a service-role read; the rollback puts 0031's body
back verbatim; the number is unique and documented.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
SQL = (MIG / "0168_api_refund_hold_recovery.sql").read_text(encoding="utf-8")
BASE = (MIG / "0031_public_api.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0168_api_refund_hold_recovery.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
PADDLE = (ROOT / "supabase" / "functions" / "_shared" / "paddle.ts").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())

BEFORE = "a9d2287173b12b704808e7b3747b05e0"


def definition(sql: str, name: str) -> str:
    m = re.search(r"^create or replace function public\." + name + r"\(.*?^\$\$;$", sql, re.S | re.M)
    assert m, name
    return m.group(0)


def body(sql: str, name: str) -> str:
    return definition(sql, name).split("$$", 1)[1].rsplit("$$;", 1)[0]


def pg_md5(text: str) -> str:
    """md5(regexp_replace(prosrc, '\\s+', ' ', 'g')), the hash every drift guard in this repository uses."""
    return hashlib.md5(re.sub(r"\s+", " ", text, flags=re.ASCII).encode()).hexdigest()


REFUND_0031 = body(BASE, "api_refund_topup")
REFUND_0168 = body(SQL, "api_refund_topup")
RECOVER = body(SQL, "api_refund_recover")


class RefundBodyIsTheLatestPlusMarkedLines(unittest.TestCase):
    def test_0031_is_the_latest_body_before_this_file(self):
        later = [p.name for p in sorted(MIG.glob("*.sql"))
                 if "0031" < p.name[:4] < "0168"
                 and "function public.api_refund_topup(" in p.read_text(encoding="utf-8")]
        self.assertEqual(later, [], "a later body exists: 0168 must be rebuilt on it")
        self.assertEqual(pg_md5(REFUND_0031), BEFORE)

    def test_every_0031_line_survives_in_order_and_every_new_line_is_marked(self):
        old = REFUND_0031.splitlines()
        dropped = ["  if short > 0 then"]
        it = iter(REFUND_0168.splitlines())

        def marked(got):
            # New code carries the marker; a blank line, or one that is only a comment (the marked block's explanation), changes nothing.
            return "-- 0168" in got or got.lstrip().startswith("--") or not got.strip()

        for line in old:
            if line in dropped:
                continue
            for got in it:
                if got == line:
                    break
                self.assertTrue(marked(got), f"an unmarked line that is not 0031's: {got!r}")
            else:
                self.fail(f"0031's line is missing or out of order: {line!r}")
        for rest in it:
            self.assertTrue(marked(rest), rest)
        # The one 0031 line that changed is named where it went.
        self.assertIn("elsif short > 0 then  -- 0168 (0031: if short > 0 then)", REFUND_0168)

    def test_every_string_literal_of_0031_is_still_there(self):
        code = "\n".join(line.split("--", 1)[0] for line in REFUND_0031.splitlines())  # an apostrophe in a comment is not a quote
        lits = set(re.findall(r"'(?:[^']|'')*'", code))
        self.assertGreaterEqual(len(lits), 10)
        for lit in lits:
            self.assertIn(lit, REFUND_0168, lit)

    def test_the_refusals_and_the_idempotency_come_first_as_before(self):
        b = REFUND_0168
        self.assertLess(b.index("if not public.credits_trusted_caller() then"), b.index("api_account_lock"))
        self.assertLess(b.index("select * into prior from public.api_ledger where external_id = rid;"),
                        b.index("insert into public.api_refund_recoveries"))
        # A duplicate returns before anything is written, and answers what was recorded.
        dup = b.split("if prior.id is not null then", 1)[1].split("  end if;\n  select coalesce(sum(l.requested_cents), 0)", 1)[0]
        self.assertIn("return jsonb_build_object('duplicate', true,", dup)
        self.assertNotIn("insert into", dup)
        self.assertNotIn("update public", dup)
        self.assertIn("'on_hold_cents', coalesce((select r.owed from public.api_refund_recoveries r where r.refund_id = rid), 0)", dup)

    def test_the_held_part_is_bounded_by_the_shortfall_and_by_what_is_on_hold(self):
        self.assertIn("held := least(short, acc.reserved_cents, on_hold);", REFUND_0168)
        self.assertIn("from public.api_holds h where h.org_id = topup.org_id and h.status = 'open';", REFUND_0168)
        # Recorded inside the same call, after the account lock, so no hold opens or settles in between.
        self.assertLess(REFUND_0168.index("acc := public.api_account_lock(topup.org_id);"), REFUND_0168.index("held := least"))
        # The answer carries it; the ledger note no longer calls held cents spent.
        self.assertIn("'on_hold_cents', held,  -- 0168", REFUND_0168)
        self.assertIn("%s on hold (taken back if the hold is released, not if it is spent), %s already spent and NOT recovered",
                      REFUND_0168)

    def test_same_signature_definer_and_search_path(self):
        head = definition(SQL, "api_refund_topup").split("$$", 1)[0]
        self.assertEqual(head, definition(BASE, "api_refund_topup").split("$$", 1)[0])
        self.assertIn("language plpgsql volatile security definer set search_path = public, pg_temp", head)


class Collector(unittest.TestCase):
    def test_it_fires_for_releases_of_a_hold_only(self):
        self.assertIn("create trigger api_ledger_recover_refunds after insert on public.api_ledger\n"
                      "  for each row when (new.kind = 'release' and new.amount_cents > 0 and new.hold_ref is not null)\n"
                      "  execute function public.api_refund_recover();", SQL)

    def test_it_collects_only_for_a_real_release_of_a_hold_open_at_the_refund(self):
        self.assertIn("h.status <> 'released' or h.amount_cents <> new.amount_cents then", RECOVER)
        self.assertIn("new.hold_ref = any (r.holds)", RECOVER)
        self.assertIn("r.collected < r.owed", RECOVER)
        self.assertIn("order by r.refund_ledger_id", RECOVER)

    def test_a_release_pays_at_most_what_it_gave_back_and_never_more_than_is_there(self):
        self.assertIn("left_ bigint := new.amount_cents;", RECOVER)
        self.assertIn("x := least(rec.owed - rec.collected, left_, coalesce(avail, 0));", RECOVER)
        self.assertIn("greatest(a.balance_cents - a.reserved_cents, 0)", RECOVER)
        self.assertIn("exit when x <= 0;", RECOVER)
        self.assertIn("exit when left_ <= 0;", RECOVER)
        self.assertIn("left_ := left_ - x;", RECOVER)

    def test_every_collection_is_a_ledger_row_written_as_the_platform(self):
        # Not api_log: it stamps auth.uid(), which is the customer when the release ran inside their own API call.
        self.assertNotIn("api_log(", RECOVER)
        self.assertNotIn("auth.uid()", RECOVER)
        ins = RECOVER.split("insert into public.api_ledger", 1)[1].split(";", 1)[0]
        self.assertTrue(ins.rstrip().endswith("null)"), ins)
        self.assertIn("note, created_by)", ins)
        self.assertIn("'refund', -x, acc.balance_cents, acc.reserved_cents, null,", ins)
        self.assertLess(RECOVER.index("set balance_cents = balance_cents - x"), RECOVER.index("insert into public.api_ledger"))

    def test_definer_with_a_pinned_search_path(self):
        head = definition(SQL, "api_refund_recover").split("$$", 1)[0]
        self.assertIn("returns trigger\n  language plpgsql security definer set search_path = public, pg_temp", head)


class TableAndPrivileges(unittest.TestCase):
    def test_the_record_is_closed_but_for_a_service_role_read(self):
        self.assertIn("alter table public.api_refund_recoveries enable row level security;", CODE)
        self.assertIn("revoke all on public.api_refund_recoveries from public, anon, authenticated, service_role;", CODE)
        self.assertIn("grant select on public.api_refund_recoveries to service_role;", CODE)
        self.assertNotRegex(CODE, r"create policy")
        self.assertNotRegex(CODE, r"grant [^;]*(insert|update|delete)[^;]* on public\.api_refund_recoveries")

    def test_only_collected_moves_and_only_up(self):
        self.assertIn("check (owed > 0 and collected >= 0 and collected <= owed)", CODE)
        self.assertIn("or new.collected < old.collected then", CODE)
        self.assertIn("before update or delete on public.api_refund_recoveries", CODE)
        self.assertIn("before truncate on public.api_refund_recoveries", CODE)

    def test_function_grants(self):
        for fn in ("api_refund_recoveries_guard()", "api_refund_recover()"):
            self.assertIn(f"revoke all on function public.{fn} from public, anon, authenticated, service_role;", CODE)
        self.assertIn("revoke all on function public.api_refund_topup(text, text, bigint, text, text) from public, anon, authenticated;", CODE)
        self.assertIn("grant execute on function public.api_refund_topup(text, text, bigint, text, text) to service_role;", CODE)
        self.assertEqual(len(re.findall(r"grant execute", CODE)), 1)

    def test_nothing_existing_is_dropped_or_rewritten(self):
        self.assertNotRegex(CODE, r"(?i)drop (table|function|column|policy|index)")
        self.assertEqual(re.findall(r"create or replace function public\.(\w+)\(", CODE),
                         ["api_refund_recoveries_guard", "api_refund_topup", "api_refund_recover"])


class HashesAndRollback(unittest.TestCase):
    def test_the_drift_guard_end_state_and_verify_name_the_bodies_own_hashes(self):
        after, recover = pg_md5(REFUND_0168), pg_md5(RECOVER)
        self.assertIn(f"array['{BEFORE}', '{after}']", SQL)
        self.assertIn(f"c <> '{recover}'", SQL)
        end = SQL.split("5. End state", 1)[1]
        self.assertIn(f"<> '{after}'", end)
        self.assertIn(f"<> '{recover}'", end)
        self.assertIn(f"= '{after}' as refund_body", SQL)
        self.assertIn(f"expected BEFORE (0031 applied, 0168 not): {BEFORE}", SQL)
        self.assertIn(f"api_refund_topup     {after}", SQL)
        self.assertIn(f"api_refund_recover   {recover}", SQL)

    def test_the_file_is_one_transaction_with_a_lock_timeout_and_a_verify_query(self):
        self.assertIn("set local lock_timeout = '5s';", SQL)
        self.assertNotRegex(SQL, r"(?m)^(begin|commit);$")
        self.assertIn("-- Verify", SQL)

    def test_the_header_names_the_lock_a_re_run_takes(self):
        # Lens N1: a re-run's DROP TRIGGER of the trigger already there takes ACCESS EXCLUSIVE on api_ledger (measured on PG16).
        head = " ".join(ln.lstrip("- ") for ln in SQL.split("set local lock_timeout", 1)[0].splitlines())
        self.assertIn("on a RE-RUN the DROP TRIGGER IF EXISTS of the trigger already there takes ACCESS EXCLUSIVE on api_ledger", head)
        self.assertIn("CREATE TRIGGER takes SHARE ROW EXCLUSIVE on api_ledger", head)

    def test_the_open_recoveries_query_requires_a_hold_that_can_still_be_released(self):
        # Lens L1: a refund whose holds were all captured keeps collected < owed for good; it is not open.
        footer = SQL.split("-- Refunds whose held part is still open", 1)[1]
        self.assertIn("where r.collected < r.owed", footer)
        self.assertIn("and exists (select 1 from public.api_holds h where h.ref = any (r.holds) and h.status = 'open')", footer)

    def test_the_forged_second_release_is_named_with_who_could_write_one(self):
        # Lens N2: the released-hold check cannot tell a second release row of one hold from the first.
        self.assertIn("a forged duplicate would collect again", SQL)
        self.assertIn("Only the database\n-- owner, in the SQL editor, could insert such a row.", SQL)

    def test_the_rollback_puts_0031s_body_back_verbatim_and_refuses_another(self):
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)
        self.assertEqual(definition(ROLLBACK, "api_refund_topup"), definition(BASE, "api_refund_topup"))
        self.assertIn(f"r is distinct from '{pg_md5(REFUND_0168)}'", ROLLBACK)
        self.assertIn(f"c <> '{pg_md5(RECOVER)}'", ROLLBACK)
        self.assertIn(f"<> '{BEFORE}' then", ROLLBACK)
        self.assertIn("drop trigger if exists api_ledger_recover_refunds on public.api_ledger;", ROLLBACK)
        self.assertIn("drop function if exists public.api_refund_recover();", ROLLBACK)
        self.assertNotIn("drop table", ROLLBACK)
        self.assertIn("grant execute on function public.api_refund_topup(text, text, bigint, text, text) to service_role;", ROLLBACK)


class Webhook(unittest.TestCase):
    def test_the_paddle_webhook_reads_on_hold_and_no_longer_calls_held_cents_spent(self):
        self.assertIn("onHold: res.on_hold_cents === undefined || res.on_hold_cents === null ? null : n(res.on_hold_cents)", PADDLE)
        # 0031's log line called the whole shortfall spent; it now goes through apiShortfallWords, which keeps the held part apart.
        self.assertNotIn("${res.shortfall} API cents were already spent", PADDLE)
        self.assertEqual(PADDLE.count("apiShortfallWords(res.shortfall, res.onHold)"), 2)
        # Lens L2: a duplicate's recorded on-hold figure is not logged as today's.
        self.assertIn("if (res.shortfall > 0 && !res.duplicate)\n          log.warn(`paddle-webhook: ${decision.reason} ${decision.adjustmentId}: "
                      "${apiShortfallWords(res.shortfall, res.onHold)}`);", PADDLE)


class Numbering(unittest.TestCase):
    def test_the_number_is_unique_and_documented(self):
        numbers = [p.name[:4] for p in MIG.glob("*.sql")]
        self.assertEqual(numbers.count("0168"), 1)
        for n in ("0163", "0164", "0165", "0166", "0167"):
            self.assertNotIn(f"{n}_", SQL.split("\n", 1)[0])
        self.assertIn("## An API top-up refund that met a hold collects when the hold is released (0168)", MIGRATIONS_DOC)


if __name__ == "__main__":
    unittest.main()
