"""Named attacks on the model registry (migration 0035).

The registry holds no tenant's rows, so the question is not "can Bob read
Alice's" but "can anyone make a model look available that is not": a customer
flipping availability, the operator typing a verified_at, a sync quietly
keeping an old proof for a new vendor model, a gated model going on sale, a
FLUX model reaching the public API. Each is refused here in the database, not
in a form.
"""

from __future__ import annotations

import json

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser
from sec_scenario import MODEL_GATED, MODEL_HIDDEN, MODEL_SOLD, _model_row


def sellable(conn, who, surface="web"):
    with acting(conn, who) as s:
        out = s.run("select id from public.sellable_models(null, %s)", [surface])
    return out, sorted(r[0] for r in out.rows) if out.ok else None


def row(conn, mid):
    with as_superuser(conn, commit=False) as s:
        return s.value("select to_jsonb(m) from public.model_registry m where id = %s", [mid])


def test_customers_see_only_the_verified_priced_model(conn, sc):
    for who in (sc.bob.actor, sc.alice.actor, sc.stranger):
        out, ids = sellable(conn, who)
        assert out.ok, out
        assert ids == [MODEL_SOLD], f"{who.name} is offered {ids}"
        with acting(conn, who) as s:
            seen = sorted(r[0] for r in s.rows("select id from public.model_registry"))
        assert seen == [MODEL_SOLD], f"{who.name} reads registry rows {seen}"


def test_anon_is_offered_nothing(conn, sc):
    out, _ = sellable(conn, ANON)
    assert not out.ok and out.sqlstate == "42501", out


def test_customer_cannot_read_spec_or_probe_evidence(conn, sc):
    # spec carries provider USD costs and internal notes: platform-only economics.
    with acting(conn, sc.bob.actor) as s:
        spec = s.run("select spec from public.model_registry")
        probes = s.run("select * from public.model_probe_runs")
        admin = s.run("select * from public.model_registry_admin()")
    assert not spec.ok and spec.sqlstate == "42501", spec
    assert probes.ok and probes.rows == [], probes
    assert not admin.ok and admin.sqlstate == "42501", admin


def test_customer_cannot_put_a_model_on_sale(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = s.run("update public.model_registry set availability = 'ga' where id = %s", [MODEL_HIDDEN])
    assert (not out.ok) or out.rowcount == 0, out
    assert row(conn, MODEL_HIDDEN)["availability"] == "hidden"


@pytest.mark.parametrize("query,params", [
    ("select public.sync_model_registry(%s::jsonb)", [json.dumps([_model_row("evil-1")])]),
    ("select public.record_model_probe(%s, 'image.openai', 'lab-model-1', 't2i', true, null, null, 1, 1, 'bob')",
     [MODEL_HIDDEN]),
])
def test_customer_cannot_sync_or_forge_a_probe(conn, sc, query, params):
    with acting(conn, sc.bob.actor) as s:
        out = s.run(query, params)
    assert not out.ok and out.sqlstate == "42501", out
    assert row(conn, MODEL_HIDDEN)["verified_at"] is None


def test_operator_cannot_sell_an_unverified_model(conn, sc):
    with acting(conn, sc.operator) as s:
        out = s.run("update public.model_registry set availability = 'beta' where id = %s", [MODEL_HIDDEN])
    assert not out.ok and out.sqlstate == "23514", out


def test_operator_cannot_type_a_verification(conn, sc):
    with acting(conn, sc.operator) as s:
        at = s.run("update public.model_registry set verified_at = now() where id = %s", [MODEL_HIDDEN])
        probe = s.run("update public.model_registry set verified_probe_id = 1 where id = %s", [MODEL_HIDDEN])
        spec = s.run("update public.model_registry set spec = '{}' where id = %s", [MODEL_SOLD])
    for out in (at, probe, spec):
        assert not out.ok and out.sqlstate == "42501", out


def test_service_role_cannot_verify_with_a_failed_or_foreign_probe(conn, sc):
    with as_superuser(conn, commit=False) as s:
        failed = s.value("select id from public.model_probe_runs where model_id = %s and not ok", [MODEL_HIDDEN])
        foreign = s.value("select id from public.model_probe_runs where model_id = %s and ok", [MODEL_SOLD])
    with acting(conn, SERVICE) as s:
        for probe_id in (failed, foreign):
            out = s.run("update public.model_registry set verified_probe_id = %s where id = %s", [probe_id, MODEL_HIDDEN])
            assert not out.ok and out.sqlstate == "23514", out
        typed = s.run("update public.model_registry set verified_at = now() where id = %s", [MODEL_HIDDEN])
        assert not typed.ok and typed.sqlstate == "23514", typed
        beta = s.run("update public.model_registry set availability = 'beta' where id = %s", [MODEL_HIDDEN])
        assert not beta.ok and beta.sqlstate == "23514", beta


def test_a_gated_model_cannot_go_on_sale_even_when_verified(conn, sc):
    assert row(conn, MODEL_GATED)["verified_at"] is not None
    for who in (sc.operator, SERVICE):
        with acting(conn, who) as s:
            out = s.run("update public.model_registry set availability = 'ga' where id = %s", [MODEL_GATED])
        assert not out.ok and out.sqlstate == "23514", out


def test_changing_the_vendor_model_takes_the_model_off_sale(conn, sc):
    moved = _model_row(MODEL_SOLD, vendor_model="lab-model-2")
    keep = [_model_row(MODEL_HIDDEN), _model_row(MODEL_GATED, terms_gate="written_consent_required")]
    with acting(conn, SERVICE) as s:
        s.value("select public.sync_model_registry(%s::jsonb)", [json.dumps([moved, *keep])])
        after = s.value("select to_jsonb(m) from public.model_registry m where id = %s", [MODEL_SOLD])
        offered = s.rows("select id from public.sellable_models()")
    assert after["verified_at"] is None and after["availability"] == "hidden", after
    assert offered == []


def test_a_model_removed_from_the_file_is_disabled(conn, sc):
    with acting(conn, SERVICE) as s:
        s.value("select public.sync_model_registry(%s::jsonb)", [json.dumps([_model_row(MODEL_HIDDEN)])])
        states = dict(s.rows("select id, availability from public.model_registry"))
    assert states[MODEL_SOLD] == "disabled" and states[MODEL_GATED] == "disabled", states


def test_web_only_models_never_reach_the_api_or_mcp(conn, sc):
    with acting(conn, SERVICE) as s:
        s.value("select public.sync_model_registry(%s::jsonb)", [json.dumps(
            [_model_row(MODEL_SOLD, api_exposure="web_only"), _model_row(MODEL_HIDDEN),
             _model_row(MODEL_GATED, terms_gate="written_consent_required")])])
        web = s.rows("select id from public.sellable_models(null, 'web')")
        api = s.rows("select id from public.sellable_models(null, 'api')")
        mcp = s.rows("select id from public.sellable_models(null, 'mcp')")
    assert web == [(MODEL_SOLD,)] and api == [] and mcp == []


def test_an_unpriced_model_is_not_for_sale(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.rows("delete from public.credit_prices where unit = %s returning 1", [f"model_{MODEL_SOLD.replace('-', '_')}_image"])
        s.conn.execute("set local role authenticated")
        s.conn.execute("select set_config('request.jwt.claims', %s, true)",
                       [json.dumps(sc.bob.actor.claims())])
        assert s.rows("select id from public.sellable_models()") == []


def test_probe_runs_are_append_only_even_for_the_service_role(conn, sc):
    with acting(conn, SERVICE) as s:
        upd = s.run("update public.model_probe_runs set ok = true")
        dele = s.run("delete from public.model_probe_runs")
        ins = s.run("insert into public.model_probe_runs (model_id, adapter, vendor_model, capability, ok, probed_by) "
                    "values (%s, 'image.openai', 'lab-model-1', 't2i', true, 'x')", [MODEL_HIDDEN])
    for out in (upd, dele, ins):
        assert not out.ok and out.sqlstate == "42501", out
