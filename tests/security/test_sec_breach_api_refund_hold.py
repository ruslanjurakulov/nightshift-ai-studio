"""Lens, an independent review of the refund paths: api_refund_topup (0031) takes back only what is AVAILABLE on the API balance
(balance_cents - reserved_cents) and records the rest as "already spent and NOT recovered", for good. A hold is not spending, and the
customer makes the holds with their own API key: top up, hold everything with API runs, have the top-up refunded or charged back
(taken 0), then let the runs fail (a channel pointed at an unavailable voice stops before spending, CLAUDE.md rule 4). The failed jobs
release their holds in full: the customer has the money back AND the balance, which buys real provider spend.

BR-0031-01  Same class as BR-0034-01 (site credits). Pre-existing on main.
"""

from __future__ import annotations

from sec_db import as_superuser

from sec_api_refund_lab import account, customer, end_job, hold_status, refund, run, topup


def test_BR_0031_01_api_holds_placed_before_a_refund_do_not_let_the_customer_keep_the_refunded_balance(conn):
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        assert account(s, c.org) == (0, 0)
        ext = topup(s, c, 5000)

        # Everything held by two API runs, then the top-up is refunded in full.
        job1, ref1, p1 = run(s, c, 1250)
        job2, ref2, p2 = run(s, c, 1250)
        assert (p1, p2) == (2500, 2500) and account(s, c.org) == (5000, 5000)
        _rid, out = refund(s, ext)
        assert out["requested_cents"] == 5000

        # The runs stop before they spend anything; the worker marks them failed and 0031 releases both holds in full.
        end_job(s, job1, "failed")
        end_job(s, job2, "failed")
        assert (hold_status(s, ref1), hold_status(s, ref2)) == ("released", "released")

        balance, _reserved = account(s, c.org)
        assert balance == 0, (
            f"refunded in full, yet the API balance kept {balance} cents of it (0 before the top-up): the refund met two holds, "
            "recorded a shortfall for good, and the holds were then released back to the customer")
