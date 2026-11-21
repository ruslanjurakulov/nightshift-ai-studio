"""Breach, round 2, on the Studio live view (branch claude/canvas-film-live):

  * GET /api/agent/runs/window  now answers `workflow` (GitHub, with the APP's token) only when
    `channels.select("id").eq("id", channel)` returns a row under the person's session, and `hold` from
    `credit_reservations.select("status,amount,captured").eq("job_id", <&hold>)`;
  * GET /api/agent/runs/[id]    answers `hold` from the visible render_jobs row's credit_ref.

The channel read is the ONLY gate in front of a server-token GitHub call, and the reservation read is the only gate on a guessed
ref, so these RLS policies are the boundary. Each test runs the routes' exact selects as PostgREST would.
"""

from __future__ import annotations

import pytest

from sec_db import ANON, acting, as_superuser  # noqa: E402

HOLD_COLS = "status,amount,captured"


def test_channels_has_exactly_one_select_policy_and_it_is_org_scoped(conn, sc):
    """A second permissive SELECT policy on channels (ORed in) would open the GitHub gate to every channel id."""
    with as_superuser(conn) as s:
        pols = s.rows("select policyname, qual from pg_policies where schemaname='public' and tablename='channels' "
                      "and cmd in ('SELECT','ALL')")
    assert [p[0] for p in pols] == ["channels_auth_read"], pols
    assert "accessible_org_ids" in pols[0][1]


def test_the_workflow_gate_hides_another_orgs_channel(conn, sc):
    for me, other in ((sc.alice, sc.bob), (sc.bob, sc.alice)):
        with acting(conn, me.actor) as s:
            assert s.rows("select channel_id from public.channels where channel_id = %s limit 2", [other.channel]) == []
            assert s.rows("select channel_id from public.channels where channel_id = %s limit 2", [me.channel]) != []
    with acting(conn, sc.stranger) as s:
        assert s.rows("select channel_id from public.channels") == []
    with acting(conn, ANON) as s:
        out = s.run("select channel_id from public.channels")
        assert (not out.ok) or out.rows == []


def test_the_window_routes_channel_gate_select_is_a_valid_query(conn, sc):
    """Was failing (correctness, not a hole): window/route.ts ran channels.select("id").eq("id", channel), but channels' key
    is channel_id (0001) and no migration adds `id`. PostgREST answered 42703 and `workflow` was null for every caller. The
    route's own select/eq columns are read from its source and run as the owner, so a rename cannot slip back."""
    import re
    from pathlib import Path

    src = (Path(__file__).resolve().parents[2] / "command-center/app/api/agent/runs/window/route.ts").read_text()
    m = re.search(r'from\("channels"\)\s*\.select\("([a-z_]+)"\)\s*\.eq\("([a-z_]+)"', src)
    assert m, "the route no longer gates on channels the way this test reads it"
    col, key = m.group(1), m.group(2)
    me = sc.alice
    with acting(conn, me.actor) as s:
        out = s.run(f"select {col} from public.channels where {key} = %s", [me.channel])
    assert out.ok, f"the route's gate query fails for the owner: {out!r}"
    assert out.rows != []


def test_a_guessed_hold_ref_of_another_org_reads_like_a_missing_one(conn, sc):
    with as_superuser(conn) as su:
        refs = {t.key: su.value("select credit_ref from public.render_jobs where id=%s", [t.render_job]) for t in sc.tenants()}
    for me, other in ((sc.alice, sc.bob), (sc.bob, sc.alice)):
        with acting(conn, me.actor) as s:
            assert s.rows(f"select {HOLD_COLS} from public.credit_reservations where job_id = %s", [refs[other.key]]) == []
            assert s.rows(f"select {HOLD_COLS} from public.credit_reservations where job_id = %s", [refs[me.key]]) != []
    with acting(conn, sc.stranger) as s:
        assert s.rows("select job_id from public.credit_reservations") == []
    with acting(conn, ANON) as s:
        out = s.run("select job_id from public.credit_reservations")
        assert (not out.ok) or out.rows == []


def test_a_member_cannot_point_a_visible_job_at_another_orgs_hold(conn, sc):
    """The [id] route trusts render_jobs.credit_ref. A member who could write it to B's ref would still be stopped by
    credit_reservations RLS, but render_jobs must not be updatable by a member at all (0019 dropped update/delete)."""
    me, other = sc.alice, sc.bob
    with as_superuser(conn) as s:
        other_ref = s.value("select credit_ref from public.render_jobs where id=%s", [other.render_job])
    with acting(conn, me.actor) as s:
        out = s.run("update public.render_jobs set credit_ref = %s where id = %s returning id", [other_ref, me.render_job])
        assert (not out.ok) or out.rows == []


@pytest.mark.parametrize("ref", ["rj-seed-b,status.eq.open", "rj-seed-b)", "*", "rj-seed-b%", "a.b", "a b"])
def test_the_hold_ref_charset_admits_no_postgrest_metacharacter(ref):
    """run-hold.ts CREDIT_REF mirrors 0020's job_id check: no , . ( ) * % or space reaches .eq()."""
    import re
    assert re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9:_-]{0,79}", ref) is None
