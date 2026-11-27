"""Verify owner terms acceptance and registry sync against real Postgres."""

import json
from contextlib import contextmanager

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser, take_off_0227
from sec_scenario import MODEL_GATED, MODEL_HIDDEN, MODEL_SOLD, _model_row


GATE = "written_consent_required"
NEW_GATE = "written_consent_required_v2"
ACCEPT = "select public.owner_accept_model_terms(%s, %s, %s)"
REVOKE = "select public.owner_revoke_model_terms(%s)"
READ = "select model_id, gate, accepted_by_you from public.model_terms_acceptance_admin()"


def _state(s, model=MODEL_GATED):
    return s.rows(
        "select availability, spec ->> 'terms_gate' from public.model_registry where id = %s",
        [model],
    )[0]


@contextmanager
def _acting_in_transaction(conn, actor):
    # Keep changes in the outer rollback-only transaction. Releasing the
    # savepoint would otherwise keep the API role and claims as well.
    with acting(conn, actor, commit=True) as s:
        yield s
        s.rows("reset role")
        s.rows("select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.role', '', true)")


def _sync(conn, gate):
    models = [_model_row(MODEL_GATED, terms_gate=gate), _model_row(MODEL_SOLD), _model_row(MODEL_HIDDEN)]
    with _acting_in_transaction(conn, SERVICE) as s:
        s.value("select public.sync_model_registry(%s::jsonb)", [json.dumps(models)])


def _promote_to_platform_admin(s, actor):
    s.rows(
        "insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1",
        [actor.uid, actor.email],
    )


def test_only_the_owner_can_change_acceptance(conn, sc):
    with as_superuser(conn, commit=False) as root:
        _promote_to_platform_admin(root, sc.dana)
        for actor in (ANON, sc.alice.actor, sc.dana, SERVICE):
            with acting(conn, actor) as s:
                for query, params in ((ACCEPT, [MODEL_GATED, GATE, MODEL_GATED]), (REVOKE, [MODEL_GATED])):
                    out = s.run(query, params)
                    assert not out.ok and out.sqlstate == "42501", out
        assert _state(root) == ("hidden", GATE)


@pytest.mark.parametrize(
    ("model", "gate", "confirm", "sqlstate"),
    [
        ("missing-model", GATE, "missing-model", "P0002"),
        (MODEL_GATED, NEW_GATE, MODEL_GATED, "P2272"),
        (MODEL_GATED, None, MODEL_GATED, "P2272"),
        (MODEL_HIDDEN, "", MODEL_HIDDEN, "P2272"),
        (MODEL_GATED, GATE, f"{MODEL_GATED} ", "22023"),
        (MODEL_GATED, GATE, None, "22023"),
    ],
)
def test_owner_must_confirm_the_current_gate_and_exact_id(conn, sc, model, gate, confirm, sqlstate):
    with acting(conn, sc.operator) as s:
        out = s.run(ACCEPT, [model, gate, confirm])
        assert not out.ok and out.sqlstate == sqlstate, out
        assert s.rows(READ) == []


def test_bytedance_stays_gated(conn, sc):
    with as_superuser(conn, commit=False) as root:
        root.rows("update public.model_registry set provider = 'bytedance' where id = %s returning id", [MODEL_GATED])
        with acting(conn, sc.operator) as s:
            out = s.run(ACCEPT, [MODEL_GATED, GATE, MODEL_GATED])
            assert not out.ok and out.sqlstate == "P2271", out
        assert _state(root) == ("hidden", GATE)


def test_operators_read_acceptance_only_through_the_checked_rpc(conn, sc):
    with as_superuser(conn, commit=False) as root:
        _promote_to_platform_admin(root, sc.dana)
        with _acting_in_transaction(conn, sc.operator) as s:
            accepted = s.value(ACCEPT, [MODEL_GATED, GATE, MODEL_GATED])
            assert accepted["availability"] == "hidden"
            assert s.rows(READ) == [(MODEL_GATED, GATE, True)]
            direct = s.run("select * from public.model_terms_acceptance")
            assert not direct.ok and direct.sqlstate == "42501", direct
        with acting(conn, sc.dana) as s:
            assert s.rows(READ) == [(MODEL_GATED, GATE, False)]
        for actor in (ANON, sc.alice.actor):
            with acting(conn, actor) as s:
                out = s.run(READ)
                assert not out.ok and out.sqlstate == "42501", out
        assert _state(root) == ("hidden", None)


def test_sync_preserves_acceptance_only_for_the_same_gate(conn, sc):
    with as_superuser(conn, commit=False) as root:
        with _acting_in_transaction(conn, sc.operator) as s:
            s.value(ACCEPT, [MODEL_GATED, GATE, MODEL_GATED])
            s.rows("update public.model_registry set availability = 'beta' where id = %s returning id", [MODEL_GATED])
        assert _state(root) == ("beta", None)
        _sync(conn, GATE)
        assert _state(root) == ("beta", None)
        _sync(conn, NEW_GATE)
        assert _state(root) == ("hidden", NEW_GATE)
        with acting(conn, sc.operator) as s:
            out = s.run(ACCEPT, [MODEL_GATED, GATE, MODEL_GATED])
            assert not out.ok and out.sqlstate == "P2272", out


def test_revoke_hides_and_restores_the_gate_before_next_sync(conn, sc):
    with as_superuser(conn, commit=False) as root:
        with _acting_in_transaction(conn, sc.operator) as s:
            s.value(ACCEPT, [MODEL_GATED, GATE, MODEL_GATED])
            s.rows("update public.model_registry set availability = 'ga' where id = %s returning id", [MODEL_GATED])
            revoked = s.value(REVOKE, [MODEL_GATED])
            assert revoked["availability"] == "hidden"
            assert s.rows(READ) == []
        assert _state(root) == ("hidden", GATE)
        _sync(conn, GATE)
        assert _state(root) == ("hidden", GATE)


def test_terms_acceptance_does_not_replace_a_successful_probe(conn, sc):
    with as_superuser(conn, commit=False) as root:
        root.rows(
            "update public.model_registry set spec = jsonb_set(spec, '{terms_gate}', to_jsonb(%s::text)) "
            "where id = %s returning id",
            [GATE, MODEL_HIDDEN],
        )
        with acting(conn, sc.operator) as s:
            s.value(ACCEPT, [MODEL_HIDDEN, GATE, MODEL_HIDDEN])
            out = s.run("update public.model_registry set availability = 'beta' where id = %s", [MODEL_HIDDEN])
            assert not out.ok and out.sqlstate == "23514", out


def test_accepted_model_still_needs_an_active_price_to_be_offered(conn, sc):
    with as_superuser(conn, commit=False) as root:
        unit = _model_row(MODEL_GATED)["credit_unit"]
        root.rows("delete from public.credit_prices where unit = %s returning unit", [unit])
        with _acting_in_transaction(conn, sc.operator) as s:
            s.value(ACCEPT, [MODEL_GATED, GATE, MODEL_GATED])
            s.rows("update public.model_registry set availability = 'beta' where id = %s returning id", [MODEL_GATED])
        with acting(conn, sc.alice.actor) as s:
            assert s.rows("select id from public.sellable_models(null, 'web') where id = %s", [MODEL_GATED]) == []


def test_rollback_restores_an_accepted_gate_and_hides_the_model(conn, sc):
    with as_superuser(conn, commit=False) as root:
        with _acting_in_transaction(conn, sc.operator) as s:
            s.value(ACCEPT, [MODEL_GATED, GATE, MODEL_GATED])
            s.rows("update public.model_registry set availability = 'beta' where id = %s returning id", [MODEL_GATED])
        take_off_0227(root)
        assert _state(root) == ("hidden", GATE)
        assert root.value("select to_regclass('public.model_terms_acceptance')") is None


@pytest.mark.parametrize("action", ["model.terms_accept", "model.terms_revoke"])
def test_owner_terms_actions_are_admitted_to_the_audit_log(conn, sc, action):
    with acting(conn, sc.operator) as s:
        logged = s.rows(
            "insert into public.app_audit_log (actor_user_id, action, target) values (%s, %s, %s) returning action",
            [sc.operator.uid, action, MODEL_GATED],
        )
        assert logged == [(action,)]
