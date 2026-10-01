"""Named attacks on worker status (migration 0045).

worker_status holds the operator's view of the background workers, including
the remedy text a failed worker reports. Customers must never read the table or
that text; only a worker (service role) may write, and only through
report_worker_status(); the one thing a signed-in customer may ask is whether
media checking is running, and the answer carries no detail, no worker id and
nothing about any organization.
"""

from __future__ import annotations

import json
from contextlib import contextmanager

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser
from sec_scenario import WORKER_CREATIVE, WORKER_DETAIL, WORKER_MEDIA


@contextmanager
def media_rows(conn, *rows):
    """Replace the media workers' rows with `rows` — (worker_id, state, age_seconds)
    — for one test, and put the seed back afterwards."""
    with as_superuser(conn) as s:
        s.rows("select count(*) from public.worker_status")
        s.run("delete from public.worker_status where kind = 'media'")
        for wid, state, age in rows:
            s.rows("insert into public.worker_status (worker_id, kind, state, detail, updated_at) "
                   "values (%s, 'media', %s, %s, now() - make_interval(secs => %s)) returning 1",
                   [wid, state, WORKER_DETAIL, age])
    try:
        yield
    finally:
        with as_superuser(conn) as s:
            s.run("delete from public.worker_status where kind = 'media'")
        with acting(conn, SERVICE, commit=True) as s:
            s.value("select public.report_worker_status(%s, 'media', 'running', %s, 'lab')", [WORKER_MEDIA, WORKER_DETAIL])


def pipeline(conn, who):
    with acting(conn, who) as s:
        out = s.run("select public.media_pipeline_state()")
    assert out.ok, out
    return out.rows[0][0]


# ── reading ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("who", ["alice", "bob", "stranger", "dana"])
def test_customers_read_no_worker_row_and_no_detail(conn, sc, who):
    actor = {"alice": sc.alice.actor, "bob": sc.bob.actor, "stranger": sc.stranger, "dana": sc.dana}[who]
    with acting(conn, actor) as s:
        rows = s.run("select worker_id, state, detail from public.worker_status")
        detail = s.run("select detail from public.worker_status where detail like %s", ["%LAB-WORKER-DETAIL%"])
        count = s.run("select count(*) from public.worker_status")
    assert rows.ok and rows.rows == [], rows
    assert detail.ok and detail.rows == [], detail
    assert count.ok and count.rows == [(0,)], count


def test_anon_cannot_read_the_table(conn, sc):
    with acting(conn, ANON) as s:
        out = s.run("select * from public.worker_status")
    assert (not out.ok and out.sqlstate == "42501") or out.rows == [], out


def test_platform_admin_reads_every_worker_and_its_detail(conn, sc):
    with acting(conn, sc.operator) as s:
        rows = s.rows("select worker_id, kind, state, detail from public.worker_status order by worker_id")
    got = {r[0]: r for r in rows}
    assert {WORKER_MEDIA, WORKER_CREATIVE} <= set(got), rows
    assert got[WORKER_MEDIA][1:] == ("media", "running", WORKER_DETAIL)


# ── writing ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("who", ["alice", "bob", "operator", "service", "anon"])
@pytest.mark.parametrize("stmt", [
    "insert into public.worker_status (worker_id, kind, state) values ('evil', 'media', 'running')",
    "update public.worker_status set state = 'failed', detail = 'x'",
    "update public.worker_status set state = 'running' where kind = 'media'",
    "delete from public.worker_status",
])
def test_nobody_writes_the_table_directly(conn, sc, who, stmt):
    actor = {"alice": sc.alice.actor, "bob": sc.bob.actor, "operator": sc.operator, "service": SERVICE, "anon": ANON}[who]
    with acting(conn, actor) as s:
        out = s.run(stmt)
    assert (not out.ok) or out.rowcount == 0, f"{who} wrote worker_status: {out!r}"
    with as_superuser(conn, commit=False) as s:
        assert s.value("select count(*) from public.worker_status where worker_id = 'evil'") == 0
        assert s.value("select state from public.worker_status where worker_id = %s", [WORKER_MEDIA]) == "running"


@pytest.mark.parametrize("who", ["alice", "bob", "stranger", "operator", "anon"])
def test_only_the_service_role_can_report(conn, sc, who):
    actor = {"alice": sc.alice.actor, "bob": sc.bob.actor, "stranger": sc.stranger, "operator": sc.operator,
             "anon": ANON}[who]
    with acting(conn, actor) as s:
        out = s.run("select public.report_worker_status('evil', 'media', 'failed', 'x', 'v')")
    assert not out.ok and out.sqlstate == "42501", f"{who}: {out!r}"
    with as_superuser(conn, commit=False) as s:
        assert s.value("select count(*) from public.worker_status where worker_id = 'evil'") == 0


def test_a_report_updates_the_workers_own_row(conn, sc):
    with acting(conn, SERVICE, commit=True) as s:
        s.value("select public.report_worker_status('lab-upsert-1', 'other', 'starting', 'booting', 'v1')")
        s.value("select public.report_worker_status('lab-upsert-1', 'other', 'running', null, 'v1')")
    try:
        with as_superuser(conn, commit=False) as s:
            rows = s.rows("select kind, state, detail, version from public.worker_status where worker_id = 'lab-upsert-1'")
        assert rows == [("other", "running", None, "v1")]
    finally:
        with as_superuser(conn) as s:
            s.run("delete from public.worker_status where worker_id = 'lab-upsert-1'")


def test_detail_is_clamped_to_300_characters(conn, sc):
    big = "x" * 5000
    with acting(conn, SERVICE, commit=True) as s:
        out = s.run("select public.report_worker_status('lab-clamp-1', 'other', 'failed', %s, %s)", [big, "v" * 500])
    try:
        assert out.ok, out
        with as_superuser(conn, commit=False) as s:
            d, v = s.rows("select char_length(detail), char_length(version) from public.worker_status "
                          "where worker_id = 'lab-clamp-1'")[0]
        assert d == 300 and v == 100
    finally:
        with as_superuser(conn) as s:
            s.run("delete from public.worker_status where worker_id = 'lab-clamp-1'")


def test_control_characters_are_removed_from_detail(conn, sc):
    with acting(conn, SERVICE, commit=True) as s:
        s.value("select public.report_worker_status('lab-ctl-1', 'other', 'failed', E'a\\nb\\x01c\\td')")
    try:
        with as_superuser(conn, commit=False) as s:
            d = s.value("select detail from public.worker_status where worker_id = 'lab-ctl-1'")
        assert d == "a b c d"
    finally:
        with as_superuser(conn) as s:
            s.run("delete from public.worker_status where worker_id = 'lab-ctl-1'")


@pytest.mark.parametrize("args,state", [
    ("'w', 'billing', 'running'", "23514"),     # unknown kind
    ("'w', 'media', 'healthy'", "23514"),       # unknown state
    ("'', 'media', 'running'", "22023"),        # no worker id
    ("null, 'media', 'running'", "22023"),
])
def test_bad_reports_are_refused(conn, sc, args, state):
    with acting(conn, SERVICE) as s:
        out = s.run(f"select public.report_worker_status({args})")
    assert not out.ok and out.sqlstate == state, out


# ── what a customer may ask ─────────────────────────────────────────────────

def test_anon_cannot_ask_for_the_pipeline_state(conn, sc):
    with acting(conn, ANON) as s:
        out = s.run("select public.media_pipeline_state()")
    assert not out.ok and out.sqlstate == "42501", out


def test_the_service_role_is_not_a_customer_caller(conn, sc):
    with acting(conn, SERVICE) as s:
        out = s.run("select public.media_pipeline_state()")
    assert not out.ok and out.sqlstate == "42501", out


def test_the_customer_answer_is_exactly_state_and_age(conn, sc):
    with media_rows(conn, ("lab-media-x", "failed", 5)):
        for who in (sc.alice.actor, sc.bob.actor, sc.stranger):
            got = pipeline(conn, who)
            assert set(got) == {"state", "age_seconds"}, got
            text = json.dumps(got)
            for secret in (WORKER_DETAIL, "LAB-WORKER", "NIGHTSHIFT_MEDIA_DIR", "lab-media-x", WORKER_MEDIA):
                assert secret not in text, f"{who.name} learned {secret!r}: {text}"


def test_the_answer_is_the_same_for_every_organization(conn, sc):
    # Nothing in it depends on who asks: no org-specific number or text.
    with media_rows(conn, ("lab-media-x", "running", 3)):
        a, b = pipeline(conn, sc.alice.actor), pipeline(conn, sc.bob.actor)
        assert a["state"] == b["state"] == "ok"
        assert abs(a["age_seconds"] - b["age_seconds"]) <= 2
        assert a["age_seconds"] < 60


@pytest.mark.parametrize("rows,state", [
    ([], "unknown"),                                              # nothing ever reported
    ([("m1", "running", 10)], "ok"),
    ([("m1", "starting", 10)], "ok"),
    ([("m1", "running", 119)], "ok"),
    ([("m1", "running", 130)], "stale"),                          # no heartbeat for > 120 s
    ([("m1", "failed", 10)], "failed"),
    ([("m1", "failed", 500)], "stale"),                           # an old failure is not news
    ([("m1", "stopped", 10)], "stale"),                           # stopped is not running
    ([("m1", "failed", 10), ("m2", "running", 10)], "ok"),         # one healthy worker is enough
    ([("m1", "running", 500), ("m2", "failed", 10)], "failed"),
])
def test_pipeline_state_verdicts(conn, sc, rows, state):
    with media_rows(conn, *rows):
        got = pipeline(conn, sc.alice.actor)
    assert got["state"] == state, got
    if state == "unknown":
        assert got["age_seconds"] is None
    else:
        assert isinstance(got["age_seconds"], int) and got["age_seconds"] >= 0


def test_other_worker_kinds_do_not_make_media_look_healthy(conn, sc):
    # The seed has a running creative worker; with no media row the answer is still unknown.
    with media_rows(conn):
        assert pipeline(conn, sc.alice.actor)["state"] == "unknown"
