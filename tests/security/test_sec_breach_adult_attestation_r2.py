"""Breach, PR #832 round 2 (0192 adult attestation): the connected assistant's Studio (0191), the paid downloads, and the paid
paths 0192's header lists as covered by "the hold gate" or "the job's gate".

The owner's rule: a person who said they are under 18 gets nothing paid, and a model whose vendor's terms are 18+ needs an adult
answer. What these tests say, and which stay FAILING until fixed:

  HOLES (failing on purpose)
  * a queued video run (render_jobs, the Command Center's "Run now") is paid by a hold that already exists, and the browser
    inserts that row itself: nothing asks the person's answer at the insert, so
      - a person who said "under 18" queues a paid run on a hold another admin of the workspace took        FAILS
      - a hold the person took before answering "under 18" still buys a run after it                       FAILS
  * a workflow (0073/0074) creates each later step in the session of WHOEVER advances the run ("whoever's page carries the run
    on", BR-L-006), so create_creative_job's gate reads the viewer, not the member who confirmed the run:
      - a member with no attestation gets an adults-only model as step 2 once an adult colleague's page polls  FAILS
      - a member who said "under 18" after Run now gets step 2 paid once an adult's page polls                 FAILS
      - Run now itself does not say up front that a later step needs an adult answer (rule 6)                  FAILS
      - a declared minor who merely opens an adult's run fails its next step (low)                            FAILS
  HELD (regression pins)
  * the connector: a flag set between quote and create, a minor's grant on an adult's workspace, a replay of a key used before
    the answer, a quote of another connection of the same person, a string requires_adult, and the listing's shape.
  * the downloads: a minor's key, a minor's re-download of an already-paid copy.
"""

from __future__ import annotations

import json
import os
import uuid

import psycopg
import pytest

import sec_db
import test_sec_mcp_oauth_creative as occ
import test_sec_workflows as wfl
from sec_db import ANON, as_superuser, user
from sec_api_refund_lab import call, customer, topup
from sec_api_refund_lab import ok as api_ok

TERMS = "2026-11-20"


# ── 1. A queued video run: the hold exists, the row is the browser's ──────

def _run_prices(s):
    s.rows("insert into public.credit_prices (unit, credits_per_unit, margin) values ('job_minimum', 1, 0), ('video_minute', 2, 0) "
           "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0 returning 1")


def _queue_run(s, who, channel, ref):
    """The Command Center's "Run now" after its reserve_credits: the signed-in admin inserts the queued row (0145's policy)."""
    return call(s, who, "insert into public.render_jobs (channel_id, kind, params, requested_by, credit_ref) "
                        "values (%s, 'daily', %s::jsonb, %s, %s) returning id",
                [channel, json.dumps({"topic": "lab", "duration": 60}), who.uid, ref])


def test_a_minor_cannot_queue_a_paid_run_on_another_admins_hold(conn):
    """The hold gate refuses the minor's OWN hold, but render_jobs_payment_guard accepts any open, unused rj- hold of the workspace,
    and credit_reservations is readable by every member. A declared minor admin reads a colleague's open hold (a dispatch that failed
    after its reserve leaves one open for 3 hours) and queues a paid video on it: no hold is inserted, so no gate fires."""
    with as_superuser(conn, commit=False) as s:
        _run_prices(s)
        c = customer(s)
        s.rows("select public.grant_credits(%s, 100, 'lab')", [c.org])
        api_ok(call(s, c.actor, "select public.record_adult_attestation(true, %s, 'welcome')", [TERMS]))
        m = user("minoradmin", f"minor-{uuid.uuid4().hex[:6]}@lab.test")
        s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [m.uid, m.email])
        s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'admin') returning 1",
               [c.org, m.uid, m.email])
        api_ok(call(s, m, "select public.record_adult_attestation(false, %s, 'welcome')", [TERMS]))
        # The control: the minor's own hold is refused (0192's hold gate).
        own = call(s, m, "select public.reserve_credits(%s, %s, 10)", [c.org, "rj-" + uuid.uuid4().hex[:12]])
        assert not own.ok and own.error.startswith("adult_only_service"), own
        ref = "rj-" + uuid.uuid4().hex[:12]
        api_ok(call(s, c.actor, "select public.reserve_credits(%s, %s, 10)", [c.org, ref]))
        seen = api_ok(call(s, m, "select job_id from public.credit_reservations where org_id = %s and status = 'open'", [c.org]))
        assert seen == ref, "the minor reads the colleague's open hold"
        out = _queue_run(s, m, c.channel, ref)
        jobs = s.value("select count(*) from public.render_jobs where channel_id = %s and requested_by = %s", [c.channel, m.uid])
        assert not out.ok and jobs == 0, (
            f"a person who said they are under 18 queued a paid video run on another admin's hold {ref}: {out} ({jobs} job)")


def test_a_hold_taken_before_the_answer_does_not_buy_a_run_after_it(conn):
    """The connector's own rule (test_a_quote_made_before_the_answer_does_not_spend_after_it): what was confirmed before "under 18"
    does not spend after it. A run's hold is the confirmation; the queued row that spends it is inserted later, unasked."""
    with as_superuser(conn, commit=False) as s:
        _run_prices(s)
        c = customer(s)
        s.rows("select public.grant_credits(%s, 100, 'lab')", [c.org])
        ref = "rj-" + uuid.uuid4().hex[:12]
        api_ok(call(s, c.actor, "select public.reserve_credits(%s, %s, 10)", [c.org, ref]))
        api_ok(call(s, c.actor, "select public.record_adult_attestation(false, %s, 'welcome')", [TERMS]))
        out = _queue_run(s, c.actor, c.channel, ref)
        jobs = s.value("select count(*) from public.render_jobs where channel_id = %s", [c.channel])
        assert not out.ok and jobs == 0, f"a hold taken before 'under 18' bought a queued run after it: {out} ({jobs} job)"


# ── 2. Workflows: a later step is created in the advancer's session ──────

ADULT_TTS = "tts-adult"
STEP_ADULT_VOICE = {"capability": "tts", "model": ADULT_TTS, "params": {"prompt": {"$input": "line"}}}


@pytest.fixture(scope="module")
def wf():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_breach_adult_wf_{uuid.uuid4().hex[:8]}"
    d = wfl.Db(sec_db.build(admin, name))
    models = [*wfl.MODELS, (ADULT_TTS, ["tts"], "audio.acme", "model_tts_a_character", 0.1)]
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": a, "capabilities": caps, "credit_unit": unit,
             "entitlement": "any",
             "spec": {"vendor_model": "acme-" + m, "output": a.split(".")[0], "durations_s": list(range(1, 61)),
                      **({"requires_adult": True} if m == ADULT_TTS else {})}}
            for m, caps, a, unit, _c in models]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, caps, a, _u, _c in models:
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, a, "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
    d.su(f"insert into public.credit_prices (unit, credits_per_unit, margin) values {wfl.PRICES} "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0")
    assert d.su("select public.model_requires_adult(spec) from public.model_registry where id = %s", [ADULT_TTS])[0][0] is True
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def _attest(d, uid, adult):
    d.act("authenticated", uid, "select public.record_adult_attestation(%s, %s, 'welcome')", [adult, TERMS])


def _run(d, o, steps):
    """The editor (who never answered) saves and runs a two-step workflow at its quoted total: (run id, steps after Run now)."""
    w = d.save(o.editor, o.org, "Promo", wfl.INPUTS, steps)
    total = d.quote(o.editor, w["id"], wfl.VALUES)["total"]
    run = str(uuid.uuid4())
    d.start(o.editor, run, w["id"], w["version"], wfl.VALUES, total)
    return run


def _run_flag_after(d, o, steps):
    """Setup adjusted by Forge for 0192's up-front refusal: Run now now refuses a workflow whose later step needs an adult answer the
    member never gave (test_run_now_says_up_front...). To reach a later step made after Run now, the adults-only flag is set on the
    model between Run now and the advance (as test_a_flag_set_between_quote_and_create does for the connector); the assertions are
    unchanged."""
    d.su("update public.model_registry set spec = spec - 'requires_adult' where id = %s", [ADULT_TTS])
    try:
        run = _run(d, o, steps)
    finally:
        d.su("update public.model_registry set spec = spec || '{\"requires_adult\": true}'::jsonb where id = %s", [ADULT_TTS])
    return run


def _finish_step0(d, run):
    st = d.steps(run)
    assert st[0][1] == "running" and st[1][1] == "pending", st
    d.worker(st[0][2])


def test_an_adults_only_later_step_is_not_made_for_a_member_without_an_answer(wf):
    o = wf.new_org()
    _attest(wf, o.owner, True)
    run = _run_flag_after(wf, o, [wfl.STEP_IMG, STEP_ADULT_VOICE])
    _finish_step0(wf, run)
    # The owner opens the run's page; the page polls advance_workflow_run as the owner, an adult.
    wf.advance(o.owner, run)
    st = wf.steps(run)
    made = wf.su("select count(*) from public.creative_jobs where org_id = %s and coalesce(routed_model, requested_model) = %s", [o.org, ADULT_TTS])[0][0]
    assert st[1][1] != "running" and made == 0, (
        f"an adults-only model was made for a run confirmed by a member without an adult attestation, because an adult's page "
        f"advanced it: steps={st}, {made} {ADULT_TTS} job(s)")


def test_control_the_same_step_is_refused_when_the_member_who_confirmed_it_advances(wf):
    """The diagnosis of the two tests around this one: the gate reads the ADVANCER. The member's own page refuses step 2 (after step 1
    was already paid for: rule 6, see test_run_now_says_up_front...); an adult's page makes it."""
    o = wf.new_org()
    run = _run_flag_after(wf, o, [wfl.STEP_IMG, STEP_ADULT_VOICE])
    _finish_step0(wf, run)
    wf.advance(o.editor, run)
    st = wf.steps(run)
    assert st[1][1] != "running" and st[1][5] == "adult_attestation_required", st


def test_a_minor_after_run_now_gets_no_later_paid_step(wf):
    o = wf.new_org()
    _attest(wf, o.owner, True)
    run = _run(wf, o, [wfl.STEP_IMG, wfl.STEP_VOICE])
    _finish_step0(wf, run)
    _attest(wf, o.editor, False)   # the person who confirmed the run now says they are under 18
    holds_before = wf.holds(o.org)[0]
    wf.advance(o.owner, run)
    st = wf.steps(run)
    assert st[1][1] != "running" and wf.holds(o.org)[0] == holds_before, (
        f"a run confirmed by a person who then said they are under 18 took a new hold and started step 2 on an adult's page: {st}")


def test_a_minor_viewing_an_adults_run_does_not_fail_it(wf):
    """The other side of the same diagnosis (low): a declared minor editor who merely opens an adult's run fails its next step with
    adult_only_service, after the adult paid for step 1. The run is the adult's; the advancer's answer should not decide it."""
    o = wf.new_org()
    _attest(wf, o.editor, True)
    minor = str(uuid.uuid4())
    wf.su("insert into auth.users (id, email) values (%s, %s)", [minor, f"m{minor[:6]}@x.io"])
    wf.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'editor')", [o.org, minor, f"m{minor[:6]}@x.io"])
    _attest(wf, minor, False)
    run = _run(wf, o, [wfl.STEP_IMG, wfl.STEP_VOICE])
    _finish_step0(wf, run)
    wf.advance(minor, run)
    st = wf.steps(run)
    assert st[1][5] != "adult_only_service", f"a minor's page failed an adult's paid run: {st}"


def test_run_now_says_up_front_that_a_later_step_needs_an_adult_answer(wf):
    """Rule 6 and quote_film's precedent: the refusal comes before Run now holds step 1, not after step 1 has been paid for."""
    o = wf.new_org()
    w = wf.save(o.editor, o.org, "Promo", wfl.INPUTS, [wfl.STEP_IMG, STEP_ADULT_VOICE])
    total = wf.quote(o.editor, w["id"], wfl.VALUES)["total"]
    run = str(uuid.uuid4())
    try:
        out = wf.start(o.editor, run, w["id"], w["version"], wfl.VALUES, total)
    except psycopg.Error as e:
        out = {"refused": str(e).splitlines()[0]}
    paid = wf.su("select count(*) from public.creative_jobs where org_id = %s", [o.org])[0][0]
    assert out.get("refused", "").startswith("adult_attestation_required") and paid == 0, (
        f"Run now started (and held step 1) for a workflow whose step 2 needs an adult answer the member never gave: "
        f"{ {k: out.get(k) for k in ('status', 'refused')} }, {paid} paid job(s)")


# ── 3. The connector (0191): what held ────────────────────────────────────

ADULT_MODEL = ("img-adult", ["t2i"], {"api_exposure": "web_mcp", "mcp_oauth_exposure": True, "requires_adult": True})
LATER_FLAG = ("img-flag-later", ["t2i"], {"api_exposure": "web_mcp", "mcp_oauth_exposure": True})
STRING_FLAG = ("img-adult-str", ["t2i"], {"api_exposure": "web_mcp", "mcp_oauth_exposure": True, "requires_adult": "yes"})
U_MINOR_A = str(uuid.UUID(int=0xAD2A1))   # an admin of org A (whose owner UA never answered) who said they are under 18
U_ADULT_A = str(uuid.UUID(int=0xAD2A2))


@pytest.fixture(scope="module")
def oc():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_breach_adult_oc_{uuid.uuid4().hex[:8]}"
    d = occ.Db(sec_db.build(admin, name))
    models = occ.MODELS
    occ.MODELS = [*models, ADULT_MODEL, LATER_FLAG, STRING_FLAG]
    try:
        occ.setup(d)
    finally:
        occ.MODELS = models
    d.su("insert into auth.users (id, email) values (%s, 'minor@r2.io'), (%s, 'adult@r2.io')", [U_MINOR_A, U_ADULT_A])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'minor@r2.io', 'admin'), "
         "(%s, %s, 'adult@r2.io', 'admin')", [occ.ORG_A, U_MINOR_A, occ.ORG_A, U_ADULT_A])
    d.act("authenticated", U_MINOR_A, "select public.record_adult_attestation(false, %s, 'welcome')", [TERMS])
    d.act("authenticated", U_ADULT_A, "select public.record_adult_attestation(true, %s, 'welcome')", [TERMS])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def _footprint(d, org):
    return (d.su("select count(*) from public.oauth_creative_quotes where org_id = %s", [org])[0][0],
            d.su("select count(*) from public.creative_jobs where org_id = %s", [org])[0][0],
            d.su("select count(*) from public.credit_reservations where org_id = %s and status = 'open'", [org])[0][0],
            occ.credits(d, org))


def test_a_flag_set_between_quote_and_create_is_refused_at_create(oc):
    tok, _g = occ.connection(oc, occ.UA, occ.ORG_A)   # UA never answered
    q = occ.quote(oc, tok, model=LATER_FLAG[0])
    assert q["status"] == 201, q
    oc.su("update public.model_registry set spec = spec || '{\"requires_adult\": true}'::jsonb where id = %s", [LATER_FLAG[0]])
    try:
        before = _footprint(oc, occ.ORG_A)
        out = occ.create(oc, tok, q["data"]["quote_id"], f"flip-{uuid.uuid4().hex[:8]}")
        assert out["status"] == 428 and occ.code(out) == "adult_attestation_required", out
        after = _footprint(oc, occ.ORG_A)
        assert after[1:] == before[1:], (before, after)
    finally:
        oc.su("update public.model_registry set spec = spec - 'requires_adult' where id = %s", [LATER_FLAG[0]])


def test_a_minors_grant_on_a_workspace_of_adults_and_no_answers_gets_nothing(oc):
    tok, _g = occ.connection(oc, U_MINOR_A, occ.ORG_A)
    before = _footprint(oc, occ.ORG_A)
    for model in ("img-on", ADULT_MODEL[0]):
        out = occ.quote(oc, tok, model=model)
        assert out["status"] == 403 and occ.code(out) == "adult_only_service", (model, out)
    assert _footprint(oc, occ.ORG_A) == before
    listed = occ.models(oc, tok)
    assert listed["ok"] is True, "the list is read-only and still answers"


def test_a_replayed_key_from_before_the_answer_answers_the_old_job_and_buys_nothing(oc):
    u = str(uuid.uuid4())
    oc.su("insert into auth.users (id, email) values (%s, %s)", [u, f"{u[:8]}@r2.io"])
    oc.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'admin')", [occ.ORG_B, u, f"{u[:8]}@r2.io"])
    tok, _g = occ.connection(oc, u, occ.ORG_B)
    q = occ.quote(oc, tok)
    idem = f"rp-{uuid.uuid4().hex[:8]}"
    first = occ.create(oc, tok, q["data"]["quote_id"], idem)
    assert first["status"] == 201, first
    oc.act("authenticated", u, "select public.record_adult_attestation(false, %s, 'welcome')", [TERMS])
    before = _footprint(oc, occ.ORG_B)
    again = occ.create(oc, tok, q["data"]["quote_id"], idem)
    assert again["status"] in (200, 403), again
    assert _footprint(oc, occ.ORG_B) == before
    # A new key on the same (used) quote: quote_used, nothing bought.
    other = occ.create(oc, tok, q["data"]["quote_id"], f"rp2-{uuid.uuid4().hex[:8]}")
    assert other["status"] in (403, 409), other
    assert _footprint(oc, occ.ORG_B) == before


def test_an_adults_quote_is_not_spent_by_another_connection_of_the_workspace(oc):
    tok_adult, _ = occ.connection(oc, U_ADULT_A, occ.ORG_A)
    q = occ.quote(oc, tok_adult, model=ADULT_MODEL[0])
    assert q["status"] == 201, q
    for who in (occ.UA, U_MINOR_A):
        tok, _ = occ.connection(oc, who, occ.ORG_A)
        before = _footprint(oc, occ.ORG_A)
        out = occ.create(oc, tok, q["data"]["quote_id"], f"x-{uuid.uuid4().hex[:8]}")
        assert out["status"] in (403, 404) and _footprint(oc, occ.ORG_A) == before, (who, out)


def test_a_string_requires_adult_is_listed_marked_and_refused(oc):
    tok, _ = occ.connection(oc, occ.UA, occ.ORG_A)
    listed = {m["id"]: m for m in occ.models(oc, tok, "t2i")["data"]["models"]}
    assert listed[STRING_FLAG[0]]["spec"].get("requires_adult") is True, listed[STRING_FLAG[0]]
    out = occ.quote(oc, tok, model=STRING_FLAG[0])
    assert out["status"] == 428 and occ.code(out) == "adult_attestation_required", out


def test_the_listing_of_an_adults_only_model_leaks_no_price_or_terms(oc):
    oc.su("update public.model_registry set spec = spec || %s::jsonb where id = %s",
          [json.dumps({"pricing": {"provider_usd_per_unit": 0.04}, "terms_notes": ["18+ per vendor"], "terms_gate": None}),
           ADULT_MODEL[0]])
    tok, _ = occ.connection(oc, occ.UA, occ.ORG_A)
    m = {x["id"]: x for x in occ.models(oc, tok, "t2i")["data"]["models"]}[ADULT_MODEL[0]]
    blob = json.dumps(m)
    assert set(m) == {"id", "name", "capabilities", "availability", "spec"}, m
    for leak in ("pricing", "provider_usd", "terms_notes", "18+ per vendor", "vendor_model", "credits", "acme-"):
        assert leak not in blob, (leak, m)


# ── 4. Downloads: what held ───────────────────────────────────────────────

def test_a_minor_gets_no_free_redownload_row_either(conn):
    """A copy already paid for this week is re-downloaded at no charge (0094 'redownload'); the download gate still refuses a minor's
    new row (stricter than needed, never looser): no row, no ledger entry."""
    with as_superuser(conn, commit=False) as s:
        s.rows("insert into public.credit_prices (unit, credits_per_unit, margin) values ('download_1080p_minute', 1, 0), "
               "('download_minimum', 1, 0) on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit returning 1")
        c = customer(s)
        s.rows("select public.grant_credits(%s, 100, 'lab')", [c.org])
        got = api_ok(call(s, c.actor, "select public.request_download(%s, '1080p', null)", [c.video]))
        assert got["charged"] > 0, got
        s.rows("update public.download_requests set status = 'failed' where id = %s returning 1", [got["id"]])
        api_ok(call(s, c.actor, "select public.record_adult_attestation(false, %s, 'welcome')", [TERMS]))
        rows = s.value("select count(*) from public.download_requests where org_id = %s", [c.org])
        out = call(s, c.actor, "select public.request_download(%s, '1080p', null)", [c.video])
        assert not out.ok and out.error.startswith("adult_only_service"), out
        assert s.value("select count(*) from public.download_requests where org_id = %s", [c.org]) == rows


def test_a_minors_key_replaying_an_idempotency_key_buys_no_download(conn):
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        topup(s, c, 5000)
        api_ok(call(s, c.actor, "select public.record_adult_attestation(false, %s, 'welcome')", [TERMS]))
        for _ in range(2):
            body = api_ok(call(s, ANON, "select public.api_request_download(%s, %s, '1080p', 'idem-r2-dl', %s, null)",
                               [c.key_hash, c.video, "ab" * 32]))
            assert body["status"] == 403 and body["error"]["code"] == "adult_only_service", body
        assert s.value("select count(*) from public.api_holds where org_id = %s", [c.org]) == 0
        assert s.value("select count(*) from public.download_requests where org_id = %s", [c.org]) == 0
