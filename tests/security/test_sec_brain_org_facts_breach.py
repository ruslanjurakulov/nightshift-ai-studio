"""Breach: attacks on brain_org_facts(p_org) (0202) beyond the happy-path contract in test_sec_brain_org_facts.py.

Each test is one attack a signed-up account, an invitee, a viewer of the operator's default org, a forged JWT or a
temp-table shadow could try. All rolled back; nothing is left in the lab.
"""

from __future__ import annotations

import time
import uuid

from sec_db import acting, as_superuser, user
from sec_scenario import DEFAULT_ORG, seat_invitee


def _facts(s, org):
    out = s.run("select public.brain_org_facts(%s)", [org])
    assert out.ok, out
    return out.rows[0][0]


def test_a_pending_invite_is_not_membership(conn, sc):
    # Ivan has an unbound org_members row for org A (email only). Asking for org A must read null.
    with acting(conn, sc.invitee) as s:
        assert _facts(s, sc.alice.org) is None


def test_a_seated_viewer_reads_their_org_and_still_not_the_other(conn, sc):
    with acting(conn, sc.invitee) as s:
        seat_invitee(s, sc)
        mine = _facts(s, sc.alice.org)
        assert mine is not None and mine["org_id"] == sc.alice.org
        assert _facts(s, sc.bob.org) is None


def test_a_default_org_viewer_cannot_read_a_customer_org(conn, sc):
    with acting(conn, sc.dana) as s:
        assert _facts(s, sc.alice.org) is None
        assert _facts(s, sc.bob.org) is None


def test_forged_claims_do_not_widen_access(conn, sc):
    # Alice's e-mail with a fresh uid; Bob's uid claiming role service_role inside the claims while the API role is
    # authenticated (what a hand-made JWT under the anon key cannot get past PostgREST, but test the function anyway).
    for who in (user("forged", sc.alice.actor.email),):
        with acting(conn, who) as s:
            assert _facts(s, sc.alice.org) is None
    with conn.transaction(force_rollback=True):
        conn.execute("select set_config('request.jwt.claims', %s, true)",
                     ['{"role":"service_role","sub":"%s"}' % sc.bob.actor.uid])
        conn.execute("set local role authenticated")
        out = conn.execute("select public.brain_org_facts(%s)", [sc.alice.org]).fetchone()[0]
        assert out is None


def test_an_org_with_no_channels_lists_no_videos_not_the_default_orgs(conn, sc):
    with acting(conn, sc.stranger) as s:
        org = str(s.value("select public.create_organization('Empty Co')"))
        facts = _facts(s, org)
    assert facts["projects"]["videos_total"] == 0
    assert facts["projects"]["recent_videos"] == []


def test_a_ledger_reference_to_another_orgs_creative_job_does_not_name_its_capability(conn, sc):
    # A capture in org A whose job id names a creative job of org B: the tool must not reveal B's job.
    with as_superuser(conn, commit=False) as root:
        bob_job = root.value("select id from public.creative_jobs where org_id = %s limit 1", [sc.bob.org])
        assert bob_job is not None, "the scenario seeds a creative job for org B"
        root.conn.execute("set local session_replication_role = replica")
        root.conn.execute("insert into public.credit_transactions (org_id, kind, amount, balance_after, reserved_after, job_id) "
                          "values (%s, 'capture', -3, 0, 0, %s)", [sc.alice.org, f"cj:{bob_job}"])
        root.conn.execute("set local session_replication_role = origin")
        root.conn.execute("select set_config('request.jwt.claims', %s, true)",
                          ['{"role":"authenticated","sub":"%s"}' % sc.alice.actor.uid])
        root.conn.execute("set local role authenticated")
        facts = root.conn.execute("select public.brain_org_facts(%s)", [sc.alice.org]).fetchone()[0]
    spend = facts["credits"]["spend_by_tool_30d"]
    assert float(spend.get("cj:unknown", 0)) >= 3, spend


def test_a_temp_table_cannot_shadow_what_the_definer_reads(conn, sc):
    # Bob creates temp relations named like the tables brain_org_facts reads; pg_temp is last and every name is
    # schema-qualified, so the definer still answers null for Alice's org and Bob's own facts are his.
    with acting(conn, sc.bob.actor) as s:
        made = s.run("create temp table org_members (org_id uuid, user_id uuid, role text)")
        if made.ok:
            s.run("insert into pg_temp.org_members values (%s, %s, 'owner')", [sc.alice.org, sc.bob.actor.uid])
            s.run("create temp table channels (channel_id text, org_id uuid)")
        assert _facts(s, sc.alice.org) is None
        assert _facts(s, sc.bob.org)["org_id"] == sc.bob.org


def test_a_platform_admin_reads_no_more_than_rls_already_shows_them(conn, sc):
    # The operator is a platform owner: accessible_org_ids gives them every org, so brain_org_facts answers for
    # Alice's org. Not a new exposure: the same rows are readable to them under RLS. Pinned so a change is seen.
    with acting(conn, sc.operator) as s:
        facts = _facts(s, sc.alice.org)
        rls_videos = s.value("select count(*) from public.videos where channel_id in "
                             "(select channel_id from public.channels where org_id = %s)", [sc.alice.org])
    assert facts is not None
    assert facts["projects"]["videos_total"] == rls_videos


def test_a_large_ledger_does_not_make_the_call_heavy(conn, sc):
    # 30k captures in one org inside 30 days: the 14-day series rescans the materialised CTE 14 times. Bound it.
    with as_superuser(conn, commit=False) as root:
        root.conn.execute("set local session_replication_role = replica")
        root.conn.execute(
            "insert into public.credit_transactions (org_id, kind, amount, balance_after, reserved_after, job_id, created_at) "
            "select %s, 'capture', -1, 0, 0, 'cj:' || gen_random_uuid(), now() - (g %% 29) * interval '1 day' "
            "from generate_series(1, 30000) g", [sc.alice.org])
        root.conn.execute("set local session_replication_role = origin")
        root.conn.execute("select set_config('request.jwt.claims', %s, true)",
                          ['{"role":"authenticated","sub":"%s"}' % sc.alice.actor.uid])
        root.conn.execute("set local role authenticated")
        t0 = time.monotonic()
        root.conn.execute("select public.brain_org_facts(%s)", [sc.alice.org]).fetchone()
        took = time.monotonic() - t0
    assert took < 5.0, f"brain_org_facts took {took:.2f}s over 30k captures"


def test_a_made_up_and_the_default_org_answer_alike_for_a_customer(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        assert _facts(s, str(uuid.uuid4())) is None
        assert _facts(s, DEFAULT_ORG) is None
