"""Migration 0188: a 'web_mcp' model is sold on the web and to our own MCP connector, never through the public API; Recraft goes to
beta only once a passed probe of the vendor model the registry names NOW is recorded.

Attacks pinned: the public API (sellable_models 'api', api_creative_model_ok) selling a web_mcp model; an unknown exposure value
opening the API (fail closed); a probe of an old vendor id (recraftv4_1_flash) flipping the renamed model to beta; the flip lowering
or raising anything else. Runs in its own scratch database.
"""
import json
import os
import uuid

import pytest

import sec_db

M = sec_db.MIGRATIONS / "0188_recraft_web_mcp.sql"
MODELS = [  # (id, api_exposure, vendor model)
    ("img-any", "any", "acme-any"),
    ("img-web", "web_only", "acme-web"),
    ("img-mcp", "web_mcp", "acme-mcp"),
    ("img-odd", "partners_only", "acme-odd"),          # a value 0188 does not know: web only
    ("recraft-v4.1", "web_mcp", "recraftv4_1"),
    ("recraft-v4.1-flash", "web_mcp", "recraftv4_1_flash_v2"),
]


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set")
    name = f"ns_recraft_0188_{uuid.uuid4().hex[:8]}"
    dsn = sec_db.build(admin, name)
    import psycopg

    class D:
        def su(self, q, p=None):
            with psycopg.connect(dsn, autocommit=True) as c:
                cur = c.execute(q, p)
                return cur.fetchall() if cur.description else None
    d = D()
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": "image.acme", "capabilities": ["t2i"],
             "credit_unit": f"model_{m.replace('-', '_').replace('.', '_')}_image", "entitlement": "any",
             "spec": {"vendor_model": vm, "output": "image", "api_exposure": exp}} for m, exp, vm in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for r in rows:
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 1, 0) on conflict (unit) do nothing",
             [r["credit_unit"]])
        if not r["id"].startswith("recraft"):
            d.su("select public.record_model_probe(%s, 'image.acme', %s, 't2i', true, null, null, 10, 100, 'security-lab')",
                 [r["id"], r["spec"]["vendor_model"]])
            d.su("update public.model_registry set availability = 'beta' where id = %s", [r["id"]])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def sold(db, surface):
    return {r[0] for r in db.su("select id from public.sellable_models('t2i', %s)", [surface])}


def test_each_surface_sells_exactly_what_its_exposure_allows(db):
    assert sold(db, "web") >= {"img-any", "img-web", "img-mcp", "img-odd"}
    assert sold(db, "mcp") == {"img-any", "img-mcp"}
    assert sold(db, "api") == {"img-any"}          # web_mcp and an unknown value never reach /api/v1


def test_the_public_api_refuses_a_web_mcp_model(db):
    assert db.su("select public.api_creative_model_ok('t2i', 'img-mcp')")[0][0] is False
    assert db.su("select public.api_creative_model_ok('t2i', 'img-any')")[0][0] is True


def test_recraft_stays_hidden_without_a_passed_probe_of_its_current_vendor_model(db):
    # A probe of the id the registry used to send (no longer documented) does not count for the renamed model.
    db.su("select public.record_model_probe('recraft-v4.1-flash', 'image.acme', 'recraftv4_1_flash', 't2i', true, null, null, 10, 100, 'lab')")
    db.su("select public.record_model_probe('recraft-v4.1', 'image.acme', 'recraftv4_1', 't2i', false, 'auth', 'no key', 10, 0, 'lab')")
    db.su(M.read_text(encoding="utf-8"))
    av = dict(db.su("select id, availability from public.model_registry where id like 'recraft-%'"))
    assert av == {"recraft-v4.1": "hidden", "recraft-v4.1-flash": "hidden"}, av


def test_a_passed_probe_of_the_current_vendor_model_then_a_replay_opens_beta_and_still_not_the_api(db):
    db.su("select public.record_model_probe('recraft-v4.1', 'image.acme', 'recraftv4_1', 't2i', true, null, null, 10, 100, 'lab')")
    db.su(M.read_text(encoding="utf-8"))
    av = dict(db.su("select id, availability from public.model_registry where id like 'recraft-%'"))
    assert av == {"recraft-v4.1": "beta", "recraft-v4.1-flash": "hidden"}, av
    assert "recraft-v4.1" in sold(db, "web") and "recraft-v4.1" in sold(db, "mcp")
    assert "recraft-v4.1" not in sold(db, "api")
    # Other models were neither raised nor lowered by either apply.
    assert dict(db.su("select id, availability from public.model_registry where id like 'img-%'")) == {
        "img-any": "beta", "img-web": "beta", "img-mcp": "beta", "img-odd": "beta"}


def test_a_passed_probe_with_the_terms_gate_still_set_stays_hidden_and_the_apply_does_not_stop(db):
    # The first live apply (2026-11-20) stopped here: recraft-v4.1 had a passed probe but its terms_gate was still set, and the
    # hidden -> beta update broke model_registry_terms_before_sale, which rolled 0188 back and held every later migration.
    db.su("update public.model_registry set spec = spec || '{\"terms_gate\": \"terms_review_required\"}'::jsonb where id = 'recraft-v4.1-flash'")
    db.su("select public.record_model_probe('recraft-v4.1-flash', 'image.acme', 'recraftv4_1_flash_v2', 't2i', true, null, null, 10, 100, 'lab')")
    db.su(M.read_text(encoding="utf-8"))
    av = dict(db.su("select id, availability from public.model_registry where id like 'recraft-%'"))
    assert av["recraft-v4.1-flash"] == "hidden", av
    assert "recraft-v4.1-flash" not in sold(db, "web")
