"""Breach, found while attacking 0165's refund path: refund_purchased_credits (0021, body of 0034) takes back only what is
AVAILABLE (balance - reserved) and records the rest as a permanent shortfall. A hold is not spending: the buyer holds every
credit (reserve_credits, callable by the workspace's owner/admin from the browser) before the refund lands, the refund takes 0,
and three hours later the unstarted hold is released (expire_credit_reservations, or lazily by the next reserve_credits). The
buyer has the money back AND the credits.

BR-0034-01  Pre-existing (not introduced by 0165; present on main). Kept as a failing test until fixed.
"""

from __future__ import annotations

import json
import uuid

from sec_db import SERVICE, as_superuser, user


def _as_owner(s):
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', '', true)")


def _call(s, actor, query, params=None):
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(actor.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [actor.role])
    s.conn.execute("set local role " + actor.role)
    out = s.run(query, params)
    _as_owner(s)
    return out


def _ok(out):
    assert out.ok, out
    return out.rows[0][0] if out.rows else None


def test_BR_0034_01_a_hold_placed_before_a_refund_does_not_let_the_buyer_keep_the_refunded_credits(conn):
    with as_superuser(conn, commit=False) as s:
        buyer = user("buyer", f"buyer-{uuid.uuid4().hex[:8]}@lab.test")
        s.rows("insert into auth.users (id, email, email_confirmed_at, created_at) values (%s, %s, now(), now()) returning 1",
               [buyer.uid, buyer.email])
        org = str(_ok(_call(s, buyer, "select public.create_organization(%s)", [f"WS {uuid.uuid4().hex[:6]}"])))
        bal = "select balance from public.credit_accounts where org_id = %s"
        before_purchase = s.value(bal, [org]) or 0

        ext = f"pay_lab{uuid.uuid4().hex[:16]}"
        _ok(_call(s, SERVICE, "select public.add_purchased_credits(%s, 1000, %s, 'lab purchase')", [org, ext]))

        # Everything held by a "run" that will never start, then the payment is refunded in full.
        job = f"rj-breach-{uuid.uuid4().hex[:8]}"
        avail = s.value("select balance - reserved from public.credit_accounts where org_id = %s", [org])
        _ok(_call(s, buyer, "select public.reserve_credits(%s, %s, %s)", [org, job, avail]))
        _ok(_call(s, SERVICE, "select public.refund_purchased_credits(%s, %s, null, 'lab', 'refund')",
                  [ext, f"rf_{uuid.uuid4().hex[:12]}"]))

        # Three hours later the hold has not started a run: the platform gives it back.
        s.rows("update public.credit_reservations set created_at = now() - interval '3 hours 1 minute' where job_id = %s "
               "returning 1", [job])
        _ok(_call(s, SERVICE, "select public.expire_credit_reservations(%s)", [org]))
        assert s.value("select status from public.credit_reservations where job_id = %s", [job]) != "open"

        after = s.value(bal, [org])
        assert after <= before_purchase, (
            f"refunded in full, yet the workspace kept the credits: balance {after}, {before_purchase} before the purchase "
            "(the refund met a hold, recorded a shortfall for good, and the hold was then released)")
