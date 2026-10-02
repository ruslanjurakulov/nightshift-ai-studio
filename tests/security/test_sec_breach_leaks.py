"""Breach wave 7, lane G: platform-private state that reaches a member of an
organization, and a counter the caller can reset.

Held (a passing test):
  * the platform's economics: no member reads ``credit_prices``, the routed
    quote has no margin, and ``creative_economics`` / ``creative_job_costs`` /
    ``creative_job_routes`` / ``model_probe_runs`` / ``worker_status`` answer a
    member nothing (wave 6 + 0084 + 0075; re-attacked here from the member's side
    through the tables the new migrations added).

Open (xfail strict, flip when fixed):
  * BR-G-004  ``take_web_rate`` deletes the caller's rows of the same bucket from
    EARLIER windows, so one call with a one-second window resets the counter a
    route keeps with a ten-minute window.
  * BR-G-005  the real failover reason (auth, quota, not_configured ...: the state
    of the platform's vendor accounts) is also copied into
    ``creative_job_events.detail`` and read by every member. BR-L-032 is the same
    value on ``creative_jobs``; fixing that row alone leaves this copy.
  * BR-G-006  ``scene_regenerations.error`` is readable by every member over
    PostgREST, and the worker fills it with the refusal's raw text (the
    platform's configured vendor model, key and error text). The Command Center
    reads only ``error_code``.
"""

from __future__ import annotations

import json

import pytest

from sec_db import acting, as_superuser

# The router world (its own scratch database, committing): models, prices, two orgs.
from test_sec_model_router import (  # noqa: F401  (db is a fixture)
    ORG_A, UA, UB, create, db, drain, rquote, svc, claim, job,
)


# ── held ────────────────────────────────────────────────────────────────────

def test_members_read_none_of_the_platforms_economics_tables(conn, sc):
    """Every table the 0037 / 0035 / 0045 / 0075 migrations keep for the operator
    answers an ordinary member with no rows or a refusal."""
    for table in ("credit_prices", "creative_job_costs", "creative_job_routes", "model_probe_runs",
                  "worker_status", "model_registry", "creative_economics"):
        with acting(conn, sc.alice.actor) as s:
            out = s.run(f"select * from public.{table}")
        assert (not out.ok and out.sqlstate == "42501") or (out.ok and out.rows == []), f"{table}: {out!r}"


# ── BR-G-004 ────────────────────────────────────────────────────────────────

@pytest.mark.xfail(strict=True, reason="BR-G-004 open: a short-window call to take_web_rate deletes the counter of the route's longer window")
def test_BR_G_004_a_caller_cannot_reset_their_own_rate_counter(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        first = [s.value("select public.take_web_rate('w7_bucket', 3, 600)") for _ in range(5)]
        assert first == [True, True, True, False, False], "the limiter does not limit at all"
        # One call with a one-second window "starts a new window" and deletes the older ones.
        s.value("select public.take_web_rate('w7_bucket', 1000, 1)")
        again = [s.value("select public.take_web_rate('w7_bucket', 3, 600)") for _ in range(5)]
        assert again == [False] * 5, f"the counter was reset by the caller: {again}"


# ── BR-G-005 ────────────────────────────────────────────────────────────────

@pytest.mark.xfail(strict=True, reason="BR-G-005 open: the real failover reason is copied into the member-readable job log")
def test_BR_G_005_a_member_never_reads_the_platforms_vendor_account_state_in_the_job_log(db):
    drain(db)
    q = rquote(db, UA, ORG_A, "cheap")
    jid = create(db, UA, ORG_A, "cheap", q["routed_model"], q["credits"], idem="w7-g005")["job"]["id"]
    claim(db, jid)
    svc(db, "select public.advance_creative_job(%s,'w-r','submitting')", [jid])
    # The cheapest model's vendor account has no key (or no balance): the worker fails over.
    db.su("update public.credit_prices set credits_per_unit = 2 where unit = 'model_img_mid_image'")
    try:
        moved = svc(db, "select public.reroute_creative_job(%s,'w-r','quota')", [jid])[0][0]
    finally:
        db.su("update public.credit_prices set credits_per_unit = 5 where unit = 'model_img_mid_image'")
    assert moved is not None, "the failover did not happen; the test would be vacuous"
    try:
        rows = db.act("authenticated", UA, "select event, detail from public.creative_job_events where job_id = %s", [jid])
        seen = json.dumps([(e, d) for e, d in rows])
        assert "quota" not in seen, f"a member reads the vendor account state in the job log: {seen}"
    finally:
        svc(db, "select public.finish_creative_job(%s,'w-r',false,null,null,'quota','x')", [jid])


# ── BR-G-006 ────────────────────────────────────────────────────────────────

@pytest.mark.xfail(strict=True, reason="BR-G-006 open: scene_regenerations.error (the worker's raw refusal text) is member-readable")
def test_BR_G_006_a_member_cannot_read_the_raw_error_text_of_a_regeneration(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        out = s.run("select error from public.scene_regenerations")
    assert not out.ok and out.sqlstate == "42501", \
        "a member reads scene_regenerations.error, which holds the worker's text (vendor model, key and error text)"


def test_a_member_reads_the_columns_the_page_uses_and_only_their_own_organizations_rows(conn, sc):
    """The control: the regeneration list the video page shows still works, and
    nothing of another organization's comes with it."""
    cols = "id,scene_id,status,source_kind,explicit_stock,quoted_credits,charged_credits,error_code,previous_asset_ids,created_at,finished_at"
    with acting(conn, sc.alice.actor) as s:
        out = s.run(f"select {cols}, org_id from public.scene_regenerations")
    assert out.ok and out.rows, out
    assert {str(r[-1]) for r in out.rows} == {sc.alice.org}
