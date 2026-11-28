"""Breach's third round on migration 0248 (65a8aec8d): the second figure is basis 'nightshift', the median of the operator
organization's own takes (credits_exempt(org), i.e. org_id = default_org_id() = 00000000-0000-0000-0000-000000000001), n >= 3,
whole seconds, no n. Can a customer be counted as the operator, put takes into the operator's figure, or get a figure without
membership? Against the money lab's own scratch database.

Ledger (Breach, 2026-11-28, 65a8aec8d). No hole found; everything below passes and is pinned.

* credits_exempt is ``p_org is not distinct from default_org_id()`` and default_org_id() is an immutable constant: NULL, a random
  id and a customer's org are not exempt. create_organization (0018) takes no id (gen_random_uuid), and no API role may INSERT
  into organizations or org_members, so a customer cannot create or join the operator's organization by itself.
* Takes in the operator's organization come only from its own members at editor or above, from staff (app_members) at editor
  or above through accessible_org_ids' default-org branch (0043), and from the service worker. A customer, and the operator's
  own viewers, cannot create a film there. Staff who are not members of the org writing the operator's takes is by design
  (they are the operator), so it is a note, not a finding.
* A non-member, a signed-in caller with no sub, and anon get not_found / 42501 even when the operator's figure exists.
* Note (INFO, not a finding): the 'nightshift' figure tells any member of a film using model M whether the operator completed
  3 or more takes of M in the last 90 days, and its value moves as the operator's last 20 change, so polling shows roughly when
  the operator works with M. That is the operator's own test activity, whole seconds, no counts; it is not customer data.
* Pre-existing, outside this change (INFO, seen in the lab): platform_role() makes every member of the default org's roster a
  platform 'owner' while app_members is empty (0018/0043). The lab's app_members is empty, and the operator's VIEWER created a
  film in the operator's organization (so could add takes to the 'nightshift' figure, and far more: it reads every
  organization). Production is only exposed if app_members is empty there; worth one read-only check by the owner
  (select count(*) from public.app_members). Not reachable from a customer account alone.
"""

from __future__ import annotations

import json
import uuid

import pytest

from test_sec_films_money import SETTINGS, a, b, db, err, no_live_segment  # noqa: F401
from test_sec_films_money import Org
from test_sec_take_progress_0246_0248 import OPERATOR_ORG, _model, _takes, row_for, typical

_OPS = {}


def operator(db):
    """The operator's organization in THIS module's database. Not test_sec_take_progress_0246_0248.operator: that one caches one
    Org per process, so a second module asking for it gets people who exist only in the first module's database."""
    if db.dsn not in _OPS:
        if not db.su("select 1 from public.organizations where id = %s", [OPERATOR_ORG]):
            db.su("insert into public.organizations (id, name, slug) values (%s, 'Nightshift', 'nightshift-lab')", [OPERATOR_ORG])
        people = [str(uuid.uuid4()) for _ in range(4)]
        for u, role in zip(people, ("owner", "admin", "editor", "viewer")):
            db.su("insert into auth.users (id, email) values (%s, %s)", [u, f"{role}-{u[:8]}@operator.lab"])
            db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s)",
                  [OPERATOR_ORG, u, f"{role}-{u[:8]}@operator.lab", role])
        db.film_org_on(OPERATOR_ORG)
        _OPS[db.dsn] = Org(OPERATOR_ORG, *people)
    return _OPS[db.dsn]


def test_only_the_operators_constant_id_is_exempt(db, a):
    assert db.su("select public.default_org_id()")[0][0] == uuid.UUID(OPERATOR_ORG)
    got = db.su("select public.credits_exempt(null), public.credits_exempt(%s), public.credits_exempt(gen_random_uuid()), "
                "public.credits_exempt(%s)", [a.org, OPERATOR_ORG])[0]
    assert got == (False, False, False, True)
    assert db.su("select provolatile from pg_proc where oid = 'public.default_org_id()'::regprocedure")[0][0] == "i"


def test_a_customer_cannot_create_or_join_the_operators_organization(db, a):
    operator(db)
    new = db.one("authenticated", a.editor, "select public.create_organization('Not the operator')")
    assert str(new) != OPERATOR_ORG
    for q, p in (("insert into public.organizations (id, name, slug) values (%s, 'Mine', 'mine-op')", [OPERATOR_ORG]),
                 ("insert into public.organizations (id, name, slug) values (gen_random_uuid(), 'Mine', 'mine-op2')", None),
                 ("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'x@x.lab', 'owner')",
                  [OPERATOR_ORG, a.editor]),
                 ("update public.org_members set org_id = %s where user_id = %s", [OPERATOR_ORG, a.editor])):
        state, _m, _d = err(lambda: db.act("authenticated", a.editor, q, p))
        assert state == "42501", q
    assert db.su("select count(*) from public.org_members where org_id = %s and user_id = %s", [OPERATOR_ORG, a.editor])[0][0] == 0


def _draft(db, who):
    return db.act("authenticated", who, "select public.create_film_draft(%s::uuid, null, 'topic', 'x', %s::jsonb, %s)",
                  [OPERATOR_ORG, json.dumps(SETTINGS), f"op-breach-{uuid.uuid4().hex[:8]}"])


def test_a_customer_the_operators_viewer_and_viewer_staff_cannot_make_a_film_in_the_operators_organization(db, a):
    """With app_members populated, as a running deployment has it. (With app_members EMPTY, 0018/0043's bootstrap rule makes
    every member of the default org's roster a platform owner, its viewers included: pre-existing, see the ledger.)"""
    op = operator(db)
    staff = str(uuid.uuid4())
    db.su("insert into auth.users (id, email) values (%s, %s)", [staff, f"staff-{staff[:8]}@operator.lab"])
    db.su("insert into public.app_members (user_id, email, role) values (%s, %s, 'owner'), (%s, %s, 'viewer')",
          [op.owner, f"owner-{op.owner[:8]}@operator.lab", staff, f"staff-{staff[:8]}@operator.lab"])
    try:
        for who in (a.editor, a.admin, op.viewer, staff):
            state, _m, _d = err(lambda: _draft(db, who))
            assert state in ("42501", "P0002"), (who, state)
        assert db.su("select count(*) from public.films where org_id = %s and created_by in (%s, %s, %s, %s)",
                     [OPERATOR_ORG, a.editor, a.admin, op.viewer, staff])[0][0] == 0
        # The operator's own editor still can: the figure is the operator's own work.
        assert _draft(db, op.editor)[0][0]["film"]["org_id"] == OPERATOR_ORG
    finally:
        db.su("delete from public.app_members where user_id in (%s, %s)", [op.owner, staff])


def test_no_figure_of_the_operators_for_a_non_member_a_subless_caller_or_anon(db, a, b):
    m = _model()
    film = _takes(db, a, m, [60], status="failed")
    _takes(db, operator(db), m, [40, 44, 48])
    assert row_for(db, a.viewer, film, m)["basis"] == "nightshift"   # the figure exists
    for who in (b.admin, None):
        state, msg, _d = err(lambda: db.act("authenticated", who, "select public.film_take_typical_seconds(%s)", [film]))
        assert state == "P0002" and "not_found" in msg, who
    state, _m, _d = err(lambda: db.act("anon", None, "select public.film_take_typical_seconds(%s)", [film]))
    assert state == "42501"


def test_the_nightshift_row_carries_only_model_capability_basis_and_whole_seconds(db, a):
    m = _model()
    film = _takes(db, a, m, [5, 6])
    _takes(db, operator(db), m, [40.4, 44.6, 47.6] + [41] * 30)
    r = row_for(db, a.viewer, film, m)
    assert set(r) == {"model", "capability", "basis", "median_s"} and r["basis"] == "nightshift"
    assert isinstance(r["median_s"], int)
    assert {x["model"] for x in typical(db, a.viewer, film)} == {m}
