"""Breach on 0227 (owner accepts a model's vendor terms): who can clear a terms_gate, and can a
registry write launder an acceptance onto terms nobody accepted.

Every test runs in a rolled-back transaction except the two race tests, which need two committed
sessions; they work on their own model row and delete it afterwards.

Two tests here FAIL on 52554e05 and are meant to until 0227 is fixed (see their docstrings):
  * test_acceptance_does_not_survive_a_vendor_change
  * test_a_gate_the_registry_imposes_again_is_not_swallowed_by_an_old_acceptance
"""

from __future__ import annotations

import json
import re
import threading
import time
from contextlib import contextmanager

import psycopg
import pytest
from psycopg import sql

from sec_db import ANON, MIGRATIONS, SERVICE, Session, admin_dsn
from sec_scenario import DEFAULT_ORG, MODEL_GATED, MODEL_HIDDEN, MODEL_SOLD, _model_row

GATE = "written_consent_required"
NEW_GATE = "written_consent_required_v2"
ACCEPT = "select public.owner_accept_model_terms(%s, %s, %s)"
REVOKE = "select public.owner_revoke_model_terms(%s)"
UPSERT = (
    "insert into public.model_registry as m (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement) "
    "values (%s, %s, %s, 'image.openai', array['t2i'], %s::jsonb, %s, 'models_image:basic') "
    "on conflict (id) do update set provider = excluded.provider, spec = excluded.spec"
)


def _now() -> int:
    return int(time.time())


def _fresh_aal2() -> dict:
    return {"aal": "aal2", "amr": [{"method": "password", "timestamp": _now() - 3600},
                                    {"method": "totp", "timestamp": _now() - 30}]}


class Tx:
    """One rolled-back transaction in which the caller changes identity (the pattern of test_sec_owner_safety)."""

    def __init__(self, conn):
        self.conn = conn
        self.s = Session(conn)

    def sup(self, query, params=None):
        self.conn.execute("reset role")
        self.conn.execute("select set_config('request.jwt.claims', '', true)")
        return self.s.rows(query, params)

    def as_(self, who, **extra):
        self.conn.execute("reset role")
        c = who.claims()
        c.update(extra)
        self.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(c)])
        self.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
        self.conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))
        return self.s

    def state(self, model=MODEL_GATED):
        return tuple(self.sup("select availability, spec ->> 'terms_gate' from public.model_registry where id = %s", [model])[0])

    def sync(self, rows):
        self.as_(SERVICE).value("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])

    def accept(self, owner, model=MODEL_GATED, gate=GATE):
        return self.as_(owner).value(ACCEPT, [model, gate, model])

    def sell(self, model=MODEL_GATED):
        self.sup("update public.model_registry set availability = 'beta' where id = %s returning 1", [model])


@contextmanager
def tx(conn):
    with conn.transaction(force_rollback=True):
        conn.execute("select set_config('request.jwt.claims', '', true)")
        yield Tx(conn)
        conn.execute("reset role")


def _others():
    return [_model_row(MODEL_SOLD), _model_row(MODEL_HIDDEN)]


# ── who may act ─────────────────────────────────────────────────────────────

def test_nobody_but_the_platform_owner_can_accept_or_revoke_even_with_a_fresh_second_factor(conn, sc):
    with tx(conn) as t:
        t.sup("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1", [sc.dana.uid, sc.dana.email])
        # Alice is owner of her own organization; Bob becomes owner of the DEFAULT organization (not the platform).
        t.sup("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'owner') returning 1",
              [DEFAULT_ORG, sc.bob.actor.uid, sc.bob.actor.email])
        for who in (sc.dana, sc.alice.actor, sc.bob.actor, sc.stranger, sc.invitee):
            for q, p in ((ACCEPT, [MODEL_GATED, GATE, MODEL_GATED]), (REVOKE, [MODEL_GATED])):
                out = t.as_(who, **_fresh_aal2()).run(q, p)
                assert not out.ok and out.sqlstate == "42501", (who.name, q, out)
        for who in (ANON, SERVICE):
            out = t.as_(who).run(ACCEPT, [MODEL_GATED, GATE, MODEL_GATED])
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
        # A forged role claim on an authenticated session buys nothing: the role is the database role.
        out = t.as_(sc.alice.actor, role="service_role").run(ACCEPT, [MODEL_GATED, GATE, MODEL_GATED])
        assert not out.ok and out.sqlstate == "42501", out
        assert t.state() == ("hidden", GATE)


@pytest.mark.parametrize("claims", [
    pytest.param({"aal": "aal1"}, id="aal1"),
    pytest.param({}, id="no-aal-claim"),
    pytest.param({"aal": "aal2", "amr": [{"method": "totp", "timestamp": 1}]}, id="stale-aal2"),
    pytest.param({"aal": "AAL2"}, id="aal2-wrong-case"),
])
def test_owner_with_a_factor_and_the_gate_on_needs_a_fresh_aal2(conn, sc, claims):
    with tx(conn) as t:
        t.sup("update public.owner_security_settings set admin_aal2_required = true returning 1")
        t.sup("insert into auth.mfa_factors (user_id, status) values (%s, 'verified') returning 1", [sc.operator.uid])
        for q, p in ((ACCEPT, [MODEL_GATED, GATE, MODEL_GATED]), (REVOKE, [MODEL_GATED])):
            out = t.as_(sc.operator, **claims).run(q, p)
            assert not out.ok and out.sqlstate == "42501" and "terms_mfa_required" in out.error, out
        assert t.state() == ("hidden", GATE)
        t.as_(sc.operator, **_fresh_aal2()).value(ACCEPT, [MODEL_GATED, GATE, MODEL_GATED])
        assert t.state() == ("hidden", None)


@pytest.mark.parametrize("gate", [
    GATE.upper(), f" {GATE}", f"{GATE} ", f"{GATE}\n", GATE[:-1], json.dumps(GATE), "%", f"{GATE}​",
])
@pytest.mark.parametrize("confirm", ["exact", "upper"])
def test_a_near_miss_gate_or_confirm_clears_nothing(conn, sc, gate, confirm):
    with tx(conn) as t:
        out = t.as_(sc.operator).run(ACCEPT, [MODEL_GATED, gate, MODEL_GATED if confirm == "exact" else MODEL_GATED.upper()])
        assert not out.ok and out.sqlstate in ("P2272", "22023"), out
        out = t.as_(sc.operator).run(ACCEPT, [MODEL_GATED, GATE, MODEL_SOLD])
        assert not out.ok and out.sqlstate == "22023", out
        assert t.state() == ("hidden", GATE)
        assert t.sup("select count(*) from public.model_terms_acceptance")[0][0] == 0


def test_no_api_role_writes_or_reads_acceptance_rows_directly(conn, sc):
    with tx(conn) as t:
        t.sup("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1", [sc.dana.uid, sc.dana.email])
        for who in (ANON, SERVICE, sc.alice.actor, sc.dana, sc.operator):
            for q, p in (
                ("insert into public.model_terms_acceptance (model_id, gate, accepted_by) values (%s, %s, %s)", [MODEL_GATED, GATE, sc.operator.uid]),
                ("update public.model_terms_acceptance set gate = %s", [GATE]),
                ("delete from public.model_terms_acceptance", None),
                ("select * from public.model_terms_acceptance", None),
            ):
                out = t.as_(who).run(q, p)
                assert not out.ok and out.sqlstate == "42501", (who.name, q, out)
        assert t.state() == ("hidden", GATE)


def test_a_platform_admin_cannot_write_spec_so_cannot_feed_the_definer_trigger(conn, sc):
    with tx(conn) as t:
        t.sup("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1", [sc.dana.uid, sc.dana.email])
        out = t.as_(sc.dana).run("update public.model_registry set spec = spec - 'terms_gate' where id = %s", [MODEL_GATED])
        assert not out.ok and out.sqlstate == "42501", out
        out = t.as_(sc.dana).run("update public.model_registry set availability = 'beta' where id = %s", [MODEL_GATED])
        assert not out.ok and out.sqlstate == "23514", out
        out = t.as_(sc.dana).run("insert into public.model_registry (id, display_name, provider, adapter, capabilities) "
                                 "values ('lab-evil-1', 'x', 'lab', 'image.openai', array['t2i'])")
        assert not out.ok and out.sqlstate == "42501", out
        assert t.state() == ("hidden", GATE)


# ── registry writes against an acceptance ───────────────────────────────────

def test_the_same_gate_on_another_model_id_stays_in_force(conn, sc):
    with tx(conn) as t:
        t.accept(sc.operator)
        t.sync([_model_row(MODEL_GATED, terms_gate=GATE), *_others(), _model_row("lab-gated-2", terms_gate=GATE)])
        assert t.state() == ("hidden", None)
        assert t.state("lab-gated-2") == ("hidden", GATE)


def test_turning_an_accepted_model_into_bytedance_restores_the_gate_and_hides_it(conn, sc):
    with tx(conn) as t:
        t.accept(sc.operator)
        t.sell()
        row = _model_row(MODEL_GATED, terms_gate=GATE)
        row["provider"] = "bytedance"
        t.sync([row, *_others()])
        assert t.state() == ("hidden", GATE)
        out = t.as_(sc.operator).run(ACCEPT, [MODEL_GATED, GATE, MODEL_GATED])
        assert not out.ok and out.sqlstate == "P2271", out


def test_acceptance_does_not_survive_a_vendor_change(conn, sc):
    """FAILS on 52554e05. The acceptance row is keyed by model id and matched by gate string only. The gate strings in
    schemas/model_registry.json are generic (44 x terms_review_required, 16 x written_consent_required), so when the file
    moves an id to another vendor (provider change, same gate string) the trigger strips the gate and the owner's
    acceptance of vendor A's terms now clears vendor B's. The trigger already knows a provider can change under the
    same id (it special-cases bytedance); any other provider change must also not inherit the acceptance."""
    with tx(conn) as t:
        t.accept(sc.operator)
        row = _model_row(MODEL_GATED, terms_gate=GATE)
        row["provider"] = "othervendor"
        t.sync([row, *_others()])
        assert t.state() == ("hidden", GATE), "an acceptance of one vendor's terms cleared another vendor's gate"


def test_a_gate_the_registry_imposes_again_is_not_swallowed_by_an_old_acceptance(conn, sc):
    """FAILS on 52554e05. Owner accepts GATE and sells the model; the file then clears the gate (no gate needed any
    more: the acceptance is moot, but its row stays); later the file puts the same generic gate back because the
    vendor's terms changed again. The trigger matches the stale acceptance and strips the new gate, so the model stays
    on sale with nobody having accepted the terms in force. An acceptance must end when the registry stops asking for it."""
    with tx(conn) as t:
        t.accept(sc.operator)
        t.sell()
        t.sync([_model_row(MODEL_GATED), *_others()])
        assert t.state() == ("beta", None)
        t.sync([_model_row(MODEL_GATED, terms_gate=GATE), *_others()])
        assert t.state() == ("hidden", GATE), "a re-imposed vendor gate was swallowed and the model stayed on sale"


def test_revoke_after_the_gate_changed_keeps_the_newer_gate_and_hides(conn, sc):
    with tx(conn) as t:
        t.accept(sc.operator)
        t.sell()
        t.sync([_model_row(MODEL_GATED, terms_gate=NEW_GATE), *_others()])
        assert t.state() == ("hidden", NEW_GATE)
        out = t.as_(sc.operator).value(REVOKE, [MODEL_GATED])
        assert out["gate"] == NEW_GATE and out["availability"] == "hidden"
        assert t.state() == ("hidden", NEW_GATE)
        t.sync([_model_row(MODEL_GATED, terms_gate=GATE), *_others()])
        assert t.state() == ("hidden", GATE)


def test_a_country_blocked_model_stays_off_sale_after_acceptance(conn, sc):
    with tx(conn) as t:
        t.sync([_model_row(MODEL_GATED, terms_gate=GATE, blocked_countries=["US"]), *_others()])
        t.accept(sc.operator)
        assert t.state() == ("hidden", None)
        out = t.as_(sc.operator).run("update public.model_registry set availability = 'beta' where id = %s", [MODEL_GATED])
        assert not out.ok and out.sqlstate == "23514", out


def test_the_audit_allow_list_keeps_every_action_0145_admitted(conn, sc):
    body = (MIGRATIONS / "0145_made_for_kids.sql").read_text(encoding="utf-8")
    fn = body[body.rindex("create or replace function public.audit_action_allowed"):]
    fn = fn[: fn.index("\n$$;")]
    actions = sorted(set(re.findall(r"'([a-z_]+(?:\.[a-z_]+)+)'", fn)))
    assert len(actions) > 80
    with tx(conn) as t:
        refused = [a for a in actions if not t.sup("select public.audit_action_allowed(%s)", [a])[0][0]]
        assert refused == []
        for a in ("social.tiktok.connect", "learning.approve", "model.terms_accept", "model.terms_revoke"):
            assert t.sup("select public.audit_action_allowed(%s)", [a])[0][0] is True
        assert t.sup("select public.audit_action_allowed('model.terms_accept ')")[0][0] is False


# ── races (committed, on a model row of their own) ──────────────────────────

RACE = "lab-race-1"


def _connect(conn):
    return psycopg.connect(psycopg.conninfo.make_conninfo(admin_dsn(), dbname=conn.info.dbname), autocommit=False)


def _as(c, who, **extra):
    claims = who.claims()
    claims.update(extra)
    c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(claims)])
    c.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))


def _spec(gate):
    return json.dumps({"vendor_model": "lab-model-1", "output": "image", **({"terms_gate": gate} if gate else {})})


@contextmanager
def _race_model(conn, gate=GATE):
    with psycopg.connect(psycopg.conninfo.make_conninfo(admin_dsn(), dbname=conn.info.dbname), autocommit=True) as root:
        root.execute(UPSERT, [RACE, RACE, "lab", _spec(gate), "model_lab_race_1_image"])
        try:
            yield root
        finally:
            root.execute("delete from public.model_terms_acceptance where model_id = %s", [RACE])
            root.execute("delete from public.model_registry where id = %s", [RACE])


def _race_state(root):
    return tuple(root.execute("select availability, spec ->> 'terms_gate' from public.model_registry where id = %s", [RACE]).fetchone())


def test_race_sync_with_a_new_gate_holding_the_row_makes_a_concurrent_accept_refuse(conn, sc):
    with _race_model(conn) as root, _connect(conn) as a, _connect(conn) as b:
        _as(a, SERVICE)
        a.execute(UPSERT, [RACE, RACE, "lab", _spec(NEW_GATE), "model_lab_race_1_image"])  # holds the row lock
        result = {}

        def accept():
            try:
                _as(b, sc.operator)
                b.execute(ACCEPT, [RACE, GATE, RACE])
                b.commit()
                result["ok"] = True
            except psycopg.Error as e:
                b.rollback()
                result["sqlstate"] = e.sqlstate

        th = threading.Thread(target=accept)
        th.start()
        time.sleep(0.5)
        a.commit()
        th.join(10)
        assert result.get("sqlstate") == "P2272", result
        assert _race_state(root) == ("hidden", NEW_GATE)


def test_race_revoke_during_a_sync_of_the_accepted_gate_leaves_the_gate_restored(conn, sc):
    with _race_model(conn) as root, _connect(conn) as a, _connect(conn) as b:
        _as(a, sc.operator)
        a.execute(ACCEPT, [RACE, GATE, RACE])
        a.commit()
        assert _race_state(root) == ("hidden", None)
        _as(b, SERVICE)
        b.execute(UPSERT, [RACE, RACE, "lab", _spec(GATE), "model_lab_race_1_image"])  # strips, holds the lock
        result = {}

        def revoke():
            try:
                _as(a, sc.operator)
                result["out"] = a.execute(REVOKE, [RACE]).fetchone()[0]
                a.commit()
            except psycopg.Error as e:
                a.rollback()
                result["sqlstate"] = e.sqlstate

        th = threading.Thread(target=revoke)
        th.start()
        time.sleep(0.5)
        b.commit()
        th.join(10)
        assert "out" in result, result
        assert _race_state(root) == ("hidden", GATE)
        assert root.execute("select count(*) from public.model_terms_acceptance where model_id = %s", [RACE]).fetchone()[0] == 0
