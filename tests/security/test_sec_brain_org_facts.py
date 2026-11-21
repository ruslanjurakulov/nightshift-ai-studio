"""0201: brain_org_facts(p_org) answers for the caller's OWN organization and nothing else.

It feeds the customer's Nightshift Brain dashboard and the Nightshift AI's customer facts, so a leak here
would put one tenant's spend, videos or memory in another tenant's chat. These prove, against a real
Postgres:

* a member reads their own org; a member of ANOTHER org, a stranger, anon and the service key get null or
  are refused, so the function cannot be used to probe whether an org exists;
* the answer carries nothing that is a cost or a margin: no vendor cost, no price list, no margin key, at
  any depth, even after this org was charged;
* spend is grouped by what charged it, a creative job by its capability, and only this org's captures count
  (another org's capture on the same day changes nothing);
* the 14-day series has 14 days, zeros included.
"""

from __future__ import annotations

import json
import uuid

from sec_db import ANON, SERVICE, acting

FORBIDDEN_KEYS = ("cost", "margin", "credits_per_unit", "price", "usd", "vendor", "provider_cost", "unit_cost")


def _facts(conn, who, org):
    with acting(conn, who) as s:
        out = s.run("select public.brain_org_facts(%s)", [org])
    return out


def _keys(v, path=""):
    if isinstance(v, dict):
        for k, x in v.items():
            yield f"{path}.{k}", k
            yield from _keys(x, f"{path}.{k}")
    elif isinstance(v, list):
        for x in v:
            yield from _keys(x, path)


def _ledger(conn, org, job_id, amount, kind):
    conn.execute("set local session_replication_role = replica")
    conn.execute(
        "insert into public.credit_transactions (org_id, kind, amount, balance_after, reserved_after, job_id) "
        "values (%s, %s, %s, 0, 0, %s)", [org, kind, amount, job_id])
    conn.execute("set local session_replication_role = origin")


def _capture(conn, org, job_id, amount):
    """A capture row as the ledger records one, inside the caller's rolled-back transaction. Replica mode skips the
    lots bookkeeping trigger: this test is about what brain_org_facts READS, not about how a charge is taken."""
    conn.execute("set local session_replication_role = replica")
    conn.execute(
        "insert into public.credit_transactions (org_id, kind, amount, balance_after, reserved_after, job_id) "
        "values (%s, 'capture', %s, 0, 0, %s)", [org, -amount, job_id])
    conn.execute("set local session_replication_role = origin")


def test_a_member_reads_their_own_org(conn, sc):
    out = _facts(conn, sc.alice.actor, sc.alice.org)
    assert out.ok, out
    facts = out.rows[0][0]
    assert facts is not None
    assert facts["org_id"] == sc.alice.org
    assert len(facts["credits"]["daily_14d"]) == 14


def test_another_org_a_stranger_anon_and_the_service_key_get_nothing(conn, sc):
    # Bob asking for Alice's org reads exactly what a made-up org reads: null.
    for who, org in ((sc.bob.actor, sc.alice.org), (sc.stranger, sc.alice.org), (sc.alice.actor, str(uuid.uuid4()))):
        out = _facts(conn, who, org)
        assert out.ok, out
        assert out.rows[0][0] is None, f"{who} read {org}"
    for who in (ANON, SERVICE):
        out = _facts(conn, who, sc.alice.org)
        assert not out.ok and out.sqlstate == "42501", f"{who} may call brain_org_facts"


def test_no_cost_price_or_margin_anywhere_even_after_a_charge(conn, sc):
    with conn.transaction(force_rollback=True):
        _capture(conn, sc.alice.org, f"cj:{uuid.uuid4()}", 7)
        facts = _facts(conn, sc.alice.actor, sc.alice.org).rows[0][0]
    for where, key in _keys(facts):
        low = key.lower()
        assert not any(f in low for f in FORBIDDEN_KEYS), f"{where} looks like a cost or a margin"
    text = json.dumps(facts).lower()
    assert "margin" not in text and "video_costs" not in text


def test_spend_is_this_orgs_own_and_named_by_tool(conn, sc):
    before = _facts(conn, sc.alice.actor, sc.alice.org).rows[0][0]["credits"]
    with conn.transaction(force_rollback=True):
        _capture(conn, sc.alice.org, "rj-" + uuid.uuid4().hex, 11)
        _capture(conn, sc.bob.org, "rj-" + uuid.uuid4().hex, 500)  # another tenant, same day
        after = _facts(conn, sc.alice.actor, sc.alice.org).rows[0][0]["credits"]
        # Bob's own read sees his charge, never Alice's.
        bob = _facts(conn, sc.bob.actor, sc.bob.org).rows[0][0]["credits"]["spend_by_tool_14d"]
    run = lambda c: float(c["spend_by_tool_14d"].get("run", 0))  # noqa: E731
    assert run(after) - run(before) == 11.0
    assert float(bob.get("run", 0)) >= 500.0
    # and today's point of the series moved by the same 11
    assert float(after["daily_14d"][-1]["credits"]) - float(before["daily_14d"][-1]["credits"]) == 11.0


def test_another_orgs_videos_are_not_listed(conn, sc):
    facts = _facts(conn, sc.alice.actor, sc.alice.org).rows[0][0]
    ids = {v["video_id"] for v in facts["projects"]["recent_videos"]}
    assert sc.bob.video not in ids
    assert all(v["channel_id"] != sc.bob.channel for v in facts["projects"]["recent_videos"])


def test_a_refunded_job_is_not_counted_as_spent(conn, sc):
    """0030: a failed download is captured, then refunded under the same ref; it cost nothing."""
    ref = f"download:{uuid.uuid4().int % 10**9}"
    before = _facts(conn, sc.alice.actor, sc.alice.org).rows[0][0]["credits"]["spend_by_tool_14d"]
    with conn.transaction(force_rollback=True):
        _ledger(conn, sc.alice.org, ref, -9, "capture")
        _ledger(conn, sc.alice.org, ref, 9, "refund")
        after = _facts(conn, sc.alice.actor, sc.alice.org).rows[0][0]["credits"]["spend_by_tool_14d"]
    assert float(after.get("download", 0)) == float(before.get("download", 0))


def test_production_refs_are_named_by_their_tool(conn, sc):
    """The refs as production writes them (lib/credits.ts newCreditRef, 0031, 0076, 0081, 0133, 0137)."""
    refs = {
        "gh-" + uuid.uuid4().hex: "run",
        "ah-" + uuid.uuid4().hex: "run",
        "rj-sr-" + uuid.uuid4().hex: "scene_regenerate",
        "bs:" + str(uuid.uuid4()): "brand_scan",
        "cs:" + str(uuid.uuid4()): "character_swap",
        "rd:" + str(uuid.uuid4()): "reply_draft",
    }
    with conn.transaction(force_rollback=True):
        for ref in refs:
            _capture(conn, sc.alice.org, ref, 1)
        got = _facts(conn, sc.alice.actor, sc.alice.org).rows[0][0]["credits"]["spend_by_tool_14d"]
    for tool in set(refs.values()):
        assert float(got.get(tool, 0)) >= 1.0, f"{tool} not tagged: {got}"
    assert "other" not in got or float(got["other"]) == 0.0, got
