"""Breach: attacks on migration 0185 (frozen exchange rates), its route, and the export route's PDF / report.full.

The tests that PASS are attacks that were tried and held, kept so a later change cannot quietly reopen them. The one that
FAILS is a hole that is still open; it stays failing, never skipped, until the fix lands.

The open hole: a PDF export is built synchronously on the Command Center's only Node event loop, with no ceiling on rows.
Measured in the worktree (vitest, the real tablesToPdf + registerTable, a 120-character source column): about 14 ms per
register row and a 14 s event-loop stall for 1,000 rows, linear in the row count. The register reads up to 50,000 money rows
(readMoney's ceiling) for a period of up to 1,098 days, so one click of "PDF" on a busy three-year register stalls every
customer's request for ten minutes or more. Each cell is also shortened one character at a time (fit(): a full width
measurement per removed character, so quadratic in the cell's length): a 300-character cost note costs about 250 ms per cell.
There is no rate limit on exports, so a double click stacks two stalls. Every world is rolled back.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from sec_db import ANON, acting, user

REPO = Path(__file__).resolve().parents[2]
CC = REPO / "command-center"

WRITES = [
    "select public.owner_analytics_fx_set('2026-10-02', 'USD', 12000, 'CBU')",
    "select public.owner_analytics_fx_delete('2026-10-01', 'USD')",
]
READS = ["select * from public.owner_analytics_fx_rates('2026-01-01', '2026-12-31')"]


# ── what held ──────────────────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("q", READS + WRITES)
def test_a_forged_email_claim_of_the_owner_does_not_reach_the_rates(conn, sc, q):
    # A fresh account whose token carries the owner's e-mail but its own sub: platform_role() keys on auth.uid().
    impostor = user("fx-impostor", sc.operator.email)
    with acting(conn, impostor) as s:
        out = s.run(q)
    assert not out.ok and out.sqlstate == "42501", out


@pytest.mark.parametrize("q", READS + WRITES)
def test_authenticated_role_claims_without_a_sub_are_not_the_owner(conn, sc, q):
    forged = type(ANON)("forged", "authenticated")
    with acting(conn, forged) as s:
        out = s.run(q)
    assert not out.ok and out.sqlstate == "42501", out


@pytest.mark.parametrize("args", [
    "'2026-10-02', 'USD', 'Infinity'::numeric, 'CBU'",
    "'2026-10-02', 'USD', '-Infinity'::numeric, 'CBU'",
    "'2026-10-02', 'USD', 1e400, 'CBU'",
    "'2026-10-02', 'USD', 999999999.99996, 'CBU'",  # rounds to 1e9: the bound is checked after rounding
    "'2026-10-02', 'USD', -1, 'CBU'",
    "'2026-10-02', E'USD\\n', 1, 'CBU'",  # a trailing newline must not slip past the ^...$ grammar
    "'2026-10-02', 'ÀBC', 1, 'CBU'",
    "'2026-10-02', 'USD'' OR ''1''=''1', 1, 'CBU'",
    "'infinity', 'USD', 1, 'CBU'",
    "'2019-12-31', 'USD', 1, 'CBU'",
    "(now() at time zone 'Asia/Tashkent')::date + 1, 'USD', 1, 'CBU'",
    "'2026-10-02', 'USD', 1, repeat('x', 121)",
])
def test_a_rate_outside_the_grammar_is_refused(conn, sc, args):
    with acting(conn, sc.operator) as s:
        out = s.run(f"select public.owner_analytics_fx_set({args})")
    assert not out.ok and out.sqlstate == "22023", (args, out)


def test_the_rate_limit_stops_fx_writes_but_never_the_owner_reading(conn, sc):
    # The fx writes share 0183's 'owner:costs' bucket (60 per 10 minutes); a flood is refused with 54000 and reads go on.
    with acting(conn, sc.operator) as s:
        refused = None
        for _ in range(70):
            out = s.run("select public.owner_analytics_fx_set('2026-10-02', 'USD', 1, 'CBU')")
            if not out.ok:
                refused = out
                break
        delete = s.run("select public.owner_analytics_fx_delete('2026-10-02', 'USD')")
        read = s.run("select count(*) from public.owner_analytics_fx_rates('2026-01-01', '2026-12-31')")
    assert refused is not None and refused.sqlstate == "54000", refused
    assert not delete.ok and delete.sqlstate == "54000", delete
    assert read.ok, read


def test_a_payment_id_never_leaves_in_presentation_mode_from_the_register():
    # registerTable drops the payment column when presenting; report.full carries no table with a payment id at all.
    tax = (CC / "lib/owner-analytics/tax.ts").read_text()
    assert "...(present ? [] : [d.payment])" in tax and "...(present ? [] : [r.paymentRef])" in tax
    export = (CC / "lib/server/owner-analytics-export.ts").read_text()
    parts = re.search(r'const parts: Exportable\[\] = \[([^\]]*)\]', export)
    assert parts, "buildReport's part list moved: re-check that report.full carries no payment ids"
    assert "revenue.events" not in parts.group(1) and "tax.register" not in parts.group(1), parts.group(1)


# ── what is still open ─────────────────────────────────────────────────────────────────────────────────────────────────


def test_a_pdf_export_has_a_row_ceiling_before_it_blocks_the_event_loop():
    # OPEN (medium, availability). tablesToPdf draws every row synchronously; nothing bounds the rows a PDF may hold.
    # The fix this test expects: lib/server/owner-analytics-pdf.ts exports PDF_MAX_ROWS (a few thousand at most), and the
    # export route refuses a PDF whose tables hold more rows than that (an error that points at XLSX) BEFORE drawing anything.
    pdf = (CC / "lib/server/owner-analytics-pdf.ts").read_text()
    route = (CC / "app/api/owner-analytics/export/route.ts").read_text()
    declared = re.search(r"export const PDF_MAX_ROWS\s*=\s*([\d_]+)", pdf)
    assert declared, "lib/server/owner-analytics-pdf.ts has no PDF_MAX_ROWS: a 50,000-row register stalls the server for minutes"
    assert int(declared.group(1).replace("_", "")) <= 5000, declared.group(0)
    assert "PDF_MAX_ROWS" in route, "the export route does not refuse an over-long PDF before tablesToPdf runs"
