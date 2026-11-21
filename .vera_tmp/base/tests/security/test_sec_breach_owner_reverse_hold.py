"""Found with BR-0031-01's root-cause search: owner_reverse_grant (0107) takes back only the part of a grant that is neither held nor
unavailable (v_unspent := l.remaining - l.held, then least(..., balance - reserved)) and records the reversal under
'owner-reverse:<grant id>'. A partial reversal is therefore final: the retry answers duplicate, and when the hold that covered the rest
is released the organization keeps those credits for good. Its 'adjust' row also spends in normal lot order, not from the grant's lot.

BR-0107-01  low. Pre-existing on main; a platform owner/admin has to make the grant and the reversal. Fixed by migration 0172: the held
part of the shortfall is owed (credit_grant_reversal_recoveries) and collected from the grant's own lot when the hold is released, by a
collector that fires after 0167's on credit_transactions and shares its per-release cap. The variants are in
test_sec_grant_reversal_hold_recovery.py.
"""

from __future__ import annotations

import json
import uuid

from sec_db import SERVICE, as_superuser

REASON = "granted to the wrong workspace by mistake"


def _as(s, actor, aal=True):
    claims = actor.claims()
    if aal:
        claims["aal"] = "aal1"
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(claims)])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [actor.role])
    s.conn.execute("set local role " + actor.role)


def _owner(s):
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', '', true)")


def _value(s, actor, query, params=None):
    _as(s, actor)
    try:
        return s.value(query, params)
    finally:
        _owner(s)


def test_BR_0107_01_a_grant_reversed_while_partly_held_does_not_stay_with_the_org_when_the_hold_is_released(conn, sc):
    with as_superuser(conn, commit=False) as s:
        org = sc.bob.org
        bal = "select balance from public.credit_accounts where org_id = %s"
        before = s.value(bal, [org])
        g = _value(s, sc.operator, "select public.owner_grant_credits(%s, 100, %s, %s)", [org, REASON, f"key-br0107-{uuid.uuid4().hex[:8]}"])
        assert g["ok"] is True, g

        # A run holds all but 30 of what is available; the owner reverses the grant: 30 taken, 70 recorded as a shortfall.
        job = f"rj-br0107-{uuid.uuid4().hex[:8]}"
        avail = s.value("select balance - reserved from public.credit_accounts where org_id = %s", [org])
        assert _value(s, sc.bob.actor, "select public.reserve_credits(%s, %s, %s)", [org, job, avail - 30]) is not None
        out = _value(s, sc.operator, "select public.owner_reverse_grant(%s, %s)", [g["transaction_id"], REASON])
        assert (out["ok"], out["reversed"], out["shortfall"]) == (True, 30, 70), out

        # The run never starts; its hold is released. A retry of the reversal is a duplicate.
        assert _value(s, SERVICE, "select public.release_credits(%s)", [job]) > 0
        again = _value(s, sc.operator, "select public.owner_reverse_grant(%s, %s)", [g["transaction_id"], REASON])
        assert again["duplicate"] is True, again

        after = s.value(bal, [org])
        assert after == before, (
            f"the grant was reversed, yet the workspace kept {after - before} of its 100 credits: the reversal met a hold, recorded "
            "the rest as a shortfall for good, and the hold was then released back to the workspace")
