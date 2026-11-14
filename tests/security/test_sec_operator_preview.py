"""The platform operator may try a hidden model in the operator's own organization before anyone else may (migration 0139).

creative_price accepts a model that is not beta or ga only when ALL of these hold: the model is hidden and its spec says
`"operator_preview": true`, the caller is a platform admin, and the organization is the credits-exempt one (the operator's own).
These tests run the real quote, the real create and the real list on a real Postgres and prove the other side of every one of those
conditions: a member who is not a platform admin, and a platform admin acting in a customer's organization, are answered exactly like
a customer naming any hidden model; a normal model is quoted byte for byte as it was before the file; the money path is the exempt
organization's own (no hold, no ledger row), and an unpriced preview never writes a price anybody could buy at.

Every row is made inside a rolled-back transaction, so no later test sees it. The file-level tests (order, drift guard, rollback) run on
scratch databases.
"""

from __future__ import annotations

import json
import uuid

import pytest

import sec_db
from sec_db import ANON, SERVICE, acting, as_superuser
from sec_scenario import DEFAULT_ORG, MODEL_HIDDEN, MODEL_SOLD, _model_row
from test_sec_api_creative import Db

PREVIEW = "lab-preview-1"
PROMPT = {"prompt": "a lighthouse at dawn"}


def _unit(mid):
    return f"model_{mid.replace('-', '_')}_image"


def _make_preview(conn, mid=PREVIEW, *, availability="hidden", verified=True, price=None, **spec):
    """A model the way the registry file would ship one: terms-gated, unpriced, hidden, and marked operator_preview, with a vendor cost of
    one US cent per image (0.01 USD -> 1 credit at cost). `spec` overrides any of that."""
    base = {"operator_preview": True, "terms_gate": "terms_review_required",
            "pricing": {"unit": "image", "provider_usd_per_unit": 0.01}}
    base.update(spec)
    row = _model_row(mid, **base)
    conn.execute("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement) "
                 "values (%s, %s, 'lab', 'image.openai', array['t2i'], %s::jsonb, %s, 'models_image:basic')",
                 [mid, mid, json.dumps(row["spec"]), _unit(mid)])
    if verified:
        conn.execute("select public.record_model_probe(%s, 'image.openai', 'lab-model-1', 't2i', true, null, null, 900, 1234, 'security-lab')",
                     [mid])
    if availability != "hidden":
        conn.execute("update public.model_registry set availability = %s where id = %s", [availability, mid])
    if price is not None:
        conn.execute("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0.5)", [_unit(mid), price])


def _become(conn, who):
    conn.execute("reset role")
    conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims() if who else {})])
    if who is not None:
        conn.execute(f"set local role {who.role}")


def _call(conn, who, q, params):
    """Run q as `who` in a savepoint; returns ('ok', value) or (sqlstate, message)."""
    try:
        with conn.transaction():
            _become(conn, who)
            v = conn.execute(q, params).fetchone()[0]
            _become(conn, None)
            return "ok", v
    except Exception as e:                                      # noqa: BLE001 - the SQLSTATE and text are the assertion
        return getattr(e, "sqlstate", None), str(e).strip().splitlines()[0]


def _quote(conn, who, org, mid, params=PROMPT):
    return _call(conn, who, "select public.quote_creative_job(%s, 't2i', %s, %s::jsonb)", [org, mid, json.dumps(params)])


def _create(conn, who, org, mid, params=PROMPT, maxc=None):
    return _call(conn, who, "select public.create_creative_job(%s, 't2i', %s, %s::jsonb, 'exact', null, %s::numeric)",
                 [org, mid, json.dumps(params), maxc])


def _list(conn, who, org):
    return _call(conn, who, "select coalesce(jsonb_agg(id order by id), '[]'::jsonb) from public.operator_preview_models(%s)", [org])


def _minimum(conn):
    v = conn.execute("select credits_per_unit from public.credit_prices where unit = 'job_minimum'").fetchone()
    return 0 if v is None else float(conn.execute("select public.credits_round_up(%s)", [v[0]]).fetchone()[0])


NORMAL = "lab-normal-1"


def _make_normal(conn):
    """A model on sale the ordinary way (verified, beta, priced, no plan entitlement), as test_sec_model_shutdown makes them."""
    row = _model_row(NORMAL)
    conn.execute("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement) "
                 "values (%s, %s, 'lab', 'image.openai', array['t2i'], %s::jsonb, %s, null)",
                 [NORMAL, NORMAL, json.dumps(row["spec"]), _unit(NORMAL)])
    conn.execute("select public.record_model_probe(%s, 'image.openai', 'lab-model-1', 't2i', true, null, null, 900, 1234, 'security-lab')",
                 [NORMAL])
    conn.execute("update public.model_registry set availability = 'beta' where id = %s", [NORMAL])
    conn.execute("insert into public.credit_prices (unit, credits_per_unit) values (%s, 4)", [_unit(NORMAL)])


def _operator_joins(conn, sc, org):
    """The platform operator is also a member (owner) of a customer's organization: the case the rule must still refuse."""
    conn.execute("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'owner') on conflict do nothing",
                 [org, sc.operator.uid, sc.operator.email])


# ── who may preview ────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_operator_in_the_exempt_organization_is_quoted_at_vendor_cost_and_told_it_is_a_preview(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make_preview(conn)
        state, q = _quote(conn, sc.operator, DEFAULT_ORG, PREVIEW)
        assert state == "ok", q
        # 0.01 USD per image x 100 credits per USD, no margin, rounded up to the cent, floored at job_minimum like every quote.
        assert q["preview"] is True and q["exempt"] is True and q["model"] == PREVIEW, q
        assert float(q["credits_per_unit"]) == 1.0 and q["unit"] == _unit(PREVIEW), q
        assert float(q["credits"]) == max(1.0, _minimum(conn)), q
        assert q["available"] is None, "the exempt organization has no balance to show"
        # The quote wrote no price: nothing is on sale because the operator looked.
        assert conn.execute("select count(*) from public.credit_prices where unit = %s", [_unit(PREVIEW)]).fetchone()[0] == 0


def test_a_member_of_the_exempt_organization_who_is_not_a_platform_admin_is_refused_like_any_hidden_model(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make_preview(conn)
        got = _quote(conn, sc.dana, DEFAULT_ORG, PREVIEW)
        assert got[0] == "NS400" and got[1] == "model_not_sellable", got
        # the same answer a customer gets for any hidden model: nothing says a preview exists
        hidden = _quote(conn, sc.dana, DEFAULT_ORG, MODEL_HIDDEN)
        assert hidden == got, (hidden, got)
        assert _list(conn, sc.dana, DEFAULT_ORG) == ("ok", [])
        # and the create refuses before anything (only a platform admin starts a generation in the exempt organization, 0036)
        state, _ = _create(conn, sc.dana, DEFAULT_ORG, PREVIEW)
        assert state == "42501"


def test_a_platform_admin_acting_in_a_customers_organization_is_refused(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make_preview(conn)
        _operator_joins(conn, sc, sc.alice.org)
        got = _quote(conn, sc.operator, sc.alice.org, PREVIEW)
        assert got[0] == "NS400" and got[1] == "model_not_sellable", got
        got = _create(conn, sc.operator, sc.alice.org, PREVIEW, maxc=1000)
        assert got[0] == "NS400" and got[1] == "model_not_sellable", got
        assert _list(conn, sc.operator, sc.alice.org) == ("ok", [])
        assert conn.execute("select count(*) from public.creative_jobs where requested_model = %s", [PREVIEW]).fetchone()[0] == 0
        assert conn.execute("select count(*) from public.credit_reservations where org_id = %s and created_at >= now()",
                            [sc.alice.org]).fetchone()[0] == 0


def test_a_customer_is_refused_in_their_own_organization_and_sees_no_list(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make_preview(conn)
        assert _quote(conn, sc.alice.actor, sc.alice.org, PREVIEW)[:2] == ("NS400", "model_not_sellable")
        assert _create(conn, sc.alice.actor, sc.alice.org, PREVIEW, maxc=1000)[:2] == ("NS400", "model_not_sellable")
        assert _list(conn, sc.alice.actor, sc.alice.org) == ("ok", [])
        # a customer cannot ask about the operator's organization either
        assert _list(conn, sc.alice.actor, DEFAULT_ORG) == ("ok", [])
        # and the list a customer is offered is unchanged
        _become(conn, sc.alice.actor)
        ids = {r[0] for r in conn.execute("select id from public.sellable_models(null, 'web')").fetchall()}
        _become(conn, None)
        assert PREVIEW not in ids


def test_the_operator_sees_the_model_in_the_preview_list_only_in_the_exempt_organization(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make_preview(conn)
        _operator_joins(conn, sc, sc.alice.org)
        assert _list(conn, sc.operator, DEFAULT_ORG) == ("ok", [PREVIEW])
        assert _list(conn, sc.operator, sc.alice.org) == ("ok", [])
        _become(conn, sc.operator)
        spec = conn.execute("select spec from public.operator_preview_models(%s)", [DEFAULT_ORG]).fetchone()[0]
        _become(conn, None)
        # the public half only: never the vendor's cost, the vendor model or the terms notes
        assert "pricing" not in spec and "vendor_model" not in spec and "terms_gate" not in spec and "operator_preview" not in spec, spec
        # nor is it offered through the API's model check, which asks sellable_models
        _become(conn, sc.operator)
        offered = conn.execute("select id from public.sellable_models('t2i', 'web')").fetchall()
        _become(conn, None)
        assert (PREVIEW,) not in offered
        conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(sc.operator.claims())])
        assert conn.execute("select public.api_creative_model_ok('t2i', %s)", [PREVIEW]).fetchone()[0] is False


@pytest.mark.parametrize("variant", [
    {"operator_preview": "true"},          # a string is not the JSON value true
    {"operator_preview": 1},
    {"operator_preview": False},
    {"operator_preview": None},
    {"availability": "disabled"},          # the owner's off, or a model removed from the file
    {"verified": False},                   # no real call has worked
    {"shutdown": {"on": "2000-01-01", "source_url": "https://example.com/deprecations", "as_of": "2026-11-12"}},
])
def test_the_operator_is_refused_unless_every_condition_holds(conn, sc, variant):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        kw = dict(variant)
        avail = kw.pop("availability", "hidden")
        verified = kw.pop("verified", True)
        _make_preview(conn, availability=avail, verified=verified, **kw)
        got = _quote(conn, sc.operator, DEFAULT_ORG, PREVIEW)
        assert got[:2] == ("NS400", "model_not_sellable"), (variant, got)
        assert _list(conn, sc.operator, DEFAULT_ORG) == ("ok", []), variant


def test_the_owners_switch_still_turns_a_preview_off(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make_preview(conn)
        conn.execute("update public.model_availability_settings set enforced = true")
        conn.execute("insert into public.model_availability (scope, target, enabled, reason, note, changed_by) "
                     "values ('model', %s, false, 'other', 'lab', %s)", [PREVIEW, sc.operator.uid])
        got = _quote(conn, sc.operator, DEFAULT_ORG, PREVIEW)
        assert got[:2] == ("NS400", "model_temporarily_off"), got
        assert _list(conn, sc.operator, DEFAULT_ORG) == ("ok", [])


def test_a_preview_with_no_stated_cost_or_a_cost_by_variant_stays_unpriced(conn, sc):
    for mid, pricing in (("lab-preview-nocost", {"unit": "image", "provider_usd_per_unit": None}),
                         ("lab-preview-zero", {"unit": "image", "provider_usd_per_unit": 0}),
                         ("lab-preview-huge", {"unit": "image", "provider_usd_per_unit": 1000}),
                         ("lab-preview-var", {"unit": "image", "provider_usd_per_unit": 0.01,
                                              "variants": {"by": "quality", "prices": {"low": 0.01}}})):
        with conn.transaction(force_rollback=True):
            _become(conn, None)
            _make_preview(conn, mid, pricing=pricing)
            got = _quote(conn, sc.operator, DEFAULT_ORG, mid)
            assert got[0] == "NS400" and got[1] in ("unpriced", "invalid_params"), (mid, got)


def test_a_preview_that_has_a_credit_price_is_quoted_at_it(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make_preview(conn, price=40)
        state, q = _quote(conn, sc.operator, DEFAULT_ORG, PREVIEW)
        assert state == "ok", q
        assert q["preview"] is True and float(q["credits_per_unit"]) == 60.0 and float(q["credits"]) == max(60.0, _minimum(conn)), q


# ── the money path ─────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_operators_preview_job_holds_and_charges_nothing_like_every_job_of_the_exempt_organization(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make_preview(conn)
        before = conn.execute("select count(*) from public.credit_transactions").fetchone()[0]
        state, out = _create(conn, sc.operator, DEFAULT_ORG, PREVIEW, maxc=1000)
        assert state == "ok", out
        job = out["job"]
        row = conn.execute("select credit_ref, quoted_credits, status, requested_model, payer from public.creative_jobs where id = %s",
                           [job["id"]]).fetchone()
        assert row[0] is None, "the exempt organization holds nothing: reserve_credits answered exempt"
        assert float(row[1]) == max(1.0, _minimum(conn)) and row[2] == "queued" and row[3] == PREVIEW and row[4] == "credits", row
        assert conn.execute("select count(*) from public.credit_reservations where job_id = %s", [f"cj:{job['id']}"]).fetchone()[0] == 0
        assert conn.execute("select count(*) from public.credit_transactions").fetchone()[0] == before
        # a confirmed price below the record is refused, as for any job
        got = _create(conn, sc.operator, DEFAULT_ORG, PREVIEW, maxc=0.5)
        assert got[:2] == ("NS409", "price_changed"), got


# ── nothing changes for anyone else ────────────────────────────────────────────────────────────────────────────────

def test_every_other_quote_is_byte_for_byte_what_0125_answered(conn, sc):
    """The same calls with 0139 on and with 0139 rolled back (its own rollback, inside this transaction): the same answers, refusals included."""
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make_preview(conn)
        _make_normal(conn)
        _operator_joins(conn, sc, sc.alice.org)
        calls = [(who, org, mid)
                 for who, org in ((sc.alice.actor, sc.alice.org), (sc.operator, sc.alice.org), (sc.dana, DEFAULT_ORG),
                                  (sc.bob.actor, sc.bob.org), (sc.operator, DEFAULT_ORG))
                 for mid in (NORMAL, MODEL_SOLD, MODEL_HIDDEN, "lab-gated-1", "no-such-model")]
        calls += [(sc.alice.actor, sc.alice.org, PREVIEW), (sc.dana, DEFAULT_ORG, PREVIEW), (sc.operator, sc.alice.org, PREVIEW)]
        with_0139 = [_quote(conn, who, org, mid) for who, org, mid in calls]
        lists = [_list(conn, who, org) for who, org, _ in calls]
        _become(conn, None)
        # 0149 sits on 0139's creative_price, and 0139's rollback refuses any other body: it comes off first (0153, on 0149's, before it,
        # and 0155, on 0153's, before that).
        conn.execute(sec_db.rollback_0176_body())  # 0176 sits on 0159's creative_price: off first
        conn.execute(sec_db.rollback_0159_body())  # 0159 sits on 0156's creative_price: off first
        conn.execute(sec_db.rollback_0156_body())  # 0156 sits on 0155's creative_price: off first
        conn.execute(sec_db.rollback_0155_body())
        conn.execute(sec_db.rollback_0153_body())
        conn.execute(sec_db.rollback_0149_body())
        conn.execute(sec_db.rollback_0139_body())
        without = [_quote(conn, who, org, mid) for who, org, mid in calls]
        assert with_0139 == without
        assert any(s == "ok" for s, _ in with_0139), "the positive control: a normal model is quoted"
        assert all(v == ("ok", []) or (who is sc.operator and org == DEFAULT_ORG)
                   for (who, org, _), v in zip(calls, lists)), lists


def test_the_helper_is_internal_and_the_list_is_for_signed_in_users_only(conn, sc):
    for who in (sc.alice.actor, ANON, SERVICE):
        with acting(conn, who) as s:
            out = s.run("select public.creative_operator_preview(%s, 'hidden', '{\"operator_preview\": true}'::jsonb)", [DEFAULT_ORG])
        assert not out.ok and out.sqlstate == "42501", (who.name, out)
    for who in (ANON, SERVICE):
        with acting(conn, who) as s:
            out = s.run("select * from public.operator_preview_models(%s)", [DEFAULT_ORG])
        assert not out.ok and out.sqlstate == "42501", (who.name, out)
    with acting(conn, sc.alice.actor) as s:
        assert s.run("select * from public.operator_preview_models(%s)", [DEFAULT_ORG]).ok
    with as_superuser(conn, commit=False) as s:
        # no signed-in user: never a preview
        assert s.value("select public.creative_operator_preview(%s, 'hidden', '{\"operator_preview\": true}'::jsonb)", [DEFAULT_ORG]) is False


# ── the file itself: order, drift guard, rollback ──────────────────────────────────────────────────────────────────

MIGRATION = sec_db.MIGRATION_0139
ROLLBACK = sec_db.ROLLBACK_0139
M0125 = sec_db.MIGRATION_0125
SIG = "public.creative_price(uuid,text,text,jsonb)"


def _md5(d):
    return d.su(f"select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = '{SIG}'::regprocedure")[0][0]


def _scratch(files):
    admin = sec_db.admin_dsn()
    name = f"ns_preview_{uuid.uuid4().hex[:8]}"
    base = sec_db.create_database(admin, name)
    sec_db.apply_files(base, files)
    return admin, name, Db(base)


def test_it_refuses_to_apply_before_0125_and_leaves_nothing_behind():
    # 0149 sits on 0139 and refuses to apply without it: left out with it.
    admin, name, d = _scratch([f for f in sec_db.build_sequence() if f.name not in (M0125.name, MIGRATION.name, *sec_db.ON_0139)])
    try:
        with pytest.raises(Exception) as cm:
            d.su(MIGRATION.read_text(encoding="utf-8"))
        assert "0139 needs 0125_model_shutdown.sql" in str(cm.value)
        assert d.su("select to_regprocedure('public.creative_operator_preview(uuid, text, jsonb)') is null")[0][0] is True
    finally:
        sec_db.drop_database(admin, name)


def test_the_drift_guard_refuses_a_body_edited_by_hand_and_a_replay_changes_nothing():
    # The chain up to this file: 0149 replaces creative_price on 0139's body, and this file's guard accepts only 0125's or its own.
    admin, name, d = _scratch([f for f in sec_db.build_sequence() if f.name not in sec_db.ON_0139])
    try:
        before = _md5(d)
        d.su(MIGRATION.read_text(encoding="utf-8"))                       # the replay
        assert _md5(d) == before
        body = d.su(f"select pg_get_functiondef('{SIG}'::regprocedure)")[0][0]
        d.su(body.replace("begin\n", "begin\n  -- edited by hand\n", 1))
        with pytest.raises(Exception) as cm:
            d.su(MIGRATION.read_text(encoding="utf-8"))
        assert "0139 found a creative_price() that is neither 0125's body nor 0139's" in str(cm.value), str(cm.value)
    finally:
        sec_db.drop_database(admin, name)


def test_the_rollback_puts_0125s_body_back_byte_for_byte_and_the_file_applies_again():
    admin, name, d = _scratch([f for f in sec_db.build_sequence() if f.name not in (MIGRATION.name, *sec_db.ON_0139)])
    try:
        pre = _md5(d)
        assert pre == "e0c4a7806642086398558cf322c95a0d", "0125's body is the base"
        d.su(MIGRATION.read_text(encoding="utf-8"))
        assert _md5(d) != pre
        d.su(ROLLBACK.read_text(encoding="utf-8"))
        assert _md5(d) == pre, "byte for byte"
        assert d.su("select to_regprocedure('public.creative_operator_preview(uuid, text, jsonb)') is null "
                    "and to_regprocedure('public.operator_preview_models(uuid)') is null")[0][0] is True
        # 0125's own rollback works again once 0139 is off
        d.su(sec_db.ROLLBACK_0125.read_text(encoding="utf-8"))
        d.su(M0125.read_text(encoding="utf-8"))
        d.su(MIGRATION.read_text(encoding="utf-8"))                       # and again on the rolled-back database
        assert _md5(d) != pre
        body = d.su(f"select pg_get_functiondef('{SIG}'::regprocedure)")[0][0]
        d.su(body.replace("begin\n", "begin\n  -- edited by hand\n", 1))
        with pytest.raises(Exception) as cm:
            d.su(ROLLBACK.read_text(encoding="utf-8"))
        assert "rollback 0139 found a creative_price() that is neither 0139's body nor 0125's" in str(cm.value)
    finally:
        sec_db.drop_database(admin, name)
