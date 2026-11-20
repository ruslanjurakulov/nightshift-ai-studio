"""The adult attestation (0192) in a workflow (0073/0083): each later step is made AS the member who confirmed the run, whoever's page
advances it. What would break, and which test says so:

  a declared minor who opens a teammate's run fails it (Lens H1's repro)      test_a_minor_editor_advancing_an_adults_three_step_run_*
  a minor viewer's advance differs from the confirmer's own                  test_a_minor_viewers_advance_is_exactly_the_confirmers
  a step the confirmer's gate refuses leaves a hold open, or the run open    test_a_run_stopped_by_the_confirmers_gate_holds_nothing
  the job of a later step is recorded as the viewer's, not the confirmer's   (checked in the two tests above)
"""

from __future__ import annotations

import json
import os
import uuid

import pytest

import sec_db
import test_sec_workflows as wfl

TERMS = "2026-11-20"
FLOW3 = [wfl.STEP_IMG, wfl.STEP_ANIMATE, wfl.STEP_VOICE]


@pytest.fixture(scope="module")
def wf():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_adult_wf_{uuid.uuid4().hex[:8]}"
    d = wfl.Db(sec_db.build(admin, name))
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": a, "capabilities": caps, "credit_unit": unit,
             "entitlement": "any", "spec": {"vendor_model": "acme-" + m, "output": a.split(".")[0], "durations_s": list(range(1, 61))}}
            for m, caps, a, unit, _c in wfl.MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, caps, a, _u, _c in wfl.MODELS:
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')", [m, a, "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
    d.su(f"insert into public.credit_prices (unit, credits_per_unit, margin) values {wfl.PRICES} "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0")
    d.su("update public.plan_entitlements set value = '1000' where key = 'concurrency'")
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def _attest(d, uid, adult):
    d.act("authenticated", uid, "select public.record_adult_attestation(%s, %s, 'welcome')", [adult, TERMS])


def _owner_run(d, o, steps=FLOW3):
    w = d.save(o.owner, o.org, "Promo", wfl.INPUTS, steps)
    total = d.quote(o.owner, w["id"], wfl.VALUES)["total"]
    run = str(uuid.uuid4())
    d.start(o.owner, run, w["id"], w["version"], wfl.VALUES, total)
    st = d.steps(run)
    assert st[0][1] == "running", st
    d.worker(st[0][2])
    return run


def _state(d, run, org):
    """A run as the database holds it, without the ids that differ between two runs."""
    status = d.su("select status, error_code from public.workflow_runs where id = %s", [run])[0]
    steps = [(i, s, ec) for i, s, _j, _q, _c, ec in d.steps(run)]
    jobs = d.su("select w.step_index, j.requested_by::text, j.status from public.workflow_run_steps w "
                "join public.creative_jobs j on j.id = w.job_id where w.run_id = %s order by 1", [run])
    return status, steps, jobs


def test_a_minor_editor_advancing_an_adults_three_step_run_does_not_fail_it(wf):
    """Lens H1: owner adult, editor minor, a three-step run of the owner's, step 1 done; the editor's page advances it."""
    o = wf.new_org()
    _attest(wf, o.owner, True)
    _attest(wf, o.editor, False)
    run = _owner_run(wf, o)
    wf.advance(o.editor, run)
    status, steps, jobs = _state(wf, run, o.org)
    assert status == ("running", None), (status, steps)
    assert steps[1][1] == "running" and steps[1][2] is None, steps
    # The step's job is the confirmer's, never the minor viewer's.
    assert [j[1] for j in jobs] == [o.owner, o.owner], jobs


def test_a_minor_viewers_advance_is_exactly_the_confirmers(wf):
    """Atlas (b): a minor who opens a teammate's run changes it exactly as the confirmer's own advance would."""
    out = []
    for by_minor in (True, False):
        o = wf.new_org()
        _attest(wf, o.owner, True)
        _attest(wf, o.editor, False)
        run = _owner_run(wf, o)
        holds = wf.holds(o.org)
        wf.advance(o.editor if by_minor else o.owner, run)
        status, steps, jobs = _state(wf, run, o.org)
        out.append((status, steps, [(i, s) for i, _who, s in jobs], wf.holds(o.org)[0] - holds[0],
                    [who == o.owner for _i, who, _s in jobs]))
    assert out[0] == out[1], out


def test_a_run_stopped_by_the_confirmers_gate_holds_nothing(wf):
    """Atlas (a): the member who pressed Run now (no answer then) answers "under 18" after it; an adult viewer's page advances the
    run. Step 2 is refused as the confirmer's, the run ends with the typed reason, and nothing stays held: step 1 was captured when
    it finished, and step 2 never held."""
    o = wf.new_org()
    run = _owner_run(wf, o)
    _attest(wf, o.owner, False)
    _attest(wf, o.editor, True)
    before = wf.acct(o.org)
    wf.advance(o.editor, run)
    status, steps, jobs = _state(wf, run, o.org)
    assert status == ("failed", "step_failed"), (status, steps)
    assert steps[1] == (1, "failed", "adult_only_service") and steps[2][1] == "skipped", steps
    assert len(jobs) == 1, "step 2 was never made"
    assert wf.holds(o.org) == (0, 0), wf.holds(o.org)
    assert wf.acct(o.org) == before, "nothing is held or charged past the refusal"
