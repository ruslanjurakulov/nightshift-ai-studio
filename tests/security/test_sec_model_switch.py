"""The owner's per-model and per-provider ON/OFF switch (0124), attacked in a real database.

What must hold, with a real registry, price list, credit ledger, API key and job queue:

* DARK: until model_availability_settings.enforced is set, no row of model_availability changes anything for anybody;
* only the platform OWNER reads or writes the switches: not an admin who is not the owner, not a customer, not anon, not the service key,
  and no API role has any privilege on any of the four tables;
* a switched-off model (or every model of a switched-off provider) is missing from every list that reads the registry, and is REFUSED, with
  its own word and with nothing held or charged, at every entry point that starts, quotes or routes a generation: the Studio's quote and
  create (exact and routed, a stale page included), the router's pick and its failover, the API and MCP (api_creative_*), the workflow
  quote and start, and the worker's last gate before the vendor is called;
* the IN-FLIGHT RULE: a job not yet sent to the vendor is stopped when its model goes OFF and its hold comes back; a job already sent
  continues and is charged as before; nothing is re-routed and nothing is revived when the model comes back;
* every change is audited (who, when, why, the state before, the jobs it stopped) in a log nobody can rewrite;
* the user is told "temporarily unavailable", never the owner's reason;
* the optional alert only ever says so: it never hides anything and it can never undo a job's own refund.

Runs in its own scratch database (it commits).
"""
import hashlib
import json
import os
import re
import threading
import uuid

import psycopg
import pytest

import sec_db
from sec_db import REPO
from test_sec_api_creative import Db

MIGRATION = REPO / "supabase" / "migrations" / "0124_model_switch.sql"
ROLLBACK = REPO / "docs" / "sql" / "rollback_0124_model_switch.sql"

ORG_A = "aaaaaaaa-0000-0000-0000-000000000124"
ORG_B = "bbbbbbbb-0000-0000-0000-000000000124"
OWNER = str(uuid.UUID(int=0x124A))
ADMIN = str(uuid.UUID(int=0x124B))
UA = str(uuid.UUID(int=0x124C))
UB = str(uuid.UUID(int=0x124D))
KEY_A = hashlib.sha256(b"switch-key-a").hexdigest()

PROMPT = {"prompt": "a lighthouse at dawn"}
STEPS = [{"capability": "t2i", "model": "img-a1", "params": {"prompt": "a lighthouse"}},
         {"capability": "t2i", "model": "img-a2", "params": {"prompt": "a harbour"}}]

# id -> (provider, quality_tier, speed_tier, credits per image, extra spec)
MODELS = {
    "img-a1": ("acme", 3, 3, 2, {}),
    "img-a2": ("acme", 4, 3, 5, {}),
    "img-web": ("acme", 4, 4, 3, {"api_exposure": "web_only"}),
    "img-z1": ("zeta", 5, 2, 9, {}),
    "img-z2": ("zeta", 3, 2, 2, {}),
}
REASONS = ("out_of_funds", "vendor_outage", "terms_review", "other")


def unit(m):
    return f"model_{m.replace('-', '_')}_image"


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_switch_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email, email_confirmed_at) values (%s,'owner@sw.io',now()),(%s,'admin@sw.io',now()),"
         "(%s,'a@sw.io',now()),(%s,'b@sw.io',now())", [OWNER, ADMIN, UA, UB])
    d.su("insert into public.app_members (user_id, email, role) values (%s,'owner@sw.io','owner'),(%s,'admin@sw.io','admin')",
         [OWNER, ADMIN])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A','org-a-sw'),(%s,'B','org-b-sw')", [ORG_A, ORG_B])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@sw.io','owner'),(%s,%s,'b@sw.io','owner')",
         [ORG_A, UA, ORG_B, UB])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG_A])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG_B])
    d.su("update public.plan_entitlements set value = '1000' where key = 'concurrency'")
    rows = [{"id": m, "display_name": m.upper(), "provider": prov, "adapter": "image.acme", "capabilities": ["t2i"],
             "credit_unit": unit(m), "entitlement": "any",
             "spec": {"vendor_model": "acme-" + m, "output": "image", "quality_tier": q, "speed_tier": s, **extra}}
            for m, (prov, q, s, _c, extra) in MODELS.items()]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, (_p, _q, _s, c, _x) in MODELS.items():
        d.su("select public.record_model_probe(%s, 'image.acme', %s, 't2i', true, null, null, 10, 100, 'lab')", [m, "acme-" + m])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0)", [unit(m), c])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('job_minimum', 1, 0) "
         "on conflict (unit) do update set credits_per_unit = 1, margin = 0")
    d.su("insert into public.api_settings (org_id, activated_at, activated_by, terms_version) values (%s, now(), %s, 'v1')", [ORG_A, UA])
    d.su("insert into public.api_accounts (org_id, balance_cents, paid_total_cents) values (%s, 0, 100000)", [ORG_A])
    d.su("insert into public.api_keys (org_id, name, key_hash, created_by, scopes) values (%s, 'k', %s, %s, %s)",
         [ORG_A, KEY_A, UA, ["creative:quote", "creative:create", "creative:read"]])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


@pytest.fixture(autouse=True)
def clean(db):
    """Every test starts dark and empty: not enforced, no switch, no open job, no rate counter."""
    db.su("update public.model_availability_settings set enforced = false, auto_suggest = false, "
          "suggest_threshold = 3, suggest_window_minutes = 60")
    db.su("delete from public.model_availability")
    db.su("delete from public.model_availability_alerts")
    db.su("delete from public.web_rate_counters")
    # failures of earlier tests are outside every window (the alert counts jobs, and these tests share one database)
    db.su("update public.creative_jobs set finished_at = now() - interval '2 days' where error_code = 'quota'")
    drain(db)
    yield
    drain(db)


# ── helpers ─────────────────────────────────────────────────────────────────

def err(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate, str(e.value).splitlines()[0], (e.value.diag.message_detail or "")


def svc(db, q, p=None):
    return db.act("service_role", None, q, p)


def enforce(db, on=True):
    db.su("update public.model_availability_settings set enforced = %s", [on])


def sw(db, scope, target, enabled, reason="out_of_funds", note=None, confirm=False, who=OWNER):
    return db.act("authenticated", who, "select public.owner_set_model_switch(%s,%s,%s,%s,%s,%s)",
                  [scope, target, enabled, reason if not enabled else None, note, confirm])[0][0]


def off(db, scope, target, reason="out_of_funds", note=None, who=OWNER):
    """Turn OFF, confirming what the confirmation asks (the number of waiting jobs is asserted by the tests that care)."""
    return sw(db, scope, target, False, reason, note, True, who)


def on(db, scope, target, who=OWNER):
    return sw(db, scope, target, True, who=who)


def sellable(db, who=UA, surface="web", cap="t2i"):
    return {r[0] for r in db.act("authenticated", who, "select id from public.sellable_models(%s,%s)", [cap, surface])}


def registry_visible(db, who):
    return {r[0] for r in db.act("authenticated", who, "select id from public.model_registry")}


def quote(db, model, uid=UA, org=ORG_A, params=PROMPT):
    return db.act("authenticated", uid, "select public.quote_creative_job(%s,'t2i',%s,%s::jsonb)", [org, model, json.dumps(params)])[0][0]


def create(db, model, maxc, uid=UA, org=ORG_A, mode="exact", idem=None, params=PROMPT):
    return db.act("authenticated", uid, "select public.create_creative_job(%s,'t2i',%s,%s::jsonb,%s,%s,%s::numeric)",
                  [org, model, json.dumps(params), mode, idem, maxc])[0][0]


def rquote(db, mode, uid=UA, org=ORG_A):
    return db.act("authenticated", uid, "select public.quote_creative_route(%s,'t2i',%s,%s::jsonb)",
                  [org, mode, json.dumps(PROMPT)])[0][0]


def footprint(db, org=ORG_A):
    return (db.su("select count(*) from public.creative_jobs where org_id=%s", [org])[0][0],
            db.su("select count(*), coalesce(sum(amount),0)::float from public.credit_reservations where org_id=%s and status='open'",
                  [org])[0],
            db.su("select balance::float, reserved::float from public.credit_accounts where org_id=%s", [org])[0])


def job(db, job_id):
    cols = ("status", "error_code", "charged_credits", "quoted_credits", "requested_model", "routed_model", "mode", "worker_id",
            "submit_started_at", "provider_task_id", "credit_ref", "fallback_from")
    row = db.su(f"select {', '.join(cols)} from public.creative_jobs where id=%s", [job_id])[0]
    return dict(zip(cols, row))


def reservation(db, ref):
    r = db.su("select status from public.credit_reservations where job_id=%s", [ref])
    return r[0][0] if r else None


def events(db, job_id):
    return [r[0] for r in db.su("select event from public.creative_job_events where job_id=%s order by id", [job_id])]


def claim_next(db, worker="w-sw"):
    got = svc(db, "select id::text, credit_ref, org_id::text from public.claim_creative_job(%s)", [worker])
    return got[0] if got else None


def drain(db):
    while svc(db, "select id from public.claim_creative_job('drain')"):
        pass
    for (jid,) in db.su("select id::text from public.creative_jobs where worker_id='drain'"):
        svc(db, "select public.finish_creative_job(%s,'drain',false,null,null,'test_drain','drained')", [jid])
    # whatever is still queued or running belongs to a test that ended early: end it, so the next test starts empty
    for (jid,) in db.su("select id::text from public.creative_jobs where status in ('queued','running','provider_pending','processing')"):
        db.su("select public.creative_end_locked(%s::uuid, 'failed', 'test_cleanup', 'cleanup')", [jid])


def log_rows(db, kind=None):
    q = "select kind, scope, target, enabled, previous_enabled, reason, note, jobs_stopped, in_flight, actor_user_id::text, actor_email, at from public.model_availability_log"
    if kind:
        q += " where kind = %s"
    return db.su(q + " order by id", [kind] if kind else None)


def api_quote(db, model="img-a1", cap="t2i"):
    return db.act("anon", None, "select public.api_creative_quote(%s,%s,%s,%s::jsonb,null)",
                  [KEY_A, cap, model, json.dumps(PROMPT)])[0][0]


def api_create(db, model, idem, maxc=100, cap="t2i"):
    return db.act("anon", None, "select public.api_creative_create(%s,%s,%s,%s::jsonb,'exact',%s,%s,%s,null)",
                  [KEY_A, cap, model, json.dumps(PROMPT), maxc, idem, hashlib.sha256(idem.encode()).hexdigest()])[0][0]


def queued_job(db, model="img-a1", price=None, idem=None, org=ORG_A, uid=UA):
    out = create(db, model, price if price is not None else MODELS[model][3], uid=uid, org=org, idem=idem)
    return out["job"]["id"]


# ═══ DARK ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

def test_dark_a_recorded_switch_changes_nothing_until_it_is_put_in_force(db):
    """Applying the migration must change nothing: the row exists, it does not count, and nobody can record one through the function."""
    assert db.su("select enforced, auto_suggest from public.model_availability_settings") == [(False, False)]
    db.su("insert into public.model_availability (scope, target, enabled, reason) values ('provider', 'acme', false, 'other')")
    assert sellable(db) == set(MODELS)
    assert db.act("authenticated", UA, "select public.model_is_available('img-a1')")[0][0] is True
    assert db.act("authenticated", UA, "select public.models_switched_off()")[0][0] == []
    assert quote(db, "img-a1")["credits"] == 2
    assert registry_visible(db, UA) >= set(MODELS)
    out = sw(db, "model", "img-a1", False, "other")
    assert out["ok"] is False and out["error"] == "not_enforced"
    assert db.su("select count(*) from public.model_availability where scope = 'model'")[0][0] == 0
    assert svc(db, "select public.model_switch_state()")[0][0] == {"enforced": False, "providers": [], "models": []}


def test_the_settings_row_is_set_by_hand_and_every_change_is_logged(db):
    before = len(log_rows(db, "settings"))
    enforce(db)
    rows = log_rows(db, "settings")
    assert len(rows) == before + 1
    assert db.su("select detail from public.model_availability_log where kind='settings' order by id desc limit 1")[0][0]["enforced"] == [False, True]
    assert db.su("select count(*) from public.security_events where kind = 'model.switch.settings' and severity = 'critical'")[0][0] >= 1
    # the row can be edited, never deleted or emptied
    for q in ("delete from public.model_availability_settings", "truncate public.model_availability_settings"):
        assert err(lambda: db.su(q))[0] == "42501"
    assert db.su("select count(*) from public.model_availability_settings")[0][0] == 1
    # a second row cannot exist
    assert err(lambda: db.su("insert into public.model_availability_settings (id) values (false)"))[0] == "23514"


# ═══ WHO ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

def test_only_the_owner_reads_or_writes_the_switches(db):
    enforce(db)
    calls = {
        "read": ("select public.owner_model_switches()", []),
        "preview": ("select public.owner_model_switch_preview('model','img-a1')", []),
        "set": ("select public.owner_set_model_switch('model','img-a1',false,'other',null,true)", []),
        "dismiss": ("select public.owner_model_alert_dismiss(1)", []),
    }
    for name, (q, p) in calls.items():
        # anon and the service key have no EXECUTE at all
        assert err(lambda: db.act("anon", None, q, p))[0] == "42501", name
        assert err(lambda: svc(db, q, p))[0] == "42501", name
        # a customer, an organization owner included, is refused by the function (reads raise; the writers answer 42501 from owner_guard)
        assert err(lambda: db.act("authenticated", UA, q, p))[0] == "42501", name
    # a platform ADMIN who is not the owner: the reads raise, the writers answer owner_required
    assert err(lambda: db.act("authenticated", ADMIN, calls["read"][0]))[0] == "42501"
    assert err(lambda: db.act("authenticated", ADMIN, calls["preview"][0]))[0] == "42501"
    assert sw(db, "model", "img-a1", False, "other", who=ADMIN)["error"] == "owner_required"
    assert db.act("authenticated", ADMIN, "select public.owner_model_alert_dismiss(1)")[0][0]["error"] == "owner_required"
    assert db.su("select count(*) from public.model_availability")[0][0] == 0
    assert db.act("authenticated", OWNER, calls["read"][0])[0][0]["enforced"] is True


@pytest.mark.parametrize("table", ["model_availability_settings", "model_availability", "model_availability_log", "model_availability_alerts"])
def test_no_api_role_has_any_privilege_on_the_tables(db, table):
    enforce(db)
    for role, uid in (("anon", None), ("authenticated", UA), ("authenticated", OWNER), ("authenticated", ADMIN), ("service_role", None)):
        for q in (f"select * from public.{table}", f"delete from public.{table}", f"update public.{table} set id = id" if table.endswith("settings") else f"delete from public.{table} where false"):
            assert err(lambda: db.act(role, uid, q))[0] == "42501", (role, uid, q)
    for q in ("insert into public.model_availability (scope, target, enabled, reason) values ('provider','acme',false,'other')",
              "insert into public.model_availability_log (kind) values ('switch')",
              "insert into public.model_availability_alerts (provider, failures, window_minutes) values ('acme',3,60)"):
        for role, uid in (("anon", None), ("authenticated", OWNER), ("service_role", None)):
            assert err(lambda: db.act(role, uid, q))[0] == "42501", (role, q)


def test_a_reader_is_not_told_the_id_of_a_model_it_could_never_be_offered(db):
    """models_switched_off() answers only for models on sale and proven (the registry policy's own test): a hidden or unproven model is
    not in a customer's list, so a provider switch must not tell them its id."""
    enforce(db)
    db.su("update public.model_registry set availability = 'hidden' where id = 'img-z2'")
    try:
        off(db, "provider", "zeta")
        assert db.act("authenticated", UA, "select public.models_switched_off()")[0][0] == ["img-z1"]
        # the owner's own document still lists every model, hidden ones included
        doc = db.act("authenticated", OWNER, "select public.owner_model_switches()")[0][0]
        zeta = next(p for p in doc["providers"] if p["provider"] == "zeta")
        assert {m["id"] for m in zeta["models"]} == {"img-z1", "img-z2"}
    finally:
        db.su("update public.model_registry set availability = 'beta' where id = 'img-z2'")


def test_a_reader_learns_ids_and_a_boolean_never_a_reason(db):
    enforce(db)
    off(db, "provider", "zeta", "out_of_funds", "the Zeta balance is gone")
    assert db.act("authenticated", UA, "select public.models_switched_off()")[0][0] == ["img-z1", "img-z2"]
    assert db.act("authenticated", UA, "select public.model_is_available('img-z1')")[0][0] is False
    assert db.act("authenticated", UA, "select public.model_is_available('img-a1')")[0][0] is True
    assert err(lambda: db.act("anon", None, "select public.model_is_available('img-z1')"))[0] == "42501"
    # the worker's door is the service key's only
    assert err(lambda: db.act("authenticated", UA, "select public.model_switch_state()"))[0] == "42501"
    assert err(lambda: db.act("authenticated", OWNER, "select public.model_switch_state()"))[0] == "42501"
    assert svc(db, "select public.model_switch_state()")[0][0] == {"enforced": True, "providers": ["zeta"], "models": []}
    # the helpers are nobody's to call
    for q in ("select public.model_switch_stop_jobs(array['img-a1'])", "select public.model_switch_counts(array['img-a1'])",
              "select public.model_switch_target_models('model','img-a1')"):
        for role, uid in (("anon", None), ("authenticated", OWNER), ("service_role", None)):
            assert err(lambda: db.act(role, uid, q))[0] == "42501", (role, q)


def test_no_existence_oracle_a_customer_cannot_tell_a_hidden_model_from_one_that_does_not_exist(db):
    """The reviewer's repro. model_is_available is executable by a signed-in customer (the registry policy calls it as the reader). With a
    HIDDEN model whose provider is OFF, a customer must get the same answer for it as for an id that is not in the registry at all;
    only a platform admin (and the platform's own callers) are told the truth about a model nobody is offered."""
    enforce(db)
    db.su("update public.model_registry set availability = 'hidden' where id = 'img-z2'")
    db.su("update public.model_registry set availability = 'disabled' where id = 'img-z1'")
    try:
        off(db, "provider", "zeta")
        ask = lambda who, mid: db.act("authenticated", who, "select public.model_is_available(%s)", [mid])[0][0]  # noqa: E731
        for mid in ("img-z2", "img-z1", "img-no-such-model", "IMG-Z2", "  img-z2 "):
            assert ask(UA, mid) is True, f"a customer is told {mid!r} is available, exactly as for an id that does not exist"
        assert {ask(UA, m) for m in ("img-z2", "img-z1", "img-no-such-model")} == {True}
        # the platform's own callers and a platform admin (not only the owner) get the real answer for every id
        assert ask(ADMIN, "img-z2") is False and ask(OWNER, "img-z1") is False and ask(OWNER, "img-no-such-model") is True
        assert svc(db, "select public.model_is_available('img-z2')")[0][0] is False
        assert db.su("select public.model_is_available('img-z2')")[0][0] is False
        # a stale row for an id that is not in the registry (only the SQL editor can write one) tells a customer nothing either
        db.su("insert into public.model_availability (scope, target, enabled, reason) values ('model', 'img-gone', false, 'other')")
        try:
            assert ask(UA, "img-gone") is True and ask(OWNER, "img-gone") is False
        finally:
            db.su("delete from public.model_availability where target = 'img-gone'")
        # a model a customer can be offered is still answered truthfully, the whole point of the function
        db.su("update public.model_registry set availability = 'beta' where id = 'img-z2'")
        assert ask(UA, "img-z2") is False and ask(UA, "img-a1") is True
        # and the id-only list tells a customer nothing about the hidden one
        db.su("update public.model_registry set availability = 'hidden' where id = 'img-z2'")
        assert db.act("authenticated", UA, "select public.models_switched_off()")[0][0] == []
        # the registry policy still hides it, whichever way
        assert "img-z2" not in registry_visible(db, UA) and "img-z1" not in registry_visible(db, UA)
    finally:
        db.su("update public.model_registry set availability = 'beta' where id in ('img-z1', 'img-z2')")


# ═══ WRITING A SWITCH ════════════════════════════════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("args,error", [
    (("planet", "img-a1", False, "other", None), "bad_scope"),
    (("model", "no-such-model", False, "other", None), "unknown_target"),
    (("provider", "no-such-provider", False, "other", None), "unknown_target"),
    (("provider", "img-a1", False, "other", None), "unknown_target"),          # a model id is not a provider
    (("model", "acme", False, "other", None), "unknown_target"),               # a provider id is not a model
    (("model", "img-a1", None, "other", None), "bad_enabled"),
    (("model", "img-a1", False, None, None), "bad_reason"),
    (("model", "img-a1", False, "", None), "bad_reason"),
    (("model", "img-a1", False, "because", None), "bad_reason"),
    (("model", "img-a1", False, "out_of_funds; drop table x", None), "bad_reason"),
    (("model", "img-a1", False, "other", "x" * 201), "bad_note"),
    (("model", "img-a1", False, "other", "two\nlines"), "bad_note"),
    (("model", "img-a1", False, "other", "tab\there"), "bad_note"),
])
def test_a_malformed_switch_is_refused_and_leaves_no_row_and_no_log(db, args, error):
    enforce(db)
    n = len(log_rows(db))
    out = db.act("authenticated", OWNER, "select public.owner_set_model_switch(%s,%s,%s,%s,%s,true)", list(args))[0][0]
    assert (out["ok"], out["error"]) == (False, error), out
    assert db.su("select count(*) from public.model_availability")[0][0] == 0
    assert len(log_rows(db)) == n


@pytest.mark.parametrize("reason", REASONS)
def test_each_of_the_four_reasons_is_accepted_and_trimmed_and_a_note_is_kept(db, reason):
    enforce(db)
    out = sw(db, " MODEL ", " IMG-A1 ", False, f" {reason.upper()} ", "  balance topped up on Friday  ", True)
    assert out["ok"] is True and out["scope"] == "model" and out["target"] == "img-a1"
    assert db.su("select reason, note from public.model_availability where target='img-a1'") == [(reason, "balance topped up on Friday")]


def test_turning_on_carries_no_reason_and_keeps_the_row_as_the_last_word(db):
    enforce(db)
    off(db, "model", "img-a1", "vendor_outage", "down")
    out = on(db, "model", "img-a1")
    assert out["ok"] is True and out["enabled"] is True and out["effective_available"] is True
    assert db.su("select enabled, reason, note, changed_by::text, changed_by_email from public.model_availability where target='img-a1'") == \
        [(True, None, None, OWNER, "owner@sw.io")]
    # the row cannot hold a reason while on, or lack one while off (the table's own CHECK)
    assert err(lambda: db.su("update public.model_availability set reason = 'other' where target = 'img-a1'"))[0] == "23514"
    off(db, "model", "img-a1")
    assert err(lambda: db.su("update public.model_availability set reason = null where target = 'img-a1'"))[0] == "23514"


def test_turning_on_clears_a_reason_and_a_note_the_caller_sent_along(db):
    enforce(db)
    off(db, "model", "img-a1", "vendor_outage", "down")
    out = db.act("authenticated", OWNER, "select public.owner_set_model_switch('model','img-a1',true,'out_of_funds','stale note',false)")[0][0]
    assert out["ok"] is True
    assert db.su("select enabled, reason, note from public.model_availability where target='img-a1'") == [(True, None, None)]
    assert log_rows(db, "switch")[-1][5:7] == (None, None)


def test_the_switch_is_rate_limited_after_sixty_calls_in_ten_minutes(db):
    enforce(db)
    seen = set()
    for _ in range(62):
        out = db.act("authenticated", OWNER, "select public.owner_set_model_switch('model','no-such-model',false,'other',null,false)")[0][0]
        seen.add(out["error"])
    assert "rate_limited" in seen and "unknown_target" in seen


def test_a_refused_admin_who_is_not_the_owner_uses_one_slot_of_their_own_rate_limit_and_writes_nothing(db):
    """owner_guard (0107) takes the caller's rate slot before the owner test: documented in the file's header, pinned here."""
    enforce(db)
    n_log, n_ev = len(log_rows(db)), db.su("select count(*) from public.security_events where kind = 'model.switch'")[0][0]
    db.su("delete from public.web_rate_counters")
    out = db.act("authenticated", ADMIN, "select public.owner_set_model_switch('model','img-a1',false,'other',null,true)")[0][0]
    assert (out["ok"], out["error"]) == (False, "owner_required")
    slots = db.su("select count(*) from public.web_rate_counters where bucket = 'owner:model_switch@600'")[0][0]
    assert slots >= 1, "the refused admin call took a slot of the caller's own limit"
    assert db.su("select count(*) from public.model_availability")[0][0] == 0
    assert len(log_rows(db)) == n_log
    assert db.su("select count(*) from public.security_events where kind = 'model.switch'")[0][0] == n_ev
    # a customer is refused before anything is counted
    db.su("delete from public.web_rate_counters")
    assert err(lambda: db.act("authenticated", UA, "select public.owner_set_model_switch('model','img-a1',false,'other',null,true)"))[0] == "42501"
    assert db.su("select count(*) from public.web_rate_counters where bucket = 'owner:model_switch@600'")[0][0] == 0


# ═══ THE READ PATH ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

def test_a_provider_off_hides_all_its_models_everywhere_a_list_is_read_and_on_brings_them_back(db):
    enforce(db)
    assert sellable(db) == set(MODELS)
    off(db, "provider", "acme", "out_of_funds")
    for surface in ("web", "api", "mcp"):
        assert sellable(db, surface=surface) == {"img-z1", "img-z2"}, surface
    assert registry_visible(db, UA) == {"img-z1", "img-z2"}, "the Studio's direct read of the registry loses them too"
    assert registry_visible(db, UB) == {"img-z1", "img-z2"}
    assert registry_visible(db, ADMIN) >= set(MODELS), "a platform admin still reads every row of the registry"
    on(db, "provider", "acme")
    assert sellable(db) == set(MODELS) and registry_visible(db, UA) >= set(MODELS)


def test_a_model_off_hides_that_model_only_and_a_model_on_never_overrides_a_provider_off(db):
    enforce(db)
    off(db, "model", "img-a1")
    assert sellable(db) == set(MODELS) - {"img-a1"}
    off(db, "provider", "acme")
    on(db, "model", "img-a2")                      # a model row that says ON
    out = on(db, "model", "img-a1")
    assert out["effective_available"] is False, "its provider is still off"
    assert sellable(db) == {"img-z1", "img-z2"}
    on(db, "provider", "acme")
    assert sellable(db) == set(MODELS)
    # a model off under a provider that is on stays off when the provider is switched off and on
    off(db, "model", "img-a1")
    off(db, "provider", "acme")
    on(db, "provider", "acme")
    assert sellable(db) == set(MODELS) - {"img-a1"}


def test_the_owner_reads_every_provider_and_model_with_its_switch_and_nobody_else_does(db):
    enforce(db)
    off(db, "model", "img-z1", "terms_review", "waiting for their answer")
    doc = db.act("authenticated", OWNER, "select public.owner_model_switches()")[0][0]
    assert doc["enforced"] is True and doc["auto_suggest"] is False
    byp = {p["provider"]: p for p in doc["providers"]}
    assert set(byp) == {"acme", "zeta"}
    z1 = next(m for m in byp["zeta"]["models"] if m["id"] == "img-z1")
    assert z1["hidden"] is True and z1["switch"]["reason"] == "terms_review" and z1["switch"]["changed_by_email"] == "owner@sw.io"
    assert byp["acme"]["switch"] is None and all(m["hidden"] is False and m["switch"] is None for m in byp["acme"]["models"])
    assert doc["log"][0]["target"] == "img-z1" and doc["log"][0]["reason"] == "terms_review"
    blob = json.dumps(doc)
    assert "credit" not in blob and "vendor_model" not in blob and "spec" not in blob, "no price, no spec, no key"


# ═══ EVERY ENTRY POINT REFUSES, AND NOTHING IS HELD OR CHARGED ═══════════════════════════════════════════════════════════════

def refused_off(fn):
    st, word, _detail = err(fn)
    assert (st, word) == ("NS400", "model_temporarily_off"), (st, word)


def test_entry_point_the_studio_quote_refuses_a_switched_off_model(db):
    enforce(db)
    assert quote(db, "img-a1")["credits"] == 2
    off(db, "model", "img-a1")
    before = footprint(db)
    refused_off(lambda: quote(db, "img-a1"))
    assert footprint(db) == before
    assert quote(db, "img-a2")["credits"] == 5, "another model is not affected, and nothing is substituted"


def test_entry_point_the_studio_create_refuses_a_switched_off_model_even_with_a_stale_quote(db):
    enforce(db)
    stale = quote(db, "img-a1")                                   # the page was loaded while the model was on
    off(db, "model", "img-a1")
    before = footprint(db)
    refused_off(lambda: create(db, "img-a1", stale["credits"]))
    refused_off(lambda: create(db, "img-a1", 1000, idem="sw-stale-1"))
    assert footprint(db) == before, "no job, no hold, no charge"
    on(db, "model", "img-a1")
    assert create(db, "img-a1", stale["credits"])["job"]["status"] == "queued"


def test_entry_point_the_router_never_picks_a_switched_off_model_and_a_stale_pick_is_refused(db):
    enforce(db)
    q = rquote(db, "cheap")
    assert q["routed_model"] == "img-a1"
    off(db, "model", "img-a1")
    before = footprint(db)
    # the page confirms the pick it was shown: the database asks the router again and the pick has moved
    st, word, _ = err(lambda: create(db, q["routed_model"], q["credits"], mode="cheap", idem="sw-route-1"))
    assert (st, word) == ("NS409", "route_changed")
    assert footprint(db) == before
    again = rquote(db, "cheap")
    assert again["routed_model"] == "img-z2" and again["credits"] == 2
    # with every candidate off, nothing is routed at all
    off(db, "provider", "zeta")
    off(db, "provider", "acme")
    assert err(lambda: rquote(db, "auto"))[:2] == ("NS400", "no_model_available")
    assert footprint(db) == before


def test_entry_point_the_api_and_mcp_name_the_refusal_and_hold_nothing(db):
    enforce(db)
    assert api_quote(db)["ok"] is True
    off(db, "model", "img-a1", "out_of_funds", "never shown to a caller")
    before = footprint(db)
    for res in (api_quote(db), api_create(db, "img-a1", "sw-api-1")):
        assert res["ok"] is False and res["status"] == 503 and res["error"]["code"] == "model_temporarily_off", res
        assert "never shown" not in json.dumps(res) and "funds" not in json.dumps(res)
    assert footprint(db) == before
    # the same key, the same call, another model: unaffected
    assert api_quote(db, "img-a2")["ok"] is True
    # a model the API never sells (the vendor keeps it off the API) is still "not available through the API", switched off or not
    off(db, "model", "img-web")
    res = api_quote(db, "img-web")
    assert res["ok"] is False and res["error"]["code"] == "model_not_sellable"
    # and a model that is not in the registry reads as before
    assert api_quote(db, "no-such-model")["error"]["code"] == "model_not_sellable"
    # captions are never sold through the API: the wording does not change either
    assert api_quote(db, "img-a2", cap="captions")["error"]["code"] in ("model_not_sellable", "invalid_params", "capability_not_supported")
    assert footprint(db) == before


def test_entry_point_the_workflow_quote_names_the_step_and_the_run_is_refused(db):
    enforce(db)
    wf = db.act("authenticated", UA, "select public.save_workflow(%s::uuid, null, 'sw flow', '[]'::jsonb, %s::jsonb)",
                [ORG_A, json.dumps(STEPS)])[0][0]
    q = db.act("authenticated", UA, "select public.quote_workflow(%s, '{}'::jsonb)", [wf["id"]])[0][0]
    assert q["priced"] is True and q["total"] == 7
    off(db, "model", "img-a1")
    before = footprint(db)
    q = db.act("authenticated", UA, "select public.quote_workflow(%s, '{}'::jsonb)", [wf["id"]])[0][0]
    assert q["priced"] is False and q["total"] is None and q["unpriced_steps"] == [0]
    assert (q["steps"][0]["reason"], q["steps"][1]["priced"], q["steps"][1]["credits"]) == ("model_temporarily_off", True, 5)
    for confirmed in (0, 7, 1000):
        st, _w, _d = err(lambda: db.act("authenticated", UA, "select public.start_workflow_run(%s::uuid, %s::uuid, %s::integer, '{}'::jsonb, %s::numeric)",
                                         [str(uuid.uuid4()), wf["id"], wf["version"], confirmed]))
        assert st == "NS400"
    assert footprint(db) == before
    assert db.su("select count(*) from public.workflow_runs where org_id=%s", [ORG_A])[0][0] == 0


def test_entry_point_a_failover_never_moves_a_job_to_a_switched_off_model(db):
    enforce(db)
    # cheap: img-a1 (2 credits) is the pick; img-z2 (2 credits, within the hold) is the one candidate it could move to
    q = rquote(db, "cheap")
    jid = create(db, q["routed_model"], q["credits"], mode="cheap", idem="sw-fo-1")["job"]["id"]
    got = claim_next(db)
    assert got and got[0] == jid
    assert svc(db, "select public.advance_creative_job(%s,'w-sw','submitting')", [jid])[0][0] is True
    off(db, "provider", "zeta")
    assert svc(db, "select public.reroute_creative_job(%s,'w-sw','unreachable')", [jid])[0][0] is None, "the only candidate is off"
    assert job(db, jid)["routed_model"] == "img-a1" and job(db, jid)["fallback_from"] is None
    on(db, "provider", "zeta")
    moved = svc(db, "select public.reroute_creative_job(%s,'w-sw','unreachable')", [jid])[0][0]
    assert moved["model"] == "img-z2", "control: with the switch on the same failover goes where it always did"


def test_entry_point_the_worker_cannot_send_a_job_whose_model_was_switched_off_after_it_was_claimed(db):
    """The last gate. The sweep at switch time is skipped on purpose (the job is written straight into the state a race would leave):
    advance('submitting') itself stops the job, releases the hold and tells the worker it is not its job to send any more."""
    enforce(db)
    jid = queued_job(db)
    _id, ref, org = claim_next(db)
    svc(db, "select public.start_credit_reservation(%s,%s)", [ref, org])
    assert job(db, jid)["status"] == "running"
    db.su("insert into public.model_availability (scope, target, enabled, reason) values ('model', 'img-a1', false, 'out_of_funds')")
    assert svc(db, "select public.advance_creative_job(%s,'w-sw','submitting')", [jid])[0][0] is False
    j = job(db, jid)
    assert (j["status"], j["error_code"], j["charged_credits"], j["submit_started_at"], j["provider_task_id"]) == \
        ("failed", "model_temporarily_off", 0, None, None)
    assert reservation(db, ref) == "released"
    assert "failed" in events(db, jid)
    assert db.su("select reserved::float from public.credit_accounts where org_id=%s", [ORG_A])[0][0] == 0
    # a second call changes nothing and the job stays ended
    assert svc(db, "select public.advance_creative_job(%s,'w-sw','submitting')", [jid])[0][0] is False
    assert job(db, jid)["status"] == "failed"
    # not the worker's job: nobody else can use the gate to end a job
    jid2 = queued_job(db, "img-a2", idem="sw-gate-2")
    db.su("insert into public.model_availability (scope, target, enabled, reason) values ('model', 'img-a2', false, 'other') on conflict do nothing")
    assert svc(db, "select public.advance_creative_job(%s,'someone-else','submitting')", [jid2])[0][0] is False
    assert job(db, jid2)["status"] == "queued", "a worker that does not hold the job cannot end it"


def test_entry_point_the_gate_never_ends_a_job_whose_submit_has_begun_or_that_another_worker_holds(db):
    enforce(db)
    jid = queued_job(db)
    claim_next(db)
    assert svc(db, "select public.advance_creative_job(%s,'w-sw','submitting')", [jid])[0][0] is True     # sent: possibly with the vendor
    db.su("insert into public.model_availability (scope, target, enabled, reason) values ('model', 'img-a1', false, 'other')")
    assert svc(db, "select public.advance_creative_job(%s,'w-sw','submitting')", [jid])[0][0] is False    # not allowed twice, but NOT ended
    j = job(db, jid)
    assert (j["status"], j["error_code"], j["charged_credits"]) == ("running", None, None)
    assert j["submit_started_at"] is not None
    # a job another worker holds: a stranger asking to send it cannot end it
    db.su("delete from public.model_availability")
    jid2 = queued_job(db, "img-a2", idem="sw-gate-3")
    got = claim_next(db)
    assert got[0] == jid2
    db.su("insert into public.model_availability (scope, target, enabled, reason) values ('model', 'img-a2', false, 'other')")
    assert svc(db, "select public.advance_creative_job(%s,'someone-else','submitting')", [jid2])[0][0] is False
    assert job(db, jid2)["status"] == "running" and job(db, jid2)["worker_id"] == "w-sw"


def test_entry_point_the_gate_is_inert_for_an_enabled_model_and_while_dark(db):
    jid = queued_job(db)
    claim_next(db)
    db.su("insert into public.model_availability (scope, target, enabled, reason) values ('model', 'img-a1', false, 'other')")
    assert svc(db, "select public.advance_creative_job(%s,'w-sw','submitting')", [jid])[0][0] is True, "dark: the row does not count"
    assert job(db, jid)["submit_started_at"] is not None


# ═══ THE IN-FLIGHT RULE ══════════════════════════════════════════════════════════════════════════════════════════════════════

def test_inflight_a_queued_job_is_stopped_with_its_credits_returned_after_a_confirmation_that_counts_it(db):
    enforce(db)
    jid = queued_job(db)
    ref = job(db, jid)["credit_ref"]
    assert reservation(db, ref) == "open" and footprint(db)[2][1] == 2
    pre = db.act("authenticated", OWNER, "select public.owner_model_switch_preview('model','img-a1')")[0][0]
    assert (pre["ok"], pre["queued"], pre["running"], pre["waiting"], pre["in_flight"]) == (True, 1, 0, 1, 0)
    # without the confirmation nothing changes, and the answer says how many it would stop
    out = sw(db, "model", "img-a1", False, "out_of_funds")
    assert (out["ok"], out["error"], out["waiting"], out["in_flight"]) == (False, "confirm_required", 1, 0)
    assert job(db, jid)["status"] == "queued" and db.su("select count(*) from public.model_availability")[0][0] == 0
    out = sw(db, "model", "img-a1", False, "out_of_funds", confirm=True)
    assert (out["ok"], out["jobs_stopped"]) == (True, 1)
    j = job(db, jid)
    assert (j["status"], j["error_code"], j["charged_credits"]) == ("failed", "model_temporarily_off", 0)
    assert reservation(db, ref) == "released" and footprint(db)[2][1] == 0, "the hold came back in full"
    assert events(db, jid)[-1] == "failed"
    assert log_rows(db, "switch")[-1][7] == 1, "the log says how many jobs it stopped"
    # the user is told the job failed with credits returned, like any failed job
    note = db.su("select data from public.notifications where kind = 'creative_job_failed' and ref = %s", [jid])
    assert len(note) == 1 and note[0][0]["code"] == "model_temporarily_off" and float(note[0][0]["credits_returned"]) == 2


def test_inflight_a_job_that_is_claimed_but_not_sent_is_stopped_and_the_worker_is_told_it_is_not_its_job(db):
    enforce(db)
    jid = queued_job(db)
    _id, ref, org = claim_next(db)
    assert job(db, jid)["status"] == "running"
    pre = db.act("authenticated", OWNER, "select public.owner_model_switch_preview('provider','acme')")[0][0]
    assert (pre["waiting"], pre["running"], pre["queued"]) == (1, 1, 0)
    assert off(db, "provider", "acme")["jobs_stopped"] == 1
    j = job(db, jid)
    assert (j["status"], j["error_code"], j["worker_id"]) == ("failed", "model_temporarily_off", None)
    assert reservation(db, ref) == "released"
    assert svc(db, "select public.advance_creative_job(%s,'w-sw','submitting')", [jid])[0][0] is False
    assert svc(db, "select public.heartbeat_creative_job(%s,'w-sw')", [jid])[0][0] is False


def test_inflight_a_job_already_with_the_vendor_continues_and_is_charged_as_before(db):
    enforce(db)
    jid = queued_job(db)
    _id, ref, org = claim_next(db)
    svc(db, "select public.start_credit_reservation(%s,%s)", [ref, org])
    assert svc(db, "select public.advance_creative_job(%s,'w-sw','submitting')", [jid])[0][0] is True
    # submit started, no task id yet: possibly with the vendor, so it is SENT
    pre = db.act("authenticated", OWNER, "select public.owner_model_switch_preview('model','img-a1')")[0][0]
    assert (pre["waiting"], pre["in_flight"]) == (0, 1)
    out = sw(db, "model", "img-a1", False, "vendor_outage")            # nothing to stop: no confirmation is needed
    assert (out["ok"], out["jobs_stopped"], out["in_flight"]) == (True, 0, 1)
    assert job(db, jid)["status"] == "running" and job(db, jid)["submit_started_at"] is not None
    assert svc(db, "select public.advance_creative_job(%s,'w-sw','submitted','task-1')", [jid])[0][0] is True
    assert job(db, jid)["status"] == "provider_pending"
    off(db, "provider", "acme")
    assert job(db, jid)["status"] == "provider_pending"
    assert svc(db, "select public.advance_creative_job(%s,'w-sw','processing')", [jid])[0][0] is True
    done = svc(db, "select public.finish_creative_job(%s,'w-sw',true,null,'{}'::jsonb,null,null)", [jid])[0][0]
    assert done["status"] == "completed"
    assert job(db, jid)["charged_credits"] == 2 and reservation(db, ref) == "captured"


def test_inflight_a_requeued_job_that_has_a_task_id_is_sent_and_one_that_has_none_is_not(db):
    enforce(db)
    sent, unsent = queued_job(db, idem="sw-rq-1"), queued_job(db, idem="sw-rq-2")
    got = claim_next(db)
    first = got[0]
    svc(db, "select public.advance_creative_job(%s,'w-sw','submitting')", [first])
    svc(db, "select public.advance_creative_job(%s,'w-sw','submitted','task-rq')", [first])
    assert svc(db, "select public.advance_creative_job(%s,'w-sw','requeue')", [first])[0][0] is True
    assert job(db, first)["status"] == "queued" and job(db, first)["provider_task_id"] == "task-rq"
    off(db, "model", "img-a1")
    states = {r[0]: r[1] for r in db.su("select id::text, status from public.creative_jobs where id in (%s,%s)", [sent, unsent])}
    assert states[first] == "queued", "queued, but it has a vendor task: it resumes and is polled"
    other = unsent if first == sent else sent
    assert states[other] == "failed"


def test_inflight_a_routed_job_is_stopped_not_rerouted_and_nothing_comes_back_when_the_model_does(db):
    enforce(db)
    q = rquote(db, "cheap")
    jid = create(db, q["routed_model"], q["credits"], mode="cheap", idem="sw-rt-1")["job"]["id"]
    assert job(db, jid)["routed_model"] == "img-a1"
    off(db, "model", "img-a1")
    j = job(db, jid)
    assert (j["status"], j["error_code"], j["routed_model"], j["fallback_from"]) == ("failed", "model_temporarily_off", "img-a1", None)
    on(db, "model", "img-a1")
    assert job(db, jid)["status"] == "failed", "switching on again does not revive a stopped job: the person starts it again"
    assert svc(db, "select count(*) from public.claim_creative_job('w-sw')")[0][0] == 0


def test_inflight_only_the_targeted_models_and_only_their_unsent_jobs_are_touched(db):
    enforce(db)
    a1, a2, z1 = queued_job(db, "img-a1", idem="sw-t-1"), queued_job(db, "img-a2", idem="sw-t-2"), queued_job(db, "img-z1", idem="sw-t-3")
    b1 = queued_job(db, "img-a1", idem="sw-t-4", org=ORG_B, uid=UB)
    out = off(db, "model", "img-a1")
    assert out["jobs_stopped"] == 2, "both organizations' unsent jobs of that model, nothing else"
    assert [job(db, x)["status"] for x in (a1, b1)] == ["failed", "failed"]
    assert [job(db, x)["status"] for x in (a2, z1)] == ["queued", "queued"]
    assert db.su("select reserved::float from public.credit_accounts where org_id=%s", [ORG_B])[0][0] == 0
    out = off(db, "provider", "acme")
    assert out["jobs_stopped"] == 1 and job(db, a2)["status"] == "failed" and job(db, z1)["status"] == "queued"


def test_inflight_a_long_queue_is_swept_in_bounded_batches_and_nothing_waits_on_the_sweep(db):
    """One OFF stops at most 200 jobs (the API's statement_timeout is 8 s). The switch row is whole after the first call; the owner is told how
    many remain and calls again; a job the sweep has not reached still cannot be sent (the last gate)."""
    enforce(db)
    db.su("select public.grant_credits(%s, 10000, 'test-batch')", [ORG_A])
    ids = [queued_job(db, "img-z1", idem=f"sw-batch-{i}") for i in range(203)]
    assert footprint(db)[2][1] >= 203 * 9
    pre = db.act("authenticated", OWNER, "select public.owner_model_switch_preview('model','img-z1')")[0][0]
    assert pre["waiting"] == 203
    first = off(db, "model", "img-z1")
    assert (first["ok"], first["jobs_stopped"], first["remaining"], first["complete"]) == (True, 200, 3, False)
    assert db.su("select enabled from public.model_availability where scope='model' and target='img-z1'") == [(False,)], \
        "the switch itself is whole after the first call: the model is hidden and refused whatever remains"
    assert "img-z1" not in sellable(db, UA)
    assert err(lambda: quote(db, "img-z1"))[1] == "model_temporarily_off"
    left = [i for i in ids if job(db, i)["status"] == "queued"]
    assert len(left) == 3
    # a leftover job cannot be sent: the worker's last gate ends it and returns the hold
    jid = left[0]
    _id, ref, org = claim_next(db)
    assert _id in left
    svc(db, "select public.start_credit_reservation(%s,%s)", [ref, org])
    assert svc(db, "select public.advance_creative_job(%s,'w-sw','submitting')", [_id])[0][0] is False
    assert job(db, _id)["error_code"] == "model_temporarily_off" and reservation(db, ref) == "released"
    # the same OFF again finishes the sweep
    second = off(db, "model", "img-z1")
    assert (second["ok"], second["jobs_stopped"], second["remaining"], second["complete"]) == (True, 2, 0, True)
    assert db.su("select count(*) from public.creative_jobs where requested_model='img-z1' and status='queued'")[0][0] == 0
    assert db.su("select reserved::float from public.credit_accounts where org_id=%s", [ORG_A])[0][0] == 0
    # both calls are in the log, with what was left each time
    rows = db.su("select jobs_stopped, detail->>'remaining' from public.model_availability_log where kind='switch' and target='img-z1' order by id")
    assert rows[-2:] == [(200, "3"), (2, "0")]
    # a switch ON reports nothing left
    out = on(db, "model", "img-z1")
    assert (out["remaining"], out["complete"]) == (0, True)


def test_inflight_two_switches_at_once_over_the_same_organization_never_deadlock(db):
    enforce(db)
    for i in range(4):
        queued_job(db, "img-a1", idem=f"sw-dl-a{i}")
        queued_job(db, "img-z1", idem=f"sw-dl-z{i}")
    results, errors = [], []
    stopped_before = db.su("select count(*) from public.creative_jobs where status='failed' and error_code='model_temporarily_off'")[0][0]

    def run(provider):
        try:
            results.append(off(db, "provider", provider)["jobs_stopped"])
        except Exception as e:  # noqa: BLE001
            errors.append(repr(e))

    threads = [threading.Thread(target=run, args=(p,)) for p in ("acme", "zeta")]
    [t.start() for t in threads]
    [t.join(timeout=60) for t in threads]
    assert not errors and sorted(results) == [4, 4]
    assert db.su("select count(*) from public.creative_jobs where status='failed' and error_code='model_temporarily_off'")[0][0] == stopped_before + 8


def test_the_sweep_skips_a_job_a_worker_is_in_the_middle_of_and_the_last_gate_takes_it(db):
    enforce(db)
    jid = queued_job(db)
    claim_next(db)
    import psycopg as pg
    holder = pg.connect(db.dsn, autocommit=False)
    try:
        holder.execute("select id from public.creative_jobs where id = %s for update", [jid])      # the worker's advance() holds the row
        out = off(db, "model", "img-a1")
        assert out["jobs_stopped"] == 0, "skip locked: the sweep does not wait on a worker"
    finally:
        holder.rollback()
        holder.close()
    assert job(db, jid)["status"] == "running"
    assert svc(db, "select public.advance_creative_job(%s,'w-sw','submitting')", [jid])[0][0] is False
    assert job(db, jid)["status"] == "failed" and job(db, jid)["error_code"] == "model_temporarily_off"


# ═══ AUDIT ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

def test_every_change_is_logged_with_who_when_why_and_the_state_before(db):
    enforce(db)
    n0 = len(log_rows(db, "switch"))
    off(db, "model", "img-z1", "vendor_outage", "their status page")
    on(db, "model", "img-z1")
    off(db, "provider", "acme", "terms_review")
    rows = log_rows(db, "switch")[n0:]
    assert [(r[1], r[2], r[3], r[4], r[5]) for r in rows] == [
        ("model", "img-z1", False, None, "vendor_outage"),
        ("model", "img-z1", True, False, None),
        ("provider", "acme", False, None, "terms_review"),
    ]
    assert all(r[9] == OWNER and r[10] == "owner@sw.io" and r[11] is not None for r in rows)
    assert rows[0][6] == "their status page"
    ev = db.su("select kind, severity, target, detail from public.security_events where kind = 'model.switch' order by id desc limit 3")
    assert [e[1] for e in ev] == ["warning", "notice", "warning"] and ev[0][2] == "provider:acme"
    assert ev[0][3]["reason"] == "terms_review" and ev[0][3]["enabled"] is False


def test_the_log_cannot_be_rewritten_by_anyone_not_even_the_database_owner(db):
    enforce(db)
    off(db, "model", "img-z2")
    for q in ("update public.model_availability_log set reason = 'other'", "delete from public.model_availability_log",
              "truncate public.model_availability_log"):
        assert err(lambda: db.su(q))[0] == "42501", q


def test_a_refused_change_writes_no_log_and_a_log_that_cannot_be_written_stops_the_change(db):
    enforce(db)
    n = len(log_rows(db))
    sw(db, "model", "img-a1", False, "nonsense")
    assert len(log_rows(db)) == n
    # an audit that cannot be written stops the change (the owner functions, unlike the trails, are not best-effort)
    db.su("alter table public.model_availability_log add constraint zz_no_more check (kind <> 'switch') not valid")
    try:
        assert err(lambda: off(db, "model", "img-a1"))[0] == "23514"
    finally:
        db.su("alter table public.model_availability_log drop constraint zz_no_more")
    assert db.su("select count(*) from public.model_availability")[0][0] == 0, "the switch was rolled back with its log"


# ═══ THE USER SEES "TEMPORARILY UNAVAILABLE", NEVER THE OWNER'S REASON ═══════════════════════════════════════════════════════

def test_no_user_facing_text_carries_the_reason_or_the_note(db):
    enforce(db)
    off(db, "provider", "acme", "out_of_funds", "wallet empty, top up Friday")
    texts = []
    for fn in (lambda: quote(db, "img-a1"), lambda: create(db, "img-a1", 2, idem="sw-leak-1")):
        st, word, detail = err(fn)
        texts.append((word, detail))
    texts.append((json.dumps(api_quote(db)), ""))
    texts.append((json.dumps(api_create(db, "img-a1", "sw-leak-2")), ""))
    texts.append((json.dumps(db.act("authenticated", UA, "select * from public.sellable_models('t2i','web')"), default=str), ""))
    texts.append((json.dumps(db.act("authenticated", UA, "select public.models_switched_off()")), ""))
    q = db.act("authenticated", UA, "select public.quote_workflow(%s, '{}'::jsonb)", [db.act("authenticated", UA,
               "select (public.save_workflow(%s::uuid, null, 'leak', '[]'::jsonb, %s::jsonb)) ->> 'id'",
               [ORG_A, json.dumps(STEPS)])[0][0]])[0][0]
    texts.append((json.dumps(q), ""))
    texts.append((json.dumps(db.act("authenticated", UA, "select data from public.notifications where org_id = %s", [ORG_A]), default=str), ""))
    for word, detail in texts:
        blob = (word + " " + detail).lower()
        assert not any(w in blob for w in ("funds", "wallet", "friday", "balance", "out_of", "vendor_outage", "terms_review")), blob


# ═══ THE OPTIONAL ALERT ══════════════════════════════════════════════════════════════════════════════════════════════════════

def fail_with(db, code, model="img-a1", n=1, tag="al"):
    ids = []
    for i in range(n):
        jid = queued_job(db, model, idem=f"sw-{tag}-{code}-{model}-{i}-{uuid.uuid4().hex[:6]}")
        claim_next(db)
        svc(db, "select public.finish_creative_job(%s,'w-sw',false,null,null,%s,'x')", [jid, code])
        ids.append(jid)
    return ids


def alerts(db):
    return db.su("select provider, kind, status, failures, window_minutes from public.model_availability_alerts order by id")


def test_alert_is_off_by_default_and_a_failure_with_the_quota_code_records_nothing(db):
    enforce(db)
    fail_with(db, "quota", n=4)
    assert alerts(db) == []


def test_alert_n_quota_failures_in_the_window_record_one_open_alert_per_provider_and_hide_nothing(db):
    enforce(db)
    db.su("update public.model_availability_settings set auto_suggest = true")
    fail_with(db, "quota", "img-a1", 2)
    assert alerts(db) == [], "below the threshold"
    fail_with(db, "quota", "img-a2", 1)
    assert alerts(db) == [("acme", "may_be_out_of_funds", "open", 3, 60)], "counted per provider, across its models"
    fail_with(db, "quota", "img-a1", 2)
    assert alerts(db) == [("acme", "may_be_out_of_funds", "open", 5, 60)], "one open alert, its count follows"
    fail_with(db, "quota", "img-z1", 1)
    assert [a[0] for a in alerts(db)] == ["acme"], "another provider below its own threshold"
    # it only says so
    assert sellable(db) == set(MODELS) and db.su("select count(*) from public.model_availability")[0][0] == 0
    doc = db.act("authenticated", OWNER, "select public.owner_model_switches()")[0][0]
    assert [(a["provider"], a["failures"]) for a in doc["alerts"]] == [("acme", 5)]


def test_alert_other_failures_do_not_count_a_bad_key_needs_the_opposite_remedy(db):
    enforce(db)
    db.su("update public.model_availability_settings set auto_suggest = true")
    for code in ("auth", "rate_limited", "unavailable", "policy", "bad_request", "timeout", "not_configured"):
        fail_with(db, code, "img-a1", 3)
    assert alerts(db) == []


def test_alert_old_failures_fall_out_of_the_window(db):
    enforce(db)
    db.su("update public.model_availability_settings set auto_suggest = true, suggest_threshold = 3, suggest_window_minutes = 60")
    old = fail_with(db, "quota", "img-a1", 2)
    db.su("alter table public.creative_jobs disable trigger user")
    try:
        db.su("update public.creative_jobs set finished_at = now() - interval '3 hours' where id = any(%s::uuid[])", [old])
    finally:
        db.su("alter table public.creative_jobs enable trigger user")
    fail_with(db, "quota", "img-a1", 1)
    assert alerts(db) == [], "two of the three are older than the window"


def test_alert_the_owner_dismisses_it_once_and_a_new_burst_opens_a_new_one(db):
    enforce(db)
    db.su("update public.model_availability_settings set auto_suggest = true, suggest_threshold = 2")
    fail_with(db, "quota", "img-z1", 2)
    aid = db.su("select id from public.model_availability_alerts where status = 'open'")[0][0]
    assert err(lambda: db.act("authenticated", UA, "select public.owner_model_alert_dismiss(%s)", [aid]))[0] == "42501"
    out = db.act("authenticated", OWNER, "select public.owner_model_alert_dismiss(%s)", [aid])[0][0]
    assert out == {"ok": True, "id": aid}
    assert db.act("authenticated", OWNER, "select public.owner_model_alert_dismiss(%s)", [aid])[0][0]["error"] == "no_such_alert"
    assert log_rows(db, "alert_dismissed")[-1][2] == "zeta"
    fail_with(db, "quota", "img-z1", 2)
    assert [(a[0], a[2]) for a in alerts(db)] == [("zeta", "dismissed"), ("zeta", "open")]


def test_alert_a_failure_inside_the_alert_can_never_undo_the_jobs_own_refund(db):
    enforce(db)
    db.su("update public.model_availability_settings set auto_suggest = true, suggest_threshold = 2")
    db.su("alter table public.model_availability_alerts add constraint zz_break check (false) not valid")
    try:
        ids = fail_with(db, "quota", "img-a1", 3)
    finally:
        db.su("alter table public.model_availability_alerts drop constraint zz_break")
    assert alerts(db) == []
    for jid in ids:
        j = job(db, jid)
        assert (j["status"], j["error_code"], j["charged_credits"]) == ("failed", "quota", 0)
        assert reservation(db, j["credit_ref"]) == "released"


def test_alert_the_threshold_and_the_window_are_bounded(db):
    for sql in ("update public.model_availability_settings set suggest_threshold = 1",
                "update public.model_availability_settings set suggest_threshold = 51",
                "update public.model_availability_settings set suggest_window_minutes = 4",
                "update public.model_availability_settings set suggest_window_minutes = 1441"):
        assert err(lambda: db.su(sql))[0] == "23514", sql


# ═══ THE MIGRATION ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

def md5_of(db, signature):
    return db.su("select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = %s::regprocedure", [signature])[0][0]


REPLACED = {
    "public.sellable_models(text,text)": "sellable_models",
    "public.creative_price(uuid,text,text,jsonb)": "creative_price",
    "public.advance_creative_job(uuid,text,text,text,jsonb)": "advance_creative_job",
    "public.api_creative_model_ok(text,text)": "api_creative_model_ok",
    "public.api_creative_refusal(text,text,text)": "api_creative_refusal",
}


def test_a_replay_changes_nothing_and_never_undoes_what_the_owner_set(db):
    enforce(db)
    off(db, "model", "img-z2", "other", "kept")
    before = {s: md5_of(db, s) for s in REPLACED}
    db.su(MIGRATION.read_text(encoding="utf-8"))
    assert {s: md5_of(db, s) for s in REPLACED} == before
    assert db.su("select enforced from public.model_availability_settings") == [(True,)], "the seed row is on conflict do nothing"
    assert db.su("select enabled, reason, note from public.model_availability where target = 'img-z2'") == [(False, "other", "kept")]


def test_the_drift_guard_refuses_a_replaced_function_whose_live_body_is_somebody_elses(db):
    """A body edited by hand since 0100 would be silently undone by create or replace: the file refuses instead."""
    admin = sec_db.admin_dsn()
    name = f"ns_switch_drift_{uuid.uuid4().hex[:8]}"
    base = sec_db.create_database(admin, name)
    try:
        sec_db.apply_files(base, [f for f in sec_db.build_sequence() if f.name != MIGRATION.name])
        d = Db(base)
        body = d.su("select pg_get_functiondef('public.creative_price(uuid,text,text,jsonb)'::regprocedure)")[0][0]
        d.su(body.replace("begin\n", "begin\n  -- edited by hand\n", 1))
        st, msg, _ = err(lambda: d.su(MIGRATION.read_text(encoding="utf-8")))
        assert "0124 found a creative_price() that is neither 0100's body nor 0124's" in msg, msg
        # and nothing of the file stayed behind (one transaction)
        assert d.su("select to_regprocedure('public.model_is_available(text)') is null")[0][0] is True
        assert d.su("select to_regclass('public.model_availability') is null")[0][0] is True
    finally:
        sec_db.drop_database(admin, name)


def test_the_policy_drift_guard_compares_the_whole_policy_not_a_few_words(db):
    """The old check looked for four substrings, which a hand-edited policy can keep while widening who reads what. The guard now compares the
    whole deparsed expression with the two texts it may have (0035's and 0124's)."""
    admin = sec_db.admin_dsn()
    name = f"ns_switch_pol_{uuid.uuid4().hex[:8]}"
    base = sec_db.create_database(admin, name)
    try:
        sec_db.apply_files(base, [f for f in sec_db.build_sequence() if f.name != MIGRATION.name])
        d = Db(base)
        # 0035's own policy: the file applies (checked by the rollback test too); here, every edit that keeps the four words is refused
        for widened in (
            "public.is_platform_admin() or (availability in ('beta', 'ga') and verified_at is not null) or true",
            "public.is_platform_admin() or (availability in ('beta', 'ga', 'hidden') and verified_at is not null)",
            "(public.is_platform_admin() or availability in ('beta', 'ga')) and verified_at is not null",
            "public.is_platform_admin() or (availability in ('beta', 'ga') and verified_at is null)",
        ):
            d.su("drop policy model_registry_select on public.model_registry")
            d.su(f"create policy model_registry_select on public.model_registry for select to authenticated using ({widened})")
            st, msg, _ = err(lambda: d.su(MIGRATION.read_text(encoding="utf-8")))
            assert "model_registry_select policy that is not 0035's (or 0124's)" in msg, (widened, msg)
            assert d.su("select to_regclass('public.model_availability') is null")[0][0] is True
        # the same expression for the wrong roles is refused too: the live policy is exactly "to authenticated" (no partial state either)
        using = "public.is_platform_admin() or (availability in ('beta', 'ga') and verified_at is not null)"
        for roles in ("anon", "public", "authenticated, anon", "authenticated, service_role", "anon, authenticated"):
            d.su("drop policy model_registry_select on public.model_registry")
            d.su(f"create policy model_registry_select on public.model_registry for select to {roles} using ({using})")
            st, msg, _ = err(lambda: d.su(MIGRATION.read_text(encoding="utf-8")))
            assert "model_registry_select policy that is not 0035's (or 0124's)" in msg, (roles, msg)
            assert d.su("select to_regclass('public.model_availability') is null")[0][0] is True, roles
            assert d.su("select to_regprocedure('public.model_is_available(text)') is null")[0][0] is True, roles
        # a policy for another command or with a with-check is refused too
        d.su("drop policy model_registry_select on public.model_registry")
        d.su("create policy model_registry_select on public.model_registry for all to authenticated "
             "using (public.is_platform_admin() or (availability in ('beta', 'ga') and verified_at is not null))")
        assert "model_registry_select policy" in err(lambda: d.su(MIGRATION.read_text(encoding="utf-8")))[1]
        # restore 0035's text: the file applies, and applies again over its own policy (the replay)
        d.su("drop policy model_registry_select on public.model_registry")
        d.su("create policy model_registry_select on public.model_registry for select to authenticated "
             "using (public.is_platform_admin() or (availability in ('beta', 'ga') and verified_at is not null))")
        d.su(MIGRATION.read_text(encoding="utf-8"))
        d.su(MIGRATION.read_text(encoding="utf-8"))
    finally:
        sec_db.drop_database(admin, name)


def test_the_rollback_puts_the_five_bodies_and_the_policy_back_and_the_file_applies_again(db):
    admin = sec_db.admin_dsn()
    name = f"ns_switch_rb_{uuid.uuid4().hex[:8]}"
    base = sec_db.create_database(admin, name)
    try:
        # the state before the file: everything up to 0123 (0124 is the last file of the sequence)
        files = [f for f in sec_db.build_sequence() if f.name != MIGRATION.name]
        sec_db.apply_files(base, files)
        d = Db(base)
        pre = {s: md5_of(d, s) for s in REPLACED}
        pre_policy = d.su("select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'model_registry_select'")[0][0]
        d.su(MIGRATION.read_text(encoding="utf-8"))
        assert {s: md5_of(d, s) for s in REPLACED} != pre
        d.su("update public.model_availability_settings set enforced = true")
        d.su(ROLLBACK.read_text(encoding="utf-8"))
        assert {s: md5_of(d, s) for s in REPLACED} == pre, "byte for byte"
        assert d.su("select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'model_registry_select'")[0][0] == pre_policy
        assert d.su("select count(*) from pg_proc where proname like 'model\\_switch\\_%' or proname like 'owner\\_model\\_%' "
                    "or proname in ('model_is_available','models_switched_off')")[0][0] == 0
        assert d.su("select count(*) from pg_class where relname like 'model\\_availability%' and relkind = 'r'")[0][0] == 0
        assert d.su("select count(*) from pg_trigger where tgname = 'model_switch_note_quota'")[0][0] == 0
        # and the file applies again on the rolled-back database
        d.su(MIGRATION.read_text(encoding="utf-8"))
        assert d.su("select enforced from public.model_availability_settings") == [(False,)]
    finally:
        sec_db.drop_database(admin, name)
