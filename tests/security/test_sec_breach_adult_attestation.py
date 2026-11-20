"""Breach, PR #832 (0192 adult attestation): the paths that make a paid job WITHOUT going through create_creative_job.

0192 gates quote_creative_job, route_model and create_creative_job. Its own header lists the Film Studio (0171) as "not covered";
Breach was asked whether that gap only prices or actually CREATES. It creates: start_film holds the credits, writes a queued
segment and plans every take for the worker, with no adult gate at all. The same is true of the video API (api_create_video,
the MCP server's create_video), which never touches the creative job path. These tests stay FAILING until those paths ask
adult_attestation_gate (or an equivalent) before the hold:

  * a person who said they are under 18 starts a whole film (every model: 0192's "adult_only_service" promise)  FAILS
  * a person without an attestation starts a film whose key-frame model requires_adult                          FAILS
  * a person who said they are under 18 gets a video job and an API hold through their key                     FAILS
  * the stored "method" is the browser's word, not the session's: a direct RPC records "google" for an email
    account, and any terms_version passes (the route's "chosen here, not by the body" does not hold)           FAILS (low)
"""

from __future__ import annotations

import json
import os
import uuid

import psycopg
import pytest

import sec_db
from sec_db import ANON, as_superuser
from sec_api_refund_lab import call, customer, topup
from sec_api_refund_lab import ok as api_ok
from test_sec_films_money import Db as FilmDb
from test_sec_films_money import MODELS as FILM_MODELS
from test_sec_films_money import ASSEMBLY_RATE, JOB_MINIMUM


# ── the Film Studio: start_film creates, unguarded ─────────────────────────────

@pytest.fixture(scope="module")
def films():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_breach_adult_{uuid.uuid4().hex[:8]}"
    d = FilmDb(sec_db.build(admin, name))
    rows = []
    for m, prov, a, caps, unit, _rate, spec in FILM_MODELS:
        # The film's key-frame model is the one whose vendor's terms are 18+ (as the Gemini image rows will be).
        extra = {"requires_adult": True} if m == "img-key" else {}
        rows.append({"id": m, "display_name": m, "provider": prov, "adapter": a, "capabilities": caps, "credit_unit": unit,
                     "entitlement": "any", "spec": {"vendor_model": "acme-" + m, "output": a.split(".")[0], **spec, **extra}})
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, _prov, a, caps, unit, rate, _spec in FILM_MODELS:
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0) "
             "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0", [unit, rate])
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, a, "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability = 'beta' where id = %s", [m])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('film_assembly_minute', %s, 0), "
         "('job_minimum', %s, 0) on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit",
         [ASSEMBLY_RATE, JOB_MINIMUM])
    assert d.su("select (spec ->> 'requires_adult')::boolean from public.model_registry where id = 'img-key'")[0][0] is True
    assert d.su("select public.set_film_studio_enabled(true)")[0][0]["ok"] is True
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def _attest(d, uid, adult):
    d.act("authenticated", uid, "select public.record_adult_attestation(%s, '2026-11-20', 'welcome')", [adult])


def _created(d, org):
    """What a start left behind: (live segments, planned takes, open holds)."""
    seg = d.su("select count(*) from public.film_segments where org_id = %s and status in ('queued', 'running', 'draining')", [org])[0][0]
    takes = d.su("select count(*) from public.film_takes where org_id = %s and status = 'planned'", [org])[0][0]
    holds = d.su("select count(*) from public.credit_reservations where org_id = %s and status = 'open'", [org])[0][0]
    return seg, takes, holds


def _start_attempt(d, who, fid, qid):
    try:
        return d.start(who, fid, qid)
    except psycopg.Error as e:
        return {"ok": False, "reason": str(e).splitlines()[0], "code": e.sqlstate}


def test_a_minor_cannot_start_a_film(films):
    """0192 says a person who said they are under 18 is refused EVERY model. start_film never asks."""
    o = films.new_org()
    for uid in (o.owner, o.admin, o.editor):
        _attest(films, uid, False)
    assert films.act("authenticated", o.admin, "select public.my_adult_attestation()")[0][0] == {"state": "minor"}
    fid = films.film(o)
    q = films.quote(o.editor, fid)
    out = _start_attempt(films, o.admin, fid, q["quote_id"])
    seg, takes, holds = _created(films, o.org)
    assert out.get("ok") is not True and (seg, takes, holds) == (0, 0, 0), (
        f"a minor started a film: {out} — {seg} live segment(s), {takes} planned take(s), {holds} open hold(s)")
    assert out.get("reason") == "adult_only_service", out


def test_a_requires_adult_key_frame_model_is_not_started_without_an_attestation(films):
    """img-key requires_adult; nobody in this organization ever answered. start_film still holds and plans the key frame."""
    o = films.new_org()
    fid = films.film(o)
    q = films.quote(o.editor, fid)
    assert any(ln.get("model") == "img-key" for ln in q["lines"]), q["lines"]
    out = _start_attempt(films, o.admin, fid, q["quote_id"])
    seg, takes, holds = _created(films, o.org)
    assert out.get("ok") is not True and (seg, takes, holds) == (0, 0, 0), (
        f"an adult-only model was started without an attestation: {out} — {seg} segment(s), {takes} take(s), {holds} hold(s)")
    assert out.get("reason") == "adult_attestation_required", out


def test_the_film_quote_names_the_adult_only_model_as_refused(films):
    """Rule 6 (fail early): the quote a person confirms should already say the key frame needs an attestation."""
    o = films.new_org()
    fid = films.film(o)
    q = films.quote(o.editor, fid)
    reasons = {r.get("reason") for r in q.get("refusals") or []}
    assert "adult_attestation_required" in reasons, (
        f"quote_film refuses nothing for an adult-only key frame and a person without an attestation: "
        f"startable={q.get('startable')} refusals={q.get('refusals')}")


# ── the video API / MCP: api_create_video creates, unguarded ───────────────────

def test_a_minors_api_key_cannot_create_a_video_job(conn):
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        out = api_ok(call(s, c.actor, "select public.record_adult_attestation(false, '2026-11-20', 'welcome')"))
        assert out["state"] == "minor" and out["recorded"] is True, out
        topup(s, c, 5000)
        body = api_ok(call(s, ANON, "select public.api_create_video(%s, %s, %s::jsonb, null, null, null)",
                           [c.key_hash, c.channel, json.dumps({"topic": "lab", "duration": 60})]))
        jobs = s.value("select count(*) from public.render_jobs j join public.channels ch on ch.channel_id = j.channel_id "
                       "where ch.org_id = %s", [c.org])
        held = s.value("select count(*) from public.api_holds where org_id = %s and status = 'open'", [c.org])
        assert body.get("status") != 201 and jobs == 0 and held == 0, (
            f"a minor's key created a video job: status={body.get('status')} render_jobs={jobs} open_holds={held}")


# ── the record's metadata: the session should decide method, not the caller ───

def test_an_email_account_cannot_record_its_answer_as_google(conn):
    """The route picks "google" from app_metadata.provider, but record_adult_attestation is granted to authenticated and takes
    p_method and p_terms_version from the caller: the browser's anon key + session can write any method and any old version, and
    the first answer then stands for ever (a bumped AGE_TERMS_VERSION never asks again)."""
    with as_superuser(conn, commit=False) as s:
        c = customer(s)  # an email account: no app_metadata.provider = google in its JWT
        out = call(s, c.actor, "select public.record_adult_attestation(true, 'v0', 'google')")
        row = s.rows("select method, terms_version from public.adult_attestations where user_id = %s", [c.actor.uid])
        assert not out.ok and row == [], (
            f"an email account recorded method/terms of its own choosing: {row} (record_adult_attestation trusts p_method)")

